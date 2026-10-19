// ================================================================
// 来源优先级的**写操作**（core/ops/trust.js）
//
// 职责：值级界面那三个动作的落点
//   1. setFieldPrefer   ——「以后这个字段优先用这个来源」
//   2. markValueInvalid ——「这个值我不用了」
//   3. removeSourceValue ——「这条值**真删**掉」
//   4. applyManualValue ——「以我填的为准」（走手工编辑那条路，这里只提供入口）
//
// 依赖：core/fieldValue.js（读值/投影）, core/trust.js（投影规则）
// 依据：值级 UI
//
// ★ 一条关键设计：**设了偏好就立刻生效**
// --------------------------------------------------------
// 缓存字段平时由合并策略写（保证零行为变化）。如果"设为首选来源"只改配置、
// 不改值，用户会看到"我设了却没反应" —— 那等于没做。所以这里的做法是**按字段生效**：
// 你为某字段指定偏好时，就**只把那个字段**改成由投影决定（reprojectField），
// 并立刻重算其缓存值；其它字段的行为一个都不变。
//
// 于是三个动作都是**可逆**的：把偏好清掉/把值恢复有效，再投影一次就回到原样。
// ================================================================
import { applyProjection } from '../fieldValue.js';
import { normalizeTrust } from '../trust.js';
import { getNodeDefaults } from '../model/node.js';

/**
 * 在来源层里找一条值。
 *
 * ⚠️ **必须连 `account` 一起配对**：手改值按账户各留一条
 * （同一字段可能同时有"我改的"和"队友改的"，`src` 都是 `manual`）——
 * 只按 `(src, 值)` 找会命中的是**别人那条**，于是一按「不用/真删」就删错人。
 *
 * @param {Array} list
 * @param {string} src
 * @param {*} value
 * @param {string|undefined|null} account - 给了就精确配对；`undefined`/`null` = 只在 `<客观>` 那条里找
 *        （不传账户时，按"值没有账户归属"的口径）
 */
export function findSourceValueIndex(list, src, value, account) {
    const v = String(value);
    const acc = (account === undefined || account === null) ? '' : String(account);
    return list.findIndex(x => x && x.src === src && String(x.v) === v
        && String((x && x.account) || '') === acc);
}

/** 该字段当前配置的偏好（数组形式） */
export function getFieldPrefer(trust, field) {
    const t = normalizeTrust(trust);
    const v = t.fieldPrefer[field];
    if (!v) return [];
    return Array.isArray(v) ? v.slice() : [v];
}

/**
 * 「以后这个字段优先用这个来源」
 *
 * @param {Object} draft - Immer draft（或普通 state）
 * @param {string} field
 * @param {string} pattern - 来源 id，或前缀模式（`pta:*`）
 * @returns {{ ok:boolean, reason?:string, prefer:string[], reprojected?:Object }}
 */
export function setFieldPrefer(draft, field, pattern) {
    if (!draft || !field || !pattern) return { ok: false, reason: '参数不全' };
    if (!draft.trust || typeof draft.trust !== 'object') {
        draft.trust = { categoryRank: ['manual', 'board', 'script', 'derived'], sources: {}, fieldPrefer: {} };
    }
    if (!draft.trust.fieldPrefer || typeof draft.trust.fieldPrefer !== 'object') {
        draft.trust.fieldPrefer = {};
    }
    // 手改永远最高，写进去也没用 —— 直接说清楚，别让用户以为设了会生效
    if (String(pattern) === 'manual') {
        return { ok: false, reason: '手改的值本来就优先，不需要设置' };
    }
    draft.trust.fieldPrefer[field] = [String(pattern)];
    return { ok: true, prefer: [String(pattern)], reprojected: reprojectField(draft, field) };
}

/** 清掉某字段的偏好（回到"按类别/等级"的默认规则） */
export function clearFieldPrefer(draft, field) {
    if (!draft || !field || !draft.trust || !draft.trust.fieldPrefer) {
        return { ok: false, reason: '没有可清除的偏好' };
    }
    if (!Object.prototype.hasOwnProperty.call(draft.trust.fieldPrefer, field)) {
        return { ok: false, reason: '这个字段本来就没有偏好' };
    }
    delete draft.trust.fieldPrefer[field];
    return { ok: true, prefer: [], reprojected: reprojectField(draft, field) };
}

// ================================================================
// 字段组偏好
//
// "注意数值难度可能有需要**快捷切换所查看系列**的需求"
// —— 同一道题可能同时有 CF 官方难度和 AtCoder 难度（`数值难度` 组的两个成员），
//    界面得能一键说"这道题我想看哪个口径的"。
//
// ⚠️ 与 `fieldPrefer`（"这个**字段**优先用哪个**来源**"）是**两件事**，别混：
//    · `fieldPrefer` 管"同一个字段的多个来源值谁赢"；
//    · `groupPrefer` 管"这一**组**（同一类信息的不同字段）里显示哪一个"。
//    组偏好的语义是**显示口径**，不改各成员自己的值（每个来源的值都还在来源层里）。
// ================================================================

/** 这一组当前选的成员字段（没设过就空串） */
export function getGroupPrefer(trust, group) {
    const t = normalizeTrust(trust);
    const table = (t && t.groupPrefer) || {};
    const v = table[group];
    return v === undefined || v === null ? '' : String(v);
}

/**
 * 「这一组以后显示这个成员」（如 `数值难度` → `atcoderDifficulty`）
 *
 * @returns {{ ok:boolean, reason?:string, prefer:string }}
 */
export function setGroupPrefer(draft, group, field) {
    if (!draft || !group || !field) return { ok: false, reason: '参数不全', prefer: '' };
    if (!draft.trust || typeof draft.trust !== 'object') {
        draft.trust = { categoryRank: ['manual', 'board', 'script', 'derived'], sources: {},
                        fieldPrefer: {}, groupPrefer: {} };
    }
    if (!draft.trust.groupPrefer || typeof draft.trust.groupPrefer !== 'object') {
        draft.trust.groupPrefer = {};
    }
    draft.trust.groupPrefer[group] = String(field);
    return { ok: true, prefer: String(field) };
}

/** 清掉某组的显示偏好（回到"按注册表成员顺序取第一个有值的"） */
export function clearGroupPrefer(draft, group) {
    if (!draft || !group || !draft.trust || !draft.trust.groupPrefer) {
        return { ok: false, reason: '没有可清除的组偏好' };
    }
    if (!Object.prototype.hasOwnProperty.call(draft.trust.groupPrefer, group)) {
        return { ok: false, reason: '这一组本来就没有偏好' };
    }
    delete draft.trust.groupPrefer[group];
    return { ok: true, prefer: '' };
}

/**
 * 「这个值我不用了」/ 恢复
 *
 * 只标记，不删除 —— 留痕（"谁说过什么"）要留得住。
 *
 * @param {Object} draft
 * @param {string} nodeId
 * @param {string} field
 * @param {string} src
 * @param {*} value
 * @param {boolean} [invalid=true]
 * @returns {{ ok:boolean, reason?:string, reprojected?:Object }}
 */
export function markValueInvalid(draft, nodeId, field, src, value, invalid = true, account = undefined) {
    const node = draft && draft.nodes ? draft.nodes[nodeId] : null;
    if (!node) return { ok: false, reason: '节点不存在' };
    const list = (node.values && node.values[field]) || [];
    const i = findSourceValueIndex(list, src, value, account);
    if (i < 0) return { ok: false, reason: '没找到这个来源值' };
    const hit = list[i];

    // 全失效会让字段"没有可用值" → 缓存值不该被清空（调用契约），
    // 所以先算一遍：如果失效后没有别的可用值，就不允许失效最后一个。
    const remaining = list.filter(x => x !== hit && !x.invalid);
    if (invalid && remaining.length === 0) {
        return { ok: false, reason: '这是这个字段唯一的值，不能失效（否则字段会变空）' };
    }

    hit.invalid = !!invalid;
    return { ok: true, reprojected: reprojectField(draft, field) };
}

/**
 * 「这条值**真删**掉」
 *
 * 与 `markValueInvalid`（标不用）的区别：
 *   - `不用`：值**留着**、标记不采用 —— 留痕（"谁说过什么"），可恢复；
 *   - `真删`：从来源层**移除**这条值。用在"这条根本不该在"的场合：
 *     手改打错的那条、爬虫给错的、早已失效只想清干净的。
 *
 * ★ **可以删到一条不剩**：删掉最后一条来源值 ⇒
 *   字段的缓存值**回到该字段的默认值**（`getNodeDefaults(type)[field]`），
 *   即"这条值没了 = 这个字段回到没有来源的状态"。
 *   ⚠️ 这与 `markValueInvalid`（标不用）的硬规则**故意不同**：标不用是"这条别用、去用别的"，
 *   唯一一条时它没有意义，所以拦；而**真删是要把值抹掉**，拦着只会让人清不掉
 *   （实测：唯一一条是手改值时，面板上一个按钮都没有）。
 *   `applyProjection` 那边"没有可用值就不动缓存字段"的契约**不变** —— 自动重投影仍然
 *   绝不会清空字段，只有这一支显式删除会。
 *
 * @param {Object} draft
 * @param {string} nodeId
 * @param {string} field
 * @param {string} src
 * @param {*} value
 * @param {string} [account] - 这条值属于哪个账户（手改值按账户各一条，必须精确配对）
 * @returns {{ ok:boolean, reason?:string, removed?:Object, reprojected?:Object, cleared?:boolean }}
 */
export function removeSourceValue(draft, nodeId, field, src, value, account = undefined) {
    const node = draft && draft.nodes ? draft.nodes[nodeId] : null;
    if (!node) return { ok: false, reason: '节点不存在' };
    const list = (node.values && node.values[field]) || [];
    const i = findSourceValueIndex(list, src, value, account);
    if (i < 0) return { ok: false, reason: '没找到这个来源值' };

    const hit = list[i];
    list.splice(i, 1);

    return { ok: true, removed: { v: hit.v, src: hit.src }, ...settleFieldAfterRemoval(draft, node, field) };
}

/**
 * **撤掉某字段的一条来源值之后该怎么收尾**（`removeSourceValue` 与"手改清空"共用**这一份**）。
 *
 * 两条路：
 *   · 还有可用来源值 ⇒ **重投影**（把缓存 `node[field]` 落回投影选中的那条）；
 *   · 一条可用值都不剩 ⇒ **回该字段的默认值**（`getNodeDefaults(type)[field]`）。
 *
 * 为什么必须显式收尾（`applyProjection` 的契约是"没有可用值就不动缓存字段"）：
 *   不收尾的话缓存就停在**刚被撤掉的那个值**上 —— 而读有两套：**③ 性质待补**读缓存
 *   （`natureStatusOf(node)` 读 `node[field]`）、**字段表 / 编辑框 / 导入**读投影
 *   ⇒ 同一格两个答案。实测（用户 2026-10-08）：把手改的赛季清掉（想让脚本那份说话），
 *   ③ 里从此写着"缺：赛季"，而字段表里明明有 2023；重新导入也治不好（那条记录会被
 *   指纹判成"没变化 ⇒ 跳过"，缓存永远停在空）。所以这里和 `removeSourceValue` 同源。
 *
 * @returns {{cleared?:boolean, reprojected?:Object}} 走了哪一支
 */
export function settleFieldAfterRemoval(draft, node, field) {
    if (!node) return {};
    const list = (node.values && node.values[field]) || [];
    const usableLeft = list.some(x => x && !x.invalid);
    if (!usableLeft) {
        if (node.values && list.length === 0) delete node.values[field];
        const def = getNodeDefaults(node.type || '')[field];
        if (Array.isArray(def)) node[field] = def.slice();
        else if (def && typeof def === 'object') node[field] = { ...def };
        else node[field] = def === undefined ? '' : def;
        return { cleared: true };
    }
    return { reprojected: reprojectField(draft, field) };
}

/**
 * 按投影重算**某个字段**的缓存值（只处理有来源值的节点）。
 *
 * ⚠️ 与 `applyProjection` 的契约一致：没有可用来源值的节点**不动**缓存字段。
 *
 * @returns {{ nodes:number, changed:number }} 处理了几个节点 / 改了几个值
 */
export function reprojectField(draft, field) {
    const out = { nodes: 0, changed: 0 };
    if (!draft || !draft.nodes) return out;
    // 投影按"在看的账户"过滤。没有 `viewingAccountId` → undefined
    // → 不过滤。
    // ⚠️ 必须**同时**带上账户表：否则"停用/已删账户的值不参与投影"失效 ——
    //    重算会把一个停用账户的值写回缓存（树上看不到、缓存里却是它）。
    const opts = { viewingAccount: draft.viewingAccountId, accounts: draft.accounts, settings: draft.settings };
    for (const id of Object.keys(draft.nodes)) {
        const node = draft.nodes[id];
        if (!node || !node.values || !Array.isArray(node.values[field]) || !node.values[field].length) continue;
        out.nodes++;
        const r = applyProjection(node, field, draft.trust, opts);
        if (r.changed) out.changed++;
    }
    return out;
}
