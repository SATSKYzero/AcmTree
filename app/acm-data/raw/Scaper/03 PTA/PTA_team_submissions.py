#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
PTA 榜单 → **某一支队**的逐条提交（手工小工具）

怎么拿榜单（1 步）：
    浏览器打开 PTA 榜单页 → F12 → Network 里那次 `xcpc-rankings/public` 请求 →
    响应存成 `03 PTA/PTA_rankings.json`（就是本脚本默认读的那份）。

用法（**队伍必须你自己给**）：
    py PTA_team_submissions.py --team TEAM0          # 按队名找
    py PTA_team_submissions.py --rank 1              # 按名次找
    py PTA_team_submissions.py --team TEAM0 -o team_submissions.json
    py PTA_team_submissions.py --team TEAM0 --input PTA_rankings.json

⚠️ **这里没有"默认队伍"，也不该有**：哪支队是你，是个人信息 ——
   写死在脚本里等于把你的队名随仓库发出去（而且换一届就错）。
   管线那边同理：队名从 `me.json` 的账户映射来，可用
   `05 xcpc/pta_submissions_adapter.py --team` 临时覆盖。

输出形状 = `{ "total", "submissions": [...], "teamInfo": {...} }`
   —— `teamInfo` **原样保留**（队名/成员/学校）：适配器拿它核对"这份文件是哪支队"
   （`pta_submissions_adapter.py` 的队名名单）。逐题字段与 `PTA_rankings.json` 的
   `detailsByProblemSetProblemId` 一致，另附题号 label。
"""

import argparse
import json
import os
import sys

#: 读写都相对**本文件**所在目录（`03 PTA/`）—— 在仓库根敲同一条命令也不会读空
HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_INPUT = os.path.join(HERE, "PTA_rankings.json")
DEFAULT_OUTPUT = os.path.join(HERE, "PTA_team_submissions.json")


def build_problem_label_map(data):
    problem_dict = data.get("xcpcRankings", {}).get("problemInfoByProblemSetProblemId", {})
    return {pid: info.get("label", "?") for pid, info in problem_dict.items()}


def find_team(data, rank=None, team=None):
    """按名次或队名找那一项；找不到就抛（**不猜**）"""
    rankings = data.get("xcpcRankings", {}).get("rankings", [])
    if not rankings:
        raise ValueError("未找到 rankings 数据")
    if team:
        for item in rankings:
            if str((item.get("teamInfo") or {}).get("teamName") or "").strip() == team:
                return item
        raise ValueError(f"榜单里没有队名 = {team} 的队伍（换个写法，或用 --rank）")
    for item in rankings:
        if item.get("rank") == rank:
            return item
    raise ValueError(f"未找到 rank = {rank} 的队伍")


def extract_team_submissions(data, team):
    label_map = build_problem_label_map(data)
    details = team.get("detailsByProblemSetProblemId", {})
    submissions = []
    for pid, detail in details.items():
        label = label_map.get(pid, "?")
        accept_time = detail.get("acceptTime", -1)
        passed = accept_time >= 0
        submissions.append({
            "题号": label,
            "是否通过": passed,
            "通过时间(分钟)": accept_time if passed else None,
            "得分": detail.get("score", 0.0),
            "有效提交次数": detail.get("validSubmitCount", 0),
            "提交次数快照": detail.get("submitCountSnapshot", 0),
            "最后提交时间(分钟)": detail.get("lastSubmitAt", -1) if detail.get("lastSubmitAt", -1) >= 0 else None,
        })
    submissions.sort(key=lambda x: x["题号"])
    return submissions


def main(argv):
    ap = argparse.ArgumentParser(description="PTA 榜单 → 某一队的逐条提交")
    # 队伍二选一，**必填**：不给就报错，不替用户选
    ap.add_argument("--team", default="", help="队名（如 TEAM0）")
    ap.add_argument("--rank", type=int, default=None, help="名次（如 1）")
    ap.add_argument("--input", default=DEFAULT_INPUT, help="榜单 JSON（默认同目录的 PTA_rankings.json）")
    ap.add_argument("-o", "--output", default=DEFAULT_OUTPUT, help="输出（默认同目录的 PTA_team_submissions.json）")
    args = ap.parse_args(argv)

    if not args.team and args.rank is None:
        print("❌ 要说清是哪支队：`--team <队名>` 或 `--rank <名次>`"
              "（这里没有默认值 —— 队名是你的个人信息，不该写死在脚本里）", file=sys.stderr)
        return 2
    if not os.path.isfile(args.input):
        print(f"❌ 读不到榜单：{args.input}（先按文件头的说明存一份）", file=sys.stderr)
        return 1

    with open(args.input, "r", encoding="utf-8") as f:
        data = json.load(f)

    try:
        team = find_team(data, rank=args.rank, team=args.team.strip())
    except ValueError as e:
        print(f"❌ {e}", file=sys.stderr)
        return 1

    info = team.get("teamInfo") or {}
    submissions = extract_team_submissions(data, team)
    out = {
        "total": len(submissions),
        "submissions": submissions,
        # 原样保留：适配器用它核对"这份文件是哪支队"（队名/成员/学校都在这）
        "teamInfo": info,
    }
    with open(args.output, "w", encoding="utf-8") as f:
        f.write(json.dumps(out, ensure_ascii=False, indent=2))
    print(f'✅ {args.output}   队伍 {info.get("teamName") or "?"}（rank {team.get("rank")}）'
          f' ｜ {len(submissions)} 题')
    if not info.get("teamName"):
        print("   ⚠️ 榜单项里没有 teamInfo.teamName —— 适配器就只能靠 --team/me.json 认队名了")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
