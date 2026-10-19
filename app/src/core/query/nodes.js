// ================================================================
// 节点查询（core/query/nodes.js）
// 职责：只读查询，纯函数，接收 state 参数
// 依赖：无
// ================================================================

// ---- 取节点 ----
export function getNode(state, id) {
    return state.nodes[id] || null;
}

// ---- 取子节点 id 列表 ----
export function getChildIds(state, id) {
    return state.childOrder[id];
}

// ---- 取子节点对象列表 ----
export function getChildren(state, id) {
    const ids = state.childOrder[id];
    const out = [];
    for (const cid of ids) {
        const c = state.nodes[cid];
        if (c) out.push(c);
    }
    return out;
}

// ---- 取父节点 id ----
export function getParentId(state, id) {
    if (state.parentOf[id] !== undefined) return state.parentOf[id];
    // 回退：遍历 childOrder（极少用）
    for (const pid in state.childOrder) {
        if (state.childOrder[pid].includes(id)) return pid;
    }
    return null;
}

// ---- 取父节点对象 ----
export function getParent(state, id) {
    const pid = getParentId(state, id);
    if (pid === null || pid === undefined) return null;
    return state.nodes[pid] || null;
}

// ---- 取根节点 ----
export function getRoot(state) {
    return state.rootId ? state.nodes[state.rootId] || null : null;
}

// ---- 取兄弟节点 ----
export function getSiblings(state, id) {
    const pid = getParentId(state, id);
    if (pid === null) return [];
    return getChildren(state, pid);
}

// ---- 取祖先链（**根在前**，不含自身） ----
//
// ⚠️ 这是**两处检索**（题目 / 比赛）"归属"读的那一个：不要再在 `features/*Search/collect.js`
//    各抄一份逐字相同的实现（各写一份就会漂）。
//    深度上限 `MAX_DEPTH` 是防坏数据成环（`parentOf` 自指）。
//
// ⚠️ 与下面的 `getAncestors` **是同一个走法、只差顺序**（`getAncestors` 就是它的反序）：
//    两个名字并存只是为了"别混用顺序"，**不是**两套口径。
//    （这里只认 `parentOf`，不走 `getParentId` —— 后者在 `parentOf` 缺项时回退去扫
//      `childOrder`，`parentOf` 不完整时会**多认/认错**祖先（实测踩过）：
//      检索的"归属"是**投影**，宁缺勿错。）
const MAX_DEPTH = 1000;

export function getAncestorsRootFirst(state, id) {
    const out = [];
    if (!state || !state.nodes || !state.parentOf) return out;
    let cur = state.parentOf[id];
    let guard = 0;
    while (cur && guard++ < MAX_DEPTH) {
        const node = state.nodes[cur];
        if (!node) break;                       // 断链（父已不在）⇒ 到此为止，不抛
        out.unshift(node);
        cur = state.parentOf[cur];
    }
    return out;
}

// ---- 取祖先链（从父到根，**末位是根**；与上面只差顺序，别混用） ----
export function getAncestors(state, id) {
    return getAncestorsRootFirst(state, id).reverse();
}

// ---- 取后代（先序） ----
export function getDescendants(state, id) {
    const root = state.nodes[id];
    if (!root) return [];
    const out = [];
    (function walk(n) {
        const childIds = state.childOrder[n.id];
        for (const cid of childIds) {
            const c = state.nodes[cid];
            if (c) {
                out.push(c);
                walk(c);
            }
        }
    })(root);
    return out;
}

// ---- 取子树所有 id（含自身，先序） ----
export function getSubtreeIds(state, id) {
    const root = state.nodes[id];
    if (!root) return [];
    const out = [];
    (function walk(n) {
        out.push(n.id);
        const childIds = state.childOrder[n.id];
        for (const cid of childIds) {
            const c = state.nodes[cid];
            if (c) walk(c);
        }
    })(root);
    return out;
}

// ---- 判断 ancestor 是否为 descendant 的祖先（含自身） ----
export function isAncestor(state, ancestorId, descendantId) {
    if (ancestorId === descendantId) return true;
    let pid = getParentId(state, descendantId);
    while (pid) {
        if (pid === ancestorId) return true;
        pid = getParentId(state, pid);
    }
    return false;
}

// ---- 深度（根为 0） ----
export function getDepth(state, id) {
    let depth = 0;
    let pid = getParentId(state, id);
    while (pid) {
        depth++;
        pid = getParentId(state, pid);
    }
    return depth;
}

// ---- 路径（从根到当前节点） ----
export function getPath(state, id) {
    const path = [];
    let current = state.nodes[id];
    while (current) {
        path.unshift(current);
        const pid = getParentId(state, current.id);
        current = pid ? state.nodes[pid] : null;
    }
    return path;
}