"""Native, signed-by-Apple Shortcuts workflow. No real tokens or passwords here."""
from pathlib import Path
import json,plistlib,uuid
import native_actions as b
from share_input import normalize_shared
HERE=Path(__file__).resolve().parent;OUT=HERE.parent
CHUNK=4*1024*1024
# Save File retains the native Text output's .txt extension on macOS/iOS.
# The contents are JSON; use the filename it actually writes for cache reuse.
CACHE='Shelf-Selfhost-session-v1.txt'
CONFIG='Shelf-Selfhost-config-v1.txt'
def endpoint(*parts):return b.text(b.var('服务器地址'),*parts)

def load_origin():
    saved=b.add('documentpicker.open',WFFile=b.SHORTCUTS_FOLDER,WFGetFilePath=CONFIG,WFFileErrorIfNotFound=False,WFGetFolderContents=False)
    b.save('服务器地址',b.txt(saved));missing=b.condition(b.count(b.var('服务器地址'),'Characters'),0,1)
    b.save('服务器地址',b.add('ask',WFAskActionPrompt=b.text('请输入自己的 Shelf HTTPS 服务器地址'),WFInputType='Text',WFAllowsMultilineText=False));b.end(missing)
    b.save('服务器地址',b.replace(b.replace(b.var('服务器地址'),'^\\s+|\\s+$',''),'/+$',''))
    valid=b.add('text.match',text=b.text(b.var('服务器地址')),WFMatchTextPattern='^https://[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::[0-9]{1,5})?$',WFMatchTextCaseSensitive=True,ShowWhenRun=False)
    b.fail_if_missing(valid,'请输入完整 HTTPS 域名，不带路径、账号、查询或片段。')
    b.add('documentpicker.save',WFInput=b.attachment(b.var('服务器地址')),WFFolder=b.SHORTCUTS_FOLDER,WFAskWhereToSave=False,WFFileDestinationPath=CONFIG,WFSaveFileOverwrite=True)

def clear_token():
    b.save('登录令牌',b.add('nothing'))

def save_google_session(response):
    # This session comes from the Google login endpoint; the backend enforces
    # Google ownership. Store just the valid token, without optional JSON fields.
    b.add('documentpicker.save',WFInput=b.attachment(b.txt('{"origin":"',b.var('服务器地址'),'","token":"',b.var('登录令牌'),'"}')),WFFolder=b.SHORTCUTS_FOLDER,WFAskWhereToSave=False,WFFileDestinationPath=CACHE,WFSaveFileOverwrite=True)

def json_integer(value):
    formatted=b.add('format.number',WFNumber=b.text(value),WFNumberFormatDecimalPlaces=0)
    return b.replace(formatted,'[^0-9]','')
def rounding(value,mode):
    return b.add('round',WFInput=b.attachment(value),WFRoundTo='Ones Place',WFRoundMode=mode)
def floor(value):return rounding(value,'Always Round Down')
def ceil(value):return rounding(value,'Always Round Up')
def fresh_login():
    flow=b.request_once(endpoint('/v1/auth/google/start'),'POST',json_body={})
    flow_id=b.value(flow,'flowId');claim=b.value(flow,'claimSecret');url=b.value(flow,'authorizationUrl')
    for v in [flow_id,claim,url]:b.fail_if_missing(v,'无法开始 Google 登录，请检查网络后重试。')
    b.alert('请选择与你电脑 Shelf 相同的 Google 账号。授权成功后返回“快捷指令”，即可继续存入文件。')
    valid_url=b.add('text.match',text=b.text(url),WFMatchTextPattern='^https://accounts\\.google\\.com/o/oauth2/v2/auth\\?',WFMatchTextCaseSensitive=True,ShowWhenRun=False)
    b.fail_if_missing(valid_url,'授权页面不正确，已停止。')
    b.add('openurl',WFInput=b.attachment(url));b.add('waittoreturn')
    clear_token()
    loop=str(uuid.uuid4()).upper();b.add('repeat.count',GroupingIdentifier=loop,WFControlFlowMode=0,WFRepeatCount=60)
    pending=b.condition(b.count(b.var('登录令牌'),'Characters'),0,1)
    response=b.add('downloadurl',WFURL=endpoint('/v1/auth/',flow_id),WFHTTPMethod='GET',WFHTTPHeaders=b.fields({'x-shelf-claim':claim}),ShowHeaders=True)
    token=b.value(response,'token')
    complete=b.condition(b.count(token,'Characters'),2,0)
    valid_token=b.add('text.match',text=b.text(token),WFMatchTextPattern='^[0-9]{10}\\.[a-f0-9]{32}\\.[a-f0-9]{64}$',WFMatchTextCaseSensitive=True,ShowWhenRun=False)
    b.fail_if_missing(valid_token,'登录令牌无效，请重试。')
    returned=b.txt(b.value(response,'relayOrigin'));wrong_origin=b.condition(returned,5,b.var('服务器地址'));b.alert('登录服务器不匹配，已停止。');b.stop();b.end(wrong_origin)
    b.save('登录令牌',token)
    save_google_session(response)
    b.otherwise(complete)
    error=b.value(response,'error');failed=b.condition(b.count(error,'Characters'),2,0)
    b.alert('Google 授权未完成，请重新运行后再授权。');b.stop();b.end(failed)
    b.add('delay',WFDelayTime=1);b.end(complete)
    b.end(pending);b.add('repeat.count',GroupingIdentifier=loop,WFControlFlowMode=2)
    b.fail_if_missing(b.var('登录令牌'),'Google 登录未完成，请重新分享文件后重试。')

def request(url,method,**options):
    response=b.request_once(url,method,**options)
    if not options.get('auth'):return response
    slot='请求结果-'+str(uuid.uuid4());result=b.save(slot,response)
    expired=b.add('text.match',text=b.text(b.txt(response)),WFMatchTextPattern='"error"\\s*:\\s*"DRIVE_AUTH_EXPIRED"',WFMatchTextCaseSensitive=True,ShowWhenRun=False)
    branch=b.condition(b.count(expired),2,0);fresh_login()
    b.save(slot,b.request_once(url,method,**options));b.end(branch);return result

def load_session():
    clear_token()
    cached=b.add('documentpicker.open',WFFile=b.SHORTCUTS_FOLDER,WFGetFilePath=CACHE,WFFileErrorIfNotFound=False,WFGetFolderContents=False)
    available=b.condition(b.count(cached),2,0)
    data=b.add('getdictionaryfrominput',WFInput=b.attachment(b.txt(cached)))
    matches=b.condition(b.txt(b.value(data,'origin')),4,b.var('服务器地址'));b.save('登录令牌',b.txt(b.value(data,'token')));b.end(matches);b.end(available)
    has_token=b.condition(b.count(b.var('登录令牌'),'Characters'),2,0)
    expiry=b.add('text.match',text=b.text(b.var('登录令牌')),WFMatchTextPattern='^[0-9]{10}(?=\\.)',WFMatchTextCaseSensitive=True,ShowWhenRun=False)
    found=b.condition(b.count(expiry),2,0)
    number=b.add('getitemfromlist',WFInput=b.attachment(expiry),WFItemSpecifier='First Item')
    now=b.add('date',WFDateActionMode='Current Date');epoch=b.add('date',WFDateActionMode='Specified Date',WFDateActionDate='1970-01-01T00:00:00Z')
    seconds=b.add('gettimebetweendates',WFTimeUntilFromDate=b.text(epoch),WFInput=b.text(now),WFTimeUntilUnit='Seconds')
    old=b.condition(b.math(number,'-',120),1,seconds);clear_token();b.end(old)
    b.otherwise(found);clear_token();b.end(found);b.end(has_token)
    missing=b.condition(b.count(b.var('登录令牌'),'Characters'),0,1);fresh_login();b.end(missing)
    response=request(endpoint('/v1/files?shelf-mobile=1'),'GET',auth=True)
    protocol=b.txt(b.value(response,'protocol'));unsupported=b.condition(protocol,5,'shelf-mobile-import-v1')
    b.alert('Google Drive 手机上传入口尚未启用，或登录已失效。请先完成 Shelf 服务更新后再试。');b.stop();b.end(unsupported)
    count=b.value(response,'partBytes');b.fail_if_missing(count,'服务器未返回分片大小，已取消。')
    for op in [0,2]:
        unsupported=b.condition(count,op,CHUNK);b.alert('服务器分片协议已变化，请更新此快捷指令。');b.stop();b.end(unsupported)

def unwrap_wechat(file):
    stem=b.add('properties.files',WFInput=b.attachment(file),WFContentItemPropertyName='Name')
    ext=b.add('properties.files',WFInput=b.attachment(file),WFContentItemPropertyName='File Extension')
    filename=b.txt(stem,'.',ext)
    matched=b.add('text.match',text=b.text(filename),WFMatchTextPattern='^聊天记录(?:[_ -].*)?\\.zip$',WFMatchTextCaseSensitive=True,ShowWhenRun=False)
    archive=b.condition(b.count(matched),2,0)
    roots=b.add('unzip',WFArchive=b.attachment(file))
    b.save('微信附件',b.add('nothing'));b.save('聊天文字',b.add('nothing'));b.save('微信附件文件夹',b.add('nothing'))
    loop=str(uuid.uuid4()).upper();b.add('repeat.each',GroupingIdentifier=loop,WFControlFlowMode=0,WFInput=b.attachment(roots))
    root=b.var('Repeat Item');nm=b.add('properties.files',WFInput=b.attachment(root),WFContentItemPropertyName='Name')
    log=b.condition(nm,4,'聊天记录');b.save('聊天文字',b.txt(root));b.end(log)
    folder=b.condition(nm,4,'聊天记录内的图片、视频和文件');b.save('微信附件文件夹',root);b.end(folder)
    b.add('repeat.each',GroupingIdentifier=loop,WFControlFlowMode=2)
    has_folder=b.condition(b.count(b.var('微信附件文件夹')),2,0)
    children=b.add('file.getfoldercontents',WFFolder=b.attachment(b.var('微信附件文件夹')),Recursive=True)
    inner=str(uuid.uuid4()).upper();b.add('repeat.each',GroupingIdentifier=inner,WFControlFlowMode=0,WFInput=b.attachment(children))
    child=b.var('Repeat Item');typ=b.add('getitemtype',WFInput=b.attachment(child))
    directory=b.add('text.match',text=b.text(typ),WFMatchTextPattern='^(?:Folder|文件夹)$',WFMatchTextCaseSensitive=True,ShowWhenRun=False)
    is_file=b.condition(b.count(directory),0,1);b.add('appendvariable',WFVariableName='微信附件',WFInput=b.attachment(child));b.end(is_file)
    b.add('repeat.each',GroupingIdentifier=inner,WFControlFlowMode=2);b.end(has_folder)
    b.fail_if_missing(b.var('聊天文字'),'无法识别这份微信聊天记录，请打开原文件后再分享。')
    many=b.condition(b.count(b.var('微信附件')),2,1);b.alert('这份聊天记录包含多个附件，请打开要存的那个文件后再分享。');b.stop();b.end(many)
    single=b.condition(b.count(b.var('微信附件')),2,0)
    b.save('待上传文件',b.add('getitemfromlist',WFInput=b.attachment(b.var('微信附件')),WFItemSpecifier='First Item'))
    b.otherwise(single)
    missing_attachment=b.add('text.match',text=b.text(b.var('聊天文字')),WFMatchTextPattern='\\[(?:文件|图片|视频)\\]',WFMatchTextCaseSensitive=True,ShowWhenRun=False)
    absent=b.condition(b.count(missing_attachment),2,0);b.alert('聊天记录提到了附件，但没有收到原文件。请打开原文件后再分享。');b.stop();b.end(absent)
    b.save('分享类型',b.txt('text'))
    b.save('待上传文件',b.add('setitemname',WFInput=b.attachment(b.var('聊天文字')),WFName=b.text('文字.txt'),WFDontIncludeFileExtension=False))
    b.end(single);b.end(archive)

def build():
    b.actions.clear();b.request=request
    b.add('comment',WFCommentActionText='存入 Shelf · Google Drive：每次一个原文件；首次 Google 官方登录，后续复用令牌。不保存密码、不修改剪贴板。手机文件经 HTTPS 发给 Shelf 服务，由服务加密后写入同一 Google Drive 空间。原文件直接上传；服务端处理分片和加密。纯文字存为文字卡片。')
    shared={'Type':'ExtensionInput'};n=b.count(shared)
    empty=b.condition(n,0,1);b.alert('请在微信或“文件”中分享一个文件，再选择“存入 Shelf”。');b.stop();b.end(empty)
    many=b.condition(n,2,1);b.alert('每次只存入一个文件，请只选择一个后重新分享。');b.stop();b.end(many)
    file=b.save('待上传文件',b.add('getitemfromlist',WFInput=b.attachment(shared),WFItemSpecifier='First Item'))
    # Start the native app before hashing/uploading a large shared item.
    b.add('handoff')
    b.save('分享类型',b.txt('file'))
    normalize_shared(file)
    unwrap_wechat(file)
    stem=b.add('properties.files',WFInput=b.attachment(file),WFContentItemPropertyName='Name')
    b.fail_if_missing(stem,'无法取得原文件名，请从原文件的分享菜单重试。')
    ext=b.add('properties.files',WFInput=b.attachment(file),WFContentItemPropertyName='File Extension')
    name=b.save('原文件名',b.txt(stem));has_ext=b.condition(b.count(ext,'Characters'),2,0);b.save('原文件名',b.txt(stem,'.',ext));b.end(has_ext)
    b.fail_if_missing(name,'无法取得原文件名，请从原文件的分享菜单重试。')
    load_origin()
    load_session()
    # File Size displays a friendly unit, but its native numeric coercion is the
    # exact byte count. Counting megabytes of Base64 text invokes Apple's data
    # detectors and can stall for minutes, so do not count or coerce that text.
    file_size=b.add('properties.files',WFInput=b.attachment(file),WFContentItemPropertyName='File Size')
    size=b.save('原文件字节数',b.math(file_size,'+',0))
    digest=b.save('原文件校验',b.lower(b.add('hash',WFInput=b.attachment(file),WFHashType='SHA256')))
    rand=b.add('number.random',WFRandomNumberMinimum=0,WFRandomNumberMaximum=2147483647);now=b.add('date',WFDateActionMode='Current Date')
    hexid=b.lower(b.add('hash',WFInput=b.attachment(b.txt(now,'|',rand,'|',digest,'|',name)),WFHashType='SHA256'))
    id=b.save('文件编号',b.replace(hexid,'^(.{8})(.{4})(.{4})(.{4})(.{12}).*$','$1-$2-$3-$4-$5'))
    text_kind=b.condition(b.var('分享类型'),4,'text')
    b.save('原文件名',b.txt('__shelf_note_v1__',id,'.txt'));b.end(text_kind)
    path=b.save('文件上传地址',b.txt(b.var('服务器地址'),'/v1/files/',id,'?shelf-mobile=1'))
    started=request(b.text(path),'POST',auth=True,json_body={'id':id,'name':name,'size':(3,size),'sha256':digest,'mode':'raw-stream-v1','kind':b.var('分享类型')})
    b.fail_if_missing(b.value(started,'id'),'无法开始上传，请检查登录、文件名或云端空间。')
    response=request(b.text(path,'&part=raw'),'PUT',auth=True,file=file)
    received=b.value(response,'received');b.fail_if_missing(b.value(response,'id'),'文件上传失败，已取消此次上传。',b.text(path))
    for op in [0,2]:
        wrong=b.condition(received,op,size);request(b.text(path),'DELETE',auth=True);b.alert('文件上传不完整，请保持快捷指令在前台后重试。');b.stop();b.end(wrong)
    result=request(b.text(path,'&commit=1'),'POST',auth=True,json_body={});b.save('最终文件记录',result)
    for key,expected in [('id',id),('name',name),('sha256',digest)]:
        raw_value=b.value(result,key);b.fail_if_missing(raw_value,'上传未完成，没有收到完整的服务端文件记录。');received=b.txt(raw_value)
        wrong=b.condition(received,5,expected);b.alert('文件记录核对不一致，未能确认上传成功。');b.stop();b.end(wrong)
    returned_size=b.value(result,'size');b.fail_if_missing(returned_size,'上传未完成，没有收到文件字节数。')
    for op in [0,2]:
        wrong=b.condition(returned_size,op,size);b.alert('文件大小核对不一致，未能确认上传成功。');b.stop();b.end(wrong)
    b.save('完成名称',name);text_kind=b.condition(b.var('分享类型'),4,'text');b.save('完成名称',b.txt('文字'));b.end(text_kind)
    b.alert('已存入 Shelf：\n',b.var('完成名称'));b.stop()
    return {'WFWorkflowName':'存入 Shelf（自配置）','WFWorkflowActions':b.actions,'WFWorkflowClientVersion':'2600.0','WFWorkflowMinimumClientVersion':900,'WFWorkflowMinimumClientVersionString':'900','WFWorkflowIcon':{'WFWorkflowIconStartColor':431817727,'WFWorkflowIconGlyphNumber':61440},'WFWorkflowTypes':['ActionExtension'],'WFWorkflowImportQuestions':[],'WFWorkflowHasShortcutInputVariables':True,'WFWorkflowNoInputBehavior':{'Name':'WFWorkflowNoInputBehaviorShowError','Parameters':{'Error':'请分享一个原文件后重试。'}},'WFWorkflowInputContentItemClasses':['WFStringContentItem','WFRichTextContentItem','WFGenericFileContentItem','WFImageContentItem','WFPDFContentItem','WFAVAssetContentItem'],'WFWorkflowOutputContentItemClasses':[],'WFWorkflowHasOutputFallback':False}

if __name__=='__main__':
    result=build();name=result['WFWorkflowName'];(OUT/(name+'-unsigned.shortcut')).write_bytes(plistlib.dumps(result,fmt=plistlib.FMT_BINARY));(OUT/(name+'.plist')).write_bytes(plistlib.dumps(result));print('Native actions:',len(b.actions))
