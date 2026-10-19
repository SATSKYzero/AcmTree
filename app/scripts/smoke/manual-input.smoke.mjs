// ================================================================
// 冒烟测试：编辑弹窗里的"手改"判据（scripts/smoke/manual-input.smoke.mjs）
//
// 钉住这条 bug：
//   在 P 节点编辑弹窗里点来源面板的「优先」—— 缓存值当场更新（这部分是对的），
//   但 `node.values` 里仍然产生/顶替出一条 `manual`。
//   而 `manual` 在投影里优先级最高（core/trust.js 的 categoryRank），
//   一条假的手改会让用户的来源偏好**永远失效**。
//
// 根因（修复前）：`manualInputFields()` 用的是**反向**判据 ——
//   "输入框没有 `data-src-driven` 标记就算手改"。于是：
//     * 用户一个键都没敲，弹窗里所有没被同步过的字段（例：ratio）都算手改；
//     * 点**别的**字段来源行的「优先」，就把 ratio 记成了 manual。
// 修法：改用**正向信号** —— 用户敲键盘才会触发的 `input` 事件
//   （程序 `el.value = x` 不触发任何事件），见 ui/G_modal/manualInput.js。
//
// 这一组特意走**真实弹窗路径**（editNode → 解析出的真实 DOM → 点真实按钮），
// 而不是直接调 `updateP`（那条路走的是 fallback 分支，
// 正是 bug 漏网的原因）。
//
// 运行：npm run test:smoke
// ================================================================
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDom, makeContainer } from './dom.mjs';
import { group, ok, eq, report } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = path.join(ROOT, 'src');
const mod = rel => `file://${path.join(SRC, rel).replace(/\\/g, '/')}`;

// ---------------------------------------------------------------
// 1. DOM 桩：**打开 innerHTML 解析**，让 G4_edit 用 HTML 字符串拼出来的弹窗
//    真的变成元素树 —— 否则 `panel.querySelector('#field-name')` 永远拿不到节点，
//    "真实弹窗路径"在冒烟测试里根本跑不起来。
// ---------------------------------------------------------------
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

// 本用例不 bootstrap 插件，但保留 fetch 桩以免别的路径意外发请求
globalThis.fetch = async () => ({ ok: false, json: async () => ({}) });

// ---------------------------------------------------------------
// 2. 动态 import 被测模块（必须在装好桩之后：manualInput.js 在 import 时
//    就在 document 上注册 input 监听）
// ---------------------------------------------------------------
const { AppState } = await import(mod('shell/state.js'));
const { createInitialState } = await import(mod('core/model/state.js'));
const { createNode } = await import(mod('core/model/node.js'));
const { editNode } = await import(mod('ui/G_modal/G4_edit.js'));
const { explainField, removeManualValue } = await import(mod('core/fieldValue.js'));
const { hasTypedInput, typedFields, beginInputSession } = await import(mod('ui/G_modal/manualInput.js'));
// 视图层读值（清空那一组的判据之一："viewValue 还吐不吐旧值"）
const { viewValue, viewDerived } = await import(mod('view/scope.js'));

const PTA = 'pta-icpc2026preliminary-2';
const SRK = 'srk-icpc2026preliminary-2';
const AT = '2026-09-21T21:45:03.669Z';
const PID = 'p_two_src';

const tick = (ms = 40) => new Promise(r => setTimeout(r, ms));

/** 造一个 P 节点 + 两个来源（pta/srk）；name 与 ratio 各有两个说法 */
function seed() {
    const base = createInitialState();
    for (const k of Object.keys(base)) AppState[k] = base[k];
    AppState.currentTab = 'main';

    const node = createNode(PID, 'P', { name: 'All Closed', problemId: 'A', extKey: 'xcpc:two:A' });
    node.ratio = '4.61';
    node.values = {
        name: [
            { v: 'All Closed', src: PTA, at: AT },
            { v: 'All Closed (SRK)', src: SRK, at: AT }
        ],
        ratio: [
            { v: '4.61', src: PTA, at: AT },
            { v: '4.55', src: SRK, at: AT }
        ]
    };
    AppState.nodes[PID] = node;
    AppState.childOrder[PID] = [];
    AppState.childOrder[AppState.rootId].push(PID);
    AppState.parentOf[PID] = AppState.rootId;

    for (const [id, kind, rank] of [[PTA, 'board', 50], [SRK, 'script', 10]]) {
        AppState.sources[id] = { kind, rank };
        AppState.trust.sources[id] = { kind, rank };
    }
}

/** 打开真实的 P 编辑弹窗；`done` 在事务成功时 resolve */
async function openModal() {
    const done = editNode(PID);
    await tick(30);
    const panel = document.querySelector('.modal-panel');
    return { panel, confirm: panel ? panel.querySelector('.btn-primary') : null, done };
}

/** 当前节点某字段的 manual 来源值 */
const manualsOf = field =>
    ((AppState.nodes[PID].values || {})[field] || []).filter(x => x && x.src === 'manual');

/** 在弹窗里找到"某字段 + 某来源"那一行的动作按钮 */
const findAction = (panel, act, field, src) =>
    panel.querySelectorAll(`[data-src-act="${act}"]`)
        .find(b => b.dataset.field === field && b.dataset.src === src);

// ===============================================================
group('回归：打开弹窗直接点「确定」不该产生任何 manual（用户没敲字）');
// ===============================================================
// 修复前：`manualInputFields()` 把**所有**没被来源动作同步过的控件都算手改，
// 于是"打开弹窗 → 确定"会在 name 与 ratio 上各写一条 manual。
{
    seed();
    const { panel, confirm, done } = await openModal();
    ok(!!panel, '弹窗已打开（真实 DOM）');
    ok(!!confirm, '找到弹窗的「确定」按钮');

    confirm.click();
    const res = await done;
    eq(res.success, true, '确定后事务成功');

    const n = AppState.nodes[PID];
    eq(manualsOf('name').length, 0,
        `没敲字 → name 不该有 manual：${JSON.stringify(n.values.name)}`);
    eq(manualsOf('ratio').length, 0,
        `没敲字 → ratio 不该有 manual：${JSON.stringify(n.values.ratio)}`);
    eq('mode' in AppState.trust, false, '`trust.mode` 设置不存在（没人读它，不许再加）');
}

// ===============================================================
group('★ 回归：点来源面板的「优先」不该把任何字段记成手改');
// ===============================================================
// 用户症状：点某个字段来源行的「优先」→ `ratio` 的 values 里
// 产生/顶替出一条 manual（手动改的是 name 的来源偏好，被误记到 ratio 头上）。
{
    seed();
    const { panel, confirm, done } = await openModal();

    const namePrefer = findAction(panel, 'prefer', 'name', SRK);
    ok(!!namePrefer, '找到 name 字段 srk 那一行的「优先」按钮');

    namePrefer.click();
    await tick(80);

    const after = AppState.nodes[PID];
    eq(after.name, 'All Closed (SRK)', '缓存值当场更新（来源动作本身是对的）');
    const nameInput = panel.querySelector('#field-name');
    eq(nameInput.value, 'All Closed (SRK)',
        '弹窗输入框被程序同步成新值（这个赋值**不**触发 input 事件）');

    confirm.click();
    const res = await done;
    eq(res.success, true, '确定后事务成功');

    const n = AppState.nodes[PID];
    eq(manualsOf('ratio').length, 0,
        `★ ratio 不该被顶替出一条 manual：${JSON.stringify(n.values.ratio)}`);
    eq(manualsOf('name').length, 0,
        `★ 来源动作也不是手改（name 同样不该有 manual）：${JSON.stringify(n.values.name)}`);
    ok(/你指定这个字段优先用 srk/.test(explainField(n, 'name', AppState.trust).reason),
        '偏好仍然生效（没有被假的 manual 顶掉）');
}

// ===============================================================
group('用户真的在输入框敲字 → 才记 manual（且只有一条）');
// ===============================================================
{
    seed();
    const { panel, confirm, done } = await openModal();
    const ratioInput = panel.querySelector('#field-ratio');
    ok(!!ratioInput, '弹窗里有 #field-ratio 输入框');

    // 真实浏览器里"用户敲字"就是：值变了 + input 事件冒泡到 document
    ratioInput.value = '9.99';
    ratioInput.dispatchEvent({ type: 'input' });
    eq(hasTypedInput('ratio'), true, 'input 事件被登记为"用户手动输入"');
    eq(JSON.stringify(typedFields(['name', 'ratio'])), JSON.stringify(['ratio']),
        '候选清单里只有敲过的那个字段');

    confirm.click();
    const res = await done;
    eq(res.success, true, '确定后事务成功');

    const n = AppState.nodes[PID];
    eq(n.ratio, '9.99', '缓存值 = 用户敲进去的值');
    const manuals = manualsOf('ratio');
    eq(manuals.length, 1, `只有一条 manual：${JSON.stringify(n.values.ratio)}`);
    eq(manuals[0].v, '9.99', 'manual 记的就是敲进去的值');
    eq(manualsOf('name').length, 0, '没碰过的 name 依旧不该有 manual');
}

// ===============================================================
group('连续手改只留一条 manual（替换语义没被破坏）');
// ===============================================================
{
    // 接上一组：节点上已有一条 manual('9.99')
    const { panel, confirm, done } = await openModal();
    const ratioInput = panel.querySelector('#field-ratio');
    ratioInput.value = '8.88';
    ratioInput.dispatchEvent({ type: 'input' });
    confirm.click();
    await done;

    const manuals = manualsOf('ratio');
    eq(manuals.length, 1, `连续手改不攒历史：${JSON.stringify(manuals)}`);
    eq(manuals[0].v, '8.88', '留下的是最新那次手改');
    eq(AppState.nodes[PID].ratio, '8.88', '缓存值 = 最新手改值');
}

// ===============================================================
group('混合：用户敲 name + 点 ratio 的来源动作 → 只有敲过的那个算手改');
// ===============================================================
{
    seed();
    const { panel, confirm, done } = await openModal();

    const nameInput = panel.querySelector('#field-name');
    nameInput.value = 'My Custom Name';
    nameInput.dispatchEvent({ type: 'input' });

    const ratioPrefer = findAction(panel, 'prefer', 'ratio', SRK);
    ok(!!ratioPrefer, '找到 ratio 字段 srk 那一行的「优先」按钮');
    ratioPrefer.click();
    await tick(80);

    const ratioInput = panel.querySelector('#field-ratio');
    eq(ratioInput.value, '4.55', 'ratio 输入框被来源动作同步（程序赋值，不算用户输入）');
    eq(hasTypedInput('ratio'), false, '程序同步**不会**把 ratio 记成"用户输入过"');

    confirm.click();
    const res = await done;
    eq(res.success, true, '确定后事务成功');

    const n = AppState.nodes[PID];
    const nameManuals = manualsOf('name');
    eq(nameManuals.length, 1, `敲过的 name 记一条 manual：${JSON.stringify(n.values.name)}`);
    eq(nameManuals[0].v, 'My Custom Name', 'manual 记的是用户敲的值');
    eq(manualsOf('ratio').length, 0,
        `只有来源动作 → ratio 不该有 manual：${JSON.stringify(n.values.ratio)}`);
    eq(n.ratio, '4.55', 'ratio 仍由偏好投影决定');
}

// ===============================================================
group('弹窗会话隔离：上一个弹窗敲过的字段不带进下一个弹窗');
// ===============================================================
{
    seed();
    // 手工模拟"上一个弹窗里用户敲过 name"（不点确定就关掉）
    beginInputSession();
    const stale = document.createElement('input');
    stale.id = 'field-name';
    document.body.appendChild(stale);
    stale.dispatchEvent({ type: 'input' });
    eq(hasTypedInput('name'), true, '前提：上一个会话确实登记了 name');
    stale.remove();

    // 打开新的弹窗（editNode 会 beginInputSession）
    const { panel, confirm, done } = await openModal();
    eq(hasTypedInput('name'), false, '新弹窗打开时会话已清空');

    confirm.click();
    await done;
    eq(manualsOf('name').length, 0,
        `上个会话的输入不该漏进这一次：${JSON.stringify(AppState.nodes[PID].values.name)}`);
    ok(!!panel, '（弹窗流程本身正常）');
}

// ===============================================================
group('R（提交）的手改也走同一套判据（"我敲过它" ∧ "它确实变了"）');
// ===============================================================
// 背景：这条规则覆盖**所有弹窗的所有字段**（"所有字段自然都过这个规则"）——
// 只在 P 弹窗的 name/ratio 上实现不够（updateP 的 opts.manualFields 候选清单只列那两个，
// R 弹窗完全不记来源）。做法：**每个弹窗把自己的字段都列成候选**，
// 由 core/ops/node.js 的 manualRecorder 统一判（派生字段自动排除）。
const RID = 'r_sub';
const ACCOUNT = 'k1';

/** 造 W→S→C→P→R 的合法链，R 上带一条"导入来的"来源值（属于 k1） */
function seedChain() {
    const base = createInitialState();
    for (const k of Object.keys(base)) AppState[k] = base[k];
    AppState.currentTab = 'main';

    const chain = [
        ['w1', 'W', null, {}],
        ['s1', 'S', 'w1', {}],
        ['c1', 'C', 's1', {}],
        ['p1', 'P', 'c1', { name: '题A' }],
        ['r_sub', 'R', 'p1', {}]
    ];
    for (const [id, type, parent, extra] of chain) {
        const node = createNode(id, type, { extKey: `xcpc:chain:${id}`, ...extra });
        AppState.nodes[id] = node;
        AppState.childOrder[id] = [];
        AppState.parentOf[id] = parent || AppState.rootId;
        AppState.childOrder[AppState.parentOf[id]].push(id);
    }
    const r = AppState.nodes[RID];
    r.status = 'AC';
    r.time = '2026.09.13 22:06';
    r.link = 'https://qoj.ac/submission/1';
    r.values = {
        status: [{ v: 'AC', src: 'qoj', at: AT, account: ACCOUNT }],
        time: [{ v: '2026.09.13 22:06', src: 'qoj', at: AT, account: ACCOUNT }],
        link: [{ v: 'https://qoj.ac/submission/1', src: 'qoj', at: AT, account: ACCOUNT }]
    };
    AppState.sources['qoj'] = { kind: 'script', rank: 20 };
    AppState.trust.sources['qoj'] = { kind: 'script', rank: 20 };
    AppState.accounts[ACCOUNT] = {
        id: ACCOUNT, name: '主号', nature: '', children: [], isLocal: false, mappings: []
    };
    AppState.currentAccountId = ACCOUNT;
    AppState.viewingAccountId = ACCOUNT;
}

/** 打开真实的 R 编辑弹窗 */
async function openRModal() {
    const done = editNode(RID);
    await tick(30);
    const panel = document.querySelector('.modal-panel');
    return { panel, confirm: panel ? panel.querySelector('.btn-primary') : null, done };
}

/** R 上某字段的 manual 来源值 */
const rManuals = field =>
    ((AppState.nodes[RID].values || {})[field] || []).filter(x => x && x.src === 'manual' && x.v !== undefined);

/**
 * 在 `<select>` 里"选"一项。
 *
 * ⚠️ 不能直接 `select.value = 'WA'`：DOM 桩里 `<select>` 的 `value` 是**算**出来的
 * （选中项的值），与真实浏览器一致 —— 直接赋 `value` 不改变选中项，读了还是旧值。
 */
function pickOption(selectEl, value) {
    for (const o of selectEl.querySelectorAll('option')) {
        o._selected = (o._value === value);
    }
    selectEl.dispatchEvent({ type: 'input' });
}

{
    seedChain();
    const { panel, confirm, done } = await openRModal();
    ok(!!panel, 'R 弹窗打开了');
    const statusInput = panel.querySelector('#field-status');
    const linkInput = panel.querySelector('#field-link');
    ok(!!statusInput && !!linkInput, '弹窗里有 #field-status / #field-link');

    // ① 只点确定（没敲字）→ 一个 manual 都不该有
    confirm.click();
    eq((await done).success, true, '确定后事务成功');
    eq(rManuals('status').length, 0, '没敲字 → status 不该有 manual');
    eq(rManuals('time').length, 0, '没敲字 → time 不该有 manual');
    eq(rManuals('link').length, 0, '没敲字 → link 不该有 manual');
    eq(AppState.nodes[RID].values.status.length, 1, '导入来的那条来源值还在');
}

{
    // ② 敲 status（值变了 + input 事件）→ 记一条 manual，带**登录账户**
    const { panel, confirm, done } = await openRModal();
    const statusInput = panel.querySelector('#field-status');
    pickOption(statusInput, 'WA');
    eq(hasTypedInput('status'), true, '选择/输入被登记成"用户手动输入"');
    confirm.click();
    eq((await done).success, true, '确定后事务成功');

    const n = AppState.nodes[RID];
    eq(n.status, 'WA', '缓存值 = 用户选的');
    const manuals = rManuals('status');
    eq(manuals.length, 1, `只有一条 manual：${JSON.stringify(n.values.status)}`);
    eq(manuals[0].v, 'WA', 'manual 记的是敲进去的值');
    eq(manuals[0].account, ACCOUNT, '手改归当前登录账户（不是"客观"）');
    eq(n.values.status.length, 2, '导入来的那条**没被顶掉**（两条并存，manual 优先级更高）');
}

{
    // ③ 程序改值（不派发事件）→ 不算手改
    const { panel, confirm, done } = await openRModal();
    const linkInput = panel.querySelector('#field-link');
    linkInput.value = 'https://qoj.ac/submission/999';   // 程序赋值：不触发任何事件
    eq(hasTypedInput('link'), false, '程序赋值不会被登记成"用户输入过"');
    confirm.click();
    eq((await done).success, true, '确定后事务成功');
    eq(AppState.nodes[RID].link, 'https://qoj.ac/submission/999', '值确实写进去了');
    eq(rManuals('link').length, 0, '但**不算手改**（没敲过）');
}

{
    // ④ 只读：在查看别人的账户时，改提交同样被拒（抛 → 事务回滚）
    AppState.viewingAccountId = 'local';                  // ≠ 登录账户 k1
    const { panel, confirm, done } = await openRModal();
    pickOption(panel.querySelector('#field-status'), 'TLE');
    confirm.click();
    const res = await done;
    eq(res.success, false, '只读时被拒');
    ok(/只读|正在查看/.test(res.error || ''), `错误信息说清原因：${res.error}`);
    eq(AppState.nodes[RID].status, 'WA', '值没被改动（事务回滚）');
    AppState.viewingAccountId = ACCOUNT;
}

// ===============================================================
group('手改链接**不带类别**（这条路径不再加特判）');
// ===============================================================
// 口径：①"手改…先只做只存单条的版本，以后再说"；
// ②"对于链接，我们先完全不管手改是否功能足够，这不属于『供导入数据处理』的部分"；
// ③"数据处理的逻辑中一个特判都没有" —— 所以这里**没有**"C 的 link 补个类别"那种
// 按类型/字段分头处理的写法。手改值落在「🔗 链接」组，如实呈现。
{
    const base = createInitialState();
    for (const k of Object.keys(base)) AppState[k] = base[k];
    AppState.currentTab = 'main';

    const CID = 'c_links';
    const c = createNode(CID, 'C', { name: '成都站', extKey: 'xcpc:chengdu' });
    c.link = 'https://qoj.ac/contest/2567';
    c.values = {
        link: [
            { v: 'https://qoj.ac/contest/2567', src: 'qoj-chengdu', at: AT, linkKind: 'problems' },
            { v: 'https://board.xcpcio.com/icpc/50th/chengdu', src: 'xcpcio-chengdu', at: AT, linkKind: 'board' }
        ]
    };
    AppState.nodes[CID] = c;
    AppState.childOrder[CID] = [];
    AppState.childOrder[AppState.rootId].push(CID);
    AppState.parentOf[CID] = AppState.rootId;
    AppState.sources['qoj-chengdu'] = { kind: 'script', rank: 20 };
    AppState.trust.sources['qoj-chengdu'] = { kind: 'script', rank: 20 };

    const done = editNode(CID);
    await tick(30);
    const panel = document.querySelector('.modal-panel');
    const linkInput = panel.querySelector('#field-link');
    ok(!!linkInput, '弹窗里有链接输入框（#field-link）');
    // 榜单链接不再单独有输入框（它只是 `link` 里的一个类别）
    eq(panel.querySelector('#field-boardLink'), null, '榜单链接不再是独立字段');

    linkInput.value = 'https://codeforces.com/gym/106589';
    linkInput.dispatchEvent({ type: 'input' });
    panel.querySelector('.btn-primary').click();
    const res = await done;
    eq(res.success, true, `确定后事务成功：${res.error || ''}`);

    // ⚠️ 事务走 immer：**必须从 AppState 重新取节点**，手里那个旧引用是上一版对象
    const after = AppState.nodes[CID];
    const manual = (after.values.link || []).find(x => x && x.src === 'manual');
    eq(manual && manual.v, 'https://codeforces.com/gym/106589', '手改值进了来源层');
    eq(manual && manual.linkKind, undefined, '手改值**不带类别**（这条路径不加特判）');
}

// ===============================================================
// 手改**清空**（"手动填过的字段清不掉"）
//
// 症状：把值改回空 ⇒ 保存"成功"、一个字节没变；重开编辑框又显示旧值。
// 根因：`addSourceValue` 对空值是"不记"（fieldValue.js 的 `isEmptyFieldValue` 早返回），
//   于是"改回空"等于**什么都没做** —— 已存在的那条 `manual` 源值留在 `node.values[字段]` 里，
//   而 `manual` 在投影里优先级最高（trust.js 的 categoryRank）⇒ `viewValue()` 仍旧吐旧值。
// 修法（唯一判据在 core/ops/node.js 的 `recordManualValue`）：`after` 为空
//   ⇒ 改调 `removeManualValue(node, field, draft.currentAccountId)`（**删掉当前账户那条**）；
//   非空 ⇒ 照旧 `addSourceValue`。于是 name/link/ratio/kind/submitKind/四个 nature 等
//   **所有手改字段**一起修好了。
//
// 下面这组就是给这个修法钉钉子。⚠️ 顺序刻意排成：
//   ① 清空的**正向 + 核心**（manual 条目被删 / viewValue 不吐旧值 / 无空值残留）
//   ② 真实编辑弹窗路径（保存后重画，控件里是空的 —— 用户视角的那一条）
//   ③ 只删**当前账户**那条（别的账户那条必须留着）
//   ④ 清一个**本来就没有 manual** 的字段（不抛错、不产生条目、返回 false）
//   ⑤ 回归锚：非空写入照旧（连改两次只留一条）；派生 + pin 字段（status1/status2）没变
// ===============================================================

// ===============================================================
group('★ 手改清空：改回空 ⇒ manual 条目被**删掉**（不是塞空值），viewValue 回落到别的来源');
// ===============================================================
{
    seed();
    // ① 正向：敲一个非空 ratio → 来源层出现 manual，viewValue 返回新值
    let { panel, confirm, done } = await openModal();
    const ratioInput = panel.querySelector('#field-ratio');
    ratioInput.value = '9.99';
    ratioInput.dispatchEvent({ type: 'input' });
    confirm.click();
    eq((await done).success, true, '正向：确定后事务成功');

    let n = AppState.nodes[PID];
    let m = manualsOf('ratio');
    eq(m.length, 1, `正向：来源层出现一条 manual：${JSON.stringify(n.values.ratio)}`);
    eq(m[0].v, '9.99', '正向：manual 记的就是敲进去的值');
    eq(m[0].account, AppState.currentAccountId, '正向：manual 归当前账户');
    eq(viewValue(AppState, n, 'ratio'), '9.99', '正向：viewValue 返回手改值');
    eq(n.ratio, '9.99', '正向：缓存字段 = 手改值');

    // ② 清空（核心）：同一字段改回空
    ({ panel, confirm, done } = await openModal());
    const clearInput = panel.querySelector('#field-ratio');
    eq(clearInput.value, '9.99', '（前提）重开弹窗时控件里是手改值');
    clearInput.value = '';
    clearInput.dispatchEvent({ type: 'input' });
    confirm.click();
    eq((await done).success, true, '清空：确定后事务成功');

    n = AppState.nodes[PID];
    eq(manualsOf('ratio').length, 0,
        `★ 清空后那条 manual 被删掉（不是变成空值条目）：${JSON.stringify(n.values.ratio)}`);
    const rest = (n.values.ratio || []);
    eq(rest.filter(x => x && x.src === 'manual').length, 0,
        '★ values 里不再有 src=manual 的那条');
    eq(rest.filter(x => !String((x && x.v) === undefined ? '' : x.v).trim()).length, 0,
        '★ values 里没有残留空值条目');
    eq(rest.length, 2, `导入来的两条来源值原样还在：${JSON.stringify(n.values.ratio)}`);
    eq(viewValue(AppState, n, 'ratio'), '4.61',
        '★ viewValue 不再返回旧手改值，回落到权威榜单（board）那条');
    ok(!/手改/.test(explainField(n, 'ratio', AppState.trust).reason),
        `★ 出处解释里也不再有"你手改的"：${explainField(n, 'ratio', AppState.trust).reason}`);
    // ★ **缓存跟着投影回落**（撤掉手改 ⇒ 回落到权威榜单那条）。
    //   为什么不能留在空：**读缓存的地方不止视图** —— ③ 性质待补（`natureStatusOf` 读
    //   `node[field]`）、组队/组名的 `groupFacetsOf`、以及一堆 `node.natureX` 都读缓存；
    //   缓存停在空就会出现"字段表说 4.61、③ 说缺"这种**同一格两个答案**
    //   （用户 2026-10-08 实测：清掉重复的手改赛季想让脚本那份说话 ⇒ ③ 里从此写着"缺：赛季"）。
    eq(n.ratio, '4.61', '★ 缓存跟着投影回落（不是留在空）');
    eq(n.ratio, viewValue(AppState, n, 'ratio'), '★ 缓存 = 投影（同一格只有一个答案）');
}

// ===============================================================
group('★ 手改清空：真实编辑弹窗路径 —— 保存后重画，控件里是空的（用户视角）');
// ===============================================================
// 用 `link`：它**没有别的来源**，手改是唯一出处 —— 于是"清空后控件里该是空的"
// 这条断言才能真的对着"控件里又显示旧值"那个症状写。
// （ratio 清空后会回落到别的来源，控件里显示的是**回落值**，那不是 bug。）
{
    seed();
    let { panel, confirm, done } = await openModal();
    const linkInput = panel.querySelector('#field-link');
    ok(!!linkInput, 'P 弹窗里有 #field-link 输入框');
    eq(String(linkInput.value || ''), '', '（前提）link 一开始是空的');

    // 写入：手改一个链接
    linkInput.value = 'https://codeforces.com/gym/106589';
    linkInput.dispatchEvent({ type: 'input' });
    confirm.click();
    eq((await done).success, true, '写入：确定后事务成功');

    let n = AppState.nodes[PID];
    eq(manualsOf('link').length, 1, `写入：link 上有了一条 manual：${JSON.stringify(n.values.link)}`);
    eq(viewValue(AppState, n, 'link'), 'https://codeforces.com/gym/106589',
        '写入：viewValue 返回手改链接');

    // 重开弹窗 = 保存后重画：控件里应该是刚保存的那个值（这一段本来是对的）
    ({ panel, confirm, done } = await openModal());
    eq(panel.querySelector('#field-link').value, 'https://codeforces.com/gym/106589',
        '重画：控件里是刚保存的手改值');

    // ★ 用户视角的那一条：在编辑面板里改回空 → 保存 → 重画 → 控件里是空的
    const blank = panel.querySelector('#field-link');
    blank.value = '';
    blank.dispatchEvent({ type: 'input' });          // 用户把框清空 = 值变了 + input 事件
    confirm.click();
    eq((await done).success, true, '清空：确定后事务成功');

    n = AppState.nodes[PID];
    eq(manualsOf('link').length, 0, '★ 清空后 manual 条目没了');
    eq((n.values.link || []).length, 0,
        `★ values.link 里没有残留空值条目：${JSON.stringify(n.values.link)}`);

    ({ panel, confirm, done } = await openModal());
    eq(String(panel.querySelector('#field-link').value || ''), '',
        '★ 保存后重画，编辑控件里是**空的**（"看着像没清掉"的那个用户视角）');
    confirm.click();
    await done;
}

// ===============================================================
group('★ 手改清空：只删**当前账户**那条 —— 别的账户的手改值必须留着');
// ===============================================================
{
    seed();
    const OTHER = 'k_other';
    AppState.accounts[OTHER] = {
        id: OTHER, name: '队友', nature: '', children: [], isLocal: false, mappings: []
    };
    const n0 = AppState.nodes[PID];
    n0.ratio = '9.99';
    n0.values.ratio = [
        { v: '4.61', src: PTA, at: AT },
        { v: '4.55', src: SRK, at: AT },
        { v: '9.99', src: 'manual', at: AT, account: AppState.currentAccountId },
        { v: '7.77', src: 'manual', at: AT, account: OTHER }
    ];

    const { panel, confirm, done } = await openModal();
    const ratioInput = panel.querySelector('#field-ratio');
    eq(ratioInput.value, '9.99', '（前提）当前账户的手改值优先显示');
    ratioInput.value = '';
    ratioInput.dispatchEvent({ type: 'input' });
    confirm.click();
    eq((await done).success, true, '清空：确定后事务成功');

    const n = AppState.nodes[PID];
    const manuals = manualsOf('ratio');
    eq(manuals.filter(x => x.account === AppState.currentAccountId).length, 0,
        '★ 当前账户那条确实被删了');
    eq(manuals.length, 1,
        `★ 别的账户那条留着（removeManualValue 是带账户的）：${JSON.stringify(n.values.ratio)}`);
    eq(manuals[0].account, OTHER, '★ 留下的正是别的账户那条');
    eq(manuals[0].v, '7.77', '★ 别的账户的值一字未动');
    eq(viewValue(AppState, n, 'ratio'), '4.61', '当前范围里回落到权威榜单那条');

    // 换成"在看那个账户"：它的手改值仍然生效（留下的不是死数据）
    const savedView = AppState.viewingAccountId;
    AppState.viewingAccountId = OTHER;
    eq(viewValue(AppState, n, 'ratio'), '7.77', '★ 切到那个账户，viewValue 给出它自己的手改值');
    AppState.viewingAccountId = savedView;
}

// ===============================================================
group('★ 手改清空：清一个**本来就没有 manual** 的字段 ⇒ 不抛错、不产生条目、返回 false');
// ===============================================================
{
    seed();
    const n0 = AppState.nodes[PID];
    n0.link = 'https://qoj.ac/orig';
    n0.values.link = [{ v: 'https://qoj.ac/orig', src: PTA, at: AT }];

    const { panel, confirm, done } = await openModal();
    const linkInput = panel.querySelector('#field-link');
    eq(linkInput.value, 'https://qoj.ac/orig', '（前提）控件里是导入来的链接');
    linkInput.value = '';                              // 用户把它清空（该字段上并没有 manual）
    linkInput.dispatchEvent({ type: 'input' });
    confirm.click();
    const res = await done;
    eq(res.success, true, `清一个没有 manual 的字段：不抛错${res.error ? '（' + res.error + '）' : ''}`);

    const n = AppState.nodes[PID];
    eq(manualsOf('link').length, 0, '没有凭空产生 manual 条目');
    const list = n.values.link || [];
    eq(list.length, 1, `导入来的那条来源值原样还在：${JSON.stringify(n.values.link)}`);
    eq(list[0].src, PTA, '还是导入来的那条（没被顶替、也没被删）');
    eq(list.filter(x => !String((x && x.v) || '').trim()).length, 0, '没有残留空值条目');
    eq(n.link, '', '缓存字段按 updateP 既有语义清空');

    // "返回 false 语义正常"：直接对 `removeManualValue` 断言（没有条目 ⇒ 不写数据）
    const snapshot = JSON.stringify(n.values.link);
    eq(removeManualValue(n, 'link', AppState.currentAccountId), false,
        'removeManualValue 对"本来就没有 manual"的字段返回 false');
    eq(JSON.stringify(n.values.link), snapshot, '返回 false 时一个字节都没动');
    eq(removeManualValue(n, '没有这个字段', ''), false, '字段压根没有 values 条目时同样返回 false（不抛错）');
}

// ===============================================================
group('回归锚：非空写入照旧（连改两次只留一条；清空后再写也不攒）');
// ===============================================================
{
    seed();
    const setRatio = async (val) => {
        const { panel, confirm, done } = await openModal();
        const el = panel.querySelector('#field-ratio');
        el.value = val;
        el.dispatchEvent({ type: 'input' });
        confirm.click();
        return done;
    };

    await setRatio('9.99');
    await setRatio('8.88');
    let n = AppState.nodes[PID];
    eq(manualsOf('ratio').length, 1, `连改两次非空仍然只留一条：${JSON.stringify(n.values.ratio)}`);
    eq(manualsOf('ratio')[0].v, '8.88', '留下的是最新那次手改');
    eq(viewValue(AppState, n, 'ratio'), '8.88', 'viewValue = 最新手改值');

    // 清空 → 再写非空：删除之后再写不会"攒"出第二条
    await setRatio('');
    eq(manualsOf('ratio').length, 0, '清空后 0 条');
    await setRatio('5.55');
    n = AppState.nodes[PID];
    eq(manualsOf('ratio').length, 1, `清空后再写：仍然只有一条：${JSON.stringify(n.values.ratio)}`);
    eq(manualsOf('ratio')[0].v, '5.55', '值是最新写进去的');
    eq(viewValue(AppState, n, 'ratio'), '5.55', 'viewValue 跟着走');
}

// ===============================================================
group('回归锚：nature 下拉（natureClass）也走同一套清空判据');
// ===============================================================
{
    seed();
    // 先有一条"导入来的"分类：清空后 viewValue 应该回落到它
    const n0 = AppState.nodes[PID];
    n0.natureClass = 'atcoder/abc';
    n0.values.natureClass = [{ v: 'atcoder/abc', src: PTA, at: AT }];

    let { panel, confirm, done } = await openModal();
    const sel = panel.querySelector('#field-natureClass');
    ok(!!sel && String(sel.tagName).toLowerCase() === 'select', 'P 弹窗里有 natureClass 下拉框');
    eq(sel.value, 'atcoder/abc', '（前提）下拉框选中导入来的分类');
    pickOption(sel, 'xcpc/ccpc');
    confirm.click();
    eq((await done).success, true, '写入 natureClass：确定后事务成功');

    let n = AppState.nodes[PID];
    eq(manualsOf('natureClass').length, 1,
        `写入：natureClass 上有一条 manual：${JSON.stringify(n.values.natureClass)}`);
    eq(manualsOf('natureClass')[0].v, 'xcpc/ccpc', 'manual 记的是选中的分类');
    eq(viewValue(AppState, n, 'natureClass'), 'xcpc/ccpc', 'viewValue 返回手改后的分类');

    // 改回空选项
    ({ panel, confirm, done } = await openModal());
    const blank = panel.querySelector('#field-natureClass');
    eq(blank.value, 'xcpc/ccpc', '（前提）重开时下拉框选中手改值');
    pickOption(blank, '');
    confirm.click();
    eq((await done).success, true, '清空 natureClass：确定后事务成功');

    n = AppState.nodes[PID];
    eq(manualsOf('natureClass').length, 0,
        `★ 清空后 manual 条目被删掉：${JSON.stringify(n.values.natureClass)}`);
    eq((n.values.natureClass || []).filter(x => !String((x && x.v) || '').trim()).length, 0,
        '★ 没有残留空值条目');
    eq(viewValue(AppState, n, 'natureClass'), 'atcoder/abc', '★ viewValue 回落到导入来源那条');
    eq(n.natureClass, 'atcoder/abc', '★ 缓存跟着投影回落（不是留在空）');
    eq(n.natureClass, viewValue(AppState, n, 'natureClass'), '★ 缓存 = 投影（否则 ③ 会说"缺分类"、字段表里却有值）');
}

// ===============================================================
group('回归锚：派生 + pin 字段（status1 / status2）走的不是这条路，行为没变');
// ===============================================================
// 它们由 `setDerivedOverride` 管（记/清"覆盖"）—— 清空 ⇒ 撤回覆盖、按范围回落到自动值。
// 这一组断言：加了清空分支之后，派生字段这条路径**一字未变**。
{
    seed();
    const n0 = AppState.nodes[PID];
    const auto1 = Number(viewDerived(AppState, n0, 'status1'));
    const auto2 = Number(viewDerived(AppState, n0, 'status2'));

    // ① status1：pin 上（1 = 我按下的"已处理"）→ 记一条覆盖
    let { panel, confirm, done } = await openModal();
    const s1 = panel.querySelector('#field-status1');
    ok(!!s1, '弹窗里有 #field-status1 下拉框');
    pickOption(s1, '1');
    confirm.click();
    eq((await done).success, true, 'status1 pin：确定后事务成功');
    let n = AppState.nodes[PID];
    eq(n.status1, 1, 'status1 缓存字段 = 1');
    eq(manualsOf('status1').length, 1, `status1 pin 记了一条覆盖：${JSON.stringify(n.values.status1)}`);
    eq(Number(viewDerived(AppState, n, 'status1')), 1, 'status1 派生值 = 覆盖值');

    // ② status1：撤掉 pin（选回自动值）→ 覆盖被撤回
    ({ panel, confirm, done } = await openModal());
    pickOption(panel.querySelector('#field-status1'), String(auto1));
    confirm.click();
    eq((await done).success, true, 'status1 撤 pin：确定后事务成功');
    n = AppState.nodes[PID];
    eq(manualsOf('status1').length, 0, '★ status1 的覆盖条目被撤回（走的仍是 setDerivedOverride）');
    eq((n.values.status1 || []).filter(x => !String((x && x.v) || '').trim()).length, 0,
        '★ status1 没有残留空值条目');
    eq(Number(viewDerived(AppState, n, 'status1')), auto1, '★ status1 回到自动值（行为没变）');

    // ③ status2：pin 5（忽略）→ 记一条覆盖
    ({ panel, confirm, done } = await openModal());
    pickOption(panel.querySelector('#field-status2'), '5');
    confirm.click();
    eq((await done).success, true, 'status2 pin：确定后事务成功');
    n = AppState.nodes[PID];
    eq(n.status2, 5, 'status2 缓存字段 = 5');
    eq(viewDerived(AppState, n, 'status2'), 5, 'status2 派生值 = 忽略（覆盖）');
    eq(manualsOf('status2').length, 1, `status2 pin 记了一条覆盖：${JSON.stringify(n.values.status2)}`);

    // ④ status2：撤掉 pin → 覆盖被撤回，回到自动值
    ({ panel, confirm, done } = await openModal());
    pickOption(panel.querySelector('#field-status2'), String(auto2));
    confirm.click();
    eq((await done).success, true, 'status2 撤 pin：确定后事务成功');
    n = AppState.nodes[PID];
    eq(manualsOf('status2').length, 0, '★ status2 的覆盖条目被撤回（走的仍是 setDerivedOverride）');
    eq((n.values.status2 || []).filter(x => !String((x && x.v) || '').trim()).length, 0,
        '★ status2 没有残留空值条目');
    eq(Number(viewDerived(AppState, n, 'status2')), auto2, '★ status2 回到自动值（行为没变）');
}

report();
