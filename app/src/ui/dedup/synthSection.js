// ================================================================
// ① 合成节点清单（ui/dedup/synthSection.js）
//
// 职责：合成节点清单 + 改名/解绑/删除 + 悬空指针。
// ================================================================
import { pageState } from './state.js';
import { TYPE_LABEL, button, linkBlockOf, markGoto, nodeLabel, pager, reasonText, runWrite, slice } from './kit.js';
import { natureChips } from './naturePending.js';
// 悬空指针的**判据去重规则 + 文案 + 动作**都在这一份声明里（与 ⑤ 的「🧹 可清理」共用）
import { DANGLING_REASON, cleanDangling as cleanDanglingPtrs, incoherentProblems } from './pruneStages.js';
import { ensureUniqueName } from '../../core/ops/_helpers.js';
import { updateP, updateWS } from '../../core/ops/node.js';
import { assignSynthKey, bindOwner, createSynthNode, findReusableSynthSibling, isSynthKeyTaken, synthKeyOf, unbindOwner } from '../../core/ops/synth.js';
import { deleteNode } from '../../core/ops/tree.js';
import { AppState } from '../../shell/state.js';
import { mk } from '../../utils/dom.js';
import { showDeleteConfirm, showPromptDialog } from '../G_modal/G2_common.js';
import { showToast } from '../G_modal/G_modals.js';

export function synthSection(model, redraw) {
    const nodes = model.nodes;
    const groups = model.groups;
    const box = mk('div', '', 'margin-bottom:16px;');
    const title = mk('div', '', 'font-weight:600;font-size:13px;color:#334155;margin-bottom:6px;');
    title.textContent = `① 合成节点：${groups.length} 个`;
    box.appendChild(title);

    // 口径：已绑好的组**单独一块**，人只做**抽查 / 解绑** —— 这里不产生建议。
    const intro = mk('div', '', 'font-size:12px;color:#64748b;line-height:1.7;margin-bottom:6px;');
    intro.textContent = '核对模式：这里只把已经绑好的组列出来，供抽查与解绑，'
        + '不会产生任何建议。（建议在下面 ②，且只作用于还没归入的原料。）';
    box.appendChild(intro);

    box.appendChild(danglingRow(model.dangling, model.warnings));

    if (!groups.length) {
        const empty = mk('div', '', 'font-size:12px;color:#94a3b8;');
        empty.textContent = '还没有合成节点。在下面的「可能重复」里点「新建合成节点并归入」就会建一个。';
        box.appendChild(empty);
        return box;
    }

    box.appendChild(pager(groups.length, pageState.groups, 'groups', redraw));
    for (const g of slice(groups, 'groups')) {
        const card = mk('div', 'dedup-synth', 'border:1px solid #eef2f6;border-radius:8px;padding:8px 10px;margin-bottom:6px;background:#fcfdff;');

        const head = mk('div', '', 'display:flex;align-items:center;flex-wrap:wrap;font-size:13px;color:#0f172a;');
        const keyLine = mk('span', 'dedup-synth-key', 'font-size:12px;color:#475569;font-family:ui-monospace,Consolas,monospace;margin-right:8px;');
        keyLine.textContent = g.key;
        head.appendChild(keyLine);
        const nameEl = mk('span', 'dedup-synth-name', 'flex:1;min-width:0;');
        nameEl.textContent = `${TYPE_LABEL[g.type] || g.type} · ${g.name || g.nodeId}`;
        markGoto(nameEl, g.nodeId);      // 点组名 ⇒ 跳到树上那个合成节点
        head.appendChild(nameEl);
        const countEl = mk('span', 'dedup-synth-count', 'font-size:12px;color:#64748b;margin-right:4px;');
        countEl.textContent = `成员 ${g.memberIds.length}`;
        head.appendChild(countEl);
        head.appendChild(button('改名', 'font-size:12px;padding:2px 10px;', () => renameSynthTitle(g.nodeId)));
        head.appendChild(button('改合成标识', 'font-size:12px;padding:2px 10px;',
            () => renameSynthKey(g.nodeId)));
        head.appendChild(button('删除合成节点', 'font-size:12px;padding:2px 10px;color:#b91c1c;',
            () => removeSynthNode(g.nodeId, g.name || g.nodeId, g.memberIds.length)));
        card.appendChild(head);

        if (!g.memberIds.length) {
            const empty = mk('div', '', 'font-size:12px;color:#94a3b8;margin-top:4px;');
            empty.textContent = '（还没有成员）';
            card.appendChild(empty);
        }
        for (const id of g.memberIds) {
            const node = nodes[id];
            const row = mk('div', 'dedup-member', 'display:flex;align-items:center;flex-wrap:wrap;font-size:13px;color:#0f172a;margin-top:2px;');
            const bad = model.dangling.some(d => d.id === id);
            const name = mk('span', '', `flex:1;min-width:0;${bad ? 'color:#b45309;' : ''}`);
            name.textContent = nodeLabel(node) + (bad ? ' ⚠️ 指针有问题' : '');
            markGoto(name, id);
            row.appendChild(name);
            row.appendChild(natureChips(id, redraw));      // ← 链接左侧的三个 nature（可点改）
            const links = linkBlockOf(id, 'margin-right:6px;');
            if (links) row.appendChild(links);
            row.appendChild(button('解绑', 'font-size:12px;padding:2px 10px;', () => unbindMember(id)));
            card.appendChild(row);
        }
        box.appendChild(card);
    }
    return box;
}

/**
 * 悬空指针那一条（**标黄 + 一键清理**，不是丢弃）。
 *
 * 口径：指针指向的合成标识不存在 / 跨类型 / 指向自己。这种数据不炸（计数会把它
 * 当"单元素组"），但它显然不是用户想要的 ⇒ 显式列出来让用户决定。
 *
 * ⚠️ **同一类**的坏数据（计数口径 `collectGroups` 报出的"节点 id 当标识写"、
 * "两个节点共用一个标识"）也**并进同一条黄条**列出来 —— 不另造警告面板。
 * 已经在悬空那半句里的节点不重复列：那是同一件事的两种说法，黄条里说一遍就够。
 * 这一块**没有写操作**（那两类问题得用户自己改数据，清指针解决不了）。
 */

function danglingRow(dangling, problems) {
    const box = mk('div', 'dedup-dangling', 'margin-bottom:8px;');
    // ⚠️ **两个半句的判据/去重规则都从 `pruneStages.js` 出**（与 ⑤ 的「🧹 可清理」同一条声明）：
    //    这里只负责"画成一条黄条"，不再自己滤 warnings、也不自己写清理动作。
    const extra = incoherentProblems({ dangling, warnings: problems });
    if (!dangling.length && !extra.length) return box;

    const bar = mk('div', '', 'border:1px solid #fde68a;border-radius:8px;padding:8px 10px;'
        + 'background:#fffbeb;font-size:12px;color:#92400e;line-height:1.7;display:flex;'
        + 'align-items:center;flex-wrap:wrap;gap:6px;');
    if (dangling.length) {
        // ⚠️ 这一条**刻意不做成可点链接**：它是纯文本黄条（整句一个 `textContent`），
        //    混进元素会把句子切碎（冒烟里的 DOM 桩也不聚合 `textContent`）——
        //    而"跳过去核对"在 ①（成员行）里已经有了，这里不重复造入口。
        const items = dangling.slice(0, 5).map(d => {
            const n = (AppState.nodes || {})[d.id];
            return `${nodeLabel(n)} → ${d.synthKey}（${DANGLING_REASON[d.reason] || d.reason}）`;
        });
        const text = mk('span', '', 'flex:1;min-width:0;');
        text.textContent = `⚠️ 有 ${dangling.length} 个指针是悬空的：`
            + items.join('；') + (dangling.length > items.length ? ` …等 ${dangling.length} 个` : '');
        bar.appendChild(text);
        bar.appendChild(button('一键清理', 'font-size:12px;padding:2px 10px;', cleanDangling));
    }
    if (extra.length) {
        const text = mk('span', '', 'flex:1 1 100%;min-width:0;');
        text.textContent = `⚠️ 还有 ${extra.length} 处数据不自洽（计数与成员表读不到一起，得改数据）：`
            + extra.slice(0, 5).join('；') + (extra.length > 5 ? ` …等 ${extra.length} 处` : '');
        bar.appendChild(text);
    }
    box.appendChild(bar);
    return box;
}

// ================================================================
// ② 控制栏 —— 筛选范围
//
// 筛选范围只信性质归类：跨性质的不建议。控件照「一级 tab 栏的
// 『题目检索』」那一套。绑定只用在两种情形：
//   · 绑定的正确性可以保证；
//   · 缩小比较范围后规模够小，足以手动处理。
//
// 控制栏与「题目检索」同款控件、同一套 CSS；条件一变就**重算**并重画，
// 右上角永远显示**命中条数**（一眼看到"缩到多少条"）。
// ================================================================

export function joinSynth(materialId, synthKey) {
    if (!synthKey) {
        showToast('这条建议没有可归入的合成节点，请用「新建合成节点并归入」', 'info');
        return;
    }
    runWrite((draft) => bindOwner(draft, materialId, synthKey), `已归入 ${synthKey}`).catch(() => {});
}

/** ② 新建一个合成节点，并把一条或两条原料归入它 */

export function createAndJoin(materialIds, suggestKey) {
    runWrite((draft) => {
        const first = draft.nodes[materialIds[0]];
        if (!first) throw new Error('节点不存在');
        const parentId = draft.parentOf[first.id];
        if (!parentId) throw new Error('这个节点不在树上，没法在它旁边建合成节点');
        // 标识：候选给的只是**建议**（多半是 extKey）—— 被占用了就退回自动标识。
        // ⚠️ "被占用"的判据**只有一处**：`isSynthKeyTaken`（core/ops/synth.js）。
        //    这里刻意不自己扫 `synthIndex`：那是第二套判断
        //    （写路径 `createSynthNode` 自己也用同一个判据抛"已被占用"作最后防线）。
        //    建议被占 ⇒ 换一个自动标识，而不是把"新建并归入"整个拒掉：
        //    候选行给的标识只是启发式的**建议**，不是用户的明确指定；为此拒绝一次
        //    用户主动发起的归入，等于让用户替他看不懂的建议买单。
        const wanted = String(suggestKey || '').trim();
        const taken = isSynthKeyTaken(draft, wanted);
        // ★ 位置不撞（合成节点的生成"不要又撞位置又撞名字"）：
        //   那个位置上**已经有代表同一批东西的合成节点**时，**归入它**，别在旁边再叠一个
        //   （"同一父节点下并排好几个近乎同名的合成节点"就是这么来的）。
        //   判据只有一条、且三条规则都是**精确相等**（`findReusableSynthSibling`，core/ops/synth.js）：
        //     ① 候选给的标识正被**同父同类型**的一个兄弟用着 ⇒ 那就是它（"若调用方给得出候选"）；
        //     ② 同父同类型下已经有一个**名字一字不差**的合成节点 ⇒ 就是它；
        //     ③ 同父同类型下已经有一个**成员集合完全相同**的合成节点 ⇒ 就是它
        //        （同一批成员又被点了一次；注意光靠名字认不出来 —— `ensureUniqueName`
        //         保证新建的那个永远不重名，`渠道甲` 会被改成 `渠道甲1`）。
        //   ⚠️ 复用不改这三块布局 / 分页 / 确认框，也不绕校验：归入照走 `bindOwner`。
        const reusable = findReusableSynthSibling(draft, parentId, {
            synthKey: taken ? wanted : '',
            name: first.name,
            memberIds: materialIds,
            type: first.type
        });
        const node = reusable || ((wanted && !taken)
            ? createSynthNode(draft, parentId, { type: first.type, name: first.name, synthKey: wanted })
            : createSynthNode(draft, parentId, { type: first.type, name: first.name }));
        const key = synthKeyOf(node);
        for (const id of materialIds) bindOwner(draft, id, key);
        return { key, reused: !!reusable };
    }, (r) => (r && r.reused ? `已归入已有的合成节点 ${r.key}` : '已新建合成节点并归入')).catch(() => {});
}

/** 改合成节点的**标题**（改身份是另一个动作，见下面的 `renameSynthKey`） */

function renameSynthTitle(nodeId) {
    const node = (AppState.nodes || {})[nodeId];
    if (!node) return;
    showPromptDialog('改合成节点标题', '标题（只影响显示；成员不变）', node.name || '', (val) => {
        if (!val) return;
        runWrite((draft) => {
            const target = draft.nodes[nodeId];
            if (!target) throw new Error('节点不存在');
            // ⚠️ 必须自己保证不重名：`updateP`/`updateWS` 只管写字段、**不管重名**，
            //    不自己拦就能把合成节点改成与兄弟同名（与"新建时不撞名字"自相矛盾）。
            //    照 `G_modal/editForm.js` 的同款判据：**名字没变就不动**、比较时**排除自己**。
            let finalName = val;
            const parentId = (draft.parentOf || {})[nodeId] || null;
            if (parentId && val !== target.name) {
                let clash = false;
                for (const cid of draft.childOrder[parentId] || []) {
                    const c = draft.nodes[cid];
                    if (c && c.id !== nodeId && c.name === val) { clash = true; break; }
                }
                if (clash) finalName = ensureUniqueName(draft, parentId, val);
            }
            if (target.type === 'P') updateP(draft, nodeId, { name: finalName });
            else updateWS(draft, nodeId, { name: finalName });
        }, '标题已修改').catch(() => {});
    });
}

/**
 * 改**合成标识**（换身份）。
 *
 * `assignSynthKey` 在**同一个事务**里把所有成员指针一起重写 —— 这是硬要求
 * （分两次改就会出现"指针指向已经不存在的标识"的瞬间，而那个瞬间可能被自动落盘）。
 */

function renameSynthKey(nodeId) {
    const node = (AppState.nodes || {})[nodeId];
    if (!node) return;
    const from = synthKeyOf(node);
    showPromptDialog('改合成标识', `合成标识（当前 ${from}）；成员指针会在同一事务里一起改`, from, (val) => {
        if (!val || val === from) return;
        runWrite((draft) => assignSynthKey(draft, nodeId, val), `合成标识已改为 ${val}`).catch(() => {});
    });
}

/** 解绑一个成员（成员本身还在树上，只是不在这个名单里了） */

function unbindMember(memberId) {
    runWrite((draft) => unbindOwner(draft, memberId), '已解绑').catch(() => {});
}

/** 删除合成节点（成员不删；指向它的指针由 deleteNode 在同一事务里清掉） */

function removeSynthNode(nodeId, name, memberCount) {
    showDeleteConfirm(
        '删除合成节点',
        `确定删除合成节点「${name}」吗？它的 ${memberCount} 个成员「不会被删除」，只是解绑。此操作可撤销。`,
        (yes) => {
            if (!yes) return;
            runWrite((draft) => deleteNode(draft, nodeId), '合成节点已删除（成员保留）').catch(() => {});
        }
    );
}

/** 一键清理悬空指针（**动作壳在 `pruneStages.js`** —— ⑤ 的「🧹 可清理」走的是同一个） */

function cleanDangling() {
    cleanDanglingPtrs();
}

// ================================================================
// 渲染
// ================================================================

/**
 * 画整个整理页。
 *
 * @param {string} [containerId]
 * @returns {HTMLElement|null}
 */
