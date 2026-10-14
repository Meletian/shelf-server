import { createHash } from 'node:crypto';
import { ProviderError } from './providers.mjs';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hash = b => createHash('sha256').update(b).digest('hex');
const terminal = new Set(['accepted', 'rejected', 'revoked', 'expired']);
export function normalizedEmail(value) {
    if (typeof value !== 'string' || value.length > 254)
        return '';
    const email = value.trim().toLowerCase();
    return /^[a-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/.test(email) ? email : '';
}
export function verifiedEmail(info) { return info?.email_verified === true ? normalizedEmail(info.email) : ''; }
// The store supplied here is encrypted by the existing account-store envelope.
// Each delivery has its own random content key and lives in a separate Drive folder.
export function createSharing({ shares, accounts, driver, now, persist, locked, limited, parseJson, notify = () => { }, events = false, directUploads, wireValid, maximum }) {
    const descriptor = s => ({ id: s.id, sender: s.senderEmail, recipient: s.recipientEmail, status: s.status, createdAt: s.createdAt, expiresAt: s.expiresAt, size: s.parts.reduce((n, p) => n + p.size, 0) });
    let dirty = false;
    function expire() {
        for (const [id, s] of shares) {
            if (!terminal.has(s.status) && s.expiresAt <= now()) {
                s.status = 'expired';
                delete s.key;
                directUploads?.cancelBinding(s.id);
                dirty = true;
            }
            if (terminal.has(s.status) && s.parts.every(p => p.deleted) && s.expiresAt + 30 * 86400000 <= now()) {
                shares.delete(id);
                dirty = true;
            }
        }
    }
    async function maintenance() {
        expire();
        let left = 4;
        for (const s of shares.values())
            if (terminal.has(s.status)) {
                for (const p of s.parts)
                    if (!p.deleted && left-- > 0) {
                        try {
                            await locked(`${s.senderId}:share-object:${p.id}`, async () => {
                                if (p.deleted || !terminal.has(s.status))
                                    return;
                                const store = driver(s.senderId);
                                for (const suffix of s.protocolVersion === 2 ? ['.data', '.meta'] : ['.data']) {
                                    await store.delete(p.id + suffix);
                                    if (await store.get(p.id + suffix))
                                        throw Error('DELETE_NOT_CONFIRMED');
                                }
                                p.deleted = true;
                                dirty = true;
                            });
                        }
                        catch { /* Keep receipts for the next bounded cleanup attempt. */ }
                    }
                if (left <= 0)
                    break;
            }
        if (dirty) {
            await persist();
            dirty = false;
        }
        return [...shares.values()].some(s => terminal.has(s.status) && s.parts.some(p => !p.deleted));
    }
    function needIdentity(accountId) {
        const account = accounts.get(accountId);
        if (account?.provider !== 'google' || !account.email)
            throw new ProviderError('SHARE_EMAIL_PERMISSION_REQUIRED', 403);
        return account.email;
    }
    async function route(request, session, path, method) {
        if (!path.startsWith('/v1/shares'))
            return null;
        expire();
        const accountId = session.accountId;
        if (path === '/v1/shares/identity' && method === 'GET') {
            const email = accounts.get(accountId)?.provider === 'google' ? accounts.get(accountId).email ?? '' : '';
            return Response.json({ email, ready: !!email, ...(events ? { eventMode: 'ticket-v1' } : {}) });
        }
        if (path === '/v1/shares' && method === 'GET') {
            if (dirty) {
                await persist();
                dirty = false;
            }
            const all = [...shares.values()].sort((a, b) => b.createdAt - a.createdAt);
            return Response.json({ inbox: all.filter(s => s.recipientId === accountId && ['pending', 'receiving'].includes(s.status)).slice(0, 100).map(descriptor), sent: all.filter(s => s.senderId === accountId && s.status !== 'uploading').slice(0, 100).map(descriptor) });
        }
        if (path === '/v1/shares' && method === 'POST')
            return locked('share-create:' + accountId, async () => {
                const senderEmail = needIdentity(accountId), v = parseJson(await limited(request, 262144)), email = normalizedEmail(v.recipient);
                const v2 = v.protocolVersion === 2;
                if (v.cardKind !== undefined && !['file', 'note'].includes(v.cardKind)) throw new ProviderError('SHARE_INVALID_PACKAGE', 400);
                if (v2 && !directUploads || v.protocolVersion !== undefined && v.protocolVersion !== 1 && !v2)
                    throw new ProviderError('SHARE_PROTOCOL_UNSUPPORTED', 409);
                if (!email || !uuid.test(v.id ?? '') || typeof v.key !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(v.key) || Buffer.from(v.key, 'base64').length !== 32 || Buffer.from(v.key, 'base64').toString('base64') !== v.key || !Array.isArray(v.parts) || !v.parts.length || v.parts.length > 65 || v.parts.some((p, i) => !uuid.test(p?.id ?? '') || !Number.isSafeInteger(p.size) || p.size < 16 || p.size > (v2 ? i === 0 ? 256 * 1024 + 40 : maximum : 1024 * 1024 + 28) || !/^[a-f0-9]{64}$/.test(p.sha256 ?? '') || v2 && (!wireValid(p.wire, p.id, maximum) || p.wire.commitReceipt !== undefined || p.wire.size !== p.size || p.wire.sha256 !== p.sha256)) || new Set(v.parts.map(p => p.id)).size !== v.parts.length || v.parts.reduce((n, p) => n + p.size, 0) > (v2 ? 8 * 1024 * 1024 * 1024 + 512 * 1024 : 64 * 1024 * 1024 + 65 * 28))
                    throw new ProviderError('SHARE_INVALID_PACKAGE', 400);
                const previous = shares.get(v.id);
                if (previous) {
                    if (previous.senderId !== accountId)
                        throw new ProviderError('SHARE_NOT_FOUND', 404);
                    const parts = list => list.map(({ id, size, sha256, wire }) => ({ id, size, sha256, ...(v2 ? { wire } : {}) }));
                    if ((previous.cardKind ?? null) !== (v.cardKind ?? null) || (previous.protocolVersion ?? 1) !== (v2 ? 2 : 1) || previous.recipientEmail !== email || previous.key !== v.key || JSON.stringify(parts(previous.parts)) !== JSON.stringify(parts(v.parts)))
                        throw new ProviderError('SHARE_ID_CONFLICT', 409);
                    return Response.json(descriptor(previous));
                }
                const account = accounts.get(accountId);
                let budget = account.sharingBudget;
                if (!budget || budget.expiresAt <= now())
                    budget = { count: 0, expiresAt: now() + 3600000 };
                if (budget.count >= 30)
                    throw new ProviderError('SHARE_LIMIT_REACHED', 429);
                budget.count++;
                account.sharingBudget = budget;
                await persist();
                const recipients = [...accounts].filter(([, a]) => a.provider === 'google' && a.email === email);
                if (recipients.length !== 1)
                    throw new ProviderError('SHARE_RECIPIENT_UNAVAILABLE', 404);
                const recipientId = recipients[0][0];
                if (recipientId === accountId)
                    throw new ProviderError('SHARE_SELF_NOT_ALLOWED', 400);
                if (shares.size >= 4096 || [...shares.values()].filter(s => s.senderId === accountId && !terminal.has(s.status)).length >= 20 || [...shares.values()].filter(s => s.recipientId === recipientId && !terminal.has(s.status)).length >= 100 || [...shares.values()].filter(s => s.senderId === accountId && s.createdAt > now() - 86400000).length >= 64)
                    throw new ProviderError('SHARE_LIMIT_REACHED', 429);
                // A caller cannot select another delivery's storage objects.
                if (v.parts.some(p => [...shares.values()].some(s => s.parts.some(other => other.id === p.id))))
                    throw new ProviderError('SHARE_INVALID_PACKAGE', 400);
                const s = { id: v.id, ...(v.cardKind ? { cardKind: v.cardKind } : {}), ...(v2 ? { protocolVersion: 2 } : {}), senderId: accountId, recipientId, senderEmail, recipientEmail: email, key: v.key, parts: v.parts.map(({ id, size, sha256, wire }) => ({ id, size, sha256, ...(v2 ? { wire } : {}), uploaded: false })), status: 'uploading', createdAt: now(), expiresAt: now() + 7 * 86400000 };
                shares.set(s.id, s);
                await persist();
                return Response.json(descriptor(s), { status: 201 });
            });
        const streamed = path.match(/^\/v1\/shares\/([0-9a-f-]{36})\/parts\/(0|[1-9][0-9]?)\/(stream|uploads(?:\/[A-Za-z0-9_-]{43}(?:\/commit)?)?)$/);
        if (streamed) {
            const s = shares.get(streamed[1]), index = Number(streamed[2]), p = s?.parts[index];
            if (!s || s.protocolVersion !== 2 || !p || accountId !== s.senderId && accountId !== s.recipientId)
                throw new ProviderError('SHARE_NOT_FOUND', 404);
            if (s.expiresAt <= now() || terminal.has(s.status))
                throw new ProviderError('SHARE_NO_LONGER_AVAILABLE', 410);
            const store = driver(s.senderId);
            if (streamed[3] === 'stream') {
                if (method !== 'GET' || accountId !== s.recipientId)
                    throw new ProviderError('SHARE_NOT_FOUND', 404);
                if (s.status !== 'receiving')
                    throw new ProviderError('SHARE_ACCEPT_REQUIRED', 409);
                const stream = store.getStream ? await store.getStream(p.id + '.data') : new Response(await store.get(p.id + '.data')).body;
                if (!stream)
                    throw new ProviderError('SHARE_PACKAGE_DAMAGED');
                if (s.status !== 'receiving' || s.expiresAt <= now())
                    throw new ProviderError('SHARE_NO_LONGER_AVAILABLE', 410);
                return new Response(stream, { headers: { 'content-type': 'application/octet-stream' } });
            }
            if (accountId !== s.senderId)
                throw new ProviderError('SHARE_NOT_FOUND', 404);
            return directUploads.route(request, session, store, '/v1/' + streamed[3], method, { key: s.id + ':' + index, wire: p.wire, available: () => s.status === 'uploading' && s.expiresAt > now(), committed: async () => { p.uploaded = true; await persist(); } });
        }
        const match = path.match(/^\/v1\/shares\/([0-9a-f-]{36})\/(commit|package|accept|complete|reject|revoke|parts\/(?:0|[1-9][0-9]?))$/);
        if (!match || !uuid.test(match[1]))
            throw new ProviderError('NOT_FOUND', 404);
        const [, , action] = match, s = shares.get(match[1]);
        if (!s || accountId !== s.senderId && accountId !== s.recipientId)
            throw new ProviderError('SHARE_NOT_FOUND', 404);
        return locked('share:' + s.id, async () => {
            const sender = accountId === s.senderId, recipient = accountId === s.recipientId;
            if (action === 'revoke' && method === 'POST' && sender || action === 'reject' && method === 'POST' && recipient) {
                const status = action === 'revoke' ? 'revoked' : 'rejected';
                if (s.status === status)
                    return Response.json({ ok: true });
                // The recipient may stop an interrupted receipt; sender revocation stays restricted.
                const cancellable = action === 'reject' ? ['pending', 'uploading', 'receiving'] : ['pending', 'uploading'];
                if (!cancellable.includes(s.status))
                    throw new ProviderError(terminal.has(s.status) && action === 'reject' ? 'SHARE_NO_LONGER_AVAILABLE' : 'SHARE_ALREADY_RECEIVING', terminal.has(s.status) && action === 'reject' ? 410 : 409);
                s.status = status;
                delete s.key;
                directUploads?.cancelBinding(s.id);
                await persist();
                notify([s.senderId, s.recipientId]);
                return Response.json({ ok: true });
            }
            if (terminal.has(s.status)) {
                if (action === 'complete' && method === 'POST' && recipient && s.status === 'accepted')
                    return Response.json({ ok: true });
                throw new ProviderError('SHARE_NO_LONGER_AVAILABLE', 410);
            }
            if (action === 'commit' && method === 'POST' && sender) {
                if (!s.parts.every(p => p.uploaded))
                    throw new ProviderError('SHARE_UPLOAD_INCOMPLETE', 409);
                if (s.status === 'uploading') {
                    s.status = 'pending';
                    await persist();
                    notify([s.senderId, s.recipientId]);
                }
                return Response.json(descriptor(s));
            }
            if (action === 'accept' && method === 'POST' && recipient) {
                if (s.protocolVersion === 2 && request.headers.get('x-shelf-share-protocol') !== 'stream-v2')
                    throw new ProviderError('SHARE_CLIENT_UPGRADE_REQUIRED', 409);
                if (!['pending', 'receiving'].includes(s.status))
                    throw new ProviderError('SHARE_UPLOAD_INCOMPLETE', 409);
                s.status = 'receiving';
                await persist();
                return Response.json(descriptor(s));
            }
            if (action === 'complete' && method === 'POST' && recipient) {
                if (s.status !== 'receiving')
                    throw new ProviderError('SHARE_ACCEPT_REQUIRED', 409);
                s.status = 'accepted';
                delete s.key;
                await persist();
                notify([s.senderId, s.recipientId]);
                return Response.json({ ok: true });
            }
            if (action === 'package' && method === 'GET' && recipient) {
                if (s.status !== 'receiving')
                    throw new ProviderError('SHARE_ACCEPT_REQUIRED', 409);
                return Response.json({ id: s.id, key: s.key, ...(s.cardKind ? { cardKind: s.cardKind } : {}), ...(s.protocolVersion === 2 ? { protocolVersion: 2, scope: hash(`shelf-share-v2\0${hash(`${new URL(request.url).origin}\0${s.senderId}`)}\0${s.id}`) } : {}), parts: s.parts.map(({ id, size, sha256, wire }) => ({ id, size, sha256, ...(s.protocolVersion === 2 ? { wire } : {}) })) });
            }
            if (action.startsWith('parts/')) {
                if (s.protocolVersion === 2)
                    throw new ProviderError('SHARE_CLIENT_UPGRADE_REQUIRED', 409);
                const p = s.parts[Number(action.split('/')[1])];
                if (!p)
                    throw new ProviderError('SHARE_NOT_FOUND', 404);
                const store = driver(s.senderId);
                if (method === 'PUT' && sender && s.status === 'uploading') {
                    const v = parseJson(await limited(request, 1500000));
                    if (typeof v.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(v.data))
                        throw new ProviderError('SHARE_INVALID_PART', 400);
                    const bytes = Buffer.from(v.data, 'base64');
                    if (bytes.length !== p.size || bytes.toString('base64') !== v.data || hash(bytes) !== p.sha256)
                        throw new ProviderError('SHARE_INVALID_PART', 400);
                    if (store.putVerified)
                        await store.putVerified(p.id + '.data', bytes);
                    else {
                        await store.put(p.id + '.data', bytes);
                        const checked = await store.get(p.id + '.data');
                        if (!checked || hash(checked) !== p.sha256)
                            throw new ProviderError('SHARE_UPLOAD_NOT_CONFIRMED');
                    }
                    p.uploaded = true;
                    await persist();
                    return Response.json({ ok: true, sha256: p.sha256 });
                }
                if (method === 'GET' && recipient && s.status === 'receiving') {
                    const bytes = await store.get(p.id + '.data');
                    if (!bytes || bytes.length !== p.size || hash(bytes) !== p.sha256)
                        throw new ProviderError('SHARE_PACKAGE_DAMAGED');
                    return Response.json({ data: bytes.toString('base64') });
                }
            }
            throw new ProviderError('SHARE_NOT_FOUND', 404);
        });
    }
    return { route, maintenance };
}
