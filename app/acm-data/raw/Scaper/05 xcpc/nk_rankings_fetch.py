#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
牛客榜单抓取（**公开接口，无需登录**）→ `nk_cid<CID>_rank.json`

为什么需要它
------------
29 场没 ratio 的场次里，有 2 场的榜单在牛客上（`rankland_index.json` 的 `nowcoder` 字段
给了 contest id）。牛客榜单不必靠"浏览器控制台跑 `fetch-nk-rank.js`"——
**那个接口其实是公开的**（实测）：

    GET https://ac.nowcoder.com/acm-heavy/acm/contest/real-time-rank-data?id=<cid>&limit=0

**只 User-Agent + accept + referer 就返回 200**（无 cookie、无 token）。
返回 `{msg, code, data:{basicInfo, problemData, rankData}}` —— 正是
`01 nk/lib/nk_rank_stats.py` 的 `unwrap()` 认的那种"原始响应"。

用法
----
    python nk_rankings_fetch.py --list
    python nk_rankings_fetch.py --slug gxcpc9th
    python nk_rankings_fetch.py --missing        # 只抓当前包还没有 ratio 的
    python nk_rankings_fetch.py --missing --force # 连"已经有 ratio 的"也重抓（--force 把已有当不存在）
    python nk_rankings_fetch.py                  # 不给参数 = 索引里所有有 nowcoder 的场次

读取开关 `--cache-mode/--retry-mode/--force` 来自通用层 `Scaper/lib/read_modes.py`。

抓完：`python "…/01 nk/lib/nk_rank_stats.py" -i <rank.json> -o <rank_stats.json>`，
再把注册表那场的 board 指向它。
"""

from __future__ import annotations

import argparse
import gzip
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, 'lib'))
sys.path.insert(0, os.path.abspath(os.path.join(HERE, '..', 'lib')))   # Scaper/lib（通用读取层）

from read_modes import print_stats, add_cli_args, configure_from, retry_call, should_refetch  # noqa: E402
from xcpc_common import read_json, slugs_with_ratio  # noqa: E402

INDEX = os.path.join(HERE, 'cache', 'rankland_index.json')
DEFAULT_OUT_DIR = os.path.join(HERE, 'cache', 'nk')
UA = {
    'accept': 'application/json',
    'accept-language': 'zh-CN,zh;q=0.9',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
}


def api_url(cid: str, page: int = 0) -> str:
    """
    牛客榜单接口。**分页必须自己翻**（实测踩到）：
    `limit=0` 只给第一页（`pageSize=50`），而 `basicInfo.rankCount` 才是真实队数 ——
    实测 gxcpc9th 是 753 队 / 16 页，只拿第一页会让"有效队伍数"这个分母**漏掉 93%**
    → 算出来的 ratio 全部偏高（而且原始响应格式下 `nk_rank_stats` 不会报错）。
    """
    q = urllib.parse.urlencode({'token': '', 'id': str(cid), 'limit': '0',
                                'page': str(page),
                                '_': str(int(time.time() * 1000))})
    return f'https://ac.nowcoder.com/acm-heavy/acm/contest/real-time-rank-data?{q}'


def _get_json(url: str, cid: str, timeout: int) -> dict:
    h = dict(UA)
    h['referer'] = f'https://ac.nowcoder.com/acm/contest/{cid}'
    resp = urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=timeout)
    raw = resp.read()
    if resp.headers.get('content-encoding') == 'gzip':
        raw = gzip.decompress(raw)
    d = json.loads(raw.decode('utf-8', 'replace'))
    if d.get('code') not in (0, None):
        raise ValueError(f'接口返回异常：code={d.get("code")!r} msg={d.get("msg")!r}')
    if not isinstance(d.get('data'), dict):
        raise ValueError('返回里没有 data（接口变了或 id 不对）')
    return d


def fetch(cid: str, timeout: int = 60, verbose: bool = True) -> dict:
    """
    抓**全量**榜单，返回 `nk_rank_stats.py` 能直接吃的**汇总包**
    （`bundleVersion` / `basicInfo` / `problemData` / `rankData` / `pagesCollected`）。

    为什么要翻页 + 为什么要输出汇总包：见 `api_url()` 的说明；
    汇总包还带 `pagesCollected`，`nk_rank_stats.unwrap()` 会据此判"是否完整"（不完整就不写 ratio）。
    """
    first = _get_json(api_url(cid, 1), cid, timeout)
    data = first['data']
    basic = data.get('basicInfo') or {}
    pages = int(basic.get('pageCount') or 1)
    total = int(basic.get('rankCount') or 0)
    rows = list(data.get('rankData') or [])
    if verbose:
        print(f'      {total} 队 / {pages} 页，已收 1')
    for p in range(2, pages + 1):
        d = _get_json(api_url(cid, p), cid, timeout)
        got = (d.get('data') or {}).get('rankData') or []
        rows.extend(got)
        if verbose:
            print(f'      第 {p}/{pages} 页 +{len(got)} → {len(rows)}')
        if not got:
            break
        time.sleep(0.4)         # 别把对方打急
    return {
        'bundleVersion': 1,
        'basicInfo': basic,
        'problemData': data.get('problemData') or [],
        'rankData': rows,
        'pagesCollected': pages if len(rows) >= total else 0,
        'source': f'nk_rankings_fetch(cid={cid})',
    }


def main(argv):
    ap = argparse.ArgumentParser(description='牛客榜单抓取（无需登录）')
    ap.add_argument('--slug', action='append', default=[])
    ap.add_argument('--missing', action='store_true')
    ap.add_argument('--list', action='store_true')
    ap.add_argument('--out-dir', default=DEFAULT_OUT_DIR)
    ap.add_argument('--sleep', type=float, default=1.0)
    add_cli_args(ap)                  # --cache-mode/--retry-mode/--force（通用层）
    args = ap.parse_args(argv)
    configure_from(args)              # 必须在下面任何读缓存/联网之前

    index = read_json(INDEX).get('bySlug') or {}

    only = set(args.slug)
    # 判据**只看牛客那棵树**（口径："本渠道没有 ratio 就该抓"）：
    # 别的渠道有 ratio 不代表牛客有；"牛客树里压根没这场"也算缺。
    # `--force`/`--cache-mode none` 时"已经有 ratio"也不算已有 ⇒ 全部重抓。
    have = slugs_with_ratio('nk') if (args.missing and not only) else None
    want = []
    for slug, info in sorted(index.items()):
        cids = [str(x) for x in (info.get('nowcoder') or []) if str(x).strip()]
        if not cids:
            continue
        if only and slug not in only:
            continue
        if have is not None and not should_refetch(slug in have):
            continue
        want.append((slug, cids[0], str(info.get('title') or '')))
    if not want:
        print('没有要抓的场次')
        return 1

    print(f'📋 {len(want)} 场要抓：')
    for slug, cid, name in want:
        print(f'   {slug:36s} cid={cid}  {name[:34]}')
    if args.list:
        return 0

    os.makedirs(args.out_dir, exist_ok=True)
    ok = fail = 0
    for i, (slug, cid, name) in enumerate(want, 1):
        out = os.path.join(args.out_dir, f'nk_cid{cid}_rank.json')
        try:
            # `fetch()` 自己只是个"按页翻到底"的循环（没有重试）⇒ 交给通用层重试整个抓取，
            # 不包里面的 `_get_json`（否则会变成 页数 × 重试次数 的乘法）
            d = retry_call(fetch, cid, what=f'牛客榜单 {slug}')
        except (urllib.error.URLError, urllib.error.HTTPError, ValueError,
                TimeoutError, OSError) as e:
            print(f'  [{i}/{len(want)}] ❌ {slug}: {type(e).__name__} {str(e)[:70]}')
            fail += 1
            continue
        data = d
        teams = data.get('rankData') or []
        probs = data.get('problemData') or []
        eff = sum(1 for t in teams if (t.get('acceptedCount') or 0) > 0)
        with open(out, 'w', encoding='utf-8', newline='\n') as f:
            json.dump(d, f, ensure_ascii=False)
            f.write('\n')
        print(f'  [{i}/{len(want)}] ✅ {slug}: {len(teams)} 队（有效 {eff}）/ '
              f'{len(probs)} 题 → {out}')
        ok += 1
        if i < len(want):
            time.sleep(args.sleep)

    print(f'\n完成：成功 {ok} / 失败 {fail}')
    if ok:
        print('下一步：把 rank.json 喂给 nk_rank_stats.py 出统计，再在注册表里把 board 指向它')
    print_stats('牛客榜单')
    return 0 if fail == 0 else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
