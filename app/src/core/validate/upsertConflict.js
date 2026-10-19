// ================================================================
// extKey 冲突检测（core/validate/upsertConflict.js）
// 职责：extKey 的**全局唯一**约束（节点自动导入的前置不变量）
// 依赖：无（只读 state 结构与普通对象数组）
//
// 为什么单独一个文件（而不是并进 conflict.js）：
//   conflict.js 管的是「名称 / 题号」冲突——那是**展示层**的唯一性，
//   冲突了只警告、可自动重命名（handlers/H2_batchImport.js 就是这么做的）。
//   本文件的 extKey 是**身份层**的唯一性，冲突即数据错误，不可自动修正
//   （自动挑一个 = 静默合并两个节点，不可修）。
//
// 设计依据：docs/auto-import.md 2.4 / 3.2
// ================================================================

/** 把 extKey 规范化为可比较形式（只做 trim，**不解析内容**） */
function normKey(value) {
    if (value === undefined || value === null) return '';
    return String(value).trim();
}

/**
 * 检查全树的 extKey 是否全局唯一
 *
 * 重复的 extKey 会让 `buildExtKeyIndex` 的查找出现歧义，
 * 而父引用解析（2.2）正依赖该查找。
 *
 * @param {Object} state - AppState
 * @returns {Array<{ extKey: string, nodeIds: string[] }>} 重复项列表（空数组 = 无冲突）
 */
export function collectExtKeyConflicts(state) {
    const seen = new Map();     // extKey → nodeId[]
    if (!state || !state.nodes) return [];

    for (const id in state.nodes) {
        const node = state.nodes[id];
        if (!node) continue;
        const key = normKey(node.extKey);
        if (!key) continue;
        if (!seen.has(key)) seen.set(key, []);
        seen.get(key).push(id);
    }

    const out = [];
    for (const [extKey, nodeIds] of seen) {
        if (nodeIds.length > 1) out.push({ extKey, nodeIds });
    }
    return out;
}

/**
 * 检查一份待导入记录内部的 extKey 是否重复
 *
 * 包内自相矛盾（同一 key 出现两次）会让"先到的那条被后到的覆盖"，
 * 表现成"导入了 2 条只得到 1 个节点"——见 docs/auto-import.md 4.7。
 *
 * @param {Array<Object>} records - [{ extKey, type, ... }]
 * @returns {Array<{ extKey: string, indexes: number[] }>} 重复项（indexes 为记录下标）
 */
export function collectBatchExtKeyConflicts(records = []) {
    const seen = new Map();     // extKey → index[]
    const list = Array.isArray(records) ? records : [];

    for (let i = 0; i < list.length; i++) {
        const rec = list[i];
        if (!rec || typeof rec !== 'object') continue;
        const key = normKey(rec.extKey);
        if (!key) continue;     // 缺 key 由 plan 层单独报错，不在此重复计
        if (!seen.has(key)) seen.set(key, []);
        seen.get(key).push(i);
    }

    const out = [];
    for (const [extKey, indexes] of seen) {
        if (indexes.length > 1) out.push({ extKey, indexes });
    }
    return out;
}

/**
 * 检查把某个 extKey 指给某个节点是否会造成全局冲突
 *
 * 供「补身份键」功能（docs/auto-import.md 8.5）在提交前预检：
 * 目标 key 若已被**别的**节点占用则拒绝，**不自动挑一个**。
 *
 * @param {Object} state
 * @param {string} nodeId - 受检节点
 * @param {string} extKey - 想写入的 key
 * @returns {{ ok: boolean, code?: string, holderId?: string, reason?: string }}
 */
export function checkExtKeyUnique(state, nodeId, extKey) {
    const key = normKey(extKey);
    if (!key) {
        return { ok: false, code: 'empty-key', reason: 'extKey 不能为空' };
    }
    if (!state || !state.nodes || !state.nodes[nodeId]) {
        return { ok: false, code: 'no-node', reason: `节点不存在：${nodeId}` };
    }

    for (const id in state.nodes) {
        if (id === nodeId) continue;
        const node = state.nodes[id];
        if (node && normKey(node.extKey) === key) {
            return {
                ok: false,
                code: 'key-taken',
                holderId: id,
                reason: `extKey "${key}" 已被节点 ${id}（${node.name || node.type}）占用`
            };
        }
    }
    return { ok: true };
}
