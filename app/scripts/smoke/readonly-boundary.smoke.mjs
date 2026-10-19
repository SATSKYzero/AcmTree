// ================================================================
// 只读边界冒烟（scripts/smoke/readonly-boundary.smoke.mjs）
//
// 契约 C4：`viewingAccountId !== currentAccountId` ⇒ **一切手改被拒**，
// 而导入/重算照常。光靠"记得在每个入口加守卫"是维持不住这条契约的 ——
// 副页与账户表整条链就漏过（三份独立审计都抓到）。
//
// 这个文件做三件事：
//   ① **行为**：表里每个"手改入口"在只读模式下必须抛异常；
//   ② **豁免**：表里每个"刻意不拦"的入口必须**不**抛（防止有人顺手补守卫把功能弄死）；
//   ③ **覆盖闸门**：扫 core/ops 的源码，凡是"会改 draft 的导出函数"，
//      必须在 ① 或 ② 里归类 —— **新增一个 ops 忘了加守卫，这里会直接红**。
//
// 跑法：node --import ./scripts/smoke/register.mjs scripts/smoke/readonly-boundary.smoke.mjs
// ================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDom } from './dom.mjs';
import { group, eq, ok, report } from './harness.mjs';

installDom();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const mod = (rel) => `file://${path.join(ROOT, 'src', rel).replace(/\\/g, '/')}`;

const tree = await import(mod('core/ops/tree.js'));
const node = await import(mod('core/ops/node.js'));
const tag = await import(mod('core/ops/tag.js'));
const batch = await import(mod('core/ops/batch.js'));
const page = await import(mod('core/ops/page.js'));
const account = await import(mod('core/ops/account.js'));
const reattribute = await import(mod('core/ops/reattribute.js'));
const view = await import(mod('core/ops/view.js'));
const settings = await import(mod('core/ops/settings.js'));
const synth = await import(mod('core/ops/synth.js'));
const plan = await import(mod('core/ops/plan.js'));
const { createNode } = await import(mod('core/model/node.js'));
const { createPage, createVNode } = await import(mod('core/model/page.js'));

// ================================================================
// 夹具：一棵够用的树 + 两个账户，且**处于只读模式**
// ================================================================
function makeState() {
    const s = {
        rootId: 'o',
        nodes: {},
        childOrder: {},
        parentOf: {},
        pages: {},
        accounts: {
            local: { id: 'local', name: '本机', isLocal: true, children: [], mappings: [] },
            k1: { id: 'k1', name: '主号', children: [], isLocal: false, mappings: [] },
            k2: { id: 'k2', name: '队友', children: [], isLocal: false, mappings: [] }
        },
        currentAccountId: 'k1',
        viewingAccountId: 'k2',            // ← 只读：在看的不是登录账户
        sources: {},
        trust: { categoryRank: ['manual', 'board', 'script', 'derived'], sources: {}, fieldPrefer: {} },
        settings: { mode: {}, stats: {}, performance: {} },
        meta: { idCounter: 1 },
        currentPageId: 'p1'
    };
    const put = (id, type, parentId, extra = {}) => {
        s.nodes[id] = createNode(id, type, extra);
        s.childOrder[id] = s.childOrder[id] || [];
        s.parentOf[id] = parentId;
        if (parentId) s.childOrder[parentId].push(id);
    };
    put('o', 'O', null, { name: '根' });
    put('w', 'W', 'o', { name: '平台' });
    put('c', 'C', 'w', { name: '比赛' });
    put('p', 'P', 'c', { name: '题目', problemId: 'A' });
    put('r', 'R', 'p', { name: '提交', status: 'AC', time: '2026.09.22 21:00' });
    s.nodes.p.tags = [{ id: 't1', text: 'dp', color: '无色' }];
    s.nodes.p.values = {
        name: [{ v: '题目', src: 'manual', at: 'T1', account: 'k1' }],
        ratio: [{ v: '20.00', src: 'pta:x', at: 'T1', account: 'k2' }]
    };

    const pg = createPage('p1', '副页A', 'v1');
    pg.virtualIndex['v1'] = createVNode('v1', null, 'O', null);
    pg.virtualIndex['v2'] = createVNode('v2', 'p', 'P', 'v1');
    pg.virtualIndex['v3'] = createVNode('v3', 'r', 'R', 'v2');
    pg.virtualIndex['v1'].children.push('v2');
    pg.virtualIndex['v2'].children.push('v3');
    s.pages['p1'] = pg;
    return s;
}

/** 只读模式判定（顺带自检夹具） */
eq(account.isViewOnly(makeState()), true, '夹具确实处于只读模式（在看的 ≠ 登录的）');

// ================================================================
// ① 手改入口：必须被拒
// ================================================================
const GUARDED = [
    ['tree.addRoot', (s) => tree.addRoot(s, 'W', { name: '新平台' })],
    ['tree.addChild', (s) => tree.addChild(s, 'c', 'P', { name: '新题' })],
    ['tree.deleteNode', (s) => tree.deleteNode(s, 'p')],
    ['tree.moveUp', (s) => tree.moveUp(s, 'c')],
    ['tree.moveDown', (s) => tree.moveDown(s, 'c')],
    ['tree.copyNode', (s) => tree.copyNode(s, 'p', 'c')],
    ['tree.clearProblems', (s) => tree.clearProblems(s, 'c')],
    ['tree.clearSubmissions', (s) => tree.clearSubmissions(s, 'p')],
    ['node.updateP', (s) => node.updateP(s, 'p', { name: '改名' })],
    ['node.updateR', (s) => node.updateR(s, 'r', { status: 'WA' })],
    ['node.updateWS', (s) => node.updateWS(s, 'c', { name: '改名' })],
    ['node.updateRemark', (s) => node.updateRemark(s, 'p', '题解')],
    // 合成：绑/解绑都是手改（改的是「所属合成节点」），必须同样过只读闸门
    ['node.bindOwnerSynth', (s) => node.bindOwnerSynth(s, 'c', 'k1')],
    ['synth.createSynthNode', (s) => synth.createSynthNode(s, 'c', { type: 'C' })],
    ['synth.assignSynthKey', (s) => synth.assignSynthKey(s, 'c', 'k9')],
    ['synth.bindOwner', (s) => synth.bindOwner(s, 'c', 'k1')],
    ['synth.unbindOwner', (s) => synth.unbindOwner(s, 'c')],
    ['synth.applyOwnerSynth', (s) => synth.applyOwnerSynth(s, s.nodes.c, 'k1')],
    ['synth.clearDanglingOwners', (s) => synth.clearDanglingOwners(s)],
    ['synth.clearOwnersOf', (s) => synth.clearOwnersOf(s, ['k1'])],
    ['tag.addTag', (s) => tag.addTag(s, 'p', 'math')],
    ['tag.deleteTag', (s) => tag.deleteTag(s, 'p', 't1')],
    ['tag.moveTagUp', (s) => tag.moveTagUp(s, 'p', 't1')],
    ['tag.moveTagDown', (s) => tag.moveTagDown(s, 'p', 't1')],
    ['batch.batchAddPNodes', (s) => batch.batchAddPNodes(s, 'c', [{ name: '批量题' }])],
    ['page.addPage', (s) => page.addPage(s, '新副页')],
    ['page.deletePage', (s) => page.deletePage(s, 'p1')],
    ['page.renamePage', (s) => page.renamePage(s, 'p1', '改名')],
    ['page.duplicatePage', (s) => page.duplicatePage(s, 'p1')],
    ['page.copyRealNodeToPage', (s) => page.copyRealNodeToPage(s, 'p', 'p1')],
    ['page.batchCopyToPage', (s) => page.batchCopyToPage(s, ['p'], 'p1')],
    ['page.deleteVirtualNode', (s) => page.deleteVirtualNode(s, 'v2', 'p1')],
    ['page.moveVirtualNode', (s) => page.moveVirtualNode(s, 'v2', 'up', 'p1')],
    ['page.setVNodeBlocked', (s) => page.setVNodeBlocked(s, 'p1', 'v2', true)],
    ['page.setPageHideBlocked', (s) => page.setPageHideBlocked(s, 'p1', true)],
    ['page.syncPageWithTree', (s) => page.syncPageWithTree(s, 'p1')],
    ['page.clearAllPages', (s) => page.clearAllPages(s)],
    ['page.resetAllVirtualPages', (s) => page.resetAllVirtualPages(s)],
    // 训练计划：新建/改/删计划、加/改/删强度映射表 —— 都是手改（会随存档走、会进包）
    ['plan.addPlan', (s) => plan.addPlan(s, { name: '计划', pageId: 'p1', start: '2026.10.01', goal: { value: 3 } })],
    ['plan.updatePlan', (s) => plan.updatePlan(s, 'plan_1', { name: '改名' })],
    ['plan.deletePlan', (s) => plan.deletePlan(s, 'plan_1')],
    ['plan.addIntensityTable', (s) => plan.addIntensityTable(s, { name: '表' })],
    ['plan.updateIntensityTable', (s) => plan.updateIntensityTable(s, 'ti_1', { name: '改名' })],
    ['plan.deleteIntensityTable', (s) => plan.deleteIntensityTable(s, 'ti_1')],
    ['account.createAccount', (s) => account.createAccount(s, { name: '新账户' })],
    ['account.saveAccount', (s) => account.saveAccount(s, 'k2', { name: '改名' })],
    ['account.removeAccount', (s) => account.removeAccount(s, 'k2')],
    ['account.setAccountActive', (s) => account.setAccountActive(s, 'k2', false)],
    // 账户列表里的上移/下移（也只写 draft ⇒ 走同一个手改守卫）
    ['account.moveAccount', (s) => account.moveAccount(s, 'k2', -1)],
    ['reattribute.reattributeValues', (s) => reattribute.reattributeValues(s, {})],
    // 按线索清值（2026-10-17）：删值 = 手改级别，只读时必须被拒（`dryRun` 还允许，那是预览）
    ['reattribute.purgeValuesByClue',
        (s) => reattribute.purgeValuesByClue(s, { source: 's', field: 'f', value: 'v' })]
];

group('① 只读模式下：手改入口必须被拒');
for (const [label, run] of GUARDED) {
    const s = makeState();
    let err = null;
    try { run(s); } catch (e) { err = e; }
    const guarded = !!err && /只读|正在查看/.test(err.message);
    ok(guarded, `${label} 被拒${guarded ? '' : `（实际：${err ? err.message : '没有抛异常'}）`}`);
}

// ================================================================
// ② 刻意不拦的入口：必须仍然可用
// ================================================================
const EXEMPT = [
    ['account.setViewingAccount（进/出只读的开关）', (s) => account.setViewingAccount(s, 'k1'), 'viewingAccountId'],
    ['account.setCurrentAccount（切换登录身份）', (s) => account.setCurrentAccount(s, 'k2'), 'currentAccountId'],
    ['page.setPageSelected（选中态 = 视图状态）', (s) => page.setPageSelected(s, 'p1', true), null],
    ['page.cleanDeletedRealNode（删真实节点后的自动清理）', (s) => page.cleanDeletedRealNode(s, ['p']), null],
    ['view.setNodeExpanded（展开/折叠）', (s) => view.setNodeExpanded(s, 'c', true), null],
    ['view.toggleNodeSelected（勾选）', (s) => view.toggleNodeSelected(s, 'p'), null],
    ['settings.setSetting（应用设置）', (s) => settings.setSetting(s, 'mode.treeDisplayMode', 'folder'), null]
];

group('② 刻意豁免的入口：只读时仍然可用');
for (const [label, run] of EXEMPT) {
    const s = makeState();
    let err = null;
    try { run(s); } catch (e) { err = e; }
    ok(!err, `${label} 未被拦${err ? `（实际抛了：${err.message}）` : ''}`);
}

// ================================================================
// ③ 覆盖闸门：core/ops 里"会改 draft"的导出函数必须归类
// ================================================================
group('③ 覆盖闸门：新增 ops 忘加守卫会在这里红');

// 判据：函数体里出现"写 draft"的信号（赋值 / delete / push / splice / Object.assign 到 draft 上）
const MUTATION_PATTERNS = [
    /draft\.\w+(\[[^\]]*\])?\s*=(?!=)/,          // draft.x = / draft.x[k] =
    /delete\s+draft\./,                          // delete draft.x
    /draft\.\w+(\[[^\]]*\])?\.\w+\(/,            // draft.childOrder[id].push(…)
    /accountsOf\(draft\)/,                       // 账户表写入（saveAccount 等）
    /\bnode\.\w+\s*=(?!=)/,                      // node.x = （手改节点）
    /\bacc\.\w+\s*=(?!=)|\btarget\.\w+\s*=(?!=)/, // 账户对象就地改
    /\bpage\.virtualIndex\[[^\]]*\]\s*=(?!=)/,   // 副页结构改
    /\bvNode\.\w+\s*=(?!=)/
];

/** 粗略切出 `export function name(...) { … }` 的函数体（按花括号配对） */
function exportedFunctionBodies(src) {
    const out = {};
    const re = /export\s+function\s+(\w+)\s*\([^)]*\)\s*\{/g;
    let m;
    while ((m = re.exec(src)) !== null) {
        const name = m[1];
        let i = re.lastIndex - 1;
        let depth = 0;
        for (; i < src.length; i++) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}') {
                depth--;
                if (depth === 0) { i++; break; }
            }
        }
        out[name] = src.slice(m.index, i);
    }
    return out;
}

const OPS_FILES = ['tree.js', 'node.js', 'tag.js', 'batch.js', 'page.js', 'account.js',
                   'upsert.js', 'reattribute.js', 'trust.js', 'virtualStats.js', 'view.js', 'settings.js',
                   'synth.js'];

const classified = new Set(GUARDED.map(([label]) => label.split('.').pop()));
// 豁免里明确写了"不该归类为手改"的（含它们的内部工具）
for (const extra of ['setViewingAccount', 'setCurrentAccount', 'setPageSelected', 'cleanDeletedRealNode',
                     'setNodeExpanded', 'toggleNodeExpanded', 'toggleNodeSelected', 'setSetting', 'updateSettings',
                     'mutateNodeTags',
                     'refreshVirtualStatsForPage', 'refreshAllVirtualStats', 'reprojectField',
                     'setFieldPrefer', 'clearFieldPrefer', 'markValueInvalid',
                     // 字段组：组显示偏好与 `fieldPrefer` 同族 ——
                     // 改的是"这一组显示哪个成员"的口径，界面上由 `sourceActions` 统一
                     // `assertManualEditAllowed` 拦（和"优先/不用"同一条路），不是独立的手改入口。
                     'setGroupPrefer', 'clearGroupPrefer',
                     'upsertRecord', 'assignExtKey', 'buildExtKeyIndex', 'cleanNodeFields', 'isWritableField',
                     'setNodeCurrentPage', 'setNodeSelected', 'flipChildrenSelection', 'clearSelectionInScope',
                     'setVirtualNodeExpanded', 'toggleVirtualNodeExpanded', 'setVirtualNodeCurrentPage',
                     'setVirtualNodeSelected', 'toggleVirtualNodeSelected', 'flipVirtualChildrenSelection',
                     // 合成：`setOwnerRaw` 是**导入两阶段解析**用的裸写入口 ——
                     // 导入本来就不受只读限制（契约 C4：导入/重算照常），所以它刻意不拦。
                     'setOwnerRaw',
                     'getNextProblemId']) {
    classified.add(extra);
}

const unclassified = [];
for (const file of OPS_FILES) {
    const abs = path.join(ROOT, 'src', 'core', 'ops', file);
    if (!fs.existsSync(abs)) continue;
    const src = fs.readFileSync(abs, 'utf8');
    const bodies = exportedFunctionBodies(src);
    for (const [name, body] of Object.entries(bodies)) {
        if (classified.has(name)) continue;
        if (MUTATION_PATTERNS.some(re => re.test(body))) {
            unclassified.push(`core/ops/${file} 的 ${name}()`);
        }
    }
}
eq(unclassified.length, 0, '每个"会改 draft"的 ops 导出都必须在①或②里归类'
    + (unclassified.length ? `；未归类：${unclassified.join('、')}` : ''));

// 顺带钉住两边名单的规模（防止有人把条目删掉让测试变空）
ok(GUARDED.length >= 30, `① 表里有 ${GUARDED.length} 个手改入口（≥30）`);
ok(EXEMPT.length >= 7, `② 表里有 ${EXEMPT.length} 个豁免入口（≥7）`);

// ---- UI 层的唯一例外：副页节点编辑（插件扩展字段直接写 vNode）----
// 它没有 ops 入口可走（`ext.apply(draft, pageId, vId, formData)` 是插件自己的函数），
// 所以守卫只能写在 UI 事务的第一行 —— 这里钉住它别被人删掉。
{
    const g7 = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'G_modal', 'G7_vNodeEdit.js'), 'utf8');
    ok(/assertManualEditAllowed\(draft, '编辑副页节点'\)/.test(g7),
        'G7_vNodeEdit（插件写 vNode 的唯一入口）带着只读守卫');
    const h2 = fs.readFileSync(path.join(ROOT, 'src', 'handlers', 'H2_batchImport.js'), 'utf8');
    ok(/if \(isViewOnly\(AppState\)\) return;/.test(h2),
        'H2 的映射保存遇到只读就什么都不留');
}

report();
