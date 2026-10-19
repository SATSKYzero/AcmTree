#!/usr/bin/env node
// ================================================================
// 导入包离线试跑（scripts/crate-check.mjs）
//
// 职责：用**应用真实的导入引擎**（parse → plan）试跑一份 crate，
//       在不打开浏览器的情况下看到「新增 / 更新 / 跳过 / 警告 / 错误」。
//
// 为什么需要它：
//   应用里的路径是 `index.html` → 浏览器。爬虫作者没法在自己机器上
//   离线验证产出。本脚本复用应用同一套模块（不是复制逻辑），
//   因此结论与浏览器里完全一致。
//
// 它做什么 / 不做什么：
//   - 用 `parseCrate` 解析（成熟 crate 走快路径，平台原生载荷走适配器）
//   - 用 `buildPlan` 生成导入计划（**只读**，绝不写任何数据）
//   - 打印摘要、逐条错误、警告、未使用字段
//   - **不写 IndexedDB、不碰浏览器**，因此可以随便跑
//
// 用法：
//   node scripts/crate-check.mjs out_problems.json
//   node scripts/crate-check.mjs out_all.json --verbose
//   node scripts/crate-check.mjs qoj_problems.json          # 原生载荷也行（走适配器）
//   node scripts/crate-check.mjs out.json --tree export.json # 用已导出的树当基线
//
// 提示：`--tree` 传应用导出的完整 JSON 后，"父节点是否已在树上"才判得准；
//       不传则假定是一棵空树，所有容器都会被判为"将新建"。
// ================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mod = rel => `file://${path.join(ROOT, 'src', rel).replace(/\\/g, '/')}`;

const { parseCrate } = await import(mod('features/AutoImport/parse.js'));
const { buildPlan, ACTION } = await import(mod('features/AutoImport/plan.js'));
const { applyFieldMap, RESERVED_KEYS } = await import(mod('features/AutoImport/fieldmap.js'));

// 结构键**不自己写一份**：用应用里的权威清单（这里各写一份就会漏掉
// `字段来源`，把"已用掉的信息"报成了"未使用字段"）。
const RESERVED = [...RESERVED_KEYS];

// ---------------------------------------------------------------
// 参数
// ---------------------------------------------------------------
const argv = process.argv.slice(2);
const flags = new Set(argv.filter(a => a.startsWith('--')));
const positional = argv.filter(a => !a.startsWith('--'));
const treeIdx = argv.indexOf('--tree');
const treePath = treeIdx >= 0 ? argv[treeIdx + 1] : '';
const cratePath = positional.find(a => a !== treePath);

if (!cratePath) {
    console.error('用法: node scripts/crate-check.mjs <crate.json> [--tree <导出.json>] [--verbose]');
    process.exit(2);
}
const verbose = flags.has('--verbose');

// ---------------------------------------------------------------
// 构造一棵"最小可用"的假 state（plan 只读 nodes / childOrder / parentOf）
// ---------------------------------------------------------------
function makeState() {
    const st = {
        rootId: 'o',
        nodes: { o: { id: 'o', type: 'O', name: '根' } },
        childOrder: { o: [] },
        parentOf: { o: null }
    };
    return st;
}

/** 若传了 --tree，把导出 JSON 里的节点灌进 state（得到真实的基线） */
function loadTree(st, file) {
    const exported = JSON.parse(fs.readFileSync(file, 'utf8'));
    const nodes = exported && exported.nodes ? exported.nodes : {};
    const childOrder = exported && exported.childOrder ? exported.childOrder : {};
    const parentOf = exported && exported.parentOf ? exported.parentOf : {};

    for (const id of Object.keys(nodes)) {
        st.nodes[id] = nodes[id];
        st.childOrder[id] = childOrder[id] || [];
        st.parentOf[id] = parentOf[id] !== undefined ? parentOf[id] : null;
    }
    if (exported && exported.rootId) st.rootId = exported.rootId;
    return Object.keys(nodes).length;
}

function buildKeyIndex(st) {
    const idx = {};
    for (const id of Object.keys(st.nodes)) {
        const n = st.nodes[id];
        if (!n || !n.extKey) continue;
        const k = String(n.extKey).trim();
        if (k && !(k in idx)) idx[k] = id;
    }
    return idx;
}

// ---------------------------------------------------------------
// 跑
// ---------------------------------------------------------------
const state = makeState();
let baseline = 0;
if (treePath) {
    try {
        baseline = loadTree(state, treePath);
    } catch (err) {
        console.error(`读取 --tree 失败：${err.message}`);
        process.exit(2);
    }
}

let raw;
try {
    // 去掉 UTF-8 BOM（PowerShell / 记事本 / 部分导出工具会写），
    // JSON.parse 会被 BOM 噎住，报 "Unexpected token"
    raw = JSON.parse(fs.readFileSync(cratePath, 'utf8').replace(/^\uFEFF/, ''));
} catch (err) {
    console.error(`解析 ${cratePath} 失败：${err.message}`);
    process.exit(2);
}

console.log(`\n📦 ${path.basename(cratePath)}`);
if (treePath) console.log(`   基线树：${baseline} 个节点（来自 ${path.basename(treePath)}）`);
else console.log('   基线树：空（未传 --tree，所有容器都算将新建）');

const parsed = parseCrate(raw);
// `父synthKey`（父是合成节点）是**脚本侧机制**，应用的导入引擎目前
// 只认 `父extKey`。它会以"未映射列"出现在 parse 的警告里 —— 那条泛泛的提示
// 说不清后果，这里拦下来换成一句讲得清的（下面单独打印）。
const isParentSynthWarning = w => String(w && w.message || '').includes('父synthKey');
if (parsed.warnings && parsed.warnings.length) {
    for (const w of parsed.warnings) {
        if (isParentSynthWarning(w)) continue;
        console.log(`   ⚠️  [解析] ${w.message}`);
    }
}
if (!parsed.ok || !parsed.crate) {
    console.log('\n❌ 解析失败（整包级错误，不会导入任何东西）：');
    for (const e of parsed.errors) console.log(`   • [${e.code}] ${e.message}`);
    process.exit(1);
}

const rawRecords = Array.isArray(raw.records) ? raw.records : [];
const parentSynthRecords = rawRecords.filter(r => r && typeof r === 'object'
    && String(r['父synthKey'] === undefined || r['父synthKey'] === null ? '' : r['父synthKey']).trim() !== '');
// ⚠️ 这段文案容易**说反** —— "应用只认 父extKey，这些记录会挂到根下"是错的。
//    实际（`features/AutoImport/` 的 parse → resolve → plan →
//    synthApply 四段都在）：
//      · **合成节点**（有 `synthKey`）用 `父synthKey` 是**正牌写法**（父是合成节点时用它），
//        应用完全支持，挂在那个合成节点下面；
//      · **普通记录**（有 `extKey`）用 `父synthKey` 会被**逐条拒绝**（合成节点不是它的
//        父容器），既不挂根下也不静默忽略。钉子见 `src/test/autoImportSynth.test.js`
//        的"普通记录（有 extKey）用父synthKey ⇒ 逐条拒绝"。
const synthWithParentSynth = parentSynthRecords.filter(r => String(r.synthKey || '').trim() !== '');
const ordinaryWithParentSynth = parentSynthRecords.filter(r => String(r.synthKey || '').trim() === '');
if (synthWithParentSynth.length) {
    console.log(`   ℹ️  本包有 ${synthWithParentSynth.length} 条**合成节点**用「父synthKey」：`
        + '这是正牌写法（父是合成节点时就用它），应用侧**支持** —— 不用改。');
}
if (ordinaryWithParentSynth.length) {
    console.log(`   ⚠️  本包有 ${ordinaryWithParentSynth.length} 条**普通记录**（有 extKey）用了「父synthKey」：`
        + '普通记录的父引用只能用「父extKey」（合成节点不当它的父容器）——');
    console.log('       这些记录会被**逐条拒绝**（既不会挂到根下，也不会静默忽略），'
        + '原因文案见 `plan.js` 的「普通记录…不能用 父synthKey」。');
}

const c = parsed.crate;
console.log(`   来源：${c.source.id || '(未署名)'}${c.source.label ? ' / ' + c.source.label : ''}`);
console.log(`   适配器：${c.adapter || '无（成熟 crate 快路径）'}`);
console.log(`   records：${c.records.length} 条`);

const plan = buildPlan({
    crate: c,
    state,
    keyIndex: buildKeyIndex(state),
    applyFieldMap: (record, fieldMap) => applyFieldMap(record, fieldMap, { reservedKeys: RESERVED })
});

const s = plan.summary;
console.log(`\n📊 试跑结果：新增 ${s.create}｜更新 ${s.update}｜跳过 ${s.skip}｜警告 ${s.warnings}｜错误 ${s.errors}`);
// 合成：合成节点与成员指针是**两阶段**的另一条通道，不在上面的 create/update 里。
// 不单独报的话，界面上那个"会新建 N 个合成节点"就完全看不见（预览会少算）。
if (s.synthNodes > 0 || s.synthSkip > 0) {
    console.log(`   🧩 合成节点（两阶段·第一阶段）：新建 ${s.synthCreate}｜更新 ${s.synthUpdate}｜跳过 ${s.synthSkip}`
        + `　← ${s.synthNodes} 个会写入，**不计入**上面的"新增/更新"`);
}
if (s.pointerSet > 0 || s.pointerRejected > 0) {
    let line = `   🔗 成员指针 ownerSynth（第二阶段）：会写入 ${s.pointerSet}`;
    if (s.pointerRejected > 0) {
        line += `｜被拒 ${s.pointerRejected}`;
        if (s.pointerDangling > 0) line += `（其中目标解析不了 ${s.pointerDangling}）`;
    }
    console.log(line);
}
if (s.similaritySuppressed > 0) {
    console.log(`   已忽略 ${s.similaritySuppressed} 条"不是同一件东西"的相似标题`
        + '（① 只差数字的编号系列，如「联赛（1）」vs「联赛（10）」；'
        + '② 同一场里**题号不同**的两道题，如 `F` vs `F2`）');
}
if (s.unusedColumns.length) {
    // `父synthKey` 已经在上面单独讲过了（那条提示比"未使用字段"清楚得多，别报两遍）
    const cols = s.unusedColumns.filter(c => c !== '父synthKey');
    if (cols.length) console.log(`   未使用字段（只记列名，不导入）：${cols.join(', ')}`);
}

if (plan.errors.length) {
    console.log(`\n❌ 错误（这些条目不会执行，其余照常）：`);
    for (const e of plan.errors) {
        const idx = e.index !== undefined ? `第 ${e.index} 条 ` : '';
        console.log(`   • ${idx}[${e.code}] ${e.message}`);
    }
}

if (plan.warnings.length) {
    console.log(`\n⚠️  警告（不影响执行）：`);
    for (const w of plan.warnings) {
        const idx = w.index !== undefined ? `第 ${w.index} 条 ` : '';
        console.log(`   • ${idx}[${w.code}] ${w.message}`);
    }
}

if (verbose && plan.records.length) {
    console.log(`\n📋 逐条计划：`);
    const tag = { [ACTION.CREATE]: '＋', [ACTION.UPDATE]: '↻', [ACTION.SKIP]: '＝' };
    for (const r of plan.records) {
        const fields = Object.keys(r.fields || {});
        console.log(`   ${tag[r.action] || '?'} ${r.type}  ${r.extKey}`
            + (r.parentExtKey ? `  (父 ${r.parentExtKey})` : '')
            + (fields.length ? `  字段: ${fields.join(',')}` : ''));
    }
}

// 合成：这两张清单不在 plan.records 里（身份不同、阶段不同），verbose 时单独列。
const synthNodes = (plan.synth && plan.synth.nodes) || [];
const pointers = (plan.synth && plan.synth.pointers) || [];
if (verbose && synthNodes.length) {
    console.log(`\n🧩 合成节点计划（身份是 synthKey，没有 extKey）：`);
    const synthTag = { create: '＋', update: '↻', skip: '＝' };
    for (const n of synthNodes) {
        const fields = Object.keys(n.fields || {});
        console.log(`   ${synthTag[n.action] || '?'} ${n.type}  synthKey=${n.synthKey}`
            + (n.parentExtKey ? `  (父 ${n.parentExtKey})` : '')
            + (fields.length ? `  字段: ${fields.join(',')}` : ''));
    }
}
if (verbose && pointers.length) {
    console.log(`\n🔗 成员指针计划（ownerSynth，第二阶段）：`);
    const ptrTag = { set: '＋', same: '＝', reject: '✗' };
    for (const p of pointers) {
        console.log(`   ${ptrTag[p.action] || '?'} ${p.extKey}  ownerSynth=${p.synthKey}`
            + (p.current ? `  (树上现为 ${p.current})` : '')
            + (p.reason ? `  —— ${p.reason}` : ''));
    }
}

// 合成节点也是"会写入的节点"，所以计进可写入总数（否则数字会少算）
const usable = s.create + s.update + s.synthNodes;
console.log(`\n${s.errors === 0 ? '✅' : '⚠️ '} 可写入 ${usable} 个节点`
    + (s.errors ? `，另有 ${s.errors} 条会被拒绝` : ''));
if (s.errors === 0 && usable === 0) {
    console.log('   （没有变更——这份包与当前树一致，重复导入是安全的）');
}
if (!treePath) {
    console.log('\n💡 想更准确地判断"哪些是新容器"，用应用导出 JSON 后加 --tree <文件>');
}
process.exit(s.errors > 0 ? 1 : 0);
