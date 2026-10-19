#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
AtCoder 提交 → crate 片段（**整棵树一个片段**：`W atcoder → S 系列 → C → P → R`）

为什么要有它：AtCoder 是独立渠道，与 CF/QOJ 一样
**各出各的节点**，要不要跟主树那场算同一场由用户在「判重整理」页填 `映射元素值` 决定 ——
所以这里只负责"把 AtCoder 上这个账号的痕迹如实出成一棵树"。

数据源（AtCoder Problems 的公开 API，**不需要登录、不需要 cookie**；形状已实测）
--------------------------------------------------------------------------------
  ① `resources/contests.json` 6494 条：`id, title, start_epoch_second, duration_second, rate_change`
  ② `resources/problems.json` 9605 条：`id, contest_id, problem_index, title, name`
     （`title` 形如 `"A. DEGwer's Doctoral Dissertation"`，`name` 是裸题名 `"DEGwer's Doctoral Dissertation"`）
  ③ `atcoder-api/v3/user/submissions?user=<handle>&from_second=<T>`：**每页 500 条**，
     `id, epoch_second, problem_id, contest_id, language, point, result, execution_time, length, user_id`
     ⇒ 翻页办法：取本页最大 `epoch_second` + 1 继续，直到某页不满 500 条。

树形与 key（`lib/xcpc_common.py` 的 helper 自带 `atcoder:` 前缀）
-------------------------------------------------------------------
    O ─(W)atcoder「AtCoder」        ← **顶层平台树**，不进「辅助节点」
         └─(S)abc「ABC」             ← **按 contest id 的字母前缀客观分类**
             └─(C)atcoder:c:abc300
                 └─(P)atcoder:c:abc300:p:A
                     └─(R)atcoder:c:abc300:sub:atcoder:1234567

  · "Atcoder 不应该在辅助节点里..." ⇒ 走 `PLATFORM_TREES`（顶层），
    与 CF/QOJ 平级。
  · S 的四类 + 兜底：`abc` / `arc` / `agc` / `ahc` / `other`（名字 `ABC`/`ARC`/`AGC`/`AHC`/`其他`）。
    **只按 id 前缀判，不按赛名猜**（口径：相似度/名字一律不参与判定）。
    同一个分类（`series_of()`）**顺带写进 C 的 `natureSub`**（"加 abc/arc/agc/ahc"）；
    `other` 时留空 —— 词表里没有 `other`，认不出就该是"没标"。
  · 只出"我提交过的场次"；没有提交的场次不产出（C/P 也不出）。
  · 每场的 P = 该场**全部**题目（problems.json 的 `problem_index → name`），与 QOJ 同一口径：
    "收录一个比赛就该收录比赛内的所有题目"（任何渠道都同样）。
  · **P 的排序**：见 `lib/xcpc_common.py` 的 `letter_sort()`（**唯一一份实现**）——
    **只有 `EX` 垫底**，其余按**自然序**：`A < B < … < E < E1 < E2 < F < F2 < G`。
    （"要不限特殊名单，把 EX 放进去，其他按字典序排吧"。
     不这样排的话 `F2` 会被踢到 `F` 之后看不见的位置，
     而 AtCoder 的 `F2` 是官方独立题目（如 ARC120 的 F/F2 = 同题面、不同约束，
     见 https://atcoder.jp/contests/arc120/tasks ），它就该紧跟在 `F` 后面。）

状态映射（AtCoder 的 `result` → 应用的 `scripts/crate.py` 的 `STATUS_OPTIONS`）
------------------------------------------------------------------------------
    AC    → AC    判题通过
    WA    → WA    Wrong Answer
    TLE   → TLE   Time Limit Exceeded
    MLE   → MLE   Memory Limit Exceeded
    RE    → RE    Runtime Error
    OLE   → OLE   Output Limit Exceeded
    CE    → CE    编译错误（`STATUS_OPTIONS` 里有 CE，不再洗成 '-'）
    IE    → '-'   评测机内部错误：不是我的程序错，不该记成任何一种提交结果
    WJ    → '-'   Waiting for Judging（还没判）：等下一轮抓时自然会变成真结果
    Judging → '-' 同上（AtCoder 新提交先给这个）
    （表里没有的值 → '-'：宁可留空，也不猜）

读取层（`Scaper/lib/read_modes.py`，本仓库通用件）与缓存
-------------------------------------------------------
  · 三份缓存都在 `05 xcpc/cache/atcoder/`：`contests.json` / `problems.json` /
    `submissions_<handle>.json`（原始响应，不加工）。
  · **资源文件是活数据**（AtCoder 每周加场）⇒ 就地默认 `CACHE_NONE`：**每次联网**、抓到照旧写回。
  · **提交列表是增量的**：已有缓存时只从"缓存里最大 `epoch_second` + 1"往后抓；
    `--force` / `--cache-mode none` 才忽略水位线、从 0 重新抓一遍。
  · 出网一律走 `retry_call`（`--retry-mode once` 就只试一次）。

用法
----
    py atcoder_adapter.py                        # 读 me.json 的 atcoder.handle（花名册里所有人）
    py atcoder_adapter.py --handle tourist       # 临时指定（逗号分隔可给多个）
    py atcoder_adapter.py --max-pages 1          # 调试：提交只翻一页
    py atcoder_adapter.py --force                # 提交从 0 重抓、资源也重下
    py atcoder_adapter.py -o cache/_t.json       # 换个输出位置
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, 'lib'))
sys.path.insert(0, os.path.abspath(os.path.join(HERE, '..', 'lib')))   # Scaper/lib（通用读取层 + me.py）

from xcpc_common import (  # noqa: E402
    CACHE, add_crate_path, contest_key, emit_problem_synths, letter_sort, norm_letter, open_tree,
    problem_key, problem_reuse_groups, union_scope, year_mid, year_series_key,
    read_json, read_json_cached, rel, series_key, submission_key, write_json, year_in_text,
    empty_source_result,
)
from read_modes import (  # noqa: E402
    CACHE_NONE, Archive, add_cli_args, configure_from, offline, print_stats, require_local,
    retry_call, should_refetch,
)

add_crate_path()

from crate import Crate, _s, class_rules, link_kinds, nature_fields, to_cst, validate_crate  # noqa: E402
LABEL = 'AtCoder'
UA = 'acm-tree/xcpc'          # ⚠️ 必须带自己的 UA：urllib 默认那行会被挡
API = 'https://kenkoooo.com/atcoder'
CONTESTS_API = f'{API}/resources/contests.json'
PROBLEMS_API = f'{API}/resources/problems.json'
#: 题目难度模型：`{problem_id: {difficulty, slope, intercept, …}}`。
#: ⚠️ 它是**对象**不是数组（`_resource` 只收列表，所以另有 `_resource_map`）；
#: 公开可取、不需要 apiKey（实测 1.0s / 1.9 MB）。
MODELS_API = f'{API}/resources/problem-models.json'
SUBMISSIONS_API = f'{API}/atcoder-api/v3/user/submissions'
PAGE_SIZE = 500               # 提交接口每页 500 条（实测）
MAX_PAGES = 200               # 兜底：400 页 = 20 万条，真撞上就是出事了，别把它跑飞
no_official = False          # --no-official-tasks：跳过官方题表页（离线快速跑）
CACHE_DIR = os.path.join(CACHE, 'atcoder')
PAGES_DIR = os.path.join(CACHE_DIR, 'pages')          # 官方题表页的原料归档
ARCHIVE = Archive(PAGES_DIR)
LETTER_WARN_CACHE = os.path.join(CACHE_DIR, 'letter_warnings.json')
BROWSER_UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
              '(KHTML, like Gecko) Chrome/126.0 Safari/537.36')
TASKS_URL = 'https://atcoder.jp/contests/{cid}/tasks'

# contest id 的字母前缀 → 系列（**客观分类：只看 id，不看赛名**）
SERIES_NAMES = {'abc': 'ABC', 'arc': 'ARC', 'agc': 'AGC', 'ahc': 'AHC', 'other': '其他'}

STATUS_MAP = {
    'AC': 'AC', 'WA': 'WA', 'TLE': 'TLE', 'MLE': 'MLE', 'RE': 'RE', 'OLE': 'OLE',
    'CE': 'CE', 'IE': '-', 'WJ': '-', 'Judging': '-',
}


def atcoder_handles(explicit: str = '') -> list[str]:
    """
    要抓的 AtCoder 用户名**列表**（花名册里登记过的都算）：参数 > 环境变量 >
    `me.json` 的 `atcoder.handles/handle` > 花名册 `team[].atcoder` / `mappings`。
    优先级全在 `Scaper/lib/me.py` 的 `handles()` 里（与 CF 那边同一套）。
    读不到就返回空列表 —— 调用方给一句人能看懂的话，**绝不去改 me.json**。

    ⚠️ **一个都不许少**（原来这里 `return got[0]`）：范围是"谁的提交里有这场就收这场"，
       少一个人 ⇒ 他打过的场次**整场不在树上**。实测（2026-10-15）CF 那条路就是这么漏的
       （只问第一个人 ⇒ 队友 0 场正式比赛）；AtCoder 现在花名册里只有一个人，
       但只要队友的 atcoder 账号进了 me.json，这里就会犯同一个错。
    """
    shared = os.path.abspath(os.path.join(HERE, '..', 'lib'))
    if os.path.isfile(os.path.join(shared, 'me.py')):
        if shared not in sys.path:
            sys.path.insert(0, shared)
        try:
            import me as me_mod
            return me_mod.handles('atcoder', explicit)
        except Exception:  # noqa: BLE001 —— 读配置失败不该让整件事炸掉
            return []
    return [x.strip() for x in _s(explicit).split(',') if x.strip()]


def _get_json(url: str, timeout: int = 60):
    """取一个 JSON（AtCoder Problems 是公开 API，不带 cookie，只带自己的 UA）"""
    req = urllib.request.Request(url, headers={
        'User-Agent': UA,
        'Accept': 'application/json',
    })
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode('utf-8', 'replace'))


def _resource(path: str, url: str, what: str) -> list:
    """
    一份**活资源**（AtCoder 每周加场）⇒ 就地默认 `CACHE_NONE`：每次联网，抓到照旧写回。
    （`--cache-mode keep` 才让它读缓存。）
    """
    if not should_refetch(os.path.isfile(path), CACHE_NONE):
        # 离线（`--offline`）时 `should_refetch` 一律 False ⇒ 这里就是"只用本地"那条路：
        # 本地没有就当场报错（AtCoder 清单 1.2 MB / 5s+，且它是**活资源**，缺了整棵树就空）
        require_local(path, what)
        print(f'📦 用缓存 {rel(path)}')
        return read_json_cached(path)
    data = retry_call(_get_json, url, what=what)
    if not isinstance(data, list):
        raise RuntimeError(f'{what} 返回的不是列表：{str(data)[:120]}')
    write_json(path, data)
    print(f'⬇️ {what}：{len(data)} 条 → {rel(path)}')
    return data


def _resource_map(path: str, url: str, what: str, optional: bool = False) -> dict:
    """
    与 `_resource` 同一套读取语义（活资源、默认 `CACHE_NONE`、离线只用本地），但取的是**对象**。

    @param optional - `True` = **拿不到不算错**（返回 `{}` 并提示）——
                      难度就是这种：它是"锦上添花"的字段，缺了整棵树照样成立
    """
    if not should_refetch(os.path.isfile(path), CACHE_NONE):
        if not os.path.isfile(path):
            if optional:
                print(f'⚠️ 没有 {what} 缓存（离线？）⇒ 这一轮不写它，不影响其它字段')
                return {}
            require_local(path, what)
        print(f'📦 用缓存 {rel(path)}')
        data = read_json_cached(path)
    else:
        try:
            data = retry_call(_get_json, url, what=what)
        except Exception as err:                                  # noqa: BLE001
            if not optional:
                raise
            print(f'⚠️ 取不到 {what}（{type(err).__name__}）⇒ 这一轮不写它，不影响其它字段')
            return {}
        if not isinstance(data, dict):
            if optional:
                print(f'⚠️ {what} 返回的不是对象（{type(data).__name__}）⇒ 不用它')
                return {}
            raise RuntimeError(f'{what} 返回的不是对象：{str(data)[:120]}')
        write_json(path, data)
        print(f'⬇️ {what}：{len(data)} 条 → {rel(path)}')
    return data if isinstance(data, dict) else {}


def load_models() -> dict:
    """
    题目难度模型 ⇒ `{problem_id: difficulty(int)}`（**没有难度的题不进表** —— 不写负结论）。

    kenkoooo 难度（`problem-models.json`，公开可取）是**数值难度字段组**的一员
    （另一员是 CF 官方难度、将来还有 clist 难度）。
    """
    raw = _resource_map(os.path.join(CACHE_DIR, 'problem-models.json'), MODELS_API,
                        'AtCoder 题目难度模型（problem-models.json）', optional=True)
    out = {}
    for pid, model in (raw or {}).items():
        diff = (model or {}).get('difficulty') if isinstance(model, dict) else None
        if diff is None or diff == '':
            continue                      # 还没估出难度的新题：**不写**（缺失 ≠ 0）
        try:
            out[str(pid)] = int(diff)
        except (TypeError, ValueError):
            continue
    return out


def submissions_path(handle: str) -> str:
    """一份提交缓存**一个账号**（多人抓时不会互相覆盖）"""
    safe = re.sub(r'[^0-9A-Za-z_.-]', '_', handle)
    return os.path.join(CACHE_DIR, f'submissions_{safe}.json')


def fetch_submissions(handle: str, from_second: int = 0, max_pages: int = 0) -> tuple[list, int]:
    """
    按 `from_second` 往后翻页抓提交（每页 500 条，直到某页不满）。

    两道保险：① 水位线**必须前进**（同一秒里超过一页就停，免得原地打转）；
    ② 页数上限 `MAX_PAGES`（跑飞了也能自己停）。
    """
    out: list = []
    pages = 0
    cursor = int(from_second)
    while True:
        url = f'{SUBMISSIONS_API}?user={urllib.parse.quote(handle)}&from_second={cursor}'
        page = retry_call(_get_json, url, what=f'AtCoder 提交 {handle} 第 {pages + 1} 页')
        if not isinstance(page, list):
            raise RuntimeError(f'提交接口返回的不是列表：{str(page)[:120]}')
        out.extend(page)
        pages += 1
        print(f'   第 {pages} 页：{len(page)} 条')
        if len(page) < PAGE_SIZE:
            break
        nxt = max((r.get('epoch_second') or 0) for r in page) + 1
        if nxt <= cursor:
            print('   ⚠️ 水位线没有前进（同一秒里超过一页）—— 停在这里，下次跑会接着抓')
            break
        if max_pages and pages >= max_pages:
            print(f'   （--max-pages {max_pages}：调试用，先停）')
            break
        if pages >= MAX_PAGES:
            print(f'   ⚠️ 翻到 {MAX_PAGES} 页还没完 —— 停（免得跑飞）')
            break
        cursor = nxt
    return out, pages


def load_submissions(handle: str, max_pages: int = 0) -> tuple[list, int]:
    """
    读（并更新）提交缓存：**增量** —— 已有缓存就从"最大 epoch + 1"往后抓。

    `--force` / `--cache-mode none` 时忽略水位线、从 0 重抓（缓存仍然合并，不会丢历史）。
    @returns `(我的全部提交, 本轮抓了几页)`
    """
    path = submissions_path(handle)
    cached = read_json(path) if os.path.isfile(path) else []
    cached = [r for r in cached if isinstance(r, dict)]
    # ⚠️ **离线就是一次也不联网**：不能把 `should_refetch()` 的结论**只用来决定水位线**，
    #    而让下面那句 `fetch_submissions()` **无条件**执行 ⇒ 离线重跑照样往 kenkoooo 打请求
    #    （实测：`--offline` 下统计里出现"联网 1 次"，抓的是
    #    `.../user/submissions?user=…&from_second=…`）。
    #    离线直接走"只用本地"，本地没有就当场报错（别静默少一截提交）。
    if offline():
        if not cached:
            require_local(path, 'AtCoder 提交缓存')
        print(f'📦 用缓存 {rel(path)}（离线：不联网；{len(cached)} 条）')
        return cached, 0
    if should_refetch(os.path.isfile(path)):
        start = 0
        if cached:
            print('   （--force/--cache-mode none：忽略水位线，从 0 重抓一遍）')
    else:
        start = (max((r.get('epoch_second') or 0) for r in cached) + 1) if cached else 0
    print(f'🌐 抓 {handle} 的提交（from_second={start}'
          + (f'，缓存里已有 {len(cached)} 条' if cached else '') + '）')
    got, pages = fetch_submissions(handle, from_second=start, max_pages=max_pages)

    merged: dict = {}
    for r in cached + got:
        sid = _s(r.get('id'))
        # 兜底：接口已按 user 过滤，这里再判一次（`--handle` 写错/别人数据混进来时挡住）
        if not sid or _s(r.get('user_id')).lower() != handle.lower():
            continue
        merged[sid] = r
    rows = [merged[k] for k in sorted(merged, key=lambda k: (merged[k].get('epoch_second') or 0, k))]
    write_json(path, rows)
    print(f'💾 {rel(path)}：我的提交 {len(rows)} 条（本轮新增 {len(merged) - len(cached)}）')
    return rows, pages


_fail_streak = 0


def _fetch_html(url: str, cookie: str = '') -> str:
    """取 AtCoder 的公开 HTML。⚠️ 必须带浏览器 UA（默认那行会被挡）。"""
    req = urllib.request.Request(url, headers={
        'User-Agent': BROWSER_UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'})
    with urllib.request.urlopen(req, timeout=25) as r:
        return r.read().decode('utf-8', 'replace')


def official_tasks(cid: str) -> dict:
    """
    一场的**官方题表页** → `{task_id: (题号, 题名)}`。题号就是页面上那个 token，**权威**。

    为什么非要它（"每个比赛都要抓好其下题目的正确题号"）：AtCoder Problems 的
    `problems.json` 会把老题的**老家改挂到配对场**（实测 `arc070_a/b` 的 `contest_id` 成了 `abc056`），
    于是"不属于这场"的题只能按 id 尾巴推 —— arc070 会推成 **A,B**,E,F，而官方是 **C,D,E,F**。
    页面变体（比完就不变）⇒ 就地默认 **KEEP + RETRY**，`--force` 重抓；页面**原样入归档**。

    抓不到返回 `{}`（调用方退回推断并记警告）；连着 3 场抓不到就本轮到此为止，别白打几十个请求。
    """
    global _fail_streak
    if _fail_streak >= 3:
        return {}
    html = ARCHIVE.page(key=cid, kind='tasks', url=TASKS_URL.format(cid=cid),
                        fetch=_fetch_html, accept=lambda h: '/tasks/' in h,
                        verbose=False, label=f'atcoder tasks/{cid}')
    if not html:
        _fail_streak += 1
        return {}
    _fail_streak = 0
    pat = re.compile(r'href="/contests/%s/tasks/([^"]+)"[^>]*>(.*?)</a>'
                     % re.escape(cid), re.S)
    texts: dict = {}
    for tid, raw in pat.findall(html):
        one = re.sub(r'\s+', ' ', re.sub('<[^>]+>', '', raw)).strip()
        if one and one not in texts.setdefault(tid, []):
            texts[tid].append(one)
    out: dict = {}
    for tid, ts in texts.items():
        letter, name = '', ''
        for one in ts:
            if not letter and re.fullmatch(r'[A-Za-z][A-Za-z0-9]{0,2}', one):
                letter = one.upper()                      # 实测：一题两个锚，第一个是题号
            elif len(one) > len(name):
                name = one
        if not letter and ts:                             # 也有把 "C - Go Home" 写一个锚的
            m = re.match(r'^([A-Za-z][A-Za-z0-9]{0,2})\s*[-\u2013\u2014]\s*(.+)$', ts[0])
            if m:
                letter, name = m.group(1).upper(), m.group(2).strip()
        if letter:
            out[tid] = (letter, name)
    return out


def series_of(contest_id: str) -> str:
    """contest id 的字母前缀 → 系列 id（客观分类；认不出的都归 `other`）"""
    m = re.match(r'[a-z]+', str(contest_id or '').lower())
    prefix = m.group(0) if m else ''
    return prefix if prefix in ('abc', 'arc', 'agc', 'ahc') else 'other'


def contest_of_problem(pid: str, info: dict) -> str:
    """
    这道题**属于哪一场**（用来把题挂到对应比赛的 C 下）。

    ⚠️ 两条官方来源会打架（实测）：AtCoder Problems 会把老题**重新挂到 ADT 系列赛** ——
    `abc217_f` 的 `contest_id` 成了 `adt_all_20260804_1`。所以两边都算：
      · 资源写的 `contest_id`（ADT 那类新挂靠**只有它准**）
      · 题号 id 的前缀（`abc217_f` → `abc217`，原场**只有它准**）
    调用方把两个候选都试一遍（见 `build_tree` 里的分组），同一题号重复的自然被字母去重挡掉。
    """
    return _s((info or {}).get('contest_id')) or _s(pid).rsplit('_', 1)[0]


def letter_in(pid: str, cid: str, info: dict) -> str:
    """
    这道题在**某一场**里的题号。

    规则（同样的实测教训）：**这场自己的官方条目就用它的 `problem_index`；
    不是这场挂的，就按 id 尾巴取**（`abc217_f` → `F`）。
    不这么分的话，`abc217_f` 会被贴成 `I`（那是它在 ADT 里的题号），整棵 ABC217 的题号就乱了。
    """
    if _s((info or {}).get('contest_id')) == _s(cid):
        got = norm_letter((info or {}).get('problem_index'))
        if got:
            return got
    suf = _s(pid).rsplit('_', 1)[-1]
    return norm_letter(suf) if suf else ''


def _letter_sort(index) -> tuple:
    """P 的输出顺序 —— **委托给唯一那份实现** `xcpc_common.letter_sort`（只有 EX 垫底、其余自然序）"""
    return letter_sort(index)


def build_tree(contests: dict, problems: dict, submissions: list,
               handles, letter_warn: dict,
               difficulty: dict | None = None) -> tuple[Crate, list[str]]:
    """
    整棵 AtCoder 树一个 crate（见文件头"树形与 key"）。

    @param contests    `{contest_id: contests.json 那条}`
    @param problems    `{problem_id: problems.json 那条}`
    @param submissions **这些账号的**提交（原始字段，各带 `user_id`）
    @param handles     本次实际用的用户名（字符串或列表都收）—— 只用来报范围，
                       `账户线索` 写的是**每条提交自己的 `user_id`**（逐人抓 ⇒ 这条是谁的
                       抓的时候就知道；不要回头再读一次配置，否则 `--handle X`
                       而 me.json 里没登记时线索会凭空消失）
    @param difficulty  `{problem_id: difficulty}`（`load_models()` 的产物）——
                       **数值难度字段组**的一员（写进 P 的 `atcoderDifficulty`）；
                       `None`/空 = 这一轮没有它，**不写**（缺失不写负结论）
    @returns `(crate, 警告列表)`
    """
    want = [handles] if isinstance(handles, str) else [h for h in (handles or []) if h]
    crate = Crate(source_id='atcoder', label=LABEL, platform='atcoder')
    global no_official
    diff_of = difficulty or {}

    def _diff_extra(problem_id: str) -> dict:
        """题目的数值难度（没有就不写那个字段 —— 缺的题以后重跑会自己补上）"""
        got = diff_of.get(str(problem_id))
        return {'atcoderDifficulty': str(got)} if got is not None else {}
    warns: list[str] = []
    tree = open_tree(crate, 'atcoder')          # O → W aux → W aux-atcoder（并定下这棵树）

    # 题目按场分组（P 要出该场**全部**题目）——两个候选场次都挂，靠题号去重
    by_contest_problems: dict[str, list] = {}
    for pid, p in problems.items():
        for cand in {contest_of_problem(pid, p), _s(pid).rsplit('_', 1)[0]}:
            if cand:
                by_contest_problems.setdefault(cand, []).append((pid, p))

    by_contest: dict[str, list] = {}
    for r in submissions:
        cid = _s(r.get('contest_id'))
        if not cid:
            continue
        by_contest.setdefault(cid, []).append(r)
    if not by_contest:
        warns.append(f'一条提交都没有（{"、".join(want) or "这些账号"} 在 AtCoder 上没提交过？）')
        return crate, warns

    # 抓取范围 = 显式 ∪ 我有提交的（AtCoder 只有"我的提交"这一支）
    scope_contests = union_scope(mine=set(by_contest), name=f'AtCoder（{"、".join(want)}）')

    series_done: set = set()
    # 复用题的候选（`(场次 extKey, 场次时间, 题 extKey, 题名, 题号)`）—— 填完再统一判"同一时间同一题"
    p_entries: list = []
    for cid in sorted(scope_contests):
        sid = series_of(cid)
        sk = series_key(sid)
        if sk not in series_done:              # 同一个 S 只能出一遍（包内 extKey 必须唯一）
            crate.series(tree, sk, name=SERIES_NAMES[sid])
            series_done.add(sk)

        info = contests.get(cid) or {}
        if not info:
            warns.append(f'场次 {cid} 不在 contests.json 里（提交里有、资源里没有）—— 名字留空')
        ck = contest_key(cid)
        ctime = to_cst(info.get('start_epoch_second'))
        cyear = year_in_text(ctime)
        # ★ **年份层**（"atcoder 每类(abc/arc/agc/其他)除了其他
        #   同样按年分类"）⇒ `atcoder:s:abc:2024` 这一层，`other`（无归类）**不加**。
        # 判据/兜底与 cf、nk、hdu 完全一致：`year_series_key` + `YEAR_FALLBACK`（年份未知），
        # **不静默丢**——取不到年份的场次落在「年份未知」那一层里，看得见。 
        parent = sk
        if sid != 'other':
            yk = year_series_key(sk, cyear)
            if yk not in series_done:
                crate.series(sk, yk, name=year_mid(cyear))
                series_done.add(yk)
            parent = yk
        # ⚠️ 比赛时间写 **`contestTime`**（应用就这一个字段，见 crate.py 的 WRITABLE_FIELDS）；
        #    源里还有 `duration_second`，但包里**没有** duration 字段，所以不写（见文件头注）。
        #
        # 性质：**AtCoder 上办的比赛 ⇒ 大类 `atcoder`**。
        # 小类（"加 abc/arc/agc/ahc"）：**按 contest id 的字母前缀**
        # 填 `series_of(cid)` 的结果 —— 与 S 层用的是**同一个判据、同一个函数**
        # （`abc`/`arc`/`agc`/`ahc`；**只按 id 前缀，相似度/赛名一律不参与判定**）。
        # `other`（认不出的前缀，如 `adt_*` 那类重挂场）⇒ **留空**：
        # 词表里没有 `other` 这个值，而"认不出"就该是"没标"，不许造一个 `other` 桶
        # （`nature_fields` 会把空值丢掉，不占位）。
        # 地区写 `无`（"cf contest 等的地区应自动填『无』"）：
        # AtCoder 全是线上赛、没有场地地区 ⇒ "不适用"（不是"还没判"）；
        # 年份取官方开赛时间的 20xx；**赛季写 `无`**（"cf/atc 的赛季直接填无"）——
        # AtCoder 的 ABC/ARC/AGC 没有"赛季"这个概念 ⇒ 不适用，不是"还没判"。
        crate.contest(parent, ck, name=_s(info.get('title')),
                      contestTime=(ctime or None),
                      **nature_fields(('natureClass', 'atcoder/无归类' if sid == 'other'
                                       else 'atcoder/' + sid),
                                      ('natureYear', cyear),
                                      ('natureSeason', '无'),
                                      ('natureRegion', '无')),
                      # 分类依据（元列 `分类依据`）：**赛制 id 前缀**（`abc`/`arc`/`agc`/`ahc`）——
                      # AtCoder 自己的系列名，A 权威（与 S 层用的是同一个 `series_of()`）。
                      **class_rules(('natureClass', 'atcoder:series'),
                                    # 年份/赛季/地区的**依据**：年取**开赛时间**（A）；
                                    # 赛季/地区都写 `无`（不适用 ⇒ B），不是"还没判"。
                                    ('natureYear', 'atcoder:year-time' if cyear else ''),
                                    ('natureSeason', 'atcoder:season-none'),
                                    ('natureRegion', 'atcoder:region-none')),
                      **link_kinds(('problems', f'https://atcoder.jp/contests/{cid}')))

        # ---- P：这一场全部题目 ----
        # ① **官方题表页优先**（题号/题名都权威，且覆盖全场 —— 抓到了就不依赖 problems.json 的挂靠）；
        # ② 抓不到才退回推断（`problem_index` / id 尾巴），并记一条**警告**（题号可能有误）。
        official = {} if no_official else official_tasks(cid)
        if no_official:
            letter_warn[cid] = '命令行 --no-official-tasks：没读官方题表'
        elif not official:
            letter_warn[cid] = '抓不到官方题表页 /contests/%s/tasks' % cid
        pkeys: dict[str, str] = {}             # 题号字母 → P 的 key
        rows_p: list = []                      # (题号, 题名, task_id)
        if official:
            for tid, (letter, name) in official.items():
                rows_p.append((letter, name or _s((problems.get(tid) or {}).get('name')), tid))
        else:
            for pid, p in (by_contest_problems.get(cid) or []):
                rows_p.append((letter_in(pid, cid, p), _s(p.get('name')), pid))
        for letter, pname, tid in sorted(rows_p, key=lambda x: _letter_sort(x[0])):
            if not letter or letter in pkeys:
                continue
            pkeys[letter] = problem_key(cid, letter)
            crate.problem(ck, pkeys[letter], name=pname, problem_id=letter,
                          link=f'https://atcoder.jp/contests/{cid}/tasks/{tid}',
                          **_diff_extra(tid))
            p_entries.append((ck, ctime, pkeys[letter], pname, letter))

        # ---- R：我的提交（父 = 题目；题目资源里没有就补一条最小 P，别让 R 悬空）----
        done: set = set()
        for r in sorted(by_contest[cid], key=lambda x: (x.get('epoch_second') or 0, _s(x.get('id')))):
            sub_id = _s(r.get('id'))
            if not sub_id or sub_id in done:
                continue
            done.add(sub_id)
            who = _s(r.get('user_id'))
            pid = _s(r.get('problem_id'))
            known = problems.get(pid) or {}
            letter = (official.get(pid) or ('', ''))[0] or letter_in(pid, cid, known)
            if not letter:
                # 资源里查不到这道题：从 problem_id 的尾巴取字母（`abc300_a` → `A`），
                # 并且**补一条 P**，否则 R 的父节点不在这棵树里（校验会报红）
                letter = norm_letter(pid.rsplit('_', 1)[-1])
                warns.append(f'题目 {pid} 不在 problems.json 里（题号按 id 尾巴取 {letter!r}）')
            if not letter:
                warns.append(f'提交 {sub_id} 认不出题号（problem_id={pid!r}），跳过')
                continue
            if letter not in pkeys:
                pkeys[letter] = problem_key(cid, letter)
                crate.problem(ck, pkeys[letter], problem_id=letter,
                              link=f'https://atcoder.jp/contests/{cid}/tasks/{pid}',
                              **_diff_extra(pid))
            crate.submission(
                pkeys[letter],
                submission_key(cid, 'atcoder', sub_id),
                status=STATUS_MAP.get(_s(r.get('result')), '-'),
                time=to_cst(r.get('epoch_second')),
                link=f'https://atcoder.jp/contests/{cid}/submissions/{sub_id}',
                language=(_s(r.get('language')) or None),
                # 口径：毫秒（AtCoder 的 `execution_time` 本身就是毫秒），与 CF 那边一致
                timeUsed=(str(r.get('execution_time')) if r.get('execution_time') is not None else None),
                # 账户线索：应用不解释 handle 的含义，只拿它去查账户注册表。
                # 值取**这条提交自己的 `user_id`**（`load_submissions` 已按它过滤过）——
                # 多人时这是唯一正确的问法：写"本轮用的 handle"会把队友的提交记到第一个人头上。
                **({'账户线索': {'source': 'atcoder', 'field': 'handle', 'value': who}}
                   if who else {}),
            )

    # ---- ★ 复用题的**合成节点 + 成员指针**（"cf/atc 你直接生成 ownerSynth
    #      和合成节点就行了" + "**比赛完全不用合成**"）----
    # 判据：**同一时间的不同场次里，同一道题**各留了一份 P ⇒ 合成成一组。
    # AtCoder 上这种情形很少（历史上有 ABC/ARC 同时办、题共用的时候），所以**没有就不产出**；
    # 这条规则留着，将来出现了自动接住（不用再改代码）。
    made, pointed = emit_problem_synths(crate, problem_reuse_groups(p_entries), warns)
    if made:
        print(f'   复用题：{made} 个合成节点 + {pointed} 条成员指针'
              f'（同一时间不同场共用题；比赛层**不**合成）')
    return crate, warns


def main(argv):
    ap = argparse.ArgumentParser(description='AtCoder 提交 → crate 片段（整棵树：W/S/C/P/R）')
    ap.add_argument('-o', '--output', default='')
    ap.add_argument('--handle', default='',
                    help='AtCoder 用户名（**可逗号分隔多个**）；不给就读 me.json 的 atcoder.handles / 花名册')
    ap.add_argument('--max-pages', type=int, default=0,
                    help='调试用：提交最多翻几页（默认不限）')
    ap.add_argument('--no-official-tasks', action='store_true',
                    help='不读官方题表页（离线快速跑；题号退回推断，会记警告）')
    add_cli_args(ap)
    args = ap.parse_args(argv)
    configure_from(args)

    out = args.output or os.path.join(CACHE, 'crate_atcoder_tree.json')
    handles = atcoder_handles(args.handle)
    if not handles:
        print('⚠️ 没有 AtCoder handle —— 在 me.json 里加 atcoder.handle（或给 --handle）；'
              '这次**不覆盖**已有片段（别把归档过的整棵树写没了，也别让流水线挂）',
              file=sys.stderr)
        # ⚠️ 不能"存一份**空 crate**"（`Crate(...).save(out)`）—— 那会把归档过的
        #    AtCoder 树**盖成空片段**（空 ≠ 没有）。走统一件：留旧 + 出声。
        return empty_source_result(out, what='记录（没配 AtCoder handle）')
    try:
        contests = {_s(c.get('id')): c for c in _resource(
            os.path.join(CACHE_DIR, 'contests.json'), CONTESTS_API, 'AtCoder contests.json')}
        problems = {_s(p.get('id')): p for p in _resource(
            os.path.join(CACHE_DIR, 'problems.json'), PROBLEMS_API, 'AtCoder problems.json')}
        global no_official
        no_official = bool(args.no_official_tasks)
        subs, _pages = [], 0
        for h in handles:                     # 逐个账号抓（各自一份缓存 `submissions_<handle>.json`）
            rows, pages = load_submissions(h, max_pages=args.max_pages)
            subs += rows
            _pages += pages
        letter_warn: dict = {}
        # 数值难度（kenkoooo problem-models.json）：**拿不到也不算错**（`optional=True`），
        # 拿得到就写进 P 的 `atcoderDifficulty`（数值难度字段组的一员）
        models = load_models()
        crate, warns = build_tree(contests, problems, subs, handles, letter_warn, models)
        if models:
            print(f'   难度：{len(models)} 道题带上 atcoderDifficulty')
    except Exception as e:  # noqa: BLE001
        # 公开 API 也会偶发抽风：**保留上一份片段**、exit 0，别打断整条流水线
        if os.path.isfile(out):
            print(f'⚠️ 这次抓不到 AtCoder API（{type(e).__name__}: {str(e)[:90]}）—— '
                  f'保留上一份片段 {rel(out)}（下次重跑会覆盖）', file=sys.stderr)
            return 0
        print(f'❌ 抓不到 AtCoder API 且没有可用的旧片段：{type(e).__name__}: {str(e)[:120]}', file=sys.stderr)
        return 1
    if not crate.records:
        # ⚠️ 不再删旧片段（空 ≠ 没有），与上面"抓不到 API"那条同一个口径
        return empty_source_result(out, warns)
    crate.save(out)
    print(f'✅ {rel(out)}   {crate.summary()}')
    for w in warns[:20]:
        print('   ⚠️', w)
    if len(warns) > 20:
        print(f'   ⚠️ …另有 {len(warns) - 20} 条同类的警告')
    issues = validate_crate(crate.to_dict())
    # 这棵树是**自足**的（W/S/C/P/R 都在本包里）⇒ "父节点不在包内"之类的问题就是真错，照常报红
    if letter_warn:
        write_json(LETTER_WARN_CACHE, letter_warn)
        print(f'⚠️ {len(letter_warn)} 场没有官方题表（已用推断，题号可能有误）'
              f'—— 明细 {rel(LETTER_WARN_CACHE)}')
    elif os.path.isfile(LETTER_WARN_CACHE):
        os.remove(LETTER_WARN_CACHE)          # 这轮全有官方题表 ⇒ 清掉上一次的警告
    print_stats('AtCoder')
    if issues:
        print(f'❌ 校验问题 {len(issues)}：')
        for it in issues[:20]:
            print('   •', it)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
