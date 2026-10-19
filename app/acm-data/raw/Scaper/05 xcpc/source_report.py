#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
小样：把一场 XCPC 数据的**每个字段的每个来源**列出来，并说明"当前值为什么是它"。

⚠️ 这是一个**只读演示**，不改应用、不改数据结构、不写任何比赛数据。
   它读的是已经产出的 crate 片段（`cache/crate_<slug>_<source>.json`），
   把"同一个字段有多个来源"这件事显式摆出来。

它演示三件事（对应应用里那套"来源 + 优先级"机制）：
  1. **每个值记出处**：同一个字段来自 PTA / rankland / QOJ 时都列出来；
  2. **当前值 = 按优先级选出来的**，并给出**人话理由**；
  3. **优先级可以改**：`--prefer ratio=srk` 就能看到值随之变化（可逆）。

用法：
    python source_report.py icpc2026preliminary-2
    python source_report.py icpc2026preliminary-2 --prefer ratio=srk    # 演示改优先级
    python source_report.py icpc2026preliminary-2 --prefer name=manual
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

from xcpc_common import CACHE, find_contest, load_manifest, read_json  # noqa: E402

# 来源等级 / 类别序 —— **演示用**的近似口径，真源在应用的 `src/core/trust.js`
# （`KIND_RANK`：manual 100 > board 30 > script 20 > derived 10；`DEFAULT_TRUST.categoryRank`
#  ＋**来源级覆盖** `SOURCE_RANK`）。
# ⚠️ 这里是**跨语言手抄**（Python 读不到 JS）：`src/test/sourceReportRanks.test.js` 会解析本文件
#    并与那三样对拍 —— 哪一边单独改了，测试就红。
# ⚠️ 本表的键是**来源短名**（`source_of()` 取的第一个 `-` 之前那截）⇒ 它**分不出**
#    `cf-<slug>`（榜）与 `cf-titles-<slug>`（题名补充）、也分不出 `nk-<slug>`（榜）与
#    `nk-scraper`（提交/ratio）—— 应用侧是按 (来源, 类别) 分档的。
#    这一档按"榜"取（`CATEGORY='board'`）：这个工具就是用来查"这场凭什么挑了这个值"的，
#    而会引人来查的正是榜上那几个字段（ratio / 赛名）。
#    应用侧全表三档：30 现场/官方榜（xcpcio/pta/rankland-index/srk 的榜角色）｜
#    25 榜但混非正式（`cf-*`、`nk-*` 的 **board**）｜ 20 脚本/补充。
SOURCE_RANK = {'pta': 30, 'srk': 20, 'qoj': 20, 'cf': 25, 'nk': 25, 'manual': 100}
# 类别序：权威榜单(board) > 脚本(script) > 派生(derived)
CATEGORY_RANK = ['manual', 'board', 'script', 'derived']
# 每个来源在这一场里扮演什么角色（真源是应用里 `state.trust` 的类别；清单的 role 决定取值）
CATEGORY = {'pta': 'board', 'srk': 'script', 'qoj': 'script', 'cf': 'board', 'nk': 'board'}

FIELD_ORDER = ['name', 'contestTime', 'problemId', 'ratio', 'link', 'identityKey',
               'status', 'time']
FIELD_LABEL = {
    'name': '名字', 'contestTime': '比赛时间', 'problemId': '题号', 'ratio': '通过率',
    'link': '链接', 'identityKey': '跨场身份', 'status': '结果', 'time': '提交时间',
}


def source_of(crate: dict) -> tuple[str, str]:
    """
    片段 → (来源短名, 完整 srcId)。例：'pta'，'pta-icpc2026preliminary-2'。

    ⚠️ 来源 id 不带 `xcpc-` 前缀 —— 那个前缀既是
    **流水线名**又和大类取值 `xcpc` 撞脸（`xcpc-cf-contest` 看着像"大类=xcpc"，
    其实它是 05 流水线的 CF 正式比赛片段、大类是 `cf`）。来源 id 就是 `<渠道>-<slug>`。
    """
    src_id = str((crate.get('source') or {}).get('id') or '?')
    m = re.match(r'([a-z]+)-', src_id)
    return (m.group(1) if m else src_id), src_id


def identity_key(link: str) -> str:
    """路线 C 的跨场身份：从 CF gym 链接合成 `cf:gym:<gym>:<letter>`（先只存不用）"""
    m = re.search(r'codeforces\.com/gym/(\d+)/problem/([A-Za-z0-9]+)', str(link or ''))
    return f'cf:gym:{m.group(1)}:{m.group(2).upper()}' if m else ''


def collect(slug: str, extra: dict | None = None) -> dict:
    """
    把各来源片段摊成 {extKey: {'type':…, '父extKey':…, 'values': {字段: [(值, 来源短名, srcId)]}}}

    注意：这一步**不合并**，只是把"谁说了什么"摆出来 —— 这就是来源层。

    `extra` 用来临时塞额外的"来源"（形如 `{短名: 片段路径}`），
    演示"同一个字段两个来源说法不同"时用。
    """
    nodes: dict[str, dict] = {}

    def eat(crate: dict, short: str, src_id: str):
        for rec in crate.get('records') or []:
            key = rec.get('extKey')
            if not key:
                continue
            node = nodes.setdefault(key, {'type': rec.get('节点类型'), 'parent': rec.get('父extKey', ''),
                                          'values': {}})
            for field, value in rec.items():
                if field in ('节点类型', 'extKey', '父extKey'):
                    continue
                node['values'].setdefault(field, []).append((value, short, src_id))

    for name in sorted(os.listdir(CACHE)):
        m = re.match(rf'crate_{re.escape(slug)}_([a-z]+)\.json$', name)
        if not m:
            continue
        crate = read_json(os.path.join(CACHE, name))
        short, src_id = source_of(crate)
        eat(crate, short, src_id)

    for short, path in (extra or {}).items():
        if os.path.isfile(path):
            eat(read_json(path), short, short)

    # 路线 C 的跨场身份：不是来源给的，是**算出来**的（这里只用 srk 的链接演示）
    for node in nodes.values():
        links = node['values'].get('link') or []
        for value, short, src_id in links:
            ik = identity_key(value)
            if ik:
                node['values'].setdefault('identityKey', []).append((ik, short, src_id))
                break
    return nodes


def project(field: str, values: list, prefer: dict) -> tuple[str, str, str]:
    """
    投影：从多个来源值里选出"当前值"，并给人话理由。

    规则顺序：手改 > 字段级偏好 > 类别序 > 来源等级 > 更新时间
    @returns (值, 来源短名, 理由)
    """
    # 值相同 → 先合并同类，避免"3 个来源说同一句话"刷屏
    distinct = {}
    for value, short, _src in values:
        distinct.setdefault(str(value), []).append(short)

    if len(distinct) == 1:
        value = next(iter(distinct))
        who = distinct[value]
        return value, who[0], ('唯一来源' if len(who) == 1 else f'{len(who)} 个来源一致')

    # 有分歧：按规则挑
    def sort_key(item):
        value, shorts = item
        manual = 1 if 'manual' in shorts else 0
        pref = prefer.get(field)
        pref_hit = 1 if (pref and pref in shorts) else 0
        best_cat = max(CATEGORY_RANK.index(CATEGORY.get(s, 'script')) for s in shorts)
        best_rank = max(SOURCE_RANK.get(s, 0) for s in shorts)
        return (manual, pref_hit, -best_cat, best_rank, len(shorts))

    value, shorts = max(distinct.items(), key=sort_key)
    if 'manual' in shorts:
        reason = '你手改的（永远优先）'
    elif prefer.get(field) in shorts:
        reason = f'你指定这个字段优先用 {prefer[field]}'
    elif CATEGORY.get(shorts[0]) == 'board':
        reason = '权威榜单优先（这场以它为准）'
    else:
        reason = f'来源等级更高（{max(SOURCE_RANK.get(s, 0) for s in shorts)}）'
    others = [f'{s} 说 {v}' for v, ss in distinct.items() if v != value for s in ss[:1]]
    if others:
        reason += '；另有 ' + '、'.join(others) + '（未采用）'
    return value, shorts[0], reason


def main(argv):
    ap = argparse.ArgumentParser(description='只读小样：列出每个字段的来源与投影理由')
    ap.add_argument('slug')
    ap.add_argument('--prefer', action='append', default=[],
                    help='演示改优先级，如 --prefer ratio=srk（可给多次）')
    ap.add_argument('--extra', action='append', default=[],
                    help='额外塞一个"来源"来演示分歧：--extra 短名=片段.json')
    ap.add_argument('--manifest', default='')
    args = ap.parse_args(argv)

    manifest = load_manifest(args.manifest)
    contest = find_contest(manifest, args.slug)

    prefer = {}
    for item in args.prefer:
        if '=' in item:
            f, s = item.split('=', 1)
            prefer[f.strip()] = s.strip()

    extra = {}
    for item in args.extra:
        if '=' in item:
            short, path = item.split('=', 1)
            extra[short.strip()] = path.strip()

    nodes = collect(args.slug, extra)
    if not nodes:
        print(f'❌ cache 里没有 {args.slug} 的片段 —— 先跑 npm run crate:xcpc')
        return 1

    # 排序：W → S → C → P → R，同类型按 extKey
    order = {'W': 0, 'S': 1, 'C': 2, 'P': 3, 'R': 4}
    keys = sorted(nodes, key=lambda k: (order.get(nodes[k]['type'], 9), k))

    conflicts = 0
    print(f'📋 {contest.get("name") or args.slug}    （只读小样，未写入任何东西）')
    print(f'   来源：' + '、'.join(sorted({s for n in nodes.values() for v in n["values"].values()
                                        for _x, s, _y in v})))
    if prefer:
        print(f'   ⚙️ 本次演示的优先级覆盖：{prefer}')
    print()

    for key in keys:
        node = nodes[key]
        print(f'{node["type"]} {key}')
        for field in FIELD_ORDER:
            entries = node['values'].get(field)
            if not entries:
                continue
            value, who, reason = project(field, entries, prefer)
            # 来源明细：同一字段的每个不同值分别列
            by_value = {}
            for v, s, _sid in entries:
                by_value.setdefault(str(v), []).append(s)
            detail = ' ｜ '.join(f'{v} ← {"/".join(sorted(set(ss)))}'
                                for v, ss in by_value.items())
            if len(by_value) > 1:
                conflicts += 1
            star = '★' if len(by_value) > 1 else ' '
            print(f'  {star} {FIELD_LABEL.get(field, field):<8} {detail}')
            print(f'      选中：{value}   ← {who}   （{reason}）')
        print()

    print(f'共 {len(nodes)} 个节点；{conflicts} 处字段有多个不一致的来源（★ 标出）')
    print('\n提示：加 --prefer ratio=srk 就能看到"改优先级 → 值随之变化"（可以改回来）')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
