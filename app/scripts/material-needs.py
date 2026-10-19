#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
原料需求清单（scripts/material-needs.py）—— 只读，不改任何数据。

口径：**让抓取部分知道该抓哪些原料**。

链路：**体检**（`field-coverage.py` 说"哪一格缺/可疑"）→ **本脚本**（翻译成"要抓什么原料、
去哪抓、一行命令、预计补多少"）→ **抓取侧**（`build-all.py --needs` 照着跑）。

为什么需要这一层：体检只说"缺 865 道题的难度"，可**抓取部分听不懂** ——
它需要的是"**刷新哪份缓存 / 重跑哪个来源的哪几场**"。这一步就是把前者翻译成后者。

输出：
  · `acm-data/reports/material-needs.json`  机器可读（抓取侧读它）
  · `acm-data/reports/material-needs.md`    人看的
  · stdout 一行摘要

用法：
    python -B scripts/material-needs.py
    python -B scripts/material-needs.py --selftest
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import subprocess
import sys
import time
from selftest_kit import Selftest

sys.dont_write_bytecode = True

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPTS = os.path.join(REPO, 'scripts')
DEFAULT_PACKAGE = os.path.join(REPO, 'acm-data', 'nodes', 'all_nodes.json')
DEFAULT_REGISTRY = os.path.join(REPO, 'acm-data', 'field-registry.json')
DEFAULT_OUT_DIR = os.path.join(REPO, 'acm-data', 'reports')
#: CF 比赛渠道的原料缓存目录（`problems.json` 题池 + `rated_list.json` 计分列表 + `page_difficulty.json` 页面实际值）
CF_CACHE = os.path.join(REPO, 'acm-data', 'raw', 'Scaper', '05 xcpc', 'cache', 'cf_contest')
_CF_EVIDENCE = None           # 懒加载：`lib/cf_page_evidence.py`（页面三态判据，唯一一份实现）
_CLIST_EVIDENCE = None        # 懒加载：`lib/clist_evidence.py`（CLIST「上游没有」的证据）
_ATCODER_EVIDENCE = None      # 懒加载：`lib/atcoder_models_evidence.py`（kenkoooo 没估出难度）

# 渠道 → 它的原料缓存 / 重跑方式。**这里就是"抓取部分要知道的东西"**：
# 一条需求必须说得出"哪份原料旧了/缺了"以及"怎么补"，否则它只是抱怨。
CHANNELS = {
    'cf': {
        'label': 'Codeforces',
        'adapter': os.path.join('acm-data', 'raw', 'Scaper', '05 xcpc', 'cf_contest_adapter.py'),
        'caches': [os.path.join('acm-data', 'raw', 'Scaper', '05 xcpc', 'cache', 'cf_contest',
                                'problems.json'),
                   os.path.join('acm-data', 'raw', 'Scaper', '05 xcpc', 'cache', 'cf_contest',
                                'page_difficulty.json')],
        'only_source': 'cf-contest',
    },
    'atcoder': {
        'label': 'AtCoder',
        'adapter': os.path.join('acm-data', 'raw', 'Scaper', '05 xcpc', 'atcoder_adapter.py'),
        'caches': [os.path.join('acm-data', 'raw', 'Scaper', '05 xcpc', 'cache', 'atcoder')],
        'only_source': 'atcoder',
    },
    'qoj': {
        'label': 'QOJ',
        'adapter': os.path.join('acm-data', 'raw', 'Scaper', '05 xcpc', 'qoj_adapter.py'),
        'caches': [os.path.join('acm-data', 'raw', 'Scaper', '04 qoj', 'cache')],
        'only_source': 'qoj',
    },
    'xcpcio': {
        'label': 'XCPCIO 榜单',
        'adapter': os.path.join('acm-data', 'raw', 'Scaper', '05 xcpc', 'xcpcio_adapter.py'),
        'caches': [os.path.join('acm-data', 'raw', 'Scaper', '05 xcpc', 'cache', 'xcpcio_tree.json')],
        # 同一类问题（`xcpcio_tree.json` 也是**建出来的**）：刷新要跑它的 builder
        'refetch': [os.path.join('acm-data', 'raw', 'Scaper', '05 xcpc', 'build_xcpcio_index.py')],
        'refetchForce': [os.path.join('acm-data', 'raw', 'Scaper', '05 xcpc',
                                      'build_xcpcio_index.py'), '--force'],
        'only_source': 'xcpcio',
    },
    'rankland': {
        'label': 'RankLand',
        'adapter': os.path.join('acm-data', 'raw', 'Scaper', '05 xcpc', 'rankland_index_adapter.py'),
        'caches': [os.path.join('acm-data', 'raw', 'Scaper', '05 xcpc', 'cache', 'rankland_index.json')],
        # ★ **刷新原料的命令**：`rankland_index.json` 是**建出来的**索引
        #   （`build_rankland_index.py`），而 `adapter` 只是**读它**的消费者 ⇒ 光"删掉缓存"不会
        #   触发重抓，反倒会让**链子第 1 步（注册表）直接失败**（它要拿这份索引校验 slug，实测）。
        #   所以这里写清"该跑哪条"：抓取侧**先跑它**，再跑链子。
        #: **只补缺的/过期的**（不带 `--force`：`read_modes` 的缓存语义 ⇒ 有缓存的不重抓）
        'refetch': [os.path.join('acm-data', 'raw', 'Scaper', '05 xcpc', 'build_rankland_index.py')],
        #: 「兜底全重爬」档（`--probe-all`）才用：忽略缓存、整份重抓
        'refetchForce': [os.path.join('acm-data', 'raw', 'Scaper', '05 xcpc',
                                      'build_rankland_index.py'), '--force'],
        'only_source': 'rankland-index',
    },
    'clist': {
        'label': 'CLIST',
        'adapter': os.path.join('scripts', 'clist-difficulty.py'),
        'caches': [os.path.join('acm-data', 'raw', 'Scaper', '05 xcpc', 'cache', 'clist',
                                'difficulty.json')],
        # 它的"adapter"本身就是 builder ⇒ 刷新 = `sync --force`（忽略缓存全量重抓）
        #: `sync --refresh` = **只补新题**（按 id 倒序翻最新一页）；`--force` 才是整份重抓
        'refetch': [os.path.join('scripts', 'clist-difficulty.py'), 'sync', '--refresh'],
        'refetchForce': [os.path.join('scripts', 'clist-difficulty.py'), 'sync', '--force'],
        'only_source': '',
    },
    'pta': {
        'label': 'PTA',
        'adapter': os.path.join('acm-data', 'raw', 'Scaper', '05 xcpc', 'pta_submissions_adapter.py'),
        'caches': [],
        'only_source': 'pta',
    },
    'nk': {'label': '\u725b\u5ba2', 'adapter': None, 'caches': [], 'only_source': 'nk'},
    'hdu': {'label': 'HDU', 'adapter': None, 'caches': [], 'only_source': 'hdu'},
    'srk': {'label': 'RankLand(srk)', 'adapter': None, 'caches': [], 'only_source': 'srk'},
    'unknown': {'label': '\u672a\u77e5\u6e20\u9053', 'adapter': None, 'caches': [], 'only_source': ''},
}

#: extKey 前缀 → 渠道。**需求必须按它分渠道**：把 PTA 缺的语言算到 CF 头上，
#: 抓取侧就会去抓一份**根本不含这些数据**的原料（实测踩到：33 条 `aux-pta:` 的提交）。
CHANNEL_BY_PREFIX = {
    'cf:': 'cf',
    'qoj:': 'qoj',
    'atcoder:': 'atcoder',
    'aux-pta:': 'pta',
    # 牛客/杭电的**主树 P** 是 nk:c:… / hdu:c:…（**没有** aux- 前缀）——
    # 只写 `aux-nk:` 会把「牛客多校缺 clist 难度」这类需求归到**未知渠道**
    # （实测：50 格 clist 缺口全落在 unknown）⇒ `nk:` 这一行必须带完整渠道前缀。
    'nk:': 'nk',
    'hdu:': 'hdu',
    'aux-nk:': 'nk',
    'aux-srk:': 'srk',
    'aux-xcpcio:': 'xcpcio',
    'aux-rankland:': 'rankland',
}


def channel_of(ext_key: str) -> str:
    for prefix, channel in CHANNEL_BY_PREFIX.items():
        if str(ext_key).startswith(prefix):
            return channel
    return 'unknown'

#: 「哪一格缺 ⇒ 该抓哪个渠道的什么」的**唯一一份规则表**。
#  加字段就往这里加一行（与 `field-registry.json` 一样：规则集中写、别散在代码里）。
NEED_RULES = (
    {
        'type': 'P', 'field': 'cfDifficulty', 'channel': 'cf', 'kind': 'refresh-cache',
        'why': 'CF 题池快照太旧（抓的时候还没打分）/ 只有补题没提交、拿不到提交里的兜底 rating',
        'action': '刷新题池（删掉缓存后重建；或单独跑一次带 --force 的该适配器）',
        # ★ 「该跑的命令」= **按需求补抓**那条正门（`--needs` 会照这份清单删掉旧原料、再重跑该来源）
        'fix': 'python -B scripts/build-all.py --needs',
        # ⚠️ **查原料**：题池里这一条**在**但 `rating` 是 null ⇒ 不是"没抓到"，是
        #    "CF 自己没给这道题打分"（新轮次常见）。
        #    这类不能进需求清单 —— 否则抓取侧会一遍遍去抓一份**永远补不上的原料**（实测踩到）。
        'exhausted': 'cf-pool',
        # ★ 判"这格**应该**有没有"的判据：**按场次的 Rated: Yes/No**
        #   —— 官网「Past contests filter → Rated: No」那份**逐场列表**（`--fetch-rated-list`）；
        #   **不计分的场没有难度分**。
        #   ⚠️ **不能用**"题目页面上的 Difficulty"判 —— 页面写没写 ≠ 这场计不计分。
        #   ⚠️ 也别用 `contest.ratingChanges`（那是"计分"）或名字/标签（都已实测推翻）。
    },
    {
        'type': 'P', 'field': 'atcoderDifficulty', 'channel': 'atcoder', 'kind': 'rerun-source',
        'why': 'AtCoder 难度来自 kenkoooo 的 `problem-models.json`：那一条**根本没有 `difficulty`**'
               '（口径："缺失不写负结论"）',
        'action': '重跑 AtCoder 适配器（它顺带拉 `problem-models.json`，公开无 key）',
        # ★ 「该跑的命令」：重跑这个来源（`--only-source` 会带 `--force`，适配器真的会重新拉）
        'fix': 'python -B scripts/build-all.py --only-source atcoder',
        # ⚠️ **查原料**：模型里那一条**在、就是没有 `difficulty`** ⇒ 不是"我们没抓到"，是 kenkoooo
        #    **没给这道题估出来**。现场重下复核（1,156,532 B / 5148 条）：三类成因 ——
        #    ① 最难的 F（`arc146_f`/`arc120_f2`/`agc0**f`…）= `{"is_experimental": false}`，
        #       **够格的评分者太少**（"**kenkoooo 的无难度常常是因为没有人过才算不了
        #       （也就是特别难，不是没有）**"）；② 教育 DP 场 26 题 = 只有 `slope`/`intercept`
        #       （那场不计分，没有难度模型）；③ `abc299_a/b` = 太简单（饱和）。
        #    ⇒ 重跑来源**永远补不上** ⇒ 不派那条命令（护栏在 `lib/atcoder_models_evidence.py`：
        #       同场一道题都没有 = kenkoooo 没收这场 ⇒ 说不上"上游没有"；缓存过期 ⇒ 重新算缺）。
        'exhausted': 'atcoder-unestimated',
    },
    {
        'type': 'P', 'field': 'clistDifficulty', 'channel': 'clist', 'kind': 'refresh-cache',
        'why': 'CLIST（clist.by）里这道题的 `rating` 为 null（它还没算出来）或我们没抓到这个 judge',
        'exhausted': 'clist-absent',
        'action': '刷 CLIST 难度缓存：`python -B scripts/clist-difficulty.py fetch --force`'
                  '（限速 10 请求/分钟，脚本自己会睡）',
        # ★ 「该跑的命令」：CLIST 难度**不属于任何题目来源**（它是一份跨 judge 的缓存，
        #   一个渠道的适配器重跑多少次都补不上）⇒ 不管缺的是 cf / atcoder / nk 的题，
        #   该跑的都是这一条；"重跑该渠道适配器"那条**补不到这些格**。
        'fix': 'python -B scripts/clist-difficulty.py fetch --force',
    },
    {
        'type': 'R', 'field': 'language', 'channel': 'cf', 'kind': 'rerun-source',
        'why': '提交页解析漏了语言（少数几条）',
        'action': '重跑该渠道的提交适配器',
    },
    {
        'type': 'P', 'field': 'name', 'channel': 'xcpcio', 'kind': 'rerun-source',
        'why': '这些题只有题号/通过率，缺题名与链接',
        'action': '重跑该渠道的题单适配器（题名/链接来自它的 config）',
    },
    # ── ↓↓ 下面两条**只有"追值"档放行时才出现**（`--pursue low`）↓↓ ──────────
    #   这 179 格（171 题链接 + 8 场开赛时间）是 `pursue: low` 的典型：注册表对 `aux-rankland:`
    #   标了"多半拿不到" ⇒ 默认档（`normal`）**不进需求清单**（"别花力气追"）；
    #   显式 `--pursue low` 时才给这两张卡 —— 让"重爬优先级"这个选项**真的有东西可选**。
    #   ⚠️ 通道是按**记录自己的 extKey 前缀**分的（`CHANNEL_BY_PREFIX`），规则里的 `channel`
    #      只是备注：真缺的格属于哪个渠道，由那一格的 key 说了算。
    {
        'type': 'P', 'field': 'link', 'channel': 'rankland', 'kind': 'rerun-source',
        'why': 'RankLand 索引的 `refs` 里**没有**这些题的链接（实测索引与 refs 片段 0 命中）'
               '—— rankland 本来就不提供题目链接',
        'action': '重跑该渠道的题单/索引适配器（题链接来自它的 `refs`）—— 多半补不回来',
    },
    {
        'type': 'C', 'field': 'contestTime', 'channel': 'rankland', 'kind': 'rerun-source',
        'why': 'RankLand 索引里这 8 场没有开赛时间 —— 索引没给的开赛时间，多半永远不会有',
        'action': '重跑该渠道的题单/索引适配器（开赛时间来自它的 `statistics`）—— 多半补不回来',
    },
)

#: **追值门槛**（`--pursue`）默认档：`normal` ⇒ 标了"多半拿不到"（`pursue: low`）的格子
#  **不进需求清单**（重爬优先级可在指令/主脚本建包中选择）。
#  ⚠️ 这是**人的判断**、不是证据（注册表 §1.1.2）：它只决定"这一轮抓不抓"。
#  ★ 口径："『多半拿不到』与『已填』『缺』『豁免』并列，**不算缺**"
#    ⇒ 体检那边它们进并列的 `missingLow`（`field-coverage.py`），**不再算缺**；
#    但**本文件的抓取计划不变** —— `--pursue low` 照样把它们列成需求（两件事）。
DEFAULT_PURSUE = 'normal'
#: 追值三档的**取值只有一处**：`field-coverage.py` 的 `PURSUE_LEVELS`（下面按路径加载它）。
#  这里再抄一遍、靠自测钉"两份相等"只是把重复钉住，不是消掉 —— 取值只允许有一处。


def _load_json(path: str) -> dict:
    try:
        with open(path, 'r', encoding='utf-8') as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


def _load_module(path: str):
    """按路径加载 `scripts/field-coverage.py`（文件名带横线，不能直接 import）"""
    return _load_module_by_path('field_coverage', path)


def _load_module_by_path(name: str, path: str):
    """按路径加载一个 .py（文件名可能带横线，不能直接 import）"""
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ImportError(path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


#: 追值三档 —— **从 `field-coverage.py` 取**（它是唯一真源；CLI 的 `choices` 与体检那边共用）。
#  ⚠️ 放在这里而不是文件顶部：得先有 `_load_module`；顶部抄一份字面量会与真源分叉。
PURSUE_LEVELS = _load_module(os.path.join(SCRIPTS, 'field-coverage.py')).PURSUE_LEVELS


def _cf_evidence():
    """
    按路径加载 `lib/cf_page_evidence.py` —— 「题目页面**实际**有没有难度」这份三态判据的唯一实现。

    为什么不去 import 整个 CF 适配器：那会把抓取侧的依赖全拖进来（这里只要读一个 JSON）。
    """
    global _CF_EVIDENCE
    if _CF_EVIDENCE is None:
        path = os.path.join(REPO, 'acm-data', 'raw', 'Scaper', '05 xcpc', 'lib',
                            'cf_page_evidence.py')
        _CF_EVIDENCE = _load_module_by_path('cf_page_evidence', path)
    return _CF_EVIDENCE


def _clist_evidence():
    """
    按路径加载 `lib/clist_evidence.py` —— 「CLIST 上游**有没有**给这道题算难度」的唯一实现。

    为什么需要它：探针实测 —— 缺的那 530 格**缓存里压根没有**
    （`abc217` 只有 D/F/G/H、CF `2202` 只有 A/B/G1），全量重抓 20–30 分钟**一格不变**。
    所以这些格要能落到"上游没有"（不再派那条永远补不上的命令），而不是一直挂着当需求。
    """
    global _CLIST_EVIDENCE
    if _CLIST_EVIDENCE is None:
        path = os.path.join(REPO, 'acm-data', 'raw', 'Scaper', '05 xcpc', 'lib',
                            'clist_evidence.py')
        _CLIST_EVIDENCE = _load_module_by_path('clist_evidence', path)
    return _CLIST_EVIDENCE


def _atcoder_evidence():
    """
    按路径加载 `lib/atcoder_models_evidence.py` —— 「kenkoooo **有没有**给这道题估出难度」的唯一实现。

    为什么需要它：现场重下 `problem-models.json`（1,156,532 B / 5148 条）复核，缺的
    38 道**一条 `difficulty` 都没有**（太难没人过 ⇒ IRT 估不出 / 教育 DP 场没有难度模型 / 签到题饱和）
    ⇒ 重跑 AtCoder 适配器**永远补不上**，不该一直挂在需求清单上（那正是最后剩下的那 1 条）。
    """
    global _ATCODER_EVIDENCE
    if _ATCODER_EVIDENCE is None:
        path = os.path.join(REPO, 'acm-data', 'raw', 'Scaper', '05 xcpc', 'lib',
                            'atcoder_models_evidence.py')
        _ATCODER_EVIDENCE = _load_module_by_path('atcoder_models_evidence', path)
    return _ATCODER_EVIDENCE


def page_rating(cid, idx, cf_cache: str = '', now: float = 0):
    """题目页面上**实际**有没有难度（三态 `has`/`none`/`unknown`）—— 转发给 `lib/cf_page_evidence.py`"""
    path = os.path.join(cf_cache, 'page_difficulty.json') if cf_cache else ''
    return _cf_evidence().page_rating(cid, idx, now=now, path=path)


def scope_of_missing(records: list, rule: dict, registry: dict, coverage, parent_of: dict,
                     package: str = DEFAULT_PACKAGE, cf_cache: str = '',
                     clist_cache: str = '', models_cache: str = '',
                     pursue: str = DEFAULT_PURSUE) -> dict:
    """
    这条需求**具体涉及哪些 key**（抓取侧就靠它知道"抓哪几场/哪几题"）。

    @param clist_cache  - CLIST 缓存表路径（自测注入用；空 = 真实缓存）
    @param models_cache - kenkoooo 模型文件路径（同上）
    @param pursue       - **追值门槛**：低于这一档的缺口**不算进这一轮**（默认 `normal` ⇒ 跳过 `low`）
    @returns `{'count': n, 'sample': [...前 20 个], 'groups': {父key: {有, 共}}}`（只带"同组不一致"的组）
    """
    want_type, field = rule['type'], rule['field']
    rules = dict(coverage.rules_for(want_type, registry))
    if field not in rules:
        return {'count': 0, 'applies': 0, 'sample': [], 'groups': {},
                'deferred': 0, 'deferredBy': {}}
    # ⚠️ **`optional`（"可有可无"）不进需求清单** —— 与体检那条口径对齐：`coverage_of()`
    #    把 `optional` 的缺列进「允许缺」一节，从不报"真缺/可疑"（见 `field-coverage.py`）。
    #    实测踩过（2026-10-15）：`R.language` 在注册表里就是 `optional`（"language 直接标
    #    可有可无"），而 QOJ **场次页根本没有语言那一列**（`docs/auto-import.md` 的
    #    「使用语言」行），可需求清单照样派了一条"重跑该渠道的提交适配器"——那条命令
    #    **永远补不上**，还会每轮重建都报一次。
    #    要连 optional 一起抓，就在注册表那条**显式**写 `pursue` / `pursueByPrefix`
    #    （`link` / `contestTime` 就是这么办的：`{'aux-rankland:': 'low'}` ⇒ 只在 `--pursue low` 时才出现）。
    if (str(rules[field].get('expect') or 'optional') == 'optional'
            and not (rules[field].get('pursue') or rules[field].get('pursueByPrefix'))):
        return {'count': 0, 'applies': 0, 'sample': [], 'groups': {},
                'deferred': 0, 'deferredBy': {}}
    when = rules[field].get('when') or {}
    missing, applies = [], []
    for rec in records:
        if str(rec.get('节点类型') or '') != want_type:
            continue
        # ⚠️ 谓词不成立的记录**不算缺**（`aux-` 豁免、非 cf 平台…）——
        #    不然"要抓的原料"里会混进一堆本来就该缺的格子。
        if not coverage.predicate_holds(rec, when, parent_of):
            continue
        applies.append(rec)
        if not coverage.is_filled(rec, field):
            missing.append(rec)
    # 同组不一致：同一个父下"有的有、有的没有"（Round 1124 E/F 那种形态）
    groups = {}
    for rec in applies:
        key = str(rec.get('父extKey') or '')
        groups.setdefault(key, {'total': 0, 'filled': 0})
        groups[key]['total'] += 1
        if coverage.is_filled(rec, field):
            groups[key]['filled'] += 1
    partial = {k: v for k, v in groups.items()
               if 0 < v['filled'] < v['total']}
    # 「原料里本来就没有」的那些：查一次原料缓存，有这条记录但值为空 ⇒ 补不了
    exhausted = 0
    why = {}                       # 「归到本来就没有」的分项计数（两个 exhausted 分支共用）
    check = rule.get('exhausted')
    if check == 'cf-pool':
        cf_dir = cf_cache or CF_CACHE
        pool_path = os.path.join(cf_dir, 'problems.json')
        pool = _load_json(pool_path)
        # ① **逐场列表**（判据："**应不应该有就是按场次的 Rated: Yes/No 判的**"）：
        #    `cf_contest_adapter.py --fetch-rated-list` 把「Past contests filter → Rated: No」
        #    那份列表抓下来落成本文件；**不计分的场没有难度分**。
        #    ⚠️ **不能**按题目页面上的 Difficulty 判 —— 就按场次计分与否判，别再自创信号。
        rated_doc = _load_json(os.path.join(cf_dir, 'rated_list.json'))
        unrated_listed = {str(x) for x in (rated_doc.get('unrated') or [])}
        # ② 题池**刚刷新过**吗（同一次构建里抓的）—— 是的话，"还是没有"就说明抓不动。
        try:
            fresh = abs(os.path.getmtime(package) - os.path.getmtime(pool_path)) < 2 * 3600
        except OSError:
            fresh = False
        # ⚠️ **别拿逐题 rating 决定"要不要抓"**（**不能看逐题的 rating** —— 不然新题怎么办？）：
        #    **新轮次的题还没打分，那也是 null** —— 那是"等 CF 打分"，
        #    不是缺口，也不是抓取能解决的。
        still = []
        for rec in missing:
            # ⚠️ 键 ⇒ `(场次号, 题号)` 的解析**只有一处**（`lib/cf_page_evidence.problem_ref`）——
            #    这条规则只允许有一份实现：多处各写一份必然分叉、校验各不相同。
            cid, idx = _cf_evidence().problem_ref(rec)
            # ★ **两条判据分开用**（"应不应该有就是按场次的 Rated: Yes/No 判的"）：
            #   ① **应该有**：场次不计分 ⇒ 这一格不该有难度分 ⇒ 不是缺口（`unrated`）；
            #   ② **实际有**：题目页面上写没写（`page_rating`）—— 实际也没有 ⇒ 补不了（`page-none`）；
            #      实际有 ⇒ 该去补值（进需求）；还没查过 ⇒ 也进需求（去查一次）。
            if str(cid) in unrated_listed:
                exhausted += 1                 # 「Rated: No」⇒ 应该有 = 否
                why['unrated'] = why.get('unrated', 0) + 1
                continue
            state, actual = page_rating(cid, idx, cf_cache)
            if state == 'none':
                exhausted += 1                 # 页面确认**实际没有** ⇒ 补不了
                why['page-none'] = why.get('page-none', 0) + 1
                continue
            if state == 'has':
                still.append(rec)              # **实际有**（API 漏了/没抓到）⇒ 值得按题补
                why['page-has'] = why.get('page-has', 0) + 1
                continue
            entry = (pool.get(cid) or {}).get(idx)
            if isinstance(entry, dict) and not entry.get('rating'):
                exhausted += 1                 # 计分轮但 CF 还没给分（新轮次）⇒ 等它
                why['notYet'] = why.get('notYet', 0) + 1
                continue
            if fresh:
                exhausted += 1                 # 题池刚刷新过还是没有 ⇒ 抓不动
                why['noData'] = why.get('noData', 0) + 1
                continue
            still.append(rec)                  # 题池旧了 ⇒ 值得刷新一次题池
        missing = still
        if exhausted:
            pretty = '、'.join(f'{k} {v}' for k, v in why.items())
            print(f'   （CF：{exhausted} 格归"本来就没有"：{pretty} '
                  f'—— 不计分的场（应该有=否）/ 页面确认没有（实际没有）/ 还没打分）', flush=True)
        if why.get('page-has'):
            print(f'   ↳ 另有 {why["page-has"]} 格**实际上有**（题目页面写着，API 漏了）⇒ '
                  f'值得按题补：`cf_contest_adapter.py --fill-difficulty`', flush=True)

    elif check == 'clist-absent':
        # 「CLIST 上游没有」是证据、不是猜测：那份全量缓存（`cache/clist/difficulty.json`，抓于 T）
        #   里**这个 judge 有别的题、就是没有这一条**，且缓存还新鲜（30 天）
        #   ⇒ 不是"我们没抓到"，是 clist **没给这道题算难度** ⇒ 刷新缓存也补不到（探针实测：
        #   `abc217` 只有 D/F/G/H、CF `2202` 只有 A/B/G1，与缺失集合互补；全量重抓 20–30 分钟不变）。
        # ⚠️ 护栏两条都在 `lib/clist_evidence.py` 里：① 那个 judge 一条都没有 ⇒ 说不上"上游没有"
        #   （那一轮没抓它）；② 缓存过期 ⇒ 重新算缺（新题可能刚被算出来）。
        evidence = _clist_evidence()
        state_path = clist_cache                      # 自测注入；空 = 真实缓存
        kept = []
        for rec in missing:
            state, _why = evidence.clist_state(rec.get('link') or '', path=state_path)
            if state != 'absent':
                kept.append(rec)                      # 说不清（认不出 / 那个 judge 没抓 / 证据过期）⇒ 照旧算缺
                continue
            exhausted += 1
            why['clist-absent'] = why.get('clist-absent', 0) + 1
        missing = kept
        if why.get('clist-absent'):
            print(f'   （CLIST：{why["clist-absent"]} 格归"上游没有"：缓存里有这个 judge 的别的题、'
                  f'就是没有这一条 ⇒ 刷新缓存也补不到，见 `lib/clist_evidence.py`）', flush=True)

    elif check == 'atcoder-unestimated':
        # 「kenkoooo 没估出难度」也是证据、不是猜测：模型文件里**那一条在、就是没有 `difficulty`**
        #   （现场重下复核：38 道全无 —— 10 道太难没人过 ⇒ IRT 估不出、26 道教育 DP 场
        #   只有用时模型、2 道签到题饱和），且缓存还新鲜（30 天）
        #   ⇒ 重跑 AtCoder 适配器也补不上（"**特别难，不是没有**"）。
        # ⚠️ 护栏两条都在 `lib/atcoder_models_evidence.py` 里：① 同场一道题都没有 ⇒ kenkoooo 没收这场
        #   （说不上"上游没有"）；② 缓存过期 ⇒ 重新算缺（新题/漏估的可能刚被估出来）。
        evidence = _atcoder_evidence()
        state_path = models_cache                     # 自测注入；空 = 真实缓存
        kept = []
        for rec in missing:
            pid = evidence.model_id_of(rec.get('link') or '', coverage.key_of(rec))
            state, _why = evidence.model_state(pid, path=state_path)
            if state != 'absent':
                kept.append(rec)                      # 说不清（认不出 / 没收这场 / 证据过期）⇒ 照旧算缺
                continue
            exhausted += 1
            why['atcoder-unestimated'] = why.get('atcoder-unestimated', 0) + 1
        missing = kept
        if why.get('atcoder-unestimated'):
            print(f'   （AtCoder：{why["atcoder-unestimated"]} 格归"上游没估出来"：模型里那一条在、'
                  f'就是没有 `difficulty`（太难没人过 / 不计分的教育场 / 签到题饱和）⇒ 重跑也补不到，'
                  f'见 `lib/atcoder_models_evidence.py`）', flush=True)

    # ★ **追值门槛**（重爬优先级可在指令/主脚本建包中选择）：
    #   注册表里标了"**多半拿不到**"（`pursue: low`）的格子**默认不进需求清单** ——
    #   别花力气追；要连它们一起抓就显式 `--pursue low`（`high` 则是"只抓最值得追的"）。
    #   ★ 口径："『多半拿不到』与『已填』『缺』『豁免』并列，**不算缺**"
    #   ⇒ 体检那边把它们放进并列的 `missingLow`（`field-coverage.py`）；
    #   但**本文件的抽取计划不变**：`--pursue low` 照样把它们列成需求（两件事）。
    kept, deferred_by = [], {}
    min_rank = coverage.pursue_rank(pursue)
    for rec in missing:
        level = coverage.pursue_of(rules[field], rec)
        if coverage.pursue_rank(level) < min_rank:
            deferred_by[level] = deferred_by.get(level, 0) + 1
            continue
        kept.append(rec)
    missing = kept

    by_channel = {}
    for rec in missing:
        by_channel.setdefault(channel_of(coverage.key_of(rec)), []).append(rec)
    return {
        'count': len(missing),
        'exhausted': exhausted,
        'deferred': sum(deferred_by.values()),
        'deferredBy': deferred_by,
        'applies': len(applies),
        'sample': [coverage.key_of(r) for r in missing[:20]],
        'groups': partial,
        'byChannel': by_channel,
    }


def derive_needs(records: list, registry: dict, coverage, parent_of: dict,
                 package: str = DEFAULT_PACKAGE, cf_cache: str = '',
                 clist_cache: str = '', models_cache: str = '',
                 pursue: str = DEFAULT_PURSUE, stats: dict = None) -> list:
    """
    体检结果 → 原料需求清单（按渠道聚合成"一次抓取动作"）。

    @param pursue - **追值门槛**（`high`/`normal`/`low`，默认 `normal`）：低于这一档的缺口不算需求
    @param stats  - 可选：把"被门槛挡下 / 归上游没有"的总数写回这里（清单为空时也要报得出来）
    """
    needs = []
    for rule in NEED_RULES:
        scope = scope_of_missing(records, rule, registry, coverage, parent_of, package, cf_cache,
                                 clist_cache, models_cache, pursue)
        if stats is not None:
            stats['deferred'] = stats.get('deferred', 0) + scope.get('deferred', 0)
            stats['exhausted'] = stats.get('exhausted', 0) + scope.get('exhausted', 0)
            for level, num in (scope.get('deferredBy') or {}).items():
                stats.setdefault('deferredBy', {})[level] = \
                    stats.setdefault('deferredBy', {}).get(level, 0) + num
        if not scope['count']:
            continue
        for ch, recs in sorted(scope['byChannel'].items(), key=lambda kv: -len(kv[1])):
            channel = CHANNELS.get(ch) or CHANNELS['unknown']
            command = (f"python -B \"{channel['adapter']}\" -o <临时文件>"
                       if channel['adapter'] else
                       (f"python -B scripts/build-all.py --only-source {channel['only_source']}"
                        if channel['only_source'] else '(认不出这个渠道 —— 见 key 前缀)'))
            needs.append({
                'id': f"{ch}:{rule['field']}",
                'channel': ch,
                'channelLabel': channel['label'],
                'field': f"{rule['type']}.{rule['field']}",
                'kind': rule['kind'],
                'action': rule['action'],
                'why': rule['why'],
                # ⚠️ **原料**：抓取侧真正要碰的东西（命令 / 缓存文件），不是"哪个字段缺"
                'command': command,
                # ★ **该跑的命令**：
                #   `command` 是"重跑这个**来源**"的命令，可它**未必补得上这一格** ——
                #   CLIST 难度是一份**跨 judge 的缓存**，重跑 cf/nk 的适配器一次都补不到；
                #   atcoder 难度要的是"重跑来源（顺带拉 problem-models.json）"而不是
                #   adapter 导出到 `<临时文件>`。两条命令长得像、用途不同，卡上必须分开说。
                #   这里给出的就是**真正该跑的那一条**；没有专门规则时退回 `command`。
                'fixCommand': rule.get('fix') or command,
                'onlySource': channel['only_source'],
                'caches': channel['caches'],
                #: 刷新这份原料该跑的**命令**（argv；空 = 没有专门 builder，靠删缓存逼重抓）
                #: ⚠️ **两档**（"不能只抓缺的?"）：`refetch` = 只补缺的/过期的；
                #:    `refetchForce` = 兜底档（`--probe-all`）用的整份重抓。
                'refetch': channel.get('refetch') or [],
                'refetchForce': channel.get('refetchForce') or channel.get('refetch') or [],
                'gain': len(recs),
                'exhausted': scope.get('exhausted', 0),
                # 被**追值门槛**挡下的格数（`--pursue low` 才把它们算进来）—— 与 `exhausted` 并列：
                # 前者是"上游没有"，这个是"我估计拿不到、这一轮先不抓"。
                'deferred': scope.get('deferred', 0),
                'groups': len(scope['groups']),
                'sample': [coverage.key_of(r) for r in recs[:20]],
                'partialGroups': dict(list(scope['groups'].items())[:20]),
            })
    needs.sort(key=lambda x: (x['channel'], -x['groups'], -x['gain']))
    return needs


def render_md(needs: list, package: str, pursue: str = DEFAULT_PURSUE) -> str:
    lines = ['# 原料需求清单（material-needs）', '',
             f'- 依据：`{os.path.relpath(package, REPO)}` 的字段体检',
             f'- 追值门槛：**{pursue}**'
             f'（标了"多半拿不到"的 `low` 格子'
             + ('**不进本清单** —— 要连它们一起抓给 `--pursue low`）' if pursue == 'normal'
                else '已按这一档筛选）' if pursue == 'high' else '已全部算进来）'),
             '', ]
    if not needs:
        lines.append('（没有需要补抓的原料 —— 体检里的"可疑"项为空）')
        return '\n'.join(lines) + '\n'
    lines += ['| 渠道 | 缺什么 | 涉及 | 同组不一致 | 抓什么 |', '|---|---|---|---|---|']
    for n in needs:
        lines.append(f"| {n['channelLabel']} | `{n['field']}` 缺 {n['gain']} | "
                     f"{len(n['sample'])} 例：{'、'.join(n['sample'][:3])} | {n['groups']} 组 | "
                     f"{n['action']} |")
    lines.append('')
    for n in needs:
        lines += [f"## {n['channelLabel']} · {n['field']}", '',
                  f"- 为什么缺：{n['why']}",
                  f"- 做什么：{n['action']}（预计补回 {n['gain']} 格）",
                  f"- **该跑的命令**：`{n['fixCommand']}`",
                  f"- 重跑该来源（另一件事，未必补得上这一格）：`{n['command']}`"
                  + (f"（或 `--only-source {n['onlySource']}`）" if n.get('onlySource') else ''),
                  f"- 要碰的原料：{'、'.join('`' + c + '`' for c in n['caches'])}", '']
        if n['partialGroups']:
            lines.append('- 同组不一致（同一场里有的有、有的没有 —— 最可疑）：')
            for parent, st in list(n['partialGroups'].items())[:10]:
                lines.append(f"  - `{parent}`：{st['filled']}/{st['total']}")
            lines.append('')
    return '\n'.join(lines) + '\n'


def fetch_rated_list() -> None:
    """
    探数据：让 CF 适配器去拉「Past contests filter → Rated: Yes/No」那份**逐场列表**（几页请求）。

    这是判"这一格**应该**有没有难度分"的**唯一判据**：
    "**应不应该有就是按场次的 Rated: Yes/No 判的**"。
    """
    adapter = os.path.join(REPO, 'acm-data', 'raw', 'Scaper', '05 xcpc', 'cf_contest_adapter.py')
    print('🔎 拉 CF「Rated: Yes/No」逐场列表 → cf_contest_adapter.py --fetch-rated-list', flush=True)
    try:
        subprocess.run([sys.executable, '-B', adapter, '--fetch-rated-list'], cwd=REPO, check=False)
    except OSError as err:
        print(f'   ⚠️ 拉不到（{err}）—— 缺失的场按"题池新旧"兜底', flush=True)


def fetch_page_difficulty(recheck: bool = False) -> None:
    """
    探数据（下半）：**按题查页面**看难度**实际**有没有（补值 + 留"实际没有"的证据）。

    @param recheck - `True` = **兜底档**：忽略已记下的结论，把所有缺难度的题全部重查
                     （`--probe-all`）。平时**不要**用 —— 默认档只查"没结论/结论过期"的题，
                     这就是"防止以后不停重爬"的那道闸。
    """
    adapter = os.path.join(REPO, 'acm-data', 'raw', 'Scaper', '05 xcpc', 'cf_contest_adapter.py')
    argv = [sys.executable, '-B', adapter, '--fill-difficulty']
    if recheck:
        argv.append('--all')
        print('⚠️ --probe-all：忽略已有结论，全部重查（兜底档）', flush=True)
    print('🔎 按题查 CF 题目页面：难度**实际**有没有 → cf_contest_adapter.py --fill-difficulty',
          flush=True)
    try:
        subprocess.run(argv, cwd=REPO, check=False)
    except OSError as err:
        print(f'   ⚠️ 查不到（{err}）—— 缺的格子会在下面的需求清单里列出来', flush=True)


def run(package: str, registry_path: str, out_dir: str, probe: bool = False,
        probe_all: bool = False, pursue: str = DEFAULT_PURSUE) -> int:
    with open(package, 'r', encoding='utf-8') as fh:
        doc = json.load(fh)
    with open(registry_path, 'r', encoding='utf-8') as fh:
        registry = json.load(fh)
    coverage = _load_module(os.path.join(SCRIPTS, 'field-coverage.py'))
    records = doc.get('records') or []
    parent_of = {coverage.key_of(r): r for r in records if coverage.key_of(r)}

    if probe:
        # 两条判据的**参考源**都要先取回来：① 场次计不计分（"应该有"）；② 题目页面**实际**有没有。
        fetch_rated_list()
        fetch_page_difficulty(recheck=probe_all)

    stats = {}
    needs = derive_needs(records, registry, coverage, parent_of, package, CF_CACHE,
                         pursue=pursue, stats=stats)
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, 'material-needs.json'), 'w', encoding='utf-8') as fh:
        json.dump({'package': os.path.relpath(package, REPO), 'pursue': pursue, 'needs': needs},
                  fh, ensure_ascii=False, indent=1)
        fh.write('\n')
    with open(os.path.join(out_dir, 'material-needs.md'), 'w', encoding='utf-8', newline='\n') as fh:
        fh.write(render_md(needs, package, pursue))

    # ⚠️ **被门槛挡下的格**与"上游没有"一样要**报出来**（清单为空时也要报）——
    #    默默不派需求会被读成"一个都不缺"（那正是这一页最怕的误读）。
    deferred = int(stats.get('deferred') or 0)
    if deferred:
        by = '、'.join(f'{k} {v}' for k, v in sorted((stats.get('deferredBy') or {}).items()))
        print(f'   ⏬ 追值门槛 {pursue}：另有 {deferred} 格标了"多半拿不到"（{by}）'
              f'⇒ 这一轮**没派需求**（要连它们一起抓：`--pursue low`）', flush=True)
    if not needs:
        print(f'📋 原料需求：无（体检里的可疑项为空'
              + (f'；另有 {deferred} 格被追值门槛挡下' if deferred else '') + '）', flush=True)
        return 0
    exhausted = int(stats.get('exhausted') or 0)
    if exhausted:
        print(f'   ℹ️ 另有 {exhausted} 格是「原料里本来就没有」（抓了也补不上，已排除）', flush=True)
    head = f'📋 原料需求：{len(needs)} 条 —— ' + '；'.join(
        f"{n['channelLabel']} 补 {n['field']}（{n['gain']} 格，{n['groups']} 组同组不一致）"
        for n in needs[:3])
    print(head, flush=True)
    print(f"   （明细：{os.path.relpath(os.path.join(out_dir, 'material-needs.md'), REPO)}；"
          f"按需抓取：`python -B scripts/build-all.py --needs`）", flush=True)
    return 0


# ================================================================
# 自测：钉住"缺 ⇒ 需求"的翻译（含同组不一致的识别）
# ================================================================
def _selftest() -> int:
    _st = Selftest('原料需求')
    ok = _st.ok

    coverage = _load_module(os.path.join(SCRIPTS, 'field-coverage.py'))
    registry = {'registryVersion': 1, 'fields': {
        'name': {'expect': 'required', 'types': ['P'], 'when': {'notExtKeyPrefix': ['aux-']}},
        'cfDifficulty': {'expect': 'expected', 'types': ['P'], 'when': {'extKeyPrefix': ['cf:c:']}},
    }}
    records = [
        {'节点类型': 'P', 'extKey': 'cf:c:1:p:A', '父extKey': 'cf:c:1', 'cfDifficulty': '1200', 'name': 'A'},
        {'节点类型': 'P', 'extKey': 'cf:c:1:p:B', '父extKey': 'cf:c:1', 'name': 'B'},
        {'节点类型': 'P', 'extKey': 'cf:c:1:p:C', '父extKey': 'cf:c:1', 'name': 'C'},
        {'节点类型': 'P', 'extKey': 'aux-xcpcio:c:9:p:A', '父extKey': 'aux-xcpcio:c:9'},
    ]
    parent_of = {coverage.key_of(r): r for r in records}
    # ⚠️ 缓存路径与"题池新旧"都要**可注入**：不然自测会去读仓库里那份真缓存，
    #    结论随抓取漂移（假数据派不出需求、断言直接 KeyError）。
    tmp = os.path.join(REPO, '.tmp-needs-selftest')
    os.makedirs(tmp, exist_ok=True)
    pkg_path = os.path.join(tmp, 'pkg.json')
    with open(pkg_path, 'w', encoding='utf-8') as fh:
        json.dump({'records': records}, fh)
    cf_dir = os.path.join(tmp, 'cf')
    os.makedirs(cf_dir, exist_ok=True)
    with open(os.path.join(cf_dir, 'problems.json'), 'w', encoding='utf-8') as fh:
        json.dump({'1': {'A': {'name': 'A', 'rating': 1200}}}, fh)   # A 有分、B/C 不在题池

    # ── 两条判据的四个组合（"应该有" = 场次计不计分；"实际有" = 题目页面写没写）
    now = int(time.time())
    old = os.path.getmtime(pkg_path) - 3 * 3600          # 题池比包旧 3 小时 ⇒ 值得刷一次

    def page_of(entries):
        with open(os.path.join(cf_dir, 'page_difficulty.json'), 'w', encoding='utf-8') as fh:
            json.dump(entries, fh)

    def needs_of():
        return {n['field']: n for n in
                derive_needs(records, registry, coverage, parent_of, pkg_path, cf_dir)}

    # ① 题池**旧** + 页面**没查过** ⇒ 需求：刷题池（默认动作）
    os.utime(os.path.join(cf_dir, 'problems.json'), (old, old))
    page_of({})
    by_field = needs_of()
    ok('P.cfDifficulty' in by_field, '题池旧 + 页面没查过 ⇒ 派生出一条需求')
    need = by_field['P.cfDifficulty']
    ok(need['channel'] == 'cf' and need['kind'] == 'refresh-cache', '渠道 cf + 刷新题池')
    ok(need['gain'] == 2, '缺 2 格（B、C）')
    ok(need['groups'] == 1, '识别出 1 组同组不一致（cf:c:1 里 1/3）')
    ok(need['partialGroups'].get('cf:c:1', {}).get('filled') == 1, '组内明细：cf:c:1 有 1 条')
    ok(any(c.endswith('problems.json') for c in need['caches']), '说得出**要碰哪份原料**')
    ok(need['command'].endswith('cf_contest_adapter.py" -o <临时文件>'), '给得出命令')
    ok(need['fixCommand'].startswith('python -B scripts/build-all.py'), '★ 该跑的命令是"重跑该来源"（不是上面那条导出到临时文件的）')
    ok('P.name' not in by_field, '`aux-` 占位题被豁免 ⇒ 不产生题名需求')

    # ② **应该有 = 否**：场次在「Rated: No」列表里 ⇒ 不是缺口（不管页面有没有）★ 判据：场次 Rated: Yes/No
    with open(os.path.join(cf_dir, 'rated_list.json'), 'w', encoding='utf-8') as fh:
        json.dump({'rated': [], 'unrated': ['1']}, fh)
    page_of({'1': {'B': {'rating': 2000, 'checkedAt': now}, 'C': {'rating': 2600, 'checkedAt': now}}})
    ok(not needs_of(), '场次不计分（应该有=否）⇒ 不派需求（**判据就是场次 Rated: Yes/No**）')

    # ③ **实际有**：场次计分、页面写着难度、可包里没有 ⇒ 派需求（该按题补值）
    with open(os.path.join(cf_dir, 'rated_list.json'), 'w', encoding='utf-8') as fh:
        json.dump({'rated': ['1'], 'unrated': []}, fh)
    by_field = needs_of()
    ok('P.cfDifficulty' in by_field, '场次计分 + 页面**实际有** ⇒ 派需求（去把值补回来）')

    # ④ **实际没有**：页面确认没写（证据新鲜）⇒ 补不了 ⇒ 不派
    page_of({'1': {i: {'rating': None, 'checkedAt': now} for i in list('ABC')}})
    ok(not needs_of(), '页面确认**实际没有** ⇒ 不派需求（有证据才敢说"本来就没有"）')

    # ⑤ 页面证据**过期** ⇒ 又变成"没结论"（新题打完分要能自己补上）⇒ 派需求
    stale = now - 40 * 86400
    page_of({'1': {i: {'rating': None, 'checkedAt': stale} for i in list('ABC')}})
    ok(bool(needs_of()), '页面证据过期 ⇒ 重新派需求（**不然新题怎么办**）')

    # ⑥ 题池里 `rating: null`（计分轮还没打分）⇒ 等它，不派
    with open(os.path.join(cf_dir, 'problems.json'), 'w', encoding='utf-8') as fh:
        json.dump({'1': {'A': {'name': 'A', 'rating': 1200},
                         'B': {'name': 'B', 'rating': None},
                         'C': {'name': 'C', 'rating': None}}}, fh)
    page_of({})
    ok(not needs_of(), '计分轮但题池 `rating: null`（还没打分）⇒ 不派（别一遍遍抓补不上的原料）')

    # ⑦ ★ CLIST 的"上游没有"证据（探针结论落地）：**缓存里有这个 judge 的别的题、
    #    就是没有这一条** ⇒ 归"上游没有"、不派那条永远补不上的命令。
    #    两条护栏各一条反例（少了它们，"缺席"就会被误读成"上游没有"）。
    clist_dir = os.path.join(tmp, 'clist')
    os.makedirs(clist_dir, exist_ok=True)
    clist_table = os.path.join(clist_dir, 'difficulty.json')
    clist_registry = {'registryVersion': 1, 'fields': {
        'clistDifficulty': {'expect': 'expected', 'types': ['P'],
                            'when': {'extKeyPrefix': ['cf:c:'], 'evidence': 'clist'}},
    }}
    clist_records = [
        {'节点类型': 'P', 'extKey': 'cf:c:9:p:A', '父extKey': 'cf:c:9',
         'link': 'https://codeforces.com/contest/9/problem/A'},
        {'节点类型': 'P', 'extKey': 'cf:c:9:p:B', '父extKey': 'cf:c:9',
         'link': 'https://codeforces.com/contest/9/problem/B'},
    ]

    def clist_needs():
        # ⚠️ `clist_path` 要**注入**（第 5 个位置参数）：不注入就会去读仓库里那份真缓存，
        #    结论随抓取漂移（`codeforces.com|9|A` 真缓存里**有** ⇒ 不注入就会红在这）。
        rows, _ = coverage.coverage_of(clist_records, clist_registry, {}, '', clist_table)
        return derive_needs(clist_records, clist_registry, coverage, {}, pkg_path, cf_dir,
                            clist_table), rows

    with open(clist_table, 'w', encoding='utf-8') as fh:
        # 这个 judge **有别的题**（证明那一轮抓到了 cf），就是没有 9/A、9/B 这两条
        json.dump({'codeforces.com|8|A': 900}, fh)
    got, rows = clist_needs()
    ok(not any(n['field'] == 'P.clistDifficulty' for n in got),
       '★ 缓存里 codeforces 有别的题、就没有这两条 ⇒ 归"上游没有"，**不派需求**')
    row = [r for r in rows if r['field'] == 'clistDifficulty'][0]
    ok(row['missing'] == 0 and row['exempt'] == 2,
       f'体检那一行也跟着：缺 0 / 豁免 2（实际 {row["missing"]}/{row["exempt"]}）')

    with open(clist_table, 'w', encoding='utf-8') as fh:
        # ⚠️ 反向锚：**表里有**这一条 ⇒ 那"缺"是我们**没写进去**（回写的问题），
        #    不是"上游没有" ⇒ 照旧算缺、照旧派需求（别把 bug 洗成"上游没有"）
        json.dump({'codeforces.com|9|A': 1500, 'codeforces.com|8|A': 900}, fh)
    got, rows = clist_needs()
    need = [n for n in got if n['field'] == 'P.clistDifficulty']
    ok(bool(need) and need[0]['gain'] == 1,
       f'★ 反向锚：表里有 9/A ⇒ 它是**真缺**（该修回写），照旧派需求（实际 '
       f'{[n["gain"] for n in need]}）')
    row = [r for r in rows if r['field'] == 'clistDifficulty'][0]
    ok(row['missing'] == 1 and row['exempt'] == 1,
       f'体检那一行：缺 1（表里有那条）/ 豁免 1（真没有那条）（实际 {row["missing"]}/{row["exempt"]}）')

    with open(clist_table, 'w', encoding='utf-8') as fh:
        json.dump({}, fh)                                   # 空缓存
    got, rows = clist_needs()
    ok(any(n['field'] == 'P.clistDifficulty' for n in got),
       '护栏①：还没有缓存（没有证据）⇒ 照旧算缺、照旧派需求（**没有证据就不算豁免**）')

    with open(clist_table, 'w', encoding='utf-8') as fh:
        json.dump({'atcoder.jp|1|A': 100}, fh)              # 只有别的 judge ⇒ 说明那一轮没抓 cf
    got, _rows = clist_needs()
    ok(any(n['field'] == 'P.clistDifficulty' for n in got),
       '护栏②：缓存里这个 judge 一条都没有 ⇒ 说不上"上游没有"（那一轮没抓它）⇒ 照旧派需求')

    with open(clist_table, 'w', encoding='utf-8') as fh:
        json.dump({'codeforces.com|9|A': 1500}, fh)
    stale_at = time.time() - 40 * 86400                     # 否定证据过期（40 天 > 30 天 TTL）
    os.utime(clist_table, (stale_at, stale_at))
    got, _rows = clist_needs()
    ok(any(n['field'] == 'P.clistDifficulty' for n in got),
       '护栏③：缓存过期（> 30 天）⇒ 重新算缺（**新题可能刚被 clist 算出来**）')

    # ⑧ ★ AtCoder 的"kenkoooo 没估出难度"证据（"kenkoooo 的无难度常常是因为
    #    **没有人过**才算不了（也就是**特别难，不是没有**）"）⇒ 这些格归"上游没估出来"、
    #    不再派那条 `--only-source atcoder`（重跑**永远补不上**）。两条护栏各配反例。
    at_table = os.path.join(tmp, 'problem-models.json')
    at_registry = {'registryVersion': 1, 'fields': {
        'atcoderDifficulty': {'expect': 'expected', 'types': ['P'],
                              'when': {'extKeyPrefix': ['atcoder:'],
                                       'evidence': 'atcoder-models'}},
    }}
    at_records = [
        {'节点类型': 'P', 'extKey': 'atcoder:c:abc299:p:A', '父extKey': 'atcoder:c:abc299',
         'link': 'https://atcoder.jp/contests/abc299/tasks/abc299_a'},
        {'节点类型': 'P', 'extKey': 'atcoder:c:abc299:p:B', '父extKey': 'atcoder:c:abc299',
         'link': 'https://atcoder.jp/contests/abc299/tasks/abc299_b'},
    ]

    def at_needs():
        # ⚠️ 路径要**注入**（第 8 个位置参数）：不注入就会去读仓库里那份真模型文件，结论随抓取漂移
        rows, _ = coverage.coverage_of(at_records, at_registry, {}, '', '', at_table)
        return derive_needs(at_records, at_registry, coverage, {}, pkg_path, cf_dir, '',
                            at_table), rows

    with open(at_table, 'w', encoding='utf-8') as fh:
        json.dump({'abc299_a': {'slope': -0.1, 'intercept': 6.2},
                   'abc299_b': {'slope': -0.1, 'intercept': 6.9},
                   'abc299_c': {'difficulty': 104}}, fh)      # 同场别的题在、这两条没有难度
    got, rows = at_needs()
    ok(not any(n['field'] == 'P.atcoderDifficulty' for n in got),
       '★ kenkoooo 模型里那一条在、就是没有 `difficulty` ⇒ 归"上游没估出来"，**不派需求**')
    row = [r for r in rows if r['field'] == 'atcoderDifficulty'][0]
    ok(row['missing'] == 0 and row['exempt'] == 2,
       f'体检那一行也跟着：缺 0 / 豁免 2（实际 {row["missing"]}/{row["exempt"]}）')

    with open(at_table, 'w', encoding='utf-8') as fh:
        # ⚠️ 反向锚：上游**估出来了**而我们没写 ⇒ 那是**回写 bug**，照旧派需求（别洗成"上游没有"）
        json.dump({'abc299_a': {'difficulty': 15},
                   'abc299_b': {'slope': -0.1}}, fh)
    got, _rows = at_needs()
    ok(any(n['field'] == 'P.atcoderDifficulty' for n in got),
       '★ 反向锚：上游有值、我们没写 ⇒ 照旧派需求（该修的是回写）')

    with open(at_table, 'w', encoding='utf-8') as fh:
        json.dump({'arc146_f': {'is_experimental': False}}, fh)   # 同场一道题都没有
    got, _rows = at_needs()
    ok(any(n['field'] == 'P.atcoderDifficulty' for n in got),
       '护栏①：表里同场一道题都没有 ⇒ kenkoooo 没收这场，照旧派需求')

    with open(at_table, 'w', encoding='utf-8') as fh:
        json.dump({'abc299_a': {'slope': -0.1}, 'abc299_c': {'difficulty': 104}}, fh)
    stale_m = time.time() - 40 * 86400                          # > 30 天 TTL
    os.utime(at_table, (stale_m, stale_m))
    got, _rows = at_needs()
    ok(any(n['field'] == 'P.atcoderDifficulty' for n in got),
       '护栏②：缓存过期（> 30 天）⇒ 重新算缺（上游可能刚把漏估的补上）')

    # ⑨ ★ **追值门槛**（重爬优先级可在指令/主脚本建包中选择）：
    #    门槛只决定"这一轮抓不抓"，**不改体检结论** —— 三条锚：默认档挡下 low、
    #    `--pursue low` 放行、`--pursue high` 只放行 high；再加"被挡下的格要报得出来"。
    pur_registry = {'registryVersion': 1, 'fields': {
        'cfDifficulty': {'expect': 'expected', 'types': ['P'],
                         'when': {'extKeyPrefix': ['cf:c:']},
                         'pursueByPrefix': {'cf:c:9': 'low'}},
    }}
    pur_records = [
        # `cf:c:9` 那两条标成"多半拿不到"，`cf:c:8` 那条是默认档
        {'节点类型': 'P', 'extKey': 'cf:c:9:p:A', '父extKey': 'cf:c:9'},
        {'节点类型': 'P', 'extKey': 'cf:c:9:p:B', '父extKey': 'cf:c:9'},
        {'节点类型': 'P', 'extKey': 'cf:c:8:p:A', '父extKey': 'cf:c:8'},
    ]

    def pur_needs(level):
        # ⚠️ 题池要**旧**（`fresh=False`）：题池刚刷新过的话，CF 那支会把缺的格子
        #    归到"抓不动"（`exhausted`）⇒ 就走不到追值门槛那一步了
        os.utime(os.path.join(cf_dir, 'problems.json'), (old, old))
        page_of({})
        stats = {}
        got = derive_needs(pur_records, pur_registry, coverage, {}, pkg_path, cf_dir,
                           pursue=level, stats=stats)
        return got, stats

    # （三档取值只有一份：`PURSUE_LEVELS` 直接从 field-coverage 取来，不必"两份互相对"）
    got, stats = pur_needs('normal')
    ok(all(n['gain'] == 1 for n in got) and stats['deferred'] == 2,
       f'★ 门槛 normal（默认）：标了 `pursue: low` 的 2 格**不进需求**、其余照旧'
       f'（实际 gain={[n["gain"] for n in got]} / 挡下 {stats.get("deferred")}）')
    ok(stats.get('deferredBy') == {'low': 2}, '★ 挡下的格按档计数（页头要报得出"多半拿不到 N 格"）')
    got_lo, stats_lo = pur_needs('low')
    ok(sum(n['gain'] for n in got_lo) == 3 and not stats_lo.get('deferred'),
       f'★ 门槛 low：连"多半拿不到"的一起抓（实际 '
       f'{sum(n["gain"] for n in got_lo)} 格 / 挡下 {stats_lo.get("deferred")}）')
    got_hi, stats_hi = pur_needs('high')
    ok(not got_hi and stats_hi['deferred'] == 3,
       f'★ 门槛 high：只抓明确值得追的 ⇒ 这一组全挡下（实际 {len(got_hi)} 条需求）')
    # ⚠️ 门槛**不改体检结论**：被挡下的格在体检里照样有结论 —— 按现在的四档口径，
    #    它们进**并列的** `missingLow`（"多半拿不到"，**不算缺**），`missing` 只剩默认档那 1 格。
    #    （⚠️ 链子只跑 `material-needs.py`、不跑它的 `--selftest` ⇒ 断言与口径对不上也没人发现，
    #      抽查时记得单独跑一遍 `--selftest`。）
    rows_p, _ = coverage.coverage_of(pur_records, pur_registry, {})
    ok(rows_p[0]['missing'] == 1 and rows_p[0].get('missingLow') == 2
       and rows_p[0]['pursue'] == 'normal',
       f'★ 门槛只影响需求清单，**体检结论一个字不动**（缺 {rows_p[0]["missing"]} 格 / '
       f'多半拿不到 {rows_p[0].get("missingLow")} 格）')

    # ⑨ ★ `optional`（"可有可无"）**默认不派需求** —— 与体检的「允许缺」一致。
    #    实测踩过：`R.language` 是 optional、QOJ 场次页**没有语言那一列**（只有全局
    #    `/submissions?submitter=` 有，见 `docs/auto-import.md`），可需求清单照样给了它
    #    一条"重跑适配器"——那条命令补不上，还每轮重建都报一次。
    #    反向锚：注册表**显式**标了 `pursue` 的 optional 字段照旧派（`link`/`contestTime` 靠这条）。
    opt_registry = {'registryVersion': 1, 'fields': {
        'language': {'expect': 'optional', 'types': ['R']},
    }}
    opt_records = [
        {'节点类型': 'R', 'extKey': 'qoj:c:1873:sub:3175978', '父extKey': 'qoj:c:1873:p:9769'},
    ]
    got = derive_needs(opt_records, opt_registry, coverage, {}, pkg_path, cf_dir)
    ok(not any(n['field'] == 'R.language' for n in got),
       '★ `optional` ⇒ **不派需求**（实测踩过：QOJ 场次页没有"语言"列，'
       f'却给 `R.language` 派过一条补不上的需求；实际 {[n["field"] for n in got]}）')

    lnk_registry = {'registryVersion': 1, 'fields': {
        'link': {'expect': 'optional', 'types': ['P'], 'pursue': 'normal'},
    }}
    lnk_records = [
        {'节点类型': 'P', 'extKey': 'aux-rankland:c:ccpc2024zhengzhou:p:A',
         '父extKey': 'aux-rankland:c:ccpc2024zhengzhou'},
    ]
    got = derive_needs(lnk_records, lnk_registry, coverage, {}, pkg_path, cf_dir)
    ok(any(n['field'] == 'P.link' for n in got),
       '★ 反向锚：optional 但注册表**显式**标了 `pursue` ⇒ 照旧派需求'
       '（`link`/`contestTime` 那两条 `pursueByPrefix` 就靠这条活着）')

    import shutil
    shutil.rmtree(tmp, ignore_errors=True)
    return _st.done()

def main(argv):
    ap = argparse.ArgumentParser(description='原料需求清单（只读）：把体检翻译成"要抓什么"')
    ap.add_argument('package', nargs='?', default=DEFAULT_PACKAGE)
    ap.add_argument('--registry', default=DEFAULT_REGISTRY)
    ap.add_argument('--out-dir', default=DEFAULT_OUT_DIR)
    ap.add_argument('--selftest', action='store_true')
    ap.add_argument('--probe-all', action='store_true', dest='probe_all',
                    help='（配 `--probe`）**兜底档**：忽略已记下的结论，把缺难度的题全部重查一遍'
                         '（`--fill-difficulty --all`）。平时不用 —— 默认档已经能防重爬，'
                         '又靠 30 天保质期不断试爬"可能刚打上分"的新题')
    ap.add_argument('--probe', action='store_true',
                    help='（联网）先**按题查一遍 CF 题目页面**（把"实际有"的难度补回来、'
                         '并给"实际没有"的留下证据），再生成清单 —— '
                         '⚠️ 这一步查的是"**实际有**"；"应该有"另有判据（场次 Rated: Yes/No）')
    ap.add_argument('--pursue', choices=list(PURSUE_LEVELS), default=DEFAULT_PURSUE,
                    help='**重爬优先级门槛**（追值，默认 %s）：低于这一档的缺口**不进本清单** —— '
                         '`normal` = 跳过标了"多半拿不到"（`pursue: low`）的格；'
                         '`low` = 全都算（连那些也一起去抓）；`high` = 只抓明确值得追的。'
                         '⚠️ 它只改"这一轮抓不抓"，**不改体检结论**（那些格照样是"缺"）'
                         % DEFAULT_PURSUE)
    args = ap.parse_args(argv)
    if args.selftest:
        return _selftest()
    return run(args.package, args.registry, args.out_dir, probe=args.probe,
               probe_all=args.probe_all, pursue=args.pursue)


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
