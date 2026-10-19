#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
HDU 比赛列表解析（HTML → Hdu_contests.json）

数据来源
--------
**推荐**：打开 HDU 比赛列表页 → F12 控制台粘 `save-hdu-page.js` →
按规范名下载 `hdu_contests_source.html`（**不用剪贴板**）。

**手动**：控制台执行 `copy(document.documentElement.outerHTML)`（DevTools 自带的
`copy()`，不受"页面未聚焦"限制），粘进 `hdu_contests_source.html`。

用法
----
    # 默认（输入输出都在脚本同目录）
    python Hdu_contest_list_scraper.py

    # 明确指定（推荐；批处理脚本会这么调）
    python Hdu_contest_list_scraper.py -i Hdu_contest_list_source.html -o Hdu_contests.json

实现说明
--------
输入输出都可传参（`-i` / `-o`），默认值固定为脚本同目录。
输出写死在"当前工作目录"的话，从别的目录运行时会把文件生成到意外的地方（实测踩过），
所以默认值按脚本同目录来，传参与不传参都能跑。
"""

from __future__ import annotations

import argparse
import json
import os
import sys

# 不要生成 __pycache__（下面要 import lib/hdu_common.py）
sys.dont_write_bytecode = True

try:
    from bs4 import BeautifulSoup
except ImportError:
    sys.exit('需要 beautifulsoup4：pip install beautifulsoup4')

HERE = os.path.dirname(os.path.abspath(__file__))

# ---- 接上公共工具（lib/hdu_common.py）----
sys.path.insert(0, HERE if os.path.basename(HERE) == 'lib'
                else os.path.join(HERE, 'lib'))
from hdu_common import add_prefix, write_json  # noqa: E402


def parse_contest_list(filepath: str) -> list:
    # 按顺序尝试多种编码（HDU 页面有时是 GB 系）
    html = None
    for enc in ('utf-8', 'gbk', 'gb18030', 'gb2312'):
        try:
            with open(filepath, 'r', encoding=enc, errors='ignore') as f:
                html = f.read()
            break
        except Exception:
            continue
    if html is None:
        raise ValueError('无法解码文件，请检查文件格式')

    soup = BeautifulSoup(html, 'html.parser')
    table = soup.find('table', class_='table_text')
    if not table:
        raise ValueError("未找到 class='table_text' 的表格")

    rows = table.find_all('tr')
    if len(rows) < 2:
        raise ValueError('表格行数不足')

    contests = []
    for row in rows[1:]:
        tds = row.find_all('td')
        if len(tds) < 6:
            continue
        contest_id = tds[0].text.strip()
        name_td = tds[1]
        a_tag = name_td.find('a')
        if a_tag:
            contest_name = a_tag.text.strip()
            contest_link = add_prefix(a_tag.get('href', ''))
        else:
            contest_name = name_td.text.strip()
            contest_link = ''
        start_time = tds[2].text.strip()
        type_plain = tds[3].text.strip()
        status = tds[4].text.strip()
        register_td = tds[5]
        register_info = register_td.text.strip()
        reg_a = register_td.find('a')
        register_link = add_prefix(reg_a.get('href')) if reg_a and reg_a.get('href') else ''
        extra_info = tds[6].text.strip() if len(tds) >= 7 else ''
        contests.append({
            'contest_id': contest_id,
            'contest_name': contest_name,
            'link': contest_link,
            'start_time': start_time,
            'type': type_plain,
            'status': status,
            'register_info': register_info,
            'register_link': register_link,
            'extra': extra_info,
        })

    contests.sort(key=lambda x: int(x['contest_id']) if x['contest_id'].isdigit() else 0)
    return contests


def main(argv):
    ap = argparse.ArgumentParser(description='HDU 比赛列表 HTML → hdu_contests.json')
    ap.add_argument('-i', '--input', required=True,
                    help='比赛列表页 HTML（save-hdu-page.js 或浏览器控制台存的）')
    ap.add_argument('-o', '--output', default='',
                    help='输出路径；不给就写成输入文件旁边的 hdu_contests.json')
    args = ap.parse_args(argv)

    try:
        data = parse_contest_list(args.input)
    except Exception as e:
        print(f'解析失败: {e}', file=sys.stderr)
        return 1

    # 与另外两个爬虫一致：输出落在**输入 HTML 旁边**，名字固定是 hdu_contests.json
    # （它是一份比赛**列表**，本身没有 cid，所以名字里不带 cid）
    out = args.output or os.path.join(
        os.path.dirname(os.path.abspath(args.input)), 'hdu_contests.json')

    write_json(out, data)
    print(f'✅ 共解析到 {len(data)} 场比赛 → {out}')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
