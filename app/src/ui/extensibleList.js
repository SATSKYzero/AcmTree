// ================================================================
// 可扩展列表合并（ui/extensibleList.js）
// 职责：把「内置项」与「插件注册项」合并成一份有序、去重的列表
// 依赖：无
// 说明：本模块**不碰 DOM**，可在 Node 测试中直接引用。
//       文件夹节点视图（folderViewRegistry）与一级 Tab（tabRegistry）
//       共用这份语义，避免两处各写一份判重/排序逻辑。
//
// 契约：每一项形如 { id, label, order?, ...扩展字段 }
//   - 内置项默认 order = 0，插件项默认 order = pluginOrder
//   - id 冲突时"先到先得"：内置优先，插件被跳过并告警
//   - 返回的是浅拷贝，调用方改不动原对象
// ================================================================

/**
 * 合并内置项与插件项
 * @param {Array<Object>} builtins - 内置项
 * @param {Array<Object>} plugins - 插件注册项
 * @param {Object} [opts]
 * @param {number} [opts.pluginOrder=100] - 插件项默认排序值
 * @param {Function} [opts.onConflict] - 冲突回调 (def) => void，缺省打印告警
 * @returns {Array<Object>} 排序后的列表（插件项带 isPlugin: true）
 */
export function mergeExtensible(builtins = [], plugins = [], { pluginOrder = 100, onConflict } = {}) {
    const list = [];
    const seen = new Set();

    for (const def of builtins) {
        if (!def || typeof def.id !== 'string') continue;
        if (seen.has(def.id)) continue;   // 内置重复 id：只保留第一个
        seen.add(def.id);
        list.push({ ...def, isPlugin: false, order: def.order ?? 0 });
    }

    for (const def of plugins) {
        if (!def || typeof def.id !== 'string') continue;
        if (seen.has(def.id)) {
            if (typeof onConflict === 'function') onConflict(def);
            else console.warn(`[extensibleList] id "${def.id}" 与已有项冲突，已跳过`);
            continue;
        }
        seen.add(def.id);
        list.push({ ...def, isPlugin: true, order: def.order ?? pluginOrder });
    }

    // Array.prototype.sort 稳定：order 相同则保持注册先后
    return list.sort((a, b) => a.order - b.order);
}

/**
 * 按 id 取项
 * @param {Array<Object>} list
 * @param {string} id
 * @returns {Object|null} 未命中则回退到第一项
 */
export function pickById(list, id) {
    if (!Array.isArray(list) || list.length === 0) return null;
    return list.find(item => item.id === id) || list[0];
}

/**
 * 判断 id 是否存在于列表中
 * @param {Array<Object>} list
 * @param {string} id
 * @returns {boolean}
 */
export function hasId(list, id) {
    return Array.isArray(list) && list.some(item => item.id === id);
}
