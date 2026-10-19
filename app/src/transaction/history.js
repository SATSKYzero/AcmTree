// ================================================================
// 历史栈管理（transaction/history.js）
// 职责：保存字段引用快照、撤回
// 依赖：core/model/state.js（rebuildParentOf）、A_registry.js（快照名单）
// ================================================================

import { rebuildParentOf, freezeNodes, freezeNodeList, freezeTopLevel } from '../core/model/state.js';
// ---- 需要纳入历史快照的 AppState 字段 ----
// 名单**派生自 `A_registry.js`**（`snapshot: true` 的那些）：谁算"能撤销的用户数据"
// 只有一处口径。派生不出来的两件事写在注释里：
//   · `parentOf` 为派生索引（从 childOrder 重建），注册表里 snapshot: false
//   · `currentTab` 是会话语义（TFF），注册表里 snapshot: false
//
// 名单漏一个维度，撤回就会留下"界面提示已回退、那份数据却原样不动"的混合状态，
// 随后还会把这个混合状态写盘（账户表、`fieldRegistry` / `reports` 都属这一类）。
//
// remark / 私有笔记的撤销**不需要单独加一个 `remark` 键**
// —— 备注是**节点字段**（`core/model/node.js` 的 `createNode` 里 `remark: ''`），
// 而节点表整张在名单里（`nodes`），改动随它一起进快照。
// 加一个顶层 `remark` 只会得到 `undefined`（`AppState.remark` 根本不存在），
// 那是"看起来在做、实际什么都没做"。回归钉子见 `src/test/history.test.js`
// 的"★ remark 改动可撤销"。
import { SNAPSHOT_KEYS } from '../A_registry.js';

// ---- 历史栈 ----
let Hisstate = [];
let HisCount = -1;

export function getHistory() { return Hisstate; }
export function getHistoryCount() { return HisCount; }

/**
 * 从 AppState 抓取"字段引用快照"
 * 由于 Immer 保证旧引用不可变，此快照是安全的
 */
export function captureState(state) {
    const snap = {};
    for (const k of SNAPSHOT_KEYS) {
        snap[k] = state[k];
    }
    return snap;
}

/**
 * 将快照回填到 AppState
 * 说明：
 *   - 提交场景：snapshot = produce 产物，含 AppState 全部字段，全部回填
 *   - 撤回场景：snapshot = captureState 产物，只含 SNAPSHOT_KEYS，只回填这些
 *   - parentOf 为派生索引，回填后立即从 childOrder 重建
 */
export function applyState(state, snapshot, changedIds) {
    // `parentOf` 是**派生索引**，只由 `childOrder` 决定 ⇒ `childOrder` 没换引用就不必重建
    //（真包 27k 节点实测 ~9ms/次；一次操作通常只改值、不动结构）
    const structChanged = !state.parentOf || (snapshot.childOrder !== undefined
        && snapshot.childOrder !== state.childOrder);
    for (const k of Object.keys(snapshot)) {
        state[k] = snapshot[k];
    }
    if (structChanged) state.parentOf = rebuildParentOf(state.childOrder);
    // Immer 的"深走"开关（见 `core/model/state.js` 的 `freezeNodes`）：事务刚改过的节点是
    // **可写的副本**，这里统一补冻一次 —— 一次事务只多花几毫秒，换来的是下一次事务不会
    // 为了找 draft 把整棵树走一遍（真包实测 389ms → 31ms）。
    // ★ 给了 `changedIds` 就**只补冻那几个**（真包实测全表扫 ~12ms/次，而真正要冻的只有
    //   这次新产生的副本；别的上一次就冻住了）。没给 ⇒ 退回全表版（兜底，别去掉）。
    if (Array.isArray(changedIds)) freezeNodeList(state, changedIds);
    else freezeNodes(state);
    // ★ 顶层大字典按白名单冻上（2026-10-18，**已开**；用户："你该把操作-白名单用起来，那有利于以后的维护"）：
    //   目的是**守住"顶层大字典只在事务里换、不许就地改"这条不变量**（性能上三档实测**无收益**：
    //   `只 produce：updateP` 31 → 38–39ms、`一次操作` 61 → 63–64ms ⇒ 理由是**维护性/守卫**，不是提速。
    //   详见 `docs/core-pitfalls.md` 的「冻结白名单」一节）。
    //   只冻**容器这一层**（值不冻）⇒ 事务里照旧能写；事务外就地改 `childOrder[x]` / `pages[x]` 当场 TypeError。
    //   ⚠️ 开它的代价是**夹具**：冒烟里"直接搭状态"的写法必须改成"换可变副本 / 换整张字典 / 克隆页对象"
    //   （`page-sync` / `ui-wiring` / `nodeinfo-target` / `auto-import` / `import-synth` / `accounts` 都已改过）。
    freezeTopLevel(state);
}

// ---- 入栈 ----
export function pushHistory(beforeSnapshot) {
    if (!beforeSnapshot) return;
    if (Hisstate.length === 0) {
        Hisstate.push(beforeSnapshot);
        HisCount = 0;
        return;
    }
    Hisstate.unshift(beforeSnapshot);
    applyHistoryLimit();
}

// ---- 出栈（撤回） ----
/**
 * 撤回一步，返回**要回到的那个快照**。
 *
 * 栈的语义（别搞混）：`Hisstate[0]` 是**最近一次事务的"事务前快照"**，
 * 也就是撤回该回到的状态；`Hisstate[length-1]` 是哨兵（最早的那份，撤不动了）。
 *
 * ⚠️ 先 `shift()` 掉栈顶、再返回**下一个**更旧的快照会**跳过一步**
 * （S0→S1→S2→S3 之后撤回依次落到 S1、S0、空转）。
 * 正确做法是把栈顶本身返回。
 */
export function popHistory() {
    if (Hisstate.length <= 1) return null;
    const snapshot = Hisstate.shift();
    HisCount = Hisstate.length - 1;
    return snapshot;
}

// ---- 重置 ----
export function resetHistory(snapshot) {
    Hisstate = [snapshot];
    HisCount = 0;
}

// ---- 清空 ----
export function clearHistory() {
    if (Hisstate.length > 0) {
        Hisstate = [Hisstate[0]];
    } else {
        Hisstate = [];
    }
    HisCount = Hisstate.length - 1;
}

// ---- 应用步数上限 ----
export function applyHistoryLimit(maxSteps) {
    const limit = (maxSteps && maxSteps > 0) ? maxSteps : 25;
    while (Hisstate.length - 1 > limit) {
        Hisstate.pop();
    }
    HisCount = Hisstate.length - 1;
}

// ---- 加载历史（持久化反序列化时用） ----
export function setHistoryFromArray(arr) {
    if (!Array.isArray(arr)) throw new Error('历史数据必须是数组');
    Hisstate = arr;
    HisCount = arr.length - 1;
}