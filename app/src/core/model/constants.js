// ================================================================
// 核心常量（core/model/constants.js）
// 职责：**只放核心模型自己的**常量（节点类型约束、时间占位、数据结构版本）
// 无依赖
//
// 注意：类型标签/徽章、status 文案、编辑模式、统计筛选模式这些是**应用级**常量，
// 单一来源在 `A_constants.js`（各抄一份就会漂移，所以别在这里重复）。
// ================================================================

// ---- 子节点类型约束（节点类型集合 = 这里的键，别再另抄一份名单） ----
export const TYPE_CHILDREN_MAP = {
    'O': ['W', 'S'],
    'W': ['S', 'W'],
    'S': ['C', 'S'],
    'C': ['P'],
    'P': ['R'],
    'R': []
};

/**
 * 「父容器类型不允许这个子节点」那**一句话**（判据 + 说法都在这里，**只有这一份**）。
 *
 * 为什么放在这：类型约束的真源就是上面那张表，说它违了什么也应当同处一源。
 * 消费者（**全都调它，不许自己拼一句**，否则同一个包在不同入口会有不同说法）：
 *   · 预览（`features/AutoImport/plan.js`）与合成节点那一侧（`plan/synthNodes.js`）；
 *   · 落地（`core/ops/upsert.js`）；
 *   · 产包侧合并（`scripts/crate-merge.mjs`）。
 *
 * ⚠️ **不带"标签"参数**：一旦有的入口传中文标签、有的传类型字母，同一个包就会看到两句话
 *    （实测踩到）。类型字母（`W` / `C`…）是这套约束的**公共词汇**，各入口一律用它。
 * ⚠️ 那句"中间要插一层"的提示**从表里推**（谁允许这个子类型），不是给 `W→C` 写死的特判
 *    —— 表一改，写死的那句就成了假话。
 *
 * @param {string} parentType 父容器的类型（`W`）
 * @param {string} childType  想挂上去的子节点类型（`C`）
 * @param {{parentKey?:string, childKey?:string, parentCol?:string}} [ctx] 显示用的键；
 *        `parentCol` = 父引用**写在哪一列**（`父extKey` / `父synthKey`）—— 有它时按
 *        `父synthKey = "…"（C 类型）` 说，让人一眼知道该去改哪一格（没传就只报类型 + 键）
 * @returns {string} 允许 ⇒ `''`；不允许 ⇒ 一句可直接行动的话
 */
export function badParentTypeMessage(parentType, childType, ctx = {}) {
    const allowed = TYPE_CHILDREN_MAP[parentType];
    if (!Array.isArray(allowed) || allowed.includes(childType)) return '';
    const pLabel = ctx.parentCol
        ? `${ctx.parentCol} = "${ctx.parentKey}"（${parentType} 类型）`
        : `${parentType}${ctx.parentKey ? `("${ctx.parentKey}")` : ''}`;
    const cLabel = `${childType}${ctx.childKey ? `("${ctx.childKey}")` : ''}`;
    // 中间那一层**从表里推**：允许放这个子类型的那些类型（`W` 下放 `C` ⇒ `S`）
    const via = allowed.filter((t) => (TYPE_CHILDREN_MAP[t] || []).includes(childType));
    const hint = via.length ? `　← 中间要插一层 ${via.join(' / ')}` : '';
    return `${pLabel} 下不允许 ${cLabel}：按类型层级只允许 `
        + `${allowed.length ? allowed.join(' / ') : '（没有子节点）'}，${childType} 不在其中`
        + `${hint}。处理：改挂到允许放这个类型的父容器下`
        + '（判据唯一一份：core/model/constants.js 的 TYPE_CHILDREN_MAP）';
}

// ---- 渲染模式 ----
export const DEFAULT_TREE_DISPLAY_MODE = 'tree';

// ---- 时间占位符 ----
export const TIME_PLACEHOLDER = '----.--.-- --:--';

// ---- 数据结构版本（**导出文件里的版本戳**，不参与加载时的迁移判断） ----
export const STATE_VERSION = 'v8.0.0';
