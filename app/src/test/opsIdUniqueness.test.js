// ================================================================
// id 的唯一性（`core/ops/_helpers.js` + `core/model/convert.js`）—— 会红的回归锚
//
// 来由（用户 2026-10-13 报的）：`v9.3.0` 的「副页复制」把「2023 CC秦皇岛」复制成了**一个单题**。
// 量出来的根因：`nextVirtualId()` 当时是"毫秒 + **4 位随机**"，而"复制一个 1900 节点的副页"
// 会在**同一毫秒**里连着要上千个 id ⇒ **生日碰撞**（实测 2000 个 id × 10 轮，5 轮出现重复）；
// 撞上时两个 vNode 合成一个（字典后写覆盖前写、两个父的 `children` 指向同一个 id）⇒
// **一个容器被一个叶子顶掉**，看起来就是"容器变成一个单题"。
//
// 用户对修法的要求（原话）："**要确定性的修复,出错概率要在 1e-40 以下**"。
// 现在的保证**不是概率**，而是构造：
//   ① 所有 id 族共用一个计数器（`nextIdOf`），发号只做 `++state.meta.idCounter`（O(1)、不扫表）；
//   ② 计数器住在 state 里随存档/导出包走，且**载入/导入时抬到所有已有 id 之上**
//      （`convert.js:normalizeIdCounter`，`restoreDerived` 与 `executor.importState` 两处都调）；
//   ③ 老格式（`page_<ms36>` / `v_<ms36>_<rand>` …）与新格式（`<前缀>_<数字>_<ms36>`）
//      **字段数不同** ⇒ 结构上不可能相等。
// ⇒ 只要计数器不回退，新 id 与任何已有 id 重合是**不可能事件**，与随机数无关。
//
// ⚠️ 下面这些测试**把 `Math.random` 换成"一调就抛"**：证明发号**根本不碰随机数**，
//    而不是"碰巧没撞上"。
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    nextIdOf, nextNodeId, nextTagId, nextPageId, nextVirtualRootId, nextVirtualId
} from '../core/ops/_helpers.js';
import { nextPlanId, nextIntensityTableId } from '../core/ops/plan.js';
import { normalizeIdCounter, maxIdCounterOf, restoreDerived } from '../core/model/convert.js';
import { createInitialState } from '../core/model/state.js';

/** 让 `Math.random` 一调就抛：任何"靠随机拉开"的实现都会当场炸；计数器实现一点不受影响 */
function withRandomForbidden(fn) {
    const real = Math.random;
    Math.random = () => { throw new Error('id 发号不许用 Math.random（唯一性由计数器保证）'); };
    try { return fn(); } finally { Math.random = real; }
}

test('★ 发号不碰随机数：5000 个 id（七族混发）互不相同', () => {
    const s = createInitialState();
    const ids = withRandomForbidden(() => {
        const out = [];
        for (let i = 0; i < 5000; i++) {
            out.push(nextIdOf(s, 'x_'));
            if (i % 6 === 0) out.push(nextVirtualId(s));
            if (i % 6 === 1) out.push(nextPageId(s));
            if (i % 6 === 2) out.push(nextVirtualRootId(s));
            if (i % 6 === 3) out.push(nextPlanId(s));
            if (i % 6 === 4) out.push(nextIntensityTableId(s));
            if (i % 6 === 5) out.push(nextNodeId(s), nextTagId(s));
        }
        return out;
    });
    assert.equal(new Set(ids).size, ids.length,
        `发出去的 id 里有重复（去重后 ${new Set(ids).size} / 共 ${ids.length}）`);
});

test('★ 归一化：计数器被压低也不许与"已有的 id"重合（vNode / 副页 / 计划 / 强度表都算）', () => {
    const s = createInitialState();
    // 故意造一份"计数器不可靠"的 state：各族都有 id，而 idCounter 只有 1
    s.nodes = { 'n_900_zzz': { id: 'n_900_zzz', type: 'P', values: {} } };
    s.tags = { 't_800_zzz': { id: 't_800_zzz', name: 'x' } };
    s.pages = {
        'page_700_zzz': {
            id: 'page_700_zzz', name: '页', rootId: 'vroot_750_zzz',
            virtualIndex: { 'vroot_750_zzz': { id: 'vroot_750_zzz', refId: null, type: 'O', parentId: null, children: ['v_760_zzz'] }, 'v_760_zzz': { id: 'v_760_zzz', refId: 'n_900_zzz', type: 'P', parentId: 'vroot_750_zzz', children: [] } },
            vNodeStats: {}, createdAt: '', lastModified: '', selected: false
        }
    };
    s.plans = { 'plan_600_zzz': { id: 'plan_600_zzz', name: '计划', pageId: 'page_700_zzz' } };
    s.settings.trainingIntensityTables = [{ id: 'ti_500_zzz', name: '表' }];
    s.meta.idCounter = 1;

    const existing = new Set(['n_900_zzz', 't_800_zzz', 'page_700_zzz', 'vroot_750_zzz', 'v_760_zzz', 'plan_600_zzz', 'ti_500_zzz']);
    assert.equal(maxIdCounterOf(s), 900, '扫出来的最大计数器应当是 900（各族里最大）');
    normalizeIdCounter(s);
    assert.equal(s.meta.idCounter, 900, '归一化后计数器要抬到 900');

    const made = withRandomForbidden(() => [
        nextVirtualId(s), nextPageId(s), nextVirtualRootId(s), nextPlanId(s), nextIntensityTableId(s),
        nextNodeId(s), nextTagId(s)
    ]);
    assert.equal(new Set(made).size, made.length, '同一轮发出去的 id 之间也有重复');
    const clash = made.filter((id) => existing.has(id));
    assert.deepEqual(clash, [], `与已有 id 撞了：${clash.join(', ')}`);
});

test('★ 读存档那条路（`restoreDerived`）也要归一化计数器', () => {
    const raw = {
        nodes: { 'n_300_zzz': { id: 'n_300_zzz', type: 'P', values: {} } },
        childOrder: { 'n_300_zzz': [] },
        pages: {},
        plans: {},
        settings: {},
        meta: { idCounter: 1 }
    };
    const restored = restoreDerived(raw);
    assert.equal(restored.meta.idCounter, 300, '读盘后计数器必须 >= 所有已有 id 的数字前缀');
    const id = nextVirtualId(restored);
    assert.ok(!id.startsWith('v_1_') && !id.startsWith('v_2_'), '新 id 不许落在"已被用过的"小计数器区间');
});

test('★ 导入那条路（`executor.importState`）必须接上归一化（源码锚）', async () => {
    // ⚠️ 导入要真跑得有 落盘/IndexedDB 那一整套 ⇒ 这里用源码锚钉"那一句在"
    //    （与 `problemPick.test.js` 那两条源码级锚同性质）。
    const fs = await import('node:fs');
    const url = new URL('../shell/executor.js', import.meta.url);
    const src = fs.readFileSync(url, 'utf8');
    assert.match(src, /normalizeIdCounter\(complete\)/,
        'importState 里必须调 `normalizeIdCounter(complete)`（否则导入包之后新发的 id 可能与包里已有的撞）');
    assert.match(src, /import \{ normalizeIdCounter \} from '\.\.\/core\/model\/convert\.js'/,
        'executor.js 要真的 import 它');
});

test('★ 没有计数器 / 计数器坏掉：自愈，不许抛', () => {
    const s = createInitialState();
    delete s.meta.idCounter;
    const a = nextVirtualId(s);
    const b = nextVirtualId(s);
    assert.notEqual(a, b, '没有计数器时也得给出两个不同的 id');
    assert.ok(Number.isFinite(s.meta.idCounter), '发号之后要补上一个可用的计数器');

    const s2 = createInitialState();
    s2.meta = null;
    const c = nextNodeId(s2);
    assert.ok(typeof c === 'string' && c.startsWith('n_'), 'meta 整块没有时也要能发号');
});
