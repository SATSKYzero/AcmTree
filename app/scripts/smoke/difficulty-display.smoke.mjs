// ================================================================
// 树上那个数字 = 「数值难度」字段组的**当前口径**（冒烟）
//
// 口径：**使原来显示 cf 难度的位置显示数值难度（切换）** —— 数值难度不只是藏在设置页面里。
// ⚠️ 为什么放在冒烟里而不是单测：`view/builders.js` 会牵进 `shell/state.js`（→ immer，
//    只有浏览器的 import map / `register.mjs` 能解析）—— 单测里 import 它会 ERR_MODULE_NOT_FOUND。
// ================================================================
import { installDom } from './dom.mjs';
import { group, eq, ok, report } from './harness.mjs';

installDom();

const { buildPNodeTitle } = await import('../../src/view/builders.js');

const registry = {
    groups: {
        数值难度: { fields: ['cfDifficulty', 'atcoderDifficulty', 'clistDifficulty'],
                    expect: 'expected', anyOf: true, types: ['P'] }
    },
    fields: {
        cfDifficulty: { expect: 'expected', types: ['P'] },
        atcoderDifficulty: { expect: 'expected', types: ['P'] },
        clistDifficulty: { expect: 'expected', types: ['P'] }
    }
};

function makeState(fieldRegistry, trust) {
    const p = { id: 'p', type: 'P', name: '题', problemId: 'A',
                cfDifficulty: 1200, atcoderDifficulty: 900, clistDifficulty: 1175,
                status1: 0, status2: 0, values: {} };
    return {
        rootId: 'o', nodes: { p }, childOrder: { p: [] }, parentOf: { p: null },
        fieldRegistry, trust, settings: {}, meta: {}, sources: {}, accounts: {},
        currentAccountId: 'local', viewingAccountId: 'local'
    };
}

group('树上那个数字 = 数值难度组的当前口径');
{
    const state = makeState(registry, { groupPrefer: {} });
    const html = buildPNodeTitle(state, state.nodes.p);
    ok(/data-diff-field="cfDifficulty"/.test(html), '默认显示 CF（注册表成员顺序第一个）');
    ok(/1200/.test(html), '值是 CF 的 1200');

    const clist = makeState(registry, { groupPrefer: { 数值难度: 'clistDifficulty' } });
    const h2 = buildPNodeTitle(clist, clist.nodes.p);
    ok(/data-diff-field="clistDifficulty"/.test(h2), '换了口径 ⇒ 树上跟着换（CLIST）');
    ok(/1175/.test(h2), '值是 clist 的 1175');

    const at = makeState(registry, { groupPrefer: { 数值难度: 'atcoderDifficulty' } });
    ok(/data-diff-field="atcoderDifficulty"/.test(buildPNodeTitle(at, at.nodes.p)), 'AtCoder 也能切');

    // ⚠️ 没有注册表（老包）⇒ 退回 cfDifficulty（老包的行为不变）
    const old = makeState(null, {});
    const h3 = buildPNodeTitle(old, old.nodes.p);
    ok(/data-diff-field="cfDifficulty"/.test(h3), '没有注册表 ⇒ 还是 cfDifficulty');
    ok(/1200/.test(h3), '值仍是 1200');
}

report('难度显示（数值难度组口径）');
