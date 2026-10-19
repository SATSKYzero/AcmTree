// ================================================================
// 「是不是一个**真年份**（`20xx`）」只有一处判据：`core/natureFields.isRealYear`
//
// 病根：
//   同一条判据在 **6 处**各写一遍 —— `ContestSearch/query.js`、`siblingOrder.yearKey`、
//   `rosterAccounts`（两处）、`rosterMappings`、以及 Python 的 `nature_rules.py`；
//   而 `core/dedup.js` 的注释专门写着"只问唯一入口 `isRealYear()`、**这里不自己 new RegExp**"
//   —— 也就是说**约定存在，但只有那一个文件遵守**。
//   ⚠️ 那 6 处**会漂**（实测 14 种输入 × 4 个站点）：`' 2025 '`（带空格）真源算真年份、
//   其中 3 处算不是；其余 50 格一致。今天数据是规范化的、咬不到人，
//   但"改一处忘一处就分叉"正是这个仓反复踩的那类坑。
//
// 下面两条：
//   ① 行为：那几处与真源**同口径**（带空格的年份也算年份了）；
//   ② 源码级 lint：生产文件里不许再出现 `^20\d{2}`（注释里提到不算 —— 本仓注释经常要解释
//      "以前是怎么写的"）；Python 那两份"真年份"字面量必须与 JS 这份是同一个形态，
//      谁单独改了（比如又写成 `(19|20)`）这里就红。
//
// 为什么 lint 只禁**带 `^` 锚点**的写法：从一段文本里**抽**年份（`/20\d{2}/`，如
// `natureSuggest.yearInText`、`collect.yearFromTime`）是**另一条判据**，故意不合并。
// ================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isRealYear } from '../core/natureFields.js';
import { yearKey } from '../core/siblingOrder.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const readSrc = (rel) => fs.readFileSync(path.join(ROOT, ...rel.split('/')), 'utf8');
/** 整文件剥注释（块注释 + 整行行注释）——注释里提"以前怎么写的"不算 */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** 生产文件：`src` 下的 `.js`（除 `src/test`）与 `scripts` 下的 `.js`/`.mjs`（除 `scripts/smoke`） */
function productionFiles(dir, skipDir) {
    const out = [];
    const walk = (abs) => {
        for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
            const full = path.join(abs, e.name);
            if (e.isDirectory()) {
                if (e.name === 'node_modules' || e.name === skipDir) continue;
                walk(full);
            } else if (/\.(js|mjs)$/.test(e.name)) {
                out.push(path.relative(ROOT, full).split(path.sep).join('/'));
            }
        }
    };
    walk(path.join(ROOT, dir));
    return out;
}

test('★ 真年份这四处与真源同口径（带空格的年份也算年份）', () => {
    // 这一格必须与真源给同一个答案
    assert.equal(isRealYear(' 2025 '), true, '真源口径：先 trim 再判');
    assert.equal(yearKey(' 2025 '), 2025, '年份排序键必须与真源一致');
    // 反向：非法/占位值依旧不算年份（别为了"统一"把它们放进来）
    for (const bad of ['1999', '26', '2026年', '待同步', '无', '不确定', '', null, undefined, '20250']) {
        assert.equal(isRealYear(bad), false, `${JSON.stringify(bad)} 不是真年份`);
        assert.equal(yearKey(bad), -1, `${JSON.stringify(bad)} 的排序键必须是 -1`);
    }
});

/**
 * 扫一段源码里"又自己写了一份真年份判据"的地方（注释里提到不算）—— 纯函数，好**自检**。
 *
 * ⚠️ **不能按行查字面量**：按行 split + 查 `^20\d{2}` 这种写法，
 * 会让 `new RegExp('^20'\n + '\\d{2}$')` 这种**字符串拼接**跨行全躲过去。
 * 现在整文件匹配，并先把**拼接的噪音**去掉（引号、`+`、空白，再把字符串里的 `\\d` 收成 `\d`）
 * —— 这样 `'^20' + '\\d{2}$'`、`new RegExp('^20\\d{2}$')` 与 `/^20\d{2}$/` 在判据眼里是
 * **同一个形状**（⚠️ 少了"收反斜杠"这一步，字符串写法这一整类都躲得掉，自检会当场红出来）。
 *
 * ⚠️ 仍然**只禁带 `^` 锚点**的那种（见文件头）：从文本里**抽**年份（`/20\d{2}/`）是另一条
 * 判据（`natureSuggest.yearInText` / `collect.yearFromTime`），故意不合并。
 */
const yearLintOffenders = (rel, text) => {
    const flat = stripComments(text)
        .replace(/['"`]/g, '').replace(/\+/g, '').replace(/\s+/g, '')
        .replace(/\\\\/g, '\\');
    return /\^20\\d\{2\}/.test(flat)
        ? [`${rel} 又自己写了一份"真年份"判据（带锚点）—— 请改用 core/natureFields.isRealYear`]
        : [];
};

test('源码级 lint：生产文件里不许再自己写 `^20\\d{2}`（判据只有 `natureFields.isRealYear`）', () => {
    const files = [
        ...productionFiles('src', 'test'),
        ...productionFiles('scripts', 'smoke')
    ].filter(rel => rel !== 'src/core/natureFields.js');   // 唯一真源，它当然要写

    const offenders = files.flatMap(rel => yearLintOffenders(rel, readSrc(rel)));
    assert.deepEqual(offenders, [],
        `这些地方又自己写了一份"真年份"判据，请改用 \`core/natureFields.isRealYear\`：\n${offenders.join('\n')}`);

    // ★ **自检**：喂两份**已知**样本 ——
    //   一份"又写了一遍"（必须被抓），一份"只在注释里提"（必须放过）。
    //   这样"这条 lint 会不会咬"每次跑测试都自动验一遍，不靠我说。
    assert.notDeepEqual(yearLintOffenders('假文件.js', 'const ok = /^20\\d{2}$/.test(s);'), [],
        '自检：又写一遍的行必须被抓');
    assert.notDeepEqual(yearLintOffenders('假文件.js', 'const ok = /^20\\d{2}$/.test(s);   // 顺手写的'), [],
        '自检：行尾带注释的也要抓（只有**整行是注释**才放过）');
    assert.deepEqual(yearLintOffenders('假文件.js', '// 以前写的是 ^20\\d{2}，现在问 isRealYear'), [],
        '自检：注释里提到不算（本仓注释经常解释"以前怎么写的"）');
    // ★ 常见的两种绕法：跨行字符串拼接 / 换引号
    assert.notDeepEqual(yearLintOffenders('假文件.js', "const re = new RegExp('^20'\n    + '\\\\d{2}$');"), [],
        '自检：跨行字符串拼接必须抓');
    assert.notDeepEqual(yearLintOffenders('假文件.js', 'const re = new RegExp("^20" + "\\\\d{2}$");'), [],
        '自检：双引号 + 同行拼接必须抓');
    // 设计上**不禁**的（见文件头末段）：从文本里抽年份是另一条判据
    assert.deepEqual(yearLintOffenders('假文件.js', 'const y = /20\\d{2}/.exec(text);'), [],
        '自检：不带锚点的抽取判据**故意**不算（那是另一件事）');
    assert.deepEqual(yearLintOffenders('假文件.js', 'const d = /\\d{2}/.test(x);'), [],
        '自检：与年份无关的两位数字正则不算');
});

test('跨语言对拍：Python 那两份"真年份"字面量与 JS 这份是同一个形态', () => {
    // 隔着一门语言没法 import，所以按本仓的既有做法（见 linkKinds / sourceReportRanks）**手抄 + 对拍**
    // ⚠️ **先剥注释再抓字面量**：不剥的话，把判据换成别的写法、
    //    只要**注释里**留一句 `re.fullmatch(r'20\d{2}', …)` 就照样绿。
    const picks = [
        ['acm-data/raw/Scaper/05 xcpc/lib/xcpc_common.py', /re\.fullmatch\(\s*r?(["'])([^"']*20\\d\{2\}[^"']*)\1/],
        ['scripts/nature_rules.py', /re\.fullmatch\(\s*r?(["'])([^"']*20\\d\{2\}[^"']*)\1/]
    ];
    /** 剥掉注释后抓"真年份"字面量（返回字面量或 null）—— 抽出来好**自检** */
    const pyYearPattern = (text, re) => {
        const m = re.exec(text.replace(/#.*$/gm, ''));
        return m ? m[2] : null;
    };
    // ★ 自检：判据换成别的写法、旧正则**只在注释里** ⇒ 必须抓不到（也就是必须红）
    const pyRe = picks[0][1];
    assert.equal(pyYearPattern('def f(s):\n    # 以前是 re.fullmatch(r"20\\d{2}", s)\n    return s.isdigit() and len(s) == 4\n', pyRe), null,
        '自检：只在注释里留旧写法 ⇒ 必须抓不到（否则这条对拍是假绿）');
    assert.equal(pyYearPattern('def f(s):\n    return re.fullmatch(r"20\\d{2}", s)\n', pyRe), '20\\d{2}',
        '自检：真写着 ⇒ 必须抓到');
    const found = [];
    for (const [rel, re] of picks) {
        const pat = pyYearPattern(readSrc(rel), re);
        assert.ok(pat, `${rel} 里找不到"真年份"那条正则（**注释里提到不算**）—— 改法变了就得同步这份对拍`);
        found.push([rel, pat]);
    }
    for (const [rel, pat] of found) {
        assert.equal(pat, '20\\d{2}',
            `${rel} 的"真年份"字面量变成了 ${JSON.stringify(pat)} —— 必须只有 \`20\\d{2}\`（不许再写 (19|20)）`);
    }
    // JS 侧同口径：`^20\d{2}$`（锚点只在 JS 里，因为匹配的是**整个值**）
    assert.equal(isRealYear('2025'), true);
    assert.equal(isRealYear('1999'), false, 'JS 与 Python 都不认 19xx');
});
