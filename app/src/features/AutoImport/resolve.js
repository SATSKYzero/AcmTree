// ================================================================
// 节点自动导入 — 拓扑排序与父引用解析（features/AutoImport/resolve.js）
// 职责：把扁平的记录数组排成「父先于子」的可应用顺序，并逐条裁定拒绝
// 依赖：core/validate/upsertConflict.js（包内 extKey 重复，3.2）
//       features/AutoImport/constants.js（节点类型合法性）
// 说明：本模块**不碰 DOM、不 import view/ shell/**，可在 Node 测试中直接引用。
//       除「记录本身有问题」外不做任何猜测——父引用两边都找不到就拒绝（2.3），
//       不做隐式创建、不从 URL 推断。
//
// 拒绝码：
//   duplicate-extkey  包内 extKey 重复（参与重复的每条都拒绝，3.2 / 4.7）
//   duplicate-synthkey 包内 synthKey 重复（同样每条都拒绝 —— 与 extKey 同一口径）
//   missing-extkey    extKey 缺失 / trim 后为空**且**没有 synthKey（3.1 / 4.4）
//   bad-type          节点类型不在 O/W/S/C/P/R 之列（2.1）
//   parent-both       父引用同时给了 父extKey 与 父synthKey（只能给一个）
//   unsupported-parent-ref 普通记录（有 extKey）用了 父synthKey —— 那种形状不存在
//   parent-not-found  父引用（extKey 或 synthKey）在包内与树上都存在不了（2.3）
//   parent-cycle      包内父引用成环（2.2），含自引用（长度 1 的环）
//   too-deep          父引用链超过 opts.maxDepth（防病态数据）
//
// **父引用有两种写法，恰好给一个** ——
//   · `父extKey`   父是普通节点（身份是 extKey）
//   · `父synthKey` 父是合成节点（身份是 synthKey）
// 两者都空 = 挂真实根节点；两个都有 = 逐条拒绝（"父引用只能给一个"）。
// 解析发生在**登记完本包的合成标识之后**（见下面第 1/3 步的两趟）——
// 于是"同一个包里先建合成节点、再让另一个合成节点挂到它下面"是合法的，
// 不会在第一阶段被误判成"父找不到"。
//
// 设计依据：docs/auto-import.md 2.2 / 2.3 / 2.4 / 3.3 / 4.4 / 9.2
// ================================================================
import { collectBatchExtKeyConflicts } from '../../core/validate/upsertConflict.js';
import { isValidNodeType } from './constants.js';

/** 父引用链深度上限的默认值（防御病态数据） */
const DEFAULT_MAX_DEPTH = 100;

// 注意：第 1 步只认**包内身份键重复**这一件事。它必须排在一切父引用解析之前 ——
// 重复的 synthKey 会让"父synthKey 指向谁"歧义（哪一条才是父？），
// 歧义一旦被放任，后面就会静默挑一条（那是"会产生错误结果"的静默失效）。

/**
 * extKey 归一化：只 trim，**不解析内容**（3.1）
 * 非字符串一律 String() 后 trim，因此任何输入都不会抛异常。
 */
function normKey(value) {
    if (value === undefined || value === null) return '';
    return String(value).trim();
}

/**
 * 造一个「该 extKey 是否已在树上」的判定函数
 * treeIndex 形如 `{ extKey: nodeId }`（core/ops/upsert.js 的 buildExtKeyIndex 产出）
 * @param {Object} treeIndex
 * @returns {function(string): boolean}
 */
function buildTreeLookup(treeIndex) {
    if (!treeIndex || typeof treeIndex !== 'object' || Array.isArray(treeIndex)) {
        return () => false;
    }
    return key => {
        if (!Object.prototype.hasOwnProperty.call(treeIndex, key)) return false;
        const nodeId = treeIndex[key];
        return nodeId !== undefined && nodeId !== null && nodeId !== '';
    };
}

/**
 * 造一个「该 synthKey 是否已在树上」的判定函数
 *
 * `treeSynth` 是 `core/ops/synth.js` 的 `synthIndex(state).byKey`
 * （`synthKey → nodeId`）。**只读**，不改状态。
 *
 * 为什么要单独一个（不能塞进 buildTreeLookup）：
 *   extKey 与 synthKey 是**两套互不相干的身份**（见 core/ops/synth.js 铁律③），
 *   同名同值也各自算各自的；混成一张表会让 `父extKey` 命中一个合成节点。
 *
 * @param {Map<string,string>|Object} treeSynth
 * @returns {function(string): boolean}
 */
function buildSynthLookup(treeSynth) {
    if (treeSynth instanceof Map) {
        return key => {
            const id = treeSynth.get(key);
            return id !== undefined && id !== null && id !== '';
        };
    }
    if (!treeSynth || typeof treeSynth !== 'object' || Array.isArray(treeSynth)) {
        return () => false;
    }
    return key => {
        if (!Object.prototype.hasOwnProperty.call(treeSynth, key)) return false;
        const id = treeSynth[key];
        return id !== undefined && id !== null && id !== '';
    };
}

/**
 * 一条参与解析的记录在错误信息里怎么称呼自己。
 * 合成节点没有 extKey（身份是 synthKey）—— 只写 extKey 的话错误里会出现空引号，
 * 用户根本不知道说的是哪一条。
 */
function labelOf(item) {
    if (!item) return '（未知记录）';
    if (item.extKey) return `extKey "${item.extKey}"`;
    if (item.synthKey) return `合成标识 "synthKey=${item.synthKey}"`;
    return `第 ${Number(item.index) + 1} 条`;
}

// ---- 极小顶堆：让 Kahn 每次取「当前可用的最小原始下标」入队 ----
// 这样既满足「父先于子」，又让无约束的记录保持输入顺序（稳定）。

function heapPush(heap, value) {
    heap.push(value);
    let i = heap.length - 1;
    while (i > 0) {
        const p = (i - 1) >> 1;
        if (heap[p] <= heap[i]) break;
        const t = heap[p];
        heap[p] = heap[i];
        heap[i] = t;
        i = p;
    }
}

function heapPop(heap) {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0) {
        heap[0] = last;
        let i = 0;
        for (;;) {
            const l = i * 2 + 1;
            const r = l + 1;
            let m = i;
            if (l < heap.length && heap[l] < heap[m]) m = l;
            if (r < heap.length && heap[r] < heap[m]) m = r;
            if (m === i) break;
            const t = heap[m];
            heap[m] = heap[i];
            heap[i] = t;
            i = m;
        }
    }
    return top;
}

/**
 * 把扁平记录排成可应用顺序，并逐条裁定拒绝
 *
 * 记录形状（已由 parse 层归一化，未知多余键视为不透明数据）：
 * ```
 * { type: 'C'|'P'|'R'|'W'|'S'|'O', extKey, parentExtKey, fields, raw }
 * ```
 *
 * @param {Array<Object>} records
 * @param {Object<string,string>} treeIndex - extKey → nodeId，来自 core/ops/upsert.js 的 buildExtKeyIndex(state)
 * @param {Object} [opts]
 * @param {number} [opts.maxDepth] - 防御病态父引用链。默认 100
 * @param {Object|Map} [opts.treeSynth] - `synthKey → nodeId`（`synthIndex(state).byKey`）：
 *        树上已有的合成标识，供 `父synthKey` 解析（缺省 = 树上没有合成节点）
 * @returns {{
 *   ordered: Array<Object>,          // 可以应用的记录，父在子前；浅拷贝，parentExtKey /
 *                                    // parentSynthKey 已归一化（挂根 = ''），
 *                                    // 并附上 `index`（在入参数组里的原始下标，供 plan 层逐条报错/回溯）
 *   rejected: Array<{ index:number, code:string, reason:string }>,  // 按 index 升序
 *   created: string[]                // 将会新建的节点 extKey（树上还不存在的），顺序同 ordered
 * }}
 */
export function resolveOrder(records, treeIndex, opts) {
    // ---- 0. 入参兜底：畸形输入一律返回空结果，绝不抛异常 ----
    if (!Array.isArray(records) || records.length === 0) {
        return { ordered: [], rejected: [], created: [] };
    }
    const options = (opts && typeof opts === 'object') ? opts : {};
    const maxDepth = (Number.isFinite(options.maxDepth) && options.maxDepth > 0)
        ? Math.floor(options.maxDepth)
        : DEFAULT_MAX_DEPTH;
    const hasTreeKey = buildTreeLookup(treeIndex);
    const hasTreeSynth = buildSynthLookup(options.treeSynth);

    /** 原始下标 → { code, reason } */
    const rejected = new Map();

    // ---- 1a. 包内 extKey 重复：参与的每一条都拒绝（3.2 / 4.7）----
    // 包内自相矛盾必须先于一切其它判定——否则「先到的被后到的覆盖」是静默的。
    for (const conflict of collectBatchExtKeyConflicts(records)) {
        const key = normKey(conflict.extKey);
        const indexes = Array.isArray(conflict.indexes) ? conflict.indexes : [];
        for (const i of indexes) {
            const others = indexes.filter(x => x !== i).map(x => x + 1).join('、');
            rejected.set(i, {
                code: 'duplicate-extkey',
                reason: `extKey "${key}" 在包内重复出现（与第 ${others} 条相同），无法确定身份（3.2）`
            });
        }
    }

    // ---- 1b. 包内 synthKey 重复：同样每条都拒绝（与 extKey 同一口径）----
    // 为什么必须在**父引用解析之前**：`父synthKey` 指向谁会有歧义。
    // 这里与 plan.js 的 planSynthNodes 判据相同（那边也报一次，是同一套口径的两道闸门：
    // 这一道保证**父引用**看得准，那一道保证**建节点**看得准）。
    const synthDup = new Map();
    for (let i = 0; i < records.length; i++) {
        if (rejected.has(i)) continue;
        const rec = records[i];
        if (!rec || typeof rec !== 'object' || Array.isArray(rec)) continue;
        if (normKey(rec.extKey)) continue;               // 有 extKey 的不是合成节点
        const key = normKey(rec.synthKey);
        if (!key) continue;
        if (!synthDup.has(key)) synthDup.set(key, []);
        synthDup.get(key).push(i);
    }
    for (const [key, indexes] of synthDup) {
        if (indexes.length < 2) continue;
        for (const i of indexes) {
            const others = indexes.filter(x => x !== i).map(x => x + 1).join('、');
            rejected.set(i, {
                code: 'duplicate-synthkey',
                reason: `synthKey "${key}" 在包内重复出现（与第 ${others} 条相同），`
                    + '无法确定是哪条节点、也无法确定父引用指向谁，全部拒绝（与 extKey 重复同一口径）'
            });
        }
    }

    // ---- 2. 逐条身份校验（3.1 / 4.4）----
    /** 通过身份校验、参与父引用解析的记录 */
    const items = [];   // { index, extKey, synthKey, type, parentKind, parentKey, record }
    for (let i = 0; i < records.length; i++) {
        if (rejected.has(i)) continue;
        const rec = records[i];
        if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
            rejected.set(i, {
                code: 'missing-extkey',
                reason: '记录不是对象，没有可用的 extKey（4.4）'
            });
            continue;
        }
        const extKey = normKey(rec.extKey);
        // 合成：合成节点**没有 extKey**（身份是 `synthKey`）。
        // 它照样是一条可应用的记录（要挂到父容器下、要建出来），只是**不能当 extKey 父**——
        // 因为 `父extKey` 按 extKey 解析，而它没有 extKey（成员关系是指针，不是父子）。
        const synthKey = normKey(rec.synthKey);
        if (!extKey && !synthKey) {
            rejected.set(i, {
                code: 'missing-extkey',
                reason: 'extKey 缺失或 trim 后为空，也没有 synthKey（合成节点身份），该条没有身份，拒绝导入（4.4）'
            });
            continue;
        }
        const rawType = (rec.type === undefined || rec.type === null)
            ? ''
            : String(rec.type).trim();
        if (!isValidNodeType(rawType)) {
            rejected.set(i, {
                code: 'bad-type',
                reason: `节点类型 "${rawType}" 不在 O/W/S/C/P/R 之列（2.1）`
            });
            continue;
        }

        // ---- 父引用：两种写法**恰好给一个**（都不给 = 挂根）----
        const parentExtKey = normKey(rec.parentExtKey);
        const parentSynthKey = normKey(rec.parentSynthKey);
        if (parentExtKey && parentSynthKey) {
            rejected.set(i, {
                code: 'parent-both',
                reason: `父引用只能给一个：本条同时给了 父extKey="${parentExtKey}" 与 `
                    + `父synthKey="${parentSynthKey}"，父到底是谁说不清（父是普通节点用 父extKey，`
                    + '父是合成节点用 父synthKey），该条不导入（2.3）'
            });
            continue;
        }
        // `父synthKey` 只对合成节点有意义：普通记录（有 extKey）进合成节点的名单用的是
        // **成员指针 `ownerSynth`**，不是父子（core/ops/synth.js 铁律①：名单不是嵌套）。
        // 这条形状在包格式里不存在 ⇒ 逐条拒绝，别猜用户想表达"父子"还是"归入"。
        if (parentSynthKey && extKey) {
            rejected.set(i, {
                code: 'unsupported-parent-ref',
                reason: `普通记录（extKey "${extKey}"）不能用 父synthKey="${parentSynthKey}"：`
                    + '合成节点不是它的父容器 —— 要么改用 父extKey 指出真正的父容器，'
                    + '要么用「所属合成节点 / ownerSynth」把它归入那个合成节点的名单'
            });
            continue;
        }

        items.push({
            index: i,
            extKey,
            synthKey,
            type: rawType,
            parentKind: parentSynthKey ? 'synth' : (parentExtKey ? 'ext' : ''),
            parentKey: parentSynthKey || parentExtKey,
            record: rec
        });
    }

    // ---- 3. 包内身份表（重复项已在第 1 步整体剔除，故唯一）----
    // extKey 表：**合成节点记录（无 extKey）不入表** —— 空串入表会让所有合成节点互相覆盖。
    // synthKey 表：**普通记录（有 extKey）不入表** —— 它没有 synthKey，同理。
    const byExtKey = new Map();
    const bySynthKey = new Map();
    for (let k = 0; k < items.length; k++) {
        if (items[k].extKey) byExtKey.set(items[k].extKey, k);
        else if (items[k].synthKey) bySynthKey.set(items[k].synthKey, k);
    }

    // ---- 4. 父引用解析（2.2 / 2.3 / 3.3）----
    const parentIdx = new Array(items.length).fill(-1);   // -1 = 无包内父（挂根 / 挂树上）
    const childrenOf = [];
    for (let k = 0; k < items.length; k++) childrenOf.push([]);
    /** items 下标 → { code, reason }：不可应用的记录 */
    const bad = new Map();

    for (let k = 0; k < items.length; k++) {
        const it = items[k];
        if (it.parentKind === '') {
            // 3.3：两种父引用都留空 / 省略 ⇒ 挂真实根节点，**这不是错误**
            continue;
        }
        // 先看**本包**（这一趟已经在第 1/2 步登记完所有身份键 —— 父可以是
        // 同一次导入里新建的另一个合成节点，两阶段时序的要求）
        const inCrateIdx = it.parentKind === 'synth'
            ? bySynthKey.get(it.parentKey)
            : byExtKey.get(it.parentKey);
        if (inCrateIdx !== undefined) {
            // 父在包内：可能同批创建 ⇒ 形成排序约束（自引用也走这里，留给第 5 步判环）
            parentIdx[k] = inCrateIdx;
            childrenOf[inCrateIdx].push(k);
            continue;
        }
        // 再看**树上**
        const onTree = it.parentKind === 'synth'
            ? hasTreeSynth(it.parentKey)
            : hasTreeKey(it.parentKey);
        if (onTree) continue;   // 父已在树上：直接复用，无排序约束

        // 两边都没有 → 逐条拒绝（2.3），**绝不静默挂根**；错误信息必须可直接行动
        const col = it.parentKind === 'synth' ? '父synthKey' : '父extKey';
        const what = it.parentKind === 'synth' ? '合成标识' : 'extKey';
        rejected.set(it.index, {
            code: 'parent-not-found',
            reason: `父节点不存在：${col} = "${it.parentKey}"。`
                + `包内没有该 ${what} 的记录，树上也没有该 ${what} 的节点。`
                + `处理：先导入父容器${it.parentKind === 'synth' ? '（或先在树上建好那个合成节点）' : ''}，`
                + '或让爬虫在本包里补一条该父的记录（2.3）'
        });
        bad.set(k, { code: 'parent-not-found', reason: '' });
    }

    // ---- 5. 环检测：包内父引用成环 → 环上每条都拒绝（2.2）----
    // 每条至多一个父，是「函数式图」，沿父指针走一遍即可 O(n) 找出全部环。
    const color = new Uint8Array(items.length);   // 0 未访问 / 1 在本次链上 / 2 已完成
    for (let start = 0; start < items.length; start++) {
        if (color[start] !== 0) continue;
        const path = [];
        let cur = start;
        while (cur !== -1 && color[cur] === 0) {
            color[cur] = 1;
            path.push(cur);
            cur = parentIdx[cur];
        }
        if (cur !== -1 && color[cur] === 1) {
            // cur 落在本次链上 ⇒ path 从 cur 起的一段就是环
            const at = path.indexOf(cur);
            for (let t = at; t < path.length; t++) {
                bad.set(path[t], {
                    code: 'parent-cycle',
                    reason: `包内父引用成环：${labelOf(items[path[t]])} 的父引用链回到自身（2.2）`
                });
            }
        }
        for (const node of path) color[node] = 2;
    }

    // ---- 6. 坏记录向下游传播：父挂不上，子必然也挂不上 → 同样逐条拒绝 ----
    const queue = [];
    for (const k of bad.keys()) queue.push(k);
    for (let qi = 0; qi < queue.length; qi++) {
        const k = queue[qi];
        const cause = bad.get(k);
        for (const child of childrenOf[k]) {
            if (bad.has(child)) continue;
            const col = items[k].extKey ? '父extKey' : '父synthKey';
            const parentKey = items[k].extKey || items[k].synthKey;
            bad.set(child, {
                code: cause.code,
                reason: cause.code === 'parent-cycle'
                    ? `父引用链上游成环，无法挂接：${col} = "${parentKey}"（2.2）`
                    : `父节点记录已被拒绝，无法挂接：${col} = "${parentKey}"（2.3）`
            });
            queue.push(child);
        }
    }
    for (const [k, info] of bad) {
        const originalIndex = items[k].index;
        if (!rejected.has(originalIndex)) {
            rejected.set(originalIndex, { code: info.code, reason: info.reason });
        }
    }

    // ---- 7. 幸存记录的拓扑排序：父先于子；无约束者保持输入顺序 ----
    // Kahn：只把「包内父」当边；挂根 / 挂树上的记录入度为 0。
    const alive = new Array(items.length).fill(false);
    for (let k = 0; k < items.length; k++) alive[k] = !bad.has(k);

    const indeg = new Array(items.length).fill(0);
    const heap = [];
    for (let k = 0; k < items.length; k++) {
        if (!alive[k]) continue;
        indeg[k] = (parentIdx[k] === -1) ? 0 : 1;
        if (indeg[k] === 0) heapPush(heap, k);
    }

    const topo = [];
    while (heap.length > 0) {
        const k = heapPop(heap);
        topo.push(k);
        for (const child of childrenOf[k]) {
            if (!alive[child]) continue;
            indeg[child] -= 1;
            if (indeg[child] === 0) heapPush(heap, child);
        }
    }

    // ---- 8. 深度守卫：父引用链过长 → 拒绝（防病态数据）----
    // ⚠️ **不能靠 topo 顺序算深度**：合成节点记录（无 extKey）本来就**不进** `ordered`
    //    （它走 plan.js 的两阶段通道），可它照样是别人的父 ⇒ 它的深度没被算出来的话，
    //    "挂在合成节点下的整条链"就会整批漏算。所以**沿父指针逐条走**：
    //    父一定先被算过（记忆化 + 显式栈，深链不爆栈）。**成环的那些不用管**：
    //    第 5 步已把它们标进 `bad`（第 7 步的 `alive` 读的就是它），
    //    它们既是起点也是终点（`depth[k] = 1`，不再沿父指针往上走）——
    //    所以这里不会死循环。
    const depth = new Array(items.length).fill(0);
    const tooDeep = new Set();
    for (let k = 0; k < items.length; k++) {
        if (depth[k] !== 0) continue;
        if (!alive[k]) { depth[k] = 1; continue; }   // 坏记录：终点，不再上溯
        const path = [];
        let cur = k;
        while (cur !== -1 && alive[cur] && depth[cur] === 0) {
            path.push(cur);
            cur = parentIdx[cur];
        }
        let d = (cur === -1 || !alive[cur]) ? 1 : depth[cur];
        for (let t = path.length - 1; t >= 0; t--) {
            d += 1;
            depth[path[t]] = d;
            if (d <= maxDepth) continue;
            tooDeep.add(path[t]);
            rejected.set(items[path[t]].index, {
                code: 'too-deep',
                reason: `父引用链深度 ${d} 超过上限 ${maxDepth}，疑似数据异常，拒绝该条`
            });
        }
    }

    // ---- 9. 组装结果 ----
    const ordered = [];
    const created = [];
    for (const k of topo) {
        if (tooDeep.has(k)) continue;
        const it = items[k];
        // 浅拷贝：保留 raw / fields 等不透明数据，只把身份字段归一化后交给下游；
        // `index` 是原始下标，plan 层用它把结果对回入参记录（逐条报错，9.2）
        ordered.push({
            ...it.record,
            index: it.index,
            extKey: it.extKey,
            parentExtKey: it.parentKind === 'ext' ? it.parentKey : '',
            // 父引用的另一种写法 —— 归一化后交给 plan/synthApply 解析成父节点 id
            parentSynthKey: it.parentKind === 'synth' ? it.parentKey : ''
        });
        if (it.extKey && !hasTreeKey(it.extKey)) created.push(it.extKey);
    }

    // ---- 9b. 兜底：进了 items 却既没进 topo、也没被标坏的记录 ----
    // 正常数据到不了这里（topo 装的是全部活着且不超深的记录）。真到了这里就是
    // **本模块自己的漏洞** —— 宁可逐条拒绝（可见），也绝不静默丢记录（不可见）。
    const inTopo = new Set(topo);
    for (let k = 0; k < items.length; k++) {
        if (inTopo.has(k) || bad.has(k) || tooDeep.has(k)) continue;
        if (rejected.has(items[k].index)) continue;
        rejected.set(items[k].index, {
            code: 'internal-drop',
            reason: '这条记录没有进入可应用清单（父引用图不完整）；为免静默丢失，按拒绝处理'
        });
    }

    const rejectedList = [];
    for (const [index, info] of rejected) {
        rejectedList.push({ index, code: info.code, reason: info.reason });
    }
    rejectedList.sort((a, b) => a.index - b.index);

    return { ordered, rejected: rejectedList, created };
}
