// ================================================================
// 插件注册表测试
// ================================================================
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
    registerNodeMigration,
    registerVNodeMigration,
    registerVNodeCopyHook,
    registerComputeRule,
    registerVNodeComputeRule,
    registerNodeEditorExtension,
    registerVNodeEditorExtension,
    registerRenderSlot,
    registerFolderView,
    registerTab,
    runNodeMigrations,
    runVNodeMigrations,
    runVNodeCopyHooks,
    getComputeRules,
    getVNodeComputeRules,
    getNodeEditorExtensions,
    getVNodeEditorExtensions,
    renderSlots,
    getPluginFolderViews,
    getPluginTabs,
    isPluginTab,
    getKnownSlotIds,
    getPluginFailures,
    clearPluginFailures,
    RENDER_SLOTS,
    createPluginApi,
    __resetRegistryForTest
} from '../core/pluginRegistry.js';

beforeEach(() => {
    __resetRegistryForTest();
});

// ================================================================
// Migration
// ================================================================

test('registerNodeMigration / runNodeMigrations', () => {
    const calls = [];
    registerNodeMigration(node => calls.push(node.id));
    registerNodeMigration(node => { node.extra = true; });

    const n = { id: 'n_1' };
    runNodeMigrations(n);

    assert.deepEqual(calls, ['n_1']);
    assert.equal(n.extra, true);
});

test('registerNodeMigration 非函数抛错', () => {
    assert.throws(() => registerNodeMigration('not-fn'), /需要函数/);
});

test('registerVNodeMigration / runVNodeMigrations', () => {
    registerVNodeMigration(v => { v.x = 1; });
    const vn = {};
    runVNodeMigrations(vn);
    assert.equal(vn.x, 1);
});

// ================================================================
// CopyHook
// ================================================================

test('registerVNodeCopyHook / runVNodeCopyHooks', () => {
    const pairs = [];
    registerVNodeCopyHook((real, vNode) => {
        pairs.push([real.id, vNode.id]);
        vNode.copied = real.value;
    });

    const real = { id: 'r1', value: 'hello' };
    const vNode = { id: 'v1' };
    runVNodeCopyHooks(real, vNode);

    assert.deepEqual(pairs, [['r1', 'v1']]);
    assert.equal(vNode.copied, 'hello');
});

// ================================================================
// ComputeRule
// ================================================================

test('registerComputeRule / getComputeRules 特定类型', () => {
    const fn = () => 1;
    registerComputeRule('P', 'testKey', fn);
    const rules = getComputeRules('P');
    assert.equal(rules.length, 1);
    assert.equal(rules[0].key, 'testKey');
    assert.equal(rules[0].compute, fn);
});

test('registerComputeRule / getComputeRules 通配 *', () => {
    registerComputeRule('*', 'testKey', () => 1);
    assert.equal(getComputeRules('P').length, 1);
    assert.equal(getComputeRules('C').length, 1);
    assert.equal(getComputeRules('O').length, 1);
});

test('getComputeRules 特定 + 通配合并', () => {
    registerComputeRule('P', 'a', () => 1);
    registerComputeRule('*', 'b', () => 2);
    const rules = getComputeRules('P');
    assert.equal(rules.length, 2);
    assert.deepEqual(rules.map(r => r.key), ['a', 'b']);
});

test('getComputeRules 未注册类型返回空数组', () => {
    assert.deepEqual(getComputeRules('P'), []);
});

test('registerComputeRule 参数校验', () => {
    assert.throws(() => registerComputeRule(1, 'k', () => 1), /type 需为字符串/);
    assert.throws(() => registerComputeRule('P', 1, () => 1), /key 需为字符串/);
    assert.throws(() => registerComputeRule('P', 'k', 'not-fn'), /compute 需为函数/);
});

test('registerVNodeComputeRule 特定 + 通配', () => {
    registerVNodeComputeRule('P', 'vk', () => 1);
    registerVNodeComputeRule('*', 'wk', () => 2);
    const rules = getVNodeComputeRules('P');
    assert.equal(rules.length, 2);
    assert.deepEqual(rules.map(r => r.key), ['vk', 'wk']);
    // C 只有通配
    assert.equal(getVNodeComputeRules('C').length, 1);
});

// ================================================================
// EditorExtension
// ================================================================

test('registerNodeEditorExtension / getNodeEditorExtensions', () => {
    registerNodeEditorExtension({
        nodeTypes: ['P', 'C'],
        fields: [{ key: 'x', label: 'X' }],
        apply: () => {}
    });
    registerNodeEditorExtension({
        nodeTypes: ['*'],
        fields: [{ key: 'y', label: 'Y' }],
        apply: () => {}
    });

    const extsP = getNodeEditorExtensions({ type: 'P' });
    assert.equal(extsP.length, 2);

    const extsO = getNodeEditorExtensions({ type: 'O' });
    assert.equal(extsO.length, 1);
    assert.equal(extsO[0].fields[0].key, 'y');
});

test('registerNodeEditorExtension 参数校验', () => {
    assert.throws(() => registerNodeEditorExtension(null), /需/);
    assert.throws(() => registerNodeEditorExtension({ nodeTypes: [], fields: [], apply: 'x' }), /需/);
});

test('registerVNodeEditorExtension / getVNodeEditorExtensions', () => {
    registerVNodeEditorExtension({
        vNodeTypes: ['P'],
        fields: [{ key: 'z' }],
        apply: () => {}
    });
    assert.equal(getVNodeEditorExtensions({ type: 'P' }).length, 1);
    assert.equal(getVNodeEditorExtensions({ type: 'C' }).length, 0);
});

// ================================================================
// RenderSlot
// ================================================================

test('registerRenderSlot / renderSlots', () => {
    registerRenderSlot('slotA', () => '<span>A1</span>');
    registerRenderSlot('slotA', () => '<span>A2</span>');
    registerRenderSlot('slotB', () => '<span>B</span>');

    assert.equal(renderSlots('slotA', {}, {}), '<span>A1</span><span>A2</span>');
    assert.equal(renderSlots('slotB', {}, {}), '<span>B</span>');
    assert.equal(renderSlots('slotC', {}, {}), '');
});

test('renderSlots 非字符串返回值被忽略', () => {
    registerRenderSlot('slotA', () => null);
    registerRenderSlot('slotA', () => '<span>valid</span>');
    registerRenderSlot('slotA', () => 123);
    assert.equal(renderSlots('slotA', {}, {}), '<span>valid</span>');
});

test('renderSlots 传参 state 和 context', () => {
    let captured = null;
    registerRenderSlot('slotA', (state, ctx) => {
        captured = { state, ctx };
        return '';
    });
    const state = { foo: 1 };
    const ctx = { bar: 2 };
    renderSlots('slotA', state, ctx);
    assert.equal(captured.state, state);
    assert.equal(captured.ctx, ctx);
});

test('registerRenderSlot 参数校验', () => {
    assert.throws(() => registerRenderSlot(1, () => ''), /slotId 需为字符串/);
    assert.throws(() => registerRenderSlot('x', 'not-fn'), /renderer 需为函数/);
});

// ================================================================
// createPluginApi
// ================================================================

test('createPluginApi 返回全部 10 个注册函数 + RENDER_SLOTS 只读契约', () => {
    const api = createPluginApi();
    const expected = [
        'registerNodeMigration',
        'registerVNodeMigration',
        'registerVNodeCopyHook',
        'registerComputeRule',
        'registerVNodeComputeRule',
        'registerNodeEditorExtension',
        'registerVNodeEditorExtension',
        'registerRenderSlot',
        'registerFolderView',
        'registerTab'
    ];
    for (const k of expected) {
        assert.equal(typeof api[k], 'function', `缺少 ${k}`);
    }
    assert.equal(typeof api.RENDER_SLOTS, 'object', '缺少 RENDER_SLOTS 只读契约');
    assert.equal(Object.keys(api).length, expected.length + 1, 'api 暴露的键数量应与预期一致');
});

test('createPluginApi 返回的注册函数与模块导出一致', () => {
    const api = createPluginApi();
    assert.equal(api.registerNodeMigration, registerNodeMigration);
    assert.equal(api.registerComputeRule, registerComputeRule);
    assert.equal(api.registerRenderSlot, registerRenderSlot);
    assert.equal(api.registerFolderView, registerFolderView);
    assert.equal(api.registerTab, registerTab);
});

// ================================================================
// 页面级扩展点：registerFolderView / registerTab
// ================================================================

test('registerFolderView 注册后可查表', () => {
    const def = { id: 'timeline', label: '🕒 时间线', order: 20, mount: () => {} };
    registerFolderView(def);

    const list = getPluginFolderViews();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 'timeline');
    assert.equal(list[0].mount, def.mount);
});

test('registerFolderView 返回副本，外部改动不影响注册表', () => {
    registerFolderView({ id: 'a', label: 'A', mount: () => {} });
    const list = getPluginFolderViews();
    list.push({ id: 'injected', label: 'X', mount: () => {} });
    list.length = 0;
    assert.equal(getPluginFolderViews().length, 1);
});

test('registerFolderView 重复 id 抛错', () => {
    registerFolderView({ id: 'dup', label: 'A', mount: () => {} });
    assert.throws(
        () => registerFolderView({ id: 'dup', label: 'B', mount: () => {} }),
        /已被注册/
    );
});

test('registerFolderView 参数校验', () => {
    assert.throws(() => registerFolderView(null), /需传入视图定义对象/);
    assert.throws(() => registerFolderView({ label: 'A', mount: () => {} }), /id 需为非空字符串/);
    assert.throws(() => registerFolderView({ id: 'x', mount: () => {} }), /label 需为非空字符串/);
    assert.throws(() => registerFolderView({ id: 'x', label: 'A' }), /mount 需为函数/);
    assert.throws(() => registerFolderView({ id: 'x', label: 'A', mount: () => {}, unmount: 1 }), /unmount 需为函数/);
    assert.throws(() => registerFolderView({ id: 'x', label: 'A', mount: () => {}, order: '1' }), /order 需为数字/);
});

test('registerTab 注册 / 查表 / 判重 / 参数校验', () => {
    assert.equal(isPluginTab('t1'), false);

    const def = { id: 't1', label: '🧩 插件页', mount: () => {} };
    registerTab(def);

    assert.equal(isPluginTab('t1'), true);
    assert.equal(isPluginTab('nope'), false);
    assert.equal(getPluginTabs().length, 1);
    assert.equal(getPluginTabs()[0].label, '🧩 插件页');

    assert.throws(() => registerTab({ id: 't1', label: '重复', mount: () => {} }), /已被注册/);
    assert.throws(() => registerTab({ id: 't2', label: 'X' }), /mount 需为函数/);
});

test('registerTab 与 registerFolderView 各自独立命名空间', () => {
    registerTab({ id: 'same', label: 'Tab', mount: () => {} });
    // 同名 id 在文件夹视图命名空间下不应冲突
    registerFolderView({ id: 'same', label: 'View', mount: () => {} });
    assert.equal(getPluginTabs().length, 1);
    assert.equal(getPluginFolderViews().length, 1);
});

// ================================================================
// __resetRegistryForTest
// ================================================================

test('__resetRegistryForTest 清空所有注册表', () => {
    registerNodeMigration(() => {});
    registerComputeRule('P', 'k', () => 1);
    registerRenderSlot('s', () => '');
    registerFolderView({ id: 'v', label: 'V', mount: () => {} });
    registerTab({ id: 't', label: 'T', mount: () => {} });

    __resetRegistryForTest();

    assert.equal(getComputeRules('P').length, 0);
    assert.equal(renderSlots('s', {}, {}), '');
    assert.equal(getPluginFolderViews().length, 0);
    assert.equal(getPluginTabs().length, 0);
    assert.equal(isPluginTab('t'), false);
    // migration 的验证通过"调用后无效果"间接测
    const n = { id: 'x' };
    runNodeMigrations(n);
    assert.equal(n.extra, undefined);
});

// ================================================================
// 渲染槽契约
// ================================================================

test('RENDER_SLOTS 声明已知槽，getKnownSlotIds 可枚举', () => {
    assert.equal(RENDER_SLOTS.NODE_SELECT_DOT_BEFORE, 'node-select-dot-before');
    assert.deepEqual(getKnownSlotIds(), ['node-select-dot-before']);
});

test('RENDER_SLOTS 被冻结', () => {
    assert.equal(Object.isFrozen(RENDER_SLOTS), true);
});

test('registerRenderSlot 未知槽：告警但不抛错', () => {
    const warnings = [];
    const original = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
        assert.doesNotThrow(() => registerRenderSlot('no-such-slot', () => '<i>x</i>'));
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /未知槽/);
    } finally {
        console.warn = original;
    }
});

test('registerRenderSlot 已知槽不告警', () => {
    const warnings = [];
    const original = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
        registerRenderSlot(RENDER_SLOTS.NODE_SELECT_DOT_BEFORE, () => '<i>x</i>');
        assert.equal(warnings.length, 0);
    } finally {
        console.warn = original;
    }
});

// ================================================================
// 插件错误隔离（迁移 / 拷贝钩子 / 渲染槽）
// ================================================================

/** 临时静音 console.error，避免故障注入用例刷屏 */
function quiet(fn) {
    const original = console.error;
    console.error = () => {};
    try {
        return fn();
    } finally {
        console.error = original;
    }
}

test('runNodeMigrations 隔离抛错并继续执行后续插件', () => {
    const seen = [];
    registerNodeMigration(() => { throw new Error('坏插件'); });
    registerNodeMigration(node => { seen.push(node.id); });

    const node = { id: 'n1' };
    quiet(() => runNodeMigrations(node));

    assert.deepEqual(seen, ['n1']);
    assert.equal(node.extra, undefined);
    assert.equal(getPluginFailures().length, 1);
    assert.equal(getPluginFailures()[0].label, 'nodeMigration');
});

test('runVNodeMigrations 隔离抛错并继续', () => {
    registerVNodeMigration(() => { throw new Error('坏'); });
    registerVNodeMigration(v => { v.ok = true; });

    const v = {};
    quiet(() => runVNodeMigrations(v));
    assert.equal(v.ok, true);
});

test('runVNodeCopyHooks 隔离抛错并继续', () => {
    registerVNodeCopyHook(() => { throw new Error('坏'); });
    registerVNodeCopyHook((real, vNode) => { vNode.from = real.id; });

    const vNode = {};
    quiet(() => runVNodeCopyHooks({ id: 'r' }, vNode));
    assert.equal(vNode.from, 'r');
});

test('renderSlots 隔离抛错的渲染器，保留其余片段', () => {
    const slot = RENDER_SLOTS.NODE_SELECT_DOT_BEFORE;
    registerRenderSlot(slot, () => '<b>好</b>');
    registerRenderSlot(slot, () => { throw new Error('坏渲染'); });
    registerRenderSlot(slot, () => '<i>尾</i>');

    let html = '';
    quiet(() => { html = renderSlots(slot, {}, {}); });
    assert.equal(html, '<b>好</b><i>尾</i>');
});

test('渲染器返回非字符串被忽略', () => {
    const slot = RENDER_SLOTS.NODE_SELECT_DOT_BEFORE;
    registerRenderSlot(slot, () => null);
    registerRenderSlot(slot, () => 123);
    registerRenderSlot(slot, () => '<p>真</p>');
    assert.equal(renderSlots(slot, {}, {}), '<p>真</p>');
});

test('getPluginFailures 记录标签与消息，重复失败累加计数', () => {
    registerRenderSlot(RENDER_SLOTS.NODE_SELECT_DOT_BEFORE, () => { throw new Error('同样的错'); });
    quiet(() => {
        renderSlots(RENDER_SLOTS.NODE_SELECT_DOT_BEFORE, {}, {});
        renderSlots(RENDER_SLOTS.NODE_SELECT_DOT_BEFORE, {}, {});
        renderSlots(RENDER_SLOTS.NODE_SELECT_DOT_BEFORE, {}, {});
    });

    const failures = getPluginFailures();
    assert.equal(failures.length, 1);
    assert.equal(failures[0].label, 'renderSlot:node-select-dot-before');
    assert.equal(failures[0].message, '同样的错');
    assert.equal(failures[0].count, 3);
});

test('getPluginFailures 返回副本，外部改动不影响记录', () => {
    registerNodeMigration(() => { throw new Error('x'); });
    quiet(() => runNodeMigrations({}));
    const failures = getPluginFailures();
    failures[0].count = 999;
    failures.length = 0;
    assert.equal(getPluginFailures()[0].count, 1);
});

test('clearPluginFailures 清空记录', () => {
    registerNodeMigration(() => { throw new Error('x'); });
    quiet(() => runNodeMigrations({}));
    assert.equal(getPluginFailures().length, 1);
    clearPluginFailures();
    assert.equal(getPluginFailures().length, 0);
});

test('计算规则故意不隔离：抛错向上传播', () => {
    // 规则算错时静默跳过会写回过期错值，比事务失败更危险，故必须响亮失败
    registerComputeRule('P', 'boom', () => { throw new Error('算错了'); });
    const rules = getComputeRules('P');
    assert.equal(rules.length, 1);
    assert.throws(() => rules[0].compute({}, { id: 'n' }), /算错了/);
    assert.equal(getPluginFailures().length, 0, '计算规则失败不应进隔离记录');
});