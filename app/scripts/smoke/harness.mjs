// ================================================================
// 冒烟测试断言与报告（scripts/smoke/harness.mjs）
// 职责：极简断言 + 通过/失败计数 + 非零退出码
// 说明：冒烟测试是普通脚本（不是 node:test 用例），因为它们需要在
//       import 被测模块**之前**先装好 DOM 桩与全局变量。
// ================================================================

let passed = 0;
const failures = [];
let section = '(未分组)';

// ★ 计时仪表（`process.env.SMOKE_MARKS` 打开时才有输出，平时**零成本**）：
//   用来回答"这个 smoke 文件的时间花在哪一段" —— 排查"某个文件特别慢"时先跑它。
const MARKS = !!process.env.SMOKE_MARKS;
const markStart = Date.now();
let lastMark = markStart;
const mark = (what) => {
    if (!MARKS) return;
    const now = Date.now();
    console.error(`[mark] +${String(now - lastMark).padStart(5)}ms (累计 ${String(now - markStart).padStart(6)}ms) ${what}`);
    lastMark = now;
};

/** 开启一个分组（用于输出可读性） */
export function group(title) {
    mark(`分组「${title}」`);
    section = title;
    console.log(`\n=== ${title} ===`);
}

/**
 * 摆节点状态（**测试专用**）：事务之外不许就地改节点。
 *
 * 来由：节点对象是**冻的**（`core/model/state.js` 的 `freezeNodes`），
 * 那正是 Immer 肯跳过"深走整棵树"的开关（真包实测 389ms → 31ms）。
 * 冻上之后 `AppState.nodes[id].xxx = v` 会**当场抛错** —— 那本来就是 bug（不入历史、不落盘），
 * 不抛错时同样静默。测试里要摆状态就走这个口。
 *
 * ⚠️ 它**不是**"一次真实事务"：只做 `produce` + `applyState`（= 改状态 + 补冻），
 *    **没有** `executeTransaction` 的校验 / 历史入栈 / 标脏 / 落盘 / 刷新
 *    （`transaction/executor.js`）。要验那些就别用它，直接跑 `execute(...)`。
 *
 * @param {Object} state - 目标 state（通常是 AppState 单例）
 * @param {(draft:Object) => void} recipe - 用 draft 写，和正式代码同一套姿势
 */
export async function patchNodes(state, recipe) {
    const { produce } = await import('immer');
    const { applyState } = await import('../../src/transaction/history.js');
    applyState(state, produce(state, recipe));
}

/** 断言为真 */
export function ok(condition, label, extra = '') {
    if (condition) {
        passed++;
        console.log(`  ✔ ${label}${extra ? '  ' + extra : ''}`);
    } else {
        failures.push(`${section} → ${label}${extra ? '  ' + extra : ''}`);
        console.log(`  ✖ ${label}${extra ? '  ' + extra : ''}`);
    }
}

/** 断言相等（浅比较，用于字符串/数字/布尔） */
export function eq(actual, expected, label) {
    ok(actual === expected, label, `(期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)})`);
}

/** 断言深相等（数组 / 对象；按 JSON 结构比，够用且不需要引入 assert 模块） */
export function deepEq(actual, expected, label) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    ok(a === b, label, a === b ? '' : `\n      期望 ${b}\n      实际 ${a}`);
}

/**
 * 输出汇总并退出：有任何失败 ⇒ 退出码 1；**一项断言都没跑也 ⇒ 退出码 1**。
 *
 * ★ `passed + failures === 0` 不许走"全部通过"并 `exit 0`
 *   —— 于是一个冒烟文件因为提前 `return` / 条件不成立**什么都没检查**，仍然算绿
 *   （与 `crate-invariants.smoke.mjs` 里 `if (p) {...}` 那种整块静默跳过同型）。
 *   判据：**"通过"必须是"我检查了一个可观察的结果"**。
 */
export function report() {
    mark(`收尾（共 ${passed + failures.length} 项断言）`);
    console.log('\n' + '='.repeat(62));
    if (passed + failures.length === 0) {
        console.log('❌ 这个冒烟文件**一项断言都没跑**（提前 return / 条件不成立？）—— 不算通过');
        process.exit(1);
    }
    if (failures.length === 0) {
        console.log(`✅ 冒烟测试全部通过：${passed} 项`);
        process.exit(0);
    }
    console.log(`❌ ${failures.length} 项失败（共 ${passed + failures.length} 项）：`);
    for (const f of failures) console.log(`  • ${f}`);
    process.exit(1);
}
