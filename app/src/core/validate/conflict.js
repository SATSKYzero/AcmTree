// ================================================================
// 冲突检测（core/validate/conflict.js）
// 职责：名称/题号冲突检测
// 依赖：core/query/nodes.js
// ================================================================
import { getChildren, getNode } from '../query/nodes.js';

/**
 * 检测在指定父节点下，给定名称/题号是否与已有 P 节点冲突
 * @param {Object} state
 * @param {string} parentId
 * @param {string} name - 待检查名称（可空）
 * @param {string} problemId - 待检查题号（可空）
 * @param {string} excludeId - 排除的节点 id（编辑时排除自身）
 * @returns {string[]} 冲突描述列表
 */
export function collectPNodeConflicts(state, parentId, name, problemId, excludeId = null) {
    const anomalies = [];
    const parent = getNode(state, parentId);
    if (!parent) throw new Error(`父节点 ${parentId} 不存在`);

    const children = getChildren(state, parentId);

    if (name && name.trim()) {
        const trimmed = name.trim();
        for (const c of children) {
            if (c.type === 'P' && c.id !== excludeId && c.name === trimmed) {
                anomalies.push(`名称 "${trimmed}" 已存在`);
                break;
            }
        }
    }
    if (problemId && problemId.trim()) {
        const trimmed = problemId.trim();
        for (const c of children) {
            if (c.type === 'P' && c.id !== excludeId && c.problemId === trimmed) {
                anomalies.push(`题号 "${trimmed}" 已存在`);
                break;
            }
        }
    }
    return anomalies;
}

// ---- 检查同一 C 节点下 P 节点题号是否唯一 ----
export function checkProblemIdUnique(state, cId) {
    const c = getNode(state, cId);
    if (!c || c.type !== 'C') return [];
    const seen = new Set();
    const dups = [];
    for (const cid of state.childOrder[c.id]) {
        const p = getNode(state, cid);
        if (p && p.type === 'P' && p.problemId) {
            if (seen.has(p.problemId)) dups.push(p.problemId);
            else seen.add(p.problemId);
        }
    }
    return dups;
}

// ---- 批量 P 节点冲突检测（供批量导入使用） ----
/**
 * 检测批量 P 节点数据与已有节点的冲突
 * @param {Object} state
 * @param {string} parentId - 目标 C/W/S 节点 id
 * @param {Array<Object>} pNodesData - [{ name, problemId, ... }, ...]
 * @returns {string[]} 冲突描述列表
 */
export function collectBatchConflicts(state, parentId, pNodesData) {
    const anomalies = [];
    const parent = getNode(state, parentId);
    if (!parent) throw new Error(`父节点 ${parentId} 不存在`);

    const existingNames = new Set();
    const existingProblemIds = new Set();
    for (const cid of state.childOrder[parentId]) {
        const child = state.nodes[cid];
        if (child && child.type === 'P') {
            if (child.name) existingNames.add(child.name);
            if (child.problemId) existingProblemIds.add(child.problemId);
        }
    }

    const seenNames = new Set();
    const seenProblemIds = new Set();
    for (const item of pNodesData) {
        const name = item.name ? String(item.name).trim() : '';
        const problemId = item.problemId ? String(item.problemId).trim() : '';

        if (name) {
            if (seenNames.has(name)) {
                anomalies.push(`文件内名称重复: "${name}"`);
            } else {
                seenNames.add(name);
            }
            if (existingNames.has(name)) {
                anomalies.push(`名称 "${name}" 与已有题目重复`);
            }
        }

        if (problemId) {
            if (seenProblemIds.has(problemId)) {
                anomalies.push(`文件内题号重复: "${problemId}"`);
            } else {
                seenProblemIds.add(problemId);
            }
            if (existingProblemIds.has(problemId)) {
                anomalies.push(`题号 "${problemId}" 与已有题目重复`);
            }
        }
    }

    return anomalies;
}