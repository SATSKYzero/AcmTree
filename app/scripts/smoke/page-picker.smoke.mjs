// ================================================================
// 冒烟测试：「选一个副页」共用件真的被**两个弹窗**用上了（scripts/smoke/page-picker.smoke.mjs）
//
// 用户 2026-10-14："收成一份共用件"。可执行的判据是**两件事**：
//   ① 两个弹窗里那两段 `<option>` 与共用件生成的一模一样（同一份选项文本 / 计数口径）；
//   ② 「＋ 新建副页」的显示隐藏与读回校验只有一份（选哨兵 ⇒ 输入框出现；空名 ⇒ 报错；选了页 ⇒ 给出 id）。
// 纯函数那半在 `src/test/pagePicker.test.js`；这里钉 DOM 那半（弹窗真的弹出来 + 控件真的接上）。
//
// ⚠️ 用 `installDom([], { parseHtml: true })`：弹窗内容是拼 `innerHTML` 的，
//    不开解析开关的话 `panel.querySelector('#pick-page')` 永远拿不到（断言会空转地绿）。
// ================================================================
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDom, makeContainer, serialize } from './dom.mjs';
import { group, ok, eq, report } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = path.join(ROOT, 'src');
const mod = (rel) => `file://${path.join(SRC, rel).replace(/\\/g, '/')}`;

const body = installDom([], { parseHtml: true });
const app = makeContainer(body, 'app');
for (const id of ['toast', 'tree-body', 'tree-container', 'tab-main']) makeContainer(app, id);
globalThis.fetch = async () => ({ ok: false, json: async () => ({}) });

const { AppState } = await import(mod('shell/state.js'));
const { createInitialState } = await import(mod('core/model/state.js'));
const { createNode } = await import(mod('core/model/node.js'));
const { createPage, createVNode } = await import(mod('core/model/page.js'));
const picker = await import(mod('ui/kit/pagePicker.js'));
const { promptCopyToPage } = await import(mod('ui/G_modal/G4_copy.js'));
const { promptTodoProblemSheet } = await import(mod('ui/G_modal/G5_todoSheet.js'));

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const nextLoop = async () => { await tick(); await tick(); };

/** 两页 + 一棵小树（P 挂在 C 下，`promptTodoProblemSheet` 要能挑出题） */
function seed() {
    const base = createInitialState();
    for (const k of Object.keys(base)) AppState[k] = base[k];
    const val = (v) => [{ v: String(v), src: 'manual', at: 'T', account: '' }];
    AppState.nodes = {
        root: { id: 'root', type: 'O', name: '根', values: {} },
        c1: { id: 'c1', type: 'C', name: '某场比赛', values: {} },
        p1: { id: 'p1', type: 'P', name: 'A题', problemId: 'A', status1: 0, status2: 0, values: { ratio: val('9') } }
    };
    AppState.childOrder = { root: ['c1'], c1: ['p1'], p1: [] };
    AppState.parentOf = { c1: 'root', p1: 'c1' };
    AppState.rootId = 'root';
    AppState.currentTab = 'main';
    AppState.currentPageId = 'main';
    const mk = (id, name, n) => {
        const page = createPage(id, name, id + '_vroot');
        page.virtualIndex[id + '_vroot'] = createVNode(id + '_vroot', null, 'O', null);
        for (let i = 0; i < n; i++) {
            const vid = id + '_v' + i;
            page.virtualIndex[vid] = createVNode(vid, 'p1', 'P', id + '_vroot');
            page.virtualIndex[id + '_vroot'].children.push(vid);
        }
        return page;
    };
    AppState.pages = {
        page_a: mk('page_a', '我的题单', 3),
        page_b: mk('page_b', '空页', 0)
    };
}

const topOverlay = () => { const o = body.querySelectorAll('.modal-overlay'); return o[o.length - 1] || null; };
const closeAll = () => {
    while (topOverlay()) {
        const btn = topOverlay().querySelectorAll('.btn').find((b) => b.textContent === '取消');
        if (btn) btn.click(); else break;
    }
};

// ================================================================
group('① 两个弹窗的副页下拉同源（列表 / 计数 / 哨兵都来自共用件）');
// ================================================================
// ⚠️ 桩的边界：开了 `parseHtml` 之后 `<select>` 的 `innerHTML` 会被清空（元素树取代它），
//    而解析出来的 `<option>` **不认文本**（只留 value）⇒ 这里比的是**值的序列**（列表与顺序），
//    "选项文本长什么样"由纯函数单测（`src/test/pagePicker.test.js` 的 `pageOptionLabelOf`）钉。
const optionValuesOf = (sel) => [...sel.children].map((o) => String(o.value));
{
    seed();
    const wantValues = picker.pageChoicesOf(AppState).map((c) => c.id);

    // —— 复制到副页（`G4_copy`）：不带「新建」项 ——
    promptCopyToPage('p1');
    await nextLoop();
    const sel1 = topOverlay() && topOverlay().querySelector('#copy-to-page-select');
    ok(!!sel1, '★ 复制到副页里那个下拉在（`#copy-to-page-select`）');
    eq(optionValuesOf(sel1).join(','), wantValues.join(','),
        '★★ 它的选项序列与共用件的 `pageChoicesOf` **完全一致**（同一份列表与顺序）');
    eq(!!topOverlay().querySelector(`#${picker.newPageInputIdOf('copy-to-page-select')}`), false,
        '★ 复制到副页**没有**「新建副页」那一项（`allowNew` 没开）');
    closeAll();

    // —— 挑题建页（`G5_todoSheet`）：带「新建」项 ——
    promptTodoProblemSheet('c1');
    await nextLoop();
    const sel2 = topOverlay() && topOverlay().querySelector('#pick-page');
    ok(!!sel2, '★ 挑题弹窗里那个下拉在（`#pick-page`）');
    eq(optionValuesOf(sel2).join(','), wantValues.concat([picker.NEW_PAGE_VALUE]).join(','),
        '★★ 它的选项序列 = 同一份列表 + 末尾那个「新建」哨兵');
    ok(!!topOverlay().querySelector(`#${picker.newPageInputIdOf('pick-page')}`),
        '★ 开了 `allowNew` ⇒ 新建名输入框也在');
}

// ================================================================
group('①b 源码锚：两处都**不再**自己拼 `<option>` / 自己算页列表（不许退回去）');
// ================================================================
{
    const fs = await import('node:fs');
    const readSrc = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');
    const copySrc = readSrc('ui/G_modal/G4_copy.js');
    const todoSrc = readSrc('ui/G_modal/G5_todoSheet.js');
    ok(/pageSelectHtml\(/.test(copySrc) && /readPagePicker\(/.test(copySrc),
        '★★ `G4_copy.js` 走共用件（`pageSelectHtml` + `readPagePicker`）');
    ok(/pageSelectHtml\(/.test(todoSrc) && /wirePagePicker\(/.test(todoSrc) && /readPagePicker\(/.test(todoSrc),
        '★★ `G5_todoSheet.js` 走共用件（`pageSelectHtml` + `wirePagePicker` + `readPagePicker`）');
    ok(!/<select[^>]*id="(copy-to-page-select|pick-page)"/.test(copySrc + todoSrc),
        '★★ 两处**都不许**自己拼那个 `<select>`（退回本地实现就会被这条抓住）');
    ok(!/function (getPagesList|pageList)\(/.test(copySrc + todoSrc),
        '★★ 两处**都不许**再各写一份页列表（`getPagesList` / `pageList`）');
}

// ================================================================
group('② 「＋ 新建副页」：显示/隐藏与读回校验都只有一份（`wirePagePicker` / `readPagePicker`）');
// ================================================================
{
    const panel = topOverlay();
    const selectId = 'pick-page';
    const inputId = picker.newPageInputIdOf(selectId);
    const sel = panel.querySelector(`#${selectId}`);
    const input = panel.querySelector(`#${inputId}`);
    ok(!!sel && !!input, '（前提）下拉与新建名输入框都在');

    // 初始"藏着"这件事**桩里看不见**（解析出来的 input 不带 style 属性；见 `dom.mjs` 的属性白名单）
    // ⇒ 那一条改由纯函数单测钉（`src/test/pagePicker.test.js`：`newPageNameInputHtml` 里写着 `display:none`）。
    // 这里钉"接线**幂等**"：弹窗打开时已经接过一次 ⇒ 再接一次返回 false（不叠监听）
    eq(picker.wirePagePicker(panel, { selectId }), false, '★ 重复接线是幂等的（第二次返回 false，不叠监听）');
    // 选哨兵 ⇒ 显示（走**真 change 事件**，与真人操作同一信号）
    sel.value = picker.NEW_PAGE_VALUE;
    sel.dispatchEvent({ type: 'change' });
    eq(String(input.style.display), 'block', '★ 选到「＋ 新建一个副页…」⇒ 输入框显示出来');
    // 选回某一页 ⇒ 又藏起来
    sel.value = 'page_a';
    sel.dispatchEvent({ type: 'change' });
    eq(String(input.style.display), 'none', '★ 选回具体某一页 ⇒ 又藏起来');

    // 读回与校验（唯一一份判据）
    sel.value = picker.NEW_PAGE_VALUE;
    input.value = '';
    let picked = picker.readPagePicker(panel, { selectId });
    eq(picked.isNew, true, '选了哨兵 ⇒ `isNew`');
    eq(picked.error, '新建副页要填个名字', '★ 空名 ⇒ 报错（"新建副页要填个名字"）');
    input.value = '  10月补题  ';
    picked = picker.readPagePicker(panel, { selectId });
    eq(picked.name, '10月补题', '★ 名字 trim 过');
    eq(picked.error, '', '填了名字 ⇒ 没有错');

    sel.value = 'page_b';
    picked = picker.readPagePicker(panel, { selectId });
    eq(picked.isNew, false, '选具体页 ⇒ 不是新建');
    eq(picked.pageId, 'page_b', '★ 给出 pageId');
    eq(picked.error, '', '没有错');

    closeAll();
    ok(!String(serialize(body)).includes('pick-page'), '（顺带）弹窗关掉了');
}

report();
