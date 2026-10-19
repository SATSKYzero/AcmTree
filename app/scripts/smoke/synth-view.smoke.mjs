// ================================================================
// 冒烟测试：树上的**合成节点成员名单**（scripts/smoke/synth-view.smoke.mjs）
//
// Node 单测钉不到这里，因为渲染链
// （`view/renderers.js` → `view/builders.js` → `view/helpers.js`）会 import
// `core/pluginRegistry.js` 与 `shell/state.js`（裸包名 `immer`），纯 Node 单测跑不起来 ——
// 冒烟运行器带 immer 解析钩子，正是为这类用例准备的。
//
// 这里钉的是"**是引用，不是子节点**"这一条在**渲染结果**上的表现：
//   ① 合成节点行**列出成员**（名字），顺序 = `synthMembers` 的**树序**
//      （不是 `synthIndex(state).members` 的插入序 —— 两者刻意造成不同的顺序来验）；
//   ② 成员**不计入子节点计数**（选中模式徽标上的数字只有真实子树，且渲染前后 childOrder 不变）；
//   ③ 成员**不产生可折叠节点**：成员 id 不出现在渲染结果里，也不进 `childOrder`；
//   ④ 成员名单**只长在合成节点上**（成员自己那一行不出现）。
//
// ⚠️ 渲染函数是**纯字符串**返回（不碰 DOM），所以这里不需要 `parseHtml`；
//    装 DOM 桩只是为了让渲染链在 import 阶段能加载。
//
// 运行：npm run test:smoke
// ================================================================
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDom } from './dom.mjs';
import { group, ok, eq, deepEq, report } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = path.join(ROOT, 'src');
const mod = rel => `file://${path.join(SRC, rel).replace(/\\/g, '/')}`;

installDom([]);
globalThis.fetch = async () => ({ ok: false, json: async () => ({}) });

const { renderNode } = await import(mod('view/renderers.js'));
const { getChildNodes } = await import(mod('view/helpers.js'));
const { countEligibleSubtree } = await import(mod('view/eligible.js'));
const { synthMembers, synthIndex } = await import(mod('core/ops/synth.js'));
const { createNode } = await import(mod('core/model/node.js'));

const TRUST = {
    categoryRank: ['manual', 'board', 'script', 'derived'],
    sources: { manual: { kind: 'manual', rank: 100 } },
    fieldPrefer: {}
};

const SYNTH_KEY = 'synth:gp';

/**
 * 一棵树（**成员刻意与合成节点不同父** —— 成员关系是名单，不是父子）：
 *
 *   o (O)
 *   └ w (W)
 *     └ s (S)
 *       ├ cA (C)
 *       │  ├ synP (P, synthKey=synth:gp, 合成题)   ← 合成节点（2 个**真**子节点）
 *       │  │  ├ r1 (R, selected)
 *       │  │  └ r2 (R, selected)
 *       │  ├ p1 (P, → synth:gp, 题1, selected)      ← 成员（跨父，挂在 cA 下）
 *       │  └ p2 (P, → synth:gp, 题2)                ← 成员
 *       └ cB (C)
 *          └ p3 (P, → synth:gp, 题3)                ← 成员（另一棵子树）
 *
 * ⚠️ `nodes` 的**对象键序**刻意把 p3 排在 p1/p2 前面：这样"用了树序还是插入序"一眼可辨。
 */
function makeState() {
    const st = {
        rootId: 'o',
        nodes: {},
        childOrder: {},
        parentOf: {},
        pages: {},
        accounts: { k1: { id: 'k1', name: '主号' } },
        sources: { manual: { kind: 'manual', rank: 100 } },
        trust: TRUST,
        viewingAccountId: 'k1',
        settings: { display: { nodePerPage: 50 }, mode: { editMode: 'selection' }, stats: {} }
    };
    const add = (id, type, parent, extra = {}) => {
        st.nodes[id] = { ...createNode(id, type, extra), ...extra, id, type };
        st.childOrder[id] = st.childOrder[id] || [];
        if (parent === null) { st.parentOf[id] = null; return st.nodes[id]; }
        st.childOrder[parent] = st.childOrder[parent] || [];
        st.childOrder[parent].push(id);
        st.parentOf[id] = parent;
        return st.nodes[id];
    };
    add('o', 'O', null);
    add('w', 'W', 'o', { name: '平台' });
    add('s', 'S', 'w', { name: '系列' });
    add('cA', 'C', 's', { name: '比赛A' });
    add('cB', 'C', 's', { name: '比赛B' });
    add('synP', 'P', 'cA', { name: '合成题', synthKey: SYNTH_KEY });
    add('r1', 'R', 'synP', { status: 'AC', selected: true });
    add('r2', 'R', 'synP', { status: 'WA', selected: true });
    // ⚠️ 插入序：p3 在 p1/p2 之前；树序：p1、p2 在 p3 之前
    add('p3', 'P', 'cB', { name: '题3', ownerSynth: SYNTH_KEY });
    add('p1', 'P', 'cA', { name: '题1', ownerSynth: SYNTH_KEY, selected: true });
    add('p2', 'P', 'cA', { name: '题2', ownerSynth: SYNTH_KEY });
    return st;
}

/** 把合成节点那一块 HTML 渲染出来（`full` 模式 + `selection` 编辑模式 ⇒ 带子节点计数徽标） */
const renderSynth = st => renderNode(st, st.nodes.synP, 0, [st.nodes.synP], 'cA', false, 'full');

/** 渲染结果里"选中模式"两个计数徽标的数字（见 `helpers.js` 的 boxHtml1/boxHtml2） */
function countBadges(html) {
    return [...html.matchAll(/width:22px; height:22px;[^>]*>([^<]*)</g)].map(m => m[1]);
}

/** 取「成员」那一行 */
function memberLine(html) {
    const m = /<div class="synth-members"[\s\S]*?<\/div>/.exec(html);
    return m ? m[0] : '';
}

// ===============================================================
group('合成节点：成员名单（顺序 = 树序，不是插入序）');
// ===============================================================
const st = makeState();
const html = renderSynth(st);

deepEq(synthMembers(st, SYNTH_KEY), ['p1', 'p2', 'p3'], 'synthMembers 给的是**树序**');
eq((synthIndex(st).members.get(SYNTH_KEY) || [])[0], 'p3', 'synthIndex 给的是**插入序**（两者刻意不同）');

const line = memberLine(html);
ok(!!line, '合成节点渲染出了 .synth-members 一行');
ok(/成员：题1、题2、题3（共 3）/.test(line),
    '名单按树序列了 3 个成员名（用户 2026-10-06：去掉"（引用，不是子节点）"那句废话 —— '
    + '"成员是指针"这件事写在代码与悬停提示里就够了）', line.slice(0, 120));
ok(html.indexOf('题1') < html.indexOf('题2') && html.indexOf('题2') < html.indexOf('题3'),
    '渲染顺序 = 树序（p1 → p2 → p3）');

// ===============================================================
group('成员是引用：不计入计数、不产生可折叠节点');
// ===============================================================
const htmlBefore = html;
const childOrderBefore = JSON.stringify(st.childOrder);
const nodesBefore = JSON.stringify(st.nodes);

deepEq(getChildNodes(st, st.nodes.synP).map(n => n.id), ['r1', 'r2'], '真实子节点只有 r1 / r2');
ok(getChildNodes(st, st.nodes.synP).every(n => n.ownerSynth !== SYNTH_KEY),
    '成员（p1/p2/p3）**不在** childOrder 里');

// 徽标数字 = 真实子树里被选中的节点数（r1、r2），**不含**选中的成员 p1
eq(countEligibleSubtree(st, st.nodes.synP, true, false), 2, '子树计数只看 childOrder（成员不算）');
deepEq(countBadges(html).slice(0, 2), ['2', '2'],
    '渲染出来的两个计数徽标都是 2（若把 p1 也算进去会变成 3）');

ok(!/data-id="p1"/.test(html) && !/data-id="p2"/.test(html) && !/data-id="p3"/.test(html),
    '成员没有被画成节点行（没有 data-id ⇒ 拖拽/重排/单选都认不出它）');
ok(/data-id="synP"/.test(html), '合成节点自己仍然是一个正常节点行');

deepEq(JSON.stringify(st.childOrder), childOrderBefore, '渲染**不改** childOrder（不产生新的可折叠节点）');
deepEq(JSON.stringify(st.nodes), nodesBefore, '渲染**不改**任何节点（只读）');

// ===============================================================
group('成员名单只长在合成节点上 / 截断');
// ===============================================================
const memberHtml = renderNode(st, st.nodes.p1, 0, [st.nodes.p1], 'cA', false, 'full');
ok(!/synth-members/.test(memberHtml), '成员自己那一行**不**画成员名单（只有合成节点有）');

// ===============================================================
group('方框区分：合成节点带淡色花纹类，原料节点不带（只改表现）');
// ===============================================================
// 口径："应该在方框显示上区分原料节点与合成节点 —— 给合成节点的背景打上淡色花纹"。
// 判定口径 = `isSynthesis(node)`（有非空 `synthKey`）；花纹本身写在 `index.html` 的
// `.node-box.synth-box-pattern`（`repeating-linear-gradient`，只叠 `background-image`）。
// 这里钉的是**渲染结果**：合成节点的方框多挂 `synth-box-pattern`，原料节点一个字都不多。

/** 取 `id` 那个节点的**方框**开标签（`<div class="node-box …" data-id="…">`） */
function boxOf(html, id) {
    return new RegExp(`<div class="([^"]*)" data-id="${id}">`).exec(html) || [];
}

/** 渲染一个原料节点（p1 有 ownerSynth 但**没有** synthKey ⇒ 原料） */
const materialHtml = renderNode(st, st.nodes.p1, 0, [st.nodes.p1], 'cA', false, 'full');

const synthMatch = boxOf(html, 'synP');
ok(synthMatch.length > 0, '合成节点的方框开标签认得出（class + data-id 同一行）', html.slice(0, 160));
ok(/\bsynth-box-pattern\b/.test(synthMatch[1] || ''),
    '合成节点的方框 class 里有约定名 `synth-box-pattern`', synthMatch[1]);
ok(/\bnode-box\b/.test(synthMatch[1] || ''),
    '既有 `node-box` 类**没被换掉**（只是多挂一个类，选择器全部照旧）', synthMatch[1]);
ok(/data-id="synP"/.test(synthMatch[0]), '`data-id` 契约逐字不变');

const materialMatch = boxOf(materialHtml, 'p1');
ok(materialMatch.length > 0, '原料节点的方框开标签也认得出');
eq(materialMatch[1], 'node-box',
    '原料节点（有 ownerSynth、无 synthKey）的方框 class **就是** `node-box`，不带花纹类');
ok(!/synth-box-pattern/.test(materialHtml),
    '原料节点整段 HTML 里没有花纹类（连带它的成员名单行也没有）');

// 花纹必须在 CSS 里真的存在，否则类名只是挂了个空壳
const { readFileSync } = await import('node:fs');
const INDEX_HTML = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const patternRule = /\.node-box\.synth-box-pattern\s*\{([\s\S]*?)\}/.exec(INDEX_HTML);
ok(!!patternRule, 'index.html 里有 `.node-box.synth-box-pattern` 规则（花纹有样式落点）');
const patternBody = patternRule ? patternRule[1] : '';
ok(/repeating-linear-gradient/.test(patternBody), '花纹用 `repeating-linear-gradient`（纯 CSS，不塞图片/不加依赖）');
ok(/background-image/.test(patternBody), '花纹走 `background-image`');
ok(!/background(-color)?\s*:/.test(patternBody.replace(/background-image\s*:/g, '')),
    '花纹**不**写 `background-color`（不许覆盖既有底色/状态底色）');
// ⚠️ **别钉死小数位**：具体浓度是手感决定的东西（"淡色斜纹可以深一些" ⇒
//    alpha 从 0.045 提到 0.10）—— 写死 `0\.0\d\d?` 只认 < 0.1，于是"调深"反而弄红。
//    这里只钉**性质**：是低 alpha 的 rgba（不是实色），才谈得上"不抢戏"。
//    ⚠️ 条纹里**本来就有 alpha=0 的透明停靠点**（0.10 → 0 交替），所以判据是
//    "至少有一个 >0 的着色停靠、且所有停靠都不超过 0.2"，不是"每个都 >0"。
const patternAlphas = [...patternBody.matchAll(/rgba\([^)]*?,\s*([0-9.]+)\s*\)/g)].map(m => Number(m[1]));
ok(patternAlphas.length > 0
    && patternAlphas.some(a => a > 0)
    && patternAlphas.every(a => a >= 0 && a <= 0.2),
    '花纹颜色是低 alpha 的 rgba 淡色（不抢戏：压不过文字/徽标/状态色）',
    `alpha = ${patternAlphas.join(', ')}`);

// 只改表现：渲染前 / 渲染后逐字节相同（这一组是新渲染：synP + 原料 p1 各一次）
const childOrderBefore2 = JSON.stringify(st.childOrder);
const nodesBefore2 = JSON.stringify(st.nodes);
const reRender = renderSynth(st) + renderNode(st, st.nodes.p1, 0, [st.nodes.p1], 'cA', false, 'full');
const onceRender = html + materialHtml;
// 逐字节比较，但**别把整段 HTML 打进日志**（失败时只报第一处不同的下标）
let diffAt = -1;
for (let i = 0; i < Math.max(onceRender.length, reRender.length); i++) {
    if (onceRender[i] !== reRender[i]) { diffAt = i; break; }
}
ok(diffAt === -1,
    '同一份 state 再渲染一次，HTML 逐字节可复现（花纹是确定性的，不是随机/时间相关）',
    diffAt === -1 ? `长度一致（${onceRender.length} 字节）` : `第 ${diffAt} 字节起不同`);
deepEq(JSON.stringify(st.childOrder), childOrderBefore2, '加花纹后：渲染**不改** childOrder');
deepEq(JSON.stringify(st.nodes), nodesBefore2, '加花纹后：渲染**不改**任何节点字段（含 synthKey/ownerSynth）');
eq(st.nodes.synP.synthKey, SYNTH_KEY, '合成节点该有的 `synthKey` 一个都不变');
eq(st.nodes.p1.ownerSynth, SYNTH_KEY, '原料节点该有的 `ownerSynth` 一个都不变');
deepEq(countBadges(html).slice(0, 2), ['2', '2'], '加花纹后计数徽标数字不变（花纹不碰计数）');

// 10 个成员 ⇒ 只列前 8 个名字 + "（共 10）"
const big = makeState();
for (let i = 1; i <= 7; i++) {
    big.nodes['m' + i] = { ...createNode('m' + i, 'P', { name: '成员' + i }), name: '成员' + i, ownerSynth: SYNTH_KEY };
    big.childOrder['m' + i] = [];
    big.parentOf['m' + i] = 'cB';
    big.childOrder.cB.push('m' + i);
}
const bigLine = memberLine(renderSynth(big));
// 只数**名字**之间的顿号（title 里的"不折叠、不重挂、不计入子节点数"不能算进来）
const bigText = (/：([^（]*)（共 10）/.exec(bigLine) || [])[1] || '';
eq((bigText.match(/、/g) || []).length, 7, '最多列 8 个名字（8 个名字之间有 7 个顿号）', bigText);
ok(/（共 10）/.test(bigLine), '总数照样写清楚（共 10）');
ok(!/成员6/.test(bigText), '第 9 个之后不列名字（截断）');
ok(/…$/.test(bigText), '截断处有省略号');
ok(!/data-id=/.test(line), '名单这一行里没有任何 data-id（不可重挂）');

// ===============================================================
group('很多合成节点：整趟渲染只建一次成员表（不是每个合成节点各扫一遍全树）');
// ===============================================================
// 背景：XCPC 那块会有**几百个合成节点**。若每个合成节点渲染时
// 都调一次 `synthMembers`（= 一趟全树 DFS），总代价就是 O(#合成 × N)。
// 现在的实现：`buildSynthMembersHtml` 走 `synthMembersTable`（一趟建表）+ 按
// `state.nodes` / `state.childOrder` **对象引用**做的一槽记忆化。
//
// 计数桩：把 `nodes` 包成 Proxy，只数 `Object.keys(nodes)`（= "全表遍历"发生的次数，
// `synthMembersTable` → `synthIndex` 每次建表恰好 2 次）。渲染多少个合成节点，
// 这个数字都**不许**跟着长。
const { buildSynthMembersHtml } = await import(mod('view/builders.js'));
const many = makeState();
for (let i = 1; i <= 30; i++) {
    const sid = 'syn' + i;
    many.nodes[sid] = {
        ...createNode(sid, 'P', { name: '合成' + i }), name: '合成' + i, synthKey: 'synth:many:' + i
    };
    many.childOrder[sid] = [];
    many.parentOf[sid] = 'cA';
    many.childOrder.cA.push(sid);
    const mid = 'mm' + i;
    many.nodes[mid] = {
        ...createNode(mid, 'P', { name: '成员' + i }), name: '成员' + i, ownerSynth: 'synth:many:' + i
    };
    many.childOrder[mid] = [];
    many.parentOf[mid] = 'cB';
    many.childOrder.cB.push(mid);
}
let keysCalls = 0;
many.nodes = new Proxy(many.nodes, {
    ownKeys(target) { keysCalls++; return Reflect.ownKeys(target); }
});

// ① 第一次渲染：表还没建 ⇒ 会发生全表遍历
keysCalls = 0;
const firstHtml = buildSynthMembersHtml(many, many.nodes.synP);
const firstCost = keysCalls;
ok(firstCost > 0, '首次渲染确实建了表（计数桩有效）', `ownKeys = ${firstCost}`);
ok(/成员：题1、题2、题3（共 3）/.test(firstHtml), '渲染结果逐字不变（记忆化只省遍历，不改输出）');

// ② 同一份 state 下再渲染 31 个合成节点：表已在槽里 ⇒ 全表遍历**不再发生**
keysCalls = 0;
for (let i = 1; i <= 30; i++) buildSynthMembersHtml(many, many.nodes['syn' + i]);
const laterCost = keysCalls;
console.log(`    计数桩：首次渲染建表 ${firstCost} 次 Object.keys(nodes)`
    + ` · 之后渲染 30 个合成节点合计 ${laterCost} 次`);
ok(laterCost < firstCost * 3,
    '再渲染 30 个合成节点，全表遍历没有跟着长（30 次重建的话这个数字会是首次的 30 倍）',
    `首次 ${firstCost} · 之后 30 次渲染合计 ${laterCost}`);
ok(/成员：成员7（共 1）/.test(buildSynthMembersHtml(many, many.nodes.syn7)),
    '顺带：后面这些合成节点的名单也渲染正确');

// ③ 换了 `nodes` 引用（= 结构变了）⇒ 表必须重建，不许拿旧表糊弄
const swappedNodes = new Proxy({ ...many.nodes }, {
    ownKeys(target) { keysCalls++; return Reflect.ownKeys(target); }
});
const swapped = { ...many, nodes: swappedNodes };
keysCalls = 0;
buildSynthMembersHtml(swapped, swappedNodes.synP);
ok(keysCalls > 0, '`nodes` 引用一变，表就重建（引用失效，不是永久缓存）', `ownKeys = ${keysCalls}`);

// ===============================================================
group('★ 合并显示：`[不判重 / 判重]` 一开，树上那道题按**整组**显示状态');
// ===============================================================
// `ui/dedup/summary.js` 写着"同组的计数、状态与信息在去重计数模式下才合并显示"，
// 这道用例走**真实渲染**（`renderNode`）把**显示**侧也钉住：
// 同一棵树、只改 `settings.stats.countMode`，那一条 P 的 `.status-bar` 就该跟着变。
{
    const mkState = (countMode) => {
        const st = makeState();
        st.settings.stats = { countMode };
        // p1 自己**没**处理（0），同组的兄弟 p2 处理了（1）⇒ 两列必然不同
        st.nodes.p1.values = { status1: [{ v: '0', src: 'manual', at: 'T1', account: 'k1' }] };
        st.nodes.p2.values = { status1: [{ v: '1', src: 'manual', at: 'T1', account: 'k1' }] };
        return st;
    };
    /** 取那一条节点的 `.status-bar` 的 class（`active` = 已处理） */
    const barOf = (html) => {
        const m = /class="status-bar ([^"]*)"/.exec(html);
        return m ? m[1].trim() : '';
    };
    const plain = mkState('plain');
    const plainHtml = renderNode(plain, plain.nodes.p1, 0, [plain.nodes.p1], 'cA', false, 'full');
    eq(barOf(plainHtml), '', '不判重：p1 只显示自己那份（没处理 ⇒ 不亮）');

    const dedup = mkState('dedup');
    const dedupHtml = renderNode(dedup, dedup.nodes.p1, 0, [dedup.nodes.p1], 'cA', false, 'full');
    ok(/active/.test(barOf(dedupHtml)),
        '★ 判重：同组的 p2 处理了 ⇒ p1 这一条也亮（这就是"合并显示"）', barOf(dedupHtml));
    ok(!/active/.test(barOf(plainHtml)), '对照：同一棵树在 `plain` 模式下**不亮**（差别只来自那个开关）');

    // 反向锚：把合成组拆掉（没有组头、没有指针）⇒ 两种模式逐字相同（合并显示只在有组时才起作用）
    const noGroup = mkState('dedup');
    delete noGroup.nodes.synP.synthKey;
    delete noGroup.nodes.p1.ownerSynth;
    delete noGroup.nodes.p2.ownerSynth;
    const noGroupHtml = renderNode(noGroup, noGroup.nodes.p1, 0, [noGroup.nodes.p1], 'cA', false, 'full');
    eq(barOf(noGroupHtml), barOf(plainHtml), '没有合成组 ⇒ 判重模式也显示自己那份（逐字相同）');
}

report();
