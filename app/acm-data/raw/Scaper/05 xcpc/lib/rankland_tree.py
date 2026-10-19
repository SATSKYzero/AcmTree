#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
RankLand（algoux/srk-collection）的场次目录树 —— **唯一一份**解析/抓取实现

为什么要它
----------
XCPC 各场没有统一编号，但这套社区数据里每场都有一个稳定 slug
（`icpc2026preliminary-2`、`bjcpc2026`、`ucup3rdfinals`…），
并且 `official/config.yaml` 就是一棵**带中文名的目录树**：

    - path: icpc
      name: ICPC
      children:
        - path: icpc2026
          name: ICPC 2026 (51st)
          children:
            - path: icpc2026preliminary-2
              format: srk.json            ← 只有真场次才有 format
              name: 2026-09-12 网络赛第二场

所以本模块提供三件事：
  * `fetch_config_text()` / `parse_tree()`  —— 读并解析这棵树
  * `iter_contests()`                      —— 列出所有真场次（含仓库内路径）
  * `fetch_repo_file()`                    —— 按仓库路径下载任意文件（含 srk 榜单）

层级**不统一**（照抄，不要硬编码语义）：
  * 三层：`official/<系列>/<年份或省份>/<slug>.srk.json`
  * 两层：`official/<系列>/<slug>.srk.json`（如 ucup）

⚠️ 数据许可：srk-collection 是 **AGPL-3.0**，其 README 要求使用数据时标注来源，
   二次加工产生的衍生数据按相同协议开源。本模块只做"下载 + 解析路径"。

本文件不 import 项目内模块，只用标准库。
⚠️ **唯一例外**：`read_modes`（`Scaper/lib`）—— "该不该重抓 / 离线缺缓存要报错"
   这套口径必须与全仓一致，而它是那套口径的**唯一真源**。
"""

from __future__ import annotations

import base64
import json
import os
import sys
import urllib.request

# 「要不要重抓 / 离线缺缓存怎么办」只有一处口径：`Scaper/lib/read_modes.py`
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                                '..', '..', 'lib')))
from read_modes import require_local, should_refetch  # noqa: E402

API = 'https://api.github.com/repos/algoux/srk-collection/'
TREE_PATH = 'official/config.yaml'
RAW = 'https://raw.githubusercontent.com/algoux/srk-collection/master/'
UA = {'User-Agent': 'acm-tree/xcpc'}

HERE = os.path.dirname(os.path.abspath(__file__))
SPEC = os.path.dirname(HERE)


def _get(url: str, timeout: int = 60) -> bytes:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def fetch_config_text(cache_path: str = '') -> str:
    """
    取 `official/config.yaml` 原文。

    走 GitHub contents API（>1MB 的文件它不给 content，就退回 blobs API），
    并把结果缓存到 `05 xcpc/cache/`：这棵树 45KB，没必要每次重下。

    ⚠️ **缓存口径与全仓一致**："文件在就用它"是不行的，
    **完全不认 `--force` / `--offline`** —— `--force` 跑法会拿到上一轮的配置，
    而 `--offline` 在缓存缺失时还会**偷偷联网**。现在一律问 `read_modes`（那套口径的唯一真源）：
      · `should_refetch(True)` ⇒ `--force` / `--cache-mode none` 时**照抓**；
      · 离线且本地没有 ⇒ `require_local()` 当场报错（绝不联网）。
    """
    cache_path = cache_path or os.path.join(SPEC, 'cache', 'rankland_config.yaml')
    if os.path.isfile(cache_path) and not should_refetch(True):
        with open(cache_path, 'r', encoding='utf-8', errors='replace') as f:
            return f.read()
    require_local(cache_path, 'rankland 的 official/config.yaml')

    j = json.loads(_get(API + 'contents/' + TREE_PATH).decode('utf-8'))
    if j.get('content'):
        text = base64.b64decode(j['content']).decode('utf-8')
    else:
        blob = json.loads(_get(API + 'git/blobs/' + j['sha']).decode('utf-8'))
        text = base64.b64decode(blob['content']).decode('utf-8')

    os.makedirs(os.path.dirname(os.path.abspath(cache_path)), exist_ok=True)
    with open(cache_path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(text)
    return text


def fetch_repo_file(repo_path: str) -> bytes:
    """按仓库内路径下载文件（>1MB 走 blobs API —— 榜单文件通常 1~5MB）"""
    try:
        data = _get(RAW + repo_path)
        # raw 域名在国内网络下可能被重置/返回错误页 —— 只认真正的 JSON
        if data.lstrip()[:1] in (b'{', b'['):
            return data
    except Exception:
        pass
    j = json.loads(_get(API + 'contents/' + repo_path).decode('utf-8'))
    if j.get('content'):
        return base64.b64decode(j['content'])
    blob = json.loads(_get(API + 'git/blobs/' + j['sha']).decode('utf-8'))
    return base64.b64decode(blob['content'])


def parse_tree(cfg: str) -> list[dict]:
    """
    config.yaml → `[{indent, path, name, format}, …]`（按出现顺序）

    只认三个键：节点是 `- path: <slug>`，紧跟其后缩进更深的是
    `format:`（**只有真场次才有 `format: srk.json`**，年份/省份那种
    目录节点只有 `children:`）与 `name:`。

    刻意不引 yaml 依赖：结构极其固定，而 yaml 库不一定装得到。
    """
    nodes = []
    cur = None
    for line in cfg.splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        indent = len(line) - len(line.lstrip(' '))
        s = line.strip()
        if s.startswith('- '):
            s = s[2:]
        if s.startswith('path:'):
            cur = {'indent': indent, 'path': s.split(':', 1)[1].strip(),
                   'name': '', 'format': ''}
            nodes.append(cur)
        elif cur is not None and indent > cur['indent']:
            if s.startswith('name:') and not cur['name']:
                cur['name'] = s.split(':', 1)[1].strip().strip('"').strip("'")
            elif s.startswith('format:') and not cur['format']:
                cur['format'] = s.split(':', 1)[1].strip()
    return nodes


def ancestors(node: dict, nodes: list[dict]) -> list[dict]:
    """父链（由近到远）—— 用缩进判定，父的缩进必须更小"""
    out = []
    for other in nodes:
        if other is node:
            break
        if other['indent'] < node['indent']:
            while out and out[-1]['indent'] >= other['indent']:
                out.pop()
            out.append(other)
    return out


def iter_contests(cfg: str) -> list[dict]:
    """
    列出所有**真场次**（有 `format` 的叶子），每个返回：

        {slug, name, series, mid, repo_path, parents:[(path,name), …], format}

    `series` = 树的第 1 层，`mid` = 第 2 层（可能为空，如 ucup）。
    `repo_path` 是可直接下载的仓库内路径。
    """
    nodes = parse_tree(cfg)
    out = []
    for n in nodes:
        if not n['format']:
            continue
        anc = ancestors(n, nodes)
        paths = [a['path'] for a in anc]
        repo_path = '/'.join(['official'] + paths + [f"{n['path']}.{n['format']}"])
        out.append({
            'slug': n['path'],
            'name': n['name'] or n['path'],
            'series': anc[0]['path'] if anc else '',
            'series_name': anc[0]['name'] if anc else '',
            'mid': paths[1] if len(paths) > 1 else '',
            'mid_name': anc[1]['name'] if len(anc) > 1 else '',
            'parents': [(a['path'], a['name']) for a in anc],
            'repo_path': repo_path,
            'format': n['format'],
        })
    return out


def find_contest(cfg: str, slug: str) -> dict | None:
    for c in iter_contests(cfg):
        if c['slug'] == slug:
            return c
    return None
