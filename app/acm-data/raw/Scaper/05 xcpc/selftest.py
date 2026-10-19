#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
XCPC 链路的**离线自测**（不联网、不动你的数据）

为什么必须有：**extKey 一旦导入就不能改**（改了 = 新身份 = 下次导入变重复节点）。
而这条链路上"身份"由三处拼出来（`lib/xcpc_common.py` 的 key 函数、各适配器、
清单里的 slug/层级），任何一处被改歪都不会报错 —— 只会**静默产出另一棵树**。
所以这里用最小夹具把下面这些钉死：

  1. extKey 逐字符正确（W/S/S/C/P/R 六种）
  2. PTA 的 ratio = 通过队伍数 / 有效队伍数 × 100（含与被测数据无关的口径）
  3. srk 的两种角色：titles 只补题名/链接、board 才算 ratio
  4. QOJ / CF 只出 R，提交 key 带来源
  5. 各来源片段都过 `crate.validate_crate`（硬错误为 0）
  6. `crate-merge.mjs` 合并后：容器只出现一次、记录数对得上

用法：
    python selftest.py            # 全部通过 → 退出码 0
    npm run crate:xcpc:selftest
"""

from __future__ import annotations

import json
import io
import os
import re
import subprocess
import sys

sys.dont_write_bytecode = True

# ★ 本进程 stdio 钉 UTF-8（2026-10-18）：关掉 Windows「UTF-8 Beta」后 ACP=936，这套自测打 `✔/✘`
#   会 UnicodeEncodeError。与 `app/scripts/utf8_stdio.py` 同一句话（两个根各一份，别无第三份）。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding='utf-8', errors='replace')
    except (AttributeError, ValueError, OSError):
        pass

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, 'lib'))

from xcpc_common import CACHE, GYM_WHITELIST, REPO  # noqa: E402

FAILED: list[str] = []
PASSED = 0


def check(name: str, got, want):
    global PASSED
    # ⚠️ 别直接用 `==`：`False == 0`、`0.0 == 0` 都为真 ⇒ "返回 0"那种断言
    #    分不出真 0 与 False（审计点名）。bool 只跟 bool 比，其余照旧。
    if isinstance(got, bool) != isinstance(want, bool):
        same = False
    else:
        same = got == want
    if same:
        PASSED += 1
        print(f'  ✔ {name}')
    else:
        FAILED.append(name)
        print(f'  ✘ {name}\n      期望 {want!r}\n      实际 {got!r}')


def check_true(name: str, ok: bool, detail: str = ''):
    global PASSED
    if ok:
        PASSED += 1
        print(f'  ✔ {name}')
    else:
        FAILED.append(name)
        print(f'  ✘ {name}{"  " + detail if detail else ""}')


# ================================================================
# 夹具（最小、手算得出答案）
# ================================================================

SLUG = 'test2026preliminary-x'
# 各渠道那棵树的 W 键（`aux-<渠道>`，见 `xcpc_common.AUX_TREES`）——
# **没有"合并树"**：每个渠道各自一棵，收在 W `aux`（辅助节点）下。
PTA, NK, SRK = 'aux-pta', 'aux-nk', 'aux-srk'
CONTEST = {
    'slug': SLUG,
    'name': '测试赛',
    'series': {'id': 'icpc', 'name': 'ICPC'},
    'mid': {'id': 'test2026', 'name': 'ICPC 2026 (测试)'},
}


def fixture_pta() -> dict:
    """2 道题、3 支有效队伍：A 两队过（66.67%）、B 一队过（33.33%）"""
    details = {
        't1': {'rank': 1, 'detailsByProblemSetProblemId': {
            'p1': {'acceptTime': 10}, 'p2': {'acceptTime': -1}}},
        't2': {'rank': 2, 'detailsByProblemSetProblemId': {
            'p1': {'acceptTime': 20}, 'p2': {'acceptTime': -1}}},
        't3': {'rank': 3, 'detailsByProblemSetProblemId': {
            'p1': {'acceptTime': -1}, 'p2': {'acceptTime': 30}}},
        't4': {'rank': 4, 'detailsByProblemSetProblemId': {
            'p1': {'acceptTime': -1}, 'p2': {'acceptTime': -1}}},   # 0 题过 → 不算有效
    }
    return {
        'competitionBasicInfo': {
            'id': '999', 'name': '测试网络赛 - 第 X 场', 'type': 'XCPC',
            'startAt': '2026-09-12T05:00:00Z', 'endAt': '2026-09-12T10:00:00Z',
            'freezeAt': '2026-09-12T09:00:00Z', 'hideScoreboard': True,
        },
        'xcpcRankings': {
            'problemInfoByProblemSetProblemId': {
                'p1': {'label': 'A', 'acceptCount': 2, 'submitCount': 9},
                'p2': {'label': 'B', 'acceptCount': 1, 'submitCount': 5},
            },
            'rankings': list(details.values()),
        },
    }


def fixture_nk(complete: bool = True) -> dict:
    """
    牛客 `nk_rank_stats.json` 的最小夹具（`01 nk/lib/nk_rank_stats.py` 的产出）。

    这一份**自己就带好了每题 ratio**（牛客是算完再给的），所以适配器只做搬运 ——
    自测要钉的正是"搬运不改口径"以及"complete=false 时宁可不给"。
    """
    return {
        'source': 'cache/nk/nk_cid4242_rank.json',
        'contestId': '4242',
        'beginTime': '2026.05.31 09:00', 'endTime': '2026.05.31 14:00',
        'effectiveTeams': 4, 'teamCount': 6, 'zeroSolveTeams': 2,
        'pagesCollected': 2, 'pagesExpected': 2, 'complete': complete,
        'problems': [
            {'pid': 'p1', 'letter': 'a', 'solvedTeams': 2, 'submitCount': 9, 'ratio': '50.00'},
            {'pid': 'p2', 'letter': 'B', 'solvedTeams': 0, 'submitCount': 3, 'ratio': '0.00'},
        ],
    }


def fixture_srk() -> dict:
    return {
        'type': 'general', 'version': '0.3.9',
        'contest': {'title': {'zh-CN': '测试网络赛 - 第 X 场', 'fallback': 'Test'},
                    'startAt': '2026-09-12T13:00:00+08:00'},
        'problems': [
            {'alias': 'A', 'title': 'All Closed', 'link': 'https://codeforces.com/gym/999/problem/A',
             'statistics': {'accepted': 2, 'submitted': 9}},
            {'alias': 'B', 'title': 'Island', 'link': 'https://codeforces.com/gym/999/problem/B',
             'statistics': {'accepted': 1, 'submitted': 5}},
        ],
        'rows': [
            {'user': {'id': '1', 'name': 'T1'}, 'statuses': [
                {'result': 'AC'}, {'result': 'WA'}]},
            {'user': {'id': '2', 'name': 'T2'}, 'statuses': [
                {'result': 'AC'}, None]},
        ],
    }


def fixture_qoj() -> list:
    return [
        {'提交ID': '555', '题号': 'A', '题目链接': 'https://qoj.ac/contest/4113/problem/1',
         '题目名称': 'All Closed',
         '提交链接': 'https://qoj.ac/submission/555', '结果': 'AC',
         '提交者': 'someone', '提交时间': '2026-09-13 22:06:07'},
        {'提交ID': '556', '题号': 'B', '题目链接': 'https://qoj.ac/contest/4113/problem/2',
         '题目名称': 'Island',
         '提交链接': 'https://qoj.ac/submission/556', '结果': '答案错误',
         '提交时间': '2026-09-13 22:10:00'},   # 缺 提交者：**没有**线索
        {'提交ID': '557', '题号': 'A', '题目链接': 'https://qoj.ac/contest/9999/problem/1',
         '提交链接': 'https://qoj.ac/submission/557', '结果': 'AC',
         '提交时间': '2026-09-13 22:11:00'},   # 缺 提交者：**没有**线索（不是空线索）
        # ★ `v9.4.15`（用户 2026-10-15："qoj 的 Ac 时间有问题"）：场次页对**参与窗口内**的提交
        #   给的是**相对时间**（`00:31:01` = 开赛后第 31 分钟），只有全局按人列表页才给绝对时刻。
        #   口径（用户同日）：**只有相对时间就当没有** ⇒ R 不写 time，但**不算校验错**
        #   （生成端把它记进 `crate.relative_only_subs`，`validate_crate` 显式放行）。
        {'提交ID': '558', '题号': 'B', '题目链接': 'https://qoj.ac/contest/4113/problem/2',
         '题目名称': 'Island',
         '提交链接': 'https://qoj.ac/submission/558', '结果': 'AC',
         '提交者': 'someone', '提交时间': '00:31:01'},
    ]


def fixture_cf() -> list:
    """3 条：两条 tester 的、一条别人的；**第一条还带一个队友**（验证多人归属）"""
    return [
        {'id': 111, 'contestId': 999, 'creationTimeSeconds': 1789189200,
         'problem': {'index': 'A', 'name': 'All Closed'}, 'verdict': 'OK',
         'author': {'members': [{'handle': 'tester'}]}},
        {'id': 112, 'contestId': 999, 'creationTimeSeconds': 1789189260,
         'problem': {'index': 'B', 'name': 'Island'}, 'verdict': 'WRONG_ANSWER',
         'author': {'members': [{'handle': 'tester'}]}},
        {'id': 114, 'contestId': 999, 'creationTimeSeconds': 1789189270,
         'problem': {'index': 'B', 'name': 'Island'}, 'verdict': 'OK',
         'author': {'members': [{'handle': 'mate'}, {'handle': 'tester'}]}},  # 队伍提交
        {'id': 113, 'contestId': 999, 'creationTimeSeconds': 1789189300,
         'problem': {'index': 'A', 'name': 'All Closed'}, 'verdict': 'OK',
         'author': {'members': [{'handle': 'someone-else'}]}},   # 别人的，应被过滤
    ]


# ================================================================
# 各段检查
# ================================================================

def keys_of(crate) -> dict:
    return {r['extKey']: r for r in crate.to_dict()['records']}


def test_extkeys(pta_crate, srk_crate, qoj_crate, cf_crate):
    print('\n[1] extKey（导入后不可改，逐字符钉死）')
    p = keys_of(pta_crate)
    # 各渠道**各自一棵树**，收在 W `aux`（辅助节点）下；
    # 键写成 `aux-<渠道>`（不带冒号）—— 第一段仍是"树身份"（`src/utils/similarity.js` 靠它
    # 跳过跨树重复），父子关系照样摆成 `aux → aux-pta`。
    check('辅助节点 W 挂根', 'aux' in p and '父extKey' not in p['aux'], True)
    check('渠道树 W 挂在辅助节点下', p[PTA]['父extKey'], 'aux')
    check('S 系列', f'{PTA}:s:icpc' in p, True)
    check('S 中间层（链式）', f'{PTA}:s:icpc:test2026' in p, True)
    check('C 比赛（slug）', f'{PTA}:c:{SLUG}' in p, True)
    check('P 题目（字母）', f'{PTA}:c:{SLUG}:p:A' in p, True)
    check('C 的父是中间层 S', p[f'{PTA}:c:{SLUG}']['父extKey'], f'{PTA}:s:icpc:test2026')
    check('中间层 S 的父是系列 S', p[f'{PTA}:s:icpc:test2026']['父extKey'], f'{PTA}:s:icpc')
    check('系列 S 的父是渠道树 W', p[f'{PTA}:s:icpc']['父extKey'], PTA)

    q = keys_of(qoj_crate)
    # QOJ 是**自己那棵树**：O─(W)qoj─(S)<QOJ 分类…>─(C)<场次 id>─(P)<题目 id>─(R)
    # S 层**严格用 QOJ 自己的分类**，不再有 `xcpc` 那一层。
    # 它不再挂到主树的题目上 —— 要不要与主树那场算同一场由判重整理页绑
    # `映射元素值` 决定，导入侧不做自动匹配。
    check('QOJ 平台 W 挂根', 'qoj' in q and '父extKey' not in q['qoj'], True)
    check('QOJ 比赛 C 按**场次 id**认', 'qoj:c:4113' in q, True)
    # C 的父必须是一条**从 qoj 逐层接上来的 S 链**（分类 id 是活的，所以只钉形状不钉具体分类）
    chain, node, ok = [], q['qoj:c:4113']['父extKey'], True
    while node != 'qoj':
        if node not in q or q[node]['节点类型'] != 'S' or node in chain:
            ok = False
            break
        chain.append(node)
        node = q[node]['父extKey']
    check('QOJ 比赛挂在**分类 S 链**上，链根是 qoj', ok and len(chain) >= 1, True)
    check('QOJ 分类层的键是分类 id（cat-<id>）',
          all(k.startswith('qoj:s:cat-') for k in chain), True)
    check('QOJ 分类 S 层带 QOJ 原文类名', all(q[k].get('name') for k in chain), True)
    check('QOJ 题目 P 按**题目 id**认', 'qoj:c:4113:p:1' in q, True)
    check('QOJ 题目挂在它那场比赛下', q['qoj:c:4113:p:1']['父extKey'], 'qoj:c:4113')
    check('QOJ 提交带场次 id 与提交 id', 'qoj:c:4113:sub:555' in q, True)
    check('QOJ 提交的父是**本包里的**题目', q['qoj:c:4113:sub:555']['父extKey'],
          'qoj:c:4113:p:1')
    check('QOJ 不碰别的树（每条键都属于 qoj 这棵）',
          any(k.split(':')[0] != 'qoj' for k in q), False)
    c = keys_of(cf_crate)
    # CF 也是**自己那棵树**：O─(W)cf─(S)cf gym─(S)xcpc─(C)<gym id>─(P)─(R)。
    # 本片段只出 R + 难度分（题名/榜单在同场的 cf_board 片段里），所以这里只钉提交键。
    check('CF 提交 key 按 gym id', 'cf:c:999:sub:111' in c, True)
    check('CF 提交的父是**本包里的**题目', c['cf:c:999:sub:111']['父extKey'],
          'cf:c:999:p:A')
    check('CF 不碰别的树（每条键都属于 cf 这棵）',
          any(k.split(':')[0] != 'cf' for k in c), False)
    check('CF 与 QOJ 的提交 ID 互不干扰（同号也算不同 key）',
          'cf:c:999:sub:555' in c, False)


def link_kinds_of(rec: dict) -> dict:
    """
    取 `链接分类` 的 `{类别: [URL]}` 视图，便于断言**语义**。

    为什么不直接比整个列：条目形状是 `{v, src}`，而 `src` 由产出点自动补
    （`Crate._normalize_link_kinds` 用包来源 id）—— 那是"形状契约"，另有专门断言钉它，
    这里只关心"哪一类、什么 URL"。
    """
    return {k: [x.get('v') for x in v] for k, v in (rec.get('链接分类') or {}).items()}


def all_link_kinds_well_formed(records) -> bool:
    """形状契约：`链接分类` 的每个条目都必须是 `{v, src}`（裸 URL 在产出点就该被归一）"""
    for r in records:
        for _kind, items in (r.get('链接分类') or {}).items():
            for one in items:
                if not (isinstance(one, dict) and one.get('v') and one.get('src')):
                    return False
    return True


def test_pta(pta_crate, stats):
    print('\n[2] PTA 榜单：口径与字段')
    p = keys_of(pta_crate)
    check('有效队伍数（至少过 1 题）', stats['effectiveTeams'], 3)
    check('A 的 ratio = 2/3', p[f'aux-pta:c:{SLUG}:p:A']['ratio'], '66.67')
    check('B 的 ratio = 1/3', p[f'aux-pta:c:{SLUG}:p:B']['ratio'], '33.33')
    check('题号写进 problemId', p[f'aux-pta:c:{SLUG}:p:A']['problemId'], 'A')
    check('清单里的 name 覆盖榜单名（清单是"自建树"的权威）',
          p[f'aux-pta:c:{SLUG}']['name'], '测试赛')
    check('UTC 时间已换算到 +08:00', p[f'aux-pta:c:{SLUG}']['contestTime'], '2026.09.12 13:00')
    # 爬取层**只声明类别**，不再自己写 link ——
    # 归属规则（按类别优先级挑缓存值）**只在应用层一处**（`plan.js`）。
    check('PTA 榜单页记成 board 类别', link_kinds_of(p[f'aux-pta:c:{SLUG}']),
          {'board': ['https://pintia.cn/rankings/999']})
    check('爬取层不写 C 的 link', 'link' in p[f'aux-pta:c:{SLUG}'], False)
    # 形状契约：适配器写的是裸 URL，`Crate._add` 在**产出点**归一成 `{v, src}`
    #（"数据处理的逻辑中一个特判都没有" —— 归一放产出点，读取端走直路）
    check('链接分类条目形状统一（都是 {v, src}）',
          all_link_kinds_well_formed(pta_crate.to_dict()['records']), True)


def test_nk(nk_crate, nk_stats, incomplete_stats):
    """
    牛客榜单：**与 PTA 同一个适配器**（省赛/邀请赛挂在牛客上就用它）。

    这里钉三件事，都是踩过或差点踩到的：
      1. ratio **原样搬运**（牛客已经算好，这里不许再除一遍分母）；
      2. `complete=false` → **一道题都不给 ratio**（分母不全 = 数字偏高）；
      3. 牛客比赛页记成 **board** 类别（爬取层不写 link，见 test_pta）。
    """
    print('\n[2b] 牛客榜单（同一个适配器，形状自动识别）')
    k = keys_of(nk_crate)
    check('有效队伍数 / 榜上队伍数', (nk_stats['effectiveTeams'], nk_stats['teams']), (4, 6))
    check('ratio 原样搬运（不再是 通过数/有效数 的除法）',
          (k[f'aux-nk:c:{SLUG}:p:A']['ratio'], k[f'aux-nk:c:{SLUG}:p:B']['ratio']),
          ('50.00', '0.00'))
    check('题号归一化（小写 a → A）',
          (k[f'aux-nk:c:{SLUG}:p:A']['problemId'], k[f'aux-nk:c:{SLUG}:p:B']['problemId']),
          ('A', 'B'))
    check('开始时间原样用牛客的', k[f'aux-nk:c:{SLUG}']['contestTime'], '2026.05.31 09:00')
    # ⚠️ 用 **`#rank` 锚点**（格式是 `…/contest/<cid>#rank`；
    #    裸比赛页会停在题目列表、还要自己找榜单标签）
    check('牛客比赛页记成 board 类别（带 #rank 锚点）',
          link_kinds_of(k[f'aux-nk:c:{SLUG}']),
          {'board': ['https://ac.nowcoder.com/acm/contest/4242#rank']})
    check('来源 id 由调用方给，如实写成 xcpc-nk-<slug>',
          nk_crate.to_dict()['source']['id'], f'nk-{SLUG}')
    check('不完整榜单：ratio 一律为空',
          set(incomplete_stats['ratios'].values()), {''})


def test_srk_titles(titles_crate, board_crate):
    print('\n[3] srk 的两种角色')
    t = keys_of(titles_crate)
    check('titles：补题名', t[f'aux-srk:c:{SLUG}:p:A']['name'], 'All Closed')
    check('titles：补 CF gym 链接', t[f'aux-srk:c:{SLUG}:p:A']['link'],
          'https://codeforces.com/gym/999/problem/A')
    check('titles：**不碰** ratio', 'ratio' in t[f'aux-srk:c:{SLUG}:p:A'], False)
    b = keys_of(board_crate)
    check('board：算 ratio（只数 rows 里 result=AC 的行）',
          b[f'aux-srk:c:{SLUG}:p:A']['ratio'], '100.00')
    check('board：C 链接指向 rankland', b[f'aux-srk:c:{SLUG}']['link'],
          f'https://rl.algoux.cn/collection/official?rankId={SLUG}')


def test_submissions(qoj_crate, cf_crate, qoj_warns=()):
    print('\n[4] 提交：CF 只出 R；QOJ 出**自己那棵树**（W/S/C/P/R）')
    cf_types = {r['节点类型'] for r in cf_crate.to_dict()['records']}
    check('CF 片段只有 R', cf_types, {'R'})
    # QOJ 是**独立的一棵树**：场次有链接、题目有题面链接与题名、
    # 提交有运行信息 —— 自足，不再挂到主树的题目上（见 qoj_adapter.py 的文件头）。
    qoj_types = {r['节点类型'] for r in qoj_crate.to_dict()['records']}
    check('QOJ 片段是它自己一整棵树（W/S/C/P/R）', qoj_types, {'W', 'S', 'C', 'P', 'R'})
    q = keys_of(qoj_crate)
    check('QOJ 的 P 不写 ratio', 'ratio' in q['qoj:c:4113:p:1'], False)
    check('QOJ 的 P 带题名（来自 题目名称）',
          q['qoj:c:4113:p:1'].get('name'), 'All Closed')
    check('QOJ 的 P 带题面链接',
          q['qoj:c:4113:p:1'].get('link'), 'https://qoj.ac/contest/4113/problem/1')
    check('「答案错误」→ WA', q['qoj:c:4113:sub:556']['status'], 'WA')
    # 时间**保留到秒**（14 位）—— 同一分钟内多条提交靠它排序，acTime 才准
    check('提交时间带时区换算（保留秒）',
          q['qoj:c:4113:sub:555']['time'], '2026.09.13 22:06:07')
    # ★ `v9.4.15`（用户 2026-10-15："这种应该是**丢弃提交并警告**，而不是整包建不了"）：
    #   场次页只给相对时间（`00:31:01`）⇒ 这条提交**不进包**，并且要说出来（去哪儿补）。
    #   ⚠️ 别改成"写个空 time 留在包里"：`time` 是 required ⇒ 体检判真缺 ⇒ 整条链停在体检那一步。
    check('★ 只有相对时间的提交**没有进包**（丢弃，不是写成 00:31:01，也不是留个空 time）',
          'qoj:c:4113:sub:558' in q, False)
    check('★ 而且**警告里说了**（几条、什么原因、去哪补）',
          any('相对时间' in w and 'sub:558' not in w for w in qoj_warns), True)
    check('（对照）绝对时间那一条照旧进包、保留到秒',
          q['qoj:c:4113:sub:555']['time'], '2026.09.13 22:06:07')
    check('比赛 C 记下 QOJ 补题入口（problems 类别）',
          link_kinds_of(q['qoj:c:4113']),
          {'problems': ['https://qoj.ac/contest/4113']})
    c = keys_of(cf_crate)
    check('CF：OK → AC', c['cf:c:999:sub:111']['status'], 'AC')
    check('CF：WRONG_ANSWER → WA', c['cf:c:999:sub:112']['status'], 'WA')
    check('CF：别人的提交被过滤掉', 'cf:c:999:sub:113' in c, False)
    check('CF 链接是 gym 提交页', c['cf:c:999:sub:111']['link'],
          'https://codeforces.com/gym/999/submission/111')


def test_account_clue(qoj_crate, cf_crate):
    """账户线索：源如实搬运"这条记录关于谁"，应用只拿它查映射表"""
    print('\n[4.5] 账户线索')
    q = keys_of(qoj_crate)
    check('QOJ：线索 = {source:qoj, field:提交者, value:<用户名>}（**不带赛季**）',
          q['qoj:c:4113:sub:555'].get('账户线索'),
          {'source': 'qoj', 'field': '提交者', 'value': 'someone'})
    check('QOJ：源里没有提交者 → **根本不写线索**（区别于空线索）',
          '账户线索' in q['qoj:c:4113:sub:556'], False)
    c = keys_of(cf_crate)
    # ⚠️ 不带赛季（CF 账号不会每年一换，加赛季是画蛇添足）
    check('CF：线索 = {source:cf, field:handle, value:<handle>}（**不带赛季**）',
          c['cf:c:999:sub:111'].get('账户线索'),
          {'source': 'cf', 'field': 'handle', 'value': 'tester'})
    check('CF：队伍提交归到"登记顺序里第一个命中的 handle"（tester 在前）',
          c['cf:c:999:sub:114'].get('账户线索'),
          {'source': 'cf', 'field': 'handle', 'value': 'tester'})
    # 线索是**元列**：不能因为多了一列就被 crate 校验报成"未使用字段"
    from crate import validate_crate
    issues = validate_crate(qoj_crate.to_dict())
    check('线索列不被当成「未使用字段」',
          [i for i in issues if '账户线索' in str(i)], [])


def test_validate(crates, validate_crate):
    print('\n[5] 各片段过 crate 校验（硬错误必须是 0）')
    for name, crate in crates:
        issues = validate_crate(crate.to_dict())
        hard = [i for i in issues if '父节点' not in str(i)]
        check_true(f'{name} 无硬错误', not hard, f'→ {hard}')


def test_merge(fragments: dict, slug: str):
    print('\n[6] crate-merge 合并（多来源粘合）')
    repo = os.path.abspath(os.path.join(HERE, '..', '..', '..', '..'))
    merge = os.path.join(repo, 'scripts', 'crate-merge.mjs')
    if not os.path.isfile(merge):
        print('  ⚠️ 找不到 crate-merge.mjs —— 跳过这一段')
        return
    # ⚠️ 中间文件**直接写在 cache/ 下**，不要建子目录：
    #    `tempfile.mkdtemp` 建的目录带 0700 ACL，在本仓库的沙箱里
    #    里面的文件写不进去、目录还删不掉（实测踩到过，留下过两个空目录）。
    paths = []
    for name, crate in fragments.items():
        p = os.path.join(CACHE, f'_selftest_frag_{name}.json')
        crate.save(p)
        paths.append(p)
    out = os.path.join(CACHE, '_selftest_merged.json')
    try:
        ret = subprocess.call(['node', merge, *paths, '-o', out, '--quiet'],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        check('合并成功（退出码 0）', ret, 0)
        if ret != 0:
            return
        recs = json.load(open(out, encoding='utf-8'))['records']
        keys = [r['extKey'] for r in recs]
        # 两个渠道片段（pta + srk）**共用一个 `aux` 容器**，各自那棵树各一份 ——
        # 容器去重、树不互相覆盖，正是拆树要保证的事。
        check('辅助节点容器只出现一次（两棵树共用它）',
              {k: keys.count(k) for k in ('aux', PTA, SRK,
                                          f'{PTA}:s:icpc', f'{PTA}:s:icpc:test2026',
                                          f'{PTA}:c:{slug}')},
              {'aux': 1, PTA: 1, SRK: 1,
               f'{PTA}:s:icpc': 1, f'{PTA}:s:icpc:test2026': 1,
               f'{PTA}:c:{slug}': 1})
        check('合并后没有重复键（容器与记录都只出现一次）',
              {k: keys.count(k) for k in set(keys) if keys.count(k) > 1}, {})
        # 三棵树并存、互不覆盖：辅助节点下的两棵 + QOJ 那棵
        check('三棵树并存：aux-pta / aux-srk / qoj',
              all(k in keys for k in ('aux', PTA, SRK, f'{PTA}:c:{slug}',
                                      f'{SRK}:c:{slug}', 'qoj', 'qoj:c:4113')), True)
        # 归认信息必须**活着穿过合并**——合并产物是应用真正吃的那份文件，
        # 这里丢了的话，"这条提交是谁交的"就永远到不了应用。
        r555 = next((r for r in recs if r['extKey'] == 'qoj:c:4113:sub:555'), None)
        check('合并产物保留账户线索',
              (r555 or {}).get('账户线索'),
              {'source': 'qoj', 'field': '提交者', 'value': 'someone'})
    finally:
        for p in paths + [out]:
            try:
                os.remove(p)
            except OSError:
                pass


# ================================================================

def test_cf_page_difficulty():
    """
    「按题抓页面补难度」的**证据三态**（"**特殊情况只能兜底**"）。

    ⚠️ 判"这格**应该**有难度吗"，只认**这道题自己的证据**（题目页面写没写 `Difficulty`）：
       已实测推翻的**间接信号** —— 官网「Past contests filter → Rated: No」列表
       （663 / 664 / 1345 全在里面，可题目页面上明写着 2000 / 3100 / 2600 …）。
    """
    import time as _time

    import cf_contest_adapter as A

    tmp = os.path.join(CACHE, 'cf_contest', '.tmp-pagediff-selftest.json')
    old_path = A.PAGE_DIFF_JSON
    try:
        A.PAGE_DIFF_JSON = tmp
        if os.path.isfile(tmp):
            os.remove(tmp)
        now = int(_time.time())

        # ① 没抓过 ⇒ 说不清（**该去抓一次**）
        check('按题页面：没抓过 ⇒ unknown', A.page_rating('663', 'B', now=now)[0], 'unknown')

        # ② 抓过、页面写了 ⇒ has（值就是页面上的难度）
        with open(tmp, 'w', encoding='utf-8') as fh:
            json.dump({'663': {'B': {'rating': 2000, 'checkedAt': now}}}, fh)
        check('按题页面：页面写了 ⇒ has', A.page_rating('663', 'B', now=now), ('has', 2000))

        # ③ 抓过、页面**没写** ⇒ none（真豁免：**留了证据**才敢说"本来就没有"）
        with open(tmp, 'w', encoding='utf-8') as fh:
            json.dump({'2214': {'A': {'rating': None, 'checkedAt': now}}}, fh)
        check('按题页面：抓过但页面没写 ⇒ none（真豁免）',
              A.page_rating('2214', 'A', now=now)[0], 'none')

        # ④ 否定证据**过期** ⇒ 又变成 unknown（**新题**打完分要能自己补上；"不然新题怎么办？"）
        check('按题页面：否定证据过期 ⇒ unknown（新题能自己补上）',
              A.page_rating('2214', 'A', now=now + A.EVIDENCE.PAGE_NEG_TTL + 60)[0], 'unknown')

        # ⑤ 并进题池：**只补空位、不覆盖已有值**；否定证据**不并**
        pool = {'663': {'A': {'name': 'Rebus', 'rating': 1800}, 'B': {'name': 'B', 'rating': None}}}
        with open(tmp, 'w', encoding='utf-8') as fh:
            json.dump({'663': {'A': {'rating': 1500, 'checkedAt': now},
                               'B': {'rating': 2000, 'checkedAt': now}},
                       '2214': {'A': {'rating': None, 'checkedAt': now}}}, fh)
        A._merge_page_difficulty(pool)
        check('按题页面并进题池：只补空位（API 的 rating 是权威，不被页面覆盖）',
              pool['663']['A']['rating'], 1800)
        check('按题页面并进题池：补上空位', pool['663']['B']['rating'], 2000)
        check_true('按题页面并进题池：否定证据**不并**（页面没写 ≠ 给个空值）',
                   '2214' not in pool)

        # ⑤ 已有结论的题**不再抓**（幂等：不然每次重建都把这几十个请求重打一遍 —— 实测踩到）
        calls = []

        def _no_net(*_a, **_k):
            calls.append(1)
            raise AssertionError('这题已有结论，不该联网')

        real_open = A.urllib.request.urlopen
        A.urllib.request.urlopen = _no_net
        try:
            A.fetch_page_difficulty([('663', 'B'), ('2214', 'A')], verbose=False)
        finally:
            A.urllib.request.urlopen = real_open
        check('按题页面：`has`/`none` 已有结论 ⇒ **一次也不联网**（幂等）', calls, [])

        # ⑤b **三档开关**（"能否对旧题的误判自动作出措施以防以后不停重爬，
        #     又能不断试爬新题的 rating，同时又有选项可以兜底全部重爬"）：
        #     · 默认（neg_ttl=None）= 30 天保质期 ⇒ `none` 算已有结论 ⇒ **不重爬**（防重爬那道闸）；
        #     · `--neg-ttl-days 0` ⇒ 否定证据一律当过期 ⇒ `unknown` ⇒ **每次试爬**；
        #     · `recheck=True`（`--all`）⇒ **忽略已有结论，全部重查**（兜底）。
        #   ⚠️ 这里只验"判定"，不联网：把 urlopen 换成"记一笔就抛"，看它有没有走到网络那一步。
        def _count_net(*_a, **_k):
            calls.append(1)
            raise AssertionError('（自测）不真联网')

        with open(tmp, 'w', encoding='utf-8') as fh:
            json.dump({'2214': {'A': {'rating': None, 'checkedAt': now}}}, fh)
        calls.clear()
        A.urllib.request.urlopen = _count_net
        try:
            A.fetch_page_difficulty([('2214', 'A')], verbose=False)                     # 默认档
            check('防重爬闸门：默认档 `none` 结论 ⇒ 一次也不联网', calls, [])
            A.fetch_page_difficulty([('2214', 'A')], verbose=False, neg_ttl_days=0)      # 每次试爬
            check('不断试爬档：`--neg-ttl-days 0` ⇒ 会去联网（试一次）', len(calls) >= 1, True)
        finally:
            A.urllib.request.urlopen = real_open
        # 注意：上面那次真的"试"失败了（假 urlopen 抛错）⇒ 结论仍是 `none`，数据没被弄脏
        check('试爬失败**不改**已有结论（仍是 none）',
              A.page_rating('2214', 'A', now=now)[0], 'none')
    finally:
        A.PAGE_DIFF_JSON = old_path
        if os.path.isfile(tmp):
            os.remove(tmp)


def _local_key_parses(src: str) -> list:
    """
    在一段 Python 源码里找"**取下标 3 或 4**"的取值，返回行号列表（④ 的判据）。

    为什么看语法树而不是正则：键 `cf:c:<场>:p:<题号>` 的"5 段 + `p`"这条解释**归
    `lib/cf_page_evidence.problem_ref` 所有**，别处自己拼就是重复。守卫审计证明
    "同行 + 单引号 + `parts`"这种正则判据**换引号/拆行/改名**就能绕过去；而"下标 3/4
    的取值"是语法树里的一个稳定形状，怎么写都躲不掉。

    只禁 3/4：只取 `parts[2]`（场次号）是另一件事（`field-coverage.py` 的 `contestIdBelow`
    就这么用），禁了会误伤。实测这三份文件现在一处都没有。

    解析不了的源码（语法错误）返回空 —— 交给别的测试去报语法错。
    """
    import ast
    try:
        tree = ast.parse(src)
    except SyntaxError:
        return []
    out = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Subscript):
            continue
        idx = node.slice
        if isinstance(idx, ast.Constant) and idx.value in (3, 4):
            out.append(node.lineno)
    return out


def test_cf_adapter_edges():
    """
    重建版 `cf_contest_adapter` 的三处**边界**（都是错误级）。

    都在"今天的数据走不到、但一旦走到就**静默出错**"那一类 ⇒ 这里用假数据钉住：

      ① **题池的值是题名串**（`problems.json`）时，把页面证据并进去不许崩。
         共用件 `lib/cf_page_evidence.merge_into_pool` 兼容这种形状；自己写一份就会
         `AttributeError`，而 `main()` 会把它误报成"这次抓不到 CF API"、保留上一份片段。
      ② `fetch_types` 判"这一页没有新 id"用的 `seen` 必须是**每个 token 各一份**：
         否则第 2 个 token 的某页只要 id 在**别的 token** 里出现过就算"没有新 id"，
         `page > 2` 时提前收工 ⇒ 后面的页再也不翻（丢标签）。
      ③ `missing_difficulty_pairs` 从键里取题号要取 `cf:c:<场>:p:<题号>` 的**第 5 段**，
         不许把字面量 `p` 当题号（否则去查 `problemset/problem/<场>/p`，还把 'p' 当结论写进证据）。
    """
    import cf_contest_adapter as A

    # ---- ① 题名串题池 + 页面证据 ⇒ 不崩，且 API 的值不动 ----
    tmp = os.path.join(CACHE, 'evidence_selftest.json')      # 中间文件写 cache/（本仓自测惯例）
    with open(tmp, 'w', encoding='utf-8', newline='\n') as f:
        json.dump({'663': {'A': {'rating': 1500}, 'B': {'rating': None}}}, f)
    old_path = A.PAGE_DIFF_JSON
    A.PAGE_DIFF_JSON = tmp
    try:
        pool = {'663': {'A': 'Rebus'}}                        # 值是题名串
        try:
            A._merge_page_difficulty(pool)
            check('① 题名串那格**留题名、补难度**（不是"不崩但一个字不并"）',
                  pool['663']['A'], {'name': 'Rebus', 'rating': 1500})
        except Exception as e:                                # noqa: BLE001
            check_true(f'① 不该崩（实际 {type(e).__name__}: {str(e)[:60]}）', False)
        pool2 = {'663': {'A': {'name': 'X', 'rating': None}}}
        A._merge_page_difficulty(pool2)
        check('① 池子里空着的那格照样补上（只有没值时才补）', pool2['663']['A']['rating'], 1500)
        pool3 = {'663': {}}
        A._merge_page_difficulty(pool3)
        check('① API 的题池漏了这道题 ⇒ 补一条（题名留空）',
              pool3['663'].get('A'), {'name': '', 'rating': 1500})
    finally:
        A.PAGE_DIFF_JSON = old_path
        if os.path.isfile(tmp):
            os.remove(tmp)

    # ---- ② 每个 token 各一份 `seen`（场景要能真正区分对错，见上面说明）----
    pages = {
        ('div1', 1): [1, 2, 3], ('div1', 2): [],
        ('div2', 1): [4, 5, 6], ('div2', 2): [1, 2, 3], ('div2', 3): [7, 8, 9],
    }
    got_pages = []
    real_fetch, real_write = A._fetch_html, A.write_json

    def fake_fetch(url):
        # ⚠️ 取**真 token 名**（审计指出：`'div1' in url` 对 `filterTypes=div1div2` 也成立，
        #    那样打标签的断言就不是被 div2 兜住的）
        tm = re.search(r'filterTypes=([a-z0-9]+)', url)
        tok = tm.group(1) if tm else 'div1'
        m = re.search(r'/page/(\d+)', url)
        page = int(m.group(1)) if m else 1
        got_pages.append((tok, page))
        return ''.join(f'<a href="/contest/{i}"></a>' for i in pages.get((tok, page), []))

    A._fetch_html = fake_fetch
    A.write_json = lambda *a, **k: None                        # 不落盘
    try:
        types = A.fetch_types(refresh=True)
    finally:
        A._fetch_html, A.write_json = real_fetch, real_write
    check('② 第 2 个 token 也会翻到第 3 页（不被别的 token 的 id 提前打断）', ('div2', 3) in got_pages, True)
    check('② 第 3 页那三场都拿到了这个 token 的标签',
          [c for c in (7, 8, 9) if 'div2' in (types.get(c) or [])], [7, 8, 9])

    # ---- ③ 键里取题号：`cf:c:<场>:p:<题号>` ----
    # ⚠️ 2026-10-19：这里还要把 `os.path.isfile` 打桩。`missing_difficulty_pairs()` 开头
    #    "没有包就早退"（返回 []），而**树包是生成物**（`clean-personal` 档位 1 会删它）⇒
    #    包不在时这条判据会**假红**（实际 []，期望 [('2196','C')]）。它验的是"键里怎么取题号"，
    #    与包在不在无关，所以把 isfile 也当输入打桩。
    real_read, real_rate = A.read_json, A.page_rating
    real_isfile = A.os.path.isfile
    A.read_json = lambda p: {'records': [{'节点类型': 'P', 'extKey': 'cf:c:2196:p:C'}]}
    A.page_rating = lambda cid, idx, **k: ('unknown', None)
    A.os.path.isfile = lambda p: True
    try:
        pairs = A.missing_difficulty_pairs(verbose=False)
    finally:
        A.read_json, A.page_rating, A.os.path.isfile = real_read, real_rate, real_isfile
    check('③ 缺 problemId 时从键的第 5 段取题号（不是字面量 p）', pairs, [('2196', 'C')])

    # ---- ④ 键 ⇒ 题号 的解析**只有一处**（审计：同一规则全仓三份、校验各不相同）----
    #     源码级 lint：三处都必须调共用件，不许再自己 `split(':')` 拼
    three = [
        os.path.join(HERE, 'cf_contest_adapter.py'),
        os.path.join(REPO, 'scripts', 'material-needs.py'),
        os.path.join(REPO, 'scripts', 'field-coverage.py'),
    ]
    bad = []
    for path in three:
        if not os.path.isfile(path):
            bad.append(f'{os.path.basename(path)} 找不到')
            continue
        with open(path, encoding='utf-8') as fh:
            src = fh.read()
        # ① 必须**真的调**共用件（守卫审计：只查子串 `problem_ref(` 挡不住
        #    "留一句调用、另写一份 split(':') 解析"）
        bare = re.sub(r'#.*', '', src)                    # 剥注释再查（只在注释里提不算）
        if not re.search(r'problem_ref\s*\(', bare):
            bad.append(f'{os.path.basename(path)} 没调 problem_ref')
        # ② 也不许**在本地再解析一遍键**。判据 = **语法树里出现"下标 3 或 4 的取值"**。
        #    ⚠️ 用 `ast` 而不是正则（"守卫出 bug 你怎么判？"）：守卫审计
        #    把判据从"`extKey` 与 `.split(':')` 同一行 + 单引号"绕过去了（换引号/拆行/改个变量名）。
        #    语法树里"取下标 3 或 4"是个稳定形状 —— 怎么改名、怎么拆行都躲不掉。
        #    ⚠️ 只取 `parts[2]`（场次号）是**另一件事**（`field-coverage.py` 的 `contestIdBelow`
        #    就这么用），所以只禁 3/4。实测这三份文件现在**一处都没有**。
        for ln in _local_key_parses(src):
            bad.append(f'{os.path.basename(path)}:{ln} 本地又解析了一遍键（该用 problem_ref）')
    check('④ 三处都调共用件解析键（谁再自己拼就红）', bad, [])
    # ★ 自检：喂已知样本，证明这条 lint 真的会咬（连同"什么不该被禁"一起钉住）
    check('④ 自检：`parts[4]` 这种本地解析必须被抓',
          len(_local_key_parses("parts = extKey.split(':')\nidx = parts[4]\n")) > 0, True)
    check('④ 自检：换引号、拆行、改名都躲不掉（看的是语法树）',
          len(_local_key_parses("p2 = ext.split(\":\")\nidx = p2 [4]\n")) > 0, True)
    check('④ 自检：只取 `parts[2]`（场次号）是另一件事，不该被禁',
          _local_key_parses("parts = ext.split(':')\ncid = parts[2]\n"), [])


def test_atcoder_difficulty():
    """
    AtCoder **数值难度**（kenkoooo `problem-models.json`）——
    "是时候让数值难度也成为字段组了"（组的两员：`cfDifficulty` / `atcoderDifficulty`）。

    钉三件事：① 难度**写进 P**；② `difficulty` 缺失的题**不写**那个字段（缺失 ≠ 0）；
    ③ 难度**可以是负数**（`abc138_a: -848`）且不受影响。
    """
    from atcoder_adapter import build_tree
    import atcoder_adapter as A

    old_no_official = A.no_official
    A.no_official = True                   # 自测不联网（官方题表页那一步跳过）

    contests = {'abc1': {'id': 'abc1', 'title': 'AtCoder Beginner Contest 1',
                         'start_epoch_second': 1600000000, 'rate_change': '~ 1999'}}
    problems = {
        'abc1_a': {'id': 'abc1_a', 'contest_id': 'abc1', 'problem_index': 'A', 'name': 'A 题'},
        'abc1_b': {'id': 'abc1_b', 'contest_id': 'abc1', 'problem_index': 'B', 'name': 'B 题'},
    }
    difficulty = {'abc1_a': -848}          # B 故意没有（新题还没估分）
    # ⚠️ 必须给一条提交：`build_tree` 的口径是"抓取范围 = 我有提交的场次"，
    #    一条提交都没有时它**直接返回**（整棵树只剩 W 节点）—— 不喂提交就会栽在这。
    subs = [{'id': 1, 'contest_id': 'abc1', 'problem_id': 'abc1_a', 'result': 'AC',
             'epoch_second': 1600000100, 'language': 'C++ (GCC 9.2.1)', 'execution_time': 10}]
    try:
        crate, _warns = build_tree(contests, problems, subs, 'tester', {}, difficulty)
        recs = crate.to_dict()['records']
        by_ext = {r['extKey']: r for r in recs}
        check('AtCoder 难度：写进 P（负数也照写）',
              by_ext['atcoder:c:abc1:p:A'].get('atcoderDifficulty'), '-848')
        check_true('AtCoder 难度：还没估分的题**不写**那个字段（缺失 ≠ 0）',
                   'atcoderDifficulty' not in by_ext['atcoder:c:abc1:p:B'])
        crate2, _ = build_tree(contests, problems, subs, 'tester', {})     # 没有难度数据（离线）
        by_ext2 = {r['extKey']: r for r in crate2.to_dict()['records']}
        check_true('AtCoder 难度：整份难度为空时也不炸、只是不写',
                   'atcoderDifficulty' not in by_ext2['atcoder:c:abc1:p:A'])
    finally:
        A.no_official = old_no_official


def test_cf_classification():
    """CF 严格分类：token → 分类路径，**纯函数**先钉死。"""
    from cf_contest_adapter import classify_cf, fetch_types
    from crate import nature_fields

    check('CF：div1', classify_cf(['div1']), 'cf/contest/div1')
    check('CF：div1+2 优先于 div2（合办场两个 token 都在）',
          classify_cf(['div2', 'div1div2']), 'cf/contest/div1+2')
    check('CF：rated 压过 unrated 的标记（div2 + team）',
          classify_cf(['team', 'div2']), 'cf/contest/div2')
    check('CF：edu（educational）', classify_cf(['educational']), 'cf/contest/edu')
    check('CF：team > april > kotlin（同时命中取 team）',
          classify_cf(['april', 'kotlin', 'team']), 'cf/contest/others/team')
    check('CF：april 压 kotlin', classify_cf(['kotlin', 'april']), 'cf/contest/others/april')
    check('CF：只有 kotlin', classify_cf(['kotlin']), 'cf/contest/others/kotlin')
    check('CF：`icpc` 不准 ⇒ 忽略（只剩它 = 没命中）',
          classify_cf(['icpc']), 'cf/contest/others/无归类')
    check('CF：`mirror` 不再单列，落 others/无归类',
          classify_cf(['mirror']), 'cf/contest/others/无归类')
    check('CF：没中任何 token', classify_cf([]), 'cf/contest/others/无归类')
    from xcpc_common import is_provincial_invitational as is_provincial_invitational_now

    # gym 是**另一支**（不在 `filterTypes` 表里 ≠ 归不了），见 cf_board_adapter 的注释
    # ⚠️ gym 的分类同样细分（A 方案：`cf/gyms` 下镜像整棵 xcpc 子树）⇒ `cf_nature` 要传赛名
    from cf_board_adapter import cf_nature, gym_class_of
    from qoj_adapter import qoj_class_of as qoj_class_of_for_ec_test
    gym = cf_nature('2023.11.05 11:00:00', 'The 2020 ICPC Asia Yinchuan Regional Programming Contest')
    check('CF gym 的分类（ICPC 区域赛）',
          gym.get('natureClass'), 'cf/gyms/xcpc/icpc/ec/regional/official')
    check('CF gym 的年份取自开赛时间', gym.get('natureYear'), '2023')
    # "cf 无赛季，但通常单说 cf 有仅 cf contest 的含义"
    # + "gym 有很多线下赛，很多能和 qoj/xcpc 绑定，只是暂时不填"
    # ★（"cf/gyms 的年份与赛季也补一补（可能只能靠名字）"）：
    #   赛季 = **赛名**里的年份（2020 赛季），年份 = **开赛时间**（2023 真办）—— 银川站疫情延期那场
    check('CF gym 的赛季取自**赛名**（2020 赛季，那年疫情延期到 2023 才办）',
          gym.get('natureSeason'), '2020')
    check('★ CF gym 的地区取自**赛名里的城市**（自动填；否则一律留空等人补）',
          gym.get('natureRegion'), '银川')
    check('★ CF gym 的地区规则 id', (gym.get('分类依据') or {}).get('natureRegion'),
          'gym:region-city')
    # 名字里有年份、CF 没给开赛时间 ⇒ 靠赛名把年份补上（否则一律空着挂 ③）
    check('★ CF gym：没有开赛时间时年份退到赛名',
          (cf_nature('', 'The 2021 Sichuan Provincial Collegiate Programming Contest')
           .get('natureYear'),
           cf_nature('', 'The 2021 Sichuan Provincial Collegiate Programming Contest')
           .get('natureSeason')),
          ('2021', '2021'))
    # 名与时间都没有 ⇒ 还是空（不猜）
    check('★ CF gym：名与时间都没有 ⇒ 两个字段都空',
          (cf_nature('', 'The 17th Zhejiang Provincial Collegiate Programming Contest')
           .get('natureYear'),
           cf_nature('', 'The 17th Zhejiang Provincial Collegiate Programming Contest')
           .get('natureSeason')),
          (None, None))
    # 总决赛：没有开赛时间 ⇒ `待同步`；有 ⇒ 用那个日期
    check('★ CF gym：总决赛没有开赛时间 ⇒ 年份 `待同步`',
          cf_nature('', '2021 ICPC Asia East Continent Final').get('natureYear'), '待同步')
    check('★ CF gym：总决赛有开赛时间 ⇒ 用那个日期（2021 赛季、2022 办）',
          cf_nature('2022.03.01', '2021 ICPC Asia East Continent Final').get('natureYear'), '2022')

    # ---- ★ gym 再细分（A 方案；"省赛/邀请赛的判定一定要最靠前"）----
    check('★ gym：CCPC 总决赛（英文全称也认）',
          gym_class_of('2019 China Collegiate Programming Contest Final (CCPC-Final 2019)'),
          'cf/gyms/xcpc/ccpc/final/official')
    check('★ gym：CCPC 分站（Onsite ⇒ regional）',
          gym_class_of('2019 China Collegiate Programming Contest Qinhuangdao Onsite'),
          'cf/gyms/xcpc/ccpc/regional/official')
    check('★ gym：CCPC 网络赛（Online ⇒ pre）',
          gym_class_of('The 2023 CCPC Online Contest'), 'cf/gyms/xcpc/ccpc/pre/official')
    check('★ gym：CCPC 女生专场',
          gym_class_of('2024 China Collegiate Programming Contest (CCPC) Female Onsite'
                       '（2024年中国大学生程序设计竞赛女生专场）'),
          'cf/gyms/xcpc/ccpc/female/official')
    check('★ gym：**又含 CCPC 又含邀请赛/省赛 ⇒ 省赛赢**（点名的优先级）',
          gym_class_of('The 2024 CCPC Shandong Invitational Contest and Provincial Collegiate PC')
          .startswith('cf/gyms/xcpc/provincial&invitational/'), True)
    check('★ gym：ICPC 亚洲区域赛（赛区从赛名读）',
          gym_class_of('2017-2018 ACM-ICPC, Asia Tsukuba Regional Contest'),
          'cf/gyms/xcpc/icpc/ap/regional/official')
    check('★ gym：ICPC EC 总决赛',
          gym_class_of('2017-2018 ACM-ICPC Asia East Continent League Final (ECL-Final 2017)'),
          'cf/gyms/xcpc/icpc/ec/final/official')
    check('★ gym：ICPC 赛区读不出 ⇒ **停在浅处**（不猜赛区）',
          gym_class_of('Some Random ICPC Contest Without Any Region'),
          'cf/gyms/xcpc/icpc')
    check('★ gym：只有 UC 身份 ⇒ `cf/gyms/ucup`',
          gym_class_of('Universal Cup Stage 5: Nowhere'), 'cf/gyms/ucup')
    check('★ gym：什么都不是 ⇒ `cf/gyms/无归类`',
          gym_class_of('Totally Unknown Contest'), 'cf/gyms/无归类')
    check('★ 省赛判据不透支：ICPC 的中文全称（…国际大学生程序设计竞赛亚洲区域赛…）**不是**省赛',
          is_provincial_invitational_now('第43届ACM-ICPC国际大学生程序设计竞赛亚洲区域赛（焦作站）'), False)
    check('★ 省赛判据不透支：ICPC 的英文全称也不是',
          is_provincial_invitational_now('2023 - 2024 International Collegiate Programming Contest, Macau'),
          False)
    # ★ "省赛/邀请赛判定**只对 ec 赛区生效**"
    from xcpc_common import is_ec_name
    check('★ 中国省赛名（没写 ICPC）也算 EC', is_ec_name('The 17th Zhejiang Provincial Collegiate Programming Contest'), True)
    check('★ 中文省赛名也算 EC', is_ec_name('第二十届东北地区大学生程序设计竞赛'), True)
    check('★ CCPC 算 EC', is_ec_name('2020 CCPC Henan Provincial Collegiate Programming Contest'), True)
    check('★ 波兰的全国赛**不是** EC（不会被说成省赛）',
          is_ec_name('The 2022 ICPC Polish Collegiate Programming Contest (AMPPZ 2022)'), False)
    check('★ 欧洲区域赛也不是 EC', is_ec_name('The 2022 ICPC Central Europe Regional Contest (CERC 2022)'), False)
    check('★ 日本区域赛也不是 EC', is_ec_name('2017-2018 ACM-ICPC, Asia Tsukuba Regional Contest'), False)
    check('★ 非 EC 的 Collegiate 场次**不进**省赛那一支（gym）',
          gym_class_of('The 2022 ICPC Polish Collegiate Programming Contest (AMPPZ 2022)'),
          'cf/gyms/xcpc/icpc')
    check('★ 非 EC 的 Collegiate 场次**不进**省赛那一支（QOJ）',
          qoj_class_of_for_ec_test([[{'name': 'ICPC'}, {'name': 'Regionals'}, {'name': 'Europe'},
                                     {'name': 'Central Europe'}]],
                                   ['The 2022 ICPC Polish Collegiate Programming Contest (AMPPZ 2022)']),
          'qoj/xcpc/icpc/eu/无归类')

    # 缓存里那张真表：**每个值都得是 Trie 里的合法路径**（分类表与注册表不许各说各话）
    path = os.path.join(CACHE, 'cf_contest', 'types.json')
    if not os.path.isfile(path):
        return
    types = fetch_types()
    bad = []
    dist: dict = {}
    for cid, toks in types.items():
        cls = classify_cf(toks)
        try:
            nature_fields(('natureClass', cls))
        except ValueError as exc:                    # noqa: PERF203 —— 报出来更好排查
            bad.append(f'{cid}: {cls}（{exc}）')
        dist[cls] = dist.get(cls, 0) + 1
    check_true('CF：缓存表里每一场的分类都过注册表 Trie', not bad, '；'.join(bad[:3]))
    check('CF：缓存表非空', len(types) > 0, True)
    check('CF：缓存表里没有"只有 icpc 这一类"的漏网场（ignored token）',
          dist.get('cf/contest/others/无归类', 0) > 0 or 'icpc' not in types, True)


def test_xcpc_class_rules():
    """
    XCPC / QOJ 的分类细化规则 ——**纯函数**先钉死：

      · 收集源只收 EC ⇒ `xcpc/icpc` → `xcpc/icpc/ec`；
      · 再按赛名判 `pre` / `final` / `regional` / `无归类`（顺序 = 声明的顺序）；
      · `ccpc` 省掉 EC 那一步，阶段判定与 icpc 一致；
      · QOJ：分类路径过 icpc/ccpc 就走 `qoj/xcpc/…`，都不过就 `qoj/无归类`。
    """
    from xcpc_common import (held_year_of, in_final_window, is_provincial_invitational,
                             season_of_held, stage_of, xcpc_class_of)
    from crate import nature_fields
    from qoj_adapter import QOJ_FETCH_FAILED, QOJ_UCUP_CLASS, qoj_class_of
    from qoj_adapter import build_tree as qoj_adapter_build
    from qoj_adapter import qoj_identities as qoj_adapter_identities

    # ---- 阶段判定（顺序 = pre → final → regional）----
    check('阶段：网络赛 → pre', stage_of('2024 网络预选赛'), 'pre')
    check('阶段：Online → pre', stage_of('The 2024 ICPC Asia East Continent Online Contest (I)'), 'pre')
    check('阶段：总决赛 → final', stage_of('第八届中国大学生程序设计竞赛总决赛'), 'final')
    check('阶段：Final → final', stage_of('2024-2025 ICPC, Asia East Continent Final Contest'), 'final')
    check('阶段：区域赛 → regional', stage_of('第43届ACM-ICPC亚洲区域赛（焦作站）'), 'regional')
    # ★ `Pre-Finals Workshop`（莫斯科训练营，QOJ 常当**变体名**挂在区域赛上）
    #   里的 "Finals" **不算总决赛** —— 否则 final 那条（排在 regional 前）会把它抢走
    check('★ 阶段：Pre-Finals Workshop 不算总决赛',
          stage_of('Moscow Pre-Finals Workshops 2022 Day 3 The 2021 ICPC Asia Macau Regional Contest'),
          'regional')
    check('★ 阶段：Pre-Final（无 s）同样不算', stage_of('Moscow Pre-Final Workshop Day 1'), '无归类')
    check('★ 阶段：真总决赛照旧 Final', stage_of('The 2020 ICPC Asia East Continent Final Contest'), 'final')
    check('阶段：區域賽（澳门写法）→ regional', stage_of('2024 ICPC 亞洲區域賽（澳門站）'), 'regional')
    check('阶段：一个都不中 → 无归类', stage_of('2024 某某杯程序设计竞赛'), '无归类')
    check('阶段：空名字 → 无归类', stage_of(''), '无归类')
    # 命中多个：**警告 + 取声明顺序里的第一个**（故意不随机：随机 = 重跑不幂等）
    w: list = []
    check('阶段：Online + Final 同时命中 ⇒ 取 pre',
          stage_of('EC-Final Online Contest', 'icpc', w), 'pre')
    check_true('…而且记了一条警告', len(w) == 1 and '同时命中' in w[0], str(w))

    # ---- ccpc 的 female / vocational + regional 的别名 ----
    check('ccpc：女生 → female', stage_of('第十届中国大学生程序设计竞赛 女生专场', 'ccpc'), 'female')
    check('ccpc：高职 → vocational', stage_of('2024 CCPC 高职专场（郑州）', 'ccpc'), 'vocational')
    check('ccpc：女生优先于别的命中',
          stage_of('中国大学生程序设计竞赛 女生专场 区域赛', 'ccpc'), 'female')
    check('icpc：不含 female/vocational 这两条（那是 ccpc 的）',
          stage_of('女生专场', 'icpc'), '无归类')
    check('regional 别名：含「中国大学生程序设计竞赛」不含「总决赛」⇒ regional',
          stage_of('第六届中国大学生程序设计竞赛（秦皇岛）正式赛', 'ccpc'), 'regional')
    check('regional 别名：含「总决赛」时**不**走别名 ⇒ final',
          stage_of('第六届中国大学生程序设计竞赛总决赛', 'ccpc'), 'final')
    check('省赛/邀请赛关键词判定（名字）',
          is_provincial_invitational('2024 北京市大学生程序设计竞赛'), True)
    check('省赛/邀请赛关键词判定（大小写无关）',
          is_provincial_invitational('The 2023 Guangdong Provincial Collegiate Programming Contest'), True)
    check('省赛/邀请赛关键词判定（不含 ⇒ False）', is_provincial_invitational('CCPC Final 2024'), False)
    # ★ 追加的第二条判据
    check('★ 含「大学生程序设计大赛」不含「中国大学生程序设计大赛」⇒ 省赛',
          is_provincial_invitational('第七届广西大学生程序设计大赛'), True)
    check('★ 含「中国大学生程序设计大赛」⇒ **不算**省赛',
          is_provincial_invitational('2024 中国大学生程序设计大赛'), False)
    check('…但含「中国-东盟国际大学生程序设计大赛」时仍算（不是那个排除串）',
          is_provincial_invitational('第八届广西大学生程序设计大赛暨2025中国-东盟国际大学生程序设计大赛'), True)
    check('…而且两条判据是"任一命中"（有「省」字就直接算）',
          is_provincial_invitational('2024 四川省大学生程序设计大赛'), True)
    # ★ 追加的第三条：含「大学生程序设计竞赛」不含「中国大学生程序设计竞赛」
    check('★ 含「大学生程序设计竞赛」不含「中国…竞赛」⇒ 省赛',
          is_provincial_invitational('第二十届东北地区大学生程序设计竞赛'), True)
    check('★ 含「中国大学生程序设计竞赛」⇒ **不算**省赛',
          is_provincial_invitational('2024 中国大学生程序设计竞赛（CCPC）'), False)

    # ---- XCPC：icpc（收集源只收 EC）----
    check('icpc + 网络赛 → xcpc/icpc/ec/pre',
          xcpc_class_of('icpc', '2024 网络赛', 'xcpcio'), 'xcpc/icpc/ec/pre/official')
    check('icpc + 总决赛 → xcpc/icpc/ec/final',
          xcpc_class_of('icpc', '2024 EC Final', 'rankland'), 'xcpc/icpc/ec/final/official')
    check('icpc + 区域赛 → xcpc/icpc/ec/regional',
          xcpc_class_of('icpc', '2024 亚洲区域赛 成都站', 'pta'), 'xcpc/icpc/ec/regional/official')
    check('icpc + 认不出 → xcpc/icpc/ec/无归类',
          xcpc_class_of('icpc', '某某杯', 'xcpcio'), 'xcpc/icpc/ec/无归类')
    # ---- ccpc：省掉 EC 那一步，其余一致 ----
    check('ccpc + 网络赛 → xcpc/ccpc/pre', xcpc_class_of('ccpc', '2024 CCPC 网络赛'), 'xcpc/ccpc/pre/official')
    check('ccpc + 总决赛 → xcpc/ccpc/final', xcpc_class_of('ccpc', '2024 CCPC Final'), 'xcpc/ccpc/final/official')
    check('ccpc + 区域赛 → xcpc/ccpc/regional',
          xcpc_class_of('ccpc', '2024 CCPC 区域赛（成都）'), 'xcpc/ccpc/regional/official')
    check('ccpc + 认不出 → xcpc/ccpc/无归类', xcpc_class_of('ccpc', 'CCPC 2024'), 'xcpc/ccpc/无归类')
    # ---- 省赛/邀请赛：名字看得出 ⇒ 进 `xcpc/provincial&invitational/<主办>/<类型>`（正交化）；看不出 ⇒ 停在 `xcpc` ----
    # ⚠️ 这两个名字里**一个品牌词都没有** ⇒ 主办那一段是 `无`（不是判不出，是"没提"）。
    check('provincial-invitational + 名字含「市」→ xcpc/provincial&invitational',
          xcpc_class_of('provincial-invitational', '2024 北京市大学生程序设计竞赛'),
          'xcpc/provincial&invitational/无/省赛/official')
    check('provincial-invitational + 名字含 Provincial → xcpc/provincial&invitational',
          xcpc_class_of('provincial-invitational', 'The 2023 Guangdong Provincial Collegiate Programming Contest'),
          'xcpc/provincial&invitational/无/省赛/official')
    check('provincial-invitational + 看不出 → 停在 xcpc',
          xcpc_class_of('provincial-invitational', '某某杯'), 'xcpc')
    # ★ `未归类` **只在省赛的失配里出现**（其余判不出一律 `无归类`）——
    #   真实例子就是 QOJ 上那几场 `ACM-HK`：**路径**说它属于这一支，赛名里却没有任何 5 类词。
    check('★ 省赛支：靠路径进支、但类型判不出 ⇒ **未归类**（蓝、等人补）',
          qoj_class_of([{'name': '~'}, {'name': 'Team Competition'}, {'name': 'Chinese Provincial'},
                        {'name': 'Invitational Programming Contests'}],
                       ['ACM-HK Programming Contest 2026']),
          'qoj/xcpc/provincial&invitational/未归类')

    # ---- 省赛那一支的**两轴**（正交化成 4×3 = 12 类）----
    # 类型 3 类：`省赛暨邀请赛` / `省赛` / `邀请赛`（顺序即优先级，命中即止 —— "两个都有"排最前）；
    # 主办 4 档：`IC&CC` / `IC` / `CC` / `无`（"先判 IC&CC"）。
    # ⚠️ 实测踩到的坑：②「大学生程序设计竞赛/大赛」这条**没有"省/市"字面词**的别名，
    #    会把 `…ICPC 国际大学生程序设计竞赛邀请赛…` 这类 IC/CC 邀请赛一口吞成 `省赛`
    #    ⇒ ②b 那条加了"名字里带邀请/invitational 就不算"的前提。这几条就是钉住这件事的。
    from xcpc_common import (provincial_type_of, provincial_org_of, STAGE_NONE,
                             PROVINCIAL_TYPE_NONE)
    check('类型：省赛 + 邀请（"暨…省赛"）⇒ 省赛暨邀请赛',
          provincial_type_of('2025CCPC全国邀请赛（郑州）暨第七届河南省赛'), '省赛暨邀请赛')
    check('类型：有"省"字的省赛 ⇒ 省赛',
          provincial_type_of('2026 年山东省大学生程序设计竞赛'), '省赛')
    check('类型：**没有**"省"字的省赛（靠"大学生程序设计大赛"）⇒ 省赛',
          provincial_type_of('第七届广西大学生程序设计大赛'), '省赛')
    check('★ 类型：ICPC 的邀请赛 ⇒ 邀请赛（② 不许吞；主办由另一轴判）',
          provincial_type_of('第 49 届 ICPC 国际大学生程序设计竞赛邀请赛昆明站'), '邀请赛')
    check('★ 类型：CCPC 的邀请赛 ⇒ 邀请赛（② 不许吞）',
          provincial_type_of('2026 CCPC 中国大学生程序设计竞赛全国邀请赛（南昌）'), '邀请赛')
    check('★ 类型：CCPC 的地区邀请赛（没有"省"字）⇒ 邀请赛',
          provincial_type_of('2024年中国大学生程序设计竞赛全国邀请赛（东北）'
                             '暨第十八届CCPC东北地区大学生程序设计竞赛'), '邀请赛')
    # ★ ① 「省赛暨邀请赛」的三种写法（实测漏判 5 条之后放宽了窗口）：
    #   英文窗口从 `[^,;]{0,60}`（逗号算断句）改成跨逗号 80 字符；中文窗口 24/30 → 40 字；
    #   另加一条"没有省/市字面词、但也没有 IC/CC 品牌词"的（广西那种）。
    check('★ 类型：英文"逗号拼两套名"的合办场 ⇒ 省赛暨邀请赛',
          provincial_type_of('The 2024 CCPC National Invitational Contest (Changchun), '
                             'The 17th Jilin Provincial Collegiate Programming Contest'), '省赛暨邀请赛')
    check('★ 类型：中文长串（公司名夹在中间 26 字）⇒ 省赛暨邀请赛',
          provincial_type_of('2025 年（第二十二届）广东省大学生程序设计竞赛暨“汇丰科技（中国）”'
                             '中国大学生程序设计竞赛邀请赛（广东）预赛'), '省赛暨邀请赛')
    check('★ 类型：没有"省"字、但"大学生程序设计大赛 + 邀请"⇒ 省赛暨邀请赛',
          provincial_type_of('第八届广西大学生程序设计大赛暨2025邀请赛'), '省赛暨邀请赛')
    check('★ 类型：带 IC/CC 品牌词的邀请赛**不许**被 ① 抢走（那是 ③）',
          (provincial_type_of('第 49 届 ICPC 国际大学生程序设计竞赛邀请赛昆明站'),
           provincial_type_of('2026 CCPC 中国大学生程序设计竞赛全国邀请赛（南昌）')),
          ('邀请赛', '邀请赛'))
    # ⚠️ 英文里 `collegiate` 是**两义**的（复盘异常时逮到）：
    #    "某地区 Collegiate" = 省/地区赛 ✓；"… National Invitational Collegiate Programming Contest"
    #    里的 collegiate 只是 IC/CC 官方名的一部分 ✗ ⇒ 紧跟 invitational 的那个不算（后顾排除）。
    check('★ 类型：`… Invitational Collegiate …` 是**邀请赛**，不是省赛暨邀请赛',
          provincial_type_of('2024 ICPC National Invitational Collegiate Programming Contest, Wuhan Site'),
          '邀请赛')
    check('★ 类型：`<地区> Collegiate … National Invitational` 仍是省赛暨邀请赛',
          provincial_type_of('2023 Jiangsu Collegiate Programming Contest, '
                             '2023 National Invitational of CCPC (Hunan), The 13th Xiangtan Collegiate PC'),
          '省赛暨邀请赛')
    check('类型：一条都不命中 ⇒ `未归类`（省赛支专属的判不出值，不猜）',
          provincial_type_of('某某杯'), PROVINCIAL_TYPE_NONE)

    # ---- 主办那一轴（4 档）：**只认品牌词**，英文 `China` 不算 CC ----
    check('★ 主办：河南那两场必须分得开 —— ICPC 场 ⇒ IC',
          provincial_org_of('第 17 届 ICPC 河南省大学生程序设计竞赛'), 'IC')
    check('★ 主办：河南那两场必须分得开 —— CCPC 场 ⇒ CC',
          provincial_org_of('第八届 CCPC 河南省大学生程序设计竞赛'), 'CC')
    check('★ 主办：英文 `ICPC China …` **不许**被判成"两个都有"（China ≠ 中国）',
          provincial_org_of('The 2026 ICPC China Sichuan Provincial Programming Contest'), 'IC')
    check('★ 主办：两个品牌词都提到 ⇒ `IC&CC`（先判它）',
          provincial_org_of('2025 ICPC 国际大学生程序设计竞赛暨 CCPC 全国邀请赛（南昌）'), 'IC&CC')
    check('主办：一个品牌词都没有 ⇒ `无`（这是结论，不是欠账）',
          provincial_org_of('2024 北京市大学生程序设计竞赛'), '无')

    # ---- QOJ：把 xcpc 那一套复制到 qoj 下 ----
    icpc_path = [{'name': 'ICPC'}, {'name': 'Regionals'}, {'name': 'Asia East Continent'}]
    ccpc_path = [{'name': '~'}, {'name': 'Team Competition'},
                 {'name': 'China Collegiate Programming Contest (CCPC)'}]
    prov_path = [{'name': '~'}, {'name': 'Team Competition'}, {'name': 'Chinese Provincial'},
                 {'name': 'Invitational Programming Contests'}]
    check('qoj：路径过 icpc + 网络赛 → qoj/xcpc/icpc/ec/pre',
          qoj_class_of(icpc_path, ['The 2024 ICPC Asia East Continent Online Contest (I)']),
          'qoj/xcpc/icpc/ec/pre/official')
    check('qoj：路径过 icpc + 区域赛 → qoj/xcpc/icpc/ec/regional',
          qoj_class_of(icpc_path, ['The 2024 ICPC Asia East Regionals']), 'qoj/xcpc/icpc/ec/regional/official')
    # ★ 点名的 1522：标题只是"Universal Cup Stage 23"，**变体名**里才写着 EC-Final
    check('qoj：用**所有名字**判阶段（1522：变体名里有 EC-Final ⇒ final）',
          qoj_class_of(icpc_path, ['The 2nd Universal Cup. Stage 23: Shanghai',
                                   'The 2023 ICPC Asia East Continent Final Contest (EC-Final 2023)']),
          'qoj/xcpc/icpc/ec/final/official')
    check('qoj：路径过 ccpc + 总决赛 → qoj/xcpc/ccpc/final',
          qoj_class_of(ccpc_path, ['第十届中国大学生程序设计竞赛总决赛（CCPC 2024）']),
          'qoj/xcpc/ccpc/final/official')
    check('qoj：路径过 ccpc + 女生 → qoj/xcpc/ccpc/female',
          qoj_class_of(ccpc_path, ['第十届中国大学生程序设计竞赛 女生专场']), 'qoj/xcpc/ccpc/female/official')
    check('qoj：省赛路径 → qoj/xcpc/provincial&invitational',
          qoj_class_of(prov_path, ['The 2023 Guangdong Provincial Collegiate Programming Contest']),
          'qoj/xcpc/provincial&invitational/无/省赛/official')
    check('qoj：判不出省赛路径但名字里有「省」⇒ 也进那一支',
          qoj_class_of([], ['2024 四川省大学生程序设计竞赛']),
          'qoj/xcpc/provincial&invitational/无/省赛/official')
    # ★（「无归类」/「未归类」分家）：**省赛那一支判不出类型**是全仓库唯一写
    #   `未归类` 的地方（= 填写不完全、蓝、等人补）。真例：`ACM-HK Programming Contest`（路
    #   径说它是省赛/邀请赛，赛名里没有那 3 类的任何字面词）。
    #   ⚠️ 这里同时钉住 QOJ 那一支**比的是 `PROVINCIAL_TYPE_NONE`**：写死比 `STAGE_NONE` 的话，
    #      分支永远进不去、靠 else 混出 `未归类`（结果一样，但代码在说谎）；写错成 `无归类`
    #      会被这一条逮住。
    check('★ qoj：省赛路径 + 赛名判不出类型 ⇒ `未归类`（蓝：填写不完全，不是灰的「无归类」）',
          qoj_class_of(prov_path, ['ACM-HK Programming Contest 2026']),
          'qoj/xcpc/provincial&invitational/未归类')
    check('qoj：两支都不过 → qoj/无归类',
          qoj_class_of([{'name': 'Universal Cup'}, {'name': 'The 3rd Universal Cup'}],
                       ['Universal Cup Stage 5']), 'qoj/无归类')
    w2: list = []
    # ★ icpc 那支要带**赛区**（ec/eu/jp）才落得下来；用一个完整 EC 路径当夹具
    nanjing_path = [{'id': '2', 'name': 'ICPC'}, {'id': '17', 'name': 'Regionals'},
                    {'id': '21', 'name': 'Asia East Continent'}, {'id': '84', 'name': 'Nanjing'}]
    both = nanjing_path + [{'name': 'CCPC 联办赛'}]
    check('qoj：两支都过 ⇒ 取 icpc', qoj_class_of([both], ['某场'], w2), 'qoj/xcpc/icpc/ec/无归类')
    check_true('…并警告', len(w2) == 1 and '同时过了' in w2[0], str(w2))
    check('qoj：空路径 → qoj/无归类', qoj_class_of([], []), 'qoj/无归类')
    check('qoj：拿不到名字时写「获取数据失败」', QOJ_FETCH_FAILED, '获取数据失败')
    # ★（「像『获取数据失败』这种上游异常的情况，nature 可以用『上游异常』（灰）
    #   补充」）：`qoj:c:2624` 那一页 403 / 上游坏了 ⇒ 名字一个都拿不到，**分类也落 `上游异常`**
    #   （灰 = 判不了、判冲突时当没主张）；它**不是** `未归类`（蓝 = 等人补：这种情况根本补不出来）。
    #   这里跑真实的 2624（本地缓存里确实没有它的标题/题目名）。
    crate_up, _wu = qoj_adapter_build(contest_ids=['2624'])
    cs_up = {r['extKey']: r for r in crate_up.to_dict()['records'] if r['节点类型'] == 'C'}
    check('★ qoj：连名字都没抓到（上游异常）⇒ 分类落「上游异常」，不是「未归类」',
          (cs_up['qoj:c:2624']['name'], cs_up['qoj:c:2624']['natureClass'].split('/')[-1]),
          ('获取数据失败', '上游异常'))
    # ★ **UC 与 XCPC 两种读法各出一个节点**（用户 2026-10-07："希望 ucup 单独出节点与 extkey
    #   格式，ucup 与省赛等为同一场时就出两个节点，互不绑定与干扰"）—— 拿真实的 `qoj:c:1522`
    #   （标题 Stage 23: Shanghai、路径过 ICPC ⇒ 2023 EC-Final）验：
    #     · 基键 `qoj:c:1522` = **xcpc 读法**（EC-Final），题（P）与提交（R）都在它下面；
    #     · `qoj:c:1522:ucup` = **UC 读法**（标题那个名字 + `qoj/ucup`），**不带题不带提交**。
    crate_uc, _w = qoj_adapter_build(contest_ids=['1522', '1221'])
    recs_uc = crate_uc.to_dict()['records']
    cs = {r['extKey']: r for r in recs_uc if r['节点类型'] == 'C'}
    check_true('★ UC Stage + 有 icpc 路径 ⇒ **两个 C 节点**（`qoj:c:<id>` 与 `qoj:c:<id>:ucup`）',
               'qoj:c:1522' in cs and 'qoj:c:1522:ucup' in cs,
               str(sorted(cs)[:8]))
    check('★ 基键那份的性质 = xcpc 读法（EC-Final）', cs['qoj:c:1522'].get('natureClass'),
          'qoj/xcpc/icpc/ec/final/official')
    check_true('★ 基键那份的名字取**那一支的名字**（不是 UC 那个标题）',
               'Universal Cup' not in str(cs['qoj:c:1522'].get('name')),
               str(cs['qoj:c:1522'].get('name')))
    check('★ 基键照 xcpc 那套算年份（总决赛没日期 ⇒ `待同步`）',
          cs['qoj:c:1522'].get('natureYear'), '待同步')
    check_true('★ 基键的赛季同样照 xcpc 那套（不是 UC 的 `无`）',
               cs['qoj:c:1522'].get('natureSeason') != '无',
               str(cs['qoj:c:1522'].get('natureSeason')))
    check_true('★ 基键挂在 icpc 那条链下（别让分类与落点打架）',
               'cat-2' in str(cs['qoj:c:1522'].get('父extKey')),
               str(cs['qoj:c:1522'].get('父extKey')))
    # ---- UC 那份 ----
    check('★ `:ucup` 那份的分类 = `qoj/ucup`', cs['qoj:c:1522:ucup'].get('natureClass'),
          QOJ_UCUP_CLASS)
    check_true('★ `:ucup` 那份的名字 = UC 那个标题（不是变体名）',
               'Universal Cup' in str(cs['qoj:c:1522:ucup'].get('name')),
               str(cs['qoj:c:1522:ucup'].get('name')))
    check('★ `:ucup` 那份赛季 = `无`（UC 没有赛季概念）',
          cs['qoj:c:1522:ucup'].get('natureSeason'), '无')
    check('★ `:ucup` 那份地区 = `待填写`（与纯 UC 场次同一条判据）',
          cs['qoj:c:1522:ucup'].get('natureRegion'), '待填写')
    check_true('★ `:ucup` 那份挂在 Universal Cup 那条链下（与基键那条不同）',
               'cat-106' in str(cs['qoj:c:1522:ucup'].get('父extKey'))
               and str(cs['qoj:c:1522:ucup'].get('父extKey'))
               != str(cs['qoj:c:1522'].get('父extKey')),
               str(cs['qoj:c:1522:ucup'].get('父extKey')))
    ps = [r for r in recs_uc if r['节点类型'] == 'P']
    check_true('★ 题单只在基键那份下（`:ucup` 那份不带题）',
               any(r.get('父extKey') == 'qoj:c:1522' for r in ps)
               and not any(str(r.get('父extKey') or '').startswith('qoj:c:1522:ucup')
                           for r in ps),
               '题单挂错地方了')
    check_true('★ 提交也只在基键那份下（R 不被分到 `:ucup` 那份上）',
               all(str(r.get('父extKey') or '').startswith('qoj:c:1522:p:')
                   for r in recs_uc
                   if r['节点类型'] == 'R' and str(r.get('extKey', '')).startswith('qoj:c:1522:sub:')),
               '有 R 挂到别处了')
    check_true('★ `:ucup` 那份底下**一个题/提交都没有**',
               not any(str(r.get('父extKey') or '').startswith('qoj:c:1522:ucup')
                       for r in recs_uc),
               '`:ucup` 下面挂了东西')
    # 纯 UC 的那批（没有 xcpc 读法）**照旧一个节点 `qoj:c:<id>`** —— 不给它们再造一份
    check_true('★ 纯 UC（没有 xcpc 读法）照旧只有一个节点、`qoj/ucup`',
               cs.get('qoj:c:1221') is not None
               and cs['qoj:c:1221'].get('natureClass') == QOJ_UCUP_CLASS
               and 'qoj:c:1221:ucup' not in cs,
               '1221 → ' + str(cs.get('qoj:c:1221', {}).get('natureClass')))

    # ★ **赛季只读这一场自己那条路径**（不许把 `all_paths` 拼起来读）—— 实测 `qoj:c:1464`
    #   （2023 北京市大学生程序设计竞赛）：它还挂在
    #   `/Training Camps/Petrozavodsk Programming Camp/46th … (2024 Winter)/` 下，
    #   拼起来会读出 **2024**（还标成 A 级"权威"）⇒ 与 2024 北京那场撞进同一个年份层/组；
    #   它自己那条（省赛/北京）没有年份 ⇒ 正确结果是退到**赛名里的 2023**（C 级）。
    crate_bj, _wbj = qoj_adapter_build(contest_ids=['1464', '1668'])
    cbs = {r['extKey']: r for r in crate_bj.to_dict()['records'] if r['节点类型'] == 'C'}
    check('★ 2023 北京市赛：赛季读赛名里的 2023（不是 Petrozavodsk 那条路径里的 2024）',
          (cbs['qoj:c:1464'].get('natureSeason'),
           (cbs['qoj:c:1464'].get('分类依据') or {}).get('natureSeason')),
          ('2023', 'qoj:season-name'))
    check('★ 2024 北京市赛：赛季仍是 2024（这条是赛名给的）',
          (cbs['qoj:c:1668'].get('natureSeason'),
           (cbs['qoj:c:1668'].get('分类依据') or {}).get('natureSeason')),
          ('2024', 'qoj:season-name'))

    # ---- ★（"新增 qoj/ucup，年份=qoj端比赛时间，赛季填无"）----
    uc_path = [{'id': '106', 'name': 'Universal Cup'}, {'id': '107', 'name': 'The 1st Universal Cup'}]
    check('★ qoj：路径不过 icpc/ccpc + 标题写着 Universal Cup ⇒ `qoj/ucup`',
          qoj_class_of([uc_path], ['The 1st Universal Cup. Stage 15: Hangzhou'],
                       title='The 1st Universal Cup. Stage 15: Hangzhou'), QOJ_UCUP_CLASS)
    check('★ qoj：**UC Stage 特殊处理** —— 标题是 UC ⇒ 这一份读法是 `qoj/ucup`'
          '（哪怕路径过了 icpc；建树时**两种都用**：基键 `qoj:c:<id>` 用那份 xcpc 读法、再出一个 `qoj:c:<id>:ucup`）',
          qoj_class_of([nanjing_path], ['The 2nd Universal Cup. Stage 23: Shanghai'],
                       title='The 2nd Universal Cup. Stage 23: Shanghai'),
          QOJ_UCUP_CLASS)
    check('★ qoj：`qoj_identities()` 的第二列 = 那一支的 xcpc 读法（EC-Final）',
          qoj_adapter_identities([nanjing_path], ['The 2nd Universal Cup. Stage 23: Shanghai'],
                                 title='The 2nd Universal Cup. Stage 23: Shanghai')[1],
          'qoj/xcpc/icpc/ec/无归类')
    check('★ qoj：标题不是 UC、路径也不过 icpc ⇒ 仍是 `qoj/无归类`',
          qoj_class_of([], ['Moscow Pre-Finals Workshops 2022 Day 3'],
                       title='Moscow Pre-Finals Workshops 2022 Day 3'), 'qoj/无归类')
    check('★ qoj：`Stage 1: Qingdao`（变体名写着 2018 青岛区域赛）按规则也算 UC'
          '（"先不认名字" ⇒ 名字不作为 ICPC 身份的证据）',
          qoj_class_of([uc_path], ['The 2nd Universal Cup. Stage 1: Qingdao',
                                   'The 2018 ICPC Asia Qingdao Regional Contest (Online Session)'],
                       title='The 2nd Universal Cup. Stage 1: Qingdao'), QOJ_UCUP_CLASS)

    # ---- ★（那几条反馈的落地）----
    # ① `区域`（不带"赛"）也是 regional：`xcpc/icpc/ec/无归类` 里那 4 条全是分站赛
    check('★ 阶段：「亚洲区域西安站」这种没有"赛"字的 ⇒ regional',
          stage_of('第 47 届国际大学生程序设计竞赛亚洲区域西安站'), 'regional')
    check('★ 阶段：「区域赛合肥站 - 正式赛」⇒ regional',
          stage_of('第 48 届 ICPC 国际大学生程序设计竞赛区域赛合肥站 - 正式赛'), 'regional')
    # ② official / warm-up（"xcpc 的各分支还要细分 official/warm-up"，选方案 A：
    #    每个阶段叶子下再分、现有场次一律迁成 …/official）
    from xcpc_common import is_warmup, phase_of
    check('★ 热身赛判据：Warm Up',
          is_warmup('The 2023 ICPC Asia East Continent Final Contest. Warm Up'), True)
    check('★ 热身赛判据：Warm-up（连字符）', is_warmup('2024 CCPC Final Warm-up'), True)
    check('★ 热身赛判据：Warming up', is_warmup('Warming up Contest'), True)
    check('★ 热身赛判据：热身赛', is_warmup('第十一届中国大学生程序设计竞赛总决赛（热身赛）'), True)
    check('★ 热身赛判据：普通场次不算', is_warmup('The 47th ICPC Asia Nanjing Regional Contest'), False)
    check('★ ec final 的热身赛 ⇒ …/final/warm-up',
          xcpc_class_of('icpc', 'The 2023 ICPC Asia East Continent Final Contest (EC-Final 2023). Warm Up'),
          'xcpc/icpc/ec/final/warm-up')
    check('★ ccpc 总决赛热身赛 ⇒ ccpc/final/warm-up',
          xcpc_class_of('ccpc', '第十一届中国大学生程序设计竞赛总决赛（热身赛）'),
          'xcpc/ccpc/final/warm-up')
    check('★ 普通场次一律 …/official',
          xcpc_class_of('icpc', 'The 47th ICPC Asia Nanjing Regional Contest'),
          'xcpc/icpc/ec/regional/official')
    check('★ `无归类` 不带 official/warm-up（它没有"正式/热身"之分）',
          phase_of('xcpc/icpc/ec/无归类', 'x'), 'xcpc/icpc/ec/无归类')
    check('★ qoj 下同理（热身赛的镜像也进 warm-up）',
          qoj_class_of(icpc_path, ['The 2025 ICPC Asia East Continent Final Contest. Warm up']),
          'qoj/xcpc/icpc/ec/final/warm-up')

    # ③ ★ 只用一条主路径不够，要**充分利用所有路径**：
    #    —— `qoj:c:1093`（2022 南京站）在分类树里被发现时挂在 Universal Cup 下，
    #    但它自己还属于 `ICPC / Regionals / Asia East Continent / Nanjing`。
    uc_path = [{'id': '106', 'name': 'Universal Cup'}, {'id': '107', 'name': 'The 1st Universal Cup'}]
    check('★ qoj：看**所有路径** —— 主路径是 Universal Cup、另一条过 ICPC ⇒ 照样归类',
          qoj_class_of([uc_path, nanjing_path], ['The 2022 ICPC Asia Nanjing Regional Contest']),
          'qoj/xcpc/icpc/ec/regional/official')
    check('★ qoj：所有路径都不过 icpc/ccpc ⇒ 仍是 qoj/无归类',
          qoj_class_of([uc_path], ['The 1st Universal Cup. Stage 4: Ukraine']), 'qoj/无归类')
    # ④ 赛区从 icpc 那条路径读（缩写表：aa/ec/ap/aw/eu/la/na/ne）；
    #    Trie 里没有的赛区**停在 `qoj/xcpc/icpc`**（合法前缀，不硬塞）
    check('★ qoj：Europe ⇒ eu',
          qoj_class_of([[{'id': '2', 'name': 'ICPC'}, {'id': '17', 'name': 'Regionals'},
                         {'id': '18', 'name': 'Europe'}, {'id': '28', 'name': 'Central Europe'}]],
                       ['The 2022 ICPC Central Europe Regional Contest (CERC 2022)']),
          'qoj/xcpc/icpc/eu/regional/official')
    check('★ qoj：Asia Pacific ⇒ ap（`jp` 已并进 `ap`）',
          qoj_class_of([[{'name': 'ICPC'}, {'name': 'Regionals'}, {'name': 'Asia Pacific'},
                         {'name': 'Japan'}]], ['2020-2021 ICPC Asia Pacific - Yokohama Regional']),
          'qoj/xcpc/icpc/ap/regional/official')
    # ★ `championship` 也算**总决赛** ——
    #   ICPC 各赛区的总决赛就叫 `<region> Championship`（`Finals` 层就是放它们的）
    check('★ qoj：North America Championship ⇒ na/final（`championship` = 赛区总决赛）',
          qoj_class_of([[{'name': 'ICPC'}, {'name': 'Regionals'}, {'name': 'North America'}]],
                       ['2022-2023 ICPC North America Championship']),
          'qoj/xcpc/icpc/na/final/official')
    check('★ qoj：Latin America ⇒ la',
          qoj_class_of([[{'name': 'ICPC'}, {'name': 'Regionals'}, {'name': 'Latin America'}]],
                       ['The 2nd Universal Cup. Stage 26: Latin America']),
          'qoj/xcpc/icpc/la/无归类')
    w3: list = []
    check('★ qoj：缩写表外的赛区 ⇒ 停在 `qoj/xcpc/icpc`',
          qoj_class_of([[{'name': 'ICPC'}, {'name': 'Regionals'}, {'name': 'Antarctica'}]],
                       ['The 2026 ICPC Antarctica Regional Contest'], w3), 'qoj/xcpc/icpc')
    check_true('…并警告（"赛区不在缩写表里，等人补"）', len(w3) == 1 and '赛区' in w3[0], str(w3))
    # ⑤ 占位取值：`待同步` 是合法年份值（"qoj 的各 final 年份可以填『待同步』"）
    from crate import NATURE_PENDING_VALUES
    from xcpc_common import YEAR_TO_SYNC
    check('★ 「待同步」= crate.NATURE_PENDING_VALUES 里的那个（两处不许漂）',
          YEAR_TO_SYNC in NATURE_PENDING_VALUES, True)
    check('★ `待同步` 写得进 natureYear',
          nature_fields(('natureYear', YEAR_TO_SYNC))['natureYear'], YEAR_TO_SYNC)
    # ⑥ 带 official 的那层不影响年份判定（按前缀判）
    check('★ `…/final/official` 没日期 ⇒ 留空',
          held_year_of('xcpc/icpc/ec/final/official', '2023', ''), '')
    check('★ `…/final/warm-up` 有日期时照常用日期',
          held_year_of('qoj/xcpc/ccpc/final/warm-up', '2023', '2024.01.13'), '2024')
    # ⑦ ★ 总决赛拿不到日期 ⇒ `待同步`（"The 2017 ACM-ICPC Asia EC League Final
    #    Contest（上海大学）年份也填待同步"）—— **XCPC 那一侧同样适用**，不只是 QOJ
    from xcpc_common import xcpc_nature
    nat = xcpc_nature({'id': 'icpc'}, {'id': 'icpc2017'},
                      'The 2017 ACM-ICPC Asia EC League Final Contest （上海大学）', 'rankland')
    check('★ XCPC 总决赛没日期 ⇒ 年份写 `待同步`', nat.get('natureYear'), '待同步')
    check('…赛季照旧从 mid.id 取', nat.get('natureSeason'), '2017')
    # ★ "QOJ 分类链路口名的 20xx 也是按赛季划的…那**与年份完全无关**" ⇒
    #   **不再用赛季年顶年份**；"年份全部自动填 `待同步` 啊…怎么缺了呢" ⇒ **写 `待同步`**
    #   （不是留空 —— 空是"还没判"，而这里判过了、只是手里没有日期）。
    check('★ 分区赛没日期 ⇒ **待同步**（不再用赛季年顶、也不留空）',
          xcpc_nature({'id': 'icpc'}, {'id': 'icpc2023'},
                      'The 47th ICPC Asia Nanjing Regional Contest', 'xcpcio').get('natureYear'),
          YEAR_TO_SYNC)
    check('★ 那一格的依据 = `<渠道>:year-tbd`（D 不高；带来源前缀）',
          (xcpc_nature({'id': 'icpc'}, {'id': 'icpc2023'},
                       'The 47th ICPC Asia Nanjing Regional Contest', 'xcpcio')
           .get('分类依据') or {}).get('natureYear'), 'xcpcio:year-tbd')
    check('★ 年份/赛季的依据**带渠道**（"是谁给的"决定级别：xcpcio/pta/nk=A、rankland/srk=C）',
          (xcpc_nature({'id': 'icpc'}, {'id': 'icpc2023'},
                       'The 47th ICPC Asia Nanjing Regional Contest', 'rankland',
                       held_time='2024.03.10').get('分类依据') or {}),
          {'natureClass': 'xcpc:name-stage', 'natureYear': 'rankland:year-time',
           'natureSeason': 'rankland:season-key', 'natureRegion': 'xcpc:region-city'})
    check('★ 渠道不认识（空）⇒ 落回 `xcpc:` 前缀（来源不明 = 次档）',
          (xcpc_nature({'id': 'icpc'}, {'id': 'icpc2023'},
                       'The 47th ICPC Asia Nanjing Regional Contest', '')
           .get('分类依据') or {}).get('natureYear'), 'xcpc:year-tbd')
    check('…有开赛时间时总决赛照常用它',
          xcpc_nature({'id': 'icpc'}, {'id': 'icpc2023'},
                      'The 2023 ICPC Asia East Continent Final Contest', 'xcpcio',
                      held_time='2024.01.13').get('natureYear'), '2024')

    # ★ 年份（举办）**只认开赛时间**（不用"赛季年顶"那条口径）
    check('举办年份：有开赛时间就用它',
          held_year_of('xcpc/icpc/ec/regional/official', '2023', '2024.03.10'), '2024')
    check('★ 没有开赛时间 ⇒ **留空**（赛季与举办年份是两件事）',
          held_year_of('xcpc/icpc/ec/regional/official', '2023', ''), '')
    check('EC-Final 没日期同样留空（口径统一了）',
          held_year_of('xcpc/icpc/ec/final/official', '2023', ''), '')
    check('CCPC Final 同理', held_year_of('xcpc/ccpc/final/official', '2023', ''), '')
    check('EC-Final 有开赛时间时照常用它',
          held_year_of('xcpc/icpc/ec/final/official', '2023', '2024.01.13'), '2024')
    check('qoj 镜像同理（没日期就留空）',
          held_year_of('qoj/xcpc/icpc/ec/final/official', '2023', ''), '')
    check('★ QOJ 的普通场次也从 **QOJ 端日期**取，取不到就留空（不再从赛季反推）',
          held_year_of('qoj/xcpc/icpc/ec/regional/official', '2023', ''), '')
    check('…有日期时照常用日期',
          held_year_of('qoj/xcpc/icpc/ec/final/official', '2023', '2024.01.13'), '2024')

    # ---- 总决赛窗口规则：赛季 X 的总决赛在 X 年 9 月 ~ X+1 年 8 月 ----
    check('窗口：X 年 9 月办 ⇒ 赛季 X', season_of_held('2024.09.01'), '2024')
    check('窗口：X+1 年 1 月办 ⇒ 赛季 X', season_of_held('2024.01.13'), '2023')
    check('窗口：X+1 年 8 月办 ⇒ 赛季 X', season_of_held('2023.08.31'), '2022')
    check('窗口：X+1 年 7 月办 ⇒ 赛季 X（2021 赛季的 EC-Final 在 2022-07）',
          season_of_held('2022.07.20'), '2021')
    check('窗口：X 年 12 月办 ⇒ 赛季 X（2024 赛季的 EC-Final 在 2024-12-28）',
          season_of_held('2024.12.28'), '2024')
    check('窗口：没有日期 ⇒ 空', season_of_held(''), '')
    check('窗口判定：赛季与日期一致', in_final_window('2023', '2024.01.13'), True)
    check('窗口判定：差两年（疫情延期那种）⇒ False', in_final_window('2019', '2021.04.18'), False)

    # ---- 产出**一律**是注册表里的合法路径（规则不许吐出 Trie 外的值）----
    produced = [xcpc_class_of(s, n, 'xcpcio') for s in ('icpc', 'ccpc', 'prov', '')
                for n in ('2024 网络赛', '2024 Final', '2024 区域赛', '某某杯', '', '女生专场',
                          '高职专场', '第六届中国大学生程序设计竞赛（秦皇岛）正式赛',
                          '2024 北京市大学生程序设计竞赛')]
    produced += [qoj_class_of(icpc_path, ['2024 Online']), qoj_class_of(ccpc_path, ['2024 Final']),
                 qoj_class_of(prov_path, ['2024 Provincial']), qoj_class_of([], [])]
    bad = []
    for cls in produced:
        try:
            nature_fields(('natureClass', cls))
        except ValueError as exc:                      # noqa: PERF203 —— 报出来更好排查
            bad.append(f'{cls}: {exc}')
    check_true('★ 规则产出的每个分类都过注册表 Trie', not bad, '；'.join(bad[:3]))


def test_read_modes():
    """通用读取层（`Scaper/lib/read_modes.py`）的**离线模式** ——
    "建包要那么久吗" ⇒ 加了 `--offline` / `CACHE_OFFLINE`。这里钉住它的四条语义。"""
    import read_modes as rm
    import socket as sk

    print('\n[7] 通用读取层：离线模式（--offline = 一次也不联网）')
    rm.configure()                                   # 回到"没配过"的干净状态
    check_true('默认不离线', not rm.offline())
    check('默认（KEEP）时：本地有就不重抓、没有才联网',
          (rm.should_refetch(True), rm.should_refetch(False)), (False, True))

    # ① 离线：不管本地有没有，**一律不联网**（调用方读到 False 就会去读本地）
    rm.configure(offline=True)
    check_true('offline() 认得出这次是离线', rm.offline())
    check('离线时 active_cache() = `offline`', rm.active_cache(), rm.CACHE_OFFLINE)
    check('离线时 should_refetch 对谁都 False（本地有没有都不联网）',
          (rm.should_refetch(True), rm.should_refetch(False)), (False, False))
    check('离线不算"无新值截断"（压根没联网）', rm.should_stop_on_no_new(rm.CACHE_OFFLINE), False)

    # ② 缺文件必须**当场报错**，不能静默出缺数据的包
    here = os.path.abspath(__file__)
    rm.require_local(here, '本自测文件')                # 在 ⇒ 空操作（不抛）
    check_true('require_local(在) 不抛', True)
    try:
        rm.require_local(os.path.join(os.path.dirname(here), '绝不存在_offline_selftest.json'),
                         '某份清单')
        check_true('require_local(不在) 应该抛 SystemExit', False)
    except SystemExit as e:
        check_true('require_local(不在) 报的是人话（提到 --offline 与先在线跑一次）',
                   '--offline' in str(e) and '先不带' in str(e), str(e)[:80])
    check_true('在线时 require_local 是空操作（调用方照旧联网）',
               (rm.configure(), rm.require_local('/绝不存在/x.json', 'x'), True)[-1])

    # ③ 离线时连"读一页"都不许碰网络：fetch 一旦被调用就说明漏了
    rm.configure(offline=True)
    called = []

    def boom(url, cookie):
        called.append(url)
        raise AssertionError('离线模式竟然联网了')

    got = rm.read_page(key='k', kind='contest', url='http://example.invalid',
                       fetch=boom, load=lambda k, kind: '', save=None,
                       cache=rm.active_cache())     # ⚠️ 策略要**显式**传进来（`read_page` 不自己解析）
    check('离线 + 本地没有 ⇒ 返回空串且**没有**联网', (got, called), ('', []))

    # ③b ★ 那一页"没拿到"必须**看得见**：
    #     `read_page` 只写一行 stderr，数字一多就淹了 ⇒ `print_stats` 结尾要补一行 ❌。
    #     ⚠️ 顺手钉住"**故意不改退出码**"这条口径（缺页在线模式也可能是正常的，
    #     要不要致命由调用方用 `require_local()` 决定），别再有人把它改成 exit 1。
    buf = io.StringIO()
    keep_err = sys.stderr
    sys.stderr = buf
    before_failed = rm.stats()['failed']
    try:
        s = rm.print_stats('自测')
    finally:
        sys.stderr = keep_err
    check_true('有失败 ⇒ print_stats 补一行 ❌「没拿到」（数字里淹不掉）',
               '没拿到' in buf.getvalue(), buf.getvalue()[:90])
    check_true('而且那行点了"必需的读取点该用 require_local()"',
               'require_local' in buf.getvalue(), buf.getvalue()[:90])
    # ⚠️ 这一条比的是**前后差值**（不是绝对值）：`print_stats` 自己**不许多记一笔**失败。
    #    "整趟"的起点由 `configure_from` 定 —— 见下面那条「configure_from 之后统计归零」。
    check('print_stats 不额外多记失败（前后差值 0）', s['failed'] - before_failed, 0)

    # ③c ★ **离线时 `retry_call` 当场拦下**（实测逮到的那一族）：
    #     各渠道自己写 `should_refetch()` 守卫是对的，但"忘一处就静默联网"——
    #     实测 `atcoder_adapter.load_submissions` 把 `should_refetch()` 只用在水位线上，
    #     `--offline` 重跑照样打 kenkoooo。所以"一次也不联网"不能只靠每个渠道自觉，
    #     要走同一个 choke point：凡经 `retry_call` 的网络调用，离线时在这里就被挡下。
    tried = []

    def boom_fetch(**kw):                                        # noqa: ARG001
        tried.append('联网了')
        return 'x'

    try:
        rm.retry_call(boom_fetch, what='某接口', tries=3, sleep=0)
        check_true('离线时 retry_call 应该当场退出', False)
    except SystemExit as e:
        check_true('★ 离线时 retry_call 当场退出，且 **fn 一次都没被调用**（兜底不靠各渠道自觉）',
                   '离线' in str(e) and not tried, f'{str(e)[:60]} / tried={tried}')

    # ③d `where` 里的凭据不许进重试日志（同一套 `safe_where`，这里连重试那行一起钉住）
    rm.configure()                                   # 回到在线（重试日志才走得到）
    out_buf = io.StringIO()
    keep_out = sys.stdout
    sys.stdout = out_buf
    try:
        rm.retry_call(lambda **kw: (_ for _ in ()).throw(RuntimeError('boom')),   # noqa: ARG005
                      what='https://codeforces.com/api/x?apiKey=NmQ3Zk9uZUtleTEyMw',
                      tries=2, sleep=0)
    except RuntimeError:
        pass
    finally:
        sys.stdout = keep_out
    check_true('★ 重试日志里的 `where` 也过 safe_where（凭据不进日志）',
               'NmQ3Zk9uZUtleTEyMw' not in out_buf.getvalue()
               and '↻' in out_buf.getvalue() and 'codeforces.com/api/x' in out_buf.getvalue(),
               repr(out_buf.getvalue()[:110]))

    # ③e ★ 兜底闸门（"收成一处"）：离线时**任何**往外连都被拦下 ——
    #     不靠"每个渠道都记得加 should_refetch()"，也不管它走不走 `retry_call`
    #     （仓里还有 ~28 处直连 `urllib`，"联网 N 次"的统计压根看不见它们）。
    pristine = sk.create_connection          # ⚠️ 要在**装闸门之前**抓（装完再抓就是把闸门当原样）
    rm.configure(offline=True)
    try:
        sk.create_connection(('example.invalid', 80))
        check_true('离线时 create_connection 应该当场报错', False)
    except SystemExit as e:
        check_true('★ 离线时往外连**当场报错**，并指出**调用点**（不是标准库/共用件那几帧）',
                   'example.invalid' in str(e) and 'selftest.py' in str(e),
                   str(e).splitlines()[0][:80])
    except Exception as e:                       # noqa: BLE001 —— 真去连了（闸门没装）⇒ 也算红，但要说清
        check_true('离线时往外连要被**闸门**拦下（SystemExit），而不是真去连',
                   False, f'{type(e).__name__}: {e}')
    s = sk.socket(sk.AF_INET, sk.SOCK_STREAM)
    try:
        s.connect(('example.invalid', 80))
        check_true('离线时 socket.connect 应该当场报错', False)
    except SystemExit:
        check_true('★ 离线时 socket.connect 也被拦（直连 urllib 那 ~28 处走的就是它）', True)
    except Exception as e:                       # noqa: BLE001
        check_true('离线时 socket.connect 也要被闸门拦下（SystemExit）',
                   False, f'{type(e).__name__}: {e}')
    finally:
        s.close()
    check_true('在线时闸门卸干净（socket.create_connection 回到原样）',
               (rm.configure(), sk.create_connection is pristine)[-1])

    # ④ 开关互斥：一个是"只用本地"、一个是"忽略本地重抓"，同时给就报错
    for kwargs, why in (({'offline': True, 'force': True}, 'force'),
                        ({'offline': True, 'cache': rm.CACHE_KEEP}, 'cache-mode keep')):
        try:
            rm.configure(**kwargs)
            check_true(f'--offline 与 {why} 同时给应该报错', False)
        except ValueError as e:
            check_true(f'--offline 与 {why} 同时给报 ValueError', '互斥' in str(e), str(e)[:60])

    # ⑤ 环境变量那条路（流水线要给 600+ 个子进程传，见 OFFLINE_ENV）
    for value, want in (('1', True), ('0', False), ('', False)):
        os.environ[rm.OFFLINE_ENV] = value
        rm.configure()
        check(f'{rm.OFFLINE_ENV}={value!r} ⇒ offline={want}', rm.offline(), want)
    os.environ.pop(rm.OFFLINE_ENV, None)

    # ⑥ 父进程传下来的离线也不许和 --force 并存
    os.environ[rm.OFFLINE_ENV] = '1'
    try:
        rm.configure(force=True)
        check_true('环境变量离线 + --force 应该报错', False)
    except ValueError as e:
        check_true('环境变量离线 + --force 报 ValueError', '互斥' in str(e), str(e)[:60])
    finally:
        os.environ.pop(rm.OFFLINE_ENV, None)

    # ⑦ configure_from（argparse 那条路）认 `--offline`
    class _Args:
        cache_mode = None
        retry_mode = None
        force = False
        offline = True

    check('configure_from(--offline) 生效', rm.configure_from(_Args()).get('cache'), rm.CACHE_OFFLINE)

    # ⑦b ★ 统计的粒度 = **一次运行**（`configure_from` 会清零；2026-10-16 修，审计翻出来的）：
    #    链子里的 `.py` 步骤在**应用那个长驻进程**里是 `runpy` **就地**跑的（`build_chain.run_step`，
    #    不是子进程）⇒ 模块级 `_STATS/_T0` 会跨步骤、跨多次构建累加：每步打出来的数字其实是
    #    "这个进程至今"，那句 `❌ 有 N 页没拿到` 也**永远回不到 0**。
    rm._STATS['failed'] = 3                          # 造一个脏值（不必真去失败）
    rm.configure_from(_Args())
    s2 = rm.stats()
    check('★ configure_from 之后统计归零（统计的粒度 = 一次运行）', (s2['failed'], s2['pages']), (0, 0))
    rm.configure()                                   # 收尾：别把策略漏给后面的用例


def test_auth_state():
    """
    **登录态判据**（`Scaper/lib/auth_state.py`）—— "cookie 过期这种情况
    值得一个模块去处理"。这里钉住四件事：

      ① 每平台"过期"长什么样都按**实测**判（QOJ 302→login / clist 401 / CF 正文 comment / PTA 401）；
      ② **被拦 ≠ 过期**：403+Cloudflare 要说"不是凭据问题"，**不许**让人去改 me.json；
      ③ 反面教材：牛客正常页面的导航里就有 `login` ⇒ 200 + 那个词必须是 **ok**（别误报）；
      ④ **过期不重试、当场停**：`read_modes.read_page` / `retry_call` 遇到 `AuthError` 只试一次。
    """
    import auth_state as A
    import read_modes as rm

    print('\n[8] 登录态（cookie / apiKey）：过期长什么样、以及"当场停"')

    def resp(status=200, url='https://example.test/', location='', body=''):
        return A.from_http(status, url, location, body)

    # ① 实测到的四种"过期"长相
    check('QOJ：302 → //qoj.ac/login ⇒ 过期', A.state_of('qoj', resp(302, location='//qoj.ac/login')),
          A.EXPIRED)
    check('QOJ：正常提交页（200 + table-bordered）⇒ 好',
          A.state_of('qoj', resp(200, body='<table class="table-bordered">')), A.OK)
    check('clist：401 + 0 字节 ⇒ 过期', A.state_of('clist', resp(401)), A.EXPIRED)
    check('CF：正文 `Incorrect API key` ⇒ 过期',
          A.state_of('cf', resp(400, body='{"status":"FAILED","comment":"apiKey: Incorrect API key"}')),
          A.EXPIRED)
    check('PTA：401 + `USER_NOT_LOGGED_IN` ⇒ 过期',
          A.state_of('pta', resp(401, body='{"error":{"code":"USER_NOT_LOGGED_IN"}}')), A.EXPIRED)

    # ② 被拦（限流 / Cloudflare）**不是**凭据问题
    check('CF：`Too many requests` ⇒ 被拦（不是过期）',
          A.state_of('cf', resp(400, body='{"comment":"Too many requests"}')), A.BLOCKED)
    check('QOJ：403 + Cloudflare 验证页 ⇒ 被拦',
          A.state_of('qoj', resp(403, body='<title>Just a moment...</title>')), A.BLOCKED)
    blocked_text = A.explain('qoj', resp(403, body='Just a moment...'))
    check_true('被拦的那句话明说"不是凭据的问题"，且**不出现**该平台的凭据键（别让人去改它）',
               '不是凭据的问题' in blocked_text and 'qoj.cookie' not in blocked_text,
               blocked_text[:80])

    # ③ 反面教材：正常页面里出现 `login` 这个词**不能**当判据（牛客就长这样）
    nk_page = ('<html><head><title>比赛</title></head><body>'
               '<a href="/login">login</a> 提交列表</body></html>')
    check('牛客：200 + 正文里有 `login`（导航链接）⇒ **仍然算好**（别误报）',
          A.state_of('nk', resp(200, body=nk_page)), A.OK)
    check('表里没有的平台 / 没有响应 ⇒ 一律 ok（宁可漏报，别乱报）',
          (A.state_of('不存在的站', resp(302, location='/login')), A.state_of('qoj', None)),
          (A.OK, A.OK))

    # ④ 给人看的那句话：过期 ⇒ 指到具体凭据 + 怎么拿；并且提醒"重跑不会重抓"
    text = str(A.AuthError('qoj', resp(302, location='//qoj.ac/login'), where='第 1 页'))
    check_true('过期的话里有：me.json + `qoj.cookie` + 怎么拿 + 重跑不重抓',
               all(s in text for s in ('me.json', 'qoj.cookie', 'F12', '不会重抓')), text[:100])

    # ⑤ `raise_if_bad`：好页原样给回正文；坏页抛 AuthError
    check('raise_if_bad 好页 ⇒ 原样返回正文',
          A.raise_if_bad('qoj', resp(200, body='<table class="table-bordered">hi')),
          '<table class="table-bordered">hi')
    try:
        A.raise_if_bad('qoj', resp(302, location='//qoj.ac/login'))
        check_true('raise_if_bad 坏页应该抛 AuthError', False)
    except A.AuthError as e:
        check_true('raise_if_bad 坏页抛 AuthError（带那句话）', 'qoj.cookie' in str(e))
    # `guard_body`：只拿得到正文的渠道（CF 就长这样）
    try:
        A.guard_body('cf', '{"comment":"Incorrect signature"}', where='api')
        check_true('guard_body 过期应该抛', False)
    except A.AuthError:
        check_true('guard_body 过期抛 AuthError', True)

    # ⑥ ★ **过期 ⇒ 只试一次、当场停**（"别让 20–75 页跑到一半才发现"）
    calls = []

    def dead(url, cookie):
        calls.append(url)
        raise A.AuthError('qoj', resp(302, location='//qoj.ac/login'))

    try:
        rm.read_page(key='k', kind='contest', url='http://example.invalid', fetch=dead,
                     load=lambda k, kind: '', save=None, cache=rm.CACHE_KEEP, retry=rm.RETRY_RETRY)
        check_true('read_page 遇到 AuthError 应该 SystemExit', False)
    except SystemExit as e:
        check('read_page 遇到 AuthError ⇒ SystemExit(2)（当场停）', getattr(e, 'code', None), 2)
    check('★ 而且**只联网一次**（默认 retry 会试 3 次 —— 过期重试没意义）', len(calls), 1)

    def dead_call(**kw):
        calls.append('retry_call')
        raise A.AuthError('clist', resp(401))

    calls.clear()
    try:
        rm.retry_call(dead_call, what='clist')
        check_true('retry_call 遇到 AuthError 应该抛出去', False)
    except A.AuthError:
        check('★ retry_call 遇到 AuthError：**不重试**、原样抛给 main（只试 1 次）', len(calls), 1)

    # ⑦ ★ `where` 不许把凭据带进报错/日志
    #    调用点惯例是 `where=url`，而 CF 的 **`apiKey` / `apiSig` 就在查询串里**
    #    ⇒ 过期时那句话会把凭据写进日志。现在 `AuthError` 里统一过 `safe_where()`。
    check('safe_where：砍掉查询串（CF 的 apiKey/apiSig 就在这里）',
          A.safe_where('https://codeforces.com/api/user.status?apiKey=SECRET&apiSig=abc'),
          'https://codeforces.com/api/user.status')
    check('safe_where：方法名/普通标签原样', A.safe_where('cf_api.user.status'), 'cf_api.user.status')
    check('safe_where：空 ⇒ 空', A.safe_where(''), '')
    # ⚠️ 占位值要**唯一**：别用 `SECRET` 这种词 —— `explain()` 里本来就有 `CF_API_SECRET`
    #    （大写 SECRET 是它的子串）⇒ 断言会假红（实测踩到）。
    dirty = 'https://codeforces.com/api/x?apiKey=NmQ3Zk9uZUtleTEyMw'
    err_text = str(A.AuthError('cf', resp(400, body='{"comment":"apiKey: Incorrect API key"}'),
                               where=dirty))
    check_true('★ AuthError 正文里**没有**凭据，但仍有"发生在哪"',
               'NmQ3Zk9uZUtleTEyMw' not in err_text and 'codeforces.com/api/x' in err_text,
               repr(err_text[:120]))


def test_empty_source_result():
    """
    "这条源这次没产出记录"的统一处理。

    病根：qoj / atcoder / cf-contest 三个适配器都写成"**删掉**上一份片段 + 返回 0" ——
    上游空转一次（提交文件被截断、API 返回空），已归档的整条源就没了，
    而这一趟还报成功（实测症状：混装包里 qoj 那一支整棵消失）。

    这里钉两件事：① 有上一份片段时**一个字都不许动**它，返回 0（沿用已有数据）；
    ② 没有上一份片段时**也返回 0**（非零会把整条链掐断 —— 默认 `--force` 会先删片段，
       所以"没有上一份"是必然的），但必须在 stderr 上**说响**（❌ + "这条源这次会缺"）。
    ⚠️ 中间文件写在 `cache/` 下，别用 `tempfile.mkdtemp`（那种目录 0700 ACL，
    在本仓库的沙箱里写不进也删不掉 —— 见本文件 test_merge 那段注释）。
    """
    from xcpc_common import CACHE, empty_source_result
    path = os.path.join(CACHE, '_selftest_empty_source.json')
    try:
        if os.path.isfile(path):
            os.remove(path)
        # ① 没有上一份片段 ⇒ **也不许非零退出**（否则默认 `--force` 跑法会把整条链掐断：
        #    管线先删片段 ⇒ "没有上一份"是必然的），但必须把话说响
        buf = io.StringIO()
        keep_err = sys.stderr
        sys.stderr = buf
        try:
            code_none = empty_source_result(path, ['w1'])
        finally:
            sys.stderr = keep_err
        check('没有上一份片段 ⇒ 返回 0（不炸链子：与管线"空来源不算失败"同口径）', code_none, 0)
        check_true('★ 但必须**说响**（❌ + 这条源这次会缺）',
                   '❌' in buf.getvalue() and '这条源这次会缺' in buf.getvalue(),
                   buf.getvalue()[:90])
        check('而且它**没有**凭空造出一个空片段', os.path.isfile(path), False)

        # ② 有上一份片段 ⇒ 保留原文 + 返回 0
        keep = '{"crateVersion": 1, "records": [{"节点类型": "W"}]}\n'
        with open(path, 'w', encoding='utf-8', newline='\n') as f:
            f.write(keep)
        check('有上一份片段 ⇒ 返回 0（沿用上一份）', empty_source_result(path, ['w1', 'w2']), 0)
        got = open(path, encoding='utf-8').read() if os.path.isfile(path) else '（文件被删了！）'
        check('★ 上一份片段**一字未动**（"这次没拿到" ≠ "没有"）', got, keep)
    finally:
        if os.path.isfile(path):
            os.remove(path)


def test_cf_api_rate_limit():
    """
    CF 限流（429 / `Too many requests`）必须走**退避重试**那条路。

    病根：这一条在共用件里是"被拦（BLOCKED）"，而 `_call_once` 直接把它交给
    `guard_body` ⇒ 抛 `AuthError` ⇒ `call` 的 `except CfError` **接不到** ——
    文档里那句"被限流就退避重试"**永不生效**：一次瞬时限流会被当成"凭据被拦"，
    `read_page` 收到 AuthError 就 `SystemExit(2)` 把整趟抓取当场停掉。

    怎么测：把 `urlopen` 换成"每次都 429"、把退避与限速打成空转，看
    ① 抛的是 `CfError`（可重试）而不是 `AuthError`；② **真的重试了**（retries=1 ⇒ 打两次）。
    """
    import io
    import urllib.error
    import cf_api

    calls = []

    def fake_urlopen(req, timeout=None):                      # noqa: ARG001
        calls.append(req.full_url.split('?')[0])
        raise urllib.error.HTTPError(
            req.full_url, 429, 'Too many requests', {},
            io.BytesIO(b'{"status":"FAILED","comment":"Too many requests"}'))

    real_urlopen = cf_api.urllib.request.urlopen
    real_sleep = cf_api.time.sleep
    real_throttle = cf_api._throttle
    cf_api.urllib.request.urlopen = fake_urlopen
    cf_api.time.sleep = lambda _s: None                       # 退避别真等
    cf_api._throttle = lambda: None
    try:
        try:
            cf_api.call('contest.standings', {'contestId': 1}, retries=1)
            verdict = '没抛（静默返回了：更糟）'
        except cf_api.CfError as e:
            verdict = 'CfError' if 'Too many requests' in str(e) else f'CfError，但话不对：{e}'
        except Exception as e:                                # noqa: BLE001
            # `auth_state.AuthError` 落这一支：那正说明"被当成了凭据问题"
            verdict = f'{type(e).__name__}（AuthError = 被当成凭据被拦）'
    finally:
        cf_api.urllib.request.urlopen = real_urlopen
        cf_api.time.sleep = real_sleep
        cf_api._throttle = real_throttle
    check('★ 429 ⇒ 可重试的 CfError（不是 AuthError）', verdict, 'CfError')
    check('★ 而且**真的重试了**（退避那条路活着：retries=1 ⇒ 打两次）', len(calls), 2)


def test_batch_hard_stop():
    """
    `lib/batch.py`：**退出码 2 = "当场停"**。

    病根：`read_modes.read_page` 遇到凭据过期/被拦会 `SystemExit(2)`，而 `batch.main`
    把**一切非零压成 1** ⇒ "凭据过期"变得和"某一场失败"没区别，后面的场次还会
    拿着死凭据一路空转（"别让 20–75 页跑到一半才发现"）。

    这里用两个**假适配器**真跑一遍批处理：
      · 第一个 `SystemExit(2)`；
      · 第二个**只要被跑到就会写一个标记文件**。
    断言：返回码 2、且那个标记文件**不存在**（= 剩下的场次真的没跑）。
    ⚠️ 中间文件写在 `cache/` 下（`tempfile.mkdtemp` 那种 0700 目录在本仓库沙箱里写不进）。
    """
    import batch as batch_mod

    hard_mod = os.path.join(CACHE, '_selftest_hard_stop_mod.py')
    next_mod = os.path.join(CACHE, '_selftest_must_not_run_mod.py')
    marker = os.path.join(CACHE, '_selftest_must_not_run.marker')
    jobs_file = os.path.join(CACHE, '_selftest_hard_stop_jobs.json')
    try:
        with open(hard_mod, 'w', encoding='utf-8', newline='\n') as f:
            f.write('def main(argv):\n    raise SystemExit(2)\n')
        with open(next_mod, 'w', encoding='utf-8', newline='\n') as f:
            f.write(f'def main(argv):\n    open({marker!r}, "a", encoding="utf-8").write("ran")\n    return 0\n')
        with open(jobs_file, 'w', encoding='utf-8', newline='\n') as f:
            json.dump([{'slug': 'hard', 'module': hard_mod, 'argv': []},
                       {'slug': 'next', 'module': next_mod, 'argv': []}], f)
        if os.path.isfile(marker):
            os.remove(marker)
        code = batch_mod.main(['--jobs', jobs_file])
        check('★ 凭据/原料那一类 ⇒ 批处理返回 2（别压成 1）', code, batch_mod.HARD_STOP)
        check('★ 而且**不再跑剩下的场次**（下一个适配器没被执行）',
              os.path.isfile(marker), False)
    finally:
        for p in (hard_mod, next_mod, marker, jobs_file):
            if os.path.isfile(p):
                os.remove(p)


def _asset_path_offenders(text: str) -> list:
    """
    "gym_whitelist.json 的文件名出现在这段源码里"的行号（`test_shared_asset_paths` 的判据）。

    两种情况都算：
      ① 真在拼路径：带引号的文件名 + `os.path.join`
      ② **把文件名赋值给变量**：`_FILE = 'gym_whitelist' + '.json'` 拆两行就躲过 ①
         （守卫审计逮到）
    注释里提不算（本仓注释里常出现这类文件名）。
    """
    out = []
    for i, line in enumerate(text.split('\n'), 1):
        code = line.split('#', 1)[0]
        if re.search(r"""['"]gym_whitelist\.json['"]""", code) and 'os.path.join' in code:
            out.append(i)
        elif re.search(r"""^\s*[A-Za-z_]\w*\s*=\s*['"][^'"]*gym_whitelist""", code):
            out.append(f'{i}（把文件名赋值给变量了 —— 应直接用 GYM_WHITELIST）')
    return out


def test_shared_asset_paths():
    """
    "人工维护的那几个人读文件"的**路径只有一处**。

    `gym_whitelist.json` 的路径若在 5 个文件里各拼一遍（`os.path.join(HERE, …)`）——
    换一处、或者把文件挪个位置，就得记得改 5 处，漏一个就是"白名单读不到、静默少几场"。
    所以只留 `xcpc_common.GYM_WHITELIST` 一处。
    """
    bad = []
    # ⚠️ 跳过 `xcpc_common.py`（常量就住那儿）与**本文件**（下面这两行文字里就有那个文件名）
    skip = {'xcpc_common.py', 'selftest.py'}
    for d in (HERE, os.path.join(HERE, 'lib')):
        for name in sorted(os.listdir(d)):
            if not name.endswith('.py') or name in skip:
                continue
            path = os.path.join(d, name)
            with open(path, encoding='utf-8') as fh:
                for hit in _asset_path_offenders(fh.read()):
                    bad.append(f'{os.path.relpath(path, HERE)}:{hit}')
    check('★ gym_whitelist 的路径只在 xcpc_common.py 拼（别处 import GYM_WHITELIST）', bad, [])
    check('那个常量指向真实文件', os.path.isfile(GYM_WHITELIST), True)
    # ★ 自检：证明这条 lint 真的会咬（两种躲法 + 注释不该误伤）
    check('自检：`os.path.join(..., "gym_whitelist.json")` 必须被抓',
          len(_asset_path_offenders("P = os.path.join(HERE, 'gym_whitelist.json')\n")) > 0, True)
    check("自检：拆成 `'gym_whitelist' + '.json'` 赋给变量也躲不掉",
          len(_asset_path_offenders("_F = 'gym_whitelist' + '.json'\n")) > 0, True)
    check('自检：只在注释里提文件名不该误伤',
          _asset_path_offenders("# 以前是 os.path.join(HERE, 'gym_whitelist.json')\nx = 1\n"), [])


def test_root_platform_src():
    """
    共享根容器的**显示名**出处统一写 `xcpc_common.ROOT_SRC`。

    为什么：`crate.py` 里条目的出处**缺省 = 本包的来源 id**，而 `aux` / `aux-*` / `cf` 这些根容器
    **每棵子树的片段都会顺手声明一遍** ⇒ "谁先被合并进来"就决定了名字的出处。实测：
    13 个根容器里 9 个的 `name` 出处是某个**具体比赛**（`xcpcio-bjcpc2024` / `cf-web-ccpc2019final` …），
    语义不对、而且换一种输入组织方式就换一个值（"拍平"与"两段式"合并结果差 2 条记录）。

    所有声明都带 `**PLATFORM_NAME_SRC`。这里钉两条：
      ① 行为：`open_tree` 出来的 `aux` / `aux-<渠道>` 两层的 `字段来源` 就是那个常量；
      ② 源码级 lint：**再有人加一处"共享根容器"的声明却忘了带 `PLATFORM_NAME_SRC`** ⇒ 红。
    """
    import crate as crate_mod
    from xcpc_common import PLATFORM_NAME_SRC, ROOT_SRC, open_tree

    cr = crate_mod.Crate('selftest-root-src')
    tree = open_tree(cr, 'pta')
    recs = {r['extKey']: r for r in cr.to_dict()['records'] if r.get('节点类型') == 'W'}
    check('① open_tree 的 aux 层带上了显式出处', (recs.get('aux') or {}).get('字段来源'), PLATFORM_NAME_SRC['字段来源'])
    check('① open_tree 的渠道层也带上了', (recs.get(tree) or {}).get('字段来源'), PLATFORM_NAME_SRC['字段来源'])

    # ② 源码级 lint：声明共享根容器（`platform('cf'` / `platform(AUX_ROOT` / `platform(CF_PLATFORM`）
    #    的那些行必须带 PLATFORM_NAME_SRC。⚠️ 只查"根容器"那几种写法，adapters 里给别的小 W 节点
    #    起名不在这个规则里。
    bad = []
    pattern = re.compile(r"\.platform\(\s*(AUX_ROOT|[A-Z][A-Z_]*_PLATFORM|'cf'|\"cf\")")
    for d in (HERE, os.path.join(HERE, 'lib')):
        for name in sorted(os.listdir(d)):
            if not name.endswith('.py') or name == 'selftest.py':
                continue
            path = os.path.join(d, name)
            with open(path, encoding='utf-8') as fh:
                for i, line in enumerate(fh, 1):
                    if pattern.search(line) and 'root_name_src' not in line:
                        bad.append(f'{os.path.relpath(path, HERE)}:{i}')
    check('② 每个"共享根容器"的声明都带 root_name_src（漏一处就红）', bad, [])
    check('常量本身是那个词', ROOT_SRC, 'xcpc-common')


def test_no_docs_in_cache():
    """
    ★ `05 xcpc/cache/` 里**不许放手写文档**（`.md`）—— 2026-10-19 用户："这些也属于注册表，请尝试收纳"。

    病根是**两个工具对同一批文件口径不一致**，而且静默：
      · `clean-personal`（发布副本的判据）把 `.md` 一律当"源码/文档，永不删" ⇒ 副本里**有**它们；
      · `.gitignore` 把 `app/acm-data/raw/**/cache/` **整段**忽略 ⇒ 推上 GitHub 的仓库里**没有**它们。
    实测（2026-10-19 那一轮发布）：副本 678 文件，`git add -A` 只暂存 **675** —— 差的三个正是
    `cf_gym_approve_2022-2025.md` / `cf_gym_judge_2022-2025.md` / `cf_gym_recommend.md`
    （CF gym 的批准/逐条判断/推荐清单：**哪几场该收**，是注册表级知识、不是可重抓的缓存）。
    ⇒ 已搬去 `05 xcpc/`（与 `_usage.md` / `_rankland_slugs.md` 并排、与 `xcpc_registry.json` 同层）。
    这条反过来钉住"别再把文档写回 `cache/`"：`cache/` 里出现任何 `.md` ⇒ 红。
    （`_pieces_*.txt` 是产包中间产物，照样允许。）
    """
    stray = sorted(n for n in os.listdir(CACHE) if n.lower().endswith('.md'))
    check('cache/ 里不许放手写文档（.md 会被 .gitignore 静默丢掉、进不了发布包）', stray, [])


def test_rankland_config_cache():
    """
    `rankland_tree.fetch_config_text()` 的缓存口径必须**与全仓一致**。

    它若按"文件在就用它"：`--force` 跑法会拿到上一轮的配置，而 `--offline` 在缓存缺失时
    还会**偷偷联网**。所以一律问 `read_modes`（`should_refetch` / `require_local`）。
    三条：① 有缓存 + 正常 ⇒ 不联网；② 有缓存 + `--force` ⇒ **重抓**；③ 没缓存 + 离线 ⇒ 报错、不联网。
    """
    import base64 as _b64
    import importlib
    import read_modes as rm
    rt = importlib.import_module('rankland_tree')

    path = os.path.join(CACHE, '_selftest_rankland_config.yaml')
    calls = []

    def fake_get(url, timeout=60):                                   # noqa: ARG001
        calls.append(url)
        body = _b64.b64encode(b'path: selftest\n').decode()
        return json.dumps({'content': body}).encode('utf-8')

    real_get = rt._get
    rt._get = fake_get
    try:
        with open(path, 'w', encoding='utf-8', newline='\n') as f:
            f.write('path: cached\n')

        rm.configure()
        check('① 有缓存 + 正常模式 ⇒ 用缓存（不联网）', (rt.fetch_config_text(path), calls), ('path: cached\n', []))

        rm.configure(force=True)
        got = rt.fetch_config_text(path)
        check('② 有缓存 + --force ⇒ **重抓**（不再拿上一轮的）', (got, len(calls)), ('path: selftest\n', 1))
        with open(path, encoding='utf-8') as f:
            check('   而且新抓到的写回了缓存', f.read(), 'path: selftest\n')

        os.remove(path)
        rm.configure(offline=True)
        calls.clear()
        try:
            rt.fetch_config_text(path)
            check_true('③ 没缓存 + 离线 ⇒ 应该当场报错（不许联网）', False)
        except SystemExit as e:
            check_true('③ 没缓存 + 离线 ⇒ 报一句人话（先在线跑一次）',
                       '离线' in str(e) and not calls, str(e)[:70])
    finally:
        rt._get = real_get
        rm.configure()
        if os.path.isfile(path):
            os.remove(path)


def test_ordinal_year_agreement():
    """
    两处"**届次 → 年份**"判据必须对得上。

    · `lib/match.py` 的 `build_season_years()`：从**已有数据**里推（rankland 标题里
      同时有「第 N 届」和年份）—— 表驱动，能容纳例外；
    · `xcpcio_adapter.py` 的 `season_year()`：**闭式**（`ccpc 第 n 届 = 2014+n`、`icpc = 1975+n`）。
    两条路回答同一个问题，实测在 56 条真实数据上**都在 ±1 年以内**；
    这条自测把"它们对得上"钉住 —— 哪一边单独改了（或新数据把闭式撑破），这里就红。
    """
    import match
    import xcpcio_adapter as xa

    idx_path = os.path.join(CACHE, 'rankland_index.json')
    check('（前提）rankland 索引在本地（这条自测要用它）', os.path.isfile(idx_path), True)
    if not os.path.isfile(idx_path):
        return
    with open(idx_path, encoding='utf-8') as fh:
        idx = json.load(fh)
    table = match.build_season_years(idx)
    check('表里确实推出东西了（空表不算通过）', len(table) > 0, True)

    bad = []
    for (series, season), year in sorted(table.items()):
        closed = xa.season_year(series, season)
        if not closed:
            continue
        if abs(int(closed) - int(year)) > 1:
            bad.append(f'{series} {season}：表里 {year} / 闭式 {closed}')
    check('★ 两处"届次→年份"一致（±1 年以内，例外都是"决赛次年办"）', bad, [])


def test_xcpcio_site_words():
    """
    **带分隔符的站点词也要能从 slug 里认出来** —— 实测踩到（2026-10-15，用户问的
    "`board.xcpcio.com/icpc/47th/xian` 这份榜单为什么没爬到"）：

    病根：`xcpcio_adapter.SITE_ALIAS` 里明明有 `'xi_an': 'xian'`，但 `slug_tokens()`
    **先把 slug 按 `-`/`_` 切开** ⇒ `icpc2022xi_an` 的词是
    `['icpc2022xi','icpc','xi','an',…]` —— **`xi_an` 这个词再也不会出现** ⇒ 那条别名是
    **死代码** ⇒ 站点词为空 ⇒ `match_entry()` 退到"赛名重合 ≥ 50%"，而注册表条目的
    `name` 常是空的（赛名只在 rankland 标题里）⇒ 直接判"没有能对上的目录"。
    影响面（逐场对拍过）：**4 场**，全是 `xi_an`（47th/48th/50th 西安站 + 51st 西安邀请赛），
    原本一个 xcpcio 指派都没有。

    ⚠️ 反面那条同样要钉住：别名表里带分隔符的键在 slug 上找时**右边界必须落在词尾** ——
    不锚的话 `xi[-_]?an` 会把 **`xiangtan`（湘潭）** 也当成 `xian`
    （实测那会顺手把一场**人判过"不导"**的场次新指派）。
    """
    import xcpcio_adapter as xa

    tree_path = os.path.join(CACHE, 'xcpcio_tree.json')
    check('（前提）xcpcio 目录树在本地（这条自测要用它）', os.path.isfile(tree_path), True)
    if not os.path.isfile(tree_path):
        return
    tree = xa.load_tree()
    sites = {str(c.get('site') or '').lower() for c in tree}
    sites |= {re.sub(r'[^a-z0-9]', '', s) for s in list(sites)}
    sites |= {'final', 'wfinal'}

    check('★ `icpc2022xi_an` 的站点词认得出来（`xi_an` → `xian`）',
          sorted(xa._site_words({'_slug': 'icpc2022xi_an'}, sites)), ['xian'])
    check('★ 反例：`…-xiangtan`（湘潭）**不许**被当成 `xian`',
          'xian' in xa._site_words({'_slug': 'ccpc2023invitational-xiangtan'}, sites), False)
    check('（对照）没有连字符的站点词照旧认得出',
          sorted(xa._site_words({'_slug': 'icpc2022shenyang'}, sites)), ['shenyang'])

    # 真跑一场（用注册表里那条 + 真目录树）：47th 西安站必须落到 `data/icpc/47th/xian`
    reg_path = os.path.join(HERE, 'xcpc_registry.json')
    if not os.path.isfile(reg_path):
        return
    with open(reg_path, encoding='utf-8') as fh:
        reg = json.load(fh)
    idx_path = os.path.join(CACHE, 'rankland_index.json')
    idx = {}
    if os.path.isfile(idx_path):
        with open(idx_path, encoding='utf-8') as fh:
            idx = json.load(fh).get('bySlug') or {}
    entry = dict((reg.get('contests') or {}).get('icpc2022xi_an') or {})
    entry['_slug'] = 'icpc2022xi_an'
    found, why = xa.match_entry(entry, tree, idx_info=idx.get('icpc2022xi_an') or {})
    check('★ `match_entry`：ICPC 2022 西安站 → `data/icpc/47th/xian`'
          f'（理由：{why}）', (found or {}).get('path'), 'data/icpc/47th/xian')


def test_rankland_index_role_kind():
    """
    **"补充性角色"不许声明成权威榜单**（2026-10-16 修；是翻"来源优先级"时发现的）：

    症状：应用眼里 `rankland-index-*` 这一族是**权威榜单**（board）—— 实测包里
    **134** 个 `rankland-index-*` 是 board，而清单里只有 **13** 场真的把它当 board
    （其余全是 `role: titles`：只补赛名/题单，榜单另有其人）。

    病根：`xcpc_pipeline.py` 把 `titles` **折成** `--role board` 传下去，而
    `rankland_index_adapter.build()` 是**按 role 声明 kind** 的（`board` 才算权威榜单）
    ⇒ "只补题名/题号的索引"拿着榜单身份，会压掉真榜单的 `name`/`contestTime`/`problemId`。

    判据：同一场、同一份索引，`role='titles'` / `'time'` 出的片段 kind 必须是 `script`，
    只有 `role='board'` 才是 `board`；并且流水线必须**原样透传** role（这一条走源码级 ——
    那一支只是拼命令行，离线自测跑不到它）。
    """
    import rankland_index_adapter as ria

    info = {'title': '自测场', 'startAt': '', 'problems': [], 'repoPath': ''}
    kinds = {role: ria.build(CONTEST, SLUG, info, role).to_dict()['source']['kind']
             for role in ('board', 'titles', 'time')}
    check('rankland-index：board 角色 = 权威榜单', kinds['board'], 'board')
    check('★ rankland-index：titles 角色只是补充 ⇒ kind=script（不许压榜单）', kinds['titles'], 'script')
    check('rankland-index：time 角色 = script（不变）', kinds['time'], 'script')

    with open(os.path.join(HERE, 'xcpc_pipeline.py'), encoding='utf-8') as fh:
        pipe = fh.read()
    check('★ 流水线不再把 titles 折成 board（那一折就是这次病根）',
          "'time' if role == 'time' else 'board'" in pipe, False)


def test_dry_run_leaves_tally_alone():
    """
    **`--dry-run` / `--list` 一个字节都不许动**（2026-10-17 实测踩到）。

    症状：跑一次 `python xcpc_pipeline.py --dry-run` ⇒ `acm-data/reports/stage-tally.json`
    （**git 跟踪**的环节记账）**消失** —— 链尾 `--dry-run` 那一支提前 `return`，根本不会把
    这一轮的账写回；下一次"保存快照"就把这个"删除"一起提交了。

    病根：`stages.reset_tally_file()` 与 `ACM_STAGE_TALLY=1` 原来**无条件**执行，
    而它们的位次在两条早退路（`--list` / `--dry-run`）**之前**。

    判据（源码级 —— 这一支只在真跑时生效，离线自测跑不到它）：那两句必须**紧跟**
    `if not (args.dry_run or args.list):` —— 去掉守卫、或把它们退回 4 空格缩进（老写法）都会红。
    ⚠️ 别再写一条"老写法不许出现"的独立断言：拆掉守卫后那两句的缩进**还是 8 空格**，
    那种断言照样绿（实测过一次，是**假守卫**）。一条"紧跟守卫"的断言就把两种回归都管住了。
    反面证据：修之前跑 `--dry-run`，那份文件真的没了（连大小/mtime 都无从谈起）。
    """
    with open(os.path.join(HERE, 'xcpc_pipeline.py'), encoding='utf-8') as fh:
        pipe = fh.read()
    guarded = re.search(
        r'if not \(args\.dry_run or args\.list\):\n'
        r'\s+os\.environ\[[\'"]ACM_STAGE_TALLY[\'"]\]\s*=\s*[\'"]1[\'"]\n'
        r'\s+stages\.reset_tally_file\(\)', pipe)
    check_true('★ 清记账那句在"只预演 / 只列清单"的守卫里面（紧跟守卫）', bool(guarded),
               '否则一次 --dry-run 会删掉 reports/stage-tally.json（git 跟踪的文件）')


def test_sync_stale_marks():
    """
    **`.stale` 标记要"增删两半"**（2026-10-16 修，审计翻出来的）：

    症状：某一类**这一轮产出了**，可它上一轮留下的 `.json.stale` 还挂着 ⇒
    `build_chain.stale_products()` 与链尾那句"见到它就说明这份产物是上一轮的"**长期说谎**。
    病根：那段逻辑原来**只写不删**。顺带一个洞：**空片段被 `continue` 跳过**的类两头都不沾
    （既不产出、也不在"没产出"那份名单里）⇒ 旧产物既没标记、也没人说。

    判据：`sync_stale_marks(produced, known, dir)` 按 `produced` 增删 —— 四条都跑一遍
    （这一段原来埋在 `main()` 里，抽成函数就是为了这一条）。
    """
    import xcpc_pipeline as xp

    d = os.path.join(CACHE, '_stale_selftest')
    os.makedirs(d, exist_ok=True)
    w = lambda n: open(os.path.join(d, n), 'w', encoding='utf-8').write('x')      # noqa: E731
    has = lambda n: os.path.isfile(os.path.join(d, n))                             # noqa: E731
    try:
        # ① 本轮产出 + 旧标记 ⇒ 标记被删
        w('a.json'); w('a.json.stale')
        xp.sync_stale_marks({'a'}, {'a'}, d)
        check('★ 本轮产出的类：上一轮的 .stale 被删掉', has('a.json.stale'), False)
        # ② 本轮没产出 + 有产物 ⇒ 写标记（产物不删）
        w('b.json')
        xp.sync_stale_marks(set(), {'b'}, d)
        check('本轮没产出的类：写 .stale、旧产物留着', (has('b.json'), has('b.json.stale')), (True, True))
        # ③ 本轮没产出 + 没有产物 ⇒ 不写标记
        xp.sync_stale_marks(set(), {'c'}, d)
        check('没有上一轮产物 ⇒ 不写 .stale', has('c.json.stale'), False)
        # ④ 本轮产出 + 没有旧标记 ⇒ 什么都不做（也不报错）
        w('d.json')
        check('本轮产出且没有旧标记 ⇒ 一行都不说', xp.sync_stale_marks({'d'}, {'d'}, d), [])
    finally:
        for f in sorted(os.listdir(d)):
            os.remove(os.path.join(d, f))
        os.rmdir(d)


def test_xcpcio_mirrors_order():
    """
    **取 xcpcio 那份仓库文件的镜像顺序**（实测踩到，2026-10-15，和上面那条同一天）：

    `fastly` ✅ 838 KB / 2.1 s ｜ `gcore` ❌ 10054 ｜ `cdn` ❌ 10054 ｜ `raw` ❌ 61 s 后重置
    —— 旧的名单只有 `cdn` + `raw` ⇒ **这一份榜单一条路都下不来**
    （症状：`RuntimeError: 取不到 …/run.json：The read operation timed out`）。

    这条守卫只钉"**名单里有 fastly、且它排在 cdn/raw 前**"（顺序是实测结论，不是随手写的）——
    真下载能不能通要在**真网络**上跑，桩里测不了。
    """
    import xcpcio_adapter as xa

    top = xa.RAW_MIRRORS[0] if xa.RAW_MIRRORS else ''
    check('★ xcpcio 取文件的镜像：`fastly` 排第一（国内网络下 cdn/raw 都不可用）',
          top.startswith('https://fastly.jsdelivr.net/'), True)
    check('（名单里也留着 cdn/raw 兜底，别的网络可能反过来）',
          any(m.startswith('https://cdn.jsdelivr.net/') for m in xa.RAW_MIRRORS)
          and any(m.startswith('https://raw.githubusercontent.com/') for m in xa.RAW_MIRRORS), True)
    # `build_xcpcio_index.py`（建那棵树）是**另一处**同名名单 —— 两处要同一个顺序
    idx_src = os.path.join(HERE, 'build_xcpcio_index.py')
    if os.path.isfile(idx_src):
        with open(idx_src, encoding='utf-8') as fh:
            src = fh.read()
        check('★ 建树那一步（`build_xcpcio_index.py`）也是 fastly 在前',
              'fastly.jsdelivr.net/gh/xcpcio/board-data' in src
              and src.index('fastly.jsdelivr.net/gh/xcpcio/board-data')
              < src.index('cdn.jsdelivr.net/gh/xcpcio/board-data'), True)


def test_me_cache_freshness():
    """
    **`me.json` 改完必须马上生效**（实测踩到，2026-10-16，用户报的）：

    症状：换了 QOJ cookie、**另起进程探活通过**，但在应用里重建时
    `qoj-submits` 那步**稳定**判"登录态失效（302 → //qoj.ac/login）"。

    病根：`lib/me.py:load_me()` 的 `_CACHE` 是**"读过一次就永远用它"**，而应用那颗
    「🛠 重建总包并导入」是**在 dev-server 那个长驻进程里**跑链子的
    （`build_runner.py` 只 `importlib.reload(build_chain)`，而这一步 `runpy` 进去
    `import me` 复用**同一个已导入的模块**）⇒ 缓存里还是**旧 cookie**。

    判据：同一个进程里，把文件**改成同长度的新内容**再读 —— 只有 mtime 能区分，
    所以这一条同时钉住"缓存按 (mtime, size) 失效"而不是"按内容大小猜"。
    """
    import me as me_mod
    import time                          # 只为把 mtime 推过一个刻度（本文件别处不需要它）

    tmp = os.path.join(CACHE, '__selftest_me.json')
    try:
        def write(v):
            with open(tmp, 'w', encoding='utf-8') as f:
                json.dump({'qoj': {'cookie': v}}, f, ensure_ascii=False)

        write('OLD1')
        first = me_mod.load_me(tmp)
        check('第一次读到 OLD1', (first.get('qoj') or {}).get('cookie'), 'OLD1')
        check('同一个文件连读两次是**同一份**（缓存还在，不是每次重读）',
              me_mod.load_me(tmp) is first, True)
        time.sleep(0.02)
        write('NEW2')                       # ⚠️ 与 OLD1 **同长度** ⇒ 只有 mtime 能区分
        check('★ 文件改了（同长度）⇒ 立刻读到新值（不许"读过就永远用它"）',
              (me_mod.load_me(tmp).get('qoj') or {}).get('cookie'), 'NEW2')
        # ⚠️ 再写一次之前**必须**睡一下：判据是 (mtime, size)，而 Windows 的 mtime 刻度比
        #    想象中粗（实测同一刻度内改文件，mtime+size **都**看不出来 —— 这是它已知的边界，
        #    不是 bug；真要"改完立刻生效"到纳秒级，得换成内容哈希）。
        time.sleep(0.02)
        write('OLD1')
        check('★ 再改一次照样能读到（缓存只留最新那一版，不把新值钉死）',
              (me_mod.load_me(tmp).get('qoj') or {}).get('cookie'), 'OLD1')
    finally:
        if os.path.isfile(tmp):
            os.remove(tmp)


def test_handles_accepts_list():
    """
    `<平台>.handles` **列表**必须一个个当账号（2026-10-17 修的真 bug）。

    症状：`me.json` 里写 `"cf": {"handles": ["a", "b"]}`（`lib/me.py` 的文件头明说支持这种写法），
    而 `me.handles('cf')` 返回**一个**账号 `"['a', 'b']"` ⇒ 去查这个不存在的账号，
    真正的 a / b 一条都不抓（**静默缩小范围**，与 2026-10-16 那四处兜底是同一个形状）。

    病根：`handles()` 内部的 `add()` 只写了 `[v]`（标量思路），列表被 `str()` 成整条。
    一直没暴露是因为**应用导出的那份 me.json 把平台账号写在 `accounts[]` / `mappings` 里**，
    从没走过列表这一支。
    """
    import me as me_mod

    tmp = os.path.join(CACHE, '__selftest_me_list.json')
    saved = me_mod.ME_FILE
    try:
        with open(tmp, 'w', encoding='utf-8', newline='\n') as f:
            json.dump({'cf': {'handles': ['a', 'b']}, 'qoj': {'handle': 'X, Y'}}, f,
                      ensure_ascii=False)
        me_mod.ME_FILE = tmp
        check('★ `cf.handles` 是列表 ⇒ **逐个**当账号（不是整条字符串）',
              me_mod.handles('cf'), ['a', 'b'])
        # 反例：标量里的逗号**不许**拆 —— QOJ 队伍显示名里就有逗号（见 add() 的说明）
        check('标量里的逗号不拆（那是有意的）', me_mod.handles('qoj'), ['X, Y'])
    finally:
        me_mod.ME_FILE = saved
        if os.path.isfile(tmp):
            os.remove(tmp)


def test_cf_probe_registered():
    """
    **CF 有探针**（2026-10-17 改的口径；用户："cf 怎么能因为贵就不探"）。

    病根：CF 的每一发都要 `apiSig` 签名 ⇒ 旧口径写成"没有**便宜的**探针 ⇒ 不探"。
    那是"没有免签名的探法"，不是"不探"：结果设置页那颗「🔎 探活」对 CF 是空转，
    key/secret 填错也要等抓取跑到第一发才知道。

    现在：`lib/auth_state.py:SIGNED_PROBES['cf']` 真发一发带签名的请求
    （签名与请求**复用** `cf_api.check_credentials()`，`lib/me.py --check` 调的是同一个）。

    判据（**不发网络请求**）：① `cf` 在 `SIGNED_PROBES` 里（别退回"不探"）；
    ② 它失败时合成的那几种正文仍由**同一张表**定性 —— 不自己判；
    ③ "还没填凭据"那种按 `expired` 显式定性（落到默认的"被拦"会打出"这不是凭据的问题"——反话）；
    ④ 框里的值（`--set cf.apiKey=…`）必须喂进环境变量给 `cf_api`（否则探的是磁盘那份）。
    """
    import auth_state as a

    check_true('★ CF 注册了"要签名"的探针（不许再退回"不探"）',
               'cf' in a.SIGNED_PROBES, f'实际注册了：{sorted(a.SIGNED_PROBES)}')
    for body, want in (('{"comment":"Incorrect API key"}', a.EXPIRED),
                       ('{"comment":"Incorrect signature"}', a.EXPIRED),
                       ('{"comment":"Too many requests"}', a.BLOCKED)):
        check(f'★ CF 失败正文 {body[:26]}… 仍由表定性',
              a.state_of('cf', a.Response(200, body=body)), want)
    check('★ 还没填凭据 ⇒ 显式按 expired 定性（指路，不是"被拦"）',
          a._cf_state_on_error('这个方法需要 Codeforces 凭据，但没找到 —— 设环境变量…'), a.EXPIRED)
    check('其余失败（key/签名/限流）**交给表**判，探针自己不判',
          a._cf_state_on_error('{"comment":"Incorrect API key"}'), '')
    # 覆盖值必须喂进 cf_api（界面承诺"用框里现在的值探一发"）
    env_names = ('CF_API_KEY', 'CF_API_SECRET')
    saved_env = {k: os.environ.get(k) for k in env_names}
    try:
        a.set_overrides(['cf.apiKey=K1', 'cf.apiSecret=S1'])
        check('★ 覆盖值喂进环境变量给 cf_api 用（几条）', a._cf_apply_overrides(), 2)
        check('★ 喂的就是框里那个 key', os.environ.get('CF_API_KEY'), 'K1')
        a._OVERRIDES.clear()          # ⚠️ `set_overrides()` **只增不清**（传空列表不重置）
        for k in env_names:
            os.environ.pop(k, None)
        check('没有覆盖值时不乱设环境变量', a._cf_apply_overrides(), 0)
    finally:
        a._OVERRIDES.clear()
        for k, v in saved_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def test_offline_never_fetches():
    """
    **离线就是一次也不联网** —— 实测逮到的一次真联网。

    `atcoder_adapter.load_submissions()` 若把 `should_refetch()` 的结论**只用来决定
    水位线**（从哪个 `from_second` 往后抓），而 `fetch_submissions()` 是**无条件**执行的
    ⇒ `--offline` 重跑照样往 kenkoooo 打请求（实测：离线跑的统计里出现"联网 1 次"）。
    所以离线走"只用本地"：有缓存就返回它，没有就当场报错。
    """
    import importlib
    import read_modes as rm
    at = importlib.import_module('atcoder_adapter')

    handle = '__selftest_offline__'
    path = at.submissions_path(handle)
    calls = []
    real_get = at._get_json

    def fake_get(*a, **k):                                           # noqa: ARG001
        calls.append(a[0] if a else '')
        return []

    at._get_json = fake_get
    try:
        with open(path, 'w', encoding='utf-8', newline='\n') as f:
            json.dump([{'id': 1, 'user_id': handle, 'epoch_second': 100}], f)
        rm.configure(offline=True)
        rows, pages = at.load_submissions(handle)
        check('① 离线 + 有缓存 ⇒ 返回缓存、**一次网都不联**（页数 0）',
              (len(rows), pages, calls), (1, 0, []))
        os.remove(path)
        calls.clear()
        try:
            at.load_submissions(handle)
            check_true('② 离线 + 没缓存 ⇒ 应该当场报错（不许偷偷联网）', False)
        except SystemExit as e:
            check_true('② 离线 + 没缓存 ⇒ 报一句人话，且**一次网都没联**',
                       '离线' in str(e) and not calls, str(e)[:70])
    finally:
        at._get_json = real_get
        rm.configure()
        if os.path.isfile(path):
            os.remove(path)


def test_subprocess_output_streams_through():
    """
    ★ **子进程的输出要接回自己这条流**（2026-10-17 修）。

    病根：`xcpc_pipeline.run()` 原来是 `subprocess.call` ⇒ 子进程（`lib/batch.py` 与各适配器）
    继承的是**真 stdout**，于是 ① 应用里那个日志框（走 `build_chain` 的 `on_line`）**看不到
    适配器在跑什么**（只有服务器控制台有）；② 适配器喊的进度（`lib/progress.py`）传不到心跳。

    ⚠️ 判据必须看**缓冲区结尾**、不能只看 `in`：`run()` 自己会先回显一行
    `$ python -B -c print("grandchild-hello")` —— 那行**就含**这段文本
    ⇒ 写成 `'grandchild-hello' in buf` 的话，`subprocess.call` 的旧写法**永远是绿的**
    （实测：第一版就是这么写的，拿旧写法验红时没红，才发现是假守卫）。
    """
    import contextlib
    import io

    import xcpc_pipeline as xp

    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = xp.run([sys.executable, '-B', '-c', 'print("grandchild-hello")'], dry=False)
    check('★ 子进程输出接回父进程的流（应用日志框才看得到适配器在干嘛）',
          (code, buf.getvalue().rstrip().endswith('grandchild-hello')), (0, True))


def test_adapters_uniform_cli():
    """
    ★ **所有适配器都挂同一套读取开关**（`read_modes.add_cli_args`），而且流水线**真的透传** `--force`。

    为什么要有这条（2026-10-17 实测）：`xcpc_pipeline.py --force` 原来只删片段、让适配器重跑，
    **一个适配器都没收到 `--force`** ⇒ 应用里「全删重爬」那一档实际只是"重新打包一遍"
    （实测：整条链 83.8s、CF「归档命中 616 / 联网 7」）。而"忽略本地缓存去重抓"是**适配器自己**
    按 `read_modes` 那套做的。两半都必须钉住：
      ① 每个适配器的 CLI 都得认 `--force`/`--offline` —— 谁没挂，被透传时就是 argparse 报错（退出码 2）
         ⇒ **整条链掐断**；
      ② 流水线那条命令行里真得带上 `--force`（拿 `--dry-run` 看"它打算跑什么"，不联网、秒级）。

    ⚠️ 适配器名单**从目录 glob 出来**，不手写 —— 手写的名单加了新适配器就不会跟着长。
    """
    import glob

    adapters = sorted(glob.glob(os.path.join(HERE, '*_adapter.py')))
    check_true('★ 适配器数量 ≥ 10（名单是 glob 出来的）', len(adapters) >= 10, f'实际 {len(adapters)}')
    # ⚠️ 起子进程一律带上 `PYTHONUTF8=1`（2026-10-18 实测）：关掉 Windows「UTF-8 Beta」后 ACP=936，
    #    而子进程的 stdout 是**管道** ⇒ 按 GBK 编码 ⇒ 适配器的 `--help` 里有 `⟨⟩`/emoji ⇒ 一打就
    #    `UnicodeEncodeError` ⇒ 这些断言看到的是空输出（症状：11 个适配器"全都不认 --force"）。
    child_env = {**os.environ, 'PYTHONUTF8': '1'}
    bad = []
    for path in adapters:
        got = subprocess.run([sys.executable, '-B', path, '--help'],
                             capture_output=True, text=True, encoding='utf-8', errors='replace',
                             env=child_env)
        if got.returncode != 0 or '--force' not in got.stdout or '--offline' not in got.stdout:
            bad.append(os.path.basename(path))
    check('★ 每个适配器都认 --force / --offline（谁没挂，透传时整条链就掐断）', bad, [])

    # ② 透传那半：`--dry-run` 会把"打算执行的命令行"打出来 —— 看里面有没有 `--force`
    dump = subprocess.run(
        [sys.executable, '-B', os.path.join(HERE, 'xcpc_pipeline.py'),
         'icpc2026preliminary-2', '--only-source', 'cf', '--force', '--dry-run', '--no-baseline'],
        capture_output=True, text=True, encoding='utf-8', errors='replace', env=child_env)
    lines = [ln for ln in dump.stdout.splitlines() if '_adapter.py' in ln]
    check_true('★ 看得到适配器命令行（dry-run 没跑起来/清单读不到都会红）', bool(lines),
               f'exit={dump.returncode}')
    check('★ 透传：dry-run 打出来的**每一条**适配器命令行都带 --force',
          [ln.strip()[:60] for ln in lines if '--force' not in ln], [])


def test_class_rule_ids():
    """
    **分类依据**（元列 `分类依据`）—— 每条判据要发一个稳定规则 id。

    为什么值得单独钉：规则 id 是**跨语言**的键 —— Python 这边写、JS 那边查级别表
    （`src/core/natureConfidence.js` 的 `CLASS_RULE_LEVEL`）。拼错一个字母不会报错，
    只会在界面上静默降级成"依据未知"—— 那正是这一列要解决的问题本身。
    所以这里把**每条分支**的 id 都断言一遍（形状也断：`<范围>:<规则>`）。
    """
    import re as _re
    from crate import class_rule_problem
    from xcpc_common import xcpc_class_rule
    from cf_board_adapter import gym_class_rule
    from qoj_adapter import qoj_identity_rules

    shape = _re.compile(r'^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$')

    def check_pair(label, got, want_cls, want_rule):
        cls, rule = got
        check(f'★ 分类依据：{label}', (cls, rule), (want_cls, want_rule))

    # ---- XCPC（xcpcio/rankland/pta/srk 四路共用 `xcpc_nature`）----
    check_pair('icpc + 区域赛 ⇒ 阶段由**赛名**判（C）',
               xcpc_class_rule('icpc', '2024 亚洲区域赛 成都站', 'xcpcio'),
               'xcpc/icpc/ec/regional/official', 'xcpc:name-stage')
    check_pair('ccpc + 总决赛 ⇒ 同上（id 带 ccpc 前缀，便于回溯是哪一支）',
               xcpc_class_rule('ccpc', '2024 CCPC Final'),
               'xcpc/ccpc/final/official', 'ccpc:name-stage')
    check_pair('省赛/邀请赛 ⇒ 判据最靠前（C）',
               xcpc_class_rule('provincial-invitational', '2024 北京市大学生程序设计竞赛'),
               'xcpc/provincial&invitational/无/省赛/official', 'xcpc:name-provincial')
    check_pair('系列认不出 ⇒ 停在 `xcpc`（E：什么都没命中）',
               xcpc_class_rule('', '某某杯'), 'xcpc', 'xcpc:shallow')
    check_pair('阶段判不出 ⇒ `无归类`（E）',
               xcpc_class_rule('icpc', '某某杯', 'xcpcio'),
               'xcpc/icpc/ec/无归类', 'xcpc:unclassified')
    # 收集源不止 EC（`NON_EC_SOURCES`）⇒ 停在 `xcpc/icpc`（B：结构）。
    # ⚠️ 这份名单现在是**空的**（四个来源都只收 EC）⇒ 临时挂一个进去才测得到那条分支；
    #    改完立刻还原（别把自测的脏状态漏给后面的用例）。
    import xcpc_common as _xc
    _saved = _xc.NON_EC_SOURCES
    try:
        _xc.NON_EC_SOURCES = ('pta-nonec',)
        check_pair('收集源不止 EC ⇒ 停在 `xcpc/icpc`（B：结构，值没往下走）',
                   _xc.xcpc_class_rule('icpc', '某某杯', 'pta-nonec'),
                   'xcpc/icpc', 'xcpc:series')
    finally:
        _xc.NON_EC_SOURCES = _saved

    # ---- QOJ：两份读法各自带规则 id ----
    icpc_path = [{'name': 'ICPC'}, {'name': 'Regionals'}, {'name': 'Asia East Continent'}]
    prov_path = [{'name': '~'}, {'name': 'Team Competition'}, {'name': 'Chinese Provincial'}]
    check('★ 分类依据：qoj 路径过 icpc（A 权威）',
          qoj_identity_rules(icpc_path, ['The 2024 ICPC Asia East Regionals']),
          (('qoj/xcpc/icpc/ec/regional/official', 'qoj:path-icpc'), ('', '')))
    check('★ 分类依据：qoj 标题是 UC ⇒ 这一份读法 `qoj/ucup`（C）+ xcpc 那份照旧'
          '（建树时两种都用：基键 `qoj:c:<id>` 用后者、再出一个 `:ucup` 那份）',
          qoj_identity_rules(icpc_path, ['The 2nd Universal Cup. Stage 23: Shanghai'],
                             title='The 2nd Universal Cup. Stage 23: Shanghai'),
          (('qoj/ucup', 'qoj:ucup-title'),
           ('qoj/xcpc/icpc/ec/无归类', 'qoj:path-icpc')))
    check('★ 分类依据：qoj 省赛路径（C）',
          qoj_identity_rules(prov_path, ['The 2023 Guangdong Provincial Collegiate PC'])[0],
          ('qoj/xcpc/provincial&invitational/无/省赛/official', 'qoj:name-provincial'))
    check('★ 分类依据：qoj 路径说 ICPC 但赛区读不出 ⇒ 停在浅处（E）',
          qoj_identity_rules([{'name': 'ICPC'}, {'name': 'Regionals'}],
                             ['Some ICPC Contest'])[0],
          ('qoj/xcpc/icpc', 'qoj:shallow'))
    check('★ 分类依据：qoj 什么都没挂（B 结构）',
          qoj_identity_rules([], ['Moscow Pre-Finals Workshops 2022 Day 3'],
                             title='Moscow Pre-Finals Workshops 2022 Day 3')[0],
          ('qoj/无归类', 'qoj:no-category'))
    check('★ 分类依据：qoj 有路径但认不出（E）',
          qoj_identity_rules([[{'name': 'Universal Cup'}, {'name': 'The 3rd Universal Cup'}]],
                             ['某场比赛'], title='某场比赛')[0],
          ('qoj/无归类', 'qoj:unclassified'))

    # ---- CF gym：赛名那套（阶段/省赛/赛区/UC/什么都没有）----
    check_pair('gym：CCPC 分站 ⇒ 阶段由赛名判（C）',
               gym_class_rule('2019 China Collegiate Programming Contest Qinhuangdao Onsite'),
               'cf/gyms/xcpc/ccpc/regional/official', 'gym:name-stage')
    # ★ 5 类细分进分类后，**短名**的答案变了。
    #   真实赛名都带 `and Provincial Collegiate Programming Contest` ⇒ ①/② 省赛（见上面 gym_class_of 那条）；
    #   但截短的 `The 2024 CCPC Shandong Invitational Contest` 里没有 `省/市/Provincial/Collegiate`
    #   字面词，只有 `CCPC + Invitational` ⇒ 类型落 **邀请赛**、主办落 **CC**（正交化后两轴分开写）。
    #   同一场比赛两个来源用了不同品牌名就可能分到不同类（全库实测 12 处）——
    #   要并组得在应用 ①/② 页里把成员挪进同一个合成节点（**改 natureClass 本身不并组**，
    #   脚本对已是本步格式的 ownerSynth 一个字不动，只报 drift；见 field-rules §10.5.1）。
    check_pair('gym：CCPC 承办的邀请赛（短名无 Provincial 字样）⇒ CC / 邀请赛',
               gym_class_rule('The 2024 CCPC Shandong Invitational Contest'),
               'cf/gyms/xcpc/provincial&invitational/CC/邀请赛/official', 'gym:name-provincial')
    check_pair('gym：ICPC 的赛区**靠城市/大区词推**（D）',
               gym_class_rule('2017-2018 ACM-ICPC, Asia Tsukuba Regional Contest'),
               'cf/gyms/xcpc/icpc/ap/regional/official', 'gym:infer-region')
    check_pair('gym：赛区读不出 ⇒ 停在浅处（E）',
               gym_class_rule('Some Random ICPC Contest Without Any Region'),
               'cf/gyms/xcpc/icpc', 'gym:shallow')
    check_pair('gym：只剩 UC 这个字符串身份（D）',
               gym_class_rule('Universal Cup Stage 5: Nowhere'), 'cf/gyms/ucup', 'gym:name-ucup')
    check_pair('gym：什么都不是（E）',
               gym_class_rule('Totally Unknown Contest'), 'cf/gyms/无归类', 'gym:unclassified')

    # ---- ★ 地区（`natureRegion`）----
    # 835 个空地区"果然还是太多了" ⇒ 让管线按规则填：**统一成中文城市/省名**、
    # 网络赛与 UC 写 `无`、读不出留空（不猜）。
    from xcpc_common import place_of_name, region_of_contest, is_online_class
    from cf_board_adapter import cf_nature
    check('★ 地区：赛名里的城市 ⇒ 统一成中文',
          place_of_name('The 2022 ICPC Asia Nanjing Regional Contest'), ('南京', 'city'))
    # ⚠️ 两遍扫：**中国地名优先于"外国英文地名"**（复盘异常时逮到）：
    #    QOJ 的 `name_text` 是**所有变体名拼起来**的，`qoj:c:1464` 的第二份名是
    #    `Petrozavodsk Winter 2024…` ⇒ 表里 foreign 排在「北京」前面，北京市赛被判成 `不需要`。
    check('★ 地区：同一串里**既有中文地名又有外国英文地名** ⇒ 中文赢',
          place_of_name('2023 北京市大学生程序设计竞赛 Petrozavodsk Winter 2024. Day 2. CCPC Contest 1'),
          ('北京', 'city'))
    check('★ 地区：只有外国英文地名 ⇒ 仍是 `不需要`',
          place_of_name('Petrozavodsk Winter 2024. Day 2. CCPC Contest 1'), ('彼得罗扎沃茨克', 'foreign'))
    check('★ 地区：省赛的省名 ⇒ 中文（英文写法也认）',
          place_of_name('The 2015 ICPC China Sichuan Provincial Programming Contest'),
          ('四川', 'province'))
    check('★ 地区：中文赛名里的城市（「青岛站」）',
          place_of_name('第43届ACM-ICPC亚洲区域赛（青岛站）'), ('青岛', 'city'))
    check('★ 地区：大区词（「东北地区」）',
          place_of_name('第二十届东北地区大学生程序设计竞赛'), ('东北', 'province'))
    check('★ 地区：`xiangtan` 不能被 `xian` 抢走（长词在前）',
          place_of_name('2021 ICPC Asia Xiangtan Regional Contest'), ('湘潭', 'city'))
    check('★ 地区：读不出 ⇒ 空（不猜）', place_of_name('The 2021 ICPC Asia East Continent Final'),
          ('', ''))
    check('★ 地区：网络赛（分类是 `…/pre…`）⇒ `无`',
          region_of_contest('xcpc/icpc/ec/pre/official', '2024 网络赛', 'xcpc'),
          ('无', 'xcpc:region-none'))
    check('★ 地区：网络赛（gym 镜像同理）',
          region_of_contest('cf/gyms/xcpc/ccpc/pre/official', 'The 2023 CCPC Online Contest', 'gym'),
          ('无', 'gym:region-none'))
    check('★ 地区：**热身赛不算线上**（分类是 warm-up ⇒ 仍按赛名读场地）',
          is_online_class('xcpc/icpc/ec/final/warm-up'), False)
    check('★ 地区：区域赛 ⇒ 城市 + 规则 id',
          region_of_contest('xcpc/icpc/ec/regional/official',
                            'The 2023 ICPC Asia Jinan Regional Contest', 'xcpc'),
          ('济南', 'xcpc:region-city'))
    check('★ 地区：省赛 ⇒ 省名 + 规则 id',
          region_of_contest('xcpc/provincial&invitational/省赛/official',
                            'The 2023 Guangdong Provincial Collegiate Programming Contest', 'xcpc'),
          ('广东', 'xcpc:region-province'))
    # 三个写入点都要带上地区（`xcpc_nature` / `cf_nature` / QOJ 的两份读法）
    from xcpc_common import xcpc_nature
    nat = xcpc_nature({'id': 'icpc'}, {'id': 'icpc2023jinan'},
                      'The 2023 ICPC Asia Jinan Regional Contest', 'xcpcio')
    check('★ 地区：`xcpc_nature()` 写进 natureRegion', nat.get('natureRegion'), '济南')
    check('★ 地区：`xcpc_nature()` 带上地区的规则 id',
          (nat.get('分类依据') or {}).get('natureRegion'), 'xcpc:region-city')
    gym_nat = cf_nature('2023.11.05 11:00:00', 'The 2020 ICPC Asia Yinchuan Regional Programming Contest')
    check('★ 地区：`cf_nature()` 写进 natureRegion（银川站）', gym_nat.get('natureRegion'), '银川')
    check('★ 地区：`cf_nature()` 的规则 id',
          (gym_nat.get('分类依据') or {}).get('natureRegion'), 'gym:region-city')
    from qoj_adapter import qoj_region_of
    check('★ 地区：UC 系列 ⇒ `待填写`（"都用脚本填『待填写』，但**在判定层面被视为已填写**"）',
          qoj_region_of('qoj/ucup', 'The 1st Universal Cup. Stage 10: Zhejiang', ''),
          ('待填写', 'qoj:region-ucup'))
    check('★ 地区：**没有变体名可用**的 UC 镜像（名字还是 UC 名）⇒ `待填写`（点名的那批）',
          qoj_region_of('qoj/xcpc/icpc/eu/regional/official',
                        'The 3rd Universal Cup. Stage 31: Wroclaw', '', ucup_mirror=True),
          ('待填写', 'qoj:region-ucup'))
    check('★ 地区：EC-Final ⇒ `待填写`（场地不在赛名里，先摆着、算填过了）',
          region_of_contest('xcpc/icpc/ec/final/official',
                            'The 2023 ICPC Asia East Continent Final Contest', 'xcpc'),
          ('待填写', 'xcpc:region-tbd'))
    check('★ 地区：CCPC Final 的 gym 镜像同理', 
          region_of_contest('cf/gyms/xcpc/ccpc/final/official',
                            '2019 China Collegiate Programming Contest Final (CCPC-Final 2019)', 'gym'),
          ('待填写', 'gym:region-tbd'))
    check('★ 地区：女生专场 / 高职专场也算那一档（含热身）',
          (region_of_contest('xcpc/ccpc/female/official', '第十一届中国大学生程序设计竞赛（女生专场）', 'xcpc'),
           region_of_contest('qoj/xcpc/ccpc/vocational/official', '第十届…高职专场', 'qoj'),
           region_of_contest('qoj/xcpc/icpc/ec/final/warm-up', 'EC-Final 2023. Warm Up', 'qoj')),
          (('待填写', 'xcpc:region-tbd'), ('待填写', 'qoj:region-tbd'), ('待填写', 'qoj:region-tbd')))
    check('★ 地区：**本身是英文写法的国外地名** ⇒ `不需要`（不翻译）',
          region_of_contest('cf/gyms/xcpc/icpc/ap/regional/official',
                            '2017-2018 ACM-ICPC, Asia Tsukuba Regional Contest', 'gym'),
          ('不需要', 'gym:region-foreign'))
    check('★ 地区：繁體写法统一成**简体**（"「澳門」改简体"）',
          region_of_contest('xcpc/provincial&invitational/省赛/official',
                            '2024 澳門大學生程序設計競賽', 'xcpc'),
          ('澳门', 'xcpc:region-city'))
    check('★ 地区：QOJ 赛名读不出 ⇒ 退到**分类路径里的地名层**',
          qoj_region_of('qoj/无归类', 'Some Unknown Contest',
                        'ICPC Regionals Asia East Continent Wuhan'),
          ('武汉', 'qoj:path-city'))

    # ---- 形状 + 与 JS 级别表的交叉核对 ----
    #
    # ⚠️ "产包里用到的每条规则 id 都要有级别"那一条**不在这里** —— 它在
    #    `src/test/crossLangTables.test.js`（`npm test`）：那里从产包读 `分类依据`、
    #    问应用侧唯一的解算器 `levelOfClassRule`（两张表都查）。
    #    曾经在这里手抄过一份 41 条 id 的清单，问题有两个：**手抄只能证明抄下来的那些**
    #    （新加一条判据一个都盖不到），而且与 JS 那份是**同一个事实的第二份判据**、
    #    选值口径还不一样（这边丢空串并 trim、那边不丢）⇒ 同一条脏数据一处红一处绿。
    #    判据只有一份：规则的**形状**在这里（`class_rule_problem`），**登记**在 JS 单测。


def test_problem_synths():
    """
    **复用题的合成节点 + 成员指针** ——

        "除了 xcpc，合成节点只在 **cf/atc 的同一时间不同场复用题**时出现，**比赛完全不用合成**"
        + "**cf/atc 直接生成 ownerSynth 和合成节点就行了**"

    所以这里钉四件事：① 判据 = **时间相同 + 题名相同 + 落在 ≥2 个场次**；
    ② "老家"取场次 extKey 排序里的第一个（稳定可复现）；③ 合成节点是 **P**、挂在老家那场下；
    ④ 成员记录**只写 extKey + ownerSynth**（带了 name 会在导入时改写题名）。
    """
    from crate import Crate, validate_crate
    from xcpc_common import (emit_problem_synths, problem_reuse_groups,
                             problem_synth_key, PROBLEM_SYNTH_PREFIX,
                             MERGED_SYNTH_NAME_PREFIX)

    check('★ 复用题：合成标识 = `synth:problem:<老家 P 的 extKey>`',
          problem_synth_key('cf:c:2201:p:F2'), 'synth:problem:cf:c:2201:p:F2')
    check('★ 复用题：前缀就是 `synth:problem:`', PROBLEM_SYNTH_PREFIX, 'synth:problem:')
    # cf 合成节点的名字前缀 `[Merged]`：合成节点与老家那道 P
    #   **同父同名**，不加前缀在树上分不出谁是谁。
    check('★ 复用题：名字前缀就是 `[Merged] `', MERGED_SYNTH_NAME_PREFIX, '[Merged] ')

    entries = [
        ('cf:c:2201', '2026.01.01 20:00', 'cf:c:2201:p:F2', 'Yet Another Problem', 'F2'),
        ('cf:c:2202', '2026.01.01 20:00', 'cf:c:2202:p:G2', 'Yet Another Problem', 'G2'),
        # 时间不同 ⇒ 不是复用（同名题到处都是）
        ('cf:c:2203', '2026.01.02 20:00', 'cf:c:2203:p:A', 'Yet Another Problem', 'A'),
        # 只在一场里出现 ⇒ 不是复用
        ('cf:c:2201', '2026.01.01 20:00', 'cf:c:2201:p:A', '独有题', 'A'),
        # 时间缺失 ⇒ 不算（宁可不合，也不乱合）
        ('', '', 'cf:c:2204:p:A', '还没抓到时间的题', 'A'),
    ]
    groups = problem_reuse_groups(entries)
    check('★ 复用题：只有"同一时间 + 同名 + ≥2 场"成组', len(groups), 1)
    check('★ 复用题：老家 = 场次排序第一个', groups[0]['home'],
          {'ext': 'cf:c:2201:p:F2', 'parent': 'cf:c:2201',
           'name': 'Yet Another Problem', 'problem_id': 'F2'})
    check('★ 复用题：成员只有另一场那份', groups[0]['members'],
          [{'ext': 'cf:c:2202:p:G2', 'parent': 'cf:c:2202'}])

    c = Crate(source_id='selftest', label='复用题自测')
    c.platform('cf', name='CF')
    c.series('cf', 'cf:contests', name='CF 正式比赛')
    c.contest('cf:contests', 'cf:c:2201', name='Round 2201 (Div. 1)')
    c.contest('cf:contests', 'cf:c:2202', name='Round 2202 (Div. 2)')
    c.problem('cf:c:2201', 'cf:c:2201:p:F2', name='Yet Another Problem', problem_id='F2')
    c.problem('cf:c:2202', 'cf:c:2202:p:G2', name='Yet Another Problem', problem_id='G2')
    made, pointed = emit_problem_synths(c, groups)
    # 2 = 老家自己 + 1 份拷贝（老家也算成员，见下面那条 ★）
    check('★ 复用题：产出计数（含老家自己）', (made, pointed), (1, 2))
    recs = c.to_dict()['records']
    syn = [r for r in recs if r.get('synthKey')]
    check('★ 复用题：合成节点是 **P**、挂在老家那场下、名字带 `[Merged] ` 前缀、有题号',
          (len(syn), syn[0]['节点类型'], syn[0]['父extKey'], syn[0]['name'], syn[0].get('problemId')),
          (1, 'P', 'cf:c:2201', MERGED_SYNTH_NAME_PREFIX + 'Yet Another Problem', 'F2'))
    check('★ 复用题：合成节点**没有** extKey', syn[0].get('extKey'), None)
    memb = [r for r in recs if r.get('ownerSynth')]
    check('★ 复用题：**包内**成员就地在那条 P 上写指针（不再出一条同 extKey 的记录）',
          (len(memb), sorted(r['extKey'] for r in memb),
           set(r['ownerSynth'] for r in memb)),
          (2, ['cf:c:2201:p:F2', 'cf:c:2202:p:G2'],
           {problem_synth_key('cf:c:2201:p:F2')}))
    # ⚠️ 老家必须登记（例："Codeforces Round 1124 (Div. 1) D 没有 ownerSynth"）：
    #    刻意把老家排除（"它不需要给自己当成员"）⇒ ① 老家的状态进不了组值；② 它在判重页显示成
    #    **未归属**、在节点详页显示"没归入任何合成组"。全库 355 个组全都如此，所以一起登记。
    home_rec = [r for r in recs if r.get('extKey') == 'cf:c:2201:p:F2'][0]
    check('★ 复用题：**老家自己也写 ownerSynth**（否则它显示成"没归入"）',
          (home_rec.get('ownerSynth'), home_rec['父extKey'], home_rec['name']),
          (problem_synth_key('cf:c:2201:p:F2'), 'cf:c:2201', 'Yet Another Problem'))
    # ⚠️ 反向锚：**成员（真 P）的题名不许带前缀** —— 前缀一旦漏进成员，"同一时间 + 同题名"
    #    这条分组判据就再也配不上组了（前缀只该长在合成节点自己身上）。
    check('★ 复用题：成员题名**不带** `[Merged] ` 前缀（否则分组判据就废了）',
          [r['name'] for r in recs if r.get('extKey', '').endswith(':p:G2')],
          ['Yet Another Problem'])
    check('★ 复用题：整包仍过校验', validate_crate(c.to_dict()), [])

    # **包外**成员（树上已有、本包没出）：另出一条**指针记录**，且**不写 name**
    # ⚠️ 夹具里把**父场次**放进包（真实场景就是这样：父在树上/别处已有），只让那份 P "在包外"。
    c2 = Crate(source_id='selftest2', label='复用题自测·包外成员')
    c2.platform('cf', name='CF')
    c2.series('cf', 'cf:contests', name='CF 正式比赛')
    c2.contest('cf:contests', 'cf:c:2201', name='Round 2201 (Div. 1)')
    c2.contest('cf:contests', 'cf:c:2202', name='Round 2202 (Div. 2)')
    c2.problem('cf:c:2201', 'cf:c:2201:p:F2', name='Yet Another Problem', problem_id='F2')
    made2, pointed2 = emit_problem_synths(c2, groups)
    recs2 = c2.to_dict()['records']
    pointer = [r for r in recs2 if r.get('ownerSynth') and r.get('name') is None]
    check('★ 复用题：包外成员另出一条指针记录（老家在包内 ⇒ 只是就地写，不算指针记录）',
          (made2, pointed2, len(pointer)), (1, 2, 1))
    check('★ 复用题：那条指针记录**不写 name**（写了会在导入时改写题名）',
          (pointer[0]['extKey'], pointer[0].get('name'), pointer[0]['父extKey']),
          ('cf:c:2202:p:G2', None, 'cf:c:2202'))
    check('★ 复用题：包内的老家也照写 ownerSynth',
          [r['extKey'] for r in recs2 if r.get('ownerSynth') and r.get('name')],
          ['cf:c:2201:p:F2'])
    check('★ 复用题：带了包外指针的包也过校验', validate_crate(c2.to_dict()), [])


def test_registry_index_bootstrap():
    """
    **缺索引 ⇒ 现场建一份，而不是把链子堵死**（2026-10-19 实测，公开发布副本上点「重建总包」）。

    症状：一份**没有抓取缓存**的副本（release 包 / 新机器）上点「重建总包」，
    第 1 步 `registry build` 立刻 `❌ 缺 cache/rankland_index.json` 退出 1 —— 链子一步都没跑。
    病根：这一层别的原料都是"缺就补"（`read_modes` 的 KEEP 语义），只有这份索引是**见了就死**。
    修法：`xcpc_registry.load_index()` 在索引**完全不在**时先跑一遍 `build_rankland_index.py`
    （文件在就一个字都不碰 —— 那份 builder 自己也有"缺的才抓"）。

    判据（不联网）：把 `INDEX` 指到临时路径 + 把 `subprocess.run` 打桩 --
      ① 打桩版"建出文件" ⇒ `load_index()` 要**调过 builder 并读到索引**；
      ② 打桩版"建不出来" ⇒ 必须 `sys.exit`，而且那句话要**点名**该跑哪条命令。
    """
    import shutil

    import xcpc_registry as XR

    # ⚠️ 别用 `tempfile.mkdtemp()`：在本机的受限沙箱里那个目录**写不进去**（实测 EACCES，
    #    与本仓其它测试同一处理：写到仓库根的 `.tmp-*/` 里，`.gitignore` 已经挡着）。
    tmpd = os.path.join(REPO, '.tmp-idx-selftest')
    shutil.rmtree(tmpd, ignore_errors=True)
    os.makedirs(tmpd, exist_ok=True)
    idx = os.path.join(tmpd, 'rankland_index.json')
    real_index, real_run = XR.INDEX, XR.subprocess.run
    calls: list = []

    class _OK:
        returncode = 0

    def _fake_run(argv, **kw):
        calls.append([str(x) for x in argv])
        with open(idx, 'w', encoding='utf-8') as f:
            json.dump({'bySlug': {'icpc2025chengdu': {'slug': 'x'}}}, f)
        return _OK()

    try:
        XR.INDEX = idx
        XR.subprocess.run = _fake_run
        got = XR.load_index()
        check('★ 缺索引 ⇒ 现场跑 builder（不直接把链子堵死）',
              (bool(calls), bool(calls and calls[0][-1].endswith('build_rankland_index.py')),
               bool((got or {}).get('bySlug'))),
              (True, True, True))

        os.remove(idx)
        calls.clear()

        class _Bad:
            returncode = 1

        XR.subprocess.run = lambda *a, **k: _Bad()
        code = None
        try:
            XR.load_index()
        except SystemExit as e:                      # 期望：当场停
            code = str(e.code or '')
        check('★ builder 建不出来 ⇒ 当场停，且点名要跑哪条命令',
              bool(code and 'build_rankland_index.py' in code), True)
    finally:
        XR.INDEX, XR.subprocess.run = real_index, real_run
        shutil.rmtree(tmpd, ignore_errors=True)


def test_side_tree_staleness():
    """
    **那两棵"链上读、链上不产"的树，旧了要看得见**（2026-10-17 真踩到）。

    症状：`build_chain` 从头跑到尾都"成功"，而包里那棵杭电树只有 **10 场**（原料里已经有 50 场）——
    因为链只把 `nodes/hdu-multi-university.json` 读进来，谁都不负责让它变新，
    而 `build_chain.py` 里连 `hdu` / `nk` 这两个词都没有。
    修法：`side_tree_notes()` 按 mtime 比一句（**只报不改**，`.stale` 那套只覆盖"链上产出的类"）。

    判据：把产物拷一份、mtime 按回 2020 ⇒ 必须报出"杭电那棵树比原料旧"且点名该跑哪条命令；
    产物是新的 ⇒ **一句都不许报**（否则这句会变成长期噪音、被无视）。
    """
    import shutil
    import time as _t
    import xcpc_pipeline as xp

    nodes = os.path.join(xp.REPO, 'acm-data', 'nodes')
    src = os.path.join(nodes, 'hdu-multi-university.json')
    if not os.path.isfile(src):
        # ⚠️ 2026-10-19 修：这里原来 `check('（跳过）…', True)` —— `check()` 要三个参数，
        #    这条分支**从来没跑过**（树包一直在），所以一直没暴露。而树包现在是**生成物**
        #    （`clean-personal` 档位 1 会删它）⇒ "没有包"是正常状态，这里只打一行、不计数。
        print('  ↳ （跳过）没有 hdu 那棵树（`acm-data/nodes/hdu-multi-university.json`）'
              '，staleness 判据无从验 —— 先跑 `npm run crate:hdu` 再验')
        return
    tmp = os.path.join(nodes, '.probe-side-selftest')
    shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(tmp, exist_ok=True)
    try:
        dst = os.path.join(tmp, 'hdu-multi-university.json')
        shutil.copyfile(src, dst)
        old = _t.mktime((2020, 1, 1, 0, 0, 0, 0, 0, -1))
        os.utime(dst, (old, old))
        stale = xp.side_tree_notes(tmp)
        check_true('★ 树比原料旧 ⇒ 报一句（并点名该跑的命令）',
                   any('杭电那棵树' in one and 'crate:hdu' in one for one in stale), str(stale))
        shutil.copyfile(src, dst)                      # 换成新的那份（mtime = 现在）
        fresh = xp.side_tree_notes(tmp)
        check_true('★ 树是新的 ⇒ 一句都不报（否则这句会变成长期噪音）', fresh == [], str(fresh))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main() -> int:
    import pta_adapter
    import srk_adapter
    import qoj_adapter
    import cf_adapter
    from crate import validate_crate

    print('XCPC 自测（离线）')

    # ---- 各来源片段 ----
    pta_stats = pta_adapter.analyze(fixture_pta())
    pta_crate = pta_adapter.build(CONTEST, pta_stats)
    test_pta(pta_crate, pta_stats)

    nk_stats = pta_adapter.analyze_nk(fixture_nk())
    nk_crate = pta_adapter.build(CONTEST, nk_stats, f'nk-{SLUG}', tree_source='nk')
    test_nk(nk_crate, nk_stats, pta_adapter.analyze_nk(fixture_nk(complete=False)))

    srk_stats = srk_adapter.analyze(fixture_srk())
    titles_crate = srk_adapter.build(CONTEST, srk_stats, 'titles')
    board_crate = srk_adapter.build(CONTEST, srk_stats, 'board')
    test_srk_titles(titles_crate, board_crate)

    # QOJ：**整棵树一个 crate**（场次集合来自分类树缓存；这里只钉 4113 这一场，
    # 免得自测依赖"这一轮爬了多少场"）
    qoj_crate, qoj_warns = qoj_adapter.build_tree(records=fixture_qoj(), contest_ids=['4113'])
    qkeys = [r['extKey'] for r in qoj_crate.to_dict()['records'] if r['节点类型'] == 'R']
    # ⚠️ 夹具里那条"只有相对时间"的提交**被丢弃**（用户："丢弃提交并警告"）⇒ 只数到 2 条。
    check('QOJ 提交按 `/contest/<id>` 分组：本场 2 条、别场 1 条各归各的 C',
          (sum(1 for k in qkeys if k.startswith('qoj:c:4113:')),
           sum(1 for k in qkeys if k.startswith('qoj:c:9999:'))), (2, 1))

    # CF：单 handle 与多人两种调用方式都要能用
    cf_records = cf_adapter.pick(fixture_cf(), 'tester')
    cf_crate, _ = cf_adapter.build(SLUG, cf_records, '999', 'tester')
    # 多人：手滑写两遍同一个 handle 必须被去重（否则白抓一份）
    multi = cf_adapter.pick(fixture_cf(), ['tester', 'tester', 'mate'])
    check('CF 多人：handle 集合去重后仍只留目标人的提交', len(multi), 3)
    cf_multi, _ = cf_adapter.build(SLUG, multi, '999', handles=['tester', 'mate'])
    check('CF 多人：队友提交也能进包', len(keys_of(cf_multi)), 3)

    test_extkeys(pta_crate, titles_crate, qoj_crate, cf_crate)
    test_submissions(qoj_crate, cf_crate, qoj_warns)
    test_account_clue(qoj_crate, cf_crate)
    test_cf_classification()
    test_cf_page_difficulty()
    test_cf_adapter_edges()
    test_atcoder_difficulty()
    test_xcpc_class_rules()
    test_class_rule_ids()
    test_problem_synths()
    test_read_modes()
    test_auth_state()
    test_cf_api_rate_limit()
    test_batch_hard_stop()
    test_empty_source_result()
    test_shared_asset_paths()
    test_root_platform_src()
    test_rankland_config_cache()
    test_no_docs_in_cache()
    test_ordinal_year_agreement()
    test_xcpcio_site_words()
    test_rankland_index_role_kind()
    test_dry_run_leaves_tally_alone()
    test_sync_stale_marks()
    test_side_tree_staleness()
    test_registry_index_bootstrap()
    test_xcpcio_mirrors_order()
    test_me_cache_freshness()
    test_handles_accepts_list()
    test_cf_probe_registered()
    test_offline_never_fetches()
    test_subprocess_output_streams_through()
    test_adapters_uniform_cli()
    test_validate([('PTA', pta_crate), ('srk-titles', titles_crate),
                   ('QOJ', qoj_crate), ('CF', cf_crate)], validate_crate)

    tmp = None   # 中间文件直接写 cache/，见 test_merge 的说明
    test_merge({'pta': pta_crate, 'srk': titles_crate, 'qoj': qoj_crate}, SLUG)

    print()
    if FAILED:
        print(f'❌ 失败 {len(FAILED)} 项：')
        for f in FAILED:
            print('   •', f)
        return 1
    print(f'✅ 全部通过：{PASSED} 项')
    return 0


if __name__ == '__main__':
    sys.exit(main())
