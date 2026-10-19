// ================================================================
// 通用的两个"动作"件（ui/kit/actions.js）
//
// 从 `ui/dedup/kit.js` 里搬出来的 —— 因为**每个页面**都要用它们
// （`ui/kit/report.js` 的模板就用这两个），而"共享模块反向 import 某个 feature"
// 是错的方向。`ui/dedup/kit.js` 仍然**原样再导出**它们，所以判重页那十几个文件
// 一行都不用改。
//
// 只放**与页面无关**的东西：跳树、写一次数据。判重页专用的（`reasonText` /
// `linkBlockOf` / `natureChipOption` …）留在那边。
// ================================================================
import { EVENTS } from '../../A_constants.js';
import { execute } from '../../shell/executor.js';
import { showToast } from '../G_modal/G_modals.js';
// 悬停提示也是给人看的字 ⇒ 统一去 Markdown 记号（实现只有一份）
import { plain } from '../../utils/text.js';

/**
 * 跳到某个节点在树上的位置 —— **全仓唯一的"派发"那一句**。
 *
 * 谁都可以用（`ui/nodeinfo/nodeGroupActions.js` 的文档级委托、判重页那份兼容委托…），
 * 但"派发哪一颗事件、事件里带什么"只在这里写一次
 * —— 各写一遍就会出现"有的地方事件名/字段写错"这种点不动（`EVENTS.REVEAL_NODE`
 *  + `detail.nodeId` 是 `ui/revealNode.js` 认的契约）。
 *
 * @param {string} nodeId - **主树真实节点 id**（副页页内 id 要先 `realNodeIdOf` 解析）
 * @returns {boolean} 空 id 不动、返回 false
 */
export function revealNodeById(nodeId) {
    const id = String(nodeId || '').trim();
    if (!id) return false;
    document.dispatchEvent(new CustomEvent(EVENTS.REVEAL_NODE, { detail: { nodeId: id } }));
    return true;
}

/**
 * 把**已有的**元素变成"跳到树上"的链接（不改它的文字，只加行为）。
 *
 * ★ **承载只有这一份**（`data-reveal-node`）：接住它的是
 *   `ui/nodeinfo/nodeGroupActions.js` 里那条**文档级** click 委托 —— 调用方
 *   **不需要挂任何监听**（插件也白拿，那一条是全局的）。
 *
 * ⚠️ `class="dedup-goto"` 与 `data-goto` 是**行为钩子**（判重页的兼容委托按它找、
 *    `scripts/smoke/dedup-synth.smoke.mjs` 按它断言）⇒ 搬文件/收敛时**不能改**。
 *    `data-goto` 现在只是兼容痕迹（`ui/dedup/kit.js:wireGotoLinks` 会读它兜底），
 *    **新代码一律只认 `data-reveal-node`**。
 *
 * @param {HTMLElement} el
 * @param {string} nodeId - **目标 id**：主树真实 id，或（`v9.0.19` 起）**副页页内 id**
 *   （`revealNode` 按归属分流）。解析不出归属的**不要**调它，如实当纯文本。
 * @param {string} [color]
 * @param {string} [title] - 悬停提示。默认那句说的是"在树上定位"——**副页页内定位要传自己的**
 *   （提示与实际行为必须一致：页内定位说成"树上"就是假话）。**别为此另写一个挂载函数。**
 */
export function markGoto(el, nodeId, color = '#1d4ed8', title = '在树上定位这个节点') {
    const id = String(nodeId || '');
    el.dataset.revealNode = id;          // ★ 唯一的承载
    el.dataset.goto = id;                // 兼容钩子（见上）
    el.classList.add('dedup-goto');      // 兼容钩子（见上）
    el.title = plain(title);
    el.style.cursor = 'pointer';
    el.style.color = color;
    return el;
}

/**
 * 写一次数据并刷新界面（所有动作共用；一切写操作都走 execute 事务）。
 *
 * `okMsg` 可以是字符串，也可以是 `(result) => string` —— 后者给"结果决定文案"的动作用
 * （合成节点的生成可能是**复用**而不是新建，两种说法的提示不该混为一谈）。
 */
export function runWrite(mutator, okMsg) {
    return execute(mutator, {
        refreshParentId: null,
        validate: false,
        onSuccess: (result) => {
            const msg = typeof okMsg === 'function' ? okMsg(result) : okMsg;
            if (msg) showToast(msg, 'info');
            // 走全局刷新信号：缓存作废、列表重画都由它带出来（见 tabs.js 的监听）
            document.dispatchEvent(new CustomEvent(EVENTS.UI_REFRESH_REQUIRED));
        },
        onError: (err) => {
            const msg = err && err.message ? err.message : String(err);
            showToast(`操作失败：${msg}`, 'error');
        }
    });
}
