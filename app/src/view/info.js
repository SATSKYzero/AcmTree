// ================================================================
// 信息栏渲染（view/info.js）
// 职责：渲染信息栏、全局统计刷新
// 依赖：view/stats.js, core/model/infoState.js, transaction/history.js,
//       utils/A_helpers.js, persistence/indexeddb.js（只读真实配额）
// ================================================================
import { getTotalNodeCount } from './stats.js';
import { InfoState } from '../core/model/infoState.js';
import { getHistoryCount } from '../transaction/history.js';
import { formatTime, escapeHtml } from '../utils/A_helpers.js';
import { idbEstimateSize } from '../persistence/indexeddb.js';
import { viewNote } from './scope.js';

// ----- 内部状态（缓存和警告） -----
let lastStorageWarningShown = false;
let cachedSizeMB = null;
let sizeDirty = true;
let sizeTimer = null;

/**
 * 算体积是**背景信息**，不该卡在每次点击的同步路径上。
 *
 * 为什么贵：它要 `JSON.stringify(整个 state)` —— 真包 2.7 万节点实测 **~500ms**，
 * 而 `DB_MODIFIED`（每次改数据都会派发）就把它标脏 ⇒ **每点一下都要同步付一遍**。
 * 现在：**第一次**（还没算过）照旧同步算一次（启动时那一行不留空）；
 * 之后标脏只**排一次延迟计算**（合并到一次），期间信息栏显示上一次的数字。
 * 体积是给人看"要不要清理"的，晚一秒更新没有任何代价。
 */
const SIZE_DEFER_MS = 5000;

// ================================================================
// 存储**真实配额**（`navigator.storage.estimate()`）—— 警戒线只看它
//
// 口径（用户 2026-10-06）：**黄 = 配额已用 ≥50%，红 = ≥90%**。
// 为什么不再按"数据体积 MB"报警：**体积与"该不该备份"无关**（备份那件事由这一行里
// 「上次JSON导出」那一格管），而"能不能写进去"只看浏览器给的配额。
//
// ⚠️ 那个 45MB 常数是**旧口径**（已删）：它来自**老 Firefox 在 IndexedDB 超过 50MB 时
//    会弹窗要权限**（`dom.indexedDB.warningQuota`：桌面 50 / 移动 5MB），警戒线压在它下面；
//    现在的 Chromium（Edge 同源）改成"按磁盘给配额"，那条线既没有对应约束、
//    也不会因为数据涨就变危险 ⇒ 判据换成配额比例，只此一条。
//
// ⚠️ 显示的那个 MB 是**本应用数据的估算体积**（`computeSizeNow`：逐节点 JSON 长度求和），
//    与配额的"已用"不是一回事（后者含别的 storage，且 Chromium 129 起 IDB 值用 Snappy
//    压缩 ⇒ 磁盘口径比逻辑体积小）⇒ 两个数分开写、别相加别相减。
// ================================================================
const QUOTA_FULL_RATIO = 0.9;
const QUOTA_WARN_RATIO = 0.5;

let storageUsage = 0;      // 这个 origin 实际用了多少（含非本应用）
let storageQuota = 0;      // 浏览器给的额度（0 = 还没拿到 / 不支持）

/**
 * **按对象标识缓存**的 JSON 长度。
 *
 * 为什么能这么缓存：Immer 是**结构共享**的 —— 没改过的节点还是**同一个对象**。
 * 于是"整份 JSON.stringify"（真包 27k 节点 **~400ms**）可以拆成"每个节点量一次、之后查表"：
 * 每次都只重新量**这一轮改过的那几个**节点，其余命中缓存 ⇒ ~15ms。
 * ⚠️ 这是体积**估算**（按对象的 JSON 长度求和 + 一点分隔符开销），
 *    不是逐字节相等 —— 它只用来显示"💾 存储：x MB"和 50MB 那条警戒线，够了。
 */
const sizeLenCache = new WeakMap();

/** 一个值的 JSON 长度（按**对象标识**缓存；标量直接算） */
function cachedJsonLen(v) {
    if (v === null || typeof v !== 'object') {
        const s = JSON.stringify(v);
        return s === undefined ? 0 : s.length;
    }
    const hit = sizeLenCache.get(v);
    if (hit !== undefined) return hit;
    let n = 0;
    try { n = JSON.stringify(v).length; } catch (_) { n = 0; }
    sizeLenCache.set(v, n);
    return n;
}

/** `nodes` 字典的长度：**逐个节点**查缓存（这才是省下那 400ms 的地方） */
function cachedNodesLen(nodes) {
    let n = 0;
    for (const id of Object.keys(nodes || {})) {
        n += cachedJsonLen(nodes[id]) + id.length + 5;      // `"id":{…},` 那点开销
    }
    return n + 10;                                          // 外层 {…}
}

/** 字节 → 人话（`12.4 GB` / `512 MB` / `39.65 MB`） */
function formatMB(bytes) {
    if (!bytes || bytes <= 0) return '0 MB';
    const mb = bytes / 1024 / 1024;
    if (mb >= 1024) return (mb / 1024).toFixed(2) + ' GB';
    if (mb >= 100) return mb.toFixed(0) + ' MB';
    return mb.toFixed(2) + ' MB';
}

function computeSizeNow(state) {
    try {
        const stateForSize = {
            rootId: state.rootId,
            nodes: state.nodes,
            childOrder: state.childOrder,
            pages: state.pages,
            settings: state.settings,
            meta: state.meta,
            currentPageId: state.currentPageId
        };
        // 顶层逐个量（每个都按引用缓存）；`nodes` 走"逐节点查表"那版
        let bytes = 6 + cachedNodesLen(stateForSize.nodes);
        for (const k of ['rootId', 'childOrder', 'pages', 'settings', 'meta', 'currentPageId']) {
            const v = stateForSize[k];
            if (v === undefined) continue;
            bytes += k.length + 4 + cachedJsonLen(v);
        }
        cachedSizeMB = bytes / 1024 / 1024;
    } catch (e) {
        cachedSizeMB = null;
    }
    sizeDirty = false;
}

/** 排一次"过一会儿再算体积"（同时只排一个；算完重画那一行） */
function scheduleSizeCompute(state) {
    if (sizeTimer) return;
    sizeTimer = setTimeout(() => {
        sizeTimer = null;
        computeSizeNow(state);
        refreshStorageQuota(state);      // 异步；拿到（或变了）它自己再重画一次
        updateInfoBar(state);
    }, SIZE_DEFER_MS);
}

/**
 * 读一次**真实**占用 / 配额（异步、失败静默；只在数字变了时重画）。
 *
 * 为什么跟体积一起刷：两个数在同一行显示，分开刷会有一次"半新半旧"的中间态。
 */
async function refreshStorageQuota(state) {
    try {
        const { usage, quota } = await idbEstimateSize();
        if (!quota) return;
        if (usage === storageUsage && quota === storageQuota) return;
        storageUsage = usage;
        storageQuota = quota;
        updateInfoBar(state);
    } catch (_) { /* 拿不到就继续用旧的（或那条固定 MB 线） */ }
}

// ----- 标记缓存失效（供外部事件调用） -----
export function markSizeDirty() {
    sizeDirty = true;
}

// ----- 更新信息栏（DOM） -----
export function updateInfoBar(state) {
    const bar = document.getElementById('info-bar');
    if (!bar) return;

    const { openTime, lastSaveTime, lastModifiedTime, dbIsSaved, jsonIsSaved, jsonLastSaveTime } = InfoState;

    const openStr = formatTime(openTime);
    const saveStr = lastSaveTime ? formatTime(lastSaveTime) : '--';
    const modStr = formatTime(lastModifiedTime);
    const dbStatus = dbIsSaved ? '<span class="saved">✅ DB已保存</span>' : '<span class="unsaved">⚠️ DB未保存</span>';
    const jsonStatus = jsonIsSaved ? '<span class="saved">✅ JSON已导出</span>' : '<span class="unsaved">⚠️ JSON未导出</span>';
    const jsonTimeStr = jsonLastSaveTime ? formatTime(jsonLastSaveTime) : '--';

    let nodeCount = 0;
    const currentPageId = state.currentPageId;
    if (currentPageId !== 'main') {
        const page = state.pages[currentPageId];
        if (page) {
            nodeCount = Object.keys(page.virtualIndex).length - 1;
            if (nodeCount < 0) nodeCount = 0;
        }
    } else {
        nodeCount = getTotalNodeCount(state);
    }

    // ⚠️ **启动第一屏也不同步算体积**（2026-10-18 实测：真包 `computeSizeNow` 在主树那一趟贡献
    //   探针机 157ms、浏览器 ~300ms，全花在"把 nodes 逐节点量一遍"上）。
    //   两串数字里它是**最不影响判断**的那一个 ⇒ 先显示 `…`，一拍之后再算准（与统计栏同一姿态）。
    let sizeStr = cachedSizeMB === null ? '…' : '0.00 MB';
    let warningHtml = '';
    if (sizeDirty) scheduleSizeCompute(state);
    if (cachedSizeMB !== null) {
        sizeStr = cachedSizeMB.toFixed(2) + ' MB';
        // 真实配额拿得到就一并写出来（"这条线到底是多少"从此不用问人）
        const byQuota = storageQuota > 0;
        const usedRatio = byQuota ? storageUsage / storageQuota : 0;
        sizeStr += byQuota ? `（配额 ${formatMB(storageQuota)}）` : '（配额未知）';
        // ---- 警戒线**只看真实配额**（口径：黄 ≥50%、红 ≥90%）----
        // 不按"数据体积 MB"报警：体积与"该不该备份"无关（那件事由这一行的「上次JSON导出」管），
        // 而"能不能写进去"只看浏览器给的额度。拿不到配额（老浏览器/隐私模式）⇒ 不报警。
        const nearFull = byQuota && usedRatio >= QUOTA_FULL_RATIO;
        const nearLimit = byQuota && usedRatio >= QUOTA_WARN_RATIO;
        const limitText = `浏览器配额 ${formatMB(storageQuota)} 已用 ${(usedRatio * 100).toFixed(1)}%`
            + `（已用 ${formatMB(storageUsage)}）`;
        if (nearFull) {
            warningHtml = ` <span class="storage-warning" style="color:#dc2626;font-weight:700;cursor:help;" title="存储空间已达 ${limitText}，请立即导出备份或清理数据">⚠️ 存储已满</span>`;
            if (!lastStorageWarningShown) {
                lastStorageWarningShown = true;
                const event = new CustomEvent('show-toast', {
                    detail: { message: `⚠️ 存储空间已达 ${limitText}，请立即导出备份或清理数据`, type: 'error' }
                });
                document.dispatchEvent(event);
            }
        } else if (nearLimit) {
            warningHtml = ` <span class="storage-warning" style="color:#f59e0b;font-weight:700;cursor:help;" title="存储空间已达 ${limitText}（接近上限），请及时导出备份或清理数据">⚠️ 存储接近上限</span>`;
            if (!lastStorageWarningShown) {
                lastStorageWarningShown = true;
                const event = new CustomEvent('show-toast', {
                    detail: { message: `⚠️ 存储空间已达 ${limitText}（接近上限），建议导出备份`, type: 'warning' }
                });
                document.dispatchEvent(event);
            }
        } else {
            lastStorageWarningShown = false;
        }
    } else {
        sizeStr = '计算失败';
    }

    const hisCount = getHistoryCount();

    // 口径提示 —— 现在在看谁、派生结论按谁算（不这样写清，会以为
    // "过题状态/完成状态"也跟着查看范围变了）
    const note = viewNote(state);
    const noteHtml = note ? `<span class="stat-value" style="cursor:help;">${escapeHtml(note)}</span>` : '';

    bar.innerHTML = `
        <span><span class="label">打开时间：</span><span class="value">${openStr}</span></span>
        <span><span class="label">上次保存：</span><span class="value">${saveStr}</span></span>
        <span><span class="label">上次修改：</span><span class="value">${modStr}</span></span>
        <span>${dbStatus}</span>
        <span>${jsonStatus} <span class="label">上次JSON导出：</span><span class="value">${jsonTimeStr}</span></span>
        <span><span class="label">📊 节点数：</span><span class="value">${nodeCount}</span></span>
        <span><span class="label">💾 存储：</span><span class="value">${sizeStr}</span>${warningHtml}</span>
        ${hisCount > 0 ? `<span>🔙 可撤回: ${hisCount}</span>` : ''}
        ${noteHtml}
    `;
}