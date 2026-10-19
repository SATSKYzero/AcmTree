// ================================================================
// 「性质」的推荐（core/natureSuggest.js）—— ③ 性质待补的填表助手
//
// 口径：年份与地区要有自动推荐机制，方便人工填。
//
// 三条铁律（与判重页那些"推荐"同源）：
//   · **只推荐，不写数据**：值要人点一下才进库（写路径仍是 `core/ops/node.js` 那一处）；
//   · **没有证据就不推荐**：返回 `null`，绝不用"猜一个"把空格填上；
//   · **每条推荐都带出处**（`why` 一句话 + `fromId`）—— 界面上点了能跳过去核对
//     （`EVENTS.REVEAL_NODE`），"凭什么说它是 2024"永远看得见。
//
// 为什么**只做年份**（"不方便可以只年份"）：
//   地区这一维现在**没有可学的样本** —— 全库真实数据里 `natureRegion` 只有脚本填的 `无`
//   （线上赛）与空（XCPC，等人工），一个真地名都没有；唯一站得住的规则是
//   "同一场比赛的另一个来源填过哪个地区"，今天必然推不出东西。
//   等有人填过之后再补那条（见文件末尾 TODO），接口已经预留成 `{ year, region }`。
//
// ⚠️ 读值口径与 ③ 那一栏保持一致：读**缓存字段**（`node.contestTime` 等），
//    不绕来源层 —— 判重页判"缺不缺"用的也是缓存字段（`missingNatureKeysOf`）。
// ================================================================
import { normalizeNatureValue, isRealYear } from './natureFields.js';
import { levelOfSuggestFrom, meetsMinLevel } from './natureConfidence.js';

/**
 * 文本里的年份。
 *
 * ⚠️ **只认 `20xx`**：`natureYear` 的合法形态是 `^(20\d{2}|待同步|不确定)$`（注册表里写的），
 *    在这里连"19xx"一起抓的话，会推出去一个**写不进去**的值（写路径会拒，见 `applyNatureFields`）。
 *    只取**第一个**命中（Python 侧 `year_in_text` 同口径）。
 */
export function yearInText(text) {
    const m = /20\d{2}/.exec(String(text === undefined || text === null ? '' : text));
    return m ? m[0] : '';
}

/**
 * 从**标识**（`extKey` / `synthKey`，以及容器的键）里取年份 —— 与 `yearInText` 只差一条：
 * **纯数字的段一律丢掉**。
 *
 * ⚠️ 为什么必须这样（实测踩到）：节点的标识长这样
 * `qoj:c:2028`（= QOJ 场次 id）、`cf:c:2039`（= CF 比赛号）—— **id 本身就是 4 位数**，
 * 于是 `yearInText('qoj:c:2028')` 会吐出一个"2028 年"，而这场的真实年份是 2016
 * （`The 2016 ACM-ICPC Asia China-Final Contest`）。用户看到的就是"年份被误判成 2028"。
 * 丢掉纯数字段之后，`qoj:c:2028` / `cf:c:2039` / `…:cat-458` 都不再产出年份，
 * 而 `xcpc:c:zjcpc-2026`（年份长在 slug 里）照旧取到 2026。
 */
export function yearInIdentifier(text) {
    const kept = String(text === undefined || text === null ? '' : text)
        .split(/[:/]/)
        .filter(seg => seg && !/^\d+$/.test(seg));
    return yearInText(kept.join(' '));
}

/** 推荐的出处（界面上要能说清"凭什么"，也是测试里的锚）
 *
 * ⚠️ 每个出处**同时带一个「依据强度」级别**（`core/natureConfidence.js` 的 `SUGGEST_LEVEL`）——
 * "『按推荐填』让用户选择接受 A/B/C/D/E 级及以上的推荐"。
 * 级别只在那一处定义（这里不另写一份），取值见 `SUGGEST_LEVEL`。 */
export const SUGGEST_FROM = Object.freeze({
    TIME: 'time',             // 本节点的开赛时间（最硬：官方数据）
    KEY: 'key',               // 本节点的标识（爬虫生成的 slug，如 `xcpc:c:zjcpc-2026`）
    CONTAINER: 'container',   // 父容器链（应用里自己分的组，如 S 层「2026 浙江省赛」）
    NAME: 'name',             // 节点名（**最弱**：QOJ 那类赛名常带"2025 年 1 月"副标题）
    SIBLING: 'sibling',       // **同一届（分类逐字相同 + 赛季相同）的另一个来源**填过什么
    SEASON: 'season'          // 从**已有的赛季**反推（没有开赛时间时的兜底）
});

/** 推荐强度（数字越小越硬）；同值时按这个顺序取 */
const ORDER = [SUGGEST_FROM.TIME, SUGGEST_FROM.SIBLING, SUGGEST_FROM.KEY,
    SUGGEST_FROM.CONTAINER, SUGGEST_FROM.NAME, SUGGEST_FROM.SEASON];

/**
 * 「同一届」的**年份索引**：`去平台前缀的分类 + 赛季` → 这一届已知的举办年份。
 *
 * 为什么要它（总决赛窗口规则要求）：EC-Final / CCPC Final 的举办年份
 * 在"赛季年或次年"之间（窗口只给到这一步，**不唯一**），所以脚本不敢硬填；
 * 但**同一场比赛在别的来源树上常常有真实日期**（比如 QOJ 那场 EC-Final 的 XCPC 镜像）
 * ⇒ "同一届的另一个来源填过什么"就是真证据，比拿赛季顶准。
 *
 * ⚠️ 同届判定**要掐掉 `qoj/` 那一段前缀**：同一场 EC-Final 在 QOJ 上是
 *    `qoj/xcpc/icpc/ec/final`、在 XCPC 那边是 `xcpc/icpc/ec/final` —— 平台不同、赛事同一场。
 *    掐掉之后两边都是 `xcpc/icpc/ec/final` ✓（其余部分逐字相同，不会把不相干的并到一起）。
 * ⚠️ 同一个键下出现**两个不同年份**就不推（互相矛盾时宁可留空）。
 * ⚠️ **只有两个字段都是真的 `20xx` 才进索引**：`无` / `待同步` / `不确定` 一律跳过 ——
 *    否则所有 CF 单场（赛季 `无`）会挤进同一个键、彼此当"同届"，推出来的东西毫无意义。
 *    推荐**只给真年份**（"cf gym 不要推荐赛季无/年份无"）。
 * ⚠️ 索引按 `state.nodes` 这个**对象**缓存（`WeakMap`）：Immer 每次事务都会换一个新对象
 *    ⇒ 数据一变缓存自动作废，不需要手工失效。
 */
const YEAR_INDEX_CACHE = new WeakMap();

/** 同届比对的键：分类掐掉 `qoj/` 前缀（QOJ 上的镜像与 XCPC 侧的同一场要能对上） */
function seasonKeyOf(cls) {
    return String(cls || '').replace(/^qoj\//, '');
}

/**
 * 给一条推荐补上**依据强度**级别（`A`…`E`）—— **唯一处**，级别表在 `natureConfidence.js`。
 *
 * ⚠️ 所有对外返回的推荐都要过这一手（返回 `{...s, level}`，不改原对象）；
 *    界面据此显示徽标、并按用户选的门槛过滤（`suggestNatureFields` 的 `minLevel`）。
 */
function withLevel(s) {
    return s ? { ...s, level: levelOfSuggestFrom(s.from) } : s;
}

function seasonYearIndex(state) {
    const nodes = (state && state.nodes) || {};
    let hit = YEAR_INDEX_CACHE.get(nodes);
    if (hit) return hit;
    hit = new Map();
    for (const id of Object.keys(nodes)) {
        const n = nodes[id];
        if (!n) continue;
        // ⚠️ **合成节点不算"另一个来源"**：组头那几个性质是**按成员派生**出来的
        //    （`pickGroupNature`），拿它当证据等于把成员的话重复数一遍 —— 而且它没有自己的
        //    开赛时间，"同一届"会永远出现两个值（真实来源说 2024、组头说 2023）。
        if (n.synthKey) continue;
        const cls = normalizeNatureValue('natureClass', n.natureClass);
        const season = normalizeNatureValue('natureSeason', n.natureSeason);
        const year = normalizeNatureValue('natureYear', n.natureYear);
        // ⚠️ 两个都必须是**真年份**：`无` / `待同步` / `不确定` 不是"某一届"的标识
        //    （CF 全部单场的赛季都是 `无`，按它分桶会把不相干的比赛并成一届）
        if (!cls || !isRealYear(season) || !isRealYear(year)) continue;
        const key = `${seasonKeyOf(cls)}\u0000${season}`;
        const list = hit.get(key) || [];
        list.push({ year, id: String(n.id || id), name: String(n.name || '') });
        hit.set(key, list);
    }
    YEAR_INDEX_CACHE.set(nodes, hit);
    return hit;
}

/** 同一届的另一个来源填的年份（唯一才推；没有 / 矛盾 ⇒ `null`） */
function siblingYear(state, node) {
    const cls = normalizeNatureValue('natureClass', node.natureClass);
    const season = normalizeNatureValue('natureSeason', node.natureSeason);
    if (!cls || !isRealYear(season)) return null;   // `无` 之类的赛季不成"届"，索引里也没有它
    const list = seasonYearIndex(state).get(`${seasonKeyOf(cls)}\u0000${season}`) || [];
    const mine = String(node.id || '');
    const others = list.filter(x => x.id !== mine);
    const years = [...new Set(others.map(x => x.year))];
    if (years.length !== 1) return null;            // 没找到 / 两个来源互相矛盾 ⇒ 不推
    const one = others.find(x => x.year === years[0]);
    return {
        value: years[0],
        from: SUGGEST_FROM.SIBLING,
        fromId: one.id,
        why: `同一届（${cls} · ${season} 赛季）的另一个来源「${one.name || one.id}」填的是 ${years[0]}`
    };
}

/** 取节点：接受 id 或节点对象（两处调用方都方便） */
function nodeOf(state, nodeOrId) {
    if (nodeOrId && typeof nodeOrId === 'object') return nodeOrId;
    const nodes = (state && state.nodes) || {};
    return nodes[String(nodeOrId || '')] || null;
}

/** 从节点的父容器链里找**最近的**那个带年份的容器（含它自己那一层上溯到根） */
function containerYear(state, node) {
    const parentOf = (state && state.parentOf) || {};
    const nodes = (state && state.nodes) || {};
    let id = parentOf[node.id];
    const guard = new Set();                     // 数据坏了（成环）也不许死循环
    while (id && !guard.has(id)) {
        guard.add(id);
        const p = nodes[id];
        if (!p) break;
        // 名字优先（合成容器就叫「2024」这种），键走 `yearInIdentifier`（别把段 id 当年份）
        const y = yearInText(p.name) || yearInIdentifier(p.extKey);
        if (y) {
            return {
                value: y,
                from: SUGGEST_FROM.CONTAINER,
                fromId: id,
                why: `父容器「${p.name || p.id}」里写着 ${y}`
            };
        }
        id = parentOf[id];
    }
    return null;
}

/**
 * 这一支的比赛有**赛季**概念吗？（XCPC 及其 QOJ 镜像）
 *
 * 有赛季概念时，「赛季」字段才真的与「年份（举办）」不同（EC-Final 常跨年）。
 */
export function hasSeasonConcept(node) {
    const cls = normalizeNatureValue('natureClass', node && node.natureClass);
    return /^(xcpc|qoj\/xcpc)(\/|$)/.test(cls);
}

/**
 * 建议一个节点的**年份（举办年份）**：开赛时间 → （没有时间时）**赛季年**。
 *
 * ⚠️ 第一依据永远是官方开赛时间。**没有时间才退到赛季年**，而且 `why` 里必须说清
 * "这是从赛季反推的、可能差一年"（"qoj 应该没记开赛时间，从赛季倒推一下"
 * —— QOJ 那 300 场里只有 19 场有日期，不反推就只能永远空着；数据侧同样这么填）。
 */
export function suggestNatureYear(state, nodeOrId) {
    const node = nodeOf(state, nodeOrId);
    if (!node) return null;
    if (normalizeNatureValue('natureYear', node.natureYear)) return null;
    const id = String(node.id || '');
    const timeText = String(node.contestTime || '').trim();
    const timeYear = yearInText(timeText);
    if (timeYear) {
        return withLevel({
            value: timeYear,
            from: SUGGEST_FROM.TIME,
            fromId: id,
            why: `本节点的开赛时间 ${timeText}（= 举办年份）`
        });
    }
    const season = normalizeNatureValue('natureSeason', node.natureSeason);
    const bySibling = siblingYear(state, node);
    if (bySibling) return withLevel(bySibling);
    // ⚠️ 只有**真赛季年**才能反推：`无` / `待同步` / `不确定` 反推出来就是一个假的年份
    //    （"cf gym 不要推荐赛季无/年份无"）——推不出来就留空，等人填。
    if (isRealYear(season)) {
        return withLevel({
            value: season,
            from: SUGGEST_FROM.SEASON,
            fromId: id,
            why: `没有开赛时间 ⇒ 从「赛季」 ${season} 反推（跨年赛事可能差一年，请核对）`
        });
    }
    return null;
}

/**
 * 建议一个节点的**赛季年份**：标识 → 名字 → 父容器。
 *
 * 这些都是"这一届是哪一届"的证据（slug 里常写着 `icpc2023ecfinal`），与 CF/AtCoder
 * 那种"没有赛季概念"的支无关（那边 `natureSeason` 直接等于举办年，由适配器填好）。
 */
export function suggestNatureSeason(state, nodeOrId) {
    const node = nodeOf(state, nodeOrId);
    if (!node) return null;
    if (normalizeNatureValue('natureSeason', node.natureSeason)) return null;
    const id = String(node.id || '');
    const own = (from, value, why) => withLevel({ value, from, fromId: id, why });

    const key = String(node.extKey || node.synthKey || '').trim();
    // ⚠️ 标识里的年份走 `yearInIdentifier`：`qoj:c:2028` 这种**段 id 本身就是四位数**，
    //    用 `yearInText` 会把它当年份（实测："很多比赛的年份被误判成 2028"）。
    const keyYear = yearInIdentifier(key);
    if (keyYear) return own(SUGGEST_FROM.KEY, keyYear, `标识「${key}」里写着 ${keyYear}`);

    const name = String(node.name || '').trim();
    const nameYear = yearInText(name);
    if (nameYear) {
        return own(SUGGEST_FROM.NAME, nameYear, `名字「${name}」里写着 ${nameYear}（请核对是不是赛季年）`);
    }

    const byContainer = containerYear(state, node);
    if (byContainer) return withLevel(byContainer);

    return null;
}

/**
 * 一个节点的全部推荐（年份 = 举办年份；赛季；地区一律不推）。
 *
 * @returns {{year: Object|null, season: Object|null, region: null}}
 */
export function suggestNature(state, nodeOrId) {
    return {
        year: suggestNatureYear(state, nodeOrId),
        season: suggestNatureSeason(state, nodeOrId),
        region: null
    };
}

/**
 * 一批节点的**字段级**推荐（给"按推荐填入"那个按钮用）。
 *
 * 每条只带**推得出来的**字段（`fields` 可能是 `{}` ⇒ 调用方跳过它），
 * 并附上逐字段的 `why`（界面上要能说清"凭什么"）与 `levels`（逐字段的**依据强度**）。
 *
 * `opts.minLevel`（`A`…`E`，缺省 `E` = 全收）—— "『按推荐填』让用户
 * 选择接受 A/B/C/D/E 级及以上的推荐"：**低于门槛的推荐直接不进结果**（= 不会被批量写进去）。
 *
 * @returns {Array<{id:string, fields:Object, whys:Object, levels:Object}>}
 */
export function suggestNatureFields(state, ids, opts) {
    const minLevel = (opts && opts.minLevel) || 'E';
    const out = [];
    for (const id of (Array.isArray(ids) ? ids : [])) {
        const y = suggestNatureYear(state, id);
        const s = suggestNatureSeason(state, id);
        const fields = {};
        const whys = {};
        const levels = {};
        if (y && meetsMinLevel(y.level, minLevel)) {
            fields.natureYear = y.value;
            whys.natureYear = y.why;
            levels.natureYear = y.level;
        }
        if (s && meetsMinLevel(s.level, minLevel)) {
            fields.natureSeason = s.value;
            whys.natureSeason = s.why;
            levels.natureSeason = s.level;
        }
        if (Object.keys(fields).length) out.push({ id: String(id), fields, whys, levels });
    }
    return out;
}

/** 推荐强度序（给界面排序/取最优用；不认识的一律排最后） */
export function suggestRank(from) {
    const i = ORDER.indexOf(from);
    return i < 0 ? ORDER.length : i;
}

// TODO（地区）：等库里出现**真实地名**之后再加唯一那条站得住的规则 ——
//   "同一场比赛的另一个来源节点（同名 / 同一个 `extKey` 的镜像）填过哪个地区"
//   ⇒ 推荐那个值，`why` 写清"来自哪一场的哪份原料"，`fromId` 指向那个节点。
//   在此之前**不许**从拼音目录名 / 赛名去猜地名（那是"猜"，不是"证据"）。
//
// 📌 **记下**（`https://qoj.ac/category/21` 上"21 的城市可供推荐"）：
//   候选**词表**其实是现成的 —— QOJ 自己的分类目录里就写着地名：
//     · `cat-21`（ICPC / Regionals / Asia East Continent）下的 **20 个城市目录**：
//       Beijing / Changchun / Chengdu / Guangzhou / Hangzhou / Hefei / Hong Kong & Macau /
//       Jiaozuo / Jinan / Kunming / Nanjing / Nanning / Qingdao / Shanghai / Shenyang /
//       Ürümqi / Wuhan / Xi'an / Xuzhou / Yinchuan（这正是我们**故意不建层**的那一批，
//       见 `qoj_adapter.py` 的 `QOJ_SITE_LAYER_PARENTS`）；
//     · `cat-212`（Chinese Provincial / Invitational）下的**省/市**目录：
//       Zhejiang / Sichuan / Hunan / Hebei / Shandong / Guangdong / Beijing / Jiangsu /
//       Shaanxi / Jilin / Hong Kong & Macau / Guangxi / Xi'an / Shanghai / Liaoning / Wuhan /
//       Fujian / Multi-Provincial…
//   用法建议（真要动手时）：拿它当**候选集**去匹配场次名/标识里出现的地名（或 QOJ 分类路径），
//   匹上就推荐 + `why` 写"QOJ 分类里写着 Wuhan"，**仍然由人点一下才写**。
//   ⚠️ 两个坑：① 这些是**站点分类名**，与我们想要的 `natureRegion` 写法未必一致
//   （`Hong Kong & Macau` / `Ürümqi` 这种要定个写法）；② 所以**不能**直接把目录名当值写进去。
