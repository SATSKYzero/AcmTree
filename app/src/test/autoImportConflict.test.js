// ================================================================
// extKey 冲突检测测试（core/validate/upsertConflict.js）
// 依据：docs/auto-import.md 2.4 / 3.2 / 4.7 / 8.5
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    collectExtKeyConflicts,
    collectBatchExtKeyConflicts,
    checkExtKeyUnique
} from '../core/validate/upsertConflict.js';

function makeState(entries = []) {
    const state = { rootId: 'o', nodes: {}, childOrder: {}, parentOf: {} };
    for (const [id, extra] of entries) {
        state.nodes[id] = { id, type: 'P', name: id, ...extra };
        state.childOrder[id] = [];
    }
    return state;
}

// ================================================================
// collectExtKeyConflicts —— 全局唯一（2.4 约束）
// ================================================================

test('collectExtKeyConflicts 无冲突时返回空数组', () => {
    const s = makeState([['a', { extKey: 'x' }], ['b', { extKey: 'y' }]]);
    assert.deepEqual(collectExtKeyConflicts(s), []);
});

test('collectExtKeyConflicts 检出跨容器的同 key 冲突（全局唯一）', () => {
    // 两棵子树下各有一个 qoj:4113 —— 这正是 2.4 说的歧义来源
    const s = { rootId: 'o', nodes: {}, childOrder: {}, parentOf: {} };
    s.nodes.o = { id: 'o', type: 'O' };
    s.nodes.c1 = { id: 'c1', type: 'C', extKey: 'qoj:4113' };
    s.nodes.c2 = { id: 'c2', type: 'C', extKey: 'qoj:4113' };
    s.childOrder = { o: ['c1', 'c2'], c1: [], c2: [] };
    s.parentOf = { c1: 'o', c2: 'o' };

    const conflicts = collectExtKeyConflicts(s);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].extKey, 'qoj:4113');
    assert.deepEqual(conflicts[0].nodeIds.sort(), ['c1', 'c2']);
});

test('collectExtKeyConflicts 忽略空 extKey（空不是身份）', () => {
    const s = makeState([['a', { extKey: '' }], ['b', { extKey: '' }], ['c', {}]]);
    assert.deepEqual(collectExtKeyConflicts(s), []);
});

test('collectExtKeyConflicts 对前后空白做 trim 后比较', () => {
    const s = makeState([['a', { extKey: 'qoj' }], ['b', { extKey: ' qoj ' }]]);
    const conflicts = collectExtKeyConflicts(s);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].extKey, 'qoj');
});

test('collectExtKeyConflicts 对无效 state 返回空数组', () => {
    assert.deepEqual(collectExtKeyConflicts(null), []);
    assert.deepEqual(collectExtKeyConflicts({}), []);
});

// ================================================================
// collectBatchExtKeyConflicts —— 包内重复（4.7）
// ================================================================

test('collectBatchExtKeyConflicts 检出包内重复并给出行下标', () => {
    const records = [
        { extKey: 'a' },
        { extKey: 'b' },
        { extKey: 'a' }
    ];
    const dups = collectBatchExtKeyConflicts(records);
    assert.equal(dups.length, 1);
    assert.equal(dups[0].extKey, 'a');
    assert.deepEqual(dups[0].indexes, [0, 2]);
});

test('collectBatchExtKeyConflicts 忽略缺 key 的记录（由 plan 层单独报错）', () => {
    const records = [{ extKey: '' }, {}, { extKey: '' }];
    assert.deepEqual(collectBatchExtKeyConflicts(records), []);
});

test('collectBatchExtKeyConflicts 多组重复各报一条', () => {
    const records = [
        { extKey: 'a' }, { extKey: 'b' }, { extKey: 'a' }, { extKey: 'b' }
    ];
    const dups = collectBatchExtKeyConflicts(records);
    assert.equal(dups.length, 2);
    assert.deepEqual(dups.map(d => d.extKey).sort(), ['a', 'b']);
});

test('collectBatchExtKeyConflicts 对无效输入返回空数组', () => {
    assert.deepEqual(collectBatchExtKeyConflicts(null), []);
    assert.deepEqual(collectBatchExtKeyConflicts(undefined), []);
    assert.deepEqual(collectBatchExtKeyConflicts({}), []);
});

// ================================================================
// checkExtKeyUnique —— 补身份键预检（8.5）
// ================================================================

test('checkExtKeyUnique 可用时返回 ok', () => {
    const s = makeState([['a', {}], ['b', { extKey: 'other' }]]);
    const res = checkExtKeyUnique(s, 'a', 'fresh');
    assert.equal(res.ok, true);
});

test('checkExtKeyUnique 被别的节点占用 → 拒绝并指出持有者', () => {
    const s = makeState([['a', {}], ['b', { extKey: 'taken', name: 'B题' }]]);
    const res = checkExtKeyUnique(s, 'a', 'taken');
    assert.equal(res.ok, false);
    assert.equal(res.code, 'key-taken');
    assert.equal(res.holderId, 'b');
    assert.match(res.reason, /taken/);
});

test('checkExtKeyUnique 指向自己已有的 key 不算冲突（幂等预检）', () => {
    const s = makeState([['a', { extKey: 'mine' }]]);
    assert.equal(checkExtKeyUnique(s, 'a', 'mine').ok, true);
});

test('checkExtKeyUnique 空 key 与不存在的节点被拒', () => {
    const s = makeState([['a', {}]]);
    assert.equal(checkExtKeyUnique(s, 'a', '   ').code, 'empty-key');
    assert.equal(checkExtKeyUnique(s, 'nope', 'k').code, 'no-node');
});
