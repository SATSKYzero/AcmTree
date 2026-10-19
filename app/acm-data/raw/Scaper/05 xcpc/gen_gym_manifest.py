#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
把 `gym_whitelist.json`（你手改过的白名单）变成 `xcpc_contests.json` 里的场次条目。

为什么要有它：一次要加几十个 gym 场次，手写清单不现实；而"哪些 gym 要导"是**你的判断**，
已经写在白名单里了（`include: true/false`）。这个脚本只做"翻译 + 合并"：

    board       = cf（带 gym 号；题单/通过率由 `cf_board_adapter.py` 从 gym 榜单取，需登录）
    sources     = []（题名已经在 board 里出，不重复挂 srk）
    submissions = cf（只出你自己的提交，公开 API）

**跨平台整合（`cache/rankland_index.json` 存在时自动启用）**
----------------------------------------------------------
同一场在不同平台各有一个 id：CF 是 `gym/104813`，rankland 是 `ccpc2026final`，QOJ 是
`contest/3799`，PTA 是 `pintia.cn/rankings/<id>`。索引把 gym 号 → rankland slug 对上了，
于是这里可以做三件"合并成一场"的事：

  1. **身份**换成 rankland slug（外部稳定 slug，比 `cf104813` 更有意义）
  2. **赛名/系列/年份**改用 rankland 的（中文名，且年份层与网络赛等同层，不再另起 `invitational2025`）
  3. 索引里认出唯一 QOJ 比赛号的，**挂一个 QOJ 提交来源**（你的补题记录就落回这场）

索引里没有的 gym（老场次），退回原行为（`cf<gym>` + 按英文名猜系列）。**不猜、只如实翻译**。

幂等：按 `slug` 合并 —— 手工写的条目（如 icpc2026preliminary-1/2）**不动**；
再跑一次只会更新/补齐白名单生成的条目。

用法
----
    python gen_gym_manifest.py            # 读白名单 → 写清单，并打印摘要
    python gen_gym_manifest.py --dry-run  # 只打印会写什么
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys

sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, 'lib'))
sys.path.insert(0, os.path.abspath(os.path.join(HERE, '..', 'lib')))   # …/Scaper/lib

from match import best_title_match, match_by_gym, name_tokens, norm_text  # noqa: E402
from me import cf_handle  # noqa: E402
from xcpc_common import (GYM_WHITELIST,  # noqa: E402
    MANIFEST, SERIES_FROM_RANKLAND, SERIES_NAMES, load_manifest_lenient,
    qoj_name, read_json, rel, write_json,
)  # noqa: E402

WHITELIST = GYM_WHITELIST   # ⚠️ 路径只有一处（`xcpc_common.GYM_WHITELIST`）
RANKLAND_INDEX = os.path.join(HERE, 'cache', 'rankland_index.json')
QOJ_INDEX = os.path.join(HERE, '..', '04 qoj', 'cache', 'qoj_contest_titles.json')
QOJ_SUBMISSIONS = 'acm-data/raw/Scaper/04 qoj/qoj_submissions.json'

# 系列名表 / rankland 目录→系列 id、以及系列名的显示口径，都在 `xcpc_common`里（**只有那一份**）。
# 另写一张表（`provincial` / `invitational` 两个 id）会让两张表一旦分峉，同一场比赛在不同
# 脚本里建出两个容器。所以只能从公共表读。


def series_of(name: str) -> str:
    """
    赛名 → 系列 id（**只在索引里没有 rankland 层级时**才用）。

    省赛与邀请赛**合成一个系列** —— 这两类经常合办（"CCPC 全国邀请赛（南昌）暨江西省赛"），
    从赛名分不干净，分不干净就别分。所以这两个分支返回同一个 id。
    """
    if re.search(r'Invitational|Provincial', name, re.I):
        return 'provincial-invitational'
    if re.search(r'CCPC|China Collegiate', name, re.I):
        return 'ccpc'
    if re.search(r'ICPC|ACM-ICPC', name, re.I):
        return 'icpc'
    return 'other'


def year_of(name: str, fallback: str = '') -> str:
    """年份：**优先取名字里的**（镜像可能晚一年），没有就用白名单里从 CF 开赛时间推出来的"""
    m = re.search(r'(20\d{2})', name)
    return m.group(1) if m else str(fallback or '')


def load_rankland() -> dict:
    """读跨平台索引；没有就返回空 dict（=全部退回英文名猜系列的老行为）"""
    if not os.path.isfile(RANKLAND_INDEX):
        return {}
    try:
        return read_json(RANKLAND_INDEX)
    except (ValueError, OSError) as e:
        print(f'⚠️ 读不了 {rel(RANKLAND_INDEX)}（{e}）—— 按没有索引处理', file=sys.stderr)
        return {}


def load_qoj() -> dict:
    """读 QOJ 索引（比赛号 → 官方赛名）；没有就返回空 dict"""
    if not os.path.isfile(QOJ_INDEX):
        return {}
    try:
        return read_json(QOJ_INDEX)          # 04 独家维护的 {场次号: {names, title, …}}
    except (ValueError, OSError):
        return {}


def _years_of(s) -> set:
    """赛名里出现的年份（只给下面那个建议器的"年份不冲突"守卫用）"""
    return set(re.findall(r'(?:19|20)\d{2}', str(s or '')))


def qoj_candidates(name: str, qoj_index: dict, min_common: int = 2) -> list:
    """
    CF gym 名 ↔ QOJ 官方赛名（两边都是英文官方名，所以能比）。

    门槛：**至少 2 个特征词重合**，且年份不冲突（任一边没写年份时放行）。
    刻意不自动采用：`EC Online Contest` 与 `EC-Final` 只差一个词，机器分不出来 ——
    宁可让用户看一眼（`--qoj-candidates` 打印建议），也不要认错比赛。

    ⚠️ 特征词用 `lib/match.name_tokens`（拉丁词 + 汉字 bigram）。
    自己切词（"只取 latin 词 + 一张停用词表"）—— 两份停用词表可以各自漂。
    本函数**只打印建议、不参与认定**，所以这一处换实现不改任何数据。

    @returns [(比赛号, QOJ 名, 重合词, 重合率)]，按重合率降序
    """
    gt, gy = name_tokens(name), _years_of(name)
    out = []
    for cid, v in (qoj_index or {}).items():
        for qn in (v.get('names') or []):
            qt, qy = name_tokens(qn), _years_of(qn)
            common = gt & qt
            if len(common) < min_common:
                continue
            if gy and qy and not (gy & qy):
                continue
            out.append((cid, qn, sorted(common), len(common) / min(len(gt), len(qt))))
    out.sort(key=lambda x: (-x[3], -len(x[2])))
    return out


def rankland_of(index: dict, gid) -> tuple[str, dict]:
    """
    gym 号 → (rankland slug, 该场索引信息)；索引里没有就返回 ('', {})。

    ⚠️ "gym 号 → slug"的判据**只有一份**，在 `lib/match.match_by_gym`
    （`xcpc_registry.py` 走的就是它）。自己查一遍 `byGym` 会让两份判据各自漂。
    本函数只是**再带上那场的索引信息**（调用方要 info），判据本身不再自己写。
    """
    slug, _why = match_by_gym(gid, index)
    if not slug:
        return '', {}
    return slug, (index.get('bySlug') or {}).get(slug) or {}


def cf_problem_titles(gid) -> list[str]:
    """从 gym 榜单缓存里取题名（缓存只有摘要，题名在里面）"""
    path = os.path.join(HERE, 'cache', f'cf_standings_{gid}.json')
    if not os.path.isfile(path):
        return []
    try:
        d = read_json(path)
    except (ValueError, OSError):
        return []
    return [str(p.get('name') or '') for p in (d.get('problems') or []) if str(p.get('name') or '').strip()]


def match_by_problems(gid, index: dict, claimed: set, year: str) -> tuple[str, dict, float, int]:
    """
    gym 号不在索引的 `byGym` 里时，用**题目名集合**找同一场（这是内容层面的证据，不是猜）。

    为什么可行：CF gym 的题名与 rankland 的题名都是官方英文题名，同一场的题名集合必然重合；
    再要求年份对得上（±1 年，跨年赛），就基本不会认错。

    ⚠️ 判据**只有一份**，在 `lib/match.best_title_match`（`xcpc_registry.py`
    那条路也走它）。选共用件的两处理由：
      · 归一化是"只留小写字母数字"，共用件是 `norm_text`（多留汉字 —— CF 题名是英文，所以
        对当前数据无差别，但以后有中文题名时共用件更对）；
      · 年份守卫取 `startAt`，共用件按**赛季年**（`index_year`）—— 跨年赛不再误杀。
    阈值仍由**本工具**定：这里返回"最像的那一条"（不设门槛），门槛 `score>=0.5 且 inter>=5`
    在调用处判 —— 那是 gym 这个场景的标定，不是重复。

    @returns (slug, info, 重合率, 重合题数)；找不到返回 ('', {}, 0.0, 0)
    """
    mine = {norm_text(t) for t in cf_problem_titles(gid) if norm_text(t)}
    if len(mine) < 4:
        return '', {}, 0.0, 0
    return best_title_match(mine, index, claimed=claimed, year=year)


def mid_names(index: dict) -> dict:
    """
    mid id → 官方层名（`icpc2024` → `ICPC 2024 (49th)`），取自 rankland 的目录树。

    为什么要全局建这张表：**同一个 mid 只能有一个名字**。没对上 rankland 的 gym
    也能自己算出 `icpc2024` 这个 id，若它只写 "ICPC 2024"，合并时就会和
    网络赛那边的 "ICPC 2024 (49th)" 撞成 field-value-conflict（实测撞了 16 条）。
    """
    out: dict[str, str] = {}
    for info in (index.get('bySlug') or {}).values():
        mid, name = str(info.get('mid') or ''), str(info.get('midName') or '')
        if mid and name and mid not in out:
            out[mid] = name
    return out


def layers(info: dict, sid_fallback: str, year: str, mids: dict | None = None) -> tuple[str, str, str, str]:
    """
    (系列 id, 系列名, mid id, mid 名) —— 索引里有 rankland 的层级就用它的。

    rankland 的 mid 是它自己的目录名（`icpc2026`），与本仓库的 extKey 惯例一致；
    没有 mid（如 ucup 两层结构）时退回 `系列+年份`。
    """
    rid = str(info.get('series') or '')
    sid = SERIES_FROM_RANKLAND.get(rid, sid_fallback)
    sname = SERIES_NAMES.get(sid, SERIES_NAMES['other'])
    mid_id = str(info.get('mid') or '') or (f'{sid}{year}' if year else '')
    mid_name = (str(info.get('midName') or '')
                or (mids or {}).get(mid_id)
                or (f'{sname} {year}' if year else ''))
    return sid, sname, mid_id, mid_name


def make_entry(gym: dict, handle: str, index: dict, qoj_index: dict | None = None,
               claimed: set | None = None, match_log: list | None = None,
               mids: dict | None = None) -> dict:
    gid = gym['id']
    cf_name = gym.get('name') or f'CF gym {gid}'
    rl_slug, info = rankland_of(index, gid)
    matched_by = 'gym' if rl_slug else ''

    # 索引里没有这个 gym 号时，退一步按**题目名集合**找同一场（保守阈值：重合率 ≥0.5 且至少 5 题）
    if not rl_slug and index:
        cand_slug, cand_info, score, inter = match_by_problems(
            gid, index, claimed or set(), year_of(cf_name, gym.get('year')))
        if score >= 0.5 and inter >= 5:
            rl_slug, info, matched_by = cand_slug, cand_info, 'problems'
            if match_log is not None:
                match_log.append((gid, cf_name, cand_slug, str(cand_info.get('title') or ''), score, inter))
        elif match_log is not None and cand_slug:
            match_log.append((gid, cf_name, '',
                              f'最像的是 {cand_slug}（{cand_info.get("title", "")}），'
                              f'但只重合 {inter} 题 / {score:.0%}，没敢用', score, inter))
    if claimed is not None and rl_slug:
        claimed.add(rl_slug)

    # 身份：有 rankland 就用它的 slug（跨平台同一场 = 同一条目）；否则退回 cf<gym>
    slug = rl_slug or gym.get('slug') or f'cf{gid}'
    name = str(info.get('title') or '') or cf_name
    sid, sname, mid_id, mid_name = layers(info, series_of(cf_name), year_of(cf_name, gym.get('year')), mids)

    board_note = ('CF gym 榜单（contest.standings，需登录）。通过率口径 = 通过队伍数 ÷ 有效队伍数，'
                  '但 gym 含虚拟参赛，数字会比官方榜低。')
    if info:
        how = {'gym': '索引按 gym 号对上', 'problems': '索引里没有这个 gym 号，按**题目名集合**对上'}.get(matched_by, '')
        board_note += f' 本场在 rankland 里的身份是 {rl_slug}（{how}），赛名取 rankland 的中文名。'
    if (info.get('ptaRankings') or []):
        board_note += (' rankland 标着官方榜 pintia.cn/rankings/' + '、'.join(info['ptaRankings'])
                       + '；本仓库没有对应文件，暂未采用。')

    entry = {
        'slug': slug,
        'name': name,
        'slugFrom': f'codeforces:gym/{gid}',
        'series': {'id': sid, 'name': sname},
        'board': {
            'source': 'cf',
            'role': 'board',
            'gym': gid,
            'file': f'acm-data/raw/Scaper/05 xcpc/cache/cf_standings_{gid}.json',
            'note': board_note,
        },
        'sources': [],
        'submissions': ([
            {
                'source': 'cf',
                'role': 'submissions',
                'gym': gid,
                'file': f'acm-data/raw/Scaper/05 xcpc/cache/cf_{gid}_{handle}.json',
                'note': '只导你自己（handle 在 defaults.cfHandle）的提交',
            }
        ] if handle else []),
        'generated': 'gym_whitelist.json',
    }
    if cf_name and cf_name != name:
        entry['aliases'] = {'cf': cf_name}
    if mid_id:
        entry['mid'] = {'id': mid_id, 'name': mid_name or mid_id}
    if info:
        entry['rankland'] = {'slug': rl_slug, 'startAt': info.get('startAt') or '',
                             'matchedBy': matched_by,
                             'repoPath': info.get('repoPath') or '',
                             'refs': [r.get('link') for r in (info.get('refs') or []) if r.get('link')]}

    # QOJ：索引里认出**唯一**一个 QOJ 比赛号时，挂一个提交来源。
    # 你的 QOJ 提交文件里混着好几场比赛，适配器按 contest 号过滤（见 qoj_adapter.py）。
    # 04 的 qoj_contest_titles.json 能给这个名字的**官方赛名** —— 写在 note 里便于核对
    # "rankland 认出来的比赛号确实是同一场"。
    qojs = [c for c in (info.get('qojContests') or []) if c]
    if len(qojs) == 1:
        oname = qoj_name(qoj_index or {}, qojs[0])
        entry['submissions'].append({
            'source': 'qoj',
            'role': 'submissions',
            'file': QOJ_SUBMISSIONS,
            'contest': qojs[0],
            'note': ('QOJ 补题记录（比赛号 ' + qojs[0] + ' 是从 rankland 的题目链接里认出来的'
                     + (f'；QOJ 上这场叫「{oname}」' if oname else '') + '）'),
        })
    return entry


def year_from_standings(gid: int) -> str:
    """
    名字里没年份时，从 gym 榜单的 `contest.startTimeSeconds` 推（需要凭据）。
    拿不到就返回 ''（那这场会直接挂在系列下，不挂年份层 —— 也能用）。
    """
    try:
        from cf_api import call, has_credentials
        if not has_credentials():
            return ''
        r = call('contest.standings', {'contestId': gid, 'from': 1, 'count': 1, 'showUnofficial': 'true'}, auth=True)
        st = (r.get('contest') or {}).get('startTimeSeconds')
        if not st:
            return ''
        from datetime import datetime, timedelta, timezone
        return str(datetime.fromtimestamp(int(st), tz=timezone.utc)
                   .astimezone(timezone(timedelta(hours=8))).year)
    except Exception:
        return ''


def main(argv):
    ap = argparse.ArgumentParser(description='gym 白名单 → 场次清单')
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--manifest', default='')
    ap.add_argument('--qoj-candidates', action='store_true',
                    help='给"没对上 rankland"的 gym 打印 QOJ 候选场次（供人工确认，不自动采用）')
    args = ap.parse_args(argv)

    # ⚠️ 让每个跑它的人都看见：这个工具用的是**另一套"同一场"匹配**，
    #    不在链子上、只在手工跑时生效 —— 结论以 `xcpc_registry.py` 那条路为准
    #    （`lib/match.py` 是那套判据的唯一实现，见它的文件头）。
    print('⚠️ 本工具用的是另一套"同一场"匹配（手工工具，不在链子上）——'
          '结论以 `xcpc_registry.py`（`lib/match.py`）为准；两边不一致时先信注册表那条。')

    manifest_path = args.manifest or MANIFEST
    manifest = load_manifest_lenient(manifest_path)
    if not manifest.get('contests'):
        print(f'ℹ️ {rel(manifest_path)} 不存在或是空的 —— 从零开始（只会写入这次生成的条目；'
              '手写的 PTA 场次需要你自己加，见 _usage.md §0.1）')
        manifest.setdefault('defaults', {})
    if not os.path.isfile(WHITELIST):
        print(f'❌ 找不到白名单 {rel(WHITELIST)} —— 先用 gym 白名单脚本生成，或手工建', file=sys.stderr)
        return 1
    wl = read_json(WHITELIST)
    # handle 的唯一来源是个人信息文件 me.json；白名单/清单里的只是残留副本
    handle = (cf_handle() or str(wl.get('handle') or '')
              or (manifest.get('defaults') or {}).get('cfHandle') or '')
    if not handle:
        # 不知道是谁 ⇒ 不挂 CF 提交来源（`cf_adapter.py` 本来也会因为没 handle 而跳过）。
        # 场次条目照常生成：题单/通过率/身份都跟"谁在导"无关。
        print('ℹ️ 跳过 CF 提交来源：没有 handle（在 acm-data/raw/Scaper/me.json 的 cf.handle 里填上，'
              '或先跑 fetch_my_gyms.py --handle <你的CF用户名>）—— 其余照常生成')
    else:
        # 清单里的 defaults 是给出提交的适配器看的（cf_adapter 只导这个 handle 的提交）
        manifest.setdefault('defaults', {})['cfHandle'] = handle

    picked = [g for g in (wl.get('gyms') or []) if g.get('include')]
    if not picked:
        print('⚠️ 白名单里一个 include=true 都没有')
        return 1

    index = load_rankland()
    qoj_index = load_qoj()
    if index:
        print(f'ℹ️ 跨平台索引：{len(index.get("bySlug") or {})} 场、认得 {len(index.get("byGym") or {})} 个 gym'
              f'（{rel(RANKLAND_INDEX)}）')
    else:
        print('ℹ️ 没有跨平台索引（cache/rankland_index.json）—— 本次不做跨平台整合，'
              '系列按英文名猜。要整合先跑 build_rankland_index.py')
    if qoj_index:
        print(f'ℹ️ QOJ 索引：{len(qoj_index)} 场比赛号有官方赛名（{rel(QOJ_INDEX)}）')

    # 名字和索引都给不出年份的，才去捞一次 gym 榜单开赛时间（需要凭据；拿不到就挂系列下）
    def has_year(g: dict) -> bool:
        if year_of(g.get('name') or '', g.get('year')):
            return True
        _, info = rankland_of(index, g['id'])
        return bool(str(info.get('mid') or ''))

    need_year = [g for g in picked if not has_year(g)]
    if need_year:
        print(f'ℹ️ {len(need_year)} 个 gym 既没有年份也认不出 rankland 层级，从 CF 开赛时间补：'
              f'{", ".join(str(g["id"]) for g in need_year)}')
        for g in need_year:
            y = year_from_standings(g['id'])
            if y:
                g['year'] = y
                print(f'   gym {g["id"]} → {y} 年')

    # 手工写的条目（没有 generated 标记）保持原样，且**优先**：
    # 若某个 gym 认出的 rankland slug 与手工条目撞名（如网络赛第二场 = gym 106701），
    # 就跳过生成 —— 手工条目里写得更细（PTA 榜单 + 账户线索），不该被覆盖。
    existing = list(manifest.get('contests') or [])
    manual = [c for c in existing if not c.get('generated')]
    manual_slugs = {c.get('slug') for c in manual}
    generated = {}
    integrated = skipped = 0
    qoj_map = []
    claimed: set = set()
    match_log: list = []
    unmatched_gyms: list = []
    mids = mid_names(index)
    for g in picked:
        e = make_entry(g, handle, index, qoj_index, claimed, match_log, mids)
        if e['slug'] in manual_slugs:
            skipped += 1
            continue
        if e.get('rankland'):
            integrated += 1
            for s in e['submissions']:
                if s.get('source') == 'qoj':
                    qoj_map.append((g['id'], e['slug'], s['contest'], qoj_name(qoj_index, s['contest'])))
        else:
            unmatched_gyms.append(g)
        generated[e['slug']] = e

    new_gen = sorted(generated.values(), key=lambda c: (c['series']['id'], (c.get('mid') or {}).get('id', ''), c['slug']))
    manifest['contests'] = manual + new_gen

    # 摘要
    by_series = {}
    for c in new_gen:
        by_series[c['series']['id']] = by_series.get(c['series']['id'], 0) + 1
    print(f'白名单勾选 {len(picked)} 个 gym → 生成/更新 {len(generated)} 条清单条目')
    if index:
        print(f'   跨平台整合：{integrated} 条用了 rankland 身份/赛名'
              + (f'；{skipped} 条与手工条目撞名，保持手工（{", ".join(sorted(manual_slugs))}）' if skipped else ''))
        n_qoj = sum(1 for c in new_gen if any((s.get('source') == 'qoj') for s in (c.get('submissions') or [])))
        print(f'   其中 {n_qoj} 条挂上了 QOJ 提交来源（补题记录会落回同一场）')
        for gid, slug, cid, oname in qoj_map:
            print(f'      gym {gid} → {slug} → QOJ {cid}：{oname or "（QOJ 索引里没这个名字）"}')
    if match_log:
        took = [m for m in match_log if m[2]]
        print(f'   按题目名集合对上的 {len(took)} 条 / 没敢用的 {len(match_log) - len(took)} 条（自己核一下名字）：')
        for gid, cf_name, slug, rl_name, score, inter in match_log:
            print(f'      gym {gid}  CF：{cf_name[:52]}')
            print(f'          → {("采用 " + slug) if slug else "未采用"}：{rl_name[:52]}（重合 {inter} 题 / {score:.0%}）')
    print('   手工条目（保持不动）：' + (', '.join(c['slug'] for c in manual) or '（无）'))
    print('   系列分布：' + '、'.join(f'{SERIES_NAMES.get(k, k)} {v}' for k, v in sorted(by_series.items())))
    if index:
        unmatched = [c['slug'] for c in new_gen if not c.get('rankland')]
        if unmatched:
            print(f'   ℹ️ 索引里没有的 {len(unmatched)} 个 gym（保持 `cf<gym>` 身份、系列按英文名猜）：'
                  + '、'.join(unmatched[:12]) + (' …' if len(unmatched) > 12 else ''))
            print('      · 想让它们也整合：确认白名单里的 gym 号没写错；'
                  'rankland 没收录的老场次就只能这样')
        if args.qoj_candidates and unmatched_gyms:
            print('   QOJ 候选（CF 名与 QOJ 名都是官方英文名，所以能比；**只是建议，不自动采用**）：')
            for g in unmatched_gyms:
                print(f'      gym {g["id"]}  {str(g.get("name") or "")[:58]}')
                cands = qoj_candidates(str(g.get('name') or ''), qoj_index)[:2]
                if not cands:
                    print('          （QOJ 上也没有满足门槛的场次）')
                for cid, qn, common, score in cands:
                    print(f'          QOJ {cid}（{score:.0%} 重合 {"、".join(common)}）：{qn[:56]}')
    missing_year = [c['slug'] for c in new_gen if not c.get('mid')]
    if missing_year:
        print(f'   ⚠️ 认不出年份（直接挂在系列下）：{", ".join(missing_year)}')

    if args.dry_run:
        print('（--dry-run：没有写文件）')
        return 0
    write_json(manifest_path, manifest)
    print(f'💾 写入 {rel(manifest_path)}')
    print('\n下一步：npm run crate:xcpc      # 会把所有勾选的场次都跑一遍（首次较慢：要抓 gym 榜单）')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
