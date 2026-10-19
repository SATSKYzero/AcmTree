// ================================================================
// 「这个字段应有吗 / 已有吗」（core/fieldRegistry.js）
//
// 每个字段条都要有『是否应有』『是否已有』『来源』『优先级』四样：
// 「来源」/「优先级」走 `字段来源` / `trust` + `fieldLevel.js`；
// 「应有」/「已有」的判据在构建期（`acm-data/field-registry.json` 的 `expect` 谓词 +
// 体检报告）—— 应用侧由本模块补上。
//
// 这份模块把「应有」搬到应用侧：**注册表随包发布**（`all_nodes.json` 顶层 `fieldRegistry`），
// 字段条按同一份规则实时算。判据只有一处 —— 构建侧 `scripts/field-coverage.py`
// 的 `predicate_holds()` / `is_filled()`；这里是与它**逐条对齐**的 JS 版（两边必须一致，
// 单测钉住形状）。
//
// ⚠️ 两条判据别混（**应不应该有就是按场次的 Rated: Yes/No 判的**）：
//   · **应有**（本模块）= 注册表规则：`expect` 档位 + `when` 谓词；
//   · **实际有**（抓取侧）= CF 题目页面写没写 `Difficulty`（`lib/cf_page_evidence.py`）。
//   注册表里带 `when.evidence` 的字段，只是在这里**提一句**"可能有豁免"，不做判定。
//
// 纯模块：不碰 DOM、不读全局 state（`parentOf` 由调用方注入）。
// ================================================================

/** 档位（与注册表、体检报告同名） */
export const EXPECT_LEVELS = Object.freeze(['required', 'expected', 'optional']);

/** 档位的中文说法（界面用） */
export const EXPECT_LABEL = Object.freeze({
    required: '必须有',
    expected: '应该有',
    optional: '可有可无'
});

/**
 * 档位的**颜色**（**只有这一处**）：必须有=红 / 应该有=琥珀 / 可有可无=灰。
 *
 * ⚠️ 这个"三档 → 三色"的映射**只有这一处**（本文件的组渲染与字段条渲染、
 * `core/coverage.js` 的 `expectColor` 都读它）—— 三处各写一遍就会改一处亮一处暗。
 */
export const EXPECT_COLOR = Object.freeze({
    required: '#b91c1c',
    expected: '#b45309',
    optional: '#94a3b8'
});

/** 取一个档位的颜色（认不出 / 空 ⇒ 灰，与"可有可无"同色） */
export function expectColorOf(expect) {
    return EXPECT_COLOR[String(expect === undefined || expect === null ? '' : expect).trim()]
        || EXPECT_COLOR.optional;
}

/**
 * 节点的身份键（与构建侧 `field-coverage.key_of()` 对齐：`extKey`，合成节点看 `synthKey`）。
 *
 * ⚠️ 合成节点的 `extKey` 可能是**空的**（见合成那节的约定），所以退回 `synthKey`。
 */
export function identityKeyOf(node) {
    if (!node || typeof node !== 'object') return '';
    const ext = node.extKey === undefined || node.extKey === null ? '' : String(node.extKey);
    if (ext) return ext;
    const synth = node.synthKey === undefined || node.synthKey === null ? '' : String(node.synthKey);
    return String(synth || '');
}

/**
 * 节点的类型（`'C'` / `'P'` / `'R'` / `'S'` / `'W'` / `'O'` …）。
 *
 * ⚠️ **两个名字都要认**（只认一个的话，"应有/已有"就只能在 name/link 旁边看到）：
 *   · 应用里的节点用 **`type`**（`core/model/node.js` 建的）；
 *   · 包里/构建侧用 **`节点类型`**（列名；导入时由 `fieldMap` 映射成 `type`）。
 *   只读 `节点类型` 的话应用里恒为空 ⇒ **凡是有具体 `types` 的规则（nature 四维、cfDifficulty、
 *   language…）全部返回 `null`**，只剩 `types:['*']` 的 `name`/`link` 有那一行。
 */
export function nodeTypeOf(node) {
    if (!node || typeof node !== 'object') return '';
    if (node.type !== undefined && node.type !== null && String(node.type) !== '') return String(node.type);
    return String(node.节点类型 || '');
}

/**
 * 这个字段**算不算有值**（与构建侧 `is_filled()` 对齐）。
 *
 * ⚠️ 空串 / `null` / `undefined` / 空数组都算"没有值"；**`0` 算有值**
 *   （时间 0 秒、内存 0 KB 都是真实数据）—— 改这条要连 Python 那边一起改。
 */
export function isFilledValue(value) {
    if (value === undefined || value === null) return false;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'object') return Object.keys(value).length > 0;
    return String(value).trim() !== '';
}

/** 注册表里这个字段的规则（没有就 null） */
export function ruleOf(registry, field) {
    const fields = registry && typeof registry === 'object' && registry.fields;
    if (!fields || typeof fields !== 'object') return null;
    const rule = fields[field];
    return rule && typeof rule === 'object' ? rule : null;
}

/**
 * `when` 谓词成立吗 —— **与 `scripts/field-coverage.py` 的 `predicate_holds()` 逐条对齐**。
 *
 * 支持：`extKeyPrefix` / `notExtKeyPrefix` / `contestIdBelow` / `parentKind`（全部可选，缺省恒成立）。
 * 未知谓词键**一律不参与判定**（保持与构建侧"只认认识的键"一致）。
 *
 * @param {Object} rule
 * @param {Object} node
 * @param {Object} [opts]
 * @param {(extKey:string)=>?Object} [opts.parentOf] - **按 extKey 找父节点**（判 `parentKind` 用）；
 *   ⚠️ 传 `state.nodes` 是**错的** —— 那个表是 **id → 节点**，而 `parentExtKey` 是 extKey，
 *   查不到就一律判成"不适用"。用 `makeParentResolver()` 造一个（它内部建 extKey 索引并缓存）。
 */
export function predicateHolds(rule, node, opts = {}) {
    const when = (rule && rule.when) || {};
    const keys = Object.keys(when);
    if (!keys.length) return true;
    const ext = identityKeyOf(node);

    const prefixes = normList(when.extKeyPrefix);
    if (prefixes.length && !prefixes.some(p => ext.startsWith(p))) return false;

    if (when.contestIdBelow !== undefined && when.contestIdBelow !== null) {
        // "比赛号小于 N"：用来排除 gym（≥100000）这类**本来就不同的东西**
        // （CF 自己不给 gym 题难度，clist 也不给）。
        // ⚠️ **只对数字场次号生效**：AtCoder 的 `abc138` / UCup 的 `ucup-2` 这种非数字场次号
        //    **不参与判定** —— 否则同一条规则里混着 CF 与 AtCoder 时，AtCoder 会被整条否掉
        //    （clist 那条规则正是这么写的）。与 `scripts/field-coverage.py` 同口径。
        const parts = ext.split(':');
        const cid = parts.length > 2 ? parts[2] : '';
        // `contestIdBelow` 可以是**数字**（对所有前缀生效），也可以是 `{前缀: 上界}`（各论各的）：
        // CF gym 是 10 万+、牛客多校是 13 万+，同一个数字界分不开。
        const spec = when.contestIdBelow;
        let bound = null;
        if (spec && typeof spec === 'object' && !Array.isArray(spec)) {
            for (const prefix of Object.keys(spec).sort((a, b) => b.length - a.length)) {
                if (ext.startsWith(prefix)) { bound = Number(spec[prefix]); break; }
            }
        } else {
            bound = Number(spec);
        }
        if (bound !== null && !Number.isNaN(bound) && /^\d+$/.test(cid) && Number(cid) >= bound) {
            return false;
        }
    }

    const excluded = normList(when.notExtKeyPrefix);
    if (excluded.length && excluded.some(p => ext.startsWith(p))) return false;

    // `notStatus`：**这几种判定本来就没有这项数据**（与 Python 同口径）——
    // 实测牛客的 TLE 行不给内存、CE 行时间内存都没有（程序没跑起来）、MLE 行不给时间。
    const notStatus = normList(when.notStatus);
    if (notStatus.length && notStatus.includes(String(node && node.status || ''))) return false;

    if (when.parentKind) {
        const parentKey = node && node.parentExtKey !== undefined && node.parentExtKey !== null
            ? String(node.parentExtKey) : '';
        const parent = typeof opts.parentOf === 'function' ? opts.parentOf(parentKey) : null;
        if (!parent || nodeTypeOf(parent) !== String(when.parentKind)) return false;
    }
    return true;
}

/**
 * 造一个「extKey → 父节点」的查询函数（`predicateHolds` 的 `parentOf`）。
 *
 * 为什么要有它：`state.nodes` 是 **id → 节点**，而 `parentExtKey` 是 extKey ——
 * 直接传 `state.nodes` 会让所有 `parentKind` 规则**静默变成"不适用"**。
 *
 * 索引**按 `state.nodes` 的引用缓存**（immer 结构共享：nodes 没变、引用就不变），
 * 所以面板渲染多次也只建一次；`nodes` 一变（导入/编辑）自动重建。
 */
const _extIndexOf = new WeakMap();

export function makeParentResolver(state) {
    if (!state || typeof state !== 'object') return () => null;
    const nodes = state.nodes;
    return (extKey) => {
        const key = extKey === undefined || extKey === null ? '' : String(extKey);
        if (!key) return null;
        if (nodes && typeof nodes === 'object') {
            let index = _extIndexOf.get(nodes);
            if (!index) {
                index = new Map();
                for (const id of Object.keys(nodes)) {
                    const n = nodes[id];
                    const k = identityKeyOf(n);
                    if (k && !index.has(k)) index.set(k, n);   // 重复 key 取先到的（与 upsert 口径一致）
                }
                _extIndexOf.set(nodes, index);
            }
            const hit = index.get(key);
            if (hit) return hit;
        }
        // `state.parentOf` 是 id → id，`state.nodes` 里也可能有合成节点：两处都兜一下
        const byId = nodes && nodes[key];
        return byId || null;
    };
}

function normList(v) {
    if (v === undefined || v === null) return [];
    return (Array.isArray(v) ? v : [v]).map(x => String(x)).filter(Boolean);
}

/**
 * 这个字段属于哪个**字段组**（没有就 null）。
 *
 * 数值难度也是一个**字段组**（cf 本身难度 & clist 难度各是其中一个成员）。
 * 组 = "同一类信息、各来源各写各的字段"：注册表 `groups` 段定义（`{组名: {fields, expect, anyOf, why}}`），
 * 随包发布 ⇒ 应用侧这份实现与构建侧（`scripts/field-coverage.py` 的 `group_rows`）同源同形。
 *
 * @returns {?{name:string, fields:string[], expect:string, anyOf:boolean, why:string}}
 */
export function groupOfField(registry, field) {
    const groups = registry && typeof registry === 'object' ? registry.groups : null;
    if (!groups || typeof groups !== 'object') return null;
    for (const name of Object.keys(groups)) {
        const g = groups[name];
        if (!g || typeof g !== 'object') continue;
        if (normList(g.fields).includes(String(field))) {
            return {
                name,
                fields: normList(g.fields),
                expect: String(g.expect || 'expected'),
                anyOf: g.anyOf !== false,          // 缺省就是"任一有就算有"（组的本意）
                why: String(g.why || '')
            };
        }
    }
    return null;
}

/**
 * 这一组在这条节点上的**现有值**（`[{field, value}]`，按成员顺序）。
 * `opts.shownValue` 给了就用它（界面上那个值），否则退回缓存字段。
 */
export function groupValues(registry, node, groupName, opts = {}) {
    const groups = (registry && registry.groups) || {};
    const g = groups[groupName];
    if (!g || !node) return [];
    const out = [];
    for (const f of normList(g.fields)) {
        const value = typeof opts.shownValue === 'function' ? opts.shownValue(node, f) : node[f];
        if (isFilledValue(value)) out.push({ field: f, value });
    }
    return out;
}

/**
 * 这一组**现在显示哪个成员**（数值难度需要**快捷切换所查看系列**）。
 *
 * 选择规则（**只有一条**，别在别处再写一遍）：
 *   ① `trust.groupPrefer[组名]` 指定的那个成员 —— 它**有值**就用它（用户显式选过，最高）；
 *   ② 否则按**注册表里的成员顺序**取第一个有值的（顺序就是优先级声明：`cfDifficulty` 在 `atcoderDifficulty` 前）；
 *   ③ 都没有 ⇒ `null`（这一组是缺的）。
 *
 * ⚠️ 组偏好只管**显示口径**，不碰各成员自己的值（每个来源的值都还在来源层里，随时切回来）。
 *
 * @returns {?{field:string, value:*, pickedBy:'prefer'|'order', others:Array<{field,value}>}}
 */
export function pickInGroup(registry, node, group, opts = {}) {
    const name = typeof group === 'string' ? group : (group && group.name);
    if (!name || !node) return null;
    const has = groupValues(registry, node, name, opts);
    if (!has.length) return null;
    const prefer = String(getGroupPrefer(opts.trust, name) || '');
    const hit = prefer ? has.find(x => x.field === prefer) : null;
    const chosen = hit || has[0];
    return {
        field: chosen.field,
        value: chosen.value,
        pickedBy: hit ? 'prefer' : 'order',
        others: has.filter(x => x.field !== chosen.field)
    };
}

/**
 * **界面上该用哪个数值难度字段**（显示数值难度、可快捷切换）。
 *
 * 规则**只有这一条**（四处调用：树上标题 / 小方框预览 / 题目分布统计 / 字段条那一行）：
 *   组的当前口径（`pickInGroup`：用户偏好 > 成员顺序）→ **没有注册表（老包）⇒ `cfDifficulty`**。
 *
 * @returns {string} 字段名（永远有值，兜底 `cfDifficulty`）
 */
export function difficultyFieldOf(state, node, opts = {}) {
    const registry = opts.registry !== undefined ? opts.registry : (state && state.fieldRegistry);
    const pick = pickInGroup(registry, node, '数值难度', {
        trust: opts.trust !== undefined ? opts.trust : (state && state.trust),
        shownValue: opts.shownValue
    });
    return pick ? pick.field : 'cfDifficulty';
}

/** 同上，取**值**（0 = 未定） */
export function difficultyValueOf(state, node, opts = {}) {
    const field = difficultyFieldOf(state, node, opts);
    const valueOf = opts.shownValue || ((n, f) => n && n[f]);
    const n = Number(valueOf(node, field));
    return { field, value: Number.isFinite(n) ? n : 0 };
}

/** 读组偏好（`trust` 可能没归一化，这里容错；真正的归一化在 `core/trust.js`） */
function getGroupPrefer(trust, group) {
    const table = trust && typeof trust === 'object' ? trust.groupPrefer : null;
    if (!table || typeof table !== 'object') return '';
    const v = table[group];
    return v === undefined || v === null ? '' : String(v);
}

/**
 * 组级那一行 HTML：`难度（数值）：CF 2000` + 其余成员的**快捷切换**按钮。
 *
 * 组成员自己那一行（`expectNoteHtml`）仍然照常显示 —— 组回答"这道题到底有没有数值难度"、
 * "我现在看的是哪个口径"，成员回答"这个来源给没给"；两者**不互相替代**
 * （只看成员会把"CF 有、AtCoder 没有"报成缺口，那是正常的）。
 *
 * @returns {string} 不属于任何组 / 没有注册表 ⇒ 空串
 */
export function groupNoteHtml(registry, node, field, opts = {}) {
    const g = groupOfField(registry, field);
    if (!g || !node) return '';
    const pick = pickInGroup(registry, node, g, opts);
    if (!pick) {
        const color = expectColorOf(g.expect);   // 三档三色只有一处
        return `<span style="color:${color};" title="${escapeAttr(g.why)}">`
            + `${escapeAttr(g.name)}：缺（${g.fields.map(shortFieldLabel).join(' / ')} 都没有）</span>`;
    }
    const picked = opts.trust && getGroupPrefer(opts.trust, g.name)
        ? '（你选的）' : '';
    const head = `<span style="color:#334155;" title="${escapeAttr(g.why)}">`
        + `${escapeAttr(g.name)}：<b>${escapeAttr(shortFieldLabel(pick.field))} `
        + `${escapeAttr(String(pick.value))}</b>${picked}</span>`;
    // 其余成员：快捷切换（点一下就换显示口径；再点同一个可以取消偏好）
    const peers = pick.others.length
        ? '　' + pick.others.map(x => groupPickBtn(node, g.name, x)).join('')
        : '';
    const reset = picked
        ? '　' + groupClearBtn(node, g.name)
        : '';
    return head + peers + reset;
}

/** 快捷切换按钮：`切到 atcoder -848` */
function groupPickBtn(node, group, one) {
    return `<button type="button" class="src-act" data-src-act="group-pick"`
        + ` data-node="${escapeAttr(node && node.id)}" data-group="${escapeAttr(group)}"`
        + ` data-field="${escapeAttr(one.field)}"`
        + ` title="${escapeAttr(`这一组以后显示 ${one.field} 的值`)}"`
        + ' style="font-size:11px;padding:0 6px;margin-left:4px;border:1px solid #cbd5e1;'
        + 'background:#f8fafc;border-radius:4px;cursor:pointer;color:#475569;">'
        + `切到 ${escapeAttr(shortFieldLabel(one.field))} ${escapeAttr(String(one.value))}</button>`;
}

/** 取消组偏好（回到"按成员顺序取第一个有值的"） */
function groupClearBtn(node, group) {
    return `<button type="button" class="src-act" data-src-act="group-clear"`
        + ` data-node="${escapeAttr(node && node.id)}" data-group="${escapeAttr(group)}"`
        + ` title="取消这一组的显示偏好，回到按成员顺序自动选"`
        + '" style="font-size:11px;padding:0 6px;margin-left:4px;border:1px solid #cbd5e1;'
        + 'background:#fff;border-radius:4px;cursor:pointer;color:#94a3b8;">取消偏好</button>';
}

/** `cfDifficulty` → `cf`、`atcoderDifficulty` → `atcoder`（组里显示用；认不出就原样） */
function shortFieldLabel(field) {
    const s = String(field || '');
    const m = /^(.*)Difficulty$/.exec(s);
    return m && m[1] ? m[1] : s;
}

/**
 * 一个字段在这一条节点上的「应有 / 已有」。
 *
 * ⚠️ **「已有」问的是"界面上那个值"**，不是缓存字段：编辑弹窗显示的是**投影值**
 *   （`view/view/scope.js` 的 `viewValue`：按来源优先级/账户/失效标记算出来的）。
 *   拿 `node[field]`（缓存字段）比会与界面上看到的不一致，
 *   所以调用方**传 `opts.shownValue`**（缺省才退回 `node[field]`）。
 *
 *   ⚠️ 这个名字**不能**叫 `valueOf` —— 那会命中 `Object.prototype.valueOf`（每个对象自带的函数），
 *   `typeof opts.valueOf === 'function'` **永远为真**，于是算出的是 opts 自己这个对象 ⇒
 *   **有值也被判成空**（单测钉住）。
 *
 * @param {Object} registry - 包顶层那份 `fieldRegistry`（没有 ⇒ 返回 null，界面就不显示这一行）
 * @param {Object} node
 * @param {string} field
 * @param {Object} [opts] - `{ parentOf, shownValue }`；`shownValue(node, field)` 给"界面上显示的值"
 * @returns {?{level:string, label:string, applies:boolean, hasValue:boolean, evidence:boolean, why:string}}
 */
export function expectOf(registry, node, field, opts = {}) {
    const rule = ruleOf(registry, field);
    if (!rule || !node) return null;
    const type = nodeTypeOf(node);
    const types = normList(rule.types && rule.types.length ? rule.types : ['*']);
    if (normList(rule.notTypes).includes(type)) return null;      // 明确不适用的类型
    if (!types.includes('*') && !types.includes(type)) return null;
    const value = typeof opts.shownValue === 'function' ? opts.shownValue(node, field) : node[field];
    return {
        level: String(rule.expect || 'optional'),
        label: EXPECT_LABEL[String(rule.expect || 'optional')] || String(rule.expect || 'optional'),
        applies: predicateHolds(rule, node, opts),
        hasValue: isFilledValue(value),
        // `coverage: false` = **整个字段不参与体检**（有能力填但决定不填，
        // 如 `tags`）—— 构建侧 `field-coverage.py` 的 `rules_for()` 直接跳过它，这里只用来
        // 把话说清楚（否则用户看到"应有：可有可无 / 无"会以为是个缺口）。
        noCoverage: rule.coverage === false,
        // `when.evidence` = "这一格的**实际有**另有参考源"（CF 题目页面）——
        // 应用侧判不了，只提一句；判定在构建侧（`scripts/field-coverage.py`）。
        evidence: !!(rule.when && rule.when.evidence),
        why: String(rule.why || '')
    };
}

/**
 * 字段条的「应有 / 已有」标记（一行 HTML）。
 *
 * @returns {string} 没有注册表 / 规则不认这个字段 ⇒ 空串（**不显摆**）
 */
export function expectNoteHtml(registry, node, field, opts = {}) {
    const got = expectOf(registry, node, field, opts);
    if (!got) return '';
    if (got.noCoverage) {
        // 整个字段不参与体检（`coverage: false`，如 `tags`）—— 不是"缺"，是**有意不填**。
        return '<span style="color:#cbd5e1;" title="注册表里这个字段标了「不参与体检」：'
            + '有能力填但决定不填，缺了不算缺口（理由见注册表的 why）">应有：不查</span>';
    }
    if (!got.applies) {
        // 谓词不成立 = "这个字段跟这条节点无关"（如 `name` 对提交、`cfDifficulty` 对 gym）
        return '<span style="color:#cbd5e1;" title="注册表里这条规则不适用于它（谓词不成立）">应有：不适用</span>';
    }
    const missing = !got.hasValue;
    // 缺的时候按档位给颜色：必须有 = 红、应该有 = 琥珀、可有可无 = 灰
    const color = missing ? expectColorOf(got.level) : EXPECT_COLOR.optional;
    const title = got.why ? ` title="${escapeAttr(got.why)}"` : '';
    const mark = missing ? (got.level === 'optional' ? '无' : '缺') : '有';
    const tail = missing && got.evidence
        ? '（若题目页面上也没有，体检会算作"实际没有"）' : '';
    return `<span style="color:${color};"${title}>应有：${escapeAttr(got.label)}`
        + ` · 已有：${mark}${tail}</span>`;
}

function escapeAttr(s) {
    return String(s === undefined || s === null ? '' : s)
        .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
        .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
