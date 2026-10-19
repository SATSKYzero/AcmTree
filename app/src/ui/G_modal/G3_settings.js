// ================================================================
// 清空数据、副页编辑（ui/G_modal/G3_settings.js）
//
// ⚠️ **设置面板不在这里**：整套设置 UI 在 `ui/settings/settingsPage.js`
//    （一级 Tab，内容运行时画），me.json 编辑器也在那儿。
//    这里只剩两件与"弹窗"绑在一起的事：清空所有数据、副页重命名。
//
// 职责：清空全部数据（`resetAllWithConfirm`）、副页重命名（`showPageEditDialog`）
// ================================================================
import { AppState } from '../../shell/state.js';
import { execute } from '../../shell/executor.js';
import { renamePage, clearAllPages } from '../../core/ops/page.js';
import { assertManualEditAllowed } from '../../core/ops/account.js';
import { EVENTS } from '../../A_constants.js';
import { escapeHtml, emit } from '../../utils/A_helpers.js';
import { createModal } from './G1_core.js';
import { showToast } from './G1_toast.js';
import { showDeleteConfirm } from './G2_common.js';

// ================================================================
// 清空所有数据
// ================================================================

/**
 * 「🗑️ 清空」（工具栏那颗，Ctrl + 点）——**把这一摊全收走**：全部节点、全部副页、全部训练计划。
 *
 * ⚠️ 用户 2026-10-14："现在'清空'不会删除计划，有点奇怪 / 其实不删副页也是奇怪的" ——
 *    改前它只清节点 + 把副页**清成空页**、`plans` 一个字没动 ⇒ 清空之后还剩一栏副页页签
 *    和一条指不到东西的计划壳。现在副页整页删（`core/ops/page.js:clearAllPages`，那个口只为这一处存在）、
 *    `draft.plans = {}` 一起清。
 * ⚠️ **不动**的是：根节点、`settings` / `accounts` / `sources` / `trust` / `fieldRegistry` 这些"应用级"的东西
 *    （"清空所有数据"历来指的是**这棵树这一摊**；账户与设置各有各的口）。
 * ⚠️ 与"删**一个**副页不删计划"（`deletePage`，§10 ⑧）**不是一回事**，别混。
 */
export function resetAllWithConfirm() {
    const root = AppState.nodes[AppState.rootId];
    const hasTree = !!(root && AppState.childOrder[root.id] && AppState.childOrder[root.id].length > 0);
    const hasPages = Object.keys(AppState.pages || {}).length > 0;
    const hasPlans = Object.keys(AppState.plans || {}).length > 0;
    // ★ 判"空"要看**三样**（改前只看树空 ⇒ "树空了但副页/计划还在"时点清空会被拦下来说"已经是空树"）
    if (!hasTree && !hasPages && !hasPlans) {
        showToast('已经是空的（没有节点、副页、计划）', 'error');
        return;
    }
    showDeleteConfirm('清空所有数据',
        '确定要清空所有数据吗？（全部节点 · 全部副页 · 全部训练计划）此操作不可撤销！',
        async (confirmed) => {
        if (!confirmed) return;
        try {
            await execute(
                (draft) => {
                    // 只读边界：清空所有数据是**最重的**手改，同样必须被拦。
                    // （守卫在这层的理由与 tree.js 一样：UI 入口会持续变多）
                    assertManualEditAllowed(draft, '清空所有数据');
                    const rootCopy = draft.nodes[draft.rootId];
                    if (!rootCopy) return;

                    // 收集要删除的所有子节点 id 及其子孙
                    const toDelete = [];
                    function walk(id) {
                        toDelete.push(id);
                        for (const cid of draft.childOrder[id]) {
                            walk(cid);
                        }
                    }
                    for (const cid of [...draft.childOrder[rootCopy.id]]) {
                        walk(cid);
                    }

                    // 清空根的子列表
                    draft.childOrder[rootCopy.id] = [];

                    // 删除所有节点数据
                    for (const id of toDelete) {
                        delete draft.nodes[id];
                        delete draft.childOrder[id];
                        delete draft.parentOf[id];
                    }

                    // 副页**整页删掉**（不是"留个空页"）+ 计划一起清（它们的 `pageId`/`rootIds` 都指着上面删掉的东西）
                    clearAllPages(draft);
                    draft.plans = {};
                    draft.currentPageId = 'main';
                },
                {
                    refreshParentId: null,
                    onSuccess: () => {
                        showToast('已清空所有数据', 'success');
                        emit(EVENTS.PAGE_TABS_REFRESH_REQUIRED);
                    },
                    onError: (err) => {
                        showToast('清空失败: ' + err.message, 'error');
                    }
                }
            );
        } catch (_) {
            // onError 已处理
        }
    });
}

// ================================================================
// 副页编辑对话框
// ================================================================
export function showPageEditDialog(pageId, currentName, onSuccess) {
    const html = `
        <p style="font-size:13px;color:#6b7280;margin-bottom:12px;">修改副页名称。</p>
        <label>副页名称：
            <input type="text" id="page-name-input" value="${escapeHtml(currentName)}" style="width:100%;padding:6px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:14px;margin-top:4px;">
        </label>
    `;
    const { panel, close } = createModal({
        title: '📄 副页设置',
        content: html,
        maxWidth: '420px',
        buttons: [
            { label: '取消', className: 'btn', callback: () => { close(); } },
            { label: '保存', className: 'btn btn-primary', callback: async () => {
                const input = panel.querySelector('#page-name-input');
                const newName = input ? input.value.trim() : '';
                if (!newName) {
                    showToast('名称不能为空', 'error');
                    return false;
                }
                try {
                    await execute(
                        (draft) => {
                            // 重命名走 core 的唯一实现（重名检查 + 只读守卫都在那里）
                            renamePage(draft, pageId, newName);
                        },
                        {
                            validate: false,
                            refreshParentId: null,
                            onSuccess: () => {
                                showToast('副页名称已更新', 'success');
                                close();
                                if (onSuccess) onSuccess();
                            },
                            onError: (err) => {
                                showToast('重命名失败: ' + err.message, 'error');
                            }
                        }
                    );
                } catch (_) {
                    // onError 已处理
                }
                return false;
            }}
        ]
    });
    setTimeout(() => {
        const input = panel.querySelector('#page-name-input');
        if (input) { input.focus(); input.select(); }
    }, 50);
}
