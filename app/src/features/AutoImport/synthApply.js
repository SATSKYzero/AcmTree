// ================================================================
// 节点自动导入 — 合成节点与成员指针的落地（features/AutoImport/synthApply.js）
//
// 职责：把 `plan.synth`（plan.js 算好的两阶段清单）写进 draft。
// 依赖：core/ops/synth.js（createSynthNode / setOwnerRaw）、core/model/elements.js
//       —— **不 import shell/、不碰 DOM**，因此可以在 Node 单测里直接调用
//       （apply.js 只在事务内部转手调用它）。
//
// 为什么单独一个模块（口径「宁可少改既有结构」）：
//   `apply.js` 的 `execute()` 是事务边界、import 了 shell/，进不了纯 Node 单测；
//   而"指针该不该写""合成节点怎么建"这些规则**必须有单测钉住**。
//   于是把这段纯逻辑抽出来，apply.js 里只剩几行转手。
//
// 两阶段的顺序是**硬要求**：先建/更新全部合成节点并登记它们的 `synthKey`，
// **再**处理成员指针 —— 同一次导入里新建的合成节点不算悬空。
// moveOwner 这里是"本批之内"的顺序；跨多个 plan 的引用不在范围（界面一次只执行一个批次）。
//
// **父引用有两种写法**（`父extKey` / `父synthKey`，恰好给一个）。
//   `父synthKey` 让一个合成节点挂到**另一个合成节点**之下 ⇒ 阶段 1 必须
//   知道"哪些合成标识此刻已经可解析"。所以阶段 1 内置一张
//   `synthKey → 节点 id` 表（先灌树上已有的，每建出一个就登记一条），
//   并**分多轮**建：包把子写在父前面也照样挂得上（单轮会把合法的父子
//   误判成"父找不到"，然后静默挂到根下 —— 那是错误结果）。
//
// 三条铁律（与 core/ops/synth.js 一致）：
//   ① 成员关系是**指针**，不是父子：这里只写 `ownerSynth`，不动 childOrder；
//   ② 指针写入走 `setOwnerRaw` —— 它**豁免 manual 闸门**（导入不是手改），
//      但**不豁免校验**：目标必须已在树上（两阶段保证了这一点）、必须是合成标识、
//      成员必须在树上。非法指针在计划层就被拒（预览里"被拒绝"），这里只兜底；
//   ③ `synthKey` / `ownerSynth` **一个来源值都不记**：它们是结构（全局一份），
//      写完之后绝不留下账户级的 manual 来源条目。
// ================================================================
import { createSynthNode, setOwnerRaw, synthIndex, OWNER_FIELD } from '../../core/ops/synth.js';
import { setClassRule } from '../../core/natureConfidence.js';
import { toCacheShape } from '../../core/model/elements.js';
import { getNowStr } from '../../utils/time.js';
import { isPlainObject } from '../../utils/guards.js';
import { str as s } from '../../utils/guards.js';

/** 普通对象（非 null、非数组） *//**
 * 落地一份合成清单（两阶段）。
 *
 * @param {Object} draft - 状态草稿（就地修改，与 ops/ 其余文件一致）
 * @param {Object} synth - `plan.synth`（缺省/空 = 什么都不做）
 * @param {Object} [opts]
 * @param {Object<string,string>} [opts.index] - extKey → nodeId（事务内维护；原地读取）
 * @param {string} [opts.rootId] - 缺省取 draft.rootId
 * @param {Function} [opts.onCreated] - (node, entry) => void；**新建**合成节点后回调
 *        （apply.js 用它写存在性归属 `origin`，与普通新节点走同一条规则）
 * @returns {{ created:number, updated:number, skipped:number, pointersSet:number,
 *             pointersRejected:number, failed:Array<Object> }}
 */
export function applySynthPart(draft, synth, opts = {}) {
    const out = {
        created: 0, updated: 0, skipped: 0,
        pointersSet: 0, pointersRejected: 0,
        failed: []
    };
    if (!draft || !draft.nodes || !isPlainObject(synth)) return out;

    const index = isPlainObject(opts.index) ? opts.index : {};
    const rootId = opts.rootId || draft.rootId;
    const nodes = Array.isArray(synth.nodes) ? synth.nodes : [];
    const pointers = Array.isArray(synth.pointers) ? synth.pointers : [];

    // 本批**新建**的合成节点：`synthKey → 节点 id`。
    // 它是 `父synthKey`（父是合成节点）的解析表 —— 这正是"两阶段时序"在
    // **阶段 1 内部**的那一半：父可以比子晚出现在清单里，照样挂得上。
    // ⚠️ 先灌入**树上已有的**合成标识：于是"父在树上、子是本批新建"这条路
    //    不会被多轮循环当成"父还没建出来"而空转（空转会让它落到兜底那一档）。
    const createdSynthIds = new Map(synthIndex(draft).byKey);

    // ============================================================
    // 阶段 1：合成节点（新建 / 更新）——必须先于指针
    // ============================================================
    // 分**多轮**建：一轮里只建"父此刻已可解析"的那些，全部都建不动就收尾。
    // 为什么要多轮：`父synthKey` 可以让一个合成节点挂到**同批的另一个合成节点**
    // 之下 —— 而清单的顺序是包的顺序，包完全可以把子写在父前面。
    // 单轮循环会把那种合法的父子判成"父找不到"，然后**静默挂到根下**（错误结果）。
    const remaining = nodes.slice();
    const createdHere = new Set();
    let progress = true;
    while (remaining.length && progress) {
        progress = false;
        for (let i = 0; i < remaining.length;) {
            const entry = remaining[i];
            if (!entry || !entry.synthKey || entry.action !== 'create') { i++; continue; }
            // 父也还没建出来（同批、更靠后）⇒ 留到下一轮，别当"父不存在"
            if (entry.parentSynthKey && !createdSynthIds.has(entry.parentSynthKey)) {
                i++;
                continue;
            }
            remaining.splice(i, 1);
            createdHere.add(entry);
            if (createOne(draft, entry, { index, rootId, createdSynthIds, out, opts })) progress = true;
        }
    }
    // 剩下的都是"父合成节点本包没建出来、树上也没有"（计划层已把这种拒掉了；
    // 这里是兜底：逐条失败、**不静默挂根**，与阶段 2 对非法指针的处理同一口径）。
    // ⚠️ 只对 create 条目报告：`createOne` 失败的那些已经在上面报过了，
    //    再报一次会让同一条记录出现两条错误（原因还可能说得不一样）。
    // ⚠️ **必须显式跳过非 create 条目**（"失败 179"就是这个）：
    //    上面那个 for 只 `splice` create 条目 ⇒ **update / skip 的条目会一直留在 `remaining` 里**
    //    （它们既不是"父找不到"，也不需要建）。少了这一行，重导一次（合成节点已存在 ⇒
    //    计划里是 update）就会给**每一个**合成节点报一条假的「父合成节点不存在：父synthKey = ""」
    //    —— 干活其实全干成了（下面的 update 分支照跑），但导入摘要写着"失败 179"。
    for (const entry of remaining) {
        if (!entry || !entry.synthKey) continue;
        if (entry.action !== 'create') continue;
        if (createdHere.has(entry)) continue;
        out.failed.push({
            synthKey: entry.synthKey, code: 'parent-not-found',
            reason: `父合成节点不存在：父synthKey = "${s(entry.parentSynthKey)}"`
                + '（本包里没有建出这个父，树上也没有）'
        });
    }

    // 更新 / 跳过：与父引用无关（节点已经在树上），一轮走完即可
    for (const entry of nodes) {
        if (!entry || !entry.synthKey) continue;
        if (createdHere.has(entry) || entry.action === 'create') continue;
        if (entry.action === 'update') {
            const node = entry.nodeId ? draft.nodes[entry.nodeId] : null;
            if (!node) {
                out.failed.push({
                    synthKey: entry.synthKey, code: 'no-node',
                    reason: `合成节点不存在：${entry.nodeId}`
                });
                continue;
            }
            writeFields(node, entry.fields);
            node.lastModified = getNowStr();
            out.updated++;
        } else {
            out.skipped++;
        }
    }

    // ============================================================
    // 阶段 2：成员指针（此刻合成节点已经建齐）
    // ============================================================
    for (const p of pointers) {
        if (!p) continue;
        if (p.action === 'reject') { out.pointersRejected++; continue; }
        if (p.action !== 'set') {
            // ★ **「值已经一致」也要看一眼依据**（`p.rule` = 包里那条 `分类依据.ownerSynth`）：
            //   包带的是人绑（`manual:set`）而树上那格没标记 ⇒ 补上 —— 这就是"重导一次把
            //   人的结论从包里恢复回来"。不补的后果实测过：应用把它降级成脚本值，
            //   下次「📤 导出人工填写」当非人工丢掉（比对弹窗"少了 1 个节点"）。
            //   ⚠️ 只在**包带了依据**时写；包没带（脚本产的指针）**不动**树上原有的标记
            //      —— 与普通记录"值没变就不清旧规则"同一口径（见 `applyClassRules` 的说明）。
            if (p.action === 'same' && p.rule) {
                const sameId = p.nodeId || (p.extKey ? index[p.extKey] : '');
                if (applyOwnerRule(sameId ? draft.nodes[sameId] : null, p.rule)) {
                    // 不并进 `pointersSet`：那是"写了几条指针"，与预览里那个数**一一对应**
                    // （预览算的是 `action === 'set'`）；这里只是补了"凭什么"，与普通记录
                    // 那条"跳过但记了来源"同一档（打一行日志就够，见 `apply.js` 的同款探针）。
                    console.log(`指针值没变、补了依据：${p.extKey} ← ${p.rule}`);
                }
            }
            continue;
        }

        const nodeId = p.nodeId || (p.extKey ? index[p.extKey] : '');
        const node = nodeId ? draft.nodes[nodeId] : null;
        if (!node) {
            out.failed.push({
                extKey: p.extKey, code: 'no-node',
                reason: `要设指针的节点不存在：extKey = "${s(p.extKey)}"`
            });
            continue;
        }
        // 双保险（计划层已经拒过）：树上已有非空指针 ⇒ **不覆盖**。
        // 计划与实际之间隔着一次 execute，这条兜底保证"包不得覆盖已有指针"永远成立。
        if (s(node[OWNER_FIELD])) { out.pointersRejected++; continue; }

        // ★ 走 setOwnerRaw：豁免 manual 闸门（导入不是手改），但**一样校验** ——
        //   目标必须存在（第一阶段已把包内新建的合成节点落地/登记好，所以同一次导入
        //   里"新建 + 指向它"是合法的）、必须是 synthKey 而不是节点 id、成员必须在树上。
        //   计划层已经按同一套判据把非法条目拒掉了；这里 catch 是**兜底**：
        //   计划与实际之间隔着一次 execute，逐条失败、不整批报废（与阶段 1 同口径）。
        try {
            // ★ 传 `holderId`：本表（已播种树上已有的 + 每建一个就 set）就是 `synthIndex` 的答案，
            //   不传的话这里每个指针都要重扫全表（实测：918 个指针 = 70s）。
            setOwnerRaw(draft, node.id, p.synthKey, { holderId: createdSynthIds.get(p.synthKey) || '' });
            // ★ 依据跟着值一起落（**如实搬运**包里的 `分类依据.ownerSynth`）：
            //   人手绑的那条带着 `manual:set`，不搬就等于把"这是人的结论"降级成脚本值
            //   ⇒ 下次导出人工填写会把它丢掉。包没带依据（脚本指针）⇒ `setClassRule('')`
            //   会清掉旧规则 —— 值这次真被换了，旧规则描述的已经是旧值（与 `applyClassRules`
            //   的 `clearStale` 同一条口径）。
            applyOwnerRule(node, p.rule);
            node.lastModified = getNowStr();
            out.pointersSet++;
        } catch (err) {
            out.pointersRejected++;
            out.failed.push({
                extKey: p.extKey, code: 'pointer-rejected',
                reason: err && err.message ? err.message : String(err)
            });
        }
    }

    return out;
}

/**
 * 把包里那条 `分类依据.ownerSynth` 写到节点上（空串 = 清掉旧规则）。
 *
 * 为什么要这一步：绑定的**值**由 `setOwnerRaw` 写（豁免 manual 闸门），但"这是人的结论"
 * 这个标记只写在手改那条路上（`core/ops/synth.js` 的 `applyOwnerSynth`）⇒ 导入的绑定
 * 会**降级成脚本值**：下次「📤 导出人工填写」两个信号都不成立（没有 `manual:set`、
 * 键又是脚本格式）⇒ 那条人工绑定从 baseline 里消失（实测：导出比对报"少了 1 个节点"）。
 * 口径：**如实搬运** —— 包里写的是什么依据就记什么；包没写（脚本产的指针）就清/不写。
 *
 * @returns {boolean} 是否真的改了那格
 */
function applyOwnerRule(node, rule) {
    if (!node) return false;
    // `setClassRule` 内部：空串 ⇒ 清掉、一样 ⇒ 不动；返回值 = 是否真改
    return !!setClassRule(node, OWNER_FIELD, String(rule || '').trim());
}

/**
 * 建一个合成节点（阶段 1 的一轮里的一个条目）。
 *
 * 单独抽出来只是为了让"多轮建"的主循环读得懂（它要处理"父还没建出来"的重试）。
 *
 * @returns {boolean} 是否真的处理了（false = 失败，见 `out.failed`）
 */
function createOne(draft, entry, { index, rootId, createdSynthIds, out, opts }) {
    try {
        const parentId = resolveParent(draft, entry, index, rootId, createdSynthIds);
        if (!parentId) {
            out.failed.push({
                synthKey: entry.synthKey, code: 'parent-not-found',
                reason: entry.parentSynthKey
                    ? `父合成节点不存在：父synthKey = "${s(entry.parentSynthKey)}"（本包里没建出它，树上也没有）`
                    : `父节点不存在：父extKey = "${s(entry.parentExtKey)}"`
            });
            return false;
        }
        // 合成节点的创建**走 createSynthNode**（身份校验/唯一性/同类型规则都在那里）。
        // `allowReserved: true` 是**导入专用**：包里的标识是别的机器自动生成的
        // （`synth:1` 这种带保留前缀的），必须原样落地，否则往返就断了。
        // `expandParent: false` 也是导入铁律：**导入不展开节点**
        // （一次上百个节点会把树炸开、还会撞上展开上限，见 upsertRecord 的同款注释）。
        const node = createSynthNode(draft, parentId, {
            synthKey: entry.synthKey,
            type: entry.type,
            name: entry.fields ? entry.fields.name : '',
            allowReserved: true,
            expandParent: false,
            // ★ 占用表就是本表（已播种树上已有的 + 每建一个 set 一个）⇒ 省掉每个节点一遍全表扫描
            takenHint: createdSynthIds
        });
        writeFields(node, entry.fields, { skipName: true });
        createdSynthIds.set(entry.synthKey, node.id);
        out.created++;
        if (typeof opts.onCreated === 'function') opts.onCreated(node, entry);
        return true;
    } catch (err) {
        // 逐条失败，不整批报废（与 apply.js 对普通记录的处理一致）：
        // 事务本身仍会提交，失败的条目进 `failed` 计数。
        out.failed.push({
            synthKey: entry.synthKey, code: 'synth-apply-failed',
            reason: err && err.message ? err.message : String(err)
        });
        return false;
    }
}

/**
 * 解析父节点 id。**两种父引用**（parse/resolve 已裁定恰好给一个）：
 *   · `parentExtKey`   父是普通节点 → 包内/树上都按 extKey 查
 *   · `parentSynthKey` 父是合成节点 → 先看**本批刚建出来的**（`createdSynthIds`），
 *                      再看树上已有的（阶段 1 的多轮保证父在子前建好）
 * 两种都留空 = 挂真实根节点（与应用侧 3.3 一致）。
 *
 * @returns {string} 父节点 id；解析不出来返回 ''（调用方按 `parent-not-found` 逐条失败）
 */
function resolveParent(draft, entry, index, rootId, createdSynthIds) {
    const synthKey = s(entry.parentSynthKey);
    if (synthKey) {
        // ⚠️ **不要再 `synthIndex(draft)`**（`createdSynthIds` 早在
        //    进来时就**用树上已有的合成标识灌满了**（见上面 `new Map(synthIndex(draft).byKey)`），
        //    且每建一个就 `.set` 一次 ⇒ 它就是"本批 + 树上"的完整解析表）。
        //    在这里重扫一遍全表的代价：`synthIndex` 两趟 `Object.keys`，而且是
        //    **immer draft** 上读 25k 个代理 —— 实测 483 个合成节点吃掉 **70.7s**（占整个导入 98%）。
        const id = createdSynthIds.get(synthKey);
        return (id && draft.nodes[id]) ? id : '';
    }
    const key = s(entry.parentExtKey);
    if (!key) return (rootId && draft.nodes[rootId]) ? rootId : '';
    const id = index[key];
    return (id && draft.nodes[id]) ? id : '';
}

/** 把计划里算好的字段写进节点（形状按属性表转一次，见 toCacheShape） */
function writeFields(node, fields, { skipName = false } = {}) {
    if (!isPlainObject(fields)) return;
    for (const key of Object.keys(fields)) {
        if (skipName && key === 'name') continue;   // name 已由 createSynthNode 写（含重名规避）
        node[key] = toCacheShape(key, fields[key]);
    }
}
