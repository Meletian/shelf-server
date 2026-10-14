// Official protocol references and the tested HTTP contract are in docs/NETDISK-STORAGE.md.
import { createHash, randomBytes } from "node:crypto";

export class ProviderError extends Error {
  constructor(code, status = 502) { super(code); this.status = status; }
}
const keyPattern = /^(?:vault\.json|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:meta|data|delete))$/;
function safeKey(key) { if (!keyPattern.test(key)) throw new ProviderError("INVALID_OBJECT_KEY", 400); return key; }
const digest = (kind, bytes) => createHash(kind).update(bytes).digest("hex");
async function json(response) {
  if (!response.ok) throw new ProviderError(response.status === 401 ? "DRIVE_AUTH_EXPIRED" : `DRIVE_HTTP_${response.status}`, response.status === 401 ? 401 : 502);
  const value = await response.json();
  if (value.error || (value.errno !== undefined && value.errno !== 0)) {
    if ([-6, 20016, 20017, 31045].includes(value.errno)) throw new ProviderError("DRIVE_AUTH_EXPIRED", 401);
    throw new ProviderError(`DRIVE_API_${value.errno ?? "ERROR"}`);
  }
  return value;
}
export function allowedDownload(url) {
  const value = new URL(url);
  if (value.protocol !== "https:" || value.username || value.password || (value.port && value.port !== "443") || !(value.hostname === "d.pcs.baidu.com" || value.hostname.endsWith(".baidupcs.com"))) throw new ProviderError("UNTRUSTED_DOWNLOAD_ADDRESS");
  return value;
}
export class GoogleDrive {
  constructor(token, fetcher = fetch, namespace = 'v1', folderContext = null) { if(!/^[a-z0-9-]{1,64}$/.test(namespace))throw new Error('Invalid storage namespace');this.token = token; this.fetch = fetcher;this.namespace=namespace;this.keyCache=new Map();this.folderContext=folderContext??{};this.metrics={count:0,duration:0}; }
  async request(url, options = {}) {
    const address = new URL(url);
    if (address.origin !== "https://www.googleapis.com" || !/^\/(?:drive\/v3|upload\/drive\/v3)\//.test(address.pathname)) throw new ProviderError("UNTRUSTED_GOOGLE_ADDRESS");
    // Google uses 308 with Location as resumable progress. Expose that response
    // without following Location, so bearer tokens never move to another host.
    // workerd's native fetch rejects a provider instance as its receiver.
    const fetcher = this.fetch;
    const began=Date.now();this.metrics.count++;
    const {longTransfer=false,...fetchOptions}=options;
    const stalled=new AbortController();
    const signal=longTransfer?AbortSignal.any([stalled.signal,AbortSignal.timeout(8*3600000)]):AbortSignal.timeout(120000);
    let headerTimer;
    try{
      const authorization=`Bearer ${await this.token()}`;
      if(longTransfer){headerTimer=setTimeout(()=>stalled.abort(),120000);headerTimer.unref?.();}
      const response=await fetcher(address,{...fetchOptions,redirect:'manual',signal,headers:{...options.headers,authorization}});
      clearTimeout(headerTimer);
      if(!longTransfer||!response.ok||!response.body)return response;
      const reader=response.body.getReader();
      const body=new ReadableStream({
        async pull(controller){
          const timer=setTimeout(()=>stalled.abort(),120000);timer.unref?.();
          try{const next=await reader.read();if(next.done)controller.close();else controller.enqueue(next.value);}
          catch(error){controller.error(error);}
          finally{clearTimeout(timer);}
        },
        async cancel(reason){stalled.abort(reason);await reader.cancel(reason);}
      });
      return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
    }
    finally{clearTimeout(headerTimer);this.metrics.duration+=Date.now()-began;}
  }
  async query(q) {
    const result = [], seen = new Set(); let page = "";
    do {
      const url = new URL("https://www.googleapis.com/drive/v3/files");
      url.search = new URLSearchParams({ q, spaces: "drive", pageSize: "1000", fields: "nextPageToken,files(id,name,size,mimeType,parents,appProperties)", ...(page ? { pageToken: page } : {}) }).toString();
      const response = await json(await this.request(url));
      if (!Array.isArray(response.files)) throw new ProviderError("INVALID_GOOGLE_LIST");
      result.push(...response.files); page = response.nextPageToken ?? "";
      if (page && seen.has(page) || result.length > 100000) throw new ProviderError("INVALID_GOOGLE_PAGINATION");
      seen.add(page);
    } while (page);
    return result;
  }
  async folder(create = false) {
    if(this.folderId)return this.folderId;
    const context=this.folderContext;
    if(context.id&&context.expiresAt>Date.now()){this.folderId=context.id;return this.folderId;}
    // Each account/namespace shares a context in the service. Serialize lookup
    // and creation so simultaneous phone/desktop requests cannot create twins.
    if(context.pending){const id=await context.pending;if(id||!create)return id;return this.folder(create);}
    const pending=this.resolveFolder(create);context.pending=pending;
    try{return await pending;}finally{if(context.pending===pending)delete context.pending;}
  }
  async resolveFolder(create) {
    const childName=this.namespace==='production-v1-uploads'?'上传暂存':this.namespace==='production-v1-shares'?'共享卡片':this.namespace==='production-v1-shares-uploads'?'共享暂存':null;
    let parent=null;
    if(childName){
      const rootContext=this.folderContext.root??(this.folderContext.root={});
      const root=new GoogleDrive(this.token,this.fetch,'production-v1',rootContext);root.metrics=this.metrics;
      parent=await root.folder(create);
      if(!parent)return null;
    }
    const folders = await this.query(`trashed = false and mimeType = 'application/vnd.google-apps.folder' and appProperties has { key='shelfStorage' and value='${this.namespace}' }`);
    if (folders.length > 1) throw new ProviderError("DUPLICATE_SHELF_FOLDER");
    let file=folders[0];
    const name=childName??(this.namespace==='production-v1'||this.namespace==='v1'?'Shelf':this.namespace.endsWith('-shares')?'Shelf · 共享卡片':'Shelf · shareshelf.cc.cd');
    if(!file){
      if(!create)return null;
      const metadata={name,mimeType:'application/vnd.google-apps.folder',appProperties:{shelfStorage:this.namespace},...(parent?{parents:[parent]}:{})};
      const response=await json(await this.request('https://www.googleapis.com/drive/v3/files',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(metadata)}));
      if(!/^[A-Za-z0-9_-]+$/.test(response.id))throw new ProviderError('INVALID_GOOGLE_ID');
      file={...metadata,parents:parent?[parent]:[],id:response.id};
    }
    if(!/^[A-Za-z0-9_-]{1,200}$/.test(file.id))throw new ProviderError('INVALID_GOOGLE_ID');
    if(this.namespace==='production-v1'){
      await this.organizeProductionFolders(file);
      await this.normalizeFolder(file,'Shelf');
    }else if(childName)await this.normalizeFolder(file,childName,parent);
    this.folderId=file.id;Object.assign(this.folderContext,{id:file.id,expiresAt:Date.now()+60000});return file.id;
  }
  async normalizeFolder(file,name,parent=null) {
    if(!/^[A-Za-z0-9_-]{1,200}$/.test(file.id)||file.mimeType!=='application/vnd.google-apps.folder'||!Array.isArray(file.parents)||file.parents.some(id=>!/^[A-Za-z0-9_-]{1,200}$/.test(id)))throw new ProviderError('INVALID_GOOGLE_FOLDER');
    const moving=parent&&(file.parents.length!==1||file.parents[0]!==parent);
    if(parent===file.id)throw new ProviderError('INVALID_GOOGLE_FOLDER');
    if(!moving&&file.name===name)return;
    const query=new URLSearchParams({fields:'id,name,mimeType,parents,appProperties'});
    if(moving){query.set('addParents',parent);if(file.parents.length)query.set('removeParents',file.parents.join(','));}
    const result=await json(await this.request(`https://www.googleapis.com/drive/v3/files/${file.id}?${query}`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({name})}));
    if(result.id!==file.id||result.name!==name||result.mimeType!==file.mimeType||result.appProperties?.shelfStorage!==file.appProperties?.shelfStorage||!Array.isArray(result.parents)||moving&&(result.parents.length!==1||result.parents[0]!==parent))throw new ProviderError('FOLDER_MOVE_NOT_CONFIRMED');
    Object.assign(file,result);
  }
  async organizeProductionFolders(root) {
    // Preserve namespace markers, IDs, vaults and every object. Old v1 objects
    // use another encryption scope, so archive their folder without flattening.
    // Never select a folder by its visible name or touch user-created folders.
    const names={'production-v1-uploads':'上传暂存','production-v1-shares':'共享卡片','production-v1-shares-uploads':'共享暂存',v1:'旧版空间'};
    const condition=Object.keys(names).map(namespace=>`appProperties has { key='shelfStorage' and value='${namespace}' }`).join(' or ');
    const children=await this.query(`trashed = false and mimeType = 'application/vnd.google-apps.folder' and (${condition})`);
    for(const [namespace,name] of Object.entries(names)){
      const matches=children.filter(file=>file.appProperties?.shelfStorage===namespace);
      if(matches.length>1){if(namespace==='v1')continue;throw new ProviderError('DUPLICATE_SHELF_FOLDER');}
      for(const file of matches){
        if(file.id===root.id)throw new ProviderError('INVALID_GOOGLE_FOLDER');
        // A user may have manually nested production inside an old folder.
        // Do not create a parent cycle while organizing legacy data.
        if(root.parents?.includes(file.id))continue;
        await this.normalizeFolder(file,name,root.id);
      }
    }
  }
  async list() {
    if(this.cachedList)return this.cachedList;
    const folder = await this.folder(); if (!folder) return [];
    if (!/^[A-Za-z0-9_-]+$/.test(folder)) throw new ProviderError("INVALID_GOOGLE_ID");
    const files = await this.query(`trashed = false and '${folder}' in parents`), names = new Set();
    this.cachedList=files.filter(file => keyPattern.test(file.name)).map(file => {
      if (names.has(file.name) || !/^[A-Za-z0-9_-]+$/.test(file.id)) throw new ProviderError("DUPLICATE_SHELF_OBJECT");
      names.add(file.name); return { key: file.name, id: file.id, size: Number(file.size) };
    });
    return this.cachedList;
  }
  async get(key) {
    safeKey(key); const file = await this.find(key); if (!file) return null;
    const response = await this.request(`https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`);
    if (!response.ok) await json(response);
    return Buffer.from(await response.arrayBuffer());
  }
  async find(key) {
    safeKey(key);
    if(this.keyCache.has(key))return this.keyCache.get(key);
    if(this.cachedList)return this.cachedList.find(file=>file.key===key)??null;
    await this.prepareKeys([key]);return this.keyCache.get(key)??null;
  }
  async prepareKeys(keys) {
    for(const key of keys)safeKey(key);
    const folder=await this.folder();if(!folder){for(const key of keys)this.keyCache.set(key,null);return;}
    const files=await this.query(`trashed = false and '${folder}' in parents and (${keys.map(key=>`name = '${key}'`).join(' or ')})`);
    for(const key of keys){const matching=files.filter(file=>file.name===key);if(matching.length>1||matching.some(file=>!/^[A-Za-z0-9_-]{1,200}$/.test(file.id)||!Number.isSafeInteger(Number(file.size))||Number(file.size)<0))throw new ProviderError('DUPLICATE_SHELF_OBJECT');const file=matching[0];this.keyCache.set(key,file?{key,id:file.id,size:Number(file.size)}:null);}
  }
  async prepareObject(id){await this.prepareKeys([`${id}.meta`,`${id}.data`,`${id}.delete`,'vault.json']);}
  async has(key){return !!await this.find(key);}
  async objectItems(id){const result=[];for(const key of [`${id}.meta`,`${id}.data`]){const file=await this.find(key);if(file)result.push(file);}return result;}
  async startChanges() {
    const value=await json(await this.request('https://www.googleapis.com/drive/v3/changes/startPageToken?fields=startPageToken'));
    if(typeof value.startPageToken!=='string'||!value.startPageToken||value.startPageToken.length>1024||/[\x00-\x20\x7f]/.test(value.startPageToken))throw new ProviderError('INVALID_GOOGLE_CHANGE_TOKEN');
    return value.startPageToken;
  }
  async changePage(pageToken) {
    // Existing clients often poll only changes. Migrate their layout lazily,
    // including accounts that do not upload again or fetch a full inventory.
    if(this.namespace==='production-v1')await this.folder(false);
    const url=new URL('https://www.googleapis.com/drive/v3/changes');
    url.search=new URLSearchParams({pageToken,pageSize:'16',spaces:'drive',includeRemoved:'true',fields:'nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,size,parents,trashed,mimeType))'}).toString();
    const response=await this.request(url);
    if(response.status===410||response.status===400)throw new ProviderError('DRIVE_CURSOR_RESET_REQUIRED',409);
    const value=await json(response),token=value.nextPageToken??value.newStartPageToken;
    if(!Array.isArray(value.changes)||value.changes.length>16||typeof token!=='string'||!token||token.length>1024||/[\x00-\x20\x7f]/.test(token))throw new ProviderError('INVALID_GOOGLE_CHANGES');
    for(const item of value.changes){if(typeof item.fileId!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(item.fileId)||item.removed!==undefined&&typeof item.removed!=='boolean'||!item.removed&&(!item.file||item.file.id!==item.fileId||typeof item.file.name!=='string'||item.file.parents!==undefined&&!Array.isArray(item.file.parents)))throw new ProviderError('INVALID_GOOGLE_CHANGES');if(item.file&&!item.file.parents)item.file.parents=[];}
    return {changes:value.changes,token,hasMore:!!value.nextPageToken};
  }
  async changedObject(id,folder) {
    if(!/^[0-9a-f-]{36}$/.test(id)||!/^[A-Za-z0-9_-]{1,200}$/.test(folder))throw new ProviderError('INVALID_OBJECT_KEY',400);
    const files=await this.query(`trashed = false and '${folder}' in parents and (name = '${id}.meta' or name = '${id}.data' or name = '${id}.delete')`),seen=new Set();
    const items=files.map(file=>{if(seen.has(file.name)||!keyPattern.test(file.name)||!/^[A-Za-z0-9_-]{1,200}$/.test(file.id))throw new ProviderError('DUPLICATE_SHELF_OBJECT');seen.add(file.name);return {key:file.name,id:file.id,size:Number(file.size)};});
    const metadata=items.find(item=>item.key===`${id}.meta`);
    if(items.some(item=>item.key===`${id}.delete`))return {removed:true,items};
    if(!metadata)return {pending:true,items};
    if(!Number.isSafeInteger(metadata.size)||metadata.size<0||metadata.size>16*1024)throw new ProviderError('INVALID_REMOTE_METADATA');
    const response=await this.request(`https://www.googleapis.com/drive/v3/files/${metadata.id}?alt=media`);if(!response.ok)await json(response);
    const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length!==metadata.size||bytes.length>16*1024)throw new ProviderError('INVALID_REMOTE_METADATA');
    return {items,metadata:bytes};
  }
  async directDownload(key) {
    safeKey(key);const file=await this.find(key);if(!file)return null;
    if(!key.endsWith('.data')||!/^[A-Za-z0-9_-]{1,200}$/.test(file.id)||!Number.isSafeInteger(file.size)||file.size<40)throw new ProviderError('INVALID_DIRECT_DOWNLOAD',400);
    return {remoteId:file.id,url:`https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`,size:file.size};
  }
  async getStream(key) {
    safeKey(key);const file=await this.find(key);if(!file)return null;
    const response=await this.request(`https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`,{longTransfer:key.endsWith('.data')});
    if(!response.ok)await json(response);return response.body;
  }
  async getReceiptStream(id){
    if(!/^[A-Za-z0-9_-]{1,200}$/.test(id))throw new ProviderError('INVALID_GOOGLE_ID',400);
    const response=await this.request(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`,{longTransfer:true});
    if(response.status===404)throw new ProviderError('OBJECT_NOT_FOUND',404);
    if(!response.ok)await json(response);return response.body;
  }
  async getRangeStream(key,range){safeKey(key);const file=await this.find(key);if(!file)return null;return this.getReceiptRangeStream(file.id,range,file.size);}
  async getReceiptRangeStream(id,range,expectedSize){
    if(!/^[A-Za-z0-9_-]{1,200}$/.test(id))throw new ProviderError('INVALID_GOOGLE_ID',400);
    const match=/^bytes=(0|[1-9][0-9]{0,12})-$/.exec(range??''),start=match?Number(match[1]):-1;
    if(!Number.isSafeInteger(start)||start<0||start>1099511627776)throw new ProviderError('INVALID_DOWNLOAD_RANGE',400);
    const response=await this.request(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`,{longTransfer:true,headers:{range}});
    if(response.status===404)throw new ProviderError('OBJECT_NOT_FOUND',404);
    const content=/^bytes ([0-9]+)-([0-9]+)\/([0-9]+)$/.exec(response.headers.get('content-range')??'');
    const total=content?Number(content[3]):0,length=response.headers.get('content-length');
    if(response.status!==206||!content||Number(content[1])!==start||Number(content[2])!==total-1||!Number.isSafeInteger(total)||total<=start||total>1099511627776||expectedSize!==undefined&&total!==expectedSize||length!==null&&Number(length)!==total-start){await response.body?.cancel();throw new ProviderError('INVALID_DOWNLOAD_RANGE');}
    return new Response(response.body,{status:206,headers:{'content-type':'application/octet-stream','accept-ranges':'bytes','content-range':response.headers.get('content-range'),'content-length':String(total-start)}});
  }
  async beginUpload(key,size) {
    safeKey(key);const folder=await this.folder(true),previous=await this.find(key);
    const url=`https://www.googleapis.com/upload/drive/v3/files${previous?`/${previous.id}`:''}?uploadType=resumable&fields=id,size,sha256Checksum`;
    const response=await this.request(url,{method:previous?'PATCH':'POST',headers:{'content-type':'application/json','x-upload-content-type':'application/octet-stream','x-upload-content-length':String(size)},body:JSON.stringify(previous?{}:{name:key,parents:[folder],appProperties:{shelfObject:'v1'}})});
    if(!response.ok)await json(response);const location=response.headers.get('location');
    if(!location)throw new ProviderError('MISSING_UPLOAD_SESSION');
    const address=new URL(location);
    if(address.origin!=='https://www.googleapis.com'||!address.pathname.startsWith('/upload/drive/v3/'))throw new ProviderError('UNTRUSTED_UPLOAD_ADDRESS');
    return location;
  }
  async beginDirectUpload(wire,intentId,clientOrigin){
    safeKey(wire.id+'.data');if(!/^[A-Za-z0-9_-]{43}$/.test(intentId))throw new ProviderError('INVALID_UPLOAD_INTENT',400);
    const folder=await this.folder(true);
    const context=this.folderContext.staging??(this.folderContext.staging={root:this.namespace==='production-v1-shares'?this.folderContext.root:this.folderContext});
    const stage=new GoogleDrive(this.token,this.fetch,this.namespace+'-uploads',context),stagingFolder=await stage.folder(true);
    const stagingName=`${crypto.randomUUID()}.data`;
    const response=await this.request('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,size,sha256Checksum',{
      method:'POST',headers:{'content-type':'application/json','x-upload-content-type':'application/octet-stream','x-upload-content-length':String(wire.size),...(clientOrigin?{origin:clientOrigin}:{})},
      body:JSON.stringify({name:stagingName,parents:[stagingFolder],appProperties:{shelfObject:'v1',shelfUpload:intentId}})
    });
    if(!response.ok)await json(response);const location=response.headers.get('location');let address;
    try{address=new URL(location);}catch{throw new ProviderError('UNTRUSTED_UPLOAD_ADDRESS');}
    if(address.origin!=='https://www.googleapis.com'||address.username||address.password||address.hash||!/^\/upload\/drive\/v3\/files(?:\/[A-Za-z0-9_-]{1,200})?$/.test(address.pathname)||!address.searchParams.get('upload_id')||location.length>4096)throw new ProviderError('UNTRUSTED_UPLOAD_ADDRESS');
    return {location,folder,stagingFolder,stagingName,intentId};
  }
  async confirmDirectUpload(record,candidateId){
    if(!/^[A-Za-z0-9_-]{1,200}$/.test(candidateId))throw new ProviderError('INVALID_GOOGLE_ID',400);
    const fields='id,name,size,sha256Checksum,parents,appProperties,trashed',wire=record.wire,finalName=safeKey(wire.id+'.data');
    let file=await json(await this.request(`https://www.googleapis.com/drive/v3/files/${candidateId}?fields=${fields}`));
    const correct=(value,final)=>value.id===candidateId&&Number(value.size)===wire.size&&!value.trashed&&value.name===(final?finalName:record.stagingName)&&Array.isArray(value.parents)&&value.parents.length===1&&value.parents[0]===(final?record.folder:record.stagingFolder)&&value.appProperties?.shelfObject==='v1'&&value.appProperties?.shelfUpload===record.intentId;
    const isFinal=correct(file,true);if(!isFinal&&!correct(file,false))throw new ProviderError('UPLOAD_NOT_CONFIRMED');
    if(file.sha256Checksum!==undefined&&file.sha256Checksum!==wire.sha256)throw new ProviderError('UPLOAD_CHECKSUM_MISMATCH');
    if(!file.sha256Checksum){
      const stream=await this.getReceiptStream(candidateId),reader=stream.getReader(),hash=createHash('sha256');let count=0;
      try{for(;;){const {done,value}=await reader.read();if(done)break;count+=value.length;if(count>wire.size){await reader.cancel();throw new ProviderError('UPLOAD_NOT_CONFIRMED');}hash.update(value);}}finally{reader.releaseLock();}
      if(count!==wire.size||hash.digest('hex')!==wire.sha256)throw new ProviderError('UPLOAD_CHECKSUM_MISMATCH');
    }
    if(!isFinal){
      const query=new URLSearchParams({addParents:record.folder,removeParents:record.stagingFolder,fields});
      file=await json(await this.request(`https://www.googleapis.com/drive/v3/files/${candidateId}?${query}`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({name:finalName})}));
      if(!correct(file,true)||file.sha256Checksum!==undefined&&file.sha256Checksum!==wire.sha256)throw new ProviderError('UPLOAD_NOT_CONFIRMED');
    }
    this.cachedList=null;this.keyCache.set(finalName,{key:finalName,id:candidateId,size:wire.size});
    return {id:candidateId,size:String(wire.size),sha256Checksum:wire.sha256};
  }
  async cancelDirectUpload(record){
    if(!/^[A-Za-z0-9_-]{43}$/.test(record.intentId)||! /^[A-Za-z0-9_-]{1,200}$/.test(record.stagingFolder)||! /^[A-Za-z0-9_-]{1,200}$/.test(record.folder))throw new ProviderError('INVALID_UPLOAD_INTENT',400);
    const files=await this.query(`trashed = false and ('${record.stagingFolder}' in parents or '${record.folder}' in parents) and appProperties has { key='shelfUpload' and value='${record.intentId}' }`);
    for(const file of files){if(!/^[A-Za-z0-9_-]{1,200}$/.test(file.id)||file.appProperties?.shelfUpload!==record.intentId)throw new ProviderError('INVALID_GOOGLE_LIST');const response=await this.request(`https://www.googleapis.com/drive/v3/files/${file.id}`,{method:'DELETE'});if(response.status!==404&&!response.ok)await json(response);}
    const remaining=await this.query(`trashed = false and ('${record.stagingFolder}' in parents or '${record.folder}' in parents) and appProperties has { key='shelfUpload' and value='${record.intentId}' }`);if(remaining.length)throw new ProviderError('DELETION_NOT_CONFIRMED');
  }
  async uploadPart(location,bytes,offset,total) {
    if(!bytes.length||bytes.length>4*1024*1024||offset<0||offset+bytes.length>total||offset%(4*1024*1024)||offset+bytes.length<total&&bytes.length!==4*1024*1024)throw new ProviderError('INVALID_UPLOAD_PART',400);
    const end=offset+bytes.length,response=await this.request(location,{method:'PUT',headers:{'content-type':'application/octet-stream','content-range':`bytes ${offset}-${end-1}/${total}`},body:bytes});
    if(end<total){if(response.status!==308||response.headers.get('range')!==`bytes=0-${end-1}`)throw new ProviderError('UPLOAD_NOT_CONFIRMED');return false;}
    const receipt=await json(response);if(!/^[A-Za-z0-9_-]{1,200}$/.test(receipt.id??'')||Number(receipt.size)!==total||receipt.sha256Checksum!==undefined&&!/^[a-f0-9]{64}$/.test(receipt.sha256Checksum))throw new ProviderError('INVALID_GOOGLE_UPLOAD');this.cachedList=null;this.keyCache.clear();return receipt;
  }
  async confirmUpload(key,wire,receipt){
    if(!receipt?.sha256Checksum)return false;
    if(receipt.sha256Checksum!==wire.sha256)throw new ProviderError('UPLOAD_CHECKSUM_MISMATCH');
    const file=await this.find(key);if(!file||file.id!==receipt.id||file.size!==wire.size||Number(receipt.size)!==wire.size)throw new ProviderError('UPLOAD_NOT_CONFIRMED');return true;
  }
  async put(key, bytes) {
    safeKey(key); const folder = await this.folder(true), previous = await this.find(key);
    // Google's multipart upload supports files below 5 MB. Bound this path at
    // 4 MiB so ordinary attachments avoid a resumable start and extra round trip.
    if(bytes.length<=4*1024*1024){
      const boundary=`shelf_${randomBytes(16).toString('hex')}`;
      const metadata=previous?{}:{name:key,parents:[folder],appProperties:{shelfObject:'v1'}};
      const body=Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`),
        Buffer.from(bytes),Buffer.from(`\r\n--${boundary}--\r\n`)
      ]);
      const confirmed=await json(await this.request(`https://www.googleapis.com/upload/drive/v3/files${previous?`/${previous.id}`:''}?uploadType=multipart&fields=id,size,sha256Checksum`,{method:previous?'PATCH':'POST',headers:{'content-type':`multipart/related; boundary=${boundary}`},body}));
      if(!/^[A-Za-z0-9_-]+$/.test(confirmed.id??'')||Number(confirmed.size)!==bytes.length)throw new ProviderError('INVALID_GOOGLE_UPLOAD');
      if(confirmed.sha256Checksum!==undefined&&confirmed.sha256Checksum!==objectHash(bytes))throw new ProviderError('UPLOAD_CHECKSUM_MISMATCH');
      this.keyCache.set(key,{key,id:confirmed.id,size:bytes.length});
      if(this.cachedList)this.cachedList=[...this.cachedList.filter(file=>file.key!==key),{key,id:confirmed.id,size:bytes.length}];
      return {checksumVerified:confirmed.sha256Checksum===objectHash(bytes)};
    }
    const url = `https://www.googleapis.com/upload/drive/v3/files${previous ? `/${previous.id}` : ""}?uploadType=resumable&fields=id,size`;
    const started = await this.request(url, { method: previous ? "PATCH" : "POST", headers: { "content-type": "application/json", "x-upload-content-type": "application/octet-stream", "x-upload-content-length": String(bytes.length) }, body: JSON.stringify(previous ? {} : { name: key, parents: [folder], appProperties: { shelfObject: "v1" } }) });
    if (!started.ok) await json(started);
    const location = started.headers.get("location"); if (!location) throw new ProviderError("MISSING_UPLOAD_SESSION");
    // Never forward a bearer token to a provider-controlled redirect at another origin.
    if (new URL(location).origin !== "https://www.googleapis.com") throw new ProviderError("UNTRUSTED_UPLOAD_ADDRESS");
    const chunk = 4 * 1024 * 1024;
    for (let offset = 0; offset < bytes.length; offset += chunk) {
      const end = Math.min(bytes.length, offset + chunk);
      const response = await this.request(location, { method: "PUT", headers: { "content-type": "application/octet-stream", "content-range": `bytes ${offset}-${end - 1}/${bytes.length}` }, body: bytes.subarray(offset, end) });
      if (end < bytes.length) {
        if (response.status !== 308 || response.headers.get("range") !== `bytes=0-${end - 1}`) throw new ProviderError("UPLOAD_NOT_CONFIRMED");
      } else {await json(response);this.cachedList=null;this.keyCache.clear();}
    }
  }
  async putVerified(key,bytes){
    const receipt=await this.put(key,bytes);
    // Use Google's SHA-256 receipt when supplied. A missing checksum falls
    // back to exact readback; absence never counts as verification.
    if(!receipt?.checksumVerified){const read=await this.get(key);if(!read?.equals(Buffer.from(bytes)))throw new ProviderError('UPLOAD_NOT_CONFIRMED');}
  }
  async deleteObject(id){
    const keys=[`${id}.meta`,`${id}.data`];
    const deleted=await Promise.allSettled(keys.map(key=>this.delete(key)));
    const failed=deleted.find(value=>value.status==='rejected');if(failed)throw failed.reason;
    await this.prepareKeys(keys);
    if(keys.some(key=>this.keyCache.get(key)))throw new ProviderError('DELETION_NOT_CONFIRMED');
    await this.delete(`${id}.delete`);
    if(await this.get(`${id}.delete`))throw new ProviderError('DELETION_NOT_CONFIRMED');
  }
  async delete(key) {
    safeKey(key); const file = await this.find(key); if (!file) return;
    const response = await this.request(`https://www.googleapis.com/drive/v3/files/${file.id}`, { method: "DELETE" });
    if (!response.ok && response.status !== 404) await json(response);
    this.cachedList=null;this.keyCache.delete(key);
  }
}
export class BaiduDrive {
  constructor(token, appDirectory, fetcher = fetch) {
    if (!/^\/apps\/[^/\x00-\x1f\\]+$/.test(appDirectory) || appDirectory.includes("..")) throw new ProviderError("INVALID_BAIDU_APP_DIRECTORY", 400);
    this.root = `${appDirectory}/Shelf-v1`; this.token = token; this.fetch = fetcher;
  }
  async request(method, options = {}, endpoint = "file") {
    const url = new URL(`https://pan.baidu.com/rest/2.0/xpan/${endpoint}`);
    url.search = new URLSearchParams({ method, access_token: await this.token(), ...(options.query ?? {}) }).toString();
    return json(await this.fetch(url, { method: options.body ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(120000), ...(options.body ? { headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(options.body) } : {}) }));
  }
  async ensureFolder() {
    try { await this.request("create", { body: { path: this.root, isdir: "1", size: "0", rtype: "0" } }); }
    catch (error) { if (error.message !== "DRIVE_API_-8") throw error; }
  }
  async list() {
    const files = [], seen = new Set();
    for (let start = 0; ; start += 1000) {
      let response;
      try { response = await this.request("list", { query: { dir: this.root, start: String(start), limit: "1000", order: "name" } }); }
      catch (error) { if (error.message === "DRIVE_API_-9" && start === 0) return []; throw error; }
      if (!Array.isArray(response.list)) throw new ProviderError("INVALID_BAIDU_LIST");
      for (const file of response.list) {
        if (file.isdir || !keyPattern.test(file.server_filename)) continue;
        if (file.path !== `${this.root}/${file.server_filename}` || seen.has(file.server_filename)) throw new ProviderError("INVALID_BAIDU_LIST");
        seen.add(file.server_filename); files.push({ key: file.server_filename, id: file.fs_id, size: file.size });
      }
      if (response.list.length < 1000) return files;
      if (start >= 100000) throw new ProviderError("INVALID_BAIDU_PAGINATION");
    }
  }
  async get(key) {
    safeKey(key); const file = (await this.list()).find(file => file.key === key); if (!file) return null;
    const meta = await this.request("filemetas", { query: { fsids: JSON.stringify([file.id]), dlink: "1" } }, "multimedia");
    if (!meta.list?.[0]?.dlink || meta.list[0].fs_id !== file.id) throw new ProviderError("INVALID_BAIDU_DOWNLOAD");
    let url = allowedDownload(meta.list[0].dlink); url.searchParams.set("access_token", await this.token());
    for (let count = 0; count < 5; count++) {
      const response = await this.fetch(url, { redirect: "manual", signal: AbortSignal.timeout(120000), headers: { "user-agent": "pan.baidu.com Shelf" } });
      if ([301, 302, 303, 307, 308].includes(response.status)) { url = allowedDownload(new URL(response.headers.get("location"), url)); continue; }
      if (!response.ok) await json(response);
      return Buffer.from(await response.arrayBuffer());
    }
    throw new ProviderError("TOO_MANY_DOWNLOAD_REDIRECTS");
  }
  async put(key, bytes) {
    safeKey(key); await this.ensureFolder(); const path = `${this.root}/${key}`, chunks = [];
    for (let offset = 0; offset < bytes.length; offset += 4 * 1024 * 1024) chunks.push(bytes.subarray(offset, offset + 4 * 1024 * 1024));
    if (!chunks.length) chunks.push(Buffer.alloc(0));
    const hashes = chunks.map(bytes => digest("md5", bytes));
    const common = { path, size: String(bytes.length), isdir: "0", rtype: "2", block_list: JSON.stringify(hashes) };
    const pre = await this.request("precreate", { body: { ...common, autoinit: "1" } });
    if (pre.return_type === 2) return; // Provider verified the complete block list (instant transfer).
    if (!pre.uploadid || !Array.isArray(pre.block_list)) throw new ProviderError("INVALID_BAIDU_UPLOAD");
    const sequence = new Set(pre.block_list);
    if (sequence.size !== pre.block_list.length || [...sequence].some(index => !Number.isInteger(index) || index < 0 || index >= chunks.length)) throw new ProviderError("INVALID_BAIDU_PARTS");
    for (const index of sequence) {
      const url = new URL("https://d.pcs.baidu.com/rest/2.0/pcs/superfile2");
      url.search = new URLSearchParams({ method: "upload", type: "tmpfile", access_token: await this.token(), path, uploadid: pre.uploadid, partseq: String(index) }).toString();
      const form = new FormData(); form.set("file", new Blob([chunks[index]]), "encrypted.bin");
      const part = await json(await this.fetch(url, { method: "POST", body: form, redirect: "error", signal: AbortSignal.timeout(120000) }));
      if (part.md5 !== hashes[index]) throw new ProviderError("UPLOAD_PART_HASH_MISMATCH");
    }
    await this.request("create", { body: { ...common, uploadid: pre.uploadid } });
  }
  async delete(key) {
    safeKey(key); if (!(await this.list()).some(file => file.key === key)) return;
    const response = await this.request("filemanager", { query: { opera: "delete" }, body: { async: "0", filelist: JSON.stringify([`${this.root}/${key}`]) } });
    if (response.info?.some(item => item.errno)) throw new ProviderError("DELETE_NOT_CONFIRMED");
  }
}
export const objectHash = bytes => digest("sha256", bytes);
export function opaqueSession() { return randomBytes(32).toString("base64url"); }
