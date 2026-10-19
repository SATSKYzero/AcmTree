// ================================================================
// 通用对话框（G2_common.js）
// ================================================================
import { normalizeTime, escapeHtml } from '../../utils/A_helpers.js';
import { createModal } from './G1_core.js';
import { showToast } from './G1_toast.js';
// W/S/C 等弹窗也走这里 —— 打开时清空"用户敲过字的字段"集合，
// 以免上一个弹窗的输入记录漏到这一次（P 弹窗同理，见 G4_edit.js）。
import { beginInputSession } from './manualInput.js';

// ================================================================
// 通用表单对话框
// ================================================================

/**
 * 渲染一组字段的控件（**唯一一处**）。
 *
 * 谁用：通用表单对话框（本文件）与节点信息大界面的「✏️ 编辑」页（`ui/nodeinfo/nodeEdit.js`）
 * —— 两处必须是同一套控件（同一个 id 前缀 `field-<key>`），否则
 * `manualInput.js` 的"用户敲过这个字段"就认不出来，手改留痕会失效。
 *
 * @param {Array<{key:string,label:string,type?:string,options?:string[],default?:*,placeholder?:string,hint?:string,suggestions?:string[]}>} fields
 * @returns {string} HTML
 */
export function renderEditFieldsHtml(fields) {
    let html = '';
    for (const f of fields) {
        html += `<label>${escapeHtml(f.label)}`;
        if (f.type === 'select') {
            // `data-dep`：这个下拉的**选项**依赖另一个字段（小类归属）——
            // 具体刷新由 `wireDependentFields` 接管（见那里的注释）。
            const depAttr = f.dependsOn ? ` data-dep="${escapeHtml(f.dependsOn)}"` : '';
            // ⚠️ **当前值不在选项里时，把它自己补进去**：
            // `<select>` 里没有的选项，赋 `value` 会落成**空串**（浏览器就这么干，见下面
            // `wireDependentFields` 的同一条注释）⇒ 编辑一个"状态是自造缩写"的节点（`HACK` /
            // `PC` / `JG`…，见 `crate.normalize_status`）会把状态**静默抹掉**。
            // 判据与性质小类那处一致（`editForm.js` 的 `if (cls && !known.includes(cls))`）。
            const options = [...(f.options || [])];
            const cur = (f.default === undefined || f.default === null) ? '' : String(f.default);
            if (cur && !options.includes(cur)) options.push(cur);
            html += `<select id="field-${f.key}"${depAttr} style="width:100%;padding:6px;border-radius:6px;border:1px solid #ccc;font-size:14px;margin-top:4px;">`;
            options.forEach(opt => {
                const selected = (String(opt) === cur) ? 'selected' : '';
                const optText = escapeHtml(opt);
                html += `<option value="${optText}" ${selected}>${optText}</option>`;
            });
            html += `</select>`;
        } else {
            // `min`/`max` 只有插件扩展字段会带（数字输入的合法区间），其余字段没有
            const minAttr = f.min !== undefined ? ` min="${escapeHtml(f.min)}"` : '';
            const maxAttr = f.max !== undefined ? ` max="${escapeHtml(f.max)}"` : '';
            // 「性质」的年份/赛季：`suggestions` = 输入框的**候选提示**（原生 `<datalist>`）。
            // ⚠️ 只是提示，**不禁手输**：要挡的是"写不进库的值"（写路径会挡），不是人的键盘；
            //    这几个值（`无` / `待同步` / `不确定`）正是"合法但想不起来该怎么写"的那种。
            const listId = f.suggestions && f.suggestions.length ? `dl-${f.key}` : '';
            const listAttr = listId ? ` list="${listId}"` : '';
            // ⚠️ 值要**转义**：题名里带 `"` 是常事（实测 `Find "rururutata"`），
            //    不转义会把 value 属性截断，输入框显示错值、保存后写坏字段。
            html += `<input type="${f.type || 'text'}" id="field-${f.key}" value="${escapeHtml(f.default || '')}" placeholder="${escapeHtml(f.placeholder || '')}"${minAttr}${maxAttr}${listAttr} style="width:100%;padding:6px;border-radius:6px;border:1px solid #ccc;font-size:14px;margin-top:4px;">`;
            if (listId) {
                html += `<datalist id="${listId}">`;
                for (const s of f.suggestions) html += `<option value="${escapeHtml(s)}"></option>`;
                html += `</datalist>`;
            }
        }
        html += `</label>`;
        // 值级来源：字段描述里可以带一段 `hint`（HTML），渲染在字段下方。
        // 例：`hint: buildSourcePanelHtml(node, 'ratio', AppState.trust)`
        if (f.hint) html += f.hint;
    }
    return html;
}

/**
 * 让"选项跟着另一个字段走"的下拉**当场重建**（小类归属用）。
 *
 * 为什么必须做：`<select>` 里**没有的选项**，赋 `value` 会落成**空串**（浏览器就这么干）。
 * 于是"先把大类从 atcoder 改成 xcpc、再选小类 ccpc"会变成**静默把小类清空** ——
 * 用户以为选了，保存下来却是空的（实测在编辑页冒烟上就是这样）。
 *
 * 描述符契约（可选，不传就什么都不做）：
 *   · `dependsOn`  —— 依赖哪个字段的 key；
 *   · `optionsFor(depValue, currentValue) → string[]` —— 重新算选项（当前值一般并进去，
 *     否则"旧数据里与当前大类不配对的值"会从下拉里消失，既看不见也清不掉）。
 *
 * 两个宿主都要调：`showFormDialog`（编辑弹窗）与 `nodeEdit.js` 的 `mountNodeEdit`（编辑子页）。
 */
export function wireDependentFields(root, fields) {
    if (!root || !Array.isArray(fields)) return;
    for (const f of fields) {
        if (!f || !f.dependsOn || typeof f.optionsFor !== 'function') continue;
        const sel = root.querySelector(`#field-${f.key}`);
        const dep = root.querySelector(`#field-${f.dependsOn}`);
        if (!sel || !dep) continue;
        dep.addEventListener('change', () => {
            const want = sel.value;
            const list = f.optionsFor(dep.value, want);
            for (const c of [...(sel.children || [])]) sel.removeChild(c);
            for (const v of list) {
                const o = document.createElement('option');
                o.value = v;
                o.textContent = v;
                sel.appendChild(o);
            }
            // 新选项里还留着就保住用户的选择；否则退回空（= 没标），**绝不**留一个非法值
            sel.value = list.includes(want) ? want : '';
        });
    }
}

/**
 * 从容器里读回字段值（**唯一一处**）。
 *
 * `time` 字段在这里就走 `normalizeTime` 校验（弹窗与编辑页行为一致）。
 *
 * @param {HTMLElement} root - 装这些控件的容器（弹窗面板 / 编辑页的字段区）
 * @param {Array<Object>} fields
 * @returns {{ok:boolean, values:Object, error?:string}}
 */
export function readEditValues(root, fields) {
    const values = {};
    for (const f of fields) {
        const input = root ? root.querySelector(`#field-${f.key}`) : null;
        if (!input) return { ok: false, values: {}, error: `找不到字段控件：${f.key}` };
        let value = input.value;
        if (f.key === 'time' && typeof value === 'string') {
            const timeResult = normalizeTime(value);
            if (!timeResult.valid) {
                return {
                    ok: false, values: {},
                    error: timeResult.reason || '时间格式无效，请使用 12位(YYYYMMDDHHMM) 或 14位(YYYYMMDDHHMMSS) 数字'
                };
            }
            value = timeResult.isEmpty ? '' : timeResult.value;
        }
        values[f.key] = value;
    }
    return { ok: true, values };
}

/**
 * @param {Function} [validate] 可选的**关框前**校验：吃 `read.values`，返回
 *        `{ok:false, error}` 时**不关框**（用户敲的值一个字不改），只弹一行错误。
 *        这个口子只给"编辑节点"用（`G4_edit.js` 传 `validateEdit`）——
 *        合成标识被占用 / 用了保留前缀时必须让用户**就地改**，而不是框一关、
 *        值全丢。不传 = 其它调用方不受影响。
 */
export function showFormDialog(title, fields, callback, validate) {
    const formHtml = renderEditFieldsHtml(fields);

    // ★ 新的一次弹窗会话（见 manualInput.js）：这个弹窗里的"手改"从零开始计
    beginInputSession();

    const { panel, close } = createModal({
        title,
        content: formHtml,
        maxWidth: '550px',
        buttons: [
            // ★ 取消**必须回调一次**（`callback(null)`）：不回调 ⇒ 调用方 `await` 的 Promise 永远悬着
            //   （用户点"取消"后界面什么也不说、也再没反应）。约定见文件头那一段。
            { label: '取消', className: 'btn', callback: () => { close(); callback(null); } },
            { label: '确定', className: 'btn btn-primary', callback: () => {
                const read = readEditValues(panel, fields);
                if (!read.ok) {
                    showToast(read.error, 'error');
                    return false;                 // 校验不过就**别关**弹窗
                }
                if (typeof validate === 'function') {
                    const check = validate(read.values) || { ok: true };
                    if (!check.ok) {
                        showToast(check.error || '无法保存', 'error');
                        return false;             // 同上：**别关**（调用方传的是纯校验）
                    }
                }
                close();
                callback(read.values);
                return false;
            }}
        ]
    });
    // 选项依赖别的字段的下拉（小类 vs 大类）要在**插入 DOM 之后**接线
    wireDependentFields(panel, fields);
}

// ================================================================
// 提示对话框（Prompt）
//
// ★ **取消 / 确定的统一约定**（`v9.3.4` 立，三类弹窗都一样）：
//   · **取消** ⇒ `callback(null)`，而且**一定回调一次**（不回调会让调用方的 Promise 永远悬着）；
//   · **确定** ⇒ `callback(值)`，**空串照传**（不再 `|| null`）。
//   ⇒ 调用方于是能分清两件事：`null` = 用户取消（**整个操作中止**）、`''` = 确定但留空
//     （对"链接 / 时间"这类**可选字段**是合法值）。
//   ⚠️ 以前这两件事是混的（都变 `null`）⇒ "可选字段那一步点取消"被当成"留空"，**后面的提交照做**
//     （用户 2026-10-13 报的"添加节点在靠后的环节点取消、之前的步骤仍执行"）。
// ================================================================
export function showPromptDialog(title, label, defaultValue, callback) {
    const html = `
        <label style="display:block;margin:10px 0;">${label}
            <input type="text" id="prompt-input" value="${defaultValue || ''}" style="width:100%;padding:6px;border-radius:6px;border:1px solid #ccc;font-size:14px;margin-top:4px;">
        </label>
    `;
    const { close, panel } = createModal({
        title,
        content: html,
        buttons: [
            { label: '取消', className: 'btn', callback: () => { close(); callback(null); } },
            { label: '确定', className: 'btn btn-primary', callback: () => {
                const input = panel.querySelector('#prompt-input');
                const val = input ? input.value.trim() : '';
                close();
                callback(val);          // ★ 空串也照传（取消才是 null）
            }}
        ]
    });
    setTimeout(() => {
        const input = panel.querySelector('#prompt-input');
        if (input) input.focus();
    }, 50);
}

// ================================================================
// 确认对话框（Confirm）
// ================================================================
export function showConfirmDialog(title, message, callback) {
    const html = `<p style="margin:12px 0;font-size:16px;">${message}</p>`;
    createModal({
        title,
        content: html,
        buttons: [
            { label: '取消', className: 'btn', callback: () => { callback(false); } },
            { label: '确定', className: 'btn btn-danger', callback: () => { callback(true); } }
        ]
    });
}

// ================================================================
// 内部：倒计时确认弹窗核心（公共部分）
// ================================================================
function createCountdownConfirm({
    title,
    message,
    onConfirm,
    onCancel,
    confirmLabel = '确定',
    confirmClass = 'btn-danger',
    countdownSeconds = 3
}) {
    const html = `
        <p style="margin:12px 0;font-size:16px;">${message}</p>
        <div class="delete-countdown">
            <span class="label">倒计时 </span>
            <span class="seconds" id="countdown-number">${countdownSeconds}</span>
            <span class="label"> 秒</span>
        </div>
    `;

    const { panel, close } = createModal({
        title,
        content: html,
        buttons: [
            { label: '取消', className: 'btn', callback: () => { close(); if (onCancel) onCancel(); } },
            { label: confirmLabel, className: `btn ${confirmClass}`, disabled: true, callback: () => {
                close();
                if (onConfirm) onConfirm();
            }}
        ],
        closeOnOverlay: false,
        closeOnEscape: false,
    });

    let countdown = countdownSeconds;
    const numberEl = panel.querySelector('#countdown-number');
    let okBtn = panel.querySelector(`.btn-row .${confirmClass}`);
    let cancelBtn = panel.querySelector('.btn-row .btn:not(.btn-danger):not(.btn-warning)');

    const newCancelBtn = cancelBtn.cloneNode(true);
    cancelBtn.parentNode.replaceChild(newCancelBtn, cancelBtn);
    const newOkBtn = okBtn.cloneNode(true);
    okBtn.parentNode.replaceChild(newOkBtn, okBtn);
    okBtn = newOkBtn;
    cancelBtn = newCancelBtn;

    const timer = setInterval(() => {
        countdown--;
        if (countdown <= 0) {
            clearInterval(timer);
            numberEl.textContent = '0';
            okBtn.disabled = false;
        } else {
            numberEl.textContent = countdown;
        }
    }, 1000);

    cancelBtn.addEventListener('click', () => {
        clearInterval(timer);
        close();
        if (onCancel) onCancel();
    });

    okBtn.addEventListener('click', () => {
        if (!okBtn.disabled) {
            clearInterval(timer);
            close();
            if (onConfirm) onConfirm();
        }
    });
}

// ================================================================
// 倒计时删除确认（简单版本）
// ================================================================
export function showDeleteConfirm(title, message, callback) {
    createCountdownConfirm({
        title,
        message,
        onConfirm: () => callback(true),
        onCancel: () => callback(false),
        confirmLabel: '确定',
        confirmClass: 'btn-danger'
    });
}

// ================================================================
// 带 Context 的倒计时删除确认（用于快照模式）
// ================================================================
export function showDeleteConfirmWithContext(title, message, onConfirm, onCancel = null) {
    createCountdownConfirm({
        title,
        message,
        onConfirm: onConfirm,
        onCancel: onCancel,
        confirmLabel: '确定',
        confirmClass: 'btn-danger'
    });
}

// ================================================================
// 操作异常确认（带倒计时）
// ================================================================
export function showOperationConfirmWithCountdown(anomalies, callback) {
    if (!anomalies || anomalies.length === 0) {
        callback(true);
        return;
    }

    const MAX_DISPLAY = 5;
    const total = anomalies.length;
    let displayItems = anomalies.slice(0, MAX_DISPLAY);
    let extraHtml = '';

    if (total > MAX_DISPLAY) {
        extraHtml = `<li style="color:#64748b; font-style:italic; list-style-type:none; text-align:center; padding-top:4px; border-top:1px solid #eef2f6; margin-top:4px;">（仅显示前 ${MAX_DISPLAY} 项，共 ${total} 项异常）</li>`;
    }

    const listHtml = displayItems.map((msg, i) => `<li>${escapeHtml(msg)}</li>`).join('') + extraHtml;

    const html = `
        <p style="margin:12px 0;font-size:16px;color:#475569;">本次操作的异常：</p>
        <ul style="margin:8px 0 16px 20px;font-size:15px;color:#b91c1c;list-style-type:decimal; ${total > MAX_DISPLAY ? 'max-height:300px;overflow-y:auto;' : ''}">${listHtml}</ul>
        <p style="margin:8px 0;font-size:15px;font-weight:500;">确定要这样操作吗？</p>
        <div class="delete-countdown" style="color:#000;">
            <span class="label">倒计时 </span>
            <span class="seconds" id="countdown-number">3</span>
            <span class="label"> 秒</span>
        </div>
    `;

    const { panel, close } = createModal({
        title: '⚠️ 操作异常确认',
        content: html,
        buttons: [
            { label: '取消', className: 'btn', callback: () => { close(); callback(false); } },
            { label: '确定', className: 'btn btn-warning', disabled: true, callback: () => { close(); callback(true); } }
        ],
        closeOnOverlay: false,
        closeOnEscape: false,
    });

    let countdown = 3;
    let okBtn = panel.querySelector('.btn-row .btn-warning');
    let cancelBtn = panel.querySelector('.btn-row .btn:not(.btn-warning)');

    const newCancelBtn = cancelBtn.cloneNode(true);
    cancelBtn.parentNode.replaceChild(newCancelBtn, cancelBtn);
    const newOkBtn = okBtn.cloneNode(true);
    okBtn.parentNode.replaceChild(newOkBtn, okBtn);
    okBtn = newOkBtn;
    cancelBtn = newCancelBtn;

    const timer = setInterval(() => {
        countdown--;
        const numberEl = panel.querySelector('#countdown-number');
        if (!numberEl) return;
        if (countdown <= 0) {
            clearInterval(timer);
            numberEl.textContent = '0';
            okBtn.disabled = false;
        } else {
            numberEl.textContent = countdown;
        }
    }, 1000);

    cancelBtn.addEventListener('click', () => {
        clearInterval(timer);
        close();
        callback(false);
    });

    okBtn.addEventListener('click', () => {
        if (!okBtn.disabled) {
            clearInterval(timer);
            close();
            callback(true);
        }
    });
}

// ================================================================
// 异常确认 Promise 版本
// ================================================================
export function confirmAnomalies(anomalies) {
    return new Promise((resolve) => {
        if (!anomalies || anomalies.length === 0) {
            resolve(true);
            return;
        }
        showOperationConfirmWithCountdown(anomalies, resolve);
    });
}