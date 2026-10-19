// ================================================================
// 「资格」判定（view/eligible.js）
//
// 三个判定函数：某个节点算不算"在自己人的范围里"，以及这个范围能数出几个节点。
//   - `getProjected`        该主树节点是否被**某个被选中的副页**映射并选中；
//   - `hasEligibleAncestor` 自身或祖先满足「主树选中」/「副页映射覆盖」；
//   - `countEligibleSubtree` 子树里满足上述条件的节点数。
// 三个都是"给定同一个 state 就给出同一个答案"的读函数；`getProjected` 里带一张
// **按 `state.pages` 引用**缓存的投影表（见下面那段注释），只是为了别把同一张表重算上万遍。
//
// 为什么**单独一个文件**：
//   `helpers.js` 是渲染辅助，它 import 了 `core/pluginRegistry.js`（取 renderSlots），
//   那条链最终会拉进 `shell/state.js` → 裸包名 `immer`。于是**任何** import 它的模块
//   都没法在纯 Node 单测里跑（`npm test` 不带 `immer` 解析钩子，浏览器才靠 import map）。
//   这三个函数只读 state 的形状、与渲染无关，单独成文件之后
//   `view/filterMode.js`（筛选模式共用件）就成了**可单测**的纯模块。
//
// 依赖：无（只看 state 的 `nodes/childOrder/parentOf/pages` 结构）
// ================================================================

// ----------------------------------------------------------------
// 「谁被副页投影覆盖」的那张集合表
//
// 为什么要它：`getProjected` 原来每问一个节点就把**所有被选中副页**的 virtualIndex
// 扫一遍。而渲染路径是**逐行**问的（`helpers.js` 的选中模式每行问 4 次：祖先链/子树
// 各看一遍"选中"和"选中∪投影"）⇒ 同一张表被反复重算成千上万次，屏幕上一屏就能到秒级。
// 这张表只取决于 `state.pages`，与问的是哪个节点无关 ⇒ 按引用缓存一次，之后每问一次
// 就是一次 `Set.has`。
//
// ⚠️ 缓存前提：**`state.pages` 一变，表就作废**。副页/虚拟节点的写入都走
//    `core/ops/view.js` 的事务（immer ⇒ 新引用），所以正常路径天然满足；
//    只有**在事务外就地改**（例如单测里手搓的夹具）才可能骗过它 —— 那种情况另有两条兜底：
//    ① 副页自身的 `selected` 翻转由下面那段"选中副页签名"当场识破；
//    ② 别的就地改动要自己调 `clearEligibleMemo()`。
// ----------------------------------------------------------------
let _projPages = null;     // 建表时用的 `state.pages` 引用
let _projSel = null;       // 当时的"哪些副页被选中"（id 列表，用来识破就地翻转）
let _projSet = null;       // refId 集合（`nodeId` 在里面 ⇒ 被投影覆盖）

/** 清空上面那张表（测试/诊断用） */
export function clearEligibleMemo() {
    _projPages = null;
    _projSel = null;
    _projSet = null;
}

/** 选中的副页是否与建表时一致（副页没几个 ⇒ 这个 O(副页数) 的检查可以每次做） */
function selectedPagesChanged(pages) {
    let n = 0;
    for (const pid in pages) {
        if (!pages[pid].selected) continue;
        if (!_projSel || _projSel[n] !== pid) return true;
        n++;
    }
    return !_projSel || n !== _projSel.length;
}

function projectedSet(state) {
    const pages = state.pages;
    if (pages === _projPages && !selectedPagesChanged(pages)) return _projSet;

    const sel = [];
    const set = new Set();
    for (const pid in pages) {
        const page = pages[pid];
        if (!page.selected) continue;
        sel.push(pid);
        const vIndex = page.virtualIndex;
        for (const vId in vIndex) {
            const vNode = vIndex[vId];
            if (vNode.selected === true) set.add(vNode.refId);
        }
    }
    _projPages = pages;
    _projSel = sel;
    _projSet = set;
    return set;
}

/** 副页投影检测：这个**主树**节点是否被某个"被选中的副页"映射且该引用被选中 */
export function getProjected(state, node, cache = null) {
    if (node._virtual) return false;
    const nodeId = node.id;
    if (cache && cache.has(nodeId)) {
        return cache.get(nodeId);
    }
    const hit = projectedSet(state).has(nodeId);
    if (cache) cache.set(nodeId, hit);
    return hit;
}

/**
 * 自身或祖先满足条件吗。
 *
 * ⚠️ 虚拟节点走**另一套判据**：只看"它所在副页里"的选中链
 *（人在副页里，选中本来就是这个页面里的选中）——所以两个"选中类"模式对虚拟节点等价。
 */
export function hasEligibleAncestor(state, node, checkSelected = true, checkProjected = false, cache = null) {
    if (node._virtual) {
        const pageId = node._pageId;
        const page = state.pages[pageId];
        if (!page) return false;
        const vNode = page.virtualIndex[node._virtualId];
        if (!vNode) return false;
        if (vNode.selected) return true;
        let pid = vNode.parentId;
        while (pid) {
            const parent = page.virtualIndex[pid];
            if (parent && parent.selected) return true;
            pid = parent ? parent.parentId : null;
        }
        return false;
    } else {
        if (checkSelected && node.selected) return true;
        if (checkProjected && getProjected(state, node, cache)) return true;
        let pid = state.parentOf[node.id] ?? null;
        while (pid) {
            const parent = state.nodes[pid];
            if (parent) {
                if (checkSelected && parent.selected) return true;
                if (checkProjected && getProjected(state, parent, cache)) return true;
            }
            pid = state.parentOf[pid] ?? null;
        }
        return false;
    }
}

/** 子树里满足条件的节点数（虚拟节点数"本副页子树里选中的"） */
export function countEligibleSubtree(state, node, checkSelected = true, checkProjected = false, cache = null) {
    if (node._virtual) {
        const pageId = node._pageId;
        const page = state.pages[pageId];
        if (!page) return 0;

        function countSub(vId) {
            const vn = page.virtualIndex[vId];
            if (!vn) return 0;
            let cnt = vn.selected ? 1 : 0;
            if (vn.children) {
                for (const cid of vn.children) {
                    cnt += countSub(cid);
                }
            }
            return cnt;
        }
        return countSub(node._virtualId);
    } else {
        function countSub(n) {
            let cnt = 0;
            // ★ 两个条件是**"或"**（`docs/guide.html` 的筛选模式表：全局覆盖 = 自身或祖先满足
            //   「主树选中」**或**「副页映射覆盖」）⇒ 一个节点**只能算一次**。
            //   ⚠️ 原来这里是两个独立 `if` ⇒ "既选中、又被选中副页投影"的节点被**数两遍**
            //     （实测同一个节点：只看选中 1、只看投影 1、两者都看 **2**）⇒ 蓝框的数偏大。
            if ((checkSelected && n.selected) || (checkProjected && getProjected(state, n, cache))) cnt++;
            const childIds = state.childOrder[n.id];
            for (const cid of childIds) {
                const c = state.nodes[cid];
                if (c) cnt += countSub(c);
            }
            return cnt;
        }
        return countSub(node);
    }
}
