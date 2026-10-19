// ================================================================
// 节点自动导入 — 计划落地（features/AutoImport/apply.js）
// 职责：把一份（或多份）ImportPlan 在一次事务里写进主树
// 依赖：shell/executor.js, core/ops/upsert.js, core/autoCompute.js
//
// 事务语义（docs/auto-import.md 9.3）：
//   - **整批一次 execute()**：要么全成，要么全回滚。
//   - 逐条错误在**进事务之前**就已剔除（plan 阶段），所以事务内不会因它们失败。
//   - 被拒绝/跳过的条目**不写入**，只计入结果。
//
// 性能：与 handlers/H2_batchImport.js 同样的做法——
//   循环内不跑 autoUpdate，循环结束后统一跑一次 fullAutoUpdate，
//   否则上千条会退化成 O(N²)（批量导入的循环里不跑 autoUpdate）。
//
// 说明：本模块 import shell/，因此不进 Node 单测，由冒烟测试覆盖。
// ================================================================
import { execute } from '../../shell/executor.js';
import { upsertRecord, buildExtKeyIndex, assignExtKey } from '../../core/ops/upsert.js';
// 同层顺序（`越新的越靠上`）：产包侧 `crate-merge.mjs` 用的是同一份实现
import { orderChildren } from '../../core/siblingOrder.js';
import { fullAutoUpdate } from '../../core/autoCompute.js';
import { recordIncoming, addSourceValue } from '../../core/fieldValue.js';
import { DEFAULT_TRUST, KIND_RANK, SOURCE_KINDS, VALID_SOURCE_KINDS } from '../../core/trust.js';
import { resolveClueAndCount, newCounter, describeCounter } from '../../core/accounts.js';
import { markOrigin } from '../../core/ops/origin.js';
import { WRITABLE_FIELDS } from './constants.js';
import { applySynthPart } from './synthApply.js';
// 组头的性质是**派生量**：导入补全成员之后要跟着走（口径在 core/natureConfidence）
import { syncAllGroupNatures } from '../../core/ops/synth.js';
import { CLASS_RULE_COL } from '../../core/natureConfidence.js';
import { NATURE_FIELD_KEYS } from '../../core/natureFields.js';

/**
 * 把一条导入记录的**分类依据**落进节点。
 *
 * 契约（与 `scripts/crate.py` 的 `class_rules()` 同一份）：
 *   · 形状 `{ 性质字段名: 规则id }`，**单值**；字段名只认性质字段（`NATURE_FIELD_KEYS`）；
 *   · **落规则的条件 = "这条记录说的值 == 节点上现在的值"**（`incoming` 而不是 `fields`）：
 *     记录说的值没被采纳（策略保留了别人的值 / 记录压根没带这个字段）⇒ **不落** ——
 *     否则徽标会拿"这个来源的规则"去描述**别人的值**。
 *     ⚠️ 为什么不用 `fields`（"这条记录真的写了哪些"）：`natureClass` 的策略是
 *     **fill-if-empty** ⇒ 值一样时它**也不在 `fields` 里**，可那个值恰恰就是这条记录判出来的
 *     （**重导一次包**的场景：包里多了这一列、业务字段一个字没变 ⇒ 整条记录指纹相同被跳过）。
 *     用"值对不对得上"当判据，两种情况一起覆盖，而且永远不会给别人的值贴规则。
 *   · 记录带了这个字段却没带规则（老包 / 手工包）⇒ **什么都不做** —— 只要那个值这次**没被写**。
 *     旧规则是"某个值被采纳时"写下的，值没变它就仍然描述**现在这个值**，删掉反而丢信息。
 *     ⚠️ **但值这次真被换了**（`rec.fields` 里有它：`forceNature`「以包里为准」那条路，
 *     或新建节点之外的值替换）却没带规则 ⇒ **旧规则描述的已经是旧值了，必须清掉**
 *     （与手改同一条口径：`core/ops/node.js` 的 `clearClassRule`）。
 *     以前这里没有这条，`applyClassRules(node, rec, true)` 的第三个实参被**静默丢掉** ——
 *     "值换了、依据没跟上，徽标对着新值撒谎"。
 *
 * @param {boolean} [clearStale] 值被换了却没带规则时，把那一格的旧规则清掉
 * @returns {boolean} 节点是否被改过
 */
function applyClassRules(node, rec, clearStale = false) {
    const rules = (rec && rec.classRules) || {};
    const incoming = (rec && rec.incoming) || {};
    const wrote = (rec && rec.fields) || {};
    const norm = v => String(v === undefined || v === null ? '' : v).trim();
    const fields = Object.keys(rules).filter(f => NATURE_FIELD_KEYS.includes(f));
    const next = { ...(node[CLASS_RULE_COL] && typeof node[CLASS_RULE_COL] === 'object'
        ? node[CLASS_RULE_COL] : {}) };
    let changed = false;
    const applied = new Set();
    for (const field of fields) {
        const rule = String(rules[field] || '').trim();
        if (!rule) continue;
        const claimed = norm(incoming[field]);
        if (!claimed || claimed !== norm(node[field])) continue;      // 值对不上 ⇒ 这条规则不是它的
        applied.add(field);
        if (next[field] === rule) continue;
        next[field] = rule;
        changed = true;
    }
    // ★ **值换了、依据没跟上**：这次**写进去了**的 nature 字段，若这一趟没给它规则
    //   （老包没有 `分类依据` 那一列 / 手工包），旧规则描述的是**旧值** ⇒ 清掉。
    //   ⚠️ "新建的节点"本来就没有旧规则 ⇒ 这里自然什么都不做，不用特判。
    if (clearStale) {
        for (const field of NATURE_FIELD_KEYS) {
            if (!Object.prototype.hasOwnProperty.call(wrote, field)) continue;
            if (applied.has(field)) continue;
            if (!Object.prototype.hasOwnProperty.call(next, field)) continue;
            delete next[field];
            changed = true;
        }
    }
    if (!changed) return false;
    if (Object.keys(next).length) node[CLASS_RULE_COL] = next;
    else delete node[CLASS_RULE_COL];
    return true;
}

/**
 * 来源类别 → 等级：**唯一一份在 `core/trust.js` 的 `KIND_RANK`**。
 *
 * 自己抄一份 `{manual:100, board:30, script:20, derived:10}`（`core/model/state.js`、
 * `core/fieldValue.js` 里也有类似的表）的毛病：数字碰巧一致，但改一处另两处不知道，
 * 症状是"手改失去优先级 / 权威榜单被脚本压掉"这类**静默压错值**。
 */

/**
 * 在一次事务里落地多份计划
 *
 * @param {Object} params
 * @param {Object} params.state - AppState
 * @param {Array<{plan:Object, source?:string}>} params.items - 多份计划，按顺序应用
 * @param {Object} [opts]
 * @param {Function} [opts.onSuccess] - (summary) => void
 * @param {Function} [opts.onError] - (err) => void
 * @returns {Promise<{ ok:boolean, created:number, updated:number, skipped:number,
 *                     rejected:number, perItem:Array<Object>, error?:string }>}
 */
export async function applyPlans({ state, items = [] }, opts = {}) {
    const result = {
        ok: false,
        created: 0,
        updated: 0,
        skipped: 0,
        rejected: 0,
        // 换父（重挂）：记录里的 `父extKey` 与树上现在挂的父不一致而真的搬了 ——
        // 与预览里 `summary.moved` 一一对应（见 `core/ops/tree.js` 的 `moveNode`）
        moved: 0,
        // 合成：与预览里那两项计数一一对应（实际写入的结果）
        synthCreated: 0,
        synthUpdated: 0,
        pointersSet: 0,
        pointersRejected: 0,
        // 同层重排动过几个容器（"越新的越靠上"，见 core/siblingOrder.js）
        reorderedParents: 0,
        // 组头的性质被按成员对齐过几个（"组头的性质是派生量"，见 core/ops/synth.js）
        syncedHeads: 0,
        perItem: [],
        accounts: newCounter(),
        // ★ 分段计时（"先量再改"的**第一步**）：
        //   只记各段毫秒数，不改任何行为 —— 界面/控制台上能看到"时间花在哪一段"。
        //   ⚠️ 与 `index.js` 的 `lastImport.ms`（端到端）**不是一回事**：那份含重算与重绘。
        phases: {}
    };

    // **只带合成节点/成员指针的包也算"有事可做"**。
    // 只认 `plan.records.length > 0` 的话，合成节点记录**不在** records 里
    // （它们没有 extKey，走两阶段通道）—— 于是"合成节点 + 指针"这种包会被整批
    // 过滤掉、静默什么都不做（实测：预览说"新建合成节点 1"，执行后树上一个都没有）。
    const hasWork = (it) => {
        if (!it || !it.plan) return false;
        // 包里带**随包发布的元数据**（`reports` 体检报告 / `fieldRegistry` 应有注册表）时，
        //   哪怕一条记录都不用写，也**必须**跑那笔事务 —— 它们是在事务里写进状态的，
        //   短路掉就等于"导了包、元数据没进来"（表现：体检页说"这个包没带体检报告"，
        //   可包明明带着）。空包 / 记录全被计划拒掉的包走的正是这条路。
        const crate = it.plan.crate || {};
        if (crate.reports || (crate.fieldRegistry && crate.fieldRegistry.fields)) return true;
        if (Array.isArray(it.plan.records) && it.plan.records.length > 0) return true;
        const synth = it.plan.synth;
        if (!synth) return false;
        return (Array.isArray(synth.nodes) && synth.nodes.length > 0)
            || (Array.isArray(synth.pointers) && synth.pointers.length > 0);
    };
    const active = items.filter(hasWork);
    if (active.length === 0) {
        result.ok = true;
        if (typeof opts.onSuccess === 'function') opts.onSuccess(result);
        return result;
    }

    const nowMs = () => Date.now();
    /** 记一段耗时（同名的累加） */
    const mark = (name, t0) => {
        result.phases[name] = (result.phases[name] || 0) + (nowMs() - t0);
    };

    try {
        const tTx = nowMs();
        await execute(draft => {
            // 索引要在事务**内部**建，这样多份计划能互相看见对方新建的节点
            const tIndex = nowMs();
            const index = buildExtKeyIndex(draft);
            mark('index', tIndex);

            // 包里带的「**应有**」注册表随导入存进状态 ——
            //   字段条上要显示「应有：必须有/应该有/可有可无 · 已有：有/缺」。
            //   后导入的包**覆盖**先前的（同一份规则的新版本应该生效）；
            //   包不带这一节（老包/裁剪包）时**保留已有的**（不要把已知的规则抹掉）。
            for (const item of active) {
                const reg = item.plan && item.plan.crate && item.plan.crate.fieldRegistry;
                if (reg && reg.fields) { draft.fieldRegistry = reg; break; }
            }

            // 包里带的**随包报告**（`reports.coverage` 字段体检 / `reports.needs`
            //   原料需求 / `reports.baseline` 回代核对）随导入存进状态 ——
            //   「🩺 体检 / 需求」那页与「③ 性质待补」那一行就读它，不用再跑脚本。
            //   ⚠️ 这里**不列举各节名字**：包里的 `reports` 已经被 `parse.js` 的 `reportsOf`
            //   逐节校验过一遍，这里只要"非空就整节收下"。加一节新报告 = 在 `reportsOf` 放行一次。
            //   规则同 `fieldRegistry`：后导入的覆盖先前的，包不带这一节时**保留已有的**。
            for (const item of active) {
                const reps = item.plan && item.plan.crate && item.plan.crate.reports;
                if (reps) {
                    draft.reports = reps;
                    break;
                }
            }

            // 来源层：这次导入用到的来源先登记进注册表（来源 ↔ 可信度 ↔ 说明）
            if (!draft.sources || typeof draft.sources !== 'object') draft.sources = {};
            if (!draft.trust || typeof draft.trust !== 'object') {
                draft.trust = { ...DEFAULT_TRUST };
            }

            let tRecords = nowMs();      // `let`：多份包时每轮都要重置
            for (const item of active) {
                const plan = item.plan;
                const srcId = item.source || plan.source || 'import:anonymous';
                if (!draft.sources[srcId]) {
                    // 来源类别由**包自己声明**（`source.kind`）：board=权威榜单 / script=爬虫脚本。
                    // 硬编码 'script' 会让榜单来源与脚本来源在投影眼里一样 ——
                    // 类别序 `manual > board > script > derived` 直接失效（压错值就是这么来的）。
                    // 缺省仍是 script：hdu/nk 那些老包不带 kind，行为一字不变。
                    const crateKind = (plan.crate && plan.crate.source && plan.crate.source.kind) || SOURCE_KINDS.SCRIPT;
                    const kind = VALID_SOURCE_KINDS.includes(crateKind)
                        ? crateKind : SOURCE_KINDS.SCRIPT;
                    const info = {
                        kind,
                        label: plan.sourceLabel || srcId,
                        // 来源级等级：类别内部的先后（类别由 kind 决定，见 core/trust.js）
                        rank: KIND_RANK[kind],
                        note: '导入包来源'
                    };
                    draft.sources[srcId] = info;
                    // ★ 同一份信息也要进 `trust.sources`：投影（core/trust.js）查的是
                    //   **trust.sources**，不是 state.sources。只写前者的话，所有来源在
                    //   投影眼里都是"默认 script / rank 0" —— 后果：**手改失去优先级**、
                    //   类别（board > script）也失效。两处同步是这套设计的硬要求。
                    if (!draft.trust.sources || typeof draft.trust.sources !== 'object') {
                        draft.trust.sources = {};
                    }
                    draft.trust.sources[srcId] = { kind: info.kind, rank: info.rank };
                }
                const stat = {
                    source: item.source || '', created: 0, updated: 0, skipped: 0, failed: 0, failures: [],
                    moved: 0,
                    // 合成：预览里那两项计数的**实际落地结果**（两阶段）
                    synthCreated: 0, synthUpdated: 0, pointersSet: 0, pointersRejected: 0,
                    accounts: newCounter()
                };

                // 合并包（`crate-merge`）会把**各来源的 kind 表**带在 `source.sources` 里 ——
                // 字段级的 `字段来源` 用的是那些 id，所以它们也必须进注册表，
                // 否则投影查不到 kind → 一律当 script/rank 0 → 类别序失效（压错值）。
                const kindTable = (plan.crate && plan.crate.source && plan.crate.source.sources) || null;
                if (kindTable && typeof kindTable === 'object') {
                    for (const sid of Object.keys(kindTable)) {
                        const k = kindTable[sid] && kindTable[sid].kind;
                        const kind2 = VALID_SOURCE_KINDS.includes(k) ? k : SOURCE_KINDS.SCRIPT;
                        const label2 = (kindTable[sid] && kindTable[sid].label) || sid;
                        if (!draft.sources[sid]) {
                            draft.sources[sid] = {
                                kind: kind2, label: label2, rank: KIND_RANK[kind2], note: '导入包来源'
                            };
                        }
                        if (!draft.trust.sources[sid]) {
                            draft.trust.sources[sid] = { kind: kind2, rank: KIND_RANK[kind2] };
                        }
                    }
                }

                if (!draft.accounts || typeof draft.accounts !== 'object') draft.accounts = {};

                for (const rec of plan.records) {
                    // ---- 归认：这条记录是关于谁的 ----
                    // 线索由**适配器**给出（`账户线索` 元列），映射表由**用户**维护
                    // （`state.accounts[*].mappings`），应用只查一次表。查不出来就归为空
                    // （客观值），并且按"填了没匹配上 / 完全没填"两类分别计数上报。
                    const accountId = resolveClueAndCount(draft.accounts, rec.accountClue, stat.accounts);

                    if (rec.action !== 'create' && rec.action !== 'update') {
                        // ---- **跳过的记录也要记来源层** ----
                        // "这个来源说过什么"是客观事实，不该被合并策略吃掉。
                        // 不加这段的后果：给已有节点补第二个来源时，
                        // 策略说"字段已有值、不必更新" → 整条 skip → 第二来源永远进不来，
                        // 来源层白设计。
                        // 注意：**只记来源、不写缓存字段**，所以不会改到任何缓存值。
                        const skipNodeId = index[rec.extKey];
                        const skipNode = skipNodeId ? draft.nodes[skipNodeId] : null;
                        if (skipNode) {
                            const opt = {
                                at: plan.generatedAt || '',
                                only: WRITABLE_FIELDS,
                                srcByField: rec.fieldSources,
                                account: accountId,
                                // 线索要**存进值里** —— 以后"补映射后重跑归认"靠它认人
                                clue: rec.accountClue
                            };
                            let added = recordIncoming(skipNode, rec.fields, srcId, opt);
                            if (rec.incoming) added += recordIncoming(skipNode, rec.incoming, srcId, opt);
                            // 跳过的记录也要补分类依据。
                            // 为什么必须在这儿：`分类依据` 是**元列**，不进指纹（指纹只看业务字段）
                            // ⇒ "包里多了一列、业务字段一个字没变"的**重导**会被判成 skip，
                            // 那条记录就永远贴不上依据徽标 —— 而"重导一次让徽标亮起来"正是靠这条路径。
                            // 安全性由 `applyClassRules` 自己保证：**值对不上就一个字节都不写**。
                            applyClassRules(skipNode, rec);
                            if (added > 0) {
                                // 这行日志是这条路径的探针：
                                // 没有它说明浏览器加载的可能是缓存里的模块（见 architecture 8.7）
                                console.log(`跳过但记了来源：${rec.extKey} +${added}（来源 ${srcId}）`);
                            }
                        } else {
                            console.warn(`跳过记录找不到节点：${rec.extKey}`);
                        }
                        stat.skipped++;
                        continue;
                    }

                    const res = upsertRecord(draft, {
                        type: rec.type,
                        extKey: rec.extKey,
                        parentExtKey: rec.parentExtKey,
                        // plan 已经算好"要写哪些字段"（策略已施加），直接用它
                        fields: rec.fields
                    }, index, { allowedFields: WRITABLE_FIELDS });

                    if (!res.ok) {
                        stat.failed++;
                        stat.failures.push({ extKey: rec.extKey, code: res.code, reason: res.reason });
                        continue;
                    }

                    // 指纹写回，供下次导入做 no-op 判定（第五节）
                    if (res.nodeId) {
                        const node = draft.nodes[res.nodeId];
                        node.importFingerprint = rec.fingerprint;
                        if (item.source) node.importSource = item.source;
                        // 存在性也要有归属 —— 导入建出来的节点记"是这个来源建出来的"，
                        // 账户用归认结果（认不出则是客观）。幂等：已存在的节点不会被改写。
                        if (res.created) {
                            markOrigin(node, {
                                src: srcId,
                                account: accountId,
                                at: plan.generatedAt || ''
                            });
                        }

                        // ---- 来源层 ----
                        // 把"这个来源说了哪些字段"记下来（含被策略忽略的 incoming）；
                        // **不动缓存字段**（它已由上面 upsertRecord 按导入策略写好），
                        // 所以这一步只让每个值的出处可追。
                        const at = plan.generatedAt || '';
                        // 逐字段来源：合成包（crate-merge）会带 `字段来源`，
                        // 有它就能记下"ratio 来自 PTA、name 来自 rankland"，
                        // 而不是整包都记成同一个来源。
                        const opt = {
                            at, only: WRITABLE_FIELDS, srcByField: rec.fieldSources,
                            // 派生值（link）的类别 —— 让它也进来源层
                            linkKindByField: rec.linkKindsByField,
                            account: accountId, clue: rec.accountClue
                        };
                        recordIncoming(node, rec.fields, srcId, opt);
                        if (rec.incoming) {
                            recordIncoming(node, rec.incoming, srcId, opt);
                        }
                        // 落选值：同字段的**其它来源值**（合并包带 `其它来源值`）——
                        // 每个值用**它自己的来源**写进来源层（`srcByField` 一个字段只能给一个来源，
                        // 所以这里逐值调 addSourceValue，而不是整批交给 recordIncoming）。
                        if (rec.otherValues && typeof rec.otherValues === 'object') {
                            for (const field of Object.keys(rec.otherValues)) {
                                if (!WRITABLE_FIELDS.includes(field)) continue;
                                for (const one of (rec.otherValues[field] || [])) {
                                    if (!one || !one.src) continue;
                                    if (one.v === undefined || one.v === null || one.v === '') continue;
                                    addSourceValue(node, field, one.v, String(one.src), {
                                        at, account: accountId, clue: rec.accountClue,
                                        // 链接的**类别**（补题/榜单/仓库/其它）——
                                        // 界面按它分组显示。没有这个键的（别的字段的落选值）不受影响。
                                        linkKind: one.linkKind
                                    });
                                }
                            }
                        }

                        // ---- 分类依据（元列 `分类依据`）----
                        // "这条分类凭什么判出来的"（`{ natureClass: 'xcpc:name-stage' }`），
                        // 界面读它显示**依据强度**徽标（`core/natureConfidence.js`）。
                        //
                        // ⚠️ 只对**这条记录真的写进去了**的字段生效（`rec.fields`）：
                        //    这个包说了某个字段但策略没采纳（已有值不动），规则就不能落 ——
                        //    否则徽标描述的是**别人的值**。
                        // ⚠️ 写进去了却**没带**规则（老包 / 手工包）⇒ 把旧规则**清掉**：
                        //    值换了、依据没跟上，留着就是撒谎（与手改同一条口径）。
                        applyClassRules(node, rec, true);
                    }

                    if (res.created) stat.created++;
                    else stat.updated++;
                    // 换父是**结构性改动**（与"更新字段"分开记）—— 见 `moveNode`
                    if (res.moved) stat.moved++;
                }

                // ---- 合成（**两阶段**，见 plan.js 的 planSynthNodes/planPointers）----
                // 位置：本包普通记录**之后** —— 合成节点的父容器可能正是本包刚建的记录；
                // 而两个阶段内部的顺序是硬要求：先建/更新全部合成节点，再落成员指针
                // （同一次导入里新建的合成节点不算悬空，§6.3 第 8 条）。
                mark('records', tRecords);
                const tSynth = nowMs();
                const synthRes = applySynthPart(draft, plan.synth, {
                    index,
                    rootId: draft.rootId,
                    // 新建的合成节点同样要有**存在性归属**（谁让它出现的）
                    onCreated: (node, entry) => {
                        const accId = resolveClueAndCount(draft.accounts, entry.accountClue, stat.accounts);
                        markOrigin(node, { src: srcId, account: accId, at: plan.generatedAt || '' });
                    }
                });
                stat.synthCreated += synthRes.created;
                stat.synthUpdated += synthRes.updated;
                stat.pointersSet += synthRes.pointersSet;
                stat.pointersRejected += synthRes.pointersRejected;
                for (const f of synthRes.failed) {
                    stat.failed++;
                    stat.failures.push({ extKey: f.extKey || '', synthKey: f.synthKey || '', code: f.code, reason: f.reason });
                }

                result.perItem.push(stat);
                mark('synth', tSynth);
                tRecords = nowMs();          // 多份包时，`records` 段要继续累加
            }

            // ★ **同层顺序**：导入一律 `childOrder.push`（新场次落在最后），
            //   所以顺序必须在这里由数据重算一遍 —— 规则与产包侧共用 `core/siblingOrder.js`。
            //   只重排"同类且规则明确"的容器（比赛按时间倒序、提交按时间倒序、年份层按年倒序、
            //   **题目按题号升序**）；混合类型 / 手建顺序的容器一个字都不动。
            //   ⚠️ 题目**也**排：理由是"来源给的顺序就是题号顺序"实测不成立
            //     （`qoj:c:4116` 是 `DKJFELBHCIGA`），所以按题号排。
            const tOrder = nowMs();
            const reorder = orderChildren(draft);
            result.reorderedParents += reorder.moved;
            mark('order', tOrder);

            // 循环结束后统一重算一次（§5.3 的 O(N²) 规避）
            const tAuto = nowMs();
            fullAutoUpdate(draft);
            mark('auto', tAuto);

            // ★ **组头的性质跟着成员走**：组头（合成节点）的 4 个性质是**派生量**
            //   （口径唯一一份在 `core/natureConfidence.js` 的 `pickGroupNature`）。
            //   导入**补全了成员的性质**之后，组头若还停在旧值，树上就会出现
            //   "成员的年份已经是 2019、组头还写着 年份未知"这种自相矛盾的状态。
            //   位置：**必须在 `applySynthPart` 之后**（成员指针这时才落地，
            //   组头才有成员可派），也要在 `fullAutoUpdate` 之后（性质字段的终值已定）。
            //   手工编辑那一侧是同一件事，挂在 `core/ops/node.js` 的换值调用点上。
            const tSyncHead = nowMs();
            result.syncedHeads = syncAllGroupNatures(draft).length;
            mark('syncHead', tSyncHead);

            return result;
        }, {
            refreshParentId: null,
            onError: () => { /* 由下面的 catch 统一处理 */ }
        });

        mark('tx', tTx);
        // 汇总（事务成功后才可信）
        for (const stat of result.perItem) {
            result.created += stat.created;
            result.updated += stat.updated;
            result.skipped += stat.skipped;
            result.rejected += stat.failed;
            result.moved += stat.moved || 0;
            result.synthCreated += stat.synthCreated || 0;
            result.synthUpdated += stat.synthUpdated || 0;
            result.pointersSet += stat.pointersSet || 0;
            result.pointersRejected += stat.pointersRejected || 0;
            if (stat.accounts) {
                result.accounts.matched += stat.accounts.matched || 0;
                result.accounts.unmatched += stat.accounts.unmatched || 0;
                result.accounts.noClue += stat.accounts.noClue || 0;
                result.accounts.conflicts.push(...(stat.accounts.conflicts || []));
            }
        }
        // 归认是"看得见"的：**每次导入都留痕**。
        // 为什么无条件打（只在有认不出时打就不够）："什么都没显示"没法区分
        // "全都认对了"和"归认根本没跑" —— 用户会问"在哪看"，
        // 这就是答案之一（另一处是导入完成提示与值的来源面板）。
        const accLine = describeCounter(result.accounts);
        if (accLine) {
            console.log(`账户归认：${accLine}`);
            if (result.accounts.conflicts.length) {
                console.warn('线索匹配到多个账户（这些记录不归任何人）：', result.accounts.conflicts);
            }
        }
        if (result.reorderedParents) {
            console.log(`同层重排：${result.reorderedParents} 个容器`
                + '（比赛/提交按时间倒序、年份层按年倒序 —— 越新的越靠上）');
        }
        if (result.syncedHeads) {
            console.log(`组头性质对齐：${result.syncedHeads} 个`
                + '（组头的年份/赛季/地区按成员派生 —— 成员被补全后跟着走）');
        }
        result.ok = true;
        if (typeof opts.onSuccess === 'function') opts.onSuccess(result);
        return result;
    } catch (err) {
        result.ok = false;
        result.error = err && err.message ? err.message : String(err);
        result.perItem = [];
        result.created = result.updated = result.skipped = result.rejected = 0;
        result.synthCreated = result.synthUpdated = 0;
        result.pointersSet = result.pointersRejected = 0;
        result.syncedHeads = 0;
        result.accounts = newCounter();
        if (typeof opts.onError === 'function') opts.onError(err);
        return result;
    }
}

/**
 * 给已有节点补写 extKey（第八节 / 8.5 的"只补空的"）
 *
 * 约束：
 *   - **不覆盖已有 key**（幂等，只补空的）
 *   - 目标 key 已被别的节点占用 → 拒绝该条，**不自动挑一个**
 *
 * @param {Object} params
 * @param {Object} params.state
 * @param {Array<{nodeId:string, extKey:string}>} params.assignments
 * @param {Object} [opts]
 * @returns {Promise<{ ok:boolean, changed:number, unchanged:number,
 *                     failed:Array<{nodeId:string, extKey:string, code:string, reason:string}>,
 *                     error?:string }>}
 */
export async function applyExtKeyAssignments({ state, assignments = [] }, opts = {}) {
    return runExtKeyAssignments(assignments, { allowOverwrite: false }, opts);
}

/**
 * **更换** extKey（含清空）—— 危险操作，必须由人在 UI 上显式确认后才调
 *
 * 与 applyExtKeyAssignments 的唯一区别是 `allowOverwrite: true`。
 * 语义后果（UI 必须讲清楚）：
 *   改完之后，爬虫仍用旧 key → **下一次导入会新建一个节点**。
 *   旧节点上的题解不丢，但会与爬虫数据脱钩（两边分叉）。
 *
 * 仍然保留的反智保护：目标 key 已被**别的**节点占用时拒绝——那是脏数据，
 * 不能靠"覆盖"来掩盖。
 *
 * @param {Object} params
 * @param {Array<{nodeId:string, extKey:string}>} params.assignments - extKey 为空串 = 清空
 * @param {Object} [opts]
 * @returns {Promise<{ ok:boolean, changed:number, unchanged:number,
 *                     failed:Array<Object>, error?:string }>}
 */
export async function changeExtKeyAssignments({ assignments = [] }, opts = {}) {
    return runExtKeyAssignments(assignments, { allowOverwrite: true }, opts);
}

/**
 * 两种模式的共同实现（只差 allowOverwrite）
 * @param {Array<Object>} assignments
 * @param {Object} mode - { allowOverwrite }
 * @param {Object} opts - { onSuccess, onError }
 */
async function runExtKeyAssignments(assignments, { allowOverwrite }, opts = {}) {
    const out = { ok: false, changed: 0, unchanged: 0, failed: [] };
    if (!assignments.length) {
        out.ok = true;
        if (typeof opts.onSuccess === 'function') opts.onSuccess(out);
        return out;
    }

    try {
        await execute(draft => {
            const index = buildExtKeyIndex(draft);
            for (const a of assignments) {
                const res = assignExtKey(draft, a.nodeId, a.extKey, index, { allowOverwrite });
                if (!res.ok) {
                    out.failed.push({ nodeId: a.nodeId, extKey: a.extKey, code: res.code, reason: res.reason });
                } else if (res.changed) {
                    out.changed++;
                } else {
                    out.unchanged++;
                }
            }
            return out;
        }, { refreshParentId: null });

        out.ok = true;
        if (typeof opts.onSuccess === 'function') opts.onSuccess(out);
        return out;
    } catch (err) {
        out.ok = false;
        out.error = err && err.message ? err.message : String(err);
        out.changed = 0;
        out.unchanged = 0;
        out.failed = [];
        if (typeof opts.onError === 'function') opts.onError(err);
        return out;
    }
}
