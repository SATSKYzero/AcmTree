// ================================================================
// 副页结构（core/model/page.js）
// 职责：Page 与 VNode 工厂
// 依赖：core/pluginRegistry.js
// ================================================================
import { runVNodeMigrations } from '../pluginRegistry.js';

// ---- 创建副页 ----
export function createPage(id, name, rootId, timestamp) {
    const now = formatNow(timestamp);
    return {
        id,
        name,
        rootId,
        virtualIndex: {},
        vNodeStats: {},
        createdAt: now,
        lastModified: now,
        selected: false,
        //: **不显示屏蔽的部分**（用户 2026-10-15："副页增加『不显示屏蔽的部分』字段，选中时屏蔽的部分不渲染"）。
        //: ⚠️ 它**只管渲染**；"屏蔽的支不参与统计"是**无条件**的（见 `childVNodesOf` 的说明）。
        //: 缺省 `false` ⇒ 老数据与今天一样（屏蔽的支照画，只是不参与统计、对齐也不再往下补）。
        hideBlocked: false
    };
}

// ---- 创建虚拟节点 ----
export function createVNode(id, refId, type, parentId) {
    const vNode = {
        id,
        refId,
        type,
        children: [],
        parentId,
        expanded: false,
        currentPage: 1,
        selected: false,
        //: **屏蔽**（用户 2026-10-15："副页节点增加可编辑的『屏蔽』字段；与主树对齐时，
        //: 走到屏蔽的节点就不会递归"）—— 只影响"与主树对齐"这一件事：
        //: 对齐走到这里就**不再往下补**；这一支已有的内容**不增不减**（不是删除、也不是隐藏）。
        //: 缺省 `false` ⇒ 老数据与没有这个字段时的行为**一个字节不变**。
        syncBlocked: false
    };
    runVNodeMigrations(vNode);
    return vNode;
}

/**
 * 一个页内节点**该走哪几个孩子** —— "屏蔽"的唯一判据就在这儿（别在别处各写一遍）。
 *
 * 用户 2026-10-15 的两条：
 *   · 「屏蔽的部分**不参与任何统计**」⇒ `purpose === 'stats'`（默认）时，
 *     **被屏蔽的那一支整支跳过**（它自己也不进统计）；
 *   · 「副页增加『不显示屏蔽的部分』字段，选中时屏蔽的部分**不渲染**」⇒ `purpose === 'render'` 时，
 *     只有 `page.hideBlocked` 为真才跳过（字段缺省 `false` ⇒ 照画）。
 *
 * @param {Object} page
 * @param {Object} vNode
 * @param {'stats'|'render'} [purpose]
 * @returns {Array<Object>} 要走的 vNode 数组（**已按屏蔽过滤**；坏引用/缺孩子一律顺带滤掉）
 */
export function childVNodesOf(page, vNode, purpose = 'stats') {
    const index = (page && page.virtualIndex) || {};
    const skipBlocked = purpose === 'render' ? !!(page && page.hideBlocked) : true;
    const out = [];
    for (const cid of (vNode && Array.isArray(vNode.children) ? vNode.children : [])) {
        const child = index[cid];
        if (!child) continue;
        if (skipBlocked && child.syncBlocked) continue;
        out.push(child);
    }
    return out;
}

/**
 * 一页的**结构签名**：只看"有哪些 vNode、各自引谁、孩子是谁、屏蔽没屏蔽"。
 *
 * ⚠️ **刻意不含 `expanded` / `selected` / `currentPage`**（那些是"看的姿势"，不是数据）——
 *   用户 2026-10-18："副页折叠现在慢啊"：`expanded` 存在 vNode 上 ⇒ 折一下整张 `virtualIndex` 换新、
 *   页对象也换新，任何"按页对象/virtualIndex 引用"当键的缓存都会**每折一次全作废**。
 *   用它当键的"数据代"那半，折叠就不会把缓存打掉。
 *
 * 为什么放在模型层：`view/stats.js`（桶缓存、总览统计）与 `view/scope.js`（容器状态 `statusComplete*`）
 *   都要用它，而那两处互相 import 会成环 —— 放这儿两边都能单向引。
 */
export function virtualStructureKey(page) {
    const idx = (page && page.virtualIndex) || {};
    const ids = Object.keys(idx);
    let s = `${ids.length}|`;
    for (const id of ids) {
        const v = idx[id];
        if (!v) continue;
        s += id + ':' + (v.refId || '') + ':' + (v.children || []).join(',')
            + (v.syncBlocked ? '#' : '') + ';';
    }
    return s;
}

/** page → 签名（页对象没换就不重复算；算一次是 O(vNode 数)） */
const STRUCT_SIGS = new WeakMap();
export function structureSignatureOf(page) {
    const hit = STRUCT_SIGS.get(page);
    if (hit && hit.page === page) return hit.sig;
    const sig = virtualStructureKey(page);
    STRUCT_SIGS.set(page, { page, sig });
    return sig;
}

// ---- 时间格式化（与 node.js 保持一致，避免跨文件依赖） ----
function formatNow(timestamp) {
    const d = timestamp ? new Date(timestamp) : new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}