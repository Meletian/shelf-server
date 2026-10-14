import {readFile,writeFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
const origin=process.argv[2];const url=new URL(origin);if(url.protocol!=='https:'||url.pathname!=='/'||url.search||url.hash||url.username||url.password)throw Error('Use a plain HTTPS server origin.');
const config=JSON.parse(await readFile(new URL('./config.example.json',import.meta.url)));config.origin=url.origin;config.encryptionKey=randomBytes(32).toString('hex');
await writeFile(new URL('./config.local',import.meta.url),JSON.stringify(config,null,2)+'\n',{flag:'wx',mode:0o600});
await writeFile(new URL('./.env',import.meta.url),'SHELF_DOMAIN='+url.host+'\n',{flag:'wx',mode:0o600});
console.log('Private configuration created. Add your Google OAuth credentials to server/config.local.');
