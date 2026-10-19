#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
rankland（srk）榜单 → crate 片段（题名 / 链接，必要时也算 ratio）

两种角色（由清单里的 `role` 决定）
----------------------------------
* `titles`（默认）：**只补题名与链接**，不算 ratio。
  为什么：ratio 的分子分母必须来自**同一份榜单**，否则会莫名差一点
  （实测 ICEC 第二场：PTA 榜 2494 支有效队伍，srk 的 rows 只有 2622 行 /
  2480 支，逐格数出来每题少 1 —— 而 srk 自己的 `statistics` 与 PTA 完全一致）。
* `board`：这场就用 srk 当权威榜单，C 的链接与 P 的 ratio 都由它算。
  ratio 的分子取 `problems[].statistics.accepted`？**不** —— 那与 rows 可能
  对不上；统一按行的 `statuses[].result == "AC"` 逐格数，口径与 PTA 一致。

srk 文件里有什么（实测，version 0.3.9）
----------------------------------------------
    contest.title{zh-CN,fallback} / startAt / duration / refLinks[]（原始榜单地址）
    problems[]  {alias:"A", title:"All Closed", link:"…/gym/106701/problem/A", statistics:{accepted,submitted}}
    rows[]      {user:{id,name,organization,…}, score:{value,time}, statuses:[{result,tries,time,solutions[]}]}

⚠️ `problems[].link` 常常直接指向 **Codeforces gym** —— 这就是"提交来源"的线索。

用法
----
    python srk_adapter.py icpc2026preliminary-2
    python srk_adapter.py icpc2026preliminary-2 --role board
    python srk_adapter.py icpc2026preliminary-2 -o out.json
"""

from __future__ import annotations

import argparse
import os
import re
import sys

sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, 'lib'))

from xcpc_common import (add_crate_path,  # noqa: E402
    title_of,
    CACHE, contest_key, find_contest, fmt_ratio, layers_of, load_manifest, mid_key,
    norm_letter, open_tree, platform_key, problem_key, read_json, rel, resolve, series_key,
    xcpc_nature,
)
from read_modes import add_cli_args, configure_from, forced  # noqa: E402

add_crate_path()

from crate import Crate, to_cst, validate_crate  # noqa: E402

LABEL = 'RankLand(srk) 榜单'
SOURCE = 'srk'          # 它那棵树：`aux-srk`


def analyze(data: dict) -> dict:
    """
    从 srk 里取出需要的东西，并把"行数 vs statistics"的差异查出来。

    @returns {meta, effectiveTeams, teams, letters, titles, links,
              solved_by_letter, accepted_stat, gym}
    """
    contest = data.get('contest') or {}
    problems = data.get('problems') or []
    rows = data.get('rows') or []

    letters, titles, links, accepted_stat = [], {}, {}, {}
    for i, p in enumerate(problems):
        letter = norm_letter(p.get('alias')) or chr(ord('A') + i)
        letters.append(letter)
        titles[letter] = str(p.get('title') or '')
        links[letter] = str(p.get('link') or '')
        st = p.get('statistics') or {}
        accepted_stat[letter] = int(st.get('accepted') or 0)

    solved = {letter: 0 for letter in letters}
    effective = 0
    for row in rows:
        statuses = row.get('statuses') or []
        ac = 0
        for i, s in enumerate(statuses):
            if not isinstance(s, dict) or i >= len(letters):
                continue
            if str(s.get('result') or '').upper() in ('AC', 'ACCEPTED', 'CORRECT'):
                ac += 1
                solved[letters[i]] = solved.get(letters[i], 0) + 1
        if ac > 0:
            effective += 1

    # CF gym 号：从任意一个 problems[].link 里认
    gyms = sorted({m.group(1) for m in
                   (re.search(r'codeforces\.com/gym/(\d+)', v) for v in links.values()) if m})

    return {
        'meta': {
            'name': title_of(contest),
            'startAt': to_cst(contest.get('startAt')),
            'duration': contest.get('duration'),
            'refLinks': contest.get('refLinks') or [],
        },
        'effectiveTeams': effective,
        'teams': len(rows),
        'letters': letters,
        'titles': titles,
        'links': links,
        'solved': solved,
        'accepted_stat': accepted_stat,
        'gyms': gyms,
    }


def report(stats: dict, role: str) -> list[str]:
    lines = [f"   {stats['meta']['name']}  |  {stats['meta']['startAt']}"
             f"  |  {len(stats['letters'])} 题 / {stats['teams']} 行"]
    for ref in stats['meta']['refLinks'][:3]:
        lines.append(f"   来源链接: {ref.get('title', '')} {ref.get('link', '')}")
    if stats['gyms']:
        lines.append(f"   Codeforces gym: {', '.join(stats['gyms'])}  ← 正赛提交在这里")
    if role == 'board':
        lines.append(f"   有效队伍（至少过 1 题）= {stats['effectiveTeams']}")
        for letter in stats['letters']:
            mine = stats['solved'].get(letter, 0)
            stat = stats['accepted_stat'].get(letter, 0)
            flag = '✓' if mine == stat else f'✗ 比 statistics 少 {stat - mine}（rows 被裁剪过）'
            lines.append(f"   {letter:>2}: 通过队伍 {mine:>5} → ratio "
                         f"{fmt_ratio(mine, stats['effectiveTeams']):>6}%   （statistics {stat} {flag}）")
    else:
        miss = [l for l in stats['letters'] if not stats['titles'].get(l)]
        lines.append(f"   只补题名/链接（不算 ratio，分子分母必须与榜单同源）"
                     + (f"；{len(miss)} 道题没题名" if miss else ''))
    return lines


def build(contest: dict, stats: dict, role: str) -> Crate:
    slug = contest['slug']
    series, mid = layers_of(contest)

    # role=board（rankland 的 rows 当权威榜单）→ kind='board'；只补题名（titles）→ script
    crate = Crate(source_id=f"srk-{slug}", label=LABEL, platform=SOURCE,
                  kind=('board' if role == 'board' else 'script'))
    # 骨架：O ─(W)aux「辅助节点」─(W)aux-srk
    open_tree(crate, SOURCE)
    parent = series_key(series['id'])
    crate.series(platform_key(), parent, name=series.get('name') or series['id'])
    if mid:
        ck_parent = mid_key(series['id'], mid['id'])
        crate.series(parent, ck_parent, name=mid.get('name') or mid['id'])
    else:
        ck_parent = parent

    ck = contest_key(slug)
    extra = {'contestTime': stats['meta']['startAt']} if stats['meta']['startAt'] else {}
    if role == 'board':
        extra['link'] = f"https://rl.algoux.cn/collection/official?rankId={slug}"
    # 性质：srk/rankland 是**收集源**（`aux-srk` 是它那棵树的名字），
    # 与"这场比赛是哪家的"无关 —— 这棵树上的 C 全是清单里的 XCPC 场次
    # ⇒ 大类恒为 `xcpc`，小类只认 1:1 的 icpc/ccpc，年份取清单 mid。判据见 `xcpc_common.xcpc_nature()`。
    crate.contest(ck_parent, ck, name=contest.get('name') or stats['meta']['name'],
                  **xcpc_nature(series, mid, contest.get('name') or '', channel='srk',
                                held_time=str(stats['meta']['startAt'] or '')), **extra)

    for letter in stats['letters']:
        kwargs = {'problem_id': letter}
        if stats['titles'].get(letter):
            kwargs['name'] = stats['titles'][letter]
        if stats['links'].get(letter):
            kwargs['link'] = stats['links'][letter]
        # 跨场身份：同一道题出现在多个比赛时共享同一个值（路线 C）。
        # 可靠的来源有两个，都取"题目平台的全局 id"（同一道题在不同场次里不变）：
        #   * Codeforces gym：`/gym/106701/problem/A` → `cf:gym:106701:A`
        #   * QOJ：`qoj.ac/problem/20016` → `qoj:20016`
        #     （2026 EC 网络赛第一场就挂在 QOJ 上；只认 gym 的话，那一场 14 道题
        #      全都没有身份键 —— 跨场聚合直接失效。）
        # 取不到就不写（宁可不给，也别给一个会变的身份）。
        link = stats['links'].get(letter) or ''
        if link:
            m = re.search(r'codeforces\.com/gym/(\d+)/problem/([A-Za-z0-9]+)', link)
            if m:
                kwargs['identityKey'] = f'cf:gym:{m.group(1)}:{m.group(2).upper()}'
            else:
                mq = re.search(r'qoj\.ac/problem/(\d+)', link)
                if mq:
                    kwargs['identityKey'] = f'qoj:{mq.group(1)}'
        if role == 'board':
            kwargs['ratio'] = fmt_ratio(stats['solved'].get(letter, 0), stats['effectiveTeams'])
        crate.problem(ck, problem_key(slug, letter), **kwargs)
    return crate


def main(argv):
    ap = argparse.ArgumentParser(description='rankland(srk) 榜单 → crate 片段')
    ap.add_argument('slug', nargs='?')
    ap.add_argument('-o', '--output', default='')
    ap.add_argument('--file', default='', help='临时指定 srk 文件')
    ap.add_argument('--role', choices=('titles', 'board'), default='',
                    help='默认取清单里的 role；titles=只补题名/链接')
    ap.add_argument('--manifest', default='')
    ap.add_argument('--no-fetch', action='store_true',
                    help='本地没有 srk 文件时不要联网抓')
    ap.add_argument('--quiet', action='store_true')
    add_cli_args(ap, force_help='**强制重抓**：把本地那份 srk 文件当成不存在 ⇒ 重新去 rankland 抓一份'
                                '（不给它时，只有"本地没有"才会抓）')
    args = ap.parse_args(argv)
    configure_from(args)

    manifest = load_manifest(args.manifest)
    if not args.slug:
        print('要给一个 slug', file=sys.stderr)
        return 2
    contest = find_contest(manifest, args.slug)

    entry = next((s for s in (contest.get('sources') or [])
                  if (s.get('source') or '') == 'srk'), None)
    role = args.role or ((entry or {}).get('role') or 'titles')
    path = resolve(args.file or (entry or {}).get('file', ''))
    # `--force`：把本地那份当成不存在 ⇒ 走"本地没有"那条路去重抓（同一个口径，不另写一遍抓取）
    if forced():
        path = ''
    if not path or not os.path.isfile(path):
        # 没文件就**按 slug 自己去 rankland 抓一份**。
        # 为什么必须自动：cache/ 是可以随时删的中间产物（README/说明里就是这么写的），
        # 删掉之后流水线不该跑不动 —— 手工步骤越少，越不容易在半年后卡住。
        if args.no_fetch:
            print(f'❌ 找不到 srk 文件：{path}（--no-fetch 不联网）', file=sys.stderr)
            return 1
        from rankland_tree import fetch_config_text, fetch_repo_file
        from rankland_tree import find_contest as rl_find
        hit = rl_find(fetch_config_text(), args.slug)
        if not hit:
            print(f'❌ rankland 树里没有 slug={args.slug}，'
                  f'也找不到本地文件 {path}\n'
                  f'   （清单里的 slug 写对了吗？`fetch_rankland_tree.py` 出清单）',
                  file=sys.stderr)
            return 1
        path = path or os.path.join(CACHE, f'{args.slug}.srk.json')
        print(f'↓ 本地没有，去 rankland 抓：{hit["repo_path"]}')
        raw = fetch_repo_file(hit['repo_path'])
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        with open(path, 'wb') as f:
            f.write(raw)
        print(f'   → {rel(path)}（{len(raw) / 1024:.0f} KB）')

    stats = analyze(read_json(path))
    if not args.quiet:
        print(f'📊 rankland srk → {args.slug}   （role={role}）')
        print('\n'.join(report(stats, role)))

    # ---- 空榜单护栏（同上：一道题都没有 = 文件不对）----
    if not stats['letters']:
        print(f'❌ 这份 srk 里一道题都没有（{path}）—— 文件是不是下错了？',
              file=sys.stderr)
        return 1
    crate = build(contest, stats, role)
    out = args.output or os.path.join(CACHE, f'crate_{args.slug}_srk.json')
    crate.save(out)
    issues = validate_crate(crate.to_dict())
    print(f'\n✅ {rel(out)}   {crate.summary()}')
    if issues:
        print(f'❌ 校验问题 {len(issues)}：')
        for it in issues:
            print('   •', it)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
