// ================================================================
// State 结构（core/model/state.js）
// 职责：State 工厂、parentOf 重建、id 生成工具
// 依赖：constants.js, node.js, A_constants.js（应用级默认值）
// 说明：不含 infoState（会话级状态见 core/model/infoState.js）
// ================================================================
import { DEFAULT_TREE_DISPLAY_MODE } from './constants.js';
import { KIND_RANK } from '../trust.js';
import { DEFAULT_EDIT_MODE, DEFAULT_STATS_FILTER_MODE } from '../../A_constants.js';
import { MODE_PLAIN } from '../query/groupCount.js';
import { createNode } from './node.js';

// ---- 初始 State（含 O 根节点） ----
//
// ⚠️ **`nodes` / `childOrder` / `parentOf` 必须排在最后**（性能坑：挪上去会明显变慢）：
//    Immer 提交一次事务时按**属性顺序**逐个 finalize 顶层孩子；只要还有"没 finalize 完的 draft"，
//    它就会对**还没走到的**孩子做一次**深度遍历**（`immer.mjs` 的 `finalizeProperty` → `finalize`）。
//    于是"改一个浅键"（比如 `meta`）如果排在三个大字典**前面**，每次事务都要**整个走一遍 2.7 万节点
//    （连每条的 `values` 一起）** ≈ **400ms**（真包实测：三个大字典排在前面 426ms / 排到最后 **1ms**）。
//    这正是"相当多操作 1s 以上"的主要来源。
//
// ⚠️ **光靠顺序不够** —— 深走"走多远"还取决于**改的那个节点在
//    `nodes` 里的位置**（实测改第 7 个 28ms / 第 9449 个 132ms / 最后一个 **389ms**；
//    只动 `childOrder`/`parentOf` 也 400ms+）。真正的开关是 `freezeNodes`（下面那个函数）：
//    节点对象冻上之后 `finalizeProperty` 会整条跳过它们。**顺序 + 冻结两件都要**。
export function createInitialState() {
    const now = Date.now();
    const rootId = makeNodeId(1, now);
    const root = createNode(rootId, 'O');
    return {
        rootId,
        pages: {},
        // ★ **训练计划**（设计稿 `docs/training-plan.md`）：`{ planId: { name, pageId, goal, statuses, ... } }`。
        //   ⚠️ **只存「形状」**（用户 ⑦）：完成情况一律现算（`core/trainingPlan.js`），一个字节都不存。
        //   ⚠️ 必须排在**三个大字典之前**（键顺序的理由见本函数末尾那段）。
        plans: {},
        // ---- 视图态（**不住在 `nodes` 里**）----
        // `expanded`：稀疏表，只记"展开着"的 id（收起是默认）；真源是 localStorage，
        //   存取见 `core/model/viewState.js`，读一律走 `isExpanded(state, id)`。
        // 为什么单独一层：住在 `nodes` 里时，折叠会换掉 `nodes` 引用 ⇒ 按引用失效的缓存整片作废。
        view: { expanded: {} },
        // ---- 来源层 ----
        // sources: srcId → 来源信息（谁抓的/哪个站点/可信度/许可…），值里只放 srcId
        // trust:   多来源优先级配置（用户可改；默认值见 core/trust.js）
        sources: { manual: { kind: 'manual', rank: KIND_RANK.manual, note: '你自己改的' } },
        // ⚠️ `trust.sources` 是**投影实际查的表**（core/trust.js 的 normalizeTrust）；
        //    `state.sources` 是人看的注册表。两处必须同步，否则手改/权威榜单的"类别优先"
        //    会在投影里退化成"都是 script"（实测踩到）。
        trust: { categoryRank: ['manual', 'board', 'script', 'derived'],
                 sources: { manual: { kind: 'manual', rank: KIND_RANK.manual } },
                 fieldPrefer: {}, groupPrefer: {} },
        // **「应有」注册表**（随包发布；导入时由 `features/AutoImport/apply.js` 写入）。
        // 形状与 `acm-data/field-registry.json` 一致：`{ fields: { 字段: { expect, types, when, why } } }`。
        // 没有它（还没导入过带注册表的包）⇒ `null`，字段条上不显示「应有」那一行，一切照旧。
        fieldRegistry: null,
        // 包顶层带的**体检报告**（`reports.coverage` = 字段体检 /
        //   `reports.needs` = 原料需求）—— 导入时由 apply.js 写入，「🩺 体检 / 需求」页读它。
        //   没有（还没导入过带报告的包 / 老包）⇒ `null`，那页说一句"重建一次包就有"。
        reports: null,
        // ---- 账户维度 ----
        // accounts: 顶层注册表（**不是树节点**）
        //   id 是一段随机乱码（API-key 类似物）：本机生成、跨机器不冲突、永不改
        //   name 随便改；nature 只是 UI 性质标签；children 是**真源**（父由全表反推，结构是 DAG）
        accounts: {
            local: { id: 'local', name: '本机', nature: '默认', children: [], isLocal: true, mappings: [] }
        },
        currentAccountId: 'local',   // 登录账户：手改值的归属（持久化）
        viewingAccountId: 'local',   // 在查看的账户：投影/筛选用（持久化）
        // ⚠️ 两者不同 ⇒ 手改禁止（避免"想改 A 还是改 B"改错账号）；导入不禁。
        settings: {
            // ★ **手改值的默认归属**（用户 2026-10-13 拍板）：`'account'`（账户私有）| `'objective'`（所有人共用）。
            //   一件事两用：**设置里的全局默认** ＋ **编辑框"上次的选择"**（别设两处）。
            //   `''` = 还没选过 ⇒ **按字段回落**：nature 四格客观、其余账户（老行为一字不变）。
            //   口径只有一处：`core/ops/node.js` 的 `manualScopeOf`。
            manualScope: '',
            // ★ **题目 AC 时间"怎么挑"**（用户 2026-10-13，设计稿 `docs/ac-time-rule.md`）：
            //   `'earliest'`（默认，= 老行为）| `'latest'` | `'cutoff'`。
            //   口径只有一处：`core/acTimeRule.js` 的 `acTimeRuleOf`（坏值/没设一律退回 earliest）。
            //   `cutoff` 只在规则是 `'cutoff'` 时用得上：8/12/14 位数字（到天/到分/到秒）。
            acTimeRule: 'earliest',
            acTimeCutoff: '',
            // ★ **查看范围要不要带上直接子账户**（用户 2026-10-13）：`false`（默认）= 原逻辑（只看本账户）；
            //   `true` = 本账户 **+ 它的直接子账户**（不递归子孙）——"把子账户机制用起来"。
            //   口径唯一一份：`core/trust.js` 的 `mergeChildrenOf` / `scopeAccountsFor`
            //   （两个范围构造口 `resolveScope` 与 `view/scope.js:scopeOpts` 都调它）。
            scopeMergeChildren: false,
            // ★ **训练强度映射表库**（⑮：全局若干张、每张有名字；计划引用其中一张）：
            //   `[{ id, name, byRatio: [{max,value}], byCf: [{max,value}], mode }]`。
            //   ⚠️ 形状以 `core/ops/plan.js:normalizeTableShape` 为准（老存档里可能还留着
            //      `byXcpc` / `defaultValue` 两个旧字段，**读的时候都不看**、也不再写出来）。
            //   ⚠️ **空数组 = 用内置默认那张**（口径唯一一份：`core/trainingPlan.js:intensityTableById`）
            //   —— 所以这里**不 import** 那张表（免得 state 卷进 core/query 的依赖链）。
            trainingIntensityTables: [],
            mode: {
                treeDisplayMode: DEFAULT_TREE_DISPLAY_MODE,
                editMode: DEFAULT_EDIT_MODE
            },
            display: {
                nodePerPage: 20,
                boxCount: 15,
                boxDisplayMode: 'cf',
                // ★ **逐字段"取哪一份"的覆盖**（只存偏离默认的项）：`{ 字段: 'own'|'group' }`。
                //   口径在 `view/scope.js` 的 `displayColumnOf(state, field)` —— **收法甲**：
                //   覆盖**只在判重模式下生效**（不判重一律本份，否则违反"plain 下不许聚合"）。
                fieldColumn: {}
            },
            performance: {
                expandedNodeWarningLimit: 2500,
                expandedNodeBlockLimit: 5000,
                historySteps: 25
            },
            autoSave: {
                autoSaveInterval: 10,
                autoExportMode: 'full'
            },
            stats: {
                statsTab: 'training',
                statsFilterMode: DEFAULT_STATS_FILTER_MODE,
                // 计数模式（**唯一一份口径**）。缺省 `plain`（不去重）
                // = 逐节点计数的口径；取值常量复用 `core/query/groupCount.js`
                // （别在这里抄第二份字面量）。读了见 `core/query/countMode.js`。
                countMode: MODE_PLAIN,
                showSpecialGroups: true,
                acStatsShowSpecial: true,
                acTrackingPageSize: 20,
                heatmapMode: 'count'
            },
            mappings: {
                batchImportMapping_v1: {},
                batchSubmitMapping_v1: {},
                batchContestMapping_v1: {}
            }
        },
        meta: {
            idCounter: 1
        },
        currentPageId: 'main',
        currentTab: 'main',
        // ⚠️ **这三个大字典永远排在最后**（理由见函数头那段：Immer 的 finalize 顺序坑）
        nodes: { [rootId]: root },
        childOrder: { [rootId]: [] },
        parentOf: { [rootId]: null }
    };
}

// ================================================================
// 把节点对象**冻上**（Immer 那趟"深走"的开关）
//
// 病根：Immer 提交一次事务时，只要还有没 finalize 完的 draft，就会把**还没走到的**普通对象
//   整棵**深走**一遍（`immer.mjs` 的 `finalizeProperty` → `finalize`），只为找"被塞进普通对象里的 draft"。
//   `setAutoFreeze(false)` 之后**没有任何东西是 frozen 的** ⇒ 这趟深走每次都真跑，
//   而且走多远取决于**改的那个东西排在 `nodes` 的哪一个位置**（真包 2.7 万节点实测，
//   同一个"改一个字段"：改第 7 个节点 **28ms** / 第 9449 个 **132ms** / 最后一个 **389ms**；
//   只动 `childOrder`/`parentOf`（`nodes` 一个字没改）也要 **404~419ms**）。
//
// 药：`finalizeProperty` 里那道门是 `isDraftable(childValue) && !isFrozen(childValue)` ——
//   **冻上就跳过**。冻的是**节点对象本身**（浅冻）：
//     389ms→31ms、404ms→44ms、"新建一道题" 425ms→127ms（`scripts/perf-bench.mjs` 可复现）。
//
// 规矩（这条要看住）：
//   · 只冻节点对象这一层：`values` 那些内部容器不冻，**事务里照常改** —— Immer 复制的是
//     **可写的**副本（`immer.mjs` 的 `shallowCopy`：普通对象走 `{ ...base }`），
//     所以"事务内怎么写状态"一个字都不用变；
//   · ⇒ **事务外就地改节点**（`AppState.nodes[id].xxx = v`）现在会**当场抛错**。
//     那本来就是 bug：不入历史、不落盘，而 `persistence/diff.js` 按**引用**判脏 ⇒
//     内存与盘静默不一致（`view/helpers.js` 里就是修这个）。
//     要改状态就走 `execute`。
//   ★ **冻的只有节点对象这一层 —— `node.values` 里那些容器仍然是可变的**（2026-10-16 写明边界）：
//     事务里要**就地**改它们（`fieldValue.js:addSourceValue` 往 `values[字段]` 里 push/替换），
//     一旦深冻，immer 把冻结的子对象当"不可 draft"直接返回 ⇒ 那些写会当场 TypeError。
//     ⇒ 所以"事务外改 `node.values[…]`"**不会**抛错（这一层没有守卫），判断"是不是被人误改"时
//       别只靠"节点冻没冻"；要更严得先把写路径全改成"换新对象"（那是另一件事，别顺手做）。
//   · 挂钩点只有两个：`replaceState`（启动加载 / 整体导入）与 `applyState`（每次事务、撤回）。
//     首次冻 2.7 万个 ~15ms；之后每次事务只补冻"这次新产生的"那几个。
// ================================================================
export function freezeNodes(state) {
    const nodes = state && state.nodes;
    if (!nodes) return 0;
    let n = 0;
    for (const id in nodes) {
        const node = nodes[id];
        if (node && typeof node === 'object' && !Object.isFrozen(node)) {
            Object.freeze(node);
            n++;
        }
    }
    return n;
}

/**
 * **顶层结构的"冻结白名单"**（2026-10-18，用户定的形状："引入操作-冻结白名单机制"）。
 *
 * 为什么需要它：`freezeNodes` 只冻**节点对象**那一层，而 `state` 里还有几张**几万键的大字典**
 * （`childOrder` / `parentOf` / `pages`）是**没冻**的普通对象 ⇒ Immer 提交时对它们整棵深走
 * （`finalizeProperty` 的 `isDraftable && !isFrozen` 门），于是"只改一个标量 `currentPageId`"
 * 的切页事务也要 **222–232ms**（实测：`produce` 占 222ms，后面 classify/applyState/落盘全是 0–10ms）。
 *
 * 规矩（与 `freezeNodes` 同一条边界，别扩大）：
 *   · **只冻"容器这一层"**（`Object.freeze(dict)`），**不冻它们的值** —— `childOrder[父]` 那些数组、
 *     `pages[id].virtualIndex` 里的 vNode、`parentOf` 的值（字符串）都不冻 ⇒ 事务里照旧可写
 *     （Immer 复制的是可写副本，写法一个字不用改）。
 *   · 名单**只有这一份**；加一张大字典就往这里加一行，并在 `src/test/perfGuards.test.js` 里
 *     补一条"它真的被冻了"的行为锚。
 *   · 事务外就地改这些结构（`AppState.childOrder[x] = ...`）会**当场抛错** —— 那本来就是 bug
 *     （不入历史、不落盘，`persistence/diff.js` 按引用判脏）。
 */
//: 顶层那两张**几万键的大字典**（它们原来是"没冻的普通对象" ⇒ Immer 提交时整棵深走）。
//: ⚠️ 夹具侧必须"造状态前换可变副本"（见各冒烟文件里那句注释），否则就地改一格会抛错 —— 那是**刻意**的。
export const FROZEN_TOP_KEYS = ['childOrder', 'parentOf', 'pages'];

/** 按白名单把顶层那几张字典冻上（幂等；只冻容器这一层） */
export function freezeTopLevel(state) {
    if (!state) return 0;
    let n = 0;
    for (const key of FROZEN_TOP_KEYS) {
        const v = state[key];
        if (v && typeof v === 'object' && !Object.isFrozen(v)) {
            Object.freeze(v);
            n++;
        }
    }
    // ★ `pages` 还要再往下一层：Immer 的深走会钻到**每个副页的 `virtualIndex`**（3000+ 个 vNode）
    //   ⇒ 只冻 `state.pages` 这张字典是不够的（2026-10-18 实测：只冻顶层时 produce 一点没降）。
    //   ⚠️ 仍然只冻**容器这一层**（vNode 对象本身不冻 ⇒ 事务里照旧能改它们的字段）。
    const pages = state.pages;
    if (pages && Object.isFrozen(pages)) {
        for (const pid in pages) {
            const idx = pages[pid] && pages[pid].virtualIndex;
            if (idx && typeof idx === 'object' && !Object.isFrozen(idx)) {
                Object.freeze(idx);
                n++;
            }
        }
    }
    return n;
}

/**
 * **只补冻"这次动过的"那几个**（`applyState` 的正常路径）。
 *
 * 为什么：上面那个全表版每次事务都要把 2.7 万个节点挨个 `Object.isFrozen` 一遍
 * （真包实测 **~12ms/次**），而真正需要补冻的只有**这次事务刚产生的那几个可写副本** ——
 * 别的节点上一次事务就已经冻住了 ✓（冻是幂等的）。事务层手里正好有"引用变了的那些 id"。
 */
export function freezeNodeList(state, ids) {
    const nodes = state && state.nodes;
    if (!nodes || !Array.isArray(ids)) return 0;
    let n = 0;
    for (const id of ids) {
        const node = nodes[id];
        if (node && typeof node === 'object' && !Object.isFrozen(node)) {
            Object.freeze(node);
            n++;
        }
    }
    return n;
}

// ---- 从 childOrder 重建 parentOf ----
export function rebuildParentOf(childOrder) {
    const parentOf = {};
    for (const parentId in childOrder) {
        const children = childOrder[parentId];
        if (!Array.isArray(children)) continue;
        for (const childId of children) {
            parentOf[childId] = parentId;
        }
    }
    return parentOf;
}

// ---- id 生成工具（纯函数，需传入 counter 与时间戳） ----
export function makeNodeId(counter, timestamp) {
    return 'n_' + counter + '_' + (timestamp || Date.now()).toString(36);
}

export function makeTagId(counter, timestamp) {
    return 't_' + counter + '_' + (timestamp || Date.now()).toString(36);
}

export function makePageId(timestamp) {
    return 'page_' + (timestamp || Date.now()).toString(36);
}

export function makeVirtualRootId(timestamp) {
    return 'vroot_' + (timestamp || Date.now()).toString(36);
}