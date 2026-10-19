#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
牛客（Nowcoder）题目列表解析（HTML → nk_cid<CID>_problems.json）

数据来源
--------
打开某场比赛的 **题目列表页**，F12 控制台粘贴 `collect-nk-problems.js`，
它会下载 `nk_cid<CID>_problems_source.html`（比赛名 + 题目表的原始 HTML）。
丢进 `01 nk/` 后跑 `npm run crate:nk` 会自动调用本脚本。

用法
----
    # 输入必给；不给 -o 时输出就写在**输入旁边**（规范名）
    python Nowcoder_prob_scraper.py -i 2026nk2/nk_cid133877_problems_source.html
    # → 2026nk2/nk_cid133877_problems.json + 2026nk2/nk_cid133877_contest.json

    # 想放别处就显式给 -o
    python Nowcoder_prob_scraper.py -i <源.html> -o <路径>/nk_cid133877_problems.json

输出字段
--------
    题号        字母（A/B/C…）—— 牛客本来就是字母，不需要换算
    标题        题名
    题目链接    https://ac.nowcoder.com/acm/contest/<比赛ID>/<题号>
    通过率      "1582/1583" 形式（通过人数 / 提交人数）
    过题均次    "1.24 次"
    团队状态    通过 / 未通过（只代表你自己这个队）

★ 为什么必须带上「题目链接」
----------------------------
**比赛身份只能从链接里认出来。** 题目列表给出的字段里没有比赛 ID，
也没有比赛名，而链接形如 `/acm/contest/133877/A` —— 那串数字就是
比赛 ID。另外页面 `<h1>` 里有比赛名（如「2026牛客暑期多校训练营2」），
本脚本也会顺带打印出来，方便你确认这一场抓对了没有。

换句话说：**有题目链接，适配器就能自己把整棵树建对；没有它，
每场都得手工告诉脚本"这是哪场比赛"** —— 所以这一列不是装饰。

行为说明
--------
- 输入输出可传参（`-o` 缺省时写到输入文件旁边的规范名），便于按场次分目录保存。
- 「题目链接」与比赛名都会打印出来（见上）。
- 兼容带 BOM 的 HTML，缺表 / 空表时给出可执行的报错。
"""

from __future__ import annotations

import argparse
import json
import os
import re
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
    CONTEST_RE, CONTEST_URL_RE, contest_name_of, write_json,
)


def read_html(path: str) -> str:
    with open(path, 'r', encoding='utf-8-sig', errors='replace') as f:
        return f.read()


# 比赛页里的起止时间（epoch 毫秒）。实测页面里两处都有：
#   window.pageInfo = {"sourceId":133877, …, "startTime":1784692800000, "endTime":1784710800000}
#   window.gioInfo  = {… "name":"2026牛客暑期多校训练营2", … "startTime":…, "endTime":…}
# 判"提交是不是赛时"（`submitKind`）要用它 —— **不能只按日期判**，当天补题很常见。
TIME_RE_START = re.compile(r'"startTime"\s*:\s*(\d{13})')
TIME_RE_END = re.compile(r'"endTime"\s*:\s*(\d{13})')


def contest_window_ms(html: str) -> tuple[int, int]:
    """页面 HTML → `(start_ms, end_ms)`；拿不到返回 `(0, 0)`"""
    a = TIME_RE_START.search(html)
    b = TIME_RE_END.search(html)
    if not (a and b):
        return (0, 0)
    return (int(a.group(1)), int(b.group(1)))


def fmt_ms(ms: int) -> str:
    """epoch 毫秒 → `2026-07-22 12:00`（北京时间，看日志用）"""
    import datetime as _dt
    return _dt.datetime.fromtimestamp(
        int(ms) / 1000, _dt.timezone(_dt.timedelta(hours=8))
    ).strftime('%Y-%m-%d %H:%M')


def abs_url(href: str) -> str:
    """牛客表格里的链接是相对路径，补上域名"""
    if not href:
        return ''
    if href.startswith('//'):
        return 'https:' + href
    if href.startswith('/'):
        return 'https://ac.nowcoder.com' + href
    return href


def parse_problem_table_from_file(filepath: str) -> list[dict]:
    html = read_html(filepath)
    soup = BeautifulSoup(html, 'html.parser')
    table = soup.find('table', class_='table-hover')
    if not table:
        raise ValueError('未找到题目表格（class="table-hover"），请检查 HTML 是否完整')

    tbody = table.find('tbody')
    if not tbody:
        raise ValueError('表格没有 tbody')

    rows = tbody.find_all('tr')
    result = []
    for row in rows:
        cols = row.find_all('td')
        if len(cols) < 6:
            continue
        pid = cols[0].text.strip()
        title_tag = cols[1].find('a')
        title = title_tag.text.strip() if title_tag else '未知'
        prob_link = abs_url(title_tag.get('href', '')) if title_tag else ''
        pass_rate = cols[3].text.strip()
        avg_attempts = cols[4].text.strip()
        status = cols[5].text.strip()
        result.append({
            '题号': pid,
            '标题': title,
            '题目链接': prob_link,      # ★ 比赛 ID 的唯一来源
            '通过率': pass_rate,
            '过题均次': avg_attempts,
            '团队状态': status,
        })
    return result


def main(argv):
    ap = argparse.ArgumentParser(description='牛客题目列表 HTML → nk_cid<CID>_problems.json')
    ap.add_argument('-i', '--input', required=True, help='题目列表页 HTML 源文件')
    ap.add_argument('-o', '--output', default='',
                    help='输出路径；不给就写成输入文件旁边的 nk_cid<CID>_problems.json')
    ap.add_argument('--quiet', action='store_true', help='不把 JSON 打到控制台')
    args = ap.parse_args(argv)

    if not os.path.isfile(args.input):
        print(f'❌ 找不到输入文件：{args.input}', file=sys.stderr)
        return 1

    try:
        data = parse_problem_table_from_file(args.input)
    except Exception as e:
        print(f'❌ 解析失败: {e}', file=sys.stderr)
        return 1

    # ---- 顺带把"这一场是谁"打出来，抓错场次一眼能发现 ----
    html = read_html(args.input)
    contest_name = contest_name_of(html)
    cids = {m.group(1) for m in CONTEST_RE.finditer(html)}
    cid = sorted(cids)[0] if len(cids) == 1 else ''
    letters = [p['题号'] for p in data]

    # 输出名一律带 cid：文件自带身份，放哪个目录都能被流水线认出来
    if not cid:
        print('❌ 题目里认不出 cid（题目链接里没有 /acm/contest/<id>/）—— '
              '无法生成规范文件名，请用 -o 指定。', file=sys.stderr)
        return 1
    out = args.output or os.path.join(
        os.path.dirname(os.path.abspath(args.input)), f'nk_cid{cid}_problems.json')

    if not args.quiet:
        print(json.dumps(data, ensure_ascii=False, indent=2))
    write_json(out, data)

    # ---- 顺带写"这是哪一场"的旁挂文件 ----
    # 为什么必须单独存：题目列表里既没有比赛名也没有比赛 ID（只有链接里的
    # 那串数字），而适配器要靠名字给 C 节点命名。存成旁挂文件后，
    # 一场 = 目录里三个文件（contest / problems / submits），各自职责清楚。
    sidecar = os.path.join(os.path.dirname(os.path.abspath(out)),
                           f'nk_cid{cid}_contest.json')
    # 采集时记下的真实比赛地址（没有就留空 → 适配器退回模板）
    url_match = CONTEST_URL_RE.search(html)
    meta = {
        'contestId': cid,
        'contestName': contest_name,
        'contestUrl': url_match.group(1) if url_match else '',
        'source': os.path.basename(args.input),
    }
    # **比赛起止时间**（页面 JSON 里就有，epoch 毫秒）——
    # 判"提交是不是赛时"要用它（`submitKind`）。牛客比赛页的 `window.pageInfo` /
    # `window.gioInfo` 里有 `startTime` / `endTime`，实测 133877 = 07-22 12:00~17:00。
    st, et = contest_window_ms(html)
    if st and et:
        meta['startTime'] = st
        meta['endTime'] = et
    with open(sidecar, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
        f.write('\n')

    print(f'\n✅ 共解析到 {len(data)} 道题 → {out}')
    print(f'   比赛名  : {contest_name or "(未从 h1 取到)"}')
    print(f'   比赛ID  : {cid or "(未取到；链接缺失会让适配器无法定位比赛)"}'
          + (f'   （页面里出现了多个 contest ID：{sorted(cids)}）' if len(cids) > 1 else ''))
    if st and et:
        print(f'   比赛时间: {fmt_ms(st)} ~ {fmt_ms(et)}（时长 {(et - st) / 3600000:.1f} 小时）')
    print(f'   旁挂文件: {sidecar}')
    print(f'   题号    : {" ".join(letters)}')
    missing = [p['题号'] for p in data if not p['题目链接']]
    if missing:
        print(f'   ⚠️ 这些题没有链接，比赛 ID 认不出来：{" ".join(missing)}')
        print('      （多为"该题在页面上无 <a> 标签"，可手动提供 -c/比赛ID）')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
