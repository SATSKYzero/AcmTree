# ================================================================
# 性质注册表的读 / 写（scripts/devserver/nature_registry_store.py）
#
# `GET/PUT /api/nature-registry` 的**数据那一半**：形状校验、sha256 冲突检测、
# 临时文件 + `os.replace` 原子替换。它动的是**仓库里的规则文件**
# `acm-data/nature-registry.json`（`scripts/crate.py` 与 `src/core/natureFields.js` 都读它）。
#
# 三条边界（与前两条写盘路由同形 —— `/api/me`、`/api/nature-assignments`）：
#   · **路径写死**（页面传不了文件名）；
#   · **形状由 `nature_registry_lib.parse_registry()` 把关**（唯一一份判据；
#     那份文件改错了是**静默**的：少一档就当没有 ⇒ 必须挡在写盘那一刻）；
#   · `sha256` 与磁盘不符 ⇒ 409（"磁盘变了"），让页面重新载入再决定怎么合。
#
# ⚠️ **不写 `.bak`**（与 `me_store.py` 同一条决定：不备份和它那套逻辑）：
#    这份文件**在 git 里**（规则文件，随仓库走）⇒ 留底就是 git；而且真正要防的是
#    "两份并发写"，那由上面那条 409 挡。写入本身仍然是原子的：
#    要么旧内容、要么新内容，**不会留下半个 JSON**。
# ================================================================
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.dirname(HERE)
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from .me_store import file_sha256                                  # noqa: E402
from nature_registry_lib import (                                  # noqa: E402
    parse_registry, read_registry, registry_diff, registry_summary,
)


REGISTRY_REL = os.path.join('acm-data', 'nature-registry.json')

#: 写入上限（防手滑贴进几 MB）—— 现在那份 25 KB 上下
REGISTRY_MAX_BYTES = 512 * 1024


def _rel():
    return REGISTRY_REL.replace('\\', '/')


def registry_read_file(path):
    """
    读 `nature-registry.json` ⇒ `(http_code, payload)`。

    ⚠️ 这份文件**不该缺**（它在 git 里，缺了是仓库坏了）⇒ 404 + 一句"怎么找回来"，
    不像 `me.json` 那样"缺了也算合法"。
    """
    if not os.path.isfile(path):
        return 404, {'ok': False, 'error': '没有 %s（它在 git 里 —— `git checkout -- %s` 找回来）'
                                           % (_rel(), _rel())}
    try:
        doc = read_registry(path)
    except ValueError as err:
        return 500, {'ok': False, 'error': '磁盘上那份**形状不合法**：%s' % err}
    return 200, {'ok': True, 'path': _rel(), 'sha256': file_sha256(path),
                 'mtime': os.path.getmtime(path), 'doc': doc, 'summary': registry_summary(doc)}


def registry_write_file(path, payload, max_bytes: int = REGISTRY_MAX_BYTES):
    """
    写 `nature-registry.json` ⇒ `(http_code, payload)`。

    body 形状：`{"doc": <整份注册表>, "sha256": "<载入时那份，可选>"}`
    （要 `text` 也行 —— 页面那边可能拿 JSON 框的原文直接发）。

    三道闸：① 大小上限；② 形状过 `parse_registry()`（**唯一一份判据**）；
    ③ `sha256` 与磁盘不符 ⇒ 409（顺带把"磁盘上那份 vs 这次要写的"差异回带）。
    """
    if not isinstance(payload, dict):
        return 400, {'ok': False, 'error': 'body 必须是 JSON 对象'}
    doc = payload.get('doc')
    if doc is None and isinstance(payload.get('text'), str):
        try:
            doc = json.loads(payload['text'])
        except ValueError as err:
            return 400, {'ok': False, 'error': '文本不是合法 JSON：%s' % err}
    if not isinstance(doc, dict):
        return 400, {'ok': False, 'error': '缺少 doc（整份注册表文档，对象）'}
    try:
        size = len(json.dumps(doc, ensure_ascii=False).encode('utf-8'))
    except (TypeError, ValueError) as err:
        return 400, {'ok': False, 'error': 'doc 不是能序列化的 JSON：%s' % err}
    if size > max_bytes:
        return 400, {'ok': False, 'error': '文档 %d KB，超过上限 %d KB'
                                           % (size // 1024, max_bytes // 1024)}
    try:
        clean = parse_registry(doc, _rel())
    except ValueError as err:
        return 400, {'ok': False, 'error': str(err)}

    old_doc = None
    if os.path.isfile(path):
        try:
            old_doc = read_registry(path)
        except ValueError as err:
            # 磁盘上那份自己就不合法（比如人手工改坏了）：**不写** ——
            # 否则"改坏了"和"我要写的这份"就分不清是谁的错，也没法看差异。
            return 500, {'ok': False, 'error': '磁盘上那份形状不合法（%s）—— 先修好它再写' % err}
        want = str(payload.get('sha256') or '')
        if want and want != file_sha256(path):
            return 409, {'ok': False, 'error': '磁盘上的 %s 变过了（冲突）——'
                                               '先重新载入，再决定怎么合' % _rel(),
                         'path': _rel(), 'sha256': file_sha256(path),
                         'summary': registry_summary(old_doc)}
    diff = registry_diff(old_doc or {}, clean)

    tmp = path + '.tmp-write'
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(tmp, 'w', encoding='utf-8', newline='\n') as fh:
            json.dump(clean, fh, ensure_ascii=False, indent=2)
            fh.write('\n')
        os.replace(tmp, path)
    except OSError as err:
        try:
            os.remove(tmp)
        except OSError:
            pass
        return 500, {'ok': False, 'error': '写入失败：%s' % err}
    return 200, {'ok': True, 'path': _rel(), 'sha256': file_sha256(path),
                 'mtime': os.path.getmtime(path), 'doc': clean,
                 'summary': registry_summary(clean), 'diff': diff}
