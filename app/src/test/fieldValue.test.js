// ================================================================
// 来源层测试（core/fieldValue.js）
//
// 钉住三件事：
//   1. **记值**：去重、忽略空值、上限淘汰
//   2. **解释**：投影值 + 来源 + 理由 + 候选列表（界面就用它）
//   3. **不改缓存字段**（兼容既有缓存与老数据的关键）
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    MAX_VALUES_PER_FIELD,
    WRITABLE_VALUE_FIELDS,
    BACKFILL_SRC,
    addSourceValue,
    backfillNodeValues,
    backfillStateValues,
    normalizeStateValues,
    recordIncoming,
    explainField,
    applyProjection,
    readField,
    readFieldInfo,
    setDerivedOverride,
    removeManualValue,
    accountOfEntry
} from '../core/fieldValue.js';
// 防漂移：core 的字段清单必须与"导入可写白名单"一致（两边各有一份，见注释）
import { WRITABLE_FIELDS } from '../features/AutoImport/constants.js';
import { projectField } from '../core/trust.js';

function node(extra = {}) {
    return { type: 'P', name: '', values: {}, ...extra };
}

const trust = {
    categoryRank: ['manual', 'board', 'script', 'derived'],
    sources: {
        'pta:x': { kind: 'board', rank: 30 },
        'srk:x': { kind: 'script', rank: 20 },
        manual: { kind: 'manual', rank: 100 }
    },
    fieldPrefer: {}
};

// ---- 记值 ----

// ---- 账户标签归一化（唯一一处） ----
test('accountOfEntry：缺省/空 = 客观那条，其余一律字符串化', () => {
    assert.equal(accountOfEntry({ account: 'k1' }), 'k1');
    assert.equal(accountOfEntry({}), '');
    assert.equal(accountOfEntry({ account: null }), '');
    assert.equal(accountOfEntry({ account: undefined }), '');
    assert.equal(accountOfEntry(null), '');
    assert.equal(accountOfEntry({ account: 0 }), '0');
});

test('addSourceValue：记下"谁说了什么"', () => {
    const n = node();
    assert.equal(addSourceValue(n, 'name', 'All Closed', 'srk:x', { at: 'T1' }), true);
    assert.deepEqual(n.values.name, [{ v: 'All Closed', src: 'srk:x', at: 'T1' }]);
});

test('空值与缺来源不记（否则来源层全是噪声）', () => {
    const n = node();
    assert.equal(addSourceValue(n, 'name', '', 'srk:x'), false);
    assert.equal(addSourceValue(n, 'name', '   ', 'srk:x'), false);
    assert.equal(addSourceValue(n, 'name', null, 'srk:x'), false);
    assert.equal(addSourceValue(n, 'name', 'x', ''), false);
    assert.deepEqual(n.values, {});
});

test('同来源同值只留一条（刷新时间）；同来源改了口则都留', () => {
    const n = node();
    addSourceValue(n, 'ratio', '4.61', 'pta:x', { at: 'T1' });
    addSourceValue(n, 'ratio', '4.61', 'pta:x', { at: 'T2' });
    assert.equal(n.values.ratio.length, 1);
    assert.equal(n.values.ratio[0].at, 'T2', '同值要刷新时间');

    addSourceValue(n, 'ratio', '4.70', 'pta:x', { at: 'T3' });
    assert.equal(n.values.ratio.length, 2, '来源自己改了口，历史要留');
});

test('超上限时丢最旧的', () => {
    const n = node();
    for (let i = 0; i < MAX_VALUES_PER_FIELD + 3; i++) {
        addSourceValue(n, 'name', `v${i}`, `src${i}`, { at: `T${String(i).padStart(2, '0')}` });
    }
    assert.equal(n.values.name.length, MAX_VALUES_PER_FIELD);
    assert.equal(n.values.name[0].v, 'v3', '最旧的三条应当被淘汰');
    assert.equal(n.values.name[n.values.name.length - 1].v, `v${MAX_VALUES_PER_FIELD + 2}`);
});

test('recordIncoming：按白名单批量记，返回条数', () => {
    const n = node();
    const fields = { name: 'A', ratio: '4.61', remark: '不该记', status1: 1 };
    const n1 = recordIncoming(n, fields, 'pta:x', { at: 'T1', only: ['name', 'ratio'] });
    assert.equal(n1, 2);
    assert.deepEqual(Object.keys(n.values).sort(), ['name', 'ratio']);
});

// ---- 解释（界面用） ----

test('explainField：值 + 来源 + 理由 + 候选', () => {
    const n = node({ values: { ratio: [
        { v: '4.61', src: 'pta:x', at: 'T1' },
        { v: '4.60', src: 'srk:x', at: 'T1' }
    ] } });
    const e = explainField(n, 'ratio', trust);
    assert.equal(e.value, '4.61');
    assert.equal(e.src, 'pta:x');
    assert.match(e.reason, /权威榜单优先/);
    assert.equal(e.count, 2);
    assert.equal(e.all.filter(x => x.selected).length, 1);
});

test('explainField：没有来源值时给出空状态与理由', () => {
    const e = explainField(node(), 'ratio', trust);
    assert.equal(e.value, '');
    assert.equal(e.count, 0);
    assert.equal(e.reason, '没有来源值');
});

test('B3 值全在范围外时：不谎报"来源未记录"，理由要说清是范围问题', () => {
    // 场景：字段只有 k2 的来源值，而当前"在查看"的是 k1（树上会显示借来的缓存值）。
    // 兜底按 `projected.empty` 触发的话，会把缓存值伪造成"v7 遗留"，面板只输出
    // 「来源：未记录」，真实来源、账户标记、优先/不用按钮全被吞掉。
    const n = node({
        name: '缓存名字',
        values: { name: [{ v: '别人的名字', src: 'srk:x', at: 'T1', account: 'k2' }] }
    });
    const accounts = {
        local: { id: 'local', name: '本机', isLocal: true, mappings: [] },
        k1: { id: 'k1', name: '主号', mappings: [] },
        k2: { id: 'k2', name: '小号', mappings: [] }
    };
    const e = explainField(n, 'name', trust, { viewingAccount: 'k1', accounts });

    assert.equal(e.src, '', '没有选中的来源（范围内确实没有值）');
    assert.match(e.reason, /不属于当前「在查看」的账户/, `理由要说清是范围问题：${e.reason}`);
    assert.equal(e.stored.length, 1, '真实来源仍然要交出去（面板要能列出并操作）');
    assert.equal(e.stored[0].account, 'k2', '带账户标记');
    assert.equal(e.stored[0].src, 'srk:x');
});

test('缓存里有值、来源层没有 → 就是"没有出处"，不编一句 v7 遗留', () => {
    // **没有老数据**（读路径不留回退兜底）：这种状态在新数据里不该出现；
    // 真出现了也如实说：不把缓存值包装成"来源：未记录（v7 遗留…）"。
    const n = node({ name: '缓存名字' });
    const e = explainField(n, 'name', trust, {});
    assert.equal(e.count, 0, '一条来源值都没有');
    assert.doesNotMatch(String(e.reason), /v7 遗留/);
    assert.equal(e.stored.length, 0);
});

test('B3 值全被标"不用"时：理由说"被标了不用"，不是"没有来源值"', () => {
    const n = node({ values: { ratio: [{ v: '4.61', src: 'pta:x', at: 'T1', invalid: true }] } });
    const e = explainField(n, 'ratio', trust);
    assert.match(e.reason, /都被标了「不用」/, `理由：${e.reason}`);
});

test('手改**只保留一条**（替换旧的，不攒历史）', () => {
    // 连续手改几次，manual 值就会攒出几条；手改表达的是"我现在要什么"，
    // 过时的手改值既没用又危险 —— manual 优先级最高，过时的那条会一直压着其它来源。
    const n = node();
    addSourceValue(n, 'ratio', '4.61', 'pta:x');
    addSourceValue(n, 'ratio', '5.00', 'manual', { at: 'T1' });
    addSourceValue(n, 'ratio', '6.00', 'manual', { at: 'T2' });
    addSourceValue(n, 'ratio', '7.00', 'manual', { at: 'T3' });
    const manuals = n.values.ratio.filter(x => x.src === 'manual');
    assert.equal(manuals.length, 1, '手改永远只留一条');
    assert.equal(manuals[0].v, '7.00', '留下的是最新那次');
    assert.equal(n.values.ratio.filter(x => x.src === 'pta:x').length, 1, '脚本来源的历史不受影响');
});

test('手改同一个值两次 → 不重复，只刷新时间', () => {
    const n = node();
    addSourceValue(n, 'ratio', '5.00', 'manual', { at: 'T1' });
    assert.equal(addSourceValue(n, 'ratio', '5.00', 'manual', { at: 'T2' }), false);
    assert.equal(n.values.ratio.length, 1);
    assert.equal(n.values.ratio[0].at, 'T2', '时间刷新成最新');
});

// ---- 手改值**按账户各留一条** ----
// `addSourceValue` 的 manual 分支若写成无条件 `filter(x => x.src !== 'manual')`，
// 会把**所有账户**的手改值一并抹掉 ⇒ "我改一下、队友改一下"，最后只剩谁后改谁那条。
// 意图是各账户互不干扰、各自增删改。
test('手改值按账户各留一条：改我的不动队友的', () => {
    const n = node();
    addSourceValue(n, 'ratio', '4.61', 'pta:x', { at: 'T0' });
    addSourceValue(n, 'ratio', '5.00', 'manual', { at: 'T1', account: 'k1' });
    addSourceValue(n, 'ratio', '6.00', 'manual', { at: 'T2', account: 'k2' });
    const manuals = n.values.ratio.filter(x => x.src === 'manual');
    assert.equal(manuals.length, 2, '两个账户各有自己的一条');
    assert.equal(manuals.find(x => x.account === 'k1').v, '5.00');
    assert.equal(manuals.find(x => x.account === 'k2').v, '6.00');

    // 我再改一次：**只替换我那条**，队友那条原样
    addSourceValue(n, 'ratio', '7.00', 'manual', { at: 'T3', account: 'k1' });
    const again = n.values.ratio.filter(x => x.src === 'manual');
    assert.equal(again.length, 2);
    assert.equal(again.find(x => x.account === 'k1').v, '7.00');
    assert.equal(again.find(x => x.account === 'k2').v, '6.00', '队友那条一个字节都没动');
});

test('手改值：同账户同值 → 只刷时间；跨账户同值 → 各留一条', () => {
    const n = node();
    addSourceValue(n, 'ratio', '5.00', 'manual', { at: 'T1', account: 'k1' });
    assert.equal(addSourceValue(n, 'ratio', '5.00', 'manual', { at: 'T2', account: 'k1' }), false,
        '同一个账户同一个值 → 不新增，只刷时间');
    assert.equal(addSourceValue(n, 'ratio', '5.00', 'manual', { at: 'T3', account: 'k2' }), true,
        '另一个账户即使值相同也是**另一条**（归属不同）');
    assert.equal(n.values.ratio.filter(x => x.src === 'manual').length, 2);
});

test('手改值：无账户（客观）那条与有账户的互不影响', () => {
    const n = node();
    addSourceValue(n, 'ratio', '5.00', 'manual', { at: 'T1', account: 'k1' });
    addSourceValue(n, 'ratio', '6.00', 'manual', { at: 'T2' });          // 客观那条
    const manuals = n.values.ratio.filter(x => x.src === 'manual');
    assert.equal(manuals.length, 2);
    assert.equal(manuals.find(x => !x.account).v, '6.00');
});

// ---- 回填（老节点补出处） ----

test('字段清单与导入可写白名单一致（两边各一份，靠这条防漂移）', () => {
    assert.deepEqual([...WRITABLE_VALUE_FIELDS].sort(), [...WRITABLE_FIELDS].sort());
});

// ================================================================
// 线索进值 + 按"来源+值+线索"合并（补映射后**改账户**，不叠条）
// ================================================================

const CLUE = { source: 'qoj', field: '提交者', value: 'alice' };

test('P3：值上会存下线索（没有线索就不写这个键）', () => {
    const n = node();
    addSourceValue(n, 'status', 'AC', 'qoj', { at: 'T1', clue: CLUE });
    assert.deepEqual(n.values.status[0].clue, CLUE);
    // 空白线索 = 没线索（不写键，保持老数据形状）
    const m = node();
    addSourceValue(m, 'status', 'AC', 'qoj', { at: 'T1', clue: { source: 'qoj', field: '提交者', value: '  ' } });
    assert.equal('clue' in m.values.status[0], false);
});

test('P3：同一个线索、同一个值、换了账户 → **改账户**，不加第二条', () => {
    const n = node();
    addSourceValue(n, 'status', 'AC', 'qoj', { at: 'T1', clue: CLUE, account: '' });
    assert.equal(n.values.status.length, 1);
    // 补上映射后重新导入：这次认出了 alice
    assert.equal(addSourceValue(n, 'status', 'AC', 'qoj', { at: 'T2', clue: CLUE, account: 'k1' }), false);
    assert.equal(n.values.status.length, 1, '★ 不叠条');
    assert.equal(n.values.status[0].account, 'k1', '账户被改写');
    assert.equal(n.values.status[0].at, 'T2', '时间刷新');
    // 反过来：映射被删掉 → 认不出 → 回落客观（删掉 account 键）
    addSourceValue(n, 'status', 'AC', 'qoj', { at: 'T3', clue: CLUE, account: '' });
    assert.equal(n.values.status.length, 1);
    assert.equal('account' in n.values.status[0], false, '认不出 → 客观（键不写）');
});

test('P3：线索不同 → 两条（一次榜单里两个队报了同一个值，不能合并）', () => {
    const n = node();
    const clueA = { source: 'pta', field: 'teamFid', value: '603' };
    const clueB = { source: 'pta', field: 'teamFid', value: '604' };
    addSourceValue(n, 'ratio', '50', 'pta', { at: 'T1', clue: clueA, account: 'kA' });
    addSourceValue(n, 'ratio', '50', 'pta', { at: 'T1', clue: clueB, account: 'kB' });
    assert.equal(n.values.ratio.length, 2, '两个队各一条');
    assert.deepEqual(n.values.ratio.map(x => x.account), ['kA', 'kB']);
});

test('P3：没有线索时同来源同值只留一条', () => {
    const n = node();
    addSourceValue(n, 'ratio', '4.61', 'pta:x', { at: 'T1' });
    addSourceValue(n, 'ratio', '4.61', 'pta:x', { at: 'T2' });
    assert.equal(n.values.ratio.length, 1);
    assert.equal(n.values.ratio[0].at, 'T2');
});

// ================================================================
// ★ `v9.4.15`（用户 2026-10-15 看着值级面板说的）：**每组替换，而不是合并**
//
// 病根（三症状同一个）：同一条记录后来改了口（QOJ 相对时间 `00:31:01` → 绝对时刻）时，
// 老实现按"来源 + **值** + 线索"找同一条 ⇒ 找不到 ⇒ 叠出第二条；投影在来源类别/rank/优先表
// 全相同时只能比 `at`，平手就是"先到者胜"（`trust.js:isBetter` 刻意稳定）⇒ 旧值永远留着；
// 而重导又因为"新值已经在列表里"报跳过。
// 口径：**组 = 同来源 + 同线索 + 同账户**，组内后来的值就地替换；账户不同 ⇒ 不同组。
// ================================================================

test('★ 同一条记录改了口 ⇒ **整组替换**（不叠第二条，且投影采纳新值）', () => {
    const n = node();
    addSourceValue(n, 'time', '00:31:01', 'qoj', { at: 'T1', clue: CLUE, account: 'k1' });
    assert.equal(n.values.time.length, 1);

    // 同一条提交（同一个线索、同一个账户）后来报的是绝对时刻 ⇒ 就地替换
    // ⚠️ 返回值只回答"多没多一条" ⇒ 替换是 **false**（不是新增）
    assert.equal(addSourceValue(n, 'time', '2026.10.14 12:30:59', 'qoj',
        { at: 'T2', clue: CLUE, account: 'k1' }), false);
    assert.equal(n.values.time.length, 1, '★ 只留一条（别再叠出"未采用"的第二条）');
    assert.equal(n.values.time[0].v, '2026.10.14 12:30:59', '★ 值被换掉了');
    assert.equal(n.values.time[0].at, 'T2', '时间戳跟着刷新');
    // 投影（应用真正显示的那个值）必须跟着变成新的
    // ⚠️ `projectField(field, values, trust)` —— 前两个参数是（字段名, 那格的值列表）
    assert.equal(projectField('time', n.values.time, trust).value,
        '2026.10.14 12:30:59', '★ 树上显示的就是新值（老实现会一直显示旧的相对时间）');
});

test('★ 已经叠出来的"第二条"（老实现留下的）：重导一次就收掉', () => {
    // 手工造出"卡住"那种形态：同来源+同线索+同账户，两条不同值并存，**时间戳一样**
    // （⚠️ 时间戳一样才会走到"先到者胜"；不一样时投影本来就取新的那条 —— 实测卡住的那 12 条
    //   属于前者：同一个包的 `at` 是包级时间戳，两条会被刷成同一个值）
    const n = node();
    n.values.time = [
        { v: '00:31:01', src: 'qoj', at: 'T2', account: 'k1', clue: CLUE },
        { v: '2026.10.14 12:30:59', src: 'qoj', at: 'T2', account: 'k1', clue: CLUE }
    ];
    assert.equal(projectField('time', n.values.time, trust).value, '00:31:01',
        '（前提）同分"先到者胜" ⇒ 老实现显示的是旧的相对时间');
    // 下一次导入（哪怕是"跳过"那条路径）会用组里已有的那个值刷新 ⇒ 多余的那条被收掉
    addSourceValue(n, 'time', '2026.10.14 12:30:59', 'qoj', { at: 'T3', clue: CLUE, account: 'k1' });
    assert.equal(n.values.time.length, 1, '★ 一组只留一条');
    assert.equal(n.values.time[0].v, '2026.10.14 12:30:59');
    assert.equal(projectField('time', n.values.time, trust).value, '2026.10.14 12:30:59',
        '★ 重导之后显示的终于是新值（这就是那 12 行能自己好过来的机制）');
});

test('★ 同一条记录、**不同账户** ⇒ 各留一条（每组还要按账户分组）', () => {
    const n = node();
    addSourceValue(n, 'ratio', '50', 'pta', { at: 'T1', clue: CLUE, account: 'kA' });
    addSourceValue(n, 'ratio', '70', 'pta', { at: 'T2', clue: CLUE, account: 'kB' });
    assert.equal(n.values.ratio.length, 2, '★ 两个账户各一条，谁也不顶掉谁');
    assert.deepEqual(n.values.ratio.map(x => x.account), ['kA', 'kB']);
    // 同一个账户再改口 ⇒ 只换它自己那条
    addSourceValue(n, 'ratio', '80', 'pta', { at: 'T3', clue: CLUE, account: 'kB' });
    assert.equal(n.values.ratio.length, 2);
    assert.deepEqual(n.values.ratio.map(x => x.v), ['50', '80']);
});

// ================================================================
// 列表型字段（tags）—— 值存成字符串数组，按**内容**比较
// ================================================================

test('P6：tags 的来源值存成字符串数组（不是 `[object Object]`、也不是 join 成串）', () => {
    const n = node();
    addSourceValue(n, 'tags', [{ id: 't1', text: 'dp', color: '红' }, { text: 'math' }],
        'pta:x', { at: 'T1' });
    assert.deepEqual(n.values.tags[0].v, ['dp', 'math']);
    assert.equal(typeof n.values.tags[0].v, 'object');
});

test('P6：两个来源说"同一份标签" → 合并（按内容比，不按引用）', () => {
    const n = node();
    addSourceValue(n, 'tags', ['dp', 'math'], 'srk:x', { at: 'T1' });
    addSourceValue(n, 'tags', [{ text: 'dp' }, { text: 'math' }], 'pta:x', { at: 'T1' });
    assert.equal(n.values.tags.length, 2, '不同来源各留一条（来源都留着）');
    const proj = projectField('tags', n.values.tags, trust);
    assert.equal(proj.reason, '2 个来源一致', '内容相同 → 合并成一个说法，不刷屏');
    assert.deepEqual(proj.value, ['dp', 'math']);
});

test('P6：标签顺序不同 = 不同说法（不替用户排序）', () => {
    const n = node();
    addSourceValue(n, 'tags', ['dp', 'math'], 'srk:x', { at: 'T1' });
    addSourceValue(n, 'tags', ['math', 'dp'], 'pta:x', { at: 'T1' });
    const proj = projectField('tags', n.values.tags, trust);
    assert.match(proj.reason, /另有/, '两种顺序都摆出来');
    assert.deepEqual(proj.value, ['math', 'dp'], '榜单来源胜出（board > script）');
    assert.match(proj.reason, /dp、math/, '理由里用人话写法显示另一种顺序');
});

test('P6：空标签列表不记（没有"值"可言）', () => {
    const n = node();
    assert.equal(addSourceValue(n, 'tags', [], 'pta:x', { at: 'T1' }), false);
    assert.equal(addSourceValue(n, 'tags', [{ text: '  ' }], 'pta:x', { at: 'T1' }), false);
    assert.equal(n.values.tags, undefined);
});

test('P6：存下来的数组是**拷贝**（不与入参共享，避免跨节点串味）', () => {
    const n = node();
    const input = ['dp'];
    addSourceValue(n, 'tags', input, 'pta:x', { at: 'T1' });
    input.push('被别人改了');
    assert.deepEqual(n.values.tags[0].v, ['dp']);
});

test('P6：explainField 的 stored 里是数组，且 selected 按内容判定', () => {
    const n = node({ values: { tags: [
        { v: ['dp', 'math'], src: 'pta:x', at: 'T1' },
        { v: ['图论'], src: 'srk:x', at: 'T1' }
    ] } });
    const info = explainField(n, 'tags', trust);
    assert.deepEqual(info.stored.map(x => x.v), [['dp', 'math'], ['图论']]);
    assert.equal(info.stored[0].selected, true, '被采用的那条（board 优先）标上');
    assert.equal(info.stored[1].selected, false);
});

test('P6：applyProjection **不**把标签列表写进缓存字段（形状不同，写了会搞坏 node.tags）', () => {
    const n = node({ tags: [{ id: 't1', text: '旧', color: '红' }],
        values: { tags: [{ v: ['dp'], src: 'pta:x', at: 'T1' }] } });
    const r = applyProjection(n, 'tags', trust);
    assert.equal(r.changed, false);
    assert.equal(r.skipped, 'list-shape');
    assert.deepEqual(n.tags, [{ id: 't1', text: '旧', color: '红' }], '缓存一个字节没动');
});

// ================================================================
// 派生字段上的"手动覆盖"（忽略 / 赛时通过 / 恢复自动计算）
// ================================================================

test('P7 setDerivedOverride：写下带账户的覆盖；传 null 就是"恢复自动计算"', () => {
    const n = node();
    assert.equal(setDerivedOverride(n, 'status2', 5, { at: 'T1', account: 'k1' }), true);
    assert.deepEqual(n.values.status2, [{ v: '5', src: 'manual', at: 'T1', account: 'k1' }]);

    // 同账户再设一次同值 → 幂等（不叠条）
    setDerivedOverride(n, 'status2', 5, { at: 'T2', account: 'k1' });
    assert.equal(n.values.status2.length, 1);
    assert.equal(n.values.status2[0].at, 'T2');

    // 清掉（恢复自动计算）→ 字段整个消失，不留空数组
    assert.equal(setDerivedOverride(n, 'status2', null, { account: 'k1' }), true);
    assert.equal(n.values.status2, undefined);
});

test('P7 removeManualValue：只删"这个账户"那条，别的来源与别的账户照旧', () => {
    const n = node({
        values: {
            status2: [
                { v: '5', src: 'manual', at: 'T1', account: 'k1' },
                { v: '4', src: 'manual', at: 'T2', account: 'k2' },
                { v: '3', src: 'qoj:x', at: 'T3' }
            ]
        }
    });
    assert.equal(removeManualValue(n, 'status2', 'k1'), true);
    assert.deepEqual(n.values.status2.map(x => x.src + '|' + (x.account || '')), ['manual|k2', 'qoj:x|']);
    assert.equal(removeManualValue(n, 'status2', 'k1'), false, '已经没有可删的了');
    assert.equal(removeManualValue(n, 'status2', 'k2'), true);
    assert.equal(removeManualValue(node(), 'status2', 'k1'), false, '没有来源层也不炸');
    assert.equal(removeManualValue(null, 'status2', 'k1'), false);
});

// ================================================================
// 视图层读取器（readField / readFieldInfo）
//
// **界面不直接读缓存字段**，而是按"本次查看范围"现算。
// 范围是**集合** —— 单账户是一个元素的集合，一队 3 人并排看是三个元素的集合。
// ================================================================

/** 一个节点的 ratio 有三个说法：A 账户、B 账户、以及客观（榜单） */
function scopeNode() {
    return node({
        ratio: '缓存里的值',
        values: {
            ratio: [
                { v: 'A 说的', src: 'pta:x', at: 'T1', account: 'kA' },
                { v: 'B 说的', src: 'srk:x', at: 'T2', account: 'kB' },
                { v: '客观说的', src: 'qoj:x', at: 'T3' }
            ]
        }
    });
}
const scopeTrust = {
    categoryRank: ['manual', 'board', 'script', 'derived'],
    sources: {
        'pta:x': { kind: 'board', rank: 30 },
        'srk:x': { kind: 'script', rank: 20 },
        'qoj:x': { kind: 'script', rank: 10 }
    },
    fieldPrefer: {}
};

test('P7 readField：单账户范围 → 只看"它的值 + 客观值"', () => {
    const n = scopeNode();
    assert.equal(readField(n, 'ratio', { trust: scopeTrust, viewingAccount: 'kA' }), 'A 说的',
        'A 的榜单值优先于客观的脚本值');
    assert.equal(readField(n, 'ratio', { trust: scopeTrust, viewingAccount: 'kB' }), 'B 说的',
        '换成 B，就是 B 的值（榜单值不属于 B，不进候选）');
});

test('P7 readField：**多账户范围**（一队 3 人并排看的那种）', () => {
    const n = scopeNode();
    // 把 A 和 B 都放进范围 → 两个人的值都是候选，按规则挑（A 的榜单 > B 的脚本）
    assert.equal(readField(n, 'ratio', { trust: scopeTrust, scopeAccounts: ['kA', 'kB'] }), 'A 说的');
    // 只放 B → B 的
    assert.equal(readField(n, 'ratio', { trust: scopeTrust, scopeAccounts: ['kB'] }), 'B 说的');
    // 空集合 = 只看客观值
    assert.equal(readField(n, 'ratio', { trust: scopeTrust, scopeAccounts: [] }), '客观说的');
});

test('P7 readField：不传范围 → 全都算候选；范围外的人看不到', () => {
    const n = scopeNode();
    assert.equal(readField(n, 'ratio', { trust: scopeTrust }), 'A 说的', '不过滤：仍是榜单值胜出');
    // 范围里放一个**不相干**的账户 → 只剩客观值
    assert.equal(readField(n, 'ratio', { trust: scopeTrust, scopeAccounts: ['kZ'] }), '客观说的');
});

test('P7 readField：没有来源值时退回缓存字段（v7 老数据照样显示）', () => {
    const legacy = node({ ratio: '28.19', values: {} });
    assert.equal(readField(legacy, 'ratio', { trust: scopeTrust, viewingAccount: 'kA' }), '28.19');
    // 列表字段退回时给数组，不给 ''
    const legacyTags = node({ tags: ['dp'], values: {} });
    assert.deepEqual(readField(legacyTags, 'tags', { trust: scopeTrust }), ['dp']);
});

test('P7 readFieldInfo：说清"值是哪来的"（投影 / 缓存兜底）', () => {
    const n = scopeNode();
    const info = readFieldInfo(n, 'ratio', { trust: scopeTrust, viewingAccount: 'kA' });
    assert.equal(info.value, 'A 说的');
    assert.equal(info.fromCache, false);
    assert.equal(info.empty, false);
    assert.ok(Array.isArray(info.all));

    const legacy = node({ ratio: '4.61', values: {}, importSource: 'pkg' });
    const legacyInfo = readFieldInfo(legacy, 'ratio', { trust: scopeTrust });
    assert.equal(legacyInfo.value, '4.61');
    assert.equal(legacyInfo.fromCache, true, '标记出"这是缓存兜底"（老数据）');

    const nothing = node({ values: {} });
    const emptyInfo = readFieldInfo(nothing, 'ratio', { trust: scopeTrust });
    assert.equal(emptyInfo.empty, true);
    assert.equal(emptyInfo.value, '');
});

test('P7 readField：绝不写数据（视图换范围不改任何东西）', () => {
    const n = scopeNode();
    const before = JSON.stringify(n);
    readField(n, 'ratio', { trust: scopeTrust, scopeAccounts: ['kB'] });
    readFieldInfo(n, 'ratio', { trust: scopeTrust, scopeAccounts: [] });
    assert.equal(JSON.stringify(n), before, '读一遍不改数据');
});

test('backfillNodeValues：用现值造一条出处，来源取 importSource', () => {
    const n = node({ name: '题A', ratio: '4.61', importSource: 'pta-1', lastModified: 'T9' });
    assert.equal(backfillNodeValues(n), 2);
    assert.deepEqual(n.values.name, [{ v: '题A', src: 'pta-1', at: 'T9' }]);
    assert.deepEqual(n.values.ratio, [{ v: '4.61', src: 'pta-1', at: 'T9' }]);
});

test('backfillNodeValues：没有 importSource 就记 local:v7', () => {
    const n = node({ name: '题A' });
    backfillNodeValues(n);
    assert.equal(n.values.name[0].src, BACKFILL_SRC);
});

test('backfillNodeValues：空值不造出处；已有出处不覆盖（幂等）', () => {
    const n = node({ name: '', ratio: '', problemId: 'A', link: '' });
    assert.equal(backfillNodeValues(n), 1, '只有 problemId 有值');
    assert.deepEqual(Object.keys(n.values), ['problemId']);

    const n2 = node({ name: '旧', values: { name: [{ v: '来源给的', src: 'srk:x', at: 'T1' }] } });
    assert.equal(backfillNodeValues(n2), 0, '已有出处 → 不动');
    assert.equal(n2.values.name.length, 1);
});

test('backfillNodeValues：tags 这类列表字段也能回填，且存的是**数组**（P6）', () => {
    const n = node({ name: 'x', tags: ['dp', 'math'] });
    backfillNodeValues(n);
    assert.deepEqual(n.values.tags[0].v, ['dp', 'math'],
        '列表值存成字符串数组（不是 join 出来的字符串）');
    // 对象数组（节点上真实的 tags 形状）也认
    const m = node({ name: 'y', tags: [{ id: 't1', text: '图论', color: '红' }, { text: 'dp' }] });
    backfillNodeValues(m);
    assert.deepEqual(m.values.tags[0].v, ['图论', 'dp'], '取 text 作为内容');
});

test('normalizeStateValues：补默认（sources/trust）并回填 —— 文件导入路径靠它', () => {
    // 从**文件**导入时构造的 state 就长这样：没有 sources/trust、节点没有 values
    const state = {
        rootId: 'r',
        nodes: { r: { id: 'r', type: 'O', name: '根' } },
        childOrder: { r: [] }
    };
    const r = normalizeStateValues(state);
    assert.equal(r.nodes, 1, '根节点的 name 被回填');
    assert.equal(state.sources.manual.kind, 'manual', '来源表补上 manual');
    assert.deepEqual(Object.keys(state.trust).sort(),
        ['categoryRank', 'fieldPrefer', 'groupPrefer', 'sources'],
        '优先级配置的形状就是 `normalizeTrust` 认的那四个键');
    assert.equal(state.nodes.r.values.name[0].v, '根');
});

test('normalizeStateValues：幂等；入参为空不炸', () => {
    const state = { nodes: { a: { id: 'a', type: 'P', name: 'A' } } };
    const r1 = normalizeStateValues(state);
    const r2 = normalizeStateValues(state);
    assert.equal(r1.fields, 1);
    assert.equal(r2.fields, 0, '第二次什么都不做');
    assert.deepEqual(normalizeStateValues(null), { nodes: 0, fields: 0 });
});

test('B5 加载时把坏掉的标签缓存修回规范形状（幂等）', () => {
    // 场景：某个 crate 把字符串数组直接写进 `node.tags`，
    // 标签管理器因此显示空白行、删除/上移报"标签不存在"。
    const state = {
        nodes: {
            p: { id: 'p', type: 'P', name: 'A', tags: ['dp', 'math'] },              // 坏形状
            q: { id: 'q', type: 'P', name: 'B', tags: [{ id: 't9', text: '图论', color: '红' }] } // 好形状
        },
        childOrder: {}
    };
    normalizeStateValues(state);
    assert.deepEqual(state.nodes.p.tags.map(t => t.text), ['dp', 'math'], '文字没变');
    assert.equal(state.nodes.p.tags.every(t => typeof t.id === 'string' && t.color), true, '补上了 id/color');
    assert.deepEqual(state.nodes.q.tags, [{ id: 't9', text: '图论', color: '红' }], '规范形状一字不碰');

    const snapshot = JSON.stringify(state.nodes);
    normalizeStateValues(state);
    assert.equal(JSON.stringify(state.nodes), snapshot, '第二次不再动（幂等）');
});

test('backfillStateValues：整棵树回填 + 登记来源（幂等）', () => {
    const state = {
        nodes: {
            a: { id: 'a', type: 'P', name: 'A', importSource: 'pkg-1', values: {} },
            b: { id: 'b', type: 'P', name: 'B', values: {} },
            c: { id: 'c', type: 'P', name: '', values: {} }
        },
        sources: {}
    };
    const r1 = backfillStateValues(state);
    assert.equal(r1.nodes, 2, 'c 没值，不回填');
    assert.equal(r1.fields, 2);
    assert.equal(state.sources['pkg-1'].kind, 'script');
    assert.equal(state.sources[BACKFILL_SRC].kind, 'manual');

    const r2 = backfillStateValues(state);
    assert.deepEqual(r2, { nodes: 0, fields: 0 }, '第二次什么都不做（幂等）');
});

// ---- 不改缓存字段（兼容关键） ----

test('applyProjection：没有来源值时**不动**缓存字段', () => {
    const n = node({ ratio: '9.99' });
    const r = applyProjection(n, 'ratio', trust);
    assert.equal(r.changed, false);
    assert.equal(n.ratio, '9.99', "不能把 '-' / 已有值抹成空（v8-plan §四 的调用契约）");
});

test('applyProjection：有来源值时才按投影写', () => {
    const n = node({ ratio: '9.99', values: { ratio: [{ v: '4.61', src: 'pta:x', at: 'T1' }] } });
    const r = applyProjection(n, 'ratio', trust);
    assert.equal(r.changed, true);
    assert.equal(n.ratio, '4.61');
    assert.match(r.reason, /唯一来源/);

    const again = applyProjection(n, 'ratio', trust);
    assert.equal(again.changed, false, '同值再投一次不该算变化（幂等）');
});
