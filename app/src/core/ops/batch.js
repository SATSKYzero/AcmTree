// ================================================================
// 批量操作（core/ops/batch.js）
// 职责：批量添加 P 节点
// 依赖：_helpers.js, model/node.js
// 不变量：**`childOrder` 是唯一真源**；`parentOf` 是派生索引，事务内用 `_helpers.parentOfInDraft`，
//   提交时由 `applyState` 整张重建（2026-10-18 起事务里**不再写** `draft.parentOf`，省掉一张 3.3 万键的拷贝）
// ================================================================
import { createNode } from '../model/node.js';
import {
    nextNodeId,
    ensureChildOrder,
    pushChild,
    ensureUniqueName,
    ensureUniqueProblemId,
    nextFreeProblemId,
    setParentOf                       // ★ 事务内的父指针（别写 `draft.parentOf`，见 `_helpers.js` 文件头）
} from './_helpers.js';
import { markOrigin, MANUAL_ORIGIN } from './origin.js';
import { recordManualValue } from './node.js';
import { setExpanded } from '../model/viewState.js';
import { setDerivedOverride } from '../fieldValue.js';
import { assertManualEditAllowed } from './account.js';

/**
 * 批量添加 P 节点到指定父节点（C/W/S）
 * @param {Object} draft - 状态草稿
 * @param {string} parentId - 父节点 id
 * @param {Array<Object>} pNodesData - [{ name, problemId?, ratio?, status2?, cfDifficulty?, link?, tags?, contestTime? }, ...]
 * @param {Object} options - { autoGenerateProblemId = true }
 * @returns {{ count: number, nodes: Object[] }}
 */
export function batchAddPNodes(draft, parentId, pNodesData, options = {}) {
    // 只读边界：批量建节点也是"手改"（数据是用户粘进去的）
    assertManualEditAllowed(draft, '批量导入题目');

    const { autoGenerateProblemId = true } = options;
    const parent = draft.nodes[parentId];
    if (!parent) throw new Error('父节点不存在');
    if (!['C', 'W', 'S'].includes(parent.type)) {
        throw new Error(`父节点类型 ${parent.type} 不允许添加题目`);
    }
    const validData = pNodesData.filter(item => {
        const hasName = item.name && String(item.name).trim() !== '';
        const hasId = item.problemId && String(item.problemId).trim() !== '';
        return hasName || hasId;
    });
    if (validData.length === 0) throw new Error('没有有效的 P 节点数据');

    const addedNodes = [];
    for (const item of validData) {
        const rawName = item.name ? String(item.name).trim() : '';
        let problemId = item.problemId ? String(item.problemId).trim() : '';
        if (autoGenerateProblemId && !problemId && parent.type === 'C') {
            problemId = nextFreeProblemId(draft, parentId);
        }
        const uniqueName = ensureUniqueName(draft, parentId, rawName || problemId || '题目');
        const uniqueProblemId = problemId
            ? ensureUniqueProblemId(draft, parentId, problemId)
            : '';

        const id = nextNodeId(draft);
        const node = createNode(id, 'P', {
            name: uniqueName,
            problemId: uniqueProblemId,
            ratio: item.ratio !== undefined ? String(item.ratio) : '',
            status2: item.status2 !== undefined ? item.status2 : 0,
            link: item.link || '',
            cfDifficulty: item.cfDifficulty || 0,
            tags: item.tags || []
        });
        pushChild(draft, parentId, id);
        setParentOf(draft, id, parentId);
        setExpanded(draft, parentId, true);
        draft.nodes[id] = node;
        ensureChildOrder(draft, id);
        // 手改留痕：这些值是从你粘的表格里来的 —— 存在性与字段值都算"你给的"。
        // 判据统一由 `recordManualValue`（core/ops/node.js）执行（派生元素自动排除）。
        markOrigin(node, { src: MANUAL_ORIGIN, account: draft.currentAccountId, at: node.createdAt });
        for (const key of ['name', 'problemId', 'ratio', 'cfDifficulty', 'link', 'tags', 'status2']) {
            if (item[key] === undefined) continue;      // 表格里没有这一列 → 不是"你给的"
            if (key === 'status2') {
                // `status2` 是派生元素（`recordManualValue` 会跳过），所以走覆盖入口：
                // 表格里写的值算不算"覆盖"由**属性表**判断，这里不写死名单。
                setDerivedOverride(node, 'status2', item.status2,
                    { at: node.createdAt, account: draft.currentAccountId });
                continue;
            }
            recordManualValue(draft, node, key, '', node[key], {});
        }
        addedNodes.push(node);
    }
    return { count: addedNodes.length, nodes: addedNodes };
}

// ================================================================
// 内部辅助
// ================================================================
// （同级重名 / 重号的规则在 `_helpers.js`，与新建、复制共用一套）