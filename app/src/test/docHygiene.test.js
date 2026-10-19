// ================================================================
// 文本卫生（`src/test/docHygiene.test.js`）—— 两条**面向读者**的检查
//
// ① `docs/guide.html`：不许出现字面 `**`，也不许出现反引号。
//    它是唯一给"不写代码的人"看的文档（应用里那个「📖 指南」），用的是
//    `<strong>` / `<code>` 标签，不认 Markdown 语法 —— 写成 `**加粗**` 的话，
//    用户看到的就是两个星号。
// ② **源码里的界面文案**：同样不许漏字面 `**`（用户 2026-10-13："星号漏了"）。
//    判据只用一条："**没有用 `plain`/`plainProse` 的文件**里，字符串位置不许出现 `**`" ——
//    用了 `utils/text.js:plain()` 的文件由它在渲染前擦掉（`textContent` / `title` / `innerHTML` 一视同仁）。
//    ⚠️ 只扫**字符串位置**：注释里写 `**强调**` 是给人读的，不算漏。
//
// ⚠️ 这里只检查这两条：不设"每份文档都要登记进 docs/README.md 地图"那类检查 ——
//   那是记账仪式，对拿到这份仓库的人没有价值，
//   却会在他们新增一份文档时莫名其妙地判红。地图仍然写、仍然有用，只是**不由测试强制**。
// ================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { repoRoot } from '../../scripts/roots.mjs';

// ⚠️ 两个根别混：`REPO` 是**机械层根**（`src/`、`docs/` 都在这层），`ROOT` 是**仓库根**（`README.md`、`个人数据/` 在这层）
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROOT = repoRoot(REPO);
/** 读一份文件：先按仓库相对找，再按机械层相对找（文档里的路径两种写法都有） */
const read = (rel) => {
    const p = path.join(ROOT, rel);
    return fs.readFileSync(fs.existsSync(p) ? p : path.join(REPO, rel), 'utf8');
};

test('★ guide.html 里不许出现 Markdown 语法（字面 ** / 反引号会直接显示给用户）', () => {
    const src = read('docs/guide.html');
    const stars = (src.match(/\*\*/g) || []).length;
    const ticks = (src.match(/\u0060/g) || []).length;
    assert.equal(stars, 0,
        `guide.html 里有 ${stars} 处字面「两个星号」 —— HTML 里不会渲染成加粗，用户看到的就是两个星号；`
        + '请改成 <strong>…</strong> 标签');
    assert.equal(ticks, 0,
        `guide.html 里有 ${ticks} 处反引号（\\u0060） —— HTML 里不会渲染成代码；`
        + '请改成 <code>…</code> 标签');
});

/**
 * 源码里的 Markdown 记号探针（**只认"会显示给人看"的位置**）。
 *
 * 判据两条：
 *   · `**`（强调）出现在**字符串**里 ⇒ 算漏（注释里写 `**强调**` 是给人读代码的，不算）；
 *   · 反引号出现在**单/双引号字符串**里 ⇒ 算漏；出现在**模板串里被转义**（`\``）⇒ 也算漏
 *     （转义它只有一个目的：让那个反引号原样输出）。
 *
 * 为什么要自己扫：注释要先剥掉，而行注释只在**引号外**才算（`'http://…'` 里的 `//` 不是注释）。
 *
 * @returns {Array<{line:number, text:string, mark:string}>} 命中的行（行号从 1 开始）
 */
function marksInStrings(src) {
    const out = [];
    let inBlock = false;
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        let code = '';
        let quote = null;
        let tick = false;
        for (let j = 0; j < line.length; j++) {
            const c = line[j];
            if (inBlock) {
                if (c === '*' && line[j + 1] === '/') { inBlock = false; j++; }
                continue;
            }
            if (quote) {
                if (c === '\\') {
                    // 模板串里转义的反引号 = 想让那个反引号显示出来 ⇒ 漏
                    if (quote === '\u0060' && line[j + 1] === '\u0060') tick = true;
                    code += c + (line[j + 1] || '');
                    j++;
                    continue;
                }
                if (c === quote) quote = null;
                else if (quote !== '\u0060' && c === '\u0060') tick = true;   // 单/双引号里的反引号
                code += c;
                continue;
            }
            if (c === '/' && line[j + 1] === '*') { inBlock = true; j++; continue; }
            if (c === '/' && line[j + 1] === '/') break;
            if (c === '"' || c === "'" || c === '\u0060') quote = c;
            code += c;
        }
        const marks = [];
        if (code.includes('**')) marks.push('**');
        if (tick) marks.push('反引号');
        if (marks.length) out.push({ line: i + 1, text: code.trim().slice(0, 120), mark: marks.join(' + ') });
    }
    return out;
}

test('★ 界面文案里不许漏 Markdown 记号（** 与反引号都会原样显示给用户）', () => {
    const SRC = path.join(REPO, 'src');
    const files = fs.readdirSync(SRC, { recursive: true })
        .map((p) => String(p).replace(/\\/g, '/'))
        .filter((p) => p.endsWith('.js') && !p.startsWith('test/') && !p.startsWith('vendor/'));
    const offenders = [];
    for (const rel of files) {
        const src = read(`src/${rel}`);
        // 用了 `plain` / `plainProse` 的文件：记号由 `utils/text.js` 在渲染前擦掉，不算漏。
        if (/\bplain(Prose)?\b/.test(src)) continue;
        for (const hit of marksInStrings(src)) {
            offenders.push(`src/${rel}:${hit.line}（${hit.mark}）  ${hit.text}`);
        }
    }
    assert.equal(offenders.length, 0,
        `这些文件的**字符串**里有字面 Markdown 记号 —— 界面上会原样显示。要么把文案写干净`
        + '（强调用「」、术语不加记号），要么过 `utils/text.js:plain()`'
        + '（`textContent` / `title` / `innerHTML` 一视同仁）；'
        + `\n  ${offenders.join('\n  ')}`);
});
