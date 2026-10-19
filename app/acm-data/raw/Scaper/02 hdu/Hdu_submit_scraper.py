#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
HDU 提交记录解析（HTML → hdu_cid<CID>_submits.json）

数据来源（二选一）
------------------
**推荐：一次性抓全部页** —— 打开该场比赛的 Status 页，F12 控制台粘贴
`fetch-hdu-submit.js`，它会自动翻页并下载 `hdu_cid<cid>_submit.html`
（多页用 `<!-- PAGE n -->` 分隔）。

**手动**（只有一页时也行）：粘 `save-hdu-page.js`（按规范名直接下载，
**不用剪贴板**），或控制台执行

    navigator.clipboard.writeText(document.documentElement.outerHTML)

⚠️ 剪贴板 API 要求**页面获得焦点**，在 DevTools 里常报
`NotAllowedError: Document is not focused`；绕法见 _usage.md。

把剪贴板内容粘进一个 HTML 文件。

**这个 HTML 文件叫什么名字？**
    输入文件名**随便**（`-i` 指过去就行）—— 流水线不看输入名。
    只有两处名字有意义：

      1. **不给 -i 时**的默认输入名：与本脚本同目录的 `Hdu_submit_source.html`
         （仅为兼容；建议总是显式 `-i`）
      2. **输出名**（真正影响流水线能不能认出来）：
         `Hdu_submits.json` 靠**内容**里的题目链接认 cid；
         想让它"自带身份、放哪都行"，加 `--named`，
         会写成 `hdu_cid<CID>_submits.json`（推荐）。

本脚本对**单页**和**多页拼接**都适用：
它按 `tr.page-card-row` 取行，并按「运行ID」去重，
所以拼进来的重复页/重叠页不会算两次。

用法
----
    # 默认（输入输出都在脚本同目录）
    python Hdu_submit_scraper.py

    # 明确指定（推荐；批处理脚本会这么调）
    python Hdu_submit_scraper.py -i 26hdu3/Hdu_submit_source.html -o 26hdu3/Hdu_submits.json
    python Hdu_submit_scraper.py -i hdu_submit_cid1231_all.html --named
    #   → hdu_submit_cid1231_all 旁边的 hdu_cid1231_submits.json

输出字段
--------
    运行ID / 提交链接 / 题号(数字) / 题号2(字母) / 题目链接
    运行结果(原文) / 运行结果2(AC/WA/…) / 结果链接
    运行时间(ms) / 使用内存(KB) / 使用语言 / 提交时间(已把 - 换成 .)

实现说明
--------
输入输出都可传参（`-i` / `-o`），便于按场次分目录保存；
输出写死在"当前工作目录"的话，每爬一场都会覆盖同一个文件。
字母映射带边界检查（见 Hdu_prob_scraper 的同名说明）。
读取兼容 BOM；末尾会报告"识别到几页 / 去重掉几条"，便于发现拼错文件。
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
sys.path.insert(0, HERE if os.path.basename(HERE) == 'lib'
                else os.path.join(HERE, 'lib'))
from hdu_common import (  # noqa: E402
    letter_of, add_prefix, cid_of_links, write_json,
)

# 运行结果原文 → 应用认识的简写
RESULT_MAP = {
    'Accepted': 'AC',
    'Wrong Answer': 'WA',
    'Time Limit Exceeded': 'TLE',
    'Memory Limit Exceeded': 'MLE',
    'Runtime Error': 'RE',
    'Compilation Error': 'CE',
    'Presentation Error': 'PE',
    'Output Limit Exceeded': 'OLE',
    'Running': 'RUN',
    'Queuing': 'QUE',
    'Compiling': 'CMP',
}


def extract_number(text: str) -> str:
    """从 '859 MS' / '2992 K' 里取数字部分"""
    m = re.search(r'\d+', text)
    return m.group(0) if m else '0'


def parse_status(status_text: str):
    """取主状态（忽略括号内附加信息）并映射成简写"""
    first = status_text.split('\n')[0].strip()
    if first in RESULT_MAP:
        return first, RESULT_MAP[first]
    for key in RESULT_MAP:
        if key in first:
            return first, RESULT_MAP[key]
    return first, first


def parse_submit_table(filepath: str) -> tuple[list, dict]:
    """
    解析单页 HTML **或** 多页拼接的 bundle。

    @returns (记录列表, 统计信息)
    """
    with open(filepath, 'r', encoding='utf-8-sig', errors='ignore') as f:
        html = f.read()
    soup = BeautifulSoup(html, 'html.parser')

    rows = soup.select('tr.page-card-row')
    if not rows:
        raise ValueError('未找到提交记录（tr.page-card-row），请检查 HTML 是否完整')

    records = []
    seen = set()
    dup = 0
    for row in rows:
        tds = row.find_all('td')
        if len(tds) < 7:
            continue

        run_id = tds[0].text.strip()
        if run_id in seen:
            dup += 1                 # 多页拼接时的重叠行，正常
            continue
        seen.add(run_id)

        submit_time = tds[1].text.strip().replace('-', '.')

        prob_a = tds[2].find('a')
        if prob_a:
            problem_id = prob_a.text.strip()
            problem_link = add_prefix(prob_a.get('href', ''))
        else:
            problem_id = tds[2].text.strip()
            problem_link = ''

        prob_letter = letter_of(problem_id)      # ★ 带边界检查

        time_ms = extract_number(tds[3].text.strip())
        mem_kb = extract_number(tds[4].text.strip())

        lang_a = tds[5].find('a')
        if lang_a:
            language = lang_a.text.strip()
            code_link = add_prefix(lang_a.get('href', ''))
        else:
            language = tds[5].text.strip()
            code_link = ''

        status_raw = tds[6].text.strip()
        status_text, status_abbr = parse_status(status_raw)

        records.append({
            '运行ID': run_id,
            '提交链接': code_link,
            '题号': problem_id,
            '题号2': prob_letter,
            '题目链接': problem_link,
            '运行结果': status_text,
            '运行结果2': status_abbr,
            '结果链接': code_link,
            '运行时间(ms)': time_ms,
            '使用内存(KB)': mem_kb,
            '使用语言': language,
            '提交时间': submit_time,
        })

    return records, {'rows': len(rows), 'duplicates': dup,
                     'pages': html.count('<!-- PAGE')}


def main(argv):
    ap = argparse.ArgumentParser(description='HDU 提交记录 HTML → hdu_cid<CID>_submits.json')
    ap.add_argument('-i', '--input', required=True,
                    help='提交页 HTML（单页，或 fetch-hdu-submit.js 的多页拼接）')
    ap.add_argument('-o', '--output', default='',
                    help='输出路径；不给就写成输入文件旁边的 hdu_cid<CID>_submits.json')
    args = ap.parse_args(argv)

    try:
        data, info = parse_submit_table(args.input)
    except Exception as e:
        print(f'解析失败: {e}', file=sys.stderr)
        return 1

    # 同 Hdu_prob_scraper：输出名一律带 cid（文件自带身份）
    out = args.output
    if not out:
        cid = cid_of_links(data)
        if not cid:
            print('❌ 提交里认不出 cid（题目链接里没有 cid=）—— 无法生成规范文件名。'
                  '请用 -o 指定输出路径。', file=sys.stderr)
            return 1
        out = os.path.join(os.path.dirname(os.path.abspath(args.input)),
                           f'hdu_cid{cid}_submits.json')

    write_json(out, data)

    unknown = sorted({r['运行结果'] for r in data if r['运行结果2'] not in
                      ('AC', 'WA', 'TLE', 'MLE', 'RE', 'CE', 'PE', 'OLE')})
    print(f'✅ 共解析到 {len(data)} 条提交 → {out}')
    if info['pages']:
        print(f'   识别到 {info["pages"]} 页，{info["rows"]} 行，'
              f'去重掉 {info["duplicates"]} 行重复')
    if unknown:
        print(f'   ℹ️ 有未映射的结果原文（会原样保留）：{", ".join(unknown)}')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
