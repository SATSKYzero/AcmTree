// ================================================================
// 探针：`countPass.js` 的 `readOwnRow` 改成"投影过的自己那份"**前后**的真包对拍
// 跑法：node --import ./scripts/smoke/register.mjs scripts/_probe-ownrow-ab.mjs
//
// 量的东西 = `runCountPass(...).rowOf(id)`（= 组那份回写之后的那一行）——
//   与界面「时间范围 AC 列表」/网格表读的是同一份。
//   · ① 有 acTime 的 P 条数   ② 其中"组那份 status2 ∉ {3,4}"的条数（症状条数）
//   · ③ 九个组列字段的逐节点签名（落盘 ⇒ 两次跑之间 `OWNROW_DIFF=1` 对拍 = 变化节点数）
//
// 三次跑：
//   OWNROW_DUMP=before node …（改前）   OWNROW_DUMP=after node …（改后）
//   OWNROW_DIFF=1 node …（只读两份 dump，不导包）
// 可选 OWNROW_INJECT=1：真包**不带账户层** ⇒ 导入后"缓存字段 ≡ 无范围投影"，
//   分叉量不出来；这个开关把一批 AC 提交改成**别人的账户**、且**不重跑 autoCompute**
//   （缓存停在"含那次 AC"、投影按本机范围过滤掉）⇒ 造出用户实测那种分叉。
//
// ⚠️ 用完即删（`scripts/AGENTS.md` 的探针惯例）；**不改产品代码**。
// ================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDom } from './smoke/dom.mjs';
import { installIndexedDb } from './smoke/idb.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const mod = rel => 'file://' + path.join(SRC, rel).replace(/\\/g, '/');
const FIELDS = ['status1', 'status2', 'xcpcDifficulty', 'acTime', 'lastSubmitTime',
    'cfDifficulty', 'atcoderDifficulty', 'clistDifficulty', 'ratio'];
installDom();
installIndexedDb();

// ---- 只读两份 dump（不导包）----
if (process.env.OWNROW_DIFF) {
    const rd = (tag) => JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', `_ownrow-${tag}.json`), 'utf8'));
    const has = (v) => (v === undefined || v === null || v === '' || v === '----.--.-- --:--' ? 0 : 1);
    const A = rd('before'); const B = rd('after');
    const per = {}; const touched = new Set();
    let acA = 0; let acB = 0; let badA = 0; let badB = 0;
    for (const key of Object.keys(A)) {
        const a = A[key]; const b = B[key] || a;
        for (let i = 0; i < FIELDS.length; i++) {
            if (a[i] !== b[i]) { per[FIELDS[i]] = (per[FIELDS[i]] || 0) + 1; touched.add(key); }
        }
        if (has(a[3])) { acA++; if (a[1] !== '3' && a[1] !== '4') badA++; }
        if (has(b[3])) { acB++; if (b[1] !== '3' && b[1] !== '4') badB++; }
    }
    console.log(`改前：有 acTime 的 P = ${acA}｜其中组那份 status2 ∉ {3,4} = ${badA}`);
    console.log(`改后：有 acTime 的 P = ${acB}｜其中组那份 status2 ∉ {3,4} = ${badB}`);
    console.log(`组列发生变化的节点数 = ${touched.size} / ${Object.keys(A).length} 个 P`
        + `｜逐字段变化节点数：${JSON.stringify(per)}`);
    process.exit(0);
}

const { AppState, replaceState } = await import(mod('shell/state.js'));
const { createInitialState } = await import(mod('core/model/state.js'));
const { parseCrate } = await import(mod('features/AutoImport/parse.js'));
const { buildPlan } = await import(mod('features/AutoImport/plan.js'));
const { buildExtKeyIndex } = await import(mod('core/ops/upsert.js'));
const { applyPlans } = await import(mod('features/AutoImport/apply.js'));
const { applyFieldMap, RESERVED_KEYS } = await import(mod('features/AutoImport/fieldmap.js'));
const { runCountPass } = await import(mod('core/query/countPass.js'));
const { clearDerivedMemo } = await import(mod('core/derive.js'));
const { clearCountCache } = await import(mod('core/query/countCache.js'));
const { TIME_PLACEHOLDER } = await import(mod('core/model/constants.js'));

const hasT = (v) => v !== undefined && v !== null && v !== '' && v !== TIME_PLACEHOLDER;
replaceState(createInitialState());
AppState.settings.stats.countMode = 'dedup';
clearDerivedMemo(); clearCountCache();
const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'acm-data', 'nodes', 'all_nodes.json'), 'utf8'));
const plan = buildPlan({
    crate: parseCrate(raw, {}).crate, state: AppState, keyIndex: buildExtKeyIndex(AppState),
    applyFieldMap: (r, fm) => applyFieldMap(r, fm, { reservedKeys: RESERVED_KEYS })
});
const res = await applyPlans({ state: AppState, items: [{ plan, source: '_probe-ownrow-ab' }] });
const ids = Object.keys(AppState.nodes).filter(id => AppState.nodes[id] && AppState.nodes[id].type === 'P');
console.log(`📦 all_nodes.json｜dedup｜导包 新建 ${res.created} / 更新 ${res.updated}`
    + `｜节点 ${Object.keys(AppState.nodes).length}｜P ${ids.length}`);

// ---- 变体 B（见文件头）----
const FOREIGN = '__probe_foreign__';
if (process.env.OWNROW_INJECT) {
    const { produce } = await import(mod('vendor/immer.mjs'));
    AppState.accounts = { ...AppState.accounts,
        local: { id: 'local', name: '本机', active: true, mappings: [] },
        [FOREIGN]: { id: FOREIGN, name: '外部账户', active: true, mappings: [] } };
    AppState.viewingAccountId = 'local';
    AppState.currentAccountId = 'local';
    let hit = 0;
    const next = produce(AppState, (d) => {
        for (const id of Object.keys(d.nodes)) {
            if (hit >= 300) break;
            const p = d.nodes[id];
            if (!p || p.type !== 'P') continue;
            for (const cid of d.childOrder[id] || []) {
                const r = d.nodes[cid];
                if (!r || r.type !== 'R') continue;
                const st = r.values && r.values.status && r.values.status[0];
                if (!st || st.v !== 'AC') continue;
                const vals = {};
                for (const f of Object.keys(r.values || {})) {
                    vals[f] = (r.values[f] || []).map(e => ({ ...e, account: FOREIGN }));
                }
                d.nodes[cid] = { ...r, values: vals };
                hit++;
                break;
            }
        }
    });
    replaceState(next);
    clearDerivedMemo(); clearCountCache();
    console.log(`🧪 注入：${hit} 道 P 的 AC 提交改记在外部账户「${FOREIGN}」名下`
        + `｜查看账户 = local｜**没有重跑 autoCompute**（缓存字段仍记住那次 AC）`);
}

for (const [label, scopeAccounts] of [
    ['不设 scopeAccounts', undefined], ['scopeAccounts=[local]（界面口径）', ['local']]
]) {
    const pass = runCountPass(AppState, {
        scopeAccounts, accounts: AppState.accounts, trust: AppState.trust, mode: 'dedup'
    });
    let withAc = 0; let bad = 0;
    for (const id of ids) {
        const r = pass.rowOf(id);
        if (!hasT(r.acTime)) continue;
        withAc++;
        if (String(r.status2) !== '3' && String(r.status2) !== '4') bad++;
    }
    console.log(`[${label}] ① 有 acTime 的 P = ${withAc}｜② 其中组那份 status2 ∉ {3,4} = ${bad}`);
}

if (process.env.OWNROW_DUMP) {
    AppState.viewingAccountId = 'local';
    clearDerivedMemo(); clearCountCache();
    const pass = runCountPass(AppState, {
        scopeAccounts: ['local'], accounts: AppState.accounts, trust: AppState.trust, mode: 'dedup'
    });
    const out = {};
    for (const id of ids) {
        const n = AppState.nodes[id];
        const r = pass.rowOf(id);
        // ⚠️ 节点 id 每次导包都带随机后缀 ⇒ 跨两次跑要比**稳定身份**（extKey / synthKey）
        out[n.extKey || n.synthKey || id] = FIELDS.map(
            f => (r[f] === undefined || r[f] === null ? '' : String(r[f])));
    }
    fs.writeFileSync(path.join(ROOT, 'scripts', `_ownrow-${process.env.OWNROW_DUMP}.json`), JSON.stringify(out));
    console.log(`💾 dump → scripts/_ownrow-${process.env.OWNROW_DUMP}.json（${Object.keys(out).length} 个 P）`);
}
