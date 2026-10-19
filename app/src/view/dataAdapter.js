// ================================================================
// 数据适配（view/dataAdapter.js）
// 职责：把 state + 当前上下文转成渲染所需的数据结构
// 依赖：view/helpers.js
// ================================================================
import { getNodePerPage } from './helpers.js';
import { structuralElements } from '../core/model/elements.js';
// ★ 孩子该走哪几个 = "屏蔽"的唯一判据（渲染这一侧看 `page.hideBlocked`）
import { childVNodesOf, structureSignatureOf } from '../core/model/page.js';
// ★ 每页一格的小上限记忆表（键 = 页 id，`prune` 收掉已删的页）
import { createSlots } from '../utils/memoSlots.js';

// ---- 提取 vNode 的非结构字段（供插件字段透传到合成节点） ----
// 结构字段由合成节点构造时显式覆盖，其余（插件字段）自动继承。
// ⚠️ 结构键**从属性表派生**（`nature === STRUCTURAL`），只额外加 vNode 专有的几个 ——
//    手抄名单会漂移：必须与 upsert 同源。
const STRUCTURAL_VNODE_KEYS = new Set([
    ...structuralElements(),
    'refId', 'children', 'parentId'      // vNode 专有（真实节点上没有这几个）
]);

function extractPluginFields(vNode) {
    const out = {};
    for (const k in vNode) {
        if (!STRUCTURAL_VNODE_KEYS.has(k)) {
            out[k] = vNode[k];
        }
    }
    return out;
}

/**
 * 获取当前上下文的数据（用于渲染）
 */
export function getDisplayData(state, options = {}) {
    const mode = options.mode || state.settings.mode.treeDisplayMode || 'tree';
    const pageId = options.pageId ?? state.currentPageId;
    const isVirtual = pageId !== 'main';

    if (!isVirtual) {
        return getMainData(state, mode, options);
    }
    return getVirtualData(state, pageId, mode, options);
}

// ================================================================
// 主页
// ================================================================

function getMainData(state, mode, options) {
    const root = state.nodes[state.rootId];
    if (!root) return { type: 'empty', pageId: 'main' };

    if (mode === 'tree') {
        return {
            type: 'tree',
            root,
            parentId: root.id,
            isVirtual: false,
            pageId: 'main'
        };
    }

    const folderCurrentId = options.folderCurrentId ?? null;
    const parentId = folderCurrentId || root.id;
    const parentNode = state.nodes[parentId];
    if (!parentNode) {
        return { type: 'empty', pageId: 'main' };
    }
    const children = collectChildren(state, parentId);
    return {
        type: 'list',
        nodes: children,
        parentId,
        parentNode,
        isVirtual: false,
        pageId: 'main',
        pagination: buildPaginationInfo(state, children, options.folderCurrentPage || 1)
    };
}

function collectChildren(state, parentId) {
    const childIds = state.childOrder[parentId];
    if (!childIds) return [];
    const out = [];
    for (const cid of childIds) {
        const c = state.nodes[cid];
        if (c) out.push(c);
    }
    return out;
}

// ================================================================
// 副页
// ================================================================

//: 副页"树"投影（`mode: 'tree'`）的那份缓存：**键 = 页 id + 结构签名 + 数据代**。
//: 为什么值得：它把整页 vNode **递归**建成投影对象（真包那页 5344 个 → 实测 ~18ms/趟）。
//: 为什么键里**不含展开态**：投影里那三格（`expanded` / `currentPage` / `selected`）是
//:   `bindLiveViewFlags` 做的**活取值器**，折叠时它们自己就变了 ⇒ 投影不必重建、折叠立刻生效。
//:   这正是"跟主页一样"：主页的展开态住 `state.view`（活的），所以投影可以按数据缓存。
const VIRTUAL_TREE_MEMO = createSlots();

function getVirtualData(state, pageId, mode, options) {
    const page = state.pages[pageId];
    if (!page) return { type: 'empty', pageId };

    if (mode === 'tree') {
        if (state.pages) VIRTUAL_TREE_MEMO.prune(Object.keys(state.pages));
        const sig = structureSignatureOf(page);
        const hit = VIRTUAL_TREE_MEMO.get(pageId);
        if (hit && hit.nodes === state.nodes && hit.sig === sig && hit.vStats === page.vNodeStats
            && hit.hideBlocked === !!page.hideBlocked && hit.settings === state.settings) {
            return hit.data;
        }
        const rootVNode = page.virtualIndex[page.rootId];
        if (!rootVNode) return { type: 'empty', pageId };
        const rootData = buildVirtualNodeRealData(state, pageId, rootVNode);
        if (!rootData) return { type: 'empty', pageId };
        const data = {
            type: 'tree',
            root: rootData,
            parentId: rootData.id,
            isVirtual: true,
            pageId
        };
        VIRTUAL_TREE_MEMO.set(pageId, {
            nodes: state.nodes, sig, vStats: page.vNodeStats,
            hideBlocked: !!page.hideBlocked, settings: state.settings, data
        });
        return data;
    }

    const folderCurrentId = options.folderCurrentId || page.rootId;
    const parentVNode = page.virtualIndex[folderCurrentId];
    if (!parentVNode) return { type: 'empty', pageId };

    const children = [];
    // ⚠️ 孩子一律过 `childVNodesOf`：它一处管着"**屏蔽**"（用户 2026-10-15：
    //    「不显示屏蔽的部分」勾上时屏蔽的支**不渲染**；统计那条另有 `purpose`）。
    for (const v of childVNodesOf(page, parentVNode, 'render')) {
        const synth = buildSyntheticNode(state, pageId, v);
        if (synth) children.push(synth);
    }

    return {
        type: 'list',
        nodes: children,
        parentId: folderCurrentId,
        parentNode: parentVNode,
        isVirtual: true,
        pageId,
        pagination: buildPaginationInfo(state, children, options.folderCurrentPage || 1)
    };
}

/**
 * 把"看的姿势"（展开 / 页码 / 选中）做成**活取值器**：每次读都回当前 `state.pages` 里那一格取。
 *
 * 为什么（用户 2026-10-18："副页的处理行为应与主页高度相似"）：主页的展开态住在 `state.view`（活的），
 * 所以"投影"可以按数据代缓存、折叠不必重建它。副页的 `expanded` 存在 vNode 上，若把它的值**拷贝**进
 * 投影对象，缓存就必须随折叠失效（否则折叠看起来没反应）。
 * ⇒ 投影只放**数据**、这三格改成 getter 现读 ⇒ 投影可以按结构签名缓存，折叠照旧立刻生效。
 */
function bindLiveViewFlags(obj, state, pageId, vId) {
    const cur = () => {
        const p = state.pages && state.pages[pageId];
        return (p && p.virtualIndex && p.virtualIndex[vId]) || null;
    };
    Object.defineProperty(obj, 'expanded', {
        get: () => { const v = cur(); return !!(v && v.expanded); },
        enumerable: true, configurable: true
    });
    Object.defineProperty(obj, 'currentPage', {
        get: () => { const v = cur(); return (v && v.currentPage) || 1; },
        enumerable: true, configurable: true
    });
    Object.defineProperty(obj, 'selected', {
        get: () => { const v = cur(); return !!(v && v.selected); },
        enumerable: true, configurable: true
    });
    return obj;
}

// ---- 合成节点（单层，供 folder 模式使用） ----
//
// 副页**可以指向一个合成节点**（`vNode.refId` = 合成节点的 id）——
// `...realNode` 会把它的 `synthKey`（身份）一并带过来，于是「📋」能认出它是合成节点、
// 节点信息界面照常渲染它的标题与字段。这就是"副页是看合并结果的入口"。
//
// ⚠️ 成员引用**不算子节点**：合成节点的成员挂在它们**实际所在的树上位置**，
//    只是靠 `ownerSynth` 指针归入 —— 这里给 `children: []` 与真实 `childOrder` 无关，
//    所以成员既不会出现在 `children` 里，也不会被折叠/重挂/计入子节点数。
//    要把成员**列出来**是另一件事（渲染区分），这里只保证"不被当成子节点"。
function buildSyntheticNode(state, pageId, vNode) {
    if (!vNode) return null;
    if (vNode.type === 'O') {
        return bindLiveViewFlags({
            ...extractPluginFields(vNode),
            id: vNode.id,
            type: 'O',
            name: `📂 ${state.pages[pageId]?.name || '副页'}`,
            children: [],
            _virtual: true,
            _virtualId: vNode.id,
            _pageId: pageId
        }, state, pageId, vNode.id);
    }
    if (!vNode.refId) return null;
    const realNode = state.nodes[vNode.refId];
    if (!realNode) return null;

    const vStats = state.pages[pageId]?.vNodeStats?.[vNode.id];

    return bindLiveViewFlags({
        ...realNode,
        ...extractPluginFields(vNode),
        id: vNode.id,
        _virtual: true,
        _virtualId: vNode.id,
        _refId: vNode.refId,
        _pageId: pageId,
        statusComplete1: vStats ? vStats.statusComplete1 : realNode.statusComplete1,
        statusComplete2: vStats ? vStats.statusComplete2 : realNode.statusComplete2,
        children: []
    }, state, pageId, vNode.id);
}

// ---- 递归构建虚拟子树（供 tree 模式使用） ----
function buildVirtualNodeRealData(state, pageId, vNode) {
    if (!vNode) return null;

    if (vNode.type === 'O') {
        const children = [];
        if (vNode.children) {
            for (const cid of vNode.children) {
                const child = state.pages[pageId]?.virtualIndex[cid];
                if (!child) continue;
                const built = buildVirtualNodeRealData(state, pageId, child);
                if (built) children.push(built);
            }
        }
        return bindLiveViewFlags({
            ...extractPluginFields(vNode),
            id: vNode.id,
            type: 'O',
            name: `📂 ${state.pages[pageId]?.name || '副页'}`,
            children,
            _virtual: true,
            _virtualId: vNode.id,
            _pageId: pageId
        }, state, pageId, vNode.id);
    }

    if (!vNode.refId) return null;
    const realNode = state.nodes[vNode.refId];
    if (!realNode) return null;

    const children = [];
    // ⚠️ 同上：孩子过 `childVNodesOf(page, …, 'render')`（"不显示屏蔽的部分"那个字段在这里生效）
    for (const child of childVNodesOf(state.pages[pageId], vNode, 'render')) {
        const built = buildVirtualNodeRealData(state, pageId, child);
        if (built) children.push(built);
    }

    const vStats = state.pages[pageId]?.vNodeStats?.[vNode.id];

    return bindLiveViewFlags({
        ...realNode,
        ...extractPluginFields(vNode),
        id: vNode.id,
        _virtual: true,
        _virtualId: vNode.id,
        _refId: vNode.refId,
        _pageId: pageId,
        statusComplete1: vStats ? vStats.statusComplete1 : realNode.statusComplete1,
        statusComplete2: vStats ? vStats.statusComplete2 : realNode.statusComplete2,
        children
    }, state, pageId, vNode.id);
}

// ================================================================
// 分页信息
// ================================================================

function buildPaginationInfo(state, array, currentPage = 1) {
    const nodePerPage = getNodePerPage(state.settings);
    const total = array.length;
    const pageCount = Math.ceil(total / nodePerPage) || 1;
    const page = Math.min(Math.max(currentPage, 1), pageCount);
    const start = (page - 1) * nodePerPage;
    const end = Math.min(page * nodePerPage, total);
    return { currentPage: page, pageSize: nodePerPage, total, pageCount, start, end };
}

/**
 * 取**某个副页虚拟节点**的展示用节点（只读、纯函数；找不到返回 null）。
 *
 * 与文件夹模式渲染虚拟节点用的是**同一份构造**（`buildSyntheticNode`）——
 * 「观察节点信息」大界面里"查看副页节点本身"就靠它（副页的 📋 要能选看
 * "所映射的主节点"还是"副页节点本身"）。
 * 注意它身上带 `_virtual / _virtualId / _refId / _pageId`，
 * 所以**能**渲染、但那些以真实节点为前提的操作（编辑/加子节点）仍不适用。
 */
export function getVirtualDisplayNode(state, pageId, vId) {
    const vNode = state && state.pages && state.pages[pageId]
        ? state.pages[pageId].virtualIndex[vId] : null;
    if (!vNode) return null;
    // ★ 给**整棵页内子树**（递归那一份 `buildVirtualNodeRealData`）：详页上的
    //   「📊 题目分布统计」「🏁 比赛补题概览」要在**副页子树上走**
    //   （`collectByType` 对投影节点走 `node.children`）—— 单层那份 `children` 是空的，
    //   两个视图会一个节点都收不到。渲染方框仍然只画这一层（`shallow`）。
    return buildVirtualNodeRealData(state, pageId, vNode);
}

// ---- 对外：构建副页虚拟子树（供选择器、导出等使用） ----
export function buildVirtualTreeRoot(state, pageId) {
    const page = state.pages[pageId];
    if (!page) return null;
    const vNode = page.virtualIndex[page.rootId];
    if (!vNode) return null;
    return buildVirtualNodeRealData(state, pageId, vNode);
}