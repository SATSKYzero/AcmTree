# ================================================================
# 回代 baseline 的**直接写盘**（scripts/devserver/nature_store.py）
#
# 规则：注册表是完整数据导出的一部分 ⇒ `acm-data/nature-assignments.json`
# **不用备份、直接写入**；而**缩水时先拒绝、要人点一下确认**（见下面那条 409 闸门）。
#
# 于是「📤 导出人工填写」走"页面点一下、主脚本直接写盘"，而不是"浏览器下载 + 人自己搬到
# acm-data/"（那个文件名会被浏览器加成 `nature-assignments (2).json`，还得靠人挑最新的）。
# 边界仍是**页面传不了路径**：
#
#   · 路径由这里写死（`NATURE_REL`）—— 页面交的只是**那整份文档**；
#   · 形状按**同一份读法**校验（`nature_baseline_lib.parse_baseline`，与
#     `scripts/nature-baseline.py` 读文件时那份**一字不差** ⇒ 写进去的必能被回代读出来）；
#   · **缩水（比磁盘上那份少节点/少格）默认拒绝**（409，把少了哪些 key 一并带回去），
#     页面问过用户之后再带 `confirm: true` 来重发；
#   · **不备份**：这份文件是**导出物**，它的每一条都能由应用数据重新导出
#     （人工值住在节点的值 + `分类依据: manual:set`，随「完整数据导出」走、IndexedDB 里也有）。
#     "写坏"这件事另有兜底：`nature-baseline.py` 读之前会**逐条校验形状**，不合法当场抛。
#     真正要防的是"**导出变少**"——那正是上面那条拒绝闸门在做的事（备份救不了它）。
#   · 仍然"临时文件 + `os.replace`"原子替换：**不会留下半个 JSON**。
# ================================================================
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.dirname(HERE)
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from nature_baseline_lib import baseline_diff, parse_baseline   # noqa: E402


NATURE_REL = os.path.join('acm-data', 'nature-assignments.json')

#: 写入上限（防手滑贴进几 MB）
NATURE_MAX_BYTES = 4 * 1024 * 1024

#: 拒绝时最多回带几个 key（页面拿它拼那句"少了什么"；不设上限的话响应会很难看）
MAX_LISTED = 50


def nature_read_file(path):
    """读磁盘上那份 baseline ⇒ `(http_code, payload)`（不存在时给 200 + `doc: null`：合法状态）"""
    if not os.path.isfile(path):
        return 200, {'ok': True, 'path': NATURE_REL.replace('\\', '/'), 'doc': None,
                     'count': 0, 'fields': 0}
    try:
        with open(path, encoding='utf-8-sig') as fh:
            doc = json.load(fh)
    except (OSError, ValueError) as err:
        return 500, {'ok': False, 'error': '读不了 %s：%s' % (NATURE_REL.replace('\\', '/'), err)}
    if not isinstance(doc, dict):
        return 500, {'ok': False, 'error': '%s 顶层不是对象' % NATURE_REL.replace('\\', '/')}
    return 200, {'ok': True, 'path': NATURE_REL.replace('\\', '/'), 'doc': doc,
                 'count': int(doc.get('count') or len(doc.get('assignments') or [])),
                 'fields': int(doc.get('fields') or 0)}


def nature_write_file(path, payload, confirm: bool = False):
    """
    写 `acm-data/nature-assignments.json` ⇒ `(http_code, payload)`。

    body 形状：`{"doc": <整份 baseline 文档>, "confirm": <bool，可选>}`。

    闸门：① 路径写死（页面传不了）；② 大小上限 + 形状过 `parse_baseline`；
    ③ **缩水且没带 `confirm`** ⇒ 409，把 `diff` 一起带回去（页面问过再来）。

    ⚠️ **不写备份**：这份文件是导出物，见文件头。
    """
    if not isinstance(payload, dict):
        return 400, {'ok': False, 'error': 'body 必须是 JSON 对象'}
    doc = payload.get('doc')
    if not isinstance(doc, dict):
        return 400, {'ok': False, 'error': '缺少 doc（整份 baseline 文档）'}
    try:
        if len(json.dumps(doc, ensure_ascii=False).encode('utf-8')) > NATURE_MAX_BYTES:
            return 400, {'ok': False, 'error': '文档超过 %d KB' % (NATURE_MAX_BYTES // 1024)}
    except (TypeError, ValueError) as err:
        return 400, {'ok': False, 'error': 'doc 不是能序列化的 JSON：%s' % err}
    try:
        parse_baseline(doc, '界面导出的 baseline')
    except ValueError as err:
        return 400, {'ok': False, 'error': str(err)}

    old_doc = None
    if os.path.isfile(path):
        try:
            with open(path, encoding='utf-8-sig') as fh:
                old_doc = json.load(fh)
        except (OSError, ValueError) as err:
            return 500, {'ok': False, 'error': '磁盘上那份读不了（%s）——不写' % err}
        if not isinstance(old_doc, dict):
            old_doc = None
    diff = baseline_diff(old_doc or {}, doc)
    want_confirm = bool(payload.get('confirm')) or bool(confirm)
    if diff['removed'] and not want_confirm:
        return 409, {
            'ok': False, 'error': '这次比磁盘上那份少了 %d 个节点（%d 处值）——先确认再写'
                                  % (diff['removed'], len(diff['changedFields'])),
            'path': NATURE_REL.replace('\\', '/'), 'diff': _trim_diff(diff), 'needConfirm': True,
        }

    tmp = path + '.tmp-write'
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(tmp, 'w', encoding='utf-8', newline='\n') as fh:
            json.dump(doc, fh, ensure_ascii=False, indent=2)
            fh.write('\n')
        os.replace(tmp, path)
    except OSError as err:
        try:
            os.remove(tmp)
        except OSError:
            pass
        return 500, {'ok': False, 'error': '写入失败：%s' % err}
    return 200, {'ok': True, 'path': NATURE_REL.replace('\\', '/'),
                 'count': int(doc.get('count') or len(doc.get('assignments') or [])),
                 'fields': int(doc.get('fields') or 0),
                 'mtime': os.path.getmtime(path), 'diff': _trim_diff(diff)}


def _trim_diff(diff):
    """回带给人看的 diff（key 列表封顶 `MAX_LISTED`，但**数字是完整的**）"""
    out = dict(diff)
    for field in ('addedKeys', 'removedKeys', 'changedKeys'):
        if len(out.get(field) or []) > MAX_LISTED:
            out[field] = out[field][:MAX_LISTED]
    out['changedFields'] = (out.get('changedFields') or [])[:MAX_LISTED]
    out['listed'] = MAX_LISTED
    return out
