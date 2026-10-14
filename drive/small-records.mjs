import { ProviderError, objectHash } from './providers.mjs';
const limit = 2 * 1024 * 1024, uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export async function readSmallRecords(request, session, storage, { limited, parseJson, wireValid, maximum, isDeleted, locked, downloadReceipt }) {
    const value = parseJson(await limited(request, 192 * 1024)), ids = value.ids;
    if (!Array.isArray(ids) || !ids.length || ids.length > 64 || new Set(ids).size !== ids.length || ids.some(id => !uuid.test(id)))
        throw new ProviderError('INVALID_BATCH', 400);
    const receipts=value.receipts;
    if(receipts!==undefined && (!Array.isArray(receipts)||receipts.length!==ids.length))throw new ProviderError('INVALID_BATCH',400);
    const direct=new Map();
    if(receipts!==undefined){
        for(let index=0;index<ids.length;index++){
            const item=receipts[index];
            if(!item||item.id!==ids[index]||!Number.isSafeInteger(item.size)||item.size<0||item.size>limit||typeof item.sha256!=='string'||!/^[a-f0-9]{64}$/.test(item.sha256))throw new ProviderError('INVALID_BATCH',400);
            // The signed receipt binds the provider object to this account and ID.
            // Never accept caller-supplied Google IDs or another account's receipt.
            const remoteId=downloadReceipt(item.receipt,session.accountId,item.id);
            if(remoteId&&storage.getReceiptStream)direct.set(item.id,{...item,remoteId});
        }
        if(receipts.reduce((size,item)=>size+item.size,0)>limit)throw new ProviderError('BATCH_TOO_LARGE',413);
    }
    const wires = [];
    for (let offset = 0; offset < ids.length; offset += 4) {
        const results = await Promise.allSettled(ids.slice(offset, offset + 4).map(async (id) => {
            if (isDeleted(session, id))
                throw new ProviderError('OBJECT_NOT_FOUND', 404);
            if(direct.has(id))return direct.get(id);
            if (storage.prepareObject)
                await storage.prepareObject(id);
            if (await storage.get(id + '.delete'))
                throw new ProviderError('OBJECT_NOT_FOUND', 404);
            const bytes = await storage.get(id + '.meta');
            if (!bytes)
                throw new ProviderError('OBJECT_NOT_FOUND', 404);
            if (bytes.length > 16384)
                throw new ProviderError('INVALID_REMOTE_METADATA');
            const wire = parseJson(bytes);
            if (!wireValid(wire, id, maximum))
                throw new ProviderError('INVALID_REMOTE_METADATA');
            return wire;
        }));
        const failure = results.find(r => r.status === 'rejected');
        if (failure)
            throw failure.reason;
        wires.push(...results.map(r => r.value));
    }
    if (wires.reduce((size, wire) => size + wire.size, 0) > limit)
        throw new ProviderError('BATCH_TOO_LARGE', 413);
    const files = new Array(wires.length);
    for (let offset = 0; offset < wires.length; offset += 4) {
        const results = await Promise.allSettled(wires.slice(offset, offset + 4).map((wire, index) => locked(session.accountId + ':object:' + wire.id, async () => {
            if (isDeleted(session, wire.id))
                throw new ProviderError('OBJECT_NOT_FOUND', 404);
            const stream = wire.remoteId ? await storage.getReceiptStream(wire.remoteId) : storage.getStream ? await storage.getStream(wire.id + '.data') : new Response(await storage.get(wire.id + '.data')).body;
            if (!stream)
                throw new ProviderError('OBJECT_NOT_FOUND', 404);
            const reader = stream.getReader(), chunks = [];
            let size = 0;
            try {
                for (;;) {
                    const next = await reader.read();
                    if (next.done)
                        break;
                    size += next.value.length;
                    if (size > wire.size) {
                        await reader.cancel();
                        throw new ProviderError('OBJECT_HASH_MISMATCH');
                    }
                    chunks.push(Buffer.from(next.value));
                }
            }
            finally {
                reader.releaseLock();
            }
            const bytes = Buffer.concat(chunks);
            if (size !== wire.size || objectHash(bytes) !== wire.sha256)
                throw new ProviderError('OBJECT_HASH_MISMATCH');
            files[offset + index] = { id: wire.id, data: bytes.toString('base64') };
        })));
        const failure = results.find(r => r.status === 'rejected');
        if (failure)
            throw failure.reason;
    }
    return Response.json({ files });
}
