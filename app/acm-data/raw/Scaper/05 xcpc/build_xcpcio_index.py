#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
建 **xcpcio 场次索引**：`系列 / 届次 / 站点` + 每场的赛名 / 开赛时间 / 题数（公开数据，MIT）

为什么要有它
--------------------------------------
"同一场"的**系列 + 届次 + 站点**这件事，除了 rankland 与 QOJ 分类，还有一份现成的
公开注册表：[xcpcio/board-data](https://github.com/xcpcio/board-data)。它的目录结构本身就是分类：

    data/ccpc/11th/zhengzhou/          ← 第 11 届 CCPC 郑州站
    data/ccpc/11th/chongqing/          ← 第 11 届 CCPC 重庆站
    data/icpc/…  data/provincial-contest/…  data/camp/…

于是 `qoj:2661`（QOJ 上的 "The 4th Universal Cup. Stage 7: Grand Prix of Zhengzhou"）
不用人绑也能知道它 = CCPC 2025 郑州站；再按 `ccpc<年><站点>` 就能找到 rankland 的 slug。

两趟请求（都不大）
----------------
1. `git/trees?recursive=1` —— 目录树（一次请求，几百 KB）：**只有目录名**。
2. 每个场次的 `config.json`（463 个，合计 **1.4 MB**）：赛名 / 开赛时间 / 题号表。

第 2 趟**必须要有**：光靠目录名（`zhengzhou`）与赛名做模糊匹配，
165 场里只能对上 48 场（27 场还只给得出"目录"、解不出 slug）；而 `config.json` 里写的是
**完整赛名**（「第 11 届 CCPC 中国大学生程序设计竞赛郑州站 - 正式赛」），
和 rankland 的标题一比就中。

⚠️ **不下榜单数据**（`run.json` / `team.json`，全仓 417 MB）—— 那是 `xcpcio_adapter.py`
   按需下的（只下对得上的场次）。这里只取"身份 + 题单"。

许可：board-data 是 **MIT**（本项目的 rankland 数据是 AGPL，两者互不影响，别混）。

用法
----
    python build_xcpcio_index.py                # 增量：只下新增/变了的 config
    python build_xcpcio_index.py --force        # 全部重下（config 很小，无所谓）
    python build_xcpcio_index.py --dry-run      # 只说有多少场，不联网

（读取开关 `--cache-mode/--retry-mode/--force` 来自通用层 `Scaper/lib/read_modes.py`。）
"""

from __future__ import annotations

import argparse
import collections
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, 'lib'))
sys.path.insert(0, os.path.abspath(os.path.join(HERE, '..', 'lib')))   # Scaper/lib（通用读取层）

from read_modes import print_stats, add_cli_args, configure_from, retry_call, should_refetch  # noqa: E402
from xcpc_common import CACHE, read_json, rel, write_json  # noqa: E402

OUT = os.path.join(CACHE, 'xcpcio_tree.json')
API = 'https://api.github.com/repos/xcpcio/board-data/git/trees/main?recursive=1'
UA = {'User-Agent': 'acm-tree/xcpc', 'Accept': 'application/vnd.github+json'}
SERIES = ('icpc', 'ccpc', 'provincial-contest', 'camp')
CST = timezone(timedelta(hours=8))


def _get(url: str, timeout: int = 60) -> bytes:
    """
    取一个 URL 的字节。

    为什么**先几面 CDN 再 GitHub**：`raw.githubusercontent.com` 在部分网络下会被重置
    （实测 WinError 10054 连接被强行关闭），GitHub 的 contents API 又限速
    （匿名 60 次/小时）—— 463 个文件根本不够。几条路都有，取到就返回。

    ⚠️ ★ **`fastly` 必须排第一**（2026-10-15 实测，同一份 `data/icpc/47th/xian/run.json`
       838 KB）：`fastly` ✅ 2.1 s ｜ `gcore` ❌ 10054 ｜ `cdn` ❌ 10054 ｜ `raw` ❌ 61 s 后重置。
       ⚠️ 旧注释说"`cdn.jsdelivr.net` 能取到" —— **在这台机器上已经不成立了**；
       顺序与 `xcpcio_adapter.RAW_MIRRORS` 是同一份结论（改一处要顺手看另一处）。
    """
    for u in (f'https://fastly.jsdelivr.net/gh/xcpcio/board-data@main/{url}',
              f'https://gcore.jsdelivr.net/gh/xcpcio/board-data@main/{url}',
              f'https://cdn.jsdelivr.net/gh/xcpcio/board-data@main/{url}',
              f'https://raw.githubusercontent.com/xcpcio/board-data/main/{url}'):
        try:
            req = urllib.request.Request(u, headers={'User-Agent': 'acm-tree/xcpc'})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except (urllib.error.URLError, OSError, ValueError):
            continue
    # 最后退到 GitHub contents API（base64）—— 限速，但能用
    import base64
    u = f'https://api.github.com/repos/xcpcio/board-data/contents/{url}'
    req = urllib.request.Request(u, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        doc = json.loads(r.read().decode('utf-8'))
    return base64.b64decode(doc['content'])


def fetch_tree() -> tuple[list, dict]:
    """目录树 → (目录路径列表, 路径 → blob sha)。sha 用来判断"变了没有"（增量下载）"""
    req = urllib.request.Request(API, headers=UA)
    with urllib.request.urlopen(req, timeout=90) as r:
        doc = json.loads(r.read().decode('utf-8'))
    if doc.get('truncated'):
        print('⚠️ GitHub 说返回被截断了（目录太多）—— 索引可能不全', file=sys.stderr)
    blobs = {t['path']: t.get('sha', '') for t in (doc.get('tree') or [])
             if t.get('type') == 'blob'}
    return [t['path'] for t in (doc.get('tree') or []) if t.get('type') == 'tree'], blobs


def parse_paths(paths: list, blobs: dict) -> list:
    """
    `data/<系列>/<届次>/<站点>` → 条目。

    届次可能写成 `11th`（届）或 `2025`（年）；站点就是目录名（`zhengzhou`）。
    `-warmup` 结尾的是热身赛，**不是**正赛场次，单独标出来。

    `configSha` 是它的 `config.json` 的 blob sha —— 下次跑就知道要不要重下。
    """
    out = {}
    for p in paths:
        parts = p.split('/')
        if len(parts) < 4 or parts[0] != 'data' or parts[1] not in SERIES:
            continue
        series, season, site = parts[1], parts[2], parts[3]
        # `*-assets` 是挂横幅图片的目录，不是场次（它的 config.json 不存在，会 404）
        if site.endswith('-assets'):
            continue
        key = (series, season, site)
        out[key] = {
            'series': series,
            'season': season,
            'site': site,
            'warmup': site.endswith('-warmup'),
            'path': p,
            'configSha': blobs.get(p + '/config.json', ''),
        }
    return sorted(out.values(), key=lambda x: (x['series'], x['season'], x['site']))


# ================================================================
# config.json → 赛名 / 时间 / 题号
# ================================================================

def parse_start(value) -> str:
    """
    xcpcio 的 `start_time` **单位不统一**：新数据是毫秒（`1763859600000`），
    也可能是秒（`1658278800`，EC-Final 46th）。判断方式：> 1e11 视为毫秒。

    @returns `2026.11.23 09:00`（**北京时间**；xcpcio 存的是 UTC 时间戳）
    """
    try:
        n = float(value)
    except (TypeError, ValueError):
        return ''
    if n <= 0:
        return ''
    if n > 1e11:
        n /= 1000.0
    try:
        dt = datetime.fromtimestamp(n, tz=timezone.utc).astimezone(CST)
    except (OverflowError, OSError, ValueError):
        return ''
    return dt.strftime('%Y.%m.%d %H:%M')


def read_config(item: dict) -> dict:
    """
    取这一场的 config.json（带缓存）。返回要并进索引的字段。

    "这份缓存能不能用" = **本地有 + sha 与目录树说的一致**；
    要不要重下交给通用层的 `should_refetch`（`--force` / `--cache-mode none` ⇒ 一律重下）。
    """
    path = item['path']
    sha = item.get('configSha') or ''
    cache = os.path.join(CACHE, 'xcpcio', *path.split('/'), 'config.json')
    usable = bool(sha) and os.path.isfile(cache) and item.get('_sha') == sha
    got = None
    if not should_refetch(usable):
        try:
            got = read_json(cache)
        except (ValueError, OSError):
            got = None
    if got is None:
        raw = _get(path + '/config.json')
        os.makedirs(os.path.dirname(cache), exist_ok=True)
        with open(cache, 'wb') as f:
            f.write(raw)
        got = json.loads(raw.decode('utf-8'))
    labels = [str(p.get('label') or '') for p in (got.get('problems') or [])]
    return {
        'name': str(got.get('contest_name') or ''),
        'startAt': parse_start(got.get('start_time')),
        'endAt': parse_start(got.get('end_time')),
        'problemCount': int(got.get('problem_quantity') or len(labels)),
        'letters': [x for x in labels if x],
        'group': dict(got.get('group') or {}),
        'link': f"https://board.xcpcio.com/{path[len('data/'):]}",
        'configSha': sha,
    }


def main(argv):
    ap = argparse.ArgumentParser(description='xcpcio 场次索引（目录树 + config）')
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--limit', type=int, default=0, help='只处理前 N 场（调试用）')
    add_cli_args(ap)                  # --cache-mode/--retry-mode/--force（通用层）
    args = ap.parse_args(argv)
    configure_from(args)              # 必须在下面任何读缓存/联网之前

    print(f'📥 {API}')
    # 目录树是一次请求、没有别的兜底 ⇒ 交给通用层的重试模式
    paths, blobs = retry_call(fetch_tree, what='xcpcio 目录树')
    items = parse_paths(paths, blobs)
    by_series = collections.Counter(x['series'] for x in items)
    print(f'   场次目录 {len(items)} 条：' + '、'.join(f'{k} {v}' for k, v in by_series.most_common()))
    print(f'   其中热身赛（*-warmup）{sum(1 for x in items if x["warmup"])} 条')

    if args.dry_run:
        print('（--dry-run：没有联网取 config、也没有写文件）')
        return 0

    # 增量：缓存里已有的 sha 拿来比（老索引里没有 configSha 时一律重下）
    old = {}
    if os.path.isfile(OUT):
        try:
            for e in (read_json(OUT).get('contests') or []):
                old[(e.get('series'), e.get('season'), e.get('site'))] = e
        except (ValueError, OSError):
            old = {}

    todo = []
    for it in items:
        prev = old.get((it['series'], it['season'], it['site'])) or {}
        it['_sha'] = prev.get('configSha') or ''
        # "这次要不要下"：缓存里有且 sha 与目录树一致 ⇒ 不用下；
        # `--force` / `--cache-mode none` 时 `should_refetch` 一律 True ⇒ 全部重下。
        fresh = bool(it['configSha']) and prev.get('configSha') == it['configSha']
        if should_refetch(fresh):
            todo.append(it)
    if args.limit:
        # ⚠️ 只限"这次下几个"，**不裁剪 items** —— 索引文件必须是完整的目录树
        todo = todo[:args.limit]
    print(f'   config.json：缓存命中 {len(items) - len(todo)} 场，要下 {len(todo)} 场'
          f'（合计约 {len(todo) * 3 / 1000:.1f} MB）')

    # 缓存命中的场次：先把已有索引里那几个字段搬回来（要下的话下面会被覆盖）
    for it in items:
        prev = old.get((it['series'], it['season'], it['site'])) or {}
        if prev.get('configSha') == it.get('configSha'):
            for k in ('name', 'startAt', 'endAt', 'problemCount', 'letters', 'group', 'link'):
                if prev.get(k) not in (None, '', []):
                    it[k] = prev[k]

    ok = fail = 0
    for i, it in enumerate(todo, 1):
        try:
            it.update(read_config(it))
            ok += 1
        except Exception as e:                                    # noqa: BLE001
            fail += 1
            print(f'   ⚠️ {it["path"]}：{type(e).__name__} {e}', file=sys.stderr)
        if i % 50 == 0 or i == len(todo):
            print(f'   … {i}/{len(todo)}')

    for it in items:
        it.pop('_sha', None)

    named = sum(1 for x in items if x.get('name'))
    doc = {
        'generatedAt': datetime.now(CST).strftime('%Y.%m.%d %H:%M'),
        'source': 'https://github.com/xcpcio/board-data',
        'license': 'MIT',
        'note': [
            'xcpcio/board-data 的目录树：data/<系列>/<届次>/<站点>，并已把每场的'
            'config.json 里的赛名/开赛时间/题号表并进来。',
            '用途：① 给"同一场"的候选补"系列+届次+站点"这条证据（详见 lib/match.py）；'
            '② 作为最权威的 ratio 来源（xcpcio_adapter.py）。',
            '**没有榜单明细**（run.json/team.json 按需另下）、**没有题名**'
            '（config.json 只给题号 label，题名不在这个仓库里）。',
            'config 缓存放在 cache/xcpcio/<路径>/config.json；靠 configSha 增量。',
            '缺"届次→年份"的映射时不硬猜：届次就按原样存（`11th`），年份靠 QOJ 分类或赛名给。',
        ],
        'contests': items,
    }
    write_json(OUT, doc)
    print(f'✅ {rel(OUT)}')
    print(f'   有赛名的 {named}/{len(items)} 场；config 下载成功 {ok}、失败 {fail}')
    print('   下一步：python xcpc_registry.py scan   # 会把它当第 5 个证据源')
    print('           用 xcpcio 当榜单的场次见 manifest 里 board.source=xcpcio')
    print_stats('xcpcio 索引')
    return 0 if not fail else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
