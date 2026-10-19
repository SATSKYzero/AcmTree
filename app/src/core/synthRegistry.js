// ================================================================
// 「哪些节点**不该**算合成键」的判据（core/synthRegistry.js）
//
// 口径："引入『有些节点不该算合成键』的逻辑与注册表"
// + "节点级白名单 + 分类白名单，是**不同层的属性叠加**" + 例子："**比如平壤**"。
//
// 注册表文件是**唯一真源**：`acm-data/synth-registry.json`
// （与 `nature-registry.json` 同一套做法：手维护 + 两个消费者共用 ——
//   `scripts/synth-bind.mjs`（产包）与 `core/synthConflicts.js`（应用侧 ⑤ 实时算））。
//
// 两层（任一层命中即排除）：
//   · `classRules` —— 按**分类路径**匹配。**先去镜像前缀**再比（`qoj/xcpc/…` / `cf/gyms/xcpc/…`
//     与 `xcpc/…` 是同一件事，见 `synthPlan.bareClass`），**精确或前缀都算命中**
//     （写 `xcpc/icpc/ec` 一处就覆盖它下面所有子路径；写 `qoj/无归类` 就只管那一支）。
//   · `nodeRules` —— 按 `extKey`（或 `synthKey`）**点名**。
//
// 命中之后**意味着什么**（三个消费者必须一致，别各判一套）：
//   ① `synth-bind` 不再给它算键 / 绑组；已绑的**脚本格式**键会被**解绑**（空掉的组与容器跟着收掉）；
//      人工绑的键（不是我们格式）**一个字不动**，只报出来；
//   ② ⑤ 冲突里它**不算"算不出"**（那是结论，不是欠账）⇒ 单独记一行"注册表排除 N 条"；
//   ③ 注册表里点名、**包里/树里却没有**的条目 ⇒ 也要报（写错 extKey、那场没了都属"不符"）。
// ================================================================

import { bareClass } from './synthPlan.js';
import { treeOfExtKey } from '../utils/extkey.js';

/** 注册表文件的位置（仓库根下 `acm-data/`）—— 本文件在 `src/core/`，上两级就是仓库根 */
const REGISTRY_URL = new URL('../../acm-data/synth-registry.json', import.meta.url);

/** 跑在 Node 里吗（单测/冒烟/脚本 = 是；浏览器 = 否） */
const IS_NODE = typeof process !== 'undefined' && !!(process.versions && process.versions.node);

/** 规则字段名（**唯一一份**，别处引用一律从这里取） */
export const CLASS_RULE_FIELDS = Object.freeze(['match']);
export const NODE_RULE_FIELDS = Object.freeze(['extKey', 'synthKey']);

/** P 层（题目绑定）的**题号映射表**字段名（"题号映射表也属于注册表"） */
export const PROBLEM_ID_MAP_FIELDS = Object.freeze(['contest', 'source', 'extKey', 'map', 'why']);

/** 去镜像前缀 + 去空白（比对两边都用它 —— 与 `synthPlan.bareClass` 同一份实现） */
export function matchText(value) {
    return String(bareClass(String(value === undefined || value === null ? '' : value).trim())).trim();
}

/**
 * 读注册表本体（Node 用 `fs`、浏览器用 `fetch`；都在**模块求值期**走完，见下面的顶层 await）。
 *
 * ⚠️ 浏览器里**必须 `cache: 'no-store'`**（与 `natureFields.js` 同一条实测教训）：
 *    这是普通静态 `.json`，HTTP 缓存会让"改了注册表"看不见。文件才几 KB。
 */
async function readRegistry() {
    if (IS_NODE) {
        const [{ readFileSync }, { fileURLToPath }] = await Promise.all([
            import('node:fs'), import('node:url')
        ]);
        return JSON.parse(readFileSync(fileURLToPath(REGISTRY_URL), 'utf8'));
    }
    const res = await fetch(REGISTRY_URL, { cache: 'no-store' });
    if (!res.ok) {
        throw new Error(`synthRegistry：注册表取不到（HTTP ${res.status}）—— ${REGISTRY_URL}`);
    }
    return res.json();
}

/**
 * 形状自检 —— **不合法直接抛**（同 `natureFields.assertRegistry`）：
 * 注册表是"人的结论"，写坏了必须当场知道，而不是静默地谁都不排除。
 */
export function assertSynthRegistry(doc) {
    const bad = (msg) => { throw new Error(`synth-registry.json：${msg}`); };
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) bad('顶层必须是对象');
    if (!Number.isFinite(Number(doc.registryVersion))) bad('缺 registryVersion');
    for (const [field, label] of [['classRules', 'classRules'], ['nodeRules', 'nodeRules'],
        ['problemIdMap', 'problemIdMap']]) {
        if (doc[field] === undefined) continue;
        if (!Array.isArray(doc[field])) bad(`${label} 必须是数组`);
        doc[field].forEach((one, i) => {
            if (!one || typeof one !== 'object' || Array.isArray(one)) bad(`${label} 第 ${i} 条不是对象`);
            if (field === 'classRules') {
                if (!String(one.match || '').trim()) bad(`classRules 第 ${i} 条缺 match`);
            } else if (field === 'nodeRules') {
                if (!String(one.extKey || one.synthKey || '').trim()) {
                    bad(`nodeRules 第 ${i} 条既没有 extKey 也没有 synthKey`);
                }
            } else {
                // ★ P 层**题号映射表**：`{contest, source|extKey, map, why}`
                if (!String(one.contest || '').trim()) bad(`problemIdMap 第 ${i} 条缺 contest（场次标识）`);
                if (!String(one.source || one.extKey || '').trim()) {
                    bad(`problemIdMap 第 ${i} 条既没有 source 也没有 extKey`);
                }
                if (!one.map || typeof one.map !== 'object' || Array.isArray(one.map)
                    || !Object.keys(one.map).length) {
                    bad(`problemIdMap 第 ${i} 条的 map 必须是非空对象（{来源题号: 本场题号}）`);
                }
                for (const [from, to] of Object.entries(one.map)) {
                    if (!String(from).trim() || !String(to).trim()) {
                        bad(`problemIdMap 第 ${i} 条的 map 里有空题号`);
                    }
                }
            }
            if (!String(one.why || '').trim()) bad(`${label} 第 ${i} 条缺 why（它是这条规则存在的理由）`);
        });
    }
    return doc;
}

const REGISTRY = assertSynthRegistry(await readRegistry());

/** 注册表版本（文件里的 `registryVersion`） */
export const SYNTH_REGISTRY_VERSION = Number(REGISTRY.registryVersion || 0);

/** 分类白名单（`{match, why}`；`match` 已归一化，比对时不再重复处理） */
export const SYNTH_CLASS_RULES = Object.freeze((REGISTRY.classRules || []).map((one) => Object.freeze({
    match: String(one.match).trim(),
    matchText: matchText(one.match),
    why: String(one.why || '')
})));

/** 节点白名单（`{extKey|synthKey, why}`） */
export const SYNTH_NODE_RULES = Object.freeze((REGISTRY.nodeRules || []).map((one) => Object.freeze({
    extKey: String(one.extKey || '').trim(),
    synthKey: String(one.synthKey || '').trim(),
    why: String(one.why || '')
})));

/**
 * **题号映射表**（P 层，"题号映射表也属于注册表"）。
 *
 * 语义：**这个来源在这场里，题号 `X` 应当算作本场次的题号 `Y`**（`map = {X: Y}`）。
 * 它在 P 层**归堆之前**生效 ⇒ 键里的题号是**规范题号**，与"谁是基准"无关
 * （基准那份换了，键也不变 —— 这正是不要"挂在基准 extKey 上"的理由）。
 *
 * ⚠️ 为什么需要它（实测真问题）：`2026provincial-东北` 里 qoj 那份的题号**整体偏移一格**
 *   （qoj 的 C 是基准的 D、D 是基准的 E…）—— 纯按题号绑会**绑错一整场**。
 */
export const SYNTH_PROBLEM_ID_MAP = Object.freeze((REGISTRY.problemIdMap || []).map((one) => Object.freeze({
    contest: String(one.contest || '').trim(),
    source: String(one.source || '').trim(),
    extKey: String(one.extKey || '').trim(),
    map: Object.freeze({ ...(one.map || {}) }),
    why: String(one.why || '')
})));

/**
 * 这一场、这个成员，有没有题号映射？**没有 ⇒ 返回 `null`**（调用方直接按原题号走）。
 *
 * ⚠️ 匹配**先 extKey 后 source**：点名到具体那条最精确；只写 `source`（来源树前缀）时
 *    对它下面**所有**成员生效。两条都命中时 **extKey 那条赢**（更精确的那条说了算）。
 *
 * @param {string} contest - 场次标识（`planKeyOf(...).id`）
 * @param {string} extKey  - 成员 C 的 extKey（`aux-rankland:c:zjcpc23rd`）
 */
export function problemIdMapOf(contest, extKey) {
    const cid = String(contest || '').trim();
    const ext = String(extKey || '').trim();
    if (!cid || !ext) return null;
    const src = treeOfExtKey(ext);                 // 来源树前缀（`aux-rankland` / `qoj` / `cf`…）
    let bySource = null;
    for (const row of SYNTH_PROBLEM_ID_MAP) {
        if (row.contest !== cid) continue;
        if (row.extKey && row.extKey === ext) return row.map;
        if (row.source && row.source === src) bySource = row.map;
    }
    return bySource;
}

/**
 * 一条分类规则命中某个分类吗？（**精确或前缀**，两边都先去掉镜像前缀）
 *
 * ⚠️ 单独导出是为了能**纯函数**地测：注册表本体是文件（不该为了测试去改它）。
 */
export function classRuleHit(match, cls) {
    const a = matchText(match);
    const b = matchText(cls);
    if (!a || !b) return false;
    return b === a || b.startsWith(a + '/');
}

/**
 * 这个节点被注册表排除了吗？
 *
 * @param {Object} node - 一个 C 节点（原料或成员都行；读 `extKey` / `synthKey` / `natureClass`）
 * @returns {null | {layer:'classRules'|'nodeRules', match:string, why:string}}
 *          （**分类层优先**：两层都命中时先说分类那一条，它是更"整类"的解释）
 */
export function noSynthRuleOf(node) {
    if (!node) return null;
    const cls = matchText(node.natureClass);
    if (cls) {
        for (const rule of SYNTH_CLASS_RULES) {
            if (!rule.matchText) continue;
            if (classRuleHit(rule.matchText, cls)) {
                return { layer: 'classRules', match: rule.match, why: rule.why };
            }
        }
    }
    const ext = String(node.extKey || '').trim();
    const synth = String(node.synthKey || '').trim();
    for (const rule of SYNTH_NODE_RULES) {
        if (rule.extKey && rule.extKey === ext) return { layer: 'nodeRules', match: rule.extKey, why: rule.why };
        if (rule.synthKey && rule.synthKey === synth) {
            return { layer: 'nodeRules', match: rule.synthKey, why: rule.why };
        }
    }
    return null;
}

/** 只要一句人话（`''` = 没被排除）—— 日志/界面用 */
export function noSynthReasonOf(node) {
    const rule = noSynthRuleOf(node);
    return rule ? `${rule.layer === 'classRules' ? '分类白名单' : '节点白名单'}：${rule.match}` : '';
}

/**
 * 注册表里点名了、但给的那批节点里**一个都没命中**的条目（构建日志与 ⑤ 都要报）。
 *
 * ⚠️ 为什么值得专门报：写错 extKey、或那场在包里没了 —— 都属于"**注册表与实际不符**"，
 *    不报的话它只会静默失效（"其实我们现有的实现有许多地方没有考虑怎么删除"）。
 *
 * @param {Array} nodes - 候选节点（产包侧传全部记录；应用侧传当前树里的 C）
 */
export function missingSynthRules(nodes) {
    const list = nodes || [];
    const out = [];
    for (const rule of SYNTH_NODE_RULES) {
        const hit = list.some((n) => (rule.extKey && String(n.extKey || '').trim() === rule.extKey)
            || (rule.synthKey && String(n.synthKey || '').trim() === rule.synthKey));
        if (!hit) out.push(rule.extKey || rule.synthKey);
    }
    for (const rule of SYNTH_CLASS_RULES) {
        if (!rule.matchText) continue;
        const hit = list.some((n) => classRuleHit(rule.matchText, n.natureClass));
        if (!hit) out.push(rule.match);
    }
    return out;
}
