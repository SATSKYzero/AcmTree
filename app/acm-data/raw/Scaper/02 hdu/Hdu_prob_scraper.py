#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
HDU 题目列表解析（HTML → hdu_cid<CID>_problems.json）

数据来源（二选一）
------------------
**推荐**：打开该场比赛的 Problems 页 → F12 控制台粘 `save-hdu-page.js` →
它按规范名下载 `hdu_cid<CID>_problems_source.html`（**不用剪贴板**）。

**手动**：控制台执行

    navigator.clipboard.writeText(document.documentElement.outerHTML)

⚠️ 剪贴板 API 要求**页面获得焦点**，在 DevTools 里常报
`NotAllowedError: Document is not focused`。绕法见 _usage.md；
实在要用就用 DevTools 自带的 `copy(document.documentElement.outerHTML)`。

**这个 HTML 文件叫什么名字？**
    输入文件名**随便**（`-i` 指过去就行）—— 流水线不看输入名。
    只有两处名字有意义：

      1. **不给 -i 时**的默认输入名：与本脚本同目录的 `Hdu_prob_source.html`
         （仅为兼容；建议总是显式 `-i`）
      2. **输出名**（真正影响流水线能不能认出来）：
         `Hdu_problems.json` 靠**内容**里的题目链接认 cid；
         想让它"自带身份、放哪都行"，加 `--named`，
         会写成 `hdu_cid<CID>_problems.json`（推荐）。

用法
----
    # 默认（输入输出都在脚本同目录）
    python Hdu_prob_scraper.py

    # 明确指定（推荐；批处理脚本会这么调）
    python Hdu_prob_scraper.py -i 26hdu3/Hdu_prob_source.html -o 26hdu3/Hdu_problems.json

    # 输出名自带比赛 ID（放在输入文件旁边）
    python Hdu_prob_scraper.py -i 26hdu3/Hdu_prob_source.html --named
    #   → 26hdu3/hdu_cid1231_problems.json

输出字段
--------
    problem_id    平台数字题号（1001…）
    problem_id2   字母题号（A…T），由 1001→A 映射而来
    title         题名
    link          题目链接（含 cid= / pid=）
    ratio         页面上的历史通过率字符串（**不是赛时数据，通常不用**）
    accepted/submitted  历史计数（同上，不用）
    solved        该队是否已解出（用于交叉校验，不写进节点）

实现说明
--------
输入输出都可传参（`-i` / `-o`），便于按场次分目录保存；
输出写死在"当前工作目录"的话，每爬一场都会覆盖同一个文件。
字母映射带**边界检查**：chr(ord('A') + (pid - 1001)) 在
pid 超出 1001..1020 时会算出 '@' / '[' 这类怪字符，会静默污染数据。
喂错文件（比如把 JSON 当 HTML）会**直接报错**，不再写出一个 0 条的空文件。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys

# 不要生成 __pycache__（下面要 import lib/hdu_common.py）
sys.dont_write_bytecode = True

try:
    from bs4 import BeautifulSoup
except ImportError:
    sys.exit('需要 beautifulsoup4：pip install beautifulsoup4')

HERE = os.path.dirname(os.path.abspath(__file__))

# ---- 接上公共工具（lib/hdu_common.py）----
# 字母表、add_prefix、cid 提取、读 JSON 都在那里有一份 —— 不再各脚本抄一遍
sys.path.insert(0, HERE if os.path.basename(HERE) == 'lib'
                else os.path.join(HERE, 'lib'))
from hdu_common import (  # noqa: E402
    LETTER_BASE, LETTER_MAX, letter_of, add_prefix, cid_of_links, write_json,
)


def parse_ratio(ratio_str: str):
    """从 '40.82% (1161/2844)' 解析出 (通过数, 提交数)"""
    m = re.search(r'\((\d+)/(\d+)\)', ratio_str)
    if m:
        return int(m.group(1)), int(m.group(2))
    return None, None


def parse_problems(filepath: str) -> list:
    with open(filepath, 'r', encoding='utf-8-sig', errors='ignore') as f:
        html = f.read()
    soup = BeautifulSoup(html, 'html.parser')

    rows = soup.select('tr.page-card-row, tr.page-card-row.striped')
    rows = list({row for row in rows})   # 去重

    # ⚠️ 必须在这里拦住"喂错文件"：
    #    什么都不查的话，`-i 某.json` 会一路解析出 0 道题，
    #    然后**把 0 条的 JSON 写进输出文件** —— 静默产出空数据，
    #    还顺手覆盖掉正确的那份。宁可报错。
    if not rows:
        raise ValueError('未找到题目行（tr.page-card-row）—— 输入是不是 HTML？'
                         '是不是该场比赛的 Problems 页？')

    problems = []
    for row in rows:
        tds = row.find_all('td')
        if len(tds) < 4:
            continue

        solved_td = tds[0]
        svg = solved_td.find('svg')
        solved = bool(svg and svg.get('style') and 'fill: #008000' in svg.get('style', ''))

        problem_id = tds[1].text.strip()
        problem_id2 = letter_of(problem_id)      # ★ 带边界检查

        a_tag = tds[2].find('a')
        if a_tag:
            title = a_tag.text.strip()
            link = add_prefix(a_tag.get('href', ''))
        else:
            title = tds[2].text.strip()
            link = ''

        ratio_str = ' '.join(tds[3].text.strip().split())
        accepted, submitted = parse_ratio(ratio_str)

        problems.append({
            'problem_id': problem_id,
            'problem_id2': problem_id2,
            'title': title,
            'link': link,
            'ratio': ratio_str,
            'accepted': accepted,
            'submitted': submitted,
            'solved': solved,
        })

    problems.sort(key=lambda x: int(x['problem_id']) if x['problem_id'].isdigit() else 0)
    return problems


def main(argv):
    ap = argparse.ArgumentParser(description='HDU 题目列表 HTML → hdu_cid<CID>_problems.json')
    ap.add_argument('-i', '--input', required=True,
                    help='题目页 HTML（浏览器里 copy(document.documentElement.outerHTML) 存下来的）')
    ap.add_argument('-o', '--output', default='',
                    help='输出路径；不给就写成输入文件旁边的 hdu_cid<CID>_problems.json')
    args = ap.parse_args(argv)

    try:
        data = parse_problems(args.input)
    except Exception as e:
        print(f'解析失败: {e}', file=sys.stderr)
        return 1

    # 输出名一律带 cid：文件自带身份，放哪个目录都能被流水线认出来。
    # 不给 -o 时就是这条规则；给了 -o 就按你的来（但流水线只认规范名）。
    out = args.output
    if not out:
        cid = cid_of_links(data)
        if not cid:
            print('❌ 题目里认不出 cid（题目链接里没有 cid=）—— 无法生成规范文件名。'
                  '请用 -o 指定输出路径。', file=sys.stderr)
            return 1
        out = os.path.join(os.path.dirname(os.path.abspath(args.input)),
                           f'hdu_cid{cid}_problems.json')

    write_json(out, data)

    no_letter = [p['problem_id'] for p in data if not p['problem_id2']]
    print(f'✅ 共解析到 {len(data)} 道题 → {out}')
    if no_letter:
        print(f'   ⚠️ {len(no_letter)} 道题超出 {LETTER_BASE}..'
              f'{LETTER_BASE + LETTER_MAX - 1}，算不出字母题号：{", ".join(no_letter)}',
              file=sys.stderr)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
