#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
**手输注册表**：XCPC 场次的"身份 + 归类"唯一真源（脚本只出候选，人拍板）

为什么要有它
---------------------------------------
「脚本自动整合&归类」与「手输注册表」结合，分工写死：

    抓取层（全自动）  build_rankland_index / QOJ 提交（含赛名，见 04）/ CF 白名单
    归类层（半自动）  本脚本 `scan` 出候选 → **人**在注册表里回 yes/no
    组装层（全自动）  本脚本 `build` → `xcpc_contests.json` → `xcpc_pipeline.py` → `mix_contain_xcpc.json`

**清单是派生产物**（不再手工编辑）；手工条目也搬进注册表。三个决定：

  * 归不到 rankland 的场次（CF gym / QOJ 比赛号）**不进树**，留在候选区等人拍板
  * 明确非 XCPC 的（SEERC/NWERC/NAC/训练营…）**记下来但 `xcpc: false`，不导**
  * 键 = rankland slug；没有 slug 的条目键用平台号（`cf:104813` / `qoj:3387`）

文件结构（`05 xcpc/xcpc_registry.json`）
---------------------------------------
    contests   ★人写（机器只补空壳）：slug / 平台号 → { xcpc, series, year, name, board,
                sources, submissions, aliases, identity, note }
    merges     ★人写：`{"cf:104373": "icpc2021macau"}` —— 人确认过"这两条是同一场"
    pending    ☆机器写：候选区，人只填 `answer`（yes / no / 或改成别的 slug）

⚠️ `merges` 目前是**单向**的（注册表 → 清单 → 包）。应用侧如果直接改了某个节点的 extKey
（「🔑 补身份键」页能改单点），要手工在这里补一条映射，否则下次导入会分裂成两棵子树。
设计轮廓见"身份与手改"那套口径；待办状态由作者自己维护。

`board`/`sources`/`submissions` 一律**照清单的形状**存（不翻译），
这样 `build` 只是把它们搬过去 —— 手写的那堆 note 一个字都不会丢。

用法
----
    python xcpc_registry.py seed            # 从现有清单迁入（首次一次）
    python xcpc_registry.py scan            # 刷新候选（含 QOJ 分类，走 cookie）
    python xcpc_registry.py status          # 看概况与待决项（**建议收**的条数也在这儿）
    python xcpc_registry.py find --suggest  # **搜候选区**：关键词 / `--year` / `--cls` / `--suggest`
    python xcpc_registry.py approve --suggest   # **批准**（= 你拍板；`--dry-run` 先预演）
    python xcpc_registry.py answer qoj:3387 yes # 逐条回答（key 可用逗号批量）
    python xcpc_registry.py build           # 注册表 → 清单
    python xcpc_registry.py build --dry-run # 只预演：谁进树、谁出树

「**推荐 → 人批准**」那条线：`scan` 会把**判得出分类**的 CF gym 全提成候选（分类来自
`cf_adapter.py --gym-meta` 的全量元信息），`suggest_of()` 再标出**建议收**的那些
（EC 赛区 / CCPC 系列 / 省赛·邀请赛那 3 类），**脚本不自己拍板**；
`build`（构建链第 1 步）会提醒还剩多少条没拍板，批准动作是 `approve`。
"""

from __future__ import annotations

import argparse
import collections
import json
import os
import re
import subprocess
import sys

sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, 'lib'))
sys.path.insert(0, os.path.abspath(os.path.join(HERE, '..', 'lib')))       # …/Scaper/lib

from match import (  # noqa: E402
    build_season_years, classify_xcpc, index_year, match_by_gym, match_by_problem_ids,
    match_by_problem_names, name_hint, xcpcio_hint,
)
from xcpc_common import (GYM_WHITELIST, MANIFEST, PROVINCIAL_SEG, place_of_name,  # noqa: E402
                         SERIES_NAMES, read_json, rel, write_json)
from read_modes import print_stats, configure, retry_call, should_refetch  # noqa: E402

REGISTRY = os.path.join(HERE, 'xcpc_registry.json')
INDEX = os.path.join(HERE, 'cache', 'rankland_index.json')
QOJ_INDEX = os.path.join(HERE, '..', '04 qoj', 'cache', 'qoj_contest_titles.json')
QOJ_CATS = os.path.join(HERE, 'cache', 'qoj_categories.json')
XCPCIO = os.path.join(HERE, 'cache', 'xcpcio_tree.json')
QOJ_SUBS = os.path.abspath(os.path.join(HERE, '..', '04 qoj', 'qoj_submissions.json'))
WHITELIST = GYM_WHITELIST   # ⚠️ 路径只有一处（`xcpc_common.GYM_WHITELIST`）
QOJ_SUBS_MANIFEST_PATH = 'acm-data/raw/Scaper/04 qoj/qoj_submissions.json'

_PROB_IN_LINK = re.compile(r'/problem/(\d+)')
_CONTEST_IN_LINK = re.compile(r'/contest/(\d+)')


# ================================================================
# 读写
# ================================================================

def load(path: str = '') -> dict:
    p = path or REGISTRY
    if not os.path.isfile(p):
        return {'contests': {}, 'merges': {}, 'pending': {}}
    doc = read_json(p)
    for k in ('contests', 'merges', 'pending'):
        doc.setdefault(k, {})
    return doc


def save(reg: dict, path: str = '') -> str:
    p = path or REGISTRY
    # pending 里已经答完的（answer 非空）留在原地当记录，不自动删
    write_json(p, reg)
    return p


def _build_index_inline() -> None:
    """
    现场跑一次 `build_rankland_index.py` 把索引建出来（**只有索引完全不在时才走这里**）。

    为什么（2026-10-19 实测踩到）：一份**没有抓取缓存**的副本（公开发布包 / 新机器）上点
    「重建总包」，第 1 步 `registry build` 就死在 `缺 cache/rankland_index.json` 上 ——
    而"缺就补"正是这一层其它所有原料的语义（`read_modes` 的 KEEP）。
    `build_chain.py:283` 那段注释早就写着"有 builder 的就跑 builder"（那里只覆盖"按需求补抓"档），
    ⇒ 把同一套语义补到这里，链子的第一步就不会再"把路堵死"。

    ⚠️ **会长**：实测整份 RankLand 索引十几分钟（网络）。所以只在**索引不存在**时才跑；
       文件在就一个字都不碰（`build_rankland_index` 自己也有"缺的才抓"的缓存语义）。
    """
    script = os.path.join(HERE, 'build_rankland_index.py')
    if not os.path.isfile(script):
        return
    print(f'⚠️ 缺 {rel(INDEX)} —— 现场建一份（跑 `build_rankland_index.py`，要联网，可能要十几分钟）')
    sys.stdout.flush()
    try:
        subprocess.run([sys.executable, '-B', script], cwd=HERE, check=False)
    except OSError as err:                                  # noqa: BLE001
        print(f'⚠️ 起不来：{err}')


def load_index() -> dict:
    if not os.path.isfile(INDEX):
        _build_index_inline()
    if not os.path.isfile(INDEX):
        sys.exit(f'❌ 缺 {rel(INDEX)} —— 先跑 `python build_rankland_index.py` 建出来（要联网）')
    return read_json(INDEX)


def load_qoj_names() -> dict:
    if not os.path.isfile(QOJ_INDEX):
        return {}
    return read_json(QOJ_INDEX)          # 04 独家维护：{场次号: {names, title, …}}


def load_xcpcio() -> list:
    """xcpcio 的目录树（`系列/届次/站点`）—— 见 `build_xcpcio_index.py`"""
    if not os.path.isfile(XCPCIO):
        return []
    try:
        return read_json(XCPCIO).get('contests') or []
    except (ValueError, OSError):
        return []


def apply_xcpcio(names: list, year: str, tree: list, index: dict, season_years: dict,
                 ev: list, guess: str) -> tuple[str, list]:
    """
    把 xcpcio 的"系列/届次/站点"加成证据；能解出 rankland slug 就顺手提上来。

    只把**命中**当证据（xcpcio 没收录 ≠ 不是 XCPC，它只覆盖 XCPC 系列）。
    年份用**届次推出来的**，不用候选自己的（否则 `ccpc/10th/…` 会被当成 2025）。
    """
    for _s, series, season, site, slug, path in xcpcio_hint(names, tree, year=year,
                                                            index=index,
                                                            season_years=season_years, top=3):
        ev = ev + [f'xcpcio 目录：{series}/{season}/{site}'
                   + (f' → 解出 {slug}' if slug else '（届次对不上年份或省赛命名不同，只作证据）')]
        if not guess and slug:
            guess = slug
    if len(ev) >= 3 and not year:
        ev = ev + ['（这场的年份没写在名字里，所以列了该站点的几个年份；xcpcio 目录里可能还有）']
    return guess, ev


def qoj_aliases(cid: str, names: dict) -> list:
    return list((names.get(str(cid)) or {}).get('names') or [])


def platform_ids(entry: dict) -> tuple[list, list]:
    """条目里用到的 (gym 号, QOJ 比赛号) 列表"""
    gyms, qojs = [], []
    items = [entry.get('board') or {}] + list(entry.get('sources') or []) \
        + list(entry.get('submissions') or [])
    for s in items:
        if s.get('gym'):
            gyms.append(str(s['gym']))
        if (s.get('source') or '') == 'qoj' and s.get('contest'):
            qojs.append(str(s['contest']))
    return gyms, qojs


# ================================================================
# seed：把现有清单搬进注册表（现状即真相）
# ================================================================

def cmd_seed(args) -> int:
    if os.path.isfile(REGISTRY) and not args.force:
        print(f'⚠️ {rel(REGISTRY)} 已存在 —— 要重建加 --force（会覆盖判断区）')
        return 1
    manifest = read_json(args.manifest or MANIFEST)
    index = load_index()
    reg = {'contests': {}, 'merges': {}, 'pending': {}}
    selfmade = []
    for c in manifest.get('contests') or []:
        slug = str(c.get('slug') or '')
        if not slug:
            continue
        in_index = slug in (index.get('bySlug') or {})
        series = (c.get('series') or {}).get('id') or ''
        mid = (c.get('mid') or {}).get('id') or ''
        year = ''
        m = re.search(r'(?:19|20)\d{2}', mid + ' ' + str((c.get('mid') or {}).get('name') or ''))
        if m:
            year = m.group(0)
        entry = {
            'xcpc': True,                 # 现状即真相：已在树里 = 人已经认可过
            'series': series,
            'year': year,
            'name': None,                 # None = 用 rankland 索引里的赛名
            'identity': 'rankland' if in_index else 'self',
            'board': c.get('board') or {},
            'sources': c.get('sources') or [],
            'submissions': c.get('submissions') or [],
            'aliases': c.get('aliases') or {},
            'note': c.get('name') or '',
        }
        reg['contests'][slug] = entry
        if not in_index:
            selfmade.append(slug)

    # 白名单里明确不导的 gym：按"记下来但 false"处理（人是这么判的，理由也搬过来）
    if os.path.isfile(WHITELIST):
        wl = read_json(WHITELIST)
        for g in wl.get('gyms') or []:
            if g.get('include'):
                continue
            reg['contests'][f"cf:{g['id']}"] = {
                'xcpc': False,
                'series': '', 'year': str(g.get('year') or ''), 'name': g.get('name') or '',
                'identity': 'none',
                'board': {}, 'sources': [], 'submissions': [], 'aliases': {},
                'note': f"CF 白名单里 include=false：{g.get('why') or ''}",
            }
        wl_handle = wl.get('handle') or ''

    save(reg)
    print(f'✅ {rel(REGISTRY)}')
    print(f'   从清单迁入 {len(manifest.get("contests") or [])} 场'
          f'（其中 {len(selfmade)} 场是自造身份 cf<gym>，标了 identity=self）')
    print(f'   白名单里 include=false 的 gym 也记下了（xcpc=false，不导）')
    print(f'   下一步：python xcpc_registry.py scan')
    return 0


# ================================================================
# scan：刷新候选区
# ================================================================

def _cf_problem_names(gym: str) -> list:
    p = os.path.join(HERE, 'cache', f'cf_standings_{gym}.json')
    if not os.path.isfile(p):
        return []
    try:
        d = read_json(p)
    except (ValueError, OSError):
        return []
    return [str(x.get('name') or '') for x in (d.get('problems') or [])]


def _qoj_groups() -> dict:
    """QOJ 提交文件 → `{比赛号: {'pids':…, 'names':…, 'n':…}}`"""
    if not os.path.isfile(QOJ_SUBS):
        return {}
    rows = read_json(QOJ_SUBS)
    if not isinstance(rows, list):
        rows = rows.get('submissions') or []
    out: dict[str, dict] = {}
    for r in rows:
        link = str(r.get('题目链接') or '')
        c = _CONTEST_IN_LINK.search(link)
        if not c:
            continue
        d = out.setdefault(c.group(1), {'pids': set(), 'names': set(), 'n': 0})
        p = _PROB_IN_LINK.search(link)
        if p:
            d['pids'].add(p.group(1))
        if r.get('题目名称'):
            d['names'].add(str(r['题目名称']))
        d['n'] += 1
    return out


def fetch_qoj_categories(cids: list, cookie: str) -> dict:
    """
    抓 QOJ 场次页，取它的**分类链**（登录态可见）。

    分类链是"是不是 XCPC + 系列 + 届次"的机器可读证据（见 `lib/match.py` 的
    `classify_xcpc`）。缓存到 `cache/qoj_categories.json`：QOJ 会加新场次，
    所以只抓没缓存的；**要重抓就 `configure(force=True)`**（= 命令行的 `--refresh-categories`，
    通用读取层的语义：把已有缓存当成不存在）。
    """
    cache: dict = {}
    if not should_refetch(os.path.isfile(QOJ_CATS)):
        try:
            cache = read_json(QOJ_CATS)
        except (ValueError, OSError):
            cache = {}
    todo = [c for c in cids if str(c) not in cache]
    if not todo or not cookie:
        return cache
    sys.path.insert(0, os.path.join(HERE, '..', '04 qoj'))
    from me import qoj_cookie                                        # noqa: E402
    from QOJ_submissions_scraper import fetch_html                   # noqa: E402
    print(f'   ↓ 抓 {len(todo)} 场的 QOJ 分类（登录态）')
    for i, cid in enumerate(todo, 1):
        try:
            html = retry_call(fetch_html, f'https://qoj.ac/contest/{cid}', cookie,
                              what=f'QOJ contest {cid}')
        except Exception as e:  # noqa: BLE001
            print(f'      {cid}: 取不到（{str(e)[:50]}）')
            continue
        ids = sorted({m for m in re.findall(r'href="/category/(\d+)"', html)}, key=int)
        chain = []
        for i2 in ids:
            try:
                h2 = retry_call(fetch_html, f'https://qoj.ac/category/{i2}', cookie,
                                what=f'QOJ category {i2}')
                mm = re.search(r'<title>(.*?)\s*-\s*QOJ\.ac</title>', h2, re.S)
                if mm:
                    nm = mm.group(1).strip()
                    if nm not in ('Contest Category', '~'):
                        chain.append(nm)
            except Exception:  # noqa: BLE001
                pass
        cache[str(cid)] = chain
        if i % 10 == 0 or i == len(todo):
            print(f'      … {i}/{len(todo)}')
    write_json(QOJ_CATS, cache)
    return cache


def hint_index(index: dict, reg: dict) -> dict:
    """
    给"赛名提示"用的临时索引：把**注册表里已有的名字/别名**拼进 rankland 的标题。

    为什么需要：rankland 有些场次**没有题名**（澳门站就是），题名判据用不上；
    而它的中文标题又和 QOJ 的英文别名对不上（「第 48 屆 ICPC 東亞洲區域賽（澳門）」vs
    「The 2023 ICPC Asia Macau Regional Contest」）。但**自有条目里有 CF 英文名**
    （`aliases.cf` / note），那就是现成的英中桥。
    """
    out = {'bySlug': {}}
    for slug, info in (index.get('bySlug') or {}).items():
        out['bySlug'][slug] = dict(info)
    for key, e in (reg.get('contests') or {}).items():
        # ⚠️ 只**补强 rankland 已有的条目**，不把自造身份（cf101775 这种）塞进候选集 ——
        # 否则 Yokohama 三个 gym 会互相匹配（实测：cf104849→cf104832→cf105633 转圈）
        if key not in out['bySlug']:
            continue
        info = out['bySlug'][key]
        extra = [str(e.get('note') or '')]
        al = e.get('aliases') or {}
        extra += [str(v) for v in al.values()] if isinstance(al, dict) else [str(al)]
        info['title'] = (str(info.get('title') or '') + ' ｜ ' + ' ｜ '.join(x for x in extra if x)).strip(' ｜')
    return out


def cmd_scan(args) -> int:
    reg = load(args.registry)
    index = load_index()
    names = load_qoj_names()
    hints_idx = hint_index(index, reg)
    season_years = build_season_years(index)      # (系列, 届次) → 年份，给 xcpcio 解 slug 用
    by_slug = index.get('bySlug') or {}
    known_gyms, known_qojs = set(), set()
    for k, e in reg['contests'].items():
        g, q = platform_ids(e)
        known_gyms |= set(g)
        known_qojs |= set(q)
        if k.startswith('cf:'):
            known_gyms.add(k.split(':', 1)[1])
        if k.startswith('qoj:'):
            known_qojs.add(k.split(':', 1)[1])

    qoj_groups = _qoj_groups()
    xcpcio = load_xcpcio()
    if xcpcio:
        print(f'   证据源：xcpcio 目录树 {len([x for x in xcpcio if not x.get("warmup")])} 场'
              f'（{rel(XCPCIO)}）')
    else:
        print('   ℹ️ 没有 xcpcio 目录树（先跑 build_xcpcio_index.py）—— 少一个证据源')
    cats = {}
    if not args.no_categories:
        # `--refresh-categories` = 通用读取层的 `--force`（这一支缓存重抓；注册表本身的 `--force` 是另一件事）
        configure(force=args.refresh_categories)
        from me import qoj_cookie
        cats = fetch_qoj_categories(sorted(set(qoj_groups) | known_qojs), qoj_cookie())

    added = 0
    # ---- 1) CF gym：白名单勾选的 ∪ **全量元信息里判得出 XCPC/UCup 的** ----
    # 为什么不止白名单：白名单只有"**我提交过的** gym"（`fetch_my_gyms` 从 user.status 反推），
    # 于是 rankland 没收录的场次永远进不来 —— 实测 CF 全量 gym 两千多场里判得出 XCPC/UCup 的
    # 有 **617** 场，而旧口径（白名单 ∪ rankland ∪ 我的提交）只覆盖到一小部分。
    # 全量元信息 = `cf_adapter.py --gym-meta` 的产物（公开、一次调用、几百 KB）；
    # 分类字段**在文件里就有**（由 `cf_board_adapter.gym_class_rule()` 算好），这里不重判。
    cf_want: dict = {}
    if os.path.isfile(WHITELIST):
        wl = read_json(WHITELIST)
        for g in wl.get('gyms') or []:
            if not g.get('include'):
                continue
            cf_want[str(g['id'])] = {                     # 白名单勾选的：可含"无归类"（人拍的）
                'name': str(g.get('name') or ''), 'year': str(g.get('year') or ''),
                'startAt': str(g.get('startAt') or ''), 'from': 'whitelist'}
        wl_handle = wl.get('handle') or ''
    meta_path = os.path.join(HERE, 'cache', 'cf_gym_meta.json')
    if os.path.isfile(meta_path):
        meta = read_json(meta_path)
        for gid, m in (meta.get('gyms') or {}).items():
            if not str(m.get('class') or '').startswith(('cf/gyms/xcpc', 'cf/gyms/ucup')):
                continue
            cf_want.setdefault(str(gid), {
                'name': str(m.get('name') or ''), 'year': str(m.get('year') or ''),
                'startAt': str(m.get('startAt') or ''), 'from': 'meta',
                'cls': str(m.get('class') or ''),
                # 年份依据（CF 没给开赛时间的那些是**推定**的，见 `cf_adapter._fill_missing_season`）
                'yearFrom': str(m.get('seasonFrom') or ''), 'yearEst': bool(m.get('seasonEst'))})
    for gid in sorted(cf_want, key=lambda x: (len(x), x)):
        info = cf_want[gid]
        if gid in known_gyms:
            continue
        slug, ev = match_by_gym(gid, index)
        if not slug:
            slug, ev2 = match_by_problem_names(_cf_problem_names(gid), index)
            ev = ev + ev2
        y0 = str(info.get('year') or '')
        if not y0:
            _m = re.search(r'(?:19|20)\d{2}', str(info.get('name') or ''))
            y0 = _m.group(0) if _m else ''
        slug, ev = apply_xcpcio([str(info.get('name') or '')], y0, xcpcio, index, season_years, ev, slug)
        conf = 0.95 if ev and ev[0].startswith('rankland 索引里 gym') else (0.8 if slug else 0.0)
        reg['pending'][f'cf:{gid}'] = {
            'kind': 'cf-gym',
            'title': info.get('name') or '',
            'year': y0,
            'startAt': info.get('startAt') or '',
            'source': info.get('from') or '',
            'cls': info.get('cls') or '',
            # ★ 年份依据：CF 只给一部分 gym 开赛时间（实测两千多场里一千多场没有）⇒ 标出推定来源，
            #   判"哪一年"时好掂量（`seasonFrom` 的三种取值见 `cf_adapter._fill_missing_season`）。
            'yearFrom': info.get('yearFrom') or '',
            'yearEst': bool(info.get('yearEst')),
            'guess': slug,
            'evidence': ev or ['rankland 没有对应，且题名也不重合'],
            'confidence': conf,
            'answer': '',
        }
        added += 1

    # ---- 2) QOJ 比赛号（我有提交的、还没归过档的）----
    for cid, d in sorted(qoj_groups.items(), key=lambda kv: -kv[1]['n']):
        if cid in known_qojs:
            continue
        slug, ev = match_by_problem_ids(d['pids'], index)
        if not slug:
            slug, ev2 = match_by_problem_names(sorted(d['names']), index)
            ev = ev + ev2
        chain = cats.get(cid) or []
        is_xcpc, series, year = classify_xcpc(chain)
        # 顺序要紧：**先 xcpcio**（它靠"系列+届次+站点"直接解 slug，比模糊赛名硬），
        # 再退到赛名提示。反过来的话，模糊提示会先占住 slug，把精确解挤掉（实测踩到）
        slug, ev = apply_xcpcio(qoj_aliases(cid, names), year, xcpcio, index, season_years, ev, slug)
        hints = name_hint(qoj_aliases(cid, names), hints_idx, year=year, top=3)
        if not slug and is_xcpc and hints:
            slug = hints[0][2]
            ev = ev + [f'分类说这是 XCPC（{series} {year}），赛名最像 {slug}'
                       f'（{hints[0][0]:.0%} / {hints[0][1]} 词）'
                       + ('（年份差 1 年：可能是赛季年 vs 次年办，请核对）' if hints[0][4] else '')
                       + (f'；还有更像的候选：{[h[2] for h in hints[1:]]}' if len(hints) > 1 else '')]
        conf = 0.95 if any('题目 id 对上' in x for x in ev) else \
               (0.85 if any('题名重合' in x for x in ev) else (0.6 if slug else 0.0))
        reg['pending'][f'qoj:{cid}'] = {
            'kind': 'qoj-contest',
            'title': (qoj_aliases(cid, names) or [''])[0],
            'aliases': qoj_aliases(cid, names)[1:],
            'submissions': d['n'],
            'qoj_taxonomy': {'xcpc': is_xcpc, 'series': series, 'year': year, 'chain': chain},
            'guess': slug,
            'evidence': ev or ['rankland 没有对应，且题名也不重合'],
            'confidence': conf,
            'answer': '',
        }
        added += 1

    # ---- 3) 已有条目里"身份是自造的"→ 给升级建议 ----
    for k, e in reg['contests'].items():
        if e.get('identity') != 'self' or k.startswith('cf:') or k.startswith('qoj:'):
            continue
        gyms, _q = platform_ids(e)
        title = str(e.get('note') or '')
        ev, slug = [], ''
        for gid in gyms:
            s2, e2 = match_by_gym(gid, index)
            if s2:
                slug, ev = s2, e2
                break
            s2, e2 = match_by_problem_names(_cf_problem_names(gid), index)
            if slug == '' and s2:
                slug, ev = s2, e2
        if not slug:
            # 顺序：**xcpcio 的精确解优先**，再退到模糊赛名提示（见 qoj 分支的说明）
            y = ''
            m = re.search(r'(?:19|20)\d{2}', title)
            if m:
                y = m.group(0)
            slug, ev = apply_xcpcio([title], y, xcpcio, index, season_years, ev, slug)
        if not slug:
            hints = name_hint([title], hints_idx, year=y, top=2, exclude={k})
            if hints:
                slug = hints[0][2]
                ev = [f'赛名最像 {slug}（{hints[0][0]:.0%} / {hints[0][1]} 词）'
                      + ('（年份差 1 年：可能是赛季年 vs 次年办，请核对）' if hints[0][4] else '')
                      + (f'；次选 {hints[1][2]}' if len(hints) > 1 else '')]
        reg['pending'][f'upgrade:{k}'] = {
            'kind': 'identity-upgrade',
            'title': title or k,
            'guess': slug,
            'evidence': ev or ['题名、平台号、赛名都对不上 —— 只能你手判（或接受继续用 cf<gym>）'],
            'confidence': 0.9 if slug else 0.0,
            'answer': '',
        }
        added += 1

    save(reg)
    undecided = [k for k, v in reg['pending'].items() if not str(v.get('answer') or '').strip()]
    print(f'✅ {rel(REGISTRY)}：候选区现在 {len(reg["pending"])} 条（未决 {len(undecided)}）')
    print(f'   本次新增/刷新 {added} 条')
    print('   下一步：python xcpc_registry.py status   # 看证据，然后 answer')
    return 0


# ================================================================
# status
# ================================================================

def cmd_status(args) -> int:
    reg = load(args.registry)
    c = reg['contests']
    tri = collections.Counter('true' if v.get('xcpc') is True else
                              ('false' if v.get('xcpc') is False else '未决') for v in c.values())
    ident = collections.Counter(v.get('identity') or '?' for v in c.values())
    print(f'📄 {rel(REGISTRY)}')
    print(f'   contests {len(c)} 条：XCPC={tri["true"]} 非XCPC={tri["false"]} 未决={tri["未决"]}')
    print(f'   身份：{"、".join(f"{k} {v}" for k, v in ident.items())}')
    print(f'   merges {len(reg["merges"])} 条；pending {len(reg["pending"])} 条')
    und = {k: v for k, v in reg['pending'].items() if not str(v.get('answer') or '').strip()}
    if und:
        print(f'\n   待决 {len(und)} 条（按可信度排序，前 20）：')
        for k, v in sorted(und.items(), key=lambda kv: -float(kv[1].get('confidence') or 0))[:20]:
            x = v.get('qoj_taxonomy') or {}
            tax = (f"QOJ分类={'XCPC' if x.get('xcpc') else ('非XCPC' if x.get('xcpc') is False else '?')}"
                   f"{('/' + x['series']) if x.get('series') else ''}"
                   f"{(' ' + x['year']) if x.get('year') else ''}") if x else ''
            print(f'   {k:<16} {float(v.get("confidence") or 0):.0%}  '
                  f'→ {v.get("guess") or "（找不到）":<26} {tax}')
            print(f'      {str(v.get("title"))[:60]}')
            for e in (v.get('evidence') or [])[:3]:
                print(f'      · {e}')
        sug = [k for k, v in und.items() if suggest_of(v)[0]]
        if sug:
            # ★ 「推荐 → 你批准」：判据在 `suggest_of()`（EC 赛区 / CCPC / 省赛·邀请赛那 3 类）
            print(f'\n   ★ 其中**建议收** {len(sug)} 条（判据 = EC 赛区 / CCPC 系列 / 省赛·邀请赛）：')
            print('      python xcpc_registry.py find --suggest          # 看清单（可加关键词 / --year / --cls）')
            print('      python xcpc_registry.py approve --suggest       # 一次批准（先加 --dry-run 预演）')
    return 0


def _series_of_class(cls: str) -> str:
    """
    "分类路径" → 系列名：`cf/gyms/xcpc/icpc/eu/regional/official` → `icpc`；`cf/gyms/ucup` → `ucup`。

    ⚠️ 只当**自造身份**那条路的兜底（`answer cf:<gym> yes` 且归不到 rankland 时）——
      系列终归要人确认（③ 性质待补可以改）；取不到就返回空串，**不猜**。
    """
    parts = str(cls or '').split('/')
    if len(parts) >= 4 and parts[2] == 'xcpc':
        return parts[3]
    if 'ucup' in parts:
        return 'ucup'
    return ''


# ================================================================
# 候选区：推荐（建议收/不收）+ 搜索 + 批量批准
# ================================================================

def suggest_of(p: dict) -> tuple:
    """
    候选 → `(是否**建议收**, 原因)` —— **唯一一份**推荐判据。

    判据**只看已经判好的分类路径**（`p['cls']`，由 `cf_adapter.py --gym-meta` 存下来的
    `cf_board_adapter.gym_class_rule()` 结果）+ 年份，**不在这里重算一遍分类**
    （两份判据会漂）。口径与名单一贯的取舍一致：

      · `cf/gyms/xcpc/icpc/ec/…`                 ⇒ **收**：EC 是我们的主场
      · `cf/gyms/xcpc/ccpc/…`                    ⇒ **收**：CCPC 系列（分站/决赛/预选/女生专场）
      · `cf/gyms/xcpc/provincial&invitational/…` ⇒ **收**：省赛/邀请赛（那 3 类之一，**地名在路径里**）
      · 其余 `xcpc/icpc/<别的赛区>`               ⇒ 不收：非 EC（一贯口径）
      · `cf/gyms/ucup` / `cf/gyms/无归类`         ⇒ 不收：训练赛 / 判不出（判不出**不猜**）

    ⚠️ **只是建议**：收不收由人定 —— `approve` 才是"人批准"那个动作，脚本不自己拍板进树。
    """
    if str(p.get('kind') or '') != 'cf-gym':
        return False, '非 CF gym（推荐只覆盖 gym）'
    cls = str(p.get('cls') or '').strip()
    if not cls:
        return False, '没有分类（先跑 `cf_adapter.py --gym-meta` 刷新全量元信息）'
    parts = cls.split('/')
    if len(parts) >= 4 and parts[2] == 'xcpc':
        series, rest = parts[3], parts[4:]
        if series == 'ccpc':
            return True, 'CCPC 系列' + (f'（{rest[0]}）' if rest and rest[0] else '')
        if series == 'icpc':
            region = rest[0] if rest else ''
            if region == 'ec':
                stage = rest[1] if len(rest) > 1 else ''
                return True, 'EC 赛区' + (f'（{stage}）' if stage else '')
            return False, f'非 EC 赛区（{region or "?"}）⇒ 一贯不导'
        if series == PROVINCIAL_SEG:
            place = rest[0] if rest else ''
            ptype = rest[1] if len(rest) > 1 else ''
            bits = [b for b in ((place if place and place != '无' else ''), ptype) if b]
            return True, '省赛/邀请赛' + (f'（{" · ".join(bits)}）' if bits else '')
        return False, f'分类里没有这一支（{series}）'
    if 'ucup' in parts:
        return False, 'Universal Cup / 训练营'
    return False, '判不出（无归类）⇒ 不猜'


def _years_of(spec: str) -> set:
    """
    `--year` 的写法：`2024` / `2022,2023` / `2022-2025`（也能混着写）。空 = 不限。

    为什么要范围：一次要看的是"**这几年**的 EC/CCPC/省市赛"，逐个年份敲四遍不合适。
    """
    out: set = set()
    for chunk in str(spec or '').replace('，', ',').split(','):
        chunk = chunk.strip()
        if not chunk:
            continue
        m = re.match(r'^(\d{4})\s*[-~]\s*(\d{4})$', chunk)
        if m:
            a, b = int(m.group(1)), int(m.group(2))
            lo, hi = (a, b) if a <= b else (b, a)
            out |= {str(y) for y in range(lo, hi + 1)}
        else:
            out.add(chunk)
    return out


def _group_label(p: dict, by: str) -> str:
    """分组标题：`by='year'` → 年份；`by='cls'` → 分类第二段（icpc/ccpc/省赛）；其它 → 单组。"""
    if by == 'year':
        return str(p.get('year') or '（无年份）')
    if by == 'cls':
        parts = str(p.get('cls') or '').split('/')
        if len(parts) >= 4 and parts[2] == 'xcpc':
            return f'xcpc/{parts[3]}'
        return '其它（ucup / 无归类）'
    return '全部'


def _recommend_md(picked: list, args) -> str:
    """候选清单（markdown）—— 给"看一眼再批准"用：分组 + 每条的理由 + 批准命令。"""
    lines = ['# CF gym 候选清单（建议收）', '',
             f'- 条件：`--suggest`' + (f' · year={args.year}' if args.year else '')
             + (f' · cls~{args.cls}' if args.cls else '')
             + (f' · 关键词 {" ".join(args.terms)}' if args.terms else ''),
             f'- 共 **{len(picked)}** 条；分类来自 `cf_adapter.py --gym-meta` 的全量元信息',
             f'- 一次批准：`python xcpc_registry.py approve --suggest'
             + (f' --year {args.year}' if args.year else '')
             + (f' --cls {args.cls}' if args.cls else '') + '`（先加 `--dry-run` 预演）', '']
    by = getattr(args, 'by', '') or 'none'
    groups: dict = {}
    for k, p in picked:
        groups.setdefault(_group_label(p, by), []).append((k, p))
    for g in sorted(groups):
        rows = groups[g]
        lines += [f'## {g}（{len(rows)} 条）', '',
                  '| 候选 | 年份 | 赛名 | 分类 | 建议 | 批准 |', '|---|---|---|---|---|---|']
        for k, p in rows:
            ok, why = suggest_of(p)
            cls = str(p.get('cls') or '').replace('cf/gyms/', '')
            yr = str(p.get('year') or '') + ('?（' + str(p.get('yearFrom') or '推定') + '）'
                                            if p.get('yearEst') else '')
            lines.append(f'| `{k}` | {yr} | {str(p.get("title"))[:70]} | `{cls}` | '
                         f'{"★收 " if ok else ""}{why} | `answer {k} yes`'
                         + (f'（归到 {p["guess"]}）' if p.get('guess') else '（自造身份 cf' + k.split(':')[-1] + '）')
                         + ' |')
        lines.append('')
    return '\n'.join(lines) + '\n'


def _pending_haystack(p: dict) -> str:
    """候选的**可搜文本**（搜索/筛选用；一处集中，免得两个命令各拼一份）。"""
    return ' '.join(str(p.get(k) or '') for k in
                    ('title', 'year', 'cls', 'guess', 'source', 'startAt', 'note')).lower()


def _select_pending(reg: dict, args) -> list:
    """
    按 `find` / `approve` 的同一套条件挑候选 —— **两个命令共用这一份判据**。

    默认只看**未决**的（`answer` 为空）；要看已经答过的加 `--answered`。
    """
    terms = [str(t).lower() for t in (getattr(args, 'terms', None) or []) if str(t).strip()]
    years = _years_of(getattr(args, 'year', ''))
    out = []
    for k, p in (reg.get('pending') or {}).items():
        answered = bool(str(p.get('answer') or '').strip())
        if answered and not getattr(args, 'answered', False):
            continue
        if getattr(args, 'suggest', False) and not suggest_of(p)[0]:
            continue
        if getattr(args, 'no_suggest', False) and suggest_of(p)[0]:
            continue
        if years and str(p.get('year') or '') not in years:
            continue
        if getattr(args, 'cls', '') and str(args.cls) not in str(p.get('cls') or ''):
            continue
        if getattr(args, 'source', '') and str(p.get('source') or '') != str(args.source):
            continue
        if terms and not all(t in _pending_haystack(p) for t in terms):
            continue
        out.append((k, p))
    return sorted(out, key=lambda kv: (-float(kv[1].get('confidence') or 0), kv[0]))


def _print_pending(picked: list, limit: int) -> None:
    for k, p in (picked if limit <= 0 else picked[:limit]):
        ok, why = suggest_of(p)
        mark = '★收' if ok else '  ·'
        yr = str(p.get('year') or '----')
        if p.get('yearEst'):
            yr += '?'                      # ? = 年份是**推定**的（CF 没给开赛时间）
        print(f'   {mark} {k:<16} {float(p.get("confidence") or 0):>4.0%}  '
              f'{yr:<5} {str(p.get("cls") or "").replace("cf/gyms/", ""):<44}')
        print(f'        {str(p.get("title"))[:70]}  ｜ {why}'
              + (f'　〔年份依据：{p.get("yearFrom")}〕' if p.get('yearEst') else ''))
        if p.get('guess'):
            print(f'        → 建议归到 {p["guess"]}（`answer {k} yes` 不用再指定 slug）')
    if limit > 0 and len(picked) > limit:
        print(f'   … 还有 {len(picked) - limit} 条（`--limit 0` 看全部）')


def cmd_find(args) -> int:
    """**搜候选区**：关键词（空格分隔，全部命中）+ `--year` / `--cls` / `--source` / `--suggest`。"""
    reg = load(args.registry)
    picked = _select_pending(reg, args)
    total = len(reg.get('pending') or {})
    und = len([1 for v in (reg.get('pending') or {}).values()
               if not str(v.get('answer') or '').strip()])
    sug = len([1 for v in (reg.get('pending') or {}).values()
               if not str(v.get('answer') or '').strip() and suggest_of(v)[0]])
    head = ' '.join(str(t) for t in (args.terms or [])) or '(无条件)'
    print(f'🔍 候选区 {total} 条（未决 {und}，其中**建议收** {sug}）｜条件：{head}'
          + (f' year={args.year}' if args.year else '')
          + (f' cls~{args.cls}' if args.cls else '')
          + (' 只看建议收' if args.suggest else '')
          + (' 排除建议收' if args.no_suggest else ''))
    print(f'   命中 {len(picked)} 条：')
    by = getattr(args, 'by', '') or 'none'
    if by != 'none':
        groups: dict = {}
        for k, p in picked:
            groups.setdefault(_group_label(p, by), []).append((k, p))
        for g in sorted(groups):
            print(f'\n   ── {g}（{len(groups[g])} 条）')
            _print_pending(groups[g], args.limit if args.limit is not None else 30)
    else:
        _print_pending(picked, args.limit if args.limit is not None else 30)
    if getattr(args, 'output', ''):
        text = _recommend_md(picked, args)
        with open(args.output, 'w', encoding='utf-8') as f:
            f.write(text)
        print(f'\n   💾 清单 → {args.output}（{len(picked)} 条；markdown，直接翻着看）')
    if picked:
        print(f'\n   批准（= 你拍板，脚本照办）：python xcpc_registry.py approve'
              + (' ' + ' '.join(args.terms) if args.terms else '')
              + (f' --year {args.year}' if args.year else '')
              + (f' --cls {args.cls}' if args.cls else '')
              + (' --suggest' if args.suggest else '')
              + '   # 加 --dry-run 先预演')
    return 0


def cmd_approve(args) -> int:
    """**批量批准**筛出来的候选（走 `answer` 那条路：含"归不到 rankland ⇒ 自造身份"）。"""
    reg = load(args.registry)
    picked = _select_pending(reg, args)
    if not picked:
        print('ℹ️ 没有匹配的候选 —— 先用 `find` 看一眼条件（或 `--answered` 把已答的也带上）')
        return 0
    print(f'准备批准 {len(picked)} 条（answer={args.answer}）：')
    _print_pending(picked, 10)
    if args.dry_run:
        print('（--dry-run：一条都没写）')
        return 0
    for k, _p in picked:
        args.key = k
        code = cmd_answer(args)
        if code:
            return code
    print(f'✅ 批准了 {len(picked)} 条；下一步：python xcpc_registry.py build → 全链重建')
    return 0


def cmd_answer(args) -> int:
    # 一次可以答**多条**（逗号分隔）：候选区里 CF gym 现在是按**全量分类**提上来的（几百条），
    # 一条条敲不现实 —— `answer "cf:100001,cf:100002" yes` 或 `answer 全部 yes` 那种循环。
    keys = [k.strip() for k in str(args.key).split(',') if k.strip()]
    if len(keys) > 1:
        for k in keys:
            args.key = k
            code = cmd_answer(args)
            if code:
                return code
        return 0
    reg = load(args.registry)
    key = args.key
    if key not in reg['pending']:
        print(f'❌ 候选区没有 {key}', file=sys.stderr)
        return 1
    p = reg['pending'][key]
    ans = args.answer.strip()
    p['answer'] = ans
    yes = ans.lower() in ('y', 'yes', 'true', '1')
    # ★ **CF gym 归不到 rankland**（没有 guess）时，"yes" = **自造身份** `cf<gym>` ——
    #   沿用既有约定（清单里那些 `cf101986` 就是这样来的），并给它一份 cf 榜单当 `board`。
    #   不这么做的话，这批"rankland 没收录"的场次只能被记成"不导"（= 永远进不来），
    #   而它们恰恰是 `scan` 从**全量元信息**里捞出来的那一批。
    selfmade = bool(yes and p.get('kind') == 'cf-gym' and not (args.slug or p.get('guess')))
    slug = args.slug or (p.get('guess') if yes else '')
    if selfmade:
        slug = 'cf' + key.split(':', 1)[1]
    if slug:
        # 人认可了 → 搬进判断区
        kind = p.get('kind')
        entry = reg['contests'].get(slug) or {}
        entry.setdefault('xcpc', True)
        entry.setdefault('identity', 'self' if selfmade else 'rankland')
        entry.setdefault('board', {})
        entry.setdefault('sources', [])
        subs = entry.setdefault('submissions', [])
        if kind == 'qoj-contest':
            cid = key.split(':', 1)[1]
            # ⚠️ 只挂提交是不够的：这场若只有 QOJ 记录、rankland 也没给榜单，
            #    就必须给一个能出 C+P 的 board，否则流水线只产出 R，父题目不存在会被导入拒绝。
            if not entry.get('board'):
                entry['board'] = {
                    'source': 'rankland-index', 'role': 'board',
                    'file': 'acm-data/raw/Scaper/05 xcpc/cache/rankland_index.json',
                    'note': '这场只有 QOJ 上的补题记录，没有榜单文件：赛名/题单取自 rankland 索引，'
                            '**不写 ratio**（索引里没有每题过队数）。',
                }
            if not any((s.get('source') == 'qoj' and str(s.get('contest')) == cid) for s in subs):
                subs.append({'source': 'qoj', 'role': 'submissions',
                             'file': QOJ_SUBS_MANIFEST_PATH, 'contest': cid,
                             'note': f'QOJ 补题记录（比赛号 {cid}）'})
        elif kind == 'cf-gym':
            gid = key.split(':', 1)[1]
            entry.setdefault('year', str(p.get('year') or ''))
            # 自造身份的那批：系列从**分类路径**取（`cf/gyms/xcpc/<系列>/…` / `cf/gyms/ucup`）；
            # 取不到就留空（人可在 ③ 补），**不猜**。赛名照旧由 cf 片段出（`name: null`）。
            if selfmade and not entry.get('series'):
                entry['series'] = _series_of_class(p.get('cls') or '')
            board = entry['board']
            if not board:
                entry['board'] = {'source': 'cf', 'role': 'board', 'gym': gid,
                                  'file': f'acm-data/raw/Scaper/05 xcpc/cache/cf_standings_{gid}.json',
                                  'note': 'CF gym 榜单（contest.standings，需登录）'}
            # ⚠️ 提交来源**与榜单无关**：这场已经有榜单时也要挂（否则 `answer … yes` 只记下
            #    身份、一条提交都不导 —— 实测 `cf:104076` 归到 `icpc2022jinan` 后
            #    清单里 `submissions` 仍是空的，我的提交一条都进不了树）。
            #    原来这一句嵌在上面的 `if not board:` 里，是缩进错位。
            if not any((s.get('source') == 'cf' and str(s.get('gym')) == gid) for s in subs):
                subs.append({'source': 'cf', 'role': 'submissions', 'gym': gid,
                             'file': f'acm-data/raw/Scaper/05 xcpc/cache/cf_{gid}_<handle>.json',
                             'note': '只导我自己的提交'})
            # ★ **titles + website 两个角色都不能少**：本场只要挂了 cf 提交，就得让
            #   `cf_board_adapter` 也出一份**这一场的 CF 副本（C+P）** —— 否则那批 R 的父题目
            #   （`cf:c:<gym>:p:<题号>`）根本不存在，导入时整批 `parent-not-found`；
            #   而 **website** 是给 C 写「分类链接」的（缺了它，
            #   `crate-invariants` 会报"每场比赛都有分类链接"不达标 —— 实测踩到）。
            #   既有 xcpcio 榜单、又挂了 cf 的场次（如 2023 济南）本来就是这个形状。
            for role, note in (('titles', '出**这一场的 CF 副本**（C+P），本场挂的 cf 提交要有个父题目落脚'),
                               ('website', 'CF 榜单里的官网链接（写 C 的「分类链接」，缺了它这场就没链接）')):
                if any((s.get('source') == 'cf' and s.get('role') == role
                        and str(s.get('gym')) == gid) for s in (entry.get('sources') or [])):
                    continue
                entry.setdefault('sources', []).append({
                    'source': 'cf', 'role': role, 'gym': gid,
                    'file': f'acm-data/raw/Scaper/05 xcpc/cache/cf_standings_{gid}.json',
                    'note': f'CF gym 榜单（contest.standings，需登录）—— {note}。'
                            '已降级为**补充来源**：xcpcio 接上后 ratio/赛名/时间由它出。'})
        elif kind == 'identity-upgrade':
            old = reg['contests'].pop(key.split(':', 1)[1], None)
            if old:
                for f in ('board', 'sources', 'submissions', 'aliases', 'note', 'series', 'year'):
                    if f in ('board', 'sources', 'submissions') and old.get(f):
                        entry[f] = old[f]
                    elif f in ('series', 'year') and old.get(f) and not entry.get(f):
                        entry[f] = old[f]
                    elif f == 'note' and old.get(f) and not entry.get('note'):
                        entry['note'] = old[f]
        reg['contests'][slug] = entry
    else:
        # 人判"不是 XCPC / 不导" → **记下来**（xcpc=false），否则下次 scan 又把它当候选提出来。
        # 这也是"非 XCPC 记 true/false"那条决定的落地处。
        tax = p.get('qoj_taxonomy') or {}
        reg['contests'][key] = {
            'xcpc': False,
            'series': str(tax.get('series') or ''),
            'year': str(tax.get('year') or ''),
            'name': str(p.get('title') or ''),
            'identity': 'none',
            'board': {}, 'sources': [], 'submissions': [], 'aliases': {},
            'note': f"人判不导（{ans}）：" + '；'.join(str(e) for e in (p.get('evidence') or [])[:2]),
        }
    save(reg)
    print(f'✅ {key} = {ans}' + (f' → 归到 {slug}' if slug else '（记为不导，不进树）'))
    return 0


# ================================================================
# build：注册表 → 清单
# ================================================================

def _series_from_slug(slug: str, info: dict | None = None) -> str:
    """
    从 slug 前缀 / rankland 索引认系列 —— **兜底用**：只有在注册表与索引都没给 `series` 时
    才会被采用（优先级见 `_layers`）。

    ⚠️ **它只作兜底**：slug 前缀一命中（`icpc*` / `ccpc*`）就会**压过注册表里显式写的
    `series`** —— 结果"把邀请赛从 ICPC/CCPC 里拆出来"这种事**改了注册表也不生效**
    （实测：20 条 invitational 全被前缀判回 icpc/ccpc）。只在**前面都没给**时才用它。
    """
    s = str(slug or '').lower()
    m = re.match(r'^(ccpc|icpc|ucup)', s)
    if m:
        return m.group(1)
    if re.match(r'^[a-z]{1,3}cpc\d', s) or re.match(r'^(northeast|sccpc)', s):
        return 'provincial-invitational'
    return str((info or {}).get('series') or '')


def _layers(entry: dict, index: dict, mids: dict | None = None,
            settings: dict | None = None) -> tuple[dict, dict | None, str]:
    """
    系列/年份层 —— 优先用**注册表里的覆盖**，其次 rankland 索引，最后才退到 `系列 年份`。

    注册表里这几个字段就是给人调分类用的：

        "series": "icpc"                     # 系列 id（`SERIES_NAMES` 里有就用它的名字）
        "seriesName": "亚洲其他区域"           # 想用别的系列名时覆盖（不必改代码）
        "mid": { "id": "zj", "name": "浙江省赛" }   # 中间层**直接指定**（省赛按省、或自造层）
        "mid": "provincial2024"              # 也可以只给 id，名字从索引/系列年推

    **省赛的中间层轴**由注册表顶层 `settings.provincialAxis` 决定：
        "place"    → 地点层 `浙江` / `广东` / `长春`（**默认** —— 省赛下分类只有一层地点，
                     同地点的不同年已经按时间排好了，不用再套一层时间）
        "year"     → `provincial2019` / 省赛 2019   （按年份分层）
        "province" → 用 rankland 的省层（`zj` / 浙江省赛）
    ⚠️ `place` 那一档会把**赛季**放进 `mid['season']`（层名不再是年份，见那里的注释）。

    ⚠️ 层名必须由层 id 唯一决定：没对上 rankland 的场次自己也能算出 `icpc2022` 这个 id，
    若它只写 "ICPC 2022"，合并时就会和网络赛那边的 "ICPC 2022 (47th)" 撞成
    field-value-conflict（实测撞过 16 条、注册表这条链上又重演 20 条）。
    所以 `mids`（层 id → 官方层名，来自索引）要一路带上。
    """
    slug = entry.get('_slug') or ''
    info = (index.get('bySlug') or {}).get(slug) or {}
    # 系列优先级：**注册表显式 → rankland 索引 → slug 前缀兜底**。
    # ⚠️ slug 前缀若排第一，"改注册表把某场挪出 ICPC/CCPC"就**不生效**（前缀又把它判回去）。
    sid = str(entry.get('series') or '') or str(info.get('series') or '')
    sid = sid or _series_from_slug(slug, info) or 'other'
    sname = str(entry.get('seriesName') or '') or SERIES_NAMES.get(sid, 'XCPC 其他')
    year = str(entry.get('year') or '')
    # 赛名：显式 name → rankland 标题 → **note（自造身份的场次只有 CF 名可用）** → slug
    # ⚠️ 不能拿 slug 当名字：`cf101986` 是身份不是赛名（实测树上真的显示成了 cf101986）
    name = (str(entry.get('name') or '') or str(info.get('title') or '')
            or ('' if info else str(entry.get('note') or '')) or slug)

    axis = str((settings or {}).get('provincialAxis') or 'year')
    if sid == 'provincial-invitational' and axis == 'place':
        # ⚠️ `place` 那一档默认不启用：`nature` 已填好（包括赛季）时，分类用**仅赛季一层**
        #   （同赛季内一样要排序）⇒ 默认走 `year`（= 赛季那一层），地点层不建。
        #   这一档留着是因为规则本身没错，只是**没人用**（要试就改注册表那一格）。
        place, _kind = place_of_name(name)
        y = (year or index_year(info) or '')
        if not place:
            return ({'id': sid, 'name': sname}, ({'season': y} if y else None), name)
        return ({'id': sid, 'name': sname}, {'id': place, 'name': place, 'season': y}, name)
    if sid == 'provincial-invitational' and axis == 'year':
        y = year or index_year(info)
        mid_id = f'provincial{y}' if y else ''
        # 层 id 沿用 `provincial<年>`（**别改**）：改了会让已导入的子树对不上、变重复节点。
        # 只有显示名跟着系列走（"省赛与邀请赛 2025"）。
        return ({'id': sid, 'name': sname},
                ({'id': mid_id, 'name': f'{sname} {y}'} if mid_id else None),
                name)

    override = entry.get('mid')
    if isinstance(override, dict) and override.get('id'):
        mid_id = str(override['id'])
        mid_name = str(override.get('name') or '') or (mids or {}).get(mid_id) or mid_id
    else:
        mid_id = (str(override) if isinstance(override, str) and override.strip() else '') \
            or str(info.get('mid') or '') or (f'{sid}{year}' if year else '')
        mid_name = (str(info.get('midName') or '')
                    or (mids or {}).get(mid_id)
                    or (f'{sname} {year}' if year else ''))
    return ({'id': sid, 'name': sname},
            ({'id': mid_id, 'name': mid_name} if mid_id else None),
            name)


def cmd_classify(args) -> int:
    """
    **分类体检**：把"要进树"的场次按 系列 / 中间层 列出来，并标出可疑项，照着改注册表即可。

    可疑标记（判据都是"能自动看出来的不一致"，不是审美）：
        self      身份还是自造的 `cf<gym>`（rankland 没对上）
        no-year   没有年份 → 会**直接挂在系列下**（没有中间层）
        guess-mid 中间层是 `{系列}{年份}` 这种**泛化**层（说明它没跟 rankland 对上，
                  而同一系列里已有人用省份层 → 粒度会不一致）
        other     系列落在了 `other`（XCPC 其他）
        noncn     名字里像**非中国大陆**（日本/欧洲/北美…），却在 icpc/ccpc 下
    """
    reg = load(args.registry)
    index = load_index()
    mids: dict = {}
    for info in (index.get('bySlug') or {}).values():
        mid, mname = str(info.get('mid') or ''), str(info.get('midName') or '')
        if mid and mname and mid not in mids:
            mids[mid] = mname
    NON_CN = re.compile(r'Yokohama|Tsukuba|Japan|Korea|Vietnam|'
                        r'Indonesia|Philippines|Thailand|Malaysia|Singapore|India|'
                        r'NWERC|NEERC|SEERC|SWERC|CERC|Europe', re.I)
    rows = []
    for key, e in sorted(reg['contests'].items()):
        if key.startswith(('cf:', 'qoj:')) or e.get('xcpc') is False or e.get('xcpc') is None:
            continue
        e['_slug'] = key
        series, mid, name = _layers(e, index, mids, reg.get('settings'))
        info = (index.get('bySlug') or {}).get(key) or {}
        flags = []
        if e.get('identity') == 'self':
            flags.append('self')
        if not mid:
            flags.append('no-year')
        elif not str(info.get('mid') or '') and not e.get('mid'):
            # 只有"rankland 没给中间层、由 系列+年份 凑出来的"才算泛化层
            flags.append('guess-mid')
        if series['id'] == 'other':
            flags.append('other')
        # 非中国大陆判定：只看**树上显示的名字**（CF 名里的 "(The 2nd Universal Cup…)"
        # 是镜像副标题，不是"在欧洲/日本办"，用它判会全错 —— 实测踩到）
        if NON_CN.search(str(name)) and series['id'] in ('icpc', 'ccpc'):
            flags.append('noncn')
        rows.append((series['name'], mid['name'] if mid else '(无年份层)',
                     key, str(name)[:38], '、'.join(flags)))

    print(f'共 {len(rows)} 场进树；可疑 {sum(1 for r in rows if r[4])} 场\n')
    cur = None
    for sname, mname, slug, name, flags in rows:
        if sname != cur:
            print(f'■ {sname}')
            cur = sname
        mark = f'  ⚠️ {flags}' if flags else ''
        print(f'   {mname:<24} {slug:<26}{name}{mark}')
    print('\n改法：在 xcpc_registry.json 的 contests 里给这一条加字段 ——')
    print('   移出 ICPC 到另一个系列： "series": "apac", "seriesName": "亚洲其他区域"')
    print('   指定中间层（省赛按省）  ： "mid": { "id": "zj", "name": "浙江省赛" }')
    print('   补/改年份              ： "year": "2020"')
    print('改完：python xcpc_registry.py build  →  删掉应用里的 XCPC 子树  →  重新导入')
    return 0


def cmd_add_catalog(args) -> int:
    """
    **补全系列**：把 rankland 里"我没提交、但有题单可以补题"的场次也纳入注册表。

    为什么默认只收"有题链接的"：绝大多数老场次 rankland 只给了赛名，**题目是空的**
    （实测 icpc 186 场里只有 45 场有题链接）—— 那些空壳导进去既不能补题、又把树撑满。
    想连空壳一起导就加 `--include-empty`。

    这些条目：`xcpc: true` + `board: rankland-index`（赛名/题单取自索引，**不写 ratio**）
    + **没有提交来源**。想给某场补真实榜单/通过率，再单独给它换 board。
    """
    reg = load(args.registry)
    index = load_index()
    by_slug = index.get('bySlug') or {}
    series_list = [s.strip() for s in (args.series or 'icpc,ccpc,provincial').split(',') if s.strip()]
    added, skipped_empty, already = [], [], 0
    for slug, info in sorted(by_slug.items()):
        if str(info.get('series') or '') not in series_list:
            continue
        if slug in reg['contests']:
            already += 1
            continue
        links = [str(p.get('link') or '').strip() for p in (info.get('problems') or [])]
        if not any(links) and not args.include_empty:
            skipped_empty.append(slug)
            continue
        reg['contests'][slug] = {
            'xcpc': True,
            'series': str(info.get('series') or ''),
            'year': index_year(info),
            'name': None,
            'identity': 'rankland',
            'board': {
                'source': 'rankland-index', 'role': 'board',
                'file': 'acm-data/raw/Scaper/05 xcpc/cache/rankland_index.json',
                'note': '没打过、只为补题：赛名/题单取自 rankland 索引，**不写 ratio**'
                        '（索引里没有每题过队数）。想要难度档就给它换一份真榜单。',
            },
            'sources': [], 'submissions': [], 'aliases': {},
            'note': str(info.get('title') or ''),
        }
        added.append((slug, len([x for x in links if x]), str(info.get('title') or '')))
    if added:
        save(reg)
    print(f'📚 系列 {"、".join(series_list)}：新增 {len(added)} 场'
          f'（已在注册表 {already} 场；**空壳跳过 {len(skipped_empty)} 场**）')
    for slug, n, title in added[:20]:
        print(f'   ＋ {slug:<26} {n:>2} 题  {title[:36]}')
    if len(added) > 20:
        print(f'   … 还有 {len(added) - 20} 场')
    if skipped_empty and not args.include_empty:
        print(f'   ℹ️ 空壳（rankland 只有赛名、没有题链接）没导 —— 想一起导加 --include-empty：'
              f'{", ".join(skipped_empty[:6])} …')
    print('   下一步：build → 删掉应用里的 XCPC 子树 → 重新导入')
    return 0


def _entry_year_of(entry: dict, found: dict) -> tuple[int | None, int | None]:
    """(本场是哪年, xcpcio 那个目录是哪年) —— 认不出就给 None"""
    mine = set(re.findall(r'(?:19|20)\d{2}', str(entry.get('_slug') or entry.get('slug') or '')))
    if entry.get('year'):
        mine.add(str(entry['year']))
    sy = _season_year(str(found.get('series') or ''), str(found.get('season') or ''))
    theirs = sy or (re.findall(r'(?:19|20)\d{2}', str(found.get('path') or '')
                    + ' ' + str(found.get('name') or '')) or [''])[0]
    my = min((int(x) for x in mine), default=None)
    return my, (int(theirs) if theirs else None)


def _season_year(series: str, season: str) -> str:
    """
    届次 → 年份（与 `xcpcio_adapter.season_year` 同一套闭式）：
    ccpc 第 n 届 = 2014+n、icpc 第 n 届 = 1975+n。
    为什么这里也要一份：xcpcio 的目录常写成 `9th/final`（路径里没有年份），
    不比届次的话 `ccpc2023final` 与 `ccpc2024final` 会被判成"年份差一样大"而互相抢。
    """
    s = str(season or '').lower()
    if re.match(r'^(?:19|20)\d{2}$', s):
        return s
    base = {'ccpc': 2014, 'icpc': 1975}.get(str(series or ''))
    m = re.search(r'^(\d+)(st|nd|rd|th)$', s)
    if base and m:
        return str(base + int(m.group(1)))
    return ''


def _gap_of(entry: dict, found: dict) -> int:
    """这条指派"年份差"多大（任一边认不出年份时按 0 处理，越小越可信）"""
    my, theirs = _entry_year_of(entry, found)
    if my is None or theirs is None:
        return 0
    return abs(theirs - my)


def cmd_xcpcio(args) -> int:
    """
    **把场次对到 xcpcio 目录**（把 xcpcio 当权威 ratio 源时用）。

    为什么需要这一步：xcpcio 的目录是 `data/<系列>/<届次>/<站点>`，注册表的键是 rankland 的
    **slug**，两者没有任何共同 ID（连站点拼写都不统一：`ec-final` / `ecfinal`）。
    所以"这场在 xcpcio 的哪一份"是**数据**，得落到注册表里（`xcpcio: <路径>`），
    不能每次出包靠模糊匹配现猜 —— 猜错一次就是一场的 ratio 全错。

    匹配算法在 `xcpcio_adapter.match_entry`（赛名 CJK bigram + 年份 + 系列，
    靠 `config.json` 里的**完整赛名**）；这里只负责报告与落盘。

    用法
    ----
        python xcpc_registry.py xcpcio                     # 只报告
        python xcpc_registry.py xcpcio --write             # 写进注册表（并备份）
        python xcpc_registry.py xcpcio --slug ccpc2025zhengzhou
        python xcpc_registry.py xcpcio --forget            # 清掉 xcpcio 指派（不用它当榜单）
    """
    import importlib.util
    reg = load(args.registry)
    # rankland 索引：**必须传**（很多场次注册表里 year 是空的，而索引的 startAt/标题能给年份）
    idx_path = os.path.join(HERE, 'cache', 'rankland_index.json')
    idx = (read_json(idx_path).get('bySlug') or {}) if os.path.isfile(idx_path) else {}
    if not args.forget:
        spec = importlib.util.spec_from_file_location(
            'xcpcio_adapter', os.path.join(HERE, 'xcpcio_adapter.py'))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        tree, match_entry = mod.load_tree(), mod.match_entry
    else:
        tree, match_entry = [], None

    keys = [args.slug] if args.slug else sorted(reg['contests'])
    hit, miss, same, conflict = [], [], [], []
    for key in keys:
        e = reg['contests'].get(key)
        if not e or e.get('xcpc') is False or e.get('xcpc') is None:
            continue
        if key.startswith(('cf:', 'qoj:')):
            continue
        if args.forget:
            if reg.get('xcpcio', {}).pop(key, None):
                same.append(key)
            continue
        e['_slug'] = key
        found, why = match_entry(e, tree, idx_info=idx.get(key))
        if not found:
            miss.append((key, why))
            continue
        old = (reg.get('xcpcio') or {}).get(key)
        (same if old == found['path'] else hit).append((key, found, why, old))

    if args.forget:
        if same and args.write:
            save(reg)
        print(f'🧹 清掉 {len(same)} 场的 xcpcio 指派' + ('（已写回）' if args.write and same else ''))
        return 0

    # **一场 xcpcio 目录只能给一场比赛**：`ccpc2024final` 与 `ccpc2023final` 会被
    # 同一份 `ccpc/9th/final` 吸引（那年总决赛因故延到 2024 办），两个都挂上就是
    # 把同一份榜单同时当两场的 ratio 源 —— 分不清哪场是哪场。这里只保留"年份差更小"的那个。
    all_hits = [(k, f) for k, f, _w, _o in hit] + [(k, f) for k, f, _w, _o in same]
    best_of: dict[str, tuple[str, int]] = {}
    for key, found in all_hits:
        gap = _gap_of(reg['contests'].get(key) or {}, found)
        cur = best_of.get(found['path'])
        if cur is None or gap < cur[1]:
            best_of[found['path']] = (key, gap)
    # 每份目录只留"年份差更小"的那场；**已经写进注册表、但这轮没跑到的指派也要一起比**，
    # 否则会把"注册表里已有的赢家"挤掉（实测 `ccpc2024final` 会把 `ccpc2023final` 的席位抢走）。
    for key, path in list((reg.get('xcpcio') or {}).items()):
        if key in {k for k, _f in all_hits}:
            continue
        e = dict(reg['contests'].get(key) or {})
        e.setdefault('_slug', key)
        found = next((t for t in tree if t['path'] == path), None)
        if found:
            best_of.setdefault(path, (key, _gap_of(e, found)))
    keepers = {v[0] for v in best_of.values()}
    for key, found in all_hits:
        if key not in keepers:
            conflict.append((key, found['path'], best_of[found['path']][0]))
    if conflict:
        drop = {c[0] for c in conflict}
        hit = [h for h in hit if h[0] not in drop]
        same = [s for s in same if s[0] not in drop]
        for d, path, keep in conflict:
            print(f'   ⚠️ {d} 与 {keep} 抢同一个目录 {path} —— {d} 让给 {keep}（不写指派）')

    print(f'📄 xcpcio 匹配：{len(hit) + len(same)}/{len(keys)} 场对得上'
          f'（新指派 {len(hit)}、没变 {len(same)}、对不上 {len(miss)}）')
    if hit:
        print('\n■ 新指派 / 有变化：')
        for key, found, why, old in hit:
            print(f'   {key:<34} → {found["path"]}')
            print(f'      {why}')
            if old:
                print(f'      ↺ 被取代的指派：{old}')
    if miss:
        print(f'\n■ 对不上（这些场次保持既有榜单来源）：')
        for key, why in miss[:40]:
            print(f'   {key:<34}   {why}')
        if len(miss) > 40:
            print(f'   … 还有 {len(miss) - 40} 场')

    if args.write and (hit or conflict):
        xc = reg.setdefault('xcpcio', {})
        for key, found, _why, _old in hit:
            xc[key] = found['path']
        for drop, _path, _keep in conflict:
            xc.pop(drop, None)          # 抢输的那场：把已有指派也撤掉
        if not args.registry:
            import shutil
            shutil.copyfile(REGISTRY, REGISTRY + '.bak')
            print(f'\n   备份 → {rel(REGISTRY + ".bak")}')
        save(reg)
        print(f'💾 写入 {len(hit)} 条 xcpcio 指派'
              + (f'、撤掉 {len(conflict)} 条（与别的场撞同一个目录）' if conflict else ''))
        print('   下一步：python xcpc_registry.py build   →   python xcpc_pipeline.py --check')
    elif hit:
        print('\n（没有写文件；确认无误后加 --write）')
    return 0


def board_has_time(entry: dict) -> bool:
    """
    这个条目的**榜单来源**给得出「比赛时间」吗？

    * `pta`：给得出（榜单里有 startAt）；
    * `cf`：`contest.standings` 对 gym **不返回** `startTimeSeconds`，得看榜单缓存里有没有、
      以及抓白名单时存下的 `startAt`（`fetch_my_gyms.py` 从 `contest.list` 取的）；
    * 其它（rankland-index / srk）：自己就会给。

    给不出时，`build` 会额外挂一个 `rankland-index` 的 `time` 角色去补（见下），
    这样"时间"也有明确的字段来源，而不是事后手填。
    """
    b = entry.get('board') or {}
    src = b.get('source') or ''
    if src != 'cf':
        return True
    gid = str(b.get('gym') or '')
    if not gid:
        return True
    p = os.path.join(HERE, 'cache', f'cf_standings_{gid}.json')
    if os.path.isfile(p):
        try:
            if (read_json(p).get('contest') or {}).get('startTimeSeconds'):
                return True
        except (ValueError, OSError):
            pass
    if os.path.isfile(WHITELIST):
        try:
            for g in (read_json(WHITELIST).get('gyms') or []):
                if str(g.get('id')) == gid and str(g.get('startAt') or '').strip():
                    return True
        except (ValueError, OSError):
            pass
    return False


def cmd_build(args) -> int:
    reg = load(args.registry)
    index = load_index()
    out_path = args.manifest or MANIFEST
    # 层 id → 官方层名（`icpc2022` → `ICPC 2022 (47th)`）：自造身份的场次也要用同一套名字
    mids: dict = {}
    for info in (index.get('bySlug') or {}).values():
        mid, mname = str(info.get('mid') or ''), str(info.get('midName') or '')
        if mid and mname and mid not in mids:
            mids[mid] = mname
    entries, skipped_self, skipped_off, skipped_undecided = [], [], [], []
    for key, e in sorted(reg['contests'].items()):
        if key.startswith(('cf:', 'qoj:')):
            if e.get('xcpc') is not False:
                skipped_self.append((key, e.get('name') or ''))
            continue
        if e.get('xcpc') is False:
            skipped_off.append(key)
            continue
        if e.get('xcpc') is None:
            skipped_undecided.append(key)
            continue
        e['_slug'] = key
        series, mid, name = _layers(e, index, mids, reg.get('settings'))
        sources = list(e.get('sources') or [])
        # rankland 的 refLinks：**一次搬全部**，按用途写进 C 的「链接分类」
        # （拆成 board / problems 两个角色、各写 C 的 link 就是在"挑一个"，
        #  而"数据爬取部分不应该有『存在多值时排除一些值』的逻辑"）。
        if key in (index.get('bySlug') or {}) and (index['bySlug'][key].get('refs')):
            if not any((s.get('source') or '') == 'rankland-refs' for s in sources):
                sources.append({
                    'source': 'rankland-refs', 'role': 'links',
                    'file': 'acm-data/raw/Scaper/05 xcpc/cache/rankland_index.json',
                    'note': 'rankland refLinks 里的**全部入口链接**，按用途分类写进 '
                            'C 的「链接分类」（榜单/补题/仓库/其它），**一条都不丢**。',
                })
        # CF 榜单里的 `websiteUrl`（官网链接）：只有榜单缓存里真有时才挂 ——
        # 它只是 link 的**备选值**（取值很不稳定，但确实可以当备选）。
        bsrc = (e.get('board') or {}).get('source') or ''
        bgym = str((e.get('board') or {}).get('gym') or '')
        if bsrc == 'cf' and bgym:
            sp = os.path.join(HERE, 'cache', f'cf_standings_{bgym}.json')
            if os.path.isfile(sp):
                try:
                    if str((read_json(sp).get('contest') or {}).get('websiteUrl') or '').strip():
                        if not any((s.get('source') or '') == 'cf' and (s.get('role') or '') == 'website'
                                   for s in sources):
                            sources.append({
                                'source': 'cf', 'role': 'website',
                                'file': f'acm-data/raw/Scaper/05 xcpc/cache/cf_standings_{bgym}.json',
                                'note': 'CF 榜单里的官网链接（只写 C 的 link，当备选值）',
                            })
                except (ValueError, OSError):
                    pass
        # 榜单给不出「比赛时间」时，挂一个只补时间的来源（值级来源明确 = rankland 索引）
        if key in (index.get('bySlug') or {}) and not board_has_time(e) \
                and not any((s.get('source') or '') == 'rankland-index' for s in sources):
            sources.append({
                'source': 'rankland-index', 'role': 'time',
                'file': 'acm-data/raw/Scaper/05 xcpc/cache/rankland_index.json',
                'note': '榜单（CF gym）拿不到开赛时间，这里只补 `contestTime`，其它字段一律不写',
            })
        # ---- xcpcio 当权威榜单（它是最权威的 ratio 源）----
        # 指派在注册表顶层 `xcpcio: {slug → data/…/站点}`（由 `xcpcio` 命令匹配写入）。
        # 它一上，**既有榜单降级成"补充来源"**（role=titles）：
        #   xcpcio 出  C.name / C.contestTime / C.link / P.ratio
        #   原榜单出  题名、题链接、identityKey（xcpcio 的 config.json **没有题名**，
        #            只有题号 label —— "接 xcpcio 能补题名"这句是错的）
        xc_path = str((reg.get('xcpcio') or {}).get(key) or '')
        if xc_path:
            b = dict(e.get('board') or {})
            if b.get('source') and b.get('source') != 'xcpcio':
                def demote(role: str, extra: str = '') -> None:
                    d = dict(b)
                    d['role'] = role
                    d['note'] = (str(d.get('note') or '')
                                 + ' ｜ 已降级为**补充来源**：xcpcio 接上后 ratio/赛名/时间由它出，'
                                   '这里只保留 xcpcio 给不出的字段。' + extra).strip(' ｜')
                    if not any((s.get('source') or '') == (b.get('source') or '')
                               and (s.get('role') or '') == role for s in sources):
                        sources.append(d)
                # CF gym 榜单一次给三样：题名/题链接、**通过率**、以及本队提交（R）。
                # 降级时**两样都得留**：
                #   * `titles` —— xcpcio 只报题号，题名/题链接只能由 CF 给；
                #   * `submissions` —— 它分析比赛时就出了 R。若只留 titles，
                #     本队提交不会再生成，而 R 指向的题号（实测 ccpc2024ladies 的 M 题）
                #     在主树上不存在 → 导入被拒。
                # ⚠️ 只留 submissions 的话，**14 场 CF 榜的 155 个题名 + 155 个链接整场丢掉**
                #    （包还在，`cache/crate_<slug>_cf_board.json` 也在，只是没人跑它）。
                if (b.get('source') or '') == 'cf':
                    demote('titles')
                    demote('submissions')
                else:
                    demote('titles')
            e['board'] = {
                'source': 'xcpcio', 'role': 'board', 'path': xc_path,
                'file': f'acm-data/raw/Scaper/05 xcpc/cache/xcpcio/{xc_path}/config.json',
                'note': 'xcpcio 榜单（**权威 ratio 源**，正式 + 打星同一口径；'
                        'ratio = 过题队伍数 / 至少过一题的有效队伍数）。',
            }
        # xcpcio 只出"题号 + ratio"，**给不出题名**（config.json 里只有 label）。
        # 所以它当 board 时，必须让 rankland 索引把题名/链接、以及 xcpcio 没收录的
        # 题号（空壳 P）都补上 —— 否则那些题号上的 ratio 与提交都挂不上去。
        # 实测 `ccpc2024ladies`：xcpcio 12 题（A–L）、CF gym 13 题（A–M），
        # 本队提交在 M 上，没有这个 titles 来源就会整场导入被拒。
        if xc_path and key in (index.get('bySlug') or {}) \
                and not any((s.get('source') or '') == 'rankland-index'
                            and (s.get('role') or '') != 'time' for s in sources):
            sources.append({
                'source': 'rankland-index', 'role': 'titles',
                'file': 'acm-data/raw/Scaper/05 xcpc/cache/rankland_index.json',
                'note': 'xcpcio 给不出题名（它的 config 只有题号），题名/题链接取 rankland 索引；'
                        'xcpcio 没收录的题号在这里补空壳 P。',
            })
        # PTA / 牛客榜单也只出"题号 + 每题过队数"，**同样给不出题名**。
        # ⚠️ 这是接 PTA 榜单时踩出来的真缺口：这些场的 board 是 `rankland-index`
        #    （它既给赛名/题名、又能给时间），换成 `pta` 之后**索引被整个挪走** ——
        #    于是题名/题链接**整场丢掉**，而且不报错（P 只剩题号，界面上一列空着）。
        #    实测 13 场 PTA 里 `cqcpc13th/14th`、`gdcpc19th`、`bjcpc2026` 等整场 0 题名。
        # 处理方式和 xcpcio 那条完全一样：board 给不出题名的，让 rankland 索引以
        # `titles` 角色补上（它只写 name/link，不碰 ratio，所以分母口径不受影响）。
        # 已经有别的题名来源（srk / cf / xcpcio）的场次**不加** —— 免得两套题名互相
        # 顶成 `其它来源值` 里的噪音（实测 `icpc2026preliminary-1/2` 就是这种）。
        #
        # 用 `insert(0)` 来"抢 `link`"（靠 `sources` 数组顺序决定归属）不行：
        # 链接归属由 `链接分类` + 应用层决定，与数组顺序无关，
        # 那种写法正是在爬取层做取舍。
        if (e.get('board') or {}).get('source') in ('pta', 'nk') \
                and key in (index.get('bySlug') or {}) \
                and not any((s.get('source') or '') in ('srk', 'cf', 'xcpcio',
                                                        'rankland-index')
                            and (s.get('role') or '') != 'time' for s in sources):
            sources.append({
                'source': 'rankland-index', 'role': 'titles',
                'file': 'acm-data/raw/Scaper/05 xcpc/cache/rankland_index.json',
                'note': 'PTA / 牛客榜单只有题号（没有题名/题链接），题名/题链接取 rankland 索引。',
            })
        # ⚠️ 不要挂 `source: 'qoj-problems'`（用 `cache/qoj_pid2cid.json` 写"QOJ 补题入口"）：
        # ① 它没有适配器（流水线的 ADAPTERS 里没有它，
        # 一旦清单里挂了它，出包时会直接报"要接新来源就加一行"）；② 它装的"题号 → 比赛号"与
        # `04 qoj --resolve-contests` 的 `qoj_problem_contests.json` 是**同一件事的两份真源**，
        # 而后者带全部候选、带归档、带重试 —— 重复的那份（含 `05 xcpc/qoj_problem_contest.py`）不保留。
        item = {
            'slug': key,
            'name': name,
            'slugFrom': 'rankland:' + str((index.get('bySlug') or {}).get(key, {}).get('repoPath') or ''),
            'series': series,
            'board': e.get('board') or {},
            'sources': sources,
            'submissions': e.get('submissions') or [],
        }
        if mid:
            item['mid'] = mid
        if e.get('aliases'):
            item['aliases'] = e['aliases']
        if e.get('note') and not item['name']:
            item['name'] = e['note']
        entries.append(item)

    old = read_json(out_path) if os.path.isfile(out_path) else {'contests': []}
    old_slugs = {c.get('slug') for c in (old.get('contests') or [])}
    new_slugs = {c['slug'] for c in entries}
    print(f'📄 {rel(out_path)}：{len(old_slugs)} → {len(new_slugs)} 场')
    print(f'   进树 {len(entries)}；被排除：自造身份 {len(skipped_self)} 场、'
          f'明确非 XCPC {len(skipped_off)} 场、未决 {len(skipped_undecided)} 场')
    still_self = [k for k, e in reg['contests'].items()
                  if e.get('identity') == 'self' and not k.startswith(('cf:', 'qoj:'))
                  and e.get('xcpc') is not False]
    if still_self:
        print(f'   ⚠️ 其中 {len(still_self)} 场仍是**自造身份** cf<gym>（继续留在树里，'
              f'但建议在注册表里升级成 rankland slug）：{", ".join(still_self[:6])}'
              + (' …' if len(still_self) > 6 else ''))
    for s in sorted(new_slugs - old_slugs):
        print(f'   ＋ {s}')
    for s in sorted(old_slugs - new_slugs):
        print(f'   － {s}')
    if args.dry_run:
        print('（--dry-run：没有写文件）')
        return 0
    if not args.manifest:
        # 覆盖前留一份备份（这是人的数据，清单每次重建，出事要能回退）
        bak = out_path + '.bak'
        if os.path.isfile(out_path):
            import shutil
            shutil.copyfile(out_path, bak)
            print(f'   备份 → {rel(bak)}')
    doc = {'defaults': (old.get('defaults') or {}), 'contests': entries}
    write_json(out_path, doc)
    print(f'💾 {rel(out_path)}')
    # ★ 「推荐 → 你批准」的提醒落在**主脚本这一步**（构建链的第 1 步就是它）：候选区里
    #   **建议收**但还没拍板的，不会自己进树 —— 说清下一步怎么批。
    und = {k: v for k, v in (reg.get('pending') or {}).items()
           if not str(v.get('answer') or '').strip()}
    sug = [k for k, v in und.items() if suggest_of(v)[0]]
    if sug:
        print(f'   ℹ️ 候选区还有 {len(sug)} 条**建议收**的没拍板（CF gym：EC 赛区 / CCPC / 省赛·邀请赛）：')
        print('      python xcpc_registry.py find --suggest      # 看清单（关键词 / --year / --cls 都能筛）')
        print('      python xcpc_registry.py approve --suggest   # 一次批准（--dry-run 先预演）')
    print('   下一步：python xcpc_pipeline.py   （或 npm run crate:xcpc -- --check）')
    return 0


# ================================================================
# CLI
# ================================================================

def main(argv):
    ap = argparse.ArgumentParser(description='XCPC 场次注册表（身份 + 归类）')
    ap.add_argument('--registry', default='')
    sub = ap.add_subparsers(dest='cmd', required=True)

    p = sub.add_parser('seed', help='从现有清单迁入（首次一次）')
    p.add_argument('--manifest', default='')
    p.add_argument('--force', action='store_true')
    p.set_defaults(fn=cmd_seed)

    p = sub.add_parser('scan', help='刷新候选区（含 QOJ 分类）')
    p.add_argument('--no-categories', action='store_true')
    p.add_argument('--refresh-categories', action='store_true')
    p.set_defaults(fn=cmd_scan)

    p = sub.add_parser('status', help='看概况与待决项')
    p.set_defaults(fn=cmd_status)

    p = sub.add_parser('answer', help='回答一条候选（key 可用逗号批量）')
    p.add_argument('key')
    p.add_argument('answer')
    p.add_argument('--slug', default='', help='指定归到哪个 slug（默认用候选建议；没有建议 ⇒ 自造身份 cf<gym>）')
    p.set_defaults(fn=cmd_answer)

    p = sub.add_parser('find', help='搜候选区（关键词 + 年份/分类/来源/建议收）')
    p.add_argument('terms', nargs='*', help='关键词（空格分隔，**全部命中**才算）')
    p.add_argument('--year', default='', help='年份：`2024` / `2022,2023` / `2022-2025`')
    p.add_argument('--cls', default='', help='分类路径子串，如 `icpc/ec` / `ccpc` / `provincial`')
    p.add_argument('--source', default='', help='候选来源：whitelist（白名单勾选）/ meta（全量元信息）')
    p.add_argument('--suggest', action='store_true', help='只看**建议收**的（EC 赛区 / CCPC / 省赛·邀请赛）')
    p.add_argument('--no-suggest', action='store_true', dest='no_suggest', help='排除建议收的')
    p.add_argument('--answered', action='store_true', help='连已经答过的也列出来')
    p.add_argument('--limit', type=int, default=30, help='每组最多列几条（0 = 全部）')
    p.add_argument('--by', default='', choices=('', 'year', 'cls', 'none'), help='分组：`year` / `cls`')
    p.add_argument('-o', '--output', default='', help='把清单写成 markdown（给"翻着看再批准"用）')
    p.set_defaults(fn=cmd_find)

    p = sub.add_parser('approve', help='批量批准筛出来的候选（= 你拍板，脚本照办）')
    p.add_argument('terms', nargs='*', help='关键词（同 `find`）')
    p.add_argument('answer', nargs='?', default='yes', help='批准成什么（默认 yes；no = 记成不导）')
    p.add_argument('--year', default='', help='年份：`2024` / `2022,2023` / `2022-2025`')
    p.add_argument('--cls', default='')
    p.add_argument('--source', default='')
    p.add_argument('--suggest', action='store_true', help='只批**建议收**的那批')
    p.add_argument('--no-suggest', action='store_true', dest='no_suggest', help='只批非建议收的（一般别这么用）')
    p.add_argument('--answered', action='store_true')
    p.add_argument('--slug', default='', help='指定归到哪个 slug（默认用候选建议）')
    p.add_argument('--dry-run', action='store_true', help='只预演：列出要批的、不写文件')
    p.set_defaults(fn=cmd_approve)

    p = sub.add_parser('classify', help='分类体检：列出系列/中间层与可疑项')
    p.set_defaults(fn=cmd_classify)

    p = sub.add_parser('add-catalog', help='补全系列：把没打过但有题单的场次也纳入')
    p.add_argument('--series', default='icpc,ccpc,provincial')
    p.add_argument('--include-empty', action='store_true', help='连"只有赛名没题单"的空壳也导')
    p.set_defaults(fn=cmd_add_catalog)

    p = sub.add_parser('xcpcio', help='把场次对到 xcpcio 目录（当权威 ratio 源用）')
    p.add_argument('--slug', default='', help='只处理这一场')
    p.add_argument('--write', action='store_true', help='写进注册表（默认只报告）')
    p.add_argument('--forget', action='store_true', help='清掉 xcpcio 指派')
    p.set_defaults(fn=cmd_xcpcio)

    p = sub.add_parser('build', help='注册表 → 清单')
    p.add_argument('--manifest', default='')
    p.add_argument('--dry-run', action='store_true')
    p.set_defaults(fn=cmd_build)

    args = ap.parse_args(argv)
    rc = args.fn(args)          # 子命令跑完再打统计（打在 parse 之后等于全是 0）
    print_stats('注册表')
    return rc


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
