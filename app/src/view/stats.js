// ================================================================
// 统计计算（view/stats.js）
// 职责：统计的格式化与缓存，计算逻辑下沉到 core/query/stats.js
// 依赖：core/query/nodes.js, core/query/stats.js
// 缓存策略：
//   - 全局统计缓存以 state.nodes 引用为键
//   - Immer 结构共享：数据未变则引用不变，缓存命中
//   - markStatsDirty 保留为手动强制失效接口
// ================================================================
import { getNode } from '../core/query/nodes.js';
// ★ 诊断/计时与"延迟烘热"共用的时间源（`utils/diag.js` 的 `nowMs` / `diag` / `diagOn`）
import { nowMs, diag, diagOn } from '../utils/diag.js';
// ★ 按页分槽的记忆表（副页统计 / 树 HTML / 计划栏共用一份实现）
import { createSlots } from '../utils/memoSlots.js';
// ★ 「屏蔽的支不参与统计」的**唯一判据**（`childVNodesOf` 就在模型层，纯函数）＋ 结构签名
import { childVNodesOf, structureSignatureOf } from '../core/model/page.js';
import {
    collectByType,
    collectCStats,
    collectPStats,
    cProblemNodes,
    formatProblemCounts,
    formatContestCounts,
    formatStatsText,
    problemUnitsOf,
    contestUnitsOf
} from '../core/query/stats.js';
import {
    newProblemBuckets, addProblem, newContestBuckets, addContest,
    S2_UNUSED, S2_TODO, S2_WA, S2_AFTER, S2_DURING, S2_IGNORE
} from '../core/model/status.js';
import { STATUS2_LABELS } from '../A_constants.js';
import { viewDerived, viewDerivedDisplay, scopeOpts } from './scope.js';
import { virtualContainerStats } from '../core/ops/virtualStats.js';
// ★ 烘热时顺带把"投影"也先建好（`view/dataAdapter.js` 的整页递归投影 ≈18–21ms/趟）
import { getDisplayData } from './dataAdapter.js';
// 合成节点（组头）：它的"子树"是**成员**（指针，不在 childOrder 里）
import { isSynthesis } from '../core/ops/synth.js';
// 计数模式（`settings.stats.countMode`）是**统计的一部分** ⇒ 必须进缓存键。
// 只改设置不改数据时 `state.nodes` 引用不变（Immer 结构共享），漏掉它就会
// "树上切了模式、统计栏还是旧数字"。
// ★「合并显示」：`dedupRepresentatives` 让**手搓的那些计数**（📊分布等）
//   也跟着判重模式走 —— 与 core 那边 `countMode` 的去重是同一个开关。
import { resolveCountMode, dedupRepresentatives } from '../core/query/countMode.js';
// C/P 计数的状态（"一代算一次" —— 见 `core/query/countCache.js`）
import { cache_countPassOf } from '../core/query/countCache.js';

// ---- re-export：保持 view 层对外 API 不变 ----
export { collectPStats, cProblemNodes };

/**
 * 派生字段取值器（**按当前查看范围**）。
 * 传给 `core/query/stats.js`，让统计读"按范围算出来"的 status2 / statusComplete2
 * 而不是缓存字段 —— 这就是"一队 3 人各自补题情况"能并存的原因。
 *
 * ⚠️ **永远读"自己那份"**（`viewDerived`），**不许**换成 `viewDerivedDisplay`：
 *    这是喂给**聚合**的输入，而聚合自己按 `countMode` 去重（`core/query/stats.js` 的
 *    `countModeOf`）。把"组那份"当输入喂进去＝把合并后的值再合并一次，还会被当输入
 *    重新喂回派生表（`core/derive.js` 文件头那条"震荡"警告）。
 *    显示侧该读哪一列，见 `view/scope.js` 的「合并显示」那一段。
 */
function derivedReader(state) {
    return (node, field) => viewDerived(state, node, field);
}

// ================================================================
// 单节点摘要：**每次渲染现算**（不做跨渲染缓存）
//
// 一行的摘要（`getWSMatchSummary` / `getWSProblemSummary` / `getCProblemSummary` /
//   `getCStatusDistribution`）要遍历**这一行自己的整棵子树** ⇒ 可见行一多，
//   总功 = Σ(每行子树) ≈ 节点数 × 深度。
// ⚠️ 这条要在**算法**上解决（渲染时一趟自底向上、每个节点只算一次），
//    **不要**在这里加"记住上一次结果"的缓存：那只会让重复渲染变快，最坏情况一点没动，
//    还要多养一套失效判据（判错就是静默算错数）。
// ================================================================

// ----- 全局统计缓存 -----
let cache = null;
// 上一次算出来的那串（**可能已经过期**）—— 给"先画旧数、过一拍再算准"用，见 `getGlobalStatsSoon`
let lastStats = null;

// ----- 手动强制失效（应急用） -----
export function markStatsDirty() {
    cache = null;
}

// ----- 节点总数（仅主树，从 rootId 递归） -----
export function getTotalNodeCount(state) {
    let count = 0;
    function walk(id) {
        count++;
        for (const cid of state.childOrder[id]) {
            walk(cid);
        }
    }
    if (state.rootId) walk(state.rootId);
    return count;
}

// ================================================================
// 计数的触发条件有若干个（树的渲染 / 统计栏 / 副页 / 启动第一屏），
// 但**计算只有一次全部算完** —— 就是 `core/query/countPass.js` 的那一趟：
//   · 谁先要数谁就跑这一趟（`cache_countPassOf` 按代闸门，一代只跑一次）；
//   · 本身值 + P 桶 + C 桶 + 📊分布 一次算齐；
//   · `plain` 与 `dedup` **都走它**（去重那套"组事件 3 步"在那一趟里，见 `countPass.js`）。
// ================================================================
function ensureAllCounts(state) {
    cache_countPassOf(state, countScopeOf(state));
}

/** 这一趟的范围/模式参数（进缓存键；口径一变就整片重算） */
function countScopeOf(state) {
    return { ...scopeOpts(state), mode: resolveCountMode(state && state.settings) };
}

/** plain/dedup 共用的那一趟（算过就复用） */
function countPassOf(state) {
    return cache_countPassOf(state, countScopeOf(state));
}

// ----- 副页（虚拟节点）：**所有**聚合都要按页内子树现算 -----
//   ⚠️ 副页节点的 id 是**页内 id**（`v_…`），主树那张计数表里没有它 ⇒ 凡"按 id 查表"的
//      一律查空、**静默全 0**。实测（同一个 C 子树、副页那张 W/S 卡片）：
//      · 摘要：主树 `00/01/01/01/02` vs 副页 `00/00/00/00/00`；
//      · 📊分布：主树 `未使用: 1 | 赛后补题: 1` vs 副页「无题目」；
//      · **C 计数**（W/S 卡片上那个 `C:…`）：主树有数、副页恒 `C:00/00/00/00/00`
//        （用户 2026-10-08 两轮分别报的："副页的 C/P 统计 + 分布"、"P 计数好了、C 计数还是不行"）。
//      逐节点的 status1/2 本来就是对的（那条走 `viewDerived`、认 `refId`）——
//      坏的只有**按 id 查表**的那几个；统计栏（`getVirtualGlobalStats`）也是对的。
//   ⇒ 判据只有这一份：**页内子树 → 引用的真实节点**，再交给与主树**同一个入口**
//      （P 侧 `problemUnitsOf`、C 侧 `contestUnitsOf`）。

/** 这是副页投影出来的节点吗（`view/dataAdapter.buildSyntheticNode` 会挂 `_virtual`） */
export function isVirtualNode(node) {
    return !!(node && node._virtual === true);
}

/**
 * 副页某个虚拟节点的**页内子树**：引用的真实 P 节点 + 页内现算的 C 条目。
 *
 * C 条目的 `value` 取 `virtualContainerStats`（**页面值**，不是节点上的字段 ——
 * 见 `core/query/stats.js` 的 `contestUnitsOf`）；`node` 是它引用的真实 C（没有 ⇒ null）。
 *
 * @param {Object} state
 * @param {Object} page
 * @param {string} vId - 子树根（页内 id）
 * @returns {{pRefs: Array<Object>, cEntries: Array<{node: Object|null, value: *}>}}
 */
function virtualSubtree(state, page, vId) {
    const index = (page && page.virtualIndex) || {};
    const pRefs = [];
    const cEntries = [];
    const walk = (vNode) => {
        if (!vNode) return;
        if (vNode.type === 'P') {
            // 这几条"数据完整性"检查原来就在统计栏那一趟里，**一条都不许丢**：
            // 引用坏了要当场说清楚是哪一条，而不是静默少算一道题。
            if (!vNode.refId) {
                throw new Error(`[副页统计] 虚拟 P 节点 "${vNode.id}" 的 refId 为空`);
            }
            const real = getNode(state, vNode.refId);
            if (!real) {
                throw new Error(
                    `[副页统计] 虚拟 P 节点 "${vNode.id}" 引用的真实节点 "${vNode.refId}" 不存在，` +
                    `请检查副页 "${page.name}" (${page.id}) 的数据完整性`
                );
            }
            if (real.status1 === undefined) {
                throw new Error(
                    `[副页统计] 真实 P 节点 "${real.id}" (${real.name || '未命名'}) 的 status1 字段缺失`
                );
            }
            if (real.status2 === undefined) {
                throw new Error(
                    `[副页统计] 真实 P 节点 "${real.id}" (${real.name || '未命名'}) 的 status2 字段缺失`
                );
            }
            pRefs.push(real);
            return;
        }
        if (vNode.type === 'C') {
            const st = virtualContainerStats(page, vNode.id, {
                nodes: state.nodes,
                derived: (n, f) => viewDerived(state, n, f),
                settings: state.settings
            });
            cEntries.push({
                node: vNode.refId ? getNode(state, vNode.refId) : null,
                value: st ? st.statusComplete2 : 0
            });
        }
        for (const child of childVNodesOf(page, vNode, 'stats')) walk(child);
    };
    walk(index[vId]);
    return { pRefs, cEntries };
}

/** 副页某个虚拟节点子树里引用的**真实 P 节点**（按页内顺序；P 的子树是提交记录 ⇒ 到它为止） */
export function virtualProblemNodes(state, node) {
    const page = state && state.pages && state.pages[node && node._pageId];
    if (!page) return [];
    return virtualSubtree(state, page, node._virtualId).pRefs;
}

/** 副页某个虚拟节点子树里的 **C 条目**（`{node, value}`；`contestUnitsOf` 要的形状） */
export function virtualContestEntries(state, node) {
    const page = state && state.pages && state.pages[node && node._pageId];
    if (!page) return [];
    return virtualSubtree(state, page, node._virtualId).cEntries;
}

/** 一批 C 条目 → C 计数桶（`contestUnitsOf` 收组，与主树 `collectCStats` 同一份规则） */
function bucketsOfContestEntries(state, entries) {
    const b = newContestBuckets();
    for (const u of contestUnitsOf(state, entries)) addContest(b, u.value);
    return b;
}

// ----- C 节点题目统计摘要 -----
/**
 * 这个 C 的 `过/过+补/处理/处理+忽略/总` 摘要。
 *
 * ⚠️ 普通 C ⇒ 与原来逐字相同（`collectPStats` 按子树汇总）。
 * **合成节点**（组头）⇒ 题目在**成员**那边（成员是指针、不是子节点，
 * 见 `core/query/stats.js` 的 `cProblemNodes`）—— 不补这一步组头永远是 0 题。
 */
/** 一个节点的 P 计数桶（副页走页内子树；合成节点走并集那条；其余按模式走"这一趟"或逐格老路） */
function computeProblemBuckets(state, node) {
    // 副页：页内 id 不在主树那张表里 ⇒ 按页内子树引用的真实 P 现算
    if (isVirtualNode(node)) return bucketsOfRealProblems(state, virtualProblemNodes(state, node));
    if (!isSynthesis(node)) return collectPStats(state, node.id, derivedReader(state));
    return bucketsOfRealProblems(state, cProblemNodes(state, node));
}

/** 一批**真实 P 节点** → P 计数桶（先收齐再统一分档：`dedup` 要按组收敛，边加边算会漏成员） */
function bucketsOfRealProblems(state, pNodes) {
    const b = newProblemBuckets();
    for (const u of problemUnitsOf(state, pNodes, derivedReader(state))) {
        addProblem(b, u.status1, u.status2);
    }
    return b;
}

/**
 * 取一个节点的 P 桶。
 * · **副页**（虚拟节点）：页内子树现算（页内 id 不在主树那张表里）；
 * · 合成节点：子树是"自己 ∪ 成员"（多个区间的纯并集）⇒ 仍走并集那条（一趟折不了它）；
 * · 其余：读那一趟（`plain` 与 `dedup` 共用；📊分布与这里**同一口径** —— 用户 2026-10-07 定：
 *   组头在"子树内有 P 原料"时都不计）。
 *
 * ⚠️ **"主树 / 副页"的分叉只在这几处**（`problemBucketOf` / `contestBucketOf` /
 *    `getCStatusDistribution`），而且分叉的**只有"子树从哪来"**：
 *    主树 = 那张按 id 建好的计数表（O(1) 查），副页 = `virtualSubtree` 现走一遍页内树。
 *    **档位规则一份都不重写** —— P 侧一律 `problemUnitsOf`、C 侧一律 `contestUnitsOf`
 *    （与主树 `collectPStats` / `collectCStats` 完全相同的那两个入口）。
 *    加新的聚合时照这个形状写；别只看主树（上一版就是这么漏掉 C 计数的：
 *    用户 2026-10-08 "P 计数好了、C 计数还是不行"）。
 */
function problemBucketOf(state, node) {
    if (isVirtualNode(node) || isSynthesis(node)) return computeProblemBuckets(state, node);
    return countPassOf(state).problemOf(node.id);
}

/** 取一个节点的 C 桶（主树读那一趟；**副页按页内子树现算**） */
function contestBucketOf(state, node) {
    if (isVirtualNode(node)) return bucketsOfContestEntries(state, virtualContestEntries(state, node));
    return countPassOf(state).contestOf(node.id);
}

/** 📊分布那六个计数 → 那一串 */
function formatDistribution(counts) {
    const parts = [];
    for (let i = 0; i < counts.length; i++) {
        if (counts[i] > 0) parts.push(`${STATUS2_LABELS[i]}: ${counts[i]}`);
    }
    return parts.length ? parts.join(' | ') : '无题目';
}

export function getCProblemSummary(state, node) {
    if (!node) return formatProblemCounts(newProblemBuckets());
    // ★ 副页：走缓存（同一 vNode 同一代只算一次；没烘热就现算并存住 —— 见上面那段注释）
    if (isVirtualNode(node)) return virtualBucketText(state, node, 'p');
    return formatProblemCounts(problemBucketOf(state, node));
}

// ================================================================
// 副页容器行（C / W / S）那几串数字：**按 vNode 缓存 + 延迟烘热**
//
// 病根（2026-10-18 实测）：副页的每一行 C/W/S 都要显示 `C:…`（它的子树里有几场）
// 和 `P:…`（有几题几过）—— 原来**每次渲染都现算自己那棵子树**（`contestBucketOf` /
// `problemBucketOf` → `virtualContestEntries` / `virtualProblemNodes` → 再逐题判档）。
// 用户那页实测 **36ms/行、10 行 360ms**，而主树同样两串走 `countPassOf`（一趟算好、
// 按数据代缓存）—— 副页缺的正是"算一次存起来"这一步。
//
// 口径**一个字没改**：还是 `contestBucketOf` / `problemBucketOf` / `problemUnitsOf`，
// 只是把结果按 `(page 对象, 数据代, vNode)` 存住。
// 什么时候算（用户 2026-10-18："在启动/刷新时就计算，跟主页一样，但可以延迟"）：
//   · 行渲染时 **命中就直接用**（0ms）；没命中就现算并存住（兜底，保证任何时候都对）；
//   · `scheduleVirtualWarmup()` 在**刷新/切页/数据变动之后**排一次：按 `WARM_BUDGET_MS`
//     一片切片把各页容器行的桶算好（不阻塞首屏与交互），这样**切进副页时已经是热的**。
// ================================================================
/** 烘热时每片最多占用多少毫秒（宁可多切几片，也别在交互时卡一下） */
const WARM_BUDGET_MS = 8;
/** page → `{ refs…, c: Map, p: Map, dist: Map }`（每页一格、页没了自动回收，同 `memoSlots`） */
const virtualBucketSlots = createSlots();
let warmTimer = null;
let warmQueue = null;

const warmRefsOf = (state, page) => ({
    state, page,
    nodes: state.nodes, sig: structureSignatureOf(page),
    settings: state.settings,
    accounts: state.accounts, trust: state.trust,
    fieldRegistry: state.fieldRegistry,
    viewingAccountId: state.viewingAccountId, currentAccountId: state.currentAccountId
});

let BOX_SEQ = 0;
/** 这一页这一代的桶缓存（**键 = 页 id**：折叠不会变；引用变了就换一份空的） */
function virtualBucketsOf(state, page) {
    if (!page || !page.virtualIndex) return null;
    // 顺手回收"已经不存在的页"那些格（≤ 页数，几十个键；见 `memoSlots` 文件头 ③④）
    if (state && state.pages) virtualBucketSlots.prune(Object.keys(state.pages));
    const refs = warmRefsOf(state, page);
    const hit = virtualBucketSlots.get(page.id);
    let diff = null;
    if (hit) {
        // 诊断（2026-10-18）：缓存**命不中**时到底是谁变了 —— 不打出来就只能猜。
        diff = [];
        if (hit.nodes !== refs.nodes) diff.push('nodes');
        if (hit.sig !== refs.sig) diff.push('结构签名');
        if (hit.settings !== refs.settings) diff.push('settings');
        if (hit.accounts !== refs.accounts) diff.push('accounts');
        if (hit.trust !== refs.trust) diff.push('trust');
        if (hit.fieldRegistry !== refs.fieldRegistry) diff.push('fieldRegistry');
        if (hit.viewingAccountId !== refs.viewingAccountId) diff.push('viewingAccountId');
        if (hit.currentAccountId !== refs.currentAccountId) diff.push('currentAccountId');
        if (!diff.length) return hit;
    }
    const fresh = { ...refs, boxId: ++BOX_SEQ, c: new Map(), p: new Map(), dist: new Map(), warmed: false };
    virtualBucketSlots.set(page.id, fresh);
    // 诊断：这一份是"第一次"还是"换了一份"、旧的还剩几条
    diag('烘热', hit
        ? `页 ${page.id} 桶缓存换代 #${fresh.boxId}（变了：${diff.join(' / ')}）— 旧 #${hit.boxId} c ${hit.c.size} / p ${hit.p.size}`
        : `页 ${page.id} 新建桶缓存 #${fresh.boxId}（这一页还没有）`);
    return fresh;
}

/** 一个 vNode 的某一串（`'c'` / `'p'` / `'dist'`）：有缓存就用，没有就现算并存住 */
const VB_STATS = { hit: 0, miss: 0, ms: 0 };
export function resetVirtualBucketStats() { VB_STATS.hit = 0; VB_STATS.miss = 0; VB_STATS.ms = 0; }
export function virtualBucketStats() { return { ...VB_STATS }; }

export function virtualBucketText(state, node, kind) {
    const page = state && state.pages && state.pages[node && node._pageId];
    const box = virtualBucketsOf(state, page);
    // 诊断：**拿不到页 ⇒ 永远算、永远存不进去**（2026-10-18 真踩到：烘热那趟传的是 `virtualIndex`
    //   里的**原始** vNode，没有 `_pageId` / `_virtualId` ⇒ 算了 3 条全丢掉，渲染时当然是 0 命中）。
    if (!box) {
        diag('烘热', `取不到页（_pageId=${String(node && node._pageId)}）`
            + ' —— 这一条只算不存，命中率会一直是 0');
    }
    const cached = box ? box[kind].get(node._virtualId) : undefined;
    if (cached !== undefined) { VB_STATS.hit++; return cached; }
    const t = nowMs();
    const text = computeVirtualBucketText(state, node, kind);
    VB_STATS.ms += nowMs() - t;
    VB_STATS.miss++;
    if (box) box[kind].set(node._virtualId, text);
    return text;
}

/** 真算（**唯一一份**口径：与主树/统计栏同一批函数） */
function computeVirtualBucketText(state, node, kind) {
    if (kind === 'c') return formatContestCounts(contestBucketOf(state, node));
    if (kind === 'p') return formatProblemCounts(problemBucketOf(state, node));
    return formatDistribution(distributionOfUnits(
        problemUnitsOf(state, virtualProblemNodes(state, node), derivedReader(state))));
}

/**
 * 排一次"烘热"：把各页**容器行**（C/W/S）的三串先算好。
 * ⚠️ 幂等：同一页同一代已经烘过就跳过；算过的条目走缓存。
 */
export function scheduleVirtualWarmup(state) {
    // 诊断（2026-10-18）：这几条就是为了回答"烘热到底有没有跑"——用户实测 `桶缓存 0命中`，
    //   而 `[烘热]` 一条都没打 ⇒ 得先看是"没排队"还是"排了没跑"。纯日志，判完可删。
    if (!state || !state.pages) { diag('烘热', '跳过：没有 state.pages'); return; }
    if (warmTimer) { diag('烘热', '跳过：已经排过一次（等它跑完）'); return; }
    const pages = Object.keys(state.pages).map((id) => state.pages[id]).filter((p) => p && p.virtualIndex);
    if (!pages.length) { diag('烘热', '跳过：没有带 virtualIndex 的副页'); return; }
    diag('烘热', `排队：${pages.length} 个副页`);
    warmQueue = { state, pages, i: 0, ids: null, j: 0 };
    warmTimer = setTimeout(warmSlice, 0);
}

/** 一片：只处理容器 vNode，`WARM_BUDGET_MS` 到点就让出主线程 */
function warmSlice() {
    warmTimer = null;
    const q = warmQueue;
    if (!q) return;
    diag('烘热', `开跑：第 ${q.i + 1}/${q.pages.length} 页`);
    const t0 = nowMs();
    const deadline = t0 + WARM_BUDGET_MS;
    while (q.i < q.pages.length) {
        const page = q.pages[q.i];
        if (!q.ids) {
            const box = virtualBucketsOf(q.state, page);
            if (!box || box.warmed) {
                diag('烘热', `页 ${page.id} 已经烘过 #${box ? box.boxId : '?'}`
                    + `（c ${box ? box.c.size : 0} / p ${box ? box.p.size : 0}`
                    + ` / dist ${box ? box.dist.size : 0} 条）`);
                q.i++; q.ids = null; q.j = 0; continue;
            }
            const all = Object.keys(page.virtualIndex);      // 只用来数个数/打诊断，不建数组
            // ⚠️ 容器类型**不一定写在 vNode 上**（投影出来的那些可能只带 `refId`）⇒ 取不到就回真实节点问。
            const state = q.state;
            const typeOf = (v) => {
                if (!v) return '';
                if (v.type) return v.type;
                const real = v.refId ? (state.nodes || {})[v.refId] : null;
                return (real && real.type) || '';
            };
            // ★ **整棵树都烘**（用户 2026-10-18："烘热不该是烘热整棵树吗"）：凡是容器 vNode 都先算好，
            //   这样**展开任何一层**都不用现算（折叠/展开也不再作废 —— 键换成了"结构签名"，见上面）。
            //   代价：真包那页 320 个容器 × 3 串 ≈ 960 次子树扫描，按 8ms 一片在后台跑完（不占交互）。
            q.ids = all.map((vid) => page.virtualIndex[vid]).filter((v) => {
                const t = typeOf(v);
                return t === 'C' || t === 'W' || t === 'S';
            });
            q.j = 0;
            if (!q.ids.length) {
                // ⚠️ **这里不许 `warmed = true`**（2026-10-18 实测踩到）：启动那一刻 `virtualIndex`
                //   还是空的（数据刚从 IndexedDB 落进来 / 还没物化），若这里就把"这一页烘过了"记下，
                //   之后再也不会有人烘它 —— 用户看到的正是 `[烘热] 页 … 已经烘过` + `0命中`。
                //   ⇒ 只跳过这一趟，不记状态；下一趟（数据到位后）自然会算。
                //   ⚠️ 诊断串**只在开关打开时才拼**（这行会被每趟刷新走到；别为一条日志扫 3000 个键）。
                if (diagOn()) {
                    const tally = {};
                    for (const vid of all) {
                        const v = page.virtualIndex[vid];
                        const t = String(v && v.type);
                        tally[t] = (tally[t] || 0) + 1;
                    }
                    diag('烘热', `页 ${page.id}：virtualIndex ${all.length} 个，**没有**容器行`
                        + `（类型分布 ${JSON.stringify(tally)}）—— 不记"已烘"，下次再试`);
                }
                q.i++; q.ids = null; q.j = 0; continue;
            }
            diag('烘热', `页 ${page.id}：${q.ids.length} 个容器行要算（全页 ${all.length} 个 vNode）`);
        }
        while (q.j < q.ids.length) {
            const raw = q.ids[q.j++];
            // ⚠️ **必须补上投影那三个字段**（2026-10-18 踩到）：`virtualIndex` 里存的是**原始** vNode
            //   （只有 `id`/`refId`/`type`/`children`），而 `virtualBucketText` 靠 `_pageId` 找页、
            //   靠 `_virtualId` 当缓存键 —— 少这两个就直接算完丢掉、命中率永远是 0。
            const vNode = { ...raw, _virtual: true, _virtualId: raw.id, _refId: raw.refId, _pageId: page.id };
            // 现算并存住（走的还是同一个 `virtualBucketText`）。
            // ⚠️ 后台任务**不许**把主流程炸掉：任何一条算不出来就跳过它（行渲染那边还有现算兜底）。
            try {
                virtualBucketText(q.state, vNode, 'c');
                virtualBucketText(q.state, vNode, 'p');
                virtualBucketText(q.state, vNode, 'dist');
            } catch { /* 单条失败不影响其余 */ }
            if (nowMs() >= deadline) { warmTimer = setTimeout(warmSlice, 0); return; }
        }
        const box = virtualBucketsOf(q.state, page);
        if (box) box.warmed = true;
        // 顺带把这一页的**总览统计**也烘一下（`getVirtualGlobalStats` 冷算实测 38–48ms，
        //   切页那一帧不该付）；它自己带按页记忆化，命中即 0ms。
        try { getVirtualGlobalStats(q.state, page); } catch { /* 后台任务不许炸主流程 */ }
        // 还有**投影**（`view/dataAdapter.js` 把整页 vNode 递归建成投影对象，真包 5344 个 ≈18–21ms/趟）：
        //   它按"页 id + 结构签名"缓存，先烘好 ⇒ 第一次切进副页也不用现建。
        try {
            const data = getDisplayData(q.state, { mode: 'tree', pageId: page.id });
            // ★ 再顺手烘**首屏那几行**的"容器状态"（那两格色条走 `virtualContainerStats`，
            //   要扫一遍子树，实测 7ms/行）。只烘第一屏（页根的直接孩子），别整页扫。
            const top = (data && data.type === 'tree' && data.root && data.root.children) || [];
            for (const row of top) {
                if (row.type !== 'C' && row.type !== 'W' && row.type !== 'S') continue;
                viewDerivedDisplay(q.state, row, 'statusComplete1');
                viewDerivedDisplay(q.state, row, 'statusComplete2');
            }
        } catch { /* 同上 */ }
        diag('烘热', `页 ${page.id} 烘好了（本片 ${Math.round(nowMs() - t0)}ms）`);
        q.i++; q.ids = null; q.j = 0;
    }
    warmQueue = null;
}

// ----- C 节点状态分布 -----
/**
 * 📊分布：**跟 P 桶同一条口径**（用户 2026-10-07 定），组划分统一到 `collectGroups`
 * （同日第二次定：不按"原始组键"另算一套）：
 *   · `plain`：子树里"该计一次的 P"各按 `status2` 记一格；
 *   · `dedup` ：**每组一次**、档位取**组那份**的 `status2`。
 * 两者都在那一趟的 `cntRule` 里（`c0..c5` 就是这个分布）。
 * ⚠️ 合成节点仍走并集那条（子树是"自己 ∪ 成员"，一趟折不了）。
 */
export function getCStatusDistribution(state, node) {
    if (!node) return formatDistribution([0, 0, 0, 0, 0, 0]);
    // ★ 副页：同一条 `problemUnitsOf`（与统计栏、P 桶同一份口径）—— 走缓存，别每行现算
    if (isVirtualNode(node)) return virtualBucketText(state, node, 'dist');
    if (isSynthesis(node)) return computeCStatusDistribution(state, node);
    return formatDistribution(countPassOf(state).distOf(node.id));
}

/** 那六个合法档位（判据从 `core/model/status.js` 派生，别处不再手抄） */
const VALID_STATUS2 = new Set([S2_UNUSED, S2_TODO, S2_WA, S2_AFTER, S2_DURING, S2_IGNORE]);

/** `{status2}` 列表 → 六个计数（📊分布；合成节点与副页共用这一份） */
function distributionOfUnits(units) {
    const counts = [0, 0, 0, 0, 0, 0];
    for (const u of units) {
        if (VALID_STATUS2.has(u.status2)) counts[u.status2]++;
    }
    return counts;
}

/** `getCStatusDistribution` 的真算 */
function computeCStatusDistribution(state, node) {
    const counts = [0, 0, 0, 0, 0, 0];
    // ★「合并显示」：判重模式下 ① 状态读「组那份」；② **每组只算一次**
    //   （同一道题的多个来源副本不该在「📊分布」里各占一格）。
    //   `plain` ⇒ 两条都是原行为（原数组 + 自己那份），逐字不变。
    // ⚠️ 合成节点（组头）的题目在**成员**那边（成员是指针、不是子节点）⇒ 走 `cProblemNodes`；
    //    普通 C 与原来逐字相同（还是它自己的子树）。
    const pNodes = dedupRepresentatives(state,
        isSynthesis(node) ? cProblemNodes(state, node) : collectByType(state, node.id, 'P'));
    // 用**合法值名单**判断，而不是 `s >= 0 && s <= 5` —— 后者会放 `2.5` 这类小数
    // 进来（`counts[2.5]++` 会往数组上挂一个多余属性），也与 `core/model/status.js` 的
    // `addProblem`（严格 `===`）口径不一致。名单从那边派生（模块级那一份，副页也用它）。
    for (const p of pNodes) {
        const s = viewDerivedDisplay(state, p, 'status2');
        if (VALID_STATUS2.has(s)) counts[s]++;
    }
    const parts = [];
    for (let i = 0; i < counts.length; i++) {
        if (counts[i] > 0) {
            parts.push(`${STATUS2_LABELS[i]}: ${counts[i]}`);
        }
    }
    return parts.length ? parts.join(' | ') : '无题目';
}

// ----- W/S 节点比赛统计摘要 -----
export function getWSMatchSummary(state, node) {
    if (isVirtualNode(node)) return `C:${virtualBucketText(state, node, 'c')}`;
    return `C:${formatContestCounts(contestBucketOf(state, node))}`;
}

// ----- W/S 节点题目统计摘要 -----
export function getWSProblemSummary(state, node) {
    if (isVirtualNode(node)) return `P:${virtualBucketText(state, node, 'p')}`;
    return `P:${formatProblemCounts(problemBucketOf(state, node))}`;
}

// ----- 全局统计（带缓存，计算下沉到 core） -----
/** 缓存键：范围 + 三个引用（`nodes`/`accounts`/`trust`）+ 计数模式 */
function statKeyOf(state) {
    return {
        rootId: state.rootId,
        nodesRef: state.nodes,
        accountsRef: state.accounts,
        trustRef: state.trust,
        scopeKey: `${state.viewingAccountId || ''}`,
        countMode: resolveCountMode(state.settings)
    };
}

/** 缓存还新鲜吗（逐字段比键） */
function statKeyFresh(state, k) {
    return !!cache
        && cache.rootId === k.rootId
        && cache.nodesRef === k.nodesRef
        && cache.accountsRef === k.accountsRef
        && cache.trustRef === k.trustRef
        && cache.scopeKey === k.scopeKey
        && cache.countMode === k.countMode;
}

/**
 * 算一遍并入缓存。
 * ★ 统计栏那两串数就是**根那一格**（整个树的 P/C 桶）—— 不再单跑一遍全表扫：
 *   plain 下它已经在那一趟里算好了（`countPassOf`），这里只是读出来。
 */
function statCompute(state, key) {
    ensureAllCounts(state);
    const rootNode = (state.nodes && state.rootId) ? state.nodes[state.rootId] : null;
    const stats = formatStatsText(problemBucketOf(state, rootNode), contestBucketOf(state, rootNode));
    lastStats = stats;
    cache = { stats, ...key };
    return stats;
}

export function getGlobalStats(state) {
    const key = statKeyOf(state);
    if (statKeyFresh(state, key)) return cache.stats;
    return statCompute(state, key);
}

/**
 * **真算一次**全局统计（跳过错/缓存判断），只给诊断用：`scripts/perf-bench.mjs` 要量
 * "算一次到底多少钱"——`getGlobalStats` 走的是延迟墙（先给上一次那串），量不到计算量。
 * ⚠️ 应用代码**别调它**：正常路径一律 `getGlobalStats` / `getGlobalStatsSoon`。
 */
export function computeGlobalStats(state) {
    return statCompute(state, statKeyOf(state));
}

// ================================================================
// **延迟一拍**的全局统计
//
// 病根（当时）：`computeGlobalStats` 要整表扫好几趟（真包 2.7 万节点、含合成节点时实测 ~100ms），
//   而**每次事务都会换掉 `state.nodes` 的引用** ⇒ 缓存每次都命中不了，每个操作都躲不掉这一笔
//   （CPU 采样：一次"点已处理" ~285ms 里它占 ~150ms）。
//
// ⚠️ 这一笔**现在已经没有了**：统计栏那两串数 = **根那一格**（`statCompute` 读那一趟的结果），
//    不再单跑一遍全表扫。这套"延迟一拍"于是只剩姿态价值（连点只算一次、只刷两串数字），
//    行为与判据保持不变（`src/test/perfGuards.test.js` 的 ⑨ 仍看着它）。
//
// 药：它**不是交互反馈** —— 树、节点摘要都已经画出来了，统计栏就那两串数。于是与
//   `SIZE_DEFER_MS`（存储体积）、判重页的 `scheduleDedupRefresh` 同一姿态：
//   **先把上一次那串画上，过一拍再算准、只把那两串数字刷掉**。
//   · 连点：定时器只有一个 ⇒ 中间那些"算了一半又过期"的重算直接省掉，最后落地的就是最新那份；
//   · 从没算过（启动第一屏）：没有"上一次"可画 ⇒ 只能同步算一次，与体积那条同一个处理。
//
// @param {Object} state
// @param {(stats:{cStr:string,pStr:string}) => void} [paint] 算准之后的回调（只刷数字，别重画整块）
// @returns {{cStr:string,pStr:string}} 立即可用的那份（可能旧一拍）
// ================================================================
// 一拍 = 200ms：够"这一下已经画完、用户还在看结果"，又短到看不出数字在变。
// 连点两次（间隔 < 200ms）只会算一次 —— 定时器只有一个，落在最后那份 state 上。
const STATS_DEFER_MS = 200;
let statsTimer = null;
let statsPending = [];      // [{ state, paint }]：同一个窗口里的多次请求只算一次、只刷一遍

function statsFlush() {
    statsTimer = null;
    const pending = statsPending;
    statsPending = [];
    if (!pending.length) return;
    // 到点再读一次 state：AppState 是**稳定的容器**（引用不变、字段被事务替换），
    // 所以这里拿到的就是**最新**那份 —— 连点时中间那些过期请求自然被合掉。
    let stats = null;
    try {
        stats = getGlobalStats(pending[pending.length - 1].state);
    } catch (err) {
        // ⚠️ 算挂了**不许**变成"定时器里没人接的异常"（事务早就提交了，没有可回滚的东西）：
        //    留一条 warn + 继续显示旧数字。为什么是 warn 而不是往上抛：抛出去谁也接不住，
        //    只会把这一拍变成控制台里一个赤条条的报错；而"统计栏没刷新"是能看出来的。
        console.warn('[统计栏] 这一拍算不出来，先保留旧数字：', err);
        return;
    }
    for (const { paint } of pending) {
        try { paint(stats); } catch (_) { /* 只是刷两串数字，失败不该炸 */ }
    }
}

//: 还没算过时先画这个（**占位**，不是 0）—— 现在**没有**人返回它（首屏那条已定口径要求真数字），
//: 留着是因为"过一拍再算准"那条路上，"上一次"理论上可能为空 ⇒ 有它在就不会画出 `undefined`。
const STATS_PLACEHOLDER = { cStr: 'C:…', pStr: 'P:…' };

export function getGlobalStatsSoon(state, paint) {
    const key = statKeyOf(state);
    if (statKeyFresh(state, key)) return cache.stats;      // 数据没动 ⇒ 直接用，也不必排重算
    // ⚠️ **启动第一屏仍要同步算一次**（2026-10-18 试过改成占位，被 `stats-defer.smoke.mjs` 打回：
    //   "★ 启动第一屏：等不了 ⇒ 直接给**算准的**那串（不是空白占位）"）⇒ 这条是**已定口径**，别动。
    //   它确实贵（真包实测 ~194ms 探针机 / ~300ms 浏览器），但"首屏数字必须是真的"优先。
    if (!lastStats) return statCompute(state, key);        // 第一拍：没有旧数可画，只能同步算
    if (typeof paint === 'function') statsPending.push({ state, paint });
    if (!statsTimer) statsTimer = setTimeout(statsFlush, STATS_DEFER_MS);
    return lastStats;
}

// ----- 副页虚拟树总览统计 -----
/**
 * 副页那条统计栏（`C:…` / `P:…`）。
 *
 * ★ 计数模式（`settings.stats.countMode`）在这里也生效，与主树**同一份口径**：
 *   `dedup` ⇒ 同一个合成组**只算一次**、档位取那一组的「组那份」——
 *   P 侧走 `problemUnitsOf()`、C 侧走 `contestUnitsOf()`（都在 `core/query/stats.js`，
 *   与主树 `collectPStats` / `collectCStats` 共用同一套组规则）。
 *   `plain` ⇒ 逐节点，与老行为逐字相同。
 *
 * ⚠️ 遍历**只有一份**（`virtualSubtree`）：页内那一趟也是"整页 = 从根走一遍"，
 *    与卡片上那几个聚合（P 桶 / C 桶 / 📊分布）**同一份子树收集器** ——
 *    以前这里内联了一份 walk，于是"漏改一处"就成了常态。
 */
//: 副页总览统计的**每页独立槽记忆化**（2026-10-18）：副页 3000+ vNode 实测一次 ~39ms，切回副页时数据往往没变 ⇒ 0ms。
//: ★ **键 = 页 id + 结构签名**（不再用页对象/`virtualIndex` 引用）：
//:   用户 2026-10-18："副页折叠现在慢啊" —— `expanded` 存在 vNode 上，折一下就换一个页对象/一张
//:   `virtualIndex`，按引用当键会把这份记忆化**每折一次全作废**。结构签名只看"有哪些 vNode、
//:   各自引谁、孩子是谁、屏蔽没屏蔽"，折叠不动它 ⇒ 折叠时照旧命中。
//: ⚠️ 键**漏一项 = 静默错数**（本仓踩过两次）：改了会影响显示口径的东西就得在这里加一项。
const virtualStatsSlots = createSlots();

export function getVirtualGlobalStats(state, page) {
    if (!page || !page.virtualIndex || Object.keys(page.virtualIndex).length === 0) {
        return formatStatsText(newProblemBuckets(), newContestBuckets());
    }
    if (state && state.pages) virtualStatsSlots.prune(Object.keys(state.pages));
    const sig = structureSignatureOf(page);
    const hit = virtualStatsSlots.get(page.id);
    if (hit && hit.state === state && hit.nodes === state.nodes
        && hit.childOrder === state.childOrder && hit.sig === sig
        && hit.accounts === state.accounts && hit.trust === state.trust
        && hit.fieldRegistry === state.fieldRegistry
        && hit.settings === state.settings
        && hit.viewingAccountId === state.viewingAccountId
        && hit.currentAccountId === state.currentAccountId) {
        return hit.stats;
    }
    // （`page.vNodeStats` 是登录口径的物化结果，不再参与显示 —— 一律按当前查看范围现算）
    const { pRefs, cEntries } = virtualSubtree(state, page, page.rootId);
    const stats = formatStatsText(bucketsOfRealProblems(state, pRefs), bucketsOfContestEntries(state, cEntries));
    virtualStatsSlots.set(page.id, {
        state, nodes: state.nodes, childOrder: state.childOrder, sig,
        accounts: state.accounts, trust: state.trust, fieldRegistry: state.fieldRegistry,
        settings: state.settings,
        viewingAccountId: state.viewingAccountId, currentAccountId: state.currentAccountId,
        stats
    });
    return stats;
}

// ----- 更新副页总览统计（DOM 操作） -----
export function updateVirtualGlobalStats(state, page, targetSelector = '#tree-stats') {
    const stats = getVirtualGlobalStats(state, page);
    const target = document.querySelector(targetSelector);
    if (target) {
        target.innerHTML = `<span>${stats.cStr}</span><span>${stats.pStr}</span>`;
        target.style.display = 'block';
    }
}
