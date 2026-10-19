#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
XCPC（ICPC/CCPC/省赛/校赛…）工具的公共工具函数（**只有这里一份**）

和 `02 hdu/lib/hdu_common.py`、`01 nk/lib/nk_common.py` 同一个套路。

XCPC 与那两个平台最大的不同：**一场比赛的数据来自多个来源**
（榜单：PTA / rankland(srk) / xcpcio / rankland 网页；提交：CF / QOJ / PTA），
所以身份（extKey）必须由**外部世界的 slug** 决定，而不是自行编号。

extKey 方案（已拍板，导入后不可改）
----------------------------------
    xcpc                                    平台（W）
    xcpc:s:<series>                         系列      如 icpc / ccpc / provincial / ucup
    xcpc:s:<series>:<mid>                   中间层    如 icpc2026 / bj（年份或省份）
    xcpc:c:<slug>                           比赛      如 icpc2026preliminary-2
    xcpc:c:<slug>:p:<letter>                题目      A/B/C…
    xcpc:c:<slug>:sub:<source>:<id>         提交      source = cf|qoj|pta

为什么 C 用 slug：XCPC 各场**没有统一编号**，而 rankland 的 srk-collection
已经为每场维护了一个稳定 slug（自带系列+年份，如 `icpc2026preliminary-2`），
直接采用它的，不另行编号。

本文件**不 import 任何项目内模块**（只用标准库），所以谁 import 它都不会成环。
"""

from __future__ import annotations

import json
import os
import re
import sys

# 通用区（`Scaper/lib/`）：**并集口径**（`scope`）与**统一环节模块**（`stages`）都住在那儿
# —— 04 qoj 与 05 xcpc 互不依赖，放任一方的 `lib/` 都会让另一方反向依赖。
# ⚠️ 本文件开头写的"不 import 任何项目内模块"在 `scope` 进来时就已经不成立了；
#    把路径放在最前面，是为了让下面那条 `CLASS_STAGE` 声明（模块级构造）能在 import 期拿到它。
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', 'lib')))

import stages as _stages  # noqa: E402  —— 统一环节模块（判据 + 依据 + 记账）

# ================================================================
# 路径
# ================================================================

HERE = os.path.dirname(os.path.abspath(__file__))          # …/05 xcpc/lib
SPEC = os.path.dirname(HERE)                               # …/05 xcpc
REPO = os.path.abspath(os.path.join(SPEC, '..', '..', '..', '..'))
NODES = os.path.join(REPO, 'acm-data', 'nodes')
CACHE = os.path.join(SPEC, 'cache')                        # 下游抓来的原始文件
MANIFEST = os.path.join(SPEC, 'xcpc_contests.json')        # 场次清单（人工维护）

#: CF gym 白名单（人工维护：这是"打过哪些 gym"）
#  ⚠️ **路径只有这一处**：谁要读它就 import 这个常量，别在各自文件里再拼一遍
#     （5 个文件各写一行 `os.path.join(HERE, 'gym_whitelist.json')` 时挪一次要改 5 处）。
#     `xcpc_registry.py` / `gen_gym_manifest.py` / `cf_adapter.py`
#      / `cf_board_adapter.py` / `fetch_my_gyms.py` 都从这里取。
GYM_WHITELIST = os.path.join(SPEC, 'gym_whitelist.json')

# ================================================================
# extKey（**唯一一份**）
# ================================================================
#
# **XCPC 那棵"合并树"不再产出** —— 各渠道各自一棵树，
# 收在 W `aux`（辅助节点）下面：
#
#     O ─(W)aux「辅助节点」─(W)aux-pta ─(S)<系列>─(S)<年份/阶段>─(C)<slug>─(P)<题号>─(R)<提交 id>
#                          ─(W)aux-rankland（index 与 refs 两种数据都挂它）
#                          ─(W)aux-xcpcio ─(W)aux-nk ─(W)aux-srk
#
# 为什么键写成 `aux-pta` 而不是 `aux:pta`：`src/utils/similarity.js` 判"是不是同一棵树"
# 只看 extKey 的**第一段**（跨树重复**故意跳过**）。写成 `aux:pta` 的话五棵树第一段都是
# `aux` ⇒ 同一场比赛在各渠道树里各有一份会被当成"包内重复"刷警告。
# `aux-pta` 让第一段仍然是"树身份"，同时父子关系照样能摆成 `aux → aux-pta`。
#
# ⚠️ 各适配器**开头必须调 `use_tree(source)`** 定下这次产出在哪棵树上；没设就报错
#    （绝不静默落回 `xcpc:` —— 那等于把刚拆掉的那棵树又拼回来）。
AUX_ROOT = 'aux'
AUX_ROOT_NAME = '辅助节点'

#: 平台 / 辅助容器的**显示名来自上面这张表（常量）**，不是"某一场比赛给的" ⇒
#: 名字那一格的出处统一写它。⚠️ **必须显式写**：`crate.py` 里条目的出处**缺省 = 本包的来源 id**，
#: 而这些根容器**每棵子树的片段都会顺手声明一遍** ⇒ "谁先被合并进来"就决定了名字的出处
#:（实测：13 个根容器里 7 个的 `name` 出处被盖成 `xcpcio-bjcpc2024` /
#: `cf-web-ccpc2019final` 这种**某一场比赛**的 id —— 语义不对，而且输入顺序一换就换一个）。
ROOT_SRC = 'xcpc-common'
#: `crate.platform(..., **PLATFORM_NAME_SRC)`：把"名字的出处"钉成上面那个常量
PLATFORM_NAME_SRC = {'字段来源': {'name': ROOT_SRC}}


def root_name_src(crate) -> dict:
    """
    共享根容器的 `name` 该带的 kwargs —— **顺便把这个来源 id 登记进本包**。

    为什么两件事必须一起做（实测）：`字段来源` 里出现一个 `source.sources`
    查不到 kind 的 id 时，`crate-invariants` 冒烟直接红（"来源表覆盖记录里用到的每个来源"）。
    所以别只写死那一格，还得让合并后的包知道 `xcpc-common` 是什么类别（derived）。
    """
    crate.declare_source(ROOT_SRC, kind='derived', label='构建期常量（平台/辅助容器的显示名）')
    return dict(PLATFORM_NAME_SRC)

# 渠道 → (它那棵树的 W 键, 显示名)。键就是 `aux-<渠道名>`。
AUX_TREES = {
    'pta': ('aux-pta', 'PTA'),
    'nk': ('aux-nk', '牛客'),
    'srk': ('aux-srk', 'srk'),
    'xcpcio': ('aux-xcpcio', 'xcpcio'),
    # rankland 的两个适配器（index = 赛程索引/题单，refs = 仓库&榜单链接）合成一棵树
    'rankland-index': ('aux-rankland', 'rankland'),
    'rankland-refs': ('aux-rankland', 'rankland'),
    # CF 正式比赛的**复用题合成节点**（"放辅助节点-cf-contest-…"）——
    # 为什么另起一棵：合成节点是"跨场的代表"，挂在老家那场下面会让人以为它属于那一场
    # （"放在原位置其实不合适"）。真比赛树 `cf` 里那份 C/P/R 一个都不动。
    # ⚠️ 名字就是**平台的名字**（'辅助节点下的"CF 正式比赛"改名为"Codeforces"'）
    'cf-contest': ('aux-cf-contest', 'Codeforces'),
}

# 渠道 → (它那棵树的 W 键, 显示名)，但**直接挂在 O 下**（不进辅助节点）。
# "Atcoder 不应该在辅助节点里..." ⇒ **挂不挂 aux 由各渠道自己决定**；
# 已经在 AUX_TREES 里的那几个（pta/nk/srk/xcpcio/rankland）**保持原状**，一个都不动。
PLATFORM_TREES = {
    'atcoder': ('atcoder', 'AtCoder'),
}

_TREE = ''          # 当前进程在产出的那棵树（`use_tree` 设一次）
_TREE_NAME = ''
_TREE_UNDER_AUX = True   # 这棵树挂不挂「辅助节点」（`open_tree` 用）


def use_tree(source: str) -> str:
    """
    定下这次产出在哪棵树上。**适配器开头必须调一次**。

    @returns 那棵树的 W 键（`aux-<渠道>` 或顶层平台键），调用方拿去挂 `crate.platform(...)`
    """
    global _TREE, _TREE_NAME, _TREE_UNDER_AUX
    src = str(source or '')
    if src in AUX_TREES:
        key, name, under_aux = AUX_TREES[src][0], AUX_TREES[src][1], True
    elif src in PLATFORM_TREES:
        key, name, under_aux = PLATFORM_TREES[src][0], PLATFORM_TREES[src][1], False
    else:
        key = ''
    if not key:
        raise ValueError(f'未知的渠道 {source!r} —— 要接新渠道就在 xcpc_common 的 '
                         f'AUX_TREES / PLATFORM_TREES 加一行')
    _TREE, _TREE_NAME, _TREE_UNDER_AUX = key, name, under_aux
    return key


def _tree() -> str:
    if not _TREE:
        raise RuntimeError('还没定下产出在哪棵树上 —— 适配器开头要调 use_tree(source)')
    return _TREE


def platform_key() -> str:
    return _tree()


def tree_name() -> str:
    """当前那棵树在树上的显示名（PTA / 牛客 / rankland / xcpcio / srk）"""
    _tree()
    return _TREE_NAME


def open_tree(crate, source: str) -> str:
    """
    把 crate 的骨架铺好：

      · 辅助渠道（`AUX_TREES`）：`O ─(W)aux「辅助节点」─(W)aux-<渠道>`（**保持原状**）
      · 顶层平台（`PLATFORM_TREES`）：`O ─(W)<渠道>`（AtCoder 不进辅助节点）

    @returns 那棵树的键（后面 `series_key/contest_key/…` 自动跟着它走）
    """
    tree = use_tree(source)
    if _TREE_UNDER_AUX:
        crate.platform(AUX_ROOT, name=AUX_ROOT_NAME, **root_name_src(crate))
        crate.platform(tree, name=tree_name(), parent=AUX_ROOT, **root_name_src(crate))
    else:
        crate.platform(tree, name=tree_name(), **root_name_src(crate))
    return tree


def series_key(sid: str) -> str:
    return f'{_tree()}:s:{sid}'


def mid_key(sid: str, mid: str) -> str:
    return f'{_tree()}:s:{sid}:{mid}'


def contest_key(slug: str) -> str:
    return f'{_tree()}:c:{slug}'


#: 年份层取不到年份时的兜底名（合成节点容器的年份层也叫这个 —— 容器键在
#: `src/core/synthPlan.js` 算、`scripts/synth-bind.mjs` 铺；两处都叫这个词，别各造一个）
YEAR_FALLBACK = '年份未知'


def year_mid(year) -> str:
    """年份层的 mid 段（`2020`；取不到 ⇒ `年份未知`，**不静默丢**）"""
    return str(year or '').strip() or YEAR_FALLBACK


def year_series_key(series: str, year) -> str:
    """
    **年份层**的键 = **系列键 + `:` + 年份**：
    `cf:s:cf-contest:2020`（真比赛树）/ `aux-cf-contest:s:cf-contest:2020`（辅助树那份镜像）。

    用户："两处的 cf-contest 再套一层**比赛时间所在的年份**" —— 两处 = 真比赛树那条
    系列（527 场 C）与辅助树那份镜像；键与层名都走这一个函数，别在两处各拼一遍。

    ⚠️ 参数是**系列键**（不是系列 id）：cf 树不是用 `use_tree` 建的，靠 `_tree()` 拼键会炸
    （实测：`还没定下产出在哪棵树上`）。
    """
    return f'{series}:{year_mid(year)}'


# ================================================================
# ★ **树上的层怎么铺** —— 唯一一份实现
#
# 需求（四条，逐条对应下面这些函数）：
#   ① "xcpc（省赛区域赛除外）都按赛季分，按年分有歧义"
#      + "省赛下分类只有一层地点，同地点的不同年已经按时间排好了，不用再套一层时间"
#      + "icpc/ec 赛区 和 ccpc，其下分类只有一层赛季，每个赛季内的比赛已经按时间排好了，
#        不用套什么 reg/final 层"
#      + "但如果有热身赛，在赛季内再开一个热身赛系列，专门放热身赛用"
#   ③ "ucup 就别分了" + "别加 2019 2026 的赛季系列层"（⇒ UCup / 无归类**不加时间层**）
#   ④ "cf gym …抄 qoj"（⇒ gym 也走这一套：系列 → 赛区/地点 → 赛季）
#
# 于是"一个 XCPC 场次挂在哪"只有四条规则（**层数越少越好**，能靠同层时间排序解决的
# 就不再套层 —— 排序规则见 `src/core/siblingOrder.js`）：
#
#   · `icpc/<赛区>/…`  ⇒  赛区层 → **赛季层** → 场次（+ 热身赛层）
#   · `ccpc/…`         ⇒  **赛季层** → 场次（+ 热身赛层）
#   · `省赛/邀请赛`     ⇒  **地点层** → 场次（**不套时间层**）
#   · `ucup` / `无归类` ⇒  **不套时间层**（保持它来源自己的分类）
#
# ⚠️ 「赛季优先、拿不到真赛季才退到举办年份」：不是所有系列都有赛季（CF 正式轮次、
#    AtCoder 都是 `无`；gym 的赛季就是举办年）⇒ `time_layer_label()` 一处兜住。
# ⚠️ 不用 `natureClass` 的**段**当层名（除了系列那一段）：QOJ 那边的层名是 QOJ 自己的
#    （`Asia East Continent` / `Zhejiang`），nature 这边的写法是抽象分类名；两棵树各说各的名字，
#    但**层的种类与顺序一致** —— 这就是"抄 qoj"。
# ================================================================

#: 树根里代表 XCPC 的那一段（判"这条 nature 是不是 XCPC 那一支"）
XCPC_SEG = 'xcpc'

#: 赛季内"专门放热身赛"的那一层（"如果有热身赛，在赛季内再开一个热身赛系列"）
WARMUP_LAYER = '热身赛'

#: 一个赛区底下"总决赛单独一层"（**只给含多个分赛区的赛区用**，见 `finals_layer_of`），
#: 且**排在赛区系列的最前面**。
#: 用户："Europe 下面那个 2026，去掉，换成 **Finals**（参考 qoj 做法），
#: 里面直接放比赛；Finals 在 Europe 系列的顶部"；再定：这一层**只给"含多个分赛区"的
#: 赛区**建（"final 只在存多赛区的 final 时使用"），别的赛区同一赛区内**只按赛季分**。
FINALS_LAYER = 'Finals'

#: 省赛/邀请赛那一支用 `PROVINCIAL_SEG`（下面定义，与 Trie 里那一段同名）—— 它**不套时间层**


def class_segments(cls: str) -> list:
    """分类路径 → 段（`qoj/xcpc/icpc/ec` → `['qoj','xcpc','icpc','ec']`）"""
    return [p for p in str(cls or '').split('/') if p]


def is_real_year(value) -> bool:
    """
    是不是真的年份 —— **口径与应用侧同一份**（`src/core/natureFields.js` 的 `isRealYear`：
    `^20\\d{2}$`）。`无` / `待同步` / `不确定` / 空 / **19xx** 都不算。

    ⚠️ 这个函数本文件里**定义过两遍**
    （另一份还有 `(19|20)`），Python 后定义者胜 ⇒ 19xx 会被当成真年份铺出年份层，
    而应用侧与 `scripts/nature-rehome.mjs` 都把它写成「年份未知」—— 同一格两套判法。
    现在**只有这一处**，且与应用侧一致。
    """
    return bool(re.fullmatch(r'20\d{2}', str(value or '').strip()))


def is_xcpc_class(cls: str) -> bool:
    """
    这条 nature 是不是 `(?/)xcpc` 那一支（"暂时只对 nature 属于 (?/)xcpc 的生效"）。
    ⚠️ 看**段**而不是子串：`xcpc/…`、`qoj/xcpc/…`、`cf/gyms/xcpc/…` 都算；末尾那段是 `xcpc`
    不算（那叫"停在半路"，没到能定位置的地方）。
    """
    segs = class_segments(cls)
    return XCPC_SEG in segs and segs.index(XCPC_SEG) < len(segs) - 1


def xcpc_tail(cls: str) -> list:
    """分类里 `xcpc` 之后的那几段（`cf/gyms/xcpc/icpc/ec` → `['icpc','ec']`）；不是那一支 ⇒ 空"""
    segs = class_segments(cls)
    if not is_xcpc_class(cls):
        return []
    return segs[segs.index(XCPC_SEG) + 1:]


def is_final_class(cls: str) -> bool:
    """
    这一场是不是**总决赛**（`…/final/…`；`championship` 也算 —— 见 `stage_of()`）。

    赛区底下总决赛要单独一层 `Finals`（排在赛区系列的最前面）。
    """
    segs = xcpc_tail(cls)
    return 'final' in segs


def finals_layer_of(cls: str, region_has_subregions: bool = False) -> str:
    """
    这一支的总决赛要不要**单独一层 `Finals`** ⇒ 返回层名（不要 ⇒ 空串）。

    （用户）："**所有 xcpc 赛制的比赛，同一赛区内只用分赛季**，不应出现任何
    regional/final；**eu 赛区有 final 是因为 eu 赛区又含多个分赛区，final 只在存多赛区的
    final 时使用**" ⇒ 判据 = 这一场的**赛区层底下还留着子赛区**（`region_has_subregions`）。
    实测只有 eu（Europe → Central / Northwestern / Southeastern Europe）是这种；
    na / la / ap 底下没有子赛区 ⇒ 它们的总决赛跟别的场次一样，只按赛季分。

    ⚠️ `region_has_subregions` 由调用方算（QOJ 那边看的是"分类树里这一层底下还留着哪些
    子分类"，见 `qoj_adapter._regions_with_subregions`）—— 别在这里猜渠道结构。
    ⚠️ EC 那一支永远不会进来（`ec` 底下是**城市**层，被 `QOJ_SITE_LAYER_PARENTS` 跳掉 ⇒
    不算子赛区），与 ① 说的"EC 其下只有一层赛季"一致。
    """
    segs = xcpc_tail(cls)
    if not segs or segs[0] != 'icpc' or not is_final_class(cls):
        return ''
    return FINALS_LAYER if region_has_subregions else ''


def is_warmup_class(cls: str) -> bool:
    """热身赛（`…/warm-up` —— 见 `phase_of()`）"""
    return 'warm-up' in class_segments(cls)


def tree_time_layer(cls: str, season='', year='') -> tuple:
    """
    该不该套"时间层"，套的话叫什么 ⇒ `(段, 层名)`；**不套 ⇒ `('', '')`**。

    规则：
      · `ucup` / `无归类` ⇒ **不套**（"ucup 就别分了" + "别加 2019 2026 的赛季系列层"）；
      · 其余（含**省赛**）⇒ **赛季优先**（"按年分有歧义"），赛季不是真 `20xx` 才退到
        举办年份，两个都不行 ⇒ `年份未知`（不静默丢）。
        ⚠️ 省赛的层是"只按**地点**一层"改成的：
        "关于省赛我改主意了，由于 nature 已填好（包括赛季），**分类换为仅赛季一层**
        （同赛季内一样要排序）" ⇒ 地点层不再建，改为赛季层（同赛季内靠时间排序）。

    @param season - `natureSeason`（赛季年；`无` / `待同步` / 空都算"没有"）
    @param year - `natureYear`（举办年份）
    """
    segs = xcpc_tail(cls)
    if not segs:
        return ('', '')
    head = segs[0]
    if head in ('ucup', '无归类', '未归类'):   # 两种都算[归不进去/没判出来] ⇒ 都不套时间层
        return ('', '')
    label = season if is_real_year(season) else (str(year or '').strip() if is_real_year(year) else '')
    return (year_mid(label), year_mid(label))


def xcpc_area_layer(cls: str) -> tuple:
    """
    赛区层 ⇒ `(段, 层名)`；没有 ⇒ `('', '')`。

    `xcpc/icpc/ec/final` ⇒ `('ec','ec')`；`xcpc/icpc`（停在半路）⇒ `('','')`；
    `ccpc` / 省赛 那一支也 ⇒ `('','')`（它们没有赛区这一层）。
    """
    segs = xcpc_tail(cls)
    if len(segs) < 2 or segs[0] != 'icpc':
        return ('', '')
    return (segs[1], segs[1])


def xcpc_series_layer(cls: str) -> tuple:
    """
    系列层 ⇒ `(段, 层名)`；**不是 XCPC 那一支 ⇒ `('', '')`**。

    `icpc/<赛区>` ⇒ `('icpc', 'icpc')` + 赛区层；`ccpc` ⇒ `('ccpc', 'ccpc')`；
    省赛/邀请赛 ⇒ `('provincial&invitational', '省赛与邀请赛')`；`ucup` / 别的 ⇒ 原样那一段。
    """
    segs = xcpc_tail(cls)
    if not segs:
        return ('', '')
    head = segs[0]
    if head == PROVINCIAL_SEG:
        return (PROVINCIAL_SEG, '省赛与邀请赛')
    return (head, head)


def problem_key(slug: str, letter: str) -> str:
    return f'{_tree()}:c:{slug}:p:{norm_letter(letter)}'


def submission_key(slug: str, source: str, sid) -> str:
    """提交的 key 带**来源**：cf / qoj / pta 的 ID 空间互不相干，混在一起会撞"""
    return f'{_tree()}:c:{slug}:sub:{source}:{sid}'


# ================================================================
# CF gym 那棵树
# ================================================================
#
#     O ─(W)cf ─(S)cf gym ─(S)<系列>[:<赛区>] ─(S)<年份> ─(C)<gym id> ─(P)<题号> ─(R)<提交 id>
#
# 具体形状见 `cf_board_adapter.gym_parent_of()`（唯一一份）：`cf:s:cf-gym:icpc:ec:2021`、
# `cf:s:cf-gym:ccpc:2024`、`cf:s:cf-gym:provincial&invitational:2023`。
# ⚠️ 这里**不画** `… ─(S)cf gym ─(S)xcpc ─…`：**那个 `xcpc` 层根本没有**（真包 27 个
#    `cf:s:cf-gym*` 键里一个都不带它）。同理不留 `CF_XCPC_SERIES` /
#    `CF_XCPC_SERIES_NAME` 这类零引用常量（它们会让人以为那层存在，照着接线
#    就会建出重复的系列层）。
#
# 为什么另起一棵：CF 这一侧的信息是**自足**的（gym 主页=补题入口、榜单、题名与题链接、
# 提交与运行信息），所以不必挂到主树的题目上。要不要与主树那场算同一场**不由导入决定**——
# 两边各自成节点，用户在「判重整理」页填 `映射元素值` 绑定（与 QOJ 那棵树同一套）。

CF_PLATFORM = 'cf'
#: 平台节点的显示名 —— "O 下的「CF」叫「Codeforces」"
#: （`O` = 总览那棵树；`CF` 是内部简称，树上是给人看的，写全名）
CF_PLATFORM_NAME = 'Codeforces'
CF_GYM_SERIES = 'cf:s:cf-gym'
CF_GYM_SERIES_NAME = 'cf gym'


def cf_gym_key(gym) -> str:
    """CF gym 的比赛节点：身份就是 **gym id**（如 102431）"""
    return f'{CF_PLATFORM}:c:{gym}'


def cf_problem_key(gym, letter: str) -> str:
    return f'{cf_gym_key(gym)}:p:{norm_letter(letter)}'


def cf_submission_key(gym, sid) -> str:
    return f'{cf_gym_key(gym)}:sub:{sid}'

# ================================================================
# 系列（**唯一一份**）
# ================================================================
#
# **省赛与邀请赛合成一个系列** `provincial-invitational`。
# 为什么：这两类**经常合办**（"CCPC 全国邀请赛（南昌）暨江西省赛"、"吉林省赛暨全国邀请赛"），
# 从赛名看不出该算哪一类 —— 分不干净就别分。24 场邀请赛被 rankland 的目录结构带着
# 散在 icpc(8) / ccpc(12) / provincial(4) 三处，同一场性质两年还分法不同
# （`ccpc2025invitational-northeast` 在 CCPC、`northeastcpc18th` 在省赛）。
#
# ⚠️ 层 id 仍沿用 `provincial<年>`（**别改**：改了已导入的子树会对不上、变成重复节点），
#    只有**显示名**跟着系列走。

SERIES_NAMES = {
    'icpc': 'ICPC',
    'ccpc': 'CCPC',
    'provincial-invitational': '省赛与邀请赛',
    'other': 'XCPC 其他',
}

# rankland 树的顶层目录名 → 系列 id（照抄，不改语义）
SERIES_FROM_RANKLAND = {
    'icpc': 'icpc',
    'ccpc': 'ccpc',
    'provincial': 'provincial-invitational',
    'university-level': 'other',
    'ucup': 'other',
}


def series_name(sid: str) -> str:
    """系列 id → 显示名（认不出的一律 `XCPC 其他`）"""
    return SERIES_NAMES.get(str(sid or ''), 'XCPC 其他')


# ================================================================
# 「性质」四字段：**XCPC 这一侧的唯一判据**（规格）
#
# 要求："原料处理脚本一定要给节点的性质归类，并尽可能填好一些基础信息，
#           以缩小比较范围。" / "至少原料脚本要先填好大类，方便用户在主脚本筛选补全。"
#
# 判据（写清楚"哪些算、哪些不算"，别一刀切）
# ------------------------------------------
# · **大类 `natureMain` = 办赛平台 / 赛系**，`xcpc` 是**赛系**（ICPC/CCPC/省赛/邀请赛
#   这一家）而不是收集源 ⇒ 05 xcpc 里**每一个 C**都写 `xcpc`，**包括**
#   xcpcio / rankland / srk 三个**收集源**的树：那些树是"数据从哪儿来"，
#   与"这场比赛是哪家的"无关（crate.py 的大类词表里**故意没有** xcpcio/rankland/srk，
#   就是为了不让收集源冒充性质）。推不出来的场次**留空**，不写占位。
# · **小类 `natureSub` 只填"1:1 能定"的那两个**：系列 icpc → `icpc`、ccpc → `ccpc`
#   （系列本身就是这个结论，不需要看赛名）。省赛/邀请赛那一系列（id
#   `provincial-invitational`）**故意留空**：它把省赛与邀请赛合成一处，单看系列
#   分不出是哪一个，而看赛名判"是不是邀请赛"会踩到两类坑 ——
#     * 合办场（"2025北京市大学生程序设计竞赛暨小米杯全国邀请赛"）两个小类**同时成立**，
#       词表里那个 `省赛与邀请赛` 才是它，但那要靠"真读过赛名"的人来定；
#     * 赛名里带"邀请赛"却不以邀请赛为主、或省赛名里根本没这两个字的场次也有。
#   所以这一系列的小类交给**主脚本人工补全**（空着比猜错好）。
# · **年份 `natureYear`** 只从**清单里已有的结构性数据**取：`mid.id`（形如
#   `provincial2024` / `icpc2026`，清单构造时就带年份），再退到赛名里第一个 20xx。
#   都不写（`2026.09.13 10:00` 这种开赛时间**不当年份来源**：赛季年 ≠ 举办年，
#   实测 EC-Final/World Finals 常在次年办，用它会把年份填错）。
# · **地区 `natureRegion` 一律留空**：xcpcio 目录里的 `beijing` / `shanghai` 是**拼音
#   目录名**，转成"北京/上海"是**猜**（同一目录名还可能是一个省/一个城市/一个赛区）；
#   词表**故意不穷举**地区（自由值），所以这里不填，交给主脚本或以后有中文名时再补。
# ================================================================

# 系列 id → **分类路径的后续段**（**只列 1:1 能定的**；没列到的一律停在 `xcpc`）。
# ⚠️ `provincial-invitational` **故意不在表里**（省赛/邀请赛/合办三种情况分不开，见上）：
#    那些场次的分类就写 `xcpc`（停在第一段 = "知道是 XCPC，还没细分"），
#    由人去 ③「性质待补」里补 —— 这比硬塞一个 `无归类` 诚实。
NATURE_CLASS_FROM_SERIES = {
    'icpc': 'xcpc/icpc',
    'ccpc': 'xcpc/ccpc',
}

# ================================================================
# **继续往细里判** —— icpc / ccpc 下面按"阶段"再分一层
#
#   · rankland / xcpcio / pta 等**收集源**只收录 **EC（亚洲东大陆）赛区**的比赛
#     ⇒ 这些来源的 `xcpc/icpc` 直接细化成 `xcpc/icpc/ec`（`ccpc` 没有这一步）；
#   · 再往下按**赛名**判阶段（顺序就是下面这个顺序）：
#       网络赛 / 网络预选赛 / Online  ⇒ `pre`
#       Final / 总决赛                 ⇒ `final`
#       Regional / 区域赛 / 區域賽     ⇒ `regional`
#       都没有                        ⇒ `无归类`
#   · ⚠️ 赛名同时命中两类及以上：**警告 + 取声明顺序里的第一个**。
#     需求是"警告并随机取值"，这里**故意不随机** —— 随机下去同一份数据两次跑出两个结果，
#     "重跑幂等 / 逐条可复现"就没了；按声明顺序取第一个，警告里写明"取的是哪个、因为什么"。
#   · `ccpc` 除了省掉 EC 这一步，阶段判定与 icpc **完全一致**（用户："下一级的确定逻辑与 icpc 一致"）。
# ================================================================

#: **不**只收 EC 赛区的来源（默认空 = 所有 XCPC 渠道都按"只收 EC"处理）。
#  用户点名："rankland / xcpcio / pta 等网站都只收录 ec 赛区的比赛"。
#  哪天发现某个来源其实还收了别的赛区，就把它的 channel 名加进来 ——
#  那个来源的 `xcpc/icpc` 会**停在 `xcpc/icpc`**（合法前缀，交给 ③ 补），不会硬塞 `ec`。
NON_EC_SOURCES = ()

#: 阶段关键词 → 段名（**顺序 = 命中多个时的取值顺序**）
#: ⚠️ `female` / `vocational` **只属于 ccpc**（用户："先判有无『女生』子串，
#:   记 ccpc/female；再判有无『高职』子串，记 ccpc/vocational"）。
#: ⚠️ `final` 那条有个**否定后顾**：`Pre-Finals Workshop`（莫斯科训练营，QOJ 常把它作为
#:    **变体名**挂在区域赛上）里的 "Finals" **不算总决赛** —— 实测 `qoj:c:911`
#:    （The 2021 ICPC Asia Macau **Regional** Contest，变体名 `Moscow Pre-Finals Workshops 2022 Day 3`）
#:    因为这条顺序（final 在 regional 之前）被误判成 `ec/final`，与 XCPC 侧同一场的
#:    `regional` 打架。判据 = "final 前面不是 `pre ` / `pre-`"。
STAGE_PATTERNS_ICPC = (
    ('pre', r'网络赛|网络预选赛|online'),
    # ⚠️ `championship` 也是**总决赛**的关键词：ICPC 各赛区的**总决赛**就叫
    #    `<region> Championship`（实测 QOJ 那 5 场 `The 2026 ICPC Europe Championship` /
    #    `The 2025 ICPC North America Championship` / Latin America 那场）—— 判不出来时
    #    一律落 `无归类`，于是它们**没有"总决赛"这个身份**，`Finals` 层也就无从谈起。
    ('final', r'(?<!pre[\s\-])final|总决赛|championship'),
    # ⚠️ `区域`（不带"赛"）这条：`xcpc/icpc/ec/无归类` 里那 4 条全是分站赛，
    #    名字写作「…亚洲区域西安站」「亚洲区域合肥站」—— 中文里"区域"就是 regional，
    #    不补这一条它们永远停在"判不出来"。`区域赛`/`區域賽` 本来就含子串"区域" ⇒ 一并覆盖。
    # ⚠️ `onsite` / `site` 同理（为 **cf gym**）：那边的分站赛写作
    #    `… Qinhuangdao Onsite` / `… Weihai Site`（**没有 "Regional" 三个字**），
    #    而"现场赛"就是分站赛（对应网络赛 pre）。`\bsite\b` 带词边界，碰不到 website 之类。
    ('regional', r'regional|区域|區域|onsite|现场赛|\bsite\b'),
)
STAGE_PATTERNS_CCPC = (
    ('female', r'女生'),
    ('vocational', r'高职'),
    ('pre', r'网络赛|网络预选赛|online'),
    ('final', r'(?<!pre[\s\-])final|总决赛|championship'),
    ('regional', r'regional|区域|區域|onsite|现场赛|\bsite\b'),
)

#: 「正式赛 / 热身赛」—— XCPC 每一支再分的最后一层（用户：
#: "我发现若干『热身赛/Warm up/Warm-up/Warming up』… xcpc 的各分支还要细分 official/warm-up"，
#: 并选定"每个阶段叶子下再分、现有场次一律迁成 …/official"）。
#: ⚠️ 判据是**赛名**：热身赛的赛名里就写着 warm up / 热身（实测 QOJ 那 4 场：
#: `The 2023 ICPC Asia East Continent Final Contest (EC-Final 2023). Warm Up`、
#: `第十一届中国大学生程序设计竞赛总决赛（热身赛）`）。
PHASE_OFFICIAL = 'official'
PHASE_WARMUP = 'warm-up'
WARMUP_PATTERNS = r'warm[\s\-_]*up|warming|热身'

#: 「regional 的第二个判据」（用户："两侧的 regional 判定再加上
#:  [同时含『中国大学生程序设计竞赛』子串但不含『总决赛』子串] 的条件"）。
#: 例：`第六届中国大学生程序设计竞赛（秦皇岛）正式赛` —— 没有"区域赛"三个字，但它就是分站赛。
REGIONAL_ALIAS = r'中国大学生程序设计竞赛'
REGIONAL_ALIAS_EXCLUDE = r'总决赛'

#: 「省赛 / 邀请赛」关键词（用户：名字含这些就当省赛/邀请赛）——**不区分大小写**
#: ⚠️ 在用户给的清单（`省` / `市` / `provincial` / `collegiate` / `invitational`）之外，
#:    这里多收了**同一个词的另外两种写法**：**`province`**（`The 2024 ICPC in Hubei Province, China`）
#:    与 **`邀请`**（`2023 年中国大学生程序设计竞赛全国邀请赛（湖南）`，`邀请赛` 就是 invitational）。
#:    用户自己写了"都不区分大小写"，要的显然是概念而不是这几个字面词。
#:    ⚠️ 剩下那些"没有这些字面词但看着像省赛"的（如 `第七届广西大学生程序设计大赛`）**故意不收** ——
#:    那要靠明确给出词（`大赛`？省名？），不该放宽成模糊匹配。
#: ⚠️ **`collegiate` 要排除两个"其实是全称"的写法**（实测踩到）：
#:    `China Collegiate Programming Contest` 是 **CCPC** 的全称、
#:    `International Collegiate Programming Contest` 是 **ICPC** 的全称 ——
#:    它们当然含 `Collegiate`，不排除的话 `2019 China Collegiate Programming Contest Final`
#:    与 `2023 - 2024 International Collegiate Programming Contest, Macau` 都会被判成
#:    **省赛/邀请赛**（因为这条判据现在**排最前面**，见 `xcpc_class_of`）。
#:    ⇒ 三个否定后顾：前面是 `china `/`chinese `/`international ` 的 `collegiate` 不算。
#:    （`Jiangsu Collegiate Programming Contest` 这类照样算省赛 ✓）
PROVINCIAL_PATTERNS = (r'省|市|provincial|province'
                       r'|(?<!china )(?<!chinese )(?<!international )collegiate'
                       r'|invitational|邀请')

#: 省赛的**第二 / 第三条判据**：
#:   · 含「大学生程序设计**大赛**」而不含「中国大学生程序设计大赛」⇒ 省赛
#:     （`第七届广西大学生程序设计大赛` 这种没有"省/市"字面词的也算）；
#:   · 含「大学生程序设计**竞赛**」而不含「中国大学生程序设计竞赛」⇒ 省赛
#:     （`第二十届东北地区大学生程序设计竞赛`；`中国大学生程序设计竞赛` 是 CCPC 那条线 ⇒ 不算）。
#: ⚠️ 排除串加长了（**这是必要的**）：这条判据现在**排最前面**，而
#:    「…**国际**大学生程序设计竞赛亚洲区域赛（焦作站）」这种 **ICPC 区域赛的中文名**
#:    也含「大学生程序设计竞赛」、又不含「中国大学生程序设计竞赛」—— 照字面会全被判成省赛
#:    （实测一下动了 70 多条！）。所以排除串里还要挡掉 **ICPC 那边的标志词**：
#:    `ICPC` / `ACM` / `亚洲` / `Asia` / `Regional` / `区域`。
#:    ⚠️ **故意不排除「国际」**：用户点过名的 `第八届广西大学生程序设计大赛暨2025中国-东盟国际
#:    大学生程序设计大赛` 里就有"国际"，排掉它就把真省赛弄丢了。
PROVINCIAL_ALIASES = (
    (r'大学生程序设计大赛', r'中国大学生程序设计大赛|ICPC|ACM|亚洲|Asia|Regional|区域'),
    (r'大学生程序设计竞赛', r'中国大学生程序设计竞赛|ICPC|ACM|亚洲|Asia|Regional|区域'),
)

#: 省赛 / 邀请赛那一段的名字（Trie 里的段名）
PROVINCIAL_SEG = 'provincial&invitational'

#: 省赛/邀请赛的**类型**（3 类）与**主办**（4 档）——**正交两轴**，合起来 12 种。
#:
#: 用户（起因：河南 2026 那组把「第 8 届 CCPC 河南省赛」与「第 17 届 ICPC 河南省赛」
#: 并成了一场 —— 两场 `natureClass` **逐字相同**，因为 `省赛` 那一支不记录主办）：
#: "省赛/邀请赛分支，可能得正交分为 4*3 类：IC/CC/IC&CC/(无) × 省赛/邀请赛/省赛暨邀请赛"。
#:
#: ⇒ 分类串从 `xcpc/provincial&invitational/<类型>/official`（`IC邀请赛`/`CC邀请赛`
#:   把主办混进了类型）改成 **`xcpc/provincial&invitational/<主办>/<类型>/official`**。
#:   主办放类型**前**面，与 `xcpc/<赛系>/<赛区>/<阶段>` 的既有层序一致。
#: ⚠️ `省赛暨邀请赛` 仍排最前（"两个都有"必须比单挑先判，见 `PROVINCIAL_TYPE_PATTERNS`）。
#: ⚠️ 定义放在这里（而不是挨着用它的 `xcpc_class_rule`）：`PHASED_LEAVES` 要按它拼路径，
#:    那个常量在上面就该定了（放后面会在模块导入时 NameError）。
PROVINCIAL_TYPES = ('省赛暨邀请赛', '省赛', '邀请赛')

#: 主办那一段的 4 档。⚠️ **`IC&CC` 排最前**（用户："先判 IC&CC"）——
#: 与类型轴"`省赛暨邀请赛` 排最前"同一条道理：**"两个都有"是更具体的结论，必须先判**，
#: 否则会被 `IC` / `CC` 单挑先吃掉。这个顺序也是 Trie 叶子与界面筛选的先后。
PROVINCIAL_ORGS = ('IC&CC', 'IC', 'CC', '无')

#: 一个都没命中时的阶段段名（"判过了，这一支里没有它可归的一项"）
STAGE_NONE = '无归类'
#: ★ **省赛那一支的类型判不出，是唯一写 `未归类` 的地方**（用户：
#:   「未归类」暂时只在省赛的失配中出现，其他都是默认无归类）—— 它 = **填写不完全**
#:   （应用里蓝、等人补）；其余一切判不出都写 `无归类`（灰 = 判过了的结论）。
PROVINCIAL_TYPE_NONE = '未归类'
#: ★ **上游异常**（用户：「像『获取数据失败』这种上游异常的情况，nature 可以用
#:   『上游异常』（灰）补充」）—— 抓不到那一页 / 上游本身坏了 ⇒ **不是「等人补」**，
#:   而是「这一格判不了」：应用里显示成**灰**（特殊的「已填」）、判冲突时当作没有主张。
UPSTREAM_ERROR = '上游异常'

#: **会被再分一层 `official` / `warm-up` 的那几个叶子**（= Trie 里 children 恰好是
#: `{"official": {}, "warm-up": {}}` 的那些节点）。见上面 `PHASE_*` 的注释。
#: ⚠️ 这份清单必须与 `acm-data/nature-registry.json` 一致 —— `crate.py selftest` 有断言钉住
#:    （逐个比对 Trie 里"只有 official/warm-up 两个孩子"的节点）。
#:    · 「无归类」**不在**里面 —— 它的意思是"这一支里没有它可归的一项"，再分正式/热身没有意义；
#:    · 停在浅处的路径（如 `xcpc/icpc`）也不加 —— Trie 里那一段没有这两个孩子。
PHASED_LEAVES = (
    # icpc 的 8 个赛区结构一致：`<赛区>/<阶段>/<official|warm-up>`
    # （用户给的缩写，见 https://qoj.ac/category/17；`jp` 已并进 `ap`）
    'xcpc/icpc/aa/pre', 'xcpc/icpc/aa/regional', 'xcpc/icpc/aa/final',
    'xcpc/icpc/ec/pre', 'xcpc/icpc/ec/regional', 'xcpc/icpc/ec/final',
    'xcpc/icpc/ap/pre', 'xcpc/icpc/ap/regional', 'xcpc/icpc/ap/final',
    'xcpc/icpc/aw/pre', 'xcpc/icpc/aw/regional', 'xcpc/icpc/aw/final',
    'xcpc/icpc/eu/pre', 'xcpc/icpc/eu/regional', 'xcpc/icpc/eu/final',
    'xcpc/icpc/la/pre', 'xcpc/icpc/la/regional', 'xcpc/icpc/la/final',
    'xcpc/icpc/na/pre', 'xcpc/icpc/na/regional', 'xcpc/icpc/na/final',
    'xcpc/icpc/ne/pre', 'xcpc/icpc/ne/regional', 'xcpc/icpc/ne/final',
    'xcpc/ccpc/female', 'xcpc/ccpc/vocational', 'xcpc/ccpc/pre',
    'xcpc/ccpc/regional', 'xcpc/ccpc/final',
    # ★ 省赛那一支**多了"类型"那一段** ⇒ 补 phase 的名单也要跟着换；
    #   ★ 正交化后是 **`<主办>/<类型>` 两段**（4×3 = 12 条，`IC邀请赛`/`CC邀请赛` 已不是合法分类）
    *[f'xcpc/{PROVINCIAL_SEG}/{o}/{t}' for o in PROVINCIAL_ORGS for t in PROVINCIAL_TYPES],
)


def is_warmup(contest_name: str) -> bool:
    """这一场的赛名是不是写着"热身赛"（`warm up` / `warming up` / `热身`，都不区分大小写）"""
    return bool(re.search(WARMUP_PATTERNS, str(contest_name or ''), re.I))


# ----------------------------------------------------------------
# ICPC 赛区（8 个，官方缩写）—— 从**赛名**里读
#
# 用途：**cf gym**（那边的分类器只能靠赛名，见 `cf_board_adapter.gym_class_of`）。
# ⚠️ QOJ 那边**不用**它：QOJ 的分类路径里有权威的赛区目录名（`QOJ_CONTINENT_SEG`），
#    赛名只是兜底，别把"权威路径"降级成"猜赛名"。
# ⚠️ 缩写表来自 `https://qoj.ac/category/17`：
#    aa=Africa & Arab / ec=Asia East Continent / ap=Asia Pacific / aw=Asia West /
#    eu=Europe / la=Latin America / na=North America / ne=Northern Eurasia。
# ----------------------------------------------------------------

#: 赛名里直接写着赛区的词 → 段名（**先比这些**）
REGION_WORDS = (
    ('asia east continent', 'ec'),
    ('east continent', 'ec'),
    ('ec regionals', 'ec'),
    ('ec-final', 'ec'),
    ('ec final', 'ec'),
    ('asia pacific', 'ap'),
    ('japan', 'ap'),
    ('asia west', 'aw'),
    ('europe', 'eu'),
    ('neerc', 'eu'), ('nwerc', 'eu'), ('cerc', 'eu'), ('seerc', 'eu'), ('swerc', 'eu'),
    ('north america', 'na'), ('naipc', 'na'),
    ('latin america', 'la'),
    ('africa', 'aa'),
    ('northern eurasia', 'ne'),
)

#: 赛名里写的是**城市**时的对照（中国/港澳臺的城市 ⇒ ec；日本的城市 ⇒ ap）
#: ⚠️ 这份表是"照着实测赛名抄的"，不是穷举 —— 遇到没收录的（新的站）就返回 `''`，
#:    调用方**停在浅处**（`cf/gyms/xcpc/icpc`）等人补，绝不乱猜一个赛区。
EC_CITIES = (
    'beijing', 'changchun', 'chengdu', 'chongqing', 'guangzhou', 'guilin', 'harbin',
    'hefei', 'hong kong', 'jinan', 'jiaozuo', 'kunming', 'macau', 'nanchang', 'nanjing',
    'nanning', 'qingdao', 'shanghai', 'shenyang', 'shenzhen', 'shijiazhuang', 'taiyuan',
    'tianjin', 'wuhan', 'xian', "xi'an", 'xuzhou', 'yinchuan', 'zhengzhou', 'zhuhai',
    'weihai', 'hangzhou', 'jinhua', 'shaoxing', 'ningbo', 'wenzhou', 'xiamen', 'fuzhou',
    'changsha', 'xiangtan', 'huangshan', 'suzhou', 'wuxi', 'zibo',
)
JP_CITIES = ('yokohama', 'tsukuba', 'tokyo', 'sendai', 'kyoto', 'osaka', 'nagoya',
             'sapporo', 'ookayama', 'aobayama', 'hongo', 'sumiyoshi')


def region_of_name(contest_name: str) -> str:
    """
    从**赛名**读 ICPC 赛区（`ec`/`ap`/`eu`/… ，读不出返回 `''`）。

    两条判据，按顺序：
      ① 赛名里直接写着赛区词（`Asia East Continent` / `Asia Pacific` / `Europe` / `NEERC`…）；
      ② 赛名里写的是城市（`Asia Jiaozuo Regional` → ec；`Asia Yokohama Regional` → ap）。
    ⚠️ 读不出就返回空串 —— **不猜**（调用方停在浅处等人补）。
    """
    text = str(contest_name or '').lower()
    for word, seg in REGION_WORDS:
        if word in text:
            return seg
    for city in EC_CITIES:
        if city in text:
            return 'ec'
    for city in JP_CITIES:
        if city in text:
            return 'ap'
    return ''


# ================================================================
# 「地区」（natureRegion）—— 举办地：城市 / 省名，线上赛写 `无`
#
# 用户：835 个空地区"果然还是太多了"，于是让管线按规则填。
# 口径（当天定的）：
#   · **统一成中文城市 / 省名**（`Nanjing` → 南京、`Sichuan` → 四川）——
#     统一写法筛选/建组才聚得起来（别名问题是 `docs/field-rules.md`（别名） 点名"最急"的那条）；
#   · **网络赛 / Online / 网络预选赛 ⇒ `无`**（没有场地是事实，不是"还没判"）；
#   · **Universal Cup ⇒ `不需要`**；**本身是英文写法的国外地名（日本/欧美各站）也 ⇒ `不需要`**
#     （用户："等等 ucup 还是直接填无吧" → 又改成：
#      "本身是英文的地名就不要了,不需要,加个『不需要』的字段" + "ucup…可以填『不需要』"）；
#   · **读不出就留空**（不猜：空 = 还没判，照旧挂在 ③ 等人补）。
#
# ⚠️ 这张表**只服务地区字段**，别拿它去改赛区判定（那是 `region_of_name()` 的
#    `REGION_WORDS` / `EC_CITIES` / `JP_CITIES`，两件事不要混）。
# ⚠️ 顺序有意义：**长词在前**（`xiangtan` 必须排在 `xian` 前面，否则"湘潭"会被读成"西安"）。
# ================================================================

#: 「地区」取值表：`(赛名里出现的写法, 统一写法, 种类)`，
#: 种类 ∈ `city`（中国城市，写中文）/ `province`（中国省名·大区，写中文）/ `foreign`（本身是
#: 英文写法的国外地名 ⇒ 写 `不需要`，不翻译）。
PLACE_PATTERNS = (
    # ---- 中国城市（英文写法）----
    ('shijiazhuang', '石家庄', 'city'), ('qinhuangdao', '秦皇岛', 'city'),
    ('xiangtan', '湘潭', 'city'), ('changchun', '长春', 'city'), ('changsha', '长沙', 'city'),
    ('changzhou', '常州', 'city'), ('haikou', '海口', 'city'), ('shenyang', '沈阳', 'city'),
    ('shenzhen', '深圳', 'city'), ('nanchang', '南昌', 'city'), ('nanning', '南宁', 'city'),
    ('nantong', '南通', 'city'), ('nanjing', '南京', 'city'), ('yancheng', '盐城', 'city'),
    ('hangzhou', '杭州', 'city'), ('ningbo', '宁波', 'city'), ('wenzhou', '温州', 'city'),
    ('jinhua', '金华', 'city'), ('shaoxing', '绍兴', 'city'), ('taizhou', '台州', 'city'),
    ('huzhou', '湖州', 'city'), ('hefei', '合肥', 'city'), ('wuhu', '芜湖', 'city'),
    ('bengbu', '蚌埠', 'city'), ('huainan', '淮南', 'city'), ('zhengzhou', '郑州', 'city'),
    ('jiaozuo', '焦作', 'city'), ('luoyang', '洛阳', 'city'), ('yinchuan', '银川', 'city'),
    ('lanzhou', '兰州', 'city'), ('taiyuan', '太原', 'city'), ('baoding', '保定', 'city'),
    ('tangshan', '唐山', 'city'), ('chengdu', '成都', 'city'), ('mianyang', '绵阳', 'city'),
    ('kunming', '昆明', 'city'), ('guiyang', '贵阳', 'city'), ('wuhan', '武汉', 'city'),
    ('ganzhou', '赣州', 'city'), ('harbin', '哈尔滨', 'city'), ('dalian', '大连', 'city'),
    ('jinan', '济南', 'city'), ('qingdao', '青岛', 'city'), ('weihai', '威海', 'city'),
    ('yantai', '烟台', 'city'), ('zibo', '淄博', 'city'), ('guilin', '桂林', 'city'),
    ('guangzhou', '广州', 'city'), ('zhuhai', '珠海', 'city'), ('suzhou', '苏州', 'city'),
    ('wuxi', '无锡', 'city'), ('xuzhou', '徐州', 'city'), ('xiamen', '厦门', 'city'),
    ('quanzhou', '泉州', 'city'), ('fuzhou', '福州', 'city'), ("xi'an", '西安', 'city'),
    ('xian', '西安', 'city'), ('nanyang', '南阳', 'city'), ('beijing', '北京', 'city'),
    ('shanghai', '上海', 'city'), ('tianjin', '天津', 'city'), ('chongqing', '重庆', 'city'),
    ('hong kong', '香港', 'city'), ('hongkong', '香港', 'city'), ('macau', '澳门', 'city'), ('macao', '澳门', 'city'),
    # ★ 用户："HK 映射地名 香港" —— **只认这一种紧凑写法**（`ACM-HK` / `HK Regional`）：
    #   裸 `hk` 太容易误伤（`hkd` / 别的缩写），所以写成两种安全形状，不做"任意子串里找 hk"。
    ('acm-hk', '香港', 'city'), (' hk ', '香港', 'city'), ('(hk)', '香港', 'city'), ('hk regional', '香港', 'city'),
    # ---- 国外城市（UC 各站 / 亚洲其它站；QOJ 与 gym 里出现过）----
    ('wroclaw', '弗罗茨瓦夫', 'foreign'), ('wrocław', '弗罗茨瓦夫', 'foreign'),
    ('warsaw', '华沙', 'foreign'), ('pyongyang', '平壤', 'foreign'),
    ('ürümqi', '乌鲁木齐', 'city'), ('urumqi', '乌鲁木齐', 'city'),
    ('petrozavodsk', '彼得罗扎沃茨克', 'foreign'), ('moscow', '莫斯科', 'foreign'),
    # ---- 国外**赛区/国家名**（本身是英文写法 ⇒ 同样 `不需要`）----
    # ⚠️ 这些必须排在 `northeast` 前面（`Northeastern Europe` 里含 `northeast`，
    #    否则会被读成中国的「东北」）—— 长词在前这条规矩在这里同样要守。
    ('central europe', '中欧', 'foreign'), ('northwestern europe', '西北欧', 'foreign'),
    ('northeastern europe', '东北欧', 'foreign'), ('southeastern europe', '东南欧', 'foreign'),
    ('north america', '北美', 'foreign'), ('northern eurasia', '北亚', 'foreign'),
    ('latin america', '拉美', 'foreign'), ('polish', '波兰', 'foreign'),
    ('poland', '波兰', 'foreign'), ('ukraine', '乌克兰', 'foreign'),
    # 中国的「东北赛区」写法：`(Northeast)` / `Northeast China`
    ('northeast', '东北', 'province'),
    # ---- 港澳台 / 日本 / 国外（日文与国外城市）----
    # ⚠️ 日本与国外这些地名**本身是英文写法** ⇒ 用户："本身是英文的地名就不要了,
    #    不需要" ⇒ 种类的第三种 `foreign`：读到它就写 **`不需要`**，不去翻译成中文。
    ('taoyuan', '桃园', 'city'), ('taipei', '台北', 'city'), ('hsinchu', '新竹', 'city'),
    ('kaohsiung', '高雄', 'city'), ('tainan', '台南', 'city'), ('taichung', '台中', 'city'),
    ('yokohama', '横滨', 'foreign'), ('tsukuba', '筑波', 'foreign'), ('sendai', '仙台', 'foreign'),
    ('sapporo', '札幌', 'foreign'), ('nagoya', '名古屋', 'foreign'), ('ookayama', '大冈山', 'foreign'),
    ('aobayama', '青叶山', 'foreign'), ('sumiyoshi', '住吉', 'foreign'), ('hongo', '本乡', 'foreign'),
    ('tokyo', '东京', 'foreign'), ('kyoto', '京都', 'foreign'), ('osaka', '大阪', 'foreign'),
    # ---- 中国省级（英文写法）----
    ('heilongjiang', '黑龙江', 'province'), ('inner mongolia', '内蒙古', 'province'),
    ('neimenggu', '内蒙古', 'province'), ('guangdong', '广东', 'province'),
    ('guangxi', '广西', 'province'), ('sichuan', '四川', 'province'),
    ('shandong', '山东', 'province'), ('jiangsu', '江苏', 'province'),
    ('zhejiang', '浙江', 'province'), ('anhui', '安徽', 'province'),
    ('fujian', '福建', 'province'), ('jiangxi', '江西', 'province'),
    ('hubei', '湖北', 'province'), ('hunan', '湖南', 'province'),
    ('henan', '河南', 'province'), ('hebei', '河北', 'province'),
    ('shanxi', '山西', 'province'), ('shaanxi', '陕西', 'province'),
    ('liaoning', '辽宁', 'province'), ('jilin', '吉林', 'province'),
    ('guizhou', '贵州', 'province'), ('yunnan', '云南', 'province'),
    ('hainan', '海南', 'province'), ('gansu', '甘肃', 'province'),
    ('qinghai', '青海', 'province'), ('ningxia', '宁夏', 'province'),
    ('xinjiang', '新疆', 'province'), ('tibet', '西藏', 'province'),
    ('xizang', '西藏', 'province'),
    # ---- 中国省名 / 大区（中文写法；长词在前）----
    ('黑龙江', '黑龙江', 'province'), ('内蒙古', '内蒙古', 'province'),
    ('东北地区', '东北', 'province'), ('华北地区', '华北', 'province'),
    ('华东地区', '华东', 'province'), ('华南地区', '华南', 'province'),
    ('华中地区', '华中', 'province'), ('西北地区', '西北', 'province'),
    ('西南地区', '西南', 'province'), ('东北', '东北', 'province'),
    ('华北', '华北', 'province'), ('华东', '华东', 'province'), ('华南', '华南', 'province'),
    ('华中', '华中', 'province'), ('西北', '西北', 'province'), ('西南', '西南', 'province'),
    ('浙江', '浙江', 'province'), ('江苏', '江苏', 'province'), ('山东', '山东', 'province'),
    ('吉林', '吉林', 'province'), ('辽宁', '辽宁', 'province'), ('河北', '河北', 'province'),
    ('河南', '河南', 'province'), ('湖北', '湖北', 'province'), ('湖南', '湖南', 'province'),
    ('安徽', '安徽', 'province'), ('福建', '福建', 'province'), ('江西', '江西', 'province'),
    ('陕西', '陕西', 'province'), ('山西', '山西', 'province'), ('四川', '四川', 'province'),
    ('云南', '云南', 'province'), ('贵州', '贵州', 'province'), ('广西', '广西', 'province'),
    ('广东', '广东', 'province'), ('海南', '海南', 'province'), ('甘肃', '甘肃', 'province'),
    ('青海', '青海', 'province'), ('宁夏', '宁夏', 'province'), ('新疆', '新疆', 'province'),
    ('西藏', '西藏', 'province'), ('北京', '北京', 'city'), ('上海', '上海', 'city'),
    ('天津', '天津', 'city'), ('重庆', '重庆', 'city'), ('香港', '香港', 'city'),
    ('澳门', '澳门', 'city'), ('台湾', '台湾', 'province'),
    # ---- 中文城市（赛名里直接写着「成都站」这种）----
    ('石家庄', '石家庄', 'city'), ('秦皇岛', '秦皇岛', 'city'), ('哈尔滨', '哈尔滨', 'city'),
    ('长春', '长春', 'city'), ('沈阳', '沈阳', 'city'), ('大连', '大连', 'city'),
    ('济南', '济南', 'city'), ('青岛', '青岛', 'city'), ('郑州', '郑州', 'city'),
    ('西安', '西安', 'city'), ('兰州', '兰州', 'city'), ('银川', '银川', 'city'),
    ('太原', '太原', 'city'), ('成都', '成都', 'city'), ('昆明', '昆明', 'city'),
    ('武汉', '武汉', 'city'), ('长沙', '长沙', 'city'), ('南昌', '南昌', 'city'),
    ('合肥', '合肥', 'city'), ('南京', '南京', 'city'), ('苏州', '苏州', 'city'),
    ('无锡', '无锡', 'city'), ('徐州', '徐州', 'city'), ('杭州', '杭州', 'city'),
    ('宁波', '宁波', 'city'), ('温州', '温州', 'city'), ('金华', '金华', 'city'),
    ('厦门', '厦门', 'city'), ('福州', '福州', 'city'), ('广州', '广州', 'city'),
    ('深圳', '深圳', 'city'), ('珠海', '珠海', 'city'), ('桂林', '桂林', 'city'),
    ('南宁', '南宁', 'city'), ('贵阳', '贵阳', 'city'), ('南阳', '南阳', 'city'),
    ('威海', '威海', 'city'), ('绵阳', '绵阳', 'city'), ('青岛', '青岛', 'city'),
    # 缩写（自造标识里常见：`ZJCPC` = 浙江省赛）
    ('zjcpc', '浙江', 'province'), ('gdcpc', '广东', 'province'),
    # ---- 繁體写法也要认（值一律**简体** —— 用户："「澳門」改简体"）----
    ('澳門', '澳门', 'city'), ('臺灣', '台湾', 'province'), ('台北', '台北', 'city'),
    ('臺北', '台北', 'city'), ('桃園', '桃园', 'city'), ('臺中', '台中', 'city'),
    ('臺南', '台南', 'city'), ('新竹', '新竹', 'city'), ('高雄', '高雄', 'city'),
)

#: 地区这一维的"不适用"取值（线上赛没有场地）—— 与 `crate.py` 的约定一致（自由文本）
NATURE_REGION_NONE = '无'

#: 赛名里写着"线上"的词 ⇒ 地区 `无`（网络赛没有场地，这是事实不是猜）
ONLINE_PATTERNS = re.compile(r'网络赛|网络预选|线上赛|online|preliminary', re.I)


def place_of_name(contest_name: str) -> tuple:
    """
    从**赛名**读"举办地" → `(统一写法, 种类)`，
    种类 ∈ `'city'` / `'province'`（中国，写中文）/ `'foreign'`（本身是英文写法的国外地名）；读不出 → `('', '')`。

    ⚠️ 与 `region_of_name()` **不是一回事**：那个读的是**赛区**（ec/ap/eu，用来判分类），
    这个读的是**地区字段**（南京 / 四川 / 不需要）。
    ⚠️ 读不出就返回空 —— **不猜**（空 = 还没判，会照旧挂在 ③ 等人补）。
    """
    text = str(contest_name or '').lower()
    # ⚠️ **两遍扫：中国城市/省名优先于"外国英文地名"**（复盘异常时逮到的一个真 bug）：
    #    QOJ 的 `name_text` 是**所有变体名拼起来**的，而 `qoj:c:1464` 的第二份名是
    #    `Petrozavodsk Winter 2024. Day 2. CCPC Contest 1` ⇒ 表里 foreign 那条排在「北京」**前面**、
    #    于是「2023 北京市大学生程序设计竞赛」被判成 `不需要`（还连带丢了省赛键）。
    #    表内顺序照旧守"长词在前"，只是把 foreign 挪到**第二遍**。
    for want_foreign in (False, True):
        for pat, value, kind in PLACE_PATTERNS:
            if (kind == 'foreign') is want_foreign and pat in text:
                return value, kind
    return '', ''


def is_online_class(cls: str) -> bool:
    """这条分类是不是"**网络赛**"那一档（`…/pre/official`、`…/pre/warm-up`、`…/pre`）？

    网络赛没有场地 ⇒ 地区 `无`。判据看**分类末段**（那是规则判出来的：
    `stage_of()` 认 `网络赛`/`Online`/`Preliminary`），而不是再猜一遍赛名。
    ⚠️ 只看"有没有 `/pre` 这一段"，**不把 warm-up 也算成线上** —— 热身赛通常就在正赛的场地办，
    它的场地按赛名读（读不出就留空等人补）。
    """
    bare = strip_mirror_prefix(str(cls or ''))
    return bare.endswith('/pre') or '/pre/' in bare


def region_of_contest(cls: str, contest_name: str, prefix: str = 'xcpc') -> tuple:
    """
    **地区字段的唯一产出点**（XCPC / gym / QOJ 三处共用）→ `(值, 规则id)`。

    口径（定稿）：
      ① **网络赛**（分类就是 `…/pre…`）⇒ `无`（那是"**网络赛没有场地，这是事实不是猜**"的
         **事实**）；
         ⚠️ **但"赛名里写着线上赛"不是 `无` 的理由**（用户："**线上赛填无的不是
         …你不用因为是线上就填无**"）：`2022 年江苏省大学生程序设计大赛（线上赛，南京师范大学）`
         的**省是对的**，被这条写成 `无` 时会连 `江苏` 都读不出来（`省赛键` 就缺地点）。
         ⇒ 现在先读地名，读得出就填地名（不管它是不是线上办）。
      ② **总决赛 / 女生专场 / 高职专场**（`is_tbd_region_class`）⇒ **`待填写`**
         （用户："ecfinal、ccfinal、ccpc 女生/高职场都用脚本填『待填写』，
         但**在判定层面被视为已填写**"—— 算填过了，只是值先摆着，想填时人工填）；
      ③ 赛名里读得出**中国城市/省名** ⇒ 统一成中文（`Nanjing` → 南京、`澳門` → 澳门）；
      ④ 读出的地名**本身是英文写法**（日本/欧美各站）⇒ **`不需要`**
         （用户："本身是英文的地名就不要了,不需要"—— 不翻译、也不留空）；
      ⑤ 都读不出 ⇒ `('', '')` —— 留空，等人补（**不猜**）。

    ⚠️ 顺序有意义：**待填写**那几类排在"读地名"前面（那几类一律先 `待填写`，
    别去猜）；网络赛那一档只看**分类**（不看赛名，见 ①）。

    `prefix` 只影响规则 id 的前缀（`xcpc:` / `gym:` / `qoj:`），三处共用同一份判据。
    """
    if is_online_class(cls):
        return NATURE_REGION_NONE, f'{prefix}:region-none'
    if is_tbd_region_class(cls):
        return NATURE_REGION_TBD, f'{prefix}:region-tbd'
    place, kind = place_of_name(contest_name)
    if kind == 'foreign':
        return NATURE_REGION_NOT_NEEDED, f'{prefix}:region-foreign'
    if place:
        return place, f'{prefix}:region-{kind}'
    return '', ''


#: 地区这一维的"没有场地"取值（网络赛 / 线上轮；`…/pre…`）—— 自由文本
NATURE_REGION_NONE = '无'

#: 地区这一维的"**不需要**"取值（用户："加个『不需要』的字段"）：
#: **本身是英文写法的国外地名**（日本/欧美各站）—— 这一维对它们不值得记（不翻译、也不留空）。
NATURE_REGION_NOT_NEEDED = '不需要'

#: 地区这一维的"**待填写**"取值（用户："ucup、ecfinal、ccfinal、
#: ccpc 女生/高职场都用脚本填『待填写』，**但在判定层面被视为已填写**"）。
#:
#: 语义：**这一维暂时由人不定期地填**（这几类的场地压根不在赛名里，或者填了也没多大用），
#: 但那不等于"还没判" —— 所以它算**填过了**（不会挂在 ③ 性质待补里等人"补"），
#: 想填的时候在 ③ 里按值筛出来填即可（填完是 `M`，回代会保住）。
NATURE_REGION_TBD = '待填写'

#: 「总决赛 / 女生专场 / 高职专场」这几种末段 —— 地区的 `待填写` 那一档（用户点名的 4 类；
#: `ucup` 是第 5 类，由 QOJ 那边单独判）。
TBD_REGION_LEAVES = ('final', 'female', 'vocational')


def is_tbd_region_class(cls: str) -> bool:
    """
    这条分类是不是"**地区暂时由人填**"的那几类（总决赛 / 女生专场 / 高职专场）？

    判据看**末段**（`…/final`、`…/final/official`、`…/final/warm-up`、`…/female/official`、
    `…/vocational/official`；镜像前缀 `qoj/`、`cf/gyms/` 照收）。
    ⚠️ 别用"名字里有没有城市"来判这几类 —— 这几类一律先 `待填写`
    （它们的场地本来就不在赛名里，范围也小，想填时人工填）。
    """
    bare = strip_mirror_prefix(str(cls or ''))
    segs = [s for s in bare.split('/') if s]
    if not segs:
        return False
    # 掐掉末层的 `official` / `warm-up`，看它上面那一段是不是 final/female/vocational
    if segs[-1] in (PHASE_OFFICIAL, PHASE_WARMUP):
        segs = segs[:-1]
    return bool(segs) and segs[-1] in TBD_REGION_LEAVES


#: **中国（EC）的省份 / 大区词** —— 用来回答"这一场是不是 **EC 的**省赛/邀请赛"。
#: 为什么要这一份（用户："省赛/邀请赛判定**只对 ec 赛区生效**"）：
#: `省赛/邀请赛` 是**中国**的概念（省、市、邀请赛），套到别的赛区上就是错的
#: —— 实测踩到 `The 2022 ICPC Polish Collegiate Programming Contest (AMPPZ 2022)`
#: （波兰的全国赛）因为名字里有 `Collegiate` 被判成"省赛"。
#: 而 gym 那边的省赛名字里**往往一个"ICPC"都没有**（`The 17th Zhejiang Provincial Collegiate
#: Programming Contest`），所以只能靠**省份/大区词**认 EC。
EC_REGION_WORDS = (
    # 英文省名（赛名里怎么写的都有，统一小写比）
    'zhejiang', 'jiangsu', 'shandong', 'heilongjiang', 'jilin', 'liaoning', 'hebei',
    'henan', 'hubei', 'hunan', 'anhui', 'fujian', 'jiangxi', 'shaanxi', 'shanxi',
    'sichuan', 'yunnan', 'guizhou', 'guangxi', 'guangdong', 'hainan', 'gansu',
    'qinghai', 'ningxia', 'xinjiang', 'tibet', 'inner mongolia', 'beijing', 'shanghai',
    'tianjin', 'chongqing', 'hong kong', 'macau', 'macao', 'taiwan',
    # 中文省名 / 大区（gym 与 QOJ 的中文赛名里常见）
    '浙江', '江苏', '山东', '黑龙江', '吉林', '辽宁', '河北', '河南', '湖北', '湖南',
    '安徽', '福建', '江西', '陕西', '山西', '四川', '云南', '贵州', '广西', '广东',
    '海南', '甘肃', '青海', '宁夏', '新疆', '西藏', '内蒙古', '北京', '上海', '天津',
    '重庆', '香港', '澳门', '台湾',
    '东北', '华东', '华南', '华中', '西南', '西北', '华北', '中国',
)

#: "这是中国（EC）的比赛"的**直接标志**（比省份词更硬）
EC_MARKERS = r'china|chinese|中国|ccpc'


def is_ec_name(contest_name: str) -> bool:
    """
    从**赛名**判断这一场是不是 **EC（Asia East Continent，中国那一支）** 的。

    三条判据（任一命中）：① 写着 `China` / `Chinese` / `中国` / `CCPC`；
    ② `region_of_name()` 读出 `ec`；③ 出现中国的省名/大区词（`Zhejiang` / `东北`…）。
    ⚠️ 判据不够时**返回 False**（"不确定"就当不是 EC）—— 省赛/邀请赛那支只对 EC 生效，
    宁可让它落回赛区那一支，也别把外国的全国赛说成"省赛"。
    """
    text = str(contest_name or '')
    if re.search(EC_MARKERS, text, re.I):
        return True
    if region_of_name(text) == 'ec':
        return True
    low = text.lower()
    return any(w in low for w in EC_REGION_WORDS)


#: **xcpc 子树的镜像前缀**：这些路径下面挂的是"同一棵 xcpc 子树"的副本
#: （`qoj/xcpc/…` 是 QOJ 侧、`cf/gyms/xcpc/…` 是 CF gym 侧）。
#: `phase_of()` 要先掐掉它们再比 `PHASED_LEAVES`，否则镜像里的阶段叶子**补不上**
#: `official`/`warm-up`（那会留下一堆"停在半路"的值 ⇒ 全挂在 ③）。
MIRROR_PREFIXES = ('qoj/', 'cf/gyms/')


def strip_mirror_prefix(cls: str) -> str:
    """掐掉**镜像前缀**（`qoj/`、`cf/gyms/`）—— 那些路径下面是同一棵 xcpc 子树。

    凡是要"按 xcpc 那套判据看这条分类"的地方（`phase_of` / `is_cross_year_leaf`…）
    都得先过这一手，否则镜像里的值匹配不上。
    """
    bare = str(cls or '')
    for pfx in MIRROR_PREFIXES:
        if bare.startswith(pfx):
            return bare[len(pfx):]
    return bare


def phase_of(cls: str, contest_name: str) -> str:
    """
    给一条分类路径补上最后一层 `official` / `warm-up`（**唯一实现**）。

    · 只有 `PHASED_LEAVES` 里那几个叶子会被补（其余原样返回：`无归类`、停在浅处的路径…）；
    · `qoj/` 与 `cf/gyms/` 这两个**镜像前缀**照收（它们下面是同一棵 xcpc 子树）。
    """
    base = str(cls or '')
    if strip_mirror_prefix(base) not in PHASED_LEAVES:
        return base
    return f'{base}/{PHASE_WARMUP if is_warmup(contest_name) else PHASE_OFFICIAL}'


def stage_of(contest_name: str, branch: str = 'icpc',
             warns: list | None = None, label: str = '') -> str:
    """
    赛名 → 阶段段名。

    · `branch='icpc'`：`pre`（网络赛/Online）→ `final`（Final/总决赛）→ `regional`（Regional/区域赛）；
    · `branch='ccpc'`：比 icpc **多两条**、且**优先级最高** —— `female`（女生）→ `vocational`（高职），
      其余与 icpc 完全一致；
    · **两侧的 `regional` 还有一个别名判据**：名字里同时含"中国大学生程序设计竞赛"**且不含**"总决赛"
      ⇒ 也算分站赛（用户点名的条件）；
    · 都没中 ⇒ `无归类`。

    ⚠️ 命中多个时**不随机**：按声明顺序取第一个，并给出警告（传了 `warns` 就追加，没传就打到 stdout）。
    需求是"警告并随机取值"，这里**故意不随机** —— 随机 = 同一份数据两次跑出两个结果，
    "重跑幂等 / 逐条可复现"就没了。
    """
    text = str(contest_name or '')
    patterns = STAGE_PATTERNS_CCPC if str(branch) == 'ccpc' else STAGE_PATTERNS_ICPC
    hit = [stage for stage, pat in patterns if re.search(pat, text, re.I)]
    if not hit and re.search(REGIONAL_ALIAS, text) and not re.search(REGIONAL_ALIAS_EXCLUDE, text):
        hit = ['regional']                 # 「中国大学生程序设计竞赛」这条例外别名
    if len(hit) > 1:
        msg = (f'赛名「{label or text}」同时命中 {"/".join(hit)} —— '
               f'按声明顺序取第一个（{hit[0]}）')
        if warns is not None:
            warns.append(msg)
        else:
            print(f'   ⚠️ {msg}')
    return hit[0] if hit else STAGE_NONE


def is_provincial_invitational(contest_name: str, extra_text: str = '') -> bool:
    """
    这一场是不是「省赛 / 邀请赛」？

    两条判据（任一命中即可）：
      ① 名字（QOJ 还会拼上**分类路径**）含 `省` / `市` / `provincial` / `province` /
         `collegiate` / `invitational` / `邀请`（都不区分大小写）；
      ② 见 `PROVINCIAL_ALIASES`：含「大学生程序设计大赛/竞赛」而**不含**对应的
         「中国大学生程序设计大赛/竞赛」（那是 CCPC 那条线）⇒ 也算省赛
         （`第七届广西大学生程序设计大赛`、`第二十届东北地区大学生程序设计竞赛` 这种
          没有"省/市"字面词的，靠这一条进来）。

    `extra_text` 给 QOJ 用：那边还要把**分类路径**拼进来一起看（路径里写着
    `Chinese Provincial / Invitational Programming Contests`）。
    """
    text = f'{contest_name or ""} {extra_text or ""}'
    if re.search(PROVINCIAL_PATTERNS, text, re.I):
        return True
    for alias, excluded in PROVINCIAL_ALIASES:
        # ⚠️ 两个都带 `re.I`：排除串里有 `ICPC` / `ACM` / `Asia` 这些**大小写混写**的词
        if re.search(alias, text, re.I) and not re.search(excluded, text, re.I):
            return True
    return False


#: 各类型的判据（**顺序即优先级**，命中即止）。英文写法与中文写法都认
#: （实测赛名两头都有：`The 2026 ICPC China Sichuan Provincial Programming Contest`、
#:  `Beijing Collegiate Programming Contest`、`The 2026 ICPC China Zhejiang Province …`、
#:  `第七届广西大学生程序设计大赛`（没有"省"字）、`湖南省第二十届大学生计算机程序设计竞赛`）。
#: 省赛的**类型**判据（"省赛 / 邀请赛 / 省赛暨邀请赛"三档）—— **这一张表就是唯一一份**。
#: ⚠️ 这里原来还有一行 `_PROVINCIAL_HAS = r'省|市|省赛|邀请'`（已删）：它没有任何引用，
#:    却是省赛关键词的**第三份手抄**（另两份是本表与 `PROVINCIAL_PATTERNS`）——
#:    谁按它改口径都不会生效，留着只会误导。
PROVINCIAL_TYPE_PATTERNS = (
    # ① 省赛暨邀请赛：**同一场既办了省赛、又办了邀请赛**（"…暨…省赛"）。三种写法都认：
    #    · 中文：「省/市」与「邀请」同一小句内（不许跨 `，。；`，窗口 **40 字** —— 实测
    #      `…广东省大学生程序设计竞赛暨"汇丰科技（中国）"中国大学生程序设计竞赛邀请赛…` 隔 26 字也中）；
    #    · 英文：`provincial`/`province`/`collegiate` ↔ `invitational`，**跨逗号也认**（窗口 80 字符）。
    #      CF gym 那种"逗号把两套赛名拼一起"的标题正是 ① 的教科书例子：
    #      `The 2024 CCPC National Invitational Contest (Changchun), The 17th Jilin Provincial Collegiate
    #       Programming Contest`（同一场：长春 CCPC 邀请赛 = 吉林省赛）。
    #      ⚠️ 窗口写成 `[^,;]{0,60}`（**逗号算断句**）时这类全库 5 条被判成 ② `省赛`。
    #    · 既无"省/市"字面词、又**无 IC/CC 品牌词**的（`第八届广西大学生程序设计大赛暨2025邀请赛`）：
    #      靠「大学生程序设计竞赛/大赛」+「邀请」进来。⚠️ **带 `CCPC`/`ICPC`/`中国`/`国际` 的排除** ——
    #      那是 ③④ 的活（它们官方中文名里必然带着"大学生程序设计竞赛"，别抢）。
    ('省赛暨邀请赛', r'((省|市)[^，。；]{0,40}(邀请|invitational))'
                    r'|((邀请|invitational)[^，。；]{0,40}(省|市))'
                    r'|((provincial|province|(?<!invitational )collegiate)[\s\S]{0,80}invitational)'
                    r'|(invitational[\s\S]{0,80}(provincial|province|(?<!invitational )collegiate))'
                    r'|^(?![\s\S]*(?:CCPC|ICPC|中国|国际))'
                    r'(?=[\s\S]*(?:邀请|invitational))[\s\S]*(?:大学生(计算机)?程序设计(竞赛|大赛))'),
    # ②a 省赛：**有"省/市"字面词**的那些 —— 省/市 + 程序设计竞赛/大赛；「第 N 届…省」；
    #     英文 `provincial` / `province` / `collegiate`。
    #     ⚠️ 中国大学生程序设计竞赛（CCPC 本体）不会走到这里 —— 它按赛系判成 `ccpc/…`。
    #     ⚠️ **`collegiate` 要排除「Invitational Collegiate」**（复盘异常时逮到）：
    #        `collegiate` 在两种地方出现 —— ①"某地区 Collegiate Programming Contest"（= 省/地区赛，
    #        是信号 ✓）；② IC/CC 官方英文名里的 `… National Invitational Collegiate Programming
    #        Contest`（那是 ③ 的赛，**不是**省赛）。判据 = **紧跟 `invitational` 的那个 `collegiate`
    #        不算**（定宽后顾 `(?<!invitational )`）。实测：`2024 ICPC National Invitational Collegiate
    #        Programming Contest, Wuhan Site` 被 ① 抢成 `省赛暨邀请赛`，归 ③ `邀请赛` 才对，
    #        与「第 49 届 ICPC … 邀请赛武汉站」那两条**并到同一个组**了。
    ('省赛', r'省赛|((省|市)[^，。；]{0,16}(大学生)?(计算机)?程序设计)(竞赛|大赛)|(第[一二三四五六七八九十百零〇\d]+届[^，。；]{0,16}省)'
             r'|( provincial| province| (?<!invitational )collegiate)'),
    # ②b 省赛：**没有"省/市"字面词**的那些（`第七届广西大学生程序设计大赛`、
    #    `湖南省第二十届大学生计算机程序设计竞赛`）—— 靠"大学生程序设计竞赛/大赛"这一条进来。
    #    ⚠️ **名字里带「邀请」/`invitational` 的不许走这一条**（实测踩到）：
    #    ② 排在 ③ 前面，而 `第 49 届 ICPC 国际大学生程序设计竞赛邀请赛昆明站`、
    #    `2026 CCPC 中国大学生程序设计竞赛全国邀请赛（南昌）` 这类名字里**必然**带着
    #    「大学生程序设计竞赛」⇒ 会被 ② 一口吞成 `省赛`，③ 那条**命中不了**
    #    （实测全库 `CC邀请赛` 0 条、`邀请赛` 0 条）。③ 是**唯一的邀请赛出口**
    #    （`IC邀请赛` / `CC邀请赛` 两个类型不存在，主办改由 `provincial_org_of()` 单独判），
    #    这一条更是不能松 —— 松了 IC/CC 邀请赛会全被吞成 `省赛`。
    #    真是"省赛**暨**邀请赛"的由 ① 认（① 用的是同一批"省/市"词，所以不会漏）。
    ('省赛', r'^(?![\s\S]*(?:邀请|invitational))[\s\S]*(?:大学生(计算机)?程序设计(竞赛|大赛))'),
    # ③ 其余邀请赛
    ('邀请赛', r'邀请|invitational'),
)

#: **主办**那一轴（与类型**正交**）：从赛名里的品牌词读 —— `IC` / `CC` / `IC&CC` / `无`。
#:
#: 用户正交化的两轴之一（另一轴是 `PROVINCIAL_TYPE_PATTERNS` 的 3 类）。
#: ⚠️ **只认品牌词**：`ICPC`/`IC`/`国际` 与 `CCPC`/`CC`/`中国`。
#:    英文 `China` **不算 CC** —— 否则 `The 2026 ICPC China Sichuan Provincial Programming Contest`
#:    会同时命中两轴 ⇒ 被判成 `IC&CC`（实测踩到）。
#: ⚠️ `\b` 是必须的：`\bIC\b` 不许命中 `ICPC` 里的那三个字符（后面紧跟 `P`，词边界不成立）。
#: ⚠️ 两轴都读**同一个赛名**，但互不干涉：主办判不出 ⇒ `无`（**不是** `未归类`，
#:    "这个名字里没提主办"是结论，不是欠账）。
PROVINCIAL_ORG_PATTERNS = (
    ('IC', r'ICPC|\bIC\b|国际'),
    ('CC', r'CCPC|\bCC\b|中国'),
)

#: 主办判不出时的那一段（"这个名字里没提是 IC 还是 CC"）
PROVINCIAL_ORG_NONE = '无'


def provincial_type_of(contest_name: str, extra_text: str = '') -> str:
    """
    省赛/邀请赛 → **3 类之一**；一条都不命中 ⇒ `无归类`（**不猜**，等人改）。

    判据 = `PROVINCIAL_TYPE_PATTERNS`（**顺序即优先级，命中即止** —— `省赛暨邀请赛` 在最前，
    因为"既办了省赛又办了邀请赛"必须比单挑先判）。
    ⚠️ **只喂赛名**（`extra_text` 现在没人用了，留着只为兼容签名）：只喂赛名是有原因的 ——
    把 QOJ 的**分类路径**也拼进来（那页写着 `Chinese Provincial / Invitational …`）⇒
    **每一场省赛都变成 `省赛暨邀请赛`**（"Provincial" 与 "Invitational" 在同一串里必然 60 字内相邻）。
    ⚠️ 只有 `is_provincial_invitational()` 认下这一场之后才轮到它（外层已经判过了）。
    ⚠️ **主办不在这一轴里**（`IC邀请赛` / `CC邀请赛` 两个类型不存在）——
    主办由 `provincial_org_of()` 单独判，两者在分类串里是相邻的两段。
    """
    text = f'{contest_name or ""} {extra_text or ""}'
    for name, pattern in PROVINCIAL_TYPE_PATTERNS:
        if re.search(pattern, text, re.I):
            return name
    return PROVINCIAL_TYPE_NONE


def provincial_org_of(contest_name: str) -> str:
    """
    这一场的**主办** → `IC` / `CC` / `IC&CC` / `无`（判据见 `PROVINCIAL_ORG_PATTERNS`）。

    与类型**正交**：任何类型都可能有任何主办（用户："正交分为 4*3 类"）。
    """
    text = f'{contest_name or ""}'
    has_ic = bool(re.search(PROVINCIAL_ORG_PATTERNS[0][1], text, re.I))
    has_cc = bool(re.search(PROVINCIAL_ORG_PATTERNS[1][1], text, re.I))
    if has_ic and has_cc:
        return 'IC&CC'
    if has_ic:
        return 'IC'
    if has_cc:
        return 'CC'
    return PROVINCIAL_ORG_NONE


def _class_fallback(ans, warns: list | None, label: str) -> tuple:
    """
    分类这一环节"**一条判据都没表态**"时的兜底（`Answer.stated is False`）。

    ⚠️ 为什么不直接 `ans.value or 'xcpc'`：`resolve()` 专门给了 `stated` 就是为了把
    **"判过了、结论是空"** 与 **"这条判据管不着"** 分开 —— 两个产出点都不看它的话，
    "判据被删掉 / 改了名"不会报错，只会**静默产出一个看起来合法的分类 + 一条依据**。
    这里既不抛（那会让整条链停）也不装没事：**值照旧停在合法前缀上，但把这件事报出来**。
    """
    if warns is not None:
        warns.append(f'{label}：一条判据都没表态（判据表被改过？）⇒ 兜底成 `xcpc` + `xcpc:shallow`')
    return 'xcpc', 'xcpc:shallow'


def xcpc_class_rule(series_id: str, contest_name: str, channel: str = '',
                    warns: list | None = None) -> tuple:
    """
    系列 + 赛名（+ 来源渠道）→ `(natureClass, 分类依据规则id)` —— **XCPC 这一侧的唯一实现**。

    适配器只管把 `series` / `name` / 自己的 `channel` 递进来，判定规则一个字都不许在别处重写。

    ★ **规则 id 记的是"最弱的那一环"**（「依据强度」）：
      一条分类路径是**一串判据接起来**的（赛系 → 赛区 → 阶段 → 正式/热身），
      值的可信度由**最弱的证据**决定 —— 记最强的那个等于自欺。所以：

        · 赛系认不出、停在 `xcpc`        → `xcpc:shallow`（E：什么都没命中）
        · 赛系来自清单、但该来源不止 EC   → `xcpc:series`（B：结构，值没往下走）
        · 阶段判不出（`无归类`）          → `xcpc:unclassified`（E）
        · 阶段由赛名判出                  → `xcpc:name-stage` / `ccpc:name-stage`（C）
        · 省赛/邀请赛（判据最靠前）        → `xcpc:name-provincial`（C）

    规则 id 的**级别表**在应用侧（`src/core/natureConfidence.js` 的 `CLASS_RULE_LEVEL`）；
    这里只负责"事实"（当时凭什么），级别改了不用重跑数据。

    ⚠️ **判据表在 `CLASS_STAGE`**（本文件下面那一条声明，②"初步分类" + ③"分类细化"就是它）：
    本函数只把四个参数折成环节认的那个对象、跑一遍、把 `(值, 依据)` 交出去。
    **判据本身一个字没搬**（`is_provincial_invitational` / `stage_of` / `phase_of` 都还在原地）。
    """
    # `item` 的统一形状是 **`(赛名, 时间文本, 渠道)`**（`stages` 的约定）：
    # 分类这一环节不看时间，所以中间那一格留空；赛系 `sid` 走 `ctx`（它不属于"这场自己"）。
    ans = _stages.resolve(CLASS_STAGE, (str(contest_name or ''), '', str(channel or '')),
                          {'warns': warns, 'sid': str(series_id or '')})
    # 一条判据都没表态 ⇒ 兜底（**并且要报出来**，见 `_class_fallback` 的说明）
    if not ans.stated:
        return _class_fallback(ans, warns, f'分类「{contest_name}」')
    return (ans.value or 'xcpc'), (ans.rule or 'xcpc:shallow')


#: ③ **省赛 / 邀请赛**那一支 —— 判据最靠前（用户："又含『CCPC』又含『省赛/邀请赛』，
#: 那就一定是『只是与 CCPC 有关系的』省赛/邀请赛，省赛/邀请赛的判定一定要最靠前"），
#: **但它只对 EC 赛区生效**（用户追加："省赛/邀请赛判定只对 ec 赛区生效"）——
#: 省赛/邀请赛是**中国**的概念，套到别的大区上就是错的。
#: xcpc 这一侧的来源**本来就是"只收 EC"**（`NON_EC_SOURCES` 里那些才收别的赛区 ⇒ 不算）。
#:
#: ★ **类型 + 主办两段进分类**（"或许省赛/邀请赛的细分应**直接放到分类里**"；
#:   正交化为 "4*3"："IC/CC/IC&CC/(无) × 省赛/邀请赛/省赛暨邀请赛"）。
#:   两段**分类值**：`xcpc/provincial&invitational/<主办>/<类型>/official` ——
#:   好处是 ① 应用里看得见、筛得出、③ 页里能**手改并回代**；② 键直接用分类，不再读赛名；
#:   ③ **主办独立成一轴**：河南那种"同年同地 IC 场 + CC 场"不会再算出同一个键被并成一组
#:   （实测：`第 8 届 CCPC 河南省赛` 与 `第 17 届 ICPC 河南省赛`
#:   分类**逐字相同** ⇒ 必然并组）。
#:   类型判不出 ⇒ 落 `无归类`（与 icpc/ccpc 的"判不出"同一种写法，**不补 phase**、
#:   也**不补主办**——判不出类型时主办那一格没有意义）。
def _class_rule_provincial(item, ctx, _cur):
    name = item[0]
    if ctx['channel'] in NON_EC_SOURCES or not is_provincial_invitational(name):
        return ''
    ptype = provincial_type_of(name)
    if ptype == PROVINCIAL_TYPE_NONE:
        return f'xcpc/{PROVINCIAL_SEG}/{PROVINCIAL_TYPE_NONE}', 'xcpc:name-provincial'
    porg = provincial_org_of(name)
    return phase_of(f'xcpc/{PROVINCIAL_SEG}/{porg}/{ptype}', name), 'xcpc:name-provincial'


#: ② **系列判不出、名字也看不出是省赛** ⇒ 停在 `xcpc`（合法前缀）
def _class_rule_shallow(_item, ctx, _cur):
    return ('xcpc', 'xcpc:shallow') if not ctx['base'] else ''


#: ② **不是"只收 EC"的那些来源** ⇒ 停在 `xcpc/icpc`（合法前缀）——
#: 这一停是**结构**（清单里的赛系说的），不是"没依据"。
#: ⚠️ 不能写 `xcpc/icpc/<阶段>`：Trie 里没有这一段，产包时会被**整包拒掉**。
def _class_rule_series_stop(_item, ctx, _cur):
    if ctx['base'] == 'xcpc/icpc' and ctx['channel'] in NON_EC_SOURCES:
        return ctx['base'], 'xcpc:series'
    return ''


#: ②+③ **阶段由赛名判出**（`branch` 决定用哪张模式表；ccpc 多女生/高职两条、且优先级最高）。
#: 最后一层是 `official` / `warm-up`（`无归类` 不补，见 `phase_of`）。
#: ⚠️ **`stage_of` 只在这里调一次**（它命中多条时会往 `warns` 追加一句 ⇒
#:    算第二遍就会报两遍；所以"判不出"这一档由本判据**自己**记依据，不另立一条判据）。
def _class_rule_stage(item, ctx, _cur):
    name = item[0]
    base = ctx['base']
    if not base:
        return ''
    branch = 'ccpc' if base == 'xcpc/ccpc' else 'icpc'
    stage = stage_of(name, branch, ctx['warns'], name)
    raw = f'xcpc/icpc/ec/{stage}' if base == 'xcpc/icpc' else f'{base}/{stage}'
    cls = phase_of(raw, name)
    # 依据：判得出记 `name-stage`，判不出记 `unclassified`（**值同一处算出来，依据分两档**）
    return (cls, 'xcpc:unclassified' if stage == STAGE_NONE
            else ('ccpc:name-stage' if branch == 'ccpc' else 'xcpc:name-stage'))


#: ② **nature 初步分类** + ③ **分类细化（省赛 & 邀请赛）** —— 这两个环节就是这一条声明。
#:
#: `merge='first'` = **顺序即优先级**：第一条表态的判据赢，"哪一个先判"就是口径本身。
#: 加一条判据 = 在这个元组里插一行（而不是回到 `xcpc_class_rule()` 里再写一个 if）。
#: ⚠️ 判据一个字没搬：`is_provincial_invitational` / `provincial_type_of` / `provincial_org_of` /
#:    `stage_of` / `phase_of` 都还在原地，本声明只负责**顺序、依据、记账**。
CLASS_STAGE = _stages.Stage(
    key='class',
    title='nature 初步分类 + 分类细化（省赛 & 邀请赛）',
    field='natureClass',
    merge='first',
    unit='条',
    missing='系列判不出、名字也看不出省赛（旧行为：停在 `xcpc`）',
    prepare=lambda item, _ctx: {'base': NATURE_CLASS_FROM_SERIES.get(_ctx.get('sid') or '', ''),
                                'channel': item[2]},
    rules=(
        _stages.Rule('provincial', 'natureClass', _class_rule_provincial,
                     '赛名里有省/市/邀请字样（或省赛别名）⇒ 类型 + 主办两段进分类；只对 EC 赛区'),
        _stages.Rule('shallow', 'natureClass', _class_rule_shallow,
                     '清单的赛系认不出 ⇒ 停在 `xcpc`（合法前缀，不是没依据）'),
        _stages.Rule('series-stop', 'natureClass', _class_rule_series_stop,
                     '非 EC 渠道的 icpc ⇒ 停在赛系那一段（结构说的，不是判不出）'),
        _stages.Rule('stage', 'natureClass', _class_rule_stage,
                     '阶段由赛名判出；判不出就记 `xcpc:unclassified`（同一次计算，依据分两档）'),
    ),
)


def xcpc_class_of(series_id: str, contest_name: str, channel: str = '',
                  warns: list | None = None) -> str:
    """
    只要分类（`xcpc_class_rule()` 的第一个返回值）—— 单测/老调用方用这个。

    ⚠️ 规则只有**一处**：`xcpc_class_rule()`。这里不许再写一遍判定。
    """
    return xcpc_class_rule(series_id, contest_name, channel, warns)[0]


#: **真的会跨年**的那几支（赛季年 ≠ 举办年）—— 除了它们，其余比赛可以直接认为两者相同
#: （用户："除了 ecfinal 与 ccfinal，可以认为 ec 赛区的所有比赛举办年份与赛季年份相同"）。
CROSS_YEAR_LEAVES = ('xcpc/icpc/ec/final', 'xcpc/ccpc/final')

#: 「值在别处、还没同步过来」那个占位取值（用户："年份/赛季提供『待同步』…以后有用"）。
#: ⚠️ 真源是 `scripts/crate.py` 的 `NATURE_PENDING_VALUES[0]`（那边管校验）；
#:    这里放一份**字面量**是为了不让通用 lib 反向依赖产包脚本 —— `xcpc selftest` 有断言钉住两者一致。
#: 用途（用户："qoj 的各 final 年份可以填『待同步』"）：总决赛的举办年不唯一、
#: 拿不到日期时标成它 ⇒ 应用里算"填过了"（不再挂在 ③ 等人猜），但**永远不会被推荐**。
YEAR_TO_SYNC = '待同步'

#: 能进**规则 id** 的渠道名（`<渠道>:year-time` / `<渠道>:season-key`）——
#: 用户定的"**日期/年份按来源分档**"（xcpcio/pta/nk = A、rankland/srk = C、
#: gym/qoj = D、cf-contest/atcoder = A）要靠它把"**是谁给的**"写进 `分类依据`；
#: 级别表在应用侧 `src/core/natureConfidence.js`（判据只写一份，这里只写"是谁给的"）。
#: ⚠️ 不在这张表里的（空 / 新渠道）一律落回 `xcpc:` 前缀 ⇒ 应用侧按"来源不明 = 次档"算。
RULE_CHANNELS = ('xcpcio', 'rankland', 'pta', 'nk', 'srk')


def is_cross_year_leaf(cls: str) -> bool:
    """
    这条分类是不是"会跨年"的那两支（EC-Final / CCPC Final，含 qoj / cf gym 的镜像）？

    ⚠️ 分类多了一层 `official`/`warm-up`（`xcpc/icpc/ec/final/official`）
    ⇒ 一律按**前缀**比，不能再用等号。
    ⚠️ 两个**镜像前缀**（`qoj/`、`cf/gyms/`）也要先掐掉 —— 否则 gym 那支的
    `cf/gyms/xcpc/icpc/ec/final/official` 匹配不上（实测踩到：gym 的总决赛不会走"没日期就
    `待同步`"那条规则，年年落空）。
    """
    bare = strip_mirror_prefix(cls)
    return any(bare == leaf or bare.startswith(f'{leaf}/') for leaf in CROSS_YEAR_LEAVES)

#: 总决赛的**举办窗口**（用户给出的猜测）：赛季 X 的两场总决赛在
#: **X 年 9 月 ~ X+1 年 8 月**之间办。实测（本仓真实数据）**成立**，只有两场例外
#: （都是疫情延期：2019 CCPC Final 延到 2021-05、2019 EC-Final 延到 2021-04）。
#: ⚠️ 用处有两个，都写在这里免得后来者重猜：
#:   ① **反推赛季**：拿到举办日期就能算届（9 月及以后算本年度，1~8 月算上一年度）——
#:      `season_of_held()`；
#:   ② **挡住"硬填"**：窗口只把举办年限定在 `{X, X+1}`，**并不唯一** ⇒ 拿不到日期的总决赛
#:      **不许**用赛季顶（`held_year_of` 里那两支留空），让应用用"同一届的另一个来源
#:      填过什么"来填（那才是真证据）。
FINAL_SEASON_WINDOW = (9, 8)     # (起始月, 结束月) —— 9 月起到次年 8 月


def season_of_held(held_time: str) -> str:
    """
    从**举办时间**按上面的窗口反推赛季（`2024.01.13` → `2023`；`2024.12.28` → `2024`）。

    纯粹是"窗口"这条规则的实现，**不猜**：拿不到年份就返回空串。
    """
    y = year_in_text(held_time)
    if not y:
        return ''
    m = re.search(r'(\d{4})\D+(\d{1,2})', str(held_time or ''))
    if not m:
        return y                       # 只有年份（没有月份）⇒ 就当同年度，不做减法
    month = int(m.group(2))
    if month < 1 or month > 12:
        return y
    return y if month >= FINAL_SEASON_WINDOW[0] else str(int(y) - 1)


def in_final_window(season: str, held_time: str) -> bool:
    """这一场（总决赛）的举办时间落在它那个赛季的窗口里吗？（`season_of_held(held_time) == season`）"""
    got = season_of_held(held_time)
    return bool(got) and got == str(season or '')


def held_year_of(cls: str, season: str, held_time: str = '') -> str:
    """
    **举办年份** ⇒ **只有拿到开赛时间才给值，否则留空**。

    ⚠️ **不"用赛季年顶"**（"QOJ 分类链路口名的 20xx 也是按
    赛季划的…那**与年份完全无关**" ⇒ 选"**不再用赛季顶年份**"）：
      · 赛季是"**哪一届**"（QOJ 的分类链路口名、清单 `mid` 都是按它划的），
        **举办年份是另一回事**（跨年赛事差一年）；
      · 所以拿不到开赛时间就**留空** —— 空 = "还没判"，照旧挂在 ③ 性质待补里，
        由应用用「同一届的另一个来源填过什么」（`natureSuggest` 的 `SIBLING`，B 级）来填。
        EC-Final / CCPC Final 那两支仍然写 `待同步`（见 `xcpc_nature`：那是"值在别处、还没同步"）。
    ⚠️ `season` 仍然收着（调用方要传、`season_of_held()` 那条窗口规则也还要它），只是**不再拿它顶年份**。
    """
    return year_in_text(held_time)


def year_in_text(text) -> str:
    """
    文本里第一个 **20xx 四年**（认不出返回 `''`）。

    口径就是"`20` 开头 + 再两位数字"：`203` 不算（不满四位）、`2026` 算；
    不额外加词边界 —— 赛名里 `2026年北京市…` 这种紧贴汉字、`icpc2026preliminary-2`
    这种紧贴字母的写法都要能取出来（`\\b` 在中文语境下不可靠）。
    取不到就返回空串（**留空，不猜**）。
    """
    m = re.search(r'20\d{2}', str(text or ''))
    return m.group(0) if m else ''


# ================================================================
# ④ **地名 / 年份 / 赛季** —— 三个字段 = 同一个环节模块的三组参数
#
# **判据只有下面这几条**（`SEASON_FROM_*` / `YEAR_*` / `REGION_CORE`），
# 三处（XCPC 各来源 / CF gym / QOJ）**共用同一批**；它们的差别只有两样，都当参数表达：
#   · **顺序** —— 谁优先就是"哪一条先判"（`first` 合并口径）；
#     XCPC 的赛季是"清单 `mid` 优先"、gym 的是"**赛名**优先"（gym 的名字就是原比赛的名字）。
#   · **集合** —— QOJ 多两条自己的判据（UC 系列 / 分类路径兜底），它在自己文件里拼。
#
# `item` 统一成 `(赛名, 时间文本)`：位置语义一样，方言之间才换得了判据。
# 其余（分类、`mid`、渠道、前缀）一律走 `ctx`（`prepare` 每次算一次）。
#
# 判据本身一个字没搬：`year_in_text` / `held_year_of` / `region_of_contest` 都还在原地。
# ================================================================

def _rule_scope(channel: str) -> str:
    """渠道 → 规则 id 的前缀（不在 `RULE_CHANNELS` 里的一律 `xcpc:`，"来源不明 = 次档"）"""
    c = str(channel or '').strip()
    return c if c in RULE_CHANNELS else 'xcpc'


def _xcpc_scope(item, _ctx):
    """XCPC 各来源共用的 `prepare`：规则 id 前缀看**渠道**（"是谁给的"）；地区恒用 `xcpc:`"""
    return {'scope': _rule_scope(item[2]), 'regionPrefix': 'xcpc'}


def _gym_scope(_item, _ctx):
    """CF gym 的 `prepare`：前缀恒为 `gym:`（它不是"收集源"，是一棵自己的镜像树）"""
    return {'scope': 'gym', 'regionPrefix': 'gym'}


# ---- 赛季：三条判据 ----
def _season_from_mid(_item, ctx, _cur):
    """清单 `mid` 里的赛季（省赛那一层是**地点**、赛季不再藏在层名里 ⇒ 清单单独带一个）"""
    mid = ctx.get('mid') or {}
    return (year_in_text(mid.get('season')) or year_in_text(mid.get('id')),
            f"{ctx['scope']}:season-key")


def _season_from_name(item, ctx, _cur):
    """赛名里的第一个 20xx"""
    return year_in_text(item[0]), f"{ctx['scope']}:season-name"


def _season_from_time(item, ctx, _cur):
    """退到开赛时间里的 20xx（gym 那一侧的次选）"""
    return year_in_text(item[1]), f"{ctx['scope']}:season-time"


# ---- 年份：两条判据（XCPC 只认时间；gym 时间优先、退到赛名）----
def _year_by_time(item, ctx, _cur):
    """
    **只认开赛时间**（XCPC 侧的定案：不拿赛季年顶年份 —— "QOJ 分类链路口名的 20xx
    是按赛季划的，那与年份完全无关"）。拿不到 ⇒ `待同步`（不是留空：空是"还没判"，
    而这里**判过了、只是手里没有日期**）。

    ⚠️ 依据那一档看的是**判出来的年份**，**不是"开赛时间非空"**：
    `held_time` 里有字但没有 20xx（如 `待定`）时是 `:year-tbd` —— 拿"参数非空"当判据
    会把它记成 `:year-time`（A 权威），那是把"没拿到"说成"拿到了"。
    """
    held = held_year_of(ctx.get('cls', ''), ctx.get('season', ''), item[1])
    return (held or YEAR_TO_SYNC,
            f"{ctx['scope']}:year-time" if held else f"{ctx['scope']}:year-tbd")


def _year_time_then_name(item, ctx, _cur):
    """
    **开赛时间优先、退到赛名**（gym 侧：CF 的开赛时间是硬数据，赛名年份常是**赛季年**）。
    总决赛（EC-Final / CCPC Final）**拿不到开赛时间就写 `待同步`**（举办年落在
    "赛季年或次年"、不唯一）；其余都没有 ⇒ **留空**（空 = "还没判"，挂 ③ 等人补）。
    """
    from_name = year_in_text(item[0])
    from_time = year_in_text(item[1])
    if is_cross_year_leaf(ctx.get('cls', '')) and not from_time:
        return YEAR_TO_SYNC, f"{ctx['scope']}:year-tbd"
    if from_time:
        return from_time, f"{ctx['scope']}:year-time"
    if from_name:
        return from_name, f"{ctx['scope']}:year-name"
    return ''


# ---- 地区：一条判据（三处共用；判据全在 `region_of_contest`）----
def _region_core(item, ctx, _cur):
    """城市 / 省名 / `无` / `待填写` / `不需要`；读不出 ⇒ `('', '')` 留空等人补"""
    return region_of_contest(ctx.get('cls', ''), item[0], ctx.get('regionPrefix', 'xcpc'))


#: ④ 的判据（**各方言共用这一批**，别在适配器里再写第二份）
SEASON_FROM_MID = _stages.Rule('season-key', 'natureSeason', _season_from_mid,
                               '清单 `mid` 里的赛季（`season` 或层 id 里的 20xx）—— B 结构')
SEASON_FROM_NAME = _stages.Rule('season-name', 'natureSeason', _season_from_name,
                                '赛名里的 20xx —— C 明确字面词')
SEASON_FROM_TIME = _stages.Rule('season-time', 'natureSeason', _season_from_time,
                                '退到开赛时间里的 20xx —— A 权威（gym 侧的次选）')
YEAR_BY_TIME = _stages.Rule('year-time', 'natureYear', _year_by_time,
                            '开赛时间里的 20xx；没有就写 `待同步`（值在别处、还没同步过来）')
YEAR_TIME_THEN_NAME = _stages.Rule('year-fallback', 'natureYear', _year_time_then_name,
                                   '开赛时间优先、退到赛名；总决赛没时间 ⇒ `待同步`（gym 侧）')
REGION_CORE = _stages.Rule('region-core', 'natureRegion', _region_core,
                           '判据全在 `region_of_contest`（网络赛 / 总决赛那几类 / 中外地名）')

#: XCPC 各来源的三组参数（`xcpcio` / `rankland` / `pta` / `nk` / `srk` 共用）
SEASON_STAGE = _stages.Stage(
    key='season.xcpc', title='赛季年份（XCPC）', field='natureSeason',
    merge='first', unit='条', prepare=_xcpc_scope,
    missing='`mid` 与赛名里都没有 20xx ⇒ 留空（不猜）',
    rules=(SEASON_FROM_MID, SEASON_FROM_NAME),
)
YEAR_STAGE = _stages.Stage(
    key='year.xcpc', title='举办年份（XCPC）', field='natureYear',
    merge='first', unit='条', prepare=_xcpc_scope,
    missing='拿不到开赛时间（本判据总会给 `待同步`，所以到不了这里）',
    rules=(YEAR_BY_TIME,),
)
REGION_STAGE = _stages.Stage(
    key='region.xcpc', title='地区（XCPC）', field='natureRegion',
    merge='first', unit='条', prepare=_xcpc_scope,
    missing='赛名里读不出中国地名 ⇒ 留空（不猜）',
    rules=(REGION_CORE,),
)

#: **CF gym 的三组参数** —— 同一个模块、判据同一批，只有两处不同：
#:   · **赛季 = 赛名优先**（gym 的名字就是原比赛的名字：`The 2020 ICPC Asia Yinchuan
#:     Regional` ⇒ 2020 赛季），赛名里没有才退到 CF 的开赛时间；
#:   · **年份 = 时间优先、退到赛名**（实测 3 场"赛季年 ≠ 举办年"的真情况：
#:     疫情延期、总决赛跨年），总决赛没时间 ⇒ `待同步`。
#: 与 XCPC 侧"两个字段各有主次"是同一条道理，只是主次**换了方向** —— 这正是"参数"。
SEASON_STAGE_GYM = _stages.Stage(
    key='season.gym', title='赛季年份（gym）', field='natureSeason',
    merge='first', unit='条', prepare=_gym_scope,
    missing='赛名与开赛时间里都没有 20xx ⇒ 留空',
    rules=(SEASON_FROM_NAME, SEASON_FROM_TIME),
)
YEAR_STAGE_GYM = _stages.Stage(
    key='year.gym', title='举办年份（gym）', field='natureYear',
    merge='first', unit='条', prepare=_gym_scope,
    missing='没有开赛时间、赛名里也没有 20xx ⇒ 留空（挂 ③ 等人补）',
    rules=(YEAR_TIME_THEN_NAME,),
)
REGION_STAGE_GYM = _stages.Stage(
    key='region.gym', title='地区（gym）', field='natureRegion',
    merge='first', unit='条', prepare=_gym_scope,
    missing='赛名里读不出中国地名 ⇒ 留空（gym 里很多是线下赛的镜像，场地就在名字里）',
    rules=(REGION_CORE,),
)


def xcpc_nature(series: dict | None, mid: dict | None = None,
                contest_name: str = '', channel: str = '',
                warns: list | None = None, held_time: str = '') -> dict:
    """
    XCPC 这一侧**全部性质字段的唯一产出点**（返回值直接 `**` 展开进 `crate.contest()`）：

        crate.contest(parent, key, name=..., contestTime=t,
                      **xcpc_nature(series, mid, name, channel='xcpcio', held_time=t))

    `natureClass` **恒以 `xcpc` 开头**：05 xcpc 里所有 C 都是 XCPC 赛系下的比赛
    （包括 xcpcio / rankland / srk 那几棵**收集源**的树 —— 收集源不是性质）。

    ⚠️ **年份与赛季是两个字段**：
      · `natureYear` = **举办年份** —— 取 `held_time`（适配器自己那份开赛时间）；
        拿不到 ⇒ **写 `待同步`**（用户："The 2017 ACM-ICPC Asia EC League Final Contest
        （上海大学）年份也填待同步"）；
      · `natureSeason` = **赛季年份** —— 先取清单 `mid['season']`（省赛那一层是"地点"、
        赛季不再藏在层名里），再退到层 id / 赛名里的 20xx（`icpc2023ecfinal` → 2023 赛季）。

    ⚠️ **为什么总决赛写 `待同步` 而不是留空**（这条口径与 QOJ 那边一致）：它们的举办年落在
    "赛季年或次年"、**不唯一**（`FINAL_SEASON_WINDOW`），所以判不出来；但"判不出来"
    不等于"还没处理" —— 留空会让它永远挂在 ③ 待补里等人手填一个**只能靠别的来源**才知道的值，
    而"同一届的另一个来源填过什么"恰恰是 `待同步` 的语义（值在别处、还没同步过来）。
    `待同步` 在应用里算"填过了"，且**永远不会被推荐**（`isRealYear` 那道闸）。

    ⚠️ **四个字段 = 四个环节**（②③ 是 `CLASS_STAGE`，④ 是 `SEASON_STAGE` /
    `YEAR_STAGE` / `REGION_STAGE`）。本函数只做两件事：**按依赖顺序**把它们跑一遍
    （年份要用赛季 ⇒ 顺序是硬的）、把结果拼成一个 dict。判据一个字不在这里。
    """
    add_crate_path()
    from crate import class_rules, nature_fields      # noqa: PLC0415 —— 延迟 import 是有意的（见 docstring）

    # ⚠️ `item` 统一成 **`(赛名, 时间文本)`**（`stages` 的约定）：判据按位置读它，
    #    方言之间才换得了判据（gym 那三组参数读的是同一个位置）。渠道放 `item[2]`，只有
    #    `CLASS_STAGE` 与 `_xcpc_scope` 用它。
    item = (str(contest_name or ''), str(held_time or ''), str(channel or ''))
    ctx0 = {'warns': warns, 'sid': str((series or {}).get('id') or '')}
    # ②③ 分类（含省赛/邀请赛的细化）
    cls_ans = _stages.resolve(CLASS_STAGE, item, ctx0)
    cls, rule = (cls_ans.value or 'xcpc'), (cls_ans.rule or 'xcpc:shallow')
    if not cls_ans.stated:
        cls, rule = _class_fallback(cls_ans, warns, f'分类「{item[0]}」')
    # ④-a 赛季（`mid` 是它的输入之一）
    season_ans = _stages.resolve(SEASON_STAGE, item, {**ctx0, 'mid': mid or {}})
    season, season_rule = (season_ans.value or ''), (season_ans.rule or '')
    # ④-b 年份（**要用赛季**：`held_year_of(cls, season, held_time)` 的第二个参数）
    year_ans = _stages.resolve(YEAR_STAGE, item, {**ctx0, 'cls': cls, 'season': season})
    held, year_rule = year_ans.value, (year_ans.rule or '')
    # ④-c 地区（要用分类：网络赛那一档只看分类）
    region_ans = _stages.resolve(REGION_STAGE, item, {**ctx0, 'cls': cls})
    region, region_rule = (region_ans.value or ''), (region_ans.rule or '')

    # 年份 / 赛季的**依据**（这两格不写依据 ⇒ 界面画不出可信度）：
    #   年份：`…:year-time`（拿到**开赛时间** ⇒ A 权威）/ `…:year-tbd`（`待同步` ⇒ D，占位）；
    #   赛季：`…:season-key`（清单 `mid`/层 id 里的 20xx ⇒ B 结构）/
    #         `…:season-name`（赛名里的 20xx ⇒ C 明确字面词）。
    return {**nature_fields(('natureClass', cls),
                            ('natureYear', held),
                            ('natureSeason', season),
                            ('natureRegion', region)),
            # 分类依据（元列 `分类依据`）：这一条 `natureClass` 是**哪条规则**判出来的
            # （见 `xcpc_class_rule()` 的说明 —— 记的是最弱的那一环）。
            # ⚠️ 这一列是**逐字段**的（`{字段: 规则id}`）⇒ 四个性质字段各有一条规则：
            #    分类 `xcpc:name-*`、年份 `xcpc:year-*`、赛季 `xcpc:season-*`、地区 `xcpc:region-*`。
            **class_rules(('natureClass', rule), ('natureYear', year_rule),
                          ('natureSeason', season_rule), ('natureRegion', region_rule))}


# 会给 ratio 的渠道（ratio = 过题队伍数 / 有效队伍数，**只有榜单源算得出**）
# rankland / srk 不给 ratio，所以不列进来（问它们"缺不缺 ratio"没有意义）
RATIO_CHANNELS = ('xcpcio', 'pta', 'nk')


# ================================================================
# 「复用题」的**合成节点 + 成员指针**
#
# 用户口径："**除了 xcpc，合成节点只在 cf/atc 的同一时间不同场复用题时出现，
# 比赛完全不用合成**" + "**cf/atc 你直接生成 ownerSynth 和合成节点就行了**"。
#
# 也就是说合成只有两种：
#   ① **XCPC 的比赛**（同一场出现在多棵来源树里）—— 由链上 `scripts/synth-bind.mjs` 按 nature
#      建组与绑定（老的清单 slug 方案 `scripts/nature_rules.py` 已停用）；
#   ② **CF / AtCoder 的题**——**只有当同一道题在"同一时间的不同场次"里各留了一份 P 时**才合成
#      （CF：同一轮 Div1/Div2 共用题，对应关系在 `cache/cf_contest/reuse.json`；AtCoder 同理）。
#      **比赛层不合成** —— cf/atcoder 的 C 一律是真节点，不做合成。
#
# 为什么两边各留一份 P 还要合成：那两份在树上就是两道"看着一模一样"的题，
# 计数/统计会当成两道；合成节点把它们归成**一组**（成员指针写在 `ownerSynth` 上）。
# ================================================================

#: 复用题合成节点的键前缀（`synth:problem:<老家那道题的 extKey>`）
PROBLEM_SYNTH_PREFIX = 'synth:problem:'

#: 复用题合成节点的**名字前缀**（用户："先修 cf 合成节点的名字前缀 `[Merged]`"）。
#:
#: 为什么需要它：合成节点 `name` 照**老家那道 P**，而它在树上**与那道 P 同父同名**
#: （都挂在老家那场下、都叫「Row GCD」）⇒ 不加前缀在树上看不出哪条是合成、哪条是原料。
#:
#: ⚠️ **只加在"合成节点自己"的显示名上**。分组判据（`problem_reuse_groups` 的"时间相同 + 题名相同"）
#:    用的是**成员题名**，一个字符都不动 —— 前缀要是混进判据，同一道题就再也配不成组了。
#: ⚠️ CF 与 AtCoder 共用 `emit_problem_synths()` ⇒ 两边一起生效（AtCoder 当前 0 组）。
MERGED_SYNTH_NAME_PREFIX = '[Merged] '


def problem_synth_key(home_ext: str) -> str:
    """一道"被复用的题"的合成标识 —— **以老家那份 P 的 extKey 为准**（稳定、可复现）"""
    return f'{PROBLEM_SYNTH_PREFIX}{str(home_ext or "").strip()}'


def problem_reuse_groups(entries: list) -> list:
    """
    `[(场次 extKey, 场次时间, 题 extKey, 题名, 题号), …]` → **复用题的组**。

    判据（用户："同一时间不同场复用题"）：
      · **时间相同**（`contestTime` 逐字相等，空的不算）；
      · **题名相同**（原样比，trim 过）；
      · 落在**至少两个不同场次**里。
    "老家"取场次 extKey 排序里的第一个（稳定、可复现）—— 合成节点挂在它下面。

    @returns `[{'home': {ext,parent,name,problem_id}, 'members': [{ext,parent}, …]}, …]`
    """
    buckets: dict = {}
    for cext, ctime, pext, pname, pid in entries:
        t = str(ctime or '').strip()
        n = str(pname or '').strip()
        if not t or not n or not pext or not cext:
            continue
        buckets.setdefault((t, n), []).append((str(cext), str(pext), str(pid or '')))

    groups = []
    for (_t, name), items in buckets.items():
        parents = {c for c, _p, _i in items}
        if len(parents) < 2:
            continue
        items.sort(key=lambda x: (x[0], x[2]))          # 场次 → 题号，稳定
        cext, pext, pid = items[0]
        groups.append({
            'home': {'ext': pext, 'parent': cext, 'name': name, 'problem_id': pid},
            'members': [{'ext': p, 'parent': c} for c, p, _i in items[1:]],
        })
    groups.sort(key=lambda g: g['home']['ext'])
    return groups


def emit_problem_synths(crate, groups: list, warns: list | None = None,
                        parent_of: dict | None = None) -> tuple:
    """
    把**复用题的组**产成记录：每组一个 **P 合成节点** + 每个成员一条 **`ownerSynth` 指针**。

    · 合成节点：`synth:problem:<老家 P 的 extKey>`，`name` = **`[Merged] ` + 老家那道题的名字**
      （前缀见 `MERGED_SYNTH_NAME_PREFIX` —— 它与老家那道 P **同父同名**，不加前缀在树上分不出谁是谁）、
      `problemId` 照老家那份 P；
      ⚠️ **前缀只加在合成节点上**；成员两份 P 的题名一个字符都不动（分组判据要它们的原样题名）。
    · 挂哪：默认挂在**老家那场**（`home.parent`）下；调用方要换地方就传 `parent_of`
      （`{老家 P 的 extKey: 新父的键}`）—— CF 就是这么把它挪进 `aux-cf-contest` 的
      （用户："放辅助节点-cf-contest-…"；"放在原位置其实不合适"）。
    · 成员：**老家自己也算成员**（组 = 组头 + **所有**原料节点，与跨来源合成那套口径一致），
      加上其余每一份拷贝。**包内**那份 ⇒ **直接在那条记录上写 `ownerSynth`**
      （同 extKey 不能再出一条记录，包里 extKey 唯一）；**包外**的（树上已有、本包没出）
      ⇒ 另出一条**指针记录**，只写 `extKey` + `ownerSynth`、**不写 name**
      （带了 name 会在导入时把题名按 `overwrite-if-changed` 改写掉；与 `synth-bind` 写 C 成员
      指针的做法一致）。

    ⚠️ **老家必须登记**（用户："Codeforces Round 1124 (Div. 1) D 没有 ownerSynth"）：
      这里刻意把老家排除（"它不需要给自己当成员"）—— 后果是 ① 老家的状态**进不了组值**
      （"组那份"只由拷贝算出来）；② 它在「判重整理」里显示成**未归属的原料**、在节点详页里显示
      "没归入任何合成组"。全库 355 个复用题组**全都**如此 ⇒ 把老家一起登记。
    ⚠️ 没有题名的组直接跳过（合成节点必须有名字；题名本来就该有，没有就是上游数据缺）。

    @param parent_of - 可选的"改挂哪儿"表（键 = 老家 P 的 extKey，值 = 父的键）
    @returns `(合成节点数, 指针数)`
    """
    made = 0
    pointed = 0
    by_ext = {}
    for r in getattr(crate, 'records', []) or []:
        k = str(r.get('extKey') or '').strip()
        if k:
            by_ext[k] = r
    for g in groups or []:
        home = (g or {}).get('home') or {}
        hext = str(home.get('ext') or '').strip()
        name = str(home.get('name') or '').strip()
        members = [m for m in (g.get('members') or [])
                   if str((m or {}).get('ext') or '').strip() not in ('', hext)]
        if not hext or not name or not members:
            continue
        key = problem_synth_key(hext)
        crate.synth(key, 'P',
                    parent=str((parent_of or {}).get(hext) or home.get('parent') or ''),
                    name=MERGED_SYNTH_NAME_PREFIX + name,
                    problemId=str(home.get('problem_id') or ''))
        made += 1
        # 老家**自己也登记**（见 docstring 的 ⚠️）：排在最前，与"组头 + 所有原料"的顺序一致
        for m in [{'ext': hext, 'parent': home.get('parent')}] + members:
            mext = str(m.get('ext') or '').strip()
            rec = by_ext.get(mext)
            if rec is not None:
                rec['ownerSynth'] = key            # 包内成员：就地写指针（不能再出一条同 extKey 的记录）
            else:
                crate.problem(str(m.get('parent') or ''), mext, owner_synth=key)
            pointed += 1
    if warns is not None and made:
        warns.append(f'复用题：{made} 个合成节点 + {pointed} 条成员指针（同一时间不同场共用题）')
    return made, pointed


def aux_tree_key(channel: str) -> str:
    """渠道名 → 它那棵树的 W 键（`pta` → `aux-pta`）"""
    key = (AUX_TREES.get(str(channel or '')) or ('', ''))[0]
    if not key:
        raise ValueError(f'未知的渠道 {channel!r} —— 要接新渠道就在 xcpc_common.AUX_TREES 加一行')
    return key


def ratio_counts(channel: str) -> dict:
    """
    `{slug: [题数, 有 ratio 的题数]}` —— **只看某一个渠道那棵树**（没包就返回空 dict）。

    ⚠️ 口径："显然是**本渠道没有 ratio 就该抓**，如 pta 有数据、
       xcpcio 没数据时**要爬 xcpcio**" ⇒ **不要跨渠道树合并看，要每个渠道自己看**。
       合并看的话"PTA 有 ratio"会把"xcpcio 缺数据"这件事盖住，那几场就永远补不上。

    只看 P 记录，extKey 形如 `<树>:c:<slug>:p:<题号>`
    （`<树>` 是 `aux-xcpcio` 这种**不带冒号**的段，所以第 3 段仍是 slug）。

    @param channel - 渠道名（`xcpcio` / `pta` / `nk` …）
    """
    tree = aux_tree_key(channel)
    # ⚠️ 合并包叫 `mix_contain_xcpc.json`（**不是** `xcpc.json`）
    #    （用户："qoj 和 cf gym 也有很多非 xcpc 的内容" ⇒ 名字照实叫"混装、但含 XCPC"）。
    #    这里按 `<aux-渠道>:` 前缀过滤，混装包里那几棵 aux 树都在。
    path = os.path.join(NODES, 'mix_contain_xcpc.json')
    if not os.path.isfile(path):
        return {}
    out = {}
    for r in read_json(path).get('records') or []:
        if r.get('节点类型') != 'P':
            continue
        ext = str(r.get('extKey') or '')
        if not ext.startswith(tree + ':'):
            continue                                   # 别的渠道的树，不看
        a = out.setdefault(ext.split(':')[2], [0, 0])
        a[0] += 1
        if r.get('ratio'):
            a[1] += 1
    return out


def slugs_with_ratio(channel: str) -> set:
    """
    该渠道树里**已经有 ratio** 的场次。

    补抓脚本要的是它（`--missing` = 目标场次里**不在这集合**的那些）——
    这样"这棵树里压根没有这个场次"也算缺，会被补上；用 `missing_ratio_slugs` 反着问的话，
    没有 P 记录的场次会**静默漏掉**。
    """
    return {s for s, (_t, ok) in ratio_counts(channel).items() if ok}


def missing_ratio_slugs(channel: str) -> set:
    """该渠道树里**一道 ratio 都没有**的场次（有 P 记录、但全无 ratio）"""
    return {s for s, (_t, ok) in ratio_counts(channel).items() if not ok}


# ================================================================
# 抓取范围 = 显式 ∪ 有提交的（通用区 `Scaper/lib/scope.py`，05 侧转手一次）
# ⚠️ `scope.py` 住在**通用区** `Scaper/lib/`（04 qoj 也要用同一份），本模块自己把那条路径挂上，
#    免得每个入口脚本都得记着加（05 xcpc/lib → ../../lib = Scaper/lib）
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', 'lib')))
from scope import split_by_origin, union_scope  # noqa: E402,F401

# 小工具
# ================================================================

_LETTER_RE = re.compile(r'[^A-Za-z0-9]')


def letter_sort(index) -> tuple:
    """
    题号排序键（**唯一一份实现**，`cf_contest_adapter` 与 `atcoder_adapter` 都用它）。

    规则（用户："要不限特殊名单，把 EX 放进去，其他按字典序排吧"；
    并问"是不是还有题号为数字的？如果有，E < E(1~9) < F"）：

      ① **只有 `EX` 特殊 ⇒ 永远垫底**：`EX` / `EX2` / `EX3`…（大小写不敏感）在第 1 组，
         组内自然序（`EX < EX2 < EX10`）。判据 = 去掉非字母数字后**以 `EX` 开头**；
         认不出形状的（如 `A1B`）放第 2 组，也在字母之后，保证排序稳定。
      ② **其余一律自然序**：先比字母前缀（`A<B<…`），前缀相同再比**数字后缀的数值**
         ⇒ `A < B < … < E < E1 < E2 < E10 < F < F2 < G`；
      ③ **纯数字题号**（整场用 1,2,…12 的场次，实测 CF 有）按数值排 ⇒ `1 < 2 < 10`，
         排在字母之前（同一场不会混着用，所以只求稳定）。

    ⚠️ 别把"常规单字母在前、**其余全垫底**"当规则：那样 CF 某场会排成 `A,B,C,D,F,E1,E2`
      —— `E1/E2` 不是"特殊题型"，只是**带数字后缀**，被踢到 `F` 后面纯属规则写歪了。
      只有 `EX` 那种"跨档加题"才该垫底（AtCoder 的 `EX` 就该排在该场最后）。
    """
    s = _LETTER_RE.sub('', str(index or '').strip().upper())   # 只留字母数字
    m = re.match(r'^([A-Z]*)(\d*)$', s)
    if not m:
        return (2, s, 0, s)
    letters, digits = m.group(1), m.group(2)
    num = int(digits) if digits else 0
    if letters.startswith('EX'):
        return (1, letters, num, s)
    return (0, letters, num, s)


def norm_letter(value) -> str:
    """题号归一化：只留字母数字并大写（`a` → `A`；空 → ''）"""
    if value is None:
        return ''
    return _LETTER_RE.sub('', str(value)).upper()


def fmt_ratio(solved, effective) -> str:
    """
    ratio = 通过队伍数 / 有效队伍数 × 100（保留 2 位小数）

    与 HDU / 牛客**同一口径**，两个平台的难度才可比。
    有效队伍数 = 赛时至少解出 1 题的队伍数（不是榜上总队伍数）。
    分母为 0 时返回空串（宁可不给，也不给一个错数）。
    """
    try:
        solved = float(solved)
        effective = float(effective)
    except (TypeError, ValueError):
        return ''
    if effective <= 0:
        return ''
    return f'{solved / effective * 100:.2f}'


def read_json(path: str):
    """读 JSON，容忍 BOM（PowerShell / 记事本存过的文件会带）"""
    with open(path, 'r', encoding='utf-8-sig', errors='replace') as f:
        return json.load(f)


#: `read_json_cached` 的记忆表：(绝对路径, mtime_ns, size) → 已解析的对象
_JSON_MEMO: dict = {}


def read_json_cached(path: str):
    """
    读 JSON，但**同一次进程内同一份文件只解析一次**。

    为什么要它（实测）：适配器里到处是"要一个字段就重读整份文件"的小助手
    —— qoj 那棵树构建时 _read_cache 被调 **3278 次**，把 850KB / 500KB 的缓存解析了几百遍，
    单这一项 13.7s，占那一步 15.4s 的 **89%**。整树适配器（qoj/atcoder/cf-contest）
    30 秒几乎全是这个。

    ⚠️ 返回的对象是**共享的**（同一个 key 只会解析一次）⇒ **调用方不要原地改它**。
       要写文件请走 write_json；要生成新 dict 请自己 copy。
    """
    try:
        stat = os.stat(path)
        key = (os.path.abspath(path), stat.st_mtime_ns, stat.st_size)
    except OSError:
        return read_json(path)                     # 不存在等情况：口径与 read_json 一致（会抛）
    hit = _JSON_MEMO.get(key)
    if hit is None:
        hit = read_json(path)
        _JSON_MEMO[key] = hit
        for old in [k for k in _JSON_MEMO if k[0] == key[0] and k != key]:
            del _JSON_MEMO[old]                    # 同一文件只留最新那一版
    return hit


def write_json(path: str, data):
    """写 JSON：UTF-8 无 BOM、缩进 2、保留中文、LF 行尾"""
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write('\n')


def empty_source_result(out: str, warns=None, *, what: str = '记录') -> int:
    """
    **"这条源这次没产出东西"的统一处理**。

    三个"整条源树"适配器（qoj / atcoder / cf-contest）都写成：
    "把旧片段删掉 + 返回 0"。后果很安静也很难查：上游空转一次
    （提交文件被截断、API 返回空），**已归档的整条源就没了**，
    而这一趟还报成功 —— 实测症状是混装包里 `qoj` 那一支整棵消失（所有 C/P/R）。

    这里的口径与"抓不到 API"那条**完全一致**：
      · 有旧片段 ⇒ **留着**（这一趟合并时就用它；下次重跑覆盖）+ stderr 说清；
      · 没有旧片段 ⇒ 这条源这次就是缺 + stderr 说清。
      · 两种都**返回 0**：⚠️ 退出码非零会把**整条链掐断** ——
        默认跑法（`build_chain` 给的 `--force`）会**先把旧片段删掉**再跑适配器
        （`xcpc_pipeline.py` 的 `args.force` 分支），于是"没有旧片段"是**必然**的，
        返回 1 = 整个产包步失败（后面的 rehome / baseline / check 全不跑）。
        而管线自己写着的口径是"空来源不算链子失败，别让它把别的类带崩"
        （见 `xcpc_pipeline.py` 里 `_class_pieces_empty` 那一段）——
        这里跟它对齐：**出声，但不炸链子**。
    ⚠️ **绝不删旧片段**："这次没拿到" ≠ "没有"。
    ⚠️ 只给**整条源树**的适配器用（qoj / atcoder / cf-contest）：源树是"这一整条源"，
    空 = 上游出问题，旧片段是**唯一**的数据。
    **逐场**片段（`crate_<slug>_*.json`）**不要**用它 —— "这一场 0 条"是正常结果
    （你确实没在这场比赛里提交），那场自己的旧片段就该删（否则会把上一轮的数
    当成本轮的，见 `cf_adapter.py` 里那句注释）。
    """
    warns = list(warns or [])
    if os.path.isfile(out):
        print(f'⚠️ 这次没有可产出的{what} —— **保留**上一份片段 {rel(out)}'
              f'（不删：空 ≠ 没有；下次重跑会覆盖）', file=sys.stderr)
        for w in warns[:8]:
            print('   ⚠️', w, file=sys.stderr)
        return 0
    print(f'❌ 没有可产出的{what}，也没有可沿用的旧片段 —— **这条源这次会缺**'
          f'（不炸链子：与管线"空来源不算失败"的口径一致）', file=sys.stderr)
    for w in warns[:8]:
        print('   ⚠️', w, file=sys.stderr)
    return 0


def title_of(contest: dict) -> str:
    """
    rankland / srk 的 `title` → 纯文本赛名。

    它是 `{'zh-CN': …, 'fallback': …}` 这种双语对象（也可能直接是字符串）。
    **一律 `.strip()`**：源里偶尔带首尾空白，留着会让同一个赛名建出两个容器
    （层名/层 id 的比较是逐字的）。原先两份实现只差这个 `.strip()`。
    """
    t = contest.get('title')
    if isinstance(t, dict):
        return str(t.get('zh-CN') or t.get('fallback') or '').strip()
    return str(t or '').strip()


def qoj_name(qoj_index: dict, cid: str) -> str:
    """QOJ 比赛号 → 官方赛名（同一场有多个名字时，都用 ` / ` 连起来）"""
    names = ((qoj_index.get(str(cid)) or {}).get('names') or [])
    return ' / '.join(names)


def add_crate_path() -> None:
    """
    把放着 `crate.py` 的 `scripts/`（没有就是 `05 xcpc` 自身）挂进 `sys.path`。

    `05 xcpc` 里 10 个适配器各自抄了一份同样的 `_SEARCH`
    循环（逐字相同）——收在这里，以后 crate.py 换位置只改这一处。
    找不到就直接退出：没有 crate 什么都做不了。
    """
    for base in (os.path.join(REPO, 'scripts'), SPEC):
        if os.path.isfile(os.path.join(base, 'crate.py')):
            if base not in sys.path:
                sys.path.insert(0, base)
            return
    sys.exit('找不到 crate.py')


def resolve(path: str) -> str:
    """清单里写的相对路径：先按 `05 xcpc/` 解析，再按仓库根解析"""
    if not path:
        return ''
    if os.path.isabs(path):
        return path
    for base in (SPEC, REPO):
        p = os.path.abspath(os.path.join(base, path))
        if os.path.isfile(p):
            return p
    # 文件还不存在（要写给它）时，按路径的**长相**挑基准。
    # ⚠️ 早先这里一律按 SPEC 拼，于是清单里写的仓库相对路径
    #    `acm-data/raw/Scaper/05 xcpc/cache/x.srk.json` 会被拼成
    #    `05 xcpc/acm-data/raw/Scaper/05 xcpc/cache/x.srk.json` ——
    #    文件落进了一个从没打算存在的嵌套目录里（实测踩到过）。
    norm = path.replace('\\', '/')
    base = REPO if norm.startswith(('acm-data/', 'scripts/', 'src/', 'docs/')) else SPEC
    return os.path.abspath(os.path.join(base, path))


def rel(path: str, base: str = '') -> str:
    """
    显示用相对路径。

    ⚠️ 不能直接用 `os.path.relpath`：**跨盘符会抛 ValueError**
    （例如把 `-o` 指到 C:\\ 而仓库在 D:\\）。命令行工具的输入路径是用户给的，
    所以这里必须兜底 —— 显示绝对路径总比崩掉好。
    """
    if not path:
        return ''
    base = base or SPEC
    try:
        return os.path.relpath(path, base)
    except ValueError:
        return os.path.abspath(path)


# ================================================================
# 场次清单
# ================================================================

def load_manifest(path: str = '') -> dict:
    path = path or MANIFEST
    data = read_json(path)
    if not isinstance(data, dict) or not isinstance(data.get('contests'), list):
        raise ValueError(f'{path} 里没有 contests 数组')
    return data


def load_manifest_lenient(path: str = '') -> dict:
    """
    读清单；**文件不存在或是空的就当成空清单**。

    为什么需要：`fetch_my_gyms.py`（要 `defaults.cfHandle`）与 `gen_gym_manifest.py`
    （要保留手工条目）都必须先读清单，而新克隆的仓库、或被清空的文件里可能什么都没有 ——
    这时甩一句 `JSONDecodeError: Expecting value: line 1 column 1` 对用户毫无帮助
    （实测踩到过：先跑生成器、后建清单就会这样）。
    """
    path = path or MANIFEST
    if not os.path.isfile(path):
        return {'contests': []}
    try:
        data = read_json(path)
    except ValueError:
        return {'contests': []}
    if not isinstance(data, dict) or not isinstance(data.get('contests'), list):
        return {'contests': []}
    return data


def find_contest(manifest: dict, slug: str) -> dict:
    for c in manifest['contests']:
        if str(c.get('slug', '')).strip() == slug:
            return c
    raise KeyError(f'清单里没有 slug={slug}（清单里有 '
                   f'{", ".join(str(c.get("slug")) for c in manifest["contests"][:10])} …）')


def layers_of(contest: dict) -> tuple[dict, dict | None]:
    """
    取该场的两层容器：系列 + 中间层（年份/省份）。

    `mid` 可以没有（例如 ucup 就是 `official/ucup/<slug>.srk.json` 两层结构）。
    """
    series = contest.get('series') or {}
    if not series.get('id'):
        raise ValueError(f'{contest.get("slug")}: 缺 series.id')
    mid = contest.get('mid') or None
    if mid and not mid.get('id'):
        raise ValueError(f'{contest.get("slug")}: mid 有 name 却没 id')
    return series, mid
