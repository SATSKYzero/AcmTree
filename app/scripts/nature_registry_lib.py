# -*- coding: utf-8 -*-
r"""
性质注册表的**形状校验**（`acm-data/nature-registry.json` 的唯一一份判据）

为什么要有它
------------
那份文件是**规则**（手维护；两个消费者：`scripts/crate.py` 与 `src/core/natureFields.js`），
可两边读它的时候**都容错**：少一档就当没有、分类树少一层就查不出来。于是"改错了"是**静默**的 ——
一直要等到产包（几分钟）才炸，或者干脆不炸、只是几场比赛判不出分类。

所以判据前置到**写盘那一刻**（主脚本 `PUT /api/nature-registry`）+ 一条能随时手跑的只读体检
（`scripts/nature-registry-check.py`）。**这一份是唯一实现** —— 别在别处再写第二套形状检查。

判据（每条都对着一次真实的错法）
--------------------------------
* 顶层键与类型：`registryVersion`（≥1 的整数）、`fields`（对象）、`classTrie`（对象）；
  `note` 若在，必须是**字符串数组**（它是给人读的说明，写成一段字符串会让消费者拿到字/词）。
* `fields`：每条要有 `label`（非空）+ `kind ∈ {classPath, text, pattern}`；
  `kind == 'pattern'` 的**必须**给 `pattern` 且能被 `re.compile` 编出来
  （编不出来 ⇒ `crate.py` 在 import 期就崩，报的还是"坏正则"这种离现场很远的错）。
* **恰好一条 `classPath`**：分类那一维（现在是 `natureClass`）是"有序列表 → `a/b/c`"的形态，
  两条的话消费者得猜哪条算；一条没有的话"分类"就没人判。
* `classTrie`：递归地必须是"**对象树**" —— 每个键非空、不含 `/`（`/` 是**写进节点时的分隔符**，
  键里带它就把两层压成一层）、没有首尾空白；每个值必须是对象；
  **叶子 = 空对象 `{}`**（写成字符串/数组/带说明的对象都会被当成"有子分类"，于是那一支消失）。
* 三片**特殊叶子必须在**：`无归类` / `未归类` / `上游异常`（`src/core/natureFields.js` 的
  `CLASS_NONE` / `CLASS_PENDING` / `CLASS_UPSTREAM` 是**逐字**比的，缺一片就有一条值判不出来；
  有跨语言对拍照，见 `src/test/crossLangTables.test.js`）。

⚠️ 只校验**形状**，不判"这个分类该不该有" —— 那是人的决定（同 `xcpc_registry.py` 那条：
机器出候选、人拍板）。
"""
from __future__ import annotations

import json
import os
import re
import sys

sys.dont_write_bytecode = True

#: `fields[*].kind` 的合法取值（消费者按它决定"这一维怎么存/怎么显示"）
KINDS = ('classPath', 'text', 'pattern')

#: 分类树里**必须有**的特殊叶子（与 `src/core/natureFields.js` 的三个常量逐字相同）
CLASS_SPECIAL = ('无归类', '未归类', '上游异常')

#: 单个分类层名里不允许出现的字符（`/` 是节点值的分隔符；空白会与环境里的引号打架）
BAD_CHARS = '/'

#: 报告里最多列几个分类（封顶，数字仍然是完整的）
MAX_LISTED = 40


def _no_dupe_pairs(pairs):
    """`object_pairs_hook`：同一个对象里**键重复**直接报（JSON 会静默留最后一个）"""
    out = {}
    for key, value in pairs:
        if key in out:
            raise ValueError('同一个对象里键「%s」出现了两次（JSON 会静默留最后一个）' % key)
        out[key] = value
    return out


def read_registry(path: str) -> dict:
    """
    读文件 → 校验 → 返回文档（`raises ValueError`，消息里带**是哪一条**判据）。

    ⚠️ 用 `_no_dupe_pairs` 而不是裸 `json.load`：手改这份文件最容易犯的就是重复键
    （复制一层忘了改名），而 `json` 默认**静默**只留最后一个。
    """
    try:
        with open(path, encoding='utf-8-sig') as fh:
            doc = json.load(fh, object_pairs_hook=_no_dupe_pairs)
    except OSError as err:
        raise ValueError('读不了 %s：%s' % (path, err))
    except ValueError as err:
        raise ValueError('%s 不是合法 JSON：%s' % (path, err))
    return parse_registry(doc, path)


def _is_int(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def parse_registry(doc, where: str = 'nature-registry.json') -> dict:
    """
    校验一份注册表文档 ⇒ **规范化后的新对象**（不改调用方那份）。

    @raises ValueError 消息 = "哪里错了 + 怎么办"，直接可以给用户看。
    """
    if not isinstance(doc, dict):
        raise ValueError('%s 顶层必须是对象' % where)
    if not _is_int(doc.get('registryVersion')) or int(doc['registryVersion']) < 1:
        raise ValueError('%s 的 `registryVersion` 必须是 ≥1 的整数' % where)
    note = doc.get('note')
    if note is not None and not (isinstance(note, list) and all(isinstance(x, str) for x in note)):
        raise ValueError('%s 的 `note` 要么不写，要么是**字符串数组**（一行一条）' % where)

    fields = doc.get('fields')
    if not isinstance(fields, dict) or not fields:
        raise ValueError('%s 的 `fields` 必须是非空对象（性质那几维各自怎么存）' % where)
    out_fields = {}
    class_path_fields = []
    for key, defn in fields.items():
        name = str(key or '')
        if not name.strip():
            raise ValueError('%s 的 `fields` 里有空键名' % where)
        if not isinstance(defn, dict):
            raise ValueError('%s 的 `fields.%s` 必须是对象（现在给的是 %s）'
                             % (where, name, type(defn).__name__))
        label = defn.get('label')
        if not (isinstance(label, str) and label.strip()):
            raise ValueError('%s 的 `fields.%s` 缺 `label`（界面上那一格叫什么）' % (where, name))
        kind = defn.get('kind')
        if kind not in KINDS:
            raise ValueError('%s 的 `fields.%s.kind` 必须是 %s 之一（现在写的是 %r）'
                             % (where, name, ' / '.join(KINDS), kind))
        pattern = defn.get('pattern')
        if kind == 'pattern' and not (isinstance(pattern, str) and pattern.strip()):
            raise ValueError('%s 的 `fields.%s` 是 `pattern` 档 ⇒ **必须**给 `pattern`' % (where, name))
        if pattern is not None:
            if not isinstance(pattern, str):
                raise ValueError('%s 的 `fields.%s.pattern` 必须是字符串' % (where, name))
            try:
                re.compile(pattern)
            except re.error as err:
                raise ValueError('%s 的 `fields.%s.pattern` 编不出来（%s）—— '
                                 '`crate.py` 会在 import 期就崩' % (where, name, err))
        if kind == 'classPath':
            class_path_fields.append(name)
        out_fields[name] = dict(defn)
    if len(class_path_fields) != 1:
        raise ValueError('%s 的 `fields` 里 `classPath` 必须**恰好一条**（现在是 %d 条：%s）'
                         % (where, len(class_path_fields), ', '.join(class_path_fields) or '无'))

    trie = doc.get('classTrie')
    if not isinstance(trie, dict) or not trie:
        raise ValueError('%s 的 `classTrie` 必须是非空对象（分类树）' % where)

    special_seen = {name: 0 for name in CLASS_SPECIAL}
    levels = {'max': 0, 'leaves': 0}

    def walk(node, path):
        if not isinstance(node, dict):
            raise ValueError('%s 的分类「%s」不是对象（分类树只能是"对象套对象"；'
                             '叶子写成 `{}`）' % (where, '/'.join(path) or '(根)'))
        levels['max'] = max(levels['max'], len(path))
        if not node:
            levels['leaves'] += 1
            if path and path[-1] in special_seen:
                special_seen[path[-1]] += 1
            return
        for key, child in node.items():
            name = str(key or '')
            if not name.strip():
                raise ValueError('%s 的分类「%s」下有一个空键名' % (where, '/'.join(path) or '(根)'))
            if name != name.strip():
                raise ValueError('%s 的分类名「%s」有首尾空白（写进节点值就是另一个分类）'
                                 % (where, name))
            if BAD_CHARS in name:
                raise ValueError('%s 的分类名「%s」里带了 `%s` —— 那是**写进节点时的分隔符**，'
                                 '会把两层压成一层' % (where, name, BAD_CHARS))
            walk(child, path + [name])

    walk(trie, [])
    missing = [n for n, c in special_seen.items() if not c]
    if missing:
        raise ValueError('%s 的分类树里少了特殊叶子：%s（`natureFields.js` 的常量按字面比，'
                         '缺一片就有一条值判不出来）' % (where, '、'.join(missing)))

    out = dict(doc)
    out['fields'] = out_fields
    return out


def class_paths(doc) -> list:
    """分类树里**所有叶子路径**（`['xcpc/icpc/aa/pre/official', …]`，字典序）"""
    out = []

    def walk(node, path):
        if not isinstance(node, dict):
            return
        if not node:
            if path:
                out.append('/'.join(path))
            return
        for key, child in node.items():
            walk(child, path + [str(key)])

    walk((doc or {}).get('classTrie') or {}, [])
    return sorted(out)


def registry_summary(doc) -> dict:
    """给界面/报告用的一行概况（数字都取整份，不封顶）"""
    fields = (doc or {}).get('fields') or {}
    paths = class_paths(doc)
    special = {}
    for name in CLASS_SPECIAL:
        special[name] = sum(1 for p in paths if p.split('/')[-1] == name)
    roots = list(((doc or {}).get('classTrie') or {}).keys())
    return {
        'version': int((doc or {}).get('registryVersion') or 0),
        'fields': [{'key': k, 'label': str(v.get('label') or ''), 'kind': str(v.get('kind') or '')}
                   for k, v in fields.items()],
        'classPaths': len(paths),
        'roots': [str(r) for r in roots],
        'special': special,
    }


def _leaf_set(doc) -> set:
    return set(class_paths(doc))


def registry_diff(old, new) -> dict:
    """
    两份注册表的差别（只比**分类叶子**与**字段名单**；给"保存前预览/保存后回执"用）。

    ⚠️ 分类是**有序**的（`a/b/c`），但"顺序"在 JSON 对象里只对**同一层**有意义 ——
    这里只报"多了/少了哪些整条路径"，不报同级顺序变化（那属于界面自己的事）。
    """
    a = _leaf_set(old or {})
    b = _leaf_set(new or {})
    fa = set(((old or {}).get('fields') or {}).keys())
    fb = set(((new or {}).get('fields') or {}).keys())
    added = sorted(b - a)
    removed = sorted(a - b)
    return {
        'addedClasses': added[:MAX_LISTED],
        'removedClasses': removed[:MAX_LISTED],
        'addedClassCount': len(added),
        'removedClassCount': len(removed),
        'keptClassCount': len(a & b),
        'addedFields': sorted(fb - fa),
        'removedFields': sorted(fa - fb),
        'listed': MAX_LISTED,
    }


def _selftest() -> int:
    from selftest_kit import Selftest
    st = Selftest('性质注册表校验')
    ok = st.ok

    base = {
        'registryVersion': 1,
        'note': ['一行说明'],
        'fields': {
            'natureClass': {'label': '分类', 'kind': 'classPath'},
            'natureYear': {'label': '年份', 'kind': 'pattern', 'pattern': r'^(20\d{2}|无)$'},
        },
        'classTrie': {'xcpc': {'icpc': {'aa': {'pre': {'official': {}, '无归类': {}, '未归类': {},
                                                       '上游异常': {}}}}}},
    }
    ok(isinstance(parse_registry(base), dict), '正例：一份最小合法注册表能过')
    ok(class_paths(base) == sorted([
        'xcpc/icpc/aa/pre/official', 'xcpc/icpc/aa/pre/无归类',
        'xcpc/icpc/aa/pre/未归类', 'xcpc/icpc/aa/pre/上游异常']),
       '分类叶子能列出来（按码点字典序，不按拼音）')
    ok(registry_summary(base)['special'] == {'无归类': 1, '未归类': 1, '上游异常': 1},
       '概况里数得出三片特殊叶子')

    def bad(mutate, why):
        doc = json.loads(json.dumps(base))
        mutate(doc)
        try:
            parse_registry(doc)
        except ValueError as err:
            return ok(True, why, str(err)[:60])
        return ok(False, '%s（居然没报错）' % why)

    bad(lambda d: d.pop('classTrie'), '顶层缺 `classTrie` ⇒ 报错')
    bad(lambda d: d.update(registryVersion='1'), '`registryVersion` 是字符串 ⇒ 报错')
    bad(lambda d: d.update(note='一段话'), '`note` 不是数组 ⇒ 报错')
    bad(lambda d: d['fields']['natureYear'].pop('pattern'), '`pattern` 档缺 pattern ⇒ 报错')
    bad(lambda d: d['fields']['natureYear'].update(pattern='^(20\\d{2}'), '坏正则 ⇒ 报错')
    bad(lambda d: d['fields']['natureYear'].update(kind='whatever'), '`kind` 不在词表 ⇒ 报错')
    bad(lambda d: d['fields']['natureClass'].update(kind='text'),
        '一条 `classPath` 都没有 ⇒ 报错')
    bad(lambda d: d['fields'].update(natureSeason={'label': '赛季', 'kind': 'classPath'}),
        '两条 `classPath` ⇒ 报错')
    bad(lambda d: d['classTrie']['xcpc']['icpc'].update({'a/b': {}}), '分类名里带 `/` ⇒ 报错')
    bad(lambda d: d['classTrie']['xcpc']['icpc'].update({' aa': {}}), '分类名有首尾空白 ⇒ 报错')
    bad(lambda d: d['classTrie']['xcpc']['icpc'].update({'ec': 'official'}),
        '叶子不是对象（写成字符串）⇒ 报错')
    bad(lambda d: d['classTrie']['xcpc']['icpc']['aa']['pre'].pop('无归类'),
        '少了特殊叶子 `无归类` ⇒ 报错')

    # 反向锚：**只在注释/别处**出现的字面量不算数，必须是真的形状规则
    ok(not _is_int(True), '布尔不算整数（`registryVersion: true` 要被挡下）')

    # 差异：只报整条路径的增减
    other = json.loads(json.dumps(base))
    other['classTrie']['xcpc']['icpc']['aa']['pre']['newbie'] = {}
    other['fields']['natureRegion'] = {'label': '地区', 'kind': 'text'}
    d = registry_diff(base, other)
    ok(d['addedClassCount'] == 1 and d['addedClasses'] == ['xcpc/icpc/aa/pre/newbie'],
       '差异报出新增的分类路径')
    ok(d['addedFields'] == ['natureRegion'] and not d['removedFields'], '差异报出新增的字段')

    # 真实那份文件必须自己过一遍（改了仓库里那份而没跑这条 = 白改）
    real = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                        'acm-data', 'nature-registry.json')
    if os.path.isfile(real):
        doc = read_registry(real)
        s = registry_summary(doc)
        ok(s['classPaths'] > 0 and all(s['special'].values()),
           '仓库里那份 `acm-data/nature-registry.json` 过校验（三片特殊叶子都在）',
           '分类 %d 条 / 根 %s' % (s['classPaths'], ','.join(s['roots'])))
    else:
        ok(False, '找不到仓库里那份 `acm-data/nature-registry.json`')
    return st.done()


if __name__ == '__main__':
    sys.exit(_selftest())
