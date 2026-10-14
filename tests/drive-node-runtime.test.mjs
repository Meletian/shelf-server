import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {existsSync} from 'node:fs';
import {WebSocket} from 'ws';
const runtime=existsSync('drive/node-runtime.mjs')?await import('../drive/node-runtime.mjs'):{};
const origin='http://127.0.0.1:18792';
function dependencies(){let subject='alice';const files=new Map();return {subject:v=>subject=v,fetch:async(url)=>new URL(url).pathname.includes('token')?Response.json({access_token:'fake',refresh_token:'fake-refresh',expires_in:3600,scope:'openid email profile https://www.googleapis.com/auth/drive.file'}):Response.json({sub:subject,email:subject+'@example.test',email_verified:true}),provider:()=>({list:async()=>[...files].map(([key,b])=>({key,size:b.length})),get:async key=>files.get(key)??null,put:async(key,b)=>files.set(key,Buffer.from(b))})};}
async function login(){const f=await(await fetch(origin+'/v1/auth/google/start',{method:'POST'})).json();await fetch(origin+'/oauth/callback/google?state='+f.flowId+'&code=fake');return (await fetch(origin+'/v1/auth/'+f.flowId,{headers:{'x-shelf-claim':f.claimSecret}})).json();}
const call=(path,token,method='GET')=>fetch(origin+path,{method,headers:{authorization:'Bearer '+token}});
function config(dir){return {origin,listenPort:18792,dataDirectory:dir,encryptionKey:'a'.repeat(64),streaming:true,directUploads:true,mobileImports:true,allowedOrigins:[origin],providers:{google:{clientId:'fixture',clientSecret:'fixture-secret'}},maintenanceIntervalMs:25};}
const socket=(ticket,source=origin)=>new Promise((resolve,reject)=>{const ws=new WebSocket(origin.replace('http','ws')+'/v1/share-events?ticket='+ticket,{origin:source});ws.once('open',()=>resolve(ws));ws.once('error',reject);});
test('Node runtime persists account keys, refuses a second writer and wrong keys without changing state',async()=>{
 assert.equal(typeof runtime.startNodeRuntime,'function','independent Node runtime missing');const dir=await mkdtemp(join(tmpdir(),'shelf-runtime-'));let active;const deps=dependencies();
 try{await assert.rejects(runtime.startNodeRuntime({...config(dir),encryptionKey:'bad'},deps),/INVALID_ENCRYPTION_KEY/);active=await runtime.startNodeRuntime(config(dir),deps);const session=await login(),key=await(await call('/v1/account-key',session.token,'POST')).json();assert.ok(key.key,JSON.stringify(key));
 await assert.rejects(runtime.startNodeRuntime(config(dir),deps),/DIRECTORY_IN_USE/);await active.close();active=null;
 const before=await readFile(join(dir,'accounts.local'));await assert.rejects(runtime.startNodeRuntime({...config(dir),encryptionKey:'b'.repeat(64)},deps));assert.deepEqual(await readFile(join(dir,'accounts.local')),before);
 active=await runtime.startNodeRuntime(config(dir),deps);assert.deepEqual(await(await call('/v1/account-key',session.token)).json(),key);
 const cap=await(await fetch(origin+'/.well-known/shelf.json')).json();assert.equal(cap.downloadMode,'google-direct-v1');assert.equal((await(await call('/v1/files?shelf-mobile=1',session.token)).json()).rawUpload,true);
 }finally{await active?.close();await rm(dir,{recursive:true,force:true});}
});
test('Node WebSocket uses allowed origins, one-time tickets, expires and closes on signout; shutdown releases resources',async()=>{
 assert.equal(typeof runtime.startNodeRuntime,'function','independent Node runtime missing');const dir=await mkdtemp(join(tmpdir(),'shelf-events-'));let active,ws;let now=Date.now(),maintenance=0;const deps={...dependencies(),now:()=>now,onMaintenance:()=>maintenance++};
 try{active=await runtime.startNodeRuntime(config(dir),deps);const session=await login();
 const ticket=async()=> (await(await call('/v1/shares/events-ticket',session.token,'POST')).json()).ticket;
 const one=await ticket();await assert.rejects(socket(one,'https://other.example'));ws=await socket(one);await assert.rejects(socket(one));
 const expired=await ticket();now+=30001;await assert.rejects(socket(expired));
 const closed=new Promise(r=>ws.once('close',r));await call('/v1/logout',session.token,'POST');await closed;
 await new Promise(r=>setTimeout(r,65));assert.ok(maintenance>0);await active.close();active=null;const count=maintenance;await new Promise(r=>setTimeout(r,60));assert.equal(maintenance,count);
 active=await runtime.startNodeRuntime(config(dir),deps);
 }finally{ws?.terminate();await active?.close();await rm(dir,{recursive:true,force:true});}
});

test('Google browser callback follows the selfhost root back to the PWA with the return marker',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'shelf-return-'));let active;
 try{active=await runtime.startNodeRuntime({...config(dir),webDirectory:'web-dist'},dependencies());
 const start=await(await fetch(origin+'/v1/auth/google/start',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({returnTo:origin})})).json();
 const response=await fetch(origin+'/oauth/callback/google?state='+start.flowId+'&code=fake');assert.equal(response.status,200);assert.equal(new URL(response.url).pathname,'/app/');assert.equal(new URL(response.url).searchParams.get('shelf-auth-return'),'1');assert.match(await response.text(),/id="root"/);
 }finally{await active?.close();await rm(dir,{recursive:true,force:true});}
});

test('shutdown retains its directory lock until an interrupted provider request has finished',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'shelf-drain-'));let active,finish,entered;const waiting=new Promise(r=>entered=r),deps=dependencies(),normal=deps.fetch;
 deps.fetch=async(url,...args)=>{if(String(url).includes('token')){entered();await new Promise(r=>finish=r);}return normal(url,...args);};
 try{active=await runtime.startNodeRuntime(config(dir),deps);const start=await(await fetch(origin+'/v1/auth/google/start',{method:'POST'})).json();const response=fetch(origin+'/oauth/callback/google?state='+start.flowId+'&code=fake').catch(()=>null);await waiting;
 let closed=false;const closing=active.close().then(()=>closed=true);await new Promise(r=>setTimeout(r,20));assert.equal(closed,false,'lock must remain held during provider work');await assert.rejects(runtime.startNodeRuntime(config(dir),deps),/DIRECTORY_IN_USE/);
 finish();await response;await closing;active=null;active=await runtime.startNodeRuntime(config(dir),dependencies());
 }finally{finish?.();await active?.close();await rm(dir,{recursive:true,force:true});}
});

test('Node adapter retains explicit legacy capability flags and the existing origin-port convention',async()=>{
 const {nodeConfig}=await import('../drive/node-config.mjs');const actual=nodeConfig({...config('/tmp/fixture'),listenPort:undefined,streaming:false,directUploads:false,mobileImports:false});assert.equal(actual.listenPort,18792);assert.equal(actual.directUploads,false);assert.equal(actual.streaming,false);assert.equal(actual.mobileImports,false);
});
