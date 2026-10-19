#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
牛客比赛**起止时间**回填 → 写进 `nk_cid<CID>_contest.json`（旁挂文件）

为什么需要
----------
判"提交是不是**赛时**"（R 的 `submitKind`）必须有**比赛时段**：
**不能只按日期判 —— 当天补题非常常见**。

而牛客比赛页里本来就有（实测 133877）：

    window.pageInfo = {"sourceId":133877,…,"startTime":1784692800000,"endTime":1784710800000}
    → 2026-07-22 12:00 ~ 17:00（5 小时）

`Nowcoder_prob_scraper.py` 之后会顺手存这两项；本脚本是**给已有的 10 场补**的
（源 HTML 解析完就删了，所以直接读线上页面，1 请求/场）。

用法
----
    python backfill_nk_contest_times.py            # 自动找本目录下所有 nk_cid*_contest.json
    python backfill_nk_contest_times.py --dry-run
"""

from __future__ import annotations

import argparse
import glob
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
CONTEST_URL = 'https://ac.nowcoder.com/acm/contest/{cid}'
UA = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
}
_CTX = ssl.create_default_context()
_CTX.check_hostname = False
_CTX.verify_mode = ssl.CERT_NONE
START_RE = re.compile(r'"startTime"\s*:\s*(\d{13})')
END_RE = re.compile(r'"endTime"\s*:\s*(\d{13})')


def fmt(ms: int) -> str:
    import datetime as _dt
    return _dt.datetime.fromtimestamp(
        int(ms) / 1000, _dt.timezone(_dt.timedelta(hours=8))).strftime('%Y-%m-%d %H:%M')


def fetch_window(cid: str, timeout: int = 25) -> tuple[int, int]:
    """抓一页窗口（**只试一次**，重试交给通用层的 `retry_call`）；拿不到就抛异常"""
    req = urllib.request.Request(CONTEST_URL.format(cid=cid), headers=UA)
    html = urllib.request.urlopen(req, timeout=timeout, context=_CTX).read().decode(
        'utf-8', 'replace')
    a, b = START_RE.search(html), END_RE.search(html)
    if not (a and b):
        return (0, 0)
    return (int(a.group(1)), int(b.group(1)))


CACHE_DIR = os.path.join(HERE, 'cache', 'nk_contest_times')


def get_window(cid: str) -> tuple[int, int]:
    """这场窗口：**有缓存就用缓存**（`--force`/`--cache-mode none` 才重抓）"""
    p = os.path.join(CACHE_DIR, f'{cid}.json')
    if not should_refetch(os.path.isfile(p)):
        d = json.load(open(p, encoding='utf-8-sig'))
        return (int(d.get('startTime') or 0), int(d.get('endTime') or 0))
    try:
        st, et = retry_call(fetch_window, cid, what=f'牛客比赛 {cid} 起止时间')
    except Exception as e:  # noqa: BLE001
        print(f'   ⚠️ cid={cid} 抓取失败：{type(e).__name__}: {str(e)[:70]}')
        return (0, 0)
    if st and et:
        os.makedirs(CACHE_DIR, exist_ok=True)
        with open(p, 'w', encoding='utf-8', newline='\n') as f:
            json.dump({'startTime': st, 'endTime': et}, f)
            f.write('\n')
    return (st, et)


def main(argv):
    ap = argparse.ArgumentParser(description='牛客比赛起止时间 → 写进旁挂 contest.json')
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--glob', default=os.path.join(HERE, '**', 'nk_cid*_contest.json'))
    add_cli_args(ap)
    args = ap.parse_args(argv)
    configure_from(args)

    files = sorted(glob.glob(args.glob, recursive=True))
    if not files:
        print('❌ 没找到 nk_cid*_contest.json', file=sys.stderr)
        return 1
    print(f'🕒 {len(files)} 场的旁挂文件（1 请求/场）')
    ok = 0
    for path in files:
        with open(path, 'r', encoding='utf-8-sig') as f:
            meta = json.load(f)
        cid = str(meta.get('contestId') or '')
        if not cid:
            print(f'   {os.path.basename(path)}: 没有 contestId，跳过')
            continue
        if meta.get('startTime') and meta.get('endTime'):
            print(f'   cid={cid}: 已有 {fmt(meta["startTime"])} ~ {fmt(meta["endTime"])}，跳过')
            continue
        st, et = get_window(cid)
        if not (st and et):
            print(f'   cid={cid}: 拿不到起止时间')
            continue
        meta['startTime'] = st
        meta['endTime'] = et
        hours = (et - st) / 3600000
        print(f'   cid={cid}: {fmt(st)} ~ {fmt(et)}（{hours:.1f} 小时）')
        if not args.dry_run:
            with open(path, 'w', encoding='utf-8', newline='\n') as f:
                json.dump(meta, f, ensure_ascii=False, indent=2)
                f.write('\n')
        ok += 1
    print(('（--dry-run：没写文件）' if args.dry_run else '') + f'更新 {ok} 场')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
