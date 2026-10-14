import assert from 'node:assert/strict';
import {test} from 'node:test';
import {existsSync} from 'node:fs';
import {mkdtemp,readFile,writeFile,copyFile,mkdir,rm,stat,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
const setup=existsSync('server/setup.mjs')?await import('../server/setup.mjs'):{};
const secret="fake-secret'$()literal",answers=['shelf.example.com','fixture.apps.googleusercontent.com',secret];
async function sandbox(){const root=await mkdtemp(join(tmpdir(),'shelf-deploy-'));await mkdir(join(root,'server'));await copyFile('server/config.example.json',join(root,'server/config.example.json'));return root;}
test('first-run wizard writes private credentials and a fixed key; retry preserves configuration byte-for-byte',async()=>{
 assert.equal(typeof setup.configureServer,'function','one-command setup missing');const root=await sandbox();let offset=0;
 try{const result=await setup.configureServer(root,async()=>answers[offset++]);const path=join(root,'server/config.local'),before=await readFile(path),config=JSON.parse(before);
 assert.equal(result.origin,'https://shelf.example.com');assert.equal(config.providers.google.clientSecret,secret);assert.match(config.encryptionKey,/^[a-f0-9]{64}$/);assert.equal((await stat(path)).mode&0o777,0o600);assert.equal(await readFile(join(root,'server/.env'),'utf8'),'SHELF_DOMAIN=shelf.example.com\n');
 await setup.configureServer(root,async()=>assert.fail('configured installation must not request new credentials'));assert.deepEqual(await readFile(path),before);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('invalid domain, partial state and symlink configuration fail without replacing existing data',async()=>{
 assert.equal(typeof setup.configureServer,'function');const root=await sandbox();
 try{await assert.rejects(setup.configureServer(root,async()=> 'https://evil.example/path'));assert.equal(existsSync(join(root,'server/config.local')),false);
 await writeFile(join(root,'server/config.local'),'{"encryptionKey":"old-keep"}');const before=await readFile(join(root,'server/config.local'));await assert.rejects(setup.configureServer(root,async()=>assert.fail('must not reset damaged config')));assert.deepEqual(await readFile(join(root,'server/config.local')),before);
 await rm(join(root,'server/config.local'));await writeFile(join(root,'untouched'),before);await symlink(join(root,'untouched'),join(root,'server/config.local'));await assert.rejects(setup.configureServer(root,async()=>assert.fail('linked config rejected')));assert.deepEqual(await readFile(join(root,'untouched')),before);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('health completion requires both the reachable service and the Shelf protocol',async()=>{
 assert.equal(typeof setup.checkHealth,'function');await setup.checkHealth('https://shelf.example.com',async url=>String(url).endsWith('/healthz')?Response.json({ok:true,service:'shelf-drive-v1'}):Response.json({protocol:'shelf-drive-v1'}));
 await assert.rejects(setup.checkHealth('https://shelf.example.com',async()=>Response.json({ok:true,protocol:'other'})));await assert.rejects(setup.checkHealth('https://shelf.example.com',async()=>Response.json({error:'offline'},{status:503})));
});
async function run(command,args,options){const child=spawn(command,args,options);let output='';for(const stream of [child.stdout,child.stderr])stream.on('data',data=>output+=data);child.stdin.end(answers.join('\n')+'\n');const code=await new Promise(r=>child.on('exit',r));return {code,output};}
test('deployment command handles prompts, preserves retries, and never claims ready on a failed build',async()=>{
 assert.ok(existsSync('server/deploy.sh'),'one-command shell entry missing');const root=await sandbox();
 try{await copyFile('server/deploy.sh',join(root,'server/deploy.sh'));await copyFile('server/setup.mjs',join(root,'server/setup.mjs'));await mkdir(join(root,'bin'));await writeFile(join(root,'bin/uname'),'#!/bin/sh\necho Linux\n',{mode:0o755});
 const docker=`#!${process.execPath}\nimport {spawnSync} from 'node:child_process';\nconst a=process.argv.slice(2);if(a[0]==='run'){const index=a.indexOf('node');if(a.includes('--check')){process.exit(process.env.TEST_FAIL_HEALTH==='1'?1:0);}const r=spawnSync(process.execPath,a.slice(index+1),{cwd:process.cwd(),stdio:'inherit'});process.exit(r.status??1);}if(a.includes('up')&&process.env.TEST_FAIL_BUILD==='1')process.exit(1);process.exit(0);\n`;
 await writeFile(join(root,'bin/docker'),docker,{mode:0o755});await writeFile(join(root,'bin/package.json'),'{"type":"module"}');
 const options={cwd:root,env:{...process.env,PATH:join(root,'bin')+':'+process.env.PATH},stdio:['pipe','pipe','pipe']};
 const first=await run('bash',['server/deploy.sh'],options);assert.equal(first.code,0,first.output);assert.match(first.output,/https:\/\/shelf.example.com\/app\//);assert.ok(!first.output.includes(secret));const before=await readFile(join(root,'server/config.local'));
 const again=await run('bash',['server/deploy.sh'],options);assert.equal(again.code,0,again.output);assert.deepEqual(await readFile(join(root,'server/config.local')),before);
 const failed=await run('bash',['server/deploy.sh'],{...options,env:{...options.env,TEST_FAIL_BUILD:'1'}});assert.notEqual(failed.code,0);assert.doesNotMatch(failed.output,/部署完成/);assert.deepEqual(await readFile(join(root,'server/config.local')),before);
 const noHTTPS=await run('bash',['server/deploy.sh'],{...options,env:{...options.env,TEST_FAIL_HEALTH:'1'}});assert.notEqual(noHTTPS.code,0);assert.doesNotMatch(noHTTPS.output,/部署完成/);
 }finally{await rm(root,{recursive:true,force:true});}
});
