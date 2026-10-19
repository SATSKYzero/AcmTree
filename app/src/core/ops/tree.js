// ================================================================
// 树结构操作（core/ops/tree.js）
// 职责：增删改移复制，纯 draft 操作
// 依赖：_helpers.js, model/node.js, core/autoCompute.js
// 约定：所有函数不返回新状态，直接修改 draft
// 不变量：**`childOrder` 是唯一真源**；`parentOf` 是派生索引 ——
//   事务内用 `_helpers.parentOfInDraft` 读、`setParentOf`/`forgetParentOf` 记（一张 Map），
//   **提交时由 `applyState` 整张重建**（`childOrder` 换引用就重建）。
//   ⚠️ 2026-10-18 起**事务里不再写 `draft.parentOf`**：写它会让 Immer 每次结构操作多拷一张
//   3.3 万键的字典（实测 `{ ...parentOf }` 78ms，`addChild` 145→117ms）。
// 自动计算：
//   addRoot / addChild(!skip) / copyNode / deleteNode /
//   clearProblems / clearSubmissions 后跑 fullAutoUpdate
//   批量场景传 skipAutoUpdate = true，由调用方统一跑
// ================================================================
import { createNode } from '../model/node.js';
import { TYPE_CHILDREN_MAP, badParentTypeMessage } from '../model/constants.js';
import { autoUpdateSubtree, autoUpdateChain, propagateUp } from '../autoCompute.js';
import {
    nextNodeId,
    ensureChildOrder,
    pushChild,
    reparent,
    ensureUniqueName,
    nextFreeProblemId,
    // ★ 事务内的父指针（**不写 `draft.parentOf`**，见 `_helpers.js` 文件头那一段）
    setParentOf, forgetParentOf, parentOfInDraft
} from './_helpers.js';
import { getNowStr } from '../../utils/time.js';
import { setExpanded } from '../model/viewState.js';
import { markOrigin, MANUAL_ORIGIN } from './origin.js';
import { recordManualValue } from './node.js';
import { assertManualEditAllowed } from './account.js';
import { synthKeyOf, clearOwnersOf } from './synth.js';

// ---- 添加根节点 ----
export function addRoot(draft, type, name, extra = {}) {
    // 只读边界：创建节点也是"手改"（它会成为树上的一条数据）
    assertManualEditAllowed(draft, '添加节点');

    const root = draft.nodes[draft.rootId];
    if (!root) throw new Error('树未初始化');
    if (!['W', 'S'].includes(type)) {
        throw new Error('根节点只能是 W 或 S');
    }
    const id = nextNodeId(draft);
    const overrides = { name: name.trim(), ...extra };
    const node = createNode(id, type, overrides);
    node.name = ensureUniqueName(draft, root.id, node.name);
    pushChild(draft, root.id, id);
    setParentOf(draft, id, root.id);
    setExpanded(draft, root.id, true);
    draft.nodes[id] = node;    ensureChildOrder(draft, id);
    // 存在性归属 + 建节点时填的值（同一套手改规则）
    markOrigin(node, { src: MANUAL_ORIGIN, account: draft.currentAccountId, at: node.createdAt });
    for (const key of Object.keys(overrides)) {
        recordManualValue(draft, node, key, '', node[key], {});
    }
    updateAddedSubtree(draft, id);
    return node;
}

// ---- 添加子节点 ----
export function addChild(draft, parentId, type, name, extra = {}, skipAutoUpdate = false) {
    // 只读边界：创建节点也是"手改"（它会成为树上的一条数据）
    assertManualEditAllowed(draft, '添加节点');

    const parent = draft.nodes[parentId];
    if (!parent) throw new Error('父节点不存在');
    const allowed = TYPE_CHILDREN_MAP[parent.type] || [];
    if (!allowed.includes(type)) {
        throw new Error(`父节点类型 ${parent.type} 不允许添加 ${type}`);
    }
    if (type !== 'R' && (!name || !name.trim())) {
        throw new Error('名称不能为空');
    }
    const id = nextNodeId(draft);
    const overrides = { name: type === 'R' ? '' : name.trim(), ...extra };
    if (type === 'P' && parent.type === 'C' && !overrides.problemId) {
        overrides.problemId = getNextProblemId(draft, parentId);
    }
    const node = createNode(id, type, overrides);
    if (type !== 'R') {
        node.name = ensureUniqueName(draft, parentId, node.name);
    }
    pushChild(draft, parentId, id);
    setParentOf(draft, id, parentId);
    setExpanded(draft, parentId, true);
    draft.nodes[id] = node;
    ensureChildOrder(draft, id);
    // 存在性也要有归属 —— 手建的节点记成 `manual` + 当前登录账户
    markOrigin(node, { src: MANUAL_ORIGIN, account: draft.currentAccountId, at: node.createdAt });
    // 建节点时填的那些值同样是"你给的" → 过同一套手改规则（派生元素会被自动排除）
    for (const key of Object.keys(overrides)) {
        recordManualValue(draft, node, key, '', node[key], {});
    }
    if (!skipAutoUpdate) {
        updateAddedSubtree(draft, id);
    }
    return node;
}

// ================================================================
// ⚠️ **结构改动只重算"变的那部分"**
//
// 整棵树重算一遍（`fullAutoUpdate(draft)`）的代价：真包 26k 节点实测
// "新建一道题" **~1250ms**，是最重的一个用户操作。
//
// 为什么可以只算一部分（这条不变量要看住，改规则时先读它）：
//   一个节点算出来的那些字段**只取决于它自己 + 它的后代** ——
//     · P：`acTime`/`lastSubmitTime`/`status2` 看的是它自己的 R 子节点，`xcpcDifficulty` 看自己的 `ratio`；
//     · C/W/S：`statusComplete1/2` 是**子汇总**（自底向上）；
//     · 唯一的插件规则（`features/TestnumOp` 的 `testNumSum`）也是"自身 + 直接子"。
//   ⇒ **结构一变，会变的只有"那棵子树 + 它的祖先链"**；别的节点一个字都不会变
//     （`fullAutoUpdate` 对它们只会得到同样的值、`changed` 计数为 0）。
//   守卫：`scripts/smoke/tree-ops-incremental.smoke.mjs`（**冒烟**，不是单测 —— 本模块会牵进
//   `shell/state.js` 的裸包名 `immer`，纯 Node 单测解析不了）。它两头都钉：
//     · 正确性：每个结构操作之后，再跑一次 `fullAutoUpdate` 必须**返回 0**（增量把该改的都改了）；
//     · "确实没整树重算"：给 `childOrder` 挂记账代理，断言结构操作只读了"子树 + 祖先链"那么多格
//       （只对拍正确性的话，改回全量重算也照样全绿 —— 实测）。
//
// 增/删/复制一整棵子树 ⇒ 重算**新（旧）子树 + 祖先**；只删/加一个节点 ⇒ 重算**它自己 + 祖先**。
// ================================================================

// ---- 增/删/移动/清空的公共小件 ----

/** 加完/复制完一棵子树：子树自底向上算一遍，再顺着祖先链滚上去 */
function updateAddedSubtree(draft, newRootId) {
    const changed = autoUpdateSubtree(draft, newRootId);
    return changed + propagateUp(draft, newRootId);
}

/** 删掉/移走一段之后：从那个位置上方的节点开始，往上重算 */
function updateAfterRemoval(draft, parentId) {
    return parentId ? autoUpdateChain(draft, parentId) : 0;
}
export function deleteNode(draft, id) {
    assertManualEditAllowed(draft, '删除节点');
    if (id === draft.rootId) throw new Error('不能删除根节点');
    const parentId = findParentId(draft, id);
    if (parentId === null) throw new Error('节点不存在');
    const childIds = draft.childOrder[parentId];
    const idx = childIds.indexOf(id);
    if (idx === -1) throw new Error('节点不在父节点列表中');
    childIds.splice(idx, 1);
    const node = draft.nodes[id];
    const ids = collectSubtreeIds(draft, id);
    // 被删的子树里可能**有合成节点**，指向它们的成员指针必须在**同一个事务**里清掉。
    // 否则自动保存可能只落一半 —— 树里留着一批指向死标识的指针（口径：
    // 死指针要"看得见 + 一键清"，但删除时就该顺手清干净，别制造它）。
    const deadSynthKeys = ids.map(cid => synthKeyOf(draft.nodes[cid])).filter(Boolean);
    for (const cid of ids) {
        delete draft.nodes[cid];
        delete draft.childOrder[cid];
        forgetParentOf(draft, cid);
    }
    clearOwnersOf(draft, deadSynthKeys);
    // 变了的是"原来那个父节点的子集合" ⇒ 从它开始往上重算
    updateAfterRemoval(draft, parentId);
    return { idsToClean: ids, deletedNode: node };
}

// ---- 换父 ----
/**
 * 把节点换挂到另一个父下（手工/UI 那条路；**结构手术只有一份** —— `_helpers.reparent`）。
 *
 * 为什么必须有它：应用里**没有**别的换父入口（只有同级上移/下移），而"这一场该挂在哪"
 * 的真源在**包里**（记录的 `父extKey`）。不搬的话，脚本侧的落位改动
 * （`scripts/nature-rehome.mjs` 那种）在应用里**永远看不见** ——
 * "分类说 xcpc、树里却还挂在 Universal Cup 下"就只能靠人手删了重导（连手填一起丢）。
 *
 * 口径：
 *   · **同级顺序 = 挂到新父的末尾**（与导入新建同一口径，不猜人想要的次序）；
 *   · 两个父的祖先链都重算（旧父少一个孩子、新父多一个）；
 *   · 类型层级仍走唯一一份判据 `badParentTypeMessage`（`W` 下不能直接放 `C` 那种）。
 * 不变量：`parentOf` 是**派生**索引（提交时由 `applyState` 重建）—— 事务内走
 *   `_helpers.parentOfInDraft` / `setParentOf`（**别直接写 `draft.parentOf`**，见文件头）。
 *
 * ⚠️ 导入那条路（`upsertRecord`）**只调 `_helpers.reparent`**：它不需要这里的两样 ——
 *    类型校验在上游已做、重算由导入循环结束时统一跑（见那边注释）。
 */
export function moveNode(draft, id, newParentId) {
    assertManualEditAllowed(draft, '移动节点');
    const node = draft.nodes[id];
    const parent = draft.nodes[newParentId];
    if (!node) throw new Error('节点不存在');
    if (!parent) throw new Error('目标父节点不存在');
    if (parentOfInDraft(draft, id) === newParentId) return false;
    const msg = badParentTypeMessage(parent.type, node.type, {
        parentKey: parent.extKey || '', childKey: node.extKey || '', parentCol: '父extKey'
    });
    if (msg) throw new Error(msg);
    const oldParentId = findParentId(draft, id);
    if (oldParentId === null) throw new Error('节点不在树上');
    if (!reparent(draft, id, newParentId)) return false;
    updateAfterRemoval(draft, oldParentId);
    autoUpdateChain(draft, newParentId);
    return true;
}

// ---- 上移 ----
export function moveUp(draft, id) {
    assertManualEditAllowed(draft, '移动节点');
    const parentId = findParentId(draft, id);
    if (parentId === null) throw new Error('节点不存在');
    const childIds = draft.childOrder[parentId];
    const idx = childIds.indexOf(id);
    if (idx <= 0) throw new Error('已在最上方');
    // ★ 人排过这个容器的顺序 ⇒ 导入时的同层重排**跳过**它（见 `elements.js` 的 `manualOrder`）
    if (draft.nodes[parentId]) draft.nodes[parentId].manualOrder = true;
    [childIds[idx - 1], childIds[idx]] =
        [childIds[idx], childIds[idx - 1]];
    return true;
}

// ---- 下移 ----
export function moveDown(draft, id) {
    assertManualEditAllowed(draft, '移动节点');
    const parentId = findParentId(draft, id);
    if (parentId === null) throw new Error('节点不存在');
    const childIds = draft.childOrder[parentId];
    const idx = childIds.indexOf(id);
    if (idx === -1 || idx >= childIds.length - 1) {
        throw new Error('已在最下方');
    }
    // ★ 同 `moveUp`：人排过 ⇒ 导入时的同层重排跳过它
    if (draft.nodes[parentId]) draft.nodes[parentId].manualOrder = true;
    [childIds[idx + 1], childIds[idx]] =
        [childIds[idx], childIds[idx + 1]];
    return true;
}

// ---- 复制节点（含所有后代，深拷贝重置 id） ----
export function copyNode(draft, sourceId, targetId) {
    assertManualEditAllowed(draft, '复制节点');
    const source = draft.nodes[sourceId];
    if (!source) throw new Error('源节点不存在');
    const target = draft.nodes[targetId];
    if (!target) throw new Error('目标节点不存在');
    const allowed = TYPE_CHILDREN_MAP[target.type] || [];
    if (!allowed.includes(source.type)) {
        throw new Error(`目标节点不允许添加 ${source.type}`);
    }
    const copy = deepCopyWithNewIds(draft, sourceId, targetId);
    if (copy.type === 'P' && target.type === 'C') {
        copy.problemId = getNextProblemId(draft, targetId);
    }
    if (copy.type !== 'R') {
        copy.name = ensureUniqueName(draft, targetId, copy.name);
    }
    pushChild(draft, targetId, copy.id);
    setExpanded(draft, targetId, true);
    updateAddedSubtree(draft, copy.id);
    return copy;
}

// ---- 清空指定节点的所有 P 节点（含其子树） ----
export function clearProblems(draft, nodeId) {
    assertManualEditAllowed(draft, '清空题目');
    const node = draft.nodes[nodeId];
    if (!node) throw new Error('节点不存在');
    const pIds = collectByTypeInDraft(draft, nodeId, 'P');
    if (pIds.length === 0) return { count: 0, idsToClean: [] };
    const pIdSet = new Set(pIds);
    const idsToClean = [];
    for (const pid of pIds) {
        for (const sid of collectSubtreeIds(draft, pid)) idsToClean.push(sid);
    }
    removeChildrenByPredicate(draft, nodeId, cid => pIdSet.has(cid));
    // 被清掉的 P 里可能有合成节点 ⇒ 成员指针同事务清（同 deleteNode 的理由）
    const deadSynthKeys = idsToClean.map(cid => synthKeyOf(draft.nodes[cid])).filter(Boolean);
    for (const id of idsToClean) {
        delete draft.nodes[id];
        delete draft.childOrder[id];
        forgetParentOf(draft, id);
    }
    clearOwnersOf(draft, deadSynthKeys);
    // 这一整棵子树里的容器都可能变（题目没了）⇒ 子树 + 祖先链一起重算
    autoUpdateSubtree(draft, nodeId);
    propagateUp(draft, nodeId);
    return { count: pIds.length, idsToClean };
}

// ---- 清空指定节点的所有 R 节点 ----
export function clearSubmissions(draft, nodeId) {
    assertManualEditAllowed(draft, '清空提交');
    const node = draft.nodes[nodeId];
    if (!node) throw new Error('节点不存在');
    const rIds = collectByTypeInDraft(draft, nodeId, 'R');
    if (rIds.length === 0) return { count: 0, idsToClean: [] };
    const rIdSet = new Set(rIds);
    removeChildrenByPredicate(draft, nodeId, cid => rIdSet.has(cid));
    // 被清掉的 R 里可能有合成节点 ⇒ 成员指针同事务清
    const deadSynthKeys = rIds.map(cid => synthKeyOf(draft.nodes[cid])).filter(Boolean);
    for (const id of rIds) {
        delete draft.nodes[id];
        delete draft.childOrder[id];
        forgetParentOf(draft, id);
    }
    clearOwnersOf(draft, deadSynthKeys);
    // 提交没了 ⇒ 那些 P 的 `status2`/`acTime` 会变 ⇒ 子树 + 祖先链一起重算
    autoUpdateSubtree(draft, nodeId);
    propagateUp(draft, nodeId);
    return { count: rIds.length, idsToClean: rIds };
}

// ================================================================
// 内部辅助
// ================================================================

function findParentId(draft, id) {
    return parentOfInDraft(draft, id);
}

/** 下一个空闲题号（`A`..`Z` → `X1`..）—— 规则在 `_helpers.js`，这里只是对外名字 */
export function getNextProblemId(draft, cId) {
    return nextFreeProblemId(draft, cId);
}

function collectSubtreeIds(draft, rootId) {
    const ids = [];
    (function walk(nid) {
        ids.push(nid);
        for (const cid of draft.childOrder[nid]) {
            walk(cid);
        }
    })(rootId);
    return ids;
}

function collectByTypeInDraft(draft, rootId, type) {
    const result = [];
    (function walk(nid) {
        const n = draft.nodes[nid];
        if (n.type === type) result.push(nid);
        for (const cid of draft.childOrder[nid]) {
            walk(cid);
        }
    })(rootId);
    return result;
}

function removeChildrenByPredicate(draft, parentId, pred) {
    const kept = [];
    for (const cid of draft.childOrder[parentId]) {
        const c = draft.nodes[cid];
        if (!c) continue;
        if (pred(cid)) continue;
        kept.push(cid);
        removeChildrenByPredicate(draft, cid, pred);
    }
    draft.childOrder[parentId] = kept;
}

function deepCopyWithNewIds(draft, sourceId, parentId) {
    const now = getNowStr();
    function clone(id, pid) {
        const src = draft.nodes[id];
        const newId = nextNodeId(draft);
        // ⚠️ 这三个字段**不能跟着复制**：
        //   - `origin`（存在性归属）：只由"创建时"写一次，抄过去会让副本永久自称
        //     "是那个来源建的"（`markOrigin` 幂等，改不回来）→ 下面按 MANUAL_ORIGIN 重标；
        //   - `extKey`（身份键）：树上 extKey 全局唯一，副本抄一份就成了**重复身份** ——
        //     `buildExtKeyIndex` 只认最先遇到的那个，之后导入永远只更新其中一个，且不报错；
        //   - `importFingerprint`/`importSource`：它们描述"这个节点是哪次导入带来的"，
        //     对副本来说是假话（与 origin 同一性质）。
        // 副本是**你现在建的一个新节点**：身份、指纹、归属都该从头开始。
        const {
            origin: _origin, extKey: _extKey,
            importFingerprint: _fingerprint, importSource: _importSource,
            ...rest
        } = src;
        draft.nodes[newId] = {
            ...rest,
            id: newId,
            createdAt: now,
            lastModified: now,
            extKey: ''                                   // 与 createNode 的默认值一致
        };
        markOrigin(draft.nodes[newId], {
            src: MANUAL_ORIGIN, account: draft.currentAccountId, at: now
        });
        draft.childOrder[newId] = [];
        setParentOf(draft, newId, pid);
        for (const cid of draft.childOrder[id]) {
            const clonedId = clone(cid, newId);
            pushChild(draft, newId, clonedId);
        }
        return newId;
    }
    const newRootId = clone(sourceId, parentId);
    return draft.nodes[newRootId];
}