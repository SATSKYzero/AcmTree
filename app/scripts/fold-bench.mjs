// ================================================================
// 折叠耗时探针（scripts/fold-bench.mjs）
//
// 为什么要有它：
//   折叠慢的成因不止快照那一处（快照那半确实生效，而展开节点数只有几十时它仍然慢）⇒
//   所以这里**先量，不猜**：把一次折叠按阶段拆开计时，看谁随节点数增长。
//
// 怎么跑（纯 Node，用 smoke 那套 register/loader 桩加载真实模块）：
//   node --import ./scripts/smoke/register.mjs scripts/fold-bench.mjs
//   （也可： node --import scripts/smoke/register.mjs scripts/fold-bench.mjs）
//
// ⚠️ 它**不进** `npm test` / `npm run test:smoke` 的自动列表 —— 它是诊断工具，不是断言。
//
// 口径与边界：
//   · 量的是**浏览器 JS 里的同一批代码**（真实 AppState + execute + 真实渲染函数）；
//   · DOM 用 smoke 的桩（`innerHTML` 默认不解析）⇒ **只算"拼 HTML 字符串 + 遍历"**，
//     真实浏览器里的 HTML 解析/布局/绘制要另加（那部分 Node 量不到，见报告）；
//   · IndexedDB 用 smoke 的内存桩 ⇒ `idbBatch` 只体现"异步一拍"，不体现磁盘；
//   · localStorage 用本文件的计量桩（会记录写入字节数）。
// ================================================================
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import { installDom } from './smoke/dom.mjs';
import { installIndexedDb } from './smoke/idb.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const mod = rel => `file://${path.join(SRC, rel).replace(/\\/g, '/')}`;

// ---------------------------------------------------------------
// 0) 环境桩（必须在 import 被测模块之前装好）
// ---------------------------------------------------------------
installDom();
installIndexedDb();

// 渲染路径要用到的那几个容器（真实 index.html 里有；桩里没有 ⇒ 补上）
function ensureContainers() {
    const ids = ['tree-body', 'tree-stats', 'mode-action-btn-container', 'folder-breadcrumb',
        'folder-view-tabs', 'folder-stats', 'stats-chart-container', 'info-bar', 'tab-bar'];
    for (const id of ids) {
        if (!document.getElementById(id)) {
            const el = document.createElement('div');
            el.id = id;
            document.body.appendChild(el);
        }
    }
}
ensureContainers();

// 诊断：FOLD_TRACE=1 时，把 UI_REFRESH_REQUIRED 的每次派发连同**调用栈**打出来
if (process.env.FOLD_TRACE) {
    const rawDispatch = document.dispatchEvent.bind(document);
    const seen = [];
    document.dispatchEvent = (ev) => {
        if (ev && ev.type && String(ev.type).includes('refresh-required')) {
            const stack = (new Error().stack || '').split('\n').slice(2, 6)
                .map(s => s.trim().replace(/^at\s+/, '').replace(/\s*\(.*?([^\\/]+:\d+:\d+)\)$/, ' @$1')).join('  ←  ');
            seen.push(stack);
        }
        return rawDispatch(ev);
    };
    globalThis.__foldTrace = () => seen;
}

// localStorage：计量桩（记录写入次数与字节数）
const LS = { data: new Map(), writes: 0, bytes: 0 };
globalThis.localStorage = {
    getItem: k => (LS.data.has(k) ? LS.data.get(k) : null),
    setItem: (k, v) => { LS.writes++; LS.bytes += String(k).length + String(v).length; LS.data.set(k, String(v)); },
    removeItem: k => { LS.data.delete(k); },
    clear: () => LS.data.clear()
};

// ---------------------------------------------------------------
// 1) 真实模块
// ---------------------------------------------------------------
const { AppState, replaceState } = await import(mod('shell/state.js'));
const { execute } = await import(mod('shell/executor.js'));
const { produce } = await import('immer');
const { createInitialState, rebuildParentOf } = await import(mod('core/model/state.js'));
const { toggleNodeExpanded } = await import(mod('core/ops/view.js'));
const { saveExpanded, collectExpanded, scheduleExpandedSave, flushExpandedSave } = await import(mod('core/model/expandedCache.js'));
const { refreshAllVirtualStats } = await import(mod('core/ops/virtualStats.js'));
const { validateExpandedLimit, getCurrentRenderedCount } = await import(mod('core/validate/expanded.js'));
const { computeDiff } = await import(mod('persistence/diff.js'));
const { saveData } = await import(mod('persistence/index.js'));
const { updateInfoBar } = await import(mod('view/info.js'));
const { refreshCurrentPage } = await import(mod('ui/G_pageUI.js'));
const { EVENTS } = await import(mod('A_constants.js'));

// 渲染：树形/文件夹视图（真实函数）
const { renderTree } = await import(mod('ui/folder/folderMode.js'));

// ---------------------------------------------------------------
// 2) 合成状态（形状尽量贴近真实：O → W → S → C → P；另加一个副页）
// ---------------------------------------------------------------
function makeState(n, vNodes = 2000) {
    const base = createInitialState();
    const nodes = {};
    const childOrder = {};
    const add = (id, type, parent) => {
        nodes[id] = {
            id, type, name: `${type}-${id}`, extKey: `${type.toLowerCase()}:${id}`,
            expanded: false, currentPage: 1, selected: false,
            status1: 0, status2: 0, values: {}
        };
        childOrder[id] = [];
        if (parent) childOrder[parent].push(id);
    };

    // 结构：O → 20 个 W → 每个 W 2 个 S → 每个 S 若干 C → 每个 C 若干 P
    add('o', 'O', null);
    let made = 1;
    let w = 0;
    while (made < n) {
        const wid = `w${w++}`;
        add(wid, 'W', 'o'); made++;
        for (let s = 0; s < 2 && made < n; s++) {
            const sid = `${wid}s${s}`;
            add(sid, 'S', wid); made++;
            for (let c = 0; c < 4 && made < n; c++) {
                const cid = `${sid}c${c}`;
                add(cid, 'C', sid); made++;
                for (let p = 0; p < 12 && made < n; p++) {
                    add(`${cid}p${p}`, 'P', cid); made++;
                }
            }
        }
    }

    const state = { ...base, rootId: 'o', nodes, childOrder, parentOf: rebuildParentOf(childOrder) };
    // 副页：一条虚拟链（v0 → v1 → … ），refId 指向真实 P，供 refreshAllVirtualStats 走一遍
    const virtualIndex = {};
    for (let i = 0; i < vNodes; i++) {
        virtualIndex[`v${i}`] = {
            id: `v${i}`, type: i % 7 === 0 ? 'C' : 'P', expanded: false, currentPage: 1, selected: false,
            children: i % 7 === 0 ? [`v${i + 1}`].filter(x => virtualIndex[x] || i + 1 < vNodes) : [],
            refId: `w0s0c0p0`
        };
    }
    state.pages = {
        ...(base.pages || {}),
        main: { id: 'main', name: '主视图', currentPage: 1, selected: false, expanded: false, virtualIndex, vNodeStats: {} }
    };
    state.currentPageId = 'main';
    return state;
}

// 让"可见树"有一定规模：把每个 S 下的 C 展开（模拟用户展开几十个节点）
// ⚠️ 走事务：节点对象是冻的（`core/model/state.js` 的 `freezeNodes`），事务外就地改会抛错
function expandSome(state, howMany = 40) {
    const ids = [];
    for (const id in state.nodes) {
        if (ids.length >= howMany) break;
        const n = state.nodes[id];
        if (n.type === 'C' || n.type === 'S') ids.push(id);
    }
    replaceState(produce(state, (d) => {
        for (const id of ids) d.nodes[id].expanded = true;
    }));
    return ids.length;
}

// ---------------------------------------------------------------
// 3) 计时工具
// ---------------------------------------------------------------
const now = () => performance.now();
function median(xs) {
    const a = [...xs].sort((x, y) => x - y);
    return a.length ? a[Math.floor(a.length / 2)] : 0;
}
async function measure(label, fn, reps = 3) {
    const out = [];
    for (let i = 0; i < reps; i++) {
        const t0 = now();
        await fn();
        out.push(now() - t0);
    }
    return { label, ms: median(out), raw: out };
}

// ---------------------------------------------------------------
// 4) 跑各档
// ---------------------------------------------------------------
const SIZES = [2000, 5000, 20000];
const REP = 3;
const rows = [];

for (const N of SIZES) {
    const state = makeState(N);
    replaceState(state);
    AppState.currentTab = 'main';
    AppState.settings.display.treeDisplayMode = 'tree';       // 树形视图（默认）
    const expanded = expandSome(AppState, 40);

    // 目标：一个"有子节点、可折叠"的 S 节点（展开态）
    const target = Object.keys(AppState.nodes).find(id => AppState.nodes[id].type === 'S');

    // 预热：让持久化基线就位，并跑一次渲染（避免首次 JIT/容器懒建）
    try { await execute(d => { d.meta.warm = 1; }, { skipHistory: true, validate: false }); } catch (_) {}
    try { renderTree(); } catch (_) {}

    const phases = [];
    // ---- ① immer produce（只算改一个节点）----
    phases.push(await measure('① immer produce', () => {
        produce(AppState, d => { toggleNodeExpanded(d, target); });
    }, REP));

    // ---- ② 校验（getCurrentRenderedCount / validateExpandedLimit）----
    phases.push(await measure('② 校验(展开数)', () => {
        validateExpandedLimit(AppState, AppState.settings.performance.expandedNodeBlockLimit,
            AppState.settings.display.nodePerPage);
    }, REP));

    // ---- ③ 副页统计 refreshAllVirtualStats ----
    const pagesClone = JSON.parse(JSON.stringify(AppState.pages));
    phases.push(await measure('③ 副页统计', () => {
        const draft = { pages: JSON.parse(JSON.stringify(pagesClone)), nodes: AppState.nodes };
        refreshAllVirtualStats(draft);
    }, REP));

    // ---- ④ 重建 parentOf（applyState 每次都做）----
    phases.push(await measure('④ rebuildParentOf', () => { rebuildParentOf(AppState.childOrder); }, REP));

    // ---- ⑤ 持久化 diff（computeDiff 全表遍历）----
    const ref = () => ({
        nodes: AppState.nodes, childOrder: AppState.childOrder, pages: AppState.pages,
        settings: AppState.settings, meta: AppState.meta, sources: AppState.sources,
        trust: AppState.trust, accounts: AppState.accounts,
        currentAccountId: AppState.currentAccountId, viewingAccountId: AppState.viewingAccountId,
        currentPageId: AppState.currentPageId, currentTab: AppState.currentTab,
        rootId: AppState.rootId, infoState: {}
    });
    const beforeRef = ref();
    phases.push(await measure('⑤ 持久化 computeDiff', () => { computeDiff(beforeRef, ref()); }, REP));

    // ---- ⑥ 折叠缓存写入（collect + stringify + setItem）----
    phases.push(await measure('⑥ saveExpanded', () => { saveExpanded(AppState); }, REP));
    const bytes = (() => {
        LS.bytes = 0; saveExpanded(AppState); return LS.bytes;
    })();

    // ---- ⑦ 一次渲染 ----
    phases.push(await measure('⑦ 渲染 renderTree', () => { renderTree(); }, REP));

    // ---- ⑧ 端到端：走 G_events 里那条真路径（含 execute + saveData + 两次刷新）----
    let refreshCount = 0;
    const onRefresh = () => { refreshCount++; };
    if (!globalThis.__foldBenchHooked) {
        document.addEventListener(EVENTS.UI_REFRESH_REQUIRED, onRefresh);
        globalThis.__foldBenchHooked = true;
        globalThis.__foldBenchRefreshCount = () => refreshCount;
        globalThis.__foldBenchResetCount = () => { refreshCount = 0; };
    }
    globalThis.__foldBenchResetCount();
    // ⑧a：**修复前**的折叠路径（不跳副页统计 + onSuccess 再派发一次刷新 + 同步写缓存）
    const e2eOld = await measure('⑧a 折叠(修复前)', async () => {
        await execute(d => { toggleNodeExpanded(d, target); }, {
            validate: true, refreshParentId: null, skipHistory: true,
            onSuccess: () => {
                saveExpanded(AppState);
                document.dispatchEvent(new CustomEvent('expanded-count-updated'));
                document.dispatchEvent(new CustomEvent(EVENTS.UI_REFRESH_REQUIRED, { detail: { parentId: null } }));
            }
        });
    }, REP);
    const refreshOld = globalThis.__foldBenchRefreshCount() / REP;

    // ⑧b：**修复后**的折叠路径（跳副页统计 + 只由 execute 派发一次刷新 + 合并写缓存）
    globalThis.__foldBenchResetCount();
    const e2eNew = await measure('⑧b 折叠(修复后)', async () => {
        await execute(d => { toggleNodeExpanded(d, target); }, {
            validate: true, refreshParentId: null, skipHistory: true, skipVirtualStats: true,
            onSuccess: () => {
                scheduleExpandedSave(AppState);
                document.dispatchEvent(new CustomEvent('expanded-count-updated'));
            }
        });
    }, REP);
    const refreshNew = globalThis.__foldBenchRefreshCount() / REP;
    flushExpandedSave();
    phases.push(e2eOld, e2eNew);
    const refreshPerFold = `${refreshOld} → ${refreshNew}`;

    // ---- ⑨ saveData 全程（diff + IDB 写）----
    phases.push(await measure('⑨ saveData(含IDB)', async () => { await saveData(AppState); }, REP));

    // ---- ⑩ 事务固定开销（no-op 事务：applyState + saveData + 1 次刷新）----
    phases.push(await measure('⑩ no-op 事务总开销', async () => {
        await execute(() => {}, { skipHistory: true, validate: false, onSuccess: () => {} });
    }, REP));

    // ---- ⑪ updateInfoBar（统计全树：O(N) 遍历）----
    phases.push(await measure('⑪ updateInfoBar(O(N))', () => { updateInfoBar(AppState); }, REP));

    // ---- ⑫ 展开数（floaters 每次刷新都算）----
    phases.push(await measure('⑫ getCurrentRenderedCount', () => {
        getCurrentRenderedCount(AppState, AppState.settings.display.nodePerPage);
    }, REP));

    // ---- ⑬ 副页统计：**在 immer draft 里**跑（execute 的真实路径）----
    phases.push(await measure('⑬ 副页统计(immer内)', () => {
        produce(AppState, d => { refreshAllVirtualStats(d); });
    }, REP));

    // ---- ⑭ 空 produce（只付 immer 的固定开销）----
    phases.push(await measure('⑭ 空 produce', () => { produce(AppState, () => {}); }, REP));

    rows.push({
        N, expanded, visible: getCurrentRenderedCount(AppState, AppState.settings.display.nodePerPage),
        cacheBytes: bytes, refreshPerFold, phases
    });
}

// ---------------------------------------------------------------
// 5) 出表
// ---------------------------------------------------------------
const labels = rows[0].phases.map(p => p.label);
console.log('\n折叠耗时探针（中位数，毫秒；每档重复 ' + REP + ' 次）');
console.log('='.repeat(78));
console.log('阶段'.padEnd(24) + SIZES.map(n => String(n).padStart(12)).join(''));
console.log('-'.repeat(78));
for (const label of labels) {
    const cells = rows.map(r => {
        const p = r.phases.find(x => x.label === label);
        return (p ? p.ms.toFixed(2) : 'n/a').padStart(12);
    });
    console.log(label.padEnd(24) + cells.join(''));
}
console.log('-'.repeat(78));
console.log('（仅供参考）展开节点数'.padEnd(20) + rows.map(r => String(r.expanded).padStart(12)).join(''));
console.log('（仅供参考）可见渲染数'.padEnd(20) + rows.map(r => String(r.visible).padStart(12)).join(''));
console.log('（仅供参考）折叠缓存字节'.padEnd(20) + rows.map(r => String(r.cacheBytes).padStart(12)).join(''));
console.log('（仅供参考）每次折叠刷新次数'.padEnd(20) + rows.map(r => String(r.refreshPerFold).padStart(12)).join(''));
console.log('='.repeat(78));
console.log('注：DOM 是 smoke 桩（innerHTML 不解析）⇒ 渲染只含"遍历 + 拼字符串"；');
console.log('    真实浏览器还要加 HTML 解析/布局/绘制，那部分这里量不到。');

if (process.env.FOLD_TRACE) {
    const seen = globalThis.__foldTrace ? globalThis.__foldTrace() : [];
    console.log('\n每次折叠的 UI_REFRESH_REQUIRED 派发来源（共 ' + seen.length + ' 次）：');
    seen.slice(0, 8).forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
}
