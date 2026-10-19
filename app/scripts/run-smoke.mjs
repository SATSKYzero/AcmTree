// ================================================================
// 冒烟测试运行器（scripts/run-smoke.mjs）
// 职责：带 immer 解析钩子跑 scripts/smoke/*.smoke.mjs
//
// 与 `run-tests.mjs` 同一套：一个文件一个进程、输出重定向到临时文件（不开管道，沙箱限制），
// 因此可以**并行**（默认 `min(核数, 8)`，见 `lib/runFiles.mjs`；`JOBS=1` 退回串行）。
//   ⚠️ 冒烟会读 `acm-data/` 下的真产物、少数还会写临时文件；出问题时先试 `JOBS=1`
//      （用来判断"是不是并行本身引起的"）。
//   ⚠️ 实测（12 核）41 个文件：4 路 15.1s → 8 路 13.0s → 12 路 13.1s（8 路封顶，再多没收益）。
//
// 用法：
//   npm run test:smoke              全部（默认并行）
//   npm run test:smoke -- accounts  只跑文件名含 "accounts" 的
//   JOBS=1 npm run test:smoke       串行
// ================================================================
import { readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { runFiles, report } from './lib/runFiles.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const smokeDir = path.join(root, 'scripts', 'smoke');
const registerUrl = new URL('./smoke/register.mjs', import.meta.url).href;

if (!existsSync(smokeDir)) {
    console.error(`[run-smoke] 找不到 ${smokeDir}`);
    process.exit(1);
}

const filters = process.argv.slice(2).filter(a => !a.startsWith('-'));
let files = readdirSync(smokeDir).filter(f => f.endsWith('.smoke.mjs')).sort();
if (filters.length > 0) files = files.filter(f => filters.some(k => f.includes(k)));

if (files.length === 0) {
    console.error('[run-smoke] 没有匹配的冒烟测试文件');
    process.exit(1);
}

const started = Date.now();
console.log(`[run-smoke] 共 ${files.length} 个冒烟测试文件\n`);

const { results, jobs } = await runFiles(
    files,
    f => ['--import', registerUrl, path.join(smokeDir, f)],
    root
);
const failed = report(results, 'run-smoke', jobs);

const seconds = ((Date.now() - started) / 1000).toFixed(1);
console.log('='.repeat(62));
if (failed.length === 0) {
    console.log(`[run-smoke] ✅ 全部通过：${files.length} 个文件，耗时 ${seconds}s（并行 ${jobs} 路）`);
    process.exit(0);
}
console.log(`[run-smoke] ❌ ${failed.length}/${files.length} 个文件失败，耗时 ${seconds}s（并行 ${jobs} 路）`);
for (const f of failed) console.log(`  • ${f.file} → ${f.reason}`);
process.exit(1);
