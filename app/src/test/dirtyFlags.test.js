// ================================================================
// 脏标记判定测试
// 锁定的核心行为：切 tab 只改 currentTab（persist:true / export:false），
// 不得把「JSON 已导出」清掉。
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    changedRoots,
    classifyChanges
} from '../core/model/dirtyFlags.js';
import { USER_FIELDS, PERSIST_ROOTS, EXPORT_ROOTS } from '../A_registry.js';

// ---- 用注册表构造一个「基线状态」，引用可复用 ----
function makeState(over = {}) {
    const base = {
        rootId: 'root',
        nodes: { a: { id: 'a' } },
        childOrder: { root: ['a'] },
        parentOf: { a: 'root' },
        pages: {},
        currentPageId: 'main',
        settings: { display: {} },
        meta: { idCounter: 1 },
        currentTab: 'main'
    };
    return { ...base, ...over };
}

// ================================================================
// 集合来源
// ================================================================

test('导出/持久化字段集合取自 A_registry 的 USER_FIELDS', () => {
    // ⚠️ 不是抽查几个键 —— 直接比**整个集合**（抽查的话"改回手写名单"也能过）
    const wantExport = Object.keys(USER_FIELDS).filter(k => USER_FIELDS[k].export).sort();
    const wantPersist = Object.keys(USER_FIELDS).filter(k => USER_FIELDS[k].persist).sort();
    assert.deepEqual([...EXPORT_ROOTS].sort(), wantExport);
    // PERSIST_ROOTS 还含 side 字段（infoState / 历史栈）的根
    assert.deepEqual([...PERSIST_ROOTS].filter(k => !['infoState', 'Hisstate', 'HisCount'].includes(k)).sort(),
        wantPersist);
});

test('currentTab 属于持久化但不属于导出（本 bug 的关键前提）', () => {
    assert.equal(USER_FIELDS['currentTab'].persist, true);
    assert.equal(USER_FIELDS['currentTab'].export, false);

    assert.equal(PERSIST_ROOTS.has('currentTab'), true);
    assert.equal(EXPORT_ROOTS.has('currentTab'), false);
});

test('parentOf 是派生字段，不进任何集合', () => {
    assert.equal(USER_FIELDS['parentOf'].persist, false);
    assert.equal(USER_FIELDS['parentOf'].export, false);
    assert.equal(EXPORT_ROOTS.has('parentOf'), false);
    assert.equal(PERSIST_ROOTS.has('parentOf'), false);
});

// ================================================================
// changedRoots
// ================================================================

test('引用相同的字段不算变化（依赖 Immer 结构共享）', () => {
    const before = makeState();
    const after = { ...before, currentTab: 'stats' };
    assert.deepEqual([...changedRoots(before, after)], ['currentTab']);
});

test('未触碰的字段保持引用，不会被误报', () => {
    const before = makeState();
    const after = { ...before };   // 全部字段同一引用
    assert.equal(changedRoots(before, after).size, 0);
});

test('多个字段同时变化都能识别', () => {
    const before = makeState();
    const after = { ...before, nodes: { b: {} }, currentTab: 'stats' };
    const roots = [...changedRoots(before, after)].sort();
    assert.deepEqual(roots, ['currentTab', 'nodes']);
});

test('changedRoots 对空值安全', () => {
    assert.equal(changedRoots(null, makeState()).size, 0);
    assert.equal(changedRoots(makeState(), null).size, 0);
});

// ================================================================
// classifyChanges —— 修复的核心断言
// ================================================================

test('只切 tab：持久化变脏，但导出不算过期', () => {
    const before = makeState();
    const after = { ...before, currentTab: 'stats' };
    const flags = classifyChanges(before, after);

    assert.equal(flags.persisted, true, 'currentTab 需要写盘');
    assert.equal(flags.exported, false, '切 tab 不应清掉"JSON已导出"');
    assert.deepEqual(flags.roots, ['currentTab']);
});

test('改题目：两者都变脏', () => {
    const before = makeState();
    const after = { ...before, nodes: { a: { id: 'a', status2: 4 } } };
    const flags = classifyChanges(before, after);

    assert.equal(flags.persisted, true);
    assert.equal(flags.exported, true);
});

test('改设置：两者都变脏（settings 会被导出）', () => {
    const before = makeState();
    const after = { ...before, settings: { display: { nodePerPage: 50 } } };
    const flags = classifyChanges(before, after);

    assert.equal(flags.persisted, true);
    assert.equal(flags.exported, true);
});

test('只变 parentOf：不影响任何标记（派生字段）', () => {
    const before = makeState();
    const after = { ...before, parentOf: { a: null } };
    const flags = classifyChanges(before, after);

    assert.equal(flags.persisted, false);
    assert.equal(flags.exported, false);
});

test('未登记的新字段：保守地按两者都变脏处理', () => {
    const before = makeState();
    const after = { ...before, someFutureField: 1 };
    const flags = classifyChanges(before, after);

    assert.equal(flags.persisted, true, '漏登记也不能不保存');
    assert.equal(flags.exported, true, '漏登记也不能不导出');
});

test('无变化：两者都不变脏', () => {
    const before = makeState();
    const flags = classifyChanges(before, { ...before });
    assert.equal(flags.persisted, false);
    assert.equal(flags.exported, false);
});

test('切 tab + 改题目：导出当然过期', () => {
    const before = makeState();
    const after = { ...before, currentTab: 'stats', nodes: { a: { id: 'a', status2: 1 } } };
    const flags = classifyChanges(before, after);

    assert.equal(flags.persisted, true);
    assert.equal(flags.exported, true);
});
