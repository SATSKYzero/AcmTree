// ================================================================
// 计数那一趟（core/query/countPass.js）
//
// 一趟**按需驱动**的遍历，同时算出四样东西：
//   · 每个 P / 容器的**本身值**（P：`status1` / `status2` / `acTime` / `lastSubmitTime` /
//     `xcpcDifficulty`；C/W/S：`statusComplete1/2`）
//   · 每个节点的**子树 P 计数**（8 格/单位，见 `model/status.js` 的 `addProblemClass`）
//   · 每个节点的**子树 C 计数**（5 格/单位，`addContestClass`）
//   · 由上面两者直接复原的 P 桶 / C 桶 / 📊分布
//
// 与老路的区别（病根）：老路是"每个节点各走一遍自己的子树"（Σ子树 ≈ 节点数 × 深度），
//   外加一遍派生表后序 + 组头第二趟 + 祖先重算。这一趟改成：
//   · **本身值**：轮到某节点时它的子树已经算完 ⇒ 容器的两格直接由**自己攒的计数**得出，
//     不必向下查（唯一的向下例外是 `P.status2` —— 要看自己的 R 子节点）；
//   · **计数**：每个 P/C 的本身值沿**每一个**祖先加一遍（不是只加到父）⇒ 每个节点自然
//     攒够自己子树的计数；统计值本身不再往上推；
//   · **组头**：组头的"子树"是它的**成员**（指针，不在 `childOrder` 里）⇒ 组事件里按需
//     把那几个成员的子树也走一遍（`subDone` 保证每棵子树至多走一次，因此不再需要
//     `synthLast` 那种"组头排最后"的排序）。
//
// `tim` / `Timc` 就是"组头排除"那条规则的实现：
//   · 一个组一次 `myTimc = ++Timc`（⚠️ **必须快照**：组事件里 `ensureSubtree` 可能**嵌套触发**
//     别的组事件，它们也会 `++Timc`；外层若继续读全局 `Timc` 去比标记，就会撞上别的组留下的
//     标记 ⇒ 提前 break、少算 —— 实测 dedup 的 C 桶就是这么少了 9 个）；
//   · `plain`：先把该组的**原料**推上去（不判 `tim`，一路加、一路置 `tim=myTimc`），
//     再推**组头**、撞到 `tim==myTimc` 就 break —— 撞上的第一个标记点正好是它与成员的 **LCA**
//     ⇒ 等价于老规矩"组头只在子树内没有它的原料时才算一次"；
//   · `dedup`：组值 = `groupAggregateOf`（与"组那份"同一份规则，即那 **3 步**），
//     组内**任意顺序**逐个推、同样撞 `tim` 就 break ⇒ 每个"含该组任一节点"的子树只计一次。
//
// ⚠️ **两套 P 计数**（不是冗余，两个口径确实不同）：
//   · `cntRule`：plain = 原料 + "子树内没有它原料的组头"；dedup = 每组一次（用组值）
//     —— 行上的 `P:` 摘要与 📊分布都用它（用户 2026-10-07 定：📊分布跟 P 桶同口径）；
//   · `cntAll`：子树里**所有** P 各算一次（dedup 下每个 P 用**它所属组的**值）—— 容器的
//     **本身值**（`statusComplete1/2`）用它，与 `derive.js` 的 `containerAggregates` 一致。
//
// ⚠️ `dedup` 的 📊分布**不在这一趟里**（见 `view/stats.js` 的说明：它按**原始组键**去重、
//    取"子树内第一次出现"那条的显示值，那个值不是每组的常数 ⇒ 这个"往上加"的模型表达不了）。
// ⚠️ 纯函数、只读 state（不写节点、不写来源层）；口径全部复用现成实现。
// ================================================================
import { collectGroupsCached, MODE_PLAIN, MODE_DEDUP } from './groupCount.js';
import { groupAggregateOf } from '../groupValue.js';
import { readField } from '../fieldValue.js';
import { resolveScope } from '../trust.js';
import { effectivePin } from '../pin.js';
import {
    derivePstatus1, derivePtriple, derivePxcpcDifficulty
} from '../derive.js';
import {
    addProblemClass, problemBucketOfClass, P_CLASS_DIMS,
    addContestClass, contestBucketOfClass, C_CLASS_DIMS,
    statusComplete2Of
} from '../model/status.js';

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** 容器类型（本身值是 `statusComplete1/2` 的那几种） */
const CONTAINER_TYPES = new Set(['C', 'W', 'S']);

/** 各数组的**额容量**：给"加节点"留位置（新增键追加在末尾 ⇒ 老下标不动，抬逻辑长度即可）。 */
const ADD_CAP = 512;

/**
 * 跑这一趟。**只读 state**。
 *
 * @param {Object} state - `{ rootId, nodes, childOrder, accounts, trust, viewingAccountId, settings }`
 * @param {Object} [opts] - `{ mode, viewingAccount, scopeAccounts, accounts, trust }`
 * @returns {Object} `{ ownOf(id), rowOf(id), problemOf(id, {rule}), contestOf(id), distOf(id), timings }`
 */

export function runCountPass(state, opts = {}) {
    const tStart = now();
    // 分相计时（诊断用：显示侧就指着这一趟，得知道钱花在哪一相）——
    //   `tables` = `collectGroups` 那趟组划分；`group` = 组事件（含组值聚合与三套向量上推）；
    //   剩下的 = 逐节点本身值（`computeOwn`，容器那格要汇总子树）。
    let tTables = 0;
    let tGroup = 0;
    let groupEvents = 0;
    let tAgg = 0;            // 组值聚合（`groupAggregateOf`）
    let aggCalls = 0;
    let tPush = 0;           // 三套向量的上推（`pushUnit` / `pushVec`）
    let tContainer = 0;      // 容器那格（子树汇总）在 `own` 相里占多少
    let readCalls = 0;       // 投影（`readField`）调用次数
    let deltaMs = 0;         // 增量更新（`applyValueDelta`）累计耗时
    /** 倒推覆盖表（只 dedup 建；`groupCompute.js` 的"组那份"就是它） */
    const grpRows = opts.mode === MODE_DEDUP ? new Map() : null;
    const mode = (opts.mode === MODE_DEDUP) ? MODE_DEDUP : MODE_PLAIN;
    // ⚠️ `nodes` / `state` 是**可变绑定**：增量更新（`applyValueDelta`）要把这一趟
    //    接到**新一代**上（键集合与结构都没变，只是某几个节点的值变了）。
    let nodes = (state && state.nodes) || {};
    const childOrder = (state && state.childOrder) || {};

    // ---- 范围（与 `derive.js` 的 `buildDerivedTable` 同形）----
    const full = {
        viewingAccount: opts.viewingAccount,
        scopeAccounts: opts.scopeAccounts,
        accounts: opts.accounts !== undefined ? opts.accounts : state.accounts,
        trust: opts.trust !== undefined ? opts.trust : state.trust
    };
    const scope = resolveScope(full);
    const read = (node, field) => {
        readCalls += 1;
        return readField(node, field, full);
    };

    // ---- ① 索引与结构 ----
    // ⚠️ `ids` / `n` 是**可变**的：加节点时把新键追加到末尾、逻辑长度往上抬（见下面的容量说明）
    let ids = Object.keys(nodes);
    let n = ids.length;
    // ★ **容量 = n + 余量**：给"加节点"留位置 —— 新增键**追加在末尾**（实测：对象键序是插入序，
    //   加节点老下标一个都不动、删节点也不会让后面前移）⇒ 增量只要把逻辑长度 `n` 往上抬。
    //   余量用光就不接增量（调用方退回整棵重算）。
    const cap = n + ADD_CAP;
    const index = new Map();
    for (let i = 0; i < n; i++) index.set(ids[i], i);
    const typeOf = new Array(n);
    for (let i = 0; i < n; i++) {
        const node = nodes[ids[i]];
        typeOf[i] = (node && node.type) || '';
    }
    const kids = new Array(n);
    const parentIdx = new Int32Array(cap).fill(-1);
    for (let i = 0; i < n; i++) kids[i] = [];
    for (const pid in childOrder) {
        const pi = index.get(pid);
        if (pi === undefined) continue;
        for (const cid of childOrder[pid] || []) {
            const ci = index.get(cid);
            if (ci === undefined) continue;
            kids[pi].push(ci);
            parentIdx[ci] = pi;
        }
    }

    // ---- ② 计数格子（按节点下标：8 格 ×2 套 + 5 格）----
    const cntRule = new Int32Array(cap * P_CLASS_DIMS);
    const cntAll = new Int32Array(cap * P_CLASS_DIMS);
    const cntC = new Int32Array(cap * C_CLASS_DIMS);

    // ---- ③ 本身值（-1 = 还没算）----
    const vS1 = new Int8Array(cap).fill(-1);
    const vS2 = new Int8Array(cap).fill(-1);
    const vC1 = new Int8Array(cap).fill(-1);
    const vC2 = new Int8Array(cap).fill(-1);
    // P 的另外三格（整行要完整 —— `derive.js` 的全量那条路直接拿这一行建表）
    const vAc = new Array(cap);
    const vLst = new Array(cap);
    const vDiff = new Array(cap);

    // ---- ④ 遍历用的标记 ----
    const subDone = new Uint8Array(cap);    // 子树已处理（本身值已算、贡献已推）
    const vis = new Uint8Array(cap);        // 组事件已处理过
    const timRule = new Int32Array(cap);    // 上一次收到贡献的"代"（每个组事件一个 myTimc）
    let Timc = 0;

    // ---- ⑤ 组（合成）关系：**只有 `collectGroups` 这一份划分**（与统计侧同一入口）----
    //   ⚠️ 注意它与"按 synthKey 建表"的旧写法有一处**形态差别**：`collectGroups` 把"自成一组"
    //   的节点**也算作该组的成员**（`slot.members` 里有它自己，键就是它的节点 id）⇒
    //   上推时**别再单独推一次**（否则原料被推两遍：实测真包 plain 根 P 桶 19840 vs 13133）。
    let keyOfNode = null;                   // 节点下标 → 组键（每个节点都有）
    let headIdxOfKey = null;                // 组键 → 组头节点下标（-1 = 没有组头）
    let memberIdxOfKey = null;              // 组键 → 成员节点下标数组（**含"自成一组"的那个节点自己**）

    /** 一个 P 单位的 8 格向量 */
    const unit8 = (s1, s2) => {
        const v = new Int32Array(P_CLASS_DIMS);
        addProblemClass(v, 0, s1, s2);
        return v;
    };
    /** 一场 C 单位的 5 格向量 */
    const unit5 = (sc2) => {
        const v = new Int32Array(C_CLASS_DIMS);
        addContestClass(v, 0, sc2);
        return v;
    };

    /** 把一份向量加到 `at` 这一格 */
    const addAt = (store, dims, at, vec, sign) => {
        const base = at * dims;
        for (let k = 0; k < dims; k++) store[base + k] += sign * vec[k];
    };

    /** 由上推得到的计数算出容器的本身值（**不向下查**） */
    const containerOwn = (v, node) => {
        const base = v * P_CLASS_DIMS;
        const c = (i) => cntAll[base + i];
        const total = c(0) + c(1) + c(2) + c(3) + c(4) + c(5);
        const processedAll = c(6) + c(7);                  // |s1==1|
        vC1[v] = (total > 0 && processedAll === total) ? 1 : 0;
        const pin2 = effectivePin(node, 'statusComplete2', scope);
        vC2[v] = (String(pin2) === '4')
            ? 4
            : statusComplete2Of(problemBucketOfClass(cntAll, base));
    };

    /** 算一个节点的本身值（轮到它时，子树已算完） */
    const computeOwn = (v) => {
        const node = nodes[ids[v]];
        if (!node) return;
        const type = typeOf[v];
        if (type === 'P') {
            vS1[v] = derivePstatus1(node, scope);
            // ⚠️ 这三格**一趟扫完**（`derivePtriple`）—— 原来三个规则各扫一遍子 R（真包 P 有 15390 个）；
            //    判据逐字同源（三格的规则只有那一份），不是"另写一份更快的"。
            const tri = derivePtriple(state, node, read, () => effectivePin(node, 'status2', scope));
            vS2[v] = tri.status2;
            vAc[v] = tri.acTime;
            vLst[v] = tri.lastSubmitTime;
            vDiff[v] = derivePxcpcDifficulty(read(node, 'ratio'));
            return;
        }
        if (CONTAINER_TYPES.has(type)) {
            // 只给容器那格计时（1990 个 ⇒ 计时开销可忽略）；P 那格 = `own` 相减去它
            const t0 = now();
            containerOwn(v, node);
            tContainer += now() - t0;
        }
    };

    const ensureGroupTables = () => {
        if (keyOfNode) return;
        const t0 = now();
        // 组划分只有这一份（`collectGroups`）；共享记忆化口 ⇒ 同一代里别处（`core/query/stats.js`）
        // 要同一份时不再重扫（真包这一趟 88~92ms）
        const g = collectGroupsCached(state);
        const { groups } = g;
        keyOfNode = new Array(n);
        headIdxOfKey = new Map();
        memberIdxOfKey = new Map();
        // ⚠️ 用**下标数组**（`ids` 与 `groupKeyOf` 都是 `Object.keys(nodes)` 的顺序，
        //    同一份 nodes ⇒ 顺序必然相同）⇒ 省掉 27k 次 `Map.get`；对不上就退回 Map。
        if (g.groupKeyOf && g.ids && g.ids.length === n) {
            for (let i = 0; i < n; i++) keyOfNode[i] = g.groupKeyOf[i];
        } else {
            for (let i = 0; i < n; i++) keyOfNode[i] = g.groupOfNode.get(ids[i]);
        }
        for (const [key, slot] of groups) {
            headIdxOfKey.set(key,
                (slot.synthId && index.has(slot.synthId)) ? index.get(slot.synthId) : -1);
            const mem = [];
            for (const mid of slot.members || []) {
                const mi = index.get(mid);
                if (mi !== undefined && mem.indexOf(mi) < 0) mem.push(mi);
            }
            memberIdxOfKey.set(key, mem);
        }
        tTables += now() - t0;
    };

    /**
     * 读一个节点的"自己那份"（组值合并要用；本身值还没算的字段给 `undefined`）。
     *
     * ⚠️ **每一列都要读"本范围投影过的那一份"**（用户 2026-10-13 拍板）——
     *   原来除 `status1/2`、`statusComplete1/2` 之外一律 `return node[field]`（**缓存字段**）：
     *   缓存是"一个范围"的物化结果、**不分账户** ⇒ 组那份 `acTime` 记住**别人**的 AC，
     *   而同一行的 `status2` 是投影出来的本机口径 ⇒ 组头带着别人的 AC 时间进
     *   「时间范围 AC 列表」，网格那一格却是「未使用/已提交未通过」（实测真包 133 条，
     *   见 `scripts/_probe-ownrow-ab.mjs` 的注入变体）。
     * 取值口**只有这两处**（都在本文件里）：本趟的数组 / `read`（= `readField` 投影）。
     */
    const readOwnRow = (node, field) => {
        const i = index.get(node.id);
        if (i === undefined) return node[field];
        const st = field === 'status1' ? vS1 : field === 'status2' ? vS2
            : field === 'statusComplete1' ? vC1 : field === 'statusComplete2' ? vC2
            : field === 'acTime' ? vAc : field === 'lastSubmitTime' ? vLst
            : field === 'xcpcDifficulty' ? vDiff : null;
        if (st) {
            const val = st[i];
            return (val === undefined || val < 0) ? node[field] : val;
        }
        // 其余（`cfDifficulty` / `atcoderDifficulty` / `clistDifficulty` / `ratio`）是**来源层字段**：
        // 它们这一趟没有自己的数组 ⇒ 用本文件那唯一的投影读口 `read`（= `core/fieldValue.js` 的
        // `readField` 按本范围投影；语义与 `view/scope.js` 的 `viewValue` 对齐 ——
        // 区别只在"范围内没有值"时它给空、`viewValue` 给缓存那份）。
        // ⚠️ `core/` 里**不许反向 import `view/`** —— 这一层的读法**只有 `readField` 这一份**。
        return read(node, field);
    };

    /** 一个字段的"组那份"（规则只有 `groupAggregateOf` 那一份；没有组头 ⇒ 退回自己那份） */
    const groupFieldOf = (headIdx, memberIds, field) => {
        if (headIdx === undefined) return undefined;
        const t0 = now();
        aggCalls += 1;
        const v = groupAggregateOf(state, {
            headId: ids[headIdx], memberIds, field, readOf: readOwnRow
        });
        tAgg += now() - t0;
        if (v === undefined || v === null) return readOwnRow(nodes[ids[headIdx]], field);
        return v;
    };

    /** 把一份**现成的**向量推到某个节点的祖先链上（`breakOnTim` = 撞到本代标记就停）
     *  `sign = -1` ⇒ **减掉**这份贡献（增量更新用：先减旧、再加新） */
    const pushVec = (v, store, dims, vec, breakOnTim, myTimc, sign = 1) => {
        let at = v;
        let guard = 0;
        while (at >= 0 && guard++ < 100000) {
            addAt(store, dims, at, vec, sign);
            if (breakOnTim) {
                timRule[at] = myTimc;
                const p = parentIdx[at];
                if (p >= 0 && timRule[p] === myTimc) break;
                at = p;
            } else {
                at = parentIdx[at];
            }
        }
    };

    /**
     * 把一个节点的本身值沿所有祖先加一遍（plain 用：原料 / 组头各一套）。
     * @param {number} v 节点下标
     * @param {boolean} doAll 推 `cntAll`（容器本身值那套）
     * @param {boolean} markTim 记不记 `timRule`（原料记、组头不记）
     * @param {boolean} doRule 推 `cntRule`
     * @param {boolean} breakOnRule `cntRule` 撞到本代标记是否 break（只有组头 true）
     * @param {number} myTimc 本次组事件的代
     */
    const pushUnit = (v, doAll, markTim, doRule, breakOnRule, myTimc, sign = 1) => {
        const type = typeOf[v];
        if (type !== 'P' && type !== 'C') return;          // 只有 P / C 的本身值参与统计
        if (type === 'P') {
            if (vS1[v] < 0) return;                        // 本身值还没算（坏数据）
            const vec = unit8(vS1[v], vS2[v]);
            let at = v;
            let guard = 0;
            while (at >= 0 && guard++ < 100000) {
                if (doAll) addAt(cntAll, P_CLASS_DIMS, at, vec, sign);
                if (doRule) addAt(cntRule, P_CLASS_DIMS, at, vec, sign);
                if (markTim) timRule[at] = myTimc;
                const p = parentIdx[at];
                if (breakOnRule && p >= 0 && timRule[p] === myTimc) break;
                at = p;
            }
            return;
        }
        if (vC2[v] < 0) return;
        const vec = unit5(vC2[v]);
        let at = v;
        let guard = 0;
        while (at >= 0 && guard++ < 100000) {
            // ⚠️ C 侧目前**只数"所有 C 各一次"**（与现状 `collectCStats` 的 plain 一致）；
            //    "plain 下 C 的组头排除"以后再加（那时这里跟 P 一样带 break）
            addAt(cntC, C_CLASS_DIMS, at, vec, sign);
            at = parentIdx[at];
        }
    };

    /**
     * 一个组事件：把组内所有节点的本身值凑齐（缺的按需走它们的子树），然后按模式的规矩上推。
     * @param {number} startIdx - 触发这次事件的节点下标（组内任意一个都行）
     */
    const runGroup = (startIdx, sign = 1) => {
        ensureGroupTables();
        const startNode = nodes[ids[startIdx]];
        // 组键与组内成员**全部来自 `collectGroups`**（悬空键 ⇒ 它自成一组，与统计侧同口径）
        const key = keyOfNode[startIdx];
        const headRaw = key === undefined ? -1 : (headIdxOfKey.get(key) ?? -1);
        const headIdx = headRaw >= 0 ? headRaw : undefined;
        const headId = headIdx === undefined ? '' : ids[headIdx];
        const memberIdx = (key === undefined ? [] : (memberIdxOfKey.get(key) || [])).slice();
        const memberIds = memberIdx.map((i) => ids[i]);

        // ⚠️ `myTimc` **必须快照**：下面 `ensureSubtree` 可能嵌套触发别的组事件（它们也会 ++Timc），
        //    外层若继续读全局 `Timc` 去比标记，就会撞上别的组留下的标记 ⇒ 提前 break、少算。
        const myTimc = ++Timc;
        // ⚠️ `vis` **必须在这里就置**（事件是原子的）：否则下面 `ensureSubtree` 走到组内某个
        //    成员时会再触发一次同一个组的组事件 ⇒ 同一份值被推两遍（实测根节点计数 ×2.5）。
        for (const mi of memberIdx) vis[mi] = 1;
        if (headIdx !== undefined) vis[headIdx] = 1;
        vis[startIdx] = 1;

        for (const mi of memberIdx) ensureSubtree(mi);
        if (headIdx !== undefined) ensureSubtree(headIdx);
        else ensureSubtree(startIdx);

        const headType = headIdx !== undefined ? typeOf[headIdx] : typeOf[startIdx];
        const isP = headType === 'P';
        const isC = CONTAINER_TYPES.has(headType);

        if (mode === MODE_PLAIN) {
            // ---- plain：组头的本身值 = merge（成员各自那份），规则复用 `groupAggregateOf` ----
            //   ⚠️ `sign < 0`（减旧贡献）时**不许回写本身值**：那时用的必须是"改动前"的值。
            if (sign > 0 && headIdx !== undefined && memberIdx.length) {
                const fields = (headType === 'P')
                    ? ['status2']
                    : (CONTAINER_TYPES.has(headType) ? ['statusComplete1', 'statusComplete2'] : []);
                for (const field of fields) {
                    const val = groupAggregateOf(state, { headId, memberIds, field, readOf: readOwnRow });
                    if (val === undefined || val === null) continue;
                    if (field === 'status2') vS2[headIdx] = Number(val);
                    else if (field === 'statusComplete1') vC1[headIdx] = Number(val);
                    else if (field === 'statusComplete2') vC2[headIdx] = Number(val);
                }
            }
            // ① 原料（成员，以及"没有组头的那个节点自己"）：两套都推、无条件、置 `timRule`
            //   ⚠️ `collectGroups` 的单元素组"成员里有它自己" ⇒ 这里**别再推第二遍**（会多算）
            const tP = now();
            for (const mi of memberIdx) pushUnit(mi, true, true, true, false, myTimc, sign);
            if (headIdx === undefined && memberIdx.indexOf(startIdx) < 0) {
                pushUnit(startIdx, true, true, true, false, myTimc, sign);
            }
            // ② 组头：`cntAll` 无条件推；`cntRule` 推、撞到本代标记就 break
            if (headIdx !== undefined) pushUnit(headIdx, true, false, true, true, myTimc, sign);
            tPush += now() - tP;
            return;
        }

        // ================= dedup =================
        // 组值（3 步）：P 组给 `status1` / `status2`（与 `groupProblemValue` 同一入口），
        // C 组给 `statusComplete1/2`（与 `contestGroupValue` 同一入口）；取不到 ⇒ 退回组头自己那份。
        const gNodes = memberIdx.slice();
        if (headIdx !== undefined) gNodes.push(headIdx);
        if (!gNodes.length) gNodes.push(startIdx);          // 单元素组（没组头也没成员）⇒ 它自己
        let vecP = null;
        let vecC = null;
        if (isP) {
            const s1 = headIdx === undefined ? readOwnRow(startNode, 'status1') : groupFieldOf(headIdx, memberIds, 'status1');
            const s2 = headIdx === undefined ? readOwnRow(startNode, 'status2') : groupFieldOf(headIdx, memberIds, 'status2');
            vecP = unit8(s1, s2);
        }
        if (isC) {
            const c2 = headIdx === undefined ? readOwnRow(startNode, 'statusComplete2') : groupFieldOf(headIdx, memberIds, 'statusComplete2');
            vecC = unit5(c2);
        }
        // 组头的**本身值**：dedup 下它就是"组那份"（与 `derive.js` 的"第二趟"同一份口径）。
        // ⚠️ 必须**先**把 `vecP`/`vecC` 算完再回写：那两处要用组头**自己那份**当 A 侧。
        // ⚠️ `sign < 0`（减旧贡献）时**不许回写**：那时用的必须是"改动前"的值。
        if (sign > 0 && headIdx !== undefined) {
            if (headType === 'P') {
                const g2 = groupFieldOf(headIdx, memberIds, 'status2');
                if (g2 !== undefined && g2 !== null) vS2[headIdx] = Number(g2);
                // ★ 难度 / AC时间 / 最新提交与 `status2` **同一条路**：把组那份写回组头自己那一格
                const gd = groupFieldOf(headIdx, memberIds, 'xcpcDifficulty');
                if (gd !== undefined && gd !== null) vDiff[headIdx] = gd;
                const ga = groupFieldOf(headIdx, memberIds, 'acTime');
                if (ga !== undefined && ga !== null) vAc[headIdx] = ga;
                const gl = groupFieldOf(headIdx, memberIds, 'lastSubmitTime');
                if (gl !== undefined && gl !== null) vLst[headIdx] = gl;
            } else if (CONTAINER_TYPES.has(headType)) {
                const g1 = groupFieldOf(headIdx, memberIds, 'statusComplete1');
                const g2 = groupFieldOf(headIdx, memberIds, 'statusComplete2');
                if (g1 !== undefined && g1 !== null) vC1[headIdx] = Number(g1);
                if (g2 !== undefined && g2 !== null) vC2[headIdx] = Number(g2);
            }
        }
        // ---- 倒推覆盖表（`working` 那一份）：`groupCompute.js` 的三趟要的就是这些 ----
        // ⚠️ 与**计数**用的 s1/s2 **分开算**：计数那套在"没有组头"时用"它自己那份"（`readOwnRow`），
        //    而这里必须与 `computeLayerGroups` 的**单元素组**口径一字不差 —— 它是
        //    `mergeField(A, 空名单)`（走同一个 `groupAggregateOf` 入口，不要自己写等价式）。
        // ⚠️ 同样只在 `sign > 0` 时写（减旧贡献那一趟不许动覆盖表）。
        // ⚠️ `sign > 0` 时先**删掉这一组旧的那几条**：组值可能**变成空**
        //    （`mergeField` 返回 null ⇒ 全量那边根本不会有这条）—— 只写不删会留下陈旧行。
        if (sign > 0 && grpRows) {
            for (const gv of gNodes) grpRows.delete(ids[gv]);
        }
        if (sign > 0 && grpRows) {
            const solo = (field) => groupAggregateOf(state, {
                headId: nodes[ids[startIdx]].id, memberIds: [], field, readOf: readOwnRow
            });
            const useSolo = headIdx === undefined;
            const o1 = useSolo ? solo('status1') : groupFieldOf(headIdx, memberIds, 'status1');
            const o2 = useSolo ? solo('status2') : groupFieldOf(headIdx, memberIds, 'status2');
            // ★ 难度 / 通过率 / AC时间 / 最新提交也进这一行（与 status 共用同一张覆盖表）
            const o3 = useSolo ? solo('xcpcDifficulty') : groupFieldOf(headIdx, memberIds, 'xcpcDifficulty');
            const o4 = useSolo ? solo('acTime') : groupFieldOf(headIdx, memberIds, 'acTime');
            const o5 = useSolo ? solo('lastSubmitTime') : groupFieldOf(headIdx, memberIds, 'lastSubmitTime');
            const o6 = useSolo ? solo('cfDifficulty') : groupFieldOf(headIdx, memberIds, 'cfDifficulty');
            const o7 = useSolo ? solo('atcoderDifficulty') : groupFieldOf(headIdx, memberIds, 'atcoderDifficulty');
            const o8 = useSolo ? solo('clistDifficulty') : groupFieldOf(headIdx, memberIds, 'clistDifficulty');
            const o9 = useSolo ? solo('ratio') : groupFieldOf(headIdx, memberIds, 'ratio');
            const row = {};
            if (o1 !== null && o1 !== undefined) row.status1 = o1;
            if (o2 !== null && o2 !== undefined) row.status2 = o2;
            if (o3 !== null && o3 !== undefined) row.xcpcDifficulty = o3;
            if (o4 !== null && o4 !== undefined) row.acTime = o4;
            if (o5 !== null && o5 !== undefined) row.lastSubmitTime = o5;
            if (o6 !== null && o6 !== undefined) row.cfDifficulty = o6;
            if (o7 !== null && o7 !== undefined) row.atcoderDifficulty = o7;
            if (o8 !== null && o8 !== undefined) row.clistDifficulty = o8;
            if (o9 !== null && o9 !== undefined) row.ratio = o9;
            if (Object.keys(row).length) {
                for (const gv of gNodes) grpRows.set(ids[gv], { ...row });
            }
        }
        const tP = now();
        for (const gv of gNodes) {
            const t = typeOf[gv];
            // `cntAll`（容器本身值那套）：**每个 P 节点**推一次 —— 值 = 它所属组的**组那份**
            // （那一组是 P 族时）；**组头类型不符**（坏数据）时参照那边读不到覆盖 ⇒ 用**它自己那份**
            if (t === 'P') {
                const v8 = vecP || unit8(readOwnRow(nodes[ids[gv]], 'status1'), readOwnRow(nodes[ids[gv]], 'status2'));
                pushVec(gv, cntAll, P_CLASS_DIMS, v8, false, myTimc, sign);
            }
            // 统计那两套：**每组每个子树一次** ⇒ 逐个推、撞 `tim` 就 break、来路置 `tim`
            if (t === 'P' && vecP) pushVec(gv, cntRule, P_CLASS_DIMS, vecP, true, myTimc, sign);
            if (t === 'C' && vecC) pushVec(gv, cntC, C_CLASS_DIMS, vecC, true, myTimc, sign);
        }
        tPush += now() - tP;
    };

    /** 一个组键的"代表下标"（组事件只需要组内任意一个节点就能触发整套逻辑） */
    const groupStartIdxOf = (key) => {
        if (key === undefined || key === null) return -1;
        const h = headIdxOfKey.get(key);
        if (h !== undefined && h >= 0) return h;
        const mem = memberIdxOfKey.get(key) || [];
        return mem.length ? mem[0] : -1;
    };

    /**
     * **增量：节点值修改**（树结构没变，只有某几个节点的值变了）。
     *
     * 思路（用户 2026-10-07 定）：计数缓存与 `tim`/`Timc` **都不扔**（只有全量刷新才重置）。
     *   · 改动集合 = 改动节点（+ 它们的父：R 改了 ⇒ 父 P 的本身值跟着变）**+ 它们所在的整组**；
     *   · 从这一层往上，**每层三步**：先**减掉旧的向上贡献**（用旧本身值）→ **重算本身值**
     *     → 再**加上新的向上贡献**；然后把集合换成它们的父，继续；
     *   · 到再没有 P/C 参与计数的那一层之后，剩下的一次性更新即可。
     * ⇒ 改动节点数是"这一条链 + 那个组"，与树的规模无关。
     *
     * ⚠️ 前提（都已实测，见 `scripts/_probe-*`）：
     *   · 计数是**可加向量**（`addAt` 带 `sign`）⇒ 减得回来；
     *   · `break` 只比"是否等于本次事件的 `myTimc`" ⇒ **换个新号重推**，遍历形状与当初逐字相同
     *     （新号谁都不带 ⇒ 第一个节点走到底并打标，后面的在共享祖先处停）⇒ 减/加的是同一批祖先；
     *   · 值修改**不增删节点键** ⇒ `Object.keys(nodes)` 顺序不变 ⇒ 按下标的那些数组继续有效。
     */
    /**
     * 把这一趟**长大**到新一代：只允许"新增键追加在末尾"（实测：对象键序是插入序 ⇒
     * 加节点时老下标一个都不动）。接不了就返回 `false`，调用方退回整棵重算。
     */
    const growWith = (nextState, added) => {
        const nextIds = Object.keys(nextState.nodes);
        if (nextIds.length > cap) return false;                       // 余量用光
        for (let i = 0; i < n; i++) if (nextIds[i] !== ids[i]) return false;   // 老下标必须逐个不变
        const m = nextIds.length;
        if (m - n !== added.length) return false;                     // 新增的正好是这次加的那批
        ids = nextIds;
        for (let i = n; i < m; i++) {                                 // 先初始化新增那一段
            const id = ids[i];
            const node = nextState.nodes[id];
            index.set(id, i);
            typeOf[i] = (node && node.type) || '';
            vS1[i] = -1; vS2[i] = -1; vC1[i] = -1; vC2[i] = -1;
            vAc[i] = undefined; vLst[i] = undefined; vDiff[i] = undefined;
            subDone[i] = 0; vis[i] = 0; timRule[i] = 0;
            parentIdx[i] = -1;
            kids[i] = [];
        }
        for (let i = n; i < m; i++) {                                 // 再接父子关系（含挂到老父下）
            const id = ids[i];
            const p = nextState.parentOf ? nextState.parentOf[id] : undefined;
            const pi = (p === undefined || p === null) ? -1 : (index.get(String(p)) ?? -1);
            parentIdx[i] = pi;
            if (pi >= 0) kids[pi].push(i);
            for (const cid of (nextState.childOrder && nextState.childOrder[id]) || []) {
                const ci = index.get(cid);
                if (ci !== undefined) kids[i].push(ci);
            }
        }
        n = m;
        // 组表按新状态重建（`ensureGroupTables` 见到 keyOfNode 为空就会重算）
        keyOfNode = null;
        headIdxOfKey = null;
        memberIdxOfKey = null;
        return true;
    };

    /**
     * **增量**：节点值修改 + 加节点（树结构改动只允许"加"；删节点不在范围内）。
     *
     * 思路（用户 2026-10-07 定）：计数缓存与 `tim`/`Timc` **都不扔**（只有全量刷新才重置）。
     *   · 改动集合 = 改动节点（+ 它们的父：R 改了 ⇒ 父 P 的本身值跟着变）**+ 它们所在的整组**；
     *   · 从这一层往上，**每层三步**：先**减掉旧的向上贡献**（用旧本身值）→ **重算本身值**
     *     → 再**加上新的向上贡献**；然后把集合换成它们的父，继续；
     *   · 到再没有 P/C 参与计数的那一层之后，剩下的一次性更新即可。
     *   · **加节点不需要"减旧"**（它旧贡献为 0；`vS1[i] < 0` 时上推本来就自动跳过）——
     *     只需要把新键追加进数组、算它的本身值、推它的贡献；要减旧的只有**祖先**。
     * ⇒ 改动节点数是"这一条链 + 那个组"，与树的规模无关。
     *
     * ⚠️ 加节点时**有一个顺序不能错**：新节点若一进组就改变**组值**，那"减旧"必须用
     *    **旧组值**，而组表是 `collectGroups(新状态)` 重建的 ⇒ 减的那一刻新成员已经在名单里了。
     *    所以：**先用旧组表减掉那几个组的旧贡献 → 再扩数组/重建组表 → 再走新增子树**。
     *
     * ⚠️ 前提（都已实测，见 `scripts/_probe-*`）：
     *   · 计数是**可加向量**（`addAt` 带 `sign`）⇒ 减得回来；
     *   · `break` 只比"是否等于本次事件的 `myTimc`" ⇒ **换个新号重推**，遍历形状与当初逐字相同
     *     （新号谁都不带 ⇒ 第一个节点走到底并打标，后面的在共享祖先处停）⇒ 减/加的是同一批祖先；
     *   · 键序：新增键**追加在末尾**、删键不让后面前移（真包实测）⇒ 按下标的数组继续有效。
     * @returns {boolean} 接得下返回 true；接不下（容量/键序不符）返回 false（调用方退回全量）
     */
    const applyDelta = (nextState, changedIds, addedIds) => {
        const t0 = now();
        const added = Array.isArray(addedIds) ? addedIds : [];
        // ---------- ① 加节点：**先用旧组表**把那几个要变的组的旧贡献减掉 ----------
        if (added.length) {
            const nextGroups = collectGroupsCached(nextState);     // 顺手把记忆化填上（下面重建时就免费）
            const done = new Set();
            for (const id of added) {
                const key = nextGroups.groupOfNode.get(id);
                if (!key || done.has(key)) continue;
                done.add(key);
                const start = groupStartIdxOf(key);                // 旧表里的代表（没有 ⇒ 这组本来没贡献）
                if (start >= 0) runGroup(start, -1);
            }
        }
        // ---------- ② 扩数组（老下标不动）----------
        if (added.length) {
            if (!growWith(nextState, added)) return false;
            state = nextState;
            nodes = nextState.nodes;
        } else if (nextState && nextState.nodes) {
            state = nextState;                 // 值修改：键集合没变
            nodes = nextState.nodes;
        }
        ensureGroupTables();
        // ---------- ③ 新增子树：算本身值 + 推贡献（走全量那条老路：`subDone` 还是 0）----------
        for (const id of added) {
            const i = index.get(String(id));
            if (i !== undefined) ensureSubtree(i);
        }
        const level = new Set();
        const groups = new Set();
        const addWithGroup = (i) => {
            level.add(i);
            // ⚠️ **只有 P / C 跑组事件**（与全量的 `ensureSubtree` 同一条判据）：
            //    R / W / S / O 既没有参与计数的本身值，全量那边也从不为它们写覆盖表
            //    —— 给它们跑会凭空写出 `{status1:0}` 这类陈行（实测：dedup 下多 6~24 条）。
            if (typeOf[i] !== 'P' && typeOf[i] !== 'C') return;
            const key = keyOfNode[i];
            if (key === undefined) return;
            groups.add(key);
            for (const mi of memberIdxOfKey.get(key) || []) level.add(mi);
            const h = headIdxOfKey.get(key);
            if (h !== undefined && h >= 0) level.add(h);
        };
        // 新增节点的**父**（新加的 R 会让父 P 的本身值变）；改动节点本人 + 它的父
        for (const id of added) {
            const i = index.get(String(id));
            if (i === undefined) continue;
            const p = parentIdx[i];
            if (p >= 0) addWithGroup(p);
        }
        for (const id of changedIds || []) {
            const i = index.get(String(id));
            if (i === undefined) continue;
            addWithGroup(i);
            const p = parentIdx[i];
            if (p >= 0) addWithGroup(p);       // 父：R 改了 ⇒ 父 P 的本身值跟着变
        }
        let cur = level;
        let guard = 0;
        while (cur.size && guard++ < 64) {
            // ① 减掉旧贡献（用**改动前**的本身值；新号 ⇒ 与当初同一批祖先）
            for (const key of groups) {
                const start = groupStartIdxOf(key);
                if (start >= 0) runGroup(start, -1);
            }
            // ② 重算这一层的本身值（P：按新一代的 R；容器：读已经更新过的 `cntAll`）
            const parents = new Set();
            for (const i of cur) {
                const t = typeOf[i];
                if (t === 'P' || CONTAINER_TYPES.has(t)) computeOwn(i);
                const p = parentIdx[i];
                if (p >= 0) parents.add(p);
            }
            // ③ 加回新贡献（含组头本身值回写与覆盖表）
            for (const key of groups) {
                const start = groupStartIdxOf(key);
                if (start >= 0) runGroup(start, +1);
            }
            // ④ 上一层：集合换成父，组换成这些父所在的组（**同样只有 P/C 进组**）
            cur = parents;
            groups.clear();
            for (const i of cur) {
                if (typeOf[i] !== 'P' && typeOf[i] !== 'C') continue;
                const key = keyOfNode[i];
                if (key === undefined) continue;
                groups.add(key);
                for (const mi of memberIdxOfKey.get(key) || []) cur.add(mi);
                const h = headIdxOfKey.get(key);
                if (h !== undefined && h >= 0) cur.add(h);
            }
        }
        deltaMs += now() - t0;
        return true;
    };

    /** 把一个节点的子树按需走完（后序），轮到它就算本身值，该触发组事件就触发 */
    function ensureSubtree(v) {
        if (subDone[v]) return;
        subDone[v] = 1;                                    // 先标：坏数据（环）不会死循环
        for (const c of kids[v]) ensureSubtree(c);
        computeOwn(v);
        if (!vis[v] && (typeOf[v] === 'P' || typeOf[v] === 'C')) {
            const t0 = now();
            groupEvents += 1;
            runGroup(v);
            tGroup += now() - t0;
        }
    }

    // ---- ⑥ 主循环：逐节点兜底（子树按需走，走完就跳过）----
    for (let v = 0; v < n; v++) ensureSubtree(v);
    const tPass = now() - tStart;

    // ---- ⑦ 对外取数 ----
    const at = (id) => index.get(id);
    return {
        size: n,
        timings: {
            pass: tPass,
            tables: tTables,
            group: tGroup,
            groupEvents,
            agg: tAgg,
            aggCalls,
            push: tPush,
            container: tContainer,
            readCalls,
            own: tPass - tTables - tGroup
        },
        /** 本身值（范围口径；没算出来的字段是 undefined） */
        ownOf(id) {
            const i = at(id);
            if (i === undefined) return {};
            const out = {};
            if (vS1[i] >= 0) out.status1 = vS1[i];
            if (vS2[i] >= 0) out.status2 = vS2[i];
            if (vC1[i] >= 0) out.statusComplete1 = vC1[i];
            if (vC2[i] >= 0) out.statusComplete2 = vC2[i];
            return out;
        },
        /** 单个字段的本身值（**不分配对象** —— `baseOf` 一次遍历要调几万次，`ownOf` 每次都建一个 `{}`） */
        ownField(id, field) {
            const i = at(id);
            if (i === undefined) return undefined;
            const st = field === 'status1' ? vS1 : field === 'status2' ? vS2
                : field === 'statusComplete1' ? vC1 : field === 'statusComplete2' ? vC2 : null;
            if (!st) return undefined;
            const v = st[i];
            return v < 0 ? undefined : v;
        },
        /**
         * **整行**（与 `derive.js` 的 `computeOwnRow` 同字段）：P 五个 / 容器两个 / 别的类型空对象。
         * `derive.js` 的全量那条路直接拿它建表。
         */
        rowOf(id) {
            const i = at(id);
            if (i === undefined) return {};
            const type = typeOf[i];
            if (type === 'P') {
                return {
                    acTime: vAc[i],
                    lastSubmitTime: vLst[i],
                    status2: vS2[i] < 0 ? undefined : vS2[i],
                    xcpcDifficulty: vDiff[i],
                    status1: vS1[i] < 0 ? undefined : vS1[i]
                };
            }
            if (CONTAINER_TYPES.has(type)) {
                return {
                    statusComplete2: vC2[i] < 0 ? undefined : vC2[i],
                    statusComplete1: vC1[i] < 0 ? undefined : vC1[i]
                };
            }
            return {};
        },
        /** P 桶：`rule: true` = 行摘要/📊分布那套；`false` = "所有 P 各一次"（容器本身值那套） */
        problemOf(id, { rule = true } = {}) {
            const i = at(id);
            if (i === undefined) return problemBucketOfClass(new Int32Array(P_CLASS_DIMS), 0);
            const store = rule ? cntRule : cntAll;
            return problemBucketOfClass(store, i * P_CLASS_DIMS);
        },
        /** C 桶 */
        contestOf(id) {
            const i = at(id);
            if (i === undefined) return contestBucketOfClass(new Int32Array(C_CLASS_DIMS), 0);
            return contestBucketOfClass(cntC, i * C_CLASS_DIMS);
        },
        /** 倒推覆盖表：`nodeId → { status1?, status2? }`（**只 dedup 有**；plain 是空表）。
         *  与 `core/groupValue.js` 的 `computeLayerGroups` 的 `working` 同口径（A/B 验过）。 */
        groupOverrides() {
            return grpRows || new Map();
        },
        /**
         * **增量**：节点值修改（`changedIds`）+ 加节点（`addedIds`）。
         * 只更新"改动/新增节点所在组 + 祖先链"；接不下（容量/键序不符）返回 `false`。
         */
        applyValueDelta(nextState, changedIds, addedIds) {
            return applyDelta(nextState, changedIds, addedIds);
        },
        /**
         * 这一趟**是不是正好建在**这两个引用那一代上。
         *
         * 为什么必须有它：增量的下标（`ids` / `parentIdx` / 组表）都是**按那一代算的**
         * ⇒ 只有"正好是上一代"才敢就地增量。中间若发生过结构性改动而没人读过
         * （缓存里还是更早那份），拿它做增量会**下标错位**（实测：`reading 'id' of undefined`）。
         */
        isBuiltOn(nodesRef, childOrderRef) {
            return nodes === nodesRef && childOrder === childOrderRef;
        },
        /** 增量累计耗时（诊断） */
        deltaMs() {
            return deltaMs;
        },
        /** 📊分布（跟着 `cntRule` 的 `c0..c5` 走 —— 用户 2026-10-07 定；dedup 不走这里） */
        distOf(id) {
            const i = at(id);
            const out = new Array(6).fill(0);
            if (i === undefined) return out;
            const base = i * P_CLASS_DIMS;
            for (let k = 0; k <= 5; k++) out[k] = cntRule[base + k];
            return out;
        }
    };
}
