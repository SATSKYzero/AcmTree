// ================================================================
// 「📋 待办题单」（按条件挑题 → 生成题单页）
//
// 设计稿 `docs/training-plan.md` ㉒㉓（用户："**筛选放在更靠前的环节**……不用再在副页上筛选"）：
//   在**题单形成**这一步就把题筛好 —— 这条链路**仓里本来就有**（原 `G5_actions.js:promptTodoProblemSheet`），
//   这一版只是把"条件"扩开（难度 / 标签 / 平台 / 状态自己勾）并允许**新建副页**。
//
// ⚠️ **挑题的判据只有一份**：`core/problemPick.js:pickProblemsOf`（纯函数、进 `npm test`）——
//    这份 UI **不许**自己再写一遍 `if (status2 === 0 || ...)`（那正是"两条路必然分叉"的老坑）。
// ⚠️ 写进副页仍然只走 `core/ops/page.js:batchCopyToPage`（含冲突检测 / 重复跳过）。
// ⚠️ 弹窗内容是**拼 innerHTML**（与仓里其它弹窗一致）⇒ 冒烟按字符串断言；
//    真正会红的判据在那份纯函数单测里（`src/test/problemPick.test.js`）。
// ================================================================
import { AppState } from '../../shell/state.js';
import { execute } from '../../shell/executor.js';
import { addPage, batchCopyToPage } from '../../core/ops/page.js';
import { pickProblemsOf, DEFAULT_PICK_FILTER } from '../../core/problemPick.js';
import { viewDerivedDisplay, viewValue } from '../../view/scope.js';
import { EVENTS, STATUS2_LABELS } from '../../A_constants.js';
import { createModal } from './G1_core.js';
import { showToast } from './G1_toast.js';
import { showOperationConfirmWithCountdown } from './G2_common.js';
// ★「选一个副页」的列表 / 选项文本 / 「新建」哨兵 / 接线 / 读回校验**只有一份**
//   （用户 2026-10-14："收成一份共用件"；原来 `pageList()`、哨兵常量、显示隐藏、校验都各写在本文件里）
import { pageSelectHtml, wirePagePicker, readPagePicker } from '../kit/pagePicker.js';
// ★「四维条件」的渲染 / 读回**只有一份**（计划侧编辑"范围条件"也用这一份 —— `ui/kit/pickFilter.js`）
import { chipRow, pickConditionHtml, readPickCondition } from '../kit/pickFilter.js';

/** 本弹窗那个副页下拉的 id（新建框的 id 由它推，见 `kit/pagePicker.js`） */
const PICK_PAGE_SELECT_ID = 'pick-page';

/**
 * 上一次用过的挑题条件（**会话级**：只为"再补一次"时不用重填；不进存档、不进包）。
 * @type {Object|null}
 */
let lastPickFilter = null;

/** 给自测/排错用 */
export function __resetPickFilter() { lastPickFilter = null; }
/** 给自测/排错用 */
export function __lastPickFilter() { return lastPickFilter ? { ...lastPickFilter } : null; }

const shownValueOf = () => (n, f) => viewDerivedDisplay(AppState, n, f) ?? viewValue(AppState, n, f);

// ⚠️ 原来这里有一份 `pageList()`（"页列表"的第二份实现）—— 已收进
//    `ui/kit/pagePicker.js:pageChoicesOf`（连计数口径一起）。**别再加回来。**

/** 从弹窗里把条件读回来（**唯一一份**：确认时按它再挑一次） */
function readFilter(panel) {
    const box = panel.querySelector('#pick-unhandled');
    return {
        ...readPickCondition(panel),            // 四维：档位 / 数值区间 / 标签 / 平台（`ui/kit/pickFilter.js`）
        statuses: [...panel.querySelectorAll('[data-pick="status"]')]
            .filter((el) => el.checked)
            .map((el) => Number(el.value)),
        includeUnhandled: box ? !!box.checked : true
    };
}

/** 一行多选芯片（抽到 `ui/kit/pickFilter.js` —— 计划侧的"范围条件"用同一份） */

/**
 * 打开「按条件挑题 → 生成题单页」。
 * @param {string} nodeId 挑题的**子树根**（一般是你点开的那个节点）
 */
export function promptTodoProblemSheet(nodeId) {
    const node = AppState.nodes[nodeId];
    if (!node) {
        showToast('节点不存在', 'error');
        return;
    }
    const shownValue = shownValueOf();
    const initial = { ...DEFAULT_PICK_FILTER, ...(lastPickFilter || {}) };
    const picked = pickProblemsOf(AppState, nodeId, initial, { shownValue });
    if (picked.total === 0) {
        showToast('这个节点下面没有题目', 'info');
        return;
    }
    if (picked.matched.length === 0) {
        showToast(`按上次的条件一道都没挑中（这个子树里共 ${picked.total} 道题）`, 'info');
        return;
    }

    // （副页列表不再在这里取：`pageSelectHtml` 自己从 state 取 —— `ui/kit/pagePicker.js` 那一份）
    // （四维条件（档位/数值区间/标签/平台）也不在这里画：`pickConditionHtml` —— `ui/kit/pickFilter.js` 那一份）
    const statusItems = [0, 1, 2, 3, 4, 5].map((s2) => ({ value: String(s2), label: `${s2} ${STATUS2_LABELS[s2]}` }));

    const html = `
        <p style="font-size:13px; color:#6b7280; margin:0 0 8px;">
            这个子树里共 <b>${picked.total}</b> 道题；按上次的条件挑中 <b class="pick-count">${picked.matched.length}</b> 道。
            <br><span style="font-size:11px;color:#94a3b8;">挑中的题会复制到下面选的副页里（题单）——主树不动，
            之后在计划里绑这个副页即可。</span>
        </p>
        ${chipRow('status', '状态2（不勾 = 不要这一类）', statusItems, initial.statuses.map(String))}
        <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#475569;margin-bottom:6px;cursor:pointer;">
            <input type="checkbox" id="pick-unhandled" ${initial.includeUnhandled ? 'checked' : ''}> 只要「还没处理过」的（状态1 没勾）也算
        </label>
        ${pickConditionHtml({ rootIds: [nodeId], initial, shownValue })}
        ${pageSelectHtml(AppState, { selectId: PICK_PAGE_SELECT_ID, label: '目标副页（题单）', allowNew: true })}
        <label style="margin-top:8px; display:flex; align-items:center; gap:6px;font-size:12px;color:#475569;cursor:pointer;">
            <input type="checkbox" id="pick-recursive" checked> 递归复制子节点
        </label>
    `;

    const { panel, close } = createModal({
        title: '📋 按条件挑题 → 生成题单页',
        content: html,
        maxWidth: '560px',
        buttons: [
            { label: '取消', className: 'btn', callback: () => { close(); } },
            {
                label: '挑题并生成', className: 'btn btn-primary', callback: async () => {
                    const filter = readFilter(panel);
                    const shown2 = shownValueOf();
                    const again = pickProblemsOf(AppState, nodeId, filter, { shownValue: shown2 });
                    if (again.matched.length === 0) {
                        showToast('按现在的条件一道都没挑中 —— 放宽一点再试', 'error');
                        return false;
                    }
                    // 「选哪个副页 / 要不要新建」的读回与校验只有一份（`ui/kit/pagePicker.js`）
                    const picked = readPagePicker(panel, { selectId: PICK_PAGE_SELECT_ID });
                    if (picked.error) { showToast(picked.error, 'error'); return false; }
                    const isNew = picked.isNew;
                    const newName = picked.name;
                    const targetPageId = picked.pageId;
                    const recursive = panel.querySelector('#pick-recursive')?.checked || false;
                    const filteredIds = again.matched.map((p) => p.id);
                    lastPickFilter = filter;              // 记着：下次"再补一次"不用重填（会话级）
                    close();

                    try {
                        await execute(
                            (draft) => {
                                const pageId = isNew ? addPage(draft, newName).id : targetPageId;
                                return batchCopyToPage(draft, filteredIds, pageId, { recursive });
                            },
                            {
                                validate: false,
                                refreshParentId: null,
                                onSuccess: (result) => {
                                    showToast(`题单已生成：${result.copied} 道题已加入副页`
                                        + (result.conflicts ? `（${result.conflicts} 道已存在被跳过）` : ''), 'success');
                                    document.dispatchEvent(new CustomEvent(EVENTS.PAGE_DATA_CHANGED, {
                                        detail: { pageId: targetPageId || '' }
                                    }));
                                    document.dispatchEvent(new CustomEvent(EVENTS.PAGE_TABS_REFRESH_REQUIRED));
                                },
                                onError: async (err) => {
                                    if (err.conflicts && err.conflicts.length > 0) {
                                        const names = err.conflicts.map((n) => n.name || n.problemId || n.id);
                                        showOperationConfirmWithCountdown(
                                            [`以下 ${err.conflicts.length} 个节点已存在于目标副页，将跳过：`, ...names],
                                            async (confirmed) => {
                                                if (!confirmed) return;
                                                try {
                                                    await execute(
                                                        (draft2) => batchCopyToPage(draft2, filteredIds, targetPageId, {
                                                            recursive, skipDuplicateCheck: true
                                                        }),
                                                        {
                                                            validate: false,
                                                            refreshParentId: null,
                                                            onSuccess: (r2) => showToast(
                                                                `题单完成：${r2.copied} 道，${r2.conflicts} 道已存在被跳过`, 'success'),
                                                            onError: (e2) => showToast('待办题单失败: ' + e2.message, 'error')
                                                        }
                                                    );
                                                } catch (_) { /* onError 已报 */ }
                                            }
                                        );
                                    } else {
                                        showToast('生成题单失败: ' + err.message, 'error');
                                    }
                                }
                            }
                        );
                    } catch (_) { /* onError 已报 */ }
                    return false;
                }
            }
        ]
    });

    // 选「＋ 新建一个副页…」才显示输入框 —— 接线也只有一份（`ui/kit/pagePicker.js`，幂等）
    wirePagePicker(panel, { selectId: PICK_PAGE_SELECT_ID });
}
