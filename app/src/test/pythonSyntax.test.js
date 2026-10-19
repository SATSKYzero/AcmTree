// ================================================================
// 全仓 Python 文件**能编译**（语法扫）
//
// 为什么要有这一条（实测踩到）：
//   `acm-data/raw/Scaper/05 xcpc/xcpc_pipeline.py` 的模块级写了 `return _code`
//   —— `SyntaxError: 'return' outside function`。后果是**产包那一步整条死掉**
//   （脚本自己编译不过，`runpy` 一执行就炸），而当手头几套自测**全绿**：
//     · `npm test` / `test:smoke` 只跑 JS；
//     · `05 xcpc selftest` 不 import 那个文件；
//     · `build_chain --selftest` 只查步骤表、不执行步骤。
//   ——"谁 import 了它"没人知道，所以**没人编译它**。
//
// 语法错是最便宜的一类错，就用最便宜的守卫兜住：挨个 `ast.parse`（不写字节码）。
// 跑法：`node scripts/run-tests.mjs pythonSyntax`（或作为 `npm test` 的一员）。
// ⚠️ `stdio: 'inherit'` 是刻意的：受限沙箱里"管着子进程的输出"= EPERM（见
//    `scripts/run-tests.mjs` 头注）；inherit 让 Python 自己把失败清单打到测试输出里。
// ================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('全仓每个 .py 都能编译（语法错 = 任何 import 它的东西都跟着死）', () => {
    // ⚠️ 子进程的 stdio 编码钉成 UTF-8（2026-10-18）：关掉 Windows「UTF-8 Beta」后 ACP=936，
    //    而被管道接走的 Python 按 GBK 编码 ⇒ `syntax-sweep.py` 打 `✅/❌` 时 UnicodeEncodeError，
    //    症状是"语法扫自己挂了"（看着像有文件编译不过）。与 `pythonSelftests.test.js` 的 `pyEnv()` 同一条。
    const res = spawnSync('python', ['-B', 'scripts/syntax-sweep.py'],
        { cwd: ROOT, stdio: 'inherit', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    if (res.error) {
        assert.fail(`起不来 python：${res.error.message}（机器上没有 python 时这条会红，`
            + '请让 CI/本机装一个，或把这条守卫挪到有 python 的环境）');
    }
    assert.equal(res.status, 0, '有 Python 文件编译不过 —— 上面那条 ❌ 清单就是它们');
});
