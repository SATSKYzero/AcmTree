// ================================================================
// 节点信息大界面：**✏️ 编辑**（ui/nodeinfo/nodeEdit.js）
//
// 与「📋 完整字段表」并列的一个子页：字段表是**观察**（每个来源原值都摊开），
// 这里是**动手改**（改完就落一条 `manual` 来源值）。
//
// 为什么不做第二套编辑模型：
//   · 字段清单/控件/校验/冲突确认/写库**全部复用** `ui/G_modal/editForm.js`
//     （编辑弹窗 G4_edit 用的就是它，同一份描述、同一个渲染器）；
//   · 控件的 id 仍是 `field-<key>` ⇒ `manualInput.js` 的"用户敲过这个字段"
//     自动认得出，手改留痕与弹窗**完全同一条规则**；
//   · 写库只走 ops（`applyEdit` 里是 `updateP/updateR/updateWS`），
//     只读守卫与账户范围都在 ops 内部，这里不碰 `AppState.nodes[...]`。
//
// 刷新：保存后由 `execute` 派发 `UI_REFRESH_REQUIRED`，`ui/tabs.js` 会重画
// 打开着的节点信息界面（本子页会被重新 mount 成新值）—— 不另造刷新机制。
//
// 依赖：G_modal/editForm.js（字段与提交）, G_modal/G2_common.js（控件渲染与读值）,
//       G_modal/manualInput.js（手改会话）, G_modal/G1_toast.js（提示）
// ================================================================
import { renderEditFieldsHtml, readEditValues, wireDependentFields } from '../G_modal/G2_common.js';
import { buildEditForm, validateEdit, confirmEditAnomalies, applyEdit } from '../G_modal/editForm.js';
import { beginInputSession } from '../G_modal/manualInput.js';
import { showToast } from '../G_modal/G1_toast.js';

/** 字段区容器的 id（读值要用它做作用域，免得读到别的界面上的同名控件） */
const FIELDS_BOX_ID = 'ni-edit-fields';

/**
 * 生成编辑页的 HTML（纯函数：只吃 node，不吃 DOM —— 冒烟测试直接断言它）。
 *
 * @param {Object} node
 * @returns {string}
 */
export function renderNodeEditHtml(node) {
    if (!node) return '<div style="padding:8px;color:#94a3b8;">(节点不存在)</div>';
    const { type, fields, extFields } = buildEditForm(node);
    const all = [...fields, ...extFields];
    if (!all.length) {
        return '<div class="nodeinfo-edit" style="padding:8px;color:#64748b;">'
            + `这个节点类型（${escapeText(type)}）没有可编辑的字段。</div>`;
    }
    return '<div class="nodeinfo-edit">'
        + '<div style="font-size:12px;color:#64748b;font-weight:600;margin-bottom:6px;">'
        + `编辑（${escapeText(type)} 节点 · 与编辑弹窗同一套字段与规则 · 保存即手改留痕）</div>`
        + `<div id="${FIELDS_BOX_ID}">${renderEditFieldsHtml(all)}</div>`
        + '<div style="margin-top:10px;"><button class="btn btn-primary" id="ni-edit-save">保存</button></div>'
        + '</div>';
}

/** 只用于上面那两处文字（字段控件的转义由 `renderEditFieldsHtml` 负责） */
function escapeText(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 挂载：把表单画进本界面的编辑容器，并绑「保存」。
 *
 * ⚠️ 每次 mount 都开一次**新的输入会话**（`beginInputSession`）：只有在这一页里
 * 敲过字的字段才算手改 —— 与弹窗打开时清空是同一个道理（见 manualInput.js）。
 *
 * @param {Object} ctx - 节点信息界面的视图上下文（`nodeInfoView.buildNodeViewContext`）
 */
export function mountNodeEdit(ctx) {
    const host = ctx && ctx.editContainer;
    if (!host) return;
    host.style.display = 'block';
    if (ctx.treeBody) ctx.treeBody.style.display = 'none';
    if (ctx.statsContainer) ctx.statsContainer.style.display = 'none';

    beginInputSession();
    host.innerHTML = renderNodeEditHtml(ctx.node);

    const node = ctx.node;
    const btn = host.querySelector('#ni-edit-save');
    if (!btn || !node) return;
    const { fields, extFields } = buildEditForm(node);
    const all = [...fields, ...extFields];
    // 选项依赖别的字段的下拉（小类 vs 大类）要在**插入 DOM 之后**接线
    wireDependentFields(host.querySelector(`#${FIELDS_BOX_ID}`), all);

    btn.addEventListener('click', async () => {
        const box = host.querySelector(`#${FIELDS_BOX_ID}`);
        const read = readEditValues(box, all);
        if (!read.ok) { showToast(read.error, 'error'); return; }
        const check = validateEdit(node.id, read.values);
        if (!check.ok) { showToast(check.error, 'error'); return; }
        // 与编辑弹窗**同一条顺序**：先确认冲突/同名，再写库
        //（`applyEdit` 的契约就是"假定已经确认过"，所以这一步不能漏）
        const confirm = await confirmEditAnomalies(node.id, read.values);
        if (!confirm.ok) {
            if (confirm.error !== '用户取消') showToast(confirm.error || '无法保存', 'error');
            return;                       // 取消/不通过 ⇒ 保留表单，不写库
        }

        btn.disabled = true;
        const res = await applyEdit(node.id, read.values);
        btn.disabled = false;
        if (res.success) {
            // 合成标识改了 ⇒ 把"后果"说出来（同一个事务里改写了 N 个成员指针）。
            // 拿不到 N 就不提数字，只说改了标识 —— 宁可不细，也不能报错数。
            const s = res.synth;
            showToast(s
                ? `已保存：合成标识 ${s.from} → ${s.to}，同时改写了 ${s.moved} 个成员的指针`
                : '已保存（并记了一条手改值）', 'success');
        } else if (res.error !== '用户取消') {
            showToast(res.error || '保存失败', 'error');
        }
    });
}
