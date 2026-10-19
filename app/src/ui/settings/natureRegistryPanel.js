// ================================================================
// 「🧬 性质注册表」那一栏（`ui/settings/natureRegistryPanel.js`）
//
// 它编辑的是**磁盘上那份规则文件** `acm-data/nature-registry.json`
// （`scripts/crate.py` 与 `core/natureFields.js` 都读它）—— 与 me.json 那一栏同一条边界：
//   · 页面写不了磁盘 ⇒ 走本机主脚本的 `GET/PUT /api/nature-registry`；
//   · **唯一真源不搬家**：应用不存第二份、也不缓存它（读的永远是从服务器拿回来的那份）；
//   · 形状判据在服务器侧（`scripts/nature_registry_lib.py`）—— 这里只做"早点告诉人"的检查
//     （重名 / 带 `/` / 正则编不出来），**不替代**那道闸。
//
// ⚠️ 保存之后**必须**告诉人两件事（写在卡片里，别只放在日志）：
//   ① **刷新页面** —— `core/natureFields.js` 是在**模块求值期**读这份注册表的，
//      不刷新的话界面上还是旧词表（选择器里那几个分类不会变）；
//   ② **重建总包** —— `scripts/crate.py` 在链上读它，词表变了要重出包才落到数据里。
// ================================================================
import { AppState } from '../../shell/state.js';
import { viewDerivedDisplay, viewValue } from '../../view/scope.js';
import { NATURE_FIELD_KEYS } from '../../core/natureFields.js';
import { escapeHtml } from '../../utils/html.js';
import { showToast } from '../G_modal/G1_toast.js';
import { fetchRegistry, mtimeText, probeRegistryApi, saveRegistry } from './natureRegistryApi.js';
import {
    addChild, isSpecial, leafPaths, listRows, moveAt, patchField, pathText, patternProblem,
    readAt, removeAt, renameAt, SPECIAL_LEAVES
} from './natureRegistryTree.js';

/** 服务器接口版本要到这一版才认这条路由（`scripts/devserver/http_handler.py` 的 `API_VERSION`） */
const NEED_API = 7;

const HINT = 'font-size:11px;color:#94a3b8;line-height:1.6;';
const INPUT = 'padding:2px 6px;font-size:12px;border:1px solid #cbd5e1;border-radius:5px;';
const MINI = 'padding:1px 6px;font-size:11px;line-height:1.6;';

/**
 * 每一条分类有多少节点在用（**按前缀数**：`xcpc/icpc` 也把更深的算进去）。
 *
 * ⚠️ 读值走**显示列**（`viewDerivedDisplay(...) ?? viewValue(...)`）—— 与统计页同一份口径。
 */
export function usageFromState(state = AppState) {
    const out = new Map();
    const nodes = Object.values((state && state.nodes) || {});
    for (const node of nodes) {
        const cls = String(viewDerivedDisplay(state, node, 'natureClass')
            ?? viewValue(state, node, 'natureClass') ?? '').trim();
        if (!cls) continue;
        const parts = cls.split('/').filter(Boolean);
        for (let i = 1; i <= parts.length; i++) {
            const key = parts.slice(0, i).join('/');
            out.set(key, (out.get(key) || 0) + 1);
        }
    }
    return out;
}

/**
 * 开一张性质注册表面板（挂进设置页那一栏）。
 *
 * @param {HTMLElement} host
 * @param {{fetchImpl?:Function, toast?:Function, usageOf?:Function}} [opts]
 *        `usageOf()` 给"每层有多少节点"（自测可注入；默认数 `AppState`）
 */
export function createNatureRegistryPanel(host, opts = {}) {
    const toast = opts.toast || showToast;
    const fetchImpl = opts.fetchImpl || globalThis.fetch;
    const usageOf = opts.usageOf || (() => usageFromState(AppState));

    const state = {
        ready: false,
        base: '',
        path: '',
        sha256: '',
        mtime: 0,
        doc: null,              // 草稿（编辑都先落在这份上）
        usage: new Map(),       // 分类路径 → 用它的节点数
        open: new Set(),        // 展开着的分类路径
        editing: '',            // 正在改名的路径（`''` = 没有）
        adding: '',             // 正在给哪个分类加子分类（`''` = 没有）
        dirty: false,
        busy: false
    };

    host.innerHTML = `
        <div id="nr-status" style="${HINT};margin:2px 0 8px 0;"></div>
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:8px;">
            <button class="btn" id="nr-reload" style="${MINI}">↻ 重新载入</button>
            <button class="btn" id="nr-expand" style="${MINI}">展开根那一层</button>
            <span id="nr-dirty" style="margin-left:auto;font-size:12px;color:#b45309;display:none;">⏳ 未保存</span>
            <button class="btn btn-primary" id="nr-save" style="${MINI}">💾 保存到 nature-registry.json</button>
        </div>
        <div id="nr-summary" style="font-size:12px;color:#475569;line-height:1.7;margin-bottom:8px;"></div>
        <div id="nr-fields" style="border:1px solid #eef2f6;border-radius:8px;padding:8px;margin-bottom:8px;"></div>
        <div id="nr-tree" style="border:1px solid #eef2f6;border-radius:8px;padding:6px;
            max-height:min(46vh,520px);overflow:auto;"></div>
        <div style="${HINT};margin-top:8px;line-height:1.7;">
            ⚠️ 保存之后还有两件事：<b>① 刷新页面</b>（应用侧那份词表是在<b>模块求值期</b>读的，
            不刷新界面上还是旧的）；<b>② 重建总包</b>（<code>crate.py</code> 在链上读它）。
            这份文件<b>在 git 里</b> —— 改坏了就 <code>git checkout -- acm-data/nature-registry.json</code>。
        </div>
    `;

    const statusEl = host.querySelector('#nr-status');
    const summaryEl = host.querySelector('#nr-summary');
    const fieldsEl = host.querySelector('#nr-fields');
    const treeEl = host.querySelector('#nr-tree');
    const dirtyEl = host.querySelector('#nr-dirty');
    const saveBtn = host.querySelector('#nr-save');

    const setStatus = (text, color = '#64748b') => {
        statusEl.textContent = text;
        statusEl.style.color = color;
    };
    const setDirty = (flag) => {
        state.dirty = !!flag;
        dirtyEl.style.display = state.dirty ? 'inline' : 'none';
    };
    const setBusy = (flag) => {
        state.busy = !!flag;
        saveBtn.disabled = state.busy || !state.ready;
    };

    // ---------------- 字段那几行 ----------------
    function paintFields() {
        const fields = (state.doc && state.doc.fields) || {};
        fieldsEl.innerHTML = Object.entries(fields).map(([key, def]) => {
            const kind = String(def.kind || '');
            const problem = kind === 'pattern' ? patternProblem(def.pattern) : '';
            const options = ['classPath', 'pattern', 'text']
                .map((k) => `<option value="${k}"${k === kind ? ' selected' : ''}>${k}</option>`).join('');
            return `<div class="nr-field" data-key="${escapeHtml(key)}"
                    style="display:flex;gap:6px;align-items:flex-end;flex-wrap:wrap;margin-bottom:6px;">
                <label style="min-width:150px;">
                    <div style="${HINT}">${escapeHtml(key)}（键名不可改：节点上的值绑的就是它）</div>
                    <input class="nr-label" data-prop="label" value="${escapeHtml(def.label || '')}"
                        style="${INPUT}width:100%;">
                </label>
                <label style="min-width:110px;">
                    <div style="${HINT}">kind</div>
                    <select class="nr-kind" data-prop="kind" style="${INPUT}">${options}</select>
                </label>
                <label style="flex:1;min-width:220px;">
                    <div style="${HINT}">pattern${
                        kind === 'pattern' ? '（这一档必须有）' : '（可选）'}</div>
                    <input class="nr-pattern" data-prop="pattern" value="${escapeHtml(def.pattern || '')}"
                        style="${INPUT}width:100%;font-family:monospace;">
                </label>
                <span class="nr-pattern-hint" style="font-size:11px;color:${problem ? '#b91c1c' : '#94a3b8'};">
                    ${problem ? escapeHtml(problem) : '✔ 能编出来'}</span>
            </div>`;
        }).join('') || `<div style="${HINT}">这份注册表里一个字段都没有 —— 那形状过不了服务器的闸。</div>`;
        // ⚠️ **就地改**（不整体重画）：打字的时候重画会把输入框换掉 ⇒ 每敲一个字丢焦点
        fieldsEl.querySelectorAll('.nr-field').forEach((row) => {
            const key = row.dataset.key;
            row.addEventListener('input', () => {
                const patch = {};
                row.querySelectorAll('[data-prop]').forEach((el) => { patch[el.dataset.prop] = el.value; });
                const hint = row.querySelector('.nr-pattern-hint');
                const kind = String(patch.kind || '');
                const problem = kind === 'pattern' ? patternProblem(patch.pattern) : '';
                hint.textContent = kind === 'pattern' ? (problem || '✔ 能编出来') : '（这一档不需要）';
                hint.style.color = problem ? '#b91c1c' : '#94a3b8';
                try {
                    state.doc = patchField(state.doc, key, patch);
                    setDirty(true);
                } catch (err) {
                    setStatus(err.message, '#b91c1c');
                }
            });
        });
    }

    // ---------------- 分类树 ----------------
    function paintTree() {
        const rows = listRows(state.doc, state.open);
        const extra = [];
        if (state.adding) extra.push(newChildRow(state.adding));
        treeEl.innerHTML = rows.map((row) => rowHtml(row)).join('') + extra.join('')
            || `<div style="${HINT}">分类树是空的。</div>`;
        const input = treeEl.querySelector('.nr-new-child') || treeEl.querySelector('.nr-rename');
        if (input) input.focus();
    }

    function newChildRow(parentPath) {
        const depth = parentPath ? parentPath.split('/').length : 0;
        return `<div class="nr-row" data-path="${escapeHtml(parentPath)}" data-new="1"
                style="display:flex;gap:6px;align-items:center;padding:2px 4px;padding-left:${8 + depth * 14}px;">
            <span style="${HINT}">新子分类</span>
            <input class="nr-new-child" style="${INPUT}flex:1;" placeholder="名字（不能带 / ）">
            <button class="btn" data-act="add-ok" style="${MINI}">✓ 加</button>
            <button class="btn" data-act="add-cancel" style="${MINI}">✕</button>
        </div>`;
    }

    function rowHtml(row) {
        const key = pathText(row.path);
        const count = state.usage.get(key);
        const tag = row.special
            ? `<span style="font-size:10px;color:#94a3b8;">（特殊：${escapeHtml(row.name)}）</span>` : '';
        if (state.editing === key) {
            return `<div class="nr-row" data-path="${escapeHtml(key)}"
                    style="display:flex;gap:6px;align-items:center;padding:2px 4px;padding-left:${8 + (row.depth - 1) * 14}px;">
                <input class="nr-rename" value="${escapeHtml(row.name)}" style="${INPUT}flex:1;">
                <button class="btn" data-act="rename-ok" style="${MINI}">✓</button>
                <button class="btn" data-act="rename-cancel" style="${MINI}">✕</button>
            </div>`;
        }
        const toggle = row.leaf
            ? '<span style="display:inline-block;width:14px;"></span>'
            : `<button class="btn nr-toggle" data-act="toggle" style="${MINI};width:18px;">${
                state.open.has(key) ? '▾' : '▸'}</button>`;
        return `<div class="nr-row" data-path="${escapeHtml(key)}"
                style="display:flex;gap:6px;align-items:center;padding:2px 4px;
                padding-left:${8 + (row.depth - 1) * 14}px;border-radius:4px;">
            ${toggle}
            <span style="font-size:12px;color:#334155;">${escapeHtml(row.name)}</span>${tag}
            <span style="font-size:11px;color:#94a3b8;">${count ? `用它的节点 ${count}` : (row.leaf ? '没人用' : `${row.children} 支`)}</span>
            <span style="margin-left:auto;display:flex;gap:3px;">
                <button class="btn" data-act="add" title="加一个子分类" style="${MINI}">＋</button>
                <button class="btn" data-act="rename" title="改名（同级顺序不变）" style="${MINI}">✎</button>
                <button class="btn" data-act="up" title="上移一格（顺序有意义：分类是有序列表）" style="${MINI}">↑</button>
                <button class="btn" data-act="down" title="下移一格" style="${MINI}">↓</button>
                <button class="btn" data-act="del" title="删掉这条" style="${MINI}">✕</button>
            </span>
        </div>`;
    }

    function apply(edit, okText = '') {
        try {
            const next = edit(state.doc);
            if (next !== state.doc) {
                state.doc = next;
                setDirty(true);
            }
            setStatus(okText || '改好了（还没写盘 —— 点右边那颗保存）');
            paintAll();
        } catch (err) {
            setStatus(err.message, '#b91c1c');
            toast(err.message, 'error');
        }
    }

    treeEl.addEventListener('click', (ev) => {
        const btn = ev.target && ev.target.closest ? ev.target.closest('[data-act]') : null;
        if (!btn || !state.ready) return;
        const act = btn.dataset.act;
        const rowEl = btn.closest('.nr-row');
        const key = rowEl ? rowEl.dataset.path : '';
        const path = key ? key.split('/') : [];
        if (act === 'toggle') {
            if (state.open.has(key)) state.open.delete(key); else state.open.add(key);
            paintTree();
            return;
        }
        if (act === 'add') {
            state.adding = key;
            state.open.add(key);
            paintTree();
            return;
        }
        if (act === 'add-cancel') {
            state.adding = '';
            paintTree();
            return;
        }
        if (act === 'add-ok') {
            const input = rowEl.querySelector('.nr-new-child');
            const name = input ? input.value : '';
            const parent = state.adding;
            state.adding = '';
            apply((doc) => addChild(doc, parent ? parent.split('/') : [], name),
                `加了「${String(name).trim()}」`);
            return;
        }
        if (act === 'rename') {
            state.editing = key;
            paintTree();
            return;
        }
        if (act === 'rename-cancel') {
            state.editing = '';
            paintTree();
            return;
        }
        if (act === 'rename-ok') {
            const input = rowEl.querySelector('.nr-rename');
            const name = input ? input.value : '';
            state.editing = '';
            apply((doc) => renameAt(doc, path, name), `改成「${String(name).trim()}」`);
            return;
        }
        if (act === 'del') {
            apply((doc) => removeAt(doc, path), `删掉了「${key}」`);
            return;
        }
        if (act === 'up') return apply((doc) => moveAt(doc, path, -1), '上移一格');
        if (act === 'down') return apply((doc) => moveAt(doc, path, 1), '下移一格');
    });
    treeEl.addEventListener('keydown', (ev) => {
        if (ev.key !== 'Enter') return;
        const rowEl = ev.target && ev.target.closest ? ev.target.closest('.nr-row') : null;
        if (!rowEl) return;
        if (ev.target.classList.contains('nr-new-child')) {
            rowEl.querySelector('[data-act="add-ok"]').click();
        } else if (ev.target.classList.contains('nr-rename')) {
            rowEl.querySelector('[data-act="rename-ok"]').click();
        }
    });

    function paintSummary() {
        const paths = leafPaths(state.doc);
        const summary = state.doc && state.doc.classTrie ? Object.keys(state.doc.classTrie) : [];
        summaryEl.innerHTML = state.ready
            ? `分类叶子 <b>${paths.length}</b> 条 · 根 <b>${summary.length}</b> 个`
              + `（${summary.map(escapeHtml).join('、')}）· 特殊叶子 <b>${
                  SPECIAL_LEAVES.filter((n) => paths.some((p) => p.split('/').pop() === n)).length
              }/3</b> 在`
            : '';
    }

    function paintAll() {
        paintSummary();
        paintFields();
        paintTree();
        setBusy(false);
    }

    // ---------------- 载入 / 保存 ----------------
    async function load() {
        setStatus('正在连本机主脚本…');
        const ping = await probeRegistryApi(fetchImpl);
        if (!ping.ok) {
            setStatus(`没连上本机主脚本（${ping.error}）—— 改这份注册表要它来读写磁盘。`, '#b91c1c');
            return false;
        }
        if (Number(ping.api || 0) < NEED_API) {
            setStatus(`服务器是启动更早的旧进程（接口 v${Number(ping.api || 0)} < v${NEED_API}）——`
                + '双击一次 启动AcmTree.bat 重启它。', '#b91c1c');
            return false;
        }
        state.base = ping.base || '';
        try {
            const got = await fetchRegistry(fetchImpl, state.base);
            state.path = got.path;
            state.sha256 = got.sha256;
            state.mtime = got.mtime;
            state.doc = got.doc;
            state.usage = usageOf() || new Map();
            // ⚠️ 默认**全收起**：真注册表有上千条叶子，一上来全展开既慢又没法看
            //    （只展开根那一层就等于展开了 40+ 行）。想看就点行首那颗 ▸，或用「全部展开」。
            state.open = new Set();
            state.ready = true;
            setDirty(false);
            setStatus(`${state.path} · 最后改动 ${mtimeText(state.mtime)} · sha ${String(state.sha256).slice(0, 8)}`);
            paintAll();
            return true;
        } catch (err) {
            setStatus(`读不到性质注册表：${err.message}`, '#b91c1c');
            return false;
        }
    }

    async function save() {
        if (!state.ready || state.busy) return false;
        setBusy(true);
        setStatus('正在写…');
        try {
            const got = await saveRegistry(fetchImpl, state.base, { doc: state.doc, sha256: state.sha256 });
            state.sha256 = got.sha256;
            state.mtime = got.mtime;
            state.doc = got.doc;
            setDirty(false);
            const d = got.diff || {};
            const bits = [];
            if (d.addedClassCount) bits.push(`+${d.addedClassCount} 条分类`);
            if (d.removedClassCount) bits.push(`−${d.removedClassCount} 条分类`);
            if (d.addedFields && d.addedFields.length) bits.push(`+字段 ${d.addedFields.join('、')}`);
            if (d.removedFields && d.removedFields.length) bits.push(`−字段 ${d.removedFields.join('、')}`);
            setStatus(`✅ 已写进 ${state.path}${bits.length ? `（${bits.join('，')}）` : '（分类没变）'}`
                + ' · 记得刷新页面 + 重建总包');
            toast('性质注册表已保存 —— 刷新页面 + 重建总包才生效', 'success');
            paintAll();
            return true;
        } catch (err) {
            if (err.status === 409) {
                setStatus('磁盘上那份被别处改过了（没写）—— 点「↻ 重新载入」看最新那份，再决定怎么合。', '#b91c1c');
            } else {
                setStatus(`写不进去：${err.message}`, '#b91c1c');
            }
            return false;
        } finally {
            setBusy(false);
        }
    }

    host.querySelector('#nr-reload').addEventListener('click', () => { load(); });
    host.querySelector('#nr-expand').addEventListener('click', () => {
        const roots = Object.keys((state.doc || {}).classTrie || {});
        const allOpen = roots.every((r) => state.open.has(r)) && state.open.size > roots.length;
        state.open = allOpen ? new Set(roots) : new Set(leafPaths(state.doc));
        host.querySelector('#nr-expand').textContent = allOpen ? '展开根那一层' : '全部展开';
        paintTree();
    });
    saveBtn.addEventListener('click', () => { save(); });

    return {
        activate: () => { if (!state.ready && !state.busy) load(); },
        reload: load,
        save,
        dirty: () => state.dirty,
        doc: () => state.doc,
        status: () => ({ text: statusEl.textContent, color: statusEl.style.color })
    };
}
