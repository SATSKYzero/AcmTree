// ================================================================
// 副页「与主树对齐 + 屏蔽」（`core/ops/page.js:syncPageWithTree` / `setVNodeBlocked`）
//
// 来源：用户 2026-10-15「新爬的比赛/题目/提交进不了副页」+ 补充「副页节点增加可编辑的
// 『屏蔽』字段；与主树对齐时，走到屏蔽的节点就不会递归」。口径写在 `docs/subpage-sync.md`。
//
// 这里钉的是**会红的口径**（不是复述现状）：
//   ① **只加不删**：已有的 vNode 一个都不许消失/换 id；
//   ② **同级顺序跟主树**（用户 2026-10-16："与主树一致"要纳入子节点顺序）：这一层的孩子按主树
//      `childOrder` 排；主树里已经没有的**垫到末尾**（只加不删 ⇒ 不删它们）；**页根那层不排**
//      （没有真实节点 ⇒ 没有"主树顺序"可对）；
//   ③ **已有的中间节点也要往下走**（"已有的 P 下面新爬的 R"必须补得进来）；
//   ④ **幂等**：再对齐一次 `added === 0`、`reordered === 0`；
//   ⑤ **屏蔽**：那一支不再补（同层别的支照补），且**已有的内容不增不减**；
//   ⑥ 页根下**没有的支不会被带回来**（"我只保留 22~26 年"靠这一条成立）；
//   ⑦ 老数据缺 `syncBlocked` ⇒ 读作 `false`；`duplicatePage` 要把它一起搬；
//   ⑧ 只读守卫在（"只看别人"时不许对齐/屏蔽）。
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { duplicatePage, setPageHideBlocked, setVNodeBlocked, syncPageWithTree } from '../core/ops/page.js';
import { childVNodesOf, createPage, createVNode } from '../core/model/page.js';
import { createInitialState } from '../core/model/state.js';

/**
 * 主树：
 *   root ─┬─ c1 ─┬─ p1 ── r1
 *         │      └─ p2 ── r2
 *         └─ c2 ─── p3            （c2 那一支**故意不进副页** ⇒ 验"不会被带回来"）
 * 副页：root(O) → v_c1(refId c1)，v_c1 下有没有 p1 由各用例自己定。
 */
function makeDraft() {
    const d = createInitialState();
    d.rootId = 'root';
    d.nodes = {
        root: { id: 'root', type: 'O', name: '根', values: {} },
        c1: { id: 'c1', type: 'C', name: '2026 郑州', values: {} },
        c2: { id: 'c2', type: 'C', name: '2021 某场', values: {} },
        p1: { id: 'p1', type: 'P', name: 'A题', values: {} },
        p2: { id: 'p2', type: 'P', name: 'B题', values: {} },
        p3: { id: 'p3', type: 'P', name: 'C题', values: {} },
        r1: { id: 'r1', type: 'R', name: '我的提交', values: {} },
        r2: { id: 'r2', type: 'R', name: '我的提交', values: {} }
    };
    d.childOrder = {
        root: ['c1', 'c2'],
        c1: ['p1', 'p2'],
        c2: ['p3'],
        p1: ['r1'],
        p2: ['r2'],
        p3: [],
        r1: [],
        r2: []
    };
    d.parentOf = { c1: 'root', c2: 'root', p1: 'c1', p2: 'c1', p3: 'c2', r1: 'p1', r2: 'p2' };

    const page = createPage('page_1', '我的范围', 'vroot');
    page.virtualIndex.vroot = createVNode('vroot', null, 'O', null);
    const vc = createVNode('v_c1', 'c1', 'C', 'vroot');
    page.virtualIndex.v_c1 = vc;
    page.virtualIndex.vroot.children = ['v_c1'];
    d.pages = { page_1: page };
    d.currentPageId = 'page_1';
    return d;
}

/** 页里所有 vNode 的 `refId`（根那个 `null` 不算） */
const refsOf = (page) => Object.values(page.virtualIndex)
    .map((v) => v.refId).filter(Boolean).sort();

/** 某个 vNode 下挂着的孩子 refId（按顺序） */
const childRefs = (page, vId) => (page.virtualIndex[vId].children || [])
    .map((id) => (page.virtualIndex[id] || {}).refId);

test('★ 对齐：只加不删、已有的 id 一个都不换', () => {
    const d = makeDraft();
    const page = d.pages.page_1;
    const vp1 = createVNode('v_p1', 'p1', 'P', 'v_c1');
    page.virtualIndex.v_p1 = vp1;
    page.virtualIndex.v_c1.children = ['v_p1'];
    const beforeIds = Object.keys(page.virtualIndex).sort();

    const got = syncPageWithTree(d, 'page_1');
    assert.ok(got.added > 0, '补进来了东西', `added=${got.added}`);
    for (const id of beforeIds) {
        assert.ok(page.virtualIndex[id], `已有的 vNode ${id} 被删了 —— 对齐**只加不删**`);
    }
    assert.equal(page.virtualIndex.v_p1.id, 'v_p1', '已有的 vNode 不许换 id');
    assert.deepEqual(childRefs(page, 'v_c1').slice(0, 1), ['p1'], '已有的孩子**还在原位**');
});

test('★ 对齐：已有的中间节点**也要往下走**（新爬的 R 补进已有的 P 下面）', () => {
    const d = makeDraft();
    const page = d.pages.page_1;
    const vp1 = createVNode('v_p1', 'p1', 'P', 'v_c1');     // 页里已经有 p1，但**没有**它的 r1
    page.virtualIndex.v_p1 = vp1;
    page.virtualIndex.v_c1.children = ['v_p1'];

    syncPageWithTree(d, 'page_1');
    assert.deepEqual(childRefs(page, 'v_p1'), ['r1'],
        '★ r1 必须挂在**已有的那个** v_p1 下（不是新造一个 p1）');
    assert.equal(page.virtualIndex.v_p1.parentId, 'v_c1', 'p1 还在原来那个父下面');
});

test('★ 对齐：同级顺序**跟主树**（用户 2026-10-16："与主树一致"纳入子节点顺序）', () => {
    const d = makeDraft();
    const page = d.pages.page_1;
    // 用户手工把 p2 放前面、p1 放后面 —— 主树里是 p1,p2（`childOrder.c1`）
    const vp2 = createVNode('v_p2', 'p2', 'P', 'v_c1');
    const vp1 = createVNode('v_p1', 'p1', 'P', 'v_c1');
    page.virtualIndex.v_p2 = vp2;
    page.virtualIndex.v_p1 = vp1;
    page.virtualIndex.v_c1.children = ['v_p2', 'v_p1'];

    const got = syncPageWithTree(d, 'page_1');
    assert.deepEqual(childRefs(page, 'v_c1'), ['p1', 'p2'], '★ 这一层拨成主树的顺序');
    assert.equal(got.reordered, 1, '报出"拨正了几层"（方便界面说清楚做了什么）');
    assert.deepEqual(childRefs(page, 'v_p1'), ['r1'], '新补的挂在对应的父下');
    // ⚠️ 只拨顺序：两个 vNode **本身**不换 id、不重建（"只加不删"照旧）
    assert.equal(page.virtualIndex.v_p1.parentId, 'v_c1');
    assert.equal(page.virtualIndex.v_p2.parentId, 'v_c1');

    const again = syncPageWithTree(d, 'page_1');
    assert.equal(again.reordered, 0, '★ 再对齐一次就不动了（顺序这件事也幂等）');
});

test('★ 对齐：主树里**已经没有**的 vNode **垫到末尾**（不删、相对顺序不变）', () => {
    const d = makeDraft();
    const page = d.pages.page_1;
    // 页里有一个主树已经不认识的 p9（后来在主树里被删了/搬走了）—— 对齐**不删**它
    page.virtualIndex.v_p9 = createVNode('v_p9', 'p9', 'P', 'v_c1');
    page.virtualIndex.v_p1 = createVNode('v_p1', 'p1', 'P', 'v_c1');
    page.virtualIndex.v_p2 = createVNode('v_p2', 'p2', 'P', 'v_c1');
    page.virtualIndex.v_c1.children = ['v_p9', 'v_p2', 'v_p1'];

    const got = syncPageWithTree(d, 'page_1');
    assert.deepEqual(childRefs(page, 'v_c1'), ['p1', 'p2', 'p9'],
        '★ 有共同主树父就排：主树里还有的按主树顺序在前，主树没有的**垫到末尾**（相对顺序不变）');
    assert.equal(got.reordered, 1, '报出拨正了几层');
    assert.ok(page.virtualIndex.v_p9, '那个 vNode 还在（只加不删）');
});

test('★ 对齐：页根那层——孩子都在**同一个主树父**下 ⇒ 也按主树排', () => {
    const d = makeDraft();
    const page = d.pages.page_1;
    // 页根下挂 c2、c1（主树 root 下是 c1,c2；`parentOf` 都是 root ⇒ 同一个父）
    page.virtualIndex.v_c2 = createVNode('v_c2', 'c2', 'C', 'vroot');
    page.virtualIndex.vroot.children = ['v_c2', 'v_c1'];
    page.virtualIndex.v_c1.children = ['v_p1'];
    page.virtualIndex.v_p1 = createVNode('v_p1', 'p1', 'P', 'v_c1');

    const got = syncPageWithTree(d, 'page_1');
    assert.deepEqual(childRefs(page, 'vroot'), ['c1', 'c2'],
        '★ 同一主树父 ⇒ 页根那层也按主树顺序');
    assert.equal(got.reordered, 1, '报出拨正了几层');
});

test('★ 对齐：页根那层——混了**不同主树父** ⇒ 那层不排', () => {
    const d = makeDraft();
    const page = d.pages.page_1;
    // 把 c2 搬到主树的 p1 底下 ⇒ 页根那两个孩子**不同父** ⇒ 没有"主树顺序"可对
    d.parentOf.c2 = 'p1';
    d.childOrder.p1 = ['r1', 'c2'];
    page.virtualIndex.v_c2 = createVNode('v_c2', 'c2', 'C', 'vroot');
    page.virtualIndex.vroot.children = ['v_c2', 'v_c1'];
    page.virtualIndex.v_c1.children = ['v_p1'];
    page.virtualIndex.v_p1 = createVNode('v_p1', 'p1', 'P', 'v_c1');

    const got = syncPageWithTree(d, 'page_1');
    assert.deepEqual(childRefs(page, 'vroot'), ['c2', 'c1'],
        '★ 没有共同的主树父 ⇒ 页根那层一个字不动');
    assert.equal(got.reordered, 0, '（一层都没被拨）');
});

test('★ 对齐：幂等（再对齐一次 added === 0）', () => {
    const d = makeDraft();
    const page = d.pages.page_1;
    page.virtualIndex.v_c1.children = ['v_p1'];
    page.virtualIndex.v_p1 = createVNode('v_p1', 'p1', 'P', 'v_c1');

    const first = syncPageWithTree(d, 'page_1');
    assert.ok(first.added > 0, '第一次补了东西');
    const n = Object.keys(page.virtualIndex).length;
    const second = syncPageWithTree(d, 'page_1');
    assert.equal(second.added, 0, '★ 第二次一个都不补（幂等）');
    assert.equal(second.reordered, 0, '★ 第二次也不再拨顺序（顺序这件事也幂等）');
    assert.equal(second.blocked, 0, '没有屏蔽');
    assert.equal(Object.keys(page.virtualIndex).length, n, '节点数也不再变');
});

test('★ 屏蔽：那一支不再往下补（同层别的支照补），且**已有的不增不减**', () => {
    const d = makeDraft();
    const page = d.pages.page_1;
    const vp1 = createVNode('v_p1', 'p1', 'P', 'v_c1');
    vp1.syncBlocked = true;                                  // 屏蔽 p1 这一支
    const vOld = createVNode('v_r0', 'r2', 'R', 'v_p1');      // 已经被屏蔽的那一支里**已有的**东西
    page.virtualIndex.v_p1 = vp1;
    page.virtualIndex.v_r0 = vOld;
    vp1.children = ['v_r0'];
    page.virtualIndex.v_c1.children = ['v_p1'];

    const got = syncPageWithTree(d, 'page_1');
    assert.equal(got.blocked, 1, '★ 报出"撞到 1 处屏蔽"');
    assert.deepEqual(childRefs(page, 'v_p1'), ['r2'],
        '★ 屏蔽的支：不再补 r1，但**已有的 r2 原样留着**（不增不减）');
    assert.deepEqual(childRefs(page, 'v_c1'), ['p1', 'p2'], '同层别的支（p2）照补');
    assert.equal(vp1.syncBlocked, true, '屏蔽标记还在');
});

test('★ 屏蔽：写在**新补进来**的支上，下一次对齐就停在它（两级生效）', () => {
    const d = makeDraft();
    const page = d.pages.page_1;
    page.virtualIndex.v_c1.children = [];
    syncPageWithTree(d, 'page_1');                            // 先补出 c1 底下整棵
    const vp1 = Object.values(page.virtualIndex).find((v) => v.refId === 'p1');
    assert.ok(vp1, '这次补进来了 p1');
    setVNodeBlocked(d, 'page_1', vp1.id, true);               // 用户点那颗 🚫

    // 主树那边又多了一道新题（r9 挂在 p1 下）⇒ 对齐时不该进这一支
    d.nodes.r9 = { id: 'r9', type: 'R', name: '新提交', values: {} };
    d.childOrder.r9 = [];
    d.childOrder.p1 = ['r1', 'r9'];
    const got = syncPageWithTree(d, 'page_1');
    assert.equal(got.blocked, 1, '撞到那处屏蔽');
    assert.deepEqual(childRefs(page, vp1.id).includes('r9'), false, '★ 屏蔽的支不再长新节点');
});

test('★ 页根下**没有的支不会被带回来**（"只保留 22~26"靠这一条）', () => {
    const d = makeDraft();
    const page = d.pages.page_1;
    page.virtualIndex.v_c1.children = [];
    const got = syncPageWithTree(d, 'page_1');
    assert.ok(got.added > 0, 'c1 那一支补齐了');
    assert.deepEqual(refsOf(page).filter((r) => r === 'c2' || r === 'p3'), [],
        '★ 页根下没有 c2 ⇒ 对齐**绝不**把 c2/p3 带回来');
});

test('老数据缺 `syncBlocked` ⇒ 读作"没屏蔽"（行为与今天一致）', () => {
    const d = makeDraft();
    const page = d.pages.page_1;
    const vp1 = createVNode('v_p1', 'p1', 'P', 'v_c1');
    delete vp1.syncBlocked;                                   // 模拟老存档
    page.virtualIndex.v_p1 = vp1;
    page.virtualIndex.v_c1.children = ['v_p1'];

    const got = syncPageWithTree(d, 'page_1');
    assert.equal(got.blocked, 0, '缺字段 ⇒ 不算屏蔽');
    assert.deepEqual(childRefs(page, 'v_p1'), ['r1'], '照常往下补');
});

test('`setVNodeBlocked`：翻转 / 根不给屏蔽 / 不存在的节点要抛', () => {
    const d = makeDraft();
    const page = d.pages.page_1;
    const vp1 = createVNode('v_p1', 'p1', 'P', 'v_c1');
    page.virtualIndex.v_p1 = vp1;
    page.virtualIndex.v_c1.children = ['v_p1'];

    setVNodeBlocked(d, 'page_1', 'v_p1', true);
    assert.equal(vp1.syncBlocked, true, '开了');
    setVNodeBlocked(d, 'page_1', 'v_p1', false);
    assert.equal(vp1.syncBlocked, false, '关了');
    assert.throws(() => setVNodeBlocked(d, 'page_1', 'vroot', true), /根不能屏蔽/);
    assert.throws(() => setVNodeBlocked(d, 'page_1', 'v_不存在', true), /不存在/);
});

test('`duplicatePage` 把 `syncBlocked` 一起搬', () => {
    const d = makeDraft();
    const page = d.pages.page_1;
    const vp1 = createVNode('v_p1', 'p1', 'P', 'v_c1');
    vp1.syncBlocked = true;
    page.virtualIndex.v_p1 = vp1;
    page.virtualIndex.v_c1.children = ['v_p1'];

    const { page: copy } = duplicatePage(d, 'page_1');
    const copied = Object.values(copy.virtualIndex).find((v) => v.refId === 'p1');
    assert.equal(copied.syncBlocked, true, '★ 复制出来的页也记得"这一支不跟主树"');
    assert.equal(copy.virtualIndex[copy.rootId].syncBlocked, false, '根那份是缺省');
});

test('只读守卫："只看别人"时对齐与屏蔽都要抛', () => {
    const d = makeDraft();
    d.viewingAccountId = 'acc_other';                         // 只读判据：`currentAccountId !== viewingAccountId`
    assert.throws(() => syncPageWithTree(d, 'page_1'), /只读模式下不能手改/);
    assert.throws(() => setVNodeBlocked(d, 'page_1', 'v_c1', true), /只读模式下不能手改/);
    assert.throws(() => setPageHideBlocked(d, 'page_1', true), /只读模式下不能手改/);
});

// ================================================================
// 用户 2026-10-15 的三条反馈：① 清单默认折叠（UI，冒烟钉）
// ② 屏蔽的支**不参与任何统计** ③ 页级字段「不显示屏蔽的部分」⇒ 屏蔽的支**不渲染**
// ================================================================

test('★「不显示屏蔽的部分」：缺省 false、能开能关、复制副页也搬', () => {
    const d = makeDraft();
    assert.equal(d.pages.page_1.hideBlocked, false, '新建的副页缺省 false（老数据行为不变）');
    delete d.pages.page_1.hideBlocked;                        // 模拟老存档：没这个字段
    assert.equal(d.pages.page_1.hideBlocked, undefined, '（前提）老数据确实没有这一格');
    setPageHideBlocked(d, 'page_1', true);
    assert.equal(d.pages.page_1.hideBlocked, true, '能开');
    setPageHideBlocked(d, 'page_1', false);
    assert.equal(d.pages.page_1.hideBlocked, false, '能关');
    d.pages.page_1.hideBlocked = true;
    const { page: copy } = duplicatePage(d, 'page_1');
    assert.equal(copy.hideBlocked, true, '★ 复制副页时一起搬（复制出来的那一页照原样看）');
});

test('★ `childVNodesOf`：统计**永远**跳过屏蔽的支；渲染**只看那个页级字段**', () => {
    const d = makeDraft();
    const page = d.pages.page_1;
    const vp1 = createVNode('v_p1', 'p1', 'P', 'v_c1');
    page.virtualIndex.v_p1 = vp1;
    page.virtualIndex.v_c1.children = ['v_p1'];

    assert.deepEqual(childVNodesOf(page, page.virtualIndex.v_c1, 'stats').map((v) => v.id), ['v_p1'],
        '（前提）没屏蔽时照走');
    assert.deepEqual(childVNodesOf(page, page.virtualIndex.v_c1, 'render').map((v) => v.id), ['v_p1'],
        '渲染也一样');

    vp1.syncBlocked = true;
    assert.deepEqual(childVNodesOf(page, page.virtualIndex.v_c1, 'stats'), [],
        '★ 统计：**无条件**跳过整支');
    assert.deepEqual(childVNodesOf(page, page.virtualIndex.v_c1, 'render').map((v) => v.id), ['v_p1'],
        '★ 渲染：没勾"不显示"时**照画**（不然用户就找不到那颗 🚫 了）');
    page.hideBlocked = true;
    assert.deepEqual(childVNodesOf(page, page.virtualIndex.v_c1, 'render'), [],
        '★ 勾了"不显示屏蔽的部分" ⇒ 那支不画');
});

test('★「不显示屏蔽的部分」**不影响对齐**（它只管渲染）', () => {
    const d = makeDraft();
    const page = d.pages.page_1;
    page.virtualIndex.v_c1.children = [];
    page.hideBlocked = true;                                   // 渲染开关开着
    const got = syncPageWithTree(d, 'page_1');
    assert.ok(got.added > 0, '★ 对齐照补（这个字段与"要不要跟主树"无关）', `added=${got.added}`);
    assert.ok(refsOf(page).includes('p1'), '补进来的东西真在数据里（只是可能不画）');
});
