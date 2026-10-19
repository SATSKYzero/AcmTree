// ================================================================
// 组计数基准（scripts/group-count-bench.mjs）
//
// 量什么：`core/query/groupCount.js` 在 2k / 5k / 20k 节点上的**全子树**计数与聚合耗时
//         （两种模式：plain 不去重 / dedup 去重），并报模式差与内存粗测。
// 目标：20k 档 **< 50ms**（模块头部的复杂度承诺：O(n log n)）。
//
// 怎么跑（纯 Node；模块本身不依赖 immer，所以**不需要** smoke 的 loader 桩）：
//   node scripts/group-count-bench.mjs
//
// ⚠️ 它**不进** `npm test` / `npm run test:smoke` 的自动列表 —— 它是诊断工具，不是断言。
//
// 合成树的口径：
//   · 约 30% 节点是**合成节点**（`synthKey = synth:s<i>`），类型从 C/P/R 里取；
//   · 每个合成节点配 1~3 个**同类型**成员原料；
//   · 其中约 10% 的成员**跨父**（放在另一个顶层容器下 ⇒ 成员与合成头分散在不同子树）；
//   · 其余节点是无指针的原料（单元素组）。
// ================================================================
import { groupCount, makeOrAgg, makeStatus2Agg, MODE_PLAIN, MODE_DEDUP } from '../src/core/query/groupCount.js';

// ⚠️ 这里必须是**字段键** `ownerSynth`，不是界面文案「所属合成节点」——
//    写中文标签的话 `groupCount` 的默认取值器读不到任何指针，所有组退化成单元素组，
//    dedup 的数字会等于 plain，基准就没有意义了。
const OWNER = 'ownerSynth';
const TYPES = ['C', 'P', 'R'];

/** 确定性伪随机（LCG，便于复现） */
function rng(seed) {
    let s = seed;
    return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
}

function buildTree(n, { synthRatio = 0.3, crossRatio = 0.1 } = {}) {
    const nodes = {};
    const parentOf = {};
    const childOrder = {};
    const rnd = rng(20260929 + n);

    const add = (id, type, parent) => {
        nodes[id] = { id, type, status1: rnd() < 0.3 ? 1 : 0, status2: Math.floor(rnd() * 6) };
        childOrder[id] = [];
        parentOf[id] = parent;
        if (parent) childOrder[parent].push(id);
    };

    // 顶层：root + 20 个容器（W），跨父成员就放到"另一个容器"下
    const TOP = 20;
    add('root', 'O', null);
    const containers = [];
    for (let i = 0; i < TOP; i++) {
        const id = `w${i}`;
        add(id, 'W', 'root');
        containers.push(id);
    }

    // 先定合成节点与成员（成员 1~3 个），剩下的名额给普通原料 ⇒ 总数**正好 n**
    const synthCount = Math.max(1, Math.floor(n * synthRatio));
    const members = [];
    for (let i = 0; i < synthCount; i++) {
        const k = 1 + Math.floor(rnd() * 3);
        for (let m = 0; m < k; m++) members.push({ synth: i, m });
    }
    let rawNeeded = n - 1 - TOP - synthCount - members.length;
    while (rawNeeded < 0) {            // 名额不够就削成员（保证正好 n）
        members.pop();
        rawNeeded = n - 1 - TOP - synthCount - members.length;
    }

    const live = [...containers];
    for (let i = 0; i < synthCount; i++) {
        const parent = live[Math.floor(rnd() * live.length)];
        const id = `s${i}`;
        add(id, TYPES[i % 3], parent);
        nodes[id].synthKey = `synth:s${i}`;
        live.push(id);
    }
    let seq = 0;
    for (let i = 0; i < rawNeeded; i++) {
        const parent = live[Math.floor(rnd() * live.length)];
        const id = `n${seq++}`;
        add(id, TYPES[seq % 3], parent);
        live.push(id);
    }
    for (const mm of members) {
        const cross = rnd() < crossRatio;
        const parent = cross
            ? containers[Math.floor(rnd() * containers.length)]      // 跨父：放到别的顶层容器下
            : (parentOf[`s${mm.synth}`] || 'root');
        const id = `m${mm.synth}_${mm.m}`;
        add(id, nodes[`s${mm.synth}`].type, parent);                // 类型必须与合成头相同
        nodes[id][OWNER] = `synth:s${mm.synth}`;
    }

    return { nodes, parentOf, childOrder };
}

function bench(n, agg, mode, reps = 5) {
    const tree = buildTree(n);
    const args = { nodes: tree.nodes, parentOf: tree.parentOf, childOrder: tree.childOrder, mode, agg };
    const times = [];
    let last = null;
    for (let i = 0; i < reps; i++) {
        if (globalThis.gc) globalThis.gc();      // 有 --expose-gc 就每次前先收一次，抖动小很多
        const t0 = process.hrtime.bigint();
        last = groupCount(args);
        times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    const sorted = times.slice().sort((x, y) => x - y);
    return {
        ms: sorted[Math.floor(sorted.length / 2)],   // 中位
        min: sorted[0],                              // 最好一次（噪声下限）
        nodes: Object.keys(tree.nodes).length,
        result: last
    };
}

const SIZES = [2000, 5000, 20000];
const orAgg = makeOrAgg(node => node.status1);
const s2Agg = makeStatus2Agg(node => node.status2);

console.log('组计数基准（中位 ms；每档 5 次，每档列同时给出"最快一次"以看噪声下限）');
console.log('| 规模 | 节点数 | plain 不去重 | dedup 去重 | OR 聚合(plain) | status2 聚合(dedup) |');
console.log('|---|---|---|---|---|---|');
const rows = [];
for (const n of SIZES) {
    const heap0 = process.memoryUsage().heapUsed;
    const plain = bench(n, null, MODE_PLAIN);
    const dedup = bench(n, null, MODE_DEDUP);
    const orAggPlain = bench(n, orAgg, MODE_PLAIN);
    const s2AggDedup = bench(n, s2Agg, MODE_DEDUP);
    const heap1 = process.memoryUsage().heapUsed;
    rows.push({ n, nodes: dedup.nodes, plain, dedup, orAggPlain, s2AggDedup, heapMB: (heap1 - heap0) / 1048576 });
    const f = (r) => `${r.ms.toFixed(1)} (${r.min.toFixed(1)})`;
    console.log(`| ${n} | ${dedup.nodes} | ${f(plain)} | ${f(dedup)} `
        + `| ${f(orAggPlain)} | ${f(s2AggDedup)} |`);
}

const big = rows[rows.length - 1];
console.log('');
console.log(`20k 档：plain ${big.plain.ms.toFixed(1)}/${big.plain.min.toFixed(1)}ms，`
    + `dedup ${big.dedup.ms.toFixed(1)}/${big.dedup.min.toFixed(1)}ms（中位/最快，目标 <50ms）`);
console.log('  ⚠️ 这台机器抖动很大（同一份代码跨进程能差 ±40%）：判读请以"最快一次"为准，'
    + '想要更稳的曲线用 `node --expose-gc scripts/group-count-bench.mjs`。');
console.log(`模式差（整棵树）：plain ${big.plain.result.groupCount} vs dedup ${big.dedup.result.groupCount}`
    + ` ⇒ 差 ${big.plain.result.groupCount - big.dedup.result.groupCount}`);
console.log(`20k 档堆增量（粗略，含造树）：${big.heapMB.toFixed(1)} MB`);
console.log(`告警数（20k）：${big.dedup.result.warnings.length}（应为 0 —— 合成树是合法数据）`);
