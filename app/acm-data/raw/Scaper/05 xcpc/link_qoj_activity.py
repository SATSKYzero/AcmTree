#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
把 QOJ 上的个人提交接进 `xcpc_contests.json` 的对应场次。

它解决什么
----------
`04 qoj/QOJ_submissions_scraper.py --fetch` 抓下来的是一份**跨比赛**的提交文件
（706 条 / 41 场）。文件里每条记录都带 `/contest/<id>/problem/<pid>`，而 rankland 的
跨平台索引里有 `pid → rankland slug`（`byProblem`）—— 于是"这份提交属于哪一场"
可以**自动**认出来，不用人一场场地挂。

对每个认出来的 QOJ 比赛号：
  * 清单里**已有**这场（同一个 slug，可能是 CF gym 整合来的）→ 给它补一条
    `{source: qoj, role: submissions, contest: <id>}`；
  * 清单里**没有**这场 → 新建一条目：赛名/系列/年份/题单取自 rankland 索引
    （`rankland-index` 当 board，**不写 ratio**），提交挂 QOJ。
    新建的条目带 `fromQojActivity: true` 标记，**重跑只更新自己建的那些**，
    不动手工条目、也不动 `gen_gym_manifest.py` 生成的条目。

幂等：同一个 `contest` 只会挂一次；已有就更新 note。

用法
----
    python link_qoj_activity.py --dry-run    # 先看会改什么
    python link_qoj_activity.py              # 真写
    python link_qoj_activity.py --no-new     # 只补已有场次，不新建条目
"""

from __future__ import annotations

import argparse
import collections
import json
import os
import re
import sys

sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, 'lib'))

from match import name_hint, problem_id_votes  # noqa: E402
from xcpc_common import (  # noqa: E402
    MANIFEST, SERIES_FROM_RANKLAND, qoj_name, read_json, rel, series_name, write_json,
)  # noqa: E402

QOJ_FILE = os.path.abspath(os.path.join(HERE, '..', '04 qoj', 'qoj_submissions.json'))
INDEX = os.path.join(HERE, 'cache', 'rankland_index.json')
QOJ_INDEX = os.path.join(HERE, '..', '04 qoj', 'cache', 'qoj_contest_titles.json')
# 清单里引用 QOJ 提交文件时写的路径（仓库相对，跨平台一致）
QOJ_MANIFEST_PATH = 'acm-data/raw/Scaper/04 qoj/qoj_submissions.json'
CONTEST_RE = re.compile(r'/contest/(\d+)')
PROBLEM_RE = re.compile(r'/problem/(\d+)')


def group_activity(rows: list[dict]) -> dict:
    """提交记录 → `{比赛号: 该场出现过的题目 id 集合}`"""
    out: dict[str, set] = collections.defaultdict(set)
    for r in rows:
        link = str(r.get('题目链接') or '')
        c = CONTEST_RE.search(link)
        p = PROBLEM_RE.search(link)
        if c and p:
            out[c.group(1)].add(p.group(1))
    return out


def match_slug(pids: set, index: dict) -> tuple[str, int, int]:
    """
    用题目 id 反查 rankland 场次（多数票）。

    ⚠️ 判据**只有一份**，在 `lib/match.problem_id_votes`（`xcpc_registry.py`
    走的是同一个）。自己抄一遍会让两份各自漂（"同一件事两个答案"）。

    @returns (slug, 命中题数, 这场提交里题目总数)；认不出返回 ('', 0, n)
    """
    return problem_id_votes(pids, index)


#: 从赛名里取年份（只用来决定"逐年份问一遍共用件"，判断本身在 `lib/match`）
_YEAR = re.compile(r'(?:19|20)\d{2}')


def match_by_name(cid: str, qoj_index: dict, index: dict,
                  exclude: set | None = None) -> tuple[str, list, list]:
    """
    题目 id 对不上时，退一步**按赛名**找（QOJ 官方名 ↔ rankland 的中文名/英文名）。

    ⚠️ 判据**只有一份**，在 `lib/match.name_hint`（`xcpc_registry.py` 用的是
    同一个）。共用件与这里的差别：
      · **按空格/标点切词** —— 中文整段成一个 token，跟 QOJ 的中文别名对不上
        （`lib/match.name_tokens` 用"拉丁词 + 汉字 bigram"，不受空格影响）；
      · **年份守卫取 `startAt`** —— 跨年赛（EC-Final / CCPC Final 常在次年上半年办）会
        **误杀正确候选**（见 `lib/match.index_year`），共用件按**赛季年**卡。
    本函数与 `name_hint` 只剩**决策口径**不同：这里要"**唯一最佳**才认"（认错场次会把提交
    挂到别的比赛上），`name_hint` 只负责排序。

    @returns (slug, 命中说明, 并列候选 slug)；认不出时 slug 为空
    """
    names = ((qoj_index.get(str(cid)) or {}).get('names') or [])
    # QOJ 的别名可能带不同年份 ⇒ 逐年份问一遍（合起来与"my_years ∩ theirs ≠ ∅"同样宽容，
    # 但用的是共用件的赛季年口径，而不是那个会误杀跨年赛的 startAt）
    years = sorted({y for n in names for y in _YEAR.findall(str(n))}) or ['']
    best: dict = {}
    for y in years:
        for score, inter, slug, _title, _gap in name_hint(names, index, year=y,
                                                          exclude=exclude, top=4):
            if slug not in best or inter > best[slug][1]:
                best[slug] = (score, inter)
    if not best:
        return '', [], []
    ranked = sorted(best.items(), key=lambda kv: -kv[1][1])
    slug, (score, inter) = ranked[0]
    if len(ranked) > 1 and ranked[1][1][1] == inter:
        return '', [], [s for s, _v in ranked[:3]]            # 并列 → 不认，列出来给人看
    return slug, [f'{inter} 个特征词重合 {score:.0%}'], []


def layers(info: dict) -> tuple[dict, dict | None]:
    rid = str(info.get('series') or '')
    sid = SERIES_FROM_RANKLAND.get(rid, 'other')
    series = {'id': sid, 'name': series_name(sid)}
    mid_id = str(info.get('mid') or '')
    mid_name = str(info.get('midName') or '')
    return series, ({'id': mid_id, 'name': mid_name} if mid_id and mid_name else None)


def new_entry(slug: str, info: dict, cid: str, oname: str) -> dict:
    series, mid = layers(info)
    entry = {
        'slug': slug,
        'name': str(info.get('title') or slug),
        'slugFrom': 'rankland:' + str(info.get('repoPath') or ''),
        'series': series,
        'board': {
            'source': 'rankland-index',
            'role': 'board',
            'file': 'acm-data/raw/Scaper/05 xcpc/cache/rankland_index.json',
            'note': '这场只有 QOJ 上的补题记录，没有榜单文件：赛名/题单取自 rankland 索引，'
                    '**不写 ratio**（索引里没有每题过队数）。想要难度档就得补一份真榜单。',
        },
        'sources': [],
        'submissions': [{
            'source': 'qoj',
            'role': 'submissions',
            'file': QOJ_MANIFEST_PATH,
            'contest': cid,
            'note': f'QOJ 补题记录（比赛号 {cid} 是按题目 id 对上 rankland 的'
                    + (f'；QOJ 上这场叫「{oname}」' if oname else '') + '）',
        }],
        'fromQojActivity': True,
    }
    if mid:
        entry['mid'] = mid
    return entry


def main(argv):
    ap = argparse.ArgumentParser(description='把 QOJ 提交接到清单里对应的场次')
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--no-new', action='store_true', help='只补已有场次，不新建条目')
    ap.add_argument('--manifest', default='')
    args = ap.parse_args(argv)

    # ⚠️ 让每个跑它的人都看见：这个工具用的是**另一套"同一场"匹配**
    #    （按空格/标点切词、中文整段成 token），不在链子上、只在手工跑时生效 ——
    #    结论以 `xcpc_registry.py` 那条路为准（`lib/match.py` 是唯一实现）。
    print('⚠️ 本工具用的是另一套"同一场"匹配（手工工具，不在链子上）——'
          '结论以 `xcpc_registry.py`（`lib/match.py`）为准；两边不一致时先信注册表那条。')

    if not os.path.isfile(QOJ_FILE):
        print(f'❌ 找不到 {rel(QOJ_FILE)} —— 先跑 04 qoj/QOJ_submissions_scraper.py --fetch',
              file=sys.stderr)
        return 1
    rows = read_json(QOJ_FILE)
    if not isinstance(rows, list):
        rows = rows.get('submissions') or []
    index = read_json(INDEX)
    by_slug = index.get('bySlug') or {}
    qoj_index = read_json(QOJ_INDEX) if os.path.isfile(QOJ_INDEX) else {}

    act = group_activity(rows)
    manifest_path = args.manifest or MANIFEST
    manifest = read_json(manifest_path)
    by_existing = {c.get('slug'): c for c in (manifest.get('contests') or [])}

    # 已经被清单里某场挂过的 QOJ 比赛号（手工或上一轮接的）——不用再动
    already = set()
    for c in manifest.get('contests') or []:
        for s in c.get('submissions') or []:
            if (s.get('source') or '') == 'qoj' and str(s.get('contest') or '').strip():
                already.add(str(s['contest']).strip())

    attached, created, unmapped, by_name, ambiguous = [], [], [], [], []
    for cid, pids in sorted(act.items(), key=lambda kv: -len(kv[1])):
        if cid in already:
            continue
        slug, hit, total = match_slug(pids, index)
        how = f'题目 id 对上 {hit}/{total}'
        if not slug:                                   # 题目 id 对不上 → 按赛名找
            slug, tokens, cands = match_by_name(cid, qoj_index, index)
            if slug:
                how = '按赛名对上：' + '、'.join(tokens)
            else:
                if cands:
                    ambiguous.append((cid, len(pids), cands))
                else:
                    unmapped.append((cid, len(pids)))
                continue
            by_name.append((cid, slug, how))
        oname = qoj_name(qoj_index, cid)
        entry = by_existing.get(slug)
        if entry is None:
            if args.no_new:
                unmapped.append((cid, len(pids)))
                continue
            info = by_slug.get(slug) or {}
            entry = new_entry(slug, info, cid, oname)
            manifest.setdefault('contests', []).append(entry)
            by_existing[slug] = entry
            created.append((slug, cid, len(pids), str(info.get('title') or ''), how))
            continue
        subs = entry.setdefault('submissions', [])
        found = next((s for s in subs
                      if (s.get('source') or '') == 'qoj' and str(s.get('contest') or '') == cid), None)
        if found:
            continue
        subs.append({
            'source': 'qoj',
            'role': 'submissions',
            'file': QOJ_MANIFEST_PATH,
            'contest': cid,
            'note': f'QOJ 补题记录（比赛号 {cid}，{how}）'
                    + (f'；QOJ 上这场叫「{oname}」' if oname else ''),
        })
        attached.append((slug, cid, len(pids), how))

    print(f'📄 {rel(QOJ_FILE)}：{len(rows)} 条提交 / {len(act)} 场'
          + (f'（其中 {len(already)} 场清单里已经挂过，跳过）' if already else ''))
    print(f'   接到已有场次 {len(attached)} 场；新建场次 {len(created)} 条；'
          f'对不上 {len(unmapped)} 场' + (f'；并列未定 {len(ambiguous)} 场' if ambiguous else ''))
    for slug, cid, n, how in attached:
        print(f'   [已有] {slug:<34} ← QOJ {cid}（{n} 题）  {how}')
    for slug, cid, n, title, how in created:
        print(f'   [新建] {slug:<34} ← QOJ {cid}（{n} 题）  {title[:30]}  {how}')
    if ambiguous:
        print('   [待定] 名字并列，没敢认（人工看一眼）：')
        for cid, n, detail in ambiguous:
            names = qoj_name(qoj_index, cid)
            print(f'      QOJ {cid}（{n} 题）{names[:44]} → 候选：{"、".join(detail)}')
    if unmapped:
        names = '、'.join(f'{c}({n}题)' for c, n in unmapped[:10])
        print(f'   [跳过] rankland 没收录这些 QOJ 场次：{names}' + (' …' if len(unmapped) > 10 else ''))

    if args.dry_run:
        print('（--dry-run：没有写文件）')
        return 0
    if not attached and not created:
        print('ℹ️ 没有要改的 —— 清单已经是最新')
        return 0
    write_json(manifest_path, manifest)
    print(f'💾 {rel(manifest_path)}')
    print('   下一步：npm run crate:xcpc -- --check')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
