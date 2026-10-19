#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
HDU 工具的公共工具函数（**只有这里一份**）

为什么要有这个文件：这些函数若在好几个脚本里各抄一份 ——
字母表 4 份、`add_prefix` 3 份、`cid_of` 2 份 —— 后果很直接：
字母上限改了一个文件、别处没改，就会变成"爬虫算出了字母、适配器却说算不出"。

所以：**凡是两个以上脚本要用的，都放这里**。
各脚本用下面这段把自己接上（在顶层和 lib/ 里都能用）：

    _HERE = os.path.dirname(os.path.abspath(__file__))
    sys.path.insert(0, _HERE if os.path.basename(_HERE) == 'lib'
                    else os.path.join(_HERE, 'lib'))
    from hdu_common import letter_of, ...

本文件**不 import 任何项目内模块**（只用标准库），所以谁 import 它都不会成环。
"""

from __future__ import annotations

import json
import os
import re
import sys

# ================================================================
# 字母题号
# ================================================================
#
# 1001..1020 → A..T。近十年实测至多 15 题，留到 20 以防万一。
# 越界**返回空串**，绝不瞎算字符：chr(ord('A') + (pid - 1001)) 这种写法
# 在 pid=1000 会给出 '@'、1027 给 '['，静默污染数据。
LETTER_BASE = 1001
LETTER_MAX = 20


def letter_of(pid) -> str:
    """数字题号 → 字母；超出 LETTER_BASE..LETTER_BASE+LETTER_MAX-1 返回空串"""
    try:
        n = int(str(pid).strip())
    except (TypeError, ValueError):
        return ''
    off = n - LETTER_BASE
    return chr(ord('A') + off) if 0 <= off < LETTER_MAX else ''


# ================================================================
# 链接
# ================================================================

CID_RE = re.compile(r'cid=(\d+)')
HDU_ORIGIN = 'https://acm.hdu.edu.cn'


def add_prefix(url: str) -> str:
    """HDU 页面里的链接是站内相对路径，补上域名"""
    if not url:
        return ''
    if url.startswith('//'):
        return 'https:' + url
    if url.startswith('/'):
        return HDU_ORIGIN + url
    return url


def cid_of_links(items, keys=('link', '题目链接', '提交链接')) -> str:
    """
    从一串记录的链接列里认出比赛 ID（`.../contest/problem?cid=1231&pid=1001`）。

    认不出返回空串 —— 调用方负责决定这是"跳过"还是"报错"。
    """
    for item in items if isinstance(items, list) else []:
        if not isinstance(item, dict):
            continue
        for k in keys:
            m = CID_RE.search(str(item.get(k) or ''))
            if m:
                return m.group(1)
    return ''


# ================================================================
# 读 JSON
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
#     hdu_cid<CID>_<种类>.json / .html     种类 = problems|submits|rank_stats|rank|submit
#     hdu_contests.json                    比赛列表（一份列表，本身没有 cid）
#
# 位置无关（递归扫描），身份全在名字里。

_CANON_RE = re.compile(r'^hdu_cid(\d+)_(problems|submits|rank_stats|rank|submit)$', re.I)
_LIST_RE = re.compile(r'^hdu_contests$', re.I)

# 名字里的种类 → 程序里用的 kind
KIND = {'problems': 'problems', 'submits': 'submits',
        'rank': 'rank', 'rank_stats': 'rankstats', 'submit': 'submitbundle'}


# `normalize_stem`（剥掉 `x (1)` / `x 副本` 这种重复下载后缀）**只有一份**，
# 在 `scripts/crate.py` —— 免得 HDU 与牛客的 lib 各抄一份逐字相同的实现。
# 这里 re-export 保持调用方不变（`hdu_pipeline.py` 一直是 `from hdu_common import normalize_stem`）。
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
    if ext.lower() == '.json' and _LIST_RE.fullmatch(stem):
        return 'contests', ''
    return '', ''


# ================================================================
# 哪一场算"多校"
# ================================================================
#
# 这件事**两处都要用**，所以只在这里写一份：
#   · 抓取侧 `hdu_multi_fetch.py` —— 决定默认抓哪几场；
#   · 出包侧 `hdu_adapter.py`     —— 决定挂到「杭电多校」还是「其他比赛」。
#
# ⚠️ 2026-10-17 实测踩到（用户看到 2021 的十场跑进「其他比赛」）：出包侧**自己又写了一遍**
#    规则、而且只认 `钉耙编程|暑期联赛|多校` ⇒ 2021「MINIEYE杯…超级联赛」判不中；
#    2022「杭电杯…超级联赛」还会先撞上"杭电"那条（跑进「杭电校赛」）。
#    ⇒ 凡是"哪一场算多校"的判断，都走 `is_multi_name()` / `multi_re()`。
#
# 名字**随年份变过**，别只认一种：2026/2025「钉耙编程…暑期联赛」、
# 2024/2023「钉耙编程…超级联赛」、2022「杭电杯…超级联赛」、
# 2021「MINIEYE杯…超级联赛」、2020/2019「Multi-University Training Contest」。
MULTI_WORDS = ('暑期联赛', '超级联赛', 'Multi-University', '多校')


def is_multi_name(name: str) -> bool:
    """赛名里出现多校那几个词之一（抓取侧 = 抓不抓；出包侧 = 挂哪个系列）"""
    low = str(name or '').lower()
    return any(w.lower() in low for w in MULTI_WORDS)


def multi_re() -> re.Pattern:
    """把 `MULTI_WORDS` 合成一个正则 —— 出包侧的系列规则直接用它，别再手写一遍"""
    return re.compile('|'.join(re.escape(w) for w in MULTI_WORDS), re.I)
