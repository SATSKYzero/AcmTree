// ================================================================
// 应用入口（I_app.js）
// 职责：初始化所有模块，串联事件与处理器
// 依赖：shell/, core/validate/, view/, ui/, A_constants.js
// ================================================================

import { APP_VERSION, APP_BUILD, EVENTS } from './A_constants.js';

import { AppState } from './shell/state.js';
import { execute } from './shell/executor.js';
import { initApp } from './shell/init.js';
import { setupDbAutoSave } from './shell/autoSave.js';
import { installFlushHooks } from './persistence/index.js';
import { bootstrapPlugins, announceStartupProblems } from './shell/bootstrap.js';

import { getCurrentRenderedCount } from './core/validate/expanded.js';
import { saveView } from './core/model/viewState.js';
import { installLongHandlerMonitor } from './utils/longHandler.js';

import { updateInfoBar } from './view/index.js';

import { showToast } from './ui/G_modal/G_modals.js';
import { setupEventDelegation, setupShortcuts } from './ui/G_events.js';
import {
    renderPageTabs,
    setupPageTabsEvents
} from './ui/G_pageUI.js';
import { getCurrentTab, setupTabs } from './ui/tabs.js';
import {
    setupModeChangeListener,
    ensureContainers
} from './ui/folder/folderMode.js';
import { setupFloaters } from './ui/floaters.js';
import {
    renderTrainingHeatmap,
    setupACTrackingEvents,
    setupACTrackingAutoRefresh,
    getStatsTab,
    renderStatsTabContent
} from './ui/stats/acTracking.js';
import { setupCompareView } from './ui/stats/compare.js';
import { initStatsCharts } from './ui/stats/statsCharts.js';
import { bindUIButtons } from './ui/buttons.js';
import { registerAllEvents } from './ui/eventBridge.js';

// ================================================================
// 初始化
// ================================================================
async function init() {
    // ---- 0. 构建标记（第一件事，越早挂上越好）----
    // 排查"代码明明改对了、现象却没变"时，控制台敲 __ACM_BUILD__ 即可确认
    // 当前标签页跑的是不是新代码（见"怎么判断跑的是不是新代码"那条排查经验）。
    window.__ACM_BUILD__ = APP_BUILD;
    if (document.body) document.body.dataset.appBuild = APP_BUILD;

    document.title = `Acm_Tree ${APP_VERSION}`;
    const h1 = document.querySelector('h1');
    // ⚠️ 标题**只有**"📂 Acm_Tree <版本>"（用户 2026-10-15："标题的灰字删了"）——
    //   别再加副标题/署名那种灰字：那是**给作者看的**，不是给用这个应用的人看的
    //   （"谁做的"记在 `README.md` / `作者专用\` 里就够了）。
    if (h1) h1.innerHTML = `📂 Acm_Tree ${APP_VERSION}`;

    // ---- 0. 激活插件（在事件注册和状态加载之前） ----
    await bootstrapPlugins();
    
    // ---- 1. 先注册所有事件监听器（在 initApp 派发刷新之前） ----
    registerAllEvents();

    // ---- 2. 绑定 UI 按钮 ----
    bindUIButtons();

    // ---- 3. 事件委托 + 快捷键 ----
    setupEventDelegation();
    setupShortcuts();

    // ---- 4. 容器初始化 ----
    ensureContainers();

    // ---- 4b. 插件装载问题要说出来 ----
    //   `bootstrapPlugins()` 跑在 `registerAllEvents()` **之前**（那时 `show-toast`
    //   监听器还没注册，就地弹会被丢掉），所以它把问题攒着，这里才派发。
    //   不说的话，读不到 /plugins.json 的表现是"检索、自动导入页无提示地消失"。
    announceStartupProblems();

    // ---- 5. 从磁盘加载（内部会派发 UI_REFRESH_REQUIRED） ----
    await initApp();

    // ---- 6. Tab 栏 ----
    setupTabs();
    setupPageTabsEvents();

    // 切到「📊 数据统计」时画热力图（**同步**：用户 2026-10-18 定的"宁愿卡一下、不要空白一拍"）。
    //   ⚠️ 试过"过一拍再画"（点击立刻响应、热力图晚一拍出现）⇒ 被用户否掉，别再改回去。
    //   它自己的成本已经压过：排序从"比较器里现读"改成"先取一次时间再排"（39 → 8ms）、
    //   `collectACNodes` 按数据代缓存（18ms → 命中 0）。
    document.addEventListener('tab-switched', (e) => {
        if (!(e.detail && e.detail.tabId === 'stats')) return;
        try { renderTrainingHeatmap(); } catch (err) { console.error('[统计页] 热力图重画失败:', err); }
    });

    // ---- 7. 二级 Tab ----
    const initialStatsTab = getStatsTab();
    renderStatsTabContent(initialStatsTab);

    setupACTrackingEvents();
    setupACTrackingAutoRefresh();
    setupCompareView();
    setupModeChangeListener();
    initStatsCharts();

    // ---- 8. 副页 Tab 栏 ----
    renderPageTabs();

    // ---- 9. 信息栏 ----
    updateInfoBar(AppState);

    // ---- 10. 检查展开节点数 ----
    const nodePerPage = AppState.settings.display.nodePerPage;
    const initialCount = getCurrentRenderedCount(AppState, nodePerPage);
    const limit = AppState.settings.performance.expandedNodeBlockLimit;
    if (initialCount > limit) {
        await execute(
            (draft) => {
                // "全部收起" = 稀疏表清空（视图态不住在节点上）
                draft.view = { ...(draft.view || {}), expanded: {} };
            },
            { validate: false, refreshParentId: null, skipHistory: true, skipVirtualStats: true, skipPersist: true }
        );
        saveView(AppState);           // 启动时这一下要立即落盘（合并写入的定时器还没起）
        showToast(`检测到展开节点数超限（${initialCount} > ${limit}），已自动折叠所有节点`, 'error');
    }

    // ---- 11. 悬浮提示 ----
    setupFloaters();

    // ---- 11b. 长处理自测（阈值见 `A_constants.LONG_HANDLER_THRESHOLD_MS`）----
    // 浏览器那条 `[Violation] 'click' handler took xxxms` 的阈值页面改不了，
    // 这里量一份自己的：交互的**同步**工作量 ≥ 阈值就在控制台打一行（带"点在哪"）。
    installLongHandlerMonitor();

    // ---- 12. 自动保存 ----
    setupDbAutoSave();
    installFlushHooks();      // 合并写的兜底 flush（pagehide / 切后台 / 卸载前）
    document.addEventListener('settings-saved', () => {
        setupDbAutoSave();
        renderPageTabs();
        if (getCurrentTab() === 'main') {
            document.dispatchEvent(new CustomEvent(EVENTS.UI_REFRESH_REQUIRED));
        }
    });

    // ---- 13. editMode 默认值保险 ----
    if (!AppState.settings.mode.editMode) {
        AppState.settings.mode.editMode = 'attribute';
    }

    if (getCurrentTab() === 'stats') {
        setTimeout(renderTrainingHeatmap, 50);
    }

    console.log(`📂 Acm_Tree ${APP_VERSION} 已加载`);
    console.log('💡 Ctrl+N 快速添加根节点, Alt+S 导出完整 JSON, Ctrl+点击按钮快速添加');
    console.log('📁 支持树形/文件夹双模式，在设置中切换');
}

// ================================================================
// 启动
// ================================================================
// ⚠️ 失败也要**把攒下的插件问题报出来**：`init()` 走到一半抛异常
//    （注册器 / 容器那几步）时，`announceStartupProblems()` 那行根本到不了 ⇒
//    插件问题又变成静默的。
init().catch((err) => {
    console.error('[启动] 初始化失败:', err);
    announceStartupProblems();
});