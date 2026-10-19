#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
QOJ 题目列表（存下来的 HTML）→ `qoj_problems.json`

和 `QOJ_submissions_scraper.py` 同一套用法：存页面 → 跑脚本（默认**合并**）→
清单里引用。为什么需要它：题名/链接在 XCPC 里通常由 rankland 的 srk 提供，
但"某场在 QOJ 上、rankland 还没收录"时，这份就是题名的来源。

用法
----
    py QOJ_problems_scraper.py                        # 读 qoj_contest.html → 合并写 qoj_problems.json
    py QOJ_problems_scraper.py -i x.html -o y.json
    py QOJ_problems_scraper.py --replace              # 覆盖写
    py QOJ_problems_scraper.py --dry-run
"""

from __future__ import annotations

import argparse
import os
import re
import sys

sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, 'lib'))

from bs4 import BeautifulSoup  # noqa: E402

from qoj_common import (  # noqa: E402
    contest_ids, fmt_counts, load_json_list, merge_by_key, resolve_path, write_json_list,
)

DEFAULT_HTML = 'qoj_contest.html'
DEFAULT_OUT = 'qoj_problems.json'
KEY = '题目ID'

BASE_URL = 'https://qoj.ac'


def parse_problems(filepath):
    with open(filepath, "r", encoding="utf-8-sig", errors="replace") as f:
        html = f.read()
    soup = BeautifulSoup(html, "html.parser")

    # 定位题目表格：第一个 table-bordered 是题目列表
    table = soup.find("table", class_="table-bordered")
    if not table:
        raise ValueError(
            "未找到题目表格（table.table-bordered）—— "
            "确认存的是**比赛题目列表**页面的 HTML，且页面已完整加载")
    tbody = table.find("tbody")
    if not tbody:
        raise ValueError("表格没有 tbody（页面可能是登录/验证页，或没加载完）")

    result = []
    skipped = 0
    for row in tbody.find_all("tr"):
        cols = row.find_all("td")
        if len(cols) < 2:
            skipped += 1
            continue

        # 题号（可能带有 class="table-success" 表示已通过）
        label_td = cols[0]
        label = label_td.text.strip()
        solved = "table-success" in (label_td.get("class") or [])

        # 题目名称与链接
        title_td = cols[1]
        title_tag = title_td.find("a")
        if not title_tag:
            skipped += 1
            continue
        title = title_tag.text.strip()
        href = title_tag.get("href", "")

        # 从 /contest/4071/problem/20016 中提取题目 ID
        problem_id = ""
        m = re.search(r"/problem/(\d+)", href)
        if m:
            problem_id = m.group(1)

        full_url = BASE_URL + href if href.startswith("/") else href

        result.append({
            "题号": label,
            "题目名称": title,
            "题目ID": problem_id,
            "题目链接": full_url,
            "是否通过": solved
        })

    return result, skipped


def main(argv):
    ap = argparse.ArgumentParser(description='QOJ 题目列表 HTML → JSON（默认合并）')
    ap.add_argument('-i', '--in', dest='inp', default='', help=f'输入 HTML（默认 {DEFAULT_HTML}）')
    ap.add_argument('--file', dest='inp_alias', default='', help='同 -i')
    ap.add_argument('-o', '--out', dest='out', default='', help=f'输出 JSON（默认 {DEFAULT_OUT}）')
    ap.add_argument('--output', dest='out_alias', default='', help='同 -o')
    ap.add_argument('--replace', action='store_true', help='覆盖写，不与已有文件合并')
    ap.add_argument('--dry-run', action='store_true', help='只解析并打印，不写文件')
    args = ap.parse_args(argv)

    html_path = resolve_path(args.inp or args.inp_alias, DEFAULT_HTML)
    out_path = resolve_path(args.out or args.out_alias, DEFAULT_OUT)

    if not os.path.isfile(html_path):
        print(f'❌ 找不到 HTML：{html_path}\n'
              f'   先在 QOJ 打开比赛题目列表页面 → Ctrl+S 存成这个文件', file=sys.stderr)
        return 1

    try:
        rows, skipped = parse_problems(html_path)
    except ValueError as e:
        print(f'❌ {e}', file=sys.stderr)
        return 1

    print(f'📄 解析 {os.path.basename(html_path)} → {len(rows)} 条'
          + (f'（另有 {skipped} 行不像题目行，已跳过）' if skipped else ''))
    if not rows:
        print('⚠️ 一条都没解析到 —— 确认存的是比赛题目列表页、且不是登录页')
        return 1
    print(f'   比赛号分布：{fmt_counts(contest_ids(rows, ("题目链接",)))}')

    if args.dry_run:
        print('（--dry-run：没有写文件）')
        return 0

    existing = [] if args.replace else load_json_list(out_path)
    merged, added, updated, nokey = merge_by_key(existing, rows, KEY)

    mode = '覆盖' if args.replace else '合并'
    if not args.replace and not added and not updated:
        print(f'✅ {out_path}')
        print(f'   （{mode}）内容本来就是最新的：合计 {len(merged)} 条，**未重写文件**')
        return 0
    write_json_list(out_path, merged)

    print(f'💾 {out_path}')
    print(f'   （{mode}）新增 {added} 条、更新 {updated} 条、合计 {len(merged)} 条'
          + (f'；{nokey} 条没有 {KEY} 只能追加' if nokey else ''))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
