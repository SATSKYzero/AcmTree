// ================================================================
// 全局状态容器（shell/state.js）
// 职责：持有 AppState 单例，提供整体替换能力
// 依赖：core/model/state.js, core/model/viewState.js, immer
// 说明：
//   AppState 是容器对象，引用永久稳定
//   loadData 后用 replaceState 整体替换其字段
//   关闭 Immer autoFreeze，避免 base state 被冻结导致 applyState 无法赋值
// ================================================================
import { setAutoFreeze } from 'immer';
import { createInitialState, freezeNodes } from '../core/model/state.js';
import { applyView } from '../core/model/viewState.js';

setAutoFreeze(false);

export const AppState = createInitialState();

/**
 * 整体替换 AppState 的字段（引用不变）
 * 用于 loadData 后回填磁盘数据
 *
 * ⚠️ **不许"先把所有键删掉再 assign"**（会造成 400ms 级性能坑）：
 *    `for (const k of Object.keys(AppState)) delete AppState[k]` 会把 V8 里这个对象
 *    打成**字典模式**（dictionary mode）—— 之后**每一次** `produce(AppState, …)`
 *    都要多花约 **400ms**（真实包 27k 节点实测：改 `meta` 一个键 423ms，同样的数据放进
 *    普通字面量对象 **0ms**；改 `nodes` 里一个节点 28ms）。"相当多操作 1s 以上"
 *    主要就是这一笔。
 *    ⇒ 按**同一份键序**逐键赋值（键集合本来就稳定 ⇒ 形状不变）；只在真的多出键时才删
 *    （例如包带来的 `reports`），那是**加键**，代价只有一次隐藏类迁移，不是字典模式。
 */
export function replaceState(newState) {
    for (const k of Object.keys(newState)) AppState[k] = newState[k];
    for (const k of Object.keys(AppState)) {
        if (!Object.prototype.hasOwnProperty.call(newState, k)) delete AppState[k];
    }
    // 折叠状态**只住在本地缓存**：整体替换之后立刻贴回来，
    // 于是"导入整包"与"关闭再启动"都不会把用户的展开/收起姿势冲掉。
    // ⚠️ 顺序要紧：`applyView` 是**就地改**节点（写 `expanded`），必须在**冻结之前**跑
    //（冻结见 `core/model/state.js` 的 `freezeNodes`）。
    applyView(AppState);
    freezeNodes(AppState);
}