// ================================================================
// 树形模式/文件夹模式共享组件（ui/folderShared.js）
// 职责：面包屑、视图Tab、统计Tab、布局助手的 UI 构建
// 依赖：view/renderers.js, I_folderMode.js
// ================================================================
import { renderNode } from '../../view/renderers.js';
// ★ 诊断日志的唯一开关（`localStorage.DSH_DIAG = '1'` + 刷新；见 `utils/diag.js` 文件头）
import { diag, nowMs, msSince } from '../../utils/diag.js';
import { getEditMode } from './folderMode.js';
// ★ 训练计划条（⑤⑥）：画在「总览统计与树之间」（槽位 `#plan-bar`）
import { renderPlanBar, PLAN_BAR_ID } from '../plan/planBar.js';

// ================================================================
// 面包屑
// ================================================================
export function buildBreadcrumbHTML(path, config) {
    const { getDisplayName, onNavigate, rootLabel = '🏠 根目录', prefixLabel = null } = config;

    if (!path || path.length === 0) {
        return '';
    }

    let html = '<div style="display:flex; align-items:center; gap:6px; font-size:13px; color:#64748b; padding:6px 0 10px 0; flex-wrap:wrap;">';

    if (prefixLabel) {
        html += `<span style="color:#94a3b8; font-weight:400;">${prefixLabel}</span>`;
        html += `<span style="color:#94a3b8;">›</span>`;
    }

    for (let i = 0; i < path.length; i++) {
        const node = path[i];
        const isLast = i === path.length - 1;
        const displayName = getDisplayName(node) || node.id || '未命名';

        if (isLast) {
            html += `<span style="font-weight:600; color:#0f172a;">${displayName}</span>`;
        } else {
            html += `<a href="#" class="folder-breadcrumb-link" data-id="${node.id}" style="color:#2563eb; text-decoration:none; cursor:pointer;">${displayName}</a>`;
            html += `<span style="color:#94a3b8;">›</span>`;
        }
    }
    html += '</div>';
    return html;
}

export function bindBreadcrumbEvents(container, onNavigate) {
    if (!container) return;
    container.querySelectorAll('.folder-breadcrumb-link').forEach(el => {
        el.addEventListener('click', (e) => {
            e.preventDefault();
            const id = el.dataset.id;
            if (id && onNavigate) {
                onNavigate(id);
            }
        });
    });
}

// ================================================================
// 视图 Tab
// ================================================================
export function buildViewTabsHTML(currentView, tabs) {
    let html = '<div style="display:flex; gap:4px; padding:6px 0 10px 0; border-bottom:1px solid #eef2f6; margin-bottom:6px; flex-wrap:wrap;">';
    for (const tab of tabs) {
        const active = tab.id === currentView ? 'active' : '';
        html += `<button class="folder-view-tab-btn ${active}" data-view="${tab.id}" style="padding:4px 14px; border:none; border-radius:6px; background:${active ? '#2563eb' : 'transparent'}; color:${active ? '#fff' : '#64748b'}; font-size:13px; font-weight:500; cursor:pointer; transition:all 0.15s;">${tab.label}</button>`;
    }
    html += '</div>';
    return html;
}

export function bindViewTabEvents(container, onSwitch) {
    if (!container) return;
    container.querySelectorAll('.folder-view-tab-btn').forEach(btn => {
        btn.addEventListener('click', function () {
            const view = this.dataset.view;
            if (view && onSwitch) {
                onSwitch(view);
            }
        });
    });
}

// ================================================================
// 统计二级 Tab
// ================================================================
export function buildStatsSubTabsHTML(currentChart = 'xcpc') {
    return `
        <div id="stats-sub-tabs" style="display:flex; gap:4px; padding:0 0 10px 0; border-bottom:1px solid #eef2f6; margin-bottom:12px;">
            <button class="stats-sub-tab-btn ${currentChart === 'xcpc' ? 'active' : ''}" data-chart="xcpc" style="padding:3px 12px; border:none; border-radius:4px; background:${currentChart === 'xcpc' ? '#2563eb' : 'transparent'}; color:${currentChart === 'xcpc' ? '#fff' : '#64748b'}; font-size:12px; font-weight:500; cursor:pointer;">XCPC难度</button>
            <button class="stats-sub-tab-btn ${currentChart === 'cf' ? 'active' : ''}" data-chart="cf" style="padding:3px 12px; border:none; border-radius:4px; background:${currentChart === 'cf' ? '#2563eb' : 'transparent'}; color:${currentChart === 'cf' ? '#fff' : '#64748b'}; font-size:12px; font-weight:500; cursor:pointer;">CF难度</button>
        </div>
    `;
}

export function bindStatsSubTabEvents(container, onSwitch) {
    if (!container) return;
    container.querySelectorAll('.stats-sub-tab-btn').forEach(btn => {
        btn.addEventListener('click', function () {
            const chartType = this.dataset.chart;
            container.querySelectorAll('.stats-sub-tab-btn').forEach(b => {
                b.classList.remove('active');
                b.style.background = 'transparent';
                b.style.color = '#64748b';
            });
            this.classList.add('active');
            this.style.background = '#2563eb';
            this.style.color = '#fff';
            if (onSwitch) {
                onSwitch(chartType);
            }
        });
    });
}

// ================================================================
// 布局助手
// ================================================================
/**
 * 重置所有视图容器（树形与文件夹两种模式都会先调它）
 *
 * ⚠️ 这里必须一并收起**插件页面板**。
 *
 * 插件面板（`#folder-view-panel-<id>`）是 `folderViewHost` 创建的**独立 DOM 节点**，
 * 不属于下面这些内置容器。早期只清了内置容器，于是切回树形模式后
 * 插件页内容仍留在屏幕上（实测症状）。
 *
 * 为什么放在这里而不是 `renderFolderViewTabs`：`renderTree()` 在树形分支里
 * **提前 return**，压根走不到 `renderFolderViewTabs` —— 加在那里是死代码。
 * 而 `resetViewContainers()` 是两种模式的公共重置点，位置才正确。
 *
 * 用选择器按 class 找，避免为这一处引入 folderViewHost 的依赖。
 */
export function resetViewContainers() {
    const breadcrumb = document.getElementById('folder-breadcrumb');
    const viewTabs = document.getElementById('folder-view-tabs');
    const folderStats = document.getElementById('folder-stats');
    const statsContainer = document.getElementById('stats-chart-container');
    const treeBody = document.getElementById('tree-body');

    breadcrumb.style.display = 'none';
    breadcrumb.innerHTML = '';
    viewTabs.style.display = 'none';
    viewTabs.innerHTML = '';
    folderStats.style.display = 'none';
    folderStats.innerHTML = '';
    statsContainer.style.display = 'none';
    statsContainer.innerHTML = '';
    document.getElementById('stats-sub-tabs')?.remove();

    // 收起全部插件页面板（不删内容：再切回文件夹模式时宿主会重新 mount）
    document.querySelectorAll('.folder-view-panel').forEach(el => {
        el.style.display = 'none';
    });

    if (treeBody) {
        treeBody.style.display = 'block';
        treeBody.innerHTML = '';
    }
}

export function applyTreeLayout({ statsContent, showStatsRow = true, showActionBtn = true, rootInfo = null }) {
    // 诊断（2026-10-18，用户切副页热态 124ms 里 `applyTreeLayout` 占 ~87ms）：拆成两段看谁是主项。
    //   开关在 `utils/diag.js` 一处（`localStorage.DSH_DIAG = '1'` + 刷新）。
    const lt0 = nowMs();
    const lLap = (n) => diag('树布局', `${n} = ${msSince(lt0)}ms（累计）`);
    const statsRow = document.querySelector('#tree-container > div:first-child');
    const treeStats = document.getElementById('tree-stats');
    const container = document.getElementById('mode-action-btn-container');
    // ★ 「根」那一格的 📋 —— **树模式这一条与文件夹模式那条是同一个规则**（`v9.1.19`）：
    //   根在树模式下也不画方框（`renderTreeView` 画的是 `getChildNodes(state, root)`）
    //   ⇒ 不补这颗，切到树模式就又打不开了。位置同样是**总览统计右边**（`index.html` 里那一格）。
    //   ⚠️ 不复用 `#mode-action-btn-container`：那格装的是「添加根节点 / 清空选择」，
    //      与"根自己的详页入口"不是一回事（清空选择时它会被清掉，📋 不该跟着消失）。
    //   ⚠️ 桩里可能没有这一格（`stats-defer.smoke.mjs` 只搭了 `#tree-stats`）⇒ 必须容忍找不到。
    const rootInfoSlot = document.getElementById('tree-root-info-container');
    if (rootInfoSlot) {
        rootInfoSlot.innerHTML = rootInfoButton(rootInfo);
        rootInfoSlot.style.display = rootInfo ? '' : 'none';
    }

    // ★ **训练计划条**（设计稿 `docs/training-plan.md` ⑤⑥）：位置就是「总览统计与树之间」
    //   （槽位 `#plan-bar` 在 `index.html` 里紧跟在统计那一行的下面）。
    //   ⚠️ 它**只在"统计那一行显示"的时候画**（= 树模式）：文件夹模式停在一个节点上时
    //      那格由文件夹自己的那套接管，这条栏在那儿没有意义。
    const planBar = document.getElementById(PLAN_BAR_ID);
    if (planBar) {
        planBar.style.display = showStatsRow ? '' : 'none';
        if (showStatsRow) renderPlanBar(); else planBar.innerHTML = '';
    }
    lLap('计划条 renderPlanBar');

    if (statsRow) statsRow.style.display = showStatsRow ? 'flex' : 'none';
    if (treeStats) {
        treeStats.style.display = 'block';
        treeStats.innerHTML = statsContent;
    }
    if (container) {
        if (showActionBtn) {
            container.innerHTML = buildModeActionButton();
            container.style.display = '';
        } else {
            container.innerHTML = '';
            container.style.display = 'none';
        }
    }
    lLap('统计行/按钮那几格');
}

// ================================================================
// 只刷"统计那两串数字"（**延迟一拍**用的轻量重画）
//
// 为什么单独一个：全局统计算一遍要整表扫好几趟（真包 ~100ms），于是渲染改成
// "先画上一次那串、过一拍再算准"（见 `view/stats.js` 的 `getGlobalStatsSoon`）。
// 到点之后**不能**重画整块 / 整棵树（那比同步算还贵），只把这些**已经在页面上**的
// 数字格子刷一遍就行 —— 三种模式下各有一处：
//   · 树模式：`#tree-stats`（`applyTreeLayout` 写的那个）
//   · 文件夹根：`#folder-stats` 里的 `.app-stats`
//   · 兼容 id：`#global-stats`
// ================================================================
export function paintStatsNumbers(stats) {
    if (!stats) return;
    const html = `<span>${stats.cStr}</span><span>${stats.pStr}</span>`;
    const treeStats = document.getElementById('tree-stats');
    if (treeStats) treeStats.innerHTML = html;
    const folderStats = document.getElementById('folder-stats');
    const box = folderStats && folderStats.querySelector ? folderStats.querySelector('.app-stats') : null;
    if (box) box.innerHTML = html;
    const legacy = document.getElementById('global-stats');
    if (legacy) legacy.innerHTML = html;
}

export function applyFolderLayout() {
    const statsRow = document.querySelector('#tree-container > div:first-child');
    const treeStats = document.getElementById('tree-stats');
    const breadcrumb = document.getElementById('folder-breadcrumb');
    const viewTabs = document.getElementById('folder-view-tabs');

    if (statsRow) statsRow.style.display = 'none';
    if (treeStats) treeStats.style.display = 'none';
    breadcrumb.style.display = 'block';
    viewTabs.style.display = 'block';
}

// ================================================================
// 动态模式操作按钮
// ================================================================
export function buildModeActionButton() {
    const editMode = getEditMode();
    if (editMode === 'selection') {
        return `<button class="btn btn-secondary" id="btn-clear-selection">🗑️ 清空选择</button>`;
    } else {
        return `<button class="btn btn-primary" id="btn-add-root">➕ 添加根节点</button>`;
    }
}

// ================================================================
// 文件夹统计栏（根节点显示总览统计，非根节点显示节点方框）
//
// ★ **"当前节点"那一格与子节点同一套**（用户 2026-10-07："文件夹模式 所选节点的方框与
//   子节点的 UI 与行为一致，除了不能左键单击"）：调用方传 `mode: 'folder'`（= 子节点那个
//   mode），这里再把 `currentFolderId` 设成**它自己** ⇒ `view/helpers.js` 的 `buildActions`
//   里 `isCurrentFolder` 自动把 ⬆/⬇ 摘掉（它在父容器里的位置，不该在这一屏里动），
//   其余按钮（📋/✏️/➕/⚙️/✖、以及选中模式那两个圆点）与子节点**一模一样**。
// ⚠️ 「不能左键单击」不用在这里做：进文件夹那个处理器只挂在 `#tree-body` 上
//   （`ui/folder/folderMode.js` 的 `setupFolderClickEvents`），而这一格住在 `#folder-stats`
//   —— 单击本来就什么都不会发生（按钮的动作委托另有 `ui/G_events.js` 那条补挂）。
// ================================================================
/**
 * **"根"那一格的 📋**（唯一一处；`v9.1.18`，用户 2026-10-13："超级根节点的详页入口放总览统计右侧"）。
 *
 * 为什么需要它：**根在任何显示模式下都没有自己的方框** ——
 *   · 树模式 `renderTreeView` 画的是它的**孩子**（`getChildNodes(state, root)`）；
 *   · 文件夹模式停在根这一格只画总览统计。
 * ⇒ 它**原来一个详页入口都没有**，"根那一层的统计 / 字段"根本点不开。
 *
 * ⚠️ **两种根给的身份不一样，别抄成一份**：
 *   · **主树超级根**：`{ id }` —— 只写 `data-id`（与 `view/helpers.js:buildActions` 的非虚拟分支同形）。
 *   · **副页根**（页内 `v_root`，`type 'O'`，代表"这一页"本身）：`{ vid, pageId }` ——
 *     `data-id` **故意不给**（它不引用任何主树节点）⇒ `ui/G_events.js:openInfoFromButton`
 *     算出 `refId === ''` ⇒ 弹"看哪个"时如实说"这是副页根节点…"，只给"副页节点本身"那一个选项。
 *
 * ⚠️ **别自己调 `openNodeInfoTab`**：接住它的只有 `ui/G_events.js` 的文档级委托
 *   （判定见 `src/ui/AGENTS.md` 的「跳到主树 / 面包屑 / 打开详情」那条）。
 */
function rootInfoButton(rootInfo) {
    if (!rootInfo) return '';
    const attrs = rootInfo.vid
        ? ` data-vid="${rootInfo.vid}" data-page-id="${rootInfo.pageId || ''}"`
        : ` data-id="${rootInfo.id || ''}"`;
    return `<button class="btn-icon btn-node-info"${attrs}`
        + ` title="${rootInfo.title || '详细节点信息'}">📋</button>`;
}

// ================================================================
// 文件夹统计栏（根节点显示总览统计，非根节点显示节点方框）
//
// ★ **"当前节点"那一格与子节点同一套**（用户 2026-10-07："文件夹模式 所选节点的方框与
//   子节点的 UI 与行为一致，除了不能左键单击"）：调用方传 `mode: 'folder'`（= 子节点那个
//   mode），这里再把 `currentFolderId` 设成**它自己** ⇒ `view/helpers.js` 的 `buildActions`
//   里 `isCurrentFolder` 自动把 ⬆/⬇ 摘掉（它在父容器里的位置，不该在这一屏里动），
//   其余按钮（📋/✏️/➕/⚙️/✖、以及选中模式那两个圆点）与子节点**一模一样**。
// ⚠️ 「不能左键单击」不用在这里做：进文件夹那个处理器只挂在 `#tree-body` 上
//   （`ui/folder/folderMode.js` 的 `setupFolderClickEvents`），而这一格住在 `#folder-stats`
//   —— 单击本来就什么都不会发生（按钮的动作委托另有 `ui/G_events.js` 那条补挂）。
// ================================================================
export function renderFolderStatsComponent({ state, stats, node, isRoot, mode = 'folder-header', showAddBtn = false, rootInfo = null }) {
    const folderStats = document.getElementById('folder-stats');
    if (!folderStats) return;

    if (isRoot && stats) {
        folderStats.className = '';
        folderStats.style.display = 'block';
        const addBtnHtml = showAddBtn ? buildModeActionButton() : '';
        // 位置按用户指的：**总览统计右边**（在「添加根节点」左边）
        const rootInfoHtml = rootInfoButton(rootInfo);
        folderStats.innerHTML = `
            <div style="display:flex; align-items:center; gap:12px; flex-wrap:wrap; width:100%;">
                <div class="app-stats" style="display:flex; flex-wrap:wrap; gap:12px 24px; flex:1; padding:8px 12px; background:#f8fafc; border-radius:10px; margin:0;">
                    <span>${stats.cStr}</span>
                    <span>${stats.pStr}</span>
                </div>
                ${rootInfoHtml}
                ${addBtnHtml}
            </div>
        `;
    } else if (node) {
        folderStats.className = '';
        folderStats.style.display = 'block';
        folderStats.innerHTML = renderNode(state, node, 0, [], null, true, mode, false,
            mode === 'folder' ? node.id : null);
    } else {
        folderStats.style.display = 'none';
    }
}