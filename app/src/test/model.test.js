// ================================================================
// 数据模型测试
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createNode } from '../core/model/node.js';
import { createInitialState, rebuildParentOf } from '../core/model/state.js';
import { createPage, createVNode } from '../core/model/page.js';
import { TYPE_CHILDREN_MAP } from '../core/model/constants.js';

// ---- createNode ----
test('createNode 抛出未知类型', () => {
    assert.throws(() => createNode('n_1', 'X'), /未知节点类型/);
});

test('createNode 创建 P 节点带默认字段', () => {
    const node = createNode('n_1', 'P');
    assert.equal(node.id, 'n_1');
    assert.equal(node.type, 'P');
    assert.equal(node.status1, 0);
    assert.equal(node.status2, 0);
    assert.equal(node.problemId, '');
    assert.equal(node.cfDifficulty, 0);
    assert.equal(node.xcpcDifficulty, '-');
    assert.deepEqual(node.tags, []);
    assert.equal(node.acTime, '----.--.-- --:--');
});

test('createNode 支持 overrides', () => {
    const node = createNode('n_1', 'P', { name: '题1', status2: 3, tags: [{ id: 't1', text: 'dp', color: '红' }] });
    assert.equal(node.name, '题1');
    assert.equal(node.status2, 3);
    assert.equal(node.tags.length, 1);
});

test('createNode 对 O 类型不产生 children 字段', () => {
    const node = createNode('n_1', 'O');
    assert.equal('children' in node, false);
});

// ---- TYPE_CHILDREN_MAP ----
test('TYPE_CHILDREN_MAP 约束正确', () => {
    assert.deepEqual(TYPE_CHILDREN_MAP['O'], ['W', 'S']);
    assert.deepEqual(TYPE_CHILDREN_MAP['W'], ['S', 'W']);
    assert.deepEqual(TYPE_CHILDREN_MAP['S'], ['C', 'S']);
    assert.deepEqual(TYPE_CHILDREN_MAP['C'], ['P']);
    assert.deepEqual(TYPE_CHILDREN_MAP['P'], ['R']);
    assert.deepEqual(TYPE_CHILDREN_MAP['R'], []);
});

// ---- createInitialState ----
test('createInitialState 含 O 根节点', () => {
    const state = createInitialState();
    assert.ok(state.rootId);
    assert.ok(state.nodes[state.rootId]);
    assert.equal(state.nodes[state.rootId].type, 'O');
    assert.deepEqual(state.childOrder[state.rootId], []);
    assert.equal(state.parentOf[state.rootId], null);
    assert.equal(state.meta.idCounter, 1);
    assert.equal(state.currentPageId, 'main');
    assert.equal(state.currentTab, 'main');
});

test('createInitialState 不含 infoState', () => {
    const state = createInitialState();
    assert.equal('infoState' in state, false);
});

test('createInitialState 的 settings 是嵌套结构', () => {
    const state = createInitialState();
    assert.ok(state.settings.display);
    assert.ok(state.settings.performance);
    assert.ok(state.settings.stats);
    assert.ok(state.settings.mode);
    assert.equal(state.settings.display.nodePerPage, 20);
    assert.equal(state.settings.performance.expandedNodeBlockLimit, 5000);
});

// ---- rebuildParentOf ----
test('rebuildParentOf 从 childOrder 重建', () => {
    const childOrder = {
        'a': ['b', 'c'],
        'b': ['d'],
        'c': [],
        'd': []
    };
    const parentOf = rebuildParentOf(childOrder);
    assert.equal(parentOf['b'], 'a');
    assert.equal(parentOf['c'], 'a');
    assert.equal(parentOf['d'], 'b');
    assert.equal(parentOf['a'], undefined);
});

// ---- createPage / createVNode ----
test('createPage 创建带 O 根页面的结构', () => {
    const page = createPage('page_1', '题单', 'vroot_1');
    assert.equal(page.id, 'page_1');
    assert.equal(page.name, '题单');
    assert.equal(page.rootId, 'vroot_1');
    assert.deepEqual(page.virtualIndex, {});
    assert.equal(page.selected, false);
});

test('createVNode 创建虚拟节点', () => {
    const v = createVNode('v_1', 'n_1', 'P', 'vroot_1');
    assert.equal(v.id, 'v_1');
    assert.equal(v.refId, 'n_1');
    assert.equal(v.type, 'P');
    assert.equal(v.parentId, 'vroot_1');
    assert.deepEqual(v.children, []);
    assert.equal(v.expanded, false);
    assert.equal(v.selected, false);
});