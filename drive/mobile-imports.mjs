import {createCipheriv,createHash,randomBytes} from 'node:crypto';
import {sha256} from '@noble/hashes/sha2.js';
import {ProviderError} from './providers.mjs';

export const MOBILE_CHUNK=4*1024*1024;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const bad=(message,status=400)=>{throw new ProviderError(message,status);};
// Pin the SHA-256 implementation through the release dependency lock. Only a
// partial block and eight state words persist, inside the existing sealed store.
function packHash(h){return {version:1,words:h.get(),length:h.length,pos:h.pos,tail:Buffer.from(h.buffer.subarray(0,h.pos)).toString('base64')};}
function unpackHash(s){
 if(s?.version!==1||!Array.isArray(s.words)||s.words.length!==8||s.words.some(v=>!Number.isInteger(v))||!Number.isSafeInteger(s.length)||s.length<0||!Number.isInteger(s.pos)||s.pos<0||s.pos>63)bad('MOBILE_STATE_INVALID',409);
 const tail=Buffer.from(s.tail,'base64');if(tail.length!==s.pos)bad('MOBILE_STATE_INVALID',409);
 const h=sha256.create();h.set(...s.words);h.length=s.length;h.pos=s.pos;h.buffer.fill(0);h.buffer.set(tail);return h;
}
function seal(bytes,key,aad,nonce){
 const cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(Buffer.from(aad));
 return Buffer.concat([cipher.update(bytes),cipher.final(),cipher.getAuthTag()]);
}
function keyFor(account,scope){
 const k=account?.spaceKey;
 if(!k?.ready||k.scope!==scope||! /^[A-Za-z0-9+/]{43}=$/.test(k.key??''))bad('MOBILE_ACCOUNT_KEY_NOT_READY',409);
 const key=Buffer.from(k.key,'base64');if(key.length!==32)bad('MOBILE_ACCOUNT_KEY_NOT_READY',409);return key;
}
export function createMobileImports({records,accounts,base,now,persist,locked,limited,parseJson,maximum,maxFileBytes,isDeleted}){
 const scopeFor=accountId=>digest(`${base.toLowerCase()}\0${accountId}`);
 const mapKey=(session,id)=>`${session.accountId}:${id}`;
 function active(session,id){const r=records.get(mapKey(session,id));return !!r&&!r.committed&&!r.cancelled&&r.expiresAt>now();}
 async function route(request,session,storage,path,method){
  if(path==='/v1/mobile/capabilities'&&method==='GET'){
   const ready=accounts.get(session.accountId)?.spaceKey?.ready===true;
   if(ready){const key=keyFor(accounts.get(session.accountId),scopeFor(session.accountId));key.fill(0);}
   return Response.json({protocol:'shelf-mobile-import-v1',partBytes:MOBILE_CHUNK,maxFileBytes,storage:'google-drive',encryption:'server-aes256gcm-chunked-v1',spaceReady:ready,rawUpload:true});
  }
  const match=path.match(/^\/v1\/mobile\/files\/([0-9a-f-]{36})(?:\/(commit|raw|[1-9][0-9]{0,4}))?$/);
  if(!match||!UUID.test(match[1]))bad('NOT_FOUND',404);
  const id=match[1],action=match[2],k=mapKey(session,id);
  if(method==='PUT'&&action==='raw')return locked(`${session.accountId}:mobile-stream:${id}`,async()=>{
   const record=records.get(k);
   if(!record||record.owner!==session.sessionHash||record.cancelled||record.expiresAt<=now())bad('MOBILE_IMPORT_NOT_FOUND',404);
   if(record.input.mode!=='raw-stream-v1'||record.nextPart!==1||record.committed||record.error)bad('MOBILE_RAW_RESTART_REQUIRED',409);
   const reader=request.body?.getReader();let count=0,used=0,number=1,part=Buffer.alloc(Math.min(MOBILE_CHUNK,record.input.size));
   record.streamComplete=false;await persist();
   async function send(){
    const response=await route(new Request(base+'/v1/mobile/files/'+id+'/'+number,{method:'PUT',body:part.subarray(0,used)}),session,storage,'/v1/mobile/files/'+id+'/'+number,'PUT');
    if(!response.ok)bad('MOBILE_STREAM_PART_FAILED',502);
    number++;used=0;part=Buffer.alloc(Math.min(MOBILE_CHUNK,record.input.size-count));
   }
   try{
    if(reader)for(;;){
     const {done,value}=await reader.read();if(done)break;
     if(count+value.length>record.input.size)bad('MOBILE_STREAM_SIZE_MISMATCH');
     let offset=0;
     while(offset<value.length){
      const take=Math.min(part.length-used,value.length-offset);part.set(value.subarray(offset,offset+take),used);used+=take;offset+=take;count+=take;
      if(used===part.length)await send();
     }
    }
    if(count!==record.input.size)bad('MOBILE_STREAM_SIZE_MISMATCH');
    if(record.input.size===0)await send();
    record.streamComplete=true;await persist();
    return Response.json({id,received:count,sha256:record.input.sha256});
   }catch(error){
    record.error=error instanceof ProviderError?error.message:'MOBILE_STREAM_INTERRUPTED';await persist();
    try{await reader?.cancel();}catch{}
    throw error;
   }finally{reader?.releaseLock();part.fill(0);}
  });
  return locked(`${session.accountId}:object:${id}`,async()=>{
   if(isDeleted(session,id))bad('OBJECT_DELETION_PENDING',409);
   const scope=scopeFor(session.accountId),key=keyFor(accounts.get(session.accountId),scope);
   try{
    if(method==='POST'&&!action){
     const meta=parseJson(await limited(request,16384));
     if(meta.id!==id||typeof meta.name!=='string'||!meta.name||meta.name.length>255||/[\r\n\0/\\]/.test(meta.name)||(meta.name.startsWith('__shelf_')&&!(meta.kind==='text'&&meta.name==='__shelf_note_v1__'+id+'.txt'))||!Number.isSafeInteger(meta.size)||meta.size<0||meta.size>maxFileBytes||!/^[a-f0-9]{64}$/.test(meta.sha256??'')||!['whole-file','base64-window-v1','raw-stream-v1'].includes(meta.mode)||meta.mode==='whole-file'&&meta.size>MOBILE_CHUNK)bad('INVALID_MOBILE_METADATA');
     if(meta.kind!==undefined&&!['file','text'].includes(meta.kind)||meta.kind==='text'&&(meta.name!=='__shelf_note_v1__'+id+'.txt'||meta.size===0||meta.size>65536||meta.mode!=='raw-stream-v1'))bad('INVALID_MOBILE_TEXT');
     const wireSize=24+meta.size+Math.max(1,Math.ceil(meta.size/MOBILE_CHUNK))*16;if(wireSize>maximum)bad('REQUEST_TOO_LARGE',413);
     const previous=records.get(k);
     if(previous){
      if(previous.owner!==session.sessionHash||previous.expiresAt<=now()||JSON.stringify(previous.input)!==JSON.stringify(meta))bad('MOBILE_IMPORT_CONFLICT',409);
      return Response.json({id,partBytes:MOBILE_CHUNK,nextPart:previous.nextPart,committed:previous.committed??false});
     }
     if(await storage.get(`${id}.meta`)||await storage.get(`${id}.data`)||await storage.get(`${id}.delete`))bad('OBJECT_ID_ALREADY_EXISTS',409);
     if(!storage.beginUpload||!storage.uploadPart||!storage.getStream)bad('SEGMENTED_UPLOAD_UNAVAILABLE',501);
     const prefix=randomBytes(8),header=Buffer.alloc(24);header.write('SHELFD01');prefix.copy(header,8);header.writeBigUInt64BE(BigInt(meta.size),16);
     const cipherHash=sha256.create();cipherHash.update(header);
     const location=await storage.beginUpload(`${id}.data`,wireSize);
     records.set(k,{accountId:session.accountId,owner:session.sessionHash,input:meta,scope,keyHash:digest(key),prefix:prefix.toString('base64'),carry:header.toString('base64'),plainHash:packHash(sha256.create()),cipherHash:packHash(cipherHash),location,wireSize,offset:0,nextPart:1,received:0,addedAt:new Date(now()).toISOString(),expiresAt:now()+6*3600000});
     await persist();return Response.json({id,partBytes:MOBILE_CHUNK,nextPart:1},{status:201});
    }
    const record=records.get(k);
    if(!record||record.owner!==session.sessionHash||record.cancelled||record.expiresAt<=now())bad('MOBILE_IMPORT_NOT_FOUND',404);
    if(record.keyHash!==digest(key)||record.scope!==scope)bad('DRIVE_ACCOUNT_CHANGED',409);
    if(method==='DELETE'&&!action){
     if(record.committed||await storage.get(`${id}.meta`))bad('MOBILE_ALREADY_COMMITTED',409);
     // This randomly named object was proven absent when the import began.
     await storage.delete(`${id}.data`);record.cancelled=true;delete record.location;delete record.carry;await persist();return Response.json({ok:true});
    }
    if(method==='PUT'&&action!=='commit'&&action){
     if(record.error)bad(record.error,409);
     const number=Number(action),bytes=await limited(request,MOBILE_CHUNK+4),fingerprint=digest(bytes);
     if(number===record.lastPart&&fingerprint===record.lastInputHash)return Response.json({id,partNumber:number,bytes:record.lastPlainBytes,received:record.received});
     if(record.committed||number!==record.nextPart)bad('INVALID_MOBILE_PART_ORDER',409);
     const start=(number-1)*MOBILE_CHUNK,wanted=Math.min(MOBILE_CHUNK,record.input.size-start);
     if(wanted<0||wanted===0&&record.input.size!==0)bad('INVALID_MOBILE_PART_ORDER',409);
     const leading=record.input.mode==='base64-window-v1'?start%3:0;
     const windowEnd=record.input.mode==='base64-window-v1'?Math.min(record.input.size,Math.ceil((start+wanted)/3)*3):start+wanted;
     if(bytes.length!==windowEnd-(start-leading))bad('MOBILE_PART_SIZE_MISMATCH');
     if(record.pendingPart&&(record.pendingPart.number!==number||record.pendingPart.hash!==fingerprint))bad('MOBILE_RETRY_CONTENT_CHANGED',409);
     // Freeze the input fingerprint before using a nonce or writing remotely.
     record.pendingPart={number,hash:fingerprint};await persist();
     const plain=bytes.subarray(leading,leading+wanted),nonce=Buffer.alloc(12);Buffer.from(record.prefix,'base64').copy(nonce);nonce.writeUInt32BE(number-1,8);
     if(record.input.kind==='text'){try{new TextDecoder('utf-8',{fatal:true}).decode(plain);}catch{bad('INVALID_MOBILE_TEXT');}}
     const encrypted=seal(plain,key,`shelf-drive-data-v1:${scope}:${id}:${number-1}/${record.input.size}`,nonce);
     const plainHash=unpackHash(record.plainHash),cipherHash=unpackHash(record.cipherHash);plainHash.update(plain);cipherHash.update(encrypted);
     const last=start+wanted===record.input.size;
     const finalPlainHash=last?Buffer.from(plainHash.clone().digest()).toString('hex'):undefined;
     if(last&&finalPlainHash!==record.input.sha256){record.error='MOBILE_ORIGINAL_CHECKSUM_MISMATCH';await persist();bad(record.error);}
     const pending=Buffer.concat([Buffer.from(record.carry,'base64'),encrypted]);let consumed=0,offset=record.offset,receipt=record.receipt;
     while(pending.length-consumed>=MOBILE_CHUNK||last&&consumed<pending.length){
      const count=Math.min(MOBILE_CHUNK,pending.length-consumed),part=pending.subarray(consumed,consumed+count);
      const result=await storage.uploadPart(record.location,part,offset,record.wireSize);if(result&&typeof result==='object')receipt=result;
      consumed+=count;offset+=count;
     }
     Object.assign(record,{offset,carry:pending.subarray(consumed).toString('base64'),received:start+wanted,nextPart:number+1,lastPart:number,lastInputHash:fingerprint,lastPlainBytes:wanted,plainHash:packHash(plainHash),cipherHash:packHash(cipherHash)});
     if(receipt)record.receipt=receipt;delete record.pendingPart;
     if(last)record.cipherDigest=Buffer.from(cipherHash.clone().digest()).toString('hex');
     await persist();return Response.json({id,partNumber:number,bytes:wanted,received:record.received});
    }
    if(method==='POST'&&action==='commit'){
     if(record.committed)return Response.json(record.result);
     if(record.error)bad(record.error,409);
     if(record.input.mode==='raw-stream-v1'&&!record.streamComplete)bad('INCOMPLETE_UPLOAD',409);
     if(record.received!==record.input.size||record.offset!==record.wireSize||record.carry!==''||!record.cipherDigest)bad('INCOMPLETE_UPLOAD',409);
     const metadata={id,name:record.input.name,size:record.input.size,sha256:record.input.sha256,addedAt:record.addedAt,sourceDevice:'iPhone'};
     const nonce=randomBytes(12),wire={version:1,id,metadata:{nonce:nonce.toString('base64'),ciphertext:seal(Buffer.from(JSON.stringify(metadata)),key,`shelf-drive-meta-v1:${scope}:${id}`,nonce).toString('base64')},size:record.wireSize,sha256:record.cipherDigest};
     const previous=await storage.get(`${id}.meta`);
     if(previous){
      const saved=parseJson(previous);if(saved.sha256!==wire.sha256||saved.size!==wire.size)bad('MOBILE_IMPORT_CONFLICT',409);
     }else{
      if(!storage.confirmUpload||!await storage.confirmUpload(`${id}.data`,wire,record.receipt)){
       const stream=await storage.getStream(`${id}.data`);if(!stream)bad('UPLOAD_NOT_CONFIRMED',502);
       const hash=createHash('sha256'),reader=stream.getReader();let count=0;
       try{for(;;){const {done,value}=await reader.read();if(done)break;count+=value.length;if(count>wire.size){await reader.cancel();bad('UPLOAD_NOT_CONFIRMED',502);}hash.update(value);}}finally{reader.releaseLock();}
       if(count!==wire.size||hash.digest('hex')!==wire.sha256)bad('UPLOAD_NOT_CONFIRMED',502);
      }
      const body=Buffer.from(JSON.stringify(wire));if(storage.putVerified)await storage.putVerified(`${id}.meta`,body);else{await storage.put(`${id}.meta`,body);if(!(await storage.get(`${id}.meta`))?.equals(body))bad('METADATA_WRITE_NOT_CONFIRMED',502);}
     }
     record.committed=true;record.result=metadata;record.expiresAt=now()+3600000;delete record.location;delete record.plainHash;delete record.cipherHash;await persist();
     return Response.json(metadata,{status:201});
    }
    bad('NOT_FOUND',404);
   }finally{key.fill(0);}
  });
 }
 return {active,route};
}
