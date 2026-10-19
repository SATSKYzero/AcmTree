// ================================================================
// 一级 Tab 注册表解析测试（纯逻辑）
// ================================================================
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
    resolveTabs,
    pickTab,
    isKnownTabId,
    tabContentId,
    DEFAULT_TAB_ID,
    PLUGIN_TAB_ORDER
} from '../ui/tabRegistry.js';
import { registerTab, __resetRegistryForTest } from '../core/pluginRegistry.js';

const BUILTINS = [
    { id: 'main', label: '🏠 主视图', order: 0 },
    { id: 'stats', label: '📊 数据统计', order: 10 },
    { id: 'filter', label: '🔍 排序筛选', order: 20 }
];

beforeEach(() => {
    __resetRegistryForTest();
});

test('tabContentId 生成约定容器 id', () => {
    assert.equal(tabContentId('main'), 'tab-main');
    assert.equal(tabContentId('myPlugin'), 'tab-myPlugin');
});

test('DEFAULT_TAB_ID 为 main', () => {
    assert.equal(DEFAULT_TAB_ID, 'main');
});

test('只有内置 Tab 时保持原顺序', () => {
    const tabs = resolveTabs(BUILTINS, []);
    assert.deepEqual(tabs.map(t => t.id), ['main', 'stats', 'filter']);
    assert.equal(tabs.every(t => t.isPlugin === false), true);
});

test('插件 Tab 默认排在内置之后', () => {
    const tabs = resolveTabs(BUILTINS, [{ id: 'plugin', label: '🧩 插件' }]);
    assert.deepEqual(tabs.map(t => t.id), ['main', 'stats', 'filter', 'plugin']);
    assert.equal(tabs[3].isPlugin, true);
    assert.equal(tabs[3].order, PLUGIN_TAB_ORDER);
});

test('插件 Tab 可用 order 插到内置之间', () => {
    const tabs = resolveTabs(BUILTINS, [{ id: 'plugin', label: '🧩', order: 15 }]);
    assert.deepEqual(tabs.map(t => t.id), ['main', 'stats', 'plugin', 'filter']);
});

test('插件 Tab 与内置 id 冲突时被跳过', () => {
    const warnings = [];
    const original = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
        const tabs = resolveTabs(BUILTINS, [{ id: 'stats', label: '劫持统计' }]);
        assert.deepEqual(tabs.map(t => t.id), ['main', 'stats', 'filter']);
        assert.equal(tabs[1].label, '📊 数据统计');
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /冲突/);
    } finally {
        console.warn = original;
    }
});

test('缺省插件参数时自动取全局注册表', () => {
    registerTab({ id: 'fromRegistry', label: '🧩 注册表页', mount: () => {} });
    const tabs = resolveTabs(BUILTINS);
    assert.deepEqual(tabs.map(t => t.id), ['main', 'stats', 'filter', 'fromRegistry']);
    assert.equal(tabs[3].isPlugin, true);
});

test('pickTab 命中 / 回退 / 空列表', () => {
    const tabs = resolveTabs(BUILTINS, []);
    assert.equal(pickTab(tabs, 'stats').id, 'stats');
    assert.equal(pickTab(tabs, 'not-exist').id, 'main');
    assert.equal(pickTab([], 'main'), null);
});

test('isKnownTabId 覆盖内置与插件', () => {
    registerTab({ id: 'plugin', label: '🧩', mount: () => {} });
    const tabs = resolveTabs(BUILTINS);
    assert.equal(isKnownTabId(tabs, 'main'), true);
    assert.equal(isKnownTabId(tabs, 'plugin'), true);
    assert.equal(isKnownTabId(tabs, 'ghost'), false);
});
