// ================================================================
// 应用外壳的两条栏序（`src/test/shellBars.test.js`）
//
// 用户 2026-10-18："能不能把 Acm_Tree 标题和右边的若干按钮,这一整栏移到一级 tab 栏上方,
// 也就是在主界面恒可见"。
//
// 为什么这条要钉在**源码**上：`index.html` 不是模块、冒烟也不解析真外壳（各冒烟自己搭桩），
// 所以"顶部栏又滑回 `#tab-main` 里"不会有任何东西红 —— 而它正是这条需求的全部内容。
//
// 两条不变量：
//   ① 顶部栏（`.app-header`）必须在**一级 tab 栏之前**（`#tab-bar` 之前）⇒ 切到统计/判重/设置也会看见；
//   ② 副页栏的宿主 `#page-tabs-host` 必须在 `#tab-main` **里面**（副页栏只属于主视图）。
//      ⚠️ 第二条是这次改动真正的原因：`renderPageTabs()` 原来 `header.after(...)`，
//         副页栏挂在顶部栏后面 ⇒ 顶部栏一动，副页栏就会跑上去。
// ================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { repoRoot } from '../../scripts/roots.mjs';

const ROOT = repoRoot();
const HTML = fs.readFileSync(path.join(ROOT, 'app', 'index.html'), 'utf8');

/** 某段文本在文件里的位置（找不到 ⇒ -1，断言会当场红） */
const at = (needle) => HTML.indexOf(needle);

test('顶部栏在一级 tab 栏之前（切到别的页也看得见）', () => {
    const header = at('<header class="app-header">');
    const tabBar = at('<div class="tab-bar" id="tab-bar">');
    assert.notEqual(header, -1, 'index.html 里找不到顶部栏 `<header class="app-header">`');
    assert.notEqual(tabBar, -1, 'index.html 里找不到一级 tab 栏 `#tab-bar`');
    assert.ok(header < tabBar, '顶部栏必须在 `#tab-bar` **之前**（否则它又滑回主视图里了）');
});

test('顶部栏不在 `#tab-main` 里面（否则切页就消失）', () => {
    const main = at('id="tab-main"');
    const header = at('<header class="app-header">');
    assert.ok(main !== -1 && header !== -1, '找不到 `#tab-main` 或顶部栏');
    assert.ok(header < main, '顶部栏不在主视图里面 —— 它是全局的');
});

test('副页栏的宿主在 `#tab-main` 里面，而且不叫 app-header', () => {
    const main = at('id="tab-main"');
    const host = at('id="page-tabs-host"');
    assert.notEqual(host, -1, '缺 `#page-tabs-host` ⇒ `renderPageTabs()` 会直接 return，副页栏整个不出现');
    assert.ok(main < host, '副页栏宿主必须在 `#tab-main` 里面（副页栏只属于主视图）');
    // 宿主别再借用顶部栏那个类名：借了就等于"副页栏又挂在顶部栏上了"
    const hostTag = HTML.slice(HTML.lastIndexOf('<', host), HTML.indexOf('>', host) + 1);
    assert.ok(!/app-header/.test(hostTag), `副页栏宿主不该带 app-header 类，实际是：${hostTag}`);
});
