#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
PTA 榜单 → crate 片段（C + P + ratio）

数据来源
--------
PTA「榜单」页面的接口响应（浏览器 F12 → Network 里那份 JSON），本地存成文件即可。
关键字段（实测）：

    competitionBasicInfo          name / startAt / endAt / freezeAt / id / type
    xcpcRankings.rankings[]       rank, solvedCount, teamInfo{teamName,schoolName,excluded},
                                  detailsByProblemSetProblemId{pid: {acceptTime, validSubmitCount, …}}
    xcpcRankings.problemInfoByProblemSetProblemId{pid: {label:"A", acceptCount, submitCount}}

**判"这题过了"看 `acceptTime >= 0`**（不是 `status=="AC"`，那个字段不存在；
`score` 也不可靠 —— 榜首队的 totalScore 居然是 0）。

ratio 口径（与 HDU / 牛客一致）
-------------------------------
    ratio = 通过队伍数 / 有效队伍数 × 100
    通过队伍数  = 该题 acceptTime >= 0 的队伍数（逐格数出来）
    有效队伍数  = 至少解出 1 题的队伍数

⚠️ **不要用题目页/`PTA_problems.json` 里的"通过率"**：那是 `通过数/提交数`
   （实测 115/1216 = 9.46%），分母不是队伍数，与本项目口径不同。

用法
----
    python pta_adapter.py icpc2026preliminary-2
    python pta_adapter.py icpc2026preliminary-2 -o out.json
    python pta_adapter.py icpc2026preliminary-2 --file "…/PTA_rankings.json"   # 临时换榜单
    python pta_adapter.py --list              # 清单里有哪些场次
"""

from __future__ import annotations

import argparse
import os
import sys

sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, 'lib'))

from xcpc_common import (add_crate_path,  # noqa: E402
    CACHE, contest_key, find_contest, fmt_ratio, layers_of, load_manifest, mid_key,
    norm_letter, open_tree, platform_key, problem_key, read_json, read_json_cached, rel, resolve, series_key,
    xcpc_nature,
)
from read_modes import add_cli_args, configure_from  # noqa: E402

# ---- 接上 crate.py（构造器）----
add_crate_path()

from crate import Crate, link_kinds, to_cst, validate_crate  # noqa: E402

LABEL = 'PTA 榜单'
# 同一个适配器吃两种来源：PTA 榜（`pta`）与**牛客**榜（`nk`，形状不同、见 `analyze_nk`）。
# 它们各自有自己那棵树（`aux-pta` / `aux-nk`），所以**来源必须由调用方告知**
# （流水线透传清单里的 `source`），默认 PTA。
SOURCE = 'pta'


# ================================================================
# 读 + 算
# ================================================================

def read_raw(path: str) -> dict:
    """
    读榜单文件 —— **不校验形状**。

    为什么不在这里校验"缺 xcpcRankings 就抛"：同一个适配器现在要吃两种形状
    （PTA 的 `xcpcRankings` 与牛客的 `problems`，见 `analyze_nk`），
    在这里挑形状会让 `--file` 指向牛客文件时先炸在"不像 PTA"上。
    形状判断统一放在 `main()` 的自动识别里，**只认这两种，认不出就明确报错**。
    """
    d = read_json_cached(path)
    if not isinstance(d, dict):
        raise ValueError(f'{path} 顶层不是 JSON 对象 —— 榜单文件应该是接口响应本身')
    d['_path'] = path
    return d


def analyze(board: dict) -> dict:
    """
    逐格数出每题的通过队伍数 + 有效队伍数，并顺带和 PTA 自己的 acceptCount 对账。

    @returns {meta, effectiveTeams, teams, solved:{pid:n}, letters:{pid:label},
              counts:{pid:acceptCount}, officialTeams}
    """
    info = board.get('competitionBasicInfo') or {}
    rk = board.get('xcpcRankings') or {}
    rankings = rk.get('rankings') or []
    problem_info = rk.get('problemInfoByProblemSetProblemId') or {}

    letters = {pid: norm_letter(v.get('label')) for pid, v in problem_info.items()}
    counts = {pid: int(v.get('acceptCount') or 0) for pid, v in problem_info.items()}

    solved = {pid: 0 for pid in problem_info}
    effective = 0
    official = 0
    for r in rankings:
        details = r.get('detailsByProblemSetProblemId') or {}
        ac = 0
        for pid, det in details.items():
            if not isinstance(det, dict):
                continue
            accept_time = det.get('acceptTime')
            if accept_time is None:
                continue
            try:
                done = float(accept_time) >= 0
            except (TypeError, ValueError):
                done = False
            if done:
                ac += 1
                if pid in solved:
                    solved[pid] += 1
        if ac > 0:
            effective += 1
        if not (r.get('teamInfo') or {}).get('excluded'):
            official += 1

    return {
        'meta': {
            'id': str(info.get('id') or ''),
            'name': str(info.get('name') or ''),
            'startAt': to_cst(info.get('startAt')),
            'endAt': to_cst(info.get('endAt')),
            'freezeAt': to_cst(info.get('freezeAt')),
            'hideScoreboard': bool(info.get('hideScoreboard')),
            'type': str(info.get('type') or ''),
        },
        'effectiveTeams': effective,
        'teams': len(rankings),
        'officialTeams': official,
        'solved': solved,
        'letters': letters,
        'counts': counts,
        # ---- `build()` 只认这几个"已成形的结论"，不再自己算/自己拼链接 ----
        # 这样 PTA / 牛客两种形状对上层的**契约完全一致**（见 analyze_nk）。
        'ratios': {pid: fmt_ratio(solved.get(pid, 0), effective) for pid in letters},
        'board_link': (f"https://pintia.cn/rankings/{info.get('id')}"
                       if info.get('id') else ''),
        'label': LABEL,
        'src': board.get('_path', ''),
    }


def report(stats: dict) -> list[str]:
    """打印/收集对账信息（**不发散**：只报事实）"""
    lines = []
    m = stats['meta']
    lines.append(f"   榜单: {m['name']}  |  {m['startAt']} ~ {m['endAt']}")
    lines.append(f"   队伍: {stats['teams']} 条（非 excluded {stats['officialTeams']}）"
                 f" | 有效队伍（至少过 1 题）{stats['effectiveTeams']}")
    if m['freezeAt']:
        lines.append(f"   封榜时间 {m['freezeAt']}"
                     + ('（hideScoreboard=true，但数据里含封榜后的通过）' if m['hideScoreboard'] else ''))
    bad = 0
    for pid in sorted(stats['letters'], key=lambda p: stats['letters'][p]):
        letter = stats['letters'][pid]
        mine = stats['solved'].get(pid, 0)
        theirs = stats['counts'].get(pid, 0)
        ok = '✓' if mine == theirs else f'✗ 差 {mine - theirs:+d}'
        bad += (mine != theirs)
        lines.append(f"   {letter:>2}: 通过队伍 {mine:>5} / 有效 {stats['effectiveTeams']}"
                     f" → ratio {fmt_ratio(mine, stats['effectiveTeams']):>6}%"
                     f"   （PTA acceptCount {theirs} {ok}）")
    if bad:
        lines.append(f"   ⚠️ {bad} 道题与 PTA 自己的 acceptCount 对不上 —— "
                     'acceptCount 是"通过队伍数"吗？需要确认后再用')
    return lines


# ================================================================
# 造 crate 片段
# ================================================================

def build(contest: dict, stats: dict, source_id: str = '', tree_source: str = SOURCE) -> Crate:
    """
    `source_id` 决定"这份榜在来源面板/`字段来源`里显示成什么"。

    ⚠️ 参数化是为了让**同一个适配器**也能吃
    **牛客**那份 `nk_rank_stats.json`（见 `analyze_nk`）——
    口径："nk/hdu 与 xcpc 是完全不交的" ⇒ **不新增 nk 适配器**，
    而是在 xcpc 链路里换一个数据源（来源名如实写成 `xcpc-nk-<slug>`）。

    `tree_source` = 这份数据**是哪家给的**（`pta` / `nk`）⇒ 落在它自己那棵树上
    （`aux-pta` / `aux-nk`）。`main()` 按榜单文件的**形状**定，不靠清单里的声明。
    """
    slug = contest['slug']
    series, mid = layers_of(contest)
    m = stats['meta']

    crate = Crate(source_id=source_id or f"pta-{slug}",
                  label=stats.get('label') or LABEL, platform=tree_source,
                  kind='board')      # 权威榜单（投影里排在脚本来源之前）
    # 骨架：O ─(W)aux「辅助节点」─(W)aux-<这家>
    open_tree(crate, tree_source)
    parent = series_key(series['id'])
    crate.series(platform_key(), parent, name=series.get('name') or series['id'])
    if mid:
        ck_parent = mid_key(series['id'], mid['id'])
        crate.series(parent, ck_parent, name=mid.get('name') or mid['id'])
    else:
        ck_parent = parent

    ck = contest_key(slug)
    # 性质：**榜单在 PTA 还是牛客，与"这场比赛是哪家的"无关** ——
    # 这个适配器出的 C 全是清单里的 XCPC 场次（`series`/`mid` 来自清单），
    # 所以大类恒为 `xcpc`、小类只认 1:1 的 icpc/ccpc，年份取清单 mid。
    # 判据全文见 `xcpc_common.xcpc_nature()`。
    #
    # ⚠️ **不要**因为 `tree_source == 'nk'`（这份榜是牛客形状）就把大类写成 `nk`：
    #    `nk` 那个大类留给"牛客自己办的赛"（01 nk 那条流水线出的多校/练习赛）。
    #    这里只是**数据从牛客来**，比赛本身是 XCPC 的（省赛/邀请赛常挂牛客）。
    #
    # PTA / 牛客给的**只有"能看榜的那一页"** —— 类别如实声明为 `board`。
    # 爬取层只声明类别、不写 `link`（"数据爬取部分
    # 不应该有『存在多值时排除一些值』的逻辑"），那是应用层的事。
    crate.contest(ck_parent, ck, name=contest.get('name') or m['name'],
                  contestTime=m['startAt'],
                  **xcpc_nature(series, mid, contest.get('name') or '', channel=tree_source,
                                held_time=str(m.get('startAt') or '')),
                  **link_kinds(('board', stats.get('board_link'))))

    # 题目：**以榜单的题目清单为准**（PTA 的 label 就是题号）
    for pid, letter in sorted(stats['letters'].items(), key=lambda kv: kv[1]):
        if not letter:
            continue
        crate.problem(ck, problem_key(slug, letter), problem_id=letter,
                      ratio=stats['ratios'].get(pid) or None)
    return crate


# ================================================================
# 牛客榜单（`01 nk/lib/nk_rank_stats.py` 的产出）—— 形状不同，单独解析
#
# 为什么同一个适配器要认两种榜单：**省赛/邀请赛可能挂在牛客上**，
# 而那两场在 xcpc 树里（xcpcio 没收录、rankland 索引也没有每题过队数）。
# 口径："nk/hdu 与 xcpc 完全不交" ⇒ **不新增 nk 适配器**，
# 而是把"榜单数据"当成一个可替换的输入源 —— 来源名如实写成 `xcpc-nk-<slug>`。
# ================================================================

def nk_board_link(cid) -> str:
    """
    牛客榜单链接。

    ⚠️ 实测：牛客**没有**独立的榜单路由 —— 逐个探过
    `/acm/contest/rank/<cid>`、`/acm/contest/rank/single/<cid>`、
    `/acm/contest/scoreboard/<cid>`，服务端一律返回"页面找不到了"（10489 字节的 404 壳），
    `/acm/contest/<cid>/rank` 被当成题号 `rank`；比赛页 HTML 里也没有"排行榜"的 `<a>`。
    榜单是比赛页上的一个**前端标签**。

    ⚠️ 用 **`#rank` 锚点**（"格式是 `…/contest/<cid>#rank`"）——
    只给裸比赛页链接的话，点进去停在题目列表，还要自己找榜单标签。
    （`01 nk` 自己的适配器也是这个格式，两边必须一致。）
    """
    cid = str(cid or '').strip()
    return f'https://ac.nowcoder.com/acm/contest/{cid}#rank' if cid else ''


def analyze_nk(raw: dict) -> dict:
    """
    牛客 `nk_rank_stats.json` → 与 `analyze()` **同形**的统计。

    该文件已经算好了每题 ratio（`problems[].{letter, solvedTeams, ratio}`），
    这里只做搬运；`complete != True` 时**不写 ratio**（分母不全 = 数字偏高，宁可不给）。

    `ratios` / `board_link` 两个键就是"同形"的全部要求 —— `build()` 只认它们，
    所以本函数**不做任何按平台的 if**，上层也不需要知道榜单来自哪个平台。
    """
    if not isinstance(raw, dict) or 'problems' not in raw:
        raise ValueError('不像牛客 rank_stats（缺 problems）—— 用 nk_rank_stats.py 生成')
    complete = bool(raw.get('complete'))
    letters, ratios = {}, {}
    for p in (raw.get('problems') or []):
        letter = norm_letter(p.get('letter'))
        if not letter:
            continue
        pid = str(p.get('pid') or letter)
        letters[pid] = letter
        # 上游在 `complete=false` 时把 ratio 写成空串 —— 如实搬运（空 = 不给）
        ratios[pid] = '' if not complete else (str(p.get('ratio')) if p.get('ratio') else '')
    if not complete:
        print(f'   ⚠️ 牛客榜单不完整（pagesCollected={raw.get("pagesCollected")}/'
              f'pagesExpected={raw.get("pagesExpected")}）—— 不写 ratio')
    effective = int(raw.get('effectiveTeams') or 0)
    return {
        'meta': {
            'id': str(raw.get('contestId') or ''),      # 用来拼榜单链接
            'name': '',                                  # 名字以场次清单为准
            'startAt': raw.get('beginTime') or '',       # 已是 `YYYY.MM.DD HH:MM`
        },
        'effectiveTeams': effective,
        'teams': int(raw.get('teamCount') or 0),
        'letters': letters,
        'ratios': ratios,
        'board_link': nk_board_link(raw.get('contestId')),
        'problem_count': len(letters),
        'complete': complete,
        'label': '牛客榜单',
        'src': raw.get('_path', ''),
    }


# ================================================================
# CLI
# ================================================================

def main(argv):
    ap = argparse.ArgumentParser(description='PTA / 牛客榜单 → crate 片段')
    ap.add_argument('slug', nargs='?', help='场次 slug（清单里的）')
    ap.add_argument('-o', '--output', default='', help='输出路径；默认 cache/crate_<slug>_<kind>.json')
    ap.add_argument('--file', default='', help='临时指定榜单文件（默认用清单里的）')
    ap.add_argument('--manifest', default='', help='换一份场次清单')
    ap.add_argument('--source-id', default='',
                    help='来源 id（默认 xcpc-<kind>-<slug>，也就是 xcpc-pta-… / xcpc-nk-…）')
    ap.add_argument('--list', action='store_true', help='列出清单里的场次')
    ap.add_argument('--quiet', action='store_true')
    add_cli_args(ap, force_help='**强制重抓**（本适配器**只读本地榜单文件**（清单里那份 / `--file`）'
                                ' ⇒ 对它没有额外作用）')
    args = ap.parse_args(argv)
    configure_from(args)

    manifest = load_manifest(args.manifest)
    if args.list:
        for c in manifest['contests']:
            b = c.get('board') or {}
            print(f"   {c['slug']:<40} board={b.get('source', '?')}  {c.get('name', '')}")
        return 0
    if not args.slug:
        print('要给一个 slug（--list 看有哪些）', file=sys.stderr)
        return 2

    contest = find_contest(manifest, args.slug)
    board_entry = contest.get('board') or {}
    board_src = board_entry.get('source') or ''
    if board_src not in ('pta', 'nk'):
        print(f"⚠️ 清单里 {args.slug} 的 board 是 {board_src!r}（不是 pta/nk），"
              '本适配器只认这两种；继续用 --file 指定也可以', file=sys.stderr)

    path = resolve(args.file or board_entry.get('file', ''))
    if not path or not os.path.isfile(path):
        print(f'❌ 找不到榜单文件：{path}', file=sys.stderr)
        return 1

    # ---- 形状自动识别：PTA（xcpcRankings）还是牛客（problems + ratio）----
    raw = read_raw(path)
    if 'xcpcRankings' in raw:
        kind, stats = 'pta', analyze(raw)
    elif 'problems' in raw:
        kind, stats = 'nk', analyze_nk(raw)
    else:
        print(f'❌ 认不出这份榜单的形状（{path}）：'
              '既没有 xcpcRankings（PTA）也没有 problems（牛客）', file=sys.stderr)
        return 1
    lines = (report(stats) if kind == 'pta' else
             [f"   有效队伍 {stats['effectiveTeams']} / 榜上 {stats['teams']}"
              f" ｜ 题目 {stats['problem_count']}"
              f" ｜ 完整 {'是' if stats['complete'] else '否（不写 ratio）'}"])
    if not args.quiet:
        print(f'📊 {kind.upper()} 榜单 → {args.slug}')
        print('\n'.join(lines))

    # ---- 空榜单护栏 ----
    # 一道题都没有 = 文件抓错了（存成别的接口/别的场次，或只存了半页）。
    # 这时**不能**照常产出：会建出一个没有题目的空比赛，你还以为导成功了。
    if not stats['letters']:
        print(f'❌ 这份榜单里一道题都没有（{path}）—— 文件是不是抓错了？\n'
              '   PTA 要有 xcpcRankings.problemInfoByProblemSetProblemId，'
              '牛客要有 problems —— 一道题都没有说明这不是某场比赛的完整榜单。',
              file=sys.stderr)
        return 1
    crate = build(contest, stats,
                  source_id=args.source_id or f'{kind}-{args.slug}',
                  tree_source=kind)      # 榜单文件是**谁**的形状 ⇒ 就落在谁那棵树上
    out = args.output or os.path.join(CACHE, f'crate_{args.slug}_{kind}.json')
    crate.save(out)
    issues = validate_crate(crate.to_dict())
    print(f'\n✅ {rel(out)}   {crate.summary()}')
    if issues:
        print(f'❌ 校验问题 {len(issues)}：')
        for it in issues:
            print('   •', it)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
