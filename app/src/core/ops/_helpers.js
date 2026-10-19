// ================================================================
// 操作层内部工具（core/ops/_helpers.js）
// 职责：id 生成、childOrder 条目保证、同级重名/重号规避、**事务内的父指针视图**
// 依赖：无（纯函数 + draft）
// ================================================================

// ================================================================
// ★ 事务内的父指针：**不写 `draft.parentOf`，只在 overlay 里记**
//
// 为什么（2026-10-18，用户："不写 parentOf 尽管改，因为有收益且稳定"）：
//   `parentOf` 是**派生索引**（`applyState` 在 `childOrder` 换引用时会整张重建）。
//   但以前每个结构操作还顺手写一次 `draft.parentOf[...]` —— 那会让 Immer **再拷一张 3.3 万键的字典**：
//   `perf-bench` 实测 `{ ...parentOf }` **78ms**，而 `只 produce：addChild(P)` 总共 145ms。
//   ⇒ 事务里改成"记在一张 `Map` 上"，读的时候先问 overlay；提交时由 `applyState` 一次性重建。
//
// 用法（**唯一入口**）：写 `setParentOf(draft, id, pid)` / `forgetParentOf(draft, id)`；
//   读 `parentOfInDraft(draft, id)`。**别再直接读写 `draft.parentOf`**（判据见 `childOrderInvariant.test.js`）。
// ⚠️ overlay 按 **draft 对象**存（WeakMap）⇒ 一次 `produce` 一份、用完即弃，不会漏到下一次事务。
// ⚠️ `parentOfInDraft` 的兜底是 **base 值**：事务开始时它是对的（那时还没动结构）。
// ================================================================
const PARENT_OVERLAY = new WeakMap();   // draft → Map<id, parentId | null>

/** 事务内改父：`parentId` 给 `null` 表示"这个节点不在树上了" */
export function setParentOf(draft, id, parentId) {
    if (!draft || !id) return;
    let ov = PARENT_OVERLAY.get(draft);
    if (!ov) { ov = new Map(); PARENT_OVERLAY.set(draft, ov); }
    ov.set(String(id), parentId == null ? null : String(parentId));
}

/** 事务内删节点：把它从父指针里摘掉 */
export function forgetParentOf(draft, id) {
    setParentOf(draft, id, null);
}

/** 事务内读父：先看 overlay，没有就看 base 的 `parentOf` */
export function parentOfInDraft(draft, id) {
    if (!draft || !id) return null;
    const ov = PARENT_OVERLAY.get(draft);
    if (ov && ov.has(String(id))) return ov.get(String(id));
    return (draft.parentOf && draft.parentOf[id]) ?? null;
}


// ================================================================
// id 生成：**唯一性只由"计数器"保证**（构造性唯一，不靠时间、不靠随机、也不扫表）
//
// ⚠️ 为什么不能"时间戳 + 随机"（`v9.3.0` 的教训，用户 2026-10-13 报的
//    "复制之后 2023 CC秦皇岛 变成一个单题"）：复制一个 1900 节点的副页要在**同一毫秒**里
//    连发上千个 id ⇒ 老实现（毫秒 + 4 位随机）**生日碰撞**（实测 2000 个 id × 10 轮，5 轮撞）；
//    撞上时两个 vNode 合成一个（后写覆盖前写、两个父的 `children` 指向同一个 id）
//    ⇒ 一个容器被一个叶子顶掉。
//
// 三条规矩（改这里之前先读）：
//   ① **所有族共用一个计数器**，形式统一 `<前缀>_<计数器>_<毫秒36>`；
//      `++state.meta.idCounter` 是**唯一**的发号动作（O(1)）；
//   ② 计数器**住在 state 里、随存档与导出包走**；**载入 / 导入时归一化**
//      （`core/model/convert.js:normalizeIdCounter`，只扫各族的数字前缀取最大）
//      ⇒ 老数据、手改过的包、计数器坏掉的存档都不会让计数器回退；
//   ③ **别在分配时扫"用过的 id 集合"**：那是 O(全表)/次，而复制/批量导入要发 N 个 id
//      ⇒ 整个操作变 O(n²)（实测过的坑）。
// ⚠️ 换了形式的族之间也撞不上：老 `page_<ms36>`、`v_<ms36>_<rand>`、`plan_<ms36>_<rand>`
//    与新的两段式 `<前缀>_<数字>_<ms36>` **字段数都不同** ⇒ 结构上不可能相等。
// ================================================================

/** 发一个 id（**唯一入口**）：`<前缀>_<计数器>_<毫秒36>` */
export function nextIdOf(state, prefix) {
    if (!state.meta || !Number.isFinite(state.meta.idCounter)) {
        // 老存档 / 手搭的 state 可能没有计数器 ⇒ 补一个可用的（真源归一化在 load/import 那两处）
        state.meta = Object.assign({}, state.meta, { idCounter: 0 });
    }
    return prefix + (++state.meta.idCounter) + '_' + Date.now().toString(36);
}

export function nextNodeId(state) {
    return nextIdOf(state, 'n_');
}

export function nextTagId(state) {
    return nextIdOf(state, 't_');
}

export function nextPageId(state) {
    return nextIdOf(state, 'page_');
}

export function nextVirtualRootId(state) {
    return nextIdOf(state, 'vroot_');
}

export function nextVirtualId(state) {
    return nextIdOf(state, 'v_');
}

// ---- 确保 childOrder 中存在该节点的条目（规则 A） ----
export function ensureChildOrder(draft, id) {
    if (!draft.childOrder[id]) draft.childOrder[id] = [];
}

// ---- 把子节点挂到父节点名下（规则 A 的**唯一入口**） ----
// 为什么不是各处直接 `draft.childOrder[parentId].push(id)`：父节点的条目可能**本来就没有**
// （老存档、手工构造的输入、别处删漏了），直接 push 就是 TypeError，
// 而它发生在事务里 ⇒ **整批导入全部回滚**。
export function pushChild(draft, parentId, childId) {
    ensureChildOrder(draft, parentId);
    draft.childOrder[parentId].push(childId);
}

// ---- 换父（**结构手术**，不含类型校验与重算） ----
/**
 * 把一个已经在树上的节点从旧父的 `childOrder` 挪到新父的末尾。
 *
 * 这是"换父"的**唯一**一份目录操作 —— `core/ops/tree.js` 的 `moveNode`（手工/UI 那条路，
 * 带 `assertManualEditAllowed` + 类型校验 + 两边祖先链重算）与
 * `upsertRecord`（导入那条路：类型校验它在第 4 步已经做了，重算由调用方在循环末尾统一跑）
 * **共用这一份**，不各写一遍。
 *
 * ⚠️ 为什么不做成 `tree.js` 里那个 `moveNode` 直接给导入用：`tree.js` 依赖
 *    `core/autoCompute.js` → `pluginRegistry.js` → `shell/state.js`（要 `immer`），
 *    而 `upsert.js` 是**纯核心模块**（`src/test/` 直接 import 它，不许牵进 shell）。
 *    所以只把目录手术下沉到这里，重算留在 tree.js 那层。
 *
 * 守卫（其余交给调用方）：节点在树上、不在自己的子树下、目标父存在、旧父的条目里有它。
 * @returns {boolean} 是否真的换了父（同一个父 ⇒ `false`，幂等）
 */
export function reparent(draft, id, newParentId) {
    if (!draft || !draft.nodes || !draft.nodes[id]) throw new Error('节点不存在');
    if (id === draft.rootId) throw new Error('不能移动根节点');
    if (!draft.nodes[newParentId]) throw new Error('目标父节点不存在');
    const oldParentId = parentOfInDraft(draft, id) || '';
    if (!oldParentId) throw new Error('节点不在树上');
    if (oldParentId === newParentId) return false;
    // 防环：目标是自己的后代（含自己）⇒ 整棵子树会从树上消失
    for (let cur = newParentId; cur; cur = parentOfInDraft(draft, cur)) {
        if (cur === id) throw new Error('不能把节点挂到它自己的子树下');
    }
    const olds = draft.childOrder[oldParentId] || (draft.childOrder[oldParentId] = []);
    const idx = olds.indexOf(id);
    if (idx === -1) throw new Error('节点不在父节点列表中');
    olds.splice(idx, 1);
    pushChild(draft, newParentId, id);
    setParentOf(draft, id, newParentId);          // ★ 只记 overlay（见文件头）
    return true;
}

// ================================================================
// 同级重名 / 重号规避（新建、复制、批量导入共用一套规则）
// ================================================================

/**
 * 同一个父节点下的兄弟名字 —— **有名字的兄弟都算，一个不落**。
 *
 * ⚠️ 这里**不按类型排除 R**：提交记录平时没有独立名字
 *    （`addChild` 给 R 写空 `name`，下面 `child.name` 这一条自然跳过），
 *    但 **R 上的合成节点是有名字的**（`createSynthNode` 默认「合成」）。
 *    若把 R 整个排除 ⇒ 同一个 P 下建几个 R 合成节点就全叫「合成」，
 *    就是"撞名字"。判据是"所有有名字的兄弟"，范围才是完整的。
 */
function siblingNames(draft, parentId) {
    const names = new Set();
    for (const cid of draft.childOrder[parentId] || []) {
        const child = draft.nodes[cid];
        if (child && child.name) names.add(child.name);
    }
    return names;
}

/** 同一个父节点下的兄弟题号 */
function siblingProblemIds(draft, parentId) {
    const ids = new Set();
    for (const cid of draft.childOrder[parentId] || []) {
        const child = draft.nodes[cid];
        if (child && child.type === 'P' && child.problemId) ids.add(child.problemId);
    }
    return ids;
}

/** 重名就加序号：`题1` → `题12` → `题13`（已占用就一直往下找） */
export function ensureUniqueName(draft, parentId, desiredName) {
    if (!desiredName) return desiredName;
    const existing = siblingNames(draft, parentId);
    if (!existing.has(desiredName)) return desiredName;
    let n = 1;
    while (existing.has(desiredName + n)) n++;
    return desiredName + n;
}

/** 下一个空闲题号：`A`..`Z`，用完了退到 `X1`、`X2`… */
export function nextFreeProblemId(draft, parentId) {
    const existing = siblingProblemIds(draft, parentId);
    for (let i = 0; i < 26; i++) {
        const letter = String.fromCharCode(65 + i);
        if (!existing.has(letter)) return letter;
    }
    let num = 1;
    while (existing.has('X' + num)) num++;
    return 'X' + num;
}

/** 想要的题号没被占用就用它，否则给下一个空闲题号 */
export function ensureUniqueProblemId(draft, parentId, desiredId) {
    const trimmed = (desiredId || '').trim();
    if (!trimmed) return '';
    if (!siblingProblemIds(draft, parentId).has(trimmed)) return trimmed;
    return nextFreeProblemId(draft, parentId);
}