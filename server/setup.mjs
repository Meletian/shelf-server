import {lstat,readFile,open,chmod,chown} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline';
import {Writable} from 'node:stream';

function setupError(message){return Object.assign(new Error(message),{safe:true});}
function originFor(input){
 if(typeof input!=='string')throw setupError('请输入 HTTPS 域名。');
 const raw=input.trim(),url=new URL(raw.includes('://')?raw:'https://'+raw);
 if(url.protocol!=='https:'||url.username||url.password||url.port||url.pathname!=='/'||url.search||url.hash||url.hostname.length>253||!url.hostname.includes('.')||!url.hostname.split('.').every(x=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(x)))throw setupError('请输入 HTTPS 域名，不带路径、端口或查询。');
 return url.origin;
}
function credential(value){if(typeof value!=='string'||!value.trim()||value.length>4096||/[\x00-\x1f\x7f]/.test(value))throw setupError('Google 客户端配置不完整。');return value.trim();}
async function regular(path){try{const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink())throw setupError('配置必须是普通文件，不可使用链接。');return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
async function privateFile(path,text){const file=await open(path,'wx',0o600);try{await file.writeFile(text);await file.sync();}finally{await file.close();}}
async function protect(path,owner={uid:1000,gid:1000}){await chmod(path,0o600);if(process.platform==='linux'&&process.getuid?.()===0)await chown(path,owner.uid,owner.gid);}
function validate(config){
 const origin=originFor(config.origin);
 if(config.origin!==origin||!/^[a-f0-9]{64}$/i.test(config.encryptionKey??'')||config.dataDirectory!=='/data')throw setupError('现有配置不完整，请恢复原配置；未重新生成密钥。');
 credential(config.providers?.google?.clientId);credential(config.providers?.google?.clientSecret);return origin;
}
export async function configureServer(root,ask){
 const configPath=resolve(root,'server/config.local'),envPath=resolve(root,'server/.env');
 const hasConfig=await regular(configPath),hasEnv=await regular(envPath);let config,origin;
 if(hasConfig){try{config=JSON.parse(await readFile(configPath,'utf8'));origin=validate(config);}catch{throw setupError('现有配置不完整，请恢复原配置；未重新生成密钥。');}}
 else{
  if(hasEnv)throw setupError('发现已有部署配置但缺少密钥，请恢复 config.local。');
  origin=originFor(await ask('Shelf 域名（例如 shelf.example.com）：'));
  const clientId=credential(await ask('Google Client ID：')),clientSecret=credential(await ask('Google Client Secret（输入隐藏）：',{secret:true}));
  config=JSON.parse(await readFile(resolve(root,'server/config.example.json'),'utf8'));
  Object.assign(config,{origin,encryptionKey:randomBytes(32).toString('hex')});config.providers.google={clientId,clientSecret};validate(config);
  await privateFile(configPath,JSON.stringify(config,null,2)+'\n');
 }
 const env='SHELF_DOMAIN='+new URL(origin).hostname+'\n';
 if(hasEnv){if(await readFile(envPath,'utf8')!==env)throw setupError('域名与现有配置不一致，请检查原配置；未覆盖。');}
 else await privateFile(envPath,env);
 await protect(configPath);await protect(envPath,await lstat(root));return {origin};
}
export async function checkHealth(origin,fetcher=fetch){
 origin=originFor(origin);
 for(const [path,key,value] of [['/healthz','service','shelf-drive-v1'],['/.well-known/shelf.json','protocol','shelf-drive-v1']]){
  const response=await fetcher(origin+path,{redirect:'error',signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw setupError('HTTPS 服务尚未就绪。');const data=await response.json();
  if(data[key]!==value||path==='/healthz'&&data.ok!==true)throw setupError('地址未返回正确的 Shelf 服务。');
 }
}
async function main(){
 const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),mode=process.argv[2];
 if(mode==='--origin'||mode==='--check'){
  const path=resolve(root,'server/config.local');await regular(path);const origin=validate(JSON.parse(await readFile(path,'utf8')));
  if(mode==='--origin'){process.stdout.write(origin+'\n');return;}
  for(let attempt=0;attempt<6;attempt++){try{await checkHealth(origin);return;}catch{if(attempt===5)throw setupError('HTTPS 检查失败，请确认域名解析、80/443 端口及 Caddy 状态后重试。');process.stdout.write('等待 HTTPS 就绪…\n');await new Promise(r=>setTimeout(r,5000));}}return;
 }
 if(mode)throw setupError('未知参数。');
 let muted=false;const sink=new Writable({write(chunk,encoding,done){if(!muted)process.stdout.write(chunk,encoding);done();}});
 sink.isTTY=process.stdout.isTTY;sink.columns=process.stdout.columns;
 const readline=createInterface({input:process.stdin,output:sink,terminal:!!(process.stdin.isTTY&&process.stdout.isTTY)}),lines=readline[Symbol.asyncIterator]();
 try{await configureServer(root,async(prompt,{secret=false}={})=>{process.stdout.write(prompt);muted=secret;const line=await lines.next();muted=false;if(secret||!process.stdin.isTTY)process.stdout.write('\n');if(line.done)throw setupError('配置输入未完成。');return line.value;});process.stdout.write('配置已就绪；保留固定密钥及原账号数据。\n');}
 finally{muted=false;readline.close();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{process.stderr.write((error.safe?error.message:'配置或连接检查失败。请检查域名、完整 Google 客户端配置或恢复原配置；已有密钥未重置。')+'\n');process.exitCode=1;});
