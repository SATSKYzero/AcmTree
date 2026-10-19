// ================================================================
// 批量导入（handlers/H2_batchImport.js）
// 职责：批量导入题目、提交记录、比赛、题目信息
// 依赖：shell/state.js, shell/executor.js, core/ops/batch.js,
//       core/ops/tree.js, core/autoCompute.js,
//       core/validate/conflict.js, utils/A_helpers.js,
//       A_constants.js
// ================================================================
import { AppState } from '../shell/state.js';
import { execute } from '../shell/executor.js';
import { batchAddPNodes } from '../core/ops/batch.js';
import { addChild } from '../core/ops/tree.js';
import { recordManualValue } from '../core/ops/node.js';
import { setDerivedOverride } from '../core/fieldValue.js';
import { setExpanded } from '../core/model/viewState.js';
import { STATUS2_ALIASES } from '../core/model/status.js';
import { assertManualEditAllowed, isViewOnly } from '../core/ops/account.js';
import { fullAutoUpdate } from '../core/autoCompute.js';
import { collectBatchConflicts } from '../core/validate/conflict.js';
import {
    genTagId, getNowStr, getXcpcDifficulty, normalizeTime
} from '../utils/A_helpers.js';
import { EVENTS, MAPPING_KEYS, DEFAULT_TAG_COLOR, STATUS2_VALUES } from '../A_constants.js';

// ---- Toast 事件 ----
function showToast(msg, type = 'info') {
    document.dispatchEvent(new CustomEvent('show-toast', { detail: { message: msg, type } }));
}

// ---- 读取已保存的映射 ----
function getStoredMapping(key) {
    return AppState.settings.mappings[key] || {};
}

// ---- 保存映射（走事务） ----
//
// ⚠️ 只读模式下**一个字节都不留**：批量导入本身是手改，会被后面的守卫拒掉，
//    但映射的保存发生在守卫**之前** —— 于是用户看到"导入被拒"，下次再打开却发现
//    映射被静默沿用了（"我明明没成功导入过"）。映射描述的是"怎么读这个文件"，
//    属于用户数据，不该在只读时被写下。
async function saveMapping(key, mapping) {
    if (isViewOnly(AppState)) return;
    await execute(
        (draft) => { draft.settings.mappings[key] = mapping; },
        { skipHistory: true }
    );
}

// ---- 冲突确认 Promise 包装（UI 层响应） ----
function confirmAnomalies(anomalies) {
    return new Promise((resolve) => {
        if (!anomalies || anomalies.length === 0) {
            resolve(true);
            return;
        }
        document.dispatchEvent(new CustomEvent(EVENTS.SHOW_ANOMALIES_DIALOG, {
            detail: { anomalies, resolve }
        }));
    });
}

// ---- 对单个 P 节点应用属性值 ----
//
// **直接赋值**（`node.problemId = value`）有三个毛病：
//   ① 值不进来源层（面板只能显示"未记录"）② 没有账户归属 ③ 只读模式拦不住。
// 所以它走与编辑弹窗**同一套规则**：只读时先抛，写值后由 `recordManualValue`
// 决定要不要留痕（判据：我敲过它 ∧ 它确实变了 —— 批量流程没有"敲过"信号，
// 退回"变了就记"）。
function applyPropertyToNode(draft, node, propKey, value) {
    const before = node[propKey];
    switch (propKey) {
        case 'problemId': node.problemId = value; break;
        case 'name': node.name = value; break;
        case 'ratio': {
            const ratioStr = String(value).trim();
            if (ratioStr === '' || ratioStr === '-') {
                node.ratio = '';
                node.xcpcDifficulty = '-';
                break;
            }
            let percent = null;
            if (ratioStr.includes('/')) {
                const parts = ratioStr.split('/');
                if (parts.length === 2) {
                    const pass = parseFloat(parts[0]);
                    const total = parseFloat(parts[1]);
                    if (!isNaN(pass) && !isNaN(total) && total > 0) {
                        percent = (pass / total) * 100;
                    }
                }
            } else {
                const num = parseFloat(ratioStr.replace('%', ''));
                if (!isNaN(num)) percent = num;
            }
            if (percent === null) {
                // 批量场景：无效输入时保留原值
                node.ratio = String(value);
                node.xcpcDifficulty = '-';
            } else {
                node.ratio = String(percent);
                node.xcpcDifficulty = getXcpcDifficulty(percent);
            }
            break;
        }
        case 'status2': {
            const num = parseInt(value);
            // 上限**派生**（加档时这里跟着长；别写死 5）
            if (!isNaN(num) && num >= 0 && num <= STATUS2_MAX) {
                node.status2 = num;
                // `status2` 是**派生**元素（`recordManualValue` 会跳过它），所以走覆盖入口：
                // 这个值算不算"用户按下的覆盖"由**属性表**判断，这里不写死名单。
                setDerivedOverride(node, 'status2', num,
                    { at: getNowStr(), account: draft.currentAccountId });
            }
            break;
        }
        case 'cfDifficulty': {
            const num = parseInt(value);
            if (!isNaN(num)) node.cfDifficulty = num;
            break;
        }
        case 'link': node.link = value; break;
    }
    // 值写完了 → 交给统一规则决定要不要留一条手改来源值（派生元素自动排除）
    recordManualValue(draft, node, propKey, before, node[propKey], {});
}
// ================================================================
// 批量导入题目（C 节点）
// ================================================================
export function batchImport(parentId) {
    const parent = AppState.nodes[parentId];
    if (!parent || parent.type !== 'C') {
        showToast('只有比赛节点可以批量导入', 'error');
        return;
    }
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json,.gz,.json.gz';
    input.onchange = function (e) {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async function (ev) {
            try {
                // ---- 1. 文件读取和解析 ----
                const data = JSON.parse(ev.target.result);
                if (!Array.isArray(data)) throw new Error('根必须为数组');
                if (data.length === 0) { showToast('文件为空', 'error'); return; }

                const allKeys = new Set();
                for (const item of data) {
                    for (const key of Object.keys(item)) allKeys.add(key);
                }
                if (allKeys.size > 20) {
                    showToast('属性超过20种，请精简文件', 'error');
                    return;
                }

                // ---- 2. 映射配置 ----
                const storedMapping = getStoredMapping(MAPPING_KEYS.BATCH_IMPORT);
                const fileKeys = Array.from(allKeys);
                const systemFields = ['problemId', 'name', 'ratio', 'status2', 'link', 'cfDifficulty', 'tags', 'acTime', 'status1', 'contestTime'];

                document.dispatchEvent(new CustomEvent(EVENTS.SHOW_MAPPING_DIALOG, {
                    detail: {
                        title: '字段映射配置（批量导入题目）',
                        fileKeys,
                        systemFields,
                        storedMapping,
                        onConfirm: async (mapping) => {
                            await saveMapping(MAPPING_KEYS.BATCH_IMPORT, mapping);

                            const problemIdKey = Object.keys(mapping).find(k => mapping[k] === 'problemId');
                            if (!problemIdKey) {
                                showToast('必须将某个字段映射到 "problemId"', 'error');
                                return;
                            }

                            // ---- 3. 构建 pNodesData ----
                            const pNodesData = [];
                            let hasValidData = false;

                            for (const item of data) {
                                const pData = {
                                    name: '',
                                    problemId: '',
                                    ratio: '',
                                    status2: 0,
                                    link: '',
                                    cfDifficulty: 0,
                                    tags: [],
                                    contestTime: ''
                                };

                                for (const [fileKey, sysKey] of Object.entries(mapping)) {
                                    const val = item[fileKey];
                                    if (val === undefined || val === null) continue;
                                    switch (sysKey) {
                                        case 'problemId': pData.problemId = String(val).trim(); break;
                                        case 'name': pData.name = String(val).trim(); break;
                                        case 'ratio': {
                                            const ratioStr = String(val).trim();
                                            if (ratioStr.includes('/')) {
                                                const parts = ratioStr.split('/');
                                                if (parts.length === 2) {
                                                    const pass = parseFloat(parts[0]);
                                                    const total = parseFloat(parts[1]);
                                                    if (!isNaN(pass) && !isNaN(total) && total > 0) {
                                                        pData.ratio = String((pass / total) * 100);
                                                    }
                                                }
                                            } else if (ratioStr.includes('%')) {
                                                const num = parseFloat(ratioStr.replace('%', ''));
                                                if (!isNaN(num)) pData.ratio = String(num);
                                            } else {
                                                const num = parseFloat(ratioStr);
                                                if (!isNaN(num)) pData.ratio = String(num);
                                            }
                                            break;
                                        }
                                        case 'status2': {
                                            // ⚠️ 用**应用自己的**状态词表（`core/model/status.js`），
                                            // 别再手写 `{'通过': 4, …}` —— 那样"通过"会被当成
                                            // **4 赛时通过**，而应用在没证据时判的是 3 赛后补题，
                                            // 同一个词两个结论。
                                            const statusText = String(val).trim();
                                            if (STATUS2_ALIASES[statusText] !== undefined) {
                                                pData.status2 = STATUS2_ALIASES[statusText];
                                            } else {
                                                const num = parseInt(statusText);
                                                if (!isNaN(num) && num >= 0 && num <= STATUS2_MAX) {
                                                    pData.status2 = num;
                                                }
                                            }
                                            break;
                                        }
                                        case 'link': pData.link = String(val); break;
                                        case 'cfDifficulty': {
                                            const diff = parseInt(val);
                                            if (!isNaN(diff)) pData.cfDifficulty = diff;
                                            break;
                                        }
                                        case 'tags': {
                                            if (Array.isArray(val)) {
                                                pData.tags = val.map(t => ({ id: genTagId(), text: String(t), color: DEFAULT_TAG_COLOR }));
                                            } else {
                                                pData.tags = [{ id: genTagId(), text: String(val), color: DEFAULT_TAG_COLOR }];
                                            }
                                            break;
                                        }
                                        case 'contestTime': pData.contestTime = String(val).trim(); break;
                                    }
                                }

                                if (pData.name) {
                                    hasValidData = true;
                                    pNodesData.push(pData);
                                }
                            }

                            if (!hasValidData || pNodesData.length === 0) {
                                showToast('没有有效的题目数据', 'error');
                                return;
                            }

                            // ---- 4. 冲突检测（纯读） ----
                            const anomalies = collectBatchConflicts(AppState, parentId, pNodesData);

                            // ---- 5. 处理冲突 ----
                            if (anomalies.length > 0) {
                                const enhanced = anomalies.map(msg => msg + '，导入时系统将自动重命名（名称追加数字后缀，题号使用 A-Z 或 X1, X2...）');
                                const confirmed = await confirmAnomalies(enhanced);
                                if (!confirmed) return;
                            }

                            // ---- 6. 执行导入 ----
                            await execute(
                                (draft) => {
                                    const result = batchAddPNodes(draft, parentId, pNodesData, {
                                        autoGenerateProblemId: true
                                    });
                                    fullAutoUpdate(draft);
                                    return { importedCount: result.count };
                                },
                                {
                                    refreshParentId: parentId,
                                    onSuccess: (result) => {
                                        showToast(`成功导入 ${result.importedCount} 道题目`, 'success');
                                    },
                                    onError: (err) => {
                                        showToast('导入失败: ' + err.message, 'error');
                                    }
                                }
                            );
                        }
                    }
                }));
            } catch (err) {
                showToast('导入失败: ' + err.message, 'error');
            }
        };
        reader.readAsText(file);
        input.value = '';
    };
    input.click();
}

// ================================================================
// 批量导入提交记录（C 节点）
// ================================================================
export function batchImportSubmissions(parentId) {
    const parentC = AppState.nodes[parentId];
    if (!parentC || parentC.type !== 'C') {
        showToast('只有比赛节点可以批量导入提交记录', 'error');
        return;
    }
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json,.gz,.json.gz';
    input.onchange = function (e) {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async function (ev) {
            try {
                const data = JSON.parse(ev.target.result);
                if (!Array.isArray(data)) throw new Error('根必须为数组');
                if (data.length === 0) { showToast('文件为空', 'error'); return; }

                const allKeys = new Set();
                for (const item of data) {
                    for (const key of Object.keys(item)) allKeys.add(key);
                }
                if (allKeys.size > 20) {
                    showToast('属性超过20种，请精简文件', 'error');
                    return;
                }

                const storedMapping = getStoredMapping(MAPPING_KEYS.SUBMIT);
                const fileKeys = Array.from(allKeys);
                const systemFields = ['problemId', 'time', 'status', 'link'];

                document.dispatchEvent(new CustomEvent(EVENTS.SHOW_MAPPING_DIALOG, {
                    detail: {
                        title: '提交记录字段映射',
                        fileKeys,
                        systemFields,
                        storedMapping,
                        onConfirm: async (mapping) => {
                            await saveMapping(MAPPING_KEYS.SUBMIT, mapping);

                            const problemIdKey = Object.keys(mapping).find(k => mapping[k] === 'problemId');
                            if (!problemIdKey) {
                                showToast('必须将某个字段映射到 "problemId"', 'error');
                                return;
                            }

                            // ---- 文件内校验：题号必须存在于当前 C 节点 ----
                            const pMap = {};
                            for (const childId of AppState.childOrder[parentId]) {
                                const child = AppState.nodes[childId];
                                if (child && child.type === 'P') {
                                    pMap[child.problemId] = child;
                                }
                            }
                            let allValid = true;
                            const invalidProblemIds = [];
                            for (const item of data) {
                                const raw = item[problemIdKey];
                                if (raw === undefined || raw === null || raw === '') {
                                    allValid = false;
                                    invalidProblemIds.push('(空值)');
                                    break;
                                }
                                const pid = String(raw).trim();
                                if (!pMap[pid]) {
                                    allValid = false;
                                    invalidProblemIds.push(pid);
                                }
                            }
                            if (!allValid) {
                                showToast(`存在无效题号: ${invalidProblemIds.slice(0,5).join(', ')}${invalidProblemIds.length>5?'...':''}，导入取消`, 'error');
                                return;
                            }

                            // ---- 执行导入 ----
                            await execute(
                                (draft) => {
                                    // 从 draft 重建 pMap（避免使用外部快照）
                                    const pMapInDraft = {};
                                    for (const cid of draft.childOrder[parentId]) {
                                        const child = draft.nodes[cid];
                                        if (child && child.type === 'P') {
                                            pMapInDraft[child.problemId] = child;
                                        }
                                    }

                                    const timeKey = Object.keys(mapping).find(k => mapping[k] === 'time');
                                    const statusKey = Object.keys(mapping).find(k => mapping[k] === 'status');
                                    const linkKey = Object.keys(mapping).find(k => mapping[k] === 'link');

                                    let imported = 0;
                                    for (const item of data) {
                                        const pid = String(item[problemIdKey]).trim();
                                        const pNode = pMapInDraft[pid];
                                        if (!pNode) continue;

                                        const extra = {};
                                        if (timeKey) {
                                            const timeResult = normalizeTime(item[timeKey]);
                                            if (!timeResult.valid) {
                                                throw new Error(`提交时间格式无效: "${item[timeKey]}" (题号: ${pid})`);
                                            }
                                            extra.time = timeResult.isEmpty ? '' : timeResult.value;
                                        } else {
                                            extra.time = getNowStr();
                                        }
                                        extra.status = statusKey ? (item[statusKey] || '-') : '-';
                                        extra.link = linkKey ? (item[linkKey] || '') : '';

                                        addChild(draft, pNode.id, 'R', '', extra, true);
                                        imported++;
                                    }

                                    // 折叠所有 P 节点（视图态：稀疏表里删键）
                                    for (const cid of draft.childOrder[parentId]) {
                                        const child = draft.nodes[cid];
                                        if (child && child.type === 'P') {
                                            setExpanded(draft, cid, false);
                                        }
                                    }

                                    fullAutoUpdate(draft);
                                    return { imported };
                                },
                                {
                                    refreshParentId: parentId,
                                    onSuccess: (result) => {
                                        showToast(`成功导入 ${result.imported} 条提交记录`, 'success');
                                    },
                                    onError: (err) => {
                                        showToast('导入失败: ' + err.message, 'error');
                                    }
                                }
                            );
                        }
                    }
                }));
            } catch (err) {
                showToast('导入失败: ' + err.message, 'error');
            }
        };
        reader.readAsText(file);
        input.value = '';
    };
    input.click();
}

// ================================================================
// 批量导入比赛（S 节点）
// ================================================================
export function batchImportContests(parentId) {
    const parent = AppState.nodes[parentId];
    if (!parent || parent.type !== 'S') {
        showToast('只有系列节点可以批量导入比赛', 'error');
        return;
    }
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json,.gz,.json.gz';
    input.onchange = function (e) {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async function (ev) {
            try {
                const data = JSON.parse(ev.target.result);
                if (!Array.isArray(data)) throw new Error('根必须为数组');
                if (data.length === 0) { showToast('文件为空', 'error'); return; }

                const allKeys = new Set();
                for (const item of data) {
                    for (const key of Object.keys(item)) allKeys.add(key);
                }
                if (allKeys.size > 20) {
                    showToast('属性超过20种，请精简文件', 'error');
                    return;
                }

                const storedMapping = getStoredMapping(MAPPING_KEYS.CONTEST);
                const fileKeys = Array.from(allKeys);
                const systemFields = ['name', 'link', 'contestTime'];

                document.dispatchEvent(new CustomEvent(EVENTS.SHOW_MAPPING_DIALOG, {
                    detail: {
                        title: '字段映射配置（批量导入比赛）',
                        fileKeys,
                        systemFields,
                        storedMapping,
                        onConfirm: async (mapping) => {
                            await saveMapping(MAPPING_KEYS.CONTEST, mapping);

                            // ---- 名称冲突检测 ----
                            const nameAnomalies = [];
                            const existingNames = new Set();
                            for (const childId of AppState.childOrder[parentId]) {
                                const child = AppState.nodes[childId];
                                if (child && child.type === 'C' && child.name) {
                                    existingNames.add(child.name);
                                }
                            }
                            const nameKey = Object.keys(mapping).find(k => mapping[k] === 'name');
                            const fileNames = data
                                .map(item => nameKey ? String(item[nameKey] || '').trim() : '')
                                .filter(n => n !== '');
                            const seenNames = new Set();
                            for (const n of fileNames) {
                                if (seenNames.has(n)) {
                                    nameAnomalies.push(`文件内名称重复: "${n}"`);
                                } else {
                                    seenNames.add(n);
                                }
                                if (existingNames.has(n)) {
                                    nameAnomalies.push(`名称 "${n}" 与已有比赛重复`);
                                }
                            }
                            if (nameAnomalies.length > 0) {
                                const enhanced = nameAnomalies.map(msg => msg + '，导入时系统将自动重命名（追加数字后缀）');
                                const confirmed = await confirmAnomalies(enhanced);
                                if (!confirmed) return;
                            }

                            // ---- 执行导入 ----
                            await execute(
                                (draft) => {
                                    let importedCount = 0;
                                    for (const item of data) {
                                        const contestData = { name: '', link: '', contestTime: '' };
                                        for (const [fileKey, sysKey] of Object.entries(mapping)) {
                                            const val = item[fileKey];
                                            if (val === undefined || val === null) continue;
                                            switch (sysKey) {
                                                case 'name': contestData.name = String(val).trim(); break;
                                                case 'link': contestData.link = String(val); break;
                                                case 'contestTime': {
                                                    const raw = String(val).trim();
                                                    const timeResult = normalizeTime(raw);
                                                    if (!timeResult.valid) {
                                                        throw new Error(timeResult.reason || `比赛时间格式无效: "${raw}"，请使用 12位(YYYYMMDDHHMM) 或 14位(YYYYMMDDHHMMSS) 数字`);
                                                    }
                                                    contestData.contestTime = timeResult.isEmpty ? '' : timeResult.value;
                                                    break;
                                                }
                                            }
                                        }
                                        if (!contestData.name) {
                                            continue;
                                        }
                                        const extra = {
                                            link: contestData.link,
                                            contestTime: contestData.contestTime
                                        };
                                        addChild(draft, parentId, 'C', contestData.name, extra, true);
                                        importedCount++;
                                    }
                                    fullAutoUpdate(draft);
                                    return { importedCount };
                                },
                                {
                                    refreshParentId: parentId,
                                    onSuccess: (result) => {
                                        showToast(`成功导入 ${result.importedCount} 场比赛`, 'success');
                                    },
                                    onError: (err) => {
                                        showToast('导入失败: ' + err.message, 'error');
                                    }
                                }
                            );
                        }
                    }
                }));
            } catch (err) {
                showToast('导入失败: ' + err.message, 'error');
            }
        };
        reader.readAsText(file);
        input.value = '';
    };
    input.click();
}

// ================================================================
// 题目信息批量导入（C 节点）
// ================================================================
export function batchImportProblemInfo(parentId) {
    const parent = AppState.nodes[parentId];
    if (!parent || parent.type !== 'C') {
        showToast('只有比赛节点可以批量导入题目信息', 'error');
        return;
    }

    const pNodes = [];
    for (const cid of AppState.childOrder[parentId]) {
        const c = AppState.nodes[cid];
        if (c && c.type === 'P') pNodes.push(c);
    }
    if (pNodes.length === 0) {
        showToast('该比赛下没有题目', 'error');
        return;
    }

    const editableProps = [
        { key: 'problemId', label: '题号' },
        { key: 'name', label: '题目名称' },
        { key: 'ratio', label: '过题比例' },
        // 取值范围**派生**（加档时这里跟着长，别再手写 "0-5"）
        { key: 'status2', label: `状态2 (0-${STATUS2_VALUES[STATUS2_VALUES.length - 1]})` },
        { key: 'cfDifficulty', label: 'CF难度' },
        { key: 'link', label: '链接' }
    ];

    document.dispatchEvent(new CustomEvent(EVENTS.SHOW_PROBLEM_INFO_DIALOG, {
        detail: {
            parentId,
            pNodes,
            editableProps,
            onExecute: async (propKey, sortMode, mode, lines) => {
                let success = false;
                await execute(
                    (draft) => {
                        // 只读边界：粘表格改字段同样是手改
                        assertManualEditAllowed(draft, '批量修改题目信息');

                        const parentCopy = draft.nodes[parentId];
                        if (!parentCopy || parentCopy.type !== 'C') {
                            throw new Error('父节点不存在或类型错误');
                        }

                        const pNodeIds = [];
                        for (const cid of draft.childOrder[parentId]) {
                            const c = draft.nodes[cid];
                            if (c && c.type === 'P') pNodeIds.push(cid);
                        }

                        if (mode === 'sequential') {
                            let orderedIds = [...pNodeIds];
                            if (sortMode === 'id') {
                                orderedIds.sort((a, b) => {
                                    const idA = draft.nodes[a].problemId || '';
                                    const idB = draft.nodes[b].problemId || '';
                                    return idA.localeCompare(idB);
                                });
                            }
                            if (lines.length > orderedIds.length) {
                                throw new Error(`行数 ${lines.length} 超过题目数 ${orderedIds.length}，请减少行数`);
                            }
                            if (lines.length === 1 && lines[0] === 'CLEAR') {
                                for (const pid of orderedIds) {
                                    const node = draft.nodes[pid];
                                    const before = {};
                                    switch (propKey) {
                                        case 'problemId': before.v = node.problemId; node.problemId = ''; break;
                                        case 'name': before.v = node.name; node.name = ''; break;
                                        case 'ratio': before.v = node.ratio; node.ratio = ''; node.xcpcDifficulty = '-'; break;
                                        case 'status2':
                                            before.v = node.status2;
                                            node.status2 = 0;
                                            // 清空 = **撤销覆盖**（`status2` 是派生字段，覆盖必须一起清）
                                            setDerivedOverride(node, 'status2', null,
                                                { account: draft.currentAccountId });
                                            break;
                                        case 'cfDifficulty': before.v = node.cfDifficulty; node.cfDifficulty = 0; break;
                                        case 'link': before.v = node.link; node.link = ''; break;
                                    }
                                    // 清空也是"手改"：值变空了 → 统一规则不记空值（无可记的"值"）
                                    recordManualValue(draft, node, propKey, before.v, node[propKey], {});
                                }
                            } else {
                                for (let i = 0; i < lines.length; i++) {
                                    const val = lines[i];
                                    if (val === '') continue;
                                    const node = draft.nodes[orderedIds[i]];
                                    if (!node) continue;
                                    applyPropertyToNode(draft, node, propKey, val);
                                }
                            }
                        } else {
                            if (lines.length === 0 || lines.length % 2 !== 0) {
                                throw new Error('行数必须为偶数（题号和值成对出现）');
                            }
                            for (const line of lines) {
                                if (line === '') {
                                    throw new Error('指定题号赋值模式下不允许空行');
                                }
                            }
                            const pairs = [];
                            const problemIdSet = new Set();
                            for (let i = 0; i < lines.length; i += 2) {
                                const pid = lines[i];
                                const val = lines[i + 1];
                                let targetId = null;
                                for (const nid of pNodeIds) {
                                    if (draft.nodes[nid].problemId === pid) {
                                        targetId = nid;
                                        break;
                                    }
                                }
                                if (!targetId) {
                                    throw new Error(`题号 "${pid}" 不存在`);
                                }
                                if (problemIdSet.has(pid)) {
                                    throw new Error(`题号 "${pid}" 重复出现`);
                                }
                                problemIdSet.add(pid);
                                pairs.push({ nodeId: targetId, value: val });
                            }
                            for (const { nodeId, value } of pairs) {
                                applyPropertyToNode(draft, draft.nodes[nodeId], propKey, value);
                            }
                        }

                        autoUpdateSubtree(draft, parentId);
                        propagateUp(draft, parentId);
                        success = true;
                        return { success: true };
                    },
                    {
                        refreshParentId: parentId,
                        onSuccess: () => {
                            showToast('题目信息更新成功', 'success');
                        },
                        onError: (err) => {
                            showToast(err.message || '操作失败', 'error');
                        }
                    }
                );
                return success;
            }
        }
    }));
}