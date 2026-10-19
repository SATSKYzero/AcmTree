// ================================================================
// 自动保存（shell/autoSave.js）
// 职责：定时 saveData + 定时触发导出事件
// 依赖：shell/state.js, persistence/index.js,
//       core/model/infoState.js, A_constants.js
// 说明：
//   - 保存：直接调 persistence.saveData
//   - 导出：不直接调 handler，改为派发 EVENTS.AUTO_EXPORT_TRIGGERED，
//          由入口层监听到后调用 exportFullJSON
// ================================================================
import { AppState } from './state.js';
import { saveData } from '../persistence/index.js';
import { InfoState } from '../core/model/infoState.js';
import { EVENTS, AUTO_SAVE_RETRY_DELAY } from '../A_constants.js';

let autoSaveRetryTimer = null;
let dbAutoSaveTimer = null;

// ================================================================
// 启动自动保存
// ================================================================
export function setupDbAutoSave() {
    if (dbAutoSaveTimer) {
        clearInterval(dbAutoSaveTimer);
        dbAutoSaveTimer = null;
    }

    const intervalMinutes = AppState.settings.autoSave.autoSaveInterval || 10;
    const intervalMs = intervalMinutes * 60 * 1000;
    console.log(`🔄 自动保存已启动，间隔 ${intervalMinutes} 分钟`);

    dbAutoSaveTimer = setInterval(performAutoSave, intervalMs);
}

// ================================================================
// 执行一次自动保存
// ================================================================
async function performAutoSave() {
    // 空树跳过
    if (!AppState.rootId || Object.keys(AppState.nodes).length <= 1) return;

    // ---- 第一步：IndexedDB 保存 ----
    try {
        await saveData(AppState);
        if (autoSaveRetryTimer) {
            clearTimeout(autoSaveRetryTimer);
            autoSaveRetryTimer = null;
        }
    } catch (err) {
        console.error('❌ 自动保存失败:', err);
        if (!autoSaveRetryTimer) {
            autoSaveRetryTimer = setTimeout(async () => {
                autoSaveRetryTimer = null;
                try {
                    await saveData(AppState);
                    console.log('✅ 自动保存重试成功');
                } catch (retryErr) {
                    console.error('❌ 自动保存重试仍然失败:', retryErr);
                }
            }, AUTO_SAVE_RETRY_DELAY);
        }
        return;
    }

    // ---- 第二步：定时导出 JSON ----
    if (InfoState.jsonIsSaved) {
        console.log('⏭️ JSON 已是最新，跳过自动导出');
        return;
    }

    const lastModified = InfoState.lastModifiedTime || 0;
    const now = Date.now();
    const intervalMs = (AppState.settings.autoSave.autoSaveInterval || 10) * 60 * 1000;
    if (now - lastModified >= intervalMs) {
        document.dispatchEvent(new CustomEvent(EVENTS.AUTO_EXPORT_TRIGGERED));
    }
}