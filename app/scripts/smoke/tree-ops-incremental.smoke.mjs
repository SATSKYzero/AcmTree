// ================================================================
// 结构操作**只重算该算的那部分**
//
// 来由：按操作卡顿时间算，200~400ms 最好 ⇒ 量出来最重的是**新建一道题 ~1250ms**：
//   `core/ops/tree.js` 六处 `fullAutoUpdate(draft)` —— **结构一动就整棵树重算**（真包 26k 节点）。
//
// 依据的不变量（改规则时先读这条）：**一个节点算出来的字段只取决于它自己 + 它的后代**
//   · P：`acTime`/`lastSubmitTime`/`status2` 看自己的 R 子节点；`xcpcDifficulty` 看自己的 `ratio`；
//   · C/W/S：`statusComplete1/2` 是子汇总（自底向上）；
//   · 唯一的插件规则 `testNumSum` 也是"自身 + 直接子"。
// ⇒ 结构一变，会变的只有"那棵子树 + 它的祖先链"。
//
// ⚠️ 为什么放冒烟而不是单测：`core/ops/tree.js` 会牵到 `shell/state.js`（裸包名 `immer`），
//    纯 Node 单测解析不了那个裸名；冒烟运行器带 immer 解析钩子。
//
// 这个文件是**对拍**：每个结构操作做完之后，再整树重算一次，
//   **必须返回 0**（= 增量已经把该改的都改了）—— 同时配"增量确实改了东西"的正向锚，免得断言空转。
// ================================================================
import { installDom } from './dom.mjs';
import { group, ok, eq, report } from './harness.mjs';

installDom();
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} };

const { addChild, deleteNode, copyNode, clearProblems, clearSubmissions } =
    await import('../../src/core/ops/tree.js');
const { fullAutoUpdate } = await import('../../src/core/autoCompute.js');

/** `O → W → S → C → P(r)` 一棵小树（形状够用：容器汇总 / P 看子提交） */
function makeDraft() {
    const d = {
        rootId: 'o', nodes: {}, childOrder: {}, parentOf: {},
        meta: { idCounter: 0 }, currentAccountId: 'local', viewingAccountId: 'local',
        accounts: {}, settings: {}, trust: {}
    };
    const add = (id, type, parentId, extra = {}) => {
        d.nodes[id] = { id, type, lastModified: '', ...extra };
        d.childOrder[id] = [];
        if (parentId === null) { d.rootId = id; d.parentOf[id] = null; return; }
        d.childOrder[parentId].push(id);
        d.parentOf[id] = parentId;
    };
    add('o', 'O', null);
    add('w', 'W', 'o');
    add('s', 'S', 'w');
    add('c', 'C', 's');
    add('p1', 'P', 'c', { ratio: '50', problemId: 'A' });
    add('p2', 'P', 'c', { ratio: '10', problemId: 'B' });
    add('r1', 'R', 'p1', { time: '2026-01-01 10:00', status: 'AC' });
    add('r2', 'R', 'p1', { time: '2026-01-02 10:00', status: 'WA' });
    // ⚠️ 这一步的返回值**必须**是"改了东西"（>0）：下面六条 `converged` 全靠
    //    `fullAutoUpdate` 能返回非 0 来兜底 —— 它要是变成恒 0 的 no-op，六条会一起静默通过。
    const seeded = fullAutoUpdate(d);
    ok(seeded > 0, `（前提）整树初算确实写了东西（changed=${seeded}）—— 否则下面的对拍是空转`);
    return d;
}

/** 对拍：操作做完之后整树重算必须无事可做 */
const converged = (d, what) => eq(fullAutoUpdate(d), 0,
    `${what}：增量重算之后整树再来一遍应当**一处都不用改**（否则就是漏算了）`);

group('结构操作：只重算"变的子树 + 祖先链"（对拍整树重算 == 0）');
{
    // ① 新建一道题
    {
        const d = makeDraft();
        const node = addChild(d, 'c', 'P', '新题', { ratio: '100' });
        ok(d.nodes[node.id], '新节点在树上');
        // 正向锚：新节点**自己的**派生字段被算过了（ratio 100 ⇒ 有难度档；空串/'-' 就是没算）
        const lv = d.nodes[node.id].xcpcDifficulty;
        ok(!!lv && lv !== '-', `（正向锚）新节点自己的派生字段算过了（xcpcDifficulty=${lv}）`);
        converged(d, '新建一道题');
    }
    // ② 新建一条提交
    {
        const d = makeDraft();
        const before = d.nodes.p2.status2;
        addChild(d, 'p2', 'R', '', { time: '2026-02-01 10:00', status: 'AC' });
        ok(d.nodes.p2.status2 !== before, '（正向锚）P 的状态确实变了');
        converged(d, '新建一条提交');
    }
    // ③ 删掉一道题
    {
        const d = makeDraft();
        deleteNode(d, 'p1');
        eq(d.nodes.p1, undefined, '（正向锚）真删掉了');
        eq(d.childOrder.c.includes('p1'), false, '父的子列表里也没了');
        converged(d, '删掉一道题');
    }
    // ④ 复制一道题
    {
        const d = makeDraft();
        const copy = copyNode(d, 'p1', 'c');
        ok(copy && copy.id, '复制出来了');
        converged(d, '复制一道题');
    }
    // ⑤ 清空题目 / ⑥ 清空提交
    {
        const d1 = makeDraft();
        clearProblems(d1, 's');
        converged(d1, '清空题目');

        const d2 = makeDraft();
        clearSubmissions(d2, 'p1');
        ok(d2.nodes.p1.status2 !== undefined, 'P 仍在自己那份里（只是提交没了）');
        converged(d2, '清空提交');
    }
}

// ================================================================
// 宽夹具上的对拍（≈400 节点，不是上面那个 7 节点的小树）
//
// ⚠️ **没做成的事**（别重开）：本来想在这里"数一数这次操作读了几格 `childOrder`"，
//   用"增量应当只读常数格"来钉住"确实没整树重算"。**量了才知道不行**：容器的
//   `computeContainerStatusComplete1/2`（`core/autoComputeRules.js:97/117`）**本来就是整棵子树走一遍**，
//   而任何改动都要顺着祖先链滚到根 ⇒ 根那一趟无论如何都要走整棵树。
//   实测（C 下 200 个 P）：增量 **2428 格** / 整树重算 **3416 格**（整棵树 404 格）——
//   两者同量级，分不开 ⇒ 这种"读几格"的判据**天生不可靠**，别拿它当守卫（阈值只能靠调，会变成假绿/假红）。
//   "没有整树重算"这个性质改由**源码锚**钉住：`src/test/perfGuards.test.js` 的 ⑩
//   （`tree.js` 里不许再出现 `fullAutoUpdate(` 调用）。这里只负责**正确性**：宽夹具上也必须收敛。
// ================================================================
group('结构操作：宽夹具（≈400 节点）上的正确性对拍');
{
    /** 宽夹具：`O→W→S→C` + C 下 `howMany` 个 P（每个 P 再挂一个 R） */
    function makeWideDraft(howMany) {
        const d = {
            rootId: 'o', nodes: {}, childOrder: {}, parentOf: {},
            meta: { idCounter: 0 }, currentAccountId: 'local', viewingAccountId: 'local',
            accounts: {}, settings: {}, trust: {}
        };
        const add = (id, type, parentId, extra = {}) => {
            d.nodes[id] = { id, type, name: id, lastModified: '', values: {}, ...extra };
            d.childOrder[id] = [];
            if (parentId === null) { d.parentOf[id] = null; return id; }
            d.childOrder[parentId].push(id);
            d.parentOf[id] = parentId;
            return id;
        };
        add('o', 'O', null);
        const w = add('w', 'W', 'o');
        const s = add('s', 'S', 'w');
        const c = add('c', 'C', 's');
        for (let i = 0; i < howMany; i++) {
            const p = add('p' + i, 'P', c, { ratio: '50', problemId: 'X' + i });
            add('r' + i, 'R', p, { time: '2026-01-01 10:00', status: 'AC' });
        }
        const seeded = fullAutoUpdate(d);
        ok(seeded > 0, `（前提）宽夹具整树初算确实写了东西（changed=${seeded}）`);
        return d;
    }

    const WIDE = 200;
    {
        const d = makeWideDraft(WIDE);
        const node = addChild(d, 'c', 'P', '新题', { ratio: '100' });
        ok(d.nodes[node.id], '新节点在树上');
        ok(d.nodes.c.statusComplete1 === 0 || d.nodes.c.statusComplete1 === 1,
            '（正向锚）容器的汇总被重算过了（不是 undefined）');
        converged(d, '（宽夹具）新建一道题');
    }
    {
        const d = makeWideDraft(WIDE);
        deleteNode(d, 'p7');
        eq(d.nodes.p7, undefined, '（正向锚）真删掉了');
        converged(d, '（宽夹具）删掉一道题');
    }
    {
        const d = makeWideDraft(WIDE);
        clearSubmissions(d, 'p7');
        ok(d.nodes.p7.status2 !== undefined, '（正向锚）P 的派生档位还在（只是提交没了）');
        converged(d, '（宽夹具）清空提交');
    }
}

report('结构操作（增量重算）');
