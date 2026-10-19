// ================================================================
// status2 的"词 ↔ 值"单一来源
//
// 背景（修的是一个真矛盾）：批量导入里自己写了一张表 `{'通过': 4, …}` ——
// 把"通过"当成 **4 赛时通过**；而应用在没有 `R.submitKind` 证据时判的是
// **3 赛后补题**。同一个词，两处结论不同。
//
// 真源只有 `core/model/status.js` 一份：数字常量 + 中文别名表 + 与 `STATUS2_LABELS`
// 的**同序**关系，全部由本测试钉住。
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    S2_UNUSED, S2_TODO, S2_WA, S2_AFTER, S2_DURING, S2_IGNORE,
    STATUS2_ALIASES, pStatus2
} from '../core/model/status.js';
import { STATUS2_LABELS } from '../A_constants.js';

test('取值与文案同序（谁加了一档忘了另一边，这条会红）', () => {
    assert.equal(STATUS2_LABELS.length, 6);
    assert.equal(STATUS2_LABELS[S2_UNUSED], '未使用');
    assert.equal(STATUS2_LABELS[S2_TODO], '待写');
    assert.equal(STATUS2_LABELS[S2_WA], '已提交未通过');
    assert.equal(STATUS2_LABELS[S2_AFTER], '赛后补题');
    assert.equal(STATUS2_LABELS[S2_DURING], '赛时通过');
    assert.equal(STATUS2_LABELS[S2_IGNORE], '忽略');
});

test('`通过` → **3 赛后补题**，不是 4（导入不替用户断言"赛时"）', () => {
    assert.equal(STATUS2_ALIASES['通过'], S2_AFTER);
    assert.equal(STATUS2_ALIASES['过了'], S2_AFTER);
    // 与 pStatus2 的默认对齐：有 AC、但没"赛中交的"证据 ⇒ 3
    assert.equal(pStatus2(true, true, 0, false), S2_AFTER);
});

test('别名表里的每个词都指向一个合法取值，且"忽略/待写"没有歧义', () => {
    const valid = new Set([S2_UNUSED, S2_TODO, S2_WA, S2_AFTER, S2_DURING, S2_IGNORE]);
    for (const [word, v] of Object.entries(STATUS2_ALIASES)) {
        assert.ok(valid.has(v), `别名「${word}」指向非法值 ${v}`);
        // 每个别名的值都该能在文案表里查到（防止指向一个不存在的档）
        assert.equal(typeof STATUS2_LABELS[v], 'string', `别名「${word}」的值 ${v} 没有文案`);
    }
    assert.equal(STATUS2_ALIASES['忽略'], S2_IGNORE);
    assert.equal(STATUS2_ALIASES['待写'], S2_TODO);
});

test('想标"赛时通过"必须明写：别名表里有独立的词', () => {
    assert.equal(STATUS2_ALIASES['赛时通过'], S2_DURING);
    assert.notEqual(STATUS2_ALIASES['赛时通过'], STATUS2_ALIASES['通过']);
});
