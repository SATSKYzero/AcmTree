// ================================================================
// 节点渲染分发（view/renderers.js）
// 职责：各类型节点渲染函数，以及递归渲染子节点
// 依赖：view/builders.js, view/helpers.js, A_constants.js
// ================================================================
import { TYPE_BADGE_MAP, STATUS2_COLORS, CONTAINER_STATUS_COLORS, RESULT_COLORS, RESULT_COLOR_UNKNOWN } from '../A_constants.js';
import {
    renderNodeBox,
    buildToggleButton,
    buildActions,
    ensureCurrentPage,
    getNodePerPage,
    getChildNodes,
    isNodeExpanded
} from './helpers.js';
import {
    buildPNodeTitle, buildPNodeMeta,
    buildRNodeTitle, buildRNodeMeta,
    buildCNodeTitle, buildCNodeMeta,
    buildWSNodeTitle, buildWSNodeMeta,
    buildPaginationHtml
} from './builders.js';
import { viewValue, viewDerived, viewDerivedDisplay } from './scope.js';
// ★ 「这条提交被忽略了吗」——**与派生那条链同一个函数**（第 4 种 AC 时间规则）
import { acTimeRuleOf, isSubmissionIgnored } from '../core/acTimeRule.js';
// ★ 诊断（`localStorage.DSH_DIAG = '1'` + 刷新；见 `utils/diag.js` 文件头）
import { diagOn, nowMs } from '../utils/diag.js';

// ================================================================
// 诊断：**单行渲染成本**的分段累加（2026-10-18，用户："拆 renderNode 单行成本"）
//
// 为什么要有它：冷切副页 ~300ms 里 `renderTreeView` 占 ~198ms，而它只拼出 2 万字符 ⇒
//   慢的不是字符串，是**每一行**的活（副页根下 3000 个 vNode，折 ~66µs/行）。
//   这里把一行拆成：标题 / 元信息 / 折叠按钮 / 操作按钮 / 子节点（含递归）/ 两个色条 / 外框。
// ⚠️ 只在 `diagOn()` 为真时计时（关着时**一次 `performance.now()` 都不调**，不是"记了不打印"）。
// ⚠️ 累加器是模块级的：调用方（`viewRenderers.renderTreeView`）在每趟开头 `resetRenderSegments()`、
//    结尾 `renderSegmentsOf()`。**纯诊断，不参与任何判定**。
// ================================================================
const SEG = { byType: {}, nByType: {}, kids: 0 };
export function resetRenderSegments() {
    for (const k of Object.keys(SEG)) {
        if (k === 'byType' || k === 'nByType') continue;
        delete SEG[k];                       // 分段键是动态的（`W/S.标题` 这种），整片清掉
    }
    SEG.byType = {};
    SEG.nByType = {};
    SEG.kids = 0;
}
export function renderSegmentsOf() {
    return { ...SEG, byType: { ...SEG.byType }, nByType: { ...SEG.nByType } };
}
/** 记一段并返回新的时间戳（`on` 为假时原样返回，不做任何计时） */
function seg(on, name, t0) {
    if (!on) return t0;
    const t = nowMs();
    SEG[name] = (SEG[name] || 0) + (t - t0);
    return t;
}

// ----- 构建子节点 HTML（递归调用 renderNode，支持分页） -----
function buildChildrenHtml(state, node, shallow, mode) {
    if (mode !== 'full' || shallow || !isNodeExpanded(state, node)) return '';
    // 诊断：这一整段（含递归）的耗时记进 `SEG.kids` —— `renderNode` 用"总时长 − 子节点时长"
    //   算**自身**成本，否则嵌套行会被重复计数（实测 `W/S 10行/367ms` 比整个循环 196ms 还大）。
    const on = diagOn();
    const k0 = on ? nowMs() : 0;
    const res = buildChildrenHtmlInner(state, node, mode);
    if (on) SEG.kids += nowMs() - k0;
    return res;
}

function buildChildrenHtmlInner(state, node, mode) {
    const children = getChildNodes(state, node);
    if (children.length === 0) return '';

    const nodePerPage = getNodePerPage(state.settings);
    const total = children.length;
    const pageCount = Math.ceil(total / nodePerPage) || 1;
    // ⚠️ 页码是**算出来**的，不写回节点（渲染路径不许改 state）
    const currentPage = ensureCurrentPage(state, node);

    const start = (currentPage - 1) * nodePerPage;
    const end = Math.min(currentPage * nodePerPage, total);
    const pageChildren = children.slice(start, end);

    let html = '';

    if (pageCount > 1) {
        html += buildPaginationHtml(state, node, pageCount, currentPage, total);
    }

    const items = pageChildren.map((child, i) =>
        renderNode(state, child, start + i, children, node.id, false, 'full')
    );
    html += items.join('');

    return `<div class="node-children">${html}</div>`;
}

// ----- P 节点渲染 -----
export function renderPNode(state, node, index, parentArray, parentId, shallow, mode = 'full', disabled = false, currentFolderId = null) {
    const badgeText = TYPE_BADGE_MAP[node.type] || '';
    const isVirtual = node._virtual === true;

    // 诊断（单行成本的分段；关着时全部零成本）—— 见文件头那段
    const on = diagOn();
    let t = on ? nowMs() : 0;

    const titleHtml = buildPNodeTitle(state, node);
    t = seg(on, 'P.标题', t);
    const metaHtml = buildPNodeMeta(state, node);
    t = seg(on, 'P.元信息', t);

    const toggleBtnHtml = buildToggleButton(state, node, mode);
    t = seg(on, 'P.折叠钮', t);
    const actionsHtml = buildActions(state, node, index, parentArray, isVirtual, mode, disabled, currentFolderId);
    t = seg(on, 'P.操作钮', t);
    const childrenHtml = buildChildrenHtml(state, node, shallow, mode);
    t = seg(on, 'P.子节点', t);

    // ★「合并显示」：这两个字段是 `GROUP_FIELDS` ⇒ 颜色条 / 状态条
    //   跟着**计数模式**走（去重模式 ⇒ 显示的是一整组的状态；`plain` ⇒ 每个节点各显示各的）。
    const colorBarColor = STATUS2_COLORS[viewDerivedDisplay(state, node, 'status2')] || '#ffffff';
    const statusBarClass = (viewDerivedDisplay(state, node, 'status1') === 1) ? 'active' : '';
    t = seg(on, 'P.色条', t);

    const out = renderNodeBox({
        node,
        titleHtml,
        metaHtml,
        colorBarColor,
        statusBarClass,
        badgeText,
        toggleBtnHtml,
        actionsHtml,
        childrenHtml
    });
    seg(on, 'P.外框', t);
    return out;
}

// ----- R 节点渲染 -----
export function renderRNode(state, node, index, parentArray, parentId, shallow, mode = 'full', disabled = false, currentFolderId = null) {
    const badgeText = TYPE_BADGE_MAP[node.type] || '';
    const isVirtual = node._virtual === true;

    const titleHtml = buildRNodeTitle(state, node, parentId);
    const metaHtml = buildRNodeMeta(state, node);

    const toggleBtnHtml = buildToggleButton(state, node, mode);
    const actionsHtml = buildActions(state, node, index, parentArray, isVirtual, mode, disabled, currentFolderId);
    const childrenHtml = buildChildrenHtml(state, node, shallow, mode);

    // R 的 status 是**值级字段**（带账户）→ 走视图读取器；
    // 颜色条用的是派生字段（status2 / statusComplete）→ 按登录账户口径
    const colorBarColor = RESULT_COLORS[viewValue(state, node, 'status')] || RESULT_COLOR_UNKNOWN;
    const statusBarClass = '';
    // ★ **被忽略的提交 ⇒ 整体变淡**（`v9.1.26`，用户 2026-10-13："提交…只是按条件判断
    //   （提交是否忽略）**整体渲染变淡**"）。
    //   判据只有一处：`core/acTimeRule.js` 的 `isSubmissionIgnored`（与派生那条链**同一个函数**）
    //   —— 树上的观感与"算不算数"必须是同一个判断，否则又会出现"看着算进去了/其实没算"。
    //   用的是**屏幕上那个时间**（`viewValue`），因为用户比对的正是自己看到的那一行。
    const dimmed = isSubmissionIgnored(viewValue(state, node, 'time'), acTimeRuleOf(state.settings));

    return renderNodeBox({
        node,
        titleHtml,
        metaHtml,
        colorBarColor,
        statusBarClass,
        badgeText,
        toggleBtnHtml,
        actionsHtml,
        childrenHtml,
        dimmed
    });
}

// ----- C 节点渲染 -----
export function renderCNode(state, node, index, parentArray, parentId, shallow, mode = 'full', disabled = false, currentFolderId = null) {
    const badgeText = TYPE_BADGE_MAP[node.type] || '';
    const isVirtual = node._virtual === true;
    const on = diagOn();
    let t = on ? nowMs() : 0;

    const titleHtml = buildCNodeTitle(state, node);
    t = seg(on, 'C.标题', t);
    const metaHtml = buildCNodeMeta(state, node);
    t = seg(on, 'C.元信息', t);

    const toggleBtnHtml = buildToggleButton(state, node, mode);
    t = seg(on, 'C.折叠钮', t);
    const actionsHtml = buildActions(state, node, index, parentArray, isVirtual, mode, disabled, currentFolderId);
    t = seg(on, 'C.操作钮', t);
    const childrenHtml = buildChildrenHtml(state, node, shallow, mode);
    t = seg(on, 'C.子节点', t);

    // ★ 容器的两格**跟显示口径**（判重 ⇒ 组那份）：`statusComplete1/2` 是"这场/这一层是不是
    //   全处理/全过"，判重模式下它就是"一处 AC ⇒ 整组亮"（`view/scope.js` 的「合并显示」那节）。
    //   ⚠️ 以前这里读 `viewDerived`（靠前那份）⇒ 真包实测 **11 / 2026** 个容器与树上别处不一致
    //   （方向全是"组那份更大"= 跨平台同一场比赛的另一份过了、这里不亮）。
    const colorBarColor = CONTAINER_STATUS_COLORS[viewDerivedDisplay(state, node, 'statusComplete2')] || '#ffffff';
    const statusBarClass = (viewDerivedDisplay(state, node, 'statusComplete1') === 1) ? 'active' : '';
    t = seg(on, 'C.色条', t);

    const out = renderNodeBox({
        node,
        titleHtml,
        metaHtml,
        colorBarColor,
        statusBarClass,
        badgeText,
        toggleBtnHtml,
        actionsHtml,
        childrenHtml
    });
    seg(on, 'C.外框', t);
    return out;
}

// ----- W/S 节点渲染 -----
export function renderWSNode(state, node, index, parentArray, parentId, shallow, mode = 'full', disabled = false, currentFolderId = null) {
    const badgeText = TYPE_BADGE_MAP[node.type] || '';
    const isVirtual = node._virtual === true;
    const on = diagOn();
    let t = on ? nowMs() : 0;

    const titleHtml = buildWSNodeTitle(state, node);
    t = seg(on, 'W/S.标题', t);
    const metaHtml = buildWSNodeMeta(state, node);
    t = seg(on, 'W/S.元信息', t);

    const toggleBtnHtml = buildToggleButton(state, node, mode);
    t = seg(on, 'W/S.折叠钮', t);
    const actionsHtml = buildActions(state, node, index, parentArray, isVirtual, mode, disabled, currentFolderId);
    t = seg(on, 'W/S.操作钮', t);
    const childrenHtml = buildChildrenHtml(state, node, shallow, mode);
    t = seg(on, 'W/S.子节点', t);

    // 同 C 那两格：容器状态走显示口径（判重 ⇒ 组那份），见 `renderCNode` 里的注释
    const colorBarColor = CONTAINER_STATUS_COLORS[viewDerivedDisplay(state, node, 'statusComplete2')] || '#ffffff';
    const statusBarClass = (viewDerivedDisplay(state, node, 'statusComplete1') === 1) ? 'active' : '';
    t = seg(on, 'W/S.色条', t);

    const out = renderNodeBox({
        node,
        titleHtml,
        metaHtml,
        colorBarColor,
        statusBarClass,
        badgeText,
        toggleBtnHtml,
        actionsHtml,
        childrenHtml
    });
    seg(on, 'W/S.外框', t);
    return out;
}

// ----- 主渲染分发器 -----
export function renderNode(state, node, index, parentArray, parentId, shallow = false, mode = 'full', disabled = false, currentFolderId = null) {
    if (!node) return '';
    // 诊断（2026-10-18）：**按类型**记一趟（含递归里的每一行）—— 用户那页 `P行 0 个` 说明
    //   "慢的行不是 P"，所以必须按类型分开记，否则永远只看到 0。（关着时零成本）
    const on = diagOn();
    const t = on ? nowMs() : 0;
    const kids0 = on ? SEG.kids : 0;
    let out;
    switch (node.type) {
        case 'P': out = renderPNode(state, node, index, parentArray, parentId, shallow, mode, disabled, currentFolderId); break;
        case 'R': out = renderRNode(state, node, index, parentArray, parentId, shallow, mode, disabled, currentFolderId); break;
        case 'C': out = renderCNode(state, node, index, parentArray, parentId, shallow, mode, disabled, currentFolderId); break;
        case 'W':
        case 'S': out = renderWSNode(state, node, index, parentArray, parentId, shallow, mode, disabled, currentFolderId); break;
        default: out = ''; break;
    }
    if (on) {
        const key = (node.type === 'W' || node.type === 'S') ? 'W/S' : node.type;
        // **自身**成本 = 总时长 − 这趟里花在子节点上的时长（否则嵌套行重复计数）
        const self = (nowMs() - t) - (SEG.kids - kids0);
        SEG.byType[key] = (SEG.byType[key] || 0) + (self > 0 ? self : 0);
        SEG.nByType[key] = (SEG.nByType[key] || 0) + 1;
    }
    return out;
}