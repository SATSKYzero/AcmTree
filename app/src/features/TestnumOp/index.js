// ================================================================
// TestnumOp 插件入口
// 职责：向核心注册所有钩子
// 依赖：core/pluginRegistry.js 由 bootstrap 以 api 参数注入
// ================================================================
import { DEFAULT_TESTNUM } from './constants.js';
import { computeTestNumSum, computeVNodeTestNumSum } from './compute.js';
import { createNodeEditExtension, createVNodeEditExtension } from './editExtension.js';
import { renderTestnumBoxes } from './renderSlot.js';

export function activateTestnumOp(api) {
    // ---- Migration：补默认值 ----
    api.registerNodeMigration(node => {
        if (node.testNum === undefined) node.testNum = DEFAULT_TESTNUM;
    });
    api.registerVNodeMigration(vNode => {
        if (vNode.testNum === undefined) vNode.testNum = DEFAULT_TESTNUM;
    });

    // ---- Compute：testNumSum ----
    api.registerComputeRule('*', 'testNumSum', computeTestNumSum);
    api.registerVNodeComputeRule('*', 'testNumSum', computeVNodeTestNumSum);

    // ---- 编辑扩展 ----
    api.registerNodeEditorExtension(createNodeEditExtension());
    api.registerVNodeEditorExtension(createVNodeEditExtension());

    // ---- 渲染槽 ----
    // ⚠️ 契约：注册槽要用 `api.RENDER_SLOTS` 常量，别硬编码字符串。
    api.registerRenderSlot(api.RENDER_SLOTS.NODE_SELECT_DOT_BEFORE, renderTestnumBoxes);
}