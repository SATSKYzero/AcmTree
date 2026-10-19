#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
HDU 比赛**起止时间**抓取（免登录）→ 补进 `Hdu_contests.json`

为什么需要它
------------
判"提交是不是**赛时**"（R 节点的 `submitKind`）必须有**比赛时段**。
而 HDU 的比赛列表页只有 `Start Time` 一列，**没有结束时间** ——
实测发现，比赛页里就有起止时间：

    https://acm.hdu.edu.cn/contest/problems?cid=<cid>
    页面里嵌着一行  const contest = {"id":1229,"now":…,"start":1784606400,"end":1784624400,…}

**这一行免登录就能拿到**（页面其它部分是登录表单，但那行 JSON 在登录表单之外）。
实测 cid 1229 → 1784606400 ~ 1784624400 = 2026-07-21 12:00 ~ 17:00（5 小时）。

⚠️ 为什么不能只按"日期相同"判赛时：**当天补题非常常见**。

用法
----
    python Hdu_contest_times.py                 # 给 Hdu_contests.json 里所有场次补 end_time
    python Hdu_contest_times.py --cids 1229,1238
    python Hdu_contest_times.py --dry-run
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import re
import ssl
import sys
import urllib.error
import urllib.request

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.abspath(os.path.join(HERE, '..', 'lib')))   # Scaper/lib（通用读取层）
from read_modes import add_cli_args, configure_from, retry_call, should_refetch  # noqa: E402
DEFAULT_JSON = os.path.join(HERE, 'Hdu_contests.json')
CONTEST_URL = 'https://acm.hdu.edu.cn/contest/problems?cid={cid}'
# 页面里那一行：const contest = {"id":1229,"now":…,"start":1784606400,"end":1784624400,…}
CONST_RE = re.compile(r'const\s+contest\s*=\s*(\{[^}]*\})')
UA = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Referer': 'https://acm.hdu.edu.cn/contests/contest_list.php',
}
_CTX = ssl.create_default_context()
_CTX.check_hostname = False
_CTX.verify_mode = ssl.CERT_NONE


def fmt_bj(epoch) -> str:
    """epoch 秒 → `2026-07-21 12:00:00`（北京时间，与源里 start_time 同格式）"""
    return datetime.datetime.fromtimestamp(
        int(epoch), datetime.timezone(datetime.timedelta(hours=8))
    ).strftime('%Y-%m-%d %H:%M:%S')


def fetch_window(cid: str, timeout: int = 25) -> tuple[str, str]:
    """抓一场的 `(start_text, end_text)`（**只试一次**，重试交给 `retry_call`）；拿不到就抛异常"""
    req = urllib.request.Request(CONTEST_URL.format(cid=cid), headers=UA)
    html = urllib.request.urlopen(req, timeout=timeout, context=_CTX).read().decode(
        'utf-8', 'replace')
    m = CONST_RE.search(html)
    if not m:
        return ('', '')
    try:
        obj = json.loads(m.group(1))
    except ValueError:
        return ('', '')
    st, et = obj.get('start'), obj.get('end')
    if not st or not et:
        return ('', '')
    return (fmt_bj(st), fmt_bj(et))


CACHE_DIR = os.path.join(HERE, 'cache', 'hdu_contest_times')


def get_window(cid: str) -> tuple[str, str]:
    """这场窗口：**有缓存就用缓存**（`--force`/`--cache-mode none` 才重抓）"""
    p = os.path.join(CACHE_DIR, f'{cid}.json')
    if not should_refetch(os.path.isfile(p)):
        d = json.load(open(p, encoding='utf-8-sig'))
        return (str(d.get('start') or ''), str(d.get('end') or ''))
    try:
        st, et = retry_call(fetch_window, cid, what=f'HDU 比赛 {cid} 起止时间')
    except Exception as e:  # noqa: BLE001
        print(f'   ⚠️ cid={cid} 抓取失败：{type(e).__name__}: {str(e)[:70]}')
        return ('', '')
    if st and et:
        os.makedirs(CACHE_DIR, exist_ok=True)
        with open(p, 'w', encoding='utf-8', newline='\n') as f:
            json.dump({'start': st, 'end': et}, f, ensure_ascii=False)
            f.write('\n')
    return (st, et)


def main(argv):
    ap = argparse.ArgumentParser(description='HDU 比赛起止时间 → 补进 Hdu_contests.json')
    ap.add_argument('-i', '--input', default=DEFAULT_JSON)
    ap.add_argument('-o', '--output', default='')
    ap.add_argument('--cids', default='', help='只补这些（逗号分隔）；默认补文件里全部')
    ap.add_argument('--dry-run', action='store_true')
    add_cli_args(ap)
    args = ap.parse_args(argv)
    configure_from(args)

    src = args.input
    if not os.path.isfile(src):
        print(f'❌ 找不到 {src}', file=sys.stderr)
        return 1
    with open(src, 'r', encoding='utf-8-sig') as f:
        doc = json.load(f)
    rows = doc if isinstance(doc, list) else (doc.get('contests') or [])
    if not rows:
        print('❌ 文件里没有场次', file=sys.stderr)
        return 1

    want = {c.strip() for c in args.cids.split(',') if c.strip()}
    targets = [r for r in rows if not want or str(r.get('contest_id')) in want]
    print(f'🕒 抓 {len(targets)} 场的起止时间（免登录，1 请求/场）')
    ok = 0
    for r in targets:
        cid = str(r.get('contest_id') or '')
        if not cid:
            continue
        st, et = get_window(cid)
        if not et:
            print(f'   cid={cid}: 拿不到')
            continue
        before_s, before_e = r.get('start_time'), r.get('end_time')
        if before_s != st:
            r['start_time'] = st
        r['end_time'] = et
        ok += 1
        hours = (datetime.datetime.fromisoformat(et) - datetime.datetime.fromisoformat(st)
                 ).total_seconds() / 3600
        flag = '' if before_s == st else f'  （原 start_time={before_s} → 已按页面修正）'
        print(f'   cid={cid}: {st} ~ {et}（{hours:.1f} 小时）{flag}')

    out = args.output or src
    if args.dry_run:
        print(f'（--dry-run：没写文件；本可更新 {ok} 场）')
        return 0
    with open(out, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)
        f.write('\n')
    print(f'💾 {out}（更新 {ok} 场）')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
