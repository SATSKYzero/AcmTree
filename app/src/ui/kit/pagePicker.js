// ================================================================
// 「选一个副页」共用件（ui/kit/pagePicker.js）
//
// 为什么有它（用户 2026-10-14："收成一份共用件"）：
//   同一件事在仓里散成**三份**，而且计数口径已经悄悄分叉：
//     · `ui/G_pageUI.js:getPagesList`（页签栏）      `len - 1`
//     · `ui/G_modal/G4_copy.js:getPagesList`（复制到副页）`len - 1`
//     · `ui/G_modal/G5_todoSheet.js:pageList`（挑题建页）`max(0, len - 1)`
//   外加两份各写的 `<option>` 文本、一份「＋ 新建副页」哨兵 + 它的显示/隐藏 + 读回 + 校验。
//   ⇒ 这一份收口：**列表 / 计数 / 选项文本 / 哨兵 / 接线 / 读回校验**。
//
// ⚠️ 它**只出字符串与判据**：仓里弹窗内容都是拼 `innerHTML`（`createModal({content})`），
//    所以这里不建元素 —— 两个调用点都不用改成"建元素"的写法。
// ⚠️ `wirePagePicker` **幂等**（靠 `dataset` 标记）：弹窗重开/重复接线不会叠监听。
// ⚠️ 计数口径 = **`virtualIndex` 去掉根那一个**（= 这一页有几道题），与页签栏同一个口径。
// ================================================================
import { escapeHtml } from '../../utils/html.js';

/** 「＋ 新建一个副页…」那一项的哨兵值（**唯一一份**；两个弹窗共用） */
export const NEW_PAGE_VALUE = '__new__';

/** 这一页有几个节点（去掉页内根那一项；坏数据不许出现负数） */
export function virtualNodeCountOf(page) {
    return Math.max(0, Object.keys((page && page.virtualIndex) || {}).length - 1);
}

/** 页列表（`state.pages` 的键序；字段与页签栏兼容：`{id, name, count, selected}`） */
export function pageChoicesOf(state) {
    const out = [];
    const pages = (state && state.pages) || {};
    for (const pid in pages) {
        const page = pages[pid] || {};
        out.push({
            id: pid,
            name: page.name || '',
            count: virtualNodeCountOf(page),
            selected: !!page.selected
        });
    }
    return out;
}

/** 选项那一行的文字（**只有一份**：`名称（N 个节点）`） */
export function pageOptionLabelOf(choice) {
    return `${choice.name}（${choice.count} 个节点）`;
}

/** `<option>` 串（`allowNew` ⇒ 末尾多一项哨兵） */
export function pageOptionsHtml(state, { selectedId = '', allowNew = false } = {}) {
    const opts = pageChoicesOf(state).map((c) =>
        `<option value="${escapeHtml(c.id)}"${c.id === selectedId ? ' selected' : ''}>`
        + `${escapeHtml(pageOptionLabelOf(c))}</option>`);
    if (allowNew) opts.push(`<option value="${NEW_PAGE_VALUE}">➕ 新建一个副页…</option>`);
    return opts.join('');
}

/** 「新建副页」那个名字输入框的 id（由 select 的 id 推出来，调用点别自己拼） */
export function newPageInputIdOf(selectId) {
    return `${selectId}-new-name`;
}

/** 「新建副页」那个名字输入框（默认隐藏；选中哨兵才显示） */
export function newPageNameInputHtml(inputId) {
    return `<input id="${inputId}" type="text" placeholder="新副页的名字（例：10月补题）"`
        + ' style="display:none;width:100%;padding:6px 10px;border:1px solid #d1d5db;'
        + 'border-radius:6px;font-size:13px;margin-top:6px;">';
}

const SELECT_STYLE = 'width:100%;padding:6px 10px;border:1px solid #d1d5db;border-radius:6px;'
    + 'font-size:13px;margin-top:2px;';

/**
 * 一整块"选目标副页"的 HTML（标签 + `<select>` +（`allowNew` 时）新建名输入框）。
 *
 * @param {Object} state
 * @param {Object} opts
 * @param {string} opts.selectId - 必给（调用点自己的 id；新建框的 id 由它推）
 * @param {string} [opts.label] - 标签文字
 * @param {boolean} [opts.allowNew] - 要不要「＋ 新建一个副页…」那一项
 * @param {string} [opts.selectedId] - 初始选中哪一页
 */
export function pageSelectHtml(state, { selectId, label = '目标副页', allowNew = false, selectedId = '' } = {}) {
    return `<label style="display:block;font-size:12px;color:#334155;">${escapeHtml(label)}</label>`
        + `<select id="${selectId}" style="${SELECT_STYLE}">`
        + `${pageOptionsHtml(state, { selectedId, allowNew })}</select>`
        + (allowNew ? newPageNameInputHtml(newPageInputIdOf(selectId)) : '');
}

/**
 * 接线：选到「＋ 新建一个副页…」才显示名字输入框（幂等）。
 * @returns {boolean} 真的接了一次（已经接过 ⇒ false）
 */
export function wirePagePicker(panel, { selectId }) {
    const sel = panel && panel.querySelector ? panel.querySelector(`#${selectId}`) : null;
    const input = panel && panel.querySelector ? panel.querySelector(`#${newPageInputIdOf(selectId)}`) : null;
    if (!sel || !input) return false;
    if (sel.dataset && sel.dataset.wired === '1') return false;
    if (sel.dataset) sel.dataset.wired = '1';
    sel.addEventListener('change', () => {
        input.style.display = (sel.value === NEW_PAGE_VALUE) ? 'block' : 'none';
    });
    return true;
}

/**
 * 读回并**校验**（**唯一一份**判据）。
 *
 * @returns {{isNew:boolean, pageId:string, name:string, error:string}} `error` 非空 = 不该继续
 */
export function readPagePicker(panel, { selectId }) {
    const sel = panel && panel.querySelector ? panel.querySelector(`#${selectId}`) : null;
    const input = panel && panel.querySelector ? panel.querySelector(`#${newPageInputIdOf(selectId)}`) : null;
    const value = sel ? String(sel.value || '') : '';
    const name = input ? String(input.value || '').trim() : '';
    if (value === NEW_PAGE_VALUE) {
        return { isNew: true, pageId: '', name, error: name ? '' : '新建副页要填个名字' };
    }
    if (!value) return { isNew: false, pageId: '', name: '', error: '请选择副页' };
    return { isNew: false, pageId: value, name: '', error: '' };
}
