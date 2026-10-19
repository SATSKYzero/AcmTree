// ================================================================
// 诊断日志的**唯一开关**（`utils/diag.js`）
//
// 来由（用户 2026-10-18）："诊断日志加全局开关或控制台消息优先级" ——
// 排查性能时撒的那些行（`[事务]` / `[切页]` / `[切页·事务]` / `[树布局]` /
// `[副页·段]` / `[副页渲染]` / `[计划栏]`）平时不该出现在控制台里。
//
// **怎么开/关**（不用改代码）：
//   · 开：控制台里 `localStorage.DSH_DIAG = '1'`，然后**刷新**；
//   · 关：`localStorage.removeItem('DSH_DIAG')`，刷新。
//   ⚠️ 只在**第一次问它的时候**读一遍 `localStorage` 并记住（`cached`）——
//      热路径上（每次切页/每帧）不做 `localStorage` 查询；代价是"改了要刷新"。
//
// ⚠️ 新加诊断行**只许走这里**：裸 `console.info` 会被 `src/test/perfGuards.test.js` 判红
//    （那条守卫就是为"又冒出没开关的日志"写的）。`console.error` / `console.warn` 不受限
//    —— 报错本来就该一直看得见。
// ⚠️ 标签照旧用那几个中文段名：控制台里按标签过滤（`-[树布局]`）是"消息优先级"之外的另一半。
// ⚠️ 本文件**不 import 任何东西**（`utils/` 最底层，`test/` 也直接引它）。
// ================================================================

let cached = null;

/** 诊断日志开着吗（默认关） */
export function diagOn() {
    if (cached === null) {
        try {
            cached = (typeof localStorage !== 'undefined') && localStorage.getItem('DSH_DIAG') === '1';
        } catch {
            cached = false;           // 隐私模式 / 没有 localStorage（Node 单测）⇒ 关着
        }
    }
    return cached;
}

/**
 * 打一行诊断（**唯一入口**）。关着的时候**什么都不做**（连时间戳都不算）。
 * @param {string} tag 段名（`事务` / `树布局` / `副页·段` …，会显示成 `[tag]`）
 * @param {string} msg 正文
 * @param {*} [data] 想一起丢进控制台的附加对象（省略就不带第二个参数）
 */
export function diag(tag, msg, data) {
    if (!diagOn()) return;
    if (data === undefined) console.info(`[${tag}] ${msg}`);
    else console.info(`[${tag}] ${msg}`, data);
}

/** 当前时刻（`performance.now()`；没它就退回 `Date.now()`）—— 计时的起点 */
export function nowMs() {
    return ((typeof performance !== 'undefined') && performance.now) ? performance.now() : Date.now();
}

/** 从 `t0` 到现在多少毫秒（**取整**：诊断行里不需要小数） */
export function msSince(t0) {
    return Math.round(nowMs() - t0);
}
