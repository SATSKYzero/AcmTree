#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
原料流水线的**统一环节模块**（`Scaper/lib/stages.py`）

这条流水线上有五个环节，每一处都在做**同一件事** ——
对每个对象问一串判据，把结论合成一个值，并记下"凭什么"与"为什么没判出来"：

    ① 是否进入范围        `05 xcpc/cf_adapter.py: scope_report()`   白名单 / rankland / 按分类 / 我的提交
    ② nature 初步分类     `xcpc_common.xcpc_class_rule()` 前半       赛系 → `xcpc/icpc`、`xcpc/ccpc`…
    ③ nature 分类细化     同一条 if 链的后半                          省赛 & 邀请赛 → 类型 + 主办
    ④ nature 地名/年/赛季  `xcpc_common.xcpc_nature()`               城市 / 省名、举办年、赛季年
    ⑤ 合成节点有无与更新   `scripts/synth-bind.mjs`（建组 + 按 nature 绑定）  结构（建不建组、绑谁）

**"大同"** = 判据 + 依据 + 记账这三件事，每个环节都少不了。

**"小异"只有一处** —— 怎么把多条判据的结论合成一个值。那就是参数 `merge`：

    union   任一判据表态就要（① 范围：谁点上算谁；依据 = 表态的那几条 id）
    first   第一条表态的赢（②③：**哪一个先判就是策略本身** —— 见 `xcpc_class_rule()` 里
            "省赛/邀请赛的判定一定要最靠前"那句）
    chain   逐条往上拼、依据记**最弱的那一环**（②③④：一条分类路径是一串判据接起来的，
            值的可信度由最弱的证据决定 —— 记最强的那个等于自欺）

所以"同一个模块的不同参数"是能做到的，而且**判据本身一个字都不用搬**：
`Rule.run` 直接调现成的那个函数，本模块只负责"顺序 / 合并 / 依据 / 记账"。

⚠️ **三条纪律**（与前身 `Scaper/lib/scope.py` 同一姿态）：
  ① **判据只有一份**：本模块**不含任何判定**，`run` 一律指向既有实现的唯一处。
     在这里写第二份判据 = 两处会分叉。**"表态"的判据只有一个**：返回值是真值
     （`None`/`False`/`''`/空表都算"这条判据管不着"）。
  ② **依据 id 是跨语言契约**：`Rule.id` 写进产物的「分类依据」那一列，
     它对应的**级别表在应用侧**（`src/core/natureConfidence.js`）——
     本模块只负责"当时凭什么"，不排级别（排了就等于在 Python 里抄一份级别表）。
  ③ **记的是"最弱的证据"**（`chain` 的 `rule`）与**"谁给的"**（`union` 的 `tags`）：
     静默丢一条判据比判错更糟 —— 判错看得见，静默丢看不见。

用法（以 ① 范围 为例）：

    SCOPE = Stage(
        key='scope', title='CF gym 抓取范围', field='inScope', merge='union',
        rules=(Rule('whitelist', 'inScope', lambda g, c, cur: g in c['wl_include'], '白名单勾选'),
               Rule('rankland',  'inScope', lambda g, c, cur: g in c['rankland'],   'rankland 索引标了它'),
               Rule('按分类',     'inScope', lambda g, c, cur: g in c['classified'],'全量元信息里判得出 XCPC/UCup'),
               Rule('我的提交',   'inScope', lambda g, c, cur: g in c['mine'],      '我在这场上交过')))

    got = apply(SCOPE_STAGE, candidates, ctx)
    # got.value[gid]  = True / False   （进不进范围）
    # got.rules[gid]  = ('whitelist', 'rankland')   （**凭什么** —— 一条不多、一条不少）
    # got.label(gid)  = 'whitelist+rankland'        （旧口径那个标签，就是它拼出来的）

单个对象的用法（适配器逐场问"这一场算哪一类"）：

    ans = resolve(CLASS_STAGE, (sid, name, channel), {'warns': warns})
    # ans.value = 'xcpc/icpc/ec/regional/official'   ans.rule = 'xcpc:name-stage'
"""

from __future__ import annotations

import atexit
import json
import os
from typing import Callable, Iterable, NamedTuple, Optional

#: 合法的合并口径（`Stage.merge`）。加新的要先想清楚"它和这三种差在哪"。
#: ⚠️ `veto`（2026-10-17 加，为"这份原料还有没有用"）：前三种**只会"加"范围** ——
#:    `union` 里判据只能表态"要"（返回值是假 = 不表态），所以它算不出"这条判据说它**没用了**"；
#:    而"删除原料"必须由一条**否**的判据来授权。`veto` 因此规定判据返回两个**真值**标记：
#:    `'in'` = 还在范围内（有用）｜`'out'` = 不在范围内了（没用）；
#:    合并时 **`'in'` 优先**：任何一条判据说"还在用"就不许删 —— 删除是唯一不可逆的动作，方向必须保守；
#:    一条都没表态 ⇒ 照旧"说不清"（**绝不静默丢**，调用方自己决定留还是问人）。
MERGES = ('union', 'first', 'chain', 'veto')


class Rule(NamedTuple):
    """
    一条判据。

    @param id    判据名 —— 给**记账/日志/去重**用（`tally` 按它数）。
                 ⚠️ 它也是**产物里那个"依据 id"的默认值**；判据自己给了依据就以它为准
                 （`run` 返回 `(值, 依据)` 即可）—— 一条判据里"值一样、依据分两档"是常事
                 （例：阶段判得出记 `xcpc:name-stage`、判不出记 `xcpc:unclassified`，
                  **计算只有一次**、依据两档 ⇒ 拆成两条判据会让中间量算两遍、警告发两遍）。
    @param field 它给哪个字段值（`union` 时是"这个对象进不进"，`first`/`chain` 时是性质字段名）
    @param run   `(item, ctx, cur) -> 值 | (值, 依据)`；**返回值"是假"（`None`/`False`/`''`/空表）就
                 算"这条判据不表态"** —— 不是"空值"：空值是"判过了、结论是空"，
                 不表态是"这条判据管不着"。
                 ⚠️ 判据写成 `g in some_set` 这种**天然返回 True/False** 的式子最省事：
                 不用为了"不表态"特意包一层（那种写法最早就是这么错的 ——
                 四条闸门全部"命中"了每一场，因为 `False` 不是 `None`）。
                 `cur` = **到目前为止的值**（`chain` 用它接着往上加工；`union`/`first` 恒为 `None`）
    @param why   一句话，凭什么这么判（只给人看：日志与记账）
    """

    id: str
    field: str
    run: Callable
    why: str = ''


class Stage(NamedTuple):
    """
    一个环节 = 一串判据 + 一个合并口径。

    @param key     稳定标识（也给日志/产物认）
    @param title    人话标题
    @param field    产出哪个字段（`union` 的布尔范围环节也写一个，如 `inScope`）
    @param merge    `MERGES` 里的一种
    @param rules    **顺序即优先级**（`first`）或**顺序即拼接顺序**（`chain`）
    @param unit     记账时的量词（"场"/"条"）
    @param missing  一条判据都没表态时，这个字段为什么是空的（写进记账）
    @param prepare  `(item, ctx) -> dict`（可选）：**这个对象先算一次的公共输入**，
                    结果并进"判据看到的 ctx"。用途：几条判据要共享同一个中间量，
                    而那个中间量算第二遍是有副作用的（实测：`stage_of` 命中多条时会
                    往 `warns` 里追加一句，算两遍就报两遍）。
    """

    key: str
    title: str
    field: str
    merge: str
    rules: tuple
    unit: str = '条'
    missing: str = ''
    prepare: Optional[Callable] = None


class Outcome(NamedTuple):
    """
    跑完一个环节的结果（批量口径）。

    @param values `{对象: 值}` —— `union` 时是 `True`/`False`，`first`/`chain` 时是那个字段的值
    @param rules  `{对象: (依据id, ...)}` —— `union` 记**所有表态的**，`first`/`chain` 只记**那一条**
    @param skipped `{对象: 原因}` —— 一条判据都没表态的（**绝不静默丢**）
    @param tally  `{判据名: 命中几个对象}` —— 一眼看出"这条判据还在不在干活"
    """

    values: dict
    rules: dict
    skipped: dict
    tally: dict

    def label(self, item, sep: str = '+') -> str:
        """
        旧口径的那个"来源标签"：`'whitelist+rankland'`。

        ⚠️ 抽出来是因为**产物里存的就是它**（`cache/cf_gym_scope.json` 的值）——
        以前那串是手拼的，现在它就是 `rules` 的拼接，两者不可能再对不上。
        一条都没表态的写 `'?'`（旧口径同款：那种场次"说不清是谁给的"）。
        """
        got = self.rules.get(item) or ()
        return sep.join(got) if got else '?'


class Answer(NamedTuple):
    """
    跑完一个环节、**单个对象**的结果（`resolve()` 的口径）。

    @param value  那个字段的值（没表态 ⇒ `None`）
    @param rule   依据 id（`''` = 没有依据可用 —— 判据不表态不是依据）
    @param stated 有没有判据表过态（`False` = 得人来看，不是"判成了空"）
    """

    value: object
    rule: str
    stated: bool


def _rule_ids(rules: Iterable[Rule]) -> tuple:
    """判据名列表（顺带做一次"名字不许重"的粗检 —— 记账会认错人）"""
    ids = tuple(r.id for r in rules)
    if len(set(ids)) != len(ids):
        raise ValueError(f'判据名重复：{ids}（记账与日志会认错人）')
    return ids


def _one(stage: Stage, item, ctx):
    """
    跑**一个对象**：逐个判据问过去，按 `merge` 合并。

    @returns `(value, rule_ids, reason, tally)`；`reason` 非空 = 一条判据都没表态
    """
    if stage.merge not in MERGES:
        raise ValueError(f'不认得的合并口径「{stage.merge}」（合法值：{" / ".join(MERGES)}）')
    local = ctx if stage.prepare is None else {**(ctx or {}), **stage.prepare(item, ctx)}
    hits = []                       # `(判据名, 值, 依据id)`
    tally: list = []                # 记账用：每表态一次记一条 `(判据名, 依据id)`
    cur = None                      # `chain` 的累积值（其余两种口径不看它）
    for rule in stage.rules:
        got = rule.run(item, local, cur)
        # 判据可以只给值，也可以给 `(值, 依据)` —— 依据是"值一样、凭什么不一样"那档
        value, rid = got if isinstance(got, tuple) else (got, rule.id)
        if not value:               # 假值 = 不表态（见 `Rule.run` 的说明）
            continue
        hits.append((rule.id, value, rid))
        tally.append((rule.id, rid))
        if stage.merge == 'chain':
            cur = value
    if not hits:
        # 一条都没表态 ⇒ 值给**假/空**，但把"没表态"记下来（纪律 ③）
        TALLY.add(stage, tally, 1)
        return (False if stage.merge == 'union' else None), (), (
            stage.missing or f'{stage.title}：没有一条判据表态'), tally
    TALLY.add(stage, tally, 1)
    if stage.merge == 'union':
        return True, tuple(rid for _n, _v, rid in hits), '', tally
    if stage.merge == 'first':
        return hits[0][1], (hits[0][2],), '', tally
    if stage.merge == 'veto':
        # 「否决」口径（见 `MERGES` 的说明）：`'in'` 优先 —— 任何一条判据说"还在用"就不许删。
        for _n, _v, rid in hits:
            if _v == 'in':
                return 'in', (rid,), '', tally
        return 'out', (hits[0][2],), '', tally
    return hits[-1][1], (hits[-1][2],), '', tally     # chain：记**最后表态的那条**（= 最弱的）


def resolve(stage: Stage, item, ctx=None) -> Answer:
    """跑一个环节、**只问一个对象**（适配器逐场调用的那种用法）"""
    value, rules, reason, _tally = _one(stage, item, ctx)
    return Answer(value=value, rule=(rules[0] if rules else ''), stated=not reason)


def apply(stage: Stage, items: Iterable, ctx=None) -> Outcome:
    """
    跑一个环节：逐个对象过一遍判据，按 `merge` 合并，产出值 + 依据 + 记账。

    ⚠️ 本函数**不含任何判定**：`Rule.run` 说什么就是什么（纪律 ①）。
    ⚠️ 对象要**可哈希**（结果按对象索引）；不可哈希的对象请用 `resolve()`。
    """
    _rule_ids(stage.rules)
    values: dict = {}
    rules_of: dict = {}
    skipped: dict = {}
    tally: dict = {}
    for item in items:
        value, rules, reason, one_tally = _one(stage, item, ctx)
        values[item] = value
        rules_of[item] = rules
        if reason:
            skipped[item] = reason
        for rule_id, _rid in one_tally:
            tally[rule_id] = tally.get(rule_id, 0) + 1
    return Outcome(values=values, rules=rules_of, skipped=skipped, tally=tally)


def report(stage: Stage, out: Outcome, say: Optional[Callable[[str], None]] = None) -> None:
    """
    把一次运行讲给人听：**每条判据各命中几场** + 有多少场"说不清是谁给的"。

    为什么要这一段：静默丢一条判据是最难发现的一类坏（本期就踩过 ——
    "白名单里有 N 个 gym 既没勾选也没被 rankland 标"这句话以前是手写的，
    加了一道新判据它不会跟着变）。这里按 `rules` 与 `tally` **现算**，
    加判据不用记得回来改文案。
    """
    emit = say or print
    head = '、'.join(f'{r.id} {out.tally.get(r.id, 0)}' for r in stage.rules)
    emit(f'   🏷️ {stage.title}：{len(out.values)} {stage.unit} ⇒ {head}')
    unknown = [k for k, v in out.rules.items() if not v]
    if unknown:
        emit(f'   ⚠️ 其中 {len(unknown)} {stage.unit}**说不清是谁给的**（一条判据都没表态）：'
             + '、'.join(sorted(unknown)[:8]) + ('…' if len(unknown) > 8 else ''))


# ================================================================
# 环节记账（跨多次调用累计）
#
# 一个环节跑一次就报一次，在适配器里是噪音（每个来源各调一次 `xcpc_nature`）；
# 而"整条链跑完，**每条判据各判了几场、有没有一条从来没中过**"才是要看的东西。
# 所以这里放一个**进程内累计器**：`_one()` 每跑一次就记一笔，链尾念一遍。
#
# ⚠️ 它是**纯记账**：不参与任何判定，也不改任何返回值。清空只影响日志。
# ⚠️ 一条判据**从来没中过**是最值得看的信号（判据写错了/过时了/被前面的判据挡住了）——
#    所以 `lines()` 把 0 命中的也列出来，不因为"不好看"就藏掉。
# ================================================================

class Tally:
    """
    `{环节: {'seen': 判了几次, 'order': [判据名…], 'rules': {判据名: {'total': n, 'by': {依据id: n}}}}}`
    """

    def __init__(self) -> None:
        self.by_stage: dict = {}

    def add(self, stage: Stage, hits: list, seen: int) -> None:
        """
        @param hits 这一次跑**表过态的** `(判据名, 依据id)`（没表态的不进 —— 那正是要看的）
        @param seen 这一次跑了几个对象
        """
        bucket = self.by_stage.setdefault(stage.key, {'title': stage.title, 'seen': 0,
                                                     'order': [], 'rules': {}, 'why': {}})
        bucket['seen'] += seen
        for rule in stage.rules:
            if rule.id not in bucket['rules']:
                bucket['rules'][rule.id] = {'total': 0, 'by': {}}
                bucket['order'].append(rule.id)
            bucket['why'].setdefault(rule.id, rule.why or '')
        for rule_id, rid in hits:
            slot = bucket['rules'].setdefault(rule_id, {'total': 0, 'by': {}})
            slot['total'] += 1
            slot['by'][rid] = slot['by'].get(rid, 0) + 1

    def reset(self) -> None:
        self.by_stage = {}


#: 进程内累计器（`resolve`/`apply` 自动记账；链尾 `tally_lines()` 念一遍）
TALLY = Tally()

#: 累计结果落哪儿 —— ⚠️ **必须落盘**：每个适配器是**一个子进程**（见 `xcpc_pipeline.py`
#: 的"进程粒度 = 适配器"），进程一退内存就没了 ⇒ 想在链尾看到"整条链每条判据各判了几场"，
#: 只能每个进程退场时把它**并进同一份文件**。
#: 路径从本文件推仓库根（`Scaper/lib/` 往上四层），不依赖 cwd。
_REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..', '..'))
TALLY_FILE = os.path.join(_REPO, 'acm-data', 'reports', 'stage-tally.json')


def reset_tally() -> None:
    """清空**内存里**的记账（一次完整的链跑之前调一次；不影响判定）"""
    TALLY.reset()


def reset_tally_file(path: str = '') -> None:
    """丢掉上一轮落盘的记账（**一次完整构建开始时调一次**，否则数字会一直累加）"""
    try:
        os.remove(path or TALLY_FILE)
    except OSError:
        pass


def flush_tally(path: str = '') -> None:
    """
    把内存里这份记账**并进**落盘那份（同名环节/判据累加）。

    为什么要"并"而不是"覆盖"：每个适配器各是一个进程，各自只判了自己那几十场 ——
    覆盖就等于"最后一个进程说了算"。链尾要看的是**整条链**。
    """
    if not TALLY.by_stage:
        return
    target = path or TALLY_FILE
    try:
        with open(target, 'r', encoding='utf-8') as fh:
            merged = json.load(fh)
    except (OSError, ValueError):
        merged = {}
    for key, b in TALLY.by_stage.items():
        slot = merged.setdefault(key, {'title': b['title'], 'seen': 0, 'rules': {},
                                      'order': [], 'why': {}})
        slot['seen'] += b['seen']
        for rid in b['order']:
            if rid not in slot['rules']:
                slot['rules'][rid] = {'total': 0, 'by': {}}
                slot['order'].append(rid)
        slot.setdefault('why', {}).update(b.get('why') or {})
        for rid, r in b['rules'].items():
            tgt = slot['rules'].setdefault(rid, {'total': 0, 'by': {}})
            tgt['total'] += r['total']
            for why, n in r['by'].items():
                tgt['by'][why] = tgt['by'].get(why, 0) + n
    try:
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, 'w', encoding='utf-8', newline='\n') as fh:
            json.dump(merged, fh, ensure_ascii=False, indent=1, sort_keys=True)
            fh.write('\n')
    except OSError:
        pass


# 每个进程退场时自动并一次 —— 适配器**一个字都不用改**（它们只是 import 了 `xcpc_common`）。
# ⚠️ **只有"这条链真的要记账"时才落盘**（`ACM_STAGE_TALLY=1`，由 `xcpc_pipeline` 在建包时设）：
#    不设闸门的话，跑一次单测 / `selftest` 也会往那份文件里塞数字 ——
#    链尾念出来就成了**假账**（实测：自测里那几条`NON_EC_SOURCES`的补丁用例全进来了）。
def _flush_tally_at_exit() -> None:
    if os.environ.get('ACM_STAGE_TALLY') == '1':
        flush_tally()


atexit.register(_flush_tally_at_exit)


def _lines_of(by_stage: dict) -> list:
    out = []
    for b in by_stage.values():
        # 一条判据一行：「判据名 命中数（依据 id 各几次）」——
        # **依据那一层才是落进产物的东西**，而"一条判据给了两档依据"是常事
        # （例：阶段判得出记 `name-stage`、判不出记 `unclassified`）。
        parts = []
        for rid in b['order']:
            r = b['rules'].get(rid) or {'total': 0, 'by': {}}
            by = r.get('by') or {}
            if len(by) > 1 or (by and next(iter(by)) != rid):
                detail = '、'.join(f'{k} {v}' for k, v in sorted(by.items(), key=lambda kv: -kv[1]))
                parts.append(f'{rid} {r["total"]}（{detail}）')
            else:
                parts.append(f'{rid} {r["total"]}')
        out.append(f'   · {b["title"]}：判了 {b["seen"]} 次 ⇒ ' + '、'.join(parts))
        dead = [rid for rid in b['order'] if not (b['rules'].get(rid) or {}).get('total')]
        if dead:
            # 一条判据 0 命中 = 它判错了、过时了、被前面的判据挡住了，**或者它本来就该待用**
            # （例：`series-stop` 的渠道表 `NON_EC_SOURCES` 现在是空的 ⇒ 永远不中，
            #  但它是给"哪天某个来源收了非 EC 赛区"留的钩子）。
            # 这三者从计数上分不开 ⇒ **把这条判据自己的"凭什么"一并印出来**，让人一眼判断。
            why = b.get('why') or {}
            out.append('     ⚠️ 这几条判据**一次都没中**（写错了？被前面的挡住了？还是本来就待用？）：')
            for rid in dead:
                out.append(f'        · {rid} —— {why.get(rid) or "（这条判据没写 why）"}')
    return out


def tally_lines(path: str = '') -> list:
    """
    整条链跑完之后，每个环节的判据各判了几场（含"一次都没中"的那几条）。

    ⚠️ 读的是**落盘那份**（跨进程合并的结果）；没有文件时退回内存里这份
    （单进程调试时用得上）。
    """
    try:
        with open(path or TALLY_FILE, 'r', encoding='utf-8') as fh:
            return _lines_of(json.load(fh))
    except (OSError, ValueError):
        return _lines_of(TALLY.by_stage)
