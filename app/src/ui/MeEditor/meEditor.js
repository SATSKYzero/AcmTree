// ================================================================
// `me.json` 编辑器（ui/MeEditor/meEditor.js）
//
// me.json 编辑器：JSON 与表单两种改法（像 vsc 的设置那种）。
//
// 一份文件、两个视图，**共用同一个草稿**：
//   表单 → JSON：把表单当前值序列化出来（切过去看到的就是"草稿"）
//   JSON → 表单：解析文本重建表单；**解析不了就不切**（免得表单被清空、用户以为改没了）
// 保存只有一个出口：「💾 保存到 me.json」（PUT 整份文本 + 载入时那份 sha256）。
//
// ⚠️ 两条不能忘的：
//   ① 凭据**直给真值**（页面隐藏 cookie 之类的没有必要；
//      接口只对本机回环 Origin 放行，且写回仍有三道闸：路径写死 / 写前备份 / sha 冲突拒绝）；
//   ② 这是**磁盘上的配置文件**，不是应用数据：不走 `execute/undo`、不进历史、不进导出；
//   ③ 有未保存改动时关掉设置面板 = 丢掉，所以面板里显眼地标「⏳ 未保存」。
//
// 实现上只做一件事把"元素 ↔ 模型"绑死：渲染完立刻按**渲染顺序**并行走一遍
// （`bindGroup`），把每个 `.me-node` / `.me-record` 挂到对应模型节点上（`__el` / `__el`）。
// 之后所有增删改都靠 `el.__node` 直接取，不用按索引猜 —— 表单小，重渲染最省心。
// ================================================================
import { escapeHtml } from '../../utils/html.js';
import { KIND, ENTRY_TYPES, buildFormModel, collectFormModel, ensureRecordColumn, nodeFromEntry, pendingEntry, recordItemOf, summarize } from './meForm.js';
import { probeMeApi, fetchMe, saveMe, mtimeText } from './meApi.js';
import { createAuthPanel } from './authPanel.js';
const INPUT = 'width:100%;padding:5px 8px;border:1px solid #d1d5db;border-radius:6px;'
    + 'font-size:13px;margin-top:2px;box-sizing:border-box;';
const MONO = 'font-family:Consolas,Menlo,monospace;font-size:12px;line-height:1.5;';
const LABEL = 'font-size:12px;color:#334155;font-weight:600;';
const HINT = 'font-size:11px;color:#94a3b8;';
const BTN_MINI = 'padding:1px 7px;font-size:11px;';

/**
 * 元素子节点（**不含文本节点**）。
 *
 * 为什么不用 `Array.from(el.children)`：真实 DOM 的 `children` 本来就只含元素，
 * 但冒烟测试用的 DOM 桩（`scripts/smoke/dom.mjs`）把它做成了"含文本节点的
 * `childNodes`" —— 文本节点上没有 `classList`/`dataset`，直接用会以
 * `Cannot read properties of undefined (reading 'contains')` 挂掉，
 * 而生产代码本身是对的（实测踩到：整个设置页渲染到一半抛错）。
 */
const childElements = (el) => Array.from((el && el.children) || []).filter((c) => c && c.classList);

/**
 * 建一个 me.json 编辑器（挂进设置面板）。
 *
 * @param {HTMLElement} panel - 设置面板根元素（内含 `#settings-tab-me`）
 * @param {{toast?:Function, fetchImpl?:Function}} [opts]
 * @returns {{activate:Function, dirty:Function, dropIfDirty:Function}}
 */
export function createMeEditor(panel, opts = {}) {
    const toast = opts.toast || (() => {});
    const fetchImpl = opts.fetchImpl || globalThis.fetch;
    const host = panel.querySelector('#settings-tab-me');
    if (!host) return { activate() {}, dirty: () => false, dropIfDirty() {} };

    const state = {
        ready: false, base: '', sha256: '', path: 'me.json', mtime: 0,
        model: null, view: 'form', dirty: false
    };

    host.innerHTML = `
        <div id="me-status" style="${HINT};margin:2px 0 8px 0;"></div>
        <div id="me-auth-slot"></div>
        <div style="display:flex;gap:6px;align-items:center;margin-bottom:8px;">
            <button class="me-view-btn btn" data-view="form" style="padding:3px 10px;font-size:12px;">🧾 表单</button>
            <button class="me-view-btn btn" data-view="json" style="padding:3px 10px;font-size:12px;">{ } JSON</button>
            <span id="me-dirty" style="margin-left:auto;font-size:12px;color:#b45309;display:none;">⏳ 未保存</span>
        </div>
        <div id="me-body" style="max-height:min(62vh,760px);overflow:auto;border:1px solid #eef2f6;border-radius:8px;padding:8px;"></div>
        <div style="display:flex;gap:8px;margin-top:10px;">
            <button class="btn" id="me-reload" style="padding:4px 10px;font-size:12px;">↻ 重新载入</button>
            <button class="btn btn-primary" id="me-save" style="padding:4px 10px;font-size:12px;margin-left:auto;">💾 保存到 me.json</button>
        </div>
        <div style="${HINT};margin-top:6px;line-height:1.5;">
            me.json 是抓取脚本的<b>名册 / 凭据</b>（全项目只此一处）。
            凭据<b>原样显示</b>（本机同源页面，遮起来只是让自己多一步）——
            想清掉就把那一格删空。
            改的是磁盘上的文件 —— <b>不进历史、不能撤回</b>（要留底就自己先复制一份 me.json）。
        </div>
    `;

    const statusEl = host.querySelector('#me-status');
    const bodyEl = host.querySelector('#me-body');
    const dirtyEl = host.querySelector('#me-dirty');
    const saveBtn = host.querySelector('#me-save');
    const setStatus = (text, color = '#64748b') => { statusEl.textContent = text; statusEl.style.color = color; };
    const setDirty = (flag) => { state.dirty = !!flag; dirtyEl.style.display = state.dirty ? 'inline' : 'none'; };

    // ---------------- 渲染 ----------------
    /** 键名那一行：新加的字段键名可编辑，原有的只显示 */
    //: ↑/↓（用户 2026-10-19："me.json 表单的项上下交换"）—— 顺序就是文件里键的先后
    //: （`collectFormModel` 按模型 `children` 顺序拼对象 ⇒ 换模型顺序 = 换 JSON 里的键序）
    const moveBtns = () => `<button class="me-move btn" data-move="up" title="上移一位" style="${BTN_MINI}">↑</button>`
        + `<button class="me-move btn" data-move="down" title="下移一位" style="${BTN_MINI}">↓</button>`;

    const keyRow = (node) => `<div style="display:flex;gap:4px;align-items:center;">`
        + (node.keyEditable
            ? `<input class="me-key" value="${escapeHtml(node.key)}" placeholder="字段名" style="${INPUT}flex:1;">`
            : `<div style="${LABEL}flex:1;">${escapeHtml(node.key)}</div>`)
        + `${moveBtns()}</div>`;

    //: 待定行"类型"下拉的显示名（值本身在 `meForm.js:ENTRY_TYPES`，那是唯一一份名单）
    const ENTRY_LABEL = { auto: '自动', string: '字符串', number: '数字', boolean: '布尔', object: '对象（嵌套）' };

    const renderNode = (node) => {
        if (node.kind === KIND.ENTRY) {
            // 待定行（`＋ 新字段` 点出来的）：键名一格、值一格、类型可选，点 ✓ 才变成真节点。
            // 为什么要有它：用户 2026-10-19 要加 `years.2026 = {contestUser, contestPassword}`，
            // 而原来新加的字段直接就是文本框 ⇒ **对象在表单里造不出来**（只能切 JSON 视图）。
            const opts = ENTRY_TYPES
                .map((t) => `<option value="${t}"${(node.valueType || 'auto') === t ? ' selected' : ''}>${ENTRY_LABEL[t] || t}</option>`)
                .join('');
            return `<div class="me-node" data-kind="entry" style="display:flex;flex-wrap:wrap;gap:6px;
                align-items:flex-start;border:1px dashed #93c5fd;border-radius:8px;padding:6px;">
                <div style="flex:0 0 170px;">${keyRow(node)}</div>
                <label style="flex:1;min-width:200px;">
                    <textarea class="me-entry-value" rows="2" spellcheck="false" style="${INPUT}${MONO}"
                        placeholder="值：填 {…} 或 […] 就建成对象/数组；类型选「对象（嵌套）」时留空即建空对象">${escapeHtml(node.value || '')}</textarea>
                </label>
                <label style="flex:0 0 auto;">
                    <div style="${HINT}">类型</div>
                    <select class="me-entry-type" style="${INPUT}">${opts}</select>
                </label>
                <button class="me-entry-commit btn" style="${BTN_MINI}">✓ 建</button>
                <button class="me-del btn" style="${BTN_MINI}">✕</button>
                <div class="me-entry-error" style="flex-basis:100%;font-size:11px;color:#dc2626;"></div>
            </div>`;
        }
        if (node.kind === KIND.GROUP) {
            return `<div class="me-node" data-kind="group" style="border:1px solid #eef2f6;border-radius:8px;padding:8px;">
                <div style="display:flex;align-items:center;gap:6px;">
                    <div style="flex:1;">${keyRow(node)}</div>
                    <span style="${HINT}">${escapeHtml(summarize(node))}</span>
                    <button class="me-del btn" style="${BTN_MINI}">✕</button>
                </div>
                <div style="margin-top:6px;">${renderGroup(node, false)}</div>
            </div>`;
        }
        if (node.kind === KIND.TEXT) {
            return `<div class="me-node" data-kind="text" style="display:flex;align-items:flex-end;gap:6px;">
                <label style="flex:1;">${keyRow(node)}
                    <input class="me-value" value="${escapeHtml(node.value)}" style="${INPUT}">
                </label>
                <button class="me-del btn" style="${BTN_MINI};margin-bottom:1px;">✕</button>
            </div>`;
        }
        if (node.kind === KIND.LINES) {
            return `<div class="me-node" data-kind="lines">
                <div style="display:flex;align-items:center;gap:6px;">
                    <div style="flex:1;">${keyRow(node)}</div>
                    <span style="${HINT}">一行一条</span>
                    <button class="me-del btn" style="${BTN_MINI}">✕</button>
                </div>
                <textarea class="me-lines" rows="${Math.min(14, Math.max(3, node.values.length + 1))}"
                    style="${INPUT}${MONO}">${escapeHtml(node.values.join('\n'))}</textarea>
            </div>`;
        }
        if (node.kind === KIND.RECORDS) {
            const rows = node.items.map(renderRecord).join('');
            return `<div class="me-node" data-kind="records">
                <div style="display:flex;align-items:center;gap:6px;">
                    <div style="flex:1;">${keyRow(node)}</div>
                    <span style="${HINT}">${escapeHtml(summarize(node))}</span>
                    <button class="me-del btn" style="${BTN_MINI}">✕</button>
                </div>
                <div class="me-records" style="margin-top:4px;display:flex;flex-direction:column;gap:6px;">${rows}</div>
                <button class="me-add-record btn" style="margin-top:6px;padding:2px 8px;font-size:11px;">＋ 加一条</button>
            </div>`;
        }
        return `<div class="me-node" data-kind="raw">
            <div style="display:flex;align-items:center;gap:6px;">
                <div style="flex:1;">${keyRow(node)}</div>
                <span style="${HINT}">结构复杂，只能用 JSON 改</span>
                <button class="me-del btn" style="${BTN_MINI}">✕</button>
            </div>
            <textarea class="me-raw" rows="4" style="${INPUT}${MONO}">${escapeHtml(JSON.stringify(node.value, null, 2))}</textarea>
        </div>`;
    };

    const renderRecord = (item) => {
        const fields = item.fields.map((f) => {
            if (f.isJson) {
                // ⚠️ 对象/数组字段（v2 的 `byYear` / `mappings`）：给 JSON 框。
                //    当字符串渲染/读回会把值写成 `"[object Object]"`（真丢数据）。
                return `<label style="flex:1;min-width:200px;">
                    <div style="${HINT}">${escapeHtml(f.key)} <span title="对象/数组：只在这里改 JSON">（JSON）</span></div>
                    <textarea class="me-field me-field-json" data-field="${escapeHtml(f.key)}" rows="3"
                        style="${INPUT}${MONO}">${escapeHtml(f.value)}</textarea>
                </label>`;
            }
            if (f.isBool) {
                // 布尔列（`accounts[].active`）：勾选框，语义是「**启用**」——
                // ⚠️ **没写这个键 = 活跃**（`rosterAccounts.accountOf()` 判的是 `active === false`），
                //    所以空的也要**勾上**：勾 = 启用。读的时候必须取 `.checked`
                //    （`value` 永远是 `"on"` —— 见 `docs/ui-conventions.md` §10）。
                return `<label style="flex:0 0 auto;min-width:96px;display:flex;align-items:center;gap:5px;">
                    <input type="checkbox" class="me-field me-field-bool" data-field="${escapeHtml(f.key)}"
                        ${f.value === 'false' ? '' : 'checked'}>
                    <span style="${HINT}" title="勾上 = 启用（爬虫会抓这个账号）；不勾 = 停用（写进文件就是 active: false）">${escapeHtml(f.key)}</span>
                </label>`;
            }
            return `<label style="flex:1;min-width:110px;">
                <div style="${HINT}">${escapeHtml(f.key)}</div>
                <input class="me-field" data-field="${escapeHtml(f.key)}" value="${escapeHtml(f.value)}" style="${INPUT}">
            </label>`;
        }).join('');
        return `<div class="me-record" style="display:flex;flex-wrap:wrap;gap:6px;align-items:flex-end;
            border:1px dashed #e2e8f0;border-radius:8px;padding:6px;">${fields}
            <button class="me-del-record btn" style="${BTN_MINI}">✕</button></div>`;
    };

    const renderGroup = (group, top) => `<div class="me-group" data-top="${top ? 1 : 0}"
        style="display:flex;flex-direction:column;gap:8px;">
        ${group.children.map(renderNode).join('')}
        <button class="me-add btn" style="align-self:flex-start;padding:2px 8px;font-size:11px;">＋ 新字段</button>
    </div>`;

    /** 渲染完把"元素 ↔ 模型"绑上（顺序一致，一次并行走完） */
    function bindGroup(groupEl, group) {
        groupEl.__group = group;
        const kids = childElements(groupEl).filter((el) => el.classList.contains('me-node'));
        group.children.forEach((node, i) => {
            const el = kids[i];
            if (!el) return;
            node.__el = el;
            el.__node = node;
            if (node.kind === KIND.GROUP) {
                // ⚠️ 用后代选择器而不是 `:scope > .me-group`：渲染顺序保证"自己的那个容器"
                //    永远排在自己的后代之前，所以第一个匹配就是自己的；而 `:scope` 在
                //    冒烟测试的 DOM 桩里不被支持（会静默返回 null ⇒ 嵌套组点不动）。
                const inner = el.querySelector('.me-group');
                if (inner) bindGroup(inner, node);
            } else if (node.kind === KIND.RECORDS) {
                const list = el.querySelector('.me-records');
                const recEls = list ? childElements(list) : [];
                node.items.forEach((item, j) => {
                    if (!recEls[j]) return;
                    item.__el = recEls[j];
                    recEls[j].__item = item;
                });
            }
        });
    }

    function paint() {
        if (state.view === 'json') {
            let text;
            try {
                text = JSON.stringify(collectFormModel(state.model), null, 2);
            } catch (err) {
                toast(`表单里有问题，先修好再切 JSON：${err.message}`, 'error');
                state.view = 'form';
            }
            if (state.view === 'json') {
                bodyEl.innerHTML = `<textarea id="me-json-text" rows="24" spellcheck="false"
                    style="${INPUT}${MONO}white-space:pre;min-height:420px;">${escapeHtml(text)}</textarea>`;
            }
        }
        if (state.view === 'form') {
            bodyEl.innerHTML = renderGroup(state.model, true);
            bindGroup(bodyEl.firstElementChild, state.model);
        }
        host.querySelectorAll('.me-view-btn').forEach((btn) => {
            const on = btn.dataset.view === state.view;
            btn.style.background = on ? '#2563eb' : 'transparent';
            btn.style.color = on ? '#fff' : '#64748b';
            btn.style.border = `1px solid ${on ? '#2563eb' : '#d1d5db'}`;
        });
    }

    // ---------------- 表单 → 模型 ----------------
    /** 把 DOM 里的当前值收回模型（切视图 / 增删 / 保存前调用；不重渲染，免得打字时跳光标） */
    function syncFormToModel() {
        if (state.view !== 'form' || !state.model) return;
        syncGroup(state.model);
    }

    function syncGroup(group) {
        for (const node of group.children) {
            const el = node.__el;
            if (!el) continue;
            if (node.keyEditable) {
                const keyEl = el.querySelector('.me-key');
                if (keyEl) node.key = keyEl.value;
            }
            if (node.kind === KIND.TEXT) {
                const inp = el.querySelector('.me-value');
                if (inp) node.value = inp.value;
            } else if (node.kind === KIND.ENTRY) {
                const ta = el.querySelector('.me-entry-value');
                if (ta) node.value = ta.value;
                const sel = el.querySelector('.me-entry-type');
                if (sel) node.valueType = sel.value;
            } else if (node.kind === KIND.LINES) {
                const ta = el.querySelector('.me-lines');
                if (ta) node.values = ta.value.split('\n');
            } else if (node.kind === KIND.RAW) {
                const ta = el.querySelector('.me-raw');
                if (ta) node.value = ta.value;
            } else if (node.kind === KIND.RECORDS) {
                for (const item of node.items) {
                    const recEl = item.__el;
                    if (!recEl) continue;
                    recEl.querySelectorAll('.me-field').forEach((inp) => {
                        const field = item.fields.find((f) => f.key === inp.dataset.field);
                        if (!field) return;
                        if (inp.classList.contains('me-field-bool')) {
                            // ⚠️ 勾选框读 `.checked`（`value` 永远是 `"on"` —— `ui-conventions` §10）。
                            //    三态映射（**别把"没这个键"写成 `false`** —— 那等于替人把账号停用了）：
                            //      勾 + 文件里本来没这个键 ⇒ 保持"不写"（缺省就是启用）
                            //      勾 + 本来有 ⇒ `true`；不勾 ⇒ `false`
                            field.value = inp.checked ? (field.wasPresent ? 'true' : '') : 'false';
                            return;
                        }
                        field.value = inp.value;
                    });
                }
            } else if (node.kind === KIND.GROUP) {
                syncGroup(node);
            }
        }
    }

    /** JSON 视图里那份文本 ⇒ 文档 */
    function parseJsonView() {
        const el = bodyEl.querySelector('#me-json-text');
        if (!el) return collectFormModel(state.model);
        let doc;
        try {
            doc = JSON.parse(el.value);
        } catch (err) {
            throw new Error(`JSON 不合法：${err.message}`);
        }
        if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('顶层必须是对象');
        return doc;
    }

    // ---------------- 载入 / 保存 ----------------
    async function load() {
        setStatus('正在连本机主脚本…');
        const probe = await probeMeApi(fetchImpl);
        if (!probe.ok) {
            setStatus(`没连上本机主脚本（${probe.error}）—— 改 me.json 要它来读写磁盘。`, '#b91c1c');
            bodyEl.innerHTML = `<div style="${HINT};padding:6px;">
                用 <b>启动AcmTree.bat</b> 起服务器后，这里就能直接改 me.json 了。</div>`;
            return false;
        }
        state.base = probe.base || '';
        try {
            const got = await fetchMe(fetchImpl, state.base);
            applyLoaded(got);
            setDirty(false);
            // ★ 文件不在也**照常进可编辑状态**（服务器回 200 + 空文档，见 `meApi.fetchMe`）：
            //   新装/发布副本里 `个人数据/` 整个都还没有，这时候"读不到"不该等于"不能填"。
            setStatus(got.exists
                ? `${state.path} · 最后改动 ${mtimeText(state.mtime)} · sha ${state.sha256.slice(0, 8)}`
                : `还没有 ${state.path} —— 填好按保存就会建出来（爬虫读的就是它）`);
            paint();
            return true;
        } catch (err) {
            setStatus(`读不到 me.json：${err.message}`, '#b91c1c');
            return false;
        }
    }

    /**
     * 文档 → 表单模型（**唯一入口** —— 每次都补那几列）。
     *
     * ★ `accounts[]` 的「**是否启用**」那一列**永远在**（用户 2026-10-15："每个账户都需要是否启用的
     *   信息"）。列 = 各条键名的并集 ⇒ 谁都没写过 `active` 时那一列根本不存在，用户就没地方改
     *   （实测：这份 me.json 4 条账户，`active` 一格都没有）。
     * ⚠️ 这里点名 `active` 是"**说一件已知的事**"，不是猜键名：它是 me.json 名册的既有字段
     *   （`core/rosterAccounts.js` 的 `NON_PLATFORM_KEYS` 里有它、爬虫侧 `lib/me.py:handles()`
     *   读它、`meExport.js` 预览里还写"（已停用 ⇒ 爬虫不抓）"）。
     *   补出来的格子是**空的** ⇒ 没动过的行不会写进文件（见 `ensureRecordColumn` 的注释）。
     */
    function modelOf(doc) {
        const model = buildFormModel(doc);
        const accs = model.children.find((c) => c.key === 'accounts');
        if (accs) ensureRecordColumn(accs, 'active', 'boolean');
        return model;
    }

    function applyLoaded(got) {
        state.sha256 = got.sha256;
        state.path = got.path || 'me.json';
        state.mtime = got.mtime;
        state.model = modelOf(got.doc);
        state.ready = true;
        // ⚠️ 登录态那一块的输入框按**载入的文档**填值 ⇒ 载完之后要重画它
        //   （它在 `createMeEditor` 里先画过一次，那时还没有文档）
        if (authPanel) authPanel.paint();
        // 读/写成功后**叫一声**：设置页拿它把 me.json 投影成应用账户
        // （me.json 是账户的唯一真源，见 core/rosterAccounts.js）
        if (typeof opts.onLoaded === 'function') {
            try {
                opts.onLoaded(got.doc);
            } catch (err) {
                console.error('[me.json] 投影成账户失败:', err);
            }
        }
    }

    async function save() {
        if (!state.ready) return;
        let text;
        try {
            // ⚠️ 必须先把表单里的当前值收回模型：用户在输入框里敲的字**只活在 DOM 里**，
            //    不 sync 直接 collect 会把改动丢掉（冒烟实测：改了 handle、保存后还是旧值）。
            if (state.view === 'form') syncFormToModel();
            const doc = state.view === 'json' ? parseJsonView() : collectFormModel(state.model);
            text = JSON.stringify(doc, null, 2) + '\n';
        } catch (err) {
            toast(`没保存：${err.message}`, 'error');
            return;
        }
        saveBtn.disabled = true;
        try {
            const got = await saveMe(fetchImpl, state.base, { text, sha256: state.sha256 });
            applyLoaded(got);
            setDirty(false);
            setStatus(`${state.path} · 已保存 ${mtimeText(state.mtime)} · sha ${state.sha256.slice(0, 8)}`, '#15803d');
            paint();
            toast('me.json 已保存', 'success');
        } catch (err) {
            if (err.status === 409) {
                setStatus('磁盘上的 me.json 变过了（抓取脚本或别的窗口写过）——点「↻ 重新载入」再改。', '#b45309');
                toast('磁盘上的 me.json 变过了，这次没写', 'error');
            } else {
                setStatus(`保存失败：${err.message}`, '#b91c1c');
                toast(`保存失败：${err.message}`, 'error');
            }
        } finally {
            saveBtn.disabled = false;
        }
    }

    // ---------------- 事件 ----------------
    host.querySelectorAll('.me-view-btn').forEach((btn) => btn.addEventListener('click', () => {
        const want = btn.dataset.view;
        if (want === state.view) return;
        if (state.view === 'form') {
            syncFormToModel();
        } else {
            try {
                state.model = buildFormModel(parseJsonView());
            } catch (err) {
                toast(`JSON 有问题，先修好：${err.message}`, 'error');
                return;
            }
        }
        state.view = want;
        paint();
    }));

    host.querySelector('#me-reload').addEventListener('click', async () => {
        if (state.dirty && !globalThis.confirm('me.json 有未保存的改动，重新载入会丢掉它们。继续？')) return;
        await load();
    });
    saveBtn.addEventListener('click', save);

    bodyEl.addEventListener('input', () => setDirty(true));

    bodyEl.addEventListener('click', (ev) => {
        const target = ev.target;
        // ⚠️ 不用 `target instanceof Element`：`Element` 在冒烟测试的 DOM 桩里不存在
        //    （`ReferenceError: Element is not defined`），而点击事件在真实与桩环境里
        //    都会冒泡。改成"有没有元素接口"的能力判断，两边都对。
        if (!target || !target.classList || typeof target.closest !== 'function') return;

        if (target.classList.contains('me-del')) {
            const nodeEl = target.closest('.me-node');
            const node = nodeEl && nodeEl.__node;
            const ownerEl = nodeEl && nodeEl.parentElement;
            const group = ownerEl && ownerEl.__group;
            if (node && group) {
                syncFormToModel();
                const i = group.children.indexOf(node);
                if (i >= 0) group.children.splice(i, 1);
                setDirty(true);
                paint();
            }
            return;
        }
        if (target.classList.contains('me-move')) {
            // ↑/↓：只换**同一个父**下的兄弟位置（用户 2026-10-19："me.json 表单的项上下交换"）。
            // 先 sync 再换再重画 —— 与 `.me-del` / `.me-add` 同一条路（顺序唯一的真源是模型）。
            const nodeEl = target.closest('.me-node');
            const node = nodeEl && nodeEl.__node;
            const ownerEl = nodeEl && nodeEl.parentElement;
            const group = ownerEl && ownerEl.__group;
            if (node && group) {
                syncFormToModel();
                const i = group.children.indexOf(node);
                const j = i + (target.dataset.move === 'up' ? -1 : 1);
                if (i >= 0 && j >= 0 && j < group.children.length) {
                    [group.children[i], group.children[j]] = [group.children[j], group.children[i]];
                    setDirty(true);
                    paint();
                }
            }
            return;
        }
        if (target.classList.contains('me-add')) {
            const group = target.parentElement && target.parentElement.__group;
            if (group) {
                syncFormToModel();
                group.children.push(pendingEntry());
                setDirty(true);
                paint();
            }
            return;
        }
        if (target.classList.contains('me-entry-commit')) {
            // 「✓ 建」：把待定行变成真节点。**失败了就地红字、不重画**（重画会丢掉刚打的字）
            const nodeEl = target.closest('.me-node');
            const node = nodeEl && nodeEl.__node;
            const ownerEl = nodeEl && nodeEl.parentElement;
            const group = ownerEl && ownerEl.__group;
            if (!node || !group || node.kind !== KIND.ENTRY) return;
            syncFormToModel();
            let built;
            try {
                built = nodeFromEntry(node.key, node.value, node.valueType);
            } catch (err) {
                const errEl = nodeEl.querySelector('.me-entry-error');
                if (errEl) errEl.textContent = err.message;
                return;
            }
            const i = group.children.indexOf(node);
            if (i < 0) return;
            built.keyEditable = true;      // 建完仍可改名（与"新加的字段名可编辑"一致）
            group.children.splice(i, 1, built);
            setDirty(true);
            paint();
            return;
        }
        if (target.classList.contains('me-add-record')) {
            const node = target.closest('.me-node').__node;
            if (node && node.kind === KIND.RECORDS) {
                syncFormToModel();
                // ⚠️ 把节点上那两套"整列"信息带上：不然新加的行 `byYear` 是文本框、
                //    `active` 要人手打 `false`（写成 `"false"` 就不是停用了）。
                node.items.push(recordItemOf(node.keys || [], {}, node.jsonKeys, node.boolKeys, node.numKeys));
                setDirty(true);
                paint();
            }
            return;
        }
        if (target.classList.contains('me-del-record')) {
            const recEl = target.closest('.me-record');
            const item = recEl && recEl.__item;
            const list = recEl && recEl.parentElement;
            const node = list && list.parentElement && list.parentElement.__node;
            if (item && node) {
                syncFormToModel();
                const i = node.items.indexOf(item);
                if (i >= 0) node.items.splice(i, 1);
                setDirty(true);
                paint();
            }
        }
    });

    // ---------------- 「🔐 登录态」那一块 ----------------
    // 它在 `#me-auth-slot` 里画：**手输凭据 + 探活**。取值/落盘都走本编辑器的同一份草稿
    // （`doc()` / `setDotted()` / `save()`）—— 不开第二条写文件的路径。
    const authHost = host.querySelector('#me-auth-slot');
    const authPanel = authHost ? createAuthPanel(authHost, {
        toast,
        doc: () => currentDoc(),
        base: () => state.base,
        fetchImpl,
        // ⚠️ **输入时就会调它** ⇒ 这里**不 paint()**：重画会重建输入框、光标跳、正在敲的字会丢
        //    （登录态那一块的输入框由它自己按需重画）。要重画的调用点自己 `paint()`。
        setDotted: (path, value) => {
            const doc = currentDoc();
            setDottedValue(doc, path, value);
            state.model = modelOf(doc);
            setDirty(true);
        },
        isDirty: () => state.dirty,
        save: () => save(),
        ready: () => state.ready
    }) : null;

    /** 当前草稿（表单视图先按 DOM 收回模型 —— 与 `save()` 同一条纪律） */
    function currentDoc() {
        if (!state.ready) return {};
        try {
            if (state.view === 'form') {
                syncFormToModel();
                return collectFormModel(state.model);
            }
            return parseJsonView();
        } catch (err) {
            return collectFormModel(state.model);
        }
    }

    return {
        activate: () => { if (!state.ready) load(); },
        dirty: () => state.dirty,
        /** 关面板前提醒一句（草稿留在内存里，重开设置还在；刷新页面才真丢） */
        dropIfDirty: () => { if (state.dirty) toast('me.json 的改动没保存（重新打开设置还在）', 'error'); },
        // 给「🔐 登录态」那块与自测用：
        doc: currentDoc,
        authPanel
    };
}

/**
 * 往草稿里写一格点分路径（`qoj.cookie` / `clist.apiKey`）。
 *
 * ⚠️ **路径上遇到不是对象的一律就地改成对象**（用户刚把一个组删了、又在登录态那块敲了值
 * ⇒ 宁可补一个空组，也不静默丢掉他敲的字）。
 */
export function setDottedValue(doc, path, value) {
    const parts = String(path || '').split('.').filter(Boolean);
    if (!parts.length || !doc || typeof doc !== 'object') return doc;
    let cur = doc;
    for (let i = 0; i < parts.length - 1; i++) {
        if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object' || Array.isArray(cur[parts[i]])) {
            cur[parts[i]] = {};
        }
        cur = cur[parts[i]];
    }
    const last = parts[parts.length - 1];
    if (value === '' || value === null || value === undefined) delete cur[last];
    else cur[last] = String(value);
    return doc;
}

/** 按点分路径读一格（读不到 / 那一格不是字符串 ⇒ 空串） */
export function dottedValue(doc, path) {
    let cur = doc;
    for (const part of String(path || '').split('.')) {
        if (!part) continue;
        if (!cur || typeof cur !== 'object') return '';
        cur = cur[part];
    }
    return (cur === undefined || cur === null || typeof cur === 'object') ? '' : String(cur);
}
