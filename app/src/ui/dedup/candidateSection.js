// ================================================================
// ② 可能重复（ui/dedup/candidateSection.js）
//
// 职责：可能重复的原料 + 推荐归入 + 控制栏。
// ================================================================
import { pageState, viewState } from './state.js';
import { ROW_CSS, TYPE_LABEL, button, chipGroup, field, hint, linkBlockOf, markGoto, natureChipOption, nodeLabel, pager, reasonText, runWrite, selectControl, slice, textInput } from './kit.js';
import { applyFilterChange, scopeChoices } from './model.js';
import { createAndJoin, joinSynth } from './synthSection.js';
import { natureChips, pendingState } from './naturePending.js';
import { DEDUP_OWNED_VALUES, DEDUP_SCOPE_KINDS, emptyDedupFilter, NO_CLASS, PARTIAL_CLASS, NO_VALUE, HAS_VALUE } from '../../core/dedup.js';
import { NATURE_FIELD_KEYS, natureFieldOf } from '../../core/natureFields.js';
// 分类依据强度（与 ③ 同一份级别表：`M` 人工 / A…E；别再写第二份档位名单）
import { MANUAL_LEVEL, RULE_LEVELS, levelLabel } from '../../core/natureConfidence.js';

/** 四个**哨兵值**（`（没标…）`/`（有标…）`/`（分类不完全）`）—— 真源在 `core/dedup.js` */
const DEDUP_SENTINELS = [NO_CLASS, PARTIAL_CLASS, NO_VALUE, HAS_VALUE];
import { mk } from '../../utils/dom.js';

export function candidateSection(model, redraw) {
    const nodes = model.nodes;
    const candidates = model.candidates;
    const box = mk('div', '', 'margin-bottom:16px;');
    const title = mk('div', '', 'font-weight:600;font-size:13px;color:#334155;margin-bottom:6px;');
    title.textContent = `② 可能重复：${candidates.length} 条建议（推荐，不是判定）`;
    box.appendChild(title);

    box.appendChild(controlBar(model, redraw));

    if (model.truncated.length) {
        const warn = mk('div', '', 'font-size:12px;color:#b45309;margin-bottom:6px;line-height:1.7;');
        const sizes = model.truncated.map(t => t.size).sort((a, b) => b - a).slice(0, 3).join('、');
        warn.textContent = `⚠️ 有 ${model.truncated.length} 个容器下节点太多（最大 ${sizes} 个），`
            + '这些容器「只按"名字完全相同"配对」（两两比相似度会算不完）。';
        box.appendChild(warn);
    }

    if (!candidates.length) {
        const empty = mk('div', 'dedup-empty', 'font-size:12px;color:#94a3b8;line-height:1.8;');
        empty.textContent = '当前范围与条件下没有可信的重复信号（题号相同 / 标题完全相同）。'
            + '这是正常的：现在的建议精度本来就低，宁可空着也不刷屏。'
            + '换一个范围、放宽性质筛选，或（明知噪声大时）开启「相似度建议」再看看。';
        box.appendChild(empty);
        return box;
    }

    box.appendChild(pager(candidates.length, pageState.candidates, 'candidates', redraw));
    for (const cand of slice(candidates, 'candidates')) {
        const a = nodes[cand.a];
        const b = nodes[cand.b];
        if (!a || !b) continue;
        const joinTarget = !!cand.suggestSynthId;

        const card = mk('div', 'dedup-cand', 'border:1px solid #fde68a;border-radius:8px;padding:8px 10px;margin-bottom:6px;background:#fffbeb;');
        const names = mk('div', '', 'font-size:13px;color:#0f172a;line-height:1.7;');
        // 两个节点**各自一行**：名字可点（跳到树上）+ 名字后面就是它自己的「🔗 链接 (N)」
        // —— 核对时"这条建议里 A 和 B 各是什么"要一眼分得开，所以不做成一行两列。
        const labelRow = (prefix, id, node) => {
            const line = mk('div', 'dedup-cand-node', 'display:flex;align-items:center;flex-wrap:wrap;gap:6px;');
            if (prefix) {
                const p = mk('span', '', 'color:#64748b;');
                p.textContent = prefix;
                line.appendChild(p);
            }
            const nameEl = mk('span', 'dedup-cand-name');
            nameEl.textContent = nodeLabel(node);
            markGoto(nameEl, id);
            line.appendChild(nameEl);
            line.appendChild(natureChips(id, redraw));     // ← 链接左侧的三个 nature（可点改）
            const links = linkBlockOf(id);
            if (links) line.appendChild(links);
            return line;
        };
        names.appendChild(labelRow('', cand.a, a));
        names.appendChild(labelRow(joinTarget ? '↳ 建议归入' : '⟷', cand.b, b));
        const tail = mk('span', '', 'color:#64748b;font-size:12px;');
        tail.textContent = joinTarget
            ? '（把 A 归入 B 那个合成节点）'
            : '—— 建议新建一个合成节点，把它们一起归入';
        names.appendChild(tail);
        const reason = mk('span', 'dedup-reason', 'color:#94a3b8;font-size:12px;margin-left:4px;');
        reason.textContent = `（${reasonText(cand)}）`;
        names.appendChild(reason);
        card.appendChild(names);

        const line = mk('div', '', 'display:flex;align-items:center;gap:6px;margin-top:6px;');
        const label = mk('span', '', 'font-size:12px;color:#64748b;');
        label.textContent = '合成标识：';
        line.appendChild(label);
        const value = mk('span', 'dedup-synth-key', 'flex:1;min-width:120px;font-size:12px;'
            + 'font-family:ui-monospace,Consolas,monospace;color:#334155;');
        value.textContent = cand.suggestSynthId
            ? cand.suggestKey
            : (cand.suggestKey || '（自动生成）');
        line.appendChild(value);

        if (joinTarget) {
            line.appendChild(button('归入', 'font-size:12px;padding:2px 10px;',
                () => joinSynth(cand.a, cand.suggestKey)));
        } else {
            line.appendChild(button('新建合成节点并归入', 'font-size:12px;padding:2px 10px;',
                () => createAndJoin([cand.a, cand.b], cand.suggestKey)));
        }
        card.appendChild(line);

        if (!joinTarget && !cand.suggestKey) {
            const warn = mk('div', '', 'font-size:12px;color:#b45309;margin-top:4px;');
            warn.textContent = '这两个节点都没有 extKey，会用自动标识（synth:…），之后可以「改合成标识」。';
            card.appendChild(warn);
        }
        box.appendChild(card);
    }
    return box;
}

// ================================================================
// ③ 「性质待补」—— 大类已标、小类 / 年份 / 地区还有空缺的节点
//
// 口径：
//   · natureSub 可以为空 —— 会归入为空的分类，同时进入推荐填写 natureSub 的逻辑；
//   · xcpc 若另 3 nature 未填就该提醒。
//
// 这一块**只做一件事**：把待补的列出来，让人**批量**填进去。
//   · **口径一个字都不在这里判**：哪些算待补、怎么分组，全在 `core/dedup.js` 的
//     `missingNatureKeysOf` / `collectNaturePendingItems` / `groupNaturePending`
//     （纯函数、有 Node 单测）；
//   · **写操作走 `runWrite`（= `execute` 事务）**，字段写入走**与编辑面板同源**的
//     `updateP / updateR / updateWS`（`core/ops/node.js` 的唯一一处 `applyNatureFields`）——
//     本块**绝不直接改 draft 的字段**；
//   · 勾选若干条 + 上面那组"待填值"，**一次事务**全写完 —— 这一块存在的意义就是
//     "别一场一场点编辑面板"。
//
// ⚠️ **这里只做最直白的列表 + 手填**：优化方向（按系列批量推断、
//    导入回代、按父容器继承 nature、填完自动跳到下一条……）**不在这里做** ——
//    要做时先动 `core/dedup.js` 的口径函数（它是这一块唯一的判据来源），再改这里。
// ================================================================

/**
 * 本块的**临时**状态（勾选 + 待填值）：只活在页面上，**不进数据、不进导出**
 * （与 `viewState` 同一个理由：数据变了不该把用户敲了一半的东西冲掉）。
 *
 * ⚠️ 所有控件都从这里取值、也写回这里 —— 于是 `redraw()` 可以随时整页重画
 *    （勾选框、下拉、文本框都还在原样），树桩里也就能直接用事件驱动。
 */
/**
 * ③ 分类筛选的两个**哨兵值**（存进 `pendingState.cls`）。
 *
 * 为什么不能像别处那样拿空串当"全部"：③ 的组里**有一组的分类本身就是空串**
 * （"连分类都没标"的比赛）—— 两者用同一个值就分不开了（点谁都一样）。
 */

function controlBar(model, redraw) {
    const box = mk('div', 'dedup-filter', 'display:flex;flex-direction:column;gap:8px;'
        + 'padding:10px 4px 12px 4px;border:1px solid #eef2f6;border-radius:8px;'
        + 'background:#fbfdff;margin-bottom:8px;');
    const change = () => applyFilterChange(redraw);

    // ---- 第一行：范围 ----
    const row1 = mk('div', '', ROW_CSS);
    row1.appendChild(field('范围', selectControl([
        { value: 'all', label: '整棵树' },
        { value: 'subtree', label: '某个子树（选一个节点）' },
        { value: 'contest', label: '单场比赛（一个 C 容器）' }
    ], viewState.scopeKind, (v) => {
        viewState.scopeKind = DEDUP_SCOPE_KINDS.includes(v) ? v : 'all';
        if (viewState.scopeKind === 'all') viewState.scopeNodeId = '';
        change();
    })));
    if (viewState.scopeKind !== 'all') {
        if (viewState.scopeKind === 'contest') {
            row1.appendChild(field('场次筛选', textInput(viewState.scopeSearch, '按名字 / 标识包含匹配',
                (v) => { viewState.scopeSearch = v; change(); }, '150px')));
        }
        const choices = scopeChoices(viewState.scopeKind);
        if (!choices.length) {
            row1.appendChild(hint('（没有匹配的节点）'));
        } else {
            row1.appendChild(field(viewState.scopeKind === 'contest' ? '比赛' : '节点',
                selectControl(choices, viewState.scopeNodeId, (v) => {
                    viewState.scopeNodeId = v;
                    change();
                })));
        }
    }
    const hit = mk('span', 'dedup-hit', 'margin-left:auto;font-size:12px;color:#334155;font-weight:600;');
    hit.textContent = `命中 ${model.candidates.length} 条建议 · ${model.scopeLabel}`;
    row1.appendChild(hit);
    box.appendChild(row1);

    // ---- 第二行起：nature 四维（**可选项从当前数据里收集**，不穷举词表）----
    // 其中「筛选分组」（如小类的「省赛或邀请赛」）也在这里，标签会写明它含哪几个值。
    for (const key of NATURE_FIELD_KEYS) {
        const label = natureFieldOf(key).label;
        const options = (model.facets.nature[key] || []).map(natureChipOption);
        const row = mk('div', '', ROW_CSS);
        // ⚠️ 哨兵档（`（没标分类）`/`（有标年份）`…）**永远在** ⇒ `options.length` 永不为 0，
        //    所以"这一维没数据"要按**真值**判（哨兵不算），那句话照旧得画出来。
        const hasReal = options.some((o) => !DEDUP_SENTINELS.includes(o.value));
        if (!hasReal) {
            const empty = mk('span', 'dedup-nature-empty', 'font-size:12px;color:#94a3b8;');
            // 带上字段键：测试与将来排查都**按这个认维度**，别拿标签文字当代理
            empty.dataset.field = key;
            empty.textContent = '（数据里还没有这个字段 —— 导入带 nature 的包之后才会出现可选项）';
            row.appendChild(empty);
        }
        row.appendChild(field(`性质·${label}`, chipGroup(
            options, viewState.filter[key],
            (next) => { viewState.filter[key] = next; change(); }
        )));
        box.appendChild(row);
    }

    // ---- 类型 / 归入状态 ----
    const rowType = mk('div', '', ROW_CSS);
    if (model.facets.types.length) {
        rowType.appendChild(field('类型', chipGroup(
            model.facets.types.map(t => ({ value: t, label: `${t} ${TYPE_LABEL[t] || ''}`.trim() })),
            viewState.filter.types,
            (next) => { viewState.filter.types = next; change(); }
        )));
    }
    rowType.appendChild(field('归入状态', chipGroup(
        [{ value: DEDUP_OWNED_VALUES[0], label: '只看未归入' },
            { value: DEDUP_OWNED_VALUES[1], label: '含已归入' }],
        [viewState.filter.owned],
        (next) => {
            // 单选：再点一下不取消（否则会落到"两个都不选"这种没有意义的状态）
            const v = next.filter(x => x !== viewState.filter.owned)[0];
            if (!v) return;
            viewState.filter.owned = v;
            change();
        }
    )));
    box.appendChild(rowType);

    // ---- 分类**依据强度**（与 ③ 性质待补同一个 `classLevel` 判据）----
    // 为什么 ② 也要它：候选是"还没归入的原料"，而"这条分类是我该复核的"正好是**同一批**节点
    // —— 少了这一档就只能在 ③ 里看，② 里挑不出"依据弱的那几对"。
    // 语义与 ③ 一字不差：单选（`M` 人工 / `≤ X` 及更弱；再点一下取消 = 全部）。
    const rowLevel = mk('div', '', ROW_CSS);
    rowLevel.appendChild(field('性质·分类依据', chipGroup([
        { value: MANUAL_LEVEL, label: `${MANUAL_LEVEL} 人工（只看我填的）` },
        ...RULE_LEVELS.slice().reverse().map(lv => ({ value: lv, label: `≤ ${levelLabel(lv).split('（')[0]}` }))
    ], [viewState.filter.classLevel], (next) => {
        const v = next.filter(x => x !== viewState.filter.classLevel)[0];
        viewState.filter.classLevel = v || '';
        change();
    })));
    box.appendChild(rowLevel);

    // ---- 关键词 + 相似度辅助 + 清空条件 ----
    const rowKw = mk('div', '', ROW_CSS);
    rowKw.appendChild(field('关键词', textInput(viewState.filter.keyword, '题名 / 题号 包含匹配',
        (v) => { viewState.filter.keyword = v; change(); }, '170px')));

    const simOn = viewState.mode !== 'strict';
    const simBtn = document.createElement('button');
    simBtn.type = 'button';
    simBtn.className = 'dedup-chip';
    simBtn.dataset.value = 'similarity';
    simBtn.textContent = simOn ? '✔ 同时显示相似度建议' : '开启相似度建议（噪声大）';
    simBtn.style.cssText = `padding:2px 8px; border:1px solid ${simOn ? '#b45309' : '#d1d5db'};`
        + ` border-radius:10px; font-size:12px; cursor:pointer;`
        + ` background:${simOn ? '#fffbeb' : '#fff'}; color:${simOn ? '#b45309' : '#475569'};`;
    simBtn.addEventListener('click', () => {
        viewState.mode = simOn ? 'strict' : 'all';
        change();
    });
    rowKw.appendChild(field('相似度辅助', simBtn));

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'dedup-clear';
    clearBtn.textContent = '清空条件';
    clearBtn.style.cssText = 'margin-left:auto; padding:3px 10px; border:1px solid #d1d5db;'
        + ' border-radius:4px; background:#fff; font-size:12px; color:#475569; cursor:pointer;';
    clearBtn.addEventListener('click', () => {
        viewState.scopeKind = 'all';
        viewState.scopeNodeId = '';
        viewState.scopeSearch = '';
        viewState.filter = emptyDedupFilter();
        viewState.mode = 'strict';
        change();
    });
    rowKw.appendChild(clearBtn);
    box.appendChild(rowKw);

    // ---- 口径说明（页面要写明，别让用户猜）----
    const tip = mk('div', 'dedup-tip', 'font-size:12px;color:#64748b;line-height:1.8;');
    tip.textContent = '默认只报「机器能判定」的等价信号：双方题号相同，或标题完全相同。'
        + '缩到「单场比赛」后通常只剩个位数，可以手动处理。'
        + '跨性质的（大类 / 小类 / 年份 / 地区对不上）一律不建议。';
    box.appendChild(tip);
    if (simOn) {
        const warn = mk('div', 'dedup-warn', 'font-size:12px;color:#b45309;line-height:1.8;');
        warn.textContent = '⚠️ 已开启相似度建议：下面这些只是名字像，不是同一个东西，'
            + '仅供人工扫一眼；它们同样受范围与性质筛选约束。';
        box.appendChild(warn);
    }
    return box;
}

/** 一条建议的**依据**文案（"凭什么"必须写出来） */
