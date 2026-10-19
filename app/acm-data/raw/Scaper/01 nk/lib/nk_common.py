#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
牛客（Nowcoder）工具的公共工具函数（**只有这里一份**）

和 HDU 那套（`02 hdu/lib/hdu_common.py`）是同一个套路，理由也一样：
这些函数若在几个脚本里各抄一份，改一处漏一处就会自相矛盾。

各脚本用下面这段把自己接上（在顶层和 lib/ 里都能用）：

    _HERE = os.path.dirname(os.path.abspath(__file__))
    sys.path.insert(0, _HERE if os.path.basename(_HERE) == 'lib'
                    else os.path.join(_HERE, 'lib'))
    from nk_common import read_json, write_json, ...

本文件**不 import 任何项目内模块**（只用标准库），所以谁 import 它都不会成环。
"""

from __future__ import annotations

import json
import os
import re
import sys

# ================================================================
# 链接
# ================================================================

# 题目/提交链接形如 https://ac.nowcoder.com/acm/contest/133877/A
CONTEST_RE = re.compile(r'/acm/contest/(\d+)(?:/([A-Za-z0-9]+))?')
# 采集时记下的真实比赛地址（collect-nk-problems.js 写在源文件头注释里）
CONTEST_URL_RE = re.compile(r'contestUrl=(\S+)')
# 比赛名：<h1> 里第一个 span（页面 <title> 是模板化的，没用）
H1_SPAN_RE = re.compile(r'<h1[^>]*>(.*?)</h1>', re.S)

def parse_link(link) -> tuple[str, str]:
    """
    题目/提交链接 → (cid, 字母题号)。

        https://ac.nowcoder.com/acm/contest/133877/A  →  ('133877', 'A')

    认不出返回 ('', '')。
    """
    m = CONTEST_RE.search('' if link is None else str(link))
    if not m:
        return '', ''
    return m.group(1) or '', (m.group(2) or '').upper()


def contest_name_of(html: str) -> str:
    """从题目页 HTML 的 <h1> 里取比赛名（取不到返回空串）"""
    m = H1_SPAN_RE.search(html or '')
    if not m:
        return ''
    for s in re.findall(r'<span[^>]*>(.*?)</span>', m.group(1), re.S):
        text = ' '.join(re.sub(r'<[^>]+>', '', s).split())
        # "原创/转载" 这类标记不是比赛名
        if text and text not in ('原创', '转载', '公开', '私有'):
            return text
    text = ' '.join(re.sub(r'<[^>]+>', ' ', m.group(1)).split())
    return text[:80]


# ================================================================
# 读 / 写 JSON
# ================================================================

def read_json(path: str):
    """
    读 JSON，容忍 BOM。
    BOM 是真实存在的坑：PowerShell 的 Set-Content 会加，手工存也可能加，
    而 json.load 遇到 BOM 会直接抛错。
    """
    with open(path, 'r', encoding='utf-8-sig', errors='replace') as f:
        return json.load(f)


def write_json(path: str, data):
    """写 JSON：UTF-8 无 BOM、缩进 2、保留中文、LF 行尾"""
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write('\n')


# ================================================================
# 文件名：流水线唯一的识别规则
# ================================================================
#
#     nk_cid<CID>_<种类>.json / .html
#     种类 = problems | submits | contest | rank_stats | rank | submit
#
# 位置无关（递归扫描），身份全在名字里。

_CANON_RE = re.compile(
    r'^nk_cid(\d+)_(problems|submits|contest|rank_stats|rank|submit)$', re.I)

# 名字里的种类 → 程序里用的 kind
KIND = {
    'problems': 'problems',
    'submits': 'submits',
    'contest': 'contest',        # 比赛身份旁挂（名字 / 真实 URL）
    'rank': 'rank',              # 完整榜单（fetch-nk-rank.js 的产出）
    'rank_stats': 'rankstats',   # 榜单统计（流水线产出）
    'submit': 'submitbundle',    # 提交页原件（collect-nk-submit.js 的多页包）
}


# `normalize_stem`（剥掉 `x (1)` 这种重复下载后缀）**只有一份**，在 `scripts/crate.py` ——
# 牛客与 HDU 的 lib 都从这里 re-export，避免各抄一份逐字相同的实现。这样调用方不变
# （`nk_pipeline.py` 是 `from nk_common import normalize_stem`）。
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), *(['..'] * 5), 'scripts')))
from crate import normalize_stem  # noqa: E402,F401


def identify(name: str) -> tuple[str, str]:
    """
    认一个文件名。

    @returns **(kind, cid)**；认不出返回 ('', '')。
             ⚠️ 顺序是 kind 在前 —— 调用方别写反（写反了会静默失效）。
    """
    stem, ext = os.path.splitext(name)
    if ext.lower() not in ('.html', '.json'):
        return '', ''
    stem = normalize_stem(stem)

    m = _CANON_RE.fullmatch(stem)
    if m:
        return KIND[m.group(2).lower()], m.group(1)
    return '', ''
