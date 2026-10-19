// ================================================================
// 冒烟测试：me.json 编辑器（scripts/smoke/me-editor.smoke.mjs）
//
// me.json 编辑器要同时支持 json 修改与 ui 修改（像 vsc 的设置那种）。
//
// 单测只覆盖纯换算（`meForm`）与客户端（`meApi`）；这里跑**真的编辑器**：
//   ① 打开那一页 → 连探活 → 渲染表单（**凭据显示真值**，不打码）；
//   ② 改一格、保存 → 交出去的 body 里**只有 text 与 sha256**，没碰的凭据原样保住；
//   ③ 表单 ⇄ JSON 两个视图共享同一份草稿（切过去看到的是刚改的值）；
//   ④ 删一条记录、加一条记录、加一个新字段（表单的增删真的落到模型上）；
//   ⑤ 保存时 409（磁盘变过）要说人话、且不把面板清空；
//   ⑥ 「🔐 登录态」那一块：手输 + **用框里的值**探活 + 存进 me.json。
//   ⑦ 账户表的**布尔列**（`accounts[].active`）给勾选框，且三态不串味
//      （没这个键 ⇒ 勾上且**不写**；取消勾 ⇒ 写布尔 `false`）。
// fetch 全程是桩，不碰网络、不碰磁盘。
// ================================================================
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDom, makeContainer, serialize } from './dom.mjs';
import { group, ok, eq, report } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = path.join(ROOT, 'src');
const mod = (rel) => `file://${path.join(SRC, rel).replace(/\\/g, '/')}`;

const body = installDom([], { parseHtml: true });
const panel = makeContainer(body, 'settings-panel');
const meTab = document.createElement('div');
meTab.id = 'settings-tab-me';
panel.appendChild(meTab);
// 第二份宿主（⑥ 要用）：`createMeEditor` 的宿主由 id 定位，两个面板各自一份
const panel2 = makeContainer(body, 'settings-panel-2');
const meTab2 = document.createElement('div');
meTab2.id = 'settings-tab-me';
panel2.appendChild(meTab2);

const { createMeEditor } = await import(mod('ui/MeEditor/meEditor.js'));

// ---- 服务器桩：一份"像真 me.json"的文档（**凭据是真值**，不打码）+ 会记账的 PUT ----
const SERVER_DOC = {
    _note: ['说明第一行', '', '说明第三行'],
    cf: { handle: 'someone', apiKey: 'REAL-CF-KEY', apiSecret: 'REAL-CF-SECRET' },
    qoj: { username: 'someone', cookie: 'session=REAL-COOKIE' },
    nk: { handle: '队名', byYear: { '2023': '甲队' } },
    team: [{ name: '我', role: 'member', cf: 'someone' }, { name: '队友', role: 'member' }]
};
const calls = [];
let sha = 'a'.repeat(64);
let conflict = false;
const fetchImpl = async (url, opts = {}) => {
    calls.push({ url: String(url), method: String(opts.method || 'GET'), opts });
    const okJson = (json, status = 200) => ({ ok: status < 400, status, json: async () => json });
    if (String(url).includes('api/ping')) {
        return okJson({ ok: true, api: 2, root: ROOT, pid: 1, port: 8399, steps: [] });
    }
    if (String(opts.method || 'GET') === 'PUT') {
        if (conflict) return okJson({ ok: false, error: '磁盘上的 me.json 变过了（冲突）' }, 409);
        const sent = JSON.parse(opts.body);
        sha = 'b'.repeat(64);
        calls.at(-1).sent = sent;
        return okJson({ ok: true, path: 'acm-data/raw/Scaper/me.json', sha256: sha, mtime: 1700000000,
            doc: JSON.parse(sent.text) });
    }
    return okJson({ ok: true, path: 'acm-data/raw/Scaper/me.json', sha256: sha, mtime: 1700000000,
        doc: SERVER_DOC });
};

const toasts = [];
const editor = createMeEditor(panel, { fetchImpl, toast: (m, k) => toasts.push(`${k || 'info'}:${m}`) });

group('me.json 编辑器：载入与渲染');
editor.activate();
await new Promise(r => setTimeout(r, 20));

const html = () => serialize(meTab);
ok(calls.some(c => c.url.includes('api/me') && c.method === 'GET'), '打开这一页会去读 /api/me');
ok(/me\.json/.test(meTab.querySelector('#me-status').textContent), '状态行报出文件路径',
    meTab.querySelector('#me-status').textContent);
ok(html().includes('cf'), '表单里有 cf 这一组');
ok(html().includes('byYear'), '嵌套对象（nk.byYear）也渲染出来了');
ok(html().includes('_note'), '字符串数组（_note）也渲染出来了');
ok(html().includes('一行一条'), '提示"一行一条"');
ok(html().includes('team'), '对象数组（team）渲染成记录行');
ok(!html().includes('apiSecret\"><'), '槽位存在（输入框渲染）');

const inputs = meTab.querySelectorAll('.me-value');
const values = inputs.map(i => i.value);
ok(values.includes('REAL-CF-KEY'), '★ 凭据那一格**显示真值**（不打码）');
ok(values.includes('session=REAL-COOKIE'), 'cookie 同理');

group('me.json 编辑器：改一格 → 保存（只交文本 + sha256）');
const handleInput = meTab.querySelectorAll('.me-value').find(i => i.value === 'someone');
handleInput.value = '改过的名字';
// 触发一次 input（面板据此标"未保存"）
handleInput.dispatchEvent({ type: 'input' });
ok(meTab.querySelector('#me-dirty').style.display === 'inline', '改动后显示「⏳ 未保存」');

meTab.querySelector('#me-save').click();
await new Promise(r => setTimeout(r, 20));
const putCall = calls.filter(c => c.method === 'PUT').at(-1);
ok(!!putCall, '保存真的打了 PUT');
ok(putCall.url.endsWith('api/me'), '打到 /api/me（页面传不了文件名）');
eq(JSON.stringify(Object.keys(putCall.sent).sort()), JSON.stringify(['sha256', 'text']),
    'PUT body 只有 text 与 sha256');
ok(putCall.sent.sha256 === 'a'.repeat(64), '带上载入时那份 sha256（服务器据此挡冲突）');
const sentDoc = JSON.parse(putCall.sent.text);
eq(sentDoc.cf.handle, '改过的名字', '改过的那格是新的');
eq(sentDoc.cf.apiKey, 'REAL-CF-KEY', '★ 没碰的凭据原样保存（不做占位符替换）');
ok(meTab.querySelector('#me-dirty').style.display === 'none', '保存后不再标"未保存"');
ok(toasts.some(t => t.startsWith('success')), '保存成功给了提示');

group('me.json 编辑器：表单 ⇄ JSON 是同一份草稿');
const jsonBtn = meTab.querySelectorAll('.me-view-btn').find(b => b.dataset.view === 'json');
jsonBtn.click();
const jsonText = meTab.querySelector('#me-json-text');
ok(!!jsonText, '切到 JSON 视图');
ok(jsonText.value.includes('"改过的名字"'), 'JSON 视图里能看到表单刚改的值');
eq(JSON.parse(jsonText.value).cf.apiKey, 'REAL-CF-KEY', 'JSON 里凭据也是真值（同一份草稿）');

jsonText.value = JSON.stringify({ ...JSON.parse(jsonText.value), 新平台: { handle: 'x' } }, null, 2);
jsonText.dispatchEvent({ type: 'input' });
const formBtn = meTab.querySelectorAll('.me-view-btn').find(b => b.dataset.view === 'form');
formBtn.click();
ok(serialize(meTab).includes('新平台'), 'JSON 里加的键切回表单也在');
eq(meTab.querySelector('#me-json-text'), null, '切回表单后 JSON 框没了');

// 坏 JSON：**不切**（还留在 JSON 视图，且明说哪里不对）——否则表单会被清空，用户以为改没了
jsonBtn.click();
meTab.querySelector('#me-json-text').value = '{ 坏 JSON';
meTab.querySelector('#me-json-text').dispatchEvent({ type: 'input' });
formBtn.click();
ok(meTab.querySelector('#me-json-text') !== null, 'JSON 坏掉时不切走（还停在 JSON 视图）');
ok(toasts.some(t => t.startsWith('error') && t.includes('JSON')), '并且明说 JSON 有问题');

// 修好就能切回去，而且改过的键还在
meTab.querySelector('#me-json-text').value =
    JSON.stringify({ ...SERVER_DOC, 新平台: { handle: 'x' } }, null, 2);
formBtn.click();
ok(meTab.querySelector('#me-json-text') === null, '修好 JSON ⇒ 切回表单');
ok(serialize(meTab).includes('新平台'), 'JSON 里改的内容带回了表单');

group('me.json 编辑器：表单增删（记录行 / 新字段）');
// ⚠️ 数元素用 querySelectorAll，不要用 serialize()：冒烟桩开了 parseHtml 之后
//    serialize 走的是"遍历元素树吐文本"，**不带 class 属性**，数 class 会永远得 0。
const recordCount = () => meTab.querySelectorAll('.me-record').length;
const beforeRecords = recordCount();
ok(beforeRecords >= 2, 'team 的两条记录都渲染出来了', `实际 ${beforeRecords} 条`);
meTab.querySelectorAll('.me-del-record')[0].click();
const afterRecords = recordCount();
ok(afterRecords === beforeRecords - 1, '删掉一条记录（team 少一人）',
    `${beforeRecords} → ${afterRecords}`);

meTab.querySelectorAll('.me-add-record')[0].click();
ok(recordCount() === afterRecords + 1, '加一条空记录（留空不落盘）', `实际 ${recordCount()} 条`);

const keyInputsBefore = meTab.querySelectorAll('.me-key').length;
meTab.querySelectorAll('.me-add').at(-1).click();
eq(meTab.querySelectorAll('.me-key').length, keyInputsBefore + 1, '新字段那一行的键名是可编辑的输入框');

// ★ 待定行：两格（键名 + 值），值贴 `{…}` 就建成**对象**（用户 2026-10-19："表单填不了对象名"）
eq(meTab.querySelectorAll('.me-entry-value').length, 1, '新加的是待定行（键名 + 值两格）');
meTab.querySelectorAll('.me-key').at(-1).value = 'years';
meTab.querySelectorAll('.me-entry-value').at(-1).value = '{a:1}';          // 半个 JSON
meTab.querySelectorAll('.me-entry-commit').at(-1).click();
ok(meTab.querySelectorAll('.me-entry-value').length === 1,
    '★ 值不是合法 JSON ⇒ 待定行**还在**（不许悄悄当字符串存下去）');
ok(serialize(meTab).includes('不是合法 JSON'), '并且就地红字说清哪里不对');
meTab.querySelectorAll('.me-entry-value').at(-1).value =
    '{"2026": {"contestUser": "teamA", "contestPassword": "pw-placeholder"}}';
meTab.querySelectorAll('.me-entry-commit').at(-1).click();
eq(meTab.querySelectorAll('.me-entry-value').length, 0, '改成合法 JSON 后点 ✓ 建 ⇒ 待定行变成真节点');
jsonBtn.click();
const nested = JSON.parse(meTab.querySelector('#me-json-text').value);
eq(nested.years && nested.years['2026'] && nested.years['2026'].contestUser, 'teamA',
    '★ 收回来是**嵌套对象**（不是字符串 `"{...}"`）');
formBtn.click();
ok(serialize(meTab).includes('个字段'), '建好的对象在表单里是可展开的分组（能接着「＋ 新字段」）');

// ★ 类型选「对象（嵌套）」：值留空就建**空对象**（先建壳、再往里加子字段）
meTab.querySelectorAll('.me-add').at(-1).click();
const entryTypeSel = meTab.querySelectorAll('.me-entry-type').at(-1);
ok(meTab.querySelectorAll('.me-entry-type option').some(o => o.value === 'object'),
    '类型下拉里有「对象（嵌套）」这一档（选项由 meForm 的 ENTRY_TYPES 出）');
entryTypeSel.value = 'object';
meTab.querySelectorAll('.me-key').at(-1).value = 'shell';
meTab.querySelectorAll('.me-entry-commit').at(-1).click();
eq(meTab.querySelectorAll('.me-entry-value').length, 0, '值留空 + 选对象 ⇒ 直接建成空对象');
jsonBtn.click();
const withShell = JSON.parse(meTab.querySelector('#me-json-text').value);
ok(withShell.shell && typeof withShell.shell === 'object' && !Array.isArray(withShell.shell),
    '★ 收回来是**空对象** `{}`（不是空字符串）', JSON.stringify(withShell.shell));
formBtn.click();

group('me.json 编辑器：磁盘变过（409）要说人话、别清空面板');
conflict = true;
meTab.querySelector('#me-save').click();
await new Promise(r => setTimeout(r, 20));
ok(meTab.querySelector('#me-status').textContent.includes('变过'), '状态行说"磁盘上那份变过了"',
    meTab.querySelector('#me-status').textContent);
ok(toasts.some(t => t.startsWith('error') && t.includes('变过')), '给了错误提示');
ok(serialize(meTab).includes('cf'), '面板没被清空（还能接着改）');
conflict = false;

group('🔐 登录态那一块：手输 + 探活');
const authCalls = [];
const authFetch = async (url, opts = {}) => {
    if (String(url).includes('api/auth-probe')) {
        authCalls.push({ url: String(url), body: JSON.parse(opts.body || '{}') });
        return {
            ok: true, status: 200,
            json: async () => ({ ok: true, code: 0, platform: 'qoj',
                output: '🔎 探 QOJ 登录态：HTTP 200\n✅ QOJ 登录态正常' })
        };
    }
    return fetchImpl(url, opts);
};
const editor2 = createMeEditor(panel2, { fetchImpl: authFetch, toast: (m, k) => toasts.push(`${k || 'info'}:${m}`) });
editor2.activate();
await new Promise(r => setTimeout(r, 20));

const rows = () => panel2.querySelectorAll('.auth-row');
ok(rows().length >= 3, '★ 登录态那一块列出来了（QOJ / CF / CLIST / 无凭据的那几个）',
    `实际 ${rows().length} 行`);
const qojRow = rows().find(r => r.dataset.platform === 'qoj');
ok(!!qojRow, '有 QOJ 那一行');
const cookieInput = qojRow.querySelectorAll('.auth-field')[0];
eq(cookieInput.dataset.path, 'qoj.cookie', '输入框绑的是 me.json 的点分路径');
eq(cookieInput.value, 'session=REAL-COOKIE', '★ 框里就是当前那份值（不打码）');
const cfRow = rows().find(r => r.dataset.platform === 'cf');
ok(!!cfRow && !!cfRow.querySelectorAll('.auth-probe')[0], 'CF 那一行也有按钮');
// ★ 口径 2026-10-17 改了（用户："cf 怎么能因为贵就不探"）：CF 的「探活」**不再是"没有探针"那一类** ——
//   后端 `auth_state.SIGNED_PROBES['cf']` 会真发一个带 apiSig 签名的请求（gym 104813 的榜单）。
//   ⚠️ 这里**与 QOJ 比**（不比某个写死的值）：`disabled` 还受 `ready` 影响，
//      而 DOM 桩不拦"点一颗 disabled 按钮"⇒ 拿 QOJ 当基准才钉得住"同等待遇"这件事。
const cfProbeBtn = cfRow.querySelectorAll('.auth-probe')[0];
eq(cfProbeBtn.disabled, qojRow.querySelectorAll('.auth-probe')[0].disabled,
    '★ CF 的「探活」与 QOJ **同等待遇**（不再"因为要签名就不探"）');
// 界面这份数据里 CF 也得是 `probe: true`（后端真注册了 `SIGNED_PROBES['cf']`；
// 两边一致这条由 `src/test/crossLangTables.test.js` 的对拍盯着）。
const { AUTH_PLATFORMS } = await import(mod('ui/MeEditor/authPanel.js'));
eq(AUTH_PLATFORMS.find(p => p.id === 'cf').probe, true,
    '★ 界面表里 CF 的 probe = true（不再"因为要签名就不探"）');

// ① 探活：**用框里现在的值**（改一下再探，别要求先保存）
// ⚠️ 每次**现取**输入框：`paint()` 会重建它们（早先抓住的那个引用已经不在 DOM 里了），
//    而且要**派发 `input`** —— 真敲字就是这一下（值在这一下里进唯一那份草稿）。
const liveCookie = () => panel2.querySelectorAll('.auth-field')[0];
liveCookie().value = 'session=NEW-ONE';
liveCookie().dispatchEvent({ type: 'input' });
await panel2.querySelectorAll('.auth-probe')[0].click();
await new Promise(r => setTimeout(r, 40));
eq(authCalls.length, 1, '★ 点「探活」打了一次 /api/auth-probe');
eq(authCalls[0].body.platform, 'qoj', '带上平台名');
eq(authCalls[0].body.overrides['qoj.cookie'], 'session=NEW-ONE',
    '★ 探的是**框里现在那个值**（还没保存也照样探）');
ok(/登录态正常/.test(serialize(panel2)), '探活结论画在那一行下面');

// ② 存进 me.json：写进草稿 + 走同一个保存出口（PUT /api/me）
const beforePut = calls.filter(c => c.method === 'PUT').length;
await panel2.querySelectorAll('.auth-save')[0].click();
await new Promise(r => setTimeout(r, 40));
eq(calls.filter(c => c.method === 'PUT').length, beforePut + 1, '★ 「存进 me.json」真的落盘了');
eq(JSON.parse(calls.filter(c => c.method === 'PUT').at(-1).sent.text).qoj.cookie, 'session=NEW-ONE',
    '存下去的就是框里那个值');

// ★★ 2026-10-17 回归（用户："新版又把我填的值吞了" / "别打补丁"）：在「🔐 登录态」格里敲的字，
//    **底部那颗「💾 保存到 me.json」也必须写得出去**。
//    病根：那几格的值原来只活在面板私藏的一份 `pending` 里、按下本行按钮才提交进草稿，
//    而底部保存是按**表单模型**重算整份文档 ⇒ 两条路各写各的，底下那颗一按就把这几格吞掉。
//    ⇒ 现在：敲一下（`input` 事件）就直接进唯一那份草稿，两条保存路径写的是同一份东西。
const cfKeyInput = cfRow.querySelectorAll('.auth-field')[0];
cfKeyInput.value = 'KEY-FROM-PANEL';
cfKeyInput.dispatchEvent({ type: 'input' });          // 真敲字就是这一下
const beforeBottom = calls.filter(c => c.method === 'PUT').length;
meTab2.querySelector('#me-save').click();             // **底部**那颗（不是本行的）
await new Promise(r => setTimeout(r, 40));
const bottomPut = calls.filter(c => c.method === 'PUT').at(-1);
eq(calls.filter(c => c.method === 'PUT').length, beforeBottom + 1, '底部那颗也走同一个出口');
ok(bottomPut && bottomPut.sent.text.includes('KEY-FROM-PANEL'),
    '★★ 底部保存**没吞掉**登录态那格里敲的字（就是这么丢的：CF key/secret + QOJ cookie）',
    bottomPut ? bottomPut.sent.text.slice(0, 160) : '（没写）');

group('📇 账户表：布尔列给勾选框（勾 = 启用；**别把"没这个键"写成 false**）');
const panel3 = makeContainer(body, 'settings-panel-3');
const meTab3 = document.createElement('div');
meTab3.id = 'settings-tab-me';
panel3.appendChild(meTab3);
const ACC_DOC = { accounts: [{ name: 'AFK', active: false, qoj: 'afk' }, { name: 'LIVE', qoj: 'live' }] };
const accFetch = async (url) => (String(url).includes('api/ping')
    ? { ok: true, status: 200, json: async () => ({ ok: true, api: 2, root: ROOT, pid: 1, port: 8399, steps: [] }) }
    : { ok: true, status: 200, json: async () => ({ ok: true, doc: ACC_DOC, sha256: 'c'.repeat(64), mtime: 1 }) });
const editor3 = createMeEditor(panel3, { fetchImpl: accFetch, toast: () => {} });
editor3.activate();
await new Promise(r => setTimeout(r, 20));
const recs = () => meTab3.querySelectorAll('.me-record');
const boxOf = (i) => recs()[i].querySelectorAll('.me-field-bool')[0];
eq(meTab3.querySelectorAll('.me-field-bool').length, 2, '★ `active` 那一列的每一条都是勾选框（不是文本框）');
eq(recs()[0].querySelectorAll('.me-field')[0].value, 'AFK', '第一行是 AFK（下面按下标取就是它）');
eq(!!boxOf(0).checked, false, '★ 写着 `active: false` ⇒ 不勾（停用）');
eq(boxOf(1).checked, true, '★ **没写这个键** ⇒ 勾上（缺省就是启用，不是停用）');
eq(editor3.doc().accounts[1].active, undefined, '★ 原样不动时**不造** `active` 那个键（没勾就是没勾）');
boxOf(0).checked = true;
eq(editor3.doc().accounts[0].active, true, '★ 勾上之后是**布尔** `true`（不是字符串 `"true"`）');
boxOf(1).checked = false;
eq(editor3.doc().accounts[1].active, false, '★ 主动取消勾 ⇒ 写成布尔 `false`（这就是"停用"）');

// 新加的那一条也要照整列给控件（否则 `byYear` 是文本框、`active` 得手打）
const recCount3 = recs().length;
meTab3.querySelectorAll('.me-add-record')[0].click();
eq(recs().length, recCount3 + 1, '「＋ 加一条」多出一行');
const fresh = recs().at(-1);
eq(fresh.querySelectorAll('.me-field-bool').length, 1, '★ 新行的 `active` 也是勾选框（不是文本框）');
eq(fresh.querySelectorAll('.me-field-bool')[0].checked, true, '★ 新行默认"启用"（留空不写 = 活跃）');
fresh.querySelectorAll('.me-field')[0].value = 'NEWBIE';
eq(editor3.doc().accounts.at(-1).name, 'NEWBIE', '填了名字就落进草稿');
eq(editor3.doc().accounts.at(-1).active, undefined, '★ 新行没动过勾 ⇒ **不写** `active`（缺省即启用）');

// 文件里**一条 `active` 都没有**时，那一列照样要在（用户 2026-10-15："每个账户都需要是否启用的信息"）
const PLAIN_DOC = { accounts: [{ name: 'A0', cf: 'a0' }, { name: 'B0', cf: 'b0' }] };
const plainFetch = async (url) => (String(url).includes('api/ping')
    ? { ok: true, status: 200, json: async () => ({ ok: true, api: 2, root: ROOT, pid: 1, port: 8399, steps: [] }) }
    : { ok: true, status: 200, json: async () => ({ ok: true, doc: PLAIN_DOC, sha256: 'd'.repeat(64), mtime: 1 }) });
const panel4 = makeContainer(body, 'settings-panel-4');
const meTab4 = document.createElement('div');
meTab4.id = 'settings-tab-me';
panel4.appendChild(meTab4);
const editor4 = createMeEditor(panel4, { fetchImpl: plainFetch, toast: () => {} });
editor4.activate();
await new Promise(r => setTimeout(r, 20));
const plainBoxes = meTab4.querySelectorAll('.me-field-bool');
eq(plainBoxes.length, 2, '★ 文件里一个 `active` 都没写过 ⇒ 那一列**照样在**（每行一个勾选框）');
eq(plainBoxes.every(b => b.checked === true), true, '★ 空 = 缺省启用 ⇒ 都勾上（不是"没勾"）');
eq('active' in editor4.doc().accounts[0], false, '★ 原样不动 ⇒ 不往文件里造 `active`');
plainBoxes[1].checked = false;
eq(editor4.doc().accounts[1].active, false, '★ 只把 B0 取消勾 ⇒ 只有它多一格布尔 `false`');
eq('active' in editor4.doc().accounts[0], false, '★ A0 没动 ⇒ 一个字都不多写');

// ===============================================================
group('表单：字段 ↑/↓（用户 2026-10-19："me.json 表单的项上下交换"）');
// ===============================================================
// 顺序 = 文件里键的先后（`collectFormModel` 按模型 children 顺序拼对象）⇒ 点一下 ↑/↓，
// `doc()` 里那两个键的先后就得换过来，值一个都不许丢。
{
    const docOrder = { zeta: 'z', alpha: { one: 1 }, beta: 'b' };
    const orderFetch = async () => ({
        ok: true, status: 200,
        json: async () => ({ ok: true, path: '个人数据/me.json', exists: true, sha256: 'c'.repeat(64),
            mtime: 1700000000, doc: docOrder })
    });
    const panel5 = makeContainer(body, 'settings-panel-5');
    const meTab5 = document.createElement('div');
    meTab5.id = 'settings-tab-me';
    panel5.appendChild(meTab5);
    const editor5 = createMeEditor(panel5, { fetchImpl: orderFetch, toast: () => {} });
    editor5.activate();
    await new Promise(r => setTimeout(r, 20));

    const keysOf = () => Object.keys(editor5.doc()).join(',');
    eq(keysOf(), 'zeta,alpha,beta', '起初顺序 = 文件里的顺序');
    let nodes = meTab5.querySelectorAll('.me-node');
    ok(nodes.length >= 3, '三格都画出来了');
    nodes[0].querySelector('.me-move[data-move="down"]').click();      // zeta ↓
    await new Promise(r => setTimeout(r, 10));
    eq(keysOf(), 'alpha,zeta,beta', '★ 点 ↓ ⇒ zeta 跑到 alpha 后面');
    eq(editor5.doc().zeta, 'z', '值一个都没丢（zeta）');
    eq(editor5.doc().alpha.one, 1, '值一个都没丢（alpha 那个对象整个还好）');
    // 再把它 ↑ 回去。⚠️ 别按"第几个 .me-node"取：`alpha` 是个对象、它自己的 ↑ 是**首行 no-op**
    //    ⇒ 按文本认 zeta 那一格（它没有内层 `.me-group`，认起来唯一）。
    nodes = [...meTab5.querySelectorAll('.me-node')].filter((n) => serialize(n).includes('zeta'));
    nodes[nodes.length - 1].querySelector('.me-move[data-move="up"]').click();
    await new Promise(r => setTimeout(r, 10));
    eq(keysOf(), 'zeta,alpha,beta', '★ 点 ↑ 又回到原样');
}

// 接进设置页（一级 Tab）的那条路在 `settings-page.smoke.mjs` 里钉 ——
// 这一段只管编辑器本身（它不依赖外壳）。

// ===============================================================
group('🔐 登录态 vs 📌 必须填：杭电那两块**分开**（用户 2026-10-19："杭电不应有登录态"）');
// ===============================================================
{
    const hduRow = [...panel2.querySelectorAll('.auth-row')].find((r) => r.dataset.platform === 'hdu');
    ok(!!hduRow, '杭电那一行还在（两格输入框照旧）');
    eq(hduRow.querySelectorAll('.auth-probe').length, 0, '★ 它**没有**探活按钮（不是登录态）');
    ok(!!hduRow.querySelectorAll('.auth-save')[0], '「存进 me.json」还在（填完还是要存）');
    // 它得在「📌 必须填」那一块里，而不是「🔐 登录态」里
    const boxes = [...panel2.querySelectorAll('div')].filter((d) => serialize(d).includes('🔐 登录态'));
    const authBox = boxes[boxes.length - 1];
    ok(/🔐 登录态/.test(serialize(panel2)) && authBox, '「🔐 登录态」那一块还在');
    ok(!serialize(authBox).includes('hdu.contestUser'), '★ 杭电那两格**不在**「登录态」块里');
    ok(serialize(panel2).includes('必须填'), '★ 另有一块写着"必须填（不是登录态）"');
}

report();
