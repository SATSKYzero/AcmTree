#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
HDU 适配器 —— 把 Hdu_*.json 转成 Acm_Tree 导入包

输入（都由同目录下的爬虫脚本产出）
----------------------------------
  Hdu_contests.json   比赛列表（可选，但强烈建议给）
  Hdu_problems.json   某场比赛的题目列表
  Hdu_submits.json    某场比赛的提交记录（可选）

输出：一份 crate（导入包），可直接拖进应用的「📥 节点自动导入」。

用法
----
⚠️ 在**项目根目录用 PowerShell** 跑。PowerShell 不用 `\` 续行（那是 bash 语法），
   所以命令写成一行 —— 直接复制下面这行即可。

    # 最省事：跑流水线，它自己找输入、自己按顺序调三个脚本
    python "acm-data/raw/Scaper/02 hdu/hdu_pipeline.py" --all

    # 完整：比赛列表 + 题目 + 提交（--only-used-contests 只建真的有数据的比赛）
    python "acm-data/raw/Scaper/02 hdu/hdu_adapter.py" "acm-data/raw/Scaper/02 hdu/Hdu_contests.json" "acm-data/raw/Scaper/02 hdu/26hdu3/Hdu_problems.json" "acm-data/raw/Scaper/02 hdu/26hdu3/Hdu_submits.json" -o acm-data/nodes/hdu-multi-university.json --only-used-contests

    # 加了 --rank-stats 就用**赛时通过率**（通过队伍数 / 有效队伍数）填 ratio
    python "acm-data/raw/Scaper/02 hdu/hdu_adapter.py" "acm-data/raw/Scaper/02 hdu/Hdu_contests.json" "acm-data/raw/Scaper/02 hdu/26hdu3/Hdu_problems.json" -o acm-data/nodes/hdu-multi-university.json --rank-stats acm-data/nodes/hdu_rank_stats_1231.json

    # 只要题目（不给提交也可以）
    python "acm-data/raw/Scaper/02 hdu/hdu_adapter.py" "acm-data/raw/Scaper/02 hdu/26hdu3/Hdu_problems.json" -o acm-data/nodes/hdu-multi-university.json

    # 转换后离线自查（推荐）
    npm run crate:check -- acm-data/nodes/hdu-multi-university.json

设计的几个关键决定
------------------
1. **比赛归属从哪来**：HDU 的题目/提交链接里带 `cid=1231`，能反查出比赛；
   若给了 contests 列表，就用它拿到比赛名与开始时间。
2. **extKey 用平台稳定 ID + 字母题号**：
       平台      hdu
       比赛系列  hdu:series:<sid>        ← 杭电多校/校赛… 由 SERIES_RULES 归类
       年份      hdu:series:<sid>:<year> ← 系列下的年份层（GROUP_BY_YEAR）
       比赛      hdu:c:<cid>            ← cid 是 HDU 的稳定比赛 ID
       题目      hdu:c:<cid>:p:<A>      ← 字母题号（比赛内位置；同一场稳定）
       提交      hdu:sub:<rid>          ← 运行ID 稳定
   树的形状（年份层让系列不会越铺越长）：
       O → W 杭电 → S 杭电多校 → S 2026 → C 联赛(1)/(2)/(3) → P → R
   题目为什么用字母：题目链接里那个数字（1001）只保证"同场连续"，
   而人在树上认的是"这场 A 题"；且 site 的 problem_id 与比赛解绑，
   换个比赛同一道题数字会变。数字→字母的映射用 letter_of() 兜底，
   超出 1001..1020 只警告、不瞎算字符。
3. **通过率用原始计数**（accepted/submitted）而不是那个
   `"6.56% (34/518)"` 字符串——由应用自己算百分比，避免解析歧义。
   （HDU 题目页自带的 ratio 是**全站**数据，不是赛时的，见 _usage.md。）
4. **`solved` / `运行结果` 不写进节点字段**：题目的通过状态由应用从
   R（提交记录）自动推导（见 docs/auto-import.md 7.6）。
   这里仅把它们用于**交叉校验**，不一致时给提示。
"""

from __future__ import annotations

import json
import os
import re
import sys

# 不要生成 __pycache__（本脚本会 import 同目录模块）—— 纯垃圾，每次跑都长出来
sys.dont_write_bytecode = True

# ---- 找到 crate.py（构造器） ----
# 两种情形都要能用：
#   1. 在本仓库里：本脚本在 acm-data/raw/Scaper/02 hdu/，构造器在 <repo>/scripts/
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

# ---- 接上公共工具（lib/hdu_common.py）----
# 字母表、cid 提取、读 JSON 都在那里，**只有一份**
_HERE_LIB = os.path.join(_HERE, 'lib') if os.path.basename(_HERE) != 'lib' else _HERE
sys.path.insert(0, _HERE_LIB)
from hdu_common import (  # noqa: E402
    LETTER_BASE, LETTER_MAX, letter_of, CID_RE, read_json, multi_re, identify,
)

# ================================================================
# ★★★ 配置区：要改就改这里 ★★★
# ================================================================

# ---- 1. 平台标识 ----
PLATFORM = 'hdu'                      # extKey 里的平台段
PLATFORM_NAME = '杭电'                 # 树上的平台节点显示名
LABEL = 'HDU 爬虫'                    # 导入记录里的来源名

# ---- 2. extKey 模板（应用**不解析** key，这里纯粹是你自己的约定）----
#
# 可用占位符：
#   {platform}   平台段（上面的 PLATFORM）
#   {cid}        比赛 ID（Hdu_contests.json 的 contest_id / 链接里的 cid）
#   {pid}        题目的**字母**（problem_id2，A/B/C…）
#   {pid_num}    题目的**平台数字 ID**（problem_id，1001/1002…）
#   {rid}        提交的运行 ID
#
# 想给所有 key 加统一前缀，直接在模板前加字面量即可，例如：
#     KEY_PLATFORM = 'myhdu'
#     KEY_CONTEST  = 'myhdu/c/{cid}'
KEY_PLATFORM = '{platform}'
KEY_SERIES   = '{platform}:series:{sid}'
KEY_YEAR     = '{platform}:series:{sid}:{year}'
KEY_CONTEST  = '{platform}:c:{cid}'
KEY_PROBLEM   = '{platform}:c:{cid}:p:{pid}'
# ⚠️ 提交的 key 必须**带上比赛 ID**：HDU 的「运行ID」是**每场重新编号**的
#    （实测：1238 场是 158~9041，1231 场是 76~7753，10 场里有 5 个 rid 跨场重复）。
#    写成 `hdu:sub:{rid}` 是错的 —— 两个比赛的同号提交会撞成同一个 extKey，
#    而 crate 要求包内 extKey 唯一，直接抛错。
KEY_SUBMISSION = '{platform}:c:{cid}:sub:{rid}'

# ---- 3. 系列分组规则（比赛名 → 挂在哪个 S 下）----
#
#   (正则, 系列标识, 系列显示名)
#
# 按顺序匹配，命中即停；都不命中 → SERIES_FALLBACK。
# **比赛必须挂在 S 下**（应用不允许 W 下直接放 C）。
#
# ⚠️ **"多校"那一条的词表不是这里的字面量**：它是 `lib/hdu_common.py` 的 `MULTI_WORDS`
#    （抓取侧 `hdu_multi_fetch.py` 判断默认抓哪几场，用的也是那一份）。
#    2026-10-17 实测踩到：这里原先自己写了一遍 `钉耙编程|暑期联赛|多校` ⇒ 2021
#    「MINIEYE杯…超级联赛」判不中 ⇒ 那十场被归进「其他比赛」（用户看出来了）；
#    2022「杭电杯…超级联赛」更糟：先撞下面那条"杭电" ⇒ 跑进「杭电校赛」。
#    ⇒ **别再手写这些词**，要加就加 `MULTI_WORDS`。
SERIES_RULES = [
    (multi_re(), 'summer', '杭电多校'),
    (re.compile(r'杭电|HDU|大学生程序设计'), 'hdu', '杭电校赛/公开赛'),
]
SERIES_FALLBACK = ('other', '其他比赛')

# 系列 → nature 小类。**只有多校那条是 `多校`**：
# 校赛/公开赛不是"多校"（多校 = 多所高校各出题、联合办一场联赛）⇒ 那些写 **`无`**
# （"这个维度上不适用"；与"留空 = 还没判"是两件事：写 `无` 就不在③ 性质待补里了）。
SUB_BY_SERIES = {'summer': 'hdu/多校'}
SUB_DEFAULT = 'hdu/无归类'

# ---- 3b. 年份层级（系列 → 年份 → 比赛）----
#
# 为什么加这一层：一个系列年年都有比赛，直接铺满一层 C 会越来越长。
# 插一层年份 S 后，树是
#     W 杭电 → S 杭电多校 → S 2026 → C 联赛(1)/(2)/(3)
# 应用允许 S 套 S（见 docs/auto-import.md 2.5），所以这是合法结构。
#
# 年份怎么认：先看比赛名里的 20xx，再看开始时间；都认不出就直接挂到系列下
# （S 下放 C 也是合法的，只是那一场少了年份分组，会打印一条提示）。
GROUP_BY_YEAR = True
YEAR_RE = re.compile(r'(20\d{2})')

# ---- 4. 字段开关 ----
#
# ⚠️ 榜单数据（推荐）
#    赛时通过率 = **通过队伍数 / 有效队伍数**
#    来源：hdu_rank_stats.py 的产出（acm-data/nodes/hdu_rank_stats_<cid>.json）
#    没有榜单时留空，不要用下面那个历史口径。
#
# ⚠️ ratio / accepted / submitted 默认**不导出**：
#    Hdu_problems.json 里那三个数算的是**历史提交**（全站累计），
#    不是赛时数据，与"这场比赛打得怎么样"无关。
EXPORT_RATIO = False

# 榜单口径：通过队伍数 / 有效队伍数

# ---- 5. 题号字母表 ----
# 边界检查与映射都在 lib/hdu_common.py（LETTER_BASE / LETTER_MAX / letter_of），
# **全项目只有那一份** —— 若在这里和三个爬虫各抄一份，
# 改一处漏一处就会变成"爬虫算出了字母、适配器却说算不出"。
LETTER_BASE_PID = LETTER_BASE          # 别名，便于本文件里读得顺

# cid 从链接里取：/contest/problems?cid=1231（`cid_of_links` / CID_RE 在 lib/hdu_common.py）

# ---- 6. 节点上挂的链接 ----
#
# 应用里 C 节点与 W 节点都会渲染 `link`（view/builders.js 的 buildCNodeMeta /
# buildWSNodeMeta → "🔗 链接"），所以这两级值得带上链接：点一下就跳到比赛/比赛列表。
#
# 比赛页用"题目列表"而不是"榜单"：C 节点底下就是题目，跳题目列表最顺手
# （这个 URL 形态取自 Hdu_contest_list_source.html 里的 href，不是凭印象编的）。
CONTEST_URL = 'https://acm.hdu.edu.cn/contest/problems?cid={cid}'
PLATFORM_URL = 'https://acm.hdu.edu.cn/contests/contest_list.php'
# 榜单（排行）页：C 节点的 `boardLink` 用它（只在有 rank_stats 的场次才写）
RANK_URL = 'https://acm.hdu.edu.cn/contest/rank?cid={cid}'

# HDU 的"排队/编译中"在应用里没有对应态 → 归到 PD（待判）
STATUS_ALIAS = {'RUN': 'PD', 'QUE': 'PD', 'CMP': 'PD'}

# ---- 7. 提交的运行信息（「先提取备用」，口径 = 毫秒 / 字节）----
#
# Hdu_submits.json 里本来就有这三样：
#     `使用语言`        → language   （G++ / C++ / Java…，原样搬）
#     `运行时间(ms)`    → timeUsed   （**毫秒**，与 CF/QOJ 的口径一致）
#     `使用内存(KB)`    → memoryUsed （HDU 给的是 **KB**，×1024 转成字节）
# 拿不到就写 `None`（别写 ""，空串会占位、把"后到者补空"的机会吃掉）。
#
# 代码长度（`codeLength`）**没有**：HDU 的 Status 表格里没有这一列
#   （**已核实**：10 场源文件的列名都只有 运行ID/提交链接/题号/…/运行时间(ms)/使用内存(KB)/使用语言/提交时间）。
#   "只有点进提交详情页才有"这句是**推测、未验证**（仓库里没有详情页样例）——
#   要取就得逐条请求，按现在"先提取备用"的阶段不值得。宁可不给。

# ---- 8. 账户线索（这条提交是谁的）----
#
# 与 XCPC 那套同一个机制：`{source, field, value}` 三元组，适配器只**如实搬运**，
# 应用拿它去查账户注册表里的映射（`hdu : handle = someone`）。
#
# ⚠️ 为什么 source 要带赛季（`hdu:26`）：应用是按三元组**全等**匹配的，
#    两条映射声明同一个三元组会被判成冲突、谁都不认领。HDU 的 handle 是不变的，
#    但"这个人的哪一届数据"是不同账户（队友会换），所以要把赛季放进 source。
#
# ⚠️ 赛季写法 = **四位年份**（`hdu:2026`）—— 数据端统一成四位
#    （`crate.py` 的 `season_of()`）。写成两位（`26`）会让映射永远认不上。
#
# ⚠️ HDU 的 Status 表格里**没有"提交者"列**（抓取脚本是把你浏览器里筛好的
#    那一页搬回来），所以线索只能来自**你自己声明的 handle**（me.json 的 `hdu.handle`）。
#    不声明就不写线索 —— 导入后全是客观值，账户对比里看不到你。
CLUE_FIELD = 'handle'

# ---- 8b. 每场是**用哪个账号**抓的（**从 `me.json` 推，仓库里不留任何痕迹**）----
#
# 2026-10-17 用户看着导入预览说："不可能全是 teamA，而且不可能全是 TEAM0"。
# 病根：归档里 2021/2023/2024/2025 的场次是**用各年那套比赛口令**抓的
# （`hdu.contestUser` 那一年是 teamB / teamC / teamD / teamE），
# 而 `--handle` 只有一个值 ⇒ 50 场的提交**全被标成同一个账号**（还带上了 TEAM0 前缀）。
#
# ★ 2026-10-19 用户定："**所有个人信息理应由 me.json 提供，且不留痕迹**"。
#   所以这里**不再读** `hdu_contest_accounts.json`（那份 `{cid: 账号}` 的小表是仓库里的
#   个人信息痕迹，会随仓库一起发出去）。事实本来就在 `me.json`：HDU 是**按年一套账号**
#   （`hdu.years.<年份>.contestUser`，抓取侧用的就是它）⇒ 出包时**按 cid 查出年份**再取那一格，
#   与抓取侧写下的那张小表**逐条相同**（真包 50 场对拍过）。
#   优先顺序不变：`--file-handle`（人显式绑定）> 按 cid 的年份事实 > `--handle`（兜底）。
#   ⚠️ 那年**没声明**就退回顶层 `hdu.contestUser`（它的既有含义 = "只关心一年的兜底"）；
#     两者都没有 ⇒ 这条线索不写（宁可不给，也不给错的）。


def contest_accounts(contest_info: dict) -> dict[str, str]:
    """
    `{cid: 账号}` —— **按 cid 查年份、再从 `me.json` 取那一年的账号**（仓库里不落任何文件）。

    @param contest_info `build()` 里的 `{cid: {name, start, end}}`（年份靠 `pick_year` 认）
    """
    mod = _me()
    want = mod.hdu_year_accounts()
    out: dict[str, str] = {}
    fell_back: list[str] = []
    for cid, info in (contest_info or {}).items():
        year = pick_year((info or {}).get('name', ''), (info or {}).get('start', ''))
        acct = want.get(year, '') if year else ''
        if not acct:
            acct = mod.get('hdu.contestUser')      # 兜底：只声明了一个账号的老写法
            if acct and year and want:
                fell_back.append(year)
        if acct:
            out[str(cid)] = mod.declared_handle('hdu', acct)
    if fell_back:
        years = '、'.join(sorted(set(fell_back)))
        print(f'   ℹ️ 年份 {years} 没在 `me.json` 的 `hdu.years` 里声明 ⇒ 账户线索按顶层 '
              f'`hdu.contestUser` 兜底（想按年区分就在那里补一格 `contestUser`）', file=sys.stderr)
    return out


# 多校/联赛的**常见比赛时段**（"HDU / 牛客多校几乎总是 12~17"）。
# 实测印证：导入的 10 场 HDU（cid 1229~1238）**全部 12:00 开赛**，
# 而 HDU 比赛页写着 `Contest Time … 12:00:00 ~ … 17:00:00`（5 小时）。
ASSUMED_WINDOW = ('12:00', '17:00')


def submit_kind(submit_time, start_time, end_time='') -> str:
    """
    HDU 提交性质：`赛时` / `补题`；**判不准返回 ''**（不写"未知"）。

    ⚠️ **不能按"日期相同"判**（**当天补题非常常见**）——
    必须用**比赛时段**：

      ① 有精确时段（`end_time`，或源里带的 `start`/`end` 时间）→ 落在窗口内 = `赛时`
      ② 没有结束时间 → **用常见时段假设**：开赛日 **12:00~17:00**（见 `ASSUMED_WINDOW`）
         落在里面 = `赛时`，否则 = `补题`
      ③ 连开赛时间都没有 → 留空

    `start_time` 可以是完整日期时间（`2026-07-21 12:00:00`），也可以只有时刻；
    只有时刻时"日子"取自 `submit_time` —— 这时不能判（返回 ''），因为没有日期可比。
    """
    day = contest_day(start_time) or contest_day(end_time)
    sub_day = contest_day(submit_time)
    if not day or not sub_day:
        return ''
    if sub_day != day:
        return SUBMIT_AFTER                      # 不是比赛那天 → 一定是补题

    # 同一天：用时段判（当天补题很常见，所以这一步不能省）
    def hhmm(value) -> str:
        m = re.search(r'(\d{1,2}):(\d{2})', _s(value))
        return f'{int(m.group(1)):02d}:{m.group(2)}' if m else ''

    m_sub = re.search(r'(\d{1,2}):(\d{2})', _s(submit_time))
    if not m_sub:
        return ''
    sub_hm = f'{int(m_sub.group(1)):02d}:{m_sub.group(2)}'

    lo, hi = hhmm(start_time) or ASSUMED_WINDOW[0], hhmm(end_time) or ASSUMED_WINDOW[1]
    # ③ 显式给的时段不完整时，退回假设（12~17）
    if not (re.search(r'\d{1,2}:\d{2}', _s(start_time)) and re.search(r'\d{1,2}:\d{2}', _s(end_time))):
        lo, hi = ASSUMED_WINDOW
    # 跨零点（如 22:00~02:00）也支持
    in_window = (lo <= sub_hm <= hi) if lo <= hi else (sub_hm >= lo or sub_hm <= hi)
    return SUBMIT_DURING if in_window else SUBMIT_AFTER


def submit_clue(handle, year: str, cid: str, season: str = '') -> dict | None:
    """
    这条提交的账户线索；没声明 handle 就返回 None（宁可不给，也不给个假的）。

    `handle` 可以是单个字符串或列表（多账号时取第一个）。
    HDU 的数据里**没有提交者**，所以一条提交属于谁完全由调用方决定
    （单人时=那唯一的 handle；多人时=这份文件是谁抓的，见 `--handles`）。
    """
    hs = [h for h in ([handle] if isinstance(handle, str) else (handle or [])) if _s(h)]
    if not hs:
        return None
    h = _s(hs[0])
    return {'source': f'hdu:{_s(season) or season_of(year) or _s(cid)}',
            'field': CLUE_FIELD, 'value': h}


# `run_fields`（提交的运行信息 → 包字段）**只有一份**，在 `scripts/crate.py` 里 ——
# HDU 与牛客若各写一份同构实现，而"耗时=毫秒、内存=字节"这个口径
# 一旦两边不一致，界面上的数字就**没法横向比**（而且看着都正常，很难发现）。
from crate import run_fields  # noqa: E402,F401


# ================================================================
# extKey 构造（统一走模板，便于整体改前缀）
# ================================================================

def platform_key() -> str:
    return KEY_PLATFORM.format(platform=PLATFORM)


def series_key(sid: str) -> str:
    return KEY_SERIES.format(platform=PLATFORM, sid=sid)


def year_key(sid: str, year: str) -> str:
    """年份节点的 extKey —— 直接续在系列 key 后面，一眼能看出从属关系。"""
    return KEY_YEAR.format(platform=PLATFORM, sid=sid, year=year)


def pick_year(contest_name: str, start_time: str) -> str:
    """
    认出比赛属于哪一年：先看比赛名，再看开始时间。

    为什么优先比赛名：开始时间格式五花八门（`2026.07.28 12:00`、`2026-7-28`…），
    而比赛名里那个 20xx 就是官方口径。
    """
    for text in (contest_name or '', start_time or ''):
        m = YEAR_RE.search(text)
        if m:
            return m.group(1)
    return ''


def contest_key(cid: str) -> str:
    return KEY_CONTEST.format(platform=PLATFORM, cid=cid)


def problem_key(cid: str, pid: str, pid_num: str = '') -> str:
    return KEY_PROBLEM.format(platform=PLATFORM, cid=cid, pid=pid, pid_num=pid_num)


def submission_key(cid: str, rid: str) -> str:
    """
    提交的 extKey。**必须带 cid**（见 KEY_SUBMISSION 处的说明）：
    HDU 的 rid 只在比赛内唯一，跨场会撞。
    """
    return KEY_SUBMISSION.format(platform=PLATFORM, cid=cid, rid=rid)


def contest_url(cid: str) -> str:
    return CONTEST_URL.format(cid=cid)


def contest_rank_url(cid: str) -> str:
    """C 节点的**榜单链接**（`boardLink`）—— HDU 的排行页带 `cid` 参数。

    只在这场比赛**真有榜单统计**（`hdu_rank_stats_<cid>.json`）时才写它，
    否则给一个空排行榜页就是假的（见 `build()` 里的判断）。
    """
    return RANK_URL.format(cid=cid)


# ================================================================
# 读入 + 反查
# ================================================================

def load(path: str):
    """读 JSON（容忍 BOM）—— 直接转发公共实现，别在这里又抄一份"""
    return read_json(path)


def load_rank_stats(path: str) -> dict:
    """
    读 hdu_rank_stats.py 的产出，整理成 {(cid, pid): {ratio, solvedTeams, effectiveTeams}}。

    赛时通过率口径：
        ratio = 通过队伍数 / 有效队伍数 × 100
    其中"有效队伍数"= 赛时至少解出 1 题的队伍数。
    """
    data = load(path)
    cid = _s(data.get('contestId'))
    effective = data.get('effectiveTeams') or 0
    table: dict[tuple[str, str], dict] = {}

    for p in data.get('problems', []):
        pid = _s(p.get('pid'))
        if not pid:
            continue
        solved = p.get('solvedTeams')
        if isinstance(solved, int) and effective > 0:
            ratio = f'{solved / effective * 100:.2f}'
        else:
            ratio = ''
        table[(cid, pid)] = {
            'ratio': ratio,
            'solvedTeams': solved,
            'effectiveTeams': effective,
        }
    return {'contestId': cid, 'effectiveTeams': effective, 'table': table}


def load_rank_stats_many(paths: list[str]) -> dict:
    """
    读**多个** hdu_rank_stats 文件，合成一张大表。

    为什么要多个：一场比赛一份统计，但用户往往希望"一次导入包含好几场"，
    而适配器只吃一份统计。合并后按 (cid, pid) 查表，不会串场。

    @returns {'table': {(cid,pid): {...}}, 'contests': {cid: effectiveTeams}}
    """
    merged: dict[tuple[str, str], dict] = {}
    contests: dict[str, int] = {}
    for path in paths or []:
        one = load_rank_stats(path)
        merged.update(one['table'])
        if one['contestId']:
            contests[one['contestId']] = one['effectiveTeams']
    return {'table': merged, 'contests': contests}


def pick_series(contest_name: str) -> tuple[str, str]:
    for pattern, key, label in SERIES_RULES:
        if pattern.search(contest_name or ''):
            return key, label
    return SERIES_FALLBACK


def build(contests: list, problems: list, submits: list, *,
          source_id: str = 'hdu-scraper',
          only_used_contests: bool = False,
          rank_stats: dict | None = None,
          handle='',
          file_handle_specs: list[str] | None = None) -> tuple[Crate, list[str]]:
    """
    组装 crate。

    `contests` 可为空列表（那样就从题目/提交的链接里反查 cid）。

    `only_used_contests=True` 时，**只建"本包真的有题目或提交"的比赛**。
    默认 False（把比赛列表全建出来）—— 因为"先把骨架铺好、以后陆续补题目"
    也是合理用法，且比赛节点本身信息量不大。

    `rank_stats` 是 hdu_rank_stats.py 的产出（经 load_rank_stats 整理）。
    给了它就用**赛时通过率**（通过队伍数 / 有效队伍数）填 ratio。

    `handle`：**你自己在 HDU 上的用户名**，或它的列表。
    - 单个 → 每条 R 都带这一条线索（最常见：整份文件都是同一个人的提交）；
    - **多个 → 必须**用 `file_handle_specs` 显式绑定"哪份文件是谁抓的"；
      没绑定的文件**一条线索都不打**（HDU 数据里没有提交者，宁可不给也不给错的）。
    """
    c = Crate(source_id=source_id, label=LABEL, platform=PLATFORM)
    warnings: list[str] = []

    # ---- 账户线索：谁被认领 ----
    # ---- 账户线索的归属（**显式绑定**）----
    #
    # HDU 的数据里**没有任何身份信息**（拿真实存档核实过：bundle 头的 `base`
    # 无 `user=` 参数、页面没有提交者列、解析出的 JSON 也没有文件头）。
    # 所以"这条提交是谁的"只能由你声明，而**声明必须落到具体文件上**。
    #
    # 规则（刻意做得严格）：
    #   * **只有一个 handle** → 所有提交都归他（最常见；不用写绑定）。
    #   * **多个 handle** → **必须**用 `--file-handle <文件>=<账号>` 显式绑定；
    #     没绑定的文件**一条线索都不打**（宁可不给，也不给错的）。
    #     ⚠️ 这里**故意不再按"提交文件顺序"zip** —— 那个顺序 = 输入文件顺序
    #     （走流水线时是 cid 数字升序），与花名册顺序毫无关系，数量碰巧相等时
    #     会**静默错认**（把队友的提交记到你名下）—— 所以归属必须显式绑定。
    want = [h for h in ([handle] if isinstance(handle, str) else (handle or [])) if _s(h)]
    sub_files: list[str] = []
    for s in submits or []:
        f = _s(s.get('_来源文件')) or '（未知文件）'
        if f not in sub_files:
            sub_files.append(f)

    def _match_file(token: str) -> str:
        """把 `--file-handle` 左边那个 token 匹配到唯一的提交文件（完整路径→后缀→文件名）"""
        t = _s(token).replace('\\', '/')
        cands = [f for f in sub_files if f.replace('\\', '/') == t]
        if not cands:
            cands = [f for f in sub_files if f.replace('\\', '/').endswith('/' + t)]
        if not cands:
            cands = [f for f in sub_files if os.path.basename(f) == os.path.basename(t)]
        return cands[0] if len(cands) == 1 else ''

    file_handle: dict[str, str] = {}
    paired: list[tuple[str, str]] = []

    # ① 人显式绑定（`--file-handle` / me.json 的 `hdu.files`）—— 最高优先
    for spec in (file_handle_specs or []):
        left, _, right = str(spec).partition('=')
        if not (left.strip() and right.strip()):
            warnings.append(f'账户线索：`--file-handle {spec}` 格式不对（要 `文件=账号`），已忽略')
            continue
        f = _match_file(left)
        if not f:
            warnings.append(f'账户线索：`--file-handle {spec}` 匹配不到唯一的提交文件'
                            f'（候选：{"、".join(os.path.basename(x) for x in sub_files)}），已忽略')
            continue
        if f in file_handle:
            warnings.append(f'账户线索：{os.path.basename(f)} 被绑定了两次，后者 {right.strip()} 生效')
        file_handle[f] = right.strip()
        paired.append((f, right.strip()))

    # ②③ 要"按 cid 查年份"，所以得等下面的 `contest_info` 建好再算（见那里的 ②③ 两段）
    by_map: list[tuple[str, str]] = []

    if paired:
        print('   账户线索（显式绑定）：')
        for f, h in paired:
            n = sum(1 for s in (submits or []) if _s(s.get('_来源文件')) == f)
            print(f'      {os.path.basename(f)}（{n} 条）→ {h}')

    # ---- 榜单统计 ----
    stat_table: dict[tuple[str, str], dict] = {}
    stat_contests: set[str] = set()
    if rank_stats:
        stat_table = rank_stats.get('table') or {}
        stat_contests = set(rank_stats.get('contests') or {})

    # ---- 比赛表：cid → {name, start_time} ----
    contest_info: dict[str, dict] = {}
    for ct in contests or []:
        cid = _s(ct.get('contest_id'))
        if not cid:
            warnings.append(f'比赛列表里有一条没有 contest_id，已跳过：{ct.get("contest_name")!r}')
            continue
        contest_info[cid] = {
            'name': _s(ct.get('contest_name')),
            'start': _s(ct.get('start_time')),
            # 结束时间（比赛列表里没有；有就用来判"赛时"，没有就按 12~17 假设）
            'end': _s(ct.get('end_time')),
        }

    # ---- 从题目/提交里补齐 cid（链接带 cid=） ----
    def cid_from_link(link: str) -> str:
        m = CID_RE.search(_s(link))
        return m.group(1) if m else ''

    for item in list(problems or []) + list(submits or []):
        link = _s(item.get('题目链接')) or _s(item.get('link'))
        cid = cid_from_link(link)
        if cid and cid not in contest_info:
            contest_info[cid] = {'name': '', 'start': ''}

    # ② `me.json` 里的事实：这一场（按 cid 查出年份）是用哪一年的账号抓的
    #   （2026-10-19 起**不再读**仓库里的 `hdu_contest_accounts.json`，见 `contest_accounts` 的注释）
    accounts = contest_accounts(contest_info)
    for f in sub_files:
        if f in file_handle:
            continue
        cid = identify(os.path.basename(f))[1]
        acct = accounts.get(cid, '')
        if acct:
            file_handle[f] = acct
            by_map.append((f, acct))

    # ③ 兜底：只声明了一个账号时，剩下没人认领的都归它
    rest = [f for f in sub_files if f not in file_handle]
    if len(want) == 1:
        for f in rest:
            file_handle[f] = want[0]
    elif want and rest:
        warnings.append(
            f'账户线索：{len(want)} 个账号，但有 {len(rest)} 份提交文件**没绑定**——'
            f'它们一条线索都不打。没绑定的是：'
            f'{"、".join(os.path.basename(f) for f in rest)}。'
            f'绑定写法：--file-handle "文件名=账号"')
    elif not want and rest:
        warnings.append(
            '账户线索：没有 handle（me.json 的 `hdu.handle` / 花名册 `team[].hdu`）—— '
            '提交会按"客观值"导入，「账户对比」里看不到你')

    if by_map:
        print('   账户线索（按 cid 的年份，事实来自 `me.json` 的 `hdu.years`）：')
        for f, h in by_map:
            n = sum(1 for s in (submits or []) if _s(s.get('_来源文件')) == f)
            print(f'      {os.path.basename(f)}（{n} 条）→ {h}')

    if not contest_info:
        warnings.append(
            '既没有比赛列表，也没能从链接里反查出 cid — '
            '无法确定比赛归属，产出将为空。请至少给 Hdu_problems.json。')

    # ---- only_used_contests：只保留"本包真的有数据"的比赛 ----
    # 判据 = 题目/提交的链接里出现了这个 cid。
    if only_used_contests and contest_info:
        used: set[str] = set()
        for item in list(problems or []) + list(submits or []):
            link = _s(item.get('题目链接')) or _s(item.get('link'))
            cid = cid_from_link(link)
            if cid:
                used.add(cid)
        dropped = sorted(set(contest_info) - used)
        if dropped:
            warnings.append(
                f'--only-used-contests：丢弃了 {len(dropped)} 场没有题目/提交的比赛'
                f'（{", ".join(dropped)}）')
        contest_info = {k: v for k, v in contest_info.items() if k in used}

    # ---- 建骨架：平台 → 系列 → 年份 → 比赛 ----
    # 平台节点的链接也走 **`链接分类`**，
    # 不再往 `link` 裸字段里写（裸字段在来源面板里没有出处）。
    c.platform(platform_key(), name=PLATFORM_NAME,
               **link_kinds(('browse', PLATFORM_URL)))

    # 同一系列的 S 只建一次；同一年份的 S 也只建一次
    series_added: set[str] = set()
    year_added: set[str] = set()
    contest_added: set[str] = set()

    def ensure_series(skey: str, slabel: str) -> str:
        if skey not in series_added:
            c.series(platform_key(), series_key(skey), name=slabel)
            series_added.add(skey)
        return series_key(skey)

    def ensure_year(skey: str, year: str) -> str:
        """系列下的年份层（S 套 S）。返回年份节点的 extKey。"""
        yk = year_key(skey, year)
        if yk not in year_added:
            c.series(series_key(skey), yk, name=year)
            year_added.add(yk)
        return yk

    def ensure_contest(cid: str) -> str:
        ck = contest_key(cid)
        if ck not in contest_added:
            info = contest_info.get(cid, {})
            name = info.get('name') or f'比赛 {cid}'
            start = info.get('start') or ''
            skey, slabel = pick_series(name)
            parent = ensure_series(skey, slabel)
            year = ''
            if GROUP_BY_YEAR:
                year = pick_year(name, start)
                if year:
                    parent = ensure_year(skey, year)
                else:
                    warnings.append(
                        f'cid={cid}（{name or "无名"}）认不出年份，直接挂在系列'
                        f'{slabel} 下。想让它也有年份层，就在比赛名或开始时间里带上 20xx')
            # contestTime 用比赛开始时间（应用会归一化格式）
            # 链接按**类别**写进元列 `链接分类`（与 xcpc 同一套）：
            # 「数据爬取部分不应该有『存在多值时排除一些值』的逻辑」。
            # 类别由本适配器声明：
            #   * 比赛页（题目列表）→ `problems`；应用层派生进 `link`
            #   * 排行榜页 → `board`，**只在真有榜单统计（rank_stats）时才写**
            #     （没抓过榜单却给一个空排行榜页 = 假信息，宁可不写）
            pairs = [('problems', contest_url(cid))]
            if cid in stat_contests:
                pairs.append(('board', contest_rank_url(cid)))
            # 性质：**这棵树上的比赛都是杭电办的**
            # （杭电多校 / 杭电校赛·公开赛，见 SERIES_RULES）⇒ 大类恒为 `hdu`。
            # 小类『多校』：**只有杭电暑期联赛那条系列
            # 才是 `多校`**，校赛/公开赛写 `无`（判据 = `pick_series` 认出来的 skey，不猜名字）。
            # 地区写 `无`：杭电的比赛都是线上赛、没有场地地区。
            # 年份就是上面那层年份节点认出来的同一个值
            # （同一份判据 `pick_year`，不另立一套 —— 树上的年份层与字段必须一致）；
            # **赛季同值**：nk/hdu 多校的赛季同举办年份。
            c.contest(parent, ck, name=name,
                      contestTime=normalize_time(start),
                      **nature_fields(('natureClass', SUB_BY_SERIES.get(skey, SUB_DEFAULT)),
                                      ('natureYear', year), ('natureSeason', year),
                                      ('natureRegion', '无')),
                      # 分类依据（元列 `分类依据`）：**杭电自己的系列规则**（`pick_series` 认出的
                      # skey）—— A 权威：不是看赛名猜的，是系列判据。
                      **class_rules(('natureClass', 'hdu:series'),
                                    # 年份/赛季/地区的**依据**（与 nk 同一套写法）：
                                    # 年 = `pick_year` 先赛名（C）再开赛时间（A）；赛季同值（结构性口径 ⇒ B）；
                                    # 地区 `无`（线上赛 ⇒ B）。
                                    ('natureYear', 'hdu:year-name' if (year and year in (name or ''))
                                     else ('hdu:year-time' if year else '')),
                                    ('natureSeason', 'hdu:season-same' if year else ''),
                                    ('natureRegion', 'hdu:region-none')),
                      **link_kinds(*pairs))
            contest_added.add(ck)
        return ck

    for cid in sorted(contest_info):
        ensure_contest(cid)

    # ---- 题目 ----
    # 记录每道题的 (cid, pid) → 是否被判为已解决，用于交叉校验
    solved_by_pid: dict[tuple[str, str], bool] = {}
    problems_added = 0

    for i, p in enumerate(problems or []):
        link = _s(p.get('link'))
        cid = cid_from_link(link)
        pid_num = _s(p.get('problem_id'))
        if not cid or not pid_num:
            warnings.append(f'第 {i} 道题缺 cid 或 problem_id，已跳过：{p.get("title")!r}')
            continue
        if cid not in contest_info:
            warnings.append(f'第 {i} 道题的 cid={cid} 不在比赛列表里（会在树上新建一个比赛节点）')

        ck = ensure_contest(cid)

        # 题号字母：优先用爬虫给的 problem_id2，否则自己按 1001→A 算
        letter = _s(p.get('problem_id2')) or letter_of(pid_num)
        if not letter:
            warnings.append(
                f'{cid}/pid={pid_num}：超出 {LETTER_BASE_PID}..'
                f'{LETTER_BASE_PID + LETTER_MAX - 1}，算不出字母题号，'
                '已回落到原始数字')
        label = letter or pid_num

        fields = {
            'name': _s(p.get('title')),
            'problemId': label,
            'link': link,
        }

        # ---- ratio 来源优先级 ----
        # 1. 榜单赛时数据（唯一可信的"这场比赛"口径）
        # 2. EXPORT_RATIO=True 时的历史数据（默认关；那算的是全站累计）
        st = stat_table.get((cid, pid_num))
        if st and st.get('ratio'):
            fields['ratio'] = st['ratio']
        elif EXPORT_RATIO:
            accepted = p.get('accepted')
            submitted = p.get('submitted')
            if isinstance(submitted, int) and submitted > 0 and isinstance(accepted, int):
                fields['ratio'] = f'{accepted / submitted * 100:.2f}'

        c.problem(ck, problem_key(cid, label, pid_num), **fields)
        problems_added += 1
        solved_by_pid[(cid, pid_num)] = bool(p.get('solved'))

    # ---- 提交 ----
    submissions_added = 0
    ac_by_pid: dict[tuple[str, str], bool] = {}

    for i, s in enumerate(submits or []):
        link = _s(s.get('题目链接'))
        cid = cid_from_link(link)
        pid_num = _s(s.get('题号'))            # Hdu_submits 的"题号"是数字 pid
        rid = _s(s.get('运行ID'))
        if not rid or not cid or not pid_num:
            warnings.append(f'第 {i} 条提交缺 运行ID/cid/pid，已跳过')
            continue

        ck = ensure_contest(cid)

        letter = _s(s.get('题号2')) or letter_of(pid_num)
        label = letter or pid_num
        pk = problem_key(cid, label, pid_num)

        # 提交的父题目可能不在本包里（只导了提交没导题目）→ 补一个占位题目
        if pk not in c._emitted:
            c.problem(ck, pk, name=label, problem_id=label, link=link)

        status = _s(s.get('运行结果2')) or normalize_status(s.get('运行结果'))
        status = STATUS_ALIAS.get(status, status)

        sk = submission_key(cid, rid)
        # 同一场里 rid 撞车 = 输入脏了（爬虫已按运行ID 去重，走到这里说明
        # 有人在同一个文件里混了别场的记录）。**不要让它变成 crate 的
        # "extKey 重复"崩溃** —— 那样只知道一个 key，不知道来源。
        if sk in c._emitted:
            warnings.append(
                f'{cid} 的提交 运行ID={rid} 在本包内重复出现，已跳过该条。'
                '多半是同一个文件里混了两次（或混进了别场的记录）')
            continue

        # 账户线索（`hdu:<赛季>` 命名空间）—— 没声明 handle 就不带这个键
        info = contest_info.get(cid, {})
        src_file = _s(s.get('_来源文件'))
        clue = submit_clue(file_handle.get(src_file, ''),
                           pick_year(_s(info.get('name')), _s(info.get('start'))), cid)

        c.submission(
            pk,
            sk,
            status=status,
            time=normalize_time(_s(s.get('提交时间'))),
            link=_s(s.get('提交链接')),
            # 提交性质（赛时 / 补题）—— 按"提交日 == 比赛日"判，判不准留空
            submitKind=(submit_kind(s.get('提交时间'), info.get('start'), info.get('end')) or None),
            **run_fields(s),
            **({'账户线索': clue} if clue else {}),
        )
        submissions_added += 1
        if status == 'AC':
            ac_by_pid[(cid, pid_num)] = True

    # ---- 交叉校验：题目里的 solved 与提交里的 AC 是否对得上 ----
    for (cid, pid_num), solved in solved_by_pid.items():
        has_ac = ac_by_pid.get((cid, pid_num), False)
        if submits and solved and not has_ac:
            warnings.append(
                f'{cid}/p{pid_num}：题目列表标了 solved=true，但本次提交记录里没有 AC。'
                '（若你只导了部分提交，这是正常的；应用以 R 记录为准）'
            )

    # ---- 榜单统计的交叉校验 ----
    if rank_stats:
        if not stat_table:
            warnings.append('榜单统计里没有题目数据')
        else:
            missing = stat_contests - set(contest_info) if stat_contests else set()
            if missing:
                warnings.append(
                    f'榜单的 cid={", ".join(sorted(missing))} 不在本次比赛的集合里 '
                    f'（本次有：{", ".join(sorted(contest_info))}）。'
                    'ratio 仍会按 cid 匹配 —— 若两场对不上，说明你混用了不同比赛的数据')
            matched = sum(1 for (cc, pp) in stat_table if (cc, pp) and cc in contest_info)
            if matched == 0:
                warnings.append('榜单统计与本包题目一条都没匹配上（cid 或 pid 对不上）')

    # ---- 统计 ----
    if not problems_added and not submissions_added:
        warnings.append('没有产出任何题目或提交记录 — 请检查输入文件是否配对（同一场比赛？）')

    return c, warnings


# ================================================================
# CLI
# ================================================================

def handle_from_me() -> str:
    """
    从 `acm-data/raw/Scaper/me.json` 读 `hdu.handle`（**全项目唯一的个人信息文件**）。

    读不到就返回空串（不报错）：没有 handle 只是"提交不带账户线索"，
    不该让整条流水线失败。读取实现走 `Scaper/lib/me.py`（**唯一一份**），
    环境变量 `HDU_HANDLE` 可临时覆盖。
    """
    hs = hdu_handles()
    return hs[0] if hs else ''


def hdu_handles() -> list[str]:
    """
    要认领的 HDU 账号（**多人**：花名册 `team[].hdu` 里登记过的都算）。

    ⚠️ 这里只回答"**有哪些账号**"，不回答"哪条提交是谁的" —— 后者**必须**由
    `me.json` 的 `hdu.files`（或 `--file-handle`）**显式绑定**（见 `build()` 的说明）。
    顺序 = `hdu.handles` 列表 → 花名册 `team[].hdu` → 单个 `hdu.handle`。
    读取实现**只有 `Scaper/lib/me.py:handles()` 一份**。

    ★ **不再兜底**（2026-10-16，用户定的口径："② 干脆别兜底"）：原来 `me.py` 导不进来时会
      自己解析 `me.json`（只读 `hdu.handles` + 单数 `hdu.handle`、**不认花名册**）⇒ 会**静默缩小**
      认领范围；现在导不进来就**当场停**（`me.json` 本身没有/没写仍是"返回空列表"）。
    """
    return [h for h in (_me().handles('hdu') or []) if h]


def file_handles_from_me() -> list[str]:
    """
    从 `me.json` 的 `hdu.files` 读**持久化的文件绑定**：`{"文件名": "账号"}`。

    为什么要有它：多人的归属只能靠 `--file-handle` 显式绑定，而每次出包都手敲一遍
    很容易漏。写进 `me.json` 就长期生效，流水线会自动透传。
    键可以是**文件名**或相对路径（适配器按"完整路径 → 后缀 → 文件名"匹配）。

    ⚠️ 2026-10-19 修：这里以前自己 `open(Scaper/me.json)` —— 而凭据 2026-10-17 已经搬到
    `个人数据/me.json` ⇒ 那条路**永远读不到**（`hdu.files` 静默失效，写了等于没写）。
    现在只走 `lib/me.py:hdu_file_handles()`（位置与解析都跟着 `ME_FILE` 走）。
    """
    return [f'{k}={v}' for k, v in _me().hdu_file_handles().items()]


def _me():
    """`Scaper/lib/me.py` 模块（**个人信息唯一入口**）—— 导不进来就当场停（别自己解析 me.json）"""
    shared = os.path.abspath(os.path.join(_HERE, '..', 'lib'))
    if shared not in sys.path:
        sys.path.insert(0, shared)
    try:
        import me as me_mod
    except ImportError as err:
        sys.exit(f'❌ 读不到 {shared}{os.sep}me.py（{err}）—— 这里**不自己解析 me.json**：'
                 f'个人信息（凭据 / 花名册 / 按年的比赛账号 / hdu.files）只有那一份实现。修好这个 import 再跑。')
    return me_mod


def _cli(argv: list[str]) -> int:
    import argparse

    ap = argparse.ArgumentParser(
        description='把 Hdu_*.json 转成 Acm_Tree 导入包')
    ap.add_argument('inputs', nargs='+',
                    help='2~3 个文件：可给 (contests problems submits) 或 (problems submits) 或 (problems)')
    ap.add_argument('-o', '--out', required=True, help='输出 crate 路径')
    ap.add_argument('--source-id', default='hdu-scraper')
    ap.add_argument('--only-used-contests', action='store_true',
                    help='只导出"本包真的有题目或提交"的比赛（默认把比赛列表全建出来）')
    ap.add_argument('--rank-stats', nargs='+', default=[],
                    help='hdu_rank_stats.py 的产出 JSON（可给多个，一场一份）—— 给了就用赛时通过率填 ratio')
    ap.add_argument('--handle', default='',
                    help='你在 HDU 上的用户名（不给就读 me.json 的 hdu.handle/花名册）—— '
                         '给了它**所有**提交都带账户线索 `hdu:<赛季> : handle = <你>`。'
                         '逗号分隔多个也可以（= `--handles`，但那样必须配 `--file-handle`）。')
    ap.add_argument('--handles', default='',
                    help='**多人**：逗号分隔的账号列表。⚠️ 光给这个**不会**归属 —— '
                         'HDU 数据里没有提交者，你必须再用 `--file-handle` 说明"哪份文件是谁抓的"')
    ap.add_argument('--file-handle', action='append', default=[], metavar='路径=账号',
                    help='**显式绑定**（可重复）：`<提交文件>=<账号>`，如 '
                         '`--file-handle "hdu_cid1229_submits.json=我"`。'
                         '匹配方式：完整路径 → 后缀 → 文件名（按此优先级找唯一一份）。'
                         '多人**只能**这样归属（不靠任何"顺序"）。'
                         '也可以写进 me.json 的 `hdu.files` 让它长期生效 '
                         '（`{"hdu_cid1229_submits.json": "我"}`），流水线会自动带上')
    args = ap.parse_args(argv)

    loaded = [load(p) for p in args.inputs]
    if not all(isinstance(x, list) for x in loaded):
        print('❌ 输入文件根节点都应是数组', file=sys.stderr)
        return 2

    contests: list = []
    problems: list = []
    submits: list = []

    # 按内容特征识别，而不是靠文件名（文件名各人习惯不同）
    # ⚠️ 用 extend 而不是赋值：流水线会把**多场**的题目/提交一起塞进来，
    #    赋值的话后一个文件会覆盖前一个，只剩最后一场（真实踩过的坑）。
    for path, data in zip(args.inputs, loaded):
        sample = data[0] if data else {}
        if not isinstance(sample, dict):
            continue
        if 'contest_id' in sample and 'contest_name' in sample:
            contests += data
        elif '运行ID' in sample or '运行结果' in sample:
            # 记住每条提交来自哪个文件：HDU 的数据里**没有提交者**，
            # 多人时只能靠"这份文件是谁抓的"来定归属（见 --handles 的说明）
            submits += [dict(r, _来源文件=path) for r in data]
        elif 'problem_id' in sample or 'title' in sample:
            problems += data
        else:
            print(f'⚠️  无法识别 {path} 的类型，已忽略（表头字段：'
                  f'{list(sample.keys())[:5]}）', file=sys.stderr)

    if not problems and not submits:
        print('❌ 没识别出题目或提交文件 —— 请检查输入', file=sys.stderr)
        return 2

    # ---- 榜单统计：--rank-stats 未给时，自动找输入文件同目录的 hdu_rank_stats*.json ----
    # 为什么自动找：这是"赛时通过率"的唯一来源，忘了加就静默少了 ratio、
    # 而且不会报错（ratio 只是空着）。自动发现能避免这种静默降级。
    rank_paths = list(args.rank_stats or [])
    if not rank_paths:
        near = os.path.dirname(os.path.abspath(args.inputs[0]))
        found = sorted(f for f in os.listdir(near)
                       if f.startswith('hdu_rank_stats') and f.endswith('.json'))
        if found:
            rank_paths = [os.path.join(near, f) for f in found]
            print(f'ℹ️  自动使用同目录的榜单统计 {len(found)} 份：{", ".join(found)}')

    rank_stats = None
    if rank_paths:
        try:
            rank_stats = load_rank_stats_many(rank_paths)
        except Exception as e:
            print(f'⚠️  读取榜单统计失败：{e}（将不使用赛时通过率）', file=sys.stderr)

    # 账户线索：优先 `--handles`/`--handle`（可逗号分隔多个），否则 me.json / 花名册。
    # 多人时的**归属必须靠 `--file-handle` 显式绑定**（见 `build()` 里的规则说明）。
    hs = [x.strip() for x in _s(args.handles).split(',') if x.strip()] \
        or [x.strip() for x in _s(args.handle).split(',') if x.strip()] \
        or hdu_handles()
    crate, warnings = build(contests, problems, submits,
                            source_id=args.source_id,
                            only_used_contests=args.only_used_contests,
                            rank_stats=rank_stats,
                            handle=hs,
                            file_handle_specs=(list(args.file_handle or [])
                                               + file_handles_from_me()))
    data = crate.to_dict()
    issues = validate_crate(data)

    crate.save(args.out)
    print(f'✅ 已写出 {args.out}')
    print(f'   {crate.summary()}')
    if contests:
        print(f'   比赛列表里识别到 {len(contests)} 场（本包只用了其中的）')
    if rank_stats and rank_stats.get('table'):
        ct = rank_stats.get('contests') or {}
        detail = '、'.join(f'cid={k} 有效队伍 {v}' for k, v in sorted(ct.items()))
        print(f'   赛时通过率：{len(rank_stats["table"])} 条（口径 = 通过队伍数 / 有效队伍数）'
              + (f'；{detail}' if detail else ''))
    # 账户线索的**实际取值**要看包：可能是 5 个（各年那套比赛账号），也可能是 1 个兜底
    used = sorted({_s(r.get('账户线索', {}).get('value'))
                   for r in (data.get('records') or [])
                   if isinstance(r.get('账户线索'), dict)} - {''})
    if used:
        print(f'   账户线索：{len(used)} 个值（{", ".join(used)}）—— 各年不同的比赛账号由'
              f' `me.json` 的 `hdu.years.<年份>.contestUser` **按 cid 的年份**决定，`--handle` 只是兜底'
              f'（应用里每个值要有一条 `hdu:<赛季> : handle = <值>` 的映射）')
    elif hs:
        print(f'   账户线索：{len(hs)} 个账号（{", ".join(hs)}）'
              f'—— 但这次一个都没落上（提交文件没被认领）')
    else:
        print('   ℹ️ 没有账户线索（me.json 里没写 hdu.handle）—— '
              '提交会按"客观值"导入，"账户对比"里看不到你')

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
