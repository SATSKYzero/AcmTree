// ================================================================
// 真包诊断：预览那张「逐条记录表」的开销（scripts/recordtable-bench.mjs）
//
// 为什么留着（不是临时探针）：`v9.0.18` 给这张表加了"默认只画前 N 行"，当时的依据是
//   "真包两万多行 = 十几 MB HTML"这个**体量**判断。2026-10-13 真量了一次，翻出两件事 ⇒ 得能重复量：
//   ① **限行**当时只省了"挂行"，没省"建行"**：`renderRecordTable` 先把**全部** N 万行
//      `document.createElement` 出来（`recRows.map(recordRow)`），再 `slice` 前 N 行挂上去
//      —— 实测"只有 250 行"的对照 ≈ 0ms，而全量那一遍 ≈ 75ms ⇒ **99% 的钱花在"建"上**。
//      ✅ **当天已改成"先切、再建"**（`i` 下标空间上按需建行）：默认限行 75ms → **2ms**，
//      "显示全部"那一次才付 ~71ms。⇒ **判据 = 下面 ①.b 那个"默认限行/对照"比值**（改前 75×，改后 ≈1×；
//      比值重新变大就是又退回去了）。
//   ② **"显示全部"的代价在桩里量不到**：桩的 `appendChild` 只是往数组里 push（1~2ms），
//      真浏览器要解析+布局+绘制 18~26 MB / 2.7 万个元素。⇒ 这一项的指标要用
//      **DOM 体积（元素数 / HTML 字节）**看，别用桩的毫秒数看。
//
// 跑法：node --import ./scripts/smoke/register.mjs scripts/recordtable-bench.mjs
//   PERF_PKG=<包路径>   换一份 crate（默认 acm-data/nodes/all_nodes.json）
//   SKIP_APPLY=1        只量"空树上出计划"那一遍（不落库，快）
//
// ⚠️ DOM 用 smoke 的桩 ⇒ **JS 里算出来的数字可信，浏览器解析/布局/绘制量不到**（同上①）。
// ⚠️ 它**不进** `npm test` / `npm run test:smoke` —— 诊断工具，不是断言。
// ================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import { installDom, serialize } from './smoke/dom.mjs';
import { installIndexedDb } from './smoke/idb.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const mod = rel => `file://${path.join(SRC, rel).replace(/\\/g, '/')}`;

installDom();
installIndexedDb();
globalThis.localStorage = (() => {
    const m = new Map();
    return {
        getItem: k => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => m.set(k, String(v)),
        removeItem: k => m.delete(k),
        clear: () => m.clear()
    };
})();

const now = () => performance.now();
const ms = x => `${x.toFixed(0)}ms`;
const median = xs => {
    const a = [...xs].sort((x, y) => x - y);
    return a.length ? a[Math.floor(a.length / 2)] : 0;
};

const { AppState, replaceState } = await import(mod('shell/state.js'));
const { createInitialState } = await import(mod('core/model/state.js'));
const { parseCrate } = await import(mod('features/AutoImport/parse.js'));
const { buildPlan } = await import(mod('features/AutoImport/plan.js'));
const { buildExtKeyIndex } = await import(mod('core/ops/upsert.js'));
const { applyPlans } = await import(mod('features/AutoImport/apply.js'));
const { applyFieldMap, RESERVED_KEYS } = await import(mod('features/AutoImport/fieldmap.js'));
const { renderRecordTable, resetRecordTableLimit, AI_RECORD_LIMIT } =
    await import(mod('features/AutoImport/ui/recordTable.js'));

const PKG = process.env.PERF_PKG
    ? path.resolve(ROOT, process.env.PERF_PKG)
    : path.join(ROOT, 'acm-data', 'nodes', 'all_nodes.json');

/** 数出容器里到底建了多少元素（桩不解析 innerHTML ⇒ 只能这么数） */
function countEls(el) {
    let n = 1;
    for (const c of (el.children || [])) n += (c && c._isText) ? 0 : countEls(c);
    return n;
}

function makePlan() {
    const parsed = parseCrate(JSON.parse(fs.readFileSync(PKG, 'utf8')), {});
    const t0 = now();
    const plan = buildPlan({
        crate: parsed.crate,
        state: AppState,
        keyIndex: buildExtKeyIndex(AppState),
        applyFieldMap: (r, fm) => applyFieldMap(r, fm, { reservedKeys: RESERVED_KEYS })
    });
    return { plan, ms: now() - t0, parsedOk: parsed.ok !== false, parseErrors: (parsed.errors || []).length };
}

/** 量一次"铺表"：默认限行 vs 点「显示全部」 */
function benchTable(plan, reps = 3) {
    const limited = [];
    const limitedHtml = [];
    const limitedEls = [];
    for (let i = 0; i < reps; i++) {
        resetRecordTableLimit();
        const box = document.createElement('div');
        document.body.appendChild(box);
        const t0 = now();
        renderRecordTable(box, plan, {});
        limited.push(now() - t0);
        if (i === 0) {
            limitedHtml.push(serialize(box).length);
            limitedEls.push(countEls(box));
        }
    }

    const full = [];
    const fullHtml = [];
    const fullEls = [];
    for (let i = 0; i < reps; i++) {
        resetRecordTableLimit();
        const box = document.createElement('div');
        document.body.appendChild(box);
        renderRecordTable(box, plan, {});
        const btn = box.querySelector('.ai-record-show-all');
        if (!btn) { full.push(-1); continue; }        // 行数没到限行 ⇒ 没有这颗按钮
        const t0 = now();
        btn.dispatchEvent({ type: 'click' });
        full.push(now() - t0);
        if (i === 0) {
            fullHtml.push(serialize(box).length);
            fullEls.push(countEls(box));
        }
    }
    return {
        limited: median(limited), full: median(full),
        limitedHtml: limitedHtml[0] || 0, fullHtml: fullHtml[0] || 0,
        limitedEls: limitedEls[0] || 0, fullEls: fullEls[0] || 0
    };
}

function countRows(plan) {
    const rec = (plan.records || []).length;
    const synth = ((plan.synth && plan.synth.nodes) || []).length;
    return { rec, synth, total: rec + synth };
}

console.log(`📦 包：${path.relative(ROOT, PKG)}（${(fs.statSync(PKG).size / 1048576).toFixed(1)} MB）`
    + `｜限行常量 AI_RECORD_LIMIT=${AI_RECORD_LIMIT}`);

// ---------------------------------------------------------------
// ① 空树上的计划（= 全新导入那一遍的行数）
// ---------------------------------------------------------------
replaceState(createInitialState());
const first = makePlan();
const r1 = countRows(first.plan);
console.log(`\n① 空树：出计划 ${ms(first.ms)}｜行数 = 记录 ${r1.rec} + 合成 ${r1.synth} = ${r1.total}`);
const t1 = benchTable(first.plan, 3);
console.log(`   默认限行：铺表 ${ms(t1.limited)}｜HTML ${(t1.limitedHtml / 1024).toFixed(0)} KB｜元素 ${t1.limitedEls}`);
console.log(`   显示全部：铺设 ${ms(t1.full)}｜HTML ${(t1.fullHtml / 1048576).toFixed(1)} MB｜元素 ${t1.fullEls}`
    + `（比限行多 ${(t1.full / Math.max(t1.limited, 1)).toFixed(0)}× 时间 / `
    + `${(t1.fullEls / Math.max(t1.limitedEls, 1)).toFixed(0)}× 元素）`);

// ---------------------------------------------------------------
// ①.b 对照：把计划砍到只剩 250 行 ⇒ 拆出"建行"与"挂行"各占多少
//      （限行只少挂 27k 行，**建行那一步照样把 27408 行全建了** —— 这组就是量这个）
// ---------------------------------------------------------------
{
    const n = AI_RECORD_LIMIT;
    const sliced = {
        ...first.plan,
        records: (first.plan.records || []).slice(0, n),
        synth: { ...(first.plan.synth || {}), nodes: [] }
    };
    const times = [];
    for (let i = 0; i < 3; i++) {
        resetRecordTableLimit();
        const box = document.createElement('div');
        document.body.appendChild(box);
        const t0 = now();
        renderRecordTable(box, sliced, {});
        times.push(now() - t0);
    }
    const med = median(times);
    console.log(`   对照（只有 ${n} 行）：铺表 ${ms(med)}｜默认限行/对照 = `
        + `${(t1.limited / Math.max(med, 1)).toFixed(1)}×`);
    console.log('   ⚠️ 这个比值就是守卫：**改前**是 75ms / 1ms ≈ 75×（= 把不显示的 27k 行也白建了）；'
        + '改成"先切再建"后两者应当**同量级**。比值重新变大 = 又变回"先建全部再切"。');
}

// ---------------------------------------------------------------
// ② 真树上再导一次（= 预览里绝大多数是"跳过/更新"那一遍）
// ---------------------------------------------------------------
if (!process.env.SKIP_APPLY) {
    const tApply0 = now();
    const res = await applyPlans({ state: AppState, items: [{ plan: first.plan, source: '_probe' }] });
    console.log(`\n② 落库（建出真树）：${ms(now() - tApply0)}`
        + `（新建 ${res && res.created} / 更新 ${res && res.updated} / 拒 ${res && res.rejected}）`);
    console.log(`   节点数 ${Object.keys(AppState.nodes || {}).length}`);
    const second = makePlan();
    const r2 = countRows(second.plan);
    console.log(`   再出计划 ${ms(second.ms)}｜行数 = 记录 ${r2.rec} + 合成 ${r2.synth} = ${r2.total}`);
    const t2 = benchTable(second.plan, 3);
    console.log(`   默认限行：铺表 ${ms(t2.limited)}｜HTML ${(t2.limitedHtml / 1024).toFixed(0)} KB｜元素 ${t2.limitedEls}`);
    console.log(`   显示全部：铺设 ${ms(t2.full)}｜HTML ${(t2.fullHtml / 1048576).toFixed(1)} MB｜元素 ${t2.fullEls}`);
}
