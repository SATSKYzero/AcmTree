// ================================================================
// 主入口：重新导出所有公共 API（ui/G_modal/G_modals.js）
// ================================================================

// G1
export { createModal } from './G1_core.js';
export { showToast } from './G1_toast.js';

// G2
export {
    showFormDialog,
    showPromptDialog,
    showConfirmDialog,
    showDeleteConfirm,
    showDeleteConfirmWithContext,
    showOperationConfirmWithCountdown,
    confirmAnomalies
} from './G2_common.js';
export { showTypeSelector, showTreeSelector } from './G2_selector.js';

// G3
export { showMappingDialog, showProblemInfoDialog } from './G3_mapping.js';
export { showTagManager } from './G3_tag.js';
// ⚠️ 设置面板是一级 Tab（`ui/settings/settingsPage.js`，见 `tabs.js` 的 settings 分支），
//    这里**不导出** `showSettings`；入口是 `switchTab('settings')`（工具栏 ⚙️ 走它）。
export { resetAllWithConfirm, showPageEditDialog } from './G3_settings.js';

// G4
export { editRemark, editNode } from './G4_edit.js';
export { promptAddRoot, promptAddChild } from './G4_add.js';
export { promptCopyNode, promptCopyToPage } from './G4_copy.js';

// G5
export { showMoreActions, promptTodoProblemSheet } from './G5_actions.js';

// G7
export { showEditTargetSelector, showInfoTargetSelector } from './G7_editTarget.js';
export { editVNode } from './G7_vNodeEdit.js';

// G8
// ⚠️ 账户界面有两种形态、**同一份视图**（`G8_accounts.js` 的 `mountAccountsView`）：
//    ① **顶栏 👤 → 弹窗**（`ui/buttons.js`，用户 2026-10-19："点顶部的账号按钮会弹窗，那样挺好的"）；
//    ② 设置页「🔑 账户/名册」那栏（内嵌，账户与 me.json 名册同屏）。
//    再加"流程中途"的快捷入口（导入摘要那条 `EVENTS.SHOW_ACCOUNTS_DIALOG`）—— 三处共用一份界面。
export { showAccountsModal, mountAccountsView, renderAccountChip } from './G8_accounts.js';