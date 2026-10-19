// ================================================================
// 标题/元数据构建（view/builders.js）
// 职责：生成各类型节点的标题和元数据 HTML
// 依赖：view/stats.js, view/helpers.js, core/query/nodes.js,
//       A_constants.js, utils/A_helpers.js
// ================================================================
import { STATUS2_COLORS, RESULT_COLORS, RESULT_COLOR_UNKNOWN, TAG_COLORS, XCPC_COLORS, DEFAULT_BOX_COUNT } from '../A_constants.js';
import { difficultyValueOf } from '../core/fieldRegistry.js';
import { escapeHtml, getCfColor, getXcpcRange, displayTime } from '../utils/A_helpers.js';
// 外链属性（不带 Referer，见 `utils/html.js` 那段注释：board.xcpcio.com 会按 Referer 回 403）
import { EXTERNAL_LINK_ATTRS } from '../utils/html.js';
import { getNode } from '../core/query/nodes.js';
import { viewValue, viewDerived, viewDerivedDisplay, viewBorrowedTitle } from './scope.js';
import { buildLinkBlock } from './linkChips.js';
import {
    getCProblemSummary,
    getCStatusDistribution,
    getWSMatchSummary,
    getWSProblemSummary,
    cProblemNodes
} from './stats.js';
import { getSubmitSummary, getNodePerPage, buildTimeTags, getChildNodes } from './helpers.js';
// 合成节点的**成员名单**（只读引用，见 `buildSynthMembersHtml`）
// 一次建表（`synthMembersTable` + 一槽记忆化）—— 见 `synthTableOf`
import { isSynthesis, synthKeyOf, synthMembersTable } from '../core/ops/synth.js';
// R 行的「提交者」：**归认到的账户**的显示名（唯一一份在 `accountLabel`）
import { accountLabel } from '../core/ops/account.js';
// 「这条值属于哪个账户」的归一化**唯一一份**在 `accountOfEntry`（别自己 `String(e.account)`）
import { accountOfEntry } from '../core/fieldValue.js';

/** 悬停说明属性（值不属于当前查看范围时才有内容） */
function borrowedAttr(state, node, field) {
    const t = viewBorrowedTitle(state, node, field);
    return t ? ` title="${escapeHtml(t)}"` : '';
}

// ----- 合成节点的成员名单 -----
/** 一行里最多列几个名字（其余折成省略号） */
const SYNTH_MEMBER_LIMIT = 8;
/** 单个名字最多显示多少字符（防一个超长标题把整行撑爆） */
const SYNTH_MEMBER_NAME_MAX = 24;

/**
 * 成员表的**一槽记忆化**（按 `state.nodes` / `state.childOrder` 的**对象引用**失效）。
 *
 * 为什么是"一槽引用记忆化"而不是"渲染一趟里建一次表"：
 *   `buildSynthMembersHtml` 是被 `build*NodeMeta` **逐个节点**调用的（没有"渲染一趟"
 *   这个上下文对象可传）—— 要"一趟建一次"就得把表一路穿到 `view/renderers.js` 的
 *   每个调用点上，改的是公共 API；而引用记忆化把这件事收在本模块内部，调用方
 *   一个字都不用改。
 *
 * 为什么引用失效是可靠的：状态是 immer 产物，任何结构写操作都会换掉 `nodes` /
 *   `childOrder` 这两个对象（数组也是新建的），于是引用一变、表必然重建；
 *   渲染本身**只读不改**（`synth-view.smoke.mjs` 已经钉住"渲染不改 childOrder/nodes"）。
 *   表里只有 **id**，成员**名字**仍然是渲染时现读的 —— 即便有人原地改了某个节点的
 *   `name` 而没换 `nodes` 引用，名单也照样是新的（只有"成员/顺序"会滞后，而那两种
 *   改动必然换对象）。`core/groupCompute.js` 的 `groupComputed` 用的是同一套口径。
 *
 * 只留一槽 ⇒ 最多多留一份上一状态的引用，不会被当成缓存泄漏。
 * ⚠️ 键里带 `childOrder` 对象引用：**就地换掉某个父的子数组**（不换 `childOrder`）
 *    骗不过它 —— 那是测试才有的写法（`src/test/groupValue.test.js` 的"成员顺序起作用"）。
 */
let synthTableMemo = { nodes: null, childOrder: null, table: null };

/** 取当前 state 的成员表（同一份引用下只建一次） */
function synthTableOf(state) {
    const nodes = (state && state.nodes) || null;
    const childOrder = (state && state.childOrder) || null;
    if (synthTableMemo.table && synthTableMemo.nodes === nodes
        && synthTableMemo.childOrder === childOrder) {
        return synthTableMemo.table;
    }
    const table = synthMembersTable(state);
    synthTableMemo = { nodes, childOrder, table };
    return table;
}

/**
 * 合成节点的「成员」一行（列的是**指针指向的成员**，不是子节点）。
 *
 * 为什么要单独一行（而不是把成员画成子节点）：成员关系是**指针**
 * （`ownerSynth` → `synthKey`），成员仍然挂在它**自己实际所在的位置**。
 * 把它们塞进 `childOrder` / 折叠树 / 拖拽重排那几套机制，就得同时改
 * 三处核心遍历（还可能撞上"一个节点两个父亲"）；而"只读地列一下名单"
 * 信息量已经够了 —— 这是**刻意**的最小实现（视图的最小实现）。
 *
 * 三条硬约束：
 *   ① **不可折叠**：本行只是灰字，不是 `.node-children` 里的节点行，
 *      展开/折叠只作用真实子节点（`getChildNodes` → `state.childOrder`）；
 *   ② **不可重挂**：不带 `data-id`、不画 ⬆⬇，拖拽/重排认不出它；
 *   ③ **不计入计数**：它不进 `state.childOrder`，`countEligibleSubtree` /
 *      徽标 / 页数一律看不见它。
 *
 * 顺序用**一次建好的成员表**（`synthMembersTable`，见 `synthTableOf`）——
 * 它按**树序**预序塞成员，与单点查询 `synthMembers(state, key)` **逐元素相同**，
 * 但"几百个合成节点各调一次"那个 O(#合成 × N) 没有了（XCPC 那块正是几百个）。
 *
 * @param {Object} state
 * @param {Object} node
 * @returns {string} 非合成节点 / 没有成员时为**空串**（不占版面）
 */
export function buildSynthMembersHtml(state, node) {
    if (!isSynthesis(node)) return '';
    const nodes = (state && state.nodes) || {};
    const key = synthKeyOf(node);                       // 与 isSynthesis 同口径（会 trim）
    const ids = synthTableOf(state).get(key) || [];
    if (ids.length === 0) return '';
    const shown = ids.slice(0, SYNTH_MEMBER_LIMIT).map(id => {
        const member = nodes[id];
        const raw = member ? (viewValue(state, member, 'name') || id) : id;
        const name = String(raw);
        return name.length > SYNTH_MEMBER_NAME_MAX ? name.slice(0, SYNTH_MEMBER_NAME_MAX) + '…' : name;
    });
    const more = ids.length > SYNTH_MEMBER_LIMIT ? '…' : '';
    const text = `成员：${shown.join('、')}${more}（共 ${ids.length}）`;
    return `<div class="synth-members" data-synth-key="${escapeHtml(node.synthKey)}"`
        + ' title="成员是引用：不折叠、不重挂、不计入子节点数（要改成员去判重整理页）">'
        + `<span style="font-size:12px;color:#94a3b8;word-break:break-all;">${escapeHtml(text)}</span>`
        + '</div>';
}

// ----- P 节点 -----
export function buildPNodeTitle(state, node) {
    // 值级字段一律走视图读取器（按"在查看"的范围现算，不动数据）
    const problemId = viewValue(state, node, 'problemId') || '';
    // 这里显示**数值难度字段组的当前口径**：
    //   · 显示哪一个：`pickInGroup`（偏好 `trust.groupPrefer` > 注册表成员顺序）；
    //   · **没有注册表（老包）⇒ 还是 `cfDifficulty`**；
    //   · 配色**先沿用 CF 那套**（各体系一套档位/颜色暂不做）。
    // 显示列那一份优先（去重 ⇒ 组那份），取不到就自己那份 —— 与 `status2` 的读法是同一条
    // （`status2` 是派生列、`viewDerived` 自己会退回 `derivedOf`；`cfDifficulty`/`ratio` 这类是
    //  **来源层字段**，`viewDerived` 对它们给 `undefined`，所以要显式退回 `viewValue`）
    const shown = difficultyValueOf(state, node,
        { shownValue: (n, f) => viewDerivedDisplay(state, n, f) ?? viewValue(state, n, f) });
    const diffField = shown.field;
    const cfDiff = shown.value;
    const cfColor = getCfColor(cfDiff);
    let cfDisplay = '';
    if (cfDiff >= 3000) {
        const str = String(cfDiff);
        cfDisplay = `<span style="color:black;">${str[0]}</span><span style="color:${cfColor};">${str.slice(1)}</span>`;
    } else {
        cfDisplay = `<span style="color:${cfColor};">${cfDiff}</span>`;
    }
    const nameDisplay = `<span class="node-name"${borrowedAttr(state, node, 'name')}>${escapeHtml(viewValue(state, node, 'name'))}</span>`;
    const submitSummary = getSubmitSummary(state, node);
    const summaryHtml = submitSummary.text ? `<span class="submit-summary" style="font-weight:bold; color:${submitSummary.color}; margin:0 4px;">${escapeHtml(submitSummary.text)}</span>` : '';
    const children = getChildNodes(state, node);
    let totalSubmits = 0;
    for (const c of children) {
        if (c && c.type === 'R') totalSubmits++;
    }
    const totalHtml = totalSubmits > 0 ? `<span class="submit-total">/${totalSubmits}</span>` : '';

    let tagsHtml = '';
    const tags = viewValue(state, node, 'tags');
    if (Array.isArray(tags) && tags.length) {
        tagsHtml = tags.map(t => {
            const text = (t && typeof t === 'object') ? t.text : t;
            const color = (t && typeof t === 'object') ? t.color : '';
            const bg = TAG_COLORS[color] || '#ffffff';
            return `<span class="tag-badge" style="background-color:${bg};">${escapeHtml(text)}</span>`;
        }).join('');
    }
    let ratioHtml = '';
    const ratio = viewDerivedDisplay(state, node, 'ratio') ?? viewValue(state, node, 'ratio');
    if (ratio && ratio !== '') {
        const num = parseFloat(ratio);
        if (!isNaN(num)) {
            const ratioDisplay = num.toFixed(2) + '%';
            const diffDisplay = viewDerivedDisplay(state, node, 'xcpcDifficulty') || '-';
            const color = XCPC_COLORS[diffDisplay] || '#000000';
            ratioHtml = `<span class="ratio-badge" style="color:${color};"${borrowedAttr(state, node, 'ratio')}>${ratioDisplay}(${diffDisplay})</span>`;
        }
    }

    return `
        <div class="node-title" style="flex-direction:column; align-items:stretch; gap:2px;">
            <div style="display:flex; flex-wrap:wrap; align-items:baseline; gap:4px 8px;">
                <span class="problem-id">${escapeHtml(problemId)}</span>
                <span class="cf-difficulty" data-diff-field="${escapeHtml(diffField)}" title="数值难度（${escapeHtml(diffField)}）">${cfDisplay}</span>
                ${ratioHtml}
            </div>
            <div style="display:flex; flex-wrap:wrap; align-items:baseline; gap:4px 8px;">
                ${nameDisplay}
                ${summaryHtml}${totalHtml}
                ${tagsHtml}
            </div>
        </div>
    `;
}

export function buildPNodeMeta(state, node) {
    const link = viewValue(state, node, 'link');
    const linkHtml = link ? `<a href="${escapeHtml(link)}" ${EXTERNAL_LINK_ATTRS} class="link">🔗 链接</a>` : '';
    return `
        <div class="node-meta">
            <span class="ac-time-bold">AC时间: ${escapeHtml(viewDerivedDisplay(state, node, 'acTime'))}</span>
            <span class="last-submit-time">最新提交: ${escapeHtml(viewDerivedDisplay(state, node, 'lastSubmitTime'))}</span>
            ${linkHtml}
            ${buildTimeTags(state, node)}
        </div>
    ` + buildSynthMembersHtml(state, node);
}

// ----- R 节点 -----
export function buildRNodeTitle(state, node, parentId) {
    let submitSeq = '';
    if (parentId) {
        const parent = getNode(state, parentId);
        if (parent && parent.type === 'P') {
            const children = getChildNodes(state, parent);
            const rNodes = [];
            for (const c of children) {
                if (c && c.type === 'R') rNodes.push(c);
            }
            const sorted = [...rNodes].sort((a, b) => {
                // 排序也按视图口径（否则"第几次提交"会跟显示的时间对不上）
                const ta = viewValue(state, a, 'time') || '';
                const tb = viewValue(state, b, 'time') || '';
                return String(ta).localeCompare(String(tb));
            });
            const pos = sorted.findIndex(r => r.id === node.id);
            if (pos !== -1) submitSeq = `#${pos+1}`;
        }
    }
    const status = viewValue(state, node, 'status') || '-';
    // 枚举之外的值（`normalize_status` 自造的缩写）用**淡灰**，别拿一个"看着像状态色"的颜色糊过去
    const color = RESULT_COLORS[status] || RESULT_COLOR_UNKNOWN;
    const statusDisplay = `<span style="font-weight:bold;color:${color};"${borrowedAttr(state, node, 'status')}>${escapeHtml(status)}</span>`;
    // 内部存 14 位（带秒），**显示也带秒**（同一分钟多条要看出先后）
    const time = displayTime(viewValue(state, node, 'time'));
    return `
        <div class="node-title">
            <span class="node-name" style="font-weight:400;">${escapeHtml(time)}  ${statusDisplay} ${submitSeq ? '<span style="font-size:11px;color:#6b7280;margin-left:4px;">('+submitSeq+')</span>' : ''}</span>
        </div>
    `;
}

/**
 * 这条提交（R）**被归认到哪个账户**。
 *
 * ⚠️ **仓里没有"整节点的账户"读口**：账户登记的粒度是**每一条来源值**
 * （`node.values[字段][i].account`，写入口见 `core/fieldValue.js` 的 `addSourceValue`
 * / `recordIncoming`），现有读口 `readField` / `readFieldInfo` 给的是**值**、
 * `explainField` 的 `stored[].account` 要逐字段问一遍，都不是"这个节点是谁的"。
 * ⚠️ 而且它**不是节点字段**：元列 `账户线索`（`core/accounts.js` 的 `ACCOUNT_CLUE_KEY`）
 * 只是**线索**（抓取时带的名字），归认结果才写进 `值.account` —— 所以要显示的是
 * **后者**（用户 2026-10-12："提交者 = 这条提交被归认到的账户，不是原始线索名"）。
 *
 * 所以这里取**最小实现**：按 `Object.keys(node.values)` 的既有顺序扫各字段的值，
 * 取**第一条有非空 `account` 的**。判"非空"用现成的 `accountOfEntry`（它是这条归一化的
 * **唯一一份**：空/缺省 = 客观那条）。
 *
 * ⚠️ 顺序是**值的插入序**，不是"最新的那条"：一条 R 上若同时挂着两个账户的值
 * （多平台合并、或各账户各手改了一次），显示的是**先记进来的那个**。
 * 这一刻意如此（"客观值就不画"那条要求也是同一姿态：不猜）。
 *
 * @returns {string} 账户 id；空串 = 未归认 / 客观（调用方据此**不画**那一段）
 */
function accountIdOfSubmission(node) {
    const bag = (node && node.values) || null;
    if (!bag || typeof bag !== 'object') return '';
    for (const field of Object.keys(bag)) {
        const list = bag[field];
        if (!Array.isArray(list)) continue;
        for (const entry of list) {
            const account = accountOfEntry(entry);
            if (account) return account;
        }
    }
    return '';
}

export function buildRNodeMeta(state, node) {
    const link = viewValue(state, node, 'link');
    const linkHtml = link ? `<a href="${escapeHtml(link)}" ${EXTERNAL_LINK_ATTRS} class="link">🔗 链接</a>` : '';
    // 提交性质（赛时 / VP / 补题）。**空就不显示** —— 空表示"判不出来"，
    // 摆一个"未知"标签只是噪音。
    const kind = String(viewValue(state, node, 'submitKind') || '').trim();
    const kindHtml = kind
        ? `<span class="submit-kind"${borrowedAttr(state, node, 'submitKind')}> ${escapeHtml(kind)}</span>`
        : '';
    // 提交者（**归认到的账户**）。**没有归认到账户时不画那一段** ——
    // 与上面 `submitKind` 空就不画同一姿态：摆一个"（无）"只是噪音。
    // 显示名走 `core/ops/account.js` 的 `accountLabel`（同名账户自动带 id 后 4 位）——
    // **别自己读 `state.accounts[id].name`、别自己拼标签**。
    const submitterId = accountIdOfSubmission(node);
    const submitterHtml = submitterId
        ? '<span class="submitter" title="这条提交归认到的账户（账户线索的归认结果，不是抓取时的原始线索名）">'
            + `提交者: ${escapeHtml(accountLabel(state, submitterId))}</span>`
        : '';
    return `
        <div class="node-meta">
            <span>提交: ${escapeHtml(displayTime(viewValue(state, node, 'time')))}</span>
            ${submitterHtml}
            <span>结果: ${escapeHtml(viewValue(state, node, 'status'))}</span>
            ${kindHtml}
            ${linkHtml}
${buildTimeTags(state, node)}
        </div>
    ` + buildSynthMembersHtml(state, node);
}

// ----- C 节点 -----
export function buildCNodeTitle(state, node) {
    let extraStats = `<span class="stats-summary">${getCProblemSummary(state, node)}</span>`;
    const distHtml = `<span class="status-distribution" title="${escapeHtml(getCStatusDistribution(state, node))}">📊分布</span>`;
    extraStats += ` ${distHtml}`;

    const children = getChildNodes(state, node);
    // 普通 C：直接子节点里的 P（与原来逐字相同）。
    // **合成节点（组头）**：成员是**指针**不是子节点 ⇒ 题目要从成员那边取
    // （`cProblemNodes`：并集 + 按"题的组标识"去重 + 按题号排序）—— 不补这一步组头
    // 一个方框都没有，而它的成员有 13 个（用户 2026-10-06："原料节点有题而合成节点
    // 没有题是不合理的"）。
    const childPs = isSynthesis(node)
        ? cProblemNodes(state, node)
        : children.filter(c => c && c.type === 'P');

    if (childPs.length > 0) {
        let boxLimit = state.settings.display.boxCount || DEFAULT_BOX_COUNT;
        if (boxLimit < 1) boxLimit = 1;
        if (boxLimit > 200) boxLimit = 200;
        const topPs = childPs.slice(0, boxLimit);
        const boxDisplayMode = state.settings.display.boxDisplayMode || 'cf';
        const boxesHtml = `<span class="boxes-scroll">${(
            topPs.map(p => {
                // 派生字段（status2 / xcpcDifficulty）按登录账户口径（缓存）
                // ★「合并显示」：颜色跟着**计数模式**走（去重 ⇒ 同组的状态合并成一份，
                //   一道题在别的平台 AC 了，这里的方框也亮）。难度不在 `GROUP_FIELDS` 里 ⇒ 仍是自己那份。
                const color = STATUS2_COLORS[viewDerivedDisplay(state, p, 'status2')] || '#ffffff';
                const id = viewValue(state, p, 'problemId') || '?';
                // 小方框里的数字 = **同一个口径**（显示列那一份优先，取不到就自己那份）
                const cf = difficultyValueOf(state, p,
                    { shownValue: (n, f) => viewDerivedDisplay(state, n, f) ?? viewValue(state, n, f) }).value;
                const xcpc = viewDerivedDisplay(state, p, 'xcpcDifficulty') || '-';
                let shapeHtml = '';
                const ratioVal = viewDerivedDisplay(state, p, 'ratio') ?? viewValue(state, p, 'ratio');
                if (ratioVal && !isNaN(parseFloat(ratioVal))) {
                    const num = parseFloat(ratioVal);
                    if (num >= 0 && num <= 100) {
                        const info = getXcpcRange(ratioVal);
                        if (info) {
                            const { level, lower, upper } = info;
                            let t = 1;
                            if (isFinite(lower) && isFinite(upper) && upper > lower) {
                                t = (upper - num) / (upper - lower);
                                t = Math.max(0, Math.min(1, t));
                            }
                            let baseHeight;
                            if (level.includes('+')) {
                                baseHeight = 75;
                            } else if (level.includes('-')) {
                                baseHeight = 25;
                            } else {
                                baseHeight = 50;
                            }
                            const heightPercent = baseHeight + 25 * t;
                            const topPercent = 100 - heightPercent;
                            const xcpcColor = XCPC_COLORS[level] || '#000000';
                            shapeHtml = `<div style="position:absolute; right:0px; top:${topPercent}%; height:${heightPercent}%; width:4px; background:${xcpcColor};"></div>`;
                        }
                    }
                }
                const offsetStyle = 'position:relative; top:-2px;';
                let bottomHtml = '';
                if (boxDisplayMode === 'cf') {
                    if (cf) {
                        if (cf >= 3000) {
                            const str = String(cf);
                            const color = getCfColor(cf);
                            bottomHtml = `<span style="color:black;">${str[0]}</span><span style="color:${color};">${str.slice(1)}</span>`;
                        } else {
                            bottomHtml = `<span style="color:${getCfColor(cf)};">${cf}</span>`;
                        }
                    }
                } else {
                    if (xcpc !== '-' && xcpc !== '') {
                        const color = XCPC_COLORS[xcpc] || '#000000';
                        bottomHtml = `<span style="color:${color};">${escapeHtml(xcpc)}</span>`;
                    }
                }
                return `<div style="display:flex; flex-direction:column; align-items:center; background:transparent; gap:1px;">
                    <div style="background-color:${color}; font-size:14px; font-weight:500; padding:0 2px; border-radius:5px; border:1px solid #ccc; text-align:center; line-height:1.4; min-width:22px; position:relative; overflow:hidden; padding-top:2px;">
                        ${shapeHtml}
                        <span style="${offsetStyle}">${escapeHtml(id)}</span>
                    </div>
                    <div style="font-size:10px; font-weight:700; text-align:center; line-height:1.2; min-height:16px;">
                        ${bottomHtml}
                    </div>
                </div>`;
            }).join('')
        )}</span>`;
        extraStats += ` ${boxesHtml}`;
    }

    return `
        <div class="node-title">
            <span class="node-name"${borrowedAttr(state, node, 'name')}>${escapeHtml(viewValue(state, node, 'name'))}</span>
            ${extraStats}
        </div>
    `;
}

/**
 * C 的链接**整块**显示（`view/linkChips.js`）—— 折叠头 `🔗 链接 (N)`，
 * 展开后按类别列出（榜单/补题/仓库/其它），每类下面列**该类全部**链接。
 * 口径：**所有类别的链接都在 `link`**（没有单独的 `boardLink`），
 * `repo` / `unknown` 非空也显示。放在 `linkChips.js` 里是因为 `builders.js`
 * 会牵进 `shell/state.js`（`immer`），留在那儿就测不到了。
 */
export function buildCNodeMeta(state, node) {
    // ★ **合成节点（组头）自己没有这两样** —— 组头不落盘 `contestTime` / `链接分类`
    //   （它们是**组值**：`core/groupValue.js` 按需聚合、一个字节都不写节点）
    //   ⇒ 组头的框上必须显示**组那份**，否则"这一组几点开赛、有哪些链接"在树上永远空着
    //   （实测："我看不到"就是这么来的：这里原来只读 `viewValue` = 节点自己那份）。
    //   ⚠️ 只有**组头**走这条：成员的自己那份非空，照旧显示自己的（与"两列值"同一姿态）。
    const synth = isSynthesis(node);
    const ownTime = viewValue(state, node, 'contestTime');
    const groupTime = (synth && !ownTime) ? viewDerived(state, node, 'contestTime', { column: 'group' }) : '';
    const contestTime = ownTime || groupTime || '';
    const groupLinks = synth ? viewDerived(state, node, '链接分类', { column: 'group' }) : null;
    const linkBlockHtml = buildLinkBlock(state, node, groupLinks);
    let contestTimeHtml = '';
    if (contestTime) {
        // ⚠️ 组值**不加** `borrowedAttr`（那是"值在别的查看范围里"的说明，组值不是那回事）
        const attr = ownTime ? borrowedAttr(state, node, 'contestTime') : '';
        contestTimeHtml = `<span class="contest-time-box"${attr}> ${escapeHtml(displayTime(contestTime))}</span>`;
    }
    return `
        <div class="node-meta">
            ${linkBlockHtml}
            ${contestTimeHtml}
${buildTimeTags(state, node)}
        </div>
    ` + buildSynthMembersHtml(state, node);
}

// ----- W/S 节点 -----
export function buildWSNodeTitle(state, node) {
    const extraStats = `<span class="stats-summary">${getWSMatchSummary(state, node)} ${getWSProblemSummary(state, node)}</span>`;
    return `
        <div class="node-title">
            <span class="node-name"${borrowedAttr(state, node, 'name')}>${escapeHtml(viewValue(state, node, 'name'))}</span>
            ${extraStats}
        </div>
    `;
}

export function buildWSNodeMeta(state, node) {
    // 所有节点的链接（**就是所有链接**）都进『按类别分组』的链接块。
    // 若只有 C 走 `buildLinkBlock`、W/S 另画一个不带类别的 `🔗 链接` —— 同一份
    // 来源层数据两种画法，链接一多就看不出来哪条是榜单、哪条是仓库。
    // 所以 W/S 与 C 同一套：折叠头 `🔗 链接 (N)` + 展开后按类别分组。
    const linkBlockHtml = buildLinkBlock(state, node);
    return `
        <div class="node-meta">
            ${linkBlockHtml}
${buildTimeTags(state, node)}
        </div>
    `;
}

// ----- 分页 UI 构建 -----
export function buildPaginationHtml(state, node, pageCount, currentPage, totalChildren) {
    const start = (currentPage - 1) * getNodePerPage(state.settings) + 1;
    const end = Math.min(currentPage * getNodePerPage(state.settings), totalChildren);
    const rangeText = `${start}~${end}`;
    return `
        <div class="pagination" style="display:flex; align-items:center; gap:8px; margin:4px 0 6px 26px; font-size:13px; color:#475569;">
            <button class="pagination-btn pagination-prev" data-id="${node.id}" ${currentPage <= 1 ? 'disabled' : ''} style="padding:2px 8px; border:1px solid #d1d5db; border-radius:4px; background:transparent; cursor:pointer; ${currentPage <= 1 ? 'opacity:0.3; cursor:not-allowed;' : ''}">◀</button>
            <span>${currentPage} / ${pageCount}</span>
            <button class="pagination-btn pagination-next" data-id="${node.id}" ${currentPage >= pageCount ? 'disabled' : ''} style="padding:2px 8px; border:1px solid #d1d5db; border-radius:4px; background:transparent; cursor:pointer; ${currentPage >= pageCount ? 'opacity:0.3; cursor:not-allowed;' : ''}">▶</button>
            <span style="color:#94a3b8; font-size:12px;">(${rangeText} / ${totalChildren})</span>
        </div>
    `;
}