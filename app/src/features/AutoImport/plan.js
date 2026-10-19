// ================================================================
// 节点自动导入 — 导入计划（features/AutoImport/plan.js）
// 职责：把 crate 变成一份 **dry-run 的 ImportPlan**——算什么、不写状态
// 依赖：./constants.js, 以及本目录的纯逻辑模块（extkey/fieldmap/resolve/
//       contentHash/similarity/merge），core/ops 与 core/validate 的纯函数
//
// 关键性质：
//   1. **本模块不改任何状态**。真正的写入由接线层在一个 execute() 事务里
//      调 core/ops/upsert.js 完成。
//   2. **逐条错误**，不整包报废（docs/auto-import.md 9.2）。
//   3. 相似度**只产生警告，永不参与判定**（4.6）。
//
// 本模块不碰 DOM、不 import view/ shell/，因此可在 Node 单测中直接引用。
// ================================================================
import {
    WRITABLE_FIELDS,
    POLICY,
    DEFAULT_SIMILARITY_THRESHOLD
} from './constants.js';
import { checkKeyConsistency } from './extkey.js';
import { resolveOrder } from './resolve.js';
import { hashRecord } from './contentHash.js';
import { findSimilarSiblings, findIntraBatchDuplicates, differsOnlyByNumbers } from '../../utils/similarity.js';
import { decideAction } from './match.js';
import { computeMerge, validateFieldPolicies, resolvePolicy } from './merge.js';
import { clueOf, resolveClueAndCount, newCounter } from '../../core/accounts.js';
import { classRulesOf } from '../../core/natureConfidence.js';
import { RESERVED_KEYS } from './fieldmap.js';
import { LINK_KIND_PRIORITY } from '../../core/linkKinds.js';
import {
    collectBatchExtKeyConflicts,
    collectExtKeyConflicts
} from '../../core/validate/upsertConflict.js';
import { inapplicableFields } from '../../core/model/elements.js';
// 父容器类型预检：类型层级**唯一一份**判据就在这里（绝不另抄一份 —— 抄两份必然漂移）
import { badParentTypeMessage } from '../../core/model/constants.js';
import {
    normalizeSynthKey,
    synthIndex,
    synthKeyOf,
    SYNTH_TYPES,
    SYNTH_KEY_FIELD,
    OWNER_FIELD
} from '../../core/ops/synth.js';
import {
    collectSiblingMap,
    collectUnused,
    mapRecord,
    mappedAll,
    mergeLinkKindOthers,
    natureDiffOf,
    normalizeKey,
    pickLink,
    prepareRecords,
    readFieldSources,
    readLinkKinds,
    readOtherValues,
    withPickedSource
} from './plan/prepare.js';
import {
    dropRejectedSynthNodes,
    planSynthNodes,
    rejectOrphanSynthParents
} from './plan/synthNodes.js';
import {
    planPointers
} from './plan/pointers.js';

/** 动作枚举（写进 plan，供预览表与执行层共用） */

export const ACTION = Object.freeze({
    CREATE: 'create',
    UPDATE: 'update',
    SKIP: 'skip',
    REJECT: 'reject'
});

/**
 * 交给 applyFieldMap 的结构键黑名单。
 *
 * plan 拿到的是**原始记录**（parse 层的 `raw`），它仍带着身份列，
 * 所以这里必须把中文与英文两种拼写都排掉，否则
 * `节点类型` / `父extKey` 会被误记成"未使用字段"。
 */
const EMPTY_APPLY_FIELD_MAP = () => ({ fields: {}, ignored: [], unmapped: [] });

/**
 * 「性质」四字段（与 `core/natureFields.js` 的 `NATURE_FIELD_KEYS` **同一份名单**）。
 *
 * ⚠️ 这里手抄一份是**有意的**：本模块要能在**纯 Node 单测**里直接跑，而
 * `core/natureFields.js` 顶部 await 读注册表（`fetch` 一份 JSON）——
 * 单测环境不该为了四个字符串名去联网。两份之间由 `src/test/autoImportPlan.test.js` 钉住相等。
 */
export function buildPlan({
    crate,
    state,
    keyIndex,
    applyFieldMap = EMPTY_APPLY_FIELD_MAP,
    similarityThreshold = DEFAULT_SIMILARITY_THRESHOLD,
    // **「以包里为准」**（预览里勾的开关）—— 勾上它，
    // "包里非空、与树上不同"的性质字段就真的写进去（默认 false = 只报不改）。
    forceNature = false
} = {}) {
    const warnings = [];
    const errors = [];
    const records = [];
    /** 因「以包里为准」而真的被覆盖的性质字段数（预览里报给用户看的那句用它） */
    const forcedCounter = { n: 0 };
    const index = keyIndex && typeof keyIndex === 'object' ? keyIndex : {};
    const fieldMap = (crate && crate.fieldMap) || {};
    const policies = (crate && crate.fieldPolicies) || {};

    // ---- 0. 策略声明本身的校验（不算致命，进警告） ----
    if (Object.keys(policies).length > 0) {
        for (const f of validateFieldPolicies(policies)) {
            warnings.push({ code: `policy-${f.code}`, message: f.message, field: f.field });
        }
    }

    // ---- 1. 包级冲突（extKey 全局唯一 / 包内重复） ----
    for (const c of collectExtKeyConflicts(state)) {
        warnings.push({
            code: 'tree-extkey-conflict',
            message: `树上已有重复 extKey "${c.extKey}"（节点 ${c.nodeIds.join(', ')}）；`
                + '父引用解析会取最先遇到的那个，建议先清理'
        });
    }

    const inCrate = (crate && crate.records) || [];
    // 注意：包内 extKey 重复**不在这里报**——resolve.js 已把它作为逐条拒绝处理
    // （doct 3.2 / 4.7），在这里再报一次会让同一条记录产生两条错误。

    // ---- 2. extKey 规范一致性自检（只警告，3.5 / 4.8） ----
    for (const finding of checkKeyConsistency(inCrate)) {
        warnings.push({
            code: `key-${finding.code}`,
            index: finding.index,
            message: finding.message
        });
    }

    // ---- 3. 拓扑排序与父引用解析 ----
    // ⚠️ 顺序上有一处讲究：`父synthKey` 的解析必须**知道树上已有的合成标识**，
    //    所以先取 `synthIndex(state)` 再解析 —— 包内**新建**的合成标识由 resolve 自己
    //    从本包 records 里登记（它一张表就知道谁是谁），两阶段时序因此成立：
    //    "同一个包里先建合成节点、再让另一个合成节点挂到它下面"不会被误判成父找不到。
    const treeSynthEarly = synthIndex(state);
    const resolved = resolveOrder(inCrate, index, { treeSynth: treeSynthEarly.byKey });
    for (const rej of resolved.rejected) {
        errors.push({ code: rej.code, index: rej.index, message: rej.reason });
    }

    // ---- 3b. 合成：把幸存记录预处理成两类 ----
    //   · **合成节点记录**（有 synthKey、没有 extKey）→ 第一阶段（planSynthNodes）
    //   · **普通记录**（有 extKey）→ 走逐字段合并；其中的 `ownerSynth`
    //     是成员指针，抽出来交给第二阶段（planPointers）
    // 两个字段都**不进** computeMerge / recordIncoming：它们是结构（全局一份），
    // 不是"某账户在某渠道看到的值"——绝不能留下账户级的 manual 来源条目。
    const prepped = prepareRecords(resolved.ordered, applyFieldMap, fieldMap);
    const synthRecordIndexes = new Set(
        prepped.filter(it => it.synthKey && !it.extKey).map(it => it.rec.index)
    );

    // 树上已知的合成标识（`synthKey` → 节点 + 类型）。第二阶段判定"悬空"用。
    // （第 3 步已经算过一次同一张表，这里复用它的 `byKey`，不重扫全表。）
    const treeSynth = treeSynthEarly;
    const synthTypes = new Map();
    for (const [key, id] of treeSynth.byKey) {
        const node = state && state.nodes ? state.nodes[id] : null;
        if (node) synthTypes.set(key, node.type);
    }

    // ---- 3c. 第一阶段：合成节点（新建 / 更新）----
    // 包里新建的合成标识在这一步就登记进 `knownSynthKeys` —— 于是"同一次导入里
    // 新建合成节点 + 指向它的成员指针"不会被误判成悬空（§6.3 第 8 条）。
    const knownSynthKeys = new Set(treeSynth.byKey.keys());
    const plannedSynthNodes = planSynthNodes({
        prepped, state, index, synthIdx: treeSynth, synthTypes,
        policies, errors, knownSynthKeys,
        // 「以包里为准」也要管合成节点（它也是 C 节点、性质来自同一份清单）。
        // ⚠️ 计数用**同一个可变对象**回传：本函数是独立函数（不是闭包），没法直接改外面的
        //    `natureForced` —— 传一个 `{ n }` 进去比"返回两个值再拆"清楚。
        forceNature, forced: forcedCounter
    });

    // ---- 3d. 父synthKey 的**逐条**裁定（与第一阶段同口径：父建不出来，子也不许挂） ----
    // resolve.js 已经保证了"父引用恰好给一个"、"两边都找不到就拒绝"；
    // 这里补的是它看不见的那一半：**父自己能不能建出来**（类型不对、身份重复、
    // 带成员指针、字段不适用 …）。父建不出来还会被硬挂到根下 —— 那是静默失效，
    // 所以按"父的记录已被拒绝，无法挂接"逐条拒绝（与resolve 的传播同一口径）。
    rejectOrphanSynthParents(prepped, plannedSynthNodes, errors);

    // ---- 3e. 执行清单只留"真的建得出来"的那些 ----
    // 3c/3d 判为拒绝的合成节点（父容器类型不允许它、父自己建不出来）**必须**从
    // 执行清单里摘掉。留着的话：预览把它算进"新建/更新合成节点 N"、点执行后逐条失败
    // —— 用户看到的预览与结果不符，这正是要消掉的静默不一致。
    const synthNodes = dropRejectedSynthNodes(plannedSynthNodes, prepped, {
        knownSynthKeys, synthTypes, treeSynthKeys: treeSynth.byKey
    });

    // ---- 4. 逐条算出路 ----
    /** parentExtKey → 该父下"当前状态"的子孙节点数组（用于相似度警告） */
    const siblingsByParent = collectSiblingMap(state, index);

    //: 本包里每个 extKey 声明成什么类型 —— 父容器**也在本包里**时，类型预检要看它
    //  （树上还没有那个节点，`index` 查不到）。判据与合成节点那一侧同源。
    const declaredExtTypes = new Map();
    for (const it of prepped) if (it.extKey && it.rec && it.rec.type) declaredExtTypes.set(it.extKey, it.rec.type);

    // 被"**不是同一件东西**"规则过滤掉的相似配对（有两类：
    // ① 只差序号；② 同父但题号不同 —— 见 `utils/similarity.js` 的 `differsOnlyByNumbers`
    // 与本节下面那段闸门）。不报警 ≠ 可以悄悄丢：计数报告给用户，让他们知道这条检查跑过了。
    let similaritySuppressed = 0;

    // 归认（预览口径）：把"这条记录会认到谁"算进计划里
    const accountCounter = newCounter();

    for (const item of prepped) {
        const { rec, mapped } = item;

        // 合成节点记录：第一阶段已处理；第一阶段报错的那条不进任何清单
        if (item.synthKey && !item.extKey) continue;

        // 父引用被拒（父合成节点建不出来 → 由 3d 传播到这里）：不导入，不静默挂根
        if (item.error) continue;

        // 普通记录**只认 父extKey**（父是普通节点）。`父synthKey` 只对合成节点
        // 有意义 —— 进合成节点的名单用的是成员指针 `ownerSynth`，不是父子。
        // 这种形状由 resolve.js 逐条拒绝（`unsupported-parent-ref`），这里说明为什么。
        if (item.parentSynthKey) {
            item.error = true;
            errors.push({
                code: 'unsupported-parent-ref',
                index: rec.index,
                message: `第 ${rec.index} 条：普通记录（extKey "${item.extKey}"）不能用 `
                    + `父synthKey="${item.parentSynthKey}" —— 合成节点不是它的父容器：`
                    + '要么用 父extKey 指出真正的父容器，要么用「所属合成节点 / ownerSynth」'
                    + '把它归入那个合成节点的名单'
            });
            continue;
        }

        // 两个身份写在一起 = 自相矛盾（合成节点不该有 extKey）。逐条报错、不导入，
        // 不猜用户想表达哪一种（与"extKey 撞上别的类型"同一处理方式）。
        if (item.synthKey && item.extKey) {
            item.error = true;
            errors.push({
                code: 'synthkey-with-extkey',
                index: rec.index,
                message: `第 ${rec.index} 条同时带 extKey "${item.extKey}" 与 synthKey "${item.synthKey}"：`
                    + '合成节点的身份是 synthKey、没有 extKey，该条不导入'
            });
            continue;
        }

        // ★ **两条类型预检**（与合成节点那一侧**同一份判据**，绝不另抄）：
        //   ① 字段不适用该节点类型（`C` 带 `ratio` 这种）；
        //   ② 父容器类型不允许这个子节点（`W` 下直接放 `C` 这种）。
        //   ⚠️ 以前**只有合成节点**判这两条，普通记录留到落地才拒（`core/ops/upsert.js`）——
        //      于是预览报"错误 0、可写入 N"，点执行却逐条失败；`crate-check` 退出码还是 0，
        //      链上「0 错误才自动导入」那道闸门形同虚设。**预览与落地必须同一套判据。**
        const notApplicable = inapplicableFields(rec.type, mapped.fields);
        if (notApplicable.length) {
            item.error = true;
            errors.push({
                code: 'field-not-applicable',
                index: rec.index,
                message: `${rec.type} 节点不适用字段：${notApplicable.join('、')}`
                    + '（见 core/model/elements.js 的 types 声明）'
            });
            continue;
        }
        const parentNodeId = item.parentExtKey ? index[item.parentExtKey] : '';
        const parentNode = parentNodeId && state && state.nodes ? state.nodes[parentNodeId] : null;
        // 父**也在本包里**（树上还没有）时看本包声明的类型；两边都没有 ⇒ 不判（交给 resolve / 落地）
        const parentType = parentNode ? parentNode.type
            : (item.parentExtKey ? declaredExtTypes.get(item.parentExtKey) : '');
        // ⚠️ 那句话**不在这里拼**：判据（`TYPE_CHILDREN_MAP`）与说法同处一源
        //    （`core/model/constants.js` 的 `badParentTypeMessage`）—— 产包侧
        //    `scripts/crate-merge.mjs` 合并时读的是**同一句**（否则同一个包两处结论不同）。
        const typeMsg = parentType
            ? badParentTypeMessage(parentType, rec.type, {
                parentKey: item.parentExtKey, childKey: item.extKey, parentCol: '父extKey'
            })
            : '';
        if (typeMsg) {
            item.error = true;
            errors.push({ code: 'bad-parent-type', index: rec.index,
                message: `${rec.type} 节点（extKey "${item.extKey}"）挂不上：${typeMsg} —— 该条不导入。` });
            continue;
        }

        const existingId = index[rec.extKey];
        const existing = existingId && state && state.nodes ? state.nodes[existingId] : null;

        // ---- 位置：**包说挂哪就挂哪** ----
        // 应用的树里**没有**别的换父入口（只有同级上移/下移）⇒ 记录的 `父extKey` 是位置的
        // **唯一真源**（落地时 `upsertRecord` 会真的换父，见 `core/ops/tree.js` 的 `moveNode`）。
        // 这里只**如实报出**"这一条会把它从哪挪到哪" —— 预览里看得见，执行后也有记账。
        // ⚠️ 目标父不在树上时这条早就被父引用解析拒了（§2.3），不在这里重复报。
        const curParent = existing && state && state.parentOf && state.nodes
            ? state.nodes[state.parentOf[existing.id]] : null;
        const curParentKey = curParent ? String(curParent.extKey || '') : '';
        const move = (existing && item.parentExtKey && curParentKey !== item.parentExtKey)
            ? {
                from: curParentKey,
                fromName: String((curParent && curParent.name) || ''),
                to: item.parentExtKey,
                toName: String((parentNode && parentNode.name) || '')
            }
            : null;

        // 链接分类（元列 `链接分类`：`{ 类别: [{v, src}] }`）。
        // 爬取层**只记录、不取舍**（口径："数据爬取部分不应该有『存在多值时排除一些值』的逻辑"），
        // 取舍规则**只在应用层这一处**：
        //   * **所有类别的链接都进 `link` 一个字段** ——
        //     界面上那条 `🔗 链接 (N)` 折叠块就是照来源层里 `link` 的值按类别分组的；
        //   * **缓存值**（`node.link`，也就是"投影选中"的那条）按类别优先级取第一条：
        //     `problems`（补题）→ `board`（榜单）→ `repo` → `unknown`，
        //     所以有补题入口时它仍是补题链接，没有就退到榜单/仓库；
        //   * 其余候选**一条都不丢**，按"落选值"写进来源层（带 `linkKind`）——
        //     「仓库」与「未知」两类也应在非空时显示。
        // 注入放在 `computeMerge` **之前**，这样它照样走导入策略（`fill-if-empty`）
        // 与手改优先那套现成机制。
        const linkKinds = readLinkKinds(rec.raw);
        const pickedLink = pickLink(linkKinds);
        if (pickedLink && mapped.fields.link === undefined) {
            mapped.fields.link = pickedLink.v;
        }

        // decideAction 返回 'merge' | 'create'（match.js 的判定词汇），
        // 这里统一翻译成 ACTION 枚举，避免两个模块各用一套名字
        const action = decideAction(existing) === 'merge' ? ACTION.UPDATE : ACTION.CREATE;

        // 相似度警告：只在 key 不一致时才有意义（4.6）
        const siblings = siblingsByParent.get(normalizeKey(rec.parentExtKey)) || [];
        const similar = findSimilarSiblings(
            { extKey: rec.extKey, fields: mapped.fields },
            siblings,
            similarityThreshold
        );
        for (const s of similar) {
            // 编号系列（`…联赛（1）` vs `（10）`）天生高度相似，报出来纯属刷屏
            if (differsOnlyByNumbers(mapped.fields && mapped.fields.name, s.otherTitle)) {
                similaritySuppressed++;
                continue;
            }
            warnings.push({
                code: s.conflict ? 'similar-key-conflict' : 'similar-title',
                index: rec.index,
                message: `题名与已有节点 "${s.otherTitle}" 高度相似（相似度 ${s.score.toFixed(2)}），`
                    + `但 extKey 不一致（${rec.extKey} vs ${s.extKey}）→ 本条按新建处理。`
                    + (s.conflict ? '【两者都有身份键，请确认 key 规范是否统一】' : ''),
                score: s.score
            });
        }

        const merge = computeMerge({
            type: rec.type,
            incoming: mapped.fields,
            existing,
            overrides: policies
        });

        // ★ 「以包里为准」（预览里勾的开关；默认**关**）：
        //   把"包里非空、与树上不同"的性质字段**补进这次要写的字段**。
        //   为什么不用 `crate.fieldPolicies` 走 `overwrite-if-changed`：
        //     · 那条路对**空值没有闸门** —— 新值是空串时它照样写，等于把树上的年份/地区抹掉
        //       （本应用里"空 = 没意见/还没判"，不是"我知道它是空的"）；
        //     · 而且它是**包级**的：会对所有记录生效，而这里要覆盖的只有"报出来的那些差异"。
        //   ⚠️ 空值一律跳过（唯一一道闸门：`d.newValue` 必须在 `natureDiffOf` 里非空）。
        const natureDiff = natureDiffOf(mapped.fields, existing, rec.raw);
        if (forceNature && natureDiff.length) {
            for (const d of natureDiff) {
                merge.fields[d.field] = d.newValue;
                d.forced = true;
                forcedCounter.n++;
                // 决策痕迹要跟着改：不然界面上这一格写着"fill-if-empty 不覆盖"、字段却写进去了
                const dec = merge.decisions.find(x => x.field === d.field);
                if (dec) {
                    dec.applied = true;
                    dec.reason = '「以包里为准」（预览里勾的）：用包里的性质覆盖树上的';
                }
            }
        }

        // 「这条记录关于谁」（元列 `账户线索`）—— 指纹、跳过判据、预览归认**共用这一份**
        const clue = clueOf(rec.raw);

        const fp = hashRecord({
            extKey: rec.extKey, type: rec.type, fields: mapped.fields,
            // ★ 线索也算内容：它会被写进来源层（每条值的 `account`/`clue`）⇒ 见 `contentHash.js`
            clue
        });

        // 指纹相同 → 整条 no-op（第五节）
        //
        // ⚠️ 例外：「以包里为准」是**当场勾的**，不能被指纹吃掉 ——
        //    重导同一个包时指纹必然相同，而"树上的值被人改过、包里没变"正是这个开关要处理的事。
        let effectiveAction = action;
        // ⚠️ 「要换父」的记录**不许被指纹/空字段吃成跳过**：它的效果不在字段上
        //    （重导同一个包时指纹必然相同，而"这场该挂到别处"正是这次要办的事）。
        if (action === ACTION.UPDATE && existing && existing.importFingerprint === fp
            && !natureDiff.some(d => d.forced) && !move) {
            effectiveAction = ACTION.SKIP;
        } else if (action === ACTION.UPDATE && Object.keys(merge.fields).length === 0
                   && !move && !clue) {
            // 指纹变了但没有可写字段变化（例如只改了被保护字段）⇒ 跳过。
            // ⚠️ **带线索的记录不跳过**：线索要写进来源层（每条值的 `account`/`clue`）——
            //    那正是"补上 handle 再导一次就归认上"要落的东西。算成跳过的话，
            //    预览写着"更新 0"、看着像什么都没发生（用户 2026-10-06 实测报的就是这个）。
            effectiveAction = ACTION.SKIP;
        }

        records.push({
            index: rec.index,
            type: rec.type,
            extKey: rec.extKey,
            parentExtKey: rec.parentExtKey || '',
            action: effectiveAction,
            nodeId: existing ? existing.id : null,
            fingerprint: fp,
            fields: merge.fields,
            // 来源层用：**这一条记录里出现了哪些字段**（含被策略忽略的）。
            // 「这个来源说过什么」是客观事实，不该被合并策略吃掉 ——
            // 缓存字段仍只写 fields，incoming 只进来源层。
            incoming: mapped.fields,
            // 逐字段来源：合成包（crate-merge）会写 `字段来源: {列名: 来源id}`，
            // 这里把它按 fieldMap 映射成内部字段名，交给 apply 记录到来源层。
            // 缺省为 null → 整个包共用一个来源（`item.source`）。
            fieldSources: withPickedSource(
                readFieldSources(rec.raw, fieldMap, applyFieldMap, mapRecord), pickedLink),
            // 缓存值的**类别**（`{ link: 'problems' }`）—— 选中值也要在来源层里带类别，
            // 否则链接块里它成了"没类别"的那条。
            linkKindsByField: pickedLink ? { link: pickedLink.kind } : null,
            // 落选值（合并包带的 `其它来源值`）：同字段的其它来源值 + **各自的来源**。
            // 应用按值写进来源层 —— 面板里就能同时看到"CF 的链接"和"QOJ 的链接"。
            // `链接分类` 里没被选中的候选链接也并进这里（带 `linkKind`）。
            otherValues: mergeLinkKindOthers(
                readOtherValues(rec.raw, fieldMap, applyFieldMap, mapRecord),
                linkKinds, pickedLink),
            // 账户线索：源里"这条记录关于谁"（元列 `账户线索`），原样带到 apply 去查映射表。
            // 应用不认识平台字段，只认识这张表 —— 所以这里不做任何解释，只搬运。
            accountClue: clue,
            // 分类依据：源里"这条分类凭什么判出来的"（元列 `分类依据`，
            // 形如 `{ natureClass: 'xcpc:name-stage' }`）。同样只搬运、不解释 ——
            // 规则 id → 级别（A…E）那张表在 `core/natureConfidence.js`，与爬取层解耦。
            classRules: classRulesOf(rec.raw),
            // **包里的性质判定与树上已有的值不一致**的那些字段（只报不改，见 `natureDiffOf`）。
            // 勾了「以包里为准」时，其中**非空**的那些已经补进 `fields`（多一个 `forced: true` 标记）。
            natureDiff,
            // **会换父**的那一条附带"从哪到哪"（`null` = 位置不变）。
            // 为什么预览必须带它：位置是**效果的一部分**，不报出来就成了静默改动树结构。
            move,
            // 归认**预览**结果（执行时以 apply 的为准，因为账户映射可能在预览之后被改）
            accountId: resolveClueAndCount((state && state.accounts) || {}, clue, accountCounter),
            decisions: merge.decisions,
            ignoredColumns: mapped.ignored,
            unusedColumns: mapped.unmapped,
            similar: similar.map(s => ({ extKey: s.extKey, score: s.score, title: s.otherTitle }))
        });
    }

    // ---- 5. 包内近似重复（爬虫 bug，4.7） ----
    // 优先级高于与树上比对：包内自相矛盾更值得先看
    //
    // ⚠️ 只比**同类型**的记录。跨类型比标题是没有意义的噪声：
    //    XCPC 的 W「XCPC」与它下面的 S「ICPC」相似度 0.75，会被误报成
    //    "同一道题导成了两个 key" —— 可它们一个是平台、一个是系列。
    //    这条检查要抓的是"同一道题/同一场比赛出现两个 key"，那只可能同类型。
    const forIntra = resolved.ordered
        // 合成节点记录（无 extKey）不参与"包内 extKey 不一致"的判重 ——
        // 它本来就没有 extKey，比出来的 `'' vs ''` 是噪声。
        .filter(rec => !synthRecordIndexes.has(rec.index))
        .map(rec => {
            const mapped = mapRecord(applyFieldMap, rec.raw, fieldMap);
            // `parentExtKey` 一起带上：判重只比**同一父容器**内的记录（见 utils/similarity.js）
            return {
                index: rec.index, extKey: rec.extKey, type: rec.type,
                parentKey: rec.parentExtKey || '', fields: mapped.fields
            };
        });
    for (const dup of findIntraBatchDuplicates(forIntra, similarityThreshold)) {
        // ⚠️ 两种"看着像、其实是两回事"的配对都只计数、不报（口径：减少警告）：
        //    ① **只差序号**（`联赛(1)` / `联赛(2)`）—— 否则 10 场同名联赛会刷出 45 条；
        //    ② **题号不同**（`arc120 F` vs `F2`、`nk … p:I` vs `p:J`）—— 一场比赛里题号不同
        //       就是两道题；实测真包 3362 条**全是这一条**（另 3 条是"同名不同题"，
        //       如 AtCoder 的重发题 `F`/`F2` 都叫 `Wine Thief`，同样合法）。
        //    真正的指纹只有一个：**同一父里同一个题号出来两个 key**（QOJ"题号全乱"
        //    那个 bug 的形态 —— 字母重复 C,C,E,E,…）。判据在 `utils/similarity.js` 给出题号，
        //    这里只下闸门。
        if (differsOnlyByNumbers(dup.aTitle, dup.bTitle)) {
            similaritySuppressed++;
            continue;
        }
        const samePid = !!dup.aPid && dup.aPid === dup.bPid;
        if (!samePid) {
            similaritySuppressed++;
            continue;
        }
        warnings.push({
            code: 'intra-batch-duplicate',
            index: dup.b,
            message: `包内第 ${dup.a} 条与第 ${dup.b} 条「同一个题号」（${dup.aPid}）却有两个 key`
                + `（${dup.aKey} vs ${dup.bKey}，相似度 ${dup.score.toFixed(2)}）——`
                + '说明爬虫输出的 key 不稳定',
            score: dup.score
        });
    }

    // ---- 5b. 第二阶段：成员指针 ----
    // **必须在第一阶段之后**：同一次导入里新建的合成节点此刻已是"已知目标"。
    // 口径：
    //   · 默认 overwrite-if-changed（树上空着就写；值相同不动、不碰 lastModified）
    //   · **包不得覆盖树上已经存在（非空）的指针** —— 这类差异在预览里单独列出来
    //   · **目标不存在 / 写的是节点 id / 成员不在树上 ⇒ 拒绝该条指针**（不照写）：
    //     坏数据不该由写路径产生；文件里的历史悬空由读路径标黄 + 一键清理。
    //: **包里"没有任何成员指着"的题目组键**（`synth:problem:…`）—— 给 `planPointers` 判
    //: "树上那条旧指针是不是上一版的残留"（见那个文件的 `oldGroupEmptyInPkg`）。
    const pkgEmptyPGroups = new Set();
    {
        const withMembers = new Set();
        for (const r of (crate && crate.records) || []) {
            const o = String((r && r.ownerSynth) || '').trim();
            if (o.startsWith('synth:problem:')) withMembers.add(o);
        }
        for (const r of (crate && crate.records) || []) {
            const sk = String((r && r.synthKey) || '').trim();
            if (sk.startsWith('synth:problem:') && !withMembers.has(sk)) pkgEmptyPGroups.add(sk);
        }
    }
    const pointers = planPointers({
        prepped, state, index, policies, synthTypes, knownSynthKeys, warnings, pkgEmptyPGroups
    });

    // ---- 6. 汇总 ----
    const synthCreate = synthNodes.filter(n => n.action === 'create').length;
    const synthUpdate = synthNodes.filter(n => n.action === 'update').length;
    const summary = {
        total: inCrate.length,
        create: records.filter(r => r.action === ACTION.CREATE).length,
        update: records.filter(r => r.action === ACTION.UPDATE).length,
        skip: records.filter(r => r.action === ACTION.SKIP).length,
        reject: errors.length,
        warnings: warnings.length,
        errors: errors.length,
        /** 因"不是同一件东西"而未报警的相似配对数量（只差序号 / 同父但题号不同） */
        similaritySuppressed,
        /**
         * **会被换父**（重挂）的条数：包的 `父extKey` 与树上现在挂的父不一致。
         * 落地时真的搬（`moveNode`）；"包里的落位改动在应用里看不见"就是这么修掉的。
         */
        moved: records.filter(r => r.move).length,
        /**
         * **包里的性质判定与树上已有的值不一致**的记录数（只报不改）。
         * 判据见 `natureDiffOf` —— 两边都非空且不同才算；"树上空、包里判出来了"是正常补全。
         */
        natureChanged: records.filter(r => (r.natureDiff || []).length > 0).length
            + synthNodes.filter(n => (n.natureDiff || []).length > 0).length,
        /**
         * 勾了「以包里为准」时**真的会被覆盖**的性质字段处数（默认 0）。
         * 与 `natureChanged` 不同：那个是"有几条记录不一样"，这个是"有几**处**会被写掉"。
         */
        natureForced: forcedCounter.n,
        unusedColumns: collectUnused(mappedAll(resolved.ordered, applyFieldMap, fieldMap)),
        // 归认**预览**：拿当前的账户映射表算一遍"这批记录会认到谁"。
        // 为什么预览也要算：映射没填对时，用户应该在**导入之前**就知道，
        // 而不是导完之后对着一堆不认识账户的值发呆。
        // （执行时 `apply.js` 会用当时的注册表再算一次 —— 那一次才是权威的。）
        accounts: accountCounter,
        // ---- 合成（§6.6 第 8 条：预览必须列出这两项计数）----
        /** 会新建 / 会更新 的合成节点数（两者之和就是界面上那个 N） */
        synthCreate,
        synthUpdate,
        synthNodes: synthCreate + synthUpdate,
        /** 合成节点记录里"值没变、不必写"的条数（不进 N） */
        synthSkip: synthNodes.filter(n => n.action === 'skip').length,
        /** 会设置的成员指针条数 */
        pointerSet: pointers.filter(p => p.action === 'set').length,
        /** 包想改但没改的成员指针（树上已有非空值 / 目标不存在 / 写的是节点 id） */
        pointerRejected: pointers.filter(p => p.action === 'reject').length,
        /** 其中"目标不可解析"的那些（悬空、或写成了节点 id）—— 预览里单独说一句 */
        pointerDangling: pointers.filter(p => p.dangling).length
    };

    return {
        records,
        summary,
        warnings,
        errors,
        crate: crate || null,
        // 合成的执行清单（两阶段；由 apply.js 原样交给 synthApply.js）
        synth: {
            nodes: synthNodes,
            pointers,
            createdKeys: synthNodes.filter(n => n.action === 'create').map(n => n.synthKey),
            knownKeys: [...knownSynthKeys]
        }
    };
}

// ================================================================
// 内部工具
// ================================================================
