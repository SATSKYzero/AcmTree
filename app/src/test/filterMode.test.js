// ================================================================
// 「筛选模式」共用件（view/filterMode.js）
//
// 为什么要钉：这套规则**三处各写各的**（题目分布统计 / 训练强度热力图 / 比赛补题概览），
// 选项文案还有两份 —— 而且三份判据在"模式认不出来"时**行为不一样**
// （热力图那份会把所有题都滤掉，另两处原样返回）。抽成一份，
// 这里把四个模式的口径 + "认不出当无限制" 一起钉住，谁再抄一份就会红。
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { STATS_FILTER_MODES, DEFAULT_STATS_FILTER_MODE } from '../A_constants.js';
import { filterByMode, FILTER_OPTIONS, FILTER_MODE_CHECKS, normalizeFilterMode } from '../view/filterMode.js';

function makeState(over = {}) {
    const state = {
        rootId: 'o',
        nodes: {
            o: { id: 'o', type: 'O' },
            c: { id: 'c', type: 'C' },
            pSel: { id: 'pSel', type: 'P', problemId: 'A' },
            pProj: { id: 'pProj', type: 'P', problemId: 'B' },
            pNone: { id: 'pNone', type: 'P', problemId: 'C' }
        },
        childOrder: { o: ['c'], c: ['pSel', 'pProj', 'pNone'] },
        parentOf: { o: null, c: 'o', pSel: 'c', pProj: 'c', pNone: 'c' },
        settings: { stats: { statsFilterMode: STATS_FILTER_MODES.ALL } },
        pages: {}
    };
    return Object.assign(state, over);
}

const idsOf = list => list.map(n => n.id);

test('FILTER_OPTIONS：四个模式各一条，且与判据表同一套 key', () => {
    assert.deepEqual(FILTER_OPTIONS.map(o => o.value).sort(),
        Object.keys(FILTER_MODE_CHECKS).sort(), '选项与判据表必须一一对应');
    for (const o of FILTER_OPTIONS) {
        assert.ok(o.label && o.title, `${o.value} 要有 label 与 title`);
    }
});

test('normalizeFilterMode：认不出的模式 ⇒ 无限制（不是"全滤掉"）', () => {
    assert.equal(normalizeFilterMode('乱写的'), DEFAULT_STATS_FILTER_MODE);
    assert.equal(normalizeFilterMode(undefined), DEFAULT_STATS_FILTER_MODE);
    assert.equal(normalizeFilterMode(STATS_FILTER_MODES.SP_ANCESTOR), STATS_FILTER_MODES.SP_ANCESTOR);
});

test('无限制：**原样返回同一个数组**（不做无谓的复制）', () => {
    const s = makeState();
    const list = [s.nodes.pNone, s.nodes.pSel];
    assert.equal(filterByMode(s, list, STATS_FILTER_MODES.ALL), list);
});

test('无限制：未知模式也当无限制（否则会滤光）', () => {
    const s = makeState();
    const list = [s.nodes.pNone, s.nodes.pSel];
    assert.equal(filterByMode(s, list, '不存在的模式'), list);
});

test('仅主页覆盖：自身或祖先被选中才算', () => {
    const s = makeState();
    const all = [s.nodes.pSel, s.nodes.pProj, s.nodes.pNone];
    assert.deepEqual(idsOf(filterByMode(s, all, STATS_FILTER_MODES.SELECTED_ANCESTOR)), [],
        '谁都没选中 ⇒ 一道都不留');
    s.nodes.c.selected = true;      // 选中**祖先**（比赛）→ 三道题都算在自己人范围内
    assert.deepEqual(idsOf(filterByMode(s, all, STATS_FILTER_MODES.SELECTED_ANCESTOR)),
        ['pSel', 'pProj', 'pNone']);
    s.nodes.c.selected = false;
    s.nodes.pSel.selected = true;   // 只选中一道题
    assert.deepEqual(idsOf(filterByMode(s, all, STATS_FILTER_MODES.SELECTED_ANCESTOR)), ['pSel']);
});

test('副页映射覆盖：只认"该副页被选中 + 虚拟节点被选中"的那条引用', () => {
    const s = makeState({
        pages: {
            pg: {
                id: 'pg', selected: true,
                virtualIndex: { v1: { id: 'v1', refId: 'pProj', type: 'P', selected: true } }
            }
        }
    });
    const all = [s.nodes.pSel, s.nodes.pProj, s.nodes.pNone];
    assert.deepEqual(idsOf(filterByMode(s, all, STATS_FILTER_MODES.PAGE_MAPPING_ONLY)), ['pProj']);
    s.pages.pg.selected = false;    // 副页本身没被选中 → 不算覆盖
    assert.deepEqual(idsOf(filterByMode(s, all, STATS_FILTER_MODES.PAGE_MAPPING_ONLY)), []);
});

test('全局覆盖 = 主树选中 ∪ 副页映射覆盖', () => {
    const s = makeState({
        pages: {
            pg: {
                id: 'pg', selected: true,
                virtualIndex: { v1: { id: 'v1', refId: 'pProj', type: 'P', selected: true } }
            }
        }
    });
    s.nodes.pSel.selected = true;
    const all = [s.nodes.pSel, s.nodes.pProj, s.nodes.pNone];
    assert.deepEqual(idsOf(filterByMode(s, all, STATS_FILTER_MODES.SP_ANCESTOR)), ['pSel', 'pProj']);
});

test('模式缺省时读设置里的那一项', () => {
    const s = makeState();
    s.settings.stats.statsFilterMode = STATS_FILTER_MODES.SELECTED_ANCESTOR;
    s.nodes.pSel.selected = true;
    const all = [s.nodes.pSel, s.nodes.pNone];
    assert.deepEqual(idsOf(filterByMode(s, all)), ['pSel'], '不传模式 → 用 state.settings 里的');
});

test('虚拟节点：按**它所在副页**里的选中链判（不看主树）', () => {
    const s = makeState({
        pages: {
            pg: {
                id: 'pg', selected: false,
                virtualIndex: {
                    vRoot: { id: 'vRoot', refId: null, type: 'O', parentId: null, children: ['vC'], selected: false },
                    vC: { id: 'vC', refId: 'c', type: 'C', parentId: 'vRoot', children: [], selected: true },
                    vP: { id: 'vP', refId: 'pNone', type: 'P', parentId: 'vC', children: [], selected: false }
                }
            }
        }
    });
    const vNode = { id: 'vP', _virtual: true, _virtualId: 'vP', _pageId: 'pg', type: 'P' };
    assert.deepEqual(idsOf(filterByMode(s, [vNode], STATS_FILTER_MODES.SELECTED_ANCESTOR)), ['vP'],
        '副页里的选中链算数（vC 选中 ⇒ vP 在自己人范围内）');
    // ⚠️ 虚拟节点走 `hasEligibleAncestor` 的虚拟分支：那里**只有"本副页的选中链"一个判据**
    //    （不区分"主树选中"与"副页映射覆盖"—— 人在副页里，选中本来就是这个页面里的选中）。
    //    所以两个"选中类"模式对虚拟节点等价，这里如实钉住，免得以后有人以为这是 bug 随手改。
    assert.deepEqual(idsOf(filterByMode(s, [vNode], STATS_FILTER_MODES.PAGE_MAPPING_ONLY)), ['vP']);
    s.pages.pg.virtualIndex.vC.selected = false;
    assert.deepEqual(idsOf(filterByMode(s, [vNode], STATS_FILTER_MODES.SELECTED_ANCESTOR)), [],
        '副页里没人选中它 ⇒ 滤掉');
});

// ================================================================
// 合成节点与"成员引用"的显式口径（结论见 `filterMode.js` 里那段注释）
//   ① 合成节点 = 真节点 ⇒ 按自己的类型/选中正常参与筛选，不特殊对待；
//   ② 成员关系是**指针**，不在 `parentOf` 里 ⇒ "归入某合成节点"**不会**让成员
//      获得该合成节点的祖先资格（选中合成节点 ≠ 选中它的成员）；
//   ③ 因此本模块一行都不用改，这里把口径钉住，谁以后想"顺手把成员也带上"就会红。
// ================================================================

/** 一棵有合成节点的树：`syn` 是合成节点，`pMem1` / `pMem2` 是指向它的成员 */
function synthState(over = {}) {
    const s = makeState({
        nodes: {
            o: { id: 'o', type: 'O' },
            syn: { id: 'syn', type: 'P', synthKey: 'synth:g', name: '合成题' },
            pMem1: { id: 'pMem1', type: 'P', ownerSynth: 'synth:g', problemId: 'A' },
            c: { id: 'c', type: 'C' },
            pMem2: { id: 'pMem2', type: 'P', ownerSynth: 'synth:g', problemId: 'B' }
        },
        // ⚠️ 成员**不在** childOrder 里 —— 成员是名单，不是子节点
        childOrder: { o: ['syn', 'pMem1', 'c'], syn: [], pMem1: [], c: ['pMem2'], pMem2: [] },
        parentOf: { o: null, syn: 'o', pMem1: 'o', c: 'o', pMem2: 'c' }
    });
    return Object.assign(s, over);
}

test('合成节点：按自己的类型/选中正常参与筛选（不特殊对待、不被偷偷滤掉）', () => {
    const s = synthState();
    const all = [s.nodes.syn, s.nodes.pMem1, s.nodes.pMem2];
    assert.equal(filterByMode(s, all, STATS_FILTER_MODES.ALL), all, '无限制时原样返回');
    assert.deepEqual(idsOf(filterByMode(s, all, STATS_FILTER_MODES.SELECTED_ANCESTOR)), [],
        '谁都没选中 ⇒ 合成节点与成员一道被滤掉（没有"合成节点豁免"这回事）');
    s.nodes.syn.selected = true;
    assert.deepEqual(idsOf(filterByMode(s, all, STATS_FILTER_MODES.SELECTED_ANCESTOR)), ['syn'],
        '合成节点自己选中 ⇒ 它在（它就是真节点）');
});

test('成员引用：归入合成节点**不给**成员祖先资格（成员关系不是父子）', () => {
    const s = synthState();
    const all = [s.nodes.syn, s.nodes.pMem1, s.nodes.pMem2];
    s.nodes.c.selected = true;      // 选中"真祖先"比赛 ⇒ 只有挂在它下面的 pMem2 算数
    assert.deepEqual(idsOf(filterByMode(s, all, STATS_FILTER_MODES.SELECTED_ANCESTOR)), ['pMem2'],
        'pMem1 的 ownerSynth 指向已选中的 syn，但它**不是** syn 的子节点 ⇒ 仍然被滤掉');
    s.nodes.c.selected = false;
    s.nodes.syn.selected = true;    // 选中合成节点
    assert.deepEqual(idsOf(filterByMode(s, all, STATS_FILTER_MODES.SELECTED_ANCESTOR)), ['syn'],
        '选中合成节点 ≠ 选中它的成员（要按组筛，那是统计侧 countMode 的事）');
});
