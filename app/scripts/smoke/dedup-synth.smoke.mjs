// ================================================================
// 冒烟测试：判重整理页的合成节点（scripts/smoke/dedup-synth.smoke.mjs）
//
// 判重页的模型：重复项**归入合成节点**（不是"绑定两个"）。
// Node 单测（`src/test/dedup.test.js`）钉的是**纯逻辑**（分组依据、推荐、只推荐不写）；
// 这里钉的是**接线**：
//   ① 页面能画出「合成节点清单」（合成标识 / 标题 / 类型 / 成员数 / 成员列表）；
//   ② 点「归入」真的经 `execute` 事务把 `ownerSynth` **写进数据**；
//   ③ 点「新建合成节点并归入」真的建出一个合成节点并把成员指过去；
//   ④ 悬空指针被**标黄列出**（不是静默丢弃），一键清理真的清掉；
//   ⑤ W/S 不参与合成（既不推荐，也不会出现在清单里）。
//
// 为什么要经过真实点击：这一页的价值全在"点一下数据就对了" —— 只断言
// "按钮画出来了"会漏掉"按钮接错了 ops / 事务没提交"这类错误。
//
// ⚠️ 树形约束（`TYPE_CHILDREN_MAP`）：O→W/S、S→C/S、C→P、P→R。
//    所以 C 原料挂在 **S 系列**下、P 原料挂在 **C 比赛**下 —— 合成节点与成员
//    同父同类型，建在哪儿都得满足同一张表（`createSynthNode` 会校验）。
//
// ⚠️ 造数据必须**整块换掉** AppState（`seed()` 做的），不能改完 `nodes` 再改
//    `childOrder`：Immer 会缓存它见过的基础对象，逐块直接改会让下一次事务的
//    draft **看不到**后改的那一块（实测：`childOrder` 里少了刚加的键，事务在校验阶段炸）。
//
// 运行：npm run test:smoke
// ================================================================
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDom, makeContainer, serialize } from './dom.mjs';
import { group, ok, eq, report } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = path.join(ROOT, 'src');
const mod = rel => `file://${path.join(SRC, rel).replace(/\\/g, '/')}`;

// ⚠️ 这一组默认不解析 innerHTML，但「改合成标识」走的是页面既有的 prompt 弹窗 ——
//    它的输入框是**拼 HTML 字符串**画出来的（`G2_common.showPromptDialog`），
//    不打开解析开关就找不到 `#prompt-input`（那会把"弹窗真的弹出来了"漏测）。
//    打开之后 `serialize()` 改为遍历元素树，语义一样（对本文件里那些 textContent
//    构造的元素完全等价：它们的 `_html` 本来就是空的）。
const body = installDom([], { parseHtml: true });
const app = makeContainer(body, 'app');
for (const id of ['tab-dedup', 'toast', 'tree-body']) makeContainer(app, id);
globalThis.fetch = async () => ({ ok: false, json: async () => ({}) });

const { AppState } = await import(mod('shell/state.js'));
const { createInitialState } = await import(mod('core/model/state.js'));
const { createNode } = await import(mod('core/model/node.js'));
// 「数据不自洽」那一行的两个数据源：警告（计数口径）与悬空指针（页面口径）。
// 这里显式 import 是为了**在测试里独立算一遍 N**，而不是拿页面自己的中间结果自证。
const { collectGroups } = await import(mod('core/query/groupCount.js'));
const { findDanglingOwners } = await import(mod('core/ops/synth.js'));
const { NATURE_FIELD_KEYS, natureFieldOf, CLASS_PATHS } =
    await import(mod('core/natureFields.js'));
// 分类的**依据强度**（元列 `分类依据` → 规则 id）—— 这里独立算一遍，
// 不是拿页面自己的中间结果自证。
const { classRuleOf } = await import(mod('core/natureConfidence.js'));
const { EVENTS } = await import(mod('A_constants.js'));
const dedupPage = await import(mod('ui/dedup/dedupPage.js'));

/** 造一个真节点（走 `createNode`，字段默认值才有；`extra` 覆盖它） */
const N = (id, type, extra = {}) => ({ ...createNode(id, type, extra), ...extra, id, type });

/**
 * 造一棵树并**整块换掉** AppState（事务要用到 settings / accounts / pages / meta）。
 * @param {Array<{parent:string, type:string, id:string, [k:string]:*}>} list 父在前、子在后
 */
function seed(list) {
    const base = createInitialState();
    const rootId = base.rootId;
    const nodes = { ...base.nodes };
    const childOrder = { ...base.childOrder };
    const parentOf = { ...base.parentOf };
    for (const item of list) {
        const { type, id, ...extra } = item;
        // ⚠️ 夹具里的 `parent: 'root'` 指的是**真实的根节点 id**：`createInitialState()`
        //    的根 id 是**生成的**（`makeNodeId(1, …)`），字面量 'root' 并不存在。
        //    写路径会**拒绝归入"从根走不到"的节点**（拒绝④），
        //    所以夹具必须挂在真根上 —— 否则测的就不是判重页，而是"夹具坏数据被拒"。
        const parent = item.parent === 'root' ? rootId : item.parent;
        nodes[id] = N(id, type, extra);
        parentOf[id] = parent;
        if (!childOrder[parent]) childOrder[parent] = [];
        childOrder[parent].push(id);
        if (!childOrder[id]) childOrder[id] = [];
    }
    replaceState({
        ...base, rootId, nodes, childOrder, parentOf,
        currentTab: 'dedup', currentPageId: 'main'
    });
    dedupPage.invalidateDedupCache();
}
const replaceState = state => { for (const k of Object.keys(state)) AppState[k] = state[k]; };

const pane = document.getElementById('tab-dedup');
const draw = (section = 'synth') => {
    dedupPage.invalidateDedupCache();
    dedupPage.renderDedupPage();
    showTab(section);      // 每组都从**确定的栏**开始（默认 ①；②/③ 自己传）
};
/**
 * 二级 tab：切到某一栏 —— **点真按钮**（与用户操作同一条路）。
 * 切栏只重画，`viewState` 里的筛选范围/关键词一个字都不动。
 */
const showTab = id => {
    const b = pane.querySelectorAll('.dedup-subtab').find(x => x.dataset.section === id);
    if (b) b.click();
    return !!b;
};
const btnsOf = card => card.querySelectorAll('.btn');
/** 一张合成节点卡里第一行的那个"合成标识"（head 的第一个子元素） */
const keyOfCard = card => {
    const head = card.children[0];
    const keyEl = head && head.children[0];
    return keyEl ? keyEl.textContent : '';
};
const cardByKey = key => pane.querySelectorAll('.dedup-synth').find(c => keyOfCard(c) === key);

// ---- 既有悬空黄条里的两个半句（同一个 `.dedup-dangling` 盒子里） ----
/** 悬空那半句（"⚠️ 有 N 个指针是悬空的…"；没有就 null） */
const danglingSpan = () => pane.querySelectorAll('.dedup-dangling span')
    .find(s => String(s.textContent).includes('个指针是悬空的')) || null;
/** "⚠️ 还有 N 处数据不自洽…"那一行（没有就 null） */
const incoherentSpan = () => pane.querySelectorAll('.dedup-dangling span')
    .find(s => String(s.textContent).includes('数据不自洽')) || null;
/** 那一行文案里的数字 N（行不在就 null） */
const incoherentN = () => {
    const s = incoherentSpan();
    const m = s && String(s.textContent).match(/还有 (\d+) 处数据不自洽/);
    return m ? Number(m[1]) : null;
};
/**
 * 页面口径的期望条数：`collectGroups` 的 warnings 里，**节点 id 已经出现在悬空
 * 半句里**的那些不再列（同一件事的两种说法）。在测试里独立复算一遍，用来钉 N。
 */
const expectedIncoherent = state => {
    const danglingIds = new Set(findDanglingOwners(state).map(d => d.id));
    return collectGroups({ nodes: (state && state.nodes) || {} }).warnings.filter(w => {
        const cut = w.indexOf(':');
        return cut > 0 && !danglingIds.has(w.slice(0, cut));
    });
};

/** 等一个写事务落地（execute 是异步的） */
async function waitFor(fn, ms = 2000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        if (fn()) return true;
        await new Promise(r => setTimeout(r, 5));
    }
    return fn();
}
const clickButton = (card, label) => {
    const b = btnsOf(card).find(x => x.textContent === label);
    if (b) b.click();
    return !!b;
};

// ===============================================================
group('判重页：合成节点清单（① 合成标识 / 标题 / 类型 / 成员）');
// ===============================================================
seed([
    { parent: 'root', type: 'S', id: 's1', name: 'XCPC 2026' },
    { parent: 's1', type: 'C', id: 'sx', name: '2026 浙江省赛（合成）', synthKey: 'synth:k1' },
    { parent: 's1', type: 'C', id: 'c1', name: '2026 浙江省赛', extKey: 'xcpc:c:zjcpc-2026', ownerSynth: 'synth:k1' },
    { parent: 's1', type: 'C', id: 'c2', name: '2026 浙江省赛（榜单）', extKey: 'qoj:c:999', ownerSynth: 'synth:k1' },
    { parent: 's1', type: 'C', id: 'c3', name: '2026 浙江省赛 补题' },
    { parent: 's1', type: 'C', id: 'c4', name: '2026 浙江省赛 补题（榜单）' }
]);
draw();

ok(!!pane.querySelector('.dedup-page'), '整理页画得出来');
const html1 = serialize(pane);
ok(/判重整理/.test(html1), '标题在');
ok(/① 合成节点：1 个/.test(html1), '第一块 = 合成节点清单');
// 二级 tab：四栏都在、默认停在①，**其余三栏的内容一次都不画**（三块内容同屏会占满版面）
const tabs1 = pane.querySelectorAll('.dedup-subtab').map(b => b.dataset.section);
eq(tabs1.join(','), 'synth,dupes,nature,summary,conflict', '五栏都在，顺序 = ①②③④⑤');
ok(/② 可能重复（\d+）/.test(html1), '② 栏的标签上带条数（哪一栏有活一眼可见）');
ok(!/② 可能重复：/.test(html1), '★ 没选中 ② ⇒ 它的块**不画**（这就是"不再同屏堆叠"）');
ok(!/节点共 \d+ 个/.test(html1), '★ 没选中 ④ ⇒ 页尾小结也不画');
showTab('dupes');
ok(/② 可能重复：/.test(serialize(pane)) && !/① 合成节点：/.test(serialize(pane)),
    '切到 ② ⇒ 只有 ② 那块在（切栏只重画，不叠画）');
showTab('summary');
ok(/节点共 \d+ 个：合成节点 1 个/.test(serialize(pane)), '④ 概览（含合成节点数）在它自己那一栏');
// ★ 「合并显示」的一键开关 `[不判重 / 判重]`：
//   写的就是**统计那边同一个设置键**（`settings.stats.countMode`）—— 不许另造第二套口径。
{
    const toggle = pane.querySelector('.dedup-count-mode');
    ok(!!toggle, '★ ④ 概览里有 `[不判重 / 判重]` 一键开关');
    const btns = toggle ? toggle.querySelectorAll('button') : [];
    eq(btns.map(b => b.textContent).join(','), '不判重,判重', '两档：不判重 / 判重');
    eq(typeof AppState.settings.stats.countMode, 'string', '（前提）设置里有这个键');
    eq(btns[0].disabled, true, '默认是「不判重」⇒ 那一档已选中（不可再点）');
    eq(btns[1].disabled, false, '「判重」可点');
    btns[1].click();
    await new Promise(r => setTimeout(r, 30));          // runWrite 是事务（异步）
    eq(AppState.settings.stats.countMode, 'dedup',
        '★ 点「判重」⇒ 写进 `settings.stats.countMode`（与设置页那两个 radio 同一个键）');
    ok(/合并显示/.test(serialize(pane)), '开关旁边如实说明"合并显示"是什么意思');
}
showTab('synth');
ok(/① 合成节点：1 个/.test(serialize(pane)), '切回 ① 照旧');
ok(/synth:k1/.test(html1), '合成标识列出来了');ok(/成员 2/.test(html1), '成员数 = 2（按 ownerSynth 指针算）');
ok(/2026 浙江省赛（合成）/.test(html1), '合成节点的标题在');
ok(!/mappingElementValue/.test(serialize(document.body)), '界面里不出现 `mappingElementValue`');

// 成员列表：两个成员都列出来，且各自带「解绑」
const synthCard = cardByKey('synth:k1');
ok(!!synthCard, '按合成标识找得到那张卡');
const members = synthCard.querySelectorAll('.dedup-member');
eq(members.length, 2, '卡里列出两个成员');
ok(members.map(m => m.children[0].textContent).join('｜').includes('xcpc:c:zjcpc-2026'),
    '成员行带它的 extKey（看得清是哪份原料）');
ok(btnsOf(synthCard).some(b => b.textContent === '改名'), '有「改名」');
ok(btnsOf(synthCard).some(b => b.textContent === '改合成标识'), '有「改合成标识」');
ok(btnsOf(synthCard).some(b => b.textContent === '删除合成节点'), '有「删除合成节点」');
eq(btnsOf(synthCard).filter(b => b.textContent === '解绑').length, 2, '每个成员一个「解绑」');

// ===============================================================
group('判重页：点「归入」真的写进 ownerSynth（走 execute 事务）');
// ===============================================================
// 场景：sx 是**同父同类型**的合成节点（名字与 c3 相同），c3 还没归属
// ⇒ 页面应给出"建议归入 sx"。⚠️ 位置由 `synthKey` 决定，不是父子关系。
seed([
    { parent: 'root', type: 'S', id: 's1', name: 'XCPC 2026' },
    { parent: 's1', type: 'C', id: 'sx2', name: '2026 浙江省赛（合成）', synthKey: 'synth:k1' },
    { parent: 's1', type: 'C', id: 'c1', name: '2026 浙江省赛', extKey: 'xcpc:c:zjcpc-2026', ownerSynth: 'synth:k1' },
    { parent: 's1', type: 'C', id: 'sx', name: '2026 浙江省赛 补题', synthKey: 'synth:k2' },
    { parent: 's1', type: 'C', id: 'c3', name: '2026 浙江省赛 补题' }
]);
draw('dupes');
eq(AppState.nodes.c3.ownerSynth, '', '（前提）c3 还没归属');

const candCard = pane.querySelectorAll('.dedup-cand')[0];
ok(!!candCard, '出了推荐');
ok(/建议归入/.test(serialize(candCard)), '推荐写明"建议归入 …"（而不是自己判定）');
ok(clickButton(candCard, '归入'), '候选行有「归入」按钮');

// execute() 是异步事务：等它提交（提交后 ownerSynth 才有值）
await waitFor(() => AppState.nodes.c3 && AppState.nodes.c3.ownerSynth === 'synth:k2');
eq(AppState.nodes.c3.ownerSynth, 'synth:k2', '点「归入」后 ownerSynth 真的写成了 synth:k2');
eq(AppState.nodes.sx.synthKey, 'synth:k2', '合成节点自己的身份没被动过');
eq(AppState.nodes.c1.ownerSynth, 'synth:k1', '别的组不受影响');

// ===============================================================
group('判重页：点「新建合成节点并归入」真的建节点 + 写指针');
// ===============================================================
seed([
    { parent: 'root', type: 'S', id: 's1', name: 'XCPC 2026' },
    { parent: 's1', type: 'C', id: 'c3', name: '2026 浙江省赛 补题', extKey: '' },
    // ⚠️ 硬门槛（默认）只认"题号相同 / 标题完全相同" ⇒ 夹具要用**完全相同**的名字，
    //    不能用 `2026 浙江省赛 补题（榜单）` 那种**只是像**的名字（那是要藏起来的噪声）。
    { parent: 's1', type: 'C', id: 'c4', name: '2026 浙江省赛 补题', extKey: '' }
]);
draw('dupes');
const beforeNodes = Object.keys(AppState.nodes).length;
const newGroupCard = pane.querySelectorAll('.dedup-cand')[0];
ok(!!newGroupCard, '两个都没归属 → 出推荐');
ok(/建议新建一个合成节点/.test(serialize(newGroupCard)), '推荐写明"建议新建一个合成节点"');
ok(!!newGroupCard.querySelector('.dedup-synth-key'), '候选行显示要用的合成标识（空则自动生成）');
ok(clickButton(newGroupCard, '新建合成节点并归入'), '候选行有「新建合成节点并归入」');

await waitFor(() => Object.keys(AppState.nodes).length > beforeNodes);
eq(Object.keys(AppState.nodes).length, beforeNodes + 1, '新建了 1 个节点');
const newSynth = Object.values(AppState.nodes).find(n => n && n.synthKey);
ok(!!newSynth, '新建的那个就是合成节点（有 synthKey）');
ok(String(newSynth.synthKey).startsWith('synth:'), '自动标识带保留前缀 synth:');
eq(newSynth.type, 'C', '类型与成员相同');
eq(AppState.parentOf[newSynth.id], 's1', '建在成员旁边（同一个父容器）');
eq(AppState.nodes.c3.ownerSynth, newSynth.synthKey, 'c3 归入它');
eq(AppState.nodes.c4.ownerSynth, newSynth.synthKey, 'c4 也归入它');

draw();
const html2 = serialize(pane);
ok(/① 合成节点：1 个/.test(html2), '重画后清单里出现这个新合成节点');
ok(/成员 2/.test(html2), '它有两个成员');

// ===============================================================
group('判重页：悬空指针标黄列出 + 一键清理');
// ===============================================================
seed([
    { parent: 'root', type: 'S', id: 's1', name: 'XCPC 2026' },
    { parent: 's1', type: 'C', id: 'ghost', name: '孤儿原料', ownerSynth: 'synth:不存在' }
]);
draw();
ok(!!pane.querySelector('.dedup-dangling'), '有悬空指针那一条（不是静默丢弃）');
const danglingHtml = serialize(pane.querySelector('.dedup-dangling'));
ok(/悬空/.test(danglingHtml) && /synth:不存在/.test(danglingHtml), '如实写出指向了哪个不存在的标识');
ok(/孤儿原料/.test(danglingHtml), '指出是哪个节点');
ok(clickButton(pane.querySelector('.dedup-dangling'), '一键清理'), '有「一键清理」');
await waitFor(() => AppState.nodes.ghost && AppState.nodes.ghost.ownerSynth === '');
eq(AppState.nodes.ghost.ownerSynth, '', '清理后指针为空');
eq(!!AppState.nodes.ghost, true, '节点本身**没被删掉**（悬空指针不清节点）');
draw();
eq(pane.querySelector('.dedup-dangling').children.length, 0, '清理后黄条消失');

// ===============================================================
group('判重页：改合成标识（成员指针在同一事务里一起改）与删除合成节点');
// ===============================================================
seed([
    { parent: 'root', type: 'S', id: 's1', name: 'XCPC 2026' },
    { parent: 's1', type: 'C', id: 'sx', name: '2026 浙江省赛（合成）', synthKey: 'old-key' },
    { parent: 's1', type: 'C', id: 'c1', name: '2026 浙江省赛', ownerSynth: 'old-key' },
    { parent: 's1', type: 'C', id: 'c2', name: '2026 浙江省赛（榜单）', ownerSynth: 'old-key' }
]);
draw();
const renameCard = cardByKey('old-key');
ok(!!renameCard, '按标识找到合成节点卡');

const { showPromptDialog, showDeleteConfirm } = await import(mod('ui/G_modal/G2_common.js'));
ok(clickButton(renameCard, '改合成标识'), '点了「改合成标识」');
// 弹窗输入框由 G2_common 里 `#prompt-input` 那个 id 登记进桩的 registry
const promptInput = document.getElementById('prompt-input');
ok(!!promptInput, '弹窗里的输入框用**页面既有的** prompt 弹窗画出来了');
promptInput.value = 'new-key';
(document.body.querySelectorAll('.modal-overlay')
    .flatMap(o => o.querySelectorAll('.btn'))
    .find(b => b.textContent === '确定') || { click() {} }).click();

await waitFor(() => AppState.nodes.sx && AppState.nodes.sx.synthKey === 'new-key');
eq(AppState.nodes.sx.synthKey, 'new-key', '合成标识改成 new-key');
eq(AppState.nodes.c1.ownerSynth, 'new-key', '成员 c1 的指针跟着改了（同一事务）');
eq(AppState.nodes.c2.ownerSynth, 'new-key', '成员 c2 的指针跟着改了（同一事务）');
draw();
ok(!!cardByKey('new-key'), '重画后按新标识找得到');
eq(!!cardByKey('old-key'), false, '改标识后 old-key 那张卡没了');

// ---- 删除合成节点：成员保留，只是解绑 ----
const delCard = cardByKey('new-key');
ok(clickButton(delCard, '删除合成节点'), '点了「删除合成节点」');
// 删除确认走 `showDeleteConfirm`（带倒计时）——把倒计时压到确定按钮可点
const overlays = document.body.querySelectorAll('.modal-overlay');
ok(overlays.length > 0, '弹出了删除确认（走既有的确认框风格）');
ok(/不会被删除|只是解绑/.test(serialize(overlays[overlays.length - 1])), '确认框写明"成员不会被删除"');
const okBtn = overlays[overlays.length - 1].querySelector('.btn-row .btn-danger');
ok(!!okBtn, '找到那个「确定」');
okBtn.disabled = false;          // 倒计时按钮初始 disabled；测试里直接放行（见 dom.mjs 的 cloneNode 支持）
okBtn.dispatchEvent({ type: 'click' });
await waitFor(() => !AppState.nodes.sx);
eq(!!AppState.nodes.sx, false, '合成节点被删掉');
eq(!!AppState.nodes.c1, true, '成员 c1 **还在树上**');
eq(AppState.nodes.c1.ownerSynth, '', 'c1 的指针被清掉（deleteNode 在同一事务里清）');
eq(AppState.nodes.c2.ownerSynth, '', 'c2 的指针也被清掉');
eq(Object.values(AppState.nodes).filter(n => n.synthKey).length, 0, '树上没有别的合成节点了');

// ===============================================================
group('判重页：W/S 不参与合成');
// ===============================================================
seed([
    { parent: 'root', type: 'W', id: 'w1', name: '2026 浙江省赛' },
    { parent: 'root', type: 'W', id: 'w2', name: '2026 浙江省赛（榜单）' }
]);
draw();
ok(/① 合成节点：0 个/.test(serialize(pane)), '也没有合成节点');
showTab('dupes');
const html3 = serialize(pane);
ok(/② 可能重复：0 条建议/.test(html3), 'W/S 之间再像也不出推荐');
eq(pane.querySelectorAll('.dedup-cand').length, 0, '候选卡一张都没有');

// ===============================================================
group('判重页：只推荐不写（画一遍推荐，数据一个字段都不变）');
// ===============================================================
seed([
    { parent: 'root', type: 'S', id: 's1', name: 'XCPC 2026' },
    { parent: 's1', type: 'C', id: 'c3', name: '2026 浙江省赛 补题', extKey: '' },
    // ⚠️ 硬门槛（默认）只认"题号相同 / 标题完全相同" ⇒ 夹具要用**完全相同**的名字，
    //    不能用 `2026 浙江省赛 补题（榜单）` 那种**只是像**的名字（那是要藏起来的噪声）。
    { parent: 's1', type: 'C', id: 'c4', name: '2026 浙江省赛 补题', extKey: '' }
]);
draw();
eq(AppState.nodes.c3.ownerSynth, '', '画完推荐，c3 的指针还是空的');
eq(AppState.nodes.c4.ownerSynth, '', '画完推荐，c4 的指针还是空的');
eq(Object.values(AppState.nodes).filter(n => n.synthKey).length, 0, '画完推荐没有悄悄建合成节点');

// ===============================================================
group('判重页：坏数据 ⇒ 多出「数据不自洽」那一行（N = 未被去重的警告条数）');
// ===============================================================
// 三条**读取路径的坏数据**一次给全（都只可能是历史存档 / 坏包，写路径会拒）：
//   ① 两对节点各自共用一个 `synthKey`；
//   ② `ownerSynth` 写成**节点 id**（`sxA`）而不是 `synthKey`；
//   ③ 成员 `m3` **从根走不到**（挂在一个不存在的父上）。
// ⚠️ 实测口径（这条就是断言要钉的事实，别想当然）：
//    · ② 的那条警告**同时**是悬空指针 —— `findDanglingOwners` 按 `synthKey` 查表，
//      节点 id 查不到 ⇒ 它已经在悬空半句里 ⇒ 被 `danglingRow` 去重掉，**不进 N**；
//    · ③ 压根不在 `collectGroups().warnings` 里（"成员从根走不到"是
//      `synthMembersTable` 的 console.warn，判重页不调它）⇒ 也不进 N；
//    · 所以这一轮 N = 2（两对共用标识），而 `warnings` 一共 3 条。
seed([
    { parent: 'root', type: 'S', id: 's1', name: 'XCPC 2026' },
    { parent: 's1', type: 'C', id: 'sxA', name: '浙江省赛（合成）', synthKey: 'dup:k1' },
    { parent: 's1', type: 'C', id: 'sxB', name: '浙江省赛（合成·副本）', synthKey: 'dup:k1' },
    { parent: 's1', type: 'C', id: 'sxC', name: '省赛（合成）', synthKey: 'dup:k2' },
    { parent: 's1', type: 'C', id: 'sxD', name: '省赛（合成·副本）', synthKey: 'dup:k2' },
    { parent: 's1', type: 'C', id: 'm2', name: '浙江省赛（榜单）', ownerSynth: 'sxA' },
    // ⚠️ 父 id 必须**不存在**：这才叫"从根走不到"（见文件顶上那条夹具坑）
    { parent: '不存在的父', type: 'C', id: 'm3', name: '浙江省赛（孤儿）', ownerSynth: 'dup:k1' },
    { parent: 's1', type: 'C', id: 'm1', name: '浙江省赛', ownerSynth: 'dup:k1' }
]);
const badNodesBefore = JSON.stringify(AppState.nodes);
const badOrderBefore = JSON.stringify(AppState.childOrder);
draw();

const extraSpan = incoherentSpan();
ok(!!extraSpan, '有坏数据 ⇒ 出现「数据不自洽」那一行');
eq(incoherentN(), 2, '文案里的 N = 2（两对共用标识）');
eq(incoherentN(), expectedIncoherent(AppState).length, 'N 等于 warnings 里没被悬空半句去重的条数');
eq(collectGroups({ nodes: AppState.nodes }).warnings.length, 3,
    '（口径）collectGroups 一共报 3 条，其中 1 条已在悬空半句里 ⇒ N 只算 2');

const extraText = String(extraSpan && extraSpan.textContent);
ok(/同一个标识出现在多个节点上/.test(extraText), '如实写出坏在哪（共用标识）');
ok(/dup:k1/.test(extraText) && /dup:k2/.test(extraText), '两对都点了名');
ok(!/\*\*/.test(extraText), '渲染文本里没有 ** 标记（去标记逻辑生效了）');
ok(!/`/.test(extraText), '渲染文本里没有反引号');
ok(!/节点 id/.test(extraText), '已挂在悬空半句里的节点不在这行重复列（去重）');
ok(!/m3/.test(extraText), '（口径）「成员从根走不到」不在这条报，也不进 N');

// 悬空那半句（同一条黄条）：`ownerSynth` 写成节点 id 的那条在这里
const dSpan = danglingSpan();
ok(!!dSpan, '悬空那半句也在（同一条黄条里）');
ok(/榜单/.test(String(dSpan && dSpan.textContent)), '悬空半句如实点出是哪个节点');
ok(findDanglingOwners(AppState).some(d => d.id === 'm2'),
    '（口径）写节点 id 的那条**同时**是悬空指针 ⇒ 注定被去重');
ok(collectGroups({ nodes: AppState.nodes }).warnings.some(w => /节点 id/.test(w) && w.includes('`')),
    '（口径）它确实是 collectGroups 的一条警告、原文还带反引号 —— 但页面不再列它');
ok(!/m3/.test(serialize(pane.querySelector('.dedup-dangling'))),
    '（口径）「成员从根走不到」在整条黄条里一个字都没有');

// 用 ok 而不是 eq：这些快照很长，失败时 eq 会把整棵树打在报告里
ok(JSON.stringify(AppState.nodes) === badNodesBefore, '画这一行不改 nodes（逐字节不变）');
ok(JSON.stringify(AppState.childOrder) === badOrderBefore, '画这一行不改 childOrder（逐字节不变）');

// ===============================================================
group('判重页：干净数据不出现「数据不自洽」那一行（回归锚）');
// ===============================================================
seed([
    { parent: 'root', type: 'S', id: 's1', name: 'XCPC 2026' },
    { parent: 's1', type: 'C', id: 'sx', name: '浙江省赛（合成）', synthKey: 'k:ok' },
    { parent: 's1', type: 'C', id: 'c1', name: '浙江省赛', ownerSynth: 'k:ok' }
]);
draw();
eq(!!incoherentSpan(), false, '干净的合成树 ⇒ 那一行不出现');
eq(pane.querySelector('.dedup-dangling').children.length, 0, '整条黄条里一个字都没有');
eq(expectedIncoherent(AppState).length, 0, '（口径）这一轮确实半条警告都没有');

// ===============================================================
group('判重页：「数据不自洽」那一行是只读的（无写操作按钮 / 无 data-*）');
// ===============================================================
// 这一轮刻意**只有**共用标识（没有悬空指针）⇒ 黄条里应该只剩那一行文字，
// 连「一键清理」都不该有（它是给悬空指针用的）。
seed([
    { parent: 'root', type: 'S', id: 's1', name: 'XCPC 2026' },
    { parent: 's1', type: 'C', id: 'sxA', name: '浙江省赛（合成）', synthKey: 'dup:k1' },
    { parent: 's1', type: 'C', id: 'sxB', name: '浙江省赛（合成·副本）', synthKey: 'dup:k1' }
]);
const roNodesBefore = JSON.stringify(AppState.nodes);
const roOrderBefore = JSON.stringify(AppState.childOrder);
draw();
const roBox = pane.querySelector('.dedup-dangling');
ok(!!incoherentSpan(), '（前提）只有「数据不自洽」，没有悬空指针');
eq(incoherentN(), 1, '这一轮 N = 1');
eq(roBox.querySelectorAll('.btn').length, 0, '黄条里没有任何按钮（连「一键清理」都没有）');

const roEls = [];
(function walk(el) {
    for (const c of (el.children || [])) {
        if (c._isText) continue;
        roEls.push(c);
        walk(c);
    }
})(roBox);
eq(roEls.filter(el => Object.keys(el.dataset || {}).length > 0).length, 0,
    '这一行里没有任何 data-* 属性（没有"点一下改数据"的入口）');
eq(roEls.filter(el => String(el.tagName).toLowerCase() === 'button').length, 0,
    '这一行里没有 button 元素');
ok(JSON.stringify(AppState.nodes) === roNodesBefore, '渲染前后 nodes 逐字节不变');
ok(JSON.stringify(AppState.childOrder) === roOrderBefore, '渲染前后 childOrder 逐字节不变');

// ===============================================================
group('判重页：筛选范围控制栏（范围 / nature / 类型 / 关键词 / 归入状态 / 清空条件）');
// ===============================================================
// 口径："判重整理要支持筛选范围，且相信性质归类，跨性质的就别建议了。"
//              "筛选有现成的模板，见一级 tab 栏的『题目检索』。"
//
// 这一组的目的是**接线**：控制栏画得出来、条件一变建议**真的变少**、
// nature 筛选**真的按数据收集**、清空条件**真的复原**。
// 纯判据在 `src/test/dedupScope.test.js` 里（那一份更细）。
seed([
    { parent: 'root', type: 'S', id: 's1', name: 'XCPC 2026', natureClass: 'xcpc' },
    // C1：两题同名同号（真重复）+ 一道"只是名字像"的
    { parent: 's1', type: 'C', id: 'c1', name: '2026 浙江省赛', natureClass: 'xcpc', natureYear: '2024' },
    { parent: 'c1', type: 'P', id: 'p1', name: 'Two Sum', problemId: 'A', natureClass: 'xcpc', natureYear: '2024' },
    { parent: 'c1', type: 'P', id: 'p2', name: 'Two Sum', problemId: 'A', natureClass: 'xcpc', natureYear: '2024' },
    { parent: 'c1', type: 'P', id: 'p7', name: 'Two Sums', problemId: '', natureClass: 'xcpc', natureYear: '2024' },
    // C2：另一场比赛（性质不同）—— 缩范围之后与 C1 无关
    { parent: 's1', type: 'C', id: 'c2', name: '2026 江苏省赛', natureClass: 'cf/contest/div2', natureYear: '2025' },
    { parent: 'c2', type: 'P', id: 'p3', name: 'Two Sum', problemId: 'A', natureClass: 'cf/contest/div2', natureYear: '2025' },
    { parent: 'c2', type: 'P', id: 'p4', name: 'Two Sum', problemId: 'A', natureClass: 'cf/contest/div2', natureYear: '2025' },
    // C3：同名同号，但两边性质不同 ⇒ 硬门槛之外，**跨性质还要再拦一次**
    { parent: 's1', type: 'C', id: 'c3', name: '2026 甲站' },
    { parent: 'c3', type: 'P', id: 'p5', name: 'Three-Axis Views', problemId: 'Z', natureClass: 'xcpc/icpc' },
    { parent: 'c3', type: 'P', id: 'p6', name: 'Three-Axis Views', problemId: 'Z', natureClass: 'cf/contest/div2' }
]);
draw('dupes');

const filterBox = () => pane.querySelector('.dedup-filter');
const hitText = () => String((pane.querySelector('.dedup-hit') || {}).textContent || '');
const hitN = () => {
    const m = hitText().match(/命中 (\d+) 条建议/);
    return m ? Number(m[1]) : null;
};
/** 控制栏里的第 i 个下拉框（0 = 范围） */
const selects = () => filterBox().querySelectorAll('select');
/** 选一个范围档（并派发 change —— 桩里的 select 赋值不会自动触发） */
const pickScope = (value) => {
    const sel = selects()[0];
    sel.value = value;
    sel.dispatchEvent({ type: 'change' });
};
/** 点控制栏里某个 value 的芯片（nature / 类型 / 归入状态 / 相似度辅助） */
const clickChip = (value) => {
    const chip = filterBox().querySelectorAll('.dedup-chip').find(c => c.dataset.value === value);
    if (chip) chip.click();
    return !!chip;
};

ok(!!filterBox(), '② 块上方有控制栏（`.dedup-filter`）');
ok(/范围/.test(serialize(filterBox())), '有「范围」这一维');
eq(selects().length, 1, '整棵树时只有一个下拉框（范围本身）');
ok(selects()[0].querySelectorAll('option').some(o => o.value === 'all'), '范围有「整棵树」');
ok(selects()[0].querySelectorAll('option').some(o => o.value === 'subtree'), '范围有「某个子树」');
ok(selects()[0].querySelectorAll('option').some(o => o.value === 'contest'), '范围有「单场比赛」');
ok(/命中 \d+ 条建议/.test(hitText()), '命中条数写在控制栏里');
eq(hitN(), 2, '整棵树：C1 一对 + C2 一对；C3 那对**跨性质**不出现');
eq(pane.querySelectorAll('.dedup-cand').length, 2, '候选卡也是 2 张');

// ⚠️ nature 的可选项必须**从数据里收集**（不是穷举词表）：数据里有 xcpc / cf
const chipValues = filterBox().querySelectorAll('.dedup-chip').map(c => c.dataset.value);
ok(chipValues.includes('xcpc') && chipValues.includes('cf'),
    'nature 芯片的取值来自当前数据（xcpc / cf 都真的出现过）');
ok(chipValues.includes('unowned') && chipValues.includes('any'), '有「归入状态」两档');
ok(chipValues.includes('C') && chipValues.includes('P') && chipValues.includes('R') === false,
    '「类型」只列真的出现过的类型（这一棵树里没有 R）');

// ---- 跨性质：把 C3 的两题单独筛出来（nature 选 xcpc）⇒ 那对仍然不出现 ----
clickChip('xcpc');
eq(hitN(), 1, 'nature 选 xcpc ⇒ 只剩 C1 那一对');
ok(clickChip('cf'), '（再加一个 cf）');
eq(hitN(), 2, '同一维多选 = **或**（xcpc + cf ⇒ 两对都出）');
ok(clickChip('xcpc'), '（取消 xcpc，只留 cf）');
eq(hitN(), 1, 'nature 只选 cf ⇒ 只剩 C2 那一对');
ok(clickChip('cf'), '（取消 cf，恢复不筛）');
eq(hitN(), 2, '取消 nature 筛选 ⇒ 回到 2 条');

// ---- 范围：单场比赛 ----
pickScope('contest');
eq(selects().length, 2, '选了「单场比赛」⇒ 多出一个比赛下拉框（+ 场次筛选输入框）');
const contestSel = selects()[1];
const contestValues = contestSel.querySelectorAll('option').map(o => o.value);
ok(contestValues.includes('c1') && contestValues.includes('c2'), '比赛下拉列出 C 容器');
contestSel.value = 'c1';
contestSel.dispatchEvent({ type: 'change' });
eq(hitN(), 1, '缩到 c1 ⇒ 只剩该容器内的 1 条（C2 那条被范围排除）');
ok(/单场比赛/.test(hitText()) && /浙江省赛/.test(hitText()), '命中那行写清楚"现在看的是哪一场"');

// 换到 c3（跨性质那对所在的比赛）⇒ 0 条
const sel3 = selects()[1];
sel3.value = 'c3';
sel3.dispatchEvent({ type: 'change' });
eq(hitN(), 0, '缩到 c3 ⇒ 0 条（那两题同名同号，但**跨性质**，所以不建议）');
ok(!!pane.querySelector('.dedup-empty'), '0 条时给出解释文案，而不是空白');
ok(/跨性质|宁可空着/.test(serialize(pane.querySelector('.dedup-empty'))), '文案说明"这是正常的"');

// ---- 关键词 ----
const back = selects()[1];
back.value = 'c1';
back.dispatchEvent({ type: 'change' });
eq(hitN(), 1, '（回到 c1）');
clickChip('xcpc');                                  // 加一层 nature
eq(hitN(), 1, '（c1 + xcpc）仍然 1 条');
const kwInput = filterBox().querySelectorAll('input').find(i => (i.placeholder || '').includes('题名'));
ok(!!kwInput, '有关键词输入框（题名 / 题号）');
kwInput.value = '江苏省赛';                          // 与 c1 里的题无关
kwInput.dispatchEvent({ type: 'input' });
eq(hitN(), 0, '关键词不匹配 ⇒ 一条都不剩（条件真的参与了重算）');
clickChip('xcpc');                                  // 取消 nature
const kw2 = filterBox().querySelectorAll('input').find(i => (i.placeholder || '').includes('题名'));
kw2.value = 'Two Sum';
kw2.dispatchEvent({ type: 'input' });
eq(hitN(), 1, '关键词「Two Sum」⇒ 只剩那一对');

// ---- 相似度辅助：默认关闭；开启后噪声回来（并给出警示） ----
ok(!/已开启相似度建议/.test(serialize(pane)), '默认不显示相似度建议（没有警示条）');
const beforeSim = hitN();
ok(clickChip('similarity'), '有「开启相似度建议」开关');
ok(/只是名字像|不是同一个东西/.test(serialize(pane)), '开启后**明确警示**这些不是同一个东西');
ok(hitN() > beforeSim, `开启后建议变多（${beforeSim} → ${hitN()}）—— "Two Sums" 那种名字像的被放出来`);
ok(clickChip('similarity'), '（关回去）');
eq(hitN(), beforeSim, '关掉之后就回到硬门槛的条数');
ok(!/已开启相似度建议/.test(serialize(pane)), '警示条也跟着消失');

// ---- 清空条件 ----
ok(!!filterBox().querySelector('.dedup-clear'), '有「清空条件」');
filterBox().querySelector('.dedup-clear').click();
eq(hitN(), 2, '清空条件 ⇒ 范围与筛选全部复原（回到整棵树的 2 条）');
eq(selects().length, 1, '范围也回到「整棵树」（只剩范围那一个下拉框）');

function kwTextOf() {
    const i = filterBox().querySelectorAll('input').find(x => (x.placeholder || '').includes('题名'));
    return i ? i.value : '';
}
eq(kwTextOf(), '', '关键词输入框里是空的');

// ⚠️ 这一组动过页面级状态（`viewState`），收尾统一复原，免得影响后面的分组
filterBox().querySelector('.dedup-clear').click();
eq(hitN(), 2, '（收尾）条件已复原');

// ===============================================================
group('判重页：③「性质待补」——列出"分类标了、年份/地区还有空缺"的节点');
// ===============================================================
// **分类是不定层路径**（`xcpc/icpc/ec/pre`），与 年份/地区 正交；
// 缺哪几项写在行尾，勾选后一次事务补一批。
seed([
    { parent: 'root', type: 'S', id: 's1', name: 'XCPC 2026' },                       // 容器：不算比赛
    {
        parent: 's1', type: 'C', id: 'c1', name: '浙江省赛（已齐）',
        // ⚠️ 必须是**叶子**（`xcpc/icpc` 这种停在中间的**不算填好**）
        natureClass: 'xcpc/icpc/eu/regional/official', natureYear: '2024', natureSeason: '2024', natureRegion: '成都'
    },                                                                                // 三项齐 ⇒ 不列
    { parent: 's1', type: 'C', id: 'c2', name: '江苏省赛', natureClass: 'xcpc/ccpc/final/official',
      natureYear: '2024', natureSeason: '2024' },
    { parent: 's1', type: 'C', id: 'c3', name: '甲站', natureClass: 'xcpc/无归类' },
    { parent: 's1', type: 'C', id: 'c4', name: 'CF Round', natureClass: 'cf/contest/div2',
      natureYear: '2025', natureSeason: '2025' }
]);
draw('nature');

const pendingBox = () => pane.querySelector('.dedup-pending');
const pendingHtml = () => serialize(pendingBox());
const rows = () => pendingBox().querySelectorAll('.dedup-pending-row');
const groupHeads = () => pendingBox().querySelectorAll('.dedup-pending-group').map(h => String(h.textContent));
const fillBox = () => pendingBox().querySelector('.dedup-pending-fill');
/** 填充条里某个字段的下拉（`field()` 的形状：`<label><span>文案</span><select>`） */
const selByLabel = (label) => {
    const l = fillBox().querySelectorAll('label').find(x => String((x.children[0] || {}).textContent) === label);
    return l ? l.querySelector('select') : null;
};
const classSel = () => selByLabel('分类');
const classOptions = () => classSel().querySelectorAll('option').map(o => String(o.value));
const inputByPlaceholder = (kw) => fillBox().querySelectorAll('input').find(i => String(i.placeholder || '').includes(kw));
const btnByText = (label) => fillBox().querySelectorAll('.btn').find(b => String(b.textContent) === label);
/** 块里任意位置的按钮（分页条挂在块上，不在填充条里） */
const pendingBtn = (label) => pendingBox().querySelectorAll('.btn').find(b => String(b.textContent) === label);
const fillBtn = () => fillBox().querySelectorAll('.btn').find(b => /填入选中/.test(String(b.textContent)));
const rowOf = (kw) => rows().find(r => serialize(r).includes(kw));
const missOf = (row) => String(row.querySelector('.dedup-pending-missing').textContent);
/** 下拉里"当前选中"的那一项的 value（桩的 `<select>.value` 只认赋值过的 `_selected`，
 *  而 `selectControl` 是用 `option.selected = true` 表达初始选中的 —— 所以这里读选项） */
const chosenOption = (sel) => {
    const o = sel.querySelectorAll('option').find(x => x.selected === true);
    return o ? String(o.value) : '';
};
/** 节点上某个字段的值（**没写过就是 undefined**：nature 三字段刻意没有默认值） */
const fieldOf = (id, key) => String((AppState.nodes[id] || {})[key] || '');
/** 勾上某一行（桩里的复选框：赋值不触发事件，得自己派发 change） */
const checkRow = (kw) => {
    const cb = rowOf(kw).querySelector('input');
    cb.checked = true;
    cb.dispatchEvent({ type: 'change' });
};

ok(!!pendingBox(), '有「性质待补」这一块（与既有三块并列，不动它们的职责）');
ok(pane.querySelectorAll('.dedup-subtab').map(b => b.dataset.section).join(',') === 'synth,dupes,nature,summary,conflict',
    '③ 排在 ② 之后、④ 之前（顺序写在 tab 栏上；⑤ 冲突在最后）');
ok(/③ 性质待补：3 条/.test(pendingHtml()), '条数 = 3（三项齐的 c1、容器 s1 都不算）');
ok(!/浙江省赛（已齐）/.test(pendingHtml()), '三项填齐的节点不列');
ok(!/XCPC 2026/.test(pendingHtml()), 'W/S 这种容器不算比赛 ⇒ 不算缺（门槛只对 C 放开）');

eq(groupHeads().length, 3, '按「分类 + 年份」分成 3 组（xcpc/ccpc/final、xcpc/无归类、cf/contest/div2 各一）');
eq(missOf(rowOf('江苏省赛')), '缺：地区', '每行写明缺哪几项（逐字段独立判）');
eq(missOf(rowOf('甲站')), '缺：年份、赛季、地区', '缺年份/赛季/地区的如实写全');
eq(missOf(rowOf('CF Round')), '缺：地区', '另一个分类支同样');

// ---- 分类 chip 行（按**第一段**分族；"『性质待补』也要分大类"）----
const mainChips = () => pane.querySelectorAll('.dedup-pending-main');
const mainChip = m => mainChips().find(c => c.dataset.main === m);
const clickMain = m => { const c = mainChip(m); if (c) c.click(); return !!c; };
const noClsChip = () => mainChips().find(c => /没标分类/.test(String(c.textContent)));
eq(mainChips().map(c => c.dataset.main).join(','), ',,xcpc,cf',
    '分类 chip = 「全部」+「没标分类」+ 各族（按 Trie 顺序），每族带条数');
ok(/全部（3）/.test(String(mainChips()[0].textContent)), '「全部」上写的是总数');
ok(/xcpc（2）/.test(String(mainChip('xcpc').textContent))
    && /cf（1）/.test(String(mainChip('cf').textContent)), '各族 chip 写的是这一支的待补数（标签 = 分类的第一段）');
ok(!!noClsChip(), '「没标分类」那个 chip **永远在**（哪怕当前 0 条）');

// ---- 填充条：一个「分类」下拉（Trie 里所有合法路径）+ 年份 / 地区 ----
ok(!!classSel(), '填充条上有「分类」下拉');
eq(classOptions()[0], '', '第一项是「不改动」');
for (const p of ['xcpc', 'xcpc/icpc', 'xcpc/icpc/ec/pre', 'cf/contest/div2', 'atcoder/arc',
    'nk/多校', 'hdu/多校', 'qoj/无归类']) {
    ok(classOptions().includes(p), `下拉里有合法路径 ${p}`);
}
ok(!classOptions().includes('cf/nope'), 'Trie 里没有的路径**不在**下拉里（控件本身就是第一道校验）');

// ===============================================================
group('判重页：③ 点「填入」真的经 execute 事务写进 nature 字段');
// ===============================================================
let txCount = 0;
document.addEventListener(EVENTS.DB_MODIFIED, () => { txCount++; });

// 选分类 `xcpc/icpc/eu`（**叶子**：`xcpc/icpc` 停在中间，填了也还是"缺分类"），勾上 c2（缺地区的那条）
classSel().value = 'xcpc/icpc/eu/regional/official';
classSel().dispatchEvent({ type: 'change' });
ok(!!rowOf('江苏省赛'), '（前提）c2 那一行在');
checkRow('江苏省赛');
ok(/填入选中的 1 条/.test(serialize(fillBox())), '勾一条 ⇒ 按钮写明要填几条');
ok(/已选 1 条/.test(serialize(fillBox())), '并显示已选条数');
eq(chosenOption(classSel()), 'xcpc/icpc/eu/regional/official', '重画后下拉仍停在刚选的值（取值都在页面级状态里）');

const txBefore = txCount;
ok(!!fillBtn(), '有「填入选中」按钮');
fillBtn().click();
await waitFor(() => AppState.nodes.c2 && AppState.nodes.c2.natureClass === 'xcpc/icpc/eu/regional/official');
eq(AppState.nodes.c2.natureClass, 'xcpc/icpc/eu/regional/official', '点一下真的写进 natureClass');
ok(txCount > txBefore, '而且经过 execute 事务（收到了 DB_MODIFIED）');
ok(JSON.stringify((AppState.nodes.c2.values || {}).natureClass || []).includes('manual'),
    '手改留痕走既有来源层（manual）—— 不是绕过 ops 直接改 draft 字段');
eq(AppState.nodes.c2.natureYear, '2024', '只写分类：年份没被动');
eq(fieldOf('c3', 'natureClass'), 'xcpc/无归类', '没勾的条目一个字都没动');
eq(fieldOf('c4', 'natureClass'), 'cf/contest/div2', '（同上）');

// ---- 年份格式挡在写之前（`26` 写下去会让"按年份筛"永远筛不到一起）----
btnByText('清空选择').click();
eq(fieldOf('c3', 'natureYear'), '', '（前提）c3 的年份还是空的');
checkRow('甲站');
const yearInput = inputByPlaceholder('20xx');
ok(!!yearInput, '有年份文本框（提示 20xx）');
yearInput.value = '26';
yearInput.dispatchEvent({ type: 'input' });
fillBtn().click();
await new Promise(r => setTimeout(r, 30));
eq(fieldOf('c3', 'natureYear'), '', '年份写成 26 ⇒ 不写数据');
eq(fieldOf('c3', 'natureRegion'), '', '（同一批的字段都没被写）');
ok(/20xx/.test(String(document.getElementById('toast').textContent)), '并且明确告诉用户年份要写成 20xx');
btnByText('清空选择').click();
const yIn = inputByPlaceholder('20xx');
yIn.value = '';
yIn.dispatchEvent({ type: 'input' });
ok(!/已选/.test(serialize(fillBox())), '（收尾）勾选已清空');

// ---- 多选 + 一次事务填一批（这是这一块存在的意义）----
ok(clickMain(''), '（前提）点回「全部」——地区不挑分类，可以跨族一起填');
const regionInput = inputByPlaceholder('Asia East');
ok(!!regionInput, '有地区文本框（年份 / 地区是自由文本）');
regionInput.value = 'Asia East';
regionInput.dispatchEvent({ type: 'input' });
checkRow('江苏省赛');
checkRow('CF Round');
ok(/填入选中的 2 条/.test(serialize(fillBox())), '勾两条 ⇒ 一个按钮填两条');
fillBtn().click();
await waitFor(() => AppState.nodes.c2 && AppState.nodes.c2.natureRegion === 'Asia East'
    && AppState.nodes.c4 && AppState.nodes.c4.natureRegion === 'Asia East');
eq(AppState.nodes.c2.natureRegion, 'Asia East', 'c2 的地区写进去了');
eq(AppState.nodes.c4.natureRegion, 'Asia East', '同一批里的 c4 也写进去了（同一个事务）');
eq(fieldOf('c3', 'natureRegion'), '', '没勾的 c3 不受影响');
draw('nature');
ok(/③ 性质待补：1 条/.test(pendingHtml()), '补全的两条从列表消失（数据一变就重算）');
ok(!/江苏省赛/.test(pendingHtml()) && !/CF Round/.test(pendingHtml()), '它们不在了');
''

// ===============================================================
group('判重页：③ 性质待补的**规模**与分页（两三万条也不会一次画出来）');
// ===============================================================
// 这一块在真实数据里会很长（地区一律留空）—— 所以列表必须有分页/上限，
// 照判重页既有分页写法（每页 25 条）。这一组用 30 条钉"只画当前页"。
const many = [];
for (let i = 0; i < 30; i++) {
    many.push({ parent: 's1', type: 'C', id: `m${i}`, name: `第 ${i} 场`, natureClass: 'xcpc/icpc' });
}
seed([{ parent: 'root', type: 'S', id: 's1', name: 'XCPC' }, ...many]);
draw('nature');
ok(/③ 性质待补：30 条/.test(pendingHtml()), '30 条都算待补（年份 / 地区为空）');
eq(rows().length, 25, '⚠️ 一页只画 25 行（不是 30）');
ok(/每页 25 条/.test(pendingHtml()), '页面上写明每页多少条');
ok(/第 1 \/ 2 页/.test(pendingHtml()), '有分页（30 条 → 2 页）');
btnByText('全选本页').click();
ok(/已选 25 条/.test(serialize(fillBox())), '「全选本页」只勾当前页的 25 条（不勾看不见的）');
btnByText('清空选择').click();
ok(!/已选/.test(serialize(fillBox())), '「清空选择」把勾清掉');
pendingBtn('下一页 ▶').click();
eq(rows().length, 5, '第 2 页 5 行');
ok(/（续）/.test(pendingHtml()), '组头跨页时标「（续）」（组标题里的条数是该组总数）');

// ===============================================================
group('判重页：③ 性质待补的空状态（没有待补的 ⇒ 有话可说，不留空框）');
// ===============================================================
seed([
    { parent: 'root', type: 'S', id: 's1', name: 'XCPC' },
    {
        parent: 's1', type: 'C', id: 'c1', name: '浙江省赛',
        natureClass: 'xcpc/icpc/eu/regional/official', natureYear: '2024', natureSeason: '2024', natureRegion: '成都'
    },
    // ⚠️ 这里必须是 **P**（题）而不是 C："比赛（C）没有大类"本身就算待补
    //    （见 `missingNatureKeysOf` 的 `MAIN_REQUIRED_TYPES`），拿 C 当"没标性质的节点"
    //    会让这一组变成 1 条、测不到空状态。
    { parent: 's1', type: 'P', id: 'c2', name: '没标性质的题' }
]);
draw('nature');
ok(/③ 性质待补：0 条/.test(pendingHtml()), '标题如实写 0 条');
ok(!!pendingBox().querySelector('.dedup-pending-empty'), '空的时候有专门的一块文案（不是空框）');
ok(/没有待补的/.test(pendingHtml()), '文案说清"没有待补的"');
eq(rows().length, 0, '一行都没有');
eq(pendingBox().querySelectorAll('select').length, 0, '连下拉都不画（没有可填的东西）');

// ===============================================================
group('判重页：③ **比赛（C）连分类都没标**也要列出来 + 能就地补分类');
// ===============================================================
// 口径："性质待补的大类还是没有" —— 若"大类非空"是所有类型的入选门槛，
// 则"连分类都没标的比赛"既进不了这一块、也没地方补。所以门槛只对 C 放开。
seed([
    { parent: 'root', type: 'S', id: 's1', name: 'XCPC' },
    { parent: 's1', type: 'C', id: 'c1', name: '没标分类的比赛' },                 // C：进列表
    { parent: 's1', type: 'P', id: 'p1', name: '没标分类的题' },                   // P：不进
    { parent: 's1', type: 'C', id: 'c2', name: '标了的比赛', natureClass: 'xcpc/icpc', natureSeason: '2024' }
]);
draw('nature');
ok(/③ 性质待补：2 条/.test(pendingHtml()), '两条 C（一条没分类、一条缺年份/地区）都在；P 不在');
eq(rows().length, 2, '两行');
eq(missOf(rowOf('没标分类的比赛')), '缺：分类、年份、赛季、地区',
    '★ 连分类都没标的比赛，行尾把**分类**也写进"缺"里（顺序 = 字段顺序）');
ok(!/没标分类的题/.test(pendingHtml()), 'P（题）没有分类**不算缺** —— 题不背比赛级的性质');
eq(mainChips().map(c => c.dataset.main).join(','), ',,xcpc',
    '分类 chip 行：`全部`（空串）+ `没标分类`（空串，**永远在**）+ `XCPC`');
ok(!!mainChip('xcpc') && /xcpc（1）/.test(String(mainChip('xcpc').textContent)), 'xcpc 这一支 1 条');
ok(/没标分类 · 赛季未知（待补 1 条）/.test(pendingHtml()),
    '空分类的组头写「没标分类」；组头那个值是**赛季**（空 ⇒ `赛季未知`）');
ok(/xcpc \/ icpc · 2024赛季（待补 1 条）/.test(pendingHtml()),
    '组头那个值是**赛季**，真年份念成 `2024赛季`（用户："把 `.2023` 改为 `.2023赛季`"）');

// 只看"没标分类"那一组（哨兵值把它与「全部」分开 —— 两者的 dataset.main 都是空串，
// 所以这里按**文案**找那个 chip）
const noMainChip = () => mainChips().find(c => /没标分类/.test(String(c.textContent)));
ok(!!noMainChip(), '有一个「没标分类（N）」chip（**不管有没有这样的条目都在**）');
noMainChip().click();
eq(rows().length, 1, '点「没标分类」那一个 chip ⇒ 只剩它');
ok(/没标分类的比赛/.test(pendingHtml()) && !/标了的比赛/.test(pendingHtml()), '确实只剩那一组');
mainChips()[0].click();
eq(rows().length, 2, '点回「全部」⇒ 两条都回来');

// 就地补分类：填充条上那个「分类」下拉（Trie 里所有合法路径）
ok(!!classSel(), '填充条上有「分类」下拉（否则"缺：分类"无处可填）');
eq(classOptions()[0], '', '第一项是「不改动」');
ok(classOptions().includes('xcpc/icpc') && classOptions().includes('cf/contest/div2'), '列的是 Trie 里的路径');
classSel().value = 'xcpc/icpc';
classSel().dispatchEvent({ type: 'change' });
checkRow('没标分类的比赛');
fillBtn().click();
await waitFor(() => fieldOf('c1', 'natureClass') === 'xcpc/icpc');
eq(fieldOf('c1', 'natureClass'), 'xcpc/icpc', '★ 点「填入」真的把分类写进节点');
eq(fieldOf('c1', 'natureYear'), '', '只填了分类，年份一个字没动（没填就不写）');
eq(fieldOf('c2', 'natureClass'), 'xcpc/icpc', '没勾的那条不动');
btnByText('清空选择').click();

// ---- ③ 的**分类 / 年份 / 地区筛选**（与填充条分开的那一行；填充条是"要写入的值"，不筛）----
const filterRow = () => pendingBox().querySelector('.dedup-pending-filter');
// ③ 的筛选行是**芯片多选**（`kit.js` 的 `chipGroup`）。下面这些断言按"**替换成一个值**"驱动
// —— 先把这一行里已选中的都取消，再点目标芯片（真实用户也能这么点）；"多选并集"另有断言。
// 返回的对象**长得像 `<select>`**（`querySelectorAll('option')` / `.value` / `dispatchEvent`），
// 好让既有的 `chosenOption(...)` 与断言写法原样能用。
const fsSel = (label) => {
    // ⚠️ 每次都**重新查**：点一下芯片就整块重画，旧的节点当场作废
    const row = () => filterRow().querySelectorAll('label')
        .find(x => String((x.children[0] || {}).textContent) === label);
    const chips = () => (row() ? row().querySelectorAll('.dedup-chip') : []);
    const isOn = (c) => String(c.className).includes('dedup-chip-on');
    // ⚠️「依据」那一档**仍是单选 `<select>`**（它是"门槛"不是"取值集合"）⇒ 原样返回，别适配
    const realSelect = () => (row() ? row().querySelector('select') : null);
    const opts = () => chips().map(c => ({
        value: c.dataset.value,
        textContent: String(c.textContent),
        get selected() { return isOn(c); }
    }));
    const real = realSelect();
    if (real) return real;                                  // 「依据」还是下拉 ⇒ 直接给它
    return {
        querySelectorAll: (sel) => (sel === 'option' ? opts() : chips()),
        get value() { const o = opts().find(x => x.selected); return o ? o.value : ''; },
        set value(v) {
            for (const c of chips()) if (isOn(c)) c.click();
            if (v === '' || v === '\u0000all') return;      // `\u0000all` = 「全部」= 一个都不选
            const c = chips().find(x => x.dataset.value === v);
            if (c) c.click();
        },
        dispatchEvent() { }                                  // 芯片是 click 驱动的 ⇒ 这里空操作
    };
};ok(!!filterRow(), '③ 有一行**筛选**（`.dedup-pending-filter`），与填充条分开');
ok(/批量填入/.test(serialize(fillBox())), '填充条自己写着「✍️ 批量填入」的标题（别和筛选看混）');
eq(filterRow().querySelectorAll('label').map(l => String((l.children[0] || {}).textContent)).join(','),
    '分类,年份,赛季,地区,依据',
    '★ 筛选行 = 分类 / 年份 / 赛季 / 地区（与 nature 四字段一一对应）+「依据」（分类的规则强度）');
seed([
    { parent: 'root', type: 'S', id: 's1', name: 'XCPC' },
    // c1：**有地区、缺年份**（这样才能筛地区 —— 三项齐的节点根本不在待补列表里）
    { parent: 's1', type: 'C', id: 'c1', name: '甲赛', natureClass: 'xcpc/icpc', natureRegion: '成都' },
    { parent: 's1', type: 'C', id: 'c2', name: '乙赛', natureClass: 'xcpc/ccpc', natureYear: '2024' },
    { parent: 's1', type: 'C', id: 'c3', name: '丙赛', natureClass: 'cf/contest/div2' }
]);
draw('nature');
eq(rows().length, 3, '（前提）三条待补');
eq(fsSel('分类').querySelectorAll('option').map(o => String(o.textContent)).sort().join(','),
    ['（没标分类）', '（分类不完全）', 'cf', 'cf / contest', 'cf / contest / div2', 'xcpc', 'xcpc / ccpc', 'xcpc / icpc']
        .sort().join(','),
    '分类筛选项 =「（没标分类）」+ **「（分类不完全）」** + 数据里出现过的路径（含祖先）；「全部」= 一个都不选（芯片多选）');
// ★「（分类不完全）」= 有值但没到 Trie 的叶子（"筛选分类要增加『（分类不完全）』选项"）
fsSel('分类').value = '\u0000partial';
fsSel('分类').dispatchEvent({ type: 'change' });
eq(rows().length, 2, '★ 选「（分类不完全）」⇒ 命中 xcpc/icpc 与 xcpc/ccpc 两条（都停在半路）');
ok(!/丙赛/.test(pendingHtml()), '叶子（cf/contest/div2）那条不在里面');
fsSel('分类').value = '\u0000all';
fsSel('分类').dispatchEvent({ type: 'change' });
eq(rows().length, 3, '切回「全部」⇒ 三条都回来');
// ★ **多选**（v9.0.10）：同时选两支 ⇒ **并集**（维度内"或"、维度之间"与"）——与 ② 同一条口径
{
    const clickChip = (label, value) => {
        const r = filterRow().querySelectorAll('label').find(x => String((x.children[0] || {}).textContent) === label);
        r.querySelectorAll('.dedup-chip').find(c => c.dataset.value === value).click();
    };
    clickChip('分类', 'xcpc/icpc');
    clickChip('分类', 'cf/contest/div2');
    eq(rows().length, 2, '★ 同时选 `xcpc/icpc` 与 `cf/contest/div2` ⇒ 两条都算（`xcpc/ccpc` 那条不在，它俩不互相包含）');
    clickChip('分类', 'xcpc/icpc');
    eq(rows().length, 1, '再点一下取消一个 ⇒ 只剩 `cf/contest/div2` 那一条（丙赛）');
    clickChip('分类', 'cf/contest/div2');
    eq(rows().length, 3, '都取消 ⇒ 回到"不筛"');
}
eq(fsSel('年份').querySelectorAll('option').map(o => String(o.textContent)).sort().join(','),
    '2024,（有标年份）,（没标年份）'.split(',').sort().join(','),
    '年份筛选项 = 出现过的年份 +「（没标年份）」+「（有标年份）」（多选；空选 = 全部）');
eq(fsSel('赛季').querySelectorAll('option').map(o => String(o.textContent)).sort().join(','),
    '（有标赛季）,（没标赛季）'.split(',').sort().join(','),
    '★ 赛季筛选项 =「（没标赛季）」+「（有标赛季）」（这批夹具都没填赛季）');
eq(fsSel('地区').querySelectorAll('option').map(o => String(o.textContent)).sort().join(','),
    '成都,（有标地区）,（没标地区）'.split(',').sort().join(','),
    '★ 地区筛选项 = 出现过的地区 +「（没标地区）」+「（有标地区）」');
// ★「（有标 X）」= 这一维**非空**（第三个选项）：
//   与「（没标 X）」互补、合起来是全部 —— "哪几维已经处理过了"一眼可见。
fsSel('年份').value = '\u0000filled';
fsSel('年份').dispatchEvent({ type: 'change' });
eq(rows().length, 1, '★ 选「（有标年份）」⇒ 只剩填了年份的那条');
ok(/乙赛/.test(pendingHtml()), '正是 c2（夹具里唯一带 natureYear 的）');
fsSel('年份').value = '\u0000empty';
fsSel('年份').dispatchEvent({ type: 'change' });
eq(rows().length, 2, '★ 选「（没标年份）」⇒ 另外两条（有标 + 没标 = 全部）');
fsSel('年份').value = '';
fsSel('年份').dispatchEvent({ type: 'change' });
eq(rows().length, 3, '筛回「全部」⇒ 三条都回来');
fsSel('分类').value = 'xcpc';
fsSel('分类').dispatchEvent({ type: 'change' });
eq(rows().length, 2, '★ 按**前缀** xcpc 筛 ⇒ 命中 xcpc/icpc 与 xcpc/ccpc 两条');
ok(!/丙赛/.test(pendingHtml()), 'cf/contest/div2 那条被筛掉');
ok(/筛后 2 \/ 3 条/.test(serialize(filterRow())), '筛后条数写在筛选行右边');
fsSel('地区').value = '成都';
fsSel('地区').dispatchEvent({ type: 'change' });
eq(rows().length, 1, '叠加地区=成都 ⇒ 只剩带成都的那条（各维之间是"与"）');
ok(/甲赛/.test(pendingHtml()), '正是 c1');
fsSel('分类').value = 'xcpc/ccpc';
fsSel('分类').dispatchEvent({ type: 'change' });
eq(rows().length, 0, '★ 缩到更深的路径 xcpc/ccpc ⇒ 与"地区=成都"没有交集');
ok(/筛后 0 \/ 3 条/.test(serialize(filterRow())), '筛后 0 条也如实写');
fsSel('地区').value = '';
fsSel('地区').dispatchEvent({ type: 'change' });
eq(rows().length, 1, '去掉地区 ⇒ 又只剩 xcpc/ccpc 那条（**换得回去**：候选取自全部待补项）');
// 分类下拉与 chip 行**同一份状态**
fsSel('分类').value = 'cf';
fsSel('分类').dispatchEvent({ type: 'change' });
eq(rows().length, 1, '换成 cf 那一支 ⇒ 只有 cf/contest/div2 那条');
ok(String(mainChips().find(c => /^cf（/.test(String(c.textContent))).className)
    .includes('dedup-pending-main-on'),
    '★ 用下拉改了分类 ⇒ chip 行的高亮跟着变（两边同值）');
pendingBtn('清空筛选').click();
eq(rows().length, 3, '「清空筛选」⇒ 恢复三条（分类也回「全部」）');
ok(String(mainChips()[0].className).includes('dedup-pending-main-on'),
    'chip 行回到「全部」高亮');

// ===============================================================
// ★ 依据强度：分类那一格的**徽标** + 「依据 ≤ X」筛选
// ===============================================================
// 口径："引入『可信度级别』概念" + "筛选『只看 C 以下』"。
// 规则 id 由**爬虫**写进元列 `分类依据`（`{ natureClass: 'qoj:path-icpc' }`），
// 界面只查表（`core/natureConfidence.js` 的 `CLASS_RULE_LEVEL`）—— 不许两边各写一份。
// 这里钉三件事：
//   ① 徽标 = 分类那一格文案末尾的 ` · A`，且 `dataset.level` / `dataset.rule` 都在；
//   ② 「依据」筛选按**该级及更弱**收（"只看 C 以下" = 选 `≤ C`；A 最硬 ⇒ `≤ A` 只排除"没有依据"的）；
//   ③ **级别未知（人填的 / 老数据）不进任何一档** —— 它们不是"依据弱"，是"没有依据这回事"。
seed([
    { parent: 'root', type: 'S', id: 's1', name: 'XCPC' },
    // 甲：A（QOJ 自己的分类路径）；乙：C（赛名里的字面词）；丙：D（靠城市/大区词推赛区）
    // 戊：E（什么都没命中，`qoj/无归类` 那种）；丁：**没有那一列**（人填的 / 老数据）
    { parent: 's1', type: 'C', id: 'c1', name: '依甲', natureClass: 'xcpc/icpc', natureRegion: '成都',
        '分类依据': { natureClass: 'qoj:path-icpc' } },
    { parent: 's1', type: 'C', id: 'c2', name: '依乙', natureClass: 'xcpc/ccpc', natureYear: '2024',
        '分类依据': { natureClass: 'xcpc:name-stage' } },
    { parent: 's1', type: 'C', id: 'c3', name: '依丙', natureClass: 'cf/contest/div2',
        '分类依据': { natureClass: 'gym:infer-region' } },
    { parent: 's1', type: 'C', id: 'c4', name: '依丁', natureClass: 'xcpc/icpc' },
    { parent: 's1', type: 'C', id: 'c5', name: '依戊', natureClass: 'qoj/无归类',
        '分类依据': { natureClass: 'qoj:unclassified' } }
]);
draw('nature');
eq(rows().length, 5, '（前提）五条待补');
const clsChipOf = id => pendingBox().querySelectorAll('.dedup-nature-chip')
    .find(c => c.dataset.id === id && c.dataset.field === 'natureClass');
eq(clsChipOf('c1').dataset.level, 'A', '★ 元列 `分类依据` 的规则 id ⇒ 徽标级别（查表得来）');
eq(clsChipOf('c1').dataset.rule, 'qoj:path-icpc', '规则 id 也挂在 dataset 上（排查"这条凭什么"）');
ok(/ · A$/.test(String(clsChipOf('c1').textContent)), '★ 分类那一格文案末尾带 ` · A`');
eq(clsChipOf('c4').dataset.level, undefined, '★ 没有 `分类依据`（人填的 / 老数据）⇒ **不画**徽标');
ok(!/ · /.test(String(clsChipOf('c4').textContent)), '连文案里的级别也不写（不许瞎猜一个）');
// ⚠️ 钉子改口径：以前这里钉的是**标题里带 `**未知**` 字面量**（那是把"记号漏到悬停提示里"
//    当成了正确行为）。悬停提示同样是给人看的字 ⇒ 现在钉"**去记号之后**仍然说清为什么"。
ok(/依据：未知/.test(String(clsChipOf('c4').title))
    && /老数据/.test(String(clsChipOf('c4').title)),
    '★ 但 title 要**说清为什么**（"手填的 / 老数据"），且**不带 Markdown 记号**');
ok(!/\*\*/.test(String(clsChipOf('c4').title)) && !/\*\*/.test(String(clsChipOf('c1').title)),
    '★ 悬停提示里不许有 `**`（`title` 也是给人看的字）');
ok(/规则 qoj:path-icpc/.test(String(clsChipOf('c1').title)), '有依据时 title 写明是哪条规则判的');
const lvSel = () => fsSel('依据');
eq(lvSel().querySelectorAll('option').map(o => String(o.textContent)).join(','),
    '全部,M 人工（只看我填的）,≤ E 无依据,≤ D 推断,≤ C 明确字面词,≤ B 结构,≤ A 权威',
    '★ 「依据」= 「全部」+「M 人工」（单选那一档）+ 五档规则级别（文案与强度序都取自 natureConfidence）');
lvSel().value = 'A';
lvSel().dispatchEvent({ type: 'change' });
eq(rows().length, 4, '★ `≤ A`（最宽的一档）⇒ 所有**有依据**的都收，只挡掉"没有依据"那条');
ok(!/依丁/.test(pendingHtml()), '★ 级别未知那条不在 —— 它不是"弱"，是没有依据这回事');
lvSel().value = 'C';
lvSel().dispatchEvent({ type: 'change' });
eq(rows().length, 3, '★ `≤ C`（"只看 C 以下"）⇒ C / D / E 三条');
ok(/依乙/.test(pendingHtml()) && /依丙/.test(pendingHtml()) && /依戊/.test(pendingHtml()),
    '正是乙（C）/ 丙（D）/ 戊（E）');
ok(!/依甲/.test(pendingHtml()), '★ A 那条（最硬）被挡在外面 —— 依据够硬的不必复核');
lvSel().value = 'E';
lvSel().dispatchEvent({ type: 'change' });
eq(rows().length, 1, '★ `≤ E`（最窄）⇒ 只剩最没有依据的那条');
ok(/依戊/.test(pendingHtml()), '正是戊');
lvSel().value = '';
lvSel().dispatchEvent({ type: 'change' });
eq(rows().length, 5, '筛回「全部」⇒ 五条都回来');

// ★ 手改分类 ⇒ 标成 **M（人工）**（"手改的 nature 可以标为 M"）——
//   走填充条那条真实写路径（与编辑弹窗同一套 ops），不是在测试里直接改对象。
checkRow('依甲');
classSel().value = 'xcpc/ccpc';
classSel().dispatchEvent({ type: 'change' });
fillBtn().click();
await waitFor(() => fieldOf('c1', 'natureClass') === 'xcpc/ccpc');
eq(fieldOf('c1', 'natureClass'), 'xcpc/ccpc', '（前提）分类真的改掉了');
eq(classRuleOf(AppState.nodes.c1), 'manual:set', '★ 人改过 ⇒ 依据改成 `manual:set`（不是清空）');
// ⚠️ 走完写路径后要 `draw()` 一次（= `invalidateDedupCache()`）：③ 的条目是**算出来的缓存**，
//    写路径自己只 redraw、不作废缓存 —— 芯片读的是活节点（所以上面两条已经对），
//    而下面要按"依据级别"筛，必须让条目重新算过。
pendingBtn('清空选择').click();
draw('nature');
eq(clsChipOf('c1').dataset.level, 'M', '★ 徽标变成 M');
ok(/ · M$/.test(String(clsChipOf('c1').textContent)), '文案末尾写 ` · M`');
eq(clsChipOf('c1').dataset.rule, 'manual:set', 'dataset 里也带得上（排查用）');
// M 比 A 还硬 ⇒ 任何「≤ X」都不收它；要看它得选专门的「M 人工」那一档
lvSel().value = 'A';
lvSel().dispatchEvent({ type: 'change' });
ok(!/依甲/.test(pendingHtml()), '★ `≤ A` 不收 M（人填的不是"依据弱"）');
lvSel().value = 'M';
lvSel().dispatchEvent({ type: 'change' });
eq(rows().length, 1, '★ 选「M 人工」⇒ 只剩人填的那条');
ok(/依甲/.test(pendingHtml()), '正是依甲');
lvSel().value = '';
lvSel().dispatchEvent({ type: 'change' });
eq(rows().length, 5, '筛回「全部」⇒ 五条都回来');

// ★ 回代 baseline 的导出入口 ——
//   `docs/manual-workflow.md`（回代三件套） 的 ③：应用导出"人定过的 nature"，脚本读它做 baseline。
// ★ 口径："不用备份,直接写入" + 缩水时"**后者**" ⇒ **POST 直接写盘**：
//   不走下载（浏览器会存成 `nature-assignments (2).json`，还得靠人挑最新的 + 放对位置）。
//   这一组钉四件事：① 正常一路 ⇒ 只打一次接口、**不下载**；② 缩水（409）⇒ **先问**，
//   取消则一个字不写；③ 确认后重发**带 confirm**；④ 服务器不在 ⇒ 退回下载。
{
    const expBtn = () => pendingBox().querySelector('.dedup-baseline-export');
    ok(!!expBtn(), '③ 有「📤 导出人工填写」按钮');
    const toast = () => String(document.getElementById('toast').textContent);
    const settle = () => new Promise((r) => setImmediate(r));       // 处理器是 async 的
    const realFetch = globalThis.fetch;
    const realConfirm = window.confirm;
    const calls = [];
    const downloads = [];
    const stub = (status, body) => async (url, opts = {}) => {
        calls.push({ url: String(url), method: opts.method || 'GET',
            body: opts.body ? JSON.parse(opts.body) : null });
        return { ok: status >= 200 && status < 300, status, json: async () => body };
    };
    const okReply = { ok: true, path: 'acm-data/nature-assignments.json', count: 1, fields: 1,
        diff: { added: 1, removed: 0, changed: 0, addedKeys: ['aux-xcpcio:c:a'], removedKeys: [] } };
    const shrink = { ok: false, error: '这次比磁盘上那份少了 1 个节点（1 处值）——先确认再写',
        needConfirm: true, diff: { added: 0, removed: 1, changed: 0,
            removedKeys: ['qoj:c:3871'], addedKeys: [], changedKeys: [] } };
    // 拦下 a.click()（真浏览器会下载，桩里只是个元素）——**退路那条**才该走到它
    const realCreate = document.createElement;
    document.createElement = (tag) => {
        const el = realCreate.call(document, tag);
        if (String(tag).toLowerCase() === 'a') {
            const realClick = el.click ? el.click.bind(el) : null;
            el.click = () => { downloads.push(String(el.download || '')); if (realClick) realClick(); };
        }
        return el;
    };
    try {
        // ① 正常：直接写盘，**不下载**
        globalThis.fetch = stub(200, okReply);
        expBtn().click();
        await settle();
        eq(calls.length, 1, '点一下 ⇒ 只打一次接口');
        ok(/api\/nature-assignments$/.test(calls[0].url) && calls[0].method === 'POST',
            '★ 走的是 `POST /api/nature-assignments`（页面传不了文件名）');
        ok(calls[0].body && calls[0].body.doc && calls[0].body.doc.format === 'nature-assignments'
            && calls[0].body.confirm === false, 'body 里是**整份文档**（confirm 默认 false）');
        ok(/已写入 acm-data\/nature-assignments\.json/.test(toast()), 'toast 说清写到哪了');
        ok(downloads.length === 0, '★ 直接写盘这条路**不下载**（"文件名被加 (2)"的问题就此消失）');

        // ② 缩水被拒（409）⇒ **先问**；用户取消 ⇒ 一个字不写、不再打接口
        calls.length = 0;
        let seen = '';
        globalThis.fetch = stub(409, shrink);
        window.confirm = (msg) => { seen = String(msg); return false; };
        expBtn().click();
        await settle();
        ok(/少了 1 个节点/.test(seen) && /qoj:c:3871/.test(seen),
            '★ 弹的那句话写清"少了几个、是哪些"');
        eq(calls.length, 1, '取消 ⇒ **不再重发**（磁盘上那份没动）');
        ok(/已取消/.test(toast()), 'toast 说明取消了');
        ok(downloads.length === 0, '取消时更不该下载');

        // ③ 用户点确认 ⇒ 重发**带 confirm**（写盘那个 200 才算数）
        calls.length = 0;
        globalThis.fetch = stub(409, shrink);
        window.confirm = () => true;
        const results = [shrink, okReply];
        globalThis.fetch = async (url, opts = {}) => {
            calls.push({ url: String(url), method: opts.method || 'GET',
                body: opts.body ? JSON.parse(opts.body) : null });
            const body = results[Math.min(calls.length - 1, results.length - 1)];
            return { ok: body.ok, status: body.ok ? 200 : 409, json: async () => body };
        };
        expBtn().click();
        await settle();
        await settle();
        eq(calls.length, 2, '先被拒一次、确认后再发一次');
        eq(calls[1].body.confirm, true, '★ 第二次带 `confirm: true`');
        ok(/已覆盖写入/.test(toast()), '写成了：toast 说"已覆盖写入"');

        // ④ 服务器不在（旧进程 / 没起主脚本）⇒ **退回到下载**
        calls.length = 0;
        globalThis.fetch = async () => { throw new Error('连不上'); };
        expBtn().click();
        await settle();
        eq(downloads.join(','), 'nature-assignments.json',
            '★ 写盘不成就退回下载一份 `nature-assignments.json`（并提示放哪）');
        ok(/已下载一份/.test(toast()), 'toast 写清退路与"重启主脚本才能直接写"');
    } finally {
        globalThis.fetch = realFetch;
        window.confirm = realConfirm;
        document.createElement = realCreate;
    }

    // ★ 脚本端的**只读核对**（"加由原料脚本端给出的『手输与自动计算结果一致』的
    //   列表，作为只读提示"）：数据来自包顶层 `reports.baseline`（应用**不重算** —— 它不知道
    //   "若不禁用人工标记，管线会判成什么"）。这一组钉：摘要数字、点开才列、列表里带脚本的依据 id。
    {
        const verdict = () => pendingBox().querySelector('.dedup-baseline-verdict');
        const listBox = () => pendingBox().querySelector('.dedup-baseline-same');
        const toggle = () => pendingBox().querySelector('.dedup-baseline-same-toggle');
        const savedReports = AppState.reports;
        try {
            AppState.reports = null;
            // 夹具里放一条**带 extKey 的真节点**：报告里给的是 extKey，靠它解析出节点才能跳树
            seed([
                { parent: 'root', type: 'S', id: 's1', name: 'XCPC' },
                { parent: 's1', type: 'C', id: 'c1', name: 'ZJCPC 2026 补题', extKey: 'qoj:c:3711',
                  natureClass: 'qoj/无归类', natureRegion: '浙江' }
            ]);
            draw('nature');
            ok(/还没有脚本端的核对/.test(serialize(pendingBox())),
                '没有报告（老包 / 还没重建）⇒ 只说一句，不报错');

            AppState.reports = { baseline: {
                baseline: { path: 'acm-data/nature-assignments.json', generatedAt: 'T', nodes: 18, fields: 29 },
                applied: 29, sameAsAuto: 2, differs: 11, filledEmpty: 16, missing: 0, invalid: 0,
                listed: 200,
                sameAsAutoItems: [
                    { key: 'qoj:c:3711', field: 'natureRegion', value: '浙江', rule: 'qoj:region-province' },
                    { key: 'qoj:c:9999', field: 'natureYear', value: '2020', rule: '' }
                ]
            } };
            draw('nature');
            const text = serialize(verdict());
            ok(/与脚本算出来的一致 2 处/.test(text) && /压住了脚本的值 11 处/.test(text)
               && /包里本来空着 16 处/.test(text), '★ 三类数字都念出来（只读）');
            ok(/18 节点 \/ 29 处/.test(text), '并说明盘上那份 baseline 有多大');
            ok(!!toggle() && listBox().style.display === 'none', '列表默认**收起**（点开才看）');
            toggle().click();
            const openText = serialize(listBox());
            ok(listBox().style.display === 'block' && /qoj:c:3711/.test(openText)
               && /脚本给的也是这个值，依据 qoj:region-province/.test(openText),
            '★ 点开后列出条目，并带上**脚本自己的依据 id**');
            ok(/（无 id）/.test(openText), '脚本那条没有 id 时如实写「（无 id）」，不假装知道');
            // ★ 那些 key **点着能跳树**（"有没有跳转"）—— 与 ①②⑤ 那几处同一条路
            const gotoIds = listBox().querySelectorAll('.dedup-goto').map((el) => el.dataset.goto);
            ok(gotoIds.length && gotoIds.every((id) => !!id),
                '报告里的 extKey 解析得到节点时就挂 `dedup-goto`（点着跳树）');
            toggle().click();
            ok(listBox().style.display === 'none', '再点一次收起');
        } finally {
            AppState.reports = savedReports;
            draw('nature');
        }
    }
}

// ===============================================================
// 判重页（⑤）：nature 四维在数据里**没有值**时要看得见
//
// 现象：② 的筛选控制栏里"没看到性质四维"。原因是芯片的取值**从数据里收集**
// （`collectDedupFacets`），而现有数据四个 nature 字段全空 ⇒ 收集出来是空 ⇒ 整行不画。
//
// 口径没变（**不从穷举词表变成可选项**）：只是把"数据里还没有这个字段"**说清楚**。
// 这一组钉：空的时候四个维度**各自**画一行灰字说明、且**一个词表取值芯片都没有**；
// 有值的时候照旧画芯片。
// ===============================================================
{
    const empties = () => filterBox().querySelectorAll('.dedup-nature-empty');
    const emptyText = () => empties().map(e => String(e.textContent)).join('｜');
    const chipValues = () => filterBox().querySelectorAll('.dedup-chip').map(c => c.dataset.value);
    /** Trie 里的**具体取值** —— 空数据上它们一个都不该出现 */
    const vocab = CLASS_PATHS.map(p => p.value);

    // ---- ① 四个 nature 字段全空：四个维度各自一行灰字说明 ----
    seed([
        { parent: 'root', type: 'S', id: 's1', name: 'XCPC 2026' },
        { parent: 's1', type: 'C', id: 'c1', name: '浙江省赛' }
    ]);
    draw('dupes');
    filterBox().querySelector('.dedup-clear').click();      // 复原上几组留下的筛选条件

    eq(empties().length, 4, '⚠️ 四个维度**都画出来了**（不再因为收集不到值就整行不画）');
    ok(/数据里还没有这个字段/.test(emptyText()), '灰字说明写清"数据里还没有这个字段"');
    ok(/导入带 nature 的包之后才会出现可选项/.test(emptyText()), '并说明什么时候才会出现可选项');
    const emptyHtml = serialize(filterBox());
    for (const key of NATURE_FIELD_KEYS) {
        const label = `性质·${natureFieldOf(key).label}`;
        ok(emptyHtml.includes(label), `灰字那一行的维度标签是「${label}」`);
    }
    ok(!chipValues().some(v => vocab.includes(v)),
        '⚠️ 一个**词表取值**芯片都没有（只是把"空"说清楚，没有穷举词表）');

    // ---- ② 数据里有值时照旧画芯片（说明只在**真的空**的那几维出现）----
    seed([
        { parent: 'root', type: 'S', id: 's1', name: 'XCPC 2026', natureClass: 'xcpc/icpc' },
        { parent: 's1', type: 'C', id: 'c1', name: '浙江省赛', natureClass: 'xcpc/icpc' }
    ]);
    draw('dupes');
    filterBox().querySelector('.dedup-clear').click();

    eq(empties().length, 3, '有值的那一维不再画说明（只剩年份 / 赛季 / 地区三行）');
    ok(chipValues().includes('xcpc'), '有值 ⇒ 照旧画芯片（分类 xcpc）');
    ok(chipValues().includes('xcpc/icpc'), '（更深的路径也在）');
    const withValueHtml = serialize(filterBox());
    // ⚠️ **按 `data-field` 认维度，别拿标签文字当代理** —— 标签是给人看的文案，
    //    改文案不该弄红测试（把四维标签统一加「性质·」前缀会误红）。
    const emptyFields = [...filterBox().querySelectorAll('.dedup-nature-empty')]
        .map(el => el.dataset.field).sort();
    eq(emptyFields.join(','), 'natureRegion,natureSeason,natureYear',
        '有值的那一维没有"数据里还没有这个字段"那一行（只剩年份 / 赛季 / 地区）');
    ok(withValueHtml.includes('性质·赛季') && withValueHtml.includes('性质·地区'),
        '空的那三维仍然各自画说明（逐维独立判，不是一刀切）');
}

// ===============================================================
group('判重页：每行都可点开源站链接 / 跳到树上（"各界面放链接…方便核对"）');
// ===============================================================
// 「跳到树上」只有**一个**入口：`EVENTS.REVEAL_NODE`（与「🔍 题目检索」同一颗事件，
// `ui/revealNode.js` 负责切页/展开祖先/滚动/高亮）。这里挂个 document 监听，
// 看点击到底有没有把它派发出去 —— 只断言"画出了 data-goto"会漏掉"事件名写错/没绑上"。
const revealed = [];
document.addEventListener(EVENTS.REVEAL_NODE, e => revealed.push(e.detail && e.detail.nodeId));
/** 夹具用的链接值（形状与来源层里的 `link` 一致） */
const L = (url, kind) => ({ v: url, src: 's1', at: '', linkKind: kind });

seed([
    { parent: 'root', type: 'S', id: 's1', name: 'XCPC 2026' },
    { parent: 's1', type: 'C', id: 'sx', name: '成都站（合成）', synthKey: 'synth:k9' },
    { parent: 's1', type: 'C', id: 'c1', name: '成都站', extKey: 'xcpc:c:chengdu',
      ownerSynth: 'synth:k9', natureClass: 'xcpc/icpc', natureYear: '2024',
      values: { link: [L('https://board.xcpcio.com/chengdu', 'board'),
                       L('https://qoj.ac/contest/2567', 'problems')] } },
    { parent: 's1', type: 'C', id: 'c2', name: '绵阳站', natureClass: 'xcpc/icpc',
      values: { link: [L('https://qoj.ac/contest/9999', 'problems')] } }
]);

// ---- ① 合成节点清单：组名与每个成员行 ----
draw('synth');
const card9 = cardByKey('synth:k9');
const memberRows = card9.querySelectorAll('.dedup-member');
eq(memberRows.length, 1, '（前提）这张卡一个成员');
const memberGo = memberRows[0].querySelector('[data-goto]');
ok(!!memberGo, '① 成员行有可点的跳转');
eq(memberGo.dataset.goto, 'c1', '跳的是这个成员自己的 id');
ok(!!memberRows[0].querySelector('.link-block'), '① 成员行带「🔗 链接」块（复用节点信息面板那块组件）');
ok(/🔗 链接 \(2\)/.test(serialize(memberRows[0])), '块上写的是这个节点的真实链接数');
ok(/qoj\.ac\/contest\/2567/.test(serialize(memberRows[0])), '链接真的画出来了（不是空块）');

const before1 = revealed.length;
memberGo.click();
eq(revealed[revealed.length - 1], 'c1', '点成员名 ⇒ 派发 REVEAL_NODE（跳到树上那个节点）');
eq(revealed.length, before1 + 1, '只派发一次（没有冒泡出第二遍）');

const headGo = card9.querySelector('.dedup-synth-name');
ok(!!headGo && headGo.dataset.goto === 'sx', '① 组名也可点（跳到合成节点自己）');

// ---- ③ 性质待补：一行一条，且**点名字不会顺带勾上勾选框** ----
draw('nature');
// ⚠️ c1 也在这张表里（它分类/年份都有，缺的是**地区**）—— 所以按 `data-goto` 精确认行，
//    不能拿"第一行"当 c2（这一条正是靠断言里那句 id 抓住的）。
const allRows = pane.querySelectorAll('.dedup-pending-row');
// ⚠️ **组头（合成节点 `sx`）不在 ③ 里了**：它那四个性质是**按成员派生**的
//    （编辑弹窗不给这四格）⇒ 列在这里等于叫人来填一个"填了也会被按成员重算走"的格子，
//    而且「批量填入」会把它一起写进去。欠账本身是**成员**的 ⇒ 由成员那条承担。
//    这条断言以前是 3（含 `sx`），改动理由见 `core/dedup.js` 的 `collectNatureItems`。
eq(allRows.length, 2, '（前提）两条待补：c1 缺地区、c2 缺年份+地区（组头不进来）');
const rowGo = id => allRows.find(r => {
    const g = r.querySelector('[data-goto]');
    return g && g.dataset.goto === id;
});
const prow = rowGo('c2');
ok(!!prow, '③ 找得到 c2 那一行');
const pname = prow.querySelector('.dedup-pending-name');
eq(pname.dataset.goto, 'c2', '③ 点名字跳的是这一行那个节点');
ok(/🔗 链接 \(1\)/.test(serialize(prow)), '③ 行里带这一行自己的链接块');
ok(!!allRows.every(r => r.querySelector('[data-goto]')) , '③ 每一行都可点');
const pcb = prow.querySelector('.dedup-pending-check');
const before3 = revealed.length;
pname.click();
eq(revealed[revealed.length - 1], 'c2', '点 ③ 的名字 ⇒ 派发 REVEAL_NODE');
eq(revealed.length, before3 + 1, '只派发一次');
// ⚠️ DOM 桩不模拟 `<label>` 的"点了就勾上控件"，这条只把口径钉住：
//    真浏览器里靠 `wireGotoLinks` 的 `preventDefault()` 拦住 label 的默认行为。
eq(pcb.checked, false, '⚠️ 点名字**不会**顺带勾上勾选框（页面对 label 的默认行为按下了 preventDefault）');

// ---- ② 可能重复：两个节点各自一行、各自可点、各自带自己的链接 ----
seed([
    { parent: 'root', type: 'S', id: 's1', name: 'XCPC 2026' },
    { parent: 's1', type: 'C', id: 'd1', name: '成都站', extKey: 'xcpc:c:chengdu',
      values: { link: [L('https://board.xcpcio.com/chengdu', 'board')] } },
    { parent: 's1', type: 'C', id: 'd2', name: '成都站', extKey: 'qoj:c:2567',
      values: { link: [L('https://qoj.ac/contest/2567', 'problems')] } }
]);
draw('dupes');
const candCards = pane.querySelectorAll('.dedup-cand');
ok(candCards.length >= 1, '（前提）出了候选');
const candRows = candCards[0].querySelectorAll('.dedup-cand-node');
eq(candRows.length, 2, '② 候选卡里两个节点**各自一行**（核对时 A/B 分得开）');
eq(candRows.map(r => r.querySelector('[data-goto]').dataset.goto).join(','), 'd1,d2',
    '两行各自可点、指向各自的 id');
ok(/🔗 链接 \(1\)/.test(serialize(candRows[0])), '② 第一行带自己的链接块');
ok(/🔗 链接 \(1\)/.test(serialize(candRows[1])), '② 第二行也带自己的链接块');
ok(!/board\.xcpcio/.test(serialize(candRows[1])), '第二行不会混进第一行的链接');
const before2 = revealed.length;
candRows[1].querySelector('[data-goto]').click();
eq(revealed[revealed.length - 1], 'd2', '点 ② 的第二行 ⇒ 跳到 d2（不是 d1）');
eq(revealed.length, before2 + 1, '只派发一次');

// ===============================================================
group('判重页：③ 年份/赛季「推荐」（有依据才出现；点一下才写入）');
// ===============================================================
// 三条铁律在这里逐条钉：**有依据才出现**（没依据连按钮都不画）、**带出处**（title 里写清）、
// **点了才写**（数据在点之前一个字都不动）。
// ⚠️ **年份（举办）与赛季是两个字段、两条依据**：
//    年份只认开赛时间，赛季认标识/名字/容器 —— 谁也不许顶替谁。
seed([
    { parent: 'root', type: 'S', id: 's1', name: '浙江省赛' },        // 容器名里**没有**年份
    { parent: 's1', type: 'C', id: 'c1', name: '甲站', extKey: 'xcpc:c:zjcpc-2026',
      natureClass: 'xcpc/icpc' },                                     // 依据 = 标识（⇒ 赛季）
    { parent: 's1', type: 'C', id: 'c2', name: '乙站', contestTime: '2024.05.01 09:00:00',
      natureClass: 'xcpc/icpc' },                                     // 依据 = 开赛时间（⇒ 年份）
    { parent: 's1', type: 'C', id: 'c3', name: '丙站', extKey: 'xcpc:c:bingzhan',
      natureClass: 'xcpc/icpc' }                                      // 没依据 ⇒ 不推荐
]);
draw('nature');

const rowById = id => pane.querySelectorAll('.dedup-pending-row').find(r => {
    const g = r.querySelector('[data-goto]');
    return g && g.dataset.goto === id;
});
/** 某一个字段的推荐按钮（`data-field` 是「年份」/「赛季」） */
const chipOf = (id, field) => {
    const r = rowById(id);
    if (!r) return null;
    const all = r.querySelectorAll('.dedup-suggest');
    return field ? (all.find(c => c.dataset.field === field) || null) : (all[0] || null);
};
eq(fieldOf('c1', 'natureSeason'), '', '（前提）c1 还没赛季');

const chip1 = chipOf('c1', '赛季');
ok(!!chip1, 'c1 有依据（标识里写着 2026）⇒ 出现**赛季**推荐按钮');
eq(chip1.dataset.value, '2026', '推荐值就是标识里那个年份');
eq(chip1.dataset.field, '赛季', '按钮上标着是哪个字段（两个字段各有一个按钮）');
ok(/标识/.test(chip1.title), '按钮的 title 写清**依据**（凭什么说它是 2026）');
ok(/点了才写入/.test(chip1.title), '并写明"点了才写入"');

const chip2 = chipOf('c2', '年份');
ok(!!chip2, 'c2 有依据（本节点的开赛时间）⇒ 出现**年份**推荐按钮');
eq(chip2.dataset.value, '2024', 'c2 的推荐值 = 开赛时间里的 2024');
ok(/开赛时间/.test(chip2.title), '依据说的是开赛时间（举办年份）');
ok(!chipOf('c2', '赛季'), '⚠️ c2 标识/名字里没有年份 ⇒ **不推赛季**（两个字段各推各的）');

// ★ 每个 ✍️ 按钮带**依据强度**（"引入『可信度级别』概念"）
eq(chip2.dataset.level, 'A', '★ 开赛时间那条的级别是 A（官方数据）');
eq(chip1.dataset.level, 'B', '★ 标识（slug）那条是 B');
ok(/依据强度/.test(chip2.title) && /A 权威/.test(chip2.title),
    '★ 按钮 title 里写清级别（鼠标停着就能看见）');
ok(/✍️ A·年份 2024/.test(String(chip2.textContent)), '★ 按钮文案里也带级别');

// ★ 「按推荐填」的门槛（"让用户选择接受 A/B/C/D/E 级及以上的推荐"）
// ⚠️ 每次改完都要**重新取**那个下拉：`redraw()` 会把填充条整个重建，旧节点已经脱离文档。
const levelSel = () => fillBox().querySelector('select.dedup-suggest-level');
const setLevel = (v) => {
    const sel = levelSel();
    sel.value = v;
    sel.dispatchEvent({ type: 'change' });
};
const suggestText = () => String(pane.querySelector('.dedup-pending-suggest-btn').textContent);
ok(!!levelSel(), '★ 填充条上有「依据≥」那个下拉');
eq(levelSel().querySelectorAll('option').map(o => o.value).join(','), 'A,B,C,D,E', '五档都在');
eq(chosenOption(levelSel()), 'D', '默认 D（= 当前的全部依据，行为不变）');
// ⚠️ 按钮上的条数说的是**勾选的那几条** ⇒ 先勾上 c1（它只有 B 级的赛季推荐）才验得出门槛
const levelCb = rowById('c1').querySelector('.dedup-pending-check');
levelCb.checked = true;
levelCb.dispatchEvent({ type: 'change' });
// 门槛 A：只收"开赛时间"那类 ⇒ c1 的赛季（B 级）不再是候选项
setLevel('A');
ok(!/（\d+ 条）/.test(suggestText()),
    `★ 门槛 A 下勾选的这条推不出（c1 只推得出 B 级的赛季）：${suggestText()}`);
setLevel('B');
ok(/（1 条）/.test(suggestText()), '★ 门槛 B 下 c1 的赛季（B 级）又回来了');
setLevel('D');
eq(chosenOption(levelSel()), 'D', '切回 D');
// 收尾：把 c1 取消勾选（后面那一节要验"只勾 c2 时 1 条"）
const levelCb2 = rowById('c1').querySelector('.dedup-pending-check');
levelCb2.checked = false;
levelCb2.dispatchEvent({ type: 'change' });

ok(!chipOf('c3'), '⚠️ c3 没有任何依据 ⇒ **连按钮都不画**（不猜）');
ok(/年份（举办）1 条、赛季 1 条/.test(serialize(pane)), '说明里先讲清"各有几条能按推荐补"');

// 点一下 ⇒ 真的走事务写进数据
chip1.click();
await waitFor(() => fieldOf('c1', 'natureSeason') === '2026');
eq(fieldOf('c1', 'natureSeason'), '2026', '★ 点推荐按钮真的把**赛季**写进了节点');
eq(fieldOf('c1', 'natureYear'), '', '★ 而且**没有**顺手把年份也填了（两个字段互不牵连）');
eq(fieldOf('c2', 'natureSeason'), '', '没点的那条一个字没动');

// 一键：勾选若干条 ⇒ 每条按**它自己**的推荐值填
draw('nature');
const rowC2 = rowById('c2');
const cb2 = rowC2.querySelector('.dedup-pending-check');
cb2.checked = true;
cb2.dispatchEvent({ type: 'change' });
const suggestBtn = pane.querySelector('.dedup-pending-suggest-btn');
ok(!!suggestBtn, '填充条上有「按推荐填年份/赛季」');
ok(/按推荐填年份\/赛季（1 条）/.test(String(suggestBtn.textContent)),
    '按钮上写清"选中的里有多少条能推"');
suggestBtn.click();
await waitFor(() => fieldOf('c2', 'natureYear') === '2024');
eq(fieldOf('c2', 'natureYear'), '2024', '★ 一键后 c2 拿到**它自己**那个推荐值（不是 c1 的 2026）');
eq(fieldOf('c1', 'natureSeason'), '2026', 'c1 的赛季值（那一条只推得出赛季）不受影响');

// ===============================================================
group('判重页：③ 顺带显示「已填满」+ 每行三个 nature（可点改）');
// ===============================================================
// 口径："我想在性质待补同时按筛选看到 nature 已填满的节点的信息；未填满的文本现在
// 超链接是蓝色，已填满的就用绿色；所有未填满的放完才轮到已填满，且已填满不计数"
// + "无论是否已填满，在当前判重整理的每个页面的链接左侧显示 3 个 nature，而且可以点击修改"。
const clickConfirm = () => {
    const btn = document.body.querySelectorAll('.modal-overlay')
        .flatMap(o => o.querySelectorAll('.btn'))
        .find(b => b.textContent === '确定');
    ok(!!btn, '弹窗里有「确定」');
    if (btn) btn.dispatchEvent({ type: 'click' });
    return !!btn;
};

seed([
    { parent: 'root', type: 'S', id: 's1', name: '浙江省赛' },
    // ⚠️ `p1` 的分类**停在中间**（`xcpc/icpc` 不是叶子）⇒ 它照样是"待补"（缺分类）
    { parent: 's1', type: 'C', id: 'p1', name: '甲站', natureClass: 'xcpc/icpc' },
    { parent: 's1', type: 'C', id: 'f1', name: '乙站',
      natureClass: 'xcpc/icpc/eu/regional/official', natureYear: '2024', natureSeason: '2024', natureRegion: '成都' },
    { parent: 's1', type: 'C', id: 'f2', name: '丙站',
      natureClass: 'xcpc/ccpc/final/official', natureYear: '2023', natureSeason: '2023', natureRegion: '无' }
]);
draw('nature');

const pendingRows = () => pane.querySelectorAll('.dedup-pending-row');
eq(pendingRows().length, 1, '（前提）默认只画待补那一条');
ok(!/已填满的节点：/.test(serialize(pane)), '默认**不**画「已填满」那一摞');
const toggle = pane.querySelector('.dedup-pending-showfilled-check');
ok(!!toggle, '有「同时显示已填满」开关');
// 观感：整条（复选框 + 文字）套一层**圆角框 + 淡绿底**，免得看漏
const toggleBox = pane.querySelector('.dedup-pending-showfilled');
ok(/border-radius:8px/.test(toggleBox.style.cssText) && /#f0fdf4/.test(toggleBox.style.cssText)
    && /inline-flex/.test(toggleBox.style.cssText),
    '★ 开关外面套了一层圆角、淡绿底的框（且只包住内容）');
eq(toggle.checked, false, '默认关着');
ok(/已填满的节点（2 条；不计入上面的条数）/.test(serialize(pane)),
    '开关上写清有几条、且说明不计入条数');

toggle.checked = true;
toggle.dispatchEvent({ type: 'change' });
const rowsAll = pendingRows();
eq(rowsAll.length, 3, '打开后：1 条待补 + 2 条已填满');
eq(rowsAll.map(r => !!r.querySelector('.dedup-pending-filled-mark')).join(','), 'false,true,true',
    '★ 所有未填满的放完才轮到已填满');
ok(/③ 性质待补：1 条/.test(serialize(pane)), '★ 标题条数仍然只算待补（已填满不计数）');
ok(/已填满的节点：2 \/ 2 条/.test(serialize(pane)), '已填满单独报数（筛选后 / 全部）');
eq(pane.querySelectorAll('.dedup-subtab').find(b => b.dataset.section === 'nature').textContent.includes('（1）'),
    true, '★ tab 上的条数也不含已填满');

const nameOf = r => r.querySelector('.dedup-pending-name');
ok(/1d4ed8/i.test(String(nameOf(rowsAll[0]).style.color)), '未填满的名字是**蓝色**');
ok(/15803d/i.test(String(nameOf(rowsAll[1]).style.color)), '已填满的名字是**绿色**');
eq(rowsAll[1].querySelectorAll('.dedup-pending-check').length, 0, '已填满的行没有勾选框（它不是待补）');
eq(rowsAll[0].querySelectorAll('.dedup-pending-check').length, 1, '待补的行有勾选框');

// 筛选对两摞**用同一套**：把分类筛到 `xcpc/ccpc` ⇒ 待补 0 条、已填满只剩 ccpc 那 1 条
const fsSel2 = fsSel;                       // 复用本文件既有的"按标签找筛选下拉"助手
const clsSel = fsSel2('分类');
// 开了开关 ⇒ 候选取两摞的并集：`xcpc/ccpc` 只存在于"已填满"那一摞里，但也得选得到
ok(clsSel.querySelectorAll('option').map(o => o.value).includes('xcpc/ccpc'),
    '★ 已填满那摞的分类也进筛选候选项（否则这一类根本筛不动）');
clsSel.value = 'xcpc/ccpc';
clsSel.dispatchEvent({ type: 'change' });
eq(pendingRows().length, 1, '★ 筛到 xcpc/ccpc ⇒ 待补那一条被筛掉，只剩已填满的丙站');
ok(!!pendingRows()[0].querySelector('.dedup-pending-filled-mark'), '剩下的正是「已填满」那条');
ok(/已填满的节点：1 \/ 2 条/.test(serialize(pane)), '已填满那一摞也按同一套筛选缩了');

// ---- ★ 待补 0 条时，③ **仍然得能进去改**（症状："性质待补为 0 时改不了，模块被隐藏了"）----
// 机理：这一块若在 `!items.length` 时 `return box` ⇒ 「同时显示已填满的」开关永远画不出来
// ⇒ 数据全填满之后，那上千条"已填满"的节点**没有任何入口**能看到 / 点开编辑。
// 修法 = 空状态那句话照说，但**开关（以及打开后的筛选行）必须画**。
seed([
    { parent: 'root', type: 'S', id: 's1', name: '浙江省赛' },
    { parent: 's1', type: 'C', id: 'q1', name: '甲站',
      natureClass: 'xcpc/icpc/ec/regional/official', natureYear: '2024', natureSeason: '2024', natureRegion: '成都' },
    { parent: 's1', type: 'C', id: 'q2', name: '乙站',
      natureClass: 'xcpc/ccpc/final/official', natureYear: '2023', natureSeason: '2023', natureRegion: '无' }
]);
draw('nature');
// ⚠️ `pendingState` 是**跨夹具保留**的（活在页面上）：上一组可能把分类筛到 `qoj/无归类` 之类。
//    先开开关让筛选行画出来、点一下「清空筛选」，再关掉开关来测"默认也该画开关"。
const ensureToggle = (on) => {
    const t = pane.querySelector('.dedup-pending-showfilled-check');
    if (t && t.checked !== on) {
        t.checked = on;
        t.dispatchEvent({ type: 'change' });
    }
    return t;
};
ensureToggle(true);
const clrTg = pendingBtn('清空筛选');
if (clrTg) clrTg.click();
ensureToggle(false);
ok(/没有待补的/.test(serialize(pendingBox())), '待补 0 条 ⇒ 空状态那句话还在');
eq(pendingRows().length, 0, '（前提）一条待补都没有');
const tgEmpty = pane.querySelector('.dedup-pending-showfilled-check');
ok(!!tgEmpty, '★ 待补 0 条时「同时显示已填满」开关**照样画出来**（它是唯一入口）');
ok(!pane.querySelector('.dedup-pending-filter'), '开关关着时先不画筛选行（不白占版面）');
ensureToggle(true);
ok(!!pane.querySelector('.dedup-pending-filter'), '★ 打开开关后**筛选行也在**（上千条得能按分类/年份/地区缩）');
const filledRows = pane.querySelectorAll('.dedup-pending-row');
eq(filledRows.length, 2, '已填满那两条列出来了');
ok(!!filledRows[0].querySelector('.dedup-pending-filled-mark'), '列的正是「已填满」那一摞');
// 「能改」才是这一条的终点：点一个小标签要能打开编辑弹窗
filledRows[0].querySelectorAll('.dedup-nature-chip')[1].click();
ok(!!document.getElementById('field-natureYear'),
    '★ 点 nature 小标签能打开编辑弹窗（**待补 0 条也改得了**）');
const closeBtn = document.body.querySelectorAll('.modal-overlay')
    .flatMap(o => o.querySelectorAll('.btn'))
    .find(b => /取消|关闭/.test(String(b.textContent)));
if (closeBtn) closeBtn.dispatchEvent({ type: 'click' });
ok(!document.getElementById('field-natureYear'), '（收尾）弹窗关掉了，不留到下一组');

// ---- 每行四个 nature（分类/年份/赛季/地区），且在「🔗 链接」**左边** ----
seed([
    { parent: 'root', type: 'S', id: 's1', name: '浙江省赛' },
    { parent: 's1', type: 'C', id: 'p1', name: '甲站', natureClass: 'xcpc/icpc/eu/regional/official',
      values: { link: [{ v: 'https://qoj.ac/contest/1', src: 's1', at: '', linkKind: 'problems' }] } }
]);
draw('nature');
// 这几项状态是**跨夹具保留**的（`pendingState` 活在页面上）：先清筛选、关掉「已填满」开关，
// 让下面只看"待补那一行"，别让上一组的条件漏进来。
const clrBtn = pendingBtn('清空筛选');
if (clrBtn) clrBtn.click();
const tgReset = pane.querySelector('.dedup-pending-showfilled-check');
if (tgReset && tgReset.checked) {
    tgReset.checked = false;
    tgReset.dispatchEvent({ type: 'change' });
}
const row0 = pendingRows()[0];
const chips = row0.querySelectorAll('.dedup-nature-chip');
eq(chips.length, 4, '每行四个 nature（分类/年份/赛季/地区）');
eq(chips.map(c => c.dataset.field).join(','),
    'natureClass,natureYear,natureSeason,natureRegion', '顺序 = 分类/年份/赛季/地区');
const kids = [...row0.children];
const chipWrap = kids.find(c => String(c.className).includes('dedup-nature-chips'));
const linkWrap = kids.find(c => String(c.className).includes('dedup-links'));
ok(!!chipWrap && !!linkWrap && kids.indexOf(chipWrap) < kids.indexOf(linkWrap),
    '★ 几个 nature 排在「🔗 链接」左边');
eq(chips[1].textContent, '年份:—', '没标的字段显示成 `—`（"没标"本身就是要看的信息）');
eq(chips[2].textContent, '赛季:—', '赛季那一格同样写 `—`');

// 点一个 ⇒ 打开**编辑弹窗那一套**（四个字段的控件都在），改完走事务写进去
chips[1].click();
const natYearInput = document.getElementById('field-natureYear');
ok(!!natYearInput, '★ 点 nature ⇒ 弹出编辑弹窗（#field-natureYear 在）');
ok(!!document.getElementById('field-natureClass') && !!document.getElementById('field-natureRegion')
    && !!document.getElementById('field-natureSeason'),
    '分类 / 赛季 / 地区的控件也在（同一份 `natureFieldDescriptors`）');
natYearInput.value = '2019';
clickConfirm();
await waitFor(() => fieldOf('p1', 'natureYear') === '2019');
eq(fieldOf('p1', 'natureYear'), '2019', '★ 弹窗里改的年份真的写进节点（走 execute 事务）');
eq(fieldOf('p1', 'natureClass'), 'xcpc/icpc/eu/regional/official', '没动过的分类原样保留');

draw('nature');
ok(/年份:2019/.test(serialize(pendingRows()[0])), '重画后小标签显示新值');
ok(/缺：赛季、地区/.test(serialize(pendingRows()[0])), '填了年份 ⇒ 还缺赛季与地区');

// ---- ① / ② 的每一行也有这几个（"每个页面"都要）----
seed([
    { parent: 'root', type: 'S', id: 's1', name: 'XCPC' },
    { parent: 's1', type: 'C', id: 'sx', name: '甲站（合成）', synthKey: 'synth:k7' },
    { parent: 's1', type: 'C', id: 'm1', name: '甲站', extKey: 'xcpc:c:jia',
      ownerSynth: 'synth:k7', natureClass: 'xcpc/icpc', natureYear: '2024' },
    { parent: 's1', type: 'C', id: 'd2', name: '乙站' },
    { parent: 's1', type: 'C', id: 'd3', name: '乙站' }
]);
draw('synth');
eq(pane.querySelectorAll('.dedup-member .dedup-nature-chip').length, 4, '① 成员行有四个 nature');
draw('dupes');
ok(pane.querySelectorAll('.dedup-cand .dedup-nature-chip').length >= 4, '② 候选卡里的节点也有四个 nature');

// ===============================================================
group('判重页：③ 分类**只有到 Trie 叶子才算填好**（停在中途的照样是待补）');
// ===============================================================
// 口径："nature 的分类字段，只有在 Trie 树的叶子节点时才被视为填好"
// + "到某位的『无归类』也算叶子"。
seed([
    { parent: 'root', type: 'S', id: 's1', name: '浙江省赛' },
    // 年份/地区都填了，但分类停在 `xcpc/icpc`（不是叶子）⇒ **仍是待补**（缺分类）
    { parent: 's1', type: 'C', id: 'stuck', name: '卡在中途', natureClass: 'xcpc/icpc',
      natureYear: '2024', natureSeason: '2024', natureRegion: '成都' },
    // 到叶子的（`无归类` / `ccpc/final`）⇒ 已填满
    { parent: 's1', type: 'C', id: 'done1', name: '到叶子了', natureClass: 'qoj/无归类',
      natureYear: '2024', natureSeason: '2024', natureRegion: '无' },
    { parent: 's1', type: 'C', id: 'done2', name: '也到叶子了', natureClass: 'xcpc/ccpc/final/official',
      natureYear: '2023', natureSeason: '2023', natureRegion: '无' }
]);
draw('nature');

const stuckRow = rowOf('卡在中途');
ok(!!stuckRow, '分类停在 `xcpc/icpc` 的比赛**仍然在待补列表里**');
eq(missOf(stuckRow), '缺：分类', '★ 行尾写「缺：分类」（年份/地区都填了）');
ok(/（分类还停在 xcpc\/icpc，没到叶子）/.test(serialize(stuckRow)),
    '★ 并且把原因说出来（否则"分类明明有值却说缺分类"看着像 bug）');
ok(!/已填满/.test(serialize(stuckRow)), '它不算已填满');
ok(/③ 性质待补：1 条/.test(pendingHtml()), '只有它一条待补');

// 已填满那一摞：到叶子的两条都在（`无归类` 也算叶子 —— 口径明确过）
const tg2 = pane.querySelector('.dedup-pending-showfilled-check');
tg2.checked = true;
tg2.dispatchEvent({ type: 'change' });
eq(pendingRows().length, 3, '打开开关：1 条待补 + 2 条已填满');
eq(pendingRows().filter(r => r.querySelector('.dedup-pending-filled-mark')).length, 2,
    '★ 「到叶子」的两条算已填满（`qoj/无归类` 与 `xcpc/ccpc/final`）');

// 填充条的分类下拉：没到叶子的路径**标出来**（避免"选了却还挂着"的困惑）
const optLabel = (value) => {
    const o = classSel().querySelectorAll('option').find(x => String(x.value) === value);
    return o ? String(o.textContent) : '';
};
eq(optLabel('cf/contest/div2'), 'cf / contest / div2', '叶子不额外标');
ok(/（还没到叶子）/.test(optLabel('xcpc/icpc')), '★ 停在中途的路径在填充条里标「（还没到叶子）」');
ok(/（还没到叶子）/.test(optLabel('xcpc')), '（根也一样标）');

// ---- 小标签的三种颜色：绿 = 填好（分类到叶子）、**蓝 = 有值但没到叶子**、灰 = 空 ----
// 口径："分类:xcpc 的按钮（填了但不够细的）改蓝"
const chipIn = (row, field) => row.querySelectorAll('.dedup-nature-chip')
    .find(c => c.dataset.field === field);
const stuckChip = chipIn(stuckRow, 'natureClass');
eq(stuckChip.dataset.state, 'partial', '★ 分类停在半路 ⇒ 状态是 `partial`');
ok(/#eff6ff/i.test(stuckChip.style.cssText) && /#1d4ed8/i.test(stuckChip.style.cssText),
    '★ 而且画成**蓝色**（淡蓝底 + 深蓝字），不是"填好了"的绿');
ok(/没到叶子/.test(stuckChip.title), 'title 里说清为什么它不算填好');
const doneChip = chipIn(pendingRows().find(r => /到叶子了/.test(serialize(r))), 'natureClass');
eq(doneChip.dataset.state, 'on', '到叶子的分类 ⇒ `on`（绿）');
ok(/#f0fdf4/i.test(doneChip.style.cssText), '绿色底（与蓝色区分开）');
const yearChip = chipIn(stuckRow, 'natureYear');
eq(yearChip.dataset.state, 'on', '年份非空 ⇒ `on`（年份/地区不看叶子，只看有没有值）');
ok(chipIn(stuckRow, 'natureRegion').dataset.state === 'on', '地区非空 ⇒ `on`');

// ---- 分类筛选：**只存在于"已填满"那摞里的分类**也要选得动（症状：
//      "只有已填满节点的分类，筛选有选项但点不动"）----
seed([
    { parent: 'root', type: 'S', id: 's1', name: '混装' },
    { parent: 's1', type: 'C', id: 'p_x', name: '待补的', natureClass: 'xcpc/icpc',
      natureYear: '2024', natureSeason: '2024', natureRegion: '无' },
    { parent: 's1', type: 'C', id: 'f_q', name: '已填满的', natureClass: 'qoj/无归类',
      natureYear: '2024', natureSeason: '2024', natureRegion: '无' }
]);
draw('nature');
// 上一组把"同时显示已填满"开着（`pendingState` 跨夹具保留）⇒ 先关掉，再从"默认只看待补"开始
const tgReset2 = pane.querySelector('.dedup-pending-showfilled-check');
if (tgReset2 && tgReset2.checked) {
    tgReset2.checked = false;
    tgReset2.dispatchEvent({ type: 'change' });
}
eq(pane.querySelectorAll('.dedup-pending-row').length, 1, '（前提）默认只看得到待补那条');
const tg3 = pane.querySelector('.dedup-pending-showfilled-check');
tg3.checked = true;
tg3.dispatchEvent({ type: 'change' });
eq(pane.querySelectorAll('.dedup-pending-row').length, 2, '打开开关：两条都在');
ok(mainChips().map(c => c.dataset.main).includes('qoj'),
    '★ 只存在于已填满那摞的族也有 chip（否则下面的守卫会把选择打回去）');
ok(/qoj（0）/.test(String(mainChip('qoj').textContent)), 'chip 上的数字只数待补（这里是 0）');
const clsSel3 = fsSel('分类');
ok(clsSel3.querySelectorAll('option').map(o => o.value).includes('qoj/无归类'), '下拉里有这一项');
clsSel3.value = 'qoj/无归类';
clsSel3.dispatchEvent({ type: 'change' });
eq(chosenOption(fsSel('分类')), 'qoj/无归类', '★ 选了就**停住**（不再被打回「全部」）');
eq(pane.querySelectorAll('.dedup-pending-row').length, 1, '★ 而且真的筛出那一条（已填满的）');
ok(!!pane.querySelector('.dedup-pending-filled-mark'), '剩下的正是"已填满"那条');
pendingBtn('清空筛选').click();
const tg4 = pane.querySelector('.dedup-pending-showfilled-check');
if (tg4 && tg4.checked) { tg4.checked = false; tg4.dispatchEvent({ type: 'change' }); }

// ===============================================================
group('判重页：没名字的比赛**不显示节点 id**（"比赛 · n_475880_… 没名字"）');
// ===============================================================
// 没名字时不退回显示**节点 id**（`n_<计数器>_<base36>`，看着像乱码），而是如实写「（没名字）」，
// 标识就在后面括号里（够定位）。
seed([
    { parent: 'root', type: 'S', id: 's1', name: 'aux-rankland' },
    { parent: 's1', type: 'C', id: 'n_475880_munqybk3', name: '',
      extKey: 'aux-rankland:c:icpc2017ecfinal', natureClass: 'xcpc/icpc/ec/regional/official' }
]);
draw('nature');
const nameless = serialize(pane);
ok(/（没名字）/.test(nameless), '★ 没名字的 C 显示「（没名字）」');
ok(!/n_475880_munqybk3/.test(nameless), '★ 不再把节点 id 当名字显示（那是应用内部标识）');
ok(/aux-rankland:c:icpc2017ecfinal/.test(nameless), '标识照旧写在括号里（定位用）');

// ===============================================================
group('判重页：⑤ 冲突（**应用实时算**：年份警报 / 算不出键 / 该换键）');
// ===============================================================
// 口径："警报要有 UI" ⇒ 选 **(b) 应用实时算** + **单开一栏 ⑤ 冲突**。
// 判据与产包侧 `scripts/synth-bind.mjs` **共用同一份**（`core/synthPlan.js` + `core/natureConfidence.js`），
// 所以这里钉两件事：① 口径一致（高可信才算警报）；② **随树状态实时变**（改完值立刻消失）。
seed([
    { parent: 'root', type: 'S', id: 's1', name: 'XCPC' },
    // 一组：两个成员都拿**开赛时间**（A 级）报年份、却不一样 ⇒ **警报**
    { parent: 's1', type: 'C', id: 'g1', name: '2020 IC银川', synthKey: 'synth:xcpc:2020ec_regional-银川',
      natureClass: 'xcpc/icpc/ec/regional/official', natureSeason: '2020', natureYear: '2020', natureRegion: '银川' },
    { parent: 's1', type: 'C', id: 'm1', name: '银川站', extKey: 'aux-a:c:1',
      ownerSynth: 'synth:xcpc:2020ec_regional-银川', natureClass: 'xcpc/icpc/ec/regional/official',
      natureSeason: '2020', natureYear: '2020', natureRegion: '银川',
      '分类依据': { natureYear: 'xcpcio:year-time' } },
    { parent: 's1', type: 'C', id: 'm2', name: '银川站', extKey: 'aux-b:c:1',
      ownerSynth: 'synth:xcpc:2020ec_regional-银川', natureClass: 'xcpc/icpc/ec/regional/official',
      natureSeason: '2020', natureYear: '2021', natureRegion: '银川',
      '分类依据': { natureYear: 'xcpcio:year-time' } },
    // 算不出键：省赛那支**缺类型** ⇒ 分类停在 **`未归类`**（蓝 = 填写不完全、等人补 ← 这才是欠账）
    { parent: 's1', type: 'C', id: 'n1', name: '某某杯', extKey: 'qoj:c:9',
      natureClass: 'qoj/xcpc/provincial&invitational/未归类', natureSeason: '2025', natureRegion: '浙江' },
    // ★ 灰值**不算欠账**：`上游异常` 与 `…/无归类` 是**结论**
    //   （"这一格判不了" / "判过了、没有它可归的一项"）⇒ 不进"算不出、留给人"这份待办。
    //   真例 `qoj:c:2624`（那一页 403、名字都拿不到）属于这种：把它算欠账就是冒进。
    { parent: 's1', type: 'C', id: 'u1', name: '获取数据失败', extKey: 'qoj:c:2624',
      natureClass: 'qoj/xcpc/provincial&invitational/上游异常', natureSeason: '不确定', natureRegion: '河北' },
    // 该换键：绑着脚本格式的键、但按现在的分类该是另一个（`icpc-ec` → `ccpc`）
    { parent: 's1', type: 'C', id: 'd1', name: '某场', extKey: 'qoj:c:8',
      ownerSynth: 'synth:xcpc:2025ec_regional-成都', natureClass: 'xcpc/ccpc/regional/official',
      natureSeason: '2025', natureRegion: '成都' }
]);
draw('summary');
ok(showTab('conflict'), '⑤ 那一栏在');
const confHtml = () => serialize(pane.querySelector('.dedup-conflict'));
ok(/⑤ 冲突 \/ 待办：要人动的 3 处/.test(confHtml()), '★ 数字 = 年份警报 1 + 算不出 1 + 该换键 1');
ok(/年份冲突 1 处/.test(confHtml()), '年份冲突列出来了');
ok(/2020 ← .*aux-a:c:1/.test(confHtml()) && /2021 ← .*aux-b:c:1/.test(confHtml()),
    '★ 两边的值 + 各自是哪些节点，都列出来');
ok(/算不出合成键 1 条/.test(confHtml()) && /缺类型/.test(confHtml()),
    '★ 算不出键**连原因一起**说（不能只说"没归入"）');
// ★ 题目绑定那一段**总是渲染**（哪怕异常为 0）—— 漏 import 时渲染会抛异常
//   ⇒ ⑤ 整栏看起来空白，像"没数据"一样。这条钉住"它至少渲染到这一步"。
ok(/题目绑定（P 随 C）/.test(confHtml()),
    '★ 题目绑定那一段总在（漏 import / 渲染抛异常会让整栏空白，不是"没数据"）');
// 症状：④ 那行会把 `**多出来的那条没绑**`／`**3**` 当字面量漏到界面上。
// ⑤ 整段都是 `textContent` ⇒ 标记（`**`／反引号）必须在渲染前统一去掉（`conflictSection.plain`）。
ok(!/\*\*/.test(confHtml()) && !/`/.test(confHtml()),
    '★ ⑤ 渲染文本里没有 `**` 与反引号（漏出来就是这段文案没走去标记）');
ok(!/qoj:c:2624/.test(confHtml()),
    '★ **灰值（`上游异常` / `…/无归类`）不算"算不出"** —— 那是结论、不是等人补的欠账（蓝的 `未归类` 才进）');
ok(/该换键 1 条/.test(confHtml()) && /synth:xcpc:2025cc_regional-成都/.test(confHtml()),
    '★ 该换键把"现在指着谁 / 应该是谁"都写出来');

// ===============================================================
// ★ 「整组无题名」：**照旧提示，但可以直接绑**
// ===============================================================
// 若全组都没题名 ⇒ 脚本 `continue`（不建组），⑤ 里只列成员、给不出任何键，
//   人在界面上**想绑也没地方绑**（死胡同）。现在的做法：照样建组、照样绑，名字用兜底名
//   `题号（题名缺失）`，⑤ 里当作**提示**（不算「待判」），并且那条要能点、能「✓ 确认这一场」。
// ⚠️ 它**换掉整棵树**（`seed`）⇒ 定义成函数、放在上面那段"实时性"断言**之后**再调，
//    否则 `AppState.nodes.m2` 会被换掉（这条断言就会红）。
function checkNoNameBinding() {
    seed([
        { parent: 'root', type: 'S', id: 's9', name: 'XCPC' },
        { parent: 's9', type: 'C', id: 'g9', name: '某场邀请赛', synthKey: 'synth:xcpc:2024demo-东北',
          natureClass: 'xcpc/provincial&invitational/无/邀请赛/official', natureSeason: '2024', natureRegion: '东北' },
        { parent: 's9', type: 'C', id: 'n9a', name: '东北邀请赛（rankland）', extKey: 'aux-rankland:c:x:p',
          ownerSynth: 'synth:xcpc:2024demo-东北', natureClass: 'xcpc/provincial&invitational/无/邀请赛/official',
          natureSeason: '2024', natureRegion: '东北' },
        { parent: 's9', type: 'C', id: 'n9b', name: '东北邀请赛（另一来源）', extKey: 'aux-rankland:c:y:p',
          ownerSynth: 'synth:xcpc:2024demo-东北', natureClass: 'xcpc/provincial&invitational/无/邀请赛/official',
          natureSeason: '2024', natureRegion: '东北' },
        // P **合成节点**（组头）—— 导入包之后树上才有它（点「题号」跳的就是它）。
        // ⚠️ 也给它 `problemId`：不带题号的 P 会进 ③「没有题号」，把这组夹具的异常数搅乱。
        { parent: 'g9', type: 'P', id: 'sp9', synthKey: 'synth:problem:2024demo-东北-A', problemId: 'A' },
        // ⚠️ 两条成员 P **都没有题名**（正是这一类），但题号都有
        { parent: 'n9a', type: 'P', id: 'p9a', extKey: 'aux-rankland:c:x:p:A', problemId: 'A' },
        // ★ 再来一条**同一来源、同一题号**的 ⇒ 触发 ④「同一来源多出一条」那一行
        //   （这一行的标记容易漏出来：`**多出来的那条没绑**`／`**3**` 成了字面量）
        { parent: 'n9a', type: 'P', id: 'p9a2', extKey: 'aux-rankland:c:x:p:A2', problemId: 'A' },
        { parent: 'n9b', type: 'P', id: 'p9b', extKey: 'aux-rankland:c:y:p:A', problemId: 'A' }
    ]);
    draw('summary');
    ok(showTab('conflict'), '⑤ 那一栏在（整组无题名这组夹具）');
    const h = confHtml();
    ok(/② 整组都没有题名/.test(h), '★ 照旧提示（这一类仍然列出来）');
    ok(/已经按题号绑上了/.test(h), '★ 而且说清楚**已经绑上了**（不能只说"绑不了" —— 那是死胡同）');
    ok(/synth:problem:2024demo-东北-A/.test(h), '★ 键要写出来（不然人看不到它绑到哪儿去了）');
    ok(/已按题号绑上/.test(h), '★ 这一条也说清"已绑"（不是"建不出组"）');
    ok(/✓ 确认这一场/.test(h), '★ 这条要能确认（确认过的组脚本不再覆盖名字）');
    // 判据：它**不算「待判」**（已经绑好了，只是显示名是兜底名）—— 算进去就是假欠账
    ok(/💬 提示 1 处/.test(h), '★ 整组无题名算「提示」不算「待判」（"照旧提示"）');
    ok(!/待判 1 处/.test(h), '⚠️ 不许把"已绑上、只是没名字"算成待判');
    // 「✓ 确认这一场」这个按钮**真的被渲染出来**了（判据是 `memberIds` —— 少了它按钮就不出现，
    // ⑤ 又变成"只报不能动"）。⚠️ 这里不点它：写标记走的是与 ① 同一个 `runWrite + applyOwnerSynth`，
    // 那一条另有覆盖；这里要钉的是"这一类**有**按钮"。
    const cfBtn = [...pane.querySelectorAll('.btn')].find((b) => b.textContent === '✓ 确认这一场');
    ok(!!cfBtn, '★ ② 那一场的「✓ 确认这一场」按钮真的渲染出来了（`memberIds` 少一个就没有它）');
    ok(/aux-rankland:c:x:p:A/.test(h) && /aux-rankland:c:y:p:A/.test(h),
        '★ 两个成员都列出来（点得进去、核得着）');
    // ★ ④「同一来源多出一条」那一行：**内容要在、标记不许漏**
    ok(/④ 同一来源多出一条/.test(h), '★ ④ 那一行在（这条夹具故意给同一来源塞了两条同题号的）');
    ok(!/\*\*/.test(h) && !/`/.test(h),
        '★ ④（与整段 ⑤）渲染出来**没有 `**`／反引号**（漏出来就会是 `**多出来的那条没绑**）　**3** 处`');
    // ★ "**前面的节点加超链接**" —— 这一行前半段那两处（场次 / 题号）也要能点进去。
    //   判据用 `data-goto`（`markGoto` 的落点；空串 = 没换算到节点 id、点了不会动）。
    const extraRow = pane.querySelector('.dedup-conflict-problems-extra');
    ok(!!extraRow, '★ ④ 那一条渲染出来了');
    const gotos = extraRow ? extraRow.querySelectorAll('.dedup-goto') : [];
    ok(gotos.length >= 3, '★ 前半段两处 + 被踢那条 = 至少 3 个可点节点');
    ok(gotos.every((el) => String(el.dataset.goto || '').length > 0),
        '★ 每个可点处都真的带上了节点 id（`data-goto` 空 = 点了原地不动，等于没加）');
    ok(String((gotos[0] || {}).textContent || '') === '2024demo-东北',
        '★ 第一个可点是**场次**（C 合成节点）');
    ok(String((gotos[1] || {}).textContent || '') === 'A',
        '★ 第二个可点是**题号**（那一个 P 合成节点）');
    ok(String((gotos[2] || {}).textContent || '').includes('aux-rankland:c:x:p:A2'),
        '★ 第三个可点是被踢出去的那条 P 本体');
    // P 合成节点**不在树上**（还没导入包）时：那一处退化成纯文本，**不许**留"点了不动"的假链接
    {
        const keepNodes = AppState.nodes;
        try {
            const noHead = { ...AppState.nodes };
            delete noHead.sp9;
            AppState.nodes = noHead;
            dedupPage.invalidateDedupCache();
            dedupPage.renderDedupPage();
            showTab('conflict');
            const row2 = pane.querySelector('.dedup-conflict-problems-extra');
            const g2 = row2 ? row2.querySelectorAll('.dedup-goto') : [];
            ok(g2.length >= 2 && g2.every((el) => String(el.dataset.goto || '').length > 0),
                '★ 合成节点还不在树上 ⇒ 那处是纯文本（不是空 `data-goto` 的假链接）');
            ok(/2024demo-东北 的 A/.test(serialize(row2)),
                '★ 键名照旧写出来（只是不可点），不然那一行就少了一段信息');
        } finally {
            AppState.nodes = keepNodes;
        }
    }
}

// ★ 实时性：把 m2 的年份改成一致 ⇒ **警报立刻消失**（这是选 (b) 而不是"包带报告"的理由）
const node2 = AppState.nodes.m2;
node2.natureYear = '2020';
node2['分类依据'] = { ...(node2['分类依据'] || {}), natureYear: 'xcpcio:year-time' };
dedupPage.invalidateDedupCache();
dedupPage.renderDedupPage();
showTab('conflict');
// ⚠️ 这里钉的是**计数归零**、不是"那一栏消失"：⑤ 现在**每一栏都在**（0 条也在，灰的、
//    默认折叠）—— "这一栏没有"与"这一栏根本没算"必须分得开（用户 2026-10-06 定的）。
//    钉子照样有牙：重算没跟上就会写成 `年份冲突 1 处`。
ok(/年份冲突 0 处/.test(confHtml()), '★ 改完值 ⇒ 年份警报**当场归零**（那一栏还在，只是 0 处）');
ok(/⑤ 冲突 \/ 待办：要人动的 2 处/.test(confHtml()), '数字跟着降到 2（算不出 + 该换键）');

checkNoNameBinding();      // ★ 见上面那个函数（"整组无题名照旧提示，但可以直接绑"）

// 低可信的差异**不算警报**：只有"C 级（赛名里的年份）确实报了个年份"才记账（`待同步` 不算分歧）
seed([
    { parent: 'root', type: 'S', id: 's1', name: 'XCPC' },
    { parent: 's1', type: 'C', id: 'g2', name: '2019 EC-Final', synthKey: 'synth:xcpc:icpc-ec:2019:EC-Final',
      natureClass: 'xcpc/icpc/ec/final/official', natureSeason: '2019', natureYear: '2019', natureRegion: '上海' },
    { parent: 's1', type: 'C', id: 'k1', name: 'EC-Final', extKey: 'cf:c:1',
      ownerSynth: 'synth:xcpc:icpc-ec:2019:EC-Final', natureClass: 'xcpc/icpc/ec/final/official',
      natureSeason: '2019', natureYear: '2019', natureRegion: '上海',
      '分类依据': { natureYear: 'xcpcio:year-time' } },
    { parent: 's1', type: 'C', id: 'k2', name: 'EC-Final', extKey: 'qoj:c:1',
      ownerSynth: 'synth:xcpc:icpc-ec:2019:EC-Final', natureClass: 'qoj/xcpc/icpc/ec/final/official',
      natureSeason: '2019', natureYear: '2018', natureRegion: '上海',
      '分类依据': { natureYear: 'gym:year-name' } }
]);
draw('summary');
showTab('conflict');
ok(/年份冲突 0 处/.test(confHtml()), '★ C 级（赛名年份，不高）不参与 ⇒ **不算警报**（那一栏计数为 0）');
ok(/低可信的年份差异 1 处/.test(confHtml()), '但列进"低可信差异"（记账）');
ok(/⑤ 冲突 \/ 待办：要人动的 0 处/.test(confHtml()), 'tab 数字 = 0（没有要人动的事）');

// ★ 注册表排除（"引入『有些节点不该算合成键』的逻辑与注册表"；
//   两层白名单叠加；并选了"⑤ 里多一行记账"）——它**只记账**、不进 tab 数字。
//   夹具直接用注册表里那条真规则（`qoj:c:2180` = 2016 平壤区域赛，场地在中国境外）。
{
    seed([
        { parent: 'root', type: 'S', id: 's1', name: 'XCPC' },
        { parent: 's1', type: 'C', id: 'x1', name: 'The 2016 ICPC Asia Pyongyang Regional',
          extKey: 'qoj:c:2180', natureClass: 'qoj/xcpc/icpc/ec/regional/official',
          natureSeason: '2016', natureYear: '2016', natureRegion: '平壤' },
        { parent: 's1', type: 'C', id: 'x2', name: '某场普通区域赛', extKey: 'qoj:c:1',
          natureClass: 'qoj/xcpc/icpc/ec/regional/official',
          natureSeason: '2016', natureYear: '2016', natureRegion: '平壤' }
    ]);
    draw('summary');
    showTab('conflict');
    ok(/注册表排除 1 条/.test(confHtml()), '★ 被注册表点名的那条**单独记一行**');
    ok(/节点白名单：qoj:c:2180/.test(confHtml()), '并写清是哪一层、哪条规则命中的');
    ok(/qoj:c:2180/.test(confHtml()) && !/算不出合成键 2 条/.test(confHtml()),
        '★ 它**不算"算不出"**（是结论，不是欠账）');
    ok(/⑤ 冲突 \/ 待办：要人动的 0 处/.test(confHtml()),
        '★ 它**不进 tab 数字**（只记账，不是要人动的事）');
    const noSynthRow = pane.querySelector('.dedup-conflict-nosynth');
    ok(!!noSynthRow && noSynthRow.querySelectorAll('.dedup-nature-chip').length === 4,
        '★ 这一行同样带 4 个 nature 小标签（点着就能改）');

    // 注册表里点名了、**树里却没有** ⇒ 也要报（写错 extKey / 那场没了都属"不符"）
    seed([
        { parent: 'root', type: 'S', id: 's1', name: 'XCPC' },
        { parent: 's1', type: 'C', id: 'x2', name: '某场普通区域赛', extKey: 'qoj:c:1',
          natureClass: 'qoj/xcpc/icpc/ec/regional/official',
          natureSeason: '2016', natureYear: '2016', natureRegion: '平壤' }
    ]);
    draw('summary');
    showTab('conflict');
    ok(/注册表里点名、但当前树里没有的 1 条/.test(confHtml())
       && /qoj:c:2180/.test(confHtml()), '★ 点名的节点不在树里 ⇒ 明确报出来（不是静默失效）');
    ok(!/\*\*/.test(confHtml()) && !/`/.test(confHtml()),
        '★ ⑤ 整段渲染文本里**没有 `**` 与反引号**（④ 那行不能把 `**多出来的那条没绑**` 漏出来）'
        + ' —— 这一栏全是 `textContent`，标记必须统一去掉（`conflictSection.plain`）');
}

// ===============================================================
// ★ ⑤ 的三档"有内容才画行"（真数据里常年是 0 条 ⇒ 只能在这里钉住"有内容时画得出来"）
// ===============================================================
// 为什么单独钉：这三档的行渲染只在**非空**时才跑（真包上 `unroundedPre` / `orphanP` 都是
// 0 条），曾经有一条把"往行里 append 一个 void 小件"的写法漏过去 ⇒ **一有条目就崩**
// （`appendChild(undefined)`）。这里造出"有内容"的夹具，把三档各钉一条。
{
    seed([
        { parent: 'root', type: 'S', id: 's1', name: 'XCPC' },
        // 组头 + **同一棵树（aux-rankland）给的两条无序号网络赛** ⇒ ⑩
        { parent: 's1', type: 'C', id: 'h1', name: '2026 EC网络赛', synthKey: 'synth:xcpc:2026ec_pre',
          natureClass: 'xcpc/icpc/ec/pre/official', natureSeason: '2026' },
        { parent: 's1', type: 'C', id: 'm1', name: 'EC Online A', extKey: 'aux-rankland:c:a',
          ownerSynth: 'synth:xcpc:2026ec_pre', natureClass: 'xcpc/icpc/ec/pre/official', natureSeason: '2026' },
        { parent: 's1', type: 'C', id: 'm2', name: 'EC Online B', extKey: 'aux-rankland:c:b',
          ownerSynth: 'synth:xcpc:2026ec_pre', natureClass: 'xcpc/icpc/ec/pre/official', natureSeason: '2026' },
        // 两个来源、题号不同但题名相同 ⇒ 题目绑定里"按题名对上"那一档
        { parent: 'm1', type: 'P', id: 'pa', extKey: 'aux-rankland:c:a:p:A', problemId: 'A', name: '电梯' },
        { parent: 'm2', type: 'P', id: 'pb', extKey: 'aux-rankland:c:b:p:B', problemId: 'B', name: '电梯' },
        // 父指向一个不存在的节点 ⇒ ⑪（这条题一条都绑不上，必须报出来）
        { parent: 'm1', type: 'P', id: 'pz', extKey: 'aux-rankland:c:a:p:Z', problemId: 'Z', name: '孤儿题' }
    ]);
    // 把 `pz` 的父**指坏**（挂在根下 / 指到不存在的 id 都算"父链连不上"）
    AppState.parentOf = { ...AppState.parentOf, pz: '没有这个节点' };
    draw('summary');
    showTab('conflict');
    ok(/🌐 无序号网络赛：分不开 1 组/.test(confHtml()),
        '★ ⑩ 有内容时画得出来（同一棵树给了两条无序号网络赛）');
    ok(/aux-rankland 给了 2 条/.test(confHtml()), '★ 并写清是哪个渠道、哪几条');
    ok(/🕳 题找不到它的场次 1 条/.test(confHtml()), '★ ⑪ 有内容时画得出来（父链连不上的题）');
    ok(/🔗 按题名对上 1 处/.test(confHtml()), '★ 题目绑定那一栏的标题带上"按题名对上"的条数');
    ok(/B → A/.test(confHtml()), '★ 按题名对上的那一条写清了 `从哪个题号 → 对到哪个题号`');
    ok(!/\*\*/.test(confHtml()) && !/`/.test(confHtml()),
        '★ 这几档的标题/行同样没有 `**` 与反引号漏出来（它们也是 `textContent`）');
}

report('判重整理页（合成节点）');
