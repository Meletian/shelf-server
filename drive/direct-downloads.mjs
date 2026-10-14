import {ProviderError} from './providers.mjs';

// Only the authenticated account's own committed objects may request this.
// Google access tokens retain their existing drive.file scope. They are not
// single-file/read-only tokens; refresh tokens never cross this boundary.
export function createDirectDownloads({accounts,accessToken,now,maximum,wireValid,sessionValid=()=>true}) {
  return async function issue(request,session,storage,id) {
    const args=new URL(request.url).searchParams;
    if(args.get('shelf-direct')!=='1'||[...args.keys()].some(k=>!['shelf-direct','renew'].includes(k))||args.getAll('shelf-direct').length!==1||args.getAll('renew').length>1||args.has('renew')&&args.get('renew')!=='1')throw new ProviderError('INVALID_DIRECT_DOWNLOAD',400);
    const account=accounts.get(session.accountId);
    if(account?.provider!=='google'||typeof storage.directDownload!=='function')throw new ProviderError('DIRECT_DOWNLOAD_UNSUPPORTED',409);
    const bytes=await storage.get(id+'.meta');
    if(!bytes)throw new ProviderError('OBJECT_NOT_FOUND',404);
    let wire;try{wire=JSON.parse(bytes.toString('utf8'));}catch{throw new ProviderError('INVALID_METADATA',409);}
    if(!wireValid(wire,id,maximum))throw new ProviderError('INVALID_METADATA',409);
    const data=await storage.directDownload(id+'.data');
    if(!data)throw new ProviderError('OBJECT_NOT_FOUND',404);
    if(!/^[A-Za-z0-9_-]{1,200}$/.test(data.remoteId??'')||data.url!==`https://www.googleapis.com/drive/v3/files/${data.remoteId}?alt=media`||data.size!==wire.size)throw new ProviderError('DOWNLOAD_NOT_CONFIRMED',409);
    if(!sessionValid(session))throw new ProviderError('DRIVE_AUTH_EXPIRED',401);
    const token=await accessToken(session.accountId,args.get('renew')==='1');
    if(!sessionValid(session))throw new ProviderError('DRIVE_AUTH_EXPIRED',401);
    const current=accounts.get(session.accountId);
    if(typeof token!=='string'||!token||token.length>8192||/[\r\n\0]/.test(token)||!Number.isSafeInteger(current?.expiresAt)||current.expiresAt<=now())throw new ProviderError('DRIVE_AUTH_EXPIRED',401);
    return Response.json({protocol:'shelf-google-download-v1',id,remoteId:data.remoteId,url:data.url,token,expiresAt:current.expiresAt,size:wire.size,sha256:wire.sha256},{headers:{'cache-control':'no-store','referrer-policy':'no-referrer'}});
  };
}
