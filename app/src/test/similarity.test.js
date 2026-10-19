// ================================================================
// 标题相似度测试（utils/similarity.js）
//
// 只钉两件事 —— 都是**判定别人怎么用它的规则**，不是算法本身的精度：
//   ① `blockingKey` 只取第一个 token（判重整理页靠它把两两比从 O(n²) 降下来）；
//   ② `findIntraBatchDuplicates` **不跨"树"比**：各渠道各自成节点是设计，
//      同一道题在 `xcpc:` 与 `qoj:` 下各有一份是预期，不是"key 不稳定"。
//
// 相似度本身是启发式，精度不由这里保证（阈值边界另见 docs/auto-import.md 4.6）。
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    blockingKey,
    findIntraBatchDuplicates,
    DEFAULT_SIMILARITY_THRESHOLD
} from '../utils/similarity.js';

test('blockingKey：只取第一个 token（短标题才不会永远对不上）', () => {
    assert.equal(blockingKey('2026 浙江省赛 第一场'), '2026');
    assert.equal(blockingKey('浙江省赛 2026'), '浙');
    assert.equal(blockingKey('Two Sum'), 'two');
    assert.equal(blockingKey('Two Sums'), 'two', '差一个字母的两条仍在同一块');
    assert.equal(blockingKey(''), '');
    assert.equal(blockingKey('   '), '');
});

test('blockingKey：取 n 个 token 时按前 n 个拼', () => {
    assert.equal(blockingKey('2026 浙江省赛', 2), '2026 浙');
});

test('包内重复：同一个"树"里标题相似、key 不同 → 报出来', () => {
    const dup = findIntraBatchDuplicates([
        { index: 0, extKey: 'xcpc:c:a:p:A', type: 'P', fields: { name: '最小LCM' } },
        { index: 1, extKey: 'xcpc:c:a:p:B', type: 'P', fields: { name: '最小 LCM ' } }
    ], DEFAULT_SIMILARITY_THRESHOLD);
    assert.equal(dup.length, 1);
});

test('包内重复：**跨树**（xcpc / qoj）不比 —— 各渠道各自成节点是设计', () => {
    const dup = findIntraBatchDuplicates([
        { index: 0, extKey: 'xcpc:c:bjcpc2025:p:I', type: 'P', fields: { name: '最小LCM' } },
        { index: 1, extKey: 'qoj:c:1986:p:10521', type: 'P', fields: { name: '最小LCM' } }
    ], DEFAULT_SIMILARITY_THRESHOLD);
    assert.deepEqual(dup, [], '同一道题在两棵树下各一份是预期，不该报"key 不稳定"');
});

test('包内重复：**跨父容器**也不比 —— 不同比赛出现同名题是正常的', () => {
    const dup = findIntraBatchDuplicates([
        { index: 0, extKey: 'xcpc:c:bjcpc2024:p:E', type: 'P', fields: { name: '删除01串' } },
        { index: 1, extKey: 'xcpc:c:ccpc2024chongqing:p:J', type: 'P', fields: { name: '删除01串' } }
    ], DEFAULT_SIMILARITY_THRESHOLD);
    assert.deepEqual(dup, [],
        '合并包里 1101 条这类报警全是不同比赛之间的同名题（实测），只会把真问题淹了');
});

test('包内重复：**同一父容器**下仍要比（这才是"同一道题两个 key"）', () => {
    const dup = findIntraBatchDuplicates([
        { index: 0, extKey: 'xcpc:c:bjcpc2024:p:E', type: 'P', fields: { name: '删除01串' } },
        { index: 1, extKey: 'xcpc:c:bjcpc2024:p:E2', type: 'P', fields: { name: '删除01串' } }
    ], DEFAULT_SIMILARITY_THRESHOLD);
    assert.equal(dup.length, 1);
});

test('包内重复：类型不同 / key 相同 都不比', () => {
    const dups = findIntraBatchDuplicates([
        { index: 0, extKey: 'xcpc:c:a', type: 'C', fields: { name: '最小LCM' } },
        { index: 1, extKey: 'xcpc:c:a:p:A', type: 'P', fields: { name: '最小LCM' } }
    ], DEFAULT_SIMILARITY_THRESHOLD);
    assert.deepEqual(dups, [], '跨类型比标题是噪声');

    const sameKey = findIntraBatchDuplicates([
        { index: 0, extKey: 'xcpc:c:a:p:A', type: 'P', fields: { name: '最小LCM' } },
        { index: 1, extKey: 'xcpc:c:a:p:A', type: 'P', fields: { name: '最小LCM' } }
    ], DEFAULT_SIMILARITY_THRESHOLD);
    assert.deepEqual(sameKey, [], 'key 相同属于"包内重复"那条独立路径');
});
