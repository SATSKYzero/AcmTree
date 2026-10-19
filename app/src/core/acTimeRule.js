// ================================================================
// 题目 AC 时间「怎么挑」（core/acTimeRule.js）
//
// 职责：从一道题的所有 AC 时间里挑出**代表那一次**的那条。**唯一一处**。
// 为什么单独一个零依赖文件：它的消费者横跨四家，而且这四家**必须同义** ——
//   · `core/derive.js` 的 `derivePacTime`（派生表单条那条路）
//   · `core/derive.js` 的 `derivePtriple`（把 status2/acTime/lastSubmitTime 合并成一趟的性能路径）
//   · `core/autoComputeRules.js` 的 `computePacTime`（**写缓存字段**那条路）
//   · `core/groupValue.js` 的 `AGG_BUILDERS.acTime`（判重模式下「组那份」）
// 以前这四家各写一遍"排序取 [0]"，改规则就得四家一起改 —— 那正是会漏的地方。
//
// 规则（用户 2026-10-13 定，设计稿 `docs/ac-time-rule.md`）：
//   · `earliest`（默认）：全部 AC 里**最早**的那条（= 老行为，逐字不变）
//   · `latest`：全部 AC 里**最晚**的那条
//   · `cutoff`：给一个**截断时间**，取「不早于它」的那些里**最早**的一条；
//               一条都没有（这题的 AC 全在截断之前）⇒ 取**全部里最晚**的那条
//
// ⚠️ 时间一律是 `'YYYY.MM.DD HH:mm[:ss]'` 这种**可字典序比较**的字符串
//    （`utils/time.js` 头注：存储/比较带秒）。前两种规则**直接字符串比**，
//    只有 `cutoff` 才去规范化成 14 位数字键 —— 别给默认路径添开销。
// ================================================================

/** 空值占位符（`core/model/node.js` 那份；这里照抄是为了本模块**零依赖**） */
const TIME_PLACEHOLDER = '----.--.-- --:--';

/** 四种规则（**唯一名单**：设置页的下拉、校验、测试都读它） */
export const AC_TIME_RULES = Object.freeze(['earliest', 'latest', 'cutoff', 'cutoffIgnore']);

/** 设置页显示的文案 */
export const AC_TIME_RULE_LABELS = Object.freeze({
    earliest: '取最早（第一次 AC）',
    latest: '取最近（最后一次 AC）',
    cutoff: '取「截断时间」之后的最早一次',
    // ★ 第 4 种（用户 2026-10-13）：它不只是"挑哪一条"，而是**早于截断的提交整体不算**
    //   （口径见下面 `isSubmissionIgnored`）—— 用于"重复利用训练资源"。
    cutoffIgnore: '取「截断时间」之后的最早一次，并忽略截断前的所有提交'
});

export const DEFAULT_AC_TIME_RULE = 'earliest';

/** 截断值允许的位数 ⇒ 精度：8 位到天 / 12 位到分 / 14 位到秒 */
export const CUTOFF_DIGITS = Object.freeze([8, 12, 14]);

/**
 * 时间 → **14 位数字比较键**（`'2026.03.19 22:32:42'` ⇒ `'20260319223242'`）。
 * 认不出（空 / 占位符 / 没数字）⇒ `''`。
 * 缺的部分补 `0`：`'2025.01.15 10:00'`（到分）⇒ `'20250115100000'`。
 */
export function acTimeKey(time) {
    const digits = String(time === undefined || time === null ? '' : time).replace(/\D/g, '');
    if (!digits) return '';
    return digits.length >= 14 ? digits.slice(0, 14) : digits.padEnd(14, '0');
}

/**
 * 用户填的截断值 → 14 位数字键（认 8 / 12 / 14 位；别的形状 ⇒ `''` = 没设）。
 * 分隔符随便写（`2026-01-01` / `20260101` / `2026.01.01 12:00` 都认）—— 只数数字。
 */
export function normalizeAcTimeCutoff(raw) {
    const digits = String(raw === undefined || raw === null ? '' : raw).replace(/\D/g, '');
    if (!CUTOFF_DIGITS.includes(digits.length)) return '';
    return digits.padEnd(14, '0');
}

/**
 * 把 `state.settings` 归一成 `{ rule, cutoff }`（**判据只有这一处**）。
 *
 * ⚠️ 两种"填坏了"都**退回 `earliest`**，不抛错、不停在半个状态上：
 *   · `acTimeRule` 不是三个之一 / 没设（老存档）⇒ `earliest`；
 *   · `rule === 'cutoff'` 但截断值不是 8/12/14 位 ⇒ 也退回 `earliest`
 *     （否则"截断值空着"会变成"什么都挑不出来"）。
 */
export function acTimeRuleOf(settings) {
    const s = settings || {};
    const raw = String(s.acTimeRule || '');
    const rule = AC_TIME_RULES.includes(raw) ? raw : DEFAULT_AC_TIME_RULE;
    if (rule !== 'cutoff' && rule !== 'cutoffIgnore') return { rule, cutoff: '', ignoreBefore: false };
    const cutoff = normalizeAcTimeCutoff(s.acTimeCutoff);
    if (!cutoff) return { rule: DEFAULT_AC_TIME_RULE, cutoff: '', ignoreBefore: false };
    return { rule, cutoff, ignoreBefore: rule === 'cutoffIgnore' };
}

/** 归一化一条规则（`pickAcTime` / `isSubmissionIgnored` 共用；**判据只有这一处**） */
function normalizeRule(rule) {
    if (!rule || !AC_TIME_RULES.includes(rule.rule)) return { rule: DEFAULT_AC_TIME_RULE, cutoff: '', ignoreBefore: false };
    const cutoff = String(rule.cutoff || '');
    // ⚠️ `ignoreBefore` 只认规则名（别信传进来的那个布尔）：传参可以省，口径不能有两份
    return { rule: rule.rule, cutoff, ignoreBefore: rule.rule === 'cutoffIgnore' && !!cutoff };
}

/**
 * **一条提交算不算"被忽略"**（`v9.1.26`，用户 2026-10-13 定的第 4 种规则）。
 *
 * 用户的方向（原话）："提交**不存更多字段**，只是**按条件判断**（提交是否忽略）" ⇒
 *   它是**纯函数**：只看这条提交的时间与当前规则，**不在 R 节点上写任何标记**
 *   （写了就要迁移、要回代、还要担心它和"标记失效"那套混）。
 * 判据：**严格早于截断**的那些算忽略（`key < cutoff`）—— 与 `pickAcTime` 的
 *   "不早于截断才入选"正好互补（`>=` / `<`，两边不会同时算/同时不算）。
 *
 * 谁在用（**全部四处**，漏一处就是"树上一半算了、另一半没算"）：
 *   · `core/derive.js` 的 `derivePacTime` / `derivePtriple`（派生表：status2 / acTime / lastSubmitTime）；
 *   · `core/autoComputeRules.js` 的 `computePacTime` / `computePstatus2` / `computePlastSubmitTime`（写缓存）；
 *   · `view/builders.js`（R 行**整体变淡**，只影响观感）。
 *
 * @param {string} time 提交时间（`'YYYY.MM.DD HH:mm[:ss]'`）
 * @param {{rule:string,cutoff:string}} rule `acTimeRuleOf(settings)` 的结果
 * @returns {boolean}
 */
export function isSubmissionIgnored(time, rule) {
    const r = normalizeRule(rule);
    if (!r.ignoreBefore) return false;
    const k = acTimeKey(time);
    return !!k && k < r.cutoff;
}

/**
 * 从候选里挑一条。
 *
 * @param {string[]} values 候选时间（**可以**混着占位符 / 空串，这里自己滤）
 * @param {{rule:string, cutoff:string}} [rule] `acTimeRuleOf` 的结果；不给/坏了 ⇒ `earliest`
 * @param {string} [placeholder] 一个候选都没有时返回它
 * @returns {string}
 */
export function pickAcTime(values, rule, placeholder = TIME_PLACEHOLDER) {
    const list = [];
    for (const raw of (Array.isArray(values) ? values : [])) {
        const t = String(raw === undefined || raw === null ? '' : raw).trim();
        if (!t || t === TIME_PLACEHOLDER) continue;
        list.push(t);
    }
    if (!list.length) return placeholder;
    const r = normalizeRule(rule);

    // ★ `cutoffIgnore`：**先滤掉被忽略的，再取最早** —— "截断后没有"就是**没有**
    //   （与规则 3 的"没有就取最晚"不同：那只是"显示哪一次"，这个是真的不算）。
    //   ⚠️ 滤两遍是幂等的（调用方通常已经滤过）⇒ 这里再做一次是**保险**，不是两份口径。
    if (r.rule === 'cutoffIgnore') {
        const kept = list.filter(t => !isSubmissionIgnored(t, r));
        if (!kept.length) return placeholder;
        let best = kept[0];
        for (const t of kept) if (t < best) best = t;
        return best;
    }

    if (r.rule === 'latest') {
        let pick = list[0];
        for (const t of list) if (t > pick) pick = t;
        return pick;
    }
    if (r.rule !== 'cutoff') {                       // earliest（含一切兜底）
        let pick = list[0];
        for (const t of list) if (t < pick) pick = t;
        return pick;
    }
    // cutoff：**不早于截断**的那些里取最早；一条都没有 ⇒ 取全部里最晚
    let hit = '';
    let latest = list[0];
    for (const t of list) {
        if (t > latest) latest = t;
        const k = acTimeKey(t);
        if (k && k >= r.cutoff && (hit === '' || t < hit)) hit = t;
    }
    return hit || latest;
}
