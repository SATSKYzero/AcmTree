// ================================================================
// 查询层测试
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    getNode, getChildIds, getChildren, getParentId, getParent,
    getRoot, getSiblings, getAncestors, getDescendants,
    getSubtreeIds, isAncestor, getDepth, getPath
} from '../core/query/nodes.js';

import {
    collectByType, collectAllByType, countNodes,
    collectPStats, collectCStats, getGlobalStats,
    formatProblemCounts, formatContestCounts
} from '../core/query/stats.js';

function makeState() {
    return { rootId: null, nodes: {}, childOrder: {}, parentOf: {} };
}

function addNode(state, id, type, parentId = null, extra = {}) {
    state.nodes[id] = { id, type, ...extra };
    state.childOrder[id] = [];
    if (parentId === null) {
        state.rootId = id;
        state.parentOf[id] = null;
    } else {
        state.childOrder[parentId].push(id);
        state.parentOf[id] = parentId;
    }
}

// 构造一棵树：
//   O
//   └─ W
//      ├─ S1
//      │  └─ C1
//      │     ├─ P1
//      │     └─ P2
//      └─ S2
function makeTree() {
    const s = makeState();
    addNode(s, 'O', 'O');
    addNode(s, 'W', 'W', 'O');
    addNode(s, 'S1', 'S', 'W');
    addNode(s, 'S2', 'S', 'W');
    addNode(s, 'C1', 'C', 'S1');
    addNode(s, 'P1', 'P', 'C1', { status1: 1, status2: 4 });
    addNode(s, 'P2', 'P', 'C1', { status1: 0, status2: 0 });
    return s;
}

test('getNode 取节点', () => {
    const s = makeTree();
    assert.equal(getNode(s, 'P1').type, 'P');
    assert.equal(getNode(s, '不存在'), null);
});

test('getChildIds 返回子 id 数组', () => {
    const s = makeTree();
    assert.deepEqual(getChildIds(s, 'W'), ['S1', 'S2']);
    assert.deepEqual(getChildIds(s, 'P1'), []);
});

test('getChildren 返回子对象数组', () => {
    const s = makeTree();
    const children = getChildren(s, 'W');
    assert.equal(children.length, 2);
    assert.equal(children[0].id, 'S1');
    assert.equal(children[1].id, 'S2');
});

test('getParentId / getParent', () => {
    const s = makeTree();
    assert.equal(getParentId(s, 'P1'), 'C1');
    assert.equal(getParent(s, 'P1').type, 'C');
    assert.equal(getParentId(s, 'O'), null);
});

test('getRoot', () => {
    const s = makeTree();
    assert.equal(getRoot(s).id, 'O');
});

test('getSiblings', () => {
    const s = makeTree();
    const sib = getSiblings(s, 'S1');
    assert.equal(sib.length, 2);
    assert.ok(sib.some(n => n.id === 'S2'));
});

test('getAncestors 从父到根', () => {
    const s = makeTree();
    const anc = getAncestors(s, 'P1');
    assert.deepEqual(anc.map(n => n.id), ['C1', 'S1', 'W', 'O']);
});

test('getDescendants 先序', () => {
    const s = makeTree();
    const desc = getDescendants(s, 'W');
    assert.deepEqual(desc.map(n => n.id), ['S1', 'C1', 'P1', 'P2', 'S2']);
});

test('getSubtreeIds 含自身', () => {
    const s = makeTree();
    const ids = getSubtreeIds(s, 'S1');
    assert.deepEqual(ids, ['S1', 'C1', 'P1', 'P2']);
});

test('isAncestor', () => {
    const s = makeTree();
    assert.equal(isAncestor(s, 'W', 'P1'), true);
    assert.equal(isAncestor(s, 'S2', 'P1'), false);
    assert.equal(isAncestor(s, 'P1', 'P1'), true);
});

test('getDepth', () => {
    const s = makeTree();
    assert.equal(getDepth(s, 'O'), 0);
    assert.equal(getDepth(s, 'W'), 1);
    assert.equal(getDepth(s, 'P1'), 4);
});

test('getPath 从根到当前', () => {
    const s = makeTree();
    const path = getPath(s, 'P1');
    assert.deepEqual(path.map(n => n.id), ['O', 'W', 'S1', 'C1', 'P1']);
});

// ---- stats ----
test('collectByType 收集子树指定类型', () => {
    const s = makeTree();
    const ps = collectByType(s, 'C1', 'P');
    assert.equal(ps.length, 2);
    assert.deepEqual(ps.map(p => p.id), ['P1', 'P2']);
});

test('collectAllByType 全树收集', () => {
    const s = makeTree();
    const ws = collectAllByType(s, 'W');
    assert.equal(ws.length, 1);
    assert.equal(ws[0].id, 'W');
});

test('countNodes 节点总数', () => {
    const s = makeTree();
    assert.equal(countNodes(s), 7);
});

test('collectPStats', () => {
    const s = makeTree();
    const st = collectPStats(s, 'O');
    assert.equal(st.total, 2);
    assert.equal(st.passed, 1);         // P1 status2=4
    assert.equal(st.passedIgnore, 1);   // P1 status2=3或4
    assert.equal(st.processed, 1);      // P1 status1=1
    assert.equal(st.processedIgnore, 1);
});

test('collectCStats', () => {
    const s = makeTree();
    // 给 C1 设置 statusComplete2 = 3
    s.nodes['C1'].statusComplete2 = 3;
    const st = collectCStats(s, 'O');
    assert.equal(st.total, 1);
    assert.equal(st.ak, 1);
});

test('getGlobalStats 返回格式化字符串', () => {
    const s = makeTree();
    s.nodes['C1'].statusComplete2 = 3;
    const stats = getGlobalStats(s);
    // ⚠️ `\d{2,}`（两位起）而不是 `\d+`：后者放过了"最后一档只有一位"这个 bug
    //（`00/11/00/00/14` 里最后那个总数会变成 `/7`）
    assert.match(stats.cStr, /^C:\d{2,}\/\d{2,}\/\d{2,}\/\d{2,}\/\d{2,}$/);
    assert.match(stats.pStr, /^P:\d{2,}\/\d{2,}\/\d{2,}\/\d{2,}\/\d{2,}$/);
});

// 计数器补零：**每一档都至少两位，包括最后那个"总数"**（设计口径，见 `core/query/stats.js` 的 `pad`）
test('计数器：总数只有一位时也要补成两位', () => {
    assert.equal(
        formatProblemCounts({ passed: 0, passedIgnore: 11, processed: 0, processedIgnore: 0, total: 7 }),
        '00/11/00/00/07');
    assert.equal(
        formatContestCounts({ ak: 2, proc: 3, contact: 4, ign: 0, total: 5 }),
        '02/03/04/00/05');
});

test('计数器：总数是三位时所有档同宽（按总数位数补零，原口径不变）', () => {
    assert.equal(
        formatProblemCounts({ passed: 1, passedIgnore: 11, processed: 2, processedIgnore: 3, total: 120 }),
        '001/011/002/003/120');
});

test('计数器：一题都没有时也是 `00/00/00/00/00`', () => {
    assert.equal(
        formatProblemCounts({ passed: 0, passedIgnore: 0, processed: 0, processedIgnore: 0, total: 0 }),
        '00/00/00/00/00');
});