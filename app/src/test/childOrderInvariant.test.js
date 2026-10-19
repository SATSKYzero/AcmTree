// ================================================================
// childOrder 条目不变量（规则 A）：**挂子节点必须走 `pushChild`**
//
// 病根：`core/ops/upsert.js` 里直接
// `draft.childOrder[parentId].push(id)`，而父节点的条目可能**本来就没有**
// （老存档、手工构造的输入、别处删漏了）⇒ TypeError，
// 而它在事务里发生 ⇒ **整批导入全部回滚**，用户看到的是"导不进来"。
//
// "挂子节点"只有一个入口 `_helpers.js` 的 `pushChild`（缺条目先补）。
// 下面两条：① 真跑一遍"父缺条目"的输入；② 扫一遍 ops 层，防止再冒出直接 push。
// ================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { upsertRecord, buildExtKeyIndex } from '../core/ops/upsert.js';
// ★ 2026-10-18 起**事务里不再写 `draft.parentOf`**（派生索引，提交时由 `applyState` 重建）
//   ⇒ 事务内的父子关系走这条读口（与 ops 里同一份：`ops/_helpers.js:parentOfInDraft`）。
import { parentOfInDraft } from '../core/ops/_helpers.js';

const OPS_DIR = fileURLToPath(new URL('../core/ops/', import.meta.url));

/** O → W 的草稿，但**故意不给 W 建 childOrder 条目** */
function draftWithMissingEntry() {
    return {
        rootId: 'o',
        nodes: {
            o: { id: 'o', type: 'O', name: '根', extKey: '', expanded: false },
            w: { id: 'w', type: 'W', name: 'QOJ', extKey: 'qoj', expanded: false }
        },
        childOrder: { o: ['w'] },                 // ★ 没有 w
        parentOf: { o: null, w: 'o' },
        meta: { idCounter: 0 }
    };
}

test('父节点缺 childOrder 条目时，新建子节点**补上条目**而不是 TypeError', () => {
    const draft = draftWithMissingEntry();
    const index = buildExtKeyIndex(draft);

    const res = upsertRecord(draft, {
        type: 'S', extKey: 'qoj:contest', parentExtKey: 'qoj', fields: { name: 'Contest' }
    }, index);

    assert.equal(res.ok, true, `没炸：${res.reason || ''}`);
    assert.equal(res.created, true);
    assert.deepEqual(draft.childOrder.w, [res.nodeId], '父节点的条目补出来了，孩子挂上去了');
    assert.deepEqual(draft.childOrder[res.nodeId], [], '新节点自己的条目也在（规则 A 的两半）');
    assert.equal(parentOfInDraft(draft, res.nodeId), 'w');
});

//: 剥注释（行注释与块注释）——注释里提 `.push(` 不算
function stripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

//: 会改数组的词
const MUTATORS = 'push|pop|shift|unshift|splice|sort|reverse|fill|copyWithin';

/**
 * 在一段 ops 源码里找"绕过 `pushChild` 直接改 `childOrder`"的地方，返回命中片段。
 *
 * ⚠️ **判据必须跨行、且不能只认 `X.childOrder[k].push(`**：
 * 只按行 split + 只看 `]` 后紧跟 `.push(` 会漏，于是
 *   ① `draft.childOrder[real.id]\n    .push(vId)`（拆行）与
 *   ② `Reflect.apply(Array.prototype.push, draft.childOrder[real.id], [vId])`
 * 两种写法**都不红**，而它们干的正是守卫要防的事）。本判据整文件匹配、`\s*` 跨行。
 *
 * 覆盖的写法：下标后跟改数组方法 / 把下标交出去给 `push.call` `push.apply`
 * `Reflect.apply(…push…, 下标)`。
 *
 * ⚠️ **故意不管"给下标赋值"**（`draft.childOrder[p] = kept`）：那种写法会**建出条目**，
 * 复现不了"父缺条目 ⇒ TypeError ⇒ 整批回滚"这个病根；`tree.js` 里按谓词重建子列表、
 * 深拷贝时给新节点初始化空条目都是这类，禁了是误伤。这条守卫只盯"往已有列表里塞"。
 *
 * ⚠️ **已知边界**：`const list = draft.childOrder[pid]; list.push(x)` 这种**先取别名**
 * 的写法任何文本判据都抓不到（那要靠 code review 或类型系统）。这里不假装能抓。
 */
function childOrderWriters(src) {
    const t = stripComments(src);
    const hits = [];
    const push = (re) => { const m = re.exec(t); if (m) hits.push(m[0].replace(/\s+/g, ' ').trim().slice(0, 70)); };
    push(new RegExp(`childOrder\\s*\\[[^\\]]*\\]\\s*\\.\\s*(?:${MUTATORS})\\b`));
    push(new RegExp(`(?:${MUTATORS})\\s*\\.\\s*(?:call|apply)\\s*\\([^;]{0,200}?childOrder`));
    push(new RegExp(`Reflect\\.apply\\s*\\(\\s*(?:Array\\.prototype\\.)?(?:${MUTATORS})\\b[^;]{0,200}?childOrder`));
    return hits;
}

test('★ 2026-10-18：ops 层**不再写 `draft.parentOf`**（它是派生索引，提交时由 `applyState` 重建）', () => {
    // 为什么：写它会让 Immer 再拷一张 3.3 万键的字典（`perf-bench` 实测 `{ ...parentOf }` **78ms**，
    //   而 `只 produce：addChild(P)` 总共 145ms）。用户 2026-10-18："不写 parentOf 尽管改"。
    // 现在的形状：事务内写 `setParentOf(draft, id, pid)` / `forgetParentOf`（一张 Map），读 `parentOfInDraft`。
    // 判据（会红）：ops 层任何文件里出现 `X.parentOf[...] = ` / `delete X.parentOf[...]` / `X.parentOf = `。
    const offenders = [];
    for (const f of fs.readdirSync(OPS_DIR).filter(n => n.endsWith('.js'))) {
        if (f === '_helpers.js') continue;                    // overlay 的实现就在那儿（它自己不对 draft 赋值）
        const src = stripComments(fs.readFileSync(path.join(OPS_DIR, f), 'utf8'));
        for (const re of [
            /[\w$.]*\bparentOf\s*\[[^\]]*\]\s*(?:\+\+|--)?=(?!=)/g,
            /delete\s+[\w$.]*\bparentOf\s*\[[^\]]*\]/g,
            /\b\w+\.parentOf\s*=(?!=)/g
        ]) {
            const m = re.exec(src);
            if (m) offenders.push(`${f} → ${m[0].replace(/\s+/g, ' ').trim().slice(0, 70)}`);
        }
    }
    assert.deepEqual(offenders, [],
        '`parentOf` 是派生索引：事务里请用 `setParentOf`/`forgetParentOf`/`parentOfInDraft`（`_helpers.js`），'
        + '别再直接写 `draft.parentOf` —— 那会让 Immer 每次结构操作多拷一张 3.3 万键的字典');
});

test('ops 层只有 `pushChild` 一个入口在写 childOrder（别处再写直接写就红）', () => {
    const offenders = [];
    for (const f of fs.readdirSync(OPS_DIR).filter(n => n.endsWith('.js'))) {
        if (f === '_helpers.js') continue;                    // 唯一入口自己
        const src = fs.readFileSync(path.join(OPS_DIR, f), 'utf8');
        for (const hit of childOrderWriters(src)) offenders.push(`${f} → ${hit}`);
    }
    assert.deepEqual(offenders, [],
        '挂子节点请走 _helpers.js 的 pushChild（缺条目先补）——'
        + '直接 push 会在"父条目缺失"的输入上抛 TypeError，把整批导入回滚掉');
});

test('★ 上面那条判据自己会咬（喂已知坏样本，含两种躲法）', () => {
    // 两种躲法：拆行、Reflect.apply
    assert.equal(childOrderWriters("draft.childOrder[real.id]\n    .push(vId);").length, 1, '拆行也要抓');
    assert.equal(childOrderWriters(
        'Reflect.apply(Array.prototype.push, draft.childOrder[real.id], [vId]);').length, 1, 'Reflect.apply 也要抓');
    // 同一件事的别的写法
    assert.equal(childOrderWriters('Array.prototype.push.call(draft.childOrder[p], cid);').length, 1, 'push.call');
    assert.equal(childOrderWriters('draft.childOrder[p].push(cid);').length, 1, '最直白的写法');
    assert.equal(childOrderWriters('draft.childOrder[p].splice(0, 1);').length, 1, '别的改数组方法也算');
    // 这些**不该**被误伤
    assert.deepEqual(childOrderWriters('const kids = draft.childOrder[real.id] || [];'), [], '读不算');
    assert.deepEqual(childOrderWriters('for (const cid of draft.childOrder[real.id]) use(cid);'), [], '遍历不算');
    assert.deepEqual(childOrderWriters('draft.childOrder[parentId] = kept;'), [], '整个换掉会**建出**条目，不是那个病根');
    assert.deepEqual(childOrderWriters('// draft.childOrder[p].push(cid)\n'), [], '注释里提不算');
    assert.deepEqual(childOrderWriters('pNode.children.push(vId);'), [], '`children` 是另一套结构（副页）');
    assert.deepEqual(childOrderWriters('if (kids.length) out.push(id);'), [], '往本地数组 push 不算');
});
