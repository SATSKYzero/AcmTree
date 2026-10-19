#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
回代 baseline 的**交换格式**（读法 + 逐格比对）—— `scripts/nature_baseline_lib.py`

为什么单独一个模块：这份格式有**三个**消费者，读法只能有一份 ——

    · `scripts/nature-baseline.py`  —— 用它把人的结论回写进包（链尾那一步）；
    · `scripts/devserver/nature_store.py` —— 应用点「📤 导出人工填写」时**直接写盘**
      （本机主脚本那条路），写之前也要按同一个形状校验；
    · 两者之间的「**这次比磁盘上那份少了什么**」判据（口径：
      **缩水先拒绝、要人点一下确认**）—— 放在这里，两边看到的数字一样。

⚠️ 文件名用**下划线**（`nature_baseline_lib.py`）：那个带连字符的 `nature-baseline.py`
   是命令行入口、`import` 不进来；这个 lib 才是被 import 的那个。
"""

from __future__ import annotations

import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from crate import NATURE_FIELDS                                    # noqa: E402

#: 应用侧的格式标识与版本（`src/core/natureAssignments.js` 的 `ASSIGNMENTS_FORMAT` / `_VERSION`）
FORMAT = "nature-assignments"
SUPPORTED_VERSIONS = (1,)

#: 「人定的」那个规则 id（应用侧 `src/core/natureConfidence.js` 的 `MANUAL_RULE`，
#: 也是 `CLASS_RULE_LEVEL` 里映射到级别 `M` 的那一条）。
#: ⚠️ 字面量各写一份是为了不让通用脚本反向依赖 JS；`nature-baseline.py` 的 `selftest`
#:    会去 JS 文件里核对一致。
BASELINE_RULE = "manual:set"

#: 应用侧的"人工"来源 id（与 `src/core/fieldValue.js` 的 `MANUAL_SRC` 同值）
MANUAL_SRC = "manual"

#: 规则 id 的形状（与 `crate.CLASS_RULE_PATTERN` 同源；这里只做"别写进脏东西"的兜底）
RULE_SHAPE = re.compile(r"^[a-z][a-z0-9-]*:[A-Za-z][A-Za-z0-9-]*$")


def parse_baseline(data: dict, label: str = "baseline") -> dict:
    """
    校验一份 baseline **文档**（已经 `json.loads` 过的）并归一化成两张表。

    ⚠️ 与 `load_baseline()` 是同一套判据：那个只是"读文件 + 调我"。
    不合法**直接抛 `ValueError`**（这是版本化交换格式，宁可当场停）。

    @returns `{byExtKey: {extKey: {字段: 值}}, bySynthKey: {...}, generatedAt, registryVersion}`
    """
    if not isinstance(data, dict):
        raise ValueError(f"{label}：顶层不是对象")
    if data.get("format") != FORMAT:
        raise ValueError(f"{label}：format 应为 {FORMAT!r}，实际 {data.get('format')!r}"
                         "（这份文件应当由应用「判重整理」页的「📤 导出人工填写」导出）")
    version = data.get("version")
    if version not in SUPPORTED_VERSIONS:
        raise ValueError(f"{label}：version {version!r} 不认识（本脚本支持 {SUPPORTED_VERSIONS}）")
    rows = data.get("assignments")
    if not isinstance(rows, list):
        raise ValueError(f"{label}：assignments 不是数组")

    by_ext: dict[str, dict] = {}
    by_synth: dict[str, dict] = {}
    # ★ 每条还带着**导出那一刻那个节点的名字**（应用写进 `name`，只给人看的快照）——
    #   回代时拿它核对"这个 identity **现在还是不是那一场**"：同一个 cid 换读法（或改名）时，
    #   手填值会被静默套到"改了名字的同一场"上（25/24 浙江省赛就是这么烂的）⇒ 见 `renamed`。
    name_ext: dict[str, str] = {}
    name_synth: dict[str, str] = {}
    for i, one in enumerate(rows):
        if not isinstance(one, dict):
            raise ValueError(f"{label}：第 {i} 条不是对象")
        ext = str(one.get("extKey") or "").strip()
        synth = str(one.get("synthKey") or "").strip()
        if not ext and not synth:
            raise ValueError(f"{label}：第 {i} 条既没有 extKey 也没有 synthKey")
        fields = one.get("fields")
        if not isinstance(fields, dict) or not fields:
            raise ValueError(f"{label}：第 {i} 条（{ext or synth}）的 fields 是空的")
        out: dict[str, str] = {}
        for field, info in fields.items():
            if field not in NATURE_FIELDS:
                raise ValueError(f"{label}：第 {i} 条（{ext or synth}）里有未知性质字段 {field!r}")
            value = info.get("v") if isinstance(info, dict) else info
            value = "" if value is None else str(value).strip()
            if not value:
                raise ValueError(f"{label}：第 {i} 条（{ext or synth}）的 {field} 没有值")
            rule = str(info.get("rule") or "") if isinstance(info, dict) else ""
            if rule and (rule != BASELINE_RULE or not RULE_SHAPE.match(rule)):
                raise ValueError(f"{label}：第 {i} 条（{ext or synth}）的 {field} "
                                 f"rule={rule!r} 不是人工标记 {BASELINE_RULE!r}")
            out[field] = value
        ident = ext or synth
        (by_ext if ext else by_synth)[ident] = out
        stored_name = str(one.get("name") or "").strip()
        if stored_name:
            (name_ext if ext else name_synth)[ident] = stored_name

    # ★ **手工绑定的合成归属**（`ownerBindings`，可选一节）。
    #   它跟 nature 四字段同样重要 —— 丢了就"重出包之后人手绑的那些归属全漂掉"。
    bind_ext: dict[str, str] = {}
    bind_synth: dict[str, str] = {}
    for i, one in enumerate(data.get("ownerBindings") or []):
        if not isinstance(one, dict):
            raise ValueError(f"{label}：ownerBindings 第 {i} 条不是对象")
        ext = str(one.get("extKey") or "").strip()
        synth = str(one.get("synthKey") or "").strip()
        if not ext and not synth:
            raise ValueError(f"{label}：ownerBindings 第 {i} 条既没有 extKey 也没有 synthKey")
        owner = str(one.get("ownerSynth") or "").strip()
        if not owner:
            raise ValueError(f"{label}：ownerBindings 第 {i} 条（{ext or synth}）没有 ownerSynth"
                             "（空 = 解绑，不该写进来）")
        rule = str(one.get("rule") or "").strip()
        if rule and rule != BASELINE_RULE:
            raise ValueError(f"{label}：ownerBindings 第 {i} 条（{ext or synth}）的 "
                             f"rule={rule!r} 不是人工标记 {BASELINE_RULE!r}")
        (bind_ext if ext else bind_synth)[ext or synth] = owner

    # ★ **"人确认过这一组"**（`confirmedGroups`，可选一节）—— **组级标记**，按 `synthKey` 认。
    #   它与 nature / ownerSynth 是同一类东西：**人的结论**，丢了就得重新确认一遍
    #   （而 `problem-bind` 每轮重建全部题目组头 ⇒ 不随包带回来就会丢）。
    confirm_synth: dict[str, str] = {}
    for i, one in enumerate(data.get("confirmedGroups") or []):
        if not isinstance(one, dict):
            raise ValueError(f"{label}：confirmedGroups 第 {i} 条不是对象")
        synth = str(one.get("synthKey") or "").strip()
        if not synth:
            raise ValueError(f"{label}：confirmedGroups 第 {i} 条没有 synthKey"
                             "（组级标记按组键认，别的认不了）")
        confirm_synth[synth] = str(one.get("name") or "")

    # ★ **「这一条与同号那道题不是同一道」**（`splitMembers`，可选一节）—— **成员级标记**，按 `extKey` 认。
    #   它同样是**人的结论**（人在 ⑤ 点「✂️ 不同的题」打上的）：不写回包，下一次建包就会被算法
    #   重新并回同号那一组。
    split_ext: dict[str, bool] = {}
    for i, one in enumerate(data.get("splitMembers") or []):
        if not isinstance(one, dict):
            raise ValueError(f"{label}：splitMembers 第 {i} 条不是对象")
        ext = str(one.get("extKey") or "").strip()
        if not ext:
            raise ValueError(f"{label}：splitMembers 第 {i} 条没有 extKey"
                             "（成员级标记按成员身份认）")
        split_ext[ext] = True

    return {"byExtKey": by_ext, "bySynthKey": by_synth,
            "nameByExtKey": name_ext, "nameBySynthKey": name_synth,
            "bindByExtKey": bind_ext, "bindBySynthKey": bind_synth,
            "confirmBySynthKey": confirm_synth,
            "splitByExtKey": split_ext,
            "generatedAt": str(data.get("generatedAt") or ""),
            "registryVersion": data.get("registryVersion")}


def load_baseline(path: str) -> dict:
    """
    读 baseline 文件并**验证形状**（不合法直接抛）。

    ⚠️ 用 `utf-8-sig` 读：这份文件是**人手动搬过来的**（应用导出 → 放进 acm-data/），
       中途很可能被记事本之类的编辑器存成带 BOM 的 UTF-8。写出去的一律不带 BOM，
       但**读**得容得下 —— 为这个让整条链路报错不值得。
       （应用也可以**直接写盘**，这条路仍留着：手搬的习惯与外部来的文件都还得认。）
    """
    with open(path, encoding="utf-8-sig") as fh:
        data = json.load(fh)
    return parse_baseline(data, path)


def rows_of(data: dict) -> dict:
    """
    一份 baseline 文档 → `{identity: {字段: 值}}`（**只取值、不校验**）。

    用途只有一个：**新旧两份比一比**（谁没了 / 谁变了）。所以它要能读**旧的、形状未必完美**
    的那一份 —— 校验交给 `parse_baseline()`，别把"比对"也搞成"不合法就不给看"。

    ⚠️ 绑定（`ownerBindings`）当成一个**伪字段** `ownerSynth` 混进同一张表：
    这样"少了哪些节点/哪些格"的判据**一份就够**（缩水拒绝那道闸门也顺带覆盖绑定）。
    """
    out: dict[str, dict] = {}
    for one in (data or {}).get("assignments") or []:
        if not isinstance(one, dict):
            continue
        key = str(one.get("extKey") or one.get("synthKey") or "").strip()
        if not key:
            continue
        vals: dict[str, str] = {}
        for field, info in (one.get("fields") or {}).items():
            value = info.get("v") if isinstance(info, dict) else info
            vals[str(field)] = "" if value is None else str(value)
        out.setdefault(key, {}).update(vals)
    for one in (data or {}).get("ownerBindings") or []:
        if not isinstance(one, dict):
            continue
        key = str(one.get("extKey") or one.get("synthKey") or "").strip()
        if not key:
            continue
        out.setdefault(key, {})["ownerSynth"] = str(one.get("ownerSynth") or "")
    return out


def diff_rows(old_rows: dict, new_rows: dict) -> dict:
    """
    新旧两份 `rows_of()` 的差 —— **要人看的那三个数**。

    @returns `{added, removed, changed, addedKeys, removedKeys, changedKeys, changedFields}`
             （`added/removed` 按**节点**数、`changed` 按**节点**数，
              `changedFields` 才是一格一格数出来的）
    """
    old_keys, new_keys = set(old_rows), set(new_rows)
    added = sorted(new_keys - old_keys)
    removed = sorted(old_keys - new_keys)
    changed, changed_fields = [], []
    for key in sorted(old_keys & new_keys):
        fields = sorted(f for f in set(old_rows[key]) | set(new_rows[key])
                        if old_rows[key].get(f) != new_rows[key].get(f))
        if fields:
            changed.append(key)
            for f in fields:
                changed_fields.append({"key": key, "field": f,
                                       "was": old_rows[key].get(f, ""),
                                       "now": new_rows[key].get(f, "")})
    return {"added": len(added), "removed": len(removed), "changed": len(changed),
            "addedKeys": added, "removedKeys": removed, "changedKeys": changed,
            "changedFields": changed_fields}


def baseline_diff(old_doc: dict, new_doc: dict) -> dict:
    """两份 baseline **文档**的差（`diff_rows()` 的薄壳）"""
    return diff_rows(rows_of(old_doc), rows_of(new_doc))
