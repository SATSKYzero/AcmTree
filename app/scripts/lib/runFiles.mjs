// ================================================================
// 逐文件跑测试（`scripts/lib/runFiles.mjs`）—— **可并行**，输出仍按文件成块
//
// 为什么要它（测试要能并行跑）：
//   顺序跑时每跑一个文件都要起一次 node、再导入一遍应用/夹具 ⇒ 大头是"起进程 + 导入"，
//   而不是测试本身。**2026-10-13 实测（12 核）**：
//     · 单测 102 文件：串行… → 4 路 7.5s → 8 路 **7.0s**
//     · 冒烟 41 文件：4 路 15.1s → 8 路 13.0s → **最慢先发车（见下）10.5s**
//   ⇒ **"加并行度"到 8 就吃满了**（8→12 无收益）；真正省时间的是**调度**：
//     墙钟 ≈ 最长那条流水线，所以先把最慢的文件发车（`TIMING_FILE` 那段）。
//
// 两条纪律不变：
//   ① **一个文件一个进程**（模块级状态仍然互不污染，与 `node --test` 语义一致）；
//   ② 沙箱里**不能开管道**（`stdio: 'pipe'` 会 EPERM，见两个 runner 的注释）⇒
//      子进程的输出**重定向到临时文件**，退出后由父进程读出来打印 ——
//      好处是输出天然按文件分块，别的文件的日志不会插进来。
//
// ⚠️ 想退回串行：`JOBS=1`（出问题时先试这个，用来判断"是不是并行本身引起的"）。
// ================================================================
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, openSync, closeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 上几次各文件耗时的**缓存**（`.run-timings.json`，**不进仓库**）。
 *
 * 为什么需要它：并行跑测试的墙钟时间 ≈ **最长那条流水线**。文件**一个进程一个**，
 * 谁先起谁后起由调度决定 —— 把**最慢的文件先发车**，尾巴才不会拖到最后
 * （2026-10-13 实测：本仓 41 个冒烟文件里 `reveal-node` 10.3s、`auto-import` 7.4s、
 *  其余大多 < 1s ⇒ 不排序的话这两条就是在最后才开始跑，整个套件跟着它们走）。
 *
 * ⚠️ 缓存**只用来排序**，不参与任何断言；丢了也没有正确性影响（只是排序变回文件名字典序）。
 */
const TIMING_FILE = path.join(os.tmpdir(), 'acmtree-run-timings.json');

function readTimings() {
    try {
        const raw = JSON.parse(readFileSync(TIMING_FILE, 'utf8'));
        return (raw && typeof raw === 'object') ? raw : {};
    } catch {
        return {};
    }
}

function writeTimings(map) {
    try {
        writeFileSync(TIMING_FILE, JSON.stringify(map));
    } catch { /* 写不了就算了（只影响下次的调度顺序） */ }
}

/** 默认并行度：`min(可用核数, 8)`。
 *
 * ⚠️ **别指望"并行度再翻倍就能快一倍"**（2026-10-13 实测，本机 12 核）：
 *   · 单测 102 文件：4 路 **7.5s** → 8 路 **7.0s** → 12 路 **7.0s**
 *   · 冒烟 41 文件：4 路 **15.1s** → 8 路 **13.0s** → 12 路 **13.1s**
 *   ⇒ 大头是**每个文件自己的活**（每个文件一个进程 + 导入应用夹具 + 建夹具 + 断言），
 *     不是"起 node"（实测空转 node+register 只要 0.11s）。
 *   ⇒ 所以真正能压时间的是两件事：**① 最慢的文件先发车**（本文件下面的排序）；
 *     ② 把"某个文件自己为什么慢"查清（用 `SMOKE_MARKS=1` 看分段耗时）。
 */
export function defaultJobs() {
    const asked = Number(process.env.JOBS);
    if (Number.isFinite(asked) && asked > 0) return Math.floor(asked);
    const cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : 4;
    return Math.max(1, Math.min(8, cores));
}

/**
 * 跑一批文件（每个文件一个进程，最多 `jobs` 个同时跑）。
 *
 * @param {string[]} files - 文件名（只用于打印/记录）
 * @param {(file: string) => string[]} argvFor - 这个文件的命令行参数
 * @param {string} cwd - 工作目录
 * @returns {Promise<Array<{file, code, signal, error, text}>>} 与 `files` **同序**
 */
export async function runFiles(files, argvFor, cwd) {
    const jobs = Math.max(1, Math.min(defaultJobs(), files.length || 1));
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'acm-run-'));
    const results = new Array(files.length);

    // ★ 调度：**最慢的先发车**（时间取上次跑这份文件用了多久；没记录按 1200ms 估）
    const timings = readTimings();
    const order = files.map((f, i) => i)
        .sort((a, b) => (timings[files[b]] || 1200) - (timings[files[a]] || 1200));
    let next = 0;

    const worker = async () => {
        for (;;) {
            const slot = next++;
            if (slot >= order.length) return;
            const i = order[slot];
            const file = files[i];
            const log = path.join(tmpRoot, `${i}.log`);
            const fd = openSync(log, 'w');
            const started = Date.now();
            const got = await new Promise((resolve) => {
                const child = spawn(process.execPath, argvFor(file), { stdio: ['ignore', fd, fd], cwd });
                child.on('close', (code, signal) => resolve({ code, signal }));
                child.on('error', (error) => resolve({ error }));
            });
            closeSync(fd);
            timings[file] = Date.now() - started;
            results[i] = { file, ...got, text: readFileSync(log, 'utf8') };
        }
    };

    await Promise.all(Array.from({ length: jobs }, worker));
    writeTimings(timings);
    rmSync(tmpRoot, { recursive: true, force: true });
    return { results, jobs };
}

/** 按顺序把每个文件那块输出打出来，并给出失败清单 */
export function report(results, label, jobs) {
    const failed = [];
    for (const r of results) {
        const rule = '─'.repeat(Math.max(0, 56 - r.file.length));
        process.stdout.write(`── ${r.file} ${rule}\n`);
        process.stdout.write(r.text.endsWith('\n') || r.text === '' ? r.text : `${r.text}\n`);
        process.stdout.write('\n');
        if (r.error) failed.push({ file: r.file, reason: r.error.message });
        else if (r.signal) failed.push({ file: r.file, reason: `被信号 ${r.signal} 终止` });
        else if (r.code !== 0) failed.push({ file: r.file, reason: `退出码 ${r.code}` });
    }
    return failed;
}
