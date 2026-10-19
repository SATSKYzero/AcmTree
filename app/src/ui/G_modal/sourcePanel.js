// ================================================================
// 值级来源面板（ui/G_modal/sourcePanel.js）
//
// 职责：给编辑弹窗的每个字段生成一小段"这个值是谁给的 / 为什么选它"的 HTML。
//
// 依赖：core/fieldValue.js（explainField）, utils/A_helpers.js（escapeHtml）
// 依据：值级 UI
//
// 为什么先做"只读"
// ----------------
// Q2（优先级可设置）需要三个动作：设为首选来源 / 标记失效 / 以我填的为准。
// 那些要写 `state.trust`，属于"会影响结果"的操作 —— 先把**看得见**做出来，
// 确认显示的信息对，再让按钮去改配置。顺序反了的话，你没法判断按钮干了什么。
//
// 显示规则：**每个字段都出一行** —— 宁可编辑弹窗长一点，也不让用户对着空行猜。
//   * 有来源       → 一行灰字：`来源：xxx（唯一来源）`；多个来源则加可展开，
//                    列出**每个说法**与被选中的那个
//   * **没有来源值** → 一行灰字说清是哪种：派生字段 `来源：自动计算`、
//                    常规字段 `来源：默认值`（手动新建的节点就是这个）
//
// ⚠️ 版面取舍：**宁可满，不可空** —— 靠"没有出处就返回空串"省版面，
//    换来的是一堆看不懂的空行。
// ================================================================
import { explainField, MANUAL_SRC } from '../../core/fieldValue.js';
import { srcLabel } from '../../core/sourceLabel.js';
import { getFieldPrefer } from '../../core/ops/trust.js';
import { matchesPattern } from '../../core/trust.js';
import { accountLabel } from '../../core/ops/account.js';
import { formatFieldValue, shapeOf, natureOf, ELEMENT_NATURE, isEmptyFieldValue } from '../../core/model/elements.js';
// 链接类别的词汇表（唯一一份，纯模块 —— 与树上渲染共用同一套标签）
import { linkKindLabel } from '../../core/linkKinds.js';
import { fieldLevelOf } from '../../core/fieldLevel.js';
import { expectNoteHtml, groupNoteHtml } from '../../core/fieldRegistry.js';
// 从**叶子模块**直接引入 escapeHtml，而不是 utils/A_helpers.js：
// A_helpers 会把 shell/state.js（→ immer，只有浏览器 import map 能解析）牵进来，
// 那样本模块就只能冒烟测试、不能单测。这里保持只依赖纯模块。
// ⚠️ 两个名字都要（这个文件里 `escapeHtml(...)` 与 `esc(...)` 都在用）——
//    别各自抄一份实现（见 utils/html.js 的头注）。
import { escapeHtml, escapeHtml as esc } from '../../utils/html.js';

/** 按钮的 HTML（动作由 sourceActions.js 的委托监听接住） */
function actionBtn(node, field, src, value, act, label, title, account = '') {
    // ⚠️ `data-account` **必须带上**：手改值按账户各留一条，同一个 `src='manual'`
    //    在字段里可能同时有"我改的"和"队友改的" —— 不带账户，动作就会命中别人那条。
    return `<button type="button" class="src-act" data-src-act="${act}"`
        + ` data-node="${esc(node && node.id)}" data-field="${esc(field)}"`
        + ` data-src="${esc(src)}" data-value="${esc(value)}" data-account="${esc(account)}"`
        + ` title="${esc(title || label)}"`
        + ' style="font-size:11px;padding:0 6px;margin-left:6px;border:1px solid #cbd5e1;'
        + 'background:#f8fafc;border-radius:4px;cursor:pointer;color:#475569;">'
        + `${esc(label)}</button>`;
}

/**
 * 生成一个字段的来源说明块。
 *
 * @param {Object} node - 节点
 * @param {string} field - 字段名（内部名，如 'ratio'）
 * @param {Object} [trust] - 优先级配置（一般传 AppState.trust）
 * @param {Object} [opts]
 * @param {Object} [opts.accounts] - `state.accounts`（显示名字 + **隐藏已停用账户**的信息）
 * @param {string} [opts.viewingAccount] - "在查看"的账户（投影口径；别的账户的值标出来但不参与）
 * @returns {string} HTML（**总是**一行：有来源就写来源，没有就写"自动计算"/"默认值"）
 */
export function buildSourcePanelHtml(node, field, trust, opts = {}) {
    if (!node) return '';
    // **应有 / 已有**（每个字段条都要有『是否应有』『是否已有』『来源』『优先级』）——
    //   来源与优先级在下面那两行 + 级别徽标里；「应有 / 已有」由包顶层那份注册表给出。
    //   `opts.registry` = 包顶层那份 `fieldRegistry`（随包发布）；**没有就整行不显示**。
    //   ⚠️「已有」要问**界面上那个值**（投影值），所以调用方传 `shownValue`；
    //      不传才退回缓存字段 `node[field]`（那样可能和输入框里显示的不一致）。
    const expectNote = expectNoteHtml(opts.registry, node, field, {
        parentOf: opts.parentOf,
        shownValue: opts.shownValue
    });
    // **字段组**那一行（如「数值难度」= cfDifficulty + atcoderDifficulty）——
    //   组回答"这道题到底有没有数值难度 / 我现在看的是哪个口径"，成员那一行回答"这个来源给没给",
    //   两行并存（不互相替代）。其余成员在这里是**快捷切换按钮**（数值难度可能有需要
    //   快捷切换所查看系列）。
    const groupNote = groupNoteHtml(opts.registry, node, field, {
        shownValue: opts.shownValue,
        trust
    });
    const noteText = [groupNote, expectNote].filter(Boolean).join('　');
    const expectLine = noteText
        ? `<div class="src-expect" style="font-size:12px;margin:2px 0 2px;">${noteText}</div>`
        : '';
    const info = explainField(node, field, trust, opts);
    if (!info.count && !(info.stored && info.stored.length)) {
        // 没有来源值，两种（**没有老数据**：读路径不留回退兜底）：
        //   · 派生字段（`status1` / `status2` / `acTime` / `xcpcDifficulty` / `statusComplete…`）：
        //     值是**算出来的** —— 你按下过的会带 manual 来源值，走下面的正常分支；
        //   · 常规字段：值是 `createNode` 给的**默认值**，最典型的就是**手动新建的节点**
        //     （`ops/tree.js` 只给建节点时填的字段记 manual，其余全停在默认）。
        // 两种都如实说一句：那一行空着，用户会以为坏了。
        const note = natureOf(field) === ELEMENT_NATURE.DERIVED ? '来源：自动计算' : '来源：默认值';
        return expectLine
            + '<div class="src-note" style="font-size:12px;color:#cbd5e1;margin:2px 0 8px;">'
            + note + '</div>';
    }

    // 单/多来源按 **stored**（全部存下来的值）判定，不是按"可用值"：
    // 两个来源点掉一个之后仍然是"两个来源"（一个已标不用），面板不该退回单来源布局
    // ——否则用户看不到自己干了什么、也没法点回来（实测踩到）。
    const stored = info.stored || info.all || [];
    const viewing = opts.viewingAccount === undefined || opts.viewingAccount === null
        ? null : String(opts.viewingAccount);

    /**
     * 值是谁的。
     * 空 = 与任何账户无关（客观）—— 榜单算出来的 ratio 就是这种。
     * 有值时显示 `👤 名字 #后4位`（名字可以重名，后 4 位是身份）；
     * **不在查看中**的值也标出来 —— 否则用户看不懂"面板说当前用 A，字段里却是 B"。
     */
    const accountTag = (x) => {
        const id = String((x && x.account) || '');
        if (!id) return '';
        const name = opts.accounts ? accountLabel({ accounts: opts.accounts }, id) : id;
        const notViewing = viewing !== null && id !== viewing
            ? '<span style="color:#b45309;">（不在查看中）</span>' : '';
        return ` · <span style="color:#0369a1;">👤${escapeHtml(name)}</span>${notViewing}`;
    };

    /**
     * **逐字段依据级别**徽标 —— 单来源与多来源两条分支都要用，
     * 所以定义在这儿（在两条分支之前）。
     *
     * 字段来源的可信优先级设定覆盖**所有字段**：**每一格**都算得出级别 ——
     * 人改的 `M`、权威榜单 `A`、脚本抓的 `B`、派生 `C`、旧回填 `D`；nature 字段
     * 有规则 id 时以规则为准（更精确）。鼠标停上去给理由（`fieldLevelNote`）。
     *
     * ⚠️ `trust.sources[src]` 与 `state.sources[src]` 形状一致（都带 `kind`）——
     *    `core/fieldValue.js` 补来源表时两边一起写，所以这里不用再拿整个 state。
     */
    const levelTag = (x, f, n, t) => {
        const got = fieldLevelOf({ sources: (t && t.sources) || {} }, x && x.src, f, n);
        if (!got.level) return '';
        // ⚠️ 悬停提示用 **`got.note`**（`fieldLevelOf` 按"这一格凭什么"现算的那句），
        //    **不要**按级别字母去查 `LEVEL_REASON`：那套字母对 nature 字段是**规则级别**、
        //    对别的字段是**来源类别**（同一个字母两套含义），按字母反查会把"推断（D）"
        //    说成"旧数据回填"、把"无依据（E）"说成"占位 / 合成"（实测踩到）。
        return `<span title="${escapeHtml(got.note || '')}"`
            + ' style="background:#f1f5f9;border:1px solid #cbd5e1;border-radius:3px;'
            + 'padding:0 4px;margin-left:4px;color:#334155;">'
            + escapeHtml(got.level) + '</span>';
    };

    // 被隐藏的（停用账户 / 已删账户）来源值：说一句，别让用户以为值丢了
    const hiddenNote = info.hiddenInactive
        ? `<span style="color:#cbd5e1;">（另有 ${info.hiddenInactive} 条来自已停用账户，已隐藏）</span>`
        : '';

    // ---- 「真删」只给**手改值**（当且仅当）----
    // 为什么这么定：
    //   · 爬虫/榜单给的值 → **不给**。那是数据，不是我的笔迹；要屏蔽它用「不用」（可恢复），
    //     不该让人一键抹掉导入来的原始值。
    //   · **别人账户**的手改值 → 不给。各账户的手改互不干扰（各自增删改），我不该删队友的。
    //   · 本账户手改的值 → 给。这正是"撤销我自己那次手改"。
    //   · ★ **客观手改值（`account === ''`，= 「所有人共用」）也给**（2026-10-13 用户实测抓到）：
    //     它**不属于"别人"**，而且「转成所有人共用」那句提示写着"（撤销可还原）" ——
    //     不给真删的话，转完就只剩 `Ctrl+Z` 一条退路，面板上连个能按的都没有（用户原话：
    //     "手改值怎么没有「真删」"）。⚠️ 老数据里手改值没有账户键，走的也是这一支 —— 同样算我的。
    const ownAccount = (opts.currentAccount === undefined || opts.currentAccount === null)
        ? '' : String(opts.currentAccount);
    const isMyManual = x => !!x && x.src === MANUAL_SRC
        && (String(x.account || '') === '' || String(x.account || '') === ownAccount);

    // ---- 客观手改值（= "所有人共用"）的**轻标记**（用户 2026-10-13）----
    // ⚠️ **只标 `src === 'manual'` 的条目**：榜单 / 脚本给的客观值本来就不属于谁，
    //    满屏都标就没人看得见"**我填的这条**是对所有人都算的"这一件事。
    // 单来源与多来源两条分支都要标（同一个判据、同一段 HTML）。
    const sharedTag = x => (x && x.src === MANUAL_SRC && !String(x.account || ''))
        ? '<span title="所有人共用（客观值）" style="margin-left:4px;">🌐</span>'
        : '';

    // ---- 「转成所有人共用」入口（用户 2026-10-13；**破坏性**动作）----
    //   · 只对**名单里的字段**显示：名单的唯一一份在 `core/ops/node.js` 的
    //     `OBJECTIVE_PROMOTABLE_FIELDS`，由调用方经 `opts.promoteFields` 传进来
    //     —— 本模块是**纯字符串模块**（Node 单测直接 import），不能 import 那条
    //     会牵出 `immer` 的链（`core/ops/node.js` → `utils/A_helpers.js` → `shell/state.js`）。
    //   · 只有"这一格确实有**按账户**的手改"才给按钮：没有可转的，点了只会报一句
    //     （判据与 core 的 `usable` 同形：manual ∧ 有账户 ∧ 值非空）。
    //   · 具体怎么转（取哪条、清哪些）**全在 `promoteManualToObjective` 里**，这里只画按钮。
    const canPromote = (Array.isArray(opts.promoteFields) ? opts.promoteFields : []).includes(field);
    const promoteBtn = canPromote && stored.some(x => x && x.src === MANUAL_SRC
        && String(x.account || '') && !isEmptyFieldValue(field, x.v))
        ? actionBtn(node, field, MANUAL_SRC, '', 'promote', '转成所有人共用',
            '把这一格的手改写给所有人看：已经有"所有人共用"的值就不动它，否则取第一条按账户的值；'
            + '其余按账户的手改会被删掉（撤销可还原）')
        : '';

    if (stored.length <= 1) {
        const one = stored[0];
        const srcs = [...new Set(stored.map(x => x.src))].join('/');
        // 归属**每个字段都写出来**：有账户写 `👤谁`，没有就明说 `客观`。
        // 为什么单值也要写：只写"来源：xxx（唯一来源）"时，
        // 用户没法判断"这个值没有账户信息"和"这条值不属于任何账户"——
        // 而那两句是完全不同的意思。空着 = 让人猜，不行。
        const who = accountTag(one) || ' · <span style="color:#cbd5e1;">客观</span>';
        // 列表型字段（tags）额外把**值**也写出来：它没有输入框，不写就完全看不到内容
        const listValue = shapeOf(field) === 'list' && one
            ? `　值：${escapeHtml(formatFieldValue(field, one.v))}`
            : '';
        // ⚠️ 单来源也要给按钮：唯一一条是**本账户手改值**时，
        //    用户想把它删掉，而只输出一行灰字就一个按钮都没有、根本删不了。
        //      · `恢复`（这条已标不用时才有意义 —— 唯一一条被标不用只可能来自导入/历史）；
        //      · `真删`（**只给本账户手改值**；删掉最后一条 ⇒ 字段回到默认值，
        //        见 `removeSourceValue`）。`优先`/`不用` 在单来源下没有意义（唯一一条不许标不用）。
        const oneActs = (one && one.invalid
            ? actionBtn(node, field, one.src, one.v, 'restore', '恢复', '恢复采用这个来源的值', one.account)
            : '')
            + (isMyManual(one)
                ? actionBtn(node, field, one.src, one.v, 'remove', '真删',
                    '把我手改的这条值删掉（字段回到默认值；撤销可还原）', one.account)
                : '');
        return expectLine
            + `<div class="src-note" style="font-size:12px;color:#94a3b8;margin:2px 0 8px;">`
            + `来源：${escapeHtml(srcLabel(srcs))}${levelTag(one, field, node, trust)}${sharedTag(one)}${who}${listValue}（${escapeHtml(info.reason)}）${hiddenNote}${oneActs}${promoteBtn}</div>`;
    }

    const prefers = getFieldPrefer(trust, field);
    const usable = stored.filter(x => !x.invalid);
    const extra = info.invalidCount ? `（其中 ${info.invalidCount} 个已标不用）` : '';

    const rows = stored.map(x => {
        const mark = x.invalid ? '⛔' : (x.selected ? '✅' : '　');
        const when = x.at ? ` · ${escapeHtml(x.at)}` : '';
        const dim = x.invalid ? 'opacity:.55;' : '';
        // 链接的**类别**（🔗 补题 / 🏆 榜单 / 📦 仓库 / ❔ 其它）——
        // 来源面板本来就逐值列出"谁给的"，再补上"这是哪一类"，用户才能一眼分清
        // 同一场上那几条链接各是干什么的。
        const kindTag = x.linkKind
            ? `<span style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:3px;`
              + `padding:0 4px;margin-right:4px;">${escapeHtml(linkKindLabel(x.linkKind))}</span>`
            : '';
        // 失效的 → 只能"恢复"；可用的 → "优先"，且**只有在还有别的可用值时才给"不用"**
        // （唯一可用的值不许失效，那是 core/ops/trust.js 的硬规则，给了按钮也只会报错）
        //
        // `真删`：**只给本账户的手改值**（见上面 `isMyManual` 的说明）——
        //   `不用` 只是标记（值留着留痕、可恢复），`真删` 才是把这条值从来源层移除。
        const removeBtn = isMyManual(x)
            ? actionBtn(node, field, x.src, x.v, 'remove', '真删',
                '把我手改的这条值删掉（撤销可还原）', x.account)
            : '';
        const acts = x.invalid
            ? actionBtn(node, field, x.src, x.v, 'restore', '恢复', '恢复采用这个来源的值', x.account) + removeBtn
            : actionBtn(node, field, x.src, x.v, 'prefer', '优先',
                prefers.some(p => matchesPattern(x.src, p))
                    ? '已经是首选' : '以后这个字段优先用这个来源', x.account)
                + (usable.length >= 2
                    ? actionBtn(node, field, x.src, x.v, 'dump', '不用', '这个值不采用（可恢复）', x.account)
                    : '')
                + removeBtn;
    
    return `<div style="margin:2px 0;${dim}">${mark} ${kindTag}<b>${escapeHtml(formatFieldValue(field, x.v))}</b>`
            + `　← ${escapeHtml(srcLabel(x.src))}${levelTag(x, field, node, trust)}${accountTag(x)}${sharedTag(x)}${when}`
            + (x.account ? '' : '<span style="color:#cbd5e1;"> · 客观</span>')
            + (x.invalid ? '<span style="color:#b45309;">（已标不用）</span>' : '')
            + `${acts}</div>`;
    }).join('');

    const clear = prefers.length
        ? `<div style="margin-top:4px;">`
            + actionBtn(node, field, prefers[0], '', 'clear-prefer', '取消偏好',
                '恢复按来源类别/等级自动选值')
            + `</div>`
        : '';
    // 「转成所有人共用」单独一行（它改的是**这一格的归属**，不是"用哪个来源"）
    const promoteLine = promoteBtn ? `<div style="margin-top:4px;">${promoteBtn}</div>` : '';

    return expectLine
        + `<details class="src-details" style="font-size:12px;color:#64748b;margin:2px 0 8px;">`
        + `<summary style="cursor:pointer;">ⓘ ${stored.length} 个来源${extra} `
        + `（当前用 <b>${escapeHtml(srcLabel(info.src) || '（无可用值）')}</b>：${escapeHtml(info.reason)}）</summary>`
        + `<div style="padding:4px 0 0 6px;">${rows}${promoteLine}${clear}${hiddenNote ? `<div style="margin-top:2px;">${hiddenNote}</div>` : ''}</div>`
        + `</details>`;
}

/**
 * 给一批字段生成来源说明（拼成一段 HTML，插在字段行之间）。
 *
 * @param {Object} node
 * @param {Array<{key:string}>} fields
 * @param {Object} [trust]
 * @param {Object} [opts] - { only: 只给这些字段生成（缺省全部） }
 * @returns {Object} `{ 字段名: HTML }`
 */
export function buildSourcePanels(node, fields, trust, opts = {}) {
    const only = Array.isArray(opts.only) ? new Set(opts.only) : null;
    const out = {};
    for (const f of Array.isArray(fields) ? fields : []) {
        if (!f || !f.key) continue;
        if (only && !only.has(f.key)) continue;
        const html = buildSourcePanelHtml(node, f.key, trust, opts);
        if (html) out[f.key] = html;
    }
    return out;
}
