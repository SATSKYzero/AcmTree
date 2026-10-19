// ================================================================
// TestnumOp 编辑扩展
// ================================================================
import { DEFAULT_TESTNUM, TESTNUM_MIN, TESTNUM_MAX } from './constants.js';

function parseTestNum(raw) {
    if (raw === undefined || raw === null || String(raw).trim() === '') {
        return DEFAULT_TESTNUM;
    }
    const v = parseInt(raw);
    if (isNaN(v)) return null;
    if (v < TESTNUM_MIN || v > TESTNUM_MAX) return null;
    return v;
}

// ---- 主树节点编辑扩展 ----
export function createNodeEditExtension() {
    return {
        nodeTypes: ['*'],
        fields: [{
            key: 'testNum',
            label: 'Testnum',
            type: 'number',
            min: TESTNUM_MIN,
            max: TESTNUM_MAX,
            default: DEFAULT_TESTNUM
        }],
        apply: (draft, nodeId, formData) => {
            const v = parseTestNum(formData.testNum);
            if (v === null) return;
            const node = draft.nodes[nodeId];
            if (node) node.testNum = v;
        }
    };
}

// ---- 副页 vNode 编辑扩展 ----
export function createVNodeEditExtension() {
    return {
        vNodeTypes: ['*'],
        fields: [{
            key: 'testNum',
            label: 'Testnum（副页）',
            type: 'number',
            min: TESTNUM_MIN,
            max: TESTNUM_MAX,
            default: DEFAULT_TESTNUM
        }],
        apply: (draft, pageId, vId, formData) => {
            const v = parseTestNum(formData.testNum);
            if (v === null) return;
            const page = draft.pages[pageId];
            if (!page) return;
            const vNode = page.virtualIndex[vId];
            if (vNode) vNode.testNum = v;
        }
    };
}