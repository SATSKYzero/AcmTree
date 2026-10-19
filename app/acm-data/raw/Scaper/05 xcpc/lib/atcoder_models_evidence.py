#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
AtCoder 难度「**实际有没有**」的证据 = **kenkoooo 模型文件里那一条有没有 `difficulty` 键**。

## 为什么需要它

截图里问"**1/2都是补充 atcoder 的难度 / 确定爬不到吗？**"，而 3696（ARC146 F）与 4596
（ARC120 F2）明明有数；病因是："**kenkoooo 的无难度常常是因为没有人过才算不了
（也就是特别难，不是没有）**" —— 那张 kenkoooo 列表截图正好是证据：ARC120 **F** 有值、
**F2** 悬停显示 `Difficulty is unavailable`。

现场重下 `problem-models.json`（**1,156,532 B / 5148 条**）复核：全库 `atcoderDifficulty`
缺的 **38 格**里，那 38 道**一条 `difficulty` 都没有**，分三类（**都不是"没抓到"**）：

| 类 | 例 | 上游长什么样 | 为什么 |
|---|---|---|---|
| 最难的那一档 | `arc146_f`、`arc120_f2`、`arc155_f`、`arc175_f`、`arc180_f`、`agc012/020/040/059/066_f` | `{"is_experimental": false}` | **够格的评分者太少**（"没有人过才算不了"）——IRT 估不出 |
| 教育 DP 场（26 题） | `dp_a…dp_z` | 只有 `slope` / `intercept` | 那场**不计分**，从来没有难度模型（只有用时模型） |
| 签到题 | `abc299_a/b` | 只有 `slope` / `intercept` / `variance` | 太简单（**饱和**），也没估 |

⚠️ 三个旁证（先说清"缺"不是弄丢的，否则会被洗成"上游没有"）：
  ① 上游**保留**负难度（**944 条**负数，`abc459_a = -921`）⇒ `atcoder_adapter.load_models()` 的
     `diff is None ⇒ continue` 不是把负数滤掉了，是照「缺失 ≠ 0」写的；
  ② kenkoooo 前端 `api/APIClient.ts` 的 `useProblemModelMap()` 是**唯一**取难度的地方
     （`STATIC_API_BASE_URL + "/problem-models.json"` ⇒ `clipDifficulty(model.difficulty)`）
     ⇒ **它自己那页同样不显示**；
  ③ 别的路都不存在：`problem-models-experimental.json` / `difficulty.json` / `/v3/problems/difficulty`
     全是 404，`merged-problems.json` / `problems.json` 里也没有这两道。

⇒ 跟 CLIST 那 530 格同一类处置：「缺」要能落到"**有证据：上游没有**"，否则体检一直催、
需求清单一直派一条**永远补不上**的命令（`atcoderDifficulty` 那条正是需求清单里的最后 1 条）。
⚠️ 但**不给它做"应该不应该有"的判据**：应不应该有另有一套（见 `scripts/material-needs.py`），
本条只答"**实际**有没有"。

## 判据（三态）

`model_state(problem_id)`：
  · `has`     —— 模型里那一条**有数字 `difficulty`**（却缺）⇒ 那是"**没写进去**"，**该修的是
                 回写**，不是去抓；体检据此照常算缺、需求里也不豁免它 —— 别把 bug 洗成"上游没有"）
  · `absent`  —— 那一条**在**、但**没有 `difficulty`**（前三类之一），**且同一场别的题在表里**
                 （证明 kenkoooo 确实收这场），**且缓存还新鲜**（`NEG_TTL`）⇒ **上游没估出来**
  · `unknown` —— 认不出题 id / 表里压根没有这一场 / 缓存过期或缺文件 ⇒ 说不清 ⇒ 照旧算缺

⚠️ 两条**必须**的护栏（少了任何一条，"缺席"就会被误读成"上游没有"）：
  ① **场次覆盖面**：表里**同场一道题都没有** ⇒ 说明 kenkoooo 压根没这一场（别拿它当"上游没有"）；
  ② **保质期**：`problem-models.json` 是"某一刻的快照"，新题过一阵子可能就被估出来了
     （`abc299 A/B` 那种"漏估"尤其可能补上）⇒ 否定证据 **30 天**过期，过期后照旧算缺
     —— 与 `clist_evidence` / `cf_page_evidence` 同一个态度："**不然新题怎么办？**"。

这一份实现**两处共用**：字段体检（`scripts/field-coverage.py`）、原料需求
（`scripts/material-needs.py`）—— 判据只写一遍。
"""
from __future__ import annotations

import json
import os
import re
import time

HERE = os.path.dirname(os.path.abspath(__file__))                       # …/05 xcpc/lib
DIR = os.path.join(os.path.dirname(HERE), 'cache', 'atcoder')           # …/05 xcpc/cache/atcoder
TABLE_JSON = os.path.join(DIR, 'problem-models.json')
NEG_TTL = 30 * 86400        # 否定证据的保质期（30 天）

_LINK_RX = re.compile(r'^https?://atcoder\.jp/contests/([^/?#]+)/tasks/([^/?#]+)')
_EXT_RX = re.compile(r'^atcoder:c:([^:]+):p:(.+)$')


def model_id_of(link: str = '', ext_key: str = '') -> str:
    """
    这道题的 **kenkoooo 题 id**（`arc120_f2`）—— 表就是按这个 key 的。

    优先从 `link`（`…/tasks/arc120_f2`）取 **task 段**（那是权威的，`EX` / `F2` 的大小写原样在里）；
    取不到再从 `extKey`（`atcoder:c:arc120:p:F2`）拼：
    用 `link` 优先是因为 extKey 里题号可能被规范化过，而表 key 认的是 AtCoder 的 task id。
    """
    m = _LINK_RX.match(str(link or '').strip())
    if m:
        cid, task = m.group(1), m.group(2)
        if '_' in task:
            return task.lower()
        return f'{cid}_{task.lower()}'
    m = _EXT_RX.match(str(ext_key or '').strip())
    if m:
        return f'{m.group(1)}_{m.group(2).lower()}'
    return ''


def _read_json(path: str) -> dict:
    try:
        with open(path, 'r', encoding='utf-8') as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


def table(path: str = '') -> dict:
    """`{kenkoooo 题 id: 模型}` —— 那份 `cache/atcoder/problem-models.json`"""
    data = _read_json(path or TABLE_JSON)
    return data if isinstance(data, dict) else {}


def checked_at(path: str = '') -> float:
    """缓存**抓下来的时刻**（文件 mtime）—— 否定证据的"什么时候看的"就是它"""
    try:
        return os.path.getmtime(path or TABLE_JSON)
    except OSError:
        return 0.0


def contest_covered(cid: str, tbl: dict = None) -> bool:
    """护栏①：表里**有没有这一场的别的题**（用来区分"上游没估"与"kenkoooo 没收这场"）"""
    if not cid:
        return False
    data = table() if tbl is None else tbl
    head = cid + '_'
    return any(str(k).startswith(head) for k in data)


def _diagnose(entry) -> str:
    """上游那一条长什么样 ⇒ 一句人话的病因（三类）"""
    if not isinstance(entry, dict):
        return 'kenkoooo 表里连这一条都没有'
    if 'slope' in entry and 'discrimination' not in entry:
        return '只有用时模型（`slope`/`intercept`，**没有难度模型** —— 多为不计分的教育场）'
    return '那一条只有 `is_experimental`/`variance` 之类、**没有 `difficulty`**（够格的评分者太少 ⇒ 估不出来）'


def model_state(problem_id: str, now: float = 0, path: str = '', neg_ttl=None) -> tuple:
    """
    这道题的 AtCoder 难度**实际有没有**（三态，见模块头）。

    @param problem_id - kenkoooo 题 id（`arc120_f2`）；用 `model_id_of()` 从 link/extKey 求
    @param neg_ttl    - 否定证据的保质期（秒）；**`None` = 默认 `NEG_TTL`（30 天）**，
                        `0` = 一律当过期（每次重问，最激进）。
                        ⚠️ 别写 `neg_ttl or NEG_TTL`：那样"0 天"表达不出来。
    @returns `(state, why)` —— `'has'` / `'absent'` / `'unknown'`，`why` 是给人看的一句话
    """
    now = now or time.time()
    ttl = NEG_TTL if neg_ttl is None else float(neg_ttl)
    pid = str(problem_id or '').strip()
    if not pid:
        return ('unknown', '认不出这道题的 kenkoooo 题 id（不是"上游没有"）')
    tbl = table(path)
    if not tbl:
        return ('unknown', '还没有 kenkoooo 模型缓存 ⇒ 没证据')
    entry = tbl.get(pid)
    if isinstance(entry, dict):
        diff = entry.get('difficulty')
        if diff is not None and diff != '':
            return ('has', f'kenkoooo 表里**有**这道题的难度（{diff}）—— 缺的话是**没写进去**，'
                           '不是上游没有')
    cid = pid.rsplit('_', 1)[0]
    if not contest_covered(cid, tbl):
        return ('unknown', f'表里 {cid} 这场一道题都没有 ⇒ kenkoooo 没收这场（说不上"上游没有"）')
    age = now - checked_at(path)
    if age >= ttl:
        return ('unknown', f'缓存已经 {age / 86400:.0f} 天了（≥ {ttl / 86400:.0f} 天）⇒ 过期，'
                           '新题可能刚被估出来，重新问一次')
    return ('absent', f'{_diagnose(entry)}（缓存抓于 '
                      f'{time.strftime("%Y-%m-%d", time.localtime(checked_at(path)))}）'
                      f' ⇒ kenkoooo 没给这道题估难度')
