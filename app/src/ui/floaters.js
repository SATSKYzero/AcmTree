// ================================================================
// 悬浮提示组件（ui/floaters.js）
// 职责：展开节点数提示、模式切换按钮、编辑模式切换按钮
// 依赖：shell/state.js, core/validate/expanded.js, A_constants.js,
//       ui/folderMode.js, ui/G_modal/G_modals.js, ui/G_pageUI.js
// ================================================================
import { AppState } from '../shell/state.js';
import { getCurrentRenderedCount } from '../core/validate/expanded.js';
import { EVENTS } from '../A_constants.js';
import {
    getTreeDisplayMode,
    getEditMode,
    setEditMode,
    switchDisplayMode
} from './folder/folderMode.js';
import { showToast } from './G_modal/G_modals.js';
import { renderPageTabs } from './G_pageUI.js';
import { getCurrentTab, getTabs } from './tabs.js';
import { DEFAULT_TAB_ID } from './tabRegistry.js';


// ================================================================
// 悬浮件的可见性
// 悬浮的「展开节点数」与两个模式切换按钮只在主视图显示，看节点信息页时不显示。
// 判据细化到**当前 tab**：只有主视图这一个 tab 才显示
//（否则"建好就一直挂着"，在节点信息页/插件页里也看得见）。
//
// ★ 另一条判据 —— 按住 Ctrl 才显示（按 Ctrl 开、松开关）：
//   理由：那三个悬浮件平时是**视野里的噪声**
//   （左下角常驻一块黑色计数 + 两个模式按钮），而它们的用途都是"临时看一眼 / 临时切一下"。
//   于是：**按住 Ctrl = 露出来，松开 = 收回去**（默认整页干净）。
//   ⚠️ 两个条件**同时**满足才显示：主视图 ∧ 按住 Ctrl。
//   ⚠️ 窗口失焦时必须**当松开处理** —— 切窗口时收不到 `keyup`，否则那三块会一直挂在屏幕上。
// ================================================================
const FLOATER_IDS = ['expanded-warning-floater', 'mode-switch-floater', 'edit-mode-switch-floater'];

/** Ctrl 现在按着吗（唯一状态；只由下面两个监听器改） */
let ctrlHeld = false;

function updateFloaterVisibility() {
    const cur = getCurrentTab();
    const tab = getTabs().find(t => t.id === cur);
    const onMain = cur === DEFAULT_TAB_ID && !(tab && (tab.isNodeInfo || tab.isPlugin));
    const show = onMain && ctrlHeld;
    for (const id of FLOATER_IDS) {
        const el = document.getElementById(id);
        if (el) el.style.display = show ? '' : 'none';
    }
    // ★ 同一个 Ctrl 状态也管着**副页方框上的计划强度角标**（`.node-badge`，默认 `display:none`）：
    //   挂一个 body 类，让 CSS 决定显隐 ⇒ **按键不需要重画任何东西**。
    //   ⚠️ 别再挂第二个 keydown/keyup 监听器（这一处是 Ctrl 状态的唯一一份，见文件头）。
    if (document.body && document.body.classList) {
        document.body.classList.toggle('ctrl-held', ctrlHeld);
    }
    return show;
}

/** 判断一个键盘事件是不是"Ctrl 本身"（`key` 是 `Control`；老浏览器退到 `keyCode === 17`） */
function isCtrlKey(e) {
    if (!e) return false;
    if (e.key === 'Control') return true;
    return e.keyCode === 17 || e.which === 17;
}

/**
 * 接上"按住 Ctrl 才显示"的开关。
 *
 * 监听挂在 `window` 的**捕获阶段**：应用里有别处 `preventDefault` / `stopPropagation` 时
 * 照样能收到底层按键（这只是"看得见看不见"，不改任何数据）。
 */
function setupCtrlHold() {
    window.addEventListener('keydown', (e) => {
        if (!isCtrlKey(e) || ctrlHeld) return;
        ctrlHeld = true;
        updateFloaterVisibility();
    }, true);
    window.addEventListener('keyup', (e) => {
        if (!isCtrlKey(e)) return;
        ctrlHeld = false;
        updateFloaterVisibility();
    }, true);
    // 切走窗口时收不到 keyup ⇒ 当松开（否则悬浮件会一直挂着）
    window.addEventListener('blur', () => {
        if (!ctrlHeld) return;
        ctrlHeld = false;
        updateFloaterVisibility();
    });
    // Alt+Tab / 右键菜单 / 系统弹窗后回来时，Ctrl 其实早就松了 —— 兜一道
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden || !ctrlHeld) return;
        ctrlHeld = false;
        updateFloaterVisibility();
    });
}

/** 「Ctrl 现在按着吗」—— 给单测/排查用（悬浮件的可见性判据里它是一半条件） */
export function isCtrlHeld() {
    return ctrlHeld;
}

export { updateFloaterVisibility };

// ================================================================
// 展开节点数提示
// ================================================================
function setupExpandedWarningFloater() {
    const floater = document.createElement('div');
    floater.id = 'expanded-warning-floater';
    floater.style.cssText = `
        position: fixed;
        bottom: 20px;
        left: 20px;
        background: rgba(0,0,0,0.75);
        color: #fff;
        padding: 8px 16px;
        border-radius: 8px;
        font-size: 13px;
        font-family: 'Segoe UI', 'Microsoft YaHei', sans-serif;
        z-index: 999;
        pointer-events: none;
        opacity: 0.9;
        transition: background 0.3s;
        max-width: 300px;
    `;
    document.body.appendChild(floater);

    function updateWarningFloater() {
        const nodePerPage = AppState.settings.display.nodePerPage;
        const count = getCurrentRenderedCount(AppState, nodePerPage);
        const warningLimit = AppState.settings.performance.expandedNodeWarningLimit;
        const blockLimit = AppState.settings.performance.expandedNodeBlockLimit;
        let bgColor = 'rgba(0,0,0,0.75)';
        if (count > blockLimit) bgColor = 'rgba(220,38,38,0.85)';
        else if (count > warningLimit) bgColor = 'rgba(245,158,11,0.85)';
        floater.style.background = bgColor;
        floater.textContent = `📊 展开节点数: ${count}/${warningLimit}/${blockLimit}`;
    }

    updateWarningFloater();
    document.addEventListener('expanded-count-updated', updateWarningFloater);
    document.addEventListener('settings-saved', updateWarningFloater);
    setInterval(() => { updateWarningFloater(); updateFloaterVisibility(); }, 3000);
    document.addEventListener(EVENTS.UI_REFRESH_REQUIRED, updateFloaterVisibility);
    // 点标签栏后立刻重判（用事件委托，避免 tabs.js 反过来依赖本模块）
    document.addEventListener('click', (e) => {
        const el = e.target;
        if (el && el.closest && el.closest('#tab-bar, #nodeinfo-tab-bar')) {
            setTimeout(updateFloaterVisibility, 0);
        }
    }, true);
    updateFloaterVisibility();
}

// ================================================================
// 模式切换按钮
// ================================================================
function setupModeSwitchFloater() {
    const floater = document.createElement('div');
    floater.id = 'mode-switch-floater';
    floater.style.cssText = `
        position: fixed;
        bottom: 60px;
        left: 24px;
        z-index: 999;
        background: rgba(15, 23, 42, 0.85);
        backdrop-filter: blur(4px);
        color: #fff;
        padding: 8px 16px;
        border-radius: 24px;
        font-size: 13px;
        font-family: 'Segoe UI', 'Microsoft YaHei', sans-serif;
        cursor: pointer;
        user-select: none;
        transition: background 0.2s, transform 0.15s;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        border: 1px solid rgba(255,255,255,0.1);
        display: flex;
        align-items: center;
        gap: 6px;
    `;
    floater.addEventListener('mouseenter', () => {
        floater.style.background = 'rgba(15, 23, 42, 0.95)';
    });
    floater.addEventListener('mouseleave', () => {
        floater.style.background = 'rgba(15, 23, 42, 0.85)';
    });
    floater.addEventListener('click', () => {
        const current = getTreeDisplayMode();
        const next = current === 'tree' ? 'folder' : 'tree';
        switchDisplayMode(next);
    });

    function updateLabel() {
        const mode = getTreeDisplayMode();
        floater.innerHTML = mode === 'tree' ? '🌳 树形' : '📁 文件夹';
    }

    updateLabel();
    document.addEventListener('settings-saved', updateLabel);
    document.addEventListener(EVENTS.UI_REFRESH_REQUIRED, updateLabel);
    document.body.appendChild(floater);
}

// ================================================================
// 编辑模式切换按钮
// ================================================================
function setupEditModeSwitchFloater() {
    const floater = document.createElement('div');
    floater.id = 'edit-mode-switch-floater';
    floater.style.cssText = `
        position: fixed;
        bottom: 60px;
        left: 120px;
        z-index: 999;
        background: rgba(15, 23, 42, 0.85);
        backdrop-filter: blur(4px);
        color: #fff;
        padding: 8px 16px;
        border-radius: 24px;
        font-size: 13px;
        font-family: 'Segoe UI', 'Microsoft YaHei', sans-serif;
        cursor: pointer;
        user-select: none;
        transition: background 0.2s, transform 0.15s;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        border: 1px solid rgba(255,255,255,0.1);
        display: flex;
        align-items: center;
        gap: 6px;
    `;
    floater.addEventListener('mouseenter', () => {
        floater.style.background = 'rgba(15, 23, 42, 0.95)';
    });
    floater.addEventListener('mouseleave', () => {
        floater.style.background = 'rgba(15, 23, 42, 0.85)';
    });
    floater.addEventListener('click', () => {
        const current = getEditMode();
        const next = current === 'attribute' ? 'selection' : 'attribute';
        setEditMode(next).catch(() => {});
        document.dispatchEvent(new CustomEvent(EVENTS.UI_REFRESH_REQUIRED));
        renderPageTabs();
    });

    function updateLabel() {
        const mode = getEditMode();
        floater.innerHTML = mode === 'attribute' ? '✏️ 属性编辑' : '🎯 选中状态编辑';
    }

    updateLabel();
    document.addEventListener('settings-saved', updateLabel);
    document.addEventListener(EVENTS.UI_REFRESH_REQUIRED, updateLabel);
    document.body.appendChild(floater);
}

// ================================================================
// 统一入口
// ================================================================
export function setupFloaters() {
    setupCtrlHold();
    setupExpandedWarningFloater();
    setupModeSwitchFloater();
    setupEditModeSwitchFloater();
}