// ================================================================
// 长处理自测（utils/longHandler.js）
//
// 职责：量出一次交互卡了多久，超过阈值就照浏览器那条 Violation 的样式打一行。
//
// 为什么自己来：浏览器那条 `[Violation] 'click' handler took xxxms` 的阈值是
//   **Blink 里的常量**（`PerformanceMonitor`），页面改不了。我们要按自己的阈值看 ——
//   现在是 `LONG_HANDLER_THRESHOLD_MS`（`A_constants.js`，默认 **50ms**）。
//
// ★ 三个数各有出处，**别混**（实测同一次 click：内置 254ms / 本模块 327ms —— 差的那 73ms
//   不是误差，是"输入延迟"）：
//   · **处理器**（主口径）= Event Timing 的 `processingEnd − processingStart`。
//     这就是 Chrome 内置那条 "handler took" 量的**同一段**（处理器自己跑的那段），
//     而且**不受 `stopPropagation` 影响** —— 实测踩到过：关闭按钮的处理器 `stopPropagation`
//     了，靠"冒泡走到 window"去收尾根本收不到。
//   · **输入延迟** = `processingStart − startTime`。`startTime` 是**事件被创建的时刻**（输入到了），
//     处理器要等主线程空出来才轮到它 ⇒ 这一截是"事件排队等了多久"（主线程**本来就忙**的信号）。
//     用 `− startTime` 当处理器时长就会虚高这一截（327 vs 254 就是这么来的）。
//   · **派发到下一帧** = 同一条目的 `duration`（事件开始 → 下一次渲染机会）。
//     处理器不慢、但重画慢的情况，看这个数。
//
// 老浏览器没有 Event Timing（`PerformanceObserver` 不认 `type: 'event'`）⇒ 退回
//   "捕获阶段记起点 + `setTimeout(0)` 收尾"，那时报的是**整个同步任务**
//   （派发 + 之后的微任务/尾巴）—— 比内置那个数**大**是正常的（量的不是同一段）。
//
// ⚠️ 只量同步部分：`await` 之后的工作不在里面 —— 那本来就该异步，把长任务留在主线程才是问题。
// ⚠️ 只观测，不拦截、不改行为（不 `preventDefault`、不改监听器）。
//
// ★ **两处防刷屏**（实测不加会一次卡顿刷 8 条：`pointerleave/pointerover/mouseover/…` 各一条）：
//   · 只报**交互**那几种事件（`WATCHED`）；鼠标移来移去那一家**不收**（内置那条也不报它们）；
//   · **同一次卡顿并成一条**：与上一波首尾相接（`startTime ≤ 上次结束 + 2ms`）的条目并进去，
//     一行里列出"这次卡顿里的 N 个事件"，名字取最该去修的那个（`click > keydown > …`）。
// ================================================================
import { LONG_HANDLER_THRESHOLD_MS } from '../A_constants.js';

/** 看哪几种交互。
 *  ⚠️ **鼠标移来移去那一家（`mouseover/mouseout/pointerover/pointerout/mouseenter/…`）故意不收**：
 *     一次卡顿会让它们**每个都报一条**（实测同一次卡顿里 `pointerleave/pointerover/mouseover/…`
 *     各报 198ms），控制台被淹掉；内置那条 Violation 也不报它们。 */
const WATCHED = ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup',
    'keydown', 'keyup', 'change', 'input', 'contextmenu'];

/** 一次卡顿里出现多个事件时，这一行用哪个名字（挑最该去修的那个） */
const NAME_PRIORITY = ['click', 'keydown', 'change', 'input', 'dblclick'];

let installed = false;

/** 正在攒的这一次卡顿（同一次卡顿里的多个事件并成一条） */
let pending = null;
let flushTimer = null;

let lastEnd = 0;
/**
 * 最近这一次卡顿的窗口（**一看到就记，与"报没报出去"无关**）。
 * 为什么不能用"报出去时"那个时刻记：`LoAF`（帧归因）是**帧一结束**就送来的，
 * 而这一行是"静下来 50ms"才打的 ⇒ 归因那时窗口还不存在（实测踩到：归因永远不出现）。
 * `attributed` = 这一波已经归因过了，别对同一波重复打。
 */
let lastBurst = null;

/** 给日志一句"点在哪"：标签#id.类 「前 12 个字」 */
function describe(el) {
    if (!el || el === document || el === window || !el.tagName) return '';
    const tag = String(el.tagName).toLowerCase();
    const id = el.id ? `#${el.id}` : '';
    const cls = (typeof el.className === 'string' && el.className.trim())
        ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    const text = String(el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 12);
    return `${tag}${id}${cls}${text ? ` 「${text}」` : ''}`;
}

/** 这一波静下来之后报一条（多个事件并成一行） */
function flushPending() {
    clearTimeout(flushTimer);
    flushTimer = null;
    const p = pending;
    pending = null;
    if (!p) return;
    const names = [...p.names];
    let name = names[0];
    for (const prefer of NAME_PRIORITY) {
        if (p.names.has(prefer)) { name = prefer; break; }
    }
    console.warn(`[Violation] '${name}' handler took ${p.proc.toFixed(0)}ms`
        + (p.wholeTask
            ? `（整个同步任务 ${p.proc.toFixed(0)}ms —— 本浏览器没有 Event Timing，`
                + '这个数含处理器排下的微任务/尾巴，比内置那条大是正常的'
            : `（处理器 ${p.proc.toFixed(0)}ms，输入延迟 ${(p.inputDelay || 0).toFixed(0)}ms，`
                + `派发到下一帧 ${p.dur.toFixed(0)}ms`)
        + (names.length > 1 ? `；同一次卡顿里的 ${names.length} 个事件：${names.join('/')}` : '')
        + `；应用自测阈值 ${LONG_HANDLER_THRESHOLD_MS}ms）`
        + (p.target ? ` ← ${p.target}` : ''));
}

/** 主口径：Event Timing（`processingEnd − startTime` = Chrome 内置那条量的同一段） */
function installEventTiming() {
    if (typeof PerformanceObserver === 'undefined' || typeof performance === 'undefined') return false;
    const onEntries = (list) => {
        for (const e of list.getEntries()) {
            if (!e || e.entryType !== 'event') continue;
            if (!e.processingEnd) continue;                       // 没这段数据的条目跳过
            if (!WATCHED.includes(e.name)) continue;              // 鼠标移来移去那一家不报
            // ⚠️ **与内置那条比的是这一笔**：`processingEnd − processingStart` = 处理器自己
            //    跑的那段。`startTime` 是**事件被创建的时刻**（输入到了），处理器要等主线程
            //    空出来才轮到它 ⇒ `− startTime` 会多出一截"输入延迟"（实测稳定多 ~73ms，
            //    正是 327 vs 254 / 302 vs 229 那个差）。
            const pStart = e.processingStart || e.startTime;
            const proc = e.processingEnd - pStart;
            const inputDelay = Math.max(0, pStart - e.startTime);
            if (proc < LONG_HANDLER_THRESHOLD_MS) continue;
            const dur = e.duration || 0;
            const end = e.startTime + dur;
            // 与上一波**接得上**（同一次卡顿里又派发了一个事件）⇒ 并进同一条，别刷屏
            if (pending && e.startTime <= lastEnd + 2) {
                pending.proc = Math.max(pending.proc, proc);
                pending.dur = Math.max(pending.dur, dur);
                pending.inputDelay = Math.max(pending.inputDelay || 0, inputDelay);
                pending.start = Math.min(pending.start, e.startTime);
                pending.names.add(e.name);
                if (!pending.target && e.target) pending.target = describe(e.target);
                if (lastBurst) {
                    lastBurst.start = Math.min(lastBurst.start, e.startTime);
                    lastBurst.end = Math.max(lastBurst.end, end);
                }
            } else {
                flushPending();
                pending = {
                    proc, dur, inputDelay, start: e.startTime, names: new Set([e.name]),
                    target: e.target ? describe(e.target) : ''
                };
                lastBurst = { start: e.startTime, end, attributed: false };
            }
            lastEnd = Math.max(lastEnd, end);
            clearTimeout(flushTimer);
            flushTimer = setTimeout(flushPending, 50);            // 这一波静下来再报（一行）
        }
    };
    let po = null;
    try {
        po = new PerformanceObserver(onEntries);
        // `durationThreshold` 的默认值是 104ms：不调低的话 50~104ms 这档根本不会产生条目
        po.observe({ type: 'event', buffered: true, durationThreshold: 16 });
        return true;
    } catch (err) {
        try {
            if (po) { po.disconnect(); po.observe({ type: 'event', buffered: true }); return true; }
        } catch (err2) { /* 不支持 ⇒ 走兜底 */ }
        return false;
    }
}

/**
 * 兜底（老浏览器）：捕获阶段记起点 + `setTimeout(0)` 收尾。
 * ⚠️ 那时报出来的是**整个同步任务**（派发 + 处理器排下的微任务/尾巴）⇒ 比内置那个数大。
 */
function installFallback() {
    if (typeof document === 'undefined') return;
    let open = null;
    for (const type of WATCHED) {
        document.addEventListener(type, (e) => {
            if (open) return;                                     // 嵌套派发按最外层算
            open = { type, target: describe(e && e.target), t0: performance.now() };
            setTimeout(() => {
                if (!open) return;
                const ev = open;
                open = null;
                const ms = performance.now() - ev.t0;
                if (ms < LONG_HANDLER_THRESHOLD_MS) return;
                if (pending && ev.t0 <= lastEnd + 2) {
                    pending.proc = Math.max(pending.proc, ms);
                    pending.names.add(ev.type);
                    pending.start = Math.min(pending.start, ev.t0);
                    if (!pending.target && ev.target) pending.target = ev.target;
                    if (lastBurst) lastBurst.end = Math.max(lastBurst.end, performance.now());
                } else {
                    flushPending();
                    pending = {
                        proc: ms, dur: ms, start: ev.t0, names: new Set([ev.type]),
                        target: ev.target, wholeTask: true
                    };
                    lastBurst = { start: ev.t0, end: performance.now(), attributed: false };
                }
                lastEnd = Math.max(lastEnd, performance.now());
                clearTimeout(flushTimer);
                flushTimer = setTimeout(flushPending, 50);
            }, 0);
        }, true);
    }
}

/**
 * 帧归因（LoAF：`long-animation-frame`）。
 *
 * 为什么需要它：内置那条与"处理器"那笔**都只给一个总数**。想知道"这 74ms 到底是谁花的"
 * （应用的哪个文件 / **扩展** / 样式布局），只有 LoAF 直接给：条目里的 `scripts[]` 逐条带
 * `sourceURL` / `sourceFunctionName` / `duration`，还有 `styleAndLayoutStart`。
 * ⚠️ 只报**刚报过的那一次卡顿**所在的那一帧，别把每一帧都刷出来。
 */
function installFrameAttribution() {
    if (typeof PerformanceObserver === 'undefined') return;
    try {
        const po = new PerformanceObserver((list) => {
            for (const e of list.getEntries()) {
                if (!e || e.entryType !== 'long-animation-frame') continue;
                reportFrame(e);
            }
        });
        po.observe({ type: 'long-animation-frame', buffered: true });
    } catch (err) { /* 不支持就算了：这只是归因，主口径不靠它 */ }
}

/** URL 缩成"最后两段"，扩展脚本额外标出来（一眼看出是不是扩展） */
function shortUrl(u) {
    if (!u) return '(未知)';
    const s = String(u);
    const isExt = /^(chrome|moz|safari-web)-extension:\/\//.test(s);
    const tail = s.split('/').filter(Boolean).slice(-2).join('/');
    return (isExt ? '扩展 ' : '') + tail;
}

function reportFrame(e) {
    const win = lastBurst;
    const dur = e.duration || 0;
    const frameEnd = e.startTime + dur;
    if (!win || win.attributed) return;
    if (frameEnd < win.start - 4 || e.startTime > win.end + 4) return;
    win.attributed = true;
    const scripts = (e.scripts || [])
        .filter(s => (s.duration || 0) >= 5)
        .sort((a, b) => (b.duration || 0) - (a.duration || 0))
        .slice(0, 4)
        .map(s => `${shortUrl(s.sourceURL)}${s.sourceFunctionName ? `:${s.sourceFunctionName}` : ''} `
            + `${(s.duration || 0).toFixed(0)}ms`);
    const layout = Math.max(0, frameEnd - (e.styleAndLayoutStart || frameEnd));
    console.warn(`[Violation] 帧归因（这一帧 ${dur.toFixed(0)}ms）：`
        + (scripts.length ? scripts.join(' / ') : '没有 ≥5ms 的脚本')
        + `；样式布局 ${layout.toFixed(0)}ms`);
}

/**
 * 装上长处理自测。**幂等**：重复调用只装一次。
 * 纯 Node 环境（没有 `performance`）⇒ 什么都不做。
 */
export function installLongHandlerMonitor() {
    if (installed) return;
    if (typeof performance === 'undefined') return;
    installed = true;
    if (!installEventTiming()) installFallback();
    installFrameAttribution();
}
