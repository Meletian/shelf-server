import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { BaiduDrive, GoogleDrive, ProviderError, objectHash, opaqueSession } from "./providers.mjs";
import { createTransfers } from './transfers.mjs';
import { createDirectUploads } from './direct-uploads.mjs';
import { createDirectDownloads } from './direct-downloads.mjs';
import { oauthSourceBucket } from './auth-source.mjs';
import { createSharing, verifiedEmail } from './sharing.mjs';
import { createShareEvents } from './share-events.mjs';
import { readSmallRecords } from './small-records.mjs';
import {seedWelcome} from './welcome.mjs';
import {createMobileImports} from './mobile-imports.mjs';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_JSON = 16 * 1024;
const MAX_DIRECT_UPLOAD = 4 * 1024 * 1024;
const hash = value => createHash("sha256").update(value).digest("hex");
function accountProfile(info) {
    const name = typeof info?.name === 'string' ? info.name.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 100) : '';
    let picture = '';
    try {
        const url = new URL(info?.picture);
        if (url.protocol === 'https:' && !url.username && !url.password && !url.port && url.href.length <= 1024 && (url.hostname === 'googleusercontent.com' || url.hostname.endsWith('.googleusercontent.com')))
            picture = url.href;
    }
    catch { }
    return { name, picture };
}
function origin(value) {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/" || !(url.protocol === "https:" || url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))
        throw new Error("The drive service needs an HTTPS origin, or HTTP loopback for local tests.");
    return url.origin;
}
function equal(a, b) { const left = Buffer.from(a ?? ""), right = Buffer.from(b ?? ""); return left.length === right.length && timingSafeEqual(left, right); }
async function limited(request, maximum) {
    if (Number(request.headers.get("content-length")) > maximum)
        throw new ProviderError("REQUEST_TOO_LARGE", 413);
    const reader = request.body?.getReader(), parts = [];
    let size = 0;
    if (!reader)
        return Buffer.alloc(0);
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done)
                break;
            size += value.length;
            if (size > maximum) {
                await reader.cancel();
                throw new ProviderError("REQUEST_TOO_LARGE", 413);
            }
            parts.push(value);
        }
    }
    finally {
        reader.releaseLock();
    }
    return Buffer.concat(parts);
}
function parseJson(bytes) {
    try {
        return JSON.parse(bytes.toString("utf8"));
    }
    catch {
        throw new ProviderError("INVALID_JSON", 400);
    }
}
function sealed(value, maximum) { return value && typeof value.nonce === "string" && /^[A-Za-z0-9+/]{16}$/.test(value.nonce) && typeof value.ciphertext === "string" && value.ciphertext.length >= 24 && value.ciphertext.length <= maximum && /^[A-Za-z0-9+/]+={0,2}$/.test(value.ciphertext); }
function wireValid(value, id, maximum) {
    return value?.version === 1 && value.id === id && sealed(value.metadata, 8192) && Number.isSafeInteger(value.size) && value.size >= 40 && value.size <= maximum && /^[a-f0-9]{64}$/.test(value.sha256);
}
async function oauthJson(fetcher, url, options = {}) {
    let response;
    // workerd accepts manual/follow, but rejects error before making a request.
    // Manual plus the status check below refuses redirects without forwarding secrets.
    try {
        response = await fetcher(url, { ...options, redirect: "manual", signal: AbortSignal.timeout(20000) });
    }
    catch {
        throw new ProviderError("OAUTH_NETWORK_ERROR");
    }
    if (!response.ok)
        throw new ProviderError("OAUTH_REJECTED", response.status === 401 ? 401 : 502);
    let value;
    try {
        value = await response.json();
    }
    catch {
        throw new ProviderError("OAUTH_INVALID_RESPONSE");
    }
    if (value.error || value.errno && value.errno !== 0)
        throw new ProviderError("OAUTH_REJECTED");
    return value;
}
export function createDriveService(config, dependencies = {}) {
    const base = origin(config.origin), fetcher = dependencies.fetch ?? fetch, now = dependencies.now ?? Date.now;
    if (!/^[a-f0-9]{64}$/.test(config.encryptionKey ?? ""))
        throw new Error("Set a random 32-byte encryptionKey in the private service config.");
    const storageKey = Buffer.from(config.encryptionKey, "hex"), accounts = new Map(), sessions = new Map(), flows = new Map(), transfers = new Map(), locks = new Map(), authAttempts = new Map(), folderContexts = new Map();
    const shares = new Map(), uploads = new Map(), deletedObjects = new Map();
    // Preserve both legacy phone receipts and active mobile upload state.
    const mobileImports = new Map();
    const welcomeJobs=new Map();
    function queueWelcome(session,storage){
        const account=accounts.get(session.accountId),guide=account?.welcome,key=account?.spaceKey;
        if(!config.welcomeCards||guide?.state!=='eligible'||!key?.ready||guide.retryAfter>now()||welcomeJobs.has(session.accountId))return;
        const task=locked('welcome:'+session.accountId,()=>seedWelcome({storage,guide,scope:key.scope,key:new Uint8Array(Buffer.from(key.key,'base64')),persist,write:verifiedPut,locked:(id,job)=>locked(`${session.accountId}:object:${id}`,job),isDeleted:id=>isDeleted(session,id)})).catch(async()=>{guide.retryAfter=now()+60000;try{await persist();}catch{}}).finally(()=>welcomeJobs.delete(session.accountId));
        welcomeJobs.set(session.accountId,task);dependencies.waitUntil?.(task);
    }
    const collections = { accounts, sessions, flows, transfers, authAttempts, shares, uploads, deletedObjects, mobileImports }, fingerprints = new Map();
    const isDeleted = (session, id) => { const record = deletedObjects.get(session.accountId + ':' + id); return !!record && (record.cleanupPending || record.expiresAt > now()); };
    const maxFileBytes = 8 * 1024 * 1024 * 1024, maxCipherBytes = 24 + maxFileBytes + 16 * Math.ceil(maxFileBytes / (4 * 1024 * 1024));
    const maximum = config.maxObjectBytes ?? (config.directUploads ? maxCipherBytes : 256 * 1024 * 1024);
    if (!Number.isSafeInteger(maximum) || maximum < 1024 || maximum > maxCipherBytes)
        throw new Error("Invalid maxObjectBytes");
    const directMaximum = config.streaming ? Math.min(config.directUploadMaxBytes ?? MAX_DIRECT_UPLOAD, MAX_DIRECT_UPLOAD, maximum) : maximum;
    if (!Number.isSafeInteger(directMaximum) || directMaximum < 40)
        throw new Error('Invalid directUploadMaxBytes');
    const allowedOrigins = new Set(config.allowedOrigins ?? []);
    allowedOrigins.add(base);
    const ready = (async () => {
        if (!config.dataDirectory && !dependencies.store)
            return;
        if (dependencies.store?.loadRecords) {
            const records = await dependencies.store.loadRecords();
            if (records !== null) {
                for (const { kind, id, sealed } of records) {
                    if (!Object.hasOwn(collections, kind) || typeof id !== 'string' || sealed?.version !== 1)
                        throw Error('INVALID_PRIVATE_RECORD');
                    const cipher = createDecipheriv('aes-256-gcm', storageKey, Buffer.from(sealed.nonce, 'base64'));
                    cipher.setAAD(Buffer.from(`shelf-private-record-v1:${base}\0${kind}\0${id}`));
                    cipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
                    const plain = Buffer.concat([cipher.update(Buffer.from(sealed.ciphertext, 'base64')), cipher.final()]);
                    try {
                        const value = parseJson(plain);
                        collections[kind].set(id, value);
                        fingerprints.set(kind + '\0' + id, hash(plain));
                    }
                    finally {
                        plain.fill(0);
                    }
                }
                return;
            }
        }
        if (config.dataDirectory)
            await mkdir(config.dataDirectory, { recursive: true, mode: 0o700 });
        let stored;
        try {
            stored = dependencies.store ? await dependencies.store.load() : parseJson(await readFile(join(config.dataDirectory, "accounts.local")));
            if (!stored)
                return;
        }
        catch (error) {
            if (error.code === "ENOENT")
                return;
            throw error;
        }
        try {
            const cipher = createDecipheriv("aes-256-gcm", storageKey, Buffer.from(stored.nonce, "base64"));
            cipher.setAAD(Buffer.from(`shelf-drive-tokens-v1:${base}`));
            cipher.setAuthTag(Buffer.from(stored.tag, "base64"));
            const data = JSON.parse(Buffer.concat([cipher.update(Buffer.from(stored.ciphertext, "base64")), cipher.final()]).toString("utf8"));
            for (const [key, value] of data.accounts)
                accounts.set(key, value);
            for (const [key, value] of data.sessions)
                if (value.expiresAt > now())
                    sessions.set(key, value);
            for (const [key, value] of data.flows ?? [])
                if (value.expiresAt > now())
                    flows.set(key, value);
            for (const [key, value] of data.authAttempts ?? [])
                if (value.expiresAt > now())
                    authAttempts.set(key, value);
            for (const [key, value] of data.transfers ?? [])
                if (value.expiresAt > now())
                    transfers.set(key, value);
            for (const [key, value] of data.shares ?? [])
                shares.set(key, value);
            for (const [key, value] of data.uploads ?? [])
                uploads.set(key, value);
            for (const [key, value] of data.deletedObjects ?? [])
                deletedObjects.set(key, value);
            for (const [key, value] of data.mobileImports ?? [])
                mobileImports.set(key, value);
        }
        catch {
            throw new Error("The private account store could not be decrypted. Keep the original encryption key and service origin.");
        }
    })();
    let writeQueue = Promise.resolve();
    let directInFlight = 0;
    const directWaiters = [];
    async function boundedDirectUpload(size, work) {
        if (size <= MAX_JSON)
            return work();
        if (directInFlight >= 2) {
            if (directWaiters.length >= 16)
                throw new ProviderError('TOO_MANY_UPLOADS', 429);
            await new Promise(resolve => directWaiters.push(resolve));
        }
        else
            directInFlight++;
        try {
            return await work();
        }
        finally {
            const next = directWaiters.shift();
            if (next)
                next();
            else
                directInFlight--;
        }
    }
    function persist() {
        if (!config.dataDirectory && !dependencies.store)
            return Promise.resolve();
        const job = writeQueue.catch(() => undefined).then(async () => {
            if (dependencies.store?.saveRecords) {
                const changed = [], removed = [], next = new Map();
                for (const [kind, map] of Object.entries(collections))
                    for (const [id, value] of map) {
                        const plain = Buffer.from(JSON.stringify(value)), fingerprint = hash(plain), recordId = kind + '\0' + id;
                        next.set(recordId, fingerprint);
                        try {
                            if (fingerprints.get(recordId) === fingerprint)
                                continue;
                            const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', storageKey, nonce);
                            cipher.setAAD(Buffer.from(`shelf-private-record-v1:${base}\0${kind}\0${id}`));
                            const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
                            changed.push({ kind, id, sealed: { version: 1, nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') } });
                        }
                        finally {
                            plain.fill(0);
                        }
                    }
                for (const recordId of fingerprints.keys())
                    if (!next.has(recordId)) {
                        const [kind, id] = recordId.split('\0');
                        removed.push({ kind, id });
                    }
                await dependencies.store.saveRecords(changed, removed);
                fingerprints.clear();
                for (const [id, fingerprint] of next)
                    fingerprints.set(id, fingerprint);
                return;
            }
            const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", storageKey, nonce);
            cipher.setAAD(Buffer.from(`shelf-drive-tokens-v1:${base}`));
            const payload = Buffer.from(JSON.stringify({ accounts: [...accounts], sessions: [...sessions], flows: [...flows], transfers: [...transfers], authAttempts: [...authAttempts], shares: [...shares], uploads: [...uploads], deletedObjects: [...deletedObjects], mobileImports: [...mobileImports] }));
            const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
            payload.fill(0);
            const sealedState = { nonce: nonce.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
            if (dependencies.store) {
                await dependencies.store.save(sealedState);
                return;
            }
            const temp = join(config.dataDirectory, `accounts.${opaqueSession()}.local`);
            await writeFile(temp, JSON.stringify(sealedState), { mode: 0o600 });
            await rename(temp, join(config.dataDirectory, "accounts.local"));
        });
        writeQueue = job;
        return job;
    }
    async function locked(key, work) {
        const previous = locks.get(key) ?? Promise.resolve();
        let release;
        const current = new Promise(resolve => { release = resolve; });
        locks.set(key, current);
        await previous;
        try {
            return await work();
        }
        finally {
            release();
            if (locks.get(key) === current)
                locks.delete(key);
        }
    }
    function providerConfig(provider) { return ["google", "baidu"].includes(provider) ? config.providers?.[provider] : null; }
    function configured(provider) { const value = providerConfig(provider); return !!(value?.clientId && value?.clientSecret && (provider !== "baidu" || /^\/apps\/[^/]+$/.test(value.appDirectory ?? ""))); }
    function prune() {
        for(const [id,value] of mobileImports)if(value.expiresAt<=now())mobileImports.delete(id);
        for (const [id, value] of flows)
            if (value.expiresAt <= now())
                flows.delete(id);
        for (const [id, value] of sessions)
            if (value.expiresAt <= now())
                sessions.delete(id);
        for (const [id, value] of transfers)
            if (value.expiresAt <= now())
                transfers.delete(id);
        for (const [id, value] of authAttempts)
            if (value.expiresAt <= now())
                authAttempts.delete(id);
        for (const [id, value] of deletedObjects)
            if (value.expiresAt <= now() && !value.cleanupPending)
                deletedObjects.delete(id);
    }
    async function token(provider, grant, flow) {
        const app = providerConfig(provider), values = { grant_type: grant, client_id: app.clientId, client_secret: app.clientSecret, ...(grant === "authorization_code" ? { code: flow.code, redirect_uri: `${base}/oauth/callback/${provider}`, ...(provider === "google" ? { code_verifier: flow.verifier } : {}) } : { refresh_token: flow.refreshToken }) };
        if (provider === "google")
            return oauthJson(fetcher, "https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(values) });
        // Baidu's official SDK uses GET here. This URL is never logged or returned to the client.
        const url = new URL("https://openapi.baidu.com/oauth/2.0/token");
        url.search = new URLSearchParams(values).toString();
        return oauthJson(fetcher, url);
    }
    function checkToken(response, provider, previous) {
        if (typeof response.access_token !== "string" || !response.access_token || !Number.isFinite(response.expires_in) || response.expires_in <= 0 || !(response.refresh_token || previous?.refreshToken))
            throw new ProviderError("OAUTH_INCOMPLETE_GRANT");
        const scopes = new Set((response.scope ?? previous?.scope ?? "").split(/[ ,]+/));
        if (provider === "google" ? !scopes.has("https://www.googleapis.com/auth/drive.file") : !scopes.has("netdisk"))
            throw new ProviderError("OAUTH_PERMISSION_MISSING");
        return { accessToken: response.access_token, refreshToken: response.refresh_token ?? previous?.refreshToken, expiresAt: now() + response.expires_in * 1000, scope: response.scope ?? previous?.scope };
    }
    async function accessToken(accountId,force=false) {
        return locked(`refresh:${accountId}`, async () => {
            const account = accounts.get(accountId);
            if (!account)
                throw new ProviderError("DRIVE_AUTH_EXPIRED", 401);
            if (account.expiresAt <= now() + 60000 || force) {
                const next = checkToken(await token(account.provider, "refresh_token", account), account.provider, account);
                accounts.set(accountId, { ...account, ...next });
                await persist();
            }
            return accounts.get(accountId).accessToken;
        });
    }
    function driver(accountId, sharing = false) {
        const account = accounts.get(accountId);
        const namespace = (config.storageNamespace ?? 'v1') + (sharing ? '-shares' : '');
        if (dependencies.provider)
            return dependencies.provider(accountId, account.provider, () => accessToken(accountId), namespace);
        if (account.provider === 'google') {
            const contextKey = accountId + ':' + namespace;
            if (!folderContexts.has(contextKey)) {
                if (folderContexts.size >= 1024)
                    folderContexts.delete(folderContexts.keys().next().value);
                folderContexts.set(contextKey, {});
            }
            if(namespace==="production-v1-shares"){const rootKey=accountId+":production-v1";if(!folderContexts.has(rootKey))folderContexts.set(rootKey,{});folderContexts.get(contextKey).root=folderContexts.get(rootKey);}
            return new GoogleDrive(() => accessToken(accountId), fetcher, namespace, folderContexts.get(contextKey));
        }
        return new BaiduDrive(() => accessToken(accountId), providerConfig("baidu").appDirectory, fetcher);
    }
    function authenticate(request) {
        const bearer = request.headers.get("authorization")?.match(/^Bearer (\d{10}\.[a-f0-9]{32}\.[a-f0-9]{64})$/)?.[1];
        const session = bearer && sessions.get(hash(bearer));
        if (!session || session.expiresAt <= now())
            throw new ProviderError("DRIVE_AUTH_EXPIRED", 401);
        return { ...session, sessionHash: hash(bearer) };
    }
    const commitReceipt = (wire, session) => createHmac('sha256', storageKey).update(`shelf-commit-v1\0${session.accountId}\0${wire.id}\0${wire.size}\0${wire.sha256}\0${hash(JSON.stringify(wire.metadata))}`).digest('hex');
    const mobile = createMobileImports({records:mobileImports,accounts,base,now,persist,locked,limited,parseJson,maximum,maxFileBytes,isDeleted});
    const transferRoute = createTransfers({ transfers, now, persist, limited, parseJson, wireValid, maximum, receipt: commitReceipt, isDeleted });
    const directUploads = createDirectUploads({ uploads, transfers, now, persist, limited, parseJson, wireValid: (wire, id, max) => UUID.test(id ?? '') && wireValid(wire, id, max), maximum, locked, receipt: commitReceipt, isDeleted, sessionValid: session => sessions.get(session.sessionHash)?.accountId === session.accountId && sessions.get(session.sessionHash)?.expiresAt > now() });
    const directDownload = createDirectDownloads({accounts,accessToken,now,maximum,wireValid,sessionValid:session=>sessions.get(session.sessionHash)?.accountId===session.accountId&&sessions.get(session.sessionHash)?.expiresAt>now()});
    const events = createShareEvents({ now, allowedOrigins, validSession: s => sessions.get(s.sessionHash)?.accountId === s.accountId && sessions.get(s.sessionHash)?.expiresAt > now(), emit: dependencies.emitShares });
    const sharing = createSharing({ shares, accounts, driver: id => driver(id, true), now, persist, locked, limited, parseJson, notify: events.changed, events: !!dependencies.emitShares, ...(config.directUploads ? { directUploads, wireValid, maximum } : {}) });
    const changeScope = accountId => hash(`${base}\0${accountId}\0${config.storageNamespace ?? 'v1'}`);
    function encodeChangeCursor(accountId, folder, token) {
        const body = Buffer.from(JSON.stringify({ version: 1, scope: changeScope(accountId), folder, token })).toString('base64url');
        return `${body}.${createHmac('sha256', storageKey).update('shelf-google-changes-v1\0' + body).digest('hex')}`;
    }
    function decodeChangeCursor(cursor, accountId) {
        if (typeof cursor !== 'string' || cursor.length > 4096 || !/^([A-Za-z0-9_-]+)\.([a-f0-9]{64})$/.test(cursor))
            throw new ProviderError('DRIVE_CURSOR_RESET_REQUIRED', 409);
        const [body, signature] = cursor.split('.'), expected = createHmac('sha256', storageKey).update('shelf-google-changes-v1\0' + body).digest('hex');
        if (!equal(signature, expected))
            throw new ProviderError('DRIVE_CURSOR_RESET_REQUIRED', 409);
        let value;
        try {
            value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
        }
        catch {
            throw new ProviderError('DRIVE_CURSOR_RESET_REQUIRED', 409);
        }
        if (value.version !== 1 || value.scope !== changeScope(accountId) || value.folder !== null && (typeof value.folder !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(value.folder)) || typeof value.token !== 'string' || !value.token || value.token.length > 1024 || /[\x00-\x20\x7f]/.test(value.token))
            throw new ProviderError('DRIVE_CURSOR_RESET_REQUIRED', 409);
        return value;
    }
    function withRemoteIds(wire, items, request, force = false) {
        if (request && !force && request.headers.get('x-shelf-sync') !== 'google-changes-v1')
            return wire;
        const ids = [`${wire.id}.meta`, `${wire.id}.data`].map(key => items.find(item => item.key === key)?.id);
        if (!ids.every(id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(id)))
            return wire;
        if (!request || request.headers.get('x-shelf-download') !== 'receipt-v1')
            return { ...wire, remoteIds: ids };
        const scope = changeScope(authenticate(request).accountId);
        const session = authenticate(request);
        const body = Buffer.from(JSON.stringify({ version: 1, scope, id: wire.id, dataId: ids[1], expiresAt: Math.min(now() + 24 * 3600000, session.expiresAt) })).toString('base64url');
        const signature = createHmac('sha256', storageKey).update('shelf-download-v1\0' + body).digest('hex');
        return { ...wire, remoteIds: ids, downloadReceipt: `${body}.${signature}` };
    }
    function downloadReceipt(receipt, accountId, id) {
        if (typeof receipt !== 'string' || receipt.length > 2048 || !/^([A-Za-z0-9_-]+)\.([a-f0-9]{64})$/.test(receipt))
            throw new ProviderError('INVALID_DOWNLOAD_RECEIPT', 400);
        const [body, signature] = receipt.split('.'), expected = createHmac('sha256', storageKey).update('shelf-download-v1\0' + body).digest('hex');
        if (!equal(signature, expected))
            throw new ProviderError('INVALID_DOWNLOAD_RECEIPT', 400);
        let value;
        try {
            value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
        }
        catch {
            throw new ProviderError('INVALID_DOWNLOAD_RECEIPT', 400);
        }
        if (value.version !== 1 || value.scope !== changeScope(accountId) || value.id !== id)
            throw new ProviderError('DOWNLOAD_RECEIPT_SCOPE_MISMATCH', 403);
        if (!/^[A-Za-z0-9_-]{1,200}$/.test(value.dataId ?? '') || !Number.isSafeInteger(value.expiresAt))
            throw new ProviderError('INVALID_DOWNLOAD_RECEIPT', 400);
        return value.expiresAt > now() ? value.dataId : null;
    }
    const remoteItems = (storage, id) => storage.objectItems ? storage.objectItems(id) : storage.list();
    async function verifiedPut(storage, key, bytes, code) {
        if (storage.putVerified) {
            await storage.putVerified(key, bytes);
            return;
        }
        await storage.put(key, bytes);
        if (!(await storage.get(key))?.equals(bytes))
            throw new ProviderError(code);
    }
    async function cleanup(storage, id) {
        if (!UUID.test(id))
            throw new ProviderError("INVALID_OBJECT_ID");
        if (storage.deleteObject) {
            await storage.deleteObject(id);
            return;
        }
        for (const key of [`${id}.meta`, `${id}.data`]) {
            await storage.delete(key);
            if (await storage.get(key))
                throw new ProviderError("DELETE_NOT_CONFIRMED");
        }
        await storage.delete(`${id}.delete`);
        if (await storage.get(`${id}.delete`))
            throw new ProviderError("DELETE_NOT_CONFIRMED");
    }
    async function route(request, context) {
        await ready;
        prune();
        const url = new URL(request.url), path = url.pathname, method = request.method;
        if (url.origin !== base)
            throw new ProviderError("INVALID_SERVICE_ORIGIN", 400);
        if (path === "/.well-known/shelf.json" && method === "GET")
            return Response.json({ protocol: "shelf-drive-v1", spaceMode: 'account-key-v1', encryption: "client-aes256gcm-chunked-v1", uploadMode: config.streaming ? 'segmented-v1' : 'single-v1', directUploadMaxBytes: directMaximum, ...(config.directUploads ? { directUploadMode: 'google-resumable-direct-v1', downloadMode: 'google-direct-v1', shareMode: 'stream-v2', maxFileBytes } : {}), commitReceiptMode: 'verified-v1', smallReadMode: 'batch-v1', smallReadReceiptMode:'receipt-v1', syncMode: 'google-changes-v1', maxObjectBytes: maximum, providers: ["google", "baidu"].map(id => ({ id, configured: configured(id) })) });
        const callback = path.match(/^\/oauth\/callback\/(google|baidu)$/);
        if (callback && method === "GET") {
            const state = url.searchParams.get("state"), flow = flows.get(state);
            if (!flow || flow.provider !== callback[1] || flow.used || flow.expiresAt <= now())
                return new Response("<!doctype html><html lang=zh><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><title>Shelf · 重新授权</title><body><h1>此授权页面已失效</h1><p>授权可能已过期、已取消或已处理。请勿刷新此页面。</p><p>返回 Shelf 会自动检查连接；若提示重新授权，再点击“前往官方授权”。</p><p>旧版 Shelf：点击“取消”，重新展开“使用自己的网盘”，再点击“前往官方授权”。</p></body></html>", { status: 400, headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; frame-ancestors 'none'" } });
            flow.used = true;
            await persist();
            try {
                if (url.searchParams.has("error"))
                    throw new ProviderError("OAUTH_CANCELLED", 400);
                const code = url.searchParams.get("code");
                if (!code || code.length > 4096)
                    throw new ProviderError("OAUTH_MISSING_CODE", 400);
                const grant = checkToken(await token(flow.provider, "authorization_code", { ...flow, code }), flow.provider);
                let subject, profile, email;
                if (flow.provider === "google") {
                    const info = await oauthJson(fetcher, "https://www.googleapis.com/oauth2/v3/userinfo", { headers: { authorization: `Bearer ${grant.accessToken}` } });
                    subject = info.sub;
                    profile = accountProfile(info);
                    email = verifiedEmail(info);
                }
                else {
                    const address = new URL("https://pan.baidu.com/rest/2.0/xpan/nas");
                    address.search = new URLSearchParams({ method: "uinfo", access_token: grant.accessToken }).toString();
                    const info = await oauthJson(fetcher, address);
                    subject = String(info.uk ?? "");
                }
                if (!subject || subject.length > 256)
                    throw new ProviderError("OAUTH_NO_ACCOUNT_ID");
                if (flows.get(state) !== flow)
                    throw new ProviderError("OAUTH_CANCELLED", 400);
                const accountId = `${flow.provider}:${hash(subject)}`;
                const previous=accounts.get(accountId);
                accounts.set(accountId, { ...previous, provider: flow.provider, ...grant, ...(profile ? { profile, email } : {}),...(!previous&&config.welcomeCards?{welcome:{version:1,state:'pending',createdAt:now(),language:flow.language??'zh'}}:{}) });
                flow.accountId = accountId;
                await persist();
            }
            catch (error) {
                flow.error = error instanceof ProviderError ? error.message : "OAUTH_FAILED";
            }
            flow.verifier = "";
            await persist();
            if (flow.returnTo)
                return new Response(null, { status: 303, headers: { location: `${flow.returnTo}/?shelf-auth-return=1`, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
            const outcome=flow.accountId&&!flow.error?'<h1>授权成功</h1><p>返回 Shelf 即可自动进入空间，无需再次检查授权。</p>':'<h1>授权未完成</h1><p>请返回 Shelf 查看原因并重新授权。</p>';
            return new Response("<!doctype html><html lang=zh><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><title>Shelf</title><body>"+outcome+"</body></html>", { headers: { "content-type": "text/html; charset=utf-8", "cache-control":"no-store", "content-security-policy": "default-src 'none'; style-src 'none'; frame-ancestors 'none'" } });
        }
        const start = path.match(/^\/v1\/auth\/(google|baidu)\/start$/);
        if (start && method === "POST") {
            const provider = start[1];
            if (!configured(provider))
                throw new ProviderError("OAUTH_APP_NOT_CONFIGURED", 503);
            let returnTo,language='zh';
            if (request.body) {
                const bytes = await limited(request, MAX_JSON), options = bytes.length ? parseJson(bytes) : {};
                if(typeof options.language==='string')language=options.language.startsWith('zh')?'zh':'en';
                if (options.returnTo !== undefined) {
                    try {
                        returnTo = origin(options.returnTo);
                    }
                    catch {
                        throw new ProviderError('INVALID_RETURN_ORIGIN', 400);
                    }
                    if (!allowedOrigins.has(returnTo))
                        throw new ProviderError('UNTRUSTED_RETURN_ORIGIN', 400);
                }
            }
            // Only the hosting adapter supplies this identity: never trust caller-supplied forwarding headers.
            const source = oauthSourceBucket(context.source);
            const sourceHash = hash(`${config.encryptionKey}:oauth-source:${source}`), attempts = authAttempts.get(sourceHash);
            if ((attempts?.count ?? 0) >= 8 || [...flows.values()].filter(flow => flow.sourceHash === sourceHash).length >= 4)
                throw new ProviderError('OAUTH_SOURCE_RATE_LIMITED', 429);
            if (flows.size >= 256)
                throw new ProviderError("TOO_MANY_AUTH_REQUESTS", 429);
            if (!attempts && authAttempts.size >= 4096)
                throw new ProviderError('TOO_MANY_AUTH_REQUESTS', 429);
            const id = opaqueSession(), claimSecret = opaqueSession(), verifier = opaqueSession() + opaqueSession();
            authAttempts.set(sourceHash, { count: (attempts?.count ?? 0) + 1, expiresAt: attempts?.expiresAt ?? now() + 5 * 60000 });
            flows.set(id, { provider, sourceHash, claimHash: hash(claimSecret), verifier, expiresAt: now() + 5 * 60000, language,...(returnTo ? { returnTo } : {}) });
            await persist();
            const address = new URL(provider === "google" ? "https://accounts.google.com/o/oauth2/v2/auth" : "https://openapi.baidu.com/oauth/2.0/authorize");
            address.search = new URLSearchParams({ response_type: "code", client_id: providerConfig(provider).clientId, redirect_uri: `${base}/oauth/callback/${provider}`, scope: provider === "google" ? "openid profile email https://www.googleapis.com/auth/drive.file" : "basic netdisk", state: id, ...(provider === "google" ? { code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", access_type: "offline", prompt: "consent" } : {}) }).toString();
            return Response.json({ flowId: id, claimSecret, authorizationUrl: address.href, expiresAt: now() + 5 * 60000, spaceMode: 'account-key-v1' });
        }
        const poll = path.match(/^\/v1\/auth\/([A-Za-z0-9_-]{43})$/);
        if (poll && ["GET", "DELETE"].includes(method)) {
            const flow = flows.get(poll[1]);
            if (!flow || !equal(flow.claimHash, hash(request.headers.get("x-shelf-claim") ?? "")))
                throw new ProviderError("OAUTH_FLOW_NOT_FOUND", 404);
            if (method === "DELETE") {
                flows.delete(poll[1]);
                await persist();
                return Response.json({ ok: true });
            }
            if (flow.error) {
                flows.delete(poll[1]);
                await persist();
                throw new ProviderError(flow.error, 400);
            }
            if (!flow.accountId)
                return Response.json({ pending: true });
            const expiresAt = now() + 30 * 86400000, bearer = `${Math.floor(expiresAt / 1000)}.${randomBytes(16).toString("hex")}.${randomBytes(32).toString("hex")}`;
            sessions.set(hash(bearer), { accountId: flow.accountId, expiresAt });
            flows.delete(poll[1]);
            await persist();
            return Response.json({ token: bearer, username: flow.accountId, provider: flow.provider, relayOrigin: base, expiresAt: Math.floor(expiresAt / 1000) });
        }
        const session = authenticate(request), storage = driver(session.accountId);
        // Pages already forwards the files routes. Keep its existing asset
        // deployment intact and explicitly select the mobile protocol by query.
        let mobilePath=path;
        if(url.searchParams.has('shelf-mobile')){
            const args=url.searchParams;
            if(args.get('shelf-mobile')!=='1'||[...args.keys()].some(k=>!['shelf-mobile','part','commit'].includes(k))||['shelf-mobile','part','commit'].some(k=>args.getAll(k).length>1))throw new ProviderError('INVALID_MOBILE_ROUTE',400);
            const item=path.match(/^\/v1\/files\/([0-9a-f-]{36})$/);
            if(path==='/v1/files'&&method==='GET'&&args.size===1)mobilePath='/v1/mobile/capabilities';
            else if(item&&UUID.test(item[1])){
                const prefix='/v1/mobile/files/'+item[1];
                if(args.size===1&&['POST','DELETE'].includes(method))mobilePath=prefix;
                else if(method==='PUT'&&args.size===2&&/^(?:raw|[1-9][0-9]{0,4})$/.test(args.get('part')??''))mobilePath=prefix+'/'+args.get('part');
                else if(method==='POST'&&args.size===2&&args.get('commit')==='1')mobilePath=prefix+'/commit';
                else throw new ProviderError('INVALID_MOBILE_ROUTE',400);
            }else throw new ProviderError('INVALID_MOBILE_ROUTE',400);
        }
        if(mobilePath.startsWith("/v1/mobile/")){
            if(!config.mobileImports)throw new ProviderError("MOBILE_IMPORT_UNAVAILABLE",409);
            if(accounts.get(session.accountId)?.provider!=="google")throw new ProviderError("MOBILE_GOOGLE_ONLY",409);
            if(method==='POST'&&/^\/v1\/mobile\/files\/[0-9a-f-]{36}$/.test(mobilePath)&&!accounts.get(session.accountId)?.spaceKey?.ready){
                // Use the existing guarded initializer for a new account. It
                // refuses legacy/conflicting vaults and never replaces a key.
                await route(new Request(base+'/v1/account-key',{method:'POST',headers:{authorization:request.headers.get('authorization'),'content-type':'application/json'},body:'{}'}),context);
            }
            return mobile.route(request,session,storage,mobilePath,method);
        }


        if(['GET','HEAD'].includes(method))queueWelcome(session,storage);
        context.googleMetrics = storage.metrics;
        if (path === '/v1/shares/events-ticket' && method === 'POST')
            return Response.json(events.issue(session));
        if (path.startsWith('/v1/uploads')) {
            if(method==='POST'&&path==='/v1/uploads'&&mobile.active(session,parseJson(await limited(request.clone(),MAX_JSON)).id))throw new ProviderError('UPLOAD_IN_PROGRESS',409);
            if (!config.directUploads)
                throw new ProviderError('DIRECT_UPLOAD_UNSUPPORTED', 409);
            const response = await directUploads.route(request, session, storage, path, method);
            if (storage.startChanges && response.ok) {
                const value = await response.json(), wire = value.committed ?? value;
                if (wire.version === 1) {
                    const enriched = withRemoteIds(wire, await remoteItems(storage, wire.id), request);
                    return Response.json(value.committed ? { committed: enriched } : enriched, { status: response.status });
                }
                return Response.json(value, { status: response.status });
            }
            return response;
        }
        if (path.startsWith('/v1/shares'))
            return sharing.route(request, session, path, method);
        if (path === '/v1/profile' && method === 'GET')
            return locked(`profile:${session.accountId}`, async () => {
                const account = accounts.get(session.accountId);
                if (account.provider !== 'google')
                    return Response.json({ name: '', picture: '' });
                if (!account.profile) {
                    const info = await oauthJson(fetcher, 'https://www.googleapis.com/oauth2/v3/userinfo', { headers: { authorization: `Bearer ${await accessToken(session.accountId)}` } });
                    if (typeof info.sub !== 'string' || `google:${hash(info.sub)}` !== session.accountId)
                        throw new ProviderError('OAUTH_NO_ACCOUNT_ID', 403);
                    account.profile = accountProfile(info);
                    await persist();
                }
                return Response.json(accountProfile(account.profile));
            });
        if (path.startsWith('/v1/transfers')) {
            // Serialize only transfers for the same immutable object. Other cards
            // and reads must not queue behind a slow attachment upload.
            const transferId = path.split('/')[3], record = transfers.get(transferId);
            let objectId = record?.wire.id;
            if (path === '/v1/transfers' && method === 'POST')
                objectId = parseJson(await limited(request.clone(), MAX_JSON)).id;
            if (!UUID.test(objectId ?? ''))
                throw new ProviderError(path === '/v1/transfers' && method === 'POST' ? 'INVALID_METADATA' : 'TRANSFER_NOT_FOUND', path === '/v1/transfers' && method === 'POST' ? 400 : 404);
            if(mobile.active(session,objectId))throw new ProviderError('UPLOAD_IN_PROGRESS',409);
            return locked(`${session.accountId}:object:${objectId}`, async () => {
                if ([...uploads.values()].some(r => r.accountId === session.accountId && r.wire.id === objectId && !r.committed && !r.cancelled && r.expiresAt > now()))
                    throw new ProviderError('UPLOAD_IN_PROGRESS', 409);
                const response = await transferRoute(request, session, storage, path, method);
                if (!response)
                    throw new ProviderError('NOT_FOUND', 404);
                if (response.ok && storage.startChanges && request.headers.get('x-shelf-sync') === 'google-changes-v1' && (method === 'POST' || method === 'PUT')) {
                    const value = await response.json();
                    if (path.endsWith('/commit'))
                        return Response.json(withRemoteIds(value, await remoteItems(storage, value.id), request), { status: response.status });
                    if (value.committed)
                        value.committed = withRemoteIds(value.committed, await remoteItems(storage, value.committed.id), request);
                    return Response.json(value, { status: response.status });
                }
                return response;
            });
        }
        if (path === '/v1/changes' && method === 'GET')
            return (async () => {
                if (!storage.startChanges || !storage.changePage)
                    return Response.json({ unsupported: true });
                const cursor = url.searchParams.get('cursor');
                if (!cursor) {
                    const token = await storage.startChanges(), folder = await storage.folder();
                    return Response.json({ reset: true, cursor: encodeChangeCursor(session.accountId, folder, token) });
                }
                const value = decodeChangeCursor(cursor, session.accountId);
                if (!value.folder)
                    throw new ProviderError('DRIVE_CURSOR_RESET_REQUIRED', 409);
                const page = await storage.changePage(value.token), dirty = new Map(), removedRemoteIds = new Set();
                for (const item of page.changes) {
                    if (item.fileId === value.folder) {
                        if (item.removed || item.file.trashed)
                            throw new ProviderError('DRIVE_CURSOR_RESET_REQUIRED', 409);
                        continue;
                    }
                    if (item.removed || item.file.trashed || !item.file.parents.includes(value.folder)) {
                        removedRemoteIds.add(item.fileId);
                        continue;
                    }
                    const match = item.file.name.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(meta|data|delete)$/);
                    if (match) {
                        if (!dirty.has(match[1]))
                            dirty.set(match[1], new Set());
                        dirty.get(match[1]).add(item.fileId);
                    }
                    else
                        removedRemoteIds.add(item.fileId);
                }
                const files = [], removedIds = [];
                async function readChanged(id) {
                    if (isDeleted(session, id)) {
                        removedIds.push(id);
                        return;
                    }
                    const object = await storage.changedObject(id, value.folder);
                    if (object.removed) {
                        removedIds.push(id);
                        return;
                    }
                    if (object.pending) {
                        if ([...dirty.get(id)].every(remoteId => removedRemoteIds.has(remoteId))) {
                            removedIds.push(id);
                            return;
                        }
                        // Data and metadata commit separately. Keep the previous cursor
                        // until the complete object is visible, rather than losing it.
                        throw new ProviderError('DRIVE_CHANGES_PENDING', 503);
                    }
                    const wire = parseJson(object.metadata);
                    if (!wireValid(wire, id, maximum) || !object.items.some(item => item.key === `${id}.data` && item.size === wire.size))
                        throw new ProviderError('INCOMPLETE_REMOTE_OBJECT');
                    files.push(withRemoteIds(wire, object.items, request, true));
                }
                const changed = [...dirty.keys()];
                for (let offset = 0; offset < changed.length; offset += 4) {
                    const results = await Promise.allSettled(changed.slice(offset, offset + 4).map(readChanged));
                    const failed = results.find(value => value.status === 'rejected');
                    if (failed)
                        throw failed.reason;
                }
                return Response.json({ files, removedIds, removedRemoteIds: [...removedRemoteIds], cursor: encodeChangeCursor(session.accountId, value.folder, page.token), hasMore: page.hasMore });
            })();
        if (path === "/v1/logout" && method === "POST") {
            sessions.delete(session.sessionHash);
            await persist();
            dependencies.closeSession?.(session.sessionHash);
            return Response.json({ ok: true });
        }
        if (path === '/v1/account-key' && ['GET', 'POST'].includes(method))
            return locked(session.accountId, async () => {
                const scope = hash(`${base.toLowerCase()}\0${session.accountId}`), namespace = config.storageNamespace ?? 'v1';
                const bytes = method === 'POST' ? await limited(request, MAX_JSON) : Buffer.alloc(0), options = bytes.length ? parseJson(bytes) : {};
                const supplied = options.key;
                if (supplied !== undefined && (typeof supplied !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(supplied) || Buffer.from(supplied, 'base64').length !== 32 || Buffer.from(supplied, 'base64').toString('base64') !== supplied))
                    throw new ProviderError('DRIVE_INVALID_KEY', 400);
                let saved = accounts.get(session.accountId)?.spaceKey;
                if (saved && (saved.version !== 1 || saved.scope !== scope || saved.namespace !== namespace || typeof saved.ready !== 'boolean' || !(/^[A-Za-z0-9+/]{43}=$/.test(saved.key ?? ''))))
                    throw new ProviderError('DRIVE_ACCOUNT_KEY_INVALID', 409);
                if (saved?.ready) {
                    if (supplied && !equal(supplied, saved.key))
                        throw new ProviderError('DRIVE_ACCOUNT_KEY_CONFLICT', 409);
                    queueWelcome(session,storage);return Response.json({ key: saved.key, scope });
                }
                if (method === 'GET')
                    throw new ProviderError(saved ? 'DRIVE_ACCOUNT_KEY_PENDING' : 'ACCOUNT_KEY_NOT_INITIALIZED', saved ? 409 : 404);
                const original = await storage.get('vault.json'), vault = original ? parseJson(original) : null;
                const guide=accounts.get(session.accountId)?.welcome;
                if(guide?.state==='pending'){
                    if(!vault&&!(await storage.list()).some(item=>/\.(?:meta|data|delete)$/.test(item.key)))guide.state='eligible';else guide.state='skipped';
                    await persist();
                }
                if (vault && vault.scope !== scope)
                    throw new ProviderError('DRIVE_INVALID_VAULT', 400);
                if (vault?.version === 1) {
                    if (!supplied)
                        throw new ProviderError('DRIVE_LEGACY_KEY_REQUIRED', 409);
                    if (options.expectedVault !== hash(JSON.stringify(vault)))
                        throw new ProviderError('DRIVE_VAULT_CHANGED', 409);
                    const sample = (await storage.list()).find(item => item.key.endsWith('.meta'));
                    if (sample) {
                        const wire = parseJson(await storage.get(sample.key));
                        const key = Buffer.from(supplied, 'base64');
                        let plain;
                        try {
                            if (!wireValid(wire, sample.key.slice(0, -5), maximum))
                                throw new Error('invalid');
                            const ciphertext = Buffer.from(wire.metadata.ciphertext, 'base64'), cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(wire.metadata.nonce, 'base64'));
                            cipher.setAAD(Buffer.from(`shelf-drive-meta-v1:${scope}:${wire.id}`));
                            cipher.setAuthTag(ciphertext.subarray(-16));
                            plain = Buffer.concat([cipher.update(ciphertext.subarray(0, -16)), cipher.final()]);
                            if (parseJson(plain).id !== wire.id)
                                throw new Error('invalid');
                        }
                        catch {
                            throw new ProviderError('DRIVE_LEGACY_KEY_INVALID', 400);
                        }
                        finally {
                            key.fill(0);
                            plain?.fill(0);
                        }
                    }
                    saved = { version: 1, scope, namespace, key: supplied, ready: true };
                    accounts.get(session.accountId).spaceKey = saved;
                    try {
                        await persist();
                    }
                    catch (error) {
                        delete accounts.get(session.accountId).spaceKey;
                        throw error;
                    }
                    return Response.json({ key: saved.key, scope }, { status: 201 });
                }
                if (vault && (vault.version !== 2 || vault.keyMode !== 'account'))
                    throw new ProviderError('DRIVE_INVALID_VAULT', 400);
                if (vault && !saved)
                    throw new ProviderError('DRIVE_ACCOUNT_KEY_UNAVAILABLE', 409);
                if (!vault && (await storage.list()).some(item => item.key.endsWith('.meta') || item.key.endsWith('.data')))
                    throw new ProviderError('MISSING_VAULT_WITH_EXISTING_FILES', 409);
                if (!saved) {
                    saved = { version: 1, scope, namespace, key: randomBytes(32).toString('base64'), ready: false };
                    accounts.get(session.accountId).spaceKey = saved;
                }
                // Save the recovery key before creating the marker, including retries
                // after a failed previous persistence. Never expose an uncommitted key.
                await persist();
                if (!vault) {
                    const marker = Buffer.from(JSON.stringify({ version: 2, scope, keyMode: 'account' }));
                    await verifiedPut(storage, 'vault.json', marker, 'VAULT_WRITE_NOT_CONFIRMED');
                }
                saved.ready = true;
                accounts.get(session.accountId).spaceKey = saved;
                try {
                    await persist();
                }
                catch (error) {
                    saved.ready = false;
                    throw error;
                }
                queueWelcome(session,storage);return Response.json({ key: saved.key, scope }, { status: 201 });
            });
        if (path === "/v1/vault" && ["GET", "PUT"].includes(method))
            return locked(session.accountId, async () => {
                const existing = await storage.get("vault.json");
                if (method === "GET")
                    return existing ? new Response(existing, { headers: { "content-type": "application/json" } }) : Response.json({ error: "VAULT_NOT_INITIALIZED" }, { status: 404 });
                if (existing)
                    throw new ProviderError("VAULT_ALREADY_EXISTS", 409);
                if ((await storage.list()).some(item => item.key.endsWith(".meta") || item.key.endsWith(".data")))
                    throw new ProviderError("MISSING_VAULT_WITH_EXISTING_FILES", 409);
                const bytes = await limited(request, MAX_JSON), value = parseJson(bytes);
                const scope = hash(`${base.toLowerCase()}\0${session.accountId}`);
                if (value.version !== 1 || value.scope !== scope || value.iterations !== 600000 || !/^[A-Za-z0-9+/]{22}==$/.test(value.salt ?? "") || !sealed(value.wrappedKey, 128))
                    throw new ProviderError("INVALID_VAULT", 400);
                await storage.put("vault.json", bytes);
                if (!(await storage.get("vault.json"))?.equals(bytes))
                    throw new ProviderError("VAULT_WRITE_NOT_CONFIRMED");
                return Response.json({ ok: true }, { status: 201 });
            });
        if (path === '/v1/files/batch' && method === 'POST')
            return readSmallRecords(request, session, storage, { limited, parseJson, wireValid, maximum, isDeleted, locked, downloadReceipt });
        if (path === "/v1/files" && method === "GET")
            return (async () => {
                const result = [];
                const cursor = url.searchParams.get('cursor');
                if (cursor !== null && !UUID.test(cursor))
                    throw new ProviderError('INVALID_CURSOR', 400);
                const markers = (await storage.list()).filter(item => item.key.endsWith('.delete'));
                if (config.streaming) {
                    let queued = false;
                    for (const item of markers) {
                        const key = session.accountId + ':' + item.key.slice(0, -7);
                        if (!deletedObjects.get(key)?.cleanupPending) {
                            deletedObjects.set(key, { expiresAt: now() + 30 * 86400000, cleanupPending: true });
                            queued = true;
                        }
                    }
                    if (queued)
                        await persist();
                }
                else
                    for (const item of markers)
                        await locked(`${session.accountId}:object:${item.key.slice(0, -7)}`, () => cleanup(storage, item.key.slice(0, -7)));
                const items = await storage.list();
                const pending = new Set(items.filter(item => item.key.endsWith('.delete')).map(item => item.key.slice(0, -7)));
                const metadata = items.filter(item => item.key.endsWith('.meta') && !pending.has(item.key.slice(0, -5)) && !isDeleted(session, item.key.slice(0, -5))).sort((a, b) => a.key.localeCompare(b.key)).filter(item => !cursor || item.key.slice(0, -5) > cursor);
                const selected = config.streaming ? metadata.slice(0, 16) : metadata;
                const readMetadata = async (item) => {
                    const id = item.key.slice(0, -5);
                    if (!UUID.test(id))
                        throw new ProviderError("INVALID_OBJECT_ID");
                    const bytes = await storage.get(item.key);
                    if (!bytes || bytes.length > MAX_JSON)
                        throw new ProviderError("INVALID_REMOTE_METADATA");
                    const value = parseJson(bytes);
                    if (!wireValid(value, id, maximum) || !items.some(item => item.key === `${id}.data` && item.size === value.size))
                        throw new ProviderError("INCOMPLETE_REMOTE_OBJECT");
                    return storage.startChanges ? withRemoteIds(value, items, request) : value;
                };
                // Keep Google connections bounded, and finish all reads before releasing
                // the account lock even if one object fails validation.
                for (let offset = 0; offset < selected.length; offset += 4) {
                    const batch = await Promise.allSettled(selected.slice(offset, offset + 4).map(readMetadata));
                    const failure = batch.find(value => value.status === 'rejected');
                    if (failure)
                        throw failure.reason;
                    result.push(...batch.map(value => value.value));
                }
                return Response.json(config.streaming ? { files: result, nextCursor: metadata.length > 16 ? selected.at(-1).key.slice(0, -5) : null } : result);
            })();
        const file = path.match(/^\/v1\/files\/([^/]+)$/);
        if (file && UUID.test(file[1]) && ["GET", "PUT", "DELETE"].includes(method))
            return locked(`${session.accountId}:object:${file[1]}`, async () => {
                const id = file[1], metaKey = `${id}.meta`, dataKey = `${id}.data`;
                if(method!=='GET'&&mobile.active(session,id))throw new ProviderError('UPLOAD_IN_PROGRESS',409);
                const range=method==='GET'?request.headers.get('range'):null;
                if(range&&!/^bytes=(0|[1-9][0-9]{0,12})-$/.test(range))throw new ProviderError('INVALID_DOWNLOAD_RANGE',400);
                if (method !== 'DELETE' && isDeleted(session, id))
                    throw new ProviderError(method === 'GET' ? 'OBJECT_NOT_FOUND' : 'OBJECT_DELETION_PENDING', method === 'GET' ? 404 : 409);
                if(method==='GET'&&url.searchParams.has('shelf-direct')){
                    if(!config.directUploads)throw new ProviderError('DIRECT_DOWNLOAD_UNSUPPORTED',409);
                    return directDownload(request,session,storage,id);
                }
                if (method === 'GET' && storage.getReceiptStream && request.headers.has('x-shelf-object-receipt')) {
                    const remoteId = downloadReceipt(request.headers.get('x-shelf-object-receipt'), session.accountId, id);
                    if (remoteId){
                        if(range&&storage.getReceiptRangeStream)return storage.getReceiptRangeStream(remoteId,range);
                        return new Response(await storage.getReceiptStream(remoteId), { headers: { 'content-type': 'application/octet-stream',...(storage.getReceiptRangeStream?{'accept-ranges':'bytes'}:{}) } });
                    }
                }
                if (storage.prepareObject)
                    await storage.prepareObject(id);
                if (method === "GET") {
                    if (!(storage.has ? await storage.has(metaKey) : await storage.get(metaKey)))
                        throw new ProviderError("OBJECT_NOT_FOUND", 404);
                    if(range&&storage.getRangeStream){const response=await storage.getRangeStream(dataKey,range);if(!response)throw new ProviderError('INCOMPLETE_REMOTE_OBJECT');return response;}
                    const data = config.streaming && storage.getStream ? await storage.getStream(dataKey) : await storage.get(dataKey);
                    if (!data)
                        throw new ProviderError("INCOMPLETE_REMOTE_OBJECT");
                    return new Response(data, { headers: { "content-type": "application/octet-stream",...(storage.getRangeStream?{'accept-ranges':'bytes'}:{}) } });
                }
                if (method === "DELETE") {
                    deletedObjects.set(session.accountId + ':' + id, { expiresAt: now() + 30 * 86400000, cleanupPending: true });
                    await persist();
                    for (const record of uploads.values())
                        if (record.accountId === session.accountId && record.wire.id === id && !record.committed) {
                            record.cancelled = true;
                            delete record.location;
                        }
                    for (const [transferId, record] of transfers)
                        if (record.accountId === session.accountId && record.wire.id === id)
                            transfers.delete(transferId);
                    await persist();
                    const marker = Buffer.from("SHELF_DELETE_V1");
                    await verifiedPut(storage, `${id}.delete`, marker, 'DELETE_MARKER_NOT_CONFIRMED');
                    await cleanup(storage, id);
                    deletedObjects.get(session.accountId + ':' + id).cleanupPending = false;
                    await persist();
                    return Response.json({ ok: true });
                }
                if (await storage.get(`${id}.delete`))
                    throw new ProviderError("OBJECT_DELETION_PENDING", 409);
                if ([...uploads.values()].some(r => r.accountId === session.accountId && r.wire.id === id && !r.committed && !r.cancelled && r.expiresAt > now()))
                    throw new ProviderError('UPLOAD_IN_PROGRESS', 409);
                if ([...transfers.values()].some(record => record.accountId === session.accountId && record.wire.id === id && !record.committed))
                    throw new ProviderError('UPLOAD_IN_PROGRESS', 409);
                if (!(storage.has ? await storage.has('vault.json') : await storage.get("vault.json")))
                    throw new ProviderError("VAULT_NOT_INITIALIZED", 409);
                const encoded = request.headers.get("x-shelf-metadata") ?? "";
                if (encoded.length > MAX_JSON * 2 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))
                    throw new ProviderError("INVALID_METADATA", 400);
                const value = parseJson(Buffer.from(encoded, "base64"));
                if (value?.commitReceipt !== undefined || !wireValid(value, id, maximum))
                    throw new ProviderError("INVALID_METADATA", 400);
                if (config.streaming && value.size > directMaximum)
                    throw new ProviderError('USE_SEGMENTED_UPLOAD', 400);
                return boundedDirectUpload(value.size, async () => {
                    const data = await limited(request, directMaximum);
                    if (data.length !== value.size || objectHash(data) !== value.sha256 || data.subarray(0, 8).toString() !== "SHELFD01")
                        throw new ProviderError("OBJECT_HASH_MISMATCH", 400);
                    const existing = await storage.get(metaKey);
                    if (existing) {
                        const previous = parseJson(existing);
                        if (previous.sha256 === value.sha256 && JSON.stringify(previous.metadata) === JSON.stringify(value.metadata))
                            return Response.json(storage.startChanges ? withRemoteIds(previous, await remoteItems(storage, id), request) : previous);
                        throw new ProviderError("OBJECT_ID_ALREADY_COMMITTED", 409);
                    }
                    await verifiedPut(storage, dataKey, data, 'UPLOAD_NOT_CONFIRMED');
                    await verifiedPut(storage, metaKey, Buffer.from(JSON.stringify(value)), 'METADATA_WRITE_NOT_CONFIRMED');
                    const confirmed = request.headers.get('x-shelf-commit-receipt') === 'verified-v1' ? { ...value, commitReceipt: commitReceipt(value, session) } : value;
                    return Response.json(storage.startChanges ? withRemoteIds(confirmed, await remoteItems(storage, id), request) : confirmed, { status: 201 });
                });
            });
        throw new ProviderError("NOT_FOUND", 404);
    }
    return {
        ready,
        async consumeEventTicket(ticket, requestOrigin) { await ready; return events.consume(ticket, requestOrigin); },
        async maintenance() {
            await ready;
            const uploadPending = await directUploads.maintenance((id, binding) => driver(id, !!binding)), sharePending = await sharing.maintenance();
            let count = 0, dirty = false;
            for (const [key, record] of deletedObjects) {
                if (!record.cleanupPending || count++ >= 4)
                    continue;
                const split = key.lastIndexOf(':'), accountId = key.slice(0, split), id = key.slice(split + 1);
                try {
                    await locked(accountId + ':object:' + id, async () => { await cleanup(driver(accountId), id); record.cleanupPending = false; dirty = true; });
                }
                catch { /* Retry the durable deletion intent next time. */ }
            }
            if (dirty)
                await persist();
            return sharePending || uploadPending || [...deletedObjects.values()].some(record => record.cleanupPending);
        },
        async fetch(request, context = {}) {
            context = { ...context };
            const began = Date.now();
            const requestOrigin = request.headers.get("origin"), cors = requestOrigin && allowedOrigins.has(requestOrigin) ? { "access-control-allow-origin": requestOrigin, vary: "Origin", "access-control-allow-methods": "GET,PUT,POST,DELETE,OPTIONS", "access-control-allow-headers": "authorization,content-type,x-shelf-request,x-shelf-claim,x-shelf-metadata,x-shelf-offset,x-shelf-commit,x-shelf-sync,x-shelf-download,x-shelf-object-receipt,x-shelf-commit-receipt,x-shelf-share-protocol,range", "access-control-expose-headers":"accept-ranges,content-range,content-length" } : {};
            let response;
            try {
                if (requestOrigin && !allowedOrigins.has(requestOrigin))
                    throw new ProviderError("ORIGIN_NOT_ALLOWED", 403);
                if (request.method === "OPTIONS")
                    response = new Response(null, { status: 204 });
                else {
                    if (!["GET", "HEAD"].includes(request.method) && requestOrigin && request.headers.get("x-shelf-request") !== "1")
                        throw new ProviderError("CSRF_REJECTED", 403);
                    response = await route(request, context);
                }
            }
            catch (error) {
                response = Response.json({ error: error instanceof ProviderError ? error.message : "DRIVE_OPERATION_FAILED" }, { status: error instanceof ProviderError ? error.status : 500 });
            }
            const headers = new Headers(response.headers);
            const metrics = context.googleMetrics;
            headers.set('server-timing', `shelf;dur=${Date.now() - began}, google;dur=${metrics?.duration ?? 0};desc="${metrics?.count ?? 0} requests"`);
            headers.set('x-shelf-google-requests', String(metrics?.count ?? 0));
            for (const [key, value] of Object.entries(cors))
                headers.set(key, value);
            headers.set("cache-control", "no-store");
            headers.set("x-content-type-options", "nosniff");
            headers.set("referrer-policy", "no-referrer");
            headers.set("x-frame-options", "DENY");
            return new Response(response.body, { status: response.status, headers });
        },
    };
}
