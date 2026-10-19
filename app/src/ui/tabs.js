// ================================================================
// 分页切换逻辑（ui/tabs.js）
// 职责：一级 Tab 栏的渲染、切换、插件页挂载
// 依赖：shell/state.js, shell/executor.js, A_constants.js,
//       core/pluginRegistry.js, ui/tabRegistry.js
//
// 设计约定：
//   - 内置 Tab 的**唯一真源是 index.html 的静态按钮**，本模块启动时读取；
//     因此新增内置页只需改 HTML，不必同步改动 JS 常量。
//   - 插件 Tab 通过 api.registerTab 注册，按钮与内容容器都在运行时生成。
//   - 插件页内容容器为 `#tab-<id>`，与内置页同级、同为 .tab-content，
//     沿用既有 CSS（非 .active 即隐藏）。
//   - 内置页的内容仍由各自既有逻辑渲染（统计图、AC 追踪等），
//     本模块只在切到插件页时负责挂载。
// ================================================================
import { AppState } from '../shell/state.js';
import { execute } from '../shell/executor.js';
import { EVENTS } from '../A_constants.js';
import { getPluginTabs } from '../core/pluginRegistry.js';
import { realNodeIdOf } from '../core/ops/page.js';
// ★ 诊断日志的唯一开关（`localStorage.DSH_DIAG = '1'` + 刷新；见 `utils/diag.js` 文件头）
import { diag, nowMs, msSince } from '../utils/diag.js';
import { renderNodeInfoPanel, forgetNodeView } from './nodeinfo/nodeInfoView.js';
// ★ 内层计划页（设计稿 `docs/training-plan.md` ⑭）：**同一个"第三类 tab"机制**的第二种口味
//   —— 与节点详页同样自带一条栏、可同时开多个、内容按需画。
import { renderPlanPanel, planTabId } from './plan/planPage.js';
// 悬停提示也是给人看的字 ⇒ 统一去 Markdown 记号（实现只有一份）
import { plain } from '../utils/text.js';
import { renderDedupPage, invalidateDedupCache } from './dedup/dedupPage.js';
import { renderSettingsPage, isSettingsDirty, SETTINGS_TAB_ID } from './settings/settingsPage.js';
import { renderCoveragePage, COVERAGE_TAB_ID } from './coverage/coveragePage.js';
// ★ 注入给插件的那份"节点入口条"（`mountPluginTab` 的 `ctx.nodeEntry`）——
//   插件自己不许 import `ui/`，所以由宿主把**这唯一一份**传进去（见那里的说明）
import { nodeEntryLine } from './kit/nodeEntry.js';
import {
    resolveTabs,
    pickTab,
    isKnownTabId,
    tabContentId,
    DEFAULT_TAB_ID,
    PLUGIN_TAB_ORDER
} from './tabRegistry.js';

const TAB_BAR_ID = 'tab-bar';
const NODE_INFO_BAR_ID = 'nodeinfo-tab-bar';
const APP_ID = 'app';

/**
 * 本模块的构建标记。
 *
 * 用途：排查"浏览器跑的是不是最新代码"。
 * 前端模块缓存问题极难自查——代码对、服务器对，就只有客户端是旧的。
 * 探针里比对 `TABS_BUILD` 就能一眼定论（见 scripts/tab-refresh-probe.js）。
 *
 * 改行为时请顺手递增它。
 */
export const TABS_BUILD = 'v8.5.0-coverage-tab-1';

// 当前已挂载的插件页定义（用于切换时 unmount）
let mountedPluginTab = null;

// ================================================================
// 「节点信息」界面（**第三类 tab**）
// ================================================================
//
// 浏览器式的多界面：现有那些页（主视图 / 数据统计 / 插件页…）**照旧互斥**，一次只显示一个；
// 而"节点信息"是**另一类 tab** —— 可以同时开好几个、各自带 `✕`，点谁显示谁。
// 它们还有**自己的一条栏**（index.html `#nodeinfo-tab-bar`），压在内置分页栏之上，
// 所以开关它们**不影响任何现有页的状态**（就像浏览器里开新标签不动老标签）。
//
// ⚠️ **会话级，不进存档**（与 `ui/stats/compare.js` 的 `compareAccounts` 同类）：
//    刷新后回到"一个都没开"，而持久化的 `currentTab` 若指着它，`setupTabs()` 会回落到主视图。
//
// 目前面板里画的只是该节点的**最基本**信息 —— "观察节点信息"大界面会替换
// `renderNodeInfoPanel()`，这条机制不用动。
let nodeInfoTabs = [];

/** 节点信息 tab 排在所有内置页（0~999）与插件页（1000+）之后 */
const NODE_INFO_ORDER = 2000;

/** 节点信息 tab 的 id（带 `node-` 前缀，与内置 / 插件页的 id 不会撞） */
export function nodeInfoTabId(nodeId) {
    return `node-${nodeId}`;
}

/** 当前开着哪些节点信息界面（副本，外部改动不影响内部） */
export function getNodeInfoTabs() {
    return nodeInfoTabs.map(t => ({ ...t }));
}

/**
 * 打开某节点的信息界面；**已经开着就只切过去**（不重复开）
 *
 * @param {string} nodeId
 * @param {{asVirtual?: boolean, pageId?: string, activate?: boolean}} [opts]
 *   `asVirtual` = 这个 id 是**副页里的虚拟节点**（"两个都能看"）：
 *   那时**不**解析成 `_refId`，界面主体就是这个虚拟节点自己（页内信息 + 页内子节点/统计）。
 *   `activate`（默认 `true`）= 开完要不要**切过去**；`false` ⇒ **开而不激活**
 *   （像浏览器里按住 Ctrl 点链接：新页签开出来了，当前页一动不动）。`v9.0.18` 加的。
 *
 * ⚠️ **不激活时也把容器建出来**（`ensureTabContent`）：不建的话那一页签在
 *    `#nodeinfo-tab-bar` 上有按钮、点过去却是一片空白 —— 与"内容按需画"的坑同型
 *    （见 `mountPluginTab` 里那段说明）。它**不带** `active` 类 ⇒ 不会占着屏幕。
 */
export function openNodeInfoTab(nodeId, opts = {}) {
    // ⚠️ 副页里点了 📋 时传进来的是**虚拟节点 id** —— 那是"引用"，不是节点：
    //    不解析成 `_refId` 的话，标题会变成 `v_xxx`、面板里一个字段都读不到
    //（实测踩过）。解析放在这里，**所有调用点一次修好**。
    //    但"主节点与副页节点两个都能看" ⇒ 走 `asVirtual` 时**故意不解析**。
    const asVirtual = !!opts.asVirtual;
    const activate = opts.activate === undefined ? true : !!opts.activate;
    const pageId = asVirtual ? (opts.pageId || AppState.currentPageId) : '';
    const id = asVirtual ? nodeId : realNodeIdOf(AppState, nodeId);
    const tabId = nodeInfoTabId(id);
    if (!nodeInfoTabs.some(t => t.id === tabId)) {
        const page = asVirtual ? ((AppState.pages || {})[pageId] || {}) : null;
        const v = asVirtual ? ((page.virtualIndex || {})[id] || {}) : null;
        const real = (v && v.refId) ? AppState.nodes[v.refId] : null;
        const node = (!asVirtual && AppState.nodes) ? AppState.nodes[id] : null;
        // 副页可以指向**合成节点**（列表里它就是"看合并结果"的那一项）——
        // 标题照实写出"合成节点"，别让它看起来像个普通原料。
        const realIsSynth = !!(real && String(real.synthKey || '').trim());
        const label = asVirtual
            ? (realIsSynth
                ? `🧩 副页·合成节点：${real.name || '（未命名）'}（${String(real.synthKey).trim()}）`
                : `🔍 副页节点：${(real && real.name) || (v && v.name) || '（未命名）'}`)
            : `🔍 ${(node && node.name) ? node.name : id}`;
        nodeInfoTabs.push({
            id: tabId,
            nodeId: id,
            isVirtual: asVirtual,
            pageId,
            label,
            order: NODE_INFO_ORDER + nodeInfoTabs.length,
            isNodeInfo: true
        });
        renderTabBar();
        // 开而不激活：容器现在就得有（否则点过去是空白，见上面的 ⚠️），但不切过去
        if (!activate) ensureTabContent(tabId);
    }
    if (activate) switchTab(tabId);
}

/**
 * 打开某条计划的**内层页**（"跟节点详页一个意思"）：同一个 `nodeInfoTabs` 列表、同一条栏。
 * 已经开着就只切过去。
 */
export function openPlanTab(planId, opts = {}) {
    const plan = (AppState.plans || {})[planId];
    if (!plan) return false;
    const tabId = planTabId(planId);
    if (!nodeInfoTabs.some((t) => t.id === tabId)) {
        nodeInfoTabs.push({
            id: tabId,
            planId,
            label: `📅 ${plan.name || planId}`,
            order: NODE_INFO_ORDER + nodeInfoTabs.length,
            isPlan: true
        });
        renderTabBar();
        if (opts.activate === false) ensureTabContent(tabId);
    }
    if (opts.activate !== false) switchTab(tabId);
    return true;
}

/** 关掉某条计划的内层页；关掉的正是当前那个就回主视图 */
export function closePlanTab(tabId = '') {
    const i = nodeInfoTabs.findIndex((t) => t.isPlan && (!tabId || t.id === tabId));
    if (i < 0) return false;
    const gone = nodeInfoTabs.splice(i, 1)[0];
    const el = document.getElementById(tabContentId(gone.id));
    if (el && typeof el.remove === 'function') el.remove();
    renderTabBar();
    if (getCurrentTab() === gone.id) switchTab(DEFAULT_TAB_ID);
    return true;
}

/** 现在开着哪些计划页（副本） */
export function getPlanTabs() {
    return nodeInfoTabs.filter((t) => t.isPlan).map((t) => ({ ...t }));
}

/** 关掉某节点信息界面；关掉的正是当前那个就回主视图 */
export function closeNodeInfoTab(tabId) {
    const i = nodeInfoTabs.findIndex(t => t.id === tabId);
    if (i < 0) return;
    nodeInfoTabs.splice(i, 1);
    forgetNodeView(tabId);
    const el = document.getElementById(tabContentId(tabId));
    if (el && typeof el.remove === 'function') el.remove();
    renderTabBar();
    if (getCurrentTab() === tabId) switchTab(DEFAULT_TAB_ID);
}

// ================================================================
// 内置 Tab 读取
// ================================================================

/**
 * 从 index.html 的静态按钮读取内置 Tab。
 * 每次读取都跳过插件按钮（带 data-plugin-tab），因此重渲染后重复读取结果不变。
 * order 用独立计数器而非节点索引，避免插件页夹在中间时内置页顺序漂移。
 * 节点信息页不在这条栏里（见 `#nodeinfo-tab-bar`），无需在此排除。
 * @returns {Array<{id,label,order}>}
 */
export function readBuiltinTabs() {
    const bar = document.getElementById(TAB_BAR_ID);
    const list = [];
    if (bar && typeof bar.querySelectorAll === 'function') {
        let seq = 0;
        bar.querySelectorAll('.tab-btn').forEach(btn => {
            // 插件页是**运行时生成**的按钮，重渲染后不能被当成内置页
            if (btn.dataset && btn.dataset.pluginTab) return;
            const id = btn.dataset ? btn.dataset.tab : null;
            if (!id) return;
            // `data-order` 让某个内置页**显式排到别处**（判重整理要排在
            // 插件页「📥 节点自动导入」(1400) 之后 ⇒ HTML 里给它 1500）；
            // 没写就按 DOM 顺序（seq*10，仍是 0~999，排在插件页之前）。
            const explicit = btn.dataset ? btn.dataset.order : '';
            const order = (explicit !== undefined && explicit !== null && String(explicit).trim() !== '')
                ? Number(explicit) : seq * 10;
            list.push({ id, label: btn.innerHTML, order: Number.isFinite(order) ? order : seq * 10 });
            seq++;
        });
    }
    if (list.length === 0) {
        // 兜底：HTML 结构异常时至少保证主视图可用
        list.push({ id: DEFAULT_TAB_ID, label: '🏠 主视图', order: 0 });
    }
    return list;
}

/** 取「内置 + 插件 + 节点信息」合并后的 Tab 列表 */
export function getTabs() {
    // 节点信息界面是**第三类**：它们不在 index.html 里、也不经插件注册，
    // 而是运行时按需打开，所以直接追加在最后（order 也是 2000+）
    return resolveTabs(readBuiltinTabs(), getPluginTabs()).concat(nodeInfoTabs);
}

/** 判断某 id 是否为已知 Tab */
export function isKnownTab(tabId) {
    return isKnownTabId(getTabs(), tabId);
}

// ================================================================
// 当前 Tab
// ================================================================

export function getCurrentTab() {
    return AppState.currentTab || DEFAULT_TAB_ID;
}

export async function setCurrentTab(tabId) {
    if (!isKnownTab(tabId)) tabId = DEFAULT_TAB_ID;
    if (AppState.currentTab === tabId) return;
    // ⚠️ 改 tab 只是"看哪一页"，**不重画那棵看不见的树**（2026-10-18，用户："都照样卡"）：
    //   `execute` 的默认 `refreshFn` 会派发 `UI_REFRESH_REQUIRED` ⇒ `refreshCurrentPage()` 把
    //   当前那棵树（主页冷刷实测 154ms、副页 14ms）整棵重画一遍，而它此刻是**藏着的**；
    //   而且 produce 里还会跑 `refreshAllVirtualStats`（副页 3638 vNode 时 ~40ms）。
    //   两者都与"切 tab"无关 ⇒ 这里显式关掉：`refreshFn` 给空函数 + `skipVirtualStats`。
    //   要刷的内容（判重页/设置页/热力图）由 `switchTab` 自己按需画。
    await execute(
        (draft) => { draft.currentTab = tabId; },
        { skipHistory: true, validate: false, skipVirtualStats: true, refreshFn: () => {} }
    );
}

// ================================================================
// 内容容器
// ================================================================

/**
 * 取得（必要时创建）插件 Tab 的内容容器
 * @param {string} tabId
 * @returns {HTMLElement|null}
 */
export function ensureTabContent(tabId) {
    const id = tabContentId(tabId);
    let el = document.getElementById(id);
    if (el) return el;

    const app = document.getElementById(APP_ID);

    // 静默失败是这个函数最糟的行为：拿不到 #app 就 return null，
    // 于是插件页容器永不创建、页面一片空白，而**控制台一个字都没有**，
    // 排查时完全看不出是哪一步坏的（实测踩过）。这里改成响亮报告。
    if (!app) {
        console.error(`[tabs] 找不到 #${APP_ID}，无法为插件页 "${tabId}" 创建内容容器 —— `
            + '该页会显示为空白。请检查 index.html 的 #app 是否被移除或重命名。');
        return null;
    }

    el = document.createElement('div');
    el.id = id;
    el.className = 'tab-content';

    // 插到最后一个 .tab-content 之后，保持与内置页同级
    const existing = typeof app.querySelectorAll === 'function' ? app.querySelectorAll('.tab-content') : [];
    const last = existing && existing.length ? existing[existing.length - 1] : null;
    if (last && typeof last.after === 'function') last.after(el);
    else app.appendChild(el);

    return el;
}

// ================================================================
// 激活状态与挂载
// ================================================================

/**
 * 重画**当前正显示**的节点信息界面（数据变了就重画，否则面板停在旧值）。
 *
 * 节点信息界面不在 `switchTab()` 的常规路径上（它没有 mount/unmount），
 * 所以数据刷新不会自动带上它 —— 例如在大界面里点"标不用/设为首选"，
 * 或导入跑完一轮之后。只重画当前显示的：别的切过去时自然会重建。
 * `rendering` 是重入保护：重画会挂载视图，视图若再触发刷新，不能再进一圈。
 */
let renderingNodeInfo = false;
function refreshVisibleNodeInfoTab() {
    if (renderingNodeInfo) return;
    const tab = pickTab(getTabs(), getCurrentTab());
    if (!tab || (!tab.isNodeInfo && !tab.isPlan)) return;
    renderingNodeInfo = true;
    try {
        if (tab.isPlan) renderPlanPanel(tab);
        else renderNodeInfoPanel(tab);
    } catch (err) {
        console.error(`[tabs] 节点信息界面 "${tab.id}" 重画失败:`, err);
    } finally {
        renderingNodeInfo = false;
    }
}

/**
 * 「判重整理」页：内置页里唯一一个**有内容要画**的（其余内置页的内容都在 index.html 里）。
 *
 * 与节点信息界面同样的处理：切过去时画一次，数据变了重画当前显示的那个。
 * 它没有 mount/unmount 契约（那不是插件页），所以走这条显式分支。
 */
const DEDUP_TAB_ID = 'dedup';
function refreshDedupPage() {
    if (getCurrentTab() !== DEDUP_TAB_ID) return;
    renderDedupPage();
}

/**
 * 「设置」页：同上（设置是**一级 Tab**，弹窗宽度放不下）。
 *
 * ⚠️ 与判重整理**唯一的差别**：设置页里有**未保存的输入**和 me.json 草稿，
 * 所以"数据变了就重画"要先看 `isSettingsDirty()` —— 否则用户正在敲「自动保存间隔」，
 * 后台一次无关的数据刷新就会把那一格冲回旧值（这一页一直开着，后台刷新随时可能发生）。
 */
function refreshSettingsPage(force = false) {
    if (getCurrentTab() !== SETTINGS_TAB_ID) return;
    if (!force && isSettingsDirty()) return;
    renderSettingsPage();
}

/**
 * 「体检 / 需求」页（体检报告应该能在应用里看）。
 *
 * 它是**纯读**的（只读 `AppState.reports`，不联网、不跑脚本），所以比设置页更简单：
 * 没有草稿要护着，数据变了就重画，就是当前页那点筛选/页码（在 coveragePage 的模块状态里，
 * 重画不会清）。判重整理/设置页那种"按需画 + 冷启动也要画"的坑在这里一模一样。
 */
function refreshCoveragePage() {
    if (getCurrentTab() !== COVERAGE_TAB_ID) return;
    renderCoveragePage();
}

/** 两条栏：内置/插件页一条，「节点信息」层一条（见 index.html） */
function tabBarEls() {
    return [document.getElementById(TAB_BAR_ID), document.getElementById(NODE_INFO_BAR_ID)]
        .filter(Boolean);
}

/** 统一刷新按钮与内容面板的 active 状态 */
function applyTabActiveState(activeId) {
    for (const bar of tabBarEls()) {
        if (typeof bar.querySelectorAll !== 'function') continue;
        bar.querySelectorAll('.tab-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === activeId);
        });
    }
    document.querySelectorAll('.tab-content').forEach(el => {
        el.classList.toggle('active', el.id === tabContentId(activeId));
    });
}

/** 卸载当前插件页 */
function unmountMountedPluginTab() {
    if (!mountedPluginTab) return;
    const def = mountedPluginTab;
    mountedPluginTab = null;
    if (typeof def.unmount !== 'function') return;
    try {
        def.unmount({ state: AppState, tabId: def.id, container: document.getElementById(tabContentId(def.id)) });
    } catch (err) {
        console.error(`[tabs] 插件页 "${def.id}" 卸载失败:`, err);
    }
}

/**
 * 挂载插件页（内置页不做任何事，交给既有逻辑）
 * @param {Object|null} tab - 合并列表中的 Tab 定义
 */
function mountPluginTab(tab) {
    if (!tab || !tab.isPlugin) {
        unmountMountedPluginTab();
        return;
    }

    // ⚠️ 必须先确保容器存在。
    //
    // 为什么：`setupTabs()`（冷启动路径）**没有** ensureTabContent 这一步，
    // 直接调到这里；而容器是"按需创建"的，getElementById 会返回 null，
    // 函数静默 return —— 表现为「刷新后插件页按钮高亮、内容却一片空白，
    // 点一下别的 Tab 再切回来才好」。
    // 只有冷启动会暴露这个缺口（`switchTab()` 那边有 ensureTabContent）。
    // 所有插件页（ProblemSearch / AutoImport …）都受影响。
    //
    // 放在这里而不是 setupTabs()，是为了让**每个**调用点都自动受保护 ——
    // 新增调用点也不会踩同一个坑。
    let container = document.getElementById(tabContentId(tab.id));
    if (!container) {
        container = ensureTabContent(tab.id);
    }
    if (!container) return;   // ensureTabContent 已在内部响亮报错

    // 防御：**容器空了就必须重挂**。
    // 只判断 `mountedPluginTab.id === tab.id` 就直接 return 不够：记录说已挂载、
    // 容器实际是空的，这种状态会永久卡住 ——
    // 表现为「切走再切回来（或刷新后）该页一片空白，怎么点都不渲染」。
    // 容器为空时无条件重挂，代价只是一次多余 mount，收益是不会卡死。
    const containerIsEmpty = container.children.length === 0
        && !String(container.innerHTML || '').trim();

    if (mountedPluginTab && mountedPluginTab.id === tab.id && !containerIsEmpty) return;

    unmountMountedPluginTab();

    mountedPluginTab = tab;
    try {
        tab.mount({
            state: AppState,
            tabId: tab.id,
            container,
            refresh: () => document.dispatchEvent(new CustomEvent(EVENTS.UI_REFRESH_REQUIRED)),
            // ★ **插件不许 import `ui/`**（`src/features/AGENTS.md` 的不变量）⇒ 把"节点入口条"
            //   （身份键 + 完整面包屑 + 📋，实现只有 `ui/kit/nodeEntry.js` 那一份）**注入**给插件，
            //   照 `features/ContestOverview` 注入 `jumpId` 的先例：**插件只调用、不 import**。
            //   ⚠️ 注入的是**函数**（不是预渲染的 DOM）：列表每次重画都重新调一次，拿到的才是当前 state。
            nodeEntry: (node, opts) => nodeEntryLine(AppState, node, opts)
        });
    } catch (err) {
        // 插件自身的错误不应中断分页切换
        console.error(`[tabs] 插件页 "${tab.id}" 挂载失败:`, err);
        container.innerHTML = `<div class="empty-tab"><div class="icon">🧩</div><div class="title">插件页加载失败</div><div class="desc">${err && err.message ? err.message : err}</div></div>`;
    }
}

// ================================================================
// 切换
// ================================================================

export function switchTab(tabId) {
    const tabs = getTabs();
    if (!isKnownTabId(tabs, tabId)) return;
    if (tabId === getCurrentTab()) return;
    // 诊断（2026-10-18，用户："解决在一级 tab 栏间切换慢的问题"）—— 逐段打毫秒，默认关。
    const t0 = nowMs();
    const lap = (n) => diag('Tab', `${n} = ${msSince(t0)}ms（累计）`);

    setCurrentTab(tabId).catch(() => {});
    lap('setCurrentTab');

    const tab = pickTab(tabs, tabId);
    // 先建容器，再统一切 active，确保新面板参与 class 切换
    if (tab && (tab.isPlugin || tab.isNodeInfo || tab.isPlan)) ensureTabContent(tab.id);
    // 节点信息界面自己负责画内容（它不是插件，没有 mount/unmount）
    if (tab && tab.isNodeInfo) renderNodeInfoPanel(tab);
    // 计划页同理：内容按需画（它不是插件，没有 mount/unmount）
    if (tab && tab.isPlan) renderPlanPanel(tab);
    // 判重整页：**同步画**（2026-10-18 用户："改回卡一下"）。
    //   试过 `scheduleDedupRefresh()`（60ms 后画）—— 点击立刻响应、内容晚一拍；
    //   用户的选择是"**宁愿卡一下，也不要空白一拍**"（判重整页冷算 `computeModel` 真包 603ms，
    //   但那一笔只在该页数据变过后的第一次付）。⇒ 这里保持同步，别再改成延迟。
    if (tab && tab.id === DEDUP_TAB_ID) refreshDedupPage();
    lap('判重页 refreshDedupPage');
    // 设置页：切过来时**强制**画（用户主动进来的，草稿不会丢 —— 值在 `draft` 里）
    if (tab && tab.id === SETTINGS_TAB_ID) refreshSettingsPage(true);
    lap('设置页');
    // 体检页：纯读，切过来就画
    if (tab && tab.id === COVERAGE_TAB_ID) refreshCoveragePage();
    lap('体检页');

    applyTabActiveState(tabId);
    lap('applyTabActiveState');
    mountPluginTab(tab);
    lap('mountPluginTab');

    const d0 = nowMs();
    document.dispatchEvent(new CustomEvent('tab-switched', { detail: { tabId } }));
    diag('Tab', `tab-switched 监听（含热力图/统计二级页）= ${msSince(d0)}ms ｜ 合计 ${msSince(t0)}ms`);
}

// ================================================================
// 渲染与初始化
// ================================================================

/**
 * 重建两条 Tab 栏的按钮（内置、插件页、节点信息层）并绑定点击
 * 用 DOM 构建而非拼 HTML：按钮可被查询/绑定，也避免插件 label 被当作 HTML 注入
 * @returns {HTMLElement|null}
 */
export function renderTabBar() {
    const bar = document.getElementById(TAB_BAR_ID);
    const niBar = document.getElementById(NODE_INFO_BAR_ID);
    if (!bar && !niBar) return null;

    const tabs = getTabs();
    const activeId = getCurrentTab();

    // 清空既有按钮（index.html 的静态按钮在此被替换为动态渲染结果）
    if (bar) bar.innerHTML = '';
    if (niBar) niBar.innerHTML = '';

    for (const tab of tabs) {
        // 「节点信息」是**上一层**的另一条栏，不混进内置分页栏
        const host = (tab.isNodeInfo || tab.isPlan) ? niBar : bar;
        if (!host) continue;

        const btn = document.createElement('button');
        btn.className = tab.id === activeId ? 'tab-btn active' : 'tab-btn';
        btn.dataset.tab = tab.id;
        // data-plugin-tab 让 readBuiltinTabs 在重渲染后仍能区分
        if (tab.isPlugin) btn.dataset.pluginTab = '1';
        if (tab.isNodeInfo || tab.isPlan) {
            if (tab.isNodeInfo) btn.dataset.nodeinfoTab = '1';
            else btn.dataset.planTab = '1';
            // 节点信息 tab：文字 + ✕（参考浏览器：能同时开多个，各自关掉）
            const label = document.createElement('span');
            label.textContent = tab.label;
            btn.appendChild(label);
            const x = document.createElement('span');
            x.className = 'tab-close';
            x.textContent = '✕';
            x.title = plain('关闭');
            x.style.cssText = 'margin-left:8px; opacity:.55; font-size:11px; cursor:pointer;';
            x.addEventListener('click', (ev) => {
                ev.stopPropagation();          // 别把"关闭"当成"切过去"
                closeNodeInfoTab(tab.id);
            });
            btn.appendChild(x);
        } else {
            btn.innerHTML = tab.label;
        }
        btn.addEventListener('click', () => switchTab(tab.id));
        host.appendChild(btn);
    }

    // 没开任何节点信息界面时整条栏收起（否则会留一条空白横杠）
    if (niBar) niBar.style.display = nodeInfoTabs.length ? '' : 'none';
    return bar || niBar;
}

export function setupTabs() {
    const tabs = getTabs();
    const current = getCurrentTab();

    // 持久化的 currentTab 可能指向已被移除的插件页，回落到主视图
    const activeId = isKnownTabId(tabs, current) ? current : DEFAULT_TAB_ID;
    if (activeId !== current) {
        setCurrentTab(activeId).catch(() => {});
    }

    // ★ 在所有分支之前，**确保每个插件页的容器都已存在**。
    //
    // 为什么要有这一步：插件页的内容容器是"按需创建"的（不在 index.html 里），
    // 而挂载路径只有 switchTab() 会创建它。冷启动（刷新后停在插件页）时
    // 容器从未被创建 → mountPluginTab 里 getElementById 返回 null。
    // 把它提到这里，无论后续走哪条分支都不会再出现"按钮高亮、内容空白"。
    for (const t of tabs) {
        if (t && t.isPlugin) ensureTabContent(t.id);
    }

    // 版本戳：用于一眼确认浏览器加载的是不是最新代码（排查缓存问题时很省事）
    try {
        const pane = document.getElementById(tabContentId('auto-import'));
        if (pane) pane.dataset.tabsBuild = TABS_BUILD;
    } catch (e) { /* 纯诊断，失败无妨 */ }

    renderTabBar();
    applyTabActiveState(activeId);

    // 冷启动就停在「判重整理」页时（持久化的 currentTab）也要画内容 ——
    // 内置页的内容都在 index.html 里，只有这一页是运行时画的（与插件页同一个坑）
    refreshDedupPage();
    // 设置页同理（冷启动停在它上面时也要有内容）
    refreshSettingsPage(true);
    // 体检页同理
    refreshCoveragePage();

    // 若持久化的就是插件页，初始化时也要挂载
    mountPluginTab(pickTab(tabs, activeId));

    // 数据刷新时带上正显示着的节点信息界面（它不走 switchTab，没人替它重画）
    document.addEventListener(EVENTS.UI_REFRESH_REQUIRED, refreshVisibleNodeInfoTab);
    // 判重整理页同理（绑/解绑之后要立刻看到结果）。
    // ⚠️ 缓存必须在**这里**作废：`UI_REFRESH_REQUIRED` 是"数据变了"的唯一信号，
    //    比猜时间戳可靠；而且即使当前不在这一页，缓存也得跟着作废。
    document.addEventListener(EVENTS.UI_REFRESH_REQUIRED, () => {
        invalidateDedupCache();
        // ⚠️ 判重整理页那几栏**很重**（真包实测：⑤ 冲突 ~456ms、组三趟 ~786ms，都是冷算），
        //    而且它多数时候**没在屏幕上**（用户在树上点）。所以这里**延迟一拍**再重画：
        //    当前这次点击的反馈（树/统计）先出来，重算落到下一帧 —— 用户点着才"连续"。
        //    ⚠️ 缓存作废仍**同步**做（上面那行），所以不延迟期间读到的也不会是陈旧的。
        scheduleDedupRefresh();
        // 设置页**不强制**：用户可能正敲着字（见 refreshSettingsPage）
        refreshSettingsPage();
        // 体检页：纯读，跟着一起重画
        refreshCoveragePage();
    });
}

/**
 * 排一次"稍后重画判重整理页"（合并成一次）。
 *
 * 见上面那段：那页的重算（⑤ 冲突 + 组三趟）单次是**几百毫秒**级的冷算，
 * 让它跟在这一帧里跑，等于每次点树上都多等一个 0.5~0.8 秒。
 * 延迟一拍不改变"数据变了就重画"的语义，只是把重算挪到点击之后。
 */
function scheduleDedupRefresh() {
    if (dedupRefreshTimer) return;
    dedupRefreshTimer = setTimeout(() => {
        dedupRefreshTimer = null;
        refreshDedupPage();
    }, 60);
}

let dedupRefreshTimer = null;
