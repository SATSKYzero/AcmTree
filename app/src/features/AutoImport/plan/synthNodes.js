// ================================================================
// 合成节点的**规划**（features/AutoImport/plan/synthNodes.js）
//
// 阶段 1（合成节点）的全部判据 —— 父容器类型预检、
// 被拒条目的剔除、以及"父建不出来 ⇒ 子也拒绝"的级联。
// ================================================================
import { SYNTH_TYPES } from '../../../core/ops/synth.js';
import { TYPE_CHILDREN_MAP, badParentTypeMessage } from '../../../core/model/constants.js';
import { clueOf } from '../../../core/accounts.js';
import { computeMerge } from '../merge.js';
import { inapplicableFields } from '../../../core/model/elements.js';
import { natureDiffOf, prepareRecords } from './prepare.js';

export function planSynthNodes({ prepped, state, index, synthIdx, synthTypes, policies, errors, knownSynthKeys,
                          forceNature = false, forced = { n: 0 } }) {
    const records = prepped.filter(it => it.synthKey && !it.extKey && !it.error);

    // 包内 `synthKey` 重复：参与的每条都**不建**（与 extKey 重复同一口径，3.2）。
    // ⚠️ 逐条**报错**的那一次在 `resolve.js` 的 `duplicate-synthkey`（它必须更早 ——
    //    父引用 `父synthKey` 指向谁不能有歧义）。这里只做一件事：把重复的那些
    //    从第一阶段清单里摘掉，于是它们**不进 `knownSynthKeys`** ——
    //    指向它们的成员指针会被判悬空而拒绝，不会悄悄挂到一个"随便挑的"节点上。
    const byKey = new Map();
    for (const it of records) {
        if (!byKey.has(it.synthKey)) byKey.set(it.synthKey, []);
        byKey.get(it.synthKey).push(it);
    }
    for (const [, list] of byKey) {
        if (list.length < 2) continue;
        for (const it of list) it.error = true;
    }

    // ---- 第一趟：逐条校验 —— 先只产出**候选**，不登记身份、不进执行清单 ----
    // 为什么要分两趟：父容器类型预检需要一张"本包会建出来的合成标识 → 类型"的表，
    // 而那张表必须等**全部**候选校验完才准 —— 包完全可以把子写在父前面（两阶段
    // 时序），单趟里父的类型还没轮到登记，预检就会漏判（漏判 = 放行一条
    // 执行时必然失败的条目，正是要消掉的那种不一致）。
    const candidates = [];
    for (const it of records) {
        if (it.error) continue;
        const rec = it.rec;
        const fields = it.mapped.fields;

        if (it.ownerSynth) {
            it.error = true;
            errors.push({
                code: 'synth-node-with-owner',
                index: rec.index,
                message: `合成节点（synthKey "${it.synthKey}"）不能有「所属合成节点」`
                    + '—— 成员名单不能嵌套（core/ops/synth.js）'
            });
            continue;
        }

        const type = String(rec.type || '').trim().toUpperCase();
        if (!SYNTH_TYPES.includes(type)) {
            it.error = true;
            errors.push({
                code: 'synth-bad-type',
                index: rec.index,
                message: `不能合成 ${type} 节点：合成只在 ${SYNTH_TYPES.join(' / ')} 上做`
                    + '（比赛 W / 系列 S / 平台 O 不参与合成）'
            });
            continue;
        }

        const holderId = synthIdx.byKey.get(it.synthKey);
        const existing = holderId && state && state.nodes ? state.nodes[holderId] : null;
        if (existing && existing.type !== type) {
            it.error = true;
            errors.push({
                code: 'synth-type-mismatch',
                index: rec.index,
                message: `synthKey "${it.synthKey}" 命中的既有合成节点是 ${existing.type} 类型，`
                    + `而记录声明为 ${type}`
            });
            continue;
        }

        const notApplicable = inapplicableFields(type, fields);
        if (notApplicable.length) {
            it.error = true;
            errors.push({
                code: 'field-not-applicable',
                index: rec.index,
                message: `${type} 节点不适用字段：${notApplicable.join('、')}`
                    + '（见 core/model/elements.js 的 types 声明）'
            });
            continue;
        }

        const merge = computeMerge({ type, incoming: fields, existing, overrides: policies });

        // 「以包里为准」对**合成节点**同样生效（它也是 C 节点、性质来自同一份清单）
        const natureDiff = natureDiffOf(fields, existing, rec.raw);
        if (forceNature && natureDiff.length) {
            for (const d of natureDiff) {
                merge.fields[d.field] = d.newValue;
                d.forced = true;
                forced.n++;
                const dec = merge.decisions.find(x => x.field === d.field);
                if (dec) {
                    dec.applied = true;
                    dec.reason = '「以包里为准」（预览里勾的）：用包里的性质覆盖树上的';
                }
            }
        }

        const action = !existing ? 'create'
            : (Object.keys(merge.fields).length > 0 ? 'update' : 'skip');

        candidates.push({ it, rec, type, existing, merge, action, natureDiff });
    }

    // 本包**建得出来**的合成标识 → 记录声明的类型（父容器类型预检用）。
    // ⚠️ 只收**过了第一趟校验**的那些：一个建不出来的合成父（类型不在 SYNTH_TYPES、
    //    带成员指针、字段不适用 …）不在这里 —— 子记录会走"父建不出来 ⇒ 子也拒绝"
    //    那条路径（rejectOrphanSynthParents），由它说清"是哪条父"，不让类型预检抢答。
    const declaredSynthTypes = new Map();
    for (const c of candidates) declaredSynthTypes.set(c.it.synthKey, c.type);

    // 本包**新建**的普通父容器 → 记录声明的类型（`父extKey` 指向同批新建的父时要用）。
    // 两个身份写在一起的记录恒被拒（`synthkey-with-extkey`，第 4 步），建不出节点 ⇒ 不收。
    const declaredExtTypes = new Map();
    for (const it of prepped) {
        if (!it.extKey || it.synthKey) continue;
        const type = String(it.rec.type || '').trim().toUpperCase();
        if (type) declaredExtTypes.set(it.extKey, type);
    }

    // ---- 第二趟：父容器**归属**预检 + 落执行清单 ----
    const nodes = [];
    for (const c of candidates) {
        const { it, rec, type, existing, merge, action, natureDiff } = c;

        // 只有**新建**才需要预检：更新/跳过的那条，节点已经在树上待着了，
        // 位置不会再由父引用决定（synthApply 的更新分支不看父引用）。
        if (action === 'create') {
            // ① 合成节点**必须**显式给父容器（父extKey / 父synthKey 恰好一个）。
            //    树根是 O，而 `TYPE_CHILDREN_MAP` 里 O 只允许 W / S；合成节点只能是
            //    C/P/R（`SYNTH_TYPES`）⇒ **合成节点在根下永远放不下**。所以"两种父
            //    引用都不给"对合成节点一定是错的：预览里就该逐条拒绝，而不是算
            //    "新建 N"、点执行后逐条失败（预览与结果不符）。
            //    ⚠️ 这条**只管合成节点**：普通记录不给父引用 = 挂真实根，是合法的（3.3）。
            if (!it.parentExtKey && !it.parentSynthKey) {
                it.error = true;
                errors.push({
                    code: 'synth-parent-required',
                    index: rec.index,
                    message: `合成节点（synthKey "${it.synthKey}"，${type} 类型）没有父容器：`
                        + '两种父引用都留空 = 挂真实根节点，而根是 O 类型 —— '
                        + `按类型层级 O 只允许 ${(TYPE_CHILDREN_MAP.O || []).join(' / ')}，`
                        + `${type} 放不下（合成节点只能是 ${SYNTH_TYPES.join(' / ')}）。该条不导入。`
                        + '处理：用 父extKey 指出一个普通父容器，或把 父synthKey 指向另一个合成节点'
                        + '（判据唯一一份：core/model/constants.js 的 TYPE_CHILDREN_MAP）'
                });
                continue;
            }

            // ② 父容器**类型**必须允许这个子节点 —— 判据与**那句话**都在
            //    `core/model/constants.js` 的 `badParentTypeMessage`（别在这里重抄句式：
            //    抄一遍就会与预览 / 落地 / 产包合并三处漂成两句不同的话）。
            const parent = synthParentContainerOf(it, {
                state, index, synthIdx, declaredSynthTypes, declaredExtTypes
            });
            const typeMsg = parent
                ? badParentTypeMessage(parent.type, type, {
                    parentKey: parent.key, childKey: it.synthKey, parentCol: parent.col
                })
                : '';
            if (typeMsg) {
                it.error = true;
                errors.push({
                    code: 'synth-bad-parent-type',
                    index: rec.index,
                    message: `合成节点（synthKey "${it.synthKey}"，${type} 类型）挂不上：${typeMsg}`
                        + ' —— 该条不导入。'
                });
                continue;
            }
        }

        // ★ 本包**新建**的合成标识从此刻起就是"已知目标"（成员指针据此判悬空）
        knownSynthKeys.add(it.synthKey);
        synthTypes.set(it.synthKey, type);
        nodes.push({
            index: rec.index,
            synthKey: it.synthKey,
            type,
            parentExtKey: it.parentExtKey,
            // 父是合成节点时的写法（执行层按它解析出父节点 id）。
            // 两种写法在 parse/resolve 已按同一套判据裁定"恰好给一个"，这里只做搬运。
            parentSynthKey: it.parentSynthKey,
            action,
            nodeId: existing ? existing.id : null,
            fields: merge.fields,
            decisions: merge.decisions,
            accountClue: clueOf(rec.raw),
            // 合成节点的性质与成员一样来自清单 ⇒ 同样报"与树上不一致"（它也是 C 节点）。
            // ⚠️ 差异在**第一趟**就算好了（勾了「以包里为准」时 `merge.fields` 已经跟着改过）。
            natureDiff
        });
    }
    return nodes;
}

/**
 * 合成节点的**父容器类型**预检 —— 计划阶段就判出"这条挂不上"。
 *
 * 为什么必须在计划层判：真节点落地时 `createSynthNode` → `addChild` 会按
 * `TYPE_CHILDREN_MAP`（core/model/constants.js）校验"这个父容器的类型允不允许
 * 这个子节点"。计划层看不到这一层的话，预览就会把挂不上去的条目算成
 * "新建/更新合成节点 N"，点执行后逐条失败 —— 用户看到的预览与结果不符。
 *
 * 父容器的类型按**两种父引用**（恰好给一个，resolve.js 已裁定）分别解析：
 *   · `父synthKey` → 父是合成节点：先看**树上**那个合成节点（它已经是既成事实），
 *     再看**本包**里那条合成节点记录声明/建成后的类型（两阶段：父可以在同一次
 *     导入里新建 —— 包的先后顺序不影响，见 `declaredSynthTypes`）；
 *   · `父extKey`  → 父是普通节点：同样"树上优先、本包新建的按记录声明的类型"。
 * （两种都不给 = 想在根下建合成节点：那种记录在调用点就被 `synth-parent-required`
 *   拒了 —— 根是 O，O 只允许 W / S，而合成节点只能是 C/P/R，永远放不下。）
 *
 * ⚠️ 判据只此一份：`TYPE_CHILDREN_MAP`。这里绝不抄一份类型表。
 *
 * @returns {{type:string, key:string, col:string}|null} 父容器的类型、它的键、以及
 *          父引用**写在哪一列**（`父extKey` / `父synthKey`）；
 *          **null = 此刻无从得知**（父引用解析不出来、父记录自己还没过关）
 *          → 不在这里判，交给"父建不出来 ⇒ 子也拒绝"那条路径说清原因。
 */

function synthParentContainerOf(it, { state, index, synthIdx, declaredSynthTypes, declaredExtTypes }) {
    const nodes = (state && state.nodes) || {};
    const typeOfId = id => {
        const node = id ? nodes[id] : null;
        return node ? String(node.type || '').trim().toUpperCase() : '';
    };

    if (it.parentSynthKey) {
        const key = String(it.parentSynthKey);
        const col = '父synthKey';
        const holderId = synthIdx && synthIdx.byKey ? synthIdx.byKey.get(key) : '';
        const onTree = typeOfId(holderId);
        if (onTree) return { type: onTree, key, col };
        const declared = declaredSynthTypes.get(key);
        return declared ? { type: declared, key, col } : null;
    }

    if (it.parentExtKey) {
        const key = String(it.parentExtKey);
        const col = '父extKey';
        const onTree = typeOfId(index ? index[key] : '');
        if (onTree) return { type: onTree, key, col };
        const declared = declaredExtTypes.get(key);
        return declared ? { type: declared, key, col } : null;
    }

    return null;   // 两种父引用都不给：调用点已按 `synth-parent-required` 拒掉
}

/**
 * 把**计划层已判为拒绝**的合成节点从执行清单里摘掉（就地撤销身份登记）。
 *
 * 为什么需要：`planSynthNodes` / `rejectOrphanSynthParents` 逐条报错时，
 * 被拒的条目可能**已经**躺在执行清单里（级联：父容器类型挂不上 ⇒ 挂在它下面的
 * 那个合成节点是它唯一的子，但子自己的父-子类型组合可能是合法的）。
 * 留在清单里的后果有两个，都是"预览与结果不符"：
 *   ① 预览按它算"新建/更新合成节点 N"，执行时逐条失败；
 *   ② 它被当成"已知合成标识"，指向它的成员指针在预览里显示"待设置"，
 *      执行时却因为目标建不出来而被拒。
 * 所以这里一并**撤销**它在 `knownSynthKeys` / `synthTypes` 里的登记 ——
 * 指向一个建不出来的合成节点，本来就该在预览里判悬空（写路径铁律）。
 *
 * ⚠️ 只摘 `action === 'create'` 的那一条：树上已经有这个合成节点时
 *    （update / skip），即使这条记录被连带标错，树上那个节点照样要更新 ——
 *    摘掉是错的。树上的合成标识也不撤销登记（它是既成事实，指针目标依然合法）。
 */

export function dropRejectedSynthNodes(nodes, prepped, { knownSynthKeys, synthTypes, treeSynthKeys }) {
    const rejected = new Set();
    for (const it of prepped) {
        if (it.error && it.synthKey && !it.extKey) rejected.add(it.synthKey);
    }
    if (rejected.size === 0) return nodes;

    const kept = [];
    for (const n of nodes) {
        if (n.action === 'create' && rejected.has(n.synthKey)) {
            if (!(treeSynthKeys && treeSynthKeys.has(n.synthKey))) {
                knownSynthKeys.delete(n.synthKey);
                synthTypes.delete(n.synthKey);
            }
            continue;
        }
        kept.push(n);
    }
    return kept;
}

/**
 * `父synthKey` 的逐条裁定 —— **父自己建不出来，子也不许挂**。
 *
 * 为什么需要这一步（resolve.js 看不见的那一半）：
 *   `resolve.js` 只按**身份键**解析父引用（包内有没有、树上有没有），
 *   它不判断"那个父记录**能不能建出来**"。而合成节点会因为类型不对、
 *   带成员指针、字段不适用等原因在 `planSynthNodes` 里被逐条拒绝 ——
 *   此时子记录的父引用就悬空了。若不处理，`synthApply` 会解析不到父，
 *   把子节点**静默挂到根下**（那是"会产生错误结果"的静默失效）。
 *
 * 口径与 `resolve.js` 的坏记录传播一致：父的记录已被拒绝 ⇒ 子逐条拒绝，
 * 并说清"是哪一条父"。三层嵌套时沿父链一路上溯，一次传播到全部下游。
 *
 * @param {Array<Object>} prepped - prepareRecords 的产物（就地标 `error`）
 * @param {Array<Object>} synthNodes - planSynthNodes 的执行清单（**不含**被拒的那些）
 * @param {Array<Object>} errors - 就地追加逐条错误
 */

export function rejectOrphanSynthParents(prepped, synthNodes, errors) {
    /** synthKey → 承载它的 prepped 项（重复时保留第一条：仅用于上溯，重复本就全被拒） */
    const byKey = new Map();
    /** 计划层判为"这条建不出来"的记录：synthKey 非空、却没有进执行清单 */
    const rejectedSynth = new Set();

    for (const it of prepped) {
        if (!it.synthKey || it.extKey) continue;
        if (!byKey.has(it.synthKey)) byKey.set(it.synthKey, it);
    }
    const planned = new Set(synthNodes.map(n => n.synthKey));
    for (const key of byKey.keys()) {
        if (!planned.has(key)) rejectedSynth.add(key);
    }
    if (rejectedSynth.size === 0) return;

    /**
     * 一个项**能不能**挂到父合成节点下。
     * ⚠️ 只判"父记录进没进执行清单"，**不**在这里判"树上有没有" ——
     *    后者是 `resolve.js` 的职责（它已经把"两边都找不到"拒掉了）。
     */
    const canAttach = (it) => {
        const key = it.parentSynthKey;
        if (!key) return true;
        if (rejectedSynth.has(key)) return false;
        const parent = byKey.get(key);
        return parent ? canAttach(parent) : true;
    };

    /** 说清"到底是哪一条父建不出来"（三层嵌套时一路上溯） */
    const reasonOf = (it) => {
        const key = it.parentSynthKey;
        if (rejectedSynth.has(key)) {
            const parent = byKey.get(key);
            const upstream = parent && parent.parentSynthKey ? reasonOf(parent) : '';
            return `父合成节点（synthKey "${key}"，第 ${parent ? parent.rec.index : '?'} 条）`
                + '那条记录已被拒绝，建不出这个父' + (upstream ? `；再往上：${upstream}` : '');
        }
        return `父合成节点不存在：父synthKey = "${key}"`;
    };

    for (const it of prepped) {
        if (it.error || !it.parentSynthKey || it.extKey) continue;
        if (canAttach(it)) continue;
        it.error = true;
        errors.push({
            code: 'parent-not-found',
            index: it.rec.index,
            message: `合成标识 "${it.synthKey}" 无法挂接：${reasonOf(it)}。`
                + '处理：修好那条父记录，或把它改成挂到普通父容器下（父extKey）'
        });
    }
}

/**
 * **第二阶段**：成员指针 → 执行清单（set / same / reject）。
 *
 * 四条口径（§6.3 第 8、9 条）：
 *   1. 默认 `overwrite-if-changed`：值相同 → `same`（不写、不碰 lastModified）；
 *   2. 树上已有**非空**指针且与包内不同 → `reject`（包不得覆盖；预览里单独列出来）；
 *   3. **目标不存在**（树上没有、本包里也没有）→ `reject`：写路径不许产生悬空指针
 *      （不"照写 + 标黄"；悬空只留给文件里的历史数据，读路径仍然标黄 + 一键清理）；
 *   4. **写的是节点 id 而不是合成标识** → `reject`（与 ③ 同一条出口，文案单独说清）。
 *
 * 被拒绝的条目只在预览里报告差异，**一个字节都不写**（与 apply 层同一口径）。
 */
