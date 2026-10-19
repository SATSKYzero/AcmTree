// ================================================================
// 统计查询（core/query/stats.js）
// 职责：节点统计、P 节点统计、全局统计
// 依赖：core/model/status.js（分档口径）
//
// 派生字段（status2 / statusComplete2）**按查看范围现算**，
// 所以统计不再直接读缓存字段，而是读一个由调用方给的取值器：
//
//     const derived = (node, field) => viewDerived(state, node, field);
//     collectPStats(state, rootId, derived)
//
// **不传**时退回读缓存字段（= 登录账户口径），这样别的调用方
// （还没迁移的调用点）行为一字不变。
//
// **计数接 `countMode`** + 三处口径回填
// ----------------------------------------------------------------
//   · 模式开关是**全局设置** `state.settings.stats.countMode`（缺省 `plain`，口径见
//     `core/query/countMode.js` 的 `resolveCountMode`）。调用方一个字都不用改：
//     **不传第 4 个参数、且设置是缺省 `plain` ⇒ 逐字段与逐节点计数相同**
//     （`state.nodes` 里**没有合成节点**时逐字段完全相等，有回归锚钉住）。
//   · `plain`（不去重）= §二 模式 1 的定义：**子树里所有原料节点各算一次**
//     + **合成节点只在"本子树内没有任何它的成员"时算一次**
//     （只要有一个同类型成员在内，该合成节点就不算 —— 否则与成员重复）。
//   · `dedup`（去重）= **真的按组计**：范围内每个「组」只算一次，
//     **档位取那一组的「组那份」**（= 「(合成节点自己那份 + 列表成员各自那份) 再聚合」，
//     规则与实现都在 `core/groupValue.js`：`status1` 取或、`status2` `preferReal`
//     外加"合成头自己那份 == 5（忽略）⇒ 整组 5"的特例 —— 语义见该模块文件头）；
//     没有合成节点的原料自己就是一组（档位取它自己）。组的划分复用
//     `core/query/groupCount.js` 的 `collectGroups()` —— 与计数模块**同一份口径**
//     （悬空指针落成单元素组、同类型校验、合成节点不当成员），不在这里另写一套。
//     ⚠️ 这**不是**"组头压过成员"：只看组头自己填的值，会把成员的 1/真实档位丢掉。
//   · 去重是 **scope-local**：成员在范围内 ⇒ 该组在范围内（组头在范围外也照样按它算）。
//   · **P 侧**：`plain` 数 P 原料 + （子树内**没有** P 成员的）P 合成节点；`dedup` 每组一次。
//     ⚠️ 合成节点若不是 P 类型，本来就不进 P 的分档（这里是按类型筛的）。
//   · **C 侧**（"两者合并"）：组头是合成 C 时，它的分档取
//     `max(① 该合成 C 节点**自己子树 P 汇总**出来的 `statusComplete2`,
//          ② 它组内 **C 成员各自** `statusComplete2` 的聚合)`。
//     ① 就是 `core/derive.js` 的 `deriveContainerStatusComplete2`（这里只经由取值器**读**它，
//     **不另写一套**）；② 读成员自己的那份；`max` 是 `0 未动/1 接触/2 全处理/3 AK` 的
//     自然解释，同时让"用户按下的覆盖 `4`（忽略）"按既有 pin 语义**优先**（4 是序数最大）。
//     这两条腿就是 `core/groupValue.js` 的 **A（树内）/ B（映射）**：C 侧也走
//     `groupAggregateOf`（**与 P 侧同一入口**），不再在 stats 里自己折叠。
//     没有合成节点的 C 行为不变（每个 C 自己一组、取它自己）。
// ================================================================
import { newProblemBuckets, addProblem, newContestBuckets, addContest } from '../model/status.js';
import { collectGroupsCached, MODE_DEDUP } from './groupCount.js';
import { isCountMode, resolveCountMode } from './countMode.js';
import { groupAggregateOf } from '../groupValue.js';
// 合成节点（组头）的成员是**指针**，不是子节点 —— `cProblemNodes` 要用
import { isSynthesis, synthKeyOf } from '../ops/synth.js';
import { orderedIds } from '../siblingOrder.js';
// 「子节点从哪来」现成那一份（主树形态）：真实节点那一支走它
import { getChildIds } from './nodes.js';

/** 默认取值器：直接读缓存字段 */
const cacheReader = (node, field) => node[field];

// ================================================================
// 按组计数的两件工具（**只读**，不写任何节点/来源层）
// ================================================================

/** 本次按哪种模式计数：显式 `opts.mode` 优先；非法 / 不给 ⇒ 读全局设置（缺省 plain） */
function countModeOf(state, opts) {
    const explicit = opts && opts.mode;
    return isCountMode(explicit) ? explicit : resolveCountMode((state || {}).settings);
}

/**
 * 子树内的节点 id 逐个访问（**迭代**，两万节点不爆栈）。
 * `rootId` 空 = 全树；根不在 `nodes` 里 = 什么都不访问（与 `collectByType` 同口径）。
 * 子节点一律走 `state.childOrder`（与 `collectByType` 一致）。
 */
function forEachInScope(state, rootId, visit) {
    const nodes = (state && state.nodes) || {};
    if (!rootId) {
        for (const id in nodes) visit(id);
        return;
    }
    if (!nodes[rootId]) return;
    const childOrder = (state && state.childOrder) || {};
    const seen = new Set();
    const stack = [rootId];
    while (stack.length) {
        const id = stack.pop();
        if (seen.has(id) || !nodes[id]) continue;
        seen.add(id);
        visit(id);
        const kids = childOrder[id] || [];
        for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    }
}

/**
 * 组索引（`collectGroups()` 的结果）：**记忆化在 `groupCount.js` 的共享口里**
 * （`collectGroupsCached` —— 键 = `nodes` 引用，WeakMap 不拖住上一代）。
 *
 * 为什么要缓存：`collectPStats` 每个渲染出来的 C/W/S 节点都要调一次
 * （`view/stats.js` 的 `getCProblemSummary` 等），每次全表扫一遍 = O(n²)。
 * ⚠️ 以前这里是**自己一槽** ⇒ 同一代里"那一趟"（`countPass.js`）也要同一份时会各扫一遍
 *    （真包这一趟 **88~92ms**）⇒ 现在两处共用一份。
 * **只服务 `dedup` 路径**（`plain` 一字不变）。
 */
function groupIndexOf(state) {
    // 共用 `groupCount.js` 的共享记忆化口：真包这一趟 88~92ms，同一代里那一趟
    // （`countPass.js`）也要同一份 ⇒ 别各扫一遍。
    return collectGroupsCached(state);
}

/**
 * 一个 C 的**题目节点集合**（显示用）：自己子树里的 P **＋ 合成节点的成员**子树里的 P。
 *
 * 为什么合成节点要单独走这一步：**成员是"指针"不是子节点**（`ownerSynth` → `synthKey`，
 * 见 `core/ops/synth.js`），组头的 `childOrder` 里一道题都没有 ⇒ 不补这一步，组头永远是
 * "0 题"（摘要 `00/00/00 00/00/00`、📊分布空、一个方框都没有），而它的成员明明有 13 题
 * —— 用户 2026-10-06："原料节点有题而合成节点没有题是不合理的"。
 *
 * 去重按**题的组标识**（`ownerSynth` / 自己的 `synthKey`）：同一道题在各来源各有副本时
 * 只留一格（否则"2026 IC网络赛2"这种 4 个来源的组会被数成 4×13 道）。
 * **没有组标识的不合并** —— 与 `core/dedup.js` 的"宁多报、不误合"同一条口径。
 * 按题号排序（`core/siblingOrder.js` 的 `orderedIds`），与树上的顺序一致。
 *
 * ⚠️ **非合成节点逐字不变**：这里只对合成节点做"并集 + 去重"，普通 C 还是它自己的子树。
 */
export function cProblemNodes(state, node) {
    if (!node) return [];
    // ★ **副页（虚拟节点）的子节点在投影里**（`_virtual` 的节点自带 `children`），
    //   **不在 `childOrder` 里** —— 按页内 id 去 `state.nodes` 查会落空。
    //   以前这里一律走 `collectByType(state, node.id, 'P')`：副页上那一趟取不到任何 P，
    //   于是"合成节点那条并集"只好退回**各来源的成员记录**，而副本自己的 status 多为空
    //   ⇒ C 卡片上那排小方框**全白**（用户 2026-10-08："主页时题目小方框正常显示绿色的通过，
    //   在副页全白"）。修法不是给副页另写一套，而是**把"子树从哪来"这一处分叉收在一处**：
    //   真实节点走 `collectByType`（`childOrder`），虚拟节点走它自己的 `children`。
    const psUnder = (rootNode) => {
        if (!rootNode) return [];
        if (!rootNode._virtual) return collectByType(state, rootNode.id, 'P');
        const out = [];
        (function walk(n) {
            for (const c of (n.children || [])) {
                if (!c) continue;
                if (c.type === 'P') out.push(c);
                else walk(c);
            }
        })(rootNode);
        return out;
    };
    const roots = [node];
    if (isSynthesis(node)) {
        const { groups, groupOfNode } = groupIndexOf(state);
        const key = groupOfNode.get(node.id) || synthKeyOf(node);
        const slot = key ? groups.get(key) : null;
        for (const mid of (slot && slot.members) || []) if (mid !== node.id) roots.push(state.nodes[mid]);
    }
    const out = [];
    const seenId = new Set();
    const seenKey = new Set();
    const rootOf = new Map();          // 每个存活的 P 来自哪一棵子树（见下面 ② 的判据）
    for (const r of roots) {
        for (const p of psUnder(r)) {
            if (!p || seenId.has(p.id)) continue;
            seenId.add(p.id);
            const gk = String(p.ownerSynth || p.synthKey || '').trim();
            if (gk) {
                if (seenKey.has(gk)) continue;
                seenKey.add(gk);
            }
            out.push(p);
            rootOf.set(p.id, r.id);
        }
    }
    const byId = new Map(out.map(p => [p.id, p]));
    // ① **存活的题只来自一棵子树** ⇒ 上面收集出来的顺序**就是那棵树上的顺序**
    //    （`collectByType` / `psUnder` 都按 `childOrder` 前序遍历）⇒ **原样返回**。
    //    ⚠️ 以前这里**无条件**按 `orderedIds`（题号升序）重排 —— 于是"📊 题目排序"对话框
    //      手动排出来的难度序**在卡片上永远看不到**：树变了、卡片不动
    //      （实测：真包某 C 按 CF 难度降序后 树 = `E2 F E1 D C B A`、卡片仍 `A B C D E1 E2 F`），
    //      而本函数的注释自己写着"**与树上的顺序一致**"。
    // ⚠️ **判据是"存活的题"来自几个根，不是"一共走过几个根"**（`v9.0.7` 修的坑）：
    //    组头的成员副本会被走一遍（`roots` 里有它们），但它们贡献的题**按组去重全被丢掉**了
    //    ⇒ 存活的题其实**全来自组头自己**（有树序、也就有"人排过的顺序"）。
    //    按 `roots.length` 判会让这类比赛**整体退回题号序** —— 症状与上面那条一模一样：
    //    用户在某场"2026 IC网络赛1"（组头 + 4 个成员）上点「XCPC难度降序」，
    //    提示说"已按…排序"、树序也确实变了，可**那一行方框一个都没动**。
    //    （实测：树序 `A B C…` → `F M C L A D N G J H K I B E`，卡片仍 `A B C…`。）
    const rootOfOut = new Set(out.map((p) => rootOf.get(p.id)));
    if (rootOfOut.size <= 1) return out;
    // ② **真的跨了多棵子树**（成员独有的题也在里面）：跨子树没有"树上的顺序"可言 ⇒
    //    **组头自己那份先按它的树序**（人排过的顺序就写在它的 `childOrder` 上），
    //    只剩"成员独有的题"才退回规范序（题号升序，规则只有一份：`core/siblingOrder.js`）。
    const head = roots[0];
    const ownIdx = new Map(psUnder(head).map((p, i) => [p.id, i]));
    const mine = out.filter(p => ownIdx.has(p.id))
        .sort((a, b) => ownIdx.get(a.id) - ownIdx.get(b.id));
    const rest = out.filter(p => !ownIdx.has(p.id));
    if (!rest.length) return mine;
    return [...mine, ...orderedIds(rest).order.map(id => byId.get(id))];
}

/**
 * **一组的那一份档位**（dedup 用）—— 与 `core/groupValue.js` 的"组那份"**同一套规则**：
 *   `OR(自己那份, 成员们的 status1)` / `preferReal(自己那份, 成员们的 status2)`，
 *   外加 `status2` 的特例"合成头自己那份 == 5（忽略）⇒ 整组 5"。
 *
 * ⚠️ 走 `groupAggregateOf`（`core/groupValue.js`），**并把调用方的取值器原样透传**
 *    —— 统计的 reader 是 `viewDerived`（按账户范围投影），组值必须按**同一个范围**算，
 *    否则同一个组会在树上显示一个数、在统计栏按另一个数分档。
 * ⚠️ 组头就是那个合成节点（`headId`），成员是 `collectGroups` 给的 `slot.members`；
 *    成员**永远是原料**（合成节点不会被当成员）⇒ 不会递归。
 * ⚠️ 非合成代表（自己一组）也走同一条：`memberIds` 为空 ⇒ 组值 = 它自己那份。
 *
 * @returns {*} 该组的 status1/status2；算不出来（字段没聚合器 / 头不存在）⇒ 退回自己那份
 */
function groupProblemValue(state, rep, field, derived) {
    const v = groupAggregateOf(state, {
        headId: rep.node.id,
        memberIds: rep.isSynth ? rep.memberIds : [],
        field,
        readOf: derived
    });
    return (v === undefined || v === null) ? derived(rep.node, field) : v;
}

/**
 * **一个组键 → 代表**（组头就是那个合成节点；没有组头 / 组头不在 ⇒ 原料自己）。
 *
 * 抽出来给两处共用（**代表怎么定只有这一份**）：
 *   · `groupRepsInScope()` —— 主树，按 `state.childOrder` 遍历子树；
 *   · `problemUnitsOf()` —— 副页，调用方已经收好一批 P（虚拟树不走 childOrder）。
 *
 * @returns {{node:Object, isSynth:boolean, memberIds:string[]}|null}
 *   组头类型与 `type` 不一致（坏数据）⇒ `null`（调用方按"整组不计入本类型"处理）
 */
function groupRepOf(state, key, fallbackNode, type) {
    const { groups } = groupIndexOf(state);
    const slot = key === undefined ? null : groups.get(key);
    const headId = (slot && slot.synthId) || '';
    const isSynth = !!(headId && (state.nodes || {})[headId]);
    const rep = isSynth ? state.nodes[headId] : fallbackNode;
    if (((rep && rep.type) || '') !== type) return null;
    return { node: rep, isSynth, memberIds: isSynth ? (slot.members || []) : [] };
}

/**
 * `dedup`：范围内**每个组各出一个代表节点**（组的划分见文件头）。
 *
 * 代表 = 该组的**合成节点**（组头）；没有组头（无指针 / 悬空指针）就是那个原料自己。
 * 只有 `type` 的组会被收（P 统计只数 P 组；C 统计只数 C 组；同类型是合成关系的硬约束）。
 * 组头在不在范围内**不影响计数**（成员在范围内 ⇒ 该组在范围内，档位照样取组头那一组）
 * —— 这正是"去重是 scope-local、档位以组为单位"。
 *
 * @returns {Array<{node:Object, isSynth:boolean, memberIds:string[]}>}
 *   `node` 是代表（组头或原料自己）；`isSynth` = 代表就是那个组头；
 *   `memberIds` 只在 `isSynth` 时有值（该组的全部成员节点 id，调用方按类型自行筛）。
 */
function groupRepsInScope(state, rootId, type) {
    const nodes = (state && state.nodes) || {};
    const { groupOfNode } = groupIndexOf(state);
    const seen = new Set();
    const reps = [];
    forEachInScope(state, rootId, (id) => {
        const node = nodes[id];
        if (!node || node.type !== type) return;
        const key = groupOfNode.get(id);
        if (key === undefined || seen.has(key)) return;
        const rep = groupRepOf(state, key, node, type);
        if (!rep) return;                            // 组头是别的类型（非法数据）⇒ 不计入本类型
        seen.add(key);
        reps.push(rep);
    });
    return reps;
}

/**
 * 一批 P 节点（**调用方已经收好的**，如副页里引用的那些）按**当前计数模式**归一成
 * `[{node, status1, status2}]`：
 *   · `plain` ⇒ 每个节点各一条，读它自己那份 —— **与逐节点计数逐字相同**（老行为）；
 *   · `dedup` ⇒ **每组一条**，档位取**那一组的组那份**（`groupProblemValue`，与
 *     `collectPStats` 同一入口、同一份规则）—— 副页也就能跟主树用同一个开关。
 *
 * 为什么要有它：副页（虚拟树）的"子树"是 `page.virtualIndex` 里那批**引用**，
 * `groupRepsInScope()` 那套按 `state.childOrder` 遍历的子树的办法用不上；
 * 但口径必须是同一份 ⇒ 共用本模块的组索引与组值规则，不另写一套。
 *
 * @param {Object} state - 至少 `{nodes}`；`dedup` 还要 `settings`（模式）
 * @param {Array} pNodes - 一批 P 节点；元素为 `null` = "引不到真实节点"（只计总数、不判状态）
 * @returns {Array<{node:Object|null, status1:*, status2:*}>}
 */
export function problemUnitsOf(state, pNodes, derived = cacheReader, opts = {}) {
    const list = Array.isArray(pNodes) ? pNodes : [];
    const out = [];
    if (countModeOf(state, opts) !== MODE_DEDUP) {
        for (const n of list) {
            out.push(n
                ? { node: n, status1: derived(n, 'status1'), status2: derived(n, 'status2') }
                : { node: null, status1: undefined, status2: undefined });
        }
        return out;
    }
    const { groupOfNode } = groupIndexOf(state);
    const seen = new Set();
    for (const n of list) {
        if (!n) { out.push({ node: null, status1: undefined, status2: undefined }); continue; }
        const key = groupOfNode.get(n.id);
        // 不在组索引里（例如传进来的 nodes 只是一部分）⇒ 自成一组，**不丢**
        const rep = key === undefined ? { node: n, isSynth: false, memberIds: [] }
            : groupRepOf(state, key, n, 'P');
        if (!rep) continue;                          // 组头是别的类型（坏数据）⇒ 整组跳过
        if (key !== undefined) {
            if (seen.has(key)) continue;
            seen.add(key);
        }
        out.push({
            node: rep.node,
            status1: groupProblemValue(state, rep, 'status1', derived),
            status2: groupProblemValue(state, rep, 'status2', derived)
        });
    }
    return out;
}

/**
 * `plain`：这个子树里**该计一次的 P 节点**（§二 模式 1 的定义）。
 *
 *   · **原料**（没有 `synthKey` 的节点）= 一定算一次；
 *   · **合成节点** = 只在"本子树内**没有它的任何 P 成员**"时算一次
 *     —— 只要有 P 成员在内，它就不单独计（否则成员与合成节点重复计）；
 *   · 同组里**不是组头**的合成节点（坏数据：两个节点共用一个 `synthKey`）不计，
 *     与 `groupCount.js` 的 plain 分支同口径（那边只认 `meta.synthIdx`）。
 *
 * ⚠️**回归底线**：`state.nodes` 里没有合成节点时，这里每个 P 都是原料、各算一次 ⇒ 与
 * **逐节点计数**逐字段相等（且连组索引都不建，顺带没有额外开销）。
 */
function plainPNodes(state, rootId) {
    const nodes = (state && state.nodes) || {};
    const all = [];
    const pIds = new Set();
    let hasSynth = false;
    forEachInScope(state, rootId, (id) => {
        const n = nodes[id];
        if (!n || n.type !== 'P') return;
        all.push(n);
        pIds.add(id);
        if (n.synthKey) hasSynth = true;
    });
    if (!hasSynth) return all;
    const { groups, groupOfNode } = groupIndexOf(state);
    const out = [];
    for (const p of all) {
        if (!p.synthKey) { out.push(p); continue; }
        const key = groupOfNode.get(p.id);
        const slot = key === undefined ? null : groups.get(key);
        if (!slot || slot.synthId !== p.id) continue;   // 不是组头（坏数据）⇒ 不计
        let memberInside = false;
        for (const mid of slot.members) {
            const m = nodes[mid];
            if (m && m.type === 'P' && pIds.has(mid)) { memberInside = true; break; }
        }
        if (!memberInside) out.push(p);
    }
    return out;
}

/**
 * 一批**容器**（调用方已经算好了"它在当前视图里的值"）按**当前计数模式**归一成
 * `[{node, value}]`：
 *   · `plain` ⇒ 每个容器各一条（原样返回那些值）—— 老行为；
 *   · `dedup` ⇒ **每组一条**，值走 `groupAggregateOf`（C 侧合并规则**只有那一份**：
 *     `statusComplete2` = 序数取最大，`4 忽略` 自然是最大值）——
 *     `readOf` 是**本视图的取值器**（页里没有的节点给 `undefined` ⇒ 那一路空着，靠另一路）。
 *
 * 为什么与 `problemUnitsOf` 分开：P 侧的档位来自 `derived(node, 'status1'/'status2')`，
 * 而副页的 C 值是 `virtualContainerStats()` 现算出来的**页面值**（不是节点上的字段），
 * 所以调用方把 `{node, value}` 一起交进来。**合并规则仍是同一份**（`groupAggregateOf`）。
 *
 * @param {Object} state - 至少 `{nodes}`；`dedup` 还要 `settings`（模式）
 * @param {Array<{node:Object|null, value:*}>} entries - 容器（真实节点）+ 它在当前视图里的值
 * @returns {Array<{node:Object|null, value:*}>}
 */
export function contestUnitsOf(state, entries, opts = {}) {
    const list = Array.isArray(entries) ? entries : [];
    const out = [];
    if (countModeOf(state, opts) !== MODE_DEDUP) {
        for (const e of list) out.push({ node: (e && e.node) || null, value: e ? e.value : undefined });
        return out;
    }
    const { groupOfNode } = groupIndexOf(state);
    const seen = new Set();
    // 本视图的取值器：只认"页里真的算了值"的那些节点（组头不在页里 ⇒ A 那一路空着）
    const pageValue = new Map();
    for (const e of list) if (e && e.node) pageValue.set(e.node.id, e.value);
    const readOf = (node, field) => (node && field === 'statusComplete2' ? pageValue.get(node.id) : undefined);
    for (const e of list) {
        const n = (e && e.node) || null;
        if (!n) { out.push({ node: null, value: e ? e.value : undefined }); continue; }
        const key = groupOfNode.get(n.id);
        const rep = key === undefined ? { node: n, isSynth: false, memberIds: [] }
            : groupRepOf(state, key, n, 'C');
        if (!rep) continue;                          // 组头是别的类型（坏数据）⇒ 整组跳过
        if (key !== undefined) {
            if (seen.has(key)) continue;
            seen.add(key);
        }
        let v;
        if (rep.isSynth) {
            v = groupAggregateOf(state, {
                headId: rep.node.id, memberIds: rep.memberIds, field: 'statusComplete2', readOf
            });
        }
        if (v === undefined || v === null) v = e.value;    // 退回流：与"自己一份"一致
        out.push({ node: rep.node, value: v });
    }
    return out;
}

/**
 * C 组合并：`max(① 组头自己子树 P 汇总, ② 组内 C 成员各自 statusComplete2)`。
 *
 * **口径与实现都在 `core/groupValue.js`**（架构修正后：① 是 **A**、② 是 **B**，
 * `merge = A/B 两套相遇`）—— 这里只是**把统计侧的取值器原样透传**过去，
 * **不另写一套折叠**（与 P 侧走 `groupProblemValue` → `groupAggregateOf` 同一个入口）。
 *
 * ⚠️ 取不到值的（`undefined` / `null`）**退回 `own`**（与逐节点计数一致）——
 *    `groupAggregateOf` 的 `null` 表示"两套都没值"，此时组值 ≡ 组头自己那份。
 * **没有成员 / 不是合成节点 ⇒ 原样返回 `own`**（这条保证"无合成节点时逐字段相等"）。
 */
function contestGroupValue(state, group, derived) {
    const own = derived(group.node, 'statusComplete2');   // ① A：容器推导（derive.js）
    if (!group.isSynth) return own;
    const v = groupAggregateOf(state, {
        headId: group.node.id,
        memberIds: group.memberIds,
        field: 'statusComplete2',
        readOf: derived
    });
    return (v === undefined || v === null) ? own : v;
}

// ---- 收集指定子树中指定类型的节点 ----
/**
 * 收集**指定子树**里指定类型的节点。
 *
 * @param {Object} state
 * @param {Object|string} root - 子树根：**节点对象或 id 都行**（副页节点的 id 是**页内 id**，
 *        `state.nodes` 里查不到 ⇒ 只给 id 会取不到任何东西）
 */
export function collectByType(state, root, types) {
    const typeSet = new Set(Array.isArray(types) ? types : [types]);
    const rootNode = (root && typeof root === 'object') ? root : state.nodes[root];
    if (!rootNode) return [];
    const out = [];
    (function walk(n) {
        if (typeSet.has(n.type)) out.push(n);
        // ★ **子树从哪来**这一处判据与 `cProblemNodes` 的 `psUnder` 同形：
        //   真实节点走 `childOrder`（唯一那份 `mainChildIdsOf`），
        //   **副页投影节点走它自己的 `children`**（页内 id 不在 `state.nodes` 里）。
        if (n._virtual) {
            for (const c of (Array.isArray(n.children) ? n.children : [])) if (c) walk(c);
            return;
        }
        for (const cid of getChildIds(state, n.id) || []) {
            const c = state.nodes[cid];
            if (c) walk(c);
        }
    })(rootNode);
    return out;
}

// ---- 全树收集指定类型 ----
export function collectAllByType(state, types) {
    const typeSet = new Set(Array.isArray(types) ? types : [types]);
    const out = [];
    for (const id in state.nodes) {
        const n = state.nodes[id];
        if (typeSet.has(n.type)) out.push(n);
    }
    return out;
}

// ---- 节点总数（含根） ----
export function countNodes(state) {
    return Object.keys(state.nodes).length;
}

// ---- P 节点统计 ----
/**
 * @param {Object} state
 * @param {string|null} rootId - null = 整棵树
 * @param {(node:Object, field:string) => *} [derived] - 派生字段取值器（缺省读缓存）
 * @param {Object} [opts]
 * @param {'plain'|'dedup'} [opts.mode] - 计数模式；不传 / 非法 ⇒ 读
 *        `state.settings.stats.countMode`（缺省 `plain` = 今天的行为）
 */
export function collectPStats(state, rootId, derived = cacheReader, opts = {}) {
    if (countModeOf(state, opts) === MODE_DEDUP) {
        // ---- dedup：范围内**每个组各计一次**，档位取**那一组的组值** ----
        // ⚠️ 不能只取组头**自己填的** status1/status2（那是"覆盖"，与组那份对不上）——
        //    这里与 `core/groupValue.js` 的组值同一套规则（`groupProblemValue`）。
        const b = newProblemBuckets();
        for (const rep of groupRepsInScope(state, rootId, 'P')) {
            addProblem(b, groupProblemValue(state, rep, 'status1', derived),
                groupProblemValue(state, rep, 'status2', derived));
        }
        return b;
    }
    // ---- plain：§二 模式 1 的定义（原料各一次 + 子树内无成员的合成节点各一次）----
    // 没有合成节点时 = 逐节点计数（逐个 addProblem，逐字段相等）。
    const b = newProblemBuckets();
    for (const p of plainPNodes(state, rootId)) {
        addProblem(b, derived(p, 'status1'), derived(p, 'status2'));
    }
    return b;
}

// ---- C 节点统计 ----
/**
 * C 侧的分档字段是 `statusComplete2`（`core/model/elements.js`）。
 *
 *   · `plain`：逐节点；
 *   · `dedup`：范围内**每个 C 组各计一次**，档位取
 *     `groupAggregateOf`（= max(合成 C 自己子树 P 汇总, 组内 C 成员聚合)，规则与实现在
 *     `core/groupValue.js` 的 A/B/merge）；没有合成节点的 C 自己一组、取它自己 ⇒ 与
 *     `plain` 逐字段相等。
 *
 * @param {Object} [opts] - 同 `collectPStats`（`{ mode }`）
 */
export function collectCStats(state, rootId, derived = cacheReader, opts = {}) {
    const b = newContestBuckets();
    if (countModeOf(state, opts) === MODE_DEDUP) {
        for (const rep of groupRepsInScope(state, rootId, 'C')) {
            addContest(b, contestGroupValue(state, rep, derived));
        }
        return b;
    }
    const cNodes = rootId
        ? collectByType(state, rootId, 'C')
        : collectAllByType(state, 'C');
    for (const c of cNodes) {
        addContest(b, derived(c, 'statusComplete2'));
    }
    return b;
}

// ---- 统计文本（全局统计栏 / 节点摘要共用同一套补零规则） ----
/**
 * 按该档自己的总数决定补零宽度（两位起，别再改）。
 *
 * ⚠️ **最后那个"总数"也要过这个函数**（不这样做的话：`00/11/00/00/14`
 * 里最后一位会变成一位数，如 `…/7` —— 裸拼的 `${pb.total}` 不受补零约束，
 * "每个数字至少两位"这条设计就只对前四档成立）。
 */
const pad = (num, total) => String(num).padStart(Math.max(String(total).length, 2), '0');

/** `过/过+补/处理/处理+忽略/总` */
export function formatProblemCounts(pb) {
    return `${pad(pb.passed, pb.total)}/${pad(pb.passedIgnore, pb.total)}`
        + `/${pad(pb.processed, pb.total)}/${pad(pb.processedIgnore, pb.total)}/${pad(pb.total, pb.total)}`;
}

/** `AK/处理/接触/忽略/总` */
export function formatContestCounts(cb) {
    return `${pad(cb.ak, cb.total)}/${pad(cb.proc, cb.total)}`
        + `/${pad(cb.contact, cb.total)}/${pad(cb.ign, cb.total)}/${pad(cb.total, cb.total)}`;
}

/** 统计栏那一行：`C:…` 与 `P:…` */
export function formatStatsText(pb, cb) {
    return {
        cStr: `C:${formatContestCounts(cb)}`,
        pStr: `P:${formatProblemCounts(pb)}`
    };
}

// ---- 全局统计 ----
/**
 * @param {Object} [opts] - 计数模式（`{ mode }`），**P / C 两侧都看它**（C 侧口径见
 *        `collectCStats`）。
 */
export function getGlobalStats(state, derived = cacheReader, opts = {}) {
    const ps = collectPStats(state, null, derived, opts);
    const cs = collectCStats(state, null, derived, opts);
    return { ...formatStatsText(ps, cs), cRaw: cs, pRaw: ps };
}