#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
Codeforces **gym 比赛 → crate 片段**（C + P，带通过率）

为什么需要有它：`cf_adapter.py` 只出 **R**（提交），题单与通过率本来靠 PTA / rankland。
但"rankland 没收录的 gym 场次"（国外区域赛镜像、省赛、邀请赛…）就只能从 CF 自己的榜单取：

    contest.standings?contestId=<gym>&showUnofficial=true   ← **需要登录态**

实测：
  * `contest.standings` 对 gym 必须带凭据，否则 `contestId: You have to be authenticated`；
  * `rows` 只有 `showUnofficial=true` 才给（gym 里绝大多数是**虚拟参赛**）；
  * 非 gym 的普通场次不允许带参数查榜单（CF 只给匿名无参请求）。

凭据：见 `lib/cf_api.py`（**唯一来源是 `acm-data/raw/Scaper/me.json` 的 `cf.apiKey/apiSecret`**，
环境变量 `CF_API_KEY`/`CF_API_SECRET` 可临时覆盖）。

通过率口径（与 PTA / HDU / 牛客一致）
-------------------------------------
    ratio = 通过队伍数 ÷ 有效队伍数 × 100
    通过队伍数 = 该题 problemResults[].points > 0 的队伍数（逐行数出来）
    有效队伍数 = 至少解出 1 题的队伍数

⚠️ 与官方榜（PTA/牛客）**不完全同源**：gym 的榜包含虚拟参赛，人数通常比现场赛多，
   所以算出来的通过率会偏低。本适配器在产出片段里把这件事写进 `note`，不假装同源。

缓存：榜单原始响应存到清单里写的 `file`（默认 `cache/cf_standings_<gym>.json`），
     重跑直接读缓存 —— **想重抓加 `--force`**（通用读取层的开关）。

用法
----
    python cf_board_adapter.py cf101775
    python cf_board_adapter.py cf101775 --force
    python cf_board_adapter.py cf101775 --gym 101775 -o out.json
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys

sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, 'lib'))
sys.path.insert(0, os.path.abspath(os.path.join(HERE, '..', 'lib')))   # Scaper/lib（通用读取层）

from cf_api import call, has_credentials  # noqa: E402
from read_modes import print_stats, add_cli_args, configure_from, should_refetch  # noqa: E402
from xcpc_common import (GYM_WHITELIST, add_crate_path,  # noqa: E402
    CACHE, CF_GYM_SERIES, CF_GYM_SERIES_NAME, CF_PLATFORM, CF_PLATFORM_NAME,
    root_name_src,
    cf_gym_key, cf_problem_key,
    find_contest, fmt_ratio, is_ec_name, is_provincial_invitational,
    is_warmup_class, layers_of, load_manifest, phase_of, provincial_org_of,
    PROVINCIAL_SEG, PROVINCIAL_TYPE_NONE,
    provincial_type_of,
    read_json,
    region_of_name, rel, resolve, stage_of, tree_time_layer,
    WARMUP_LAYER, write_json, xcpc_area_layer, xcpc_series_layer,
    # ④ 的三组参数（**gym 那一份**）—— 判据与 XCPC / QOJ 共用同一批，只是顺序换了向
    REGION_STAGE_GYM, SEASON_STAGE_GYM, YEAR_STAGE_GYM,
)

# 统一环节模块（`Scaper/lib/stages.py`）：这一侧也走"判据 + 依据 + 记账"那一套
import stages as _stages  # noqa: E402

add_crate_path()

from crate import Crate, class_rules, link_kinds, nature_fields, to_cst, validate_crate  # noqa: E402

LABEL = 'Codeforces 榜单'
PAGE = 10000          # 单次 standings 最多取多少行（要更多就翻页）


def fetch_standings(gym: int, cache_path: str, verbose: bool = True) -> dict:
    """
    取 gym 榜单并**只留下需要的东西**（缓存也存这份摘要）。

    为什么不留原始响应：一场 gym 的 standings 是"队伍数 × 题数"的矩阵 ——
    几千队 × 十几题就是几十 MB；57 场下来几个 GB，纯属浪费。
    这里算完就丢：留下 `contest`（名字/时间）+ `problems` + 每题通过队伍数 + 有效队伍数。

    "要不要重抓"问**通用读取层**（`should_refetch`）：`--force` / `--cache-mode none` 时它说"要"。
    """
    if cache_path and not should_refetch(os.path.isfile(cache_path)):
        data = read_json(cache_path)
        if isinstance(data, dict) and 'solvedPerProblem' in data:
            if verbose:
                print(f'📦 用缓存 {rel(cache_path)}（{data.get("teams", 0)} 行）')
            return data

    if not has_credentials():
        sys.exit('❌ gym 榜单需要 Codeforces 凭据：在 acm-data/raw/Scaper/me.json 里填 '
                 'cf.apiKey/cf.apiSecret（或设环境变量 CF_API_KEY/CF_API_SECRET）')

    head = call('contest.standings', {'contestId': gym, 'from': 1, 'count': 1, 'showUnofficial': 'true'}, auth=True)
    contest = head['contest']
    problems = head['problems'] or []
    solved_per_problem = [0] * len(problems)
    effective = 0
    teams = 0

    start = 1
    while True:
        page = call('contest.standings',
                    {'contestId': gym, 'from': start, 'count': PAGE, 'showUnofficial': 'true'}, auth=True)
        rows = page.get('rows') or []
        for r in rows:
            prs = r.get('problemResults') or []
            solved_any = False
            for i, pr in enumerate(prs):
                if i < len(solved_per_problem) and (pr.get('points') or 0) > 0:
                    solved_per_problem[i] += 1
                    solved_any = True
            if solved_any:
                effective += 1
        teams += len(rows)
        if verbose:
            print(f'   ↓ standings {start}…{start + len(rows) - 1}（累计 {teams} 行）')
        if len(rows) < PAGE:
            break
        start += PAGE

    data = {
        '_note': 'gym 榜单摘要（原始矩阵已丢弃）。ratio 口径：通过队伍数 ÷ 有效队伍数（至少解出 1 题的队伍）。',
        'gym': gym,
        'contest': contest,
        'problems': problems,
        'teams': teams,
        'effective': effective,
        'solvedPerProblem': solved_per_problem,
    }
    if cache_path:
        write_json(cache_path, data)
    return data


def start_time_from_whitelist(gym) -> str:
    """
    从 `gym_whitelist.json` 里取这场 gym 的**开赛时间**（`startAt`，+08:00）。

    为什么需要它：CF 的 `contest.standings` 响应对 gym **不返回 `startTimeSeconds`**
    （实测缓存里的 contest 对象只有 id/name/类型/时长/出题人…），于是 C 节点的「比赛时间」
    会空着。而**抓白名单时**（`fetch_my_gyms.py` 读 `contest.list`）就已经拿到过它了 ——
    按"爬取时取好、脚本内合并"的原则，这里直接读那份，不额外发请求。
    """
    p = GYM_WHITELIST   # ⚠️ 路径只有一处（`xcpc_common.GYM_WHITELIST`）
    if not os.path.isfile(p):
        return ''
    try:
        wl = read_json(p)
    except (ValueError, OSError):
        return ''
    for g in (wl.get('gyms') or []):
        if str(g.get('id')) == str(gym):
            return str(g.get('startAt') or '')
    return ''


def iso_time(iso: str) -> str:
    """`2023-11-05T11:00:00+08:00` → `2023.11.05 11:00:00`（统一走 `crate.to_cst`）"""
    return to_cst(iso)


# ================================================================
# 「性质」四字段
#
# 判据：**CF gym 上的比赛 ⇒ 大类 `cf`**（办赛平台是 Codeforces；这些场次多半是
# XCPC 各站的镜像，但那要等用户在判重页与主树那场绑定，导入侧**不做自动匹配** ——
# 与"这棵树另起"的理由完全一致，见上面的骨架注释）。
# 分类写 **`cf/gyms`**（"cf gym 该放 cf/gyms"）：gym 是 CF 里**另一类比赛**
# —— 它不在 `/contests` 那张 `filterTypes` 表里（那张表只收正式 rated/unrated 场次），
# 所以它不是"套 others 之后没判出来"，而是**本来就有自己的一支**；`cf/gyms` 这个名字 = CF 官方口径
# （站点上就叫 `/gyms`，见 `cf:s:cf-gym` 那层容器）。
# 不能写成 `cf/others/无归类`（那会把"表里查不到"当成"归不了"）。
# 地区**留空**（"gym 有很多线下赛，很多能和 qoj/xcpc 绑定，只是暂时不填"）：
# 写 `无` 是错的（按"gym 都是线上赛"推出来的）—— 那些线下站的场地在名字里、也能跟
# QOJ/XCPC 那边对上，只是还没填 ⇒ 空 = "还没判"，挂在 ③ 待补里等着。
# 年份取"开赛时间里的第一个 20xx"（CF 的 `startTimeSeconds` 由 CF 官方给，是硬数据；
# 拿不到就留空 —— 年份空是"还没判"，与"判过了"不是一回事）。
#
# ---- gym 再细分一层（A 方案）-------------------------------
# 口径："接下来准备 cf gym 的分类。由于相比于 qoj 没有权威分类，精度会低很多"。
# **gym 的名字基本就是原比赛的名字**（实测 67 个名字全都命中至少一个可用信号：
# ICPC 34 / CCPC 17 / Regional 25 / Provincial 23 / Invitational 9 …），所以这里
# **复用 xcpc 那一套完全相同的判据**（`stage_of` / `is_provincial_invitational` /
# `region_of_name`）—— 规则只有一处，绝不重写第二份。
# 结构（A 方案）= **把 xcpc 子树原样镜像到 `cf/gyms/xcpc/…` 下**：
#   `cf/gyms/xcpc/icpc/<赛区>/<阶段>/<official|warm-up>`、`cf/gyms/xcpc/ccpc/<阶段>/…`、
#   `cf/gyms/xcpc/provincial&invitational/<份>`；另外 `cf/gyms/ucup`（只有 UC 身份的那些）
#   与 `cf/gyms/无归类`。
# ⚠️ **优先级**（第一条最重要）：**省赛/邀请赛 > CCPC > ICPC > UC > 无归类** ——
#    "比如又含 CCPC 又含省赛/邀请赛，那就一定是『只是与 CCPC 有关系的』省赛/邀请赛"。
# ================================================================

#: gym 那棵树的根（它下面镜像整棵 xcpc 子树）
GYM_PREFIX = 'cf/gyms'
#: ICPC 赛区读不出来时**停在哪里**（合法前缀 ⇒ 挂 ③ 等人补，不硬塞赛区）
GYM_ICPC_SHALLOW = f'{GYM_PREFIX}/xcpc/icpc'
#: 认 CCPC 的三种写法：`CCPC` / 中文全称 / **英文全称**（`China Collegiate Programming Contest`
#: —— 实测 `2019 China Collegiate Programming Contest Qinhuangdao Onsite` 既没写 CCPC、
#: 也没有中文，只有这一种写法；不认它就会掉进 `无归类`）
CCPC_PATTERN = (r'ccpc|中国大学生程序设计'
                r'|china collegiate programming contest|chinese collegiate programming contest')

#: 认 ICPC 的两种写法：`ICPC` / **英文全称**（`International Collegiate Programming Contest`
#: —— 与上面 CCPC 那条同一个坑：实测 `2022 International Collegiate Programming Contest,
#: Jinan Site` 既没写 ICPC、也没有中文，只有这一种写法。不认它就会掉进 `无归类`，
#: 而这一场在 rankland 里的身份是 `icpc2022jinan` ⇒ CF 副本既落不到
#: `cf/gyms/xcpc/icpc/ec/…`，也接不进「2022 IC济南」那个合成组，连带它的提交挂不上）。
#: 赛区/阶段**照旧**走共用判据（实测这场 `region_of_name` 读到 `ec`、`stage_of` 读到 `regional`）。
ICPC_PATTERN = r'icpc|international collegiate programming contest'


def gym_class_rule(contest_name: str, warns: list | None = None) -> tuple:
    """
    CF gym 的赛名 → `(分类路径, 分类依据规则id)`（**唯一实现**；规则与 xcpc 那侧共用同一批函数）。

    优先级：**省赛/邀请赛 → CCPC → ICPC → Universal/Open Cup → 无归类**。
    ⚠️ **省赛/邀请赛那一档只对 EC 生效**（"省赛/邀请赛判定只对 ec 赛区生效"）——
    怎么判 gym 的 EC 就靠赛名里的**中国标志**（`is_ec_name()`：`China`/`Chinese`/`中国`/`CCPC`
    /中国的省名与大区词如 `Zhejiang`、`东北`；`region_of_name()` 读到 `ec` 也算）。
    实测这让 `The 17th Zhejiang Provincial Collegiate Programming Contest`（没写 ICPC）照样进省赛，
    而外国那种 `… Collegiate Programming Contest`（没有中国标志）**不会被说成省赛**。

    ★ **规则 id 记的是最弱的那一环**（「依据强度」）：
      · `gym:name-provincial`（C）—— 赛名里明写着省/邀请赛（且 EC）；
      · `gym:name-stage`（C）—— 赛名里明写着 CCPC / ICPC；
      · `gym:infer-region`（D）—— ICPC 的**赛区靠城市/大区词推**（gym 的赛名里未必写赛区）；
      · `gym:name-ucup`（D）—— 只剩"Universal Cup / Open Cup"这个字符串身份；
      · `gym:shallow`（E）—— 是 ICPC，但赛区读不出来 ⇒ 停在 `cf/gyms/xcpc/icpc` 等人补；
      · `gym:unclassified`（E）—— 什么都没命中。
    """
    name = str(contest_name or '')
    region = region_of_name(name)
    # ① 省赛/邀请赛（**最靠前**，但**只对 EC**）：又含 CCPC 又含省赛/邀请赛的，
    #    是"与 CCPC 有关系的省赛/邀请赛"
    if is_ec_name(name) and is_provincial_invitational(name):
        # ★ 类型 + 主办两段**与 XCPC/QOJ 两侧同一份判据**（"细分应直接放到分类里"；
        #   正交化成 4×3 = 12 类）
        ptype = provincial_type_of(name)
        # ⚠️ 同 QOJ 那一支：判不出时 `provincial_type_of()` 返回 `未归类`（不是 `无归类`）。
        if ptype == PROVINCIAL_TYPE_NONE:
            return f'{GYM_PREFIX}/xcpc/{PROVINCIAL_SEG}/{PROVINCIAL_TYPE_NONE}', 'gym:name-provincial'
        porg = provincial_org_of(name)
        return phase_of(f'{GYM_PREFIX}/xcpc/{PROVINCIAL_SEG}/{porg}/{ptype}', name), 'gym:name-provincial'
    # ② CCPC（含"中国大学生程序设计"与英文全称 "China Collegiate Programming Contest"）
    if re.search(CCPC_PATTERN, name, re.I):
        stage = stage_of(name, 'ccpc', warns, name)
        return phase_of(f'{GYM_PREFIX}/xcpc/ccpc/{stage}', name), 'gym:name-stage'
    # ③ ICPC：赛区从赛名读（读不出就停在浅处，不猜）。写法同 ② 一样认缩写与英文全称
    if re.search(ICPC_PATTERN, name, re.I):
        if not region:
            msg = f'gym 赛名「{name[:60]}」是 ICPC，但赛区读不出来 ⇒ 停在 `{GYM_ICPC_SHALLOW}`，等人补'
            if warns is not None:
                warns.append(msg)
            else:
                print(f'   ⚠️ {msg}')
            return GYM_ICPC_SHALLOW, 'gym:shallow'
        stage = stage_of(name, 'icpc', warns, name)
        return phase_of(f'{GYM_PREFIX}/xcpc/icpc/{region}/{stage}', name), 'gym:infer-region'
    # ④ Universal Cup / Open Cup（只有它、又没有 ICPC/CCPC 身份的）
    if re.search(r'universal cup|open cup', name, re.I):
        return f'{GYM_PREFIX}/ucup', 'gym:name-ucup'
    # ⑤ 什么都不是
    return f'{GYM_PREFIX}/无归类', 'gym:unclassified'


def gym_class_of(contest_name: str, warns: list | None = None) -> str:
    """
    只要分类（`gym_class_rule()` 的第一个返回值）—— 单测/老调用方用这个。

    ⚠️ 规则只有**一处**：`gym_class_rule()`。这里不许再写一遍判定。
    """
    return gym_class_rule(contest_name, warns)[0]


def gym_parent_of(crate, cls: str, season: str, year: str, region: str, done: set) -> str:
    """
    按 **natureClass** 把 CF gym 的 S 层铺出来，返回这一场该挂的父键。

    "cf gym xcpc 同样按 nature 分类" ⇒ 不按"分类路径
    **每段一层** + 年份层"，而是 **"抄 qoj"**：

        cf:s:cf-gym                      ← 既有的那层（`cf gym`）
        ├── icpc / <赛区> / <赛季>       ← 例：`icpc` → `ec` → `2024`
        │   └── 热身赛                   ← **只有热身赛才建**这一层
        ├── ccpc / <赛季>                ← 不套 reg/final 层（同赛季内按时间排）
        ├── 省赛与邀请赛 / <赛季>        ← 同："省赛…分类换为仅赛季一层"
        └── ucup / <它自己的分类>        ← **不套时间层**（"ucup 就别分了"）

    与 QOJ 那棵树**层的种类与顺序一致**（那边是 QOJ 自己的层名，这边用 nature 的写法）——
    判据只有一份：`xcpc_common.tree_time_layer / xcpc_series_layer / xcpc_area_layer /
    is_warmup_class`。

    ⚠️ **不再把 `natureClass` 每段都铺成一层**：`regional` / `final` / `official` 这些段
    不再是层（"其下分类只有一层赛季，每个赛季内的比赛已经按时间排好了，不用套什么
    reg/final 层"）—— 一场是区域赛还是总决赛，看它自己的 `natureClass` 字段就够了。
    ⚠️ 省赛**不再按地点分层**（"分类换为仅赛季一层"）
    ⇒ 它和别的支一样只套一层**赛季**；`natureRegion` 仍在字段里（值不缺）。
    """
    series_seg, series_name = xcpc_series_layer(cls)
    if not series_seg:
        parts = [p for p in str(cls or '').split('/') if p][2:]     # 去掉 `cf` / `gyms`
        seg = parts[0] if parts else '无归类'
        key = f'{CF_GYM_SERIES}:{seg}'
        if key not in done:
            crate.series(CF_GYM_SERIES, key, name=seg)
            done.add(key)
        return key
    parent = CF_GYM_SERIES
    for seg, name in ((series_seg, series_name), xcpc_area_layer(cls)):
        if not seg:
            continue
        key = f'{parent}:{seg}'
        if key not in done:
            crate.series(parent, key, name=name)
            done.add(key)
        parent = key
    seg, label = tree_time_layer(cls, season, year)
    if seg:
        key = f'{parent}:{seg}'
        if key not in done:
            crate.series(parent, key, name=label)
            done.add(key)
        parent = key
    if is_warmup_class(cls):
        key = f'{parent}:warm-up'
        if key not in done:
            crate.series(parent, key, name=WARMUP_LAYER)
            done.add(key)
        parent = key
    return parent


def cf_nature(ctime: str = '', name: str = '', warns: list | None = None) -> dict:
    """CF gym 的 C 的性质字段（`ctime` = 已转成 `YYYY.MM.DD …` 的开赛时间，`name` = 赛名）。

    **分类**（A 方案）：`cf/gyms/xcpc/<…>` 那棵镜像树，判据见 `gym_class_of`。

    **赛季 = 举办年份**（"通常单说 cf 有仅 cf contest 的含义" —— `无` 只给 CF 的**正式轮次**
    （`/contests` 那张表里的），**gym 不算**：gym 是别人借 CF 平台办的**比赛**，有自己的年份
    ⇒ 赛季就写举办年份。写 `无` 是**错的**（会把 gym 混进"没有赛季概念"的那一堆））。

    ⚠️ **"cf/gyms 的年份与赛季也补一补（可能只能靠名字）"** ⇒ 两个字段**各有主次**：
      · **赛季** = **赛名里第一个 20xx**（gym 的名字就是原比赛的名字：`The 2020 ICPC Asia Yinchuan
        Regional` ⇒ 2020 赛季），赛名里没有才退到 CF 的开赛时间；
      · **年份（举办）** = **CF 的开赛时间**（那是"这场 gym 什么时候真办的"，硬数据），
        拿不到才退到赛名里的年份；
      · **总决赛**（EC-Final / CCPC Final）**拿不到开赛时间就写 `待同步`**（它们的举办年
        落在"赛季年或次年"、不唯一，见 `FINAL_SEASON_WINDOW`）。
    ⚠️ 为什么两个字段要**分主次**（实测 3 场不一致，全都是"赛季年 ≠ 举办年"的真情况）：
      · `cf:c:104022` The **2020** ICPC Asia Yinchuan Regional —— 疫情延期，**2021** 才办
        （与 XCPC 侧那场一致：年 2021 / 季 2020）；
      · `cf:c:105173` The **2024** CCPC National Invitational (Northeast) —— **2023** 年 12 月办；
      · `cf:c:103861` **2021** ICPC Asia East Continent **Final** —— **2022** 办（总决赛跨年）。
    还有 13 场**名字里有年份、但 CF 没给开赛时间**的（如 `The 2021 Sichuan Provincial Collegiate
    Programming Contest`）⇒ 靠赛名把年份补上（否则只能空着挂在 ③）。

    **地区留空**（"gym 有很多线下赛，很多能和 qoj/xcpc 绑定，只是暂时不填"）
    —— 按"gym 都是线上赛"写 `无` 是**错的**：`无` 是"判过了、没有场地"，而这些 gym
    里**很多是线下赛**（区域赛/省赛的镜像），场地就在场次名里、也能跟 QOJ/XCPC 侧那场对上，
    只是**此刻还没填** ⇒ 空 = "还没判"，挂在 ③ 性质待补里等（那才是它该待的地方）。

    ⚠️ **三个字段走的是同一个环节模块**（`Scaper/lib/stages.py`），只是参数与 XCPC 侧不同：
    判据是**同一批**（`SEASON_FROM_NAME` / `SEASON_FROM_TIME` / `YEAR_TIME_THEN_NAME` /
    `REGION_CORE`，都在 `xcpc_common`），差的只有**顺序与集合** —— 赛季这里"赛名优先"、
    年份这里"时间优先、退到赛名"。以前这里是**自己拼一遍**（三条 if + 手拼规则 id），
    与 `xcpc_nature` 是两份实现；现在两边是同一个模块的两组参数。
    """
    cls, rule = gym_class_rule(name, warns)
    # `item` 统一成 `(赛名, 时间文本)`（与 `xcpc_nature` 同一形状 ⇒ 判据才换得过来）
    item = (str(name or ''), str(ctime or ''))
    ctx = {'cls': cls, 'warns': warns}
    season_ans = _stages.resolve(SEASON_STAGE_GYM, item, ctx)
    season, season_rule = (season_ans.value or ''), (season_ans.rule or '')
    # 年份那一档要吃赛季（与 XCPC 侧同一个顺序：赛季 → 年份 → 地区）
    year_ans = _stages.resolve(YEAR_STAGE_GYM, item, {**ctx, 'season': season})
    held, year_rule = year_ans.value, (year_ans.rule or '')
    # 地区（要用分类：网络赛那一档只看分类；gym 的赛名基本就是原比赛的名字）
    region_ans = _stages.resolve(REGION_STAGE_GYM, item, ctx)
    region, region_rule = (region_ans.value or ''), (region_ans.rule or '')
    return {**nature_fields(('natureClass', cls),
                            ('natureYear', held),
                            ('natureSeason', season),
                            ('natureRegion', region)),
            # 分类依据（元列 `分类依据`）：这条分类是**哪条规则**判出来的（见 `gym_class_rule`）
            **class_rules(('natureClass', rule), ('natureYear', year_rule),
                          ('natureSeason', season_rule), ('natureRegion', region_rule))}


def build(contest_meta: dict, slug: str, gym: int, data: dict,
          role: str = 'board') -> tuple[Crate, dict] | tuple[Crate | None, dict]:
    series, mid = layers_of(contest_meta)
    c = data.get('contest') or {}
    # CF 那棵树上这场比赛的名字：**用 CF 自己的**（gym 的官方赛名）。
    # ⚠️ 三个角色（board / titles / website）都要写**同一个表达式** ——
    #    否则合并时同字段两个值会报冲突；而只写一个角色的话，
    #    那些"只跑 titles 的场次"在 CF 树上就会没名字（实测 67 场里 35 场没名字）。
    cf_name = c.get('name') or contest_meta.get('name', '')
    problems = data.get('problems') or []
    solved_per_problem = data.get('solvedPerProblem') or []
    effective = int(data.get('effective') or 0)

    # 角色决定 kind：`titles` 是**补充**（题名/题链接），不是权威榜单 ——
    # 类别错了会在投影里压错值（xcpcio 的 ratio 是 board，CF 的题名该是 script）。
    kind = 'board' if role == 'board' else 'script'
    crate = Crate(source_id=f'cf-{slug}' if role == 'board' else f'cf-titles-{slug}',
                  label=LABEL if role == 'board' else 'Codeforces 题名/题链接',
                  platform=CF_PLATFORM, kind=kind)
    # ---- CF 那棵树的骨架：W cf → S cf gym → S <系列>[:<赛区>] → S <年份> → C <gym id> ----
    #      （形状的唯一一份实现在 `gym_parent_of()`；**没有 `xcpc` 那一段**）
    # ⚠️ 全部以 `cf` 开头 ⇒ crate-merge 不会把它与主树（`xcpc:*`）合并。
    # 要不要跟主树那场算同一场，由用户在判重整理页绑 `映射元素值`（导入侧不做自动匹配）。
    ck = cf_gym_key(gym)
    # 比赛时间：榜单响应里有就用它；没有（gym 就是这样）退回抓白名单时存下的那份。
    # ⚠️ 拿不到就**别写空串**：`Crate` 只丢 `None`、不丢 `""`，写空串等于"我认为它是空的"，
    #    会把合并时"后到者补空"的机会占掉（实测：rankland 索引补进来的时间被空串压掉了）。
    ctime = to_cst(c.get('startTimeSeconds')) if c.get('startTimeSeconds') else ''
    if not ctime:
        ctime = iso_time(start_time_from_whitelist(gym))

    # ★ **性质只算一次**：三个角色（board / titles / website）写的是**同一个 C**，
    #   父键与性质必须逐字相同，否则合并时会报 `extkey-parent-conflict` / 字段冲突。
    #   （website 那支若另用一份 ctime 去算 nature，同一场两个算法，早晚要打架。）
    nature = cf_nature(ctime, cf_name)

    def skeleton(one: Crate) -> str:
        """把骨架铺在 `one` 上，返回这一场该挂的父键（系列 → 赛区/地点 → 赛季）。"""
        one.platform(CF_PLATFORM, name=CF_PLATFORM_NAME, **root_name_src(one),
                     **link_kinds(('browse', 'https://codeforces.com/')))
        one.series(CF_PLATFORM, CF_GYM_SERIES, name=CF_GYM_SERIES_NAME,
                   **link_kinds(('browse', 'https://codeforces.com/gyms')))
        # `done` 先塞进已经建好的那层，免得重复出一遍（同一个 S 只能出一遍）
        done = {CF_GYM_SERIES}
        # ⚠️ 时间层**赛季优先**（gym 的赛季就是举办年份）、省赛只按赛季、ucup 不套 ——
        #    判据全在 `gym_parent_of` / `xcpc_common` 那一份里，这里只把 nature 递进去
        return gym_parent_of(one, str(nature.get('natureClass') or ''),
                             str(nature.get('natureSeason') or ''),
                             str(nature.get('natureYear') or ''),
                             str(nature.get('natureRegion') or ''), done)

    ck_parent = skeleton(crate)

    if role == 'website':
        # 只出 C 的**官网链接**（CF 给的 `websiteUrl`）—— EC 区镜像多半没有，别的赛区镜像常有。
        # websiteUrl 很不稳定，但确实可以当链接用。
        # 类别按现有 4 类只能是 `unknown`（4 类里没有"官网"）——
        # **不丢**，如实记成 unknown，应用侧照样显示（"非空就显示"）。
        url = str(c.get('websiteUrl') or '').strip()
        if not url:
            # ⚠️ **不能裸 `return None`**：`main` 是按 `crate, stats = build(...)` 解包的
            #    ⇒ 这一支会当场 `TypeError: cannot unpack non-iterable NoneType object`，
            #    整场被判"适配器失败"、连带**整包不写**（实测：给"只有提交、没有官网链接"的
            #    场次补上 `website` 角色后，100 多场一起炸）。没链接 = 这一场**没内容可出**，
            #    不是错误 ⇒ 照样回 (None, stats)，由调用方跳过。
            return None, {'effective': 0, 'teams': 0, 'problems': 0, 'named': 0}
        crate = Crate(source_id=f'cf-web-{slug}', label='CF 官网链接',
                      platform=CF_PLATFORM, kind='script')
        web_parent = skeleton(crate)          # 同一个 C ⇒ 父键必须与别的角色完全一致
        crate.contest(web_parent, cf_gym_key(gym), name=cf_name,
                      **nature,
                      **link_kinds(('unknown', url)))
        return crate, {}

    if role == 'titles':
        # P 的题名/题链接/tags ——**一个 ratio 都不写**。
        # 什么时候用它：xcpcio 抢走 board 之后（xcpcio 是最权威的 ratio 源），
        # CF 榜不再算 ratio，但它的题名/题链接是 xcpcio 给不出的（xcpcio 只有题号）。
        # ⚠️ 没有 titles 角色时，那 14 场 CF 榜的 155 道题名 + 155 个链接会整场丢掉。
        # C 节点照出（**名字与 gym 链接都要给**：CF 那棵树上的每个比赛都得有名字、
        # 能点开 —— 别的角色（board）也写同一个 gym 链接，值相同不会冲突），
        # 其它字段（ratio 等）留空，由 board 角色或别的来源补。
        crate.contest(ck_parent, ck, name=cf_name,
                      **nature,
                      **link_kinds(('problems', f'https://codeforces.com/gym/{gym}')))
        for p in problems:
            letter = str(p.get('index') or '').strip()
            if not letter:
                continue
            crate.problem(ck, cf_problem_key(gym, letter),
                          problem_id=letter,
                          name=str(p.get('name') or ''),
                          link=f'https://codeforces.com/gym/{gym}/problem/{letter}',
                          tags=([str(t) for t in (p.get('tags') or []) if str(t).strip()] or None))
        stats = {'effective': effective, 'teams': int(data.get('teams') or 0),
                 'problems': len(problems), 'solved': solved_per_problem}
        return crate, stats

    # CF gym 的榜单是 `/standings`（类别 board），gym 主页是**补题入口**（类别 problems）。
    # 爬取层只声明这两个类别，缓存值由应用层挑。
    crate.contest(ck_parent, ck, name=cf_name,
                  contestTime=ctime or None,
                  kind='contest',
                  **nature,
                  **link_kinds(('board', f'https://codeforces.com/gym/{gym}/standings'),
                               ('problems', f'https://codeforces.com/gym/{gym}')))

    for i, p in enumerate(problems):
        letter = str(p.get('index') or '').strip()
        if not letter:
            continue
        crate.problem(ck, cf_problem_key(gym, letter),
                      problem_id=letter,
                      name=str(p.get('name') or ''),
                      link=f'https://codeforces.com/gym/{gym}/problem/{letter}',
                      # CF 每题给的 tags（dp/贪心/图论…）。EC 区镜像多半没有，别的赛区镜像常有 ——
                      # 有就写，没有写 None（不占位，留给别的来源）。
                      tags=([str(t) for t in (p.get('tags') or []) if str(t).strip()] or None),
                      ratio=(fmt_ratio(solved_per_problem[i] if i < len(solved_per_problem) else 0,
                                       effective) or None))

    stats = {'effective': effective, 'teams': int(data.get('teams') or 0),
             'problems': len(problems), 'solved': solved_per_problem}
    return crate, stats


def main(argv):
    ap = argparse.ArgumentParser(description='Codeforces gym 榜单 → crate 片段（C + P）')
    ap.add_argument('slug', nargs='?')
    ap.add_argument('-o', '--output', default='')
    ap.add_argument('--gym', type=int, default=0, help='临时指定 gym 号')
    ap.add_argument('--file', default='', help='临时指定榜单缓存文件')
    # `--force`（忽略缓存重抓）等三个开关来自**通用读取层**；重试仍由 cf_api 自己管（它有 CF 的退避）
    add_cli_args(ap)
    ap.add_argument('--manifest', default='')
    ap.add_argument('--list', action='store_true')
    ap.add_argument('--role', default='board', choices=('board', 'website', 'titles'),
                    help='board=榜单（C+P+ratio）；website=**只出 C 的官网链接**；'
                         'titles=**只出 P 的题名/题链接**（xcpcio 当 board 时用，不写 ratio）')
    args = ap.parse_args(argv)
    configure_from(args)

    manifest = load_manifest(args.manifest)
    if args.list:
        for c in manifest['contests']:
            b = c.get('board') or {}
            if b.get('source') == 'cf':
                print(f"   {c['slug']:<20} gym={b.get('gym')}   {c.get('name', '')}")
        return 0

    if not args.slug:
        print('要给一个 slug', file=sys.stderr)
        return 2
    contest = find_contest(manifest, args.slug)

    # 榜单不一定还是 CF：xcpcio 更权威时 CF 榜降级，这里看**清单里的来源条目**
    # （board=cf 或 sources 里有 cf；角色由调用方给）。
    def cf_entry() -> dict:
        b = contest.get('board') or {}
        if b.get('source') == 'cf':
            return b
        for s in (contest.get('sources') or []) + (contest.get('submissions') or []):
            if (s.get('source') or '') == 'cf' and s.get('gym'):
                return s
        return {}

    entry = cf_entry()
    if not entry:
        print(f"ℹ️ 清单里 {args.slug} 没有 CF 来源，跳过")
        return 0

    gym = args.gym or int(entry.get('gym') or 0)
    if not gym:
        print(f'❌ 清单里 {args.slug} 的 CF 来源缺 gym 号', file=sys.stderr)
        return 1

    cache_path = resolve(args.file or entry.get('file') or os.path.join(CACHE, f'cf_standings_{gym}.json'))
    print(f'📊 CF gym {gym} → {args.slug}')
    data = fetch_standings(gym, cache_path)

    crate, stats = build(contest, args.slug, gym, data, args.role)
    if crate is None:
        out0 = args.output or os.path.join(CACHE, f'crate_{args.slug}_cf_website.json')
        if os.path.isfile(out0):
            os.remove(out0)
        print(f'ℹ️ {args.slug} 的 CF 榜单里没有 websiteUrl，不产出片段')
        return 0
    # ⚠️ `website` 角色**不能在这里 return**：下面的 `crate.save(out)` 才是写片段的地方，
    #    提前返回 = 片段从不落盘 → 流水线 `os.path.isfile(out)` 判否 → 静默当成"这场没数据"跳过
    #    （实测踩到：25 场官网链接一条都没进包，且流水线不报任何错）。
    #    所以这里只改输出，写盘走同一条路。
    if args.role == 'website':
        print(f"   CF 官网：{data['contest'].get('websiteUrl', '')}")
    elif args.role == 'titles':
        named = sum(1 for p in (data.get('problems') or []) if str(p.get('name') or '').strip())
        print(f"   比赛：{data['contest'].get('name', '')}")
        print(f"   只出题名/题链接（**不算 ratio**，ratio 由 xcpcio 出）："
              f"{stats['problems']} 道题，其中 {named} 道有题名")
    else:
        print(f"   比赛：{data['contest'].get('name', '')}")
        print(f"   题目 {stats['problems']} 道｜榜单 {stats['teams']} 行｜有效队伍数 {stats['effective']}")
        print(f"   通过队伍数（逐题）：{', '.join(str(n) for n in stats['solved'][:8])}"
              + (' …' if len(stats['solved']) > 8 else ''))

    out = args.output or os.path.join(CACHE, f'crate_{args.slug}_cf_{args.role}.json')
    crate.save(out)
    issues = validate_crate(crate.to_dict())
    hard = [i for i in issues if '父节点' not in str(i)]
    print(f'✅ {rel(out)}   {crate.summary()}')
    for w in ([i for i in issues if '父节点' in str(i)][:1]):
        print('   ℹ️', w)
    if hard:
        print(f'❌ 校验问题 {len(hard)}：')
        for it in hard:
            print('   •', it)
        return 1
    print_stats('CF 榜单')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
