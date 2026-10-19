// ================================================================
// 值级来源的**动作**（ui/G_modal/sourceActions.js）
//
// 职责：把来源面板上的按钮接到 core/ops/trust.js 的写操作上。
//
// 为什么用"委托式"监听（在 document 上听一次）
// -------------------------------------------
// 面板 HTML 是由 `sourcePanel.js` 拼出来的纯字符串，插在两个不同的弹窗里
// （P 弹窗自己拼、W/S/C 走 `showFormDialog` 的 `field.hint`）。若逐个弹窗各挂一次事件，
// 就得改两处、而且以后再加第三个入口还得记得挂 ——
// 委托一次就解决，且**不会漏**。
//
// 依赖：shell/executor.js（execute）, shell/state.js（AppState）,
//       core/ops/trust.js（三个动作）, G1_toast.js（提示）, sourcePanel.js（重绘）
// ================================================================
import { AppState } from '../../shell/state.js';
import { execute } from '../../shell/executor.js';
import { setFieldPrefer, clearFieldPrefer, markValueInvalid, removeSourceValue,
         setGroupPrefer, clearGroupPrefer } from '../../core/ops/trust.js';
import { assertManualEditAllowed } from '../../core/ops/account.js';
// 「转成所有人共用」：**动作与名单都在 core 里**（本文件只负责"问一句 + 如实反馈"）——
//   名单（`OBJECTIVE_PROMOTABLE_FIELDS`）在这里 import 是为了**重绘面板时与首次渲染一模一样**
//   （面板是纯字符串模块，自己 import 不了这条链：见 sourcePanel.js 的说明）。
import { promoteManualToObjective, OBJECTIVE_PROMOTABLE_FIELDS } from '../../core/ops/node.js';
import { buildSourcePanelHtml } from './sourcePanel.js';
import { viewValue } from '../../view/scope.js';
import { makeParentResolver } from '../../core/fieldRegistry.js';
import { showToast } from './G1_toast.js';
// 确认框用**仓里现成的那一个**（破坏性动作必须先问 —— 用户 2026-10-13："破坏是难免的"）
import { showConfirmDialog } from './G2_common.js';
import { escapeHtml } from '../../utils/html.js';

/** 按钮文案 */
const LABELS = {
    prefer: '以后用这个来源',
    clearPrefer: '取消这个字段的偏好',
    dump: '这个值不用了',
    remove: '把这条值真删掉'
};

function findButton(target) {
    return target && typeof target.closest === 'function'
        ? target.closest('[data-src-act]')
        : null;
}

/** 动作做完后，把那个字段的面板原地重绘（不用关掉弹窗） */
function refreshPanel(btn, node, field) {
    const panel = btn.closest('.src-details') || btn.closest('.src-note') || btn.parentElement;
    if (!panel || !panel.parentElement) return;
    const holder = document.createElement('div');
    holder.innerHTML = buildSourcePanelHtml(node, field, AppState.trust, {
        accounts: AppState.accounts,
        viewingAccount: AppState.viewingAccountId,
        // ★ 范围口径（要不要带上**直接子账户**）也要传 —— 重绘必须与首次渲染**逐字同口径**
        //   （`resolveScope` 从 `opts.settings` 读它；少了它就是"点了按钮口径就变了"，`v9.1.23`）
        settings: AppState.settings,
        currentAccount: AppState.currentAccountId,
        // 重绘要跟首次渲染**一模一样**（少了这几样，「应有/已有」那一行会消失或算错）
        registry: AppState.fieldRegistry,
        shownValue: (n, f) => viewValue(AppState, n, f),
        parentOf: makeParentResolver(AppState),
        // 同上：少了它，转完客观值之后「转成所有人共用」按钮会**留在原地**（首次渲染有、重绘没有）
        promoteFields: OBJECTIVE_PROMOTABLE_FIELDS
    });
    // ⚠️ **必须按类名取面板那一格，不许用 `holder.firstElementChild`**（2026-10-13 抓到的真 bug）：
    //    `buildSourcePanelHtml` 的返回值是 `expectLine + 面板` —— 而 `expectLine`
    //    （`<div class="src-expect">`：字段组 / 应有-已有 那一行）**排在面板前面**，
    //    且只要有 `registry` 就非空（真弹窗**就是**传了 registry 的）。
    //    ⇒ `firstElementChild` 拿到的是**那一行说明**，`replaceChild` 于是把来源面板
    //      **换成了说明行的一份副本**：症状 = 说明行出现**两份**、来源面板（优先/不用/真删）整块消失。
    //    为什么此前"复现不出来"：Node 夹具没传 `registry` ⇒ `noteText` 为空 ⇒ `firstElementChild` 正好是面板。
    // ⚠️ **分开查两个单类选择器，不许写成 `.src-note, .src-details`**：
    //    `scripts/smoke/dom.mjs` **不解析逗号选择器**（仓里已踩过：见 `src/ui/AGENTS.md` 的 📋 那条）
    //    ⇒ 合写的话冒烟里恒为 null、`if (fresh)` 直接跳过 ⇒ **改坏了也测不出来**（这条守卫就废了）。
    const fresh = holder.querySelector('.src-note') || holder.querySelector('.src-details');
    if (fresh) panel.parentElement.replaceChild(fresh, panel);
}

/**
 * 动作做完后，把弹窗里**那个字段的输入框**同步成重算后的值。
 *
 * ⚠️ 为什么必须有（实测 bug）
 * ---------------------------------------
 * `优先` / `不用` / `恢复` 只重绘了来源面板，**没碰字段控件**。于是
 * `AppState` 里值已经是新值了，弹窗里的 `#field-ratio` 还是旧值：
 *   ① 用户看到的是"我点了却没反应"（输入框没变）；
 *   ② 更糟的是接着点「确定」时，`G4_edit.js` / `showFormDialog` 取的是
 *      **输入框**的值 → 旧值被写回（`updateP` 还会把它记成一条 `manual` 来源），
 *      等于把刚设好的偏好悄悄抹掉。刷新后现象正是：偏好还在、理由也写着
 *      "你指定这个字段优先用 …"，值却变回去了。
 *
 * 只在"输入框内容 == 动作前的值"时才写：用户正在改的内容不抢
 * （控件不存在：面板也可能挂在没有输入框的地方，那就什么都不做）。
 *
 * ⚠️ 这里**故意不**做任何"这不是用户输入"的标记：反向判据（"没标记就算手改"）
 *   会出错 —— 只要输入框没被同步过，一个用户根本没碰的字段也会被记成手改
 *   （实测：点某个字段来源行的 优先，另一个字段的 `values` 里就顶替出一条 manual）。
 *   改由 `manualInput.js` 用**正向信号**（input 事件 = 用户真的敲了字）判定，
 *   而程序写 `el.value` 不会触发任何事件 —— 所以这里什么都不用标。
 *
 * @returns {boolean} 是否真的更新了控件
 */
function syncFieldControl(field, prevValue, node) {
    const el = document.getElementById(`field-${field}`);
    if (!el || !node) return false;
    const before = String(prevValue === undefined || prevValue === null ? '' : prevValue);
    if (String(el.value) !== before) return false;      // 用户已经改过 → 不覆盖他
    const raw = node[field];
    const next = String(raw === undefined || raw === null ? '' : raw);
    if (next === before) return false;                  // 值没变，不用动
    el.value = next;                                    // 程序赋值：不触发 input 事件
    return true;
}

/**
 * 「转成所有人共用」的**确认**（唯一一处文案）。
 *
 * ⚠️ 这个动作是**破坏性**的（用户认可："破坏是难免的"）：它按定义要删掉按账户的那些手改。
 *    所以先问一句 —— 用仓里现成的 `showConfirmDialog`，不新写弹窗。
 */
function confirmPromote(field) {
    return new Promise(resolve => {
        showConfirmDialog('转成所有人共用',
            `<div style="margin:12px 0;font-size:15px;">「${escapeHtml(field)}」的<b>按账户手改会被删掉</b>
             （撤销可还原），然后：</div>
             <div style="margin:8px 0;font-size:15px;line-height:1.9;">
             · 已经有「所有人共用」的值 ⇒ <b>不动它</b>，就用它；<br>
             · 没有 ⇒ 用<b>第一条按账户的值</b>建一条「所有人共用」的。</div>`,
            resolve);
    });
}

async function runAction(btn) {
    // ⚠️ `account` 必须一起取：手改值按账户各留一条，同一个 `src='manual'`
    //    在字段里可能同时有"我改的"和"队友改的" —— 不带账户就会命中别人那条。
    const { srcAct, field, src, value, node: nodeId, account } = btn.dataset;
    if (!field || !nodeId) return;
    const node = AppState.nodes[nodeId];
    if (!node) return;
    // 破坏性动作：**先确认，再进事务**（用户取消 ⇒ 一个字节都不动）
    if (srcAct === 'promote' && !(await confirmPromote(field))) return;
    // 动作前的缓存值：此刻弹窗里的输入框显示的就是它（用于判断该不该同步）
    const prevValue = node[field];

    let message = '';
    let failed = false;
    await execute(draft => {
        // `优先` / `不用` / `恢复` 会**重算并写回缓存字段**，
        // 也就是"以当前登录账户的名义改了这个字段的显示值" —— 所以它同样受只读边界约束。
        // （必须拦：在查看别人的账户时，点一下偏好就会把值改掉，且重算是按"在查看"
        //   的账户过滤的，面板与实际值会对不上。）
        assertManualEditAllowed(draft, '调整来源优先级');
        if (srcAct === 'prefer') {
            const r = setFieldPrefer(draft, field, src);
            message = r.ok
                ? `以后「${field}」优先用 ${src}（已重算 ${r.reprojected ? r.reprojected.changed : 0} 个值）`
                : (r.reason || '设置失败');
        } else if (srcAct === 'clear-prefer') {
            const r = clearFieldPrefer(draft, field);
            message = r.ok ? `已取消「${field}」的来源偏好` : (r.reason || '取消失败');
        } else if (srcAct === 'dump') {
            const r = markValueInvalid(draft, nodeId, field, src, value, true, account);
            message = r.ok
                ? `已把 ${src} 说的「${value}」标为不用（可再点一次恢复）`
                : (r.reason || '操作失败');
        } else if (srcAct === 'restore') {
            const r = markValueInvalid(draft, nodeId, field, src, value, false, account);
            message = r.ok ? `已恢复 ${src} 说的「${value}」` : (r.reason || '操作失败');
        } else if (srcAct === 'group-pick') {
            // **字段组**的显示口径快捷切换（注意数值难度可能有需要快捷切换所查看系列的需求）。
            //   ⚠️ 只改"显示哪个成员"，**不动任何来源的值**。
            const r = setGroupPrefer(draft, String(btn.dataset.group || ''), field);
            message = r.ok
                ? `「${btn.dataset.group}」以后显示 ${field} 的值（其它来源的值都还在）`
                : (r.reason || '切换失败');
        } else if (srcAct === 'group-clear') {
            const r = clearGroupPrefer(draft, String(btn.dataset.group || ''));
            message = r.ok ? '已取消这一组的显示偏好' : (r.reason || '取消失败');
        } else if (srcAct === 'promote') {
            // ★ 「转成所有人共用」：取第一条按账户的手改变成**客观**手改，其余按账户的条目消失。
            //   "取哪条 / 清哪些 / 客观已有就不动"全在 core（`promoteManualToObjective`），
            //   这里只把结果如实说出来（`converted:false` ⇒ 连原因一起说）。
            const r = promoteManualToObjective(draft, nodeId, field);
            if (r.converted) {
                message = r.keptObjective
                    ? `已经是所有人共用了（值「${r.value}」）；按账户的那几条手改已删掉`
                    : `已转成所有人共用：「${r.value}」（取自账户 ${r.from} 的那条）；按账户的手改已删掉`;
            } else {
                message = r.reason || '没能转成所有人共用';
                failed = true;
            }
        } else if (srcAct === 'remove') {
            // 「真删」：把这条值从来源层**移除**。界面只在本账户的手改值上给这个按钮
            //（`sourcePanel.js` 的 `isMyManual`）；删掉最后一条 ⇒ 字段回到默认值。
            const r = removeSourceValue(draft, nodeId, field, src, value, account);
            message = r.ok
                ? (r.cleared
                    ? `已删掉我手改的「${value}」—— 这个字段回到默认值（撤销可还原）`
                    : `已删掉我手改的「${value}」（撤销可还原）`)
                : (r.reason || '操作失败');
        }
        return true;
    });

    if (message) showToast(message, failed ? 'error' : 'success');
    // 用**执行后的**节点重绘（AppState 已被替换）
    const after = AppState.nodes[nodeId];
    if (after) {
        // 先把输入框同步到新值，再重绘面板 —— 面板与输入框都不能是旧值
        syncFieldControl(field, prevValue, after);
        refreshPanel(btn, after, field);
    }
}

/**
 * 注册委托监听（模块被 import 时执行一次）。
 * 幂等：重复 import 不会重复挂（ESM 模块只执行一次）。
 */
document.addEventListener('click', event => {
    const btn = findButton(event.target);
    if (!btn) return;
    event.preventDefault();      // 面板在 <label> 里，别让它把焦点挪到输入框
    event.stopPropagation();
    runAction(btn).catch(err => {
        console.error('来源动作失败:', err);
        showToast('操作失败：' + err.message, 'error');
    });
});

export { findButton, runAction, LABELS };
