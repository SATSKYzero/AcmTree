// ================================================================
// TestnumOp 渲染槽
// ================================================================
import { DEFAULT_TESTNUM } from './constants.js';

const BOX_STYLE = 'display:inline-flex; align-items:center; justify-content:center; width:22px; height:22px; border:2px solid #000; border-radius:4px; font-size:14px; font-weight:700; color:#1e293b; margin-right:4px;';

export function renderTestnumBoxes(state, ctx) {
    const node = ctx.node;
    const testNum = node.testNum ?? DEFAULT_TESTNUM;
    const testNumSum = node.testNumSum ?? 0;

    return `<span style="${BOX_STYLE} background:#dbeafe;">${testNum}</span>`
         + `<span style="${BOX_STYLE} background:#fce7f3;">${testNumSum}</span>`;
}