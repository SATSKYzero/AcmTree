// ================================================================
// 同层排序：**越新的越靠上**（core/siblingOrder.js）
//
// 口径：
//   "各处的同层节点时间顺序混乱 越新的越靠上为宜（顺序总是在补充节点时被破坏?）"
//
// —— 顺序本来就是"插入序"（`upsert` 新节点一律 `childOrder.push`），
//    所以每补一场比赛它都落在最后。**唯一能长期成立的做法**是"由数据算顺序"，
//    而不是"按抓到/导入的先后"。
//
// 这个模块就是那条规则的**唯一一份实现**，两处共用：
//   · 产包侧 `scripts/crate-merge.mjs`（合并完把记录按"父在前、子按规则"重排 ⇒ 包本身就是有序的）
//   · 应用侧 `features/AutoImport/apply.js`（**增量导入**后重排受影响的容器 ⇒ 老树也被治好）
// ⚠️ Python 侧不再另写一份：两个消费者都在 JS（crate-merge 是 .mjs、应用是 src/），
//    所以"跨语言同步"这件事不存在 —— 只有这一份。
//
// 规则（**只排"同类兄弟"**，别的一律保持原样 —— 手建顺序、非同类混排都别动）：
//   · 全是 C（比赛）：开赛时间**倒序**（没有时间的垫底）→ `natureYear` 倒序 → 名字 → id
//   · 全是 R（提交）：提交时间**倒序** → id
//   · 全是"年份层 S"（名字是 `20xx` / `年份未知`）：年份倒序（`年份未知` 垫底）→ id
//   · 全是 P（题目）：**题号升序**（"题号怎么是乱的"）
//   · 其它（含 W / O、混合类型）：**原样不动**
//
// 为什么 C 用"时间字符串去掉非数字再比"：包里的时间有两种写法
// （`2026.09.26 22:35` 与 `2024-05-01 10:00:00`），直接比字符串会被分隔符坑。
// ================================================================

import { isRealYear } from './natureFields.js';

/** 时间 → 纯数字串（`2026.09.26 22:35` → `202609262235`）；空/认不出 → `''` */
export function timeKey(value) {
    const digits = String(value === undefined || value === null ? '' : value).replace(/[^0-9]/g, '');
    return digits;
}

/** `natureYear` → 数值（`20xx`；`无`/`待同步`/空等特殊值 → -1） */
export function yearKey(value) {
    // "是不是真年份"只问唯一入口（`isRealYear`）—— 别自己再写一遍正则：
    // 那条判据散在多处时，连"带空格的年份"都会给出不同答案（实测）。
    const t = String(value === undefined || value === null ? '' : value).trim();
    return isRealYear(t) ? Number(t) : -1;
}

/** 这个 "年份层" 的名字/键是不是年份层（`2026` / `年份未知`） */
export function isYearLayer(text) {
    const t = String(text === undefined || text === null ? '' : text).trim();
    // ⚠️ 年份判据**与 `yearKey` / `layerYear` / 应用侧 `natureFields.isRealYear` 同一口径**：
    //    只认 `20xx`。单独写成 `(19|20)\d{2}` 的话，同一个文件里 19xx 一会儿是"年份层"
    //    （排序用）、一会儿不是（`yearKey` 给 -1、`layerYear` 认不出）。
    return yearKey(t) >= 0 || t === '年份未知';
}

/** 年份层名 → 年（`年份未知` / 认不出 → -1）—— 与 `yearKey` 同一口径（只认 `20xx`） */
function layerYear(text) {
    return yearKey(text);
}

// ================================================================
// 两种"位置固定"的层：
//   · **热身赛**层放在同一层的**最后**（"热身赛系列放赛季的最后"）；
//   · **Finals** 层放在同一层的**最前**（"Finals 在 Europe 系列的顶部"）。
// 判据按**键尾**（`:warm-up` / `:finals`）与**层名**两条都认 —— 键是树上的身份，
// 名字是给人看的，两个都在说明这一层是什么。
// ================================================================
export function isWarmupLayer(n) {
    if (!n || (n.type || '') !== 'S') return false;
    return String(n.name || '').trim() === '热身赛' || /:warm-up$/.test(String(n.id || ''));
}

export function isFinalsLayer(n) {
    if (!n || (n.type || '') !== 'S') return false;
    return String(n.name || '').trim() === 'Finals' || /:finals$/.test(String(n.id || ''));
}

const zh = (a, b) => String(a || '').localeCompare(String(b || ''), 'zh-Hans-CN');

/** `problemId` → 比较用的键（trim；空 = 没填，认不出身份） */
export function problemIdKey(value) {
    return String(value === undefined || value === null ? '' : value).trim();
}

/**
 * 两个**题号**的先后（`<0` = a 在前）：**自然序**升序。
 *
 * · 字母题号：就是字母序（`A` < `B` < … < `Z`；题号不会到 27 题，`AA` 排哪儿无所谓）；
 * · 数字题号（有些平台是 `1`/`2`/…）：按**数值**比（`9` < `10`，不是字符串序）；
 * · 空题号：**垫底**（没填 = 认不出身份，不该挤在最前面）。
 *
 * ⚠️ 为什么要这条规则（"题号怎么是乱的"）：题目的顺序一直沿用
 *    **包里的记录顺序**，而那是各来源自己的排列（实测 `2026 北京市赛` 出来是
 *    `D K J F E L B H C I G A`）。题号是题目的身份，就该按它排 —— 与比赛按开赛时间、
 *    提交按提交时间**同一个道理**（`siblingOrder` 就是"同层顺序由数据算出来"的唯一一份实现）。
 */
export function compareProblemId(a, b) {
    const x = problemIdKey(a);
    const y = problemIdKey(b);
    if (!x || !y) return x === y ? 0 : (x ? -1 : 1);      // 空的垫底
    return x.localeCompare(y, undefined, { numeric: true }) || 0;
}

/**
 * 同一父下两个**同类**节点的先后（`<0` = a 在前）。
 * @param {Object} a - 节点
 * @param {Object} b - 节点
 */
export function compareSiblings(a, b) {
    // 两种"位置固定"的层先在前面判掉（与类型无关）：Finals 置顶、热身赛垫底
    const af = isFinalsLayer(a);
    const bf = isFinalsLayer(b);
    if (af !== bf) return af ? -1 : 1;
    const aw = isWarmupLayer(a);
    const bw = isWarmupLayer(b);
    if (aw !== bw) return aw ? 1 : -1;
    const type = (a && a.type) || '';
    if (type === 'C') {
        const ta = timeKey(a.contestTime || a.time);
        const tb = timeKey(b.contestTime || b.time);
        if (ta !== tb) return tb.localeCompare(ta);              // 时间倒序（没有时间的垫底）
        const ya = yearKey(a.natureYear);
        const yb = yearKey(b.natureYear);
        if (ya !== yb) return yb - ya;                            // 年份倒序
        return zh(a.name, b.name) || String(a.id).localeCompare(String(b.id));
    }
    if (type === 'R') {
        const ta = timeKey(a.time);
        const tb = timeKey(b.time);
        if (ta !== tb) return tb.localeCompare(ta);
        return String(a.id).localeCompare(String(b.id));
    }
    if (type === 'P') {
        // 题目：**题号升序**（"题号怎么是乱的"）—— 题号是题目的身份，
        // 与"比赛按开赛时间、提交按提交时间"同一个道理。打平由 `orderedIds` 用原顺序兜底。
        return compareProblemId(a.problemId, b.problemId);
    }
    if (type === 'S') {
        // ⚠️ 只有**年份层**才按年排；`cat-*` / `Central Europe` 这种来源自带的层之间**没有先后**
        //    ⇒ 返回 0（由调用方的"原顺序"兜底）—— 否则 `Finals` 置顶时会把其余兄弟按 id 重排
        const ay = layerYear(a.name) >= 0 ? layerYear(a.name) : layerYear(String(a.id || '').split(':').pop());
        const by = layerYear(b.name) >= 0 ? layerYear(b.name) : layerYear(String(b.id || '').split(':').pop());
        if (ay < 0 && by < 0) return 0;
        return by - ay;                                           // 年倒序（`年份未知` 垫底）
    }
    return 0;
}

/**
 * 这一组兄弟**该不该排**：只有"同类且规则明确"的才排。
 * @param {Array<Object>} nodes - 兄弟节点（按当前顺序）
 */
export function shouldOrder(nodes = []) {
    if (nodes.length < 2) return false;
    const types = new Set(nodes.map((n) => (n && n.type) || ''));
    if (types.size === 1) {
        const type = [...types][0];
        if (type === 'C' || type === 'R' || type === 'P') return true;
        if (type === 'S') {
            // 全是年份层就排；或者里面有 `Finals` 层（它要置顶，别的保持原顺序）
            return nodes.every((n) => isYearLayer(n && n.name) || isYearLayer(String((n && n.id) || '').split(':').pop()))
                || nodes.some(isFinalsLayer);
        }
        return false;                                             // W / O：原样（手建顺序）
    }
    // **混着"比赛 + 固定位层"**的组也要排 —— 父亲底下既有几场比赛、又有「热身赛」层
    // （或「Finals」层）时：比赛按时间倒序，`Finals` 置顶、热身赛垫底。
    const fixed = (n) => isWarmupLayer(n) || isFinalsLayer(n);
    if (nodes.some(fixed)) {
        const rest = nodes.filter((n) => !fixed(n));
        return rest.length > 0 && rest.every((n) => (n && n.type) === 'C');
    }
    return false;
}

/**
 * 按规则排好一组兄弟（不改原数组）。
 * @param {Array<Object>} nodes
 * @returns {{order: string[], changed: boolean}}
 */
export function orderedIds(nodes = []) {
    const ids = nodes.map((n) => n.id);
    if (!shouldOrder(nodes)) return { order: ids, changed: false };
    // ⚠️ 打平时用**原顺序**当兜底（不是 id）："比赛 + 固定位层"这种混合组也会进排序，
    //    那些不参与规则的兄弟（比如赛区底下的几个子系列层）必须保持原样，只让 Finals 走到最前。
    const orig = new Map(nodes.map((n, i) => [n.id, i]));
    const sorted = [...nodes].sort((a, b) => compareSiblings(a, b) || (orig.get(a.id) - orig.get(b.id)));
    const order = sorted.map((n) => n.id);
    return { order, changed: order.join('\u0000') !== ids.join('\u0000') };
}

/**
 * **就地**重排 draft 里所有该排的容器（每个父一次）。
 *
 * @param {Object} draft - `{ nodes, childOrder }`
 * @returns {{parents: number, moved: number}} 处理了几个容器、几个真的动了
 */
export function orderChildren(draft) {
    const out = { parents: 0, moved: 0 };
    if (!draft || !draft.nodes || !draft.childOrder) return out;
    for (const parentId of Object.keys(draft.childOrder)) {
        const ids = draft.childOrder[parentId];
        if (!Array.isArray(ids) || ids.length < 2) continue;
        // ★ **人排过的容器，导入不许重排**（`manualOrder`：手排 = `handlers/H3_sort.js` 的
        //   题目/提交排序、`core/ops/tree.js` 的上移/下移；见 `elements.js` 的字段注释）。
        //   没有这一句，手动排出来的顺序**下一次导入就被规范序冲掉**。
        const parent = draft.nodes[parentId];
        if (parent && parent.manualOrder) continue;
        const nodes = ids.map((id) => draft.nodes[id]).filter(Boolean);
        if (nodes.length < 2) continue;
        const { order, changed } = orderedIds(nodes);
        out.parents++;
        if (!changed) continue;
        // ⚠️ 只重排**认得的**那些节点；万一有 id 在 nodes 里查不到，不能把它弄丢
        const missing = ids.filter((id) => !draft.nodes[id]);
        draft.childOrder[parentId] = order.concat(missing);
        out.moved++;
    }
    return out;
}

/**
 * 把一份**平铺的记录表**排成"父在前、子按规则"的顺序（产包侧用）。
 *
 * 父不在本包里的记录（类包是子集）留在**最后**，相对顺序不变 —— 不猜、不丢。
 *
 * ⚠️ 这里**必须**允许调用方给一个 `nodeOf`（实测的坑）：产包侧传进来的是
 *    **条目**（`{record, file, fieldSrc}`），`节点类型` 与 `contestTime` 既不在条目顶层、
 *    也不在 `record` 顶层（业务字段全在 `record.fields` 里，键是内部字段名）。
 *    没有 `nodeOf` 时 `type` 读到空串 ⇒ `shouldOrder` 对所有组都返回 false ⇒
 *    **整个重排静默失效**（包看着"产出来了"，可顺序一个都没动）。
 *
 * @param {Array<Object>} records - 记录（每条要能被 `keyOf` 认出身份、被 `parentOf` 认出父）
 * @param {{keyOf:Function, parentOf:Function, nodeOf:Function}} io
 *        `nodeOf` 可选：把一条记录变成规则认得的节点形状（`{type,name,contestTime,time,natureYear}`）；
 *        不给就当"记录本身就是那个形状"。
 * @returns {Array<Object>} 新数组
 */
export function treeOrder(records = [], io = {}) {
    const keyOf = io.keyOf || ((r) => r.extKey || '');
    const parentOf = io.parentOf || ((r) => r.parentExtKey || '');
    // 默认形状 = **crate 记录**：类型列叫 `节点类型`，业务字段摊在顶层（应用侧/老测试就是这种）
    const shapeOf = io.nodeOf || ((r) => ({ type: r['节点类型'] || r.type, name: r.name,
        contestTime: r.contestTime, time: r.time, natureYear: r.natureYear }));
    const byKey = new Map();
    const order = new Map();                       // 父 → 孩子（原顺序）
    for (const r of records) {
        const k = keyOf(r);
        if (k) byKey.set(k, r);
        const p = parentOf(r);
        if (!order.has(p)) order.set(p, []);
        order.get(p).push(r);
    }
    const out = [];
    const seen = new Set();
    const walk = (parentKey) => {
        const kids = order.get(parentKey) || [];
        // id 一律用 `keyOf`（不采信 `shapeOf` 自己给的 id）：排序结果要能按同一个身份键对回去
        const { order: ids } = orderedIds(kids.map((r) => ({ ...shapeOf(r), id: keyOf(r) })));
        const rank = new Map(ids.map((id, i) => [id, i]));
        const sortedKids = [...kids].sort((a, b) => (rank.get(keyOf(a)) ?? 0) - (rank.get(keyOf(b)) ?? 0));
        for (const r of sortedKids) {
            const k = keyOf(r);
            if (!k || seen.has(k)) continue;
            seen.add(k);
            out.push(r);
            walk(k);
        }
    };
    // 根：父不在本包里的那些（含父为空串的）
    const roots = records.filter((r) => !byKey.has(parentOf(r)));
    for (const r of roots) {
        const k = keyOf(r);
        if (!k || seen.has(k)) continue;
        seen.add(k);
        out.push(r);
        walk(k);
    }
    // 剩下的（成环 / 认不出身份）按原顺序补在最后
    for (const r of records) {
        const k = keyOf(r);
        if (k && seen.has(k)) continue;
        if (k) seen.add(k);
        out.push(r);
    }
    return out;
}
