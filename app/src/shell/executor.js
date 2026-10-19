// ================================================================
// 统一事务入口（shell/executor.js）
// 职责：组装 AppState + persistence + 事务层 + 事件派发
// 依赖：shell/state.js, transaction/executor.js, persistence/index.js,
//       core/validate/expanded.js, A_constants.js, utils/A_helpers.js
// 说明：handlers / UI / 入口层只调 execute / undo，不感知底层细节
// ================================================================



import { AppState, replaceState } from './state.js';
import { executeTransaction, undo as undoRaw } from '../transaction/executor.js';
import { flushPendingSave, saveData, scheduleSave } from '../persistence/index.js';
import { validateExpandedLimit } from '../core/validate/expanded.js';
import { refreshAllVirtualStats } from '../core/ops/virtualStats.js';
import { EVENTS } from '../A_constants.js';
import { emit } from '../utils/A_helpers.js';

import { rebuildParentOf } from '../core/model/state.js';
import { normalizeIdCounter } from '../core/model/convert.js';
import { normalizeStateValues } from '../core/fieldValue.js';
import { captureState, resetHistory } from '../transaction/history.js';
import { InfoState, markModified } from '../core/model/infoState.js';
import { importedState } from '../A_registry.js';

function defaultValidateFn(nextState) {
    const limit = nextState.settings.performance.expandedNodeBlockLimit;
    const nodePerPage = nextState.settings.display.nodePerPage;
    return validateExpandedLimit(nextState, limit, nodePerPage);
}

/**
 * 默认的 UI 刷新：派发 `UI_REFRESH_REQUIRED`。
 * ⚠️ 别在调用点自己再派发一遍（那才是"刷新跑两遍"的老毛病）。
 */
function defaultRefreshFn(parentId) {
    document.dispatchEvent(new CustomEvent(EVENTS.UI_REFRESH_REQUIRED, {
        detail: { parentId }
    }));
}

/**
 * 执行事务（统一入口）
 * @param {Function} operation - (draft) => result
 * @param {Object} options - 覆盖默认配置
 * @returns {Promise<any>}
 */
export async function execute(operation, options = {}) {
    const defaultHistorySteps = AppState.settings.performance.historySteps;
    // 探针实测：副页统计（`refreshAllVirtualStats`）在 immer draft 里
    // 跑一次 ≈17ms（20k 节点、2k 虚节点）—— 而**折叠**只改"看的姿势"（`expanded`），
    // 不碰任何取值，副页统计不可能变。于是折叠那几处显式声明 `skipVirtualStats: true`，
    // 把这次纯浪费省掉；其余事务照旧（默认 false，保证"任何事务后统计都是新的"）。
    const skipVirtualStats = !!options.skipVirtualStats;
    // ★ **没有副页就别读 `draft.pages`**。
    //   为什么：读 draft 的属性会**创建一个子 draft**，而 Immer 在提交时按顶层键序逐个 finalize；
    //   只要还有"没 finalize 完的 draft"，它就会对**后面那些还没走到的大字典做深度遍历**
    //   （`core/derive.js` 里记着同一个机制）。真包 27k 节点实测：**这一句读 = ~380ms**，
    //   而 `pages` 为空时它**什么都不做**（`for (const pageId in draft.pages)` 空转）。
    //   ⇒ 用**基础对象**（`AppState.pages`，不经代理 ⇒ 不建 draft）先判一下，白读就省掉。
    //   ⚠️ 代价（很小、且会自愈）：**本次事务新建的第一个副页**不做统计，下一次改动会补上
    //      —— 新建的副页本来就是空的，等于没有可算的东西。
    const pagesExisted = Object.keys(AppState.pages || {}).length > 0;
    // 折叠只改 `expanded`，折叠态真源是 localStorage
    // ⇒ 折叠事务声明 `skipPersist`：不标脏、不报 DB_MODIFIED、不登记落盘。
    const skipPersist = !!options.skipPersist;
    return executeTransaction(AppState, (draft) => {
        const result = operation(draft);
        if (!skipVirtualStats && pagesExisted) refreshAllVirtualStats(draft);
        return result;
    }, {
        validateFn: defaultValidateFn,
        // ⚠️ **合并写** —— 事务提交后只登记，300ms 内的
        // 多次改动合成一次落盘（探针实测：每次同步落盘 ≈15.6ms 常数 + 全表 diff）。
        // 代价：**崩溃最多丢最近 ~300ms 的改动**；期间 `dbIsSaved=false`，
        // 指示器照实显示"未保存"，页面离开/显式保存/导出/导入前都会强制 flush。
        saveFn: skipPersist ? null : () => scheduleSave(AppState),
        skipPersist,
        emitFn: emit,
        // ⚠️ 调用方给了 `refreshFn` 就用它的；否则用默认那个 ——
        //    别在调用点自己派发一遍 `UI_REFRESH_REQUIRED`（那才是"刷新跑两遍"的老毛病）。
        refreshFn: options.refreshFn || ((parentId) => defaultRefreshFn(parentId)),
        DB_MODIFIED_EVENT: EVENTS.DB_MODIFIED,
        maxHistorySteps: defaultHistorySteps,
        ...options
    });
}

/**
 * 撤回
 * @returns {Promise<boolean>}
 */
export async function undo() {
    return undoRaw(AppState, {
        saveFn: () => scheduleSave(AppState),
        emitFn: emit,
        refreshFn: defaultRefreshFn,
        DB_MODIFIED_EVENT: EVENTS.DB_MODIFIED
    });
}

// ================================================================
// 单点更新（**增 / 删 / 改一个点都归这里**；删点 = 更新它的父节点）
//
// 为什么单开一个入口：三种操作在数据上是**同一件事** —— 树上一条记录变了。
//   第二阶段（单点优化）只改**这一个函数体**：把"这一处变化引起的连锁"从
//   "全量重算"换成"只重算受影响的那部分"，调用方（UI / handlers）一个字不用改。
//
// ⚠️ 现在函数体 = **原有逻辑**（转手给 `execute`），行为与以前逐字相同。
//    先只把这个接缝留出来，不提前做任何优化。
//
//    "变的是哪个点"不用另外传：`operation` 的返回值就带着 ——
//      · 增：`addChild` 返回**新节点**；
//      · 删：`deleteNode` 返回 `{ idsToClean, deletedNode }`，要更新的是它的父；
//      · 改：`updateP` / `updateR` / `updateWS` / `updateRemark` 返回**那个节点**。
// ================================================================
export async function executePointUpdate(operation, options = {}) {
    // ★ 第二阶段：**纯顺序改动**（上移/下移）—— 值一个都不变（真包 27206 节点 × 两种模式
    //   逐字段对拍 0 不同，覆盖表也逐条相同，见 `core/query/valueCaches.js`）
    //   ⇒ 只做事务 + 重画，各份按代缓存**接到新一代**上（省掉白跑的一整趟 ~150~250ms）。
    if (options.orderOnly) {
        return execute(operation, { ...options, orderOnly: undefined, carryValueCaches: true });
    }
    return execute(operation, options);
}

// ================================================================
// 整体导入（替换 AppState 全部数据 + 重置历史）
// 用途：importFullJSON 使用
// 语义：与常规事务（增量修改）不同，不走 Immer
// 顺序：先写盘 → 再替换内存 → 重置历史 → 派发刷新
// ================================================================
/**
 * @param {Object} newState - 导入数据（整份导出包对象；缺哪一节见 `importedState` 的规则）
 * @returns {Promise<void>}
 */
export async function importState(newState) {
    // 1. 构造完整 state（名单派生自 `A_registry.js` 的 USER_FIELDS）
    //    ⚠️ 手写顶层键会漏（`fieldRegistry`/`reports`）⇒
    //    "文件里明明带着、导进来却没有"。加落盘字段不用改这里。
    const complete = importedState(newState, AppState);
    // ⚠️ 兜底：包**没有** `nodes` 时 `importedState` 会"沿用手上这份"
    //   （老存档语义，`registryCoverage.test.js` 钉着）—— 而那时候手上这份**已经冻结**，
    //   紧接着的 `normalizeStateValues(complete)` 是**就地写节点**（`fieldValue.js` 的
    //   `repairNodeCacheShapes` / `delete n.mappingElementValue`）⇒ 会抛一句看不懂的
    //   "Cannot add property …, object is not extensible"。
    //   正常入口（`handlers/H1_jsonIO.js`）已经在校验里挡掉了缺 `nodes` 的文件，这条只是
    //   "哪天多一条导入入口"时的兜底：宁可说清"包缺少 nodes"。
    if (complete.nodes === AppState.nodes) {
        throw new Error('导入包缺少 nodes（不能沿用手上这份：它已冻结，归一化会就地写节点）');
    }
    complete.parentOf = rebuildParentOf(complete.childOrder);
    // ★ 任何"整体换掉 state"的路径都必须走这一步（幂等）：补默认 + 回填来源层。
    //   漏掉它的后果实测过：从文件导入的数据来源层永远是空的。
    normalizeStateValues(complete);
    // ★ **把 id 计数器抬到所有已有 id 之上**（`v9.3.1`）：id 的唯一性全靠计数器，
    //   而导入是"换一份数据"⇒ 必须重算，否则接着新建的节点/副页/计划可能与包里已有的**撞 id**
    //   （`v9.3.0` 那个"复制之后容器变单题"就是这一类：vNode id 撞了）。
    //   ⚠️ 这条与 `restoreDerived`（读存档那条路）是同一条口径 —— **两处都要有**。
    normalizeIdCounter(complete);

    // 2. 标记修改（lastModifiedTime / dbIsSaved / jsonIsSaved）
    markModified();

    // 3. 先把**待写的**写掉，再整体写盘（失败时 InfoState 会自动回滚，见 persistence/index.js）
    //    ⚠️ 顺序要紧：整体替换是"换一份世界"，导入前必须让上一份世界先落地。
    await flushPendingSave();
    await saveData(complete);

    // 4. 替换内存 AppState（引用不变，字段替换）
    replaceState(complete);

    // 5. 重置历史栈为「导入后状态」
    resetHistory(captureState(AppState));

    // 6. 派发刷新
    emit(EVENTS.DB_SAVED);
    emit(EVENTS.UI_REFRESH_REQUIRED, { parentId: null });
    emit(EVENTS.PAGE_TABS_REFRESH_REQUIRED);
}