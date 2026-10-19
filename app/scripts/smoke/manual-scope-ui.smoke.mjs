// 手改值的归属：**UI 那一段**（编辑框开关 / 🌐 标记 / 转成所有人共用）。core 那段见 src/test/manualScope.test.js。
// 跑法：npm run test:smoke -- manual-scope-ui；每条"去掉哪一行会红"见交付报告。
import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { installDom, makeContainer } from './dom.mjs';
import { group, ok, eq, report } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const mod = rel => `file://${path.join(ROOT, 'src', rel).replace(/\\/g, '/')}`;
const tick = (ms = 60) => new Promise(r => setTimeout(r, ms));
const body = installDom([], { parseHtml: true });
makeContainer(body, 'app'); makeContainer(body, 'toast');
globalThis.fetch = async () => ({ ok: false, json: async () => ({}) });
const { AppState } = await import(mod('shell/state.js'));
const { createInitialState } = await import(mod('core/model/state.js'));
const { createNode } = await import(mod('core/model/node.js'));
const { buildSourcePanelHtml } = await import(mod('ui/G_modal/sourcePanel.js'));
const { buildEditForm, applyEdit } = await import(mod('ui/G_modal/editForm.js'));
const { noteTypedField } = await import(mod('ui/G_modal/manualInput.js'));
const { renderEditFieldsHtml, readEditValues } = await import(mod('ui/G_modal/G2_common.js'));
await import(mod('ui/G_modal/sourceActions.js'));           // import 即注册委托监听

const TRUST = { categoryRank: ['manual', 'board', 'script', 'derived'], fieldPrefer: {},
    sources: { manual: { kind: 'manual', rank: 100 }, 'srk:x': { kind: 'script', rank: 20 } } };
const PID = 'p_scope_ui';
/** 摆一个 P 节点（来源层直接给 `values`）；k1/k2 要登记 —— 不登记面板会把它们的值当"停用账户"藏起来 */
function seed(values = {}, manualScope = '') {
    const base = createInitialState();
    for (const k of Object.keys(base)) AppState[k] = base[k];
    AppState.settings.manualScope = manualScope;
    Object.assign(AppState.accounts, { k1: { id: 'k1', name: '主号', mappings: [] },
        k2: { id: 'k2', name: '小号', mappings: [] } });
    AppState.sources['srk:x'] = AppState.trust.sources['srk:x'] = { kind: 'script', rank: 20 };
    const n = createNode(PID, 'P', { name: '题', extKey: 'xcpc:p:scope-ui' });
    n.values = values; AppState.nodes[PID] = n; AppState.childOrder[PID] = [];
    AppState.parentOf[PID] = AppState.rootId; AppState.childOrder[AppState.rootId].push(PID);
    return n;
}
const fields = () => buildEditForm(AppState.nodes[PID]).fields;
const sw = () => fields().find(f => f.key === 'manualScope');
const manuals = f => (AppState.nodes[PID].values[f] || []).filter(x => x && x.src === 'manual');
const accOf = e => String((e && e.account) || '');
const hasPromote = html => /data-src-act="promote"/.test(html);
const lastDialog = () => { const d = document.body.querySelectorAll('.modal-overlay'); return d[d.length - 1]; };
const payload = () => Object.fromEntries(fields().map(f => [f.key, f.default ?? '']));

group('① 编辑框开关：默认跟 settings.manualScope（没设过 = 第三态「按字段默认」）；改选 ⇒ 写回设置 + 这一次编辑按它记');
{
    seed();
    eq(sw().default, '按字段默认（推荐）', '★ 设置是空（没设过）⇒ 默认选中第三态（= 不表态）');
    const box = document.createElement('div'); box.innerHTML = renderEditFieldsHtml(fields());
    const res = readEditValues(box, fields()).values;       // ★ 走真控件：渲染 → 读回
    eq(res.manualScope, '按字段默认（推荐）', '开关真的渲染成了控件，也读得回来');
    res.ratio = '12.34'; res.manualScope = '所有人共用（客观值）';   // = 用户在真控件里改选
    noteTypedField('ratio');                                // 模拟"用户敲过 ratio"
    eq((await applyEdit(PID, res)).success, true, '★ applyEdit 成功（走的还是那条既有写库路）');
    eq(AppState.settings.manualScope, 'objective', '★ 改选写回了 settings.manualScope（下次的默认）');
    eq(accOf(manuals('ratio')[0]), '', '★ 这一次编辑按 objective 记（不带账户 ⇒ 换谁看都在）');
    seed();                                                 // 对照：**没改**开关（留在第三态）⇒ 不传 scope
    const res2 = payload(); res2.name = '我改的名字'; noteTypedField('name');
    eq(res2.manualScope, '按字段默认（推荐）', '没设过设置 ⇒ 控件里就停在第三态');
    await applyEdit(PID, res2);
    eq(accOf(manuals('name')[0]), AppState.currentAccountId, '没改开关 ⇒ 老行为（按字段回落）');
    eq(AppState.settings.manualScope, '', '★ 保持第三态保存 ⇒ 设置仍是空（不表态，不是第三种设置值）');
    seed({}, 'objective');                                  // 对照：**改选到**第三态
    const res3 = payload(); res3.ratio = '7.77'; res3.manualScope = '按字段默认（推荐）'; noteTypedField('ratio');
    await applyEdit(PID, res3);
    eq(accOf(manuals('ratio')[0]), '', '★ 选第三态 ⇒ 这一次仍不传 scope（core 那条链继续走：写库时设置里那个 objective 还说了算）');
    eq(AppState.settings.manualScope, '', '★★ 选第三态 ⇒ **清掉设置**（`v9.1.20` 修的残余：不清的话下次表单又显示旧值 = 选了个寂寞）');
    eq(sw().default, '按字段默认（推荐）', '★ 清掉之后，下一次表单的默认真的回到第三态（这才叫"生效了"）');

    // 对照：**没动**开关 ⇒ 设置一个字都不许动（`null`（没动）与 `''`（明确选第三态）是两回事）
    seed({}, 'objective');
    eq(sw().default, '所有人共用（客观值）', '设置里有值 ⇒ 默认取设置');
    const res4 = payload(); res4.name = '只改名字'; noteTypedField('name');
    eq(res4.manualScope, '所有人共用（客观值）', '没碰开关 ⇒ 读回来的就是默认本身');
    await applyEdit(PID, res4);
    eq(AppState.settings.manualScope, 'objective', '★ 没改开关 ⇒ 设置原样留着（别把"没动"也当成"清掉"）');
    eq(accOf(manuals('name')[0]), '', '这一次编辑也照设置记（没动开关 = 沿用上次的选择）');
}
group('② 🌐 只标 src === \'manual\' 的客观值');
{
    const html = buildSourcePanelHtml({ values: { ratio: [{ v: '1', src: 'manual', at: 'T1' },
        { v: '2', src: 'manual', at: 'T2', account: 'k1' }, { v: '3', src: 'srk:x', at: 'T3' }] } }, 'ratio', TRUST);
    eq((html.match(/🌐/g) || []).length, 1, '三条里只有"客观手改"那条有 🌐（别的来源的客观值不标）');
    ok(/title="所有人共用（客观值）"/.test(html), '轻标记带 title 说明');
    ok(/🌐/.test(buildSourcePanelHtml({ values: { name: [{ v: 'X', src: 'manual', at: 'T1' }] } }, 'name', TRUST)),
        '单来源分支也标（两条分支同一判据）');
}
group('③ 转成所有人共用：只对名单里的字段出现，且先确认再执行');
{
    const n = seed({ cfDifficulty: [{ v: '2400', src: 'manual', at: 'T2', account: 'k2' },
        { v: '1800', src: 'manual', at: 'T1', account: 'k1' }, { v: '1500', src: 'srk:x', at: 'T0' }],
        ratio: [{ v: '10.00', src: 'manual', at: 'T1', account: 'k1' }] });
    n.cfDifficulty = '1800';
    ok(hasPromote(fields().find(f => f.key === 'cfDifficulty').hint), '★ 表单把名单（core 那一份）递给了面板');
    eq(hasPromote(buildSourcePanelHtml(n, 'ratio', TRUST, { promoteFields: ['cfDifficulty'] })), false, '名单外的字段 ⇒ 不出现');
    eq(hasPromote(buildSourcePanelHtml(n, 'cfDifficulty', TRUST)), false, '调用方没传名单 ⇒ 一个都不给');
    const btn = document.createElement('button');
    btn.className = 'src-act'; Object.assign(btn.dataset, { srcAct: 'promote', field: 'cfDifficulty', node: PID });
    document.body.appendChild(btn);
    const before = JSON.stringify(AppState.nodes[PID].values);
    btn.click(); await tick(30);
    ok(!!lastDialog(), '★ 点下去先弹确认框（没有直接执行）');
    lastDialog().querySelectorAll('.btn').find(b => b.textContent === '取消').click(); await tick(30);
    eq(JSON.stringify(AppState.nodes[PID].values), before, '★ 取消 ⇒ 来源层逐字节不变');
    btn.click(); await tick(30);
    lastDialog().querySelector('.btn-danger').click(); await tick(80);
    eq(manuals('cfDifficulty').length, 1, '★ 只剩一条手改（其余按账户的条目被删掉）');
    eq(accOf(manuals('cfDifficulty')[0]), '', '★ 那条是客观的（所有人共用）');
    eq(manuals('cfDifficulty')[0].v, '2400', '取的是**第一条**按账户的值（不是"本账户那条"）');
    ok(/所有人共用/.test(String(document.getElementById('toast').textContent)), '结果如实提示（说了"所有人共用"）');
}
group('④ 动作结束后该字段那一块只渲染一次（用户 2026-10-13 抓到的"出现两遍"）');
{
    // 症状：点完「转成所有人共用」（**任何动作都一样**）之后，`数值难度: cf …（你选的）`
    //       那一行与右边那组按钮**各出现两遍**，而来源面板整块消失。
    // 病根（2026-10-13 定位）：`buildSourcePanelHtml` 的返回值是 **`expectLine + 面板`** ——
    //   `expectLine`（`<div class="src-expect">`）**排在面板前面**，而 `refreshPanel` 原来取的是
    //   `holder.firstElementChild` ⇒ 拿到的是那一行说明，`replaceChild` 于是把**来源面板**
    //   换成了说明行的一份副本（说明行 ×2、面板消失）。
    //   ⚠️ 此前"复现不出来"的唯一原因：夹具**没传 `registry`** ⇒ 那一行为空 ⇒ firstElementChild 正好是面板。
    //   ⇒ 本夹具必须**按真弹窗那样传 registry**（`buildSourcePanelHtml` 的 opts **与** `AppState.fieldRegistry`，
    //     后者是 `refreshPanel` 重绘时读的那一份）——少任何一处，这条守卫就又变成恒绿的。
    const REGISTRY = { fields: { cfDifficulty: { expect: 'optional', types: ['*'], why: '夹具：让那一行非空' } } };
    const n = seed({ cfDifficulty: [{ v: '2400', src: 'manual', at: 'T2', account: 'k2' },
        { v: '1800', src: 'manual', at: 'T1', account: 'k1' }] });
    // ⚠️ 必须在 `seed()` **之后**设：seed 会把 `AppState` 整个重置成 `createInitialState()`
    //    （先设就被冲掉 ⇒ 重绘时那一行变空 ⇒ 病根不出现 ⇒ 这条守卫又变成恒绿）。
    AppState.fieldRegistry = REGISTRY;
    const host = document.createElement('div');
    const firstHtml = buildSourcePanelHtml(n, 'cfDifficulty', TRUST, { promoteFields: ['cfDifficulty'], registry: REGISTRY });
    ok(/^<div class="src-expect"/.test(firstHtml),
        '★ 夹具前提：面板 HTML 的**第一个元素**是「应有/已有」那一行（真弹窗就是这样 ⇒ `firstElementChild` 必然取错）');
    host.innerHTML = firstHtml;
    document.body.appendChild(host);
    const btn = host.querySelector('[data-src-act="promote"]');
    ok(!!btn, '夹具：面板里真有那颗「转成所有人共用」');
    btn.click(); await tick(30);
    lastDialog().querySelector('.btn-danger').click(); await tick(120);
    // ⚠️ 转完之后只剩 1 条手改 ⇒ 面板走**单来源**分支（`.src-note`），不再有 `.src-details` ——
    //    所以判据按"来源面板元素"合并数（两条分支各只有一个根元素）。
    // 正确的文档形状 = `[应有/已有那一行, 面板]`（两格）；取错元素时变成 `[那一行, 那一行]`（面板整块没了）。
    // ⚠️ 只在**这个夹具容器**里数：DOM 桩的 `document.body.querySelectorAll` 会把**别的用例留在 body 里**
    //    的元素也数进来（上一组的按钮就还在），那不是这块面板的份数。
    eq(host.querySelectorAll('.src-expect').length, 1,
        '★★「应有/已有」那一行只有一份 —— 这就是用户看到的"两份"（取错元素时这里会是 2）');
    eq(host.querySelectorAll('.src-note').length + host.querySelectorAll('.src-details').length, 1,
        '★ 来源面板元素只有 1 个（取错元素时它会被那份说明顶掉 ⇒ 这里 0，优先/不用/真删 全都没了）');
    eq(host.querySelectorAll('[data-src-act="promote"]').length, 0, '★ 转完就不再是"可转"状态');
    host.remove();
}
report('手改值的归属：UI 那一段');
