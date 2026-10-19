// ================================================================
// 链接类别的词汇表（core/linkKinds.js）
//
// **唯一一份**：类别名与中文标签只在这里定义，`view/linkChips.js`（树上渲染）与
// `ui/G_modal/sourcePanel.js`（编辑弹窗的来源面板）都从这里取 —— 两处各写一份的话，
// 迟早出现"树上叫仓库、弹窗里叫资料"这种不一致。
//
// ⚠️ 这是**纯模块**（不 import 任何东西）：`sourcePanel.js` 刻意只依赖纯模块，
//    这样它才能被单元测试直接 import（见该文件顶部关于 `shell/state.js`/`immer` 的注释）。
//
// 上游权威定义在 `scripts/crate.py` 的 `LINK_KINDS`（爬取层写进元列 `链接分类`）。
// 依据：docs/field-rules.md。
// ================================================================

/** 类别 → 小标题/标签 */
export const LINK_KIND_LABELS = Object.freeze({
    board: '🏆 榜单',
    problems: '🔗 补题',
    repo: '📦 仓库',
    // **源站上的容器页**（平台主页、QOJ 分类页、CF gym 列表）——
    // 点回源头核对归属用，见于 W 与 S 节点
    browse: '🧭 浏览',
    unknown: '❔ 其它',
    // 没有类别信息的值（导入时没带的、或手填的）—— 不假装知道它是哪一类
    unclassified: '🔗 链接'
});

/** 显示顺序：能直接用的入口在前，资料/待归类在后 */
export const LINK_KIND_ORDER = Object.freeze(['board', 'problems', 'repo', 'browse', 'unknown', 'unclassified']);

/**
 * **缓存值**（`node.link`）的挑选优先级：有补题入口时它就是补题链接，
 * 没有就退到榜单 → 仓库 → 其它（详见 `features/AutoImport/plan.js` 的 `pickLink`）。
 *
 * ⚠️ 它和 `LINK_KIND_ORDER` **不是一回事**：那个是界面上小标题的**显示**顺序
 *（榜单在前更像"比赛的入口"），这个是"哪一条配当 `link` 的缓存值"。
 * `browse` 排最后：容器节点上它常常是**唯一**的值（那就取它），
 * 但同一个节点上真有比赛入口时，不该被"浏览页"抢走 `link`。
 */
export const LINK_KIND_PRIORITY = Object.freeze(['problems', 'board', 'repo', 'browse', 'unknown']);

/**
 * 类别 → 标签 —— **唯一的查表入口**（别再各处 `LINK_KIND_LABELS[k] || …`）。
 *
 * @param {string} kind
 * @param {string} [fallback] 未知类别的兜底。**不传 = 原样返回 key**（便于排查，
 *        弹窗来源面板就是这个口径）；树上要显示成「❔ 其它」，所以那边显式传它。
 *        ⚠️ 兜底**故意不写死在这里**：两处的意图不同，写死会把"未知 key"这件事藏起来。
 */
export function linkKindLabel(kind, fallback) {
    const k = String(kind || '');
    if (LINK_KIND_LABELS[k]) return LINK_KIND_LABELS[k];
    return fallback === undefined ? k : fallback;
}

/**
 * 一个节点的链接，**按类别分组**成 `{ 类别: [{v, src}] }`。
 *
 * ⚠️ 同一条信息在**两种形状**里住的地方不同，这个函数是唯一的归一入口：
 *   · **包记录**（crate）上它是元列 `链接分类`（`scripts/crate.py` 归一成 `{类别:[{v,src}]}`）；
 *   · **应用节点**上没有这一格 —— 导入把它**摊进了来源层**（`node.values.link`，
 *     每条带 `linkKind`，见 `features/AutoImport/plan.js` 与 `apply.js`）
 *     ⇒ 这里再按 `linkKind` 分回组（没有 `linkKind` 的算 `unclassified`，
 *     与 `view/linkChips.js` 的分组口径**同一条**）。
 *
 * 为什么要它：组值的链接聚合器（`core/groupValue.js` 的 `AGG_BUILDERS['链接分类']`）
 * 要在**两种形状**下都拿得到"自己那份" —— 只认其中一种就会出现
 * "拿真包跑探针正常、在应用里永远是空"（实测踩到）。
 */
export function linkKindsOfNode(node) {
    const n = node || {};
    const direct = n['链接分类'];
    if (direct && typeof direct === 'object' && !Array.isArray(direct)) return direct;
    const out = {};
    const list = (n.values || {}).link;
    for (const one of (Array.isArray(list) ? list : [])) {
        const v = one && one.v;
        if (v === undefined || v === null || String(v).trim() === '') continue;
        const kind = String((one && one.linkKind) || '') || 'unclassified';
        if (!out[kind]) out[kind] = [];
        if (!out[kind].some(x => x.v === String(v))) {
            out[kind].push({ v: String(v), src: String((one && one.src) || '') });
        }
    }
    return out;
}

/**
 * 把一份 `链接分类` 并进 `dst`（**原地改**）；同类别同 URL 只留一条（出处取先到的）。
 *
 * ⚠️ **判据只有这一份**，两个消费者：
 *   · 合并两条**记录**（`scripts/crate-merge.mjs`：同一场的数据分散在多个来源，各自的链接都要留）；
 *   · **组值的链接聚合器**（`core/groupValue.js` 的 `AGG_BUILDERS['链接分类']`：
 *     一个组的链接 = 组头 + 各成员链接的并集）。
 *   各写一份的话迟早漂成"两种去重口径"，症状是同一个 URL 在树上出现两个一模一样的标签。
 *
 * ⚠️ 它**不往组头落地**：组头的 `链接分类` 不在合成那一步写（组值是按需聚合出来的派生值，
 *    `core/groupValue.js` 文件头那条"组值不落盘"）。这里只是那个聚合器的折叠函数。
 *
 * ⚠️ 去重的是 **`(类别, URL)`**，不是"值"：不同类别里的同一个 URL（牛客页既是 `board`
 *    又是 `problems`）照旧各留一条 —— 类别本身就是它的用途。
 *
 * @param {Object} dst - 目标 `{ 类别: [{v, src}] }`（原地改）
 * @param {Object} incoming - 来源 `{ 类别: [{v, src}] }`（形状**只有一种**，归一在产出点
 *        `scripts/crate.py` 的 `_normalize_link_kinds`：裸 URL 也会补成 `{v, src}`）
 */
export function mergeLinkKinds(dst, incoming) {
    if (!dst || !incoming || typeof incoming !== 'object') return;
    for (const kind of Object.keys(incoming)) {
        const list = Array.isArray(incoming[kind]) ? incoming[kind] : [];
        for (const one of list) {
            const v = one && one.v;
            if (v === undefined || v === null || String(v).trim() === '') continue;
            if (!dst[kind]) dst[kind] = [];
            if (!dst[kind].some(x => x.v === String(v))) {
                dst[kind].push({ v: String(v), src: String((one && one.src) || '') });
            }
        }
    }
}
