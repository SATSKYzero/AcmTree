#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
HDU 榜单 → 赛时统计（只从**队伍行**算，不用表头）

⚠️ 为什么不用表头
----------------
榜单表头形如 `1001 1169 / 2864`（看着像"通过 1169 / 提交 2864"），
但**它和表格里逐队逐格的数据对不上** —— 实测 1229 场：

    题号    表头 submitted   从格子累加的提交次数
    1001        2864              1874
    1004        2745              1265
    1008        1940               594

表头总是**更大**（多 12%~35%，且每题比例不同），说明它数的不是同一件事
（很可能是"所有运行次数"，含通过之后的提交与其它判题结果）。
既然对不上，就一律**忽略表头**，只从队伍行自己数 —— 这样得到的
"通过队伍数"才和树上"这题有多少队做出来"含义一致。

本脚本产出（这正是"精确赛时数据"的唯二可靠来源）
------------------------------------------------
1. **每题赛时通过队伍数**：多少支队伍在赛时解出了这道题
2. **有效队伍数**：赛时至少解出 1 题的队伍数

用法
----
    python "acm-data/raw/Scaper/02 hdu/lib/hdu_rank_stats.py" "acm-data/raw/Scaper/02 hdu/26hdu/26hdu3/hdu_cid1231_rank.html" -o acm-data/nodes/hdu_rank_stats_1231.json
    python "acm-data/raw/Scaper/02 hdu/lib/hdu_rank_stats.py" "acm-data/raw/Scaper/02 hdu/26hdu/26hdu3/hdu_cid1231_rank.html"   # 只打印

（一般不用手跑 —— `hdu_pipeline.py` 会自动调它。）

输出结构
--------
    {
      "source": "26hdu/26hdu3/hdu_cid1231_rank.html",
      "contestId": "1231",
      "effectiveTeams": 699,             # ★ 至少解出 1 题
      "teamCount": 1080,                 # 榜上出现的队伍总数
      "zeroSolveTeams": 381,             # 一题没解出的 (1080 - 699)
      "problems": [
        { "pid": "1001", "letter": "A", "solvedTeams": 12, "attemptedTeams": 39 },
        ...
      ]
    }
"""

from __future__ import annotations

import argparse
import json
import sys

# 不要生成 __pycache__（本脚本会 import 同目录模块）—— 纯垃圾，每次跑都长出来
sys.dont_write_bytecode = True

# 复用榜单解析（状态判定只写一处）
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from hdu_rank_parser import parse_pages, letter_of_pid  # noqa: E402


def compute_stats(rank_data: dict) -> dict:
    """
    从解析出的榜单数据里算赛时统计。

    @param rank_data  hdu_rank_parser.parse_html 的返回值
    @returns 统计结果（见文件头"输出结构"）
    """
    teams = rank_data.get('teams', [])
    problems = rank_data.get('problems', [])

    # ---- 有效队伍：赛时至少解出 1 题 ----
    # 两条口径都用，并检查是否自洽：
    #   bySolvedCol : 榜单 Solved 列（最权威）
    #   byCells     : 格子里有 passed 的记录
    # 两条口径不一致（格子判据写错）会导致"通过数 > 有效队伍数"。
    # 现在以 Solved 列为准，但若两者不等就给你提示。
    by_solved_col = [t for t in teams if (t.get('solved') or 0) > 0]
    by_cells = [t for t in teams
                if any(r.get('passed') for r in (t.get('results') or {}).values())]

    effective = by_solved_col
    cross_check = ''
    if len(by_solved_col) != len(by_cells):
        cross_check = (f'（注意：格子口径算出 {len(by_cells)} 支，'
                       f'与 Solved 列差 {abs(len(by_cells) - len(by_solved_col))} —— '
                       '两者本应一致，若差距大请检查榜单解析）')
    zero_solve = len(teams) - len(effective)

    # ---- 每题：通过队伍数 / 尝试过（提交过）的队伍数 ----
    out_problems = []
    for p in problems:
        pid = p['pid']
        solved_teams = 0
        attempted_teams = 0
        for t in teams:
            r = t.get('results', {}).get(pid)
            if not r:
                continue
            attempted_teams += 1
            # ★ 判据是 `passed`（有没有时刻），不是 state 名 —— 详见 hdu_rank_parser
            if r.get('passed'):
                solved_teams += 1
        out_problems.append({
            'pid': pid,
            'letter': letter_of_pid(pid),
            'solvedTeams': solved_teams,        # ★ 赛时通过队伍数
            'attemptedTeams': attempted_teams,  # 有提交的队伍数
        })

    # 按通过队伍数降序排一份，便于一眼看出难题
    out_problems.sort(key=lambda x: (-x['solvedTeams'], x['pid']))

    return {
        'source': rank_data.get('source', ''),
        'contestId': rank_data.get('contestId', ''),
        'effectiveTeams': len(effective),      # ★ 有效队伍数
        'crossCheck': cross_check,
        'teamCount': len(teams),
        'zeroSolveTeams': zero_solve,
        'problems': out_problems,
    }


def main(argv):
    ap = argparse.ArgumentParser(description='HDU 榜单 → 赛时统计（不用表头）')
    ap.add_argument('file')
    ap.add_argument('-o', '--out', help='输出 JSON（缺省只打印）')
    args = ap.parse_args(argv)

    with open(args.file, 'r', encoding='utf-8-sig', errors='replace') as f:
        html = f.read()

    # 用 parse_pages：同时支持单页与多页合并文件（去重由它负责）
    rank_data = parse_pages(html, source=args.file)
    stats = compute_stats(rank_data)

    print(f'✅ 赛时统计：{args.file}')
    print(f'   contestId      : {stats["contestId"] or "(未取到)"}')
    pages = rank_data.get('pages', 1)
    print(f'   解析页数       : {pages}'
          + ('   ⚠️ 单页 —— 数据不完整（完整榜单请用 scripts/fetch-hdu-rank.js 抓全部页）'
             if pages <= 1 else ''))
    print(f'   有效队伍数     : {stats["effectiveTeams"]}   ← 至少解出 1 题')
    if stats.get('crossCheck'):
        print(f'   {stats["crossCheck"]}')
    print(f'   榜上队伍总数   : {stats["teamCount"]}'
          f'（其中 {stats["zeroSolveTeams"]} 支一题未解）')
    print()
    print('   每题赛时通过队伍数（降序）：')
    print('     题号  字母   通过队伍  有提交队伍')
    for p in stats['problems']:
        pct = (f'{p["solvedTeams"] / stats["effectiveTeams"] * 100:5.1f}%'
               if stats['effectiveTeams'] else '  -  ')
        print(f'     {p["pid"]}  {p["letter"]:^4} {p["solvedTeams"]:>7} {p["attemptedTeams"]:>10}'
              f'   {pct} 队')

    if args.out:
        with open(args.out, 'w', encoding='utf-8') as f:
            json.dump(stats, f, ensure_ascii=False, indent=2)
        print(f'\n✅ 已写出 {args.out}')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
