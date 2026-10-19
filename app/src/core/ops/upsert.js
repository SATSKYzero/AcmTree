// ================================================================
// 增量 upsert（core/ops/upsert.js）
// 职责：按 extKey 身份为主树做「查 → 增 / 改」，供节点自动导入使用
// 依赖：_helpers.js, model/node.js, model/constants.js
// 约定：所有函数不返回新状态，直接修改 draft（与 ops/ 其余文件一致）
// 不变量：
//   - draft.parentOf 与 draft.childOrder 保持一致
//   - 不覆盖 STRUCTURAL / AUTO 字段（见下方常量）
// 自动计算：
//   本模块**刻意不跑** fullAutoUpdate。批量导入必须由调用方在循环结束后
//   统一跑一次（否则退化为 O(N²)，与 handlers/H2_batchImport.js 同样的处理）。
//
// 设计依据：docs/auto-import.md
//   - 判定规则（key 精确相等）   → 4.2
//   - 容器可不在包里但必须在树上 → 2.3
//   - 父引用留空即挂根           → 3.3
//   - extKey 全局唯一            → 2.4
// ================================================================
import { createNode } from '../model/node.js';
import { TYPE_CHILDREN_MAP, badParentTypeMessage } from '../model/constants.js';
import { getNowStr } from '../../utils/time.js';
import { nextNodeId, ensureChildOrder, pushChild, reparent, setParentOf, parentOfInDraft } from './_helpers.js';
import { assertManualEditAllowed } from './account.js';
import { structuralElements, derivedElements, natureElements, ELEMENT_NATURE, inapplicableFields, toCacheShape } from '../model/elements.js';

// ================================================================
// 受保护字段：导入**禁止**写入
// ================================================================

/**
 * 结构字段：由树结构本身决定，插件/导入不得触碰。
 *
 * ⚠️ **不手抄**：它是 `core/model/elements.js` 里 `nature === STRUCTURAL` 的元素
 * （加一个结构字段 = 属性表加一行，这里自动跟上）。
 *
 * 合成的例外（**刻意不是**结构字段，改动前先读 docs/manual-workflow.md（合成节点的指针））：
 *   `synthKey`（合成节点的身份）与 `ownerSynth`（原料节点的成员指针）的
 *   `nature` 是 `FIELD`，属性组合是 `importable: true, manual: false` ——
 *   "包**可以带**它们"，"但**不记手改来源值**"。
 *   它们**不在**下面的名单里，所以 `isWritableField()` 对它们返回 true。
 *   ⚠️ 谁都不许把它们挪进 `structuralElements`（或往本数组里手加一行）：
 *      那会让"包能带合成节点与成员指针"整体失效。
 *   ⚠️ 实际写入走的是 `features/AutoImport/synthApply.js` 的两阶段通道
 *      （`setOwnerRaw` 豁免 manual 闸门），**不走** `upsertRecord` 的逐字段合并；
 *      这里的放行是"入口不该被挡住"的语义保证。
 */
export const PROTECTED_NODE_KEYS = Object.freeze([
    ...structuralElements(),
    // 存在性（`origin`）：由**创建动作**写一次，导入包不许伪造"这个节点是我建的"
    ...natureElements(ELEMENT_NATURE.EXISTENCE)
]);

/**
 * 派生字段：由 core/autoCompute.js 从子节点或 ratio 推导。
 * 导入写它们会与 autoCompute 打架，且下一轮重算就被冲掉。
 *
 * ⚠️ 同样**从属性表派生**（`nature === DERIVED`）。
 */
export const AUTO_NODE_KEYS = Object.freeze(derivedElements());

const PROTECTED = new Set([...PROTECTED_NODE_KEYS, ...AUTO_NODE_KEYS]);

/** 该字段是否允许由导入写入 */
export function isWritableField(key) {
    return !PROTECTED.has(key);
}

// ================================================================
// extKey 索引
// ================================================================

/**
 * 建立 extKey → nodeId 的全局索引
 *
 * 注意：**只收录非空 extKey**。空串/undefined 不入表，因此"查不到"
 * 与"没有 extKey"在查找层是同一回事（区分交给 plan 层）。
 * 若同一 extKey 出现多次（脏数据），**保留最先遇到的**，
 * 冲突由 core/validate/upsertConflict.js 的 collectExtKeyConflicts 报出。
 *
 * @param {Object} state - AppState 或 draft
 * @returns {Object<string,string>} extKey → nodeId
 */
export function buildExtKeyIndex(state) {
    const index = {};
    if (!state || !state.nodes) return index;
    for (const id in state.nodes) {
        const node = state.nodes[id];
        if (!node || !node.extKey) continue;
        const key = String(node.extKey).trim();
        if (!key) continue;
        if (!(key in index)) index[key] = id;
    }
    return index;
}

// ================================================================
// 字段清洗
// ================================================================

/**
 * 从记录里挑出可写入节点的字段
 *
 * @param {Object} fields - 记录上已映射为内部字段名的字段表
 * @param {Object} [opts]
 * @param {string[]} [opts.allowedFields] - 白名单（缺省不限制）
 * @returns {Object} 清洗后的字段表（新对象）
 */
export function cleanNodeFields(fields, { allowedFields } = {}) {
    const out = {};
    if (!fields || typeof fields !== 'object') return out;
    const allowed = Array.isArray(allowedFields) ? new Set(allowedFields) : null;

    for (const key of Object.keys(fields)) {
        if (!isWritableField(key)) continue;
        if (allowed && !allowed.has(key)) continue;
        const value = fields[key];
        if (value === undefined) continue;
        out[key] = value;
    }
    return out;
}

// ---- 浅比较（节点字段都是标量或一维数组，无需深比较库） ----
function sameValue(a, b) {
    if (a === b) return true;
    if (Array.isArray(a) || Array.isArray(b)) {
        return JSON.stringify(a) === JSON.stringify(b);
    }
    return false;
}

// ================================================================
// upsertRecord
// ================================================================

/**
 * 按 extKey 增量写入一条记录
 *
 * 判定（docs/auto-import.md 4.2）：**extKey 精确相等才合并，否则新建。**
 * 没有任何模糊匹配、没有降级阶梯。
 *
 * ⚠️ 已有节点不只是**合并字段**：记录的 `父extKey` 若与树上现在挂的父不同，会**换父**
 *    （`moveNode`，段末说明）—— 位置的唯一真源在包里，应用里没有别的换父入口。
 *
 * @param {Object} draft - 状态草稿
 * @param {Object} record
 * @param {string} record.type - 'O'|'W'|'S'|'C'|'P'|'R'
 * @param {string} record.extKey - 非空身份键
 * @param {string} [record.parentExtKey] - 留空 ⇒ 挂根（见 3.3）
 * @param {Object} [record.fields] - 已映射为内部字段名的字段表
 * @param {Object<string,string>} index - extKey → nodeId（由调用方维护并原地更新）
 * @param {Object} [opts]
 * @param {string} [opts.rootId] - 缺省取 draft.rootId
 * @param {Object} [opts.mergedFields] - 覆盖 record.fields；由 plan/merge 层算好的最终值
 * @param {string[]} [opts.allowedFields] - 字段白名单
 * @returns {{ ok: boolean, action?: 'created'|'updated', nodeId?: string,
 *             created?: boolean, changedFields?: string[],
 *             reason?: string, code?: string }}
 */
export function upsertRecord(draft, record, index, opts = {}) {
    if (!draft || !draft.nodes) {
        return { ok: false, code: 'bad-draft', reason: '状态草稿无效' };
    }
    if (!record || typeof record !== 'object') {
        return { ok: false, code: 'bad-record', reason: '记录不是对象' };
    }

    // ---- 1. 类型校验 ----
    const type = record.type ? String(record.type).trim().toUpperCase() : '';
    if (!TYPE_CHILDREN_MAP[type]) {
        return {
            ok: false,
            code: 'bad-type',
            reason: `未知节点类型 "${record.type}"（应为 O/W/S/C/P/R 之一）`
        };
    }

    // ---- 2. 身份校验（必须有 extKey，见 4.4） ----
    const rawKey = record.extKey;
    const extKey = (rawKey === undefined || rawKey === null) ? '' : String(rawKey).trim();
    if (!extKey) {
        return {
            ok: false,
            code: 'missing-extkey',
            reason: '缺少身份键 extKey（不能为空）'
        };
    }

    // ---- 3. 解析父节点（包内优先 / 树上其次 / 否则拒绝，见 2.3、3.3） ----
    const rawParent = record.parentExtKey;
    const parentKey = (rawParent === undefined || rawParent === null) ? '' : String(rawParent).trim();
    let parentId;

    if (!parentKey) {
        parentId = opts.rootId || draft.rootId;
        if (!parentId || !draft.nodes[parentId]) {
            return { ok: false, code: 'no-root', reason: '根节点不存在' };
        }
    } else {
        parentId = index ? index[parentKey] : undefined;
        if (!parentId || !draft.nodes[parentId]) {
            return {
                ok: false,
                code: 'parent-not-found',
                reason: `父节点不存在：父extKey = "${parentKey}"（包内与树上都没有）`
            };
        }
    }

    const parent = draft.nodes[parentId];

    // ---- 4. 父子类型约束 ----
    // ⚠️ 那句话**不在这里拼**：判据（`TYPE_CHILDREN_MAP`）与说法同处一源
    //    （`core/model/constants.js` 的 `badParentTypeMessage`）—— 预览、合成节点那一侧、
    //    产包合并读的都是**同一句**（各写一句的话，同一个包在四个入口有四种说法）。
    const typeMsg = badParentTypeMessage(parent.type, type, {
        parentKey, childKey: extKey, parentCol: '父extKey'
    });
    if (typeMsg) {
        return { ok: false, code: 'bad-parent-type', reason: typeMsg };
    }

    // ---- 5. 字段清洗 ----
    const source = opts.mergedFields !== undefined ? opts.mergedFields : record.fields;
    const clean = cleanNodeFields(source, { allowedFields: opts.allowedFields });

    // ---- 5a. 缓存字段的形状 ----
    // `tags` 在来源层是**字符串数组**，而缓存字段 `node.tags` 是 `[{id,text,color}]`。
    // 不转就直接写缓存 → 标签管理器空白行、删除/上移报"标签不存在"。
    for (const key of Object.keys(clean)) {
        clean[key] = toCacheShape(key, clean[key]);
    }

    // ---- 5b. 字段是否适用于这个节点类型（属性表的 `types`）----
    // 属性表声明了"这个元素属于哪些节点类型"，就要拿它做校验 ——
    // 否则"给 C 节点的记录里塞 ratio（P 专有）"会被静默写进去。口径：**拒绝并报错**。
    const notApplicable = inapplicableFields(type, clean);
    if (notApplicable.length) {
        return {
            ok: false,
            code: 'field-not-applicable',
            reason: `${type} 节点不适用字段：${notApplicable.join('、')}`
                + `（见 core/model/elements.js 的 types 声明）`
        };
    }

    // ---- 6. 查 → 合并 / 新建 ----
    const existingId = index ? index[extKey] : undefined;
    const existing = existingId ? draft.nodes[existingId] : null;

    if (existing) {
        // 6a. 既有节点的类型必须与记录一致（extKey 撞上别的类型 = 记录写错了，
        //     不查类型就会按"已存在"策略把字段合并进类型不符的节点）
        if (existing.type !== type) {
            return {
                ok: false,
                code: 'type-mismatch',
                reason: `extKey "${extKey}" 命中的既有节点是 ${existing.type} 类型，`
                    + `而记录声明为 ${type}`
            };
        }
        const changedFields = [];
        for (const key of Object.keys(clean)) {
            if (sameValue(existing[key], clean[key])) continue;
            existing[key] = clean[key];
            changedFields.push(key);
        }
        // ★ **位置也以记录为准**（与字段同一条口径：记录说什么就是什么）
        //   应用里**没有**别的换父入口（只有同级上移/下移）⇒ 记录的 `父extKey` 是位置唯一真源；
        //   不搬的话，脚本侧的落位改动（`scripts/nature-rehome.mjs` 那种）永远看不见，
        //   而"分类说 xcpc、树里还挂在 Universal Cup 下"只能靠人手删了重导。
        //   ⚠️ 这里只调**结构手术** `_helpers.reparent`（不调 `tree.js` 的 `moveNode`）：
        //      ① 父容器类型在第 4 步已经校验过；② 重算由调用方在循环结束后统一跑一次
        //      （本模块刻意不跑 fullAutoUpdate），而 `tree.js` 会牵进 `shell/state.js`
        //      ⇒ `src/test/` 那边直接 import 本模块时会炸（实测过）。
        const curParentId = parentOfInDraft(draft, existing.id) || '';
        const moved = (curParentId !== parentId) ? reparent(draft, existing.id, parentId) : false;
        if (changedFields.length > 0 || moved) {
            existing.lastModified = getNowStr();
        }
        return {
            ok: true,
            action: 'updated',
            nodeId: existing.id,
            created: false,
            moved,
            changedFields
        };
    }

    // ---- 新建 ----
    const id = nextNodeId(draft);
    const node = createNode(id, type, { extKey, ...clean });
    pushChild(draft, parentId, id);
    setParentOf(draft, id, parentId);
    // 刻意**不**展开父节点。
    // 一次导入动辄上百个节点，逐级展开会把整棵树炸开、还会撞到
    // settings.performance 的展开上限（见 core/validate/expanded.js）。
    // 新节点自身默认 expanded:false；想找新节点用「定位」动作
    // （EVENTS.REVEAL_NODE → ui/revealNode.js 会按需展开那条链）。
    draft.nodes[id] = node;
    ensureChildOrder(draft, id);

    if (index) index[extKey] = id;

    return {
        ok: true,
        action: 'created',
        nodeId: id,
        created: true,
        moved: false,
        changedFields: Object.keys(clean)
    };
}

// ================================================================
// 补身份键（docs/auto-import.md 第八节）
// ================================================================

/**
 * 给已有节点补写 / 更换 / 清空 extKey
 *
 * 三种模式（由 opts.allowOverwrite 区分）：
 *
 * | 调用 | 行为 |
 * |---|---|
 * | `assignExtKey(d, id, key)`              | **只补空的**；已有 key → 拒绝（幂等） |
 * | `assignExtKey(d, id, key, idx, {allowOverwrite:true})` | **更换**（含清空） |
 *
 * 为什么默认不允许覆盖：
 *   改了 key 就等于换了身份 —— 爬虫那边仍用旧 key，
 *   于是**下一次导入会新建一个节点**。这是不可逆的分叉，
 *   所以必须由人在「补身份键」页显式操作，不能由导入流程自动做。
 *
 * 清空（`extKey` 传空且 allowOverwrite）是**救援通道**：
 *   补错了又不知道正确的 key 时，先清空退回"未设身份"，
 *   之后可以重新补；否则那个错误 key 会永久卡住这个节点。
 *
 * @param {Object} draft
 * @param {string} nodeId
 * @param {string} extKey - 新 key；空串表示清空（需 allowOverwrite）
 * @param {Object<string,string>} [index] - extKey → nodeId；会原地更新
 * @param {Object} [opts]
 * @param {boolean} [opts.allowOverwrite=false] - 是否允许覆盖 / 清空已有 key
 * @returns {{ ok: boolean, changed?: boolean, reason?: string, code?: string }}
 */
export function assignExtKey(draft, nodeId, extKey, index, opts = {}) {
    // 只读边界：改身份键同样是手改（它会分叉整棵树），在查看别人时禁止
    assertManualEditAllowed(draft, '修改身份键');

    const node = draft && draft.nodes ? draft.nodes[nodeId] : null;
    if (!node) {
        return { ok: false, code: 'no-node', reason: `节点不存在：${nodeId}` };
    }

    const { allowOverwrite = false } = opts;
    const key = (extKey === undefined || extKey === null) ? '' : String(extKey).trim();
    const current = node.extKey ? String(node.extKey).trim() : '';

    // ---- 清空（仅"更换"模式允许） ----
    if (key === '') {
        if (!allowOverwrite) {
            return { ok: false, code: 'empty-key', reason: 'extKey 不能为空' };
        }
        if (current === '') {
            return { ok: true, changed: false };   // 本来就空，幂等
        }
        if (index && index[current] === nodeId) delete index[current];
        node.extKey = '';
        node.lastModified = getNowStr();
        return { ok: true, changed: true };
    }

    // ---- 补空 / 更换 ----
    if (current === key) {
        return { ok: true, changed: false };       // 幂等：值没变
    }

    if (current !== '' && !allowOverwrite) {
        return {
            ok: false,
            code: 'already-has-key',
            reason: `节点已有 extKey "${current}"，不覆盖（如需更换请走「更换 key」并确认后果）`
        };
    }

    // 冲突：同一 key 不能挂两个节点（即使是在"更换"模式下）
    const owner = index ? index[key] : undefined;
    if (owner && owner !== nodeId) {
        return {
            ok: false,
            code: 'key-taken',
            reason: `extKey "${key}" 已被节点 ${owner} 占用`
        };
    }

    if (index) {
        if (current) delete index[current];
        index[key] = nodeId;
    }
    node.extKey = key;
    node.lastModified = getNowStr();
    return { ok: true, changed: true };
}
