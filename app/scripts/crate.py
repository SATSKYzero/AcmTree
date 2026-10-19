#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Acm_Tree 节点自动导入 —— 导入包（crate）构造与校验工具

用途
----
给"各平台的爬虫脚本"用：把爬取结果拼成 Acm_Tree 能直接导入的 crate，
并在**导入之前**离线自查，避免"导进去才发现一堆错误"。

这个文件是**纯标准库、零依赖**的，可以直接复制进你自己的爬虫项目。

契约来源
--------
应用侧契约（权威）：docs/auto-import.md
本工具实现的是其中"成熟 crate"格式（第 7 节）：

    {
      "crateVersion": 1,
      "source": { "id": "...", "label": "..." },
      "generatedAt": "...",                 # 可选，不参与内容哈希
      "fieldMap": { "<爬虫列名>": "<内部字段名>" | null },
      "defaults": { "fieldPolicies": {...} },   # 可选
      "records": [
        { "节点类型": "W", "extKey": "qoj", "父extKey": "", "name": "QOJ" },
        { "节点类型": "P", "extKey": "qoj:4113:20236", "父extKey": "qoj:4113",
          "题号": "A", "题目名称": "All Closed" }
      ]
    }

三条硬规则（写错了导入会被逐条拒绝）
------------------------------------
1. **每个节点都必须有非空 extKey**（身份键）。没有 → 该条被拒。
2. **`父extKey` 必须能解析**：要么在同包的 records 里，要么已在主树上。
   两边都没有 → 该条被拒（应用**不会**帮你隐式创建容器）。
3. **容器链必须合法**（docs/auto-import.md 2.5）：

       O → W/S     平台 / 系列
       W → S/W     平台下只能是平台或系列（**不能直接放比赛**）
       S → C/S     系列下是比赛或系列
       C → P       比赛下是题目
       P → R       题目下是提交记录

   注意 `W` 下放 `C` 是**非法**的，必须中间插一层 `S`。

字段策略（决定"会不会冲掉手填数据"）
------------------------------------
应用按 `fieldMap` 把爬虫列名映射成内部字段名，然后按**逐字段策略**写入：

- 已存在的节点：`name`/`problemId`/`cfDifficulty`/`ratio`/`contestTime`/`link` 以及
  其它可写字段（`kind`/`identityKey`/`language`/`timeUsed`/`memoryUsed`/
  `codeLength`）都用 `fill-if-empty` —— **只补空、绝不动你已经改过的值**；
  `tags`/`remark` 一律 **不覆盖**（标签是你手工整理的，题解不可再生）。
- 新建的节点：按 create 默认表写入。
- **派生字段永远不可写**：`status1` `status2` `acTime` `lastSubmitTime`
  `xcpcDifficulty` `statusComplete1/2`。它们由应用从子节点/ratio 推导。
  → 所以爬虫**不需要**输出"是否通过"，把 R（提交记录）导进去就够了。

用法
----
    from crate import Crate, KIND_PROBLEM, KIND_SUBMISSION, KIND_CONTEST

    c = Crate(source_id="my-scraper", label="我的爬虫")
    c.platform("qoj")                                  # W
    c.group("qoj", "contest", name="QOJ Contest")       # S（满足 W→S→C）
    c.contest("qoj", "4113", name="Round 4113")         # C
    c.problem("qoj", "4113", problem_key="20236", ...)  # P
    c.submission(...)                                   # R
    c.save("out.json")

    issues = validate_crate_file("out.json")            # 离线自查
"""

from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone

# ================================================================
# 常量：节点类型与合法的父子关系（docs/auto-import.md 2.5）
# ================================================================


TYPE_PLATFORM = "W"

TYPE_SERIES = "S"

TYPE_CONTEST = "C"

TYPE_PROBLEM = "P"

TYPE_SUBMISSION = "R"

TYPE_ROOT = "O"

NODE_TYPES = (TYPE_ROOT, TYPE_PLATFORM, TYPE_SERIES, TYPE_CONTEST, TYPE_PROBLEM, TYPE_SUBMISSION)

TYPE_LABELS = {
    "O": "超级根", "W": "平台", "S": "系列",
    "C": "比赛", "P": "题目", "R": "提交记录",
}

# 合法的子类型：与 src/core/model/constants.js 的 TYPE_CHILDREN_MAP 一致

ALLOWED_CHILDREN = {
    "O": ("W", "S"),
    "W": ("S", "W"),
    "S": ("C", "S"),
    "C": ("P",),
    "P": ("R",),
    "R": (),
}

# 可以由导入写入的内部字段（**唯一真源**：`src/core/model/elements.js` 里 `importable: true`）
#
# ⚠️ JS 那两份都是从元素表**派生**的（`features/AutoImport/constants.js` 的 `WRITABLE_FIELDS`
#    与 `core/fieldValue.js` 的 `WRITABLE_VALUE_FIELDS`，都走 `importableElements()`）；
#    Python 这边没法 import JS ⇒ **只能手抄这一份**。所以有**对拍**：
#    `scripts/crate_selftest.py` 的 `_crate_self_checks()` 会把这份清单与 JS 真模块报出来的
#    那 24 个逐字比一遍（加字段时漏了一边，`npm run crate:selftest` 当场红）——
#    否则就会分叉成"适配器写了 `identityKey`，校验器却说会被当作未使用字段"。

WRITABLE_FIELDS = frozenset({
    "name", "problemId", "cfDifficulty", "ratio", "link", "tags",
    "contestTime", "time", "status",
    "kind",          # C 的种类：contest | practice
    "identityKey",   # P 的跨场身份（同一题在多场共享）
    # **数值难度字段组** ——
    #   同一道题的数值难度，各来源各写各的字段（现在：CF 官方 `cfDifficulty` / kenkoooo
    #   `atcoderDifficulty`；将来 clist 的另立一个）。组只知道"这几个是同一类信息"，
    #   谁赢由来源优先级决定（见 `acm-data/field-registry.json` 的 `groups`）。
    "atcoderDifficulty",
    "clistDifficulty",
    # 「先提取备用」：提交的运行信息（口径：毫秒 / 字节）
    "language", "timeUsed", "memoryUsed", "codeLength",
    # R 的**提交性质**（赛时 / VP / 补题；判不出就留空 —— 不写"未知"）
    "submitKind",
    # 合成：合成节点的身份 + 原料节点的指针（都是结构性的全局信息，
    # 可以随包走，但**不记手改来源值**；一个包的成员指针在导入时二阶段解析）
    "synthKey", "ownerSynth",
    # 「性质」三字段：
    #   分类 natureClass（**不定层路径** `xcpc/icpc/ec/pre`，合法性 = 注册表里的 Trie）
    #   年份 natureYear（20xx）/ 地区 natureRegion（自由文本，线上赛填「无」）
    # 原料脚本**至少要先填好分类**（方便在主脚本里筛选补全）；
    # 三个都可空 —— 判不出来就留空，别写"未知"。取值必须走下面的 `nature_fields()`。
    "natureClass", "natureYear", "natureSeason", "natureRegion",
    # ★ 「这一组（题目组）人确认过」—— **组级标记**，只落在题目组头上（`types: ['P']`）。
    #   随包走：应用把它导出成 baseline 的 `confirmedGroups`，重建时 `scripts/problem-bind.mjs`
    #   读**那一份**保住"人确认过的组"（组名取人给的快照、成员不动）——
    #   ⚠️ 那一步跑在链上 `baseline2` **之前**，而 `xcpc_pipeline` 会把上一轮的 P 层记录整批收掉
    #   ⇒ 包里的这一格到那时**还没写回来**，光靠它认不出人确认过谁。
    #   应用侧也靠它把那一组从 ⑤ 里去掉。
    "已确认",
    # ★ 「这一条与同号那道题**不是同一道**」—— **成员级标记**（人在 ⑤ 点「✂️ 不同的题」打上）。
    #   算法见到它就给这一条发**溢出号**（`X1、X2…`），从此与那一号分属两组。
    "拆开",
})

# 派生字段：**永远不可写**，写了会被应用忽略

DERIVED_FIELDS = frozenset({
    "status1", "status2", "acTime", "lastSubmitTime",
    "xcpcDifficulty", "statusComplete1", "statusComplete2",
})

# 各类型常用的"看起来像内部字段"的列名，供 validate 提示用

KNOWN_INTERNAL = WRITABLE_FIELDS

CURRENT_CRATE_VERSION = 1

# 提交结果：与应用的 STATUS_OPTIONS 完全一致
#
# ⚠️ **`CE` 必须在这张表里**：各来源的
#    编译错误一律被洗成 `-`（`cf_adapter` / `atcoder_adapter` 明写 `→ '-'`；HDU 抓取脚本与
#    牛客那边映射出来的 `CE` 又在这一层被丢掉）—— 那是**有意义的结论**，不该丢。
#    应用侧同一份表：`src/A_constants.js` 的 `STATUS_OPTIONS` + `RESULT_COLORS`（颜色）。
#
# ⚠️ **`P.AC`（部分分）**：
#    QOJ 有些场次按**测试点部分给分**，一行的 Result 会写成 `AC , WA`（有的点过、有的点没过）；
#    还有的场次 Result 直接给**得分**（ICPC 计分）。`AC , WA` 这种**一行多判定** ⇒ **`P.AC`**
#    （读作"部分 AC"；**字面带点**，字面量就是 `P.AC` —— 它只当**值**用，
#    从不进类名/选择器/文件名，所以那个点不会惹事：已 grep 确认）。
#    ⚠️ QOJ 原始映射的 `PC` / `PAC` 写法（PTA 的 `PARTIAL_ACCEPTED`）仍收，统一归一成 `P.AC`。
#
# ⚠️ **`ILE`（交互题空转，颜色与 TLE 一致）**——
#    CF 的 `IDLENESS_LIMIT_EXCEEDED` 实测 26 条，不映射就落 `-`。
# ⚠️ **除枚举之外还允许"自造缩写"**（其他文本随意但一定要有，最好英文缩写）：
#    `normalize_status()` 对**非空但认不出**的文本会给一个英文缩写（见 `_abbrev_status`），
#    **不再返回 `-`** —— `-` 只留给**真的空**（没有判定）。应用侧对"不在 STATUS_OPTIONS 里的值"
#    用**淡灰**渲染（`RESULT_COLOR_UNKNOWN`），所以自造缩写照样看得见。
STATUS_OPTIONS = ("AC", "WA", "TLE", "RE", "MLE", "OLE", "CE", "ILE", "P.AC", "-")

# extKey 长度上限（应用侧的"格式可疑"阈值）

MAX_EXT_KEY_LENGTH = 200
# synthKey（合成标识）长度上限 —— 跨语言契约：应用侧真源是
# `src/core/ops/synth.js` 的 `MAX_SYNTH_KEY_LEN`，两边必须一致。

MAX_SYNTH_KEY_LENGTH = 64

# 允许合成的节点类型 —— 跨语言契约：应用侧真源是 `src/core/ops/synth.js` 的
# `SYNTH_TYPES`（同义同源的还有 `src/core/dedup.js`）。
# W / S / O **一律不许**合成：它们不参与"同一实体跨场归并"。

SYNTH_TYPES = ("C", "P", "R")
# 提交性质（`submitKind`）的**值域** —— 只有这三个，**空串**表示"判不出"。
# ⚠️ 这是**跨语言契约**：应用侧真源是 `src/core/model/status.js` 的 `SUBMIT_KINDS`，
#    两边必须逐字一致（`src/test/submitKind.test.js` 有一条契约钉）。
#    各适配器**只准用下面的常量**，别再把字面量抄一遍。

SUBMIT_KINDS = ('赛时', 'VP', '补题')
SUBMIT_DURING, SUBMIT_VP, SUBMIT_AFTER = SUBMIT_KINDS


# ================================================================
# 链接分类（**唯一一份**）
#
# 为什么要有它：C 上的链接若**没有类别**，就成了谁先到谁占 `link`，靠的是清单里来源的
# 数组顺序（先到先得）。结果是同一个 URL 会重复占位、
# 而"这条链接是干什么用的"完全看不出来。
#
# 不分类的代价：分类逻辑**散在各适配器里**，同一个 github「原始榜单文件」链接，
# `rankland_refs_adapter` 判"垃圾、丢掉"（`_SKIP`），`rankland_index_adapter` 却拿它
# 当 C 的主链接 —— **同一类链接两处判定相反**，这就是"分类必须收口到一处"的证据。
#
# 语义（**唯一口径**）：
#   * **所有类别的链接都进 `link` 一个字段** —— 不设 `boardLink`（它只是"分开"的
#     一层，被分类取代后就是多余的）。
#   * 缓存值（`node.link`）由**应用层**按类别优先级挑第一条：
#     补题 → 榜单 → 仓库 → 其它（见 `src/core/linkKinds.js` 的 `LINK_KIND_PRIORITY`）。
#     所以"有补题入口时它就是补题链接"，**没有也不会空着**（退到榜单/仓库）。
#     ⚠️ "`link` 只接受 `problems`、没有就空着"**不成立**，别按它写代码。
#   * 其余候选**一条都不丢**，全部留在来源层里（带 `kind`），应用侧按类别分组渲染。
#
# ⚠️ 只按 **URL** 判，不看标题：这是给"手上没有上下文"的地方用的助手
#    （如 `rankland_index_adapter` 只拿到一个 URL）。
#    **有上下文的适配器应该自己声明类别**（如牛客比赛页：`nk` 榜说它是 `board`、
#    rankland 的「赛题重现」ref 说它是 `problems` —— **同一个 URL、两种正确类别**，
#    URL 分类器天生分不出来，所以它只是助手，不是权威）。
#    加新类别时记住这条约束。
# ================================================================

# 现在 5 类。第 5 类 `browse` 是**真有源才有的**：容器节点（平台的站、QOJ 的分类、CF 的 gym 列表）
# 都该能点回**源站上那个容器页**去核对归属 —— 系列、W 节点的 qoj、cf、cf gym 都加上链接，
# 顺便可以降低排查难度。
# （`题解` 仍然一条都没有，继续不加。）

LINK_KINDS = ("board", "problems", "repo", "browse", "unknown")

# 类别 → 中文名（应用侧渲染用；这里定义一次，别在别处再抄一份）

LINK_KIND_LABELS = {
    "board": "榜单",
    "problems": "补题",
    "repo": "仓库",
    "browse": "浏览",
    "unknown": "其它",
}


# ================================================================
# 「性质」四字段（**唯一一份**）
#
# 口径："nature 可以像链接一样，开若干可选的字段。先来 4 个：
#        大类：xcpc/cf/atc…  小类：icpc/ccpc/省赛/邀请赛/省赛或邀请赛
#        年份：20xx          地区：…"
#       "nature 的填写一定要注册表…如果注册表从主脚本返回来，
#        那至少原料脚本要先填好大类，方便在主脚本筛选补全。"
#       "用 Atcoder，此处只是简写描述"；
#       "其所对应的合成节点的名字与路径完全与 xcpcio / rankland
#        无关，只与 nature 有关"；
#       "『省赛与邀请赛』特指两者合办、无法区分的情况，所以是『与』。
#        省赛或邀请赛 = 省赛 + 邀请赛 + 省赛与邀请赛。"
#
# 应用侧真源在 `src/core/natureFields.js`（拿不到就别说两边一致了）；
# 这里只是**逐字镜像**，两边由 `src/test/natureFields.test.js` 的**双向**断言钉住
# （照 `LINK_KINDS` ↔ `linkKinds.js` 那套）。
#
# ⚠️ 年份 / 地区**故意不在这里穷举**：年份只有格式（`^20\d{2}$`，见 `NATURE_YEAR_PATTERN`），
#    地区是自由值（写法在源头就不统一，穷举一份必然过期）。
#    它们的"已有取值"由应用侧从数据里收集，不是爬虫侧的词表。
# ================================================================

# ================================================================
# 注册表（**唯一真源是文件**）：`acm-data/nature-registry.json`
#
# 口径：**没有「大类 / 小类」两级**，而是**一个不定层的「分类」字段** ——
# 值 = **有序字符串列表**，写进节点的形态是 `/` 连起来的字符串
# （`["xcpc","icpc","ec","pre"]` ⇔ `"xcpc/icpc/ec/pre"`）；合法性 = 注册表里的 **Trie**，
# **任何前缀都合法**（"停在哪一层"本身就是信息）：
#   · `cf`        = 知道是 CF，还没细分；
#   · `cf/contest/others/无归类` = 判过了，CF 里没有它可归的一项（= 「无」，含义不变）；
#   · `""`（空）  = 还没标 ⇒ 进应用侧 ③「性质待补」。
# 与 `年份` / `地区` **正交**。
#
# ⚠️ **本文件不再镜像词表**：JS 侧 `src/core/natureFields.js` 与这里读的是**同一份 JSON**
#    （"逐字镜像 + 跨语言同步测试"那套不需要了）。
# ================================================================

#: 注册表文件（仓库根下 `acm-data/nature-registry.json`）

NATURE_REGISTRY_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "acm-data", "nature-registry.json")

def _load_nature_registry(path: str = "") -> dict:
    with open(path or NATURE_REGISTRY_PATH, "r", encoding="utf-8") as fh:
        return json.load(fh)

NATURE_REGISTRY = _load_nature_registry()

#: 分类的分隔符（节点上存的是这个字符串形态）

CLASS_SEP = "/"

#: `无归类` —— 判过了但归不进去（不是"没标"）；**分类器判不出时写的也是 `无归类`**
#: （`xcpc_common.STAGE_NONE`；应用里显示成**灰** = 特殊的"已填"）；
#: `未归类`（**蓝** = 填写不完全 ⇒ 照旧挂 ③ 等人补）**只在省赛那一支的类型失配时**写
#: （`PROVINCIAL_TYPE_NONE`，唯一一处）—— 两个值都由 Trie 收着。
#: ⚠️ 这段以前写反了（说"脚本判不出时写 `未归类`"）：以它为准去改代码，会把整套
#:    "判不出"从灰改成蓝、`无归类` 的语义整个换掉。

CLASS_NONE = "无归类"

#: 分类的 Trie（注册表里**写死**的那棵树）

CLASS_TRIE = NATURE_REGISTRY["classTrie"]

#: 字段 key → (界面文案, kind)；kind 与 JS 侧同名枚举一致

NATURE_FIELDS = {
    key: (defn["label"], defn["kind"])
    for key, defn in NATURE_REGISTRY["fields"].items()
}

#: 年份格式（注册表里给的；JS 侧同名字符串）

NATURE_YEAR_PATTERN = NATURE_REGISTRY["fields"]["natureYear"]["pattern"]

#: 赛季格式（注册表里给的；年份=**举办年份**、赛季=**赛季年份**，
#:  EC-Final 常跨年 ⇒ 两个概念分开存；`无` 只给**没有赛季概念**的那些比赛）

NATURE_SEASON_PATTERN = NATURE_REGISTRY["fields"]["natureSeason"]["pattern"]

#: **占位取值**：值在别处还没同步 / 看过了但拿不准（"年份/赛季提供
#: 『待同步』『不确定』选项，以后有用"）。两字段都能写、都算"填过了"，但**绝不推荐**。
#: ⚠️ 与 JS 侧 `core/natureFields.js` 的 `NATURE_PENDING_VALUES` 是同一份口径
#: （值写死在这里，因为注册表只存"合法格式"这个正则，不存"哪些是占位"的语义）。

NATURE_PENDING_VALUES = ("待同步", "不确定")

#: 赛季的「不适用」（= 没有赛季概念：CF 正式轮次 / AtCoder；**`cf gym` 不算**，见 cf_board_adapter）

NATURE_SEASON_NONE = "无"

#: 年份的「不适用」（目前只有 `qoj/ucup` 用它：
#: UC 既没有赛季概念、QOJ 那边也基本没记时间）。⚠️ 它与 `待同步` 的区别：
#: `无` = 这个维度对这类比赛**不适用**；`待同步` = 值存在但还没同步过来。

NATURE_YEAR_NONE = "无"

def class_path_of(value) -> list:
    """
    拆一个分类值 → 段列表。接受 `"a/b"`（节点上的形态）、`["a","b"]`（列表形态）、空。

    **只 trim 与切分，不做别名替换**（与 JS 侧 `classPathOf` 逐条一致）。
    """
    if isinstance(value, (list, tuple)):
        return [str(x).strip() for x in value if str(x).strip()]
    s = str(value or "").strip()
    if not s:
        return []
    return [x.strip() for x in s.split(CLASS_SEP) if x.strip()]

def class_value_of(path) -> str:
    """段列表 → 节点上存的字符串形态"""
    return CLASS_SEP.join(class_path_of(path))

def class_path_problem(value) -> str:
    """
    分类值合不合法？合法 → `""`；否则一句人话（JS 侧 `classPathProblem` 同一口径）。

    口径：**每一段都必须落在 Trie 的对应层上** —— 只要逐段都在，停在第一段、第二段…都合法。
    空值 = 没标 ⇒ 合法（可空字段）。
    """
    segs = class_path_of(value)
    if not segs:
        return ""
    node = CLASS_TRIE
    walked: list = []
    for seg in segs:
        if not isinstance(node, dict) or seg not in node:
            kids = list(node) if isinstance(node, dict) else []
            return ("分类「" + (CLASS_SEP.join(walked) or "（根）") + "」下没有「" + seg + "」"
                    + ("（可选：" + "、".join(kids) + "）" if kids else "（它已经没有下一层了）"))
        walked.append(seg)
        node = node[seg]
    return ""

def class_paths() -> list:
    """所有合法路径（展平 Trie；顺序 = Trie 的书写顺序）"""
    out: list = []

    def walk(node, prefix):
        for seg, kids in node.items():
            path = prefix + [seg]
            out.append(CLASS_SEP.join(path))
            walk(kids, path)

    walk(CLASS_TRIE, [])
    return out

def class_root_of(value) -> str:
    """分类的第一段（= 界面上的"一族"）；空值 → `""`"""
    segs = class_path_of(value)
    return segs[0] if segs else ""

def class_matches(value, prefix) -> bool:
    """前缀匹配（筛选用）：`value` 等于 `prefix` 或落在它下面"""
    v = class_path_of(value)
    p = class_path_of(prefix)
    if not p:
        return True
    return len(v) >= len(p) and all(a == b for a, b in zip(v, p))

def is_known_class_path(value) -> bool:
    """这个值在 Trie 里吗（空值 → `False`）"""
    return bool(class_path_of(value)) and class_path_problem(value) == ""

def nature_fields(*pairs, **kw) -> dict:
    """
    把 `(字段, 值)` 收成**节点上的普通字段**（不是元列），返回值直接 `**` 展开：

        crate.contest(parent, key,
                      **nature_fields(("natureClass", "xcpc/icpc"),
                                      ("natureYear", "2025"),
                                      ("natureRegion", "成都")))

    口径（与 `link_kinds()` 一致的三条）：
      * 允许**部分填写**（三个都可空）—— 空值直接丢掉，不占位；
      * **分类要过 Trie**（`class_path_problem`）；年份只查格式；地区**不校验**（自由值）；
      * 不认识的 key 直接 `raise`（写错字段名要当场发现，别静默丢进包里）。

    位置参数与关键字参数**走同一套校验**（关键字形式只是顺手）。
    """
    merged: list = list(pairs) + list(kw.items())
    out: dict = {}
    for field, value in merged:
        if field not in NATURE_FIELDS:
            raise ValueError("未知的性质字段 %r（只能是 %s）" % (field, tuple(NATURE_FIELDS)))
        if field == "natureClass":
            v = class_value_of(value)
            if not v:
                continue
            problem = class_path_problem(v)
            if problem:
                raise ValueError("分类不合法：%s（注册表：acm-data/nature-registry.json）" % problem)
            out[field] = v
            continue
        v = str(value or "").strip()
        if not v:
            continue
        if field == "natureYear" and not re.fullmatch(NATURE_YEAR_PATTERN, v):
            raise ValueError("年份要写成 20xx（四位）、`无`（这一维不适用）或 `待同步` / `不确定`，收到 %r" % v)
        if field == "natureSeason" and not re.fullmatch(NATURE_SEASON_PATTERN, v):
            raise ValueError("赛季要写成 20xx（四位）、`无`（没有赛季概念的那些比赛）或 "
                             "`待同步` / `不确定`，收到 %r" % v)
        out[field] = v
    return out


# ================================================================
# 分类依据（元列 `分类依据`）
#
# 起因："节点自动分类/填值规则高度依赖社区命名规范…如果要做得精，
# 应该引入『可信度级别』概念" —— 级别本身在应用侧（`src/core/natureConfidence.js`
# 的 `CLASS_RULE_LEVEL`：规则 id → A/B/C/D/E）；**这里只负责把"哪条规则判出这个值"记下来**。
#
# 为什么记规则 id 而不是直接记级别：级别是"读法"（同一条规则将来改了分级，
# 全库重算一次就有新级别）；规则 id 是**事实**（这条分类当时凭什么得出的）。
# 记 id 顺便还能排查"90 条 CE 被塞进省赛"这种事——直接 `grep` 规则名就知道谁干的。
#
# 形状**只有一种**：`{ 性质字段名: 规则id }`（现在只有 `natureClass` 有规则）
#   `{'分类依据': {'natureClass': 'xcpc:name-stage'}}`
# ⚠️ 键用**内部字段名**（`natureClass`，不是界面列名「分类」）——应用读的是它
#    （`classLevelOf(node)` 读 `node['分类依据'].natureClass`），两处不许各写一份口径。
# ⚠️ **单值**（不是列表）：一条分类路径是**一串判据接起来**的（赛系 → 赛区 → 阶段 → 正式/热身），
#    这里记的是**最弱的那一环** —— 值的可信度由最弱证据决定，记最强的那个等于自欺。
# ================================================================

#: 元列名（与 `字段来源` / `账户线索` / `链接分类` 同级）

CLASS_RULE_COL = "分类依据"
#: 规则 id 的写法：`<范围>:<规则>` ——
#: **范围**全小写 + 连字符（`cf-contest` / `qoj` / `gym` / `xcpc` / `ccpc` / `nk` / `hdu` / `atcoder`），
#: **规则**是大小写敏感的标志符（允许驼峰：`filterTypes` 就是 CF 那边的字段名，
#: 照抄它才查得回源头）。例：`qoj:path-icpc`、`gym:infer-region`、`cf-contest:filterTypes`。

CLASS_RULE_PATTERN = r"^[a-z][a-z0-9-]*:[A-Za-z][A-Za-z0-9-]*$"

def class_rule_problem(value) -> str:
    """
    一个规则 id 合不合法（合法返回空串，否则返回人话原因）—— **唯一实现**。

    ⚠️ 格式错了要**当场炸**（与 `nature_fields` 对字段名的口径一致）：规则 id 拼错一个字母
    在应用侧只会静默降级成 E 级（"无依据"），没人会去查 —— 那正是这一列要解决的问题本身。
    """
    v = str(value or "").strip()
    if not v:
        return "规则 id 不能为空"
    if not re.fullmatch(CLASS_RULE_PATTERN, v):
        return f"规则 id 要写成 `<范围>:<规则>`（范围全小写、规则可驼峰），收到 {v!r}"
    return ""

def class_rules(*pairs) -> dict:
    """
    把 `(性质字段, 规则id)` 收成元列 `分类依据`，**返回值直接拿去 `**` 展开**：

        crate.contest(parent, key,
                      **nature_fields(("natureClass", cls)),
                      **class_rules(("natureClass", "xcpc:name-stage")))

    · 空值丢掉（没有规则可记就不写这一列，不占位）；
    · 字段名只认 `NATURE_FIELDS`；规则 id 只认上面的形状 —— 都不静默放过（见 `class_rule_problem`）。
    """
    out: dict = {}
    for field, rule in pairs:
        if field not in NATURE_FIELDS:
            raise ValueError("未知的性质字段 %r（只能是 %s）" % (field, tuple(NATURE_FIELDS)))
        r = str(rule or "").strip()
        if not r:
            continue
        problem = class_rule_problem(r)
        if problem:
            raise ValueError("分类依据不合法：%s" % problem)
        out[field] = r
    return {CLASS_RULE_COL: out} if out else {}


# 判据顺序**有意义**：先判"更具体"的，再兜底到 unknown。

_LINK_RULES = (
    # 榜单：能看到排名的页面
    ("board", re.compile(
        r"/rankings?/|/rankings?$|board\.xcpcio\.com|/standings|/scoreboard|"
        r"scoreboard\.|/ranklist|/board\b|/rank\b", re.I)),
    # 补题入口：题面/题目集/重现赛（QOJ 场次页、CF gym、vjudge、UCup、PDF 题面…）
    ("problems", re.compile(
        r"/problem-sets/|/problemset|codeforces\.com/(gym|contest)/\d+$|"
        r"codeforces\.com/(gym|contest)/\d+/problem/|qoj\.ac/contest/\d+$|"
        r"contest\.ucup\.ac/contest/\d+|vjudge\.net/contest/\d+|"
        r"jisuanke\.com|/problems?$|\.pdf$", re.I)),
    # 仓库/数据文件（**不能丢** —— `rankland_refs_adapter` 直接丢弃会让这 89 条形同消失）
    ("repo", re.compile(
        r"github\.com|gitlab\.com|gitee\.com|srk-collection|raw\.githubusercontent\.com",
        re.I)),
)

def classify_link(url: str) -> str:
    """
    一条链接 URL → 类别（`LINK_KINDS` 之一，认不出就是 `"unknown"`）。

    **助手**，不是权威：它只看得见 URL。有上下文的适配器（知道这条 ref 的标题、
    或者自己就是某个榜单的抓取者）应当**直接声明类别**。
    """
    u = str(url or "").strip()
    if not u:
        return "unknown"
    for kind, pat in _LINK_RULES:
        if pat.search(u):
            return kind
    return "unknown"

def link_kind_label(kind: str) -> str:
    """类别 → 中文名（未知类别原样返回，便于排查）"""
    return LINK_KIND_LABELS.get(str(kind or ""), str(kind or ""))

def link_kinds(*pairs) -> dict:
    """
    把 `(类别, URL)` 收成 C 的元列 `链接分类`，**返回值直接拿去 `**` 展开**：

        crate.contest(parent, key, **link_kinds(('board', board_url),
                                                ('problems', qoj_url)))

    ⚠️ **不取舍**：同一个类别给几条就留几条（"数据爬取部分不应该有
    『存在多值时排除一些值』的逻辑"）。空 URL 丢掉，不占位。
    ⚠️ **类别由调用方声明**，不要在这里用 `classify_link()` 猜 —— 适配器手上有上下文
    （如 ref 的标题），判得比 URL 准（牛客比赛页既是榜单又是题面的那个例子）。
    """
    out: dict[str, list] = {}
    for kind, url in pairs:
        u = str(url or "").strip()
        if not u:
            continue
        if kind not in LINK_KINDS:
            raise ValueError(f"未知的链接类别 {kind!r}（只能是 {LINK_KINDS}）")
        out.setdefault(kind, []).append(u)
    return {"链接分类": out} if out else {}


# ================================================================
# 小工具
# ================================================================

def now_iso() -> str:
    """当前时间的 ISO 字符串（写入 generatedAt，不参与内容哈希）"""
    return datetime.now().astimezone().isoformat(timespec="seconds")

_TIME_RE = re.compile(
    r"^(\d{4})[.\-/](\d{2})[.\-/](\d{2})[ T](\d{2}):(\d{2})"
    r"(?::(\d{2}))?\s*(?:Z|[+-]\d{2}:?\d{2})?$")

#: **只有时间没有日期**（`00:31:01` / `2:05`）—— 比赛内的相对时间，**不是时刻**。
#   ⚠️ 与 `04 qoj/QOJ_submissions_scraper.py` 的 `_REL_TIME` 同一件事（那份是"这列值属于哪一类"的
#   归档判据，这份是"**能不能当 `time` 用**"的判据）；两边都必须是这个形状。
_ONLY_TIME_RE = re.compile(r"^\s*\d{1,3}:\d{2}(?::\d{2})?\s*$")

def is_relative_time(value) -> bool:
    """
    这个值是不是**比赛内的相对时间**（`00:31:01` / `2:05`）—— 也就是"看起来像时间，但不是时刻"。

    为什么要单独一个口：`normalize_time` 只回答"能不能当 `time` 用"（返回 `''` 是**结论**，
    而"原来是空的"也返回 `''`）⇒ 生成端分不出"源没给"与"源给了个相对时间"。
    QOJ 适配器要靠这个区分来决定"这条 R 的时间**拿不到**"（`allow_missing_time`，见 `validate_crate`），
    而不是把任何认不出的脏值都放行。

    ⚠️ 与 `04 qoj/QOJ_submissions_scraper.py` 的 `_REL_TIME` 是**同一件事的两面**：
    那边（更严，要求带秒）判"这一列的值属于哪一类"，用来**归档**；这边判"能不能当时刻"。
    两处都必须认这个形状 —— 改一处要顺手看另一处。
    """
    if value is None:
        return False
    return bool(_ONLY_TIME_RE.match(str(value).strip()))


def normalize_time(value) -> str:
    """
    把各种时间写法标准化成应用内部格式 `YYYY.MM.DD HH:MM[:SS]`。

    为什么必须做：应用里 `acTime` / `lastSubmitTime` 的推导是**字符串比较**
    （`child.time > latest`），格式不统一就会比错。

    ⚠️ **给了秒就保留秒**（14 位）—— 同一分钟内的多条提交靠它才排得对。
    但**不替没有秒的源数据补 `:00`**（那是凭空造精度）。

    ⚠️ **本函数只统一"写法"，不换算时区**（适配器早已把时间换成北京时间了）。
    需要"从任意来源（epoch / ISO / 中文）得到 CST 时间"请用 `to_cst`。

    ★ **只有时间、没有日期的值一律不当时刻用 ⇒ 返回空串**（`v9.4.15`；用户 2026-10-15 报的：
    QOJ 场次页的「提交时间」列给的是**比赛内相对时间** `00:31:01`，它一路穿到树上，
    P 的「AC时间」就显示成 `00:31:01`）。判据：`_ONLY_TIME_RE`。
    ⚠️ 这里**破例不"原样返回"**（下面那条退路是为"可疑但可能是真值"的写法留的）：
    只有时间的串**不可能**是时刻，留着它有两个确定的坏处 ——
      ① `acTime` 是字符串比较 ⇒ `00:31:01` 会跟别的提交比大小，挑出一个凭空的时间；
      ② 它**有值** ⇒ 体检那边"R.time 缺"这一格不报，缺口连需求都不算（原始症状能藏几个月）。
    原始值不会丢：QOJ 那边把相对时间归档在**另一列**（`相对提交时间`），要查得到。

    无法识别时返回原字符串（宁可见到可疑值，也不要静默丢弃）。
    """
    if value is None:
        return ""
    text = str(value).strip()
    if not text:
        return ""
    m = _TIME_RE.match(text)
    if m:
        y, mo, d, h, mi, sec = m.groups()      # sec 为 None = 这个写法没有秒
        if not sec or sec == "00":
            # ⚠️ 秒为 `00` 也**不写** —— 与 `to_cst` 同一口径，否则
            #    `13:00:00` 会给每个整点时间拖一条没意义的 `:00`，
            #    而且同一个时刻走 ISO 路径与中文路径会得到不同的串。
            return f"{y}.{mo}.{d} {h}:{mi}"
        return f"{y}.{mo}.{d} {h}:{mi}:{sec}"
    if _ONLY_TIME_RE.match(text):
        return ""
    # 退路：纯数字 12/14 位
    digits = re.sub(r"\D", "", text)
    if len(digits) == 14:
        base = (f"{digits[0:4]}.{digits[4:6]}.{digits[6:8]} "
                f"{digits[8:10]}:{digits[10:12]}")
        # 同 `to_cst` 的口径：秒为 `00` 不写
        return base if digits[12:14] == "00" else f"{base}:{digits[12:14]}"
    if len(digits) == 12:
        return (f"{digits[0:4]}.{digits[4:6]}.{digits[6:8]} "
                f"{digits[8:10]}:{digits[10:12]}")
    return text


# 北京时间（UTC+8）。全项目的"应用可见时间"都按它展示（与 `normalize_time` 同口径）。

CST = timezone(timedelta(hours=8))


# ================================================================
# 小工具（这几个若在每个平台适配器里各写一份，必然逐字重复）
#
# 为什么放 crate.py：它是**跨平台、零依赖**的那一份（各平台适配器都已经 import 它），
# 而且这些函数都不属于任何单个平台。合并的理由很实际 —— 同一段逻辑写 5 遍时，
# 改其中 1 遍（或只在一处发现 bug）另外 4 处就悄悄分叉了。
# ================================================================

def s_of(v) -> str:
    """**列值 → 字符串**：`None` → `''`，其它 `str()` 后 strip。

    ⚠️ 各适配器自带 `_s()`，五个文件逐字相同；合并到这里。
    保留一个模块内的 `_s = s_of` 别名是**故意**的 —— 让调用点一行不用改，
    但新代码请直接 import `crate.s_of`。
    """
    return '' if v is None else str(v).strip()


# 兼容别名（适配器里到处是 `_s(...)`，改名不值得；但请优先用 `s_of`）
_s = s_of

def season_of(year: str) -> str:
    """
    年份 → **赛季串**（`2026` → `2026`）；认不出就原样返回。

    用处：HDU / 牛客的账户线索是 `hdu:2026` / `nk:2026` 这种带赛季的命名空间
    （那两家的"名字"可能重复或换人，所以要分届）。CF/QOJ **不用**它
    （那两个平台的账号不会每年一换，加赛季是画蛇添足）。

    ⚠️ **必须写四位年** —— 把 `2026` 截成 `26` 就对不上：
    应用里的映射一律是 `nk:2023` / `hdu:2026` 这种**四位**，
    两边按三元组**全等**匹配 ⇒ 对不上（实测：10120 个值全成"未认领的线索"）。
    四位更好认、也少一个错点 ⇒ **数据迁就人**：不再截断。
    """
    return s_of(year)


# 重复下载后缀：`x (1)` / `x（2）` / `x 副本` / `x copy` —— 取**真身**那条（比只认半角括号更全）

_DUP_SUFFIX_RE = re.compile(r'[\s_\-]*(?:[（(]\s*\d+\s*[)）]|副本|copy)$', re.I)

def normalize_stem(stem: str) -> str:
    """
    反复剥掉**重复下载后缀**（可能叠好几个，如 `x (1) (2)`）。

    浏览器下载同名文件时会加 ` (1)`，采集脚本据此判断"哪个名字是干净的"。
    收口到这一处：`nk/lib/nk_common.py` 与 `hdu/lib/hdu_common.py`
    各写一份必然逐字重复。
    """
    prev = None
    while prev != stem:
        prev = stem
        stem = _DUP_SUFFIX_RE.sub('', stem).strip()
    return stem

def contest_day(value) -> str:
    """
    从时间串里取"**日子**" `YYYY-MM-DD`（认 `2026.08.26 22:28:24` / `2026-08-26T12:00:00+08:00`）。

    用处：判"这条提交是不是赛时"时要比较"提交日 vs 比赛日"（HDU/牛客）。
    取不到返回 `''`。收口到这一处：`hdu_adapter.py` 与 `nk_adapter.py`
    各写一份必然逐字重复。
    """
    m = re.match(r'(\d{4})[.\-/](\d{2})[.\-/](\d{2})', s_of(value))
    return f'{m.group(1)}-{m.group(2)}-{m.group(3)}' if m else ''

def run_fields(record: dict) -> dict:
    """
    **提交的运行信息 → 包字段**（拿不到的一律 `None`，**不写空串占位**）。

    这是"**口径**"的唯一实现：`timeUsed` = **毫秒**、`memoryUsed` = **字节**、
    `codeLength` = **字节**。源里的 `使用内存(KB)` 要 ×1024，`代码长度` 可能是 `2.0kb`。
    应用侧字段表（`src/core/model/elements.js`）就是这么定的，两边必须一致。

    ⚠️ 为什么收口：HDU 与牛客的适配器各写过一份同构的实现（逐字相同的三个转换），
    而**口径不同 = 界面上的耗时/内存没法横向比**，出 bug 还很难看出来（数字看着都正常）。
    HDU 没有 `代码长度` 列 → 传空就得到 `None`。
    """
    out: dict = {'language': s_of(record.get('使用语言')) or None}
    for key, raw, scale in (
            ('timeUsed', s_of(record.get('运行时间(ms)')), 1),
            ('memoryUsed', s_of(record.get('使用内存(KB)')), 1024),
            ('codeLength', s_of(record.get('代码长度')), 1)):
        try:
            out[key] = str(int(float(raw) * scale)) if raw else None
        except ValueError:
            out[key] = None
    return out

def to_cst(value) -> str:
    """
    **任意来源的提交时间 → 北京时间字符串**（应用内部格式 `YYYY.MM.DD HH:MM[:SS]`）。

    这是**唯一**一份"时间 → CST 字符串"的实现（合并口径见下），各平台适配器不要
    再各写一个 `local_time`：

      * **epoch 秒**（CF 的 `creationTimeSeconds`、xcpio/榜单的 `startAt` 秒）→ 带秒；
      * **ISO 字符串**（PTA 的 `2026-09-06T05:10:06Z`、rankland 的 `+08:00`）→ 带秒；
      * 认不出来 → 交给 `normalize_time` 兜底（它认中文/数字写法，保留它有的精度）。

    ⚠️ **为什么要合并**：6 个适配器各写一份 `local_time`，全都
    `strftime('%Y.%m.%d %H:%M')` —— **把秒丢了**。而源数据其实是有秒的
    （实测：CF 的 epoch `%60` 分布散开、PTA 的 `submitAt` 带 `:06Z`），
    于是 CF/PTA 的 1578 条是 12 位、QOJ/HDU/牛客是 14 位，**两套口径并存**。
    同一分钟内的多条提交排不出先后 → `acTime` 会取错 ⇒ 口径定为"普遍用 14 位"。
    合并成一份同时消掉了这个精度丢失。

    口径：**有秒就带秒，但秒是 `00` 就不写**（`13:00:00` → `13:00`，
    否则每个整点时间都长出一条没意义的 `:00`；也不给没有秒的源数据补 `:00`）。
    """
    if value is None:
        return ""

    def _fmt(dt, sec):
        """秒为 None 或 '00' → 不写秒（整点时间不该拖个 :00）"""
        base = dt.strftime("%Y.%m.%d %H:%M")
        return base if (not sec or str(sec) == "00") else f"{base}:{sec}"

    # ① epoch 秒（数字或"看起来是数字"的字符串）
    text = str(value).strip()
    if isinstance(value, (int, float)) or re.fullmatch(r"\d{9,11}(?:\.\d+)?", text):
        try:
            ts = float(value)
        except (TypeError, ValueError):
            return normalize_time(value)
        if ts > 0:
            dt = datetime.fromtimestamp(ts, tz=timezone.utc).astimezone(CST)
            return _fmt(dt, dt.strftime("%S"))
        return ""
    # ② ISO（`2026-09-06T05:10:06Z` / `2026-04-11T11:00:00+08:00` / 裸串）
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?", text)
    if m:
        y, mo, d, h, mi, sec = m.groups()
        try:
            naive = datetime(int(y), int(mo), int(d), int(h), int(mi),
                             int(sec) if sec else 0)
        except ValueError:
            return text
        z = re.search(r"(Z|[+-]\d{2}:?\d{2})$", text)
        if not z:
            # ⚠️ **裸串按时区未知处理，原样采用**（当 UTC 会凭空 +8 小时）。
            #    例：rankland 的 `2026-04-11T11:00:00` 本来就是北京时间。
            return _fmt(naive, sec)
        if z.group(1) == "Z":
            dt = naive.replace(tzinfo=timezone.utc)
        else:
            sign = 1 if z.group(1)[0] == "+" else -1
            dt = naive.replace(tzinfo=timezone(
                sign * timedelta(hours=int(z.group(1)[1:3]), minutes=int(z.group(1)[-2:]))))
        return _fmt(dt.astimezone(CST), sec)
    # ③ 其它写法（中文/纯数字）交给 normalize_time，保留它认得出的精度
    return normalize_time(value)

#: 「一行多判定」检测用的小词表：判定词 → 我们的事典（**不是**完整别名表，别拿它当映射用）
_VERDICT_WORDS = {
    'AC': 'AC', 'OK': 'AC', 'ACCEPTED': 'AC',
    'WA': 'WA', 'TLE': 'TLE', 'TL': 'TLE', 'MLE': 'MLE', 'ML': 'MLE',
    'RE': 'RE', 'OLE': 'OLE', 'CE': 'CE', 'ILE': 'ILE', 'PE': 'PE',
    'PC': 'P.AC', 'PAC': 'P.AC', 'UKE': 'UKE', 'FAIL': 'FAIL',
}


def _abbrev_status(text: str) -> str:
    """
    **认不出的非空结果 → 一个英文缩写**（其他文本随意但一定要有，最好英文缩写）。

    规则（够用就好，别过度设计）：
      · 多词 → 各词首字母（`Compilation Error` → `CE`、`Wrong Answer` → `WA`）；
      · 单词 → 前 4 个字母（`CHALLENGED` → `CHAL`）；纯数字/符号按同样办法取；
      · **没有任何 ASCII 字母数字**（中文等）⇒ 原样留**前 6 个字符**（缩不出来就别硬缩，
        至少让人看见原文）—— 应用侧对不在 `STATUS_OPTIONS` 里的值用**淡灰**渲染，看得见。
      · 真为空 ⇒ `-`（这条在 `normalize_status` 里先判，不经过这里）。
    """
    words = re.findall(r'[A-Za-z0-9]+', text)
    if not words:
        return text[:6]
    if len(words) > 1:
        return ''.join(w[0] for w in words)[:4].upper()
    return words[0][:4].upper()


def normalize_status(value) -> str:
    """
    把判题结果标准化成 `STATUS_OPTIONS` 之一；**非空但认不出的给英文缩写**（见下），
    只有**真的空**才返回 `'-'`。

    ⚠️ **唯一一份**：`nk` / `hdu` / `qoj` / `pta` 四个适配器都走它（各自只做自己那半边的别名）。

    ⚠️ **牛客的中文 `运行结果` 必须认**（"nk 段错误 评测状态不被识别"）：牛客的 `运行结果` 是**中文**，
    而这里只认「通过/满分/答案错误/超时」四个 —— 实测 1832 条牛客提交里 **508 条落 `-`**（28%），
    其中 **468 条本该认得**：运行超时 302 → TLE、**段错误 91 → RE**、内存超限 32 → MLE、
    执行出错 22 / 运行错误 16 / 浮点错误 4 → RE、输出超限 1 → OLE。

    ⚠️ **"彻底一点"的口径**：① `CE`（编译错误）进 `STATUS_OPTIONS`；
    ② **`ILE`**（CF 的交互题空转 `IDLENESS_LIMIT_EXCEEDED`）进 `STATUS_OPTIONS`，
    颜色与 TLE 一致；③ 其余认得出的都给码（`CHALLENGED → HACK`、`PARTIAL → PC`、
    `Compiling/PENDING → PD`、`JUDGING → JG`…）；④ **认不出的非空值走 `_abbrev_status`**，
    **永不返回 `-`** —— 于是"没有判定"（空）与"认不出的判定"（有码）**分得开**。
    """
    if value is None:
        return "-"
    text = str(value).strip()
    if not text:
        return "-"
    upper = text.upper()
    if upper in STATUS_OPTIONS:
        return upper

    # ---- 英文别名（大小写/下划线两种写法都收）----
    if upper in ("OK", "ACCEPTED"):
        return "AC"
    if upper in ("WRONG ANSWER", "WRONG_ANSWER"):
        return "WA"
    if "RUNTIME" in upper:
        return "RE"
    if "MEMORY" in upper:
        return "MLE"
    if "OUTPUT" in upper and "LIMIT" in upper:
        return "OLE"
    if "IDLENESS" in upper:                 # CF 交互题「空转」：等着输入却没读 ⇒ 不是超时也不是 RE
        return "ILE"
    if "TIME" in upper and "LIMIT" in upper:
        return "TLE"
    if "COMPILATION" in upper:
        return "CE"
    if upper == "CHALLENGED":               # CF：这条提交被 hack 了
        return "HACK"
    if upper in ("PC", "PAC"):              # 部分分（QOJ/PTA 的 `PC` / `PAC` 写法也收，统一成 `P.AC`）
        return "P.AC"
    if upper.startswith("PARTIAL"):         # 部分分（PTA 的 `PARTIAL_ACCEPTED`）
        return "P.AC"
    # QOJ 那种**一行多判定**（`AC , WA`）= 按测试点部分给分 ⇒ **`P.AC`**
    # （字面量就是 `P.AC`）。判据：把词拆开逐个查一遍，**≥2 个不同的判定词**。
    tokens = [w for w in re.split(r'[^A-Za-z]+', upper) if w]
    hits = {_VERDICT_WORDS[w] for w in tokens if w in _VERDICT_WORDS}
    if len(hits) >= 2:
        return "P.AC"
    if upper in ("COMPILING", "PENDING", "WAITING"):    # 还没判完（等下一轮抓就变真结果）
        return "PD"
    if upper in ("JUDGING", "RUNNING"):     # 评测中
        return "JG"

    # ---- 中文别名 ----
    # 编译错误**先判**（虽然它不含下面的词，但把口径写在明处，别让后来者以为是漏了）
    if text in ("编译错误", "编译失败"):
        return "CE"
    # 这几个用**全等**：短词做包含判断容易被别的句子吃掉（如「未通过」≠ 通过）
    if text in ("通过", "满分", "答案正确", "答案正确（AC）"):
        return "AC"
    if text in ("答案错误", "错误答案"):
        return "WA"
    if text in ("段错误", "运行错误", "执行出错", "浮点错误", "非法访问", "非法内存访问"):
        return "RE"
    if text in ("内存超限", "内存溢出"):
        return "MLE"
    if text in ("输出超限", "输出过多"):
        return "OLE"
    if text in ("交互超时", "空转超时", "空转"):
        return "ILE"
    if text in ("等待评测", "排队中", "编译中", "正在评测"):
        return "PD"
    # 只有"超时"这一族用**包含**：同一家的措辞会飘（「超时」/「运行超时」/「时间超时」…）
    if "超时" in text or "超出时间限制" in text:
        return "TLE"

    # ---- 认不出的**非空**值：给个英文缩写，别丢成 `-`（非空值一定要有码）----
    return _abbrev_status(text)


# ================================================================
# Crate 构造器
# ================================================================

class Crate:
    """
    增量构造一个 crate。

    **字段名风格（重要）**：本构造器写入的列名**就是内部字段名**
    （`name` / `problemId` / `link` / `status` / `time` …），应用会直接采纳，
    **不需要 fieldMap 参与**。

    `fieldMap` 只用于两种情形：

    - 你的爬虫输出的是**自己的列名**（中文/别的命名）→ 用 `map_column` 映射；
    - 想让应用把某些列记进"未使用字段"报告 → `map_column(col, None)`。

    所以 `map_column` 是可选的。若你只用本构造器的 `problem()` / `submission()`
    等方法，**可以完全不调用 map_column**。

    设计取向：**key 由调用方显式给出**，不做任何猜测。
    因为 extKey 一旦定型就不能改（改了等于换身份，会破坏幂等），
    所以把它放在签名里最显眼的位置，逼迫调用方想清楚。
    """

    def __init__(self, source_id: str, label: str = "", platform: str = "", kind: str = "script"):
        """
        @param kind 来源于**应用信任模型**的类别：`board`（权威榜单）/ `script`（爬虫脚本）。
            这个值决定投影里的类别序（`manual > board > script > derived`）——
            同一场既有榜单来源又有脚本来源时，**类别错了就会压错值**。
            默认 `script`（应用侧的导入来源没有显式类别时一律记成 script/rank 20）。
        """
        if not source_id:
            raise ValueError("source_id 不能为空（用于导入记录与排查）")
        if kind not in ("board", "script", "derived", "manual"):
            raise ValueError(f"未知的来源类别 kind={kind!r}（board/script/derived/manual）")
        self.crate_version = CURRENT_CRATE_VERSION
        self.source = {"id": source_id, "kind": kind}
        if label:
            self.source["label"] = label
        if platform:
            self.source["platform"] = platform
        self.generated_at = now_iso()
        # 显式声明"本构造器写入的列用的是内部字段名"。
        # 为什么需要：应用把「既不是内部字段名、也不在 fieldMap 里」的列
        # 记进"未使用字段"报告。构造器写的就是内部名，所以声明成恒等映射，
        # 报告里才不会把 name/link 这些误列成"未使用"。
        self.field_map: dict[str, str | None] = {f: f for f in sorted(WRITABLE_FIELDS)}
        self.field_policies: dict[str, str] = {}
        # 「本包还会用到哪些**别的**来源 id」（可选）。为什么要它：
        #   `字段来源` 记的是"这一格是谁给的"，而**共享根容器的显示名**是构建期常量给的
        #   （见 `xcpc_common.ROOT_SRC`）—— 那个 id 不在本包的 `source.id` 上，
        #   包合并后 `source.sources` 里查不到 kind ⇒ `crate-invariants` 冒烟直接红
        #   （实测就是它把这一条逮出来的）。所以允许显式登记（`declare_source`），
        #   `to_dict` 会把它并进 `source.sources`（合并时逐层带下去）。
        self.extra_sources: dict[str, dict] = {}
        self.records: list[dict] = []
        self._emitted: set[str] = set()
        # 包内合成标识（`synthKey`）已用集合 —— 与 extKey 一样**包内唯一**（3.2 同口径）
        self._emitted_synth: set[str] = set()

    # ---------- 元信息 ----------

    def map_column(self, column: str, internal: str | None) -> "Crate":
        """
        声明一个**爬虫列名**到内部字段的映射。

        - 映射到内部字段名（见 WRITABLE_FIELDS）→ 参与导入
        - 映射到 `None` → **显式忽略**（身份输入列，不是节点字段）

        **没出现在 fieldMap 里的列 = 未使用字段**：应用只会把列名记进
        "导入记录"（不存值），方便你将想加字段时有据可查。

        注意：构造器的 `problem()` / `submission()` 等方法写入的列**已经是
        内部字段名**，构造时已自动登记恒等映射，所以**不需要**为它们调用本方法。
        本方法只在你额外塞入爬虫自有列名时才用。
        """
        if internal is not None and internal not in WRITABLE_FIELDS:
            raise ValueError(
                f"列 {column!r} 映射到 {internal!r}，但它不是可写字段。\n"
                f"  可写字段：{', '.join(sorted(WRITABLE_FIELDS))}\n"
                f"  派生字段（永远不可写）：{', '.join(sorted(DERIVED_FIELDS))}"
            )
        self.field_map[column] = internal
        return self

    def policy(self, field: str, policy: str) -> "Crate":
        """
        覆盖某内部字段的合并策略。

        合法值：never / fill-if-empty / overwrite-if-changed / force
        注意：**派生字段与 remark 无论怎么设都无效**（应用侧硬约束）。
        """
        allowed = ("never", "fill-if-empty", "overwrite-if-changed", "force")
        if policy not in allowed:
            raise ValueError(f"策略 {policy!r} 非法，应为 {allowed}")
        self.field_policies[field] = policy
        return self

    # ---------- 记录 ----------

    def _add(self, record: dict, required_fields: tuple[str, ...] = ()) -> dict:
        """
        全部记录的**唯一入口**（校验、归一、记账都在这一处）。

        合成：一条记录的身份键有两种，**恰好用其中一个**：
          · `extKey`    → 普通节点（树上按 extKey 认人）
          · `synthKey`  → **合成节点**（树上按合成标识认人，它**没有** extKey）
        两个都为空 ⇒ 没有身份键，拒绝；两个都非空 ⇒ 自相矛盾，拒绝
        （应用侧 `plan.js` 对后者的口径是整条不导入）。
        """
        raw_ext = record.get("extKey")
        raw_synth = record.get("synthKey")
        ext_key = "" if raw_ext is None else str(raw_ext).strip()
        synth_key = "" if raw_synth is None else str(raw_synth).strip()

        if not ext_key and not synth_key:
            raise ValueError(
                f"记录的 extKey 与 synthKey 不能同时为空（没有身份键）：{record!r}\n"
                f"  普通节点写 extKey；合成节点写 synthKey（它没有 extKey）"
            )
        if ext_key and synth_key:
            raise ValueError(
                f"记录同时带 extKey {ext_key!r} 与 synthKey {synth_key!r}：\n"
                f"  合成节点的身份是 synthKey、**没有** extKey，一条记录不能两者都有"
                f"（应用会拒绝该条）：{record!r}"
            )

        if ext_key:
            record["extKey"] = ext_key
            record.pop("synthKey", None)
            if ext_key in self._emitted:
                raise ValueError(f"extKey 重复（包内必须唯一）：{ext_key!r}")
            if len(ext_key) > MAX_EXT_KEY_LENGTH:
                raise ValueError(f"extKey 过长（>{MAX_EXT_KEY_LENGTH}）：{ext_key!r}")
        else:
            record.pop("extKey", None)
            record["synthKey"] = synth_key
            if synth_key in self._emitted_synth:
                raise ValueError(f"synthKey 重复（包内必须唯一）：{synth_key!r}")
            if len(synth_key) > MAX_SYNTH_KEY_LENGTH:
                raise ValueError(
                    f"synthKey 过长（>{MAX_SYNTH_KEY_LENGTH}）：{synth_key!r}")

        if record["节点类型"] not in NODE_TYPES:
            raise ValueError(f"未知节点类型：{record['节点类型']!r}")
        if synth_key and record["节点类型"] not in SYNTH_TYPES:
            raise ValueError(
                f"不能合成 {record['节点类型']} 节点（synthKey={synth_key!r}）："
                f"合成只在 {' / '.join(SYNTH_TYPES)} 上做（W/S/O 不参与合成）"
            )

        self._dedupe_parent_ref(record)

        for f in required_fields:
            if not record.get(f):
                raise ValueError(f"{record['节点类型']} 记录缺少必填列 {f!r}：{record!r}")
        self._normalize_link_kinds(record)
        self._normalize_class_rules(record)
        if ext_key:
            self._emitted.add(ext_key)
        else:
            self._emitted_synth.add(synth_key)
        self.records.append(record)
        return record

    @staticmethod
    def _dedupe_parent_ref(record: dict) -> None:
        """
        父引用归一：`父extKey`（父是普通节点）与 `父synthKey`（父是合成节点）
        **至多给一个**（都不给 = 挂在真实根节点下，3.3 —— 只有 W 会这样用）。

        两个都给 ⇒ 拒绝：父到底是谁说不清，应用侧没有这种形状。
        """
        parent_ext = "" if record.get("父extKey") is None else str(record["父extKey"]).strip()
        parent_synth = ("" if record.get("父synthKey") is None
                        else str(record["父synthKey"]).strip())
        if parent_ext and parent_synth:
            raise ValueError(
                f"记录同时给了 父extKey={parent_ext!r} 与 父synthKey={parent_synth!r}：\n"
                f"  父引用只能给一个（父是普通节点用 父extKey，父是合成节点用 父synthKey）："
                f"{record!r}"
            )
        if parent_ext:
            record["父extKey"] = parent_ext
            record.pop("父synthKey", None)
        elif parent_synth:
            record["父synthKey"] = parent_synth
            record.pop("父extKey", None)
        else:
            record.pop("父extKey", None)
            record.pop("父synthKey", None)

    def _normalize_link_kinds(self, record: dict) -> None:
        """
        把元列 `链接分类` **归一成唯一形状**：`{ 类别: [{v, src}, …] }`。

        为什么必须在这一处归一（"数据处理的逻辑中一个特判都没有"）：
        该列的产出方有两类 —— **过 `crate-merge` 的**（xcpc：merge 帮它补 `src`）
        和**不过 merge 的**（hdu / nk：单来源流水线，适配器写完就直接落盘）。
        两边形状不同，读取端就不得不写"两种都认 + 出处回落"的容错 —— 那就是特判。
        归一放在**唯一的产出点**（`_add` 是全部记录的唯一入口）之后，
        读取端只剩一条直路：认 `{v, src}`。

        * 条目可以是裸 URL 或 `{v, src}`；出处缺省 = **本包的来源 id**
          （单来源包里"这条值是谁给的"本来就是它）；
        * 空值丢掉、空类别丢掉；整个列空了就把键删掉（不写空壳）。
        """
        lk = record.get("链接分类")
        if not isinstance(lk, dict):
            return
        out: dict[str, list] = {}
        for kind, seq in lk.items():
            items = []
            for one in (seq if isinstance(seq, (list, tuple)) else [seq]):
                v = one.get("v") if isinstance(one, dict) else one
                if v is None or not str(v).strip():
                    continue
                src = (one.get("src") if isinstance(one, dict) else "") or self.source["id"]
                items.append({"v": str(v).strip(), "src": str(src)})
            if items:
                out[str(kind)] = items
        if out:
            record["链接分类"] = out
        else:
            record.pop("链接分类", None)

    def _normalize_class_rules(self, record: dict) -> None:
        """
        把元列 `分类依据` **归一成唯一形状**：`{ 性质字段: 规则id }`，并**验收规则 id**。

        与 `_normalize_link_kinds` 同一个理由（归一放在唯一产出点、读取端走直路），
        但这里多一道**格式验收**：规则 id 是给应用查级别表的键，拼错了不会有人发现
        （只会静默变 E 级）—— 所以宁可当场炸。

        · 未知字段名丢掉；空规则丢掉；整个列空了就把键删掉（不写空壳）；
        · 合法形状由 `class_rule_problem()` 判（**唯一实现**）。
        """
        cr = record.get("分类依据")
        if not isinstance(cr, dict):
            return
        out: dict = {}
        for field, rule in cr.items():
            if field not in NATURE_FIELDS:
                continue
            r = str(rule or "").strip()
            if not r:
                continue
            problem = class_rule_problem(r)
            if problem:
                raise ValueError(f"分类依据不合法（{field}）：{problem}")
            out[field] = r
        if out:
            record["分类依据"] = out
        else:
            record.pop("分类依据", None)

    def platform(self, ext_key: str, name: str = "", parent: str = "", **extra) -> str:
        """
        平台（W）。`parent` 留空 ⇒ 挂在真实根节点下（应用侧 3.3）。

        返回它的 extKey，便于链式构造。
        """
        rec = {"节点类型": "W", "extKey": ext_key}
        if parent:
            rec["父extKey"] = parent
        if name:
            rec.setdefault("name", name)
        rec.update({k: v for k, v in extra.items() if v is not None})
        self._add(rec)
        return ext_key

    def series(self, parent: str, ext_key: str, name: str = "", **extra) -> str:
        """系列（S）。`W` 下不能直接放 `C`，所以平台与比赛之间必须有这一层。"""
        rec = {"节点类型": "S", "extKey": ext_key, "父extKey": parent}
        if name:
            rec["name"] = name
        rec.update({k: v for k, v in extra.items() if v is not None})
        self._add(rec)
        return ext_key

    def contest(self, parent: str, ext_key: str, name: str = "",
                owner_synth: str = "", **extra) -> str:
        """
        比赛（C）。`parent` 必须是 `S`（或 `S` 嵌套 `S`）。

        `owner_synth` 非空 ⇒ 这条记录是某个**合成节点**的成员，
        值是该合成节点的 `synthKey`（**不是**节点 id、也不是 extKey）。
        """
        rec = {"节点类型": "C", "extKey": ext_key, "父extKey": parent}
        if name:
            rec["name"] = name
        if owner_synth:
            rec["ownerSynth"] = owner_synth
        rec.update({k: v for k, v in extra.items() if v is not None})
        self._add(rec)
        return ext_key

    def problem(self, parent: str, ext_key: str, name: str = "", problem_id: str = "",
                link: str = "", ratio="", cf_difficulty=None, tags=None,
                owner_synth: str = "", **extra) -> str:
        """
        题目（P）。

        注意 `ratio`（通过率百分比）会自动带出 `xcpcDifficulty`——那是**应用侧派生**的，
        不要自己写 `xcpcDifficulty`。

        `owner_synth` 同 `contest()`（成员指针，写的是 `synthKey`）。
        """
        rec = {"节点类型": "P", "extKey": ext_key, "父extKey": parent}
        if name:
            rec["name"] = name
        if problem_id:
            rec["problemId"] = problem_id
        if link:
            rec["link"] = link
        if ratio not in ("", None):
            rec["ratio"] = str(ratio)
        if cf_difficulty:
            rec["cfDifficulty"] = int(cf_difficulty)
        if tags:
            rec["tags"] = list(tags)
        if owner_synth:
            rec["ownerSynth"] = owner_synth
        rec.update({k: v for k, v in extra.items() if v is not None})
        self._add(rec)
        return ext_key

    def submission(self, parent: str, ext_key: str, status: str = "",
                   time: str = "", link: str = "", owner_synth: str = "",
                   **extra) -> str:
        """
        提交记录（R）。

        这是**最重要的记录类型**：应用的 `status2` / `acTime` / `lastSubmitTime`
        都由 R 子节点推导（见 docs/auto-import.md 7.6），
        所以爬虫**不需要**输出"是否通过"。

        `time` 会被自动标准化为 `YYYY.MM.DD HH:MM`。

        `owner_synth` 同 `contest()`（成员指针，写的是 `synthKey`）。
        """
        rec = {"节点类型": "R", "extKey": ext_key, "父extKey": parent}
        if status:
            rec["status"] = normalize_status(status)
        if time:
            rec["time"] = normalize_time(time)
        if link:
            rec["link"] = link
        if owner_synth:
            rec["ownerSynth"] = owner_synth
        rec.update({k: v for k, v in extra.items() if v is not None})
        self._add(rec)
        return ext_key

    def synth(self, synth_key: str, node_type: str, parent: str = "",
              parent_synth: str = "", name: str = "", **extra) -> str:
        """
        **合成节点** —— 一个真节点，身份是 `synthKey`（**没有** extKey）。

        它和普通节点的区别只有两点：
          · 身份：树上按 `synthKey` 认人（`extKey` 那一套与它无关）；
          · 类型：只允许 C / P / R（W/S/O 不参与合成）。

        位置（谁当父节点）由调用方决定，本构造器**不替你做约定**：
          · `parent`       = 父的 **extKey**（父是普通节点，树上或本包内）
          · `parent_synth` = 父的 **synthKey**（父是合成节点）
        两者**至多给一个**；都不给 ⇒ 挂在真实根节点下（与 `platform()` 同一口径）。
        ⚠️ 校验器两种写法都接受；哪种是你们的约定，由 Scraper 侧决定。

        返回它的 `synthKey`，便于链式构造（和 `contest()` 返回 extKey 一样）。
        """
        rec = {"节点类型": str(node_type).strip().upper(), "synthKey": synth_key}
        if parent:
            rec["父extKey"] = parent
        if parent_synth:
            rec["父synthKey"] = parent_synth
        if name:
            rec["name"] = name
        rec.update({k: v for k, v in extra.items() if v is not None})
        self._add(rec, required_fields=("name",))
        return str(synth_key).strip()

    # ---------- 输出 ----------

    def declare_source(self, source_id: str, kind: str = "derived", label: str = "") -> None:
        """
        登记"本包还会用到、但不是本包 `source.id` 的**别的**来源 id"（见 `extra_sources` 的注释）。

        用途：共享根容器的显示名出处（`xcpc_common.ROOT_SRC` 那种构建期常量）。
        合并后它会出现在包的 `source.sources` 里，应用才知道那个 id 的 kind
        （类别序 manual > board > script > derived）。
        """
        sid = str(source_id or "").strip()
        if not sid:
            return
        if kind not in ("board", "script", "derived", "manual"):
            raise ValueError(f"未知的来源类别 kind={kind!r}（board/script/derived/manual）")
        self.extra_sources.setdefault(sid, {"kind": kind, "label": label or sid})

    def to_dict(self) -> dict:
        """转成 crate 字典（可直接 json.dump）"""
        source = dict(self.source)
        if self.extra_sources:
            # ⚠️ **本包自己那份 id 优先**（同名时不覆盖）—— 与 `crate-merge` 里
            #    "同名 id 的 kind 取第一个声明"同一口径，别让这里把真来源的类型改掉。
            nested = dict(source.get("sources") or {})
            for sid, meta in self.extra_sources.items():
                nested.setdefault(sid, dict(meta))
            source["sources"] = nested
        out = {
            "crateVersion": self.crate_version,
            "source": source,
            "generatedAt": self.generated_at,
            "fieldMap": dict(self.field_map),
            "records": list(self.records),
        }
        if self.field_policies:
            out["defaults"] = {"fieldPolicies": dict(self.field_policies)}
        return out

    def save(self, path: str) -> str:
        """写入 JSON 文件（UTF-8、缩进 2、ensure_ascii=False 保留中文）

        ⚠️ **临时文件 + `os.replace` 原子替换**：爬虫动不动跑几十分钟、
        还常被 Ctrl-C，直接覆盖写一旦被打断就留下**半个 JSON**，而后续
        `crate-merge` 会把截断的片段当正常输入读进来（症状是"合并莫名其妙少了一截"）。
        临时文件与目标**同目录**（跨盘 replace 不原子），异常路径由 `finally` 清掉。
        """
        data = self.to_dict()
        tmp = '%s.crate-%d' % (path, os.getpid())
        try:
            with open(tmp, "w", encoding="utf-8", newline="\n") as fh:
                json.dump(data, fh, ensure_ascii=False, indent=2)
                fh.write("\n")
            os.replace(tmp, path)
        finally:
            if os.path.exists(tmp):
                try:
                    os.remove(tmp)
                except OSError:
                    pass
        return path

    def summary(self) -> str:
        """一行摘要，便于爬虫日志输出"""
        counts: dict[str, int] = {}
        for r in self.records:
            counts[r["节点类型"]] = counts.get(r["节点类型"], 0) + 1
        parts = [f"{TYPE_LABELS.get(k, k)}×{counts[k]}"
                 for k in sorted(counts, key=lambda t: NODE_TYPES.index(t))]
        # 合成节点混在类型计数里看不出来（它也是 C/P/R），单独点一笔
        synth = sum(1 for r in self.records if str(r.get("synthKey") or "").strip())
        extra = f"，其中合成节点×{synth}" if synth else ""
        return f"{len(self.records)} 条记录（{', '.join(parts)}{extra}）"


# ================================================================
# 校验（离线自查，对应应用侧会做的判定）
# ================================================================

def validate_crate(data: dict, tree_ext_keys: set[str] | None = None,
                   tree_synth_keys: set[str] | None = None,
                   tree_node_ids: set[str] | None = None) -> list[str]:
    """
    校验一份 crate，返回问题列表（空列表 = 可导入）。

    `tree_ext_keys` 是**主树上已有**的 extKey 集合。传了它，就能提前发现
    "父节点两边都没有"这类会在导入时被逐条拒绝的问题。
    获取方式：应用里导出 JSON 后，把 nodes 的 extKey 收集起来
    （`extract_tree_keys` 就干这个）。

    合成：树上还有一类节点**没有 extKey** —— 合成节点（身份是 `synthKey`）。
    所以另外三个可选的树上集合：
      · `tree_synth_keys` —— 主树上已有的合成标识（判定成员指针 / `父synthKey` 悬空）；
      · `tree_node_ids`   —— 主树上的节点 id（判定 `ownerSynth` 是否误写成了节点 id）。
    不传它们时，指向树上合成节点的引用会被保守地报成"解析不了"（宁可疑，不放过）。

    ⚠️ 「R 没有 `time`」这条**不许放宽**（别加 `allow_missing_time` 之类的口）：2026-10-15 试过
    "空着 + 点名放行"，结果是**体检判真缺 ⇒ 非零退出 ⇒ 整条链停在体检那一步**（树一动不动）。
    定稿口径在**生成端**：拿不到绝对时刻的提交**丢弃 + 警告**（`qoj_adapter.py`），
    于是进包的 R 一定有时间，这条校验照旧是一道真闸门。

    只做**离线能查的**检查；权威判定始终在应用侧。
    """
    issues: list[str] = []

    if not isinstance(data, dict):
        return ["crate 根必须是对象"]

    if data.get("crateVersion") != CURRENT_CRATE_VERSION:
        issues.append(f"crateVersion 应为 {CURRENT_CRATE_VERSION}，实际 {data.get('crateVersion')!r}"
                      "（版本不符应用会整包报错）")

    src = data.get("source")
    if not isinstance(src, dict) or not src.get("id"):
        issues.append("source.id 缺失（应用用它记导入记录）")

    field_map = data.get("fieldMap")
    if not isinstance(field_map, dict):
        issues.append("fieldMap 缺失或不是对象")
        field_map = {}
    else:
        for column, internal in field_map.items():
            if internal is None:
                continue
            if not isinstance(internal, str) or not internal:
                issues.append(f"fieldMap[{column!r}] 的值非法：{internal!r}"
                              "（应为内部字段名或 null）")
            elif internal in DERIVED_FIELDS:
                issues.append(f"fieldMap[{column!r}] → {internal!r} 是**派生字段**，"
                              "写了也会被应用忽略；请改从 R（提交记录）推导")
            elif internal not in WRITABLE_FIELDS:
                issues.append(f"fieldMap[{column!r}] → {internal!r} 不是可写字段"
                              f"（可写：{', '.join(sorted(WRITABLE_FIELDS))}）")

    records = data.get("records")
    if not isinstance(records, list) or not records:
        issues.append("records 缺失或为空数组")
        return issues

    # ---- 逐条 ----
    by_key: dict[str, dict] = {}
    by_synth: dict[str, dict] = {}
    dup: set[str] = set()
    dup_synth: set[str] = set()
    for i, rec in enumerate(records):
        where = f"第 {i} 条"
        if not isinstance(rec, dict):
            issues.append(f"{where}：不是对象")
            continue

        rtype = rec.get("节点类型")
        if rtype not in NODE_TYPES:
            issues.append(f"{where}：节点类型非法 {rtype!r}"
                          f"（应为 {'/'.join(NODE_TYPES)} 之一）")

        # ---- 身份键：extKey（普通节点）/ synthKey（合成节点），恰好一个 ----
        raw_ext = rec.get("extKey")
        ext_key = raw_ext.strip() if isinstance(raw_ext, str) else ""
        if raw_ext is not None and not isinstance(raw_ext, str):
            issues.append(f"{where}：extKey 不是字符串（{raw_ext!r}）")
        raw_synth = rec.get("synthKey")
        synth_key = raw_synth.strip() if isinstance(raw_synth, str) else ""
        if raw_synth is not None and not isinstance(raw_synth, str):
            issues.append(f"{where}：synthKey 不是字符串（{raw_synth!r}）")

        if not ext_key and not synth_key:
            issues.append(f"{where}：extKey 与 synthKey 都缺失或为空 → 没有身份键，"
                          "应用会拒绝该条（4.4；合成节点用 synthKey 作身份）")
        if ext_key and synth_key:
            issues.append(f"{where}：同时带 extKey {ext_key!r} 与 synthKey {synth_key!r}"
                          " —— 合成节点的身份是 synthKey、**没有** extKey，"
                          "该条不导入")

        if ext_key:
            if len(ext_key) > MAX_EXT_KEY_LENGTH:
                issues.append(f"{where}：extKey 过长（>{MAX_EXT_KEY_LENGTH}）")
            if ext_key in by_key:
                dup.add(ext_key)
            else:
                by_key[ext_key] = rec
            if "：" in ext_key or re.search(r"[\uFF00-\uFFEF]", ext_key):
                issues.append(f"{where}：extKey 含全角字符（{ext_key!r}）——"
                              "肉眼几乎看不出，建议改半角")
            if ext_key != raw_ext:
                issues.append(f"{where}：extKey 首尾有空白（{raw_ext!r}）")

        if synth_key:
            if len(synth_key) > MAX_SYNTH_KEY_LENGTH:
                issues.append(f"{where}：synthKey 过长（>{MAX_SYNTH_KEY_LENGTH}）："
                              f"{synth_key!r}")
            if synth_key in by_synth:
                dup_synth.add(synth_key)
            else:
                by_synth[synth_key] = rec
            if synth_key != raw_synth:
                issues.append(f"{where}：synthKey 首尾有空白（{raw_synth!r}）")
            # 合成只在 C/P/R 上做 —— W/S/O 必须被拒（明确点名，别只说"类型非法"）
            if rtype not in SYNTH_TYPES:
                issues.append(f"{where}：不能合成 {rtype!r} 节点（synthKey={synth_key!r}）"
                              f" —— 合成只在 {' / '.join(SYNTH_TYPES)} 上做"
                              "（比赛 W / 系列 S / 平台 O 不参与合成）")
            if not str(rec.get("name") or "").strip():
                issues.append(f"{where}：合成节点（synthKey={synth_key!r}）没有 name"
                              " —— 它在树上是一个真节点，必须有名字")

        if rtype == "R" and not rec.get("time"):
            issues.append(f"{where}：R 记录没有 time —— 题目的 acTime/lastSubmitTime "
                          "推不出来")

    for k in sorted(dup):
        issues.append(f"包内 extKey 重复：{k!r} → 应用会拒绝所有参与者（3.2）")
    for k in sorted(dup_synth):
        issues.append(f"包内 synthKey 重复：{k!r} → 与 extKey 重复同一口径，"
                      "应用会拒绝所有参与者（3.2）")

    # ---- 成员指针 ownerSynth ----
    known_ext = set(by_key) | (tree_ext_keys or set())
    known_synth = set(by_synth) | (tree_synth_keys or set())
    known_ids = set(tree_node_ids or set())

    for i, rec in enumerate(records):
        if not isinstance(rec, dict):
            continue
        where = f"第 {i} 条"
        raw_owner = rec.get("ownerSynth")
        owner = raw_owner.strip() if isinstance(raw_owner, str) else ""
        if not owner:
            continue
        if str(rec.get("synthKey") or "").strip():
            issues.append(f"{where}：合成节点（synthKey={rec.get('synthKey')!r}）不能有"
                          f" ownerSynth={owner!r} —— 成员名单不能嵌套（core/ops/synth.js）")
            continue
        if owner in known_synth:
            holder = by_synth.get(owner)
            holder_type = holder.get("节点类型") if isinstance(holder, dict) else None
            self_type = rec.get("节点类型")
            if holder_type and self_type and holder_type != self_type:
                issues.append(
                    f"{where}：成员指针 ownerSynth={owner!r} 指向的是 "
                    f"{TYPE_LABELS.get(holder_type, holder_type)} 类型合成节点，"
                    f"而本条是 {TYPE_LABELS.get(self_type, self_type)} 类型 —— "
                    "合成关系必须同类型（core/ops/synth.js）")
            continue
        # 解析不了：区分"写错了对象"（写成 extKey / 节点 id）和"悬空"
        if owner in known_ext:
            issues.append(f"{where}：ownerSynth={owner!r} 写的是 **extKey / 节点 id**，"
                          "不是合成标识（synthKey）—— 要写那条合成节点的 synthKey；"
                          "写入会被拒绝（core/ops/synth.js）")
        elif owner in known_ids:
            issues.append(f"{where}：ownerSynth={owner!r} 写的是**节点 id**，"
                          "不是合成标识（synthKey）—— 写入会被拒绝"
                          "（core/ops/synth.js 的 assertOwnerTarget）")
        else:
            issues.append(f"{where}：**悬空成员指针**：ownerSynth={owner!r} "
                          "树上没有、本包里也没有 → 写入会被拒绝（不再落成单元素组）")

    # ---- 父引用：链能不能串起来 ----
    # 父引用也有两种，节点自身的键也有两种，所以统一用带命名空间的二元组
    #        （`("ext", extKey)` / `("synth", synthKey)`）—— 否则 synthKey 恰好
    #        等于某个 extKey 时会把两条记录认成同一个。
    label: dict[tuple[str, str], str] = {}
    node_type: dict[tuple[str, str], str] = {}
    parents_of: dict[tuple[str, str], tuple[str, str] | None] = {}
    for i, rec in enumerate(records):
        if not isinstance(rec, dict):
            continue
        ek = rec.get("extKey")
        ek = ek.strip() if isinstance(ek, str) else ""
        sk = rec.get("synthKey")
        sk = sk.strip() if isinstance(sk, str) else ""
        if ek:
            self_ref = ("ext", ek)
        elif sk:
            self_ref = ("synth", sk)
        else:
            continue
        label[self_ref] = ek or sk
        node_type[self_ref] = rec.get("节点类型")

        pe = rec.get("父extKey")
        pe = pe.strip() if isinstance(pe, str) else ""
        ps = rec.get("父synthKey")
        ps = ps.strip() if isinstance(ps, str) else ""
        if pe and ps:
            issues.append(f"第 {i} 条：同时给了 父extKey={pe!r} 与 父synthKey={ps!r}"
                          " —— 父引用只能给一个（2.3）")
            continue
        if pe:
            parents_of[self_ref] = ("ext", pe)
        elif ps:
            parents_of[self_ref] = ("synth", ps)
        else:
            parents_of[self_ref] = None

    def _resolvable(ref: tuple[str, str]) -> bool:
        kind, key = ref
        return key in (known_ext if kind == "ext" else known_synth)

    for self_ref, parent_ref in parents_of.items():
        if parent_ref is None:
            continue
        if not _resolvable(parent_ref):
            kind, p = parent_ref
            col = "父extKey" if kind == "ext" else "父synthKey"
            issues.append(f"父节点两边都没有：{label[self_ref]!r} 的 {col}={p!r} "
                          "既不在本包 records 里，也不在树上 → 应用会拒绝该条（2.3）")

    # ---- 父子类型：这是最容易写错的一条 ----
    for self_ref, parent_ref in parents_of.items():
        if parent_ref is None or parent_ref not in node_type:
            continue          # 父在树上（本包没有它的记录）⇒ 类型未知，跳过
        p_type = node_type[parent_ref]
        c_type = node_type[self_ref]
        if p_type in ALLOWED_CHILDREN and c_type and c_type not in ALLOWED_CHILDREN[p_type]:
            hint = ""
            if p_type == "W" and c_type == "C":
                hint = "　← W 下不能直接放 C，必须中间插一层 S（2.5）"
            issues.append(
                f"{TYPE_LABELS.get(p_type, p_type)}({label[parent_ref]}) 下不允许 "
                f"{TYPE_LABELS.get(c_type, c_type)}({label[self_ref]}){hint}")

    # ---- 环 ----
    for start in list(parents_of):
        seen, cur = set(), start
        while cur is not None and cur not in seen:
            seen.add(cur)
            cur = parents_of.get(cur)
        if cur is not None and cur == start:
            issues.append(f"父引用成环：{label[start]!r} 的父链回到自身（2.2）")

    # ---- 列的解析方式（重要，别误判） ----
    # 应用侧有三种列：
    #   a) 键**本来就是内部字段名**（`name` / `link` / `problemId`）→ 直接生效，
    #      **不需要** fieldMap。本工具的 Crate 构造器就是这种风格。
    #   b) 键是爬虫自己的列名 → 必须由 fieldMap 映射到内部字段名。
    #   c) 键既不是内部字段名、也不在 fieldMap 里 → 真正的"未使用字段"
    #      （应用只记列名，不导入值）。
    # 所以判断"未使用"时要把 (a) 排除掉，否则会误报。
    seen_cols: set[str] = set()
    for rec in records:
        if not isinstance(rec, dict):
            continue
        for col in rec:
            # 结构列 + **元列**：元列不是业务字段，也不该报"未使用"。
            # （`字段来源`、`账户线索` 都是记录级元信息）
            # ⚠️ `其它来源值` 也必须在列里：它是 `crate-merge` 合并多来源时写的
            #    （落选值的备份，应用侧由 `fieldmap.js` / `parse.js` 认它），
            #    漏掉它 → 合并包会被误报"未使用字段"。
            # ⚠️ `链接分类` 同理：C 的链接按类别记账，
            #    爬取层只记录、不取舍（见 `LINK_KINDS`）。
            # ⚠️ `父synthKey`：父引用的一种写法，同样是**结构列**，不是业务字段。
            # ⚠️ `分类依据`：记录"这条 `natureClass` 是哪条规则判出来的"
            #    （`{ natureClass: 'qoj:path-icpc' }`），应用侧查级别表画依据强度徽标
            #    （`src/core/natureConfidence.js` 的 `CLASS_RULE_LEVEL`）。
            if col in ("节点类型", "extKey", "父extKey", "父synthKey", "parentExtKey",
                       "字段来源", "账户线索", "其它来源值", "链接分类",
                       CLASS_RULE_COL):
                continue
            if col in KNOWN_INTERNAL or col in field_map:
                continue
            if col not in seen_cols:
                seen_cols.add(col)
    for col in sorted(seen_cols):
        issues.append(f"提示：列 {col!r} 既不是内部字段名、也不在 fieldMap 中 "
                      "→ 会被当作「未使用字段」（只记列名，不导入值）")

    return issues

def _tree_sets(exported: dict) -> tuple[set[str], set[str], set[str]]:
    """
    从应用导出的完整 JSON 里收集三样东西（喂给 `validate_crate`）：

      · extKey 集合 —— 普通节点的身份；
      · synthKey 集合 —— **合成节点**的身份（这类节点**没有 extKey**，
        只收 extKey 的话，"父是合成节点 / 成员指针指向合成节点"会被误报成悬空）；
      · 节点 id 集合 —— 用来判 `ownerSynth` 是不是误写成了节点 id。
    """
    nodes = exported.get("nodes") or {}
    ext_keys: set[str] = set()
    synth_keys: set[str] = set()
    ids: set[str] = set()
    for node_id, node in nodes.items():
        ids.add(str(node_id))
        if not isinstance(node, dict):
            continue
        ek = str(node.get("extKey") or "").strip()
        if ek:
            ext_keys.add(ek)
        sk = str(node.get("synthKey") or "").strip()
        if sk:
            synth_keys.add(sk)
    return ext_keys, synth_keys, ids

def validate_crate_file(path: str, tree_keys_file: str | None = None) -> list[str]:
    """从文件读 crate 并校验；`tree_keys_file` 可选，传应用的导出 JSON"""
    with open(path, "r", encoding="utf-8-sig") as fh:
        data = json.load(fh)

    if tree_keys_file:
        with open(tree_keys_file, "r", encoding="utf-8-sig") as fh:
            exported = json.load(fh)
        ext_keys, synth_keys, ids = _tree_sets(exported)
        return validate_crate(data, ext_keys, synth_keys, ids)
    return validate_crate(data)

def extract_tree_keys(exported_json_path: str) -> set[str]:
    """从应用导出的完整 JSON 里收集所有非空 extKey（喂给 validate 用）"""
    with open(exported_json_path, "r", encoding="utf-8-sig") as fh:
        exported = json.load(fh)
    return _tree_sets(exported)[0]


# ================================================================
# selftest：合成节点（产出侧机制）
# ================================================================

def _cli(argv: list[str]) -> int:
    import argparse

    p = argparse.ArgumentParser(
        description="Acm_Tree 导入包（crate）校验 / 自测工具")
    sub = p.add_subparsers(dest="cmd", required=True)

    v = sub.add_parser("validate", help="校验一份 crate（导入前离线自查）")
    v.add_argument("crate", help="crate JSON 路径")
    v.add_argument("--tree", help="应用导出的完整 JSON（用于检查父节点是否已在树上）")

    s = sub.add_parser("selftest", help="用内置样本跑一遍构造→校验，验证工具本身")
    s.add_argument("--out", default="", help="把生成的 crate 写到该路径")

    k = sub.add_parser("tree-keys", help="从应用导出 JSON 里导出 extKey 清单")
    k.add_argument("exported", help="应用导出的完整 JSON 路径")
    k.add_argument("--out", default="", help="写到该文件（缺省打到 stdout）")

    #: **当前可写字段清单** —— 文档与人都来问它，别在各处手抄一份（抄本会烂）
    sub.add_parser("fields", help="打印当前可写字段白名单（WRITABLE_FIELDS）")

    args = p.parse_args(argv)
    # ⚠️ 自测在 `crate_selftest.py`（那边只放自测，这里只留构造器 + 校验器 + CLI）——
    #    **懒加载**：拷走单个 `crate.py` 的人不会因为这些子命令而 import 失败。
    from crate_selftest import (_crate_self_checks, _selftest_adapters,
                                _selftest_nature, _selftest_status, _selftest_synth)

    if args.cmd == "validate":
        issues = validate_crate_file(args.crate, args.tree)
        if not issues:
            print(f"✅ {args.crate} 通过校验")
            return 0
        print(f"❌ {args.crate} 有 {len(issues)} 个问题：")
        for it in issues:
            print("  •", it)
        return 1

    if args.cmd == "tree-keys":
        keys = sorted(extract_tree_keys(args.exported))
        text = "\n".join(keys) + ("\n" if keys else "")
        if args.out:
            with open(args.out, "w", encoding="utf-8", newline="\n") as fh:
                fh.write(text)
            print(f"已写出 {len(keys)} 个 extKey → {args.out}")
        else:
            sys.stdout.write(text)
        return 0

    if args.cmd == "fields":
        # 一行一个、**排序**输出：Python 这份是个 `frozenset`（没有顺序），排序只为
        # 输出稳定（方便 `diff` / 贴进文档）。**顺序本身不是判据** —— 顺序有语义的是
        # 应用侧 `core/model/elements.js` 那张表。
        for f in sorted(WRITABLE_FIELDS):
            print(f)
        return 0

    # selftest
    c = Crate(source_id="selftest", label="自测")
    c.platform("qoj", name="QOJ")
    c.series("qoj", "qoj:contest", name="QOJ Contest")
    c.contest("qoj:contest", "qoj:4113", name="Round 4113")
    c.problem("qoj:4113", "qoj:4113:20236", name="All Closed",
              problem_id="A", link="https://qoj.ac/contest/4113/problem/20236")
    c.submission("qoj:4113:20236", "qoj:sub:2951241", status="AC",
                 time="2026-09-13 22:06:07", link="https://qoj.ac/submission/2951241")

    data = c.to_dict()
    issues = validate_crate(data)
    print("构造：", c.summary())
    if issues:
        print(f"❌ 自测失败，{len(issues)} 个问题：")
        for it in issues:
            print("  •", it)
        return 1
    print("✅ 自测通过：构造出的 crate 能通过校验")
    print("   extKey 示例：", ", ".join(r["extKey"] for r in data["records"]))

    # ---- 合成：产出侧机制（该过的过、该拒的拒） ----
    synth_fails, synth_checks = _selftest_synth()
    if synth_fails:
        print(f"❌ 合成自测失败，{len(synth_fails)}/{synth_checks} 项：")
        for it in synth_fails:
            print("  •", it)
        return 1
    print(f"✅ 合成自测通过：{synth_checks} 项断言（合成节点 / 成员指针 / 父synthKey）")

    # ---- 「性质」四字段：词表的校验口径（该过的过、该拒的拒） ----
    nature_fails, nature_checks = _selftest_nature()
    if nature_fails:
        print(f"❌ 性质自测失败，{len(nature_fails)}/{nature_checks} 项：")
        for it in nature_fails:
            print("  •", it)
        return 1
    print(f"✅ 性质自测通过：{nature_checks} 项断言（大类/小类词表 / 年份格式 / 地区自由）")

    # ---- 「性质」：适配器侧契约（写进 Crate 之后还在不在 + 来源→大类这张表） ----
    crate_fails, crate_checks = _crate_self_checks()
    ad_fails, ad_checks = _selftest_adapters()
    if crate_fails or ad_fails:
        fails = crate_fails + ad_fails
        print(f"❌ 性质/适配器契约自测失败，{len(fails)}/{crate_checks + ad_checks} 项：")
        for it in fails:
            print("  •", it)
        return 1
    print(f"✅ 性质适配器契约自测通过：{crate_checks} 项（**nature_fields 进 Crate 之后仍在**）"
          f" + {ad_checks} 项（来源→大类表）")

    # ---- 判题结果词表（四个适配器共用的一份；"nk 段错误 评测状态不被识别"）----
    st_fails, st_checks = _selftest_status()
    if st_fails:
        print(f"❌ 判题结果词表自测失败，{len(st_fails)}/{st_checks} 项：")
        for it in st_fails:
            print("  •", it)
        return 1
    print(f"✅ 判题结果词表自测通过：{st_checks} 项断言（中英文别名 / 认得出都给码 / 只有空才是 '-'）")

    if args.out:
        c.save(args.out)
        print(f"已写出 → {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(_cli(sys.argv[1:]))
