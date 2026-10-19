// ================================================================
// 冒烟测试：副页节点的「详细信息」能选看哪个（scripts/smoke/nodeinfo-target.smoke.mjs）
//
// 副页（虚拟节点）上的 📋 不是直接开节点，而是先弹一个"查看哪个"的选择框 ——
// ① 所映射的主树节点 ② 副页节点本身（页内身份）。
// 交互与主视图那套"选择哪个"是同一个 `createModal`（见 G7_editTarget.js）。
//
// 这组用例走**真实路径**：
//   ① 弹窗里两个目标都在（且顺序/标签对）；
//   ② 选"副页节点本身" → 开出来的是**虚拟节点**的信息界面（`isVirtual`，标题写明）；
//   ③ 它的第一个子视图是「📋 副页节点信息」（列页内身份，不是主节点那张完整字段表），
//      且**不给**「✏️ 编辑」（编辑虚拟节点走插件那条路）；
//   ④ 选"所映射主树节点" → 开主节点的信息界面；
//   ⑤ 引用失效/根节点时，只给"副页节点本身"。
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

// 这组用例**不需要**解析 innerHTML：选择框的内容是用**真元素**构造的（见 G7 里那段注释），
// 副页信息/子 tab 栏则是直接赋 innerHTML、按字符串断言（桩不解析时 `innerHTML` 原样可读）。
const body = installDom();
const app = makeContainer(body, 'app');
for (const id of ['tab-bar', 'tree-container', 'tree-body', 'stats-chart-container',
    'folder-view-tabs', 'tab-main', 'folder-breadcrumb', 'folder-stats', 'toast']) {
    makeContainer(app, id);
}
globalThis.fetch = async () => ({ ok: false, json: async () => ({}) });

const { AppState } = await import(mod('shell/state.js'));
const { createInitialState } = await import(mod('core/model/state.js'));
const { createNode } = await import(mod('core/model/node.js'));
const { showInfoTargetSelector } = await import(mod('ui/G_modal/G7_editTarget.js'));
const { openNodeInfoTab, getNodeInfoTabs } = await import(mod('ui/tabs.js'));
const { renderNodeInfoPanel } = await import(mod('ui/nodeinfo/nodeInfoView.js'));
const { getVirtualDisplayNode } = await import(mod('view/dataAdapter.js'));
const { EVENTS } = await import(mod('A_constants.js'));
// 蓝字/按钮的点击靠**文档级委托**接住（这里显式引入那一份，见 `docs/node-navigation.md` §5.2）
await import(mod('ui/nodeinfo/nodeGroupActions.js'));

const PID = 'p_ref';
const PAGE = 'pg1';
const VROOT = 'v_root';
const VID = 'v_p1';
const AT = '2026-09-21T21:45:03.669Z';

/** 主树一个 P + 一个副页（根 vNode + 一个引用该 P 的 vNode） */
function seed() {
    const base = createInitialState();
    for (const k of Object.keys(base)) AppState[k] = base[k];
    AppState.currentTab = 'main';

    const node = createNode(PID, 'P', { name: 'All Closed', problemId: 'A', extKey: 'xcpc:demo:A' });
    node.ratio = '4.61';
    AppState.nodes[PID] = node;
    AppState.childOrder[PID] = [];
    AppState.childOrder[AppState.rootId].push(PID);
    AppState.parentOf[PID] = AppState.rootId;

    AppState.pages[PAGE] = {
        id: PAGE,
        name: '我的题单',
        rootId: VROOT,
        virtualIndex: {
            [VROOT]: { id: VROOT, type: 'O', children: [VID], refId: null },
            [VID]: { id: VID, type: 'P', refId: PID, children: [], selected: true, expanded: false }
        },
        vNodeStats: { [VID]: { statusComplete1: 1, statusComplete2: 3 } }
    };
    AppState.currentPageId = PAGE;
}

const btnOf = target =>
    body.querySelectorAll('.info-target-btn').find(b => b.dataset && b.dataset.target === target);
const panelKey = id => String(id).replace(/[^a-zA-Z0-9_-]/g, '_');

group('副页节点的「详细信息」：主节点 / 副页节点两个都能看');
{
    seed();

    // ① 两个目标都在
    const picks = [];
    showInfoTargetSelector({ pageId: PAGE, vId: VID, refId: PID, onPick: t => picks.push(t) });
    eq(body.querySelectorAll('.info-target-btn').length, 2, '弹出"查看哪个"，两个目标都给');
    ok(!!btnOf('real'), '有「查看所映射主树节点」');
    ok(!!btnOf('vnode'), '有「查看副页节点本身」');

    // ② 选"副页节点本身" → 虚拟节点的信息界面
    btnOf('vnode').dispatchEvent({ type: 'click' });
    eq(picks[0], 'vnode', '点了「副页节点本身」→ onPick 收到 vnode');
    openNodeInfoTab(VID, { asVirtual: true, pageId: PAGE });
    const vt = getNodeInfoTabs().find(t => t.nodeId === VID);
    ok(!!vt, '副页节点的信息界面开出来了');
    eq(vt.isVirtual, true, '它标着 isVirtual（不会被当成真实节点）');
    ok(String(vt.label).includes('副页节点'), `标题写明是副页节点（${vt.label}）`);

    // ③ 主体是"它自己"的信息；不给「✏️ 编辑」
    renderNodeInfoPanel(vt);
    const s = panelKey(VID);
    const fields = document.getElementById(`ni-fields-${s}`);
    ok(!!fields, '副页节点信息容器在');
    ok(String(fields.innerHTML).includes('引用主节点'), '列的是它自己的页内身份（含"引用主节点"）');
    ok(String(fields.innerHTML).includes('All Closed'), '引用信息里带上主节点的名字');
    ok(!String(fields.innerHTML).includes('完整字段表（'), '不是主节点那张「完整字段表」');
    const tabsHtml = String(document.getElementById(`ni-tabs-${s}`).innerHTML);
    ok(tabsHtml.includes('副页节点信息'), '子 tab 有「📋 副页节点信息」');
    ok(!tabsHtml.includes('✏️ 编辑'), '副页节点**不给**「✏️ 编辑」（编辑虚拟节点走插件那条路）');

    // ④ 选"所映射主树节点" → 开主节点的信息界面
    showInfoTargetSelector({ pageId: PAGE, vId: VID, refId: PID, onPick: t => picks.push(t) });
    btnOf('real').dispatchEvent({ type: 'click' });
    eq(picks[picks.length - 1], 'real', '点了「所映射主树节点」→ onPick 收到 real');
    openNodeInfoTab(PID);
    ok(getNodeInfoTabs().some(t => t.nodeId === PID && !t.isVirtual),
        '主节点的信息界面照旧能开（且不是虚拟那个）');

    // ⑤ 引用失效 / 根节点：只给"副页节点本身"
    showInfoTargetSelector({ pageId: PAGE, vId: VROOT, refId: '', onPick: () => {} });
    eq(body.querySelectorAll('.info-target-btn').length, 1, '没有主节点可看时，只给「副页节点本身」');
    ok(!!btnOf('vnode'), '（那个按钮仍是"副页节点本身"）');
    document.body.querySelectorAll('.modal-overlay').forEach(el => el.remove());
}

group('副页展示节点带两个身份（📋 的 data-id / data-vid 就靠它）');
{
    const d = getVirtualDisplayNode(AppState, PAGE, VID);
    ok(!!d, 'getVirtualDisplayNode 拿得到展示节点');
    eq(d._virtual, true, '_virtual');
    eq(d._refId, PID, `_refId = ${PID}（主节点那个身份）`);
    eq(d._virtualId, VID, `_virtualId = ${VID}（副页节点那个身份）`);
    eq(d._pageId, PAGE, '_pageId');
    eq(getVirtualDisplayNode(AppState, PAGE, '不存在'), null, '找不到就返回 null');
}

// ===============================================================
group('副页指向**合成节点**（副页成了"看合并结果"的入口）');
// ===============================================================
// 场景：主树上一个合成节点 `sy`（`synthKey` 非空），它有一个成员 `syMember`。
// 副页里放一个 vNode 指向 `sy`（`refId` = sy）—— 这就是"副页指向合成节点"。
{
    const SY = 'sy';
    const MEMBER = 'syMember';
    const VID2 = 'v_sy';
    // ⚠️ 2026-10-18：副页的 `virtualIndex` 会被冻结（`freezeTopLevel` 白名单）⇒ 先换可变副本
    AppState.pages = {
        ...AppState.pages,
        [PAGE]: { ...AppState.pages[PAGE], virtualIndex: { ...AppState.pages[PAGE].virtualIndex } }
    };
    AppState.pages[PAGE].virtualIndex[VROOT].children.push(VID2);
    AppState.pages[PAGE].virtualIndex[VID2] =
        { id: VID2, type: 'P', refId: SY, children: [], selected: false, expanded: false };

    // ⚠️ 2026-10-18：顶层大字典可能被冻结（`freezeTopLevel`）⇒ 造状态前换可变副本
    AppState.childOrder = { ...AppState.childOrder };
    AppState.parentOf = { ...AppState.parentOf };
    const sy = createNode(SY, 'P', { name: 'All Closed（合成）', problemId: '' });
    sy.synthKey = 'synth:g1';                 // ← 身份：它是合成节点
    AppState.nodes[SY] = sy;
    AppState.childOrder[SY] = [MEMBER];
    AppState.parentOf[SY] = AppState.rootId;

    const member = createNode(MEMBER, 'R', { name: '成员提交' });
    member.ownerSynth = 'synth:g1';           // ← 指针：它归入这个合成节点
    AppState.nodes[MEMBER] = member;
    AppState.childOrder[MEMBER] = [];
    AppState.parentOf[MEMBER] = SY;

    // ---- ① 展示节点：合成节点能被当成普通节点渲染 ----
    const d = getVirtualDisplayNode(AppState, PAGE, VID2);
    ok(!!d, '副页指向合成节点时，展示节点拿得到');
    eq(d._refId, SY, '_refId = 那个合成节点');
    eq(d.synthKey, 'synth:g1', '把它的合成标识带过来了（界面据此认出它是合成节点）');
    eq(d.name, 'All Closed（合成）', '标题来自合成节点');

    // ---- ② 成员引用**不算子节点** ----
    const { getChildNodes } = await import(`file://${path.join(SRC, 'view/helpers.js').replace(/\\/g, '/')}`);
    eq(d.children.length, 0, '展示节点的 children 里**没有**成员引用');
    eq(getChildNodes(AppState, d).length, 0, 'getChildNodes 也不把成员当子节点');
    eq(AppState.childOrder[SY].length, 1, '（对照）成员只挂在它**实际所在的树上位置**');
    eq(getChildNodes(AppState, sy).map(c => c.id).join(','), MEMBER,
        '真实树上它是普通子节点 —— 指针归入与树结构是两件事');

    // ---- ③ 「查看哪个节点？」把合成节点也当目标，并写出它是合成节点 ----
    const picks = [];
    showInfoTargetSelector({ pageId: PAGE, vId: VID2, refId: SY, onPick: t => picks.push(t) });
    eq(body.querySelectorAll('.info-target-btn').length, 2, '两个目标都给');
    ok(!!btnOf('real'), '有指向它的那一个目标');
    ok(/合成节点/.test(btnOf('real').textContent), `目标按钮写明是合成节点（${btnOf('real').textContent}）`);
    const hintEl = body.querySelectorAll('.info-target-box')[0].querySelector('p');
    ok(/合成节点/.test(hintEl ? hintEl.textContent : ''), '提示语也如实说明这是合成节点');
    btnOf('real').dispatchEvent({ type: 'click' });
    eq(picks[picks.length - 1], 'real', '点了它 → onPick 收到 real（由调用方开**真实节点**的信息界面）');

    // ---- ④ 打开来确实是那个合成节点 ----
    openNodeInfoTab(SY);
    const tab = getNodeInfoTabs().find(t => t.nodeId === SY);
    ok(!!tab, '合成节点的信息界面开得出来');
    eq(!!tab.isVirtual, false, '它是**真实节点**（不是副页虚拟节点）');
    renderNodeInfoPanel(tab);
    const s = panelKey(SY);
    ok(!!document.getElementById(`ni-fields-${s}`), '面板画出来了');
    const boxEl = document.getElementById(`tab-${tab.id}`).querySelector('.nodeinfo-nodebox');
    ok(/All Closed（合成）/.test(serialize(boxEl)), '顶部节点框里看到的就是这个合成节点');

    // ---- ⑤ 副页指向合成节点时，面板标题如实写明（别像个普通原料） ----
    openNodeInfoTab(VID2, { asVirtual: true, pageId: PAGE });
    const vTab = getNodeInfoTabs().find(t => t.nodeId === VID2);
    ok(!!vTab && vTab.isVirtual, '副页那一项也开得出来');
    ok(/合成节点/.test(String(vTab.label)), `标题写明是合成节点（${vTab.label}）`);

    document.body.querySelectorAll('.modal-overlay').forEach(el => el.remove());
}

// ===============================================================
group('★ 详页头部那串 id：解析不出主树节点时**不许画成可点**');
// ===============================================================
// 蓝色 = 链接 ⇒ 蓝了就必须真能点。副页**根节点**（`v_root`，`refId` 为空）不引用任何真实节点，
// `core/ops/page.js:mainTreeNodeIdOf` 给空串 ⇒ 那一格必须**保持灰的纯文本**
//（画成可点就是"点了没反应的假链接"，比纯文本更糟 —— `ui/kit/report.js:nodeOrText` 的文件头）。
// 正向那一半（能解析 ⇒ 蓝 + `data-reveal-node`）在 `ui-wiring.smoke.mjs` 里（真实节点 `cA`）。
{
    openNodeInfoTab(VROOT, { asVirtual: true, pageId: PAGE });
    const t = getNodeInfoTabs().find(x => x.nodeId === VROOT);
    ok(!!t, '副页**根节点**的信息界面也开得出来（这组的前提）');
    renderNodeInfoPanel(t);
    const idTag = document.getElementById(`tab-${t.id}`).querySelector('.nodeinfo-node-id');
    ok(!!idTag, '头部那串 id 那一格还在');
    eq(serialize(idTag), VROOT, '照旧显示那串 id 本身');
    ok(!idTag.querySelector('.nodeinfo-node-id-link'), '★ 解析不出 ⇒ **没有**链接元素（不留假链接）');
    ok(!idTag.querySelector('[data-reveal-node]'), '★ 整格里一个 `data-reveal-node` 都不许有');
}

// ===============================================================
group('★ 副页节点的蓝字：跳**页内位置**（不是它引用的主节点）');
// ===============================================================
// 病根 / 需求（用户 2026-10-13）：副页节点详页头部**已经**有一颗
// 「🔎 跳到它引用的主节点」—— 蓝字再跳主节点就是"同一件事两个入口"。
// ⇒ 副页（`_virtual`）那一格改成**页内 id**（点它就定位到该副页内的对应位置），
//   那颗按钮**一个字不动**（那是"跳主树"的入口）。
// 判据（两条会红）：
//   · 蓝字承载 = **页内 id**（`data-reveal-node="v_p1"`），点一下派发 `REVEAL_NODE{v_p1}`；
//   · 按钮承载 = **它引用的主节点 id**（`data-reveal-node="p_ref"`），点一下派发 `REVEAL_NODE{p_ref}`。
//   ⚠️ 反着抄（蓝字指真实节点 = `v9.0.16` 的行为）⇒ 第一条当场红。
{
    openNodeInfoTab(VID, { asVirtual: true, pageId: PAGE });
    const t = getNodeInfoTabs().find(x => x.nodeId === VID);
    ok(!!t && t.isVirtual, '副页节点（不是根）的信息界面开出来了');
    renderNodeInfoPanel(t);

    const pane = document.getElementById(`tab-${t.id}`);
    const idTag = pane.querySelector('.nodeinfo-node-id');
    const link = idTag && idTag.querySelector('.nodeinfo-node-id-link');
    ok(!!link, '★ 副页节点那一格仍是蓝的可点链接（观感与主树节点一致）');
    eq(link && link.dataset.revealNode, VID,
        '★ 蓝字承载的是**页内 id**（点它 = 跳到该副页内的对应位置，不是它引用的主节点）');
    eq(serialize(link), VID, '显示的仍是那串页内 id');

    const jumpBtn = pane.querySelector('.nodeinfo-jump');
    ok(!!jumpBtn, '「🔎 跳到它引用的主节点」那颗按钮还在');
    eq(jumpBtn.getAttribute('data-reveal-node'), PID,
        '★ 那颗按钮仍指向**它引用的主节点**（与蓝字各管一件事；`v9.0.16` 的语义一个字没动）');

    // 两条路都走**同一种承载、同一条文档级委托**（没有第二种标记）——
    // 点一下各派发一颗，且带的是各自那个 id。
    const seen = [];
    const onReveal = e => seen.push(e.detail && e.detail.nodeId);
    document.addEventListener(EVENTS.REVEAL_NODE, onReveal);
    link.click();
    eq(seen[seen.length - 1], VID, '点蓝字 ⇒ 派发的是页内 id（页内定位）');
    jumpBtn.click();
    eq(seen[seen.length - 1], PID, '点按钮 ⇒ 派发的是主节点 id（跳主树）');
    eq(seen.length, 2, '两次点击各派发一颗（没有第二种委托、也没有双派发）');
    document.removeEventListener(EVENTS.REVEAL_NODE, onReveal);
}

// ===============================================================
group('★ 副页「📊 题目分布统计」筛出来的题目：三样都要有（🔎 页内 id + 📋 + **页内**面包屑）');
// ===============================================================
// 症状（用户实测）：副页节点详页的「📊 题目分布统计」点柱筛出来的那一批题**没有面包屑、
// 也没有 📋**（主页同一处有）。
// 病根：那一行入口由 `ui/kit/nodeEntry.js:appendNodeEntries` 插在方框后面，它按
// `state.nodes[box.dataset.id]` 查节点；而副页方框的 `data-id` 是**页内 id**（`v_p1`），
// `state.nodes` 里查不到 ⇒ 整条被 `continue` 掉（连 🔎 一起没了）。
// 前提变了：`v9.0.17` 起 `ui/revealNode.js:revealNode` **两种 id 都认** ⇒ 页内 id 可以当 🔎 承载了。
// 现在：页内 id 解析成副页展示节点（`getVirtualDisplayNode`），🔎 给**页内 id**、
// 📋 带树上那颗同样的两个身份（走"看哪个"那一支）、面包屑走**页内**祖先链。
// ⚠️ 明细里的方框是 `innerHTML` 拼的（DOM 桩不解析）⇒ 这里按真实 DOM **手工摆一个**
//    `.node-box[data-id]`（形状照 `view/helpers.js:renderNodeBox`），再走**生产那份**
//    `appendNodeEntries` —— 没有另写一套插法，也**没有**改桩去解析 innerHTML。
{
    seed();
    const VID_ENTRY = 'v_entry';
    // 用一个**这次会话里没开过**的页内 id（`openNodeInfoTab` 的资料是会话级的，
    // 复用 `v_p1` 会让"新开一个"变成"切到已开的那个"，验不出"是谁开的"）
    AppState.pages[PAGE].virtualIndex[VID_ENTRY] =
        { id: VID_ENTRY, type: 'P', refId: PID, parentId: VROOT, children: [], selected: false, expanded: false };
    AppState.pages[PAGE].virtualIndex[VROOT].children.push(VID_ENTRY);

    const { appendNodeEntries, nodeEntryLine } = await import(mod('ui/kit/nodeEntry.js'));
    const { setupEventDelegation } = await import(mod('ui/G_events.js'));
    setupEventDelegation();      // 📋 的**文档级**委托（只装一次，重复调无副作用）

    const host = document.getElementById('stats-chart-container');
    host.innerHTML = '';
    const detail = document.createElement('div');
    detail.className = 'stats-segment-detail';
    const rows = document.createElement('div');
    rows.className = 'stats-segment-rows';
    const wrapper = document.createElement('div');
    wrapper.className = 'node-wrapper';
    const box = document.createElement('div');
    box.className = 'node-box';
    box.setAttribute('data-id', VID_ENTRY);      // ★ 副页方框的 data-id = **页内 id**
    wrapper.appendChild(box);
    rows.appendChild(wrapper);
    detail.appendChild(rows);
    host.appendChild(detail);

    appendNodeEntries(detail, AppState, '.stats-segment-rows');
    const line = detail.querySelector('.node-entry');
    ok(!!line, '★ 副页方框后面插上了入口条（以前页内 id 在 state.nodes 里查不到 ⇒ 整支被跳过）');

    // ---- ① 🔎：承载仍是 data-reveal-node，值是**页内 id** ----
    const go = line && line.querySelector('[data-reveal-node]');
    ok(!!go, '★ 有 🔎（承载仍是那唯一一种 data-reveal-node）');
    eq(go && go.dataset.revealNode, VID_ENTRY, '★ 🔎 的值是**页内 id**（revealNode 按归属分流 ⇒ 页内定位）');
    eq(go && go.title, '跳到它所在那一页里的位置',
        '★ 悬停提示说的是**页内**定位（不是默认那句"在树上定位"——提示与实际行为必须一致）');
    const seen = [];
    const onReveal = e => seen.push(e.detail && e.detail.nodeId);
    document.addEventListener(EVENTS.REVEAL_NODE, onReveal);
    go.click();
    document.removeEventListener(EVENTS.REVEAL_NODE, onReveal);
    eq(seen.join(','), VID_ENTRY, '★ 点一下派发的就是页内 id（没有被解析成它引用的主节点）');

    // ---- ② 📋：与树上那颗**同一套身份** ⇒ 走"看哪个"再开副页节点自己的详页 ----
    const info = line && line.querySelector('.btn-node-info');
    ok(!!info, '★ 有 📋（仍是 btn-node-info，靠文档级委托接住）');
    eq(info && info.dataset.vid, VID_ENTRY, '★ 📋 带页内身份 data-vid');
    eq(info && info.dataset.pageId, PAGE, '★ 📋 带 data-page-id（选择器要知道是哪一页）');
    eq(info && info.dataset.id, PID, '★ 📋 的 data-id 是它引用的**主节点**（"看哪个"里的另一个目标）');
    info.click();
    eq(body.querySelectorAll('.info-target-btn').length, 2, '★ 点它 ⇒ 弹出"看哪个"（复用那一支）');
    btnOf('vnode').dispatchEvent({ type: 'click' });
    const opened = getNodeInfoTabs().find(t => t.nodeId === VID_ENTRY);
    ok(!!opened, '★ 选"副页节点本身" ⇒ 开出了详页');
    eq(!!(opened && opened.isVirtual), true, '★ 开的是**页内节点自己**（openNodeInfoTab 的 asVirtual 那一支）');
    ok(!getNodeInfoTabs().some(t => t.isVirtual && t.nodeId === PID),
        '（对照）没有把页内 id 当成真实节点开成一个空界面');
    document.body.querySelectorAll('.modal-overlay').forEach(el => el.remove());

    // ---- ③ 面包屑：**页内**链（不是主树那条，也不许印「（就在根下）」）----
    const crumb = line && line.querySelector('.node-entry-crumb');
    ok(!!crumb, '★ 有面包屑');
    const crumbHtml = serialize(crumb);
    ok(/vnode-crumb/.test(crumbHtml), '用的是**页内**那一条渲染器（主树那条是 nig-crumb）');
    ok(!/nig-crumb/.test(crumbHtml), '★ 没有混进主树那份 breadcrumbHtml');
    ok(!/（就在根下）/.test(crumbHtml), '★ 不会印「（就在根下）」这种假话');
    ok(crumbHtml.includes(`data-reveal-node="${VROOT}"`), '★ 链的第一段是**页内根**（点它 = 跳到这一页的根）');
    ok(crumbHtml.includes('📄 我的题单'), '带「📄 页名」前缀（知道这是哪一页的链）');

    // ---- ④ 主页面那一处**逐字不变**（这次只加副页那一支，主树节点那条一个字符没动）----
    // ⚠️ `v9.4.15` 起**唯一一处**改过的字是链最后那段：无名根节点以前印「（未命名）」，
    //    现在印「🏠 根目录」（用户："这个面包屑 前两节好像不存在啊"——第二节就是根）。
    //    别的地方（🔎 那句、📋 那句、来源树 `xcpc`、类名、属性、行内样式）**逐字未变**。
    const rootId = AppState.rootId;
    const mainLine = nodeEntryLine(AppState, AppState.nodes[PID]);
    eq(serialize(mainLine),
        '🔎 跳到树上📋 打开详页<div class="nig-crumb" style="font-size:11px;color:#94a3b8;line-height:1.6;word-break:break-all;margin-top:1px;">'
        + '<span>xcpc</span> <span style="color:#cbd5e1;">›</span> '
        + `<span class="nig-crumb" data-reveal-node="${rootId}" style="cursor:pointer;`
        + 'text-decoration:underline dotted;">🏠 根目录</span></div>',
        '★ 主树节点那条入口条**逐字不变**（除"无名根节点"那段的名字，其余一个字没动）');
    eq(mainLine.querySelector('[data-reveal-node]').dataset.revealNode, PID, '主树节点仍给**真实 id**');
    eq(mainLine.querySelector('[data-reveal-node]').title, '在树上定位这个节点',
        '（对照）主树那条的提示仍是默认那句 —— 一个字没动');
    eq(mainLine.querySelector('.btn-node-info').dataset.id, PID, '主树节点的 📋 仍给**真实 id**');
    eq(mainLine.querySelector('.btn-node-info').dataset.vid, undefined,
        '主树节点那颗 📋 **不带** data-vid（不弹"看哪个"）');
    host.innerHTML = '';
}

report('副页详细信息的目标选择');
