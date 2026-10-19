#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
字段体检（scripts/field-coverage.py）—— 只读，不改任何数据。

口径：解决"缺"要靠机制 —— 给「**哪些字段应有**」立一份记录字段：默认规则 + 注册表。

它解决的问题：**"缺"从来没人报**，只能靠人在树上撞见（Round 1124 的 E/F 就是这么被发现的）。
现在每次产包都体检一遍，缺什么、是不是真缺、和上次比新增了哪些缺口，都摆出来。

判据来自 `acm-data/field-registry.json`（**单一真源**）：三档 `required/expected/optional`
+ 可选谓词 `when`。⚠️ 不按全局百分比判 —— 那是噪音（`ratio` 缺 82% 里绝大多数题
本来就不在任何带榜单的渠道里）。

输出：
  · `acm-data/reports/field-coverage.json`  机器可读（也用来和**上一次**对比）
  · `acm-data/reports/field-coverage.md`    人看的
  · stdout 一行摘要

用法：
    python -B scripts/field-coverage.py                       # 体检并写报告
    python -B scripts/field-coverage.py --quiet               # 只出那一行摘要
    python -B scripts/field-coverage.py --selftest
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import sys
from collections import Counter, defaultdict
from selftest_kit import Selftest

sys.dont_write_bytecode = True

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_EVIDENCE = None              # 懒加载 `lib/cf_page_evidence.py`（页面证据三态，唯一一份实现）
_CLIST_EVIDENCE = None        # 懒加载 `lib/clist_evidence.py`（CLIST 难度"上游没有"的证据）
_ATCODER_EVIDENCE = None      # 懒加载 `lib/atcoder_models_evidence.py`（kenkoooo 没估出难度）
DEFAULT_PACKAGE = os.path.join(REPO, 'acm-data', 'nodes', 'all_nodes.json')
DEFAULT_REGISTRY = os.path.join(REPO, 'acm-data', 'field-registry.json')
DEFAULT_OUT_DIR = os.path.join(REPO, 'acm-data', 'reports')

#: 三档判据（顺序 = 严重程度）
EXPECT_LEVELS = ('required', 'expected', 'optional')


def key_of(record: dict) -> str:
    return str(record.get('extKey') or record.get('synthKey') or '')


def is_filled(record: dict, field: str) -> bool:
    """这个字段算不算"有值"（空串 / None / 空列表都算缺）"""
    value = record.get(field)
    if value is None:
        return False
    if isinstance(value, (list, tuple, dict)):
        return len(value) > 0
    return str(value).strip() != ''


def _cf_page_evidence():
    """
    按路径加载 `lib/cf_page_evidence.py`（页面证据的**三态**判据 —— 唯一一份实现）。

    ⚠️ 判的还有"**应该**"有没有，不只是"**实际**"有没有 ——
       "缺"是不是"**该有**而缺"，得看**这个字段自己的证据**（CF 题目页面写没写 `Difficulty`）。
       间接信号（这轮计不计分 / 题池 `rating: null`）都已被实测推翻（663/664/1345 就是反例）。
    """
    global _EVIDENCE
    if _EVIDENCE is None:
        path = os.path.join(REPO, 'acm-data', 'raw', 'Scaper', '05 xcpc', 'lib',
                            'cf_page_evidence.py')
        spec = importlib.util.spec_from_file_location('cf_page_evidence', path)
        if spec is None or spec.loader is None:
            raise ImportError(path)
        module = importlib.util.module_from_spec(spec)
        sys.modules['cf_page_evidence'] = module
        spec.loader.exec_module(module)
        _EVIDENCE = module
    return _EVIDENCE


def _clist_evidence():
    """
    按路径加载 `lib/clist_evidence.py`（CLIST 难度"**上游没有**"的证据 —— 唯一一份实现）。

    为什么不是"再抓一次就有"：探针实测（见那个模块的头注）—— 缺的那些题
    **缓存里压根没有**（`abc217` 只有 D/F/G/H、CF `2202` 只有 A/B/G1），全量重抓 20–30 分钟
    也一格不变。所以"缺"要能落到"有证据：上游没有"，否则体检会一直催一条永远补不上的命令。
    """
    global _CLIST_EVIDENCE
    if _CLIST_EVIDENCE is None:
        path = os.path.join(REPO, 'acm-data', 'raw', 'Scaper', '05 xcpc', 'lib',
                            'clist_evidence.py')
        spec = importlib.util.spec_from_file_location('clist_evidence', path)
        if spec is None or spec.loader is None:
            raise ImportError(path)
        module = importlib.util.module_from_spec(spec)
        sys.modules['clist_evidence'] = module
        spec.loader.exec_module(module)
        _CLIST_EVIDENCE = module
    return _CLIST_EVIDENCE


def _atcoder_evidence():
    """
    按路径加载 `lib/atcoder_models_evidence.py`（kenkoooo **没估出难度**的证据 —— 唯一一份实现）。

    为什么不是"重跑来源就有"：现场重下 `problem-models.json`（1,156,532 B / 5148 条）
    复核，缺的 38 道**一条 `difficulty` 都没有**（10 道太难没人过 ⇒ IRT 估不出、26 道教育 DP 场
    根本没有难度模型、2 道签到题饱和），重跑适配器**永远补不上**。
    """
    global _ATCODER_EVIDENCE
    if _ATCODER_EVIDENCE is None:
        path = os.path.join(REPO, 'acm-data', 'raw', 'Scaper', '05 xcpc', 'lib',
                            'atcoder_models_evidence.py')
        spec = importlib.util.spec_from_file_location('atcoder_models_evidence', path)
        if spec is None or spec.loader is None:
            raise ImportError(path)
        module = importlib.util.module_from_spec(spec)
        sys.modules['atcoder_models_evidence'] = module
        spec.loader.exec_module(module)
        _ATCODER_EVIDENCE = module
    return _ATCODER_EVIDENCE


def evidence_says_none(record: dict, when: dict, page_path: str = '',
                       clist_path: str = '', models_path: str = '') -> bool:
    """
    这格的缺，有没有"**实际就没有**"的证据（⇒ 允许缺，不再当可疑）。

    证据源写在注册表的 `when.evidence` 里，**没有证据就不算豁免**
    （"没抓到"和"实际没有"必须分得开）：
      · `'cf-page'` —— CF 题目页面上的 `Difficulty`（`lib/cf_page_evidence.py`，三态 + 30 天保质期）；
      · `'clist'`   —— **CLIST 那份全量缓存的"缺席"**（`lib/clist_evidence.py`：缓存里有这个 judge 的
        别的题、就是没有这一条，且缓存还新鲜 ⇒ 上游没给这道题算难度）；
      · `'atcoder-models'` —— **kenkoooo 模型里那一条没有 `difficulty`**
        （`lib/atcoder_models_evidence.py`：同场别的题在表里、这一条只有 `slope`/`is_experimental`
        ⇒ 上游估不出来 —— kenkoooo 的无难度常常是因为**没有人过**才算不了
        （也就是**特别难，不是没有**））。

    ⚠️ 这判的是"**实际**有没有"，**不是**"**应该**有没有"：应该不应该有另有判据
    （CF 按场次计不计分 → `scripts/material-needs.py`）—— **应不应该有就是按
    场次的 Rated: Yes/No 判的**：两条判据别混。

    @param page_path   - CF 页面证据文件路径（自测注入用；空 = 用真实缓存）
    @param clist_path  - CLIST 缓存表路径（同上）
    @param models_path - kenkoooo 模型文件路径（同上）
    """
    kind = str(when.get('evidence') or '')
    if kind == 'atcoder-models':
        ev = _atcoder_evidence()
        pid = ev.model_id_of(record.get('link') or '', key_of(record))
        state, _why = ev.model_state(pid, path=models_path)
        return state == 'absent'      # 那一条在、就是没有 difficulty，且证据新鲜
    if kind == 'clist':
        state, _why = _clist_evidence().clist_state(record.get('link') or '', path=clist_path)
        return state == 'absent'      # 表里有这条 judge 的别的题、就是没有它，且证据新鲜
    if kind != 'cf-page':
        return False
    # ⚠️ 键 ⇒ `(场次号, 题号)` 的解析**只有一处**（`lib/cf_page_evidence.problem_ref`）——
    #    全仓三份副本、校验各不相同会把同一道题解成不同的键。
    cid, idx = _cf_page_evidence().problem_ref(record)
    if not cid or not idx:
        return False
    state, _ = _cf_page_evidence().page_rating(cid, idx, path=page_path)
    return state == 'none'          # 查过、页面没写、证据还新鲜 ⇒ 实际没有


def pursue_of(rule: dict, record: dict) -> str:
    """
    **追值**（`pursue`）：这一格**值不值得追** —— `high` / `normal`（默认）/ `low`。

    ⚠️ **这是"人的判断"，不是"证据"**（对"**不能确定能不能爬到**"的东西也要引入优先级）：
    证据那套（`when.evidence`）说的是"**查过了、实际没有**"；`pursue` 说的是
    "**没查/查不到，但我估计**它多半永远拿不到"（`low`）/ "值得优先追"（`high`）。
    判据两层：规则上的 `pursue`（整字段一档）+ `pursueByPrefix`（**按来源覆盖**，值 = 那档）。
    """
    level = str(rule.get('pursue') or 'normal')
    by_prefix = rule.get('pursueByPrefix') or {}
    if isinstance(by_prefix, dict):
        key = key_of(record)
        for prefix in sorted(by_prefix, key=len, reverse=True):
            if key.startswith(prefix):
                return str(by_prefix[prefix] or level)
    return level


#: 追值的三档，**越大越该追**（汇总一行时取缺的那些格里最高的一档）
_PURSUE_RANK = {'low': 0, 'normal': 1, 'high': 2}

#: 追值三档（`--pursue` 的合法取值，顺序 = 从"最该追"到"最不该追"）
PURSUE_LEVELS = ('high', 'normal', 'low')


def pursue_rank(level: str) -> int:
    """
    追值档 → 名次（**越大越该追**）。认不出的档当 `normal`（不冒进、也不误杀）。

    ⚠️ 这是 `--pursue` **门槛**比较用的（`material-needs.py` 拿它筛"这一轮抓不抓"）——
    与 `pursue_worst()` 同一份名次表，别再抄一份。
    """
    return _PURSUE_RANK.get(str(level or 'normal'), _PURSUE_RANK['normal'])


def pursue_worst(levels) -> str:
    """一行里缺的那些格**该按哪档看待** —— 取**最高**的那档（只要有值得追的，这一行就值得看）"""
    best = 'low'
    for lv in levels:
        lv = str(lv or 'normal')
        if pursue_rank(lv) > pursue_rank(best):
            best = lv
    return best


def predicate_holds(record: dict, when: dict, parent_of: dict) -> bool:
    """
    `when` 谓词成立吗（键值全部成立才算）。

    ⚠️ 谓词**不成立**时，这条规则就当"不适用"—— 既不报真缺、也不报可疑。
    """
    if not when:
        return True
    prefixes = when.get('extKeyPrefix')
    if prefixes:
        prefixes = [prefixes] if isinstance(prefixes, str) else list(prefixes)
        ext = key_of(record)
        if not any(ext.startswith(p) for p in prefixes):
            return False
    below = when.get('contestIdBelow')
    if below is not None:
        # "比赛号小于 N" —— 用来把 gym（>=100000）这类**本来就不同的东西**排除掉。
        # 实测：CF 的 gym 题**没有官方难度分**（CF 自己不给、clist 也不给）。
        # ⚠️ 实测：**场次号不是数字的**（AtCoder 的 `abc138`、UCup 的 `ucup-2`…）
        #    ⇒ 这个界**不参与判定** —— 否则同一条规则里混着 CF 与 AtCoder 时，AtCoder 会被整条否掉
        #    （clist 那条规则就是这么写的）。判据一句话：**只对数字场次号生效**。
        ext = key_of(record)
        parts = ext.split(':')
        cid = parts[2] if len(parts) > 2 else ''
        # `below` 可以是**数字**（对所有前缀生效），也可以是 `{前缀: 上界}`（各论各的）：
        # 实测 —— CF gym 是 10 万+、牛客多校是 13 万+，**同一个数字界分不开**，
        # 只能一个前缀一个界（clist 那条规则就是 `{cf:c: : 100000}`）。
        bound = None
        if isinstance(below, dict):
            for prefix in sorted(below, key=len, reverse=True):
                if ext.startswith(prefix):
                    bound = below[prefix]
                    break
        else:
            bound = below
        if bound is not None and cid.isdigit() and int(cid) >= int(bound):
            return False
    excluded = when.get('notExtKeyPrefix')
    if excluded:
        # "这类记录豁免"：辅助树的占位题（`aux-*`）只有 ratio/题号，本来就不带题名。
        excluded = [excluded] if isinstance(excluded, str) else list(excluded)
        ext = key_of(record)
        if any(ext.startswith(p) for p in excluded):
            return False
    not_status = when.get('notStatus')
    if not_status:
        # "**这几种判定本来就没有这项数据**"（口径："处理其他缺失"）：
        # 实测牛客的 TLE 行**不给内存**（只给时间 1001/3001ms）、CE 行时间内存都没有
        # （程序压根没跑起来）、MLE 行不给时间 ⇒ 那 396 格不是"缺"，是这一格**不适用**。
        not_status = [not_status] if isinstance(not_status, str) else list(not_status)
        if str(record.get('status') or '') in not_status:
            return False
    want_parent = when.get('parentKind')
    if want_parent:
        parent = parent_of.get(str(record.get('父extKey') or ''))
        if not parent or str(parent.get('节点类型') or '') != str(want_parent):
            return False
    return True


def rules_for(node_type: str, registry: dict) -> list:
    """这个节点类型适用哪些字段规则（`types: ['*']` = 所有类型）"""
    out = []
    for field, rule in (registry.get('fields') or {}).items():
        # `coverage: false` = **整个字段不参与体检**（口径："减少缺" ——
        # 有能力填但决定不填的，比如 `tags`：注册表 `why` 里写明理由，这里直接不进统计）。
        if rule.get('coverage') is False:
            continue
        types = rule.get('types') or ['*']
        if str(node_type) in (rule.get('notTypes') or []):
            continue                      # 明确不适用的类型（如 name 对 R 没有意义）
        if '*' in types or node_type in types:
            out.append((field, rule))
    return out


def coverage_of(records: list, registry: dict, parent_of: dict,
                page_path: str = '', clist_path: str = '',
                models_path: str = '') -> tuple:
    """
    逐 (类型, 字段) 统计。

    @param page_path   - 页面证据文件（自测注入用；空 = 真实缓存）
    @param clist_path  - CLIST 缓存表（同上）
    @param models_path - kenkoooo 模型文件（同上）

    @returns (rows, groups) - rows 是每行的统计；groups 是"同组不一致"的明细
    """
    by_type = defaultdict(list)
    for record in records:
        by_type[str(record.get('节点类型') or '?')].append(record)

    rows = []
    inconsistent = []
    for node_type in sorted(by_type):
        rows_of_type = by_type[node_type]
        for field, rule in rules_for(node_type, registry):
            expect = str(rule.get('expect') or 'optional')
            when = rule.get('when') or {}
            applies = [r for r in rows_of_type if predicate_holds(r, when, parent_of)]
            filled = [r for r in applies if is_filled(r, field)]
            # 「缺」分**三**类（『多半拿不到』与『已填』『缺』『豁免』并列，**不算缺**）：
            #   · `exempt`     —— 有证据“实际没有”（证据 = 题目页面）⇒ 允许缺；
            #   · `missingLow` —— **多半拿不到**（注册表标了 `pursue: low`）⇒ 并列的一档、**不算缺**；
            #   · `missing`    —— 剩下那些该有却没有（真缺 / 可疑 / 同组不一致 只看它）。
            missing, missing_low, exempt = [], [], []
            for r in applies:
                if is_filled(r, field):
                    continue
                if evidence_says_none(r, when, page_path, clist_path, models_path):
                    exempt.append(r)
                elif pursue_of(rule, r) == 'low':
                    missing_low.append(r)
                else:
                    missing.append(r)
            row = {
                'type': node_type, 'field': field, 'expect': expect,
                'applies': len(applies), 'filled': len(filled), 'missing': len(missing),
                'missingLow': len(missing_low), 'missingLowSample': [key_of(r) for r in missing_low[:5]],
                'exempt': len(exempt), 'exemptSample': [key_of(r) for r in exempt[:5]],
                # 「追值」：缺的那些格按哪档看待（取最高的那档）+ 各档计数
                # 「追值」：三档都算进来（含 `missingLow`）—— material-needs 的 --pursue low 靠它
                'pursue': pursue_worst(pursue_of(rule, r) for r in (missing + missing_low)) if (missing or missing_low) else 'normal',
                'pursueCounts': dict(Counter(pursue_of(rule, r) for r in (missing + missing_low))),
                'why': rule.get('why') or '',
            }
            rows.append(row)
            # 同组不一致：同一个父（同一场/同一轮）里，**有的有、有的没有** ——
            # 这正是"Round 1124 A–D 有难度、E/F 没有"那种形态，最该报。
            if expect == 'expected' and missing:
                groups = defaultdict(list)
                for r in applies:
                    # ⚠️ **有"实际没有"证据的成员不进这一组**：它们不是"不一致"，
                    #    是这轮里合法的空格（如 1662/2214 的题页面确实没写难度）。
                    if not is_filled(r, field) and evidence_says_none(r, when, page_path, clist_path, models_path):
                        continue
                    groups[str(r.get('父extKey') or '')].append(r)
                for parent_key, members in groups.items():
                    if len(members) < 2:
                        continue
                    have = [r for r in members if is_filled(r, field)]
                    if 0 < len(have) < len(members):
                        inconsistent.append({
                            'type': node_type, 'field': field, 'parent': parent_key,
                            'total': len(members), 'filled': len(have),
                            'missing_keys': [key_of(r) for r in members if not is_filled(r, field)][:6],
                        })
    inconsistent.sort(key=lambda x: (-(x['total'] - x['filled']), x['field']))
    rows.extend(group_rows(records, registry, parent_of, page_path, clist_path, models_path))
    return rows, inconsistent


def group_rows(records: list, registry: dict, parent_of: dict, page_path: str = '',
               clist_path: str = '', models_path: str = '') -> list:
    """
    **字段组**的统计（口径："数值难度"也要成为字段组）。

    组 = "同一类信息、各来源各写各的字段"（如 `数值难度` = `cfDifficulty` + `atcoderDifficulty`）。
    `anyOf: true` ⇒ **任一成员有值就算这一组有值**；组的「缺」= 组内成员**全缺**。

    ⚠️ 组和成员**都要统计**：成员回答"这个来源给没给"，组回答"这道题到底有没有数值难度"。
       只看成员会把"CF 有、AtCoder 没有"报成缺口（那是正常的）。
    """
    out = []
    for name, group in (registry.get('groups') or {}).items():
        if not isinstance(group, dict):
            continue
        members = [str(f) for f in (group.get('fields') or [])]
        if not members:
            continue
        types = [str(t) for t in (group.get('types') or ['*'])]
        by_type = defaultdict(list)
        for record in records:
            node_type = str(record.get('节点类型') or '?')
            if '*' not in types and node_type not in types:
                continue
            by_type[node_type].append(record)
        for node_type in sorted(by_type):
            rows_of_type = by_type[node_type]
            # 谓词：**任一成员适用** ⇒ 这一组就该适用（成员规则里带 when 的那种）
            member_rules = [(f, r) for f, r in rules_for(node_type, registry) if f in members]
            if not member_rules:
                continue
            applies, filled, missing, exempt = [], [], [], []
            for rec in rows_of_type:
                # ⚠️ 参数顺序：`predicate_holds(记录, when, parent_of)` —— 写反了会"恒成立"
                #    （记录里没有认识的谓词键 ⇒ 一律 True），实测踩到过。
                holds = [predicate_holds(rec, (rule.get('when') or {}), parent_of)
                         for _, rule in member_rules]
                if not any(holds):
                    continue                       # 一条都不适用 ⇒ 这一组跟它无关
                applies.append(rec)
                if any(is_filled(rec, f) for f, _ in member_rules):
                    filled.append(rec)
                    continue
                # 全是空的：**每一个适用成员都得有"实际没有"的证据**，这一组才算"有证据实际没有"。
                # ⚠️ 必须是 `all(...)` 而不是 `any(...)`：任一成员有证据就整组豁免 —— **太松**，
                #    一道 AtCoder 题的「数值难度」= cfDifficulty（不适用）
                #    + atcoderDifficulty（kenkoooo 还没估 ⇒ **没证据**）+ clistDifficulty（clist 没有
                #    ⇒ 有证据）⇒ `any` 会把整组说成"实际没有"，可我们**根本不知道** kenkoooo 会不会
                #    估出来 —— 那正是要靠"重跑来源"去补的那 38 格（需求清单里还挂着它）。
                #    组问的是"**这道题到底有没有**数值难度"⇒ 只有**所有**适用成员都有证据才敢下这个结论。
                holds_pairs = [(f, rule) for (f, rule), ok2 in zip(member_rules, holds) if ok2]
                if all(evidence_says_none(rec, (rule.get('when') or {}), page_path, clist_path, models_path)
                       for _, rule in holds_pairs):
                    exempt.append(rec)
                else:
                    missing.append(rec)
            out.append({
                'type': node_type, 'field': name, 'group': members,
                'expect': str(group.get('expect') or 'expected'),
                'applies': len(applies), 'filled': len(filled), 'missing': len(missing),
                # 组行不分「多半拿不到」（那是**逐格**的判断；组问的是“这道题到底有没有”）
                'missingLow': 0, 'missingLowSample': [],
                'exempt': len(exempt), 'exemptSample': [key_of(r) for r in exempt[:5]],
                'why': group.get('why') or '',
            })
    return out


def load_previous(path: str) -> tuple:
    """上一次的报告：({(类型,字段): 缺口数}, 当时的注册表指纹)"""
    try:
        with open(path, 'r', encoding='utf-8') as fh:
            doc = json.load(fh)
    except (OSError, ValueError):
        return {}, ''
    out = {}
    for row in doc.get('rows') or []:
        out[(row.get('type'), row.get('field'))] = int(row.get('missing') or 0)
    return out, str(doc.get('registrySha') or '')


def render_md(rows: list, inconsistent: list, deltas: dict, package: str) -> str:
    bad = [r for r in rows if r['expect'] == 'required' and r['missing']]
    suspect = [r for r in rows if r['expect'] == 'expected' and r['missing']]
    proven = [r for r in rows if r.get('exempt')]
    # 「多半拿不到」：**并列的第四档**（**不算缺**）
    low_rows = [r for r in rows if r.get('missingLow')]
    lines = ['# 字段体检（field-coverage）', '',
             f'- 包：`{os.path.relpath(package, REPO)}`（{sum(r["applies"] for r in rows)} 条记录参与判定）',
             f'- 真缺（required）：**{len(bad)}** 个字段', f'- 可疑（expected）：**{len(suspect)}** 个字段',
             f'- 同组不一致：**{len(inconsistent)}** 组',
             f'- 允许缺·**有证据"实际没有"**：**{sum(r["exempt"] for r in proven)}** 格'
             f'（这些不算可疑 —— "实际有没有"按**题目页面**查；'
             f'"应该有"另有判据 = 场次计不计分，判在 `material-needs.py`）', '']
    low_total_md = sum(int(r.get('missingLow') or 0) for r in low_rows)
    lines.append(f'- 并列的第四档·**多半拿不到**：**{low_total_md}** 格'
                 f'（注册表标了 `pursue: low`：人已判断"追也多半追不到"'
                  f'⇒ **不算缺**；想硬追用 `--pursue low`）')
    if bad:
        lines += ['## ❌ 真缺（结构上说不通）', '', '| 类型 | 字段 | 缺 | 共 | 说明 |', '|---|---|---|---|---|']
        lines += [f'| {r["type"]} | `{r["field"]}` | {r["missing"]} | {r["applies"]} | {r["why"]} |' for r in bad]
        lines.append('')
    if suspect:
        lines += ['## ⚠️ 可疑（谓词说该有）', '', '| 类型 | 字段 | 缺 | 共 | 说明 |', '|---|---|---|---|---|']
        lines += [f'| {r["type"]} | `{r["field"]}` | {r["missing"]} | {r["applies"]} | {r["why"]} |'
                  for r in suspect]
        lines.append('')
    if proven:
        lines += ['## ✅ 有证据"实际没有"（不再算可疑）', '',
                  '| 类型 | 字段 | 格数 | 例子 | 证据 |', '|---|---|---|---|---|']
        for r in proven:
            lines.append(f'| {r["type"]} | `{r["field"]}` | {r["exempt"]} | '
                         f'{"、".join(r.get("exemptSample") or [])} | CF 题目页面上也没写 `Difficulty` |')
        lines.append('')
    if low_rows:
        lines += ['## ⏳ 多半拿不到（**不算缺**：注册表 `pursue: low`）', '',
                  '| 类型 | 字段 | 格数 | 例子 | 为什么这么判 |', '|---|---|---|---|---|']
        for r in low_rows:
            lines.append(f'| {r["type"]} | `{r["field"]}` | {r["missingLow"]} | '
                         f'{"、".join(r.get("missingLowSample") or [])} | 这一格的追值档是 `low`'
                         f'（注册表 `pursue` / `pursueByPrefix`）|')
        lines.append('')
    if inconsistent:
        lines += ['## 🔍 同组不一致（同父下有的有、有的没有 —— 最可疑）', '',
                  '| 类型 | 字段 | 父 | 有/共 | 缺的例子 |', '|---|---|---|---|---|']
        for one in inconsistent[:40]:
            lines.append(f'| {one["type"]} | `{one["field"]}` | `{one["parent"]}` | '
                         f'{one["filled"]}/{one["total"]} | {"、".join(one["missing_keys"])} |')
        lines.append('')
    if deltas.get('worse') or deltas.get('better'):
        lines += ['## 与上一次体检对比', '']
        for (node_type, field), n in deltas.get('worse', []):
            lines.append(f'- ❗ 新增缺口：{node_type}.`{field}` +{n}')
        for (node_type, field), n in deltas.get('better', []):
            lines.append(f'- ✅ 补上了：{node_type}.`{field}` -{n}')
        lines.append('')
    lines += ['## 允许缺（optional / 谓词不成立）', '',
              '| 类型 | 字段 | 缺 | 共 | 为什么允许 |', '|---|---|---|---|---|']
    for r in rows:
        if r not in bad and r not in suspect:
            note = r['why']
            if r.get('exempt'):
                note += f'（另有 {r["exempt"]} 格有证据「实际没有」）'
            lines.append(f'| {r["type"]} | `{r["field"]}` | {r["missing"]} | {r["applies"]} | {note} |')
    lines.append('')
    return '\n'.join(lines)


def run(package: str, registry_path: str, out_dir: str, quiet: bool = False) -> int:
    with open(package, 'r', encoding='utf-8') as fh:
        doc = json.load(fh)
    with open(registry_path, 'r', encoding='utf-8') as fh:
        registry = json.load(fh)
    records = doc.get('records') or []
    parent_of = {key_of(r): r for r in records if key_of(r)}

    rows, inconsistent = coverage_of(records, registry, parent_of)

    report_path = os.path.join(out_dir, 'field-coverage.json')
    previous, prev_registry = load_previous(report_path)
    # ⚠️ 规则变了就不能比 delta（改一条豁免规则就会让报告说"补上了 1 项"
    #    —— 那是规则变了，不是数据变了）。
    registry_sha = hashlib.sha256(
        json.dumps(registry, ensure_ascii=False, sort_keys=True).encode('utf-8')).hexdigest()[:12]
    comparable = bool(previous) and prev_registry == registry_sha
    deltas = {'worse': [], 'better': [], 'comparable': comparable,
              'registryChanged': bool(previous) and prev_registry != registry_sha}
    if comparable:
        for row in rows:
            now = row['missing']
            before = previous.get((row['type'], row['field']))
            if before is None:
                continue
            if now > before:
                deltas['worse'].append(((row['type'], row['field']), now - before))
            elif now < before:
                deltas['better'].append(((row['type'], row['field']), before - now))

    bad = [r for r in rows if r['expect'] == 'required' and r['missing']]
    suspect = [r for r in rows if r['expect'] == 'expected' and r['missing']]

    os.makedirs(out_dir, exist_ok=True)
    payload = {
        'package': os.path.relpath(package, REPO),
        'registryVersion': registry.get('registryVersion'),
        'registrySha': registry_sha,
        'records': len(records),
        'rows': rows,
        'inconsistent': inconsistent[:200],
        'deltas': {'worse': [[list(k), v] for k, v in deltas['worse']],
                   'better': [[list(k), v] for k, v in deltas['better']]},
    }
    with open(report_path, 'w', encoding='utf-8') as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=1)
        fh.write('\n')
    md_path = os.path.join(out_dir, 'field-coverage.md')
    with open(md_path, 'w', encoding='utf-8', newline='\n') as fh:
        fh.write(render_md(rows, inconsistent, deltas, package))

    head = (f'🩺 字段体检：真缺 {len(bad)} 项 / 可疑 {len(suspect)} 项 / '
            f'同组不一致 {len(inconsistent)} 组')
    exempt_total = sum(int(r.get('exempt') or 0) for r in rows)
    low_total = sum(int(r.get('missingLow') or 0) for r in rows)
    # ★ 「『多半拿不到』与『已填』『缺』『豁免』并列、**不算缺**」：
    #   它与"有证据实际没有"一样，是**并列的一档**，不进"真缺/可疑"。
    if exempt_total or low_total:
        head += (f'（**并列的另两档**：有证据"实际没有" **{exempt_total}** 格 · '
                 f'多半拿不到 **{low_total}** 格 —— 两者**都不算缺**）')
    if deltas.get('registryChanged'):
        head += '；（注册表改过 ⇒ 不与上次比 delta）'
    elif deltas['worse']:
        head += f'；❗ 比上次新增缺口 {len(deltas["worse"])} 项'
    if deltas.get('comparable') and deltas['better']:
        head += f'；✅ 补上 {len(deltas["better"])} 项'
    print(head, flush=True)
    if bad:
        print('   ❌ 真缺：' + '、'.join(f'{r["type"]}.{r["field"]} 缺{r["missing"]}' for r in bad), flush=True)
    if suspect:
        print('   ⚠️ 可疑：' + '、'.join(f'{r["type"]}.{r["field"]} 缺{r["missing"]}' for r in suspect), flush=True)
    if inconsistent:
        top = inconsistent[0]
        print(f'   🔍 最可疑的一组：{top["parent"]} 的 {top["type"]}.{top["field"]} '
              f'{top["filled"]}/{top["total"]}（缺 {"、".join(top["missing_keys"])}）', flush=True)
    if not quiet:
        print(f'   （明细：{os.path.relpath(md_path, REPO)}）', flush=True)
    # 真缺 = 非零退出，好让链条/CI 能当"有缺口"用；可疑只提示不失败（那是"值得看一眼"）
    return 1 if bad else 0


# ================================================================
# 自测：钉住三档判据 + 谓词 + 同组不一致（E/F 那种形态）
# ================================================================
def _selftest() -> int:
    _st = Selftest('字段体检')
    ok = _st.ok

    registry = {
        'registryVersion': 1,
        'fields': {
            'name': {'expect': 'required', 'types': ['*']},
            'cfDifficulty': {'expect': 'expected', 'types': ['P'], 'when': {'extKeyPrefix': ['cf:c:']}},
            'ratio': {'expect': 'optional', 'types': ['P']},
        },
    }
    records = [
        {'节点类型': 'C', 'extKey': 'cf:c:1', 'name': '一场比赛'},
        {'节点类型': 'P', 'extKey': 'cf:c:1:p:A', '父extKey': 'cf:c:1', 'name': 'A', 'cfDifficulty': '1200'},
        {'节点类型': 'P', 'extKey': 'cf:c:1:p:B', '父extKey': 'cf:c:1', 'name': 'B'},          # 同组缺
        {'节点类型': 'P', 'extKey': 'qoj:c:9:p:A', '父extKey': 'qoj:c:9', 'name': 'A'},        # 非 cf ⇒ 谓词不成立
        {'节点类型': 'C', 'extKey': 'cf:c:2'},                                                 # 真缺 name
    ]
    parent_of = {key_of(r): r for r in records}
    rows, inconsistent = coverage_of(records, registry, parent_of)
    by = {(r['type'], r['field']): r for r in rows}

    ok(by[('C', 'name')]['missing'] == 1, 'required 缺 ⇒ 真缺（C.name 缺 1）')
    ok(by[('C', 'name')]['expect'] == 'required', '档位照抄注册表')
    ok(by[('P', 'cfDifficulty')]['applies'] == 2, '谓词 extKeyPrefix=cf:c: ⇒ 只判 cf 那两道')
    ok(by[('P', 'cfDifficulty')]['missing'] == 1, 'cf 组里缺 1 道 ⇒ 可疑')
    ok(by[('P', 'ratio')]['expect'] == 'optional', 'optional 档')
    ok(len(inconsistent) == 1 and inconsistent[0]['field'] == 'cfDifficulty',
       '同组不一致命中（同父 cf:c:1 下 1/2）')

    # ★ 「『多半拿不到』与『已填』『缺』『豁免』并列、**不算缺**」：
    #   `pursue: low` 的格进 `missingLow`（**并列的第四档**）、**不进 `missing`**；
    #   而「追值」记账（`pursueCounts`）**仍然包含它们** —— `material-needs --pursue low` 靠它拿那 179 格。
    registry_low = {
        'registryVersion': 1,
        'fields': {
            'name': {'expect': 'required', 'types': ['*']},
            'link': {'expect': 'optional', 'types': ['P'], 'pursue': 'low'},
        },
    }
    rows_low, _inc = coverage_of(records, registry_low, parent_of)
    by_low = {(r['type'], r['field']): r for r in rows_low}
    ok(by_low[('P', 'link')]['missingLow'] == 3, f"pursue:low → missingLow 3，实际 {by_low[('P', 'link')]['missingLow']}")
    ok(by_low[('P', 'link')]['missing'] == 0, '★ **不计入缺**（并列的一档）')
    ok(by_low[('P', 'link')]['pursueCounts'].get('low') == 3,
       '「追值」记账仍然看得到它们（抓取计划要用）')
    ok(all((r.get('missingLow') or 0) == 0 for r in rows_low if r['field'] != 'link'),
       '只有那一档进 missingLow')
    ok(inconsistent[0]['missing_keys'] == ['cf:c:1:p:B'], '不一致明细点到具体 key')
    ok(predicate_holds({'节点类型': 'P', 'extKey': 'x'}, {}, {}) is True, '没有 when ⇒ 恒成立')
    ok(predicate_holds({'节点类型': 'P', 'extKey': 'qoj:c:1'}, {'extKeyPrefix': 'cf:'}, {}) is False,
       '前缀不匹配 ⇒ 不适用')
    ok(predicate_holds({'节点类型': 'P', 'extKey': 'a', '父extKey': 'c1'},
                       {'parentKind': 'C'}, {'c1': {'节点类型': 'C'}}) is True, 'parentKind 成立')
    ok(predicate_holds({'节点类型': 'P', 'extKey': 'a', '父extKey': 'c1'},
                       {'parentKind': 'R'}, {'c1': {'节点类型': 'C'}}) is False, 'parentKind 不成立')
    ok(is_filled({'x': ''}, 'x') is False and is_filled({'x': []}, 'x') is False
       and is_filled({'x': 0}, 'x') is True, '空串/空列表算缺；0 算有值')

    # ── 「**实际**有没有」：有"实际没有"的证据 ⇒ 不算可疑（"我们在判的还有'应该'有没有，
    #    不只是'实际'有没有" / "特殊情况只能兜底"）
    import time as _time
    evidence_registry = {
        'registryVersion': 1,
        'fields': {'cfDifficulty': {'expect': 'expected', 'types': ['P'],
                                    'when': {'extKeyPrefix': ['cf:c:'], 'evidence': 'cf-page'}}},
    }
    tmp_dir = os.path.join(REPO, '.tmp-coverage-selftest')
    os.makedirs(tmp_dir, exist_ok=True)
    page_file = os.path.join(tmp_dir, 'page_difficulty.json')
    now = int(_time.time())
    try:
        with open(page_file, 'w', encoding='utf-8') as fh:
            json.dump({'1': {'B': {'rating': None, 'checkedAt': now}}}, fh)
        rows2, incons2 = coverage_of(records, evidence_registry, parent_of, page_file)
        row2 = rows2[0]
        ok(row2['missing'] == 0 and row2['exempt'] == 1,
           '页面确认没写 ⇒ 归"有证据实际没有"，**不算可疑**')
        ok(incons2 == [], '有证据的空格不再报"同组不一致"')

        # 证据**过期**（新题打完分要能自己补上）⇒ 又变回可疑
        stale = now - 40 * 86400
        with open(page_file, 'w', encoding='utf-8') as fh:
            json.dump({'1': {'B': {'rating': None, 'checkedAt': stale}}}, fh)
        rows3, incons3 = coverage_of(records, evidence_registry, parent_of, page_file)
        ok(rows3[0]['missing'] == 1 and rows3[0]['exempt'] == 0,
           '证据过期 ⇒ 重新算可疑（否则新题打完分也补不上）')
        ok(len(incons3) == 1, '证据过期 ⇒ 同组不一致照报')

        # **没有证据**（页面还没查过）⇒ 也照报可疑（"没抓到"≠"实际没有"）
        os.remove(page_file)
        rows4, _ = coverage_of(records, evidence_registry, parent_of, page_file)
        ok(rows4[0]['missing'] == 1, '没抓过页面 ⇒ 照报可疑（不能凭空豁免）')
    finally:
        if os.path.isfile(page_file):
            os.remove(page_file)
        if os.path.isdir(tmp_dir) and not os.listdir(tmp_dir):
            os.rmdir(tmp_dir)

    # ── **CLIST 的"上游没有"**（探针结论）：那份全量缓存里有这个 judge 的别的题、
    #    就是没有这一条 ⇒ 有证据"实际没有"（允许缺、不算可疑）。两条护栏各一条反例。
    clist_registry = {
        'registryVersion': 1,
        'fields': {'clistDifficulty': {'expect': 'expected', 'types': ['P'],
                                       'when': {'extKeyPrefix': ['cf:c:'], 'evidence': 'clist'}}},
    }
    clist_records = [
        {'节点类型': 'P', 'extKey': 'cf:c:9:p:A', '父extKey': 'cf:c:9',
         'link': 'https://codeforces.com/contest/9/problem/A'},
        {'节点类型': 'P', 'extKey': 'cf:c:9:p:B', '父extKey': 'cf:c:9',
         'link': 'https://codeforces.com/contest/9/problem/B'},
    ]
    clist_file = os.path.join(tmp_dir, 'clist_difficulty.json')
    # ⚠️ 上一段（cf-page）的 `finally` 把空目录收走了 ⇒ 这里得自己重建（自测里不留空目录）
    os.makedirs(tmp_dir, exist_ok=True)
    try:
        with open(clist_file, 'w', encoding='utf-8') as fh:
            json.dump({'codeforces.com|8|A': 900}, fh)       # 这个 judge 有别的题、没有 9/A 9/B
        rows5, _ = coverage_of(clist_records, clist_registry, {}, '', clist_file)
        ok(rows5[0]['missing'] == 0 and rows5[0]['exempt'] == 2,
           f'★ CLIST 缓存里没有这两条 ⇒ 归"上游没有"（实际 {rows5[0]["missing"]}/{rows5[0]["exempt"]}）')

        with open(clist_file, 'w', encoding='utf-8') as fh:
            json.dump({'codeforces.com|9|A': 1500, 'codeforces.com|8|A': 900}, fh)
        rows6, _ = coverage_of(clist_records, clist_registry, {}, '', clist_file)
        ok(rows6[0]['missing'] == 1 and rows6[0]['exempt'] == 1,
           f'★ 反向锚：表里**有**这条 ⇒ 那是"我们没写进去"（真缺），只有另一条豁免'
           f'（实际 {rows6[0]["missing"]}/{rows6[0]["exempt"]}）')

        with open(clist_file, 'w', encoding='utf-8') as fh:
            json.dump({'atcoder.jp|1|A': 100}, fh)           # 只有别的 judge
        rows7, _ = coverage_of(clist_records, clist_registry, {}, '', clist_file)
        ok(rows7[0]['missing'] == 2 and rows7[0]['exempt'] == 0,
           '护栏：缓存里这个 judge 一条都没有 ⇒ 那一轮没抓它，不能说"上游没有"')

        with open(clist_file, 'w', encoding='utf-8') as fh:
            json.dump({'codeforces.com|8|A': 900}, fh)
        stale_c = _time.time() - 40 * 86400                  # > 30 天 TTL
        os.utime(clist_file, (stale_c, stale_c))
        rows8, _ = coverage_of(clist_records, clist_registry, {}, '', clist_file)
        ok(rows8[0]['missing'] == 2 and rows8[0]['exempt'] == 0,
           '护栏：否定证据过期（> 30 天）⇒ 重新算可疑（新题可能刚被 clist 算出来）')

        rows9, _ = coverage_of(clist_records, clist_registry, {}, '', os.path.join(tmp_dir, 'nope.json'))
        ok(rows9[0]['missing'] == 2 and rows9[0]['exempt'] == 0,
           '护栏：还没有缓存（没证据）⇒ 照报可疑')
    finally:
        if os.path.isfile(clist_file):
            os.remove(clist_file)
        if os.path.isdir(tmp_dir) and not os.listdir(tmp_dir):
            os.rmdir(tmp_dir)

    # ── **AtCoder：kenkoooo 没估出难度**（"kenkoooo 的无难度常常是因为**没有人过**
    #    才算不了（也就是**特别难，不是没有**）"）—— 与 CLIST 那套同一形状：**那一条在、就是没有
    #    `difficulty`** ⇒ 归"上游没有"；两条护栏各配一条反例。
    at_registry = {
        'registryVersion': 1,
        'fields': {'atcoderDifficulty': {'expect': 'expected', 'types': ['P'],
                                         'when': {'extKeyPrefix': ['atcoder:'],
                                                  'evidence': 'atcoder-models'}}},
    }
    at_records = [
        {'节点类型': 'P', 'extKey': 'atcoder:c:abc299:p:A', '父extKey': 'atcoder:c:abc299',
         'link': 'https://atcoder.jp/contests/abc299/tasks/abc299_a'},
        {'节点类型': 'P', 'extKey': 'atcoder:c:abc299:p:B', '父extKey': 'atcoder:c:abc299',
         'link': 'https://atcoder.jp/contests/abc299/tasks/abc299_b'},
    ]
    at_file = os.path.join(tmp_dir, 'problem-models.json')
    os.makedirs(tmp_dir, exist_ok=True)
    try:
        with open(at_file, 'w', encoding='utf-8') as fh:
            # 同场**别的题在**（证明 kenkoooo 收了这场），这两条只有用时模型、没有难度
            json.dump({'abc299_a': {'slope': -0.1, 'intercept': 6.2},
                       'abc299_b': {'slope': -0.1, 'intercept': 6.9},
                       'abc299_c': {'difficulty': 104}}, fh)
        rows5b, _ = coverage_of(at_records, at_registry, {}, '', '', at_file)
        ok(rows5b[0]['missing'] == 0 and rows5b[0]['exempt'] == 2,
           f'★ kenkoooo 模型里那一条在、就是没有 `difficulty` ⇒ 归"上游没估出来"'
           f'（实际 {rows5b[0]["missing"]}/{rows5b[0]["exempt"]}）')

        with open(at_file, 'w', encoding='utf-8') as fh:
            # ⚠️ 反向锚：上游**估出来了**（有 difficulty）而我们没写 ⇒ 那是**回写 bug**，
            #    照旧算缺、照旧派需求 —— 别把它洗成"上游没有"
            json.dump({'abc299_a': {'difficulty': 15},
                       'abc299_b': {'slope': -0.1, 'intercept': 6.9}}, fh)
        rows5c, _ = coverage_of(at_records, at_registry, {}, '', '', at_file)
        ok(rows5c[0]['missing'] == 1 and rows5c[0]['exempt'] == 1,
           f'★ 反向锚：上游有值而我们没写 ⇒ 算真缺（该修回写），只有另一条豁免'
           f'（实际 {rows5c[0]["missing"]}/{rows5c[0]["exempt"]}）')

        with open(at_file, 'w', encoding='utf-8') as fh:
            json.dump({'arc146_f': {'is_experimental': False}}, fh)     # 只有别的场
        rows5d, _ = coverage_of(at_records, at_registry, {}, '', '', at_file)
        ok(rows5d[0]['missing'] == 2 and rows5d[0]['exempt'] == 0,
           '护栏①：表里**同场一道题都没有** ⇒ kenkoooo 没收这场，不能说"上游没有"')

        with open(at_file, 'w', encoding='utf-8') as fh:
            json.dump({'abc299_a': {'slope': -0.1}, 'abc299_c': {'difficulty': 104}}, fh)
        stale_a = _time.time() - 40 * 86400                          # > 30 天 TTL
        os.utime(at_file, (stale_a, stale_a))
        rows5e, _ = coverage_of(at_records, at_registry, {}, '', '', at_file)
        ok(rows5e[0]['missing'] == 2 and rows5e[0]['exempt'] == 0,
           '护栏②：否定证据过期（> 30 天）⇒ 重新算可疑（上游可能刚把漏估的补上）')

        rows5f, _ = coverage_of(at_records, at_registry, {}, '', '',
                                os.path.join(tmp_dir, 'no-models.json'))
        ok(rows5f[0]['missing'] == 2 and rows5f[0]['exempt'] == 0,
           '护栏②：还没有模型缓存（没证据）⇒ 照报可疑')
    finally:
        if os.path.isfile(at_file):
            os.remove(at_file)
        if os.path.isdir(tmp_dir) and not os.listdir(tmp_dir):
            os.rmdir(tmp_dir)

    # ── **声明**：`when.notExtKeyPrefix`（来源不适用）与 `coverage: false`（整天不查）
    #    —— 口径是"减少缺（豁免？）"：有能力填但决定不填的，要能**声明**掉，
    #    而不是一直挂在"可有可无而缺"里当噪声。
    decl_registry = {
        'registryVersion': 1,
        'fields': {
            # ① 来源不适用：cf 那条来源**不提供**这个字段 ⇒ 它那两条不算缺
            'codeLength': {'expect': 'optional', 'types': ['R'],
                           'when': {'notExtKeyPrefix': ['cf:']}},
            # ② 整天不查：`coverage: false` ⇒ 连行都不出现
            'tags': {'expect': 'optional', 'types': ['P'], 'coverage': False},
        },
    }
    decl_records = [
        {'节点类型': 'R', 'extKey': 'cf:c:1:sub:cf:9', '父extKey': 'cf:c:1'},
        {'节点类型': 'R', 'extKey': 'nk:c:1:sub:nk:9', '父extKey': 'nk:c:1'},
        {'节点类型': 'P', 'extKey': 'cf:c:1:p:A', '父extKey': 'cf:c:1'},
    ]
    rows_d, _ = coverage_of(decl_records, decl_registry, {})
    cl = [r for r in rows_d if r['field'] == 'codeLength']
    ok(bool(cl) and cl[0]['applies'] == 1 and cl[0]['missing'] == 1,
       f'★ 声明① 来源不适用（`notExtKeyPrefix: [cf:]`）：cf 那条不进统计、nk 那条照旧算缺'
       f'（实际 {cl[0]["applies"] if cl else "-"} 适用 / {cl[0]["missing"] if cl else "-"} 缺）')
    ok(not any(r['field'] == 'tags' for r in rows_d),
       '★ 声明② `coverage: false` ⇒ 整个字段不进体检（连行都不出现）')

    # ── **声明③ `notStatus`**：这几种判定**本来就没有这项数据**（"处理其他缺失"）——
    #    实测牛客 TLE 行不给内存、CE 行时间内存都没有、MLE 行不给时间 ⇒ 那些格该算"不适用"。
    st_registry = {
        'registryVersion': 1,
        'fields': {'memoryUsed': {'expect': 'optional', 'types': ['R'],
                                  'when': {'notStatus': ['CE', 'TLE']}}},
    }
    st_records = [
        {'节点类型': 'R', 'extKey': 'nk:c:1:sub:nk:1', 'status': 'CE'},        # 编译错误 ⇒ 不适用
        {'节点类型': 'R', 'extKey': 'nk:c:1:sub:nk:2', 'status': 'TLE'},       # 牛客 TLE 不给内存 ⇒ 不适用
        {'节点类型': 'R', 'extKey': 'nk:c:1:sub:nk:3', 'status': 'WA'},        # 普通行 ⇒ 照旧算缺
    ]
    rows_st, _ = coverage_of(st_records, st_registry, {})
    ok(rows_st[0]['applies'] == 1 and rows_st[0]['missing'] == 1,
       f'★ 声明③ `notStatus: [CE, TLE]`：那两种判定不进统计、WA 那条照旧算缺'
       f'（实际 {rows_st[0]["applies"]} 适用 / {rows_st[0]["missing"]} 缺）')

    # ── **追值 `pursue`**（对这些**不能确定能不能爬到**的东西也应该引入优先级）：
    #    三档 high/normal/low，可按来源覆盖；一行取**缺的那些格里最高**的一档。
    pur_registry = {'registryVersion': 1, 'fields': {
        'link': {'expect': 'optional', 'types': ['P'],
                 'pursueByPrefix': {'aux-rankland:': 'low'}}}}
    pur_records = [
        {'节点类型': 'P', 'extKey': 'aux-rankland:c:1:p:A', '父extKey': 'aux-rankland:c:1'},
        {'节点类型': 'P', 'extKey': 'cf:c:1:p:A', '父extKey': 'cf:c:1'},
    ]
    rows_p, _ = coverage_of(pur_records, pur_registry, {})
    ok(rows_p[0]['pursueCounts'] == {'low': 1, 'normal': 1},
       f'★ 追值：按来源覆盖生效（实际 {rows_p[0]["pursueCounts"]}）')
    ok(rows_p[0]['pursue'] == 'normal',
       f'★ 追值：整行取**最高**那档（有值得追的 ⇒ normal，不是 low）（实际 {rows_p[0]["pursue"]}）')
    ok((pursue_rank('high'), pursue_rank('normal'), pursue_rank('low'), pursue_rank(''))
       == (2, 1, 0, 1),
       '★ 追值档名次（`--pursue` 门槛就按它比；认不出的档当 normal，不冒进也不误杀）')

    # ── **字段组**（"是时候让数值难度也成为字段组了"）：`anyOf` 语义
    group_registry = {
        'registryVersion': 1,
        'groups': {'数值难度': {'fields': ['cfDifficulty', 'atcoderDifficulty'],
                                'expect': 'expected', 'anyOf': True,
                                'types': ['P'], 'why': '同一道题的数值难度'}},
        'fields': {
            'cfDifficulty': {'expect': 'expected', 'types': ['P'],
                             'when': {'extKeyPrefix': ['cf:c:']}},
            'atcoderDifficulty': {'expect': 'expected', 'types': ['P'],
                                  'when': {'extKeyPrefix': ['atcoder:']}},
        },
    }
    group_records = [
        # CF 那题：只有 CF 难度 ⇒ **组有值**（anyOf：一个成员有就够）
        {'节点类型': 'P', 'extKey': 'cf:c:1:p:A', '父extKey': 'cf:c:1', 'cfDifficulty': '1200'},
        # CF 那题：一个都没有 ⇒ 组缺
        {'节点类型': 'P', 'extKey': 'cf:c:1:p:B', '父extKey': 'cf:c:1'},
        # AtCoder 那题：只有 AtCoder 难度 ⇒ 组也有值
        {'节点类型': 'P', 'extKey': 'atcoder:abc1:p:A', '父extKey': 'atcoder:abc1',
         'atcoderDifficulty': '-848'},
        # 别的平台：两条成员谓词都不成立 ⇒ 这一组**不适用**
        {'节点类型': 'P', 'extKey': 'qoj:c:9:p:A', '父extKey': 'qoj:c:9'},
    ]
    grows, _ = coverage_of(group_records, group_registry,
                           {key_of(r): r for r in group_records})
    grow = [r for r in grows if r.get('group')]
    ok(len(grow) == 1, '组统计只出一行（一个组 × 一个类型），实际 %d' % len(grow))
    g = grow[0]
    ok(g['field'] == '数值难度' and g['group'] == ['cfDifficulty', 'atcoderDifficulty'],
       '组行带上成员名单')
    ok(g['applies'] == 3, '谓词不成立的记录不算（qoj 那题不进组），实际 %d' % g['applies'])
    ok(g['filled'] == 2, '**任一成员有值就算有**（CF 那题 + AtCoder 那题），实际 %d' % g['filled'])
    ok(g['missing'] == 1, '成员全缺才算组缺，实际 %d' % g['missing'])

    return _st.done()


def main(argv):
    ap = argparse.ArgumentParser(description='字段体检（只读）：按注册表判"缺"是不是真缺')
    ap.add_argument('package', nargs='?', default=DEFAULT_PACKAGE)
    ap.add_argument('--registry', default=DEFAULT_REGISTRY)
    ap.add_argument('--out-dir', default=DEFAULT_OUT_DIR)
    ap.add_argument('--quiet', action='store_true', help='只出那一行摘要')
    ap.add_argument('--selftest', action='store_true')
    args = ap.parse_args(argv)
    if args.selftest:
        return _selftest()
    return run(args.package, args.registry, args.out_dir, args.quiet)


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
