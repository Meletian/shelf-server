import { opaqueSession, ProviderError } from './providers.mjs';
import { verifyStream } from './transfers.mjs';
const day = 86400000;
const same = (a, b) => a.id === b.id && a.size === b.size && a.sha256 === b.sha256 && JSON.stringify(a.metadata) === JSON.stringify(b.metadata);
export function createDirectUploads({ uploads, transfers = new Map(), now, persist, limited, parseJson, wireValid, maximum, locked, receipt, isDeleted = () => false, sessionValid = () => true }) {
    function available(record, session, binding) {
        if (!record || record.accountId !== session.accountId || record.owner !== session.sessionHash)
            throw new ProviderError('UPLOAD_NOT_FOUND', 404);
        if (record.binding !== binding?.key)
            throw new ProviderError('UPLOAD_NOT_FOUND', 404);
        if (!binding && isDeleted(session, record.wire.id))
            throw new ProviderError('OBJECT_DELETION_PENDING', 409);
        if (binding && !binding.available())
            throw new ProviderError('SHARE_NO_LONGER_AVAILABLE', 410);
        if (record.cancelled || record.expiresAt <= now())
            throw new ProviderError('UPLOAD_NO_LONGER_AVAILABLE', 410);
        if (!sessionValid(session))
            throw new ProviderError('DRIVE_AUTH_EXPIRED', 401);
    }
    const result = (record, session) => ({ ...record.wire, commitReceipt: receipt(record.wire, session) });
    async function route(request, session, storage, path, method, binding) {
        if (path === '/v1/uploads' && method === 'POST') {
            const wire = parseJson(await limited(request, 16384));
            if (wire?.commitReceipt !== undefined || !wireValid(wire, wire?.id, maximum) || binding && !same(binding.wire, wire))
                throw new ProviderError('INVALID_METADATA', 400);
            return locked(`${session.accountId}:${binding ? 'share-object' : 'object'}:${wire.id}`, async () => {
                if (!binding && isDeleted(session, wire.id))
                    throw new ProviderError('OBJECT_DELETION_PENDING', 409);
                if (binding && !binding.available())
                    throw new ProviderError('SHARE_NO_LONGER_AVAILABLE', 410);
                if (!storage.beginDirectUpload || !storage.confirmDirectUpload)
                    throw new ProviderError('DIRECT_UPLOAD_UNSUPPORTED', 409);
                if (storage.prepareObject)
                    await storage.prepareObject(wire.id);
                if (await storage.get(wire.id + '.delete'))
                    throw new ProviderError('OBJECT_DELETION_PENDING', 409);
                const previous = await storage.get(wire.id + '.meta');
                if (previous) {
                    const committed = parseJson(previous);
                    if (!same(committed, wire))
                        throw new ProviderError('OBJECT_ID_ALREADY_COMMITTED', 409);
                    if (![...uploads.values()].some(r => r.accountId === session.accountId && r.binding === binding?.key && r.committed && same(r.wire, wire)))
                        await verifyStream(storage.getStream ? await storage.getStream(wire.id + '.data') : new Response(await storage.get(wire.id + '.data')).body, wire);
                    if (binding) {
                        if (!binding.available())
                            throw new ProviderError('SHARE_NO_LONGER_AVAILABLE', 410);
                        await binding.committed();
                    }
                    return Response.json({ committed: { ...committed, commitReceipt: receipt(committed, session) } });
                }
                if (!binding && [...transfers.values()].some(r => r.accountId === session.accountId && r.wire.id === wire.id && !r.committed && r.expiresAt > now()))
                    throw new ProviderError('UPLOAD_IN_PROGRESS', 409);
                if (!binding && !(storage.has ? await storage.has('vault.json') : await storage.get('vault.json')))
                    throw new ProviderError('VAULT_NOT_INITIALIZED', 409);
                for (const [uploadId, r] of uploads)
                    if (r.accountId === session.accountId && r.binding === binding?.key && r.wire.id === wire.id && !r.cancelled && r.expiresAt > now()) {
                        if (r.owner !== session.sessionHash)
                            throw new ProviderError('UPLOAD_IN_PROGRESS', 409);
                        if (!same(r.wire, wire)) {
                            r.cancelled = true;
                            delete r.location;
                            await persist();
                            continue;
                        }
                        r.lastActivity = now();
                        await persist();
                        return Response.json({ uploadId, uploadUrl: r.location, size: r.wire.size, expiresAt: r.expiresAt });
                    }
                if ([...uploads.values()].filter(r => r.accountId === session.accountId && !r.committed && !r.cancelled && r.expiresAt > now()).length >= 8)
                    throw new ProviderError('TOO_MANY_UPLOADS', 429);
                if (uploads.size >= 4096)
                    throw new ProviderError('TOO_MANY_UPLOADS', 429);
                const uploadId = opaqueSession();
                const grant = await locked('direct-folder:' + session.accountId + ':' + (binding ? 'shares' : 'files'), () => storage.beginDirectUpload(wire, uploadId, request.headers.get('origin') ?? undefined));
                const record = { ...grant, wire, ...(binding ? { binding: binding.key } : {}), owner: session.sessionHash, accountId: session.accountId, startedAt: now(), lastActivity: now(), expiresAt: now() + day, cleanupAfter: now() + 8 * day, ...(!sessionValid(session) || binding && !binding.available() ? { cancelled: true } : {}) };
                uploads.set(uploadId, record);
                await persist();
                available(record, session, binding);
                return Response.json({ uploadId, uploadUrl: record.location, size: wire.size, expiresAt: record.expiresAt }, { status: 201 });
            });
        }
        const match = path.match(/^\/v1\/uploads\/([A-Za-z0-9_-]{43})(\/commit)?$/);
        if (!match)
            throw new ProviderError('NOT_FOUND', 404);
        const record = uploads.get(match[1]);
        available(record, session, binding);
        return locked(`${session.accountId}:${binding ? 'share-object' : 'object'}:${record.wire.id}`, async () => {
            available(record, session, binding);
            if (method === 'DELETE' && !match[2]) {
                if (record.committed)
                    throw new ProviderError('UPLOAD_ALREADY_COMMITTED', 409);
                record.cancelled = true;
                delete record.location;
                await persist();
                return Response.json({ ok: true });
            }
            if (method === 'GET' && !match[2])
                return Response.json(record.committed ? { committed: result(record, session) } : { uploadId: match[1], uploadUrl: record.location, size: record.wire.size, expiresAt: record.expiresAt });
            if (method === 'POST' && match[2]) {
                if (record.committed) {
                    await binding?.committed();
                    return Response.json(result(record, session));
                }
                const v = parseJson(await limited(request, 1024));
                if (!/^[A-Za-z0-9_-]{1,200}$/.test(v.fileId ?? ''))
                    throw new ProviderError('INVALID_GOOGLE_ID', 400);
                if (storage.prepareObject)
                    await storage.prepareObject(record.wire.id);
                if (await storage.get(record.wire.id + '.delete'))
                    throw new ProviderError('OBJECT_DELETION_PENDING', 409);
                const old = await storage.get(record.wire.id + '.meta');
                if (old && !same(parseJson(old), record.wire))
                    throw new ProviderError('OBJECT_ID_ALREADY_COMMITTED', 409);
                // Never accept a caller's checksum receipt; provider reads it with its own credential.
                const proof = await storage.confirmDirectUpload(record, v.fileId);
                if (proof?.id !== v.fileId || Number(proof.size) !== record.wire.size || proof.sha256Checksum !== record.wire.sha256)
                    throw new ProviderError('UPLOAD_NOT_CONFIRMED');
                available(record, session, binding);
                if (await storage.get(record.wire.id + '.delete'))
                    throw new ProviderError('OBJECT_DELETION_PENDING', 409);
                const bytes = Buffer.from(JSON.stringify(record.wire));
                if (storage.putVerified)
                    await storage.putVerified(record.wire.id + '.meta', bytes);
                else {
                    await storage.put(record.wire.id + '.meta', bytes);
                    const check = await storage.get(record.wire.id + '.meta');
                    if (!check?.equals(bytes))
                        throw new ProviderError('METADATA_WRITE_NOT_CONFIRMED');
                }
                if (binding && !binding.available()) {
                    record.cancelled = true;
                    delete record.location;
                    await persist();
                    throw new ProviderError('SHARE_NO_LONGER_AVAILABLE', 410);
                }
                record.committed = true;
                record.remoteId = v.fileId;
                delete record.location;
                await persist();
                available(record, session, binding);
                await binding?.committed();
                return Response.json(result(record, session), { status: 201 });
            }
            throw new ProviderError('NOT_FOUND', 404);
        });
    }
    async function maintenance(storageFactory) {
        let count = 0, dirty = false, pending = false;
        for (const [id, r] of uploads) {
            if (!r.committed && (r.cancelled || r.expiresAt <= now())) {
                pending = true;
                if (count++ >= 4)
                    continue;
                try {
                    await locked(`${r.accountId}:${r.binding ? 'share-object' : 'object'}:${r.wire.id}`, async () => {
                        const storage = storageFactory(r.accountId, r.binding);
                        const meta = await storage.get(r.wire.id + '.meta');
                        if (!r.binding && meta && same(parseJson(meta), r.wire)) {
                            r.committed = true;
                            dirty = true;
                            return;
                        }
                        if (storage.cancelDirectUpload)
                            await storage.cancelDirectUpload(r);
                        if (r.cleanupAfter <= now()) {
                            uploads.delete(id);
                            dirty = true;
                        }
                    });
                }
                catch { /* Keep private tombstone for a later sweep. */ }
            }
            else if (r.committed && r.cleanupAfter <= now()) {
                uploads.delete(id);
                dirty = true;
            }
        }
        if (dirty)
            await persist();
        return pending;
    }
    function cancelBinding(prefix) {
        for (const r of uploads.values())
            if (r.binding?.startsWith(prefix + ':') && !r.committed) {
                r.cancelled = true;
                delete r.location;
            }
    }
    return { route, maintenance, cancelBinding };
}
