// ================================================================
// 虚拟节点定位（core/ops/page.js 的 `locateVirtualNode` / `realNodeIdOf`）
//
// 为什么要单独钉：副页里那些"页内 id"（`v_cA`）**不是节点** —— 字段、子节点
// 全在它引用的真实节点上。UI 侧多处要判这件事（删除/移动用页内 id，
// 看信息/编辑/加子节点用真实 id），只要有一处忘了解析就会出怪事：
// 实测踩过 `📋 详细节点信息` 传页内 id ⇒ 开出一个标题是 `v_cA`、字段读不到的空界面。
// 所以解析**只留一处**（`realNodeIdOf`），这里把它钉住。
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { locateVirtualNode, realNodeIdOf, virtualAncestorsOf } from '../core/ops/page.js';

function makeState() {
    return {
        rootId: 'root',
        nodes: {
            root: { id: 'root', type: 'O' },
            cA: { id: 'cA', type: 'C', name: '2024 省赛' }
        },
        parentOf: { root: null, cA: 'root' },
        pages: {
            page_1: {
                id: 'page_1', name: '副页', rootId: 'v_root',
                virtualIndex: {
                    // 副页根节点**没有 refId**（它代表"这一页"，不是某个真实节点）
                    v_root: { id: 'v_root', refId: null, type: 'O', parentId: null, children: ['v_cA'] },
                    v_cA: { id: 'v_cA', refId: 'cA', type: 'C', parentId: 'v_root', children: [] }
                }
            },
            page_2: {
                id: 'page_2', name: '另一页', rootId: 'v2_root',
                virtualIndex: {
                    v2_root: { id: 'v2_root', refId: null, type: 'O', parentId: null, children: [] }
                }
            }
        }
    };
}

test('locateVirtualNode：跨副页找得到，并给出它属于哪一页', () => {
    const s = makeState();
    const hit = locateVirtualNode(s, 'v_cA');
    assert.equal(hit.pageId, 'page_1');
    assert.equal(hit.vNode.refId, 'cA');
    assert.equal(locateVirtualNode(s, 'v_root').pageId, 'page_1');
    assert.equal(locateVirtualNode(s, 'v2_root').pageId, 'page_2');
});

test('locateVirtualNode：真实节点 / 不存在的 id → null', () => {
    const s = makeState();
    assert.equal(locateVirtualNode(s, 'cA'), null);
    assert.equal(locateVirtualNode(s, '不存在'), null);
    assert.equal(locateVirtualNode({ nodes: {} }, 'cA'), null);
    assert.equal(locateVirtualNode(null, 'cA'), null);
});

test('realNodeIdOf：页内 id → 真实节点 id；其余原样返回', () => {
    const s = makeState();
    assert.equal(realNodeIdOf(s, 'v_cA'), 'cA', '副页里的节点 → 指向的真实节点');
    assert.equal(realNodeIdOf(s, 'cA'), 'cA', '本来就不虚拟 → 原样');
    assert.equal(realNodeIdOf(s, '不存在'), '不存在', '认不出也原样（不编一个 id 出来）');
});

test('realNodeIdOf：副页根节点没有 refId → 原样返回（不误指向别处）', () => {
    const s = makeState();
    assert.equal(realNodeIdOf(s, 'v_root'), 'v_root');
});

// ================================================================
// 页内祖先链（`virtualAncestorsOf`）—— **副页面包屑的真源**
//
// 为什么不复用 `core/query/nodes.js:getAncestorsRootFirst`：那一份走**主树**的 `state.parentOf`，
// 而页内 id 在那张表里根本不存在 ⇒ 拿页内 id 去问只会得到「（就在根下）」这种**假话**
// （`nodeGroup.breadcrumbHtml` 就是因此被挡住不给副页用的，见 `docs/node-navigation.md` §2.5）。
// 这一份与 `locateVirtualNode` 同住、同一份数据；`ui/revealNode.js` 的页内展开也走它。
// ================================================================
test('★ virtualAncestorsOf：页内祖先链由根到父（不含自己），走的是页内 parentId', () => {
    const s = makeState();
    // v_root > v_a > v_cA（把 v_cA 挂到更深一层）
    s.pages.page_1.virtualIndex.v_a =
        { id: 'v_a', refId: 'cA', type: 'C', parentId: 'v_root', children: ['v_cA'] };
    s.pages.page_1.virtualIndex.v_cA.parentId = 'v_a';
    s.pages.page_1.virtualIndex.v_root.children = ['v_a'];

    assert.deepEqual(virtualAncestorsOf(s, 'v_cA').map(v => v.id), ['v_root', 'v_a'],
        '根在前、**不含自己**（与 `getAncestorsRootFirst` 同一套顺序约定）');
    assert.deepEqual(virtualAncestorsOf(s, 'v_a').map(v => v.id), ['v_root'], '父是根时只有一段');
    assert.deepEqual(virtualAncestorsOf(s, 'v_root').map(v => v.id), [], '页内根没有祖先');
});

test('virtualAncestorsOf：主树 id / 不存在的 id / 没有 state ⇒ 空数组（不编一条链）', () => {
    const s = makeState();
    assert.deepEqual(virtualAncestorsOf(s, 'cA'), [], '真实节点在页内表里查不到 ⇒ 空');
    assert.deepEqual(virtualAncestorsOf(s, '不存在'), [], '认不出 ⇒ 空');
    assert.deepEqual(virtualAncestorsOf(null, 'v_cA'), [], '没有 state 也不炸');
});

test('virtualAncestorsOf：断链 / 成环有兜底（不许挂死在页内表上）', () => {
    const s = makeState();
    s.pages.page_1.virtualIndex.v_cA.parentId = '没了';       // 断链
    assert.deepEqual(virtualAncestorsOf(s, 'v_cA'), [], '指向不存在的父 ⇒ 停在那儿（空数组）');

    const cyc = makeState();
    cyc.pages.page_1.virtualIndex.v_cA.parentId = 'v_root';
    cyc.pages.page_1.virtualIndex.v_root.parentId = 'v_cA';  // 成环
    const chain = virtualAncestorsOf(cyc, 'v_cA');
    assert.ok(chain.length >= 1, '成环时靠深度上限收敛（这里能返回就说明没挂死）');
});
