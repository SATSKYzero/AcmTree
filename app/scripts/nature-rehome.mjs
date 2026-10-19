// ================================================================
// 按 nature 把「渠道没给分类」的节点搬到位（scripts/nature-rehome.mjs）
//
// 「渠道没给分类」的节点该放哪：
//   问：QOJ 那种"没挂分类"的兜底桶里的场次该放哪？
//   答：**"仅针对各渠道分类本就不充分的节点,若有足够的nature,直接改变其在树中的路径"**
//       + "跟同 class 的邻居走，认不出再按 nature 类路径铺"
//       + "这个机制暂时只对 nature 属于 (?/)xcpc 的生效"
//
// 为什么是**独立一步**、而且**排在产包之后**：
//   · 这些场次的 nature 是**人在应用里手填的**（`qoj:c:3658` 的 class 来源就是 `manual`），
//     它回到包里靠的是 `xcpc_pipeline` 末尾那步「回代 baseline」⇒ 在适配器里根本看不到
//     （那时这一场的 class 还是 `qoj/无归类`）。所以只能在这之后做。
//   · 产包那一步（`crate-merge`）已经排过同层顺序了，这里搬完**必须重排**
//     ⇒ 直接 import 应用侧那一份 `core/siblingOrder.js`（顺序规则只有一份实现）。
//
// 落点怎么算（**由数据推导**，不新增命名体系）：
//   ① 先建索引：`(树根, natureClass)` → 该 class 的场次**现在都挂在哪些容器**（去掉年份层）
//      ＋ 每个容器里出现过的「地区」计数；
//   ② 只有一个容器 ⇒ 就去那儿；
//   ③ 有多个 ⇒ 用**这一场自己的地区**去认（`浙江` ⇒ 那个容器里已有 9 场是浙江）；
//   ④ 一个都对不上 ⇒ 退到**按 nature 类路径铺**（`qoj/xcpc/ccpc/final/official`
//      ⇒ `qoj:s:xcpc:ccpc:final:official`）＋年份层 —— 这段是"脚本自己推导"的兜底；
//      ★ 无邻居参考时**分类 + 赛季**就够定位 ⇒ 年份层取**赛季**
//      （赛季才是"哪一届"；举办年份会跨年、总决赛还常是 `待同步`）；
//   ⑤ 两样都不行（比如同 class 一处落点都没有、class 又只有一段）⇒ **留在原地**（不猜）。
//
// ⚠️ 三条边界：
//   · **只搬"兜底桶"里的**（层名 `（QOJ 上没挂分类）` / `无归类` / `无分类` / `其他`）；
//   · **只搬 nature 够的**（class 有值、且不是 `无归类` 那一类"判过了但归不进去"）；
//   · **只对 `(?/)xcpc` 这一支生效**（"暂时只对…生效"）——
//     `cf/contest/…`、`atcoder/…`、`nk/多校`… 一律不动。
//
// 空掉的兜底桶**顺手收掉**（`qoj:s:no-category` 本来就只在"有人落进来"时才建）。
//
// 用法：
//   node scripts/nature-rehome.mjs <包>                  # 就地改（链子里就是这么跑的）
//   node scripts/nature-rehome.mjs [--package <包>] [--dry-run] [--quiet]
// ================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mod = rel => `file://${path.join(ROOT, 'src', rel).replace(/\\/g, '/')}`;
const DEFAULT_PACKAGE = path.join(ROOT, 'acm-data', 'nodes', 'all_nodes.json');

const { treeOrder } = await import(mod('core/siblingOrder.js'));
// ⚠️ "是不是真年份"的口径**只有一处**：应用侧 `core/natureFields.js` 的 `isRealYear`
//    （`^20\d{2}$`）。年份判据只用这一份 —— 自写的 `^(19|20)\d{2}$` 会把 19xx 算成年份，
//    而应用侧**不算**（同一格两套判法 ⇒ 层名/推荐会分叉）。
const { isRealYear: isRealYearShared } = await import(mod('core/natureFields.js'));
// ⚠️ "哪一段是镜像前缀"的口径也只有一处：应用侧 `core/synthPlan.js` 的 `bareClass`
//    （`qoj/xcpc/…` / `cf/gyms/xcpc/…` → `xcpc/…`）。若自写一份"分类里含
//    `xcpc` 段且它不在最后"的判据 —— 两套判法一旦分叉，同样的分类会有两种归宿
//    ⇒ `classIsXcpc` 问 `bareClass`。
const { bareClass } = await import(mod('core/synthPlan.js'));

// ================================================================
// 判据（都是纯函数：自测直接 import 它们）
// ================================================================

/** 兜底桶的层名：渠道自己没给出分类时，那一层就叫这些 */
export const FALLBACK_NAMES = ['（QOJ 上没挂分类）', '无归类', '无分类', '其他'];

/** ★ **年份层的兜底名** —— `yearLabel()` 只在"不是真年份"时产出它（名字的唯一定义处） */
export const YEAR_UNKNOWN_LAYER = '年份未知';

/** 「判过了、但归不进去」的写法（有值 ≠ 够用） */
const NOT_ENOUGH = /无归类|无分类|无标注|待定/;

/** 这一层是不是兜底桶 */
export function isFallbackLayer(name) {
    return FALLBACK_NAMES.includes(String(name === undefined || name === null ? '' : name).trim());
}

/**
 * 这一层是不是**年份层的兜底桶**（`年份未知`）？
 *
 * ⚠️ 它**必须也当成"兜底桶"**（实测踩到，用户 2026-10-08 报"年份未知里有大量已填年份的节点"）：
 *    以前只有分类层的兜底名算兜底 ⇒ 一个节点**第一次**被放进 `年份未知`（那时年份还没定）
 *    之后，**年份补上了也不会被搬走** —— 就一直躺在 `年份未知` 里（真包里 17 个）。
 */
export function isYearFallbackLayer(name) {
    return String(name === undefined || name === null ? '' : name).trim() === YEAR_UNKNOWN_LAYER;
}

/** 兜底桶（分类层 / 年份层）—— "该不该被重新落位"的**唯一判据** */
export function isFallbackBucket(name) {
    return isFallbackLayer(name) || isYearFallbackLayer(name);
}

/** 分类路径 → 段（`qoj/xcpc/ccpc` → `['qoj','xcpc','ccpc']`） */
export function classSegments(cls) {
    return String(cls === undefined || cls === null ? '' : cls).split('/').map(s => s.trim()).filter(Boolean);
}

/**
 * 这条 nature 是不是 `(?/)xcpc` 那一支。
 * 适用范围："这个机制暂时只对 nature 属于 (?/)xcpc 的生效" ——
 * `xcpc/…`、`qoj/xcpc/…`、`cf/gyms/xcpc/…` 都算（前面有多少段平台/镜像前缀都行）；
 * ⚠️ 看**段**而不是子串：`cf/xcpc-ish/…` 这种不算，`nk/多校` 也不算。
 *
 * 判据用**唯一的那份 `bareClass`** 去掉镜像前缀，再看剩下的是不是 `xcpc/…`（不自己数段）。
 * 自写数段的判法对 `foo/xcpc/bar` 这种**非镜像前缀**的路径会给出同一个答案、
 * 但对"什么算镜像前缀"的定义不同 ⇒ 早晚分叉。
 */
export function classIsXcpc(cls) {
    return bareClass(cls).startsWith('xcpc/');
}

/** nature「够不够」（有值、且不是"归不进去"那一类） */
export function enoughClass(cls) {
    const t = String(cls === undefined || cls === null ? '' : cls).trim();
    return !!t && !NOT_ENOUGH.test(t) && classIsXcpc(t);
}

/** 去掉末尾的年份层（`…:2026` / `…:年份未知`）⇒ 容器键 */
export function stripYearLayer(key) {
    const text = String(key || '');
    // ⚠️ **必须要求前面有冒号**：若按 `/:…$/` 锚定，`'2024'` / `'年份未知'` 这种
    //    **整个键就是一层**的输入会被剥成空串（层键本身不该被剥）。
    const at = text.lastIndexOf(':');
    if (at < 0) return text;
    const last = text.slice(at + 1);
    // ⚠️ 年份判据用**同一个** `isRealYear`（别再写 `(19|20)` 那种正则）：
    //    `yearLabel` 从不产出 19xx，这里也只认它产得出的东西。
    if (last === YEAR_UNKNOWN_LAYER || isRealYear(last)) return text.slice(0, at);
    return text;
}

/**
 * 是不是真的年份（`20xx`）—— **应用侧同一个函数**（`core/natureFields.js` 的 `isRealYear`）。
 * `待同步` / `无` / 空 / 19xx 都不算。
 */
export function isRealYear(year) {
    return isRealYearShared(year);
}

/** 年份 → 年份层的层名（与 `xcpc_common.year_mid` 同一口径） */
export function yearLabel(year) {
    const t = String(year === undefined || year === null ? '' : year).trim();
    return isRealYear(t) ? t : YEAR_UNKNOWN_LAYER;
}

/**
 * 年份层的层名，**取赛季**：赛季才是"哪一届"（举办年份可能跨年、总决赛还常是 `待同步`）。
 * 赛季不是真年份（空 / `待同步` / `无`）才退到举办年份；两个都不行 ⇒ `年份未知`（不静默丢）。
 */
export function seasonLabel(node) {
    if (isRealYear(node && node.natureSeason)) return String(node.natureSeason).trim();
    return yearLabel(node && node.natureYear);
}

/**
 * ★★ **这一条的"年份层"该用哪个轴**（用户 2026-10-08 定的标准：**两种系列、两套标准**）：
 *   · **xcpc 系列**（`(?/)xcpc` 那一支 —— `xcpc/…`、`qoj/xcpc/…`、`cf/gyms/xcpc/…` 这些镜像都算）
 *     ⇒ **按赛季**（`natureSeason`）：赛程本来就是**按赛季**排的，而举办年份会跨年
 *     （EC-Final / CCPC Final 常是"赛季年末办、举办年落到次年"，年份那格还常是 `待同步`）
 *     ⇒ 用年份分层会把同一届拆到两层、把总决赛全塞进 `年份未知`；
 *   · **别的**（cf 正式轮次 / atcoder / 多校…）⇒ **按年份**（`natureYear`）：
 *     这些比赛**没有"赛季"这个概念**（`natureSeason` 常是 `无` 或空；gym 的赛季 = 举办年份），
 *     年份才是它们自己的轴。
 *
 * 判据只读 `natureClass` 的**分支**（`classIsXcpc`），不看具体比赛——于是同一场在两个镜像下
 * 落到同一层（`cf/gyms/xcpc/...` 与 `qoj/xcpc/...` 是同一支）。
 */
export function layerLabelOf(node) {
    return classIsXcpc((node && node.natureClass) || '') ? seasonLabel(node) : yearLabel(node && node.natureYear);
}

/** 这一条的年份层是"赛季轴"还是"年份轴"（只用于日志措辞，判据与 `layerLabelOf` 同一条） */
export function layerAxisOf(node) {
    return classIsXcpc((node && node.natureClass) || '') ? '赛季' : '年份';
}

// ================================================================
// 索引与落点
// ================================================================

/**
 * `(树根, class)` → `{ 容器键: { 地区: 场次数 } }`。
 *
 * 只收**能用**的样本：C 节点、nature 够、**父不是兜底桶**（否则兜底桶会把自己变成候选）。
 *
 * @param {Array<Object>} records - 包里的记录
 * @param {{keyOf:Function, parentOf:Function}} io
 */
export function buildHomeIndex(records, io) {
    const { keyOf, parentOf } = io;
    const byKey = new Map();
    for (const r of records) byKey.set(keyOf(r), r);
    const rootOf = (r) => {
        let cur = r;
        for (let i = 0; i < 64; i++) {
            const p = byKey.get(parentOf(cur));
            if (!p) return keyOf(cur);
            cur = p;
        }
        return keyOf(cur);
    };
    const idx = new Map();
    for (const r of records) {
        if (String(r['节点类型'] || r.type || '') !== 'C') continue;
        if (!enoughClass(r.natureClass)) continue;
        const p = byKey.get(parentOf(r));
        if (p && isFallbackLayer(p.name)) continue;
        const cls = String(r.natureClass).trim();
        const root = rootOf(r);
        const chain = stripYearLayer(parentOf(r));
        if (!chain) continue;
        if (!idx.has(root)) idx.set(root, new Map());
        const byClass = idx.get(root);
        if (!byClass.has(cls)) byClass.set(cls, new Map());
        const chains = byClass.get(cls);
        if (!chains.has(chain)) chains.set(chain, new Map());
        const region = String(r.natureRegion || '').trim();
        const counter = chains.get(chain);
        counter.set(region, (counter.get(region) || 0) + 1);
    }
    return idx;
}

/**
 * 这一场该挂哪 ⇒ `{chain, why}`；`chain` 为空 = 没有同 class 的落点（调用方再退到类路径）。
 *
 * @param {Map} byClass - `class → {容器键: {地区: 场次数}}`
 * @param {string} cls
 * @param {string} region
 */
export function resolveHome(byClass, cls, region) {
    const chains = (byClass && byClass.get(String(cls || '').trim())) || new Map();
    if (chains.size === 0) return { chain: '', why: '同分类一处落点都没有' };
    if (chains.size === 1) {
        const only = [...chains.keys()][0];
        return { chain: only, why: `同分类只有一处落点（${chains.get(only).size} 个地区样本）` };
    }
    const want = String(region || '').trim();
    if (want) {
        const hits = [...chains.entries()].filter(([, c]) => c.get(want))
            .sort((a, b) => (b[1].get(want) - a[1].get(want)) || String(a[0]).localeCompare(String(b[0])));
        if (hits.length) return { chain: hits[0][0], why: `同分类 ${chains.size} 处落点，按地区「${want}」认出（该处 ${hits[0][1].get(want)} 场）` };
    }
    return { chain: '', why: `同分类有 ${chains.size} 处落点、地区${want ? `「${want}」认不出` : '为空'}⇒ 退到类路径` };
}

/**
 * 按 nature 类路径铺出来的容器键（**不改记录**）：`qoj/xcpc/ccpc/final/official` ⇒
 * `['qoj:s:xcpc','qoj:s:xcpc:ccpc','qoj:s:xcpc:ccpc:final','…:official']`（每段的层名就是这一段）。
 *
 * 树根那一段**掐掉**（`qoj` 那棵树里 `qoj:s` 已经是根，再铺一层 `qoj` 是重复）——
 * 但只在它真的是最前面那段时掐（`cf/gyms/…` 在 `cf` 树里掐成 `gyms/…`）。
 *
 * @returns {{keys: Array<string>, names: Array<string>}}
 */
export function classPathLayers(root, cls) {
    const segs = classSegments(cls);
    if (segs.length && segs[0] === String(root || '')) segs.shift();
    const keys = [];
    const names = [];
    let cur = `${root}:s`;
    for (const seg of segs) {
        cur = `${cur}:${seg}`;
        keys.push(cur);
        names.push(seg);
    }
    return { keys, names };
}

// ================================================================
// ② 精简层：**"只剩赛季区别"的比赛组，别再套赛季层**
//
// 判据："着重检查那些已经分类到只剩赛季区别的比赛组，不要再套赛季层"
//
// 判据（**两个条件都满足**才收）：
//   · 容器通过它底下那几个赛季层收到的比赛，**分类完全一样**（⇒ 它们之间只剩赛季的差别）；
//   · 而且**每个赛季层里最多只有一场**（⇒ 那几层没在"分组"，只是在为单场开层）。
//
//   例：`…:cat-17:cat-18:cat-26`「Southeastern Europe」下 2023/2024/2025 三层各一场、
//        class 全是 `qoj/xcpc/icpc/eu/regional/official` ⇒ 三层都收掉，三场直接挂。
//   反例①：`…:cat-17:cat-21`「Asia East Continent」的 class 混着 `regional`/`pre`/`final` ⇒ 不动。
//   反例②：**省赛**（`cat-212`）class 一样，但**每个赛季十几场** ⇒ 赛季层有用，不动
//          （"省赛…分类换为仅赛季一层，同赛季内一样要排序"）。
//
// ⚠️ 三条护栏：
//   · 赛季层里若有**非 C**（比如「热身赛」层）⇒ 整组不动（搬上去会把热身赛层也拽走）；
//   · **合成节点容器**（`xcpc:s:synth…`）不参与：那一层的"系列 → 赛季"是它的容器定义
//     （容器键在 `src/core/synthPlan.js` 算、由 `scripts/synth-bind.mjs` 铺），不是"多套了一层"；
//   · 只有比赛本身**有 natureClass** 才认得出"分类一样"（空 class 不算）。
// ================================================================

/** 是不是"赛季层"（层名 `20xx` / `年份未知`）—— 年份判据用同一个 `isRealYear` */
export function isSeasonLayer(node) {
    if (!node || (node['节点类型'] || node.type) !== 'S') return false;
    const name = String(node.name || '').trim();
    return name === YEAR_UNKNOWN_LAYER || isRealYear(name);
}

/**
 * 收掉"只剩赛季区别"的那些赛季层（**原地改 `doc.records`**）。
 *
 * @returns {{collapsed: Array, moved: number}} 收掉的层 / 搬上来的比赛数
 */
export function collapseSeasonLayers(doc, dryRun = false) {
    const records = doc.records || [];
    const keyOf = (r) => r.synthKey || r.extKey || '';
    const parentOf = (r) => r['父synthKey'] || r['父extKey'] || '';
    const byKey = new Map(records.map((r) => [keyOf(r), r]));
    const kids = new Map();
    for (const r of records) {
        const p = parentOf(r);
        if (!kids.has(p)) kids.set(p, []);
        kids.get(p).push(r);
    }
    const collapsed = [];
    const drop = new Set();
    const movedNodes = [];
    for (const r of records) {
        const key = keyOf(r);
        const parentKey = parentOf(r);
        if (!parentKey || !byKey.has(parentKey)) continue;
        if (String(r.name || '').trim().startsWith('synth') || /:synth/.test(key)) continue;   // 合成容器不参与
        if (key.startsWith('xcpc:s:synth')) continue;
        const seasons = (kids.get(key) || []).filter(isSeasonLayer);
        if (!seasons.length) continue;
        const pool = [];
        let ok = true;
        for (const s of seasons) {
            const inner = kids.get(keyOf(s)) || [];
            // ⚠️ 每层**最多一场**才算"没在分组"（多了就是真的在按赛季分组，比如省赛）
            if (inner.length !== 1 || inner.some((x) => x['节点类型'] !== 'C')) { ok = false; break; }
            pool.push(...inner);
        }
        if (!ok || !pool.length) continue;
        const classes = new Set(pool.map((c) => String(c.natureClass || '').trim()));
        if (classes.size !== 1 || ![...classes][0]) continue;              // 分类必须**完全一样**
        collapsed.push({ parent: key, seasons: seasons.map((s) => keyOf(s)), n: pool.length, cls: [...classes][0] });
        for (const s of seasons) drop.add(keyOf(s));
        // ⚠️ 比赛的**新父 = 这个容器本身**（`key`），不是容器的父（第一版写成 `parentKey`
        //    把比赛挂到了 W 上 —— 冒烟当场抓住）
        movedNodes.push(...pool.map((c) => ({ c, to: key })));
    }
    if (!dryRun && movedNodes.length) {
        for (const { c, to } of movedNodes) {
            delete c['父synthKey'];
            delete c['父extKey'];
            const dest = byKey.get(to);
            if (dest && String(dest.synthKey || '').trim()) c['父synthKey'] = to;
            else c['父extKey'] = to;
        }
        doc.records = records.filter((r) => !drop.has(keyOf(r)));
        // 搬完重排（父在前、同层按规则）—— 同样只有 `src/core/siblingOrder.js` 那一份实现
        doc.records = treeOrder(doc.records, {
            keyOf: (r) => r.synthKey || r.extKey || '',
            parentOf: (r) => r['父synthKey'] || r['父extKey'] || ''
        });
    }
    return { collapsed, moved: movedNodes.length };
}

// ================================================================
// 主流程
// ================================================================

const keyOf = (r) => r.synthKey || r.extKey || '';
const parentOf = (r) => r['父synthKey'] || r['父extKey'] || '';

/**
 * 搬这一份包（**原地改 `doc.records`**）。`dryRun` 时不改。
 *
 * @returns {{moved: Array, buckets: Array, index: Map}}
 */
export function rehome(doc, dryRun = false) {
    const records = doc.records || [];
    const byKey = new Map(records.map((r) => [keyOf(r), r]));
    const index = buildHomeIndex(records, { keyOf, parentOf });

    const moved = [];
    const intendParent = new Map();            // C 的 key → 这次**打算**挂到哪（dry-run 也照记）
    const created = new Map();                 // 新铺的 S（键 → 记录），最后一次性补进 records
    const ensureLayer = (key, parent, name) => {
        if (byKey.has(key) || created.has(key)) return;
        const isSynth = !!String(parent.synthKey || '').trim();
        const rec = isSynth
            ? { '节点类型': 'S', synthKey: key, '父synthKey': parent.synthKey }
            : { '节点类型': 'S', extKey: key, '父extKey': keyOf(parent) };
        rec.name = name;
        created.set(key, rec);
        byKey.set(key, rec);
    };

    for (const r of records) {
        if (String(r['节点类型'] || '') !== 'C') continue;
        const parent = byKey.get(parentOf(r));
        // ★ 只搬**兜底桶**里的（分类层的 `无归类`… **和年份层的 `年份未知`** —— 见 `isFallbackBucket`）
        if (!parent || !isFallbackBucket(parent.name)) continue;
        const cls = String(r.natureClass || '').trim();
        if (!enoughClass(cls)) continue;                             // 只搬 nature 够的（且只对 xcpc 那支）
        const root = (() => {                                        // 树根 = 最上面那个祖先
            let cur = r;
            for (let i = 0; i < 64; i++) {
                const p = byKey.get(parentOf(cur));
                if (!p) return keyOf(cur);
                cur = p;
            }
            return keyOf(cur);
        })();
        const { chain, why } = resolveHome(index.get(root), cls, r.natureRegion);
        let dest = chain;
        let how = why;
        // ★ 年份层用哪个轴**由分支决定**（xcpc ⇒ 赛季；别的 ⇒ 年份），两条路（有邻居参考 / 没参考）同一份
        const axis = layerAxisOf(r);
        let label = layerLabelOf(r);
        if (!dest) {                                                 // 退到「按 nature 类路径铺」
            const { keys, names } = classPathLayers(root, cls);
            let p = byKey.get(root);
            for (let i = 0; i < keys.length; i++) {
                ensureLayer(keys[i], p, names[i]);
                p = byKey.get(keys[i]);
            }
            if (!keys.length) continue;                              // 一段都没有 ⇒ 不猜
            dest = keys[keys.length - 1];
            how = `${why} ⇒ 按类路径铺 \`${dest}\`；年份层取${axis} ${label}`;
        }
        const yearKey = `${dest}:${label}`;
        const from = parentOf(r);                                    // ⚠️ 必须在改父之前取
        // ⚠️ 算出来还是**同一个桶** ⇒ 这不是"搬"，别改父引用也别记账。
        //    （加进"年份层的兜底桶"之后，一大批**年份仍然没定**的节点会走进这个循环：
        //      它们本来就该留在 `年份未知` 里，不拦的话日志会虚报搬了几百条。）
        if (yearKey === from) continue;
        ensureLayer(yearKey, byKey.get(dest), label);
        if (!dryRun) {
            // 只留一个父引用（应用侧对"两个都有"是整条拒绝）
            delete r['父synthKey'];
            delete r['父extKey'];
            const destRec = byKey.get(yearKey);
            if (destRec && String(destRec.synthKey || '').trim()) r['父synthKey'] = yearKey;
            else r['父extKey'] = yearKey;
        }
        moved.push({ key: keyOf(r), name: r.name || '', from, to: yearKey, how });
        intendParent.set(keyOf(r), yearKey);
    }

    // 空掉的兜底桶收掉（它本来就只是"有人落进来才建"的）
    //
    // ⚠️ 判"桶是不是空了"必须按**这次搬完之后**的父子关系算（`intendParent`），
    //    不能读此刻的 `parentOf`：真跑时上面的循环已经把 `父extKey` 删掉改过了，
    //    而 dry-run 一个字都不改 —— 用当前父引用会**少报**要删的桶，
    //    于是 `--dry-run` 与实际写盘结果不一致。
    const buckets = [];
    if (moved.length) {
        const stillUsed = new Set(records.map((r) => intendParent.get(keyOf(r)) ?? parentOf(r)));
        for (const r of records) {
            if (String(r['节点类型'] || '') !== 'S' || !isFallbackBucket(r.name)) continue;
            if (stillUsed.has(keyOf(r))) continue;
            buckets.push({ key: keyOf(r), name: r.name });
        }
    }
    if (!dryRun) {
        const dropped = new Set(buckets.map((b) => b.key));
        doc.records = records.filter((r) => !dropped.has(keyOf(r))).concat([...created.values()]);
        // 搬完必须**重排同层顺序**（规则只有一份实现：`src/core/siblingOrder.js`）
        doc.records = treeOrder(doc.records, {
            keyOf: (r) => r.synthKey || r.extKey || '',
            parentOf: (r) => r['父synthKey'] || r['父extKey'] || ''
        });
    }
    return { moved, buckets, index };
}

// ================================================================
// 命令行
// ================================================================

function main(argv) {
    const args = { package: DEFAULT_PACKAGE, dryRun: false, quiet: false };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--package') args.package = argv[++i];
        else if (argv[i] === '--dry-run') args.dryRun = true;
        else if (argv[i] === '--quiet') args.quiet = true;
        // 位置参数也给（`build_chain.py` 那一步就是 `node nature-rehome.mjs <包>`，
        // 与 `crate-check.mjs <包>` 同一种传法）
        else if (!argv[i].startsWith('-')) args.package = argv[i];
        else {
            console.error(`用法: node scripts/nature-rehome.mjs [<包>] [--package <包>] [--dry-run] [--quiet]`);
            return 2;
        }
    }
    const doc = JSON.parse(fs.readFileSync(args.package, 'utf8'));
    const { moved, buckets } = rehome(doc, args.dryRun);
    const { collapsed, moved: lifted } = collapseSeasonLayers(doc, args.dryRun);
    if (!args.quiet) {
        if (!moved.length) {
            console.log('🔀 按 nature 落位：没有"分类不够、nature 够"的节点（兜底桶里是干净的）');
        } else {
            console.log(`🔀 按 nature 落位：${moved.length} 场（渠道没给分类、nature 够）`);
            for (const m of moved) {
                console.log(`   ${m.key}「${m.name}」→ ${m.to}`);
                console.log(`      依据：${m.how}`);
            }
            for (const b of buckets) console.log(`   🧹 空掉的兜底桶已收掉：${b.key}「${b.name}」`);
        }
        if (collapsed.length) {
            console.log(`🧹 只剩赛季区别的组：收掉 ${collapsed.length} 组里的 ${collapsed.length} 层赛季层`
                + `（${lifted} 场比赛上提一层）`);
            for (const c of collapsed.slice(0, 8)) {
                console.log(`   ${c.parent}：${c.seasons.length} 层 → 直接挂 ${c.n} 场（class ${c.cls}）`);
            }
            if (collapsed.length > 8) console.log(`   …… 另有 ${collapsed.length - 8} 组`);
        }
    }
    if (args.dryRun) {
        console.log('（--dry-run：没有写盘）');
        return 0;
    }
    fs.writeFileSync(args.package, JSON.stringify(doc, null, 2) + '\n', 'utf8');
    return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
    process.exit(main(process.argv.slice(2)));
}
