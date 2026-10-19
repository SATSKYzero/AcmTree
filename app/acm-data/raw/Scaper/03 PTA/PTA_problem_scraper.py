# 1.获取数据方式见图片
# 2.粘贴至PTA_rankings.html
# 终端输入指令:py PTA_problem_scraper.py
# 
#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import json

INPUT_FILE = "PTA_rankings.json"
OUTPUT_FILE = "PTA_problems.json"
TEAM_COUNT = 2486

def extract_problem_info(filepath):
    with open(filepath, "r", encoding="utf-8") as f:
        data = json.load(f)

    problem_dict = data.get("xcpcRankings", {}).get("problemInfoByProblemSetProblemId", {})
    if not problem_dict:
        raise ValueError("未找到题目信息")

    balloon_list = data.get("balloonSettings", [])
    balloon_map = {}
    for b in balloon_list:
        label = b.get("label")
        if label:
            balloon_map[label] = {
                "color": b.get("color", ""),
                "rgb": b.get("rgb", "")
            }

    result = []
    for pid, info in problem_dict.items():
        label = info.get("label", "")
        accept_count = info.get("acceptCount", 0)
        submit_count = info.get("submitCount", 0)

        if submit_count > 0:
            accept_rate = f"{accept_count}/{submit_count}"
            rate_percent = round(accept_count / submit_count * 100, 2)
        else:
            accept_rate = "0/0"
            rate_percent = 0.0

        first_accept = info.get("firstAcceptTeamFid", "0")
        first_accept_display = "无" if first_accept == "0" else first_accept

        balloon = balloon_map.get(label, {})
        color_name = balloon.get("color", "")
        color_rgb = balloon.get("rgb", info.get("balloonRgb", ""))

        result.append({
            "题号": label,
            "通过数": accept_count,
            "提交数": submit_count,
            "通过率": accept_rate,
            "AC率": accept_count/TEAM_COUNT,
            "通过率百分比": rate_percent,
            "气球颜色": color_name,
            "气球RGB": color_rgb,
            "首杀队伍FID": first_accept_display
        })

    result.sort(key=lambda x: x["题号"])
    return result


if __name__ == "__main__":
    data = extract_problem_info(INPUT_FILE)
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        f.write(json.dumps(data, ensure_ascii=False, indent=2))