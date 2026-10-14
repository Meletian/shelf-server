"""Build an unsigned native iOS Shortcut; never uses production credentials."""
from pathlib import Path
import json
import plistlib
import uuid

HERE = Path(__file__).resolve().parent
OUT = HERE.parent
CACHE_PATH = "Shelf-shelf-session-v1.txt"
# Native macOS 26 WFFilePickerParameter default: resolves the Shortcuts folder on iOS too.
SHORTCUTS_FOLDER = {"fileLocation": {"relativeSubpath": "", "WFFileLocationType": "Shortcuts"},
                    "filename": "Documents", "displayName": "快捷指令"}

LIMIT = 8 * 1024 * 1024
B64_CHUNK = 8 * 1024 * 1024  # 6 MiB bytes; non-final R2 parts must exceed 5 MiB.
actions = []


def ref(action_id, name="Result"):
    return {"Type": "ActionOutput", "OutputUUID": action_id, "OutputName": name}


def var(name):
    return {"Type": "Variable", "VariableName": name}


def attachment(value):
    return {"WFSerializationType": "WFTextTokenAttachment", "Value": value}


def text(*parts):
    value, attachments = "", {}
    for part in parts:
        if isinstance(part, dict):
            offset = len(value.encode("utf-16-le")) // 2
            attachments[f"{{{offset}, 1}}"] = part
            value += "\ufffc"
        else:
            value += str(part)
    result = {"string": value}
    if attachments:
        result["attachmentsByRange"] = attachments
    return {"WFSerializationType": "WFTextTokenString", "Value": result}


def fields(mapping):
    items = []
    for key, value in mapping.items():
        typ = 0
        if isinstance(value, tuple):
            typ, value = value
        items.append({"WFItemType": typ, "WFKey": text(key), "WFValue": text(value)})
    return {"WFSerializationType": "WFDictionaryFieldValue",
            "Value": {"WFDictionaryFieldValueItems": items}}


def add(kind, **params):
    ident = str(uuid.uuid4()).upper()
    params["UUID"] = ident
    actions.append({"WFWorkflowActionIdentifier": "is.workflow.actions." + kind,
                    "WFWorkflowActionParameters": params})
    return ref(ident)


def save(name, value):
    add("setvariable", WFVariableName=name, WFInput=attachment(value))
    return var(name)


def txt(*parts):
    return add("gettext", WFTextActionText=text(*parts))


def count(value, mode="Items"):
    token = attachment(value)
    return add("count", WFCountType=mode, Input=token)


def value(source, key):
    return add("getvalueforkey", WFInput=attachment(source),
               WFDictionaryKey=text(key), WFGetDictionaryValueType="Value")


def condition(source, code, right=None):
    # Dictionary outputs are typed generically by Apple. Explicitly make a number
    # before numeric comparisons, otherwise If asks for its text comparison value.
    if code in (0, 1, 2, 3):
        source = math(source, "+", 0)
    group = str(uuid.uuid4()).upper()
    params = {"GroupingIdentifier": group, "WFControlFlowMode": 0,
              "WFCondition": code,
              "WFInput": {"Type": "Variable", "Variable": attachment(source)}}
    if right is not None:
        params["WFNumberValue" if code in (0, 1, 2, 3) else
               "WFConditionalActionString"] = text(right) if isinstance(right, dict) or code in (4, 5) else right
    add("conditional", **params)
    return group


def otherwise(group):
    add("conditional", GroupingIdentifier=group, WFControlFlowMode=1)


def end(group):
    return add("conditional", GroupingIdentifier=group, WFControlFlowMode=2)


def alert(*message, title="Shelf"):
    add("alert", WFAlertActionTitle=text(title), WFAlertActionMessage=text(*message),
        WFAlertActionCancelButtonShown=False)


def stop():
    add("exit")


def fail_if_missing(source, message, abort_url=None):
    group = condition(count(source, "Characters"), 0, 1)
    if abort_url:
        request(abort_url, "DELETE", auth=True)
    alert(message)
    stop()
    end(group)


def request_once(url, method, *, auth=False, metadata=False, json_body=None, file=None):
    headers = {}
    if auth:
        headers["Authorization"] = txt("Bearer ", var("登录令牌"))
    if metadata:
        headers.update({"x-shelf-name": var("编码文件名"), "x-shelf-device": "iPhone"})
    if json_body is not None:
        headers["Content-Type"] = "application/json"
    if file is not None:
        headers["Content-Type"] = "application/json" if metadata and method == "POST" else "application/octet-stream"
    params = {"WFURL": url, "WFHTTPMethod": method, "WFHTTPHeaders": fields(headers), "ShowHeaders": True}
    if json_body is not None:
        params.update(WFHTTPBodyType="JSON", WFJSONValues=fields(json_body))
    elif file is not None:
        params.update(WFHTTPBodyType="File", WFRequestVariable=attachment(file))
    return add("downloadurl", **params)



def replace(source, pattern, replacement):
    return add("text.replace", WFInput=text(source), WFReplaceTextFind=pattern,
               WFReplaceTextReplace=replacement, WFReplaceTextRegularExpression=True,
               WFReplaceTextCaseSensitive=True)



def uri_component(source):
    # Apple's URL Encode leaves URI reserved characters such as '/' and '+'.
    # Escape them for a single path component/header filename (RFC 3986).
    result = add("urlencode", WFInput=text(source), WFEncodeMode="Encode")
    for char in ":/?#[]@!$&'()*+,;=":
        result = add("text.replace", WFInput=text(result), WFReplaceTextFind=char,
            WFReplaceTextReplace="%"+format(ord(char),"02X"),
            WFReplaceTextRegularExpression=False, WFReplaceTextCaseSensitive=True)
    return result


def lower(source):
    return add("text.changecase", text=text(source), WFCaseType="lowercase", ShowWhenRun=False)


def math(source, operation, operand):
    return add("math", WFInput=attachment(source), WFMathOperation=operation,
               WFMathOperand=attachment(operand) if isinstance(operand, dict) else operand)


