// 小方框预览 + 题目分布统计：与树上那个数字**同一个口径**
// （这两处（题目小方框预览、题目分布统计）做细了麻烦 ——
//   所以这里只统一"读哪个字段"，**不做**各体系一套分档/配色。）
import { installDom } from './dom.mjs';
import { group, ok, report } from './harness.mjs';

installDom();

const { buildPNodeTitle, buildCNodeTitle } = await import('../../src/view/builders.js');
const registry = {
    groups: { 数值难度: { fields: ['cfDifficulty', 'atcoderDifficulty'], expect: 'expected',
                        anyOf: true, types: ['P'] } },
    fields: {
        cfDifficulty: { expect: 'expected', types: ['P'] },
        atcoderDifficulty: { expect: 'expected', types: ['P'] }
    }
};

function makeState(trust) {
    const p = { id: 'p', type: 'P', name: '题', problemId: 'A', cfDifficulty: 1200,
                atcoderDifficulty: 900, status1: 0, status2: 0, values: {} };
    const c = { id: 'c', type: 'C', name: '比赛', status1: 0, status2: 0, values: {} };
    return {
        rootId: 'o', nodes: { p, c }, childOrder: { p: [], c: ['p'] },
        parentOf: { p: 'c', c: null }, fieldRegistry: registry, trust,
        settings: { display: { boxCount: 15, boxDisplayMode: 'cf' } }, meta: {},
        sources: {}, accounts: {}, currentAccountId: 'local', viewingAccountId: 'local'
    };
}

group('小方框预览跟着口径走');
{
    const cf = makeState({ groupPrefer: {} });
    const box1 = buildCNodeTitle(cf, cf.nodes.c);
    ok(/1200/.test(box1), '默认（CF 口径）小方框里是 1200');

    const at = makeState({ groupPrefer: { 数值难度: 'atcoderDifficulty' } });
    const box2 = buildCNodeTitle(at, at.nodes.c);
    ok(/900/.test(box2), '切到 AtCoder 口径后小方框里变成 900');
    ok(!/>1200</.test(box2), '不再显示 CF 的 1200');
}

// ===============================================================
group('★ 判重模式：题目分布统计按**组**计数（同一道题的多个来源副本只算一次）');
// ===============================================================
// 「合并显示」下半：图上那些**手搓的计数**也要跟着判重模式走 ——
// 这里走**真实渲染**（`renderStatsChart`）：两个来源各有一份 cf 1200 的题、同属一组 ⇒
// 不去重那根柱子写 2，判重写 1。
{
    const statsCharts = await import('../../src/ui/stats/statsCharts.js');
    const holder = document.createElement('div');
    holder.id = 'stats-chart-dedup-probe';
    document.body.appendChild(holder);

    const mkTree = (countMode) => ({
        rootId: 'o',
        nodes: {
            o: { id: 'o', type: 'O' },
            c: { id: 'c', type: 'C', name: '比赛', values: {} },
            p1: { id: 'p1', type: 'P', name: '题1', problemId: 'A', ownerSynth: 'synth:g',
                  cfDifficulty: 1200, values: {} },
            p2: { id: 'p2', type: 'P', name: '题2', problemId: 'A', ownerSynth: 'synth:g',
                  cfDifficulty: 1200, values: {} }
        },
        childOrder: { o: ['c'], c: ['p1', 'p2'], p1: [], p2: [] },
        parentOf: { o: null, c: 'o', p1: 'c', p2: 'c' },
        fieldRegistry: registry, trust: { groupPrefer: {} },
        settings: { display: {}, stats: { countMode } }, meta: {},
        sources: {}, accounts: {}, currentAccountId: 'local', viewingAccountId: 'local'
    });
    /** 柱子上那个"这一档共几题"的数字（`renderBarChart` 的 `countLabel`） */
    const barCounts = () => holder.querySelectorAll('div')
        .map(d => String(d.textContent || '').trim())
        .filter(t => /^\d+$/.test(t));

    statsCharts.renderStatsChart(mkTree('plain'), 'c', 'cf', null, holder.id);
    ok(barCounts().includes('2'), '不去重 ⇒ 那根柱子算 **2** 条', barCounts().join(','));

    statsCharts.renderStatsChart(mkTree('dedup'), 'c', 'cf', null, holder.id);
    ok(barCounts().includes('1'), '★ 判重 ⇒ 同一组只算 **1** 条', barCounts().join(','));
    ok(!barCounts().includes('2'), '★ 不再把两个副本各算一次', barCounts().join(','));
}

report('小方框预览 + 题目分布统计（判重模式的计数）');
