// ================================================================
// 「选一个副页」共用件（`ui/kit/pagePicker.js`）—— 纯函数部分
//
// 来由（用户 2026-10-14："收成一份共用件"）："选目标副页"这件事在仓里散成三份，
// 连"这一页几个节点"的计数口径都分叉了（两处 `len - 1`、一处 `max(0, len - 1)`）。
// 这里钉的是**只有一份**的那几个判据：计数口径 / 选项文本 / 哨兵 / 读回校验的**读取端**（DOM 那半在冒烟里）。
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    NEW_PAGE_VALUE, virtualNodeCountOf, pageChoicesOf, pageOptionLabelOf, pageOptionsHtml,
    newPageInputIdOf, pageSelectHtml
} from '../ui/kit/pagePicker.js';

const pageOf = (id, name, nodeCount, selected = false) => {
    const virtualIndex = { vroot: { id: 'vroot', refId: null, type: 'O', parentId: null, children: [] } };
    for (let i = 0; i < nodeCount; i++) virtualIndex['v' + i] = { id: 'v' + i, refId: 'n' + i, type: 'P', parentId: 'vroot', children: [] };
    return { id, name, rootId: 'vroot', virtualIndex, selected };
};

test('★ 计数口径只有一份：virtualIndex 去掉根那一个（空页 = 0，坏数据不许负数）', () => {
    assert.equal(virtualNodeCountOf(pageOf('p1', '空页', 0)), 0);
    assert.equal(virtualNodeCountOf(pageOf('p2', '三题', 3)), 3);
    assert.equal(virtualNodeCountOf({ virtualIndex: {} }), 0, '连根都没有 ⇒ 0（不许 -1）');
    assert.equal(virtualNodeCountOf(null), 0);
});

test('★ pageChoicesOf：键序照 `state.pages`，字段是 `{id,name,count,selected}`', () => {
    const state = { pages: { page_b: pageOf('page_b', 'B 页', 2, true), page_a: pageOf('page_a', 'A 页', 0) } };
    assert.deepEqual(pageChoicesOf(state).map((p) => p.id), ['page_b', 'page_a'], '顺序 = 对象键序（与页签栏一致）');
    assert.deepEqual(pageChoicesOf(state)[0], { id: 'page_b', name: 'B 页', count: 2, selected: true });
    assert.deepEqual(pageChoicesOf({}), []);
});

test('★ 选项文本只有一份：`名称（N 个节点）`（全角括号、数字前有空格）', () => {
    assert.equal(pageOptionLabelOf({ name: '我的题单', count: 12 }), '我的题单（12 个节点）');
    const html = pageOptionsHtml({ pages: { p1: pageOf('p1', '我的题单', 12) } });
    assert.equal(html, '<option value="p1">我的题单（12 个节点）</option>');
});

test('★ `allowNew` 才多「＋ 新建一个副页…」那一项，值是哨兵常量', () => {
    const state = { pages: { p1: pageOf('p1', '甲', 1) } };
    assert.equal(pageOptionsHtml(state).includes(NEW_PAGE_VALUE), false, '不带新建项时不许出现哨兵');
    const withNew = pageOptionsHtml(state, { allowNew: true });
    assert.ok(withNew.endsWith(`<option value="${NEW_PAGE_VALUE}">➕ 新建一个副页…</option>`), '新建项在最后');
    assert.equal(NEW_PAGE_VALUE, '__new__', '哨兵值改了要一起改老数据/测试（这里是"写死"的那份）');
});

test('★ `selectedId` 落在哪一项上（`selected` 属性）', () => {
    const state = { pages: { p1: pageOf('p1', '甲', 1), p2: pageOf('p2', '乙', 2) } };
    assert.ok(pageOptionsHtml(state, { selectedId: 'p2' }).includes('<option value="p2" selected>'), 'p2 被选中');
    assert.equal(pageOptionsHtml(state, { selectedId: 'p2' }).includes('value="p1" selected'), false);
});

test('★ 页名要转义（页名是用户输入，能带尖括号）', () => {
    const html = pageOptionsHtml({ pages: { p1: pageOf('p1', '<img src=x>', 1) } });
    assert.equal(html.includes('<img'), false, '不许把页名当标签插进去');
    assert.ok(html.includes('&lt;img'));
});

test('★ `pageSelectHtml`：一次给出标签 + 下拉 +（allowNew 时）新建名输入框；input 的 id 由 select 的 id 推', () => {
    const state = { pages: { p1: pageOf('p1', '甲', 1) } };
    const html = pageSelectHtml(state, { selectId: 'pick-page', label: '目标副页（题单）', allowNew: true });
    assert.ok(html.includes('id="pick-page"'), '下拉的 id 照调用点给的');
    assert.ok(html.includes(`id="${newPageInputIdOf('pick-page')}"`), '新建框的 id 由它推出来');
    assert.ok(html.includes('目标副页（题单）'), '标签在');
    // ★ 新建名输入框**默认必须是藏着的**（选到哨兵才由 `wirePagePicker` 显示出来）。
    //   ⚠️ 这一条**只能在这里钉**：冒烟用的 DOM 桩不保留解析出来的 `style` 属性
    //   （`dom.mjs` 的属性白名单里没有 style）⇒ 在冒烟里"初始是否隐藏"看不见。
    assert.ok(/display:\s*none/.test(html), '新建名输入框默认 `display:none`');
    const noNew = pageSelectHtml(state, { selectId: 'copy-to-page-select', label: '选择目标副页：' });
    assert.ok(noNew.includes('id="copy-to-page-select"'));
    assert.equal(noNew.includes(newPageInputIdOf('copy-to-page-select')), false, '不 allowNew ⇒ 不画那个输入框');
});
