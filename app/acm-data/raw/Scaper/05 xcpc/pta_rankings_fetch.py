#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
PTA 榜单抓取（**公开接口，无需登录**）→ 存成 `pta_adapter.py` 能直接吃的 JSON

为什么需要它
------------
29 场没有 ratio 的场次里，**12 场的榜单就在 PTA 上**（`rankland_index.json` 的
`ptaRankings` 字段给了 ranking id）。那 2 场靠"浏览器 F12 存一份"，
所以一直以为 PTA 要登录 —— **其实不用**（拿到真实请求后实测）：

    GET https://pintia.cn/api/competitions/<id>/xcpc-rankings/public?filter={...}

**最小请求头（只 User-Agent + accept + referer）就返回 200**；
不需要 cookie、不需要 `x-lollipop`、不需要登录态。
榜单本身也标着 `showFullBoardInPublic: true` —— 它天生就是公开的。
（点开页面只有 8.8 KB 空壳、数据全靠前端 JS 拉，所以"看 HTML"那条路不通，必须打这个接口。）

返回的 JSON 与 `pta_adapter.py` 期望的**完全一致**：
  `xcpcRankings.rankings[]`（含 `detailsByProblemSetProblemId`）、
  `xcpcRankings.problemInfoByProblemSetProblemId`、`balloonSettings`、`competitionBasicInfo`。

用法
----
    python pta_rankings_fetch.py --list            # 看哪些场次缺 ratio 且有 PTA 榜
    python pta_rankings_fetch.py --missing         # 只抓"还没有 ratio 的"那些场次
    python pta_rankings_fetch.py --missing --force # 连"已经有 ratio 的"也重抓（--force 把已有当不存在）
    python pta_rankings_fetch.py --slug bjcpc2025
    python pta_rankings_fetch.py                   # 不给参数 = 索引里所有有 ptaRankings 的场次
    python pta_rankings_fetch.py --missing --out-dir "acm-data/raw/Scaper/03 PTA"

读取开关 `--cache-mode/--retry-mode/--force` 来自通用层 `Scaper/lib/read_modes.py`。

抓完怎么用：把存下来的文件挂到注册表那场的 `board`（source=pta, file=<路径>），
再 `python xcpc_pipeline.py --force`。
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
MANIFEST = os.path.join(HERE, 'xcpc_contests.json')
DEFAULT_OUT_DIR = os.path.join(HERE, 'cache', 'pta')
# 判"这题过了"看 acceptTime >= 0（`pta_adapter` 的口径；那个 status 字段不存在）
UA = {
    'accept': 'application/json;charset=UTF-8',
    'accept-language': 'zh-CN',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'content-type': 'application/json;charset=UTF-8',
}
FILTER = json.dumps({'groupFid': '', 'teamExcluded': 'NO_FILTER', 'hideScoreboard': False},
                    separators=(',', ':'))


def api_url(rid: str) -> str:
    return (f'https://pintia.cn/api/competitions/{rid}/xcpc-rankings/public'
            f'?filter={urllib.parse.quote(FILTER)}')


def fetch(rid: str, timeout: int = 40) -> dict:
    """抓一份公开榜单；返回解析后的 JSON（失败抛异常，**不静默返回空**）"""
    h = dict(UA)
    h['referer'] = f'https://pintia.cn/rankings/{rid}'
    req = urllib.request.Request(api_url(rid), headers=h)
    resp = urllib.request.urlopen(req, timeout=timeout)
    raw = resp.read()
    if resp.headers.get('content-encoding') == 'gzip':
        raw = gzip.decompress(raw)
    body = raw.decode('utf-8', 'replace')
    if 'xcpcRankings' not in body:
        raise ValueError(f'返回里没有 xcpcRankings（{len(body)}B）—— 接口变了或 id 不对')
    return json.loads(body)


def load_index() -> dict:
    return (read_json(INDEX).get('bySlug') or {})


def targets(index: dict, only_slugs: set) -> list[tuple]:
    """[(slug, rid, 名称)]"""
    out = []
    for slug, info in sorted(index.items()):
        rids = [str(x) for x in (info.get('ptaRankings') or []) if str(x).strip()]
        if not rids:
            continue
        if only_slugs and slug not in only_slugs:
            continue
        out.append((slug, rids[0], str(info.get('title') or '')))
    return out


def main(argv):
    ap = argparse.ArgumentParser(description='PTA 公开榜单抓取（无需登录）')
    ap.add_argument('--slug', action='append', default=[], help='只抓这些 slug（可重复）')
    ap.add_argument('--missing', action='store_true', help='只抓当前包里还没有 ratio 的')
    ap.add_argument('--list', action='store_true', help='只列出目标，不抓')
    ap.add_argument('--out-dir', default=DEFAULT_OUT_DIR)
    ap.add_argument('--sleep', type=float, default=1.0, help='每场之间等几秒（默认 1）')
    add_cli_args(ap)                  # --cache-mode/--retry-mode/--force（通用层）
    args = ap.parse_args(argv)
    configure_from(args)              # 必须在下面任何读缓存/联网之前

    index = load_index()
    only = set(args.slug)
    want = targets(index, only)
    if args.missing and not only:
        # 判据**只看 PTA 那棵树**（口径："本渠道没有 ratio 就该抓"）：
        # 别的渠道有 ratio 不代表 PTA 有；而且"PTA 树里压根没这场"也算缺。
        # `--force`/`--cache-mode none` 时"已经有 ratio"也不算已有 ⇒ 全部重抓。
        have = slugs_with_ratio('pta')
        if not have:
            print('⚠️ PTA 那棵树里一场 ratio 都没有（先出一次包）⇒ 按"全缺"处理')
        want = [w for w in want if should_refetch(w[0] in have)]
    if not want:
        print('没有要抓的场次（--list 看索引，不给参数就是全量）')
        return 1

    print(f'📋 {len(want)} 场要抓：')
    for slug, rid, name in want:
        print(f'   {slug:36s} {rid}  {name[:34]}')
    if args.list:
        return 0

    os.makedirs(args.out_dir, exist_ok=True)
    ok = fail = 0
    for i, (slug, rid, name) in enumerate(want, 1):
        out = os.path.join(args.out_dir, f'pta_{slug}.json')
        try:
            # 单次尝试、自己没有任何重试 ⇒ 交给通用层的重试模式（--retry-mode once 就只试一次）
            d = retry_call(fetch, rid, what=f'PTA 榜单 {slug}')
        except (urllib.error.URLError, urllib.error.HTTPError, ValueError,
                TimeoutError, OSError) as e:
            print(f'  [{i}/{len(want)}] ❌ {slug}: {type(e).__name__} {str(e)[:70]}')
            fail += 1
            continue
        xr = d.get('xcpcRankings') or {}
        teams = xr.get('rankings') or []
        eff = sum(1 for r in teams if (r.get('solvedCount') or 0) > 0)
        with open(out, 'w', encoding='utf-8', newline='\n') as f:
            json.dump(d, f, ensure_ascii=False)
            f.write('\n')
        print(f'  [{i}/{len(want)}] ✅ {slug}: {len(teams)} 队（有效 {eff}）→ '
              f'{os.path.relpath(out, os.path.abspath(os.path.join(HERE, "..", "..", "..", "..", "..")))}')
        ok += 1
        if i < len(want):
            time.sleep(args.sleep)

    print(f'\n完成：成功 {ok} / 失败 {fail}')
    if ok:
        print('\n下一步（每场都要）：')
        print('  1. 在 xcpc_registry.json 里把该场 board 指向这份文件：')
        print('     "board": { "source": "pta", "role": "board", "file": "<上面的路径>" }')
        print('  2. python xcpc_pipeline.py --force && npm run crate:check -- acm-data/nodes/mix_contain_xcpc.json')
    print_stats('PTA 榜单')
    return 0 if fail == 0 else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
