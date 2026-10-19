#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
Codeforces（含 gym）提交记录 → crate 片段（**只出 R**）

数据来源
--------
Codeforces 公开 API（**不需要登录、不需要 cookie**）：

    https://codeforces.com/api/contest.status?contestId=<gym>&handle=<handle>&from=1&count=<N>

实测：gym 106701 可以这样查，返回的每条含
`id / creationTimeSeconds / problem{index,name} / author.members[].handle /
verdict / programmingLanguage / timeConsumedMillis`。

⚠️ **必须给 handle**：整场 gym 的提交超过 1 万条（API 单次上限 10000），
全导进来会让树上挂满几万个 R 节点 —— 而应用里 R 只用来推导"我过了没"，
所以只要**自己**的提交（与 HDU / 牛客那套的取数范围一致）。

没给 handle 会直接报错；handle 写错会拿到 Codeforces 的原话
（`handle: User with handle XXX not found`）。

提交身份
--------
    xcpc:c:<slug>:sub:cf:<提交ID>

用法
----
    python cf_adapter.py icpc2026preliminary-2              # 用清单里的 gym/handle
    python cf_adapter.py icpc2026preliminary-2 --handle X   # 临时换 handle
    python cf_adapter.py icpc2026preliminary-2 --gym 106701 --handle X -o out.json
    python cf_adapter.py icpc2026preliminary-2 --no-fetch   # 只用本地缓存，不联网

缓存：抓下来的原始响应存到清单里写的 `file`（默认 `cache/cf_<gym>_<handle>.json`），
     下次直接读缓存 —— 想强制重抓就删掉那个文件。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request

sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, 'lib'))
# 通用区（`Scaper/lib/`）：范围的**并集口径**与**统一环节模块**都住那儿 ——
# 04 qoj 与 05 xcpc 互不依赖，所以这两样只能放通用区。
sys.path.insert(0, os.path.abspath(os.path.join(HERE, '..', 'lib')))

import stages  # noqa: E402  —— 统一环节模块（判据 + 依据 + 记账）

from xcpc_common import (GYM_WHITELIST, add_crate_path,  # noqa: E402
    CACHE, CF_PLATFORM, cf_gym_key, cf_problem_key, cf_submission_key, find_contest, union_scope,
    load_manifest, norm_letter, read_json, rel, resolve, write_json,
)

add_crate_path()

from read_modes import add_cli_args, configure_from, forced, print_stats  # noqa: E402

from crate import (SUBMIT_DURING, SUBMIT_AFTER, SUBMIT_VP, Crate, _s,  # noqa: E402
                   nature_fields, normalize_status, to_cst, validate_crate)

LABEL = 'Codeforces 提交'
WHITELIST = GYM_WHITELIST   # ⚠️ 路径只有一处（`xcpc_common.GYM_WHITELIST`）
RANKLAND_INDEX = os.path.join(CACHE, 'rankland_index.json')
GYM_META = os.path.join(CACHE, 'cf_gym_meta.json')
API = 'https://codeforces.com/api/contest.status'


def _ymd_of_epoch(sec) -> tuple[str, str]:
    """`startTimeSeconds` → `(年份, 'YYYY-MM-DDTHH:MM:SS+08:00')`；拿不到就两个空串。

    +08:00 读：CF 的 gym 赛历按北京时间的比赛最多，这样"日期"跟人记的那天一致。
    """
    try:
        t = int(sec)
    except (TypeError, ValueError):
        return '', ''
    if t <= 0:
        return '', ''
    import time as _time
    lt = _time.gmtime(t + 8 * 3600)
    return str(lt.tm_year), _time.strftime('%Y-%m-%dT%H:%M:%S+08:00', lt)

# Codeforces 的 verdict → 应用的状态词汇（scripts/crate.py 的 STATUS_OPTIONS）
#
# ⚠️ `COMPILATION_ERROR` 映射成 **`CE`**（`STATUS_OPTIONS` 里已有 CE；
#    词汇表里没有的就洗成 `-`，理由是"词汇表里没有就不冒充"）。
# ⚠️ CF 还有三种**不是编译错误**的判定，也不该落 `-` ——
#    `IDLENESS_LIMIT_EXCEEDED`（交互题空转，26 条）→ **`ILE`**（颜色与 TLE 一致）、
#    `CHALLENGED`（被 hack，7 条）→ **`HACK`**、`PARTIAL`（部分分，1 条）→ **`PC`**。
# ⚠️ **未知 verdict 一律交给 `normalize_status()`**（不再 `.get(..., '-')` 硬留 `-`）：
#    它会做中英文别名 + 认不出的给**英文缩写** ⇒ 以后 CF 再加新 verdict 也不会静默丢成 `-`。
VERDICT_MAP = {
    'OK': 'AC',
    'WRONG_ANSWER': 'WA',
    'TIME_LIMIT_EXCEEDED': 'TLE',
    'MEMORY_LIMIT_EXCEEDED': 'MLE',
    'RUNTIME_ERROR': 'RE',
    'COMPILATION_ERROR': 'CE',
    'IDLENESS_LIMIT_EXCEEDED': 'ILE',
    'CHALLENGED': 'HACK',
    'PARTIAL': 'P.AC',
}


def cf_handles(explicit: str = '') -> list[str]:
    """
    要抓的 CF 账号（**多人**：花名册里登记过的都算）。

    优先级在 `lib/me.py` 的 `handles()` 里：参数 > 环境变量 > `cf.handles` 列表 >
    花名册 `team[].cf` > 单个 `cf.handle`。读不到就返回 `[]`（调用方再退到清单里的 `handle`）。
    """
    shared = os.path.abspath(os.path.join(HERE, '..', 'lib'))
    if os.path.isfile(os.path.join(shared, 'me.py')):
        if shared not in sys.path:
            sys.path.insert(0, shared)
        try:
            import me as me_mod
            return me_mod.handles('cf', explicit)
        except ImportError:
            pass
    return [x.strip() for x in _s(explicit).split(',') if x.strip()]


def fetch(gym: str, handle: str, count: int = 10000) -> list[dict]:
    """调 API 拿某个 handle 在这场的提交（分页，直到拿完或到上限）"""
    out, start, page = [], 1, 2000
    while True:
        url = f'{API}?contestId={gym}&handle={handle}&from={start}&count={page}'
        req = urllib.request.Request(url, headers={'User-Agent': 'acm-tree/xcpc'})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                data = json.loads(r.read().decode('utf-8', 'replace'))
        except urllib.error.HTTPError as e:
            body = e.read().decode('utf-8', 'replace')[:300]
            raise RuntimeError(f'Codeforces 拒绝了请求（{e.code}）：{body}') from None
        if data.get('status') != 'OK':
            raise RuntimeError(f'Codeforces 返回：{_s(data.get("comment")) or data}')
        got = data.get('result') or []
        out.extend(got)
        if len(got) < page or len(out) >= count:
            break
        start += page
    return out


def pick(records: list[dict], handles) -> list[dict]:
    """
    只留**目标 handle 集合里**的人提交的（API 已过滤，这里再兜一次底）、且属于本 gym 的。

    `handles` 可以是单个字符串或集合/列表（多人）。
    空集合 = 不过滤（宁可全留，也别悄悄丢掉——但正常路径不会走到这里）。
    """
    want = {_s(h) for h in ([handles] if isinstance(handles, str) else (handles or []))}
    want.discard('')
    hit = []
    for r in records:
        members = [_s(m.get('handle')) for m in
                   ((r.get('author') or {}).get('members') or [])]
        if want and not (set(members) & want):
            continue
        if not (r.get('problem') or {}).get('index'):
            continue
        hit.append(r)
    return hit


def person_of(record: dict, handles: list[str]) -> str:
    """
    这条提交算**谁**的：在目标 handle 里按**登记顺序**取第一个出现在 members 里的。

    为什么按登记顺序而不是 members 顺序：gym 的提交作者是**队伍**（`author.members` 可能 3 个人），
    members 顺序没有含义；按花名册顺序取，结果稳定、可解释
    （想换人就把 `me.json` 的 `team` 顺序调一下）。
    """
    members = {_s(m.get('handle')) for m in ((record.get('author') or {}).get('members') or [])}
    for h in handles:
        if h and h in members:
            return h
    return ''


def build(slug: str, records: list[dict], gym: str, handle: str = '',
          handles: list[str] | None = None) -> tuple[Crate, list[str]]:
    """
    组装 crate。

    `handles` 给多人；只给 `handle`（单数）时按单人处理。
    """
    want = [h for h in (handles or ([handle] if handle else [])) if h]
    # 来源元信息里的 platform：这段出的是 **CF 那棵树**的节点 ⇒ platform 写 `cf`
    crate = Crate(source_id=f'cf-{slug}', label=LABEL, platform=CF_PLATFORM)
    warns = []
    # 提交性质按"官方比赛时段"判（CF 的 participantType 在 gym 里不可靠）
    window = gym_window(gym, slug)
    if window[0]:
        print(f'   比赛时段：{window[0]} ~ {window[1]}（判 赛时/VP/补题 用）')
    else:
        warns.append('拿不到这场的官方比赛时段（CF 缓存 + 白名单都没有）—— '
                     '提交性质只能退回 CF 官方字段判，gym 里可能不准')
    seen = set()
    rated = set()      # 已经出过 `cfDifficulty` 的题号（一道题只出一条 P 记录）
    for r in records:
        sid = _s(r.get('id'))
        letter = norm_letter((r.get('problem') or {}).get('index'))
        if not sid:
            warns.append('有一条缺提交 id，跳过')
            continue
        if not letter:
            warns.append(f'提交 {sid} 缺题号，跳过（定位不到父题目）')
            continue
        if sid in seen:
            warns.append(f'提交 {sid} 重复出现，已去重')
            continue
        seen.add(sid)

        # 账户线索：这条提交的作者 handle。
        #   - gym 的提交作者可能是**队伍**（`author.members` 多个 handle），
        #     按花名册顺序取第一个命中的（`person_of`），而不是 members[0]
        #     —— 否则队友排前面时会把人认错（实测 101775 里有 3 个 members 的记录）；
        #   - 应用不解释 `handle` 的含义，只拿它去查账户注册表的映射。
        #
        # ⚠️ `source` **不带赛季**（CF 账号不会每年一换，加赛季是画蛇添足）——
        #    应用侧有**兼容回退**：`core/accounts.js` 会把 `cf:23` 当 `cf` 再查一次，两种写法都认。
        who = person_of(r, want) or (
            _s((((r.get('author') or {}).get('members') or [{}])[0] or {}).get('handle'))
            if not want else '')
        clue = ({'source': 'cf', 'field': 'handle', 'value': who} if who else None)

        verdict = _s(r.get('verdict'))
        # 「先提取备用」：提交的运行信息（语言/耗时/内存）。口径：**毫秒 / 字节**。
        crate.submission(
            cf_problem_key(gym, letter),
            cf_submission_key(gym, sid),
            # 表里没有的 verdict ⇒ 交给 `normalize_status()`（别名 / 自造缩写），**不留 `-`**
            status=VERDICT_MAP.get(verdict) or normalize_status(verdict),
            time=to_cst(r.get('creationTimeSeconds')),
            link=f'https://codeforces.com/gym/{gym}/submission/{sid}',
            language=(_s(r.get('programmingLanguage')) or None),
            timeUsed=(str(r.get('timeConsumedMillis')) if r.get('timeConsumedMillis') is not None else None),
            memoryUsed=(str(r.get('memoryConsumedBytes')) if r.get('memoryConsumedBytes') is not None else None),
            submitKind=submit_kind(r, window),
            **({'账户线索': clue} if clue else {}),
        )
        # 题的官方难度分只在**正式题池**里有（gym 镜像多半没有）→ 有才写，没有不占位。
        # ⚠️ 父是**比赛**（`cf_gym_key`），不是题目自己 —— `problem(key, key)`
        #    是自引用环（父指向自己），一旦这条被触发就会被导入按"父节点不存在"拒绝。
        rating = (r.get('problem') or {}).get('rating')
        if rating and letter not in rated:
            rated.add(letter)
            # 性质：这份片段只出 CF gym 的 P（C 由 `cf_board_adapter.py` 出），
            # **P 也是 CF gym 的题** ⇒ 大类同样写 `cf`（两边同值，合并不会冲突）。
            # 小类/地区/年份留空：这里手上只有题面，没有赛期（年份在 C 上）。
            crate.problem(cf_gym_key(gym), cf_problem_key(gym, letter),
                          problem_id=letter, cfDifficulty=str(rating))
    return crate, warns


# ---- 提交性质 ----
#
# **判据 = 官方比赛时段**（`gym_window`），不靠 `participantType` —— 原因见下。
#
# CF 官方还能给两个字段（实测 1583 条提交）：
#   * `relativeTimeSeconds`：官方语义"距开赛秒数"，**不在时段内则是 INT_MAX**。
#   * `author.participantType`：`CONTESTANT` / `VIRTUAL` / `PRACTICE`。
#
# ⚠️ **两个坑（都实测踩到）**：
#   1. `participantType` 在 gym 里**不可靠**：真实参赛的 `zjcpc` 系列，
#      CF 返回的是 `PRACTICE` + INT_MAX —— 照它判会把真实赛时提交说成"补题"。
#   2. `relativeTimeSeconds` 对 **gym** 也基本是 INT_MAX（上面那 324 条就是），
#      所以它只在**正式比赛**（非 gym）里好用。
#
# 于是最终口径（见 `submit_kind`）：
#   ① 有比赛时段 → 落在 [开赛, 开赛+时长] 内 = `赛时`；时段之后 = `VP`/`补题`。
#      这一条**同时解决了"重放"歧义**：重放/VP 的时间戳必然落在窗口之后。
#   ② 没有时段（实测 57 场里 6 场）→ **只用相对时间**：非 INT_MAX 且 ≥0 = `赛时`，
#      否则**留空**（"不在时段内"分不清 VP 与补题，宁可不写）。
CF_REL_TIME_NOT_IN_CONTEST = 2147483647      # INT_MAX：CF 官方的"不在比赛时段内"
CF_DEFAULT_DURATION = 18000                  # 实测缓存里 gym 的 durationSeconds 基本都是 18000


def gym_window(gym, slug: str = '') -> tuple:
    """
    某场 gym 的官方比赛时段 `(start_epoch, end_epoch)`；拿不到返回 `(None, None)`。

    开赛时间的来源按可靠性排（实测覆盖率）：
      ① `cache/rankland_index.json` 的 `bySlug[slug].startAt` —— **391/394 场都有**，最全；
      ② `cache/cf_standings_<gym>.json` 的 `contest.startTimeSeconds`
         （**gym 里常常是 None**，时长 `durationSeconds` 倒是都有，基本是 18000）；
      ③ `gym_whitelist.json` 的 `startAt`（95 场里只有 53 场有）。

    为什么非要它：CF 的 `participantType` 在 gym 里**不可靠** ——
    实测真实参赛的 `zjcpc` 系列，官方返回 `PRACTICE` + INT_MAX，
    照它判会把真实赛时提交说成"补题"（踩过：324 条）。
    """
    start = None
    dur = CF_DEFAULT_DURATION

    # ② 先拿时长（standings 缓存里的 durationSeconds 比默认值可信）
    p = os.path.join(CACHE, f'cf_standings_{gym}.json')
    if os.path.isfile(p):
        try:
            c = (read_json(p) or {}).get('contest') or {}
            if c.get('startTimeSeconds'):
                start = int(c['startTimeSeconds'])
            if c.get('durationSeconds'):
                dur = int(c['durationSeconds'])
        except (ValueError, OSError, TypeError):
            pass

    # ① rankland 索引（开赛时间最全）
    if start is None and slug:
        idx = os.path.join(CACHE, 'rankland_index.json')
        if os.path.isfile(idx):
            try:
                info = ((read_json(idx) or {}).get('bySlug') or {}).get(slug) or {}
                iso = str(info.get('startAt') or '').strip()
                if iso:
                    import datetime as _dt
                    start = int(_dt.datetime.fromisoformat(iso).timestamp())
            except (ValueError, OSError, TypeError):
                pass

    # ③ 白名单兜底
    if start is None:
        try:
            from cf_board_adapter import start_time_from_whitelist  # noqa: WPS433
            iso = start_time_from_whitelist(gym)
            if iso:
                import datetime as _dt
                start = int(_dt.datetime.fromisoformat(iso).timestamp())
        except Exception:  # noqa: BLE001
            pass

    if start is None:
        return (None, None)
    return (start, start + dur)


def submit_kind(record: dict, window: tuple = (None, None)) -> str:
    """
    CF 提交 → `赛时` / `VP` / `补题`；判不出返回 ''（**不写"未知"**）。

    判据**优先用比赛时段**，因为 CF 的 `participantType` 在 gym 里**不可靠**：
    实测真实参赛的 `zjcpc` 系列，官方返回的是 `PRACTICE` + INT_MAX
    （gym 里团队赛的非注册成员就是这个标记），照它判会把 324 条真实赛时提交说成"补题"。

       ① 有比赛时段（`gym_window`）：
           提交时间在 [开赛, 开赛+时长] 内 → `赛时`
           时段结束后交的 → 看官方类型：`VIRTUAL` 记 `VP`、其它记 `补题`
           （**重放/VP 的时间戳必然落在窗口之后**，所以这一条同时解决了"重放"歧义）
       ② 没有时段 → **只用相对时间**（`relativeTimeSeconds`）判，它是官方语义"距开赛秒数"：
           非 INT_MAX 且 ≥ 0 → `赛时`（提交确实落在比赛时段内）
           INT_MAX / 负 → **留空**（"不在时段内"只说明不是赛时，分不清 VP 与补题，
                          而 `participantType` 在 gym 里实测不可靠 —— 不硬猜）
    """
    cts = record.get('creationTimeSeconds')
    start, end = window
    pt = _s((record.get('author') or {}).get('participantType')).upper()
    if start and cts is not None:
        try:
            t = int(cts)
        except (TypeError, ValueError):
            return ''
        if start <= t <= end:
            return SUBMIT_DURING
        # 时段之后交的：官方类型只说 VIRTUAL / 其它，分不出"重放"与"自己练"的细微差别，
        # 但两者都**不是赛时**，所以这一档是安全的。
        return SUBMIT_VP if pt in ('VIRTUAL', 'CONTESTANT') else SUBMIT_AFTER
    rts = record.get('relativeTimeSeconds')
    if rts is None:
        return ''
    try:
        r = int(rts)
    except (TypeError, ValueError):
        return ''
    return SUBMIT_DURING if (r != CF_REL_TIME_NOT_IN_CONTEST and r >= 0) else ''


def _year_from_name(name: str) -> str:
    """赛名里的**第一个**四位年（`2019-2020 ICPC…` ⇒ `2019`）—— 与项目的赛季口径一致。

    取第一个而不是最后一个：`2022-2023 ICPC Asia …` 是**2022 赛季**的比赛（和 slug
    `icpc2022…` 同口径）。没有就返回空串。
    """
    m = re.search(r'(?<!\d)((?:19|20)\d{2})(?!\d)', str(name or ''))
    return m.group(1) if m else ''


def _fill_missing_season(data: dict) -> int:
    """
    给"CF 没给开赛时间"的 gym 补**赛季**（原地改 `data['gyms']`；返回补了几条）。

    为什么必须补：**实测 2649 场 gym 里有 1519 场 CF 根本没给 `startTimeSeconds`**
    （不是个别现象），所以"哪些是 2022–2025 的比赛"光靠 CF 字段判不出来 ——
    而标题里也常常不写年份。两条判据、按可靠度：

      ① **赛名里的年份**（`_year_from_name`；`2022-2023 ICPC Asia …` ⇒ 2022）；
      ② **按 gym 号插值**：gym 号是按**创建顺序**连发的，前后邻居大多带日期
         ⇒ 取**号最接近**的那个有日期 gym 的赛季。CF 的 gym 列表**最新在前**，
         前几页 = 号最大的那批 = 最近几季 —— 判 22–25 年时正好要看这一段。

    只补 `year`（+ 记 `seasonFrom` 说明依据），**CF 的硬数据永远优先**；
    `start`/`startAt` 只在能从 rankland 索引（按 gym 号 → slug → 开赛时间）拿到时补。
    """
    gyms = data.get('gyms') or {}
    if not gyms:
        return 0
    # rankland 索引：gym 号 → slug → 开赛时间（唯一一份现成证据）
    rl_start: dict = {}
    try:
        idx = read_json(RANKLAND_INDEX)
        by_gym = idx.get('byGym') or {}
        by_slug = idx.get('bySlug') or {}
        for gid, slug in by_gym.items():
            info = by_slug.get(str(slug)) or {}
            raw = info.get('start') or info.get('startAt') or ''
            if raw:
                rl_start[str(gid)] = raw
    except (ValueError, OSError, TypeError):
        rl_start = {}

    dated = []
    for gid, m in gyms.items():
        if m.get('start'):
            m['seasonFrom'] = m.get('seasonFrom') or 'cf（startTimeSeconds）'
            dated.append((int(gid), str(m.get('year') or '')))
    dated.sort()
    fixed = 0
    for gid, m in gyms.items():
        if str(m.get('year') or '').strip():
            continue                                   # CF 给了就别动
        why = ''
        yr = ''
        raw = rl_start.get(str(gid))
        if raw:
            if isinstance(raw, (int, float)) or str(raw).isdigit():
                yr, _iso = _ymd_of_epoch(raw)
                m['start'] = raw
                m['startAt'] = _iso
            else:
                yr = _year_from_name(str(raw))
                m['startAt'] = str(raw)
            why = 'rankland 索引'
        if not yr:
            yr = _year_from_name(m.get('name'))
            why = '赛名里的年份' if yr else ''
        if not yr and dated:
            # 号最接近的那个有日期 gym（列表里大多相邻 ⇒ 差几号就是同一季）
            approx = min(dated, key=lambda kv: abs(kv[0] - int(gid)))
            yr, why = approx[1], f'按 gym 号插值（邻居 {approx[0]}）'
        if not yr:
            continue
        m['year'] = yr
        m['seasonFrom'] = why
        m['seasonEst'] = (why != 'rankland 索引')
        fixed += 1
    return fixed


def fetch_gym_meta(force: bool = False) -> dict:
    """
    **全量 gym 元信息**：`contest.list?gym=true`（公开、**一次调用**）→ `cache/cf_gym_meta.json`。

    为什么值得全量存：CF 上 gym 一共两千多场，这一个调用就把
    `id / 赛名 / 开赛时间 / 时长 / phase` 全给了 —— 只留这几项 + 分类，几百 KB。
    有它才谈得上"按赛名分类筛范围"：范围不再只由
    "白名单勾选 ∪ rankland 标的 gym 号 ∪ 我的提交"这条三源并集决定
    （那样 **rankland 没收录的场次永远进不来**：实测全量里判得出 XCPC/UCup 的有 617 场，
    旧口径只看得到其中一小部分）。

    分类用 `cf_board_adapter.gym_class_rule()`（**判据只有那一份**，这里只是把它跑一遍存下来），
    于是下游（`scope_report` 的"候选"、`xcpc_registry.py scan` 的候选区）**不需要**再各自判一次。

    ⚠️ **这只是元信息**：每题过题数（ratio）与题目清单要 `contest.standings`
    （需登录、**每场一个请求**）—— 那仍然按场次抓，不在这里、也不全量抓。

    @param force 重抓（默认直接用本地那份）
    """
    if not force and os.path.isfile(GYM_META):
        try:
            d = read_json(GYM_META)
            if isinstance(d, dict) and (d.get('gyms') or {}):
                # ★ 每次读到本地那份都顺手补一次"赛季推定"（**不联网**）：
                #   老版本存的元信息里 1519 条没有 year，补完才好按年份筛候选。
                if _fill_missing_season(d):
                    write_json(GYM_META, d)
                return d
        except (ValueError, OSError):
            pass
    from cf_api import call                    # 公开方法：不需要凭据
    from cf_board_adapter import gym_class_rule   # 分类判据**唯一实现**（别在这里重写一份）
    rows = call('contest.list', {'gym': 'true'}) or []
    gyms: dict = {}
    for c in rows:
        gid = str(c.get('id') or '').strip()
        if not gid:
            continue
        name = str(c.get('name') or '')
        cls, rule = gym_class_rule(name, [])
        year, start_at = _ymd_of_epoch(c.get('startTimeSeconds'))
        gyms[gid] = {
            'name': name,
            'year': year,
            'startAt': start_at,
            'start': c.get('startTimeSeconds'),
            'dur': c.get('durationSeconds'),
            'phase': str(c.get('phase') or ''),
            'class': cls,
            'rule': rule,
        }
    out = {
        'source': 'contest.list?gym=true（公开；id/赛名/开赛时间/时长/phase）',
        'note': '全量 gym 元信息 + 赛名分类。**不含**题目与过题数（那要 contest.standings，按场次抓）。'
                'CF 只给一部分 gym 开赛时间（实测 2649 场里有 1519 场没有）⇒ '
                '`year` 可能是推定的，看 `seasonFrom` / `seasonEst`。',
        'count': len(gyms),
        'gyms': gyms,
    }
    _fill_missing_season(out)
    write_json(GYM_META, out)
    return out


def gym_meta_classes(path: str = '') -> dict:
    """`{gym 号: 分类路径}`（`cache/cf_gym_meta.json` 里有就返回；没有 = 空表）。

    给"范围/候选区"用：它们只关心**哪些 gym 判得出 XCPC/UCup**，不关心别的字段。
    """
    p = path or GYM_META
    if not os.path.isfile(p):
        return {}
    try:
        d = read_json(p)
        return {str(g): str(m.get('class') or '')
                for g, m in ((d or {}).get('gyms') or {}).items()}
    except (ValueError, OSError):
        return {}


#: ① **范围环节**（"哪些 gym 进生成节点的范围"）—— 四道闸门，就是这条环节的全部参数。
#:
#: 用统一环节模块（`Scaper/lib/stages.py`）表达：**判据只有这四条**，
#: 加闸门 = 在这里加一条 `Rule`（不再是"在 `scope_report()` 里再写一遍 if 与标签拼接"）。
#: `merge='union'` = 任一闸门表态就要（这正是"显式范围"的语义）；依据 = 表态的那几条 id，
#: 产物里那串 `'whitelist+rankland'` 就是它拼出来的。
#: ⚠️ `Rule.id` **就是存进 `cache/cf_gym_scope.json` 的那个标签**（跨语言：应用里也按它读）。
SCOPE_STAGE = stages.Stage(
    key='scope',
    title='CF gym 抓取范围',
    field='inScope',
    merge='union',
    unit='场',
    missing='四条闸门都没表态（不可能：候选集就是这四条的并集）',
    rules=(
        stages.Rule('whitelist', 'inScope',
                    lambda g, c, _cur: g in c['wl_include'],
                    '`gym_whitelist.json` 里 `include: true`'),
        stages.Rule('rankland', 'inScope',
                    lambda g, c, _cur: g in c['rankland'],
                    'RankLand 索引把这场的 gym 号标出来了'),
        stages.Rule('按分类', 'inScope',
                    lambda g, c, _cur: g in c['classified'],
                    '全量元信息（`cf_gym_meta.json`）里判得出 XCPC/UCup'),
        stages.Rule('我的提交', 'inScope',
                    lambda g, c, _cur: g in c['mine'],
                    '白名单里那场的 `submissions` 计数 > 0（我打过）'),
    ),
)

#: 「我的提交」那一条的 id —— `explicit`（显式范围）要从闸门结果里**排除它**才算得出来
MINE_RULE = '我的提交'


def scope_report(verbose: bool = True) -> dict:
    """
    gym 的抓取范围 = **显式 ∪ 我的提交**，其中

      · 显式 = 白名单勾选 ∪ rankland 标的 gym 号 ∪ **全量元信息里判得出 XCPC/UCup 的**
        （见 `fetch_gym_meta()` —— 没有那份文件就退回前两项，行为回到旧口径）；
      · 我的提交 = 我打过、但上面两项都没收进来的场次。

    （gym 里出现了没打过的场，必须能说清**是谁给的**）。

    产出 `cache/cf_gym_scope.json`：`{gym: 'whitelist'/'rankland'/'我的提交'/'+'.join}`，
    并打印"其中 N 场我没有任何提交"（这些就是名单带来、不是我打过的场 —— 现在起不再静默）。
    判据全用**现成数据**（白名单里的 `submissions` 计数就是"我有没有提交"），不新抓网络。

    ⚠️ **四道闸门在 `SCOPE_STAGE` 里声明**（本文件顶部那一条），这里只做三件事：
    把四份事实凑成 `ctx`、跑环节、按结果落产物。**标签与依据由环节给**，
    不再在这里手拼（那种写法加一道闸门就要记得改两处 —— 本期就踩过：
    "白名单里有 N 个 gym 既没勾选也没被 rankland 标"那句是手写的，加了「按分类」它不会跟着变）。
    """
    rows = (read_json(WHITELIST).get('gyms') or []) if os.path.isfile(WHITELIST) else []
    wl_include = {str(g['id']) for g in rows if g.get('include')}
    wl_all = {str(g['id']) for g in rows}
    mine = {str(g['id']) for g in rows if (g.get('submissions') or 0) > 0}
    # ★ 全量元信息里判得出 XCPC/UCup 的（`fetch_gym_meta()` 的产物；没有就空表 = 旧口径）
    by_class = gym_meta_classes()
    classified = {g for g, cls in by_class.items()
                  if cls.startswith(('cf/gyms/xcpc', 'cf/gyms/ucup'))}
    rankland: set = set()
    if os.path.isfile(RANKLAND_INDEX):
        for _slug, info in (read_json(RANKLAND_INDEX).get('bySlug') or {}).items():
            for gid in (info.get('gyms') or []):
                rankland.add(str(gid))
    # ---- ① 跑范围环节（**四道闸门就是参数**）----
    ctx = {'wl_include': wl_include, 'rankland': rankland, 'classified': classified, 'mine': mine}
    universe = sorted(wl_include | rankland | classified | mine, key=lambda x: (len(x), x))
    got = stages.apply(SCOPE_STAGE, universe, ctx)
    # 显式范围 = 除「我的提交」以外任一闸门表态的（加闸门时这一行不用改）
    explicit = {g for g in universe if set(got.rules.get(g) or ()) - {MINE_RULE}}
    scope = union_scope(explicit=explicit, mine=mine, name='CF gym')
    # 实际进包 = 清单里**被任何 cf 来源引到**的 gym（`board` 或 `sources` 里的 cf 条目）——
    # cf_board_adapter 按 board / website / titles 三种 role 都会出 C，只数 `board` 会少算
    # （实测 22 vs 67）；67 与包里 `cf:s:cf-gym` **子树下**的 C 数完全一致
    # （67 条，键是 `cf:c:<gym id>`、父链走到那棵 S 层）。
    # 本适配器（submissions）只出 R、不出 C。候选口径保留，两个数都打。
    packed: set = set()
    try:
        for c in (load_manifest('').get('contests') or []):
            for one in [c.get('board') or {}] + list(c.get('sources') or []):
                if str(one.get('source') or '') == 'cf' and one.get('gym'):
                    packed.add(str(one['gym']))
    except Exception:  # noqa: BLE001 —— 清单读不到就只报候选口径
        packed = set()
    labels = {gid: got.label(gid) for gid in sorted(scope, key=lambda x: (len(x), x))}
    zero = [g for g in scope if g not in mine]
    write_json(os.path.join(CACHE, 'cf_gym_scope.json'), labels)
    if verbose:
        # ★ 每条闸门各命中几场 + "说不清是谁给的" —— **按环节的结果现算**（加闸门不用改文案）
        stages.report(SCOPE_STAGE, got)
        print(f'   🏷️ CF gym：**候选 {len(scope)} 场** → **实际进包 {len(packed)} 场**'
              f'（清单过滤后；进包 = 清单里被任何 cf 来源引到的 gym）')
        print(f'   💾 来源标注 {rel(os.path.join(CACHE, "cf_gym_scope.json"))}：'
              + '|'.join(r.id for r in SCOPE_STAGE.rules)
              + '（`按分类` = 全量元信息里判得出 XCPC/UCup 的）')
        print(f'   ⚠️ 其中 {len(zero)} 场我**没有任何提交**（名单带来的，不是我打过的场）：'
              + '、'.join(sorted(zero, key=lambda x: (len(x), x))[:8]) + ('…' if len(zero) > 8 else ''))
        if wl_all - scope:
            print(f'   （白名单里有 {len(wl_all - scope)} 个 gym 既没勾选也没被 rankland 标 —— 没进范围）')
    return labels


def main(argv):
    ap = argparse.ArgumentParser(description='CF gym 提交 → crate 片段（只出 R）')
    ap.add_argument('slug', nargs='?')
    ap.add_argument('-o', '--output', default='')
    ap.add_argument('--file', default='', help='提交 JSON（默认用清单里写的；没有就联网抓）')
    ap.add_argument('--gym', default='', help='CF gym 号（默认取清单里的）')
    ap.add_argument('--handle', default='', help='CF handle（默认取清单里的；可给多个用逗号分隔）')
    ap.add_argument('--handles', default='',
                    help='**多人**：逗号分隔的 handle 列表（比 --handle 更明确）')
    ap.add_argument('--team', action='store_true',
                    help='用 me.json 花名册里登记的所有 CF 账号（队友/多队）—— 与 --handles 二选一')
    ap.add_argument('--no-fetch', action='store_true', help='只用本地文件，不联网')
    ap.add_argument('--scope-report', action='store_true',
                    help='只算 gym 的抓取范围（显式 ∪ 我有提交）并写 cache/cf_gym_scope.json，不出片段')
    ap.add_argument('--gym-meta', action='store_true',
                    help='只刷新**全量 gym 元信息**（contest.list?gym=true：公开、一次调用）'
                         '→ cache/cf_gym_meta.json（id/赛名/开赛时间/时长/phase + 赛名分类），'
                         '不出片段 —— 这是"按分类筛范围、候选区吃全量"的数据源'
                         '（本地已有那份就直接用；要重抓再加 --refresh-gym-meta）')
    ap.add_argument('--refresh-gym-meta', action='store_true',
                    help='配 --gym-meta：强制重抓（默认直接用本地那份）')
    ap.add_argument('--manifest', default='')
    add_cli_args(ap, force_help='**强制重抓**：把本地那份提交 JSON / gym 元信息当成不存在 ⇒ 重新走 CF API'
                                '（与 `--no-fetch` 互斥；`--gym-meta` 那一步等于 `--refresh-gym-meta`）')
    args = ap.parse_args(argv)
    configure_from(args)
    # 两个开关互斥：一个说"只许本地"、一个说"忽略本地重抓" —— 与其猜人的意思，直接说清
    if args.force and args.no_fetch:
        print('❌ `--no-fetch` 与 `--force` 互斥：一个是"只用本地"，一个是"忽略本地重抓"', file=sys.stderr)
        return 2

    if args.scope_report:
        scope_report()
        print_stats('CF gym 范围')
        return 0

    if args.gym_meta:
        # ⚠️ 离线档**不许**联网：本地那份在就用它，不在就跳过（不是失败 —— 这一步只是"刷新元信息"）。
        #    离线判据走**环境变量**（`ACM_READ_OFFLINE`，`xcpc_pipeline.py --offline` 会给每个
        #    子适配器设上；见 `Scaper/lib/read_modes.py` 的 `OFFLINE_ENV`）。
        _off = str(os.environ.get('ACM_READ_OFFLINE') or '').strip().lower()
        if _off not in ('', '0', 'false') and not os.path.isfile(GYM_META):
            print(f'ℹ️ 离线且没有本地那份 {rel(GYM_META)} ⇒ 跳过（先联网跑一次 --gym-meta）')
            return 0
        meta = fetch_gym_meta(force=args.refresh_gym_meta or forced())
        n = len(meta.get('gyms') or {})
        cls = gym_meta_classes()
        xc = sum(1 for c in cls.values() if c.startswith(('cf/gyms/xcpc', 'cf/gyms/ucup')))
        est = sum(1 for m in (meta.get('gyms') or {}).values() if m.get('seasonEst'))
        dated = sum(1 for m in (meta.get('gyms') or {}).values() if m.get('start'))
        print(f'✅ 全量 gym 元信息：{n} 场（其中判得出 XCPC/UCup 的 {xc} 场）'
              f' → {rel(GYM_META)}')
        print(f'   赛季来源：CF 给了开赛时间的 {dated} 场；**推定**的 {est} 场'
              f'（赛名年份 / gym 号插值 / rankland —— 看每条的 `seasonFrom`）')
        print_stats('CF gym 元信息')
        return 0

    manifest = load_manifest(args.manifest)
    if not args.slug:
        print('要给一个 slug', file=sys.stderr)
        return 2
    contest = find_contest(manifest, args.slug)

    entry = next((s for s in (contest.get('submissions') or [])
                  if (s.get('source') or '') == 'cf'), None)
    # 手工指定了 gym（调试/一次性用）就不要求清单里有 cf 条目
    manual = bool(args.gym) and bool(args.handles or args.handle or args.team)
    if not entry and not manual:
        print(f'ℹ️ 清单里 {args.slug} 没有 cf 提交来源，跳过')
        return 0

    entry = entry or {}
    gym = _s(args.gym or entry.get('gym'))
    # handle 的来源（优先级从高到低）：
    #   ① --handles / --handle（命令行，逗号分隔也算多个）
    #   ② --team → me.json 花名册里所有 CF 账号
    #   ③ **默认**：花名册（`me.json` 的 `team`）→ 多个人就有多个 handle；
    #      没登记花名册时等价于单值（cf.handles → cf.handle → 清单里的）
    #   ④ 清单：本场条目 → `defaults.cfHandle`
    if args.handles:
        want = [h.strip() for h in args.handles.split(',') if h.strip()]
    elif args.handle:
        want = [h.strip() for h in args.handle.split(',') if h.strip()]
    else:
        want = cf_handles()
    if not want:
        one = _s(entry.get('handle') or (manifest.get('defaults') or {}).get('cfHandle'))
        want = [one] if one else []
    # 去重（手滑写两遍同一个 handle 是最常见的操作失误；重复取会白白多抓一份）
    seen_h: list[str] = []
    for h in want:
        if h not in seen_h:
            seen_h.append(h)
    want = seen_h
    if not want:
        print('ℹ️ 跳过：没有 CF handle（`me.json` 的 `cf.handle`／`team` 花名册，'
              '或本场清单条目的 `handle`／`defaults.cfHandle` 填一个即可）。\n'
              '   为什么必须给：**整场 gym 有一万多条提交**，全导进来会让树上挂满 R 节点；\n'
              '   这里只要目标账号的提交。想批量带队友：`me.json` 的 `team` 里登记 '
              '`cf` 字段，然后 `--team`（或默认就会带上）。')
        return 0
    if not gym:
        print('❌ 没有 gym 号（清单里写 gym，或 --gym）', file=sys.stderr)
        return 1

    # ---- 逐人取数（带缓存，**下过就不再下**）----
    all_records: list[dict] = []
    per_handle: dict[str, list[dict]] = {}
    for h in want:
        # 文件选哪（顺序要紧）：
        #   ① 显式 `--file`（只对单人合理）
        #   ② 清单里写的那个（**只对单人**；多人时它只属于清单写的那个 handle）
        #   ③ 按 handle 分文件 `cache/cf/<gym>_<handle>.json`（多人时各存各的）
        #   ④ 兼容约定 `cache/cf_<gym>_<handle>.json`（115 份历史缓存都在这，得认；
        #      但**只在单人时**用 —— 多人时按 handle 分文件，否则会把同一个文件
        #      读三遍、把队友的提交全算成第一个人的（实测踩到））
        multi = len(want) > 1
        p_path = os.path.join(CACHE, 'cf', f'{gym}_{h}.json')
        legacy = os.path.join(CACHE, f'cf_{gym}_{h}.json')
        one_path = ''
        if not multi:
            for cand in (resolve(_s(args.file)) if args.file else '',
                         resolve(_s(entry.get('file'))) if entry.get('file') else '',
                         legacy, p_path):
                if cand and os.path.isfile(cand):
                    one_path = cand
                    break
            one_path = one_path or p_path
        else:
            one_path = p_path
        if os.path.isfile(one_path) and not forced():      # `--force`：把本地那份当成不存在 ⇒ 走下面那条重抓
            got = read_json(one_path)
            if isinstance(got, dict):
                got = got.get('result') or []
            src = 'cache'
        elif args.no_fetch:
            print(f'❌ 没有本地文件：{one_path}（--no-fetch 不联网）', file=sys.stderr)
            return 1
        else:
            print(f'↓ Codeforces API: gym {gym}, handle {h}')
            got = fetch(gym, h)
            write_json(one_path, {'status': 'OK', 'result': got,
                                  'fetchedFrom': f'{API}?contestId={gym}&handle={h}'})
            src = 'api'
        per_handle[h] = got
        print(f'   {h:<28} {len(got):>4} 条（{src}）')
        all_records += got

    hit = pick(all_records, want)
    # 合并后按提交 ID 去重（同一份缓存被两个 handle 读到、或 API 有重叠页时会发生）
    uniq: list[dict] = []
    seen_ids: set[str] = set()
    for r in hit:
        sid = _s(r.get('id'))
        if sid and sid in seen_ids:
            continue
        seen_ids.add(sid)
        uniq.append(r)
    if len(uniq) != len(hit):
        print(f'   ℹ️ 合并时按提交 ID 去重：{len(hit)} → {len(uniq)} 条')
    hit = uniq
    print(f'📊 CF 提交 → {args.slug}   （gym {gym}，{len(want)} 个账号，'
          f'合并后 {len(hit)} 条属于目标账号）')
    if len(want) > 1:
        for h in want:
            n = len(pick(per_handle.get(h) or [], [h]))
            print(f'   {h:<28} {n:>4} 条')
    for r in hit[:8]:
        print(f"      #{r['id']}  {(r.get('problem') or {}).get('index')}  "
              f"{_s(r.get('verdict'))}  {to_cst(r.get('creationTimeSeconds'))}  "
              f"{person_of(r, want)}")
    if len(hit) > 8:
        print(f'      … 还有 {len(hit) - 8} 条')

    out = args.output or os.path.join(CACHE, f'crate_{args.slug}_cf.json')
    if not hit:
        # 「这个来源没有数据」是**正常结果**，不是失败：
        # 空包过不了校验（records 不能为空），所以干脆不产出片段；
        # 同时删掉可能残留的上一次片段，免得合并进上一次的数据。
        if os.path.isfile(out):
            os.remove(out)
        print('ℹ️ 0 条 → 不产出片段（合并时会跳过这个来源）')
        return 0

    crate, warns = build(args.slug, hit, gym, handles=want)
    crate.save(out)
    issues = validate_crate(crate.to_dict())
    soft = [i for i in issues if '父节点' in str(i)]
    hard = [i for i in issues if '父节点' not in str(i)]
    print(f'✅ {rel(out)}   {crate.summary()}')
    if soft:
        print(f'   ℹ️ {len(soft)} 条的父题目在**榜单片段**里（只出 R 的片段都这样）')
    for w in warns:
        print('   ⚠️', w)
    if hard:
        print(f'❌ 校验问题 {len(hard)}：')
        for it in hard:
            print('   •', it)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
