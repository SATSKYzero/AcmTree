// ================================================================
// 两列值诊断（scripts/two-column-audit.mjs）—— **先量再说"哪处该读哪一份"**
//
// 它答一个问题：判重模式下，「**靠前那份**」（`viewValue` / `viewDerived`）
// 与「**靠后那份**」（显示口径 `viewDerivedDisplay(...) ?? viewValue(...)`）
// **到底差多少、差在哪些字段**。
//
// 为什么要有它：`plain ⇒ 靠前那份 / dedup ⇒ 靠后那份` 这个分工**只有一处判据**
// （`view/scope.js` 的 `displayColumnOf`）—— 但各个消费点（树 / 统计 / 检索 / 排序…）
// 是**各自**去调读口的，调错一份不会报错、只会"数字/颜色跟别处不一样"。
// 要判"某处是不是读错了"，就得先知道**两份在那处是否真的不同**（差 0 ⇒ 只是写法不统一）。
//
// 怎么跑：
//   node --import ./scripts/smoke/register.mjs scripts/two-column-audit.mjs
//   PERF_PKG=<包路径>  换一份数据（默认 acm-data/nodes/all_nodes.json）
//
// ⚠️ **不进 CI**（诊断工具，不是断言）：它只打印数字。会红的守卫是
//    `src/test/dedupDisplay.test.js` 的两条源码级名单检查（"谁允许直接读底层口"）。
// ================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { installDom } from './smoke/dom.mjs';
import { installIndexedDb } from './smoke/idb.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const mod = (rel) => `file://${path.join(SRC, rel).replace(/\\/g, '/')}`;

installDom();
installIndexedDb();
globalThis.localStorage = (() => {
    const m = new Map();
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)),
        removeItem: (k) => m.delete(k), clear: () => m.clear() };
})();

const { AppState, replaceState } = await import(mod('shell/state.js'));
const { createInitialState } = await import(mod('core/model/state.js'));
const { viewValue, viewDerived, viewDerivedDisplay } = await import(mod('view/scope.js'));
const { ELEMENT_NATURE, natureOf, isElement } = await import(mod('core/model/elements.js'));
const { parseCrate } = await import(mod('features/AutoImport/parse.js'));
const { buildPlan } = await import(mod('features/AutoImport/plan.js'));
const { buildExtKeyIndex } = await import(mod('core/ops/upsert.js'));
const { applyPlans } = await import(mod('features/AutoImport/apply.js'));
const { applyFieldMap, RESERVED_KEYS } = await import(mod('features/AutoImport/fieldmap.js'));

replaceState(createInitialState());
const PKG = process.env.PERF_PKG
    ? path.resolve(ROOT, process.env.PERF_PKG)
    : path.join(ROOT, 'acm-data', 'nodes', 'all_nodes.json');
const raw = JSON.parse(fs.readFileSync(PKG, 'utf8'));
const parsed = parseCrate(raw, {});
const plan = buildPlan({
    crate: parsed.crate, state: AppState, keyIndex: buildExtKeyIndex(AppState),
    applyFieldMap: (r, fm) => applyFieldMap(r, fm, { reservedKeys: RESERVED_KEYS })
});
await applyPlans({ state: AppState, items: [{ plan, source: 'probe' }] });

/**
 * 「靠前那份」的读法 = `view/scope.js` 的 `ownColumnReader` 的分流
 * （那份没导出 ⇒ 这里照它写：**派生列**走 `viewDerived`，**来源层字段**走 `viewValue`）。
 */
const ownOf = (n, f) => {
    if (!isElement(f)) return n[f];
    if (natureOf(f) === ELEMENT_NATURE.DERIVED) return viewDerived(AppState, n, f);
    return viewValue(AppState, n, f);
};
/** 「屏幕上那一列」= `viewDerivedDisplay(...) ?? viewValue(...)` */
const shownOf = (n, f) => {
    const v = viewDerivedDisplay(AppState, n, f);
    return (v === undefined || v === null) ? viewValue(AppState, n, f) : v;
};
const norm = (v) => (v === undefined || v === null ? '' : Array.isArray(v) ? JSON.stringify(v) : String(v));

const nodes = Object.values(AppState.nodes);
// ⚠️ 只在**判重模式**下量：`plain` 下显示口径本来就是"靠前那份"（这是设计，不是差异）
AppState.settings.stats.countMode = 'dedup';
console.log(`📦 ${path.relative(ROOT, PKG)}｜节点 ${nodes.length}｜模式 dedup`);

const FIELDS_P = ['status1', 'status2', 'xcpcDifficulty', 'acTime', 'lastSubmitTime',
    'ratio', 'cfDifficulty', 'contestTime', 'problemId'];
const FIELDS_CONT = ['statusComplete1', 'statusComplete2'];

function audit(label, list, fields) {
    console.log(`\n${label}`);
    for (const f of fields) {
        let diff = 0, onlyShown = 0;
        const samples = [];
        for (const n of list) {
            const a = norm(ownOf(n, f));
            const b = norm(shownOf(n, f));
            if (a === b) continue;
            diff++;
            if (!a) onlyShown++;                     // 靠前那份是空、靠后那份有值
            if (samples.length < 3) samples.push(`${n.type}/${n.problemId || n.name || n.id}: ${a || '∅'} → ${b || '∅'}`);
        }
        console.log(`  ${f.padEnd(17)} 两份不同 ${String(diff).padStart(5)} / ${list.length}`
            + `（其中"靠前那份空、显示那份有值" ${onlyShown}）${diff ? '  ' + samples.join(' ｜ ') : ''}`);
    }
}

audit('P（题目）：', nodes.filter((n) => n.type === 'P'), FIELDS_P);
audit('C / W / S（容器）：', nodes.filter((n) => ['C', 'W', 'S'].includes(n.type)), FIELDS_CONT);

// 容器状态条这一格单独看：它曾经是 `view/renderers.js` 读错的那处（v9.0.5 修）
const conts = nodes.filter((n) => ['C', 'W', 'S'].includes(n.type));
const inGroup = conts.filter((n) => n.synthKey || n.ownerSynth);
const diffCont = conts.filter((n) => norm(ownOf(n, 'statusComplete2')) !== norm(shownOf(n, 'statusComplete2')));
console.log(`\n容器状态条（statusComplete2）：在组合成节点里的容器 ${inGroup.length} 个，`
    + `两份不同 ${diffCont.length} 个（方向：靠后那份更大 `
    + `${diffCont.filter((n) => Number(shownOf(n, 'statusComplete2')) > Number(ownOf(n, 'statusComplete2'))).length} / 更小 `
    + `${diffCont.filter((n) => Number(shownOf(n, 'statusComplete2')) < Number(ownOf(n, 'statusComplete2'))).length}）`);
