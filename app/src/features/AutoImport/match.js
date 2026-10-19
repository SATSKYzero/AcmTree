// ================================================================
// 节点自动导入 — 匹配判定（features/AutoImport/match.js）
// 职责：extKey 精确相等的匹配判定 + 全局哈希表查找
// 依赖：无
// 设计依据：docs/auto-import.md 4.2 / 4.3 / 11.2
//
// ⚠️ 本模块的不变量：**相似度永不参与判定**。
//   整条判定逻辑只有一句：
//       node.extKey === record.extKey   （逐字符完全一致）
//   相似度只属于 similarity.js，它产出的东西**只是警告**——
//   不阻断、不门控、不设上限、也不影响本模块的任何返回值。
//   任何"模糊匹配 / 阈值 / 打分 / 降级 / 题号归一化"的写法都是
//   对本设计的破坏（4.2 明确不设那些层级）。
//
// 作用域隔离（4.3）：调用方必须只在**已解析出的父容器**作用域内查
//   `keyIndex`。跨比赛、跨平台绝不匹配。这是正确性规则，与模糊无关。
//
// 说明：本模块**不碰 DOM、不 import view/ shell/**，可在 Node 测试中直接引用。
// ================================================================

// ================================================================
// 查找
// ================================================================

/**
 * 在 extKey 索引里精确查找节点。
 *
 * 只做 `trim` + 精确相等比较：不做大小写折叠、不做任何其它归一化。
 * index 为 `extKey → nodeId` 的（全局）哈希表，见 2.4 / 11.1 的
 * `core/ops/upsert.js#buildExtKeyIndex`。
 *
 * @param {Object<string,string>} keyIndex - extKey → nodeId
 * @param {string} extKey
 * @returns {string|null} nodeId，未命中返回 null
 */
export function findByExtKey(keyIndex, extKey) {
    const key = extKey === undefined || extKey === null ? '' : String(extKey).trim();
    if (key === '') return null;
    if (keyIndex === null || typeof keyIndex !== 'object') return null;
    if (!Object.prototype.hasOwnProperty.call(keyIndex, key)) return null;

    const nodeId = keyIndex[key];
    if (nodeId === undefined || nodeId === null || nodeId === '') return null;
    return nodeId;
}

// ================================================================
// 判定
// ================================================================

/**
 * 决定一条记录的动作。**没有模糊匹配，永远没有**（4.2）。
 *
 * @param {Object} node - 已命中的节点，或 null
 * @returns {'merge'|'create'}
 */
export function decideAction(node) {
    const exists = node !== null && typeof node === 'object' && !Array.isArray(node);
    return exists ? 'merge' : 'create';
}
