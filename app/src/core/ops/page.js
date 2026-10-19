// ================================================================
// 副页操作（core/ops/page.js）
// 职责：创建/删除/重命名副页，复制/删除/移动虚拟节点
// 依赖：_helpers.js, model/page.js, core/pluginRegistry.js, core/ops/account.js（只读守卫）
//
// 只读边界：副页里的结构改动**同样是手改** ——
// 删一个副页、把节点复制进来、移动/删除虚拟节点，都会改到用户数据（并且会随存档走）。
// 所以本文件每个"改结构"的入口都过 `assertManualEditAllowed`，与 `tree.js` 完全对称。
// ⚠️ 守卫必须在这一层：副页整条链（含 4 个 UI 调用点）不在这里拦，
//    在"只看别人"时就全都能改 —— 这是一处系统性缺口。
//
// 刻意**不**加守卫的两个（与 `core/ops/view.js` 的选中/展开同类）：
//   - `setPageSelected`：选中态是视图状态，不影响数据含义；
//   - `cleanDeletedRealNode`：删真实节点时的**自动清理**，运行在已过守卫的事务里。
// ================================================================
import { createPage as createPageObject, createVNode } from '../model/page.js';
import { nextPageId, nextVirtualRootId, nextVirtualId, parentOfInDraft } from './_helpers.js';
// ★ 建页时要顺手建它那一份计划（一对一模型）—— 只借这一个函数，不把计划那一摊拉进来
//   （`ops/plan.js` **不** import 本文件 ⇒ 不成环）
import { ensurePagePlan } from './plan.js';
import { MAX_PAGES } from '../../A_constants.js';
import { getNowStr } from '../../utils/time.js';
import { runVNodeCopyHooks } from '../pluginRegistry.js';
import { assertManualEditAllowed } from './account.js';
// ★ 主树那一半祖先链的**唯一一份实现**（走 `parentOf`）—— 下面的 `nodeAncestorsOf` 按归属分流时用它。
//   ⚠️ 只能从**文件**引它、别从 `core/query/index.js` 那个桶引（桶会把这个只读层拉宽）；
//      `core/query/nodes.js` 本身**零依赖**（文件头写着"依赖：无"）⇒ 这里不会绕成环。
import { getAncestorsRootFirst } from '../query/nodes.js';

// ---- 创建副页 ----
export function addPage(draft, name) {
    assertManualEditAllowed(draft, '新建副页');
    const trimmed = String(name || '').trim();
    if (!trimmed) throw new Error('副页名称不能为空');
    for (const pid in draft.pages) {
        if (draft.pages[pid].name === trimmed) {
            throw new Error(`副页名称 "${trimmed}" 已存在`);
        }
    }
    const id = nextPageId(draft);
    const rootId = nextVirtualRootId(draft);
    const page = createPageObject(id, trimmed, rootId);
    page.virtualIndex[rootId] = createVNode(rootId, null, 'O', null);
    draft.pages[id] = page;
    // ★ 副页与计划**一对一**（用户 2026-10-15 定的模型：计划是副页的一部分、没有增删界面）
    //   ⇒ 建页就自带一份**默认初始状态**的计划（幂等；写路径才做，渲染里不做）。
    //   口径见 `docs/training-plan.md` 的「14. 2026-10-15 用户新反馈（三条 · 分析稿）」那一节。
    ensurePagePlan(draft, id);
    return page;
}

// ---- 复制整个副页 ----
/**
 * 把**一个副页整份复制**成另一个副页（内容 + 结构 + 视图态；**不复制真实节点、不复制计划**）。
 *
 * 用户 2026-10-13 的任务："副页复制 / 整个副页复制"。口径与边界写在 `docs/subpage-copy.md`：
 *   · **结构逐字保留**：父子关系、`children` 顺序、`refId`、`type` 一起搬；
 *   · **所有页内 id 重新发**（`page` / 根 / 每个 vNode）—— 靠一张 `旧→新` 映射**建第二遍**。
 *     ⚠️ **绝不许复用旧 id**：`locateVirtualNode` 是按"页内 id 全局唯一"找页的，复用会让两页互相认领；
 *   · `refId` **原样保留** ⇒ 新旧两页指向**同一批真实节点**（"复制题单"的意思就是"同一批题、两份排布"）；
 *   · 视图态（每个 vNode 的 `expanded` / `currentPage` / `selected`，以及页的 `selected`）**一起复制**；
 *   · **不复制** `createdAt`（新页就是现在建的）、**不复制** `view.pages[id]` 与 UI 运行态、
 *     **不复制计划的内容**（源计划的参数不搬）—— 但一对一的模型下**副本会自带一份默认计划**
 *     （见 `ops/plan.js:ensurePagePlan`；`v9.4.16` 起，用户 2026-10-15 定的口径）。
 *
 * ⚠️ 上限用**与新建同一条**（`MAX_PAGES`）：复制也是新建一个副页。
 *
 * @param {Object} draft
 * @param {string} sourcePageId - 要复制的副页 id
 * @param {string} [newName] - 新副页名；空 ⇒ 原名 + 「副本」（重名自动加序号，见 `uniquePageName`）
 * @returns {{page:Object, nodeCount:number, name:string}} 新副页对象 + 复制了几个 vNode（不含根）
 */
export function duplicatePage(draft, sourcePageId, newName = '') {
    assertManualEditAllowed(draft, '复制副页');
    const source = draft.pages[sourcePageId];
    if (!source) throw new Error('副页不存在');
    if (Object.keys(draft.pages).length >= MAX_PAGES) {
        throw new Error(`副页数量已达上限（${MAX_PAGES}个）`);
    }

    // ⚠️ id 由**计数器**发（`_helpers.js` 文件头那段）：这里要发 N 个（1900 节点的副页就是 1900 个），
    //    每个都是 O(1) 的 `++meta.idCounter` —— **不扫表**（扫表会让整趟变 O(n²)）。
    const newPageId = nextPageId(draft);
    const newRootId = nextVirtualRootId(draft);
    const name = uniquePageName(draft, newName, source.name);
    const page = createPageObject(newPageId, name, newRootId);

    // 旧 id → 新 id：先给**每个**旧 vNode 发新 id（含根），再按映射建第二遍
    const idMap = new Map();
    for (const oldId of Object.keys(source.virtualIndex)) {
        idMap.set(oldId, oldId === source.rootId ? newRootId : nextVirtualId(draft));
    }
    for (const [oldId, v] of Object.entries(source.virtualIndex)) {
        const vNode = createVNode(idMap.get(oldId), v.refId, v.type,
            v.parentId ? (idMap.get(v.parentId) || null) : null);
        vNode.children = (v.children || []).map((cid) => idMap.get(cid)).filter(Boolean);
        // 视图态一起搬（"整个副页复制"就是连"看它的状态"一起）
        vNode.expanded = !!v.expanded;
        vNode.currentPage = Number(v.currentPage) || 1;
        vNode.selected = !!v.selected;
        // ★ 屏蔽也要搬（否则复制出来的新页会"忘了"哪几支不跟主树）
        vNode.syncBlocked = !!v.syncBlocked;
        page.virtualIndex[vNode.id] = vNode;    }
    page.vNodeStats = JSON.parse(JSON.stringify(source.vNodeStats || {}));
    page.selected = !!source.selected;
    // ★ 「不显示屏蔽的部分」也一起搬（页级字段：复制出来的那一页当然也该照原样看）
    page.hideBlocked = !!source.hideBlocked;
    draft.pages[newPageId] = page;
    // ★ 一对一的模型下，**副本也要有它自己那一份计划**（否则新页上没有计划、`planOfPage` 空着）。
    //   ⚠️ 口径仍是"**不复制计划**"（源计划的参数不搬）：新区页拿一份**默认初始状态**
    //   —— 与"复制题单 = 同一批题、两份排布，计划各配各的"一致。
    ensurePagePlan(draft, newPageId);
    return { page, nodeCount: Object.keys(page.virtualIndex).length - 1, name };
}

/**
 * 副页名**全局唯一**（`addPage` 也是这条规则）。
 *
 * 规则（`docs/subpage-copy.md` §4）：
 *   · 用户在弹窗里给了名字 ⇒ 就用它；重名 ⇒ 加序号；
 *   · 没给 ⇒ `原名` + 「副本」；再复制**同一页** ⇒ `原名` + 「副本2」「副本3」…
 *     ⚠️ 这里有个坑（实测踩过）：源页名本身可能**已经是** `X副本2`，直接拼就成了 `X副本2副本`
 *     ⇒ 先把名字里的「副本 + 数字」尾巴剥掉再拼（`副本` 是**保留后缀**，别让它叠起来）。
 */
function uniquePageName(draft, wanted, sourceName) {
    const asked = String(wanted || '').trim();
    const taken = new Set(Object.values(draft.pages).map((p) => p && p.name));
    if (asked) {
        if (!taken.has(asked)) return asked;
        let n = 2;
        while (taken.has(asked + n)) n++;
        return asked + n;
    }
    const base = String(sourceName || '副页').replace(/副本\d*$/, '') + '副本';
    if (!taken.has(base)) return base;
    let n = 2;
    while (taken.has(base + n)) n++;
    return base + n;
}

// ---- 删除副页 ----
export function deletePage(draft, pageId) {
    assertManualEditAllowed(draft, '删除副页');
    if (!draft.pages[pageId]) throw new Error('副页不存在');
    delete draft.pages[pageId];
    if (draft.currentPageId === pageId) {
        draft.currentPageId = 'main';
    }
    return true;
}

// ---- 重命名副页 ----
export function renamePage(draft, pageId, newName) {
    assertManualEditAllowed(draft, '重命名副页');
    const page = draft.pages[pageId];
    if (!page) throw new Error('副页不存在');
    const trimmed = String(newName || '').trim();
    if (!trimmed) throw new Error('副页名称不能为空');
    for (const pid in draft.pages) {
        if (pid !== pageId && draft.pages[pid].name === trimmed) {
            throw new Error(`副页名称 "${trimmed}" 已存在`);
        }
    }
    page.name = trimmed;
    page.lastModified = getNowStr();
    return page;
}

// ---- 设置副页选中状态 ----
export function setPageSelected(draft, pageId, selected) {
    const page = draft.pages[pageId];
    if (!page) throw new Error('副页不存在');
    page.selected = !!selected;
    page.lastModified = getNowStr();
    return page;
}

// ---- 复制真实节点到副页 ----
export function copyRealNodeToPage(draft, realNodeId, targetPageId, parentVirtualId = null, recursive = false, skipDuplicateCheck = false) {
    assertManualEditAllowed(draft, '复制节点到副页');
    const page = draft.pages[targetPageId];
    if (!page) throw new Error(`副页 ${targetPageId} 不存在`);
    const realNode = draft.nodes[realNodeId];
    if (!realNode) throw new Error(`真实节点 ${realNodeId} 不存在`);

    let pVId = parentVirtualId;
    if (!pVId || !findVNode(draft, targetPageId, pVId)) {
        pVId = page.rootId;
    }
    const parentVNode = findVNode(draft, targetPageId, pVId);
    if (!parentVNode) throw new Error('父虚拟节点不存在');

    function copyRecursive(realId, parentVIdInner) {
        const real = draft.nodes[realId];
        const pNode = findVNode(draft, targetPageId, parentVIdInner);
        if (pNode && !skipDuplicateCheck) {
            const exists = pNode.children.some(cid => {
                const child = findVNode(draft, targetPageId, cid);
                return child && child.refId === real.id;
            });
            if (exists) {
                throw new Error(`节点 "${real.name || real.id}" 已存在于目标父节点下`);
            }
        }
        const vId = nextVirtualId(draft);
        const vNode = createVNode(vId, real.id, real.type, parentVIdInner);
        // ★ 插件复制钩子：让插件决定复制哪些字段到 vNode
        runVNodeCopyHooks(real, vNode);
        if (pNode) pNode.children.push(vId);
        page.virtualIndex[vId] = vNode;
        if (recursive) {
            // ⚠️ `|| []`：`childOrder` 里**没有这一条**时（老存档 / 手搭的夹具 / 刚建的节点）
            //    这里会 `undefined is not iterable` —— 而"对齐"是**批量**走这条路的，
            //    一个缺条目就会把整趟对齐回滚掉（实测在冒烟里踩到）。缺条目 = 没有子节点，不是错误。
            for (const cid of draft.childOrder[real.id] || []) {
                copyRecursive(cid, vId);
            }
        }
        return vId;
    }
    const newVId = copyRecursive(realNodeId, pVId);
    page.lastModified = getNowStr();
    return newVId;
}

// ---- 批量复制到副页 ----
export function batchCopyToPage(draft, realNodeIds, targetPageId, options = {}) {
    assertManualEditAllowed(draft, '批量复制节点到副页');
    const { recursive = false, skipDuplicateCheck = false } = options;
    const page = draft.pages[targetPageId];
    if (!page) throw new Error(`副页 ${targetPageId} 不存在`);
    if (!Array.isArray(realNodeIds) || realNodeIds.length === 0) {
        throw new Error('待复制节点列表不能为空');
    }
    const conflicts = [];
    const toCopy = [];
    for (const rid of realNodeIds) {
        const real = draft.nodes[rid];
        if (!real) continue;
        const exists = Object.values(page.virtualIndex).some(v => v.refId === rid);
        if (exists) conflicts.push(real);
        else toCopy.push(real);
    }
    if (conflicts.length > 0 && !skipDuplicateCheck) {
        const err = new Error('部分节点已存在于目标副页');
        err.conflicts = conflicts;
        err.toCopy = toCopy;
        err.total = realNodeIds.length;
        throw err;
    }
    const copied = [];
    for (const real of toCopy) {
        try {
            const vId = copyRealNodeToPage(draft, real.id, targetPageId, null, recursive, true);
            copied.push({ realNodeId: real.id, virtualId: vId });
        } catch (err) {
            console.warn('复制节点失败:', real.id, err.message);
        }
    }
    page.lastModified = getNowStr();
    return {
        total: realNodeIds.length,
        copied: copied.length,
        conflicts: conflicts.length,
        skipped: realNodeIds.length - copied.length - conflicts.length
    };
}

// ---- 删除虚拟节点（含后代） ----
export function deleteVirtualNode(draft, virtualId, pageId) {
    assertManualEditAllowed(draft, '删除副页节点');
    const page = draft.pages[pageId];
    if (!page) throw new Error(`副页 ${pageId} 不存在`);
    const vNode = findVNode(draft, pageId, virtualId);
    if (!vNode) throw new Error(`虚拟节点 ${virtualId} 不存在`);
    if (vNode.type === 'O') throw new Error('不能删除副页根节点');

    function removeRecursive(id) {
        const node = findVNode(draft, pageId, id);
        if (!node) return;
        for (const cid of [...node.children]) {
            removeRecursive(cid);
        }
        delete page.virtualIndex[id];
    }
    if (vNode.parentId) {
        const parent = findVNode(draft, pageId, vNode.parentId);
        if (parent) {
            const idx = parent.children.indexOf(virtualId);
            if (idx !== -1) parent.children.splice(idx, 1);
        }
    }
    removeRecursive(virtualId);
    page.lastModified = getNowStr();
    return true;
}

// ---- 移动虚拟节点 ----
export function moveVirtualNode(draft, virtualId, direction, pageId) {
    assertManualEditAllowed(draft, '移动副页节点');
    const page = draft.pages[pageId];
    if (!page) throw new Error(`副页 ${pageId} 不存在`);
    const vNode = findVNode(draft, pageId, virtualId);
    if (!vNode) throw new Error(`虚拟节点 ${virtualId} 不存在`);
    if (!vNode.parentId) throw new Error('虚拟节点没有父节点');
    const parent = findVNode(draft, pageId, vNode.parentId);
    if (!parent) throw new Error('父虚拟节点不存在');
    const idx = parent.children.indexOf(virtualId);
    if (idx === -1) throw new Error('虚拟节点不在父节点的子列表中');
    if (direction === 'up' && idx > 0) {
        [parent.children[idx - 1], parent.children[idx]] =
            [parent.children[idx], parent.children[idx - 1]];
    } else if (direction === 'down' && idx < parent.children.length - 1) {
        [parent.children[idx + 1], parent.children[idx]] =
            [parent.children[idx], parent.children[idx + 1]];
    } else {
        throw new Error(`无法移动：已在最${direction === 'up' ? '上' : '下'}方`);
    }
    page.lastModified = getNowStr();
    return true;
}

// ================================================================
// 与主树对齐（+ 屏蔽）—— 设计稿与口径见 `docs/subpage-sync.md` 的「副页对齐」一节
//
// 为什么要有它（用户 2026-10-15）："新爬的比赛/题目/提交进不了副页" —— 副页是**快照**
// （`virtualIndex` + `children` + `refId`），显示/统计只顺着快照走，导入/爬取那边一个字都不碰它。
// 于是要给一个**显式动作**：把页里已有的每一支"补成主树现在的样子"。
//
// 三条口径（都写在上面那篇里）：
//   · **只加不删**、**同级顺序按主树 `childOrder` 排**：有**共同主树父**就排 —— **页根那层**要求
//     孩子来自**同一个主树父**（混父 ⇒ 没有"主树顺序"可对 ⇒ 不排）；主树里**已经没有**的
//     （对齐不删、还留着）**垫到末尾**（用户 2026-10-16："与主树一致"纳入子节点顺序；
//     当天看过两版后定稿："**之前那版生效范围最广，要那版**"——**别**再加"必须是子集才排"那道门）。
//   · **幂等**（再对齐一次 `added === 0`、`reordered === 0`）；
//   · **走到 `syncBlocked` 的节点就停**（这一支已有的内容不增不减）。
// ================================================================

/**
 * 屏蔽 / 取消屏蔽一个副页节点（**只影响"与主树对齐"**：对齐走到这里不再往下递归）。
 *
 * ⚠️ 它**不是**删除、也**不是**隐藏：那一支已有的节点原样留着，只是不再跟主树长。
 * ⚠️ 根（`type === 'O'`）不给屏蔽：要"整页都别跟"就是不点「与主树对齐」——
 *    再给根一个开关就变成"同一件事两个控件"（`v9.4.9` 删掉的那一类）。
 */
export function setVNodeBlocked(draft, pageId, virtualId, blocked) {
    assertManualEditAllowed(draft, '屏蔽副页节点');
    const page = draft.pages[pageId];
    if (!page) throw new Error(`副页 ${pageId} 不存在`);
    const vNode = findVNode(draft, pageId, virtualId);
    if (!vNode) throw new Error(`虚拟节点 ${virtualId} 不存在`);
    if (vNode.type === 'O') throw new Error('副页根不能屏蔽（"整页不跟主树"就是不点对齐那个按钮）');
    vNode.syncBlocked = !!blocked;
    page.lastModified = getNowStr();
    return vNode;
}

/**
 * 设"**不显示屏蔽的部分**"（用户 2026-10-15）。
 *
 * ⚠️ 它**只管渲染**（`view/dataAdapter.js` 走 `childVNodesOf(..., 'render')`）：
 *    勾上 ⇒ 被屏蔽的支**不画**（连同它的后代）；不勾 ⇒ 照画。
 *    "屏蔽的支**不参与统计**"是**无条件**的（`purpose: 'stats'`），与这个开关无关。
 */
export function setPageHideBlocked(draft, pageId, hide) {
    assertManualEditAllowed(draft, '切换"不显示屏蔽的部分"');
    const page = draft.pages[pageId];
    if (!page) throw new Error(`副页 ${pageId} 不存在`);
    page.hideBlocked = !!hide;
    page.lastModified = getNowStr();
    return page;
}

/** 一棵页内子树有几个节点（**只数刚补进来的那一棵**，不扫整页） */
function subtreeSizeOf(index, rootId) {
    let n = 0;
    const stack = [rootId];
    while (stack.length) {
        const v = index[stack.pop()];
        if (!v) continue;
        n += 1;
        for (const cid of v.children || []) stack.push(cid);
    }
    return n;
}

/**
 * **与主树对齐**：把这一页里已有的每一支，补成主树现在的样子（**内容 + 同级顺序**）。
 *
 * 规则（唯一一处，`docs/subpage-sync.md` §2①）：
 *   从页根往下走**页里已有的每个 vNode**；走到哪，就把"主树里还有、页里还没有"的孩子**整棵**补进来；
 *   **已有的孩子要继续往下走**（否则"已有的 P 下面新爬的 R"补不进来）；走到 `syncBlocked` 就停；
 *   ★ 补完之后，**这一层的孩子按主树的 `childOrder` 排**（用户 2026-10-16："与主树一致"要纳入子节点顺序）。
 *
 * @returns {{added:number, blocked:number, visited:number, reordered:number, nodeCount:number}}
 *          `blocked` = 撞到几处屏蔽、`reordered` = 有几层的顺序被拨正（都只为报数用）
 */
export function syncPageWithTree(draft, pageId) {
    assertManualEditAllowed(draft, '与主树对齐');
    const page = draft.pages[pageId];
    if (!page) throw new Error(`副页 ${pageId} 不存在`);

    let added = 0;
    let blocked = 0;
    let visited = 0;
    let reordered = 0;

    /**
     * ★ **把这一层按主树顺序摆正**（用户 2026-10-16："与主树一致"要纳入子节点顺序；
     * 当天看过两版后定稿："**之前那版生效范围最广，要那版**"）。
     *
     * 判据（唯一一处）：
     *   ① 先找这一层共同的**主树父**：普通 vNode ⇒ 它自己的 `refId`（孩子天然以它为父）；
     *      **页根（`type === 'O'`）** ⇒ 孩子的 `parentOf` 必须**只有一个值**（混了不同父
     *      ⇒ 没有"主树顺序"可对 ⇒ 不排；"我只保留 22~26 年"那层常是这样）；
     *   ② 有父就**排**：按那个父的 `childOrder` 的**相对顺序**；主树里**已经没有**的
     *      （对齐**只加不删** ⇒ 还留着它）**垫到末尾**，彼此的相对顺序不变；
     *   ③ 顺序这件事**幂等**（第二次 `reordered === 0`）。
     * ⚠️ 有孩子 id 在 `virtualIndex` 里找不到 ⇒ 整层不动（宁可不动，也不悄悄丢引用）。
     * ⚠️ **不要**再加"必须是子集才排"那道门（试过）：页里只要有一个主树已经不认识的节点，
     *    那一层就**整层不排** ⇒ 生效范围明显变窄 —— 用户 2026-10-16 定稿要**范围广**的那版。
     */
    const orderByTree = (v) => {
        const kids = v.children || [];
        if (kids.length < 2 || kids.some((id) => !page.virtualIndex[id])) return;
        let parent = v.refId;
        if (v.type === 'O') {
            const parents = new Set(kids.map((id) => parentOfInDraft(draft, page.virtualIndex[id].refId)));
            parent = parents.size === 1 ? ([...parents][0] || '') : '';
        }
        if (!parent) return;
        const rank = new Map();
        for (const rid of draft.childOrder[parent] || []) {
            if (!rank.has(rid)) rank.set(rid, rank.size);          // 同一真实节点出现两次时按第一次算
        }
        const next = kids.map((id, i) => {
            const ref = page.virtualIndex[id].refId;
            // 主树里没有它 ⇒ 键取 `rank.size + i`：**垫到末尾**，且彼此保持原来的相对顺序
            return { id, r: rank.has(ref) ? rank.get(ref) : rank.size + i, i };
        }).sort((a, b) => (a.r - b.r) || (a.i - b.i)).map((x) => x.id);
        if (next.join(',') === kids.join(',')) return;
        v.children = next;
        reordered += 1;
    };

    const walk = (vId) => {
        const v = page.virtualIndex[vId];
        if (!v) return;
        if (v.type !== 'O' && v.syncBlocked) {
            blocked += 1;                       // ★ 屏蔽：这一支到此为止（已有的不增不减）
            return;
        }
        // ⚠️ 页根（`type === 'O'`）**自己没有真实节点**（`refId === null`）⇒ 只能顺着它已有的
        //    孩子走 —— 这也正是"页根下没有的支永远不会被带回来"（"我只保留 22~26 年"）的判据。
        if (v.type === 'O') {
            for (const cid of v.children || []) walk(cid);
            orderByTree(v);                     // ★ 页根那层同样按上面的判据排（同一主树父 + 子集才排）
            return;
        }
        if (!v.refId) return;
        visited += 1;
        for (const cid of draft.childOrder[v.refId] || []) {
            const kids = (v.children || []).map((id) => page.virtualIndex[id]);
            const exists = kids.find((k) => k && k.refId === cid);
            if (exists) {
                walk(exists.id);                // ★ 已有的孩子**继续往下走**
                continue;
            }
            // ⚠️ 复用**现成的**"递归复制一棵真实子树进副页"（`copyRealNodeToPage`）——
            //    它带插件复制钩子、重名检查与只读守卫；这里只额外数一下补了几个。
            const newId = copyRealNodeToPage(draft, cid, pageId, v.id, true, true);
            added += subtreeSizeOf(page.virtualIndex, newId);
            walk(newId);                        // 新支继续走（新补进来的节点默认不屏蔽）
        }
        orderByTree(v);                         // ★ 补完再排：这一层跟主树的顺序对齐
    };
    walk(page.rootId);
    page.lastModified = getNowStr();
    return { added, blocked, visited, reordered, nodeCount: Object.keys(page.virtualIndex).length - 1 };
}

// ---- 清理所有副页中引用了被删真实节点的 vNode ----
export function cleanDeletedRealNode(draft, realNodeIds) {
    const idSet = new Set(Array.isArray(realNodeIds) ? realNodeIds : [realNodeIds]);
    if (idSet.size === 0) return false;
    let anyDeleted = false;
    for (const pid in draft.pages) {
        const page = draft.pages[pid];
        const toRemove = [];
        for (const vId in page.virtualIndex) {
            const v = page.virtualIndex[vId];
            if (v.refId && idSet.has(v.refId)) {
                toRemove.push(vId);
            }
        }
        if (toRemove.length === 0) continue;

        const allToDelete = new Set();
        function collectDescendants(vId) {
            if (allToDelete.has(vId)) return;
            allToDelete.add(vId);
            const node = page.virtualIndex[vId];
            if (!node) return;
            for (const cid of node.children) collectDescendants(cid);
        }
        for (const vId of toRemove) collectDescendants(vId);

        for (const vId of allToDelete) {
            const node = page.virtualIndex[vId];
            if (!node) continue;
            if (node.parentId) {
                const parent = page.virtualIndex[node.parentId];
                if (parent) {
                    const idx = parent.children.indexOf(vId);
                    if (idx !== -1) parent.children.splice(idx, 1);
                }
            }
        }
        for (const vId of allToDelete) {
            delete page.virtualIndex[vId];
        }
        anyDeleted = true;
        page.lastModified = getNowStr();
    }
    return anyDeleted;
}

// ---- 清空所有副页：**整页删掉**（不是"留个空页"）----
/**
 * 「清空所有数据」用的那一步：把副页**整页删掉**（连同页内节点）。
 *
 * ⚠️ 用户 2026-10-14（看过「导入 / 导出 / 清空」那一栏之后）："其实不删副页也是奇怪的" ——
 *    清空之后页签还挂在那儿（只是变成一页空树），与"清空所有数据"这个说法不符；
 *    **计划**同理（那时会留一条指不到东西的壳，调用方 `resetAllWithConfirm` 一起清）。
 * ⚠️ **不是**"删单个副页"那条路：那条在 `deletePage`，而且**刻意不碰计划**（§10 ⑧：计划留着并提示
 *    "题单页已删除"）。两件事别混 —— 一个副页没了，别的副页/别的计划可能还活得好好的；
 *    "清空所有数据"是**把这一摊全收走**。
 * ⚠️ 也别与 `core/model/viewState.js` 的 `resetPagination()` 混（2026-10-16 从 `clearAllPages`
 *    **改名**）：那个清的是**分页**（`view.pages = {}`，页码回第 1 页），与副页无关 ——
 *    两个东西原来**同名**，调用点各 import 自己那份，读起来分不出谁是谁。
 */
export function clearAllPages(draft) {
    assertManualEditAllowed(draft, '清空副页');
    draft.pages = {};
}

// ---- 重置所有虚拟页的 currentPage 为 1 ----
export function resetAllVirtualPages(draft) {
    assertManualEditAllowed(draft, '重置副页分页');
    for (const pid in draft.pages) {
        const page = draft.pages[pid];
        for (const vId in page.virtualIndex) {
            page.virtualIndex[vId].currentPage = 1;
        }
        page.lastModified = getNowStr();
    }
}

// ================================================================
// 读：虚拟节点在哪、它指的是哪个真实节点
//
// ⚠️ 这两支是**只读**的（不改 state），但必须放在**唯一一处**：
//    UI 侧多处都要判"这个 id 是副页里的虚拟节点吗"，各写一份就会出现
//    "有的地方解析了 `_refId`、有的地方没解析"这种半截修法（实测踩过：
//    `📋 详细节点信息` 传的是虚拟节点 id ⇒ 开出来一个标题是 `v_xxx` 的空界面）。
// ================================================================

/** 在**所有副页**里找这个 id（虚拟 id 是全局唯一的，但不确定属于哪一页） */
export function locateVirtualNode(state, id) {
    const pages = (state && state.pages) || {};
    for (const pid in pages) {
        const v = pages[pid] && pages[pid].virtualIndex ? pages[pid].virtualIndex[id] : null;
        if (v) return { pageId: pid, vNode: v };
    }
    return null;
}

/**
 * 副页**页内祖先链**：从该页的根一路到**它的父**（不含自己），返回 vNode 对象（根在前）。
 *
 * ⚠️ 它**不能**用 `core/query/nodes.js:getAncestorsRootFirst` 顶替，也不是"第二份实现"：
 *    那一份走的是**主树**的 `state.parentOf` / `childOrder`，而页内 id（`v_xxx`）在那两张表里
 *    **根本不存在** ⇒ 拿页内 id 去问只会得到「（就在根下）」这种**假话**（`docs/node-navigation.md`
 *    §2.5 记的正是这个坑，所以副页节点行一直不给面包屑）。页内祖先的真源只有
 *    `state.pages[pageId].virtualIndex[*].parentId` —— 与 `locateVirtualNode` 同一份数据，摆在它旁边。
 *
 * 断链 / 成环（深度上限 1000）/ 认不出归属 ⇒ 空数组（调用方如实不画，别编一条链出来）。
 *
 * @param {Object} state - `AppState`
 * @param {string} id - 副页**页内 id**
 * @returns {Array<Object>} 由根到父的 vNode；不含自己
 */
export function virtualAncestorsOf(state, id) {
    const hit = locateVirtualNode(state, id);
    if (!hit) return [];
    const page = state.pages[hit.pageId];
    const index = (page && page.virtualIndex) || {};
    const chain = [];
    let cur = hit.vNode;
    let guard = 0;
    while (cur && cur.parentId && guard++ < 1000) {
        cur = index[cur.parentId];
        if (!cur) break;
        chain.unshift(cur);
    }
    return chain;
}

/**
 * 祖先链的**唯一入口**：按**归属**在主树与副页那两棵树之间分流。
 *
 * 为什么要有它（用户 2026-10-13 拍板）：以前调用方得自己知道"这个 id 属于哪棵树" ——
 * 主树走 `core/query/nodes.js:getAncestorsRootFirst`、副页走上面的 `virtualAncestorsOf`，
 * 挑错了不会报错，只会印出「（就在根下）」这种**假话**（`docs/node-navigation.md` §2.5 记的正是这个坑）。
 *
 * ⚠️ 两棵树的**实现都各自只有一份**，这里只是分流，不是"第三份祖先链"：
 *   · 主树 id（`state.nodes` 里真有）⇒ `getAncestorsRootFirst`（`parentOf`，返回**节点对象**）；
 *   · 别的（副页页内 id `v_xxx`）⇒ `virtualAncestorsOf`（`virtualIndex[*].parentId`，返回 **vNode**）。
 * 顺序与 `ui/revealNode.js:revealNode` / `findNodeBox` 一致：**先主树、再副页**（同名时主树赢）。
 *
 * ⚠️ **为什么不叫 `ancestorsOf`**：同一个 `core/ops/` 层里 `account.js` 已经有一个**同名但完全不同**的
 *    `ancestorsOf`（那是**账户树**的祖先、返回账户 id 字符串）。同名同层会让下一个读代码的人当场认错，
 *    所以这里带上前缀 `node`。**别改名回去。**
 *
 * @param {Object} state - `AppState`
 * @param {string} id - 节点 id（主树真实 id 或副页页内 id，两种都认）
 * @returns {Array<Object>} 由根到父、**不含自己**的对象数组；认不出 / 没有祖先 ⇒ 空数组
 */
export function nodeAncestorsOf(state, id) {
    const key = String(id || '');
    if (key && state && state.nodes && state.nodes[key]) return getAncestorsRootFirst(state, key);
    return virtualAncestorsOf(state, key);
}

/**
 * 虚拟节点 id → 它引用的**真实**节点 id（不是虚拟节点就原样返回）。
 *
 * 用于"操作的是那个节点本身"的动作（看信息 / 编辑 / 加子节点）：
 * 副页里看到的只是**引用**，字段与子节点都在真实节点上。
 */
export function realNodeIdOf(state, id) {
    const hit = locateVirtualNode(state, id);
    return (hit && hit.vNode && hit.vNode.refId) ? hit.vNode.refId : id;
}

/**
 * 可以**跳过去**的主树节点 id：`realNodeIdOf` 解析 + 还要求 `state.nodes` 里真有。
 *
 * ⚠️ 这是"给节点行画一个『🔎 跳到树上 / 📋 打开详页』入口"的**唯一判据**。
 *    以前这一步散在两处（`ui/kit/nodeEntry.js` 的入口条、插件 `ContestOverview/index.js`
 *    注入的 `jumpId`），写法一样、迟早分叉 —— 少查一次 `state.nodes` 就会画出
 *    **点了没反应的假链接**（比纯文本更糟，见 `ui/kit/report.js:nodeOrText` 的文件头）。
 *    插件 import core 是允许的（`src/features/AGENTS.md` 的不变量），import `ui/` 不行 ——
 *    所以这一份只能住在 core。
 *
 * @param {Object} state - `AppState`
 * @param {string} id - 节点 id（副页的页内 id 也认，先解析）
 * @returns {string} 主树真实节点 id；**空串 = 不能跳**（没有 id / 副页根节点 / 树上已没这个节点）
 */
export function mainTreeNodeIdOf(state, id) {
    const real = String(realNodeIdOf(state, id) || '').trim();
    return (real && state && state.nodes && state.nodes[real]) ? real : '';
}

// ================================================================
// 内部辅助
// ================================================================

function findVNode(draft, pageId, vId) {
    const page = draft.pages[pageId];
    if (!page) return null;
    return page.virtualIndex[vId] || null;
}