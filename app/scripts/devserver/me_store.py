# ================================================================
# me.json 的读 / 写（scripts/devserver/me_store.py）
#
# 从 `dev-server.py` 拆出来的：`GET/PUT /api/me` 的**数据那一半** ——
# sha256 冲突检测、原子替换（`os.replace`）。
# ⚠️ 它动的是磁盘上的配置文件，不进应用历史。
#
# ⚠️ **不打码**（页面隐藏 cookie 之类的完全没有必要）：
#    这个接口只对本机回环 Origin 放行（见 `http_handler.cors_origin_allowed`），
#    页面就是你自己开的设置页 —— 遮成 `<已隐藏>` 只是让自己多一步（而且"看得到才敢改"）。
#    所以 GET 直给真值、PUT 就是**所见即所得**；换来的安全线是**两条不变**：
#    路径写死（页面传不了文件名）、sha256 不符 ⇒ 409 拒绝。
#
# ★ **"还没配"是合法状态**（2026-10-19）：`个人数据/me.json` 不在 ⇒ GET 回 200 + 空文档
#   （`exists: False`），PUT 会**顺手把 `个人数据/` 建出来**。判据见 `me_read_file` /
#   `me_write_file` 里的 ★，守卫在 `devserver/selftest.py`（"首次写进不存在的目录"那两条）。
# ================================================================
import hashlib
import json
import os

from . import roots


#: 仓库根相对的路径（**按仓库根解析，不是 `APP_ROOT`** —— 理由见 `roots.py` 文件头）。
#: ⚠️ 2026-10-17：`me.json` 从 `acm-data/raw/Scaper/` 搬到了**仓库根下的 `个人数据/`**
#:    （个人信息集中一处，公开副本整目录排除）。抓取层同一条口径的另一份在
#:    `acm-data/raw/Scaper/lib/me.py:ME_FILE`。
ME_REL = os.path.join(roots.PERSONAL_DIRNAME, 'me.json')

#: 写入上限（防手滑贴进几 MB）
ME_MAX_BYTES = 256 * 1024


def file_sha256(path: str) -> str:
    """文件的 sha256（设置页拿它做"磁盘变了吗"的比对）"""
    h = hashlib.sha256()
    try:
        with open(path, 'rb') as fh:
            for chunk in iter(lambda: fh.read(65536), b''):
                h.update(chunk)
    except OSError:
        return ''
    return h.hexdigest()


def me_read_file(path):
    """
    读 `me.json` ⇒ `(http_code, payload)`（**原样返回，不打码**，见文件头）。

    路径由调用方给定（服务器里写死 `ME_REL`），这里只负责"读 + 报指纹"。

    ★ **文件不在 ≠ 出错**（2026-10-19，用户："me.json 应在为空时仍允许账户写入，否则初次建包
      信息无法填全"）：第一次装、或拿到一份发布副本时，`个人数据/` 整个目录都还没有 ——
      那是**合法状态**（注册表那种"缺了就不对"的不一样）。所以这里回 **200 + `exists: False` +
      空文档**，页面照常进入可编辑状态；旧口径回 404，页面只能打一句"读不到 me.json"，
      凭据与账户**一处都填不了**。`exists` 只给界面说人话用（"还没有 me.json，保存一次就会建出来"），
      不是权限开关。
    """
    if not os.path.isfile(path):
        return 200, {'ok': True, 'path': ME_REL.replace('\\', '/'), 'exists': False,
                     'sha256': '', 'mtime': 0, 'doc': {}}
    try:
        with open(path, 'r', encoding='utf-8') as fh:
            doc = json.load(fh)
    except (OSError, ValueError) as err:
        return 500, {'ok': False, 'error': '读不了 %s：%s' % (ME_REL.replace('\\', '/'), err)}
    if not isinstance(doc, dict):
        return 500, {'ok': False, 'error': '%s 顶层不是对象' % ME_REL.replace('\\', '/')}
    return 200, {'ok': True, 'path': ME_REL.replace('\\', '/'), 'exists': True,
                 'sha256': file_sha256(path),
                 'mtime': os.path.getmtime(path), 'doc': doc}


def _keep_backup(path):
    """
    把当前那份原样存成 `me.json.bak`（**覆盖式、只留一档**）。

    ⚠️ 失败**不抛也不阻断**写入：备份是保险，不是闸门（见 `me_write_file` 的说明）。
    """
    if not os.path.isfile(path):
        return
    tmp = path + '.bak.tmp'
    try:
        with open(path, 'rb') as src, open(tmp, 'wb') as dst:
            dst.write(src.read())
        os.replace(tmp, path + '.bak')
    except OSError:
        try:
            os.remove(tmp)
        except OSError:
            pass


def me_write_file(path, payload, max_bytes: int = ME_MAX_BYTES):
    """
    写 `me.json` ⇒ `(http_code, payload)`。

    body 形状：`{"text": "<整份 JSON 文本>", "sha256": "<载入时那份，可选>"}`。

    三道闸：① 路径由调用方写死（**页面传不了路径**）；② 大小上限 + 必须是 JSON **对象**；
    ③ `sha256` 与磁盘不符 ⇒ 409 拒绝（"磁盘变了"，让页面重新载入后自己决定怎么合）。
    正文用"临时文件 + `os.replace`"原子替换。

    ⚠️ **写之前把当前那份留成 `me.json.bak`**（2026-10-17 改的口径）：旧口径是"不备份和它那套
       逻辑"（用户 2026-10-06），代价在 2026-10-17 兑现了一次 —— 一次自测事故把这份文件从
       4969 字节覆盖成 73 字节，盘上、git 里（全库 9628 个 blob 扫过）都没有副本，凭据全丢。
       现在**只留一档、覆盖式**（不滚多份、不建 `.bak2`），且**写失败不阻断写入**（备份是保险，
       不是闸门）。它属于第 1 档凭据（`scripts/clean-personal.mjs` 的三档判据认得出 `me.json.bak`，
       清个人数据时会连它一起处理）。
    """
    if not isinstance(payload, dict):
        return 400, {'ok': False, 'error': 'body 必须是 JSON 对象'}
    text = payload.get('text')
    if not isinstance(text, str) or not text.strip():
        return 400, {'ok': False, 'error': '缺少 text（整份 JSON 文本）'}
    if len(text.encode('utf-8')) > max_bytes:
        return 400, {'ok': False, 'error': '文本超过 %d KB' % (max_bytes // 1024)}
    try:
        new_doc = json.loads(text)
    except ValueError as err:
        return 400, {'ok': False, 'error': '不是合法 JSON：%s' % err}
    if not isinstance(new_doc, dict):
        return 400, {'ok': False, 'error': '顶层必须是对象（与 me.json 同形）'}

    if os.path.isfile(path):
        try:
            with open(path, 'r', encoding='utf-8') as fh:
                # 只用来**验"磁盘那份读得了"**：读不了（坏了/半截）就不写 ——
                # 免得把一份还能手工救的文件盖掉。（那份不拿来做合并；备份另有 `_keep_backup`。）
                json.load(fh)
        except (OSError, ValueError) as err:
            return 500, {'ok': False, 'error': '磁盘上那份读不了（%s）——不写' % err}
        want = str(payload.get('sha256') or '')
        if want and want != file_sha256(path):
            return 409, {'ok': False, 'error': '磁盘上的 me.json 变过了（冲突）——'
                                               '先重新载入，再决定怎么合'}

    tmp = path + '.tmp-write'
    _keep_backup(path)                 # 写之前留一档 `me.json.bak`（见上面 _keep_backup 的说明）
    try:
        # ★ **目录不在就建出来**（2026-10-19，第一次装/发布副本里 `个人数据/` 整个都还没有；
        #   旧写法直接在"父目录不存在"的地方开临时文件 ⇒ `[Errno 2] … me.json.tmp-write` ⇒
        #   导入全量包时"树进来了、个人信息没写回"，设置页那颗按钮也一样写不进去）。
        #   形状与 `nature_store.py` / `nature_registry_store.py` 那两条路由同一处（别各写一套）。
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(tmp, 'w', encoding='utf-8', newline='\n') as fh:
            json.dump(new_doc, fh, ensure_ascii=False, indent=2)
            fh.write('\n')
        os.replace(tmp, path)
    except OSError as err:
        try:
            os.remove(tmp)
        except OSError:
            pass
        return 500, {'ok': False, 'error': '写入失败：%s' % err}
    return 200, {'ok': True, 'path': ME_REL.replace('\\', '/'), 'exists': True,
                 'sha256': file_sha256(path),
                 'mtime': os.path.getmtime(path), 'doc': new_doc}
