// ================================================================
// 副页复制（`core/ops/page.js:duplicatePage`）—— 纯逻辑测试
//
// 任务来源：用户 2026-10-13「副页复制 / 整个副页复制」。口径与边界写在 `docs/subpage-copy.md`。
// 这里钉的是**会红的口径**（不是复述现状）：
//   ① 结构逐字保留（父子关系 / `children` 顺序 / `type` / `refId`）；
//   ② **页内 id 全换新**、`refId` 原样（两页指向同一批真实节点）—— 复用 id 会让 `locateVirtualNode` 两页互认；
//   ③ 视图态三样（`expanded` / `currentPage` / `selected`）与页的 `selected` **一起复制**；
//   ④ **源页一个字没动**；
//   ⑤ 命名：默认「原名副本」，重名往后加序号；
//   ⑥ 边界：源页不存在 / 到 `MAX_PAGES` ⇒ 抛；空副页也能复制。
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { duplicatePage } from '../core/ops/page.js';
import { createPage, createVNode } from '../core/model/page.js';
import { createInitialState } from '../core/model/state.js';
import { MAX_PAGES } from '../A_constants.js';

/** 造一个可控的 draft：一个副页 + 一棵 vNode 树（含展开态 / 页码 / 选中态） */
function makeDraft() {
    const d = createInitialState();
    d.nodes = {
        p1: { id: 'p1', type: 'P', name: 'A题', values: {} },
        p2: { id: 'p2', type: 'P', name: 'B题', values: {} },
        c1: { id: 'c1', type: 'C', name: '某场比赛', values: {} }
    };
    d.childOrder = { p1: [], p2: [], c1: ['p1', 'p2'] };
    const page = createPage('page_src', '我的题单', 'vroot_src');
    page.virtualIndex.vroot_src = createVNode('vroot_src', null, 'O', null);
    const vc = createVNode('v_c', 'c1', 'C', 'vroot_src');
    vc.expanded = true;
    vc.currentPage = 3;
    page.virtualIndex.v_c = vc;
    page.virtualIndex.vroot_src.children = ['v_c'];
    const vp1 = createVNode('v_p1', 'p1', 'P', 'v_c');
    vp1.selected = true;
    page.virtualIndex.v_p1 = vp1;
    const vp2 = createVNode('v_p2', 'p2', 'P', 'v_c');
    page.virtualIndex.v_p2 = vp2;
    vc.children = ['v_p1', 'v_p2'];
    page.selected = true;
    page.vNodeStats = { v_c: { pCount: 2 } };
    d.pages = { page_src: page };
    d.currentPageId = 'page_src';
    return d;
}

/** 按"根 → 子"的路径描述整棵树（用 refId/type 说话，与 id 无关 ⇒ 能跨两页比对结构） */
function shapeOf(page) {
    const out = [];
    const walk = (vid, path) => {
        const v = page.virtualIndex[vid];
        const tag = `${v.type}${v.refId ? ':' + v.refId : ''}`;
        out.push(`${path}/${tag}`);
        (v.children || []).forEach((cid, i) => walk(cid, `${path}/${tag}[${i}]`));
    };
    walk(page.rootId, '');
    return out.sort();
}

test('复制：结构逐字保留（父子关系 / children 顺序 / type / refId）', () => {
    const d = makeDraft();
    const before = shapeOf(d.pages.page_src);
    const { page, nodeCount } = duplicatePage(d, 'page_src');
    assert.equal(nodeCount, 3, '复制了 3 个 vNode（不含根）');
    assert.deepEqual(shapeOf(page), before, '两页的树形逐条相同');
    const src = d.pages.page_src;
    assert.deepEqual(page.virtualIndex[page.rootId].children.map((id) => page.virtualIndex[id].refId),
        src.virtualIndex[src.rootId].children.map((id) => src.virtualIndex[id].refId),
        '根的孩子顺序（按 refId 表达）一致');
});

test('★ 复制：页内 id 全换新、refId 原样（两页指向同一批真实节点）', () => {
    const d = makeDraft();
    const srcIds = Object.keys(d.pages.page_src.virtualIndex);
    const { page } = duplicatePage(d, 'page_src');
    const newIds = Object.keys(page.virtualIndex);
    assert.equal(newIds.length, srcIds.length, '节点数一样');
    const overlap = newIds.filter((id) => srcIds.includes(id));
    assert.deepEqual(overlap, [], '新旧页内 id **一个都不许重合**（复用会让 locateVirtualNode 两页互认）');
    assert.notEqual(page.rootId, d.pages.page_src.rootId, '根 id 也换');
    assert.notEqual(page.id, d.pages.page_src.id, '页 id 也换');
    const refsOf = (p) => Object.values(p.virtualIndex).map((v) => v.refId).filter(Boolean).sort();
    assert.deepEqual(refsOf(page), refsOf(d.pages.page_src), 'refId 集合完全相同');
});

test('★ 复制：视图态三样 + 页的 selected 一起搬', () => {
    const d = makeDraft();
    const { page } = duplicatePage(d, 'page_src');
    const byRef = (p, ref) => Object.values(p.virtualIndex).find((v) => v.refId === ref);
    assert.equal(byRef(page, 'c1').expanded, true, '展开态搬过来了');
    assert.equal(byRef(page, 'c1').currentPage, 3, '页码搬过来了');
    assert.equal(byRef(page, 'p1').selected, true, '圈选搬过来了');
    assert.equal(page.selected, true, '页的 selected 也搬');
    assert.deepEqual(page.vNodeStats, d.pages.page_src.vNodeStats, 'vNodeStats 一起搬');
});

test('★ 复制：源页一个字没动（复制是只读源）', () => {
    const d = makeDraft();
    const snapshot = JSON.stringify(d.pages.page_src);
    duplicatePage(d, 'page_src');
    assert.equal(JSON.stringify(d.pages.page_src), snapshot, '源页逐字未变');
    assert.equal(Object.keys(d.pages).length, 2, '多出来的是新页，源页仍在');
});

test('复制：命名 = 原名 + 副本；重名往后加序号', () => {
    const d = makeDraft();
    assert.equal(duplicatePage(d, 'page_src').name, '我的题单副本');
    assert.equal(duplicatePage(d, 'page_src').name, '我的题单副本2', '已有「我的题单副本」⇒ 加 2');
    assert.equal(duplicatePage(d, 'page_src').name, '我的题单副本3');
    assert.equal(Object.keys(d.pages).length, 4, '★ 连建三页：页数**真的** +3（同一毫秒也不许撞 id）');
    assert.equal(duplicatePage(d, 'page_src', '  自定义名  ').name, '自定义名', '给了名字就用它（并且 trim）');
    assert.equal(duplicatePage(d, 'page_src', '自定义名').name, '自定义名2', '自定义名重名也加序号');
});

test('复制：边界（源页不存在 / 到上限 / 空副页）', () => {
    const d = makeDraft();
    assert.throws(() => duplicatePage(d, 'page_没有'), /副页不存在/);
    // 空副页（只有根）也要能复制
    const empty = createPage('page_empty', '空页', 'vroot_e');
    empty.virtualIndex.vroot_e = createVNode('vroot_e', null, 'O', null);
    d.pages.page_empty = empty;
    const r = duplicatePage(d, 'page_empty');
    assert.equal(r.nodeCount, 0, '空副页复制出 0 个 vNode');
    assert.equal(Object.keys(r.page.virtualIndex).length, 1, '只有一个新根');
    assert.notEqual(r.page.rootId, 'vroot_e', '根 id 仍要换新');
    // 到上限：把 pages 填满
    const d2 = makeDraft();
    for (let i = 0; i < MAX_PAGES; i++) {
        const p = createPage('page_fill' + i, '填' + i, 'vroot_fill' + i);
        p.virtualIndex['vroot_fill' + i] = createVNode('vroot_fill' + i, null, 'O', null);
        d2.pages['page_fill' + i] = p;
    }
    assert.throws(() => duplicatePage(d2, 'page_src'), new RegExp(`副页数量已达上限（${MAX_PAGES}个）`));
});

test('★ 复制：只读守卫在（"只看别人"时不许复制）', () => {
    const d = makeDraft();
    // 只读判据 = `currentAccountId !== viewingAccountId`（`core/ops/account.js:isViewOnly`）
    d.currentAccountId = 'acc_me';
    d.viewingAccountId = 'acc_other';
    assert.throws(() => duplicatePage(d, 'page_src'), /只读模式下不能手改/);
});

test('★ 复制大副页：结构不许被 id 碰撞弄坏（用户报的"容器变成一个单题"）', () => {
    // 用户 2026-10-13 实测：复制 1904 个节点的副页之后，「2023 CC秦皇岛」变成一个单题。
    // 根因是 `nextVirtualId()` 当时只靠"毫秒 + 4 位随机"⇒ 同毫秒连着要上千个 id 会**生日碰撞**，
    // 撞上时两个 vNode 合成一个（后写覆盖前写，两个父指向同一个 id）。
    // ⇒ 这条钉的是"**发 N 个 id 也不许撞**"，以及撞了之后会被看出来的那三处症状。
    // ⚠️ 夹具自己用**字面 id**（它测的是复制，不是发号器；发号器自有 `opsIdUniqueness.test.js` 钉）。
    const d = createInitialState();
    d.nodes = { root: { id: 'root', type: 'O', name: '根', values: {} } };
    d.childOrder = { root: [] };
    d.parentOf = {};
    d.rootId = 'root';
    const page = createPage('page_big', '我的题单', 'vroot');
    page.virtualIndex.vroot = createVNode('vroot', null, 'O', null);
    const CONS = 30, PER = 30;                       // 30 场 × 30 题 = 900+ 个 vNode，同一次操作内发完
    for (let c = 0; c < CONS; c++) {
        const cid = 'vc' + c;
        const vc = createVNode(cid, 'c' + c, 'C', 'vroot');
        page.virtualIndex[cid] = vc;
        page.virtualIndex.vroot.children.push(cid);
        for (let p = 0; p < PER; p++) {
            const pid = 'vp' + c + '_' + p;
            const vp = createVNode(pid, 'p' + c + '_' + p, 'P', cid);
            page.virtualIndex[pid] = vp;
            vc.children.push(pid);
        }
    }
    d.pages = { page_big: page };
    const srcCount = Object.keys(page.virtualIndex).length;
    const { page: copy } = duplicatePage(d, 'page_big');
    const ids = Object.keys(copy.virtualIndex);
    assert.equal(new Set(ids).size, ids.length, '副本里有**重复 id** ⇒ 一定有节点被顶掉');
    assert.equal(ids.length, srcCount, '副本节点数与源页不等 ⇒ 有节点丢了或重了');
    // 每个容器的孩子数必须一致（"容器变成一个单题"就是这条不成立的症状）
    const cs = (pg) => Object.values(pg.virtualIndex).filter((v) => v.type === 'C');
    const srcCs = cs(page).map((v) => v.children.length).sort((a, b) => a - b);
    const dstCs = cs(copy).map((v) => v.children.length).sort((a, b) => a - b);
    assert.deepEqual(dstCs, srcCs, '容器的孩子数对不上 ⇒ 结构被弄坏了');
    // 断链 / 父指针不符：一个都不许有
    let broken = 0;
    for (const v of Object.values(copy.virtualIndex)) {
        for (const cid of v.children) {
            const kid = copy.virtualIndex[cid];
            if (!kid || kid.parentId !== v.id) broken++;
        }
    }
    assert.equal(broken, 0, '副本里有断链 / 父指针不符的节点');
});
