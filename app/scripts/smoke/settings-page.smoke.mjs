// ================================================================
// 冒烟测试：设置页（一级 Tab）（scripts/smoke/settings-page.smoke.mjs）
//
// 设置框太小 ⇒ **设置独占一个一级 tab 栏**。
//
// 设置是一级 Tab（`index.html` 的 `data-tab="settings"`
// + `#tab-settings`，内容由 `ui/settings/settingsPage.js` 在切过去时画）。
// 这里走**真实路径**钉住几件只在"接线 + 多栏一页"下才成立的事：
//   ① 分页栏里有这一页，切过去有内容（**冷启动停在它上面**也要画 —— 与判重整理同一个坑）；
//   ② 五栏都在，切栏**不丢草稿**（在「显示」改了值 → 去「性能」→ 回来还是新值）；
//   ③ **跨栏保存**：改「显示」栏、停在「性能」栏按保存，改的那格也要落库
//      （保存**不能**从 DOM 读值 —— 那栏压根不在 DOM 里，实测会读成空串 ⇒ 一律报错）；
//   ④ 「🔑 名册/凭据」那栏做成 me.json 编辑器，**没进那一栏不联网**，
//      且**切走再回来草稿还在**（编辑器实例跨重画复用）；
//   ⑤ ⚙️ 工具栏按钮 = 切到这一页。
// fetch 是桩，不碰网络；数据走内存 IndexedDB 桩。
// ================================================================
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDom, makeContainer, serialize } from './dom.mjs';
import { group, ok, eq, deepEq, report } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = path.join(ROOT, 'src');
const mod = (rel) => `file://${path.join(SRC, rel).replace(/\\/g, '/')}`;
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

// ① 先装 DOM 桩（含 `#tab-bar` / `#tab-settings`，镜像 index.html 的静态结构）
const body = installDom([], { parseHtml: true });
const app = makeContainer(body, 'app');
const tabBar = makeContainer(app, 'tab-bar');
makeContainer(app, 'nodeinfo-tab-bar');
const settingsPane = document.createElement('div');
settingsPane.id = 'tab-settings';
settingsPane.className = 'tab-content';
app.appendChild(settingsPane);
const dedupPane = document.createElement('div');
dedupPane.id = 'tab-dedup';
dedupPane.className = 'tab-content';
app.appendChild(dedupPane);
makeContainer(app, 'toast');

// me.json 的接口桩（只记调用，不联网）
const meCalls = [];
// 结构：映射与花名册合并成一个东西 —— 账户＝一人一项，
// 项上带着平台账号 + 历年队名 + 推不出来的映射原文；凭据仍按平台放顶层。
const DOC = {
    accounts: [
        {
            name: '我', nature: '本人',
            cf: 'me_cf', qoj: 'me_qoj', nk: '2026届队名', hdu: 'demo/teamA',
            byYear: { nk: { 2023: '23届队名', 2024: '24届队名', 2025: '25届队名' } },
            mappings: [{ source: 'pta:12345', field: '队伍', value: 'demo' }]
        },
        { name: '队友', cf: 'mate_cf' }
    ],
    current: '我',
    _note: ['这是说明（me.json 的 _note），导出时不许动它'],
    cf: { apiKey: 'REAL-CF-KEY' },
    qoj: { cookie: 'session=REAL-COOKIE' }
};
// 桩里那份"磁盘上的 me.json"：PUT 之后要**记住**，否则"再读一次"又回到初始内容，
// "补过了就不再补"这类断言会假失败（真服务器当然是有状态的）。
let diskDoc = DOC;
globalThis.fetch = async (url, opts = {}) => {
    const call = { url: String(url), method: String(opts.method || 'GET') };
    meCalls.push(call);
    const body2 = (json, status = 200) => ({ ok: status < 400, status, json: async () => json });
    if (String(url).includes('api/ping')) return body2({ ok: true, api: 2, root: ROOT, steps: [] });
    if (String(url).includes('api/me')) {
        if (String(opts.method || 'GET') === 'PUT') {
            const sent = JSON.parse(opts.body);
            call.sent = sent;                       // 测试要检查"写进去的是什么"
            diskDoc = JSON.parse(sent.text);
            return body2({ ok: true, path: 'acm-data/raw/Scaper/me.json', sha256: 'c'.repeat(64),
                mtime: 1700000000, doc: diskDoc });
        }
        return body2({ ok: true, path: 'acm-data/raw/Scaper/me.json', sha256: 'a'.repeat(64),
            mtime: 1700000000, doc: diskDoc });
    }
    return body2({ ok: false, error: '不该打这个接口' }, 404);
};

// ② 内置页签按钮（镜像 index.html：主视图 / 数据统计 / 判重整理 / 设置）
for (const [id, label, order] of [['main', '🏠 主视图', ''], ['stats', '📊 数据统计', ''],
    ['dedup', '🧩 判重整理', '1500'], ['settings', '⚙️ 设置', '1600']]) {
    const btn = document.createElement('button');
    btn.className = 'tab-btn';
    btn.dataset.tab = id;
    if (order) btn.dataset.order = order;
    btn.innerHTML = label;
    tabBar.appendChild(btn);
}
for (const id of ['main', 'stats']) {
    const pane = document.createElement('div');
    pane.id = `tab-${id}`;
    pane.className = 'tab-content';
    app.appendChild(pane);
}

const { AppState } = await import(mod('shell/state.js'));
const { createInitialState } = await import(mod('core/model/state.js'));
const { renderSettingsPage, __resetSettingsPageState, isSettingsDirty } = await import(mod('ui/settings/settingsPage.js'));
const { setupTabs, switchTab, getCurrentTab } = await import(mod('ui/tabs.js'));
const { bindUIButtons } = await import(mod('ui/buttons.js'));

function seed() {
    const base = createInitialState();
    for (const k of Object.keys(base)) AppState[k] = base[k];
    AppState.settings.display.boxCount = 15;
    AppState.settings.display.boxDisplayMode = 'cf';
    AppState.settings.autoSave.autoSaveInterval = 10;
    AppState.settings.mode.treeDisplayMode = 'tree';
    __resetSettingsPageState();
    meCalls.length = 0;
    diskDoc = DOC;                       // ⚠️ 每组建都从"盘上那份"重新开始（上一组可能 PUT 过）
}

const pane = () => document.getElementById('tab-settings');
/** ⚠️ 文本要 `serialize()`（DOM 桩开了解析后，文本在子文本节点里，`textContent` 是空的） */
const text = () => serialize(pane());
const sectionBtn = (id) => pane().querySelector(`[data-section="${id}"]`);
/** 「🔑 账户/名册」那一栏里的二级页（账户 / 名册，一次只画一块） */
const meSubBtn = (id) => pane().querySelector(`.me-subtab[data-sub="${id}"]`);
const field = (key) => pane().querySelector(`[data-setting="${key}"]`);

// ================================================================
group('① 一级 Tab：分页栏里有「⚙️ 设置」，切过去就有内容');
seed();
document.getElementById('settings-icon');
setupTabs();
const tabBtn = tabBar.querySelectorAll('.tab-btn').find((b) => b.dataset.tab === 'settings');
ok(!!tabBtn, '分页栏里有「⚙️ 设置」按钮');
ok(tabBar.querySelectorAll('.tab-btn').map((b) => b.dataset.tab).join(',')
    .endsWith('settings'), '它排在内置页最后（order 1600）');

switchTab('settings');
await tick();
eq(getCurrentTab(), 'settings', '切到了设置页');
ok(/⚙️ 设置/.test(text()), '页面画出来了');
ok(pane().querySelector('[data-section="me"]') !== null, '有「🔑 名册/凭据」这一栏');
ok(!!field('boxCount'), '默认停在「显示」栏，控件在');
ok(!/undefined|NaN/.test(text()), '⚠️ 页面上没有 undefined / NaN 漏出来');
ok(!meCalls.some((c) => c.url.includes('api/me')), '⚠️ me.json 的接口现在**一个字都没打**（没进那一栏）');

// ================================================================
group('② 冷启动就停在设置页：也要画（与判重整理同一个坑）');
seed();
document.getElementById('tab-settings').innerHTML = '';
// 模拟"上一次就停在设置页"（currentTab 是持久化的）——`setupTabs` 必须把它画出来
AppState.currentTab = 'settings';
setupTabs();
ok(/⚙️ 设置/.test(text()), '持久化就是设置页时，setupTabs 把它画出来');

// ================================================================
group('③ 切栏不丢草稿 + 跨栏保存（不能从 DOM 读值）');
seed();
renderSettingsPage();
const boxInput = field('boxCount');
boxInput.value = '33';
boxInput.dispatchEvent({ type: 'input' });
const intervalInput = field('autoSaveInterval');
ok(!intervalInput, '「显示」栏里没有「保存」栏的控件（各栏各管各的）');
eq(isSettingsDirty(), true, '敲了字 ⇒ 这一页标记为"有未保存改动"（tabs.js 据此不重画冲掉它）');

sectionBtn('performance').click();
await tick();
ok(!!field('l1'), '切到「性能」栏');
sectionBtn('display').click();
await tick();
eq(field('boxCount').value, '33', '切回来还是刚敲的值（草稿没丢）');

// 现在停在「显示」栏，但把「保存」栏的值也改一下，再去别的栏按保存
const autoInput = (() => {
    sectionBtn('save').click();
    const inp = field('autoSaveInterval');
    inp.value = '25';
    inp.dispatchEvent({ type: 'input' });
    return inp;
})();
ok(!!autoInput, '「保存」栏里能改自动保存间隔');
sectionBtn('performance').click();
await tick();
pane().querySelector('#settings-save-btn').click();
await tick(60);
eq(AppState.settings.display.boxCount, 33, '⚠️ 跨栏保存：在「性能」栏按保存，「显示」栏改的 boxCount 也落库了');
eq(AppState.settings.autoSave.autoSaveInterval, 25, '「保存」栏自己那格也落库了');
eq(isSettingsDirty(), false, '保存之后不再是"未保存"状态');

// ================================================================
group('④ 逐字段"取哪一份"：控件画出来了 + 保存真的落库（收法甲）');
seed();
renderSettingsPage();
ok(!!field('col_status1'), '「显示」栏里有逐字段取法的下拉（字段名单从 `ELEMENTS.take.agg` 派生）');
eq(field('col_status1').value, 'auto', '默认是「自动」（跟计数模式走）');
{
    const sel = field('col_status1');
    sel.value = 'own';
    sel.dispatchEvent({ type: 'change' });
    pane().querySelector('#settings-save-btn').click();
    await tick(60);
    eq(AppState.settings.display.fieldColumn.status1, 'own', '保存 ⇒ 写进 `settings.display.fieldColumn`');
    eq(AppState.settings.display.fieldColumn.status2, undefined,
        '只写**偏离默认**的项（没碰的字段不落库）');
    // 再选回「自动」⇒ 那一项要被**删掉**（否则设置里会攒下一堆等于默认的死项）
    renderSettingsPage();
    const sel2 = field('col_status1');
    eq(sel2.value, 'own', '重画后控件显示已保存的值');
    sel2.value = 'auto';
    sel2.dispatchEvent({ type: 'change' });
    pane().querySelector('#settings-save-btn').click();
    await tick(60);
    eq(AppState.settings.display.fieldColumn.status1, undefined, '选回「自动」⇒ 该项被清掉');
}

// ================================================================
group('④′ 校验规则照旧（非法值不落库，给一句人话）');
seed();
renderSettingsPage();
sectionBtn('performance').click();          // L1/L2 在「性能」栏
const l2 = field('l2');
l2.value = '0';
l2.dispatchEvent({ type: 'input' });
const before = AppState.settings.performance.expandedNodeBlockLimit;
pane().querySelector('#settings-save-btn').click();
await tick(40);
eq(AppState.settings.performance.expandedNodeBlockLimit, before, 'L2 填 0 ⇒ 不保存');

// ================================================================
group('④″ 题目 AC 时间的规则：保存真的落库 + **当场重算 P 的 `acTime` 缓存**（v9.1.21）');
{
    // 为什么这条必须走**真设置页**：`settings.acTimeRule` 是**唯一一条会改到"已物化缓存字段"**的设置 ——
    //   它必须连带触发 `recomputeAcTime`，否则 `node.acTime`（缓存）与派生表**两个答案**。
    //   夹具：一道题 2019 过过一次、2026 重训又过 ⇒ 换规则时缓存值必须跟着变。
    seed();
    AppState.nodes.p = { id: 'p', type: 'P', name: '重训题', acTime: '----.--.-- --:--' };
    AppState.nodes.r1 = { id: 'r1', type: 'R', status: 'AC', time: '2019.01.01 10:00:00' };
    AppState.nodes.r2 = { id: 'r2', type: 'R', status: 'AC', time: '2026.03.19 22:32:42' };
    AppState.childOrder.p = ['r1', 'r2'];
    renderSettingsPage();
    sectionBtn('stats').click();
    eq(field('acTimeRule').value, 'earliest', '★ 默认停在「取最早」（= 老行为，老存档也读得出来）');
    eq(AppState.nodes.p.acTime, '----.--.-- --:--', '夹具前提：缓存还是占位的（没跑过自动计算）');

    // ① 选了「截断」却没填值 ⇒ **不保存**、给一句人话（别静默退回另一条规则）
    field('acTimeRule').value = 'cutoff';
    field('acTimeRule').dispatchEvent({ type: 'change' });
    pane().querySelector('#settings-save-btn').click();
    await tick(40);
    eq(AppState.settings.acTimeRule, 'earliest', '★ 缺截断值 ⇒ 一个字都不落库（规则还停在 earliest）');
    ok(serialize(document.getElementById('toast')).includes('8 / 12 / 14'), '并且把"要填几位"说清楚');

    // ② 补上截断值 ⇒ 落库 + **缓存当场重算**（2019 那条被截掉 ⇒ 取 2026 那次）
    field('acTimeCutoff').value = '20260101';
    field('acTimeCutoff').dispatchEvent({ type: 'input' });
    pane().querySelector('#settings-save-btn').click();
    await tick(60);
    eq(AppState.settings.acTimeRule, 'cutoff', '保存 ⇒ 写进 `settings.acTimeRule`');
    eq(AppState.settings.acTimeCutoff, '20260101', '截断值按**原样**存（用户填什么就是什么）');
    eq(AppState.nodes.p.acTime, '2026.03.19 22:32:42',
        '★★ 缓存当场重算成"截断之后那一次" —— 不重算的话训练追踪就看不见这次重训');

    // ③ 换回「取最近」⇒ 缓存跟着变；⚠️ 截断值**留着**（口径已反转，见下）
    renderSettingsPage();
    sectionBtn('stats').click();
    eq(field('acTimeRule').value, 'cutoff', '重画后控件显示已保存的规则');
    field('acTimeRule').value = 'latest';
    field('acTimeRule').dispatchEvent({ type: 'change' });
    pane().querySelector('#settings-save-btn').click();
    await tick(60);
    eq(AppState.settings.acTimeRule, 'latest', '保存 ⇒ 换成 `latest`');
    // ⚠️ **口径反转**（`v9.1.28`，用户 2026-10-13："希望截断时间不要随模式切换丢失"）：
    //   这一条原来钉的是"非 cutoff 规则 ⇒ 截断值清掉（不留死值）"（`v9.1.21` 我自己的口径）。
    //   用户明确不要清 ⇒ 改成"留着"，并**删掉"清掉"这条断言**（同一件事只留一个说法，
    //   新的判据在下面 ④⁵ 那组：切走再切回来不用重填）。
    eq(AppState.settings.acTimeCutoff, '20260101', '★ 非 cutoff 规则 ⇒ 截断值**留着**（用户要求：切回来不用重填）');
    eq(AppState.nodes.p.acTime, '2026.03.19 22:32:42', '取最近 = 也是 2026 那次（这道题两次 AC）');
}

// ================================================================
group('④‴ 查看范围「带直接子账户」：复选框读的是 `.checked`（不是 `.value`）');
{
    // 用户 2026-10-13："把账户的**子账户**机制用起来…**做成一个选项、与原逻辑并列**"（定成全局设置）。
    // ⚠️ 这里钉的是**复选框特有的坑**：`input.value` 恒为 `"on"`，写成 `draft[x] = t.value`
    //    会让"取消勾选"也存成真值 ⇒ 这个选项**永远关不掉**。
    seed();
    renderSettingsPage();
    sectionBtn('stats').click();
    const box = field('scopeMergeChildren');
    ok(!!box, '设置页有这一格（在 📊 统计栏，与计数模式/AC 时间规则同屏）');
    eq(box.checked, false, '★ 默认不勾 = 原逻辑（只看本账户）');

    box.checked = true;
    box.dispatchEvent({ type: 'change' });
    pane().querySelector('#settings-save-btn').click();
    await tick(60);
    eq(AppState.settings.scopeMergeChildren, true, '勾上 ⇒ 落库为 `true`');

    renderSettingsPage();
    sectionBtn('stats').click();
    const box2 = field('scopeMergeChildren');
    eq(box2.checked, true, '重画后控件显示已保存的值');
    box2.checked = false;
    box2.dispatchEvent({ type: 'change' });
    pane().querySelector('#settings-save-btn').click();
    await tick(60);
    eq(AppState.settings.scopeMergeChildren, false,
        '★★ 取消勾选 ⇒ 必须落成 `false`（把 `.checked` 写成 `.value` 的话这里会是 `"on"`，永远关不掉）');
}

// ================================================================
group('④⁗ 第 4 种 AC 时间规则（忽略截断前的提交）：下拉有它 + 缓存**三格一起重算**');
{
    // 用户 2026-10-13："题目的 Ac时间/最新提交/stat2 要按条件判断（提交是否忽略）每个提交是否取"
    //   ⇒ 改这条规则时，`recomputeAcTime` 必须把**三格**都重算（只算 acTime 会留下两个答案）。
    seed();
    AppState.nodes.p = { id: 'p', type: 'P', name: '题', acTime: '', lastSubmitTime: '', status2: 0, values: {} };
    AppState.nodes.r1 = { id: 'r1', type: 'R', status: 'AC', time: '2019.01.01 10:00:00', submitKind: 'upsolve', values: {} };
    AppState.nodes.r2 = { id: 'r2', type: 'R', status: 'WA', time: '2026.05.01 10:00:00', submitKind: 'upsolve', values: {} };
    AppState.childOrder.p = ['r1', 'r2'];
    renderSettingsPage();
    sectionBtn('stats').click();
    // ⚠️ 断言**标签文本**而不是 `value="cutoffIgnore"`：DOM 桩的 `serialize()` 不输出属性
    //    （只给标签/文本）—— 写属性会得到一条假红。
    ok(serialize(pane()).includes('并忽略截断前的所有提交'), '★ 下拉里有第 4 种（用户看得到的那个标签）');

    // ① 选了第 4 种却不填截断值 ⇒ **不落库** + 报一句人话
    const sel = field('acTimeRule');
    sel.value = 'cutoffIgnore';
    sel.dispatchEvent({ type: 'change' });
    pane().querySelector('#settings-save-btn').click();
    await tick(40);
    eq(AppState.settings.acTimeRule, 'earliest', '★ 缺截断值 ⇒ 一个字都不落库（第 4 种也要截断值）');
    ok(serialize(document.getElementById('toast')).includes('8 / 12 / 14'), '并且说要填几位');

    // ② 补上截断值 ⇒ 落库 + **三格缓存一起重算**
    field('acTimeCutoff').value = '20260101';
    field('acTimeCutoff').dispatchEvent({ type: 'input' });
    pane().querySelector('#settings-save-btn').click();
    await tick(60);
    eq(AppState.settings.acTimeRule, 'cutoffIgnore', '保存 ⇒ 写进设置');
    eq(AppState.nodes.p.status2, 2, '★★ 2019 那次 AC 被忽略 ⇒ 只剩 2026 那发 WA（已提交未通过）');
    eq(AppState.nodes.p.acTime, '----.--.-- --:--', '★★ 没有"截断之后的 AC" ⇒ 占位符');
    eq(AppState.nodes.p.lastSubmitTime, '2026.05.01 10:00:00', '★★ 最新提交也只看没被忽略的那发');
}

// ================================================================
group('④⁵ 截断时间不随规则切换丢失（用户 2026-10-13："希望截断时间不要随模式切换丢失"）');
{
    // 病根（`v9.1.28`）：保存时写的是 `acNeedsCutoff ? acCutoffRaw : ''` ⇒ 只要当前这条规则
    // **用不到**截断值，一存就把它抹了；切回带截断的规则时得重填一遍（用户看到的"丢失"）。
    // 判据：切到「取最早」保存后，`settings.acTimeCutoff` 必须**一个字都没少**。
    seed();
    renderSettingsPage();
    sectionBtn('stats').click();

    // ① 前提：按第 4 种存一个截断值
    field('acTimeRule').value = 'cutoffIgnore';
    field('acTimeRule').dispatchEvent({ type: 'change' });
    field('acTimeCutoff').value = '20260101';
    field('acTimeCutoff').dispatchEvent({ type: 'input' });
    pane().querySelector('#settings-save-btn').click();
    await tick(50);
    eq(AppState.settings.acTimeRule, 'cutoffIgnore', '（前提）第 4 种规则落库');
    eq(AppState.settings.acTimeCutoff, '20260101', '（前提）截断值落库');

    // ② ★ 切到**不带截断**的规则再保存 ⇒ 截断值必须留着（改前这里是 `''`）
    field('acTimeRule').value = 'earliest';
    field('acTimeRule').dispatchEvent({ type: 'change' });
    pane().querySelector('#settings-save-btn').click();
    await tick(50);
    eq(AppState.settings.acTimeRule, 'earliest', '规则切到「取最早」并落库');
    eq(AppState.settings.acTimeCutoff, '20260101', '★ 截断值**没被抹掉**（切回来不用重填）');

    // ③ 再切回带截断的规则 ⇒ 直接就能存（不用重填），且输入框里看得见那个值
    field('acTimeRule').value = 'cutoffIgnore';
    field('acTimeRule').dispatchEvent({ type: 'change' });
    pane().querySelector('#settings-save-btn').click();
    await tick(50);
    eq(AppState.settings.acTimeRule, 'cutoffIgnore', '切回第 4 种 ⇒ 直接落库（没有"要填截断值"的拦阻）');
    eq(AppState.settings.acTimeCutoff, '20260101', '截断值仍是原来那一个');
    eq(field('acTimeCutoff').value, '20260101', '重画之后输入框里显示的就是它（不是空的）');
}

// ================================================================
group('⑤ 「🔑 名册/凭据」页 = me.json 编辑器（进那一页才联网；切走再回来草稿还在）');
seed();
renderSettingsPage();
ok(!meCalls.some((c) => c.url.includes('api/me')), '没进那一栏 ⇒ 不联网');
sectionBtn('me').click();
await tick(50);
// 这一栏分「账户 / 名册」两页，默认停在**账户**页 ⇒ 名册那半还没画、也没联网
eq(pane().querySelectorAll('.me-subtab').length, 2, '★ 二级栏里有「账户」「名册/凭据」两页');
eq(pane().querySelector('.me-subtab-on').dataset.sub, 'accounts', '★ 默认停在「账户」页');
ok(!meCalls.some((c) => c.url.includes('api/me')), '★ 停在账户页**一个字都不联网**');
ok(!pane().querySelector('#settings-tab-me'), '账户页里不画 me.json 编辑器（一次只画一块）');
meSubBtn('roster').click();
await tick(50);
ok(meCalls.some((c) => c.url.includes('api/me')), '切到「名册/凭据」页才去读 /api/me');
const meStatus = pane().querySelector('#me-status');
ok(meStatus && /me\.json/.test(meStatus.textContent), '状态行报出 me.json 的路径',
    meStatus ? meStatus.textContent : '(没有 #me-status)');
ok(pane().querySelectorAll('.me-view-btn').length === 2, '表单 / JSON 两个视图按钮都在');

// 在 me.json 那一页敲一格（不保存），切走再回来：草稿必须还在
// `accounts[]` 是"对象数组" ⇒ 渲染成记录行（`.me-field`），不是 `.me-value`
const meInput = pane().querySelectorAll('.me-field').find((i) => i.value === 'me_cf');
meInput.value = '改了一半';
meInput.dispatchEvent({ type: 'input' });
sectionBtn('stats').click();
await tick();
sectionBtn('me').click();
meSubBtn('roster').click();
await tick(40);
ok(pane().querySelectorAll('.me-field').some((i) => i.value === '改了一半'),
    '⚠️ 切走再回来，me.json 的草稿还在（编辑器实例跨重画复用）');
ok(meCalls.filter((c) => c.url.includes('api/me')).length === 1,
    '回来时**没有重复读**（实例还活着，不是重建）', `读了 ${meCalls.filter((c) => c.url.includes('api/me')).length} 次`);

// ================================================================
group('⑥ 「🔑 账户/名册」= 同一栏的**两页**（一次只画一块；账户那页可正常操作）');
seed();
// 先造第二个账户，好点它的「改为查看」
const { execute } = await import(mod('shell/executor.js'));
const accOps = await import(mod('core/ops/account.js'));
await execute((d) => accOps.createAccount(d, { name: '小号', nature: '本人小号' }),
    { validate: false, refreshParentId: null });
renderSettingsPage();
sectionBtn('me').click();
await tick(40);
const accHost = pane().querySelector('#settings-accounts-host');
ok(!!accHost, '账户页里有「应用账户」那块');
ok(/账户（\d+）/.test(serialize(accHost)) && /小号/.test(serialize(accHost)),
    '账户列表画出来了（含"本机"与测试建的「小号」）', serialize(accHost).slice(0, 60) + '…');
ok(!pane().querySelector('#settings-tab-me'), '★ 账户页里**没有** me.json 那半（分页了，一次只画一块）');
meSubBtn('roster').click();
await tick(40);
ok(!!pane().querySelector('#settings-tab-me'), '切到名册页才画 me.json 那半');
ok(!pane().querySelector('#settings-accounts-host'), '★ 名册页里也没有账户那半');
meSubBtn('accounts').click();
await tick(40);

// 账户是**绝对真源**（在应用数据里）⇒ 这一页正常可操作（走 ops + 撤销），不写文件
// ⚠️ 「查看它」**每张卡都有**（当前那个是高亮+禁用）⇒ 挑一个"不是当前查看"的来点
const viewBtn = pane().querySelectorAll('.acc-act')
    .find((b) => b.dataset.act === 'view' && b.dataset.id !== AppState.viewingAccountId);
ok(!!viewBtn, '账户卡片上有可点的「查看它」');
ok(viewBtn.disabled !== true, '按钮可点（真源就在这儿）');
viewBtn.click();
await tick(60);
eq(AppState.viewingAccountId, viewBtn.dataset.id, '⚠️ 点了**真的改了**应用状态（ops 那条路）');

// ================================================================
group('⑧ 账户顺序 / 停用页 / 恒在的那一对按钮');
seed();
{
    await execute((d) => {
        // 三个账户：名字故意与"建的顺序"相反 —— 只按名字排的话顺序就是 a/b/c
        accOps.createAccount(d, { name: '阿', id: 'kkkkkkkkkkka', mappings: [] });
        accOps.createAccount(d, { name: '波', id: 'kkkkkkkkkkkb', mappings: [] });
        accOps.createAccount(d, { name: '次', id: 'kkkkkkkkkkkc', mappings: [] });
    }, { validate: false, refreshParentId: null });
    renderSettingsPage();
    sectionBtn('me').click();
    await tick(40);
    const idsInList = () => pane().querySelectorAll('#acc-list .acc-card')
        .map((c) => c.querySelector('[data-act="up"], [data-act="down"]')).map((b) => b && b.dataset.id);

    // ① 恒在第一 = 默认账户「本机」（它没有箭头）
    ok(accOps.listAccountIds(AppState)[0] === 'local', '★ 排序结果里「本机」恒第一');
    const cards = pane().querySelectorAll('#acc-list .acc-card');
    ok(!cards[0].querySelector('[data-act="up"]'), '「本机」那张卡**没有箭头**（它不参与排序）');
    eq(pane().querySelectorAll('#acc-list [data-act="up"]').length, 3, '其余三个账户各有一个 ↑');

    // ② 上移一位：顺序真的变了，而且**整列归一化**（都拿到 order）
    const order = () => accOps.listAccountIds(AppState).filter((id) => id !== 'local');
    const before = order();
    const second = before[1];
    await execute((d) => accOps.moveAccount(d, second, -1), { validate: false, refreshParentId: null });
    const after = accOps.listAccountIds(AppState).filter((id) => id !== 'local');
    eq(after[0], second, '★ 上移一位 ⇒ 它与上一位换了位置（顺序由 order 决定）');
    eq(after.slice().sort().join(','), before.slice().sort().join(','), '只换位置，不增不减');
    ok(AppState.accounts[second].order < AppState.accounts[before[0]].order,
        '★ 移动后整列都被写成 0..n-1 的序号（顺序从此与名字无关）',
        `${AppState.accounts[second].order} vs ${AppState.accounts[before[0]].order}`);

    // ③ 到头了返回 false（界面据此把箭头画成灰的，不画成"没了"）
    eq(accOps.moveAccount(AppState, second, -1), false, '已经在「本机」后面那一位 ⇒ 返回 false');
    eq(accOps.moveAccount(AppState, 'local', 1), false, '「本机」不参与交换');
    ok(AppState.accounts.local.order === AppState.accounts[second].order - 1
        || accOps.listAccountIds(AppState)[1] === second, '「本机」仍在最前');

    // ④ 停用的账户挪到另一页
    renderSettingsPage();
    sectionBtn('me').click();
    await tick(40);
    eq(pane().querySelector('#acc-list').dataset.page, 'on', '★ 默认停在「活跃」页');
    await execute((d) => accOps.setAccountActive(d, second, false), { validate: false, refreshParentId: null });
    renderSettingsPage();
    sectionBtn('me').click();
    await tick(40);
    ok(!/#acc-list[\s\S]*?波/.test(serialize(pane().querySelector('#acc-list'))),
        '★ 停用之后它**不在活跃页**里了');
    pane().querySelectorAll('.acc-page').find((b) => b.dataset.page === 'off').click();
    await tick(40);
    eq(pane().querySelector('#acc-list').dataset.page, 'off', '切到「已停用」页');
    ok(/波/.test(serialize(pane().querySelector('#acc-list'))), '已停用页看得见它');
    ok(!/本机/.test(serialize(pane().querySelector('#acc-list'))), '★ 已停用页里没有活跃账户');

    // ⑤ 「以它登录」/「查看它」常驻 + 高亮（不是"当前那个就消失"）
    pane().querySelectorAll('.acc-page').find((b) => b.dataset.page === 'on').click();
    await tick(40);
    const loginBtns = pane().querySelectorAll('#acc-list [data-act="login"]');
    const viewBtns = pane().querySelectorAll('#acc-list [data-act="view"]');
    const cardCount = pane().querySelectorAll('#acc-list .acc-card').length;
    eq(loginBtns.length, cardCount, '★ 「以它登录」每张卡都在（当前那个也不消失）');
    eq(viewBtns.length, cardCount, '★ 「查看它」同理');
    const curLogin = loginBtns.find((b) => b.dataset.id === AppState.currentAccountId);
    ok(curLogin && curLogin.disabled, '★ 当前登录账户那个按钮**高亮 + 禁用**（点它本来就没事可做）');
    ok(/✅/.test(serialize(curLogin)), '高亮那个带上「✅」字样');
}

// ================================================================
group('⑦ 👤 工具栏标记 = **弹出账户窗**（用户 2026-10-19：改回弹窗形态）');
seed();
switchTab('main');
await tick();
const chipBtn = document.createElement('button');
chipBtn.id = 'account-chip';
document.body.appendChild(chipBtn);
bindUIButtons();
const panelsBefore = document.querySelectorAll('.modal-panel').length;
chipBtn.click();
await tick(60);
// ★ 用户原话："很久以前的版本 点顶部的账号按钮会弹窗，那样挺好的" —— 前一版改成"切到设置页"被否。
//   判据两条一起看：**弹出一个账户窗**，且**没有把人从树上甩到设置页**。
eq(getCurrentTab(), 'main', '★ 点 👤 不再切到设置页（人还在原来的页签上）');
const panelsAfter = document.querySelectorAll('.modal-panel');
eq(panelsAfter.length, panelsBefore + 1, '★ 点 👤 弹出一个窗');
ok(/👤 账户/.test(serialize(panelsAfter[panelsAfter.length - 1])), '弹的是「👤 账户」窗');
// 设置页那一栏照旧（⚙ 进得去、里面还是同一份账户视图）——见下面 ⑧/⑩ 各组对 `#settings-accounts-host` 的断言。

// ================================================================
group('⑨ 读 me.json **不动账户**（账户是绝对真源，在应用数据里）');
seed();
{
    // 先按"真源"的样子建一个账户（走 ops，与界面上编辑同一条路）
    await execute((d) => {
        const id = accOps.createAccount(d, { name: '我', nature: '本人' });
        accOps.saveAccount(d, id, { mappings: [{ source: 'cf', field: 'handle', value: 'me_cf' }] });
    }, { validate: false, refreshParentId: null });
    const before = JSON.stringify(AppState.accounts);

    sectionBtn('me').click();
    await tick(60);
    ok(!meCalls.some((c) => c.url.includes('api/me')), '★ 账户页不读 me.json（它有自己的页）');
    meSubBtn('roster').click();
    await tick(60);
    ok(meCalls.some((c) => c.url.includes('api/me')), '名册页才读 me.json');
    eq(JSON.stringify(AppState.accounts), before,
        '⚠️ 读 me.json **没碰**账户（不许把账户投影覆盖掉）');
}

group('⑩0 账户那一页：**新建账户的入口在视图里**（嵌进设置页也能建）');
seed();
{
    // 病根（2026-10-19，用户在新发布的副本里问"怎么新建账户?"）：那颗「＋ 新建账户」原来只写在
    // `showAccountsModal()` 的**弹窗页脚**里，而设置页用的是同一个视图（`mountAccountsView`）却没有页脚
    // ⇒ 设置页整栏**没有任何新建入口**（只有「📤 写进 me.json」，而 me.json 名册是派生物、改它长不出账户）。
    sectionBtn('me').click();
    meSubBtn('accounts').click();
    await tick(60);
    const host = pane().querySelector('#settings-accounts-host');
    ok(!!host, '设置页有账户视图宿主');
    // ⚠️ 视图是 innerHTML 画的 ⇒ 解析后 `textContent` 是空的（见本文件第 120 行那条注释），
    //    所以按 `data-act` 找、按 `serialize` 验字。
    const newBtns = host.querySelectorAll('.acc-act').filter((b) => b.dataset.act === 'new');
    ok(newBtns.length === 1, `★ 视图里恰好一颗「＋ 新建账户」（弹窗页脚不再重复一颗）—— 实际 ${newBtns.length}`);
    ok(/＋ 新建账户/.test(serialize(host)), '按钮上的字画出来了');
    newBtns[0].click();
    await tick(80);
    const panels = document.querySelectorAll('.modal-panel');
    const editor = panels[panels.length - 1];
    ok(!!editor.querySelector('#acc-name'), '★ 点它真叠出「👤 新建账户」编辑器');
    const cancel = editor.querySelectorAll('.btn').find((b) => serialize(b).trim() === '取消');
    ok(!!cancel, '编辑器有「取消」');
    cancel.click();
    await tick(60);
}

group('⑩ 「📤 写进 me.json（爬虫用）」：映射 → 名册，**凭据与说明不动**');
seed();
{
    await execute((d) => {
        const id = accOps.createAccount(d, { name: '我', nature: '本人' });
        accOps.saveAccount(d, id, {
            mappings: [
                { source: 'cf', field: 'handle', value: 'me_cf' },
                { source: 'qoj', field: '提交者', value: 'me_qoj' },
                { source: 'nk:2026', field: '用户名', value: '2026届队名' },
                { source: 'pta:icpc2026', field: '队伍', value: 'demo' }
            ]
        });
    }, { validate: false, refreshParentId: null });

    sectionBtn('me').click();
    meSubBtn('accounts').click();        // 「写进 me.json」按钮在**账户**那一页
    await tick(60);
    const expBtn = pane().querySelector('#me-export-btn');
    ok(!!expBtn, '账户页有「📤 写进 me.json（爬虫用）」按钮');
    expBtn.click();
    await tick(80);

    const panels = document.querySelectorAll('.modal-panel');
    const preview = panels[panels.length - 1];
    const txt = serialize(preview);
    ok(/写进 me\.json/.test(txt), '预览标题在');
    ok(/cf=me_cf/.test(txt), '预览里能看见导出来的平台账号');
    ok(/nk:2026=2026届队名/.test(txt), '`nk:2026` 那条变成了 `byYear` 的 2026 年');

    const okBtn = preview.querySelectorAll('button').find((b) => /确定写/.test(b.textContent));
    ok(!!okBtn, '确定按钮带着"会写几个人"');
    okBtn.click();
    await tick(140);

    const put = meCalls.filter((c) => c.method === 'PUT').at(-1);
    ok(!!put && !!put.sent, '真的 PUT 了 me.json');
    const written = JSON.parse(put.sent.text);
    const me = (written.accounts || []).find((a) => a.name === '我');
    ok(!!me, '名册里有人了（就是应用里的账户）');
    eq(me.cf, 'me_cf', 'cf 映射 → `cf` 字段');
    eq(me.qoj, 'me_qoj', 'qoj 映射 → `qoj` 字段');
    eq(me.byYear && me.byYear.nk && me.byYear.nk['2026'], '2026届队名', '带赛季的 → `byYear` 的年份');
    eq((me.mappings || []).map((m) => m.source).join(','), 'pta:icpc2026',
        '⚠️ 推不出来的（pta 命名空间）**原样留在 mappings 里**');
    eq(written.cf && written.cf.apiKey, 'REAL-CF-KEY', '⚠️ 凭据没被动（apiKey 还在原处）');
    ok(Array.isArray(written._note) && written._note.length > 0, '说明（_note）也留着');
}
// ================================================================
group('⑪ ⚙️ 工具栏按钮 = 切到这一页');
seed();
setupTabs();
switchTab('main');
await tick();
// 桩里的 index.html 没建 #settings-icon（那是 toolbar 里的）——补一个再绑
const icon = document.createElement('button');
icon.id = 'settings-icon';
document.body.appendChild(icon);
bindUIButtons();
icon.click();
await tick();
eq(getCurrentTab(), 'settings', '点 ⚙️ 就切到设置页');

// ================================================================
group('⑫ 用「表单」保存 me.json：`byYear` / `mappings` 不会被写坏');
seed();
{
    sectionBtn('me').click();
    meSubBtn('roster').click();          // me 编辑器在「名册/凭据」那一页
    await tick(60);
    // 表单视图下 accounts[] 是"记录行"：byYear / mappings 是对象/数组 ⇒ 必须给 JSON 框，
    // 否则存下去会变成 "[object Object]"（真丢数据 —— 这条就是为它钉的）
    const jsonBoxes = pane().querySelectorAll('.me-field-json');
    ok(jsonBoxes.length >= 2, '`byYear` / `mappings` 那几个格子是 JSON 文本框', `实际 ${jsonBoxes.length} 个`);
    ok(jsonBoxes.some((t) => /23届队名/.test(t.value)), '里面是那一份 JSON 内容');

    const nBefore = meCalls.filter((c) => c.method === 'PUT').length;
    pane().querySelector('#me-save').click();
    await tick(140);
    const put = meCalls.filter((c) => c.method === 'PUT').at(-1);
    ok(meCalls.filter((c) => c.method === 'PUT').length === nBefore + 1, '表单保存真的 PUT 了');
    const written = JSON.parse(put.sent.text);
    const me = written.accounts.find((a) => a.name === '我');
    ok(me.byYear && me.byYear.nk && me.byYear.nk['2023'] === '23届队名',
        '⚠️ `byYear` 原样保住了（没变成字符串/[object Object]）');
    ok(JSON.stringify(me.mappings).includes('pta:12345'), '`mappings` 那条也原样保住');
}

// ================================================================
group('⑬ 🔽 折叠全部：不带 Ctrl 只折**当前页**，带 Ctrl 折**所有页**');
// ================================================================
// 用户 2026-10-13 定的范围语义。树模式下两处展开态**不是同一份**：主树在 `view.expanded`，
// 副页在 `pages[pageId].virtualIndex[v].expanded`（只有 `setVirtualNodeExpanded` 一个写口）。
// ⚠️ 走的是**真的顶栏按钮**（`bindUIButtons` + `#btn-collapse-all`）：出问题的正是"点了没反应"。
seed();                 // seed 已把 treeDisplayMode 摆成 'tree'
setupTabs();
switchTab('main');
await tick();
{
    const VN = (id) => ({ id, type: 'P', refId: null, parentId: 'vr', children: [], expanded: true, currentPage: 3 });
    const mkPages = () => ({     // 两张副页各带展开态；**整块换掉**（逐格改 Immer 看不见）
        pg1: { id: 'pg1', name: '页一', rootId: 'vr', virtualIndex: { vr: VN('vr'), va: VN('va'), vb: VN('vb') } },
        pg2: { id: 'pg2', name: '页二', rootId: 'vr', virtualIndex: { vr: VN('vr'), vc: VN('vc') } }
    });
    const folded = (pid) => Object.values(AppState.pages[pid].virtualIndex).every((n) => n.expanded === false);

    AppState.pages = mkPages();
    AppState.currentPageId = 'pg1';
    AppState.view = { expanded: { nA: true } };      // 主树那份展开态（不带 Ctrl 时不该被动）

    const collBtn = document.createElement('button');
    collBtn.id = 'btn-collapse-all';
    document.body.appendChild(collBtn);
    bindUIButtons();
    const clickCollapse = (ctrlKey) => collBtn.dispatchEvent({ type: 'click', target: collBtn, ctrlKey });

    clickCollapse(false);
    await tick();
    ok(folded('pg1'), '★ 不带 Ctrl：**当前页**的页内展开态全为 false');
    ok(!folded('pg2'), '★ 别的副页**一格没动**（页二照旧全展开）');
    ok(AppState.view.expanded.nA === true, '★ 当前页不是主树 ⇒ 主树那份展开态也不动');
    deepEq(Object.values(AppState.pages.pg1.virtualIndex).map((n) => n.currentPage), [3, 3, 3],
        '★ 折叠**不动页码**（与主树"只清 expanded"同一姿态）');

    AppState.pages = mkPages();
    clickCollapse(true);
    await tick();
    ok(folded('pg1') && folded('pg2'), '★ 带 Ctrl：**所有副页**都折了');
    ok(!AppState.view.expanded.nA, '★ 带 Ctrl 也折主树（`view.expanded` 清空）');
}

// ================================================================
group('⑭ 训练强度映射表：全局若干张有名字的表（⑮），改完计划一起变（自带增删改，不走底部保存）');
{
    seed();
    renderSettingsPage();
    sectionBtn('intensity').click();
    await tick(20);
    ok(!!pane().querySelector('[data-ti="select"]'), '这一栏有「选哪张表」的下拉');
    ok(!!pane().querySelector('[data-ti="editor"]'), '有编辑区');
    ok(/内置默认表/.test(serialize(pane().querySelector('[data-ti="editor"]'))),
        '★ 一张自定义表都没有时，编辑区如实说"用的是内置默认表（只读）"');
    ok(!pane().querySelector('[data-ti="save"]'), '内置那张**不给保存**（它是出厂口径，不是数据）');

    // ① 新建一张 ⇒ 带出厂曲线（XCPC 侧的控制点 / 数值侧的控制点 / 默认强度都填好）
    const nameInput = pane().querySelector('[data-ti="new-name"]');
    nameInput.value = '我的强度表';
    nameInput.dispatchEvent({ type: 'input' });
    pane().querySelector('[data-ti="add"]').click();
    await tick(40);
    const list = AppState.settings.trainingIntensityTables;
    eq(list.length, 1, '表库里有了一张');
    eq(list[0].name, '我的强度表', '名字用的是输入框里那个');
    ok(Array.isArray(list[0].byRatio) && list[0].byRatio.length > 0, '★ 出厂 XCPC 控制点已填好（第 5 轮改成按通过率）');
    ok(Array.isArray(list[0].byCf) && list[0].byCf.length > 0, '出厂数值控制点也填好');
    eq(list[0].mode, 'exp', '★ 点之间默认是**指数段**（用户第 8 轮；另有线段 / 平滑曲线两档）');
    // ★ 第 12 轮（"未填写的不计入 ⇒ 强度为 0"）：表里**不再有** `defaultValue` 那个字段，
    //   设置页上那个「没填难度时按它算」的输入框也一并删了（留着就是个不起作用的旋钮）
    eq('defaultValue' in list[0], false, '★ 表里不再有 defaultValue（没填难度 ⇒ 强度 0）');
    ok(!pane().querySelector('[data-ti="default"]'), '★ 设置页那一栏也没有「默认强度」输入框了');

    // ② 改一个控制点（通过率 11% 那一点 = 银牌的分界点）⇒ 保存真的落库
    // ⚠️ 表格是**易 → 难**排的（用户第 5 轮）⇒ 别按行号取，**按横坐标值取**那一行
    const ratioValueByMax = (maxVal) => {
        const maxes = [...pane().querySelectorAll('input')]
            .filter((n) => String(n.dataset.ti || '').endsWith(':max') && String(n.dataset.ti).startsWith('ratio:'));
        const hit = maxes.find((n) => String(n.value) === String(maxVal));
        return hit ? pane().querySelector(`[data-ti="${String(hit.dataset.ti).replace(':max', ':value')}"]`) : null;
    };
    const silver = ratioValueByMax(11);
    ok(!!silver, '控制点里找得到「通过率 11%」那一行（= 银牌的分界点）');
    ok(/银牌/.test(serialize(pane())) && /C\+/.test(serialize(pane())),
        '★ 控制点旁边标出了档名（唯一一份：`xcpcPointLabelOf`）');
    silver.value = '9';
    silver.dispatchEvent({ type: 'input' });
    pane().querySelector('[data-ti="save"]').click();
    await tick(40);
    const pt11 = AppState.settings.trainingIntensityTables[0].byRatio.find((p) => Number(p.max) === 11);
    eq(pt11 && pt11.value, 9, '★ 控制点强度落库');

    // ③ 删掉某一个控制点 ⇒ 那一点不再在表里（相邻两点之间就变成一条长线段）
    const beforePts = AppState.settings.trainingIntensityTables[0].byRatio.length;
    pane().querySelector('[data-ti="ratio:5:del"]').click();
    await tick(40);
    eq(AppState.settings.trainingIntensityTables[0].byRatio.length, beforePts - 1, '★ ✖ 删一点 落库');

    // ④ 数值侧：加一点 / 删一点都落库，且**归一化时按 max 升序**
    const before = AppState.settings.trainingIntensityTables[0].byCf.length;
    pane().querySelector('[data-ti="cf:add"]').click();
    await tick(40);
    eq(AppState.settings.trainingIntensityTables[0].byCf.length, before + 1, '＋ 加一点 落库');
    pane().querySelector('[data-ti="cf:0:del"]').click();
    await tick(40);
    eq(AppState.settings.trainingIntensityTables[0].byCf.length, before, '✖ 删一点 也落库');
    const maxes = AppState.settings.trainingIntensityTables[0].byCf.map((r) => (r.max === null ? Infinity : r.max));
    ok(maxes.every((v, i) => i === 0 || v >= maxes[i - 1]), '★ 归一化后 `byCf` 按 max 升序（曲线才不会来回折）');

    // ⑤ 删表按钮的接线在（**不点**：它是 3 秒倒计时的确认框，点了要等 3 秒；
    //    删除本身由 `trainingPlan.test.js` 与只读守卫那两条覆盖）
    ok(!!pane().querySelector('[data-ti="delete"]'), '「✖ 删除这张表」的按钮在（走了既有确认框）');
    const intensityMod = await import(mod('ui/settings/intensitySection.js'));
    eq(intensityMod.currentIntensityTableId(), AppState.settings.trainingIntensityTables[0].id,
        '这一栏停在刚建的那张表上（重画之后也没丢）');

    // ⑥ 换回内置那张 ⇒ 编辑区又变回只读
    const sel = pane().querySelector('[data-ti="select"]');
    sel.value = '';
    sel.dispatchEvent({ type: 'change' });
    await tick(20);
    ok(/内置默认表/.test(serialize(pane().querySelector('[data-ti="editor"]'))), '换回内置 ⇒ 编辑区只读');
    ok(AppState.settings.trainingIntensityTables.length === 1, '换表不动数据');
}
report();
