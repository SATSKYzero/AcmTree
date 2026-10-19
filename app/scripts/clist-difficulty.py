#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
CLIST 难度（`https://clist.by/api/v4/`）—— 「数值难度」字段组的第三员。

口径：cf 有本身难度、clist 也有难度 ⇒ 数值难度作为一个字段组；clist 这一份由本脚本接。

## 为什么单独一个脚本（而不是一个"来源适配器"）

clist **不是**一棵树：它给的是"**已经有**的那些题目"的难度 ⇒ 它的动作是**给包里的 P 补一格**，
不是产出片段。所以它和 `nature-baseline.py` 同形（**包产出之后就地写值**），而不是和
`qoj_adapter.py` 那样产 crate 片段。落点：`xcpc_pipeline` 的「回代 baseline」旁边。

## 口径

- 抓的是 `problem` 端点的 `rating`（clist 自己的难度口径），写进 **`clistDifficulty`**。
- **只抓我们链接里出现过的 judge**（`codeforces.com` / `atcoder.jp` / `ac.nowcoder.com` /
  `acm.hdu.edu.cn` / `contest.ucup.ac` / `qoj.ac`）—— clist 全库 17.7 万题，没必要翻。
- 匹配用**归一化过的身份**（`judge|cid|题号`），不是比 URL 字符串：
  CF 的 `/contest/393/problem/A` 与 `/gym/393/problem/A`、`?locale=en` 之类的差异都能对上。
- **没难度就不写**（clist 的 `rating` 常为 `null`）—— 与 CF/AtCoder 那边同一条口径。

## 凭据

`me.json` 的 `clist: { username, apiKey }`（或环境变量 `CLIST_USERNAME` / `CLIST_API_KEY`）。
⚠️ clist 的鉴权是 `Authorization: ApiKey <用户名>:<key>` —— **用户名不是可选的**
（只给 key 一律 401，实测）。没有凭据 ⇒ 整个脚本**友好跳过**（exit 0，不当失败）。

## 限速

clist 官方口径 **10 请求/分钟**。这里每次请求之间睡 `SLEEP_SECONDS`（默认 6.5s ≈ 9/min），
翻页用 `limit=1000`（实测**上限真给 1000**，不是 100）⇒ 一个 judge 也就十几页。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(REPO, 'acm-data', 'raw', 'Scaper', '05 xcpc', 'lib'))
sys.path.insert(0, os.path.join(REPO, 'acm-data', 'raw', 'Scaper', '05 xcpc'))
sys.path.insert(0, os.path.join(REPO, 'acm-data', 'raw', 'Scaper', 'lib'))

from xcpc_common import read_json, rel, write_json  # noqa: E402

# ⚠️ `normalize_url` / 缓存路径的**唯一一份实现**在 `lib/clist_evidence.py`（"上游有没有"的判据
#    也是它 —— 抓取、体检、原料需求三处共用，见那个模块的头注）。这里只是把它导进来用。
from clist_evidence import normalize_url, TABLE_JSON as CACHE_FILE  # noqa: E402,F401
from selftest_kit import Selftest
# 登录态判据（clist 凭据失效 ⇒ **401 + 0 字节**）—— 各渠道共用一份，见 `Scaper/lib/auth_state.py`
import auth_state  # noqa: E402

API = 'https://clist.by/api/v4'
CACHE_DIR = os.path.dirname(CACHE_FILE)
DEFAULT_PACKAGE = os.path.join(REPO, 'acm-data', 'nodes', 'all_nodes.json')

#: **CF 同轮共用题**的对应关系（`"<我这场的 cid:idx>" → "<老家那场的 cid:idx>"`）。
#: 写它的是 `cf_contest_adapter.py`（它按"同轮 + 同题名"认出来的，见那边的注释）——
#: 路径与那个适配器一致（`05 xcpc/cache/cf_contest/reuse.json`）。
REUSE_FILE = os.path.join(REPO, 'acm-data', 'raw', 'Scaper', '05 xcpc', 'cache', 'cf_contest',
                          'reuse.json')

PAGE_SIZE = 1000            # 实测上限就是 1000
SLEEP_SECONDS = 6.5         # clist: 10 请求/分钟 ⇒ 保守一点
MAX_PAGES = 40              # 一个 judge 最多翻这么多页（40×1000 = 4 万题；撞上就是出事了）
NEW_PAGES = 1               # 不带 --force 时：每个 judge **只翻最新的一页**（1000 条，补新题够用）
FIELD = 'clistDifficulty'

#: 抓哪些 judge（→ clist 的 `resource` 名）。
#: ⚠️ **暂时只到 CF 正式轮次 + AtCoder**：
#:   · gym **不抓** —— 实测 clist 一个都不给（832/832 缺），与 CF 自己不给是同一件事；
#:   · 牛客/杭电/UCup/QOJ 先摘掉（它们的链接形状各异，等要用时再往上加一行，
#:     `normalize_url()` 里已经有它们的解析规则，加回来即可）。
RESOURCES = {
    'codeforces.com': 'codeforces.com',
    'atcoder.jp': 'atcoder.jp',
    # 牛客：**有难度**（实测 1000 条里 889 带 rating）—— 多校那批题就在这
    'ac.nowcoder.com': 'ac.nowcoder.com',
    # 杭电：现在是**空跑**（`acm.hdu.edu.cn` 0 题、`bestcoder` 624 题但 0 带 rating，实测）
    # —— 留着这一行：clist 哪天给它算了难度，重抓一次就自动进来（不用改代码）
    'acm.hdu.edu.cn': 'acm.hdu.edu.cn',
}

#: URL → `judge|cid|题号` 的匹配规则**已经搬到** `lib/clist_evidence.py`
#: （那边的 `clist_state()` 也要用它判"上游有没有"，一份实现两处用 —— 见模块头注）。


def credentials() -> tuple:
    """`(username, api_key)` —— 环境变量 > `me.json` 的 `clist`；都没有就空"""
    user = os.environ.get('CLIST_USERNAME', '').strip()
    key = os.environ.get('CLIST_API_KEY', '').strip()
    if user and key:
        return user, key
    try:
        import me as me_mod
        user = user or str(me_mod.get('clist.username') or '').strip()
        key = key or str(me_mod.get('clist.apiKey') or '').strip()
    except Exception:                                        # noqa: BLE001
        pass
    return user, key


def _get(path: str, user: str, key: str, timeout: int = 60) -> dict:
    url = f'{API}/{path}'
    req = urllib.request.Request(url, headers={
        'User-Agent': 'acm-tree/1.0',
        'Accept': 'application/json',
        'Authorization': f'ApiKey {user}:{key}',
    })
    # ★ 凭据失效（clist ⇒ **401 + 0 字节**）由共用件定性：过期就当场停、说清去 me.json 改哪一份
    _status, text = auth_state.open_text(req, platform='clist', timeout=timeout, where=url)
    return json.loads(text)


def fetch_resource(resource: str, user: str, key: str, out: dict, verbose: bool = True,
                   max_pages: int = MAX_PAGES, newest_first: bool = False) -> int:
    """
    翻一个 judge 的题 ⇒ 写进 `out`（`归一化身份 → 难度`）。返回落进的条数。

    @param newest_first - `True` = 按 `id` **倒序**（先翻刚加的新题）；配合 `max_pages` 就是"只补新题"
    """
    added = 0
    order = '-id' if newest_first else 'id'
    for page in range(max_pages):
        offset = page * PAGE_SIZE
        path = (f'problem/?format=json&limit={PAGE_SIZE}&offset={offset}'
                f'&resource={resource}&order_by={order}')
        if verbose:
            print(f'   {resource} 第 {page + 1} 页（offset {offset}）…', flush=True)
        try:
            doc = _get(path, user, key)
        except urllib.error.HTTPError as e:
            if e.code == 429:                                # 限速：等一轮再来
                if verbose:
                    print('     429 限速 ⇒ 等 60s', flush=True)
                time.sleep(60)
                continue
            raise
        rows = doc.get('objects') or []
        for row in rows:
            rating = row.get('rating')
            if rating is None or rating == '':
                continue                                     # **没难度就不写**（缺失 ≠ 0）
            ident = normalize_url(row.get('url') or '')
            if not ident:
                continue
            out[ident] = int(rating)
            added += 1
        if len(rows) < PAGE_SIZE:
            break                                            # 翻到底了
        time.sleep(SLEEP_SECONDS)
    return added


def fetch(resources: list, verbose: bool = True, force: bool = False,
          new_pages: int = NEW_PAGES) -> dict:
    """
    抓这些 judge 的题难度 ⇒ 缓存文件（`{归一化身份: 难度}`）。

    ⚠️ **clist 的难度几乎不会变**（clist 给出的难度几乎不会更改）⇒
       默认**只补新题**：按 `id` 倒序翻每个 judge 的前 `new_pages` 页，**合并**进已有缓存；
       要全量重来才用 `force=True`（**兜底全部重爬**）。
    """
    user, key = credentials()
    if not user or not key:
        if verbose:
            print('⚠️ 没有 clist 凭据（`me.json` 的 `clist.username` / `clist.apiKey`，'
                  '或环境变量 `CLIST_USERNAME` / `CLIST_API_KEY`）⇒ **跳过**（不是失败）')
        return {}
    # ⚠️ `read_json` 对**不存在**的文件会抛（它只兜 JSON 坏了）⇒ 先看文件在不在
    have = {} if force else ((read_json(CACHE_FILE) or {}) if os.path.isfile(CACHE_FILE) else {})
    out = dict(have)
    t0 = time.time()
    for resource in resources:
        n = fetch_resource(resource, user, key, out, verbose=verbose,
                           max_pages=(MAX_PAGES if force else new_pages),
                           newest_first=(not force))
        if verbose:
            print(f'   {resource}：带难度的题 +{n}（累计 {len(out)}）')
    os.makedirs(CACHE_DIR, exist_ok=True)
    write_json(CACHE_FILE, out)
    if verbose:
        print(f'↓ {rel(CACHE_FILE)}：{len(out)} 条难度（{time.time() - t0:.0f}s'
              f'，{"全量重抓" if force else "只补新题"}）')
    return out


def load_reuse(path: str = REUSE_FILE) -> dict:
    """CF 同轮共用题的对应关系（文件不在 / 坏了 ⇒ 空表，**不当失败**）"""
    if not os.path.isfile(path):
        return {}
    try:
        return read_json(path) or {}
    except Exception:                                            # noqa: BLE001
        return {}


def _reuse_ident(raw: str) -> str:
    """`2202:G2` → `codeforces.com|2202|G2`（认不出 ⇒ 空串，**不瞎认**）"""
    parts = str(raw or '').split(':')
    if len(parts) != 2 or not parts[0].isdigit() or not re.fullmatch(r'[A-Za-z0-9]{1,3}', parts[1]):
        return ''
    return f'codeforces.com|{parts[0]}|{parts[1]}'


def expand_reuse(table: dict, pairs: dict) -> tuple:
    """
    按 CF 自己给的"同轮共用题"关系，把**只有一边有难度**的题补上另一边。

    **cf contest 异场同题，clist 只有一处有 rating** ⇒ 由于 cf contest 的结构稳定，同步。

    为什么这条关系可信：它不是"题名像"猜出来的，而是 **CF 的结构**决定的 —— 同一轮
    Div.1 / Div.2 共用题，`cf_contest_adapter` 按"同一轮 + 同题名"把两份 P 对应起来
    （`reuse.json`）。实测（52 对）：**两边 P 都在包里、全都是"copy 侧没有难度、
    home 侧有"** ⇒ 缺口那 52 格全靠它补。

    三条口径：
      · **只补缺的**（两边都有值 ⇒ 谁都不动：clist 的难度几乎不变，别拿一边去盖另一边）；
      · **两边都缺 ⇒ 不动**（缺失 ≠ 0，不猜）；
      · 认不出的键（没有冒号 / cid 不是数字）⇒ 跳过。

    @returns `(新表, {补上的身份: (值, 出处身份)})`
    """
    out = dict(table or {})
    filled: dict = {}
    for raw_a, raw_b in (pairs or {}).items():
        ka, kb = _reuse_ident(raw_a), _reuse_ident(raw_b)
        if not ka or not kb or ka == kb:
            continue
        va, vb = out.get(ka), out.get(kb)
        if va is None and vb is not None:
            out[ka], filled[ka] = vb, (vb, kb)
        elif vb is None and va is not None:
            out[kb], filled[kb] = va, (va, ka)
    return out, filled


def prepared_table(verbose: bool = True) -> dict:
    """
    缓存表 + **CF 同轮共用题同步** —— `sync` / `apply` 两条路共用这一处。

    ⚠️ 同步**只在内存里做**（不写回 `difficulty.json`）：那份缓存是"clist 说了什么"的**原始证据**
    （`lib/clist_evidence.py` 还拿它判"上游到底有没有这一条"）⇒ 派生值不该混进去。
    """
    table = (read_json(CACHE_FILE) or {}) if os.path.isfile(CACHE_FILE) else {}
    if not table:
        return {}
    table, filled = expand_reuse(table, load_reuse())
    if filled and verbose:
        print(f'   · CF 同轮共用题：补上 {len(filled)} 格难度'
              f'（例：{list(filled.items())[0][0]} ← {list(filled.items())[0][1][1]}）')
    return table


def apply_to_package(package: str, table: dict, dry_run: bool = False, verbose: bool = True) -> dict:
    """
    给包里**已经有**的 P 补 `clistDifficulty`（就地改 `package`）。

    @returns `{hit, miss, kept, wrote}` —— hit=匹配上的题、wrote=这次真写了几格
    """
    doc = read_json(package)
    stats = {'hit': 0, 'miss': 0, 'kept': 0, 'wrote': 0}
    for rec in doc.get('records') or []:
        if str(rec.get('节点类型') or '') != 'P':
            continue
        ident = normalize_url(rec.get('link') or '')
        if not ident:
            continue
        rating = table.get(ident)
        if rating is None:
            stats['miss'] += 1
            continue
        stats['hit'] += 1
        if str(rec.get(FIELD) or '').strip() and str(rec.get(FIELD)) == str(rating):
            stats['kept'] += 1
            continue
        stats['wrote'] += 1
        if not dry_run:
            rec[FIELD] = str(rating)
    if not dry_run and stats['wrote']:
        write_json(package, doc)
    if verbose:
        print(f'   clist 难度：匹配上 {stats["hit"]} 道 / 表里没有 {stats["miss"]} 道 / '
              f'本次写 {stats["wrote"]} 格（已是最新 {stats["kept"]}）')
    return stats


def package_resources(package: str) -> list:
    """包里 P 的链接涉及哪些 judge（只抓这些，别翻 clist 全库 17.7 万题）"""
    doc = read_json(package)
    seen = set()
    for rec in doc.get('records') or []:
        if str(rec.get('节点类型') or '') != 'P':
            continue
        ident = normalize_url(rec.get('link') or '')
        if ident:
            seen.add(ident.split('|', 1)[0])
    return [RESOURCES[j] for j in RESOURCES if j in seen]


def sync(package: str, force: bool = False, dry_run: bool = False, verbose: bool = True,
         refresh: bool = False) -> int:
    """
    默认动作（**链子里跑的就是它**）：

    · 缓存**在** ⇒ **只回写，一次也不联网** —— clist 的难度几乎不变，
      每次构建都去抓纯属浪费（它还有 10 请求/分钟的限速）；
    · 缓存**不在** ⇒ 抓一次（按包里的链接决定抓哪些 judge）；
    · `force` ⇒ 全量重抓（**兜底全部重爬**）；
    · `refresh` ⇒ 只补新题（按 id 倒序翻每个 judge 的前几页）。
    """
    want = package_resources(package)
    if not want:
        print('（包里 P 的链接认不出任何 clist judge ⇒ 跳过）')
        return 0
    has_cache = os.path.isfile(CACHE_FILE) and bool(read_json(CACHE_FILE) or {})
    if not (force or refresh) and has_cache:
        table = prepared_table(verbose)
        if verbose:
            print(f'🔎 clist 难度：用缓存（{len(table)} 条；clist 的难度几乎不变，'
                  f'要重抓用 `--force`）')
        apply_to_package(package, table, dry_run=dry_run, verbose=verbose)
        return 0
    if verbose:
        print(f'🔎 clist 难度：要抓 {len(want)} 个 judge：{"、".join(want)}'
              f'（{"全量重抓" if force else "只补新题"}）')
    table = fetch(want, verbose=verbose, force=force)
    if not table:
        return 0
    table, filled = expand_reuse(table, load_reuse())
    if filled and verbose:
        print(f'   · CF 同轮共用题：补上 {len(filled)} 格难度')
    apply_to_package(package, table, dry_run=dry_run, verbose=verbose)
    return 0


def main(argv):
    ap = argparse.ArgumentParser(description='CLIST 难度 → 包里 P 的 `clistDifficulty`')
    ap.add_argument('action', nargs='?', default='sync', choices=('sync', 'fetch', 'apply', 'selftest'))
    ap.add_argument('--package', default=DEFAULT_PACKAGE)
    ap.add_argument('--force', action='store_true',
                    help='**兜底全部重爬**：忽略缓存、把每个 judge 全量重抓一遍'
                         '（clist 的难度几乎不变，平时用不到；限速 10 请求/分钟，会跑一阵）')
    ap.add_argument('--refresh', action='store_true',
                    help='只补新题：按 id 倒序翻每个 judge 最新的一页，合并进缓存')
    ap.add_argument('--dry-run', action='store_true', dest='dry_run')
    ap.add_argument('--quiet', action='store_true')
    args = ap.parse_args(argv)
    if args.action == 'selftest':
        return _selftest()
    if args.action == 'fetch':
        want = package_resources(args.package)
        fetch(want, verbose=not args.quiet, force=args.force)
        return 0
    if args.action == 'apply':
        table = prepared_table(verbose=not args.quiet)
        if not table:
            print(f'⚠️ 还没有缓存 {rel(CACHE_FILE)} ⇒ 先跑 `fetch`（或直接跑不带参数的 sync）')
            return 0
        apply_to_package(args.package, table, dry_run=args.dry_run, verbose=not args.quiet)
        return 0
    return sync(args.package, force=args.force, dry_run=args.dry_run,
                verbose=not args.quiet, refresh=args.refresh)


# ================================================================
# 自测（纯函数 + 落盘，不联网）
# ================================================================

def _selftest() -> int:
    import tempfile
    _st = Selftest('clist 难度', verbose=True)
    ok = _st.ok

    # ① URL → 归一化身份（同一题的不同写法必须归一）
    ok(normalize_url('https://codeforces.com/contest/393/problem/A') == 'codeforces.com|393|A',
       'CF contest 写法')
    ok(normalize_url('https://codeforces.com/gym/105161/problem/B') == 'codeforces.com|105161|B',
       'CF gym 写法（与 contest 同一个身份形状）')
    ok(normalize_url('https://codeforces.com/problemset/problem/663/B') == 'codeforces.com|663|B',
       'CF problemset 写法')
    ok(normalize_url('https://atcoder.jp/contests/abc138/tasks/abc138_a') == 'atcoder.jp|abc138|A',
       'AtCoder：题号取 task 尾巴')
    ok(normalize_url('https://ac.nowcoder.com/acm/contest/12345/C') == 'ac.nowcoder.com|12345|C',
       '牛客')
    ok(normalize_url('https://acm.hdu.edu.cn/showproblem.php?pid=1000') == 'acm.hdu.edu.cn|1000|',
       '杭电（只有 pid）')
    ok(normalize_url('https://qoj.ac/contest/100/problem/A') == 'contest.ucup.ac|100|A',
       'QOJ/UCup 那种 /contest/<id>/problem/<letter>')
    ok(normalize_url('') == '' and normalize_url('https://example.com/x') == '',
       '认不出 ⇒ 空串（不瞎认）')

    # ② 回写：只认归一化身份，**没难度不写**，已是最新不重复写
    tmp = os.path.join(tempfile.gettempdir(), 'clist-selftest-pkg.json')
    with open(tmp, 'w', encoding='utf-8') as fh:
        json.dump({'records': [
            {'节点类型': 'P', 'extKey': 'cf:c:393:p:A',
             'link': 'https://codeforces.com/contest/393/problem/A'},
            {'节点类型': 'P', 'extKey': 'cf:c:663:p:B',
             'link': 'https://codeforces.com/problemset/problem/663/B'},   # 表里没有
            {'节点类型': 'P', 'extKey': 'atcoder:c:abc138:p:A',
             'link': 'https://atcoder.jp/contests/abc138/tasks/abc138_a',
             'clistDifficulty': '1174'},                                   # 已经是这个值
            {'节点类型': 'C', 'extKey': 'cf:c:393', 'link': 'https://codeforces.com/contest/393'},
        ]}, fh)
    table = {'codeforces.com|393|A': 2120, 'atcoder.jp|abc138|A': 1174}
    st = apply_to_package(tmp, table, verbose=False)
    ok(st['hit'] == 2 and st['miss'] == 1 and st['wrote'] == 1 and st['kept'] == 1,
       f'回写统计（实际 {st}）')
    doc = read_json(tmp)
    by = {r['extKey']: r for r in doc['records']}
    ok(by['cf:c:393:p:A'].get(FIELD) == '2120', '写进 clistDifficulty（字符串）')
    ok(FIELD not in by['cf:c:663:p:B'], '表里没有 ⇒ **不写**（缺失 ≠ 0）')
    ok(by['atcoder:c:abc138:p:A'].get(FIELD) == '1174', '值没变 ⇒ 保持原样')
    ok(FIELD not in doc['records'][3], 'C 节点一个字段都不动')

    # ③ 幂等：再跑一遍 ⇒ 0 写
    st2 = apply_to_package(tmp, table, verbose=False)
    ok(st2['wrote'] == 0 and st2['kept'] == 2, f'幂等（实际 {st2}）')

    # ④ 没凭据 ⇒ fetch 友好跳过（不抛、不联网）
    # ⚠️ 必须**注入空凭据**：`me.json` 里已经有 clist 的 key ⇒ 直接跑会真联网（不注入就会踩到）
    real_cred = credentials
    globals()['credentials'] = lambda: ('', '')
    try:
        got = fetch(['codeforces.com'], verbose=False)
        ok(got == {}, '没有凭据 ⇒ fetch 返回空、不抛（友好跳过）')
    finally:
        globals()['credentials'] = real_cred

    # ⑤ CF 同轮共用题同步（纯函数，不碰网络与磁盘）
    ok(_reuse_ident('2202:G2') == 'codeforces.com|2202|G2', '`cid:idx` → 归一化身份')
    ok(_reuse_ident('2202') == '' and _reuse_ident('abc:G2') == '' and _reuse_ident('') == '',
       '不是 `<数字 cid>:<题号>` ⇒ 空串（不瞎认）')
    base = {'codeforces.com|2201|D': 2439, 'codeforces.com|2199|A': 800}
    pairs = {'2202:F': '2201:D',        # copy 侧缺、home 侧有 ⇒ 补
             '2199:A': '2198:B',        # 反向：home 侧缺、copy 侧有 ⇒ 也补（关系是同一道题）
             '2197:X': '2196:Y',        # 两边都缺 ⇒ 不动
             'bad': '2201:D'}           # 坏键 ⇒ 跳过
    got, filled = expand_reuse(base, pairs)
    ok(got['codeforces.com|2202|F'] == 2439, '★ 一边有难度 ⇒ 补到另一边（值一致）')
    ok(got['codeforces.com|2198|B'] == 800, '★ **反方向也补**（关系是"同一道题"，不分谁先）')
    ok('codeforces.com|2197|X' not in got and 'codeforces.com|2196|Y' not in got,
       '两边都没有 ⇒ **不写**（缺失 ≠ 0，不猜）')
    ok(len(filled) == 2 and filled['codeforces.com|2202|F'] == (2439, 'codeforces.com|2201|D'),
       '同步记账：补了哪几格 + 出处（界面/日志要看得出这值是从哪来的）')
    ok(base == {'codeforces.com|2201|D': 2439, 'codeforces.com|2199|A': 800},
       '★ **不改原表**（`difficulty.json` 是"clist 说了什么"的原始证据）')
    both = expand_reuse({'codeforces.com|1|A': 100, 'codeforces.com|2|B': 200}, {'1:A': '2:B'})[0]
    ok(both['codeforces.com|1|A'] == 100 and both['codeforces.com|2|B'] == 200,
       '★ 两边都有值 ⇒ **谁都不动**（clist 的难度几乎不变，绝不拿一边盖另一边）')
    ok(load_reuse(os.path.join(tempfile.gettempdir(), '这里没有这个文件.json')) == {},
       '复用关系文件不在 ⇒ 空表（不当失败）')

    os.remove(tmp)
    return _st.done()


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
