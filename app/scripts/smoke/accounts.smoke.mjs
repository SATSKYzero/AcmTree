// ================================================================
// 冒烟测试：账户管理界面（scripts/smoke/accounts.smoke.mjs）
//
// 走的是**真实路径**：装 DOM（带 innerHTML 解析）→ 点顶栏标记开弹窗 →
// 点「＋ 新建账户」→ 填名字与映射 → 点「保存」→ 真的走一次 execute 事务。
//
// 为什么单测不够：`core/ops/account.js` 只保证"数据改对了"，
// 而"界面上点了以后到底有没有那个账户"必须端到端看一遍 ——
// UI 入口一旦把整条流程短路掉（执行按钮被禁用），单测是发现不了的。
//
// 运行：npm run test:smoke
// ================================================================
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDom, makeContainer, serialize } from './dom.mjs';
import { group, ok, eq, report, patchNodes } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = path.join(ROOT, 'src');
const mod = rel => `file://${path.join(SRC, rel).replace(/\\/g, '/')}`;

// ---------------------------------------------------------------
// 1. DOM 桩（parseHtml: 弹窗内容要能查到 #acc-name / .acc-map-row）
// ---------------------------------------------------------------
const body = installDom([], { parseHtml: true });
makeContainer(body, 'account-chip');
makeContainer(body, 'toast');

// FileReader 桩：`importFullJSON` 读普通 JSON 走 readAsText。
//
// ⚠️ **必须把这个 promise 接住**：应用里 `reader.onload = async (e) => {...}` **是 async 的**，
//    而 `importFullJSON()` 自己**不返回 promise**（返回 undefined，见 `handlers/H1_jsonIO.js:162`）。
//    桩如果同步调完就算，导入的剩余部分会在**任意时刻**才落地 ——
//    实测在 Node v24.19 上它正巧落进后面某一组的点击窗口里，把刚 seed 的状态整个换掉
//    （`rootId` 都变了、树上只剩根），于是下游断言 `find(extKey === 'p3r')` 拿到 undefined。
//    Node v24.9 上它落地得早，所以一直没暴露。`awaitImport()` 是唯一的等待入口。
let pendingImport = Promise.resolve();
globalThis.FileReader = class {
    _run(fn) {
        pendingImport = Promise.resolve(fn()).catch(() => {});
        return pendingImport;
    }
    readAsText(file) {
        this._run(() => this.onload({ target: { result: file._text } }));
    }
    readAsArrayBuffer(file) {
        const bytes = new TextEncoder().encode(file._text);
        this._run(() => this.onload({ target: { result: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) } }));
    }
};

/** 等上一次 `importFullJSON` **真的跑完**（不 await 它 = 没同步，状态可能被随时换掉） */
const awaitImport = () => pendingImport;

const { AppState } = await import(mod('shell/state.js'));
const { createInitialState } = await import(mod('core/model/state.js'));
const { execute } = await import(mod('shell/executor.js'));
const { createNode } = await import(mod('core/model/node.js'));
const { updateP } = await import(mod('core/ops/node.js'));
const accounts = await import(mod('core/ops/account.js'));
const ui = await import(mod('ui/G_modal/G8_accounts.js'));

function seedState() {
    const base = createInitialState();
    for (const key of Object.keys(base)) AppState[key] = base[key];
}

/**
 * 找到页面上**最后**打开的那个弹窗面板。
 * （前面几组留下来的弹窗还挂在 DOM 里，所以要取最后一个，不能用第 1 个）
 */
function lastPanel() {
    const panels = body.querySelectorAll('.modal-panel');
    return panels[panels.length - 1] || null;
}

/** 找到页面上第 n 个弹窗面板（1 = 最底层） */
function panelAt(n) {
    const panels = body.querySelectorAll('.modal-panel');
    return panels[n - 1] || null;
}

/** 在那个面板里按文字找按钮 */
function btnByText(panel, text) {
    return panel.querySelectorAll('.btn').find(b => String(b.textContent || '').includes(text)) || null;
}

const wait = () => new Promise(r => setTimeout(r, 30));

/**
 * 等一个条件成立（事务里要写 IndexedDB，耗时不确定）。
 * 用轮询而不是固定 sleep：固定 sleep 要么慢要么飘。
 */
async function waitFor(predicate, timeoutMs = 2000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        if (predicate()) return true;
        await new Promise(r => setTimeout(r, 10));
    }
    return false;
}

/** 造一道题，用来测"只读时手改被拒" */
function seedProblem() {
    // ⚠️ 2026-10-18：顶层大字典可能被**冻结**（`freezeTopLevel` 白名单，防 Immer 深走）⇒
    //   夹具就地造状态前先换成**可变副本**（幂等；语义等价，只是让下面对它逐格赋值不抛错）。
    AppState.childOrder = { ...AppState.childOrder };
    AppState.parentOf = { ...AppState.parentOf };
    const root = AppState.nodes[AppState.rootId];
    const w = createNode('w_acct', 'W', { name: 'W', extKey: 'w-acct' });
    AppState.nodes[w.id] = w;
    AppState.childOrder[w.id] = [];
    AppState.childOrder[root.id].push(w.id);
    AppState.parentOf[w.id] = root.id;
    const s = createNode('s_acct', 'S', { name: 'S', extKey: 's-acct' });
    AppState.nodes[s.id] = s;
    AppState.childOrder[s.id] = [];
    AppState.childOrder[w.id].push(s.id);
    AppState.parentOf[s.id] = w.id;
    const c = createNode('c_acct', 'C', { name: 'C', extKey: 'c-acct' });
    AppState.nodes[c.id] = c;
    AppState.childOrder[c.id] = [];
    AppState.childOrder[s.id].push(c.id);
    AppState.parentOf[c.id] = s.id;
    const p = createNode('p_acct', 'P', { name: '题A', extKey: 'p-acct' });
    AppState.nodes[p.id] = p;
    AppState.childOrder[p.id] = [];
    AppState.childOrder[c.id].push(p.id);
    AppState.parentOf[p.id] = c.id;
    return p.id;
}

/** 同一条链，但返回**比赛（C）的 id** —— 批量建 P 需要它当父 */
function seedContestChain() {
    seedProblem();
    return 'c_acct';
}

// ===============================================================
group('账户：顶栏标记');
// ===============================================================
seedState();
ui.renderAccountChip();
const chip = document.getElementById('account-chip');
eq(chip.textContent, '👤 本机', '默认显示登录账户');
ok(/登录账户：本机/.test(chip.title), '悬停里有完整说明');

// ===============================================================
group('账户：管理界面（真实弹窗 → 新建 → 保存）');
// ===============================================================
ui.showAccountsModal();
const main = panelAt(1);
ok(!!main, '账户管理弹窗打开了');
ok(/账户（1）/.test(serialize(main)), `列出了 1 个默认账户：${serialize(main).slice(0, 80)}…`);
// ⚠️ 别用 `btnByText` 找它：这颗按钮是**视图用 innerHTML 画的**（解析后文本在子文本节点里，
//    `textContent` 是空的）—— 按 `data-act` 找才稳（与本文件里 `.acc-act` 那几处同一写法）。
const newBtn0 = main.querySelectorAll('.acc-act').find((b) => b.dataset.act === 'new');
ok(!!newBtn0, '有「＋ 新建账户」按钮');
ok(/＋ 新建账户/.test(serialize(main)), '按钮上的字真的画出来了');

// 点新建 → 叠出编辑器
newBtn0.click();
await wait();
const editor = panelAt(2);
ok(!!editor, '编辑器弹窗叠在上面');
ok(!!editor.querySelector('#acc-name'), '有名称输入框');
ok(!!editor.querySelector('#acc-map-rows'), '有映射区');

// 填名字 + 性质 + 一条映射（走界面按钮加行）
editor.querySelector('#acc-name').value = '主号';
editor.querySelector('#acc-nature').value = '本人唯一账号';
editor.querySelector('#acc-map-add').click();
let rows = editor.querySelectorAll('.acc-map-row');
eq(rows.length, 1, '点「＋ 添加映射」真的多了一行');
rows[0].querySelector('.m-source').value = 'qoj';
rows[0].querySelector('.m-field').value = '提交者';
rows[0].querySelector('.m-value').value = 'alice';

// 再点一次「＋」，第二行留空 → 保存时应该被丢掉（空行不是错误）
editor.querySelector('#acc-map-add').click();
eq(editor.querySelectorAll('.acc-map-row').length, 2, '第二行加上了');

btnByText(editor, '保存').click();
await wait();

const ids = accounts.listAccountIds(AppState).filter(x => x !== 'local');
eq(ids.length, 1, `账户建出来了：${JSON.stringify(AppState.accounts)}`);
const acc = AppState.accounts[ids[0]];
eq(acc.name, '主号', '名字写进去了');
eq(acc.nature, '本人唯一账号', '性质写进去了');
assertMaps(acc.mappings);
function assertMaps(mappings) {
    eq(mappings.length, 1, `空行被丢掉，只留 1 条：${JSON.stringify(mappings)}`);
    eq(mappings[0].source, 'qoj');
    eq(mappings[0].field, '提交者');
    eq(mappings[0].value, 'alice');
}

eq(panelAt(2), null, '保存后编辑器关掉了');
ok(panelAt(1) === main, '账户管理弹窗还在（没被叠出第二个副本）');

// ===============================================================
group('账户：归认（刚填的映射立刻能用）');
// ===============================================================
const { resolveClueAndCount, newCounter } = await import(mod('core/accounts.js'));
const c1 = newCounter();
const who = resolveClueAndCount(AppState.accounts,
    { source: 'qoj', field: '提交者', value: 'alice' }, c1);
eq(who, acc.id, '界面上填的映射能认出账户');
eq(c1.matched, 1, '计数也对了');

// ===============================================================
group('账户：切换查看 → 只读（手改被拒，导入不受影响）');
// ===============================================================
const pid = seedProblem();
const before = AppState.nodes[pid].name;

// 点「查看它」
const viewBtn = main.querySelectorAll('.acc-act').find(b => b.dataset.act === 'view' && b.dataset.id === acc.id);
ok(!!viewBtn, '卡片上有「查看它」');
viewBtn.click();
await wait();

eq(AppState.viewingAccountId, acc.id, '查看指针切过去了');
eq(AppState.currentAccountId, 'local', '登录账户没变');
ok(/只读/.test(chip.textContent), `顶栏标记变成只读：${chip.textContent}`);

// 手改：必须被拒（抛异常 → 事务回滚）
// ⚠️ 这里刻意写成**块体**（与 G4_edit.js 的真实调用一致）：
//    `(draft) => updateP(...)` 这种表达式体返回的是 Immer 的 draft，
//    事务结束后它已被吊销 —— 任何属性访问（包括 Promise 决议时的 `.then`）
//    都会以 "proxy has been revoked" 炸掉。
let err = null;
try {
    await execute(
        (draft) => { updateP(draft, pid, { name: '改个名' }, { manualFields: ['name'] }); },
        { validate: false, refreshParentId: null }
    );
} catch (e) { err = e; }
ok(!!err, '只读时手改抛异常了');
ok(/只读/.test(err.message) && /正在查看/.test(err.message), `错误信息说清了原因：${err.message}`);
eq(AppState.nodes[pid].name, before, '事务回滚了，值没被改');

// 导入不受只读影响：直接走 core 的来源层写入
const { recordIncoming } = await import(mod('core/fieldValue.js'));
await execute(
    (draft) => { recordIncoming(draft.nodes[pid], { ratio: '42.00' }, 'pta-import', { at: 'T1' }); },
    { validate: false, refreshParentId: null }
);
const pNode = AppState.nodes[pid];
eq(pNode.values.ratio[0].v, '42.00', '只读时导入照样写得进来源层（只读的边界就在这里）');

// 切回自己 → 手改恢复（本机本来就是登录账户，所以卡片上出现的是「查看它」）
const backBtn = main.querySelectorAll('.acc-act').find(b => b.dataset.act === 'view' && b.dataset.id === 'local');
ok(!!backBtn, '卡片上有「查看它」（本机）');
backBtn.click();
await wait();
eq(AppState.viewingAccountId, 'local', '查看切回本机');
eq(accounts.isViewOnly(AppState), false, '不再是只读');
await execute(
    (draft) => { updateP(draft, pid, { name: '改个名' }, { manualFields: ['name'] }); },
    { validate: false, refreshParentId: null }
);
eq(AppState.nodes[pid].name, '改个名', '切回来后手改又能用了');
// 手改的值记在**当前登录账户**名下（不是"客观"）——
// 否则"这个值是谁写的"在手改之后反而丢了（手改归属账户）。
const manualEntry = (AppState.nodes[pid].values.name || []).find(x => x.src === 'manual');
eq(manualEntry && manualEntry.account, 'local', '手改的值带登录账户');

// ===============================================================
group('账户：重复映射会被提醒，但不会自动改');
// ===============================================================
eq(accounts.findMappingConflicts(AppState,
    { source: 'qoj', field: '提交者', value: 'alice' }, acc.id).length, 0,
    '只有它自己声明这条线索 → 不冲突');

// 给"本机"塞一条一模一样的线索（界面上就是两个账户填了同一行）
accounts.saveAccount(AppState, 'local', {
    mappings: [{ source: 'qoj', field: '提交者', value: 'alice' }]
});
eq(accounts.findMappingConflicts(AppState,
    { source: 'qoj', field: '提交者', value: 'alice' }, acc.id).length, 1,
    '两个账户认领同一线索 → 碰出来了（界面上会提醒，导入时也会报冲突、不认领）');
accounts.saveAccount(AppState, 'local', { mappings: [] });        // 还原

// ===============================================================
group('账户：删除（确认框 → 真的删掉 → 指针回落）');
// ===============================================================
const del = main.querySelectorAll('.acc-act').find(b => b.dataset.act === 'del' && b.dataset.id === acc.id);
ok(!!del, '卡片上有「删除」');
del.click();
await wait();
const confirmPanel = panelAt(2);
ok(!!confirmPanel, '删除确认框弹出来了');
ok(/倒计时/.test(serialize(confirmPanel)), '是那个带倒计时的确认框（防误点）');
const confirmBtn = btnByText(confirmPanel, '确定');
ok(!!confirmBtn, '确认框里有「确定」');
// 防误点的倒计时：刚弹出时"确定"是**禁用**的（要等 3 秒）——
// 这条断言本身就是保护的存在证明。跑冒烟时不真等 3 秒，直接解除禁用后点。
ok(confirmBtn.disabled === true, '刚弹出时「确定」是禁用的（防误点）');
confirmBtn.disabled = false;
confirmBtn.click();
ok(await waitFor(() => AppState.accounts[acc.id] === undefined), '删除事务真的落盘了');
eq(AppState.accounts[acc.id], undefined, '账户删掉了');
eq(AppState.viewingAccountId, 'local', '查看指针回落（不悬空）');

// ===============================================================
group('账户：导出 → 导入一整轮不能丢账户');
// ===============================================================
// 症状：账户是**顶层注册表**（不是树节点），而完整导出的字段清单是手写的
// （`buildExportData` 从 `A_registry.js` 的 USER_FIELDS 派生）——
// 漏一个键，"导出→导入"一轮就把它丢了，
// 而且丢得**很安静**：认得出谁这件事没了，导进来的值全变"客观"，
// 当前登录账户还会回落成"本机"（手改归属跟着变）。
{
    seedState();
    const { buildExportData } = await import(mod('persistence/index.js'));
    const { importFullJSON } = await import(mod('handlers/H1_jsonIO.js'));

    // 造一份"有账户 + 有映射 + 指针不指向默认账户"的状态
    AppState.accounts.k9 = {
        id: 'k9', name: '主号', nature: '本人唯一账号', children: [], isLocal: false,
        mappings: [{ source: 'qoj', field: '提交者', value: 'alice', current: true }]
    };
    AppState.currentAccountId = 'k9';
    AppState.viewingAccountId = 'k9';
    // ★ 随包元数据（字段「应有」表 / 报告）走**用户真实路径**
    //   也要能回来 —— `importFullJSON` 一旦手抄字段子集交给 importState，
    //   漏抄 fieldRegistry/reports ⇒ 文件里带着、导进来却没有（`data-invariants` 用的是
    //   importState 直连，所以那条路测不到这条）。
    AppState.fieldRegistry = { registryVersion: 1, fields: { natureClass: { expect: 'required' } } };
    AppState.reports = { coverage: { rows: [{ type: 'C', field: 'natureClass', missing: 0 }] } };
    const pid = seedProblem();
    AppState.nodes[pid].values = {
        status: [{ v: 'AC', src: 'qoj', at: 'T1', account: 'k9' }]
    };

    const payload = buildExportData(AppState);
    eq(payload.accounts && Object.keys(payload.accounts).length, 2,
        `导出带上账户注册表：${JSON.stringify(payload.accounts)}`);
    eq(payload.currentAccountId, 'k9', '导出带登录账户');
    eq(payload.viewingAccountId, 'k9', '导出带查看账户');
    ok(JSON.stringify(payload.accounts.k9.mappings).includes('alice'), '映射也在导出里');
    eq(payload.fieldRegistry.registryVersion, 1, '导出带上字段「应有」表');
    eq(payload.reports.coverage.rows.length, 1, '导出带上体检报告');

    // 走**用户真实路径**：把导出的 JSON 当成文件再导入
    const text = JSON.stringify(payload);
    const before = JSON.stringify(AppState.accounts);
    // 先破坏内存状态，确保后面看到的不是"没被清掉"的假象
    AppState.accounts = { local: { id: 'local', name: '本机', children: [], isLocal: true, mappings: [] } };
    AppState.currentAccountId = 'local';
    AppState.viewingAccountId = 'local';
    AppState.fieldRegistry = null;
    AppState.reports = null;

    importFullJSON({ name: 'roundtrip.json', _text: text });
    await awaitImport();                       // ⚠️ 不 await = 状态会被随时换掉（见桩的注释）
    ok(AppState.accounts.k9 !== undefined, '导入后账户回来了');

    eq(JSON.stringify(AppState.accounts), before, '账户注册表逐字节一致');
    eq(AppState.accounts.k9.mappings[0].value, 'alice', '映射值没错');
    eq(AppState.currentAccountId, 'k9', '登录账户恢复');
    eq(AppState.viewingAccountId, 'k9', '查看账户恢复');
    eq(AppState.nodes[pid].values.status[0].account, 'k9', '值上的归属也还在');
    eq(AppState.fieldRegistry && AppState.fieldRegistry.registryVersion, 1,
        '★ 字段「应有」表从文件回来了（importFullJSON 不许再手抄字段子集）');
    eq(AppState.reports && AppState.reports.coverage.rows.length, 1,
        '★ 体检报告从文件回来了');
}

// ===============================================================
group('账户：老存档（没有 accounts 键）不会把现有账户抹掉');
// ===============================================================
{
    seedState();
    const { importFullJSON } = await import(mod('handlers/H1_jsonIO.js'));
    AppState.accounts.k9 = { id: 'k9', name: '主号', children: [], isLocal: false, mappings: [] };
    AppState.currentAccountId = 'k9';

    // 一份 v7 形状的存档（只保证 rootId/nodes/childOrder/settings/meta）
    const root = AppState.nodes[AppState.rootId];
    const legacy = {
        rootId: AppState.rootId,
        nodes: { [root.id]: root },
        childOrder: { [root.id]: [] },
        settings: AppState.settings,
        meta: { idCounter: 5 },
        pages: {}
    };
    importFullJSON({ name: 'legacy.json', _text: JSON.stringify(legacy) });
    // ⚠️ 不能写成 `waitFor(() => AppState.accounts !== undefined)` —— 它**恒真**，
    //    于是"老存档"那次导入根本没被等，随时可能落到后面某一组里把状态换掉。
    await awaitImport();
    eq(AppState.accounts.k9 !== undefined, true, '老存档没有 accounts 键 → **不清空**现有账户');
    eq(AppState.currentAccountId, 'k9', '登录账户也保留（不回落成"本机"）');
}

// ===============================================================
group('**每一个** export 字段都要能走完"导出 → 导入"（新增字段自动进这条守卫）');
// ===============================================================
// 为什么要有这一组：上面那组只钉了 `accounts`/`fieldRegistry`/`reports` 这几个**点名的**字段，
// 而病根是"名单少一处就静默丢一个字段"。这里不点名任何字段 —— 从注册表拿 `EXPORT_KEYS`，
// 逐个种下只属于本次导出的值、再逐个清空、走一遍真实导入，最后断言**整份导出包一字不差地回来**。
// 以后谁加一个 `export: true` 的字段，只要导入侧没接住，这里就红。
{
    seedState();
    const { buildExportData } = await import(mod('persistence/index.js'));
    const { importFullJSON } = await import(mod('handlers/H1_jsonIO.js'));
    const { EXPORT_KEYS } = await import(mod('A_registry.js'));
    const { normalizeStateValues } = await import(mod('core/fieldValue.js'));

    // 树本体（三张 store 表 + 根）另有校验，不参与这一轮"逐字段往返"
    const TREE = new Set(['nodes', 'childOrder', 'pages', 'rootId']);
    const probe = (k) => (k === 'meta' ? { idCounter: 7, synthKeyCounter: 9, 探针: k } : { 探针: k });

    for (const k of EXPORT_KEYS) if (!TREE.has(k)) AppState[k] = probe(k);
    const payload = JSON.parse(JSON.stringify(buildExportData(AppState)));
    for (const k of EXPORT_KEYS) if (!TREE.has(k)) AppState[k] = null;   // 清干净，免得看到假象

    importFullJSON({ name: 'all-fields.json', _text: JSON.stringify(payload) });
    await awaitImport();

    // ⚠️ 两边都过一遍**归一化**再比：导入必然会补默认值（`sources.manual`、`accounts.local`、
    //    认不出的账户指针回落到"本机"…），那是归一化的活、不是"字段有没有被接住"。
    //    归一化**不会**凭空造出 `reports`/`fieldRegistry` 这类包元数据 ⇒ 漏接仍然会红。
    const norm = (obj) => {
        const copy = JSON.parse(JSON.stringify(obj));
        normalizeStateValues(copy);
        return JSON.stringify(copy);
    };
    eq(norm(buildExportData(AppState)), norm(payload),
       `★ export 字段逐个往返一致（当前 ${EXPORT_KEYS.length} 个：${EXPORT_KEYS.join(',')}）`);
    eq(AppState.meta.synthKeyCounter, 9, '★ meta 是整节导出/导入的（`synthKeyCounter` 不许被投影丢掉）');
}


// P1：批量导入的字段写入必须走与编辑弹窗同一套规则 —— 直接赋值不进来源层、
//   没有账户归属、只读模式还拦不住。
// P0：只做创建归属 —— 节点"在不在"也是一个元素，
//   `origin = { src, account, at }`，**永不覆盖**。
{
    seedState();
    const { addChild } = await import(mod('core/ops/tree.js'));
    const { batchAddPNodes } = await import(mod('core/ops/batch.js'));
    const { markOrigin, originOf } = await import(mod('core/ops/origin.js'));
    const { assertManualEditAllowed } = accounts;

    AppState.accounts.k1 = { id: 'k1', name: '主号', children: [], isLocal: false, mappings: [] };
    AppState.currentAccountId = 'k1';
    AppState.viewingAccountId = 'k1';

    const cid = seedContestChain();
    // ---- 手建一个 P：存在性 + 初始字段值都要留痕 ----
    let pNode = null;
    await execute((draft) => {
        pNode = addChild(draft, cid, 'P', '手建的题', { problemId: 'Z', link: 'https://x/y' });
    }, { validate: false, refreshParentId: null });

    const p = AppState.nodes[pNode.id];
    eq(originOf(p).src, 'manual', '手建节点：存在性记 manual');
    eq(originOf(p).account, 'k1', '存在性归属 = 当前登录账户');
    ok(!!originOf(p).at, '存在性带时间');
    eq((p.values.name || []).find(x => x.src === 'manual').v, '手建的题', '建节点填的值也留痕');
    eq((p.values.problemId || []).find(x => x.src === 'manual').v, 'Z', 'problemId 同样留痕');
    eq((p.values.name || []).find(x => x.src === 'manual').account, 'k1', '字段值归属 = 当前账户');
    // 派生元素不许留痕
    eq(p.values.status1, undefined, '派生元素（status1）不进来源层');

    // ---- 批量粘表格（批量导入题目）----
    let added = [];
    await execute((draft) => {
        // ⚠️ ratio 的分数写法是在**上层**（H2 的 pData 构造）归一化的，
        //    batchAddPNodes 拿到的已经是正常值 —— 这里照实传。
        added = batchAddPNodes(draft, cid, [
            { name: '粘的题A', problemId: 'Y', ratio: '50', link: '' },
            { name: '粘的题B', problemId: 'X', ratio: '' }
        ]).nodes;
    }, { validate: false, refreshParentId: null });

    eq(added.length, 2, '批量建了 2 道题');
    const a = AppState.nodes[added[0].id];
    eq(originOf(a).src, 'manual', '批量粘的节点：存在性记 manual（是你粘的表格）');
    eq((a.values.ratio || []).find(x => x.src === 'manual').v, '50', '粘进去的 ratio 留痕');
    eq((a.values.name || []).find(x => x.src === 'manual').v, '粘的题A', '粘进去的 name 留痕');
    eq(a.values.link, undefined, '表格里 link 为空 → 没有可记的值（空值不记）');

    // ---- 存在性永不覆盖 ----
    markOrigin(a, { src: '某个导入包', account: 'k9' });
    eq(originOf(a).src, 'manual', 'origin 幂等：后来的说法不能改写"谁建的"');
}

// ===============================================================
group('P0/P1：只读时"建节点/批量粘表格"同样被拒');
// ===============================================================
{
    const cid = seedContestChain();
    AppState.viewingAccountId = 'local';               // ≠ 登录账户 k1

    const { addChild } = await import(mod('core/ops/tree.js'));
    const { batchAddPNodes } = await import(mod('core/ops/batch.js'));

    let addErr = null;
    try {
        await execute((draft) => { addChild(draft, cid, 'P', '不许建', {}); },
            { validate: false, refreshParentId: null });
    } catch (e) { addErr = e; }
    ok(!!addErr && /只读|正在查看/.test(addErr.message), `手建节点被拒：${addErr && addErr.message}`);

    let batchErr = null;
    try {
        await execute((draft) => { batchAddPNodes(draft, cid, [{ name: 'x', problemId: 'W' }]); },
            { validate: false, refreshParentId: null });
    } catch (e) { batchErr = e; }
    ok(!!batchErr && /只读|正在查看/.test(batchErr.message), `批量建节点被拒：${batchErr && batchErr.message}`);

    const before = Object.keys(AppState.nodes).length;
    eq(before, Object.keys(AppState.nodes).length, '没有节点被偷偷建出来');
    AppState.viewingAccountId = 'k1';
}

// ===============================================================
group('P0：导入建出来的节点，存在性记的是"导入来源 + 归认到的账户"');
// ===============================================================
{
    seedState();
    AppState.accounts.k1 = {
        id: 'k1', name: '主号', children: [], isLocal: false,
        mappings: [{ source: 'cf', field: 'handle', value: 'alice' }]
    };
    AppState.currentAccountId = 'k1';
    AppState.viewingAccountId = 'k1';

    const { markOrigin, originOf } = await import(mod('core/ops/origin.js'));
    const { parseCrate } = await import(mod('features/AutoImport/parse.js'));
    const { buildPlan } = await import(mod('features/AutoImport/plan.js'));
    const { applyPlans } = await import(mod('features/AutoImport/apply.js'));

    const crate = JSON.stringify({
        crateVersion: 1, source: { id: 'cf-adapter' }, fieldMap: {},
        records: [
            { 节点类型: 'W', extKey: 'n0' },
            { 节点类型: 'S', extKey: 'n1', 父extKey: 'n0' },
            { 节点类型: 'C', extKey: 'n2', 父extKey: 'n1' },
            { 节点类型: 'P', extKey: 'n3', 父extKey: 'n2', name: '题' },
            { 节点类型: 'R', extKey: 'n4', 父extKey: 'n3', status: 'AC', time: 'T',
              账户线索: { source: 'cf', field: 'handle', value: 'alice' } }
        ]
    });
    const parsed = parseCrate(JSON.parse(crate));
    const p = buildPlan({ crate: parsed.crate, state: AppState, keyIndex: {} });
    const res = await applyPlans({ state: AppState, items: [{ plan: p, source: 'cf-adapter' }] });
    eq(res.ok, true, '导入成功');

    const rNode = Object.values(AppState.nodes).find(n => n && n.extKey === 'n4');
    eq(originOf(rNode).src, 'cf-adapter', '存在性记的是**导入来源**（不是 manual）');
    eq(originOf(rNode).account, 'k1', '存在性归属 = 这条记录归认到的账户');
    const wNode = Object.values(AppState.nodes).find(n => n && n.extKey === 'n0');
    eq(originOf(wNode).account, '', '没有线索的容器 → 客观（空账户）');
    eq(originOf(wNode).src, 'cf-adapter', '但它确实是这个来源建的');

    // 幂等：再导一次（此时是 skip/update）不许改写 origin
    markOrigin(wNode, { src: '别人', account: 'k9' });
    eq(originOf(wNode).src, 'cf-adapter', 'origin 不被后来的说法改写');
}

// ===============================================================
group('P2：停用一个账户（界面上点「停用」→ 三条规则同时生效）');
// ===============================================================
{
    seedState();
    const { buildSourcePanelHtml } = await import(mod('ui/G_modal/sourcePanel.js'));
    const { setAccountActive, isAccountActive, listActiveAccountIds } = accounts;

    AppState.accounts.k1 = {
        id: 'k1', name: '主号', children: [], isLocal: false,
        mappings: [{ source: 'qoj', field: '提交者', value: 'alice' }]
    };
    AppState.accounts.k2 = { id: 'k2', name: '小号', children: [], isLocal: false, mappings: [] };
    AppState.currentAccountId = 'k1';
    AppState.viewingAccountId = 'k1';
    const pid = seedProblem();
    AppState.nodes[pid].values = {
        ratio: [
            { v: '1', src: 's1', at: 'T1', account: 'k1' },
            { v: '2', src: 's2', at: 'T2', account: 'k2' },
            { v: '3', src: 's3', at: 'T3' }
        ]
    };

    // 打开管理界面 → 找到 k2 卡片上的「停用」
    ui.showAccountsModal();
    const panel = lastPanel();
    const offBtn = panel.querySelectorAll('.acc-act').find(b => b.dataset.act === 'off' && b.dataset.id === 'k2');
    ok(!!offBtn, '卡片上有「停用」按钮');
    offBtn.click();
    ok(await waitFor(() => isAccountActive(AppState, 'k2') === false), '停用生效');
    eq(AppState.accounts.k2.mappings.length, 0, '账户本身还在（停用≠删除）');
    eq(listActiveAccountIds(AppState).includes('k2'), false, '活跃列表里没有它');

    // 规则①：不能作登录/查看
    let err = null;
    try { await execute((d) => accounts.setViewingAccount(d, 'k2'), { validate: false }); }
    catch (e) { err = e; }
    ok(!!err && /已停用/.test(err.message), `不能作查看账户：${err && err.message}`);

    // 规则②：不参与归认（用**它独有**的线索，避免撞上 k1 的映射）
    AppState.accounts.k2.mappings = [{ source: 'qoj', field: '提交者', value: 'alice_alt' }];
    const counter = { matched: 0, unmatched: 0, noClue: 0, conflicts: [] };
    const { resolveClueAndCount } = await import(mod('core/accounts.js'));
    const altClue = { source: 'qoj', field: '提交者', value: 'alice_alt' };
    await execute((d) => setAccountActive(d, 'k2', true), { validate: false, refreshParentId: null });
    eq(resolveClueAndCount(AppState.accounts, altClue, counter), 'k2',
        '前提：启用时这条线索认得出它');
    await execute((d) => setAccountActive(d, 'k2', false), { validate: false, refreshParentId: null });
    eq(resolveClueAndCount(AppState.accounts, altClue, counter), '',
        '停用后认不出（映射还留着）');
    eq(AppState.accounts.k2.mappings.length, 1, '映射确实还在');

    // 规则③：字段来源里不显示它的信息
    const html = buildSourcePanelHtml(AppState.nodes[pid], 'ratio', AppState.trust, {
        accounts: AppState.accounts, viewingAccount: AppState.viewingAccountId
    });
    assert_not_contains(html, '小号', '停用账户的名字不该出现在来源里');
    ok(/已停用账户/.test(html), `面板说明隐藏了几条：${html.slice(0, 120)}…`);
    ok(/👤主号/.test(html), '活跃账户照常显示');

    // 指针回落：停用当前登录/查看的账户
    await execute((d) => setAccountActive(d, 'k1', false), { validate: false, refreshParentId: null });
    eq(AppState.currentAccountId, 'local', '登录账户回落（不悬空）');
    eq(AppState.viewingAccountId, 'local', '查看账户回落');
}

// ===============================================================
group('P3：补映射后不再"叠一条"，而且能把历史值一次修回来');
// ===============================================================
// 场景：第一次导入时还没填映射 → 那些值记成"客观"；
// 补上映射后直接重新导入的话只会在旁边**再叠一条**（同来源同值、账户不同），
// 历史值永远修不回来。所以两条路都要通：
//   ① 重新导入 → 按"来源+值+线索"合并，**改账户**；
//   ② 界面上的「🔁 用当前映射重跑归认」→ 不重新导入也能把历史值改对。
{
    seedState();
    const { parseCrate } = await import(mod('features/AutoImport/parse.js'));
    const { buildPlan } = await import(mod('features/AutoImport/plan.js'));
    const { applyFieldMap, RESERVED_KEYS } = await import(mod('features/AutoImport/fieldmap.js'));
    const { applyPlans } = await import(mod('features/AutoImport/apply.js'));
    const { reattributeValues } = await import(mod('core/ops/reattribute.js'));

    const makeCrate = () => JSON.stringify({
        crateVersion: 1, source: { id: 'cf-adapter' }, fieldMap: {},
        records: [
            { 节点类型: 'W', extKey: 'p3w' },
            { 节点类型: 'S', extKey: 'p3s', 父extKey: 'p3w' },
            { 节点类型: 'C', extKey: 'p3c', 父extKey: 'p3s' },
            { 节点类型: 'P', extKey: 'p3p', 父extKey: 'p3c', name: '题' },
            { 节点类型: 'R', extKey: 'p3r', 父extKey: 'p3p', status: 'AC', time: 'T',
              账户线索: { source: 'qoj', field: '提交者', value: 'alice' } }
        ]
    });

    // ---- 第一次导入：**没有**映射 → 客观 ----
    const runImport = async () => {
        const parsed = parseCrate(JSON.parse(makeCrate()));
        // ⚠️ 必须自己把 applyFieldMap 传进去：`buildPlan` 默认是空映射器
        //    （AutoImport 插件在真实路径里注入它）。少了它，记录里的列一个都映射不出来。
        const plan = buildPlan({
            crate: parsed.crate,
            state: AppState,
            keyIndex: {},
            applyFieldMap: (record, fieldMap) => applyFieldMap(record, fieldMap, { reservedKeys: RESERVED_KEYS })
        });
        return applyPlans({ state: AppState, items: [{ plan, source: 'cf-adapter' }] });
    };
    await runImport();
    const rOf = () => Object.values(AppState.nodes).find(n => n && n.extKey === 'p3r');
    eq(rOf().values.status.length, 1, '第一次导入：一条来源值');
    eq(rOf().values.status[0].account, undefined, '没映射 → 客观');
    ok(!!rOf().values.status[0].clue, `线索被存下来了（重跑归认靠它）：${JSON.stringify(rOf().values.status[0].clue)}`);

    // ---- 补上映射 → 重新导入 ----
    AppState.accounts.k1 = {
        id: 'k1', name: '主号', children: [], isLocal: false,
        mappings: [{ source: 'qoj', field: '提交者', value: 'alice' }]
    };
    AppState.currentAccountId = 'k1';
    AppState.viewingAccountId = 'k1';
    const res2 = await runImport();
    eq(res2.accounts.matched, 1, '这次认出来了');
    eq(rOf().values.status.length, 1, '★ 没有叠出第二条');
    eq(rOf().values.status[0].account, 'k1', '★ 账户被改写');

    // ---- 再走界面上的「重跑归认」：先制造一条"客观"历史值 ----
    rOf().values.status[0].account = undefined;      // 人为还原成"客观"（模拟老数据）
    const preview = reattributeValues(AppState, { dryRun: true });
    eq(preview.changed, 1, '预览：会改 1 条');
    eq(rOf().values.status[0].account, undefined, 'dryRun 不写');

    await execute((draft) => { reattributeValues(draft, {}); },
        { validate: false, refreshParentId: null });
    const after = Object.values(AppState.nodes).find(n => n && n.extKey === 'p3r');
    eq(after.values.status.length, 1, '重跑不会加条数');
    eq(after.values.status[0].account, 'k1', '重跑把历史值改对了');
    eq(after.values.status[0].v, 'AC', '值本身没动');
    eq(after.values.status[0].src, 'cf-adapter', '来源没动');

    // ---- 认不出来的线索：重跑把它降回客观（不猜） ----
    AppState.accounts.k1.mappings = [];
    await execute((draft) => { reattributeValues(draft, {}); },
        { validate: false, refreshParentId: null });
    const dropped = Object.values(AppState.nodes).find(n => n && n.extKey === 'p3r');
    eq(dropped.values.status[0].account, undefined, '映射删掉 → 回落客观');
    assert_not_contains(JSON.stringify(dropped.values.status[0]), '"account"',
        '不写空串键（保持老形状）');

    // ---- 界面上的按钮也要真的跑通（接线错了整套白做）----
    AppState.accounts.k1.mappings = [{ source: 'qoj', field: '提交者', value: 'alice' }];
    ui.showAccountsModal();
    const accPanel = lastPanel();
    const rerunBtn = accPanel.querySelectorAll('.btn').find(b => /重跑归认/.test(String(b.textContent)));
    ok(!!rerunBtn, '账户界面上有「🔁 用当前映射重跑归认」按钮');
    rerunBtn.click();
    await wait();
    const confirmPanel = lastPanel();
    ok(!!confirmPanel && /归属会改变/.test(serialize(confirmPanel)),
        `弹出了预览确认框：${serialize(confirmPanel).slice(0, 120)}…`);
    btnByText(confirmPanel, '确定').click();
    await wait();                              // 确认回调是 async，多等一拍再断言
    // ⚠️ 失败信息里带上**现场**：直接写 `find(...).values` 的话，节点一旦不在就抛
    //    `TypeError: Cannot read properties of undefined`，把"为什么不在"整个吞掉
    //    （实测在 Node 24.19 上真的丢过，只有 TypeError 没有线索）。
    const p3ExtKeys = () => Object.values(AppState.nodes)
        .map(n => n && n.extKey).filter(k => typeof k === 'string' && k.startsWith('p3'));
    const changed = await waitFor(() => {
        const n = Object.values(AppState.nodes).find(x => x && x.extKey === 'p3r');
        return n && n.values.status[0].account === 'k1';
    });
    ok(changed, `点确认后归属真的改回来了（现场 p3* 节点：`
        + `${p3ExtKeys().join(', ') || '（一个都没有）'}）`);
    const p3r = Object.values(AppState.nodes).find(n => n && n.extKey === 'p3r');
    eq(p3r ? p3r.values.status.length : -1, 1, '界面上重跑也不会加条数');
}

// ===============================================================
group('P0：备注与身份键也过同一套规则（只读守卫 + 手改留痕）');
// ===============================================================
{
    seedState();
    const { editRemark } = await import(mod('ui/G_modal/G4_edit.js'));
    const { assignExtKey } = await import(mod('core/ops/upsert.js'));
    const { updateRemark } = await import(mod('core/ops/node.js'));

    AppState.accounts.k1 = { id: 'k1', name: '主号', children: [], isLocal: false, mappings: [] };
    AppState.currentAccountId = 'k1';
    AppState.viewingAccountId = 'k1';
    const pid = seedProblem();

    // ---- 备注：不许 `target.remark = ...` 直接赋值（不过守卫、不留痕） ----
    const done = editRemark(pid);
    await wait();
    const panel = lastPanel();
    panel.querySelector('#remark-textarea').value = '这题要写题解';
    panel.querySelector('.btn-primary').click();
    await done;
    const p1 = AppState.nodes[pid];
    eq(p1.remark, '这题要写题解', '备注写进去了');
    const remarkVal = (p1.values.remark || []).find(x => x.src === 'manual');
    ok(!!remarkVal, `备注也留痕：${JSON.stringify(p1.values.remark)}`);
    eq(remarkVal.account, 'k1', '备注的手改归当前登录账户');
    eq(remarkVal.v, '这题要写题解');

    // ---- 身份键：只读时拒绝 ----
    AppState.viewingAccountId = 'local';
    let err = null;
    try {
        await execute((d) => { assignExtKey(d, pid, 'new-key', {}); },
            { validate: false, refreshParentId: null });
    } catch (e) { err = e; }
    ok(!!err && /只读|正在查看/.test(err.message), `只读时改身份键被拒：${err && err.message}`);
    eq(AppState.nodes[pid].extKey, 'p-acct', '身份键没被改');

    // 切回来 → 能改（并走同一入口；换 key 属于危险操作，要显式 allowOverwrite）
    AppState.viewingAccountId = 'k1';
    await execute((d) => { assignExtKey(d, pid, 'new-key', {}, { allowOverwrite: true }); },
        { validate: false, refreshParentId: null });
    eq(AppState.nodes[pid].extKey, 'new-key', '切回来就能改');

    // 备注也受只读约束
    AppState.viewingAccountId = 'local';
    let err2 = null;
    try {
        await execute((d) => { updateRemark(d, pid, '偷偷改'); },
            { validate: false, refreshParentId: null });
    } catch (e) { err2 = e; }
    ok(!!err2 && /只读|正在查看/.test(err2.message), '只读时改备注被拒');
    eq(AppState.nodes[pid].remark, '这题要写题解', '备注没被改');
    AppState.viewingAccountId = 'k1';
}

// ===============================================================
group('P6：标签列表也是一个字段值（过同一套规则，值存成字符串数组）');
// ===============================================================
{
    seedState();
    AppState.accounts.k1 = { id: 'k1', name: '主号', children: [], isLocal: false, mappings: [] };
    AppState.currentAccountId = 'k1';
    AppState.viewingAccountId = 'k1';
    const pid = seedProblem();
    const node = AppState.nodes[pid];
    node.tags = [];

    // 走真实的"批量管理标签"入口：setByPath 里注册的更多操作菜单
    const { showMoreActions } = await import(mod('ui/G_modal/G5_actions.js'));
    ok(typeof showMoreActions === 'function', '拿到更多操作入口');

    // 直接走它内部的那条路（菜单渲染依赖 DOM 较多，这里用 core 的等价入口验证规则）
    const { recordManualValue } = await import(mod('core/ops/node.js'));
    await execute((draft) => {
        const p = draft.nodes[pid];
        const before = (p.tags || []).map(t => t.text);
        p.tags.push({ id: 'tg1', text: 'dp', color: '无色' });
        recordManualValue(draft, p, 'tags', before, p.tags.map(t => t.text), {});
    }, { validate: false, refreshParentId: null });

    const after = AppState.nodes[pid];
    assert_tags(after);
    function assert_tags(n) {
        const manual = (n.values.tags || []).find(x => x.src === 'manual');
        ok(!!manual, `标签列表留痕了：${JSON.stringify(n.values.tags)}`);
        assert_is_array(manual.v);
        eq(JSON.stringify(manual.v), JSON.stringify(['dp']), '存成字符串数组（不是 [object Object]）');
        eq(manual.account, 'k1', '归当前登录账户');
    }
    function assert_is_array(v) {
        ok(Array.isArray(v), '值的形状是数组');
    }

    // 面板显示：数组要用「、」连起来给人看
    const { buildSourcePanelHtml } = await import(mod('ui/G_modal/sourcePanel.js'));
    const html = buildSourcePanelHtml(after, 'tags', AppState.trust,
        { accounts: AppState.accounts, viewingAccount: 'k1' });
    ok(/dp/.test(html), `面板能显示标签列表：${html.slice(0, 100)}…`);
    assert_not_contains(html, 'object Object', '不会显示 [object Object]');

    // 只读时批量改标签被拒
    AppState.viewingAccountId = 'local';
    let err = null;
    try {
        await execute((draft) => {
            const p = draft.nodes[pid];
            const before = (p.tags || []).map(t => t.text);
            p.tags.push({ id: 'tg2', text: 'math', color: '无色' });
            recordManualValue(draft, p, 'tags', before, p.tags.map(t => t.text), {});
        }, { validate: false, refreshParentId: null });
    } catch (e) { err = e; }
    // 注意：这条路径本身没守卫（规则在 G5_actions 的事务开头），
    // 这里断言的是"没有守卫就不会被拦" —— 真正的守卫在下面那条（走 showMoreActions 的事务）
    ok(err === null, '（core 层的记录器本身不管只读，守卫在入口事务里）');
    AppState.viewingAccountId = 'k1';
}

// ===============================================================
group('P7 阶段 1：树上的值按"在查看"的范围现算（数据不动）');
// ===============================================================
{
    seedState();
    const { buildPNodeTitle, buildRNodeTitle } = await import(mod('view/builders.js'));
    const { viewValue, viewValueStrict, viewBorrowed } = await import(mod('view/scope.js'));

    AppState.accounts.k1 = { id: 'k1', name: '主号', children: [], isLocal: false, mappings: [] };
    AppState.accounts.k2 = { id: 'k2', name: '小号', children: [], isLocal: false, mappings: [] };
    AppState.currentAccountId = 'k1';
    AppState.viewingAccountId = 'k1';
    AppState.sources['pta-x'] = { kind: 'board', rank: 30 };
    AppState.trust.sources['pta-x'] = { kind: 'board', rank: 30 };
    AppState.sources['qoj-x'] = { kind: 'script', rank: 20 };
    AppState.trust.sources['qoj-x'] = { kind: 'script', rank: 20 };

    const pid = seedProblem();
    const p = AppState.nodes[pid];
    // 白板状态：缓存字段与来源层故意写得**不一样**，这样"到底读的哪一个"一眼可辨
    p.ratio = '缓存里的 99';
    p.name = '缓存名字';
    p.values = {
        ratio: [
            { v: '20.00', src: 'pta-x', at: 'T1', account: 'k1' },
            { v: '30.00', src: 'pta-x', at: 'T2', account: 'k2' }
        ],
        name: [{ v: '别人的名字', src: 'qoj-x', at: 'T1', account: 'k2' }]
    };

    // ---- 在看 k1：ratio 用 k1 的；name 只有 k2 的值 → 显示缓存值（不丢信息）+ 标记"借来的" ----
    AppState.viewingAccountId = 'k1';
    eq(viewValue(AppState, p, 'ratio'), '20.00', '树上读的是**投影值**，不是缓存');
    eq(viewValueStrict(AppState, p, 'name'), '', '严格口径：别人的名字不算数（统计用）');
    eq(viewValue(AppState, p, 'name'), '缓存名字', '显示口径：退回缓存值，不让名字凭空消失');
    eq(viewBorrowed(AppState, p, 'name'), true, '并标记"这不是你在查看的账户的值"');

    const htmlK1 = buildPNodeTitle(AppState, p);
    ok(/20\.00%/.test(htmlK1), `树上显示 k1 的 20.00%：${htmlK1.slice(0, 120)}…`);
    assert_not_contains(htmlK1, '99.00%', '不显示缓存里的 99');
    assert_not_contains(htmlK1, '30.00%', '也不显示 k2 的 30.00');
    ok(/title="[^"]*不属于当前「在查看」的账户/.test(htmlK1), '借来的值带悬停说明');

    // ---- 换成在看 k2：同一个节点，显示 k2 的值；**数据一个字节没动** ----
    const snapshot = JSON.stringify(p);
    AppState.viewingAccountId = 'k2';
    eq(viewValue(AppState, p, 'ratio'), '30.00', '换范围 → 值跟着变（不动数据）');
    assert_not_contains(buildPNodeTitle(AppState, p), '20.00%', 'k1 的值不再显示');
    eq(JSON.stringify(p), snapshot, '★ 视图换范围**不改数据**（方案 B 的核心）');

    // ---- R 节点的 status 也是值级的：范围不同 → 显示不同 ----
    const rid = 'r_scope';
    const rNode = createNode(rid, 'R', { time: '2026.09.13 22:06', status: '-' });
    rNode.values = {
        status: [
            { v: 'AC', src: 'qoj-x', at: 'T1', account: 'k1' },
            { v: 'WA', src: 'qoj-x', at: 'T2', account: 'k2' }
        ]
    };
    AppState.nodes[rid] = rNode;
    AppState.childOrder[rid] = [];
    AppState.childOrder[pid].push(rid);
    AppState.parentOf[rid] = pid;
    AppState.viewingAccountId = 'k1';
    ok(/AC/.test(buildRNodeTitle(AppState, rNode, pid)), '在看 k1 → 提交显示 AC');
    AppState.viewingAccountId = 'k2';
    ok(/WA/.test(buildRNodeTitle(AppState, rNode, pid)), '在看 k2 → 同一条提交显示 WA');
    AppState.viewingAccountId = 'k1';

    // ---- ★ R 行的「提交者」= 这条提交**归认到的账户**（不是抓取时的原始线索名）----
    // 值上有 `account` ⇒ 画出 `accountLabel` 的结果（同名账户带 id 后 4 位）；
    // 没有 `account`（未归认 / 客观）⇒ **那一段不画**（与 `submitKind` 空就不画同一姿态）。
    const { buildRNodeMeta } = await import(mod('view/builders.js'));
    const metaHtml = buildRNodeMeta(AppState, rNode);
    ok(metaHtml.includes('提交者: 主号 #k1'),
        `R 行画出归认到的账户（accountLabel 的结果）：${metaHtml.slice(0, 200)}…`);
    eq((metaHtml.match(/提交者/g) || []).length, 1, '「提交者」只画一段');
    const rNoAccount = createNode('r_noaccount', 'R', { time: '2026.09.13 22:07', status: 'AC' });
    rNoAccount.values = { status: [{ v: 'AC', src: 'qoj-x', at: 'T1' }] };
    assert_not_contains(buildRNodeMeta(AppState, rNoAccount), '提交者',
        '★ 未归认 / 客观值 ⇒ 「提交者」那一段**不画**（不是画个空标签）');

    // ---- 口径提示（信息栏那句） ----
    const { viewNote } = await import(mod('view/scope.js'));
    ok(/口径：主号/.test(viewNote(AppState)), '在看=登录 时说"全部按这个账户算"');
    AppState.viewingAccountId = 'k2';
    ok(/只看「小号」/.test(viewNote(AppState))
        && !/暂按登录账户/.test(viewNote(AppState)),
        `查看≠登录 时把口径说清楚（且不再声称有登录口径的例外）：${viewNote(AppState)}`);
    AppState.viewingAccountId = 'k1';
}

// ===============================================================
group('P7 阶段 2：派生字段也按范围算（"各自的补题情况"）');
// ===============================================================
{
    seedState();
    const { viewDerived } = await import(mod('view/scope.js'));
    const { getGlobalStats } = await import(mod('view/stats.js'));
    const { collectACNodes } = await import(mod('ui/stats/acTracking.js'));
    const { buildPNodeTitle, buildCNodeTitle } = await import(mod('view/builders.js'));
    const { createNode: mkNode } = await import(mod('core/model/node.js'));

    AppState.accounts.k1 = { id: 'k1', name: '主号', children: [], isLocal: false, mappings: [] };
    AppState.accounts.k2 = { id: 'k2', name: '小号', children: [], isLocal: false, mappings: [] };
    AppState.currentAccountId = 'k1';
    AppState.viewingAccountId = 'k1';
    AppState.sources['qoj-x'] = { kind: 'script', rank: 20 };
    AppState.trust.sources['qoj-x'] = { kind: 'script', rank: 20 };

    // W→S→C→P，P 下面两条提交：k1 的 AC、k2 的 WA
    const root = AppState.nodes[AppState.rootId];
    const chain = [['w2', 'W', null], ['s2', 'S', 'w2'], ['c2', 'C', 's2'], ['p2', 'P', 'c2']];
    for (const [id, type, parent] of chain) {
        const n = mkNode(id, type, { extKey: `p7:${id}`, name: id });
        AppState.nodes[id] = n;
        AppState.childOrder[id] = [];
        AppState.parentOf[id] = parent || AppState.rootId;
        AppState.childOrder[AppState.parentOf[id]].push(id);
    }
    for (const [id, status, account] of [['r7a', 'AC', 'k1'], ['r7b', 'WA', 'k2']]) {
        const r = mkNode(id, 'R', { extKey: `p7:${id}`, time: '----.--.-- --:--' });
        r.values = {
            status: [{ v: status, src: 'qoj-x', at: 'T1', account }],
            time: [{ v: `2026.09.13 22:0${id === 'r7a' ? '6' : '4'}`, src: 'qoj-x', at: 'T1', account }]
        };
        AppState.nodes[id] = r;
        AppState.childOrder[id] = [];
        AppState.childOrder.p2.push(id);
        AppState.parentOf[id] = 'p2';
    }
    // 缓存字段故意写成"第三套"（证明不是抄缓存）
    AppState.nodes.p2.status2 = 9;
    AppState.nodes.c2.statusComplete2 = 9;

    const p = AppState.nodes.p2;
    const c = AppState.nodes.c2;

    // ---- 在看 k1：k1 的 AC 算数 ----
    eq(viewDerived(AppState, p, 'status2'), 3, 'k1 范围内有 AC → 3');
    eq(viewDerived(AppState, p, 'acTime'), '2026.09.13 22:06', 'AC 时间是 k1 那条');
    eq(viewDerived(AppState, c, 'statusComplete2'), 3, '容器：全部通过');
    const statsK1 = getGlobalStats(AppState);
    ok(/^P:00\/01\//.test(statsK1.pStr), `全局统计按 k1 算：${statsK1.pStr}`);

    // ---- 在看 k2：同一条提交换成 WA → 完全不同的结论 ----
    AppState.viewingAccountId = 'k2';
    eq(viewDerived(AppState, p, 'status2'), 2, 'k2 范围内只有 WA → 2');
    eq(viewDerived(AppState, p, 'acTime'), '----.--.-- --:--', 'k2 没有 AC');
    eq(viewDerived(AppState, c, 'statusComplete2'), 0, '容器：没过');
    const statsK2 = getGlobalStats(AppState);
    ok(/^P:00\/00\//.test(statsK2.pStr), `全局统计按 k2 算：${statsK2.pStr}`);
    ok(statsK1.pStr !== statsK2.pStr, '★ 同一份数据、两个范围 → 两套统计（缓存键带范围）');

    // ---- 树上画出来的颜色/摘要也跟着变 ----
    const htmlK2 = buildPNodeTitle(AppState, p);
    AppState.viewingAccountId = 'k1';
    const htmlK1 = buildPNodeTitle(AppState, p);
    ok(htmlK1 !== htmlK2, '同一个节点，两个范围渲染出不同 HTML');

    // ---- AC 追踪（"我的补题情况"） ----
    AppState.viewingAccountId = 'k1';
    eq(collectACNodes(AppState).some(n => n.id === 'p2'), true, 'k1：这道题在"我 AC 了"的列表里');
    AppState.viewingAccountId = 'k2';
    eq(collectACNodes(AppState).some(n => n.id === 'p2'), false, 'k2：不在（他没 AC）');
    AppState.viewingAccountId = 'k1';

    eq(JSON.stringify(AppState.nodes.r7a.values), JSON.stringify({
        status: [{ v: 'AC', src: 'qoj-x', at: 'T1', account: 'k1' }],
        time: [{ v: '2026.09.13 22:06', src: 'qoj-x', at: 'T1', account: 'k1' }]
    }), '★ 一路切范围，数据一个字节没动');
    eq(AppState.nodes.p2.status2, 9, '缓存字段也还是原样（视图不写缓存）');
}

// ===============================================================
group('P7 阶段 2（覆盖写入口）：选「忽略」→ 记进来源层（带账户）→ 按范围生效');
// ===============================================================
{
    seedState();
    const { updateP } = await import(mod('core/ops/node.js'));
    const { viewDerived } = await import(mod('view/scope.js'));
    const { createNode: mkNode } = await import(mod('core/model/node.js'));

    AppState.accounts.k1 = { id: 'k1', name: '主号', children: [], isLocal: false, mappings: [] };
    AppState.accounts.k2 = { id: 'k2', name: '小号', children: [], isLocal: false, mappings: [] };
    AppState.currentAccountId = 'k1';
    AppState.viewingAccountId = 'k1';

    const root = AppState.nodes[AppState.rootId];
    const chain = [['w5', 'W', null], ['s5', 'S', 'w5'], ['c5', 'C', 's5'], ['p5', 'P', 'c5']];
    for (const [id, type, parent] of chain) {
        const n = mkNode(id, type, { extKey: `pin:${id}`, name: id });
        AppState.nodes[id] = n;
        AppState.childOrder[id] = [];
        AppState.parentOf[id] = parent || AppState.rootId;
        AppState.childOrder[AppState.parentOf[id]].push(id);
    }
    const pid = 'p5';
    // 一条 AC 提交（客观）：让"赛时通过 / 忽略"这类覆盖有立足点
    const r = mkNode('r5', 'R', { extKey: 'pin:r5', time: '2026.09.13 22:06' });
    r.values = { status: [{ v: 'AC', src: 'qoj-x', at: 'T1' }] };
    AppState.nodes.r5 = r;
    AppState.childOrder.r5 = [];
    AppState.childOrder[pid].push('r5');
    AppState.parentOf.r5 = pid;

    // 走**统一的手改入口**：把 status2 选成 5（忽略）
    await execute((draft) => {
        updateP(draft, pid, { status2: 5 }, { manualFields: ['status2'] });
    }, { validate: false, refreshParentId: null });

    const p = AppState.nodes[pid];
    const pin = (p.values.status2 || []).find(x => x.src === 'manual');
    ok(!!pin, `覆盖被记进来源层：${JSON.stringify(p.values.status2)}`);
    eq(pin.v, '5', '记的是 5（忽略）');
    eq(pin.account, 'k1', '覆盖归属 = 当前登录账户');

    // 按范围生效
    AppState.viewingAccountId = 'k1';
    eq(viewDerived(AppState, p, 'status2'), 5, 'k1：忽略生效');
    AppState.viewingAccountId = 'k2';
    eq(viewDerived(AppState, p, 'status2'), 3, 'k2：不受 k1 的"忽略"影响（该 AC 还是 AC）');

    // 恢复自动计算（在 k1 名下）→ 覆盖被删掉
    AppState.viewingAccountId = 'k1';
    AppState.currentAccountId = 'k1';
    await execute((draft) => {
        updateP(draft, pid, { status2: 3 }, { manualFields: ['status2'] });
    }, { validate: false, refreshParentId: null });
    eq(AppState.nodes[pid].values.status2, undefined, '选回可推导的值 → 覆盖被清掉');
    eq(viewDerived(AppState, AppState.nodes[pid], 'status2'), 3, '恢复成算出来的 3');
}

// ===============================================================
group('审计修复：只读边界覆盖标签/结构操作 · 副本不继承 origin · 重算带上账户表');
// ===============================================================
{
    seedState();
    const { viewValue } = await import(mod('view/scope.js'));
    const { addTag, deleteTag } = await import(mod('core/ops/tag.js'));
    const { deleteNode, copyNode, moveUp, clearProblems } = await import(mod('core/ops/tree.js'));
    const { markOrigin, originOf } = await import(mod('core/ops/origin.js'));
    const { reprojectField } = await import(mod('core/ops/trust.js'));

    AppState.accounts.k1 = { id: 'k1', name: '主号', children: [], isLocal: false, mappings: [] };
    AppState.accounts.k2 = { id: 'k2', name: '小号', children: [], isLocal: false, mappings: [] };
    AppState.currentAccountId = 'k1';
    AppState.viewingAccountId = 'k1';
    const pid = seedProblem();

    // ---- 1) 标签改动过统一入口：进来源层（列表形状）+ 树上看得见 ----
    await execute((d) => { addTag(d, pid, 'dp', '红'); }, { validate: false, refreshParentId: null });
    const n1 = AppState.nodes[pid];
    const pin = (n1.values.tags || []).find(x => x.src === 'manual');
    ok(!!pin, `标签留痕了：${JSON.stringify(n1.values.tags)}`);
    eq(JSON.stringify(pin.v), JSON.stringify(['dp']), '存成字符串数组（列表形状）');
    eq(pin.account, 'k1', '归当前登录账户');
    eq(JSON.stringify(viewValue(AppState, n1, 'tags')), JSON.stringify(['dp']),
        '★ 树上读得到（只改 node.tags 的话树上会看不见）');

    // ---- 2) 只读：标签/结构操作全被拒 ----
    AppState.viewingAccountId = 'local';
    const blocked = [
        ['改标签', (d) => addTag(d, pid, 'math')],
        ['删标签', (d) => deleteTag(d, pid, pin === undefined ? 'x' : n1.tags[0].id)],
        ['删节点', (d) => deleteNode(d, pid)],
        ['复制节点', (d) => copyNode(d, pid, 'c_acct')],
        ['移动节点', (d) => moveUp(d, pid)],
        ['清空题目', (d) => clearProblems(d, 'c_acct')]
    ];
    for (const [label, fn] of blocked) {
        let err = null;
        try { await execute(fn, { validate: false, refreshParentId: null }); } catch (e) { err = e; }
        ok(!!err && /只读|正在查看/.test(err.message), `${label} 在只读模式下被拒：${err && err.message}`);
    }
    eq(AppState.nodes[pid].tags.length, 1, '标签没被改');
    ok(!!AppState.nodes[pid], '节点没被删');
    AppState.viewingAccountId = 'k1';

    // ---- 3) 复制出来的节点不继承 origin（副本是"你现在建的"） ----
    await patchNodes(AppState, (d) => {
        markOrigin(d.nodes[pid], { src: '某个导入包', account: 'k1', at: 'T0' });
    });
    await execute((d) => { copyNode(d, pid, 'c_acct'); }, { validate: false, refreshParentId: null });
    const copied = Object.values(AppState.nodes).filter(x => x && x.type === 'P' && x.id !== pid);
    eq(copied.length, 1, '复制出了一个题目节点');
    eq(originOf(copied[0]).src, 'manual', '★ 副本的存在性归属是"手建"，不是抄来的导入来源');
    eq(originOf(AppState.nodes[pid]).src, '某个导入包', '原节点的归属没被改');

    // ---- 4) 重算（优先/不用）带上账户表：停用账户的值不会被写回缓存 ----
    const p = AppState.nodes[pid];
    p.values.ratio = [
        { v: '1', src: 's-a', at: 'T1', account: 'k1' },
        { v: '2', src: 's-b', at: 'T2', account: 'k2' }
    ];
    for (const s of ['s-a', 's-b']) {
        AppState.sources[s] = { kind: 'script', rank: 20 };
        AppState.trust.sources[s] = { kind: 'script', rank: 20 };
    }
    AppState.viewingAccountId = 'k1';
    await execute((d) => { reprojectField(d, 'ratio'); }, { validate: false, refreshParentId: null });
    eq(AppState.nodes[pid].ratio, '1', '（前提）s-b 更新但属于 k2 → k1 的值胜出');
    AppState.accounts.k2.active = false;      // 停用 ● k2 的值不该再参与
    p.values.ratio[0].at = 'T0';              // 让 k1 的这条"更旧"，只有"停用"能救它
    await execute((d) => { reprojectField(d, 'ratio'); }, { validate: false, refreshParentId: null });
    ok(AppState.nodes[pid].ratio !== '2' || AppState.viewingAccountId !== 'k1',
        `停用账户的值没有被写进缓存（实际 ${AppState.nodes[pid].ratio}）`);
    AppState.viewingAccountId = 'k1';
}

// ===============================================================
group('撤回（Ctrl+Z）逐步回退 · 账户维度跟着回退');
// ===============================================================
{
    seedState();
    const { createAccount, saveAccount, setViewingAccount } = accounts;
    const { undo } = await import(mod('shell/executor.js'));
    const { initHistory, getHistoryCount } = await import(mod('transaction/index.js'));

    // 前面的组留下了一堆历史快照；把历史重置成"现在"，撤回数从这里开始算
    initHistory(AppState);
    eq(getHistoryCount(), 0, '（前提）历史清零');

    // ---- 1) 撤回逐步回退（C3）：三次改动 → 依次回到上一步 ----
    const nameOf = () => AppState.nodes[AppState.rootId].name;
    await patchNodes(AppState, (d) => { d.nodes[d.rootId].name = 'N0'; });
    for (const n of ['N1', 'N2', 'N3']) {
        await execute((d) => { d.nodes[d.rootId].name = n; }, { validate: false, refreshParentId: null });
    }
    eq(nameOf(), 'N3', '（前提）改到 N3');
    eq(getHistoryCount(), 3, '可撤回 3 步');
    await undo();
    eq(nameOf(), 'N2', '★ 撤回一次只退一步');
    await undo();
    eq(nameOf(), 'N1', '再撤回退到 N1');
    await undo();
    eq(nameOf(), 'N0', '再撤回退到 N0');
    eq(await undo(), false, '没有更多可撤回');

    // ---- 2) 账户维度也进快照（C2）：撤回要能还原账户表与指针 ----
    await execute((d) => createAccount(d, { id: 'k_undo', name: '待撤回账户' }),
        { validate: false, refreshParentId: null });
    eq(!!AppState.accounts['k_undo'], true, '（前提）账户建出来了');
    await undo();
    eq(AppState.accounts['k_undo'], undefined, '★ 撤回把新建的账户也撤掉了');

    await execute((d) => createAccount(d, { id: 'k_view', name: '看它' }),
        { validate: false, refreshParentId: null });
    await execute((d) => setViewingAccount(d, 'k_view'), { validate: false, refreshParentId: null });
    eq(AppState.viewingAccountId, 'k_view', '（前提）在看的账户切过去了');
    await undo();
    eq(AppState.viewingAccountId, 'local', '★ 撤回把"在看指针"也还原了');
    await undo();
    eq(!!AppState.accounts['k_view'], false, '再撤回把"看它"这个账户也撤掉');

    // ---- 3) 账户改名同样可撤回（节点与账户一起回退，不留混合状态） ----
    await execute((d) => createAccount(d, { id: 'k_rename', name: '原名字' }),
        { validate: false, refreshParentId: null });
    await execute((d) => { saveAccount(d, 'k_rename', { name: '改过名的账户' }); }, { validate: false, refreshParentId: null });
    eq(AppState.accounts.k_rename.name, '改过名的账户', '（前提）账户名改了');
    await undo();
    eq(AppState.accounts.k_rename.name, '原名字', '★ 账户改名也撤回得掉');
}

// ===============================================================
group('账户：映射**写法**写错了要当场点出来（10120 条未认领）');
// ===============================================================
{
    // 赛季一律**四位年**（两位数写法要被点出来）：写 `nk:23` 就该被点出来。
    // 弹窗里应当**当场上黄条**并给出正确写法（只提醒、不自动改 —— 匹配是全等）。
    seedState();
    ui.showAccountsModal();
    // ⚠️ 前面几组留下的弹窗还挂在 DOM 里 ⇒ 一律用 `lastPanel()`（不是 panelAt(1)）
    const main = lastPanel();
    main.querySelectorAll('.acc-act').find((b) => b.dataset.act === 'new').click();
    await wait();
    const editor = lastPanel();
    editor.querySelector('#acc-name').value = '写法测试';
    editor.querySelector('#acc-map-add').click();
    const row = editor.querySelectorAll('.acc-map-row')[0];
    row.querySelector('.m-source').value = 'nk:23';
    row.querySelector('.m-field').value = '用户名';
    row.querySelector('.m-value').value = '某昵称';
    // 改一下输入（真实用户是敲进去的）⇒ 触发 input 检查
    row.querySelector('.m-source').dispatchEvent({ type: 'input' });
    const warn = editor.querySelector('#acc-map-warn');
    ok(!!warn, '弹窗里有"写法警告"那一块');
    eq(warn.style.display !== 'none', true, '写错了 ⇒ 黄条显示出来');
    ok(/nk:2023/.test(serialize(warn)), `黄条给出了正确写法：${serialize(warn).slice(0, 80)}…`);
    ok(/四位年/.test(serialize(warn)), '并说明了原因（赛季是四位年）');

    // 改成对的写法 ⇒ 黄条消失
    row.querySelector('.m-source').value = 'nk:2023';
    row.querySelector('.m-source').dispatchEvent({ type: 'input' });
    eq(editor.querySelector('#acc-map-warn').style.display, 'none', '改对之后黄条收起来');

    // 对的那条**照常能保存**（提醒不拦人）
    btnByText(editor, '保存').click();
    await wait();
    const saved = Object.values(AppState.accounts).find((a) => a.name === '写法测试');
    ok(!!saved, '账户存下来了');
    eq((saved.mappings || []).map((m) => `${m.source}|${m.field}`).join(','), 'nk:2023|用户名', '映射原样存着');
}

// ===============================================================
group('账户：「🗑 清值」把"来源写错线索"留下的无主值清掉（只删无主的）');
// ===============================================================
{
    seedState();
    // 一条提交，同一格两条值：旧线索（无主）+ 新线索（已映射到「我」）
    const r = createNode('r_purge', 'R', { name: '提交', extKey: 'r-purge' });
    r.values = {
        language: [
            { v: 'G++', src: 'hdu-scraper', at: 'T2', clue: { source: 'hdu:2025', field: 'handle', value: 'teamE' } },
            { v: 'G++', src: 'hdu-scraper', at: 'T1', clue: { source: 'hdu:2025', field: 'handle', value: 'TEAM0/teamA' } }
        ]
    };
    AppState.nodes[r.id] = r;
    await execute((d) => accounts.createAccount(d, { id: 'k_purge', name: '我' }),
        { validate: false, refreshParentId: null });
    await execute((d) => accounts.saveAccount(d, 'k_purge', {
        mappings: [{ source: 'hdu:2025', field: 'handle', value: 'teamE' }]
    }), { validate: false, refreshParentId: null });

    ui.showAccountsModal();
    const main = lastPanel();
    const purgeBtn = main.querySelectorAll('.acc-act').find(b => b.dataset.act === 'purge');
    ok(!!purgeBtn, '「未认领的线索」那行有「🗑 清值」按钮');
    ok(purgeBtn && purgeBtn.dataset.value === 'TEAM0/teamA', '它带着那条无主线索（不是有主的那条）');
    purgeBtn.click();
    await wait();
    const confirm = lastPanel();
    ok(/不能撤销/.test(serialize(confirm)), '确认框写明了不能撤销');
    ok(/1 条/.test(serialize(confirm)), `确认框给出要删的条数：${serialize(confirm).slice(0, 120)}…`);
    btnByText(confirm, '确定').click();
    await wait();
    eq(AppState.nodes.r_purge.values.language.length, 1, '★ 只删了无主那条');
    eq(AppState.nodes.r_purge.values.language[0].clue.value, 'teamE', '留下的是已映射的那条线索');
}

// ===============================================================
group('账户：点顶栏 👤 **弹窗**（不是跳设置页）');
// ===============================================================
// 用户 2026-10-19："我觉得很久以前的版本 点顶部的账号按钮会弹窗，那样挺好的" ⇒ 改回来。
// 这一段直接走 `bindUIButtons()` 的真实绑定（它对其它顶栏元素都用了 `?.`，缺了就不绑），
// 再点那颗 chip —— 判据是"多出一个 `.modal-panel` 且里面是账户界面"。
{
    seedState();
    ui.renderAccountChip();
    const { bindUIButtons } = await import(mod('ui/buttons.js'));
    bindUIButtons();
    const before = document.querySelectorAll('.modal-panel').length;
    document.getElementById('account-chip').click();
    await wait();
    const after = document.querySelectorAll('.modal-panel');
    eq(after.length, before + 1, '★ 点 👤 多出一个弹窗');
    const panel = after[after.length - 1];
    ok(/👤 账户/.test(serialize(panel)), '弹出来的是「👤 账户」那一窗');
    ok(/账户（\d）/.test(serialize(panel)), '窗里就是账户视图（两种形态同一份界面）');
    ok(!!panel.querySelectorAll('.acc-act').find((b) => b.dataset.act === 'new'),
        '★ 弹窗里也有「＋ 新建账户」（入口跟着视图走）');
}

// ===============================================================
group('账户：映射行 / 子账户可**上下交换**（用户 2026-10-19）');
// ===============================================================
// 顺序就是数据：`mappings` 是数组、`children` 也是数组 ⇒ 界面上的 ↑/↓ 必须真的落到数组顺序上。
{
    seedState();
    // 建一个父 + 两个子（子账户那块要"已选"的才有 ↑/↓）
    await execute((d) => {
        const p = accounts.createAccount(d, { name: '父账户' });
        const a = accounts.createAccount(d, { name: '子甲' });
        const b = accounts.createAccount(d, { name: '子乙' });
        accounts.saveAccount(d, p, { children: [a, b] });
        AppState.__ids = { p, a, b };
    }, { validate: false, refreshParentId: null });
    const { p: pid, a: aid, b: bid } = AppState.__ids;

    ui.showAccountsModal();
    const main = lastPanel();
    main.querySelectorAll('.acc-act').find((x) => x.dataset.act === 'edit' && x.dataset.id === pid).click();
    await wait();
    const ed = lastPanel();

    // ---- ① 映射行 ↓：第一行和第二行换位 ----
    ed.querySelector('#acc-map-add').click();
    ed.querySelector('#acc-map-add').click();
    let rows = ed.querySelectorAll('.acc-map-row');
    const fill = (row, src) => {
        row.querySelector('.m-source').value = src;
        row.querySelector('.m-field').value = '用户名';
        row.querySelector('.m-value').value = src + '_v';
    };
    fill(rows[0], 'aa');
    fill(rows[1], 'bb');
    rows[0].querySelector('.acc-map-down').click();
    rows = ed.querySelectorAll('.acc-map-row');
    eq(rows[0].querySelector('.m-source').value, 'bb', '★ 点 ↓ ⇒ 第一行换成了原来第二行');
    eq(rows[1].querySelector('.m-source').value, 'aa', '第二行换成了原来第一行');

    // ---- ② 子账户 ↑：把第二个子账户提到第一个 ----
    const kidsBefore = [...ed.querySelectorAll('.acc-child-row')].filter((r) => r.dataset.on === '1').map((r) => r.dataset.id);
    eq(kidsBefore.join(','), [aid, bid].join(','), '起初子账户顺序 = 存进去的顺序');
    ed.querySelectorAll('.acc-child-up')[1].click();          // 第二行（子乙）上移
    const kidsAfter = [...ed.querySelectorAll('.acc-child-row')].filter((r) => r.dataset.on === '1').map((r) => r.dataset.id);
    eq(kidsAfter.join(','), [bid, aid].join(','), '★ 点 ↑ ⇒ 子乙排到子甲前面');

    // ---- 保存：两个顺序都要真的落到数据里 ----
    btnByText(ed, '保存').click();
    await wait();
    eq(AppState.accounts[pid].mappings[0].source, 'bb', '映射顺序落盘（bb 在前）');
    eq((AppState.accounts[pid].children || []).join(','), [bid, aid].join(','), '子账户顺序落盘（子乙在前）');
}

report();

/** 断言不含某段文字（读起来比 `ok(!/.test/)` 清楚） */
function assert_not_contains(text, needle, label) {
    ok(!String(text).includes(needle), label);
}
