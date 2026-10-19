// ================================================================
// 状态语义（core/model/status.js）
// 职责：status1 / status2 / statusComplete2 的**聚合口径**（纯函数，无依赖）
//
// 为什么必须只有一处：
//   "哪几个 status2 算通过、哪几个算处理过" 这条规则若在 6 个地方各写一遍
//   （自动计算规则、按范围派生、全树统计、副页统计、副页容器统计…），
//   改一处忘一处就会出现"树上显示 3、统计栏按 4 算"这类对不上的数字。
//
// 三个入口，各自只管"我去哪取值"，怎么算一律来这里：
//   - addProblem(b, status1, status2)   P 的分档（同时是统计栏 P / C 摘要的来源）
//   - statusComplete2Of(b)              容器（C/W/S）由子树 P 的分档推出
//   - addContest(b, statusComplete2)    C 的分档（统计栏 C 摘要）
//   - pStatus2(hasSub, hasAC, pin)      P.status2 本身的算法（自动计算 / 派生共用）
//
// 注意：`pin`（用户覆盖）的**取值来源**由调用方决定 —— 本应用走来源层投影（带账户）。
// 本模块只负责"拿到覆盖后怎么用"。
// ================================================================

// status2 的取值含义（文案在 `A_constants.js` 的 STATUS2_LABELS，两者同序）
// —— 导出给别处用（如"中文词 → 值"的映射、UI 里的裸比较），**别再各写一份数字**。
export const S2_UNUSED = 0;
export const S2_TODO = 1;
export const S2_WA = 2;
export const S2_AFTER = 3;
export const S2_DURING = 4;
export const S2_IGNORE = 5;

// ----------------------------------------------------------------
// R.submitKind：提交的性质
//
// 它决定 P.status2 是「4 赛时通过」还是「3 赛后补题」——
// 规则：**只要有一发"赛时"的 AC，这题就算赛时通过**（其余 AC 都算赛后补的）。
//
// ⚠️ 空字符串 = "判不出来 / 还没判"，**不是**一个值（别写"未知"）：
//    留空才能被下次抓取补上（导入策略是 fill-if-empty）。
// ----------------------------------------------------------------
export const SUBMIT_KIND_DURING = '赛时';
export const SUBMIT_KIND_VP = 'VP';
export const SUBMIT_KIND_AFTER = '补题';
export const SUBMIT_KINDS = Object.freeze([SUBMIT_KIND_DURING, SUBMIT_KIND_VP, SUBMIT_KIND_AFTER]);

/**
 * `status2` 的**取值**（数字，与 `A_constants.js` 的 `STATUS2_LABELS` 同序）。
 *
 * 为什么要把数字导出来：**别处要"把中文词变成数字"时容易各自硬写**
 * （例如批量导入里写死 `{'通过': 4, …}` —— 那就把"通过"当成**4 赛时通过**，
 * 而应用在没有 `R.submitKind` 证据时判的是 **3 赛后补题**，同一个词两个结论）。
 * 统一从这里取，谁要"中文词 → 值"就用下面那张映射。
 */

/**
 * **中文词 → `status2`**（供 Excel/CSV 批量导入这类"人写的输入"用）。
 *
 * ⚠️ 关键取舍：**`通过` 映射到 `3 赛后补题`，不是 `4 赛时通过`**。
 * 理由：`4` 的正式名字是「**赛时通过**」，只有拿到"赛中交的"证据（`R.submitKind = 赛时`）
 * 才配得上；一张表上写个"通过"并不携带这个证据。**导入不该替用户断言"赛时"**，
 * 而 `pStatus2` 在没有证据时的默认正是 `3` —— 两边据此对齐。
 * 想标赛时通过，请在表里明确写 `赛时通过`（或导完在树上按）。
 */
export const STATUS2_ALIASES = Object.freeze({
    '通过': S2_AFTER,          // 过题 ≠ 赛时过题（见上）
    '过了': S2_AFTER,
    '赛后补题': S2_AFTER,
    '已补': S2_AFTER,
    '未通过': S2_WA,
    '已提交未通过': S2_WA,
    '提交未通过': S2_WA,
    '赛时通过': S2_DURING,
    '待写': S2_TODO,
    '未使用': S2_UNUSED,
    '忽略': S2_IGNORE
});

// ----------------------------------------------------------------
// P（题目）分档
// ----------------------------------------------------------------

/** 统计栏 `P:过/过+补/处理/处理+忽略/总` 的那五档 */
export function newProblemBuckets() {
    return { total: 0, passed: 0, passedIgnore: 0, processed: 0, processedIgnore: 0 };
}

/**
 * 这个 `status2` 算不算"**过题**"（`3 赛后补题` 或 `4 赛时通过`）。
 *
 * 别再各处写裸比较（`s2 === 3 || s2 === 4`，如 `ui/stats/acTracking.js`、
 * `core/query/compare.js`）—— 哪天想给"过题"加一档，漏一处就会
 * "树上算过、筛选里不算"。这里只有这一份。
 */
export function isPassed(status2) {
    return status2 === S2_AFTER || status2 === S2_DURING;
}

/** 这个 `status2` 算不算"**忽略了**"（不参与统计/比较） */
export function isIgnored(status2) {
    return status2 === S2_IGNORE;
}
/** 把一道 P 计入分档（严格 `===`：非法值不落进任何档） */
export function addProblem(b, status1, status2) {
    b.total++;
    // ⚠️ `passed`（赛时过题）与 `passedIgnore`（过题，含赛后补）**不是同一个集合**：
    //    前者只数"4 赛时通过"，后者数"3 或 4"。所以这里不能两个都用 `isPassed`。
    if (status2 === S2_DURING) b.passed++;
    if (isPassed(status2)) b.passedIgnore++;
    if (status1 === 1) b.processed++;
    if (status1 === 1 || isIgnored(status2)) b.processedIgnore++;
    return b;
}

// ----------------------------------------------------------------
// P 的**类向量**（给"一趟算齐"用）
//
// 病根：树上每个节点的 P 摘要 = "子树里每个 P 各 `addProblem` 一次再相加" ⇒ 以前只能
//   每个节点各走一遍自己的子树。改成"往上加"之后，沿途要带的是一份**可加的向量**，
//   那就得有一份"一个 P 归到向量哪几格"的定义 —— 它就是下面这 8 格：
//     `c0..c5` = `status2` 的六个档各几个（📊分布要用全部六档）；
//     `c6` = `|status1==1 且 status2!=5|`、`c7` = `|status1==1 且 status2==5|`。
//   ⇒ 五档桶由它们复原（`problemBucketOfClass`），**不再走第二个 `addProblem` 实现**。
// ⚠️ 与 `addProblem` 是**同一份口径的两个面**：`addProblem` 是"一个一个加"，
//    这里是"先把每个单位的格记下来、最后一次性还原"。改了一边必须同时看另一边。
// ⚠️ `total` 在这里 = `c0..c5` 之和，所以只在"`status2` 一定是这六档之一"时才与
//    `addProblem` 完全等价 —— 派生出来的 `status2` 由 `pStatus2` 产出、恒在 0..5，
//    这条由对拍（真包全节点）钉住。
// ----------------------------------------------------------------

/** 一个 P 单位的类向量有几格（`c0..c5` + 两个 `status1==1` 的细分） */
export const P_CLASS_DIMS = 8;

/** 把一个 P 记进类向量（`vec[base + 0..7]`） */
export function addProblemClass(vec, base, status1, status2) {
    if (isStatus2ValueLocal(status2)) vec[base + status2] += 1;
    if (status1 === 1) {
        if (status2 === S2_IGNORE) vec[base + 7] += 1;
        else vec[base + 6] += 1;
    }
}

/** 类向量 → 五档桶（与 `addProblem` 逐字段等价） */
export function problemBucketOfClass(vec, base = 0) {
    const c3 = vec[base + S2_AFTER];
    const c4 = vec[base + S2_DURING];
    const c5 = vec[base + S2_IGNORE];
    let total = 0;
    for (let i = 0; i <= S2_IGNORE; i++) total += vec[base + i];
    const a = vec[base + 6];                 // s1==1 且 s2!=5
    const b = vec[base + 7];                 // s1==1 且 s2==5
    return {
        total,
        passed: c4,
        passedIgnore: c3 + c4,
        processed: a + b,
        processedIgnore: (a + b) + c5 - b        // |{s1==1} ∪ {s2==5}|
    };
}
// ----------------------------------------------------------------
// C 的**类向量**（同上）：`d0..d4` = `statusComplete2` 的五个档各几个
// （`AK/处理/接触/忽略/总` 五档由它复原；`addContest` 是"一个一个加"的那一面）
//
// ⚠️ `total` 在这里 = `d0..d4` 之和 ⇒ 只在"`statusComplete2` 一定是 0..4 之一"时才与
//    `addContest` 完全等价 —— 而 `addContest` 的 `total++` 是**无条件**的（`undefined` 也记一个"总"）。
//    真包两轮对拍（plain / dedup 各 27205 节点）都是 0 错 ⇒ 派生出来的 `statusComplete2`
//    从来没出现过"不在档内"的值，这条等价成立。
// ----------------------------------------------------------------

/** 一个 C 单位的类向量有几格（`statusComplete2 = 0..4` 五档） */
export const C_CLASS_DIMS = 5;

/** 把一场 C 记进类向量 */
export function addContestClass(vec, base, statusComplete2) {
    const s = Number(statusComplete2);
    if (s === 3 || s === 2 || s === 1 || s === 0 || s === 4) vec[base + s] += 1;
}

/** 类向量 → 五档桶（与 `addContest` 逐字段等价） */
export function contestBucketOfClass(vec, base = 0) {
    const d1 = vec[base + 1], d2 = vec[base + 2], d3 = vec[base + 3], d4 = vec[base + 4];
    return {
        total: vec[base + 0] + d1 + d2 + d3 + d4,
        ak: d3,
        proc: d2 + d3,
        contact: d1 + d2 + d3,
        ign: d1 + d2 + d3 + d4
    };
}

/**
 * 这个值算不算 `status2` 的**六档之一**（本文件内部用；判据就是那六个常量，
 * 严格 `===` —— 小数 / 字符串一律不算，与 `addProblem` 的严格比较同口径）。
 */
function isStatus2ValueLocal(v) {
    return v === S2_UNUSED || v === S2_TODO || v === S2_WA
        || v === S2_AFTER || v === S2_DURING || v === S2_IGNORE;
}
// ----------------------------------------------------------------
// 容器（C/W/S）完成状态
// ----------------------------------------------------------------

/**
 * 容器的 statusComplete2：由子树里所有 P 的分档推出。
 * `4`（忽略）是**用户按下的覆盖**，不在这里 —— 调用方命中覆盖时直接返回 4。
 *
 * @returns {0|1|2|3} 0 未动 / 1 有接触 / 2 全部处理 / 3 AK
 */
export function statusComplete2Of(b) {
    if (b.total === 0) return 0;
    if (b.passedIgnore === b.total) return 3;
    if (b.processedIgnore === b.total) return 2;
    if (b.passedIgnore > 0) return 1;
    return 0;
}

// ----------------------------------------------------------------
// C（比赛）分档
// ----------------------------------------------------------------

/** 统计栏 `C:AK/处理/接触/忽略/总` 的那五档 */
export function newContestBuckets() {
    return { total: 0, ak: 0, proc: 0, contact: 0, ign: 0 };
}

/** 把一场 C 计入分档（严格 `===`：非法值不落进任何档） */
export function addContest(b, statusComplete2) {
    b.total++;
    if (statusComplete2 === 3) b.ak++;
    if (statusComplete2 === 2 || statusComplete2 === 3) b.proc++;
    if (statusComplete2 === 1 || statusComplete2 === 2 || statusComplete2 === 3) b.contact++;
    if (statusComplete2 === 1 || statusComplete2 === 2
        || statusComplete2 === 3 || statusComplete2 === 4) b.ign++;
    return b;
}

// ----------------------------------------------------------------
// P.status2 的算法
// ----------------------------------------------------------------

/**
 * P.status2 = 范围内有没有提交 / 有没有**赛时**的 AC，外加用户按下的覆盖。
 *
 * 判据由 R 的 `submitKind` 说话 —— **范围内只要有一发 `赛时` 的 AC，就是 4 赛时通过**；
 * 全是 VP / 补题的 AC 才是 3。
 *
 * @param {boolean} hasSub - 范围内有没有 R 子节点
 * @param {boolean} hasAC - 范围内有没有 AC 的 R 子节点
 * @param {*} pin - 用户覆盖（`5` 忽略 / `4` 赛时通过 / `1` 待写；其它/缺省 = 无覆盖）
 * @param {boolean} [hasDuringAC] - 范围内有没有**赛时**的 AC（默认 false = 老数据/判不出来）
 */
export function pStatus2(hasSub, hasAC, pin, hasDuringAC = false) {
    if (pin === S2_IGNORE) return S2_IGNORE;             // 忽略：无条件保留
    if (hasAC) return (hasDuringAC || pin === S2_DURING) ? S2_DURING : S2_AFTER;
    if (hasSub) return S2_WA;
    return pin === S2_TODO ? S2_TODO : S2_UNUSED;
}
