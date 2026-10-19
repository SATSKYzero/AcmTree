#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
Codeforces **正式比赛（≠ gym）** → crate 片段（**整棵树一个片段**）

口径（"import CF contest（≠ gym）"）：
gym 那棵是**白名单驱动、一场一片段**（`cf_adapter.py`）；正式比赛换个驱动方式 ——
**"我提交过哪些正式比赛"就是集合**，不用人去挑，也不用改清单。CF 的 `user.status`
是**公开 API、不要凭据**（只要 handle）。
⚠️ **花名册里登记过的 CF 账号逐个都要问**（`cf_adapter.cf_handles`）：范围是"谁的名单里有这场"，
少问一个人，他一个人打过的那些正式比赛就**整场不在树上**（`--handle a,b` 也可临时指定）。

数据来源（全部公开）：
    contest.list                    → 全部比赛（再拉一次 `gym=true` 做差集，分出正式/gym）
    user.status?handle=<h>          → 我的全部提交（分页）
    problemset.problems          → 全题池 `{contestId, index, name}`（题单靠它）
    ⚠️ **不要**用 `contest.standings` 取正式比赛信息 —— 实测它对非 gym 是 **admin-only**；
       场次名/时间 `contest.list` 已经给了。

树：`O ─(W)cf ─(S)cf contest ─(C)<contestId> ─(P)<index> ─(R)<提交 id>`
口径：**一场内有提交 ⇒ 收该场全部题目**；Div. 轮次把 **Div1+Div2 一起收**；
共用题（Div1/Div2 复用）**只挂老家那场**，我在两边的提交都挂到那个 P 上 ⇒ AC 不重复计。
（gym 那支挂在 `cf:s:cf-gym:<系列>[:<赛区>][:<年份>]` 下，两条互不影响；id 空间也不重叠 —— gym 都是六位数。）

读取层规矩见 `Scaper/lib/read_modes.py`：场次信息**比完就不变** ⇒ KEEP + `--force`；
比赛清单与我的提交是**活数据** ⇒ 就地默认 `CACHE_NONE`。
"""

from __future__ import annotations

import argparse
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, 'lib'))
sys.path.insert(0, os.path.abspath(os.path.join(HERE, '..', 'lib')))       # Scaper/lib

from cf_api import call                                                  # noqa: E402
from cf_adapter import VERDICT_MAP, cf_handles, submit_kind              # noqa: E402
from read_modes import (  # noqa: E402
    CACHE_NONE, Archive, add_cli_args, configure_from, offline, print_stats, require_local,
    retry_call, should_refetch,
)
from xcpc_common import (  # noqa: E402
    CACHE, REPO, add_crate_path, letter_sort, union_scope, cf_gym_key, cf_problem_key, cf_submission_key,
    aux_tree_key, contest_key, emit_problem_synths, empty_source_result, open_tree, read_json, rel,
    root_name_src, series_key, write_json, year_in_text, year_mid, year_series_key,
)
import cf_page_evidence as EVIDENCE                                       # noqa: E402

add_crate_path()

from crate import Crate, class_rules, link_kinds, nature_fields, to_cst, validate_crate              # noqa: E402

CF_PLATFORM = 'cf'
CF_PLATFORM_NAME = 'Codeforces'
CF_CONTEST_SERIES = 'cf:s:cf-contest'
CF_CONTEST_SERIES_NAME = 'CF contest'
#: 辅助树那棵的**渠道 id**（`xcpc_common.AUX_TREES` 的键 ⇒ W `aux-cf-contest`，名字 `Codeforces`）
CF_CONTEST_SID = 'cf-contest'
LABEL = 'Codeforces 正式比赛'
DIR = os.path.join(CACHE, 'cf_contest')
PAGES_DIR = os.path.join(DIR, 'pages')
ARCHIVE = Archive(PAGES_DIR)
BROWSER_UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
              '(KHTML, like Gecko) Chrome/126.0 Safari/537.36')
_PAGE_OK = None            # CF 比赛页能不能抓（实测现在 404/反爬 ⇒ 探一次就够，别打 400 个请求）


def _handles(explicit: str) -> list[str]:
    """
    要抓的 CF handle **列表**：参数（`--handle a,b`）> 环境变量 > `cf.handles` >
    花名册 `team[].cf` > 单个 `cf.handle`。读取实现**只有 `cf_adapter.cf_handles` 一份**。

    ⚠️ **一个都不许少**：这条路的范围是"**谁的 `user.status` 里有这场**就收这场"，
       少一个人 ⇒ 队友一个人打过的那些正式比赛**整场都不在树上**（连 C 都不建）。
       实测（2026-10-15）：只取第一个 ⇒ someone 4434 条有、队友 teammate_a **0 条**正式比赛
       （同一个人的 gym 有 252 条 ⇒ 不是没数据，是这条路没问他）。
    """
    return cf_handles(explicit)


def contest_list() -> dict:
    """
    全部比赛 + gym 的 id 集合（**活数据**：每周都有新比赛）⇒ 默认每次都联网。

    返回 `{'all': {id: {name, start, duration, phase}}, 'gyms': [id, …]}`
    """
    path = os.path.join(DIR, 'list.json')
    if not should_refetch(os.path.isfile(path), CACHE_NONE):
        # 离线（`--offline`）时 `should_refetch` 一律 False ⇒ 这里就是"只用本地"那条路：
        # 本地没有这份清单的话**当场报错**（约 26s 的一次抓取，别静默出缺数据的包）。
        require_local(path, 'CF contest.list 清单')
        return read_json(path)
    os.makedirs(DIR, exist_ok=True)
    try:
        # ⚠️ `retries=0`：`cf_api.call` 自己就有 `retries=3` 的内部重试，再套 `retry_call` 会变成
        #    4×3 次乘法；让 `retry_call` 当**唯一**重试权威（`--retry-mode once` 也才管得住它）。
        alls = retry_call(call, 'contest.list', retries=0, what='CF contest.list')
        gyms = retry_call(call, 'contest.list', {'gym': 'true'}, retries=0, what='CF contest.list(gym)')
    except Exception as e:  # noqa: BLE001
        # 活数据本该每次联网，但 CF 抽风（实测整段 404）时**用缓存重建**，
        # 否则这一轮什么都出不来；警告说清"这份是用缓存算的"。
        if os.path.isfile(path):
            print(f'⚠️ CF contest.list 抓不到（{type(e).__name__}: {str(e)[:60]}）'
                  f'—— 用缓存 {rel(path)} 重建')
            return read_json(path)
        raise
    data = {
        'all': {str(c['id']): {'name': c.get('name') or '',
                               'start': c.get('startTimeSeconds'),
                               'duration': c.get('durationSeconds'),
                               'phase': c.get('phase') or ''} for c in alls},
        'gyms': sorted(str(c['id']) for c in gyms),
    }
    write_json(path, data)
    print(f'↓ {rel(path)}：{len(data["all"])} 场比赛（其中 gym {len(data["gyms"])}）')
    return data


def my_submissions(handle: str) -> list:
    """我的全部提交（**活数据**）⇒ 默认每次都联网；分页拿完"""
    path = os.path.join(DIR, f'history_{handle}.json')
    if not should_refetch(os.path.isfile(path), CACHE_NONE):
        return read_json(path).get('rows') or []
    os.makedirs(DIR, exist_ok=True)
    rows, start, page = [], 1, 5000
    while True:
        try:
            got = retry_call(call, 'user.status',
                         {'handle': handle, 'from': start, 'count': page}, retries=0,
                             what=f'CF user.status({handle}) 第 {start} 条起')
        except Exception as e:  # noqa: BLE001
            if os.path.isfile(path) and not rows:
                print(f'⚠️ CF user.status 抓不到（{type(e).__name__}: {str(e)[:60]}）'
                      f'—— 用缓存 {rel(path)} 重建')
                return read_json(path).get('rows') or []
            raise
        rows.extend(got)
        if len(got) < page:
            break
        start += page
    write_json(path, {'handle': handle, 'rows': rows})
    print(f'↓ {rel(path)}：{len(rows)} 条提交')
    return rows


def _fetch_html(url: str, cookie: str = '') -> str:
    """取 CF 的公开 HTML（带浏览器 UA；默认 UA 会被挡）。"""
    req = urllib.request.Request(url, headers={
        'User-Agent': BROWSER_UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'})
    with urllib.request.urlopen(req, timeout=25) as r:
        return r.read().decode('utf-8', 'replace')


# ---- CF 自己的分类（**严格按 CF 的字段，不看赛名**）----
#
# CF 的「Past contests filter」有个 `filterTypes` 选择框，服务端按它筛 —— 那就是 CF 自己的
# 分类字段（14 个 token：div1/div2/div3/div4/div1div2/educational/ton/global/kotlin/vkcup/
# long/april/team/icpc）。取值的办法：`/contests/page/<n>?filterTypes=<token>` 逐页抓，
# 把"哪些场次属于哪个 token"抄成一张表（缓存在 `cache/cf_contest/types.json`）。
#
# ⚠️ **归类规则**：
#   · `div1~4` / `div1+2` / `edu` 是**rated 比赛的全分类**；
#   · 不在其中 ⇒ 一定 unrated（⚠️ rated 场有时因事故变 unr，所以**完全不看是否 rated**）；
#   · unrated 的**先套一层 `others`**：`team` > `april` > `kotlin` > `无归类`（按这个优先级取第一个命中）；
#   · `icpc` 这个 token **不准** ⇒ 忽略；`mirror` 同样忽略。
CF_TYPE_TOKENS = ('div1', 'div2', 'div3', 'div4', 'div1div2', 'educational',
                  'team', 'april', 'kotlin')
#: 有类型的 token → 分类路径；顺序 = 命中多个时的优先级（先"年长"的合办场，再单一 Div）
#: ⚠️ "cf/div1 等（除了 gyms）改为 cf/contest/div1"：正式轮次**收进一层
#:    `contest`** —— 这样 `cf/contest/*` 与 `cf/gyms` 一眼分得开（gym 不是 cf contest，
#:    见 `cf_board_adapter` 的注释）。**`cf/gyms` 一个字不动。**
CF_PREFIX = 'cf/contest'
CF_RATED_ORDER = (('div1div2', f'{CF_PREFIX}/div1+2'), ('div1', f'{CF_PREFIX}/div1'),
                  ('div2', f'{CF_PREFIX}/div2'), ('div3', f'{CF_PREFIX}/div3'),
                  ('div4', f'{CF_PREFIX}/div4'), ('educational', f'{CF_PREFIX}/edu'))
CF_OTHER_ORDER = (('team', f'{CF_PREFIX}/others/team'), ('april', f'{CF_PREFIX}/others/april'),
                  ('kotlin', f'{CF_PREFIX}/others/kotlin'))


def classify_cf(tokens) -> str:
    """
    一组 CF 类型 token → 分类路径（**唯一判据**，纯函数；规则见上面那段注释）。
    """
    toks = {str(t) for t in (tokens or ())}
    for tok, cls in CF_RATED_ORDER:
        if tok in toks:
            return cls
    for tok, cls in CF_OTHER_ORDER:
        if tok in toks:
            return cls
    return f'{CF_PREFIX}/others/无归类'


def fetch_types(refresh: bool = False) -> dict:
    """
    抓 CF 的 `filterTypes` 归类表 → `{cid: [token, …]}`（缓存在 `cache/cf_contest/types.json`）。

    为什么要缓存：默认全链路**离线**跑；这张表变动很慢，抓一次能用很久。
    `refresh=True`（或缓存不存在）时才联网：每个 token 逐页抓（`/contests/page/<n>?filterTypes=`），
    页数按"这一页没新 id"判停。
    """
    path = os.path.join(DIR, 'types.json')
    if not refresh and os.path.isfile(path):
        return read_json(path).get('types') or {}
    types: dict = {}
    total_pages = 0
    for tok in CF_TYPE_TOKENS:
        page = 1
        # ⚠️ **每个 token 一个 `seen`**：判"这页没有新 id"不能用 `ids - set(types)` ——
        #    `types` 是**跨 token 累积**的 ⇒ 第二个 token 起，只要这页的
        #    id 在前面某个 token 里出现过就算"没有新 id"，于是 `page > 2` 时提前收工、后面的页
        #    再也不翻（实测：div2 到第 2 页就停，第 3 页的 4/5/6 一个标签都没拿到）。
        seen: set = set()
        while True:
            url = (f'https://codeforces.com/contests/page/{page}?filterTypes={tok}'
                   if page > 1 else f'https://codeforces.com/contests?filterTypes={tok}&complete=true')
            try:
                html = _fetch_html(url)
            except Exception as exc:                       # noqa: BLE001 —— 抓不动就停这个 token
                print(f'   ⚠️ filterTypes={tok} 第 {page} 页抓不动（{type(exc).__name__}）—— 这个 token 到此为止')
                break
            ids = {int(x) for x in re.findall(r'href="/contest(?:s)?/(\d+)"', html)}
            fresh = ids - seen
            seen |= ids
            for cid in ids:
                types.setdefault(cid, [])
                if tok not in types[cid]:
                    types[cid].append(tok)
            total_pages += 1
            if not ids or page >= 40:
                break
            page += 1
            if not fresh and page > 2:
                break
    write_json(path, {'fetchedAt': datetime.now(timezone.utc).isoformat(), 'types': types})
    print(f'↓ {rel(path)}：{len(types)} 场（{total_pages} 页 / {len(CF_TYPE_TOKENS)} 个 token）')
    return types


def contest_page_problems(cid: str) -> dict:
    """
    试抓 `/contest/<cid>` 页面拿**该场完整题单** → `{题号: 题名}`；抓不到返回 `{}`。

    为什么要试（"cf contest 的题目还是没爬满"）：`problemset.problems`
    **只列一颗题的"老家"那场**，所以 Div2 场里那些共用题在它自己名下是空的。官方题表页
    本是权威来源，但实测 CF 对匿名抓取**常常 404/反爬** —— 所以探一次就够：抓到就补全，
    抓不到就退回现状并**明确警告**（缺口明细写 `incomplete.json`，见 build）。
    """
    global _PAGE_OK
    if _PAGE_OK is False:
        return {}
    # 离线（`--offline`）时本地没有这一页 = "这一场这次拿不到"，**不是**"CF 的页面抓不动"——
    # ⚠️ 别让它把探测结论钉成 False：一个**没归档过的场次**夹在前面，会让后面**归档里明明有**的
    #    那几百场也一起跳过。实测（2026-10-15）：范围扩到 4 个账号后 `need_c` 里多了队友打过、
    #    本机没抓过的场次 ⇒ 题单从 2047 道掉到 50 道（R 一条没少，所以只看提交数是看不出来的）。
    #    这一页只是**锦上添花**（没它还有 problemset 题池 + `incomplete.json` 兜底）⇒ 不是
    #    `require_local` 那种"必须在本地"的读取点。
    if offline() and not ARCHIVE.has(cid, 'contest'):
        return {}
    html = ARCHIVE.page(key=cid, kind='contest',
                        url=f'https://codeforces.com/contest/{cid}',
                        fetch=_fetch_html, accept=lambda h: '/problem/' in h,
                        verbose=False, label=f'cf contest/{cid}')
    if not html:
        if _PAGE_OK is None:
            print('⚠️ CF 比赛页抓不动（404/反爬）—— 题单只能靠 problemset，缺口见 incomplete.json')
        _PAGE_OK = False
        return {}
    _PAGE_OK = True
    out: dict = {}
    # 实测结构：题表**一个大 `<tr>` 里每 4 个 td 一组**：
    #   td[0] `<a href="/contest/<cid>/problem/A">A</a>` —— 文本**只是题号**
    #   td[1] `<a href="/contest/<cid>/problem/A">K Is Important</a>` —— 同一个 href、文本才是**题名**
    #   td[2] submit、td[3] status
    # ⇒ 同一个 href 出现两次；**文本等于题号的那次不是名字**。
    pat = r'href="/contest/%s/problem/([A-Za-z0-9]+)"[^>]*>(.*?)</a>' % re.escape(cid)
    for m in re.finditer(pat, html, re.S):
        idx = m.group(1)
        text = re.sub(r'\s+', ' ', re.sub('<[^>]+>', '', m.group(2))).strip()
        if text and text != idx:
            out[idx] = text                  # 名字锚
        else:
            out.setdefault(idx, '')          # 题号锚：占位，稍后由名字锚覆盖
    return out


def problemset() -> dict:
    """
    全题池 → `{比赛号: {题号: {'name', 'rating'}}}`。体积大、变化慢 ⇒ **KEEP**（`--force` 重抓）。

    `rating` 就是**题目自带的 CF 难度**（"cf contest 的题目通常有自带的 cf 难度"）——
    顺手写进 P 的 `cfDifficulty`，零额外请求。
    """
    path = os.path.join(DIR, 'problems.json')
    if not should_refetch(os.path.isfile(path)):
        data = read_json(path)
        if data:
            return data
    os.makedirs(DIR, exist_ok=True)
    got = retry_call(call, 'problemset.problems', retries=0, what='CF problemset.problems')
    out: dict = {}
    for p in (got or {}).get('problems') or []:
        cid, idx = str(p.get('contestId') or ''), str(p.get('index') or '')
        if cid and idx:
            out.setdefault(cid, {})[idx] = {'name': p.get('name') or '',
                                            'rating': p.get('rating')}
    write_json(path, out)
    print(f'↓ {rel(path)}：{len(out)} 场比赛的题单')
    return out


def build(handles: list[str], max_contests: int = 0, verbose: bool = True) -> tuple[Crate, list[str]]:
    crate = Crate(source_id='cf-contest', label=LABEL, platform=CF_PLATFORM)
    warns: list[str] = []
    listing = contest_list()
    gyms = set(listing.get('gyms') or [])
    want = {h for h in (handles or []) if h}
    # ---- 逐人取提交（**按 handle 逐个查** `user.status`）----
    # 范围 = 这些人的并集；归属由"这条提交是从谁的名单里拿到的"决定（抓的时候就知道，
    # 不用猜）—— 同一条提交出现在两个人的名单里时（CF 的队员提交两边都查得到），
    # 只留**名单里靠前**的那个账号：与 `cf_adapter.person_of` 同一个口径。
    rows: list = []
    who: dict[str, str] = {}                          # 提交 id ⇒ 它的账号
    for h in (handles or []):
        got = my_submissions(h)
        if verbose:
            print(f'👤 {h}：{len(got)} 条提交')
        for r in got:
            sid = str(r.get('id') or '')
            if sid and sid in who:
                continue
            rows.append(r)
            if sid:
                who[sid] = h
    mine: dict[str, list] = {}
    gym_cids: set[str] = set()                        # 被排除的 gym 场次（只为那行日志数得对）
    for r in rows:
        cid = str((r.get('problem') or {}).get('contestId') or r.get('contestId') or '')
        if not cid:
            continue
        if cid in gyms:                               # gym 归 cf_adapter 管
            gym_cids.add(cid)
            continue
        members = [m.get('handle') for m in (r.get('author') or {}).get('members') or []]
        if members and not (set(members) & want):     # API 已按 handle 过滤，这里兜底
            continue
        mine.setdefault(cid, []).append(r)
    picked = sorted(mine, key=lambda c: (listing['all'].get(c, {}).get('start') or 0), reverse=True)
    if max_contests:
        picked = picked[:max_contests]
    if verbose:
        # ⚠️ 计数用 `gym_cids`，不要用 `len(mine)` —— `mine` **只装正式比赛**
        #    （gym 在上面就 `continue` 了）⇒ 那个数会把"正式比赛场数"误印成"gym 已排除"。
        print(f'👤 {len(want)} 个账号：正式比赛 {len(picked)} 场要出'
              f'（gym {len(gym_cids)} 场已排除，共 {len(rows)} 条提交）')

    pool = problemset()                      # {场次号: {题号: 题名}}（共用题**只挂老家那场**）
    _merge_page_difficulty(pool)             # 页面证据补进题池（**只补空位**，API 的 rating 是权威）

    # ---- 同轮 Div1 + Div2 一起收（"同一轮的 Div1+Div2 一起收进来"）----
    # 我在这一轮的任何一场有提交 ⇒ 这一轮的**两场**都出（各出 C + 各自 P + 我的 R）；
    # 共用题仍只挂老家那场（见下面的 home_of），不造重复 P。
    # 判"同一轮"用**客观信号**：`contest.list` 的 `startTimeSeconds` 相同 + 赛名去掉 "(Div. N)" 后相同。
    def round_key(cid: str) -> tuple:
        meta = listing['all'].get(cid) or {}
        base = (meta.get('name') or '').split('(Div.')[0].strip()
        return (meta.get('start') or 0, base)

    by_round: dict = {}
    for cid, meta in listing['all'].items():
        if cid in gyms or 'Div.' not in (meta.get('name') or ''):
            continue
        by_round.setdefault(round_key(cid), []).append(cid)
    mates: dict = {}
    for cid in picked:
        for other in by_round.get(round_key(cid), []):
            if other != cid:
                mates.setdefault(cid, []).append(other)
    if verbose and mates:
        print(f'   同轮一起收：{len(mates)} 场有 Div. 伙伴（各多收 1 场，共 '
              f'{sum(len(v) for v in mates.values())} 场）')
    crate.platform(CF_PLATFORM, name=CF_PLATFORM_NAME, **root_name_src(crate))
    crate.series(CF_PLATFORM, CF_CONTEST_SERIES, name=CF_CONTEST_SERIES_NAME,
                 **link_kinds(('browse', 'https://codeforces.com/contests')))

    # ---- 复用（Div1/Div2 会复用若干题，要用合适的方式拿到复用情况）----
    # CF 只给两条**官方**信号，都不用猜：
    #   ① `problemset.problems` 里共用题**只列在老家那场**（实测 Div.2 那场只剩自己独有的题）；
    #   ② 每条提交的 `problem` 带该题**官方题名**（两场里是同一个字符串）。
    # ⇒ "老家" = 题池里拥有这个名字的那场；**P 的 key 定在老家**，我在别场对同一题的提交
    #   也挂到那个 P 上 ⇒ 同一道题只有一个 P、AC 不会重复计。
    # （试过抓 `/contest/<cid>/problems` 页面拿 href —— 实测返回的不是题目页，抓不动。）
    # ⚠️ 题名只在**同一轮**（同开赛时刻）里当键 —— 不同轮次出现同名题是常事
    #    （"Yet Another …" 到处都是），全局查名会把提交挂到别的轮次去。
    round_of = {c: (listing['all'].get(c, {}).get('start') or 0) for c in listing['all']}
    # 题池没给 rating 时的兜底：**我的提交里自带 `problem.rating`**（CF 官方难度分）。
    # 为什么要兜底：`problems.json` 缓存可能是老形状（值是名字串），且 CF API 抽风时补不了。
    sub_rating: dict = {}
    for r in rows:
        pr = r.get('problem') or {}
        if pr.get('rating'):
            sub_rating.setdefault((str(pr.get('contestId') or ''), str(pr.get('index') or '')),
                                  pr.get('rating'))

    _building_names = [False]            # 建 by_name 时不走"老家兜底"，免得自己查自己

    def pinfo(cid: str, idx: str, fb_name: str = '', fb_rating=None) -> tuple:
        """
        题池里这题的 (题名, 难度分)；题池里没有就用兜底（兼容老的扁平形状）。

        ⚠️ 难度**不一定有、出现时间也乱序**：缺就是缺 ——
        **不写空串、不把"这题没难度"当结论缓存**，只在真有值时写 `cfDifficulty`，下次 `--force` 自然再试。
        """
        if fb_rating is None:
            fb_rating = sub_rating.get((cid, idx))
        name, rating = fb_name, fb_rating
        got = (pool.get(cid) or {}).get(idx)
        if isinstance(got, dict):
            name = got.get('name') or fb_name
            rating = got.get('rating') or fb_rating
        elif isinstance(got, str):
            name = got or fb_name
        # 共用题：`problemset` 只把 rating 写在**老家那条条目**上（"d2 C~F 缺难度" 就是这个）
        # 判据与 `home_of`/`reuse` **完全同一套**（同轮 + 同名），不另立一套。
        if not rating and not _building_names[0]:
            hcid, hidx = home_of(cid, idx, name)
            if (hcid, hidx) != (cid, idx):
                hgot = (pool.get(hcid) or {}).get(hidx)
                if isinstance(hgot, dict) and hgot.get('rating'):
                    rating = hgot['rating']
                if not rating:
                    rating = sub_rating.get((hcid, hidx))
        return (name, rating)

    by_name: dict = {}
    _building_names[0] = True
    try:
        for cid, probs in pool.items():
            rnd = round_of.get(cid) or 0
            for idx in probs:
                pname = pinfo(cid, idx)[0]
                if rnd and pname:
                    by_name.setdefault((rnd, pname), (cid, idx))
    finally:
        _building_names[0] = False

    def home_of(cid: str, idx: str, pname: str) -> tuple:
        hit = by_name.get((round_of.get(cid) or 0, pname))
        return hit if (hit and hit[1]) else (cid, idx)

    # 抓取范围 = **显式（同轮伙伴场）∪ 我有提交的**（通用件 `Scaper/lib/scope.py`）
    scope_contests = union_scope(explicit={o for v in mates.values() for o in v},
                                 mine=set(picked), name=f'CF 正式比赛（{", ".join(handles or [])}）')
    need_c: set = set(scope_contests)
    pnodes: dict = {}
    reuse: dict = {}
    for cid in picked:
        for r in mine[cid]:
            p = r.get('problem') or {}
            idx, pname = str(p.get('index') or ''), p.get('name') or ''
            if not idx:
                warns.append(f'{cid}: 有一条提交没有题号（{r.get("id")}）')
                continue
            hcid, hidx = home_of(cid, idx, pname)
            need_c.add(hcid)
            pnodes[(hcid, hidx)] = pinfo(hcid, hidx, pname, p.get('rating'))

    emitted: set = set()

    def emit_p(cid: str, idx: str, pname: str, rating) -> None:
        extra = {'cfDifficulty': str(rating)} if rating else {}
        crate.problem(cf_gym_key(cid), cf_problem_key(cid, idx),
                      name=pname, problem_id=idx,
                      link=f'https://codeforces.com/contest/{cid}/problem/{idx}', **extra)
        emitted.add((cid, idx))

    # 先**收集**全部 P，最后统一产出 —— 产出的顺序必须是**官方题号序**，而不是"提交顺序"。
    # ⚠️ 只有 F 有提交时 F 会被排到最前，那就是按提交顺序产出的后果。
    allp: dict = {}

    def collect_p(cid: str, idx: str, pname: str, rating) -> None:
        prev = allp.get((cid, idx))
        if prev:
            allp[(cid, idx)] = (prev[0] or pname, prev[1] or rating)
        else:
            allp[(cid, idx)] = (pname, rating)

    for (hcid, hidx), (pname, rating) in pnodes.items():
        collect_p(hcid, hidx, pname, rating)
    for cid in picked:                    # 同轮伙伴那场"自己的"题（共用题两边各留一份，见 reuse）
        for m in mates.get(cid, []):
            for idx in (pool.get(m) or {}):
                pname, rating = pinfo(m, idx)
                collect_p(m, idx, pname, rating)
    # 官方比赛页抓得到就用它（权威、含 problemset 里没有的题）；抓不到上面已警告一次
    pagen = 0
    for cid in sorted(need_c):
        for idx, pname in contest_page_problems(cid).items():
            before = len(allp)
            collect_p(cid, idx, pname, pinfo(cid, idx, pname)[1])
            if len(allp) > before:
                pagen += 1
    if pagen:
        print(f'   CF 比赛页补了 {pagen} 道题（problemset 里没有的）')

    # ---- ★ 复用题的对应关系：**按整份题单算**（"发现 Codeforces Round 1079
    #      (Div. 1) 的合成节点数不够（发现 cf contest 的合成节点数不够）"）----
    # 判据本身（**同一轮 + 同题名**）不变，只是**跑的对象**从"本账号提交过的那几题"换成
    # 了"**这两场的整份题单**"：只遍历 `mine[cid]` 会让没做过的那些共用题没有 reuse
    # 记录、也就没有合成节点。实测 Round 1079（Div1 2196 / Div2 2197）有 **5 道**同名共用题
    # （A↔C、B↔D、C1↔E1、C2↔E2、D↔F），只看提交则只出 **1 个**合成节点（只有本账号做过的那对 C2/E2）。
    # ⚠️ 必须放在 `allp` 收齐之后、**产出 P / 出 C 之前**：老家那场要先进 `need_c`
    #    （否则它的 C 不会产出，合成节点就挂在一个不存在的父上）。
    # ⚠️ 遍历**快照**（`list(...)`）：下面会给新老家的题调 `collect_p()`，那是往 `allp` 里加键
    #    —— 直接遍历 `allp.items()` 会 `RuntimeError: dictionary changed size during iteration`
    #    （直接遍历会这么炸：包都产不出来）。
    for (cid, idx), (pname, _rating) in list(allp.items()):
        if not pname:
            continue
        hcid, hidx = home_of(cid, idx, pname)
        if (hcid, hidx) == (cid, idx):
            continue
        # ⚠️ 老家必须**在 CF 的比赛列表里**（有 meta 才有名字/时间/类型可写）。不在就**不建这一组**
        #    并**记一条警告** —— 不能"只给名字、别崩"：那会建出一个 nature 全空的占位 C
        #    （原则："只从'我的提交'里建的东西只有**比赛列表补充**和**提交**；
        #      若有任何不符必须注意" ⇒ 这里正是一种"不符"，必须**报出来**而不是编一个节点）。
        if hcid not in listing['all']:
            warns.append(f'复用题的老家 {hcid}（{cid}:{idx}「{pname}」）不在 CF 的比赛列表里 ⇒ '
                         f'这一组不建合成节点')
            continue
        if f'{cid}:{idx}' not in reuse:
            reuse[f'{cid}:{idx}'] = f'{hcid}:{hidx}'
        if hcid not in need_c:
            # 老家的题单也要收（整份题单：题池 + 比赛页），否则那场的 P 不全、合成节点会悬空
            for hidx2 in (pool.get(hcid) or {}):
                hpname, hrating = pinfo(hcid, hidx2)
                collect_p(hcid, hidx2, hpname, hrating)
            for hidx2, hpname in contest_page_problems(hcid).items():
                collect_p(hcid, hidx2, hpname, pinfo(hcid, hidx2, hpname)[1])
        need_c.add(hcid)

    # CF 自己的分类（`filterTypes` 那张表）—— 严格按字段，**不看赛名**
    types = fetch_types(refresh=bool(os.environ.get('CF_REFRESH_TYPES')))
    untyped = 0
    year_series: set = set()     # 年份层（`cf:s:cf-contest:<年>`）只建一次
    mirror: dict = {}            # 逐场 C 的 kwargs ⇒ 辅助树那份镜像**照抄**（两处不会漂）

    for cid in sorted(need_c, key=lambda c: (listing['all'].get(c, {}).get('start') or 0), reverse=True):
        meta = listing['all'].get(cid) or {}
        name = meta.get('name') or f'CF contest {cid}'
        start = meta.get('start')
        ctime = to_cst(start) if start else ''
        # 性质：分类 = **CF 自己的 `filterTypes` 类型**
        # （`divid1`…/`educational` 是 rated 的全分类；不在其中 ⇒ unrated，先套 `others`，
        #  再按 team > april > kotlin 优先取一个，都没有就 `others/无归类`；`icpc` 不准、忽略）。
        cls = classify_cf(types.get(str(cid)) or types.get(cid) or [])
        if not types.get(str(cid)) and not types.get(cid):
            untyped += 1
        # **年份层**（"两处的 cf-contest 再套一层比赛时间所在的年份"）：
        #   `cf:s:cf-contest` → `cf:s:cf-contest:<年份>` → C。取不到年份落 `年份未知`（别静默丢）。
        ykey = year_series_key(CF_CONTEST_SERIES, year_in_text(ctime))
        if ykey not in year_series:
            year_series.add(ykey)
            crate.series(CF_CONTEST_SERIES, ykey, name=year_mid(year_in_text(ctime)))
        # 地区写 `无`（都是线上赛）；年份取 CF 官方开赛时间里的 20xx（epoch，硬数据）；
        # **赛季写 `无`**（"cf/atc 的赛季直接填无"）——
        # CF 的一场轮次没有"赛季"这个概念（不跨年、也不按赛季编号）⇒ 这是"不适用"，不是"还没判"。
        kwargs = dict(
            name=name,
            contestTime=ctime or None,
            **nature_fields(('natureClass', cls),
                            ('natureYear', year_in_text(ctime)),
                            ('natureSeason', '无'),
                            ('natureRegion', '无')),
            # 分类依据（元列 `分类依据`）：**CF 自己的 `filterTypes` 表**（A 权威）——
            # 这是全库最硬的一档：不是看赛名猜的，是 CF 官方给的类型。
            # （`filterTypes` 里没有这一场 ⇒ `others/无归类`，来源仍是同一张表。）
            **class_rules(('natureClass', 'cf-contest:filterTypes'),
                          ('natureYear', 'cf-contest:year-time' if year_in_text(ctime)
                           else 'cf-contest:year-none'),
                          ('natureSeason', 'cf-contest:season-none'),
                          ('natureRegion', 'cf-contest:region-none')),
            **link_kinds(('problems', f'https://codeforces.com/contest/{cid}'),
                         ('board', f'https://codeforces.com/contest/{cid}/standings')))
        crate.contest(ykey, cf_gym_key(cid), **kwargs)
        # 辅助树那份 C **照抄**（同一份 kwargs ⇒ 名字/性质/链接不会两处漂）
        mirror[cid] = kwargs
    if untyped:
        warns.append(f'{untyped} 场在 CF 的 filterTypes 表里没有记录（一律记 cf/contest/others/无归类）')

    # 统一产出：场次顺序照 C 的产出顺序（开赛时间倒序），场内按**官方题号**排
    for cid in sorted(need_c, key=lambda c: (listing['all'].get(c, {}).get('start') or 0), reverse=True):
        for idx in sorted([i for (c, i) in allp if c == cid], key=letter_sort):
            pname, rating = allp[(cid, idx)]
            emit_p(cid, idx, pname, rating)

    for cid in picked:
        meta = listing['all'].get(cid) or {}
        start, dur = meta.get('start'), int(meta.get('duration') or 0)
        window = (start, (start + dur) if (start and dur) else None)
        for r in mine[cid]:
            p = r.get('problem') or {}
            idx, pname = str(p.get('index') or ''), p.get('name') or ''
            if not idx:
                continue
            sid = r.get('id')
            # 账户线索 = **这条提交是从谁的 `user.status` 里拿到的**（逐人抓 ⇒ 抓的时候就
            # 知道，不用按花名册顺序猜；gym 那条路没有这个信息才用 `cf_adapter.person_of` 兜底）。
            # 取不到就**不带这个键**（宁可不给，也不给个错的 —— 空串会让它匹配到别的账号）。
            who_h = who.get(str(sid), '')
            # P 挂到「实际参赛那场」名下（不再把 P 合并到老家）：
            # 两边现在都能拿到官方题号，各自留一份；同一道题会有两个 P，
            # 对应关系记在 reuse.json，供判重 / AC 统计用。缺了就当场补一条，别让 R 悬空。
            if (cid, idx) not in emitted:
                emit_p(cid, idx, pname, pinfo(cid, idx, pname)[1])
            crate.submission(
                cf_problem_key(cid, idx), cf_submission_key(cid, sid),
                status=VERDICT_MAP.get(str(r.get('verdict') or ''), '-'),
                time=to_cst(r.get('creationTimeSeconds')),
                link=f'https://codeforces.com/contest/{cid}/submission/{sid}',
                language=r.get('programmingLanguage') or None,
                timeUsed=(str(r.get('timeConsumedMillis'))
                          if r.get('timeConsumedMillis') is not None else None),
                memoryUsed=(str(r.get('memoryConsumedBytes'))
                            if r.get('memoryConsumedBytes') is not None else None),
                submitKind=submit_kind(r, window),
                **({'账户线索': {'source': 'cf', 'field': 'handle', 'value': who_h}} if who_h else {}),
            )
    # ---- 题单体检：有提交、这场名下却没有对应 P 的题 ----
    incomplete: dict = {}
    for cid in sorted(need_c):
        have = {idx for (c, idx) in emitted if c == cid}
        miss = []
        for r in (mine.get(cid) or []):
            pr = r.get('problem') or {}
            idx = str(pr.get('index') or '')
            if not idx or idx in have:
                continue
            hcid, hidx = home_of(cid, idx, pr.get('name') or '')
            miss.append({'index': idx,
                         'problemId': f'{hcid}:{hidx}',
                         'why': ('共用题（老家在 %s:%s）' % (hcid, hidx))
                                if (hcid, hidx) != (cid, idx) else '这场没有这条 P'})
        if miss:
            incomplete[cid] = miss
    if incomplete:
        write_json(os.path.join(DIR, 'incomplete.json'), incomplete)
        n_items = sum(len(v) for v in incomplete.values())
        print(f'⚠️ {len(incomplete)} 场题单不全（{n_items} 道题只有提交、没有 P 条目）'
              f'—— 明细 {rel(os.path.join(DIR, "incomplete.json"))}')
    elif os.path.isfile(os.path.join(DIR, 'incomplete.json')):
        os.remove(os.path.join(DIR, 'incomplete.json'))     # 这轮齐了 ⇒ 清掉上一次的明细
    if reuse:
        write_json(os.path.join(DIR, 'reuse.json'), reuse)
        print(f'复用：我在别场打的题里 {len(reuse)} 条是老家那场的题（{len(set(reuse.values()))} 道）'
              f'—— P 不再合并到老家（两边各留一份），这份对应关系留给判重 / AC 统计：'
              f'{rel(os.path.join(DIR, "reuse.json"))}')

    # ---- ★ 复用题的**合成节点 + 成员指针**（"cf/atc 你直接生成 ownerSynth
    #      和合成节点就行了"；"**比赛完全不用合成**" ⇒ 这里只合成**题**，不合成 cf 的比赛）----
    # 上面那些 reuse 的对应关系只是**一个 side 文件**，树上那两份 P 仍各是各的 ——
    # 合成节点把它们归成一组（判重/统计按组看），成员指针写在 `ownerSynth` 上。
    # ⚠️ 老家那份 P 不进 members（它不用给自己当成员）。
    by_home: dict = {}
    for copy_short, home_short in sorted(reuse.items()):
        by_home.setdefault(home_short, []).append(copy_short)
    groups = []
    for home_short, copies in sorted(by_home.items()):
        hcid, hidx = str(home_short).split(':', 1)
        hname = pinfo(hcid, hidx)[0]
        groups.append({
            'home': {'ext': cf_problem_key(hcid, hidx), 'parent': cf_gym_key(hcid),
                     'name': hname, 'problem_id': hidx},
            'members': [{'ext': cf_problem_key(*str(c).split(':', 1)),
                         'parent': cf_gym_key(str(c).split(':', 1)[0])} for c in copies],
        })
    # ---- ★ 合成节点落在**辅助节点 → aux-cf-contest**（"放辅助节点-cf-contest-…"；
    #      "两处的 cf-contest 再套一层比赛时间所在的年份"）----
    # 为什么不留在老家那场下面：合成节点是"跨场的代表"，挂在某一棵真比赛树里会让人以为
    # 那道题属于那一场（"**放在原位置其实不合适**"）⇒ 另起一棵辅助树，逐场镜像一个 C
    # （名字/性质/链接**照抄**上面那份 kwargs ⇒ 两处不会漂）。真比赛树那边的 C/P/R 一个都不动。
    parent_of = {}
    if groups:
        open_tree(crate, CF_CONTEST_SID)                 # W aux「辅助节点」+ W aux-cf-contest
        crate.series(aux_tree_key(CF_CONTEST_SID), series_key(CF_CONTEST_SID),
                     name=CF_CONTEST_SERIES_NAME,
                     **link_kinds(('browse', 'https://codeforces.com/contests')))
        mirror_years: set = set()
        mirror_c: set = set()        # ⚠️ 一场可能有多道复用题（1753 有 3 道）⇒ 镜像 C 只建一次
        for g in groups:
            hext = str((g.get('home') or {}).get('ext') or '')
            hcid = str((g.get('home') or {}).get('parent') or '').rsplit(':', 1)[-1]
            ckey = contest_key(hcid)
            parent_of[hext] = ckey
            if ckey in mirror_c:
                continue
            mirror_c.add(ckey)
            info = mirror.get(hcid) or {}
            if not info:
                # 上面那段"复用题对应关系"保证老家一定进过 `need_c`、也一定照过 `mirror`
                # ⇒ 走到这里说明有别的东西漏了 —— 如实报出来，**不编占位节点**
                # （"若有任何不符必须注意"）
                warns.append(f'⚠️ 复用题的老家 {hcid} 没有镜像 C（不该发生）⇒ 跳过这一组')
                continue
            ykey = year_series_key(series_key(CF_CONTEST_SID),
                                   year_in_text(info.get('contestTime') or ''))
            if ykey not in mirror_years:
                mirror_years.add(ykey)
                crate.series(series_key(CF_CONTEST_SID), ykey,
                             name=year_mid(year_in_text(info.get('contestTime') or '')))
            crate.contest(ykey, ckey, **info)
        if mirror_c:
            print(f'   合成节点改挂辅助树：aux-cf-contest（{len(mirror_c)} 场镜像 C / '
                  f'{len(mirror_years)} 个年份层）')
    made, pointed = emit_problem_synths(crate, groups, warns, parent_of)
    if made:
        print(f'   复用题：{made} 个合成节点 + {pointed} 条成员指针'
              f'（Div1/Div2 同轮共用题；比赛层**不**合成）')
    return crate, warns


#: 「**哪些场计分**」的逐场列表 —— **有现成的列表**。
#:
#: ⚠️ 别再自己找信号了：CF 官网「**Past contests filter**」里就有 **Rated: Yes / No** 这个筛选，
#:    查询参数是 `filterRated=yes|no`。翻几页就是整份列表（不计分的场很少）。
#:    **不要**走这几条路（都试过、都不成立，省得下次再走）：
#:      · `contest.list` **没有** rated 字段（键只有 durationSeconds/frozen/id/name/phase/
#:        relativeTimeSeconds/startTimeSeconds/type）；`type` 也不灵（CF 里 8 个无分老轮次、ICPC 里 22 个）；
#:      · `contest.ratingChanges` 只说明"有没有 rating 变化"—— 663/664/1345 **返回 0 条**
#:        可它们的题池里 A~E 明明有难度分（"**不能看逐题的 rating**"是另一回事）；
#:      · `types.json` 的 `april/team/kotlin` 标签不是干净判据（april 7 有分 / 7 无分，team 75/3）；
#:      · **赛名**里写 Unrated 的只是一部分（April Fools 就没写）⇒ 名字**不可当判据**。
RATED_LIST_JSON = os.path.join(DIR, 'rated_list.json')
RATED_LIST_PAGES = 6          # 不计分的场不多，翻几页就够；抓不全也不要紧（缺失的按"题池新旧"兜底）

#: 「题目**实际**有没有难度分」—— 按题页面查（参考：`https://codeforces.com/problemset`）。
#:
#: ⚠️ 两条判据别混（"**应不应该有就是按场次的 Rated: Yes/No 判的**"）：
#:   · **应该有** = 场次计不计分（上面那份 `rated_list.json`，判在 `scripts/material-needs.py`）；
#:   · **实际有** = 题目页面上写没写 `Difficulty`（本文件抓，三态判据在 `lib/cf_page_evidence.py`）。
#:   663 / 664 / 1345 在「Rated: No」里（**不应该有**），可 `api/problemset.problems` 对它们
#:   **不全**（663 只有 `A=1800`），而题目页面上写着 `Difficulty *2000` —— 那是**实际有**。
PAGE_DIFF_JSON = EVIDENCE.PAGE_DIFF_JSON
PAGE_DIFF_DELAY = 0.8         # CF 的页面，别打太快


def page_difficulty(path: str = '') -> dict:
    """题目页面的查询结果（转发给 `lib/cf_page_evidence.py`）"""
    return EVIDENCE.page_difficulty(path or PAGE_DIFF_JSON)


def page_rating(cid, idx, now: float = 0, path: str = '', neg_ttl=None):
    """这道题页面上**实际**有没有难度：三态 `has` / `none` / `unknown` —— 见 `lib/cf_page_evidence.py`"""
    return EVIDENCE.page_rating(cid, idx, now=now, path=path or PAGE_DIFF_JSON, neg_ttl=neg_ttl)


def _merge_page_difficulty(pool: dict) -> int:
    """
    把「按题查页面」的结果**并进题池** —— **复用共用件**（`lib/cf_page_evidence.merge_into_pool`）。

    口径（"**应不应该有就是按场次的 Rated: Yes/No 判的**"；这条只管"实际有"）：
      · **只补空位**：API 的 `rating` 是权威，**绝不覆盖**；
      · 池子里没有这道题时**补一条**；
      · **否定证据不并**（页面没写 ≠ 记一个空值）；旧形状（题池的值是**题名串**、
        或证据值直接是数字）由共用件兼容。

    ⚠️ **别在这里再写一份**：自己写会直接 `slot.get('rating')`，
    遇到旧形状的题池（`problems.json` 的值是题名串）会 `AttributeError` —— 而 `main()` 会把它
    当成"这次抓不到 CF API"、打印警告后 `return 0` **保留上一份片段**，真错因被改写成上游抽风。
    @returns 证据里**有值**的条数（打印/排查用）
    """
    known = page_difficulty()
    n = sum(1 for probs in (known or {}).values() for ev in (probs or {}).values()
            if ((ev or {}).get('rating') if isinstance(ev, dict) else ev))
    EVIDENCE.merge_into_pool(pool, PAGE_DIFF_JSON)
    return n


def fetch_page_difficulty(pairs: list, verbose: bool = True, recheck: bool = False,
                          neg_ttl_days=None) -> dict:
    """
    按题查页面 ⇒ 结果写进 `PAGE_DIFF_JSON`（"实际有"给值、"实际没有"留否定证据）。

    @param pairs - `[(cid, idx), …]`，**只查这些**（调用方已经从体检结果里挑出来了）
    @param recheck - `True` = **忽略已有结论**，全部重查（`--fill-difficulty --all` 的兜底档）
    @param neg_ttl_days - 否定证据的保质期（天）；0 = 用默认 30 天。0 天 = 每次都要重查
    """
    known = page_difficulty()
    ttl = None if neg_ttl_days is None else float(neg_ttl_days) * 86400
    # ⚠️ 默认**只查 `unknown`** —— `has` 与 `none` 都是已有结论（幂等；不然每次重建都重打一遍请求）。
    #    `recheck` 是给"兜底全部重爬"用的逃生门：**显式**要求时才忽略已有结论。
    if recheck:
        todo = [(str(c), str(i)) for c, i in pairs]
    else:
        todo = [(str(c), str(i)) for c, i in pairs
                if page_rating(c, i, neg_ttl=ttl)[0] == 'unknown']
    if verbose:
        why = '忽略已有结论、全部重查' if recheck else f'{len(pairs) - len(todo)} 道已有结论，不用查'
        print(f'🔎 按题查页面：要查 {len(todo)} 道（{why}）')
    for cid, idx in todo:
        url = f'https://codeforces.com/problemset/problem/{cid}/{idx}'
        try:
            req = urllib.request.Request(url, headers={'User-Agent': BROWSER_UA, 'Accept': 'text/html',
                                                       'Accept-Language': 'en-US,en;q=0.9'})
            with urllib.request.urlopen(req, timeout=60) as res:
                html = res.read().decode('utf-8', 'replace')
        except Exception as err:                                   # noqa: BLE001
            if verbose:
                print(f'   ⚠️ {cid}{idx} 查不到（{type(err).__name__}）')
            time.sleep(PAGE_DIFF_DELAY)
            continue
        # 页面上：`<span class="tag-box" title="Difficulty">*2000</span>`
        # （**没有** `ProblemRating` 这种类名 —— 实测踩过，别去匹配类名）。
        found = re.search(r'Difficulty"?\s*>\s*\*?\s*(\d{3,4})', html)
        rating = int(found.group(1)) if found else None
        known.setdefault(cid, {})[idx] = {'rating': rating, 'checkedAt': int(time.time())}
        if verbose:
            print(f'   {cid}{idx} → 实际有 {rating}' if rating
                  else f'   · {cid}{idx}：页面也没写（记成"实际没有"）')
        time.sleep(PAGE_DIFF_DELAY)
    write_json(PAGE_DIFF_JSON, known)
    if verbose:
        has = sum(1 for v in known.values() for e in v.values() if (e or {}).get('rating'))
        print(f'↓ {rel(PAGE_DIFF_JSON)}：实际有 {has} 道 / 页面确认"没有" '
              f'{sum(len(v) for v in known.values()) - has} 道')
    return known


def missing_difficulty_pairs(verbose: bool = True, recheck: bool = False,
                             neg_ttl_days=None) -> list:
    """
    扫**当前包里**缺 `cfDifficulty`、且**页面还没给结论**的 CF 正式比赛题 ⇒ `[(cid, idx), …]`。

    只按"**实际**"问：① 正式比赛（gym 一律没难度分）；② 包上确实没值；③ 页面三态是 `unknown`。
    ⚠️ **不看计分与否** —— 那是"应该"的判据（在 `material-needs.py` 里），两者别混。

    @param recheck - `True` = 忽略第 ③ 条（**兜底全部重爬**：连"所属比赛说有 rating、实际没有"
                      那种题的既有结论也一起推翻重查）。⚠️ 仍只查**缺**的题 —— 已经有值的重查没收益
                      （要重抓**题池**用 `--force`）。
    @param neg_ttl_days - 否定证据保质期（天）；0 = 默认 30 天，0 天 = 每次重查
    """
    pkg = os.path.join(REPO, 'acm-data', 'nodes', 'all_nodes.json')
    if not os.path.isfile(pkg):
        if verbose:
            print('（还没有包，跳过按题查难度）')
        return []
    doc = read_json(pkg)
    ttl = None if neg_ttl_days is None else float(neg_ttl_days) * 86400
    pairs, seen, settled = [], set(), 0
    for rec in doc.get('records') or []:
        if str(rec.get('节点类型') or '') != 'P':
            continue
        # 键形如 `cf:c:<场>:p:<题号>` —— **解析只有一处**（`cf_page_evidence.problem_ref`；
        # 全仓三份的历史见它的 docstring）。取不到就跳过。
        cid, idx = EVIDENCE.problem_ref(rec)
        if not cid or not idx or int(cid) >= 100000:             # gym 一律没有难度分
            continue
        if (cid, idx) in seen:
            continue
        seen.add((cid, idx))
        if str(rec.get('cfDifficulty') or '').strip():           # 包上已经有值（含按题补回来的）
            continue
        if not recheck and page_rating(cid, idx, neg_ttl=ttl)[0] != 'unknown':
            settled += 1                                         # `has`/`none` ⇒ 页面已给结论
            continue
        pairs.append((cid, idx))
    if verbose:
        print(f'（包里缺难度、页面还没给结论的 CF 正式比赛题：{len(pairs)} 道；'
              f'gym 与"页面已有结论"的 {settled} 道都不算）')
    return pairs


def fill_difficulty_from_pages(verbose: bool = True, recheck: bool = False,
                               neg_ttl_days=None) -> dict:
    """按题查页面（**唯一入口**：`--fill-difficulty`；`--all` ⇒ `recheck=True`）。"""
    pairs = missing_difficulty_pairs(verbose=verbose, recheck=recheck, neg_ttl_days=neg_ttl_days)
    if not pairs:
        return {}
    return fetch_page_difficulty(pairs, verbose=verbose, recheck=recheck, neg_ttl_days=neg_ttl_days)


def fetch_rated_list(verbose: bool = True) -> dict:
    """
    拉「Past contests filter → Rated: Yes/No」那份列表 ⇒ `{rated: [id…], unrated: [id…]}`。

    先抓 `filterRated=no`（只关心"不计分的场"），再抓 `yes` 作对照；每页一个请求。
    """
    ua = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
          '(KHTML, like Gecko) Chrome/124.0 Safari/537.36')
    out = {'rated': [], 'unrated': [], 'fetchedAt': int(time.time())}

    def page_ids(url: str) -> list:
        req = urllib.request.Request(url, headers={'User-Agent': ua, 'Accept': 'text/html',
                                                  'Accept-Language': 'en-US,en;q=0.9'})
        with urllib.request.urlopen(req, timeout=60) as res:
            html = res.read().decode('utf-8', 'replace')
        # ⚠️ 属性名是 `data-contestId`（大写 I）—— 小写匹配会 0 命中（实测踩过）。
        return [str(x) for x in re.findall(r'data-contestId="(\d+)"', html)]

    for want, key in (('no', 'unrated'), ('yes', 'rated')):
        for page in range(1, RATED_LIST_PAGES + 1):
            url = f'https://codeforces.com/contests?filterRated={want}'
            if page > 1:
                url = f'https://codeforces.com/contests/page/{page}?filterRated={want}'
            try:
                ids = page_ids(url)
            except Exception as err:                                  # noqa: BLE001
                if verbose:
                    print(f'   ⚠️ filterRated={want} 第 {page} 页抓不到（{type(err).__name__}）—— 到此为止')
                break
            fresh = [i for i in ids if i not in out[key]]
            out[key].extend(fresh)
            if verbose:
                print(f'   filterRated={want} 第 {page} 页：{len(ids)} 场（新增 {len(fresh)}）')
            if not fresh:
                break                      # 整页都是见过的 ⇒ 到头了
    write_json(RATED_LIST_JSON, out)
    if verbose:
        print(f'↓ {rel(RATED_LIST_JSON)}：计分 {len(out["rated"])} 场 / **不计分 {len(out["unrated"])} 场**')
    return out


def main(argv):
    ap = argparse.ArgumentParser(description=f'{LABEL} → crate 片段（整棵树一个片段）')
    ap.add_argument('-o', '--output', default=os.path.join(CACHE, 'crate_cf_contest_tree.json'))
    ap.add_argument('--handle', default='',
                    help='CF handle（**可逗号分隔多个**；默认取 me.json 的 cf.handles / 花名册 team[].cf）')
    ap.add_argument('--max-contests', type=int, default=0, help='只出最近 N 场（调试用）')
    ap.add_argument('--fetch-rated-list', action='store_true', dest='fetch_rated_list',
                    help='只拉「Past contests filter → Rated: Yes/No」那份**逐场列表**并写缓存，'
                         '不产包 —— 给 `material-needs.py` 用（谁计分、谁不计分，一页页列表）')
    ap.add_argument('--fill-difficulty', action='store_true', dest='fill_difficulty',
                    help='**按题查页面**看难度**实际**有没有：扫包里缺 `cfDifficulty` 的 CF 正式比赛题，'
                         '逐题查 `problemset/problem/<场>/<题>`，写 `cache/cf_contest/page_difficulty.json`')
    ap.add_argument('--all', action='store_true', dest='recheck',
                    help='（配合 `--fill-difficulty`）忽略已记下的结论，**全部重查**一遍（兜底档）')
    ap.add_argument('--neg-ttl-days', type=float, default=None, dest='neg_ttl_days',
                    help='（配合 `--fill-difficulty`）"页面没有难度"这个否定证据的保质期（天）；'
                         '默认 30 天，`0` = 每次重查')
    add_cli_args(ap)
    args = ap.parse_args(argv)
    configure_from(args)

    # ---- 两个"只干一件事"的子命令（不产包）----
    if args.fetch_rated_list:
        fetch_rated_list()
        return 0
    if args.fill_difficulty:
        if args.recheck:
            print('⚠️ --all：忽略已记下的结论，把所有缺难度的题**全部重查**一遍（兜底档）')
        fill_difficulty_from_pages(recheck=args.recheck, neg_ttl_days=args.neg_ttl_days)
        return 0

    handles = _handles(args.handle)
    if not handles:
        print('❌ 没有 CF handle —— 在 acm-data/raw/Scaper/me.json 的 cf.handle（或花名册 '
              'team[].cf）里填，或给 --handle', file=sys.stderr)
        return 1
    out = args.output or os.path.join(CACHE, 'crate_cf_contest_tree.json')
    try:
        crate, warns = build(handles, args.max_contests)
    except Exception as e:  # noqa: BLE001
        # CF 的 API 会偶发 404/限流（实测整段时间 404）：**保留上一份片段**、
        # exit 0 —— 别让一个渠道抽风把整条流水线打断（数据没变，重跑会覆盖）。
        if os.path.isfile(out):
            print(f'⚠️ 这次抓不到 CF API（{type(e).__name__}: {str(e)[:90]}）—— '
                  f'保留上一份片段 {rel(out)}（下次重跑会覆盖）', file=sys.stderr)
            return 0
        print(f'❌ 抓不到 CF API 且没有可用的旧片段：{type(e).__name__}: {str(e)[:120]}', file=sys.stderr)
        return 1
    if not crate.records:
        # 空片段会被 `crate-merge` **整包级拒绝**（"crate.records 缺失或为空"），
        # 整轮合并全废 —— 实测踩过（AtCoder 那边同一个坑）⇒ 不产出片段。
        # ⚠️ 不再删旧片段（空 ≠ 没有），与"抓不到 API"那条同一个口径。
        return empty_source_result(out, warns)
    data = crate.to_dict()
    issues = validate_crate(data)
    crate.save(out)
    print(f'✅ {rel(out)}   {crate.summary()}')
    for w in warns[:8]:
        print(f'   ⚠️ {w}' + (f'（还有 {len(warns) - 8} 条）' if len(warns) > 8 else ''))
    if issues:
        print(f'   ⚠️ 体检 {len(issues)} 条：{issues[:3]}')
    print_stats('CF 正式比赛')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
