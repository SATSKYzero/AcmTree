#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
CF 题目难度：**「实际有没有」的参考** = 题目页面（给定的 `https://codeforces.com/problemset`）。

⚠️ 先把两条**完全不同**的判据分开（曾把它们搅成了一锅）：

| 问题 | 判据 | 落在哪 |
|---|---|---|
| 这一格**应该**有没有 | **场次计不计分**：官网「Past contests filter → Rated: Yes/No」 | `cache/cf_contest/rated_list.json`（`--fetch-rated-list`），判在 `scripts/material-needs.py` |
| 这一格**实际**有没有 | **题目页面上写没写 `Difficulty`** | 本模块 ⇒ `cache/cf_contest/page_difficulty.json` |

⚠️ **曾犯过的错**（写下来）：看到 663 / 664 / 1345 在「Rated: No」列表里、题目页面上却写着
难度分，就断言"**Rated 判据被推翻了**" —— **错的**。这两件事**同时成立**、互不矛盾：
场次不计分（**不应该有**），CF 照样给题目打了难度（**实际有**）。用户："**应不应该有就是
按场次的 Rated: Yes/No 判的，你幻觉严重**"。别拿"实际有"去否定"应该有"。

`api/problemset.problems` 对那几场是**不全**的（663 只有 `A=1800`），所以**"实际有"要按题目
页面查**（参考就是题集页；单题页 `problemset/problem/<场>/<题>` 上写着 `Difficulty *2000`）。

三态（`page_rating`）：
  · `has`     —— 页面写了 ⇒ 实际有（值就按它补）
  · `none`    —— 查过、页面没写，且证据还新鲜（`PAGE_NEG_TTL`）⇒ **实际没有**（可豁免）
  · `unknown` —— 没查过 / 证据过期 ⇒ 说不清 ⇒ **去查一次**（用户："**特殊情况只能兜底**"：
                没有参考源时，唯一诚实的动作是把参考取回来，而不是猜）

⚠️ 否定证据带**保质期**：新题打分前页面也是空的，过期后要再看一眼（用户："**不然新题怎么办？**"）。

这一份实现**三处共用**：抓取（`cf_contest_adapter.py --fill-difficulty`）、原料需求
（`scripts/material-needs.py`）、字段体检（`scripts/field-coverage.py`）—— 判据只写一遍。
"""
from __future__ import annotations

import json
import os
import time

HERE = os.path.dirname(os.path.abspath(__file__))                     # …/05 xcpc/lib
DIR = os.path.join(os.path.dirname(HERE), 'cache', 'cf_contest')      # …/05 xcpc/cache/cf_contest
PAGE_DIFF_JSON = os.path.join(DIR, 'page_difficulty.json')
PAGE_NEG_TTL = 30 * 86400      # 否定证据的保质期（30 天）


def _read_json(path: str) -> dict:
    try:
        with open(path, 'r', encoding='utf-8') as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


def page_difficulty(path: str = '') -> dict:
    """题目页面的查询结果 → `{比赛号: {题号: {'rating': int|None, 'checkedAt': ts}}}`。"""
    return _read_json(path or PAGE_DIFF_JSON) or {}


def page_rating(cid, idx, now: float = 0, path: str = '', neg_ttl=None):
    """
    这道题**页面上**的难度（三态，见模块头）。

    @param neg_ttl - 否定证据的保质期（秒）；**`None` = 用默认 `PAGE_NEG_TTL`（30 天）**，
                     `0` = 一律当过期（每次重查，最激进）。
                     ⚠️ 别用 `0 or 默认` 那种写法：那样"0 天"永远表达不出来（实测踩到）。

    @returns `(state, rating)` —— `'has'` / `'none'` / `'unknown'`
    """
    now = now or time.time()
    ttl = PAGE_NEG_TTL if neg_ttl is None else float(neg_ttl)
    entry = (page_difficulty(path).get(str(cid)) or {}).get(str(idx))
    if not isinstance(entry, dict):
        return ('unknown', None)
    if entry.get('rating'):
        return ('has', entry['rating'])
    if now - float(entry.get('checkedAt') or 0) < ttl:
        return ('none', None)
    return ('unknown', None)


def key_of(cid, idx) -> str:
    """证据的键（`比赛号:题号`）—— 日志/报告里用得上"""
    return f'{cid}:{idx}'


def problem_ref(record: dict) -> tuple:
    """
    一条 P 记录 → `(cid, idx)` —— **"键怎么写"的唯一解释处**。

    键形如 `cf:c:<场次号>:p:<题号>`（`xcpc_common.cf_problem_key`）。为什么要有这个函数：
    这条规则全仓**三份**（`cf_contest_adapter.missing_difficulty_pairs`
    / `scripts/material-needs.py` / `scripts/field-coverage.py`），三份的形状校验还各不相同
    （一处判 `parts[3] == 'p'` + strip、一处只判长度、一处只判 `>= 5`）—— 同一份畸形键
    在三处会给出不同答案（`cf:c:2196:x:C`：一处给 `''`、另两处给 `'C'`）。

    ⚠️ 取不到（合成节点没有 `extKey`、键不是这个形状、题号位是字面量 `p`）一律返回 `('', '')`，
    调用方自己 `continue` —— **别在调用点再写一遍解析**。
    """
    rec = record or {}
    parts = str(rec.get('extKey') or '').split(':')
    if len(parts) < 5 or parts[0] != 'cf' or parts[1] != 'c' or parts[3] != 'p':
        return ('', '')
    cid = parts[2]
    idx = str(rec.get('problemId') or parts[4]).strip()
    return (cid, idx) if cid.isdigit() and idx else ('', '')


def merge_into_pool(pool: dict, path: str = '') -> dict:
    """
    把"题目页面上实际有"的难度**并进题池**（只在内存里并，不改缓存文件）：
    API 重抓（`--force`）也不会把补回来的分冲掉；题池里**已有值的一律不动**
    （API 的值优先，页面只补 API 漏掉的那几场）；"实际没有"的不并。

    ⚠️ 题池有三种形状都要认：`{name, rating}`（当前）、
    **题名串**（`problems.json` 的另一种形状）、**缺这一格**（API 的题池漏了它）。题名串那格
    **一个字都不并**（页面证据会被静默丢掉）⇒ 要保留题名、把难度补上。
    """
    for cid, probs in (page_difficulty(path) or {}).items():
        for idx, entry in (probs or {}).items():
            rating = (entry or {}).get('rating') if isinstance(entry, dict) else entry
            if not rating:
                continue
            slot = pool.setdefault(str(cid), {})
            got = slot.get(str(idx))
            if isinstance(got, dict):
                if not got.get('rating'):
                    got['rating'] = rating
            elif isinstance(got, str):
                slot[str(idx)] = {'name': got, 'rating': rating}     # 题名串那格：留题名、补难度
            elif got is None:
                slot[str(idx)] = {'name': '', 'rating': rating}      # API 的题池里没这道题
    return pool
