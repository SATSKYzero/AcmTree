// ================================================================
// 统计栏"延迟一拍"的对拍
//
// 为什么值得一条冒烟：统计栏现在**先把上一次那串画上、过一拍（200ms）再算准**
// （`view/stats.js` 的 `getGlobalStatsSoon`）—— 这是最容易"悄悄坏"的一类改动：
//   ① 数据变了却一拍之后**没刷新** ⇒ 统计栏永远停在旧数字（用户看半天以为数据没生效）；
//   ② 数据没变却每次都排重算 ⇒ 白花钱（延迟那笔的开销全白付）；
//   ③ 算挂了抛在**定时器**里 ⇒ 变成没人接的异常（事务早提交了，没有可回滚的东西）。
// 所以这里真等一拍，验："过一拍**真的**变成新数字" / "同一份数据不重复排" / "写进了 DOM"。
//
// ⚠️ 时钟是真的 `setTimeout(200)`：等待写宽一点（250ms），别把它做成 flaky。
// ================================================================
import { installDom, makeContainer } from './dom.mjs';
import { group, ok, eq, report } from './harness.mjs';

const body = installDom();
const app = makeContainer(body, 'app');
makeContainer(app, 'tree-stats');          // `paintStatsNumbers` 要写的那个格子

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} };

const { AppState, replaceState } = await import('../../src/shell/state.js');
const { execute } = await import('../../src/shell/executor.js');
const { createInitialState } = await import('../../src/core/model/state.js');
const { addChild } = await import('../../src/core/ops/tree.js');
const { updateP } = await import('../../src/core/ops/node.js');
const { getGlobalStats, getGlobalStatsSoon } = await import('../../src/view/stats.js');
const { paintStatsNumbers } = await import('../../src/ui/folder/folderShared.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 等到"那一拍"落地：定时器是 200ms，给足余量（`run-smoke.mjs` 默认 4 路并行，太紧会 flaky）
const SETTLE = 320;

replaceState(createInitialState());
let P_ID = '';
await execute((d) => {
    const kid = (parentId, type, name) => {
        addChild(d, parentId, type, name);
        const ids = d.childOrder[parentId];
        return ids[ids.length - 1];
    };
    const w = kid(AppState.rootId, 'W', '平台');
    const s = kid(w, 'S', '系列');
    const c = kid(s, 'C', '比赛');
    P_ID = kid(c, 'P', '题目');
}, { skipHistory: true, validate: false, skipPersist: true });
await execute((d) => updateP(d, P_ID, { status1: 1 }),
    { skipHistory: true, validate: false, skipPersist: true });

const el = document.getElementById('tree-stats');
const text = () => (el ? el.innerHTML.replace(/<[^>]*>/g, '|') : '(没有这个格子)');

group('统计栏：先画旧数、过一拍再算准');
{
    // ---- ① 第一拍（从没算过）：没有"上一次"可画 ⇒ 必须**同步给准数**，不能先给空 ----
    const paints = [];
    const first = getGlobalStatsSoon(AppState, (s) => paints.push(s));
    eq(first.cStr + first.pStr, getGlobalStats(AppState).cStr + getGlobalStats(AppState).pStr,
        '★ 启动第一屏：等不了 ⇒ 直接给**算准的**那串（不是空白占位）');
    eq(paints.length, 0, '第一拍不需要回调（渲染方自己就用返回值画）');
    paintStatsNumbers(first);
    ok(text().includes('P:'), '画进 DOM 的那串长得对：' + text());

    // ---- ② 数据一变：立刻给的是**上一拍**那串，同时排一次重算 ----
    // ⚠️ 这里**不许**先调 `getGlobalStats()` 去"拿期望值" —— 那是同步入口，会把缓存刷新成新数，
    //    于是 `getGlobalStatsSoon` 就变成"命中缓存、直接给新数"（探针自己把要验的行为抹掉了，
    //    第一版就踩了这个）。期望值一律等**回调之后**再取。
    const oldText = first.cStr + first.pStr;
    await execute((d) => updateP(d, P_ID, { status1: 0 }),
        { skipHistory: true, validate: false, skipPersist: true });
    const soon = getGlobalStatsSoon(AppState, (s) => paints.push(s));
    eq(soon.cStr + soon.pStr, oldText, '★ 点击那一帧先画**上一次**那串（不为了统计卡住响应）');
    eq(paints.length, 0, '还没到点 ⇒ 还没回调');
    eq(text().replace(/[|]/g, ''), oldText.replace(/[|]/g, ''),
        '（前提）DOM 里此刻还是旧数 —— 所以下面那次回调必须把它换掉');

    // ---- ③ 过一拍：回调拿到的是**新数**（确实重算了，不是空转），且真的写进了 DOM ----
    await sleep(SETTLE);
    eq(paints.length, 1, '★ 过一拍回调一次');
    const newText = getGlobalStats(AppState);
    const newStr = newText.cStr + newText.pStr;
    ok(newStr !== oldText, '（前提）重算之后数字**确实变了**：' + oldText + ' → ' + newStr);
    eq(paints[0].cStr + paints[0].pStr, newStr, '★ 回调给的必须是**重算后**的那串（不是旧数）');
    for (const p of paints) paintStatsNumbers(p);
    eq(text().replace(/[|]/g, ''), newStr.replace(/[|]/g, ''),
        '★ DOM 里的数字也换了（"没刷新"这一类 bug 就钉在这儿）');

    // ---- ④ 数据没变：不许再排重算（白花钱），而且直接给新鲜那份 ----
    const before = paints.length;
    const again = getGlobalStatsSoon(AppState, (s) => paints.push(s));
    eq(again.cStr + again.pStr, newStr, '数据没动 ⇒ 直接给**新鲜**的那份（不必等）');
    await sleep(SETTLE);
    eq(paints.length, before, '★ 数据没动就不排重算（那条"每次都白算一遍"的路被堵住了）');

    // ---- ⑤ 连点：同一拍里排两次，两个回调都拿到**同一份**最新数 ----
    //
    // ⚠️ 这条标签若写成"合掉了一次重算"就是**空转**的：`paints` 里没有
    //    "算了几次"这个可观察量（`getGlobalStats` 是模块内函数，测试没法装计数器）——
    //    把 `statsFlush` 改成"给每个 pending 各算一次"它照样绿。所以这里：
    //      · 标签只说**它能验的**（两个回调都在、拿到同一份最新数、且在**同一次 flush** 里）；
    //      · 用时间戳钉"同一拍"（同一个 flush 里两个回调是背靠背调的，差 < 1ms）；
    //      · "只算一次"由实现（`statsFlush` 里只有一处 `getGlobalStats`）保证 —— 那是**代码结构**，
    //        不假装这里有行为断言。
    await execute((d) => updateP(d, P_ID, { status1: 1 }),
        { skipHistory: true, validate: false, skipPersist: true });
    const times = paints.length;
    const stamps = [];
    const stamp = (s) => { paints.push(s); stamps.push(performance.now()); };
    getGlobalStatsSoon(AppState, stamp);
    getGlobalStatsSoon(AppState, stamp);
    await sleep(SETTLE);
    eq(paints.length, times + 2, '两个回调都在（各自把自己那块刷掉）');
    const fresh = getGlobalStats(AppState);
    eq(paints[times].cStr + paints[times].pStr, fresh.cStr + fresh.pStr, '第一次回调拿到的是最新数');
    eq(paints[times + 1].cStr + paints[times + 1].pStr, fresh.cStr + fresh.pStr, '第二次回调拿到的是**同一份**');
    ok(stamps.length === 2 && Math.abs(stamps[1] - stamps[0]) < 1,
        `★ 两个回调在**同一次 flush**里（间隔 ${(stamps[1] - stamps[0]).toFixed(2)}ms）—— 这是"同一拍"能观察到的那部分`);
}

report('统计栏延迟一拍');
