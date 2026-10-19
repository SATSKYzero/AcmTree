// ================================================================
// 跨语言「来源优先级」表同步：`source_report.py` ↔ `core/trust.js`
//
// 病根：`acm-data/raw/Scaper/05 xcpc/source_report.py` 是
// "只读小样"工具，它**自己又实现了一遍来源优先级投影**（等级表 + 类别序 + 来源→类别），
// 而权威口径在应用的 `src/core/trust.js`。两边一旦漂移，这个工具就会**用一套自己的规则
// 告诉你"应用为什么选了这个值"** —— 比没有这个工具更坏。
//
// 为什么不直接删投影：它是排查"这场为什么挑了这个值"的唯一入口（用户会用它）。
// 所以按本仓既有的跨语言做法（见 `linkKinds.test.js`）：**手抄 + 对拍**，
// 哪一边单独改了，这里就红。
// ================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { KIND_RANK, DEFAULT_TRUST, VALID_SOURCE_KINDS, sourceRankOf } from '../core/trust.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PY = path.join(ROOT, 'acm-data', 'raw', 'Scaper', '05 xcpc', 'source_report.py');

const readPy = () => fs.readFileSync(PY, 'utf8');

/**
 * 从 Python 源码里抠出一个**字面量表**（`NAME = {...}` / `NAME = [...]`），返回 JS 值。
 *
 * ⚠️ 判据要经得起两种折腾：
 *   ① **多行**字面量必须认（`CATEGORY_RANK` 拆成多行不算错）。按
 *      **括号配平**取整块，跨行无所谓。
 *   ② 更坏的是**真绿**：把字面量搬进 `SOURCE_RANK.update({...})`、只留一个空的
 *      `SOURCE_RANK = {}` —— 那样会返回空表，而"遍历空表"的断言**一条都不会失败**。
 *      只认"赋值右边直接是字面量"，碰到函数调用/拼接就**当场报错**（写法变了要同步对拍，
 *      不许静默变成空表）；调用方另有"表不能是空的"断言兜底。
 */
function pyLiteral(text, name) {
    const at = new RegExp(`^${name}\\s*=\\s*`, 'm').exec(text);
    if (!at) throw new Error(`source_report.py 里应该有一行 \`${name} = …\``);
    const i = at.index + at[0].length;
    const open = text[i];
    if (open !== '{' && open !== '[') {
        throw new Error(`\`${name}\` 右边不是字面量（看起来是 ${JSON.stringify(text.slice(i, i + 24))}…）`
            + ' —— 写法变了就得同步这份对拍（右边不是字面量时会静默变成空表 ⇒ 所有断言都失效）');
    }
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let end = -1;
    for (let j = i; j < text.length; j++) {
        if (text[j] === open) depth += 1;
        else if (text[j] === close) { depth -= 1; if (depth === 0) { end = j; break; } }
    }
    if (end < 0) throw new Error(`\`${name}\` 的括号没闭合`);
    const body = text.slice(i, end + 1);
    // 这些表的键/值都是单引号包的短字面量 ⇒ 换成 JSON 直接解析（形状不合会当场抛，不静默）
    return JSON.parse(body.replace(/'/g, '"').replace(/,\s*([\]}])/g, '$1'));
}

const table = (name) => pyLiteral(readPy(), name);

test('来源类别（`CATEGORY` 的取值）都必须是应用侧认可的类别', () => {
    const category = table('CATEGORY');
    assert.ok(Object.keys(category).length > 0, 'CATEGORY 不能是空表（空表会让下面每一条都失效）');
    for (const [src, kind] of Object.entries(category)) {
        assert.ok(VALID_SOURCE_KINDS.includes(kind),
            `source_report.py 把 ${src} 归成「${kind}」，而应用侧只认 ${VALID_SOURCE_KINDS.join('/')}`);
    }
});

test('类别序（`CATEGORY_RANK`）与应用侧 `DEFAULT_TRUST.categoryRank` **逐字一致**', () => {
    const rank = table('CATEGORY_RANK');
    assert.ok(rank.length > 0, 'CATEGORY_RANK 不能是空表');
    assert.deepEqual(rank, [...DEFAULT_TRUST.categoryRank],
        '两边顺序不同 ⇒ 同一份数据会得出不同的"当前值"');
});

test('来源等级（`SOURCE_RANK`）与**应用侧算出来的那一份**逐项一致', () => {
    const rank = table('SOURCE_RANK');
    const category = table('CATEGORY');
    assert.ok(Object.keys(rank).length > 0, 'SOURCE_RANK 不能是空表');
    for (const [src, r] of Object.entries(rank)) {
        if (src === 'manual') {
            assert.equal(r, KIND_RANK.manual, '手改那一档也要与 KIND_RANK 一致');
            continue;
        }
        const kind = category[src];
        assert.ok(kind, `SOURCE_RANK 里有 ${src}，但 CATEGORY 里没给它类别`);
        // ⚠️ 判据不是"等于类别的等级"：`core/trust.js` 的 `SOURCE_RANK` 允许**同类之内**再分档
        //    （cf 榜 25 < 现场榜 30）。所以这里问的是应用侧对**同一个来源**算出来是多少 ——
        //    应用侧没覆盖 ⇒ 回落到该类别自己的等级（`?? KIND_RANK[kind]`）。
        const appSide = sourceRankOf(`${src}-x`, kind);
        assert.equal(appSide === null ? KIND_RANK[kind] : appSide, r,
            `${src}：工具说 ${r}，应用侧（类别 ${kind}）算出来是 ${appSide === null ? KIND_RANK[kind] : appSide}`);
    }
});

test('★ 等级与类别序**不许互相矛盾**（同类之内随便分档，跨类别不许倒挂）', () => {
    const rank = table('SOURCE_RANK');
    const category = table('CATEGORY');
    const worst = {};                      // 类别 → 该类别里**最低**的等级
    for (const [src, r] of Object.entries(rank)) {
        if (src === 'manual') continue;
        const kind = category[src];
        if (worst[kind] === undefined || r < worst[kind]) worst[kind] = r;
    }
    // 类别序（`CATEGORY_RANK`）从高到低：每一档的**最低**等级都必须严格高于下一档的**最高**等级
    const order = table('CATEGORY_RANK');
    for (let i = 0; i + 1 < order.length; i++) {
        const hi = worst[order[i]];
        const lo = worst[order[i + 1]];
        if (hi === undefined || lo === undefined) continue;
        assert.ok(hi > lo,
            `「${order[i]}」这一档最低 ${hi} 不大于「${order[i + 1]}」的 ${lo} ⇒ `
            + '等级会把类别序顶翻（同一个值两个说法）');
    }
});

test('★ 上面那个解析自己会咬（多行要认、空表/函数调用要报错）', () => {
    assert.deepEqual(pyLiteral("A = {'x': 'board', 'y': 'script'}\n", 'A'), { x: 'board', y: 'script' });
    assert.deepEqual(pyLiteral("A = [\n  'a',\n  'b'\n]\n", 'A'), ['a', 'b'], '多行要认（按行匹配会假红）');
    assert.deepEqual(pyLiteral("Z = 0\nA = {'x': 1}\n", 'A'), { x: 1 }, '取指定的名字，不受别的赋值干扰');
    // 那种"搬走字面量"的写法：解析出来是**空表** ⇒ 由调用方的"不能是空表"断言抓红
    //（这条自检钉住那个配合：解析不报错，但空表绝不会让断言静默通过）
    assert.deepEqual(pyLiteral("SOURCE_RANK = {}\nSOURCE_RANK.update({'a': 1})\n", 'SOURCE_RANK'), {},
        '搬走字面量后只剩空表 —— 靠"不能是空表"那道断言兜');
    assert.throws(() => pyLiteral("A = dict(x=1)\n", 'A'), /右边不是字面量/, '别的构造方式要报错');
    assert.throws(() => pyLiteral("A = {'x': 1\n", 'A'), /没闭合/, '括号不闭合要报错');
    assert.throws(() => pyLiteral("A = 1\n", 'B'), /应该有一行/, '找不到名字要报错');
});
