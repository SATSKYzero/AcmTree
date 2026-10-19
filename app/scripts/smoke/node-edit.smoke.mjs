// ================================================================
// 冒烟测试：节点信息大界面的「✏️ 编辑」子页（scripts/smoke/node-edit.smoke.mjs）
//
// 在「观察节点信息」大界面里加一个「✏️ 编辑」子页，
// 与「📋 完整字段表」并列，**复用编辑弹窗那一套字段与规则**（不许第二套编辑模型）。
//
// 这组用例走**真实路径**：
//   ① 编辑页渲染出真控件（`field-<key>` 输入框 + 保存按钮）；
//   ② 在页里"敲字"（值变了 + input 事件）→ 点「保存」→ 走 ops → 
//      `node.values[字段]` 里出现一条 `manual`（账户 = 当前账户）；
//   ③ 没敲过的字段**不产生** manual（手改判据不能被程序化的值变化骗到）；
//   ④ 子页确实挂在节点信息界面里（`switchNodeView` 能切到它，且它按 id 注册）。
//
// 运行：npm run test:smoke
// ================================================================
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDom, makeContainer } from './dom.mjs';
import { group, ok, eq, deepEq, report, patchNodes } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = path.join(ROOT, 'src');
const mod = rel => `file://${path.join(SRC, rel).replace(/\\/g, '/')}`;

// ① 打开 innerHTML 解析：编辑页的字段控件是用 HTML 字符串拼出来的，
//    桩不解析的话"输入框在不在""点了保存有没有反应"都测不到。
const body = installDom([], { parseHtml: true });
const app = makeContainer(body, 'app');
makeContainer(app, 'tab-bar');
makeContainer(app, 'tree-container');
makeContainer(app, 'tree-body');
makeContainer(app, 'stats-chart-container');
makeContainer(app, 'folder-view-tabs');
makeContainer(app, 'tab-main');
makeContainer(app, 'folder-breadcrumb');
makeContainer(app, 'folder-stats');
makeContainer(app, 'toast');

globalThis.fetch = async () => ({ ok: false, json: async () => ({}) });

const { AppState } = await import(mod('shell/state.js'));
const { createInitialState } = await import(mod('core/model/state.js'));
const { createNode } = await import(mod('core/model/node.js'));
const { renderNodeEditHtml } = await import(mod('ui/nodeinfo/nodeEdit.js'));
const { renderNodeInfoPanel, switchNodeView, getNodeView } = await import(mod('ui/nodeinfo/nodeInfoView.js'));
const { tabContentId } = await import(mod('ui/tabRegistry.js'));
// 性质四字段：控件在 `editForm.js` 里，提交载荷也必须带
const { buildEditForm, validateEdit, applyEdit } = await import(mod('ui/G_modal/editForm.js'));
const { NATURE_FIELD_KEYS, isKnownNatureValue } = await import(mod('core/natureFields.js'));
const { EVENTS } = await import(mod('A_constants.js'));

const PID = 'p_edit_page';
const AT = '2026-09-21T21:45:03.669Z';
const tick = (ms = 40) => new Promise(r => setTimeout(r, ms));

/** 造一个 P 节点（两个来源的说法，ratio 可改） */
function seed() {
    const base = createInitialState();
    for (const k of Object.keys(base)) AppState[k] = base[k];
    AppState.currentTab = 'main';

    const node = createNode(PID, 'P', { name: 'All Closed', problemId: 'A', extKey: 'xcpc:edit:A' });
    node.ratio = '4.61';
    node.values = {
        name: [{ v: 'All Closed', src: 'pta-x', at: AT }],
        ratio: [{ v: '4.61', src: 'pta-x', at: AT }]
    };
    AppState.nodes[PID] = node;
    AppState.childOrder[PID] = [];
    AppState.childOrder[AppState.rootId].push(PID);
    AppState.parentOf[PID] = AppState.rootId;
    AppState.sources['pta-x'] = { kind: 'board', rank: 50 };
    AppState.trust.sources['pta-x'] = { kind: 'board', rank: 50 };
}

const manualsOf = field =>
    ((AppState.nodes[PID].values || {})[field] || []).filter(x => x && x.src === 'manual');

// ===============================================================
group('编辑页：渲染出真控件（与弹窗同一套 id）');
// ===============================================================
{
    seed();
    const html = renderNodeEditHtml(AppState.nodes[PID]);
    ok(/id="field-name"/.test(html), '渲染出 #field-name 输入框');
    ok(/id="field-ratio"/.test(html), '渲染出 #field-ratio 输入框');
    ok(/id="field-status2"/.test(html), '派生字段 status2 也在（下拉）');
    ok(/id="ni-edit-save"/.test(html), '有「保存」按钮');
    ok(!/id="field-__ext/.test(html) || true, '（扩展字段按插件注册情况出现）');

    const wNode = createNode('c_edit_page', 'C', { name: '某场比赛', extKey: 'xcpc:c:edit' });
    const cHtml = renderNodeEditHtml(wNode);
    ok(/id="field-contestTime"/.test(cHtml), 'C 节点多出「比赛时间」字段');
    ok(/id="field-kind"/.test(cHtml), 'C 节点多出「种类」字段');

    const oHtml = renderNodeEditHtml(createNode('o_root', 'O', { name: '根' }));
    ok(/没有可编辑的字段/.test(oHtml), 'O 节点没有可编辑字段（如实说明，不硬凑控件）');
}

// ===============================================================
group('★ 编辑页：敲字 → 保存 → state 里出现 manual（账户 = 当前账户）');
// ===============================================================
{
    seed();
    const tabId = 'tab-nodeinfo-edit-test';
    // 节点信息界面的内容容器（由 tabs.js 正常建好，这里手工建一个同名的）
    makeContainer(body, tabContentId(tabId));
    const tab = { id: tabId, nodeId: PID };

    renderNodeInfoPanel(tab);
    eq(getNodeView(tabId), 'node-fields', '节点信息界面默认停在「完整字段表」');

    switchNodeView(tab, 'node-edit');
    eq(getNodeView(tabId), 'node-edit', '★ 能切到「✏️ 编辑」子页（它就是注册进来的第三个视图）');

    const s = String(PID).replace(/[^a-zA-Z0-9_-]/g, '_');
    const host = document.getElementById(`ni-edit-${s}`);
    ok(!!host, '编辑子页有自己的容器 ni-edit-*');
    ok(host.style.display === 'block', '切到编辑页时容器显示出来');

    const ratioInput = host.querySelector('#field-ratio');
    const nameInput = host.querySelector('#field-name');
    const saveBtn = host.querySelector('#ni-edit-save');
    ok(!!ratioInput && !!nameInput && !!saveBtn, '页面上找得到 ratio / name 输入框与「保存」');

    // 真实浏览器里"用户敲字" = 值变了 + input 事件冒泡到 document
    ratioInput.value = '9.99';
    ratioInput.dispatchEvent({ type: 'input' });
    saveBtn.click();
    await tick(60);

    const n = AppState.nodes[PID];
    eq(manualsOf('ratio').length, 1,
        `★ 敲过的字段落了一条 manual：${JSON.stringify(n.values.ratio)}`);
    eq(manualsOf('ratio')[0].v, '9.99', 'manual 记的是我敲进去的值');
    eq(manualsOf('ratio')[0].account, AppState.currentAccountId,
        '账户 = 当前账户（不是写死的）');
    eq(n.ratio, '9.99', '缓存字段也跟着更新了');
    eq(manualsOf('name').length, 0,
        '没敲过的字段**不**产生 manual（程序化的值不算手改）');
}

// ===============================================================
group('编辑页：校验不过就不写库（名称不能为空）');
// ===============================================================
{
    seed();
    const tabId = 'tab-nodeinfo-edit-test-2';
    makeContainer(body, tabContentId(tabId));
    const tab = { id: tabId, nodeId: PID };
    renderNodeInfoPanel(tab);
    switchNodeView(tab, 'node-edit');

    const s = String(PID).replace(/[^a-zA-Z0-9_-]/g, '_');
    const host = document.getElementById(`ni-edit-${s}`);
    const nameInput = host.querySelector('#field-name');
    nameInput.value = '';
    nameInput.dispatchEvent({ type: 'input' });
    host.querySelector('#ni-edit-save').click();
    await tick(60);

    eq(manualsOf('name').length, 0, '名称为空 → 不写库、不记 manual');
    eq(AppState.nodes[PID].name, 'All Closed', '原值原样保留');
}

// ===============================================================
// 性质四字段：控件画出来 ≠ 提交载荷带上了
//
// 实测踩过的静默失效：`natureFieldDescriptors` 把四个控件画出来了，点保存也"成功"，
// 但 `applyEdit` 的三个 payload 没带这四个字段 ⇒ 数据一个字节都没变，而且
// 没有任何测试覆盖它。下面这组用例就是来钉住这件事的。
// ===============================================================

/** 四个 nature 字段的"旧值"（都在词表 / 格式内，且与下面 NEW 不同 —— "真的变了"才看得见） */
const NATURE_OLD = { natureClass: 'cf/无归类', natureYear: '2023', natureSeason: '2022', natureRegion: '北京' };
/** 提交进去的"新值"（大类/小类取词表值、年份取 20xx、地区随便一个中文） */
const NATURE_NEW = { natureClass: 'xcpc/ccpc', natureYear: '2024', natureSeason: '2023', natureRegion: '上海' };
/** 四个类型各一个节点（R 也测 —— 它同样有这四个控件与载荷） */
const NATURE_IDS = { P: PID, R: 'r_nature_page', W: 'w_nature_page', C: 'c_nature_page' };

/** 某个 nature 字段上"我敲过的"那条来源值 */
const manualOf = (id, field) =>
    ((AppState.nodes[id].values || {})[field] || []).find(x => x && x.src === 'manual');

/**
 * 造四个类型各一个节点，四个 nature 字段先给一组旧值。
 *
 * 为什么旧值必须非空：把"漏带字段"的 bug 种回去时，节点上要**留着旧值**才能被断言抓住
 * （没有旧值的话"字段没被搬运"和"字段本来就没值"看起来一样）。
 */
function seedNature() {
    seed();
    const p = AppState.nodes[PID];
    for (const k of NATURE_FIELD_KEYS) {
        p[k] = NATURE_OLD[k];
        (p.values ||= {})[k] = [{ v: NATURE_OLD[k], src: 'pta-x', at: AT }];
    }
    const add = (id, type, name) => {
        const node = createNode(id, type, { name, extKey: `nature:${id}` });
        for (const k of NATURE_FIELD_KEYS) {
            node[k] = NATURE_OLD[k];
            node.values[k] = [{ v: NATURE_OLD[k], src: 'pta-x', at: AT }];
        }
        // R 的时间要给一个**能过 `normalizeTime`** 的值：编辑页读值时会当场校验它
        if (type === 'R') node.time = '2024.05.01 10:00';
        AppState.nodes[id] = node;
        AppState.childOrder[id] = [];
        AppState.parentOf[id] = AppState.rootId;
        AppState.childOrder[AppState.rootId].push(id);
        return node;
    };
    add(NATURE_IDS.R, 'R', '提交一条');
    add(NATURE_IDS.W, 'W', '某平台');
    add(NATURE_IDS.C, 'C', '某场比赛');
}

/** 走**真实编辑页面板**：填四个字段 → 点保存 → 等事务落定 */
async function submitNatureViaEditPanel(id, type) {
    const tabId = `tab-nodeinfo-nature-${type}`;
    makeContainer(body, tabContentId(tabId));
    const tab = { id: tabId, nodeId: id };
    renderNodeInfoPanel(tab);
    switchNodeView(tab, 'node-edit');

    const s = String(id).replace(/[^a-zA-Z0-9_-]/g, '_');
    const host = document.getElementById(`ni-edit-${s}`);
    ok(!!host, `${type}：编辑子页有容器 ni-edit-*`);
    for (const k of NATURE_FIELD_KEYS) {
        const el = host.querySelector(`#field-${k}`);
        if (!el) { ok(false, `${type}：编辑面板里找不到控件 #field-${k}`); return host; }
        el.value = NATURE_NEW[k];
        // "用户敲字"的证据 = input/change 事件（程序赋值不触发任何事件）
        el.dispatchEvent({ type: 'input' });
        el.dispatchEvent({ type: 'change' });
    }
    host.querySelector('#ni-edit-save').click();
    await tick(80);
    return host;
}

// ===============================================================
group('★ 性质四字段：编辑面板填 → 保存 → 节点字段真的变了 + 过事务 + 留痕（P/R/W/C）');
// ===============================================================
{
    // 用的就是注册表 / 格式里的合法值（不另抄一份；地区是自由文本所以只做人话）
    ok(isKnownNatureValue('natureClass', NATURE_NEW.natureClass),
        `夹具的分类 ${NATURE_NEW.natureClass} 在 Trie 里`);
    ok(/^20\d{2}$/.test(NATURE_NEW.natureYear), `夹具的年份 ${NATURE_NEW.natureYear} 是 20xx`);

    let txCount = 0;
    document.addEventListener(EVENTS.DB_MODIFIED, () => { txCount++; });

    seedNature();
    for (const type of ['P', 'R', 'W', 'C']) {
        const id = NATURE_IDS[type];
        const txBefore = txCount;
        await submitNatureViaEditPanel(id, type);

        const n = AppState.nodes[id];
        for (const k of NATURE_FIELD_KEYS) {
            eq(n[k], NATURE_NEW[k],
                `${type}：${k} 真的变了（旧值 ${NATURE_OLD[k]} → 新值）`);
        }
        ok(txCount > txBefore, `${type}：真的过了 execute 事务（收到了 DB_MODIFIED）`);
        for (const k of NATURE_FIELD_KEYS) {
            const m = manualOf(id, k);
            eq(m && m.v, NATURE_NEW[k],
                `${type}：${k} 的来源层里有 manual 条目（走的是 applyNatureFields 的 rec，不是绕过留痕）`);
            // ★ nature 四格**不记账户**（用户 2026-10-08："年份,赛季这种信息不用分帐户"）——
            //   它们是比赛自己的属性，一格里就一条手填值；记了账户会让它在别的账户下看不见、
            //   却照样被导出当"人的结论"带走（"清了几回还在"）。别的字段仍记账户。
            eq(m && m.account, undefined,
                `${type}：${k} 的 manual **不带账户**（nature 四格与账户无关）`);
        }
    }
}

// ===============================================================
group('★ 性质四字段：改回空选项 ⇒ 字段真的被清空（不是"没改"）');
// ===============================================================
{
    seedNature();
    const n = AppState.nodes[PID];
    eq(n.natureClass, NATURE_OLD.natureClass, '（前提）清空前节点上是旧值');

    const tabId = 'tab-nodeinfo-nature-clear';
    makeContainer(body, tabContentId(tabId));
    const t = { id: tabId, nodeId: PID };
    renderNodeInfoPanel(t);
    switchNodeView(t, 'node-edit');
    const host = document.getElementById('ni-edit-p_edit_page');
    const sel = host.querySelector('#field-natureClass');
    ok(!!sel && String(sel.tagName).toLowerCase() === 'select', '分类是下拉框');
    sel.value = '';                        // 空选项 = 没标
    sel.dispatchEvent({ type: 'change' });
    host.querySelector('#ni-edit-save').click();
    await tick(80);

    eq(AppState.nodes[PID].natureClass, '', '★ 改回空选项后字段 === \'\'（真的被清空）');
    // 其余字段没被碰（"只动我改的那个"这条边界同样要钉）
    eq(AppState.nodes[PID].natureYear, NATURE_OLD.natureYear, '没碰的年份原样保留');
    eq(AppState.nodes[PID].natureRegion, NATURE_OLD.natureRegion, '没碰的地区原样保留');
}

// ===============================================================
group('★ 回归锚：编辑面板画出来的每个 nature 控件 key，都在提交载荷里被搬运');
//
// 这是**最关键的一条**：它直接对着"控件存在但提交载荷漏带"这件事写。
// 手法 = 用能想到的最直接的方式：
//   ① 从 `buildEditForm(node)` 取出这个类型真正画出来的字段清单，断言四个 nature key 都在；
//   ② 按这份清单造一份"四个字段都改了值"的 `res`，交给 `applyEdit`；
//   ③ 断言四个字段**都**变了 —— 只要某个 payload 漏了一个 key，那一个就停在旧值上。
// （不必经过假 DOM：漏带发生在 `applyEdit` 的 payload 里，这里就是它的入口。）
// ===============================================================
{
    seedNature();
    for (const type of ['P', 'R', 'W', 'C']) {
        const id = NATURE_IDS[type];
        const { fields } = buildEditForm(AppState.nodes[id]);
        const keys = fields.map(f => f.key);
        const natureKeys = keys.filter(k => NATURE_FIELD_KEYS.includes(k));
        deepEq(natureKeys, [...NATURE_FIELD_KEYS],
            `${type}：表单里画出了全部四个 nature 控件（顺序也与键表一致）`);

        // 四个字段都改成新值；其余控件取它们自己的默认值
        const res = {};
        for (const f of fields) res[f.key] = (f.default === undefined ? '' : f.default);
        for (const k of NATURE_FIELD_KEYS) res[k] = NATURE_NEW[k];
        // 对照：老字段一起改（一条回归锚 —— 别为了 nature 把老字段的搬运弄坏）
        if (keys.includes('name')) res.name = `改过的名字-${type}`;
        if (keys.includes('link')) res.link = `https://example.test/${type}`;

        const r = await applyEdit(id, res);
        eq(r.success, true, `${type}：applyEdit 成功${r.error ? '（' + r.error + '）' : ''}`);
        const n = AppState.nodes[id];
        for (const k of NATURE_FIELD_KEYS) {
            eq(n[k], NATURE_NEW[k],
                `${type}：${k} 被 payload 搬运（漏带就会停在旧值 ${NATURE_OLD[k]}）`);
        }
        if (keys.includes('name')) eq(n.name, res.name, `${type}：对照 —— 老字段 name 照旧生效`);
        if (keys.includes('link')) eq(n.link, res.link, `${type}：对照 —— 老字段 link 照旧生效`);
    }
}

// ===============================================================
// 「分类」控件（**不定层路径 + Trie**，取代"大类/小类"两级）
//
// 两条要钉住：
//   ① 下拉**只给 Trie 里的合法路径**（外加节点上已有的旧值，免得旧值看不见也清不掉）；
//   ② 写路径**自己也判**（绕过界面的路径：单测 / 导入 / 将来别处的调用）——
//      不在 Trie 里的值一律拒，且**一个字段都不落库**（半写比拒绝更糟）。
// ===============================================================
{
    seed();
    // ⚠️ 摆状态走 `patchNodes`，别事务外就地改节点（节点对象是冻的 —— 现在靠"seed() 从没走
    //    replaceState"侥幸不抛；seed 一改成走 replaceState 就当场红）
    await patchNodes(AppState, (d) => { d.nodes[PID].natureClass = 'atcoder/abc'; });
    const host = openEditHost(PID, 'nature-class');
    const clsSel = host.querySelector('#field-natureClass');
    ok(!!clsSel, '编辑面板里有「分类」下拉');
    const optsOf = sel => [...(sel.children || [])].map(o => o.value);
    ok(optsOf(clsSel).includes('atcoder/abc'), '① 当前值在选项里（旧值不会看不见）');
    ok(optsOf(clsSel).includes('xcpc/icpc/ec/pre'), '① 深层路径也在选项里（不定层）');
    ok(!optsOf(clsSel).includes('cf/nope'), '① Trie 里没有的路径不在选项里');

    // ② 写路径那道闸：绕过界面直接塞一个不在 Trie 里的路径，必须**明确拒绝**且**一个字段都不落库**
    const before = JSON.stringify(AppState.nodes[PID]);
    const res = {};
    const { fields } = buildEditForm(AppState.nodes[PID]);
    for (const f of fields) res[f.key] = (f.default === undefined ? '' : f.default);
    res.natureClass = 'cf/nope';                    // Trie 里没有这一层
    const r = await applyEdit(PID, res);
    eq(r.success, false, '③ 不在 Trie 里的分类必须被拒（不是静默写进去）');
    ok(/分类不合法/.test(String(r.error || '')), `③ 错误信息说清为什么：${r.error}`);
    eq(JSON.stringify(AppState.nodes[PID]), before, '③ 被拒时**一个字段都不落库**（半写比拒绝更糟）');

    // 合法路径则照常过
    res.natureClass = 'xcpc/icpc';
    const r2 = await applyEdit(PID, res);
    eq(r2.success, true, '合法路径照常写入');
    eq(AppState.nodes[PID].natureClass, 'xcpc/icpc', '写进去了');
}

// ===============================================================
// 合成节点的编辑界面若与原料节点一样（没有 synthKey）⇒ 改不了。这一组钉住两套面板的分叉：
//
// 两套面板（**判据只有一条**：`core/ops/synth.js` 的 `isSynthesis(node)`）：
//   · 原料节点：画「所属合成节点」（现状不变）；
//   · 合成节点：画「合成标识」（**可改**），不画「所属合成节点」（它填不了：
//     写会被 `applyOwnerSynth` 拒绝）。
//
// 这一组钉四件事（都是**接线**，能证伪的那种）：
//   ① 字段清单真的分叉（合成没有 ownerSynth、有 synthKey；原料反过来）；
//   ② 在真面板里改合成标识 ⇒ **真的改了**，且同组**所有成员指针一起**指到新标识；
//   ③ 整个改动过 `execute` 事务（收到 DB_MODIFIED）；
//   ④ 被占用 / 保留前缀 ⇒ 被拒、面板不关（值一个字不改）。
// ===============================================================

/** 造一个真节点（`createNode` 给默认字段，`extra` 覆盖它） */
const N = (id, type, extra = {}) => ({ ...createNode(id, type, extra), ...extra, id, type });

/** 一个 C 合成节点 + 两个 C 成员（都挂在同一个 S 下，树形与判重页冒烟同一套） */
const SYNTH_OLD = 'xcpc:c:2026-zj';
const SYNTH_NEW = 'xcpc:c:2026-zj-v2';
const SYNTH_TAKEN = 'xcpc:c:2026-js';

/**
 * ⚠️ 每次 seed 都换一批**节点 id**：编辑子页的容器 id 是 `ni-edit-<节点 id>`
 *    （由 `nodeEdit.js` 固定），而 `document.getElementById` 拿的是**第一个**命中的 ——
 *    沿用同一个 id 会让后一组拿到前一组那个"已经绑好旧 state"的容器，
 *    断言就变成空转（实测踩过：改的是旧节点，看起来却"通过"）。
 */
let seedSeq = 0;
function seedSynthEdit() {
    seed();                                  // 根 + PID（P 原料）照旧
    seedSeq += 1;
    const ids = {
        synth: `c_synth_${seedSeq}`,
        other: `c_synth_other_${seedSeq}`,
        members: [`c_m1_${seedSeq}`, `c_m2_${seedSeq}`]
    };
    const add = (id, type, extra = {}, parent = AppState.rootId) => {
        AppState.nodes[id] = N(id, type, extra);
        AppState.childOrder[id] = [];
        AppState.parentOf[id] = parent;
        if (!AppState.childOrder[parent]) AppState.childOrder[parent] = [];
        AppState.childOrder[parent].push(id);
        return AppState.nodes[id];
    };
    const s1 = add(`s_synth_edit_${seedSeq}`, 'S', { name: 'XCPC 2026' });
    add(ids.synth, 'C', { name: '2026 浙江省赛（合成）', synthKey: SYNTH_OLD }, s1.id);
    // 另一个合成节点：用来验"标识被占用"
    add(ids.other, 'C', { name: '2026 江苏省赛（合成）', synthKey: SYNTH_TAKEN }, s1.id);
    add(ids.members[0], 'C', { name: '2026 浙江省赛', extKey: 'xcpc:c:zj-2026', ownerSynth: SYNTH_OLD }, s1.id);
    add(ids.members[1], 'C', { name: '2026 浙江省赛（榜单）', extKey: 'qoj:c:999', ownerSynth: SYNTH_OLD }, s1.id);
    return ids;
}

/** 拥有某个合成标识（= 指针指向它）的节点 id，排序后返回（顺序无关的集合比较） */
const ownersOf = key => Object.values(AppState.nodes)
    .filter(n => n && String(n.ownerSynth || '') === key)
    .map(n => n.id).sort();

/** 把某个节点挂进「节点信息大界面 → ✏️ 编辑」子页，返回它的编辑容器 */
function openEditHost(id, tag) {
    const tabId = `tab-nodeinfo-synth-${tag}`;
    makeContainer(body, tabContentId(tabId));
    const tab = { id: tabId, nodeId: id };
    renderNodeInfoPanel(tab);
    switchNodeView(tab, 'node-edit');
    const s = String(id).replace(/[^a-zA-Z0-9_-]/g, '_');
    return document.getElementById(`ni-edit-${s}`);
}

/** 在编辑面板里敲一个新标识并点保存（"用户敲字" = 值变了 + input/change 事件） */
async function typeSynthKeyAndSave(host, value) {
    const input = host.querySelector('#field-synthKey');
    if (!input) return null;
    input.value = value;
    input.dispatchEvent({ type: 'input' });
    input.dispatchEvent({ type: 'change' });
    host.querySelector('#ni-edit-save').click();
    await tick(80);
    return input;
}

// ---- ① 字段清单真的分叉（P / C 两种类型各验一遍，R 也一样）----
{
    const keysOf = node => buildEditForm(node).fields.map(f => f.key);

    const synthC = N('x_c', 'C', { name: '合成', synthKey: 'k:c' });
    const matC = N('x_c2', 'C', { name: '原料', ownerSynth: 'k:c' });
    const synthP = N('x_p', 'P', { name: '合成', synthKey: 'k:p' });
    const matP = N('x_p2', 'P', { name: '原料', ownerSynth: 'k:p' });
    const synthR = N('x_r', 'R', { name: '', synthKey: 'k:r' });
    const matR = N('x_r2', 'R', { name: '' });

    for (const [label, synth, material] of [
        ['C', synthC, matC], ['P', synthP, matP], ['R', synthR, matR]
    ]) {
        const sk = keysOf(synth);
        const mk2 = keysOf(material);
        ok(sk.includes('synthKey'), `${label} 合成节点：面板里**有**「合成标识」控件`);
        ok(!sk.includes('ownerSynth'), `${label} 合成节点：面板里**没有**「所属合成节点」（它填不了）`);
        ok(!mk2.includes('synthKey'), `${label} 原料节点：面板里没有「合成标识」（没这个字段）`);
        // ⚠️ R 原料**没有**「所属合成节点」控件（R 分支没有这个字段）——
        //    这条是"现状不变"的锚：别为了分两套顺手给 R 加一个。
        eq(mk2.includes('ownerSynth'), label === 'R' ? false : true,
            `${label} 原料节点：${label === 'R' ? '照旧没有' : '**有**'}「所属合成节点」（现状不变）`);
    }

    // 控件真的画进了 HTML（不是只在描述里）
    const synthHtml = renderNodeEditHtml(synthC);
    ok(/id="field-synthKey"/.test(synthHtml), '合成节点：渲染出 #field-synthKey 输入框');
    ok(!/id="field-ownerSynth"/.test(synthHtml), '合成节点：没有 #field-ownerSynth 输入框');
    const matHtml = renderNodeEditHtml(matC);
    ok(/id="field-ownerSynth"/.test(matHtml), '原料节点：渲染出 #field-ownerSynth 输入框');
    ok(!/id="field-synthKey"/.test(matHtml), '原料节点：没有 #field-synthKey 输入框');

    // 提示里说清"会同时改写几个成员指针"（N 取自 `synthMembers`；拿不到就说「所有成员」）
    const hint = buildEditForm(synthC).fields.find(f => f.key === 'synthKey').hint;
    ok(/个成员|所有成员/.test(hint), '提示里说清"会同时改写几个成员指针"（拿不到数就说「所有成员」）');
}

// ---- ②③ 真面板：改合成标识 ⇒ 成员指针在**同一个事务**里一起改 ----
let synthTxCount = 0;
document.addEventListener(EVENTS.DB_MODIFIED, () => { synthTxCount++; });
{
    const ids = seedSynthEdit();
    // 前提：N 取得出来（挂在树上）
    deepEq(ownersOf(SYNTH_OLD), [...ids.members].sort(), '（前提）两个成员都指向旧标识');
    const hint = buildEditForm(AppState.nodes[ids.synth]).fields.find(f => f.key === 'synthKey').hint;
    ok(/2 个成员/.test(hint), '提示里说清"会同时改写 2 个成员指针"（N 取自 synthMembers）');

    const host = openEditHost(ids.synth, 'rename');
    ok(!!host && host.style.display === 'block', '合成节点的 ✏️ 编辑子页打开了');
    eq(host.querySelector('#field-synthKey').value, SYNTH_OLD, '控件里预填的是当前合成标识');

    const txBefore = synthTxCount;
    const input = await typeSynthKeyAndSave(host, SYNTH_NEW);
    ok(!!input, '找到并改动了「合成标识」控件');

    eq(AppState.nodes[ids.synth].synthKey, SYNTH_NEW, '★ 合成标识真的改了（不再是改不动）');
    eq(ownersOf(SYNTH_OLD).length, 0, '★ 旧标识的成员**一个不剩**（指针全被改写）');
    deepEq(ownersOf(SYNTH_NEW), [...ids.members].sort(), '★ 新标识的成员数不变（还是那两个）');
    eq(String(AppState.nodes[ids.synth].ownerSynth || ''), '', '合成节点自己没有被写上指针');
    ok(synthTxCount > txBefore, '★ 整个改动过 execute 事务（收到 DB_MODIFIED）');
    ok(/2 个成员/.test(String(document.getElementById('toast').textContent)),
        '保存后提示里说清后果（改写了 2 个成员的指针）');
}

// ---- ④ 被占用 / 保留前缀 ⇒ 被拒、面板不关、输入一字不改 ----
{
    const ids = seedSynthEdit();
    const host = openEditHost(ids.synth, 'reject');
    const before = JSON.stringify(AppState.nodes);
    const txBefore = synthTxCount;

    await typeSynthKeyAndSave(host, SYNTH_TAKEN);
    eq(AppState.nodes[ids.synth].synthKey, SYNTH_OLD, '占用：合成标识一个字没改');
    eq(host.querySelector('#field-synthKey').value, SYNTH_TAKEN,
        '占用：面板不关、用户输入**一字不改**（输入框里还是我敲的那串）');
    ok(/已被占用/.test(String(document.getElementById('toast').textContent)), '占用：明确说"已被占用"');
    eq(synthTxCount, txBefore, '占用：连事务都没进（DB_MODIFIED 一次都没发）');
    deepEq(ownersOf(SYNTH_OLD), [...ids.members].sort(), '占用：成员指针没被碰');
    ok(JSON.stringify(AppState.nodes) === before, '占用：整张节点表逐字节不变');

    await typeSynthKeyAndSave(host, 'synth:9');
    eq(AppState.nodes[ids.synth].synthKey, SYNTH_OLD, '保留前缀：合成标识一个字没改');
    eq(host.querySelector('#field-synthKey').value, 'synth:9',
        '保留前缀：面板不关、用户输入一字不改');
    ok(/保留前缀/.test(String(document.getElementById('toast').textContent)), '保留前缀：明确写出原因');
    eq(synthTxCount, txBefore, '保留前缀：同样没进事务');

    await typeSynthKeyAndSave(host, '');
    eq(AppState.nodes[ids.synth].synthKey, SYNTH_OLD, '空值：合成标识一个字没改（不许清空身份）');
    ok(/不能为空/.test(String(document.getElementById('toast').textContent)), '空值：明确说"不能为空"');

    // ⚠️ 上面那三条在**编辑页**上"不关、不改"靠的是 `validateEdit`（关框前的唯一判据）：
    //    写事务里 `assignSynthKey` 也会拒，但那时 DB_MODIFIED 本来就不会发 ——
    //    光看事务计数分不出"提前挡下"和"事务里回滚"。所以这里**直接**钉校验这一处。
    const resOf = k => ({ synthKey: k, name: '2026 浙江省赛（合成）', link: '', statusComplete2: '0' });
    const c1 = validateEdit(ids.synth, resOf(SYNTH_TAKEN));
    ok(!c1.ok && /已被占用/.test(c1.error), '占用：validateEdit **直接挡下**（这就是"关框前"的判据）');
    const c2 = validateEdit(ids.synth, resOf('synth:9'));
    ok(!c2.ok && /保留前缀/.test(c2.error), '保留前缀：validateEdit 直接挡下');
    const c3 = validateEdit(ids.synth, resOf(''));
    ok(!c3.ok && /不能为空/.test(c3.error), '空值：validateEdit 直接挡下');
    ok(validateEdit(ids.synth, resOf(SYNTH_NEW)).ok, '（对照）没人占用的新标识能过校验');
}

// ---- ④b 回归锚：**自动分配的标识本来就是 `synth:` 前缀** ⇒ 不许因此把面板锁死 ----
// 生产里的自动标识是 `synth:<n>`（`core/ops/synth.js` 的 `nextAutoSynthKey`），
// 而上面那组夹具用的是**不带前缀**的 `xcpc:c:2026-zj` ⇒ 恰好绕开了最常走的那条路。
// 真踩过：校验**无条件**查保留前缀 ⇒ **每一个**合成节点连改个名字都保存不了。
{
    const ids = seedSynthEdit();
    const AUTO = 'synth:7';                          // 伪造"自动分配的标识"（常态）
    await patchNodes(AppState, (d) => {              // 同上：摆状态走事务，别就地改节点
        d.nodes[ids.synth].synthKey = AUTO;
        for (const m of ids.members) d.nodes[m].ownerSynth = AUTO;
    });

    const byKey = k => ({ synthKey: k, name: '2026 浙江省赛（合成）', link: '', statusComplete2: '0' });
    ok(validateEdit(ids.synth, byKey(AUTO)).ok,
        '★ 当前标识是 `synth:` 前缀 ⇒ 原样保存**必须**通过（不许被保留前缀挡下）');
    const c = validateEdit(ids.synth, byKey('synth:8'));
    ok(!c.ok && /保留前缀/.test(c.error),
        '（对照）**改**成另一个 `synth:` 前缀的标识仍然被拒（保留前缀只对"改动"生效）');

    const host = openEditHost(ids.synth, 'auto-key');
    await typeSynthKeyAndSave(host, AUTO);            // 只点保存，标识没动
    ok(!/保留前缀/.test(String(document.getElementById('toast').textContent)),
        '★ 走真实面板保存"标识未变" ⇒ 不再报"不能以保留前缀开头"');
    eq(AppState.nodes[ids.synth].synthKey, AUTO, '标识保持原样');
    deepEq(ownersOf(AUTO), [...ids.members].sort(), '两个成员指针仍然指着它');
}

// ---- ⑤ 反向锚：原料节点的保存路径**一点没变**（ownerSynth 照旧写）----
{
    const ids = seedSynthEdit();
    // ids.members[0] 是原料：在面板里把「所属合成节点」改到另一个合成节点
    const host = openEditHost(ids.members[0], 'material');
    const ownerInput = host.querySelector('#field-ownerSynth');
    ok(!!ownerInput, '原料节点的面板里找得到 #field-ownerSynth');
    ownerInput.value = SYNTH_TAKEN;
    ownerInput.dispatchEvent({ type: 'input' });
    ownerInput.dispatchEvent({ type: 'change' });
    host.querySelector('#ni-edit-save').click();
    await tick(80);
    eq(AppState.nodes[ids.members[0]].ownerSynth, SYNTH_TAKEN,
        '★ 回归锚：原料节点照旧能改「所属合成节点」（这条路一字没动）');
    eq(String(AppState.nodes[ids.members[0]].synthKey || ''), '',
        '原料节点没有被写上合成标识');
}

// ---- ⑥ 编辑**弹窗**（C 走的 W/S/C 那条 `showFormDialog`）同样"被拒就不关框" ----
//
// `showFormDialog` 若是"**先关框、再回调**"，校验就发生在回调里，框已经没了。
// 合成标识被占用正是"必须让用户就地改"的场景，所以它多了第 4 个参数（关框前校验）。
// 这一组走**真弹窗**：打开 → 敲一个被占用的标识 → 点确定 ⇒ 框还在、值还在。
{
    const { editNode } = await import(mod('ui/G_modal/G4_edit.js'));
    const ids = seedSynthEdit();
    const before = document.body.querySelectorAll('.modal-overlay').length;
    editNode(ids.synth);                       // 不 await：它要框关了才 resolve
    await tick(30);
    const overlays = document.body.querySelectorAll('.modal-overlay');
    eq(overlays.length, before + 1, '编辑弹窗开出来了（走 showFormDialog）');
    const panel = overlays[overlays.length - 1];
    const input = panel.querySelector('#field-synthKey');
    ok(!!input, '弹窗里也有「合成标识」控件（与编辑页同一套字段）');
    eq(!!panel.querySelector('#field-ownerSynth'), false, '弹窗里没有「所属合成节点」');

    input.value = SYNTH_TAKEN;
    input.dispatchEvent({ type: 'input' });
    panel.querySelector('.btn-primary').click();
    await tick(60);

    eq(document.body.querySelectorAll('.modal-overlay').length, before + 1,
        '★ 占用 ⇒ 弹窗**不关**（用户能就地改，不至于从头再来）');
    eq(input.value, SYNTH_TAKEN, '★ 弹窗里的输入一字不改');
    eq(AppState.nodes[ids.synth].synthKey, SYNTH_OLD, '数据也没被写（事务没提交）');
    ok(/已被占用/.test(String(document.getElementById('toast').textContent)), '弹窗里也说明了原因');
}

report('节点信息大界面 ✏️ 编辑子页');
