// ================================================================
// ⑤ 冲突栏的判据（core/synthConflicts.js）
//
// 这一栏的数字会直接告诉用户"去动哪几条"。
// 人绑的指针**不进**"该换键"：构建侧 `synth-bind.mjs` 会跳过人手绑的节点 ——
// 界面上说 N 条、构建日志说 0 条就是不一致。
// ================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { synthConflicts, classifySynthMember } from '../core/synthConflicts.js';

/** 一条 C：nature 说它该合成到 `synth:xcpc:2020ec_regional-成都` */
function member(over = {}) {
    return {
        id: 'c1',
        type: 'C',
        extKey: 'qoj:c:777',
        name: '某场 EC',
        natureClass: 'qoj/xcpc/icpc/ec/regional/official',
        natureYear: '2020',
        natureSeason: '2020',
        natureRegion: '成都',
        ownerSynth: 'synth:xcpc:2020ec_regional-银川',   // 脚本格式的键，但**指到了别处**
        ...over
    };
}

const MANUAL = { '分类依据': { ownerSynth: 'manual:set' } };

test('人绑的指针（`分类依据.ownerSynth = manual:set`）**不进**「该换键」', () => {
    const res = synthConflicts({ c1: member(MANUAL) });
    assert.deepEqual(res.drift, [],
        '人绑就归人 —— 构建侧 `synth-bind.mjs` 会跳过它们（两边必须同一条口径）');
    assert.equal(res.summary.drift, 0);
    // ★ 但它**另有一档**（2026-10-06 改的口径）：`drift` 不收它，是因为"脚本该不该动它"——
    //   可**重出包时组头会按人后来补全的性质改名/另建**，那个旧键就在包里找不到了
    //   （症状：树上一切正常、⑤ 一格警报都不报，只有包里 baseline 核对说"这几个 identity
    //   不在包里"）。所以"人绑 + 键过时"**单列一档并进 tab 数字** —— 不修，下次重出包手填就落空。
    assert.equal(res.summary.driftHuman, 1, '★ 人绑的键过时了要单独报出来');
    assert.equal(res.summary.alarms, 1, '…而且算"要人动的事"（它会让手填落空）');
});

test('对照：没有那条标记的（脚本产的）照旧报「该换键」', () => {
    const res = synthConflicts({ c1: member() });
    assert.equal(res.drift.length, 1);
    assert.equal(res.drift[0].cur, 'synth:xcpc:2020ec_regional-银川');
    assert.notEqual(res.drift[0].want, res.drift[0].cur, 'want 是按 nature 现算出来的键');
    assert.equal(res.summary.alarms, 1);
});

test('灰值（`上游异常` / `…/无归类`）不进「算不出」，蓝色 `未归类` 照旧进', () => {
    const grey = (cls) => synthConflicts({ c1: member({ natureClass: cls, ownerSynth: '' }) }).noKey.length;
    assert.equal(grey('qoj/xcpc/provincial&invitational/上游异常'), 0);
    assert.equal(grey('qoj/xcpc/provincial&invitational/无归类'), 0);
    assert.equal(grey('qoj/xcpc/provincial&invitational/未归类'), 1);
});

// ⚠️ 判据的**顺序就是口径**：`classifySynthMember` 的四步顺序本身也要有守卫 ——
//    这四步若散在循环里、靠 `continue` 串，"哪一条先判"就只存在于代码的排版里。
test('`classifySynthMember`：四步判据的**先后**是口径（不是实现细节）', () => {
    // ① 注册表点名的（`qoj:c:2180` 平壤）**同时**是灰值/算不出 ⇒ 必须报 `noSynth`，不能被灰值吞掉
    const excluded = { '节点类型': 'C', extKey: 'qoj:c:2180', name: '平壤站',
        natureClass: 'qoj/xcpc/icpc/ec/regional/official', ownerSynth: '' };
    assert.equal(classifySynthMember(excluded).kind, 'noSynth',
        '注册表排除排在灰值判断**之前**（排除是更明确的结论）');

    // ② 灰值：哪怕是"算不出"的形状，也不进那一栏
    const grey = { type: 'C', extKey: 'qoj:c:2624', name: '某场',
        natureClass: 'qoj/xcpc/provincial&invitational/上游异常' };
    assert.equal(classifySynthMember(grey).kind, 'skip', '灰值是结论，不是欠账');

    // ③ 不是成员的三类：非 C / 组节点 / 空
    assert.equal(classifySynthMember({ type: 'P', extKey: 'x' }).kind, 'skip');
    assert.equal(classifySynthMember({ type: 'C', synthKey: 'synth:x' }).kind, 'skip');
    assert.equal(classifySynthMember(null).kind, 'skip');
});
