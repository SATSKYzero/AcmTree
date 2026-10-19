// ================================================================
// 文件字节：行尾与 BOM（`src/test/fileBytes.test.js`）
//
// 为什么要有这条：**行尾是看不见的**（`read` 只给行号与文字，`\r` 不可见），而写文件的工具默认写 LF；
// 仓库又**本来就是混的**（4 个 `.bat` 必须 CRLF，68 个 `.js` 也是 CRLF，其余多是 LF）⇒ 没有"统一行尾"
// 这条规矩可用。历史上真踩到过：`.bat` 被改成 LF 之后 `cmd` 把中文行**读碎**、双击毫无反应；
// `Set-Content` 又给两个文件加了 BOM。
//
// 判据（每条都会**点名文件**）：
//   ① 每个 `.bat`：必须**全 CRLF**（0 个裸 LF）、不许有 BOM —— 唯一"行尾错了会真的坏"的一类；
//   ② 每个文本文件：**不许有 BOM**（本仓任何文本都不需要它）；
//   ③ `app/acm-data/` 之外的文本文件：**不许混行尾**（要么全 CRLF、要么全 LF）。
//      （数据目录里那些是脚本生成的，混行尾不影响任何读者 —— 但它们**不许带 BOM**，②照查。）
//
// ⚠️ `LEGACY_*` 是**历史遗留**（不是这轮改的）：修一个就从名单里删一个。名单只为让守卫"今天就是绿的"，
//    不然后人一打开就看见红的、会去改守卫（那是明令禁止的）。
// 手查命令（一条就够，**别逐字节扫**）：`git ls-files --eol`（`w/mixed` 就是混行尾）。
// 成本：大文件只读前 3 字节判 BOM；行尾只扫 `app/acm-data/` 之外那几 MB。
// ================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { APP_ROOT, repoRoot } from '../../scripts/roots.mjs';

const ROOT = repoRoot();
const DATA_PREFIX = 'app/acm-data/';      // 行尾检查跳过这一片（BOM 照查）

const EXTS = new Set(['.js', '.mjs', '.json', '.md', '.html', '.css', '.py', '.bat', '.txt', '.yml', '.yaml', '.ps1']);
const MAX_BYTES = 8 * 1024 * 1024;        // 超过就不整份读了（行尾/BOM 在头部就露）
const SKIP_DIRS = new Set(['.git', '.git-full', 'node_modules', '__pycache__']);

/** 历史遗留：带 BOM 的两个文件（`Set-Content` 那两次事故留下的） */
const LEGACY_BOM = new Set([
    'app/src/core/natureAssignments.js',
    'app/src/test/elements.test.js'
]);
/** 历史遗留：混行尾的四个文件（索引里就是混的，`git ls-files --eol` 能看到 i/mixed） */
const LEGACY_MIXED = new Set([
    'app/src/test/autoImportSynth.test.js',
    'app/src/ui/folder/folderShared.js',
    'app/src/ui/stats/statsCharts.js',
    'app/src/view/linkChips.js'
]);

function rel(p) { return path.relative(ROOT, p).replace(/\\/g, '/'); }

/** 走两棵树，收文本文件（相对仓库根；用 Set 去重 —— `app/` 在仓库根里面，会被走两次） */
function* walk(dir) {
    let items;
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
        const p = path.join(dir, it.name);
        if (it.isDirectory()) {
            if (SKIP_DIRS.has(it.name)) continue;
            // ⚠️ 2026-10-19：**公开发布副本**住在 `作者专用/AcmTree-<版本>-release/` 里，
            //    它是"整个工作区的另一份"（`publish-copy.mjs` 的产物）⇒ 再扫一遍只会翻倍，
            //    而且那里面的行尾/BOM 是**被复制来的**，报出来等于让 copy 反噬原件（实测当场假红）。
            if (it.name.startsWith('AcmTree-') && it.name.endsWith('-release')) continue;
            yield* walk(p);
        } else if (it.isFile() && EXTS.has(path.extname(it.name).toLowerCase())) {
            yield rel(p);
        }
    }
}
const FILES = new Set([...walk(APP_ROOT), ...walk(ROOT)]);

/** 前 3 字节判 BOM（**不整份读**：大包有十几 MB） */
function hasBom(r) {
    let fd;
    try {
        fd = fs.openSync(path.join(ROOT, ...r.split('/')), 'r');
        const b = Buffer.alloc(3);
        const n = fs.readSync(fd, b, 0, 3, 0);
        return n === 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF;
    } catch { return false; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* 无所谓 */ } }
}

/** 数行尾（只给仓库里那几 MB 用；逐字符在 Node 里足够快） */
function endings(r) {
    let text;
    try { text = fs.readFileSync(path.join(ROOT, ...r.split('/')), 'utf8').slice(0, MAX_BYTES); }
    catch { return null; }
    let crlf = 0;
    let lf = 0;
    for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) !== 10) continue;
        if (i > 0 && text.charCodeAt(i - 1) === 13) crlf++; else lf++;
    }
    return { crlf, lf };
}

test('★ 每个 `.bat` 必须全 CRLF、无 BOM（错了 cmd 会把中文行读碎）', () => {
    const bad = [];
    for (const r of FILES) {
        if (!r.toLowerCase().endsWith('.bat')) continue;
        if (hasBom(r)) bad.push(`${r}：有 BOM`);
        const e = endings(r);
        if (e && e.lf > 0) bad.push(`${r}：有 ${e.lf} 个裸 LF（${e.crlf} 个 CRLF）—— 必须整份 CRLF`);
    }
    assert.deepEqual(bad, [], `这些 \`.bat\` 的行尾/BOM 不对：\n  ${bad.join('\n  ')}\n`
        + '（改法：写/改时行尾必须显式 CRLF；**不许**用 PowerShell 的 `Set-Content`）');
});

test('★ 文本文件不许带 BOM（本仓任何文本都不需要它）', () => {
    const bad = [];
    for (const r of FILES) {
        if (hasBom(r) && !LEGACY_BOM.has(r)) bad.push(r);
    }
    assert.deepEqual(bad, [], `这些文件带 BOM（污染 diff，也容易被别的工具读歪）：\n  ${bad.join('\n  ')}`);
});

test('★ `app/acm-data/` 之外的文本文件不许混行尾（往 CRLF 文件里插 LF 行就会这样）', () => {
    const bad = [];
    for (const r of FILES) {
        if (r.startsWith(DATA_PREFIX) || LEGACY_MIXED.has(r)) continue;
        const e = endings(r);
        if (e && e.crlf > 0 && e.lf > 0) bad.push(`${r}：CRLF ${e.crlf} 个 ＋ 裸 LF ${e.lf} 个`);
    }
    assert.deepEqual(bad, [], `这些文件混了行尾：\n  ${bad.join('\n  ')}\n`
        + '（手查：`git ls-files --eol` 看 `w/mixed`）');
});

test('守卫自己得能咬：扫到的文件数够多（目录走错会静默变空）', () => {
    assert.ok(FILES.size > 100, `应当扫到足够多的文件（实际 ${FILES.size}）`);
});
