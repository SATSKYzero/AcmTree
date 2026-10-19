// ================================================================
// 事件委托与快捷键绑定（ui/G_events.js）
// 职责：树节点按钮事件、快捷键、全局按钮
// 依赖：shell/state.js, shell/executor.js, core/ops/*,
//       A_constants.js, utils/A_helpers.js,
//       G_modal/G_modals.js, G_pageUI.js,
//       I_folderMode.js
// ================================================================
import { AppState } from '../shell/state.js';
import { execute } from '../shell/executor.js';
import {
    deleteNode as deleteNodeOp,
    clearProblems as clearProblemsOp,
    clearSubmissions as clearSubmissionsOp
} from '../core/ops/tree.js';
import {
    deleteVirtualNode as deleteVirtualNodeOp,
    moveVirtualNode as moveVirtualNodeOp,
    setVNodeBlocked as setVNodeBlockedOp,
    cleanDeletedRealNode,
    locateVirtualNode as locateVirtualNodeIn
} from '../core/ops/page.js';
import {
    toggleNodeExpanded as toggleNodeExpandedOp,
    setNodeCurrentPage,
    toggleNodeSelected as toggleNodeSelectedOp,
    flipChildrenSelection,
    clearSelectionInScope,
    toggleVirtualNodeExpanded as toggleVirtualNodeExpandedOp,
    setVirtualNodeCurrentPage,
    toggleVirtualNodeSelected as toggleVirtualNodeSelectedOp,
    flipVirtualChildrenSelection
} from '../core/ops/view.js';
import { fullAutoUpdate } from '../core/autoCompute.js';
import { EVENTS } from '../A_constants.js';
import { emit } from '../utils/A_helpers.js';
import { scheduleViewSave, pageOf } from '../core/model/viewState.js';
import {
    showToast,
    showDeleteConfirm,
    showMoreActions,
    showEditTargetSelector,
    showInfoTargetSelector
} from './G_modal/G_modals.js';
import { refreshCurrentPage, renderPageTabs } from './G_pageUI.js';
import { getTreeDisplayMode, getEditMode, folderCurrentPage, setFolderCurrentPage, goToRootFolder } from './folder/folderMode.js';
import { openNodeInfoTab } from './tabs.js';

const pressedKeys = new Set();

// ================================================================
// 内部辅助
// ================================================================

// ---- 判断节点是否虚拟；是则返回 { pageId, vNode } ----
// 实现在 `core/ops/page.js`（**唯一一处**）：`ui/tabs.js` 开节点信息界面时也要用同一支，
// 各写一份就会出现"有的地方解析了 `_refId`、有的没解析"。
const locateVirtualNode = (id) => locateVirtualNodeIn(AppState, id);

// ---- 读取每页节点数 ----
function getNodePerPage() {
    const v = AppState.settings.display.nodePerPage;
    return (v && v > 0) ? v : 20;
}

// ================================================================
// 全选/取消全选（清空当前页范围选中状态）
// ================================================================
async function clearAllSelection() {
    const pageId = AppState.currentPageId;
    const isVirtual = pageId !== 'main';

    // 收集当前页面所有非 O 节点 id
    let allIds = [];
    if (isVirtual) {
        const page = AppState.pages[pageId];
        if (!page) { showToast('副页不存在', 'error'); return; }
        for (const vId in page.virtualIndex) {
            if (page.virtualIndex[vId].type !== 'O') allIds.push(vId);
        }
    } else {
        for (const nid in AppState.nodes) {
            if (AppState.nodes[nid].type !== 'O') allIds.push(nid);
        }
    }

    if (allIds.length === 0) {
        showToast('没有可操作的节点', 'info');
        return;
    }

    // 检查是否已全部未选中
    const alreadyCleared = allIds.every(id => {
        if (isVirtual) {
            return !AppState.pages[pageId].virtualIndex[id].selected;
        }
        return !AppState.nodes[id].selected;
    });
    if (alreadyCleared) {
        showToast('所有节点已处于未选中状态', 'info');
        return;
    }

    try {
        await execute(
            (draft) => {
                if (isVirtual) {
                    clearSelectionInScope(draft, pageId);
                } else {
                    clearSelectionInScope(draft, 'main');
                }
                return { count: allIds.length };
            },
            {
                validate: false,
                refreshParentId: null,
                onSuccess: (result) => {
                    document.dispatchEvent(new CustomEvent(EVENTS.UI_REFRESH_REQUIRED));
                    showToast(`已清空 ${result.count} 个节点的选中状态`, 'success');
                },
                onError: (err) => {
                    showToast('清空失败: ' + err.message, 'error');
                }
            }
        );
    } catch (_) {}
}

// ================================================================
// 展开/折叠
// ================================================================
async function toggleNodeExpanded(id) {
    const vInfo = locateVirtualNode(id);
    const isVirtual = !!vInfo;

    try {
        await execute(
            (draft) => {
                if (isVirtual) {
                    toggleVirtualNodeExpandedOp(draft, id, vInfo.pageId);
                } else {
                    toggleNodeExpandedOp(draft, id);
                }
            },
            {
                validate: !isVirtual,
                refreshParentId: null,
                // 折叠状态**只进本地缓存** —— 不进快照（所以不建
                // 历史步：一次折叠一次快照，正是"折叠有些慢"的来源之一），也不进导出包。
                // 探针（scripts/fold-bench.mjs）实测：这两处是纯浪费：
                //   · `skipVirtualStats`：折叠只改"看的姿势"，副页统计不可能变（否则每次事务
                //     都要在 immer draft 里重算 ≈17ms）；
                //   · **不重复派发** `UI_REFRESH_REQUIRED` —— `execute` 的 refreshFn 已经
                //     派发过同语义的一次，这里再派发就是"整条刷新链跑两遍"（渲染 ~18ms×2）。
                skipHistory: true,
                skipVirtualStats: true,
                skipPersist: true,
                // 刷新由 `execute` 的默认 refreshFn 派发（**不在这里再派一次** —— 那才是"刷新跑两遍"）。
                onSuccess: () => {
                    scheduleViewSave(AppState);      // 合并写入（连点折叠只落盘一次）
                    if (isVirtual) {
                        // 刷新已由 execute 的 refreshFn 派发的事件触发，这里不手动重画
                    } else {
                        document.dispatchEvent(new CustomEvent('expanded-count-updated'));
                    }
                },
                onError: (err) => {
                    if (err.message !== '节点不存在' && err.message !== '虚拟节点不存在') {
                        showToast(err.message || '操作失败', 'error');
                    }
                }
            }
        );
    } catch (_) {}
}

// ================================================================
// 翻页
// ================================================================
async function handlePageChange(nodeId, delta) {
    const mode = getTreeDisplayMode();
    const pageId = AppState.currentPageId;
    const isVirtualPage = pageId !== 'main';

    // ---- 主页文件夹模式 ----
    if (!isVirtualPage && mode === 'folder') {
        const newPage = folderCurrentPage + delta;
        if (newPage >= 1) {
            setFolderCurrentPage(newPage);
        }
        return;
    }

    // ---- 副页文件夹模式 ----
    if (isVirtualPage && mode === 'folder') {
        // 副页文件夹模式的翻页状态在 I_virtualFolderMode.js 管理
        // 通过 UI_REFRESH_REQUIRED 触发对应模块自行处理
        document.dispatchEvent(new CustomEvent(EVENTS.FOLDER_PAGE_CHANGE, {
            detail: { pageId, delta }
        }));
        return;
    }

    // ---- 树形模式 ----
    const vInfo = locateVirtualNode(nodeId);
    if (vInfo) {
        try {
            await execute(
                (draft) => {
                    const vNode = draft.pages[vInfo.pageId].virtualIndex[nodeId];
                    if (!vNode) throw new Error('虚拟节点不存在');
                    const nodePerPage = getNodePerPage();
                    const total = vNode.children ? vNode.children.length : 0;
                    const pageCount = Math.ceil(total / nodePerPage) || 1;
                    let newPage = (vNode.currentPage || 1) + delta;
                    if (newPage < 1) newPage = 1;
                    if (newPage > pageCount) newPage = pageCount;
                    if (vNode.currentPage === newPage) {
                        throw new Error('PAGE_UNCHANGED');
                    }
                    setVirtualNodeCurrentPage(draft, nodeId, vInfo.pageId, newPage);
                },
                {
                    validate: false,
                    refreshParentId: null,
                    onSuccess: () => refreshCurrentPage(),
                    onError: (err) => {
                        if (err.message !== 'PAGE_UNCHANGED' && err.message !== '虚拟节点不存在') {
                            showToast(err.message || '翻页失败', 'error');
                        }
                    }
                }
            );
        } catch (_) {}
        return;
    }

    // ---- 主树真实节点翻页 ----
    const node = AppState.nodes[nodeId];
    if (!node) {
        showToast('节点不存在', 'error');
        return;
    }

    const nodePerPage = getNodePerPage();
    const childIds = AppState.childOrder[nodeId] || [];
    const total = childIds.length;
    const pageCount = Math.ceil(total / nodePerPage) || 1;
    let newPage = pageOf(AppState, nodeId) + delta;
    if (newPage < 1) newPage = 1;
    if (newPage > pageCount) newPage = pageCount;
    if (pageOf(AppState, nodeId) === newPage) return;

    try {
        await execute(
            (draft) => {
                setNodeCurrentPage(draft, nodeId, newPage);
            },
            {
                validate: false,
                refreshParentId: null,
                onSuccess: () => {
                    import('../view/tree.js').then(({ updateNode }) => {
                        updateNode(AppState, nodeId);
                    });
                    document.dispatchEvent(new CustomEvent('expanded-count-updated'));
                },
                onError: (err) => {
                    if (err.message !== '节点不存在') {
                        showToast(err.message || '翻页失败', 'error');
                    }
                }
            }
        );
    } catch (_) {}
}

// ================================================================
// 虚拟节点移动
// ================================================================
async function moveVirtualNodeWithExecute(id, direction) {
    const vInfo = locateVirtualNode(id);
    if (!vInfo) {
        showToast('虚拟节点不存在', 'error');
        return;
    }
    try {
        await execute(
            (draft) => {
                moveVirtualNodeOp(draft, id, direction, vInfo.pageId);
            },
            {
                validate: false,
                refreshParentId: null,
                onSuccess: () => {
                    renderPageTabs();
                    const pageId = AppState.currentPageId;
                    if (pageId !== 'main') {
                        refreshCurrentPage();
                    } else {
                        document.dispatchEvent(new CustomEvent(EVENTS.UI_REFRESH_REQUIRED, { detail: { parentId: null } }));
                    }
                    showToast(`${direction === 'up' ? '上' : '下'}移成功`, 'success');
                },
                onError: (err) => {
                    showToast(err.message || '移动失败', 'error');
                }
            }
        );
    } catch (_) {}
}

// ================================================================
// 副页节点：屏蔽 / 取消屏蔽
//
// 语义（`docs/subpage-sync.md`）：**「与主树对齐」走到屏蔽的节点就不再往下递归** ——
// 这一支已有的内容**不增不减**。它与"从副页移除"是两件事：那个是删，这个是"不再长"。
// ================================================================
async function toggleVNodeBlockedWithExecute(id) {
    const vInfo = locateVirtualNode(id);
    if (!vInfo) {
        showToast('虚拟节点不存在', 'error');
        return;
    }
    const on = !vInfo.vNode.syncBlocked;
    try {
        await execute(
            (draft) => {
                setVNodeBlockedOp(draft, vInfo.pageId, id, on);
            },
            {
                validate: false,
                refreshParentId: null,
                onSuccess: () => {
                    renderPageTabs();
                    const pageId = AppState.currentPageId;
                    if (pageId !== 'main') {
                        refreshCurrentPage();
                    } else {
                        document.dispatchEvent(new CustomEvent(EVENTS.UI_REFRESH_REQUIRED, { detail: { parentId: null } }));
                    }
                    showToast(on ? '已屏蔽：对齐时不再往下递归' : '已取消屏蔽', 'success');
                },
                onError: (err) => {
                    showToast(err.message || '屏蔽失败', 'error');
                }
            }
        );
    } catch (_) {}
}

// ================================================================
// 事件委托
// ================================================================// 「📋 打开详页」的**文档级**委托
//
// 这一条是 `📋 btn-node-info[data-id]` 的**唯一入口**（`docs/node-navigation.md` §5.2）。
//
// ⚠️ 排除的是**树方框自己那颗**（`.node-box` 里的）—— 它由 `#tree-container` 上的
//    `onActionClick` 接住，而那条会 `stopPropagation`（所以这里**不会重复开两个页**）。
//
//    ⚠️ **别把排除写宽成"在 `#tree-container` 里就跳过"**（`v9.0.15` 修的真病根）：
//    插件把自己的页挂在 `#tree-container` 里（folder 视图宿主就是这么挂的），
//    那样一来它们行上的 `.btn-node-info` 就被这条**拒收**、只能靠容器上那条接 ——
//    而容器上那条认的是**逗号选择器** `.btn-icon, .toggle-btn, .pagination-btn`，
//    DOM 桩（`scripts/smoke/dom.mjs`）**不解析逗号选择器** ⇒ 那条路径在 CI 里恒为空转、
//    连"点了有没有反应"都测不到。症状就是"面板里的 🔎/📋 点了没反应"，且**没有任何断言会红**。
//    `features/AutoImport/extKeyPanel.js`（补身份键清单表）就是这么踩的。
// ⚠️ 只注册一次：`setupEventDelegation()` 在测试/冒烟里可能被调多次。
//
// ★ **按住 Ctrl 点 = 新开一个详页页签，但当前页不变**（`v9.0.18`，用户拍板：
//   "别中键，就 Ctrl"，语义照浏览器）。判据**只在这一条委托内部**加 ——
//   `Ctrl` 在树上已经被"多选 / 编辑 / 显示 nature"占用，**不许全局劫持**
//   （见 `setupShortcuts` 与 `folderMode.folderClickHandler`），
//   而这条只管 `.btn-node-info`（📋）那一颗，碰不到别的。
// ⚠️ 树方框自己那颗 📋 **也**要认 Ctrl：它在下面那条 `onActionClick` 里被
//   `stopPropagation` 拦下、根本到不了这里 —— 所以同一个 `e.ctrlKey` 分支
//   在那条里也写了一遍（两条都是**既有的**委托，没有新增监听）。
// ================================================================
let nodeInfoDelegateInstalled = false;
function installNodeInfoDelegate() {
    if (nodeInfoDelegateInstalled) return;
    nodeInfoDelegateInstalled = true;
    document.addEventListener('click', (e) => {
        const btn = e.target && typeof e.target.closest === 'function'
            ? e.target.closest('.btn-node-info') : null;
        // 只让"树方框自己那颗"给容器上那条（`onActionClick` 会 stopPropagation）
        if (!btn || (btn.closest && btn.closest('.node-box'))) return;
        e.preventDefault();
        openInfoFromButton(btn, !e.ctrlKey);
    });
}

// ================================================================
// 「📋」那一颗点下去干什么 —— **只有这一份**（两条既有委托都转发到它）
//
// 为什么要有它：📋 有**两个落点形状**，各有各的委托（管的 DOM 区域不同，两条都得留着）：
//   · **树方框里那一颗** ⇒ `#tree-container` / `#folder-stats` 上的 `onActionClick`
//     （它会 `stopPropagation`，不会重复开）；
//   · **其它地方**（AC 列表 / 记录表 / **副页统计的明细行入口条** …）⇒ `document` 上那条。
// 但"点下去做什么"必须**只有一套**：副页节点（带 `data-vid`）先弹"看哪个"选择器，
// 再由它 `openNodeInfoTab(..., { asVirtual, pageId })`；否则直接开那个节点。
//
// ⚠️ **别把这段在两条委托里各抄一遍**：`v9.0.18` 的 Ctrl 语义之所以没变成全局劫持，
//    靠的就是"只在接 📋 的这两条既有委托内部判 + 一套实现"；抄两份 ⇒ 下次改语义必只改一处。
// ⚠️ 入口条（`ui/kit/nodeEntry.js`）那颗副页 📋 就是靠这里认 `data-vid` 的 —— 它住在
//    节点详页的 `.tab-content` 里（**不在** `#tree-container`），只能由这条文档级委托接住。
// ================================================================
function openInfoFromButton(btn, activate = true) {
    const vId = String(btn.dataset.vid || '');
    if (vId) {
        const refId = btn.dataset.id && btn.dataset.id !== vId ? btn.dataset.id : '';
        const pageId = btn.dataset.pageId || AppState.currentPageId;
        showInfoTargetSelector({
            pageId,
            vId,
            refId,
            isRoot: !refId,
            onPick: target => {
                if (target === 'real' && refId) openNodeInfoTab(refId, { activate });
                else openNodeInfoTab(vId, { asVirtual: true, pageId });
            }
        });
        return;
    }
    const id = String(btn.dataset.id || '').trim();
    if (id) openNodeInfoTab(id, { activate });
}

// ================================================================
// ================================================================
// 「节点方框上那排按钮」的委托**可以挂到任意容器上**（`v9.1.27`）
//
// 为什么要有这个口子：`onActionClick` 只认**自己挂的那个根**，而"画节点方框的地方"
// 不止 `#tree-container` —— 已经踩过两次：
//   · `#folder-stats`（文件夹模式"当前节点"那一格，在 `#tree-container` **之外**）；
//   · **节点详页**（`ui/nodeinfo/nodeInfoView.js` 的 `ni-body-<s>`，子节点那一栏与头部那格
//     都是 `renderNode` 出来的 `.node-box`）—— 用户 2026-10-13 实测：
//     "节点详页子节点的各按钮点不了了"（📋/✏️/➕/⚙️/⬆/⬇ 全都没反应）。
// ⚠️ **为什么不能只挂 `document`**：`onActionClick` 的各个分支**不是全都** `stopPropagation`，
//   两条路径都活着就会"开两个弹窗"；而容器级这条与 `#tree-container` 那条是天然互斥的
//   （一次点击只经过一条链）⇒ 挂容器才是对的做法。
// ⚠️ 幂等：靠 `root.dataset.delegated`（`setupEventDelegation` 与详页各调一次，谁先谁生效）。
// ================================================================
let actionDelegate = null;

/** 把一个容器接上"方框按钮"的委托（幂等；返回是否已接上） */
export function bindActionDelegation(root) {
    if (!root || !actionDelegate) return false;
    if (root.dataset && root.dataset.delegated) return true;
    if (root.dataset) root.dataset.delegated = '1';
    root.addEventListener('click', actionDelegate);
    return true;
}

export function setupEventDelegation() {
    installNodeInfoDelegate();
    const container = document.getElementById('tree-container');
    if (!container) return;

    // ---- 按钮点击 ----
    // ⚠️ 这条（与下面那条）除了 `#tree-container`，还要挂到 **`#folder-stats`** 上 ——
    //    文件夹模式"当前节点"那一格住在那里（`#tree-container` **之外**）。见本函数末尾。
    const onActionClick = function (e) {
        const target = e.target.closest('[data-id]');
        if (!target) return;
        const id = target.dataset.id;
        if (!id) return;

        // ⚠️ **分开写三次 `closest`**，别用逗号选择器：DOM 桩（`scripts/smoke/dom.mjs`）不解析
        //    逗号选择器 ⇒ 合写时这条委托在冒烟里**永远返回 null**，"点了没反应"那类 bug 抓不到。
        //    同一条规矩 `ui/G_pageUI.js` 那三颗小按钮上写着（`docs/ui-conventions.md` §8）。
        const actionBtn = target.closest('.btn-icon') || target.closest('.toggle-btn')
            || target.closest('.pagination-btn');
        if (!actionBtn) return;

        // ---- 展开/折叠 ----
        if (actionBtn.classList.contains('toggle-btn')) {
            e.stopPropagation();
            toggleNodeExpanded(id);
            return;
        }

        // ---- 选中状态切换 ----
        if (actionBtn.classList.contains('btn-select-toggle')) {
            e.stopPropagation();
            const vInfo = locateVirtualNode(id);
            const isVirtual = !!vInfo;
            try {
                execute(
                    (draft) => {
                        if (isVirtual) {
                            toggleVirtualNodeSelectedOp(draft, id, vInfo.pageId);
                        } else {
                            toggleNodeSelectedOp(draft, id);
                        }
                    },
                    {
                        validate: false,
                        refreshParentId: null,
                        onSuccess: () => {
                            document.dispatchEvent(new CustomEvent(EVENTS.UI_REFRESH_REQUIRED));
                        },
                        onError: (err) => {
                            showToast('切换选中失败: ' + err.message, 'error');
                        }
                    }
                ).catch(() => {});
            } catch (_) {}
            return;
        }

        // ---- 翻转直接子节点选中 ----
        if (actionBtn.classList.contains('btn-toggle-children')) {
            e.stopPropagation();
            const vInfo = locateVirtualNode(id);
            const isVirtual = !!vInfo;
            if (isVirtual) {
                const vNode = vInfo.vNode;
                if (!vNode.children || vNode.children.length === 0) {
                    showToast('该节点没有直接子节点', 'info');
                    return;
                }
            } else {
                const node = AppState.nodes[id];
                if (!node) {
                    showToast('节点不存在', 'error');
                    return;
                }
                const childIds = AppState.childOrder[id] || [];
                if (childIds.length === 0) {
                    showToast('该节点没有直接子节点', 'info');
                    return;
                }
            }
            try {
                execute(
                    (draft) => {
                        if (isVirtual) {
                            flipVirtualChildrenSelection(draft, id, vInfo.pageId);
                        } else {
                            flipChildrenSelection(draft, id);
                        }
                    },
                    {
                        validate: false,
                        refreshParentId: null,
                        onSuccess: () => {
                            document.dispatchEvent(new CustomEvent(EVENTS.UI_REFRESH_REQUIRED));
                        },
                        onError: (err) => {
                            if (err.message !== '无子节点') {
                                showToast('操作失败: ' + err.message, 'error');
                            }
                        }
                    }
                ).catch(() => {});
            } catch (_) {}
            return;
        }

        // ---- 翻页 ----
        if (actionBtn.classList.contains('pagination-prev') || actionBtn.classList.contains('pagination-next')) {
            e.stopPropagation();
            const nodeId = actionBtn.dataset.id;
            if (!nodeId) return;
            const isPrev = actionBtn.classList.contains('pagination-prev');
            handlePageChange(nodeId, isPrev ? -1 : 1);
            return;
        }

        // ---- 详细节点信息（开一个**独立的"节点信息"界面**：与现有页面并存，可同时开多个）----
        // 它是"第三类 tab"（见 ui/tabs.js）—— 开关它**不影响**现有任何页的状态。
        // ★ 按住 Ctrl ⇒ **开而不激活**（当前页不变；语义照浏览器，见上面那条委托的说明）。
        //   ⚠️ 副页节点那条（`data-vid`）走的是"看哪个"选择器，选择器本身没有
        //   "激活 / 不激活"这个概念 ⇒ 只有 `refId` 直接命中那一支带 Ctrl 语义
        //   （如实记在 `docs/node-navigation.md` 的残余里，没装作两支一样）。
        if (actionBtn.classList.contains('btn-node-info')) {
            e.stopPropagation();
            // 与文档级那条**同一份实现**（`openInfoFromButton`）：副页 `data-vid` ⇒ 先弹"看哪个"。
            openInfoFromButton(actionBtn, !e.ctrlKey);
            return;
        }

        // ---- 编辑 ----
        if (actionBtn.classList.contains('btn-edit')) {
            e.stopPropagation();
            if (AppState.currentPageId !== 'main') {
                showToast('请在主页编辑节点', 'info');
                return;
            }
            document.dispatchEvent(new CustomEvent(EVENTS.EDIT_NODE, { detail: { nodeId: id } }));
            return;
        }

        // ---- 添加子节点 ----
        if (actionBtn.classList.contains('btn-add-child')) {
            e.stopPropagation();
            if (AppState.currentPageId !== 'main') {
                showToast('副页不支持添加子节点', 'info');
                return;
            }
            document.dispatchEvent(new CustomEvent(EVENTS.ADD_CHILD, {
                detail: { parentId: id, quick: !!e.ctrlKey }
            }));
            return;
        }

        // ---- 更多操作 ----
        if (actionBtn.classList.contains('btn-more')) {
            e.stopPropagation();
            if (AppState.currentPageId !== 'main') {
                showToast('副页不支持更多操作', 'info');
                return;
            }
            showMoreActions(id);
            return;
        }

        // ---- 删除 ----
        if (actionBtn.classList.contains('btn-delete')) {
            e.stopPropagation();
            const vInfo = locateVirtualNode(id);
            const isVirtual = !!vInfo;

            // 强制删除（A+Q）
            if (pressedKeys.has('a') && pressedKeys.has('q')) {
                document.dispatchEvent(new CustomEvent(EVENTS.DELETE_NODE, {
                    detail: { nodeId: id, isVirtual, force: true }
                }));
                return;
            }

            const isCtrlPressed = pressedKeys.has('Control') || pressedKeys.has('Meta');
            if (!isCtrlPressed) {
                showToast('请按住 Ctrl 键再执行删除操作', 'error');
                return;
            }

            let name;
            if (isVirtual) {
                const realNode = vInfo.vNode.refId ? AppState.nodes[vInfo.vNode.refId] : null;
                name = realNode ? (realNode.name || realNode.problemId || '未命名') : '虚拟节点';
            } else {
                const node = AppState.nodes[id];
                if (!node) { showToast('节点不存在', 'error'); return; }
                name = node.name || node.time || '未命名';
            }

            showDeleteConfirm(
                '删除节点',
                `确定要删除「${name}」及其所有子节点吗？`,
                (confirmed) => {
                    if (!confirmed) return;
                    document.dispatchEvent(new CustomEvent(EVENTS.DELETE_NODE, {
                        detail: { nodeId: id, isVirtual, force: false }
                    }));
                }
            );
            return;
        }

        // ---- 屏蔽 / 取消屏蔽（只对副页节点）----
        if (actionBtn.classList.contains('btn-toggle-blocked')) {
            e.stopPropagation();
            toggleVNodeBlockedWithExecute(id);
            return;
        }

        // ---- 上移 ----
        if (actionBtn.classList.contains('btn-move-up')) {
            e.stopPropagation();
            const vInfo = locateVirtualNode(id);
            if (vInfo) {
                moveVirtualNodeWithExecute(id, 'up');
            } else {
                document.dispatchEvent(new CustomEvent(EVENTS.MOVE_UP, { detail: { nodeId: id } }));
            }
            return;
        }

        // ---- 下移 ----
        if (actionBtn.classList.contains('btn-move-down')) {
            e.stopPropagation();
            const vInfo = locateVirtualNode(id);
            if (vInfo) {
                moveVirtualNodeWithExecute(id, 'down');
            } else {
                document.dispatchEvent(new CustomEvent(EVENTS.MOVE_DOWN, { detail: { nodeId: id } }));
            }
            return;
        }
    };

    // ---- 双击编辑（树模式）/ Ctrl+单击编辑（文件夹模式） ----
    let lastClickTime = 0;
    let clickTimer = null;
    const onBoxClick = function (e) {
        if (e.target.closest('.btn-icon, .toggle-btn, .pagination-btn')) return;
        const box = e.target.closest('.node-box');
        if (!box) return;
        const id = box.dataset.id;
        if (!id) return;

        const mode = getTreeDisplayMode();

        // 文件夹模式：Ctrl+单击编辑
        if (mode === 'folder' && e.ctrlKey) {
            e.stopPropagation();
            const editMode = getEditMode();
            if (editMode === 'selection') {
                lastClickTime = 0;
                clearTimeout(clickTimer);
                clickTimer = null;
                return;
            }
            const vInfo = locateVirtualNode(id);
            if (vInfo) {
                showEditTargetSelector(vInfo.pageId, id);
            } else {
                document.dispatchEvent(new CustomEvent(EVENTS.EDIT_NODE, { detail: { nodeId: id } }));
            }
            lastClickTime = 0;
            clearTimeout(clickTimer);
            clickTimer = null;
            return;
        }

        // 树模式：双击编辑
        if (mode === 'tree') {
            const now = Date.now();
            if (now - lastClickTime <= 350) {
                const editMode = getEditMode();
                if (editMode === 'selection') {
                    lastClickTime = 0;
                    clearTimeout(clickTimer);
                    clickTimer = null;
                    return;
                }
                const vInfo = locateVirtualNode(id);
                if (vInfo) {
                    showEditTargetSelector(vInfo.pageId, id);
                } else {
                    document.dispatchEvent(new CustomEvent(EVENTS.EDIT_NODE, { detail: { nodeId: id } }));
                }
                lastClickTime = 0;
                clearTimeout(clickTimer);
                clickTimer = null;
            } else {
                lastClickTime = now;
                clearTimeout(clickTimer);
                clickTimer = setTimeout(() => {
                    lastClickTime = 0;
                    clickTimer = null;
                }, 400);
            }
        }
    };

    // ---- 把上面两条委托挂到该挂的容器上 ----
    // ★ **`#folder-stats` 那一格（文件夹模式"当前节点"）也要接**：它在 `#tree-container`
    //   **之外**，而按钮/快捷键全靠这两条委托 ⇒ 不补这一条，那一格上的 📋/✏️/➕/⚙️/✖
    //   点了没反应（以前那一格用 `folder-header` 模式渲染、根本不画按钮，所以没人发现）。
    // ⚠️ **单击不会"进文件夹"**：那件事的处理器只挂在 `#tree-body` 上
    //   （`ui/folder/folderMode.js` 的 `setupFolderClickEvents`）—— 这一格点了什么都不会发生。
    // ⚠️ 只挂一次：`setupEventDelegation()` 在测试/冒烟里可能被调多次。
    const clickRoots = [container];
    const headerBox = document.getElementById('folder-stats');
    if (headerBox && !headerBox.dataset.delegated) {
        headerBox.dataset.delegated = '1';
        clickRoots.push(headerBox);
    }
    // ★ 供**节点详页**那种"自己一套容器"的地方复用（见上面 `bindActionDelegation` 的说明）
    actionDelegate = onActionClick;
    for (const root of clickRoots) {
        root.addEventListener('click', onActionClick);
        root.addEventListener('click', onBoxClick);
    }
    // ⚠️ 详页的容器是**懒建**的（`tabs.js:ensureTabContent`）⇒ 启动时还不存在；
    //    那一侧自己在 `renderNodeInfoPanel` 里调 `bindActionDelegation`。
    //    这里顺手把"已经在文档里的"也接上（热重载 / 测试里可能先建好了）。
    for (const el of document.querySelectorAll('[id^="tab-nodeinfo"]')) bindActionDelegation(el);

    // ---- 动态模式操作按钮 ----
    document.addEventListener('click', function (e) {
        const target = e.target.closest('#btn-add-root, #btn-clear-selection');
        if (!target) return;
        e.stopPropagation();

        if (target.id === 'btn-add-root') {
            document.dispatchEvent(new CustomEvent(EVENTS.ADD_ROOT, { detail: { ctrlKey: e.ctrlKey } }));
        } else if (target.id === 'btn-clear-selection') {
            if (!e.ctrlKey) {
                showToast('请按住 Ctrl 键执行清空操作', 'error');
                return;
            }
            clearAllSelection();
        }
    });
}

// ================================================================
// 快捷键
//
// ⚠️ 这里**没有** Ctrl+Z（撤回）：撤回只在「设置」面板里点（刻意设计，避免误触）。
//    也**不要**加 `Ctrl+N`（快速添加根节点）：浏览器会先把 Ctrl+N 取走（新开窗口），
//    页面收不到那个按键，它永远不可能生效。
// ================================================================
export function setupShortcuts() {
    document.addEventListener('keydown', (e) => {
        pressedKeys.add(e.key);
        // ★ **按住 Ctrl ⇒ 节点框上显示这一条的 nature**（就在「修改」后面那一格）。
        //   只给 body 挂一个属性，**显示规则在 `index.html` 的样式块里**（一处说了算）——
        //   不逐个元素设 `display`：那样按住 Ctrl 时滚动/展开新画出来的方框会是隐藏的。
        //   ⚠️ 判据要连 `e.ctrlKey` 一起看：Ctrl 在**窗口外**先按住、再回来按别的键时，
        //      我们收不到 Ctrl 那次 keydown，只有后面那个键带着 `ctrlKey=true`。
        if (e.key === 'Control' || e.ctrlKey) naturePeek(true);
        if (e.altKey && e.key === 's') {
            e.preventDefault();
            document.dispatchEvent(new CustomEvent(EVENTS.EXPORT_FULL));
        }
    });
    document.addEventListener('keyup', (e) => {
        pressedKeys.delete(e.key);
        if (e.key === 'Control') naturePeek(false);
    });
    window.addEventListener('blur', () => {
        pressedKeys.clear();
        naturePeek(false);          // 焦点跑掉 = 收不到 keyup ⇒ 必须显式收起（否则一直亮着）
    });

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            pressedKeys.clear();
            naturePeek(false);
        }
    });
}

/** 「按住 Ctrl 显示 nature」的开关：只动 `body` 上那一个属性（显示规则在 index.html） */
function naturePeek(on) {
    if (!document.body) return;
    if (on) document.body.dataset.naturePeek = '1';
    else delete document.body.dataset.naturePeek;
}