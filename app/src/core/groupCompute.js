// ================================================================
// 组计算接线（core/groupCompute.js）
//
// 职责：把 `core/groupValue.js` 的"每层三趟"接进**真实的取值链路**，并做记忆化。
//
// 为什么需要一层接线（而不是让规则自己去算）
// ----------------------------------------------------------------
//   · `groupValue.js` 是**纯算法**：它只认"自己那份值"的取值器（`baseOf`），
//     不知道 `status2` 是算出来的、更不知道"按账户范围算"这回事；
//   · 而 `status2` 的"自己那份"必须走 `core/derive.js` 的派生表（按范围算）
//     —— 视图全走投影。
//   于是这里把两者接起来：第 1 趟（原料）的值 = **那一趟**（`core/query/countPass.js`）
//   的本身值（`ownOf`）—— 与显示侧"带覆盖那张表"**共用同一趟**；组值（`working`）
//   由 `groupValue.js` 的每层三趟算出来，交给调用方读（显示的"组那份"列、容器汇总口径）。
//
// ⚠️ 层间**不再重算派生表**（真包实测每层一次 314ms）：那张带覆盖的表没有任何读者 ——
//   逐条理由见下面循环后面那段注释（`readOwn` 的兜底顺序 + `own` 只装本类型节点）。
//
// ⚠️ 与 `derive.js` 的分工（别再混）
//   · `derive.js`：**自己那份**（含"按范围"）；
//   · 本模块：**组那份**（`working` 覆盖表）+ 两列的读取入口；
//   · 两列**都不写回来源层**：`working` 是一张**只读的旁路表**，不是节点字段。
//
// 失效标记（不做脏传播）
// ----------------------------------------------------------------
//   键 = `nodes` 引用 + `childOrder` 引用 + 计数模式 + `currentAccountId`：
//     · `nodes` 引用变了（Immer 结构共享：**任何**数据改动都会换引用）⇒ 重算；
//     · 结构改动 ⇒ `childOrder` 也换引用；
//     · 计数模式是全局设置 ⇒ 换模式必须重算；
//     · 倒推覆盖本身**与范围无关**（组是结构），但第 1 趟要算派生值，
//       而派生值按账户范围算 ⇒ 账户换了也得重算。
//   一槽缓存（与 `derive.js` 的 `memo` 同一套路），2 万节点量级下够用。
//
// 依赖：core/groupValue.js、core/derive.js、core/model/elements.js。纯模块（无 immer / DOM）。
// ================================================================
import { derivedOf } from './derive.js';
import { cache_countPassOf } from './query/countCache.js';
import { synthIndexOf } from './ops/synth.js';
import { runGroupPasses, GROUP_LEVELS, GROUP_FIELDS, hasGroupAgg, hasSynthesisNodes, groupValueOnDemand } from './groupValue.js';
import { resolveCountMode } from './query/countMode.js';
// ★ 查看范围里的账户 = 本账户（+ 开关开着时的直接子账户）—— **与显示侧同一份规则**
//   （`v9.1.25`：这条路上原来只按 `[viewingAccountId]` 造范围，把那个开关整个绕过去了）
import { scopeAccountsFor, mergeChildrenOf } from './trust.js';
import { natureOf, ELEMENT_NATURE } from './model/elements.js';

/** 一槽记忆化（键见文件头；`nodes` 引用是对比的第一项） */
let memo = null;

/** 测试/诊断用：清掉记忆化 */
export function clearGroupMemo() {
    memo = null;
}

/**
 * **把已有的组表（`working`）接到新一代上**（不清、不重算）。
 * 用途与边界见 `countCache.js` 的 `rekeyCountCache`：只给"纯顺序改动"（上移/下移）用
 * —— 真包实测覆盖表在上下移前后**逐条相同**（dedup 17093 条）。
 */
export function rekeyGroupMemo(state) {
    if (!memo) return;
    memo.nodes = (state || {}).nodes || null;
    memo.childOrder = (state || {}).childOrder || null;
}

/** 本次要看哪个账户那一份（与 `view/scope.js` 的 `scopeOpts` 同口径，但不建 Set） */
function viewAccountOf(state, opts) {
    const v = (opts && opts.viewingAccountId !== undefined)
        ? opts.viewingAccountId
        : (state ? state.viewingAccountId : '');
    return (v === undefined || v === null) ? '' : String(v);
}

/**
 * 三趟编排 + 记忆化。**只读**，不写任何节点/来源层。
 *
 * @param {Object} state - `{ nodes, parentOf, childOrder, settings, accounts, trust, viewingAccountId }`
 * @param {Object} [opts] - `{ viewingAccountId, accounts, trust }`
 * @returns {{ working:Map<string,Object>, hasSynthesis:boolean, layers:Array }}
 */
export function groupComputed(state, opts = {}) {
    if (!state || !state.nodes) {
        return { working: new Map(), hasSynthesis: false, layers: [] };
    }
    const account = viewAccountOf(state, opts);
    const mode = resolveCountMode(state.settings);
    const accounts = opts.accounts !== undefined ? opts.accounts : state.accounts;
    const trust = opts.trust !== undefined ? opts.trust : state.trust;
    // ★★ **范围必须与显示侧同一份规则**（`v9.1.25` 修的真坑）：原来这里是
    //    `[account]` —— 只按"在查看的账户"造范围，**绕过** `scopeAccountsFor`
    //    ⇒ 「查看范围 → 把我的子账户也算进我这份」这个开关**在这一条路上被忽略**。
    //    症状（用户 2026-10-13 实测）：计数模式 = **去重** 时，显示读的是「组那份」，
    //    而组那份正是从这里的三趟/那一趟出来的 ⇒ **父账户勾了开关也一条取不到**
    //    （someone 那天 9 题、TEAM0 0 题）。
    //    ⚠️ 变量名保持 `scopeId`：`src/test/perfGuards.test.js` 的源码锚认的就是
    //    `scopeAccounts: scopeId`（那条锚要的"与 scopeOpts 同形"现在才真的成立）。
    const scopeKey = scopeAccountsFor(account, accounts, mergeChildrenOf(state.settings));
    const scopeId = scopeKey;

    const hit = memo;
    if (hit && hit.nodes === state.nodes && hit.childOrder === state.childOrder
        && hit.account === account && hit.mode === mode
        && hit.scope === scopeId.join(',')
        && hit.accounts === accounts && hit.trust === trust) {
        return hit.result;
    }

    const working = new Map();
    // `hasSynthesis` 只算一次（三层各扫一遍 Tree 太浪费；`runGroupPasses` 内部也要用）
    let hasSynthesis = hasSynthesisNodes(state);
    // ★ **没有合成节点 ⇒ 组值 ≡ 自己那份**（三趟什么都不做）⇒ 那一趟也不必跑。
    //   为什么这行顺序要紧：跑一趟要 ~130ms（真包 27k），而"没有合成节点"是**很常见**的一类
    //   （`groupPerf` 那条守卫钉的就是"短路应该几乎免费"，实测从 152ms → 5ms）。
    //
    // ★ 第 1 趟（原料）的值 = **那一趟的本身值**（`ownOf`）—— 不再自己建一张"自己那份"的表。
    //   口径与显示侧**同一份**：
    //     · dedup 模式下 `view/scope.js` 那张带覆盖的表（`derivedTable({group})`）也是从
    //       `cache_countPassOf(..., mode:'dedup')` 来的 ⇒ **共用同一趟**（不然显示侧就跑了
    //       两遍全量：自己那份表 + 组表）；
    //     · plain 模式下用 plain 那一份（与统计栏共用）。
    //   ⚠️ 取值必须与老那张表**逐字段一致**（否则组值会跟着变）：`ownOf` 给的就是
    //      P 的 `status1`/`status2`（组头的 `status2` 在那一趟里已被"组那份"回写 ⇒ 与
    //      派生表第二趟的 merge 同值）、容器不产 `status1/2` ⇒ 与老表的空行一致。
    //      真包对拍：`working` 逐条相同（`scripts/_probe-group-ab.mjs`）。
    const tStart = Date.now();
    const pass = hasSynthesis
        ? cache_countPassOf(state, {
            scopeAccounts: scopeId, accounts, trust,
            ...(mode === 'dedup' ? { mode: 'dedup' } : {})
        })
        : null;
    // 第 1 趟的取值器：A = **自己那份**（这一层的 `own` 只装本类型节点；跨类型成员
    // 先命中 `working`，见下面"不再在层间重算派生表"那段）。
    const baseOf = (node, field) => {
        if (!pass) return node[field];
        const v = pass.ownField(node.id, field);           // ⚠️ 用标量口：一次遍历要调几万次
        return v !== undefined ? v : node[field];
    };

    const layers = [];
    let groupsTotal = 0;
    // 分相计时（诊断用：显示侧"组那份"这条路上，钱在那一趟还是在这三趟）
    const tPassMs = Date.now() - tStart;
    const layerMs = {};

    // ★ **dedup：覆盖表直接由那一趟交出来**，不再跑"每层三趟"。
    //   依据：那一趟在组事件里本来就算出了每组的 `status1`/`status2`（`vecP` 那三处），
    //   按 `computeLayerGroups` 的单元素组/组值口径补上后，真包对拍 **17092 条 0 不一致**
    //   （同进程、包内稳定键；`scripts/_probe-overrides-ab.mjs`）。
    //   ⇒ 暖态省掉三趟那 **~107ms**（P 65 + C 42）。
    //   ⚠️ `layers` 只保留被测试/诊断用到的"层名 + 组数"（原来那两层的 `groups` 就是
    //      `synthIndexOf().byKey.size` —— `computeLayerGroups` 的 `done(index.byKey.size)`）；
    //      `values` 那张逐节点表生产上没人读（`groupValueOnDemand` 读的是 `working`）。
    if (pass && mode === 'dedup') {
        const ov = pass.groupOverrides();
        for (const [id, row] of ov) working.set(id, { ...row });
        const heads = synthIndexOf(state).byKey.size;
        for (const type of GROUP_LEVELS) {
            const groups = (type === 'R') ? 0 : heads;
            layers.push({ layer: type, groups, values: new Map() });
            groupsTotal += groups;
        }
        const result = {
            working, hasSynthesis, layers, groupsTotal,
            timings: { pass: tPassMs, layers: { 三趟: '已跳过（dedup 用那一趟）' }, total: Date.now() - tStart }
        };
        memo = {
            nodes: state.nodes, childOrder: state.childOrder, account, mode,
            scope: scopeId.join(','),
            accounts, trust, result
        };
        return result;
    }
    // ⚠️ 成员顺序 / 成员表**不在这里传**：`runGroupPasses` 自己用
    //    `core/ops/synth.js` 的 `synthMembersTable` 一趟建表（树序，且**不含合成节点自己**）。
    for (const type of GROUP_LEVELS) {
        const tL = Date.now();
        const step = runGroupPasses(state, { type, working, baseOf, hasSynthesis });
        layerMs[type] = Date.now() - tL;
        hasSynthesis = step.hasSynthesis;
        const layer = step.layers[0] || { layer: type, groups: 0, values: new Map() };
        layers.push(layer);
        groupsTotal += layer.groups;
        if (!hasSynthesis) break;               // 没有合成节点 ⇒ 三趟什么都不做（回归锚）
    }
    // ★ **不再在层间重算派生表**（以前每层都重来一次，真包实测 **314ms/次**、两层就 600+ms）。
    //
    //   为什么可以不要（逐条对到代码上，别凭印象）：
    //     · 那张表只喂**下一层**的 `baseOf`（`computeLayerGroups` 的 `readOwn`）；
    //     · 而 `readOwn` 的取值顺序是 `own`（**本层节点**）→ `working`（倒推覆盖）→ `baseOf`；
    //       `own` 只装 `typeOf(node) === type` 的节点 ⇒ 跨类型（只有坏数据会这样：组头是 C、
    //       成员里有 P）也会先在 `working` 命中上一层的组值，**轮不到** `baseOf`；
    //     · `baseOf` 只有"本层自己的 A"用得到，而 A 要的是**自己那份** ⇒ 用**初始那张表**
    //       （不带 `group`）就是对的。
    //   ⇒ 层间那张"带覆盖的表"没有任何读者。实测验证：去掉后 `working` 逐条相同
    //     （`scripts` 里的 A/B 探针，27000 节点 / 17092 条覆盖，两种跑法顺序都跑过）。

    const result = {
        working, hasSynthesis, layers, groupsTotal,
        timings: { pass: tPassMs, layers: layerMs, total: Date.now() - tStart }
    };
    memo = {
        nodes: state.nodes, childOrder: state.childOrder, account, mode,
        scope: scopeId.join(','),
        accounts, trust, result
    };
    return result;
}

/**
 * **组那份**的值（两列值里的第二列）。
 *
 * ⚠️ **底层口**：它**不管显示模式**（任何模式下组值都照算 —— 有测试钉着）。
 *   "屏幕上那一列"该读哪一份由 `view/scope.js` 的 `displayColumnOf` 决定 ⇒ 要跟屏幕一致就调
 *   `viewDerivedDisplay(...)`，别在这里自己判断（`plain` 下屏幕上那份**是**"自己那份"）。
 *
 * @param {Object} state
 * @param {Object} node
 * @param {string} field
 * @param {Object} [opts]
 * @returns {*} 组值；没有组 / 不聚合该字段 → `undefined`（调用方退回"自己那份"）
 */
export function groupValueOf(state, node, field, opts = {}) {
    if (!node || !hasGroupAgg(field)) return undefined;
    // ★「把开销挪到初始化」：**不在任何组里**的节点，答案必然是 `undefined` ——
    //   而下面那句 `groupComputed` 会把整棵树算一遍（真包实测 ~750ms）。
    //   判据与别处同一套：成员看 `ownerSynth`、组头看 `synthKey`。
    if (!inSomeGroup(node)) return undefined;
    const c = groupComputed(state, opts);
    if (!c.hasSynthesis) return undefined;
    const row = c.working.get(node.id);
    if (!row || row[field] === undefined) return undefined;
    return row[field];
}

/** 这个节点在**某个组**里吗？（成员 = 有 `ownerSynth`；组头 = 有 `synthKey`） */
function inSomeGroup(node) {
    return !!(node && (String(node.ownerSynth || '').trim() || String(node.synthKey || '').trim()));
}

/** 某节点某字段**有没有**组那份（渲染层/统计层据此决定要不要显示第二列） */
export function hasGroupValue(state, node, field, opts = {}) {
    return groupValueOf(state, node, field, opts) !== undefined;
}

/** 派生字段过滤（与 `derivedOf` 同口径）：普通/结构字段没有"两列"这回事 */
export function hasDerivedColumn(field) {
    return natureOf(field) === ELEMENT_NATURE.DERIVED;
}

export { derivedOf, GROUP_FIELDS, GROUP_LEVELS, groupValueOnDemand };
