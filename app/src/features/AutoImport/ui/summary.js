// ================================================================
// 统计栏 + 问题清单（features/AutoImport/ui/summary.js）
//
// 导入前"会写什么"的统计、性质差异列、错误/警告清单。
// `natureDiffOf` 也在这儿（只有这两处用它）。
//
// ⚠️ **被拒绝 / 悬空的成员指针不止给计数**：`appendPointerIssues()` 会把它们逐条列出来
//    （节点名 + `extKey` + 目标 + 树上现值 + 原因 + 「跳到树上」链接）——
//    只给数字的话，用户拿不到"是哪条、该去改哪个节点"。
// ================================================================
import { AppState } from '../../../shell/state.js';
import { EVENTS } from '../../../A_constants.js';
import { accountName } from '../../../core/ops/account.js';
import { NATURE_FIELD_KEYS, natureFieldOf } from '../../../core/natureFields.js';
import { CLASS_RULE_COL } from '../../../core/natureConfidence.js';
import { button } from './kit.js';
// ★ 异常报告走**统一模板**（与判重整理 ⑤、体检·需求同一套：定序分段 / 每栏都在 / 默认折叠）
import { renderSections } from '../../../ui/kit/report.js';
// 悬停提示（`title`）也是给人看的字 ⇒ 统一去 Markdown 记号（实现只有一份）
import { plain } from '../../../utils/text.js';

export function natureDiffOf(rec) {
    const list = (rec && Array.isArray(rec.natureDiff)) ? rec.natureDiff : [];
    if (!list.length) return null;
    const labelOf = key => {
        const f = natureFieldOf(key);
        return (f && f.label) || key;
    };
    return {
        count: list.length,
        // 单元格里只给"哪几维不一致"（点开 title 看具体值）
        short: list.map(d => labelOf(d.field)).join('、'),
        title: list.map(d => {
            const f = natureFieldOf(d.field);
            const label = (f && f.label) || d.field;
            // 勾了「以包里为准」的那些会真的写进去 —— tooltip 里说清"哪几处会被覆盖"
            const mark = d.forced ? '★ 本次会覆盖' : '（只提示，不覆盖）';
            return `${mark}　${label}：树上「${d.oldValue}」→ 包里「${d.newValue}」`
                + (d.rule ? `（依据 ${d.rule}）` : '');
        }).join('\n')
    };
}

export function renderSummary(container, plan, opts = {}) {
    const s = plan.summary;
    const box = document.createElement('div');
    box.className = 'ai-summary';
    box.style.cssText = 'display:flex; gap:14px; flex-wrap:wrap; align-items:center;'
        + ' padding:8px 12px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:6px; font-size:13px;';

    const chip = (label, value, color, title) => {
        const el = document.createElement('span');
        el.style.cssText = `color:${color}; font-weight:600;`;
        el.textContent = `${label} ${value}`;
        if (title) el.title = title;          // 悬停说清"这个数是数什么的"
        return el;
    };

    box.appendChild(chip('新增', s.create, '#16a34a', '本包里**没在树上**的记录（会新建节点）'));
    box.appendChild(chip('更新', s.update, '#2563eb', '本包里**树上已有**、且有字段要改的记录'));
    box.appendChild(chip('跳过', s.skip, '#64748b', '本包里树上已有、且**没有字段要改**的记录（一条都不写）'));
    // 会**换父**的条数。恒常渲染（0 也在）：与上面三项同构 —— "位置一个没动"也要看得见。
    if (s.moved !== undefined) {
        box.appendChild(chip('🔀 重挂', s.moved, s.moved > 0 ? '#b45309' : '#94a3b8',
            '这些记录的父与树上现在挂的父不一致 ⇒ 执行时会按包里的父换挂'));
    }
    // 合成（预览**必须**列出这两项）——与上面三项同构呈现。
    // 恒常渲染（哪怕是 0）："没有合成节点/指针"本身就是要看见的信息。
    // ⚠️ 这个数与「新增/更新」**不是同一批东西**：合成节点（组头）没有 extKey、身份是
    //    `synthKey`，走**两阶段通道**（与普通记录分开建），所以它**不计入**上面那三个数。
    //    它在下面那张表里单独成行，动作写成「新建合成 / 更新合成 / 跳过合成」。
    if (s.synthNodes !== undefined) {
        box.appendChild(chip('新建/更新合成节点', s.synthNodes, '#7c3aed',
            '合成节点（组头）= 一场比赛/一道题攒出来的那颗"并"节点，身份是 synthKey（没有 extKey）'
            + ' ⇒ 与普通记录分开走一条通道，**不计入**上面的新增/更新/跳过。'
            + '下面是它的条数（新建 + 更新）；表里那几行写着「新建合成 / 更新合成 / 跳过合成」。'));
    }
    if (s.pointerSet !== undefined) {
        box.appendChild(chip('设置成员指针', s.pointerSet, '#0891b2',
            '会写「所属合成节点」（ownerSynth）的记录条数 —— 即"这一条归到哪个组"'));
    }
    box.appendChild(chip('警告', s.warnings, s.warnings > 0 ? '#d97706' : '#94a3b8'));
    box.appendChild(chip('错误', s.errors, s.errors > 0 ? '#dc2626' : '#94a3b8'));

    // ★ 上面这一行是**统计**（有几条会写、几条不写）；下面才是**异常报告**。
    //   异常报告全部走**统一模板**（`ui/kit/report.js`）—— 与判重整理 ⑤、体检页同一套：
    //   **每一栏都在**（0 条也在，灰的、默认折叠）、分三段、点标题展开看明细。
    //   ⚠️ 以前这里是**一串内联 note**（有才出现、没就消失、顺序还按代码先后），
    //      用户 2026-10-06："这些异常报告的位置也太乱了，我根本理不清逻辑"。
    appendImportReport(box, plan, opts);

    container.appendChild(box);
}

// ================================================================
// ★ 导入预览的异常报告（**统一模板**：判重整理 / 节点自动导入 / 体检·需求 同一套）
//
//   ① **会挡住的** —— 错误、成员指针被拒：这些条目不落库
//   ② **只管提醒** —— 警告、性质不一致、归认：不影响执行，但要你看一眼
//   ③ **只记账**   —— 相似标题被忽略、未使用字段：跑过了、跳过了多少
//
// ⚠️ **每一栏都在**（0 条也在）：导入预览最容易骗人的就是"什么都没有"——
//    那到底是"没问题"还是"这段根本没跑"？计数为 0 也要看得见。
// ================================================================

/** 被拒绝 / 悬空的成员指针（`plan.synth.pointers` 阶段 2 清单里那两类） */
function pointerIssues(plan) {
    const all = (plan && plan.synth && plan.synth.pointers) || [];
    return all.filter(p => p && (p.action === 'reject' || p.dangling));
}

/**
 * 异常报告的**环节清单**（三段）。
 *
 * `items(plan, opts)` 给"这一栏有几条"，`title(n, plan, opts)` 写标题（**口径就在标题里**），
 * `row` / `body` 画明细。控件的回调走 `opts`（由 `panel.js` 给，与以前一样）。
 */
function importReportSections() {
    const one = (cond, fact) => (cond ? [fact] : []);
    return [
        {
            title: '① 会挡住的',
            hint: '这些条目不落库（要么改包、要么先在应用里处理掉）',
            stages: [
                {
                    id: 'errors', tone: 'alarm',
                    items: (p) => (p && p.errors) || [],
                    title: (n) => `⛔ 错误 ${n} 条（这些条目不会执行）`,
                    row: (e) => {
                        const row = document.createElement('div');
                        row.className = 'ai-issue-row';
                        row.style.cssText = 'font-size:12px;color:#334155;padding:2px 0 2px 12px;';
                        const code = document.createElement('span');
                        code.style.cssText = 'color:#b91c1c;font-weight:600;';
                        code.textContent = `[${e.code}] `;
                        row.appendChild(code);
                        row.appendChild(document.createTextNode(String(e.message || '')));
                        return row;
                    }
                },
                {
                    id: 'parseErrors', tone: 'alarm',
                    items: (p, o) => (o && o.parseErrors) || [],
                    title: (n) => `⛔ 解析阶段剔掉的 ${n} 条`
                        + '（非法类型 / 缺身份键 / 记录不是对象 —— 它们**不会**出现在下面的记录表里）',
                    row: (e) => {
                        const row = document.createElement('div');
                        row.className = 'ai-issue-row';
                        row.style.cssText = 'font-size:12px;color:#334155;padding:2px 0 2px 12px;';
                        const code = document.createElement('span');
                        code.style.cssText = 'color:#b91c1c;font-weight:600;';
                        code.textContent = `[${e.code}] `;
                        row.appendChild(code);
                        row.appendChild(document.createTextNode(String(e.message || '')));
                        return row;
                    }
                },
                {
                    id: 'pointers', tone: 'warn',
                    items: pointerIssues,
                    title: (n, p) => {
                        const s = (p && p.summary) || {};
                        return `🔗 成员指针被拒 ${n} 条（${s.pointerRejected || 0} 条成员指针改动被拒绝，不会写入`
                            + `；其中 ${s.pointerDangling || 0} 条悬空/非法的成员指针：`
                            + '目标合成标识树上、包里都没有 —— 直接拒绝，不会写入）';
                    },
                    body: (body, plan) => appendPointerIssues(body, plan)
                }
            ]
        },
        {
            title: '② 只管提醒',
            hint: '不影响执行 —— 默认不覆盖你手填的值，只是报给你看',
            stages: [
                {
                    id: 'warnings', tone: 'warn',
                    items: (p) => (p && p.warnings) || [],
                    title: (n) => `⚠️ 警告 ${n} 条（不影响执行）`,
                    row: (w) => {
                        const row = document.createElement('div');
                        row.className = 'ai-issue-row';
                        row.style.cssText = 'font-size:12px;color:#334155;padding:2px 0 2px 12px;';
                        const code = document.createElement('span');
                        code.style.cssText = 'color:#b45309;font-weight:600;';
                        code.textContent = `[${w.code}] `;
                        row.appendChild(code);
                        row.appendChild(document.createTextNode(String(w.message || '')));
                        return row;
                    }
                },
                {
                    id: 'natureChanged', tone: 'warn',
                    items: (p) => {
                        const s = (p && p.summary) || {};
                        return one(s.natureChanged > 0, { n: s.natureChanged });
                    },
                    title: (n, p, opts) => {
                        const s = (p && p.summary) || {};
                        return (opts && opts.natureForce)
                            ? `🧬 性质不一致 ${s.natureChanged || 0} 条（已勾「以包里为准」：本次会覆盖 ${s.natureForced || 0} 处）`
                            : `🧬 性质不一致 ${s.natureChanged || 0} 条`;
                    },
                    body: (body, plan, opts) => appendNatureDiffControls(body, opts)
                },
                {
                    // 换父：**会真的执行**（不是"只报不动"）—— 标题里写死，别让它混进"提醒"里
                    id: 'moved', tone: 'sync',
                    items: (p) => {
                        const s = (p && p.summary) || {};
                        return one(s.moved > 0, { n: s.moved });
                    },
                    title: (n, p) => {
                        const s = (p && p.summary) || {};
                        return `🔀 会换父 ${s.moved || 0} 条（包的父与树上挂的父不一致`
                            + ' ⇒ **执行时真的按包换父**：应用里没有别的换父入口）';
                    },
                    body: (body, plan) => appendMoveList(body, plan)
                },
                {
                    id: 'accounts', tone: 'sync',
                    items: (p) => {
                        const a = (p && p.summary && p.summary.accounts) || null;
                        return (a && (a.matched || a.unmatched || a.conflicts.length))
                            ? one(true, a) : [];
                    },
                    title: (n, p) => {
                        const s = (p && p.summary) || {};
                        const a = s.accounts || {};
                        const names = [...new Set(((p && p.records) || []).map(r => r.accountId).filter(Boolean))]
                            .map(id => accountName(AppState, id));
                        return `🙋 归认：${a.matched || 0} 条 → ${names.join('、') || '（无）'}`
                            + (a.conflicts && a.conflicts.length
                                ? `　${a.conflicts.length} 条线索被多个账户认领（不归任何人）` : '');
                    },
                    body: (body, plan, opts) => appendAccountControls(body, plan, opts)
                }
            ]
        },
        {
            title: '③ 只记账',
            hint: '这些检查跑过了、跳过了多少 —— 不是错误',
            stages: [
                {
                    id: 'similaritySuppressed', tone: 'note',
                    items: (p) => {
                        const s = (p && p.summary) || {};
                        return one(s.similaritySuppressed > 0, { n: s.similaritySuppressed });
                    },
                    title: (n, p) => {
                        const s = (p && p.summary) || {};
                        return `🙈 已忽略 ${s.similaritySuppressed || 0} 条"不是同一件东西"的相似标题`;
                    },
                    body: (body) => body.appendChild(noteLine(
                        '① 只差数字（「联赛（1）」vs「联赛（10）」）；'
                        + '② 同一场比赛里**题号不同**的两道题（`F` vs `F2`）。'
                        + '这两种报出来只是刷屏，已跳过；真正的指纹是"同一个题号出来两个 key"。'))
                },
                {
                    id: 'unusedColumns', tone: 'note',
                    items: (p) => {
                        const s = (p && p.summary) || {};
                        return s.unusedColumns || [];
                    },
                    title: (n, p) => {
                        const s = (p && p.summary) || {};
                        return `🧾 未使用字段：${(s.unusedColumns || []).join('、')}`;
                    }
                }
            ]
        }
    ];
}

/** 一行小灰字（只记账那一类的说明） */
function noteLine(text) {
    const el = document.createElement('div');
    el.style.cssText = 'font-size:12px;color:#94a3b8;line-height:1.8;margin-left:12px;';
    el.textContent = plain(text);
    return el;
}

/** 「会换父」明细最多列几条（再多就让人去看记录表） */
const MOVE_LIST_LIMIT = 20;

/**
 * 「会换父」的明细：**从哪个父挪到哪个父**。
 *
 * 为什么必须列出来（而不是只报个数）：换父是**结构改动**（树上的位置变了）——
 * 只给数字，人只能导完自己在树里找。记录表里带 `🔀` 的那些行是同一份数据的完整清单。
 */
function appendMoveList(body, plan) {
    const moves = ((plan && plan.records) || []).filter(r => r.move);
    const box = document.createElement('div');
    box.style.cssText = 'font-size:12px;color:#334155;line-height:1.9;margin-left:12px;'
        + 'font-family:monospace;';
    for (const r of moves.slice(0, MOVE_LIST_LIMIT)) {
        const line = document.createElement('div');
        const name = (r.fields && r.fields.name) || '';
        line.textContent = `${r.extKey}${name ? `（${name}）` : ''}　`
            + `${r.move.fromName || r.move.from} → ${r.move.toName || r.move.to}`;
        box.appendChild(line);
    }
    if (moves.length > MOVE_LIST_LIMIT) {
        box.appendChild(noteLine(`…… 另有 ${moves.length - MOVE_LIST_LIMIT} 条（见记录表里带「🔀」的行）`));
    }
    body.appendChild(box);
}

/** 把三段异常报告画进统计栏（**满宽另起一行**：统计栏是 flex + wrap） */
function appendImportReport(box, plan, opts) {
    const wrapEl = document.createElement('div');
    wrapEl.className = 'ai-report';
    wrapEl.style.cssText = 'flex-basis:100%; width:100%;';
    renderSections(wrapEl, importReportSections(), plan, opts || {});
    box.appendChild(wrapEl);
}

/**
 * 「性质不一致」那一栏的两个控件：**只看这几条**（纯显示筛选）与**以包里为准**（会重算计划）。
 *
 * ⚠️ 两个开关语义完全不同（一个是"怎么看"、一个是"要不要写"），所以文案里必须说清，
 *    并且「以包里为准」要标明**不能撤回**（撤回历史不记导入）。
 */
function appendNatureDiffControls(body, opts) {
    const o = opts || {};
    // ⚠️ 这个类名是**给冒烟测试与排查用的钩子**（`.ai-nature-diff-note`）：模板统一生成
    //    `stage-body`，这里再挂一个"这一栏是什么"的名字，选择器不用按位置猜。
    body.classList.add('ai-nature-diff-note');
    const btn = document.createElement('button');
    btn.className = 'btn ai-nature-only-btn';
    btn.style.cssText = 'margin:2px 0 2px 12px;padding:1px 8px;font-size:11px;';
    btn.textContent = o.natureOnly ? '显示全部记录' : '只看这几条';
    btn.title = plain('在下面的记录表里只留"性质不一致"的那些（再点一次恢复全部）');
    btn.addEventListener('click', () => { if (o.onToggleNatureOnly) o.onToggleNatureOnly(); });
    body.appendChild(btn);

    const force = document.createElement('label');
    force.className = 'ai-nature-force';
    force.style.cssText = 'display:inline-flex;align-items:center;gap:4px;font-size:12px;'
        + 'color:#b45309;cursor:pointer;user-select:none;margin-left:8px;';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'ai-nature-force-cb';
    cb.checked = !!o.natureForce;
    cb.title = plain('勾上 = 这一次导入用**包里的性质**覆盖树上的那些不一致（只覆盖非空的，不会把值抹空）。\n'
        + '⚠️ 你手填的分类 / 年份会被顶掉，且**不能撤回**（撤回历史不记导入）—— 执行前先看记录表的'
        + '「将写入字段」。\n取消勾选 = 回到默认（只报不改）。');
    cb.addEventListener('change', () => {
        if (o.onToggleNatureForce) o.onToggleNatureForce(cb.checked);
    });
    force.appendChild(cb);
    const text = document.createElement('span');
    text.textContent = '以包里为准';
    force.appendChild(text);
    body.appendChild(force);
}

/**
 * 「归认」那一栏的直达入口。
 *
 * ⚠️ 「没匹配上」与「被多个账户认领」是两种毛病（**缺映射** vs **两条映射重复**），
 *    分成两个按钮；它们都只是**打开账户面板**（那里才列得出"是哪几条"）。
 */
function appendAccountControls(body, plan, opts) {
    const a = (plan && plan.summary && plan.summary.accounts) || {};
    if (a.unmatched) {
        const btn = document.createElement('button');
        btn.className = 'btn';
        btn.style.cssText = 'margin:2px 0 2px 12px;padding:1px 8px;font-size:11px;';
        btn.textContent = `⚠️ ${a.unmatched} 条线索没匹配上 → 点这里看是哪几条`;
        btn.title = plain('打开「账户」面板：未认领的线索会按 源:字段=值 列出来（带条数），'
            + '点一行就能补映射，补完点「🔁 用当前映射重跑归认」即可，不用重新导入。');
        btn.addEventListener('click', () => { document.dispatchEvent(new CustomEvent(EVENTS.SHOW_ACCOUNTS_DIALOG)); });
        body.appendChild(btn);
    }
    if (a.conflicts && a.conflicts.length) {
        const btn2 = document.createElement('button');
        btn2.className = 'btn';
        btn2.style.cssText = 'margin:2px 0 2px 12px;padding:1px 8px;font-size:11px;';
        btn2.textContent = '去看是哪两条映射重复';
        btn2.title = plain('被多个账户认领的线索会留在账户面板里（标"被 X、Y 同时认领"）。\n'
            + '两条映射声明同一个三元组时，谁都不认领 —— 删掉一条即可。');
        btn2.addEventListener('click', () => { document.dispatchEvent(new CustomEvent(EVENTS.SHOW_ACCOUNTS_DIALOG)); });
        body.appendChild(btn2);
    }
}

// ================================================================
// 渲染：错误 / 警告
// ================================================================

/**
 * **被拒绝 / 悬空的成员指针逐条列出来**（节点信息 + 目标 + 原因 + 跳到树上）。
 *
 * 为什么不能只给计数：这两类条目的排查入口是**那个节点本身** ——
 * 要知道它叫什么、`extKey` 是什么、包里想把它指到哪、树上现在指着谁，
 * 才能判断该在「判重整理」页解绑、还是去补那个合成组头。所以每条一行、信息给全。
 *
 * 数据来源：`plan.synth.pointers`（阶段 2 的执行清单，`plan/pointers.js` 产出）：
 *   · `action: 'reject'` ⇒ 被拒绝（树上已有非空指针 / 目标是节点 id / 悬空）；
 *   · `dangling: true`  ⇒ 其中"目标不可解析"的那些（悬空 / 写成节点 id）。
 * `nodeId` 是**树上那条**记录的 id（悬空指针本身长在它身上）⇒ 有它就给「跳到树上」。
 *
 * ⚠️ 跳树只有一条路：派发 `EVENTS.REVEAL_NODE`（实现全在 `ui/revealNode.js`：
 *    切分页 / 展开祖先 / 翻页 / 滚动高亮）。这里**不 import ui 层**，也不自己展开
 *    —— 同 `ui/nodeinfo/nodeGroupActions.js` 的口径。
 *
 * ⚠️ **点这里不挂局部委托**（G8）：`data-reveal-node` 的文档级委托
 *    （`ui/nodeinfo/nodeGroupActions.js`，随 `ui/tabs.js → nodeInfoView` 装配一次）**已经覆盖全文档**。
 *    以前这里再挂一份 `wrapEl` 上的监听，两个监听都在冒泡路径上、又都不 `stopPropagation`
 *    ⇒ **一次点击派发两颗 `REVEAL_NODE`**（`revealNode` 跑两趟：两套高亮看护定时器、下游可能双刷新）。
 *    判据：`scripts/smoke/reveal-node.smoke.mjs` 钉住"点一次只派发一颗"。
 */
export function appendPointerIssues(box, plan) {
    const all = (plan && plan.synth && plan.synth.pointers) || [];
    const rows = all.filter(p => p && (p.action === 'reject' || p.dangling));
    if (!rows.length) return;

    const wrapEl = document.createElement('div');
    wrapEl.className = 'ai-pointer-issues';
    // 满宽另起一行（统计栏是 flex + wrap）
    wrapEl.style.cssText = 'flex-basis:100%; width:100%; margin-top:6px; padding:6px 8px;'
        + ' background:#fffbeb; border:1px solid #fde68a; border-radius:4px;'
        + ' color:#78350f; font-size:12px; line-height:1.8;';

    for (const p of rows) {
        const node = (AppState.nodes || {})[p.nodeId] || null;
        const line = document.createElement('div');

        // ① 是哪一条：包里第几条 + 树上那个节点的名字/类型
        const name = node && node.name ? String(node.name) : '';
        const kind = node && node.type ? `[${node.type}]` : '';
        line.appendChild(document.createTextNode(
            `· 包里第 ${p.index} 条　${name}${kind} `.replace(/\s+$/, '')));

        // ② 身份：`extKey`（排查靠它，用等宽好复制）
        const keyEl = document.createElement('code');
        keyEl.textContent = p.extKey || '(无 extKey)';
        keyEl.style.cssText = 'padding:0 3px; background:#fef3c7; border-radius:3px;';
        line.appendChild(keyEl);

        // ③ 目标 + 树上现值（"想改成谁" vs "现在指着谁"）
        line.appendChild(document.createTextNode(
            ` → 目标「${p.synthKey}」`
            + (p.current ? `；树上现值「${p.current}」` : '；树上现值为空')));

        // ④ 原因（预览里不渲染 markdown ⇒ 去掉强调符）
        const why = String(p.reason || '').replace(/\*\*/g, '');
        if (why) {
            const whyEl = document.createElement('div');
            whyEl.style.cssText = 'margin-left:14px; color:#92400e;';
            whyEl.textContent = why;
            line.appendChild(whyEl);
        }

        // ⑤ 超链接：跳到树上那一条（没有它就在包里核对）
        const act = document.createElement('div');
        act.style.cssText = 'margin-left:14px;';
        if (p.nodeId) {
            const a = document.createElement('a');
            a.href = '#';
            a.dataset.revealNode = p.nodeId;
            a.textContent = '🔎 跳到树上';
            a.title = plain(`在树上定位并高亮这个节点（id ${p.nodeId}）`);
            a.style.cssText = 'color:#1d4ed8; text-decoration:underline;';
            act.appendChild(a);
        } else {
            const span = document.createElement('span');
            span.style.cssText = 'color:#94a3b8;';
            span.textContent = '树上没有这个节点（只能在包里核对）';
            act.appendChild(span);
        }
        line.appendChild(act);
        wrapEl.appendChild(line);
    }

    // ⚠️ **这里不挂局部委托**（G8）：`data-reveal-node` 的文档级委托已经全局生效
    //    （`ui/nodeinfo/nodeGroupActions.js`，由 `ui/tabs.js → nodeInfoView` 装配）。
    //    再挂一份 = 同一次点击派发两颗 `REVEAL_NODE`（见本函数文件头那段）。
    box.appendChild(wrapEl);
}

// ================================================================
// 渲染：记录表
// ================================================================

/**
 * 一条记录上的"性质不一致"标记 —— 表格里那一列的文案 + 悬停解释。
 *
 * 口径：`plan.js` 的 `natureDiffOf()` 只报"两边都非空且不同"（树上是空的、包里判出来了
 * 是**正常补全**，不算差异）。这里只负责把它**写成一行人话**。
 */
