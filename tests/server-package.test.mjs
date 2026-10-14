import assert from 'node:assert/strict';
import {test} from 'node:test';
import {existsSync} from 'node:fs';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {unzipSync,strFromU8} from 'fflate';
const pack=existsSync('scripts/package-server.mjs')?await import('../scripts/package-server.mjs'):{};
test('server source export includes its runtime and uses a secret-free explicit whitelist',async()=>{
 assert.equal(typeof pack.packageServer,'function','server export missing');const temp=await mkdtemp(join(tmpdir(),'shelf-package-'));
 try{const result=await pack.packageServer({root:resolve('.'),output:join(temp,'server.zip')});const entries=unzipSync(await readFile(result.path));
 for(const file of ['package.json','package-lock.json','drive/service.mjs','drive/server.mjs','drive/node-runtime.mjs','src/driveCrypto.ts','server/README.md','server/compose.yml','server/Caddyfile','server/Dockerfile','scripts/package-server.mjs','server/deploy.sh','server/setup.mjs','LICENSE','NOTICE.md','README.md','mobile-shortcut/存入 Shelf（自配置）.shortcut','tests/server-deploy.test.mjs','tests/server-package.test.mjs','tests/drive-node-runtime.test.mjs'])assert.ok(entries[file],file);
 assert.ok(!Object.keys(entries).some(p=>/accounts\.local|config\.local|node_modules|target|\.wrangler|shelf-server-source\.zip/.test(p)));
 const config=JSON.parse(strFromU8(entries['server/config.example.json']));assert.equal(config.origin,'https://shelf.example.com');assert.equal(config.encryptionKey,'GENERATE_ON_YOUR_SERVER');assert.deepEqual(config.providers.google,{clientId:'',clientSecret:''});
 assert.match(strFromU8(entries['server/README.md']),/oauth\/callback\/google/);assert.match(result.sha256,/^[a-f0-9]{64}$/);
 }finally{await rm(temp,{recursive:true,force:true});}
});

test('Docker COPY layout contains every source export input and excludes private config',async()=>{
 const {mkdir,cp}=await import('node:fs/promises'),{basename}=await import('node:path');const dir=await mkdtemp(join(tmpdir(),'shelf-image-'));
 try{const docker=await readFile('server/Dockerfile','utf8');assert.doesNotMatch(docker,/COPY server\s+\.\/server/);
 for(const line of docker.split('\n').filter(line=>line.startsWith('COPY '))){const raw=line.slice(5).trim(),parts=raw.startsWith('[')?JSON.parse(raw):raw.split(/\s+/),destination=parts.pop();for(const source of parts){let target=join(dir,destination);const stat=(await import('node:fs/promises')).stat;const item=await stat(source);if(parts.length>1||destination.endsWith('/')||destination==='./')target=join(target,basename(source));await mkdir((await import('node:path')).dirname(target),{recursive:true});await cp(source,target,{recursive:true});}}
 await pack.packageServer({root:dir,output:join(dir,'audited.zip')});
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('unchanged reviewed sources produce identical package bytes across build hooks',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'shelf-repro-'));
 try{const one=await pack.packageServer({root:resolve('.'),output:join(dir,'one.zip')});await new Promise(r=>setTimeout(r,2100));const two=await pack.packageServer({root:resolve('.'),output:join(dir,'two.zip')});assert.equal(one.sha256,two.sha256);}finally{await rm(dir,{recursive:true,force:true});}
});
