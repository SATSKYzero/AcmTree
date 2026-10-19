#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
xcpcio 榜单 → crate 片段（**权威 ratio 源**：正式 + 打星同一口径）

口径
----
> **xcpcio 是最权威的 ratio 源**（分正式/打星），PTA 其次。

所以这个适配器是 `board` 角色：C 的赛名 / 开赛时间 + **每题 ratio** 都由它出。
（题名它给不了 —— 见下。）

xcpcio/board-data 里有什么（实测 448 场）
---------------------------------------------------
    <系列>/<届次>/<站点>/config.json   赛名 / 开赛时间 / 题号 label（A…M）/ 分组名
    <系列>/<届次>/<站点>/team.json     队伍（`group:["official"]/["unofficial"]`，老数据是 `official/unofficial` 布尔）
    <系列>/<届次>/<站点>/run.json      逐条提交 {team_id, problem_id, timestamp, status, language}

⚠️ **它没有题名**：`config.json` 的 `problems[]` 只有 `id` / `label` / 气球颜色。
   所以"接 xcpcio 能补 123 道缺题名"这句**不成立** ——
   题名还是得靠 srk / rankland 索引 / QOJ。

ratio 口径（与 HDU / 牛客 / PTA / srk **一致**）
-----------------------------------------------
    ratio = 过这题的队伍数 / 有效队伍数 × 100
    有效队伍数 = **至少过 1 题**的队伍数（不是榜上总队伍数）

两点实测得来的细节：

1. **按 (队伍, 题目) 去重**。同一个队对同一题可能有多条 `CORRECT`（重测/补交/重复导入），
   直接数 run 会把 ratio 算过 100%（实测 CCPC 2025 郑州：某题数出 296 > 292 支有效队伍）。
2. **正式 + 打星都算**。xcpcio 自己的 group 只用来**标注**，
   不参与分子分母 —— 这样和 PTA/CF 的口径才可比。
   （实测郑州站：只算正式 250 支，全算 292 支。）

用法
----
    python xcpcio_adapter.py ccpc2025zhengzhou                # board 角色
    python xcpcio_adapter.py ccpc2025zhengzhou --role index   # 只出 config 里的赛名/时间/题号
    python xcpcio_adapter.py --match-report                   # 报告各场对到哪个目录（不写片段）
"""

from __future__ import annotations

import argparse
import collections
import json
import os
import re
import sys
import urllib.error
import urllib.request

sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, 'lib'))
sys.path.insert(0, os.path.abspath(os.path.join(HERE, '..', 'lib')))   # Scaper/lib（通用读取层）

from read_modes import print_stats, add_cli_args, configure_from, should_refetch  # noqa: E402
from xcpc_common import (add_crate_path,  # noqa: E402
    CACHE, contest_key, find_contest, fmt_ratio, layers_of, load_manifest, mid_key,
    norm_letter, open_tree, platform_key, problem_key, read_json, read_json_cached, rel, series_key,
    xcpc_nature,
)

sys.path.insert(0, os.path.join(HERE, 'lib'))
from match import name_tokens, overlap  # noqa: E402

add_crate_path()

from crate import Crate, link_kinds  # noqa: E402

LABEL = 'xcpcio 榜单'
SOURCE = 'xcpcio'          # 它那棵树：`aux-xcpcio`
TREE = os.path.join(CACHE, 'xcpcio_tree.json')
RAW = 'https://raw.githubusercontent.com/xcpcio/board-data/main/'
CDN = 'https://cdn.jsdelivr.net/gh/xcpcio/board-data@main/'
#: 取这份仓库文件的**多路兜底**（顺序 = 实测的"快且能用"，理由见 `fetch_raw()` 的注释）。
#  ⚠️ 两根老镜子（`cdn` / `raw`）在国内网络**都不可用**（10054 / 61s 后被重置）——
#     这份名单是**唯一**一份（`build_xcpcio_index.py` 那边同样顺序，改一处要顺手看另一处）。
RAW_MIRRORS = (
    'https://fastly.jsdelivr.net/gh/xcpcio/board-data@main/',
    'https://gcore.jsdelivr.net/gh/xcpcio/board-data@main/',
    CDN,
    RAW,
)
AC_STATUS = ('CORRECT', 'ACCEPTED', 'OK')

# 队伍状态：xcpcio 新数据用 group 数组，老数据用布尔
def is_unofficial(team: dict) -> bool:
    groups = [str(g).lower() for g in (team.get('group') or [])]
    if groups:
        return 'unofficial' in groups or 'star' in groups
    return bool(team.get('unofficial'))


# 本项目 slug 里的**缩写** → xcpcio 目录名里的词。
# 为什么需要：rankland 的省赛 slug 用缩写（`zjcpc21st`），xcpcio 的目录用省份（`zhejiang`），
# 两边一个字母都不重合（实测：不建这张表，省赛 30 多场全对不上）。
# 只列**实际用到的**；拼写按 xcpcio 目录里的原样写（`henan` / `henan-icpc` 两种都有）。
SITE_ALIAS = {
    'bj': 'beijing', 'bjcpc': 'beijing',
    'cqcpc': 'chongqing',
    'gdcpc': 'guangdong',
    'gxcpc': 'guangxi',
    'haccpc': 'henan', 'haicpc': 'henan',
    'hbcpc': 'hubei', 'hecpc': 'hebei', 'hlcpc': 'heilongjiang', 'hncpc': 'hunan',
    'jlcpc': 'jilin', 'jscpc': 'jiangsu', 'jxcpc': 'jiangxi',
    'lncpc': 'liaoning', 'ne': 'northeastern', 'northeastcpc': 'northeastern',
    'northeast': 'northeastern',
    'sccpc': 'sichuan', 'sdcpc': 'shandong', 'shcpc': 'shanghai', 'zjcpc': 'zhejiang',
    'xi_an': 'xian', 'xian': 'xian',
    # 专场/网络赛：slug 里的词和 xcpcio 目录名不是一回事
    'ladies': 'girl', 'girls': 'girl',
    'hv': 'gaozhi', 'vocational': 'gaozhi',
    'preliminary': 'online-qualification',
}

# xcpcio 目录里 `season` 是届次（`11th`）还是年份（`2025`）都要认


def _ordinal(text: str) -> int | None:
    m = re.search(r'(\d+)(st|nd|rd|th)', str(text or ''))
    return int(m.group(1)) if m else None


def slug_tokens(slug: str) -> list[str]:
    """
    把 slug 拆成"可能的站点词"，**黏在一起的部分也要拆开**。

        ccpc2025zhengzhou    → ccpc2025zhengzhou / ccpc / zhengzhou
        bjcpc2024            → bjcpc2024 / bjcpc            （省赛缩写 + 年）
        zjcpc21st            → zjcpc21st / zjcpc / zjcpc    （届次写法）
        sccpc17th            → sccpc17th / sccpc
        icpc2024preliminary-2→ icpc2024preliminary / preliminary / 2

    ⚠️ 只按 `-`/`_` 切、再补一个"字母+届次"的正则不够：`bjcpc2024`、`ccpc2022hv`
    （高职）、`shcpc2025` 这些**全都拆不出站点词**（实测踩到，几十场匹配不上）。
    """
    out = []
    for part in re.split(r'[-_]', str(slug or '').lower()):
        if not part:
            continue
        out.append(part)
        m = re.match(r'^([a-z]+)(\d+)(st|nd|rd|th)$', part)     # `zjcpc21st` → `zjcpc`
        if m:
            out.append(m.group(1))
            continue
        # 数字（年份/规模）前后的字母段都算候选：`bjcpc2024`→`bjcpc`、`ccpc2022hv`→`hv`
        for chunk in re.findall(r'[a-z]+', part):
            out.append(chunk)
        for seg in re.split(r'\d{2,}', part):                   # 年份两侧
            seg = seg.strip('-_')
            if len(seg) >= 2:
                out.append(seg)
    return out


# ================================================================
# 索引 / 匹配
# ================================================================

def load_tree() -> list:
    if not os.path.isfile(TREE):
        sys.exit(f'❌ 没有 {rel(TREE)} —— 先跑 build_xcpcio_index.py')
    return read_json_cached(TREE).get('contests') or []


# 届次 → 年份：xcpcio 的 `season` 对 icpc/ccpc 写的是届次（`11th`）。
# 实测（448 场）这不是"差 1 年"的模糊关系，而是**闭式**：
#     ccpc 第 n 届 = 2014 + n   （8th=2022、9th=2023、10th=2024、11th=2025、12th=2026）
#     icpc 第 n 届 = 1975 + n   （46th=2021、47th=2022、48th=2023、49th=2024、50th=2025、51st=2026）
# 表里的少数例外全是"决赛/总决赛在次年办"或名称里的年份印错（ccpc 第 8 届有 1 场写 2023），
# 所以下面仍然允许 ±1 年的差。
_ORD_BASE = {'ccpc': 2014, 'icpc': 1975,
             'provincial-contest': 0, 'camp': 0}


def season_year(series: str, season: str) -> str:
    """`('ccpc','11th')` → `'2025'`；`season` 本来就是年份就直接返回；认不出返回 ''"""
    s = str(season or '').lower()
    if re.match(r'^(?:19|20)\d{2}$', s):
        return s
    o = _ordinal(s)
    base = _ORD_BASE.get(str(series or ''))
    if o and base:
        return str(base + o)
    return ''


def _site_words(entry: dict, tree_sites: set) -> set:
    """
    这一场的 slug 里，**哪些词是"站点类型"的**（对应 xcpcio 的目录名）。

    `ccpc2025zhengzhou` 的 `zhengzhou` 是站点；`zjcpc21st` 的 `zjcpc` 是省份缩写；
    `ccpc2025ladies` 的 `ladies` 是专场名；`northeastcpc20th` 的 `northeastcpc` → `northeastern`。

    站点名与 slug 词**一律先去符号再比**：目录里写 `xi_an`、slug 里也写 `xi_an`，
    但有的地方是 `xian`，所以 `re.sub` 之后再查表。

    ⚠️ ★ **带分隔符的别名要另走一条**（实测踩到，2026-10-15：ICPC 47th / 48th / 50th
       西安站**整场拿不到 xcpcio 榜单**）：`slug_tokens()` 先把 slug 按 `-`/`_` **切开**，
       于是 `icpc2022xi_an` 的词是 `['icpc2022xi','icpc','xi','an',…]` —— **`xi_an` 这个词
       再也不会出现** ⇒ 别名表里那条 `'xi_an': 'xian'` **永远命中不了**（死代码）⇒ 站点词为空；
       而"退到赛名重合 ≥ 50%"那条路又拿不到赛名（注册表条目的 `name` 常是 `None`，赛名只在
       rankland 标题里）⇒ `match_entry()` 直接报"没有系列=icpc、年份≈… 且站点/赛名能对上的目录"。
       ⇒ 对**别名表里带 `-`/`_` 的键**（`xi_an`）改成在**原 slug** 上用 `xi[-_]?an` 这种正则找。
       ⚠️ **不**对单段键（`ne` / `hv` / `bj`）做子串匹配 —— 两字母键会把 `online` 之类误伤成
       `northeastern`。
    """
    out = set()
    slug = str(entry.get('_slug') or '')
    for t in slug_tokens(slug):
        flat = re.sub(r'[^a-z0-9]', '', t)
        if flat in SITE_ALIAS:
            out.add(SITE_ALIAS[flat])
        elif flat in tree_sites:
            out.add(flat)
    for key, value in SITE_ALIAS.items():
        parts = re.split(r'[-_]', key)
        if len(parts) < 2:                    # 单段键照旧走上面那条（别做子串匹配）
            continue
        # ⚠️ **右边界必须落在词尾**（`(?=[-_]|$)`）：站点词在 slug 里是**尾巴**，
        #    不锚右边界的话 `xi[-_]?an` 会把 **`xiangtan`（湘潭）** 也当成 `xian`
        #    —— 实测那就顺手把一场**人判过"不导"**的场次新指派了（湘潭那场）。
        pat = r'[-_]?'.join(re.escape(p) for p in parts) + r'(?=[-_]|$)'
        if re.search(pat, slug.lower()):
            out.add(value)
    return {w for w in out if w}


def _series_candidates(entry: dict, idx_info: dict | None = None) -> list[str]:
    """
    这场可能落在 **xcpcio 的哪些顶层目录**下（按优先级，去重）。

    为什么要"可能多个"：**省赛与邀请赛合成一个系列**（`provincial-invitational`），
    但 xcpcio 里这两类**在不同目录**：
      * 纯省赛 → `provincial-contest/…`；
      * 邀请赛 → `icpc/<届次>/<站点>-invitational` 或 `ccpc/<届次>/<站点>-invitational`
        （rankland 也是这么放的，分类原样继承）。
    所以不能只拿本项目自己的系列名去找目录，要按"这场大概是什么"给一串候选：

      1. 纯省赛（slug 里没 `invitational`）→ 直接 `provincial-contest`（不用猜）；
      2. 邀请赛 → **先按 rankland 索引的路径前缀**（`official/icpc/…` / `official/ccpc/…`
         / `official/provincial/…`）给出真正的目录，再把 `provincial-contest` 放最后兜底
         （索引里没有、赛名也认不出归属时，它至少有省赛目录可比）。
    """
    slug = str(entry.get('_slug') or entry.get('slug') or '').lower()
    inv = 'invitational' in slug
    out: list[str] = []
    if not inv:
        return ['provincial-contest'] if _series_id(entry, idx_info) in (
            'provincial', 'provincial-invitational', 'other') else [_series_id(entry, idx_info)]

    repo = str((idx_info or {}).get('repoPath') or '')
    m = re.match(r'^official/(icpc|ccpc|provincial)/', repo)
    if m:
        out.append('provincial-contest' if m.group(1) == 'provincial' else m.group(1))
    # 兜底：赛名/身份里带 ICPC/CCPC 字样就能认（rankland 没收录时也有救）
    hay = f"{slug} {entry.get('name') or ''} {(idx_info or {}).get('title') or ''}".upper()
    if 'CCPC' in hay:
        out.append('ccpc')
    elif 'ICPC' in hay:
        out.append('icpc')
    out.append('provincial-contest')
    seen, uniq = set(), []
    for x in out:
        if x and x not in seen:
            seen.add(x)
            uniq.append(x)
    return uniq


def _series_id(entry: dict, idx_info: dict | None = None) -> str:
    """
    系列 id。**三种形状都要认**（实测每种都踩到过）：

    * 注册表里是字符串 `"ccpc"`；
    * 清单（`xcpc_contests.json`）里是对象 `{"id": "ccpc", "name": "CCPC"}`；
    * 两条都没有时，从 slug 前缀认（`ccpc2023shenzhen` → ccpc）——
      实测注册表里有 5 条既没写 series 也没写 year。
    """
    s = entry.get('series')
    sid = str(s.get('id') or '') if isinstance(s, dict) else str(s or '')
    if not sid:
        slug = str(entry.get('_slug') or entry.get('slug') or '').lower()
        m = re.match(r'^(ccpc|icpc|ucup)', slug)
        if m:
            sid = m.group(1)
        elif re.match(r'^[a-z]{1,3}cpc\d', slug) or re.match(r'^(northeast|sccpc)', slug):
            sid = 'provincial'          # zjcpc21st / gdcpc20th / northeastcpc18th
    if not sid and idx_info:
        sid = str(idx_info.get('series') or '')
    return sid


def _entry_years(entry: dict, idx_info: dict | None = None) -> set:
    """
    这一场可能的年份（**按可信度分层**）：

    1. slug 里的年份（`ccpc2025zhengzhou`）＋ 注册表 `year` —— 最可信；
    2. 两者都空时才看赛名/索引标题（`haccpc6th` 的赛名里有 2024）；
    3. 索引的 `startAt`（实测注册表里 18 条 `year` 为空，而索引里**全都有** `startAt`）。

    ⚠️ 第 2、3 条**不能无条件并进第 1 层**：赛名里常带"赛季年"或历史沿革
    （`icpc2021ecfinal` 标题写「第 46 届…（2022）」，索引 startAt 又是 2022-07），
    混进来会让年份差算出 2，把正确的候选过滤掉（实测踩到）。
    """
    strong = set(re.findall(r'(?:19|20)\d{2}', str(entry.get('_slug') or '')))
    if entry.get('year'):
        strong.add(str(entry['year']))
    if strong:
        return strong
    out = set()
    info = idx_info or {}
    # 索引 startAt / 标题比注册表空着的 year 可靠得多（18 条省赛 slug 里没有年份）
    out |= set(re.findall(r'(?:19|20)\d{2}', str(info.get('startAt') or '')))
    out |= set(re.findall(r'(?:19|20)\d{2}', str(info.get('title') or '')))
    return out


def path_year(entry: dict) -> int | None:
    """xcpcio 目录条目自己的年份：路径里的年份（`2018/qingdao`）或赛名里的"""
    for src in (str(entry.get('path') or ''), str(entry.get('name') or '')):
        m = re.search(r'(?:19|20)\d{2}', src)
        if m:
            return int(m.group(0))
    eyear = season_year(entry.get('series'), entry.get('season'))
    return int(eyear) if eyear else None


def _entry_ordinals(entry: dict, idx_info: dict | None = None) -> set:
    """
    这一场可能的**届次**（`zjcpc19th` → 19）。

    省赛 slug 用的是届次、不是年份（`第十五届吉林省大学生程序设计竞赛`），
    而 xcpcio 目录有时只给年份（`2021/jilin`）、有时只给届次（`11th/...`），
    所以两边都要能对上（实测踩到：只看年份，`jlcpc17th` 会被指到第 18 届那场）。

    ⚠️ 只认**真届次**：`ccpc2025ladies` 里的 `2025` 不是届次。
    只用 `(\\d+)(st|nd|rd|th)\\b` 会把 `2025th…` 这种当届次，
    于是 `entry_ords` 里混进 2025，把真正的 50 届（`第 50 届…`）判成"届次不同"而全灭（实测踩到）。
    所以要求序数后缀与末位数字匹配（1st/2nd/3rd/Nth），或者写的是「第 N 届」。
    """
    out = set()
    texts = [str(entry.get('_slug') or ''), str(entry.get('name') or '')]
    info = idx_info or {}
    texts.append(str(info.get('title') or ''))
    for t in texts:
        for m in re.finditer(r'(\d+)(st|nd|rd|th)\b', t, re.I):
            n, suf = int(m.group(1)), m.group(2).lower()
            last = n % 10
            if (last == 1 and suf == 'st') or (last == 2 and suf == 'nd') \
                    or (last == 3 and suf == 'rd') or (last not in (1, 2, 3) and suf == 'th'):
                if n < 1900:                    # 年份不会写序数，届次不会超过这个量级
                    out.add(n)
        m = re.search(r'第\s*(\d+)\s*届', t)
        if m:
            out.add(int(m.group(1)))
    return out


def match_entry(entry: dict, tree: list, verbose: bool = False,
                idx_info: dict | None = None) -> tuple[dict | None, str]:
    """
    注册表条目 → xcpcio 目录条目（**多重证据，缺一不认**）。

    为什么不能只靠赛名：实测光靠 CJK bigram 会把
    `icpc2026preliminary-1` 指到 `ccpc/8th/online-qualification`
    （"中国大学生程序设计竞赛"两边都有，重合率就有 50%）。
    **宁可某一类场次不给 ratio，也不能把 ratio 安到别场上。**

    判据（全部来自"外部世界的标识"，不是感觉）：

        ① 系列   icpc / ccpc / provincial-contest（省赛 ↔ provincial-contest）
        ② 年份   目录 `season`（届次先用闭式换算成年）与 slug/注册表年份差 ≤ 1；
                 省赛的届次直接对上时放宽到 ≤ 2（线上赛/延期会错位）
        ③ 站点   slug 里的站点词（含 `zjcpc→zhejiang` 这类缩写映射）命中目录 `site`
        ④ 场次型 slug 带 `invitational` 就只能对 `*-invitational` 目录；
                 河南省赛 `haccpc`/`haicpc` 分别只对 `henan`/`henan-icpc`；
                 slug 尾号 `-2` 只对 `…-2`
        slug 里**没有**站点词时（`ccpc2022final`）退到赛名重合 ≥ 50%，并要求候选唯一

    @returns (命中的条目, 理由)；没命中时 (None, 理由)
    """
    series = _series_id(entry, idx_info)
    cand_series = _series_candidates(entry, idx_info)
    want = cand_series[0] if cand_series else ''
    if not want:
        return None, '注册表里没写系列'
    years = _entry_years(entry, idx_info)
    if not years:
        return None, '这场没写年份（连 slug 里都没有）—— 不猜'
    entry_ords = _entry_ordinals(entry, idx_info)
    provincial = want == 'provincial-contest'

    # xcpcio 全部目录名（判断 slug 里的词是不是"站点词"）；连字符也去掉再收一份
    all_sites = {str(c.get('site') or '').lower() for c in tree}
    all_sites |= {re.sub(r'[^a-z0-9]', '', s) for s in list(all_sites)}
    all_sites |= {'final', 'wfinal'}
    aliases = _site_words(entry, all_sites)

    slug_l = str(entry.get('_slug') or '').lower()
    slug_flat = re.sub(r'[^a-z0-9]', '', slug_l)
    tail = re.search(r'[-_]([0-9]+)$', slug_l)
    cands = []
    for c in tree:
        if c.get('warmup') or str(c.get('site') or '').endswith('-warm'):
            continue
        # ⚠️ 目录的系列要在**候选集合**里（`_series_candidates` 给的顺序就是优先级，
        #    但这里只判"在不在"）；排序键里有系列优先级，见下面 `key` 的第一项。
        if str(c.get('series') or '') not in cand_series:
            continue
        dir_rank = cand_series.index(str(c.get('series') or ''))
        site = str(c.get('site') or '').lower()
        site_flat = re.sub(r'[^a-z0-9]', '', site)
        hit = {w for w in aliases
               if w == site or site.startswith(w + '-') or w in site_flat
               or re.sub(r'[^a-z0-9]', '', w) in site_flat}
        if aliases and not hit:
            continue
        # 目录里 `season` 可能是届次（`11th`）也可能是年份（`2025`）
        eyear = season_year(c.get('series'), c.get('season'))
        tord = _ordinal(c.get('season')) or _name_ordinal(c.get('name'))
        ord_hit = bool(tord and tord in entry_ords)
        if provincial and tord and entry_ords and tord not in entry_ords:
            continue
        gap = None
        if eyear and years:
            gap = min(abs(int(eyear) - int(x)) for x in years)
            tol = 2 if (provincial and ord_hit) else 1
            if gap > tol:
                continue
            # 省赛：**年份不一致时，必须有届次对上才认**。
            # 省赛是一年一届，年份差 1 就是"另一届"（`bjcpc2025` 不该指到 2024 北京；
            # `jxcpc2025` 不该指到 2024 江西）——那些场次 xcpcio 没收录，宁可不给 ratio。
            if provincial and gap and not ord_hit:
                continue
        # 场次型：邀请赛 / 河南省赛的 icpc / 题号尾号
        if ('invitational' in slug_l) != ('invitational' in site):
            continue
        if 'henan' in site and ('icpc' in site) != ('icpc' in slug_l):
            continue
        if tail:
            nums = re.findall(r'\d+', site) or re.findall(r'\d+', site_flat)
            if nums and tail.group(1) not in nums:
                continue
        inter, score = overlap(name_tokens(str(entry.get('name') or '')),
                               name_tokens(str(c.get('name') or '')))
        if not hit and score < 0.5:
            continue
        exact_site = 0 if (site_flat and slug_flat.endswith(site_flat)) else 1
        # 年份无从对照时（省赛只给届次）用**近年优先**，且与"已知年份"越近越好
        near = 9
        if gap is None:
            py = path_year(c)
            near = abs(py - max(int(y) for y in years)) if py else 9
        key = (dir_rank, 0 if hit else 1, exact_site, 0 if gap == 0 else 1,
               gap if gap is not None else 9, near, -score, -inter)
        why = (f'站点词命中（{"、".join(sorted(hit))}）' if hit
               else f'赛名重合 {inter} 词 / {score:.0%}')
        cands.append((key, c, bool(hit), gap, why, score, tord))

    if not cands:
        return None, (f'xcpcio 里没有系列={want}、年份≈{sorted(years)}'
                      f'且站点/赛名能对上的目录')
    if verbose:
        for c in sorted(cands, key=lambda x: x[0])[:6]:
            print(f"      候选 {c[1]['path']}  key={c[0]}  {c[4]}")

    cands.sort(key=lambda c: c[0])
    best = cands[0]
    # 并列（站点/精确度/年份档都相同）时：
    # ① **年份差更小的赢** —— `hbcpc4th`(2022) 面对 2023/hubei 与 2024/hubei 时选 2023；
    # ② 再比赛名，差得明显（≥25%）就按赛名选；
    # ③ 省赛且届次也相同 → 同一场的重复目录，取第一个；
    # ④ 都不行就**不猜**（宁可这场不出 ratio）。
    ties = [c for c in cands if c[0][:5] == best[0][:5]]
    if len(ties) > 1:
        ties.sort(key=lambda c: (-c[5], c[3] if c[3] is not None else 9))
        near = [c for c in ties if c[3] == ties[0][3]]
        if len(near) == 1:
            best = near[0]
        elif ties[0][5] - ties[1][5] >= 0.25:
            best = ties[0]
        elif provincial and ties[0][6] and ties[0][6] == ties[1][6]:
            best = ties[0]
        else:
            return None, (f'有 {len(ties)} 个并列候选（{", ".join(c[1]["path"] for c in ties[:3])}）'
                          f'—— 不猜，请人工确认')
    c = best[1]
    warn = ''
    if best[3]:                      # 年份差不为 0 → 也可能是"线上赛/延期"，但值得人看一眼
        warn = f'⚠️ 年份差 {best[3]}'
    return c, (f'{best[4]}；{"年份差 " + str(best[3]) if best[3] is not None else "年份无对照"}'
               f'（xcpcio: {c.get("name")}）{warn}')


def _name_ordinal(name) -> int | None:
    """目录名里的「第 N 届」（`第 18 届吉林省…`）"""
    m = re.search(r'第\s*(\d+)\s*届', str(name or ''))
    return int(m.group(1)) if m else None


def context_for(slug: str, manifest: dict) -> tuple[dict, dict | None]:
    """
    匹配与统计所需的**全部上下文**：清单条目 + 注册表条目 + rankland 索引条目。

    为什么不能只用清单：年份、系列这些匹配要用的信息在**注册表**里，而注册表里
    很多场次 `year` 是空的、要靠**索引的 startAt** 补 ——
    只听清单会把已经对好的场次判成"没写年份"（实测踩到，流水线整场跳过）。
    """
    c = find_contest(manifest, slug)
    e = dict(c)
    reg_path = os.path.join(HERE, 'xcpc_registry.json')
    if os.path.isfile(reg_path):
        # ⚠️ 注册表里很多字段是 `None`（"用 rankland 索引里的值"）——
        # 直接 update 会把清单里已经渲染好的赛名盖成 None；
        # 而 `series` 在注册表里是**字符串**、清单里是**对象**（`layers_of` 要用对象），
        # 所以这两个键一律以清单为准（实测两种都踩到）。
        for k, v in (read_json_cached(reg_path).get('contests', {}).get(slug) or {}).items():
            if k in ('series', 'mid'):
                continue
            if v not in (None, '', [], {}):
                e[k] = v
    e['_slug'] = slug
    idx_path = os.path.join(CACHE, 'rankland_index.json')
    info = None
    if os.path.isfile(idx_path):
        info = (read_json_cached(idx_path).get('bySlug') or {}).get(slug)
    return e, info


# ================================================================
# 原始文件（带缓存）
# ================================================================

def fetch_raw(path: str) -> bytes:
    """
    取一个仓库文件：**先几面 CDN、最后 raw**（有的网络下 raw 会被重置）；都没有就报错。

    ⚠️ ★ **镜像顺序是实测定的，别改回"cdn → raw"两条**（2026-10-15 实测，ICPC 47th 西安站
       的 `run.json` 838 KB）：

       | 镜子 | 结果 |
       |---|---|
       | `fastly.jsdelivr.net` | ✅ 838 KB / **2.1 s**（381 KB/s） |
       | `gcore.jsdelivr.net` | ❌ WinError 10054（连接被强行关闭） |
       | `cdn.jsdelivr.net` | ❌ WinError 10054 |
       | `raw.githubusercontent.com` | ❌ 61 s 后被重置（另一台机器上是"1 KB 要 21 s"） |

       ⇒ 旧的那两条（`cdn` / `raw`）**在这台机器上一条都不通** ⇒ 这一份榜单一直下不来
       （表现为 `RuntimeError: 取不到 …/run.json：The read operation timed out`）。
       同样的结论在 `build_rankland_index.py` 的镜像表里早就写过（"raw 国内必被重置；
       fastly 快且省流量"）—— 这里照那个顺序抄。
    """
    last = None
    for base in RAW_MIRRORS:
        try:
            req = urllib.request.Request(base + path, headers={'User-Agent': 'acm-tree/xcpc'})
            with urllib.request.urlopen(req, timeout=180) as r:
                return r.read()
        except (urllib.error.URLError, OSError, ValueError) as e:   # noqa: PERF203
            last = e
    raise RuntimeError(f'取不到 {path}：{last}')


_MIN_BYTES = {'config.json': 50, 'run.json': 2, 'team.json': 2}


def local_file(path: str, name: str) -> str:
    """
    把 `<配置目录>/<name>` 拉到 `cache/xcpcio/<路径>/<name>`。

    **有缓存就用缓存**（全下下来后就别再下了）——
    要不要重下交给通用层的 `should_refetch`：`--force`（把缓存当不存在）
    或 `--cache-mode none`（不读缓存）时会重下，流水线默认都不带。
    ⚠️ 全仓 run.json 有 368 MB ⇒ `--force` 是"真重下"，`--cache-mode none` 更狠（每场都重下）。
    缓存文件先做"像不像一份完整 JSON"的自检（原子写，半截文件不会留下），
    不合格才重下。
    """
    out = os.path.join(CACHE, 'xcpcio', *path.split('/'), name)
    if not should_refetch(_cached_ok(out, name)):
        return out
    raw = fetch_raw(f'{path}/{name}')
    if len(raw) < _MIN_BYTES.get(name, 2):
        raise RuntimeError(f'{path}/{name} 只有 {len(raw)} 字节，不像一份完整文件')
    os.makedirs(os.path.dirname(out), exist_ok=True)
    tmp = out + '.part'                     # 先写临时文件再改名：中断不会留下半截文件
    with open(tmp, 'wb') as f:
        f.write(raw)
    os.replace(tmp, out)
    return out


def _cached_ok(path: str, name: str) -> bool:
    """缓存文件存在、够大、且（对 JSON 而言）能被解析"""
    if not os.path.isfile(path) or os.path.getsize(path) < _MIN_BYTES.get(name, 2):
        return False
    try:
        read_json(path)
    except (ValueError, OSError):
        return False
    return True


# ================================================================
# 统计
# ================================================================

def analyze(path: str, cfg: dict) -> dict:
    """
    这一场的统计：有效队伍数、每题的过队数、正式/打星分布。

    分子分母都来自同一份 `run.json`（与 PTA/srk 的做法一致）。
    """
    labels = {str(p.get('id')): norm_letter(p.get('label')) for p in (cfg.get('problems') or [])}
    rp = local_file(path, 'run.json')
    tp = local_file(path, 'team.json')
    runs = read_json(rp)
    teams = read_json(tp)

    uno = set()
    for t in teams if isinstance(teams, list) else []:
        if not isinstance(t, dict):
            continue
        tid = str(t.get('id') if t.get('id') is not None else t.get('team_id') or '')
        if tid and is_unofficial(t):
            uno.add(tid)

    accepted = set()
    for r in runs if isinstance(runs, list) else []:
        if not isinstance(r, dict):
            continue
        if str(r.get('status') or '').upper() not in AC_STATUS:
            continue
        tid = str(r.get('team_id') or '')
        pid = str(r.get('problem_id') or '')
        if tid and pid:
            accepted.add((tid, pid))

    solved: collections.Counter = collections.Counter()
    for _tid, pid in accepted:
        solved[pid] += 1
    effective = {tid for tid, _pid in accepted}
    unofficial_eff = {t for t in effective if t in uno}

    return {
        'path': path,
        'labels': labels,
        'teams': len(teams) if isinstance(teams, list) else 0,
        'unofficial': len(uno),
        'effectiveTeams': len(effective),
        'officialOnly': len(effective) - len(unofficial_eff),
        'solved': {labels.get(pid, pid): n for pid, n in solved.items()},
        'runs': len(runs) if isinstance(runs, list) else 0,
    }


def report(contest: dict, stats: dict, role: str) -> list[str]:
    lines = [f"   {contest.get('name')}  |  xcpcio: {stats['path']}"]
    if role == 'index':
        lines.append(f"   config 里的赛名：{(contest.get('_cfg') or {}).get('contest_name')}")
        return lines
    lines.append(f"   队伍 {stats['teams']}（打星 {stats['unofficial']}）｜"
                 f"有效队伍（至少过 1 题）= {stats['effectiveTeams']}"
                 f"（其中正式 {stats['officialOnly']}）｜run {stats['runs']} 条")
    for letter in sorted(stats['labels'].values()):
        n = stats['solved'].get(letter, 0)
        lines.append(f"   {letter:>2}: 过队 {n:>5} → ratio "
                     f"{fmt_ratio(n, stats['effectiveTeams']):>6}%")
    return lines


# ================================================================
# 片段
# ================================================================

def build(contest: dict, entry: dict, stats: dict, role: str) -> Crate:
    slug = contest['slug']
    series, mid = layers_of(contest)
    cfg = contest.get('_cfg') or {}

    crate = Crate(source_id=f'xcpcio-{slug}', label=LABEL, platform=SOURCE,
                  kind=('board' if role == 'board' else 'script'))
    # 骨架：O ─(W)aux「辅助节点」─(W)aux-xcpcio
    open_tree(crate, SOURCE)
    parent = series_key(series['id'])
    crate.series(platform_key(), parent, name=series.get('name') or series['id'])
    if mid:
        mk = mid_key(series['id'], mid['id'])
        crate.series(parent, mk, name=mid.get('name') or mid['id'])
    else:
        mk = parent

    ck = contest_key(slug)
    # ⚠️ 空值一律写 None（`Crate` 丢 None、`""` 会留下占位）
    # xcpcio 给的是**榜单**（它的 C 链接本来就是 `board.xcpcio.com/...`）。
    # 爬取层只**声明类别**，不再自己写 `link`（那是应用层的事）
    # （"数据爬取部分不应该有『存在多值时排除一些值』的逻辑"）。
    board_link = (str(entry.get('link') or '') or None)
    # 性质：**这棵树是 xcpcio（收集源），但性质按"这是哪家的比赛"写** ——
    # 大类恒为 `xcpc`，小类只认 1:1 的 icpc/ccpc 系列，年份取清单里的 mid，地区留空。
    # 判据全文与"为什么收集源不算性质"见 `xcpc_common.xcpc_nature()` 的注释。
    crate.contest(mk, ck,
                  name=(str(cfg.get('contest_name') or '') or None),
                  contestTime=(str(entry.get('startAt') or '') or None),
                  kind='contest',
                  **xcpc_nature(series, mid, contest.get('name') or '', channel='xcpcio',
                                held_time=str(entry.get('startAt') or '')),
                  **link_kinds(('board', board_link)))

    for pid, letter in stats['labels'].items():
        if not letter:
            continue
        kwargs = {'problem_id': letter}
        if role == 'board':
            kwargs['ratio'] = fmt_ratio(stats['solved'].get(letter, 0), stats['effectiveTeams'])
        crate.problem(ck, problem_key(slug, letter), **kwargs)
    return crate


def main(argv):
    ap = argparse.ArgumentParser(description='xcpcio 榜单 → crate 片段')
    ap.add_argument('slug', nargs='?')
    ap.add_argument('-o', '--output', default='')
    ap.add_argument('--role', choices=('board', 'index'), default='board',
                    help='board=出 C+P.ratio（默认）；index=只出赛名/时间/题号')
    ap.add_argument('--manifest', default='')
    ap.add_argument('--path', default='', help='直接指定 xcpcio 目录（跳过匹配）')
    ap.add_argument('--letters', action='store_true',
                    help='**只打印题号**（逗号分隔），给流水线喂给 rankland-index 补空壳 P 用')
    ap.add_argument('--match-report', action='store_true',
                    help='报告清单里每场对到哪个 xcpcio 目录（不写片段）')
    add_cli_args(ap)                  # --cache-mode/--retry-mode/--force（通用层）
    args = ap.parse_args(argv)
    configure_from(args)              # 必须在下面任何读缓存/联网之前

    tree = load_tree()
    manifest = load_manifest(args.manifest)

    if args.match_report:
        # ⚠️ 用**注册表**的条目，不是清单的：年份（`year`）在注册表里，
        # 清单里只有渲染好的层级；只拿清单时，省赛全都"没写年份"匹配不上（实测踩到）。
        hit = 0
        warn = []
        for c in manifest['contests']:
            key = c['slug']
            e, info = context_for(key, manifest)
            found, why = match_entry(e, tree, idx_info=info)
            if found:
                hit += 1
                py = path_year(found)
                ey = _entry_years(e, info)
                mark = ''
                if py and ey and min(abs(py - int(y)) for y in ey) > 1:
                    mark = '   ← ⚠️ 年份对不上，请人工核对'
                    warn.append((key, found['path'], sorted(ey), py))
                print(f"✓ {key:<34} → {found['path']}{mark}")
                print(f"    {why}")
            else:
                print(f"✗ {key:<34}   （{why}）")
        print(f'\n对上 {hit}/{len(manifest["contests"])} 场'
              f'（xcpcio 目录里没有的场次不会出 ratio，保持原样）')
        if warn:
            print(f'\n⚠️ 有 {len(warn)} 场的年份对不上（可能认错场，也可能只是"赛季年 vs 次年办"）：')
            for key, path, ey, py in warn:
                print(f'   {key:<34} → {path}   我们 {ey} / 目录 {py}')
        return 0

    if not args.slug:
        print('要给一个 slug（或用 --match-report）', file=sys.stderr)
        return 2
    if args.letters:
        # 只报题号：`python xcpcio_adapter.py <slug> --letters`
        # 流水线用它给 rankland-index 补"索引里没有的题"的空壳 P（否则 ratio 挂不上）
        c, _info = context_for(args.slug, manifest)
        e = next((x for x in tree if x['path'] == str((c.get('board') or {}).get('path') or '')), None)
        if not e:
            e, _why = match_entry(c, tree, idx_info=_info)
        if not e:
            return 1
        cfg = read_json(local_file(e['path'], 'config.json'))
        print(','.join(norm_letter(p.get('label')) for p in (cfg.get('problems') or [])
                       if norm_letter(p.get('label'))))
        return 0
    contest, idx_info = context_for(args.slug, manifest)
    entry, why = match_entry(contest, tree, idx_info=idx_info)
    if args.path:
        entry = next((e for e in tree if e['path'] == args.path), None)
    if not entry:
        print(f'❌ {args.slug}：{why}', file=sys.stderr)
        return 1
    print(f'🎯 {args.slug} → {entry["path"]}   （{why}）')
    contest['_cfg'] = read_json(local_file(entry['path'], 'config.json')) \
        if entry.get('configSha') else {}
    stats = analyze(entry['path'], contest['_cfg'])
    print('\n'.join(report(contest, stats, args.role)))

    crate = build(contest, entry, stats, args.role)
    out = args.output or os.path.join(CACHE, f'crate_{args.slug}_xcpcio.json')
    crate.save(out)
    print(f'\n✅ {rel(out)}   {crate.summary()}')
    print_stats('xcpcio')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
