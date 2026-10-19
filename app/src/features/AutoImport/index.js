// ================================================================
// 节点自动导入 — 插件入口（features/AutoImport/index.js）
// 职责：
//   1. 注册一级 Tab「📥 节点自动导入」
//   2. 注册文件夹节点视图「📥 导入/同步」（当前文件夹作为默认父容器）
//   3. 预览表 + 一次事务执行
// 依赖：shell/state.js, shell/executor.js, A_constants.js,
//       ./plan.js ./parse.js ./apply.js ./files.js ./history.js ./adapters/*
//
// 依赖说明：
//   本插件**不 import ui/**。跳转走 EVENTS.REVEAL_NODE，
//   容器与激活态由框架（ui/tabs.js / ui/folder/folderViewHost.js）管理。
//
// 设计依据：docs/auto-import.md 第十节
// ================================================================
import { AppState } from '../../shell/state.js';
import { EVENTS } from '../../A_constants.js';
import { buildPlan, ACTION } from './plan.js';
import { parseCrate } from './parse.js';
import { applyFieldMap, RESERVED_KEYS } from './fieldmap.js';
import { applyPlans } from './apply.js';
import { describeCounter } from '../../core/accounts.js';
import { accountName } from '../../core/ops/account.js';
import { readAllFiles, pickFiles } from './files.js';
import { watchDirectory } from './dirWatcher.js';
import { renderExtKeyPanel } from './extKeyPanel.js';
import { appendHistory } from './history.js';
import {
    WRITABLE_FIELDS,
    DEFAULT_SIMILARITY_THRESHOLD,
    HISTORY_LIMIT
} from './constants.js';
// 「性质」三字段的键名（**唯一一份**在 core/natureFields.js）——
// 迁移按它补键，别在这里手抄 `['natureClass', …]`
import { NATURE_FIELD_KEYS, natureFieldOf } from '../../core/natureFields.js';
import { CLASS_RULE_COL } from '../../core/natureConfidence.js';

import { showToast, button, yieldToUI } from './ui/kit.js';
import { makeProgress } from './ui/progress.js';
import { renderImportFailures } from './ui/failures.js';
import { buildLogBox } from './ui/buildBox.js';
import { renderPanel } from './ui/panel.js';
import { escapeHtml as esc } from '../../utils/html.js';
// 「一键重建总包」那条本机接口的客户端 ——
// 处理链在本机"主脚本"（scripts/dev-server.py）**进程内**跑，页面这边负责
// 找到它（同源 / `127.0.0.1:8321`）、起一次、看日志与进度、取包。
import {
    probeBuildApi, startBuild, fetchBuildStatus, isBuildFinished, fetchPackageFile,
    API_VERSION, stepMark
} from './buildApi.js';


const TAB_ID = 'auto-import';

const TAB_LABEL = '📥 节点自动导入';

const TAB_ORDER = 1400;

const VIEW_ID = 'auto-import-sync';

const VIEW_LABEL = '📥 导入/同步';

const VIEW_ORDER = 30;

// ================================================================
// 页面级状态（跨挂载保留；刻意不叫 state）
//
// ⚠️ Tab 与文件夹视图**各有一份**：它们是两个独立挂载点，
//    共用一份会让"在一个里选的文件"覆盖掉另一个的预览。
// ================================================================

/** 造一份新的视图状态 */

function makeViewState(kind, forcedParentId = '') {
    return {
        kind,                       // 'tab' | 'folder'
        forcedParentId,             // 文件夹视图才有：默认父容器
        batches: [],                // [{ file, source, plan, error }]
        selected: 0
    };
}

/** 一级 Tab 的状态 */

const tabView = makeViewState('tab');

/**
 * 文件夹视图的状态
 * 每次挂载都重置：挂载点的 nodeId 变了，旧的预览就失去意义
 */

let folderView = makeViewState('folder');

// ================================================================
// 小组件
// ================================================================

export function revealNode(nodeId) {
    document.dispatchEvent(new CustomEvent(EVENTS.REVEAL_NODE, { detail: { nodeId } }));
}

export function revealNodeByExtKey(extKey) {
    const node = Object.values(AppState.nodes || {}).find(n => n && n.extKey === extKey);
    if (node) revealNode(node.id);
}

// ================================================================
// 解析：把一组文件读成待执行批次
// ================================================================

/** 每条记录的中文名（用于预览表） */

async function loadFiles(files, { forcedParentExtKey = '', onProgress = null, forceNature = false } = {}) {
    const report = (info) => { if (typeof onProgress === 'function') onProgress(info); };
    const { payloads, errors } = await readAllFiles(files, {
        onProgress: (p) => report({ phase: '读取包文件', done: p.done, total: p.total, note: p.file })
    });
    const batches = [];
    const totalUnits = payloads.length + errors.length;
    let unit = 0;

    for (const err of errors) {
        unit++;
        report({ phase: '解析与出计划', done: unit, total: totalUnits, note: err.file });
        await yieldToUI();
        batches.push({ file: err.file, source: '', plan: null, error: err.message });
    }

    for (const payload of payloads) {
        unit++;
        report({ phase: '解析与出计划', done: unit, total: totalUnits, note: payload.file });
        // 让出一次宏任务：进度条要**画得出来**，界面也不能冻
        await yieldToUI();
        // parseCrate 负责：成熟 crate 走快路径；平台原生载荷走适配器
        const parsed = parseCrate(payload.data);
        if (!parsed.ok || !parsed.crate) {
            batches.push({
                file: payload.file,
                source: '',
                plan: null,
                error: parsed.errors.map(e => e.message).join('；') || '无法解析'
            });
            continue;
        }
        // ★ **解析阶段逐条剔掉的记录要留痕**（`bad-type` / `missing-extkey` / `bad-record` …）：
        //   以前只有"整包解析失败"才把 errors 写进 batch，于是被剔掉的那几条
        //   **预览里一条都不出现、计数也不算它们**（`plan` 只看到剩下的）——
        //   用户看到"新增/更新/跳过"就是全部、错误 0，链子判过并自动导入，实际少导了记录。
        //   这里把 `parsed.errors` 一并带上，预览的「① 会挡住的」里逐条列出来。
        const parseErrors = (parsed.errors || []).map(e => ({
            code: String((e && e.code) || 'parse'), message: String((e && e.message) || e)
        }));

        let crate = parsed.crate;

        // 文件夹视图：把"当前文件夹"作为默认父容器。
        // 记录自带父引用时以记录为准（只给**两种父引用都没有**的补上默认值）：
        //   · `父extKey`    —— 父是普通节点
        //   · `父synthKey` —— 父是合成节点
        // 漏判后者的后果是"两种父引用同时给" ⇒ 该条被逐条拒绝（明明包是对的，
        // 却在文件夹视图里导不进去）—— 所以这个判断必须两种都看。
        if (forcedParentExtKey) {
            const target = AppState.nodes[forcedParentExtKey];
            const targetKey = target && target.extKey ? String(target.extKey).trim() : '';
            if (!targetKey) {
                batches.push({
                    file: payload.file,
                    source: sourceLabelOf(crate),
                    plan: null,
                    error: `当前文件夹「${target && target.name ? target.name : forcedParentExtKey}」没有 extKey，`
                        + '无法作为导入目标。请先在 🔑 补身份键 页给它补上，或改用顶部「节点自动导入」页。'
                });
                continue;
            }
            crate = {
                ...crate,
                records: crate.records.map(r => (
                    (r.parentExtKey || r.parentSynthKey) ? r : { ...r, parentExtKey: targetKey }
                ))
            };
        }

        const plan = buildPlan({
            crate,
            state: AppState,
            keyIndex: buildIndex(),
            applyFieldMap: applyFieldMapInjected,
            similarityThreshold: DEFAULT_SIMILARITY_THRESHOLD,
            forceNature
        });

        batches.push({
            file: payload.file,
            source: sourceLabelOf(crate),
            plan,
            error: '',
            parseWarnings: parsed.warnings || [],
            // 解析阶段被剔掉的逐条错误（预览「① 会挡住的」要列它们，见上面那段说明）
            parseErrors,
            // **留下那份 crate** —— 预览里的「以包里为准」要**重算计划**，
            // 而重算不能再依赖 File 句柄（用户可能已经把文件挪走/改了）。
            // 存的是**做过默认父容器补全之后**的那一份（与首次规划用的完全同一个对象）⇒
            // 重算结果与"重新载入一次"逐字节相同。
            crate
        });
    }

    return batches;
}

/**
 * 导入包的**来源 id** —— 来源层用它当 `state.sources` 的键，并写进每个值的出处。
 *
 * 顺序：`source.id` → `source.label` → 空。
 *
 * ⚠️ 优先用 `id` 而不是 `label`：label 是**给人看的显示名**（"合并自 3 个包"、
 * "PTA 榜单"），随时可能被改写；而来源 id 是**数据** —— 一变就等于换了个来源，
 * 来源层里会平白多出一堆"新来源"。id 由脚本写成稳定串
 * （如 `pta-icpc2026preliminary-2`、`crate-merge`），label 只用来显示。
 */

function sourceLabelOf(crate) {
    if (!crate || !crate.source) return '';
    return crate.source.id || crate.source.label || '';
}

/** 建 extKey → nodeId 索引（只读快照；执行时会重建） */

function buildIndex() {
    const index = {};
    const nodes = AppState.nodes || {};
    for (const id in nodes) {
        const n = nodes[id];
        if (!n || !n.extKey) continue;
        const key = String(n.extKey).trim();
        if (key && !(key in index)) index[key] = id;
    }
    return index;
}

/** 注入给 plan 的 fieldMap 实现（plan 不直接依赖 fieldmap.js） */

function applyFieldMapInjected(record, fieldMap) {
    return applyFieldMap(record, fieldMap, { reservedKeys: STRUCTURAL_KEYS });
}

/** 结构键黑名单：身份列不是业务字段（权威清单在 fieldmap.js） */

// ⚠️ `type` 已经在 `RESERVED_KEYS` 里 —— 不现拼
const STRUCTURAL_KEYS = RESERVED_KEYS;

// ================================================================
// 渲染：批次选择
// ================================================================

function replanBatches(batches, forceNature) {
    let replanned = 0;
    for (const b of batches) {
        if (!b || !b.crate) continue;
        b.plan = buildPlan({
            crate: b.crate,
            state: AppState,
            keyIndex: buildIndex(),
            applyFieldMap: applyFieldMapInjected,
            similarityThreshold: DEFAULT_SIMILARITY_THRESHOLD,
            forceNature: !!forceNature
        });
        replanned++;
    }
    return replanned;
}

/**
 * 「重建总包」那个按钮的日志面板（`<pre>` + 一行状态）。
 *
 * 为什么放页面里而不是弹窗：这一跑 2~3 分钟，日志要**边跑边看**（哪一步、卡在哪），
 * 弹窗一关就没了。
 *
 * ⚠️ **单例**（`buildLogBox()`）：面板重画（切页 / 导入后 `redraw`）会把 DOM 清掉，
 *    如果每次点击都新建一个元素，日志与"正在跑"的状态就跟着没了 —— 而"自动导入"正好
 *    会触发一次重画。所以做成一个长期存在的元素：`renderPanel` 每次都把它**重新挂上去**
 *    （内容还在），轮询继续往同一个元素里写。
 */

async function onExecute(container, v) {
    const batch = v.batches[v.selected] || v.batches[0];
    if (!batch || !batch.plan) return;

    const panel = (container && typeof container.querySelector === 'function')
        ? (container.querySelector('.ai-panel') || container) : container;
    const prog = (panel && typeof panel.querySelector === 'function' && panel.querySelector('.ai-progress'))
        ? null : (panel ? makeProgress(panel, panel.querySelector('.ai-execute-bar')) : null);
    const t0 = Date.now();
    const total = batch.plan.summary ? batch.plan.summary.total : batch.plan.records.length;
    if (prog) {
        // ⚠️ 这一段**不能分片**：applyPlans 是一次事务（要么全成要么全回滚），
        //    硬拆会改掉导入语义。所以只报阶段名与条数，不假装有百分比。
        prog.spin('写入节点', `包 ${batch.file} · ${total} 条记录（一次事务）`);
        await yieldToUI();     // 让这一帧画出来再开始干重活
    }

    const items = [{ plan: batch.plan, source: batch.source || batch.file }];
    const tApply = Date.now();
    const res = await applyPlans({ state: AppState, items });
    // ★ 分段计时（"先量再改"）：端到端 `ms` + 各段，一眼看出时间花在哪。
    const phases = { apply: Date.now() - tApply, ...(res.phases || {}) };

    // 失败**明细**（不只是条数）—— 见 `renderImportFailures`。
    // 逐条收集 + 进控制台：`applyPlans` 把 `{extKey|synthKey, code, reason}` 逐条收在
    // `perItem[].failures` 里，这里再汇总出来。
    const failures = [];
    for (const st of res.perItem || []) {
        for (const f of (st && st.failures) || []) {
            failures.push({ ...f, source: (st && st.source) || '' });
        }
    }
    if (failures.length) {
        console.warn(`[导入失败] ${failures.length} 条（包：${batch.file || '?'}）—— 按原因码看 code，`
            + '按标识去树里找：', failures);
    }

    if (!res.ok) {
        if (prog) prog.el.dataset.phase = '失败';
        showToast(`导入失败（已回滚）：${res.error}`, 'error');
        return;
    }

    // 归认结果**必须上报**：认出多少要看得见（否则"什么都没提示"无法区分
    // "都认对了"和"归认没跑"）；认不出时用户唯一能做的事就是去账户里补一条映射，
    // 所以那句话是可操作的，不是装饰。
    // ⚠️ 只弹**一条**提示：`showToast` 用的同一个元素，弹两次前一条会被顶掉。
    //    所以认不出、冲突都并进这一条里说。
    //    （`noClue` 不进提示：源本来就没给线索，用户没有可行动作，只在控制台/导入记录里。）
    let accIntro = '';
    if (res.accounts) {
        const a = res.accounts;
        const bits = [`认出 ${a.matched} 条`];
        if (a.unmatched) bits.push(`另有 ${a.unmatched} 条线索没匹配上（去「账户」补一条映射即可）`);
        if (a.conflicts.length) bits.push(`${a.conflicts.length} 条线索被多个账户认领（不归任何人）`);
        accIntro = ` ｜ 归认：${bits.join('，')}`;
    }
    // 合成两阶段的落地结果也要看得见（否则"新建了 3 个合成节点"只能去树里数）
    const synthIntro = (res.synthCreated || res.synthUpdated || res.pointersSet)
        ? ` ｜ 合成节点 +${res.synthCreated}/↻${res.synthUpdated}，成员指针 ${res.pointersSet}`
        : '';
    showToast(`导入完成：新增 ${res.created}，更新 ${res.updated}`
        + `${res.rejected ? `，失败 ${res.rejected}（明细见面板红框）` : ''}${synthIntro}${accIntro}`,
        res.rejected || (res.accounts && res.accounts.unmatched) ? 'info' : 'success');

    if (res.accounts && res.accounts.conflicts.length) {
        console.warn('同一个线索被多个账户声明：', res.accounts.conflicts);
    }

    appendHistory({
        at: new Date().toISOString(),
        source: batch.source || batch.file,
        file: batch.file,
        created: res.created,
        updated: res.updated,
        skipped: res.skipped,
        failed: res.rejected,
        // 换父（重挂）了几条 —— 与预览里那个「🔀 重挂」计数对应（见 core/ops/tree.js 的 moveNode）
        moved: res.moved || 0,
        // 这次归认了多少 / 有多少条认不出来（`describeCounter` 出人话摘要）
        accounts: res.accounts ? describeCounter(res.accounts) : '',
        accountsMatched: res.accounts ? res.accounts.matched : 0,
        accountsUnmatched: res.accounts ? res.accounts.unmatched : 0,
        unusedColumns: batch.plan.summary.unusedColumns || []
    });

    // 用**最新状态**把同一份 crate 重算一遍：
    // 刚落地的节点应大量变成"跳过"，这本身就是幂等的可视证据。
    if (prog) {
        prog.spin('重算与重绘', '用最新状态重算这份包');
        await yieldToUI();
    }
    const tRecompute = Date.now();
    v.batches = await recomputeBatch(batch, v.forcedParentId || '');
    phases.recompute = Date.now() - tRecompute;
    // 记下"上一份导的是哪个文件" —— 面板重绘后靠它显示文件名
    v.lastImport = {
        files: [batch.file].filter(Boolean),
        created: res.created,
        updated: res.updated,
        moved: res.moved || 0,
        failed: res.rejected || 0,
        // 失败明细（面板上那块红框就画它；见 `renderImportFailures`）
        failures,
        ms: Date.now() - t0,
        phases
    };
    v.selected = 0;
    const tRender = Date.now();
    renderPanel(container, v);
    phases.render = Date.now() - tRender;
    // 控制台留一份（"执行导入慢"这种问题，页面上只看得到总数）
    console.log(`执行导入 ${Date.now() - t0}ms：`
        + Object.entries(phases).map(([k, v]) => `${k} ${v}ms`).join(' ｜ '));
}

/**
 * 用当前 AppState 重算一个已载入批次（crate 原样，重新出计划）
 * @param {Object} batch
 * @param {string} [forcedParentId]
 * @returns {Promise<Array>}
 */

async function recomputeBatch(batch, forcedParentId = '') {
    if (!batch || !batch.plan || !batch.plan.crate) return [];
    const crate = batch.plan.crate;
    const plan = buildPlan({
        crate,
        state: AppState,
        keyIndex: buildIndex(),
        applyFieldMap: applyFieldMapInjected,
        similarityThreshold: DEFAULT_SIMILARITY_THRESHOLD
    });
    return [{ ...batch, plan }];
}

/**
 * 目录授权 + 轮询
 * @param {Function} loadInto - (files) => Promise<void>
 */

export function readHistory(state = AppState) {
    const box = state && state.settings ? state.settings.autoImport : null;
    const list = box && Array.isArray(box.history) ? box.history : [];
    return list;
}

// ================================================================
// 挂载
// ================================================================

/**
 * 一级 Tab：标准面板（带工具栏）
 *
 * 状态用模块级 `tabView`，因为 Tab 会在切换时反复 mount/unmount，
 * 用户选好的批次应当留住。
 */

function mountTab(ctx) {
    const container = ctx.container;
    if (!container) {
        console.error('[AutoImport] Tab 缺少容器');
        return;
    }
    renderPanel(container, tabView);
}

/**
 * 文件夹节点视图：当前文件夹作为默认父容器
 *
 * 与 Tab 的差别只有两点：默认父容器、以及工具栏换成"文件夹专用"那一条。
 * 预览与执行**完全复用** renderPanel（同一条渲染路径，不靠 innerHTML 复制一遍）。
 */

function mountFolderView(ctx) {
    const panel = ctx.panel;
    if (!panel) {
        console.error('[AutoImport] 文件夹视图缺少面板');
        return;
    }

    // 每次挂载都重置状态：挂载点的 nodeId 可能已经变了，旧预览失去意义
    folderView = makeViewState('folder', ctx.nodeId || '');

    panel.innerHTML = '';
    const host = document.createElement('div');
    host.style.cssText = 'display:flex; flex-direction:column; height:100%;';
    panel.appendChild(host);

    // ---- 文件夹专用工具栏 ----
    const toolbar = document.createElement('div');
    toolbar.style.cssText = 'display:flex; align-items:center; gap:10px; flex-wrap:wrap;'
        + ' padding:8px 4px 10px 4px; border-bottom:1px solid #eef2f6; margin-bottom:10px;';

    const node = ctx.node;
    const label = document.createElement('span');
    label.style.cssText = 'font-size:12px; color:#475569;';
    label.textContent = `导入目标：${node && node.name ? node.name : '(当前文件夹)'}`
        + (node && node.extKey ? `　extKey = ${node.extKey}` : '　⚠️ 该文件夹没有 extKey');
    toolbar.appendChild(label);

    const body = document.createElement('div');
    body.className = 'ai-folder-body';
    body.style.cssText = 'flex:1; overflow:auto;';

    // 载入并重绘（与 renderPanel 内部同构，但目标容器是 body）
    const loadInto = async (files) => {
        folderView.batches = await loadFiles(files, { forcedParentExtKey: folderView.forcedParentId });
        folderView.selected = 0;
        renderFolderBody();
    };

    const pick = button('选择导入文件…', () => onPickFiles(loadInto), true);
    pick.className = 'ai-fv-pick-btn';
    toolbar.appendChild(pick);

    toolbar.appendChild(button('🔑 补身份键', () => {
        renderExtKeyPanel(body, {
            nodeId: folderView.forcedParentId,
            node,
            refresh: () => renderFolderBody()
        });
    }));

    host.appendChild(toolbar);
    host.appendChild(body);

    /** 重绘预览区（工具栏由上面的 mount 固定，不参与重绘） */
    function renderFolderBody() {
        if (!folderView.batches.length) {
            body.innerHTML = '<div class="empty-state" style="padding:40px 20px; text-align:center; color:#94a3b8;">'
                + '<div style="font-size:36px; margin-bottom:10px; opacity:0.5;">📥</div>'
                + '<p>选择导入文件后在此预览并执行</p></div>';
            return;
        }
        // 复用 Tab 的渲染逻辑，只关掉它自带的工具栏
        renderPanel(body, folderView, { showToolbar: false });
    }

    renderFolderBody();
}

// ================================================================
// 激活
// ================================================================

export function activateAutoImport(api) {
    // extKey 字段：主树与副页都要补默认值（插件加字段的标准做法）
    api.registerNodeMigration(node => {
        if (node.extKey === undefined) node.extKey = '';
        if (node.importFingerprint === undefined) node.importFingerprint = '';
        if (node.importSource === undefined) node.importSource = '';
        // 「性质」四字段：只补**缺的键**（空值 = 没标），理由见下面的 VNodeMigration
        for (const k of NATURE_FIELD_KEYS) {
            if (node[k] === undefined) node[k] = '';
        }
        // 「分类依据」：只补**缺的键**。空对象 = "没有依据信息"
        // （老数据 / 手填的分类）—— 界面据此**不画**级别徽标（`classLevelOf` 返回空串）。
        // 它不是业务字段（`elements.js` 里是 STRUCTURAL）：导入包不许当字段写，
        // 由 `apply.js` 从元列 `分类依据` 显式落到这儿。
        if (node[CLASS_RULE_COL] === undefined) node[CLASS_RULE_COL] = {};
    });
    api.registerVNodeMigration(vNode => {
        if (vNode.extKey === undefined) vNode.extKey = '';
        if (vNode.importFingerprint === undefined) vNode.importFingerprint = '';
        if (vNode.importSource === undefined) vNode.importSource = '';
        // 「性质」四字段（大类/小类/年份/地区）：与上面三个同一套路 —— 只补**缺的键**，
        // 不写占位值。为什么需要（而不是像 `name` 那样进 COMMON_DEFAULTS）：
        // 口径是"没标就是没标" —— 四个字段**都可空**，
        // 所以节点上不该有一份"空字符串默认值"去冒充"已填"。
        for (const k of NATURE_FIELD_KEYS) {
            if (vNode[k] === undefined) vNode[k] = '';
        }
        if (vNode[CLASS_RULE_COL] === undefined) vNode[CLASS_RULE_COL] = {};
    });

    // 主树 → 副页复制时带上身份，便于在副页视图里对账
    api.registerVNodeCopyHook((real, vNode) => {
        vNode.extKey = real.extKey || '';
    });

    // 编辑对话框可手填 extKey（补身份键的另一条路径，第八节）
    //
    // 语义：**只补空的**。已有 key 时不在这里改——更换身份是危险操作，
    // 需要"讲清后果 + 二次确认"，那些放在「🔑 补身份键」页的「更换」按钮里。
    api.registerNodeEditorExtension({
        nodeTypes: ['*'],
        fields: [{
            key: 'extKey',
            label: '外部身份键 (extKey)',
            type: 'text',
            default: ''
        }],
        apply: (draft, nodeId, formData) => {
            const node = draft.nodes[nodeId];
            if (!node) return;
            const raw = formData.extKey;
            if (raw === undefined || raw === null) return;
            const key = String(raw).trim();
            if (key === '') return;                          // 空 = 不改
            if (node.extKey && node.extKey !== key) return;  // 已有 key 不在此处覆盖
            node.extKey = key;
        }
    });

    api.registerTab({
        id: TAB_ID,
        label: TAB_LABEL,
        order: TAB_ORDER,
        mount: mountTab
    });

    api.registerFolderView({
        id: VIEW_ID,
        label: VIEW_LABEL,
        order: VIEW_ORDER,
        mount: mountFolderView
    });
}

export { TAB_ID, TAB_LABEL, VIEW_ID, VIEW_LABEL, renderPanel, loadFiles, HISTORY_LIMIT };
/** 进度条控制器：给冒烟测试断言"进度/预计时间"用（生产代码由 renderPanel/onExecute 内部创建） */
export { makeProgress, yieldToUI };
// ⚠️ 这两个**只给面板用**：`ui/panel.js` 反向 import 本模块（见那个文件头注的"成环"说明）——
//    编排流程（执行导入 / 重算计划）留在这里，因为它们是**状态与事务**的把关人，不是画界面的。
export { onExecute, replanBatches };
