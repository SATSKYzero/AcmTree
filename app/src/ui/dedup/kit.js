// ================================================================
// 判重页的小工具（ui/dedup/kit.js）
//
// 职责：类型名 / 常量 / 配方块 / 输入控件 / 分页器 /
// 节点标签 / 跳转链接 / 一次写入（`runWrite`）。四块内容都靠它。
// ================================================================
import { pageState } from './state.js';
import { invalidateDedupCache } from './model.js';
import { SUGGEST_REASON } from '../../core/dedup.js';
import { synthKeyOf } from '../../core/ops/synth.js';
import { AppState } from '../../shell/state.js';
import { mk } from '../../utils/dom.js';
import { buildLinkBlock } from '../../view/linkChips.js';

// ★ `markGoto` / `runWrite` 已经搬到**通用区**（`ui/kit/actions.js`）——
//   因为每个页面都要用它们，而"共享模块反向 import 某个 feature"是错的方向。
//   这里**原样再导出**：判重页那十几个文件一行都不用改。
//   ⚠️ `revealNodeById`（**唯一那句"派发 REVEAL_NODE"**）也在那儿 —— 下面 `wireGotoLinks`
//      转发用的就是它，别在本文件再写一遍 `document.dispatchEvent(...)`。
export { markGoto, runWrite, revealNodeById } from '../kit/actions.js';
import { revealNodeById } from '../kit/actions.js';
// 悬停提示也是给人看的字 ⇒ 统一去 Markdown 记号（实现只有一份）
import { plain } from '../../utils/text.js';

export const TYPE_LABEL = { O: '根', W: '平台', S: '系列', C: '比赛', P: '题目', R: '提交' };

/** 每页几条（各清单各自分页） */

export const PAGE_SIZE = 25;

/**
 * 范围下拉里最多列几项（`单场比赛` 在 xcpc 上有 1220 个 C 容器）。
 * 超出的靠上面的「场次筛选」输入框缩小 —— 与「题目检索」把 facets 摊平的观感一致。
 */

export const SCOPE_OPTION_CAP = 500;

/** 依据 → 界面文案（**必须写明凭什么**，别让用户猜） */

const REASON_LABEL = {
    [SUGGEST_REASON.PROBLEM_ID]: '题号相同',
    [SUGGEST_REASON.SAME_TITLE]: '标题完全相同',
    [SUGGEST_REASON.SIMILAR]: '标题相似（仅供参考，不是同一个东西）'
};

// ---- 控件观感：**照抄「题目检索」那套**（筛选有现成的模板）----

const INPUT_CSS = 'padding:4px 8px; border:1px solid #d1d5db; border-radius:4px; font-size:13px; background:#fff;';

const LABEL_CSS = 'font-size:12px; color:#475569; white-space:nowrap;';

export const ROW_CSS = 'display:flex; align-items:center; gap:14px; flex-wrap:wrap;';

/**
 * 判重页的**页面级状态**（跨挂载保留；数据变了也不清 —— 用户挑的范围不该被一次导入冲掉）。
 *
 * ⚠️ 与 `pageState`（页码）分开：`invalidateDedupCache()` 会把页码归零，
 *    但**不动这里** —— 那是"数据变了"，不是"用户改主意了"。
 */

export function nodeLabel(node) {
    if (!node) return '（已不存在）';
    const key = synthKeyOf(node);
    if (key) return `🧩 合成 · ${node.name || node.id}（${key}）`;
    const type = TYPE_LABEL[node.type] || node.type || '?';
    const ext = String(node.extKey || '').trim();
    // ⚠️ 没名字时**别退回显示节点 id**（`n_475880_munqybk3` 那种，看着像乱码）：
    //    如实写「（没名字）」，
    //    标识就在后面括号里，够定位了。
    const name = String(node.name || '').trim() || '（没名字）';
    return `${type} · ${name}${ext ? `（${ext}）` : ''}`;
}

// ================================================================
// 核对用的两个跳转（各界面都放可点链接，便于核对）
// ——**两处都复用现成实现，不另造一套**：
//
//   · **源站链接**：`view/linkChips.js` 的 `buildLinkBlock()`（节点信息面板上那一整块
//     「🔗 链接 (N)」，按类别折叠）—— 判重页只是把它塞进每一行；
//   · **跳到树上**：承载 = `data-reveal-node`（`markGoto` 挂的**唯一那一份**）⇒
//     全局那条文档级委托（`ui/nodeinfo/nodeGroupActions.js`）本来就能接住；
//     本页另有一条**薄兼容**委托（下面 `wireGotoLinks`，为了让 `<label>` 不勾上勾选框、
//     以及老的 `data-goto` 标记还能点）——**它只转发**，派发实现只有 `revealNodeById` 一份。
//     `ui/revealNode.js` 负责切页/展开祖先/滚动/高亮 —— 于是**本页不 import ui 层**。
//
// ⚠️ 跳转用**事件委托**（标记 + 页面根上一个 listener）：这一页整块重画
//    很频繁（勾选、切栏都会 `redraw()`），逐个元素挂 listener 会随行数线性增长。
// ================================================================

/** 一行的「🔗 链接 (N)」块（复用节点信息面板那块组件；没链接就不占位） */

export function linkBlockOf(nodeId, css = '') {
    const node = (AppState.nodes || {})[nodeId];
    if (!node) return null;
    const html = buildLinkBlock(AppState, node);      // 一个链接都没有时返回空串
    if (!html) return null;
    const span = mk('span', 'dedup-links', css);
    span.innerHTML = html;
    return span;
}

/**
 * `data-reveal-node` 的**页面级兼容委托**（判重页根挂一次）。
 *
 * ★ **承载只有一份**：`markGoto` 挂的是 `data-reveal-node`，全局那条文档级委托
 *   （`ui/nodeinfo/nodeGroupActions.js`，随 `ui/tabs.js → nodeInfoView` 装配一次）
 *   本来就能接住它。这里留着是为了两件事，所以叫**薄兼容**：
 *     ① 判重页那一行是 `<label>` —— 点名字必须 `preventDefault()`，
 *        否则会**顺带勾上勾选框**（表格里的 `<a>` 天然不会触发表单控件的激活行为，这里是个 `<span>`）；
 *     ② `data-goto` 是**行为钩子**（本页的冒烟按它断言）⇒ 老标记还要能点。
 *   ⚠️ 它**只转发、不自己派发**：转发到 `revealNodeById`（唯一那一句）。
 *   ⚠️ 必须 `stopPropagation()`：不拦的话同一次点击会**再冒泡到 document** 上那条
 *      文档级委托 ⇒ 派发**两颗** `REVEAL_NODE`（`revealNode` 跑两趟）。
 *
 * @param {HTMLElement} root - 页面根（这一页整块重画很频繁，逐个元素挂 listener 会随行数线性增长）
 */
export function wireGotoLinks(root) {
    if (!root || typeof root.addEventListener !== 'function') return;
    root.addEventListener('click', (e) => {
        // ⚠️ 分两次 `closest`（**不要**写 `'[a], [b]'` 那种逗号选择器）：
        //    DOM 桩的 `closest` 只认**单个**简单选择器（`scripts/smoke/dom.mjs` 的文件头写着），
        //    逗号选择器在桩里恒为 null ⇒ 这条路径在冒烟里静默失效。
        const el = e.target && typeof e.target.closest === 'function'
            ? (e.target.closest('[data-reveal-node]') || e.target.closest('[data-goto]'))
            : null;
        if (!el || (root.contains && !root.contains(el))) return;
        // ⚠️ 必须 `preventDefault()`：③ 的每一行是 `<label>`，不拦的话点名字会**顺带勾上勾选框**
        //（表格里的 `<a>` 天然不会触发表单控件的激活行为，但这里的名字是个 `<span>`）。
        e.preventDefault();
        e.stopPropagation();
        // 承载认 `data-reveal-node`（`markGoto` 挂的那个）；`data-goto` 只是兼容兜底
        revealNodeById(el.getAttribute('data-reveal-node') || el.dataset.goto || '');
    });
}

/** 一个小按钮 */

export function button(label, style, onClick) {
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.type = 'button';
    btn.textContent = label;
    btn.style.cssText = style || 'font-size:12px;padding:2px 10px;margin-left:8px;';
    btn.addEventListener('click', onClick);
    return btn;
}

// ================================================================
// 控制栏的小控件 —— **观感照抄 `features/ProblemSearch/index.js`**（一级 tab 栏的
// 『题目检索』）。刻意不 import 它：`ui/` 不依赖 `features/`
// （那是插件），而这一页要能在冒烟测试里独立跑。所以样式与交互逐条对齐，不另起一套。
// ================================================================

/** 标签 + 控件（与题目检索的 `field` 同款） */

export function field(labelText, control) {
    const wrap = mk('label', '', 'display:flex; align-items:center; gap:6px;');
    const span = mk('span', '', LABEL_CSS);
    span.textContent = labelText;
    wrap.appendChild(span);
    wrap.appendChild(control);
    return wrap;
}

/**
 * 文本框 +（可选）**候选提示**。
 *
 * `suggestions` 走原生 `<datalist>` —— **只提示、不禁手输**（能存的值由写路径挡，
 * 不在这里替人做键盘警察）。用来提示那些"合法但想不起来该怎么写"的值：
 * 赛季的 `无`、两个字段的 `待同步` / `不确定`（以后有用）。
 *
 * ⚠️ `datalist` 必须**在文档里**才生效，所以带提示时返回的是 `输入框 + datalist` 的
 *    `<span>` 包一层（不带提示时仍然只返回输入框本身，省一层没用的节点）。
 * ⚠️ id 按**调用顺序**发号：同一页可能同时有填充条与别的表单，写死 id 会撞。
 */

let fillSuggestionsSeq = 0;

export function textInput(value, placeholder, onInput, width = '130px', suggestions = []) {
    const el = document.createElement('input');
    el.type = 'text';
    el.className = 'dedup-input';
    el.value = value || '';
    el.placeholder = placeholder || '';
    el.style.cssText = INPUT_CSS + `width:${width};`;
    // 中文输入法：合成（拼音候选）期间**不发** `onInput` —— 调用方通常会据此重画整个区块，
    // 输入框一旦被换掉，合成就当场中断（"输入一个字符就被打断"）。`compositionend` 补发最终值。
    let composing = false;
    el.addEventListener('compositionstart', () => { composing = true; });
    el.addEventListener('compositionend', () => { composing = false; onInput(el.value); });
    el.addEventListener('input', (e) => {
        if (composing || (e && e.isComposing)) return;
        onInput(el.value);
    });
    if (!suggestions.length) return el;

    fillSuggestionsSeq += 1;
    const listId = `dedup-fill-suggest-${fillSuggestionsSeq}`;
    el.setAttribute('list', listId);
    const dl = document.createElement('datalist');
    dl.id = listId;
    for (const s of suggestions) {
        const o = document.createElement('option');
        o.value = s;
        dl.appendChild(o);
    }
    const wrap = document.createElement('span');
    wrap.style.cssText = 'display:inline-flex;align-items:center;';
    wrap.appendChild(el);
    wrap.appendChild(dl);
    return wrap;
}

export function selectControl(options, value, onChange) {
    const el = document.createElement('select');
    el.className = 'dedup-select';
    el.style.cssText = INPUT_CSS + 'cursor:pointer;max-width:420px;';
    for (const opt of options) {
        const o = document.createElement('option');
        o.value = opt.value;
        o.textContent = opt.label;
        if (opt.value === value) o.selected = true;
        el.appendChild(o);
    }
    el.addEventListener('change', () => onChange(el.value));
    return el;
}

/**
 * 多选芯片组（与题目检索的 `chipGroup` 同款观感）。
 *
 * ⚠️ class 用 `dedup-chip` 而**不是** `btn`：判重页既有冒烟用 `.btn` 找操作按钮，
 *    控制栏要是也挂 `.btn`，"这一行里没有按钮"那类断言会被无关的芯片污染。
 */

export function chipGroup(options, selected, onChange, extraCss = '') {
    const wrap = mk('div', '', 'display:flex; flex-wrap:wrap; gap:4px;' + extraCss);
    for (const opt of options) {
        const on = selected.includes(opt.value);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'dedup-chip' + (on ? ' dedup-chip-on' : '');
        btn.dataset.value = opt.value;
        btn.textContent = opt.label;
        // 带专门说明的选项（分组芯片）用它的说明当 title；其余仍是"点击选中/取消"
        btn.title = plain(opt.title || (on ? '点击取消' : '点击选中'));
        btn.style.cssText = `padding:2px 8px; border:1px solid ${on ? '#2563eb' : '#d1d5db'};`
            + ` border-radius:10px; font-size:12px; cursor:pointer;`
            + ` background:${on ? '#2563eb' : '#fff'}; color:${on ? '#fff' : '#475569'};`;
        btn.addEventListener('click', () => {
            const next = on ? selected.filter(v => v !== opt.value) : [...selected, opt.value];
            onChange(next);
        });
        wrap.appendChild(btn);
    }
    return wrap;
}

/**
 * 一个 nature 芯片选项。
 *
 * 分类是不定层路径 ⇒ **没有"筛选分组"**：分类按前缀匹配，
 * "省赛或邀请赛"那种并集分组随大类/小类一起退场 ⇒ 这里只剩原样返回。
 * 保留这个函数是因为调用点（② 的控制栏）按它取值，将来若要再加"组合筛"就在这里加。
 */

export function natureChipOption(opt) {
    return { value: opt.value, label: opt.label };
}

/** 一段小字提示 */

export function hint(text, css = 'font-size:12px;color:#64748b;') {
    const el = mk('span', '', css);
    el.textContent = text;
    return el;
}

/** 树序的节点 id（`childOrder` 一趟预序；走不到的最后补上，别静默丢） */

export function pager(total, page, key, redraw) {
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const cur = Math.min(Math.max(page, 1), pages);
    const bar = mk('div', 'dedup-pager', 'display:flex;align-items:center;gap:8px;font-size:12px;color:#64748b;margin:2px 0 8px;');
    if (pages <= 1) return bar;

    bar.appendChild(button('◀ 上一页', 'font-size:12px;padding:2px 10px;', () => {
        if (pageState[key] <= 1) return;
        pageState[key] -= 1;
        redraw();
    }));
    const info = mk('span');
    info.textContent = `第 ${cur} / ${pages} 页（共 ${total} 条）`;
    bar.appendChild(info);
    bar.appendChild(button('下一页 ▶', 'font-size:12px;padding:2px 10px;', () => {
        if (pageState[key] >= pages) return;
        pageState[key] += 1;
        redraw();
    }));
    return bar;
}

/** 取当前页的切片 */

export function slice(list, key) {
    const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    const cur = Math.min(Math.max(pageState[key], 1), pages);
    pageState[key] = cur;
    const start = (cur - 1) * PAGE_SIZE;
    return list.slice(start, start + PAGE_SIZE);
}

// ================================================================
// 写操作
// ================================================================

/** ① 归入一个**已有的**合成节点 */

export function reasonText(cand) {
    const label = REASON_LABEL[cand.reason] || String(cand.reason || '');
    if (cand.reason === SUGGEST_REASON.SIMILAR) {
        return `依据：${label}（相似度 ${Number(cand.score || 0).toFixed(2)}）`;
    }
    return `依据：${label}${cand.evidence ? `（${cand.evidence}）` : ''}`;
}

/** ② 推荐（只是提示；一键「归入」/「新建合成节点并归入」） */
