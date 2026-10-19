// ================================================================
// 冒烟测试用最小 DOM 桩（scripts/smoke/dom.mjs）
// 职责：让不依赖真实浏览器的 UI 接线代码可以在 Node 里跑起来
// 说明：
//   - 支持 class 查询、子节点树、innerHTML 清空语义、textContent
//   - 支持把 DOM 树序列化成 HTML 字符串（用于断言渲染结果）
//   - document 级事件是**可用的**（便于测事件驱动流程），元素 `click()` 会冒泡
//   - 同时安装内存版 indexedDB（见 ./idb.mjs），否则 execute() 写盘会失败
//   - `innerHTML` **默认仍不解析**（保持既有用例的 serialize 语义）：
//     已知边界：不解析 innerHTML 字符串，因此由 innerHTML 渲染出的元素
//     查不到（例如 renderTree 产生的 .node-box）。
//     需要跑"真实弹窗路径"的用例可以 `installDom([], { parseHtml: true })`
//     打开一个极简解析器 —— 那时 innerHTML 会被建成真实元素树，
//     因此 serialize() 变成"遍历元素树"（不再原样吐出 HTML 字符串）。
// ================================================================
import { installIndexedDb } from './idb.mjs';

class El {
    constructor(tag) {
        this.tagName = tag;
        this.id = '';
        this.children = [];
        this.parent = null;
        this.style = {};
        this.dataset = {};
        this._classes = new Set();
        this._html = '';
        this._text = '';
        this._handlers = {};
        this._attrs = {};
    }

    get className() { return [...this._classes].join(' '); }
    set className(v) { this._classes = new Set(String(v).split(/\s+/).filter(Boolean)); }

    /** 第一个元素子节点（忽略文本节点），`sourceActions.js` 的 refreshPanel 要用 */
    get firstElementChild() { return (this.children || []).find(c => !c._isText) || null; }
    get lastElementChild() {
        const list = (this.children || []).filter(c => !c._isText);
        return list[list.length - 1] || null;
    }
    get childNodes() { return this.children; }

    // ---- 属性 API（createModal 会用 setAttribute/hasAttribute 设 tabindex）----
    setAttribute(name, value) {
        const n = String(name);
        const v = String(value);
        if (n === 'class') { this.className = v; return; }
        if (n === 'id') { this.id = v; registerSubtree(this); return; }
        if (n === 'selected') { this._selected = true; return; }
        if (n === 'checked') { this.checked = true; return; }
        if (n.startsWith('data-')) { this.dataset[datasetKey(n.slice(5))] = v; return; }
        (this._attrs ||= {})[n] = v;
    }
    getAttribute(name) {
        const n = String(name);
        if (n === 'class') return this.className || null;
        if (n === 'id') return this.id || null;
        if (n.startsWith('data-')) {
            const k = datasetKey(n.slice(5));
            return this.dataset && this.dataset[k] !== undefined ? this.dataset[k] : null;
        }
        return (this._attrs && this._attrs[n] !== undefined) ? this._attrs[n] : null;
    }
    hasAttribute(name) { return this.getAttribute(name) !== null; }
    removeAttribute(name) {
        const n = String(name);
        if (n === 'class') { this._classes = new Set(); return; }
        if (n === 'id') { unregisterSubtree(this); this.id = ''; return; }
        if (n.startsWith('data-')) { delete this.dataset[datasetKey(n.slice(5))]; return; }
        if (this._attrs) delete this._attrs[n];
    }

    /**
     * 与真实 DOM 一致的 `parentNode` 别名。
     *
     * 桩内部统一用 `.parent`，但**生产代码写的是 `parentNode`**（标准 API）。
     * 缺这个别名会让"取父节点"的代码拿到 undefined，
     * 进而 `tr.parentNode.insertBefore(...)` 之类抛错——
     * 表现为"正确代码在冒烟测试里静默失效"。
     */
    get parentNode() { return this.parent; }
    set parentNode(v) { this.parent = v; }

    /**
     * 与真实 DOM 一致的 `parentElement` 别名（同上）。
     * `sourceActions.js` 的 refreshPanel 写的是 `panel.parentElement` —— 缺它
     * 那条"动作后原地重绘面板"的路径会在冒烟测试里静默失效。
     */
    get parentElement() { return this.parent; }
    set parentElement(v) { this.parent = v; }

    /**
     * 控件的值。
     *
     * `<select>` 要**算**出来（真实浏览器里它就是"选中那项的 value"）；
     * 其余元素就是个普通属性。⚠️ 赋值**不触发任何事件** —— 与浏览器一致，
     * 这正是 `ui/G_modal/manualInput.js` 用 input 事件当"用户真的敲过字"的依据。
     */
    get value() {
        const tag = String(this.tagName || '').toLowerCase();
        if (tag === 'select') {
            const opts = this._query('option');
            if (!opts.length) return this._value === undefined ? '' : this._value;
            const chosen = opts.find(o => o._selected === true) || opts[0];
            // 与浏览器一致：`option` 没写 value 属性时，值就是它的文本
            return chosen._value === undefined ? textOf(chosen) : String(chosen._value);
        }
        // `<textarea>`：真实浏览器里"控件值"初始就是它的**文本内容**。
        // 桩不补这一条的话，`ta.value.split('\n')` 之类会以
        // `Cannot read properties of undefined` 挂掉 —— 而生产代码本身是对的
        // （me.json 编辑器把多行框收回模型时就会断在这儿）。
        if (tag === 'textarea' && this._value === undefined) return textOf(this);
        return this._value;
    }
    set value(v) {
        this._value = v;
        // ⚠️ `<select>` 的赋值要**真的选中对应项**（真实浏览器就是这样）：
        //    只记 `_value` 不够，getter 是按"选中项"算的 —— 于是 `sel.value = 'x'`
        //    之后读回来还是第一项，筛选/切页之类的事件处理器读到的永远是旧值
        //    （账户对比视图的冒烟就踩了这个）。
        if (String(this.tagName || '').toLowerCase() === 'select') {
            const opts = this._query('option');
            let hit = null;
            for (const o of opts) {
                const ov = o._value === undefined ? textOf(o) : String(o._value);
                if (ov === String(v)) hit = o;
            }
            for (const o of opts) o._selected = false;
            if (hit) hit._selected = true;
        }
    }

    get classList() {
        const s = this._classes;
        return {
            add: c => s.add(c),
            remove: c => s.delete(c),
            contains: c => s.has(c),
            toggle: (c, force) => {
                if (force === undefined) { s.has(c) ? s.delete(c) : s.add(c); }
                else if (force) { s.add(c); }
                else { s.delete(c); }
            }
        };
    }

    get innerHTML() { return this._html; }
    set innerHTML(v) {
        const s = String(v);
        // 打开了解析开关（installDom 的 opts.parseHtml）时，把 HTML **真的**建成元素树。
        // 必须做成开关：既有用例大量依赖"serialize 原样吐出 _html 字符串"（例如
        // `/新增 14/.test(serialize(pane))`），解析会把那段字符串换成一堆文本节点，
        // 语义相同但断言方式不同 —— 不能让它们被迫一起改。
        if (parseHtmlEnabled) {
            // ⚠️ 只注销**被替换掉的孩子**，不要注销 this 自己 ——
            //    真实浏览器里 `el.innerHTML = x` 不会让 `el` 从 `getElementById` 里消失。
            //    注销整棵子树（含 this）会让"渲染一次之后再按 id 找自己"
            //    在生产代码里对、在桩里却找不到（账户对比视图就依赖这一条）。
            for (const c of (this.children || [])) unregisterSubtree(c);
            this.children = [];
            this._html = '';
            parseHtmlFragment(s, this);
            return;
        }
        this._html = s;
        // 与浏览器一致：赋空串会清空子节点
        if (v === '') {
            for (const c of this.children) unregisterSubtree(c);
            this.children = [];
        }
    }

    get textContent() { return this._text; }
    set textContent(v) { this._text = String(v); }

    _adopt(c) {
        // 真实 DOM 里一个节点只能有一个父：挂到新父之前会先从旧父上摘下来。
        // 桩不摘的话，「单例元素换挂到新容器」这类写法会留下**幽灵引用** ——
        // 例如日志框 close() 之后，在旧容器里仍然 querySelector 得到它，
        // 于是「点框外关掉」这条断言在桩里永远失败（浏览器里其实是对的）。
        const old = c.parent;
        if (old && old !== this) old.children = old.children.filter(x => x !== c);
        c.parent = this;
        registerSubtree(c);
    }
    appendChild(c) { this.children.push(c); this._adopt(c); return c; }
    prepend(c) { this.children.unshift(c); this._adopt(c); return c; }
    insertBefore(newNode, refNode) {
        const i = refNode ? this.children.indexOf(refNode) : -1;
        if (i < 0) this.children.push(newNode);
        else this.children.splice(i, 0, newNode);
        this._adopt(newNode);
        return newNode;
    }
    after(sib) {
        const p = this.parent;
        if (!p) return;
        const i = p.children.indexOf(this);
        p.children.splice(i + 1, 0, sib);
        p._adopt(sib);
    }
    remove() {
        const p = this.parent;
        if (p) p.children = p.children.filter(c => c !== this);
        this.parent = null;
        unregisterSubtree(this);
    }
    removeChild(c) {
        const i = this.children.indexOf(c);
        if (i < 0) throw new Error('removeChild: 不是子节点');
        this.children.splice(i, 1);
        c.parent = null;
        unregisterSubtree(c);
        return c;
    }
    replaceChild(newNode, oldNode) {
        const i = this.children.indexOf(oldNode);
        if (i < 0) throw new Error('replaceChild: 不是子节点');
        this.children[i] = newNode;
        newNode.parent = this;
        oldNode.parent = null;
        unregisterSubtree(oldNode);
        registerSubtree(newNode);
        return oldNode;
    }
    /** 与真实 DOM 的 Node.contains 一致（含自身） */
    contains(node) {
        let n = node;
        while (n) {
            if (n === this) return true;
            n = n.parent;
        }
        return false;
    }
    addEventListener(type, handler) { (this._handlers[type] ||= []).push(handler); }
    removeEventListener(type, handler) {
        const list = this._handlers[type];
        if (!list) return;
        const i = list.indexOf(handler);
        if (i >= 0) list.splice(i, 1);
    }
    /**
     * 点一下。
     *
     * 走 `dispatchEvent` 而不是直接跑本地处理器：真实浏览器里点击是**冒泡**的，
     * `sourceActions.js` 的委托监听就挂在 document 上（`[data-src-act]`）。
     * 桩不冒泡的话，"点来源面板的 优先"这条路径在冒烟测试里会静默失效。
     */
    click() { this.dispatchEvent({ type: 'click' }); }
    dispatch(type) { (this._handlers[type] || []).forEach(h => h.call(this, { target: this })); }

    /**
     * 派发事件：先跑自身处理器，再沿 `parent` 冒泡，最后到 document 级监听。
     * @param {{type:string, [k:string]:*}} event
     */
    dispatchEvent(event) {
        const e = (event && typeof event === 'object') ? { ...event } : { type: String(event) };
        // ⚠️ `type` 必须显式补回来：Node 的 `new Event('change')` 把 type 放在**原型**上，
        //    展开语法拷不到自有属性 —— 于是 `e.type === undefined`，所有监听器静默不触发。
        //    （账户对比视图的冒烟就踩了这个：换了筛选框的值、事件派发了、界面却纹丝不动。）
        if (e.type === undefined && event && event.type !== undefined) e.type = event.type;
        if (!e.target) e.target = this;
        if (typeof e.preventDefault !== 'function') e.preventDefault = () => {};
        if (typeof e.stopPropagation !== 'function') e.stopPropagation = () => {};
        let node = this;
        while (node) {
            // ⚠️ `h.call(node, e)`：真实浏览器里监听器里的 `this` **就是当前节点**
            //    （currentTarget），而本项目有些处理器正是这么写的
            //    （`G3_settings.js` 的 Tab 切换用 `this.dataset.tab`）。桩若裸调用
            //    ⇒ `this === undefined` ⇒ 那些**本身正确**的接线在冒烟里以 TypeError 挂掉。
            for (const h of [...(node._handlers[e.type] || [])]) h.call(node, e);
            node = node.parent;
        }
        for (const h of [...(docListeners.get(e.type) || [])]) h(e);
        return true;
    }
    /** 记录滚动调用，便于断言"确实跳过去了"（真实布局行为无法在桩里模拟） */
    scrollIntoView(options) { (this.scrollCalls ||= []).push(options); }

    /**
     * 浅/深拷贝。
     *
     * 为什么必须有：确认类弹窗（`G2_common.js` 的 createCountdownConfirm）
     * 为了解绑旧监听会 `cloneNode(true)` 再 `replaceChild`。桩缺这个方法时，
     * 那些**本身正确**的弹窗路径会以 TypeError 挂掉 —— 表现为"冒烟里点不动"。
     */
    cloneNode(deep = false) {
        const c = new El(this.tagName);
        c.id = this.id;
        c._classes = new Set(this._classes);
        c.style = { ...this.style };
        c.dataset = { ...(this.dataset || {}) };
        c._html = this._html;
        c._text = this._text;
        c._attrs = { ...(this._attrs || {}) };
        c._value = this._value;
        c._selected = this._selected;
        c.checked = this.checked;
        c.disabled = this.disabled;
        if (deep) {
            for (const ch of (this.children || [])) {
                c.appendChild(ch && ch._isText ? { ...ch } : ch.cloneNode(true));
            }
        }
        return c;
    }
    /** 焦点：桩不模拟真实聚焦，只记录调用（生产代码常在展开表单后 focus 输入框） */
    focus() { this._focused = true; (this.focusCalls ||= []).push(true); }
    blur() { this._focused = false; }
    select() { this._selected = true; }

    querySelectorAll(sel) { return this._query(sel); }
    querySelector(sel) { return this._query(sel)[0] || null; }

    /**
     * 向上找最近的匹配祖先（含自身），与浏览器语义一致。
     *
     * 支持：标签名（`tr`）、`.class`、`[data-x]`、`[data-x="v"]`，以及它们的组合
     * （如 `tr.ai-extkey-row`）。真实浏览器里这是常用 API
     * （"从按钮找回它所在的行"），桩缺了它会让**正确代码**在冒烟测试里静默失效。
     *
     * ⚠️ 属性选择器的两个坑（症状都是"代码是对的、测试里却没反应"）：
     *   1. **不带值**的 `[data-x]`（判断"属性存在"）—— `sourceActions.js` 的委托监听
     *      就是 `closest('[data-src-act]')`；
     *   2. 带连字符的属性名 → `dataset` 用的是**驼峰键**（`data-src-act` → `srcAct`）。
     */
    closest(selector) {
        const parsed = parseSimpleSelector(selector);
        if (!parsed) return null;

        let node = this;
        while (node) {
            if (matchesSimple(node, parsed)) return node;
            node = node.parent;
        }
        return null;
    }

    /**
     * 支持的选择器子集（与 parseSimpleSelector 一致）：
     *   'tr'                         标签
     *   '.class'                     类
     *   '.class[data-attr="value"]'  类 + 数据属性
     *   '[data-attr="value"]'        仅数据属性
     *   '.a .b'                      后代（先找祖先再找后代，不支持 `>`）
     */
    _query(selector) {
        const sel = String(selector).trim();

        // 后代选择器：`.btn-row .btn` —— 弹窗里的按钮就是这么找的
        // （`G2_common.js` 的 createCountdownConfirm 找"取消"按钮）。
        // 桩不认的话 querySelector 返回 null，紧接着 `null.cloneNode` 抛错，
        // 于是**所有确认弹窗**在冒烟测试里都点不动（而它们本身是对的）。
        if (/\s/.test(sel)) {
            const parts = sel.split(/\s+/).filter(Boolean);
            const last = parts.pop();
            let roots = [this];
            for (const p of parts) {
                const next = [];
                for (const r of roots) for (const m of r._query(p)) if (!next.includes(m)) next.push(m);
                roots = next;
            }
            const out = [];
            for (const r of roots) for (const m of r._query(last)) if (!out.includes(m)) out.push(m);
            return out;
        }

        const parsed = parseSimpleSelector(sel);
        if (!parsed) return [];

        const out = [];
        const walk = n => {
            for (const c of (n.children || [])) {
                if (c._isText) continue;
                if (matchesSimple(c, parsed)) out.push(c);
                walk(c);
            }
        };
        walk(this);
        return out;
    }
}

const registry = new Map();
let bodyEl = null;

// ================================================================
// 极简选择器解析（供 _query 与 closest 共用）
//
// 支持一个**很小的子集**，够本项目用：
//   tag          如 `tr`
//   .class       如 `.ai-extkey-row`
//   #id          如 `#field-ratio`（编辑弹窗取控件就是 `panel.querySelector('#field-x')`）
//   [data-x="v"] 如 `[data-tab="main"]`
//   组合         如 `tr.ai-extkey-row`、`.btn.btn-primary`
// 不支持后代/子选择器（`a > b`、`a b`）——桩不做那么复杂的事。
// ================================================================

// ⚠️ `[data-x]`（**不带值**）也要认 —— 生产代码里的委托式监听就是这么写的
// （`sourceActions.js`: `closest('[data-src-act]')`），桩不认的话那条路径
// 在冒烟测试里会静默失效：点击"什么都没发生"，而代码本身是对的。
// ⚠️ `#id` 同样必须认：G4_edit.js 用 `panel.querySelector('#field-name')` 取值，
// 桩不认就永远拿不到节点 → 编辑弹窗路径在冒烟里根本跑不起来。
const SELECTOR_RE = /^([a-zA-Z][a-zA-Z0-9]*)?((?:[.#][^\[\].#]+)*)(?:\[data-([^=\]]+)(?:="([^"]*)")?\])?$/;

// ⚠️ `:not(...)` 也必须认：确认类弹窗（G2_common.js 的 createCountdownConfirm）
// 用 `.btn-row .btn:not(.btn-danger):not(.btn-warning)` 找"取消"按钮 ——
// 桩不认的话 `querySelector` 返回 null，紧接着 `null.cloneNode` 抛错，
// 于是**所有删除确认框**在冒烟测试里都点不动（而它们本身是对的）。
// 只支持单层的 `:not(选择器)`（本项目没用到嵌套的）。
// ⚠️ 正则必须**就地新建**：这是递归调用（`:not()` 里还能是选择器），
//    共用一个带 `g` 的模块级正则会因为内层重置 lastIndex 而无限循环（会把堆撑爆）。
const NOT_RE_SRC = ':not\\(([^()]*)\\)';

/** @returns {{tag:string|null, classes:string[], id:string|null, attr:string|undefined, attrValue:string|undefined, not:Array}|null} */
function parseSimpleSelector(selector) {
    let base = String(selector).trim();
    const nots = [];
    const notRe = new RegExp(NOT_RE_SRC, 'g');
    let nm;
    while ((nm = notRe.exec(base))) {
        const sub = parseSimpleSelector(nm[1]);
        if (sub) nots.push(sub);
    }
    base = base.replace(new RegExp(NOT_RE_SRC, 'g'), '').trim();

    const m = SELECTOR_RE.exec(base);
    if (!m) return null;
    const tag = m[1] || null;
    const classes = [];
    let id = null;
    for (const part of String(m[2] || '').split(/(?=[.#])/)) {
        if (part.length < 2) continue;
        if (part[0] === '.') classes.push(part.slice(1));
        else id = part.slice(1);            // 多个 #id 取最后一个
    }
    if (!tag && classes.length === 0 && !id && m[3] === undefined && nots.length === 0) return null;
    return { tag, classes, id, attr: m[3], attrValue: m[4], not: nots };
}

/** `data-src-act` → `srcAct`（真实浏览器的 dataset 就是驼峰键） */
function datasetKey(attr) {
    return String(attr).replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
}

/** 某个元素是否匹配解析后的选择器 */
function matchesSimple(el, parsed) {
    if (!el || el._isText) return false;
    if (parsed.not && parsed.not.some(sub => matchesSimple(el, sub))) return false;
    if (parsed.tag && String(el.tagName || '').toLowerCase() !== parsed.tag.toLowerCase()) return false;
    if (parsed.id && String(el.id || '') !== parsed.id) return false;
    if (!parsed.classes.every(cls => el._classes && el._classes.has(cls))) return false;
    if (parsed.attr !== undefined) {
        const actual = el.dataset ? el.dataset[datasetKey(parsed.attr)] : undefined;
        // 不带值 → 只要求属性存在（与真实 CSS 的 `[data-x]` 一致）
        if (parsed.attrValue === undefined) {
            if (actual === undefined || actual === null) return false;
        } else if (String(actual) !== String(parsed.attrValue)) {
            return false;
        }
    }
    return true;
}

// ================================================================
// 元素树辅助
// ================================================================

/** 一个元素（含全部后代）里带 id 的都登记进 registry；移除时反向注销 */
function registerSubtree(el) {
    if (!el || el._isText) return;
    if (el.id) registry.set(el.id, el);
    for (const c of (el.children || [])) registerSubtree(c);
}

function unregisterSubtree(el) {
    if (!el || el._isText) return;
    if (el.id && registry.get(el.id) === el) registry.delete(el.id);
    for (const c of (el.children || [])) unregisterSubtree(c);
}

/** 元素内的纯文本（含后代），用于 `<option>` 这类"没写 value 就用文本"的规则 */
function textOf(el) {
    if (!el || typeof el !== 'object') return '';
    if (el._isText) return String(el.textContent || '');
    let out = String(el._text || '');
    for (const c of (el.children || [])) out += textOf(c);
    return out;
}

// ================================================================
// 极简 innerHTML 解析（**默认关闭**，installDom({ parseHtml: true }) 才开）
//
// 目的：让"编辑弹窗"这条**真实路径**能在冒烟测试里跑起来 —— G4_edit.js 的
// 弹窗内容是用 HTML 字符串拼出来的，桩不解析就查不到 `#field-ratio`，
// 也就无法在真实弹窗上点「确定」。默认关闭是为了不改变既有用例的
// `serialize()` 语义（它们断言的是原始 HTML 字符串）。
// ================================================================

let parseHtmlEnabled = false;

const VOID_TAGS = new Set(['input', 'br', 'img', 'hr', 'meta', 'link', 'source']);

/** 极小的实体解码（够本项目用：esc 过的引号与 &） */
function decodeEntities(s) {
    return String(s)
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&');
}

/** 给解析出来的元素套属性（id / class / data-* / value / selected） */
function applyAttrs(el, attrText) {
    const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
    let m;
    while ((m = re.exec(attrText))) {
        const name = m[1];
        const value = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : ''));
        const lower = name.toLowerCase();
        if (lower === 'id') el.id = value;
        else if (lower === 'class') el.className = value;
        else if (lower === 'value') el.value = decodeEntities(value);
        // ⚠️ `type` 也要认（真实浏览器里 `input.type` 就是从属性来的）——
        //    少了它，`t.type === 'checkbox'` 这类**按控件类型分流**的代码在桩里恒为 `undefined`
        //    ⇒ 冒烟测不到那条分支（`v9.1.23` 的「带子账户」复选框就这么假红过一次）。
        else if (lower === 'type') el.type = value;
        else if (lower === 'checked') el.checked = true;
        else if (lower === 'disabled') el.disabled = true;   // 布尔属性：在就是 true
        else if (lower === 'selected') el._selected = true;
        else if (lower.startsWith('data-')) el.dataset[datasetKey(lower.slice(5))] = decodeEntities(value);
    }
}

/**
 * 把一段 HTML 建成真实元素树挂在 `parent` 下。
 * 支持：注释、普通/自闭和标签、文本、属性（引号/裸值）、void 标签。
 */
function parseHtmlFragment(html, parent) {
    const re = /<!--[\s\S]*?-->|<\/([a-zA-Z][a-zA-Z0-9]*)\s*>|<([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>|([^<]+)/g;
    const stack = [parent];
    let m;
    while ((m = re.exec(html))) {
        const [full, closeTag, openTag, attrs, selfClose, text] = m;
        if (full.startsWith('<!--')) continue;
        if (closeTag) {
            const t = closeTag.toLowerCase();
            for (let i = stack.length - 1; i > 0; i--) {
                if (String(stack[i].tagName || '').toLowerCase() === t) { stack.length = i; break; }
            }
            continue;
        }
        if (openTag) {
            const el = new El(openTag);
            applyAttrs(el, attrs || '');
            stack[stack.length - 1].appendChild(el);
            if (!VOID_TAGS.has(openTag.toLowerCase()) && selfClose !== '/') stack.push(el);
            continue;
        }
        if (text !== undefined) {
            const t = decodeEntities(text);
            if (t) stack[stack.length - 1].appendChild({ _isText: true, textContent: t, parent: null });
        }
    }
}

/** document 级事件监听表（让桩支持真实的事件链路，便于测事件驱动流程） */
const docListeners = new Map();

/** window 级事件监听表（与 document 分开维护：真实浏览器里它们是两个对象） */
const winListeners = new Map();

/** 安装全局 document/window 桩，并预建常用容器 */
export function installDom(containerIds = [], opts = {}) {
    bodyEl = new El('body');
    docListeners.clear();
    winListeners.clear();
    registry.clear();
    parseHtmlEnabled = !!opts.parseHtml;

    globalThis.document = {
        body: bodyEl,
        getElementById: id => registry.get(id) || null,
        createElement: tag => new El(tag),
        createTextNode: text => ({ _isText: true, textContent: String(text) }),
        querySelector: sel => bodyEl.querySelector(sel),
        querySelectorAll: sel => bodyEl.querySelectorAll(sel),
        addEventListener(type, handler) {
            if (!docListeners.has(type)) docListeners.set(type, []);
            docListeners.get(type).push(handler);
        },
        removeEventListener(type, handler) {
            const list = docListeners.get(type);
            if (!list) return;
            const i = list.indexOf(handler);
            if (i >= 0) list.splice(i, 1);
        },
        dispatchEvent(event) {
            const list = docListeners.get(event && event.type) || [];
            // 复制一份再遍历：监听器内部可能改动监听表
            for (const handler of [...list]) handler(event);
            return true;
        }
    };
    globalThis.window = globalThis;
    // 浏览器里有 `HTMLElement`，生产代码会用它判"content 是元素还是 HTML 字符串"
    //（`G1_core.createModal` 就是这么分的）。桩缺它 ⇒ 任何"内容用**真元素**构造"的弹窗
    // 在冒烟里必然 `ReferenceError`，而生产代码本身是对的。
    globalThis.HTMLElement = El;
    // window 是 globalThis 本身，所以给它补上与 document 对称的事件 API。
    // 真实浏览器里 window.addEventListener 是存在的（插件常用它做
    // "对话框取消"检测、resize 监听等），桩必须跟上，否则那些代码
    // 在冒烟测试里会以 TypeError 失败，而它们本身是正确的。
    globalThis.addEventListener = (type, handler) => {
        if (!winListeners.has(type)) winListeners.set(type, []);
        winListeners.get(type).push(handler);
    };
    globalThis.removeEventListener = (type, handler) => {
        const list = winListeners.get(type);
        if (!list) return;
        const i = list.indexOf(handler);
        if (i >= 0) list.splice(i, 1);
    };
    globalThis.dispatchWindowEvent = (event) => {
        const list = winListeners.get(event && event.type) || [];
        for (const handler of [...list]) handler(event);
        return true;
    };
    if (!globalThis.CustomEvent) {
        globalThis.CustomEvent = class {
            constructor(type, opts) { this.type = type; this.detail = opts?.detail; }
        };
    }
    globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
    // createModal 的 autoFocus 用 requestAnimationFrame；缺了它任何弹窗路径都会
    // 以 TypeError 挂掉（而生产代码本身是对的）。
    if (!globalThis.requestAnimationFrame) {
        globalThis.requestAnimationFrame = cb => setTimeout(() => { try { cb(0); } catch (_) {} }, 0);
        globalThis.cancelAnimationFrame = id => clearTimeout(id);
    }

    // 受限沙箱的 DOM 桩里没有 IndexedDB，但 execute() 会写盘 —— 一并装上
    installIndexedDb();

    for (const id of containerIds) {
        const el = new El('div');
        el.id = id;
        registry.set(id, el);
    }
    return bodyEl;
}

/** 取根容器（document.body） */
export function rootEl() {
    return bodyEl;
}

/** 把 DOM 树序列化成 HTML 字符串（含 textContent） */
export function serialize(el) {
    if (!el || typeof el !== 'object') return '';
    if (el._isText) return el.textContent || '';
    let out = el._html || '';
    for (const c of (el.children || [])) out += serialize(c);
    return out + (el._text || '');
}

/** 在指定父节点下建一个带 id 的 div 并登记 */
export function makeContainer(parent, id) {
    const el = new El('div');
    el.id = id;
    registry.set(id, el);
    if (parent) parent.appendChild(el);
    return el;
}

export { El };
