// ================================================================
// 事务执行器（transaction/executor.js）
// 职责：统一事务流程（Immer produce + 校验 + 提交/回滚）
// 依赖：immer, history.js, core/model/infoState.js
// ================================================================
import { produce, isDraft, original } from 'immer';
import {
    captureState,
    applyState,
    pushHistory,
    popHistory,
    resetHistory,
    getHistoryCount,
    applyHistoryLimit
} from './history.js';
import { markModified } from '../core/model/infoState.js';
import { classifyChanges, changedNodeIdsOf } from '../core/model/dirtyFlags.js';
import { rekeyValueCaches } from '../core/query/valueCaches.js';
import { applyValueDeltaToCaches } from '../core/query/countCache.js';
import { noteValueDelta } from '../core/derive.js';
// ★ 诊断日志的唯一开关（`localStorage.DSH_DIAG = '1'` + 刷新；见 `utils/diag.js` 文件头）
import { diag, diagOn, nowMs, msSince } from '../utils/diag.js';

/** 值修改增量：改动节点数上限（超了还不如让那一趟整棵重算） */
const VALUE_DELTA_MAX = 400;

/**
 * 执行事务
 * @param {Object} AppState - 全局状态容器（可变引用）
 * @param {Function} operation - (draft) => result
 * @param {Object} options
 *   - validateFn(nextState) => boolean        校验函数（可选）
 *   - saveFn() => Promise<void>               保存函数（可选）
 *   - emitFn(eventName) => void               事件派发（可选）
 *   - refreshFn(parentId) => void             UI 刷新（可选）
 *   - onSuccess(result) => void               成功回调（可选）
 *   - onError(err) => void                    失败回调（可选）
 *   - skipHistory                            是否跳过历史入栈（默认 false）
 *   - silent                                 是否静默（传给 applySnapshot 的语义，本层不处理）
 *   - refreshParentId                        传给 refreshFn
 *   - DB_MODIFIED_EVENT                      派发的事件名（默认为空字符串表示不派发）
 *   - maxHistorySteps                        历史步数上限
 * @returns {Promise<any>} operation 的返回值
 */
export async function executeTransaction(AppState, operation, options = {}) {
    const {
        validateFn = null,
        saveFn = null,
        emitFn = null,
        refreshFn = null,
        onSuccess = null,
        onError = null,
        skipHistory = false,
        // 折叠这类「只改看的姿势」的事务声明跳过持久化 ——
        // 折叠态的真源是 localStorage（core/model/viewState.js），不该进 IDB、
        // 也不该因此标脏或触发一次落盘。丢失无损失。
        skipPersist = false,
        refreshParentId = undefined,
        DB_MODIFIED_EVENT = '',
        maxHistorySteps = 25
    } = options;

    let beforeSnapshot = null;
    let historyPushed = false;

    if (!skipHistory) {
        beforeSnapshot = captureState(AppState);
        pushHistory(beforeSnapshot);
        applyHistoryLimit(maxHistorySteps);
        historyPushed = true;
    }

    let applied = false;
    let nextState = null;
    let result = undefined;
    let resultFromDraftId = '';      // 见 1b：操作把 draft 当结果返回时，记下 id，produce 之后再取**新**节点

    try {
        // 诊断（2026-10-18）：`t0` 必须从**进来那一刻**算起 —— 上一版把它放在 produce 之后，
        //   于是"produce + 分类"那几百毫秒被算到了看不见的地方（切主页 click 224ms，
        //   而事务里各段加起来只有 7ms，就是被这个错位藏掉的）。
        const txT0 = diagOn() ? nowMs() : 0;
        const txMark = (name) => {
            if (txT0) diag('事务', `${name} = ${msSince(txT0)}ms（累计）`);
        };
        // 1. Immer produce（结构共享）
        nextState = produce(AppState, draft => {
            result = operation(draft);
            // 1b. ⚠️ **操作返回的可能是 draft**（例如 `core/ops/node.js` 的 `updateP` 结尾 `return node`）——
            //     produce 一结束，那个代理就被**撤销**：`await execute(...)` 时
            //     `Promise.resolve(被撤销的代理)` 会去读它的 `.then` ⇒ 当场抛
            //     `Cannot perform 'get' on a proxy that has been revoked`。
            //     ⚠️ 症状很迷惑人：**返回 undefined 的 mutator 一点事没有**，只有"顺手把 draft 返回出来"的
            //        才会炸（导入真包之后改一个节点必炸，而把 mutator 改成块体就好了）。
            //     ⚠️ **必须在这里处理**：出了这个回调，连 `isDraft()` 自己都会因为读 `DRAFT_STATE` 而抛。
            //     只记下 id，等 produce 结束再从 `nextState` 取那条**改完之后**的普通节点（见下面 1c）。
            if (isDraft(result)) {
                const id = String((original(result) || {}).id || '');
                resultFromDraftId = id;
                result = undefined;
            }
        });
        // 1c. 把"draft 结果"换成 produce 产物里的**新节点**（普通对象、能安全读、而且是改完后的值）
        if (resultFromDraftId) {
            result = nextState && nextState.nodes ? nextState.nodes[resultFromDraftId] : undefined;
        }
        txMark('produce 完成');

        // 2. 校验
        if (validateFn && !validateFn(nextState)) {
            throw new Error('操作未通过校验');
        }

        // 3. 提交（回填 AppState）
        //    注意：applyState 会原地覆盖 AppState 的字段，所以必须在它之前
        //    比较新旧状态，才能知道这次事务究竟动了哪些顶层字段。
        const dirty = classifyChanges(AppState, nextState);
        const beforeNodes = AppState.nodes;              // `applyState` 之前先留一份（Immer 结构共享用）
        const beforeChildOrder = AppState.childOrder;
        // ★ 节点级"谁变了"——**这一趟算齐**（`changedNodeIdsOf`，唯一判据）：补冻用它、
        //   值增量用它、交给派生表的那份名单也用它（以前是各扫各的，一趟 27k 要跑三遍）。
        //   引用变了的那些节点 = **这次刚产生的可写副本** ⇒ 提交时只需补冻它们
        //   （`applyState` 的第三个参数；全表扫是 ~12ms/次，而真正要冻的只有这几个）
        const nodesChanged = changedNodeIdsOf(beforeNodes, nextState.nodes);
        const touchedIds = nodesChanged.ids;
        txMark('classifyChanges + changedNodeIdsOf 完成');
        // ★ 组划分（`ownerSynth` / `synthKey`）动没动过 —— 增量一律不敢接（见下面 valueDelta 那段），
        //   派生表那边也靠它决定"敢不敢只折受影响的那些组头"。**只看名单里的节点**，不扫全表。
        const groupingChanged = touchedIds.some((id) => {
            const b = beforeNodes ? beforeNodes[id] : undefined;
            const a = nextState.nodes[id];
            if (!b || !a) return true;
            return (b.ownerSynth || '') !== (a.ownerSynth || '')
                || (b.synthKey || '') !== (a.synthKey || '');
        });
        applyState(AppState, nextState, touchedIds);
        applied = true;
        // ★ **把这份名单交给按代缓存**（现在只有派生表读它）：它要"哪些行的值可能变了"，
        //   而这里**本来就算过** —— 不交的话那边只能再扫一遍全表按引用比（真包 ~11ms/次）。
        //   ⚠️ 只认"两代都对得上"的那一份；对不上（撤回 / 整包导入 / 别处直接换 state）⇒ 那边自己扫。
        noteValueDelta(beforeNodes, nextState.nodes, touchedIds, groupingChanged);
        // ★ **纯顺序改动**（上移/下移）：值一个都不变 ⇒ 把按代缓存**接到新一代**上，
        //    别让下一次读白跑一整趟（实测 ~150~250ms）。**必须在重画之前**做
        //    （重画会立刻读派生值，那时缓存已经是新一代的键了）。
        //    边界见 `core/query/valueCaches.js`：调用方必须用 `orderOnly` 声明。
        if (options.carryValueCaches) rekeyValueCaches(AppState);
        // ★ **值修改 / 加节点** ⇒ 走**增量**：
        //    · 值修改（只动 `nodes`、没动 `childOrder` = 没增删、没换顺序）：更新"改动节点所在组 + 祖先链"；
        //    · 加节点（`childOrder` 也变了，但**没有删除**）：新增键追加在末尾 ⇒ 扩数组即可
        //      （**不需要"减旧"**：新节点旧贡献为 0），要减旧的只有祖先。
        //    判据用 `classifyChanges` 的 roots（不扫全表）；改动/新增节点由**引用**认（Immer 结构共享）。
        else if (options.valueDelta !== false && dirty.roots.includes('nodes')) {
            // ⚠️ 剩下的判断全由"改动集合"兜着：
            //    · 有**删除** ⇒ `deleted` 为真 ⇒ 跳过；
            //    · 只是**换顺序**（上移/下移）⇒ `nodes` 引用没变 ⇒ 改动集合为空 ⇒ 跳过（走上面 `orderOnly`）；
            //    · **加节点** ⇒ 新键追加在末尾 ⇒ 那一趟自己用 `growWith` 再确认一次（容量/键序不符就返回 false）。
            const changed = nodesChanged.deleted ? null : touchedIds;
            if (changed && changed.length && changed.length <= VALUE_DELTA_MAX) {
                const added = [];
                const valueChanged = [];
                for (const id of changed) {
                    if ((beforeNodes || {})[id] === undefined) added.push(id);
                    else valueChanged.push(id);
                }
                // ⚠️ **组划分变了一律不接增量**（`ownerSynth` / `synthKey` 动了）：
                //    增量的组表是**上一代**的（值修改不重建），而组划分一变，
                //    老组该减的贡献没减、新组该加的没加 ⇒ **静默错数**（复杂组下实测：
                //    成员搬家后 total 27 vs 全量 26，之后一路差 1 —— 一次性 A/B 与真包走查都碰不到）。
                //    这类改动（判重页的归入/解绑）退回整棵重算。
                // ⚠️ **加节点暂不接增量**（用户 2026-10-07 定：稳字优先 —— 加节点收益最低、
                //    又是最后接上的那条；它同时动 `nodes` 与 `childOrder`）。
                //    `countPass.js` 里那套（容量 / `growWith` / 新增子树）是**已验证、留着**的：
                //    要启用只需删掉这一句 `if`（`added` 原样传给增量即可）。
                if (!added.length && !groupingChanged) {
                    applyValueDeltaToCaches(AppState, valueChanged,
                        { nodes: beforeNodes, childOrder: beforeChildOrder }, []);
                }
            }
        }
        // 诊断（2026-10-18，用户测得"切页 click 767ms、渲染只占 ~120ms" ⇒ 要定位事务里各段）：
        //   ⚠️ 纯日志；开关只在 `utils/diag.js` 一处（`localStorage.DSH_DIAG = '1'` + 刷新），
        //   默认关着 ⇒ 平时零输出、连时间戳都不算（用户 2026-10-18："诊断日志加全局开关…"）。
        const txLap = (() => {
            if (!txT0) return null;
            return (name) => diag('事务', `${name} = ${msSince(txT0)}ms（累计）`);
        })();
        if (txLap) txLap('applyState 等提交阶段 完成');

        if (!skipPersist) markModified(dirty);
        if (txLap) txLap('markModified 完成');

        // 4. 派发事件
        if (!skipPersist && emitFn && DB_MODIFIED_EVENT) {
            emitFn(DB_MODIFIED_EVENT);   // 没碰数据就不该报「DB 被改」
            if (txLap) txLap('DB_MODIFIED 广播完成');
        }

        // 5. 保存
        if (saveFn && !skipPersist) {
            await saveFn();
            if (txLap) txLap('saveFn（落盘）完成');
        }

        // 6. UI 刷新
        if (refreshFn) {
            refreshFn(refreshParentId !== undefined ? refreshParentId : null);
            if (txLap) txLap('refreshFn 完成');
        }

        // 7. 成功回调
        if (onSuccess) onSuccess(result);
        if (txLap) txLap('onSuccess 完成（事务整条结束）');

        return result;
    } catch (err) {
        // ---- 错误回滚 ----
        if (applied && beforeSnapshot) {
            // 已应用但保存失败 → 回滚到 beforeSnapshot
            applyState(AppState, beforeSnapshot);
        }
        if (historyPushed) {
            popHistory();
        }

        if (onError) onError(err);
        throw err;
    }
}

/**
 * 撤回
 * @param {Object} AppState
 * @param {Function} saveFn
 * @param {Function} refreshFn
 * @param {Function} emitFn
 * @param {string} DB_MODIFIED_EVENT
 * @returns {Promise<boolean>} 是否成功撤回
 */
export async function undo(AppState, { saveFn, refreshFn, emitFn, DB_MODIFIED_EVENT = '' } = {}) {
    // 诊断：撤回走的是"整份快照回灌"，和事务里的增量路径完全不同 ⇒ 分段与 `executeTransaction` 对齐
    //   （2026-10-19 加：bench 里 `撤回一步` 282ms，先看清钱花在哪一段）
    const t0 = diagOn() ? nowMs() : null;
    const lap = t0 ? (name) => diag('事务', `撤回·${name} = ${msSince(t0)}ms（累计）`) : null;
    const snapshot = popHistory();
    if (!snapshot) return false;
    applyState(AppState, snapshot);
    if (lap) lap('applyState');
    markModified();
    if (lap) lap('markModified');
    if (emitFn && DB_MODIFIED_EVENT) emitFn(DB_MODIFIED_EVENT);
    if (saveFn) await saveFn();
    if (lap) lap('saveFn（落盘）');
    if (refreshFn) refreshFn(null);
    if (lap) lap('refreshFn');
    return true;
}

/**
 * 初始化历史（首次加载时调用）
 */
export function initHistory(AppState) {
    const snapshot = captureState(AppState);
    resetHistory(snapshot);
}

export { getHistoryCount, applyHistoryLimit };