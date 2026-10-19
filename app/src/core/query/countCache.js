// ================================================================
// 计数状态的缓存（core/query/countCache.js）
// 职责：把"这一代的计数结果"留住 —— 一代**算一次**，之后所有取数只读。
// 依赖：`core/query/countPass.js`（那一趟）
// ================================================================
// 就一条路（用户 2026-10-07 定的方案）：`runCountPass()` ——
//   本身值 + P 桶 + C 桶 + 📊分布 一趟算齐；`plain` 与 `dedup` **共用这一趟**
//   （去重的"组事件 3 步"在那一趟里）。本文件只负责"一代一次"。
//
// 失效键 = **数据代 × 口径**：
//   · `state.nodes` 引用：Immer 只在**真数据改动**时换它 —— 折叠/翻页/勾选都换不动
//     （它们住在 `state.view` 里）⇒ 视图动作**一格都不重算**；
//   · `state.childOrder` 引用：结构改动；
//   · 口径：`viewingAccountId` / 计数模式 / `accounts` / `trust` / 范围 任一变了 ⇒ 整片重算。
//
// ⚠️ 这里**只留一代**（数据换代就整片丢掉重算），不做逐格失效；
//    但**一代里可以并存几份口径**（plain / dedup 各一份 —— 见下面 `scopeKeyOf` 的说明）。
// ⚠️ 读路径可以用它，但**不许写 state**：这份状态住在模块里，不是节点字段。
// ================================================================
import { runCountPass } from './countPass.js';

// ⚠️ **一份口径一个槽**（plain 一个 / dedup 一个）：两样东西会**交替**来要 ——
//    `derive.js`/`groupCompute.js` 建"自己那份"（不带 mode ⇒ plain）与
//    `view/stats.js` 数数（带 `mode` ⇒ dedup）。一个槽会互相顶掉，每交替一次就重跑一趟（~300ms）。
//    但**不合并成一张表**：同一个槽里"换了范围就重算"这条语义要留住
//    （`src/test/derive.test.js` 里"就地改 `values` 再换个范围读"那几条正是靠它）。
let genPlain = null;   // 这个槽是哪一代（哪个范围）的
let passPlain = null;
let genDedup = null;
let passDedup = null;

/** 这一代的键（全按**引用/值**比：`nodes` 是数据代，其余是口径） */
function genOf(state, scope) {
    const s = state || {};
    const sc = scope || {};
    return {
        nodes: s.nodes || null,
        childOrder: s.childOrder || null,
        account: s.viewingAccountId || '',
        accounts: s.accounts || null,
        trust: s.trust || null,
        // 范围也要进键：同一份数据可以按不同范围各算一份（`derive.js` 也是这么分的）
        scope: `${sc.viewingAccount || ''}|${Array.isArray(sc.scopeAccounts) ? sc.scopeAccounts.join(',') : ''}`
    };
}

function sameGen(a, b) {
    return !!a && !!b
        && a.nodes === b.nodes && a.childOrder === b.childOrder
        && a.account === b.account
        && a.accounts === b.accounts && a.trust === b.trust
        && a.scope === b.scope;
}

/**
 * **那一趟**：这一代（这个范围/口径）没算过就跑一次 `runCountPass()`，算过就直接给。
 * 这是计数路径上**唯一**的重算入口，也是 `derive.js` 全量建表的来源（两边共用同一个实例）。
 *
 * @param {Object} state
 * @param {Object} scope - `view/scope.js` 的 `scopeOpts(state)` + `{ mode }`
 * @returns {ReturnType<typeof runCountPass>}
 */
export function cache_countPassOf(state, scope = {}) {
    const g = genOf(state, scope);
    if (scope && scope.mode === 'dedup') {
        if (passDedup && sameGen(genDedup, g)) return passDedup;
        genDedup = g;
        passDedup = runCountPass(state, scope);
        return passDedup;
    }
    if (passPlain && sameGen(genPlain, g)) return passPlain;
    genPlain = g;
    passPlain = runCountPass(state, scope);
    return passPlain;
}

/**
 * **值修改的增量入口**：把缓存里那两份趟（plain / dedup）都按"改动节点"**增量更新**
 * （只更新改动节点所在组 + 祖先链，毫秒级），然后把它们**接到新一代**上。
 *
 * ⚠️ 前提：**没增删节点、没换顺序**（键集合与结构都没变）—— 调用方负责判定
 * （事务层用 `classifyChanges` 的 roots：`nodes` 变了而 `childOrder` 没变）。
 * ⚠️ `derive.js` 的派生表 / `groupCompute.js` 的组表**不用接**：它们的键比 `nodes` 引用，
 *   会自然作废、并**从这一趟重建**（那一趟已是最新 ⇒ 重建只是拷行，~10ms，不是重算）。
 */
export function applyValueDeltaToCaches(state, changedIds, prev = {}, addedIds = []) {
    try {
        for (const p of [passPlain, passDedup]) {
            if (!p || typeof p.applyValueDelta !== 'function') continue;
            // ⚠️ **只有"正好建在上一代"的那份趟**才敢就地增量（下标/组表是按那一代算的）。
            //    更早那份就**别动**（它的代还是旧的 ⇒ 下一次读自然重算，正确性不受影响）。
            if (typeof p.isBuiltOn === 'function' && !p.isBuiltOn(prev.nodes, prev.childOrder)) continue;
            if (p.applyValueDelta(state, changedIds, addedIds) === false) {
                // 接不下（容量用光 / 键序不符）⇒ 让这份趟作废，下一次读整棵重算
                clearCountCache();
                return;
            }
        }
        rekeyCountCache(state);
    } catch (err) {
        // ⚠️ **失败安全**：增量可能**改了一半**（数组是就地加的）⇒ 出异常时**把两份趟都丢掉**，
        //    让下一次读整棵重算 —— 宁可慢一次，也**绝不能**留着半更新的计数。
        clearCountCache();
        console.warn('[增量] 值修改增量失败，已退回整棵重算（请把这条报给作者）：', err && err.message);
    }
}

/** 测试/诊断用：两个槽都清掉（`derive.js` 的 `clearDerivedMemo` 会连它一起清） */
export function clearCountCache() {
    genPlain = null;
    passPlain = null;
    genDedup = null;
    passDedup = null;
}

/**
 * **把已有的那一趟接到新一代上**（不清、不重算）。
 *
 * 用途：**纯顺序改动**（上移/下移这种只换兄弟位置的）—— 值一个都不变
 * （真包 27206 节点 × plain/dedup 两种模式逐字段对拍 **0 不同**，覆盖表也逐条相同），
 * 而 `nodes`/`childOrder` 换了引用**只是 Immer 的结构共享**，不代表值变了。
 * 不接的话，下一次读会白跑一整趟（实测 ~150~250ms）。
 *
 * ⚠️ **只许在"值确实没变"的改动上用**（调用方声明 `orderOnly`）。
 */
export function rekeyCountCache(state) {
    const s = state || {};
    for (const gen of [genPlain, genDedup]) {
        if (!gen) continue;
        gen.nodes = s.nodes || null;
        gen.childOrder = s.childOrder || null;
        gen.accounts = s.accounts || null;
        gen.trust = s.trust || null;
    }
}

