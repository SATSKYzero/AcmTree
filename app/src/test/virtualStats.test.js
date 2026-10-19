// ================================================================
// 副页虚拟节点统计测试
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { refreshVirtualStatsForPage, refreshAllVirtualStats } from '../core/ops/virtualStats.js';

// ---- 构造：主树 C → P1 / P2 / P3，副页映射 P1 ----
function makeScenario() {
    return {
        rootId: 'o',
        nodes: {
            'o': { id: 'o', type: 'O' },
            'c': { id: 'c', type: 'C' },
            'p1': { id: 'p1', type: 'P', status1: 1, status2: 4 },
            'p2': { id: 'p2', type: 'P', status1: 0, status2: 0 },
            'p3': { id: 'p3', type: 'P', status1: 0, status2: 0 }
        },
        childOrder: {
            'o': ['c'],
            'c': ['p1', 'p2', 'p3'],
            'p1': [],
            'p2': [],
            'p3': []
        },
        parentOf: { 'o': null, 'c': 'o', 'p1': 'c', 'p2': 'c', 'p3': 'c' },
        pages: {
            'page_1': {
                id: 'page_1',
                name: '副页',
                rootId: 'vroot_1',
                virtualIndex: {
                    'vroot_1': {
                        id: 'vroot_1', refId: null, type: 'O', parentId: null,
                        children: ['v_c'], expanded: false, currentPage: 1, selected: false
                    },
                    'v_c': {
                        id: 'v_c', refId: 'c', type: 'C', parentId: 'vroot_1',
                        children: ['v_p1'], expanded: false, currentPage: 1, selected: false
                    },
                    'v_p1': {
                        id: 'v_p1', refId: 'p1', type: 'P', parentId: 'v_c',
                        children: [], expanded: false, currentPage: 1, selected: false
                    }
                },
                vNodeStats: {},
                createdAt: '', lastModified: '', selected: false
            }
        }
    };
}

test('refreshVirtualStatsForPage 只统计副页映射的 P', () => {
    const s = makeScenario();
    refreshVirtualStatsForPage(s, 'page_1');
    const st = s.pages['page_1'].vNodeStats['v_c'];
    assert.ok(st);
    // 副页只有 P1，P1 通过 → sc2 = 3
    assert.equal(st.statusComplete2, 3);
    // 副页只有 P1，status1=1 → sc1 = 1
    assert.equal(st.statusComplete1, 1);
});

test('refreshVirtualStatsForPage 副页含多个 P', () => {
    const s = makeScenario();
    // 给 v_c 加 P2
    s.pages['page_1'].virtualIndex['v_c'].children.push('v_p2');
    s.pages['page_1'].virtualIndex['v_p2'] = {
        id: 'v_p2', refId: 'p2', type: 'P', parentId: 'v_c',
        children: [], expanded: false, currentPage: 1, selected: false
    };
    refreshVirtualStatsForPage(s, 'page_1');
    const st = s.pages['page_1'].vNodeStats['v_c'];
    // P1(通过) + P2(未动) → passedIgnore=1, total=2, sc2=1（部分通过）
    assert.equal(st.statusComplete2, 1);
    // P1 status1=1, P2 status1=0 → allProcessed=false, sc1=0
    assert.equal(st.statusComplete1, 0);
});

test('refreshVirtualStatsForPage 副页含全部 P 时聚合同主树', () => {
    const s = makeScenario();
    s.pages['page_1'].virtualIndex['v_c'].children.push('v_p2', 'v_p3');
    s.pages['page_1'].virtualIndex['v_p2'] = {
        id: 'v_p2', refId: 'p2', type: 'P', parentId: 'v_c',
        children: [], expanded: false, currentPage: 1, selected: false
    };
    s.pages['page_1'].virtualIndex['v_p3'] = {
        id: 'v_p3', refId: 'p3', type: 'P', parentId: 'v_c',
        children: [], expanded: false, currentPage: 1, selected: false
    };
    refreshVirtualStatsForPage(s, 'page_1');
    const st = s.pages['page_1'].vNodeStats['v_c'];
    // 三个 P：P1 通过，P2/P3 未动 → sc2 = 1（部分通过）
    assert.equal(st.statusComplete2, 1);
});

test('refreshVirtualStatsForPage 空副页不报错', () => {
    const s = makeScenario();
    // 副页只有 O 根，无 W/S/C
    s.pages['page_1'].virtualIndex = {
        'vroot_1': {
            id: 'vroot_1', refId: null, type: 'O', parentId: null,
            children: [], expanded: false, currentPage: 1, selected: false
        }
    };
    refreshVirtualStatsForPage(s, 'page_1');
    assert.deepEqual(s.pages['page_1'].vNodeStats, {});
});

test('refreshVirtualStatsForPage 引用失效时视为未处理', () => {
    const s = makeScenario();
    // 删除 p1
    delete s.nodes['p1'];
    refreshVirtualStatsForPage(s, 'page_1');
    const st = s.pages['page_1'].vNodeStats['v_c'];
    // refId 指向不存在的节点，视为未处理
    assert.equal(st.statusComplete1, 0);
    assert.equal(st.statusComplete2, 0);
});

test('refreshAllVirtualStats 刷新所有副页', () => {
    const s = makeScenario();
    s.pages['page_2'] = JSON.parse(JSON.stringify(s.pages['page_1']));
    s.pages['page_2'].id = 'page_2';
    s.pages['page_2'].vNodeStats = {};
    refreshAllVirtualStats(s);
    assert.ok(s.pages['page_1'].vNodeStats['v_c']);
    assert.ok(s.pages['page_2'].vNodeStats['v_c']);
});

test('refreshVirtualStatsForPage 内容不变时不改变 page 引用', () => {
    const s = makeScenario();
    refreshVirtualStatsForPage(s, 'page_1');
    const statsRef1 = s.pages['page_1'].vNodeStats;
    // 再刷新一次，内容一样
    refreshVirtualStatsForPage(s, 'page_1');
    const statsRef2 = s.pages['page_1'].vNodeStats;
    assert.equal(statsRef1, statsRef2);
});

test('refreshVirtualStatsForPage 内容变化时更新 page 引用', () => {
    const s = makeScenario();
    refreshVirtualStatsForPage(s, 'page_1');
    const statsRef1 = s.pages['page_1'].vNodeStats;
    // 修改 p1 的状态
    s.nodes['p1'].status2 = 0;
    s.nodes['p1'].status1 = 0;
    refreshVirtualStatsForPage(s, 'page_1');
    const statsRef2 = s.pages['page_1'].vNodeStats;
    assert.notEqual(statsRef1, statsRef2);
});