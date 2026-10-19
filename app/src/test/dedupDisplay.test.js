// ================================================================
// 「合并显示」的显示口径（view/scope.js 的 displayColumnOf / viewDerivedDisplay /
// displayDerivedReader）。
//
// 一句话：`ui/dedup/summary.js` 写着「同组的 P/C 计数、**状态**与信息在**去重计数模式**下
// 才合并显示」，而**统计**侧接了这个口径（`core/query/stats.js` 的 `countModeOf`），
// **显示**侧也要照它走 —— 否则开了去重模式，状态栏的「我全 AC 数」变了，树上/检索却还是各显示各的
// （一道题在 A 平台 AC 了，B 平台的副本仍显示"未做"）。
//
// 这个文件钉三件事：
//   ① `dedup` ⇒ 读**组那份**；`plain`（含老存档缺键）⇒ 与 `viewDerived` **逐字相同**；
//   ② 没有组（没有合成节点 / 单元素组）⇒ 两模式同值（视图不变的回归锚）；
//   ③ ⚠️ **三处永远读"自己那份"**（编辑表单 / 导出 / 喂聚合的读取器）—— 源码级守卫。
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    displayColumnOf, viewDerivedDisplay, displayDerivedReader, viewDerived
} from '../view/scope.js';
import { groupKeyOf, dedupRepresentatives } from '../core/query/countMode.js';
import { clearDerivedMemo } from '../core/derive.js';
import { clearGroupMemo } from '../core/groupCompute.js';
import { MODE_PLAIN, MODE_DEDUP, SYNTH_PREFIX } from '../core/query/groupCount.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const trust = { categoryRank: ['manual', 'board', 'script', 'derived'], sources: { manual: { kind: 'manual', rank: 100 } }, fieldPrefer: {} };
const manual = (v, account, at) => ({ v, src: 'manual', at, account });

/**
 * 一棵有合成组的树：`synP`（合成组头）+ `p1` / `p2`（两个成员，指针指过去）。
 * `p1` 按下了「状态1 = 1」，`p2` 没按 ⇒ "自己那份"与"组那份"**必然不同**，正好对照。
 */
function synthState(countMode) {
    const st = {
        rootId: 'o',
        settings: { stats: { countMode } },
        nodes: {
            o: { id: 'o', type: 'O' },
            synP: { id: 'synP', type: 'P', synthKey: `${SYNTH_PREFIX}gp`, name: '合成题', values: {} },
            p1: { id: 'p1', type: 'P', ownerSynth: `${SYNTH_PREFIX}gp`, name: '题1', values: { status1: [manual('1', 'k1', 'T1')] } },
            p2: { id: 'p2', type: 'P', ownerSynth: `${SYNTH_PREFIX}gp`, name: '题2', values: { status1: [manual('0', 'k1', 'T1')] } }
        },
        childOrder: { o: ['synP', 'p1', 'p2'], synP: [], p1: [], p2: [] },
        parentOf: { o: null, synP: 'o', p1: 'o', p2: 'o' },
        accounts: { k1: { id: 'k1', name: '主号' } },
        sources: { manual: { kind: 'manual', rank: 100 } },
        trust,
        viewingAccountId: 'k1'
    };
    clearDerivedMemo();
    clearGroupMemo();
    return st;
}

/** 同一棵树，但**没有任何合成节点 / 指针**（这种树上显示一行都不该变） */
function noGroupState(countMode) {
    const st = synthState(countMode);
    delete st.nodes.synP.synthKey;
    delete st.nodes.p1.ownerSynth;
    delete st.nodes.p2.ownerSynth;
    clearDerivedMemo();
    clearGroupMemo();
    return st;
}

// ---- ① 模式 → 列 ----
test('displayColumnOf：去重 ⇒ `group`；不去重 / 老存档缺键 / 非法值 ⇒ `own`', () => {
    assert.equal(displayColumnOf(synthState(MODE_DEDUP)), 'group');
    assert.equal(displayColumnOf(synthState(MODE_PLAIN)), 'own');
    assert.equal(displayColumnOf({ settings: {} }), 'own', '老存档没有这个键 ⇒ own');
    assert.equal(displayColumnOf({ settings: { stats: { countMode: 'bogus' } } }), 'own', '非法值 ⇒ own');
    assert.equal(displayColumnOf(undefined), 'own', '不抛');
    assert.equal(displayColumnOf({}), 'own');
});

// ---- ② plain 必须与 `viewDerived` 逐字相同（回归锚）----
test('★ 不去重模式下 `viewDerivedDisplay` 与 `viewDerived` **逐字相同**（默认行为一个字没变）', () => {
    const st = synthState(MODE_PLAIN);
    for (const id of ['synP', 'p1', 'p2']) {
        for (const f of ['status1', 'status2', 'xcpcDifficulty', 'acTime']) {
            assert.deepEqual(viewDerivedDisplay(st, st.nodes[id], f), viewDerived(st, st.nodes[id], f),
                `${id}.${f}：plain 下必须同值`);
        }
    }
    // 老存档缺 `countMode` 也一样
    const old = synthState(MODE_PLAIN);
    old.settings = {};
    assert.deepEqual(viewDerivedDisplay(old, old.nodes.p2, 'status1'), viewDerived(old, old.nodes.p2, 'status1'));
});

// ---- ③ 去重 ⇒ 读组那份 ----
test('★ 去重模式下 `viewDerivedDisplay` 读的就是「组那份」（`{column:\'group\'}`）', () => {
    const st = synthState(MODE_DEDUP);
    // （前提）两列真的不一样：p2 自己没按，但 p1 按了 ⇒ 组那份是 1
    assert.equal(viewDerived(st, st.nodes.p2, 'status1'), 0, '自己那份：p2 没按');
    assert.equal(viewDerived(st, st.nodes.p2, 'status1', { column: 'group' }), 1, '组那份：p1 按了');
    // 结论：显示跟着模式切
    assert.equal(viewDerivedDisplay(st, st.nodes.p2, 'status1'), 1, '★ 去重模式 ⇒ 树上/检索显示 1');
    assert.equal(viewDerivedDisplay(st, st.nodes.p1, 'status1'), 1, '成员之间显示一致（组是同一份）');
    // 非 `GROUP_FIELDS` 的字段：两列同值 ⇒ 显示不变（难度不在组口径里）
    for (const f of ['xcpcDifficulty', 'acTime', 'lastSubmitTime']) {
        assert.deepEqual(viewDerivedDisplay(st, st.nodes.p2, f), viewDerived(st, st.nodes.p2, f), `${f} 不变`);
    }
});

test('回归锚：**没有合成节点**时，两种模式显示完全相同（视图不变）', () => {
    const plain = noGroupState(MODE_PLAIN);
    const dedup = noGroupState(MODE_DEDUP);
    for (const id of ['p1', 'p2']) {
        for (const f of ['status1', 'status2']) {
            assert.deepEqual(viewDerivedDisplay(dedup, dedup.nodes[id], f),
                viewDerivedDisplay(plain, plain.nodes[id], f), `${id}.${f}：没有组就没有差别`);
        }
    }
});

test('`displayDerivedReader` 与 `viewDerivedDisplay` 同值（检索那两个口子用的就是它）', () => {
    const st = synthState(MODE_DEDUP);
    const read = displayDerivedReader(st);
    assert.equal(read(st.nodes.p2, 'status1'), viewDerivedDisplay(st, st.nodes.p2, 'status1'));
    assert.equal(read(st.nodes.p2, 'status1'), 1, '去重 ⇒ 检索表里这题也显示已处理');
    const plain = synthState(MODE_PLAIN);
    assert.equal(displayDerivedReader(plain)(plain.nodes.p2, 'status1'), 0, '不去重 ⇒ 显示自己那份');
});

// ================================================================
// 图表那边的"计数"也要按组：`core/query/countMode.js` 的
//   `groupKeyOf` / `dedupRepresentatives`
// —— 统计图 / 热力图 / AC 列表 / 📊分布 的计数各是手搓的，不走 `groupCount()` 那套去重；
//    这里给它们一个**统一**的"每组只留一条"。
// ================================================================
test('groupKeyOf：成员看 `ownerSynth`、合成节点看 `synthKey`、都没有 ⇒ 空串（自成一组）', () => {
    assert.equal(groupKeyOf({ ownerSynth: 'synth:g1' }), 'synth:g1');
    assert.equal(groupKeyOf({ synthKey: 'synth:g2' }), 'synth:g2', '合成节点用 synthKey');
    assert.equal(groupKeyOf({ ownerSynth: 'synth:g1', synthKey: 'synth:g2' }), 'synth:g1',
        '两个都有时以指针为准（成员身份）');
    assert.equal(groupKeyOf({ id: 'p9' }), '', '没有指针也不是合成节点 ⇒ 自成一组');
    assert.equal(groupKeyOf(null), '', '不抛');
});

test('dedupRepresentatives：**不去重 ⇒ 原样返回同一个数组**（零开销、零变化）', () => {
    const st = { settings: { stats: { countMode: MODE_PLAIN } } };
    const list = [{ id: 'a', ownerSynth: 'g' }, { id: 'b', ownerSynth: 'g' }];
    assert.equal(dedupRepresentatives(st, list), list, 'plain 下必须是**同一个引用**（连复制都省掉）');
    const old = { settings: {} };
    assert.equal(dedupRepresentatives(old, list), list, '老存档缺键也一样');
    assert.deepEqual(dedupRepresentatives(st, null), [], '非数组 ⇒ 空（不抛）');
});

test('★ 去重 ⇒ 每组只留一条；没组的节点一条不少（键用 id 兜底，互不影响）', () => {
    const st = { settings: { stats: { countMode: MODE_DEDUP } } };
    const list = [
        { id: 'p1', ownerSynth: 'g1' },
        { id: 'p9', ownerSynth: '' },                 // 自成一组（没有指针）
        { id: 'p2', ownerSynth: 'g1' },               // 与 p1 同组 ⇒ 去掉
        { id: 's1', synthKey: 'g1' },                 // 组头也是这一组 ⇒ 去掉
        { id: 'p3', ownerSynth: 'g2' },
        { id: 'p9b', ownerSynth: '' },                // 另一个"没组的" ⇒ 保留（id 兜底）
        { id: 'p4', ownerSynth: 'g1' }
    ];
    assert.deepEqual(dedupRepresentatives(st, list).map(n => n.id), ['p1', 'p9', 'p3', 'p9b'],
        '每组一条，且代表落在**第一次出现**的位置（顺序稳定）');
});

test('`hasValue`：代表优先挑"答得出这个问题"的那条（同分不动 ⇒ 稳定）', () => {
    const st = { settings: { stats: { countMode: MODE_DEDUP } } };
    const list = [
        { id: 'p1', ownerSynth: 'g1', d: 0 },
        { id: 'p2', ownerSynth: 'g1', d: 1500 },      // 更能回答 ⇒ 换成它
        { id: 'q1', ownerSynth: 'g2', d: 0 },
        { id: 'q2', ownerSynth: 'g2', d: 0 }          // 都不行 ⇒ 不动（保持第一条）
    ];
    const hasValue = (n) => n.d > 0;
    const kept = dedupRepresentatives(st, list, { hasValue });
    assert.deepEqual(kept.map(n => n.id), ['p2', 'q1'], '有难度的那条当代表；都没难度就取先出现的');
    assert.deepEqual(dedupRepresentatives(st, list).map(n => n.id), ['p1', 'q1'],
        '不给 `hasValue` ⇒ 一律取先出现的');
});

test('`keyOf`：自定义分组键（热力图要的是"**每天**每组一条"）', () => {
    const st = { settings: { stats: { countMode: MODE_DEDUP } } };
    const list = [
        { id: 'p1', ownerSynth: 'g1', day: '2026-01-01' },
        { id: 'p2', ownerSynth: 'g1', day: '2026-01-01' },   // 同组同天 ⇒ 去掉
        { id: 'p3', ownerSynth: 'g1', day: '2026-02-02' }    // 同组不同天 ⇒ 保留（各算一天）
    ];
    const kept = dedupRepresentatives(st, list, { keyOf: (n) => `${n.day}|${groupKeyOf(n)}` });
    assert.deepEqual(kept.map(n => n.id), ['p1', 'p3'], '同一天同组只留一条；跨天各留一条');
});

// ★ `v9.1.24` 真踩（用户 2026-10-13 实测）：**自定义 `keyOf` 拼了前缀之后，兜底就废了**。
//   症状：热力图上"一天最多 1"，而 AC 列表（走默认 `groupKeyOf`）一个都不少 ——
//   因为 `"<day>|"` 是**非空串**，`raw || '#'+id` 那道兜底**永不触发**
//   ⇒ 那一天所有**没有组**的题（散题 / 没进任何合成组的比赛下的题）共用同一个键。
//   **去掉哪一行会红**：把 `keyOf` 里的 `|| '#' + n.id` 去掉 ⇒ 这里只剩 1 条。
test('★ 自定义 `keyOf`：**没有组的**多条题不许被吞成一条（热力图的兜底）', () => {
    const st = { settings: { stats: { countMode: MODE_DEDUP } } };
    const list = [
        { id: 'a', day: '2026-08-07' },                     // 三条都没组（散题）
        { id: 'b', day: '2026-08-07' },
        { id: 'c', day: '2026-08-07' },
        { id: 'd', ownerSynth: 'g1', day: '2026-08-07' }    // 有组的照旧同组只留一条
    ];
    const keyOf = (n) => `${n.day}|${groupKeyOf(n) || '#' + n.id}`;
    assert.deepEqual(dedupRepresentatives(st, list, { keyOf }).map(n => n.id), ['a', 'b', 'c', 'd'],
        '★ 没组的三条各自成组（一条都不能少）；有组的那条照旧只留一条');

    // 反证：**不拼 id** 的老写法会把这一天吞成 1 条（这就是那个 bug 的形状）
    const buggy = (n) => `${n.day}|${groupKeyOf(n)}`;
    assert.deepEqual(dedupRepresentatives(st, list, { keyOf: buggy }).map(n => n.id), ['a', 'd'],
        '（反证）老写法下这一天只剩 1 条散题 —— 热力图"一天最多 1"就是这么来的');
});

// ================================================================
// 端到端：**树上那个「📊分布」**（`view/stats.js` 的 `getCStatusDistribution`）
// —— 它也是手搓的计数，得跟着判重模式走：状态读组那份 + 每组只算一次。
// ================================================================
test('★ 📊分布：不去重 ⇒ 每人各算一格；判重 ⇒ 同组只算一格、状态取合并后的', async () => {
    const { getCStatusDistribution } = await import('../view/stats.js');
    /** 两个成员挂在一个 C 下面（p1 处理过、p2 没处理） */
    const makeTree = (countMode, ids = ['p1', 'p2']) => {
        const st = synthState(countMode);
        st.rootId = 'o';
        st.nodes = { o: { id: 'o', type: 'O' }, cA: { id: 'cA', type: 'C', name: '比赛A' } };
        for (const id of ids) {
            st.nodes[id] = {
                id, type: 'P', name: id, ownerSynth: `${SYNTH_PREFIX}gp`,
                values: id === 'p1'
                    ? { status2: [manual('3', 'k1', 'T1')] }     // 过了（3 = 已完成那档）
                    : { status2: [manual('1', 'k1', 'T1')] }     // 没过
            };
        }
        st.childOrder = { o: ['cA'], cA: [...ids] };
        for (const id of ids) st.childOrder[id] = [];
        st.parentOf = { o: null, cA: 'o' };
        for (const id of ids) st.parentOf[id] = 'cA';
        clearDerivedMemo();
        clearGroupMemo();
        return st;
    };
    const totalOf = (s) => s.split('|').reduce((n, one) => n + (Number((one.split(':')[1] || '').trim()) || 0), 0);

    const plain = makeTree(MODE_PLAIN);
    const plainOut = getCStatusDistribution(plain, plain.nodes.cA);
    assert.equal(totalOf(plainOut), 2, `不去重 ⇒ 两条各算一格（实际 ${plainOut}）`);

    const dedup = makeTree(MODE_DEDUP);
    const dedupOut = getCStatusDistribution(dedup, dedup.nodes.cA);
    // ★ **2026-10-07 统一口径**：📊分布 与 P 桶 / C 桶走**同一份组划分**（`collectGroups`），
    //   不再按"原始组键"另算一套。这个夹具里 `ownerSynth` 指向的合成节点**不存在**（悬空键）
    //   ⇒ `collectGroups` 按"悬空指针 ⇒ 单元素组"处理 ⇒ 两条各自成组、各算一格
    //   （以前 dedup 的分布会把它们并成一组、只算一格 —— 那条口径已废）。
    assert.equal(totalOf(dedupOut), 2,
        `★ 统一组划分后：悬空键各自成组 ⇒ 两条各算一格（实际 ${dedupOut}）`);
    assert.equal(dedupOut, plainOut, '★ 与 plain 逐字相同（同一划分、同一取值口径）');
});

// ================================================================
// ⚠️ 边界守卫：这三处**永远读"自己那份"**，不许换成显示读取器
//
//   ① `ui/G_modal/editForm.js`      —— 表单默认值：填进去的组那份一保存就写成自己那份（污染数据）；
//   ② `handlers/H4_exportFormats.js` —— 导出的是数据，不该随显示开关变；
//   ③ `view/stats.js` 的 `derivedReader` —— 那是**喂给聚合**的输入，聚合自己按 countMode 去重
//      （把它换成组那份＝合并两次，且会被当输入喂回派生表 ⇒ 震荡）。
// ================================================================
test('★ 源码级：编辑表单 / 导出 / 喂聚合的读取器**都不许**用显示读取器', () => {
    const files = [
        ['src/ui/G_modal/editForm.js', '编辑表单默认值'],
        ['src/handlers/H4_exportFormats.js', '导出']
    ];
    const DISPLAY_CALL = /(viewDerivedDisplay|displayDerivedReader|displayColumnOf)\s*\(/;
    for (const [rel, what] of files) {
        const src = fs.readFileSync(path.join(REPO, rel), 'utf8');
        // ⚠️ 只认**调用**（带括号）—— 注释里提到这几个名字是**故意的**（那几处正是要提醒
        //    "别换成显示读取器"），按裸名字匹配会把这些说明文字当成违规。
        assert.doesNotMatch(src, DISPLAY_CALL,
            `${rel}（${what}）不许换成显示读取器 —— 那会把"组那份"写进数据 / 喂进聚合`);
        assert.match(src, /viewDerived\(/, `${rel}（${what}）应该在读"自己那份"（守卫别是空转）`);
    }
    // `view/stats.js` 要**分开看**：同一个文件里两种用法都对 ——
    //   · `derivedReader`（喂聚合）**必须**自己那份；
    //   · `getCStatusDistribution`（📊分布，手搓的计数）**应该**跟显示口径。
    const statsSrc = fs.readFileSync(path.join(REPO, 'src/view/stats.js'), 'utf8');
    const reader = /function derivedReader\(state\)\s*\{[\s\S]*?\n\}/.exec(statsSrc);
    assert.ok(reader, '找得到 `derivedReader` 函数体（守卫别是空转）');
    assert.match(reader[0], /viewDerived\(/, '`derivedReader` 读的是"自己那份"');
    assert.doesNotMatch(reader[0], DISPLAY_CALL,
        '`derivedReader`（喂聚合）不许用显示读取器 —— 会合并两次 + 被当输入喂回派生表');
});

test('源码级：树与检索**确实**接了显示读取器（不然这个开关等于没接）', () => {
    const must = [
        ['src/view/renderers.js', 'P 的颜色条 / 状态条'],
        ['src/view/builders.js', '小方框颜色'],
        ['src/features/ProblemSearch/index.js', '题目检索'],
        ['src/features/ContestSearch/view.js', '比赛检索']
    ];
    for (const [rel, what] of must) {
        const src = fs.readFileSync(path.join(REPO, rel), 'utf8');
        assert.match(src, /viewDerivedDisplay|displayDerivedReader/, `${rel}（${what}）要接上显示口径`);
    }
});

// ================================================================
// ⚠️ 边界守卫 ②：**谁允许直接读「靠前那份」**（名单制）
//
// 来由（2026-10-12 的实测）：`view/renderers.js` 的 C / W / S 状态条读的是 `viewDerived`
// （靠前那份），而树上别处读显示列 ⇒ 判重模式下 **11 / 2026** 个容器不一致
// （方向全是"组那份更大"：跨平台同一场比赛的另一份过了、这条不亮）。
//
// 这不是"哪个名字好听"的问题，而是**默认值问题**：绝大多数场合该用的那一个，由
// `displayColumnOf`（唯一判据）在 `viewDerivedDisplay` / `displayDerivedReader` 里选好了 ——
// 所以要读"靠前那份"是**例外**，例外得写下来。
//
// 判据很便宜：**不在名单里的文件，不许出现这四个底层读口的调用**。
// 想让新文件读它 ⇒ 往名单里加一行、并写明属于哪一类（例外三条 / 读的是没组值的列 / 机制内部）。
// 反过来名单也不许烂：写在名单里却已经不再读它的文件，这里会红。
// ================================================================
const DIRECT_READ_OK = {
    // —— 两列这个机制本身（实现内部）
    'src/view/scope.js': '两列的读口本体（ownColumnReader / viewDerived / displayColumnOf 都在这）',
    'src/core/groupValue.js': '组值算法本体（自己调自己）',
    'src/core/groupCompute.js': '组值的物化与读取入口',
    // —— 例外三条：**故意**不跟显示走
    'src/handlers/H4_exportFormats.js': '例外② 导出的是数据，不该随显示开关变',
    'src/ui/G_modal/editForm.js': '例外① 表单默认值（填进去就写成自己那份 ⇒ 污染数据）',
    'src/view/stats.js': '例外③ `derivedReader` 喂聚合（合并两次 + 会被当输入喂回派生表）',
    // —— 读的是**没有组值**的列（两列同值 ⇒ 读靠前那份就是对的，还便宜）
    'src/view/helpers.js': 'R 的 time / status —— 没有聚合器',
    'src/view/renderers.js': 'R 的 status（容器那两格已走显示口径）',
    'src/view/builders.js': '名字 / 标签 / 链接 / 时间等无组值列（难度·通过率·状态走显示口）',
    'src/ui/stats/statsCharts.js': '难度分布：无组值列读自己那份，有组值列走显示口',
    'src/handlers/H3_sort.js': '排序：有组值列走显示口，`viewValue` 只作来源层字段的回退',
    'src/features/ContestOverview/index.js': '`viewValue` 只作回退（`viewDerivedDisplay(...) ?? viewValue(...)`）',
    'src/ui/G_modal/sourceActions.js': '来源层值的操作面板：读的就是"这个节点的来源值"，不该合并',
    'src/ui/nodeinfo/nodeFields.js': '完整字段表**故意同时展示两列**（自己那份 + 组那份）',
    // 训练计划条：它读的是 `status2` / `acTime`，**两个都走显示口**（`viewDerivedDisplay(...) ?? viewValue(...)`）——
    //   `viewValue` 只是**回退**（与 ContestOverview 同一写法）。名单要的是"写下来"，这条就是那个书写。
    'src/ui/plan/planBar.js': '`viewValue` 只作回退（`viewDerivedDisplay(...) ?? viewValue(...)`，同 ContestOverview）',
    'src/ui/plan/planPage.js': '内层计划页：同上（`viewValue` 只作回退），读的是 `status2`/`acTime`/`xcpcDifficulty`',
    'src/ui/G_modal/G5_todoSheet.js': '按条件挑题：显示口径取值（viewDerivedDisplay ?? viewValue），状态/难度按屏上看到的挑',
    'src/ui/plan/planBlocks.js': '计划页各块：显示口径取值（viewDerivedDisplay ?? viewValue）作兜底，难度用分档后的名字',
    'src/ui/settings/natureRegistryPanel.js': '性质注册表那一栏的"用量"统计：显示口径取值'
        + '（`viewDerivedDisplay(...) ?? viewValue(...)`，同统计页）；`viewValue` 只作回退',
    'src/ui/plan/pageBadges.js': '副页方框上的计划强度角标：强度/完成态按**显示列**取'
        + '（`viewDerivedDisplay(...) ?? viewValue(...)`，与计划栏、内层页同一口径）；'
        + '`viewValue` 只作回退，且这里只读不写',
    // —— 已拍板：**故意**读本份（用户 2026-10-12）
    //   · 检索：`value`（来源层列）"写死读 own，暂时就这样设计"；派生列 `derived` 仍走显示口；
    //   · AC 三个视图：`acTime` 要的是"**我**什么时候过的"（本份），不是"这题什么时候被过"。
    'src/features/ProblemSearch/index.js': '**故意**：`value` 读者读本份（来源层列为准）；`derived` 走显示口',
    'src/features/ContestSearch/view.js': '**故意**：与题目检索同一决定',
    'src/ui/stats/ac/tracking.js': '**故意**：`acTime` = "我的 AC 时间"（本份）；`status2` 走显示口',
    'src/ui/stats/ac/heatmap.js': '**故意**：同上（`acTime` / 每日那条时间）',
    'src/ui/stats/ac/dailyList.js': '**故意**：同上（排序用 `acTime`）'
};

/** 扫 src/**（**去掉注释**再匹配：注释里提这些名字是故意的，按裸名字匹配会把说明文字当违规） */
function lowLevelReadFiles() {
    const hits = [];
    const walk = (dir) => {
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
            const abs = path.join(dir, ent.name);
            if (ent.isDirectory()) { walk(abs); continue; }
            const rel = path.relative(REPO, abs).replace(/\\/g, '/');
            if (!rel.endsWith('.js') || rel.includes('/test/')) continue;
            const code = fs.readFileSync(abs, 'utf8')
                .replace(/\/\*[\s\S]*?\*\//g, '')
                .replace(/^[ \t]*\/\/.*$/gm, '');
            if (/(viewValue|viewDerived|groupValueOf|groupValueOnDemand)\s*\(/.test(code)) hits.push(rel);
        }
    };
    walk(path.join(REPO, 'src'));
    return hits.sort();
}

test('★ 源码级：直接读「靠前那份」的文件必须上名单（默认要读显示列）', () => {
    const found = lowLevelReadFiles();
    assert.ok(found.length > 10, `扫到的文件太少（${found.length}）⇒ 守卫别是空转`);
    const unlisted = found.filter((rel) => !(rel in DIRECT_READ_OK));
    assert.deepEqual(unlisted, [],
        `这些文件直接读了底层读口（viewValue / viewDerived / groupValueOf）：\n  ${unlisted.join('\n  ')}\n`
        + '要用"屏幕上那一列"⇒ 换 `viewDerivedDisplay` / `displayDerivedReader`（判据只有 `displayColumnOf` 一处）；\n'
        + '确实要读「靠前那份」⇒ 把它加进本文件的 `DIRECT_READ_OK` 并写明属于哪一类场合。');
});

test('★ 源码级：名单不许烂（写进去的文件必须真的还在读它）', () => {
    const found = new Set(lowLevelReadFiles());
    const stale = Object.keys(DIRECT_READ_OK).filter((rel) => !found.has(rel));
    assert.deepEqual(stale, [], `名单里这些文件已经不读了（改完记得删掉名单项）：\n  ${stale.join('\n  ')}`);
});

// ================================================================
// ★ 逐字段"取哪一份"（设置里的 `settings.display.fieldColumn`）—— **收法甲**
//
// 覆盖**只在判重模式下生效**：不判重却按组读 ⇒ 每次读那格都要把整棵树的组值算一遍
// （真包 ~750ms），而"`plain` 下不许触发任何聚合"是一条硬规矩（`perfGuards.test.js` ⑦）。
//
// ⚠️ 写这类测试要**换一个新的 `settings` 对象**（不是就地改一格）：`scopeOpts` 按 state 记忆化，
//    比的是引用 —— 与应用里"改设置走 immer ⇒ 新对象"同形。
// ================================================================
test('★ 逐字段覆盖：判重模式下 own / group 都能改（默认 = 组那份）', () => {
    const st = synthState(MODE_DEDUP);
    st.settings = { stats: { countMode: MODE_DEDUP }, display: { fieldColumn: {} } };
    assert.equal(viewDerivedDisplay(st, st.nodes.p2, 'status1'), 1, '默认：判重 ⇒ 组那份（p1 按了）');

    st.settings = { ...st.settings, display: { fieldColumn: { status1: 'own' } } };
    clearDerivedMemo(); clearGroupMemo();
    assert.equal(viewDerivedDisplay(st, st.nodes.p2, 'status1'), 0, '覆盖 own ⇒ 读本份（p2 自己没按）');
    assert.equal(viewDerivedDisplay(st, st.nodes.p1, 'status1'), 1, 'p1 本份就是 1（覆盖不影响它）');

    st.settings = { ...st.settings, display: { fieldColumn: { status1: 'group' } } };
    clearDerivedMemo(); clearGroupMemo();
    assert.equal(viewDerivedDisplay(st, st.nodes.p2, 'status1'), 1, '覆盖 group ⇒ 组那份');
    assert.equal(viewDerivedDisplay(st, st.nodes.p2, 'status2'), viewDerived(st, st.nodes.p2, 'status2'),
        '没被覆盖的字段照旧走默认（组那份）');
});

test('★ 收法甲：**不判重**时逐字段覆盖一律无效（否则会触发聚合，违反硬规矩）', () => {
    const st = synthState(MODE_PLAIN);
    st.settings = { stats: { countMode: MODE_PLAIN }, display: { fieldColumn: { status1: 'group' } } };
    clearDerivedMemo(); clearGroupMemo();
    assert.equal(displayColumnOf(st, 'status1'), 'own', 'plain 下即使设了 group，也仍读本份');
    assert.equal(viewDerivedDisplay(st, st.nodes.p2, 'status1'), 0, '值就是本份');
    assert.equal(viewDerivedDisplay(st, st.nodes.p2, 'status1'),
        viewDerived(st, st.nodes.p2, 'status1'), '与"本份"逐字相同');
});

test('★ 覆盖值非法 / 老存档没有这一节 ⇒ 一律回落到模式默认', () => {
    const st = synthState(MODE_DEDUP);
    st.settings = { stats: { countMode: MODE_DEDUP }, display: { fieldColumn: { status1: 'bogus' } } };
    assert.equal(displayColumnOf(st, 'status1'), 'group', '非法值 ⇒ 模式默认（判重 ⇒ group）');
    const old = synthState(MODE_DEDUP);     // `settings` 里没有 `display`（老存档）
    assert.equal(displayColumnOf(old, 'status1'), 'group', '老存档缺键 ⇒ 不抛、按模式默认');
    assert.equal(displayColumnOf({ settings: {} }, 'status1'), 'own', '老存档 + 不判重 ⇒ 本份');
    assert.equal(displayColumnOf(undefined, 'status1'), 'own', '不抛');
});
