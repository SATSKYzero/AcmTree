// ================================================================
// 冒烟测试：手建合成节点（scripts/smoke/add-synth.smoke.mjs）
//
// 支持手建合成节点。
// 这一组走**真实点击路径**（不是只断言"控件画出来了"）：
//   选类型（G2_selector）→ 问一句「标记为合成节点？」→ 填表 → execute 事务落库。
// 为什么必须真点：这一条的价值全在"勾一下数据就对了" —— 只断言按钮在，
// 会漏掉"开关接错了 ops / 勾了却走了常规路径 / 没勾却走了合成"这类错误。
//
// 钉住的东西：
//   ① 勾上 ⇒ 真的建出一个 `synthKey` 非空的节点，且**类型 / 父节点 / 名字**都对；
//   ② 不勾 ⇒ 建出来的节点 `synthKey` 为空（**回归锚：常规流程一字不变**）；
//   ③ 标识：留空 ⇒ 自动分配（`synth:` 前缀）；手填 ⇒ 按手填的落地；
//   ④ 重复标识 ⇒ 被拒（弹窗不关、报错、**不静默改掉用户输入**）；
//   ⑤ 保留前缀 `synth:` 手填 ⇒ 被拒（core 的规矩，界面不另判）；
//   ⑥ W/S/O 的开关**禁用**且写明理由；C 之下选不到 C（父节点子类型约束仍在管）。
//
// ⚠️ 三处桩上的坑（都真实踩过，见 dom.mjs 的注释）：
//   · 必须 `installDom([], { parseHtml: true })`：弹窗内容由 HTML 字符串拼出来，
//     不开解析就查不到 `#add-synth-check`，整条路径点不动；
//   · 复选框的钩子必须读 `.checked`（桩的 `value` 与浏览器一样是 `"on"`）；
//   · 事务要用到 `settings.performance.historySteps` 等，所以造数据必须
//     **整块换掉** AppState（走 `createInitialState()`），不能只塞 nodes。
//
// ⚠️ 还有一条**被测行为**上的坑，本文件刻意绕开：
//   被 core 拒绝时（标识重复 / 保留前缀），新建弹窗**故意不关**（用户还能改），
//   所以那条 promise 不会 settle。碰到这种场景就别 `await` 它 —— 否则整个
//   冒烟文件会挂在那里（表现出来像"卡死"，不是失败）。
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

const body = installDom([], { parseHtml: true });
const app = makeContainer(body, 'app');
for (const id of ['toast', 'tree-body', 'tree-container', 'tab-main']) makeContainer(app, id);
globalThis.fetch = async () => ({ ok: false, json: async () => ({}) });

const { AppState } = await import(mod('shell/state.js'));
const { createInitialState } = await import(mod('core/model/state.js'));
const { createNode } = await import(mod('core/model/node.js'));
const { TYPE_CHILDREN_MAP } = await import(mod('core/model/constants.js'));
const { promptAddChild } = await import(mod('ui/G_modal/G4_add.js'));

const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));
const nextLoop = async () => { await tick(); await tick(); };

/**
 * 造一棵树并整块换掉 AppState（事务要用到 settings / accounts / pages / meta）。
 *
 * ⚠️ 夹具节点必须走 `createNode`：**类型默认值是按类型发的**
 *    （`synthKey` / `ownerSynth` 只长在 C/P/R 上，S/W 根本没有这两个键）。
 *    拿根节点摊开当模板会得到一个"s 节点也有 synthKey"的假数据 —— 断言会失真。
 */
function seed(list) {
    const base = createInitialState();
    const rootId = base.rootId;
    const nodes = { ...base.nodes };
    const childOrder = { ...base.childOrder };
    const parentOf = { ...base.parentOf };
    for (const item of list) {
        const { type, id, ...extra } = item;
        const parent = item.parent === 'root' ? rootId : item.parent;
        nodes[id] = { ...createNode(id, type, extra), ...extra, id, type };
        parentOf[id] = parent;
        if (!childOrder[parent]) childOrder[parent] = [];
        childOrder[parent].push(id);
        if (!childOrder[id]) childOrder[id] = [];
    }
    for (const k of Object.keys(base)) AppState[k] = base[k];
    AppState.nodes = nodes;
    AppState.childOrder = childOrder;
    AppState.parentOf = parentOf;
    AppState.rootId = rootId;
    AppState.currentTab = 'main';
    AppState.currentPageId = 'main';
}

/** 当前所有打开着的弹窗（最后一个 = 最上面那个） */
const overlays = () => body.querySelectorAll('.modal-overlay');
const topOverlay = () => { const o = overlays(); return o[o.length - 1] || null; };
/** 在最上面的弹窗里按文字找一个按钮 */
const findBtn = (label) => {
    const o = topOverlay();
    return o ? (o.querySelectorAll('.btn').find(b => b.textContent === label) || null) : null;
};
const clickByLabel = (label) => { const b = findBtn(label); if (b) { b.click(); return true; } return false; };
/** 在类型选择器里点某个类型 */
const clickType = (type) => {
    const b = (topOverlay() || body).querySelectorAll('.type-btn').find(x => x.dataset.type === type);
    if (b) b.click();
    return !!b;
};
/** 表单弹窗里的控件（桩的 registry 是全局的） */
const elById = id => document.getElementById(id);
/** 往一个输入框里"敲字"（值 + input 事件 —— 与真人输入同一信号） */
const typeInto = (id, value) => {
    const el = elById(id);
    if (!el) return false;
    el.value = value;
    el.dispatchEvent({ type: 'input' });
    return true;
};
/** 老路径的 `showPromptDialog`：把 #prompt-input 填上再点确定 */
const fillPrompt = (value) => typeInto('prompt-input', value) && clickByLabel('确定');
/** 关掉所有还开着的弹窗（收尾用，别漏给下一个 group） */
const closeAll = () => { while (topOverlay()) clickByLabel('取消'); };
/** 等一个条件成立（execute 是异步事务） */
async function waitFor(fn, ms = 3000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (fn()) return true; await tick(); }
    return fn();
}
const synthNodes = () => Object.values(AppState.nodes).filter(n => n && n.synthKey);
const toastMsg = () => { const t = document.getElementById('toast'); return t ? String(t.textContent || '') : ''; };

// ===============================================================
group('手建合成节点：勾上开关 ⇒ 真的建出一个合成节点（类型/父节点/名字都对）');
// ===============================================================
{
    seed([
        { parent: 'root', type: 'W', id: 'w1', name: 'XCPC' },
        { parent: 'w1', type: 'S', id: 's1', name: 'XCPC 2026' },
        { parent: 's1', type: 'C', id: 'c1', name: '2026 浙江省赛', extKey: 'xcpc:c:zj' }
    ]);
    const before = Object.keys(AppState.nodes).length;

    const promise = promptAddChild('s1');
    await nextLoop();
    ok(clickType('C'), '类型选择器里有 C');
    await nextLoop();
    const box = elById('add-synth-check');
    ok(!!box, '问话弹窗里有「标记为合成节点」勾选框');
    ok(/标记为合成节点/.test(serialize(topOverlay())), '勾选框的文字在弹窗里');
    box.checked = true;
    ok(clickByLabel('确定'), '问话弹窗的「确定」点得到');
    await nextLoop();

    ok(!!elById('add-synth-name'), '勾上之后出现「名称（可改）」');
    ok(!!elById('add-synth-key'), '勾上之后出现「合成标识（可改）」（判重页能改的，这里就能填）');
    eq(elById('add-synth-name').value, '合成', '名称默认「合成」');
    eq(elById('add-synth-key').value, '', '标识默认留空 = 自动生成');
    typeInto('add-synth-name', '2026 浙江省赛（合成）');
    typeInto('add-synth-key', 'zj-2026');
    ok(clickByLabel('确定'), '表单的「确定」点得到');

    const result = await promise;
    await waitFor(() => Object.keys(AppState.nodes).length > before);

    eq(result.success, true, '新建成功（没有静默失败）');
    ok(!!result.node, '拿回了新节点');
    eq(result.synthKey, 'zj-2026', '★ 新节点的合成标识 = 手填的那个（用户可改）');
    eq(AppState.nodes[result.node.id].synthKey, 'zj-2026', '★ 落库的节点 synthKey 非空');
    eq(result.node.type, 'C', '类型 = 选的那个（C）');
    eq(AppState.parentOf[result.node.id], 's1', '父节点 = 那个系列（既有流程选的父）');
    eq(result.node.name, '2026 浙江省赛（合成）', '名字 = 用户改过的那个（没有被默认值盖掉）');
    eq(AppState.nodes[result.node.id].ownerSynth, '', '合成节点自己**没有** ownerSynth（它是组头）');
    eq(!result.node.extKey, true,
        '合成节点没有 extKey（S/W 之类的节点本来就没这个字段，C 的默认值也是空）');
    // C 的类型特有字段走既有字段写入口补上（`createSynthNode` 只认 synthKey/name/type）
    eq(result.node.contestTime, '', '比赛时间照旧（没填 ⇒ 空）');
    eq(result.node.link, '', '链接照旧（没填 ⇒ 空）');
    eq(AppState.nodes.c1.synthKey, '', '旁边那个原料没被顺手改成合成节点');
    eq(synthNodes().length, 1, '树上只有这一个合成节点');
}

// ===============================================================
group('手建合成节点：不勾 ⇒ 老流程一字不变（synthKey 为空 = 回归锚）');
// ===============================================================
{
    seed([
        { parent: 'root', type: 'W', id: 'w1', name: 'XCPC' },
        { parent: 'w1', type: 'S', id: 's1', name: 'XCPC 2026' }
    ]);
    const before = Object.keys(AppState.nodes).length;

    const promise = promptAddChild('s1');
    await nextLoop();
    clickType('C');
    await nextLoop();
    const box = elById('add-synth-check');
    eq(!!box, true, '不勾的时候也问一句（默认不勾）');
    eq(!!box.checked, false, '默认没勾上');
    clickByLabel('确定');
    await nextLoop();

    // ★ C 的普通路径：**一个表单**（名称 / 链接 / 比赛时间）——名称不再被问两遍
    ok(!elById('prompt-input'), '★ 不再先弹「请输入比赛名称」prompt（那个名称字段表单里本来就有）');
    ok(!!elById('field-name'), '★ 表单里有名称（`field-name`）');
    ok(!!elById('field-contestTime'), '★ 同一步里也有比赛时间（`field-contestTime`）');
    typeInto('field-name', '不合成的比赛');
    await nextLoop();
    ok(clickByLabel('确定'), '表单的「确定」点得到');

    const result = await promise;
    await waitFor(() => Object.keys(AppState.nodes).length > before);

    eq(result.success, true, '不勾也能建出普通节点（老路径没被挡）');
    eq(result.node.type, 'C', '类型照旧');
    eq(!result.node.synthKey, true, '★ synthKey 为空（普通节点，不是合成节点）');
    eq(result.node.name, '不合成的比赛', '名字取自那个（合并后的）表单里的名称字段');
    eq(synthNodes().length, 0, '没有平白多出一个合成节点');
    eq(!!elById('add-synth-key'), false, '老路径里**没有**合成标识那个输入框');
}

// ===============================================================
group('手建合成节点：标识留空 ⇒ 自动分配（synth: 保留前缀）');
// ===============================================================
{
    seed([
        { parent: 'root', type: 'S', id: 's1', name: 'XCPC 2026' },
        { parent: 's1', type: 'C', id: 'old', name: '老合成', synthKey: 'synth:7' }
    ]);
    const before = Object.keys(AppState.nodes).length;

    const promise = promptAddChild('s1');
    await nextLoop();
    clickType('C');
    await nextLoop();
    elById('add-synth-check').checked = true;
    clickByLabel('确定');
    await nextLoop();
    typeInto('add-synth-name', '第二个合成');
    // 标识**故意不填** ⇒ 走自动分配
    clickByLabel('确定');

    const result = await promise;
    await waitFor(() => Object.keys(AppState.nodes).length > before);

    eq(result.success, true, '留空也能建（自动分配）');
    eq(result.node.name, '第二个合成', '名字 = 用户填的');
    ok(/^synth:\d+$/.test(result.synthKey), `自动标识形如 synth:N（实际 ${result.synthKey}）`);
    ok(result.synthKey !== 'synth:7', '避开了已被占用的合成标识');
    eq(AppState.nodes[result.node.id].synthKey, result.synthKey, '落库一致');
}

// ===============================================================
group('手建合成节点：重复标识 ⇒ 被拒（弹窗不关，用户输入一个字都不改）');
// ===============================================================
{
    seed([
        { parent: 'root', type: 'S', id: 's1', name: 'XCPC 2026' },
        { parent: 's1', type: 'C', id: 'sxA', name: '合成 A', synthKey: 'taken-key' }
    ]);
    const before = Object.keys(AppState.nodes).length;
    const nodesBefore = JSON.stringify(AppState.nodes);

    // ⚠️ 这条 promise 在被拒时**不会 settle**（弹窗故意不关）——所以不 await 它，
    //    只把它接住以免 unhandled rejection 噪声。
    const pending = promptAddChild('s1');
    pending.catch(() => {});
    await nextLoop();
    clickType('C');
    await nextLoop();
    elById('add-synth-check').checked = true;
    clickByLabel('确定');
    await nextLoop();
    typeInto('add-synth-name', '撞车的合成');
    typeInto('add-synth-key', 'taken-key');
    clickByLabel('确定');

    await waitFor(() => /已被占用/.test(toastMsg()));
    ok(/已被占用/.test(toastMsg()), `弹窗报出「已被占用」（实际：「${toastMsg()}」）`);
    eq(!!topOverlay(), true, '★ 弹窗**没关**（用户还能改回一个可用的标识）');
    eq(elById('add-synth-key').value, 'taken-key',
        '★ 用户敲进去的标识**一个字都没被改掉**（不静默换成自动标识）');
    eq(Object.keys(AppState.nodes).length, before, '没有建出节点（这次操作被拒）');
    ok(JSON.stringify(AppState.nodes) === nodesBefore, '数据逐字节不变（真正的"什么都没发生"）');

    // 就地改成可用的标识 ⇒ 这一次能过（用户不必重开弹窗）
    typeInto('add-synth-key', 'free-key');
    clickByLabel('确定');
    const result = await pending;
    await waitFor(() => Object.keys(AppState.nodes).length > before);
    eq(result.success, true, '改成没被占用的标识后成功');
    eq(result.synthKey, 'free-key', '落库的是改过之后那个标识');
    eq(!!elById('add-synth-key'), false, '成功之后弹窗关了');
}

// ===============================================================
group('手建合成节点：保留前缀 synth: 手填 ⇒ 被拒（core 的规矩，界面不另判）');
// ===============================================================
{
    seed([
        { parent: 'root', type: 'S', id: 's1', name: 'XCPC 2026' }
    ]);
    const before = Object.keys(AppState.nodes).length;
    const nodesBefore = JSON.stringify(AppState.nodes);

    const pending = promptAddChild('s1');
    pending.catch(() => {});
    await nextLoop();
    clickType('C');
    await nextLoop();
    elById('add-synth-check').checked = true;
    clickByLabel('确定');
    await nextLoop();
    typeInto('add-synth-name', '保留前缀');
    typeInto('add-synth-key', 'synth:99');
    clickByLabel('确定');

    await waitFor(() => /保留前缀/.test(toastMsg()));
    ok(/保留前缀/.test(toastMsg()), `报出「保留前缀」（实际：「${toastMsg()}」）`);
    eq(!!topOverlay(), true, '弹窗不关（用户能改成别的标识）');
    eq(elById('add-synth-key').value, 'synth:99', '用户输入没被改掉');
    eq(Object.keys(AppState.nodes).length, before, '★ 没有建出节点');
    eq(synthNodes().length, 0, '树上仍然没有合成节点');
    ok(JSON.stringify(AppState.nodes) === nodesBefore, '数据逐字节不变');
    closeAll();
    eq(!!topOverlay(), false, '收尾：弹窗关干净了');
}

// ===============================================================
group('手建合成节点：W/S/O ⇒ 开关禁用 + 写明理由（不是静默失败）');
// ===============================================================
{
    seed([
        { parent: 'root', type: 'W', id: 'w1', name: 'XCPC' },
        { parent: 'w1', type: 'S', id: 's1', name: 'XCPC 2026' }
    ]);
    const before = Object.keys(AppState.nodes).length;

    const promise = promptAddChild('w1');
    await nextLoop();
    ok(clickType('S'), 'W 之下有 S 可选');
    await nextLoop();

    // ⚠️ 别用 `serialize()` 找 `disabled`：桩的序列化只吐 `_html` 与文本，
    //    **不吐属性**（那条断言恒假，是假覆盖）。禁没禁用要看**元素的属性**。
    const box = elById('add-synth-check');
    eq(!!box, true, '勾选框在');
    eq(!!box.disabled, true, '★ S 的「标记为合成节点」勾选框是 disabled（点不动）');
    const askHtml = serialize(topOverlay());
    ok(/W \/ S \/ O 不参与合成/.test(askHtml), '★ 界面上写明了理由（不是让人猜为什么点不动）');

    // 就算硬把 checked 置真，也会落回老路径（allowSynth=false 兜底）
    box.checked = true;
    clickByLabel('确定');
    await nextLoop();

    // ★ 名称与链接**已合并成一个表单**（`v9.3.5` 用户："填名字与链接可以合并为一步"）
    ok(!elById('prompt-input'), '★ 不再先弹一个名称 prompt（已并进表单）');
    ok(!!elById('field-name'), '★ 表单里有名称（`field-name`）');
    ok(!!elById('field-link'), '★ 同一步里也有链接（`field-link`）');
    typeInto('field-name', '不该是合成');
    await nextLoop();
    ok(clickByLabel('确定'), '表单的「确定」点得到');
    const result = await promise;
    await waitFor(() => result.node && AppState.nodes[result.node.id]);

    eq(result.success, true, 'S 照旧建得出来');
    eq(result.node.type, 'S', '类型 = S（平台/系列）');
    eq(!result.node.synthKey, true, '★ synthKey 为空 —— 没有静默变成合成节点');
    eq(synthNodes().length, 0, '树上没有合成节点');
    eq(Object.keys(AppState.nodes).length, before + 1, '只多了那一个 S');
}

// ===============================================================
group('手建合成节点：父节点的子类型约束仍在管（C 之下选不到 C）');
// ===============================================================
{
    seed([
        { parent: 'root', type: 'S', id: 's1', name: 'XCPC 2026' },
        { parent: 's1', type: 'C', id: 'c1', name: '2026 浙江省赛' }
    ]);
    const promise = promptAddChild('c1');
    await nextLoop();
    const typeBtns = (topOverlay() || body).querySelectorAll('.type-btn');
    eq(typeBtns.map(b => b.dataset.type).join(','), 'P', 'C 之下只给 P（TYPE_CHILDREN_MAP 没被放宽）');
    ok(TYPE_CHILDREN_MAP.C.includes('P'), '（口径）C → P 就是 TYPE_CHILDREN_MAP 里写的');
    typeBtns[0].click();
    await nextLoop();
    elById('add-synth-check').checked = true;
    clickByLabel('确定');
    await nextLoop();

    typeInto('add-synth-name', '合成的题');
    clickByLabel('确定');
    const result = await promise;
    await waitFor(() => result.node && AppState.nodes[result.node.id]);

    eq(result.success, true, 'P 合成节点建得出来');
    eq(result.node.type, 'P', '类型 = P（父节点 C 允许的那一种）');
    eq(AppState.parentOf[result.node.id], 'c1', '挂在那个比赛下');
    ok(!!AppState.nodes[result.node.id].problemId, '题号按老规则给了默认值（与既有路径同款）');
    ok(/^synth:/.test(result.synthKey), `标识自动分配（实际 ${result.synthKey}）`);
    ok(/合成/.test(result.node.name), `名字用的是用户填的那个（实际「${result.node.name}」）`);
}

// ===============================================================
group('手建合成节点：类型特有字段与合成节点在同一个事务里落地（C 的比赛时间）');
// ===============================================================
{
    seed([
        { parent: 'root', type: 'S', id: 's1', name: 'XCPC 2026' }
    ]);
    const promise = promptAddChild('s1');
    await nextLoop();
    clickType('C');
    await nextLoop();
    elById('add-synth-check').checked = true;
    clickByLabel('确定');
    await nextLoop();
    typeInto('add-synth-name', '带时间的合成');
    typeInto('add-synth-key', 'k-time');
    typeInto('field-contestTime', '202605011000');
    clickByLabel('确定');
    const result = await promise;

    eq(result.success, true, '建成功');
    eq(result.node.contestTime, '2026.05.01 10:00', '比赛时间按老规则归一化后落库');
    eq(result.node.synthKey, 'k-time', '合成标识也在同一次事务里落地');
    eq(AppState.parentOf[result.node.id], 's1', '父节点是那个系列');
}

// ===============================================================
group('手建合成节点：「标记为合成节点」那一步按取消 ⇒ 什么都不建');
// ===============================================================
{
    seed([
        { parent: 'root', type: 'S', id: 's1', name: 'XCPC 2026' }
    ]);
    const before = Object.keys(AppState.nodes).length;
    const nodesBefore = JSON.stringify(AppState.nodes);
    const promise = promptAddChild('s1');
    await nextLoop();
    clickType('C');
    await nextLoop();
    clickByLabel('取消');
    const result = await promise;
    eq(result.success, false, '取消 ⇒ success=false');
    eq(result.error, '用户取消', '报的就是「用户取消」（与老路径同义）');
    eq(Object.keys(AppState.nodes).length, before, '一个节点都没建');
    ok(JSON.stringify(AppState.nodes) === nodesBefore, '数据逐字节不变');
    eq(!!topOverlay(), false, '弹窗都关了');
}

report('手建合成节点');
