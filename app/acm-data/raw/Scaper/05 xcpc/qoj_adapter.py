#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
QOJ → crate 片段（**QOJ 自己那棵树**）

树（**S 层用 QOJ 自己的分类**）
--------------------------------------------------------------
    O ─(W)qoj ─(S)<QOJ 的分类，逐层，如 ICPC/Regionals/Asia Pacific/…> ─(C)<qoj 场次 id> ─(P)<题目 id> ─(R)<提交 id>

分类路径取自归档的**场次页顶部那条面包屑**（QOJ 自己标的归属）。
真·没挂分类的场次落兜底 S `qoj:s:no-category`（树里 W 不能直接挂 C）。

为什么另起一棵、以及为什么它自足
--------------------------------
QOJ 这一侧的信息本来就是齐的：场次有页面（补题入口链接）、题目有题面链接与题名、
提交有结果/时间/运行信息。所以它**不需要**去挂到主树（榜单/PTA 那棵）的题目上，
也就不必再依赖 rankland 的题目对应表来"找父题目"。

要不要跟主树那场比赛算同一场，**不由导入决定**：两边各自成节点，
用户在「判重整理」页填 `映射元素值`（非空且相等 ⟺ 同一个东西）来绑定。
导入侧**不做任何自动匹配** —— 这是本设计里唯一的一条判定规则。

extKey 拼法
-----------
    平台    qoj
    系列    qoj:s:cat-<分类 id>[:cat-<分类 id>…]   按 QOJ 的分类逐层，如 qoj:s:cat-2:cat-17:cat-21
    比赛    qoj:c:<QOJ 场次 id>                 如 qoj:c:1986
    题目    qoj:c:<场次 id>:p:<题目 id>          如 qoj:c:1986:p:5424
    提交    qoj:c:<场次 id>:sub:<提交 id>

怎么把提交归到这场：清单里写了 `contest`（QOJ 的 contest id，如 1986），
本适配器用题目/提交链接里的 `contest/<ID>` 过滤 —— 同一个文件里可能混着
好几个比赛的提交。

**题号（字母）只是附带信息**：树里的位置按**题目 id** 认，所以拿不到字母表
（`A`/`B`…）时只是 `problemId` 退化成题目 id，提交不会丢。
字母来源优先 `04 qoj` 自己的缓存（自足），其次才退回 rankland 索引。

用法
----
    python qoj_adapter.py icpc2026preliminary-2
    python qoj_adapter.py icpc2026preliminary-2 -o out.json
"""

from __future__ import annotations

import argparse
import os
import re
import sys

sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, 'lib'))

from xcpc_common import (add_crate_path,  # noqa: E402
    CACHE, UPSTREAM_ERROR, finals_layer_of, held_year_of, is_cross_year_leaf, is_ec_name,
    is_provincial_invitational, is_warmup_class, load_manifest, NATURE_REGION_NONE,
    NATURE_REGION_NOT_NEEDED, NATURE_REGION_TBD, norm_letter, phase_of, place_of_name,
    provincial_org_of, PROVINCIAL_SEG, PROVINCIAL_TYPE_NONE, provincial_type_of,
    read_json, read_json_cached,
    REGION_CORE, rel, empty_source_result,
    resolve, root_name_src, stage_of, STAGE_NONE, tree_time_layer, WARMUP_LAYER, YEAR_TO_SYNC,
    year_in_text,
)

# 统一环节模块（`Scaper/lib/stages.py`）：地区这一环节与其他两侧是**同一个模块的不同参数**
import stages as _stages  # noqa: E402
from read_modes import add_cli_args, configure_from  # noqa: E402

add_crate_path()

from crate import SUBMIT_DURING, SUBMIT_AFTER, SUBMIT_VP, Crate, _s, NATURE_SEASON_NONE, NATURE_YEAR_NONE, class_rules, is_relative_time, link_kinds, nature_fields, normalize_status, normalize_time, validate_crate  # noqa: E402

LABEL = 'QOJ'

# ---- QOJ 自己那棵树的骨架（见文件头）----
QOJ_PLATFORM = 'qoj'
QOJ_PLATFORM_NAME = 'QOJ'
# 分类层**就是** QOJ 自己的分类树（严格按 QOJ 的分类来），
# 所以没有"xcpc"那一层。真·没挂分类的场次（如平台用户自建的 `CCPC Final 2025 补题`）
# 才落到这个兜底 S —— 树里 W 不能直接挂 C，兜底是模型要求的，不是脚本给它们安的分类。
QOJ_SERIES = 'qoj:s:no-category'
QOJ_SERIES_NAME = '（QOJ 上没挂分类）'

#: C 的名字一个都拿不到时写这个（"qoj:c:2624 这种无法抓取的，
#: 命名为『获取数据失败』+extKey"）。应用侧会把 extKey 缀在后面显示 ⇒ 树上看到
#: 「获取数据失败（qoj:c:2624）」。留空的话应用只能显示**节点 id**（`n_475880_…`，像乱码）。
QOJ_FETCH_FAILED = '获取数据失败'

# 哪些分类层下面**不该再按地名分层**（把 `Asia East Continent` 下的
# Wuhan / Guangzhou 这类地名层去掉）。规则 = "父层在这个表里 ∧ 子层名字里没有 20xx/19xx
# ⇒ 跳过这一层"（所以带年份的 `The 2017 ACM-ICPC Asia East Regionals` 仍然保留）。
#
# ⚠️ 这两条是**同一件事**（"这一层不承载分类、只承载年份/地点，跳过"）：
#    · **21**（ICPC / Regionals / Asia East Continent）：
#      `https://qoj.ac/category/21` "只按年分、不按城市分" ⇒ 底下的
#      Wuhan / Guangzhou 这类**地名层**去掉。它自带年份的编号层也一并跳过（见 `_place_contest`）。
#    · **212**（Chinese Provincial / Invitational）：**"由于 nature 已填好（包括赛季），分类换为
#      仅赛季一层（同赛季内一样要排序）"** ⇒ 省/市那一层也不建了，场次直接挂 `cat-212` 下、
#      再套一层**赛季**（`natureRegion` 仍在字段里，值不缺）。
# 📌 **记下**：这两支底下的城市/省名，是 `natureRegion` **地区推荐**的天然候选词表
#    （见 `src/core/natureSuggest.js` 末尾那条 TODO）。
QOJ_SITE_LAYER_PARENTS = ('21', '212')

#: 这些分类层**根本不建**：它们只是"阶段"分组，而 XCPC **同一赛区里只按赛季分**。
#: "所有 xcpc 赛制的比赛，同一赛区内只用分赛季，**不应出现任何
#: regional/final**" + "**节点名字不应出现任何 regional/final**，nature 当然不变" ⇒
#: **不要由阶段派生出层**：`17`（ICPC / Regionals，层名就叫 `Regionals`）那一层不建，
#: 赛区层直接挂在 `cat-2`（ICPC）下。
#: ⚠️ 只跳**这一层**：`Finals` 是要建的（只给含多个分赛区的赛区建，见
#: `finals_layer_of`）；`natureClass` 更是一个字不动（那里面 `regional`/`final` 是分类的一部分）。
QOJ_STAGE_LAYERS = ('17',)

#: **Universal Cup 单独一支 `qoj/ucup`**（"新增 qoj/ucup，年份=qoj端比赛时间，
#: 赛季填无"；"ucup 的题目有时很混合" ⇒ 所以 UC **不算 XCPC**）。
#: 判据 = **本节点在 QOJ 的标题**里写着 Universal Cup（标题是 QOJ 自己的元数据，不是猜），
#: **且分类路径没有过 icpc/ccpc** —— 过了的照旧走 `qoj/xcpc/…`（那些有确切的 ICPC 身份，
#: 如 `Stage 23: Shanghai` = EC-Final 2023、`Stage 1: Qingdao` 的路径却只有 Universal Cup）。
#: ⚠️ 别拿这个名字去 CF 那边套：实测有 156 个 C 的标题含 "Universal Cup"，
#:    其中 30 多场是 **CF 的正式轮次**（"Codeforces Round … (Div. 2, based on Universal Cup …)"）——
#:    那些由 CF 适配器按 `filterTypes` 分类，与本条无关。
QOJ_UCUP_CLASS = 'qoj/ucup'
QOJ_UCUP_PATTERN = r'universal cup'

#: QOJ 的 **ICPC 赛区目录名 → 分类里那一段**（缩写表：
#: "https://qoj.ac/category/17，缩写依次为 aa, ec, ap(jp 改 ap), aw, eu, la, na, ne"
#: —— 正是 **ICPC 官方的 8 个赛区**：Africa & Arab / Asia East Continent / Asia Pacific /
#:   Asia West / Europe / Latin America / North America / Northern Eurasia）。
#: 这 300 场里出现过的是前五种（Asia East Continent 228 条路径、Europe 12、North America 3、
#: Asia Pacific 2、Latin America 1）；其余三种先备着（路径里出现就认，Trie 里已经有这一段）。
#: ⚠️ 除 `ec` 之外只有一个别名 `jp` —— `jp` **并进 `ap`**（Japan 是 Asia Pacific
#:    下面的子目录，赛区层面就是 ap）。
QOJ_CONTINENT_SEG = (
    ('africa & arab', 'aa'),
    ('africa and arab', 'aa'),
    ('asia east continent', 'ec'),
    ('asia pacific', 'ap'),
    ('asia west', 'aw'),
    ('europe', 'eu'),
    ('latin america', 'la'),
    ('north america', 'na'),
    ('northern eurasia', 'ne'),
)

CONTEST_RE = re.compile(r'/contest/(\d+)')
PROBLEM_RE = re.compile(r'/problem/(\d+)')
LETTER_RE = re.compile(r'^[A-Z]$')
# 每人"参加过哪些虚拟参赛（VP）"的缓存 —— 提交性质（赛时 / VP）就靠它判
QOJ_VP = os.path.abspath(os.path.join(HERE, '..', '04 qoj', 'cache',
                                      'qoj_vp_contests.json'))
# 场次页「提交时间」列的格式（relative = 参与过 / absolute = 没参与 = 补题）
QOJ_TIMEFMT = os.path.abspath(os.path.join(HERE, '..', '04 qoj', 'cache',
                                           'qoj_contest_timefmt.json'))
def _read_cache(path: str) -> dict:
    if not os.path.isfile(path):
        return {}
    try:
        doc = read_json_cached(path)
    except (ValueError, OSError):
        return {}
    return doc if isinstance(doc, dict) else {}


# 场次名字（QOJ 那棵树的 C 用它）—— 由 `04 qoj/QOJ_submissions_scraper.py --archive`
# 从**归档页**的 `<title>` 里剥出来（不额外抓任何页面，也不借别的渠道的名字）
QOJ_TITLES = os.path.abspath(os.path.join(HERE, '..', '04 qoj', 'cache',
                                          'qoj_contest_titles.json'))
# 该场**全部题目**（含未提交过的）与 QOJ 的**分类面包屑**
# —— 都由 `04 qoj/... --archive` 从归档的场次页里剥出来（不额外抓页面）
QOJ_PROBLEMS = os.path.abspath(os.path.join(HERE, '..', '04 qoj', 'cache',
                                            'qoj_contest_problems.json'))
QOJ_CATEGORIES = os.path.abspath(os.path.join(HERE, '..', '04 qoj', 'cache',
                                              'qoj_contest_categories.json'))
# `--category` 走下来的那棵树：**比赛集合**（系列 ∪ 我提交过的）与每场的分类归属。
# 这是"QOJ 包里该有哪些场次"的唯一出处 —— 与主树清单无关（清单里只有 35 场有 QOJ 提交）。
QOJ_TREE = os.path.abspath(os.path.join(HERE, '..', '04 qoj', 'cache',
                                        'qoj_category_tree.json'))


def tree_contest_ids() -> list:
    """整个 QOJ 包要出的场次（分类树 ∪ 我提交过的；由 04 qoj 的 `--category` 落盘）"""
    ids = _read_cache(QOJ_TREE).get('contests') or []
    return [str(x) for x in ids if str(x).strip()]


def tree_category_path_of(cid: str) -> list:
    """
    场次页抓不到时的**分类归属**（`qoj_category_tree.json` 里"在哪个分类下发现的它"）。

    为什么需要：有的场次在 QOJ 上已经打不开（实测 2624 手动访问也是 403），
    没有场次页就没有面包屑 —— 但它确实挂在某个分类下，不该被塞进"无分类"。
    """
    paths = _read_cache(QOJ_TREE).get('paths') or {}
    got = paths.get(str(cid)) or []
    return got if isinstance(got, list) else []


def contest_problems_of(cid: str) -> dict:
    """`{题目id: {letter, name, link}}`；没有就空（那场只会出提交里出现过的 P）"""
    if not cid:
        return {}
    d = _read_cache(QOJ_PROBLEMS).get(str(cid), {})
    return d if isinstance(d, dict) else {}


def contest_categories_of(cid: str) -> list:
    """QOJ 自己的分类路径 `[[{id, name}, …], …]`（可能有多条路径，见 04 qoj 的解析）；没有就空"""
    if not cid:
        return []
    d = _read_cache(QOJ_CATEGORIES).get(str(cid), [])
    return d if isinstance(d, list) else []


def contest_title_of(cid: str) -> str:
    """
    `qoj_contest_titles.json` 里这场叫什么；没有就返回空（调用方给兜底，见 `contest_names_of`）。

    ⚠️ 这份文件由 **`04 qoj`（`--list` / `--archive`）** 独家维护（归 04），
    形状 `{场次号: {names: [...], title, startAt, duration, difficulty}}`：`title` = 场次页
    `<title>`（最权威），没抓到场次页时退到 `names[0]`（列表页第一个名字）。
    """
    if not cid:
        return ''
    v = _read_cache(QOJ_TITLES).get(str(cid))
    if isinstance(v, dict):
        return str(v.get('title') or (v.get('names') or [''])[0] or '')
    return str(v or '')                       # 老形状（扁平名字）也认


def contest_start_at(cid: str) -> str:
    """
    这场的开赛时间（`qoj_contest_titles.json` 里的 `startAt`；拿不到就是空串）。

    ⚠️ 这份缓存里大部分条目是 `-` / `Not set`（04 的列表页没解析出日期）⇒ **举办年份**大多留空。
    这是**如实**的：QOJ 的分类路径给的是**赛季**，两者不能互相顶替（EC-Final 常跨年）。
    """
    v = _read_cache(QOJ_TITLES).get(str(cid)) if cid else None
    if isinstance(v, dict):
        return str(v.get('startAt') or '')
    return ''


def branch_name_of(cid: str, main_title: str) -> str:
    """
    这一场在 QOJ 的**另一支**叫什么 —— "变体名里不是标题的那个"；没有 ⇒ 空串。

    （看过 `qoj:s:cat-2:cat-17:cat-18` 之后的口径）：
    "这个 ucup 是同场 2 个分类吗? 其实对于这种情况，在脚本树中不同的分支时，是因为所用的
     qoj 路径不同，这时 **qoj 端的命名是不同的，所用的命名也应跟随 qoj**，这样脚本树中的名字统一
     —— 在其他位置也注意这一点"

    实测（`contest_names_of` 的两条就是两套身份）：
      · `qoj:c:1924` 标题 `The 3rd Universal Cup. Stage 31: Wroclaw`
        ＋ 变体 `The 2024 ICPC Central Europe Regional Contest (CERC 2024)`
        ⇒ 它挂在 **Europe / Central Europe** 那一支，就该叫**后者**（前者是 UC 那一支的名字）；
      · `qoj:c:1522` ⇒ `The 2023 ICPC Asia East Continent Final Contest (EC-Final 2023)`（同理）。
    """
    for one in contest_names_of(cid):
        s = str(one or '').strip()
        if s and s != str(main_title or '').strip():
            return s
    return ''


def category_name_of(cid: str, fallback: str = '') -> str:
    """
    分类层的名字：**优先用分类页自己的名字**（`qoj_category_tree.json` 的 `names`），
    没有才退回面包屑里那个（`fallback`）。

    "Qoj 下面的「~」改名为 **qoj 参考名**" ——
    实测 `qoj:s:cat-134` 的层名是面包屑里的 `~`（QOJ 给那一格的**占位写法**），
    而 `https://qoj.ac/category/134` 那一页自己写着 **`Misc`**（`04 qoj` 的
    `category_name_from_html` 取的就是它，见那边的"补祖先分类真名"）。
    """
    t = str((_read_cache(QOJ_TREE).get('names') or {}).get(str(cid)) or '').strip()
    return t or str(fallback or '').strip()


def _regions_with_subregions() -> set:
    """
    哪些**赛区层**底下还留着**子赛区**（决定总决赛要不要单独一层「总决赛」）。

    "eu 赛区有 final 是因为 eu 赛区又含多个分赛区，**final 只在存
    多赛区的 final 时使用**"。判据从**比赛**的分类路径推（`qoj_category_tree.json` 的
    `paths`）：某条路径里 `pid` 后面还跟着一段、**而那一段真的会被建出来**，`pid` 就算
    "含子赛区"。⚠️ 不能拿 `cat_paths`（那只有**抓过的**分类，Europe 那一支不在里面）。

    "会被建出来"= 三个跳过判据都不命中（与 `_place_contest` 里那三条**逐条对应**）：
    阶段层（`QOJ_STAGE_LAYERS`）/ 年份层（层名里带 `19xx|20xx`）/ 地名层（父是站点层）。

    实测：`18`（Europe → Central / Northwestern / Southeastern Europe）✓、`23`（Asia Pacific
    → Japan / Taiwan）✓；`21`（Asia East Continent）底下是城市层 ⇒ 不算；`19` / `430` 没有子类 ⇒ 不算。
    """
    def kept(pid: str, child: dict) -> bool:
        cid2 = str((child or {}).get('id') or '')
        cname = str((child or {}).get('name') or '')
        if cid2 in QOJ_STAGE_LAYERS:
            return False
        if re.search(r'(19|20)\d{2}', cname) and pid != QOJ_PLATFORM:
            return False
        if pid in QOJ_SITE_LAYER_PARENTS and not re.search(r'(19|20)\d{2}', cname):
            return False
        return True

    out: set = set()
    # ⚠️ **两个缓存都要看**：`qoj_category_tree.json` 的 `paths` 只有"在分类树里发现它"的那条
    #    （UC 那批场次往往只有 Universal Cup 一条），赛区那条在**场次页面包屑**缓存
    #    （`qoj_contest_categories.json`，就是 `contest_categories_of()` 读的那份）。
    #    只看前者会漏掉 Europe 的子赛区（`18` 不在集合里），`Finals` 也就不会建。
    sources = [
        (_read_cache(QOJ_TREE).get('paths') or {}),
        (_read_cache(QOJ_CATEGORIES) or {}),
    ]
    for src in sources:
        for paths in src.values():
            for path in (paths or []):
                segs = path or []
                for i, seg in enumerate(segs[:-1]):
                    pid = str(seg.get('id') or '')
                    if kept(pid, segs[i + 1]):
                        out.add(pid)
    return out


def contest_names_of(cid: str) -> list:
    """
    这场在 QOJ 上**所有叫过的名字**（`title` + 列表页的各个变体名），去重、保序。

    ⚠️ 为什么要一串而不是一个（`qoj:c:1522` "有 icpc 的路径，还是 ecfinal，
    但没有判上"）：QOJ 的场次页标题常常只是**赛事品牌**（`The 2nd Universal Cup. Stage 23: Shanghai`），
    而它同时登记的另一个名字才写着这是哪一场
    （`The 2023 ICPC Asia East Continent Final Contest (EC-Final 2023)`）。
    判"阶段"（pre / final / regional）与"省赛/邀请赛"关键词都得把**所有名字**一起看。
    """
    out: list = []
    if not cid:
        return out
    v = _read_cache(QOJ_TITLES).get(str(cid))
    cand = []
    if isinstance(v, dict):
        cand = [v.get('title')] + list(v.get('names') or [])
    elif v:
        cand = [v]
    for one in cand:
        s = str(one or '').strip()
        if s and s not in out:
            out.append(s)
    return out


def vp_contests_of(user: str) -> set:
    """
    `04 qoj/cache/qoj_vp_contests.json` 里某个人的 VP 场次集合。

    那个缓存由 `04 qoj/QOJ_submissions_scraper.py --participation` 维护：
    解析用户主页的 `Virtual Participations：N contests` 区块（实测 someone 11 场 /
    kongcheng_lige 3 场 / teammate_b 5 场）。拿不到就返回空集 ——
    这时所有 QOJ 提交的性质都会**留空**（不硬猜），不会误判成"赛时"。
    """
    if not user:
        return set()
    return {str(x) for x in (_read_cache(QOJ_VP).get(str(user)) or [])}


def timefmt_of(qoj_contest: str) -> set:
    """
    `04 qoj/cache/qoj_contest_timefmt.json` 里这场出现过的格式集合
    （`{'relative'}` / `{'absolute'}` / `{'relative','absolute'}` / 空集）。

    ⚠️ 它是**逐条**的信号（实测 contest 1480：同一个人同一场里
    `2026-09-20 21:08:19` 绝对 与 `03:09:00` 相对 并存）：
      * 相对时间 = 在**参与窗口内**交的（正式赛或 VP 的进行中）；
      * 绝对时间 = 窗口**外**交的（= 赛后补题）。
    所以拿到 `{'relative'}` 就说明"这场他是在参与窗口里打的"。
    """
    if not qoj_contest:
        return set()
    v = str(_read_cache(QOJ_TIMEFMT).get(str(qoj_contest)) or '')
    return {v} if v in ('relative', 'absolute') else set()


def submit_kind_of(user: str, qoj_contest: str, vp: set = None) -> str:
    """
    QOJ 提交的性质：`赛时` / `VP` / `补题`；判不出返回 ''（不写"未知"）。

    两个信号，**按可靠性**用（第 2 个更直接）：

    ① **场次页「提交时间」列的格式**（`cache/qoj_contest_timefmt.json`，由
       `QOJ_submissions_scraper.py --timefmt` 采集）：
         参与过这场（**正式赛或 VP**）→ 显示相对时间 `04:53:08`（`relative`）
         没参与过（纯补题）        → 显示绝对时间 `2024-07-23 10:07:05`（`absolute`）
       实测对照：2564（该账号 VP 过）= relative；1404 / 1197（只有补题）= absolute。
       ⚠️ 它是**按人**的（场次页只列该账号自己的提交），所以只对该账号有效。

    ② **VP 名单**（`cache/qoj_vp_contests.json`）：在名单里 = `VP`；不在 = `赛时`。

    合起来的规则（**VP 名单优先**，因为它说的就是"参与方式"）：
       在 VP 名单 → `VP`        （参与了，而且是虚拟赛；不管时间列哪种格式）
       不在名单 + relative → `赛时`（有在参与窗口内交的记录）
       不在名单 + absolute → `补题`（有提交但全在窗口外）
       都不在名单也没格式数据 → ''（留空，不硬猜）
    """
    if not qoj_contest:
        return ''
    box = vp if vp is not None else set()
    fmts = timefmt_of(qoj_contest)
    if str(qoj_contest) in box:
        return SUBMIT_VP
    if 'relative' in fmts:
        return SUBMIT_DURING
    if 'absolute' in fmts:
        return SUBMIT_AFTER
    return ''


_UNIT = re.compile(r'^([\d.]+)\s*(ms|s|kb|mb|b)?$', re.I)


def to_millis(text) -> str:
    """QOJ 的 `95ms` / `1.2s` → 毫秒（口径与 CF 的 `timeConsumedMillis` 一致）"""
    m = _UNIT.match(_s(text))
    if not m:
        return ''
    num, unit = float(m.group(1)), (m.group(2) or 'ms').lower()
    return str(int(num * {'ms': 1, 's': 1000}.get(unit, 1)))


def to_bytes(text) -> str:
    """QOJ 的 `4956kb` / `2.0mb` → 字节（口径与 CF 的 `memoryConsumedBytes` 一致）"""
    m = _UNIT.match(_s(text))
    if not m:
        return ''
    num, unit = float(m.group(1)), (m.group(2) or 'b').lower()
    return str(int(num * {'b': 1, 'kb': 1024, 'mb': 1048576}.get(unit, 1)))



def load_records(path: str) -> list[dict]:
    data = read_json(path)
    if isinstance(data, dict):
        for k in ('submissions', 'records', 'problems'):
            if isinstance(data.get(k), list):
                data = data[k]
                break
    if not isinstance(data, list):
        raise ValueError(f'{path} 不是数组，也不是含 submissions/records 的对象')
    return [x for x in data if isinstance(x, dict)]


#: 题面页归属缓存 —— `04 qoj` 独家维护（`--resolve-contests` 整类补一遍；
#: `--fetch` 抓到新的全局题号时**顺手**补那几道）。内容：`{题目 id: [场次号, ...]}`。
#: ⚠️ 这里只**读那个文件**、不 import 那边的模块：`04 qoj` 与 `05 xcpc` **互不依赖**
#:    （见 `lib/xcpc_common.py` 开头那段）；`link_qoj_activity.py` 读
#:    `../04 qoj/cache/qoj_contest_titles.json` 是同一个先例。
QOJ_PROBLEM_CONTESTS = os.path.join(HERE, '..', '04 qoj', 'cache', 'qoj_problem_contests.json')

#: 那份缓存的进程内副本（`{pid: [cid, ...]}`；读不到 = 空表，不炸）
_problem_contests: dict | None = None


def problem_contests_of(pid: str) -> list:
    """
    这一题**被哪些场次用过**（题面页原文：`The problem was used in the following contests:`）。

    用例见 `contest_id_of()` 的第 ③ 条：QOJ 的**全局**提交列表给的题目链接是全局题号
    `/problem/<pid>`、不含场次 ⇒ 只能靠这份缓存认。取**第一场**当归属（QOJ 自己的顺序），
    全部候选留在缓存里不丢。
    """
    global _problem_contests
    if _problem_contests is None:
        _problem_contests = read_json(QOJ_PROBLEM_CONTESTS) \
            if os.path.isfile(QOJ_PROBLEM_CONTESTS) else {}
        if not isinstance(_problem_contests, dict):
            _problem_contests = {}
    return list(_problem_contests.get(str(pid)) or [])


def contest_id_of(r: dict) -> str:
    """
    这一条提交属于哪个 QOJ 场次。

    ① 记录里写好的 `场次号`（`04 qoj --resolve-contests` 从**题面页**查回来的
       "这题被哪些比赛用过" —— 全局提交列表给的是全局题号 `/problem/<pid>`，不含场次）；
    ② 题目链接 / 提交链接 / `contestId` 里直接带 `/contest/<id>`；
    ③ 链接只有**全局题号**时，查**题面页归属缓存**（`04 qoj/cache/qoj_problem_contests.json`）。

    ⚠️ 三条与 `04 qoj/QOJ_submissions_scraper.py` 的 `contest_of_record()` **是同一条口径**
       （那边是这份缓存的主人）—— 这里少任何一条，结果都是"提交明明抓到了却没进包"
       （实测：23 条全局题号的提交一直落不了场，就是因为这里只有 ①②）。
    """
    sid = _s(r.get('场次号'))
    if sid:
        return sid
    for field in ('题目链接', '提交链接', 'contestId'):
        m = CONTEST_RE.search(_s(r.get(field)))
        if m:
            return m.group(1)
    pid = problem_id_of(r)
    return (problem_contests_of(pid) or [''])[0] if pid else ''


def problem_id_of(r: dict) -> str:
    """QOJ 的题目 id（树里的 P 身份就是它）"""
    pid = _s(r.get('题目ID'))
    if pid:
        return pid
    m = PROBLEM_RE.search(_s(r.get('题目链接')))
    return m.group(1) if m else ''


def build_tree(records: list[dict] | None = None,
               contest_ids: list[str] | None = None) -> tuple[Crate, list[str]]:
    """
    **整棵 QOJ 树一个 crate**：`W qoj → S <QOJ 分类链> → C → P → R`。

    为什么不按场次出片段：主树清单（`xcpc_contests.json`）里只有 35 场挂了 QOJ 提交，
    而 QOJ 包里该有的场次是"分类树 ∪ 我提交过的"（实测 299 场）。按清单逐场出，
    剩下 264 场永远进不了包 —— 而它们的 C/P 本来就在归档里躺着。

    场次集合来自 `04 qoj` 的 `--category` 落盘的 `qoj_category_tree.json`；
    提交记录整份 `qoj_submissions.json` 按场次号分组。两者都不需要清单。

    @returns `(crate, 警告列表)`
    """
    crate = Crate(source_id='qoj', label=LABEL, platform=QOJ_PLATFORM)
    warns: list[str] = []
    # 平台节点也带链接（"W 节点的 QOJ 加上链接"）——排查时能直接点回源站
    crate.platform(QOJ_PLATFORM, name=QOJ_PLATFORM_NAME, **root_name_src(crate),
                   **link_kinds(('browse', 'https://qoj.ac/')))

    if records is None:
        # 默认提交文件 = 清单里那几场共用那份（`04 qoj/qoj_submissions.json`）——
        # 与 `main()` 用的是**同一个入口** `default_submissions_file()`。
        # ⚠️ 不传 `records` 时按既有入口 `default_submissions_file()` 取提交文件，
        #    别写路径字面量：`QOJ_SUBMISSIONS` 这个名字本模块没有
        #    （它只在 `gen_gym_manifest.py` 里出现过）⇒ 写它必 NameError。
        records = load_records(default_submissions_file())
    # 提交按场次号分组（一条只归一场；认不出场次号的如实报出来）
    by_contest: dict[str, list[dict]] = {}
    no_contest = 0
    for r in records:
        if '提交ID' not in r:
            continue
        cid = contest_id_of(r)
        if not cid:
            no_contest += 1
            continue
        by_contest.setdefault(cid, []).append(r)
    if no_contest:
        warns.append(f'{no_contest} 条提交认不出 QOJ 场次号（链接里没有 /contest/<id>），跳过')

    ids = [str(x) for x in (contest_ids if contest_ids is not None else tree_contest_ids())]
    # 兜底：树缓存里没有、但提交里出现的场次也要出（例如缓存还没重建）
    for cid in by_contest:
        if cid not in ids:
            ids.append(cid)
            warns.append(f'场次 {cid} 不在分类树缓存里，但有提交 —— 补进包里')
    if not ids:
        warns.append('一个场次都没有（`04 qoj` 还没跑过 `--category`，也没有提交记录）')
        return crate, warns

    series_done: dict[str, str] = {}      # 分类链键 → 它的父键（同一个 S 只能出一遍）
    for cid in sorted(set(ids), key=lambda x: (len(x), x)):
        # ---- S 层：分类链 ----
        # 路径来自 **QOJ 自己的分类**（`qoj_category_tree.json` 里每场被发现的那个分类，
        # 那个分类的路径又是它自己那行 `Location:` 面包屑 ⇒ 同一个分类只会挂在一处；
        # 遍历来路不算数，否则同一个分类会因"从哪个根走下来"而挂到多处）。
        # 场次页自己的面包屑是**兜底**（分类树里没有的场次，比如我提交过但没在系列里的补题场）。
        #
        # ⚠️ 必须用**所有路径**（"请充分利用所有路径"）：一场可能有**多条**路径
        #    （`qoj_contest_categories.json` 里那 297 场中有 160 场不止一条）——
        #    · **判分类**用**全部**路径（否则 `qoj:c:1093` 那种"树里挂在 Universal Cup 下、
        #      自己还属于 ICPC 南京站"的场次永远判成「无归类」）；
        #    · **挂树位置**优先选"过 icpc/ccpc 的那条"（否则分类写着 `qoj/xcpc/…`、
        #      树里却挂在 `Universal Cup` 下，两处打架），再退到主路径。
        tree_paths = tree_category_path_of(cid) or []
        own_paths = contest_categories_of(cid) or []
        all_paths = _dedup_paths(list(tree_paths) + list(own_paths))
        primary = tree_paths[0] if tree_paths else (own_paths[0] if own_paths else [])
        cats_text = ' '.join(str((c or {}).get('name') or '')
                             for p in all_paths for c in p)
        names = contest_names_of(cid)
        cname = contest_title_of(cid)
        # ★ **两份读法**（`qoj_identity_rules`）：这一份读法 + （可选）xcpc 那一份读法，
        #   每一步同时给出"凭什么"（规则 id）—— 写进元列 `分类依据`。
        #   标题写着 Universal Cup ⇒ 这一份读法是 `qoj/ucup`，挂树位置也跟着走 **Universal Cup 那条路径**；
        #   其余场次就是路径判出来的那个（挂位置优先选"过 icpc/ccpc 的那条"）。
        #   ⚠️ 两种读法都在时**出两个节点**（基键 = xcpc 那份，`:ucup` = UC 那份），
        #   判据与理由见下面"UC 与 XCPC 两种读法各出一个节点"那一段。
        (cls, cls_rule), (xcpc_cls, xcpc_rule) = qoj_identity_rules(all_paths, names, warns, title=cname)
        if cls == QOJ_UCUP_CLASS:
            paths = [next((p for p in all_paths
                           if any(re.search(QOJ_UCUP_PATTERN, str((c or {}).get('name') or ''), re.I)
                                  for c in p)), primary or [])]
        else:
            paths = [_path_for_class(all_paths, cls) or primary] \
                if (all_paths or primary) else []
        cats = (paths[0] if paths else []) or []
        ck_parent = None                     # ⚠️ 挂位在下面 `held` 算完之后才定（要年份层）

        ck = f'{QOJ_PLATFORM}:c:{cid}'
        # 性质：**QOJ 上办的场次 ⇒ 大类 `qoj`**。
        # 分类**按 QOJ 自带的分类链再细一层**（"qoj 的场次常自带路径，若自带路径之一
        # 经过 icpc/ccpc 之一…然后 qoj 分类细化，具体地把 xcpc 的分类复制到 qoj 下"）：
        # 过 `icpc` ⇒ `qoj/xcpc/icpc/ec/<阶段>`（QOJ 的 Regionals 下**只有** Asia East Continent，
        # 实测 63 场全是它 ⇒ EC 那一段是确定的）；过 `ccpc` ⇒ `qoj/xcpc/ccpc/<阶段>`；
        # 两支都过就警告 + 取 icpc（`qoj_class_of`）；**都不过 ⇒ 继续记 `qoj/无归类`**
        # （"先继续记未归类"）。
        # 阶段（pre / final / regional / 无归类）用**赛名**判 —— 与 XCPC 那一侧**同一套**
        # （`xcpc_common.stage_of`，规则只有一处）。
        # 地区写 `无`（线上赛，没有场地）；年份只取**分类链路口名**里的 20xx
        # （不从赛名取：QOJ 的赛名常带"-2025 年 1 月"这类副标题，第一个年份未必是赛季年）。
        cats_text = ' '.join(str((c or {}).get('name') or '')
                             for p in all_paths for c in p)
        names = contest_names_of(cid)
        cname = contest_title_of(cid)
        # 这一场的**所有名字**拼一份（标题 + 各变体名）—— 判阶段、判地区都用它
        # （与 `qoj_identity_rules()` 里那一份是同一个口径）。
        name_text = ' '.join(str(n or '') for n in names)
        # ★ 读**这条读法自己那条路径**：有 xcpc 读法（UC 镜像）时就是那条 xcpc 路径
        #   （如 EC-Final 那条，年份在「The 2021 ICPC Asia East Regionals」这种层名里），
        #   否则就是上面按分类选出来的那条（如「…/Chinese Provincial / Invitational/Beijing/」）。
        # ⚠️ **不许拿 `all_paths` 拼起来读**：同一场可以同时挂在**别的**分类下 ——
        #    实测 `qoj:c:1464`（2023 北京市大学生程序设计竞赛）另有一条
        #    `/Training Camps/Petrozavodsk Programming Camp/46th … (2024 Winter)/`，
        #    拼起来会读出 **2024**（还标成 A 级"权威"）⇒ 与 2024 北京那场撞进同一个年份层/组；
        #    它自己那条路径没有年份 ⇒ 正确结果是退到**赛名里的 2023**（C 级）。
        # ⚠️ 这份是 **xcpc 读法**用的赛季（"取 xcpc 那份读法"时要用），下面 UC 那一档会把它改掉。
        own_path = ((_path_for_class(all_paths, xcpc_cls) or primary)
                    if (cls == QOJ_UCUP_CLASS and xcpc_cls)
                    else ((paths[0] if paths else []) or primary))
        own_cats_text = ' '.join(str((c or {}).get('name') or '') for c in (own_path or []))
        season_xcpc = year_in_text(own_cats_text) or year_in_text(' '.join(names))
        # 赛季**依据**：自己那条路径里的 20xx 是 **QOJ 自己给的**（A 权威枚举），
        # 退到"所有名字"里的 20xx 就是**赛名**（C 明确字面词）。
        season_rule_xcpc = ('qoj:season-path' if year_in_text(own_cats_text)
                            else ('qoj:season-name' if season_xcpc else ''))
        # ⚠️ 两份读法**只算一次**（上面那次 `qoj_identity_rules`）—— 不要在这里**又算一遍**
        #    `qoj_identities`：同一场判两遍，警告会重复一遍，而且两边将来一旦漂开
        #    （一个用主路径、一个用全部路径）就会写出自相矛盾的两个分类。
        held = season = season_xcpc
        # 年份/赛季依据的**默认值**（下面几条分支各自覆盖）：
        #   这一份读法（xcpc）的赛季就是 `season_xcpc`；年份默认 = 赛季年顶（下面 `else` 那一支）。
        season_rule = season_rule_xcpc
        # ⚠️ 这里原来还有一行 `year_rule = 'qoj:year-season'`（已删）：**三条分支（UC / 总决赛 /
        #    其余）每一支都会覆盖它** ⇒ 死赋值；而它又长得像"默认口径"，读代码的人会以为
        #    "赛季年顶年份"还在用（那正是 2026-10 被废掉的那条）。
        #    旧包里的 `qoj:year-season` 仍在应用侧级别表里（显示成 D），但**不再产出**。
        # **Universal Cup**（标题写着 UC ⇒ 这一份读法 `qoj/ucup`："新增 qoj/ucup，年份=qoj端比赛时间，
        # 赛季填无" → "ucup 的年份也填无吧" → "**两届 Semifinals + 两届 Finals 有自带日期就挂上吧，
        # 没有才填无**" → "**UC Stage 特殊处理**"）：
        #   · 赛季**一律 `无`** —— UC 没有"赛季年"这个概念；
        #   · 年份取 **QOJ 端的比赛时间**；QOJ 没记的（70 场里绝大多数是 `-` / `Not set`）
        #     才写 `无`（= "不适用"，而不是空着挂 ③ 等人补一个拿不到的值）。
        if cls == QOJ_UCUP_CLASS:
            held = year_in_text(contest_start_at(cid)) or NATURE_YEAR_NONE
            season = NATURE_SEASON_NONE
            year_rule = ('qoj:year-time' if year_in_text(contest_start_at(cid))
                         else 'qoj:year-none')
            season_rule = 'qoj:season-none'
            # xcpc 那一份读法**照它自己那套**算年份：它对外声称"这就是那场 EC-Final"，
            # 年份写 `无`（UC 的"不适用"）就说不过去了。总决赛没有日期 ⇒ `待同步`。
            # ⚠️ 这一场若真有那份读法（见下面"UC 与 XCPC 两种读法各出一个节点"那段），
            #    基键那份用的就是这几个值。
            if is_cross_year_leaf(xcpc_cls):
                held_xcpc = held_year_of(xcpc_cls, season_xcpc, contest_start_at(cid)) \
                    or YEAR_TO_SYNC
                xcpc_year_rule = ('qoj:year-time' if year_in_text(contest_start_at(cid))
                                  else 'qoj:year-tbd')
            else:
                # 这份读法同样：拿不到日期就 `待同步`（与收集树一个口径）
                held_xcpc = YEAR_TO_SYNC
                xcpc_year_rule = 'qoj:year-tbd'
        # 举办年份（窗口规则）：
        #   · **总决赛**（EC-Final / CCPC Final）：按窗口规则，有 `startAt` 就用它，
        #     拿不到就写 **`待同步`**（"qoj 的各 final 年份可以填『待同步』"）——
        #     它们的举办年落在"赛季年或次年"、**不唯一**，与其空着不如标成"处理过了、还没定"
        #     （应用里 `待同步` 算填过 ⇒ 不会再挂在 ③ 等人猜）。
        #   · **其余一律 = 赛季年**（"除了 ecfinal 与 ccfinal，可以认为 ec 赛区的
        #     所有比赛举办年份与赛季年份相同"）。⚠️ 这里**不再信 QOJ 的 `startAt`** ——
        #     实测它是**镜像/重跑时间**：2022 南京站被填成 2026、2022 桂林站填成 2026…
        #     那些日期对"举办年份"是假证据。
        # ---- 年份 / 赛季的**依据**（写进元列 `分类依据` ⇒ 界面据此画可信度）----
        #   这里的年份绝大多数正是**赛季年顶**出来的（`qoj:year-season`，D 推断、可信度不高）；
        #   总决赛没日期是 `待同步`
        #   （`qoj:year-tbd`，也是 D）；只有真拿到 QOJ 开赛时间才是 A（`qoj:year-time`）。
        elif is_cross_year_leaf(cls):
            held = held_year_of(cls, season, contest_start_at(cid)) or YEAR_TO_SYNC
            year_rule = ('qoj:year-time' if year_in_text(contest_start_at(cid))
                         else 'qoj:year-tbd')
        else:
            # ★ "QOJ 分类链路口名的 20xx 也是按赛季划的…那**与年份完全无关**"
            #   ⇒ **不再用赛季年顶年份**（也不信 QOJ 那个"镜像/重跑时间"）；
            #   "QOJ 年份全部自动填 `待同步`" ⇒ **写 `待同步`**（不是留空：
            #   空是"还没判"，而这里已经判过了、只是手里没有日期；`待同步` 正好是这个意思）。
            held = YEAR_TO_SYNC
            year_rule = 'qoj:year-tbd'
        # ⚠️ 名字一个都没有（QOJ 那页打不开、列表页也没有）⇒ 写**「获取数据失败」**
        #    而不是留空（"qoj:c:2624 这种无法抓取的，命名为『获取数据失败』+extKey"）。
        #    留空的话应用只能退回显示**节点 id**（`n_475880_…` 那种）；应用还会把 extKey 缀在后面，
        #    所以树上看到的是「获取数据失败（qoj:c:2624）」，够定位。
        # QOJ 场次页就是**补题入口**；名字用 QOJ 自己的（场次列表页缓存）。
        # ⚠️ 地区：**从赛名与分类路径里读**（城市 / 省名），读不出**留空**
        #    （"qoj 不要随便填地区无" —— 空 = "还没判"，不是"不适用"）。
        #    两条判据（见 `qoj_region_of`）：① 网络赛 ⇒ `无`（没有场地是事实）；
        #    ② **UC 系列 ⇒ `无`**（"等等 ucup 还是直接填无吧"）；
        #    ③ 其余读赛名里的城市（`Asia Nanjing Regional` ⇒ 南京），读不出再退到
        #    **QOJ 分类路径里的地名层**（`… / Asia East Continent / Nanjing`）。
        # ★ **连名字都没抓到**（那一页 403 / 上游坏了）⇒ 分类落 `上游异常`
        #   （灰、判冲突时当没有主张）—— 而不是 `未归类`（蓝、等人补：那种情况根本补不出来）。
        #   只在最后一格是「判不出」那两个值时替换（`qoj/ucup` 那种正常分类一个字不动）。
        if not cname and not names and cls.split('/')[-1] in (STAGE_NONE, PROVINCIAL_TYPE_NONE):
            cls = '/'.join(cls.split('/')[:-1] + [UPSTREAM_ERROR])
        # ---- ★ **UC 与 XCPC 两种读法各出一个节点**（用户 2026-10-07 口径）----
        # 这一场在 QOJ 上**同时**是"某场 XCPC 比赛"和"某个 UC 站"时（"那些 ucup stage 与
        # xcpc 完全一致的"）：
        #   · **基键 `qoj:c:<id>`** = 那份 **XCPC 读法**（名字用变体名、分类/年份/赛季/地区/
        #     挂位全按那一支）—— **题（P）与提交（R）都在这份下**；
        #   · **`qoj:c:<id>:ucup`** = 那份 **UC 读法**（UC 标题、`qoj/ucup`、赛季 `无`、
        #     地区 `待填写`、挂在 Universal Cup 那条链下）—— **不带题、不带提交**。
        # 为什么 P/R 只留基键那份：同一道题 / 同一条提交在树里出现**两次** ⇒ 计数直接翻倍
        #   （覆盖、分布、题目检索全双份）；而"收的那场"必须能看见提交 —— 早先那套
        #   "UC 一份、xcpc 再建一个 `qoj:c:<id>:xcpc`"把 R 留在了 UC 那份上，实测
        #   `qoj:c:2609`：49 条提交全挂在没有后缀的那份下，武汉区域赛那份是空的。
        # 为什么这两个节点**互不绑定、互不干扰**：UC 分类（`qoj/ucup`）不在算键范围里
        #   （`core/synthPlan.js`：只做国内）⇒ 它永远进不了任何组；题这边没有复制品 ⇒
        #   `synth:problem:*` 也不会跨场把它们绑一起。
        # ⚠️ 应用侧那条"同一场被拆成两个 C"的清理（`core/synthConflicts.js` ⑫）只认**旧写法
        #    `:xcpc`** —— `:ucup` 现在是**正规**的第二份，别再报它/收它。
        # 名字跟着 QOJ 走：基键取**那一支的名字**（`branch_name_of()`，变体名里不是标题的那个）。
        # 地区也从**那个名字**里读（"Shaanxi:陕西，入地名表，应自动识别填写"）——
        # 实测这一条修掉了 34 场区域赛（icpc 22 + ccpc 12）读不出地点的问题；
        # 真读不出（没有变体名可用、名字还是 `Stage 31: Wroclaw` 这种 UC 名）才退回兜底 `待填写`。
        uc_side = None
        if cls == QOJ_UCUP_CLASS and xcpc_cls:
            # UC 那一份的值**先抄下来**（下面几行会把 `cls`/`held`/`season`/`paths` 换成 xcpc 读法）
            uc_region, uc_region_rule = qoj_region_of(QOJ_UCUP_CLASS, name_text, cats_text)
            uc_side = {
                'ck': f'{ck}:ucup',
                'name': cname,
                'cls': cls, 'cls_rule': cls_rule,
                'held': held, 'year_rule': year_rule,
                'season': season, 'season_rule': season_rule,
                'region': uc_region, 'region_rule': uc_region_rule,
                'cats': list(cats),
            }
            xb_name = branch_name_of(cid, cname)
            cname = xb_name or cname
            cls, cls_rule = xcpc_cls, xcpc_rule
            held, year_rule = held_xcpc, xcpc_year_rule
            season, season_rule = season_xcpc, season_rule_xcpc
            region, region_rule = qoj_region_of(xcpc_cls, xb_name or name_text,
                                                cats_text, ucup_mirror=not xb_name)
            paths = [_path_for_class(all_paths, cls) or primary]
            cats = (paths[0] if paths else []) or []
        else:
            region, region_rule = qoj_region_of(cls, name_text, cats_text)
        # ★ **挂位**（含时间层，见 `_place_contest` 的说明）：必须在 `held` / `season` 定下来之后
        #   才算 —— 时间层要用的就是赛季（拿不到才退到举办年份）。
        ck_parent = _place_contest(crate, cats, series_done, held, cls=cls, season=season)
        crate.contest(ck_parent, ck, name=(cname or QOJ_FETCH_FAILED),
                      **nature_fields(('natureClass', cls),
                                      ('natureYear', held),
                                      ('natureSeason', season),
                                      ('natureRegion', region)),
                      **class_rules(('natureClass', cls_rule), ('natureYear', year_rule),
                                    ('natureSeason', season_rule), ('natureRegion', region_rule)),
                      **link_kinds(('problems', f'https://qoj.ac/contest/{cid}')))
        # UC 那一份（见上面那段）：**只出一个场次节点**，题/提交都留在基键那份下
        if uc_side:
            uc_parent = _place_contest(crate, uc_side['cats'], series_done, uc_side['held'],
                                       cls=uc_side['cls'], season=uc_side['season'])
            crate.contest(uc_parent, uc_side['ck'], name=(uc_side['name'] or QOJ_FETCH_FAILED),
                          **nature_fields(('natureClass', uc_side['cls']),
                                          ('natureYear', uc_side['held']),
                                          ('natureSeason', uc_side['season']),
                                          ('natureRegion', uc_side['region'])),
                          **class_rules(('natureClass', uc_side['cls_rule']),
                                        ('natureYear', uc_side['year_rule']),
                                        ('natureSeason', uc_side['season_rule']),
                                        ('natureRegion', uc_side['region_rule'])),
                          **link_kinds(('problems', f'https://qoj.ac/contest/{cid}')))
        _add_contest_records(crate, cid, ck, by_contest.get(cid) or [], warns)

    return crate, warns


def _place_contest(crate, cats: list, series_done: dict, year='', cls='', season='') -> str:
    """
    按一条**分类路径**把 S 层铺出来，返回这一场该挂的父键（`ck_parent`）。

    抽成函数是因为**这一场的挂位在 `held` / `season` 定下来之后才算**（要铺时间层），
    而"两种读法各挂哪条链"是那之后才定的 —— 见 `build_tree` 里
    "UC 与 XCPC 两种读法各出一个节点"那段。

    ⚠️ 「地名层跳过」与「年份层不建编号层」是**同一件事的两面**：这一层不承载分类、
    只承载年份。判据一律用"名字里有没有 19xx/20xx"（不用维护地名表）：
      · 名字**没**年份 + 父是站点层（`cat-21` = Asia East Continent）⇒ **地名层**（Wuhan /
        Guangzhou / Shanghai / Xi'an…，只是把同一赛区的场次拆散，信息在 C 的赛名里已经有了），跳过；
      · 名字**有**年份 ⇒ **年份层**（`The 2017 ACM-ICPC Asia East Regionals` = `cat-465`），也跳过。
    跳过时 `parent_cat` **不动**（它记的是"最近一个真的建出来的层"），于是后面那层仍按
    "我的父是谁"来判 —— 地名层与年份层能一起跳过去，靠的就是这一点。

    ★ **时间层**：
    · "底下比赛先按年分类…年/赛季的一层很重要" ⇒ QOJ 自己**没有统一的时间层**
      （实测：67 个 S 下直接挂 358 场），所以分类链走完后要补一层。
    · "xcpc（省赛区域赛除外）都按赛季分" ⇒ 那一层**取赛季**
      （拿不到真赛季才退到举办年份、都不行 ⇒ `年份未知`，不静默丢）。
    ⚠️ QOJ **自带年份的编号层**（`The 2021 ICPC Asia East Regionals` = `cat-461`、
      `第八届中国大学生程序设计竞赛（CCPC 2022）` = `cat-276`）**一律不建**：建了就会与时间层
      **把同一年拆成两层**（实测 `cat-21` 下 `2022`(3 场) 与 `cat-460`「The 2022 … Regionals」(3 场)
      各挂一半 —— 正是"同层混乱"）。
      唯一例外：**顶层**就带年份的层不跳（`parent` 还是平台自己时，上面没有分类可托底，
      跳过会把这一场直接挂到根上）。
    ★ **时间层**：层里的名字一律**赛季优先**（"xcpc 都按赛季分"），
      且**只在需要时才套**（"其下分类只有一层赛季，每个赛季内的比赛
      已经按时间排好了，不用套什么 reg/final 层"；"省赛下分类只有一层地点，…不用再套一层时间"；
      "ucup 就别分了"、"别加 2019 2026 的赛季系列层"）⇒ 判据只有一份：
      `xcpc_common.tree_time_layer(cls, season, year)`（省赛/UCup/无归类 ⇒ 不套）。
      热身赛再多套一层「热身赛」（"如果有热身赛，在赛季内再开一个热身赛系列"）。
    ⚠️ 层**名字**用 QOJ 自己的（`Asia East Continent` / `Zhejiang`），层**种类与顺序**与
      gym / xcpc 那边一致 —— 这就是"抄 qoj"。

    ⚠️ 「无分类」那条兜底路径（`qoj:s:no-category`）：命中"分类不够、nature 够"的会由
    链子里的 `scripts/nature-rehome.mjs` 事后搬走。
    """
    if not cats:
        # 真·没挂分类的场次（用户自建的补题场）：树里 W 不能直接挂 C，落兜底 S
        if QOJ_SERIES not in series_done:
            crate.series(QOJ_PLATFORM, QOJ_SERIES, name=QOJ_SERIES_NAME)
            series_done[QOJ_SERIES] = QOJ_PLATFORM
        return QOJ_SERIES
    parent = QOJ_PLATFORM
    key = f'{QOJ_PLATFORM}:s'
    parent_cat = ''                       # 最近一个"真的建出来"的分类 id（判"下一层是不是地名层"用）
    for c in cats:
        cid_ = str(c.get('id') or '')
        # 层名：**分类页自己的名字优先**（面包屑里 QOJ 会写占位符 `~`，见 `category_name_of`）
        cname = category_name_of(cid_, str(c.get('name') or ''))
        if cid_ in QOJ_STAGE_LAYERS:
            continue                      # 阶段层（`Regionals`）不建：只按赛季分，见那个常量的说明
        year_in_name = bool(re.search(r'(19|20)\d{2}', cname))
        if year_in_name and parent != QOJ_PLATFORM:
            continue                      # 年份层：不建编号层，末尾统一铺时间层
        if parent_cat in QOJ_SITE_LAYER_PARENTS and not year_in_name:
            continue                      # 地名层：跳过，场次挂到它的父层上去
        key = f'{key}:cat-{cid_}'
        if key not in series_done:
            # 每个分类都点得回源站上那一页（"加上链接…降低排查难度"）
            crate.series(parent, key, name=cname,
                         **link_kinds(('browse', f'https://qoj.ac/category/{cid_}')))
            series_done[key] = parent
        parent = key
        parent_cat = cid_
    # 总决赛：**含多个分赛区**的那些赛区单独一层 `Finals`（见 `finals_layer_of`）——
    # 层里直接放比赛（不套赛季层，同层按时间排）；别的赛区**同一赛区内只按赛季分**
    region_cat = str((cats[-1] or {}).get('id') or '') if cats else ''
    finals = finals_layer_of(cls, region_cat in _regions_with_subregions())
    if finals:
        fk = f'{parent}:finals'
        if fk not in series_done:
            crate.series(parent, fk, name=finals)
            series_done[fk] = parent
        return fk
    # 时间层：**赛季优先**，且只在"该套"时才套（ucup / 无归类 不套）
    seg, label = tree_time_layer(cls, season, year)
    if seg:
        year_key = f'{parent}:{seg}'
        if year_key not in series_done:
            crate.series(parent, year_key, name=label)
            series_done[year_key] = parent
        parent = year_key
    # 热身赛：赛季内**专门一层**（没有热身赛就不建这一层）
    if is_warmup_class(cls):
        wu_key = f'{parent}:warm-up'
        if wu_key not in series_done:
            crate.series(parent, wu_key, name=WARMUP_LAYER)
            series_done[wu_key] = parent
        parent = wu_key
    return parent


def _qoj_region_ucup(_item, ctx, _cur):
    """UC 系列（拿不到变体名的镜像也算）⇒ `待填写`（B 结构：这是"这个系列的性质"，不是赛名里的词）"""
    if ctx.get('ucup'):
        return NATURE_REGION_TBD, 'qoj:region-ucup'
    return ''


def _qoj_region_path(_item, ctx, _cur):
    """赛名读不出 ⇒ 退到 **QOJ 自己的分类路径**（`qoj:path-*`）；英文地名 ⇒ `不需要`"""
    place, kind = place_of_name(ctx.get('cat') or '')
    if kind == 'foreign':
        return NATURE_REGION_NOT_NEEDED, 'qoj:region-foreign'
    if place:
        return place, f'qoj:path-{kind}'
    return ''


#: **QOJ 那一份参数**（第三个方言）—— 判据与 XCPC / gym 共用同一批（`REGION_CORE`），
#: 只**多两条自己的**（UC 系列 / 分类路径兜底）；顺序即优先级。
QOJ_REGION_STAGE = _stages.Stage(
    key='region.qoj',
    title='地区（QOJ）',
    field='natureRegion',
    merge='first',
    unit='条',
    missing='赛名与分类路径里都读不出中国地名 ⇒ 留空（不猜）',
    prepare=lambda _item, _ctx: {'scope': 'qoj', 'regionPrefix': 'qoj'},
    rules=(
        _stages.Rule('region-ucup', 'natureRegion', _qoj_region_ucup,
                     'UC 系列（含拿不到变体名的镜像）⇒ `待填写`：这一维由人不定期地填'),
        REGION_CORE,
        _stages.Rule('region-path', 'natureRegion', _qoj_region_path,
                     '退到 QOJ 自己的分类路径读地名；英文地名 ⇒ `不需要`'),
    ),
)


def qoj_region_of(cls: str, name_text: str, cat_text: str = '', ucup_mirror: bool = False) -> tuple:
    """
    QOJ 场次的**地区**（`natureRegion`）→ `(值, 规则id)`。

    三条判据（**声明在 `QOJ_REGION_STAGE`** —— 与 XCPC / gym 是同一个环节模块的不同参数）：

      ① **UC 系列 ⇒ `待填写`**（`qoj/ucup`："等等 ucup 还是直接填无吧" →
         "ucup…可以填『不需要』" → 定稿："**ucup、ecfinal、ccfinal、
         ccpc 女生/高职场都用脚本填『待填写』，但在判定层面被视为已填写**"）。
         **拿不到变体名的 UC 镜像**（`ucup_mirror=True`，名字还是 `Stage 31: Wroclaw`）同样 `待填写`
         —— 这时没有"它作为哪场 XCPC 比赛"的名字可读。规则 id `qoj:region-ucup`（B 结构：
         这是"这个系列的性质"，不是赛名里的词）。
      ② **网络赛 ⇒ `无`** / **总决赛·女生·高职 ⇒ `待填写`** / 其余读中国城市·省名
         （赛名读不出再退到 **QOJ 自己的分类路径**，规则 id `qoj:path-*`）—— 全在
         `xcpc_common.region_of_contest()` 里，与 XCPC / gym 两侧共用；**都读不出就留空**。

    ⚠️ **不要"随便填 `无`"**（"qoj 不要随便填地区无"）：`无` 只说一件事 ——
    "网络赛、没有场地"；UC 与总决赛那几类是 `待填写`；国外英文地名是 `不需要`。
    """
    ans = _stages.resolve(QOJ_REGION_STAGE, (str(name_text or ''), ''), {
        'cls': cls,
        'cat': cat_text,
        # ⚠️ 判据要的是"这一场算不算 UC"：`cls` 是这一份读法，`ucup_mirror` 是"名字还是 UC 名"那条路
        'ucup': str(cls or '') == QOJ_UCUP_CLASS or bool(ucup_mirror),
    })
    return (ans.value or ''), (ans.rule or '')


def qoj_identity_rules(cats, names, warns: list | None = None, title: str = '') -> tuple:
    """
    QOJ 场次的**两份读法 + 各自的分类依据规则 id**：

        `((这一份读法, 规则id), (xcpc 读法或 '', 规则id或 ''))`

    判据与 `qoj_identities()` 是**同一份代码**（那个函数只是把两列分类取出来），
    这里多回来的是"每一条分类是**哪条规则**判出来的"（写进元列 `分类依据`，
    级别表在应用侧 `src/core/natureConfidence.js` 的 `CLASS_RULE_LEVEL`）。

    ★ **UC Stage 特殊处理**（"UC Stage 特殊处理"）：**标题写着 `Universal Cup`
    的场次，标题那一份读法是 `qoj/ucup`** —— 那是这场自己的名字（QOJ 的 `<title>`），
    xcpc 那一套（路径过 icpc/ccpc / 省赛 / 赛区阶段）是**它镜像了哪一场**的读法，
    作为第二列返回。⚠️ **`build_tree` 只用其中一个**：第二列有值 ⇒ 用第二列
    （"一个 QOJ 场次只有一个节点"，键就是 `qoj:c:<id>`；理由见那边的一段）。

    `xcpc 身份` 的判据（与 `qoj/xcpc/…` 那一支完全一致，这里只是"单独算一遍"）：
      ① **所有分类路径的并集**里过 `icpc` ⇒ `qoj/xcpc/icpc/<赛区>/<阶段>/<official|warm-up>`
         （过 `ccpc` ⇒ `qoj/xcpc/ccpc/<阶段>/…`；两支都过 ⇒ 警告 + 取 icpc；
         赛区读不出 ⇒ 停在 `qoj/xcpc/icpc`）；
      ② 不过 icpc/ccpc，但**这一场是 EC 的**且名字/路径里有省赛/邀请赛关键词 ⇒
         `qoj/xcpc/provincial&invitational/<official|warm-up>`
         （"省赛/邀请赛的判定一定要最靠前" + "只对 ec 赛区生效"）；
      ③ 都不是 ⇒ `''`。

    ⚠️ **`cats` 要看"所有路径"**（"请充分利用所有路径"：
    160/297 场有不止一条路径；`qoj:c:1093` 在分类树里挂在 `Universal Cup` 下、自己还属于
    `ICPC / Regionals / Asia East Continent / Nanjing`）。
    ⚠️ **赛区从 icpc 那条路径里读**（缩写表见 `QOJ_CONTINENT_SEG`），读不出不猜。
    ⚠️ **阶段用"所有名字"判**（`names` = 标题 + 各变体名）—— 路径里的 `Regionals` 只是那个
    大区的名字，喂进去会把一堆场次都变成 `regional`。
    ⚠️ `names` 允许传字符串；`title` 缺省空串（老调用方/单测不必传，但那会让 UC 那一档失效）。

    ★ **规则 id 记的是最弱的那一环**（「依据强度」）：

      · `qoj:path-icpc` / `qoj:path-ccpc`（A 权威）—— QOJ **自己的分类路径**说它是 ICPC / CCPC；
      · `qoj:name-provincial`（C 明确字面词）—— 名字/路径里写着省赛/邀请赛；
      · `qoj:ucup-title`（C）—— 标题写着 `Universal Cup`（那是这场**自己**的名字）；
      · `qoj:no-category`（B 结构）—— QOJ 上**真的没挂分类**（我提交过的补题场），只能落兜底；
      · `qoj:unclassified`（E 无依据）—— 有分类路径，但没有一条认得出来；
      · `qoj:shallow`（E）—— 路径说它是 ICPC，但**赛区读不出来** ⇒ 停在 `qoj/xcpc/icpc` 等人补。
    """
    paths = _as_paths(cats)
    cat_names = [str((c or {}).get('name') or '') for p in paths for c in p]
    cat_text = ' '.join(cat_names)
    name_list = [names] if isinstance(names, str) else list(names or [])
    name_text = ' '.join(str(n or '') for n in name_list)
    lowers = cat_text.lower()
    hit = [k for k in ('icpc', 'ccpc') if k in lowers]
    seg = _continent_seg(paths)
    # 这一场算不算 EC？（路径的赛区读到 `ec` / 路径里有 `ccpc` / 名字或路径里写着中国标志）
    # ⚠️ 判不出就当**不是** EC ⇒ 落回赛区那一支（`Polish Collegiate` 那种外国的全国赛
    #    就不会被说成"省赛"）。
    is_ec = (seg == 'ec') or ('ccpc' in lowers) \
        or is_ec_name(name_text) or is_ec_name(cat_text)
    xcpc, xcpc_rule = '', ''
    if is_ec and is_provincial_invitational(name_text, cat_text):
        # ★ 类型 + 主办两段**与 XCPC 侧同一份判据**（正交化成 4×3 = 12 类，
        #   见 `xcpc_common.PROVINCIAL_TYPES` / `PROVINCIAL_ORGS`）
        #   分类里"）：`qoj/xcpc/provincial&invitational/<主办>/<类型>/<official|warm-up>`；
        #   判不出 ⇒ `…/无归类`（**不补 phase**，与 icpc/ccpc 的"判不出"同一种写法）。
        #   ⚠️ **只喂赛名**：`cat_text`（分类路径）里那个
        #   `Chinese Provincial / Invitational Programming Contests` 是**分支名** —— 判成省赛
        #   正是靠它，拿它当"类型"证据会让这一支**每一场都变成"省赛暨邀请赛"**
        #   （实测踩到：自测里 `2023 广东…Provincial…` 被判成暨邀请赛）。
        #   而 `is_provincial_invitational()` 那一层**继续带 cat_text**（进不进这一支要看路径）。
        ptype = provincial_type_of(name_text)          # ⚠️ 只喂**赛名**，见下
        # ⚠️ 判不出来时 `provincial_type_of()` 返回的是 **`未归类`**（不是 `无归类`）——
        #    这一支是全仓库唯一写 `未归类` 的地方（见 `xcpc_common.PROVINCIAL_TYPE_NONE`）。
        #    ⚠️ 这里比的是 `PROVINCIAL_TYPE_NONE`：若比成 `STAGE_NONE`，那个分支**永远进不去**，
        #      `未归类` 会靠 else 混出去；比错了不会改结果，但读代码的人会以为它写 `无归类`。
        if ptype == PROVINCIAL_TYPE_NONE:
            xcpc, xcpc_rule = f'qoj/xcpc/{PROVINCIAL_SEG}/{PROVINCIAL_TYPE_NONE}', 'qoj:name-provincial'
        else:
            # 主办（IC/CC/IC&CC/无）单独一轴：`<主办>/<类型>` 两段
            xcpc = phase_of(f'qoj/xcpc/{PROVINCIAL_SEG}/{provincial_org_of(name_text)}/{ptype}', name_text)
            xcpc_rule = 'qoj:name-provincial'
    elif hit:
        if len(hit) > 1:
            msg = f'分类路径 «{" / ".join(cat_names)}» 同时过了 icpc 与 ccpc —— 取 icpc'
            if warns is not None:
                warns.append(msg)
            else:
                print(f'   ⚠️ {msg}')
        if hit[0] == 'icpc':
            if not seg:
                msg = (f'赛名「{name_text[:60]}」是 ICPC，但所有分类路径里的赛区都不在缩写表里'
                       f'（aa/ec/ap/aw/eu/la/na/ne）⇒ 停在 `qoj/xcpc/icpc`，等人补')
                if warns is not None:
                    warns.append(msg)
                else:
                    print(f'   ⚠️ {msg}')
                xcpc, xcpc_rule = 'qoj/xcpc/icpc', 'qoj:shallow'
            else:
                stage = stage_of(name_text, 'icpc', warns, name_text)
                xcpc = phase_of(f'qoj/xcpc/icpc/{seg}/{stage}', name_text)
                xcpc_rule = 'qoj:path-icpc'
        else:
            stage = stage_of(name_text, 'ccpc', warns, name_text)
            xcpc = phase_of(f'qoj/xcpc/ccpc/{stage}', name_text)
            xcpc_rule = 'qoj:path-ccpc'
    is_ucup = bool(title) and bool(re.search(QOJ_UCUP_PATTERN, str(title), re.I))
    if is_ucup:
        # ★ 标题写着 UC ⇒ 这一份读法是 `qoj/ucup`；xcpc 那份作为第二列（用不用由 `build_tree` 定）
        return (QOJ_UCUP_CLASS, 'qoj:ucup-title'), (xcpc, xcpc_rule)
    if xcpc:
        return (xcpc, xcpc_rule), ('', '')
    # 都不过 ⇒ `qoj/无归类`：**QOJ 上真没挂分类**（B 结构）与"有分类但认不出"（E 无依据）
    # 是两件事 —— 前者是客观事实（我提交过的补题场），后者是判据不够。
    return ('qoj/无归类', 'qoj:no-category' if not paths else 'qoj:unclassified'), ('', '')


def qoj_identities(cats, names, warns: list | None = None, title: str = '') -> tuple:
    """
    QOJ 场次的**两份读法**（只要分类那两列）：`(这一份读法, xcpc 读法或 '')`。

    判据只有一处：`qoj_identity_rules()`（那边同时把**分类依据规则 id** 带回来，
    写进元列 `分类依据`）—— 这里只是取前两列，**不许再写一遍判定**。
    ⚠️ 老调用方/单测用的是这个签名（`build_tree()` 用带规则 id 的那个）。
    """
    (cls, _rule), (xcpc, _xcpc_rule) = qoj_identity_rules(cats, names, warns, title)
    return cls, xcpc


def qoj_class_of(cats, names, warns: list | None = None, title: str = '') -> str:
    """只要**标题那一份读法**（`qoj_identities()` 的第一个）—— 单测/老调用方用这个。"""
    return qoj_identities(cats, names, warns, title)[0]


def _dedup_paths(paths) -> list:
    """路径去重（同一条路径可能在 tree 与 own 里各出现一次；按"段名序列"认同一性）"""
    out, seen = [], set()
    for p in paths or []:
        key = tuple(str((c or {}).get('id') or '') for c in (p or []))
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(list(p))
    return out


def _as_paths(cats) -> list:
    """把 `cats` 归一成"多条路径"（`[[{id,name},…], …]`）—— 兼容"一条扁平路径"的老形状"""
    if not cats:
        return []
    if isinstance(cats[0], dict):
        return [list(cats)]
    return [list(p) for p in cats if p]


def _continent_seg(paths) -> str:
    """从所有路径里读 icpc 的**赛区**段（`ec`/`eu`/`jp`）；读不出 ⇒ `''`"""
    names = {str((c or {}).get('name') or '').strip().lower() for p in paths for c in p}
    for key, seg in QOJ_CONTINENT_SEG:
        if key in names:
            return seg
    return ''


def _path_mentions_branch(path) -> bool:
    """这条路径过 icpc / ccpc 吗（**挂树位置**优先选过的那条，别让分类与落点打架）"""
    text = ' '.join(str((c or {}).get('name') or '') for c in (path or [])).lower()
    return 'icpc' in text or 'ccpc' in text


def _path_mentions_provincial(path) -> bool:
    """这条路径是**省赛/邀请赛**那一支吗（QOJ 的目录名叫 `Chinese Provincial / Invitational…`）"""
    text = ' '.join(str((c or {}).get('name') or '') for c in (path or [])).lower()
    return ('provincial' in text or 'invitational' in text
            or '省' in text or '市' in text or 'collegiate' in text)


def _path_for_class(paths, cls) -> list:
    """
    给一条分类挑**最匹配的那条路径**当挂树位置（找不到就返回 `[]` ⇒ 落兜底 S）。

    · 省赛/邀请赛那一支 ⇒ 找写着 `Provincial / Invitational` 的那条；
    · 其余（icpc/ccpc）⇒ 找过 `icpc/ccpc` 的那条。
    ⚠️ 别一律用"过 icpc/ccpc 的那条"：省赛那批**根本没有 icpc 路径**（它们的目录就叫
    `Chinese Provincial / Invitational`），一律找 icpc 会把节点扔进「（QOJ 上没挂分类）」那个兜底 S 里。
    """
    if PROVINCIAL_SEG in str(cls or ''):
        return next((p for p in paths if _path_mentions_provincial(p)), [])
    return next((p for p in paths if _path_mentions_branch(p)), [])


def _add_contest_records(crate: Crate, cid: str, ck: str, records: list[dict],
                         warns: list[str]) -> None:
    """铺一场的 P 与 R（题目清单来自归档的场次页；提交随后补/覆盖）"""
    def pkey(pid: str) -> str:
        return f'{ck}:p:{pid}'

    # 题号字母**只是附带信息**（树里的位置按题目 id 认），来源只有一处：
    # 归档场次页解析出来的题目清单（`qoj_contest_problems.json`）。
    # ⚠️ 不要另建第二份题号缓存（如 `qoj_problem_letters.json`，`--letters-only`）——
    # 两个缓存装的是同一份题号（都从同一页解析），两条真源只会漂。
    # （读一次，别在循环里反复读盘 —— `contest_problems_of` 每次都重新读 JSON。）
    problems = contest_problems_of(cid) or {}
    per_problem: dict = {}
    for pid, info in problems.items():
        per_problem[str(pid)] = {
            'problem_id': info.get('letter') or '',
            'name': info.get('name') or '',
            'link': info.get('link') or '',
        }

    seen: set = set()
    vp_by_user: dict = {}           # 用户名 → VP 场次集合（惰性读缓存）
    #: 拿不到绝对时刻而被**丢弃**的提交数（两种来头分开数：源页只给相对时间 / 其它空值）
    dropped_rel = 0
    dropped_other = 0
    for r in records:
        sid = _s(r.get('提交ID'))
        if not sid:
            warns.append(f'场次 {cid}：有一条缺 提交ID，跳过')
            continue
        if sid in seen:
            warns.append(f'场次 {cid}：提交 {sid} 在文件里出现多次，已去重')
            continue
        seen.add(sid)

        pid = problem_id_of(r)
        # 字母从**该场的题目清单**里查（上面那份唯一真源）；查不到就看这条提交自带的题号
        letter = (problems.get(str(pid), {}) or {}).get('letter', '') if pid else ''
        if not letter:
            letter = norm_letter(r.get('题号'))
            if not LETTER_RE.match(letter or ''):
                letter = ''
        # 位置键：优先题目 id；没有 id 时退回字母（这一支只影响极端缺列的情况）
        key = pid or (f'letter:{letter}' if letter else '')
        if not key:
            warns.append(f'场次 {cid}：提交 {sid} 既没有题目 id 也没有题号，定位不到父题目，跳过')
            continue

        # 账户线索：这条提交是**谁**提交的。应用不认识 `提交者` 这个列名 ——
        # 它只拿 `{source, field, value}` 去查账户注册表里的映射（使用方维护），
        # 这里只负责**如实搬运**，不做判断。
        clue = _s(r.get('提交者'))
        # 提交性质：按**这个人**的 VP 名单判（缓存惰性读，一个人只读一次）
        if clue and clue not in vp_by_user:
            vp_by_user[clue] = vp_contests_of(clue)
        vp_box = vp_by_user.get(clue, set())
        # ★ 提交时间**拿不到绝对时刻 ⇒ 丢弃这条提交 + 警告**（用户 2026-10-15 定的口径：
        #   "这种应该是丢弃提交并警告，而不是整包建不了"）。
        #   来头：场次页对**参与窗口内**的提交给的是比赛内相对时间（`00:31:01`），绝对时刻只有
        #   全局按人列表页（`/submissions?submitter=X`）才有 —— 抓一次就补齐，所以这属于"原料没抓全"。
        #   ⚠️ **别改成"写个空 time 留在包里"**：`time` 在 `field-registry.json` 里是 `required`
        #      ⇒ 体检会判"真缺"并非零退出 ⇒ 整条链停在体检那一步（实测：`R.time 缺 12` ⇒ 重建失败、
        #      树一动不动）。**一条拿不到时间的提交，代价不该是整包建不了。**
        #   ⚠️ 也**不是**"把相对时间写进 time"：`acTime` 是字符串比较 ⇒ 它会挑出一个凭空的时间。
        #   ⚠️ 判据用 `is_relative_time`（crate 里那唯一一份），只为把警告**分类**说清；
        #      真正决定丢不丢的是"有没有拿到绝对时刻"。
        sub_key = f'{ck}:sub:{sid}'
        _raw_time = _s(r.get('提交时间'))
        _abs_time = normalize_time(_raw_time)
        if not _abs_time:
            if is_relative_time(_raw_time) or _s(r.get('相对提交时间')):
                dropped_rel += 1
            else:
                dropped_other += 1
            continue
        crate.submission(
            pkey(key),
            sub_key,
            status=normalize_status(r.get('结果')),
            time=_abs_time,
            link=_s(r.get('提交链接')),
            # 运行信息：QOJ 给的是 `95ms` / `4956kb` / `2.0kb`，这里**归一成毫秒/字节**
            # （与 CF 口径一致），界面上才好横向比。`language` 只有全局列表页
            # （`/submissions?submitter=X`）才有这一列 —— 比赛页没有就如实为空，不编。
            language=(_s(r.get('使用语言')) or None),
            timeUsed=(to_millis(r.get('时间')) or None),
            memoryUsed=(to_bytes(r.get('内存')) or None),
            codeLength=(to_bytes(r.get('代码长度')) or None),
            submitKind=(submit_kind_of(clue, cid, vp_box) or None),
            **({'账户线索': {'source': 'qoj', 'field': '提交者', 'value': clue}} if clue else {}),
        )
        # QOJ 这一侧的题面信息（链接 + 题名）—— 就挂在这棵树自己的题目上
        info = per_problem.setdefault(key, {})
        if letter:
            info['problem_id'] = letter
        pname = _s(r.get('题目名称'))
        plink = _s(r.get('题目链接'))
        if plink:
            info['link'] = plink
        if pname:
            info['name'] = pname

    # ---- 拿不到绝对时刻的提交：**丢弃 + 说清去哪补**（口径见上面那段注释） ----
    if dropped_rel or dropped_other:
        parts = []
        if dropped_rel:
            parts.append(f'{dropped_rel} 条源页只给了**比赛内相对时间**'
                         '（场次页对参与窗口内的提交就是这样；绝对时刻只有全局按人列表页才有）')
        if dropped_other:
            parts.append(f'{dropped_other} 条**提交时间是空的/认不出**')
        warns.append(f'场次 {cid}：' + '、'.join(parts) + ' ⇒ **这些提交已丢弃**（不写进包）')
        if dropped_rel:
            warns.append('补绝对时刻（抓一次就够，之后不用再丢）：'
                         'py "acm-data/raw/Scaper/04 qoj/QOJ_submissions_scraper.py" '
                         '--fetch --submitter <用户名> --cache-mode none')

    # ---- 题目节点：题目 id 就是它的身份，认不出时 problemId 退化成这个 id ----
    for key in sorted(per_problem):
        info = per_problem[key]
        crate.problem(ck, pkey(key),
                      problem_id=(info.get('problem_id') or key),
                      **({k: v for k, v in (('link', info.get('link')), ('name', info.get('name'))) if v}))


def default_submissions_file() -> str:
    """
    默认的 QOJ 提交文件：清单里那几场**共用同一份**（`04 qoj/qoj_submissions.json`）。

    这里只借清单拿到路径 —— QOJ 包出哪些场次**不看清单**（见 `build_tree`）。
    """
    manifest = load_manifest('')
    for c in manifest.get('contests') or []:
        for s in (c.get('submissions') or []):
            if (s.get('source') or '') == 'qoj' and s.get('file'):
                return resolve(s['file'])
    return resolve('qoj_submissions.json')


def main(argv):
    ap = argparse.ArgumentParser(description='QOJ → crate 片段（整棵树：W/S/C/P/R）')
    ap.add_argument('-o', '--output', default='')
    ap.add_argument('--file', default='', help='临时指定提交 JSON（默认用清单里那几场共用的那份）')
    ap.add_argument('--tree', default='', help='临时指定分类树缓存')
    add_cli_args(ap, force_help='**强制重抓**（本适配器**只读本地提交文件与分类树缓存**'
                                '（清单里那份 / `--file` / `--tree`）⇒ 对它没有额外作用；'
                                '要重抓提交请跑 `04 qoj/QOJ_submissions_scraper.py --fetch`）')
    args = ap.parse_args(argv)
    configure_from(args)

    path = args.file or default_submissions_file()
    if not path or not os.path.isfile(path):
        print(f'❌ 找不到提交文件：{path}', file=sys.stderr)
        return 1
    records = load_records(path)
    crate, warns = build_tree(records)
    out = args.output or os.path.join(CACHE, 'crate_qoj_tree.json')
    if not crate.records:
        # ⚠️ 上游空转一次（提交文件被截断）不能把已归档的整个 qoj 源抹掉，
        #    而这一趟还报成功：走统一口径 —— 留旧 + 出声（两种都返回 0：非零会把整条链掐断）。
        return empty_source_result(out, warns)
    crate.save(out)
    problems = sum(1 for r in crate.records if r['节点类型'] == 'P')
    print(f'✅ {rel(out)}   {crate.summary()}'
          f'\n   （{len(tree_contest_ids())} 场来自分类树；题目 {problems} 个）')
    for w in warns[:20]:
        print('   ⚠️', w)
    if len(warns) > 20:
        print(f'   ⚠️ …另有 {len(warns) - 20} 条同类的警告')
    issues = validate_crate(crate.to_dict())
    # 这棵树是**自足**的（W/S/C/P/R 都在本包里），所以"父节点"类的校验问题不再是
    # 片段的正常现象 —— 它就是错，照常报红。
    if issues:
        print(f'❌ 校验问题 {len(issues)}：')
        for it in issues[:20]:
            print('   •', it)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
