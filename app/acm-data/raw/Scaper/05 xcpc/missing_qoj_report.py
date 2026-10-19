#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
谁"没有补题链接、但 QOJ 里其实有"？—— 体检报告（只读，不改数据）

「2024 北京市大学生程序设计竞赛 补题 https://qoj.ac/contest/1668 但是没抓到，
**还有很多比赛也没抓到信息，重点查没补题链接但实际上在 qoj 里有的**」。

数据来源：`04 qoj/cache/qoj_contest_titles.json`（`04 qoj --list` 独家维护：比赛号 → 官方赛名）。
判"同一场"用的是 `lib/match.py` 的原语（`norm_text` / `name_tokens` / `overlap`）——
**不另造一套比对**（那是这个项目反复强调的"同一场认定只有一份实现"）。

用法：
    python missing_qoj_report.py            # 列出候选（默认阈值 0.5）
    python missing_qoj_report.py --all      # 连分数很低的也列出来人工看
"""

from __future__ import annotations

import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, 'lib'))

from match import name_tokens, norm_text, overlap, year_gap  # noqa: E402

REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..', '..'))
# ⚠️ 合并包是 `mix_contain_xcpc.json`（见 xcpc_pipeline.py 末尾）
NODES = os.path.join(REPO, 'acm-data', 'nodes', 'mix_contain_xcpc.json')
QOJ_INDEX = os.path.join(HERE, '..', '04 qoj', 'cache', 'qoj_contest_titles.json')


_YEAR = re.compile(r'(20\d{2})')


def _years(s: str) -> list[str]:
    """名字里出现的 4 位年份（`year_gap` 收的是**年份字符串**，不是整名 —— 传错就等于没守卫）"""
    return _YEAR.findall(str(s or ''))


def qoj_contests() -> list[tuple[str, str]]:
    """[(比赛号, 赛名)] —— 一场可能有多个名字，铺平成多行（匹配时取最高分）"""
    d = json.load(open(QOJ_INDEX, encoding='utf-8-sig'))
    out = []
    for cid, info in d.items():
        names = info.get('names') if isinstance(info, dict) else None
        for n in (names or ([info] if isinstance(info, str) else [])):
            if n:
                out.append((str(cid), str(n)))
    return out


def main(argv) -> int:
    loose = '--all' in argv

    crate = json.load(open(NODES, encoding='utf-8-sig'))
    qoj = qoj_contests()

    missing = []
    for r in crate['records']:
        if r.get('节点类型') != 'C':
            continue
        if (r.get('链接分类') or {}).get('problems'):
            continue
        missing.append(r)

    print(f'没有补题链接的场次：{len(missing)} 场')
    print(f'QOJ 索引里有 {len(qoj)} 条赛名（{len(set(c for c, _ in qoj))} 个比赛号）\n')

    exact, likely = [], []
    for r in missing:
        slug = str(r['extKey']).split(':c:')[-1]
        ours = str(r.get('name') or '')
        mine = name_tokens(ours)
        best = None
        for cid, name, toks in [(c, n, name_tokens(n)) for c, n in qoj]:
            common, score = overlap(mine, toks)
            if not common:
                continue
            if best is None or score > best[2]:
                best = (cid, name, score, common)
        if not best:
            continue
        cid, name, score, common = best
        # ⚠️ **年份守卫**：光看名字像不够 —— 实测 `ccpc2022hv` 会匹到 2025 的高职专场、
        #    `shcpc2024` 会匹到 2025 的上海站。`match.py` 的 `year_gap` 就是这个原语
        #    （它与"同一场认定"用的是同一份实现，不再自己造一套）。
        oy, qy = _years(ours), _years(name)
        if oy and qy and min(abs(year_gap(a, b)) for a in oy for b in qy) > 1:
            continue
        # ① 归一化后**全等** → 可以放心自动接
        if norm_text(ours) and norm_text(ours) == norm_text(name):
            exact.append((slug, ours, cid, name))
        # ② 只是"像" → 交给人看。
        # ⚠️ 必须要求**足够多的共同 token**：实测 `overlap` 在两个 token 上会给 1.00
        #    （`icpc2022preliminary-2` 曾以 1.00 匹到"XXX Olimpiada Informatyczna"），
        #    光看分数会把巧合当成匹配。
        elif common >= 4 and score >= 0.6:
            likely.append((slug, ours, cid, name, score, common))

    print(f'=== ① 归一化后全等（{len(exact)} 场，可以自动接）===')
    for slug, ours, cid, name in exact:
        print(f'  {slug:<38} → https://qoj.ac/contest/{cid}   {name[:40]}')

    print(f'\n=== ② 只是"像"（{len(likely)} 场，需人工复核）===')
    # 名单是给人**逐条判断**的：赛名不截断（截断会恰好切掉"第几届/哪一年"这些关键信息）
    for slug, ours, cid, name, score, common in likely:
        print(f'  {slug}')
        print(f'      本地: {ours}')
        print(f'      QOJ : {cid}  {name}')
        print(f'      分数 {score:.2f}｜共同词 {common}')

    if loose:
        print('\n=== ③ 全部低分候选（人工扫一眼，低分不代表错）===')
        for r in missing:
            slug = str(r['extKey']).split(':c:')[-1]
            mine = name_tokens(r.get('name') or '')
            scored = []
            for cid, name in qoj:
                common, score = overlap(mine, name_tokens(name))
                if common:
                    scored.append((score, common, cid, name))
            scored.sort(reverse=True)
            top = scored[0] if scored else None
            print(f'  {slug:<38} {str(r.get("name") or "")[:26]:<28} '
                  + (f'→ qoj {top[2]} {top[3][:40]}（{top[0]:.2f}/{top[1]}）' if top else '→ 一个都不像'))

    print(f'\n**可自动接：{len(exact)} 场；待人工复核：{len(likely)} 场；无补题链接共 {len(missing)} 场**')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
