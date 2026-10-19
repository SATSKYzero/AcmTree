#!/usr/bin/env python3
# ================================================================
# XCPC 自动建组（scripts/nature_rules.py）—— ⚠️ **已停用，链上不再跑**
#
# 【为什么停用（实测，2026-10-06）】
#   它是**第二个建组器**（清单 slug 那一套），与 `scripts/synth-bind.mjs`（按 nature）并存
#   ⇒ 两份实现迟早漂。实测它 413 条产物里，**大部分已被 `synth-bind` 覆盖**：
#     · 128 个组头**全是国内**、且都被 `synth-bind` 换成新格式键
#       （`synth:xcpc:bjcpc2024` → `synth:xcpc:2024provincial-北京`）；
#     · 258 条成员指针同样被重写（`ownerSynth` 重算）；
#     · 非国内那条路（清单 slug 建组）**从来没命中过**：清单 186 场全是国内口径的场次，
#       非国内分支（`icpc/ap|eu|na|la`、`ucup`）也从来没有 ≥2 棵树出 C 的场次。
#   ⚠️ **但它不是纯冗余**（这一条是实测踩出来的，别再把"摘掉它没影响"当成结论）：
#     把这一步摘掉、并把 `acm-data/nodes/xcpc-synth.json` 挪走重跑，最终包**会坏**：
#       · 顶层 W `xcpc` 没了 ⇒ 整棵合成子树散到树根下；
#       · `xcpc:s:synth-icpc` 这个**中间层容器**没人建 ⇒ 它下面 16 个赛季层全断链；
#       · 258 条成员指针的 `字段来源.ownerSynth` 来源痕没了。
#     ⇒ 这三样**已经补进 `synth-bind.mjs`**（它现在自己把容器链一路铺到顶、并写来源），
#       补完之后的验收：一次真的 `npm run crate:all` 重建，与摘掉前那份包逐条比 ——
#       记录集与结构**完全一致**（27967 条、零个只在一边的身份键；组头 292 / C 成员指针
#       609 / synth 容器与 W 的 47 个键集合相同），差异只有三类、且都是预期的：
#         · +345 条 `字段来源.ownerSynth`、+20 条 `字段来源.name`（**来源痕补全**）；
#         · 33 个组头的 `natureClass` 只差**镜像前缀**（`cf/gyms/xcpc/…` ↔ `qoj/xcpc/…`，
#           `bareClass` 之后相同）——组头的写法现在只由 `pickGroupNature` 的字典序决定；
#         · 3 个组头的 `分类依据` 现在正确记成 `manual:set`（人填过的那格是最硬的证据，
#           脚本的成员集合与应用侧对齐之后才认得出来）。
#
# 【现在谁管建组】`scripts/synth-bind.mjs`（**唯一一处**）——它按 nature 算键、**铺整条容器链**、
#   写指针与来源；容器/组的命名口径在 `src/core/synthPlan.js`。**别再往本文件加规则**；
#   真要复活"非国内也建组"，先定清楚"谁来判断同一场"（现在那一支是单来源，没有重复可合）。
#
# 本文件保留的意义：对照**清单 slug 那套老口径**（怎么铺容器、成员只写 extKey 不写 name），
#   以及它自己的自测（`python -B scripts/nature_rules.py selftest`）仍可跑。
# ================================================================
# 职责（历史）：从场次清单产出「**合成节点 + 成员指针 + 容器**」三样记录，交给 `crate.py` 校验。
#
# 【这件事只有五步】——不提供可配轴，唯一策略写死在 `plan()` 里：
#   1. 读清单 `05 xcpc/xcpc_contests.json`；
#   2. 问 `xcpc_pipeline.fragments_of()`（**唯一判据**）"这一场会在哪几棵来源树上出 C"；
#   3. **只有 ≥2 棵树上都出 C 的场次才建组** —— 那才叫"跨来源重复"（≤1 棵没有重复可言）；
#   4. 每个这样的场次产一个合成节点：
#        · 身份 `synthKey = synth:xcpc:<slug>` —— **稳定可复现**（重跑爬虫标识不变）
#        · 名字 = **场次自己的名字**（不拿 nature 拼、也不塞 slug）
#        · 位置 = 脚本建的容器，挂在**顶层 W「XCPC」**下（`aux` 与那几棵来源树一个字节不动）
#        · nature 四字段一律**调 `xcpc_common.xcpc_nature()`**（唯一产出点，本文件不重算）
#   5. 成员 C 记录**只写 `extKey` + `ownerSynth`**（**不写 name** —— 免得把树上已有的名字覆盖掉）。
#
# 【为什么分组键是 slug 而不是 nature】实测（docs/field-rules.md §10.5）：
#   纯 nature 分组会把**不同场次**并到一起（12/15 组并错，最严重 9 场一组）；
#   slug 直接决定"是不是同一场" ⇒ 0 并错。nature 因此只负责**容器分层**，
#   不再参与"要不要建组"——所以"小类为空"是**正常状态**，不再是"不够强"。
#
# 【刻意不做的事】（要加回来请先想清楚为什么）
#   · 没有"按任意字段分组"的模式 —— 只有 slug 这一种；
#   · 没有 LCA 兜底 / 严格模式 / 名字模板 / prefer_complete / remark 通道 / registry 序列化；
#     （LCA 那条有实测支撑可删：跨树共同祖先是 W `aux`，收不了 C，15/15 全部算不出。）
#   · 不在这里重抄渠道表与键模板 —— `xcpc_common` 的 `AUX_TREES` / `contest_key` /
#     `series_key` / `mid_key` / `xcpc_nature` 都是**唯一处**，本文件一律 import。
#
# 用法（都只读，绝不写 acm-data）：
#   python -B scripts/nature_rules.py selftest    # 内存小例子，钉住机制
#   python -B scripts/nature_rules.py dryrun      # 真实清单干跑，报数字
# ================================================================
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import Counter
from selftest_kit import Selftest

HERE = os.path.dirname(os.path.abspath(__file__))
XCPC_DIR = os.path.join("acm-data", "raw", "Scaper", "05 xcpc")
MANIFEST = os.path.join(XCPC_DIR, "xcpc_contests.json")

# 合成节点的身份前缀与顶层归属 —— 与 `src/core/ops/synth.js` 的 `SYNTH_PREFIX` 同一字面量
# （JS 侧 `synthKeyProblem` 只对"手敲的新标识"设限，自动生成的一律带这个前缀）。
SYNTH_PREFIX = "synth:"
SYNTH_MAIN = "xcpc"
SYNTH_MAIN_NAME = "XCPC"
SYNTH_NODE_TYPE = "C"
# 这批记录的"来源 id"（导入时记在来源表里；这三样记录只带结构字段，不记来源值）
SOURCE_ID = "synth"
SOURCE_LABEL = "XCPC 合成节点（脚本自动建组）"


# ================================================================
# 一、复用既有件（**唯一一处**的那些）
# ================================================================

_MODULES: tuple | None = None


def modules() -> tuple:
    """
    延迟 import `xcpc_common` / `xcpc_pipeline` / `crate`（把 `scripts/`、`05 xcpc`、
    `05 xcpc/lib` 加进 `sys.path`）。

    为什么延迟：`xcpc_common.add_crate_path()` 是幂等的，但**谁先 import 谁说了算**；
    本文件既可能当库被 import、也可能当脚本跑，延迟最省事（与各适配器同一手法）。
    """
    global _MODULES
    if _MODULES is None:
        paths = (HERE, os.path.abspath(XCPC_DIR), os.path.join(os.path.abspath(XCPC_DIR), "lib"))
        for p in paths:
            if p not in sys.path:
                sys.path.insert(0, p)
        import crate as _crate              # noqa: PLC0415
        import xcpc_common as _common       # noqa: PLC0415
        import xcpc_pipeline as _pipeline   # noqa: PLC0415
        _MODULES = (_common, _pipeline, _crate)
    return _MODULES


def tree_by_source() -> dict[str, str]:
    """
    渠道 → 它那棵树的 W 键。

    **复用 `xcpc_common.AUX_TREES`**（渠道表的唯一处）：自抄一份 `CHANNEL_TREE` 的话，
    就会"加一个新渠道要改两处"，漏改时新渠道会被静默记成"非 aux 渠道（不计）"、不报错。
    """
    common, _pipeline, _crate = modules()
    return {src: tree for src, (tree, _name) in common.AUX_TREES.items()}


def real_year(value) -> str:
    """
    取一个**真年份**（`20\\d{2}`）—— `无` / `待同步` / `不确定` / 空 / 别的写法一律 `''`。

    为什么合成这一侧也要这一道：那两个占位取值是**合法值**（能存进 natureYear / natureSeason），
    但它们**不是年份** —— 拿去顶"举办年份"、或拿去当"哪一届"的容器名，都会把
    "还没定"说成"定了"。JS 侧同款是 `core/natureFields.js` 的 `isRealYear`。
    """
    s = str(value or "").strip()
    return s if re.fullmatch(r"20\d{2}", s) else ""


def nature_of(contest: dict) -> dict:
    """全部 nature 字段 —— **调唯一产出点** `xcpc_common.xcpc_nature()`，本文件不重算。

    ⚠️ 合成节点**自己也带 `natureYear`**：清单里没有开赛时间（`xcpc_nature` 只会照实留空），
    而合成节点是"一组来源的合并视图"，它没有"举办时间"这个东西 —— 所以这里把**赛季**填进
    年份（两者对不同来源的成员才可能差一年，对合成节点这一层没有意义）。
    ⚠️ **但总决赛例外**：`xcpc_nature` 给它们写 **`待同步`**（如"The 2017
    ACM-ICPC Asia EC League Final Contest（上海大学）年份也填待同步"），`待同步` 是**真值** ⇒
    下面那条"没年份就用赛季顶"自然不会触发（合成节点与它的成员保持一致，都是 `待同步`）。
    这不这么做的话，那些节点会一直挂在 ③「性质待补」里等人填一个填不出来的值。
    ⚠️ 只有**真年份**能顶：`无`（没有赛季概念）/ `待同步` / `不确定` 顶上去就是写坏的年份
    （`natureYear` 存得下它们，但那不是"举办年份"，等于把"没定"说成"定了"）。
    """
    common, _pipeline, _crate = modules()
    nat = common.xcpc_nature(
        contest.get("series"),
        contest.get("mid"),
        str(contest.get("name") or "")
    )
    season = real_year(nat.get("natureSeason"))
    if not nat.get("natureYear") and season:
        nat["natureYear"] = season
    return nat


def keys_of(source: str, slug: str, sid: str, mid_id: str) -> tuple[str, str]:
    """
    `(C 的 extKey, 它该挂的父 S 的 extKey)` —— **复用 `xcpc_common` 的键模板**
    （`contest_key` / `series_key` / `mid_key` 是拼键的唯一处，别在这里抄 `f"{tree}:c:{slug}"`）。

    ⚠️ 那几个函数按模块级 `_tree()` 拼键，所以先 `use_tree(source)` 把树定下来。
    这个副作用只限本离线工具（真正产包时本来也要 `use_tree`）。
    """
    common, _pipeline, _crate = modules()
    common.use_tree(source)
    series = common.series_key(sid)
    mid = common.mid_key(sid, mid_id) if mid_id else series
    return common.contest_key(slug), mid


# ================================================================
# 二、计划（**纯函数**：内存进、内存出，不碰磁盘也不碰 crate）
# ================================================================

def synth_key_of(slug: str) -> str:
    """合成标识：**稳定可复现**（清单不变 ⇒ 标识不变，导入幂等）。"""
    return f"{SYNTH_PREFIX}{SYNTH_MAIN}:{slug}"


# 分类/年份取不到时的兜底桶（**必须有**：树里 W 不能直接放 C，少了这层记录就没地方挂）
SUB_FALLBACK_KEY = "other"
SUB_FALLBACK_NAME = "其它"
YEAR_FALLBACK_KEY = "year-unknown"
YEAR_FALLBACK_NAME = "年份未知"


def containers_of(nature: dict) -> list[tuple[str, str]]:
    """
    合成节点的容器**路径** `[(extKey, name), ...]`。

    路径规则：**大类都一样，应该先按小类分、再按年份分，年份下是各 C 节点**；
    分类是**不定层路径** ⇒ 容器**跟着路径走**。
    ⚠️ 第一段 `xcpc` 与顶层 W「XCPC」是同一个东西 ⇒ **不重复建那一层**。
    ⚠️ W 不能直接放 C ⇒ 每一支**至少要有一层**（连"铺不出层"的兜底也要有）。

    ★ **与真树同一套层**（赛季一层、省赛只地点、
      不套 reg/final 层、热身赛单独一层）⇒ 判据**只有一份**，就是 `xcpc_common` 里那几个：
      `xcpc_series_layer` / `xcpc_area_layer` / `tree_time_layer` / `is_warmup_class`。
      （"`natureClass` 的每一段各一层 + 年份层"的写法会建出
       `synth-ccpc:final:official:2019` 这种真树里并不存在的层。）
    """
    common, _pipeline, _crate = modules()
    cls = str(nature.get("natureClass") or "")
    # ⚠️ 时间层用**赛季**（`natureSeason`）优先：容器回答的是"哪一届"，
    #    而 EC-Final 那种跨年场次的"举办年份"会把同一届拆开。
    #    ⚠️ 只认**真年份**：`无` / `待同步` 当容器名的话会建出一个叫「待同步」的层 —— 无意义。
    seg, label = common.tree_time_layer(cls, nature.get("natureSeason"), nature.get("natureYear"))
    series_seg, series_name = common.xcpc_series_layer(cls)
    area_seg, area_name = common.xcpc_area_layer(cls)
    out: list[tuple[str, str]] = []
    if not series_seg:
        # 不是 XCPC 那一支（`qoj` / `cf/contest` / `其他`…）⇒ 路径每段各一层 + 时间层
        segs = [s for s in cls.split("/") if s]
        if segs and segs[0] == SYNTH_MAIN:
            segs = segs[1:]
        year = real_year(nature.get("natureSeason")) or real_year(nature.get("natureYear"))
        key = f"{SYNTH_MAIN}:s:synth"
        for s in segs or [SUB_FALLBACK_KEY]:
            key = f"{key}-{s}" if key.endswith("synth") else f"{key}:{s}"
            out.append((key, s if s != SUB_FALLBACK_KEY else SUB_FALLBACK_NAME))
        out.append((f"{key}:{year or YEAR_FALLBACK_KEY}", year or YEAR_FALLBACK_NAME))
        return out
    # ---- XCPC 那一支：系列 → （赛区）→ 时间层 → （热身赛） ----
    # ⚠️ 省赛**不再按地点分层**（"分类换为仅赛季一层"）⇒ 与别的支同一条路
    key = f"{SYNTH_MAIN}:s:synth-{series_seg}"
    out.append((key, series_name))
    if area_seg:
        key = f"{key}:{area_seg}"
        out.append((key, area_name))
    if seg:
        key = f"{key}:{seg}"
        out.append((key, label))
    if common.is_warmup_class(cls):
        key = f"{key}:warm-up"
        out.append((key, common.WARMUP_LAYER))
    return out


def plan(contests, fragments_of, tree_map: dict[str, str]) -> dict:
    """
    清单 → 计划。**整个文件的业务逻辑就这一段。**

    @param contests      清单里的场次（dict 列表）
    @param fragments_of  `(contest) -> [(来源, extKey, 角色), ...]`（注入以便离线自测）
    @param tree_map      渠道 → 树键（`tree_by_source()`）
    @returns `{"groups": [...], "skipped": Counter}`；每组
             `{slug, name, synthKey, nature, container, containerName, members: [(extKey, parentKey)]}`
    """
    groups: list[dict] = []
    skipped = Counter()

    for contest in contests:
        slug = str(contest.get("slug") or "").strip()
        if not slug:
            skipped["场次缺 slug"] += 1
            continue
        series = contest.get("series") or {}
        sid = str(series.get("id") or "").strip()
        if not sid:
            skipped["场次缺 series.id"] += 1
            continue
        name = str(contest.get("name") or "").strip()
        if not name:
            # **不编名字**（`crate.synth()` 也强制 name 非空）：跳过并计数，让调用方看得见。
            skipped["场次没名字"] += 1
            continue

        # ① 这一场在哪些**来源树**上出 C（按树去重：rankland 两个适配器是同一棵树）
        pairs: list[tuple[str, str]] = []          # (树键, 渠道)
        for frag in fragments_of(contest):
            source = str(frag[0])
            tree = tree_map.get(source)
            if tree and all(t != tree for t, _s in pairs):
                pairs.append((tree, source))
        pairs.sort()

        # ② **只有跨来源重复才建组**：一个 slug 只在一棵树上出 C ⇒ 没有"同一场多份"可言
        if len(pairs) < 2:
            skipped["只有 ≤1 棵来源树出 C（没有跨源重复）"] += 1
            continue

        mid_id = str((contest.get("mid") or {}).get("id") or "").strip()
        members = [keys_of(source, slug, sid, mid_id) for _tree, source in pairs]

        nature = nature_of(contest)
        containers = containers_of(nature)
        groups.append({
            "slug": slug,
            "name": name,
            "synthKey": synth_key_of(slug),
            "nature": nature,
            "containers": containers,                  # [(S, S), ...] 小类层 → 年份层
            "container": containers[-1][0],           # 合成节点**直接**挂的那一层（年份层）
            "members": members,
        })

    return {"groups": groups, "skipped": skipped}


# ================================================================
# 三、计划 → crate（**用 `Crate` 构造器，不自己拼记录**）
# ================================================================

def existing_keys(planned: dict) -> set[str]:
    """
    这批记录**假定树上已经有**的 extKey —— 校验器拿它当"树上现有的节点"。

    为什么要它：本包只产"合成节点 + 指针 + 合成容器"三样，**成员 C 的祖先**
    （`aux` ─ `aux-<渠道>` ─ 系列 S ─ 中间层 S）是**各适配器早就产过的**，不该在这里重产。
    干跑是离线的，所以只能按"同一份清单"声明它们在树上 —— 这与老代码造一棵 `TreeCtx` 假树
    是同一个假设，但**只声明键、不虚构整棵树**。
    """
    common, _pipeline, _crate = modules()
    out = {str(common.AUX_ROOT), *tree_by_source().values()}
    for group in planned["groups"]:
        for ext_key, parent_key in group["members"]:
            out.add(ext_key)
            out.add(parent_key)
    return out


def plan_to_crate(planned: dict) -> tuple[dict, list[str]]:
    """
    计划 → 一个完整 crate（dict）+ `validate_crate` 的问题清单。

    产三样记录：
      · **顶层 W `xcpc`「XCPC」** —— 合成节点的家（`aux` 是来源树的桶，不该塞合成节点）；
      · **容器 S** —— 小类层 + 年份层两层（按 nature 去重后各产一条）；
      · **合成节点**（带 nature）+ **成员 C**（成员只写 `extKey` + `ownerSynth`，**不写 name**）。
    """
    _common, _pipeline, crate = modules()
    if not planned["groups"]:
        return crate.Crate(SOURCE_ID, label=SOURCE_LABEL).to_dict(), []

    c = crate.Crate(SOURCE_ID, label=SOURCE_LABEL)
    # 顶层 W：**只产一次**；顶层记录不写「父extKey」（与 qoj / cf / atcoder / aux 同形）
    c.platform(SYNTH_MAIN, name=SYNTH_MAIN_NAME)

    made: set[str] = set()
    for group in planned["groups"]:
        parent = SYNTH_MAIN
        for ext_key, name in group["containers"]:
            if ext_key not in made:
                made.add(ext_key)
                c.series(parent, ext_key, name=name)
            parent = ext_key                     # 下一层的父 = 这一层（S 可以套 S）
        # ⚠️ **合成节点自己也要带 nature**：它是 C（比赛），而
        #    ③「性质待补」的判据是"比赛必须知道自己是哪个平台 / 赛系" —— 漏了这一步，
        #    `all_nodes.json` 里**唯一一批没有大类的 C 就是这 128 个合成节点**
        #    （实测：C 1368 个，没有大类的 128 个**全是 `synthKey`**）。
        #    值直接取 `xcpc_nature()` 那份（**唯一产出点**：`xcpc_common.xcpc_nature`），
        #    再过一次 `nature_fields()` 的受控词表校验；地区它给的是空 ⇒
        #    这些节点照样会出现在 ③ 里等人补地区（那是"还没判"，不是"不适用"）。
        nature = group["nature"]
        # ⚠️ `nature` 里多了一样**元列** `分类依据`（这条分类凭什么判出来的）
        #    —— `nature_fields()` 只认性质字段，整包塞进去会当场炸。所以两样分开传：
        #    性质字段走 `nature_fields`，依据走 `class_rules`（都进同一个记录）。
        c.synth(group["synthKey"], SYNTH_NODE_TYPE, parent=parent, name=group["name"],
                **crate.nature_fields(
                    *[(k, v) for k, v in nature.items() if v and k in crate.NATURE_FIELDS]),
                **crate.class_rules(
                    *[(k, v) for k, v in (nature.get(crate.CLASS_RULE_COL) or {}).items()]))
        for ext_key, parent_key in group["members"]:
            # ⚠️ **不传 name**：这条记录的唯一目的是写指针；带上名字会在导入时
            #    按 `overwrite-if-changed` 覆盖树上已有的题名。
            c.contest(parent_key, ext_key, owner_synth=group["synthKey"])

    data = c.to_dict()
    return data, crate.validate_crate(data, existing_keys(planned))


# ================================================================
# 四、干跑（**只读**：读清单，不跑适配器、不联网、不写 acm-data）
# ================================================================

def snapshot(root: str) -> dict[str, tuple[int, int]]:
    """`路径 → (mtime_ns, size)`：用来**证明**干跑没写过任何文件（不哈希：cache 里有 MB 级文件）。"""
    out: dict[str, tuple[int, int]] = {}
    for base, dirs, files in os.walk(root):
        dirs.sort()
        for fn in sorted(files):
            p = os.path.join(base, fn)
            try:
                st = os.stat(p)
            except OSError:
                continue
            out[p] = (st.st_mtime_ns, st.st_size)
    return out


def load_manifest(path: str = MANIFEST) -> list[dict]:
    with open(path, "r", encoding="utf-8-sig") as fh:
        data = json.load(fh)
    return [x for x in (data.get("contests") or []) if isinstance(x, dict)]


def build(out_path: str) -> int:
    """
    产出**带合成节点与成员指针的导入包**（写文件是这一步唯一会落盘的动作）。

    校验不过就**不写文件**（宁可什么都没有，也别产出一个应用会拒的包）。
    """
    _common, pipeline, crate = modules()
    planned = plan(load_manifest(), pipeline.fragments_of, tree_by_source())
    data, issues = plan_to_crate(planned)
    if issues:
        for one in issues[:10]:
            print("   ·", one)
        print(f"❌ 校验不过（{len(issues)} 条问题）—— **没有写出文件**")
        return 1
    with open(out_path, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=1)
        fh.write("\n")
    groups = planned["groups"]
    print(f"✅ 已写出 {out_path}")
    print(f"   合成节点 {len(groups)} · 成员指针 {sum(len(g['members']) for g in groups)}"
          f" · 容器 {len({k for g in groups for k, _n in g['containers']})}（小类层+年份层）"
          f" + 顶层 W 1 · 记录 {len(data.get('records') or [])}")
    print("   拖进应用的「📥 节点自动导入」：预览里应出现"
          "「新建/更新合成节点 N」「设置成员指针 M」")
    return 0


def dry_run() -> int:
    _common, pipeline, crate = modules()
    before = snapshot("acm-data")

    contests = load_manifest()
    planned = plan(contests, pipeline.fragments_of, tree_by_source())
    data, issues = plan_to_crate(planned)

    groups = planned["groups"]
    members = sum(len(g["members"]) for g in groups)
    containers = len({k for g in groups for k, _n in g["containers"]})

    print("=" * 72)
    print("XCPC 自动建组 · 干跑（只读：不跑适配器、不联网、不写 acm-data）")
    print("=" * 72)
    print(f"清单：{MANIFEST}")
    print(f"场次 {len(contests)} ⇒ 建组 {len(groups)}"
          f"（合成节点 {len(groups)} · 成员指针 {members} · 容器 {containers} + 顶层 W 1）")
    print(f"记录数 {len(data.get('records') or [])} ⇒ validate_crate："
          f"{'✅ 无问题' if not issues else '❌ ' + str(len(issues)) + ' 条问题'}")
    for one in issues[:10]:
        print("   ·", one)

    print("-" * 72)
    print("跳过（**都计数，绝不静默丢**）：")
    if planned["skipped"]:
        for k, v in sorted(planned["skipped"].items()):
            print(f"    {k} = {v}")
    else:
        print("    （无）")

    print("-" * 72)
    print("样例（前 6 组）：")
    for g in groups[:6]:
        who = ", ".join(e for e, _p in g["members"])
        print(f"    {g['synthKey']}  name={g['name']!r}")
        path = " → ".join(f"{n}({k})" for k, n in g["containers"])
        print(f"        路径={path}  成员 {len(g['members'])} 条 ← {who}")

    print("-" * 72)
    after = snapshot("acm-data")
    changed = [p for p in set(before) | set(after) if before.get(p) != after.get(p)]
    print(f"缓存/文件是否被写过：{'**否**' if not changed else '**是**'}"
          f"（acm-data 快照 {len(before)} → {len(after)} 个文件，变更 {len(changed)} 个）")
    for p in changed[:5]:
        print("   ·", p)
    return 0 if not issues and not changed else 1


# ================================================================
# 五、自测（内存小例子；钉住机制，不碰磁盘）
# ================================================================

def _selftest() -> int:
    _st = Selftest('分类规则')
    ok = _st.ok

    tree_map = {"xcpcio": "aux-xcpcio", "rankland-index": "aux-rankland", "pta": "aux-pta"}

    # ① 跨 2 棵来源树 ⇒ 建组；只有 1 棵 ⇒ 跳过并计数
    contests = [
        {"slug": "ccpc2019final", "name": "2019 CCPC Final",
         "series": {"id": "ccpc", "name": "CCPC"}, "mid": {"id": "ccpc2019", "name": "2019"}},
        {"slug": "solo2020", "name": "2020 只有一家收录",
         "series": {"id": "icpc", "name": "ICPC"}, "mid": {"id": "icpc2020", "name": "2020"}},
    ]
    frags = {
        "ccpc2019final": [("xcpcio", None, "c"), ("rankland-index", None, "c")],
        "solo2020": [("xcpcio", None, "c")],
    }
    runner = lambda c: frags[c["slug"]]          # noqa: E731 —— 注入的假 fragments_of
    planned = plan(contests, runner, tree_map)
    groups = planned["groups"]

    ok(len(groups) == 1, "跨 2 棵来源树 ⇒ 建 1 组")
    ok(planned["skipped"]["只有 ≤1 棵来源树出 C（没有跨源重复）"] == 1, "只有 1 棵树 ⇒ 跳过并计数")

    g = groups[0]
    ok(g["synthKey"] == "synth:xcpc:ccpc2019final", "合成标识稳定可复现（synth:xcpc:<slug>）")
    ok(g["name"] == "2019 CCPC Final", "名字取自**场次自己**（不拿 nature 拼、不塞 slug）")
    ok(g["nature"]["natureClass"] == "xcpc/ccpc/final/official",
       "nature 走 xcpc_nature()：分类路径到**叶子**（末层还要分 official/warm-up）")
    ok(g["nature"]["natureYear"] == "待同步",
       "…年份：总决赛拿不到日期 ⇒ `待同步`")
    ok([k for k, _n in g["containers"]]
       == ["xcpc:s:synth-ccpc", "xcpc:s:synth-ccpc:2019"],
       "★ 与真树同一套层 —— 系列层 + **赛季层**（`final`/`official` 那些段**不再是层**）")
    ok([n for _k, n in g["containers"]] == ["ccpc", "2019"],
       "容器名 = 系列名 / 赛季（`natureSeason` 优先，见 `tree_time_layer`）")
    ok(g["container"] == "xcpc:s:synth-ccpc:2019",
       "合成节点**直接**挂在赛季层下")
    ok(sorted(e for e, _p in g["members"]) == ["aux-rankland:c:ccpc2019final",
                                               "aux-xcpcio:c:ccpc2019final"],
       "两个成员各按**自己那棵树**的键模板拼 extKey（复用 contest_key）")

    # ② 分类只到第一段（判不出更细）⇒ **照样建组**，容器退化到"兜底段 + 年份"
    solo = [{"slug": "a2021", "name": "2021 A",
             "series": {"id": "prov", "name": "X"}, "mid": {"id": "prov2021", "name": "2021"}}]
    fr2 = {"a2021": [("xcpcio", None, "c"), ("pta", None, "c")]}
    p2 = plan(solo, lambda c: fr2[c["slug"]], tree_map)
    ok(len(p2["groups"]) == 1, "分类判不细 ⇒ 照样建组（停在浅处是合法的）")
    ok(p2["groups"][0]["nature"]["natureClass"] == "xcpc",
       "…分类 = `xcpc`（= 顶层 W 那一段，容器里不再重复）")
    ok([k for k, _n in p2["groups"][0]["containers"]]
       == ["xcpc:s:synth-other", "xcpc:s:synth-other:2021"],
       "…分类只有 `xcpc`（不是 XCPC 那一支）⇒ 兜底段 `其它` + **时间层照旧**")

    # ③ 落 crate：成员记录只带 extKey + ownerSynth（**不带 name**）
    data, issues = plan_to_crate(plan(contests, runner, tree_map))
    ok(not issues, f"产出的 crate 过校验器（{issues[:2]}）")
    recs = data["records"]
    tops = [r for r in recs if r.get("extKey") == "xcpc"]
    ok(len(tops) == 1 and tops[0]["节点类型"] == "W" and not tops[0].get("父extKey"),
       "顶层 W `xcpc` **只产一条**且不写父extKey")
    synths = [r for r in recs if r.get("synthKey")]
    ok(len(synths) == 1 and synths[0]["name"] == "2019 CCPC Final"
       and synths[0].get("父extKey") == "xcpc:s:synth-ccpc:2019",
       "合成节点挂在**赛季层**的容器下")
    ok(synths[0].get("natureClass") == "xcpc/ccpc/final/official"
       and synths[0].get("natureYear") == "待同步",
       "★ 合成节点**自己带 nature**（它是 C：没有分类的 C 会进不了③「性质待补」）")
    # 地区（`xcpc_nature()` 也会判）：CCPC Final 属于"总决赛"那一档
    # ⇒ 脚本写 `待填写`（"ecfinal、ccfinal…都用脚本填『待填写』，但**在判定层面被视为已填写**"）。
    ok(synths[0].get("natureRegion") == "待填写",
       "…地区 = `待填写`（总决赛那一档：先摆着，但算填过了，不会挂在 ③ 等人补）")
    ok((synths[0].get("分类依据") or {}).get("natureRegion") == "xcpc:region-tbd",
       "…且带上地区的规则 id")
    segs = [r for r in recs if r.get("extKey") == "xcpc:s:synth-ccpc"]
    years = [r for r in recs if r.get("extKey") == "xcpc:s:synth-ccpc:2019"]
    ok(len(segs) == 1 and segs[0]["父extKey"] == "xcpc" and segs[0]["name"] == "ccpc",
       "系列那一层挂在顶层 W `xcpc` 下")
    ok(len(years) == 1 and years[0]["父extKey"] == "xcpc:s:synth-ccpc"
       and years[0]["name"] == "2019",
       "赛季层挂在**系列层**下（S 套 S）")
    mem = [r for r in recs if r.get("ownerSynth")]
    ok(len(mem) == 2, "两条成员记录")
    ok(all("name" not in r for r in mem), "★ 成员记录**不写 name**（免得覆盖树上已有的名字）")
    ok(all(r["节点类型"] == "C" for r in mem), "成员记录的类型照旧")

    # ④ 没名字的场次：跳过并计数，**不编名字**
    noname = [{"slug": "x", "name": "", "series": {"id": "ccpc"}, "mid": {"id": "m"}}]
    p3 = plan(noname, lambda c: [("xcpcio", None, "c"), ("pta", None, "c")], tree_map)
    ok(not p3["groups"] and p3["skipped"]["场次没名字"] == 1, "场次没名字 ⇒ 跳过并计数（不编名字）")

    return _st.done()


def main() -> int:
    ap = argparse.ArgumentParser(description="XCPC 自动建组（只读工具；只有 build 会落盘）")
    ap.add_argument("cmd", choices=("selftest", "dryrun", "build"))
    ap.add_argument("out", nargs="?", default=os.path.join("acm-data", "nodes", "xcpc-synth.json"),
                    help="build 的输出路径（默认 acm-data/nodes/xcpc-synth.json）")
    args = ap.parse_args()
    if args.cmd == "selftest":
        return _selftest()
    return dry_run() if args.cmd == "dryrun" else build(args.out)


if __name__ == "__main__":
    raise SystemExit(main())
