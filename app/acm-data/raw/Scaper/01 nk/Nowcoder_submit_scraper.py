#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
牛客（Nowcoder）提交记录解析（HTML → nk_cid<CID>_submits.json）

数据来源
--------
**推荐：一次性抓全部页** —— 打开该场比赛的 Status 页，F12 控制台粘贴
`collect-nk-submit.js`，它会自动翻页并下载 `nk_cid<CID>_submit.html`
（多页用 `<!-- PAGE n -->` 分隔）。

**手动**（只有一页时也行）：打开 Status 页，F12 控制台执行

    copy(document.documentElement.outerHTML)

把剪贴板内容粘进一个 HTML 文件。牛客每页 20 条、分页器又是
`javascript:void(0)`（链接里没有页码），手动翻页很容易漏页/重页。

本脚本对**单页**和**多页拼接**都适用：它遍历文件里**所有**
`table.table-hover`，并按「运行ID」去重 ——
所以拼进来的重复页/重叠页不会算两次。

用法
----
    # 输入必给；不给 -o 时输出就写在**输入旁边**（规范名）
    python Nowcoder_submit_scraper.py -i 2026nk2/nk_cid133877_submit.html
    # → 2026nk2/nk_cid133877_submits.json

    # 想放别处就显式给 -o
    python Nowcoder_submit_scraper.py -i <源.html> -o <路径>/nk_cid133877_submits.json --quiet

输出字段
--------
    运行ID / 提交链接 / 用户名 / 用户主页 / 题号 / 题目链接
    运行结果(原文) / 运行结果2(AC/WA/…) / 结果链接
    运行时间(ms) / 使用内存(KB) / 代码长度 / 使用语言 / 提交时间(已把 - 换成 .)

行为说明
--------
- 输入输出可传参（`-o` 缺省时写到输入文件旁边的规范名），便于按场次分目录保存。
- 兼容带 BOM 的 HTML；末尾打印比赛 ID / 用户数 / 时间范围。
- **按「运行ID」去重**：多页拼接一旦重叠就会产出重复记录，
  而重复的 extKey 会让 `crate.py` 直接抛错（包内 extKey 必须唯一）。
"""

from __future__ import annotations

import argparse
import json
import os
import sys

try:
    from bs4 import BeautifulSoup
except ImportError:
    sys.exit('需要 beautifulsoup4：pip install beautifulsoup4')

HERE = os.path.dirname(os.path.abspath(__file__))

# 不要生成 __pycache__（下面要 import lib/nk_common.py）
sys.dont_write_bytecode = True

# ---- 接上公共工具（lib/nk_common.py）----
sys.path.insert(0, HERE if os.path.basename(HERE) == 'lib'
                else os.path.join(HERE, 'lib'))
from nk_common import (  # noqa: E402
    CONTEST_RE, write_json,
)


# 运行结果映射表
RESULT_MAP = {
    '答案正确': 'AC',
    '运行错误': 'RE',
    '答案错误': 'WA',
    '运行超时': 'TLE',
    '内存超限': 'MLE',
    '输出超限': 'OLE',
    '编译错误': 'CE',
    '浮点错误': 'RE',
    '段错误': 'RE',
    '返回非零': 'RE',
}


def add_prefix(url: str) -> str:
    """为相对链接添加牛客竞赛域名前缀"""
    if url and url.startswith('//'):
        return 'https:' + url
    if url and url.startswith('/'):
        return 'https://ac.nowcoder.com' + url
    return url


def parse_all_submit_tables(filepath: str) -> tuple[list[dict], dict]:
    """
    解析单页 HTML **或** 多页拼接的 bundle。

    牛客的 Status 页是**分页**的（每页 20 条），分页器又只有
    `javascript:void(0)`，所以只能把多页的表格拼在一个文件里。
    拼的时候难免重叠（或重跑时粘重），因此这里**按「运行ID」去重** ——
    否则重复的 extKey 会让 `Crate` 直接抛错（crate.py: extKey 包内必须唯一）。

    @returns (记录列表, 统计信息)
    """
    with open(filepath, 'r', encoding='utf-8-sig', errors='replace') as f:
        html = f.read()
    soup = BeautifulSoup(html, 'html.parser')

    tables = soup.find_all('table', class_='table-hover')
    if not tables:
        raise ValueError('未找到任何提交表格（class="table-hover"），请检查 HTML 是否完整')

    all_records = []
    seen = set()
    dup = 0
    total_rows = 0
    for table in tables:
        tbody = table.find('tbody')
        if not tbody:
            continue

        rows = tbody.find_all('tr')
        for row in rows:
            cols = row.find_all('td')
            if len(cols) < 9:
                continue
            total_rows += 1

            # ----- 1. 运行ID（带链接） -----
            run_tag = cols[0].find('a')
            run_id = run_tag.text.strip() if run_tag else cols[0].text.strip()
            if run_id in seen:
                dup += 1                    # 多页拼接时的重叠行，正常
                continue
            seen.add(run_id)
            run_url = run_tag.get('href') if run_tag else ''

            # ----- 2. 用户名（带链接） -----
            user_tag = cols[1].find('a')
            username = user_tag.text.strip() if user_tag else cols[1].text.strip()
            user_url = user_tag.get('href') if user_tag else ''

            # ----- 3. 题号（带链接） -----
            prob_tag = cols[2].find('a')
            problem = prob_tag.text.strip() if prob_tag else cols[2].text.strip()
            prob_url = prob_tag.get('href') if prob_tag else ''

            # ----- 4. 运行结果（带链接，通常与运行ID链接相同） -----
            res_tag = cols[3].find('a')
            result_text = res_tag.text.strip() if res_tag else cols[3].text.strip()
            result_url = res_tag.get('href') if res_tag else ''

            # ----- 5. 其他纯文本字段 -----
            runtime = cols[4].text.strip()
            memory = cols[5].text.strip()
            code_len = cols[6].text.strip()
            lang = cols[7].text.strip()
            submit_time = cols[8].text.strip()

            # 映射运行结果（不在映射表中则保留原值，例如"等待评测"）
            result2 = RESULT_MAP.get(result_text, result_text)

            all_records.append({
                '运行ID': run_id,
                '提交链接': add_prefix(run_url),
                '用户名': username,
                '用户主页': add_prefix(user_url),
                '题号': problem,
                '题目链接': add_prefix(prob_url),
                '运行结果': result_text,
                '运行结果2': result2,
                '结果链接': add_prefix(result_url),
                '运行时间(ms)': runtime,
                '使用内存(KB)': memory,
                '代码长度': code_len,
                '使用语言': lang,
                '提交时间': submit_time.replace('-', '.'),
            })

    return all_records, {
        'tables': len(tables),
        'rows': total_rows,
        'duplicates': dup,
        'pages': html.count('<!-- PAGE'),
    }


def main(argv):
    ap = argparse.ArgumentParser(description='牛客提交记录 HTML → nk_cid<CID>_submits.json')
    ap.add_argument('-i', '--input', required=True, help='提交记录页 HTML 源文件')
    ap.add_argument('-o', '--output', default='',
                    help='输出路径；不给就写成输入文件旁边的 nk_cid<CID>_submits.json')
    ap.add_argument('--quiet', action='store_true', help='不把 JSON 打到控制台')
    ap.add_argument('--team', default='', help='只保留该用户名的提交（默认全部）')
    args = ap.parse_args(argv)

    if not os.path.isfile(args.input):
        print(f'❌ 找不到输入文件：{args.input}', file=sys.stderr)
        return 1

    try:
        data, info = parse_all_submit_tables(args.input)
    except Exception as e:
        print(f'❌ 解析失败: {e}', file=sys.stderr)
        return 1

    total = len(data)
    if args.team:
        data = [item for item in data if item['用户名'] == args.team]
        print(f'ℹ️  只保留用户 {args.team}：{total} → {len(data)} 条')

    cids0 = sorted({m.group(1) for item in data
                    for m in [CONTEST_RE.search(str(item.get('题目链接') or ''))] if m})
    if not cids0:
        print('❌ 提交里认不出 cid（题目链接里没有 /acm/contest/<id>/）—— '
              '无法生成规范文件名，请用 -o 指定。', file=sys.stderr)
        return 1
    out = args.output or os.path.join(
        os.path.dirname(os.path.abspath(args.input)), f'nk_cid{cids0[0]}_submits.json')

    if not args.quiet:
        print(json.dumps(data, ensure_ascii=False, indent=2))
    write_json(out, data)

    cids = sorted({m.group(1) for item in data for m in [CONTEST_RE.search(item['题目链接'])] if m})
    users = {item['用户名'] for item in data}
    times = sorted(item['提交时间'] for item in data)
    print(f'\n✅ 共解析到 {len(data)} 条提交记录 → {out}')
    print(f'   表格    : {info["tables"]} 个，{info["rows"]} 行'
          + (f'，去重掉 {info["duplicates"]} 行重复' if info['duplicates'] else ''))
    if info['pages']:
        print(f'   识别到  : {info["pages"]} 页（<!-- PAGE n --> 标记）')
    print(f'   比赛ID  : {", ".join(cids) if cids else "(未取到 —— 题目链接缺失)"}')
    print(f'   用户数  : {len(users)}')
    if times:
        print(f'   时间范围: {times[0]} ~ {times[-1]}')
    unmapped = sorted({item['运行结果'] for item in data if item['运行结果2'] == item['运行结果']})
    if unmapped:
        print(f'   ℹ️ 有未映射的结果原文（会原样保留）：{", ".join(unmapped)}')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
