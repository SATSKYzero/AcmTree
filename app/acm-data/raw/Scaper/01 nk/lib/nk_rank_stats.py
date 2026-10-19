#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
牛客（Nowcoder）榜单 → 赛时统计（ratio 的唯一来源）

为什么需要它
------------
题目列表页给的「通过率 36/54」**分母不是队伍数**，口径也不清楚；
而应用里 `ratio` 的口径已定为：

    ratio = 通过队伍数 / 有效队伍数 × 100
    有效队伍数 = 赛时至少解出 1 题的队伍数

这两个数只有一个地方给得准 —— 牛客的**榜单接口**（比赛 Rank 页背后那个
返回 JSON 的请求）：

    problemData[].acceptedCount     ← 该题**通过队伍数**（直接可用）
    rankData[].acceptedCount        ← 每队过题数 → 数出**有效队伍数**

⚠️ 榜单是**分页**的（`basicInfo.pageCount`，每页 50 队）。
**只存了第 1 页就算不出有效队伍数** —— 本脚本会检出这种情况并拒绝产出
ratio，而不是给你一个静默偏小的分母。完整榜单请用 `fetch-nk-rank.js` 抓。

用法
----
    # 完整榜单（fetch-nk-rank.js 的产出）→ 统计写在榜单旁边（流水线自动这么做）
    python "acm-data/raw/Scaper/01 nk/lib/nk_rank_stats.py" "acm-data/raw/Scaper/01 nk/2026nk2/nk_cid133877_rank.json"
    # → 2026nk2/nk_cid133877_rank_stats.json

    # 想自己指定输出路径（比如手动存了一份榜单请求的响应，哪怕只有一页）
    python "…/lib/nk_rank_stats.py" "…/nk_cid133877_rank.json" -o "…/out.json"

输入可以是两种之一（自动识别）：
    A. 榜单接口的**原始响应**（`{"msg","code","data"}`）—— 通常只有一页
    B. `fetch-nk-rank.js` 抓的**汇总包**（`{"bundleVersion",...,"rankData":[...]}`）

输出结构
--------
    {
      "source": "...",
      "contestId": "133877",
      "effectiveTeams": 1200,        # ★ 至少解出 1 题的队伍数
      "teamCount": 1644,             # 榜上队伍总数
      "zeroSolveTeams": 444,
      "pagesCollected": 33,
      "pagesExpected": 33,
      "complete": true,              # ★ false 时 ratio 不可用
      "problems": [
        {"pid": "319252", "letter": "A", "solvedTeams": 36, "submitCount": 91,
         "ratio": "3.00"},
        ...
      ]
    }
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime

# 不要生成 __pycache__（下面要 import lib/nk_common.py）
sys.dont_write_bytecode = True

# ---- 接上公共工具（lib/nk_common.py）----
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from nk_common import read_json, write_json  # noqa: E402


def epoch_ms_to_str(v) -> str:
    """
    毫秒时间戳 → `YYYY.MM.DD HH:MM`（应用内部格式，见 crate.py 的 normalize_time）。

    为什么要自己转：榜单接口给的是 13 位毫秒数，而 normalize_time 只认
    12/14 位纯数字，13 位会被原样返回 —— 那样 `contestTime` 就是
    "1784692800000"，应用里没法比较也没法显示。
    """
    try:
        ms = int(v)
    except (TypeError, ValueError):
        return ''
    if ms <= 0:
        return ''
    return datetime.fromtimestamp(ms / 1000).strftime('%Y.%m.%d %H:%M')


def load(path: str):
    """读 JSON（容忍 BOM）—— 直接用公共实现，别在这里又抄一份"""
    return read_json(path)


def unwrap(raw) -> tuple[dict, list, list, int]:
    """
    把两种输入统一成 (basicInfo, problemData, rankData, pagesCollected)。

    - 原始响应：`data` 下直接就有三样东西，页数 = 1
    - 汇总包：`rankData` 已经合并了所有页，页数看 `pagesCollected`
    """
    if not isinstance(raw, dict):
        raise ValueError('根节点不是对象')
    if raw.get('code') not in (0, None) and 'data' in raw:
        raise ValueError(f'接口返回异常：msg={raw.get("msg")!r} code={raw.get("code")!r}')

    if 'bundleVersion' in raw:                      # ---- 汇总包（唯一一种格式，靠这个 marker 认）----
        # ⚠️ **不认"没有 marker 的旧汇总包"**（用户 2026-10-19："最好重抓，别混格式"）：一个文件形状
        #    只留一种，遇到老格式就**重抓那一场的榜单**（`05 xcpc/nk_multi_fetch.py --force --contest <cid>`），
        #    别在读取端加第二个分支 —— 两支一起活下去，下一次就分不清"哪份是哪一年的形状"。
        basic = raw.get('basicInfo') or {}
        return (basic,
                raw.get('problemData') or [],
                raw.get('rankData') or [],
                int(raw.get('pagesCollected') or 0))

    data = raw.get('data')
    if not isinstance(data, dict):                  # ---- 原始响应 ----
        raise ValueError('既不是汇总包，也没有 data 字段 —— 是不是存错了文件？'
                         '（旧格式汇总包请重抓那一场：nk_multi_fetch.py --force --contest <cid>）')
    return (data.get('basicInfo') or {},
            data.get('problemData') or [],
            data.get('rankData') or [],
            1)


def letter_map(problem_data: list) -> dict:
    """
    problemId(319252) → 字母题号(A)。

    牛客榜单的 `name` 字段恰好就是字母，直接用；万一哪天变了，
    就按列表顺序退化成 A/B/C…（榜单题序与题目列表一致）。
    """
    out = {}
    for i, p in enumerate(problem_data):
        pid = str(p.get('problemId') or '')
        name = str(p.get('name') or '').strip()
        if not pid:
            continue
        out[pid] = name if name else chr(ord('A') + i)
    return out


def compute_stats(raw, source: str) -> dict:
    basic, problem_data, rank_data, pages_collected = unwrap(raw)

    contest_id = str(basic.get('contestId') or '').strip()
    page_size = int(basic.get('pageSize') or 0)
    pages_expected = int(basic.get('pageCount') or 0)
    rank_count = int(basic.get('rankCount') or 0)

    # ★ **"倒着爬"的边界法**——
    #   榜单按得分排序 ⇒ 0 题的队全在尾部；只扫到"最后一个解出 ≥1 题的队"那一页就够，
    #   有效队伍数 = rankCount − 尾部的 0 题队数（实测 3~4/33 页，省 ~10 倍流量）。
    #   这种文档带 `effectiveTeams` + `complete: 'boundary'` ⇒ **直接采信它**，
    #   别按"页数不齐"判不完整（那是为"只抓了第 1 页、分母会静默偏小"设计的保护）。
    boundary_effective = raw.get('effectiveTeams') if isinstance(raw, dict) else None
    if boundary_effective is not None and str(raw.get('complete')) == 'boundary':
        complete = True
        effective_forced = int(boundary_effective)
    else:
        effective_forced = None
        complete = bool(pages_expected) and pages_collected >= pages_expected

    # ---- 有效队伍数：至少解出 1 题（边界法给了就采信它）----
    if effective_forced is not None:
        solved_teams = effective_forced
    else:
        solved_teams = 0
        for team in rank_data:
            if int(team.get('acceptedCount') or 0) > 0:
                solved_teams += 1
    team_count = len(rank_data)

    # 汇总包里 pageCount 可能没带全（有些响应只给当前页信息）
    if not pages_expected and page_size:
        pages_expected = (rank_count + page_size - 1) // page_size if rank_count else 0

    letters = letter_map(problem_data)
    problems = []
    for p in problem_data:
        pid = str(p.get('problemId') or '')
        accepted = p.get('acceptedCount')
        if accepted is None:
            continue
        ratio = ''
        if solved_teams > 0 and complete:
            ratio = f'{int(accepted) / solved_teams * 100:.2f}'
        problems.append({
            'pid': pid,
            'letter': letters.get(pid, ''),
            'solvedTeams': int(accepted),          # ★ 通过队伍数（榜单直接给）
            'submitCount': int(p.get('submitCount') or 0),
            'ratio': ratio,
        })

    # 题序按字母排，便于人看
    problems.sort(key=lambda x: x['letter'] or x['pid'])

    return {
        'source': source,
        'contestId': contest_id,
        'beginTime': epoch_ms_to_str(basic.get('contestBeginTime')),
        'endTime': epoch_ms_to_str(basic.get('contestEndTime')),
        'effectiveTeams': solved_teams,
        'teamCount': team_count,
        'zeroSolveTeams': max(team_count - solved_teams, 0),
        'pagesCollected': pages_collected,
        'pagesExpected': pages_expected,
        'complete': complete,
        'problems': problems,
    }


def main(argv):
    ap = argparse.ArgumentParser(description='牛客榜单 JSON → 赛时统计')
    ap.add_argument('file', help='榜单原始响应 或 fetch-nk-rank.js 的汇总包')
    ap.add_argument('-o', '--out', help='输出 JSON（缺省只打印）')
    args = ap.parse_args(argv)

    if not os.path.isfile(args.file):
        print(f'❌ 找不到输入文件：{args.file}', file=sys.stderr)
        return 1

    try:
        stats = compute_stats(load(args.file), args.file)
    except Exception as e:
        print(f'❌ 解析失败: {e}', file=sys.stderr)
        return 1

    print(f'✅ 赛时统计：{args.file}')
    print(f'   contestId      : {stats["contestId"] or "(未取到)"}')
    if stats['beginTime']:
        print(f'   比赛时间       : {stats["beginTime"]} ~ {stats["endTime"]}'
              '   ← 用于 C 节点的 contestTime')
    print(f'   榜单页数       : {stats["pagesCollected"]} / {stats["pagesExpected"] or "?"}'
          + ('   ✅ 完整' if stats['complete'] else '   ⚠️ **不完整**'))
    print(f'   有效队伍数     : {stats["effectiveTeams"]}   ← 至少解出 1 题')
    print(f'   榜上队伍总数   : {stats["teamCount"]}'
          f'（其中 {stats["zeroSolveTeams"]} 支一题未解）')
    print()
    print('   每题通过队伍数（榜单口径 = 通过队伍数 / 有效队伍数）：')
    print('     字母   题号ID     通过队伍   提交数     ratio')
    for p in stats['problems']:
        print(f'     {p["letter"]:^4} {p["pid"]:>9} {p["solvedTeams"]:>9} {p["submitCount"]:>9}'
              f'   {p["ratio"] or "（榜单不完整，未计算）"}')

    if not stats['complete']:
        print()
        print('   ⚠️ 榜单不完整：**有效队伍数偏小 → ratio 会整体偏大**，')
        print('      所以本脚本故意不产出 ratio。请用 fetch-nk-rank.js 抓完整榜单后重跑。')

    if args.out:
        write_json(args.out, stats)
        print(f'\n✅ 已写出 {args.out}')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
