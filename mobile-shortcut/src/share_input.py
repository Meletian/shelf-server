"""Normalize native text/Messages RTFD before file metadata and hashing."""
import native_actions as b

def as_text_card(file):
    plain=b.add('detect.text',WFInput=b.attachment(file))
    # A Text action forces a plain text value, rather than an RTFD file wrapper.
    plain=b.txt(plain)
    plain=b.replace(plain,'\ufffc','')
    b.fail_if_missing(plain,'没有收到可存入的文字，请选择短信文字后重新分享。')
    b.save('分享类型',b.txt('text'))
    b.save('待上传文件',b.add('setitemname',WFInput=b.attachment(plain),WFName=b.text('文字.txt'),WFDontIncludeFileExtension=False))

def normalize_shared(file):
    typ=b.add('getitemtype',WFInput=b.attachment(file))
    matches=b.add('text.match',text=b.text(typ),WFMatchTextPattern='^(?:Text|Rich Text|文本|文字|多信息文本|富文本|RTFD|com\\.apple\\.(?:flat-)?rtfd)$',WFMatchTextCaseSensitive=False,ShowWhenRun=False)
    native_text=b.condition(b.count(matches),2,0)
    as_text_card(file)
    b.otherwise(native_text)
    ext=b.add('properties.files',WFInput=b.attachment(file),WFContentItemPropertyName='File Extension')
    rtfd=b.add('text.match',text=b.text(ext),WFMatchTextPattern='^(?:rtfd|flat-rtfd)$',WFMatchTextCaseSensitive=False,ShowWhenRun=False)
    wrapped=b.condition(b.count(rtfd),2,0);as_text_card(file);b.end(wrapped)
    b.end(native_text)
