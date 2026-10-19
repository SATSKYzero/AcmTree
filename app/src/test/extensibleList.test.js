// ================================================================
// 可扩展列表合并测试（纯逻辑）
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mergeExtensible, pickById, hasId } from '../ui/extensibleList.js';

const BUILTINS = [
    { id: 'a', label: 'A', order: 0 },
    { id: 'b', label: 'B', order: 10 }
];

// ================================================================
// mergeExtensible
// ================================================================

test('只有内置项：按 order 排序且 isPlugin=false', () => {
    const list = mergeExtensible(BUILTINS, []);
    assert.deepEqual(list.map(x => x.id), ['a', 'b']);
    assert.equal(list[0].isPlugin, false);
});

test('内置项缺省 order 视为 0', () => {
    const list = mergeExtensible([{ id: 'x', label: 'X' }], []);
    assert.equal(list[0].order, 0);
});

test('插件项默认排在内置项之后且 isPlugin=true', () => {
    const list = mergeExtensible(BUILTINS, [{ id: 'p', label: 'P' }], { pluginOrder: 500 });
    assert.deepEqual(list.map(x => x.id), ['a', 'b', 'p']);
    assert.equal(list[2].isPlugin, true);
    assert.equal(list[2].order, 500);
});

test('pluginOrder 缺省为 100', () => {
    const list = mergeExtensible(BUILTINS, [{ id: 'p', label: 'P' }]);
    assert.equal(list[2].order, 100);
});

test('插件可用 order 插到内置项之间或之前', () => {
    const list = mergeExtensible(BUILTINS, [
        { id: 'mid', label: 'M', order: 5 },
        { id: 'first', label: 'F', order: -1 }
    ]);
    assert.deepEqual(list.map(x => x.id), ['first', 'a', 'mid', 'b']);
});

test('order 相同时保持注册先后（稳定排序）', () => {
    // 内置与插件 order 相同：内置先入列，故排在前；插件之间保持注册先后
    const builtins = [
        { id: 'a', label: 'A', order: 0 },
        { id: 'b', label: 'B', order: 50 }
    ];
    const list = mergeExtensible(builtins, [
        { id: 'p1', label: 'P1', order: 50 },
        { id: 'p2', label: 'P2', order: 50 }
    ]);
    assert.deepEqual(list.map(x => x.id), ['a', 'b', 'p1', 'p2']);
});

test('插件与内置 id 冲突：跳过插件并告警', () => {
    const warnings = [];
    const list = mergeExtensible(BUILTINS, [{ id: 'a', label: '劫持' }], {
        onConflict: def => warnings.push(def.id)
    });
    assert.deepEqual(list.map(x => x.id), ['a', 'b']);
    assert.equal(list[0].label, 'A');      // 内置未被替换
    assert.equal(list[0].isPlugin, false);
    assert.deepEqual(warnings, ['a']);
});

test('两个插件同 id：后者跳过', () => {
    const warnings = [];
    const list = mergeExtensible(BUILTINS, [
        { id: 'dup', label: '先' },
        { id: 'dup', label: '后' }
    ], { onConflict: def => warnings.push(def.id) });
    assert.equal(list.filter(x => x.id === 'dup').length, 1);
    assert.equal(list.find(x => x.id === 'dup').label, '先');
    assert.deepEqual(warnings, ['dup']);
});

test('内置重复 id：只保留第一个且不触发冲突回调', () => {
    const warnings = [];
    const list = mergeExtensible([
        { id: 'a', label: '先' },
        { id: 'a', label: '后' }
    ], [], { onConflict: def => warnings.push(def.id) });
    assert.equal(list.length, 1);
    assert.equal(list[0].label, '先');
    assert.deepEqual(warnings, []);
});

test('结构非法的条目被忽略', () => {
    const list = mergeExtensible(BUILTINS, [null, undefined, {}, { label: '无 id' }, { id: 42, label: 'x' }]);
    assert.deepEqual(list.map(x => x.id), ['a', 'b']);
});

test('不修改传入的定义对象', () => {
    const plugin = { id: 'p', label: 'P' };
    mergeExtensible(BUILTINS, [plugin]);
    assert.equal('isPlugin' in plugin, false);
    assert.equal('order' in plugin, false);
});

test('附加字段被保留', () => {
    const list = mergeExtensible(BUILTINS, [{ id: 'p', label: 'P', mount: () => 1 }]);
    assert.equal(typeof list[2].mount, 'function');
});

// ================================================================
// pickById / hasId
// ================================================================

test('pickById 命中返回对应项', () => {
    const list = mergeExtensible(BUILTINS, []);
    assert.equal(pickById(list, 'b').id, 'b');
});

test('pickById 未命中回退第一项；空列表返回 null', () => {
    const list = mergeExtensible(BUILTINS, []);
    assert.equal(pickById(list, 'zzz').id, 'a');
    assert.equal(pickById([], 'a'), null);
    assert.equal(pickById(null, 'a'), null);
});

test('hasId 判断存在性', () => {
    const list = mergeExtensible(BUILTINS, []);
    assert.equal(hasId(list, 'a'), true);
    assert.equal(hasId(list, 'zzz'), false);
    assert.equal(hasId(null, 'a'), false);
});
