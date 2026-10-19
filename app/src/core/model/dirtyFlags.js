// ================================================================
// 脏标记判定（core/model/dirtyFlags.js）
// 职责：一次事务提交后，判断它是否影响了「持久化数据」/「导出数据」
// 依赖：A_registry.js
// 说明：本模块**不碰 DOM、不依赖 immer**，可在 Node 测试中直接引用。
//
// 为什么需要：
//   InfoState 上有两个语义**不同**的标记：
//     dbIsSaved   —— 最新数据是否已写入 IndexedDB（persist: true 的字段）
//     jsonIsSaved —— 最新数据是否已导出为本地文件（export: true 的字段）
//   每次事务提交都无条件清掉两者的话，「切个 tab」也会显示"JSON未导出"
//   —— 但 currentTab 是 persist:true / export:false，切 tab 并不改变导出文件内容。
//
// 判据直接取自 A_registry.js 的字段表（USER_FIELDS），不另立一份清单。
// ================================================================
import { PERSIST_ROOTS, EXPORT_ROOTS, REGISTERED_ROOTS } from '../../A_registry.js';

/**
 * 找出引用发生变化的顶层字段。
 * 依赖 Immer 的结构共享：字段未变则引用不变。
 * @param {Object} before
 * @param {Object} after
 * @returns {Set<string>}
 */
export function changedRoots(before, after) {
    const roots = new Set();
    if (!before || !after) return roots;
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of keys) {
        if (before[key] !== after[key]) roots.add(key);
    }
    return roots;
}

/**
 * **节点级"谁变了"（唯一判据）**：按**引用**比 —— Immer 结构共享 ⇒ 改过的节点必然换引用。
 *
 * 为什么要有这一份：事务提交后有两件事都要"节点级名单" ——
 *   · 提交时**补冻**这次新产生的可写副本（`applyState` 的第三个参数）；
 *   · 值修改的**增量**（那一趟 / 派生表只碰名单里的节点 + 祖先链）。
 * 以前是各写各的（两趟 27k 的引用比较，实测真包各 ~5~10ms）⇒ 合成一处，**一趟算齐**。
 *
 * ⚠️ `ids` 里**含新增**的（它在 `after` 里、`before` 里没有 ⇒ 引用必然不同），
 *    **不含删掉的**（它不在 `after` 里，没什么可冻、也没有"行"可复用）；
 *    有删除时 `deleted` 为真，调用方自己决定要不要退回整份重算（增量一律不敢接）。
 *
 * @param {Object} before - 改动前的 `nodes`
 * @param {Object} after - 改动后的 `nodes`
 * @returns {{ids: string[], deleted: boolean}}
 */
export function changedNodeIdsOf(before, after) {
    const b = before || {};
    const a = after || {};
    const ids = [];
    for (const id in a) if (b[id] !== a[id]) ids.push(id);
    let deleted = false;
    for (const id in b) if (!(id in a)) { deleted = true; break; }
    return { ids, deleted };
}

/**
 * 判定一次变更影响哪些标记
 *
 * 未在注册表（`A_registry.js` 的 USER_FIELDS / SIDE_FIELDS）登记的字段按「既影响持久化也影响导出」处理：
 * 将来新增字段若忘了登记，行为退化为"照常标记脏"，
 * 而不是静默地不保存、不提示导出。
 *
 * @param {Object} before - 变更前的状态
 * @param {Object} after - 变更后的状态
 * @returns {{persisted: boolean, exported: boolean, roots: string[]}}
 */
export function classifyChanges(before, after) {
    const roots = changedRoots(before, after);
    const list = [...roots];

    return {
        persisted: list.some(r => PERSIST_ROOTS.has(r) || !REGISTERED_ROOTS.has(r)),
        exported: list.some(r => EXPORT_ROOTS.has(r) || !REGISTERED_ROOTS.has(r)),
        roots: list
    };
}
