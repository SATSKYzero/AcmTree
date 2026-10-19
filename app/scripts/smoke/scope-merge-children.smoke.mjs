// ================================================================
// 冒烟：查看范围「带直接子账户」（scripts/smoke/scope-merge-children.smoke.mjs）
//
// 用户 2026-10-13："把账户的**子账户**机制用起来，status2 的 own 值取本账号与所有子账户的合并结果"，
// 随后收紧成"**做成一个选项、与原逻辑并列**" + "**不用递归**" + "**还是全局设置吧**"。
// 实现：`settings.scopeMergeChildren`（默认关）+ `core/trust.js:scopeAccountsFor`。
//
// 为什么单独一条**端到端**冒烟：口径层已经有单测（`src/test/viewScope.test.js` 钉 `scopeOpts` 的集合），
// 但"父账户能不能真的**看见**子账户那次 AC"要穿过
// `scopeOpts` → `derivedTable` → `viewDerivedDisplay` → `collectACNodes`（热力图/AC 列表那条链）。
// 用户实测反馈过"勾了没用"，所以这里把**整条链**钉死。
//
// 运行：npm run test:smoke
// ================================================================
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDom } from './dom.mjs';
import { group, ok, eq, report } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const mod = rel => `file://${path.join(ROOT, 'src', rel).replace(/\\/g, '/')}`;

installDom([]);
const { AppState } = await import(mod('shell/state.js'));
const { createInitialState } = await import(mod('core/model/state.js'));
const { scopeOpts, viewDerivedDisplay } = await import(mod('view/scope.js'));
const { collectACNodes } = await import(mod('ui/stats/ac/tracking.js'));

/**
 * 一棵最小树：`根 → 武汉(C) → 某题(P) → 一发 AC(R)`，**那次 AC 是子账户「我」交的**。
 * 账户：`TEAM0`（队伍，父）→ `me`（我，子）—— 与用户的真实结构一致。
 */
function seed({ meActive = true } = {}) {
    const base = createInitialState();
    for (const k of Object.keys(base)) AppState[k] = base[k];
    AppState.accounts = {
        local: { id: 'local', name: '本机', children: ['TEAM0'], mappings: [] },
        TEAM0: { id: 'TEAM0', name: '队伍', children: ['me'], mappings: [] },
        me: { id: 'me', name: '我', children: [], mappings: [], active: meActive }
    };
    AppState.nodes = {
        o: { id: 'o', type: 'O', name: '根', values: {} },
        c1: { id: 'c1', type: 'C', name: 'Wuhan', values: {} },
        p1: { id: 'p1', type: 'P', name: '某题', status2: 0, values: {} },
        r1: { id: 'r1', type: 'R', status: 'AC', time: '2026.09.06 11:29:29',
            values: { status: [{ v: 'AC', src: 'qoj', at: 'T1', account: 'me' }] } }
    };
    AppState.childOrder = { o: ['c1'], c1: ['p1'], p1: ['r1'], r1: [] };
    AppState.parentOf = { c1: 'o', p1: 'c1', r1: 'p1' };
    AppState.rootId = 'o';
    AppState.viewingAccountId = 'TEAM0';
    AppState.currentAccountId = 'TEAM0';
    AppState.view = {};
    AppState.pages = {};
}
/** ⚠️ 必须**换对象**：`scopeOpts` 按 `state.settings` 的**引用**记忆化（真应用里改设置走 Immer ⇒ 换引用）。
 *  就地改 `.scopeMergeChildren` 会命中上一份 opts ⇒ 假红（写这条时自己踩过）。 */
const setFlag = (v) => { AppState.settings = { ...AppState.settings, scopeMergeChildren: v }; };

group('① 开关关（默认）= 原逻辑：父账户看不见子账户交的 AC');
{
    seed();
    setFlag(false);
    eq(scopeOpts(AppState).scopeAccounts.join(','), 'TEAM0', '范围只有队伍自己');
    eq(viewDerivedDisplay(AppState, AppState.nodes.p1, 'status2'), 0, '那题在队伍眼里是「未使用」');
    eq(collectACNodes(AppState).length, 0, '热力图 / AC 列表一条都不收（这就是"没被 TEAM0 取到"）');
}

group('② 开关开：父账户**算进**子账户那次 AC（整条链都要通）');
{
    seed();
    setFlag(true);
    eq(scopeOpts(AppState).scopeAccounts.join(','), 'TEAM0,me', '★ 范围 = 本账户 + 直接子账户');
    eq(viewDerivedDisplay(AppState, AppState.nodes.p1, 'status2'), 3,
        '★ 子账户那发 AC 算进"队伍这份"（3 = 赛后补题；夹具的 R 没有 submitKind）');
    eq(collectACNodes(AppState).length, 1, '★ 收藏 AC 节点时也能收进来（热力图/AC 列表的入口）');
}

group('③ ★ 子账户被**停用**时，即使勾上也不算（既有规则：停用=不参与投影）');
{
    seed({ meActive: false });
    setFlag(true);
    eq(scopeOpts(AppState).scopeAccounts.join(','), 'TEAM0,me', '范围里**仍然**带上它（集合只看 children）');
    eq(collectACNodes(AppState).length, 0,
        '★ 但值被 `usableValues` 挡掉（`core/trust.js:228-232` 停用账户不参与投影）——'
        + '所以"勾了没用"还有一种可能：**子账户是停用状态**');
}

/**
 * ★ 去重模式 + **P 层组头**的夹具（用户 2026-10-13 的真实场景）：
 * 显示读的是「**组那份**」，而那条链走的是 `groupCompute` 的**另一套记忆化**
 * （它自己造范围）—— 就是这一条曾经把合并开关整个绕过去。
 */
function seedSynth() {
    seed();
    AppState.nodes = {
        o: { id: 'o', type: 'O', name: '根', values: {} },
        c1: { id: 'c1', type: 'C', name: 'Wuhan', values: {} },
        sp: { id: 'sp', type: 'P', name: 'Projection', synthKey: 'synth:problem:qoj:c:2609-A', values: {} },
        pA: { id: 'pA', type: 'P', name: 'Projection', ownerSynth: 'synth:problem:qoj:c:2609-A', values: {} },
        rA: { id: 'rA', type: 'R', status: 'AC', time: '2026.03.02 11:29:29',
            values: { status: [{ v: 'AC', src: 'qoj', at: 'T1', account: 'me' }] } }
    };
    AppState.childOrder = { o: ['c1'], c1: ['sp', 'pA'], sp: [], pA: ['rA'], rA: [] };
    AppState.parentOf = { c1: 'o', sp: 'c1', pA: 'c1', rA: 'pA' };
    AppState.settings = { ...AppState.settings, stats: { ...(AppState.settings.stats || {}), countMode: 'dedup' } };
}

group('④ ★ 去重模式 + P 层组头：读「组那份」那条路也必须带上子账户');
{
    seedSynth();
    setFlag(false);
    eq(viewDerivedDisplay(AppState, AppState.nodes.sp, 'status2'), 0,
        '（对照）开关关 ⇒ 队伍看这个组头是「未使用」');
    setFlag(true);
    eq(scopeOpts(AppState).scopeAccounts.join(','), 'TEAM0,me', '范围带上了子账户');
    eq(viewDerivedDisplay(AppState, AppState.nodes.sp, 'status2'), 3,
        '★★ 组那份也算进来了 —— **改前这里是 0**（`groupCompute` 自己造范围、把开关绕过去了，'
        + '症状正是用户那句"2026.3.2 someone 9 题、TEAM0 0 题"）');
    ok(collectACNodes(AppState).length >= 1, '热力图 / AC 列表在去重模式下也收得到');
}

report('查看范围：带直接子账户');
