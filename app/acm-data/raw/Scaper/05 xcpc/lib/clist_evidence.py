#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
CLIST 难度「**实际有没有**」的证据 = **那份全量缓存的"缺席"**。

## 为什么需要它（探针结论）

`clistDifficulty` 缺了 530 格时报出来的可疑，是**上游根本没有**，不是"没抓到、去抓一次就有"：

| 源 | 实测（探针） |
|---|---|
| CF 正式轮次 | 缓存里 `2202` 只有 **A/B/G1**、`2269` 只有 **A/B** —— 缺的正是剩下的那些（**互补不重叠**） |
| AtCoder | `abc217` 只有 **D/F/G/H**，缺的正是 **A/B/C/E** |
| 牛客 | clist **有这道题**，但 `rating` 是 **null**（它没给算难度） |

⇒ `clist-difficulty.py fetch --force` 是**全量重抓**（20–30 分钟 / 20–30 MB，限速 10 请求/分钟），
跑完**一格都不会变**。所以"缺"要能落到"**有证据：上游没有**"，否则体检会一直催、需求清单会一直
派一条**永远补不上**的命令（这正是看到 4 条需求时问"值不值得跑"的原因）。

## 判据（三态）

`clist_state(url)`：
  · `has`     —— 缓存表里**有**这条身份（那就不是"缺"，而是"没写进去" ⇒ **该修的是回写**，
                不是去抓；体检据此照常算缺，需求里也不豁免它 —— 别把 bug 洗成"上游没有"）
  · `absent`  —— 缓存表里**没有**这条身份，**且该 judge 确实抓到了别的题**（证明那次 fetch 覆盖到了它），
                **且缓存还新鲜**（`NEG_TTL`）⇒ **上游没有**（可豁免、不再派需求）
  · `unknown` —— 认不出链接 / 该 judge 一条都没有（那次 fetch 没覆盖到）/ 缓存过期 ⇒ 说不清 ⇒ 照旧算缺

⚠️ 两个**必须**的护栏（少了任何一条，"缺席"就会被误读成"上游没有"）：
  ① **judge 覆盖面**：全量缓存里那个 judge 一条都没有 ⇒ 说明那一轮根本没抓它（比如杭电），
     这时"缺席"只说明"没抓"，不是"上游没有"；
  ② **保质期**：缓存是"某一刻的快照"，新题过一阵子可能就被 clist 算出来了 ⇒ 否定证据 **30 天**过期，
     过期后照旧算缺（与 CF 页面证据 `PAGE_NEG_TTL` 同一个态度："**不然新题怎么办？**"）。

这一份实现**三处共用**：抓取（`clist-difficulty.py` 的 `normalize_url` 就是这里的那一份）、
原料需求（`scripts/material-needs.py`）、字段体检（`scripts/field-coverage.py`）—— 判据只写一遍。
"""
from __future__ import annotations

import json
import os
import re
import time

HERE = os.path.dirname(os.path.abspath(__file__))                        # …/05 xcpc/lib
DIR = os.path.join(os.path.dirname(HERE), 'cache', 'clist')              # …/05 xcpc/cache/clist
TABLE_JSON = os.path.join(DIR, 'difficulty.json')
NEG_TTL = 30 * 86400        # 否定证据的保质期（30 天）

#: URL → `judge|cid|题号`（匹配用；认不出返回空串）
_URL_RULES = (
    # CF：/contest/393/problem/A、/gym/105161/problem/B、/problemset/problem/663/B
    (re.compile(r'^https?://(?:www\.)?codeforces\.com/(?:contest|gym)/(\d+)/problem/([A-Za-z]\d?)$'),
     'codeforces.com'),
    (re.compile(r'^https?://(?:www\.)?codeforces\.com/problemset/problem/(\d+)/([A-Za-z]\d?)$'),
     'codeforces.com'),
    # AtCoder：/contests/<cid>/tasks/<task>（题号取 task 的最后一段字母）
    (re.compile(r'^https?://atcoder\.jp/contests/([^/]+)/tasks/(.+)$'), 'atcoder.jp'),
    # 牛客：/acm/contest/<cid>/<letter>
    (re.compile(r'^https?://ac\.nowcoder\.com/acm/contest/(\d+)/([A-Za-z]\d?)$'), 'ac.nowcoder.com'),
    # 杭电「多校」：/contest/problem?cid=1229&pid=1001（包里就是这种）
    (re.compile(r'^https?://acm\.hdu\.edu\.cn/contest/problem\?cid=(\d+)&pid=(\d+)'),
     'acm.hdu.edu.cn-multi'),
    # 杭电老题库：/showproblem.php?pid=<pid>
    (re.compile(r'^https?://acm\.hdu\.edu\.cn/showproblem\.php\?pid=(\d+)'), 'acm.hdu.edu.cn'),
    # UCup / QOJ：/<contest|contest>/<cid>/problem/<letter> 这类
    (re.compile(r'^https?://(?:contest\.ucup\.ac|qoj\.ac)/contest/([^/]+)/problem/([A-Za-z]\d?)$'),
     'contest.ucup.ac'),
)


def normalize_url(url: str) -> str:
    """
    URL → `judge|cid|题号` 的归一化身份（认不出就空串）。

    ⚠️ **别拿 URL 字符串直接比**：同一个平台有多种路径写法（`/contest/` 与 `/gym/`、带不带
    `?locale=`），字符串比会漏掉一大半。身份只留"哪个 judge + 哪场 + 哪题"。
    """
    u = str(url or '').strip()
    if not u:
        return ''
    u = u.split('#', 1)[0].split('?', 1)[0] if 'hdu.edu.cn' not in u else u
    for rx, judge in _URL_RULES:
        m = rx.match(u)
        if not m:
            continue
        groups = m.groups()
        if judge == 'atcoder.jp':
            cid, task = groups[0], groups[1]
            letter = task.rsplit('_', 1)[-1].upper()
            return f'{judge}|{cid}|{letter}'
        if judge == 'acm.hdu.edu.cn-multi':
            return f'acm.hdu.edu.cn|{groups[0]}|{groups[1]}'   # 多校：场次 + pid
        if judge == 'acm.hdu.edu.cn':
            return f'{judge}|{groups[0]}|'          # 老题库只有题号，没有场次
        cid, letter = groups[0], groups[1]
        return f'{judge}|{cid}|{letter.upper()}'
    return ''


def _read_json(path: str) -> dict:
    try:
        with open(path, 'r', encoding='utf-8') as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


def table(path: str = '') -> dict:
    """`{归一化身份: 难度}` —— 那份全量缓存（`cache/clist/difficulty.json`）"""
    return _read_json(path or TABLE_JSON) or {}


def checked_at(path: str = '') -> float:
    """缓存**抓下来的时刻**（文件 mtime）—— 否定证据的"什么时候看的"就是它"""
    try:
        return os.path.getmtime(path or TABLE_JSON)
    except OSError:
        return 0.0


def covered_judges(tbl: dict = None) -> set:
    """缓存里**真有题**的 judge（护栏①：用来区分"上游没有"与"那一轮没抓这个 judge"）"""
    data = table() if tbl is None else tbl
    return {k.split('|', 1)[0] for k in data}


def clist_state(url: str, now: float = 0, path: str = '', neg_ttl=None) -> tuple:
    """
    这道题的 CLIST 难度**实际有没有**（三态，见模块头）。

    @param neg_ttl - 否定证据的保质期（秒）；**`None` = 默认 `NEG_TTL`（30 天）**，
                     `0` = 一律当过期（每次重问，最激进）。
                     ⚠️ 别写 `neg_ttl or NEG_TTL`：那样"0 天"表达不出来。
    @returns `(state, why)` —— `'has'` / `'absent'` / `'unknown'`，`why` 是给人看的一句话
    """
    now = now or time.time()
    ttl = NEG_TTL if neg_ttl is None else float(neg_ttl)
    ident = normalize_url(url)
    if not ident:
        return ('unknown', '链接认不出 judge/题号（不是"上游没有"）')
    tbl = table(path)
    if not tbl:
        return ('unknown', '还没有 CLIST 缓存 ⇒ 没证据')
    if ident in tbl:
        return ('has', f'CLIST 缓存里有这条（{tbl[ident]}）—— 缺的话是**没写进去**，不是上游没有')
    judge = ident.split('|', 1)[0]
    if judge not in covered_judges(tbl):
        return ('unknown', f'缓存里 {judge} 一条都没有 ⇒ 那一轮没抓它（说不上"上游没有"）')
    age = now - checked_at(path)
    if age >= ttl:
        return ('unknown', f'缓存已经 {age / 86400:.0f} 天了（≥ {ttl / 86400:.0f} 天）⇒ 过期，'
                           '新题可能刚被算出来，重新问一次')
    return ('absent', f'缓存（{judge} 有 '
                      f'{sum(1 for k in tbl if k.startswith(judge + "|"))} 条）里'
                      '**就是没有这一条** ⇒ CLIST 没给这道题算难度')
