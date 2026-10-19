// ================================================================
// 重跑归认（core/ops/reattribute.js）
//
// **"补映射后重新导入"若只会再叠一条**
// —— 同一个来源、同一个值、账户却不同，按"来源+值+账户"去重就是两条。
// 于是这些值永远修不回来（面板上两条一模一样的值，一条"客观"一条"👤谁"）。
//
// 两件事一起解决：
//   1. 导入时按 **来源 + 值 + 线索** 合并（同一个线索只留一条，账户以最新一次为准）
//      —— 见 `core/fieldValue.js` 的 `addSourceValue`；
//   2. 这里：拿**当前的映射表**把**已有的值**重算一遍归属。只改 `account`，
//      不碰 `v / src / at`（值本身没变，只是"这是谁说的"这层元数据更新了）。
//
// 为什么必须靠"线索"：值上有线索才认得出"它来自哪条记录"；
// 没有线索的值（回填进去的、或来源本来就不给线索的）**不动** —— 不猜。
//
// 依赖：core/accounts.js（查表）、core/fieldValue.js（线索规范化/键）。纯函数，可单测。
// ================================================================

import { resolveAccount } from '../accounts.js';
import { assertManualEditAllowed } from './account.js';
import { normalizeClue } from '../fieldValue.js';

/**
 * 用当前映射表重跑一遍归认。
 *
 * @param {Object} draft - AppState 草稿（会**原地**改 `node.values[*][].account`）
 * @param {Object} [opts]
 * @param {boolean} [opts.dryRun] - 只统计不写（预览用）
 * @returns {{ scanned:number, withClue:number, matched:number, changed:number,
 *             unmatched:number, conflicts:number, conflictList:Array }}
 */
export function reattributeValues(draft, opts = {}) {
    const dryRun = !!opts.dryRun;
    // 只读边界：重跑归认会**改写值的归属**（`values[*].account`），是手改级别的动作。
    // 但 `dryRun` 只是预览（不写一个字），所以在只读模式下也允许 —— 否则连"看看会怎么归认"都做不到。
    if (!dryRun) assertManualEditAllowed(draft, '重跑归认');
    const out = {
        scanned: 0,        // 看过的值
        withClue: 0,       // 带线索（= 能重算）的值
        matched: 0,        // 现在能认出账户的
        changed: 0,        // 归属**确实变了**的
        unmatched: 0,      // 填了线索但认不出（含冲突）
        conflicts: 0,      // 被多个账户认领（不猜，归为客观）
        conflictList: []   // 前若干条冲突（给界面看）
    };
    if (!draft || !draft.nodes || typeof draft.nodes !== 'object') return out;
    const accounts = draft.accounts || {};

    for (const nodeId of Object.keys(draft.nodes)) {
        const node = draft.nodes[nodeId];
        const values = node && node.values;
        if (!values || typeof values !== 'object') continue;

        let touched = false;
        const nextMap = { ...values };
        for (const field of Object.keys(values)) {
            const list = values[field];
            if (!Array.isArray(list)) continue;
            let listCopy = null;

            for (let i = 0; i < list.length; i++) {
                const entry = list[i];
                out.scanned++;
                const clue = normalizeClue(entry && entry.clue);
                if (!clue) continue;                       // 没线索 → 不猜，原样不动
                out.withClue++;

                const r = resolveAccount(accounts, clue);
                const current = String((entry && entry.account) || '');
                let next = '';
                if (r.accountId) {
                    out.matched++;
                    next = r.accountId;
                } else {
                    out.unmatched++;
                    if (r.conflict.length) {
                        out.conflicts++;
                        if (out.conflictList.length < 20) {
                            out.conflictList.push({
                                nodeId,
                                field,
                                clue: `${clue.source}:${clue.field}=${clue.value}`,
                                accounts: r.conflict.slice()
                            });
                        }
                    }
                }
                if (next === current) continue;

                out.changed++;
                if (dryRun) continue;
                if (!listCopy) {
                    listCopy = list.slice();
                    nextMap[field] = listCopy;
                    touched = true;
                }
                const copy = { ...listCopy[i] };
                if (next) copy.account = next;
                else delete copy.account;                  // 认不出 → 客观（不写空键，保持既有形状）
                listCopy[i] = copy;
            }
            // 兜底：已经处理过的字段不要再被覆盖
            if (listCopy) nextMap[field] = listCopy;
        }
        if (touched && !dryRun) node.values = nextMap;
    }
    return out;
}

/**
 * 给界面用的一句话摘要。
 * @param {Object} r - `reattributeValues` 的返回值
 */
export function describeReattribute(r) {
    if (!r) return '';
    if (r.withClue === 0) return '没有带账户线索的值（老数据或来源没给线索），没有可重算的';
    const parts = [`重算 ${r.withClue} 条带线索的值`];
    parts.push(r.changed ? `改了 ${r.changed} 条归属` : '归属没变化');
    if (r.conflicts) parts.push(`${r.conflicts} 条线索被多个账户认领（不猜，留作客观）`);
    const rest = r.unmatched - r.conflicts;
    if (rest > 0) parts.push(`${rest} 条线索现在仍然认不出`);
    return parts.join('，');
}

// ================================================================
// 「哪些线索没认出来」
//
// 导入摘要只说"2183 条线索没匹配上"，**不说是哪条** —— 用户没法照着补映射。
// 这个函数把**所有认不出的线索**按"源:字段=值"聚合出来（带条数与例子），
// 界面照着列一行一条、点一下就能补映射。
//
// 与 `reattributeValues` 的分工：那个负责**改归属**，这个负责**解释为什么没认出来**。
// 两者共用 `resolveAccount`，判据永远一致。
// ================================================================

/**
 * 汇总"认不出的线索"。
 *
 * @param {Object} draft - AppState（只读，不修改）
 * @param {Object} [opts]
 * @param {number} [opts.top] - 最多返回多少种（按条数降序）；0 = 不限
 * @returns {{ total:number, kinds:Array<{source,field,value,count,conflict,
 *             accounts:string[], examples:string[]}> }}
 *   - `total`  = 认不出的**值条数**（与导入摘要的 `unmatched` 同一口径）
 *   - `kinds`  = 按条数降序的**线索种类**（`conflict` = 被多个账户认领，不是缺映射）
 */
export function collectUnmatchedClues(draft, opts = {}) {
    const out = { total: 0, kinds: [] };
    if (!draft || !draft.nodes || typeof draft.nodes !== 'object') return out;
    const accounts = draft.accounts || {};
    const byKey = new Map();

    for (const nodeId of Object.keys(draft.nodes)) {
        const node = draft.nodes[nodeId];
        const values = node && node.values;
        if (!values || typeof values !== 'object') continue;
        for (const field of Object.keys(values)) {
            const list = values[field];
            if (!Array.isArray(list)) continue;
            for (const entry of list) {
                const clue = normalizeClue(entry && entry.clue);
                if (!clue) continue;                       // 源没给线索 → 不算"认不出"
                const r = resolveAccount(accounts, clue);
                if (r.accountId) continue;                 // 认出来了
                out.total++;
                const key = `${clue.source}\u0000${clue.field}\u0000${clue.value}`;
                let hit = byKey.get(key);
                if (!hit) {
                    hit = {
                        source: clue.source, field: clue.field, value: clue.value,
                        count: 0, conflict: r.conflict.length > 0,
                        accounts: r.conflict.slice(), examples: []
                    };
                    byKey.set(key, hit);
                }
                hit.count++;
                // 例子（给人核对用）：节点类型 + 这条值所在字段。最多留 3 个。
                if (hit.examples.length < 3) {
                    const label = `${node.type || '?'}${node.name ? ` ${node.name}` : ''}`;
                    const line = `${label} ／ ${field}`;
                    if (!hit.examples.includes(line)) hit.examples.push(line);
                }
            }
        }
    }

    out.kinds = [...byKey.values()].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
    if (opts.top > 0) out.kinds = out.kinds.slice(0, opts.top);
    return out;
}

/** 一条线索的显示写法（界面/日志共用，别各写各的） */
export function clueText(clue) {
    if (!clue) return '';
    return `${clue.source}:${clue.field}=${clue.value}`;
}

// ================================================================
// 「按线索清值」—— 把某一条线索写下的那些值**删掉**
//
// 为什么需要（2026-10-17 真踩到）：适配器曾经把各年的账户线索写错成同一个值
// （杭电 2021/2023/2024/2025 全写成 `TEAM0/teamA`）。修好之后再导入，新线索是**另一组** ——
// 合并键里线索是身份的一部分（`core/fieldValue.js`），所以旧组**不会被撤**，每格留两条一模一样的值，
// 而「未认领的线索」永远挂着那四行。要清掉它，只能按"这条线索"把那些值条目删掉。
//
// 安全边界（都写在代码里，别放宽）：
//   · **只删认不出账户的那些**（`resolveAccount` 给不出 accountId）—— 这个动作只在
//     "这条线索是无主的"语境下提供；中途补了映射 ⇒ 那是有主的值，不归它管（计入 `skippedMapped`）。
//   · 只认"源 + 字段 + 值"三者全等（`normalizeClue` 规范化后比），**别按值清** —— 同一个值
//     可能是别的线索/别的来源说的，那是另一件事。
//   · 整格被清空时**把字段一起撤掉**（别留空数组：界面会画出一条空的来源行）。
// ================================================================

/**
 * 按一条线索清值（默认 dry-run：只统计不写）。
 *
 * @param {Object} draft - AppState 草稿
 * @param {{source:string,field:string,value:string}} clue - 要清的线索
 * @param {Object} [opts]
 * @param {boolean} [opts.dryRun] - 只统计（预览用，只读模式下也允许）
 * @returns {{scanned:number, removed:number, skippedMapped:number, fields:number}}
 *   - `removed`       = 删掉的值条数
 *   - `skippedMapped` = 命中这条线索、但**已经被映射认领**所以没删的条数
 *   - `fields`        = 因此被清空的字段个数
 */
export function purgeValuesByClue(draft, clue, opts = {}) {
    const dryRun = !!opts.dryRun;
    if (!dryRun) assertManualEditAllowed(draft, '按线索清值');
    const out = { scanned: 0, removed: 0, skippedMapped: 0, fields: 0 };
    const want = normalizeClue(clue);
    if (!want || !draft || !draft.nodes || typeof draft.nodes !== 'object') return out;
    const accounts = draft.accounts || {};
    const keyOf = (c) => `${c.source}\u0000${c.field}\u0000${c.value}`;
    const wantKey = keyOf(want);

    for (const nodeId of Object.keys(draft.nodes)) {
        const node = draft.nodes[nodeId];
        const values = node && node.values;
        if (!values || typeof values !== 'object') continue;

        let nextMap = null;
        for (const field of Object.keys(values)) {
            const list = values[field];
            if (!Array.isArray(list)) continue;
            const keep = [];
            let hit = 0;
            for (const entry of list) {
                out.scanned++;
                const c = normalizeClue(entry && entry.clue);
                if (!c || keyOf(c) !== wantKey) {
                    keep.push(entry);
                    continue;
                }
                if (resolveAccount(accounts, c).accountId) {
                    out.skippedMapped++;               // 有主的值不归这个动作管
                    keep.push(entry);
                    continue;
                }
                hit++;
                out.removed++;
            }
            if (!hit) continue;
            if (!nextMap) nextMap = { ...values };
            if (keep.length) nextMap[field] = keep;
            else {
                delete nextMap[field];                 // 整格清空 ⇒ 字段一起撤掉
                out.fields++;
            }
        }
        if (nextMap && !dryRun) node.values = nextMap;
    }
    return out;
}

/** 给界面用的一句话摘要（`purgeValuesByClue` 的返回值） */
export function describePurge(r) {
    if (!r || !r.removed) return '没有可删的值';
    const extra = r.fields ? `，${r.fields} 个字段因此清空` : '';
    const skipped = r.skippedMapped ? `（另有 ${r.skippedMapped} 条已被映射认领，没动）` : '';
    return `已删掉 ${r.removed} 条值${extra}${skipped}`;
}
