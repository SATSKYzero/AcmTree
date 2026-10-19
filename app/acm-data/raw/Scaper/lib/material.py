#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
原料三档（`Scaper/lib/material.py`）—— 每份原料**该不该进包、留不留**

用户 2026-10-17 定的分档（原话："进包 / 不进包但保留 / 不保留"）：

    档①  **进包**        —— 产包**应该读**它（内容会进 `nodes/*.json`）⇒ 必须留
    档②  **不进包但保留** —— 产包**不该读**它，但文件**留着**（还在候选区，下一轮可能进包）⇒ 留
    档③  **不保留**      —— 既不进包、也不在候选区 ⇒ 不读，**可以删**

★ **因果方向**：是"档"决定"产包该不该读"，**不是**"产包读了什么"反推档
  ⇒ 事实一律来自**声明的范围**（清单 / 白名单 / 元信息分类 / rankland / 提交），
    **不看**上一轮的产物（片段、日志、mtime 一概不看）。

★ **这两档的判据不是这里新写的** —— 它们就是 `cf_adapter.py` 已经在用的那两道闸门，
  读法与产物在仓库里都写着（`05 xcpc/_usage.md` §0.2.3）：
    · **候选** = `cf_adapter.SCOPE_STAGE` 四道闸门（`whitelist` / `rankland` / `按分类` / `我的提交`）
      的并集 —— 产物 `cache/cf_gym_scope.json`（`cf_adapter.py --scope-report` 写；
      跨语言都按它读，所以本模块**也读那一份**，不自己再判一次分类）；
    · **进包** = 清单（`xcpc_contests.json`）里**被任何 cf 来源引到**的 gym
      （`board` 或 `sources` 里 `source == 'cf'` 且带 `gym`）—— 与 `cf_adapter.scope_report()`
      里那段 `packed` 判据**同一口径**（`_usage.md`："范围大 ≠ 进包多，两道闸门缺一不可"）。
  本模块只做一件事：**把这两份事实按文件问一遍**，不重新定义范围、不新增名单。

★ **事实读不到 ⇒ 不表态**（`None`）⇒ 归入"不进包但保留"：
  **绝不**在"算不出来"的时候判"不保留" —— 删除是唯一不可逆的动作（同 `stages.MERGES` 里
  `veto` 那条注释的道理）。
★ **没判据覆盖的花样**（如 `cf_contest/pages/*.html`、`_pieces_*.txt`）⇒ 同样归入"不进包但保留"。

★ **盘的是整个原料层**（2026-10-17 改）：`ROOTS` 那几棵（`05 xcpc/cache` / `03 PTA` / `02 hdu` / `01 nk`）。
  之前只盘 `05 xcpc/cache` ⇒ 杭电/牛客/PTA 的原料连"进包/保留"都没被问过，`--apply` 实际只对 cf 有效。
  各平台的"声明范围"**各只有一处**（`facts()` 里那七份）：清单点名的文件（352 个）／
  `hdu_contests.json` 与归档多校名单／`cache/nk/multi_contests.json`。

判据的形状**照 `stages.py` 现成那套**（判据 + 依据 + 记账都白拿，本模块不自造）：
`merge='first'` = **判据的顺序就是档的优先级**（进包 → 保留 → 不保留），第一条表态的说了算。

加一个新类型 = 在 `RULES` 加一条（`run` 返回 `(档, 依据id)`），**别在别处写第二份判定**。
"""

from __future__ import annotations

import json
import os
import re

import stages

HERE = os.path.dirname(os.path.abspath(__file__))          # …/Scaper/lib
SCAPER = os.path.dirname(HERE)                             # …/Scaper
#: ⚠️ 这是**机械层根**（`app/`），不是仓库根 —— `Scaper` 在 `app/acm-data/raw/` 下面，
#: 往上三层正好是 `app/`。清单里的路径（`acm-data/raw/…`）就是相对它写的。
REPO = os.path.dirname(os.path.dirname(os.path.dirname(SCAPER)))

#: 策展清单（"哪些 gym 会被产包读"的事实来源）
MANIFEST = os.path.join(SCAPER, '05 xcpc', 'xcpc_contests.json')
#: 候选区（`cf_adapter.py --scope-report` 的产物；四道闸门的并集）
SCOPE_FILE = os.path.join(SCAPER, '05 xcpc', 'cache', 'cf_gym_scope.json')

# ---- 其余平台的"声明范围"（各一份文件，不另立名单）----
#: 杭电：产包要的那些场次（`hdu_adapter` 按它写 C 的名字/时间）
HDU_LIST = os.path.join(SCAPER, '02 hdu', 'hdu_contests.json')
#: 杭电：站点归档里"每年那 10 场多校"（`hdu_multi_fetch.enumerate_archive` 的产物）
HDU_ARCHIVE = os.path.join(SCAPER, '02 hdu', 'cache', 'hdu_contests_all.json')
#: 牛客：往年多校索引（`nk_multi_fetch` 按它抓；也是它 `build()` 的输入）
NK_INDEX = os.path.join(SCAPER, '05 xcpc', 'cache', 'nk', 'multi_contests.json')

#: 三档（**顺序 = 优先级**，与 `STAGE.merge='first'` 配套）
TIERS = ('进包', '不进包但保留', '不保留')
#: 默认档 = 说不清时归的那一档（**必须留**的那一档）
KEEP = '不进包但保留'

# ---- 另外三种"声明范围"（2026-10-18 补：这三类此前一律"没有判据覆盖"）----
#: cf 比赛页缓存（`pages/<id>.contest.html`）：谁点名它 = 下面三处 id 的并集
CF_CONTEST_DIR = os.path.join(SCAPER, '05 xcpc', 'cache', 'cf_contest')
#: xcpcio 的目录树（上游仓库快照）——xcpcio 原料的声明范围之一
XCPCIO_TREE = os.path.join(SCAPER, '05 xcpc', 'cache', 'xcpcio_tree.json')
#: xcpcio 原料根（`cache/xcpcio/<树里的 path>/…`）
XCPCIO_DIR = os.path.join(SCAPER, '05 xcpc', 'cache', 'xcpcio')
#: AtCoder 缓存目录（`submissions_<handle>.json` 按花名册判；其余几个是适配器按死名字读的）
ATCODER_DIR = os.path.join(SCAPER, '05 xcpc', 'cache', 'atcoder')

#: 要盘一遍的原料根（**整个原料层**，不只是 cf 那个缓存目录）。
#: ⚠️ 2026-10-17 之前只有 `05 xcpc/cache` —— 于是 `--apply` 实际上只对 cf 有效，
#:    杭电/牛客/PTA 的原料连"进包/保留"都没被问过（用户："思考当前的整个原料处理脚本是否分工明确"）。
ROOTS = (
    ('05 xcpc/cache', os.path.join(SCAPER, '05 xcpc', 'cache')),
    ('03 PTA', os.path.join(SCAPER, '03 PTA')),
    ('02 hdu', os.path.join(SCAPER, '02 hdu')),
    ('01 nk', os.path.join(SCAPER, '01 nk')),
)
#: 代码/文档不是原料（`01 nk` 与 `02 hdu` 的脚本与人写的说明挨着放，混进来只会让数目失真）
CODE_EXTS = ('.py', '.js', '.mjs', '.md', '.bat', '.sh')

#: **不是原料**的花样（与"原料的第②档"是两件事：这些连"留着待判"都不算，直接不进统计）：
#:   · `crate_*` —— 适配器上一轮写下的**片段**（`crate-merge` 的输入，每轮重产；它们不是原料）
#:   · `.vscode/`、`__pycache__/`、`*.pyc` —— 编辑器配置与字节码
#: ⚠️ 判据只认**形状**（一眼能对上的名字），不是"读起来像不像原料"。
NON_MATERIAL = (
    re.compile(r'(?:^|/)crate_[^/]+$'),
    re.compile(r'(?:^|/)_pieces[^/]*\.txt$'),      # crate-merge 的临时片段（每轮重产）
    re.compile(r'(?:^|/)batch_jobs_[^/]+\.json$'),  # 流水线临时作业表
    re.compile(r'\.log$'),
    re.compile(r'(?:^|/)\.vscode/'),
    re.compile(r'(?:^|/)__pycache__/'),
    re.compile(r'\.pyc$'),
)


def _is_material(path: str, rel: str) -> bool:
    """
    这条路是不是**原料**（census 用它，`judge()` 不用）。

    两类排除：**代码/说明**（`CODE_EXTS`）、**上一轮的产物与杂项**（`NON_MATERIAL` 的形状，
    外加"顶上带 `crateVersion` + `records` 的 JSON" —— 那就是一份 crate 包，是**产物**不是原料：
    `xcpc.json` / `test_one_contest.json` 这种随手留下的包就是它）。
    """
    if os.path.splitext(rel)[1].lower() in CODE_EXTS:
        return False
    if any(rx.search(rel) for rx in NON_MATERIAL):
        return False
    if rel.lower().endswith('.json'):
        head = _json_head(path)
        if 'crateVersion' in head and isinstance(head.get('records'), list):
            return False
    return True


# ---------------------------------------------------------------- 事实（各只有一处）
def _packed_gyms():
    """
    清单里**被任何 cf 来源引到**的 gym ⇒ `{'101986', …}`；清单读不到 ⇒ `None`（不表态）。

    ⚠️ 与 `cf_adapter.scope_report()` 里那段 `packed` **同一口径**（`board` + `sources`，
    `source == 'cf'` 且带 `gym`）；那边按 role 会出 C 的是 `cf_board_adapter`，这里不分 role
    （"这份原料会不会被读"只看有没有 cf 来源引它）。
    """
    try:
        with open(MANIFEST, encoding='utf-8') as fh:
            doc = json.load(fh)
    except (OSError, ValueError):
        return None
    rows = [c for c in ((doc or {}).get('contests') or []) if isinstance(c, dict)]
    if not rows:
        return None                        # 清单在但一条都没有 ⇒ 当"读不到"（别把整个缓存判成可删）
    out = set()
    for c in rows:
        for one in [c.get('board') or {}] + list(c.get('sources') or []):
            if isinstance(one, dict) and str(one.get('source') or '') == 'cf' and one.get('gym'):
                out.add(str(one['gym']))
    return out


def _candidate_gyms():
    """候选区 = 四道闸门的并集（`cache/cf_gym_scope.json` 的键）；那份产物没有 ⇒ `None`"""
    try:
        with open(SCOPE_FILE, encoding='utf-8') as fh:
            doc = json.load(fh)
    except (OSError, ValueError):
        return None
    return {str(k) for k in doc} if isinstance(doc, dict) else None


def _roster():
    """`cf` 的认领范围（花名册）—— 唯一入口是 `lib/me.py:handles()`；读不到 ⇒ `None`"""
    try:
        import me as me_mod
        got = {str(h).strip() for h in me_mod.handles('cf') if str(h).strip()}
        return got or None
    except Exception:
        return None


def _read_json(path: str):
    """读一份 JSON，读不到 ⇒ `None`（与"读到了、里面是空的"分开 —— 判据要靠这个区别决定表不表态）"""
    try:
        with open(path, encoding='utf-8') as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def _cf_page_scope():
    """
    cf 比赛页（`cf_contest/pages/<id>.contest.html`）的声明范围 = 三处的并集：
      · `cf_contest/list.json` 的 `all` + `gyms` 键（适配器从 CF 拉的场次表）
      · `cf_contest/page_difficulty.json` 的键（难度探针打过的场次）
      · 各 `cf_contest/history_<handle>.json` 里 `rows[].contestId`（**我的提交所在的场次** ——
        比赛页正是为它们抓的：要给 R 记录一个父题目）
    三处**都**读不到 ⇒ `None`（不表态）。
    """
    seen = False
    ids = set()
    head = _read_json(os.path.join(CF_CONTEST_DIR, 'list.json'))
    if isinstance(head, dict):
        seen = True
        for part in ('all', 'gyms'):
            ids |= {str(k) for k in (head.get(part) or {})}
    diff = _read_json(os.path.join(CF_CONTEST_DIR, 'page_difficulty.json'))
    if isinstance(diff, dict):
        seen = True
        ids |= {str(k) for k in diff}
    for hist in sorted(os.listdir(CF_CONTEST_DIR)) if os.path.isdir(CF_CONTEST_DIR) else ():
        if not (hist.startswith('history_') and hist.endswith('.json')):
            continue
        doc = _read_json(os.path.join(CF_CONTEST_DIR, hist))
        if not isinstance(doc, dict):
            continue
        seen = True
        rows = doc.get('rows')
        if isinstance(rows, list):
            ids |= {str(r['contestId']) for r in rows
                    if isinstance(r, dict) and r.get('contestId')}
    return ids if seen else None


def _xcpcio_scope():
    """
    xcpcio 原料（`cache/xcpcio/<path>/…`）的声明范围 = 目录树里那些 `path` ∪ 清单里 xcpcio 来源的 `path`。
      · 目录树（`cache/xcpcio_tree.json`）就是上游仓库的**目录快照** —— 能存在哪些场次由它定；
      · 清单里点名的 `path` 是"这一轮真要读的"（比树更直接）。
    两边都读不到 ⇒ `None`。
    """
    tree = _read_json(XCPCIO_TREE)
    man = _read_json(MANIFEST)
    if not isinstance(tree, dict) and not isinstance(man, dict):
        return None
    paths = set()
    if isinstance(tree, dict):
        paths |= {str(c['path']) for c in (tree.get('contests') or [])
                  if isinstance(c, dict) and c.get('path')}
    if isinstance(man, dict):
        for c in (man.get('contests') or []):
            if not isinstance(c, dict):
                continue
            for one in [c.get('board') or {}] + list(c.get('sources') or []):
                if isinstance(one, dict) and str(one.get('source') or '') == 'xcpcio' and one.get('path'):
                    paths.add(str(one['path']))
    return paths or None


def _atcoder_roster():
    """AtCoder 的认领范围（花名册）—— 唯一入口同样是 `lib/me.py:handles()`；读不到 ⇒ `None`"""
    try:
        import me as me_mod
        got = {str(h).strip() for h in me_mod.handles('atcoder') if str(h).strip()}
        return got or None
    except Exception:                                   # noqa: BLE001 —— 读不到就"不表态"
        return None


def _atcoder_contests():
    """AtCoder 的场次表（`cache/atcoder/contests.json` 的 `id`）——题目页的声明范围；读不到 ⇒ `None`"""
    doc = _read_json(os.path.join(ATCODER_DIR, 'contests.json'))
    if not isinstance(doc, list):
        return None
    got = {str(c['id']) for c in doc if isinstance(c, dict) and c.get('id')}
    return got or None


def _manifest_refs():
    """
    清单里**逐个点名**的原料文件（记录里任何位置的 `file` 字段；实测 796 处、去重 352 个文件）
    ⇒ **绝对路径集合**；清单读不到 ⇒ `None`。

    这是"进包"最直接的一种事实：清单**指名**要读它，产包就会读它 ⇒ 档①
    （**与 cf gym 那道闸门并列，不是替代**：gym 是按 gym 键引，这里按文件路径引）。
    ⚠️ 清单里的路径**一律以 `acm-data/` 开头**（实测 796/796），也就是相对 **`app/`** 写 ——
       所以只按 `app/` 这一个基解析（别再试别的基：试多了会把 `app/app/…` 这种假路径也塞进来，
       2026-10-17 第一版就是这么错的，导致 488 个引用落不到文件上）。
    """
    try:
        with open(MANIFEST, encoding='utf-8') as fh:
            doc = json.load(fh)
    except (OSError, ValueError):
        return None
    rows = [c for c in ((doc or {}).get('contests') or []) if isinstance(c, dict)]
    if not rows:
        return None
    raw: list[str] = []

    def walk(o):
        if isinstance(o, dict):
            f = o.get('file')
            if isinstance(f, str) and f.strip():
                raw.append(f.strip())
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)

    walk(rows)
    if not raw:
        return None
    app_root = REPO                                  # 机械层根（`app/`）—— 见文件头那个常量的注释
    out = set()
    for f in raw:
        p = f if os.path.isabs(f) else os.path.join(app_root, f)
        out.add(os.path.normcase(os.path.abspath(p)))
    return out


def _hdu_declared():
    """
    杭电那两处声明范围 ⇒ `(packed, candidates)`：
      · `packed`     = `02 hdu/hdu_contests.json` 里的 cid（产包要的那些场次）
      · `candidates` = 归档里"每年那 10 场多校"的 cid（`hdu_multi_fetch` 默认抓的正是这批）
    读不到的那一份给 `None`。
    ⚠️ **两边都不在时仍然归"保留"**（见 `_hdu_tier` 的注释：`hdu_contests.json` 是"上一次出包
       时才补进去的"，刚抓完还没出包的场次不在里面 —— 拿它当"可删"会误删刚抓的原料）。
    """
    packed = None
    try:
        with open(HDU_LIST, encoding='utf-8-sig') as fh:
            got = json.load(fh)
        rows = got if isinstance(got, list) else (got.get('contests') or [])
        packed = {str(r.get('contest_id')) for r in rows if isinstance(r, dict) and r.get('contest_id')}
    except (OSError, ValueError):
        packed = None
    cand = None
    try:
        with open(HDU_ARCHIVE, encoding='utf-8') as fh:
            arc = json.load(fh)
        words = ('暑期联赛', '超级联赛', 'multi-university', '多校')
        cand = {str(r['cid']) for r in arc
                if isinstance(r, dict) and r.get('cid')
                and any(w in str(r.get('name') or '').lower() for w in words)}
    except (OSError, ValueError):
        cand = None
    return packed, (cand or None)


def _nk_index():
    """牛客往年多校索引里的 cid（`05 xcpc/cache/nk/multi_contests.json`）；读不到 ⇒ `None`"""
    try:
        with open(NK_INDEX, encoding='utf-8') as fh:
            got = json.load(fh)
    except (OSError, ValueError):
        return None
    rows = got if isinstance(got, list) else (got.get('contests') or [])
    out = {str(r.get('cid')) for r in rows if isinstance(r, dict) and r.get('cid')}
    return out or None


def facts() -> dict:
    """
    把几份事实各读一遍 ⇒ `{'packed','candidates','roster','manifest','hdu_packed','hdu_candidates','nk_index'}`

    ⚠️ `None` 与**空集**是两件事：空集 = "确实一个都没有"（可以据此判"不保留"），
    `None` = "这份事实读不到"（⇒ 判据不表态 ⇒ 归入保留）。
    """
    hdu_packed, hdu_cand = _hdu_declared()
    return {'packed': _packed_gyms(), 'candidates': _candidate_gyms(), 'roster': _roster(),
            'manifest': _manifest_refs(),
            'hdu_packed': hdu_packed, 'hdu_candidates': hdu_cand, 'nk_index': _nk_index(),
            'cf_pages': _cf_page_scope(), 'xcpcio': _xcpcio_scope(),
            'atcoder_roster': _atcoder_roster(), 'atcoder_contests': _atcoder_contests()}


def facts_label(f: dict) -> str:
    """给报告用的一行事实摘要（`None` 写成"读不到"）"""

    def n(v):
        return '读不到' if v is None else '%d 个' % len(v)

    return ('清单里的 cf gym = %s ｜ 候选区 = %s ｜ cf 花名册 = %s\n'
            '   清单点名的文件 = %s ｜ 杭电清单 = %s ｜ 杭电归档多校 = %s ｜ 牛客索引 = %s\n'
            '   cf 比赛页的场次 = %s ｜ xcpcio 目录 = %s ｜ atcoder 花名册 = %s') % (
        n(f.get('packed')), n(f.get('candidates')), n(f.get('roster')),
        n(f.get('manifest')), n(f.get('hdu_packed')), n(f.get('hdu_candidates')), n(f.get('nk_index')),
        n(f.get('cf_pages')), n(f.get('xcpcio')), n(f.get('atcoder_roster')))


# ---------------------------------------------------------------- 键从哪读
def _json_head(path: str) -> dict:
    """读一个小 JSON（读不了就空 dict —— 判据会退回文件名/不表态，**绝不猜**）"""
    try:
        with open(path, encoding='utf-8') as fh:
            got = json.load(fh)
        return got if isinstance(got, dict) else {}
    except (OSError, ValueError):
        return {}


#: 文件名形状 → 取键（**不是**通用切分：只认这几种已知形状，认不出就退回"不表态"）
_NAME_KEY_PATTERNS = (
    re.compile(r'^cf_standings_(\d+)\.json$'),
    re.compile(r'^cf_(\d+)_me\.json$'),
    re.compile(r'^(\d+)_'),
)


def _key_from_head_or_name(path: str, rel: str, fields=()) -> str:
    """
    先按内容里那几个字段找（`gym` / `contestId` / `fetchedFrom` 里的 `contestId=`），
    再按**已知的文件名形状**取（见 `_NAME_KEY_PATTERNS`）。
    **不**从文件名里切 handle（实测 handle 会带 `_`：`alt_coder`）⇒ handle 只能从内容读。
    """
    head = _json_head(path)
    for f in fields:
        v = head.get(f)
        if isinstance(v, (str, int)) and str(v).strip():
            return str(v).strip()
    url = str(head.get('fetchedFrom') or '')
    m = re.search(r'contestId=(\d+)', url)
    if m:
        return m.group(1)
    name = os.path.basename(rel)
    for rx in _NAME_KEY_PATTERNS:
        m = rx.match(name)
        if m:
            return m.group(1)
    return ''


def _gym_key(path, rel, _ctx):
    """这条文件描述的是哪个 gym？（内容优先，文件名兜底）"""
    return _key_from_head_or_name(path, rel, fields=('gym', 'contestId'))


def _handle_key(path, rel, _ctx):
    """这条文件描述的是哪个 handle？（`history_*.json` 里有 `"handle"`，实测可靠）"""
    head = _json_head(path)
    h = head.get('handle')
    if isinstance(h, str) and h.strip():
        return h.strip()
    m = re.match(r'^history_(.+)\.json$', os.path.basename(rel))
    return m.group(1) if m else ''


# ---------------------------------------------------------------- 判据（按"花样"问档）
#: gym 那几种文件名花样 → (正则, 相对缓存根的目录)
_GYM_SHAPES = (
    (re.compile(r'^cf_standings_\d+\.json$'), ''),
    (re.compile(r'^cf_\d+_me\.json$'), ''),
    (re.compile(r'^\d+_.+\.json$'), 'cf'),
)


def _gym_tier(item, ctx, _cur):
    """
    gym 那几样原料：按**同样的两道闸门**给档
      · 清单里引到 ⇒ **进包**      · 只在候选区 ⇒ **不进包但保留**      · 两边都不在 ⇒ **不保留**

    ⚠️ 两边事实只要有一边是 `None`（读不到）⇒ **不表态**（绝不判"不保留"）。
    """
    path, rel = item
    d = os.path.dirname(rel).replace('\\', '/')
    if not any(d == want and rx.match(os.path.basename(rel)) for rx, want in _GYM_SHAPES):
        return None                        # 不是 gym 那几样 ⇒ 这条判据管不着
    key = _gym_key(path, rel, ctx)
    if not key:
        return None                        # 键取不到 ⇒ 不表态
    f = ctx.get('facts') or {}
    packed, cand = f.get('packed'), f.get('candidates')
    if packed is not None and key in packed:
        return ('进包', 'cf-gym-packed')
    if cand is not None and key in cand:
        return (KEEP, 'cf-gym-candidate')
    if packed is not None and cand is not None:
        return ('不保留', 'cf-gym-unscoped')
    return None


def _handle_tier(item, ctx, _cur):
    """`cf_contest/history_<handle>.json`：花名册里 ⇒ **进包**；不在 ⇒ **不保留**（读不到花名册 ⇒ 不表态）"""
    path, rel = item
    if os.path.dirname(rel).replace('\\', '/') != 'cf_contest':
        return None
    if not re.match(r'^history_.+\.json$', os.path.basename(rel)):
        return None
    roster = (ctx.get('facts') or {}).get('roster')
    if roster is None:
        return None
    key = _handle_key(path, rel, ctx)
    if not key:
        return None
    return ('进包', 'cf-handle-roster') if key in roster else ('不保留', 'cf-handle-gone')


def _manifest_tier(item, ctx, _cur):
    """
    清单**逐个点名**的原料文件 ⇒ **进包**（无论哪个平台、哪种花样）。

    为什么它排在最前：这是"产包会不会读它"最直接的一手事实（清单里写着这个路径），
    比任何按 gym/cid 推的判据都强。`03 PTA/*.json`、`04 qoj/qoj_submissions.json`、
    `cache/nk/nk_cid136164_rank_stats.json` 这类"清单直接点名"的文件全靠它归到档①。
    """
    path = os.path.normcase(os.path.abspath(item[0]))
    refs = (ctx.get('facts') or {}).get('manifest')
    if refs is None:
        return None
    return ('进包', 'manifest-file') if path in refs else None


_HDU_NAME = re.compile(r'^hdu_cid(\d+)_')
_NK_NAME = re.compile(r'^nk_cid(\d+)_')


def _hdu_tier(item, ctx, _cur):
    """
    杭电的原料（`hdu_cid<CID>_<种类>`）：清单里有这场 ⇒ **进包**；只在归档的多校名单里 ⇒ **保留**。

    ⚠️ **两边都不在时也是"保留"（不表态）**，与 cf 那条刻意不同 —— 病根是顺序：
       `02 hdu/hdu_contests.json` 是 `hdu_multi_fetch build` **出包时**才补进去的，
       刚抓完还没出包的那几场**不在里面** ⇒ 若把它当"可删"，`purge` 档（先删后抓/先删后产包）
       会把**刚抓的原料**删掉。⇒ 这里只用来"确认留下"，不用来"判可删"。
    """
    m = _HDU_NAME.match(os.path.basename(item[1]))
    if not m:
        return None
    f = ctx.get('facts') or {}
    cid = m.group(1)
    packed, cand = f.get('hdu_packed'), f.get('hdu_candidates')
    if packed is not None and cid in packed:
        return ('进包', 'hdu-manifest')
    if cand is not None and cid in cand:
        return (KEEP, 'hdu-archive-multi')
    return None


def _nk_tier(item, ctx, _cur):
    """
    牛客的原料（`nk_cid<CID>_*`）：在往年多校索引里 ⇒ **进包**（`nk_multi_fetch build()` 就按索引读）。

    ⚠️ 不在索引里 ⇒ **保留**（不表态）：索引是按 `--from-year` 生成过的，删掉"这次没列进来"的
       那几场会让以后 `--from-year` 往前放时要重抓一遍（清单点名的那几个由档①那条管）。
    ⚠️ **只认自动路那一份原料**（`05 xcpc/cache/nk/`）：`01 nk/` 里同名花样是浏览器手存路的，
       它产的是 `nk-browser.json`（**不进 `all_nodes.json`**）—— 名字撞了，位置不同就是两件事。
    """
    full = item[0].replace('\\', '/').lower()
    if '/cache/nk/' not in full:
        return None
    m = _NK_NAME.match(os.path.basename(item[1]))
    if not m:
        return None
    idx = (ctx.get('facts') or {}).get('nk_index')
    if idx is None:
        return None
    # ★ 索引读得到、这一场不在里面 ⇒ **表态"保留"**（不是"没判据"）：索引按 `--from-year` 生成过，
    #   "这次没列进来"不等于"没用"（以后把 --from-year 往前放还要重抓）。
    return ('进包', 'nk-index') if m.group(1) in idx else (KEEP, 'nk-not-in-index')


#: cf 比赛页的文件名形状（`cache/cf_contest/pages/<id>.contest.html`）
_CF_PAGE_NAME = re.compile(r'^(\d+)\.contest\.html$')
#: cf 那个目录里**适配器按死名字读的**几份（不是按场次分的）
_CF_FIXED = ('list.json', 'page_difficulty.json', 'rated_list.json',
             'problems.json', 'rated.json', 'reuse.json', 'types.json')


def _cf_contest_tier(item, ctx, _cur):
    """
    `cache/cf_contest/**` 那两类：
      · `list.json` / `page_difficulty.json` / `rated_list.json` ⇒ **进包**（适配器按这几个死名字读，
        没有它们 `cf_contest_adapter` 就得重新联网拉场次表）；
      · `pages/<id>.contest.html` ⇒ 在**声明范围**里（见 `_cf_page_scope`）⇒ 进包；不在 ⇒ **不保留**。
        （声明范围 = 场次表 ∪ 难度探针打过的 ∪ 我提交所在的场次 —— 比赛页正是为这三种抓的。）
    事实读不到 ⇒ 不表态。
    """
    rel = item[1].replace('\\', '/')
    if os.path.dirname(rel) != 'cf_contest' and os.path.dirname(rel) != 'cf_contest/pages':
        return None
    name = os.path.basename(rel)
    if os.path.dirname(rel) == 'cf_contest':
        return ('进包', 'cf-contest-cache') if name in _CF_FIXED else None
    m = _CF_PAGE_NAME.match(name)
    if not m:
        return None
    scope = (ctx.get('facts') or {}).get('cf_pages')
    if scope is None:
        return None
    return ('进包', 'cf-contest-page-used') if m.group(1) in scope else ('不保留', 'cf-contest-page-unused')


def _xcpcio_tier(item, ctx, _cur):
    """
    xcpcio 原料（`cache/xcpcio/<path>/…`）：那条 `path` 在**声明范围**里（目录树 ∪ 清单）⇒ **进包**；
    两边都不在 ⇒ **不保留**（目录树就是"上游有哪些场次"的快照，范围外的目录不会是这一轮要的）。
    ⚠️ **两边都读不到 ⇒ 不表态**（`_xcpcio_scope()` 返回 `None`）。
    """
    rel = item[1].replace('\\', '/')
    if not rel.startswith('xcpcio/'):
        return None
    scope = (ctx.get('facts') or {}).get('xcpcio')
    if scope is None:
        return None
    inside = os.path.dirname(rel[len('xcpcio/'):]).replace('\\', '/')
    return ('进包', 'xcpcio-tree') if inside in scope else ('不保留', 'xcpcio-gone')


#: AtCoder 那个目录里适配器按死名字读的几份
_ATCODER_FIXED = ('contests.json', 'problems.json', 'problem-models.json', 'letter_warnings.json')


def _atcoder_tier(item, ctx, _cur):
    """
    `cache/atcoder/**` 三类：死名字那几份 ⇒ **进包**；`submissions_<handle>.json` ⇒ 按**花名册**判
    （在 ⇒ 进包；不在 ⇒ 不保留，与 cf 的 `history_<handle>.json` 同形）；
    `pages/<contest>.tasks.html` ⇒ 在**声明范围**（`contests.json` 的场次表）里 ⇒ 进包，不在 ⇒ 不保留。
    """
    rel = item[1].replace('\\', '/')
    name = os.path.basename(rel)
    here = os.path.dirname(rel)
    if here == 'atcoder':
        if name in _ATCODER_FIXED:
            return ('进包', 'atcoder-cache')
        m = re.match(r'^submissions_(.+)\.json$', name)
        if not m:
            return None
        roster = (ctx.get('facts') or {}).get('atcoder_roster')
        if roster is None:
            return None
        return ('进包', 'atcoder-roster') if m.group(1) in roster else ('不保留', 'atcoder-gone')
    if here == 'atcoder/pages':
        m = re.match(r'^(.+)\.tasks\.html$', name)
        if not m:
            return None
        scope = (ctx.get('facts') or {}).get('atcoder_contests')
        if scope is None:
            return None
        return ('进包', 'atcoder-page-used') if m.group(1) in scope else ('不保留', 'atcoder-page-gone')
    return None


def _misc_declared_tier(item, ctx, _cur):
    """
    那几份"链上明确读的死名字"缓存（各一处，名字就是判据）：
      · `nk/multi_contests.json`  —— 牛客往年多校索引本身（`nk_multi_fetch` 按它抓、也按它出包）
      · `clist/difficulty.json`   —— CLIST 难度缓存（`scripts/clist-difficulty.py sync` 读它回写包）
      · `cf_gym_scope.json` / `cf_gym_meta.json` / `xcpcio_tree.json` —— 三份"范围/身份"表
        （`cf_adapter`、`gen_gym_manifest`、`xcpcio_adapter` 读；链尾还会报它们的年龄）
      · `qoj_categories.json` —— QOJ 场次分类缓存（`xcpc_registry.py` 的 `QOJ_CATS`：读它、也回写它）
      · `rankland_config.yaml` —— 上游 rankland 目录树的缓存（`lib/rankland_tree.py` 的 `cache_path`）
      · `02 hdu/hdu_contests.json` —— 杭电出包的清单（"按 cid 的账号事实"**不在这里**：
        2026-10-19 起它在 `me.json` 的 `hdu.years.<年份>.contestUser` 里，仓库里不留痕迹）
    """
    rel = item[1].replace('\\', '/')
    if rel in ('nk/multi_contests.json', 'clist/difficulty.json', 'cf_gym_scope.json',
               'cf_gym_meta.json', 'xcpcio_tree.json', 'qoj_categories.json',
               'rankland_config.yaml'):
        return ('进包', 'chain-input')
    if re.match(r'^hdu_contests\.json$', rel):
        return ('进包', 'hdu-declared')
    return None


def _pta_manual_tier(item, ctx, _cur):
    """
    `03 PTA/` 是**人从浏览器 F12 存下来的手工原料目录**（没有名字规律可言）。
    清单按路径点名的那几份由 `manifest-file` 判进包；其余 ⇒ **保留**（并**表态**：这是手工原料，
    人可能还要用 —— 与"没有判据覆盖"是两件事，报告里能分开）。
    """
    full = item[0].replace('\\', '/').lower()
    if '/03 pta/' not in full:
        return None
    return (KEEP, 'pta-manual')


def _nk_browser_tier(item, ctx, _cur):
    """
    `01 nk/<年份>/…` = **浏览器手存路**（`nk_pipeline.py --all` 的原料）⇒ **进包**。

    ⚠️ 它产的是 `nk-browser.json`（**不进 `all_nodes.json`**），但"产包会不会读"只要"某条命令会读"就成立
       —— `npm run crate:nk:browser` 就是那条命令；判据认的是**目录声明**，不是"在不在总包里"。
    ⚠️ **按绝对路径认树**（`/01 nk/<年份>/`）：`05 xcpc/cache` 里也有个 `cache/nk/`，
       只按相对路径判会把两棵树混成一件（`_nk_tier` 那条也是这么认的）。
    """
    full = item[0].replace('\\', '/').lower()
    return ('进包', 'nk-browser-raw') if re.search(r'/01 nk/\d{4}/', full) else None


def _hdu_cache_tier(item, ctx, _cur):
    """
    `02 hdu/cache/**`（归档枚举缓存 `hdu_contests_all.json`）⇒ **进包**：
    `hdu_multi_fetch.archive_rows(local_only=True)` **优先读它**，没有缓存才退回 `hdu_contests.json`。

    ⚠️ 同样**按绝对路径认树**（`/02 hdu/cache/`）：别的树里也有 `cache/`。
    """
    full = item[0].replace('\\', '/').lower()
    return ('进包', 'hdu-archive-cache') if '/02 hdu/cache/' in full else None


#: 判据表 —— **顺序 = 档的优先级**（`merge='first'`），每条 = 一类花样。
#: ⚠️ `manifest-file` **必须排第一**：清单点名是"产包会不会读"最直接的一手事实，
#:    它比按 gym/cid 推的判据都强（`03 PTA/*.json`、`cache/nk/nk_cid…_rank_stats.json` 全靠它）。
RULES = (
    stages.Rule(id='manifest-file', field='tier', run=_manifest_tier,
                why='清单（`xcpc_contests.json`）里按路径点名的原料 ⇒ 产包直接读它 ⇒ 进包'),
    stages.Rule(id='gym-raw', field='tier', run=_gym_tier,
                why='gym 的缓存：清单引到 ⇒ 进包；只在候选区（白名单/rankland/按分类/我的提交）⇒ 不进包但保留；'
                    '两边都不在 ⇒ 不保留'),
    stages.Rule(id='cf-history', field='tier', run=_handle_tier,
                why='某 handle 的整份提交历史：在花名册里 ⇒ 进包；不在 ⇒ 不保留'),
    stages.Rule(id='hdu-raw', field='tier', run=_hdu_tier,
                why='杭电的原料：在 `02 hdu/hdu_contests.json` 里 ⇒ 进包；在归档多校名单里 ⇒ 保留；'
                    '都不是 ⇒ **也保留**（清单是出包时才补的，刚抓的场次还没进去）'),
    stages.Rule(id='nk-raw', field='tier', run=_nk_tier,
                why='牛客的原料：在往年多校索引里 ⇒ 进包；不在 ⇒ 保留（索引带 --from-year 口径）'),
    stages.Rule(id='cf-contest', field='tier', run=_cf_contest_tier,
                why='`cache/cf_contest` 那两类：死名字那几份 ⇒ 进包；比赛页按"场次表 ∪ 难度探针 ∪ 我的提交"'
                    '这个声明范围判 ⇒ 在范围里进包、不在不保留'),
    stages.Rule(id='xcpcio-raw', field='tier', run=_xcpcio_tier,
                why='xcpcio 原料：目录在"上游目录树 ∪ 清单点名"里 ⇒ 进包；都不在 ⇒ 不保留'),
    stages.Rule(id='atcoder-cache', field='tier', run=_atcoder_tier,
                why='AtCoder 缓存：死名字那几份 ⇒ 进包；`submissions_<handle>` 按花名册判（同 cf 的 history）'),
    stages.Rule(id='nk-browser', field='tier', run=_nk_browser_tier,
                why='`01 nk/<年份>/` 是浏览器手存路的原料（`crate:nk:browser` 读它）⇒ 进包'),
    stages.Rule(id='hdu-cache', field='tier', run=_hdu_cache_tier,
                why='`02 hdu/cache/` 的归档枚举缓存是 `archive_rows(local_only)` 的首选输入 ⇒ 进包'),
    stages.Rule(id='atcoder-page', field='tier', run=_atcoder_tier,
                why='AtCoder 的题目页按 `contests.json` 的场次表判（在 ⇒ 进包，不在 ⇒ 不保留）'),
    stages.Rule(id='chain-input', field='tier', run=_misc_declared_tier,
                why='链上按死名字读的几份缓存/范围表（牛客索引、CLIST 难度、gym 范围与元信息、'
                    'xcpcio 目录树、杭电清单与账号事实）⇒ 进包'),
    stages.Rule(id='pta-manual', field='tier', run=_pta_manual_tier,
                why='`03 PTA/` 是人手工存的原料目录：清单点名的那几份进包，其余**保留**（手工原料不删）'),
)

#: 一个环节 = 上面那张表 + `first` 合并（**顺序即优先级**）
STAGE = stages.Stage(
    key='raw-tier', title='原料三档（进包 / 不进包但保留 / 不保留）',
    field='tier', merge='first', rules=RULES, unit='份',
    missing='没有判据覆盖这类花样 ⇒ 归入「不进包但保留」（留）—— 新花样默认安全，绝不误删')


# ---------------------------------------------------------------- 结论
def judge(rel: str, root: str = '', facts_map: dict = None) -> dict:
    """
    问一份文件 ⇒ `{'tier': 档, 'rule': 依据id, 'stated': 有没有判据表态, 'key': …, 'rel': …, 'path': …}`

    · `stated=False` ⇒ 归入 `KEEP`（**没判据覆盖** / 事实读不到）
    """
    root = root or default_root()
    path = rel if os.path.isabs(rel) else os.path.join(root, rel)
    rel2 = os.path.relpath(path, root).replace('\\', '/')
    ans = stages.resolve(STAGE, (path, rel2), {'facts': facts_map if facts_map is not None else facts()})
    tier = ans.value if ans.stated else KEEP
    key = ''
    if ans.rule in ('cf-gym-packed', 'cf-gym-candidate', 'cf-gym-unscoped'):
        key = _gym_key(path, rel2, {})
    elif ans.rule in ('cf-handle-roster', 'cf-handle-gone'):
        key = _handle_key(path, rel2, {})
    return {'tier': tier, 'rule': ans.rule, 'stated': ans.stated, 'key': key, 'rel': rel2, 'path': path}


def default_root() -> str:
    """默认就在 `05 xcpc/cache` 上问（这个模块第一个用户是它）"""
    return os.path.join(SCAPER, '05 xcpc', 'cache')


def census(root: str = '', facts_map: dict = None) -> dict:
    """
    把**一棵**原料树走一遍、按三档分堆。

    @returns `{'tiers': {'进包': [...], '不进包但保留': [...], '不保留': [(rel, 依据, 键), …]},
               'unstated': [rel, …], 'root': …, 'facts': {…}}`
             ⚠️ 只有 **`'不保留'`** 那一堆是"可以删"的；`'unstated'` 已经算进"不进包但保留"。
    """
    root = root or default_root()
    facts_map = facts() if facts_map is None else facts_map
    tiers = {t: [] for t in TIERS}
    unstated = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d != '__pycache__']
        for fn in sorted(filenames):
            p = os.path.join(dirpath, fn)
            rel = os.path.relpath(p, root).replace('\\', '/')
            if not _is_material(p, rel):
                continue                       # 脚本/说明/上一轮的片段/编辑器杂项 ⇒ 不是原料
            got = judge(rel, root, facts_map)
            if got['tier'] == '不保留':
                tiers['不保留'].append((rel, got['rule'], got['key']))
            else:
                tiers[got['tier']].append(rel)
            if not got['stated']:
                unstated.append(rel)
    return {'tiers': tiers, 'unstated': unstated, 'root': root, 'facts': facts_map}


def census_tree(facts_map: dict = None, roots: tuple = ()) -> list[dict]:
    """
    **整个原料层**盘一遍（`ROOTS` 那几棵；见文件头"为什么不能只盘 `05 xcpc/cache`"）。

    @returns `[{'label':…, 'root':…, 'census': census(...)}, …]` —— 每棵树一份，报告按树打
    """
    facts_map = facts() if facts_map is None else facts_map
    out = []
    for label, root in (roots or ROOTS):
        if not os.path.isdir(root):
            continue
        out.append({'label': label, 'root': root, 'census': census(root, facts_map)})
    return out


# ---------------------------------------------------------------- 自测
def selftest() -> int:
    """
    正反各验一遍**三档**：进包 / 只在候选区 / 两边都不在；两类花样（gym、花名册）；
    外加两条安全阀（**事实读不到 ⇒ 不表态**、**没判据覆盖 ⇒ 保留**）。
    ⚠️ 反面样本一个都不能少 —— "该留的留下了"才是这个模块的价值。
    ⚠️ 样本目录建在**工作区内**（`.material-selftest/`）而不是系统 temp：
       受限环境（DSH 文件沙箱）**不给写系统临时目录**，`tempfile.TemporaryDirectory()`
       会直接 `PermissionError`（实测；`devserver/selftest.py` 早就是这么绕的）。
    """
    import shutil

    bad, ok = [], 0

    def check(name, cond, detail=''):
        nonlocal ok
        if cond:
            ok += 1
        else:
            bad.append('%s %s' % (name, detail))

    tmp = os.path.join(HERE, '.material-selftest')
    shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(tmp, exist_ok=True)
    try:
        def w(rel, body):
            p = os.path.join(tmp, rel)
            os.makedirs(os.path.dirname(p), exist_ok=True)
            with open(p, 'w', encoding='utf-8') as fh:
                fh.write(body)
            return p

        w('cf_standings_101775.json', '{"gym": 101775}')          # 清单里引到 ⇒ 进包
        w('cf_standings_101986.json', '{"gym": 101986}')          # 只在候选区 ⇒ 不进包但保留
        w('cf_standings_101999.json', '{"gym": 101999}')          # 两边都不在 ⇒ 不保留
        w('cf_101775_me.json', '{"status":"OK","result":[]}')     # 进包（文件名兜底取键）
        w('cf_101986_me.json', '{"status":"OK","result":[]}')     # 保留
        w('cf/101775_someone.json', '{"status":"OK","result":[]}')  # 进包
        w('cf/101986_WhoKnows.json', '{"status":"OK","result":[]}')  # ⚠️ **不按 handle 判** ⇒ 保留（保守）
        w('cf/101999_someone.json', '{"status":"OK","result":[]}')  # 不保留
        w('cf_contest/history_someone.json', '{"handle":"someone","rows":[]}')   # 花名册内 ⇒ 进包
        w('cf_contest/history_Gone.json', '{"handle":"Gone","rows":[]}')       # 花名册外 ⇒ 不保留
        w('cf_contest/list.json', '{"all":{},"gyms":{}}')          # 死名字 ⇒ 进包
        w('cf_contest/pages/777.contest.html', '<html></html>')    # 声明范围内 ⇒ 进包
        w('cf_contest/pages/888.contest.html', '<html></html>')    # 声明范围外 ⇒ 不保留
        w('xcpcio/data/ccpc/10th/chongqing/config.json', '{}')     # 目录树里有 ⇒ 进包
        w('xcpcio/data/gone/old/config.json', '{}')                # 两边都不在 ⇒ 不保留
        w('atcoder/problems.json', '{}')                           # 死名字 ⇒ 进包
        w('atcoder/submissions_someone2.json', '{}')                # 花名册内 ⇒ 进包
        w('atcoder/submissions_Gone.json', '{}')                   # 花名册外 ⇒ 不保留
        w('01 nk/2026/2026nk1/nk_cid5_problems.json', '{}')        # 浏览器手存路 ⇒ 进包（`01 nk/` 那棵树）
        w('02 hdu/cache/hdu_contests_all.json', '[]')              # 归档枚举缓存 ⇒ 进包（`02 hdu` 那棵树）
        w('crate_cf999_cf_board.json', '{}')                        # 上一轮的片段 ⇒ **不是原料**（不进统计）
        w('qoj_categories.json', '{}')                              # 注册表读/写它 ⇒ 进包
        w('rankland_config.yaml', 'root: {}\n')                     # rankland 目录树缓存 ⇒ 进包
        w('problems.json', '{}')                                  # 全局单例 ⇒ 保留（没判据覆盖）
        f = {'packed': {'101775'}, 'candidates': {'101775', '101986'}, 'roster': {'someone', 'teammate_a'},
             'cf_pages': {'777'}, 'xcpcio': {'data/ccpc/10th/chongqing'},
             'atcoder_roster': {'someone2'}}
        got = census(tmp, f)
        t = got['tiers']
        packed, keep, drop = set(t['进包']), set(t[KEEP]), {rel for rel, _r, _k in t['不保留']}
        unk = set(got['unstated'])

        check('清单里引到的 gym ⇒ 进包', 'cf_standings_101775.json' in packed)
        check('只在候选区 ⇒ 不进包但保留（反面）', 'cf_standings_101986.json' in keep)
        check('两边都不在 ⇒ 不保留', 'cf_standings_101999.json' in drop)
        check('gym-me 也照同一道闸门：进包', 'cf_101775_me.json' in packed)
        check('gym-me：保留', 'cf_101986_me.json' in keep)
        check('gym×handle：进包', 'cf/101775_someone.json' in packed)
        check('★ 不拿文件名切 handle（`101986_WhoKnows` 该留）', 'cf/101986_WhoKnows.json' in keep)
        check('gym×handle：不保留', 'cf/101999_someone.json' in drop)
        check('花名册内的 history ⇒ 进包', 'cf_contest/history_someone.json' in packed)
        check('花名册外的 history ⇒ 不保留', 'cf_contest/history_Gone.json' in drop)
        # ★ 2026-10-18：这几类此前一律"没有判据覆盖"（②），现在各有一条**声明范围**判据。
        check('cf 目录里按死名字读的那几份 ⇒ 进包', 'cf_contest/list.json' in packed)
        check('★ cf 比赛页：声明范围内 ⇒ 进包', 'cf_contest/pages/777.contest.html' in packed)
        check('★ cf 比赛页：声明范围外 ⇒ 不保留', 'cf_contest/pages/888.contest.html' in drop)
        check('★ xcpcio：目录树里有 ⇒ 进包', 'xcpcio/data/ccpc/10th/chongqing/config.json' in packed)
        check('★ xcpcio：两边都不在 ⇒ 不保留', 'xcpcio/data/gone/old/config.json' in drop)
        check('atcoder：死名字那几份 ⇒ 进包', 'atcoder/problems.json' in packed)
        check('atcoder：花名册内 ⇒ 进包', 'atcoder/submissions_someone2.json' in packed)
        check('atcoder：花名册外 ⇒ 不保留', 'atcoder/submissions_Gone.json' in drop)
        check('★ 牛客浏览器手存路 ⇒ 进包（`01 nk/<年份>/`）',
              '01 nk/2026/2026nk1/nk_cid5_problems.json' in packed)
        check('★ 杭电归档缓存 ⇒ 进包（`02 hdu/cache/`）', '02 hdu/cache/hdu_contests_all.json' in packed)
        check('★ 上一轮的片段（`crate_*`）**不是原料** ⇒ 不进任何一档',              'crate_cf999_cf_board.json' not in packed and 'crate_cf999_cf_board.json' not in keep
              and 'crate_cf999_cf_board.json' not in drop
              and 'crate_cf999_cf_board.json' not in unk)
        check('★ 两份"散件"也有判据了：注册表的 QOJ 分类缓存 / rankland 目录树缓存 ⇒ 进包',
              'qoj_categories.json' in packed and 'rankland_config.yaml' in packed
              and 'qoj_categories.json' not in unk and 'rankland_config.yaml' not in unk)
        check('★ 全局单例（没判据覆盖）⇒ 保留', 'problems.json' in keep)
        check('★ 没判据覆盖是"不表态"，不是"判成不保留"',
              judge('problems.json', tmp, f)['stated'] is False)
        check('★ 新判据同样守安全阀：声明范围读不到 ⇒ 不表态（比赛页/xcpcio 都归保留）',
              judge('cf_contest/pages/888.contest.html', tmp, {**f, 'cf_pages': None})['tier'] == KEEP
              and judge('xcpcio/data/gone/old/config.json', tmp, {**f, 'xcpcio': None})['tier'] == KEEP)
        # ★ 安全阀：事实读不到 ⇒ **不许**判"不保留"（删除是唯一不可逆的动作）
        blind = {'packed': None, 'candidates': None, 'roster': None}
        check('★ 清单读不到 ⇒ 不表态（绝不判不保留）',
              judge('cf_standings_101999.json', tmp, blind)['tier'] == KEEP
              and judge('cf_standings_101999.json', tmp, blind)['stated'] is False)
        check('★ 候选区读不到 ⇒ 同样不表态',
              judge('cf/101999_someone.json', tmp, {'packed': {'101775'}, 'candidates': None,
                                                   'roster': None})['tier'] == KEEP)
        check('★ 花名册读不到 ⇒ 同样不表态',
              judge('cf_contest/history_Gone.json', tmp, {'packed': None, 'candidates': None,
                                                          'roster': None})['tier'] == KEEP)
        # 三档的名字只有一份（防"报出来一档、判的是另一档"）
        check('★ 三档的名字就是 TIERS 那三个', tuple(t) == TIERS and KEEP in TIERS)

        # ---- 其余平台的声明范围（2026-10-17 补：之前只盘 cf 那个缓存目录）----
        w('03 PTA/PTA_rankings.json', '{}')                       # 清单点名 ⇒ 进包
        w('03 PTA/other.json', '{}')                              # 没人点名 ⇒ 保留
        w('21hdu/21hdu1/hdu_cid984_problems.json', '{}')           # 杭电清单里有 ⇒ 进包
        w('24hdu/24hdu4/hdu_cid1124_problems.json', '{}')          # 只在归档多校里 ⇒ 保留（有依据）
        w('99hdu/99hdu1/hdu_cid777_problems.json', '{}')           # 两边都不在 ⇒ **仍然保留**（安全阀）
        w('cache/nk/nk_cid123_problems.json', '{}')                # 牛客索引里有 ⇒ 进包
        w('cache/nk/nk_cid456_problems.json', '{}')                # 不在索引 ⇒ 保留
        w('01nk-mirror/nk_cid123_problems.json', '{}')             # ⚠️ 不在 cache/nk ⇒ 判据不管（保留）
        f2 = dict(f)
        f2['manifest'] = {os.path.normcase(os.path.abspath(os.path.join(tmp, '03 PTA/PTA_rankings.json')))}
        f2['hdu_packed'] = {'984'}
        f2['hdu_candidates'] = {'984', '1124'}
        f2['nk_index'] = {'123'}
        got2 = census(tmp, f2)
        t2 = got2['tiers']
        packed2, keep2 = set(t2['进包']), set(t2[KEEP])
        unk2 = set(got2['unstated'])
        check('清单点名的文件 ⇒ 进包（其余平台也照这一条）',
              '03 PTA/PTA_rankings.json' in packed2 and '03 PTA/other.json' in keep2)
        check('杭电：清单里有 ⇒ 进包', '21hdu/21hdu1/hdu_cid984_problems.json' in packed2)
        check('杭电：只在归档多校里 ⇒ 保留（有依据）',
              '24hdu/24hdu4/hdu_cid1124_problems.json' in keep2
              and '24hdu/24hdu4/hdu_cid1124_problems.json' not in unk2)
        check('★ 杭电：两边都不在也保留（清单是出包时才补的，不许据此删刚抓的原料）',
              '99hdu/99hdu1/hdu_cid777_problems.json' in keep2
              and '99hdu/99hdu1/hdu_cid777_problems.json' in unk2)
        check('牛客：索引里有 ⇒ 进包', 'cache/nk/nk_cid123_problems.json' in packed2)
        check('牛客：不在索引 ⇒ 保留（**表态**，不是"没判据"）',
              'cache/nk/nk_cid456_problems.json' in keep2
              and 'cache/nk/nk_cid456_problems.json' not in unk2)
        check('★ 名字撞了不算同一件事：`01 nk/` 手存路的那份判据不管（保留）',
              '01nk-mirror/nk_cid123_problems.json' in keep2
              and '01nk-mirror/nk_cid123_problems.json' in unk2)
        check('★ 清单读不到 ⇒ 那条判据不表态（绝不会因此判进包）',
              judge('03 PTA/PTA_rankings.json', tmp, {**f2, 'manifest': None})['rule'] != 'manifest-file'
              and judge('03 PTA/PTA_rankings.json', tmp, {**f2, 'manifest': None})['tier'] != '不保留')
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    if bad:
        for b in bad:
            print('  ❌ %s' % b)
        return 1
    print('✅ 原料三档自测通过：%d 项（三档正反 ＋ 两条安全阀 ＋ 九种声明范围：清单点名 / cf gym / '
          'cf 花名册 / 杭电 / 牛客 / cf 比赛页 / xcpcio 目录 / atcoder / 不是原料的产物）' % ok)
    return 0


if __name__ == '__main__':
    import sys
    if '--selftest' in sys.argv:
        sys.exit(selftest())
    print(facts_label(facts()))
