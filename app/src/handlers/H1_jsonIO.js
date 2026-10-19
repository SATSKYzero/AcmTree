// ================================================================
// JSON 完整导出/导入（handlers/H1_jsonIO.js）
// 职责：完整数据（含副页）的导出与导入
// 依赖：shell/state.js, shell/executor.js, core/model/infoState.js,
//       persistence/index.js, A_constants.js, utils/A_helpers.js
// ================================================================
import { AppState } from '../shell/state.js';
import { importState } from '../shell/executor.js';
import { InfoState, markJsonSaved } from '../core/model/infoState.js';
import { saveData, flushPendingSave, buildExportData } from '../persistence/index.js';
// ⚠️ 读/写本机那份 `me.json` 的客户端**只有一份**：`ui/MeEditor/meApi.js`（本文件复用它，
//    别在这儿再写一遍 fetch —— 路径白名单、`no-store`、409 语义都在那边）。
import { fetchMe, saveMe } from '../ui/MeEditor/meApi.js';
import { EVENTS } from '../A_constants.js';
import { emit } from '../utils/A_helpers.js';

// ---- Toast 事件 ----
function showToast(msg, type = 'info') {
    document.dispatchEvent(new CustomEvent('show-toast', { detail: { message: msg, type } }));
}

// ---- 时间戳 ----
function makeTimestamp(includeSeconds = false) {
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const base = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
    return includeSeconds ? `${base}${pad(now.getSeconds())}` : base;
}

// ---- 触发浏览器下载 ----
function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.download = filename;
    a.href = url;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// ---- 构造导出对象：见 `persistence/index.js` 的 buildExportData ----
// （名单只有一处：`A_registry.js` 的 EXPORT_KEYS；本文件只管下载/提示/落盘）

// ================================================================
// 导出包里的「本机个人信息」那一节（`me.json`）
//
// 用户 2026-10-17："me.json 应该进（主脚本）导出包 —— 它对应完整数据导出，**不上 GitHub**"
// ⇒ 这份包里**连凭据一起带上**（换了机器、或想留底时，导入一次就全回来；抓取脚本照旧能跑）。
//   · 它**不在** `A_registry.js:EXPORT_KEYS` 里：那份名单管的是**应用状态**（IndexedDB），
//     而 `me.json` 是磁盘上由主脚本管的本机配置 ⇒ 只能由本文件现读（`/api/me` 直给真值，不打码）。
//   · 接口没开（`--no-build-api` / 直接从 `file://` 打开）就**不带这一节** ——
//     导出**照样成功**（宁可少带，也不许导不出来）；这一点会写在 toast 里，不静默。
// ================================================================
const ME_KEY = 'me';

/** 把本机 `me.json` 那一份挂到导出对象上；带上了返回 true（读不到就 false，不抛） */
async function attachMe(exportData) {
    try {
        const res = await fetchMe();
        if (res && res.doc && Object.keys(res.doc).length) {
            exportData[ME_KEY] = res.doc;
            return true;
        }
    } catch (err) {
        // 不是错误路径：本机接口本来就可以关。留一句给控制台，排查"包里怎么没有 me"时够用。
        // ⚠️ 用 `warn`（不是 `info`）：`info` 现在专指"诊断计时行"、一律走 `utils/diag.js`
        //    （`src/test/perfGuards.test.js` 会拦裸 `console.info`）；这一句是**真该一直看得见**的。
        console.warn('导出没带本机个人信息（读不到主脚本的 /api/me）：', err && err.message);
    }
    return false;
}

// ================================================================
// 完整数据导出（含副页）
// ================================================================
export async function exportFullJSON(state, silent = false) {
    // ⚠️ **树为空也允许导出**：导出里除了树，还有**设置 / 来源注册表 /
    //    账户 / 信任表**这些用户数据 —— 树空不代表没东西可导（比如刚从别处拿到一份
    //    配置、想先导出一份留底）。空树导出的就是一份"没有节点"的合法 JSON。
    const exportData = buildExportData(state);
    const withMe = await attachMe(exportData);            // 本机 me.json（见上面那一段的说明）
    const json = JSON.stringify(exportData, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    downloadBlob(blob, `AcmTree_Full_${makeTimestamp(true)}.json`);

    // 标记 JSON 已导出
    markJsonSaved();

    // 写盘（把 jsonIsSaved / jsonLastSaveTime 持久化）
    // ⚠️ 先把合并写里**还没落盘的**数据写掉（用户以为"已经保存了"的动作，不许留尾巴），
    //    再写这一次（带上刚标记的 JSON 已导出）。
    await flushPendingSave(state);
    await saveData(state);
    emit(EVENTS.DB_SAVED);
    emit(EVENTS.JSON_SAVED);

    if (!silent) {
        showToast(withMe ? '完整数据导出成功（含本机个人信息 me.json）'
                         : '完整数据导出成功（未含本机个人信息：主脚本接口没开）',
                  withMe ? 'success' : 'info');
    }
}

// ================================================================
// 完整数据压缩导出（含副页）
// ================================================================
export async function exportFullCompressedJSON(state, silent = false) {
    // 同 `exportFullJSON`：**树为空也允许导出**。
    if (typeof CompressionStream === 'undefined') {
        if (!silent) showToast('当前浏览器不支持压缩导出，请使用普通导出', 'error');
        return;
    }

    const exportData = buildExportData(state);
    const withMe = await attachMe(exportData);            // 压缩导出也带（口径同普通导出）
    const json = JSON.stringify(exportData);
    const encoder = new TextEncoder();
    const data = encoder.encode(json);

    try {
        const cs = new CompressionStream('gzip');
        const writer = cs.writable.getWriter();
        writer.write(data);
        writer.close();
        const reader = cs.readable.getReader();
        const chunks = [];
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            chunks.push(value);
        }
        const totalLength = chunks.reduce((a, b) => a + b.length, 0);
        const merged = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of chunks) {
            merged.set(chunk, offset);
            offset += chunk.length;
        }
        const blob = new Blob([merged], { type: 'application/gzip' });
        downloadBlob(blob, `AcmTree_Full_${makeTimestamp(true)}.json.gz`);

        // 标记 JSON 已导出
        markJsonSaved();

        // 先落掉合并写里挂着的改动（同普通导出），再写这一次（带 JSON 已导出标记）
        await flushPendingSave(state);
        await saveData(state);
        emit(EVENTS.DB_SAVED);
        emit(EVENTS.JSON_SAVED);

        if (!silent) {
            showToast(withMe ? '完整压缩数据导出成功（含本机个人信息 me.json）'
                             : '完整压缩数据导出成功（未含本机个人信息：主脚本接口没开）',
                      withMe ? 'success' : 'info');
        }
    } catch (e) {
        console.error('压缩数据导出失败:', e);
        if (!silent) showToast('压缩数据导出失败: ' + e.message, 'error');
    }
}

// ================================================================
// 完整数据导入（含副页，替换全部 + 重置历史）
// ================================================================
export function importFullJSON(file) {
    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            let content = e.target.result;
            let data;

            // ---- 1. 读取 + 解压 ----
            if (file.name.endsWith('.gz') || file.name.endsWith('.json.gz')) {
                if (typeof DecompressionStream === 'undefined') {
                    throw new Error('当前浏览器不支持解压，请使用普通 JSON 文件');
                }
                const blob = new Blob([content], { type: 'application/gzip' });
                const ds = new DecompressionStream('gzip');
                const stream = blob.stream().pipeThrough(ds);
                const reader2 = stream.getReader();
                const chunks = [];
                while (true) {
                    const { value, done } = await reader2.read();
                    if (done) break;
                    chunks.push(value);
                }
                const totalLength = chunks.reduce((a, b) => a + b.length, 0);
                const merged = new Uint8Array(totalLength);
                let offset = 0;
                for (const chunk of chunks) {
                    merged.set(chunk, offset);
                    offset += chunk.length;
                }
                const decoder = new TextDecoder();
                const jsonText = decoder.decode(merged);
                data = JSON.parse(jsonText);
            } else {
                data = JSON.parse(content);
            }

            // ---- 2. 校验（格式必需字段） ----
            if (!data || typeof data !== 'object') {
                throw new Error('无效的数据文件：不是对象');
            }
            if (typeof data.rootId !== 'string' || !data.rootId) {
                throw new Error('无效的数据文件：缺少 rootId');
            }
            if (!data.nodes || typeof data.nodes !== 'object') {
                throw new Error('无效的数据文件：缺少 nodes');
            }
            if (!data.childOrder || typeof data.childOrder !== 'object') {
                throw new Error('无效的数据文件：缺少 childOrder');
            }
            if (!data.nodes[data.rootId]) {
                throw new Error('无效的数据文件：rootId 指向的节点不存在');
            }
            if (!Array.isArray(data.childOrder[data.rootId])) {
                throw new Error('无效的数据文件：rootId 的 childOrder 不是数组');
            }
            if (!data.pages || typeof data.pages !== 'object') {
                data.pages = {};
            }
            if (!data.settings || typeof data.settings !== 'object') {
                throw new Error('无效的数据文件：缺少 settings');
            }
            if (!data.meta || typeof data.meta !== 'object') {
                throw new Error('无效的数据文件：缺少 meta');
            }
            if (typeof data.meta.idCounter !== 'number') {
                throw new Error('无效的数据文件：meta.idCounter 不是数字');
            }
            if (!data.currentPageId) {
                data.currentPageId = 'main';
            }

            // ---- 3. 校验 childOrder 与 nodes 一致性 ----
            for (const pid in data.childOrder) {
                if (!data.nodes[pid]) {
                    throw new Error(`childOrder 里的父节点 "${pid}" 在 nodes 中不存在`);
                }
                const childIds = data.childOrder[pid];
                if (!Array.isArray(childIds)) {
                    throw new Error(`childOrder["${pid}"] 不是数组`);
                }
                for (const cid of childIds) {
                    if (!data.nodes[cid]) {
                        throw new Error(`节点 "${pid}" 的子节点 "${cid}" 在 nodes 中不存在`);
                    }
                }
            }
            for (const nid in data.nodes) {
                if (!data.childOrder[nid]) {
                    throw new Error(`节点 "${nid}" 在 childOrder 中缺少条目`);
                }
            }

            // ---- 4. 整体导入（替换全部 + 重置历史） ----
            // 整个 `data` 交给 `importState`：该收哪些顶层字段只有一处口径（那边逐字段取，
            // 缺的沿用手上的值）。这里**手抄子集**会漏掉 fieldRegistry/reports ——
            // 结果是"文件里明明带着，导进来却没有"（而且安静得很）。
            await importState(data);

            // ---- 5. 本机个人信息（`me.json`）：文件里带就写回磁盘 ----
            // ⚠️ **刻意不 `await`**：`importFullJSON()` 有"同步返回 `undefined`"的既有契约
            //    （`scripts/smoke/accounts.smoke.mjs` 就按它同步等），而这一笔与树数据完全独立
            //    ⇒ 发出去就算，成败各打一句人话，不让它拖住导入。
            // ⚠️ **不带 sha256** ⇒ 服务器跳过"磁盘上这份被人改过"那道闸：导入是**恢复**语义，
            //    以文件为准（这是恢复，不是"所见即所得"的编辑保存）。
            if (data[ME_KEY] && typeof data[ME_KEY] === 'object') {
                saveMe(undefined, undefined, { text: JSON.stringify(data[ME_KEY], null, 2) })
                    .then(() => showToast('本机个人信息（me.json）也写回了', 'success'))
                    .catch(err => showToast('树导进来了，但本机个人信息没写回：'
                                            + (err && err.message) + '（用设置页手动填一次也行）', 'info'));
            }

            showToast('完整数据导入成功（历史已重置）', 'success');
        } catch (err) {
            console.error('导入完整数据异常:', err);
            showToast('导入失败: ' + err.message, 'error');
        }
    };

    if (file.name.endsWith('.gz') || file.name.endsWith('.json.gz')) {
        reader.readAsArrayBuffer(file);
    } else {
        reader.readAsText(file);
    }
}