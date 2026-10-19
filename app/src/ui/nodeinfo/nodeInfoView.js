// ================================================================
// 「观察节点信息」大界面（ui/nodeinfo/nodeInfoView.js）
//
// 布局：
//
//   ┌ 节点框（**直接渲染那个节点的方框**，与树上一模一样）+ id ┐
//   ├ 子 tab 栏：📋 完整字段表 | ✏️ 编辑 | 📂 子节点 | 📊 题目分布统计 | … ┤
//   └ 当前子视图内容（字段表也是其中之一，排在最左、默认选中）  ┘
//
// 与文件夹模式的**唯一区别**是"渲染到哪儿"：这里每个节点信息界面都自带一套容器
// （`ni-fields-*` / `ni-tree-*` / `ni-stats-*` / `ni-body-*`），视图通过 ctx 与 `scope` 指过去。
// 不这么做就会互相踩：文件夹页与节点页用的是同一个视图定义，容器/插件面板却按 id 单例。
//
// 会话级、只读观察：
//   · 不挂"点进文件夹"的处理器（`ctx.bindFolderClicks` 不传），点节点框不会改变主视图；
//   · 来源行的动作按钮（设为首选/标不用）仍可用 —— 那是改数据，不是改这个界面。
// ================================================================
import { AppState } from '../../shell/state.js';
import { EVENTS } from '../../A_constants.js';
import { tabContentId } from '../tabRegistry.js';
import { getDisplayData, getVirtualDisplayNode } from '../../view/dataAdapter.js';
import { escapeHtml } from '../../utils/html.js';
// 悬停提示也是给人看的字 ⇒ 统一去 Markdown 记号（实现只有一份）
import { plain } from '../../utils/text.js';
import { renderNode } from '../../view/renderers.js';
import { buildViewTabsHTML, bindViewTabEvents } from '../folder/folderShared.js';
import { getFolderViews } from '../folder/folderMode.js';
import { mountFolderView } from '../folder/folderViewHost.js';
// ★ 方框上那排按钮的委托**可以挂到任意容器**（详页不在 `#tree-container` 里，`v9.1.27`）
import { bindActionDelegation } from '../G_events.js';
import { renderNodeFieldsHtml } from './nodeFields.js';
import { mountNodeEdit } from './nodeEdit.js';
import { renderNodeGroupHtml, jumpTargetOf, breadcrumbHtml, stripTreeWiring } from './nodeGroup.js';
// ★ 「这个 id 能不能跳 / 跳到哪儿」的判据**各有唯一一份**，按 id 归属分：
//   · **副页页内 id**（`v_xxx`）⇒ `core/ops/page.js:locateVirtualNode`（"它在哪个副页里"）——
//     那串 id 在那一页里点一下就该**定位到页内那个位置**（用户 2026-10-13：副页头部**已经**
//     有一颗「🔎 跳到它引用的主节点」，蓝字再跳主节点就是同一件事两个入口）；
//   · **主树真实 id** ⇒ `core/ops/page.js:mainTreeNodeIdOf`（`realNodeIdOf` 解析 + 要求树上真有），
//     与下面那颗「🔎 跳到树上」走的 `jumpTargetOf` 是同一份。
import { locateVirtualNode, mainTreeNodeIdOf } from '../../core/ops/page.js';
// ★ 「跳到树上」的**承载**只有一份：`markGoto` 挂 `data-reveal-node`
//   （委托是 `nodeGroupActions.js` 的文档级那一条，本文件不必挂监听）
import { markGoto } from '../kit/actions.js';
// 来源行动作按钮的点击是**文档级委托**，在这里显式引入，免得"按钮在、点了没反应"
import '../G_modal/sourceActions.js';
// 同理：「🔎 跳到树上」也是文档级委托（`[data-reveal-node]`），本文件与 nodeGroup.js 都靠它
import './nodeGroupActions.js';
import { mk as mkBase } from '../../utils/dom.js';

/** 每个节点信息界面各自停在哪一个子视图上（会话级，不进行档） */
const viewByTab = new Map();

/**
 * 「完整字段表」是这个界面的**第一个子视图**。
 *
 * 它是本界面**自己**的视图，不进 `folderMode` 的视图清单 ——
 * 主视图的文件夹页不需要它（那是观察节点用的）。
 */
const FIELDS_VIEW_ID = 'node-fields';
const FIELDS_VIEW = {
    id: FIELDS_VIEW_ID,
    label: '📋 完整字段表',
    mount(ctx) {
        const host = ctx.fieldsContainer;
        if (!host) return;
        host.style.display = 'block';
        host.innerHTML = renderNodeFieldsHtml(ctx.node, ctx.state);
        if (ctx.treeBody) ctx.treeBody.style.display = 'none';
        if (ctx.statsContainer) ctx.statsContainer.style.display = 'none';
    }
};

/**
 * 「📋 副页节点信息」—— 副页节点**自己的**那一份（"两个都能看"）。
 *
 * 为什么单列一个视图而不是复用「完整字段表」：副页节点是**引用**，
 * `getVirtualDisplayNode` 出来的展示节点是"真实节点字段 + 页内字段"混在一起的，
 * 拿它跑字段表会显示**主节点**的字段表 —— 那正是另一条路（"查看所映射主树节点"）该干的事。
 * 这里只列**它自己**的页内身份：属于哪个副页、引用谁、选中/展开/页内位置、页内子节点数、现算统计。
 * 全是既有数据，没有新字段、没有新语义。
 */
const VNODE_FIELDS_VIEW_ID = 'node-vnode-fields';
const VNODE_FIELDS_VIEW = {
    id: VNODE_FIELDS_VIEW_ID,
    label: '📋 副页节点信息',
    mount(ctx) {
        const host = ctx.fieldsContainer;
        if (!host) return;
        host.style.display = 'block';
        host.innerHTML = renderVNodeFieldsHtml(ctx.node, ctx.state, ctx.pageId);
        if (ctx.treeBody) ctx.treeBody.style.display = 'none';
        if (ctx.statsContainer) ctx.statsContainer.style.display = 'none';
    }
};

/** 副页节点自己的信息（只读渲染，纯函数，便于断言） */
export function renderVNodeFieldsHtml(node, state, pageId) {
    const page = ((state && state.pages) || {})[pageId] || {};
    const v = ((page.virtualIndex) || {})[node.id] || {};
    const real = v.refId ? (((state && state.nodes) || {})[v.refId] || null) : null;
    const stats = ((page.vNodeStats) || {})[v.id || node.id] || null;
    const row = (k, val) =>
        `<tr><th style="text-align:left;padding:5px 14px 5px 0;color:#6b7280;white-space:nowrap;vertical-align:top;">${escapeHtml(k)}</th>` +
        `<td style="padding:5px 0;word-break:break-all;">${val}</td></tr>`;
    const dim = s => `<span style="color:#94a3b8">${escapeHtml(s)}</span>`;
    const rows = [
        row('所属副页', `${escapeHtml(page.name || '（未命名）')} ${dim('(' + pageId + ')')}`),
        row('节点类型', escapeHtml(v.type || node.type || '')),
        row('引用主节点', real
            ? `${escapeHtml(real.name || '（未命名）')} ${dim('(' + v.refId + ')')}`
            : '<span style="color:#b45309;">（根节点：代表这一页，不引用真实节点）</span>'),
        row('页内字段', `选中 ${v.selected ? '是' : '否'}｜展开 ${v.expanded ? '是' : '否'}｜当前页 ${v.currentPage || 1}`),
        row('页内子节点', `${(v.children || []).length} 个`),
        row('统计（本副页现算）', stats
            ? `statusComplete1 = ${stats.statusComplete1}｜statusComplete2 = ${stats.statusComplete2}`
            : dim('未计算'))
    ];
    return `<div style="padding:12px 16px;">
        <div style="margin-bottom:10px;color:#6b7280;font-size:13px;line-height:1.6;">
            副页节点是 <b>引用</b>：字段与子节点都在主树那个节点上；这里只列它<b>自己</b>的页内身份。<br>
            要看主节点，用 📋 时选「查看所映射主树节点」。
        </div>
        <table style="border-collapse:collapse;font-size:13px;">${rows.join('')}</table>
    </div>`;
}

/** 容器/作用域用的键：节点 id 里可能有怪字符，id 属性里不能带 */
function nodeKeyOf(nodeId) {
    return String(nodeId).replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * 「✏️ 编辑」是第二个子视图，排在字段表后面。
 *
 * 它**不是**另写的编辑模型：字段与规则都在 `ui/G_modal/editForm.js`，
 * 与编辑弹窗同一套（见 nodeEdit.js 的文件头）。
 */
const EDIT_VIEW_ID = 'node-edit';
const EDIT_VIEW = {
    id: EDIT_VIEW_ID,
    label: '✏️ 编辑',
    mount(ctx) {
        mountNodeEdit(ctx);
    }
};

/**
 * 「🔗 所在组」—— 这个节点属于哪个合成组、组里还有谁。
 *
 * 紧跟在「完整字段表」后面：它俩都是**观察**（只读），编辑排在它们之后。
 * 渲染是纯函数 `renderNodeGroupHtml`（在 `nodeGroup.js`），这里只管挂到自己的容器上。
 *
 * ⚠️ 只给**真实节点**：副页节点是引用，它的"组"属于被引用的那个真实节点
 * （那一页有「跳到它引用的主节点」按钮，跳过去就能看这一栏）。
 */
const GROUP_VIEW_ID = 'node-group';
const GROUP_VIEW = {
    id: GROUP_VIEW_ID,
    label: '🔗 所在组',
    mount(ctx) {
        const host = ctx.groupContainer;
        if (!host) return;
        // 名单里的每一行都是**只读节点框**（与顶部那一格、树上那一套同一份渲染）。
        // ⚠️ 由这里注入而不是 nodeGroup.js 自己 import：那边必须是**纯的**（纯 Node 单测），
        //    而 `view/renderers.js` 会拉进 immer ⇒ 纯 Node 里 import 不了。
        host.innerHTML = renderNodeGroupHtml(ctx.node, ctx.state, renderNodeBoxHtml);
    }
};

/** 只读节点框（跳转接线由 nodeGroup.js 摘掉重挂，见那边 `stripTreeWiring`） */
function renderNodeBoxHtml(node) {
    return renderNode(AppState, node, 0, [], null, true, 'folder-header');
}

/** 该 tab 当前选中的子视图 */
export function getNodeView(tabId) {
    return viewByTab.get(tabId) || FIELDS_VIEW_ID;
}

/** 界面关掉后忘掉它停在哪一页（会话级状态，别留着长草） */
export function forgetNodeView(tabId) {
    viewByTab.delete(tabId);
}

/**
 * 切到某个子视图（子 tab 栏的点击与外部调用共用这一条路径）
 *
 * 单独导出是为了让冒烟测试能驱动真实的切换：桩里的 DOM **不解析 innerHTML**，
 * 子 tab 栏那些按钮在桩里根本不存在，点不了 —— 只能从这条入口进。
 */
export function switchNodeView(tab, viewId) {
    if (viewByTab.get(tab.id) === viewId) return;
    viewByTab.set(tab.id, viewId);
    renderNodeInfoPanel(tab);
}

/**
 * 画一个节点信息界面。
 *
 * 每次都整块重建：字段值/来源会随导入与手改变，重建最省心；
 * 子视图的 DOM 本来也是每次 mount 重画的（与文件夹模式一致）。
 *
 * @param {{id:string, nodeId:string}} tab
 */
export function renderNodeInfoPanel(tab) {
    const container = document.getElementById(tabContentId(tab.id));
    if (!container) return;              // 容器由 tabs.js 的 ensureTabContent 建好

    // 主体可能是**真实节点**，也可能是**副页里的虚拟节点**（`isVirtual`，见 ui/tabs.js）：
    // 后者走 `getVirtualDisplayNode` 拿展示节点、scope 用副页 id（子节点/统计才在"这一页"里算）。
    const isVirtual = !!tab.isVirtual;
    const pageId = tab.pageId || 'main';
    const node = isVirtual
        ? getVirtualDisplayNode(AppState, pageId, tab.nodeId)
        : (AppState.nodes ? AppState.nodes[tab.nodeId] : null);
    if (!node) {
        container.innerHTML = '<div style="padding:16px;color:#94a3b8;">(节点不存在)</div>';
        return;
    }

    const s = nodeKeyOf(tab.nodeId);
    const scope = isVirtual ? pageId : `ni-${s}`;
    // 「跳到树上」落到**真实节点**上：副页里拿到的可能是页内虚拟 id（`v_xxx`），
    // 主视图里查不到它 —— 解析与"这一格出不出、写什么文案"都在 `jumpTargetOf`（纯函数，有单测）。
    const jump = jumpTargetOf(AppState, tab.nodeId, isVirtual);
    // 真实节点：字段表**排在最左**（它就是二级 tab 栏的第一个子视图），后面接「所在组」「✏️ 编辑」，
    // 再接文件夹模式那一整套；
    // 副页节点：第一格换成**它自己的页内信息**，「🔗 所在组」「✏️ 编辑」都不给（组属于真实节点；
    // 编辑虚拟节点走插件那条路，见 G7_vNodeEdit —— 真实节点那套 ops 在虚拟 id 上根本不存在）。
    const views = isVirtual
        ? [VNODE_FIELDS_VIEW, ...getFolderViews()]
        : [FIELDS_VIEW, GROUP_VIEW, EDIT_VIEW, ...getFolderViews()];
    const wanted = getNodeView(tab.id);
    const current = views.some(v => v.id === wanted) ? wanted : (views[0] ? views[0].id : wanted);
    viewByTab.set(tab.id, current);

    container.innerHTML = '';
    buildShell(container, node, s, jump, isVirtual);

    // 内置视图的容器由宿主统一收放（「字段表」「所在组」「编辑」各占一个）：
    // 别的视图（子节点/统计/插件页）的 mount 只知道自己那几个容器，收不了它们。
    const fieldsEl = document.getElementById(`ni-fields-${s}`);
    const fieldsViewId = isVirtual ? VNODE_FIELDS_VIEW_ID : FIELDS_VIEW_ID;
    if (fieldsEl) fieldsEl.style.display = current === fieldsViewId ? 'block' : 'none';
    const groupEl = document.getElementById(`ni-group-${s}`);
    if (groupEl) groupEl.style.display = current === GROUP_VIEW_ID ? 'block' : 'none';
    const editEl = document.getElementById(`ni-edit-${s}`);
    if (editEl) editEl.style.display = current === EDIT_VIEW_ID ? 'block' : 'none';

    const ctx = buildNodeViewContext(node, s, isVirtual ? pageId : 'main');
    renderViewTabsIn(tab, s, current, views);
    mountFolderView({
        views,
        viewId: current,
        ctx,
        scope,
        hostContainerId: `ni-body-${s}`,
        builtinContainerIds: [`ni-fields-${s}`, `ni-group-${s}`, `ni-edit-${s}`, `ni-tree-${s}`, `ni-stats-${s}`]
    });
    // ★ **详页里的节点方框也要能点**（`v9.1.27`，用户 2026-10-13："节点详页子节点的各按钮点不了了"）：
    //   这一页的头部那格与「子节点」那一栏都是 `renderNode` 出来的 `.node-box`（`stripTreeWiring`
    //   只摘 `id`/`data-id`）—— 而"方框按钮"的委托只挂在 `#tree-container` / `#folder-stats` 上，
    //   详页**不在**那两个容器里 ⇒ 📋/✏️/➕/⚙️/⬆/⬇ 全都没反应。
    //   修法与 `#folder-stats` 那次同一个口子：把同一个 `onActionClick` 接到这一页的容器上
    //   （幂等，靠 `dataset.delegated`；`#tab-nodeinfo*` 这个容器跨重画是稳定的）。
    bindActionDelegation(container);
}

/**
 * 造一个带 id/class/样式的小元素（id 走 setAttribute：冒烟桩靠它登记）。
 *
 * ⚠️ 这里只是 `utils/dom.js` 的 `mk` **加一个 id** 的薄壳（参数顺序与它不同：
 * 本文件惯用 `(tag, id, cls, style)`）—— 建元素那段样板**不要再抄一遍**。
 */
function mk(tag, id, cls, style) {
    const node = mkBase(tag, cls, style);
    if (id) node.setAttribute('id', id);
    return node;
}

/**
 * 大界面的外壳（**用 DOM 构造成真实元素**，不是拼 HTML 字符串）。
 *
 * 为什么不用 innerHTML：拼字符串的话，冒烟桩里这些容器**根本不存在**
 * （桩默认不解析 innerHTML），于是"挂载到哪儿""子 tab 栏有没有"全都测不到 ——
 * 而这里恰恰全是接线。`renderTabBar()` 当初也是为此改成 DOM 构造的。
 */
function buildShell(container, node, s, jump = null, isVirtual = false) {
    const root = mk('div', '', 'nodeinfo-view', 'padding:16px;');

    // 顶部 = **节点框本身**（与树上那个方框同一套渲染），不是另写一行标题
    // id 另起一行：紧贴在框后面会被框的宽度挤得忽左忽右，读起来费劲
    const head = mk('div', '', 'nodeinfo-head', 'margin-bottom:10px;');
    const box = mk('div', '', 'nodeinfo-nodebox', '');
    // ⚠️ **必须摘掉树上的接线**（`id="node-x"` + `.node-box` 的 `data-id`）：
    //    详页这一份与树上那一份**同 id 同属性** ⇒ 不摘的话
    //    `getElementById('node-x')` 可能拿到这一份（`isNodeRendered` 误判"已经画在树上"），
    //    而且当初 `findNodeBox` 全文档找时还会滚到这个**看不见的副本**上（G11）。
    //    摘掉之后方框就只剩外观 —— 跳转用下面那颗「🔎 跳到树上」（详见 `nodeGroup.js:stripTreeWiring`）。
    box.innerHTML = stripTreeWiring(renderNodeBoxHtml(node));
    head.appendChild(box);
    const idTag = mk('div', '', 'nodeinfo-node-id',
        'margin-top:4px;font-size:12px;color:#94a3b8;word-break:break-all;');
    // ★ 这串 id 是**可点入口**（蓝 = 链接 ⇒ 蓝了就必须真能点）：
    //   · **主树节点** ⇒ 跳到它在主树上的位置。判据只有一份 ——
    //     `core/ops/page.js:mainTreeNodeIdOf`（`realNodeIdOf` 解析 + 要求 `state.nodes` 里真有）；
    //     下面那颗「🔎 跳到树上」走的 `jumpTargetOf` 用的也是它。
    //   · **副页页内节点（`v_xxx`）** ⇒ `v9.0.17` 起改成**跳到该副页内的对应位置**
    //     （用户 2026-10-13：副页头部**已经**有一颗「🔎 跳到它引用的主节点」，蓝字再跳主节点
    //     就是同一件事两个入口 ⇒ 蓝字改指**页内位置**）。归属判据用现成的
    //     `core/ops/page.js:locateVirtualNode`（"它在哪个副页的 virtualIndex 里"），
    //     定位由 `ui/revealNode.js:revealNode` 接（它也认页内 id，会切到那一页再页内定位）——
    //     承载仍是同一种 `data-reveal-node`，**没有第二种标记、也没有第二种委托**。
    //   · **解析不出**（副页根节点 / 节点已删）⇒ 保持灰的纯文本，**不留假链接**
    //     （假链接比纯文本更糟，见 `ui/kit/report.js:nodeOrText` 的文件头）；
    //   · 承载只用 `data-reveal-node`（`ui/kit/actions.js:markGoto` 挂的**唯一一份**）——
    //     接住它的是 `ui/nodeinfo/nodeGroupActions.js` 那条**文档级**委托，
    //     所以这里不挂监听、也不派发 `REVEAL_NODE`。
    //   ⚠️ 可点的只是**里面那个 span**，外层的 `.nodeinfo-node-id` 一个字都不动
    //     （它是别处按 class 找的那一格，也是"id 另起一行"的那一块）。
    // ⚠️ 副页**根节点**（`v_root`，`type === 'O'`：它代表"这一页"本身）在那一页上
    //    不画方框（`renderVirtualPage` 把根当"当前文件夹"而不是列表里的一个）⇒ 不给链接。
    //    判据用 `type`（与 `ui/folder/virtualFolderMode.js:virtualClickHandler` 判"回根"同一套），
    //    不用 `parentId`：根与非根的**语义**差别是 type，`parentId` 只是顺带的形状。
    const vHit = locateVirtualNode(AppState, node.id);
    const idJump = vHit
        ? (vHit.vNode && vHit.vNode.type !== 'O' ? node.id : '')
        : mainTreeNodeIdOf(AppState, node.id);
    if (idJump) {
        // ⚠️ 本文件的 `mk` 是 `(tag, id, cls, style)` 那个薄壳（见它自己的注释），
        //    与 `utils/dom.js` 的 `mk(tag, cls, css)` **签名不同** —— 别少传一个参数，
        //    否则那串样式会落到 `className` 上（实测踩到）。
        const link = mk('span', '', 'nodeinfo-node-id-link',
            'color:#1d4ed8; text-decoration:underline;');
        link.textContent = node.id;
        markGoto(link, idJump);          // 观感（蓝 + pointer + title）与承载都从这一份来
        idTag.appendChild(link);
    } else {
        idTag.textContent = node.id;
    }
    head.appendChild(idTag);
    // 「🔎 跳到树上」—— 跳树只有一条路（派发 `EVENTS.REVEAL_NODE`，见 ui/revealNode.js），
    // 点击由 `nodeGroupActions.js` 的文档级委托接住。
    // ⚠️ 副页节点这一格给的是**它引用的真实节点**的 id：不解析的话主视图里查不到 `v_xxx`
    //    （解析在 `jumpTargetOf`，纯函数、有单测）。
    const target = jump || { canJump: false };
    if (target.canJump) {
        const btn = mk('button', '', 'btn nodeinfo-jump',
            'margin-top:6px;font-size:12px;padding:2px 10px;');
        btn.setAttribute('data-reveal-node', target.id);
        btn.setAttribute('title', plain('在主视图里展开祖先链、滚到它并高亮'));
        btn.textContent = target.label;
        head.appendChild(btn);
    }
    // ★ **所选节点的面包屑**（"节点详页 + 所选节点面包屑"）：来源树 + 祖先路径，每段可点跳树。
    //   放**头部**（不是某一栏里）⇒ 切到哪个子视图都看得到"这个节点在树上哪"。
    //   ⚠️ 排在「跳到树上」**之后**：那一格是动作，紧跟着 id 更顺；面包屑是"它在哪"的说明。
    //   ⚠️ 副页节点不给：它的祖先链在**那一页**里（`vNode.parentId`），不在 `parentOf` 上 ——
    //      硬渲染只会得到"（就在根下）"这种假话；"它在树上哪"看上面那格
    //      「🔎 跳到它引用的主节点」（那才解析到真实节点）。
    if (!isVirtual) {
        const crumb = mk('div', '', 'nodeinfo-crumb', 'margin-top:2px;');
        crumb.innerHTML = breadcrumbHtml(AppState, node);
        head.appendChild(crumb);
    }
    root.appendChild(head);

    // 子 tab 栏：与文件夹模式同一层（字段表排在最左，见 FIELDS_VIEW）
    root.appendChild(mk('div', `ni-tabs-${s}`));

    // 子视图容器：内置视图各占一个，插件视图的面板挂在 body 里
    const body = mk('div', `ni-body-${s}`);
    body.appendChild(mk('div', `ni-fields-${s}`));
    body.appendChild(mk('div', `ni-group-${s}`, '', 'display:none;'));
    body.appendChild(mk('div', `ni-edit-${s}`));
    body.appendChild(mk('div', `ni-tree-${s}`));
    body.appendChild(mk('div', `ni-stats-${s}`, '', 'display:none;'));
    root.appendChild(body);

    container.appendChild(root);
}

/** 子 tab 栏（与文件夹模式同一套按钮样式与点击绑定，只是容器不同） */
function renderViewTabsIn(tab, s, current, views) {
    const container = document.getElementById(`ni-tabs-${s}`);
    if (!container) return;
    container.innerHTML = buildViewTabsHTML(current, views);
    bindViewTabEvents(container, (view) => {
        switchNodeView(tab, view);
    });
}

/**
 * 传给视图 mount 的上下文。
 *
 * ⚠️ 与 `folderMode.buildFolderViewContext()` 是**同一份契约的两处实现**：
 * 那边指向主视图的固定容器，这边指向本界面自己的容器。
 * 往 ctx 里加字段时两处都要看。
 */
function buildNodeViewContext(node, s, pageId = 'main') {
    const folderData = getDisplayData(AppState, {
        mode: 'folder',
        pageId,
        folderCurrentId: node.id,
        folderCurrentPage: 1
    });
    return {
        source: 'nodeinfo',
        state: AppState,
        pageId,
        nodeId: node.id,
        node,
        isRoot: node.type === 'O',
        folderData,
        fieldsContainer: document.getElementById(`ni-fields-${s}`),
        groupContainer: document.getElementById(`ni-group-${s}`),
        editContainer: document.getElementById(`ni-edit-${s}`),
        treeBody: document.getElementById(`ni-tree-${s}`),
        statsContainer: document.getElementById(`ni-stats-${s}`),
        viewTabsContainer: document.getElementById(`ni-tabs-${s}`),
        treeBodyId: `ni-tree-${s}`,
        statsContainerId: `ni-stats-${s}`,
        subTabsId: `ni-subtabs-${s}`,
        refresh: () => document.dispatchEvent(new CustomEvent(EVENTS.UI_REFRESH_REQUIRED))
    };
}
