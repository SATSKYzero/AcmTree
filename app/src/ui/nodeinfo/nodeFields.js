// ================================================================
// 节点信息大界面：**完整字段表**（ui/nodeinfo/nodeFields.js）
//
// 目的：把 `core/trust.js` 投影**丢掉的东西**摊开 —— 每个字段的**每个来源原值**
// （含被标"不用"的、别的账户的、各是哪个链接类别），而不是树上那个选出来的单值。
//
// 职责边界：本模块只生成 HTML 字符串，不认识 AppState 之外的东西，也不碰 DOM。
// 来源行**复用**编辑弹窗那份 `buildSourcePanelHtml()`：同一套 ✅/⛔ 标记与动作按钮，
// 于是"设为首选 / 标不用 / 恢复"在这里点得动，不必写第二套实现。
//
// ⚠️ 那些动作按钮的点击由 `ui/G_modal/sourceActions.js` 的**文档级委托**接住，
//    所以调用方要确保那个模块已被 import（见 nodeInfoView.js）。
// ================================================================
// ⚠️ `MANUAL_SRC` / `accountOfEntry` 都从**这个纯模块**取（它不拖 `immer`）——
//    **别** import `core/ops/node.js` 或自己写字面量：本文件有纯 Node 单测（`src/test/nodeFields.test.js`）。
import { explainField, MANUAL_SRC, accountOfEntry } from '../../core/fieldValue.js';
import {
    elementsOfType,
    isElement,
    natureOf,
    formatFieldValue,
    ELEMENT_NATURE
} from '../../core/model/elements.js';
import { buildSourcePanelHtml } from '../G_modal/sourcePanel.js';
import { escapeHtml } from '../../utils/html.js';
// 聚合字段的「组那份」（**只进本表**）。
// 值取 `viewDerived(..., { column: 'group' })`（两列值的读取入口，见 `view/scope.js`）；
// 有没有这一列：`GROUP_FIELDS`（status1/status2）由 `hasGroupValue` 判（物化那份，
// `core/groupCompute.js` 就是给渲染层用的）；**有聚合器但没物化的容器字段**
// （C 的 `statusComplete1`/`statusComplete2`）由 `groupValueOnDemand` 判并**按需**取值
// —— 组头自己没有子树，"自己那份"恒为 0，没有这一行就会显示成"这场没动"。
import { scopeOpts, viewDerived, viewValue } from '../../view/scope.js';
import { makeParentResolver } from '../../core/fieldRegistry.js';
import { hasGroupValue, GROUP_FIELDS } from '../../core/groupCompute.js';
import { hasSynthesisNodes, hasGroupAgg, groupAggFields } from '../../core/groupValue.js';
import { LINK_KIND_ORDER, linkKindLabel } from '../../core/linkKinds.js';

/** 性质 → 中文小标签（只在表里做提示用，不是新的"字段分类真源"） */
const NATURE_LABEL = {
    [ELEMENT_NATURE.DERIVED]: '派生',
    [ELEMENT_NATURE.STRUCTURAL]: '结构',
    [ELEMENT_NATURE.IDENTITY]: '身份',
    [ELEMENT_NATURE.NOTE]: '笔记',
    [ELEMENT_NATURE.EXISTENCE]: '存在性',
    [ELEMENT_NATURE.TAG_LIST]: '列表'
};

/**
 * 该节点上要摊开的字段名。
 *
 * = 元素表里属于这个类型的字段 ∪ `node.values` 里出现过的字段。
 * 后一半不能省：**插件自有字段**（如 `ownerSynth`）不在元素表里，
 * 但它们**同样有来源层**，观察时正是要看的东西。
 *
 * `values` 自己不是字段，是来源层的容器，排除（不排会打出一行 `[object Object]`）。
 *
 * @param {Object} node
 * @returns {string[]}
 */
export function fieldsOf(node) {
    const out = [];
    const seen = new Set(['values']);
    for (const f of elementsOfType(node.type)) {
        if (seen.has(f)) continue;
        out.push(f);
        seen.add(f);
    }
    for (const f of Object.keys(node.values || {})) {
        if (seen.has(f)) continue;
        out.push(f);
        seen.add(f);
    }
    return out;
}

/** 值 → 人看得懂的短文本（列表型字段交给 formatFieldValue） */
function valueText(field, value) {
    if (value === undefined || value === null || value === '') return '—';
    // `链接分类` 是元列（不在元素表里）：摊成「🏆 榜单 https://…、…」——
    // `JSON.stringify` 出来的那串没法看。类别标签走唯一那份词表（`core/linkKinds.js`）。
    if (field === '链接分类' && typeof value === 'object' && !Array.isArray(value)) {
        const parts = [];
        for (const kind of LINK_KIND_ORDER.concat(Object.keys(value).filter(k => !LINK_KIND_ORDER.includes(k)))) {
            const list = Array.isArray(value[kind]) ? value[kind] : [];
            if (!list.length) continue;
            parts.push(`${linkKindLabel(kind, '❔ 其它')} ${list.map(x => String((x && x.v) || '')).join('、')}`);
        }
        return parts.join('　') || '—';
    }
    if (isElement(field)) return formatFieldValue(field, value) || '—';
    if (Array.isArray(value)) return value.map(v => String(v)).join('、') || '—';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
}

/**
 * 「组那份」行 —— **只读展示**，挂在同名「自己那份」行的**后面**。
 *
 * 为什么只进这张表：组值是**派生**（合成节点 + 成员聚合而来），
 * 树上/节点摘要再多一列会把浏览视图挤乱；完整字段表本来就是"把投影丢掉的东西摊开"的地方，
 * 两列并排最容易对照。
 *
 * ⚠️ 三条不许越线：
 *   ① 不写库、不写来源层、不进历史 —— 本行**没有** `node.values` 来源，也不发 `src-act`
 *      动作按钮（那张表里的 ✅/⛔ 按钮只在"自己那份"行上）；
 *   ② 值一律走 `viewDerived(..., { column: 'group' })`（**别直接读节点字段**：
 *      组值从不落到节点上，读不到）；
 *   ③ 有**聚合器**的字段都加行：`status1` / `status2`（物化那份）与 C 的
 *      `statusComplete1` / `statusComplete2`（按需聚合，`groupValueOnDemand`）——
 *      其余字段（难度 / `acTime` …）没有聚合器 ⇒ 不加行（两列本来就同值）。
 */
function groupColumnRow(field, value) {
    return '<div class="nif-row nif-row-group" style="display:flex;gap:10px;padding:6px 0;border-top:1px solid #f1f5f9;background:#f8fafc;">'
        + '<div class="nif-key" style="flex:0 0 130px;font-family:ui-monospace,Consolas,monospace;font-size:12px;color:#334155;word-break:break-all;">'
        + '组那份 · ' + escapeHtml(field)
        + '<span style="font-size:11px;color:#94a3b8;border:1px solid #e2e8f0;border-radius:4px;padding:0 4px;margin-left:6px;">聚合</span>'
        + '</div>'
        + '<div class="nif-val" style="flex:0 0 220px;font-size:13px;color:#0f172a;word-break:break-all;">'
        + escapeHtml(valueText(field, value))
        + '</div>'
        + '<div class="nif-src" style="flex:1;min-width:0;font-size:11px;color:#94a3b8;">'
        + '由所属合成节点与其成员聚合而来（派生值：不写库、不进历史，没有来源层条目）'
        + '</div>'
        + '</div>';
}

/**
 * 生成整张「完整字段表」的 HTML。
 *
 * @param {Object} node
 * @param {Object} state - AppState（要 `trust` / `accounts` / `viewingAccountId`）
 * @returns {string}
 */
export function renderNodeFieldsHtml(node, state) {
    if (!node) return '';
    const trust = state ? state.trust : null;
    const opts = {
        accounts: state ? state.accounts : undefined,
        viewingAccount: state ? state.viewingAccountId : undefined,
        // ★ 范围口径（要不要带上**直接子账户**）也在这里传（`resolveScope` 从 `opts.settings` 读它）——
        //   少了它，📋 完整字段表会与树上的口径分叉（`v9.1.23`）
        settings: state ? state.settings : undefined,
        // 「本账户」= 我以谁的名义在操作 ⇒ 只有本账户的手改值才给「真删」
        currentAccount: state ? state.currentAccountId : undefined,
        // **应有 / 已有**那一行（随包发布的注册表；没导入过带注册表的包就没有这一行）
        //   · shownValue = 界面上显示的那个值（投影值）—— 「已有」必须问它
        //   · parentOf = 按 extKey 找父（`when.parentKind` 用；`state.nodes` 是 id→节点，不能直接传）
        registry: state ? state.fieldRegistry : undefined,
        shownValue: (n, f) => viewValue(state, n, f),
        parentOf: makeParentResolver(state)
    };

    const fields = fieldsOf(node);
    // 「组那份」要不要出：**没有合成节点 ⇒ 一行都不出**。
    // 这里刻意选「有合成节点才出」而不是「与"自己那份"相同就不出」：
    //   · 前者是**一次全表判断**（没用到合成功能的用户，字段表一个字符都不差）；
    //   · 后者会让同一行随数值时隐时现，而这张表的职责恰恰是"把藏起来的东西摊开"，
    //     一行值恰好等于自己那份也是事实（单元素组），时隐时现反而更难解释。
    // `hasGroupValue` 本身也要求有合成节点，两道判断不冲突（前者只是省掉逐字段的活）。
    // ⚠️ `hasSynthesisNodes` 是**一趟全表扫** —— 所以它**必须**留在这里、一趟只调一次
    //    （本函数只渲染**一个**节点：调用点是 `nodeInfoView.js:49`，打开信息面板时一次）。
    //    **绝不许**把它搬进下面 `for (const field of fields)` 那个逐字段/逐行循环里，
    //    那会变成 O(字段数 × 节点数)。
    const showGroupColumn = hasSynthesisNodes(state);
    const scoped = state ? scopeOpts(state) : {};
    let groupRows = 0;
    let rows = '';
    for (const field of fields) {
        const info = explainField(node, field, trust, opts);
        // ★ **被采用的那条**是不是"客观手改"（= 所有人共用）—— 用户 2026-10-13 要求**这张表**里也看得见。
        //   判据与值级面板那处**同一个含义**（`ui/G_modal/sourcePanel.js` 的 `sharedTag`）：
        //   只看 `manual` ∧ 没有账户；榜单/脚本给的客观值**不算**（它本来就不属于谁，满屏标就没人看得见重点）。
        //   标记落在**值那一格**：这张表把来源细节摊在 `nif-src` 里（多来源时还是折叠的），
        //   值那一格是扫描整张表时唯一必看的地方。
        const adopted = (info && Array.isArray(info.stored) ? info.stored : []).find(x => x && x.selected);
        const sharedTag = (adopted && adopted.src === MANUAL_SRC && accountOfEntry(adopted) === '')
            ? '<span title="所有人共用（客观值）" style="margin-left:4px;">🌐</span>'
            : '';
        const nature = natureOf(field);
        const tag = NATURE_LABEL[nature]
            ? `<span style="font-size:11px;color:#94a3b8;border:1px solid #e2e8f0;border-radius:4px;padding:0 4px;margin-left:6px;">${NATURE_LABEL[nature]}</span>`
            : '';
        // 来源行：复用编辑弹窗那份（含 ✅/⛔ 与动作按钮）
        const srcPanel = buildSourcePanelHtml(node, field, trust, opts);
        const fromValues = Object.prototype.hasOwnProperty.call(node.values || {}, field);
        // ⚠️ **结构字段读节点自己的属性**（`extKey` / `createdAt` / `分类依据` / `id`…）：
        //    它们**没有来源层** —— 值就是节点上的那一格。一律取
        //    `explainField().value`（那是**来源层投影**）⇒ 结构字段**会一直显示空**
        //    （例如 `extKey` 明明是 `qoj`，字段表里却是空）。
        //    判据用元素表的**性质**（`ELEMENT_NATURE.STRUCTURAL`），不另列一份字段名单。
        //    ⚠️ 业务字段（FIELD 等）**照旧只读投影**：读不到就显示空 ——
        //       "退回节点缓存值"那条路不走（见 `core/fieldValue.js` 的"No 老数据"段）。
        const shown = nature === ELEMENT_NATURE.STRUCTURAL ? node[field] : (info ? info.value : '');
        rows += '<div class="nif-row" style="display:flex;gap:10px;padding:6px 0;border-top:1px solid #f1f5f9;">'
            + '<div class="nif-key" style="flex:0 0 130px;font-family:ui-monospace,Consolas,monospace;font-size:12px;color:#334155;word-break:break-all;">'
            + escapeHtml(field) + tag
            + (fromValues ? '' : '<span style="color:#cbd5e1;" title="没有来源层记录"> ·空</span>')
            + '</div>'
            + '<div class="nif-val" style="flex:0 0 220px;font-size:13px;color:#0f172a;word-break:break-all;">'
            + escapeHtml(valueText(field, shown)) + sharedTag
            + '</div>'
            + `<div class="nif-src" style="flex:1;min-width:0;">${srcPanel}</div>`
            + '</div>';
        // 紧跟在"自己那份"后面出「组那份」：
        //   · `GROUP_FIELDS`（status1/status2）→ **物化**那份（`hasGroupValue` 判，便宜）；
        //   · 有聚合器但没物化的容器字段（C 的 `statusComplete1` / `statusComplete2`）
        //     → `groupValueOnDemand` **按需聚合**（规则同一份 `AGG_BUILDERS`）。
        //   ⚠️ 组头（合成节点）自己没有子树 ⇒ "自己那份"恒为 0；这一行正是它的实话。
        if (showGroupColumn && hasGroupAgg(field)) {
            // 两条路都走**显示口径**这一处（`viewDerived(..., {column:'group'})`）：
            //   物化的 `GROUP_FIELDS` 与按需聚合的其余字段，取值器与分流规则都在它里面，
            //   这里**不再自己拼 reader**（拼错的表现是"组那份永远是空"，实测踩到过）。
            const gv = GROUP_FIELDS.includes(field) && !hasGroupValue(state, node, field, scoped)
                ? undefined
                : viewDerived(state, node, field, { column: 'group' });
            if (gv !== undefined && gv !== null) {
                rows += groupColumnRow(field, gv);
                groupRows++;
            }
        }
    }

    // ★ **有聚合器、却不在字段表里的列**（元列：`链接分类`）也要有「组那份」那一行。
    //   判据是"有没有聚合器 ∧ 是不是元素"，**不写死字段名单**（名单在
    //   `core/groupValue.js` 的 `AGG_BUILDERS`，这里只问它）：
    //     · 元素字段（`contestTime`…）在上面那个循环里已经有了"自己那份"，别再来一行；
    //     · 元列本来就没有"自己那份"那一行（它的展示在 🔗 链接块），但**"这一组的链接"
    //       正是要看的东西** —— 组值就在这里露头（值太大/空 ⇒ 不画，见下面的 `null` 判断）。
    if (showGroupColumn) {
        for (const field of groupAggFields()) {
            if (fields.includes(field) || isElement(field)) continue;
            // 取值器不在这里自己写：走**显示口径**那条路（`viewDerived(..., {column:'group'})`
            // 内部按列的种类分流：派生列 / 元列 / 普通字段）。
            const gv = viewDerived(state, node, field, { column: 'group' });
            if (gv === undefined || gv === null) continue;
            rows += groupColumnRow(field, gv);
            groupRows++;
        }
    }

    return '<div class="nodeinfo-fields">'
        + '<div style="font-size:12px;color:#64748b;font-weight:600;margin-bottom:4px;">'
        + `完整字段表（${fields.length} 个字段 · 每个来源原值都在，含被标"不用"的）`
        + (groupRows > 0
            ? `<span style="font-weight:400;color:#94a3b8;"> · 另含 ${groupRows} 行「组那份」（合成节点聚合，只读）</span>`
            : '')
        + '</div>'
        + rows
        + '</div>';
}