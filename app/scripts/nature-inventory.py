#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
「分类 / 年份 / 赛季 / 地区」种类盘点 —— **只读工具**，把当前真源导成一份人看的底账。

     python -B scripts/nature-inventory.py            # 写到 docs/nature-inventory.md
     python -B scripts/nature-inventory.py -o out.md  # 写到别处

为什么要有它：为了优化种类判定与 nature 填写规则，而**种类（Trie）的真源**是
`acm-data/nature-registry.json`、**用量的真源**是产出的 `acm-data/nodes/all_nodes.json`。
这份文档只是两者的**导出物** —— 别手工改它，改完注册表/重出包再跑一遍这个脚本。

口径：
  · 精确 = `natureClass` 逐字等于这条路径；含下游 = 还包含它下面更深的路径；
  · 只统计**比赛（C）**（题/提交不背比赛级的性质）；
  · "在用但停在半路" = 该值不是叶子（只有到叶子才算"填好了"）。
"""

from __future__ import annotations

import argparse
import collections
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REGISTRY = os.path.join(ROOT, "acm-data", "nature-registry.json")
NODES = os.path.join(ROOT, "acm-data", "nodes", "all_nodes.json")
#: 「规则 id → 依据强度级别」的**唯一真源**（应用侧那张表；这里只读它，不抄一份）
CONFIDENCE_JS = os.path.join(ROOT, "src", "core", "natureConfidence.js")


def norm(v) -> str:
    return "" if v is None else str(v).strip()


def walk_trie(node: dict, prefix: tuple = ()):
    for seg, kids in (node or {}).items():
        p = prefix + (seg,)
        yield p, kids
        yield from walk_trie(kids or {}, p)


def class_rule_levels() -> dict:
    """
    从 JS 那张表里读出 `规则id → 级别`（**表在那边，唯一真源**）。

    为什么在 Python 里解析 JS：这一页要写"每条规则用了多少条"，而级别是**读法** ——
    在这里再抄一份就是第二份真源（哪天改了分级，没人会记得改这边）。
    解析不出来就返回空表：**这一页只是给人看的账**，不该因为读不到那张表而写不出来。
    """
    try:
        with open(CONFIDENCE_JS, encoding="utf-8") as fh:
            text = fh.read()
    except OSError:
        return {}
    if "CLASS_RULE_LEVEL" not in text:
        return {}
    body = text.split("CLASS_RULE_LEVEL", 1)[1].split("});", 1)[0]
    # ⚠️ 级别是**单个大写字母**：`[A-Z]` 而不是 `[A-E]` ——
    #    级别里还有 `M 人工`（`manual:set`），用 `[A-E]` 会把它读成"表里没登记"。
    return dict(re.findall(r"'([a-z][a-z0-9-]*:[A-Za-z][A-Za-z0-9-]*)'\s*:\s*'([A-Z])'", body))


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="性质种类盘点（只读）")
    ap.add_argument("-o", "--output", default=os.path.join(ROOT, "docs", "nature-inventory.md"))
    args = ap.parse_args(argv)

    trie = json.load(open(REGISTRY, encoding="utf-8"))["classTrie"]
    pkg = json.load(open(NODES, encoding="utf-8"))
    C = [r for r in pkg["records"] if r.get("节点类型") == "C"]

    all_paths = list(walk_trie(trie))
    leaf = {p for p, kids in all_paths if not kids}
    exact = collections.Counter()
    for r in C:
        v = norm(r.get("natureClass"))
        if v:
            exact[v] += 1
    roll = {"/".join(p): sum(n for v, n in exact.items()
                             if v == "/".join(p) or v.startswith("/".join(p) + "/"))
            for p, _k in all_paths}

    out: list[str] = []
    add = out.append
    add("# 「分类 / 年份 / 赛季 / 地区」种类盘点")
    add("")
    add("> **本文件是导出物，别手改**：种类真源 = `acm-data/nature-registry.json`，")
    add("> 用量真源 = `acm-data/nodes/all_nodes.json`。跑 `python -B scripts/nature-inventory.py` 重出。")
    add("")
    add(f"共 **{len(all_paths)}** 条路径（**{len(leaf)}** 条是叶子）、比赛（C）**{len(C)}** 个。")
    add("口径：**精确** = 值逐字等于这条路径；**含下游** = 还含它下面更深的路径；")
    add("判定规则：**只有落在叶子上的分类才算「填好了」**，停在中间的照样算「缺分类」。")
    add("")
    add("## 一、Trie 全表")
    add("")
    add("| 路径 | 叶子 | 精确 | 含下游 |")
    add("|---|---|---:|---:|")
    for p, _kids in all_paths:
        key = "/".join(p)
        add(f"| `{key}` | {'✅' if p in leaf else ''} | {exact.get(key, 0)} | {roll.get(key, 0)} |")
    add("")
    add("## 二、在用的「非叶子」值（要补规则的靶子）")
    add("")
    add("| 值 | 条数 |")
    add("|---|---:|")
    stuck = [(v, n) for v, n in sorted(exact.items(), key=lambda x: -x[1])
             if v not in {"/".join(p) for p in leaf}]
    for v, n in stuck:
        add(f"| `{v}` | {n} |")
    if not stuck:
        add("| （无） | 0 |")
    add("")
    add("## 三、从没用过的叶子（精确 0 且含下游 0）")
    add("")
    unused = ["/".join(p) for p, _kids in all_paths
              if p in leaf and exact.get("/".join(p), 0) == 0 and roll.get("/".join(p), 0) == 0]
    add("、".join(f"`{u}`" for u in unused) if unused else "（没有）")
    add("")
    add("## 四、按根（第一段）")
    add("")
    add("| 根 | C 数 | 有年份 | 有赛季 | 有地区 |")
    add("|---|---:|---:|---:|---:|")
    roots = collections.Counter()
    for r in C:
        roots[norm(r.get("natureClass")).split("/")[0] or "(空)"] += 1
    for root, n in roots.most_common():
        grp = [r for r in C
               if (norm(r.get("natureClass")).split("/")[0] or "(空)") == root]
        y = sum(1 for r in grp if norm(r.get("natureYear")))
        s = sum(1 for r in grp if norm(r.get("natureSeason")))
        g = sum(1 for r in grp if norm(r.get("natureRegion")))
        add(f"| `{root}` | {n} | {y} | {s} | {g} |")
    add("")
    add("## 五、年份 / 赛季 / 地区的取值现状")
    add("")
    years = collections.Counter(norm(r.get("natureYear")) or "(空)" for r in C)
    seasons = collections.Counter(norm(r.get("natureSeason")) or "(空)" for r in C)
    regions = collections.Counter(norm(r.get("natureRegion")) or "(空)" for r in C)
    add("- 年份：" + "、".join(f"`{k}` {v}" for k, v in years.most_common(12)))
    add("- 赛季：" + "、".join(f"`{k}` {v}" for k, v in seasons.most_common(12)))
    add("- 地区：" + "、".join(f"`{k}` {v}" for k, v in regions.most_common(12)))
    add("")
    add("## 六、停在半路的那批：赛名关键词画像")
    add("")
    add("| 关键词 | 条数 |")
    add("|---|---:|")
    stuck_nodes = [r for r in C if norm(r.get("natureClass")) in {v for v, _n in stuck}]
    for label, pat in (("icpc", r"icpc"), ("ccpc", r"ccpc"),
                       ("regional / 区域赛 / 站", r"regional|区域赛|區域賽|站"),
                       ("invitational / 邀请", r"invitational|邀请"),
                       ("final / 总决赛", r"final|总决赛"),
                       ("preliminary / online / 网络赛", r"preliminary|online|网络赛"),
                       ("provincial / 省赛", r"provincial|省赛"),
                       ("ladies / women", r"ladies|women|女生")):
        n = sum(1 for r in stuck_nodes
                if re.search(pat, f"{norm(r.get('name'))} {norm(r.get('extKey'))}", re.I))
        add(f"| {label} | {n} |")
    add("")
    add("## 七、没名字的比赛（应用会显示「（没名字）」+ 标识）")
    add("")
    noname = [r for r in C if not norm(r.get("name"))]
    if noname:
        for r in noname:
            add(f"- `{norm(r.get('extKey')) or norm(r.get('synthKey'))}`")
    else:
        add("（没有）")
    add("")
    add("## 八、谁在填这四个字段")
    add("")
    add("| 来源 | 分类 | 年份（举办） | 赛季 | 地区 |")
    add("|---|---|---|---|---|")
    add("| CF 正式赛 | `cf/contest/*` —— 按 CF `/contests` 的 `filterTypes` 严判到叶子 | 开赛时间 | `无`（没有赛季概念） | `无` |")
    add("| CF gym | `cf/gyms/xcpc/…`（**整棵 xcpc 子树的镜像**：`icpc/<赛区>/<阶段>/<official·warm-up>`、"
        "`ccpc/…`、`provincial&invitational/…`）／`cf/gyms/ucup`／`cf/gyms/无归类` —— 按**赛名**判"
        "（优先级：省赛/邀请赛 → CCPC → ICPC → UC → 无归类） | **赛季 = 赛名里的年份**；年份 = CF 开赛时间（拿不到退到赛名；总决赛没日期写 `待同步`） | = 年份 | **留空**（很多是线下站，只是暂时不填） |")
    add("| AtCoder | `atcoder/<abc·arc·agc>`（认不出 → `atcoder/无归类`） | 比赛时间 | `无` | `无` |")
    add("| QOJ | **所有**分类路径有一条过 icpc/ccpc ⇒ `qoj/xcpc/<branch>/<赛区 aa·ec·ap·aw·eu·la·na·ne>/<阶段>/<official·warm-up>`"
        "（赛区不在缩写表里 ⇒ 停在 `qoj/xcpc/icpc`）；标题是 Universal Cup ⇒ **`qoj/ucup`**；"
        "都不过 ⇒ `qoj/无归类` | 非总决赛 = 赛季年；总决赛拿不到日期写 `待同步`；"
        "**`qoj/ucup` 的年份与赛季都写 `无`** | 分类链路口名里的 20xx；**`qoj/ucup` = `无`** | **留空**"
        "（QOJ 上大量线下场次，不随便写 `无`） |")
    add("| 牛客 / 杭电 | `nk|hdu/多校`；练习赛/校赛留空 | 比赛时间 | = 举办年份（多校有赛季） | `无` |")
    add("| XCPC（xcpcio / rankland / pta / srk） | 系列定 icpc/ccpc ⇒ 按赛名判阶段（含 `区域`）+ 末层 `official`/`warm-up`"
        "（见 `xcpc_common.xcpc_class_of`）；省赛/邀请赛停在 `xcpc/provincial&invitational/<层>` | 从标题/标识取 20xx | 从标题/标识取 20xx | **留空**（源头只有拼音目录名） |")
    add("")
    add("> **末层 `official` / `warm-up`**（「xcpc 的各分支还要细分 official/warm-up」）："
        "每个阶段叶子下再分一层，赛名里有 `warm up` / `热身` 的写 `warm-up`，其余写 `official`；"
        "**`无归类` 不带这一层**（它没有「正式/热身」之分）。")
    add("")
    add("> 年份/赛季都能写 `待同步` / `不确定`（占位：处理过了、只是还没定），它们算「填过了」但**不被推荐**。")
    add("")
    add("> ⚠️ 判定规则写在 **Python 适配器**里（`acm-data/raw/Scaper/05 xcpc/*.py` 与 `lib/xcpc_common.py`），")
    add("> 注册表只定「有哪些种类」；应用侧只做**推荐**（`src/core/natureSuggest.js`）与**校验**（`core/natureFields.js` / `scripts/crate.py`）。")
    add("")
    add("## 九、分类依据：每条规则用了多少条")
    add("")
    add("`分类依据` = `{ 字段: '规则id' }` —— **逐字段**记「这条值是哪条规则判出来的」。")
    add("适配器记的是**最弱的那一环**（值的可信度由最弱证据决定）；级别表在 "
        "`src/core/natureConfidence.js` 的 `CLASS_RULE_LEVEL`，**这里只数用量、不写级别**"
        "（级别是「读法」，改了分级不用重跑数据）。")
    add("")
    for field, title in (('natureClass', '分类'), ('natureRegion', '地区')):
        add(f"### 九.{'1' if field == 'natureClass' else '2'} 「{title}」那一维")
        add("")
        add("| 规则 id | 级别 | 条数 |")
        add("|---|---|---:|")
        rules = collections.Counter()
        for r in C:
            meta = r.get("分类依据")
            if isinstance(meta, dict):
                rule = norm(meta.get(field))
                if rule:
                    rules[rule] += 1
        levels = class_rule_levels()
        for rule, n in rules.most_common():
            add(f"| `{rule}` | {levels.get(rule, '（表里没登记）')} | {n} |")
        if not rules:
            add("| （无） |  | 0 |")
        add("")
        no_rule = sum(
            1 for r in C
            if norm(r.get(field))
            and not (isinstance(r.get("分类依据"), dict)
                     and norm(r["分类依据"].get(field))))
        add(f"- 有规则可查的 C：**{sum(rules.values())}** 条；**{no_rule}** 条有值但没有规则"
            "（= **老数据**：从来没写过 `分类依据` 那一列 ⇒ 界面不画依据徽标）。"
            + ("⚠️ `manual:set`（级别 M）= **人改过/接受过**的值 —— 它比任何规则都硬，"
               "会经「回代 baseline」被写回包里（见 `scripts/nature-baseline.py`）。"
               if field == 'natureClass' else
               "⚠️ 地区读不出就**留空**（不猜）——那些就是 ③ 里等人补的。"))
        add("")
    text = "\n".join(out)
    with open(args.output, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)
    print(f"已写出 {os.path.relpath(args.output, ROOT)}（{len(all_paths)} 条路径 / C {len(C)} 个）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
