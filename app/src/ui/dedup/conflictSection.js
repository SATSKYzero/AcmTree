// ================================================================
// ⑤ 冲突 / 待办（ui/dedup/conflictSection.js）
//
// 应用实时算 + **单开一栏 ⑤**。数据全来自 `core/synthConflicts.js`
// （判据与产包侧 `scripts/synth-bind.mjs` **共用同一份**：算键在 `core/synthPlan.js`、
// 级别在 `core/natureConfidence.js`）⇒ 脚本说几处、这里就是几处；
// 但这一份**随树状态实时变** —— 人改完 `natureYear` 立刻能看到它从警报里消失。
//
// ⚠️ 这一栏**只读**（判据侧不写任何东西）：要改去 ③ 性质待补 / 节点编辑，
//    或者用环节自带的那个按钮（`action`）—— 它走的是同一个 `runWrite` 事务壳。
//
// ---- 「各环节套入统一的模板」就是这么落地 ----
// 下面 `CONFLICT_STAGES` 是**唯一的环节清单**：一栏一行声明，说清
//   `items`（有哪些条）/ `title`（标题口径）/ `tone`（语气色）/ `row`（一条长什么样）
//   / `limit`（列前几条）/ `action`（人怎么处理；**没有 = 只报不动**）
// 渲染全交给 `stageKit.js` 的 `renderStages` —— 这一栏里**不再有第二处**
// 拼标题、挑颜色、写按钮、写「…还有 M 个」的代码。
// 加一个环节 = 在这里加**一条声明**（而不是像原来那样"再抄一段 40 行的块"）。
//
// ⚠️ 顺序 = 界面顺序。改顺序就改这个数组，别去动渲染器。
// ================================================================
import { mk } from '../../utils/dom.js';
// 渲染全交给**通用模板**（`ui/kit/report.js`）—— 这一栏里**不再有第二处**
// 拼标题、挑颜色、写按钮、写「…还有 M 个」的代码。
// ⚠️ 模板是**跨页面共用**的（判重整理 / 节点自动导入 / 体检·需求 同一套）。
import { renderSections, groupHead, plain, foldSection, appendNodeLink, nodeOrText } from '../kit/report.js';
// 删减那一类环节（悬空指针 / 数据不自洽 / 旧组头）—— **与判重页的黄条共用一条声明**
import { PRUNE_STAGES } from './pruneStages.js';
// 「人确认过这一组」的**组级标记**名（唯一定义在 `core/synthPlan.js`，产包侧读同一份）
import { CONFIRM_FIELD, SPLIT_FIELD } from '../../core/synthPlan.js';
import { nodeLabel, markGoto, runWrite } from './kit.js';
// 环节自带的动作（"一键处理"）都从 core/ops 出，UI 不自己拼写操作
import { applyOwnerSynth, syncAllGroupNatures } from '../../core/ops/synth.js';
// 「➡️ 改到该键」的按钮**只有一处实现**（`pruneStages.js` 里那个）：判据（算得出 + 树上真有）
// 与清理那一栏**共用**，免得两处各写一份"能不能改"的判断。
import { retargetButton, headRenameOffer } from './pruneStages.js';
// 树上有没有那个头、现在是哪些节点 —— 都在 AppState 上（只读）
import { AppState } from '../../shell/state.js';
// 「缺同步：年份、赛季」那行要写人话（标签的真源在 core/natureFields）
import { natureFieldOf } from '../../core/natureFields.js';
// 冲突页也显示 4 nature ⇒ 复用 ③/①/② 那份小标签（点着就能改）
import { natureChips } from './naturePending.js';

/** 一行的公共骨架（这一栏的行**只有两种字号**：12px 正文 / 11px 次要） */
const L = {
    line: 'font-size:12px;color:#475569;line-height:1.9;margin-left:12px;',
    key: 'font-size:11px;color:#94a3b8;line-height:1.6;margin:0 0 2px 12px;word-break:break-all;'
};

/**
 * 一行"某值 ← 哪些节点（带 4 个 nature 小标签，可点着改）"。
 *
 * ⚠️ 它**留在这里**、没跟模板一起搬去通用区：它要 `natureChips`（判重页 ③ 那一栏的小标签），
 *    而那是判重页自己的东西 —— 通用区不该反向依赖某个页面。
 */
function valueLine(value, nodes, redraw) {
    const row = mk('div', '', 'font-size:12px;color:#334155;line-height:1.9;margin-left:12px;');
    const tag = mk('span', '', 'font-weight:600;color:#0f172a;');
    tag.textContent = `${value} ← `;
    row.appendChild(tag);
    nodes.forEach((n, i) => {
        if (i) row.appendChild(document.createTextNode('、'));
        const a = mk('span', '', 'cursor:pointer;');
        a.textContent = n.key;
        markGoto(a, n.id);
        row.appendChild(a);
        // ★ 四个 nature（分类/年份/赛季/地区）—— 与 ③ 那一栏**同一份实现**（改完就地重画）
        if (n.id && redraw) row.appendChild(natureChips(n.id, redraw));
    });
    return row;
}

/** 「点这条跳到树上」的小件（这一栏到处都是它） */
function goto(text, nodeId, extraStyle = '') {
    const a = mk('span', '', `cursor:pointer;${extraStyle}`);
    a.textContent = String(text);
    markGoto(a, nodeId);
    return a;
}

/** 组标识那一行（小节、灰）：界面跳不动时也有个抓手 */
const keyLine = (text) => mk('div', 'dedup-conflict-key', L.key, String(text));

/**
 * ③ 该换键 / ⑨ 组头待同步 的**行内**小按钮（与环节级的 `action` 不是一回事：
 * 这两处是"每一条各自一个动作"，所以留在 `row` 里）。
 */
function rowButton(label, title, onClick) {
    const btn = mk('button', 'btn', 'margin-left:8px;font-size:11px;padding:0 6px;');
    // ⚠️ `title` 是**声明给的**（可能带 Markdown 记号）⇒ 落 DOM 前过 `plain`
    btn.setAttribute('title', plain(title));
    btn.textContent = label;
    btn.addEventListener('click', onClick);
    return btn;
}

/**
 * 「现在指着 X，按现值该是 Y」那一行 —— `drift`（脚本键）与 `driftHuman`（人绑的）**共用**。
 *
 * 两边的**信息与动作完全一样**，只差"谁绑的"这一点标记 ⇒ 一行代码一条口径；
 * 按钮也**只有一份实现**（`pruneStages.js` 的 `retargetButton`：算得出 + 树上真有那个头
 * 才给按钮，否则写清下一步）。
 *
 * ⚠️ 以前这两档各写了一个「➡️ 改到该键」按钮，而脚本那一档**不检查"树上有没有那个头"**
 *    ⇒ 目标不存在时点下去当场抛"不存在"。现在两条都走同一个带守卫的按钮。
 */
function driftRow(it, human) {
    const row = mk('div', human ? 'dedup-conflict-drift-human' : 'dedup-conflict-drift', L.line);
    row.appendChild(goto(it.node, it.id));
    row.appendChild(document.createTextNode('：现在指着 '));
    const cur = mk('span', '', `color:${human ? '#b45309' : '#7c3aed'};word-break:break-all;`);
    cur.textContent = it.cur;
    row.appendChild(cur);
    row.appendChild(document.createTextNode('，按现在的分类/赛季/地区应是 '));
    const want = mk('span', '', 'color:#0f766e;word-break:break-all;');
    want.textContent = it.want;
    row.appendChild(want);
    if (human) row.appendChild(mk('span', '', 'color:#94a3b8;', '（这个键是你手绑的）'));
    // ⚠️ `retargetButton` 在"算不出 / 树上没那个头"时**返回 `null`**（它只往 `row` 里补一句
    //    说明）—— `appendChild(null)` 会当场抛（DOM 桩与真浏览器都是），所以必须判返回值。
    // ★ **目标头不存在**时那条路要让给 `headRenameOffer`：那种"按现值算出来的键，树上没有那个组"
    //   正是**人绑的键过时了**这一档里唯一能一键收掉的情形（把头搬到该键）。走 `slot` 是为了
    //   无论哪一条路写进那句说明，都插在同一个位置；`retargetButton` 无按钮时会往 `slot` 里
    //   写一句"树上没有这个组"的说明，接着要给 `headRenameOffer` 让位 ⇒ 先把它撤掉
    //   （否则那一行会同时挂着两句互相打架的说明）。
    const node = (AppState.nodes || {})[it.id];
    const slot = mk('span', '', '');
    row.appendChild(slot);
    let btn = node ? retargetButton(node, slot) : null;
    if (node && !btn) {
        // ⚠️ 用 `children.length`，**别用 `firstChild`**（冒烟测试的 DOM 桩没有那个 getter ⇒
        //    真实浏览器里能跑、桩里循环不起来）。`removeChild` 两个环境都有。
        while (slot.children.length) slot.removeChild(slot.children[0]);
        btn = headRenameOffer(node, slot);
    }
    if (btn) row.appendChild(btn);
    return row;
}

// ================================================================
// 环节清单（**唯一的**）
// ================================================================

export const CONFLICT_STAGES = [
    // ---- ① 年份冲突（**只算 M/A/B 高可信**的值之间）----
    {
        id: 'yearConflicts',
        tone: 'alarm',
        items: (c) => c.yearConflicts || [],
        title: (n) => `⚠️⚠️ 年份冲突 ${n} 处`
            + '（赛季一致、两边都是**高可信**的年份，却不一样 —— 多半某个来源填错了；'
            + '跨年总决赛 / 疫情延期是已知例外）',
        // 一条 = 一小段：组头那一行 + "每个值 ← 哪些节点"（两组：高可信、低可信）
        row: (c, ctx) => {
            const out = [];
            const h = mk('div', 'dedup-conflict-item', 'font-size:12px;color:#475569;margin:2px 0 6px;');
            const name = mk('span', '', 'font-weight:600;');
            name.textContent = `${(c.head && nodeLabel(c.head)) || c.key}（赛季 ${String(c.key).split(':')[3] || '?'}）`;
            h.appendChild(name);
            h.appendChild(mk('div', '', 'font-size:11px;color:#94a3b8;word-break:break-all;', c.key));
            out.push(h);
            for (const g of c.high) out.push(valueLine(g.value, g.nodes, ctx.redraw));
            for (const g of c.low) out.push(valueLine(`（低可信）${g.value}`, g.nodes, ctx.redraw));
            return out;
        }
    },

    // ---- ② 算不出键（国内范围内、还没归入 ⇒ **只能留给人**）----
    {
        id: 'noKey',
        tone: 'warn',
        items: (c) => c.noKey || [],
        title: (n) => `⏳ 算不出合成键 ${n} 条`
            + '（国内范围内，脚本按「分类 + 赛季 + 地区」算不出 ⇒ **只能留给人**）',
        row: (it, ctx) => {
            const row = mk('div', 'dedup-conflict-nokey', L.line);
            row.appendChild(goto(it.key, it.id));
            row.appendChild(document.createTextNode(`「${it.name}」 ⇒ `));
            const why = mk('span', '', 'color:#b45309;');
            why.textContent = plain(it.why);
            row.appendChild(why);
            // ★ 也要 4 nature（点着就能改：改完它就不再算不出）
            if (it.id && ctx.redraw) row.appendChild(natureChips(it.id, ctx.redraw));
            return row;
        }
    },

/** ③ 该换键（已绑但按现在的 nature 该是另一个键）----
    ⚠️ 这一档与「④b 人绑的键过时了」**共用同一行渲染**（`driftRow`）：
    两边的信息与动作**完全一样**（现在指着谁 / 该是哪个键 / 一键改过去），
    只差"**谁绑的**"这一点标记 —— 抄成两份迟早分叉（实测：原来那两条各写了一个
    「➡️ 改到该键」按钮，人绑那条会检查"树上有没有那个头"，脚本那条**不检查**，
    于是点下去会当场抛"不存在"。）*/
    {
        id: 'drift',
        tone: 'fix',
        items: (c) => c.drift || [],
        title: (n) => `🔀 该换键 ${n} 条`
            + '（人改过 nature 之后，先前算出的那个键就不对了；脚本**一个字不动**，只报出来）',
        row: (it) => driftRow(it, false)
    },

    // ---- ④ 组头待同步（成员的性质已经比组头新 —— 组头那几个字段是**派生量**）----
    {
        id: 'headNatureDrift',
        tone: 'sync',
        limit: 8,
        items: (c) => c.headNatureDrift || [],
        title: (n) => `🔄 组头待同步 ${n} 个`
            + '（成员的性质已经比组头新 —— 组头的年份/赛季/地区是**按成员派生**的）',
        action: {
            label: (n) => `🔄 一键对齐这 ${n} 个`,
            title: '按同一份口径（真值顶占位 → 依据级别高的赢 → 同级取最早）'
                + '把这些组头的性质对齐到成员；派生的名字一起更新，人改过的名字不动',
            run: (draft) => { syncAllGroupNatures(draft); },
            done: (n) => `已按成员对齐 ${n} 个组头`
        },
        row: (it) => {
            const row = mk('div', 'dedup-conflict-headnatured', L.line);
            row.appendChild(goto(it.name || it.key, it.id));
            row.appendChild(document.createTextNode(
                `　缺同步：${(it.fields || []).map(f => (natureFieldOf(f) || {}).label || f).join('、')}`));
            return row;
        }
    },

    // ---- ④b **人绑的键过时了**（`manual:set` + 按现值该是另一个键）----
    //   为什么单列（这是实测踩出来的坑）：`drift` 刻意**跳过人绑的**（脚本不碰人的结论），
    //   而重出包时**组头会按"人后来补全的性质"改名 / 另建一个** ⇒ 那个旧键**在包里找不到**了，
    //   可**树上一切正常**（旧头还在、成员还指着它）—— 于是 ⑤ 里"悬空指针 0、旧组头 0"，
    //   一格警报都不报，直到包里的 baseline 核对说"这几个 identity 不在包里"。
    //   这一档就是把那件事**搬到人动手之前**：改到新键（树上有就一键，没有就说清为什么）。
    {
        id: 'driftHuman',
        tone: 'warn',
        items: (c) => c.driftHuman || [],
        title: (n) => `🧷 人绑的键过时了 ${n} 条`
            + '（你当初绑的那个组头，脚本按现在的分类/赛季/地区算出来是**另一个键** —— '
            + '不改的话，下次重出包这几格手填会落空）',
        row: (it) => driftRow(it, true)
    },

    // ---- ⑤ 旧组头：**声明在 `pruneStages.js`**（它是"删减"那一类，与判重页的黄条共用一条声明）----
    //   ⚠️ 这里**不再**写一遍判据/文案/动作 —— 见下面 `...PRUNE_STAGES`。

    // ---- ⑥ 空组但**键是人写的** ⇒ 只报不动（"人刚建好、还没放成员"是常态）----
    {
        id: 'humanEmptyHeads',
        tone: 'note',
        items: (c) => c.humanEmptyHeads || [],
        title: (n) => `👤 空组（键是人写的）${n} 个 —— **只报不动**`,
        row: null                                   // 只报个数：没有"要处理的一条条"
    },

    // ---- ⑦ 注册表排除（**只记账**：这些节点本来就不该算合成键）----
    {
        id: 'noSynth',
        tone: 'note',
        items: (c) => c.noSynth || [],
        title: (n) => `⛔ 注册表排除 ${n} 条`
            + '（`acm-data/synth-registry.json` 说它们**不该算合成键** ⇒ 不算"算不出"；只记账）',
        row: (it, ctx) => {
            const row = mk('div', 'dedup-conflict-nosynth', L.line);
            row.appendChild(goto(it.key, it.id));
            row.appendChild(document.createTextNode(`「${it.name}」 ⇒ `));
            const why = mk('span', '', 'color:#64748b;');
            why.textContent = `${it.layer === 'classRules' ? '分类白名单' : '节点白名单'}：${it.match}`;
            row.appendChild(why);
            if (it.id && ctx.redraw) row.appendChild(natureChips(it.id, ctx.redraw));
            return row;
        },
        // 注册表点名、树里却没有的那些（写错 extKey，还是那场没了？）—— 与上一条同一档
        after: (box, conf) => {
            if (!(conf.noSynthMissing || []).length) return;
            const miss = mk('div', 'dedup-conflict-nosynth-missing', L.line);
            miss.textContent = plain(`⚠️ 注册表里点名、但**当前树里没有**的 ${conf.noSynthMissing.length} 条：`
                + `${conf.noSynthMissing.join('、')}（写错 extKey，还是那场没了？）`);
            box.appendChild(miss);
        }
    },

    // ---- ⑧ 疑似被拆开的组（**只记账**：同一场因"一边写了主办、一边没写"被算成两组）----
    //   口径：**不自动合、交给用户判断是否合理**（留着也是一种选择，不该逼人动）。
    {
        id: 'suspectSplits',
        tone: 'note',
        items: (c) => c.suspectSplits || [],
        title: (n) => `🔀 疑似被拆开的组 ${n} 对`
            + '（同赛季 + 同地点 + 同类型，**一边写了主办、一边没写** ⇒ 可能是同一场）',
        row: (pair) => {
            const out = [];
            const row = mk('div', 'dedup-conflict-splits', L.line + 'word-break:break-all;');
            for (const [side, g] of [['a', pair[0]], ['b', pair[1]]]) {
                if (side === 'b') row.appendChild(document.createTextNode('  ⟷  '));
                // 组名**可点**（跳到那个组头节点）：报了就得能点进去。
                row.appendChild(goto(`${g.name}（${g.org}，${g.memberCount} 条）`, g.headId,
                    'text-decoration:underline dotted;'));
            }
            out.push(row);
            out.push(keyLine(`${pair[0].key}  ／  ${pair[1].key}`));
            return out;
        },
        after: (box) => {
            const hint = mk('div', 'dedup-conflict-splits-hint',
                'font-size:12px;color:#94a3b8;line-height:1.8;margin-left:12px;');
            hint.textContent = plain('要并就在上面 ① 里把成员挪进同一个组（**脚本不会撤销人的绑定**）；'
                + '觉得本来就该是两场 ⇒ 什么都不用做。');
            box.appendChild(hint);
        }
    },

    // ---- ⑩ **没序号可区分的网络赛**（⚠️ **只记账**：这一组底下可能挤了两场）----
    //   为什么不一键处理：序号读不出来时**不猜**，而"单场无序号"本来就是常态（实测：现存的
    //   无序号网络赛组全是"同一场、多来源"）⇒ 是不是两场**只有人能判**，这一档只把线索摆出来。
    //   ⚠️ **触发口径（用户 2026-10-06）**：只有**同一渠道**给出**参数完全相同**的比赛
    //   （算到同一个键）才算"无法区分"；**不同渠道**之间对不上**完全不算异常** —— 那正是
    //   合成组要干的事。所以判据是"**同一棵树**在这个组里给了 ≥2 条"，不是"组里有几条"。
    {
        id: 'unroundedPre',
        tone: 'note',
        items: (c) => c.unroundedPre || [],
        title: (n) => `🌐 无序号网络赛：分不开 ${n} 组`
            + '（**同一个渠道**给出了两条**参数完全相同**的网络赛（分类/赛季/地区/序号都算到'
            + '同一个键）⇒ 机器分不开；**不同渠道**之间怎么不一样都不算异常）',
        row: (it) => {
            const out = [];
            const row = mk('div', 'dedup-conflict-unrounded-pre', L.line + 'word-break:break-all;');
            // 组名**可点**（跳到那个组头节点）—— 组名读不出就退回键
            row.appendChild(goto(it.name || it.key, it.headId, 'text-decoration:underline dotted;'));
            out.push(row);
            out.push(keyLine(it.key));
            for (const t of it.trees || []) {
                const line = mk('div', '', L.line + 'word-break:break-all;');
                line.appendChild(document.createTextNode(`${t.tree} 给了 ${t.nodes.length} 条：`));
                (t.nodes || []).forEach((m, i) => {
                    if (i) line.appendChild(document.createTextNode('、'));
                    line.appendChild(goto(m.extKey || m.id, m.id));
                    line.appendChild(document.createTextNode(`「${m.name}」`));
                });
                out.push(line);
            }
            return out;
        },
        after: (box) => {
            const hint = mk('div', 'dedup-conflict-unrounded-pre-hint',
                'font-size:12px;color:#94a3b8;line-height:1.8;margin-left:12px;');
            hint.textContent = plain('两条其实是同一场（那个渠道重复收录了）⇒ 删掉多出来的那条；'
                + '真的是两场 ⇒ 给**成员**补上「第几场」（赛名里写 `(I)`/`(II)` 或「第 N 场」，'
                + '来源清单里是 `preliminary-2`）它们就会各自成组。');
            box.appendChild(hint);
        }
    },

    // ---- ⑪ **题（P）找不到它的场次**（⚠️ **只记账**：那些题一条都绑不上）----
    //   为什么单列：P 层那一步是**按父标识找父**的 ⇒ 父标识读不出 / 树上没那个 C 的题
    //   **既不绑、也不报**（以前就是个 `continue`）—— "静默丢一条判据比判错更糟"。
    {
        id: 'orphanP',
        tone: 'note',
        items: (c) => c.orphanP || [],
        title: (n) => `🕳 题找不到它的场次 ${n} 条`
            + '（这些题写的父节点读不出 / 树上没有 ⇒ 它们**一条都绑不上**，也不该静默）',
        row: (it) => {
            const row = mk('div', 'dedup-conflict-orphan-p', L.line + 'word-break:break-all;');
            // ⚠️ `nodeOrText()` **自己就往 `row` 里 append**（返回空）—— 别外面再套一层
            //    `row.appendChild(...)`：那样是 `appendChild(undefined)`，**这一档一有条目就崩**
            //    （实测：真数据这一档是 0 条，冒烟与单测都盖不到这条路径）。
            nodeOrText(row, it.key, it.id);
            row.appendChild(document.createTextNode(`「${it.name}」${it.problemId ? `（${it.problemId}）` : ''} ⇒ `));
            const why = mk('span', '', 'color:#b45309;');
            why.textContent = it.why === 'no-key'
                ? '这条题连标识（extKey / 节点 id）都没有'
                : (it.why === 'no-parent'
                    ? '这条题连父节点都没写'
                    : `它写的父节点「${it.parent}」在树上找不到`);
            row.appendChild(why);
            return row;
        }
    },

    // ---- ⑫ 题目绑定（P 随 C）----
    //   形状特殊（**大类 → 场次 → 题**三层，每场一个「✓ 确认这一场」），所以整段走 `body`；
    //   但它的身份、语气、标题仍由上面的声明给（这就是模板的意义：例外只有"怎么画"一处）。
    {
        id: 'problemBind',
        tone: 'note',
        // ⚠️ `items` 要**含全部五类**（前三条"待判" + 多出一条 + 按题名对上）：`items.length`
        //    决定栏头是否按 0 条**灰化**（`ui/kit/report.js`）—— 只算前三类时，后面两类
        //    有内容、栏头却是灰的（"这里没事"，与上面那两行自相矛盾）。
        items: (c) => {
            const pb = (c.problemBind) || {};
            return (pb.nameConflicts || []).concat(pb.noName || [], pb.noProblemId || [],
                pb.sameSourceExtra || [], pb.namePaired || []);
        },
        title: (n, c) => {
            const pb = c.problemBind || {};
            // 判据没跑（`pb` 里没有 `groups`）⇒ 说清楚，别再打印 `undefined 组`
            if (pb.groups === undefined) return '📝 题目绑定（P 随 C）：判据没跑（这一轮没有结果）';
            const total = (pb.nameConflicts || []).length + (pb.noProblemId || []).length;
            const tips = (pb.noName || []).length;
            const confN = (pb.confirmedGroups || []).length;
            const pairedN = (pb.namePaired || []).length;
            const extraN = (pb.sameSourceExtra || []).length;
            return `📝 题目绑定（P 随 C）：${pb.groups} 组 / 绑上 ${pb.boundP} 条`
                + (total ? `｜⚠️ **待判 ${total} 处**` : '｜没有待判')
                + (tips ? `｜💬 提示 ${tips} 处（整组无题名：**已经按题号绑上**，显示名是兜底名）` : '')
                + (extraN ? `｜🧯 同一来源多出一条 ${extraN} 处（没绑）` : '')
                + (pairedN ? `｜🔗 按题名对上 ${pairedN} 处（已绑，可审）` : '')
                + (confN ? `｜✅ 已确认 ${confN} 组（脚本不再动它们）` : '');
        },
        body: (box, conf, ctx) => { renderProblemBind(box, conf, ctx); }
    },

    // ---- ⑬ 低可信年份差异（记账，不算警报）----
    {
        id: 'yearLow',
        tone: 'note',
        items: (c) => c.yearLow || [],
        title: (n) => `ⓘ 低可信的年份差异 ${n} 处`
            + '（`待同步` 或 **C 级（赛名里的年份）** 说的值与硬数据不同 ⇒ **不算警报**）',
        row: (c, ctx) => {
            const out = [mk('div', '', 'font-size:12px;color:#94a3b8;margin:2px 0 2px 12px;word-break:break-all;', c.key)];
            for (const g of c.high) out.push(valueLine(g.value, g.nodes, ctx.redraw));
            for (const g of c.low) out.push(valueLine(g.value, g.nodes, ctx.redraw));
            return out;
        }
    },

    // ---- ⑭ 同组内分类/地区不一致（也是"打架"，但不是年份那种硬信号）----
    {
        id: 'groupConflicts',
        tone: 'note',
        items: (c) => c.groupConflicts || [],
        title: (n) => `⚠️ 同组内 分类/地区 不一致 ${n} 处`,
        row: (c, ctx) => {
            const out = [mk('div', '', 'font-size:12px;color:#475569;margin:2px 0 2px 12px;word-break:break-all;',
                `${c.key} 的 ${({ natureClass: '分类', natureRegion: '地区' })[c.field] || c.field}`)];
            for (const g of c.values) out.push(valueLine(g.value, g.nodes, ctx.redraw));
            return out;
        }
    }
];

// ================================================================
// 分段（**这一栏的逻辑**：十几条环节平铺出来没人记得住，分成三段一眼就懂）
//
//   ① **要人判的** —— 判据算不出 / 两边打架：得你看一眼、改性质或改归属
//   ② **一键就能处理的** —— 每条都带动作（点一下就没了）：清指针 / 收空壳 / 对齐组头
//   ③ **只记账的** —— 留着也是一种选择：它**不算欠账**，不该逼人动
//
// ⚠️ 分段表**只列 id**，环节本身还是 `CONFLICT_STAGES` 里那一条条声明
//    （两处各写一遍 = 迟早分叉）。漏放会**当场抛错**，不会悄悄不显示。
// ⚠️ ② / ③ 的"删减环节"按**有没有动作**自动分（`action` 有就是②）——
//    新加一条清理环节不用回来改这里。
// ================================================================

const STAGE_BY_ID = new Map(CONFLICT_STAGES.map((st) => [st.id, st]));

function pickStages(ids) {
    return ids.map((id) => {
        const st = STAGE_BY_ID.get(id);
        if (!st) throw new Error(`⑤ 的分段表写了不存在的环节「${id}」（改过 id 就要一起改这里）`);
        return st;
    });
}

/** 有动作的清理环节（"点一下就没"）*/
const PRUNE_WITH_ACTION = PRUNE_STAGES.filter((st) => st.action);
/** 只报不动的（"得改数据"）*/
const PRUNE_REPORT_ONLY = PRUNE_STAGES.filter((st) => !st.action);

export const CONFLICT_SECTIONS = [
    {
        title: '① 要人判的',
        hint: '判据算不出 / 两边打架 —— 要你看一眼再决定',
        stages: pickStages(['yearConflicts', 'groupConflicts', 'noKey', 'drift', 'driftHuman',
            'suspectSplits', 'problemBind', 'yearLow'])
    },
    {
        title: '② 一键就能处理的',
        hint: '每条都带动作，点一下就没了（判据与判重页那条黄条同一份口径）',
        stages: [...pickStages(['headNatureDrift']), ...PRUNE_WITH_ACTION]
    },
    {
        title: '③ 只记账的',
        hint: '留着也是一种选择（或"得改数据"）—— **不算欠账**，不逼人动',
        stages: [...pickStages(['noSynth', 'humanEmptyHeads', 'unroundedPre', 'orphanP']), ...PRUNE_REPORT_ONLY]
    }
];

// 漏放 = 悄悄不显示（最难发现的一类）⇒ 这里当场拦住
{
    const placed = new Set(CONFLICT_SECTIONS.flatMap((sec) => sec.stages.map((st) => st.id)));
    const left = CONFLICT_STAGES.map((st) => st.id).filter((id) => !placed.has(id));
    if (left.length) throw new Error(`⑤ 有环节没放进任何一段（加了声明就要归段）：${left.join('、')}`);
}

// ================================================================
// 题目绑定那一段（唯一一处"形状特殊"的整段渲染）
// ================================================================

const PB_KINDS = [
    ['name', '① 题名不一致（同一题号、两个来源的题名两样）', 'warn'],
    ['noName', '② 整组都没有题名（来源没给题名 ⇒ 组名只能用兜底名 `题号（题名缺失）`；**已经按题号绑上了**）', 'note'],
    ['noPid', '③ 没有题号（这条 P 进不了任何题号组）', 'hint']
];

function renderProblemBind(box, conf, ctx) {
    const pb = conf.problemBind || {};
    // 判据没跑（`groups` 都没有）⇒ 不画空壳（栏头那句「判据没跑」已经说明了）
    if (pb.groups === undefined) return;
    const nameConflicts = pb.nameConflicts || [];
    const noName = pb.noName || [];
    const noProblemId = pb.noProblemId || [];
    // ⚠️ **④⑤ 两类也要进这道闸**：只有"同一来源多出一条"/"按题名对上的"、其余三类为空时
    //    （很常见：脚本已经把那场处理干净了），早退就会把这两段整段吞掉。
    const extras = pb.sameSourceExtra || [];
    const paired = pb.namePaired || [];
    if (!nameConflicts.length && !noName.length && !noProblemId.length
        && !extras.length && !paired.length) return;

    // ★ **④ 同一来源多出一条**（例：`…-D` 被同一场的 C/D 都绑上了）：
    //   同场无同名 ⇒ 一个来源对同一道题只该有一条 ⇒ 多出来的那些**不绑**、在这里列出来。
    if (extras.length) {
        box.appendChild(groupHead(`④ 同一来源多出一条（一处来源对同一道题给了两条 ⇒ 多半是"题号错位"没对齐干净；`
            + `**多出来的那条没绑**）　**${extras.length}** 处`, 'warn'));
        for (const x of extras) {
            const row = mk('div', 'dedup-conflict-problems-extra',
                'font-size:12px;color:#64748b;line-height:1.8;margin-left:12px;word-break:break-all;');
            // ★ 前半段两个**节点**也做成可点的：
            //   `cId` = 场次那个 C 合成节点；`problemId` = 这一组的题号，点进去就是那个 P 合成节点。
            //   节点 id 由 `synthConflicts` 换算好（`cNodeId` / `id` —— 合成键 ≠ 节点 id）；
            //   还没导入包时 P 合成节点不在树上 ⇒ 那一处退化成纯文本（见 `nodeOrText`）。
            nodeOrText(row, x.cId, x.cNodeId || '');
            row.appendChild(document.createTextNode(' 的 '));
            nodeOrText(row, x.problemId, x.id || '');
            row.appendChild(document.createTextNode(' ⇒ 踢出：'));
            for (const c of x.list) {
                appendNodeLink(row, c.ext, c.id, c.link);
                row.appendChild(document.createTextNode(`「${c.name}」　`));
            }
            box.appendChild(row);
        }
    }

    // ★ **⑤ 按题名对上的**（题号对不上 ⇒ 脚本拿"题名 → 题号"把某条对到了另一个题号）：
    //   这些**已经绑上了**（不是待办），但"哪一条、从哪个题号对到哪个题号"要能看见、能点进去
    //   —— 判据那边一直算着它、界面却没人消费（报了等于没报）。所以这里列出来给人审。
    //   ⚠️ **默认折叠**：这些**已经绑上了**（不是待办），实测一场能对上十几条
    //      ⇒ 摊开会把上面真正待判的那几段刷没（模板里"只报不动的东西默认收着"那条规矩）。
    if (paired.length) {
        const box2 = foldSection(box, `⑤ 按题名对上的（题号对不上 ⇒ 脚本按题名把它对到了另一个题号；`
            + `**已经绑上了**，点开可审）　**${paired.length}** 处`, 'hint', 'problemPaired');
        for (const x of paired) {
            const row = mk('div', 'dedup-conflict-problems-paired',
                'font-size:12px;color:#64748b;line-height:1.8;margin-left:12px;word-break:break-all;');
            appendNodeLink(row, x.ext, x.id, x.link);
            row.appendChild(document.createTextNode(`「${x.name}」　${x.from} → ${x.to}`));
            if (x.base) row.appendChild(document.createTextNode(`（基准来源 ${x.base}）`));
            row.appendChild(document.createTextNode('　场次 '));
            nodeOrText(row, x.cId, x.cNodeId || '');
            box2.appendChild(row);
        }
    }

    for (const [kind, title, tone] of PB_KINDS) {
        const list = kind === 'name' ? nameConflicts : (kind === 'noName' ? noName : noProblemId);
        if (!list.length) continue;
        // ⚠️ **没有题号**那档的条目**没有 `cId`**（它们进不了任何题号组）⇒ 按 `cId` 数场次
        //    永远得到"／1 场"（全落进空串那个桶）。那档就不报场次数。
        const contests = kind === 'noPid' ? null : new Set(list.map((x) => x.cId || ''));
        // ★ **② 整组无题名默认折叠**：那些条没有可判的东西 ⇒ 收起；
        //   其它大类默认展开（那才是要你看的）。行统一挂到 `out` 上。
        const label = `${title}　**${list.length}** 处`
            + (contests ? `／${contests.size} 场` : '');
        const out = (kind === 'noName')
            ? foldSection(box, label, tone, 'problemNoName')
            : (box.appendChild(groupHead(label, tone)), box);
        if (kind === 'noName') {
            // 整组无题名照旧提示、可以直接绑 ⇒ 这栏**是提示、不是欠账**：
            // 组已经建好、成员已经绑上，缺的只是显示名。告诉人怎么把这个名字改掉。
            out.appendChild(mk('div', 'dedup-conflict-noname-note',
                'font-size:11px;color:#94a3b8;line-height:1.8;margin-left:12px;',
                '改显示名：在树上改那一条的题名，再点这一场的「✓ 确认这一场」—— 确认过的组脚本不再覆盖名字。'));
        }
        if (kind === 'noPid') {
            for (const x of list) {
                const row = mk('div', 'dedup-conflict-problems-nopid',
                    'font-size:12px;color:#94a3b8;line-height:1.8;margin-left:12px;word-break:break-all;');
                appendNodeLink(row, x.ext, x.id, x.link);
                row.appendChild(document.createTextNode('：这条 P 没有题号 ⇒ 进不了任何题号组'));
                out.appendChild(row);
            }
            continue;
        }
        // 大类下面 = **按场**（一场一屏），每场标题带比赛链接 + 「✓ 确认这一场」
        const byContest = new Map();
        for (const x of list) {
            if (!byContest.has(x.cId)) byContest.set(x.cId, { link: x.link || '', items: [] });
            byContest.get(x.cId).items.push(x);
        }
        for (const [cId, g] of [...byContest].sort((a, b) => a[0].localeCompare(b[0]))) {
            const head = mk('div', 'dedup-conflict-problem-group',
                'font-size:12px;color:#475569;font-weight:600;line-height:1.9;margin:2px 0 0 20px;word-break:break-all;');
            const cEl = mk('span', '', 'cursor:pointer;text-decoration:underline dotted;');
            cEl.textContent = cId;
            markGoto(cEl, g.items[0].cNodeId || '');   // ⚠️ 要用**合成节点的节点 id**（键不等于 id）
            head.appendChild(cEl);
            head.appendChild(document.createTextNode(`（${g.items.length} 处）`));
            if (g.link) {
                const a = mk('a', '', 'margin-left:8px;font-weight:400;');
                a.setAttribute('href', g.link);
                a.setAttribute('target', '_blank');
                a.setAttribute('rel', 'noreferrer');
                a.textContent = '比赛 ↗';
                head.appendChild(a);
            }
            // ★ **「✓ 确认这一场」**：把**组头**那格 `已确认` 打上（**组级、一条**），
            //   同时把成员指针按本组写一遍（值本来就一样，这一步只是让它落稳）。
            //   为什么改成组级（实测的坑）：以前只给**每个成员**打 `分类依据.ownerSynth='manual:set'`，
            //   而那一格**脚本自己也会写**（`applyOwnerSynth` 一律打它）⇒ "确认"被污染成
            //   "任何一次动作"，脚本产出的指针也被当成人的结论锁死（"点一次换一次、永远改不动"）。
            //   组级标记：只表达"人看过这一组、认为对"；脚本动作不写它；随组头进出包 ⇒ 重建不丢。
            if (kind === 'name' || kind === 'noName') {
                const ids = g.items.flatMap((x) => x.memberIds || []);
                if (ids.length) {
                    head.appendChild(rowButton('✓ 确认这一场',
                        '给这一组的组头打「已确认」标记（组级、一条），成员指针按本组落稳；'
                        + '以后脚本不再动这一组，且重建不丢',
                        () => {
                            runWrite((draft) => {
                                for (const x of g.items) {
                                    const headNode = draft.nodes[(x.id || '')] || null;
                                    if (headNode) headNode[CONFIRM_FIELD] = true;
                                    for (const id of x.memberIds || []) {
                                        const node = draft.nodes[id];
                                        if (node) applyOwnerSynth(draft, node, x.key);
                                    }
                                }
                            }, `已确认「${cId}」的 ${g.items.length} 题（脚本以后不再动）`).catch(() => {});
                        }));
                    // ★ **另一种确认**：「✂️ 不同的题」—— 号相同但**确实不是同一道**。
                    //   把"题名与基准不同的那几条"标上 `拆开` ⇒ 下一次建包给它们发 **`X1、X2…` 溢出号**，
                    //   从此与那一号**分属两组**（这是 (b) 之外的另一条路，两种都由人自己选）。
                    if (kind === 'name') {
                        const others = g.items.flatMap((x) => x.list || []);
                        if (others.length) {
                            head.appendChild(rowButton('✂️ 不同的题',
                                '把题名与基准不同的那几条标成「与同号那道不是同一道」⇒ 下一次建包'
                                + '给它们发 X 号（溢出号），从此分属两组（人的结论，随包走、重建不丢）',
                                () => {
                                    runWrite((draft) => {
                                        for (const x of g.items) {
                                            for (const c of (x.list || [])) {
                                                const node = draft.nodes[c.id];
                                                if (node) node[SPLIT_FIELD] = true;
                                            }
                                        }
                                    }, `已标「${cId}」里 ${others.length} 条为「不同的题」（下次建包生效）`).catch(() => {});
                                }));
                        }
                    }
                }
            }
            out.appendChild(head);
            for (const x of g.items) {
                const row = mk('div', 'dedup-conflict-problems',
                    'font-size:12px;color:#64748b;line-height:1.8;margin-left:32px;word-break:break-all;');
                if (kind === 'noName') {
                    // ★ 这些**已经绑上了** ⇒ 把它绑到了哪个键、由哪几条组成都写出来，
                    //   能点、能确认 —— 不是"只列成员、给不出键"的死胡同。
                    row.appendChild(document.createTextNode(`${x.problemId}：整组都没题名 ⇒ 已按题号绑上　`));
                    nodeOrText(row, x.key, x.id);       // 还没导入包时退化成纯文本（键照旧写出来）
                    row.appendChild(document.createTextNode('　成员 '));
                    (x.memberExts || []).forEach((e, i) => {
                        if (i) row.appendChild(document.createTextNode('、'));
                        appendNodeLink(row, e, (x.ids || [])[i], (x.links || [])[i]);
                    });
                    out.appendChild(row);
                    continue;
                }
                row.appendChild(document.createTextNode(`${x.problemId}：题名不一致　`));
                nodeOrText(row, x.key, x.id);
                row.appendChild(document.createTextNode(`　基准「${x.list[0] ? x.list[0].base : ''}」`));
                out.appendChild(row);
                for (const c of x.list) {
                    const li = mk('div', '', 'font-size:12px;color:#94a3b8;line-height:1.7;margin-left:44px;word-break:break-all;');
                    appendNodeLink(li, c.ext, c.id, c.link);
                    li.appendChild(document.createTextNode(`「${c.name}」`));
                    out.appendChild(li);
                }
            }
        }
    }
}

// ================================================================
// 那一栏
// ================================================================

/**
 * ⑤ 那一栏。
 *
 * @param {Object} model - `ui/dedup/model.js` 的 `computeModel()`（`model.conflicts` 就是结果）
 */
export function conflictSection(model, redraw) {
    const box = mk('div', 'dedup-conflict', 'margin-bottom:16px;');
    const conf = model.conflicts
        || { summary: {}, yearConflicts: [], yearLow: [], noKey: [], drift: [], noSynth: [], groupConflicts: [], suspectSplits: [] };
    const s = conf.summary || {};

    const title = mk('div', '', 'font-weight:600;font-size:13px;color:#334155;margin-bottom:6px;');
    title.textContent = `⑤ 冲突 / 待办：要人动的 ${s.alarms || 0} 处`;
    box.appendChild(title);

    const intro = mk('div', '', 'font-size:12px;color:#64748b;line-height:1.7;margin-bottom:4px;');
    intro.textContent = plain('这一栏按**当前的树**实时算（判据与产包脚本共用同一份：键的规则在 core/synthPlan.js、'
        + '可信度级别在 core/natureConfidence.js）—— 你改完 nature 立刻能在这里看到结果。'
        + '下面按「**要人判的 / 一键就能处理的 / 只记账的**」分三段，**每一栏都在**（0 条也在，灰的），'
        + '点标题展开看明细。⚠️ 这一栏**只读**：要改请去 ③ 性质待补或节点编辑。');
    box.appendChild(intro);

    renderSections(box, CONFLICT_SECTIONS, conf, { redraw, model });
    return box;
}
