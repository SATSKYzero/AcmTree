// ================================================================
// 添加：根节点、子节点（ui/G_modal/G4_add.js）
// 职责：添加根节点、子节点的表单交互 + 事务提交
// 依赖：shell/state.js, shell/executor.js, core/ops/tree.js,
//       core/ops/synth.js, core/autoCompute.js, core/validate/conflict.js,
//       utils/A_helpers.js, A_constants.js,
//       G1_core.js, G1_toast.js, G2_common.js, G2_selector.js
//
// 选完类型之后多问**一句**「标记为合成节点？」（`askSynthOption`）。
//   · 勾上 ⇒ 接着填名称 / 合成标识（`showAddSynthForm`），最后走
//     `createSynthNode` 建一个**普通节点 + 合成标识**（不是父子关系，
//     也不是第二套节点模型）。类型 / 父节点仍走既有那套选择。
//   · 不勾 ⇒ 走 `showAddChildForm`（普通节点那份表单与默认值）。
//   · 合成标识：默认自动（`synth:` 保留前缀由 core/ops/synth.js 分配），
//     用户也可以当场手填 —— 判重页「改合成标识」能改到的，这里就能填到。
//   · W/S/O 在 core 侧**根本不允许**合成（`core/ops/synth.js` 的 `SYNTH_TYPES`）：
//     这里把开关**禁用**并写明理由，而不是让用户勾了之后在提交时失败
//     （口径：别静默失败）。
//   · 类型特有的字段（题号 / 链接 / 比赛时间 / 提交时间与状态）复用
//     `G2_common.renderEditFieldsHtml` / `readEditValues` 那**唯一一套**控件与读值，
//     保证与既有弹窗同规则（`time` 的归一化就在 `readEditValues` 里）。
// ================================================================
import { AppState } from '../../shell/state.js';
import { execute } from '../../shell/executor.js';
import { addRoot, addChild, getNextProblemId } from '../../core/ops/tree.js';
import { collectPNodeConflicts } from '../../core/validate/conflict.js';
import { createSynthNode, SYNTH_TYPES, synthKeyOf } from '../../core/ops/synth.js';
import { updateP, updateR, updateWS } from '../../core/ops/node.js';
import { getNowStr, normalizeTime } from '../../utils/A_helpers.js';
import { STATUS_OPTIONS } from '../../A_constants.js';
import { createModal } from './G1_core.js';
import { showToast } from './G1_toast.js';
import {
    showFormDialog, confirmAnomalies,
    renderEditFieldsHtml, readEditValues
} from './G2_common.js';
import { showTypeSelector } from './G2_selector.js';
import { beginInputSession } from './manualInput.js';

import { TYPE_CHILDREN_MAP } from '../../core/model/constants.js';

// ---- 提交事务并回读节点 ----
async function commitAdd(operation) {
    let newNodeId = null;
    await execute((draft) => {
        const node = operation(draft);
        newNodeId = node.id;
    });
    return AppState.nodes[newNodeId];
}

// ================================================================
// 添加根节点
// ================================================================
export function promptAddRoot() {
    return new Promise((resolve) => {
        showTypeSelector(['W', 'S'], (type) => {
            if (!type) {
                resolve({ success: false, error: '用户取消选择类型' });
                return;
            }

            // ★ 名称与链接**一步问完**（用户 2026-10-14："添加节点的填名字与链接可以合并为一步"）。
            //   以前是两个 prompt 串着弹：白让人多点一次，而且"后一步取消"那段语义还容易写错
            //   （`v9.3.4` 之前那版就是：取消被当成"留空"，节点照样建出来）。
            addNodeForm('添加根节点', { nameDefault: '新节点' }, async (res) => {
                if (!res) { resolve({ success: false, error: '用户取消' }); return; }
                try {
                    const node = await commitAdd((draft) =>
                        addRoot(draft, type, String(res.name || '').trim(), { link: res.link || '' })
                    );
                    resolve({ success: true, node });
                } catch (err) {
                    resolve({ success: false, error: err.message });
                }
            });
        });
    });
}

/** 「名称 + 链接」这一步的**唯一一份**写法（根节点 / 子节点 W・S 共用；C 另加时间字段） */
function addNodeForm(title, { nameDefault, extraFields = [] } = {}, done) {
    showFormDialog(title, [
        { key: 'name', label: '名称', type: 'text', default: nameDefault || '新节点' },
        ...extraFields,
        { key: 'link', label: '链接（可选）', type: 'text', default: '' }
    ], done, (values) => {
        // 名称非空**在关框前**校验：不过就别关（用户敲的东西一个字不改，与编辑节点同款）
        if (!String(values.name || '').trim()) return { ok: false, error: '名称不能为空' };
        return { ok: true };
    });
}

// ================================================================
// 添加子节点
// ================================================================
export function promptAddChild(parentId, quick = false) {
    return new Promise((resolve) => {
        const parent = AppState.nodes[parentId];
        if (!parent) {
            resolve({ success: false, error: '父节点不存在' });
            return;
        }

        const available = TYPE_CHILDREN_MAP[parent.type] || [];
        if (!available.length) {
            resolve({ success: false, error: '此节点不允许添加子节点' });
            return;
        }

        if (quick) {
            showAddChildForm(parentId, available[0], parent, resolve);
            return;
        }

        showTypeSelector(available, (selectedType) => {
            if (!selectedType) {
                resolve({ success: false, error: '用户取消选择类型' });
                return;
            }
            // 「标记为合成节点」这一步接在**既有流程**里：先选类型，再问合不合成。
            // 不勾 ⇒ 落回 `showAddChildForm`。
            askSynthOption(selectedType, (synth) => {
                if (synth === null) {
                    resolve({ success: false, error: '用户取消' });
                    return;
                }
                if (!synth) {
                    showAddChildForm(parentId, selectedType, parent, resolve);
                    return;
                }
                showAddSynthForm(parentId, selectedType, parent, resolve);
            });
        });
    });
}

// ================================================================
// 各类型表单（**非合成**：普通节点路径）
// ================================================================

function showAddChildForm(parentId, type, parent, resolve) {
    // ---- R：提交记录 ----
    if (type === 'R') {
        showFormDialog('添加提交记录', [
            { key: 'time', label: '提交时间 (YYYY.MM.DD HH:MM 或 YYYY.MM.DD HH:MM:SS)', type: 'text', default: getNowStr() },
            { key: 'status', label: '评测结果', type: 'select', options: STATUS_OPTIONS, default: '-' },
            { key: 'link', label: '链接', type: 'text', default: '' }
        ], async (res) => {
            // ★ 表单取消 ⇒ `res === null`（`showFormDialog` 的约定）⇒ 整个添加中止
            if (!res) {
                resolve({ success: false, error: '用户取消' });
                return;
            }
            try {
                const node = await commitAdd((draft) =>
                    addChild(draft, parentId, 'R', '', {
                        time: res.time,
                        status: res.status,
                        link: res.link
                    })
                );
                resolve({ success: true, node });
            } catch (err) {
                resolve({ success: false, error: err.message });
            }
        });
        return;
    }

    // ---- P：题目 ----
    if (type === 'P') {
        const defaultProblemId = (parent.type === 'C')
            ? getNextProblemId(AppState, parentId)
            : '';

        showFormDialog('添加题目', [
            { key: 'problemId', label: '题号', type: 'text', default: defaultProblemId },
            { key: 'name', label: '题目名称', type: 'text', default: '新题目' }
        ], async (res) => {
            // ★ 表单取消 ⇒ `res === null` ⇒ 整个添加中止（别让 `res.name` 抛错、也别继续建节点）
            if (!res) {
                resolve({ success: false, error: '用户取消' });
                return;
            }
            const name = res.name.trim();
            const problemId = res.problemId.trim() || defaultProblemId;
            if (!name) {
                resolve({ success: false, error: '名称不能为空' });
                return;
            }

            const anomalies = collectPNodeConflicts(AppState, parentId, name, problemId, null);
            if (anomalies.length > 0) {
                const confirmed = await confirmAnomalies(anomalies);
                if (!confirmed) {
                    resolve({ success: false, error: '用户取消' });
                    return;
                }
            }

            try {
                const node = await commitAdd((draft) =>
                    addChild(draft, parentId, 'P', name, { problemId })
                );
                resolve({ success: true, node });
            } catch (err) {
                resolve({ success: false, error: err.message });
            }
        });
        return;
    }

    // ---- C：比赛 ----
    if (type === 'C') {
        // ★ 名称 / 链接 / 比赛时间 **一步问完**（用户 2026-10-14："步骤合并"）。
        //   以前先弹一个「请输入比赛名称」的 prompt、再弹一个**也有名称字段**的表单 —— 同一个信息问了两次。
        addNodeForm('添加比赛', {
            nameDefault: '新比赛',
            extraFields: [{ key: 'contestTime', label: '比赛时间（可选，支持 12位/14位 数字）', type: 'text', default: '' }]
        }, async (res) => {
            if (!res) { resolve({ success: false, error: '用户取消' }); return; }
            const finalName = String(res.name || '').trim();
            const timeResult = normalizeTime(res.contestTime);
            if (!timeResult.valid) {
                resolve({ success: false, error: timeResult.reason || '时间格式无效' });
                return;
            }
            const contestTime = timeResult.isEmpty ? '' : timeResult.value;
            try {
                const node = await commitAdd((draft) =>
                    addChild(draft, parentId, 'C', finalName, {
                        link: res.link || '',
                        contestTime
                    })
                );
                resolve({ success: true, node });
            } catch (err) {
                resolve({ success: false, error: err.message });
            }
        });
        return;
    }

    // ---- W / S：平台/系列 ----
    // ★ 名称与链接一步问完（同「添加根节点」那段：以前两个 prompt 串着弹）
    addNodeForm('添加子节点', { nameDefault: '新节点' }, async (res) => {
        if (!res) { resolve({ success: false, error: '用户取消' }); return; }
        try {
            const node = await commitAdd((draft) =>
                addChild(draft, parentId, type, String(res.name || '').trim(), { link: res.link || '' })
            );
            resolve({ success: true, node });
        } catch (err) {
            resolve({ success: false, error: err.message });
        }
    });
}

// ================================================================
// 手建合成节点（选完类型之后多问一句「标记为合成节点？」）
//
// ⚠️ 这里**只调用** `core/ops/synth.js` 的导出，不重造标识分配 / 校验：
//    `createSynthNode` 自己管「类型 ∈ SYNTH_TYPES」「父节点允许的子类型
//    （TYPE_CHILDREN_MAP）」「标识不重复（isSynthKeyTaken）」「保留前缀 synth:」。
// ================================================================

/** 复选框 / 标识输入框 / 名称输入框的 id（只在本模块用；同一时刻只开一个弹窗） */
const SYNTH_CHECK_ID = 'add-synth-check';
const SYNTH_KEY_INPUT_ID = 'add-synth-key';
const SYNTH_NAME_INPUT_ID = 'add-synth-name';

/**
 * 这一句问话的控件 HTML。
 *
 * ⚠️ 复选框 MUST 读 `.checked`（不是 `.value`）：浏览器里勾选框的 `value` 恒为 `"on"`。
 * ⚠️ 这三个输入框**故意不加** `field-` 前缀 —— 那个前缀是 `manualInput.js`
 *    "用户敲过这个业务字段"的登记键（见 `fieldOfElement`），`synthKey` 不参与
 *    值级来源 / 手改留痕，别让它污染那份判据。
 */
function synthAskHtml(allowSynth) {
    const boxAttrs = allowSynth ? '' : ' disabled';
    return `
        <div style="font-size:12px;color:#64748b;line-height:1.7;margin:4px 0 8px;">
            合成节点在树上就是一个<b>普通节点</b>，只是多一个身份「合成标识」；
            成员靠<b>「所属合成节点」指针</b>归入它，<b>不是父子关系</b>。
        </div>
        <label style="display:block;margin:4px 0;">
            <input type="checkbox" id="${SYNTH_CHECK_ID}"${boxAttrs} style="margin-right:6px;">
            标记为合成节点
        </label>
        ${allowSynth ? '' : '<div class="add-synth-blocked" style="font-size:12px;color:#b45309;margin-bottom:4px;">W / S / O 不参与合成，所以这个开关在这里是禁用的（合成只在 C / P / R 上做）。</div>'}
    `;
}

/** 读那个勾选（**只**读 `.checked`） */
function readSynthChecked(panel, allowSynth) {
    const box = panel.querySelector(`#${SYNTH_CHECK_ID}`);
    return allowSynth && !!(box && box.checked);
}

/**
 * 选完类型之后多问一句「标记为合成节点？」。
 *
 * 取消 = 连节点也不建了（与普通节点路径的「用户取消」同义），**不会**悄悄退回普通节点 ——
 * 用户按了取消却建出一个东西，是比多点一下更坏的体验。
 *
 * @param {string} type 已选类型（C/P/R 可勾；W/S/O 开关禁用）
 * @param {(synth:boolean|null) => void} next 取消 ⇒ null
 */
function askSynthOption(type, next) {
    const allowSynth = SYNTH_TYPES.includes(type);
    const { panel, close } = createModal({
        title: '新建节点',
        content: synthAskHtml(allowSynth),
        maxWidth: '550px',
        buttons: [
            { label: '取消', className: 'btn', callback: () => {
                close();
                next(null);
                return false;
            } },
            { label: '确定', className: 'btn btn-primary', callback: () => {
                const synth = readSynthChecked(panel, allowSynth);
                close();
                next(synth);
                return false;
            } }
        ]
    });
}

/**
 * 勾了「标记为合成节点」之后的表单：名称（可改）+ 合成标识（可改）+ 类型特有字段。
 *
 * 与 `showAddChildForm` 的普通节点路径**并存** —— 这里只在用户明确
 * 勾选时走；类型特有的字段仍与那条路径同款，只是最后一步换成 `createSynthNode`。
 * ⚠️ 标识留空 ⇒ 由 `createSynthNode` 自动分配（`synth:1`、`synth:2`…）；
 *    手填的标识**不许**以保留前缀 `synth:` 开头，也不许与已有合成节点重复 ——
 *    两条判断都在 core 里（这里不另判），失败时弹窗**不关**、原样弹错，
 *    用户敲进去的值一个字都不改（不静默替换）。
 *
 * @param {string} parentId
 * @param {string} type C / P / R 之一
 * @param {Object} parent
 * @param {Function} resolve
 */
function showAddSynthForm(parentId, type, parent, resolve) {
    const defaultProblemId = (type === 'P' && parent.type === 'C')
        ? getNextProblemId(AppState, parentId)
        : '';
    // 类型特有字段（键与默认值都与 `showAddChildForm` 同款；名称走上面那个公共输入框）
    let fields = [];
    if (type === 'P') {
        fields = [{ key: 'problemId', label: '题号', type: 'text', default: defaultProblemId }];
    } else if (type === 'C') {
        fields = [
            { key: 'link', label: '链接（可选）', type: 'text', default: '' },
            { key: 'contestTime', label: '比赛时间（可选，支持 12位/14位 数字）', type: 'text', default: '' }
        ];
    } else {
        // R：与普通节点路径一致，没有名称 / 链接字段（提交记录的身份是时间 + 状态）
        fields = [
            { key: 'time', label: '提交时间 (YYYY.MM.DD HH:MM 或 YYYY.MM.DD HH:MM:SS)', type: 'text', default: getNowStr() },
            { key: 'status', label: '评测结果', type: 'select', options: STATUS_OPTIONS, default: '-' },
            { key: 'link', label: '链接', type: 'text', default: '' }
        ];
    }
    const nameWanted = type !== 'R';
    const nameHtml = nameWanted ? `
        <label style="display:block;margin:4px 0;">名称（可改）
            <input type="text" id="${SYNTH_NAME_INPUT_ID}" value="合成" style="width:100%;padding:6px;border-radius:6px;border:1px solid #ccc;font-size:14px;margin-top:4px;">
        </label>` : '';
    const html = `
        <div style="font-size:12px;color:#64748b;line-height:1.7;margin:4px 0 8px;">
            给这个合成节点一个名字（例如「2026 浙江省赛（合成）」）；成员之后靠「所属合成节点」指针归入。
        </div>
        ${nameHtml}
        <label style="display:block;margin:4px 0;">合成标识（可改）
            <input type="text" id="${SYNTH_KEY_INPUT_ID}" value="" placeholder="留空 = 自动生成 synth:1、synth:2…" style="width:100%;padding:6px;border-radius:6px;border:1px solid #ccc;font-size:14px;margin-top:4px;">
        </label>
        <div style="font-size:12px;color:#94a3b8;margin-bottom:4px;">留空 = 由 core/ops/synth.js 自动分配。不许以保留前缀 synth: 开头，也不许与已有合成节点重复。</div>
        ${renderEditFieldsHtml(fields)}
    `;
    // ★ 新的一次弹窗输入会话（见 manualInput.js）：与 `showFormDialog` 同一处口径。
    //   漏了它，上一个弹窗里"用户敲过的字段"会漏到这一次，手改留痕就记到别处去了。
    beginInputSession();
    const { panel, close } = createModal({
        title: '新建合成节点',
        content: html,
        maxWidth: '550px',
        buttons: [
            { label: '取消', className: 'btn', callback: () => {
                close();
                resolve({ success: false, error: '用户取消' });
                return false;
            } },
            { label: '确定', className: 'btn btn-primary', callback: () => {
                const nameEl = panel.querySelector(`#${SYNTH_NAME_INPUT_ID}`);
                const keyEl = panel.querySelector(`#${SYNTH_KEY_INPUT_ID}`);
                const name = nameEl ? String(nameEl.value || '').trim() : '';
                const synthKey = keyEl ? String(keyEl.value || '').trim() : '';
                if (nameWanted && !name) {
                    showToast('名称不能为空', 'error');
                    return false;               // 校验不过就**别关**弹窗（同 showFormDialog）
                }
                const read = readEditValues(panel, fields);
                if (!read.ok) {
                    showToast(read.error, 'error');
                    return false;
                }
                // ⚠️ 这里**不预判**标识能不能用：唯一判据在 core（`isSynthKeyTaken` 等），
                //    预判就等于把同一套判断抄第二遍（本项目明令禁止）。落库失败 ⇒ 弹窗不关。
                commitSynth(parentId, type, defaultProblemId, { name, synthKey, data: read.values })
                    .then((result) => {
                        if (!result.success) {
                            showToast(result.error, 'error');
                            return;                 // 不关：用户填的值一个字都不改
                        }
                        close();
                        resolve(result);
                    });
                return false;
            } }
        ]
    });
}

/**
 * 真正落库：`createSynthNode`（**唯一**的合成节点写入口 —— 标识分配 / 保留前缀 /
 * 重复检测 / W-S-O 拒绝 / 父节点子类型约束全在它里面，这里一个字都不重造）。
 *
 * ⚠️ `createSynthNode` 只认 `synthKey` / `name` / `type`（别的键它**不发散**）。
 *    所以类型特有的字段（题号、链接、比赛时间、提交时间与状态）走**既有那套**
 *    字段写入口（`updateP` / `updateWS` / `updateR`）在**同一个事务**里补上 ——
 *    不自己往 draft 上写字段（那就绕过了手改留痕与校验，是第二套写入路径）。
 *
 * @returns {Promise<{success:boolean, node?:Object, synthKey?:string, error?:string}>}
 */
async function commitSynth(parentId, type, defaultProblemId, input) {
    try {
        const node = await commitAdd((draft) => {
            const created = createSynthNode(draft, parentId, {
                type,
                name: synthName(type, input),
                synthKey: input.synthKey
            });
            applySynthTypeFields(draft, created, type, defaultProblemId, input.data || {});
            return created;
        });
        return { success: true, node, synthKey: synthKeyOf(node) };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

/** 类型特有的字段（走既有字段写入口，与普通节点路径同规则、同留痕） */
function applySynthTypeFields(draft, node, type, defaultProblemId, data) {
    if (type === 'P') {
        const problemId = String(data.problemId === undefined ? '' : data.problemId).trim()
            || defaultProblemId;
        if (problemId) updateP(draft, node.id, { problemId });
        return;
    }
    if (type === 'C') {
        const timeResult = normalizeTime(data.contestTime || '');
        updateWS(draft, node.id, {
            link: data.link || '',
            contestTime: (timeResult.valid && !timeResult.isEmpty) ? timeResult.value : ''
        });
        return;
    }
    if (type === 'R') {
        updateR(draft, node.id, {
            time: data.time,
            status: data.status,
            link: data.link || ''
        });
    }
}

/** 合成节点的名字（R 与普通节点路径一致：名字为空；其余默认「合成」，可就地改） */
function synthName(type, input) {
    if (type === 'R') return '';
    return String(input.name || '').trim() || '合成';
}
