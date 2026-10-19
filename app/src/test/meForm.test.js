// ================================================================
// `me.json` 表单模型的单测（src/test/meForm.test.js）
//
// 口径："me.json 又有 json 修改又有 ui 修改（像 vsc 的设置那种）"。
//
// 这里钉的是"表单 ⇄ 文档"这条双通道**不许改坏文件**：
//   ① 原样进出（`doc → 模型 → doc` 与原文一样）；
//   ② 按**值**选控件（对象/字符串/字符串数组/对象数组），不认键名；
//   ③ 凭据占位符原样保留 ⇒ 交给服务器换回真值（不在这里丢密钥）；
//   ④ 新加的空字段不写进文件、键名重复要报错（宁可不写也别悄悄丢）。
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    ENTRY_TYPES,
    KIND,
    OMIT,
    buildFormModel,
    collectFormModel,
    ensureRecordColumn,
    nodeFromEntry,
    nodeOf,
    pendingEntry,
    recordItemOf,
    summarize
} from '../ui/MeEditor/meForm.js';

/** 一份"像真 me.json"的样本（结构照着磁盘上那份抄，值全是假的） */
const SAMPLE = {
    _note: ['第一行说明', '', '第三行说明'],
    cf: { handle: 'Someone', apiKey: 'REAL-CF-KEY', apiSecret: 'REAL-CF-SECRET' },
    qoj: { username: 'Someone', cookie: 'session=REAL-COOKIE' },
    nk: { handle: '队名', byYear: { '2023': '甲队', '2024': '乙队' } },
    clist: { username: 'Someone', apiKey: 'REAL-CLIST-KEY' },
    team: [
        { name: '我', role: 'member', cf: 'Someone', qoj: 'Someone' },
        { name: '队友', role: 'member', cf: 'Teammate' }
    ],
    _team_note: ['花名册说明']
};

test('文档 → 模型 → 文档：原样进出（一次都不改坏）', () => {
    const model = buildFormModel(SAMPLE);
    assert.deepEqual(collectFormModel(model), SAMPLE);
});

test('按值选控件：对象=组 / 字符串=文本 / 字符串数组=多行 / 对象数组=记录', () => {
    const model = buildFormModel(SAMPLE);
    const byKey = (k) => model.children.find((c) => c.key === k);
    assert.equal(byKey('cf').kind, KIND.GROUP, '对象 ⇒ 组');
    assert.equal(byKey('_note').kind, KIND.LINES, '字符串数组 ⇒ 多行框（一行一条）');
    assert.equal(byKey('team').kind, KIND.RECORDS, '对象数组 ⇒ 记录行');
    assert.equal(byKey('cf').children.find((c) => c.key === 'handle').kind, KIND.TEXT);
    assert.deepEqual(byKey('team').keys, ['name', 'role', 'cf', 'qoj'], '记录字段 = 各条键名的并集');
    assert.equal(byKey('team').items[1].fields.find((f) => f.key === 'qoj').wasPresent, false,
        '第二条没有 qoj ⇒ 标"本来没有"（留空就不写）');
});

test('凭据原样进出：表单里不动它，交回去还是那个值（**没有占位符那一套**）', () => {
    const model = buildFormModel(SAMPLE);
    const out = collectFormModel(model);
    assert.equal(out.cf.apiKey, 'REAL-CF-KEY');
    assert.equal(out.qoj.cookie, 'session=REAL-COOKIE');
});

test('改一个、留一个：改过的写新值，没碰的凭据照旧', () => {
    const model = buildFormModel(SAMPLE);
    const cf = model.children.find((c) => c.key === 'cf');
    cf.children.find((c) => c.key === 'handle').value = '新名字';
    const out = collectFormModel(model);
    assert.equal(out.cf.handle, '新名字');
    assert.equal(out.cf.apiKey, 'REAL-CF-KEY', '没碰的凭据未被清掉');
});

test('凭据删空 = 明确清掉（写空串，不是被当成"没填"丢掉）', () => {
    const model = buildFormModel(SAMPLE);
    const cf = model.children.find((c) => c.key === 'cf');
    cf.children.find((c) => c.key === 'apiKey').value = '';
    const out = collectFormModel(model);
    assert.equal(out.cf.apiKey, '');
    assert.ok(Object.prototype.hasOwnProperty.call(out.cf, 'apiKey'), '键还在（清空 ≠ 删除字段）');
});

test('新加的字段：名字留空 ⇒ 整行不算；填了名字 + 值才写进去；只有名字没有值也不写', () => {
    const model = buildFormModel({ cf: { handle: 'x' } });
    const cf = model.children.find((c) => c.key === 'cf');
    const added = nodeOf('', '', { keyEditable: true });
    added.value = '白填的内容';                     // 有内容但没名字 ⇒ 报错
    cf.children.push(added);
    assert.throws(() => collectFormModel(model), /没填名字/);

    added.key = 'apiKey';
    assert.deepEqual(collectFormModel(model).cf, { handle: 'x', apiKey: '白填的内容' });

    added.value = '';
    assert.deepEqual(collectFormModel(model).cf, { handle: 'x' },
        '新加的字段留空 ⇒ 不写进文件（"还没填" ≠ "填成了空串"）');
});

test('N 多行框：一行一条；尾部空行不写进文件，中间空行保留（`_note` 里的空行是排版）', () => {
    const model = buildFormModel({ _note: ['a', '', 'c'] });
    const lines = model.children[0];
    lines.values = ['a', '', 'c', '', ''];
    assert.deepEqual(collectFormModel(model)._note, ['a', '', 'c']);
    lines.values = [];
    assert.deepEqual(collectFormModel(model)._note, [], '清空 ⇒ 空数组（键还在）');
});

test('记录行：删掉一条 / 加一条（加的空条不写进文件）', () => {
    const model = buildFormModel(SAMPLE);
    const team = model.children.find((c) => c.key === 'team');
    team.items.splice(0, 1);
    assert.deepEqual(collectFormModel(model).team, [{ name: '队友', role: 'member', cf: 'Teammate' }]);
    team.items.push(recordItemOf(team.keys, {}));
    assert.equal(collectFormModel(model).team.length, 1, '空记录不写进文件');
    team.items[1].fields.find((f) => f.key === 'name').value = '第三个人';
    assert.equal(collectFormModel(model).team.length, 2);
});

test('键名重复 ⇒ 报错（对象会悄悄吃掉一个，不如让用户先改名）', () => {
    const model = buildFormModel({ a: '1' });
    model.children.push(nodeOf('a', '2'));
    assert.throws(() => collectFormModel(model), /重复/);
});

test('数字/布尔只读回原类型（键名是字符串的那些格不会被改成 "2023" 型不匹配）', () => {
    const model = buildFormModel({ n: 3, b: true, s: 'x' });
    assert.deepEqual(collectFormModel(model), { n: 3, b: true, s: 'x' });
});

test('认不出的结构退回 JSON 框（含混数组 / 带换行的字符串数组），不当成记录乱改', () => {
    assert.equal(nodeOf('mix', [1, { a: 2 }]).kind, KIND.RAW);
    assert.equal(nodeOf('nl', ['a\nb', 'c']).kind, KIND.RAW, '值里带换行 ⇒ 不能用"一行一条"那个框');
    assert.equal(nodeOf('empty', []).kind, KIND.LINES, '空数组当空表');
});

test('空文档 / 顶层不是对象：该报的报，该空的空', () => {
    assert.deepEqual(collectFormModel(buildFormModel({})), {});
    assert.throws(() => buildFormModel([1, 2]), /顶层必须是对象/);
    assert.throws(() => buildFormModel(null), /顶层必须是对象/);
});

test('摘要一行（长文本折叠时显示）', () => {
    assert.equal(summarize(nodeOf('x', 'short')), 'short');
    assert.match(summarize(nodeOf('x', 'y'.repeat(80))), /…$/);
    assert.equal(summarize(nodeOf('g', { a: 1, b: 2 })), '2 个字段');
    assert.equal(summarize(nodeOf('l', ['a', 'b'])), '2 行');
    assert.equal(summarize(nodeOf('r', [{ a: 1 }])), '1 条');
});

test('⚠️ 对象数组里的对象/数组字段（v2 的 `byYear`/`mappings`）原样进出，不会变成 "[object Object]"', () => {
    const doc = {
        accounts: [
            {
                name: '我', nature: '本人', cf: 'me_cf', nk: '某用户名',
                byYear: { nk: { 2023: '某昵称', 2025: 'demo0' } },
                mappings: [{ source: 'pta:icpc2026', field: '队伍', value: 'demo' }]
            },
            { name: '队友', cf: 'mate_cf' }
        ],
        current: '我',
        cf: { apiKey: 'REAL-CF-KEY' }
    };
    const model = buildFormModel(doc);
    assert.deepEqual(collectFormModel(model), doc, '一字不差地进出');
    const accs = model.children.find((c) => c.key === 'accounts');
    const me = accs.items[0];
    const byYear = me.fields.find((f) => f.key === 'byYear');
    assert.equal(byYear.isJson, true, 'byYear 是对象 ⇒ 标成 JSON 字段');
    assert.match(byYear.value, /某昵称/);
    const mate = accs.items[1];
    assert.equal(mate.fields.find((f) => f.key === 'byYear').isJson, true,
        '**另一条没有这个字段**也要给 JSON 框（看整列），否则新填的会被当字符串');
    assert.equal(mate.fields.find((f) => f.key === 'byYear').value, '');
});

test('对象数组里的 JSON 字段写坏了要报错（别静默存成字符串）', () => {
    const model = buildFormModel({ accounts: [{ name: '我', byYear: { nk: { 2025: 'X' } } }] });
    const accs = model.children[0];
    accs.items[0].fields.find((f) => f.key === 'byYear').value = '{ 坏 JSON';
    assert.throws(() => collectFormModel(model), /byYear.*JSON/);
});

test('⚠️ 对象数组的**布尔/数字**列原样进出（`active: false` 不能降级成 "false" —— 停用会静默失效）', () => {
    const doc = {
        accounts: [
            { name: 'AFK', active: false, qoj: 'afk' },
            { name: 'LIVE', qoj: 'live' },
            { name: 'NUM', active: true, note: 3 }
        ]
    };
    const model = buildFormModel(doc);
    assert.deepEqual(collectFormModel(model), doc,
        '一字不差地进出：布尔还是布尔、数字还是数字，**没这个键的照样没有**');
    const accs = model.children[0];
    assert.equal(accs.items[0].fields.find((f) => f.key === 'active').isBool, true, '布尔列 ⇒ 给勾选框');
    assert.equal(accs.items[1].fields.find((f) => f.key === 'active').isBool, true,
        '**另一条没有这个键**也要给勾选框（看整列），否则那一格只能手打，`"false"` 又不是 `false`');
    assert.equal(accs.items[1].fields.find((f) => f.key === 'active').value, '', '没写这个键 ⇒ 值是空的');
});

test('⚠️「＋ 加一条」也照整列给控件（列信息留在节点上，不只留给建模型那一次）', () => {
    const model = buildFormModel({ accounts: [{ name: 'A', byYear: { nk: { 2025: 'X' } }, active: false }] });
    const accs = model.children[0];
    assert.ok(accs.jsonKeys.has('byYear'), '节点上记着"哪几列是 JSON"');
    assert.ok(accs.boolKeys.has('active'), '节点上记着"哪几列是布尔"');
    const fresh = recordItemOf(accs.keys, {}, accs.jsonKeys, accs.boolKeys);
    assert.equal(fresh.fields.find((f) => f.key === 'byYear').isJson, true,
        '★ 新加的那一条，`byYear` 也得是 JSON 框（否则填进去会变成字符串）');
    assert.equal(fresh.fields.find((f) => f.key === 'active').isBool, true, '★ 新加的那一条，`active` 也得是勾选框');
});

test('⚠️ `ensureRecordColumn`：给表补一列（只动模型）——没动过的行**不写进文件**', () => {
    const doc = { accounts: [{ name: 'A', cf: 'a' }, { name: 'B', cf: 'b' }] };
    const model = buildFormModel(doc);
    const accs = model.children[0];
    assert.equal(accs.boolKeys.has('active'), false, '文件里一条布尔都没有 ⇒ 本来没有这一列');
    ensureRecordColumn(accs, 'active', 'boolean');
    assert.equal(accs.keys.includes('active'), true, '列加进模型了（表单据此画勾选框）');
    assert.equal(accs.boolKeys.has('active'), true, '而且标成布尔列');
    assert.equal(accs.items.every((it) => it.fields.some((f) => f.key === 'active' && f.isBool)),
        true, '每一条都有那一格（空的）');
    assert.deepEqual(collectFormModel(model), doc,
        '★ 谁都没动 ⇒ 文档**一字不差**（补列不是造数据）');
    accs.items[1].fields.find((f) => f.key === 'active').value = 'false';
    assert.deepEqual(collectFormModel(model).accounts[1], { name: 'B', cf: 'b', active: false },
        '★ 只有真的动过的那一行多了布尔 `false`（不是字符串）');
    assert.deepEqual(collectFormModel(model).accounts[0], { name: 'A', cf: 'a' }, 'A 没动 ⇒ 不多写');
});

test('OMIT 是内部哨兵，不会混进文档（防手滑把它当值写出去）', () => {
    assert.equal(typeof OMIT, 'symbol');
    const model = buildFormModel({ a: '1' });
    model.children.push(nodeOf('newkey', '', { keyEditable: true }));
    assert.ok(!JSON.stringify(collectFormModel(model) || {}).includes('omit'));
});

// ================================================================
// 待定行（`＋ 新字段`）：两格，**对象在表单里也造得出来**
//
// 来由（用户 2026-10-19 实测）：要给 `hdu.years` 加 `2026` 那一格，而 `＋ 新字段` 只会给出
// 一个**文本框** ⇒ "填不了对象名"，只能切去 JSON 视图改。现在值那一格贴 `{…}` 就建成对象。
// ⚠️ 同时钉住"**不许猜数字/布尔**"：`contestPassword: "123456"` 是数字形式的字符串（值纯属示例），
//    猜成数字后 JSON 里就没引号了（与 `active: false ⇒ "false"` 是同一个坑的两头）。
// ================================================================
test('★ 待定行：值贴 `{…}`/`[…]` 就建成对象/数组，其余一律字符串（不猜数字/布尔）', () => {
    // 对象：一步建好整个嵌套结构（用户要的就是这个）
    const obj = nodeFromEntry('2026', '{"contestUser": "teamA", "contestPassword": "123456"}');
    assert.equal(obj.kind, KIND.GROUP, '`{…}` ⇒ 可展开的分组');
    assert.deepEqual(obj.children.map((c) => c.key), ['contestUser', 'contestPassword']);
    // 空对象也合法（先建壳、再往里加字段）
    assert.equal(nodeFromEntry('x', '{}').kind, KIND.GROUP);
    // 数组走既有的"按值选控件"
    assert.equal(nodeFromEntry('x', '["a", "b"]').kind, KIND.LINES);
    // ★ 数字形式的字符串**必须仍是字符串**
    const pw = nodeFromEntry('contestPassword', '123456');
    assert.equal(pw.kind, KIND.TEXT);
    assert.equal(pw.valueType, 'string', '★ `123456` 不许被猜成数字（猜了 JSON 里就没引号了）');
    // 真想要数字/布尔 ⇒ 显式选类型
    assert.equal(nodeFromEntry('n', '42', 'number').valueType, 'number');
    assert.equal(nodeFromEntry('b', 'false', 'boolean').valueType, 'boolean');
    // ★ 类型选「对象（嵌套）」：**值留空就建空对象**（先建壳、再往里加字段）
    const shell = nodeFromEntry('2026', '', 'object');
    assert.equal(shell.kind, KIND.GROUP, '选对象 + 值留空 ⇒ 空分组');
    assert.deepEqual(shell.children, []);
    assert.equal(nodeFromEntry('x', '{"a": 1}', 'object').kind, KIND.GROUP, '选了对象又能贴 JSON ⇒ 照 JSON 建');
    assert.throws(() => nodeFromEntry('x', 'plain', 'object'), /值留空/, '选对象却填了裸文本 ⇒ 报错');
    assert.ok(ENTRY_TYPES.includes('object'), '类型名单里要有"嵌套"这一档（界面那个下拉读的就是它）');
    // 抄错要报出来（不静默当字符串）
    assert.throws(() => nodeFromEntry('x', '{a: 1}'), /不是合法 JSON/, '半个 JSON 要报错，不许当字符串存');
    assert.throws(() => nodeFromEntry('', 'v'), /先填字段名/, '填了值却没名字 ⇒ 报错');
    assert.throws(() => nodeFromEntry('n', 'abc', 'number'), /不是数字/);
    assert.throws(() => nodeFromEntry('b', 'yes', 'boolean'), /true 或 false/);
});

test('★ 待定行进了文档：`collectFormModel` 按同一套规则收（没点 ✓ 也不会悄悄丢）', () => {
    const model = buildFormModel({ hdu: { years: { 2024: { contestUser: 'teamD' } } } });
    const years = model.children[0].children[0];            // hdu → years
    const pending = pendingEntry();
    pending.key = '2026';
    pending.value = '{"contestUser": "teamA", "contestPassword": "…"}';
    years.children.push(pending);
    const out = collectFormModel(model);
    assert.deepEqual(out.hdu.years['2026'], { contestUser: 'teamA', contestPassword: '…' },
        '没点 ✓ 但填了内容 ⇒ 保存时按"自动"定型（不许静默丢）');
    // 两格都空 ⇒ 当没加（连键都不写）
    const blank = pendingEntry();
    years.children.push(blank);
    assert.deepEqual(collectFormModel(model), out, '空着的待定行不写进文件');
    // 填了值却没名字 ⇒ 报错（`collectGroup` 那句"没填名字"走的就是它）
    const noName = pendingEntry();
    noName.value = 'x';
    years.children.push(noName);
    assert.throws(() => collectFormModel(model), /没填名字|先填字段名/);
});
