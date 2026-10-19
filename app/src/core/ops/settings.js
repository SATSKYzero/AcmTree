// ================================================================
// 设置操作（core/ops/settings.js）
// 职责：更新全局设置，支持嵌套路径
// 依赖：A_registry.js（setByPath）
// ================================================================
import { setByPath } from '../../A_registry.js';
import { isPlainObject } from '../../utils/guards.js';

/**
 * 按路径设置单个字段
 * @param {Object} draft - 状态草稿
 * @param {string} path - 如 'display.nodePerPage'
 * @param {*} value
 */
export function setSetting(draft, path, value) {
    setByPath(draft.settings, path, value);
}

/**
 * 深合并部分设置
 * 规则：
 *   - 对象：递归合并
 *   - 数组：整体替换
 *   - 基本类型：整体替换
 *   - undefined：跳过
 *   - null：视为清空
 * @param {Object} draft - 状态草稿
 * @param {Object} partial - 嵌套对象，如 { display: { nodePerPage: 30 } }
 */
export function updateSettings(draft, partial) {
    if (!partial || typeof partial !== 'object') return;
    deepMerge(draft.settings, partial);
}

// ================================================================
// 内部辅助
// ================================================================

function deepMerge(target, source) {
    for (const key of Object.keys(source)) {
        const val = source[key];
        if (val === undefined) continue;
        if (val === null) {
            target[key] = null;
            continue;
        }
        if (isPlainObject(val)) {
            if (!isPlainObject(target[key])) {
                target[key] = {};
            }
            deepMerge(target[key], val);
        } else {
            target[key] = val;
        }
    }
}
