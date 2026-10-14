import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {startNodeRuntime} from './node-runtime.mjs';
export const listenDriveService=startNodeRuntime;
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const config=JSON.parse(await readFile(resolve(process.argv[2]??'drive/config.local'),'utf8'));
  const active=await listenDriveService(config);
  console.log('Shelf service ready. Requests and credentials are not logged.');
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{void active.close().then(()=>{process.exitCode=0;});});
 }catch(error){console.error(error.message==='DATA_DIRECTORY_IN_USE'?'Shelf data directory is already in use.':'Shelf service could not start. Check config, key and listen address.');process.exitCode=1;}
}
