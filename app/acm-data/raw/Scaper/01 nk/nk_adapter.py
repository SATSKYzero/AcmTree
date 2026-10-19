#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
牛客（Nowcoder）适配器 —— 把 nk_cid*.json 转成 Acm_Tree 导入包

输入（都由同目录下的爬虫/抓取脚本产出）
--------------------------------------
  nk_cid<CID>_contest.json    比赛身份（id + 名字）；题目爬虫顺带写的旁挂文件
  nk_cid<CID>_problems.json   某场比赛的题目列表
  nk_cid<CID>_submits.json    某场比赛的提交记录（可选）
  nk_cid<CID>_rank_stats.json（在榜单旁边）     榜单统计（`nk_rank_stats.py` 的产出）→ **ratio 的来源**

输出：一份 crate（导入包），可直接拖进应用的「📥 节点自动导入」。

用法
----
    # 最省事：跑流水线，它自己找输入、自己按顺序调脚本
    python "acm-data/raw/Scaper/01 nk/nk_pipeline.py" --all

    # 手动指定（等价于流水线内部做的事）
    python "…/nk_adapter.py" "…/2026nk2/nk_cid133877_contest.json" "…/2026nk2/nk_cid133877_problems.json" "…/2026nk2/nk_cid133877_submits.json" -o acm-data/nodes/nk-multi-university.json --rank-stats "…/2026nk2/nk_cid133877_rank_stats.json"

    # 离线自查（推荐）
    npm run crate:check -- acm-data/nodes/nk-multi-university.json

设计的几个关键决定
------------------
1. **比赛身份只能从链接里认**：题目/提交的链接形如
   `/acm/contest/133877/A`，那串数字就是比赛 ID。题目列表本身既没有
   比赛名也没有 ID，所以题目爬虫额外写了一个 `nk_cid<CID>_contest.json`
   旁挂文件 —— 没有它，C 节点只能叫"比赛 133877"。
2. **extKey**：
       平台      nk
       系列      nk:series:<sid>          ← 牛客暑期多校 / 练习赛…
       年份      nk:series:<sid>:<year>
       比赛      nk:c:<cid>              ← 牛客的比赛 ID（稳定）
       题目      nk:c:<cid>:p:<A>        ← 字母题号（牛客本来就是字母）
       提交      nk:sub:<rid>            ← 运行ID 稳定
   树形与 HDU 保持一致：W → S → S(年份) → C → P → R。
3. **ratio 只认榜单口径**：通过队伍数 ÷ 有效队伍数（与 HDU 同一口径）。
   题目页那个「通过率 36/54」**分母不明**，默认不采用
   （要采用就设 EXPORT_PAGE_RATIO = True，风险自负）。
4. **`团队状态` / `运行结果` 不写进节点字段**：题目的通过状态由应用从
   R（提交记录）推导（见 docs/auto-import.md 7.6）。
   这里仅用它们做**交叉校验**，不一致时给提示。
"""

from __future__ import annotations

import json
import os
import re
import sys

# 不要生成 __pycache__（下面要 import 仓库里的 crate.py 与 lib/nk_common.py）
sys.dont_write_bytecode = True

# ---- 找到 crate.py（构造器） ----
# 两种情形都要能用：
#   1. 在本仓库里：本脚本在 acm-data/raw/Scaper/01 nk/，构造器在 <repo>/scripts/
#   2. 你把本文件抄进自己的项目：把 crate.py 放在同目录即可
_HERE = os.path.dirname(os.path.abspath(__file__))
_SEARCH = [
    _HERE,                                                      # 同目录（抄走时的情形）
    os.path.join(_HERE, '..', '..', '..', '..', 'scripts'),     # ★ 本仓库：<repo>/scripts/
    os.path.join(_HERE, '..', '..', '..', 'scripts'),
    os.path.join(_HERE, '..', '..', 'scripts'),
]
for _p in _SEARCH:
    _p = os.path.abspath(_p)
    if os.path.isfile(os.path.join(_p, 'crate.py')):
        sys.path.insert(0, _p)
        break
else:
    sys.exit('找不到 crate.py。请把它与本脚本放在同一目录，或从仓库的 scripts/ 下运行。')

from crate import (SUBMIT_DURING, SUBMIT_AFTER,  # noqa: E402
    Crate, _s, class_rules, contest_day, link_kinds, nature_fields, normalize_status, normalize_time, season_of,
    validate_crate,
)

# ---- 接上公共工具（lib/nk_common.py）----
# 链接解析、比赛名提取、读 JSON 都在那里，只有一份
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'lib'))
from nk_common import (  # noqa: E402
    parse_link, read_json,
)


def handle_from_me() -> list[str]:
    """
    从 `acm-data/raw/Scaper/me.json` 读**要认领的牛客账号**（可以多个）。

    来源顺序（见 `lib/me.py` 的 `handles()`）：`nk.handles` 列表 → 花名册 `team[].nk`
    → 单个 `nk.handle`。`me.json` 里**没写**就返回空列表（不报错）：没有它只是"提交不带账户线索"。
    环境变量 `NK_HANDLES`/`NK_HANDLE` 可临时覆盖。

    ★ **不再兜底**（2026-10-16，用户定的口径："② 干脆别兜底"）：原来 `me.py` 导不进来时会
      自己解析 `me.json`（只读 `nk.handles` + 单数 `nk.handle`、**不认花名册**）⇒ 会**静默缩小**
      认领范围；现在导不进来就**当场停**（`me.json` 本身没有/没写仍是"返回空列表"）。
    """
    here = os.path.dirname(os.path.abspath(__file__))
    shared = os.path.abspath(os.path.join(here, '..', 'lib'))
    if shared not in sys.path:
        sys.path.insert(0, shared)
    try:
        import me as me_mod
    except ImportError as err:
        sys.exit(f'❌ 读不到 {shared}{os.sep}me.py（{err}）—— 这里**不自己解析 me.json**：'
                 f'认领范围（含花名册）只有那一份实现，兜底会静默缩小范围。修好这个 import 再跑。')
    return [h for h in (me_mod.handles('nk') or []) if h]


# ================================================================
# ★★★ 配置区：要改就改这里 ★★★
# ================================================================

# ---- 1. 平台标识 ----
PLATFORM = 'nk'
PLATFORM_NAME = '牛客'
LABEL = '牛客爬虫'

# ---- 2. extKey 模板（应用**不解析** key，这里纯粹是你自己的约定）----
#
# 可用占位符：
#   {platform}  平台段
#   {sid}       系列标识（由 SERIES_RULES 归类）
#   {year}      年份（GROUP_BY_YEAR 打开时用）
#   {cid}       比赛 ID（链接里的 /acm/contest/<cid>/）
#   {pid}       题目的**字母**（牛客题目列表的"题号"本来就是 A/B/C…）
#   {rid}       提交的运行 ID
KEY_PLATFORM = '{platform}'
KEY_SERIES = '{platform}:series:{sid}'
KEY_YEAR = '{platform}:series:{sid}:{year}'
KEY_CONTEST = '{platform}:c:{cid}'
KEY_PROBLEM = '{platform}:c:{cid}:p:{pid}'
KEY_SUBMISSION = '{platform}:c:{cid}:sub:{rid}'

# ---- 3. 系列分组规则（比赛名 → 挂在哪个 S 下）----
#
#   (正则, 系列标识, 系列显示名)
#
# 按顺序匹配，命中即停；都不命中 → SERIES_FALLBACK。
# **比赛必须挂在 S 下**（应用不允许 W 下直接放 C）。
SERIES_RULES = [
    (re.compile(r'暑期多校|多校训练营|牛客多校'), 'summer', '牛客暑期多校'),
    (re.compile(r'练习赛|周赛|小白月赛|挑战赛'), 'practice', '牛客练习赛/周赛'),
]
SERIES_FALLBACK = ('other', '其他比赛')

# 系列 → nature 小类。**只有多校那条是 `多校`**：
# "多校"指"多所高校各出题、联合办一场联赛"的赛制，练习赛/周赛/小白月赛都不是 ⇒ 那些写
# **`无`**（"这个维度上不适用"；与"留空 = 还没判"是两件事：写 `无` 就不在③ 性质待补里了）。
SUB_BY_SERIES = {'summer': 'nk/多校'}
SUB_DEFAULT = 'nk/无归类'

# ---- 3b. 年份层级（系列 → 年份 → 比赛）----
#
# 与 HDU 一致：一个系列年年都有比赛，插一层年份免得系列下越铺越长。
# 年份先看比赛名里的 20xx，再看开始时间；都认不出就直接挂系列下（合法）。
GROUP_BY_YEAR = True
YEAR_RE = re.compile(r'(20\d{2})')

# ---- 4. 字段开关 ----
#
# ratio / 通过率：默认**只认榜单口径**（通过队伍数 / 有效队伍数，与 HDU 同一口径）。
# 题目页那个「通过率 36/54」的分母说不清（不是队伍数），
# 用它会让不同平台的 ratio 不可比 —— 所以默认关掉。
EXPORT_PAGE_RATIO = False

# 提交结果别名（牛客已给出 运行结果2，这里只兜底）
STATUS_ALIAS = {'等待评测': 'PD', '排队中': 'PD', '编译中': 'PD', 'Running': 'PD'}

# ---- 7. 提交的运行信息（先提取备用，口径 = 毫秒 / 字节）----
#
# `nk_cid<CID>_submits.json` 里这四样都有，适配器把它们一并写进包：
#     `使用语言`      → language   （C++ / Python3…，原样搬）
#     `运行时间(ms)`  → timeUsed   （**毫秒**，与 CF/QOJ/HDU 同口径）
#     `使用内存(KB)`  → memoryUsed （牛客给 **KB**，×1024 转字节）
#     `代码长度`      → codeLength （**字节**；这是三个平台里唯一有它的，HDU/QOJ 都给不出）
# 拿不到就写 `None`（不写 ""：空串会占位、把"后到者补空"的机会吃掉）。

# ---- 8. 账户线索（这条提交是谁的）----
#
# 与 XCPC/HDU 同一个机制：`{source, field, value}` 三元组，适配器只**如实搬运**。
# 牛客与 HDU 不同的一点：**提交记录里自带「用户名」**（还有用户主页链接），
# 所以线索不用你声明就能从数据里取 —— 但那样会把别人的提交也认成你的，
# 所以约定是：**只给"用户名 == 你在 me.json 里声明的 nk.handle"的那几条**打线索。
# 没声明 handle 就不打（宁可不给，也不给个假的）。
#
# ⚠️ source 带赛季（`nk:2026`，**四位年份**，与 hdu 一致）
#    ：应用按三元组**全等**匹配，
#    两条映射声明同一三元组会冲突、谁都不认领；届与届之间队友会换，得分开。
CLUE_FIELD = '用户名'


def submit_clue(username: str, handle, year: str, cid: str) -> dict | None:
    """
    这条提交的账户线索；**只给"用户名在花名册里"的那几条**（别人提交不打）。

    `handle` 可以是单个字符串或列表（多账号）。
    为空 → 返回 None（宁可不给，也不给个假的）。
    """
    u = _s(username)
    want = {_s(h) for h in ([handle] if isinstance(handle, str) else (handle or []))}
    want.discard('')
    if not u or not want or u not in want:
        return None
    return {'source': f'nk:{season_of(year) or _s(cid)}', 'field': CLUE_FIELD, 'value': u}


# `run_fields`（提交的运行信息 → 包字段）**只有一份**，在 `scripts/crate.py` 里 ——
# 牛客比 HDU 多一列 `代码长度`，但那份实现是**通用的**：源里没有的列自然得到 `None`。
from crate import run_fields  # noqa: E402,F401

# ---- 6. 节点上挂的链接 ----
#
# 应用里 C 节点与 W 节点都会渲染 `link`（view/builders.js 的 buildCNodeMeta /
# buildWSNodeMeta → "🔗 链接"），所以这两级值得带上链接。
#
# 比赛 URL **优先用采集时记下的真实地址**（collect-nk-problems.js 会把
# 当前页的 location.href 写进源文件头，爬虫再落到 nk_cid<CID>_contest.json 的
# contestUrl）—— 牛客的网址形态不止一种，别拿模板去猜。
# 没记录时才退回下面这个模板。
CONTEST_URL = 'https://ac.nowcoder.com/acm/contest/{cid}'
PLATFORM_URL = 'https://ac.nowcoder.com/acm/contest/vip-index'
# 榜单（排名）页：C 节点的 `boardLink` 用它（只在有 rank_stats 的场次才写）
# ⚠️ 牛客**没有** `/rank` 这个路由（实测：服务端一律回"页面找不到了"的 404 壳）；
# 榜单是比赛页上的一个**前端标签**，所以要用 `#rank` 锚点。
RANK_URL = 'https://ac.nowcoder.com/acm/contest/{cid}#rank'


# ================================================================
# extKey 构造
# ================================================================

def platform_key() -> str:
    return KEY_PLATFORM.format(platform=PLATFORM)


def series_key(sid: str) -> str:
    return KEY_SERIES.format(platform=PLATFORM, sid=sid)


def year_key(sid: str, year: str) -> str:
    return KEY_YEAR.format(platform=PLATFORM, sid=sid, year=year)


def contest_key(cid: str) -> str:
    return KEY_CONTEST.format(platform=PLATFORM, cid=cid)


def problem_key(cid: str, letter: str) -> str:
    return KEY_PROBLEM.format(platform=PLATFORM, cid=cid, pid=letter)


def submission_key(cid: str, rid: str) -> str:
    """
    提交的 extKey：`nk:c:<比赛号>:sub:<运行ID>`。

    ⚠️ extKey 里必须**带上 `cid`**（只写 `nk:sub:<rid>` 不够）：牛客的运行 ID 换场会重号
    （hdu 实测 10 场里 5 个 rid 跨场重复），不带 cid 时跨场撞号会让 `crate.py` 抛
    "extKey 重复"。键就是身份 —— 要动它得在首次导入前动（当前数据里没有手改过的字段，
    可以整批换）。
    """
    return KEY_SUBMISSION.format(platform=PLATFORM, cid=cid, rid=rid)


# 多校/训练营的**常见比赛时段**（牛客多校几乎总是 12~17）。
# 实测印证：133876/133877/133885 都是 12:00~17:00（5 小时）。
# 只在**拿不到精确起止时间**时才用它。
ASSUMED_WINDOW = ('12:00', '17:00')


def submit_kind(submit_time, start_ms=None, end_ms=None) -> str:
    """
    牛客提交性质：`赛时` / `补题`；**判不准返回 ''**（不写"未知"）。

    ⚠️ **不能按"日期相同"判**（**当天补题非常常见**）——
    必须用**比赛时段**：

      ① 有精确起止（`nk_cid*_contest.json` 的 `startTime`/`endTime`，epoch 毫秒，
         由 `Nowcoder_prob_scraper.py` 从比赛页的 `window.pageInfo` 里存下来）
         → 提交落在窗口内 = `赛时`，否则 = `补题`
      ② 没有 → **用常见时段假设** 开赛日 12:00~17:00（见 `ASSUMED_WINDOW`）
      ③ 连开赛日期都没有 → 留空
    """
    sub_day = contest_day(submit_time)
    if not sub_day:
        return ''
    m_sub = re.search(r'(\d{1,2}):(\d{2})', _s(submit_time))
    if not m_sub:
        return ''
    sub_hm = f'{int(m_sub.group(1)):02d}:{m_sub.group(2)}'

    import datetime as _dt
    tz = _dt.timezone(_dt.timedelta(hours=8))
    if start_ms and end_ms:
        try:
            a = _dt.datetime.fromtimestamp(int(start_ms) / 1000, tz)
            b = _dt.datetime.fromtimestamp(int(end_ms) / 1000, tz)
        except (TypeError, ValueError, OSError):
            a = b = None
        if a and b:
            if sub_day != a.strftime('%Y-%m-%d'):
                return SUBMIT_AFTER
            cur = _dt.datetime.strptime(f'{sub_day} {sub_hm}', '%Y-%m-%d %H:%M').replace(tzinfo=tz)
            return SUBMIT_DURING if a <= cur <= b else SUBMIT_AFTER
        return ''

    # ② 没有精确时段：只能"开赛日 + 常见时段"（连开赛日期都没有就留空）
    #    ⚠️ `start_ms` 是 **epoch 毫秒（int）**，不是字符串 —— 若写成
    #    `isinstance(start_ms, str)`，这条分支**永远走不到**，
    #    `ASSUMED_WINDOW` 也就形同虚设（HDU 侧是真的在用）。
    start_day = ''
    if start_ms:
        try:
            start_day = _dt.datetime.fromtimestamp(int(start_ms) / 1000, tz).strftime('%Y-%m-%d')
        except (TypeError, ValueError, OSError):
            start_day = ''
    if not start_day:
        return ''
    if sub_day != start_day:
        return SUBMIT_AFTER
    lo, hi = ASSUMED_WINDOW
    return SUBMIT_DURING if lo <= sub_hm <= hi else SUBMIT_AFTER


def pick_series(contest_name: str) -> tuple[str, str]:
    for pattern, sid, label in SERIES_RULES:
        if pattern.search(contest_name or ''):
            return sid, label
    return SERIES_FALLBACK


def pick_year(contest_name: str, start_time: str) -> str:
    """先看比赛名（官方口径），再看开始时间（格式五花八门）"""
    for text in (contest_name or '', start_time or ''):
        m = YEAR_RE.search(text)
        if m:
            return m.group(1)
    return ''



# ================================================================
# 榜单统计（nk_rank_stats.py 的产出）
# ================================================================

def load_rank_stats(path: str) -> dict:
    """
    读 `nk_rank_stats.py` 的产出。

    @returns {'table': {(cid, letter): {ratio, solvedTeams, effectiveTeams}},
              'contests': {cid: effectiveTeams},
              'skipped': [(cid, 原因)]}
    """
    with open(path, 'r', encoding='utf-8-sig') as f:
        data = json.load(f)

    cid = _s(data.get('contestId'))
    effective = int(data.get('effectiveTeams') or 0)
    complete = bool(data.get('complete'))
    table: dict[tuple[str, str], dict] = {}
    skipped: list[tuple[str, str]] = []

    if not complete:
        # 榜单不完整 → 分母偏小 → ratio 会整体偏大。
        # 宁可没有 ratio，也不要一个静默偏大的数。
        skipped.append((cid, f'榜单只有 {data.get("pagesCollected")}/'
                             f'{data.get("pagesExpected") or "?"} 页，有效队伍数不可信'))
        return {'table': {}, 'contests': {}, 'skipped': skipped, 'complete': False}

    for p in data.get('problems', []):
        letter = _s(p.get('letter')).upper()
        if not letter:
            continue
        solved = p.get('solvedTeams')
        ratio = ''
        if isinstance(solved, int) and effective > 0:
            ratio = f'{solved / effective * 100:.2f}'
        table[(cid, letter)] = {
            'ratio': ratio,
            'solvedTeams': solved,
            'effectiveTeams': effective,
        }
    return {'table': table, 'contests': ({cid: effective} if cid else {}),
            'skipped': skipped, 'complete': True}


def load_rank_stats_many(paths: list[str]) -> dict:
    """多个比赛各一份统计 → 合成一张大表（按 (cid, letter) 查，不会串场）"""
    merged: dict[tuple[str, str], dict] = {}
    contests: dict[str, int] = {}
    skipped: list[tuple[str, str]] = []
    any_complete = False
    for path in paths or []:
        one = load_rank_stats(path)
        merged.update(one['table'])
        contests.update(one['contests'])
        skipped += one['skipped']
        any_complete = any_complete or one['complete']
    return {'table': merged, 'contests': contests, 'skipped': skipped,
            'complete': any_complete}


# ================================================================
# 组装
# ================================================================

def build(contest_metas: list, problems: list, submits: list, *,
          source_id: str = 'nk-scraper',
          rank_stats: dict | None = None,
          handle: str = '') -> tuple[Crate, list[str]]:
    """
    组装 crate。

    `contest_metas` 可以是空列表（那样只从链接里反查 cid，C 节点名会退化成
    "比赛 <cid>"）。`rank_stats` 是 `load_rank_stats_many` 的结果。

    `handle` 是**你在牛客上的用户名**（`me.json` 的 `nk.handle`）——
    只有"用户名 == 它"的提交才会带账户线索（见 `submit_clue`）。
    """
    c = Crate(source_id=source_id, label=LABEL, platform=PLATFORM)
    warnings: list[str] = []
    if rank_stats:
        for cid, why in rank_stats.get('skipped') or []:
            warnings.append(f'榜单统计 cid={cid} 被忽略：{why}')

    stat_table = (rank_stats or {}).get('table') or {}
    stat_contests = set((rank_stats or {}).get('contests') or {})

    # ---- 比赛表：cid → {name, begin} ----
    contest_info: dict[str, dict] = {}
    for m in contest_metas or []:
        cid = _s(m.get('contestId') or m.get('contest_id'))
        if not cid:
            warnings.append(f'有一条比赛信息没有 contestId，已跳过：{m.get("contestName")!r}')
            continue
        contest_info[cid] = {
            'name': _s(m.get('contestName') or m.get('contest_name')),
            'begin': _s(m.get('beginTime') or m.get('start_time')),
            'url': _s(m.get('contestUrl') or m.get('url')),
            # 比赛起止（epoch 毫秒，采集时从比赛页存下来的）→ 判"赛时"用
            'startMs': m.get('startTime'),
            'endMs': m.get('endTime'),
        }

    # ---- 从题目/提交的链接里补齐 cid；顺带收集题号 ----
    for item in list(problems or []) + list(submits or []):
        link = _s(item.get('题目链接'))
        cid, _letter = parse_link(link)
        if cid and cid not in contest_info:
            contest_info[cid] = {'name': '', 'begin': ''}

    # 榜单统计里带了开始时间（C 节点的 contestTime 就靠它）——
    # 由 CLI 补进 contest_metas，这里不用再做什么。

    if not contest_info:
        warnings.append(
            '既没有比赛信息，也没能从链接里反查出 cid —— 无法确定比赛归属，'
            '产出将为空。请至少给 nk_cid<CID>_problems.json（且带题目链接）。')

    # ---- 建骨架：平台 → 系列 → 年份 → 比赛 ----
    # 平台节点的链接走 **`链接分类`**，不往 `link` 裸字段里写 ——
    # 裸字段在来源面板里**没有出处**，而 `browse` 类别
    # 既带出处、也进树上"按类别分组"的链接块（qoj / cf 的容器节点就是这么写的）。
    c.platform(platform_key(), name=PLATFORM_NAME,
               **link_kinds(('browse', PLATFORM_URL)))

    series_added: set[str] = set()
    year_added: set[str] = set()
    contest_added: set[str] = set()

    def ensure_series(sid: str, label: str) -> str:
        if sid not in series_added:
            c.series(platform_key(), series_key(sid), name=label)
            series_added.add(sid)
        return series_key(sid)

    def ensure_year(sid: str, year: str) -> str:
        yk = year_key(sid, year)
        if yk not in year_added:
            c.series(series_key(sid), yk, name=year)
            year_added.add(yk)
        return yk

    def ensure_contest(cid: str) -> str:
        ck = contest_key(cid)
        if ck in contest_added:
            return ck
        info = contest_info.get(cid, {})
        name = info.get('name') or f'比赛 {cid}'
        begin = info.get('begin') or ''
        if not info.get('name'):
            # 没有比赛名 → 系列只能落到 SERIES_FALLBACK，C 节点名也不好看。
            # 更要命的是：**它和"带名字那次导入"会产生两棵不同的树**，
            # 所以这里必须吵一声，不能静默降级。
            warnings.append(
                f'cid={cid} 没有比赛名 —— C 节点只能叫"{name}"，系列也只能落到 '
                f'"{SERIES_FALLBACK[1]}"。请把 nk_cid<CID>_contest.json（题目爬虫会顺带生成）'
                '一起传进来，否则以后补上名字时会多出一个系列节点')
        sid, label = pick_series(name)
        parent = ensure_series(sid, label)
        year = ''
        if GROUP_BY_YEAR:
            year = pick_year(name, begin)
            if year:
                parent = ensure_year(sid, year)
            else:
                warnings.append(
                    f'cid={cid}（{name}）认不出年份，直接挂在系列 {label} 下。'
                    '想让它也有年份层，就在比赛名或开始时间里带上 20xx')
        # 链接按**类别**写进元列 `链接分类`，不直接写 `link`
        #（与 xcpc 同一套：「数据爬取部分不应该有『存在多值时排除
        # 一些值』的逻辑」）。类别由本适配器**声明**：
        #   * 比赛页（题目列表）→ `problems`；应用层会把它派生进 `link`（同值）
        #   * 排行榜页 → `board`，**只在真有榜单统计（rank_stats）时才写**
        #     （没抓过榜单却给一个空排行榜页 = 假信息，宁可不写）
        pairs = [('problems', info.get('url') or CONTEST_URL.format(cid=cid))]
        if cid in stat_contests:
            pairs.append(('board', RANK_URL.format(cid=cid)))
        extra = link_kinds(*pairs)
        # 性质：**这棵树上的比赛都是牛客办的**
        # （暑期多校 / 练习赛·周赛·小白月赛，见 SERIES_RULES）⇒ 大类恒为 `nk`。
        # 小类：**只有暑期多校那条系列才是 `多校`**，其余系列（练习赛/周赛/小白月赛）
        # 写 `无` —— "多校"是**赛制**，不能给所有牛客比赛都盖上
        # （判据就是 `pick_series` 认出来的 sid，不另猜名字）。
        # ⚠️ 省赛/邀请赛那些**不在这条流水线里** —— 它们由 `05 xcpc` 建（大类 `xcpc`，
        #    哪怕榜单是从牛客抓的）；这里写 `nk` 的只是"牛客自己办的赛"。
        # 地区写 `无`：牛客的比赛都是线上赛、没有场地地区。
        # 年份就是上面年份层认出来的同一个值（同一份 `pick_year`）；
        # **赛季同值**——多校是"一年一届"的暑期系列，赛季与举办年份是同一件事。
        sub = SUB_BY_SERIES.get(sid, SUB_DEFAULT)
        c.contest(parent, ck, name=name,
                  contestTime=normalize_time(begin) if begin else '',
                  **nature_fields(('natureClass', sub),
                                  ('natureYear', year), ('natureSeason', year),
                                  ('natureRegion', '无')),
                  # 分类依据（元列 `分类依据`）：**牛客自己的系列表**（`pick_series` 认出的 sid）
                  # —— A 权威：不是看赛名猜的，是系列 id。
                  **class_rules(('natureClass', 'nk:series'),
                                # 年份/赛季/地区的**依据**（与 xcpc/qoj/gym 同一套写法）：
                                # 年 = `pick_year` 先看赛名（C）再看开赛时间（A）；赛季同值（结构性
                                # 口径"多校一年一届"⇒ B）；地区 `无`（线上赛，B）。
                                ('natureYear', 'nk:year-name' if (year and year in (name or ''))
                                 else ('nk:year-time' if year else '')),
                                ('natureSeason', 'nk:season-same' if year else ''),
                                ('natureRegion', 'nk:region-none')),
                  **extra)
        contest_added.add(ck)
        return ck

    for cid in sorted(contest_info):
        ensure_contest(cid)

    # ---- 题目 ----
    problems_added = 0
    page_solved: dict[tuple[str, str], bool] = {}

    for i, p in enumerate(problems or []):
        cid, letter = parse_link(p.get('题目链接'))
        letter = letter or _s(p.get('题号')).upper()
        if not cid or not letter:
            warnings.append(f'第 {i} 道题缺 cid 或题号，已跳过：{p.get("标题")!r}')
            continue
        if cid not in contest_info:
            warnings.append(f'第 {i} 道题的 cid={cid} 不在比赛列表里（会在树上新建一个比赛节点）')

        ck = ensure_contest(cid)
        fields = {
            'name': _s(p.get('标题')),
            'problemId': letter,
            'link': _s(p.get('题目链接')),
        }

        # ---- ratio 来源：只认榜单口径 ----
        st = stat_table.get((cid, letter))
        if st and st.get('ratio'):
            fields['ratio'] = st['ratio']
        elif EXPORT_PAGE_RATIO:
            rate = _s(p.get('通过率'))          # 形如 "36/54"
            if '/' in rate:
                a, b = rate.split('/', 1)
                try:
                    if float(b) > 0:
                        fields['ratio'] = f'{float(a) / float(b) * 100:.2f}'
                except ValueError:
                    pass

        c.problem(ck, problem_key(cid, letter), **fields)
        problems_added += 1
        page_solved[(cid, letter)] = (_s(p.get('团队状态')) == '通过')

    # ---- 提交 ----
    submissions_added = 0
    ac_by_pid: dict[tuple[str, str], bool] = {}

    for i, s in enumerate(submits or []):
        cid, letter = parse_link(s.get('题目链接'))
        letter = letter or _s(s.get('题号')).upper()
        rid = _s(s.get('运行ID'))
        if not rid or not cid or not letter:
            warnings.append(f'第 {i} 条提交缺 运行ID/cid/题号，已跳过')
            continue

        ck = ensure_contest(cid)
        pk = problem_key(cid, letter)

        # 只导了提交、没导题目 → 补一个占位题目（否则父节点不存在，该条会被拒）
        if pk not in c._emitted:
            c.problem(ck, pk, name=letter, problem_id=letter,
                      link=_s(s.get('题目链接')))

        status = _s(s.get('运行结果2'))
        if status in STATUS_ALIAS:
            status = STATUS_ALIAS[status]
        status = normalize_status(status or s.get('运行结果'))

        # 账户线索：**只给"用户名 == 声明的 handle"的这条**（别人提交不打）；
        # 没声明 handle 就一条都不打（宁可不给，也不给个假的）
        info = contest_info.get(cid, {})
        clue = submit_clue(_s(s.get('用户名')), handle,
                           pick_year(_s(info.get('name')), _s(info.get('begin'))), cid)

        # extKey 重复守卫（与 hdu 同一套）：
        # `nk:sub:<rid>` **不含 cid** —— 牛客的运行 ID 换场会重号（hdu 实测 10 场里 5 个
        # rid 跨场重复）。爬虫按 rid 去重过，但"同一文件混了两次"或"混进别场记录"时，
        # 走到这里就会让 `crate.py` 抛 "extKey 重复" 崩溃 —— 那样只知道一个 key、
        # 不知道来源。宁可**跳过该条并明确告警**。
        sk = submission_key(cid, rid)
        if sk in c._emitted:
            warnings.append(
                f'{cid} 的提交 运行ID={rid} 在本包内重复出现，已跳过该条。'
                '多半是同一场抓了两次、或把别场的记录混进了同一个文件')
            continue

        c.submission(
            pk,
            sk,
            status=status,
            time=normalize_time(_s(s.get('提交时间'))),
            link=_s(s.get('提交链接')),
            # 提交性质（赛时 / 补题）—— 判不准留空
            submitKind=(submit_kind(s.get('提交时间'), info.get('startMs'), info.get('endMs')) or None),
            **run_fields(s),
            **({'账户线索': clue} if clue else {}),
        )
        submissions_added += 1
        if status == 'AC':
            ac_by_pid[(cid, letter)] = True

    # ---- 交叉校验：题目页说"通过"，提交里却没有 AC ----
    for (cid, letter), solved in page_solved.items():
        if submits and solved and not ac_by_pid.get((cid, letter)):
            warnings.append(
                f'{cid}/{letter}：题目列表标了"通过"，但本次提交记录里没有 AC。'
                '（只导了部分提交时这是正常的；应用以 R 记录为准）')

    # ---- 榜单统计的交叉校验 ----
    if rank_stats and rank_stats.get('table'):
        missing = stat_contests - set(contest_info) if stat_contests else set()
        if missing:
            warnings.append(
                f'榜单的 cid={", ".join(sorted(missing))} 不在本次比赛的集合里 '
                f'（本次有：{", ".join(sorted(contest_info))}）。'
                'ratio 仍按 cid 匹配 —— 对不上就说明混用了不同比赛的数据')
        matched = sum(1 for (cc, ll) in stat_table if cc in contest_info)
        if matched == 0:
            warnings.append('榜单统计与本包题目一条都没匹配上（cid 或题号对不上）')

    # ---- 统计 ----
    if not problems_added and not submissions_added:
        warnings.append('没有产出任何题目或提交记录 — 请检查输入文件是否配对（同一场比赛？）')

    return c, warnings


# ================================================================
# CLI
# ================================================================

def load(path: str):
    with open(path, 'r', encoding='utf-8-sig', errors='replace') as f:
        return json.load(f)


def _cli(argv: list[str]) -> int:
    import argparse

    ap = argparse.ArgumentParser(description='把 Nowcoder_*.json 转成 Acm_Tree 导入包')
    ap.add_argument('inputs', nargs='+',
                    help='若干文件：nk_cid<CID>_contest.json / nk_cid<CID>_problems.json / '
                         'nk_cid<CID>_submits.json（类型按内容自动识别）')
    ap.add_argument('-o', '--out', required=True, help='输出 crate 路径')
    ap.add_argument('--source-id', default='nk-scraper')
    ap.add_argument('--rank-stats', nargs='+', default=[],
                    help='nk_rank_stats.py 的产出 JSON（可给多个，一场一份）—— '
                         'ratio 的唯一来源')
    ap.add_argument('--handle', default='',
                    help='你在牛客上的用户名（不给就读 me.json 的 nk.handle）—— '
                         '只有"用户名 == 它"的提交会带账户线索 `nk:<赛季> : 用户名 = <你>`')
    args = ap.parse_args(argv)

    loaded = [(p, load(p)) for p in args.inputs]

    contest_metas: list = []
    problems: list = []
    submits: list = []

    # 按内容特征识别（名字各人习惯不同）；用 extend 而不是赋值，
    # 这样流水线能把**多场**的题目/提交一起塞进来
    for path, data in loaded:
        if isinstance(data, list):
            sample = data[0] if data else {}
            if not isinstance(sample, dict):
                continue
            if '运行ID' in sample:
                submits += data
            elif '标题' in sample or '题号' in sample:
                problems += data
            else:
                print(f'⚠️  无法识别 {path} 的类型，已忽略（表头字段：'
                      f'{list(sample.keys())[:5]}）', file=sys.stderr)
        elif isinstance(data, dict):
            if 'contestId' in data or 'contestName' in data:
                contest_metas.append(data)
            elif 'basicInfo' in data or 'code' in data:
                print(f'⚠️  {path} 看起来是**榜单原始响应**，不是统计文件。'
                      '请先跑 nk_rank_stats.py 生成统计，再用 --rank-stats 传进来。',
                      file=sys.stderr)
            else:
                print(f'⚠️  无法识别 {path} 的类型，已忽略', file=sys.stderr)

    if not problems and not submits:
        print('❌ 没识别出题目或提交文件 —— 请检查输入', file=sys.stderr)
        return 2

    # ---- 比赛时间：榜单统计里有 beginTime，**补进**已有比赛信息 ----
    # 注意是"补"不是"新增"：nk_cid<CID>_contest.json 已经带了 contestId，
    # 写成 `if cid not in have` 会把它跳过 → C 节点的 contestTime 会是空的。
    rank_stats = load_rank_stats_many(args.rank_stats) if args.rank_stats else None
    meta_by_cid = {_s(m.get('contestId')): m for m in contest_metas}
    for path in args.rank_stats:
        try:
            st = load(path)
        except Exception:
            continue
        cid = _s(st.get('contestId'))
        begin = _s(st.get('beginTime'))
        if not cid:
            continue
        if cid in meta_by_cid:
            if begin and not _s(meta_by_cid[cid].get('beginTime')):
                meta_by_cid[cid]['beginTime'] = begin
        else:
            contest_metas.append({'contestId': cid, 'contestName': '', 'beginTime': begin})

    # 要认领的账号：命令行（可逗号分隔）优先，否则读 me.json（含花名册）
    wanted = [x.strip() for x in _s(args.handle).split(',') if x.strip()] or handle_from_me()
    crate, warnings = build(contest_metas, problems, submits,
                            source_id=args.source_id, rank_stats=rank_stats,
                            handle=wanted)
    data = crate.to_dict()
    issues = validate_crate(data)

    crate.save(args.out)
    print(f'✅ 已写出 {args.out}')
    print(f'   {crate.summary()}')
    if rank_stats and rank_stats.get('table'):
        ct = rank_stats.get('contests') or {}
        detail = '、'.join(f'cid={k} 有效队伍 {v}' for k, v in sorted(ct.items()))
        print(f'   赛时通过率：{len(rank_stats["table"])} 条'
              '（口径 = 通过队伍数 / 有效队伍数）' + (f'；{detail}' if detail else ''))
    if wanted:
        print(f'   账户线索：nk:<赛季(四位年，如 nk:2026)> : 用户名 = {"、".join(wanted)}'
              '（只给用户名在册的提交；应用里要各配一条一样的映射）')
    else:
        print('   ℹ️ 没有账户线索（me.json 里没写 nk.handle，也没有花名册 `team[].nk`）—— '
              '提交会按"客观值"导入，「账户对比」里看不到你')

    if warnings:
        print(f'\n⚠️  {len(warnings)} 条转换期提示：')
        for w in warnings[:25]:
            print('   •', w)
        if len(warnings) > 25:
            print(f'   … 另有 {len(warnings) - 25} 条同类提示')

    if issues:
        print(f'\n❌ 校验发现 {len(issues)} 个问题（导入时可能被拒）：')
        for it in issues:
            print('   •', it)
        return 1

    print('\n下一步：')
    print(f'   npm run crate:check -- {args.out}')
    print('   然后把该文件拖进应用的「📥 节点自动导入」')
    return 0


if __name__ == '__main__':
    sys.exit(_cli(sys.argv[1:]))
