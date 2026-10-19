// ================================================================
// 「一个字段怎么取」的**模板**（`core/model/elements.js` 的 `ELEMENTS.take`）
//
// 来由（2026-10-12）：这条规则本来**散在六处** —— 性质在 `elements.js`、聚合器在
// `groupValue.js` 的 `AGG_BUILDERS`、要不要回代在 `GROUP_FIELDS`、派生算法在 `derive.js`、
// 应有档位/字段组在 `fieldRegistry.js`、读法分流在 `view/scope.js` 的 `ownColumnReader`。
// 现在**"这一格有没有组值、要不要回代"收进 `take` 一行**，`GROUP_FIELDS` 由它派生。
//
// ⚠️ **"应有档位 / 字段组"刻意不并进来**：它们的源头是 `acm-data/field-registry.json`
// （它自称"『哪些字段应有』的单一真源"）—— 那份**随包发布**（`all_nodes.json` 顶层
// `fieldRegistry`）、**Python 也读**（`scripts/field-coverage.py`）⇒ 并进代码里就是**第二个源**。
// 判据：**要不要随包走 / 有没有第二个语言读它** —— 都否 ⇒ 代码表；有一项是 ⇒ 那份 JSON 注册表。
// （但两边字段名必须对得上 ⇒ 模板 ③ 钉住。）
//
// 这个文件钉这些事（改模板忘了改算法表 / 注册表写错名字 = 这里红）：
//   ① `take.agg` ⟺ `hasGroupAgg(field)`（**双向**）；①′ `take.agg` 必须与字段同名；
//   ② `GROUP_FIELDS` == `take.materialize` 的键（**派生关系**，不许再手写第二份清单）；②′ 回代必有聚合器；
//   ③ 注册表里的字段名都在 `ELEMENTS` 里；③′ 字段组成员同理。
//
// ⚠️ 有聚合器但**不是元素**的例外只有 `链接分类`（元列，不在 `ELEMENTS` 里）—— 下面钉住它。
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ELEMENTS } from '../core/model/elements.js';
import { GROUP_FIELDS, hasGroupAgg } from '../core/groupValue.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REGISTRY_PATH = path.join(REPO, 'acm-data', 'field-registry.json');

/** 有聚合器的**元列**（不是 `ELEMENTS` 的元素 —— 它的值不在来源层，见 `view/scope.js`） */
const META_COLUMNS_WITH_AGG = ['链接分类'];

const declaredAgg = (f) => !!(ELEMENTS[f] && ELEMENTS[f].take && ELEMENTS[f].take.agg);

test('模板 ①：`take.agg` 与聚合器表**双向**对齐', () => {
    const bad = [];
    for (const f of Object.keys(ELEMENTS)) {
        if (!hasGroupAgg(f)) continue;
        // 有聚合器的字段，模板里必须写清 `take.agg`（否则"这格有组那份"这件事在模板里看不出来）
        if (!declaredAgg(f)) bad.push(`${f}：有聚合器但没写 take.agg`);
    }
    assert.deepEqual(bad, [], bad.join('\n'));
});

test('模板 ①′：写了 `take.agg` 就必须真有那个聚合器（不许空头承诺）', () => {
    const bad = [];
    for (const f of Object.keys(ELEMENTS)) {
        const take = ELEMENTS[f].take;
        if (!take || !take.agg) continue;
        if (take.agg !== f) bad.push(`${f}：take.agg 写的是 ${take.agg}（聚合器按字段名登记，必须同名）`);
        if (!hasGroupAgg(f)) bad.push(`${f}：写了 take.agg 但 AGG_BUILDERS 里没有它`);
    }
    assert.deepEqual(bad, [], bad.join('\n'));
});

test('模板 ②：`GROUP_FIELDS` **由 take.materialize 派生**（逐项相同）', () => {
    const materialized = Object.keys(ELEMENTS)
        .filter((f) => ELEMENTS[f].take && ELEMENTS[f].take.materialize);
    assert.ok(materialized.length >= 5, `materialize 的字段太少（${materialized.length}）⇒ 守卫别是空转`);
    assert.deepEqual([...GROUP_FIELDS], materialized,
        '`GROUP_FIELDS` 必须逐项等于 `take.materialize` 的键（派生关系，不是第二份手写清单）');
    assert.deepEqual([...GROUP_FIELDS], [...new Set(GROUP_FIELDS)], '不许有重复项');
});

test('模板 ②′：回代（materialize）的字段必须都有聚合器', () => {
    for (const f of GROUP_FIELDS) {
        assert.ok(hasGroupAgg(f), `${f} 在 GROUP_FIELDS 里却没有聚合器`);
        assert.ok(declaredAgg(f), `${f} 在 GROUP_FIELDS 里却没有 take.agg`);
    }
});

// ================================================================
// 模板 ③：**随包发布的那份注册表**（`acm-data/field-registry.json`）里的字段名
//
// 那张注册表是"『哪些字段应有』的**单一真源**"（它自己的话），里面的 `fields`
// （档位 + `when` 谓词）与 `groups`（字段组）**随包发布**、**Python 也读**
// ⇒ 它**不该**并进 `ELEMENTS`（并了就是第二个源：JS 代码表 vs 随包的 JSON）。
//
// 但两边**必须对得上**：注册表里写了一个 `ELEMENTS` 里没有的字段名 ⇒ 那条规则永远命中不了，
// 而**现在没有任何东西会报**（体检报告只会"少报一格"，静默）。这条守卫把那种漂移变红。
// ================================================================
test('模板 ③：注册表里的字段名都必须在 `ELEMENTS` 里（防静默漂移）', () => {
    const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
    const names = new Set(Object.keys(registry.fields || {}));
    for (const g of Object.values(registry.groups || {})) {
        for (const f of (g.fields || [])) names.add(f);
    }
    assert.ok(names.size >= 15, `注册表里只扫到 ${names.size} 个字段名 ⇒ 守卫别是空转（结构变了？）`);

    const missing = [...names].filter((f) => !ELEMENTS[f]);
    assert.deepEqual(missing, [],
        `这些字段名出现在 \`acm-data/field-registry.json\` 里，但 \`ELEMENTS\` 没有：\n  ${missing.join('\n  ')}\n`
        + '要么是打错了，要么该字段得先在 `src/core/model/elements.js` 里登记一行'
        + '（注册表的规则永远命中不了 = 静默少报一格）。');
});

test('模板 ③′：字段组的成员都在 `ELEMENTS` 里，且组是"同一类信息"（≥2 个成员）', () => {
    const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
    const groups = registry.groups || {};
    assert.ok(Object.keys(groups).length >= 1, '至少得有一个组（数值难度）⇒ 守卫别是空转');
    for (const [name, g] of Object.entries(groups)) {
        const fields = g.fields || [];
        assert.ok(fields.length >= 2, `组「${name}」只有 ${fields.length} 个成员 —— 组的意义是"同义/同类字段"`);
        for (const f of fields) assert.ok(ELEMENTS[f], `组「${name}」的成员 \`${f}\` 不在 ELEMENTS 里`);
    }
});

test('模板的已知例外：`链接分类` 是**元列**（有聚合器但不在 ELEMENTS 里）', () => {
    assert.equal(hasGroupAgg('链接分类'), true,
        '元列 `链接分类` 有聚合器（各来源的链接要并起来）—— 它不在 ELEMENTS 里是刻意的，别删这条锚');
    assert.equal(ELEMENTS['链接分类'], undefined, '`链接分类` 不该进 ELEMENTS（它的值不在来源层）');
    for (const f of META_COLUMNS_WITH_AGG) assert.equal(hasGroupAgg(f), true, `${f} 是已知的元列例外`);
});
