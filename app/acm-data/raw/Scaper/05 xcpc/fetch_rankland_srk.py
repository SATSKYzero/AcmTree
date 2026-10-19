#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
按 slug 下载某场的 RankLand 榜单（`.srk.json`）到 `cache/`。

为什么要有它：**场次身份（slug）与题目名/链接都从这份文件来**
（PTA 榜单只给题号 A~L 和通过数，没有题名）。

用法：
    python fetch_rankland_srk.py icpc2026preliminary-2
    python fetch_rankland_srk.py icpc2026preliminary-2 -o cache/xxx.srk.json
    python fetch_rankland_srk.py --list icpc2026     # 列出某年/某省份有哪些场次

产出：`cache/<slug>.srk.json`（原样保存，不加工 —— 加工是 srk_adapter.py 的事）
"""

from __future__ import annotations

import argparse
import json
import os
import sys

sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, 'lib'))
sys.path.insert(0, os.path.abspath(os.path.join(HERE, '..', 'lib')))   # Scaper/lib（通用读取层）

from rankland_tree import fetch_config_text, fetch_repo_file, iter_contests  # noqa: E402
from read_modes import print_stats, add_cli_args, configure_from, should_refetch  # noqa: E402


def digest(d: dict) -> str:
    """一句话摘要，便于确认"下对了文件" """
    contest = d.get('contest') or {}
    title = contest.get('title')
    if isinstance(title, dict):
        title = title.get('zh-CN') or title.get('fallback') or ''
    return (f"{title}  |  {contest.get('startAt', '')}  |  "
            f"{len(d.get('problems') or [])} 题 / {len(d.get('rows') or [])} 队")


def main(argv):
    ap = argparse.ArgumentParser(description='下载某场的 rankland srk 榜单')
    ap.add_argument('slug', nargs='?', help='场次 slug（如 icpc2026preliminary-2）')
    ap.add_argument('-o', '--output', default='', help='输出路径；默认 cache/<slug>.srk.json')
    ap.add_argument('--list', metavar='前缀', default='', help='只列出 slug 以该前缀开头的场次')
    # `--force`（"即使本地已有也重下"）来自**通用读取层**：这里就是它的本义
    add_cli_args(ap)
    args = ap.parse_args(argv)
    configure_from(args)

    contests = iter_contests(fetch_config_text())

    if args.list is not None and args.list:
        hit = [c for c in contests if c['slug'].startswith(args.list)]
        print(f'以 {args.list!r} 开头的场次（{len(hit)}）：')
        for c in hit:
            print(f"   {c['slug']:<38} {c['name']}")
        return 0

    if not args.slug:
        print('要给一个 slug（或 --list <前缀> 看看有哪些）', file=sys.stderr)
        return 2

    hit = next((c for c in contests if c['slug'] == args.slug), None)
    if not hit:
        near = [c['slug'] for c in contests if args.slug.split('preliminary')[0][:6] in c['slug']][:8]
        print(f'❌ rankland 树里没有 slug={args.slug}' + (f'；相近的：{near}' if near else ''))
        return 1

    out = args.output or os.path.join(HERE, 'cache', f"{args.slug}.srk.json")
    if not should_refetch(os.path.isfile(out)):
        d = json.load(open(out, encoding='utf-8-sig'))
        print(f'📦 用缓存（--force 可重下）：{os.path.relpath(out, HERE)}')
        print(f'   {digest(d)}')
        return 0

    print(f"↓ {hit['repo_path']}")
    raw = fetch_repo_file(hit['repo_path'])
    data = json.loads(raw.decode('utf-8'))

    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    with open(out, 'wb') as f:
        f.write(raw)

    print(f"✅ {os.path.relpath(out, HERE)}  （{len(raw) / 1024:.0f} KB）")
    print(f"   {hit['name']}")
    print(f"   {digest(data)}")
    print_stats('rankland 榜单')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
