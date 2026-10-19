#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
rankland **索引** → crate 片段（C + P，**不算 ratio**）

为什么要有它
------------
有些场次只有 QOJ 上的补题记录，而 rankland 的 srk 文件有它的**赛名 + 题单**
（但不含"每题过队数"的原始矩阵 —— 索引只抓了文件头部）。这时：
  * 用 `srk_adapter --role board` 要先下整份 srk（5–8MB/场）；
  * 而**索引里已经有**这场的中文名、开赛时间、每题的 alias/题名/链接 —— 够拼出 C 与 P。

所以这个适配器直接从 `cache/rankland_index.json` 出 C + P，**Ratio 一个都不写**
（没有榜单数据源，宁可不给也不编；应用里那几道题就显示不出难度档，这是如实反映）。

⚠️ 它只出 `name` / `problemId` / `link` / `contestTime` —— 不碰 ratio、不碰提交。
一个字段只有一个来源：`rankland-index` 只当"身份 + 题单"用。

用法
----
    python rankland_index_adapter.py bjcpc2025
    python rankland_index_adapter.py bjcpc2025 -o out.json
"""

from __future__ import annotations

import argparse
import os
import sys

sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, 'lib'))

from xcpc_common import (add_crate_path,  # noqa: E402
    CACHE, contest_key, find_contest, layers_of, load_manifest, norm_letter, open_tree,
    platform_key, problem_key, read_json, rel, series_key, mid_key, xcpc_nature,
)
from read_modes import add_cli_args, configure_from  # noqa: E402

add_crate_path()

from crate import Crate, link_kinds, to_cst  # noqa: E402

LABEL = 'rankland 索引（题单）'
SOURCE = 'rankland-index'          # 它那棵树：`aux-rankland`
INDEX = os.path.join(CACHE, 'rankland_index.json')
BLOB = 'https://github.com/algoux/srk-collection/blob/master/'


def index_of(slug: str) -> dict:
    if not os.path.isfile(INDEX):
        sys.exit(f'❌ 没有跨平台索引 {rel(INDEX)} —— 先跑 build_rankland_index.py')
    doc = read_json(INDEX)
    info = (doc.get('bySlug') or {}).get(slug)
    if not info:
        sys.exit(f'❌ 索引里没有 {slug}')
    return info


def build(contest: dict, slug: str, info: dict, role: str = 'board',
          letters: list | None = None) -> Crate:
    series, mid = layers_of(contest)
    # role=board（出题单，这场以它为准）→ kind='board'；titles/time（**补充**）→ script。
    # ⚠️ `titles` 支与 `board` 支**内容完全一样**（都只出 name/problemId/link/contestTime，**不写 ratio**）
    #    —— 差别只在**声明的类别**：清单里 role 写 `titles` 的场次，榜单是别人（xcpcio/cf），
    #    这里只是补题名/题号 ⇒ 拿"权威榜单"身份会压掉真榜单的同名字段（2026-10-16 修：
    #    流水线原来把 titles 折成 board，实测 134 个 `rankland-index-*` 全是 board）。
    crate = Crate(source_id=f'rankland-index-{slug}', label=LABEL, platform=SOURCE,
                  kind=('board' if role == 'board' else 'script'))
    # 骨架：O ─(W)aux「辅助节点」─(W)aux-rankland
    open_tree(crate, SOURCE)
    parent = series_key(series['id'])
    crate.series(platform_key(), parent, name=series.get('name') or series['id'])
    if mid:
        mk = mid_key(series['id'], mid['id'])
        crate.series(parent, mk, name=mid.get('name') or mid['id'])
    else:
        mk = parent

    ck = contest_key(slug)
    # ⚠️ 空值一律写 `None`（`Crate` 会把 None 丢掉、`""` 会留下占位）：
    # 索引里很多场次没有开赛时间、题目**没有题名或链接**（实测 icpc 186 场里只有 45 场有题链接），
    # 写空串就等于"我认为它是空的"，后面再挂一个更权威的来源（CF/xcpcio）也补不进来。
    if role == 'time':
        # ⚠️ `--role time`：**只出 C 的「开赛时间」这一个字段**，别的（name/link/kind）一个都不写 ——
        # 挂它的场次榜单是 CF/PTA（名字/链接/题单由榜单给），只有时间缺，让 crate-merge 的
        # "后到者补空"填上即可；多写任何字段都会和榜单撞成 field-value-conflict（实测 11 条）。
        # ⚠️ 性质字段**也要按同一口径一起走**（它是 C 上的普通字段，不是结构列）：
        #    别的角色（xcpcio/pta/srk）已经写了同样的值 ⇒ 合并时**同值不冲突**；
        #    若这里不写，那些"只跑 time 角色"的场次在树上就会缺 nature。
        # ★ **例外：这一场如果没有别的名字来源**（清单里既没有 `board`、也没有 `titles` 角色
        #   —— 名字/链接本该由它们给），那"后到者补空"永远等不到人 ⇒ 树上会留一个
        #   **没名字、没链接的空壳 C**（实测 `icpc2024hangzhou`：1102 场里就它一个，
        #   `crate-invariants` 的"每场比赛都有分类链接"为它单独报红）。这种场次
        #   就把索引能给的名字写上（有名字的那一份来源不存在 ⇒ 不会有冲突）。
        # ★ **不再赌"别人来补空"**：`--role time` 原先只写时间，指望更权威的来源把
        #   名字/链接补上 —— 但那只在"别的来源写**同一个 C**（同 slug、同树）"时成立；
        #   **CF 写的是自己的树**（`cf:c:<gym>`）⇒ 只要一场的 board/titles 全是 CF，
        #   `aux-rankland:c:<slug>` 就永远没人补，留下没名字、没链接的空壳
        #   （实测 `icpc2024hangzhou`）。这一支改成把**索引自己那份事实**写上：
        #   名字（`title` → 清单 `name` → slug）+ **仓库链接**（索引里的 `repoPath`）。
        #   别的来源给了更权威的值时照旧由既有投影/冲突规则处理（这里 `kind='script'`）。
        _repo = (BLOB + str(info.get('repoPath') or '')) if info.get('repoPath') else ''
        crate.contest(mk, ck, contestTime=(to_cst(info.get('startAt')) or None),
                      name=str(info.get('title') or contest.get('name') or slug),
                      **xcpc_nature(series, mid, contest.get('name') or '', channel='rankland',
                                    held_time=str(info.get('startAt') or '')),
                      **link_kinds(('repo', _repo)))
        return crate

    # 索引给的 `blob/official/….srk.json` 是**仓库里的数据文件**，不是给人点的入口 ——
    # 类别如实声明为 `repo`（不能让它占着 C 的 `link` ——"仓库"冒充"补题链接"）；
    # 爬取层只声明类别，落哪个字段由应用层决定。
    repo_link = (BLOB + str(info.get('repoPath') or '')) if info.get('repoPath') else ''
    crate.contest(mk, ck,
                  name=str(info.get('title') or contest.get('name') or slug),
                  contestTime=(to_cst(info.get('startAt')) or None),
                  kind='contest',
                  **xcpc_nature(series, mid, contest.get('name') or '', channel='rankland',
                                held_time=str(info.get('startAt') or '')),
                  **link_kinds(('repo', repo_link)))

    for p in info.get('problems') or []:
        letter = norm_letter(p.get('alias'))
        if not letter:
            continue
        crate.problem(ck, problem_key(slug, letter),
                      problem_id=letter,
                      name=(str(p.get('title') or '') or None),
                      link=(str(p.get('link') or '') or None))
    # 索引里**没有**的题号：xcpcio 的 config 报了题号、这里没有对应条目时补一个空壳
    # （否则那些题的 P 节点不存在，xcpcio 出的 ratio 就挂不上；题名/链接以后再补）
    have = {norm_letter(p.get('alias')) for p in (info.get('problems') or [])}
    for letter in (letters or []):
        letter = norm_letter(letter)
        if letter and letter not in have:
            crate.problem(ck, problem_key(slug, letter), problem_id=letter)
    return crate


def main(argv):
    ap = argparse.ArgumentParser(description='rankland 索引 → crate 片段（C + P，不算 ratio）')
    ap.add_argument('slug', nargs='?')
    ap.add_argument('-o', '--output', default='')
    ap.add_argument('--manifest', default='')
    ap.add_argument('--role', default='board', choices=('board', 'titles', 'time'),
                    help='board=出 C+P 题单（**这场以它为准**）；titles=同上，但只是**补充**'
                         '（kind=script，不许压榜单）；time=**只出 C 的开赛时间**')
    ap.add_argument('--letters', default='',
                    help='逗号分隔的题号（xcpcio config 里的）：索引里没有的也补一个空壳 P，'
                         '这样榜单（xcpcio）出的 ratio 才挂得上')
    add_cli_args(ap, force_help='**强制重抓**（本适配器**只读本地索引** ⇒ 对它没有额外作用；'
                                '要重抓索引请跑 `build_rankland_index.py --force`）')
    args = ap.parse_args(argv)
    configure_from(args)

    manifest = load_manifest(args.manifest)
    if not args.slug:
        print('要给一个 slug', file=sys.stderr)
        return 2
    contest = find_contest(manifest, args.slug)
    info = index_of(args.slug)
    letters = [x for x in (args.letters or '').split(',') if x.strip()]
    crate = build(contest, args.slug, info, args.role, letters)
    out = args.output or os.path.join(CACHE, f'crate_{args.slug}_rankland-index.json')
    crate.save(out)
    if args.role == 'time':
        print(f'✅ {rel(out)}   {crate.summary()}   ← 只补开赛时间 {to_cst(info.get("startAt"))}')
        return 0
    np = len(info.get('problems') or [])
    print(f'✅ {rel(out)}   {crate.summary()}')
    print(f'   赛名：{info.get("title")}｜开赛：{to_cst(info.get("startAt"))}｜题目 {np} 道')
    print('   ℹ️ 不写 ratio（索引里没有榜单数据）——应用里这些题会显示不出难度档')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
