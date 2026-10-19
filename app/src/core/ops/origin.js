// ================================================================
// 节点创建归属（core/ops/origin.js）
//
// **"元素在不在"本身也是一个元素**，
// 它同样该记"谁让它出现的"。这里实现**只做创建归属**的那一半 ——
// 删除不记（不引入墓碑：那要给全库读取端加"还活着吗"的判断，收益远小于成本）。
//
// 存在的形状（存在性元素的值）
// --------------------------
//     node.origin = { src: 'manual' | <导入包来源 id>, account: <账户 id | ''>, at: <时间> }
//
// 三条规矩：
//   1. **永不覆盖**（`markOrigin` 只在没有 origin 时写）—— "谁最先让它出现"是事实，
//      后续的导入/复制不该改写它；因此这个函数是幂等的，谁先到谁是创建者；
//   2. `account` 空 = 客观（与任何账户无关），与值级来源同一套语义；
//   3. `origin` 是**结构保护字段**（见 core/ops/upsert.js 的 PROTECTED_NODE_KEYS）：
//      导入包不许写它，否则一个 crate 就能伪造"这个节点是我建的"。
//
// 依赖：无（纯函数），可进 Node 单测。
// ================================================================

/** 节点上承载"存在性"这个元素的字段名 */
export const ORIGIN_FIELD = 'origin';

/** 手建（含手粘表格）的来源 id —— 与值级来源的 `manual` 同一个词 */
export const MANUAL_ORIGIN = 'manual';

/**
 * 写入创建归属（**幂等**：已经有 origin 的节点原样不动）。
 *
 * @param {Object} node
 * @param {Object} info - `{ src, account, at }`（`at` 省略 → 取 `node.createdAt`）
 * @returns {boolean} 是否真的写入了（false = 已经有 origin，或 node 不合法）
 */
export function markOrigin(node, info = {}) {
    if (!node || typeof node !== 'object') return false;
    if (node[ORIGIN_FIELD]) return false;                 // 先到先得，永不覆盖
    const src = String(info.src || MANUAL_ORIGIN);
    node[ORIGIN_FIELD] = {
        src,
        // 空 = 客观（没有账户归属）
        account: (info.account === undefined || info.account === null) ? '' : String(info.account),
        at: String(info.at || node.createdAt || '')
    };
    return true;
}

/**
 * 读创建归属（老节点没有 → null，**不编造**）。
 *
 * @param {Object} node
 * @returns {{src:string, account:string, at:string}|null}
 */
export function originOf(node) {
    const o = node && node[ORIGIN_FIELD];
    if (!o || typeof o !== 'object') return null;
    return {
        src: String(o.src || ''),
        account: String(o.account || ''),
        at: String(o.at || '')
    };
}
