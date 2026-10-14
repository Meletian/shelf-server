import {createCipheriv,createHash,randomBytes} from 'node:crypto';
import {encryptDriveFile} from '../src/driveCrypto.ts';

const hash=value=>createHash('sha256').update(value).digest('hex');
export const GUIDE_PASSWORD='shelf-demo';
// Public demo material, never used for user content. Prederivation avoids a
// 600,000-iteration password task in the Worker for every new account.
const DEMO_SALT=Buffer.from('5368656c662064656d6f2073616c7421','hex');
const DEMO_KEY=Buffer.from('802aca2d34b93ef3f24c117bb916114cb49e2a14355c6d89a473c8ceeaac5974','hex');
function identifier(scope,label){const bytes=Buffer.from(hash(scope+'\0shelf-guide-v1\0'+label).slice(0,32),'hex');bytes[6]=(bytes[6]&15)|80;bytes[8]=(bytes[8]&63)|128;const h=bytes.toString('hex');return`${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;}
function secureDemo(scope,text){const meta=Buffer.from(JSON.stringify({version:1,text,files:[]})),plain=Buffer.alloc(4+meta.length);plain.writeUInt32BE(meta.length);meta.copy(plain,4);const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',DEMO_KEY,iv);cipher.setAAD(Buffer.from('SHELFENC01\0'+scope));const ciphertext=Buffer.concat([cipher.update(plain),cipher.final(),cipher.getAuthTag()]);plain.fill(0);return Buffer.concat([Buffer.from('SHELFENC01'),DEMO_SALT,iv,ciphertext]);}

export async function prepareWelcome(scope,key,at,language='zh'){
 const zh=language.startsWith('zh'),w=(cn,en)=>zh?cn:en,objects=[];
 const add=async(label,name,bytes,order)=>{const id=identifier(scope,label),result=await encryptDriveFile(new Blob([bytes]),{id,name:typeof name==='function'?name(id):name,addedAt:new Date(at-order*1000).toISOString(),sourceDevice:'Shelf guide'},key,scope);objects.push({wire:result.wire,data:Buffer.from(await result.body.arrayBuffer()).toString('base64')});return id;};
 const note=async(label,text,attachments,order)=>{const rootId=identifier(scope,label),revisionId=rootId,device=identifier(scope,'device');const snapshot={schemaVersion:1,accountScope:scope,rootId,revisionId,version:{[device]:1},text,attachmentIds:attachments,deleted:false};await add(label,id=>`__shelf_entry_v1__${id}.json`,Buffer.from(JSON.stringify(snapshot)),order);return rootId;};
 await note('welcome',w('欢迎来到 Shelf\n这是可以编辑、复制和删除的示例卡片。添加文字，或拖入文件，就能开始。\n下面有加密、纯文件、文字加附件和颜色示例。加密示例密码：shelf-demo（仅供演示，请勿用于私人资料）。','Welcome to Shelf\nThese are real cards: edit, copy or delete them. Add text or drop a file to begin.\nTry the encrypted, file, attachment and color examples. Demo password: shelf-demo (public example only; never use it for private content).'),[],0);
 await add('secure',id=>`__shelf_secure_v1__${id}.shelf`,secureDemo(scope,w('已解锁演示卡片\n这是公开的加密示例。给自己的卡片加密时，请设置独立密码；密码丢失无法找回。发送解锁副本前，Shelf 会让你确认。','Example unlocked\nThis is a public encrypted example. Use your own password for private cards; a lost password cannot be recovered. Shelf asks for confirmation before sending an unlocked copy.')),1);
 await add('image',w('示例图片.svg','Example image.svg'),Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="720" height="480" viewBox="0 0 720 480"><rect width="720" height="480" rx="28" fill="#eaf3ed"/><rect x="100" y="95" width="520" height="290" rx="24" fill="white" stroke="#86b297" stroke-width="3"/><text x="360" y="230" text-anchor="middle" font-family="sans-serif" font-size="60" fill="#2e6858">Shelf</text><text x="360" y="286" text-anchor="middle" font-family="sans-serif" font-size="22" fill="#65746b">A little room for your files.</text></svg>'),2);
 const text=await add('attachment-text',w('示例说明.txt','Example notes.txt'),Buffer.from(w('你打开了一个真实的示例附件。可以预览、下载、复制或拖到其他应用；这张卡片有两份附件。','This is a real example attachment. Preview, download, copy or drag it into another app. This card has two attachments.')),3);
 const image=await add('attachment-image',w('示例小图.png','Example thumbnail.png'),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aPzYAAAAASUVORK5CYII=','base64'),3);
 await note('attachments',w('文字和附件放在一起\n点文件图标展开两份附件，也可分别预览。桌面拖动任一底部图标，会带上全部附件；文件详情中可取出单个文件。','Text and attachments together\nExpand the file icons to preview both attachments. Drag either footer icon on desktop to take all attachments, or take one file from its detail row.'),[text,image],3);
 const target=await note('color',w('用颜色整理卡片\n点调色图标，试着换一种颜色。星标可以置顶；这张绿色卡片也可以随时删除。','Organize with color\nTry the color button to change this card. Pin important cards, or delete this green example whenever you like.'),[],4),operation=identifier(scope,'color-operation');
 await add('color-operation',`__shelf_color_v1__${operation}.json`,Buffer.from(JSON.stringify({schemaVersion:1,accountScope:scope,operationId:operation,targetId:target,clock:at,color:'green'})),4);
 return objects;
}

/** Each completed object is immutable from this job's perspective: no overwrite
 * on retries, and a deleted example never reappears. Account-level completion
 * survives device changes; the plan is persisted before writing any bytes. */
export async function seedWelcome({storage,guide,scope,key,persist,write,locked,isDeleted}){
 if(!guide.plan){guide.plan=await prepareWelcome(scope,key,guide.createdAt,guide.language);guide.finished=[];await persist();}
 for(const object of guide.plan){const id=object.wire.id;if(guide.finished.includes(id))continue;
  await locked(id,async()=>{
   if(isDeleted(id)||await storage.get(id+'.delete')||await storage.get(id+'.meta')){guide.finished.push(id);await persist();return;}
   const data=Buffer.from(object.data,'base64'),existing=await storage.get(id+'.data');
   if(existing&&hash(existing)!==object.wire.sha256){guide.finished.push(id);await persist();return;}
   if(!existing)await write(storage,id+'.data',data,'GUIDE_WRITE_NOT_CONFIRMED');
   await write(storage,id+'.meta',Buffer.from(JSON.stringify(object.wire)),'GUIDE_WRITE_NOT_CONFIRMED');
   guide.finished.push(id);await persist();
  });
 }
 guide.state='done';delete guide.plan;delete guide.retryAfter;await persist();
}
