// ================================================================
// 应用初始化（shell/init.js）
// 职责：加载数据 → 回填 AppState → 初始化历史 → 派发 UI 刷新
// 依赖：shell/state.js, persistence/index.js, transaction/history.js,
//       A_constants.js
// ================================================================
import { AppState, replaceState } from './state.js';
import { loadData } from '../persistence/index.js';
import { captureState, resetHistory } from '../transaction/history.js';
import { EVENTS } from '../A_constants.js';

/**
 * 初始化应用（入口层调用）
 * 流程：
 *   1. loadData 从 IndexedDB 读，无数据时返回 createInitialState()
 *   2. replaceState 整体回填 AppState（引用稳定）
 *   3. resetHistory 用当前 AppState 初始化历史栈
 *   4. 派发 UI_REFRESH_REQUIRED，由 UI 层接管渲染
 * @returns {Promise<void>}
 */
export async function initApp() {
    // 1. 加载数据（loadData 内部已处理 InfoState 恢复）
    const loaded = await loadData();

    // 2. 回填 AppState（引用不变，字段替换）
    replaceState(loaded);

    // 3. 初始化历史（首次加载，历史栈只有当前状态）
    const snapshot = captureState(AppState);
    resetHistory(snapshot);

    // 4. 通知 UI 层刷新
    document.dispatchEvent(new CustomEvent(EVENTS.UI_REFRESH_REQUIRED, {
        detail: { parentId: null }
    }));
    document.dispatchEvent(new CustomEvent(EVENTS.PAGE_TABS_REFRESH_REQUIRED));
}