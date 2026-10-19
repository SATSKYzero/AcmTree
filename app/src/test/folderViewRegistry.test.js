// ================================================================
// 文件夹节点视图注册表解析测试
// 只测纯逻辑（不碰 DOM），因此可直接在 Node 下运行
// ================================================================
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
    resolveFolderViews,
    pickFolderView,
    panelIdOf,
    PLUGIN_VIEW_ORDER
} from '../ui/folder/folderViewRegistry.js';
import {
    registerFolderView,
    __resetRegistryForTest
} from '../core/pluginRegistry.js';

const BUILTINS = [
    { id: 'children', label: '📂 子节点', order: 0, mount: () => {} },
    { id: 'stats', label: '📊 题目分布统计', order: 10, mount: () => {} }
];

beforeEach(() => {
    __resetRegistryForTest();
});

// ================================================================
// resolveFolderViews
// ================================================================

test('只有内置视图时按 order 排序且标记 isPlugin=false', () => {
    const views = resolveFolderViews(BUILTINS, []);
    assert.equal(views.length, 2);
    assert.deepEqual(views.map(v => v.id), ['children', 'stats']);
    assert.equal(views[0].isPlugin, false);
    assert.equal(views[1].isPlugin, false);
});

test('内置视图缺省 order 视为 0', () => {
    const views = resolveFolderViews([{ id: 'x', label: 'X', mount: () => {} }], []);
    assert.equal(views[0].order, 0);
});

test('插件视图排在末尾且标记 isPlugin=true', () => {
    const plugin = { id: 'timeline', label: '🕒 时间线', mount: () => {} };
    const views = resolveFolderViews(BUILTINS, [plugin]);

    assert.deepEqual(views.map(v => v.id), ['children', 'stats', 'timeline']);
    const added = views[2];
    assert.equal(added.isPlugin, true);
    assert.equal(added.order, PLUGIN_VIEW_ORDER);
});

test('插件可用 order 插到内置视图之前', () => {
    const plugin = { id: 'first', label: '⬆️ 置顶', order: -5, mount: () => {} };
    const views = resolveFolderViews(BUILTINS, [plugin]);
    assert.deepEqual(views.map(v => v.id), ['first', 'children', 'stats']);
    assert.equal(views[0].isPlugin, true);
});

test('插件 order 相同时保持注册先后顺序', () => {
    const views = resolveFolderViews(BUILTINS, [
        { id: 'p1', label: 'P1', order: 50, mount: () => {} },
        { id: 'p2', label: 'P2', order: 50, mount: () => {} }
    ]);
    assert.deepEqual(views.map(v => v.id), ['children', 'stats', 'p1', 'p2']);
});

test('插件 id 与内置视图冲突时跳过该插件', () => {
    const warnings = [];
    const original = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
        const views = resolveFolderViews(BUILTINS, [
            { id: 'stats', label: '劫持统计', mount: () => {} },
            { id: 'ok', label: 'OK', mount: () => {} }
        ]);
        assert.deepEqual(views.map(v => v.id), ['children', 'stats', 'ok']);
        // 内置视图未被替换
        assert.equal(views[1].label, '📊 题目分布统计');
        assert.equal(views[1].isPlugin, false);
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /冲突/);
    } finally {
        console.warn = original;
    }
});

test('两个插件注册相同 id 时后者被跳过', () => {
    const warnings = [];
    const original = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
        const views = resolveFolderViews(BUILTINS, [
            { id: 'dup', label: '先', mount: () => {} },
            { id: 'dup', label: '后', mount: () => {} }
        ]);
        assert.equal(views.filter(v => v.id === 'dup').length, 1);
        assert.equal(views.find(v => v.id === 'dup').label, '先');
        assert.equal(warnings.length, 1);
    } finally {
        console.warn = original;
    }
});

test('内置视图重复 id 时只保留第一个且不告警', () => {
    const views = resolveFolderViews([
        { id: 'a', label: '先', mount: () => {} },
        { id: 'a', label: '后', mount: () => {} }
    ], []);
    assert.equal(views.length, 1);
    assert.equal(views[0].label, '先');
});

test('忽略结构非法的条目', () => {
    const views = resolveFolderViews(BUILTINS, [null, undefined, {}, { label: '无 id', mount: () => {} }, { id: 123, label: 'x', mount: () => {} }]);
    assert.deepEqual(views.map(v => v.id), ['children', 'stats']);
});

test('不修改传入的定义对象', () => {
    const plugin = { id: 'p', label: 'P', mount: () => {} };
    resolveFolderViews(BUILTINS, [plugin]);
    assert.equal('isPlugin' in plugin, false);
    assert.equal('order' in plugin, false);
});

test('缺省插件参数时自动取全局注册表', () => {
    registerFolderView({ id: 'fromRegistry', label: '🧩 注册表', order: 5, mount: () => {} });
    const views = resolveFolderViews(BUILTINS);
    assert.deepEqual(views.map(v => v.id), ['children', 'fromRegistry', 'stats']);
    assert.equal(views[1].isPlugin, true);
});

// ================================================================
// pickFolderView
// ================================================================

test('pickFolderView 命中返回对应定义', () => {
    const views = resolveFolderViews(BUILTINS, []);
    assert.equal(pickFolderView(views, 'stats').id, 'stats');
});

test('pickFolderView 未命中回退到第一个视图', () => {
    const views = resolveFolderViews(BUILTINS, []);
    assert.equal(pickFolderView(views, 'not-exist').id, 'children');
});

test('pickFolderView 空列表返回 null', () => {
    assert.equal(pickFolderView([], 'x'), null);
    assert.equal(pickFolderView(null, 'x'), null);
});

// ================================================================
// panelIdOf
// ================================================================

test('panelIdOf 生成稳定的面板容器 id', () => {
    assert.equal(panelIdOf('timeline'), 'folder-view-panel-timeline');
});

// 同一个视图会被**两个宿主**同时挂载（主视图的文件夹页 + 节点信息大界面）：
// 面板是按 id 单例的 DOM 节点，不带 scope 就会互相覆盖
// （症状：看过节点页的概览后，回主视图文件夹页看到的是那个节点页的内容）。
test('panelIdOf 带 scope 时与不带 scope 互不相同', () => {
    assert.equal(panelIdOf('timeline', 'ni-node-cA'), 'folder-view-panel-ni-node-cA-timeline');
    assert.notEqual(panelIdOf('timeline', 'ni-node-cA'), panelIdOf('timeline'));
    assert.notEqual(panelIdOf('timeline', 'ni-a'), panelIdOf('timeline', 'ni-b'));
});
