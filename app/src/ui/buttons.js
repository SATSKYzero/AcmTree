// ================================================================
// 顶栏按钮绑定（ui/buttons.js）
// 职责：顶栏所有按钮的点击事件
// 依赖：shell/state.js, shell/executor.js,
//       handlers/H_importExport.js,
//       ui/G_modal/G_modals.js,
//       ui/G_modal/G6_importExport.js,
//       ui/folderMode.js, A_constants.js
// ================================================================
import { AppState } from '../shell/state.js';
import { execute } from '../shell/executor.js';
import { importFullJSON } from '../handlers/H_importExport.js';
import {
    showToast,
    resetAllWithConfirm
} from './G_modal/G_modals.js';
import { showImportModal, showExportModal } from './G_modal/G6_importExport.js';
import { renderAccountChip, showAccountsModal } from './G_modal/G8_accounts.js';
import { getTreeDisplayMode, goToRootFolder } from './folder/folderMode.js';
// 「折叠全部」用过的口（**各只有一份**，别自己写字段）：副页回根目录（单个 / **批量只刷一次**）、页内展开态写口
import { goToVirtualRoot, goToAllVirtualRoots } from './folder/virtualFolderMode.js';
import { switchTab } from './tabs.js';
import { EVENTS } from '../A_constants.js';
import { scheduleViewSave } from '../core/model/viewState.js';
import { setVirtualNodeExpanded } from '../core/ops/view.js';

// ================================================================
// 绑定所有顶栏按钮
// ================================================================
export function bindUIButtons() {
    // ---- 导入 / 导出下拉 ----
    document.getElementById('btn-import-dropdown')?.addEventListener('click', showImportModal);
    document.getElementById('btn-export-dropdown')?.addEventListener('click', showExportModal);

    // ---- 完整导入 file input ----
    document.getElementById('file-input-full')?.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
            importFullJSON(file);
        }
        e.target.value = '';
    });

    // ---- 添加根节点（事件委托，支持动态创建） ----
    document.addEventListener('click', function (e) {
        const btn = e.target.closest('#btn-add-root');
        if (btn) {
            e.preventDefault();
            document.dispatchEvent(new CustomEvent(EVENTS.ADD_ROOT, { detail: { ctrlKey: e.ctrlKey } }));
        }
    });

    // ---- 清空数据 ----
    document.getElementById('btn-reset')?.addEventListener('click', function (e) {
        if (e.ctrlKey) {
            resetAllWithConfirm();
        } else {
            showToast('请按住 Ctrl 键再点击清空按钮', 'error');
        }
    });

    // ---- 折叠全部 ----
    // ★ 两种范围（用户 2026-10-13 定）：**不带 Ctrl = 只折当前页**；**带 Ctrl = 所有页都折**。
    //   "当前页" = `AppState.currentPageId`（`main` = 主树）；副页的展开态**不在 `view.expanded`**，
    //   而在 `pages[pageId].virtualIndex[v].expanded` ⇒ 必须走**唯一那个写口**
    //   `core/ops/view.js:setVirtualNodeExpanded`（与 `ui/revealNode.js` 同一份，别自己写字段）。
    //   ⚠️ 折叠**不动页码**（与主树那条"只清 `view.expanded`"同一姿态）。
    document.getElementById('btn-collapse-all')?.addEventListener('click', function (e) {
        const allPages = !!e.ctrlKey;
        const mode = getTreeDisplayMode();
        const curPageId = AppState.currentPageId || 'main';
        const pageIds = () => Object.keys(AppState.pages || {});

        if (mode === 'folder') {
            // 文件夹模式：折叠 = **回根目录**（回根口各只有一份，别新写）
            if (!allPages) {
                if (curPageId === 'main') goToRootFolder(); else goToVirtualRoot(curPageId);
                showToast(curPageId === 'main' ? '已回到根目录' : '已回到这一页的根目录', 'success');
                return;
            }
            // 主树 + 所有副页**合并成同一次**重画：先各自静默写状态，末尾由批量口派发唯一一次刷新
            // （改前是 1 + N 次：主树 1 次自带 + 每页各 1 次）
            goToRootFolder({ refresh: false });
            goToAllVirtualRoots(pageIds());
            showToast('已回到所有页的根目录', 'success');
            return;
        }

        // 树模式：折主树（当前页就是主树、或按了 Ctrl 时） + 折副页
        const foldMain = allPages || curPageId === 'main';
        const foldPages = allPages ? pageIds() : (curPageId === 'main' ? [] : [curPageId]);
        execute(
            (draft) => {
                // "全部收起" = 稀疏表清空（视图态不住在节点上）
                if (foldMain) draft.view = { ...(draft.view || {}), expanded: {} };
                for (const pid of foldPages) {
                    const page = (draft.pages || {})[pid];
                    if (!page) continue;
                    for (const vId of Object.keys(page.virtualIndex || {})) {
                        setVirtualNodeExpanded(draft, vId, pid, false);
                    }
                }
            },
            {
                validate: false,
                refreshParentId: null,
                // 折叠状态只进本地缓存，不进历史快照/导出包；
                // 探针实测：再省掉副页统计重算（折叠不改取值）与重复派发的刷新（execute 已发一次）
                skipHistory: true,
                skipVirtualStats: true,
                skipPersist: true,
                onSuccess: () => {
                    scheduleViewSave(AppState);      // 合并写入
                    showToast(allPages ? '已折叠所有页的节点' : '已折叠当前页的节点', 'success');
                },
                onError: (err) => {
                    showToast('折叠失败: ' + err.message, 'error');
                }
            }
        ).catch(() => {});
    });

    // ---- 设置 ----
    // 设置是**一级 Tab**（弹窗宽度放不下）⇒ 这个按钮只是"切到那一页"。
    document.getElementById('settings-icon')?.addEventListener('click', () => {
        switchTab('settings');
    });

    // ---- 账户：标记 + 管理界面 ----
    // 只读状态要**看得见**：`viewing ≠ current` 时手改会被拒绝，
    // 没有这个标记用户只会觉得"怎么改都改不动"。
    renderAccountChip();
    // 点 👤 **弹账户管理窗**（用户 2026-10-19："很久以前的版本 点顶部的账号按钮会弹窗，那样挺好的"
    //   —— 前一版改成"跳到设置页那栏"，他否了）。⚠️ 弹窗与设置页那栏是**同一份视图**
    //   （`G8_accounts.js:mountAccountsView`），两个入口都在、谁都不算第二套。
    document.getElementById('account-chip')?.addEventListener('click', () => {
        showAccountsModal();
    });

    // ---- 指南 ----
    document.getElementById('btn-guide')?.addEventListener('click', function () {
        window.open('docs/guide.html', '_blank');
    });

    // ---- 宽度控制 ----
    const widthInput = document.getElementById('width-control');
    const resetWidthBtn = document.getElementById('reset-width');
    const savedWidth = localStorage.getItem('appWidth');
    if (savedWidth && widthInput) {
        widthInput.value = savedWidth;
        document.documentElement.style.setProperty('--app-max-width', savedWidth + 'px');
    }
    widthInput?.addEventListener('input', function () {
        let val = parseInt(this.value);
        if (isNaN(val) || val < 100) val = 100;
        document.documentElement.style.setProperty('--app-max-width', val + 'px');
        localStorage.setItem('appWidth', val);
    });
    resetWidthBtn?.addEventListener('click', function () {
        if (widthInput) widthInput.value = 1200;
        document.documentElement.style.setProperty('--app-max-width', '1200px');
        localStorage.setItem('appWidth', 1200);
    });

    // ---- 空状态下的添加按钮 ----
    document.addEventListener('click', function (e) {
        if (e.target.id === 'empty-add-btn') {
            document.dispatchEvent(new CustomEvent(EVENTS.ADD_ROOT));
        }
    });
}