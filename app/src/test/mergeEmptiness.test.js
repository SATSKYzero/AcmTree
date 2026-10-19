// ================================================================
// "空值"的两套口径 —— 契约测试
//
// 应用里有**两个**判断"空"的函数，语义**故意不同**，但没有测试说明这件事，
// 下一个改代码的人很容易把其中一个"统一"掉 —— 那会静默改变导入或投影的行为。
//
//   merge.isEmptyValue            ← "这个位置**能不能被导入填上**"
//   elements.isEmptyFieldValue    ← "这个值**算不算有内容**（参不参与投影）"
//   trust.isEmptyValue            ← 同上（投影侧，与 elements 必须一致）
//
// 关键分歧点：`0`（= cfDifficulty 未填写）与 `'-'`（= 还没判/未填写）——
// 导入侧当空（该被填上）、投影侧当非空（是合法标记）。
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isEmptyValue as mergeEmpty } from '../features/AutoImport/merge.js';
import { isEmptyFieldValue as elemEmpty } from '../core/model/elements.js';
import { isEmptyValue as trustEmpty } from '../core/trust.js';

const PLACEHOLDER = '----.--.-- --:--';

test('导入侧（merge）：`0` / `\'\'` / 占位符 都算空 —— 该被数据填上', () => {
    assert.equal(mergeEmpty(''), true, '空串');
    assert.equal(mergeEmpty('   '), true, '空白');
    assert.equal(mergeEmpty(0), true, 'cfDifficulty:0 = 未填写难度（不是"难度为零"）');
    assert.equal(mergeEmpty(undefined), true);
    assert.equal(mergeEmpty(null), true);
    assert.equal(mergeEmpty([]), true, '空列表');
    assert.equal(mergeEmpty('-'), true, '`-` = 还没判 → 该被填上');
    assert.equal(mergeEmpty(PLACEHOLDER), true, '时间占位符');
    assert.equal(mergeEmpty('AC'), false);
    assert.equal(mergeEmpty(1500), false, '真难度值');
});

test('投影侧（elements / trust）：`0` / `-` **不算空** —— 它们是合法标记', () => {
    for (const [name, fn] of [['elements', v => elemEmpty('status', v)], ['trust', trustEmpty]]) {
        assert.equal(fn(''), true, `${name}: 空串算空`);
        assert.equal(fn('   '), true, `${name}: 空白算空`);
        assert.equal(fn(null), true, `${name}: null 算空`);
        assert.equal(fn(0), false, `${name}: 0 是值（不是空）`);
        assert.equal(fn('-'), false, `${name}: \`-\` 是"还没判"的合法标记`);
        assert.equal(fn('AC'), false, `${name}: 正常值`);
    }
    // tags 是列表型：空列表算空（这一条 elements 独有，按 shape 判）
    assert.equal(elemEmpty('tags', []), true);
    assert.equal(elemEmpty('tags', ['dp']), false);
});

test('两套口径在"正常值"上一致（分歧只在 0 / \'-\' / 占位符）', () => {
    for (const v of ['AC', 'WA', 1500, '2026.09.24 01:18']) {
        assert.equal(mergeEmpty(v), false, `merge 认为 ${JSON.stringify(v)} 非空`);
        assert.equal(trustEmpty(v), false, `trust 认为 ${JSON.stringify(v)} 非空`);
    }
});
