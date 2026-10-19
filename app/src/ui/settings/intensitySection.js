// ================================================================
// 设置页 · 训练强度映射表（ui/settings/intensitySection.js）
//
// 干什么：全局若干张**有名字的**强度表（⑮），每张把"难度 → 训练强度"写清楚；
//         计划只引用其中一张（`plan.intensityTableId`，空 = 用内置默认那张）。
// 依赖：`core/ops/plan.js`（增/改/删，全过只读闸门）、`core/trainingPlan.js`（内置默认表 + 插值口径）、
//       `utils/color.js:XCPC_ORDER` / `A_constants.js:XCPC_THRESHOLDS`（档位与通过率区间只有这一份）、
//       `shell/executor.js`。
//
// ⚠️ **这一栏不走设置页那个"底部保存"**：表库有自己的增/改/删按钮，各自一个事务
//    （它是"口径库"，与显示/性能那些开关不是一回事；混进底部草稿会让"保存设置"多一堆隐式副作用）。
// ⚠️ 空数组 = 用**内置默认那张**（`intensityTableById`），所以这里第一项永远是「默认（内置，只读）」。
// ⚠️ 输入框一律给 `data-ti` 属性（`ratio:<i>:max` / `ratio:<i>:value` / `cf:<i>:max` / `cf:<i>:value` /
//    `mode` / `name` / `default`），冒烟按它驱动（DOM 桩不解析逗号选择器，别合成一个复合选择器去查）。
//
// ★ `v9.1.38` 起这张表的形状变了（用户第 5 轮"重定强度权重"）：
//   · XCPC 侧从「20 个档位 → 强度」的**台阶**改成「**通过率 ≤ X% → 强度**」的**控制点**（点之间相接）；
//     出厂值 = `xcpcIntensityPoints()` 现算（每个档的**通过率上限**一点 + 一个封顶点）。
//     ⚠️ 第 9 轮起这些值**不再**按"每档 ×1.2"排，改成"通过率折算成等价数值难度再走那条式子"
//     （用户："不会明写，只是数值一致"）⇒ 界面上**只显示通过率与强度**，别把等价分印出来。
//   · 数值侧同样是控制点，出厂值来自**一条式子**（`v9.1.40`，用户第 7 轮："以 2600 取 10 为基准，
//     每差 400 分强度翻倍；再对 1 取 max，大概在 1271 前生效"）—— `cfIntensityPoints()` 采样而来。
//   · 点之间怎么相接由表上的 `mode` 决定：`exp`（指数段，`v9.1.41` 起默认）/ `line` / `smooth`。
// ================================================================
import { AppState } from '../../shell/state.js';
import { execute } from '../../shell/executor.js';
import { el } from '../../utils/dom.js';
import { escapeHtml } from '../../utils/A_helpers.js';
import { showToast, showDeleteConfirm } from '../G_modal/G_modals.js';
import { addIntensityTable, updateIntensityTable, deleteIntensityTable } from '../../core/ops/plan.js';
import {
    DEFAULT_INTENSITY_TABLE, intensityTableById, xcpcIntensityPoints, cfIntensityPoints,
    xcpcPointLabelOf, intensityJoinLabelOf,
    INTENSITY_MIN, CF_INTENSITY_BASE_VALUE, CF_INTENSITY_DOUBLE_PER, CF_INTENSITY_TOP
} from '../../core/trainingPlan.js';
import { XCPC_COLORS } from '../../A_constants.js';
// ⚠️ 档名不在这里 `XCPC_THRESHOLDS.find(...)`（第 10 轮收的）：唯一一份是上面那个 `xcpcPointLabelOf`

const CARD = 'border:1px solid #e2e8f0;border-radius:10px;padding:12px;background:#fff;';
const HINT = 'font-size:11px;color:#94a3b8;line-height:1.6;';
const INPUT = 'padding:4px 6px;border:1px solid #d1d5db;border-radius:6px;font-size:12px;';
const TH = 'font-size:11px;color:#94a3b8;font-weight:400;text-align:left;';

/**
 * 正在编辑哪张表。模块级：切栏/重画都留着。
 * ⚠️ **`null` 与 `''` 不是一回事**（这里踩过一次）：`null` = "还没选过"（自动挑第一张自定义表），
 *    `''` = "用户明确选了内置那张"。把初始值写成 `''` 的话，`select` 一选内置就被自动改回第一张表
 *    ⇒ 「换回内置」这个动作永远不生效（判据：`settings-page.smoke.mjs` ⑭ 的最后两条）。
 */
let activeTableId = null;

/** 给自测/排错用（与设置页其它模块级状态一起清） */
export function resetIntensitySection() {
    activeTableId = null;
}

/** 现在编辑的是哪一张（`''` = 内置那张；自测用） */
export function currentIntensityTableId() {
    return activeTableId || '';
}

const tablesOf = () => (Array.isArray(AppState.settings.trainingIntensityTables)
    ? AppState.settings.trainingIntensityTables : []);

/** 跑一个写操作（统一 toast；成功后重画这一栏） */
async function run(op, okMsg, redraw) {
    try {
        await execute(op, {
            validate: false,
            refreshParentId: null,
            onSuccess: () => { showToast(okMsg, 'success'); redraw(); },
            onError: (err) => showToast(err.message, 'error')
        });
    } catch (_) { /* onError 已经报过 */ }
}

/** 读一组控制点（`ratio` / `cf` 同一套钩子形状；`max` 留空 = "+∞"那一点） */
function readPoints(panel, key) {
    const out = [];
    for (const row of panel.querySelectorAll(`[data-ti="${key}:row"]`)) {
        const i = row.dataset.i;
        const maxRaw = String((panel.querySelector(`[data-ti="${key}:${i}:max"]`) || {}).value || '').trim();
        const vRaw = String((panel.querySelector(`[data-ti="${key}:${i}:value"]`) || {}).value || '').trim();
        if (vRaw === '') continue;
        const value = Number(vRaw);
        if (!Number.isFinite(value) || value < 0) continue;
        const max = (maxRaw === '') ? null : Number(maxRaw);
        out.push({ max: Number.isFinite(max) ? max : null, value });
    }
    return out;
}

/** 读当前编辑器里的值（**唯一一份**：保存那张表时用它） */
function readTableForm(panel, base) {
    const val = (sel) => {
        const node = panel.querySelector(sel);
        return node ? String(node.value === undefined ? '' : node.value).trim() : '';
    };
    const num = (sel, fallback) => {
        const raw = val(sel);
        if (raw === '') return fallback;
        const n = Number(raw);
        return Number.isFinite(n) ? n : fallback;
    };
    return {
        name: val('[data-ti="name"]') || base.name,
        byRatio: readPoints(panel, 'ratio'),
        byCf: readPoints(panel, 'cf'),
        mode: val('[data-ti="mode"]') === 'smooth' ? 'smooth' : (val('[data-ti="mode"]') === 'line' ? 'line' : 'exp')
    };
}

/** 强（数值）输入格：`data-ti` 是冒烟的钩子 */
function numInput(dataTi, value, width = '54px') {
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0';
    input.step = '0.5';
    input.style.cssText = INPUT + `width:${width};`;
    input.dataset.ti = dataTi;
    input.value = (value === undefined || value === null) ? '' : String(value);
    return input;
}

/**
 * 一组**控制点**的编辑器（`ratio` / `cf` 共用一份写法）。
 *
 * @param {string} key `ratio` | `cf`（钩子前缀；冒烟按它驱动）
 * @param {Array<{max:number|null, value:number}>} rows
 * @param {(patch:Object, okMsg:string) => void} write 写回那张表
 * @param {(x:number|null) => string} [labelOf] 每个横坐标那一格额外的灰字（XCPC 侧用来标档位）
 * @param {Function} [reset] 给一个"重算出厂值"的回调
 */
function pointsEditor(key, rows, write, labelOf, reset) {
    const wrap = el('div', '');
    const head = el('div', 'display:flex;gap:6px;font-size:11px;color:#94a3b8;margin-bottom:2px;');
    head.appendChild(el('span', 'width:104px;', '横坐标'));
    head.appendChild(el('span', 'width:64px;', '强度'));
    wrap.appendChild(head);
    const list = Array.isArray(rows) ? rows : [];
    // 展示顺序 = **易 → 难**（用户第 5 轮："应该全都易→难"）；存回时 `normalizePoints` 会按 max 升序排好
    const shown = (key === 'ratio') ? list.slice().reverse() : list;
    shown.forEach((row, i) => {
        const line = el('div', 'display:flex;gap:6px;align-items:center;margin-bottom:4px;');
        line.dataset.ti = `${key}:row`;
        line.dataset.i = String(i);
        line.appendChild(numInput(`${key}:${i}:max`, (row.max === null || row.max === undefined) ? '' : row.max, '104px'));
        line.appendChild(numInput(`${key}:${i}:value`, row.value, '64px'));
        const extra = labelOf ? labelOf(row.max) : '';
        // ★ 第 14 轮（用户："尽量给各处难度文本涂上应有的颜色"）：真档名用**难度自己的颜色**
        //   （`A_constants.js:XCPC_COLORS`，与树上/计划页同一份）；「拐点」/「到顶」不是档位 ⇒ 保持灰
        if (extra) line.appendChild(el('span', HINT + `color:${XCPC_COLORS[extra] || '#94a3b8'};`, extra));
        const del = document.createElement('button');
        del.className = 'btn';
        del.dataset.ti = `${key}:${i}:del`;
        del.textContent = '✖';
        del.title = '删掉这一点（相邻两点之间直接相接）';
        del.addEventListener('click', () => write({ [key === 'ratio' ? 'byRatio' : 'byCf']: list.filter((_, k) => k !== i) }, '已删掉这一点'));
        line.appendChild(del);
        wrap.appendChild(line);
    });
    const bar = el('div', 'display:flex;gap:6px;align-items:center;');
    const add = document.createElement('button');
    add.className = 'btn';
    add.dataset.ti = `${key}:add`;
    add.textContent = '＋ 加一点';
    add.addEventListener('click', () => {
        const next = list.concat([{ max: null, value: 0 }]);
        write({ [key === 'ratio' ? 'byRatio' : 'byCf']: next }, '已加一点（记得填数值并保存）');
    });
    bar.appendChild(add);
    if (reset) {
        const rst = document.createElement('button');
        rst.className = 'btn';
        rst.dataset.ti = `${key}:reset`;
        rst.textContent = '↺ 恢复出厂曲线';
        rst.title = key === 'ratio'
            ? '按出厂值重算 XCPC 侧（每个档位的通过率上限一点 + 封顶点，值 = 内置强度）'
            : `按"2600 取 ${CF_INTENSITY_BASE_VALUE}、每差 ${CF_INTENSITY_DOUBLE_PER} 分翻倍、` +
              `对 ${INTENSITY_MIN} 取 max、${CF_INTENSITY_TOP} 封顶"重算`;
        rst.addEventListener('click', () => write(reset(), '已按出厂值重算（还要点「保存这张表」）'));
        bar.appendChild(rst);
    }
    wrap.appendChild(bar);
    return wrap;
}

/** 编辑区（只对**真实表**画；内置默认那张只读） */
function editorOf(table, isBuiltin, redraw) {
    const card = el('div', CARD);
    card.dataset.ti = 'editor';
    const title = el('div', 'font-size:13px;font-weight:600;color:#334155;margin-bottom:8px;',
        isBuiltin ? '训练强度：内置默认表（只读）' : `训练强度：正在编辑「${table.name}」`);
    card.appendChild(title);

    if (isBuiltin) {
        card.appendChild(el('div', HINT,
            '现在计划里没引用任何自定义表 ⇒ 用的是内置这张。想改就「＋ 新建一张」，'
            + 'XCPC 侧"通过率越低越重"（每个档位的分界点是一点，C/R 最大），数值侧按"2600 取 '
            + `${CF_INTENSITY_BASE_VALUE}、每差 ${CF_INTENSITY_DOUBLE_PER} 分翻倍、对 ${INTENSITY_MIN} 取 max、`
            + `${CF_INTENSITY_TOP} 封顶"（≈1271 前都是 1），点之间按你选的方式相接。`
            + '没填难度的题强度记 0（不计入）。'));
        return card;
    }

    // ---- 表名 + 点之间怎么接 ----
    const top = el('div', 'display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;margin-bottom:8px;');
    const nameLab = el('label', 'display:flex;flex-direction:column;gap:2px;font-size:12px;color:#475569;');
    nameLab.appendChild(el('span', 'font-size:11px;color:#94a3b8;', '表名'));
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.style.cssText = INPUT + 'width:180px;';
    nameInput.dataset.ti = 'name';
    nameInput.value = table.name;
    nameLab.appendChild(nameInput);
    // ★ 第 12 轮：原来这里有个「没填难度时按它算」的默认强度 —— 用户定了"未填写的不计入 ⇒ 强度为 0"
    //   ⇒ 那个旋钮**没有任何作用了**，删掉（留着一个不起作用的开关比没有更坏）。
    const modeLab = el('label', 'display:flex;flex-direction:column;gap:2px;font-size:12px;color:#475569;');
    modeLab.appendChild(el('span', 'font-size:11px;color:#94a3b8;', '点之间'));
    const modeSel = document.createElement('select');
    modeSel.style.cssText = INPUT + 'width:132px;';
    modeSel.dataset.ti = 'mode';
    for (const [v, label] of [['exp', '指数曲线（默认）'], ['line', '线段'], ['smooth', '平滑曲线（PCHIP）']]) {
        const o = document.createElement('option');
        o.value = v;
        o.textContent = label;
        modeSel.appendChild(o);
    }
    modeSel.value = (table.mode === 'smooth') ? 'smooth' : ((table.mode === 'line') ? 'line' : 'exp');
    modeLab.appendChild(modeSel);
    top.appendChild(nameLab);
    top.appendChild(modeLab);
    card.appendChild(top);

    const write = (patch, okMsg) => run((draft) => updateIntensityTable(draft, table.id, patch), okMsg, redraw);

    // ---- XCPC 侧：按通过率的控制点（横坐标 = 各档的通过率上限 + 式子自己的两个折点）----
    const ratioTitle = el('div', TH, 'XCPC 难度（按「通过率」查表：每一点写"通过率取它时强度是多少"，'
        + `通过率越低越重；点之间${intensityJoinLabelOf(table.mode)}）`);
    ratioTitle.style.marginTop = '4px';
    card.appendChild(ratioTitle);
    card.appendChild(pointsEditor(
        'ratio',
        table.byRatio,
        write,
        // 横坐标正好落在某个档的上限上 ⇒ 标出档名；式子自己的折点 ⇒ 「拐点」/「到顶」
        // ⚠️ **唯一一份**在 `core/trainingPlan.js:xcpcPointLabelOf`（计划页那一栏也调它）
        (x) => xcpcPointLabelOf(x),
        () => ({ byRatio: xcpcIntensityPoints() })
    ));

    // ---- 数值侧：同一套控制点（出厂值 = 那条式子采样来的）----
    const cfTitle = el('div', TH, `数值难度（一串控制点；出厂值 = "2600 取 ${CF_INTENSITY_BASE_VALUE}、`
        + `每差 ${CF_INTENSITY_DOUBLE_PER} 分翻倍、对 ${INTENSITY_MIN} 取 max、${CF_INTENSITY_TOP} 封顶" 的采样，`
        + '点之间相接；上限留空 = "+∞"那一点，排最后）');
    cfTitle.style.marginTop = '10px';
    card.appendChild(cfTitle);
    card.appendChild(pointsEditor('cf', table.byCf, write, null, () => ({ byCf: cfIntensityPoints() })));

    // ---- 保存 / 删除 ----
    const foot = el('div', 'display:flex;gap:8px;margin-top:10px;');
    const save = document.createElement('button');
    save.className = 'btn btn-primary';
    save.dataset.ti = 'save';
    save.textContent = '💾 保存这张表';
    save.addEventListener('click', () => {
        const patch = readTableForm(card, table);
        run((draft) => updateIntensityTable(draft, table.id, patch), '强度表已保存', redraw);
    });
    const delBtn = document.createElement('button');
    delBtn.className = 'btn';
    delBtn.dataset.ti = 'delete';
    delBtn.textContent = '✖ 删除这张表';
    delBtn.addEventListener('click', () => {
        showDeleteConfirm('删除强度表', `确定删除「${table.name}」吗？引用它的计划会退回内置默认表。`, (okFlag) => {
            if (!okFlag) return;
            run((draft) => deleteIntensityTable(draft, table.id), '强度表已删除', () => {
                activeTableId = null;       // 删掉之后回到"还没选过"，自动挑剩下第一张
                redraw();
            });
        });
    });
    foot.appendChild(save);
    foot.appendChild(delBtn);
    card.appendChild(foot);
    return card;
}

/**
 * 这一栏的卡片（设置页 `SECTIONS` 里 `intensity` 调它）。
 * @param {Function} redraw 重画整个设置页
 */
export function intensityCards(redraw) {
    const list = tablesOf();
    const cards = [];

    // ---- 选表 ----
    const pick = el('div', CARD);
    const head = el('div', 'font-size:13px;font-weight:600;color:#334155;margin-bottom:8px;', '🏋️ 训练强度映射表');
    pick.appendChild(head);
    // ⚠️ `''` 是**用户选的**内置那张，别自动改回去（见上面 `activeTableId` 的注释）
    if (activeTableId === null || (activeTableId !== '' && !list.some((t) => t && t.id === activeTableId))) {
        activeTableId = list.length ? list[0].id : '';
    }
    const select = document.createElement('select');
    select.dataset.ti = 'select';
    select.style.cssText = INPUT + 'width:100%;';
    const builtinOpt = document.createElement('option');
    builtinOpt.value = '';
    builtinOpt.textContent = '默认（内置，只读）';
    select.appendChild(builtinOpt);
    for (const t of list) {
        const opt = document.createElement('option');
        opt.value = t.id;
        opt.textContent = t.name;
        select.appendChild(opt);
    }
    select.value = activeTableId || '';
    select.addEventListener('change', () => { activeTableId = select.value; redraw(); });
    pick.appendChild(select);
    pick.appendChild(el('div', HINT, '计划只引用其中一张（在计划设置里选）；改这张表，所有引用它的计划一起变。'));

    const addWrap = el('div', 'display:flex;gap:6px;align-items:center;margin-top:8px;');
    const newName = document.createElement('input');
    newName.type = 'text';
    newName.placeholder = '新表名字';
    newName.style.cssText = INPUT + 'flex:1;';
    newName.dataset.ti = 'new-name';
    const addBtn = document.createElement('button');
    addBtn.className = 'btn';
    addBtn.dataset.ti = 'add';
    addBtn.textContent = '＋ 新建一张';
    addBtn.addEventListener('click', () => {
        const name = String(newName.value || '').trim();
        run((draft) => {
            const t = addIntensityTable(draft, {
                name: name || `强度表 ${list.length + 1}`,
                byRatio: xcpcIntensityPoints(),
                byCf: cfIntensityPoints(),
                mode: DEFAULT_INTENSITY_TABLE.mode
            });
            activeTableId = t.id;
        }, '强度表已新建（出厂曲线已填好，可直接改）', redraw);
    });
    addWrap.appendChild(newName);
    addWrap.appendChild(addBtn);
    pick.appendChild(addWrap);
    cards.push(pick);

    // ---- 编辑当前表 ----
    const current = intensityTableById(list, activeTableId);
    const isBuiltin = current.id === DEFAULT_INTENSITY_TABLE.id;
    cards.push(editorOf(current, isBuiltin, redraw));
    return cards;
}
