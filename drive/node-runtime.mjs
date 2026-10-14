import {createServer} from 'node:http';
import {Readable,pipeline} from 'node:stream';
import {mkdir,readFile,realpath,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {packageServer} from '../scripts/package-server.mjs';
import {resolve,sep,extname} from 'node:path';
import {isIP} from 'node:net';
import {DatabaseSync} from 'node:sqlite';
import {WebSocketServer} from 'ws';
import {createDriveService} from './service.mjs';
import {nodeConfig} from './node-config.mjs';
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css','.mjs':'text/javascript; charset=utf-8','.json':'application/json','.webmanifest':'application/manifest+json','.png':'image/png','.svg':'image/svg+xml','.woff2':'font/woff2','.wasm':'application/wasm','.zip':'application/zip'};
export async function startNodeRuntime(input,dependencies={}){
 const config=nodeConfig(input),base=new URL(config.origin);await mkdir(config.dataDirectory,{recursive:true,mode:0o700});
 const lock=new DatabaseSync(resolve(config.dataDirectory,'.runtime-lock.sqlite'));
 try{lock.exec('BEGIN EXCLUSIVE');}catch{lock.close();throw Error('DATA_DIRECTORY_IN_USE');}
 let exportDirectory;
 try{exportDirectory=await mkdtemp(resolve(tmpdir(),'shelf-export-'));await packageServer({root:config.packageRoot??fileURLToPath(new URL('..',import.meta.url)),output:resolve(exportDirectory,'shelf-server-source.zip')});}catch(error){lock.close();if(exportDirectory)await rm(exportDirectory,{recursive:true,force:true});throw error;}
 const sockets=new Map(),pending=new Set(),activeRequests=new Set();let stopped=false,maintenanceRunning=false,timer,closing;
 const now=dependencies.now??Date.now;
 const waitUntil=job=>{const work=Promise.resolve(job).catch(()=>{});pending.add(work);work.finally(()=>pending.delete(work));dependencies.waitUntil?.(work);};
 const wsServer=new WebSocketServer({noServer:true,maxPayload:1024});
 const service=createDriveService(config,{...dependencies,waitUntil,emitShares:(account,value)=>{for(const [socket,session]of sockets)if(session.accountId===account){if(session.expiresAt<=now())socket.close(1008,'Session expired');else if(socket.readyState===1)socket.send(JSON.stringify(value));}dependencies.emitShares?.(account,value);},closeSession:hash=>{for(const [socket,session]of sockets)if(session.sessionHash===hash)socket.close(1008,'Session closed');dependencies.closeSession?.(hash);}});
 const validRequest=req=>req.headers.host===base.host&&req.url?.startsWith('/')&&!req.url.startsWith('//');
 const track=()=>{let finish;const work=new Promise(r=>finish=r);activeRequests.add(work);return ()=>{activeRequests.delete(work);finish();};};
 const server=createServer(async(incoming,outgoing)=>{
  const finish=track();
  const abort=new AbortController();incoming.once('aborted',()=>abort.abort());outgoing.once('close',()=>{if(!outgoing.writableFinished)abort.abort();});
  try{
   if(stopped||!validRequest(incoming)){outgoing.writeHead(400);outgoing.end();return;}
   const url=new URL(incoming.url,base);let response;
   if(['GET','HEAD'].includes(incoming.method)&&config.webDirectory&&url.pathname==='/')response=new Response(null,{status:302,headers:{location:'/app/'+url.search,'cache-control':'no-store'}});
   else if(incoming.method==='GET'&&url.pathname==='/shelf-server-source.zip')response=new Response(await readFile(resolve(exportDirectory,'shelf-server-source.zip')),{headers:{'content-type':'application/zip','content-disposition':'attachment; filename=Shelf-server-source.zip','cache-control':'no-cache'}});
   else if(incoming.method==='GET'&&url.pathname==='/healthz')response=Response.json({ok:true,service:'shelf-drive-v1'});
   else if(['GET','HEAD'].includes(incoming.method)&&config.webDirectory&&(url.pathname==='/app'||url.pathname.startsWith('/app/'))){
    let path=decodeURIComponent(url.pathname.slice(5));if(!path||!extname(path))path='index.html';
    const root=await realpath(config.webDirectory),file=await realpath(resolve(root,path));if(!file.startsWith(root+sep))throw Error('INVALID_STATIC_PATH');
    response=new Response(incoming.method==='HEAD'?null:await readFile(file),{headers:{'content-type':mime[extname(file)]??'application/octet-stream','cache-control':extname(file)==='.html'||path==='sw.js'?'no-cache':'public, max-age=3600','x-content-type-options':'nosniff'}});
   }else{
    const remote=incoming.socket.remoteAddress;let source=remote;
    if(config.trustedProxies.includes(remote)){const forwarded=String(incoming.headers['x-forwarded-for']??'').split(',').at(-1)?.trim();if(isIP(forwarded??''))source=forwarded;}
    const request=new Request(url,{method:incoming.method,headers:incoming.headers,signal:abort.signal,...(!['GET','HEAD'].includes(incoming.method)?{body:Readable.toWeb(incoming),duplex:'half'}:{})});
    response=await service.fetch(request,{source});
   }
   if(abort.signal.aborted)return;outgoing.writeHead(response.status,Object.fromEntries(response.headers));
   if(response.body)pipeline(Readable.fromWeb(response.body),outgoing,()=>{});else outgoing.end();
  }catch(error){if(abort.signal.aborted)return;if(!outgoing.headersSent)outgoing.writeHead(error.code==='ENOENT'?404:500,{'content-type':'application/json','cache-control':'no-store'});outgoing.end('{"error":"DRIVE_OPERATION_FAILED"}');}finally{finish();}
 });
 server.on('upgrade',async(req,socket,head)=>{
  const finish=track();socket.on('error',()=>{});
  try{
   const url=new URL(req.url,base);if(stopped||!validRequest(req)||url.pathname!=='/v1/share-events')throw Error('INVALID_EVENT_PATH');
   const session=await service.consumeEventTicket(url.searchParams.get('ticket'),req.headers.origin);
   if(stopped||sockets.size>=512||[...sockets.values()].filter(s=>s.accountId===session.accountId).length>=4)throw Error('TOO_MANY_CONNECTIONS');
   wsServer.handleUpgrade(req,socket,head,ws=>{sockets.set(ws,session);ws.on('close',()=>sockets.delete(ws));ws.on('error',()=>ws.terminate());ws.on('message',()=>ws.close(1008,'Server notifications only'));ws.send(JSON.stringify({type:'shares-changed',revision:0}));});
  }catch{socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');}finally{finish();}
 });
 server.requestTimeout=5*60000;server.headersTimeout=30000;
 async function maintain(){if(stopped||maintenanceRunning)return;maintenanceRunning=true;try{for(const [socket,s]of sockets)if(s.expiresAt<=now())socket.close(1008,'Session expired');await service.maintenance();dependencies.onMaintenance?.();}catch{ /* Durable cleanup is retried. No credentials or request payloads are logged. */ }finally{maintenanceRunning=false;}}
 function close(){return closing??=stop();}
 async function stop(){if(stopped)return;stopped=true;clearInterval(timer);for(const socket of sockets.keys())socket.terminate();await new Promise(r=>{wsServer.close(()=>{});server.close(r);server.closeAllConnections();});while(maintenanceRunning)await new Promise(r=>setTimeout(r,10));while(activeRequests.size)await Promise.allSettled([...activeRequests]);while(pending.size)await Promise.allSettled([...pending]);lock.close();await rm(exportDirectory,{recursive:true,force:true});}
 try{await service.ready;await new Promise((ok,fail)=>{server.once('error',fail);server.listen(config.listenPort,config.listenHost,ok);});timer=setInterval(()=>void maintain(),Math.max(10,config.maintenanceIntervalMs??60000));timer.unref();return {service,server,close};}
 catch(error){wsServer.close();server.close();lock.close();await rm(exportDirectory,{recursive:true,force:true});throw error;}
}
