// ================================================================
// 校验层测试
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getCurrentRenderedCount, validateExpandedLimit } from '../core/validate/expanded.js';
import { collectPNodeConflicts, checkProblemIdUnique } from '../core/validate/conflict.js';

function makeState() {
    return { rootId: null, nodes: {}, childOrder: {}, parentOf: {}, view: { expanded: {} } };
}

function addNode(state, id, type, parentId = null, extra = {}) {
    state.nodes[id] = { id, type, ...extra };
    // 展开态住在 `state.view.expanded`（稀疏：只记展开的），**不在节点上**
    if (extra.expanded) state.view.expanded[id] = true;
    state.childOrder[id] = [];
    if (parentId === null) {
        state.rootId = id;
        state.parentOf[id] = null;
    } else {
        state.childOrder[parentId].push(id);
        state.parentOf[id] = parentId;
    }
}

// ---- expanded ----
test('getCurrentRenderedCount 全折叠返回根的子节点数', () => {
    const s = makeState();
    addNode(s, 'o', 'O');
    addNode(s, 'w1', 'W', 'o', { expanded: false });
    addNode(s, 'w2', 'W', 'o', { expanded: false });
    assert.equal(getCurrentRenderedCount(s), 2);
});

test('getCurrentRenderedCount 展开后递归计算', () => {
    const s = makeState();
    addNode(s, 'o', 'O');
    addNode(s, 'w', 'W', 'o', { expanded: true });
    addNode(s, 'c1', 'C', 'w');
    addNode(s, 'c2', 'C', 'w');
    // O 下的 W 计 1 + W 展开后的 2 个 C
    assert.equal(getCurrentRenderedCount(s), 3);
});

test('validateExpandedLimit 超限返回 false', () => {
    const s = makeState();
    addNode(s, 'o', 'O');
    for (let i = 0; i < 10; i++) {
        addNode(s, `w${i}`, 'W', 'o');
    }
    assert.equal(validateExpandedLimit(s, 20), true);
    assert.equal(validateExpandedLimit(s, 5), false);
});

// ---- conflict ----
test('collectPNodeConflicts 检测重名', () => {
    const s = makeState();
    addNode(s, 'o', 'O');
    addNode(s, 'c', 'C', 'o');
    addNode(s, 'p1', 'P', 'c', { name: '题A', problemId: 'A' });
    const conflicts = collectPNodeConflicts(s, 'c', '题A', null);
    assert.equal(conflicts.length, 1);
    assert.match(conflicts[0], /已存在/);
});

test('collectPNodeConflicts 检测重复题号', () => {
    const s = makeState();
    addNode(s, 'o', 'O');
    addNode(s, 'c', 'C', 'o');
    addNode(s, 'p1', 'P', 'c', { name: '题A', problemId: 'A' });
    const conflicts = collectPNodeConflicts(s, 'c', null, 'A');
    assert.equal(conflicts.length, 1);
    assert.match(conflicts[0], /题号/);
});

test('collectPNodeConflicts 排除自身', () => {
    const s = makeState();
    addNode(s, 'o', 'O');
    addNode(s, 'c', 'C', 'o');
    addNode(s, 'p1', 'P', 'c', { name: '题A', problemId: 'A' });
    const conflicts = collectPNodeConflicts(s, 'c', '题A', 'A', 'p1');
    assert.equal(conflicts.length, 0);
});

test('checkProblemIdUnique 检测同 C 下的题号重复', () => {
    const s = makeState();
    addNode(s, 'o', 'O');
    addNode(s, 'c', 'C', 'o');
    addNode(s, 'p1', 'P', 'c', { problemId: 'A' });
    addNode(s, 'p2', 'P', 'c', { problemId: 'A' });
    const dups = checkProblemIdUnique(s, 'c');
    assert.deepEqual(dups, ['A']);
});