// ================================================================
// 回代 baseline：把「人定过的 nature」收成一份文件（core/natureAssignments.js）
//
// 口径：手改的 nature 标为 `M`，并从这里开始做回代。
//
// 这是什么
// --------
// `docs/manual-workflow.md`（回代三件套） 定的三件套里那个 **③ `assignments.json`**：
//
//     ① 注册表（`acm-data/nature-registry.json`，已有）
//     ② 规则（爬虫侧，已落成元列 `分类依据` 里的规则 id）
//     ③ **对 crate 的增量**：`identity → 字段 → {值, 优先级, 规则id, 来源}`
//
// ③ 的意义（§466 的"回代闭环"）：**脚本产出 → 人在应用里补/接受 → 应用导出 ③
// → 下次脚本跑先读它做 baseline**。没有它，"我改过的那些"会在下一次重跑里
// 被规则重新推一遍（结果可能不同），"既定效果"就保不住。
//
// **只收人定过的**（`分类依据` 里写着 `manual:set`，级别 `M`）：
// 剩下的值全是**规则的产物** —— 脚本重跑一遍就能复现，不必往回带。
// 于是这份文件通常很小（就是"你手填过的那几十条"），diff 起来也清楚。
//
// ⚠️ 本模块**纯函数、不碰 DOM、不读盘**（注册表由 `core/natureFields.js` 读，
//    生成时间由调用方传）—— 这样它能在 Node 单测里直接跑。
// ================================================================
import { NATURE_FIELD_KEYS } from './natureFields.js';
import { CLASS_RULE_COL, MANUAL_RULE, classRulesOf, MANUAL_LEVEL, levelOfClassRule } from './natureConfidence.js';
// 判"这个键是不是我们脚本产的"：`core/synthPlan.js` 是纯函数模块（不碰 DOM/盘）⇒ 可以在这儿用
import { isScriptKey } from './synthPlan.js';
// 「人确认过这一组」那一格的名字（唯一定义在属性表里）
import { CONFIRM_FIELD_NAME, SPLIT_FIELD_NAME } from './model/elements.js';

/**
 * 指针字段名（`ops/synth.js` 的 `OWNER_FIELD`）。
 *
 * ⚠️ 这里**手抄一份**（而不是 import）：`ops/synth.js` 会牵进模型与账户那一套，
 *    而本模块要能在**纯 Node 单测**里跑（见文件头）。两份由单测钉住相等。
 */
const OWNER_FIELD = 'ownerSynth';

/** 文件格式标识（`scripts/nature-baseline.py` 按它认文件；写错要当场拒） */
export const ASSIGNMENTS_FORMAT = 'nature-assignments';

/** 格式版本（加字段不升版本；改形状才升） */
export const ASSIGNMENTS_VERSION = 1;

/**
 * "这条值是人手填的"在**来源层**里的出处 id。
 *
 * ⚠️ 与 `core/fieldValue.js` 的 `MANUAL_SRC` **是同一个值** —— 这里手抄一份是因为
 *    `fieldValue.js` 会牵进值投影那套（本模块要能在纯 Node 单测里跑）。
 *    两份由 `src/test/natureAssignments.test.js` 钉住相等（照 `dedup.js` 抄字段名单的先例）。
 */
export const MANUAL_SRC = 'manual';

/** 值在来源层里的那一条（找"是不是手填的"以及它的时间/账户） */
function manualEntryOf(node, field, value) {
    // ⚠️ `node.values` 是**一个对象**（字段 → 该字段的值列表），不是数组 ——
    //    写成 `Array.isArray(node.values)` 会永远找不到 ⇒ `at`/`account` 一直是空
    //    （来源层里明明有一条 `src: 'manual'`）。
    const bag = node && node.values;
    const list = (bag && typeof bag === 'object') ? bag[field] : null;
    if (!Array.isArray(list)) return null;
    const want = String(value === undefined || value === null ? '' : value).trim();
    // 同值多条时取**最后**一条（来源层是追加的，最后一条 = 最近那次改动）
    let hit = null;
    for (const one of list) {
        if (!one || one.src !== MANUAL_SRC) continue;
        if (String(one.v === undefined || one.v === null ? '' : one.v).trim() === want) hit = one;
    }
    return hit;
}

/**
 * 收集**回代 baseline**（③）。
 *
 * @param {Object} state - `{nodes, ...}`（只读）
 * @param {Object} [opts]
 * @param {string} [opts.generatedAt=''] - ISO 时间（**纯函数不取系统时间**，由调用方给）
 * @param {number} [opts.registryVersion=0] - 注册表版本（给脚本做"两边对不对得上"的判断）
 * @returns {{format:string, version:number, generatedAt:string, registryVersion:number,
 *            count:number, fields:number, assignments:Array<Object>}}
 */
export function collectNatureAssignments(state, opts = {}) {
    const nodes = (state && state.nodes) || {};
    const out = [];
    let fieldCount = 0;

    // 按 **extKey** 排序（= 身份）⇒ 文件稳定、diff 干净。
    // 没有 extKey 的（合成节点）排**最后**，它们之间按 id 排。
    const ids = Object.keys(nodes).filter(id => nodes[id] && typeof nodes[id] === 'object');
    const keyOf = id => String(nodes[id].extKey || '').trim();
    ids.sort((a, b) => {
        const ka = keyOf(a); const kb = keyOf(b);
        if (!!ka !== !!kb) return ka ? -1 : 1;
        const na = ka || String(nodes[a].id || a);
        const nb = kb || String(nodes[b].id || b);
        return na < nb ? -1 : (na > nb ? 1 : 0);
    });

    for (const id of ids) {
        const node = nodes[id];
        // ★ **组头（合成节点）不进这份导出**：它那四个性质是**按成员派生**的
        //   （`pickGroupNature`），人改不了它（编辑弹窗不给这四格、③ 也不列它）——
        //   派生时会把**胜出成员那格**的规则 id 原样抄到组头，于是组头也会写成
        //   `manual:set`。把它当"人的结论"导出，会得到一堆**回声**：组头一旦改名
        //   （信息补全会换键），这些条目就变成"手填成了孤儿"（实测：陕西/浙江两条
        //   就是这么来的），而值本来就能从成员重新推出来。
        //   ⚠️ **`ownerSynth` 那一段（手工绑定的归属）不受影响**：它在成员上，下面单独收集。
        if (String(node.synthKey || '').trim()) continue;
        const rules = classRulesOf(node);
        const fields = {};
        for (const key of NATURE_FIELD_KEYS) {
            const raw = node[key];
            const v = String(raw === undefined || raw === null ? '' : raw).trim();
            if (!v) continue;                       // 空值不算"定过"
            // **两个信号都认**（谁先出现就用谁）：
            //   ① 元列 `分类依据` 写着 `manual:set`（手改会标）；
            //   ② 值级来源层里那条**就是手填的**（`src: 'manual'`）——
            //      ⚠️ 这一条覆盖"标记机制出现**之前**就手填好的值"（老数据里那些），
            //      否则第一次导出会把它们全漏掉（手填的那几十条都在这一类里）。
            const entry = manualEntryOf(node, key, v);
            const isManual = rules[key] === MANUAL_RULE || !!entry;
            if (!isManual) continue;                // 规则产物：脚本重跑能复现，不必带
            fields[key] = {
                v,
                // 优先级：§10.3 的全序里 **manual 最高** —— 脚本读它来决定"要不要让规则说话"
                priority: MANUAL_LEVEL,
                rule: MANUAL_RULE,
                src: MANUAL_SRC,
                at: (entry && entry.at) || '',
                account: (entry && entry.account) || ''
            };
            fieldCount++;
        }
        if (!Object.keys(fields).length) continue;
        out.push({
            extKey: String(node.extKey || '').trim(),
            // 合成节点没有 extKey —— 它是"一组来源的合并视图"（脚本侧按 synthKey 认，
            // 但回代是**按 crate 记录**写的，合成节点在包里也有 extKey？没有）
            synthKey: String(node.synthKey || '').trim(),
            type: String(node.type || ''),
            name: String(node.name || ''),
            fields
        });
    }

    // ★ **手工绑定的合成归属**（`ownerSynth`）也要带回去。
    //   为什么要独立一段：它不是 nature 四个字段里的任何一个，但同样是**人的结论** ——
    //   重出包时脚本只会按 nature 重算，人手绑的那份就丢了。
    //   信号与 nature 同源：**手改那条路**（`ops/synth.js:applyOwnerSynth`）会写
    //   `分类依据.ownerSynth = manual:set`；导入 / 脚本产的一律没有这个标记。
    const bindings = [];
    for (const id of ids) {
        const node = nodes[id];
        const owner = String(node[OWNER_FIELD] || '').trim();
        if (!owner) continue;                                   // 没绑 = 没有约定要留住
        // ★★ **题目组（P 层）的指针不导出** —— 那**不是人的结论**，是"某一版配对算出来的"。
        //   而 P 层的归属**本来每轮都由配对重算**（`core/synthPlan.problemBindPlan` +
        //   `scripts/problem-bind.mjs`），根本不需要"留一份"。
        //   为什么必须堵在这里（实测踩到，用户报"点一次换一次、永远改不动"）：
        //     应用侧那几下动作（「➡️ 改到该键」/ 组头改名）走 `applyOwnerSynth`，
        //     **一律打 `分类依据.ownerSynth = manual:set`** ⇒ 导出时被当成"人的结论"收进去
        //     （实测一次攒了 189 条 P 层）⇒ 回代写进包 ⇒ `problem-bind` 从此跳过它们
        //     （`keptHuman`）⇒ **某一版算错的归属被永久焊死**（一个死循环）。
        //   ⇒ 判据：**只导出 C 层**（"哪一场归到哪个组"），那才是脚本推不出来、必须由人定的东西。
        if (String(node.type || '').trim() === 'P') continue;
        // **两个信号都认**（与 nature 值同一套思路）：
        //   ① 手改那条路留下的 `分类依据.ownerSynth = manual:set`；
        //   ② ②**键不是我们脚本的格式** —— 脚本只会产出 `synth:xcpc:<分支>:…`，
        //      所以"非脚本格式的指针"只可能是人绑的 / 老包带进来的（标记机制之前就有了）。
        //      ⚠️ 没这一条，那些手工绑的归属照样会在重出包时丢掉。
        if (classRulesOf(node)[OWNER_FIELD] !== MANUAL_RULE && isScriptKey(owner)) continue;
        bindings.push({
            extKey: String(node.extKey || '').trim(),
            synthKey: String(node.synthKey || '').trim(),
            type: String(node.type || ''),
            name: String(node.name || ''),
            ownerSynth: owner,
            rule: MANUAL_RULE
        });
    }

    // ★★ **"人确认过这一组"**（`confirmedGroups`）—— **组级标记**，按 `synthKey` 认。
    //   为什么必须导出它：`problem-bind` **每轮重建全部题目组头** ⇒ 不写回包的组头，
    //   你确认过的那些组下一次建包就"忘了"（要重新确认一遍）。
    //   判据：组头节点自己那格 `已确认`（`elements.js` 的 `CONFIRM_FIELD_NAME`）为真。
    const confirmed = [];
    for (const id of ids) {
        const node = nodes[id];
        if (!node || typeof node !== 'object') continue;
        const sk = String(node.synthKey || '').trim();
        if (!sk) continue;                                   // 只有**组头**有合成标识
        if (node[CONFIRM_FIELD_NAME] !== true && node[CONFIRM_FIELD_NAME] !== '是') continue;
        confirmed.push({ synthKey: sk, name: String(node.name || '') });
    }

    // ★★ **「这一条与同号那道题不是同一道」**（`splitMembers`）—— **成员级标记**。
    //   与 `confirmedGroups` 同一类：**人的结论**，不写回包的话下一次建包就忘了
    //   （算法会把它重新并回同号那一组）。按 `extKey` 认（成员的身份就是它）。
    const split = [];
    for (const id of ids) {
        const node = nodes[id];
        if (!node || typeof node !== 'object') continue;
        if (node[SPLIT_FIELD_NAME] !== true && node[SPLIT_FIELD_NAME] !== '是') continue;
        const ext = String(node.extKey || '').trim();
        if (!ext) continue;
        split.push({ extKey: ext, synthKey: String(node.synthKey || ''), name: String(node.name || '') });
    }

    return {
        format: ASSIGNMENTS_FORMAT,
        version: ASSIGNMENTS_VERSION,
        generatedAt: String(opts.generatedAt || ''),
        registryVersion: Number(opts.registryVersion || 0),
        count: out.length,
        fields: fieldCount,
        bindings: bindings.length,
        assignments: out,
        ownerBindings: bindings,
        confirmedGroups: confirmed,
        splitMembers: split
    };
}

/** 一条 assignment 合不合法（给脚本侧与单测用；合法返回 `''`） */
export function assignmentProblem(one) {
    if (!one || typeof one !== 'object') return '不是对象';
    if (!String(one.extKey || '').trim() && !String(one.synthKey || '').trim()) {
        return '既没有 extKey 也没有 synthKey（认不出这条说的是哪个节点）';
    }
    const fields = one.fields;
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return 'fields 不是对象';
    for (const key of Object.keys(fields)) {
        if (!NATURE_FIELD_KEYS.includes(key)) return `未知的性质字段 ${key}`;
        const info = fields[key];
        const v = (info && typeof info === 'object') ? info.v : info;
        if (v === undefined || v === null || String(v).trim() === '') return `${key} 没有值`;
        // 规则 id 必须是"人定的"那一条 —— 这个文件只装人的结论
        const rule = (info && typeof info === 'object') ? info.rule : '';
        if (rule && rule !== MANUAL_RULE) return `${key} 的 rule=${rule} 不是人工标记`;
        if (rule && levelOfClassRule(rule) !== MANUAL_LEVEL) return `${key} 的 rule 级别不是 M`;
    }
    if (!Object.keys(fields).length) return 'fields 是空的';
    return '';
}

/** 一条**绑定**合不合法（合法返回 `''`）—— 与上面同一条纪律：这份文件只装人的结论 */
export function bindingProblem(one) {
    if (!one || typeof one !== 'object') return '不是对象';
    if (!String(one.extKey || '').trim() && !String(one.synthKey || '').trim()) {
        return '既没有 extKey 也没有 synthKey（认不出这条说的是哪个节点）';
    }
    const owner = String(one.ownerSynth || '').trim();
    if (!owner) return '没有 ownerSynth（空 = 解绑，不该写进来）';
    const rule = String(one.rule || '').trim();
    if (rule && rule !== MANUAL_RULE) return `rule=${rule} 不是人工标记`;
    return '';
}

export { CLASS_RULE_COL };
