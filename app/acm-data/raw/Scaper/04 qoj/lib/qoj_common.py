#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
QOJ 两个抓取脚本的公共部分（**只有这一份**）

为什么要有它：`QOJ_problems_scraper.py` / `QOJ_submissions_scraper.py` 若各自
"写死输入输出文件名 + 直接覆盖写"，想累积多场比赛就得每次改常量、或者手工并 JSON。
公共部分收在这里：

    resolve_path   相对 **脚本所在目录** 解析（不再依赖"你在哪个目录敲命令"）
    load_json_list 读 JSON 数组（容忍 BOM；文件不存在 → 空表）
    write_json_list 写 JSON 数组（UTF-8 无 BOM、缩进 4、保留中文 —— 与既有输出逐字一致）
    merge_by_key   按某个字段合并：同 key 覆盖原位置，新 key 追加（**幂等**）
    count_by       一个字段的取值分布（打印"有几场/有谁"用）
    contest_ids    从链接列里取 `contest/<id>`（清单里的 `contest` 就是它）

只依赖标准库（BeautifulSoup 是解析脚本自己的事）。
"""

from __future__ import annotations

import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
SPEC = os.path.dirname(HERE)

_CONTEST_RE = re.compile(r'/contest/(\d+)')


def resolve_path(path: str, default_name: str) -> str:
    """
    相对路径按**脚本所在目录**（`04 qoj/`）解析 —— 这样在仓库根目录敲命令也对。
    ⚠️ 若直接 `open("qoj_submissions.html")`，就取决于当前工作目录，
    换个目录跑就"找不到文件"。
    """
    raw = (path or '').strip() or default_name
    return raw if os.path.isabs(raw) else os.path.join(SPEC, raw)


def load_json_list(path: str) -> list:
    """读一个 JSON 数组；文件不存在 → `[]`（首次跑就是这种情况）"""
    if not path or not os.path.isfile(path):
        return []
    with open(path, 'r', encoding='utf-8-sig', errors='replace') as f:
        data = json.load(f)
    if isinstance(data, list):
        return [x for x in data if isinstance(x, dict)]
    raise ValueError(f'{path} 不是数组（正常只应写数组）')


def write_json_list(path: str, rows: list) -> None:
    """
    写 JSON 数组：UTF-8 无 BOM、缩进 4、保留中文，
    末尾补一个换行（便于 git diff / 拼接）。
    """
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(json.dumps(rows, ensure_ascii=False, indent=4))
        f.write('\n')


def _key_of(row: dict, key: str) -> str:
    v = row.get(key)
    return '' if v is None else str(v).strip()


def _merge_fields(old: dict, new: dict) -> dict:
    """
    两条**同 key** 的记录合成一条：**新记录的字段优先，但它空着的字段沿用旧记录的非空值**。

    为什么需要：QOJ 有**两种提交列表格式** ——
      · `/contest/<id>/submissions`（**8 列**，**没有「语言」列**）；
      · `/submissions?submitter=X`（**9 列**，有语言）。
    同一条提交两边都会出现，而这里若**整条覆盖** ⇒ "先用 9 列抓到的语言"会被"后来 8 列的那份"
    **抹掉**（实测 20 条 `qoj:` R 的 `language` 就是这么丢的，体检当场多出 20 格"缺"）。

    ⚠️ 只对**空 ↔ 非空**做兜底；两边都非空时仍以**新的**为准（页面刷新就该覆盖旧值）。
    ⚠️ 页面抓取里空串的语义是"这页没这一列"，不是"值没了"，所以沿用旧值是对的。
    """
    out = dict(new)
    for k, v in old.items():
        if out.get(k) in (None, '', [], {}) and v not in (None, '', [], {}):
            out[k] = v
    return out


def merge_by_key(existing: list, incoming: list, key: str) -> tuple[list, int, int, int]:
    """
    按 `key` 合并两批记录。

    - 同一个 key 且**内容真的变了**：用新记录覆盖（保持它在文件里的位置）→ 重新存一次页面就是刷新；
    - 同一个 key 但内容一样：**保持原样**（算"没变"，不重写文件、也不刷 mtime）；
    - 新 key：追加到末尾；
    - key 为空的记录：只能追加（没法判重），单独计数提醒。

    @returns (合并结果, 新增数, 更新数, 无 key 数)
    """
    out = [dict(r) for r in existing]
    index = {}
    for i, row in enumerate(out):
        k = _key_of(row, key)
        if k and k not in index:
            index[k] = i

    added = updated = nokey = 0
    for row in incoming:
        k = _key_of(row, key)
        if not k:
            out.append(dict(row))
            nokey += 1
            continue
        if k in index:
            i = index[k]
            merged = _merge_fields(out[i], row)   # 逐字段合并（别让 8 列那份把语言抹掉）
            if out[i] != merged:                  # 只有真的不一样才算"更新"
                out[i] = merged
                updated += 1
        else:
            out.append(dict(row))
            index[k] = len(out) - 1
            added += 1
    return out, added, updated, nokey


def count_by(rows: list, field: str) -> dict:
    """某字段的取值分布（`{提交者: 条数}`），空值归到 `(空)`"""
    out = {}
    for r in rows:
        v = _key_of(r, field) or '(空)'
        out[v] = out.get(v, 0) + 1
    return out


def contest_ids(rows: list, link_fields: tuple = ('题目链接', '提交链接')) -> dict:
    """
    从链接列里取 `contest/<id>` → 条数。

    这就是清单里 `submissions[].contest` 要填的东西（适配器按它过滤）——
    存完页面直接照着打印出来的号填即可，不用去猜。
    """
    out = {}
    for r in rows:
        cid = ''
        for f in link_fields:
            m = _CONTEST_RE.search(_key_of(r, f))
            if m:
                cid = m.group(1)
                break
        k = cid or '(无 contest 号)'
        out[k] = out.get(k, 0) + 1
    return out


def fmt_counts(counts: dict, limit: int = 6) -> str:
    """把分布打印成一行人话（多的在前）"""
    items = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    head = '、'.join(f'{k}→{v} 条' for k, v in items[:limit])
    more = f'（还有 {len(items) - limit} 个）' if len(items) > limit else ''
    return head + more
