// ================================================================
// 「用户覆盖」（pin）的取值（core/pin.js）
//
// `status1` / `status2` / `statusComplete2` 这类**派生**字段可以由用户按下覆盖
//（待写 / 赛时通过 / 忽略）—— 覆盖存在**来源层**里（`src === 'manual'`，带账户），
// 不是缓存字段。本模块就是从来源层把"本次范围里生效的那条覆盖"取出来。
//
// 为什么单独一个文件：
//   覆盖的取值长在 `core/derive.js` 里。而**自动计算**那条路
//  （`core/autoComputeRules.js` 的 `computePstatus2`，负责把值写回**缓存字段**）
//   也需要同一个判据 —— 它拿的是 `node.status2`（**缓存字段**）当覆盖是不行的：
//   缓存只有一份，多账户下会把**别人**的覆盖当成我的。
//   把判据放到更底层的本模块，两条路（视图按范围算 / 写回缓存）走**同一份**逻辑，
//   且不产生 `derive ⇄ autoComputeRules` 的循环依赖。
//
// 依赖：core/fieldValue.js（`MANUAL_SRC`）、core/trust.js 的 `resolveScope`（只在 `pinScopeOf` 里用）
// ================================================================
import { accountOfEntry, MANUAL_SRC } from './fieldValue.js';

/**
 * 范围内、`src === 'manual'` 的**最新一条** = 本次范围的手动覆盖。
 *
 * @param {Object} node
 * @param {string} field
 * @param {Set<string>|null} scope - 账户集合；`null` = 不过滤（看全部）
 * @returns {string|null} 覆盖值（**字符串**，来源层里就是字符串）或 null
 */
export function pinnedValue(node, field, scope) {
    const list = (node && node.values && node.values[field]) || [];
    let best = null;
    for (const e of list) {
        if (!e || e.src !== MANUAL_SRC || e.invalid) continue;
        const account = accountOfEntry(e);
        // 覆盖也有归属：范围外的账户按的"忽略"不该影响本范围
        if (scope && account && !scope.has(account)) continue;
        if (!best || String(e.at || '') > String(best.at || '')) best = e;
    }
    return best ? best.v : null;
}

/**
 * 本次生效的覆盖值（字符串）或 `null`。
 *
 * **没有"退回缓存"的兜底** —— 没有老数据（读路径不留回退兜底）：覆盖只从来源层来。
 */
export function effectivePin(node, field, scope) {
    const scoped = pinnedValue(node, field, scope);
    return scoped === null ? null : String(scoped);
}

/**
 * "以某个账户的身份"这一个范围 —— 写回缓存字段时用（缓存是**当前账户**那一份）。
 *
 * 与视图侧一致：没有当前账户（`''`/undefined）= 不过滤（`null`）。
 */
export function pinScopeOf(accountId) {
    const id = (accountId === undefined || accountId === null) ? '' : String(accountId);
    return id ? new Set([id]) : null;
}
