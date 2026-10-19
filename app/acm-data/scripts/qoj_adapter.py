#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
qoj 适配器（**参考/教学模板**，不是生产链路）—— 把 qoj 原生导出转成 Acm_Tree 导入包

⚠️ **别拿它做正式导入**。正式链路是
`acm-data/raw/Scaper/05 xcpc/` 那条（`xcpc_pipeline.py` + `cf_adapter.py` / `qoj_adapter.py`），
它的 extKey 拼法是 `xcpc:c:<slug>:sub:qoj:<id>`、还带账户线索/运行信息/提交性质。
**本文件保留的价值只有两个**：
  1. **写新平台的模板**（整个文件是一份"照抄清单"，见文末《换平台要改哪几行》）；
  2. `npm run crate:sample:qoj` 产出的 `acm-data/merged/sample_qoj_crate.json`
     是 `docs/scraper-guide.md` 里那个"**最小可导入样例**"。
     （⚠️ 这个 npm 名字 2026-10-17 从 `crate:qoj` 改过来：原来它和生产入口挤在同一个命名空间里，
     容易让人以为"`crate:qoj` 就是正式那条"。）
因此它里面与正式链路不同的 extKey 拼法（`qoj:sub:<id>` 那套）**不用改**，改了反而毁掉示例。

用途
----
两件事：

1. **直接可用**：把你现有的 `qoj_problems.json` / `qoj_submissions.json`
   转成 crate，喂给应用的「📥 节点自动导入」。
   （应用其实内置了同样的适配器，所以你也可以直接把原始文件丢进应用——
     这个脚本的价值在于**你能在导入前看到并审查生成的 key**。）

2. **写别的平台时的模板**：整个文件就是一份"照抄清单"——
   见文末《换平台要改哪几行》。

关键设计
--------
- **extKey 拼法**（docs/auto-import.md 3.4）：

      平台    qoj                     ← 常量
      比赛分组 qoj:contest             ← 常量（qoj 无"系列"概念，
                                          但 W 下不能直接放 C，必须插这层）
      比赛    qoj:<contestId>         ← 从"题目链接"正则取 contest/<ID>
      题目    qoj:<contestId>:<题目ID> ← 用**平台稳定主键**，不用题号
      提交    qoj:sub:<提交ID>

  ⚠️ 题目刻意用 `题目ID`（如 20236）而不是题号（如 A）：
     题号是"比赛内位置"，改一次题面就可能变；变了就静默产生重复节点。

- **爬虫不写状态**：`是否通过` 一律不导入。应用的 `status2` / `acTime`
  从 R（提交记录）自动推导（docs/auto-import.md 7.6）。

用法
----
    # 转成 crate（比赛包 + 提交包各一个文件）
    python scripts/qoj_adapter.py problems  qoj_problems.json    -o out_problems.json
    python scripts/qoj_adapter.py submissions qoj_submissions.json -o out_submissions.json
    python scripts/qoj_adapter.py both qoj_problems.json qoj_submissions.json -o out_all.json

    # 转换后立刻离线自查（推荐）
    python scripts/crate.py validate out_problems.json

    # 想连"父节点是否已在树上"一起查，就把应用的导出 JSON 带上
    python scripts/crate.py validate out_submissions.json --tree my_export.json
"""

from __future__ import annotations

import json
import os
import re
import sys

# ---- 找到 crate.py（构造器） ----
# 两种情形都要能用：
#   1. 在本仓库里：脚本在 acm-data/scripts/，构造器在 ../../scripts/
#   2. 你把本文件抄进自己的项目：把 crate.py 放在同目录即可
_HERE = os.path.dirname(os.path.abspath(__file__))
_SEARCH = [
    _HERE,                                            # 同目录（抄走时的情形）
    os.path.join(_HERE, '..', '..', 'scripts'),       # 本仓库的 scripts/
    os.path.join(_HERE, '..', 'scripts'),
]
for _p in _SEARCH:
    _p = os.path.abspath(_p)
    if os.path.isfile(os.path.join(_p, 'crate.py')):
        sys.path.insert(0, _p)
        break
else:
    sys.exit('找不到 crate.py。请把它与本脚本放在同一目录，或从仓库的 scripts/ 下运行。')

from crate import (  # noqa: E402
    Crate,
    nature_fields,
    normalize_status,
    normalize_time,
    validate_crate,
)

# ================================================================
# 平台常量 —— 换平台主要改这里
# ================================================================

PLATFORM = "qoj"
PLATFORM_NAME = "QOJ"
# 比赛分组（S）：只为满足 W → S → C 的层级约束。qoj 本身没有"系列"概念。
GROUP_KEY = f"{PLATFORM}:contest"
GROUP_NAME = "QOJ Contest"

LABEL = "QOJ 爬虫"

# 从链接里取 ID
CONTEST_ID_RE = re.compile(r"contest/(\d+)")
PROBLEM_ID_RE = re.compile(r"problem/(\d+)")

# qoj 原生列名 → 内部字段（**仅供阅读参考，不参与转换**）
#
# 为什么不用它：本适配器用 `Crate` 的 problem()/submission() 构造记录，
# 写入的列名**已经是内部字段名**，构造器会自动登记恒等 fieldMap。
# 若把这些中文列名也塞进 fieldMap，它们和实际出现的列名对不上，
# 反而会在"未使用字段"报告里制造噪音。
#
# 保留这张表是为了说明 qoj 的列语义——**你要写别的平台时，
# 照着它把"你平台的列名"映射到"内部字段名"即可**（见文末清单）。
#
# 值 None 表示"身份输入列"（是 extKey 的来源，但不是节点字段）。
QOJ_COLUMN_MEANING = {
    "题号": "problemId",
    "题目名称": "name",
    "比赛名称": "name",
    "比赛时间": "contestTime",
    "题目链接": "link",
    "提交链接": "link",
    "结果": "status",
    "提交时间": "time",

    "题目ID": None,      # 题目 extKey 的来源
    "contestId": None,   # 比赛 extKey 的来源
    "提交ID": None,      # 提交 extKey 的来源

    # 刻意**不处理**：是否通过 / 得分 / 时间 / 内存 / 代码长度 / 提交者 / 用户主页
    # → 它们会成为"未使用字段"，在应用的导入记录里留下列名，
    #   方便你日后想把"内存"也存起来时，知道爬虫早就在给了。
}

# ================================================================
# extKey 构造
# ================================================================

def platform_key() -> str:
    return PLATFORM


def group_key() -> str:
    return GROUP_KEY


def contest_key(contest_id: str) -> str:
    return f"{PLATFORM}:{contest_id}"


def problem_key(contest_id: str, problem_id: str) -> str:
    return f"{PLATFORM}:{contest_id}:{problem_id}"


def submission_key(submission_id: str) -> str:
    return f"{PLATFORM}:sub:{submission_id}"


# ================================================================
# 小工具
# ================================================================

def _s(value) -> str:
    """取非空字符串（trim）"""
    if value is None:
        return ""
    return str(value).strip()


def extract_contest_id(link: str) -> str:
    m = CONTEST_ID_RE.search(_s(link))
    return m.group(1) if m else ""


def extract_problem_id_from_link(link: str) -> str:
    m = PROBLEM_ID_RE.search(_s(link))
    return m.group(1) if m else ""


def _is_submission(item: dict) -> bool:
    return "提交ID" in item


def _is_problem(item: dict) -> bool:
    return "题目ID" in item or "题号" in item


# ================================================================
# 主转换
# ================================================================

def build(items: list[dict], *, source_id: str = "qoj-scraper") -> tuple[Crate, list[str]]:
    """
    把 qoj 原生记录列表转成 crate。

    返回 (crate, warnings)。warnings 是**可导入但值得知道**的问题
    （例如某条缺 题目ID，只能退化成链接里的 problem/<ID>）。
    """
    crate = Crate(source_id=source_id, label=LABEL, platform=PLATFORM)
    # 不需要调用 map_column：Crate 构造器写入的列名就是内部字段名，
    # 它在初始化时已自动登记恒等映射（见 crate.py 的 Crate.__init__）。

    warnings: list[str] = []

    # 平台 + 比赛分组：无论输入是哪一种，都先把骨架搭好
    crate.platform(platform_key(), name=PLATFORM_NAME)
    crate.series(platform_key(), group_key(), name=GROUP_NAME)

    # 性质：本适配器出的 C 全部来自 QOJ ⇒ 大类恒为 `qoj`。
    # 小类/年份/地区**留空**：这份输入的列里没有分类链、没有开赛时间、没有地区，
    # 推不出来就留空（"空着比填错好"；不许写"未知"占位）。
    # ⚠️ 本脚本只有题目/提交两列（在用的一份是 `05 xcpc/qoj_adapter.py`）：
    #    那边有分类链与场次名，能多填一个年份；这一份只有题目/提交两列。
    QOJ_NATURE = nature_fields(('natureClass', platform_key()))

    # 第一遍：题目（连同它需要的比赛）
    for i, item in enumerate(items):
        if not isinstance(item, dict):
            warnings.append(f"第 {i} 条不是对象，已跳过")
            continue
        if _is_submission(item):
            continue
        if not _is_problem(item):
            warnings.append(f"第 {i} 条既不像题目也不像提交，已跳过")
            continue

        link = _s(item.get("题目链接"))
        contest_id = _s(item.get("contestId")) or extract_contest_id(link)
        if not contest_id:
            warnings.append(f"第 {i} 条（题号 {_s(item.get('题号'))}）："
                            "链接里找不到 contest/<ID>，无法定位比赛 → 该条会被应用拒绝")
            continue

        problem_id = _s(item.get("题目ID")) or extract_problem_id_from_link(link)
        if not problem_id:
            warnings.append(f"第 {i} 条（题号 {_s(item.get('题号'))}）："
                            "题目ID 缺失且链接里没有 problem/<ID> → 该条会被应用拒绝")
            continue

        # 比赛（懒创建：同一个 contestId 只会建一次，由 Crate 去重）
        ck = contest_key(contest_id)
        if ck not in crate._emitted:
            crate.contest(group_key(), ck, name="", **QOJ_NATURE)

        crate.problem(
            ck,
            problem_key(contest_id, problem_id),
            name=_s(item.get("题目名称")),
            problem_id=_s(item.get("题号")),
            link=link,
        )

    # 第二遍：提交记录（会顺带补出它需要的比赛/题目，避免"父节点两边都没有"）
    for i, item in enumerate(items):
        if not isinstance(item, dict) or not _is_submission(item):
            continue

        submission_id = _s(item.get("提交ID"))
        if not submission_id:
            warnings.append(f"第 {i} 条：提交ID 为空 → 算不出 extKey，该条会被拒绝")
            continue

        link = _s(item.get("题目链接"))
        contest_id = _s(item.get("contestId")) or extract_contest_id(link)
        problem_id = _s(item.get("题目ID")) or extract_problem_id_from_link(link)
        if not contest_id or not problem_id:
            warnings.append(f"第 {i} 条（提交 {submission_id}）："
                            "定位不到父题目（缺 contest/<ID> 或 problem/<ID>）"
                            "→ 该条会被拒绝")
            continue

        ck = contest_key(contest_id)
        if ck not in crate._emitted:
            crate.contest(group_key(), ck, name="", **QOJ_NATURE)

        pk = problem_key(contest_id, problem_id)
        if pk not in crate._emitted:
            # 提交包里没有题目详情，就先用已有的题号/题名把父题目建出来
            crate.problem(
                ck, pk,
                name=_s(item.get("题目名称")),
                problem_id=_s(item.get("题号")),
                link=link,
            )

        crate.submission(
            pk,
            submission_key(submission_id),
            status=normalize_status(item.get("结果")),
            time=normalize_time(item.get("提交时间")),
            link=_s(item.get("提交链接")),
        )

    return crate, warnings


def load_json(path: str) -> list[dict]:
    with open(path, "r", encoding="utf-8-sig") as fh:
        data = json.load(fh)
    if isinstance(data, dict):
        for key in ("problems", "submissions", "records"):
            if isinstance(data.get(key), list):
                return data[key]
    if not isinstance(data, list):
        raise ValueError(f"{path} 不是数组，也不是含 problems/submissions 的对象")
    return data


# ================================================================
# CLI
# ================================================================

def _cli(argv: list[str]) -> int:
    import argparse

    p = argparse.ArgumentParser(description="把 qoj 原生导出转成 Acm_Tree 导入包")
    p.add_argument("mode", choices=("problems", "submissions", "both"),
                   help="problems=题目包；submissions=提交包；both=合并成一个包")
    p.add_argument("inputs", nargs="+", help="qoj 原生 JSON 路径")
    p.add_argument("-o", "--out", required=True, help="输出的 crate JSON 路径")
    p.add_argument("--source-id", default="qoj-scraper", help="导入记录里的来源标识")
    args = p.parse_args(argv)

    if args.mode != "both" and len(args.inputs) != 1:
        print("非 both 模式只需一个输入文件", file=sys.stderr)
        return 2

    items: list[dict] = []
    for path in args.inputs:
        items.extend(load_json(path))

    crate, warnings = build(items, source_id=args.source_id)

    data = crate.to_dict()
    issues = validate_crate(data)

    crate.save(args.out)
    print(f"✅ 已写出 {args.out}")
    print(f"   {crate.summary()}")

    if warnings:
        print(f"\n⚠️  {len(warnings)} 条转换期警告：")
        for w in warnings:
            print("   •", w)

    if issues:
        print(f"\n❌ 校验发现 {len(issues)} 个问题（导入时可能被拒）：")
        for it in issues:
            print("   •", it)
        return 1

    print("\n下一步：")
    print(f"   python scripts/crate.py validate {args.out}")
    print("   然后把该文件拖进应用的「📥 节点自动导入」")
    return 0


if __name__ == "__main__":
    sys.exit(_cli(sys.argv[1:]))


# ================================================================
# 换平台要改哪几行
# ================================================================
#
#  1. 顶部常量：PLATFORM / PLATFORM_NAME / GROUP_KEY / GROUP_NAME / LABEL
#  2. FIELD_MAP：把你平台的列名映射到内部可写字段
#     （可写字段：name problemId cfDifficulty ratio link tags contestTime time status）
#     派生字段（status1/status2/acTime/lastSubmitTime/xcpcDifficulty）**不要映射**
#  3. 三个 *_key 函数：定 extKey 拼法。要点：
#       - 用**平台稳定主键**，不要用题号/标题（它们会变）
#       - 层级前缀 = 父的 key + ":"，便于肉眼核对
#       - 提交段加 `sub:` 之类的前缀，避免与纯数字比赛 ID 撞
#  4. extract_*_id：你的平台从哪个字段/链接取 ID
#  5. build() 里"哪些记录是题目、哪些是提交"的判定（_is_submission）
#  6. 如果平台**有**系列概念，把 GROUP_KEY 换成真实的系列 key，
#     并在 build() 里按系列分组建 S —— 这样层级会更贴近语义
#
#  transform 完务必跑一次：
#       python scripts/crate.py validate <输出.json>
#  再对照 docs/auto-import.md 第 7 节确认字段语义。
