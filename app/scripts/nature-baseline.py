#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
回代 baseline（③）—— 把**人在应用里定过的 nature**回写进爬虫产出的包。

    python -B scripts/nature-baseline.py report --baseline acm-data/nature-assignments.json acm-data/nodes/all_nodes.json
    python -B scripts/nature-baseline.py apply  --baseline acm-data/nature-assignments.json acm-data/nodes/all_nodes.json
    python -B scripts/nature-baseline.py selftest

## 这是哪一步

`docs/manual-workflow.md`（回代三件套） 的三件套里那个 **③ `assignments.json`**（"对 crate 的增量"）：

    ① 注册表 `acm-data/nature-registry.json`（已有）
    ② 规则（爬虫侧：元列 `分类依据` 里的规则 id）
    ③ **人工增量** ← 本文件：脚本产出 → 人在应用里补/接受 → **应用导出 ③**
                        → 下次脚本跑先读它做 baseline

**为什么要回代**：规则会被我们不断改进，
一改，人工定过的那几十条就可能被重新推成别的值。有了 ③ 这条通道：

  · 人的结论**写进包里**（值 + `分类依据: manual:set`）⇒ 应用一看就知道这是 `M`（人工）；
  · 规则怎么改都不会漂掉它（包自己带着人的答案）；
  · 换个机器导这份包，也一样能复现——"既定效果"是**数据**，不是某台机器上的状态。

## 口径（三条，都有断言钉住）

1. **只有人定过的会进 baseline**（应用侧导出时就只收 `分类依据 == manual:set` 的字段：
   `src/core/natureAssignments.js`）。别的值都是规则的产物，脚本重跑能复现 ⇒ 不必带。
2. **只写"值 + 依据"**，不碰别的字段（名称 / 链接 / ratio / 父子关系一个字不动）；
   值仍要过 `crate.nature_fields()` 的受控词表校验 —— **不合法的一律不写**（连同它的 extKey 报出来）。
3. **baseline 里的 identity 在包里找不到**（场次没了、key 改了）**不是错误**，只报数字：
   它说明"你定过的那一场这次没在包里"，也许该回头看看它去哪了。

⚠️ 应用侧仍按 `fill-if-empty` 导入（不覆盖已有的值），所以回代**不会**因为两边不一致而互相打架：
   两边一致时它就写，恰好等于"把应用里的答案搬进了包"。
"""

from __future__ import annotations

import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import crate as crate_mod                                     # noqa: E402
from crate import nature_fields                                # noqa: E402

# ★ **格式的读法住在 `nature_baseline_lib.py`** —— 它有三个消费者
#   （本脚本 / 本机主脚本那条"直接写盘"的路 / 两者之间"少了什么"的比对），
#   读法只能有一份。这里把常量**原样 import 回来**（`selftest` 与下面的代码照旧用这些名字）。
from nature_baseline_lib import (                             # noqa: E402
    BASELINE_RULE, FORMAT, MANUAL_SRC, RULE_SHAPE, SUPPORTED_VERSIONS,
    baseline_diff, diff_rows, load_baseline, parse_baseline, rows_of)

# ⚠️ 上面那几个常量（`FORMAT` / `SUPPORTED_VERSIONS` / `BASELINE_RULE` / `MANUAL_SRC` /
#    `RULE_SHAPE`）与 `load_baseline()` 的实现**都住在 `nature_baseline_lib.py`** ——
#    本机主脚本那条"应用直接写盘"的路与"少了什么"的比对也用同一份，
#    所以这里只 import、不再各写一遍（本文件仍用这些名字，`selftest` 照旧）。


#: 应用侧的格式标识与版本（`src/core/natureAssignments.js` 的 `ASSIGNMENTS_FORMAT` / `_VERSION`）
#: ⚠️ 与常量一起住在 `nature_baseline_lib.py`；这里 import 回来是为了一处不改地沿用这些名字。
#: 报告里每类明细**最多列这么多条**（数字是完整的；别把整份 baseline 塞进包顶层报告）
LISTED = 200


def apply_baseline(data: dict, baseline: dict, dry_run: bool = False) -> dict:
    """
    把 baseline 回代进一份 crate（**原地改 `data`**，除非 `dry_run`）。

    @returns 统计：`{applied, unchanged, missing, invalid, keys, fields, sourced, ...}`
             ★ 三类**只读的核对**（"加**由原料脚本端给出**的『手输与自动计算结果一致』
             的列表，作为只读提示"）——它回答"这条人工钉住到底有没有用"：
               · `sameAsAuto`  —— 包里**脚本自己算出来的值**与人工值**一致**（钉不钉都一样，
                                  附上那条规则 id：你手输的正好就是规则会给的）；
               · `differs`     —— 包里有个**脚本算的值、但与你手输的不一样**（钉住真的在起作用）；
               · `filledEmpty` —— 包里那一格**本来空着**（脚本给不出值 ⇒ 你补的是缺口）。
             三者都带明细（`*Items`，封顶 `LISTED`），供报告与界面显示。
    """
    by_ext = baseline["byExtKey"]
    by_synth = baseline["bySynthKey"]
    # ★ **名字核对**：baseline 每条都存着"导出那一刻那个节点叫什么"（应用写的快照）。
    #   同一个 identity（`qoj:c:<id>` 这种）**可能换了读法/改了名** —— 那时这条手填写的是
    #   **另一场**，套上去就是把 A 场的结论按到 B 场上（实测：25/24 浙江省赛被旧的
    #   `qoj:c:1780/2021` 条目涂成 UC、`qoj:c:1195` 被涂成省赛）。⇒ **名字对不上就不套**，
    #   单独记一档 `renamed` 报出来（要人决定：改 baseline 的键、还是删掉）。
    name_ext = baseline.get("nameByExtKey") or {}
    name_synth = baseline.get("nameBySynthKey") or {}
    bind_ext = baseline.get("bindByExtKey") or {}
    bind_synth = baseline.get("bindBySynthKey") or {}
    # ★ **"人确认过这一组"**（组级标记）—— 按 `synthKey` 认，写回**组头**那一格。
    confirm_synth = baseline.get("confirmBySynthKey") or {}
    # ★ **「这一条与同号那道题不是同一道」**（成员级）—— 按 `extKey` 认，写回**成员**那一格。
    split_ext = baseline.get("splitByExtKey") or {}
    stats = {"applied": 0, "unchanged": 0, "missing": 0, "invalid": 0,
             "keys": 0, "fields": 0, "sourced": 0, "missingKeys": [], "invalidItems": [],
             "sameAsAuto": 0, "differs": 0, "filledEmpty": 0, "alreadyManual": 0,
             "sameAsAutoItems": [], "differsItems": [], "filledEmptyItems": [],
             # ★ 名字对不上（= 这条手填讲的**不是**现在这个 identity 指的那一场）⇒ 不套
             "renamed": 0, "renamedItems": [],
             # ★ 「人确认过这一组」写回组头（组级标记）——**两个方向都认**（见下面的回代）
             "confirmed": 0, "confirmedSame": 0, "confirmedItems": [],
             #   ★ 取消确认（应用里那个「取消确认标记」的落点）：包里写着 true、而这份
             #   `confirmedGroups` 里没有它 ⇒ 清掉。不报出来的话，一次取消几十个组
             #   会**一声不响**地发生。
             "confirmedCleared": 0, "confirmedClearedItems": [],
             # ★ 「与同号那道题不是同一道」写回成员（成员级标记）
             "split": 0, "splitSame": 0, "splitItems": [],
             # ★ 手工绑定的回代
             "bindings": 0, "bindingsSame": 0, "bindingsMissing": 0, "bindingItems": []}

    #: 指针那一格也算"人的结论"：回代时**值 + 依据 + 来源**三样一起写（与 nature 同一套）
    #:
    #: ⚠️ **只回代 C 层（"哪一场归到哪个组"），P 层（题目组）一律不回代**。
    #:   为什么（实测踩到，用户报"点一次换一次、永远改不动"）：
    #:     P 层的归属**本来每轮都由配对算出来**（`core/synthPlan.problemBindPlan` +
    #:     `scripts/problem-bind.mjs`）。可应用侧那几下动作（「➡️ 改到该键」/ 组头改名）
    #:     走的是 `applyOwnerSynth`，**一律打 `manual:set`**；导出时它们被当成"人的结论"
    #:     收进 `ownerBindings`，回代又写进包 ⇒ `problem-bind` 从此跳过它们（`keptHuman`）、
    #:     `synth-bind` 也不动（`🔒 人绑的…`）⇒ **某一版算错的归属被永久焊死**，
    #:     而 ⑤ 又如实报"过时" ⇒ 人点多少次都没用（一个死循环）。
    #:   ⇒ 判据：**P 层的指针不是"人的结论"，是"某一版脚本算出来的结论"**，不享受那条豁免。
    #:     （人若真要改某道题的归属，改完那一轮配对会按新题号/题名重新算出同一结果。）
    for rec in data.get("records") or []:
        if not isinstance(rec, dict):
            continue
        if str(rec.get("节点类型") or "").strip() == "P":
            continue
        ext = str(rec.get("extKey") or "").strip()
        synth = str(rec.get("synthKey") or "").strip()
        want = bind_ext.get(ext) if ext else None
        if want is None and synth:
            want = bind_synth.get(synth)
        if want is None:
            continue
        ident = ext or synth
        stats["bindings"] += 1
        cur = str(rec.get("ownerSynth") or "").strip()
        rules_b = rec.get("分类依据")
        if not isinstance(rules_b, dict):
            rules_b = {}
        srcs_b = rec.get("字段来源")
        if not isinstance(srcs_b, dict):
            srcs_b = {}
        if cur == want and rules_b.get("ownerSynth") == BASELINE_RULE:
            stats["bindingsSame"] += 1
            continue
        if len(stats["bindingItems"]) < LISTED:
            stats["bindingItems"].append({"key": ident, "was": cur, "now": want})
        if not dry_run:
            rec["ownerSynth"] = want
            rules_b["ownerSynth"] = BASELINE_RULE
            srcs_b["ownerSynth"] = MANUAL_SRC
            rec["分类依据"] = rules_b
            rec["字段来源"] = srcs_b

    # ★★ **"人确认过这一组"写回组头**（组级标记）。
    #   为什么单独一步：它落在**组头**（有 `synthKey` 的那条记录）上，而不是成员身上。
    #   ⚠️ 不写回的话，`problem-bind` 每轮重建全部题目组头 ⇒ 你的确认**下一次建包就没了**。
    if confirm_synth:
        for rec in data.get("records") or []:
            if not isinstance(rec, dict):
                continue
            sk = str(rec.get("synthKey") or "").strip()
            if not sk or sk not in confirm_synth:
                continue
            if rec.get("已确认") is True:
                stats["confirmedSame"] += 1
                continue
            if len(stats["confirmedItems"]) < LISTED:
                stats["confirmedItems"].append({"key": sk})
            stats["confirmed"] += 1
            if not dry_run:
                rec["已确认"] = True

    # ★★ **"取消确认"也要能回代**（上面那一段的另一半：一个只会写 `true`、从不写
    #   `false` 的回代，会让"取消"变成空动作 —— 人在应用里取消了，包里那格还是 `true`、
    #   `problem-bind` 照旧 `keepName` ⇒ 下一次建包又"确认"回来）。
    #   判据：**P 层组头**（题目组）。为什么只认这一层：
    #     · 这个标记的**唯一消费者**是 `problem-bind`，它只认"本步建的 P 合成节点"
    #       （`isOurSynth`：键带 `synth:problem:` 前缀 **且** 有 `父synthKey`）；
    #     · 应用侧写它的地方也只有一处（⑤ 的「✓ 确认这一场」，对象就是题目组头）。
    #   ⚠️ 这里用**结构**判 P 层组头（`节点类型 == 'P'` + 有 `父synthKey`），不字符串匹配
    #      前缀 —— 那个前缀的唯一定义在 JS 的 `src/core/synthPlan.js`，Python 这边 import
    #      不到，抄一份字面量就是第二处定义（全仓禁止）。
    #   ⚠️ 这一段**不能挂在上面的 `if confirm_synth:` 底下**：人把所有组都取消掉时
    #      `confirmedGroups` 是空表，而那时恰恰最需要这一趟（全清）。
    for rec in data.get("records") or []:
        if not isinstance(rec, dict):
            continue
        if str(rec.get("节点类型") or "").strip() != "P":
            continue
        if not str(rec.get("父synthKey") or "").strip():
            continue
        sk = str(rec.get("synthKey") or "").strip()
        if not sk or sk in confirm_synth:
            continue                       # 还在人确认的那份名单里（上面那一段已经写过）
        if rec.get("已确认") is not True:
            continue                       # 本来就没确认过（新组头 / 已经是 false）
        if len(stats["confirmedClearedItems"]) < LISTED:
            stats["confirmedClearedItems"].append({"key": sk})
        stats["confirmedCleared"] += 1
        if not dry_run:
            rec["已确认"] = False

    # ★★ **「这一条与同号那道题不是同一道」写回成员**（成员级标记；按 `extKey` 认）。
    #   不写回的话，算法下一轮会把它重新并回同号那一组（= 人的拆分结论被忘掉）。
    if split_ext:
        for rec in data.get("records") or []:
            if not isinstance(rec, dict):
                continue
            ext = str(rec.get("extKey") or "").strip()
            if not ext or ext not in split_ext:
                continue
            if rec.get("拆开") is True:
                stats["splitSame"] += 1
                continue
            if len(stats["splitItems"]) < LISTED:
                stats["splitItems"].append({"key": ext})
            stats["split"] += 1
            if not dry_run:
                rec["拆开"] = True

    for rec in data.get("records") or []:
        if not isinstance(rec, dict):
            continue
        ext = str(rec.get("extKey") or "").strip()
        synth = str(rec.get("synthKey") or "").strip()
        fields = by_ext.get(ext) if ext else None
        if fields is None and synth:
            fields = by_synth.get(synth)
        if fields is None:
            continue
        # ★ **名字对不上就不套**（见上面 `name_ext` 那段）：这条手填讲的是**另一场**。
        #   ⚠️ 只有两边都非空才比（老文件/没写名字的条目照旧套 —— 不能因为缺快照就不回代）。
        stored = (name_ext.get(ext) if ext else None) or (name_synth.get(synth) if synth else None) or ""
        now = str(rec.get("name") or "").strip()
        if stored and now and stored != now:
            stats["renamed"] += 1
            if len(stats["renamedItems"]) < LISTED:
                stats["renamedItems"].append({"key": ext or synth, "was": stored, "now": now})
            continue
        stats["keys"] += 1
        rules = rec.get("分类依据")
        if not isinstance(rules, dict):
            rules = {}
        # ★ 逐字段来源也要写上（自查逮到的不一致）：
        #   只写"值 + `分类依据: manual:set`"、**不写 `字段来源`** 的话，这 23 格在应用里
        #   没有来源记录，会被算到**输入包自己的 id**（`crate-merge`，类别 script）头上：
        #   界面显示 `B`（脚本给的），而 `分类依据` 明说这是 `M`（人定的）。同一个字段两处打架。
        #   `manual` 是应用侧的来源 id（`core/fieldValue.js` 的 `MANUAL_SRC`；`state.sources` 自带这一条）。
        srcs = rec.get("字段来源")
        if not isinstance(srcs, dict):
            srcs = {}
        for field, value in fields.items():
            stats["fields"] += 1
            # ⚠️ 值仍要过受控词表：注册表换过词之后，已有 baseline 里的值可能已经不合法了 ——
            #    那就**不写**（连同原因报出来），绝不让脏值进包。
            try:
                nature_fields((field, value))
            except ValueError as exc:
                stats["invalid"] += 1
                stats["invalidItems"].append(f"{rec.get('extKey') or rec.get('synthKey')} {field}={value}（{exc}）")
                continue
            # ★ 回代**之前**包里那一格是什么（= 脚本自己算出来的那个答案）+ 它的依据 id
            before = str(rec.get(field) if rec.get(field) is not None else "").strip()
            before_rule = str(rules.get(field) or "")
            item_key = rec.get("extKey") or rec.get("synthKey")
            # 值和依据都对上了，但**来源那格还缺** ⇒ 补上（幂等修补，不算"改过值"）
            if srcs.get(field) != MANUAL_SRC:
                stats["sourced"] += 1
                if not dry_run:
                    srcs[field] = MANUAL_SRC
            if before == value and before_rule == BASELINE_RULE:
                stats["unchanged"] += 1
                stats["alreadyManual"] += 1          # 包里本来就是这条人工值（重复回代）
                continue
            if before == value:
                # 脚本自己算出来的值与你手输的一致（依据 id 是脚本的，不是 `manual:set`）
                stats["sameAsAuto"] += 1
                if len(stats["sameAsAutoItems"]) < LISTED:
                    stats["sameAsAutoItems"].append({"key": item_key, "field": field,
                                                     "value": value, "rule": before_rule})
            elif not before:
                stats["filledEmpty"] += 1
                if len(stats["filledEmptyItems"]) < LISTED:
                    stats["filledEmptyItems"].append({"key": item_key, "field": field, "value": value})
            else:
                stats["differs"] += 1
                if len(stats["differsItems"]) < LISTED:
                    stats["differsItems"].append({"key": item_key, "field": field, "was": before,
                                                  "now": value, "rule": before_rule})
            stats["applied"] += 1
            if not dry_run:
                rec[field] = value
                rules[field] = BASELINE_RULE
        if not dry_run and rules:
            rec["分类依据"] = rules
        if not dry_run and srcs:
            rec["字段来源"] = srcs
    # ★ `manual` 也要登记进**来源表**（`source.sources`）—— 表是"这个 id 属于哪一类"的真源：
    #   记录里用了一个表里没有的 id，导入侧就只能当"未知 ⇒ script"（而它其实是人工，`M`）。
    #   `crate-invariants` 冒烟测试就是这么逮到我的（断言：表必须覆盖记录里用到的每个来源）。
    if not dry_run and stats["sourced"]:
        source = data.get("source")
        if not isinstance(source, dict):
            source = {}
            data["source"] = source
        table = source.get("sources")
        if not isinstance(table, dict):
            table = {}
            source["sources"] = table
        table.setdefault(MANUAL_SRC, {"kind": "manual", "label": "人工填写"})
    # 包里一个都没落上的 identity（场次没了 / key 改了）—— 只报数字，不是错误
    seen_ext = {str(r.get("extKey") or "").strip() for r in (data.get("records") or [])
                if isinstance(r, dict)}
    seen_synth = {str(r.get("synthKey") or "").strip() for r in (data.get("records") or [])
                  if isinstance(r, dict)}
    for key in by_ext:
        if key not in seen_ext:
            stats["missing"] += 1
            stats["missingKeys"].append(key)
    for key in by_synth:
        if key not in seen_synth:
            stats["missing"] += 1
            stats["missingKeys"].append(key)
    # 绑定那一节同样要报"包里找不到"（写错了 extKey / 那场没了）
    for key in list(bind_ext) + list(bind_synth):
        if key not in seen_ext and key not in seen_synth:
            stats["bindingsMissing"] += 1
            stats["missing"] += 1
            stats["missingKeys"].append(key)
    return stats


def _report(name: str, stats: dict, baseline: dict) -> None:
    print(f"   {name}：回代 {stats['applied']} 处 / 已一致 {stats['unchanged']} 处"
          f" / 命中 {stats['keys']} 个节点（baseline 里 {len(baseline['byExtKey'])} + "
          f"{len(baseline['bySynthKey'])} 条）")
    # ★ **人工值 vs 脚本自己算出来的值**（只读核对，写进报告给应用显示）——
    #   "加由原料脚本端给出的『手输与自动计算结果一致』的列表，作为只读提示"。
    if stats.get("sameAsAuto") or stats.get("differs") or stats.get("filledEmpty"):
        print(f"      ↳ 与脚本算出来的一致 {stats.get('sameAsAuto', 0)} 处"
              f"（钉不钉都一样）｜压住了脚本的值 {stats.get('differs', 0)} 处"
              f"（钉住真的在起作用）｜包里本来空着 {stats.get('filledEmpty', 0)} 处")
        first = (stats.get("sameAsAutoItems") or [])[:3]
        for one in first:
            print(f"         · {one['key']} {one['field']}={one['value']}"
                  f"（脚本给的也是这个值，依据 {one['rule'] or '（无 id）'}）")
        if len(stats.get("sameAsAutoItems") or []) > 3:
            print(f"         …另有 {stats['sameAsAuto'] - 3} 处（完整列表在报告里）")
    # ★ 手工绑定的回代：单独报一行（它不属于 nature 四字段）
    if stats.get("bindings"):
        print(f"      ↳ 手工绑定的合成归属 {stats['bindings']} 条"
              f"（已一致 {stats.get('bindingsSame', 0)}｜找不到 {stats.get('bindingsMissing', 0)}）"
              "：值 + `分类依据.ownerSynth=manual:set` + 来源 三样一起写")
    # 补 `字段来源`（值/依据一致、但来源那格缺）—— 幂等修补，单独报出来别混进"回代"
    if stats.get("sourced"):
        print(f"      ↳ 其中 {stats['sourced']} 处的 `字段来源` 补齐成 `{MANUAL_SRC}`"
              f"（只写值 + 依据的话，应用会把人工值当脚本来源，级别也不对）")
    # ★ 「人确认过这一组」/「不同的题」的回代：单独报一行（两组都是**人的结论**，
    #   而且**取消确认**这一半是"删掉结论"，不报出来就会悄悄发生）
    if stats.get("confirmed") or stats.get("confirmedSame") or stats.get("split") or stats.get("confirmedCleared"):
        print(f"      ↳ 「人确认过这一组」写回 {stats.get('confirmed', 0)} 个组头"
              f"（已一致 {stats.get('confirmedSame', 0)} 个）"
              f"｜**取消确认** {stats.get('confirmedCleared', 0)} 个"
              f"｜「不同的题」写回 {stats.get('split', 0)} 条"
              f"（已一致 {stats.get('splitSame', 0)} 条）")
    if stats["missing"]:
        # ⚠️ 措辞要说**时点**：这一趟是"回代那一刻"的核对，而**合成节点还会在后面的步骤里
        #    被建出来 / 改名**（`synth-bind.mjs` 会新建组、把旧清单键换成新键）——
        #    所以"找不到"不等于"最终包里没有"（实测：`synth:xcpc:2023ic_provincial-山东`
        #    回代时还没有那个头、最终包里有，可它那一格手填**就是没落上**）。
        #    写成"不在本包"会让人以为包坏了；说清"那一刻还不在"才是准确的，
        #    而且它恰好指出了该做什么（重新导出/一键对齐后重跑）。
        print(f"      ⚠️ 回代那一刻、这 {stats['missing']} 个 identity 还不在包里"
              f"（组头多半是**之后**才建出来/改名的）⇒ 那几格手填没落上："
              + "、".join(stats["missingKeys"][:5]) + ("…" if stats["missing"] > 5 else ""))
    if stats["invalid"]:
        print(f"      ⚠️ 有 {stats['invalid']} 处**没写**（值过不了注册表词表）：")
        for one in stats["invalidItems"][:5]:
            print(f"         · {one}")
    if stats.get("renamed"):
        # ⚠️ 这一档**不是"值过期"而是"身份换了"**：同一个 extKey 现在指另一场（换读法/改名）。
        #    套上去就是把 A 场的结论按到 B 场上 ⇒ 一律不套，等人在 baseline 里改键或删掉。
        print(f"      ⚠️ 有 {stats['renamed']} 条**名字对不上**（同一个键现在指另一场）⇒ 一条都没套：")
        for one in (stats.get("renamedItems") or [])[:5]:
            print(f"         · {one['key']}：baseline 写的是「{one['was']}」，包里是「{one['now']}」")
        if stats["renamed"] > 5:
            print(f"         …另有 {stats['renamed'] - 5} 条（完整列表在报告里）")


#: 报告写哪儿（与 `field-coverage.py` / `material-needs.py` 同一目录；`embed-reports.py`
#:  按 `REPORT_FILES` 把这几份 JSON 塞进包顶层 `reports`。**每轮都写**（没有 baseline 时也写），
#:  否则上一版的报告会留在那儿、被当成本轮的结论搬进包。）
REPO = os.path.dirname(HERE)
REPORT_PATH = os.path.join(REPO, "acm-data", "reports", "baseline.json")


def write_report(baseline: dict, baseline_path: str, total: dict, dry_run: bool,
                 listed: int = LISTED) -> str:
    """把这一轮的核对写进 `acm-data/reports/baseline.json`（应用侧只读显示）。"""
    from datetime import datetime, timezone
    payload = {
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": "scripts/nature-baseline.py",
        "baseline": {
            # ⚠️ 写**仓库相对路径**（不写绝对路径）：报告会随包发布、包要能换台机器用，
            #    绝对路径既是噪音又是"本机在哪"的泄漏。
            "path": os.path.relpath(baseline_path, REPO).replace("\\", "/"),
            "generatedAt": baseline.get("generatedAt") or "",
            "registryVersion": baseline.get("registryVersion"),
            "nodes": len(baseline.get("byExtKey") or {}) + len(baseline.get("bySynthKey") or {}),
            "fields": total.get("fields", 0),
        },
        "listed": listed,
        "applied": total.get("applied", 0),
        "unchanged": total.get("unchanged", 0),
        "sourced": total.get("sourced", 0),
        # ★ 三类核对（那份列表就是 `sameAsAuto`）
        "sameAsAuto": total.get("sameAsAuto", 0),
        "differs": total.get("differs", 0),
        "filledEmpty": total.get("filledEmpty", 0),
        "sameAsAutoItems": total.get("sameAsAutoItems") or [],
        "differsItems": total.get("differsItems") or [],
        "filledEmptyItems": total.get("filledEmptyItems") or [],
        "bindings": total.get("bindings", 0),
        "bindingsSame": total.get("bindingsSame", 0),
        "bindingItems": total.get("bindingItems") or [],
        "missing": total.get("missing", 0),
        "missingKeys": total.get("missingKeys") or [],
        # ★ 名字对不上（同一个键现在指另一场）⇒ 一条都没套。**与 `missing` 分开报**：
        #   "找不到"是那一刻还没有这个键；"名字对不上"是**键还在、但它已经不是那一场了**。
        "renamed": total.get("renamed", 0),
        "renamedItems": total.get("renamedItems") or [],
        # ⚠️ 这两项是**回代那一刻**的快照，链尾**不重算**（刻意的）：
        #    "找不到"不等于"最终包里没有" —— 合成节点会在后面的步骤里被建出来 / 改名
        #    （`synth-bind.mjs`），所以最终包里可能**有**这个键，可那几格手填**就是没落上**
        #    （回代跑在它前面）。按最终包重算会把这件事**抹掉**，那是把真问题藏起来。
        #    ⇒ 结论照旧按"回代那一刻"说，措辞在应用侧（`ui/dedup/naturePending.js`）写清了时点。
        "invalid": total.get("invalid", 0),
        "invalidItems": total.get("invalidItems") or [],
        "dryRun": bool(dry_run),
    }
    os.makedirs(os.path.dirname(REPORT_PATH), exist_ok=True)
    tmp = REPORT_PATH + ".tmp-write"
    try:
        with open(tmp, "w", encoding="utf-8", newline="\n") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=1)
            fh.write("\n")
        os.replace(tmp, REPORT_PATH)
    except OSError as err:
        try:
            os.remove(tmp)
        except OSError:
            pass
        print(f"   ⚠️ 核对报告没写成（{err}）—— 不影响回代本身")
        return ""
    return os.path.relpath(REPORT_PATH, REPO).replace("\\", "/")


def run(paths: list[str], baseline_path: str, dry_run: bool, out_path: str = "",
        no_report: bool = False) -> int:
    """
    @param no_report - **不重写核对报告**（链上"补一遍回代"那一步用）。
        为什么要有它：核对报告说的是"**回代那一刻**"的事（哪些 identity 当时不在包里、
        哪些值压住了脚本），那是**有意义的一份快照**；链尾再跑一遍回代只为"把刚建出来/
        改名之后的组头也补上值"，它一写报告就会把那一刻的结论冲成"全都 alreadyManual"。
    """
    if not os.path.isfile(baseline_path):
        # 没有 baseline = 还没人在应用里定过什么（或者还没导出）⇒ **不是错误**，
        # 让重建链路照常跑完（这是它出现在产包末尾的理由）。
        print(f"（没有回代 baseline：{baseline_path} —— 跳过。"
              "有手工填写时，在应用「判重整理 · ③」点「📤 导出人工填写」再放过来）")
        # ⚠️ **报告照写**（全 0）：不然上一版那份会留在原地被 `embed-reports` 搬进包，
        #    应用就会拿**上一次**的核对结果当这一轮的结论。
        if not dry_run:
            write_report({"byExtKey": {}, "bySynthKey": {}, "generatedAt": "",
                          "registryVersion": None}, baseline_path,
                         {"fields": 0}, dry_run=False)
        return 0
    baseline = load_baseline(baseline_path)
    print(f"回代 baseline：{baseline_path}"
          f"（导出于 {baseline['generatedAt'] or '未知'}，注册表版本 {baseline['registryVersion']}）"
          f" · {len(baseline['byExtKey'])} 个 extKey + {len(baseline['bySynthKey'])} 个 synthKey")
    if out_path and len(paths) != 1:
        print("❌ --out 只在**单个** crate 时有意义（多份就各自就地改写）")
        return 1

    #: 总表**从空开始**：键由上面那个"按统计表的键累加"填齐（见那段注释）
    total = {}
    for path in paths:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        stats = apply_baseline(data, baseline, dry_run=dry_run)
        _report(os.path.relpath(path), stats, baseline)
        # ★ **按统计表的键累加**，不写死名单（写死的话，加了 `bindings` 三个计数器却
        #   忘了同步 `total` 的初始化 ⇒ `KeyError: 'bindings'` ⇒ **整条链判失败**）。
        #   现在：数字相加、列表相接，新增一项统计**不用改这里**。
        for k, v in stats.items():
            if isinstance(v, list):
                total.setdefault(k, []).extend(v)
            elif isinstance(v, (int, float)):
                total[k] = total.get(k, 0) + v
        if dry_run:
            continue
        target = out_path or path
        with open(target, "w", encoding="utf-8", newline="\n") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=1)
            fh.write("\n")
    verb = "会回代" if dry_run else "已回代"
    print(f"✅ {verb} {total['applied']} 处人工填写"
          + (f"（{len(paths)} 份包）" if len(paths) > 1 else "")
          + ("；--dry-run 没有写盘" if dry_run else ""))
    if not dry_run and not no_report:
        wrote = write_report(baseline, baseline_path, total, dry_run=False)
        if wrote:
            print(f"   📋 核对报告：{wrote}（随包发布 ⇒ 应用「判重整理 · ③」那一行只读显示）")
    return 0


# ================================================================
# selftest：用构造器造一份小 crate，跑一遍 report / apply
# ================================================================
def selftest() -> int:
    fails: list[str] = []
    checks = 0

    def ok(cond: bool, what: str) -> None:
        nonlocal checks
        checks += 1
        if not cond:
            fails.append(what)

    # ① 与 JS 侧的字面量核对（跨语言的两份不许漂）
    js = os.path.join(os.path.dirname(HERE), "src", "core")
    conf = os.path.join(js, "natureConfidence.js")
    assign = os.path.join(js, "natureAssignments.js")
    if os.path.isfile(conf):
        with open(conf, encoding="utf-8") as fh:
            text = fh.read()
        ok(f"'{BASELINE_RULE}'" in text, f"JS 侧要认 {BASELINE_RULE!r}（classRuleOf / 级别表）")
        ok("MANUAL_LEVEL = 'M'" in text or "MANUAL_LEVEL = \"M\"" in text,
           "JS 侧的人工级别字母要是 M")
    if os.path.isfile(assign):
        with open(assign, encoding="utf-8") as fh:
            text = fh.read()
        ok(f"ASSIGNMENTS_FORMAT = '{FORMAT}'" in text, f"格式标识要与 JS 的 {FORMAT!r} 一致")
        ok(f"ASSIGNMENTS_VERSION = {SUPPORTED_VERSIONS[0]}" in text, "版本号两边一致")
    ok(bool(RULE_SHAPE.match(BASELINE_RULE)), f"{BASELINE_RULE!r} 要是合法规则 id")

    # ② 一份最小 crate：两个 C（一个会被回代、一个不在 baseline 里）
    c = crate_mod.Crate(source_id="selftest", label="回代自测")
    c.platform("p", name="平台")
    c.series("p", "s", name="系列")
    c.contest("p:s", "s:c1", name="甲站",
              **nature_fields(("natureClass", "xcpc/icpc"), ("natureYear", "2024")))
    c.contest("p:s", "s:c2", name="乙站",
              **nature_fields(("natureClass", "xcpc/ccpc/pre")))
    data = c.to_dict()

    baseline = {"byExtKey": {"s:c1": {"natureClass": "xcpc/icpc/ec/regional/official",
                                      "natureYear": "2025"}},
                "bySynthKey": {}, "generatedAt": "", "registryVersion": 1}
    stats = apply_baseline(data, baseline)
    ok(stats["applied"] == 2, f"两处都该被回代，实际 {stats['applied']}")
    ok(stats["keys"] == 1, f"命中一个节点，实际 {stats['keys']}")
    rec = [r for r in data["records"] if r.get("extKey") == "s:c1"][0]
    ok(rec.get("natureClass") == "xcpc/icpc/ec/regional/official", "值被写进去了")
    ok(rec.get("natureYear") == "2025", "年份也被写进去了")
    ok((rec.get("分类依据") or {}).get("natureClass") == BASELINE_RULE,
       "依据标成 manual:set（应用一看就知道是 M）")
    ok((rec.get("分类依据") or {}).get("natureYear") == BASELINE_RULE, "两个字段都标")
    # ★ 值 / 依据 / **来源** 三样都要写（少了 `字段来源`，
    #   应用会把人工值算到输入包自己的 id 头上（script/`B`），而依据说是 `manual:set`（`M`）。
    ok((rec.get("字段来源") or {}).get("natureClass") == MANUAL_SRC,
       f"来源那格也写 manual，实际 {(rec.get('字段来源') or {}).get('natureClass')!r}")
    ok((rec.get("字段来源") or {}).get("natureYear") == MANUAL_SRC, "两个字段的来源都写")
    # 来源表也要认得 `manual`（否则导入侧只能当"未知 ⇒ script"，级别又不对了）
    ok(((data.get("source") or {}).get("sources") or {}).get(MANUAL_SRC, {}).get("kind") == "manual",
       "来源表里登记了 manual（kind=manual）")
    other = [r for r in data["records"] if r.get("extKey") == "s:c2"][0]
    ok("分类依据" not in other, "没在 baseline 里的节点一个字不动")
    ok("字段来源" not in other, "来源那格同样一个字不动")
    # ★ **人工值 vs 脚本算出来的值**这三类（只读提示就是 `sameAsAuto`）
    #   `s:c1` 两处都改过（`xcpc/icpc` → 更深的一层、年份 2024 → 2025）⇒ 两处 `differs`
    ok(stats["differs"] == 2, f"两处都压住了脚本的值，实际 {stats['differs']}")
    ok(stats["sameAsAuto"] == 0 and stats["filledEmpty"] == 0, "这份夹具里没有「一致」与「补空」")
    ok({i["field"] for i in stats["differsItems"]} == {"natureClass", "natureYear"}, "明细按字段列出")
    ok(all(i["was"] and i["now"] for i in stats["differsItems"]),
       "明细里「原来是什么、现在是什么」都在")

    # ③ 幂等：再跑一遍 ⇒ 全部"已一致"，没有新的写入
    again = apply_baseline(data, baseline)
    ok(again["applied"] == 0 and again["unchanged"] == 2,
       f"第二遍应当是 0 写 / 2 已一致，实际 {again}")
    ok(again["sourced"] == 0, "第二遍来源也齐了 ⇒ 不再补（幂等）")
    ok(again["sameAsAuto"] == 0 and again["alreadyManual"] == 2,
       "★ 第二遍**不能**把「已一致」误报成「与脚本算的一样」（那是重复回代，不是核对）")

    # ③b 值/依据都对、**只有来源那格缺** ⇒ 只补来源（幂等修补），不重算成"改过值"
    del rec["字段来源"]
    repair = apply_baseline(data, baseline)
    ok(repair["applied"] == 0 and repair["unchanged"] == 2 and repair["sourced"] == 2,
       f"只缺来源 ⇒ 补来源、不算改值，实际 {repair}")
    ok((rec.get("字段来源") or {}).get("natureClass") == MANUAL_SRC, "补回来了")

    # ③c ★ 手工绑定的回代：值 + `分类依据.ownerSynth` + 来源 三样一起写
    c4 = crate_mod.Crate(source_id="selftest4", label="绑定自测")
    c4.platform("p4", name="平台")
    c4.series("p4", "s4", name="系列")
    c4.contest("p4:s4", "s4:c1", name="甲")
    d4 = c4.to_dict()
    b4 = {"byExtKey": {}, "bySynthKey": {}, "bindByExtKey": {"s4:c1": "synth:xcpc:icpc-ec:2020:银川"},
          "bindBySynthKey": {}, "generatedAt": "", "registryVersion": 1}
    st4 = apply_baseline(d4, b4)
    r4 = d4["records"][-1]
    ok(st4["bindings"] == 1 and r4.get("ownerSynth") == "synth:xcpc:icpc-ec:2020:银川",
       f"绑定写进去了，实际 {st4}")
    ok((r4.get("分类依据") or {}).get("ownerSynth") == BASELINE_RULE,
       "★ 依据标 `manual:set` —— 序列化后 `synth-bind` 看到它就不许再搬")
    ok((r4.get("字段来源") or {}).get("ownerSynth") == MANUAL_SRC, "来源那格也写 manual")
    again4 = apply_baseline(d4, b4)
    ok(again4["bindingsSame"] == 1 and again4["bindings"] == 1, "幂等：第二遍只报已一致")
    # 绑定里的 identity 找不到 ⇒ 与 nature 一样只报数
    st4b = apply_baseline(d4, {"byExtKey": {}, "bySynthKey": {},
                               "bindByExtKey": {"nope": "synth:x"}, "bindBySynthKey": {},
                               "generatedAt": "", "registryVersion": 1})
    ok(st4b["bindingsMissing"] == 1 and st4b["missing"] == 1, f"找不到要报，实际 {st4b}")
    # 形状校验：空 ownerSynth / 非人工 rule / 没有 identity 都当场拒
    bad_cases = (
        ({"ownerBindings": [{"extKey": "a", "ownerSynth": ""}]}, "空 ownerSynth"),
        ({"ownerBindings": [{"extKey": "a", "ownerSynth": "k", "rule": "qoj:path-icpc"}]},
         "rule 不是人工标记"),
        ({"ownerBindings": [{"ownerSynth": "k"}]}, "没有 identity"),
    )
    for bad, why in bad_cases:
        try:
            parse_baseline({"format": FORMAT, "version": 1, "assignments": [], **bad})
            ok(False, f"{why} 该被拒")
        except ValueError:
            ok(True, f"{why} 被拒")
    # 旧文件（没有 `ownerBindings` 这一节）照样能读
    ok(parse_baseline({"format": FORMAT, "version": 1, "assignments": []})["bindByExtKey"] == {},
       "旧 baseline（没有绑定那一节）兼容")

    # ③d ★ `run()` 的总表**按统计表的键累加**（写死名单会漏键 ⇒ `KeyError: 'bindings'`）
    #     —— 这里钉住"每个统计键都能被累加器接住"（数字相加 / 列表相接）。
    st_keys = set(apply_baseline(d4, b4).keys())
    acc = {}
    for k, v in apply_baseline(d4, b4).items():
        if isinstance(v, list):
            acc.setdefault(k, []).extend(v)
        elif isinstance(v, (int, float)):
            acc[k] = acc.get(k, 0) + v
    ok(set(acc) == st_keys, f"统计表里每个键都被累加器接住（差集 {st_keys ^ set(acc)}）")
    ok(isinstance(acc.get("bindingItems"), list) and isinstance(acc.get("bindings"), int),
       "绑定那一项：数字与列表都归位")

    # ④ 找不到的 identity 只报数字
    miss = apply_baseline(data, {"byExtKey": {"s:nope": {"natureClass": "xcpc"}},
                                 "bySynthKey": {}, "generatedAt": "", "registryVersion": 1})
    ok(miss["missing"] == 1 and miss["applied"] == 0, f"找不到的要单独计数，实际 {miss}")

    # ④b ★ **名字对不上就不套**（同一个 identity 现在指**另一场**）
    #     来由：`qoj:c:<id>` 这种键会因"换读法/改名"指向另一场 —— 照套就是把 A 场的结论
    #     按到 B 场上（实测 25/24 浙江省赛被旧条目涂成 UC）。这里钉住：不套 + 单独记一档 +
    #     明细带两边的名字；而**名字一致**时照旧套（别把这闸门做成"没有名字快照就不回代"）。
    c4b = crate_mod.Crate(source_id="selftest4b", label="名字核对自测")
    c4b.platform("p4b", name="平台")
    c4b.series("p4b", "s4b", name="系列")
    c4b.contest("p4b:s4b", "s4b:c1", name="甲站")
    d4b = c4b.to_dict()
    ren = apply_baseline(d4b, {"byExtKey": {"s4b:c1": {"natureYear": "2020"}}, "bySynthKey": {},
                               "nameByExtKey": {"s4b:c1": "另一个名字"}, "nameBySynthKey": {},
                               "generatedAt": "", "registryVersion": 1})
    ok(ren["renamed"] == 1 and ren["applied"] == 0 and ren["keys"] == 0,
       f"名字对不上就不该套，实际 {ren}")
    ok(ren["renamedItems"][0]["key"] == "s4b:c1" and ren["renamedItems"][0]["was"] == "另一个名字"
       and ren["renamedItems"][0]["now"] == "甲站", "明细要带两边的名字")
    ok(str(d4b["records"][-1].get("natureYear") or "") == "", "名字对不上时那一格一个字都不动")
    same = apply_baseline(d4b, {"byExtKey": {"s4b:c1": {"natureYear": "2020"}}, "bySynthKey": {},
                                "nameByExtKey": {"s4b:c1": "甲站"}, "nameBySynthKey": {},
                                "generatedAt": "", "registryVersion": 1})
    ok(same["applied"] == 1 and same["renamed"] == 0, f"名字一致要照旧套，实际 {same}")
    # 老文件（**没写名字**那批）同样照旧套 —— 缺快照不能变成"不回代"
    noname = apply_baseline(d4b, {"byExtKey": {"s4b:c1": {"natureSeason": "2021"}}, "bySynthKey": {},
                                  "nameByExtKey": {}, "nameBySynthKey": {},
                                  "generatedAt": "", "registryVersion": 1})
    ok(noname["applied"] == 1 and noname["renamed"] == 0, f"没有名字快照时照旧套，实际 {noname}")

    # ⑤ 词表外的值**不写**（连同原因报出来）
    bad = apply_baseline(data, {"byExtKey": {"s:c1": {"natureClass": "不存在的根"}},
                                "bySynthKey": {}, "generatedAt": "", "registryVersion": 1})
    ok(bad["invalid"] == 1 and bad["applied"] == 0, f"非法值不许进包，实际 {bad}")
    ok(rec.get("natureClass") == "xcpc/icpc/ec/regional/official", "非法值没有污染记录")

    # ⑥ dry-run 不写盘
    probe = crate_mod.Crate(source_id="selftest").to_dict()
    probe["records"].append({"节点类型": "C", "extKey": "s:c1",
                            "natureClass": "xcpc/icpc"})
    dry = apply_baseline(probe, baseline, dry_run=True)
    ok(dry["applied"] == 2 and probe["records"][-1].get("natureYear") is None,
       "--dry-run 只报数、不改")

    # ⑥b ★ 三类核对（那份"只读提示"就是 `sameAsAuto`）：
    #     包里**脚本自己算出来的值**与人工值一致 ⇒ 钉不钉都一样；不同 ⇒ 钉住真的在起作用；
    #     包里本来空着 ⇒ 你补的是缺口。三种都要能分清，且**明细带规则 id**。
    c3 = crate_mod.Crate(source_id="selftest3", label="核对自测")
    c3.platform("p3", name="平台")
    c3.series("p3", "s3", name="系列")
    c3.contest("p3:s3", "s3:same", name="一致",
               **nature_fields(("natureClass", "xcpc/ccpc/pre")))
    c3.contest("p3:s3", "s3:diff", name="不同",
               **nature_fields(("natureClass", "xcpc/ccpc/pre")))
    c3.contest("p3:s3", "s3:empty", name="空着")
    d3 = c3.to_dict()
    # 给"一致"那条写上脚本的依据 id（模拟管线留下的 `分类依据`）
    for r3 in d3["records"]:
        if r3.get("extKey") == "s3:same":
            r3["分类依据"] = {"natureClass": "xcpc:name-ccpc"}
        if r3.get("extKey") == "s3:diff":
            r3["分类依据"] = {"natureClass": "xcpc:name-ccpc"}
    st3 = apply_baseline(d3, {"byExtKey": {
        "s3:same": {"natureClass": "xcpc/ccpc/pre"},              # 与脚本算的一样
        "s3:diff": {"natureClass": "xcpc/ccpc/final/official"},    # 压住了脚本的值
        "s3:empty": {"natureClass": "xcpc/icpc"},                  # 包里本来空着
    }, "bySynthKey": {}, "generatedAt": "", "registryVersion": 1})
    ok(st3["sameAsAuto"] == 1 and st3["differs"] == 1 and st3["filledEmpty"] == 1,
       f"三类各 1 处，实际 {st3['sameAsAuto']}/{st3['differs']}/{st3['filledEmpty']}")
    ok(st3["applied"] == 3, "三处都会写进去（值一样也要把依据换成 manual:set）")
    ok(st3["sameAsAutoItems"][0]["key"] == "s3:same"
       and st3["sameAsAutoItems"][0]["rule"] == "xcpc:name-ccpc",
       "★ 「一致」那条要把**脚本的依据 id**带出来（人一看就知道脚本也是这个答案）")
    ok(st3["differsItems"][0]["was"] == "xcpc/ccpc/pre"
       and st3["differsItems"][0]["now"] == "xcpc/ccpc/final/official", "「不同」那条记原值/新值")
    ok(st3["filledEmptyItems"][0]["key"] == "s3:empty", "「补空」那条也列出")

    # ⑥c 报告文件：形状对、能落盘，而且**没有 baseline 时也写**（否则上一版会被搬进包）
    #     ⚠️ 夹具写在 `acm-data/reports/` 下、用完**当场删掉**：`tempfile` 在 Windows 沙箱里
    #        清理时会因为没有 chmod 权限而报错（实测踩到），而且我们要顺手钉"不留垃圾"。
    global REPORT_PATH
    saved_report = REPORT_PATH
    probe_report = os.path.join(os.path.dirname(HERE), "acm-data", "reports",
                                "selftest-baseline.json")
    REPORT_PATH = probe_report
    try:
        wrote = write_report({"byExtKey": {"a": {}}, "bySynthKey": {}, "generatedAt": "T",
                              "registryVersion": 1}, "acm-data/nature-assignments.json", st3, False)
        ok(wrote.endswith("selftest-baseline.json") and os.path.isfile(probe_report), "报告写得出")
        with open(probe_report, encoding="utf-8") as fh:
            doc = json.load(fh)
        ok(doc["sameAsAuto"] == 1 and doc["baseline"]["nodes"] == 1
           and doc["baseline"]["generatedAt"] == "T", "报告里的形状与内容对")
        ok(doc["sameAsAutoItems"][0]["rule"] == "xcpc:name-ccpc", "明细随报告一起发布")
        ok(not os.path.exists(probe_report + ".tmp-write"), "不留 .tmp-write 垃圾")
    finally:
        REPORT_PATH = saved_report
        try:
            os.remove(probe_report)
        except OSError:
            pass
    ok(not os.path.exists(probe_report), "临时报告清干净了")

    # ⑦ 合成节点（**没有 extKey**）按 synthKey 命中 —— 它是 C 节点，同样可能有人的结论
    c2 = crate_mod.Crate(source_id="selftest2", label="回代自测·合成")
    c2.platform("p2", name="平台")
    c2.series("p2", "s2", name="系列")
    c2.synth("synth:k", "C", parent="s2", name="合成甲",
             **nature_fields(("natureClass", "xcpc")))
    d2 = c2.to_dict()
    st2 = apply_baseline(d2, {"byExtKey": {}, "bySynthKey": {
        "synth:k": {"natureClass": "xcpc/ccpc/final/official"}},
        "generatedAt": "", "registryVersion": 1})
    ok(st2["applied"] == 1, f"合成节点按 synthKey 也该回代，实际 {st2}")
    srec = [r for r in d2["records"] if r.get("synthKey") == "synth:k"][0]
    ok(srec.get("natureClass") == "xcpc/ccpc/final/official", "合成节点的值被写进去了")
    ok((srec.get("分类依据") or {}).get("natureClass") == BASELINE_RULE, "依据同样标 manual:set")

    # ⑧ 坏文件的形状要被挡住
    for bad_data, why in (
        ({"format": "别的", "version": 1, "assignments": []}, "format 不对"),
        ({"format": FORMAT, "version": 99, "assignments": []}, "版本不认识"),
        ({"format": FORMAT, "version": 1, "assignments": [{"fields": {}}]}, "没有 identity"),
        ({"format": FORMAT, "version": 1,
          "assignments": [{"extKey": "x", "fields": {"name": {"v": "a"}}}]}, "未知字段"),
        ({"format": FORMAT, "version": 1,
          "assignments": [{"extKey": "x", "fields": {"natureClass": {"v": ""}}}]}, "空值"),
        ({"format": FORMAT, "version": 1,
          "assignments": [{"extKey": "x", "fields": {"natureClass": {"v": "xcpc", "rule": "qoj:path-icpc"}}}]},
         "不是人工标记"),
    ):
        path = os.path.join(HERE, "_baseline_selftest.json")
        try:
            with open(path, "w", encoding="utf-8", newline="\n") as fh:
                json.dump(bad_data, fh, ensure_ascii=False)
            try:
                load_baseline(path)
                ok(False, f"{why} 应当被拒")
            except ValueError:
                ok(True, f"{why} 被拒")
        finally:
            if os.path.isfile(path):
                os.remove(path)

    if fails:
        print(f"❌ 回代自测失败，{len(fails)}/{checks} 项：")
        for f in fails:
            print("   •", f)
        return 1
    print(f"✅ 回代自测通过：{checks} 项（形状 / 回代 / 幂等 / 找不到 / 非法值 / dry-run）")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="回代 baseline：把人工填的 nature 回写进包（③）")
    sub = ap.add_subparsers(dest="cmd", required=True)

    for name, help_text in (("apply", "回代（就地改写 crate）"),
                            ("report", "只报会改什么（不写盘）")):
        p = sub.add_parser(name, help=help_text)
        p.add_argument("crates", nargs="+", help="crate JSON 路径（可多份）")
        p.add_argument("--baseline", default=os.path.join(os.path.dirname(HERE),
                                                          "acm-data", "nature-assignments.json"),
                       help="回代 baseline（应用「③ 性质待补」页导出）")
        p.add_argument("--out", default="", help="只对单个 crate 有效：写到别处（默认就地）")
        p.add_argument("--dry-run", action="store_true", help="等价于 report（不写盘）")
        p.add_argument("--no-report", action="store_true", dest="no_report",
                       help="**不重写核对报告** —— 链上『补一遍回代』那一步用（见 `run()` 的说明）")

    sub.add_parser("selftest", help="跑内置断言")

    args = ap.parse_args(argv)
    if args.cmd == "selftest":
        return selftest()
    return run(args.crates, args.baseline, dry_run=args.cmd == "report" or args.dry_run,
               out_path=args.out, no_report=getattr(args, "no_report", False))


if __name__ == "__main__":
    sys.exit(main())
