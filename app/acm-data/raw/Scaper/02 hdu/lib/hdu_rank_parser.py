#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
HDU 榜单解析（rank HTML → 精确赛时数据）

为什么需要它
------------
`Hdu_problems.json` 里的 `ratio` / `accepted` / `submitted` 算的是**历史提交**
（全站累计），与"这场比赛打得怎么样"无关。**精确的赛时数据只能从榜单取**。

榜单表头自带一对数字，但口径容易看错，而且**和格子里的数据对不上**
（实测 1229：表头 1001 = 2864 次提交，逐格累加只有 1874 次）：

    1001  1169 / 2864
          ↑      ↑
          两个数都比格子多，说明数的不是同一件事（疑似"所有运行次数"）

所以本脚本不直接用表头，而是**逐格数队伍**：
每行 × 每列扫一遍，某个队有 AC 时刻就算它通过了这题 —— 这才是
"通过队伍数"，也正是应用里 ratio 的分子（分母是有效队伍数，见
hdu_rank_stats.py）。表头数字只作为参考打印出来。

用法
----
    python "acm-data/raw/Scaper/02 hdu/lib/hdu_rank_parser.py" 26hdu/26hdu3/hdu_cid1231_rank.html -o acm-data/nodes/hdu_rank_1231.json
    python "acm-data/raw/Scaper/02 hdu/lib/hdu_rank_parser.py" 26hdu/26hdu3/hdu_cid1231_rank.html   # 只打印摘要

输出结构
--------
    {
      "source": "26hdu/26hdu3/hdu_cid1231_rank.html",
      "contestId": "1231",            # 从 code link 的 cid= 取（取不到为 ""）
      "problems": [
        { "pid": "1001", "accepted": 1169, "submitted": 2864, "teams": 816 },
        ...
      ],
      "teams": [
        { "rank": 1, "teamId": "team0662", "teamName": "NJU-T12",
          "school": "南京大学", "solved": 9, "penalty": "22:31:28",
          "results": { "1001": {"state":"accepted","time":"00:03:07",
                                "wrong":1,"runId":"13813"}, ... } },
        ...
      ]
    }

格子状态（对应 HDU 的 class）
-----------------------------
⚠️ **判据是"有没有时刻"，不是 class 名** —— 这是本文件最容易搞错的地方：

    class                 文本              含义
    rank-status-accepted  '01:06:30 (-1)'   ✅ 已通过（时刻 + 此前的错误次数）
    rank-status-fb        '00:10:33'        ✅ 首杀，也是通过
    rank-status-solved    '+' / '+ (-12)'   ⚠️ **没有时刻 = 尝试未通过**
    rank-status-trying    '(-1)' / '(-14)'  ⚠️ 未通过
    rank-status-empty     ''                未提交

所以每条结果都带一个显式的 `passed` 布尔值，调用方**应当用 `passed`**
而不是 `state` 来判断是否通过。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys

# 不要生成 __pycache__（下面要 import lib/hdu_common.py）
sys.dont_write_bytecode = True
from collections import Counter

try:
    from bs4 import BeautifulSoup
except ImportError:
    sys.exit('需要 beautifulsoup4：pip install beautifulsoup4')

# 表头形如 "1001 1169 / 2864"（题号 + 赛时过题/提交）
HEADER_RE = re.compile(r'^(\d{3,4})\s+(\d+)\s*/\s*(\d+)$')
# 接受时刻 00:13:45
TIME_RE = re.compile(r'\b(\d{1,2}:\d{2}:\d{2})\b')
# 罚时括号 (-12) —— 注意 trying 格是 "+ (-12)"，其中 + 也可视为罚时
WRONG_RE = re.compile(r'\(\s*-\s*(\d+)\s*\)')
# code link 形如 /contest/view-code?cid=1229&rid=13813&from=rank
RID_RE = re.compile(r'rid=(\d+)')

# ---- 接上公共工具（lib/hdu_common.py）----
# 字母表与 cid 提取都在那里（只有一份）
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from hdu_common import CID_RE, letter_of  # noqa: E402

# 别名：hdu_rank_stats.py 是从这里 import 的
letter_of_pid = letter_of


def _clean(s: str) -> str:
    return ' '.join((s or '').split())


# ================================================================
# 多页合并文件（由 scripts/fetch-hdu-rank.js 抓取）
# ================================================================

PAGE_MARK_RE = re.compile(r'<!--\s*PAGE\s+(\d+)\s*-->', re.I)


def split_pages(html: str) -> list[str]:
    """
    把多页合并文件切成每页的表格 HTML。

    浏览器抓取脚本用 `<!-- PAGE n -->` 分隔各页。
    若文件只有一页（没有标记），就整体当一页返回。
    """
    marks = list(PAGE_MARK_RE.finditer(html))
    if not marks:
        return [html]
    out = []
    for i, m in enumerate(marks):
        end = marks[i + 1].start() if i + 1 < len(marks) else len(html)
        out.append(html[m.end():end])
    return out


def parse_pages(html: str, source: str = '') -> dict:
    """
    解析**多页**榜单：把每页的队伍合并成一份（按队伍去重）。

    合并语义：
      - 同一队伍在多页出现时**合并其 results**（后面的页只补不覆盖），
        这样即使分页边界上有重复行也不会丢数据；
      - problems 取各页表头的并集（按 pid）；
      - contestId 取第一个非空值。
    """
    pages = split_pages(html)
    merged_teams: dict[str, dict] = {}
    problems_by_pid: dict[str, dict] = {}
    contest_id = ''
    state_counter = Counter()

    for page_html in pages:
        try:
            one = parse_html(page_html, source=source)
        except ValueError:
            continue                     # 空页/分隔残留
        if not contest_id:
            contest_id = one.get('contestId', '')
        for p in one['problems']:
            problems_by_pid.setdefault(p['pid'], p)
        for t in one['teams']:
            key = t['teamId'] or f'rank{t["rank"]}'
            if key not in merged_teams:
                merged_teams[key] = t
            else:
                # 只在缺字段时补，不覆盖
                cur = merged_teams[key]
                for f in ('teamName', 'school', 'penalty'):
                    if not cur.get(f) and t.get(f):
                        cur[f] = t[f]
                cur['solved'] = max(cur.get('solved') or 0, t.get('solved') or 0)
                cur['results'].update(
                    {k: v for k, v in t['results'].items() if k not in cur['results']})

    teams = sorted(merged_teams.values(), key=lambda t: t['rank'])
    problems = sorted(problems_by_pid.values(), key=lambda p: p['pid'])

    # 有提交的队伍数 + 格子状态统计：都用**去重后**的队伍算，
    # 否则多页文件里重复的行会被重复计数（状态数虚高）。
    for p in problems:
        pid = p['pid']
        p['teams'] = sum(1 for t in teams if pid in t['results'])
    for t in teams:
        for r in t['results'].values():
            state_counter[r.get('state', 'empty')] += 1

    return {
        'source': source,
        'contestId': contest_id,
        'contestName': '',      # 榜单页没有比赛名，由 Hdu_contests.json 补
        'contestTime': '',
        'pages': len(pages),
        'problems': problems,
        'teams': teams,
        '_stateCounter': dict(state_counter),
    }


def parse_html(html: str, source: str = '') -> dict:
    soup = BeautifulSoup(html, 'html.parser')

    # 榜单表：HDU 用 class="page-card-table"
    table = soup.find('table', class_='page-card-table')
    if not table:
        # 兜底：找第一个含 "Rank" 表头的表
        for t in soup.find_all('table'):
            if t.find('th') and 'Rank' in t.get_text(' ', strip=True)[:80]:
                table = t
                break
    if not table:
        raise ValueError('找不到榜单表格（预期 class="page-card-table"）')

    rows = table.find_all('tr')
    if not rows:
        raise ValueError('表格没有行')

    # ---- 表头 ----
    header_cells = rows[0].find_all(['th', 'td'])
    header_text = [_clean(c.get_text(' ', strip=True)) for c in header_cells]

    # 前 4 列固定是 Rank / Author / Solved / Penalty，后面每列一道题
    fixed = ['Rank', 'Author', 'Solved', 'Penalty']
    for i, name in enumerate(fixed):
        if i < len(header_text) and header_text[i] != name:
            print(f'⚠️  表头第 {i} 列预期 {name!r}，实际 {header_text[i]!r}',
                  file=sys.stderr)

    problems = []
    for i, text in enumerate(header_text):
        if i < len(fixed):
            continue
        m = HEADER_RE.match(text)
        if not m:
            print(f'⚠️  表头第 {i} 列无法解析：{text!r}', file=sys.stderr)
            continue
        pid, accepted, submitted = m.group(1), int(m.group(2)), int(m.group(3))
        problems.append({
            'pid': pid,
            'col': i,
            'accepted': accepted,      # ★ HDU 表头的 AC 提交次数（非队伍数）
            'submitted': submitted,    # ★ HDU 表头的总提交次数
            'teams': 0,                # 稍后填：有提交的队伍数
        })

    # ---- 队伍行 ----
    teams = []
    contest_id = ''
    state_counter = Counter()

    body = [r for r in rows if r.find_all('td')]
    for tr in body:
        tds = tr.find_all('td')
        if len(tds) < 4:
            continue

        rank_txt = _clean(tds[0].get_text(' ', strip=True))
        if not rank_txt.isdigit():
            continue                     # 表头残留或分隔行
        rank = int(rank_txt)

        # 队伍单元格是 "teamA<br/>TEAM0<br/>浙江工业大学"
        team_lines = [_clean(x) for x in tds[1].get_text('\n', strip=True).split('\n')]
        team_lines = [x for x in team_lines if x]
        team_id = team_lines[0] if team_lines else ''
        team_name = team_lines[1] if len(team_lines) > 1 else team_id
        school = ' '.join(team_lines[2:]) if len(team_lines) > 2 else ''

        solved = _clean(tds[2].get_text(' ', strip=True))
        penalty = _clean(tds[3].get_text(' ', strip=True))

        results = {}
        for p in problems:
            if p['col'] >= len(tds):
                continue
            td = tds[p['col']]
            classes = td.get('class') or []
            text = _clean(td.get_text(' ', strip=True))

            state = 'empty'
            if 'rank-status-accepted' in classes or 'rank-status-fb' in classes:
                state = 'accepted'
            elif 'rank-status-solved' in classes:
                state = 'solved'
            elif 'rank-status-trying' in classes:
                state = 'trying'

            if state == 'empty':
                state_counter[state] += 1
                continue

            item = {'state': state}

            # ★ 关键判据：**有没有时刻**，而不是 class 名。
            #
            # 实测三种格子的文本形态（这是本解析器最容易搞错的地方）：
            #   rank-status-accepted  '01:06:30 (-1)'   → 有时刻 = 已通过
            #   rank-status-fb        '00:10:33'        → 首杀，也是通过
            #   rank-status-solved    '+'  /  '+ (-12)' → **没有时刻 = 尝试未通过**
            #   rank-status-trying    '(-1)' / '(-14)'  → 未通过
            #   rank-status-empty     ''                → 未提交
            #
            # 按 class 名把 `solved` 一律当成"已通过"，会导致
            # 「通过队伍数」虚高（1001 报 816，实际 677），并且和
            # 榜单的 Solved 列自相矛盾（816 > 有效队伍 791）。
            m = TIME_RE.search(text)
            if m:
                item['time'] = m.group(1)
                item['passed'] = True
            else:
                item['passed'] = False

            m = WRONG_RE.search(text)
            if m:
                item['wrong'] = int(m.group(1))

            link = td.find('a', class_='rank-status-code-link') or td.find('a')
            if link and link.get('href'):
                href = link['href']
                m = RID_RE.search(href)
                if m:
                    item['runId'] = m.group(1)
                if not contest_id:
                    m = CID_RE.search(href)
                    if m:
                        contest_id = m.group(1)

            # 首杀标记（class 里已有，但记录一下便于统计）
            if 'rank-status-fb' in classes:
                item['firstBlood'] = True

            results[p['pid']] = item

        teams.append({
            'rank': rank,
            'teamId': team_id,
            'teamName': team_name,
            'school': school,
            'solved': int(solved) if solved.isdigit() else 0,
            'penalty': penalty,
            'results': results,
        })

    # ---- 每个题：有提交（含 AC）的队伍数 ----
    for p in problems:
        pid = p['pid']
        p['teams'] = sum(1 for t in teams if pid in t['results'] and t['results'][pid]['state'] != 'empty')

    teams.sort(key=lambda t: t['rank'])

    # ---- 比赛名 / 时间：**本页没有** ----
    # 实测：榜单 HTML 里搜不到比赛名，也没有 "Contest Time" 字样
    # （含"Contest" 仅 1 次，就是 <title>Rank</title> 附近）。
    # 所以这两个字段一律留空 —— 比赛名/时间请从 Hdu_contests.json 取。
    # 本页能提供的比赛标识只有 contestId（从 code link 的 cid= 得到）。
    contest_name = ''
    contest_time = ''

    return {
        'source': source,
        'contestId': contest_id,
        'contestName': contest_name,   # 本页取不到，由调用方用 Hdu_contests.json 补
        'contestTime': contest_time,
        'problems': problems,
        'teams': teams,
        '_stateCounter': dict(state_counter),
    }


def main(argv):
    ap = argparse.ArgumentParser(description='解析 HDU 榜单 HTML')
    ap.add_argument('file')
    ap.add_argument('-o', '--out', help='输出 JSON（缺省只打印摘要）')
    args = ap.parse_args(argv)

    with open(args.file, 'r', encoding='utf-8-sig', errors='replace') as f:
        html = f.read()

    data = parse_pages(html, source=args.file)
    teams = data['teams']
    problems = data['problems']

    print(f'✅ 解析完成：{args.file}')
    print(f'   contestId : {data["contestId"] or "(未从链接取到)"}')
    print(f'   页数      : {data.get("pages", 1)}'
          + ('   ← 多页合并文件' if data.get('pages', 1) > 1 else '')
          + '   （单页时数据不完整！见页面 Export csv）')
    print(f'   队伍      : {len(teams)}')
    print(f'   题目      : {len(problems)}')
    print(f'   格子状态  : {data["_stateCounter"]}')
    print()
    print('   表头数字（**与格子数据对不上**，仅作参考；勿用作通过率）：')
    for p in problems:
        rate = f'{p["accepted"] / p["submitted"] * 100:5.1f}%' if p['submitted'] else '  -  '
        print(f'     {p["pid"]}  {p["accepted"]:>5} / {p["submitted"]:>5}  {rate}'
              f'   有提交队伍 {p["teams"]}')
    print('   （要"通过队伍数 / 有效队伍数"的通过率，请跑 hdu_rank_stats.py）')

    if teams:
        print()
        print('   前 3 名：')
        for t in teams[:3]:
            print(f'     #{t["rank"]:<3} {t["teamName"]} ({t["school"]}) '
                  f'解出 {t["solved"]} 罚时 {t["penalty"]}')

    if args.out:
        out = dict(data)
        out.pop('_stateCounter', None)
        with open(args.out, 'w', encoding='utf-8') as f:
            json.dump(out, f, ensure_ascii=False, indent=2)
        print(f'\n✅ 已写出 {args.out}')
    else:
        print('\n（加 -o out.json 可写出解析结果）')

    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
