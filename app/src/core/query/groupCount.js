// ================================================================
// 组计数（core/query/groupCount.js）—— **纯算法模块**，不 import 任何 UI / immer 依赖
//
// 为什么要有它：
//   判重模型是"**原料节点指向合成节点**"：
//     · 原料节点：身份 `extKey`，可有指针字段 `ownerSynth`（界面「所属合成节点」；
//       值 = 某合成节点的 `synthKey`）
//     · 合成节点：身份 `synthKey`（保留前缀 `synth:`），**没有** `extKey`/指针字段
//     · **成员关系是列表，不是父子**；类型相同的节点才能互为映射/被映射；
//       禁止 W/S 做合成（R/P/C 允许）
//     · **组（group）** = 合成节点 + 它的全部成员原料；无所指的原料自己就是一组（单元素组）
//
//   于是"统计"的单位是**组**，两种模式：
//     · `plain`（不去重）：统计**所有原料节点** + **"本次子树内没有任何成员"的合成节点**
//       （只要有任一成员在该子树内，该合成节点就**不计** —— 否则与成员重复）
//     · `dedup`（去重）：同一组在该子树内多次出现**只算一次**，**组的状态以合成节点为准**
//   去重是 **scope-local**（子树范围内），不是全局。
//
// ⚠️ **不能挂在"子节点加法"递推上**：不同组不可加（同一个组会在多个子树里各出现一次），
//    所以这里换成经典解法 —— **欧拉序 + 一次扫描**（"子树内不同颜色数"那套）：
//      1. 迭代 DFS 拍欧拉序（**必须迭代**：两万节点递归会爆栈）⇒ 每个子树 = 一段连续区间；
//      2. 每组只在它**最近一次出现**的位置贡献一次（旧位置置"单位元"）——
//         ⚠️ 用的是**替换点值**，**不是**减法 ⇒ 或/最值这类**不可逆**的聚合也能算；
//      3. 按子树的右端点离线回答 ⇒ 一次扫描得到**所有子树**的计数与聚合。
//    复杂度：O(n log n)。实现上还做了三件"只影响常数"的事（都有实测依据）：
//      · 内部一律用**数字下标**（节点/组都先映射成 index）—— 字符串键的 Map/Set 是这里
//        最大的常数项；
//      · **计数用树状数组**（0/1 前缀和，无闭包调用），**聚合才用线段树**（点赋值 + 区间合并）；
//      · 子树查询按右端点**挂链**（不排序）。
//    为什么不选"DFS + 启发式合并（小并大）"：那要给**每个节点**常驻一个 Set（两万节点 ×
//    字符串集合，内存与 GC 都重），而这里只要一棵扁平结构；小并大留给以后需要
//    "每组明细列表 / top-k"这类**不止标量**的查询时再说。
//
// ⚠️ 两条硬约束：
//   · "两列值"（节点自己那份 / 组那份）都是**派生缓存**，**绝不写回来源层**
//     —— 这个模块是**只读**的：只读输入、只返回结果，不修改任何输入对象；
//   · 本模块**只管聚合与计数**，不管"把 result 写进哪个字段"（那是调用方的事）。
// ================================================================

export const MODE_PLAIN = 'plain';   // 不去重
export const MODE_DEDUP = 'dedup';   // 去重（以组为单位）

/** 合成节点的保留前缀（与 `extKey` 空间不可能撞；一眼可判） */
export const SYNTH_PREFIX = 'synth:';

// ---- 默认钩子（都可被调用方覆盖） ----

/** 默认：`synthKey` 非空即合成节点 */
const defaultIsSynthesis = n => !!n && !!n.synthKey;

/** 默认合成节点身份：`synthKey` */
const defaultSynthId = n => String((n && n.synthKey) || '');

/**
 * 默认指针字段：`ownerSynth`（界面「所属合成节点」）。
 * ⚠️ 这里**只能读真字段键**：`所属合成节点` 是 UI 标签，节点上永远没有这个键
 *    （读错 ⇒ 所有组退化成单元素组，`dedup` 静默等于 `plain`）。
 */
const defaultOwner = n => String((n && n.ownerSynth) || '');

const defaultTypeOf = n => (n && n.type) || '';

// ================================================================
// 现成的聚合器（**例子**，便利件）：或 / status2（全忽略才算忽略，否则取最大）
// 想让模块算别的字段，自己给 `{ identity, value(node), combine(a,b) }` 即可。
// `combine` 需要**结合律 + 交换律**（或/最值/求和都满足）。
//
// 不给 `agg` ⇒ `groupAgg` 与 `groupCount` **同口径**（只计数，不算字段）。
// ================================================================

/** 或（`status1` 那类）：0/1 */
export function makeOrAgg(valueOf) {
    return {
        identity: 0,
        value: n => (valueOf(n) ? 1 : 0),
        combine: (a, b) => ((a || b) ? 1 : 0)
    };
}

/** status2 里的"忽略"档 */
export const STATUS2_IGNORED = 5;

/**
 * status2 语义：**全为忽略才算忽略，否则取最大**。
 *
 * ⚠️ 两种读法都实现了，**参数默认值是字面**（`preferReal: false`），但
 * **应用里用的是 `preferReal: true`**（"忽略不压过真实档位"）。
 * 所以**调用方必须显式传 `{ preferReal: true }`**，别用默认值。
 *   · 字面：组内出现过非忽略就取 `max`（于是 `[5, 3] → 5`，即"忽略"仍可能是结果）；
 *   · `preferReal: true`：只在**非忽略**的那些里取最大（`[5, 3] → 3`），全忽略才是 5。
 */
export function makeStatus2Agg(valueOf, { ignoreValue = STATUS2_IGNORED, preferReal = false } = {}) {
    return {
        identity: null,
        value: n => {
            const v = valueOf(n);
            return (v === undefined || v === null || v === '') ? null : Number(v);
        },
        combine: (a, b) => {
            if (a === null || a === undefined) return b;
            if (b === null || b === undefined) return a;
            if (preferReal) {
                const ra = a === ignoreValue ? null : a;
                const rb = b === ignoreValue ? null : b;
                if (ra === null && rb === null) return ignoreValue;
                if (ra === null) return rb;
                if (rb === null) return ra;
                return Math.max(ra, rb);
            }
            return Math.max(a, b);
        }
    };
}

// ================================================================
// 两棵结构：树状数组（只数个数）+ 线段树（只合值）
// ================================================================

/** 树状数组：0/1 前缀和（"不同组数"靠它，无闭包调用 ⇒ 常数小） */
class Bit {
    constructor(size) { this.n = size; this.t = new Int32Array(size + 1); }
    add(i, d) { for (let p = i + 1; p <= this.n; p += p & -p) this.t[p] += d; }
    sum(i) { let s = 0; for (let p = i + 1; p > 0; p -= p & -p) s += this.t[p]; return s; }
    range(l, r) { return r < l ? 0 : this.sum(r) - this.sum(l - 1); }
}

/** 线段树：点赋值 + 区间合并（不可逆聚合也支持；`build()` 一次 O(n) 建树） */
class SegTree {
    constructor(size, combine, identity) {
        let n = 1;
        while (n < Math.max(1, size)) n *= 2;
        this.n = n;
        this.combine = combine;
        this.identity = identity;
        this.val = new Array(2 * n).fill(identity);
    }
    /** 叶子全填好后调用一次（O(n)） */
    build() {
        for (let p = this.n - 1; p >= 1; p--) {
            this.val[p] = this.combine(this.val[p << 1], this.val[(p << 1) | 1]);
        }
    }
    set(i, val) {
        let p = i + this.n;
        this.val[p] = val;
        for (p >>= 1; p >= 1; p >>= 1) {
            this.val[p] = this.combine(this.val[p << 1], this.val[(p << 1) | 1]);
        }
    }
    query(l, r) {
        let out = this.identity;
        if (r < l) return out;
        let a = l + this.n, b = r + this.n + 1;
        for (; a < b; a >>= 1, b >>= 1) {
            if (a & 1) { out = this.combine(out, this.val[a]); a++; }
            if (b & 1) { b--; out = this.combine(out, this.val[b]); }
        }
        return out;
    }
}

// ================================================================
// 组收集（导出：判重页以后可以直接复用同一套口径）
// ================================================================
/**
 * 把节点表按"组"整理好。**指针值是合成节点的身份（`synthKey`）**，不是节点表的键 ——
 * 所以先建 `synthKey → 节点` 索引（也容许直接写节点 id，两条都认）。
 *
 * ⚠️ **坏数据不静默**（口径一个字都不改，只是多出 `warnings`）：
 *   · `ownerSynth` 写成**节点 id** ⇒ 报一条（本模块认、别处读不出来 ⇒ 两套口径会分叉）；
 *   · **两个节点共用同一个 `synthKey`** ⇒ 报一条（后出现的那个会被并进同一组、不再单独计数）。
 *   两条都是**顺带 O(1)** 命中的，不重扫全表、不加中间结构。
 *
 * @returns {{ groups: Map<string,{synthId:string, members:string[], type:string}>,
 *             groupOfNode: Map<string,string>, warnings: string[] }}
 */
export function collectGroups({ nodes = {}, isSynthesis = defaultIsSynthesis, synthIdOf = defaultSynthId,
                                ownerOf = defaultOwner, groupOf = null, memberOrder = null,
                                typeOf = defaultTypeOf } = {}) {
    const warnings = [];
    const groups = new Map();
    // ⚠️ 用**下标数组**而不是 `Map<id, 组键>`：真包 27k 节点，`Map.set/get` 各来一遍是这一趟
    //    里最贵的一笔（作者 2026-10-07 指出的方向）。`ids` 与 `groupKeyOf` 按下标一一对应；
    //    真要用 id 查的调用方（`core/query/stats.js` 那几处）走**懒建**的 `groupOfNode`
    //    —— 谁要谁付那份钱，热路径（那一趟）一分不付。
    const ids = Object.keys(nodes);
    const n = ids.length;

    const synthIndex = new Map();          // synthKey → 节点 id
    for (let i = 0; i < n; i++) {
        const node = nodes[ids[i]];
        if (isSynthesis(node)) {
            const id = ids[i];
            const key = synthIdOf(node) || id;
            if (!synthIndex.has(key)) {
                synthIndex.set(key, id);
            } else {
                // 坏数据（只有导入能造出来）：两个节点共用同一个 `synthKey`。
                // **语义不变**（仍取先出现的那个当组头），只是不再静默 ——
                // 后出现的那个会整条被并进同一组、从计数里消失，用户必须能看见。
                // ⚠️ 只是**顺带 O(1)** 的 `has` 命中，不重扫全表。
                const first = synthIndex.get(key);
                warnings.push(`${id}: 合成标识「${key}」**同一个标识出现在多个节点上**`
                    + `（${first} 与 ${id} 共用一个）—— 本模块按**先出现**的 ${first} 建组，`
                    + `节点 ${id} 会被并进同一组、自己不再单独计数；请改掉一个`
                    + '（这是**历史数据**：新的写入会被 ops 直接拒绝，见 core/ops/synth.js）');
            }
        }
    }

    const head = (node) => {
        const id = node.id;
        if (isSynthesis(node)) {
            if (ownerOf(node)) {
                warnings.push(`${id}: 合成节点不允许填「所属合成节点」（已忽略该指针，按它自己那组处理）`);
            }
            return synthIdOf(node) || id;
        }
        const owner = ownerOf(node) || '';
        if (!owner) return id;
        const byKeyHit = synthIndex.has(owner);
        const targetId = byKeyHit ? synthIndex.get(owner) : (nodes[owner] ? owner : '');
        const target = targetId ? nodes[targetId] : null;
        if (!target) {
            warnings.push(`${id}: 「所属合成节点」指向不存在的 ${owner} —— 按**单元素组**处理（悬空指针）`);
            return id;
        }
        if (!isSynthesis(target)) {
            warnings.push(`${id}: 「所属合成节点」指向的不是合成节点（${owner}）—— 按**单元素组**处理`);
            return id;
        }
        if (!byKeyHit) {
            // ⚠️ 坏数据：`ownerSynth` 写的是**节点 id**，不是 `synthKey`。这里"顺手认了"
            //    （见上面 `nodes[owner]` 那一支），但节点 id 不是身份 —— 别处（导入、
            //    成员表）读不出来，两套口径会分叉。**只在确实命中了另一个节点时才报**
            //    （悬空 / 指到原料各有自己的告警，别重复报两遍）。
            warnings.push(`${id}: 「所属合成节点」写的是**节点 id**「${owner}」，不是那个节点的 `
                + `\`synthKey\`「${synthIdOf(target) || owner}」—— 不可靠：只有本模块顺手认了它，`
                + `导入与成员表按标识读，读不出来；请改写成 \`synthKey\``
                + '（这是**历史数据**：新的写入会被 ops 直接拒绝，见 core/ops/synth.js）');
        }
        const t1 = typeOf(node), t2 = typeOf(target);
        if (t1 && t2 && t1 !== t2) {
            warnings.push(`${id}: 与合成节点 ${owner} **类型不同**（${t1} vs ${t2}）—— 仍按同组处理，但请核对`);
        }
        return synthIdOf(target) || owner;
    };

    // ⚠️ 这两件事**合成一趟**（原来各自 `for (const id in nodes)` 扫一遍全表）：
    //    "算每个节点归哪个组" 与 "把节点塞进那个组" 之间**没有依赖** ——
    //    归组只读 loop 1 建好的 `synthIndex` 与 `nodes`，塞组只读这一趟算出来的那个键。
    //    遍历顺序不变 ⇒ `groups` 的插入顺序、`warnings` 的顺序、成员顺序**逐字不变**。
    const groupKeyOf = new Array(n);       // 下标 → 组键（热路径读这个，不建 Map）
    for (let i = 0; i < n; i++) {
        const id = ids[i];
        const node = nodes[id];
        // ★ **快路径**（绝大多数节点走这里）：既没有 `synthKey` 也没有 `ownerSynth` ⇒ 组键就是它自己。
        //   与 `head()` 逐字等价（`isSynthesis` 假 ⇒ `owner = String(node.ownerSynth || '')` = ''
        //   ⇒ `return id`），但省掉每节点 3~4 次闭包调用 + 一次 `String()`。
        let g;
        if (!groupOf && (!node || (!node.synthKey && !node.ownerSynth))) g = id;
        else g = groupOf ? String(groupOf(node)) : head(node);
        groupKeyOf[i] = g;
        let slot = groups.get(g);
        if (!slot) {
            slot = { synthId: '', members: [], type: '' };
            groups.set(g, slot);
        }
        if (isSynthesis(node) && !slot.synthId) {
            slot.synthId = id;
            slot.type = typeOf(node);
        } else if (!isSynthesis(node)) {
            slot.members.push(id);
        }
    }
    if (memberOrder) {
        // ⚠️ `memberOrder` 的**键**容忍两种写法：合成节点的**节点 id** 或它的 **`synthKey`**
        //    （组表的键是 `synthKey`，`slot.synthId` 是节点 id —— 两套都认，免得调用方按
        //    文档传 `synthKey` 却静默不排序：rank 全空 ⇒ 悄悄退回原序，最难查）。
        for (const [key, g] of groups.entries()) {
            const list = memberOrder[key] || memberOrder[g.synthId] || [];
            if (!list.length) continue;
            const rank = new Map();
            list.forEach((id, i) => rank.set(id, i));
            g.members.sort((a, b) => (rank.has(a) ? rank.get(a) : 1e9) - (rank.has(b) ? rank.get(b) : 1e9));
        }
    }
    // 懒建的 `Map<id, 组键>`：**只有真按 id 查的调用方才付**（那一趟走 `ids` + `groupKeyOf`）
    let groupOfNodeMap = null;
    const out = { groups, warnings, ids, groupKeyOf, get groupOfNode() {
        if (!groupOfNodeMap) {
            groupOfNodeMap = new Map();
            for (let i = 0; i < n; i++) groupOfNodeMap.set(ids[i], groupKeyOf[i]);
        }
        return groupOfNodeMap;
    } };
    return out;
}

// ================================================================
// 主函数
// ================================================================
/**
 * @param {Object} input
 * @param {Object} input.nodes         id → node（普通对象；**只读**，不会被改）
 * @param {Object} [input.parentOf]    id → 父 id（根为 null/'' / 不在 nodes 里）
 * @param {Object} [input.childOrder]  id → 子 id 数组（给了它就用它定顺序与前序）
 * @param {'plain'|'dedup'} [input.mode]
 * @param {string} [input.scopeRoot]   只算这棵子树（不传 = 每个节点都算）
 * @param {Object} [input.agg]         `{ identity, value(node), combine(a,b) }`；缺省 = `groupAgg` 与 `groupCount` 同口径
 * @param {Function} [input.isSynthesis] / [input.synthIdOf] / [input.ownerOf] / [input.groupOf] / [input.typeOf] / [input.memberOrder]
 * @returns {{ byNode: Object<string,{groupCount:number, groupAgg:*}>,
 *             groupCount:number, groupAgg:*, warnings:string[], groups:Map }}
 */
/**
 * `collectGroups` 的**共享**记忆化口（键 = `nodes` 引用）。
 *
 * 为什么要有它：真包 27k 实测这一趟 **88~92ms**，而它在同一代里会被**好几处**要
 * （那一趟 `countPass.js`、`core/query/stats.js` 的组索引、判重页…）——
 * 各自留一槽就等于各扫一遍。这里用 `WeakMap` 按 `nodes` 引用共享一份
 * （WeakMap ⇒ **不拖住上一代 `nodes`**）。
 *
 * ⚠️ 边界与 `synthIndexOf` 同一条：它**只吃 `nodes`** ⇒ 引用不变则结果不变；
 *    "就地改 `nodes` 里某个字段再重读"不在契约内（那种写法得显式换引用）。
 */
const groupsMemo = new WeakMap();

export function collectGroupsCached(state) {
    const nodes = (state && state.nodes) || {};
    if (!nodes || typeof nodes !== 'object') return collectGroups({ nodes });
    const hit = groupsMemo.get(nodes);
    if (hit) return hit;
    const made = collectGroups({ nodes });
    groupsMemo.set(nodes, made);
    return made;
}

export function groupCount(input = {}) {
    const {
        nodes = {}, parentOf = {}, childOrder = {}, mode = MODE_PLAIN, scopeRoot = '',
        agg = null, isSynthesis = defaultIsSynthesis, synthIdOf = defaultSynthId,
        ownerOf = defaultOwner, groupOf = null, memberOrder = null, typeOf = defaultTypeOf
    } = input;
    if (mode !== MODE_PLAIN && mode !== MODE_DEDUP) {
        throw new Error(`未知的计数模式 ${mode}（只能是 ${MODE_PLAIN} / ${MODE_DEDUP}）`);
    }
    const useAgg = !!agg;
    const combine = (agg && agg.combine) || ((a, b) => a + b);
    const identity = (agg && 'identity' in agg) ? agg.identity : 0;
    const valueOf = (agg && agg.value) || (() => 1);

    // ---- ① 节点 id → 数字下标（后面全程用下标：字符串键的 Map 是最大常数项）----
    const ids = Object.keys(nodes);
    const n = ids.length;
    const index = new Map();
    for (let i = 0; i < n; i++) index.set(ids[i], i);
    const nodeAt = new Array(n);
    const isSynthArr = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
        const node = nodes[ids[i]];
        nodeAt[i] = node;
        if (isSynthesis(node)) isSynthArr[i] = 1;
    }
    // ---- ② 组：groupOf → 数字下标（组表 + 每组：合成头下标 / 成员下标）----
    const { groups, groupOfNode, warnings } = collectGroups({
        nodes, isSynthesis, synthIdOf, ownerOf, groupOf, memberOrder, typeOf
    });
    const groupIndex = new Map();
    const groupList = [];
    for (const [key, slot] of groups) {
        groupIndex.set(key, groupList.length);
        groupList.push({
            key,
            synthIdx: slot.synthId && index.has(slot.synthId) ? index.get(slot.synthId) : -1,
            members: slot.members.map(id => index.get(id)).filter(v => v !== undefined)
        });
    }
    const gOfNode = new Int32Array(n);
    for (let i = 0; i < n; i++) {
        const g = groupIndex.get(groupOfNode.get(ids[i]));
        gOfNode[i] = g === undefined ? -1 : g;
    }

    // ---- ③ 树：children（CSR）+ 迭代 DFS 前序 + 子树右端点 ----
    const hasOrder = !!childOrder && Object.keys(childOrder).length > 0;
    const parentIdx = new Int32Array(n).fill(-1);
    const childSeen = new Uint8Array(n);
    // 邻接：先数度，再填 CSR（O(n)，不用每节点一个数组）
    const childCount = new Int32Array(n);
    const childTmp = new Array(n);
    for (let i = 0; i < n; i++) childTmp[i] = [];
    const pushChild = (p, c) => { childTmp[p].push(c); childCount[p]++; };
    if (hasOrder) {
        for (const pid in childOrder) {
            const pi = index.get(pid);
            if (pi === undefined) continue;
            for (const cid of childOrder[pid] || []) {
                const ci = index.get(cid);
                if (ci === undefined) continue;
                pushChild(pi, ci);
                childSeen[ci] = 1;
            }
        }
    }
    for (let i = 0; i < n; i++) {
        const p = parentOf ? parentOf[ids[i]] : null;
        const pi = (p === undefined || p === null || p === '' || !nodes[p]) ? -1 : index.get(p);
        parentIdx[i] = pi === undefined ? -1 : pi;
        if (!hasOrder && parentIdx[i] >= 0) pushChild(parentIdx[i], i);
    }
    const pos = new Int32Array(n).fill(-1);
    const tout = new Int32Array(n).fill(-1);
    const order = new Int32Array(n);
    let seenCount = 0;
    const stack = [];
    const rootIdxs = [];
    for (let i = 0; i < n; i++) {
        if (hasOrder ? !childSeen[i] : parentIdx[i] < 0) rootIdxs.push(i);
    }
    for (let r = rootIdxs.length - 1; r >= 0; r--) stack.push(rootIdxs[r]);   // 进"退出"标记用 ~x
    while (stack.length) {
        const top = stack.pop();
        if (top < 0) { tout[~top] = seenCount - 1; continue; }
        if (pos[top] >= 0) continue;                 // 坏数据（环/重复边）也不炸
        pos[top] = seenCount;
        order[seenCount++] = top;
        stack.push(~top);
        const list = childTmp[top];
        for (let i = list.length - 1; i >= 0; i--) if (pos[list[i]] < 0) stack.push(list[i]);
    }
    const reached = seenCount;

    // ---- ④ 每组的值（dedup 用）/ 成员位置（plain 用）—— **按需才算** ----
    const groupValue = useAgg ? new Array(groupList.length).fill(identity) : null;
    if (useAgg && mode === MODE_DEDUP) {
        for (let g = 0; g < groupList.length; g++) {
            const meta = groupList[g];
            let acc = identity;
            if (meta.synthIdx >= 0) acc = combine(acc, valueOf(nodeAt[meta.synthIdx]));
            for (const mi of meta.members) acc = combine(acc, valueOf(nodeAt[mi]));
            groupValue[g] = acc;
        }
    }
    let memberPos = null;
    if (mode === MODE_PLAIN) {
        memberPos = new Array(groupList.length).fill(null);
        for (let g = 0; g < groupList.length; g++) {
            const meta = groupList[g];
            if (!meta.members.length) continue;
            const arr = new Int32Array(meta.members.length);
            for (let k = 0; k < meta.members.length; k++) arr[k] = pos[meta.members[k]];
            arr.sort();
            memberPos[g] = arr;
        }
    }

    // ---- ⑤ 要回答哪些子树 + 按右端点挂链（不排序）----
    const qHead = new Int32Array(n).fill(-1);
    const qNext = [];
    const qIds = [];
    const qL = [];
    const qR = [];
    const targets = [];
    if (scopeRoot && nodes[scopeRoot] && pos[index.get(scopeRoot)] >= 0) {
        const sr = index.get(scopeRoot);
        for (let i = pos[sr]; i <= tout[sr]; i++) targets.push(order[i]);
    } else {
        for (let i = 0; i < reached; i++) targets.push(order[i]);
    }
    for (const v of targets) {
        const qi = qIds.length;
        qIds.push(v); qL.push(pos[v]); qR.push(tout[v]);
        qNext.push(qHead[tout[v]]);
        qHead[tout[v]] = qi;
    }

    const byNode = {};
    const put = (v, count, value) => {
        byNode[ids[v]] = { groupCount: count, groupAgg: useAgg ? value : count };
    };

    if (mode === MODE_DEDUP) {
        // 每组只在其"最近一次出现"的位置贡献一次（旧位置撤掉）⇒ 区间里的个数 = 不同组数
        const bit = new Bit(reached);
        const valTree = useAgg ? new SegTree(reached, combine, identity) : null;
        const lastPos = new Int32Array(groupList.length).fill(-1);
        for (let i = 0; i < reached; i++) {
            const v = order[i];
            const g = gOfNode[v];
            if (g >= 0) {
                const prev = lastPos[g];
                if (prev >= 0) { bit.add(prev, -1); if (valTree) valTree.set(prev, identity); }
                bit.add(i, 1);
                if (valTree) valTree.set(i, groupValue[g]);
                lastPos[g] = i;
            }
            for (let qi = qHead[i]; qi !== -1; qi = qNext[qi]) {
                put(qIds[qi], bit.range(qL[qi], qR[qi]), valTree ? valTree.query(qL[qi], qR[qi]) : identity);
            }
        }
    } else {
        // plain：**所有原料**（前缀和 + 只放原料值的线段树）+ **子树内没有任何成员的合成节点**
        const rawPrefix = new Int32Array(reached + 1);
        const synthPositions = [];
        for (let i = 0; i < reached; i++) {
            const v = order[i];
            const raw = !isSynthArr[v];
            rawPrefix[i + 1] = rawPrefix[i] + (raw ? 1 : 0);
            if (!raw) synthPositions.push(i);
        }
        const synthPos = Int32Array.from(synthPositions);
        // 原料值整轮不变，但调用方**没要聚合**时就整块跳过（count 口径下 groupAgg 就是 groupCount）
        const rawTree = useAgg ? new SegTree(reached, combine, identity) : null;
        if (rawTree) {
            for (let i = 0; i < reached; i++) {
                const v = order[i];
                if (!isSynthArr[v]) rawTree.val[rawTree.n + i] = valueOf(nodeAt[v]);
            }
            rawTree.build();
        }
        const cntIn = (arr, l, r) => {
            if (!arr) return 0;
            let lo = 0, hi = arr.length;
            while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < l) lo = m + 1; else hi = m; }
            const s = lo;
            lo = s; hi = arr.length;
            while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] <= r) lo = m + 1; else hi = m; }
            return lo - s;
        };
        for (let v = 0; v < n; v++) {
            for (let qi = qHead[v]; qi !== -1; qi = qNext[qi]) {   // v 这里其实是右端点
                const l = qL[qi], r = qR[qi];
                let count = rawPrefix[r + 1] - rawPrefix[l];
                let value = useAgg ? rawTree.query(l, r) : identity;
                let lo = 0, hi = synthPos.length;
                while (lo < hi) { const m = (lo + hi) >> 1; if (synthPos[m] < l) lo = m + 1; else hi = m; }
                for (let k = lo; k < synthPos.length && synthPos[k] <= r; k++) {
                    const i = synthPos[k];
                    const g = gOfNode[order[i]];
                    const meta = g >= 0 ? groupList[g] : null;
                    if (!meta || meta.synthIdx !== order[i]) continue;   // 同组只认一个头
                    if (cntIn(memberPos[g], l, r) === 0) {
                        count += 1;
                        if (useAgg) value = combine(value, valueOf(nodeAt[order[i]]));
                    }
                }
                put(qIds[qi], count, value);
            }
        }
    }

    const rootsOfResult = scopeRoot && byNode[scopeRoot] ? scopeRoot : ids[rootIdxs.length ? rootIdxs[0] : 0];
    const whole = rootsOfResult ? byNode[rootsOfResult] : null;
    return {
        byNode,
        groupCount: whole ? whole.groupCount : 0,
        groupAgg: whole ? whole.groupAgg : identity,
        warnings,
        groups
    };
}
