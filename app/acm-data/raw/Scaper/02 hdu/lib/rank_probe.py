#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
榜单 HTML 结构探查（只输出摘要，不输出原文）

用途：hdu1_rank.html 有 31 万字节，整文件喂给模型极贵。
本脚本把它压成几百行的结构摘要，让开发者/模型能据此写解析器。

用法：
    python "acm-data/raw/Scaper/02 hdu/lib/rank_probe.py" "acm-data/raw/Scaper/02 hdu/26hdu/26hdu3/hdu_cid1231_rank.html"
    python "acm-data/raw/Scaper/02 hdu/lib/rank_probe.py" "acm-data/raw/Scaper/02 hdu/26hdu/26hdu3/hdu_cid1231_rank.html" --rows 5
"""

from __future__ import annotations

import argparse
import re
import sys
from collections import Counter

try:
    from bs4 import BeautifulSoup
except ImportError:
    sys.exit('需要 beautifulsoup4：pip install beautifulsoup4')


def text_of(el, limit=60) -> str:
    t = ' '.join(el.get_text(' ', strip=True).split())
    return t if len(t) <= limit else t[:limit] + '…'


def main(argv):
    ap = argparse.ArgumentParser(description='榜单 HTML 结构探查（输出摘要）')
    ap.add_argument('file')
    ap.add_argument('--rows', type=int, default=3, help='样例行数（默认 3）')
    ap.add_argument('--max-tables', type=int, default=6)
    args = ap.parse_args(argv)

    with open(args.file, 'r', encoding='utf-8-sig', errors='replace') as f:
        html = f.read()

    print(f'文件: {args.file}')
    print(f'大小: {len(html):,} 字符')
    soup = BeautifulSoup(html, 'html.parser')

    # ---- 页面里出现了什么脚本/接口线索 ----
    print('\n=== 脚本 / 接口线索 ===')
    for tag in soup.find_all(['script', 'link']):
        src = tag.get('src') or tag.get('href') or ''
        if src:
            print('  ', src)

    # 内联 script 里的关键字（可能是前端渲染的数据源）
    inline = [s.get_text() for s in soup.find_all('script') if not s.get('src')]
    for kw in ['rankings', 'problemInfo', 'balloon', 'submissions',
               'xcpcRankings', '__INITIAL', 'window.__']:
        hit = [s for s in inline if kw in s]
        if hit:
            print(f'   内联 script 含 {kw!r}：{len(hit)} 处，'
                  f'共 {sum(len(s) for s in hit):,} 字符')
            # 给一小段上下文，便于判断是不是 JSON 数据源
            m = re.search(r'.{0,80}' + re.escape(kw) + r'.{0,120}', hit[0], re.S)
            if m:
                print('     片段:', ' '.join(m.group(0).split())[:220])

    # ---- 所有 table ----
    tables = soup.find_all('table')
    print(f'\n=== 表格：共 {len(tables)} 个 ===')
    for ti, table in enumerate(tables[:args.max_tables]):
        rows = table.find_all('tr')
        header = rows[0] if rows else None
        ths = header.find_all(['th', 'td']) if header else []
        print(f'\n--- table[{ti}]  class={table.get("class")}  行数={len(rows)}  '
              f'表头单元格={len(ths)} ---')
        if ths:
            labels = [text_of(t, 20) for t in ths]
            print('  表头:', ' | '.join(labels))

        body = rows[1:] if len(rows) > 1 else rows
        for ri, row in enumerate(body[:args.rows]):
            tds = row.find_all(['td', 'th'])
            cells = []
            for td in tds:
                extra = []
                if td.get('colspan'):
                    extra.append(f'colspan={td["colspan"]}')
                if td.get('rowspan'):
                    extra.append(f'rowspan={td["rowspan"]}')
                # 单元格里的链接/图片（状态常用图标表示）
                if td.find('a'):
                    extra.append('a')
                if td.find(['svg', 'img']):
                    extra.append('icon')
                cells.append(text_of(td, 24) + (f'[{",".join(extra)}]' if extra else ''))
            print(f'  row[{ri}]:', ' | '.join(cells))

        # 列数分布（判断有无 colspan 混乱）
        widths = Counter(len(r.find_all(['td', 'th'])) for r in body)
        print('  各行列数分布:', dict(widths.most_common(6)))

    # ---- 关键词计数（判断榜单里有没有"队伍/题目"等信息）----
    print('\n=== 关键词出现次数 ===')
    raw = html
    for kw in ['队伍', '排名', '题号', '气球', 'Team', 'Rank', 'Solved',
               'AC', '罚时', 'Through', 'Frozen']:
        c = raw.count(kw)
        if c:
            print(f'  {kw!r}: {c}')

    print('\n（本脚本只输出摘要；完整数据请另写解析器）')


if __name__ == '__main__':
    main(sys.argv[1:])
