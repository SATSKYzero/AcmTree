// ================================================================
// 节点详页「🔗 所在组」（ui/nodeinfo/nodeGroup.js）
//
// 要的效果：节点详页里能看到"它属于哪个合成组、组里还有谁"，并且能跳过去。
// 这里钉**渲染**（纯函数，四种身份各一条）+ `treeTagOf` 的取值；
// "点一下真的跳树"在 `ui-wiring.smoke.mjs`（那边才有 DOM）。
//
// ⚠️ 依赖的既有口径只有一份：`core/dedup.js` 的 `synthGroups(state)`
//    （组 = 有 `synthKey` 的节点；成员 = `ownerSynth === 那个组` 的原料）。
// ================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { renderNodeGroupHtml, treeTagOf, jumpTargetOf, stripTreeWiring, breadcrumbOf, breadcrumbHtml } from '../ui/nodeinfo/nodeGroup.js';
// 「解析成主树真实 id」的唯一判据（本文件钉它；入口条与插件都 import 它）
import { realNodeIdOf, mainTreeNodeIdOf } from '../core/ops/page.js';

/** 一个能跑 `synthGroups` 的最小 state（它只用 nodes / childOrder / rootId） */
function fixture(nodes, childOrder = {}) {
    return { rootId: 'o', nodes, childOrder };
}

/**
 * 假方框：形状照抄 `view/renderers.js` 的 `renderNodeBox()`（**带** `id="node-x"` 与 `data-id`）——
 * 真那一套 import 了 immer，纯 Node 里进不来，所以这里注入。
 * ⚠️ 夹具**故意带上**那两个接线属性：`stripTreeWiring` 摘没摘干净才验得出来。
 */
const fakeBox = n => `<div id="node-${n.id}" class="node-wrapper">`
    + `<div class="node-box" data-id="${n.id}">${n.name || ''}</div></div>`;

/** 合成节点（有 synthKey）+ 两个成员（ownerSynth 指向它） */
function groupState() {
    const nodes = {
        o: { id: 'o', type: 'O', name: '根' },
        syn: { id: 'syn', type: 'C', name: '2026 IC成都', synthKey: 'xcpc:icpc-ec:2026:成都', extKey: '' },
        m1: { id: 'm1', type: 'C', name: '成都站', extKey: 'aux-xcpcio:c:icpc2026chengdu', ownerSynth: 'xcpc:icpc-ec:2026:成都' },
        m2: { id: 'm2', type: 'C', name: '成都站（QOJ）', extKey: 'qoj:c:2000', ownerSynth: 'xcpc:icpc-ec:2026:成都' }
    };
    return fixture(nodes, { o: ['syn', 'm1', 'm2'] });
}

test('treeTagOf：取 extKey 第一段（判"哪棵树"与 similarity.js 同一套）；合成节点用组标识', () => {
    assert.equal(treeTagOf({ extKey: 'aux-xcpcio:c:x' }), 'aux-xcpcio');
    assert.equal(treeTagOf({ extKey: 'qoj:c:1' }), 'qoj');
    assert.equal(treeTagOf({ synthKey: 'xcpc:icpc-ec:2026:成都' }), '组 xcpc:icpc-ec:2026:成都');
    assert.equal(treeTagOf({}), '', '两样都没有 ⇒ 空（不编一个）');
});

test('合成节点（组头）：列 **[组头 + 所有原料]**，自己那一格也在', () => {
    const st = groupState();
    const html = renderNodeGroupHtml(st.nodes.syn, st, fakeBox);
    assert.match(html, /组头/, '说清它是组头');
    assert.match(html, /组头 \+ 所有原料/, '把这一页要列什么说明白');
    assert.match(html, /成都站/, '成员在');
    assert.match(html, /成都站（QOJ）/, '另一个成员也在');
    assert.match(html, /2026 IC成都/, '★ 组头**自己**也在名单里');
    assert.equal((html.match(/data-reveal-node=/g) || []).length, 3, '组头 + 两个原料 = 三行，行行可跳');
});

test('原料且已归入：列同一份 **[组头 + 所有原料]**，并标出"本节点"', () => {
    const st = groupState();
    const html = renderNodeGroupHtml(st.nodes.m1, st, fakeBox);
    assert.match(html, /组头/, '组头那一行在');
    assert.match(html, /2026 IC成都/, '组头名字在');
    assert.match(html, /本节点/, '自己在名单里被标出来');
    assert.match(html, /aux-xcpcio/, '带出来源树（知道它是哪棵树上的）');
    assert.match(html, /qoj/, '另一个成员来自哪棵树也在');
    assert.equal((html.match(/data-reveal-node=/g) || []).length, 3, '两页列的是同一份：组头 + 两个原料');
});

test('★ 两页的名单**同一份**：顺序都是 [组头, …所有原料]，只是开头那句话不同', () => {
    const st = groupState();
    const ids = html => (html.match(/data-reveal-node="([^"]*)"/g) || [])
        .map(s => s.replace(/.*"(.*)"/, '$1'));
    assert.deepEqual(ids(renderNodeGroupHtml(st.nodes.syn, st, fakeBox)), ['syn', 'm1', 'm2']);
    assert.deepEqual(ids(renderNodeGroupHtml(st.nodes.m1, st, fakeBox)), ['syn', 'm1', 'm2'],
        '原料页也是"组头在最前"');
    assert.notEqual(renderNodeGroupHtml(st.nodes.syn, st, fakeBox),
        renderNodeGroupHtml(st.nodes.m1, st, fakeBox), '但两页不是同一段文字（开头那句不同）');
});

test('★ 名单里的方框是**只读渲染**：整框可点（`data-reveal-node`），且摘掉了树上的接线', () => {
    const st = groupState();
    const html = renderNodeGroupHtml(st.nodes.m1, st, fakeBox);
    assert.match(html, /class="nig-box" data-reveal-node="m1"/, '框本身带跳转属性（点框就跳）');
    assert.match(html, /class="node-box"/, '真的是树上那套方框渲染的结果');
    // ⚠️ 这几条是**反向锚**：不摘掉的话 `revealNode` 会滚到详页里这一份副本，而不是树上的那一份。
    //    判据只看**方框那一段**：`nig-meta` 之后是每行自己的 id 与「📋 打开详页」按钮，
    //    那个按钮的 `data-id` 是给 `btn-node-info`（开详页）用的接线，**不是**树的接线
    //    （`findNodeBox` 找的是 `.node-box[data-id]`，不会碰到它）。
    const boxPart = html.slice(0, html.indexOf('nig-meta'));
    assert.ok(boxPart.length > 0 && html.includes('nig-meta'), '取到的是方框那一段（少了工序要当场红）');
    assert.ok(!/id="node-/.test(boxPart), 'id="node-x" 必须摘掉（否则 getElementById 可能拿到副本）');
    assert.ok(!/data-id=/.test(boxPart), 'data-id 必须摘掉（否则 findNodeBox 取到副本，"点框跳过去"失灵）');
    assert.ok(!/<button/.test(boxPart), '方框里不再单独放一个「跳到树上」按钮：整框就是按钮');
});

test('stripTreeWiring：只摘 `id="node-…"` 与 `.node-box` 上的 `data-id`，别的属性一个不动', () => {
    // 已知坏样本 → 必须摘干净
    assert.equal(stripTreeWiring('<div id="node-x" class="node-wrapper">'
        + '<div class="node-box" data-id="x">A</div></div>'),
    '<div class="node-wrapper"><div class="node-box">A</div></div>');
    assert.equal(stripTreeWiring('<div id="node-1" class="node-wrapper">'
        + '<div class="node-box synth-box-pattern" data-id="1">B</div></div>'),
    '<div class="node-wrapper"><div class="node-box synth-box-pattern">B</div></div>',
    '合成节点多出来的那个类不许被吃掉');
    // 已知好样本 → 必须一个字不改（别的属性、别的 data-* 都不许误伤）
    assert.equal(stripTreeWiring('<div class="node-wrapper"><div class="node-box">C</div></div>'),
        '<div class="node-wrapper"><div class="node-box">C</div></div>');
    assert.equal(stripTreeWiring('<button data-id="x" data-foo="node-1">D</button>'),
        '<button data-id="x" data-foo="node-1">D</button>',
        '`.node-box` 之外的 data-id 不动（那是别的部件的接线，不是我们的）');
    assert.equal(stripTreeWiring(''), '');
    assert.equal(stripTreeWiring(null), '', 'null 不炸');
});

test('原料但没归入：照实说 + 指到该去哪归入（不编一个组）', () => {
    const st = fixture({ o: { id: 'o', type: 'O' }, p: { id: 'p', type: 'P', name: '散题' } }, { o: ['p'] });
    const html = renderNodeGroupHtml(st.nodes.p, st, fakeBox);
    assert.match(html, /没有归入任何合成组/, '说明没归入');
    assert.match(html, /判重整理/, '指到该去哪');
    assert.ok(!/data-reveal-node=/.test(html), '没有组就没有可跳的行');
});

test('悬空指针（ownerSynth 指向不存在的组）：如实说，不假装有组', () => {
    const st = fixture({ o: { id: 'o', type: 'O' }, x: { id: 'x', type: 'C', name: '孤儿', ownerSynth: 'no-such-group' } }, { o: ['x'] });
    const html = renderNodeGroupHtml(st.nodes.x, st, fakeBox);
    assert.match(html, /那个组不存在|悬空/, '说白了是悬空');
    assert.match(html, /判重整理/, '指到清理的地方');
});

test('节点不存在 / 空 state 不炸', () => {
    assert.match(renderNodeGroupHtml(null, {}, fakeBox), /节点不存在/);
    assert.match(renderNodeGroupHtml({ id: 'z', type: 'P' }, {}, fakeBox), /没有归入任何合成组/);
});

test('★ 每一条是「卡片」：左色条 + 虚线分隔 + 角色标签在框**上方**（"让分界明显一点"）', () => {
    const st = groupState();
    const html = renderNodeGroupHtml(st.nodes.m1, st, fakeBox);
    assert.match(html, /border-left:3px solid #0ea5e9/, '★ 组头那条是**蓝**色条');
    assert.match(html, /border-bottom:1px dashed/, '★ 条目之间**虚线分隔**');
    const roleIdx = html.indexOf('nig-role');
    const boxIdx = html.indexOf('nig-box');
    assert.ok(roleIdx >= 0 && roleIdx < boxIdx,
        '★ 角色标签在节点框**上方**（夹在框和面包屑中间就看不出条目从哪开始）');
});

test('★ 只读面包屑（丙）：来源树 + 祖先路径，每段可点；名字在 values 里也认', () => {
    // ⚠️ 应用侧很多节点的显示名在 `values.name[0].v` 里，不在 `node.name`
    //    （实测踩到：面包屑里好几段显示成「（未命名）」，而树上明明有名字）
    const st = {
        rootId: 'o', parentOf: { o: '', A: 'o', B: 'A', p: 'B' },
        nodes: {
            o: { id: 'o', type: 'O', values: { name: [{ v: 'XCPC' }] } },
            A: { id: 'A', type: 'S', values: { name: [{ v: '省赛与邀请赛' }] } },
            B: { id: 'B', type: 'C', values: { name: [{ v: '2026' }] } },
            p: { id: 'p', type: 'P', name: 'A 题', extKey: 'qoj:c:11:p:A' }
        }
    };
    assert.deepEqual(breadcrumbOf(st, 'p').map((c) => c.name), ['XCPC', '省赛与邀请赛', '2026']);
    // ⚠️ 渲染位置在**节点详页的头部**（`nodeInfoView.buildShell` 调的就是这个纯函数）——
    //    这里验纯函数本身（详页那一层会拉进 immer，纯 Node 里 import 不了）。
    const html = breadcrumbHtml(st, st.nodes.p);
    assert.match(html, /nig-crumb/, '面包屑渲染了（**没归入任何组**时也要有 —— 它是"这个节点在树上哪"）');
    assert.match(html, />qoj</, '最前面是**来源树**（丙 = 来源树 + 祖先路径）');
    assert.match(html, /data-reveal-node="B"/, '祖先路径每一段都可点跳转');
    assert.ok(!/（未命名）/.test(html), '★ 不许出现「（未命名）」');
});

test('★ 面包屑那两段"好像不存在"的：根节点印「🏠 根目录」；来源树那一段不是节点、可关掉', () => {
    // 用户 2026-10-15 看着列表那一格（`cf › （未命名） › Codeforces › CF contest › …`）：
    // "这个面包屑 **前两节好像不存在**啊"。真包（`acm-data/nodes/cf-contest.json`）里那条链是
    //   `cf`(W, 名字 Codeforces) → CF contest → 2026 → 比赛 → 题
    // ⇒ 第一段是 `treeTagOf` 出来的**来源树标签**（= 那个 W 节点的 extKey，**不是节点**），
    //   第二段是**应用自己造的那个无名根节点**（`createInitialState` 只给类型 'O'）。
    const st = {
        rootId: 'o', parentOf: { o: null, w: 'o', p: 'w' },
        nodes: {
            // ⚠️ 根**没有名字**（真库里就是这样）——以前这里印「（未命名）」
            o: { id: 'o', type: 'O' },
            w: { id: 'w', type: 'W', name: 'Codeforces', extKey: 'cf' },
            p: { id: 'p', type: 'P', name: 'SauSaGe Bank', extKey: 'cf:c:2269:p:A' }
        }
    };
    assert.deepEqual(breadcrumbOf(st, 'p').map((c) => c.name), ['🏠 根目录', 'Codeforces'],
        '★ 无名的根节点 = 根目录（别处都这么叫它，只有这条链以前叫「（未命名）」）');
    const withTag = breadcrumbHtml(st, st.nodes.p);
    assert.match(withTag, />cf</, '缺省**照旧**带来源树那一段（详页头部那条不变）');
    const noTag = breadcrumbHtml(st, st.nodes.p, { treeTag: false });
    assert.ok(!/>cf</.test(noTag), '★ `{treeTag:false}` ⇒ 不画那段**不是节点**的标签');
    assert.match(noTag, /Codeforces/, '真正的树上路径还在（来源树那段是 W 节点自己的 extKey）');
    assert.match(breadcrumbHtml(st, st.nodes.p, { includeSelf: true, treeTag: false }), /crumb-self/,
        '两个选项能一起用');
});

// ================================================================
// ★ **页内**面包屑（副页那一支）—— 与主树那一支**语义不同，但同在 `breadcrumbHtml` 里**
//
// 病根（用户实测 `v9.0.19`）：副页节点详页的「📊 题目分布统计」筛出来的题目**连面包屑都没有**
// （入口条整支被跳过）。补的时候**不能**拿主树那条链去渲染 —— 它走 `state.parentOf`（**主树**），
// 页内 id（`v_xxx`）在那张表里根本不存在 ⇒ 只会印出「（就在根下）」这种**假话**。
// `v9.0.21` 起主副页**合成同一个 `breadcrumbHtml(state, node)`**（用户 2026-10-13 拍板）：
// 函数**内部**按 `node._virtual` 分支，调用方不再自己挑名字。这里钉三件：① 页内链是真链、每段带**页内 id**；② 页内根 / 认不出归属 / 断链 ⇒ **不画**；
// ③ 绝不出现那句假话（也没有混进主树那份渲染器）。
// 数据真源：`core/ops/page.js:nodeAncestorsOf`（分流到 `virtualAncestorsOf`，与 `locateVirtualNode` 同一份数据）。
// ================================================================
function vPageState() {
    return {
        rootId: 'cA',
        nodes: {
            cA: { id: 'cA', type: 'C', name: '2024 省赛' },
            p1: { id: 'p1', type: 'P', name: 'A 题' }
        },
        parentOf: { cA: null, p1: 'cA' },
        childOrder: { cA: ['p1'], p1: [] },
        pages: {
            pg1: {
                id: 'pg1', name: '我的题单', rootId: 'v_root',
                virtualIndex: {
                    v_root: { id: 'v_root', refId: null, type: 'O', parentId: null, children: ['v_cA'] },
                    v_cA: { id: 'v_cA', refId: 'cA', type: 'C', parentId: 'v_root', children: ['v_p1'] },
                    v_p1: { id: 'v_p1', refId: 'p1', type: 'P', parentId: 'v_cA', children: [] }
                }
            }
        }
    };
}

test('★ breadcrumbHtml：**副页节点**走页内祖先链（每段带**页内 id** + 「📄 页名」前缀）', () => {
    const st = vPageState();
    const html = breadcrumbHtml(st, { id: 'v_p1', _virtual: true });
    assert.match(html, /vnode-crumb/, '用的是**页内**那一条渲染器');
    assert.ok(!/nig-crumb/.test(html), '不是主树那份 `breadcrumbHtml`（两份语义不同）');
    assert.match(html, /📄 我的题单/, '带「📄 页名」前缀（知道这是**哪一页**的链）');
    const ids = (html.match(/data-reveal-node="([^"]*)"/g) || [])
        .map((s) => s.replace(/.*"(.*)"/, '$1'));
    assert.deepEqual(ids, ['v_root', 'v_cA'],
        '★ 每段带的是**页内 id**（点一段 = 跳到那一层）；根在前、不含自己');
    assert.match(html, /2024 省赛/, '名字取它引用的真实节点（页内 id 本身没法给人看）');
    assert.ok(!/（就在根下）/.test(html), '★ 不许出现主树那份的兜底假话');
});

test('★ breadcrumbHtml：副页节点——页内根 / 认不出归属 / 断链 ⇒ **不画**（别编一条链）', () => {
    const st = vPageState();
    assert.equal(breadcrumbHtml(st, { id: 'v_root', _virtual: true }), '',
        '页内**根**节点：它就是这一页本身，印一条只有自己的链没有意义');
    assert.match(breadcrumbHtml(st, { id: 'v_cA', _virtual: true }), /📄/,
        '（对照）非根那条真的画出来了');
    assert.equal(breadcrumbHtml(st, { id: '已经删掉的', _virtual: true }), '', '认不出归属 ⇒ 不画');
    assert.equal(breadcrumbHtml(st, { id: 'p1', _virtual: true }), '',
        '主树真实 id 不走页内那一支（同一个函数里按 `_virtual` 分流）');
    const broken = vPageState();
    broken.pages.pg1.virtualIndex.v_p1.parentId = '没了';
    assert.equal(breadcrumbHtml(broken, { id: 'v_p1', _virtual: true }), '',
        '断链 ⇒ 不画（宁可没有，也不印假话）');
});

// ================================================================
// 「🔎 跳到树上」这一格该指向谁 —— 副页那个坑的守卫
// ================================================================
// 口径原文是「跳转(自身所在的)树上位置」。真实节点没问题；
// **副页**里拿到的是页内虚拟 id（`v_xxx`），主视图里根本没有它 —— 必须解析成它引用的真实节点。
// 这里纯函数验，冒烟那边只验 DOM 接线。
const pagesState = {
    rootId: 'cA',
    nodes: { cA: { id: 'cA', type: 'C', name: '2024 省赛' } },
    childOrder: { cA: [] },
    pages: {
        main: {
            id: 'main',
            virtualIndex: {
                v_root: { id: 'v_root', refId: null, type: 'O', children: ['v_cA'] },
                v_cA: { id: 'v_cA', refId: 'cA', type: 'C', children: [] }
            }
        }
    }
};

test('jumpTargetOf：真实节点 ⇒ 指向它自己，文案「跳到树上」', () => {
    assert.deepEqual(jumpTargetOf(pagesState, 'cA', false),
        { id: 'cA', canJump: true, label: '🔎 跳到树上' });
});

test('★ jumpTargetOf：副页节点 ⇒ 指向**它引用的真实节点**（不是 `v_xxx`）', () => {
    assert.deepEqual(jumpTargetOf(pagesState, 'v_cA', true),
        { id: 'cA', canJump: true, label: '🔎 跳到它引用的主节点' });
});

test('jumpTargetOf：副页**根**节点（不引用真实节点）⇒ 没得跳，这一格不出现', () => {
    assert.deepEqual(jumpTargetOf(pagesState, 'v_root', true), { id: '', canJump: false, label: '' });
});

test('jumpTargetOf：空 id 不炸', () => {
    assert.deepEqual(jumpTargetOf(pagesState, '', false), { id: '', canJump: false, label: '' });
});

test('★ jumpTargetOf：树上**没有**这个 id ⇒ 不给入口（与入口条共用同一份判据）', () => {
    // 「解析出来、但树上已经没这个节点」曾经只有入口条那一侧挡（`jumpTargetOf` 没查 `state.nodes`）
    // ⇒ 这里钉住两边一致：不给入口，别画一个"点了没反应"的假链接。
    assert.deepEqual(jumpTargetOf(pagesState, '已经删掉的节点', false),
        { id: '', canJump: false, label: '' });
});

// ================================================================
// 「解析成主树真实 id」只有一份（`core/ops/page.js:mainTreeNodeIdOf`）
// ================================================================
// 病根：这一步（`realNodeIdOf` 解析 → **还要求 `state.nodes` 里真有** → 否则 `''`）
// 以前散在两处：`ui/kit/nodeEntry.js` 的入口条 + 插件 `ContestOverview/index.js` 注入的 `jumpId`
// （`nodeGroup.js:jumpTargetOf` 是第三处、当时还少查了 `state.nodes`）。写法一样、迟早分叉 ——
// 少查一次就会画出"点了没反应的假链接"（比纯文本更糟，见 `ui/kit/report.js:nodeOrText` 文件头）。
// ⚠️ 插件 import core 是允许的、import `ui/` 不行（`src/features/AGENTS.md`）⇒ 这一份只能住 core。
test('★ mainTreeNodeIdOf：副页 id 先解析、树上没有的一律空串（"能不能跳"的唯一判据）', () => {
    const s = pagesState;
    assert.equal(mainTreeNodeIdOf(s, 'cA'), 'cA', '真实节点 ⇒ 原样（它就在树上）');
    assert.equal(mainTreeNodeIdOf(s, 'v_cA'), 'cA', '副页页内 id ⇒ 它引用的**真实节点**');
    assert.equal(mainTreeNodeIdOf(s, 'v_root'), '', '副页根节点（不引用真实节点）⇒ 不能跳');
    assert.equal(mainTreeNodeIdOf(s, '已经删掉的节点'), '', '树上没这个 id ⇒ 不能跳（别画假链接）');
    assert.equal(mainTreeNodeIdOf(s, ''), '', '空 id ⇒ 不能跳');
    assert.equal(mainTreeNodeIdOf(s, null), '', 'null ⇒ 不能跳');
    assert.equal(mainTreeNodeIdOf(null, 'cA'), '', '没有 state 也不炸');
    // ⚠️ 反向锚：`realNodeIdOf` 的语义**没有**被改（认不出也原样返回）——
    //    "解析成真实 id"与"能不能跳"是两件事，别把后者塞进前者。
    assert.equal(realNodeIdOf(s, '已经删掉的节点'), '已经删掉的节点', '`realNodeIdOf` 仍原样返回');
    assert.equal(realNodeIdOf(s, 'v_root'), 'v_root', '副页根节点解析不出真实 id（原样）');
});

// ================================================================
// 源码级：**内联入口条**（🔎 + 📋）—— 冒烟桩看不见它们，只能用源码锚兜着
//
// 病根（`v9.0.13` 实测）：统计页 AC 列表那两行的入口条是**插在方框后面**的，而方框来自
// `renderNode(..., 'readonly')` 的 HTML 字符串 —— 冒烟用的 DOM 桩**不解析 `innerHTML`**
// ⇒ 桩里一个 `.node-box[data-id]` 都查不到，`appendNodeEntries` 整个空转。
// 于是"把入口条删了 / 把 `data-reveal-node` 去掉了"这种回归**没有任何断言会红**
// （实测：删掉承载那一句，`npm test` + `npm run test:smoke` 全绿）。
// ⇒ 这里改钉**源码**：生成处必须同时给出承载（`data-reveal-node`）与 📋 入口（`btn-node-info`），
//   调用处必须真的调 `appendNodeEntries`。
// ⚠️ **别去改 DOM 桩让它解析 `innerHTML`** —— 会动一堆既有断言的语义（桩文件头写着这条边界）。
// ⚠️ 红了怎么修：**改代码**（把入口条补回去），不是把这条守卫删了。
// ================================================================
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const readSrc = (rel) => stripComments(fs.readFileSync(new URL(rel, import.meta.url), 'utf8'));

/** 🔎 的**承载**：`markGoto` 挂属性，或直接写 `data-reveal-node`（DOM / HTML 串两种写法都算） */
const REVEAL_BINDING = /markGoto\(|setAttribute\(\s*['"]data-reveal-node['"]|dataset\.revealNode\s*=|data-reveal-node=/;
/** 📋 的入口：`ui/G_events.js` 的文档级委托认这个类（少一半 = 点了没反应） */
const INFO_ENTRY = /btn-node-info/;

test('★ 源码级：内联入口条的生成处必须同时给出 🔎 承载与 📋 入口（冒烟测不到它们）', () => {
    const sites = [
        ['../ui/kit/nodeEntry.js', '统计 AC 列表那两行的入口条本身（方框来自 innerHTML ⇒ 桩里入口条整支空转）'],
        ['../features/AutoImport/extKeyPanel.js', 'extKey 清单表每行的 🔎/📋'],
        ['../features/AutoImport/ui/recordTable.js', '逐条记录表每行的 🔎/📋（写在 tr.innerHTML 里）'],
        ['../features/ContestOverview/render.js', '概览的题号 / 比赛名那一截'],
        ['../ui/nodeinfo/nodeGroup.js', '「所在组」名单每行的方框与 📋']
    ];
    const bad = [];
    for (const [rel, why] of sites) {
        const src = readSrc(rel);
        if (!REVEAL_BINDING.test(src)) bad.push(`${rel}（${why}）缺 🔎 的承载 → data-reveal-node`);
        if (!INFO_ENTRY.test(src)) bad.push(`${rel}（${why}）缺 📋 入口 → btn-node-info`);
    }
    assert.deepEqual(bad, [], '入口条少一半就等于没铺（这些地方冒烟桩都看不见）—— 补代码，别删守卫');
    // ★ 自检：判据本身会咬（否则这一条就是"永远绿"）
    assert.ok(REVEAL_BINDING.test('  markGoto(el, id);'), '（自检）`markGoto` 那种写法认得出');
    assert.ok(!REVEAL_BINDING.test('  el.title = "在树上定位这个节点";'),
        '（自检）把承载删掉之后的样本必须认不出来');
    assert.ok(INFO_ENTRY.test("info.className = 'btn-icon btn-node-info';"), '（自检）📋 入口认得出');
});

test('★ 源码级：入口条不许自造 🔎 承载（`markGoto` 是唯一那一份）', () => {
    const nodeEntry = readSrc('../ui/kit/nodeEntry.js');
    assert.match(nodeEntry, /markGoto\(/, '入口条要用 `markGoto` 挂承载（它是"唯一承载"）');
    assert.doesNotMatch(nodeEntry, /dataset\.revealNode\s*=|setAttribute\(\s*['"]data-reveal-node['"]/,
        '别在入口条里自己再写一遍 `data-reveal-node`（第二份承载会与 `markGoto` 的观感/兼容钩子分叉）');
    // 承载自己那一份：`markGoto` 必须真的把属性挂上（删了这一句 ⇒ 全仓的 🔎 一起失灵）
    assert.match(readSrc('../ui/kit/actions.js'), /el\.dataset\.revealNode\s*=\s*id/,
        '`markGoto` 必须挂 `data-reveal-node` —— 这是 `ui/AGENTS.md`「三样都只有一份」里的那一样');
});

test('★ 源码级：AC 列表那两处必须真的调 `appendNodeEntries`（桩里它整个空转）', () => {
    for (const rel of ['../ui/stats/ac/listView.js', '../ui/stats/ac/tracking.js']) {
        const src = readSrc(rel);
        assert.match(src, /import\s*\{[^}]*appendNodeEntries[^}]*\}/,
            `${rel} 要 import 入口条的插入器（没 import = 这一页没有 🔎/📋）`);
        assert.match(src, /appendNodeEntries\(container/,
            `${rel} 渲染之后要真的调它（只 import 不调 = 没铺上）`);
    }
    // 行选择器按各页的 DOM 形状来：列表页方框在 `.ac-list-rows` 里，最近 AC 页方框直接挂在容器上
    assert.match(readSrc('../ui/stats/ac/listView.js'), /appendNodeEntries\(container, state, '\.ac-list-rows'\)/,
        'listView 的方框都夹在 `.ac-list-rows` 那一段里');
    assert.match(readSrc('../ui/stats/ac/tracking.js'), /appendNodeEntries\(container, state\);/,
        'tracking 的方框直接挂在 `#ac-tracking-list` 上（给它一个行选择器就一行都找不到）');
});

// ================================================================
// 源码级：跳树**只走 `REVEAL_NODE`**（不许自己 import tabs / folderMode 去展开）
// ================================================================
// 为什么要有这条：`ui/tabs.js` 已经 import 了 `nodeInfoView.js`；这边再 import 回去就成环，
// 而且"展开祖先 / 翻页 / 滚动高亮"那套逻辑只在 `ui/revealNode.js` 一份 —— 各写一份就会漂。
test('源码级：nodeGroup*.js 不许 import ui/tabs.js 或 folder/folderMode.js（跳树只走 REVEAL_NODE）', () => {
    const files = ['../ui/nodeinfo/nodeGroup.js', '../ui/nodeinfo/nodeGroupActions.js'];
    // ⚠️ 判据要认**末段**是 `tabs.js` / `folderMode.js` 的任意相对写法（`'../tabs.js'` 也是同一个文件）——
    //    只匹配 `ui/tabs.js` 会把这种相对写法漏掉。
    const banned = /from\s+['"](?:[^'"]*\/)?(?:tabs|folderMode)\.js['"]/;
    const strip = s => s.replace(/\/\/.*$/gm, '');
    const offenders = [];
    for (const rel of files) {
        const src = fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
        if (banned.test(strip(src))) offenders.push(rel);
    }
    assert.deepEqual(offenders, [], '跳树请派发 EVENTS.REVEAL_NODE（见 ui/revealNode.js）');
    // ★ 自检：这条 lint 真的会咬，且不会误伤注释
    assert.ok(banned.test(strip("import { switchTab } from '../tabs.js';")),
        '相对写法 `../tabs.js` 也要咬住');
    assert.ok(banned.test(strip("import { enterFolder } from '../folder/folderMode.js';")),
        'folderMode 也要咬');
    assert.ok(!banned.test(strip("// 以前写的是 from '../tabs.js'，现已删")),
        '注释里提不算（先剥注释）');
    assert.ok(!banned.test(strip("import { x } from './nodeTabs.js';")),
        '别的文件（末段不是 tabs.js）不许误伤');
});

// ================================================================
// 源码级：生产里那口"只读节点框"必须真的是**树上那一套渲染**
// ================================================================
// 为什么要有这条：注入式渲染（见 `nodeRow`）的好处是能单测，代价是**生产端可能忘了注**。
// 所以钉住：`nodeInfoView.js` 传给 `renderNodeGroupHtml` 的第三个参数，必须是包着
// `view/renderers.js` 的 `renderNode(...)` 的那个函数（而不是自己拼一个像方框的东西）。
test('源码级：nodeInfoView 注入的方框 = 树上那套 `renderNode`（folder-header 模式，不是自己拼一个）', () => {
    const strip = s => s.replace(/\/\/.*$/gm, '');
    const src = strip(fs.readFileSync(new URL('../ui/nodeinfo/nodeInfoView.js', import.meta.url), 'utf8'));
    assert.match(src, /renderNodeGroupHtml\(ctx\.node, ctx\.state, renderNodeBoxHtml\)/,
        '「所在组」的 mount 要把方框渲染器传进去');
    assert.match(src,
        /function renderNodeBoxHtml\(node\)\s*\{\s*return renderNode\(AppState, node, 0, \[\], null, true, 'folder-header'\);/,
        '注入的那个函数必须是树上那一套渲染（顶部那一格用的也是它）');
    assert.ok(!/renderNodeGroupHtml\(ctx\.node, ctx\.state\)/.test(src),
        '不许再有两参调用（那样名单会一行都画不出来）');
});
