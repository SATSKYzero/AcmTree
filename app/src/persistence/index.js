// ================================================================
// 持久化层统一接口（persistence/index.js）
// 职责：saveData / loadData / clearAll / estimateSize
// 依赖：indexeddb.js, diff.js, core/model/state.js,
//       core/model/infoState.js, core/pluginRegistry.js
// ================================================================
import { idbGetAll, idbBatch, idbClearAll, idbEstimateSize } from './indexeddb.js';
import { computeDiff, isEmptyDiff, diffToIDBOps } from './diff.js';
// 折叠态**不进 IDB**（真源是 localStorage）——
// 落盘载荷与导出包都直接给**真引用**：折叠/页码是视图态（`state.view`），不在节点上。

import { rebuildParentOf, createInitialState } from '../core/model/state.js';
import { InfoState, restoreInfoState } from '../core/model/infoState.js';
import { runNodeMigrations, runVNodeMigrations } from '../core/pluginRegistry.js';
import { normalizeStateValues } from '../core/fieldValue.js';
import { metaDefaults, pickMetaFields, metaFieldsFrom, STORE_FIELD_KEYS, EXPORT_KEYS } from '../A_registry.js';
import { emit } from '../utils/event.js';
import { EVENTS, AUTO_SAVE_RETRY_DELAY } from '../A_constants.js';

// ---- 上次保存的状态引用快照（用于 diff） ----
let lastSavedRef = null;

// ================================================================
// 保存（**立即写**语义）
//
// ⚠️ 普通事务不直接调它，而是走下面的
//    `scheduleSave` 合并写；本函数保留为"立刻落盘"的那一个原语，供
//    显式保存/导出/强制 flush 使用。
// ================================================================
export async function saveData(state) {
    const prevSaveTime = InfoState.lastSaveTime;

    InfoState.lastSaveTime = Date.now();
    // ★ 这里**不能**提前把 `dbIsSaved` 置 true：落盘可能被合并延后（见 `scheduleSave`），
    //   写盘还没结束就显示"已保存"等于骗用户。成功之后才翻（失败则明确保持未保存）。
    const after = captureRef(state);
    const before = lastSavedRef || emptyRef();
    const changes = computeDiff(before, after);

    changes.metaFields.infoState = after.infoState;

    try {
        const ops = diffToIDBOps(changes);
        await idbBatch(ops);
        lastSavedRef = after;
        InfoState.dbIsSaved = true;          // ★ 真写进去了才算"已保存"
    } catch (err) {
        InfoState.lastSaveTime = prevSaveTime;
        InfoState.dbIsSaved = false;         // ★ 失败就是"没保存"，不回退成 true
        throw err;
    }
}

// ================================================================
// 合并写
//
// 探针 `scripts/fold-bench.mjs` 实测：每个事务都同步落盘，其中 IndexedDB 事务是
// **与数据规模无关的 ~15.6ms 常数** + `computeDiff` 全表遍历 ⇒ 折叠这种"只改看的姿势"
// 的动作也要付这份钱，20k 档折叠 102ms 里它占 15.6ms（地板）。
//
// 于是：事务提交后**只登记**（300ms 窗口内多次改动只写一次），页面要走或用户"以为已保存"
// 的动作时**强制 flush**。
//
// ⚠️ 这笔交易：**崩溃/断电最多丢最近 ~300ms 的改动**（写盘前的
//    那一段还在内存里）。因此：
//   · 有未落盘改动期间，`InfoState.dbIsSaved` 必须是 **false**（界面显示"DB未保存"）；
//   · flush 成功后才翻成 true 并派发 `DB_SAVED`（指示器立刻跟上）；
//   · 写失败**不吞**：保持未保存 + 自动重试 + console.error，让用户看得见。
// ⚠️ 与折叠缓存那套（`core/model/viewState.js` 的 scheduleViewSave）**刻意分开**：
//    IndexedDB 存的是数据，localStorage 存的是折叠态，两者失败后果与 flush 时机都不同。
// ================================================================
export const SAVE_COALESCE_MS = 300;

let _pendingState = null;        // 待写的 state（**引用**：写的时候现读最新值）
let _timer = null;
let _writing = null;             // 正在飞的写入（并发保护：同一时刻只有一次 idbBatch）
let _dirtyDuringWrite = false;   // 写入期间又脏了 ⇒ 写完后补一次
let _retryTimer = null;
let _hooksInstalled = false;

/** 还有没有"没落盘"的东西（界面/测试可用） */
export function hasPendingSave() {
    return !!_pendingState || !!_timer || !!_writing;
}

/**
 * 登记一次"之后要落盘"。**不等待写盘**（这就是提速的来源）。
 * @returns {boolean} 是否真的登记了（本次没有需要持久化的改动时为 false）
 */
export function scheduleSave(state, delay = SAVE_COALESCE_MS) {
    // 没有任何 persist 字段变过（例如只切 tab）⇒ 不必写盘
    //（`markModified(dirty)` 已经按 classifyChanges 判过，这里直接听它的结论）
    if (InfoState.dbIsSaved && !hasPendingSave()) return false;

    _pendingState = state;
    installFlushHooks();
    if (_timer) return false;                 // 窗口内已排队 ⇒ 合并
    _timer = setTimeout(() => {
        _timer = null;
        void writePending();
    }, delay);
    return true;
}

/** 立刻把待写的写掉（页面要走 / 显式保存 / 导出 / 导入前）。**不抛**：失败由本模块重试并保持未保存。 */
export async function flushPendingSave(state = null) {
    if (state) _pendingState = state;
    if (_timer) { clearTimeout(_timer); _timer = null; }
    if (_retryTimer) { clearTimeout(_retryTimer); _retryTimer = null; }
    if (!_pendingState) return false;
    await writePending();
    return true;
}

/** 丢弃待写内容（清空数据 / 重置 diff 基线时用：否则旧状态会在清空之后又被写回去） */
export function cancelPendingSave() {
    if (_timer) { clearTimeout(_timer); _timer = null; }
    if (_retryTimer) { clearTimeout(_retryTimer); _retryTimer = null; }
    _pendingState = null;
    _dirtyDuringWrite = false;
    return true;
}

async function writePending() {
    if (_writing) {                 // 已有写入在飞：等它，然后再补一次
        _dirtyDuringWrite = true;
        return _writing;
    }
    if (!_pendingState) return;
    const state = _pendingState;
    _pendingState = null;
    _writing = (async () => {
        try {
            await saveData(state);
            emit(EVENTS.DB_SAVED);          // 指示器从"未保存"翻成"已保存"
        } catch (err) {
            // 写失败：数据还在内存里，**保持未保存**，自动重试（与 autoSave 同一退避常量）
            console.error('❌ 合并写落盘失败（改动仍在内存、未保存）:', err);
            if (!_pendingState) _pendingState = state;
            if (!_retryTimer) {
                _retryTimer = setTimeout(() => {
                    _retryTimer = null;
                    void writePending();
                }, AUTO_SAVE_RETRY_DELAY);
            }
        } finally {
            _writing = null;
            if (_dirtyDuringWrite) {        // 写盘期间又改了 ⇒ 补一次（拿最新的 state）
                _dirtyDuringWrite = false;
                if (_pendingState) void writePending();
            }
        }
    })();
    return _writing;
}

/** 页面离开/切后台时兜底（幂等：只装一次） */
export function installFlushHooks() {
    if (_hooksInstalled) return;
    _hooksInstalled = true;
    try {
        if (typeof document === 'undefined' || !document.addEventListener) return;
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') void flushPendingSave();
        });
        if (typeof window !== 'undefined' && window.addEventListener) {
            window.addEventListener('pagehide', () => { void flushPendingSave(); });
            window.addEventListener('beforeunload', () => { void flushPendingSave(); });
        }
    } catch (_) { /* 桩环境：忽略 */ }
}

// ---- 落盘形状：**唯一出处**是 `A_registry.js` 的 USER_FIELDS ----
// 字段名单不手写（手抄会漏：sources/trust/accounts/fieldRegistry/reports 这类字段，
// 症状是"内存里有、刷新就没了、还看不出来"）。加顶层字段请去 A_registry 加一行。
// 导出给测试：形状派生是否还成立，由 `src/test/registryCoverage.test.js` 逐键验。

/** 当前状态的落盘形状（diff 的"后"，也是 lastSavedRef） */
export function captureRef(state) {
    const ref = { ...pickMetaFields(state), infoState: infoStateFields() };
    for (const key of STORE_FIELD_KEYS) ref[key] = state[key];
    //    `computeDiff` 是**按引用**比的 ⇒ 每次都认为 2.7 万节点**全改了**
    //    ⇒ 每次落盘把整棵树重写进 IndexedDB（真机上很贵；那圈拷贝本身也 ~100ms+）。
    //    `expanded`（折叠姿势）不进库这件事由 `diffToIDBOps` 在**真正要写的那几条**上剥
    return ref;
}

/** 空基线（首次落盘时 diff 的"前"）：每个 meta 字段取其缺省值、每张 store 表都是空的 */
export function emptyRef() {
    const ref = { ...metaDefaults(), infoState: {} };
    for (const key of STORE_FIELD_KEYS) ref[key] = {};
    return ref;
}

/** infoState 里**随盘走**的那四个字段（openTime / dbIsSaved 是会话级，刷新即重置） */
function infoStateFields() {
    return {
        lastSaveTime: InfoState.lastSaveTime,
        lastModifiedTime: InfoState.lastModifiedTime,
        jsonIsSaved: InfoState.jsonIsSaved,
        jsonLastSaveTime: InfoState.jsonLastSaveTime
    };
}

// ---- 导出包载荷：与落盘形状**同一套顶层字段口径**（`A_registry.js` 的 EXPORT_KEYS）----
// 放在这一层是因为它和落盘载荷是一对，且能脱离 DOM 单测。
export function buildExportData(state) {
    const out = {};
    for (const key of EXPORT_KEYS) out[key] = state[key];
    out.nodes = state.nodes;
    return out;
}

// ================================================================
// 加载
// ================================================================
export async function loadData() {
    const [nodesArr, coArr, pagesArr, metaArr] = await Promise.all([
        idbGetAll('nodes'),
        idbGetAll('childOrder'),
        idbGetAll('pages'),
        idbGetAll('meta')
    ]);

    if (nodesArr.length === 0) {
        restoreInfoState(null);
        lastSavedRef = null;
        return createInitialState();
    }

    const metaMap = {};
    for (const item of metaArr) metaMap[item.key] = item.value;

    // meta store 的顶层字段按注册表回填（老存档缺哪个键 → 用哪个字段的缺省值）
    const state = {
        ...metaFieldsFrom(metaMap),
        nodes: {},
        childOrder: {},
        parentOf: {},
        pages: {}
    };

    for (const n of nodesArr) state.nodes[n.id] = n;
    for (const co of coArr) state.childOrder[co.id] = co.children;
    for (const p of pagesArr) state.pages[p.id] = p;

    // ---- migration：补齐插件声明的字段 ----
    for (const nid in state.nodes) {
        runNodeMigrations(state.nodes[nid]);
    }
    // ---- 来源层归一化 + 回填 ----
    // （与文件导入共用同一个函数，见 core/fieldValue.js 的 normalizeStateValues）
    normalizeStateValues(state);
    for (const pid in state.pages) {
        const page = state.pages[pid];
        if (!page.virtualIndex) continue;
        for (const vId in page.virtualIndex) {
            runVNodeMigrations(page.virtualIndex[vId]);
        }
    }

    state.parentOf = rebuildParentOf(state.childOrder);

    restoreInfoState(metaMap.infoState);

    lastSavedRef = captureRef(state);

    return state;
}

// ================================================================
// 清空
// ================================================================
export async function clearAll() {
    cancelPendingSave();          // ★ 清空之后不许再把旧状态写回去
    await idbClearAll();
    lastSavedRef = null;
}

// ================================================================
// 估算大小
// ================================================================
export async function estimateSize() {
    return idbEstimateSize();
}

// ================================================================
// 手动重置 diff 基线（导入数据后调用）
// ================================================================
export function resetDiffBaseline(state) {
    cancelPendingSave();          // 基线一换，待写的就是"上一份世界"，别再写它
    lastSavedRef = state ? captureRef(state) : null;
}
