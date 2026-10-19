// ================================================================
// 视图态（core/model/viewState.js）
// 职责：`state.view` 这一层（**展开 / 页码**）的读写 + localStorage 往返
// 依赖：无（**刻意**：它在 shell/state.js 的 replaceState 里被调用，
//       不能反向依赖 core/ 的其它东西，否则会成环）。Node 里没有 localStorage 时安全降级。
// ================================================================
// 口径：
//   · **视图态不住在 `nodes` 里** —— 折叠、翻页都是"看的姿势"，不是节点数据。
//     住在 `nodes` 里时，点一下折叠就会换掉 `nodes` 引用 ⇒ 所有按"数据引用"失效的缓存
//     （派生表 / 组索引 / 合成表 / 计数）整片作废（实测：一次折叠重算整份派生表 ~292ms）；
//     而且**读/写 `draft.nodes[x]`** 会把整张 2.7 万节点的字典拖进 draft，提交时 Immer
//     就得整张浅拷（实测 ~30~44ms/次）。展开态迁出后：折叠的 `produce` 从 33ms 掉到 **0.1ms**。
//   · 两张表都是**稀疏**的：
//       `view.expanded[id] = true`   —— 只有"展开着"的才在表里（默认收起）
//       `view.pages[id]    = n`      —— 只有"翻过页"的才在表里（默认第 1 页）
//   · 不落 IndexedDB、不进导出包、不进撤销快照（`A_registry.js` 的 `view` 那一行）；
//   · 真源是 localStorage：`saveView` 写、`loadView`/`applyView` 在 `replaceState` 之后
//     贴回来（启动加载、导入整包都不会重置折叠与页码）；
//   · 读一律走 `isExpanded(state,id)` / `pageOf(state,id)`（**唯一读入口**），
//     写一律走 `setExpanded(draft,id,v)` / `setNodePage(draft,id,page)`。
// ================================================================

/** localStorage 键名。
 *  ⚠️ 字面值 `acmtree:expanded` **故意不改**（历史数据就是它）：改它等于把用户手上的
 *     折叠状态丢掉。存的东西现在多了一节 `pages`（老数据是数组 ⇒ 只有折叠，照样认）。 */
export const VIEW_CACHE_KEY = 'acmtree:expanded';

function storage() {
    try {
        return (typeof localStorage !== 'undefined' && localStorage) ? localStorage : null;
    } catch (_) {
        return null;
    }
}

/** 取出要落盘的视图态：`{ expanded: [id...], pages: {id: n} }`（两张表都稀疏） */
export function collectView(state = {}) {
    const view = (state && state.view) || {};
    const expanded = [];
    const em = view.expanded || {};
    for (const id of Object.keys(em)) if (em[id]) expanded.push(id);
    const pages = {};
    const pm = view.pages || {};
    for (const id of Object.keys(pm)) {
        const n = Number(pm[id]);
        if (Number.isFinite(n) && n > 1) pages[id] = n;
    }
    // ★ 训练计划条的两处折叠（`docs/training-plan.md` ⑥ "要能折叠"）：
    //   整条栏 + 每个计划各一行。与上面两张表同样**稀疏**（默认都是展开）。
    const collapsedPlans = [];
    const cm = view.collapsedPlans || {};
    for (const id of Object.keys(cm)) if (cm[id]) collapsedPlans.push(id);
    // ★ 计划页两张图的看法（⑱⑲⑳）：每张图的**粒度**、哪几张折起来、上下顺序。
    //   ⚠️ 粒度是"怎么看"，**不是数据**（执行粒度才住 `state.plans`）—— 两者互相独立。
    const planCharts = {};
    const pcm = view.planCharts || {};
    for (const id of Object.keys(pcm)) if (pcm[id] && typeof pcm[id] === 'object') planCharts[id] = pcm[id];
    // ★ 计划页"题目列表 / 每期完成情况"两块怎么看（折叠 / 页码 / 筛选条件）—— 同样是"看"，不是数据
    const planSections = {};
    const psm = view.planSections || {};
    for (const id of Object.keys(psm)) if (psm[id] && typeof psm[id] === 'object') planSections[id] = psm[id];
    return { expanded, pages, planBarCollapsed: !!view.planBarCollapsed, collapsedPlans, planCharts, planSections };
}

/** 把当前视图态写进本地缓存；返回是否真的写了 */
export function saveView(state) {
    const s = storage();
    if (!s) return false;
    try {
        s.setItem(VIEW_CACHE_KEY, JSON.stringify(collectView(state)));
        return true;
    } catch (_) {
        return false;      // 隐私模式/配额满：视图态丢缓存可以接受，绝不因此报错
    }
}

// ================================================================
// 合并写入
//
// `saveView` 是整表序列化（现在是稀疏的两张表 ⇒ 几十 KB 量级）；折叠/翻页都是一次动一格，
// 晚 200ms 落盘没有任何可感知差别；于是走 `scheduleViewSave`（同一拍内多次只写一次），
// 并在页面要走时**强制 flush**。`saveView` 本身不变（同步写）。
// ================================================================
let _pending = null;        // 待写的 state（引用，不必拷贝：Save 时现读）
let _timer = null;
let _hooked = false;

function hookFlush() {
    if (_hooked) return;
    _hooked = true;
    try {
        if (typeof document === 'undefined' || !document.addEventListener) return;
        // 页面离开/切到后台时把待写的写掉（关标签页也不丢最后一次视图变化）
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') flushViewSave();
        });
        if (typeof window !== 'undefined' && window.addEventListener) {
            window.addEventListener('pagehide', flushViewSave);
            window.addEventListener('beforeunload', flushViewSave);
        }
    } catch (_) { /* 桩环境：忽略 */ }
}

/** 合并写：`delay` 内的多次调用只落盘一次；已排队时返回 false */
export function scheduleViewSave(state, delay = 200) {
    _pending = state;
    hookFlush();
    if (_timer) return false;
    _timer = setTimeout(() => {
        _timer = null;
        const s = _pending;
        _pending = null;
        if (s) saveView(s);
    }, delay);
    return true;
}

/** 立刻把待写的写掉（页面离开、或测试要确定性时调） */
export function flushViewSave() {
    if (_timer) {
        clearTimeout(_timer);
        _timer = null;
    }
    const s = _pending;
    _pending = null;
    if (s) saveView(s);
    return !!s;
}

/** 读本地缓存；坏数据一律当"没有"（返回 `{expanded:{}, pages:{}}` 形状） */
export function loadView() {
    const s = storage();
    if (!s) return emptyViewShape();
    try {
        const raw = s.getItem(VIEW_CACHE_KEY);
        if (!raw) return emptyViewShape();
        const data = JSON.parse(raw);
        // 老写法是**数组**（只列展开的 id）—— 认它，不然升级那一下折叠状态会静默清空。
        if (Array.isArray(data)) {
            const expanded = {};
            for (const id of data) if (typeof id === 'string' && id) expanded[id] = true;
            return { expanded, pages: {}, planBarCollapsed: false, collapsedPlans: {}, planCharts: {}, planSections: {} };
        }
        const rawExpanded = (data && typeof data === 'object' && data.expanded) || {};
        const expanded = Array.isArray(rawExpanded)
            ? rawExpanded.reduce((m, id) => { if (id) m[id] = true; return m; }, {})
            : rawExpanded;
        const collapsedPlans = {};
        const rawCollapsed = (data && typeof data === 'object' && data.collapsedPlans) || [];
        if (Array.isArray(rawCollapsed)) for (const id of rawCollapsed) if (id) collapsedPlans[id] = true;
        const planCharts = {};
        const rawCharts = (data && typeof data === 'object' && data.planCharts) || {};
        if (rawCharts && typeof rawCharts === 'object' && !Array.isArray(rawCharts)) {
            for (const id of Object.keys(rawCharts)) {
                if (rawCharts[id] && typeof rawCharts[id] === 'object') planCharts[id] = rawCharts[id];
            }
        }
        const planSections = {};
        const rawSections = (data && typeof data === 'object' && data.planSections) || {};
        if (rawSections && typeof rawSections === 'object' && !Array.isArray(rawSections)) {
            for (const id of Object.keys(rawSections)) {
                if (rawSections[id] && typeof rawSections[id] === 'object') planSections[id] = rawSections[id];
            }
        }
        return {
            expanded,
            pages: (data && typeof data === 'object' && data.pages) || {},
            planBarCollapsed: !!(data && typeof data === 'object' && data.planBarCollapsed),
            collapsedPlans,
            planCharts,
            planSections
        };
    } catch (_) {
        return emptyViewShape();
    }
}

/**
 * 把缓存的视图态贴回 `state.view`（用于 `replaceState` 之后：启动加载 / 整包导入）。
 * ⚠️ 视图态不在 `nodes` 上 ⇒ 只写这一层，不碰任何节点对象（`computeDiff` 的按引用做差
 *    因此不会把折叠/翻页当数据改动）。
 * @returns {number} 贴回去几格（展开 + 翻过页的）
 */
export function applyView(state, data = null) {
    const src = data || loadView();
    if (!state) return 0;
    const expanded = {};
    let n = 0;
    for (const id of Object.keys(src.expanded || {})) {
        if (src.expanded[id]) { expanded[id] = true; n++; }
    }
    const pages = {};
    for (const id of Object.keys(src.pages || {})) {
        const p = Number(src.pages[id]);
        if (Number.isFinite(p) && p > 1) { pages[id] = p; n++; }
    }
    const collapsedPlans = {};
    for (const id of Object.keys(src.collapsedPlans || {})) {
        if (src.collapsedPlans[id]) { collapsedPlans[id] = true; n++; }
    }
    const planCharts = {};
    for (const id of Object.keys(src.planCharts || {})) {
        const v = src.planCharts[id];
        if (v && typeof v === 'object') { planCharts[id] = v; n++; }
    }
    const planSections = {};
    for (const id of Object.keys(src.planSections || {})) {
        const v = src.planSections[id];
        if (v && typeof v === 'object') { planSections[id] = v; n++; }
    }
    state.view = {
        ...(state.view || {}),
        expanded, pages,
        planBarCollapsed: !!src.planBarCollapsed,
        collapsedPlans,
        planCharts,
        planSections
    };
    return n;
}

/** 空视图态的形状（**唯一一份**：加一格视图态就改这里，别在四处各写一遍对象字面量） */
function emptyViewShape() {
    return { expanded: {}, pages: {}, planBarCollapsed: false, collapsedPlans: {}, planCharts: {}, planSections: {} };
}

// ================================================================
// 读入口（**唯一**）
// ================================================================

/** 这一格展开着吗 */
export function isExpanded(state, id) {
    return !!(id && state && state.view && state.view.expanded && state.view.expanded[id]);
}

/** 这一格第几页（没翻过 = 1） */
export function pageOf(state, id) {
    const p = Number(id && state && state.view && state.view.pages && state.view.pages[id]);
    return Number.isFinite(p) && p > 1 ? p : 1;
}

// ================================================================
// 写入口（**唯一**）
// ================================================================

/** 写一格展开态：`true` = 展开；`false` = 收起（稀疏表里直接删键） */
export function setExpanded(draft, id, value) {
    if (!draft || !id) return false;
    const view = draft.view || (draft.view = {});
    const map = view.expanded || (view.expanded = {});
    if (value) map[id] = true;
    else delete map[id];
    return !!value;
}

/** 写一格页码：`1` = 回第一页（稀疏表里直接删键） */
export function setNodePage(draft, id, page) {
    if (!draft || !id) return 1;
    const n = Math.max(1, parseInt(page, 10) || 1);
    const view = draft.view || (draft.view = {});
    const map = view.pages || (view.pages = {});
    if (n > 1) map[id] = n;
    else delete map[id];
    return n;
}

// ---- 训练计划条的两处折叠（⑥）----

/** 整条计划栏折起来了吗 */
export function isPlanBarCollapsed(state) {
    return !!(state && state.view && state.view.planBarCollapsed);
}

/** 写整条栏的折叠态 */
export function setPlanBarCollapsed(draft, value) {
    if (!draft) return false;
    const view = draft.view || (draft.view = {});
    view.planBarCollapsed = !!value;
    return view.planBarCollapsed;
}

/** 某个计划那一行折起来了吗 */
export function isPlanCollapsed(state, planId) {
    return !!(planId && state && state.view && state.view.collapsedPlans && state.view.collapsedPlans[planId]);
}

/** 写某个计划那一行的折叠态（稀疏：展开就把键删掉） */
export function setPlanCollapsed(draft, planId, value) {
    if (!draft || !planId) return false;
    const view = draft.view || (draft.view = {});
    const map = view.collapsedPlans || (view.collapsedPlans = {});
    if (value) map[planId] = true;
    else delete map[planId];
    return !!value;
}

// ---- 计划页两张图的看法（⑱⑲⑳）----

/** 两张图的默认查看粒度（⑳：折线默认日、柱状默认周；与计划自己的**执行粒度**无关） */
export const DEFAULT_PLAN_CHART_GRAINS = { line: 'day', bar: 'week' };

/** 计划页两张图的默认看法（粒度 / 哪几张折起 / 上下顺序） */
function defaultPlanCharts() {
    return { grain: { ...DEFAULT_PLAN_CHART_GRAINS }, hidden: {}, order: 'line-bar' };
}

/**
 * 读某条计划的两张图怎么看（**唯一读口**：缺什么补什么，调用方不用判 undefined）。
 * @returns {{grain:{line:string,bar:string}, hidden:Object, order:'line-bar'|'bar-line'}}
 */
export function planChartViewOf(state, planId) {
    const raw = (state && state.view && state.view.planCharts && state.view.planCharts[planId]) || {};
    const d = defaultPlanCharts();
    const grain = (raw.grain && typeof raw.grain === 'object') ? raw.grain : {};
    return {
        grain: {
            line: grain.line || d.grain.line,
            bar: grain.bar || d.grain.bar
        },
        hidden: (raw.hidden && typeof raw.hidden === 'object') ? { ...raw.hidden } : {},
        order: (raw.order === 'bar-line') ? 'bar-line' : 'line-bar'
    };
}

/** 写某条计划的两张图怎么看（**唯一写口**；只覆盖传进来的那几格） */
export function setPlanChartView(draft, planId, patch = {}) {
    if (!draft || !planId) return null;
    const view = draft.view || (draft.view = {});
    const map = view.planCharts || (view.planCharts = {});
    const cur = map[planId] || defaultPlanCharts();
    const next = {
        grain: { ...(cur.grain || {}), ...(patch.grain || {}) },
        hidden: { ...(cur.hidden || {}), ...(patch.hidden || {}) },
        order: (patch.order || cur.order) === 'bar-line' ? 'bar-line' : 'line-bar'
    };
    map[planId] = next;
    return next;
}

// ---- 计划页「题目列表 / 每期完成情况」两块怎么看 ----

/** 两块的默认看法（折叠 / 页码 / 每页几条 / 筛选条件） */
function defaultPlanSections() {
    return {
        list: {
            // ★ 第 11 轮（用户："默认每页10"）：每页条数默认 50 → **10**。
            //   ⚠️ 它只是**默认值**：用户在下拉里选过之后就以视图态里那份为准（`num(raw…, 默认)`）。
            open: true, page: 1, pageSize: 10, q: '', statuses: [],
            // ★ 第 4 轮（用户："筛选请让 XCPC 难度也可以勾选"）：难度档从**单选** `level`
            //   改成**多选** `levels`（与标签/平台同形）。`level` 是旧格子，只在读的时候兜底一次。
            levels: [],
            // 第 3 轮"筛选满血"：再加三维条件 + 排序（与挑题弹窗那五维对齐）
            tags: [], platforms: [], cfMin: '', cfMax: '', sort: 'default'
        },
        periods: {
            open: true, page: 1, pageSize: 12, from: '', to: '',
            // ★ 点某期 ⇒ 看那一期做了哪些题（第 6 轮："点某一项呼出题目列表"）；
            //   存**期键**（''= 没选）；表与两张图点的是同一个键（同一份视图态）
            pick: ''
        },
        // 当前强度表的数值（默认收起 —— 它是"看一眼口径"的东西，不是天天盯的）
        intensity: { open: false }
    };
}

/**
 * 读某条计划那两块怎么看（**唯一读口**：缺什么补什么）。
 * @returns {{list:Object, periods:Object}}
 */
export function planSectionViewOf(state, planId) {
    const raw = (state && state.view && state.view.planSections && state.view.planSections[planId]) || {};
    const d = defaultPlanSections();
    const num = (v, fallback) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : fallback);
    return {
        list: {
            open: (raw.list && raw.list.open !== undefined) ? !!raw.list.open : d.list.open,
            page: num(raw.list && raw.list.page, d.list.page),
            pageSize: num(raw.list && raw.list.pageSize, d.list.pageSize),
            q: String((raw.list && raw.list.q) || ''),
            statuses: Array.isArray(raw.list && raw.list.statuses) ? raw.list.statuses.map(Number) : [],
            // ⚠️ 旧格子 `level`（单选字符串）**兜底读一次** ⇒ 别人浏览器里存着的旧视图态不会把筛选悄悄丢掉
            levels: Array.isArray(raw.list && raw.list.levels)
                ? raw.list.levels.map(String)
                : (String((raw.list && raw.list.level) || '') ? [String(raw.list.level)] : []),
            tags: Array.isArray(raw.list && raw.list.tags) ? raw.list.tags.map(String) : [],
            platforms: Array.isArray(raw.list && raw.list.platforms) ? raw.list.platforms.map(String) : [],
            cfMin: String((raw.list && raw.list.cfMin) || ''),
            cfMax: String((raw.list && raw.list.cfMax) || ''),
            sort: String((raw.list && raw.list.sort) || 'default')
        },
        intensity: {
            open: (raw.intensity && raw.intensity.open !== undefined) ? !!raw.intensity.open : d.intensity.open
        },
        periods: {
            open: (raw.periods && raw.periods.open !== undefined) ? !!raw.periods.open : d.periods.open,
            page: num(raw.periods && raw.periods.page, d.periods.page),
            pageSize: num(raw.periods && raw.periods.pageSize, d.periods.pageSize),
            from: String((raw.periods && raw.periods.from) || ''),
            to: String((raw.periods && raw.periods.to) || ''),
            pick: String((raw.periods && raw.periods.pick) || '')
        }
    };
}

/** 写某条计划那两块怎么看（**唯一写口**；只覆盖传进来的那几格） */
export function setPlanSectionView(draft, planId, patch = {}) {
    if (!draft || !planId) return null;
    const view = draft.view || (draft.view = {});
    const map = view.planSections || (view.planSections = {});
    const cur = { ...defaultPlanSections(), ...(map[planId] || {}) };
    const next = {
        list: { ...cur.list, ...(patch.list || {}) },
        periods: { ...cur.periods, ...(patch.periods || {}) },
        intensity: { ...(cur.intensity || {}), ...(patch.intensity || {}) }
    };
    map[planId] = next;
    return next;
}

/**
 * **分页全部回到第一页**（"改每页条数"那类操作：一张空表就是全部第 1 页）。
 *
 * ⚠️ 名字里**不许**再叫 `clearAllPages`（2026-10-16 改，审计翻出来的**撞名**）：
 *    `core/ops/page.js` 也有一个 `clearAllPages` —— 那个清的是**副页**（`draft.pages = {}`，真删整页），
 *    而这里清的是**分页**（`draft.view.pages = {}`）。两个名字一样、语义差得远，
 *    调用点各 import 自己那份（`ui/settings/settingsPage.js` 用这个；
 *    `ui/G_modal/G3_settings.js` 用 ops 那个）⇒ 读代码的人**没法从名字判断**，
 *    改错一处就是"清空之后副页还在"或者"页码没重置"。
 */
export function resetPagination(draft) {
    if (!draft) return;
    draft.view = { ...(draft.view || {}), pages: {} };
}
