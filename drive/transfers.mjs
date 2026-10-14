import { createHash } from 'node:crypto';
import { ProviderError,opaqueSession,objectHash } from './providers.mjs';
const CHUNK=4*1024*1024;
export async function verifyStream(stream,wire) {
  if(!stream)throw new ProviderError('UPLOAD_NOT_CONFIRMED');
  const digest=createHash('sha256'),reader=stream.getReader();let size=0,magic=Buffer.alloc(0);
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>wire.size){await reader.cancel();throw new ProviderError('OBJECT_HASH_MISMATCH',400);}if(magic.length<8)magic=Buffer.concat([magic,Buffer.from(value).subarray(0,8-magic.length)]);digest.update(value);}}
  finally{reader.releaseLock();}
  if(size!==wire.size||magic.toString()!=='SHELFD01'||digest.digest('hex')!==wire.sha256)throw new ProviderError('OBJECT_HASH_MISMATCH',400);
}
export function createTransfers({transfers,now,persist,limited,parseJson,wireValid,maximum,receipt,isDeleted=()=>false}) {
  async function commit(record,storage){
    if(record.offset!==record.wire.size)throw new ProviderError('INCOMPLETE_UPLOAD',409);
    if(storage.prepareObject)await storage.prepareObject(record.wire.id);
    const previous=await storage.get(`${record.wire.id}.meta`);
    if(previous){const wire=parseJson(previous);if(JSON.stringify(wire)!==JSON.stringify(record.wire))throw new ProviderError('OBJECT_ID_ALREADY_COMMITTED',409);if(!record.committed)await verifyStream(await storage.getStream(`${record.wire.id}.data`),record.wire);record.committed=true;await persist();return {wire,status:200};}
    if(!storage.confirmUpload||!await storage.confirmUpload(`${record.wire.id}.data`,record.wire,record.receipt))await verifyStream(await storage.getStream(`${record.wire.id}.data`),record.wire);
    const meta=Buffer.from(JSON.stringify(record.wire));if(storage.putVerified)await storage.putVerified(`${record.wire.id}.meta`,meta);else{await storage.put(`${record.wire.id}.meta`,meta);if(!(await storage.get(`${record.wire.id}.meta`))?.equals(meta))throw new ProviderError('METADATA_WRITE_NOT_CONFIRMED');}
    record.committed=true;record.expiresAt=now()+3600000;await persist();return {wire:record.wire,status:201};
  }
  return async function route(request,session,storage,path,method){
    const confirmed=async record=>{const r=await commit(record,storage);if(receipt&&request.headers.get('x-shelf-commit-receipt')==='verified-v1')r.wire={...r.wire,commitReceipt:receipt(r.wire,session)};return r;};
    if(path==='/v1/transfers'&&method==='POST'){
      if(!storage.beginUpload)throw new ProviderError('SEGMENTED_UPLOAD_UNAVAILABLE',501);
      const wire=parseJson(await limited(request,16384));if(wire?.commitReceipt!==undefined||!wireValid(wire,wire.id,maximum)||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(wire.id))throw new ProviderError('INVALID_METADATA',400);
      if(isDeleted(session,wire.id))throw new ProviderError('OBJECT_DELETION_PENDING',409);
      if(storage.prepareObject)await storage.prepareObject(wire.id);
      const committed=await storage.get(`${wire.id}.meta`);
      if(committed){const previous=parseJson(committed);if(previous.sha256!==wire.sha256||JSON.stringify(previous.metadata)!==JSON.stringify(wire.metadata))throw new ProviderError('OBJECT_ID_ALREADY_COMMITTED',409);return Response.json({committed:previous});}
      if(!(storage.has?await storage.has('vault.json'):await storage.get('vault.json')))throw new ProviderError('VAULT_NOT_INITIALIZED',409);
      if(await storage.get(`${wire.id}.delete`))throw new ProviderError('OBJECT_DELETION_PENDING',409);
      for(const [transferId,record] of transfers){
        if(record.accountId!==session.accountId||record.wire.id!==wire.id)continue;
        if(record.expiresAt<=now()){transfers.delete(transferId);continue;}
        if(record.owner===session.sessionHash&&JSON.stringify(record.wire)===JSON.stringify(wire))return Response.json({transferId,offset:record.offset,chunkBytes:CHUNK});
        if(record.owner!==session.sessionHash&&(record.lastActivity ?? record.startedAt ?? record.expiresAt-6*3600000)+120000>now())throw new ProviderError('UPLOAD_IN_PROGRESS',409);
        // A retry may use a new nonce. Cancel this uncommitted lease before
        // starting a fresh transfer; an active other session cannot take it.
        transfers.delete(transferId);await persist();
      }
      if([...transfers.values()].filter(t=>t.accountId===session.accountId&&!t.committed&&t.expiresAt>now()).length>=8)throw new ProviderError('TOO_MANY_UPLOADS',429);
      const transferId=opaqueSession(),location=await storage.beginUpload(`${wire.id}.data`,wire.size);
      transfers.set(transferId,{wire,location,offset:0,owner:session.sessionHash,accountId:session.accountId,startedAt:now(),lastActivity:now(),expiresAt:now()+6*3600000});await persist();
      return Response.json({transferId,offset:0,chunkBytes:CHUNK},{status:201});
    }
    const match=path.match(/^\/v1\/transfers\/([A-Za-z0-9_-]{43})(\/commit)?$/);if(!match)return null;
    const record=transfers.get(match[1]);if(!record||record.owner!==session.sessionHash||record.accountId!==session.accountId||record.expiresAt<=now())throw new ProviderError('TRANSFER_NOT_FOUND',404);
    if(isDeleted(session,record.wire.id))throw new ProviderError('OBJECT_DELETION_PENDING',409);
    if(method==='PUT'&&!match[2]){
      const offsetText=request.headers.get('x-shelf-offset');if(!/^\d{1,12}$/.test(offsetText??''))throw new ProviderError('INVALID_UPLOAD_OFFSET',400);
      const offset=Number(offsetText),bytes=await limited(request,CHUNK);
      const autoCommit=request.headers.get('x-shelf-commit')==='last-part-v1';
      if(record.lastOffset===offset&&record.lastSize===bytes.length&&record.lastHash===objectHash(bytes))return Response.json({offset:record.offset,...(autoCommit&&record.offset===record.wire.size?{committed:(await confirmed(record)).wire}:{})});
      if(record.offset!==offset||offset%CHUNK||!bytes.length||offset+bytes.length>record.wire.size||offset+bytes.length<record.wire.size&&bytes.length!==CHUNK)throw new ProviderError('INVALID_UPLOAD_OFFSET',409);
      if(offset===0&&bytes.subarray(0,8).toString()!=='SHELFD01')throw new ProviderError('OBJECT_HASH_MISMATCH',400);
      const receipt=await storage.uploadPart(record.location,bytes,offset,record.wire.size);if(offset+bytes.length===record.wire.size&&receipt&&typeof receipt==='object')record.receipt=receipt;
      record.lastOffset=offset;record.lastSize=bytes.length;record.lastHash=objectHash(bytes);record.offset+=bytes.length;record.lastActivity=now();await persist();return Response.json({offset:record.offset,...(autoCommit&&record.offset===record.wire.size?{committed:(await confirmed(record)).wire}:{})});
    }
    if(method==='POST'&&match[2]){
      // Retain bounded progress until expiry so a lost commit response is retryable.
      const result=await confirmed(record);return Response.json(result.wire,{status:result.status});
    }
    throw new ProviderError('NOT_FOUND',404);
  };
}
