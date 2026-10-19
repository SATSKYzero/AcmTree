#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# py PTA_submissions_with_label.py
import json

RANKING_FILE = "PTA_rankings.json"
SUBMISSION_FILE = "team_submissions.json"
OUTPUT_FILE = "PTA_team_submissions_with_label.json"

# 判题状态映射表
STATUS_MAP = {
    "ACCEPTED": "AC",
    "WRONG_ANSWER": "WA",
    "TIME_LIMIT_EXCEEDED": "TLE",
    "MEMORY_LIMIT_EXCEEDED": "MLE",
    "RUNTIME_ERROR": "RE",
    "COMPILATION_ERROR": "CE",
    "PRESENTATION_ERROR": "PE",
    "OUTPUT_LIMIT_EXCEEDED": "OLE",
    "SYSTEM_ERROR": "SE",
    "PENDING": "PD",
    "JUDGING": "JG",
    "PARTIAL_ACCEPTED": "PC",
    "UNKNOWN": "UN",
}


def build_problem_label_map(ranking_file):
    with open(ranking_file, "r", encoding="utf-8") as f:
        data = json.load(f)
    problem_dict = data.get("xcpcRankings", {}).get("problemInfoByProblemSetProblemId", {})
    return {pid: info.get("label", "?") for pid, info in problem_dict.items()}


def process_submissions(submission_file, label_map):
    with open(submission_file, "r", encoding="utf-8") as f:
        data = json.load(f)

    submissions = data.get("submissions", [])

    new_submissions = []
    for s in submissions:
        pid = s.get("problemSetProblemId", "")
        raw_status = s.get("status", "")
        new_submissions.append({
            "submissionId": s.get("submissionId", ""),
            "submitAt": s.get("submitAt", ""),
            "status": STATUS_MAP.get(raw_status, raw_status),
            "题号": label_map.get(pid, "?"),
            "problemSetProblemId": pid
        })

    return new_submissions


if __name__ == "__main__":
    label_map = build_problem_label_map(RANKING_FILE)
    result = process_submissions(SUBMISSION_FILE, label_map)
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        f.write(json.dumps(result, ensure_ascii=False, indent=4))