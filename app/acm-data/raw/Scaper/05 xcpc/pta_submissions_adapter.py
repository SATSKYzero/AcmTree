#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
PTA 提交记录 → crate 片段（**只出 R**）

为什么需要它
---------------------------
PTA 榜单只给"某队在某题是否通过"，**没有逐条提交**；而应用里
`status2`（过没过）/`acTime`/`lastSubmitTime` 全部由 **R 子节点**推导。
所以不带 R 的话，比赛结束后那棵树只能显示"未使用" —— "各自补题情况"就成了空的。

数据来源
--------
PTA「提交记录」接口的响应（浏览器 F12 → Network，**你自己那队**那一份），存成 JSON 即可：
    { "total": 17, "submissions": [ {submissionId, submitAt, status, problemSetProblemId}, … ],
      "teamInfo": {"teamName": "TEAM0", …} }

**账户字段（队名）从哪来** —— 先算出**名单**（全取），再让这份文件"对号入座"：
    ① `--team A,B`／环境变量 `PTA_TEAM`（主脚本 `xcpc_pipeline.py --team` 就是这个）
       —— 人显式指定的，**盖过文件里的队名**；
    ② **`me.json` 账户里的映射** —— 所有账户声明过的 `pta:<赛季> : 队伍`，一个都不吞
       （正好本场赛季的排前面；应用「设置 → 🔑 账户/名册」写的就是这个）；
    ③ `me.json` 顶层 `pta.teamName` / 账户里的 `pta` 字段（老写法，冷备）。
    这份文件用哪支队（提交是"按队"的，一份文件只属于一支队）：
       · 文件里的 `teamInfo.teamName` **在名单里** ⇒ 用它（正常情形）；
       · 文件里没有队名 ⇒ 取名单第一支（有多支时提示一句）；
       · 文件里的队名**不在名单里** ⇒ 仍然按文件写 + 警告（"这份文件是不是别人的？"）。
    最后才是"名单和文件都没有" ⇒ 不写线索（导入后全是客观值）。
适配器会给每条 R 打上 `账户线索 = {source: 'pta:<赛季>', field: '队伍', value: <队名>}`，
应用拿它去查账户注册表里的映射（`pta : 队伍 = TEAM0`）—— 于是"这条提交是谁的"就认出来了。

**队伍成员（真名）同理**：谁是你队友由你声明 —— 名册里几条映射，`source` 写 `pta:<赛季>`、
**字段那一格写"成员"**、值写 **`<队名>/<真名>`**（一人一条，队名写在值里 —— 同一赛季
两支队的名单才不会混起来）。文件里的 `teamInfo.memberNames` 只用来**核对/显示**，
不一致时以你声明的为准；成员**不进包**（crate 里没有"真名"这个字段，队友在包里的身份
是他自己的平台账号）—— 所以它不是"账户线索"，不参与三元组匹配
（对拍 `PLATFORM_CLUES.pta.field` 的那张表只管线索）。

⚠️ 时间口径：原始 `submitAt` 是 **UTC**（`…09:59:59Z`），这里统一换算到 +08:00。
（不要拿 `PTA_team_submissions_with_label.json`：那份把 +08 的时间标成了 Z，
直接用会整体偏 8 小时。）

用法
----
    python pta_submissions_adapter.py icpc2026preliminary-2
    python pta_submissions_adapter.py icpc2026preliminary-2 --team TEAM0
    python pta_submissions_adapter.py icpc2026preliminary-2 -o out.json
    python pta_submissions_adapter.py icpc2026preliminary-2 --file "…/team_submissions.json"
    python pta_submissions_adapter.py --list
"""

from __future__ import annotations

import argparse
import os
import sys

sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, 'lib'))

from xcpc_common import (add_crate_path,  # noqa: E402
    CACHE, find_contest, load_manifest, norm_letter, open_tree, problem_key,
    read_json, rel, resolve, submission_key,
)

add_crate_path()

from crate import SUBMIT_DURING, Crate, _s, normalize_status, to_cst, validate_crate  # noqa: E402
from me import pta_members_source, pta_teams_source  # noqa: E402  （`xcpc_common` 已把 `Scaper/lib` 挂上）
from read_modes import add_cli_args, configure_from  # noqa: E402

LABEL = 'PTA 提交'
SOURCE = 'pta'          # 它那棵树：`aux-pta`

# PTA 的判题枚举 → 应用的状态值（`crate.normalize_status` 只认不带下划线的写法）
STATUS_MAP = {
    'ACCEPTED': 'AC',
    'WRONG_ANSWER': 'WA',
    'TIME_LIMIT_EXCEEDED': 'TLE',
    'MEMORY_LIMIT_EXCEEDED': 'MLE',
    'RUNTIME_ERROR': 'RE',
    'OUTPUT_LIMIT_EXCEEDED': 'OLE',
    'COMPILATION_ERROR': 'CE',       # `STATUS_OPTIONS` 里有 CE ⇒ 直通（不再落 '-'）
    'PRESENTATION_ERROR': 'PE',
    'SYSTEM_ERROR': 'SE',
    'PARTIAL_ACCEPTED': 'P.AC',
    'PENDING': 'PD',
    'JUDGING': 'JG',
}


def label_map(board_path: str) -> dict:
    """
    `problemSetProblemId` → 题号（A/B/C…）。

    从**榜单文件**里取（`xcpcRankings.problemInfoByProblemSetProblemId`）——
    提交数据本身只有 id，题号在榜首那棵树里。
    """
    if not board_path or not os.path.isfile(board_path):
        return {}
    data = read_json(board_path)
    info = ((data.get('xcpcRankings') or {}).get('problemInfoByProblemSetProblemId') or {})
    return {pid: _s((v or {}).get('label')) for pid, v in info.items()}


def load_submissions(path: str) -> tuple[list[dict], dict]:
    """读提交文件 → (提交数组, teamInfo)"""
    data = read_json(path)
    if isinstance(data, list):
        return [x for x in data if isinstance(x, dict)], {}
    subs = data.get('submissions') if isinstance(data, dict) else None
    if not isinstance(subs, list):
        raise ValueError(f'{path} 里没有 submissions 数组')
    team = data.get('teamInfo') if isinstance(data.get('teamInfo'), dict) else {}
    return [x for x in subs if isinstance(x, dict)], team


def build(slug: str, records: list[dict], labels: dict, clue: dict | None) -> tuple[Crate, list[str]]:
    crate = Crate(source_id=f'pta-{slug}', label=LABEL, platform=SOURCE)
    # 骨架：O ─(W)aux「辅助节点」─(W)aux-pta（与榜单同一个 W）
    open_tree(crate, SOURCE)
    warns = []
    seen = set()
    for r in records:
        sid = _s(r.get('submissionId'))
        if not sid:
            warns.append('有一条缺 submissionId，跳过')
            continue
        if sid in seen:
            warns.append(f'提交 {sid} 在文件里出现多次，已去重')
            continue
        seen.add(sid)

        letter = norm_letter(r.get('题号') or labels.get(_s(r.get('problemSetProblemId'))))
        if not letter:
            warns.append(f'提交 {sid} 认不出题号（problemSetProblemId 不在榜单里），跳过')
            continue

        raw_status = _s(r.get('status'))
        status = STATUS_MAP.get(raw_status, raw_status)
        extra = {}
        if clue and clue.get('value'):
            # 只有"本队那一份提交记录"才有队名 —— 如实搬运，不做判断
            extra['账户线索'] = {'source': clue['source'], 'field': clue['field'], 'value': clue['value']}
        crate.submission(
            problem_key(slug, letter),
            submission_key(slug, 'pta', sid),
            status=normalize_status(status),
            time=to_cst(r.get('submitAt')),
            link=_s(r.get('link')),
            # **PTA 的提交一定是赛时**——
            # 数据来自榜单里的"本队逐条提交"，而榜单只收录**比赛时段内**的提交
            # （赛后补题不会进这份榜）。所以这里不用判，直接写死。
            submitKind=SUBMIT_DURING,
            **extra,
        )
    return crate, warns


def clue_of(contest: dict, entry: dict, team: dict, picked_team: str = '') -> dict:
    """
    这一场的账户线索。

    队名（`value`）的来源，优先级从高到低（见文件头"账户字段从哪来"）：
        ① `picked_team` —— `main()` 从**名单**里替这份文件选好的那支
           （名单 = `--team`/`PTA_TEAM`，否则 `me.json` 账户里声明的所有 PTA 队名）；
        ② 清单里本场条目的 `accountClue`（字符串 = 只换队名；对象 = 可连 source/field 一起换）；
        ③ 提交文件里的 `teamInfo.teamName`（最后兜底）。

    ⚠️ **重名问题**：队名会年复一年重用
    （`TEAM0` 打了 3 届、队友换了两批）。而应用侧是按
    **`(source, field, value)` 三元组全等**匹配的 —— 两条映射声明同一个三元组
    会被判成**冲突、谁都不认领**（`core/accounts.js` 的 `resolveAccount`）。
    所以线索必须**唯一确定一个账户**，而原始数据里唯一能认出"是谁"的只有队名
    （PTA 没有"提交者"列），必须**把区分维度放进 source**：

        source = `pta:<mid>`   例如 `pta:icpc2026`（同一个赛季共用，跨赛季互不干扰）
        field  = `队伍`
        value  = `TEAM0`       ← 保持原值，便于和原始数据核对

    清单里可以用 `accountClue` 覆盖：
        "accountClue": { "source": "pta:icpc2026", "field": "队伍", "value": "TEAM0" }
    只写字符串则等价于"只换 value（队名）"，source 仍按上面的规则推导。
    """
    declared = entry.get('accountClue')
    file_team = _s(team.get('teamName'))
    given = _s(picked_team)
    if isinstance(declared, dict):
        source = _s(declared.get('source')) or f'pta:{season_of(contest)}'
        return {
            'source': source,
            'field': _s(declared.get('field')) or '队伍',
            'value': given or _s(declared.get('value')) or file_team,
        }
    if isinstance(declared, str) and declared.strip() and not given:
        given = declared.strip()
    return {'source': f'pta:{season_of(contest)}', 'field': '队伍', 'value': given or file_team}


def season_of(contest: dict) -> str:
    """
    PTA 的**账户线索命名空间**：优先用清单里的 `mid.id`（年份那层，如 `icpc2026`），
    没有 mid 就退回 slug（最细粒度：一场一个命名空间）。

    为什么用 mid 而不是 slug：**一届（一年）之内队名代表同一批人**，
    而跨届会换人 —— 正好是这个粒度；要更细就把 `accountClue.source` 显式写成 slug。

    ⚠️ **与 `crate.season_of` 撞名但不是一回事**（别"顺手合并"）：
       * `crate.season_of(year)` → 年份变**两位**（`2026` → `26`），给 HDU/牛客那套 `hdu:26` 用；
       * 本函数 `season_of(contest)` → 从一个**比赛对象**取命名空间（`icpc2026`），PTA 专用。
    """
    mid = contest.get('mid') or {}
    return _s(mid.get('id')) or _s(contest.get('slug'))


def main(argv):
    ap = argparse.ArgumentParser(description='PTA 提交 → crate 片段（只出 R）')
    ap.add_argument('slug', nargs='?')
    ap.add_argument('-o', '--output', default='')
    ap.add_argument('--file', default='', help='临时指定提交 JSON')
    ap.add_argument('--team', default='',
                    help='你的队伍名，**逗号分隔算多支**（默认取 me.json 账户里声明的那些，'
                         '见 me.pta_teams_source()；主脚本 --team 也走这里）。'
                         '没声明时用提交文件里的 teamInfo.teamName')
    ap.add_argument('--manifest', default='')
    ap.add_argument('--list', action='store_true')
    add_cli_args(ap, force_help='**强制重抓**（本适配器**只读本地提交 JSON**（清单里那份 / `--file`）'
                                ' ⇒ 对它没有额外作用）')
    args = ap.parse_args(argv)
    configure_from(args)

    manifest = load_manifest(args.manifest)
    if args.list:
        for c in manifest['contests']:
            subs = [s.get('source') for s in (c.get('submissions') or [])]
            print(f"   {c['slug']:<38} 提交来源: {','.join(x for x in subs if x) or '-'}")
        return 0

    if not args.slug:
        print('要给一个 slug', file=sys.stderr)
        return 2
    contest = find_contest(manifest, args.slug)

    entry = next((s for s in (contest.get('submissions') or [])
                  if (s.get('source') or '') == 'pta'), None)
    if not entry:
        print(f'ℹ️ 清单里 {args.slug} 没有 pta 提交来源，跳过')
        return 0

    path = resolve(args.file or entry.get('file', ''))
    if not path or not os.path.isfile(path):
        print(f'❌ 找不到提交文件：{path}', file=sys.stderr)
        return 1

    board_path = resolve((contest.get('board') or {}).get('file', ''))
    labels = label_map(board_path)
    records, team = load_submissions(path)

    # 队名**名单**（全取）：主脚本输入（--team / PTA_TEAM）> me.json 账户映射
    #   （`pta:<赛季> : 队伍`，本场赛季的排前）> me.json 的 pta.teamName > 账户的 pta 字段。
    #   一份提交文件只属于一支队 ⇒ 从名单里对号入座（见下），文件里的 teamInfo 是最后兜底。
    teams, team_src = pta_teams_source(args.team, season_of(contest))
    file_team = _s(team.get('teamName'))
    file_members = [str(x).strip() for x in (team.get('memberNames') or []) if str(x).strip()]
    explicit = team_src == '主脚本/环境变量'
    if teams and explicit:
        picked, how = teams[0], '按你显式指定的（盖过文件里的队名）'
    elif file_team and file_team in teams:
        picked, how = file_team, '文件里的队名在名单里'
    elif file_team:
        picked, how = file_team, '文件里的队名（不在你的名单里）'
    elif teams:
        picked, how = teams[0], '文件里没写队名，取名单第一支'
    else:
        picked, how = '', '认不出'
    # 成员名单按**这份文件那支队**取（成员声明时队名写在值里：`<队名>/<真名>`）
    members_by_team, member_src, member_notes = pta_members_source(season_of(contest), picked)
    clue = clue_of(contest, entry, team, picked)
    print(f'📊 PTA 提交 → {args.slug}')
    print(f'   提交 {len(records)} 条 | 题号表 {len(labels)} 项（来自 {os.path.basename(board_path)}）')
    if teams:
        print(f'   队名名单（{len(teams)} 支，来源：{team_src}）：{"、".join(teams)}'
              f' → 这份文件用「{picked}」（{how}）')
    if file_team and teams and file_team not in teams:
        print(f'   ⚠️ 提交文件里的队名（{file_team}）不在你的名单里 ——'
              f' 这份文件是不是别人的？或者名单缺了它（应用「设置 → 🔑 账户/名册」里补一条 '
              f'`pta:<赛季> : 队伍 = {file_team}`）')
    if not file_team and len(teams) > 1:
        print(f'   ℹ️ 文件里没写队名，名单有 {len(teams)} 支 ⇒ 按第一支「{picked}」写；'
              f' 不对就用 --team 指定')
    if explicit and file_team and file_team != picked:
        print(f'   ⚠️ 提交文件里的队名（{file_team}）和你指定的（{picked}）不一样 ——'
              f' 线索按你指定的写；若这份文件其实是别的队的，请换文件')
    # 队伍成员（**只核对/显示，不进包**）：只认**这份文件那支队**的名单（成员连队一起声明，
    # 见 me.pta_members_source：值的形状是 `<队名>/<真名>`），并按赛季分开说 ——
    # 往届的人混进本季名单，同样看不出归属。
    season = season_of(contest)
    pairs = members_by_team.get(picked, []) if picked else []
    here = [n for n, s in pairs if s in (f'pta:{season}', 'pta')]
    past = [(n, s) for n, s in pairs if s not in (f'pta:{season}', 'pta')]
    for note in member_notes:
        print('   ⚠️', note)
    if here or past:
        line = f'   队伍成员（{member_src}）：'
        if here:
            line += '本季 ' + '、'.join(here)
        if past:
            line += ('；' if here else '') + '往届 ' + '、'.join(f'{n}（{s}）' for n, s in past)
        others = [f'{t}：{"、".join(n for n, _s in v)}' for t, v in members_by_team.items()
                  if v and t != picked]
        if others:
            line += f' ｜ 另有 {"；".join(others)}'
        print(line)
        if file_members and sorted(file_members) != sorted({n for n, _s in pairs}):
            print(f'   ℹ️ 提交文件里写的是：{"、".join(file_members)}（以你声明的为准）')
    elif picked and members_by_team:
        print(f'   队伍成员：名单里没有「{picked}」这一队的人（声明时把队名写进值：'
              f' `{picked}/<真名>`）')
    elif file_members:
        print(f'   队伍成员（提交文件里的 teamInfo.memberNames）：{"、".join(file_members)}')
        print('      ↳ 这是**数据文件自带的真名**；想让它由你声明，就在名册里加几条 '
              f'`{picked or "<队名>"}/<真名>` 的成员映射（应用「设置 → 🔑 账户/名册」里能加）')
    if clue.get('value'):
        print(f"   账户线索：{clue['source']} : {clue['field']} = {clue['value']}")
        print(f"   （应用里要有一条一样的映射，且只能被一个账户声明）")
    else:
        print('   账户线索：无 —— 这条链上认不出"是谁"，导入后全是客观值')

    crate, warns = build(args.slug, records, labels, clue)
    out = args.output or os.path.join(CACHE, f'crate_{args.slug}_pta_subs.json')
    if not records:
        if os.path.isfile(out):
            os.remove(out)
        print('ℹ️ 0 条 → 不产出片段')
        return 0
    crate.save(out)
    issues = validate_crate(crate.to_dict())
    soft = [i for i in issues if '父节点' in str(i)]
    hard = [i for i in issues if '父节点' not in str(i)]
    print(f'✅ {rel(out)}   {crate.summary()}')
    if soft:
        print(f'   ℹ️ {len(soft)} 条的父题目在**榜单片段**里（只出 R 的片段都这样，合并时统一校验）')
    for w in warns:
        print('   ⚠️', w)
    if hard:
        print(f'❌ 校验问题 {len(hard)}：')
        for it in hard:
            print('   •', it)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
