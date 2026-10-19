// ================================================================
// 事件桥接（ui/eventBridge.js）
// 职责：注册所有模块间 CustomEvent 的监听器
// 依赖：shell/, core/ops/, handlers/, view/,
//       ui/G_modal/, ui/G_pageUI.js, ui/folderMode.js, A_constants.js
// ================================================================
import { AppState } from '../shell/state.js';
import { execute, executePointUpdate } from '../shell/executor.js';
import {
    deleteNode as deleteNodeOp,
    moveUp as moveUpOp,
    moveDown as moveDownOp,
    copyNode as copyNodeOp
} from '../core/ops/tree.js';
import {
    deleteVirtualNode as deleteVirtualNodeOp,
    cleanDeletedRealNode
} from '../core/ops/page.js';
import { TYPE_CHILDREN_MAP } from '../core/model/constants.js';
import { EVENTS, TYPE_LABEL_MAP } from '../A_constants.js';
import { setupRevealNodeEvents } from './revealNode.js';
import {
    updateInfoBar,
    markStatsDirty,
    markSizeDirty
} from '../view/index.js';
import {
    showToast,
    showMappingDialog,
    showProblemInfoDialog,
    showOperationConfirmWithCountdown,
    promptAddRoot,
    promptAddChild,
    editNode,
    editVNode,
    showTreeSelector
} from './G_modal/G_modals.js';
import { renderPageTabs, refreshCurrentPage } from './G_pageUI.js';
// ★ 诊断日志的唯一开关（`localStorage.DSH_DIAG = '1'` + 刷新；见 `utils/diag.js` 文件头）
import { diag, nowMs, msSince } from '../utils/diag.js';
import { renderAccountChip } from './G_modal/G8_accounts.js';
import { resetFolderStateIfInvalid } from './folder/folderMode.js';
import {
    exportFullJSON,
    batchImport,
    batchImportSubmissions,
    batchImportContests,
    batchImportProblemInfo,
    sortProblems,
    sortSubmissions
} from '../handlers/H_importExport.js';

// ================================================================
// 统一注册
// ================================================================
export function registerAllEvents() {
    registerUIEvents();
    registerTreeEvents();
    registerBatchEvents();
    registerSortEvents();
    registerPageEvents();
    registerPersistenceEvents();
    setupRevealNodeEvents();
}

// ================================================================
// UI 反馈事件
// ================================================================
function registerUIEvents() {
    document.addEventListener(EVENTS.SHOW_TOAST, (e) => {
        showToast(e.detail.message, e.detail.type || 'info');
    });

    document.addEventListener('show-toast', (e) => {
        showToast(e.detail.message, e.detail.type || 'info');
    });

    document.addEventListener(EVENTS.SHOW_MAPPING_DIALOG, (e) => {
        showMappingDialog(e.detail);
    });

    document.addEventListener(EVENTS.SHOW_PROBLEM_INFO_DIALOG, (e) => {
        showProblemInfoDialog(e.detail);
    });

    document.addEventListener(EVENTS.SHOW_ANOMALIES_DIALOG, (e) => {
        const { anomalies, resolve } = e.detail || {};
        showOperationConfirmWithCountdown(anomalies, resolve);
    });

    // 打开账户面板：**动态 import** 与账户面板保持一致的做法（它自己也是动态加载的），
    // 这样导入模块不需要静态依赖账户 UI（避免 ui↔features 的环）。
    //
    // ⚠️ 账户的入口在设置页（「🔑 账户/名册」那栏），但**这一条用弹窗** ——
    //    它是在**导入流程中途**弹出来的（"有线索认不出 → 去补映射"），此时把人跳到
    //    另一个页签反而会甩掉当前上下文（导入弹窗还开着、盖在新页面上）。
    //    常规入口（工具栏 👤）走设置页，见 `ui/buttons.js`；两处是**同一份视图**
    //    （`mountAccountsView`），不是两套实现。
    document.addEventListener(EVENTS.SHOW_ACCOUNTS_DIALOG, async () => {
        const { showAccountsModal } = await import('./G_modal/G8_accounts.js');
        showAccountsModal();
    });
}

// ================================================================
// 树操作事件
// ================================================================
function registerTreeEvents() {
    // ---- 添加根节点 ----
    document.addEventListener(EVENTS.ADD_ROOT, async () => {
        const result = await promptAddRoot();
        if (result.success && result.node) {
            showToast('已添加' + (TYPE_LABEL_MAP[result.node.type] || '') + ': ' + result.node.name, 'success');
        } else if (result.error && result.error !== '用户取消' && result.error !== '用户取消选择类型') {
            showToast(result.error, 'error');
        }
    });

    // ---- 添加子节点 ----
    document.addEventListener(EVENTS.ADD_CHILD, async (e) => {
        const { parentId, quick } = e.detail || {};
        if (!parentId) { showToast('父节点 ID 缺失', 'error'); return; }
        const result = await promptAddChild(parentId, quick);
        if (result.success && result.node) {
            showToast('已添加' + (TYPE_LABEL_MAP[result.node.type] || '') + ': ' + result.node.name, 'success');
        } else if (result.error && result.error !== '用户取消' && result.error !== '用户取消选择类型') {
            showToast(result.error, 'error');
        }
    });

    // ---- 编辑节点 ----
    document.addEventListener(EVENTS.EDIT_NODE, async (e) => {
        const { nodeId } = e.detail || {};
        if (!nodeId) { showToast('节点 ID 缺失', 'error'); return; }
        const result = await editNode(nodeId);
        if (result.success) {
            showToast('节点已更新', 'success');
        } else if (result.error && result.error !== '用户取消') {
            showToast(result.error, 'error');
        }
    });

    document.addEventListener(EVENTS.EDIT_VNODE, async (e) => {
        const { pageId, vId } = e.detail || {};
        if (!pageId || !vId) { showToast('参数缺失', 'error'); return; }
        const result = await editVNode(pageId, vId);
        if (result.success) {
            showToast('副页节点已更新', 'success');
        } else if (result.error && result.error !== '用户取消') {
            showToast(result.error, 'error');
        }
    });
    // ---- 删除节点 ----
    document.addEventListener(EVENTS.DELETE_NODE, async (e) => {
        const { nodeId, isVirtual } = e.detail || {};
        if (!nodeId) { showToast('节点 ID 缺失', 'error'); return; }

        if (isVirtual) {
            let pageId = null;
            for (const pid in AppState.pages) {
                if (AppState.pages[pid].virtualIndex[nodeId]) { pageId = pid; break; }
            }
            if (!pageId) { showToast('虚拟节点不存在', 'error'); return; }
            try {
                await execute(
                    (draft) => {
                        deleteVirtualNodeOp(draft, nodeId, pageId);
                    },
                    {
                        validate: false,
                        refreshParentId: null,
                        onSuccess: () => {
                            showToast('已删除虚拟节点', 'success');
                            document.dispatchEvent(new CustomEvent(EVENTS.UI_REFRESH_REQUIRED));
                        },
                        onError: (err) => {
                            showToast('删除失败: ' + err.message, 'error');
                        }
                    }
                );
            } catch (_) {}
            return;
        }

        const parentId = AppState.parentOf[nodeId] ?? null;
        try {
            await execute(
                (draft) => {
                    const result = deleteNodeOp(draft, nodeId);
                    cleanDeletedRealNode(draft, result.idsToClean);
                },
                {
                    refreshParentId: parentId,
                    onSuccess: () => {
                        showToast('已删除节点', 'success');
                        resetFolderStateIfInvalid();
                        document.dispatchEvent(new CustomEvent(EVENTS.PAGE_TABS_REFRESH_REQUIRED));
                    },
                    onError: (err) => {
                        showToast(err.message || '删除失败', 'error');
                    }
                }
            );
        } catch (_) {}
    });

    // ---- 上移 ----
    document.addEventListener(EVENTS.MOVE_UP, async (e) => {
        const { nodeId } = e.detail || {};
        if (!nodeId) { showToast('节点 ID 缺失', 'error'); return; }
        const parentId = AppState.parentOf[nodeId] ?? null;
        try {
            await executePointUpdate(
                (draft) => { moveUpOp(draft, nodeId); },
                {
                    orderOnly: true,                       // 纯顺序改动：值不变、缓存接代（见 valueCaches.js）
                    refreshParentId: parentId,
                    onSuccess: () => {
                        showToast('上移成功', 'success');
                        document.dispatchEvent(new CustomEvent(EVENTS.UI_REFRESH_REQUIRED));
                    },
                    onError: (err) => showToast(err.message || '上移失败', 'error')
                }
            );
        } catch (_) {}
    });

    // ---- 下移 ----
    document.addEventListener(EVENTS.MOVE_DOWN, async (e) => {
        const { nodeId } = e.detail || {};
        if (!nodeId) { showToast('节点 ID 缺失', 'error'); return; }
        const parentId = AppState.parentOf[nodeId] ?? null;
        try {
            await executePointUpdate(
                (draft) => { moveDownOp(draft, nodeId); },
                {
                    orderOnly: true,                       // 纯顺序改动：值不变、缓存接代（见 valueCaches.js）
                    refreshParentId: parentId,
                    onSuccess: () => {
                        showToast('下移成功', 'success');
                        document.dispatchEvent(new CustomEvent(EVENTS.UI_REFRESH_REQUIRED));
                    },
                    onError: (err) => showToast(err.message || '下移失败', 'error')
                }
            );
        } catch (_) {}
    });

    // ---- 复制节点 ----
    document.addEventListener(EVENTS.COPY_NODE, async (e) => {
        const { sourceId, resolve } = e.detail || {};
        if (!sourceId) {
            if (resolve) resolve({ success: false, error: '源节点 ID 缺失' });
            return;
        }
        const sourceNode = AppState.nodes[sourceId];
        if (!sourceNode) {
            if (resolve) resolve({ success: false, error: '源节点不存在' });
            return;
        }
        const sourceName = sourceNode.name || sourceNode.time || '未命名';
        const sourceType = sourceNode.type;

        const descendants = new Set();
        (function collect(id) {
            descendants.add(id);
            for (const cid of AppState.childOrder[id]) collect(cid);
        })(sourceId);

        const root = AppState.nodes[AppState.rootId];
        if (!root) {
            if (resolve) resolve({ success: false, error: '树未初始化' });
            return;
        }

        const isDisabled = (node) => {
            if (node.id === sourceId) return true;
            if (descendants.has(node.id)) return true;
            const allowed = TYPE_CHILDREN_MAP[node.type] || [];
            return !allowed.includes(sourceType);
        };
        const filter = (node) => node.type !== 'R';

        showTreeSelector(AppState, {
            title: `复制节点「${sourceName}」到...`,
            rootNode: root,
            filter,
            isDisabled,
            onConfirm: async (targetId) => {
                try {
                    await execute(
                        (draft) => { copyNodeOp(draft, sourceId, targetId); },
                        {
                            refreshParentId: targetId,
                            onSuccess: () => {
                                showToast('节点复制成功', 'success');
                                if (resolve) resolve({ success: true });
                                document.dispatchEvent(new CustomEvent(EVENTS.UI_REFRESH_REQUIRED));
                            },
                            onError: (err) => {
                                showToast(err.message || '复制失败', 'error');
                                if (resolve) resolve({ success: false, error: err.message });
                            }
                        }
                    );
                } catch (err) {
                    if (resolve) resolve({ success: false, error: err.message });
                }
            },
            onCancel: () => {
                if (resolve) resolve({ success: false, error: '用户取消' });
            }
        });
    });
}

// ================================================================
// 批量导入事件
// ================================================================
function registerBatchEvents() {
    document.addEventListener(EVENTS.BATCH_IMPORT, (e) => {
        batchImport(e.detail?.parentId);
    });
    document.addEventListener(EVENTS.BATCH_SUBMIT_IMPORT, (e) => {
        batchImportSubmissions(e.detail?.parentId);
    });
    document.addEventListener(EVENTS.BATCH_CONTEST_IMPORT, (e) => {
        batchImportContests(e.detail?.parentId);
    });
    document.addEventListener(EVENTS.BATCH_PROBLEM_INFO, (e) => {
        batchImportProblemInfo(e.detail?.parentId);
    });
}

// ================================================================
// 排序事件（作用在一棵子树上：C / W / S / O 都从这两个入口进来）
// ================================================================
function registerSortEvents() {
    document.addEventListener(EVENTS.SORT_PROBLEMS, (e) => {
        sortProblems(e.detail?.nodeId, e.detail?.sortKey);
    });
    document.addEventListener(EVENTS.SORT_SUBMISSIONS, (e) => {
        sortSubmissions(e.detail?.nodeId, e.detail?.direction);
    });
}

// ================================================================
// 页面事件
// ================================================================
function registerPageEvents() {
    document.addEventListener(EVENTS.PAGE_DATA_CHANGED, () => {
        renderPageTabs();
        document.dispatchEvent(new CustomEvent(EVENTS.UI_REFRESH_REQUIRED));
    });

    document.addEventListener(EVENTS.PAGE_TABS_REFRESH_REQUIRED, () => {
        renderPageTabs();
    });

    document.addEventListener(EVENTS.CURRENT_PAGE_REFRESH_REQUIRED, () => {
        document.dispatchEvent(new CustomEvent(EVENTS.UI_REFRESH_REQUIRED));
    });

    document.addEventListener(EVENTS.SWITCH_PAGE, async (e) => {
        const { pageId } = e.detail || {};
        if (pageId === undefined) return;
        // 诊断（2026-10-18，用户测得"click 767ms，而 refreshCurrentPage 里只占 ~120ms"）：
        //   把**事务**、**重画**、**页签**三段分开打。⚠️ 纯日志；开关在 `utils/diag.js` 一处。
        const t0 = nowMs();
        const lap = (name) => diag('切页·事务', `${name} = ${msSince(t0)}ms（累计）`);
        try {
            await execute(
                (draft) => {
                    if (pageId === 'main') {
                        draft.currentPageId = 'main';
                    } else if (draft.pages[pageId]) {
                        draft.currentPageId = pageId;
                    } else {
                        draft.currentPageId = 'main';
                    }
                },
                {
                    validate: false,
                    refreshParentId: null,
                    // ★ **切页不用重算副页统计**（2026-10-18 实测定位）：`shell/executor.js` 的事务包装
                    //   在 produce 回调**内部**跑 `refreshAllVirtualStats(draft)`，副页 3000+ vNode 每次
                    //   全量重算 ⇒ 被算进 `[事务] produce`（切页实测 222–232ms，而 bench 里"只改 meta" 只有 1ms）。
                    //   切页只改 `currentPageId`、不动任何节点 ⇒ 跳过它是安全的。
                    skipVirtualStats: true,
                    onSuccess: () => {
                        lap('execute 完成');
                        // ★ **渲染已经做过了，别再画一遍**（2026-10-18 实测）：
                        //   事务的默认 refreshFn 会派发 `UI_REFRESH_REQUIRED`，而那条监听
                        //   （本文件 :429）**已经**调了 `refreshCurrentPage()` + `renderPageTabs()`。
                        //   这里原来又调一遍 ⇒ 每次切页**整页画两次**（副页 3000 节点实测：
                        //   第一次 ~156ms、第二次又 ~113ms，页签再 36ms）。删掉这两句即省一半。
                        //   ⚠️ 别在调用点自己派发 `UI_REFRESH_REQUIRED`（`shell/executor.js` 的注释也这么写）。
                        lap('onSuccess（不重画）完成');
                    },
                    onError: (err) => {
                        showToast('切换副页失败: ' + err.message, 'error');
                    }
                }
            );
            lap('整条事件结束');
        } catch (_) {}
    });
}

// ================================================================
// 持久化事件
// ================================================================
function registerPersistenceEvents() {
    document.addEventListener(EVENTS.DB_MODIFIED, () => {
        markStatsDirty();
        markSizeDirty();
        updateInfoBar(AppState);
        resetFolderStateIfInvalid();
        renderAccountChip();
    });

    document.addEventListener(EVENTS.DB_SAVED, () => {
        markSizeDirty();
        updateInfoBar(AppState);
        renderAccountChip();
    });

    document.addEventListener(EVENTS.JSON_SAVED, () => {
        updateInfoBar(AppState);
    });

    document.addEventListener(EVENTS.UI_REFRESH_REQUIRED, (e) => {
        refreshCurrentPage(e && e.detail ? e.detail : {});
        renderPageTabs();
        // 顶栏账户标记也在这里兜一次：从磁盘加载完（initApp）走的是这条事件，
        // 而不是 DB_MODIFIED —— 漏了的话刷新后标记会停在默认值。
        renderAccountChip();
    });

    document.addEventListener(EVENTS.EXPORT_FULL, () => {
        exportFullJSON(AppState);
    });

    document.addEventListener(EVENTS.AUTO_EXPORT_TRIGGERED, () => {
        exportFullJSON(AppState, true).catch(err => {
            console.error('❌ 定时自动导出失败:', err);
        });
    });
}