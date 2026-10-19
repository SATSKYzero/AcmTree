// ================================================================
// 异常报告的**统一模板**（ui/kit/report.js）
//
// 一处异常报告 = **一条声明**。声明只说四件事，其余全由这里做完：
//   · `items(conf, ctx)`  —— 它有哪些条（**判据不在这里**）
//   · `title(n, conf, ctx)` —— 标题怎么写（含"这一栏在说哪条口径"）
//   · `row(it, ctx)` / `body(box, conf, ctx)` —— 一条长什么样 / 整段自己画
//   · `action`            —— 人怎么处理它；**没有 action 就是"只报不动"**
// 标题色、一键按钮、前 N 条 + 「…还有 M 个」、折叠、去标记 —— 都在这一份里。
//
// ⚠️ **四条规矩**（三个页面**同一套**：判重整理 ⑤ / 节点自动导入 / 体检·需求）：
//   ① **每一栏都在**，哪怕 0 条 —— "这一栏没有"与"这一栏根本没算"必须分得开
//      （判据漏 import / 渲染抛异常会让整段不见，看起来像"没数据"——实测踩到过）；
//   ② **默认折叠**，标题就是简要信息（计数 + 口径），点标题展开看明细；
//   ③ **展开状态跨重画保留**（每次事务都重画，不然"刚点开的又合上了"）；
//   ④ **定序 + 分段**：一屏先看到"有哪几类、各多少"，而不是"有内容的散落、没内容的消失"
//      （用户 2026-10-06："这些异常报告的位置也太乱了，我根本理不清逻辑"）。
//
// 折叠只是 `display`，**内容仍在 DOM 里**（冒烟测试按 DOM 断言，不受折叠影响）。
// ================================================================
import { mk } from '../../utils/dom.js';
import { markGoto, runWrite } from './actions.js';
// 模板自己也要用（标题去记号在模板里做）—— 与下面那条再导出是**同一个**实现
import { plain } from '../../utils/text.js';

/**
 * 语气 → 颜色。**同一个语气到处都是同一个颜色** —— 这是"看着不乱"的一半。
 *
 * 分档按**人要不要动**，不按"严不严重"：
 *   `alarm` 硬冲突（两边都硬却不一样，多半哪个来源错了）
 *   `warn`  要人动（算不出键 / 旧组头 / 导入被拒）
 *   `fix`   该换但脚本不动的（该换键）
 *   `sync`  派生量落后（组头待同步）
 *   `note`  只记账（留着也是一种选择，不该逼人动）
 *   `hint`  纯提示（已经处理好了，只是没名字之类）
 */
export const TONE = Object.freeze({
    alarm: '#b91c1c',
    warn: '#b45309',
    fix: '#7c3aed',
    sync: '#0e7490',
    note: '#64748b',
    hint: '#94a3b8'
});

/**
 * 去 Markdown 记号 —— **实现只有一份**（`utils/text.js`，与报告散文那边共用同一个）。
 *
 * ⚠️ 这些栏整段是 `textContent`，标记（`**`／反引号）必须在落界面前统一去掉，
 *    否则会当字面量漏出来（实测漏过好几次）。
 * ⚠️ **`title`（悬停提示）也要过它**：那同样是给人看的字。
 */
export { plain, plainProse } from '../../utils/text.js';

/** 一行小标题（颜色由 `TONE` 给） */
export function groupHead(text, tone = 'note', extra = '') {
    const el = mk('div', 'stage-group',
        `font-weight:600;font-size:12px;color:${TONE[tone] || TONE.note};margin:8px 0 2px;${extra}`);
    el.textContent = plain(text);
    return el;
}

/**
 * 一段**默认折叠**的内容（不带计数，给"段里再分小类"用）。
 *
 * ⚠️ "收起"这件事只写**一个地方**（`style.display` 属性），别一半写在 `cssText` 里：
 *    冒烟测试的 DOM 桩只保存 `style.cssText` 字符串、不解析出 `display`
 *    ⇒ 写在 cssText 里的隐藏状态在桩里看不见、切换逻辑会翻过来（实测踩到）。
 *
 * ⚠️ 给了 `key` ⇒ **跨重画记住展开状态**（与环节那一套共用 `OPEN_STAGES`）。
 *    没它的话，栏里**任何一次写入触发的重画**都会把这一段折回去 ——
 *    实测（用户 2026-10-08）：在 ② 里点「✓ 确认这一场」，面板当场合上，
 *    人只看到"点了一下，列表没了"，像是点错了。
 */
export function foldSection(box, label, tone = 'note', key = '') {
    const id = key ? `fold:${key}` : '';
    const body = mk('div', 'stage-fold', '');
    // ⚠️ 初始开合**用属性写**（不写进 `cssText`）：DOM 桩只解析 `style.display` 这个属性，
    //    写进 cssText 的 `display:none` 它读不到 ⇒ 桩里的开合状态会翻过来（上面那条注释踩过）。
    body.style.display = (id && OPEN_STAGES.has(id)) ? 'block' : 'none';
    if (id) body.dataset.fold = String(key);
    const head = groupHead('', tone, 'cursor:pointer;');
    // ⚠️ 开合状态只认 `body.style.display`（一个地方说了算）—— 与上面那条注释同一理由
    const draw = () => {
        head.textContent = plain(`${label}　${body.style.display !== 'none' ? '▾ 收起' : '▸ 点开'}`);
    };
    head.addEventListener('click', () => {
        const open = body.style.display !== 'none';
        body.style.display = open ? 'none' : 'block';
        if (id) { if (open) OPEN_STAGES.delete(id); else OPEN_STAGES.add(id); }
        draw();
    });
    draw();
    box.appendChild(head);
    box.appendChild(body);
    return body;
}

/** 一个"可点跳转 + 可选题面外链"的小件（异常那一栏每一处都用它，核对着用） */
export function appendNodeLink(parent, text, nodeId, href) {
    const el = mk('span', '', 'cursor:pointer;text-decoration:underline dotted;');
    el.textContent = text;
    markGoto(el, nodeId);
    parent.appendChild(el);
    if (href) {
        const a = mk('a', '', 'margin-left:4px;');
        a.setAttribute('href', String(href));
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noreferrer');
        a.textContent = '题面 ↗';
        parent.appendChild(a);
    }
}

/**
 * 没换算到节点 id 时就**老老实实当纯文本**（`appendNodeLink` 一律要求 id）。
 *
 * ⚠️ 为什么需要它：**合成节点**是**导入包之后**才在树上的；刚重建完还没导入时，
 *    那一格是空的 ⇒ 渲染成一个"点了原地不动"的假链接，比纯文本更糟
 *    （用户会以为功能坏了）。键名照旧写出来，只是不可点。
 */
export function nodeOrText(parent, text, nodeId, href = '') {
    if (nodeId) appendNodeLink(parent, text, nodeId, href);
    else parent.appendChild(document.createTextNode(String(text)));
}

/** 哪些环节现在是**展开**的（跨重画保留；只活在内存里 —— 那是看报表的姿态，不是数据） */
const OPEN_STAGES = new Set();

/** 程序化开/关一栏（页面里的"去某栏看"按钮用；`open=true` 展开、`false` 收起） */
export function setStageOpen(key, open = true) {
    if (!key) return;
    if (open) OPEN_STAGES.add(key);
    else OPEN_STAGES.delete(key);
}

/** 这一栏现在展开着吗（自测/排错用） */
export function isStageOpen(key) {
    return OPEN_STAGES.has(key);
}

/** 标题上的那个小三角（"收起"状态也由它一个地方说了算） */
const MARK = (open) => (open ? '▾' : '▸');

/** 环节上的一键按钮（"一键处理"用的；行内自己写的按钮**不**走这里） */
function actionButton(stage, items, ctx) {
    const btn = mk('button', 'btn', 'margin:4px 0 6px 12px;font-size:11px;padding:0 8px;');
    if (stage.action.title) btn.setAttribute('title', plain(stage.action.title));
    btn.textContent = plain(stage.action.label(items.length));
    btn.addEventListener('click', () => {
        runWrite((draft) => { stage.action.run(draft, items); },
            plain(stage.action.done(items.length))).catch(() => {});
    });
    return btn;
}

/**
 * 把一条"异常报告"画进 `box`（形状见文件头；`key` 是稳定标识，折叠状态按它认）。
 *
 * ⚠️ 标题与内容都挂 `data-stage="<key>"`：**折叠只是 `display`**，内容一直在 DOM 里 ——
 *    所以断言不用先展开，页面里的"去某栏看"按钮也只管把那一栏打开。
 */
export function renderStage(box, stage, conf, ctx) {
    const items = (stage.items ? stage.items(conf, ctx) : []) || [];
    const n = typeof stage.count === 'function' ? stage.count(conf, ctx) : items.length;
    const key = stage.key || stage.id || '';
    const label = stage.title ? stage.title(n, conf, ctx) : key;

    const body = mk('div', `stage-body stage-body-${key}`, 'margin-left:2px;');
    body.style.display = OPEN_STAGES.has(key) ? 'block' : 'none';
    if (key) body.dataset.stage = key;

    const head = mk('div', `stage-head stage-head-${key}`,
        'font-weight:600;font-size:12px;line-height:1.9;cursor:pointer;user-select:none;'
        + 'margin:6px 0 1px;'
        // 0 条 ⇒ 灰的：它在（看得见），但**不是警报**
        + `color:${n ? (TONE[stage.tone] || TONE.note) : TONE.hint};`);
    if (key) head.dataset.stage = key;
    const draw = () => { head.textContent = plain(`${MARK(OPEN_STAGES.has(key))} ${label}`); };
    draw();
    head.addEventListener('click', () => {
        if (OPEN_STAGES.has(key)) OPEN_STAGES.delete(key);
        else OPEN_STAGES.add(key);
        body.style.display = OPEN_STAGES.has(key) ? 'block' : 'none';
        draw();
    });
    box.appendChild(head);
    box.appendChild(body);

    if (stage.action && n) body.appendChild(actionButton(stage, items, ctx));
    if (stage.body) {
        stage.body(body, conf, ctx);
        if (stage.after) stage.after(body, conf, ctx);
        return;
    }
    const limit = stage.limit || 0;
    const shown = limit > 0 ? items.slice(0, limit) : items;
    for (const it of shown) {
        const out = stage.row ? stage.row(it, ctx) : null;
        // ⚠️ **大括号不能省**：`if (Array.isArray(out)) for (…) if (el) …; else if (out) …`
        //    里的 `else` 会挂到**最近的** `if (el)` 上（悬垂 else）⇒ 单元素的 `row`
        //    永远 append 不进去，而"标题在、行不在"这种半渲染最难看出来。
        if (Array.isArray(out)) {
            for (const el of out) if (el) body.appendChild(el);
        } else if (out) {
            body.appendChild(out);
        }
    }
    if (limit > 0 && n > limit) {
        const more = mk('div', '', 'font-size:12px;color:#94a3b8;margin-left:12px;');
        more.textContent = `… 还有 ${n - limit} 个（点上面的按钮一次处理完）`;
        body.appendChild(more);
    }
    if (stage.after) stage.after(body, conf, ctx);
}

/** 一组环节（顺序 = 数组顺序） */
export function renderStages(box, stages, conf, ctx) {
    for (const stage of stages) renderStage(box, stage, conf, ctx);
}

/**
 * 一整段（= 一个小标题 + 它下面的几条环节）。
 *
 * 为什么要分段：十几条平铺出来**没有逻辑**，人得逐条读才知道哪几条在说同一件事。
 * 分段之后一眼看到的是**几类**（要人判的 / 一键能处理的 / 只记账的）—— 那才记得住。
 */
export function renderSections(box, sections, conf, ctx) {
    for (const sec of sections) {
        const stages = sec.stages || [];
        if (!stages.length) continue;
        if (sec.title) {
            const head = mk('div', 'stage-section',
                'font-weight:700;font-size:12px;color:#334155;margin:12px 0 2px;'
                + 'padding-top:6px;border-top:1px solid #eef2f6;');
            head.textContent = plain(sec.title + (sec.hint ? `　—— ${sec.hint}` : ''));
            box.appendChild(head);
        }
        renderStages(box, stages, conf, ctx);
    }
}
