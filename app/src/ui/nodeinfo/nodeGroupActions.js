// ================================================================
// 「跳到树上」的**动作**（ui/nodeinfo/nodeGroupActions.js）
//
// 职责：把带 `data-reveal-node` 的按钮接到"跳树"上。
//
// 为什么单开一个文件：`nodeGroup.js` 是**纯的**（只出 HTML 字符串，不碰 document），
// 这样它的渲染能在纯 Node 里单测 —— 与 `sourcePanel.js` / `sourceActions.js`
// 同一套分工。动作与委托监听都放这里。
//
// 为什么用"委托式"监听（在 document 上听一次，同 `sourceActions.js`）：
// 面板 HTML 是字符串拼出来的，插在节点详页与「所在组」两处；在每个宿主里各挂一次
// 迟早会漏，委托一次就解决。模块被 import 时执行一次，ESM 只执行一次 ⇒ 幂等。
//
// ⚠️ **跳树只有一条路**：派发 `EVENTS.REVEAL_NODE`，由 `ui/revealNode.js` 负责
//    切分页 / 切显示模式 / 展开祖先 / 翻页 / 滚动高亮。这里不 import `ui/tabs.js`
//    （那会和 `tabs → nodeInfoView` 绕成环），也不自己写展开逻辑。
// ================================================================
// 写一次数据走**共用那一份**（`ui/kit/actions.js` 的 `runWrite`：execute 事务 + 全局刷新信号）
// ★ 「派发 REVEAL_NODE」那**唯一一句话**也在那儿（`revealNodeById`）—— 这里只负责
//   "文档级委托把点击接到它上面"，别在本文件再写一遍 `document.dispatchEvent(...)`
//   （判重页那份兼容委托也走同一个函数，见 `ui/dedup/kit.js:wireGotoLinks`）。
import { runWrite, revealNodeById } from '../kit/actions.js';
import { AppState } from '../../shell/state.js';
// 「取消确认」这件事**只有一处实现**（core/ops 是唯一的写入口：UI 不自己拼写操作）
// —— 连同"这一场有哪些已确认的题目组"那条只读判据
import { unconfirmProblems, confirmedProblemKeys, SYNTH_KEY_FIELD } from '../../core/ops/synth.js';

// ⚠️ `revealNodeById` 的家已经搬到 `ui/kit/actions.js`（唯一一份"派发"）。
//    这里**原样再导出**：`docs/node-navigation.md` 与别处的调用点照旧按这个名字找它。
export { revealNodeById };

// ---- 「跳到树上」的**文档级**委托（`data-reveal-node`）----
//
// ★ 这是**全局唯一一条**跳转委托：谁（`ui/` 还是插件）只要把 `data-reveal-node="<主树节点 id>"`
//   放在元素上，点它就会跳，**不需要调用方挂任何监听**。
// ⚠️ 别在别处再挂一份局部委托（`features/AutoImport/ui/summary.js` 以前就多挂了一份，
//    同一次点击派发**两颗** `REVEAL_NODE` —— G8）。要挂也请先看 `docs/node-navigation.md`。
document.addEventListener('click', event => {
    const target = event.target;
    const btn = target && typeof target.closest === 'function'
        ? target.closest('[data-reveal-node]') : null;
    if (!btn) return;
    // ⚠️ 别在 handle 里放"局部委托也认的"东西：这一条不 `stopPropagation`
    //   （它要在 document 上兜住全文档），所以**同一次点击只许有一条委托派发**。
    event.preventDefault();
    revealNodeById(btn.getAttribute('data-reveal-node'));
});

// ================================================================
// 「取消确认标记」（组头详页那一行，HTML 由 `nodeGroup.js` 的 `confirmRowHtml` 出）
//
// 与「跳树」同一套委托式监听（理由同文件头）：按钮是字符串拼出来的，
// 挂在详页里，宿主重画一次就换一个新的 ⇒ 在 document 上听一次。
//
// ⚠️ 只**清标记**：绑定、题名、成员指针一个字都不动
//    （"撤销确认"不是"撤销绑定"）—— 下一次建包时脚本按题名重新算这一组。
//
// ⚠️ 两个入口、**同一件事**（都走 `core/ops/synth.js` 的 `unconfirmProblems`）：
//    · `data-unconfirm-head`    = 题目组头那一页 ⇒ 撤**这一组**；
//    · `data-unconfirm-contest` = 场次组头那一页 ⇒ 撤**这一场所有题目组**
//      （人当初就是按场确认的：⑤ 那个按钮写的是「✓ 确认这一场」）。
// ================================================================
document.addEventListener('click', event => {
    const target = event.target;
    const closest = (sel) => (target && typeof target.closest === 'function')
        ? target.closest(sel) : null;
    const one = closest('[data-unconfirm-head]');
    const whole = closest('[data-unconfirm-contest]');
    if (!one && !whole) return;
    event.preventDefault();
    const nodes = AppState.nodes || {};
    const nameOf = (n) => String((n && n.name) || '').trim();
    let keys = [];
    let what = '';
    if (one) {
        const node = nodes[String(one.getAttribute('data-unconfirm-head') || '').trim()];
        if (!node) return;                       // 节点没了（面板是旧的）⇒ 什么都不写
        keys = [String(node[SYNTH_KEY_FIELD] || '').trim()].filter(Boolean);
        what = `「${nameOf(node) || '这一组'}」`;
    } else {
        const head = nodes[String(whole.getAttribute('data-unconfirm-contest') || '').trim()];
        if (!head) return;
        // ⚠️ 名单**现算**（不信 DOM 上那份）：面板可能是上一帧画的
        keys = confirmedProblemKeys(AppState, head[SYNTH_KEY_FIELD]);
        what = `「${nameOf(head) || '这一场'}」的 ${keys.length} 个题目组`;
    }
    if (!keys.length) return;
    const r = runWrite((draft) => { unconfirmProblems(draft, keys); },
        `已取消 ${what} 的确认标记（重新建包后，脚本不再为它们保住手改的题名）`);
    // ⚠️ `runWrite` 是**异步**的（execute 返回 Promise）：失败时它自己弹错，
    //    这里只负责把拒绝吞掉（否则控制台一条 unhandled rejection）。
    if (r && typeof r.catch === 'function') r.catch(() => {});
});
