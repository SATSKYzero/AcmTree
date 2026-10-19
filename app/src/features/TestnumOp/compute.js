// ================================================================
// TestnumOp 计算规则
// ================================================================
import { DEFAULT_TESTNUM } from './constants.js';

// ---- 主树节点：testNumSum = 自身 + 所有子节点的 testNumSum ----
export function computeTestNumSum(draft, node) {
    let sum = node.testNum ?? DEFAULT_TESTNUM;
    for (const cid of draft.childOrder[node.id]) {
        const child = draft.nodes[cid];
        if (child) {
            sum += child.testNumSum ?? 0;
        }
    }
    return sum;
}

// ---- 副页 vNode：testNumSum = 自身 + 所有子 vNode 的 testNumSum ----
export function computeVNodeTestNumSum(draft, page, vNode) {
    let sum = vNode.testNum ?? DEFAULT_TESTNUM;
    if (vNode.children && Array.isArray(vNode.children)) {
        for (const cid of vNode.children) {
            const child = page.virtualIndex[cid];
            if (child) {
                sum += child.testNumSum ?? 0;
            }
        }
    }
    return sum;
}