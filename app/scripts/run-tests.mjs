#!/usr/bin/env node
// ================================================================
// 测试运行器（scripts/run-tests.mjs）
// 职责：跑 src/test/*.test.js，汇总结果
//
// 为什么不直接用 `node --test`：
//   Node 的 --test 为每个文件 spawn 子进程，并用**管道**捕获输出。受限沙箱禁止
//   打开命名管道 ⇒ 整个测试跑不起来并报 `Error: spawn EPERM`（表现是
//   "tests 0 / fail 1"，很容易被误读成测试本身失败）。
//
// 本运行器的做法：**仍然一个文件一个进程**（模块级状态互不污染），但输出
// **重定向到临时文件**（不开管道）⇒ 既不受沙箱限制，还能**并行**跑：
//   并行度默认 `min(核数, 8)`（见 `lib/runFiles.mjs`），`JOBS=1` 退回串行。
//   ⚠️ 出问题时先试 `JOBS=1`，用来判断"是不是并行本身引起的"。
//
// 用法：
//   npm test                     跑全部（默认并行，见 `defaultJobs`）
//   npm test -- contests         只跑文件名含 "contests" 的
//   JOBS=1 npm test              串行
//   JOBS=12 npm test             指定并行度
// ================================================================
import { readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { runFiles, report } from './lib/runFiles.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testDir = path.join(root, 'src', 'test');

// ---- 过滤参数：按子串匹配文件名 ----
const filters = process.argv.slice(2).filter(a => !a.startsWith('-'));

if (!existsSync(testDir)) {
    console.error(`[run-tests] 找不到测试目录: ${testDir}`);
    process.exit(1);
}

let files = readdirSync(testDir).filter(f => f.endsWith('.test.js')).sort();
if (filters.length > 0) {
    files = files.filter(f => filters.some(k => f.includes(k)));
}

if (files.length === 0) {
    console.error(filters.length > 0
        ? `[run-tests] 没有匹配 ${filters.join(', ')} 的测试文件`
        : `[run-tests] ${testDir} 下没有 *.test.js`);
    process.exit(1);
}

const started = Date.now();
console.log(`[run-tests] 共 ${files.length} 个测试文件\n`);

const { results, jobs } = await runFiles(files, f => [path.join(testDir, f)], root);
const failed = report(results, 'run-tests', jobs);

const seconds = ((Date.now() - started) / 1000).toFixed(1);
console.log('='.repeat(62));

if (failed.length === 0) {
    console.log(`[run-tests] ✅ 全部通过：${files.length} 个文件，耗时 ${seconds}s（并行 ${jobs} 路）`);
    process.exit(0);
}

console.log(`[run-tests] ❌ ${failed.length}/${files.length} 个文件失败，耗时 ${seconds}s（并行 ${jobs} 路）`);
for (const f of failed) {
    console.log(`  • ${f.file} → ${f.reason}`);
}
console.log('\n单独重跑某个文件：');
// ⚠️ 打**相对当前目录**的路径（从仓库根跑 npm ⇒ `app\src\test\…`）：机械层搬进 `app/` 之后，
//    写死的 `src/test/…` 已经指不到了（2026-10-17）。
console.log(`  node ${path.relative(process.cwd(), path.join(testDir, failed[0].file))}`);
process.exit(1);
