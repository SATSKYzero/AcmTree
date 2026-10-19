// ================================================================
// 更多操作（ui/G_modal/G5_actions.js）
// 职责：节点相关的批量操作对话框与执行
// 依赖：shell/state.js, shell/executor.js, core/ops/tree.js,
//       core/ops/page.js, core/ops/_helpers.js, core/autoCompute.js,
//       utils/A_helpers.js, A_constants.js,
//       G1_core.js, G1_toast.js, G2_common.js,
//       G4_copy.js, G4_edit.js
// ================================================================
import { AppState } from '../../shell/state.js';
import { execute } from '../../shell/executor.js';
import { clearProblems, clearSubmissions } from '../../core/ops/tree.js';
import { batchCopyToPage } from '../../core/ops/page.js';
import { nextTagId } from '../../core/ops/_helpers.js';
import { assertManualEditAllowed } from '../../core/ops/account.js';
import { setDerivedOverride } from '../../core/fieldValue.js';
import { mutateNodeTags } from '../../core/ops/tag.js';
import { viewDerivedDisplay } from '../../view/scope.js';
import { autoUpdateSubtree, propagateUp, autoUpdateChain } from '../../core/autoCompute.js';
import { escapeHtml } from '../../utils/html.js';
import { TYPE_LABEL_MAP, TAG_COLOR_NAMES, DEFAULT_TAG_COLOR, EVENTS, STATUS2_MAX } from '../../A_constants.js';
import { createModal } from './G1_core.js';
import { showToast } from './G1_toast.js';
import {
    showFormDialog,
    showDeleteConfirm,
    showConfirmDialog,
    showOperationConfirmWithCountdown
} from './G2_common.js';
import { promptCopyNode, promptCopyToPage } from './G4_copy.js';
import { editRemark } from './G4_edit.js';

// ================================================================
// 事件派发（批量导入走 I_app 监听）
// ================================================================
function dispatchBatch(eventName, nodeId) {
    document.dispatchEvent(new CustomEvent(eventName, { detail: { parentId: nodeId } }));
}

// ================================================================
// 清空题目 / 提交记录
// ================================================================
function confirmClearProblems(nodeId) {
    showDeleteConfirm(
        '清空所有题目',
        '确定要删除该节点下的全部题目及其所有提交记录吗？此操作不可撤销！',
        async (confirmed) => {
            if (!confirmed) return;
            try {
                await execute(
                    (draft) => {
                        const result = clearProblems(draft, nodeId);
                        return result;
                    },
                    {
                        refreshParentId: nodeId,
                        onSuccess: (result) => {
                            showToast(`已清空 ${result.count} 道题目`, 'success');
                            document.dispatchEvent(new CustomEvent(EVENTS.PAGE_TABS_REFRESH_REQUIRED));
                        },
                        onError: (err) => {
                            showToast(err.message || '清空失败', 'error');
                        }
                    }
                );
            } catch (_) {}
        }
    );
}

function confirmClearSubmissions(nodeId) {
    showDeleteConfirm(
        '清空所有提交记录',
        '确定要删除该节点下的全部提交记录吗？题目将保留。此操作不可撤销！',
        async (confirmed) => {
            if (!confirmed) return;
            try {
                await execute(
                    (draft) => {
                        const result = clearSubmissions(draft, nodeId);
                        return result;
                    },
                    {
                        refreshParentId: nodeId,
                        onSuccess: (result) => {
                            showToast(`已清空 ${result.count} 条提交记录`, 'success');
                        },
                        onError: (err) => {
                            showToast(err.message || '清空失败', 'error');
                        }
                    }
                );
            } catch (_) {}
        }
    );
}

// ================================================================
// 排序对话框
//
// ⚠️ 两个排序都作用在**一棵子树**上（`handlers/H3_sort.js`）：C 上 = 只排这一场，
//    W/S/O 上 = 排这一支下的所有比赛。所以标题要**跟着说清作用范围**，
//    不然在 W 上点了"题目排序"却看不出它动了 20 场比赛。
// ================================================================

/** 用在非 C 容器上时的范围说明 */
function scopeTail(nodeId) {
    const node = AppState.nodes[nodeId];
    return (node && node.type === 'C') ? '' : '（这一支下所有比赛）';
}

function showSortProblemsDialog(nodeId) {
    showFormDialog(`题目排序${scopeTail(nodeId)}`, [
        { key: 'sortKey', label: '排序方式', type: 'select', options: [
            '题号升序（恢复自动排序）',
            'XCPC难度升序（过题比例降序）',
            'XCPC难度降序（过题比例升序）',
            'CF难度升序',
            'CF难度降序'
        ], default: '题号升序（恢复自动排序）' }
    ], (res) => {
        if (!res) return;                     // ★ 表单取消 ⇒ 什么都不做（约定见 `G2_common.js` 文件头）
        const map = {
            '题号升序（恢复自动排序）': 'id-asc',
            'XCPC难度升序（过题比例降序）': 'xcpc-asc',
            'XCPC难度降序（过题比例升序）': 'xcpc-desc',
            'CF难度升序': 'cf-asc',
            'CF难度降序': 'cf-desc'
        };
        document.dispatchEvent(new CustomEvent(EVENTS.SORT_PROBLEMS, {
            detail: { nodeId, sortKey: map[res.sortKey] }
        }));
    });
}

function showSortSubmissionsDialog(nodeId) {
    showFormDialog(`排序提交记录${scopeTail(nodeId)}`, [
        { key: 'direction', label: '排序方式', type: 'select',
          options: ['提交时间倒序（恢复自动排序）', '提交时间升序'],
          default: '提交时间倒序（恢复自动排序）' }
    ], (res) => {
        if (!res) return;                     // ★ 表单取消 ⇒ 什么都不做
        // 倒序 = 规范序（`core/siblingOrder.js` 里 R 的规则）⇒ 那一项就是"恢复自动"
        const dir = res.direction === '提交时间升序' ? 'asc' : 'desc';
        document.dispatchEvent(new CustomEvent(EVENTS.SORT_SUBMISSIONS, { detail: { nodeId, direction: dir } }));
    });
}

// ================================================================
// 批量管理标签
// ================================================================
function showBatchTagsDialog(node, nodeId) {
    showFormDialog('批量管理标签', [
        { key: 'action', label: '操作', type: 'select', options: ['添加标签', '删除标签'], default: '添加标签' },
        { key: 'tagText', label: '标签文字', type: 'text', default: '' },
        { key: 'tagColor', label: '标签颜色', type: 'select', options: TAG_COLOR_NAMES, default: DEFAULT_TAG_COLOR }
    ], async (res) => {
        if (!res) return;                     // ★ 表单取消 ⇒ 什么都不做
        const action = res.action;
        const tagText = res.tagText.trim();
        const tagColor = res.tagColor;
        if (!tagText) { showToast('请输入标签文字', 'error'); return; }

        try {
            await execute(
                (draft) => {
                    assertManualEditAllowed(draft, '批量改标签');
                    const targetNode = draft.nodes[nodeId];
                    if (!targetNode) throw new Error('目标节点不存在');

                    const pIds = collectTypeInDraft(draft, nodeId, 'P');
                    if (pIds.length === 0) throw new Error('该节点下没有题目');

                    let changed = 0;
                    const tagId = nextTagId(draft);

                    // 用 `core/ops/tag.js` 的**唯一入口**（守卫 + 留痕都在里面），
                    // 这里只提供"批量改这一批节点"的那一步 —— 不自己抄一遍规则。
                    for (const pid of pIds) {
                        const p = draft.nodes[pid];
                        const has = p.tags.some(t => t.text === tagText);
                        if (action === '添加标签' ? has : !has) continue;
                        mutateNodeTags(draft, pid, (node) => {
                            if (action === '添加标签') {
                                node.tags.push({ id: tagId, text: tagText, color: tagColor });
                            } else {
                                node.tags.splice(node.tags.findIndex(t => t.text === tagText), 1);
                            }
                        });
                        changed++;
                    }

                    if (changed === 0) {
                        throw new Error(`没有题目需要${action === '添加标签' ? '添加' : '删除'}该标签`);
                    }
                    return { changed };
                },
                {
                    refreshParentId: nodeId,
                    onSuccess: (result) => {
                        showToast(`批量标签操作成功，影响了 ${result.changed} 道题目`, 'success');
                    },
                    onError: (err) => {
                        showToast(err.message || '批量标签操作失败', 'error');
                    }
                }
            );
        } catch (_) {}
    });
}

// ================================================================
// 批量设置题目状态
// ================================================================
function showBatchSetStatusDialog(node, nodeId) {
    showFormDialog('批量设置题目状态', [
        { key: 'prop', label: '选择要设置的属性', type: 'select', options: ['status1', 'status2'], default: 'status1' },
        { key: 'value', label: '目标值', type: 'text', default: '1' }
    ], async (res) => {
        if (!res) return;                     // ★ 表单取消 ⇒ 什么都不做
        const prop = res.prop;
        const val = parseInt(res.value);
        // 取值范围**派生**（`status2` 的上限来自 `STATUS2_VALUES`；加档时这里跟着长）
        const maxOf = { status1: 1, status2: STATUS2_MAX };
        if (isNaN(val) || val < 0 || val > (maxOf[prop] ?? 0)) {
            showToast('请输入有效的状态值', 'error');
            return;
        }

        try {
            await execute(
                (draft) => {
                    assertManualEditAllowed(draft, '批量设状态');
                    const targetNode = draft.nodes[nodeId];
                    if (!targetNode) throw new Error('目标节点不存在');

                    const pIds = collectTypeInDraft(draft, nodeId, 'P');
                    if (pIds.length === 0) throw new Error('该节点下没有题目');

                    for (const pid of pIds) {
                        const p = draft.nodes[pid];
                        p[prop] = val;
                        // `status2` 是派生元素（`recordManualValue` 会跳过），所以走覆盖入口：
                        // 用户选的值算不算"覆盖"由**属性表**判断，这里不写死名单。
                        if (prop === 'status2') {
                            setDerivedOverride(p, 'status2', val,
                                { at: getNowStr(), account: draft.currentAccountId });
                        }
                    }

                    // ★ 批量改的是**这些 P 节点本身**：一个节点算出来的字段只取决于
                    //   "它自己 + 它的后代" ⇒ 只需各自的"自己 + 祖先链"（容器要把子树汇总上去）。
                    //   ⚠️ 里面有**组头**（`synthKey`）就整树：组头的值要走"合并整组"那一趟。
                    //   ⚠️ 以前在这里 `fullAutoUpdate(draft)`（整树，真包 27k 实测 ~1150ms/次）——
                    //      批量虽然动得多，但"每个改动节点一条链"仍远小于整树（且与树操作同一条路）。
                    const hasHead = pIds.some((pid) => draft.nodes[pid] && draft.nodes[pid].synthKey);
                    if (hasHead) fullAutoUpdate(draft);
                    else for (const pid of pIds) autoUpdateChain(draft, pid);
                    return { count: pIds.length };
                },
                {
                    refreshParentId: nodeId,
                    onSuccess: (result) => {
                        showToast(`已将 ${result.count} 道题目的 ${prop} 设置为 ${val}`, 'success');
                    },
                    onError: (err) => {
                        showToast(err.message || '批量设置状态失败', 'error');
                    }
                }
            );
        } catch (_) {}
    });
}

// ================================================================
// 批量设置比赛状态
// ================================================================
function showBatchSetContestStatusDialog(node, nodeId) {
    const cIds = collectTypeInDraft(AppState, nodeId, 'C');
    if (cIds.length === 0) {
        showToast('该节点下没有比赛', 'error');
        return;
    }

    showFormDialog('批量设置比赛状态', [
        { key: 'action', label: '操作', type: 'select', options: ['设为忽略 (statusComplete2=4)', '恢复自动计算 (statusComplete2=0)'], default: '设为忽略 (statusComplete2=4)' }
    ], async (res) => {
        if (!res) return;                     // ★ 表单取消 ⇒ 什么都不做
        const action = res.action;
        const targetValue = action.startsWith('设为忽略') ? 4 : 0;

        if (targetValue === 4) {
            const confirmResult = await new Promise((resolve) => {
                showDeleteConfirm('批量忽略比赛', `确定要将 ${cIds.length} 场比赛设为忽略吗？此操作可撤销。`, resolve);
            });
            if (!confirmResult) return;
        } else {
            const confirmResult = await new Promise((resolve) => {
                showConfirmDialog('恢复自动计算', `确定要将 ${cIds.length} 场比赛恢复为自动计算状态吗？`, resolve);
            });
            if (!confirmResult) return;
        }

        try {
            await execute(
                (draft) => {
                    assertManualEditAllowed(draft, '批量设比赛状态');
                    const targetNode = draft.nodes[nodeId];
                    if (!targetNode) throw new Error('节点不存在');

                    const cIdsInDraft = collectTypeInDraft(draft, nodeId, 'C');
                    if (cIdsInDraft.length === 0) throw new Error('该节点下没有比赛');

                    for (const cid of cIdsInDraft) {
                        const c = draft.nodes[cid];
                        c.statusComplete2 = targetValue;
                        // 容器的"忽略（4）"是**用户按下的覆盖** ——
                        // 除了写缓存，还要在来源层留一条带账户的记录（否则按范围重算会被冲掉）；
                        // "恢复自动计算（0）"则要把那条覆盖**删掉**。
                        setDerivedOverride(c, 'statusComplete2', targetValue,
                            { at: getNowStr(), account: draft.currentAccountId });
                    }

                    autoUpdateSubtree(draft, nodeId);
                    propagateUp(draft, nodeId);
                    return { count: cIdsInDraft.length };
                },
                {
                    refreshParentId: nodeId,
                    onSuccess: (result) => {
                        showToast(`已成功将 ${result.count} 场比赛${targetValue===4?'设为忽略':'恢复自动计算'}`, 'success');
                    },
                    onError: (err) => {
                        showToast(err.message || '批量设置比赛状态失败', 'error');
                    }
                }
            );
        } catch (_) {}
    });
}

// ================================================================
// 待办题单
// ================================================================
// ★ **挑题 → 生成题单页**已经搬到 `./G5_todoSheet.js`（设计稿 `docs/training-plan.md` ㉒㉓：
//   条件扩开 + 允许新建副页）。这里只做**转发**，别再实现一遍：
//   挑题的判据唯一一份在 `core/problemPick.js:pickProblemsOf`（纯函数、进 `npm test`）。
export { promptTodoProblemSheet } from './G5_todoSheet.js';
// ================================================================

// 操作菜单定义
function getCommonActions(nodeId) {
    return [
        { label: '📋 复制节点', className: 'btn-info', handler: () => promptCopyNode(nodeId) },
        { label: '📝 备注', className: 'btn-info', handler: () => editRemark(nodeId) },
        { label: '📋 复制到副页', className: 'btn-primary', handler: () => promptCopyToPage(nodeId) }
    ];
}

/**
 * 两个排序按钮 —— **只有这一份**，C（只排这一场）与 O/W/S（排一整支）共用，
 * 只是标签上写明范围（用户 2026-10-12 要求 O/W/S 也支持这三件事）。
 */
function getSortActions(nodeId, subtree) {
    const tail = subtree ? '（这一支）' : '';
    return [
        { label: `📊 题目排序${tail}`, className: 'btn-info', handler: () => showSortProblemsDialog(nodeId) },
        { label: `📅 排序提交记录${tail}`, className: 'btn-info', handler: () => showSortSubmissionsDialog(nodeId) }
    ];
}

function getCActions(node, nodeId) {
    const actions = [];
    if (node.type === 'C') {
        actions.push(
            { label: '📥 批量导入题目', className: 'btn-primary', handler: () => dispatchBatch(EVENTS.BATCH_IMPORT, nodeId) },
            { label: '📋 批量导入提交记录', className: 'btn-success', handler: () => dispatchBatch(EVENTS.BATCH_SUBMIT_IMPORT, nodeId) },
            { label: '📝 题目信息批量导入', className: 'btn-secondary', handler: () => dispatchBatch(EVENTS.BATCH_PROBLEM_INFO, nodeId) },
            ...getSortActions(nodeId, false),
            { label: '🏷️ 批量管理标签', className: 'btn-primary', handler: () => showBatchTagsDialog(node, nodeId) }
        );
    }
    return actions;
}

function getWSCActions(node, nodeId) {
    const actions = [];
    if (['W', 'S', 'C'].includes(node.type)) {
        actions.push(
            { label: '🎯 批量设置题目状态', className: 'btn-primary', handler: () => showBatchSetStatusDialog(node, nodeId) }
        );
        actions.push(
            { label: '🧹 清空所有题目', className: 'btn-danger', handler: () => confirmClearProblems(nodeId) },
            { label: '🧹 清空所有提交记录', className: 'btn-warning', handler: () => confirmClearSubmissions(nodeId) }
        );
        actions.push(
            { label: '📋 待办题单', className: 'btn-success', handler: () => promptTodoProblemSheet(nodeId) }
        );
    }
    if (['W', 'S'].includes(node.type)) {
        actions.push(
            { label: '🎯 批量设置比赛状态', className: 'btn-primary', handler: () => showBatchSetContestStatusDialog(node, nodeId) }
        );
    }
    if (node.type === 'S') {
        actions.push({ label: '📥 批量导入比赛', className: 'btn-primary', handler: () => dispatchBatch(EVENTS.BATCH_CONTEST_IMPORT, nodeId) });
    }
    return actions;
}

// ================================================================
// 主入口
// ================================================================
export function showMoreActions(nodeId) {
    const node = AppState.nodes[nodeId];
    if (!node) { showToast('节点不存在', 'error'); return; }
    const type = node.type;

    let actionDefs = [];
    actionDefs = actionDefs.concat(getCommonActions(nodeId));
    if (type === 'C') {
        actionDefs = actionDefs.concat(getCActions(node, nodeId));
    }
    if (['W', 'S', 'C'].includes(type)) {
        actionDefs = actionDefs.concat(getWSCActions(node, nodeId));
    }
    // ★ O/W/S 也支持"题目排序 / 提交记录排序"（= 作用在这一整支上）；C 的那两个在 `getCActions` 里。
    if (['O', 'W', 'S'].includes(type)) {
        actionDefs = actionDefs.concat(getSortActions(nodeId, true));
    }

    let btnHtml = '<div class="more-actions-grid">';
    actionDefs.forEach(def => {
        btnHtml += `<button class="btn ${def.className}" data-action-id="${def.label.replace(/\s/g,'_')}">${def.label}</button>`;
    });
    btnHtml += '</div>';

    const { panel, close } = createModal({
        title: `更多操作 - ${TYPE_LABEL_MAP[type] || '节点'}`,
        content: btnHtml,
        maxWidth: '450px',
        buttons: [
            { label: '关闭', className: 'btn', callback: () => { close(); } }
        ]
    });

    panel.querySelectorAll('.more-actions-grid .btn').forEach((btn, idx) => {
        btn.addEventListener('click', () => {
            const def = actionDefs[idx];
            if (def) {
                def.handler();
                close();
            }
        });
    });
}

// ================================================================
// 内部辅助
// ================================================================

function collectTypeInDraft(state, rootId, type) {
    const result = [];
    (function walk(nid) {
        const n = state.nodes[nid];
        if (!n) return;
        if (n.type === type) result.push(nid);
        const childIds = state.childOrder[nid] || [];
        for (const cid of childIds) {
            walk(cid);
        }
    })(rootId);
    return result;
}
