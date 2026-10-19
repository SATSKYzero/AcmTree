// ================================================================
// 题目绑定（P 随 C）里"**整组都没有题名**"这一类（core/synthPlan.js 的 problemBindPlan）
//
// 口径："题目绑定：**整组无题名照旧提示，但可以直接绑**"。
//
// 不建组的后果：那 61 组的成员**一条都绑不上**，而 ⑤ 里只列了成员、给不出任何键 ——
//   人在界面上**想绑也没地方绑**（死胡同）。
// 所以这一类**照旧提示**（进 `anomalies.noName`，带 `key` ⇒ ⑤ 能点、能确认），
//   同时**照常建组、照常绑成员**，组名用兜底名 `题号（题名缺失）`。
//
// ⚠️ 为什么"没题名也能绑"是对的口径：题号本身就是这条绑定的**证据**
//    （"以**直接按题号暴力绑定**为基础"），题名只是**显示名**；
//    而且"**空题名不算冲突**"（空 = 没有证据说它不同）—— 它从来不是"不许绑"的理由。
// ================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { problemBindPlan, noNameProblemDisplayName, problemSynthKey } from '../core/synthPlan.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// ---- 夹具：一个 C 合成组（两个成员 C）+ 每成员下面若干 P ----
const C1 = 'aux:a:c:1';          // 场次标识 = `demo1`
const C2 = 'aux:b:c:1';
const C_KEY = 'synth:xcpc:demo1';

/** 造一条 C 合成组 / 成员 / P（只带 `problemBindPlan` 真正读的那几格） */
function cRecord(ext, name) {
    return { 节点类型: 'C', extKey: ext, synthKey: C_KEY, name };
}
function pRecord(ext, parent, { problemId = '', name = '', ownerSynth } = {}) {
    const r = { 节点类型: 'P', extKey: ext, 父extKey: parent, problemId: problemId, name: name };
    if (ownerSynth) r.ownerSynth = ownerSynth;
    return r;
}
/** 一次性造一份最小合法输入：两个成员 C，各自一批 P */
function planOf(pA, pB) {
    const records = [
        cRecord(C_KEY, '示例场次'),
        { 节点类型: 'C', extKey: C1, 父extKey: 'aux:a', name: '示例场次' },
        { 节点类型: 'C', extKey: C2, 父extKey: 'aux:b', name: '示例场次' },
        ...pA.map((x) => pRecord(x.ext, C1, x)),
        ...pB.map((x) => pRecord(x.ext, C2, x))
    ];
    // 成员 C 把 ownerSynth 指向那个 C 合成组（`problemBindPlan` 就是靠它认"谁属于这一组"）
    for (const r of records) if (r.节点类型 === 'C' && r.extKey !== C_KEY) r.ownerSynth = C_KEY;
    return problemBindPlan(records);
}

const GROUP_KEY = problemSynthKey('demo1', 'A');

test('★ 整组都没题名 ⇒ **照样建组、照样绑成员**（可以直接绑）', () => {
    const plan = planOf(
        [{ ext: `${C1}:p:A`, problemId: 'A' }],
        [{ ext: `${C2}:p:A`, problemId: 'A' }]
    );
    const g = plan.groups.find((x) => x.key === GROUP_KEY);
    assert.ok(g, '全组无题名的那一组**必须**被建出来（不建组就是 continue ⇒ 绑不了）');
    assert.deepEqual(g.memberExts, [`${C1}:p:A`, `${C2}:p:A`], '两个来源都要绑上');
    assert.equal(g.parentSynthKey, C_KEY, '父 = 那个 C 合成节点（P 随 C）');
    assert.equal(g.noName, true, '这一组的组名是**兜底名**（要看得出题名缺失）');
    assert.equal(g.name, 'A（题名缺失）', '兜底显示名 = 题号 + 题名缺失');
});

test('★ 照旧提示：这一类**仍然**进 anomalies.noName，而且带 key（⑤ 要靠它点进去/确认）', () => {
    const plan = planOf(
        [{ ext: `${C1}:p:A`, problemId: 'A' }],
        [{ ext: `${C2}:p:A`, problemId: 'A' }]
    );
    const x = plan.anomalies.noName.find((y) => y.problemId === 'A');
    assert.ok(x, '照旧报出来（"照旧提示"的口径）');
    assert.equal(x.key, GROUP_KEY, '异常里要带合成键 —— 不然 ⑤ 给不出可点的键、也确认不了');
    assert.equal(x.cId, 'demo1');
    assert.deepEqual(x.memberExts, [`${C1}:p:A`, `${C2}:p:A`], 'memberExts = 真正绑上的那些成员');
});

test('★ 兜底名是**纯函数**（同一题号永远同一个名字；换个题号就换名字）', () => {
    assert.equal(noNameProblemDisplayName('A'), 'A（题名缺失）');
    assert.equal(noNameProblemDisplayName('A'), noNameProblemDisplayName('A'), '可重复计算（不存）');
    assert.notEqual(noNameProblemDisplayName('A'), noNameProblemDisplayName('B'));
});

test('对照片：**有**题名的组，组名照旧取"有题名的那一份"（兜底名不许顶掉真名）', () => {
    const plan = planOf(
        [{ ext: `${C1}:p:A`, problemId: 'A', name: '小红的旅行' }],
        [{ ext: `${C2}:p:A`, problemId: 'A' }]          // 另一份没题名（弃权）
    );
    const g = plan.groups.find((x) => x.key === GROUP_KEY);
    assert.ok(g);
    assert.equal(g.name, '小红的旅行', '有题名就用真名');
    assert.equal(g.noName, false);
    assert.equal(plan.anomalies.noName.length, 0, '有题名的组**不许**进"整组无题名"那类');
});

test('反向锚：整组无题名**不报题名冲突**（空题名 = 没有证据说它不同）', () => {
    const plan = planOf(
        [{ ext: `${C1}:p:A`, problemId: 'A' }],
        [{ ext: `${C2}:p:A`, problemId: 'A' }]
    );
    assert.equal(plan.anomalies.nameConflicts.length, 0, '两边都没题名 ⇒ 不是"题名不一致"');
});

// ★ **口径反转**（`v9.1.22`，用户 2026-10-13）：
//   原来这里是"**一份来源**的题号组不建（只有一个来源就没有可绑的第二份）"。
//   用户实测的症状（`synth:xcpc:2025cc_prov&invi-东北`，成员共 1）：
//   **"这个合成节点分明没有下接题目却有方框"** —— C 组头展不开（没有 P 子节点），
//   而 C 卡片那排小方框照样从成员那边并起来画。
//   ⇒ 口径改成：**每个（场次, 题号）都建一个 P 层组头**（成员 1..N 条），
//     它的本意不再是"把各来源并起来"（那是副产品），而是"**组头要有自己的合成节点 P**"。
test('★ 口径反转：**一份来源**的题号组也建（组头要有自己的合成节点 P）', () => {
    const plan = planOf([{ ext: `${C1}:p:A`, problemId: 'A', name: '甲题' }], []);
    assert.equal(plan.groups.length, 1, '★ 只有一份来源也建组 —— 否则 C 组头下面一个 P 都没有');
    assert.equal(plan.groups[0].key, GROUP_KEY);
    assert.equal(plan.groups[0].name, '甲题', '有题名就用它');
    assert.deepEqual(plan.groups[0].memberExts, [`${C1}:p:A`], '成员就那一条');
    assert.equal(plan.groups[0].noName, false);
    assert.equal(plan.anomalies.noName.length, 0, '有题名 ⇒ 不该报"整组无题名"');

    // 顺带钉住真实包里的那 37 条副作用：**一份来源 + 没题名** ⇒ 照样建组，同时进 `noName` 提示
    // （只报不挡；显示名走兜底名。改前这些组压根不建，所以提示也不会出现）
    const bare = planOf([{ ext: `${C1}:p:B`, problemId: 'B' }], []);
    assert.equal(bare.groups.length, 1, '没题名也建组（否则又是"组头下面空的"）');
    assert.equal(bare.groups[0].noName, true);
    assert.equal(bare.anomalies.noName.length, 1, '如实进提示（人在 ⑤ 里能改名 + 确认）');
});

test('反向锚：没有题号的那条不参与（进 noProblemId，不进 noName、也不建组）', () => {
    const plan = planOf(
        [{ ext: `${C1}:p:`, problemId: '' }],
        [{ ext: `${C2}:p:`, problemId: '' }]
    );
    assert.equal(plan.groups.length, 0);
    assert.equal(plan.anomalies.noName.length, 0);
    assert.equal(plan.anomalies.noProblemId.length, 2);
});

test('★ 兜底组里"同一来源多出一条"照旧踢出去、只绑一条（成员名单用 kept，不是原始 ps）', () => {
    const plan = planOf(
        [{ ext: `${C1}:p:A`, problemId: 'A' }, { ext: `${C1}:p:A2`, problemId: 'A' }],
        [{ ext: `${C2}:p:A`, problemId: 'A' }]
    );
    const g = plan.groups.find((x) => x.key === GROUP_KEY);
    assert.ok(g);
    assert.equal(g.memberExts.length, 2, '同一来源只留一条（两个来源 ⇒ 两条）');
    const x = plan.anomalies.noName.find((y) => y.problemId === 'A');
    assert.equal(x.memberExts.length, 2,
        '提示里的成员名单也要是**绑上的**那份（混进被踢的那条会让 ⑤ 的「✓ 确认」误标）');
    assert.equal(plan.anomalies.sameSourceExtra.length, 1, '多出来的那条仍然要报');
});

test('源码级：`problem-bind.mjs` 不许覆盖**人确认过**那一组的组名（否则改好的兜底名每次重建被冲掉）', () => {
    const src = fs.readFileSync(path.join(REPO, 'scripts', 'problem-bind.mjs'), 'utf8');
    // ⚠️ "确认过"的判据从**成员身上的 `manual:set`**（会被脚本动作污染）改成了
    //    **组头自己那格 `已确认`**（组级、一条）⇒ 这里跟着钉新的那一位。
    assert.match(src, /const keepName = confirmedKeys\.has\(/,
        '组头改名要认 confirmedKeys：兜底名 `A（题名缺失）` 得让人改得动、改完不被覆盖');
    assert.match(src, /if \(!keepName\) cur\.name = g\.name;/,
        '认了 keepName 之后才允许覆盖名字');
    assert.match(src, /const CONFIRM_FIELD = PLAN_CONFIRM_FIELD;/,
        '字段名要从 `core/synthPlan.js` import（唯一定义在 elements.js），不许再抄字面量');
});
