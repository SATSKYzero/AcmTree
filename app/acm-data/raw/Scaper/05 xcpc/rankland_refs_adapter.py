#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
rankland 的 `refLinks` → C 的 `链接分类`（**按用途分类，一条都不丢**）

口径：「rankland 的 refs 请区分是榜单还是补题比赛入口」

srk 里每场的 `contest.refLinks` 混着好几类入口，索引已经抓下来了（`refs: [{link, title}]`）。

**一次搬全部**：原则是
"数据爬取部分不应该有『存在多值时排除一些值』的逻辑"，所以本适配器
只做两件事：**认出类别** + **如实写进 C 的 `链接分类`**。
落哪个值由**应用层**从分类里挑（所有类别都进 `link`），
不在爬取层挑一个，也不把 github 当垃圾丢掉（那 89 条「原始榜单文件」实测一条都没进过树）。

判据：**标题优先**（本适配器手上有 `title`，判得比 URL 准），URL 用
`crate.classify_link()` 兜底 —— 分类表**唯一一份**在 `scripts/crate.py`。

    榜单   标题含 榜 / 排名 / ranklist / rankings / scoreboard / board
    补题   标题含 题 / problemset / 补题 / 公示 / 题面 / statement
    仓库   github.com/…
    其它   认不出的（照样写，不丢）

用法
----
    python rankland_refs_adapter.py <slug>
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from collections import Counter

sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, 'lib'))

from xcpc_common import (add_crate_path,  # noqa: E402
    CACHE, contest_key, find_contest, load_manifest, mid_key, open_tree, platform_key,
    read_json, rel, series_key, layers_of, xcpc_nature,
)
from read_modes import add_cli_args, configure_from  # noqa: E402

add_crate_path()

from crate import Crate, classify_link, link_kind_label, link_kinds  # noqa: E402

LABEL = 'rankland 入口链接'
SOURCE = 'rankland-refs'          # 与 index 合成一棵树：`aux-rankland`
INDEX = os.path.join(CACHE, 'rankland_index.json')

# **只保留标题判据**（本适配器有 title，比 URL 准）。
# ⚠️ URL 判据不在这里写：和 `rankland_index_adapter` 各写一份会判得相反
#    （同一批 github 链接可能一处丢弃、一处当主链接）。URL 兜底统一走
#    `crate.classify_link()`（**分类表唯一一份**在 `scripts/crate.py`）。
_BOARD_TITLE = re.compile(r'榜|排名|ranklist|rankings|scoreboard|board', re.I)
_PROB_TITLE = re.compile(r'题|problemset|补题|公示|题面|statement', re.I)


def classify(ref: dict) -> str:
    """
    一条 ref 属于哪一类链接（`crate.LINK_KINDS` 之一）。

    ⚠️ **优先看标题**：这个适配器手上有 `title`，判得比 URL 准 ——
    典型例子是牛客比赛页（`ac.nowcoder.com/acm/contest/<id>`），它既是榜单页又是题面页，
    光看 URL 分不出来（`classify_link()` 只能给个兜底）。

    原则（"数据爬取部分不应该有『存在多值时排除一些值』的逻辑"）：
      * **不设 `_SKIP`**（github 不丢弃）—— 那 89 条「原始榜单文件」链接
        本该如实记成 `repo`，实测它们**一条都没进过树**；
      * 返回的类别**不被当作"角色"去过滤**，而是照实写进 `链接分类`。
    """
    link, title = str(ref.get('link') or ''), str(ref.get('title') or '')
    if _BOARD_TITLE.search(title):
        return 'board'
    if _PROB_TITLE.search(title):
        return 'problems'
    # 标题给不出结论时才看 URL（`分类表唯一一份` 在 crate.py）
    return classify_link(link)


def build(contest: dict, slug: str, info: dict) -> Crate | None:
    """
    把这一场的**所有** refLinks 按类别写进 C 的 `链接分类`（**不取舍、不丢弃**）。

    按角色（`--role board` / `--role problems`）各写 C 的 `link` 会变成"挑一个"；
    这里只声明类别，落哪个字段由**应用层**决定 —— 见 `docs/field-rules.md`（链接类别）。
    """
    refs = [r for r in (info.get('refs') or []) if isinstance(r, dict) and r.get('link')]
    if not refs:
        return None
    pairs = [(classify(r), r['link']) for r in refs]
    series, mid = layers_of(contest)
    crate = Crate(source_id=f'rankland-refs-{slug}', label=LABEL,
                  platform=SOURCE, kind='script')
    # 骨架：O ─(W)aux「辅助节点」─(W)aux-rankland（与 index 同一个 W）
    open_tree(crate, SOURCE)
    parent = series_key(series['id'])
    crate.series(platform_key(), parent, name=series.get('name') or series['id'])
    if mid:
        mk = mid_key(series['id'], mid['id'])
        crate.series(parent, mk, name=mid.get('name') or mid['id'])
    else:
        mk = parent
    crate.contest(mk, contest_key(slug),
                  # ⚠️ **名字也要写**（不然会出现"比赛 · n_475880_munqybk3（aux-rankland:c:…）没名字"）：
                  #    有些场次**只有 refs 这一条 rankland 条目**（没有 rankland-index），
                  #    而 refs 若只写链接 ⇒ 那个 C 在树上就没有名字，应用只能退回显示**节点 id**
                  #    （`n_<计数器>_<base36>`，看着像乱码）。
                  #    清单里的 `name` 是现成的、也是这一场最权威的名字，写它不越权。
                  #    取不到就写 `None`（**别写空串**：空串会占住字段，让别家补不进来）。
                  name=(str(contest.get('name') or '') or None),
                  **xcpc_nature(series, mid, contest.get('name') or '', channel='rankland'),
                  **link_kinds(*pairs))
    counts = Counter(k for k, _u in pairs)
    print('   ℹ️ 入口链接：' + ' / '.join(
        f'{link_kind_label(k)}×{n}' for k, n in sorted(counts.items())))
    return crate


def main(argv):
    ap = argparse.ArgumentParser(description='rankland refLinks → C 的「链接分类」（一次搬全部）')
    ap.add_argument('slug', nargs='?')
    ap.add_argument('-o', '--output', default='')
    ap.add_argument('--manifest', default='')
    add_cli_args(ap, force_help='**强制重抓**（本适配器**只读本地索引** ⇒ 对它没有额外作用；'
                                '要重抓索引请跑 `build_rankland_index.py --force`）')
    args = ap.parse_args(argv)
    configure_from(args)

    manifest = load_manifest(args.manifest)
    if not args.slug:
        print('要给一个 slug', file=sys.stderr)
        return 2
    contest = find_contest(manifest, args.slug)
    if not os.path.isfile(INDEX):
        print(f'❌ 缺 {rel(INDEX)}', file=sys.stderr)
        return 1
    info = (read_json(INDEX).get('bySlug') or {}).get(args.slug) or {}
    crate = build(contest, args.slug, info)
    out = args.output or os.path.join(CACHE, f'crate_{args.slug}_rankland-refs.json')
    if crate is None:
        # 这场一个 ref 都没有 → 不产出片段（合并时跳过，和"0 条提交"同样的处理）
        if os.path.isfile(out):
            os.remove(out)
        print(f'ℹ️ {args.slug} 没有任何入口链接（refs 为空），不产出片段')
        return 0
    crate.save(out)
    print(f'✅ {rel(out)}   {crate.summary()}')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
