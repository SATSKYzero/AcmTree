// ================================================================
// 加速探针（scripts/perf-bench.mjs）—— **先量，不猜**
//
// 来由：本地静态应用、包里两万多节点，有相当多的操作延迟在 1s 以上，
// 而本地 DOM 操作**应该是几十毫秒级**。逐页扫、固定 60ms 等待这类猜法都被实测推翻过，
// 所以这个脚本只干一件事：**用真实数据 + 真实模块，把一次操作按阶段拆开计时**。
//
// 怎么跑：
//   node --import ./scripts/smoke/register.mjs scripts/perf-bench.mjs
//   可选环境变量：
//     PERF_PKG=<包路径>     换一份数据（默认 acm-data/nodes/all_nodes.json）
//     PERF_MODE=dedup       以「判重」模式跑（默认 plain）
//     PERF_SKIP_IMPORT=1    跳过导包（只测渲染阶段；上次导包的结果不复用，慎用）
//     PERF_DIAG=1           连应用里那套诊断行一起打（`[渲染行]` / `[副页·段]` / `[计划栏]` …，
//                           唯一开关见 `src/utils/diag.js`；默认关，免得刷屏）
//
// ⚠️ 与 `fold-bench.mjs` 的分工：那份用**合成树**量折叠那条链；这份用**真实包**量
// "一次操作"的整条刷新链（导包 → 事务 → 刷新广播 → 各渲染阶段）。
// ⚠️ 它**不进** `npm test` / `npm run test:smoke` —— 诊断工具，不是断言。
// ⚠️ DOM 用 smoke 的桩（`innerHTML` 不解析）⇒ 量到的是"遍历 + 拼字符串"，
//    真实浏览器里的解析/布局/绘制量不到；反过来，**JS 里算出来的数字**是可信的。
// ================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import { installDom } from './smoke/dom.mjs';
import { installIndexedDb } from './smoke/idb.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const mod = rel => `file://${path.join(SRC, rel).replace(/\\/g, '/')}`;

installDom();
installIndexedDb();

// 渲染路径要用的容器（真实 index.html 里有；桩里没有 ⇒ 补上）
for (const id of ['tree-body', 'tree-stats', 'mode-action-btn-container', 'folder-breadcrumb',
    'folder-view-tabs', 'folder-stats', 'stats-chart-container', 'info-bar', 'tab-bar',
    'node-info-content', 'dedup-content', 'plan-bar']) {
    if (!document.getElementById(id)) {
        const el = document.createElement('div');
        el.id = id;
        document.body.appendChild(el);
    }
}
globalThis.localStorage = (() => {
    const m = new Map();
    return {
        getItem: k => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => m.set(k, String(v)),
        removeItem: k => m.delete(k),
        clear: () => m.clear()
    };
})();
// `PERF_DIAG=1` ⇒ 打开应用里那套诊断行（`[渲染行]` / `[副页·段]` / `[计划栏]` …，
// 唯一开关见 `src/utils/diag.js`）。默认关着，免得刷屏。
if (process.env.PERF_DIAG === '1') globalThis.localStorage.setItem('DSH_DIAG', '1');

const now = () => performance.now();
const ms = (x) => `${x.toFixed(0)}ms`;
function median(xs) {
    const a = [...xs].sort((x, y) => x - y);
    return a.length ? a[Math.floor(a.length / 2)] : 0;
}
async function time(label, fn, reps = 3) {
    const out = [];
    for (let i = 0; i < reps; i++) {
        const t0 = now();
        try { await fn(); } catch (err) {
            if (i === 0) console.log(`   ⚠️ ${label}: ${err.message}\n${(err.stack || '').split('\n').slice(1, 6).join('\n')}`);
            continue;
        }
        out.push(now() - t0);
    }
    if (!out.length) return { label, ms: 0, min: 0, raw: [] };
    // ⚠️ 报**最小值**与**中位数**两个数：27k 节点的状态上跑几十次，主 GC 会落在某几次上
    //    （实测同一批操作里相邻两行 192ms、其余 ~620ms —— 差的就是一次大 GC）。
    //    `min` ≈ 真实工作量，`ms`（中位）≈ 用户在实际运行里会碰到的抖动上限。
    return { label, ms: median(out), min: Math.min(...out), raw: out };
}

// ---------------------------------------------------------------
// 真实模块
// ---------------------------------------------------------------
const { AppState, replaceState } = await import(mod('shell/state.js'));
const { execute } = await import(mod('shell/executor.js'));
const { produce } = await import('immer');
const { createInitialState } = await import(mod('core/model/state.js'));
const { EVENTS } = await import(mod('A_constants.js'));
const { getDisplayData } = await import(mod('view/dataAdapter.js'));
const { renderTree, ensureContainers } = await import(mod('ui/folder/folderMode.js'));
const { updateInfoBar } = await import(mod('view/info.js'));
const { getGlobalStats } = await import(mod('view/stats.js'));
const { registerAllEvents } = await import(mod('ui/eventBridge.js'));
const { computeModel, invalidateDedupCache } = await import(mod('ui/dedup/model.js'));
const { clearDerivedMemo } = await import(mod('core/derive.js'));
const { clearGroupMemo } = await import(mod('core/groupCompute.js'));
const { updateP } = await import(mod('core/ops/node.js'));
const { parseCrate } = await import(mod('features/AutoImport/parse.js'));
const { buildPlan } = await import(mod('features/AutoImport/plan.js'));
const { buildExtKeyIndex } = await import(mod('core/ops/upsert.js'));
const { applyPlans } = await import(mod('features/AutoImport/apply.js'));
const { applyFieldMap, RESERVED_KEYS } = await import(mod('features/AutoImport/fieldmap.js'));

// ---------------------------------------------------------------
// ① 导包（真实链路：parseCrate → buildPlan → applyPlans）
// ---------------------------------------------------------------
const PKG = process.env.PERF_PKG
    ? path.resolve(ROOT, process.env.PERF_PKG)
    : path.join(ROOT, 'acm-data', 'nodes', 'all_nodes.json');

replaceState(createInitialState());
AppState.settings.stats.countMode = process.env.PERF_MODE === 'dedup' ? 'dedup' : 'plain';
ensureContainers();
registerAllEvents();

const rows = [];
if (!process.env.PERF_SKIP_IMPORT) {
    const raw = JSON.parse(fs.readFileSync(PKG, 'utf8'));
    console.log(`📦 包：${path.relative(ROOT, PKG)}（${(raw.records || []).length} 条记录）`
        + `｜模式 ${AppState.settings.stats.countMode}`);
    const t = await time('导包（解析 + 计划 + 落库）', async () => {
        const parsed = parseCrate(raw, {});
        const plan = buildPlan({
            crate: parsed.crate, state: AppState, keyIndex: buildExtKeyIndex(AppState),
            applyFieldMap: (r, fm) => applyFieldMap(r, fm, { reservedKeys: RESERVED_KEYS })
        });
        const res = await applyPlans({ state: AppState, items: [{ plan, source: 'perf-bench' }] });
        if (!res || res.rejected) console.log(`   （导包结果：新建 ${res.created} / 更新 ${res.updated} / 拒 ${res.rejected}）`);
    }, 1);
    rows.push(t);
    // 只留第一次导包（后面重复导会走"全跳过"那条路，数字没意义）
}

const nodeCount = Object.keys(AppState.nodes).length;
console.log(`🌳 树：${nodeCount} 个节点`);
// 顶层字段的"体量"（immer 一次写要遍历/复制什么，一眼看清）
console.log('🧱 顶层字段：' + Object.keys(AppState).map((k) => {
    const v = AppState[k];
    const n = (v && typeof v === 'object') ? Object.keys(v).length : typeof v;
    return `${k}:${n}`;
}).join('  '));

// 让树上有一屏可画（展开若干比赛）
// ⚠️ 必须走 `produce`：节点对象现在是**冻的**（`core/model/state.js` 的 `freezeNodes`），
//    就地赋值会当场抛错（那正是它的用处）。这一步只是摆场景，成本不计进任何一行。
{
    const expand = [];
    let k = 0;
    for (const id of Object.keys(AppState.nodes)) {
        if (k >= 40) break;
        const n = AppState.nodes[id];
        if (n && (n.type === 'C' || n.type === 'S')) { expand.push(id); k++; }
    }
    replaceState(produce(AppState, (d) => {
        for (const id of expand) if (d.nodes[id]) d.nodes[id].expanded = true;
    }));
}
AppState.settings.display.treeDisplayMode = 'tree';

/** 找一个"有子节点的 P"当改值的目标（改它的 status1） */
const targetId = Object.keys(AppState.nodes).find((id) => AppState.nodes[id].type === 'P') || '';

// ---------------------------------------------------------------
// ② 各阶段（每项都尽量量"冷"的那一次：先清相关记忆化）
// ---------------------------------------------------------------
rows.push(await time('A 刷新广播（UI_REFRESH_REQUIRED 全链）', () => {
    document.dispatchEvent(new CustomEvent(EVENTS.UI_REFRESH_REQUIRED));
}, 3));

rows.push(await time('B 一次操作（execute 改一个 P + 广播）', async () => {
    await execute((d) => { if (d.nodes[targetId]) updateP(d, targetId, { status1: 1 }); },
        { skipHistory: true, validate: false });
}, 3));

// ---- B 的分解：用 `execute` 自带的开关做**二分**（谁贵一眼看出）----
// ⚠️ 这几条是**排查用**的（会直接改 `AppState.nodes` / 拿 draft 做实验，跑完状态就不是"干净树"了）
//    ⇒ 默认**不跑**：`PERF_PROBES=1` 才开（开着它会把后面真实操作的第一次跑炸成
//    "revoked proxy" —— 那是探针自己的副作用，不是应用的毛病）。
if (process.env.PERF_PROBES) {
    const { produce } = await import('immer');
    const { captureState } = await import(mod('transaction/history.js'));
    const { validateExpandedLimit } = await import(mod('core/validate/expanded.js'));
    const { refreshAllVirtualStats } = await import(mod('core/ops/virtualStats.js'));
    const { refreshCurrentPage } = await import(mod('ui/G_pageUI.js'));
    const { computeDiff } = await import(mod('persistence/diff.js'));

    const op = (d) => { if (d.nodes[targetId]) updateP(d, targetId, { status1: 1 }); };

    rows.push(await time('B1 只 immer produce（updateP）', () => { produce(AppState, op); }, 3));
    rows.push(await time('B1b 只 immer produce（什么都不改）', () => { produce(AppState, () => {}); }, 3));
    rows.push(await time('B1c 只 immer produce（改 meta 一个键）', () => { produce(AppState, (d) => { d.meta.__t = 1; }); }, 3));
    rows.push(await time('B1e 只 immer produce（改 settings 一个键）', () => {
        produce(AppState, (d) => { d.settings.display.nodePerPage = 30; });
    }, 3));
    // 探针：把"巨大的 nodes"从被测对象里拿掉 ⇒ 若变快，说明贵在**改过的父对象要遍历/复制它的孩子**
    rows.push(await time('B1g 探针 produce(小包装对象，不含 nodes)', () => {
        produce({ meta: AppState.meta, settings: AppState.settings, rootId: AppState.rootId },
            (d) => { d.meta.__t = 1; });
    }, 3));
    rows.push(await time('B1h 探针 produce(含 nodes 但不改它)', () => {
        produce({ meta: AppState.meta, nodes: AppState.nodes, childOrder: AppState.childOrder },
            (d) => { d.meta.__t = 1; });
    }, 3));
    // 探针：复现 `replaceState` 的"先把键全删掉再 assign"（V8 会把这个对象打成**字典模式**）
    const twin = {};
    for (let i = 0; i < 40; i++) twin[`k${i}`] = i;
    for (const k of Object.keys(twin)) delete twin[k];
    Object.assign(twin, AppState);
    rows.push(await time('B1i 探针 produce(delete+assign 造的同形对象)', () => {
        produce(twin, (d) => { d.meta.__t = 1; });
    }, 3));
    // 探针：全新初始状态（没经历过任何 replaceState / produce）
    {
        const { createInitialState } = await import(mod('core/model/state.js'));
        const fresh = createInitialState();
        rows.push(await time('B1j 探针 produce(全新初始状态)', () => {
            produce(fresh, (d) => { d.meta.__t = 1; });
        }, 3));
    }
    // 探针：把 AppState 的 **15 个键**照原样放进一个普通字面量
    {
        const lit = {};
        for (const k of Object.keys(AppState)) lit[k] = AppState[k];
        rows.push(await time('B1k 探针 produce(15 键字面量)', () => {
            produce(lit, (d) => { d.meta.__t = 1; });
        }, 3));
        const lit2 = { meta: AppState.meta, nodes: AppState.nodes, childOrder: AppState.childOrder,
            parentOf: AppState.parentOf, pages: AppState.pages, settings: AppState.settings };
        rows.push(await time('B1l 探针 produce(6 键，含 parentOf)', () => {
            produce(lit2, (d) => { d.meta.__t = 1; });
        }, 3));
        console.log(`   （AppState 键序：${Object.keys(AppState).join(',')}）`);
    }
    // 探针：**逐键二分** —— 到底哪个顶层键让 `produce` 变慢（还是"键多"本身）
    {
        const slow = [];
        for (const k of Object.keys(AppState)) {
            if (k === 'meta') continue;
            const lit = { meta: AppState.meta, [k]: AppState[k] };
            const t0 = now();
            for (let i = 0; i < 3; i++) produce(lit, (d) => { d.meta.__t = 1; });
            const cost = (now() - t0) / 3;
            if (cost > 30) slow.push(`${k}=${cost.toFixed(0)}ms`);
        }
        console.log(`   🔎 逐键探针（>30ms 的）：${slow.length ? slow.join('  ') : '（一个都没有）'}`);
        // 再看"键数"本身：取前 N 个键（始终带上 meta，好改）
        for (const N of [1, 2, 4, 6, 8, 10, 12, 14, 16]) {
            const keys = ['meta', ...Object.keys(AppState).slice(0, N)];
            const lit = {};
            for (const k of keys) lit[k] = AppState[k];
            const t0 = now();
            for (let i = 0; i < 3; i++) produce(lit, (d) => { d.meta.__t = 1; });
            console.log(`   🔎 前 ${String(N).padStart(2)} 个键（+meta）：${((now() - t0) / 3).toFixed(0)}ms`);
        }
        // ★ 关键探针：同样的 16 个键，只把**三个大字典挪到最后**，看还慢不慢
        {
            const keys = Object.keys(AppState);
            const big = ['nodes', 'childOrder', 'parentOf'];
            const small = keys.filter((k) => !big.includes(k));
            const reordered = {};
            for (const k of [...small, ...big]) reordered[k] = AppState[k];
            const lit = {};
            for (const k of keys) lit[k] = AppState[k];      // 原顺序（慢的那个）
            const t0 = now();
            for (let i = 0; i < 3; i++) produce(lit, (d) => { d.meta.__t = 1; });
            const slowMs = (now() - t0) / 3;
            const t1 = now();
            for (let i = 0; i < 3; i++) produce(reordered, (d) => { d.meta.__t = 1; });
            const fastMs = (now() - t1) / 3;
            console.log(`   🔎 16 键：原顺序 ${slowMs.toFixed(0)}ms ｜ 大字典挪到最后 ${fastMs.toFixed(0)}ms`);
        }
        // 再把 `updateP` 拆成几行，看是哪一行贵
        {
            const { assertManualEditAllowed } = await import(mod('core/ops/account.js'));
            const { setDerivedOverride } = await import(mod('core/fieldValue.js'));
            const probe = (label, fn) => {
                const t0 = now();
                for (let i = 0; i < 3; i++) produce(AppState, fn);
                console.log(`   🔎 ${label}：${((now() - t0) / 3).toFixed(0)}ms`);
            };
            probe('只改 node.name', (d) => { d.nodes[targetId].name = 'x'; });
            probe('只改 node.lastModified', (d) => { d.nodes[targetId].lastModified = 'x'; });
            probe('只读 node.values（不写）', (d) => { const n = d.nodes[targetId]; if (n.values) n.values.status1; });
            probe('展开 node.values（{...}，不写回）', (d) => { const n = d.nodes[targetId]; if (n.values) ({ ...n.values }); });
            probe('node.values 整个换成一个新对象', (d) => {
                const n = d.nodes[targetId]; n.values = { ...n.values };
            });
            probe('只写 node.values.status1 数组', (d) => {
                const n = d.nodes[targetId];
                if (!n.values) n.values = {};
                n.values.status1 = [{ v: '1', src: 'manual', at: 'x', account: 'local' }];
            });
            probe('assertManualEditAllowed(draft)', (d) => { assertManualEditAllowed(d, 'x'); });
            {
                const fv = await import(mod('core/fieldValue.js'));
                const st = await import(mod('core/model/status.js')).catch(() => ({}));
                probe('isPinValue(status1,1)', () => { fv.isPinValue ? fv.isPinValue('status1', 1) : 0; });
                probe('normalizeFieldValue(status1)', () => {
                    fv.normalizeFieldValue ? fv.normalizeFieldValue('status1', '1') : 0;
                });
                probe('addSourceValue(手动值)', (d) => {
                    fv.addSourceValue(d.nodes[targetId], 'status1', '1', 'manual', { at: 'x', account: 'local' });
                });
                probe('removeManualValue', (d) => {
                    if (fv.removeManualValue) fv.removeManualValue(d.nodes[targetId], 'status1', 'local');
                });
                void st;
            }
            probe('setDerivedOverride(node)', (d) => {
                setDerivedOverride(d.nodes[targetId], 'status1', 1, { at: 'x', account: d.currentAccountId });
            });
        }
    }
    rows.push(await time('B1f 只 immer produce（直接改一个 P 的 name）', () => {
        produce(AppState, (d) => { const n = d.nodes[targetId]; if (n) n.name = 'x'; });
    }, 3));
    rows.push(await time('B9 rebuildParentOf（27k 一次）', async () => {
        const { rebuildParentOf } = await import(mod('core/model/state.js'));
        rebuildParentOf(AppState.childOrder);
    }, 3));
    // ---- B2 与 B3 之间只差两件事：① 副页统计在 draft 里跑 ② 标脏 + 落盘登记 ----
    {
        const { scheduleSave, hasPendingSave } = await import(mod('persistence/index.js'));
        const { markModified } = await import(mod('core/model/infoState.js'));
        const { classifyChanges } = await import(mod('core/model/dirtyFlags.js'));
        const { applyState } = await import(mod('transaction/history.js'));
        const { rebuildParentOf } = await import(mod('core/model/state.js'));
        rows.push(await time('P1 scheduleSave（登记落盘）', async () => { await scheduleSave(AppState); }, 3));
        rows.push(await time('P2 副页统计（在 draft 里）', async () => {
            const im = await import('immer');
            im.produce(AppState, (d) => { refreshAllVirtualStats(d); });
        }, 3));
        rows.push(await time('P3 classifyChanges + applyState + rebuildParentOf', async () => {
            const { produce } = await import('immer');
            const next = produce(AppState, (d) => { d.nodes[targetId].name = 'y'; });
            classifyChanges(AppState, next);
            applyState(AppState, next);
            rebuildParentOf(AppState.childOrder);
        }, 3));
        rows.push(await time('P4 markModified({nodes:true})', () => { markModified({ nodes: true }); }, 3));
        rows.push(await time('P5 flushPendingSave（真写一遍）', async () => {
            const { flushPendingSave } = await import(mod('persistence/index.js'));
            await flushPendingSave(AppState);
        }, 1));
        void hasPendingSave;
    }
    rows.push(await time('B2 execute（关历史/校验）', async () => {
        await execute(op, { skipHistory: true, validate: false });
    }, 3));
    rows.push(await time('B3 execute（再关副页统计 + 不落盘）', async () => {
        await execute(op, { skipHistory: true, validate: false, skipVirtualStats: true, skipPersist: true });
    }, 3));
    rows.push(await time('B4 校验 validateExpandedLimit', () => {
        validateExpandedLimit(AppState, AppState.settings.performance.expandedNodeBlockLimit,
            AppState.settings.display.nodePerPage);
    }, 3));
    rows.push(await time('B5 历史 captureState', () => { captureState(AppState); }, 3));
    rows.push(await time('B6 副页统计 refreshAllVirtualStats', () => {
        refreshAllVirtualStats({ pages: AppState.pages, nodes: AppState.nodes });
    }, 3));
    rows.push(await time('B7 落盘 diff computeDiff', () => { computeDiff(AppState, AppState); }, 3));
    rows.push(await time('B8 冷刷新链 refreshCurrentPage（先清记忆化）', () => {
        clearDerivedMemo();
        clearGroupMemo();
        invalidateDedupCache();
        refreshCurrentPage();
    }, 3));
}

rows.push(await time('C 树上渲染 renderTree()', () => { renderTree(); }, 5));

// ★ **切副页**的基准（2026-10-18 加，用户："切进副页比切进主页慢"）：
//   原来 bench 一条副页都没有（导出包 `pages=0`）⇒ 这条一直没被量过。
//   做法：用 core 的 `addPage` 真建一个副页（**不自己拼 page 对象**，只读守卫也在它里面），
//   再按 `SWITCH_PAGE` 那条真实路径的顺序量：清记忆化 → 切 `currentPageId` → `refreshCurrentPage()`。
{
    const { produce } = await import('immer');
    const { addPage } = await import(mod('core/ops/page.js'));
    const { refreshCurrentPage } = await import(mod('ui/G_pageUI.js'));
    let pageId = '';
    const made = produce(AppState, (d) => {
        const pg = addPage(d, 'bench-副页');
        d.currentPageId = pg.id;
        pageId = pg.id;
    });
    // 只把这三样贴回（诊断用；别整份 Object.assign —— `nodes` 等大字典要走引用）
    AppState.pages = made.pages;
    AppState.plans = made.plans;
    AppState.currentPageId = made.currentPageId;
    // ★ 给这个副页**灌真实内容**（2026-10-18 第二轮）：上一版建的是空页 ⇒ P0/P1 都 0ms、量不出东西。
    //   走向键那套 core 操作（`batchCopyToPage(recursive)`，界面「挂进副页」用的就是它），
    //   把某个比赛下的整棵子树挂进去（≈一个真实"题单"副页的规模）。
    {
        const { batchCopyToPage } = await import(mod('core/ops/page.js'));
        // 选**一大批 P**（≈ 用户那页「我的题单 (3638)」的规模）整批挂进去（非递归，每题一条 vNode）
        const pNodes = Object.values(AppState.nodes || {}).filter((n) => n && n.type === 'P').slice(0, 3000);
        {
            const filled = produce(AppState, (d) => {
                try {
                    batchCopyToPage(d, pNodes.map((n) => n.id), pageId, { recursive: false, skipDuplicateCheck: true });
                } catch (err) {
                    rows.push({ label: `（信息）灌副页失败：${String(err && err.message).slice(0, 40)}`,
                        ms: 0, min: 0, raw: [] });
                }
            });
            AppState.pages = filled.pages;
            const vn = Object.keys((filled.pages[pageId] || {}).virtualIndex || {}).length;
            rows.push({ label: `（信息）副页内容 = ${vn} 个 vNode（P × ${pNodes.length}）`,
                ms: 0, min: 0, raw: [] });
        }
    }
    rows.push({ label: `（信息）副页 id = ${pageId}｜页数 ${Object.keys(AppState.pages || {}).length}`, ms: 0, min: 0, raw: [] });
    rows.push(await time('P0 切副页：冷刷新链 refreshCurrentPage', () => {
        clearDerivedMemo();
        clearGroupMemo();
        invalidateDedupCache();
        refreshCurrentPage();
    }, 3));
    rows.push(await time('P1 切副页：热（记忆化命中）refreshCurrentPage', () => {
        refreshCurrentPage();
    }, 5));
    // ★ 把 P1 的 72ms 拆开（2026-10-18 第三轮）：副页分支只有两步
    //   `renderVirtualPage(pageId)`（虚拟树）+ `renderPageDashboard(pageId)`（仪表盘）。
    {
        const { renderVirtualPage } = await import(mod('ui/folder/virtualFolderMode.js'));
        const { renderPageDashboard } = await import(mod('ui/folder/pageDashboard.js'));
        rows.push(await time('P1a 副页：renderVirtualPage（热）', () => { renderVirtualPage(pageId); }, 5));
    // ★ 再拆 P1a（2026-10-18 第四轮）：它里面四步，逐段量
    {
        const { getVirtualGlobalStats } = await import(mod('view/stats.js'));
        const { getDisplayData } = await import(mod('view/dataAdapter.js'));
        const page = AppState.pages[pageId];
        rows.push(await time('P1a1 副页：getVirtualGlobalStats', () => {
            getVirtualGlobalStats(AppState, page);
        }, 5));
        // ★ 按页分槽（2026-10-18，用户："记忆化怎么是共用槽位的？"）：单槽时代 **B 会把 A 顶掉**
        //   ⇒ 从另一页回到本页就等于整份重算。这一行量的是"回来后还命不命中"。
        //   ⚠️ "另一页"必须是**同一个对象**（槽里按引用比；每轮新建一个 clone 会永远落空 ⇒ 量错东西）。
        const otherPage = { ...page, id: 'page_bench_other' };
        rows.push(await time('P1a1b 副页统计：先在另一页算一遍、再回本页（分槽 ⇒ 命中 ~0ms）', () => {
            getVirtualGlobalStats(AppState, otherPage);
            getVirtualGlobalStats(AppState, page);
        }, 5));
        let data = null;
        rows.push(await time('P1a2 副页：getDisplayData(tree, pageId)', () => {
            data = getDisplayData(AppState, { mode: 'tree', pageId });
        }, 5));
        {
            const { renderTreeView } = await import(mod('view/viewRenderers.js'));
            rows.push(await time('P1a3 副页：renderTreeView（只出 HTML/挂 DOM）', () => {
                if (data && data.type === 'tree') renderTreeView(AppState, data, 'tree-body');
            }, 5));
        }
    }
        rows.push(await time('P1b 副页：renderPageDashboard（热）', () => { renderPageDashboard(pageId); }, 5));
        // ★ 计划栏（2026-10-18）：原来的形状在一趟渲染里把 `planProgressOf` 算了 **3 遍**
        //   （两遍 refreshPageBadges + 一遍 planBarDataOf）⇒ 先量一份的价，×3 那条只是**参照**。
        {
            const { planBarDataOf } = await import(mod('ui/plan/planBar.js'));
            const { planOfPage } = await import(mod('core/ops/plan.js'));
            const plan = planOfPage(AppState, pageId);
            rows.push(await time('P1c 副页：planProgressOf ×1（角标与计划栏共用这一份）',
                () => { planBarDataOf(plan); }, 5));
            rows.push(await time('P1c′ 副页：planProgressOf ×3（旧形状·仅参照）',
                () => { planBarDataOf(plan); planBarDataOf(plan); planBarDataOf(plan); }, 5));
            if (document.getElementById('plan-bar')) {
                const { renderPlanBar } = await import(mod('ui/plan/planBar.js'));
                rows.push(await time('P1d 副页：renderPlanBar（整条：角标 + 一行）',
                    () => { renderPlanBar(); }, 5));
            }
        }
    }
    // 对照：切回主页同一套口径
    AppState.currentPageId = 'main';
    rows.push(await time('P2 切主页：热 refreshCurrentPage（对照）', () => {
        refreshCurrentPage();
    }, 5));
    rows.push(await time('P3 切主页：冷刷新链 refreshCurrentPage（对照）', () => {
        clearDerivedMemo();
        clearGroupMemo();
        invalidateDedupCache();
        refreshCurrentPage();
    }, 3));
    // ★ 切页事务本身（2026-10-18，第 5 轮）：**副页已经灌满之后**再量 ——
    //   上面 B2/B3 那两条跑在"还没有副页"的时候，所以它们看不出 `refreshAllVirtualStats` 的代价。
    {
        const { execute } = await import(mod('shell/executor.js'));
        rows.push(await time('P4 切页事务（带副页统计）', async () => {
            await execute((d) => { d.currentPageId = 'main'; }, { validate: false, skipHistory: true });
        }, 3));
        rows.push(await time('P5 切页事务（**关**副页统计）', async () => {
            await execute((d) => { d.currentPageId = pageId; },
                { validate: false, skipHistory: true, skipVirtualStats: true });
        }, 3));
    }
}


rows.push(await time('D 投影 getDisplayData(main)', () => {
    getDisplayData(AppState, { mode: 'tree', currentPage: 1 });
}, 5));

rows.push(await time('E 统计栏 getGlobalStats + updateInfoBar', () => {
    getGlobalStats(AppState);
    updateInfoBar(AppState);
}, 3));

// ---- E 的分解：DB_MODIFIED 那条链 + "统计缓存一凉就重数 2.7 万节点" ----
{
    const { markStatsDirty } = await import(mod('view/stats.js'));
    rows.push(await time('E1 冷统计 getGlobalStats（先 markStatsDirty）', () => {
        markStatsDirty();
        getGlobalStats(AppState);
    }, 3));
    // ★ 「真算一次」要多少钱（2026-10-18 加）：上面那条走的是**延迟墙**（第五轮的设计 ——
    //   先返回上一次那串、200ms 后再算），所以 E1 显示 0ms **不代表算一次是 0ms**。
    //   这一条绕开延迟墙，直接量计算本身（`computeGlobalStats`）。
    {
        const { computeGlobalStats } = await import(mod('view/stats.js'));
        rows.push(await time('E1b 统计真算一次 computeGlobalStats（绕开延迟墙）', () => {
            computeGlobalStats(AppState);
        }, 3));
    }
    rows.push(await time('E2 广播 DB_MODIFIED（整条监听链，热）', () => {
        document.dispatchEvent(new CustomEvent(EVENTS.DB_MODIFIED));
    }, 3));
    // ★ 默认参数那条路里真正发生的是"统计刚被标脏 + 广播" ⇒ 冷的那条链
    rows.push(await time('E2b 广播 DB_MODIFIED（**冷**：先标脏统计）', () => {
        markStatsDirty();
        document.dispatchEvent(new CustomEvent(EVENTS.DB_MODIFIED));
    }, 3));
    rows.push(await time('E4 resetFolderStateIfInvalid', async () => {
        const { resetFolderStateIfInvalid } = await import(mod('ui/folder/folderShared.js'));
        if (typeof resetFolderStateIfInvalid === 'function') resetFolderStateIfInvalid();
    }, 3));
    rows.push(await time('E5 updateInfoBar（单项）', () => { updateInfoBar(AppState); }, 3));
    rows.push(await time('E3 getTotalNodeCount（27k 走一遍）', async () => {
        const { getTotalNodeCount } = await import(mod('view/stats.js'));
        getTotalNodeCount(AppState);
    }, 3));
}

rows.push(await time('F 派生表（冷）buildDerivedTable', async () => {
    clearDerivedMemo();
    const { buildDerivedTable } = await import(mod('core/derive.js'));
    buildDerivedTable(AppState, {});
}, 3));

// ★ 增量那半：改一个 P 之后取表（走记忆化 + 只重算"变了的 + 祖先"）
{
    const { derivedTable } = await import(mod('core/derive.js'));
    derivedTable(AppState);                     // 先建一次（= 初始化那份）
    let n = 0;
    rows.push(await time('F2 派生表（增量：改一个 P 后取表）', async () => {
        const { produce } = await import('immer');
        // 每轮换一个 P 改，模拟真实点击（结构不变 ⇒ 走增量）
        const ids = Object.keys(AppState.nodes).filter((x) => AppState.nodes[x].type === 'P');
        const id = ids[(n++) % Math.max(1, ids.length)];
        AppState.nodes = produce(AppState.nodes, (d) => { if (d[id]) d[id].name = 'p' + n; });
        derivedTable(AppState);
    }, 5));
}

rows.push(await time('G 组三趟（冷）groupComputed', async () => {
    clearGroupMemo();
    const { groupComputed } = await import(mod('core/groupCompute.js'));
    groupComputed(AppState, {});
}, 3));

rows.push(await time('H ⑤ 冲突算一遍（冷）computeModel', () => {
    invalidateDedupCache();
    computeModel();
}, 3));

rows.push(await time('H2 ⑤ 冲突（热，记忆化命中）computeModel', () => {
    computeModel();
}, 5));

// ---- H 的分解（2026-10-18 加）：那 614ms 到底花在哪几段 ----
// 只**调现成的那些函数**（`computeModel` 内部就是按这个顺序挨个调它们），不改生产代码。
// ⚠️ 各段相加≈总时间，但由于记忆化有时会互相预热，**只能看量级**，别当精确和。
{
    const {
        collectDedupFacets, collectNatureItems, scopeNodeIds, suggestMembers, synthGroups, unownedMaterialIds
    } = await import(mod('core/dedup.js'));
    const { findDanglingOwners } = await import(mod('core/ops/synth.js'));
    const { collectGroups } = await import(mod('core/query/groupCount.js'));
    const { synthConflicts } = await import(mod('core/synthConflicts.js'));
    const { viewState } = await import(mod('ui/dedup/state.js'));
    const nodes = AppState.nodes || {};
    const parentOf = AppState.parentOf || {};
    const one = async (label, fn) => {
        invalidateDedupCache();
        rows.push(await time('H· ' + label, fn, 2));
    };
    // `resolveScope()` 没有导出（它是 `computeModel` 里的私有函数）⇒ 这一段并入
    // `scopeNodeIds` 一起看：那一步拿到了范围就要把整棵树的 id 走一遍。
    await one('scopeNodeIds（范围 → id 集合）', () => scopeNodeIds(AppState, { type: 'all' }));
    await one('collectNatureItems（③ 两摞）', () => collectNatureItems(AppState, { includeFilled: true }));
    await one('suggestMembers（候选区）', () => suggestMembers(nodes, parentOf, {
        mode: viewState.mode, filter: viewState.filter, scopeIds: null
    }));
    await one('synthGroups（组）', () => synthGroups(AppState));
    await one('synthConflicts（⑤ 冲突那一栏）', () => synthConflicts(nodes, AppState));
    // ★ 把 `synthConflicts` 再拆成几段（2026-10-18）：它接受可选的 `onPhase(段名)`，
    //   **不传就完全没开销**（生产路径就是这么调的）。这里拿时间戳把每段落成一行。
    {
        const { clearDedupCache } = { clearDedupCache: () => invalidateDedupCache() };
        clearDedupCache();
        const marks = [];
        const t0 = now();
        synthConflicts(nodes, AppState, (name) => marks.push({ name, at: now() }));
        let prev = t0;
        for (const m of marks) {
            const ms = m.at - prev;
            rows.push({ label: 'H·→ ⑤ ' + m.name, ms, min: ms, raw: [] });
            prev = m.at;
        }
    }
    // ★ 再拆 `problemBindPlan`（2026-10-18）：主循环里**每场**都会喊一遍同名段 ⇒ 这里**按名字累加**。
    {
        const { problemBindPlan } = await import(mod('core/synthPlan.js'));
        const { asCrateRecords } = await import(mod('core/synthConflicts.js'));
        const records = asCrateRecords(nodes, parentOf).records;
        const acc = new Map();
        let prev = now();
        const res = problemBindPlan(records, null, null, (name) => {
            const at = now(); acc.set(name, (acc.get(name) || 0) + (at - prev)); prev = at;
        });
        if (res && res.groups && acc.size) {
            for (const [name, ms] of acc) rows.push({ label: 'H··→ pb ' + name, ms, min: ms, raw: [] });
        }
    }
    // ★ 再拆一层（2026-10-18，用户："再拆A"）：`synthConflicts` 里第一件事就是建分组表
    //   （`synthIndex`），后面才是年份/分类/题目绑定那几圈。先看这张表吃多少：
    //   它小 ⇒ 332ms 全在后面的循环里，要再拆就得往生产代码里打点（这一步只量、不改）。
    {
        const { synthIndex } = await import(mod('core/ops/synth.js'));
        await one('synthIndex（分组表，⑤ 的第一步）', () => synthIndex({ nodes }));
    }
    await one('collectGroups（计数口径 + 黄条）', () => collectGroups({ nodes }));
    await one('facets / unowned / dangling（三小段合计）', () => {
        collectDedupFacets(nodes);
        unownedMaterialIds(nodes);
        findDanglingOwners(AppState);
    });
}

// ---------------------------------------------------------------
// ③ 真实操作逐个量（用**界面那套默认参数**：带历史、带校验、带落盘登记）
// ---------------------------------------------------------------
{
    const { updateP } = await import(mod('core/ops/node.js'));
    const { addChild } = await import(mod('core/ops/tree.js'));
    const { toggleNodeExpanded } = await import(mod('core/ops/view.js'));
    const { undo } = await import(mod('shell/executor.js'));

    const pIds = Object.keys(AppState.nodes).filter((x) => AppState.nodes[x].type === 'P');
    // ⚠️ 固定同一个节点（不用 `n++`）：一开始各行换节点测，看起来像"开关"的差别，
    //    其实可能只是"不同节点的 values 大小不同"——先把这个变量钉死。
    const fixed = pIds[0];
    const pick = () => fixed;
    console.log(`  （ops 前：pages=${Object.keys(AppState.pages || {}).length} 个）`);
    const cId = Object.keys(AppState.nodes).find((x) => AppState.nodes[x].type === 'C') || '';
    let n = 0;

    const ops = [
        // ⚠️ 这几行是"对调实验"：把 `{}`（默认）放在**第 3 行**、`{skipVirtualStats:true}` 放在**第 6 行**。
        //    若"快"跟着**开关**走 ⇒ `refreshAllVirtualStats` 真有个 380ms 的坑；
        //    若"快"跟着**行号**走 ⇒ 是热机/顺序效应（那就要看每轮的环境变量差异，见下面打印）。
        ['点「已处理」A（默认）', () => execute((d) => updateP(d, pick(), { status1: 1 }), {})],
        ['同上 B（关历史）', () => execute((d) => updateP(d, pick(), { status1: 1 }), { skipHistory: true })],
        ['同上 C（默认，第 3 行）', () => execute((d) => updateP(d, pick(), { status1: 1 }), {})],
        ['同上 D（三个全关）', () => execute((d) => updateP(d, pick(), { status1: 1 }),
            { skipHistory: true, skipVirtualStats: true, skipPersist: true })],
        ['同上 E（关副页统计）', () => execute((d) => updateP(d, pick(), { status1: 1 }), { skipVirtualStats: true })],
        ['同上 F（关副页统计，第 6 行）', () => execute((d) => updateP(d, pick(), { status1: 1 }), { skipVirtualStats: true })],
        ['同上 G（默认，第 7 行）', () => execute((d) => updateP(d, pick(), { status1: 1 }), {})],
        ['点「忽略」（status2=5，覆盖值）', () => execute((d) => updateP(d, pick(), { status2: 5 }), {})],
        ['改题名（编辑弹窗保存）', () => execute((d) => updateP(d, pick(), { name: '改名' + n }), {})],
        ['新建一道题（+ 自动编号）', () => execute((d) => addChild(d, cId, 'P', '新题', {}), {})],
        ['折叠/展开一个比赛', () => execute((d) => toggleNodeExpanded(d, cId),
            { skipHistory: true, skipPersist: true, skipVirtualStats: true })],
        ['撤回一步', async () => { await undo(); }]
    ];
    // 对照：把"操作本身（在 draft 里跑）"逐个拆开（⚠️ 一律用**块体** ——
    // 表达式体会把 op 的返回值（一个 draft）当 recipe 结果 ⇒ immer 直接 `die(4)`）
    {
        const { produce } = await import('immer');
        const { autoUpdateSubtree, propagateUp } = await import(mod('core/autoCompute.js'));
        const only = (label, fn) => {
            const t0 = now();
            for (let i = 0; i < 3; i++) produce(AppState, fn);
            rows.push({ label: `（对照）只 produce：${label}`, ms: (now() - t0) / 3, min: (now() - t0) / 3, raw: [] });
        };
        only('updateP(status1)', (d) => { updateP(d, pick(), { status1: 1 }); });
        only('addChild(P)', (d) => { addChild(d, cId, 'P', '探针', {}); });
        only('只改 meta.idCounter', (d) => { d.meta.idCounter += 1; });
        only('给 nodes 加一个键再删掉', (d) => { d.nodes['__probe__'] = { id: '__probe__' }; delete d.nodes['__probe__']; });
        only('只改一个节点的字段', (d) => { d.nodes[pick()].lastModified = 'x'; });
        only('只改一个节点的 values', (d) => { const n = d.nodes[pick()]; n.values = { ...n.values, __p: [{ v: '1', src: 'manual', at: 'x' }] }; });
        only('autoUpdateSubtree + propagateUp', (d) => { autoUpdateSubtree(d, cId); propagateUp(d, cId); });
        // ★ 结构改动多出来的那两笔（2026-10-18 加，回答"加一个节点凭什么比改一个慢 5 倍"）：
        //   ⚠️ **两条都只是"手动整拷"的量，不等同于真实路径**：
        //   · `childOrder` 那条**有代表性**：写路径确实在 produce 里碰它（`d.childOrder[父] = [...]`），
        //     而 Immer 一旦碰这张表就把每个父的数组都 draft 一遍 ⇒ 这条量的是那个代价。
        //   · `parentOf` 那条**没有代表性**：`parentOf` 是**派生索引**（不进快照，
        //     `transaction/history.js` 的 `SNAPSHOT_KEYS` 里没有它；`applyState` 只在
        //     `structChanged` 时 `rebuildParentOf(childOrder)`，注释实测 ~9ms/次）。
        //     ⇒ 真实路径**不会**在事务里整张拷它；这条留着只当"整拷要多少钱"的参照。
        only('{ ...childOrder } 浅拷（结构改动才有；**有代表性**）', (d) => {
            d.childOrder = { ...d.childOrder };
        });
        only('{ ...parentOf } 浅拷（**仅参照**：真实路径里它是派生索引、不走这条路）', (d) => {
            d.parentOf = { ...d.parentOf };
        });
    }

    for (const [label, fn] of ops) {
        // 每轮把"环境变量"也记下来（未保存标记 / 待写 / 历史深度）——A/B 里排不掉的变量就在这儿
        const { InfoState } = await import(mod('core/model/infoState.js'));
        const { hasPendingSave } = await import(mod('persistence/index.js'));
        const { getHistoryCount } = await import(mod('transaction/history.js'));
        const env0 = `${InfoState.dbIsSaved ? 'saved' : 'unsaved'}|pend:${hasPendingSave() ? 1 : 0}|his:${getHistoryCount()}`;
        const r = await time(`操作：${label}`, fn, 7);
        const env1 = `${InfoState.dbIsSaved ? 'saved' : 'unsaved'}|pend:${hasPendingSave() ? 1 : 0}|his:${getHistoryCount()}`;
        r.label += `   ［前 ${env0} → 后 ${env1}］`;
        rows.push(r);
    }

    // 延迟那一笔（不在点击那条路上，但在同一个线程上跑）
    const { flushPendingSave } = await import(mod('persistence/index.js'));
    rows.push(await time('操作：落盘写（延迟 ~300ms 后自己跑）', async () => {
        await flushPendingSave(AppState);
    }, 3));

    // 打开/刷新那两个"重"页面
    rows.push(await time('开判重整理页（冷算整页模型）', () => { invalidateDedupCache(); computeModel(); }, 3));
    rows.push(await time('开节点信息页（算「组那份」，冷）', async () => {
        clearGroupMemo();
        const { groupComputed } = await import(mod('core/groupCompute.js'));
        groupComputed(AppState, {});
    }, 3));
}

// ---------------------------------------------------------------
// ④ 报告：按耗时排序（大的排前面）
// ---------------------------------------------------------------
console.log('\n========== 分阶段耗时（中位数 / 最小值） ==========');
for (const r of [...rows].sort((a, b) => b.ms - a.ms)) {
    console.log(`  ${ms(r.ms).padStart(8)}  (最小 ${ms(r.min).padStart(6)})   ${r.label}`);
}
console.log('\n（DOM 是 smoke 桩：真实浏览器还要再加解析/布局/绘制；'
    + '这里量的是 JS 里能算的那部分）');
