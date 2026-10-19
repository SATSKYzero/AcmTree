// ================================================================
// meta 层的**落盘差分**（persistence/diff.js）回归
//
// 病根：`computeDiff` 里的 meta 层**逐字段列出来**当
// 白名单 —— 新增一个顶层 meta 字段（`sources` / `trust` / `accounts` / `fieldRegistry` …）
// 而忘了在这里加一行，后果是**"刷新一次就没了"，而且看不出来**：
// 内存里明明有，IndexedDB 里没有，加载回来变默认值。
//
// 名单现在只有一处（`A_registry.js` 的 USER_FIELDS），"每个字段都真的派生了"
// 由 `registryCoverage.test.js` 逐键证明；这里只管 diff 自己的行为。
// ================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { computeDiff, isEmptyDiff } from '../persistence/diff.js';

/** 一次"最小但完整"的 meta 层（与 core/model/state.js 的默认形状一致） */
function makeState(over = {}) {
    return {
        rootId: 'o',
        nodes: {},
        childOrder: {},
        pages: {},
        settings: {},
        meta: { idCounter: 0 },
        sources: {},
        trust: {},
        accounts: {},
        currentAccountId: '',
        viewingAccountId: '',
        currentPageId: 'main',
        currentTab: 'main',
        infoState: {},
        ...over
    };
}

test('变了就得进 diff.metaFields（否则刷新就没）', () => {
    const before = makeState();
    const after = makeState({ sources: { 变了: true } });
    assert.equal(computeDiff(before, after).metaFields.sources !== undefined, true);
    assert.equal(isEmptyDiff(computeDiff(before, after)), false);
});

test('fieldRegistry：从"没有"到"有"也算变化（第一次导入就要落盘）', () => {
    const before = makeState({ fieldRegistry: null });
    const after = makeState({ fieldRegistry: { registryVersion: 1, fields: { name: { expect: 'required' } } } });
    const diff = computeDiff(before, after);
    assert.equal(diff.metaFields.fieldRegistry.registryVersion, 1, '第一次导入必须写盘');
});

test('reports：从"没有"到"有"也算变化（第一次导入就要落盘）', () => {
    const before = makeState({ reports: null });
    const after = makeState({ reports: { coverage: { rows: [] }, needs: { needs: [] } } });
    const diff = computeDiff(before, after);
    assert.equal(diff.metaFields.reports.needs.needs.length, 0, '第一次导入必须写盘');
});

test('没变的 meta 字段**不进** diff（不然每次保存都全量写）', () => {
    const a = makeState({ fieldRegistry: { registryVersion: 1 } });
    const same = makeState({ fieldRegistry: a.fieldRegistry });          // 同一个引用 = 没变
    assert.equal(computeDiff(a, same).metaFields.fieldRegistry, undefined);
});

// "每个字段都真的从 A_registry 的 USER_FIELDS 派生"由 `registryCoverage.test.js`
// **逐键行为**证明（captureRef / emptyRef / diff / 导出包 / 撤销快照），这里不再掺和。

