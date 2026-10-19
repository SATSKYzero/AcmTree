#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
`crate.py` 的**自测**（scripts/crate_selftest.py）—— 与构造器分开存放。

⚠️ 为什么只有这一块放在这里：
   `crate.py` 是一份**可以整文件拷走的构造器**（适配器脚本按 `os.path.isfile('<dir>/crate.py')`
   找到它、`from crate import Crate, …, validate_crate`；文件头写着"把 crate.py 放在同目录即可"）。
   构造器/校验器搬出去会破坏那份契约、并动到 11 个适配器 ⇒ **它们留在 `crate.py`**。
   而这里四个自测函数**没有任何外部 import**（只有 `_cli` 的 `selftest` 子命令用），
   所以放在这里最安全：`crate.py` 只剩构造器 + 校验器 + CLI。

⚠️ 这些自测是**构建侧的回归锚**（工具本身对不对），不是构造器的公开面。
"""
from __future__ import annotations

import sys

sys.dont_write_bytecode = True

from crate import (  # noqa: E402
    CLASS_RULE_COL,
    CLASS_SEP,
    CLASS_TRIE,
    Crate,
    NATURE_FIELDS,
    NATURE_PENDING_VALUES,
    NATURE_SEASON_NONE,
    NATURE_YEAR_NONE,
    class_matches,
    class_path_of,
    class_path_problem,
    class_paths,
    class_root_of,
    class_rule_problem,
    class_rules,
    class_value_of,
    normalize_status,
    normalize_time,
    is_known_class_path,
    nature_fields,
    validate_crate,
)


ADAPTER_CLASS_ROOT = {
    # ---- 05 xcpc：XCPC 赛系（榜单 / 索引 / 引用链接三个角色都算） ----
    "xcpcio": "xcpc",
    "rankland-index": "xcpc",
    "rankland-refs": "xcpc",
    "srk": "xcpc",
    # ⚠️ 这个适配器**同时**吃 PTA 与牛客两种形状的榜单（`tree_source`），
    #    但它出的 C 是清单里的 XCPC 场次 ⇒ 两种形状都写 `xcpc`，都**不许**写 pta/nk。
    "pta": "xcpc",
    "nk": "xcpc",
    # ---- 05 xcpc：办赛平台 ----
    "cf": "cf",              # gym 提交片段 / gym 榜单 / 官网链接
    "cf-titles": "cf",       # gym 的题名/题链接那一片段
    "cf-web": "cf",          # gym 的官网链接那一片段
    "cf-contest": "cf",      # CF 正式比赛
    "atcoder": "atcoder",
    "qoj": "qoj",
    # ---- 01 nk / 02 hdu：平台自己办的赛 ----
    "nk-scraper": "nk",
    "hdu-scraper": "hdu",
}

# 兼容别名（`ADAPTER_MAIN_NATURE` 与 `ADAPTER_CLASS_ROOT` 指向同一张表；
# **新代码一律用 `ADAPTER_CLASS_ROOT`**）

ADAPTER_MAIN_NATURE = ADAPTER_CLASS_ROOT

# **不该出现在分类根里的值** —— 收集源 / 榜单（判据：它们只决定"数据从哪儿来"）

COLLECTOR_VALUES = ("xcpcio", "rankland", "rankland-index", "rankland-refs", "srk")

def _selftest_synth() -> tuple[list[str], int]:
    """
    自测**合成节点**的产出机制（`Crate.synth()` / `ownerSynth` / `父synthKey` + 校验器）。

    组织方式与 `selftest` 的主用例一致（**构造 → 校验**），区别只是这里要同时跑
    "该过的必须过"和"该拒的必须拒"，所以失败项逐条收集后一次性返回。
    `该拒的`一律用 `ValueError`（构造器）/ 非空 `issues`（校验器）判定。

    @returns `(失败说明列表, 断言条数)`
    """
    fails: list[str] = []
    checks = [0]          # 可变计数器：每条断言 +1（返回真实条数，别手写数字）

    def has(issues: list[str], needle: str) -> bool:
        return any(needle in it for it in issues)

    def clean(label: str, data: dict, tree_synth=None, tree_ids=None) -> None:
        checks[0] += 1
        got = validate_crate(data, None, tree_synth, tree_ids)
        if got:
            fails.append(f"{label}：本该通过，却报了 {len(got)} 个问题 —— " + "；".join(got))

    def complains(label: str, data: dict, needle: str,
                  tree_synth=None, tree_ids=None) -> None:
        checks[0] += 1
        got = validate_crate(data, None, tree_synth, tree_ids)
        if not got:
            fails.append(f"{label}：本该报错，却通过了")
        elif not has(got, needle):
            fails.append(f"{label}：报错了，但没有 {needle!r} —— " + "；".join(got))

    def refused(label: str, build, needle: str) -> None:
        checks[0] += 1
        try:
            build()
        except ValueError as exc:
            if needle not in str(exc):
                fails.append(f"{label}：拒绝了，但文案里没有 {needle!r}：{exc}")
        except Exception as exc:                       # noqa: BLE001 — 自测要看见任何异常
            fails.append(f"{label}：抛了非 ValueError 的异常 {exc!r}")
        else:
            fails.append(f"{label}：本该被拒绝，却通过了")

    def new_crate() -> "Crate":
        return Crate(source_id="selftest-synth", label="合成自测")

    def base() -> dict:
        """一份合法包：合成节点（P）+ 一个成员（P，同类型）+ 一条成员指针。"""
        c = new_crate()
        c.platform("qoj", name="QOJ")
        c.series("qoj", "qoj:contest", name="QOJ Contest")
        c.contest("qoj:contest", "qoj:4113", name="Round 4113")
        c.problem("qoj:4113", "qoj:4113:20236", name="All Closed")
        c.synth("synth:1", "P", parent="qoj:4113", name="All Closed（合并）")
        c.problem("qoj:4113", "qoj:4113:20237", name="All Closed（另一场）",
                  owner_synth="synth:1")
        return c.to_dict()

    # ---------- ① 合法：合成节点 + 成员指针 ----------
    clean("合法合成包（合成 P + 同类型成员）", base())

    # ② 位置：`父synthKey`（父是合成节点）也要能过 —— **两种写法都是机制**
    nested = base()
    nested["records"].append({
        "节点类型": "R", "synthKey": "synth:2", "父synthKey": "synth:1",
        "name": "子提交", "time": "2026-09-29 10:00", "status": "AC",
    })
    clean("父synthKey 指向包内合成节点", nested)

    # ③ 位置：引用**树上**的合成节点/合成标识也必须能解析（tree 参数）
    tree = new_crate()
    tree.platform("qoj", name="QOJ")
    tree.series("qoj", "qoj:s", name="S")
    tree.contest("qoj:s", "qoj:c1", name="C1")
    tree.contest("qoj:s", "qoj:c2", name="C2", owner_synth="synth:tree")
    tree.synth("synth:tr", "R", parent_synth="synth:tree", name="树上合成父",
               time="2026-09-29 10:00", status="AC")
    clean("引用树上的合成标识（tree_synth_keys）", tree.to_dict(),
          tree_synth={"synth:tree"})

    # ---------- ② 身份键 ----------
    no_identity = base()
    no_identity["records"].append({"节点类型": "P", "name": "没身份"})
    complains("extKey 与 synthKey 都空", no_identity, "没有身份键")
    refused("构造器：extKey 与 synthKey 都空",
            lambda: new_crate()._add({"节点类型": "P", "name": "x"}),
            "不能同时为空")

    both = base()
    both["records"].append({"节点类型": "P", "extKey": "qoj:x", "synthKey": "synth:7",
                            "name": "两个身份"})
    complains("extKey 与 synthKey 同时给", both, "同时带")
    refused("构造器：extKey 与 synthKey 同时给",
            lambda: new_crate()._add({"节点类型": "P", "extKey": "a", "synthKey": "b",
                                      "name": "x"}),
            "不能两者都有")

    # ---------- ③ 合成类型只允许 C / P / R ----------
    for bad_type, label in (("W", "平台"), ("S", "系列"), ("O", "超级根")):
        bad = base()
        bad["records"].append({"节点类型": bad_type, "synthKey": f"synth:{bad_type}",
                               "name": f"{label}合成"})
        complains(f"{bad_type}（{label}）不能合成", bad, "不能合成")
        refused(f"构造器：{bad_type}（{label}）不能合成",
                lambda t=bad_type: new_crate().synth("synth:w", t, name="x"),
                "不能合成")

    # ---------- ④ synthKey 包内重复 ----------
    dup = base()
    dup["records"].append({"节点类型": "P", "synthKey": "synth:1", "name": "重复标识"})
    complains("synthKey 包内重复", dup, "包内 synthKey 重复")

    def _dup_builder():
        c = new_crate()
        c.synth("synth:1", "P", parent="qoj", name="A")
        c.synth("synth:1", "P", parent="qoj", name="B")

    refused("构造器：synthKey 重复", _dup_builder, "synthKey 重复")

    # ---------- ⑤ 成员指针 ----------
    dangling = base()
    dangling["records"][-1]["ownerSynth"] = "synth:404"
    complains("ownerSynth 悬空", dangling, "悬空成员指针")

    as_ext = base()
    as_ext["records"][-1]["ownerSynth"] = "qoj:4113"
    complains("ownerSynth 写成 extKey", as_ext, "不是合成标识")

    as_id = base()
    as_id["records"][-1]["ownerSynth"] = "n42"
    complains("ownerSynth 写成节点 id", as_id, "写的是**节点 id**", tree_ids={"n42"})

    mismatch = base()
    mismatch["records"].append({"节点类型": "C", "extKey": "qoj:9999",
                                "父extKey": "qoj:contest", "name": "另一场比赛",
                                "ownerSynth": "synth:1"})
    complains("成员与合成节点类型不同", mismatch, "必须同类型")

    nested_owner = base()
    nested_owner["records"].append({"节点类型": "P", "synthKey": "synth:8",
                                    "name": "合成套合成", "ownerSynth": "synth:1"})
    complains("合成节点不能有 ownerSynth", nested_owner, "不能有")

    # ---------- ⑥ 父引用 ----------
    both_parents = base()
    both_parents["records"].append({
        "节点类型": "R", "extKey": "qoj:sub:1", "父extKey": "qoj:4113:20236",
        "父synthKey": "synth:1", "name": "两个父", "time": "2026-09-29 10:00",
        "status": "AC",
    })
    complains("父extKey 与 父synthKey 同时给", both_parents, "父引用只能给一个")
    refused("构造器：父引用两个都给",
            lambda: new_crate().synth("synth:x", "P", parent="a", parent_synth="b",
                                      name="x"),
            "只能给一个")

    bad_parent = base()
    bad_parent["records"].append({
        "节点类型": "R", "synthKey": "synth:9", "父synthKey": "synth:404",
        "name": "父找不到", "time": "2026-09-29 10:00", "status": "AC",
    })
    complains("父synthKey 两边都没有", bad_parent, "父节点两边都没有")

    # ---------- ⑦ 合成节点必须有名字 ----------
    nameless = base()
    nameless["records"].append({"节点类型": "P", "synthKey": "synth:10"})
    complains("合成节点缺 name", nameless, "没有 name")
    refused("构造器：合成节点缺 name",
            lambda: new_crate().synth("synth:11", "P", parent="qoj"),
            "缺少必填列")

    return fails, checks[0]


# ================================================================
# selftest：「性质」四字段（受控词表的校验口径）
# ================================================================

def _selftest_nature() -> tuple[list[str], int]:
    """
    自测 `nature_fields()` 与三个受控词表：**该过的过、该拒的拒**。

    为什么要有：这份词表是**爬虫侧唯一写 nature 的入口** —— 词表写错（少一个值）
    或校验写松（把 `26` 当成年份），产出的包会被应用侧静默收下，
    现象要等到判重页筛不出东西才暴露。所以在这里当场钉住。
    """
    fails: list[str] = []
    checks = 0

    def ok(cond: bool, what: str) -> None:
        nonlocal checks
        checks += 1
        if not cond:
            fails.append(what)

    def refused(what: str, fn, needle: str) -> None:
        nonlocal checks
        checks += 1
        try:
            got = fn()
        except ValueError as exc:
            if needle not in str(exc):
                fails.append(f"{what}：报错里没有 {needle!r}，实际 {str(exc)!r}")
            return
        fails.append(f"{what}：本该 raise ValueError，却返回了 {got!r}")

    # ---------- ① 注册表本身：字段三个 + Trie 的根就是那七支 ----------
    ok(set(NATURE_FIELDS) == {"natureClass", "natureYear", "natureSeason", "natureRegion"},
       f"性质字段必须正好是 分类/年份/赛季/地区，实际 {sorted(NATURE_FIELDS)}")
    ok(NATURE_FIELDS["natureClass"][0] == "分类", "分类的界面文案就叫「分类」")
    roots = set(CLASS_TRIE)
    for root in ("xcpc", "cf", "atcoder", "qoj", "nk", "hdu", "pta"):
        ok(root in roots, f"分类 Trie 缺一支 {root!r}")
    for collected in COLLECTOR_VALUES:
        ok(collected not in roots,
           f"收集源 / 榜单 {collected!r} 不是分类，不该是 Trie 的根")
    # 这些路径必须都在（写死成断言：改注册表时漏掉哪一条会当场红）
    for path in ("xcpc/icpc/ec/pre", "xcpc/icpc/ec/regional", "xcpc/icpc/ec/final",
                 "xcpc/icpc/ec/无归类", "xcpc/ccpc/pre", "xcpc/ccpc/regional",
                 "xcpc/ccpc/final", "xcpc/ccpc/无归类", "xcpc/ccpc/female",
                 "xcpc/ccpc/vocational", "xcpc/provincial&invitational",
                 "xcpc/icpc/eu", "xcpc/icpc/ap", "xcpc/icpc/aa", "xcpc/icpc/aw",
                 "xcpc/icpc/la", "xcpc/icpc/na", "xcpc/icpc/ne", "xcpc/无归类",
                 "cf/contest/div1", "cf/contest/div2", "cf/contest/div3", "cf/contest/div4", "cf/contest/div1+2", "cf/contest/edu",
                 "cf/contest/others/team", "cf/contest/others/april", "cf/contest/others/kotlin", "cf/contest/others/无归类",
                 "atcoder/arc", "atcoder/abc", "atcoder/agc", "atcoder/无归类",
                 "nk/多校", "hdu/多校", "qoj/无归类",
                 # qoj/ucup（Universal Cup 单独一支，年份=QOJ 端时间、赛季=无）
                 "qoj/ucup",
                 # 每一支再分 official / warm-up（`无归类` 不带这一层）
                 # 省赛/邀请赛那支再细分：**正交化成 4×3 = 12 类**
                 # （`…/provincial&invitational/<IC&CC|IC|CC|无>/<省赛暨邀请赛|省赛|邀请赛>/<official|warm-up>`）
                 "xcpc/icpc/ec/final/official", "xcpc/icpc/ec/final/warm-up",
                 "xcpc/ccpc/final/official", "xcpc/ccpc/final/warm-up",
                 "xcpc/provincial&invitational/无/省赛/official",
                 "xcpc/provincial&invitational/无/省赛/warm-up",
                 "xcpc/provincial&invitational/IC/省赛暨邀请赛/official",
                 "xcpc/provincial&invitational/CC/邀请赛/warm-up",
                 "xcpc/provincial&invitational/IC&CC/邀请赛/official",
                 "qoj/xcpc/provincial&invitational/无/省赛/official",
                 "qoj/xcpc/icpc/ec/final/warm-up", "qoj/xcpc/ccpc/regional/official"):
        ok(is_known_class_path(path), f"分类路径 {path!r} 必须在 Trie 里")
    ok(not is_known_class_path("xcpc/provincial&invitational/official")
       and not is_known_class_path("xcpc/provincial&invitational/无归类/official"),
       "⚠️ 省赛那支**不是**「叶子 + official/warm-up」：中间必须夹**主办 + 类型**两层"
       "（`无归类` 也不带这一层）")
    ok(not is_known_class_path("xcpc/provincial&invitational/省赛/official")
       and not is_known_class_path("xcpc/provincial&invitational/IC邀请赛/official"),
       "⚠️ 不能出现「叶子直接接 official/warm-up」的写法"
       "（`…/省赛/official` / `…/IC邀请赛/…` 都非法）—— "
       "主办已独立成一轴，路径里必须写成 `<主办>/<类型>`")
    ok("xcpc/icpc/ec/region" not in class_paths() and "xcpc/ccpc/region" not in class_paths(),
       "⚠️ 阶段名必须写成 `regional`（`region` 非法）")
    ok(not is_known_class_path("xcpc/icpc/ec/无归类/official"),
       "⚠️ `无归类` **不分** official/warm-up（它没有「正式/热身」之分）")
    # 方案 = "每个阶段叶子下再分 official/warm-up"：
    # Trie 里"孩子恰好是 {official, warm-up}"的父节点必须**逐个**等于 `xcpc_common.PHASED_LEAVES`
    # （那是分类器里写死的一份清单 —— 两边不一致就会出现"Trie 有这一层、脚本却不写"或反之）。
    _phased = []
    for _p in class_paths():
        _walk = CLASS_TRIE
        for _seg in _p.split(CLASS_SEP):
            _walk = _walk[_seg]
        if set(_walk) == {"official", "warm-up"}:
            _phased.append(_p)
    ok(len(_phased) == 123,
       f"Trie 里「再分 official/warm-up」的节点应有 123 个"
       f"（xcpc 41 + qoj 镜像 41 + cf/gyms 镜像 41；"
       f"41 = icpc 八赛区×3 阶段 24 + ccpc 5 + 省赛那支 **4 主办 × 3 类型 = 12**），"
       f"实际 {len(_phased)}")
    # qoj 下面**镜像整棵 xcpc 子树**（"将 xcpc 的分类复制到 qoj 下"）
    _paths = set(class_paths())
    _xcpc = {p for p in _paths if p == "xcpc" or p.startswith("xcpc/")}
    _missing = sorted(("qoj/" + p) for p in _xcpc if ("qoj/" + p) not in _paths)
    ok(not _missing, f"qoj 下面必须镜像 xcpc 的整棵子树（缺：{_missing[:5]}）")
    ok(set(class_paths()) == {p for p in class_paths()}, "展平出来的路径不许重复")

    # ---------- ② 该过的：合法路径（**任何前缀都合法**）+ 三个字段齐全 ----------
    ok(nature_fields(("natureClass", "xcpc/icpc/ec/pre")) == {"natureClass": "xcpc/icpc/ec/pre"},
       "深路径应原样收下")
    ok(nature_fields(("natureClass", ["xcpc", "icpc", "ec", "final"]))["natureClass"]
       == "xcpc/icpc/ec/final", "**列表形态**也要收（有序字符串列表 ⇔ `/` 串）")
    for prefix in ("xcpc", "xcpc/icpc", "xcpc/icpc/ec"):
        ok(nature_fields(("natureClass", prefix))["natureClass"] == prefix,
           f"前缀 {prefix!r} 本身就是合法值（'停在哪一层'是信息）")
    ok(nature_fields(("natureClass", "cf/contest/others/无归类"))["natureClass"] == "cf/contest/others/无归类",
       "`无归类` 是合法叶子（= 「无」）")
    full = nature_fields(("natureClass", "xcpc/icpc"), ("natureYear", "2025"),
                         ("natureSeason", "2024"), ("natureRegion", "上海"))
    ok(full == {"natureClass": "xcpc/icpc", "natureYear": "2025",
                "natureSeason": "2024", "natureRegion": "上海"},
       f"四个字段应原样收下，实际 {full!r}")
    ok(nature_fields(("natureYear", "2025")) != nature_fields(("natureSeason", "2025")),
       "年份与赛季是**两个**字段（跨年赛事两个值不同）")
    # 占位取值：两个字段都能写（"以后有用"）
    for value in NATURE_PENDING_VALUES:
        ok(nature_fields(("natureYear", value))["natureYear"] == value
           and nature_fields(("natureSeason", value))["natureSeason"] == value,
           f"占位取值 {value!r} 两个字段都能写（= 处理过了、只是还没定）")
    ok(nature_fields(("natureSeason", NATURE_SEASON_NONE))["natureSeason"] == "无",
       "赛季的「不适用」= `无`（没有赛季概念的那些比赛：CF 正式轮次 / AtCoder）")
    ok(nature_fields(("natureYear", NATURE_YEAR_NONE))["natureYear"] == "无",
       "年份也允许 `无`（ucup 的年份也填无）")

    # ---------- ③ 该拒的：坏路径 / 坏年份 / 坏字段名 / 收集源 ----------
    refused("词表外的根", lambda: nature_fields(("natureClass", "codeforces")), "分类不合法")
    refused("不存在的下一层", lambda: nature_fields(("natureClass", "cf/nope")), "分类不合法")
    refused("叶子下面再挂", lambda: nature_fields(("natureClass", "cf/contest/div2/x")), "分类不合法")
    refused("年份写成两位", lambda: nature_fields(("natureYear", "26")), "20xx")
    refused("年份带后缀", lambda: nature_fields(("natureYear", "2025年")), "20xx")
    refused("赛季写成两位", lambda: nature_fields(("natureSeason", "26")), "20xx")
    refused("字段名写错", lambda: nature_fields(("nature", "xcpc")), "未知的性质字段")
    refused("字段名（大类）不是性质字段", lambda: nature_fields(("natureMain", "xcpc")), "未知的性质字段")
    refused("字段名（小类）不是性质字段", lambda: nature_fields(("natureSub", "icpc")), "未知的性质字段")

    # ---------- ④ 空值：丢掉、不占位（三个字段都可空） ----------
    ok(nature_fields(("natureClass", ""), ("natureYear", None), ("natureRegion", "  ")) == {},
       "空值一律丢掉（不留占位键）")
    only_class = nature_fields(("natureClass", "xcpc"), ("natureYear", ""),
                               ("natureSeason", None), ("natureRegion", None))
    ok(only_class == {"natureClass": "xcpc"}, f"只填分类时只有它留下，实际 {only_class!r}")

    # ---------- ④b 分类依据（元列 `分类依据`） ----------
    # 它是"这条分类凭什么判出来的"（规则 id），应用侧查级别表画徽标
    # （`src/core/natureConfidence.js` 的 `CLASS_RULE_LEVEL`）—— 形状与合法性在这里钉死。
    ok(CLASS_RULE_COL == "分类依据", "元列名要与应用侧（core/natureConfidence.js）一致")
    ok(class_rules(("natureClass", "qoj:path-icpc"))
       == {"分类依据": {"natureClass": "qoj:path-icpc"}}, "形状 = `{ 分类依据: { 字段: 规则id } }`")
    ok(class_rules(("natureClass", "")) == {}, "没有规则可记就不写这一列（不占位）")
    ok(class_rules(("natureClass", "  ")) == {} and class_rules() == {}, "空规则一律丢掉")
    ok(class_rule_problem("gym:infer-region") == "" and class_rule_problem("xcpc:name-stage") == "",
       "`<范围>:<规则>` 就是合法形状")
    for bad in ("", "  ", "没冒号", "QOJ:path-icpc", "qoj:path_icpc", "qoj:path icpc", ":x", "qoj:"):
        ok(class_rule_problem(bad) != "", f"坏规则 id {bad!r} 要被判出来")
    refused("规则 id 写错", lambda: class_rules(("natureClass", "没冒号")), "分类依据不合法")
    refused("规则 id 大写", lambda: class_rules(("natureClass", "QOJ:path-icpc")), "分类依据不合法")
    refused("规则挂到别的字段上", lambda: class_rules(("name", "qoj:path-icpc")), "未知的性质字段")

    # 归一（唯一产出点 `Crate._add`）：不留空壳、坏 id 当场炸
    probe = Crate(source_id="selftest")
    rec = {"节点类型": "C", "extKey": "x", "父extKey": "p",
           "分类依据": {"natureClass": "qoj:path-icpc", "name": "qoj:path-icpc", "natureYear": " "}}
    probe._normalize_class_rules(rec)
    ok(rec.get("分类依据") == {"natureClass": "qoj:path-icpc"},
       f"归一：只留性质字段 + 非空规则，实际 {rec.get('分类依据')!r}")
    empty = {"节点类型": "C", "extKey": "x", "父extKey": "p", "分类依据": {}}
    probe._normalize_class_rules(empty)
    ok("分类依据" not in empty, "归一后是空的 ⇒ 键删掉（不写空壳）")
    try:
        probe._normalize_class_rules({"分类依据": {"natureClass": "坏写法"}})
        fails.append("坏规则 id 过了归一（应当场炸）")
    except ValueError:
        pass
    checks += 1

    # ---------- ⑤ 辅助函数（筛选与界面都要用） ----------
    ok(class_path_of(" xcpc / icpc ") == ["xcpc", "icpc"], "拆路径只 trim，不做别名替换")
    ok(class_value_of(["xcpc", "icpc"]) == "xcpc/icpc", "拼回去用 `/`")
    ok(class_root_of("cf/contest/div2") == "cf" and class_root_of("") == "", "第一段 = 界面上的'一族'")
    ok(class_matches("cf/contest/div2", "cf") and class_matches("cf", "cf")
       and not class_matches("cf", "cf/contest/div2") and class_matches("xcpc", ""),
       "前缀匹配：选 `cf` 命中它下面所有更深的路径；反过来不成立；空前缀 = 全部")
    ok(class_path_problem("") == "" and not is_known_class_path(""),
       "空 = 合法（没标）但不算'登记过的值'")

    return fails, checks


# ================================================================
# selftest：适配器侧「性质」契约（`**nature_fields(...)` 进 Crate 之后长什么样）
# ================================================================
# 为什么要有（"原料处理脚本一定要给节点的性质归类"）：
# 各适配器（05 xcpc / 01 nk / 02 hdu）都是 `crate.contest(parent, key,
# name=…, **nature_fields(…))` 这个形状 —— 上面只钉了"注册表收不收"，
# **没钉"塞进构造器之后还在不在"**。Crate 的构造链上有一处专门吞 None/空串
# （`{k: v for k, v in extra.items() if v is not None}`），一旦哪天改成
# "白名单字段才透传"，性质就会被静默丢掉，而现象要等到判重页筛不出东西才暴露。
# ================================================================

# 各适配器写进 C 的**分类第一段**（注册表里 `classTrie` 的根）：来源 id → 根。
#
# ⚠️ 来源 id 里**不带** `xcpc-` 前缀（"直接去掉前缀"）——
#    那个前缀既是"05 xcpc 流水线"的记号、又和分类的根 `xcpc` 撞脸。
#    来源 id = `<渠道>[-<角色>]-<slug>`。
#
# 判据（整套口径见 `acm-data/raw/Scaper/05 xcpc/lib/xcpc_common.py` 的 `xcpc_nature()`）：
#   · **XCPC 赛系**（ICPC / CCPC / 省赛 / 邀请赛）→ `xcpc/…`。**收集源不是性质** ⇒
#     xcpcio / rankland(srk) / rankland-refs 那几棵树上的 C 同样写 `xcpc`。
#     PTA / 牛客**榜单**出的 C 也一样：那只是"数据从哪来"，比赛本身是 XCPC 的。
#   · **办赛平台**：CF → `cf/…`；AtCoder → `atcoder/…`；QOJ → `qoj/…`；
#     杭电流水线 → `hdu/…`；牛客流水线 → `nk/…`。
#   · 推不出归属的比赛写 `无归类`；**完全没判**才留空。

def _selftest_status() -> tuple[list[str], int]:
    """
    自测 `normalize_status()` —— 四个适配器共用的一份判题结果词表。

    由来（"nk 段错误 评测状态不被识别" → "能不能彻底一点"）：
    牛客的中文 `运行结果` 实测 508/1832 落 `-`，其中 468 条本该认得 ⇒ 词表补齐。四条口径：
      · 认得出的**都给码**：`编译错误 → CE`、`IDLENESS_LIMIT_EXCEEDED → ILE`（CF 交互题空转）、
        `CHALLENGED → HACK`、`PARTIAL → PC`、`Compiling/PENDING → PD`、`JUDGING → JG`；
      · **非空但认不出的**给**英文缩写**（`_abbrev_status`），**永不返回 `-`**（非空值一定要有码）；
      · **真的空**（没有判定）才留 `-` —— 这条是"空"与"认不出"的分界；
      · 枚举之外的值应用侧**淡灰**渲染，编辑弹窗会把它补进下拉选项（`G2_common.js`）。

    @returns `(失败说明列表, 断言条数)`
    """
    fails: list[str] = []
    checks = 0

    def ok(cond: bool, what: str) -> None:
        nonlocal checks
        checks += 1
        if not cond:
            fails.append(what)

    # 牛客那套中文 verdict（实测原样）
    for raw, want in (("运行超时", "TLE"), ("时间超时", "TLE"), ("超时", "TLE"),
                      ("段错误", "RE"), ("执行出错", "RE"), ("运行错误", "RE"), ("浮点错误", "RE"),
                      ("内存超限", "MLE"), ("输出超限", "OLE"),
                      ("答案正确", "AC"), ("通过", "AC"), ("满分", "AC"),
                      ("答案错误", "WA")):
        got = normalize_status(raw)
        ok(got == want, f"{raw!r} 应映射成 {want}，实际 {got!r}")
    # 英文那半边（大小写/下划线两种写法）
    for raw, want in (("OK", "AC"), ("Accepted", "AC"), ("WRONG_ANSWER", "WA"),
                      ("Time Limit Exceeded", "TLE"), ("RUNTIME_ERROR", "RE"),
                      ("Memory Limit Exceeded", "MLE"), ("Output Limit Exceeded", "OLE")):
        got = normalize_status(raw)
        ok(got == want, f"{raw!r} 应映射成 {want}，实际 {got!r}")
    # ⚠️ 边界一：认得出的一律给码（含 ILE / HACK / PC / PD / JG）
    for raw, want in (("编译错误", "CE"), ("编译失败", "CE"),
                      ("COMPILATION_ERROR", "CE"), ("Compilation Error", "CE"),
                      ("IDLENESS_LIMIT_EXCEEDED", "ILE"), ("Idleness limit exceeded", "ILE"),
                      ("CHALLENGED", "HACK"), ("PARTIAL", "P.AC"), ("PARTIAL_ACCEPTED", "P.AC"),
                      ("PC", "P.AC"), ("PAC", "P.AC"),
                      # QOJ 那种"一行多判定"（按测试点部分给分）⇒ 部分分（字面要 `P.AC`）
                      ("AC , WA", "P.AC"), ("AC, WA, TLE", "P.AC"), ("AC WA", "P.AC"),
                      ("Compiling", "PD"), ("PENDING", "PD"), ("Judging", "JG"),
                      ("等待评测", "PD"), ("编译中", "PD")):
        got = normalize_status(raw)
        ok(got == want, f"{raw!r} 应映射成 {want}，实际 {got!r}")
    # ⚠️ 边界二：**真的空**才留 `-`（"空"与"认不出"要分得开）
    for raw in (None, "", "   "):
        got = normalize_status(raw)
        ok(got == "-", f"{raw!r} 是空值，应留 '-'，实际 {got!r}")
    # ⚠️ 边界三：**非空但认不出的**给英文缩写，**绝不返回 `-`**（非空值一定要有，最好英文缩写）
    for raw, want in (("莫名其妙的结论", "莫名其妙的结"), ("Weird Verdict", "WV"),
                      ("BANANA", "BANA"), ("SOME_UNKNOWN_STATE", "SUS")):
        got = normalize_status(raw)
        ok(got == want, f"{raw!r} 认不出时该给缩写 {want}，实际 {got!r}")
        ok(got != "-", f"{raw!r} **非空**就不该是 '-'（实际 {got!r}）")
    # 已有的取值直通（不能被别名吃掉）——含 CE / ILE
    for raw in ("AC", "WA", "TLE", "RE", "MLE", "OLE", "CE", "ILE", "P.AC", "-",
                " ac ", "wa", "ce", "ile", "p.ac"):
        got = normalize_status(raw)
        ok(got == str(raw).strip().upper(), f"{raw!r} 应直通，实际 {got!r}")
    return fails, checks


def _crate_self_checks() -> tuple[list[str], int]:
    """
    自测"适配器写 nature 的那条路"：`**nature_fields(...)` → `Crate.contest()` → 记录。

    @returns `(失败说明列表, 断言条数)`
    """
    fails: list[str] = []
    checks = 0

    def ok(cond: bool, what: str) -> None:
        nonlocal checks
        checks += 1
        if not cond:
            fails.append(what)

    def contest_rec(**extra) -> dict:
        """在一个**临时内存 crate** 上建一个最小合法骨架，返回那条 C 记录（不落盘）"""
        c = Crate(source_id="selftest-nature", label="性质契约自测")
        c.platform("qoj", name="QOJ")
        c.series("qoj", "qoj:s", name="S")
        c.contest("qoj:s", "qoj:c1", name="C1", **extra)
        return c.records[-1]

    # ---------- ① 表里的根，每一个都能落到记录上（构造器不许中途吞掉） ----------
    ok(set(ADAPTER_CLASS_ROOT.values()) <= set(CLASS_TRIE),
       f"适配器写的根必须都在 Trie 里，多出来的："
       f"{sorted(set(ADAPTER_CLASS_ROOT.values()) - set(CLASS_TRIE))}")
    for root in ("xcpc", "cf", "atcoder", "qoj", "hdu", "nk", "pta"):
        rec = contest_rec(**nature_fields(("natureClass", root)))
        ok(rec.get("natureClass") == root,
           f"分类 {root!r} 经 Crate.contest() 之后没了（实际 {rec.get('natureClass')!r}）")

    # ---------- ② 收集源 / 榜单**不是**分类的根 ----------
    for bad in COLLECTOR_VALUES:
        try:
            nature_fields(("natureClass", bad))
        except ValueError:
            checks += 1
        else:
            checks += 1
            fails.append(f"{bad!r} 是收集源 / 榜单，不该被 nature_fields 收下")

    # ---------- ③ 三字段齐全时原样落到记录上 ----------
    full = contest_rec(**nature_fields(("natureClass", "xcpc/icpc/ec/pre"),
                                       ("natureYear", "2025"), ("natureRegion", "上海")))
    ok(full.get("natureClass") == "xcpc/icpc/ec/pre" and full.get("natureYear") == "2025"
       and full.get("natureRegion") == "上海",
       f"三个性质字段应原样落在 C 记录上，实际 {full!r}")

    # ---------- ④ 只填分类：**空值不许占位** ----------
    only_class = contest_rec(**nature_fields(("natureClass", "xcpc"), ("natureYear", None),
                                             ("natureRegion", "")))
    ok(only_class.get("natureClass") == "xcpc", "只填分类时分类必须还在")
    ok(not {"natureYear", "natureRegion"} & set(only_class),
       f"空值不许留下占位字段，实际 {sorted(only_class)}")

    # ---------- ④′ `normalize_time`：**只有时间没有日期的不当时刻**（`v9.4.15`） ----------
    # 病根（用户 2026-10-15 报的）：QOJ 场次页「提交时间」列给的是**比赛内相对时间** `00:31:01`，
    # 旧实现"认不出就原样返回" ⇒ 它一路穿到树上，P 的「AC时间」就显示成 `00:31:01`，
    # 而且**有值** ⇒ 体检那边"R.time 缺"不报，缺口连需求都不算（能藏几个月）。
    for raw in ("00:31:01", "2:05", "123:59:59", " 01:02 "):
        ok(normalize_time(raw) == "",
           f"只有时间没有日期的 {raw!r} 必须当**没有时刻**（实际 {normalize_time(raw)!r}）")
    for raw, want in (("2026-09-13 22:06:07", "2026.09.13 22:06:07"),
                      ("2026.09.13 22:06", "2026.09.13 22:06"),
                      ("20260913220607", "2026.09.13 22:06:07")):
        ok(normalize_time(raw) == want,
           f"正常时间写法一个字不许变：{raw!r} ⇒ {want!r}（实际 {normalize_time(raw)!r}）")

    # ---------- ⑤ save() 必须**原子**：写坏了不留半个文件、不留临时文件 ----------    # ⚠️ 中间文件写在**本目录**下，不要用 `tempfile.mkdtemp`：那种目录带 0700 ACL，
    #    在本仓库的沙箱里"文件写不进去、目录还删不掉"（同类坑在别处的自测里也出现过）。
    import os as _os
    here = _os.path.dirname(_os.path.abspath(__file__))
    path = _os.path.join(here, f"_selftest_save_{_os.getpid()}.json")
    try:
        good = Crate(source_id="selftest-save", label="落盘自测")
        good.platform("qoj", name="QOJ")
        good.save(path)
        before = open(path, encoding="utf-8").read()
        ok(before.endswith("}\n"), "save() 正常路径写得出来")
        ok([f for f in _os.listdir(here) if f.startswith("_selftest_save_")] ==
           [_os.path.basename(path)],
           f"落盘之后不许留临时文件，实际 {[f for f in _os.listdir(here) if f.startswith('_selftest_save_')]}")

        # 写一半必然失败（记录里塞一个 json 序列化不了的东西）⇒ 落盘失败时原文件必须一字不动
        bad = Crate(source_id="selftest-save", label="落盘自测")
        bad.platform("qoj", name="QOJ")
        bad.records.append({"节点类型": "C", "extKey": "x", "bad": {1, 2}})   # set 不能 JSON 序列化
        try:
            bad.save(path)
        except TypeError:
            checks += 1
        else:
            checks += 1
            fails.append("不可序列化的记录居然写成功了（这份自测的前提没了）")
        ok(open(path, encoding="utf-8").read() == before,
           "★ 写失败时原文件**一字不动**（直接覆盖写会留下半个 JSON，合并时被当正常输入读走）")
        ok([f for f in _os.listdir(here) if f.startswith("_selftest_save_")] ==
           [_os.path.basename(path)],
           f"失败路径也要清掉临时文件，实际 {[f for f in _os.listdir(here) if f.startswith('_selftest_save_')]}")
    finally:
        for f in _os.listdir(here):
            if f.startswith("_selftest_save_"):
                try:
                    _os.remove(_os.path.join(here, f))
                except OSError:
                    pass

    return fails, checks

def _selftest_adapters() -> tuple[list[str], int]:
    """
    自测 `ADAPTER_CLASS_ROOT` 这张"来源 → 分类根"表**与产出口径一致**（纯数据断言）。

    它挡的是这类错：把 PTA / 牛客**榜单**出来的 C 写成 `pta` / `nk`（那是"数据从哪来"，
    不是"比赛是哪一类的"），或者把 xcpcio / rankland / srk 这些收集源写成根。
    """
    fails: list[str] = []
    checks = 0

    def ok(cond: bool, what: str) -> None:
        nonlocal checks
        checks += 1
        if not cond:
            fails.append(what)

    for source, root in sorted(ADAPTER_CLASS_ROOT.items()):
        ok(root in CLASS_TRIE, f"来源 {source!r} 写的根 {root!r} 不在 Trie 里")
        ok(root not in COLLECTOR_VALUES, f"来源 {source!r} 把收集源 {root!r} 当成了分类根")
    # 具体钉几条最容易写错的（判据写在 xcpc_common.xcpc_nature 的注释里）
    ok(ADAPTER_CLASS_ROOT["xcpcio"] == "xcpc", "xcpcio 榜单上的场次是 XCPC 的")
    ok(ADAPTER_CLASS_ROOT["srk"] == "xcpc", "srk/rankland 榜单同理")
    ok(ADAPTER_CLASS_ROOT["pta"] == "xcpc", "PTA 榜单出的 C 是 XCPC 场次，不是 PTA 自己办的赛")
    ok(ADAPTER_CLASS_ROOT["nk"] == "xcpc", "牛客榜单出的 C 同理：别把收集渠道当性质")
    ok(ADAPTER_CLASS_ROOT["cf"] == "cf" and ADAPTER_CLASS_ROOT["cf-contest"] == "cf",
       "CF 正式比赛与 gym 都是 cf")
    ok(ADAPTER_CLASS_ROOT["atcoder"] == "atcoder", "AtCoder 用全称（与 Trie 的根一致）")
    ok(ADAPTER_CLASS_ROOT["qoj"] == "qoj" and ADAPTER_CLASS_ROOT["nk-scraper"] == "nk"
       and ADAPTER_CLASS_ROOT["hdu-scraper"] == "hdu",
       "QOJ / 牛客 / 杭电各写自己那一支")
    ok(not any(str(k).startswith("xcpc-") for k in ADAPTER_CLASS_ROOT),
       "来源 id 里不带 `xcpc-` 前缀（它既像流水线名又像分类的根）")

    # ---- 元列 `分类依据` 也要能**原样落进记录** ----
    # 与 `nature_fields` 走同一条通道（`Crate.contest` 的 `**extra`）—— 哪天被改成
    # "白名单字段才透传"，这一列会被静默丢掉，而现象要等到界面上一个徽标都不画才暴露。
    probe = Crate(source_id="selftest")
    probe.platform("probe", name="探针")
    probe.series("probe", "probe:s", name="系列")
    probe.contest("probe:s", "probe:c", name="比赛",
                  **nature_fields(("natureClass", "xcpc")),
                  **class_rules(("natureClass", "xcpc:name-stage")))
    prec = [r for r in probe.to_dict()["records"] if r["节点类型"] == "C"][0]
    ok(prec.get("分类依据") == {"natureClass": "xcpc:name-stage"},
       f"分类依据要原样落进记录，实际 {prec.get('分类依据')!r}")
    ok(prec.get("natureClass") == "xcpc",
       "性质字段与分类依据能同时写（两份 `**` 展开互不吃掉）")

    # ---- ★ 跨语言对拍：**可写字段白名单**与 JS 那份逐字相等 ----
    # 为什么要对拍：这份清单在 Python 里**只能手抄**（JS 那份是 `importableElements()`
    # 派生的，真源是 `core/model/elements.js`）—— 加字段时漏了一边就会出现
    # "适配器写了、校验器却说会被当作未使用字段"（现象很闷：值静默不进节点）。
    # 判据只有一份：这里**把清单交给 JS 自己报**（import 真模块），Python 不解析源码、
    # 也不复制那份派生规则。
    from crate import WRITABLE_FIELDS
    js_fields, why = _js_writable_fields()
    if js_fields is None:
        ok(False, f"问不到 JS 的可写字段清单：{why}")
    else:
        only_py = sorted(set(WRITABLE_FIELDS) - set(js_fields))
        only_js = sorted(set(js_fields) - set(WRITABLE_FIELDS))
        ok(not only_py and not only_js,
           f"可写字段两边必须一致：只有 Python 有的 {only_py}；只有 JS 有的 {only_js}"
           f"（真源 core/model/elements.js 的 importable: true）")
    return fails, checks


def _js_writable_fields():
    """
    问 JS 侧要**可写字段白名单**（`features/AutoImport/constants.js` 的 `WRITABLE_FIELDS`）。

    ⚠️ **不解析 JS 源码**（那张表是派生的：`importableElements()` 按
    `core/model/elements.js` 的 `importable: true` 收）—— 在 Python 里照抄一份派生规则
    等于又立一份判据。直接 `import` 真模块问它。

    @returns `(fields, why)`：`fields` 是字段名列表；拿不到答案时 `fields` 为 `None`、`why` 说明原因
    """
    import json
    import os
    import subprocess

    repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    target = os.path.join(repo, "src", "features", "AutoImport", "constants.js")
    if not os.path.isfile(target):
        return None, f"找不到 {target}"
    js = (
        "const { pathToFileURL } = require('node:url');"
        f"import(pathToFileURL({json.dumps(target)}).href).then(m => {{"
        "  process.stdout.write(JSON.stringify(m.WRITABLE_FIELDS));"
        "}).catch(e => { process.stderr.write(String(e && e.message || e)); process.exit(3); });"
    )
    try:
        proc = subprocess.run(["node", "-e", js], cwd=repo, capture_output=True,
                              # ⚠️ 读孩子必须显式给 encoding（2026-10-18）：`text=True` 不带它时按
                              #    `locale.getpreferredencoding()` 解码；关掉 Windows「UTF-8 Beta」后
                              #    是 936(GBK)，而孩子写的是 UTF-8 ⇒ `UnicodeDecodeError`。
                              text=True, encoding='utf-8', errors='replace', timeout=60)
    # ⚠️ `TimeoutExpired` **不是** `OSError` 的子类（实测）⇒ 必须单独捕，否则超时直接抛栈
    except subprocess.TimeoutExpired:
        return None, "node 跑了 60 秒没结束（超时）"
    except OSError as err:
        return None, f"跑不了 node：{err}"
    if proc.returncode != 0:
        return None, f"node 退出码 {proc.returncode}：{(proc.stderr or '').strip()[:200]}"
    # ⚠️ 空输出 + 退出码 0 ≠ "一条都不缺"：那是"没问到答案"（静默通过最难发现）
    if not (proc.stdout or "").strip():
        return None, "node 什么都没输出（没法判断可写字段清单）"
    try:
        return json.loads(proc.stdout), ""
    except ValueError as err:
        return None, f"读不懂 node 的输出（{err}）：{(proc.stdout or '')[:200]}"


# ================================================================
# CLI
# ================================================================
