// ================================================================
// 节点自动导入 — 补身份键（features/AutoImport/extKeyPanel.js）
// 职责：给已有节点补写 extKey（docs/auto-import.md 第八节入口 B/C）
// 依赖：shell/state.js, ./apply.js, ./extkey.js, ./constants.js
//
// 三条硬约束（8.5）：
//   1. **不覆盖已有 extKey**（幂等，只补空的）
//   2. 目标 key 已被别的节点占用 → 拒绝该条，**不自动挑一个**
//   3. **按题号/名称配对，不按顺序配对** ——
//      顺序配对在数据缺行时会静默错位，而错位的 key 是发现不了的
//
// 说明：本模块碰 DOM，不进 Node 单测，由冒烟测试覆盖。
// ================================================================
import { AppState } from '../../shell/state.js';
import { applyExtKeyAssignments, changeExtKeyAssignments } from './apply.js';
import { composeExtKey } from './extkey.js';
import { escapeHtml as esc } from '../../utils/html.js';
// 「extKey 的第一段 = 哪棵树」**只有这一份判据**（带 trim）—— 自己写 `split(':')[0]`
// 会把 `" qoj:c:1"` 读成 `" qoj"`，于是建议键里带上一个前导空格
import { treeOfExtKey } from '../../utils/extkey.js';
function showToast(msg, type = 'info') {
    document.dispatchEvent(new CustomEvent('show-toast', { detail: { message: msg, type } }));
}

const BTN_CSS = 'padding:4px 12px; border:1px solid #d1d5db; border-radius:4px; font-size:12px; cursor:pointer; background:#fff; color:#334155;';
const BTN_PRIMARY_CSS = 'padding:4px 12px; border:1px solid #2563eb; border-radius:4px; font-size:12px; cursor:pointer; background:#2563eb; color:#fff;';
// 「操作」格里的**图标**按钮：与旁边那颗文字按钮（「更换」）**同高**、内容居中。
// 为什么单独一份：单字符 + `BTN_CSS`（`padding:4px 12px`）会得到一个宽扁的盒子、emoji 还贴左上角，
// 与「更换」并排时三个盒子对不齐（2026-10-13 用户在看板上指出"排版不好"）。
const BTN_ICON_CSS = 'width:24px; height:24px; padding:0; display:inline-flex; align-items:center; '
    + 'justify-content:center; box-sizing:border-box; border:1px solid #d1d5db; border-radius:4px; '
    + 'background:#fff; color:#334155; font-size:13px; line-height:1; cursor:pointer;';

// ================================================================
// 配对解析（核心：按标识配对，不按顺序）
// ================================================================

/**
 * 解析粘贴的对照表
 *
 * 每行形如 `<extKey> <标识>`，分隔符接受制表符、多个空格、逗号。
 * **标识**用来和节点配对（题号优先，其次名称）——不用行号。
 *
 * @param {string} text
 * @returns {{ pairs: Array<{extKey:string, token:string}>, errors: string[] }}
 */
export function parseAssignmentTable(text) {
    const pairs = [];
    const errors = [];
    const lines = String(text || '').split(/\r?\n/);

    lines.forEach((line, i) => {
        const raw = line.trim();
        if (raw === '' || raw.startsWith('#')) return;

        // 制表符 / 逗号 / 2 个以上空格 都当分隔符
        const parts = raw.split(/\t|,|\s{2,}/).map(s => s.trim()).filter(Boolean);
        const fields = parts.length >= 2 ? parts : raw.split(/\s+/).map(s => s.trim()).filter(Boolean);

        if (fields.length < 2) {
            errors.push(`第 ${i + 1} 行：需要「extKey 标识」两列，实际只有 ${fields.length} 列`);
            return;
        }
        const [extKey, token] = fields;
        if (!extKey) {
            errors.push(`第 ${i + 1} 行：extKey 为空`);
            return;
        }
        pairs.push({ extKey, token: token || '' });
    });

    return { pairs, errors };
}

/**
 * 用标识把 pairs 配到节点上
 *
 * 配对优先级：problemId 精确 → name 精确 → 全局 extKey 重复（后者报错）。
 * **不做模糊匹配**——模糊配对与"按顺序"一样会静默错配。
 *
 * @param {Array<Object>} nodes - 候选节点
 * @param {Array<{extKey:string, token:string}>} pairs
 * @returns {{ assignments: Array<{nodeId:string, extKey:string}>,
 *             unmatched: string[], ambiguous: string[], skippedNonEmpty: number }}
 */
export function matchAssignments(nodes, pairs) {
    const assignments = [];
    const unmatched = [];
    const ambiguous = [];
    let skippedNonEmpty = 0;

    const usedNodes = new Set();

    for (const pair of pairs) {
        const token = String(pair.token || '').trim();
        const candidates = nodes.filter(n => {
            if (usedNodes.has(n.id)) return false;
            const pid = String(n.problemId || '').trim();
            const name = String(n.name || '').trim();
            return (pid && pid === token) || (name && name === token);
        });

        if (candidates.length === 0) {
            unmatched.push(`${pair.extKey} → "${token}"`);
            continue;
        }
        if (candidates.length > 1) {
            ambiguous.push(`${pair.extKey} → "${token}"（匹配到 ${candidates.length} 个节点，请改用题号）`);
            continue;
        }

        const node = candidates[0];
        usedNodes.add(node.id);

        // 已有 key：跳过（幂等），但计数告知
        if (node.extKey && String(node.extKey).trim() !== '' && String(node.extKey).trim() !== pair.extKey) {
            skippedNonEmpty++;
            continue;
        }
        assignments.push({ nodeId: node.id, extKey: pair.extKey });
    }

    return { assignments, unmatched, ambiguous, skippedNonEmpty };
}

// ================================================================
// 渲染
// ================================================================

/** 列出当前文件夹下的直接子节点（补 key 的作用域） */
function childNodesOf(nodeId) {
    const ids = (AppState.childOrder && AppState.childOrder[nodeId]) || [];
    const out = [];
    for (const id of ids) {
        const n = AppState.nodes[id];
        if (n) out.push(n);
    }
    return out;
}

/** 给一个节点算"建议键"（8.3 的"建议键"列；能算则算，算不出留空） */
function suggestKeyFor(node, parentExtKey) {
    if (!parentExtKey) return '';
    const platform = treeOfExtKey(parentExtKey);
    if (!platform) return '';

    if (node.type === 'P' && node.problemId) {
        return `${parentExtKey}:${String(node.problemId).trim()}`;
    }
    if (node.type === 'C' && node.contestTime) {
        return '';
    }
    return composeExtKey({ platform, contestId: String(node.name || '').trim() }) || '';
}

/**
 * 渲染补身份键面板到 `container`
 *
 * @param {HTMLElement} container
 * @param {Object} ctx - { nodeId, node, refresh? }
 */
export function renderExtKeyPanel(container, ctx = {}) {
    const nodeId = ctx.nodeId || AppState.rootId;
    const parent = AppState.nodes[nodeId];
    const parentExtKey = parent && parent.extKey ? String(parent.extKey).trim() : '';
    const children = childNodesOf(nodeId);

    container.innerHTML = '';

    const wrap = document.createElement('div');
    wrap.className = 'ai-extkey-panel';
    wrap.style.cssText = 'padding:12px 4px; font-size:13px; color:#334155;';

    // ---- 说明 ----
    const head = document.createElement('div');
    head.style.cssText = 'padding:10px 12px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:6px; margin-bottom:12px; line-height:1.7;';
    head.innerHTML = '<b>🔑 补身份键</b><br>'
        + 'extKey 是与爬虫对账的唯一身份。导入要求每个节点都必须有它。<br>'
        + '本页<b>只补空的</b>，不覆盖已有键；也不会自动挑键——冲突会报给你决定。'
        + (parent ? `<br>当前文件夹：<b>${esc(parent.name || parent.id)}</b>`
            + (parentExtKey ? `　extKey = <code>${esc(parentExtKey)}</code>` : '　<span style="color:#b45309;">⚠️ 该文件夹没有 extKey</span>') : '');
    wrap.appendChild(head);

    // ---- 当前文件夹**自身**的 extKey ----
    //
    // 为什么需要这一块：本页的节点列表只列**子节点**，而**根节点不是任何节点的子节点**，
    // 所以它在列表里永远不出现 —— 于是根节点的 extKey 无从设置。
    // 这块表单直接作用于"当前文件夹自身"，因此：
    //   - 在根文件夹打开本页 → 设置的就是**根节点的 extKey**
    //   - 在任意子文件夹打开 → 也能顺手设置该文件夹自己的 key
    wrap.appendChild(buildSelfKeyBox(parent, parentExtKey, () => {
        if (ctx.refresh) ctx.refresh();
    }));

    // ---- 入口 C：按规则批量生成（逃生舱）----
    const genBox = document.createElement('div');
    genBox.style.cssText = 'padding:10px 12px; border:1px dashed #fca5a5; border-radius:6px; margin-bottom:12px; background:#fff7f7;';
    genBox.innerHTML = '<b style="color:#b91c1c;">逃生舱：按规则批量生成</b><br>'
        + '<span style="font-size:12px; color:#b91c1c;">生成的键爬虫<b>永远不会用</b>，所以这批节点<b>永远无法与爬虫对账</b>。'
        + '它只解决"让校验通过"，不解决"能和爬虫增量"。</span>';
    const genRow = document.createElement('div');
    genRow.style.cssText = 'display:flex; gap:8px; align-items:center; margin-top:8px;';
    const prefixInput = document.createElement('input');
    prefixInput.type = 'text';
    prefixInput.className = 'ai-gen-prefix';
    prefixInput.placeholder = '前缀，如 local';
    prefixInput.value = 'local';
    prefixInput.style.cssText = 'padding:4px 8px; border:1px solid #d1d5db; border-radius:4px; font-size:12px; width:140px;';
    genRow.appendChild(prefixInput);
    const genBtn = document.createElement('button');
    genBtn.type = 'button';
    genBtn.className = 'ai-gen-btn';
    genBtn.textContent = '给本层无键子节点生成';
    genBtn.style.cssText = BTN_CSS;
    genBtn.addEventListener('click', async () => {
        const prefix = String(prefixInput.value || '').trim() || 'local';
        const targets = children.filter(n => !n.extKey || String(n.extKey).trim() === '');
        if (!targets.length) {
            showToast('本层没有缺少 extKey 的子节点', 'info');
            return;
        }
        const assignments = targets.map((n, i) => ({ nodeId: n.id, extKey: `${prefix}:${i + 1}` }));
        const res = await applyExtKeyAssignments({ state: AppState, assignments });
        report(res, () => { if (ctx.refresh) ctx.refresh(); });
    });
    genRow.appendChild(genBtn);
    genBox.appendChild(genRow);
    wrap.appendChild(genBox);

    // ---- 入口 B 主路径：粘贴对照表 ----
    const pasteBox = document.createElement('div');
    pasteBox.style.cssText = 'margin-bottom:12px;';
    pasteBox.innerHTML = '<b>粘贴对照表（推荐）</b><br>'
        + '<span style="font-size:12px; color:#64748b;">每行「extKey 标识」，标识填<b>题号</b>（推荐）或名称。'
        + '按标识配对——<b>不按顺序</b>，所以缺行不会错位。</span>';

    const textarea = document.createElement('textarea');
    textarea.className = 'ai-paste-area';
    textarea.rows = 6;
    textarea.placeholder = 'qoj:4113:20236    A\nqoj:4113:20237    B\nqoj:4113:20238    C';
    textarea.style.cssText = 'width:100%; margin-top:6px; padding:8px; border:1px solid #d1d5db; border-radius:4px;'
        + ' font-family:monospace; font-size:12px; box-sizing:border-box; resize:vertical;';
    pasteBox.appendChild(textarea);

    const pasteRow = document.createElement('div');
    pasteRow.style.cssText = 'display:flex; gap:8px; align-items:center; margin-top:8px;';
    const applyBtn = document.createElement('button');
    applyBtn.type = 'button';
    applyBtn.className = 'ai-paste-apply';
    applyBtn.textContent = '按标识配对并写入';
    applyBtn.style.cssText = BTN_PRIMARY_CSS;
    applyBtn.addEventListener('click', async () => {
        const { pairs, errors } = parseAssignmentTable(textarea.value);
        if (errors.length) {
            showToast(`对照表有 ${errors.length} 行格式不对，请检查`, 'error');
            return;
        }
        if (!pairs.length) {
            showToast('对照表为空', 'info');
            return;
        }

        const { assignments, unmatched, ambiguous, skippedNonEmpty } = matchAssignments(children, pairs);
        if (assignments.length === 0) {
            showToast(`没有可写入的配对（未匹配 ${unmatched.length}，歧义 ${ambiguous.length}）`, 'error');
            return;
        }

        const res = await applyExtKeyAssignments({ state: AppState, assignments });
        const parts = [`写入 ${res.changed}`];
        if (res.unchanged) parts.push(`已是最新 ${res.unchanged}`);
        if (res.failed.length) parts.push(`失败 ${res.failed.length}`);
        if (unmatched.length) parts.push(`未匹配 ${unmatched.length}`);
        if (ambiguous.length) parts.push(`歧义 ${ambiguous.length}`);
        if (skippedNonEmpty) parts.push(`跳过已有键 ${skippedNonEmpty}`);

        showToast(`补键完成：${parts.join('，')}`, res.failed.length ? 'info' : 'success');

        if (ambiguous.length || unmatched.length || res.failed.length) {
            renderProblems(wrap, { unmatched, ambiguous, failed: res.failed });
        }
        if (ctx.refresh) ctx.refresh();
    });
    pasteRow.appendChild(applyBtn);

    const matchBtn = document.createElement('button');
    matchBtn.type = 'button';
    matchBtn.className = 'ai-paste-preview';
    matchBtn.textContent = '仅预览配对';
    matchBtn.style.cssText = BTN_CSS;
    matchBtn.addEventListener('click', () => {
        const { pairs, errors } = parseAssignmentTable(textarea.value);
        if (errors.length) { showToast(`对照表有 ${errors.length} 行格式不对`, 'error'); return; }
        const { assignments, unmatched, ambiguous } = matchAssignments(children, pairs);
        renderProblems(wrap, { unmatched, ambiguous, failed: [], preview: assignments.length });
    });
    pasteRow.appendChild(matchBtn);
    pasteBox.appendChild(pasteRow);
    wrap.appendChild(pasteBox);

    // ---- 节点列表（当前键 + 建议键 + 更换）----
    //
    // 用**真实 DOM 元素**逐行构建，而不是 innerHTML 拼串：
    //   1. 「更换」按钮需要绑事件（拼串拿不到元素）；
    //   2. 真实元素可被冒烟测试查询 —— innerHTML 拼串查不到，
    //      会让回归测试形同虚设。
    const listTitle = document.createElement('b');
    listTitle.textContent = `本层子节点（${children.length}）`;
    wrap.appendChild(listTitle);

    const list = document.createElement('div');
    list.style.cssText = 'margin-top:6px; max-height:320px; overflow:auto; border:1px solid #e2e8f0; border-radius:6px;';

    if (children.length === 0) {
        const emptyRow = document.createElement('div');
        emptyRow.style.cssText = 'padding:16px; color:#94a3b8; font-size:12px;';
        emptyRow.textContent = '本层没有子节点';
        list.appendChild(emptyRow);
    } else {
        const table = document.createElement('table');
        table.style.cssText = 'width:100%; border-collapse:collapse; font-size:12px;';

        const thead = document.createElement('thead');
        const hr = document.createElement('tr');
        hr.style.cssText = 'background:#f8fafc; color:#475569; position:sticky; top:0;';
        for (const label of ['名称', '类型', '题号', '当前 extKey', '建议键', '操作']) {
            const th = document.createElement('th');
            th.style.cssText = 'text-align:left; padding:5px 8px;';
            th.textContent = label;
            hr.appendChild(th);
        }
        thead.appendChild(hr);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        for (const n of children) {
            const has = n.extKey && String(n.extKey).trim() !== '';
            const sug = suggestKeyFor(n, parentExtKey);

            const tr = document.createElement('tr');
            tr.className = 'ai-extkey-row';
            tr.dataset.node = n.id;
            tr.style.cssText = 'border-top:1px solid #f1f5f9;';

            const cell = (text, css) => {
                const td = document.createElement('td');
                td.style.cssText = css || 'padding:5px 8px;';
                td.textContent = text;
                tr.appendChild(td);
                return td;
            };

            cell(n.name || '');
            cell(n.type, 'padding:5px 8px; color:#64748b;');
            cell(n.problemId || '', 'padding:5px 8px; color:#64748b;');
            cell(has ? String(n.extKey) : '(空)',
                `padding:5px 8px; font-family:monospace; color:${has ? '#334155' : '#dc2626'};`);
            cell(sug, 'padding:5px 8px; font-family:monospace; color:#94a3b8;');

            const opTd = document.createElement('td');
            opTd.style.cssText = 'padding:5px 8px; white-space:nowrap; vertical-align:middle;';
            // 「操作」这一格排成**一行 flex**（与 `ui/kit/nodeEntry.js` 那行入口条同一种排法）：
            // 三个盒子等高、垂直居中对齐；间距用 `gap`，别再用每个元素各自的 `margin-right`。
            const ops = document.createElement('div');
            ops.style.cssText = 'display:flex; align-items:center; gap:6px;';
            // ★ 每行补「🔎 跳到树上 / 📋 打开详页」（G5）。
            //   ⚠️ 插件**不 import `ui/`**（`src/features/AGENTS.md` 的不变量）⇒ 这里只**写属性**：
            //      · `data-reveal-node` 由 `ui/nodeinfo/nodeGroupActions.js` 的**文档级**委托接住
            //        （不必自己挂监听，也不必自己派发事件）；
            //      · `btn-node-info[data-id]` 由 `ui/G_events.js` 的**文档级**委托接住 `openNodeInfoTab`。
            //   两者的实现都只有一份，见 `docs/node-navigation.md` 第 5 节。
            //   ⚠️ **别把这一页挪进"要靠容器上那条委托"的位置**（`v9.0.15` 修的真病根）：
            //      本页是由 folder 视图宿主挂进 `#tree-container` 的，而 `ui/G_events.js` 的
            //      文档级 📋 委托原先用 `closest('#tree-container')` 把**整个树容器**拒收了
            //      ⇒ 那颗 📋 只剩 `#tree-container` 上的 `onActionClick` 接，而后者认的是
            //      **逗号选择器**（DOM 桩不解析）⇒ 桩里"点了没反应"、且没有任何断言会红。
            //      现在那条排除只留 `.node-box` **自己那颗**（容器那条会 `stopPropagation`，不重复开）。
            const goto = document.createElement('a');
            goto.href = '#';
            goto.className = 'ai-extkey-goto';
            goto.dataset.revealNode = n.id;
            goto.textContent = '🔎';
            goto.title = '在树上定位并高亮这个节点';
            // 与右边两颗按钮**同高**、居中；去掉下划线（下划线压在 emoji 底下会让这一格看着歪）
            goto.style.cssText = 'display:inline-flex; align-items:center; justify-content:center; '
                + 'width:22px; height:24px; flex:0 0 auto; text-decoration:none; color:#1d4ed8; font-size:13px; line-height:1;';
            ops.appendChild(goto);

            const infoBtn = document.createElement('button');
            infoBtn.type = 'button';
            infoBtn.className = 'btn-icon btn-node-info ai-extkey-info';
            infoBtn.dataset.id = n.id;
            infoBtn.textContent = '📋';
            infoBtn.title = '打开这个节点的详页（与树上那个 📋 是同一件事）';
            infoBtn.style.cssText = BTN_ICON_CSS;
            ops.appendChild(infoBtn);

            const changeBtn = document.createElement('button');
            changeBtn.type = 'button';
            changeBtn.className = 'ai-extkey-change';
            changeBtn.textContent = '更换';
            changeBtn.style.cssText = BTN_CSS + ' height:24px; box-sizing:border-box;';
            changeBtn.addEventListener('click', () => {
                openChangeForm(changeBtn, n, () => { if (ctx.refresh) ctx.refresh(); });
            });
            ops.appendChild(changeBtn);
            opTd.appendChild(ops);
            tr.appendChild(opTd);

            tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        list.appendChild(table);
    }
    wrap.appendChild(list);

    container.appendChild(wrap);

    // ---- 局部小工具 ----
    function report(res, done) {
        if (!res.ok) {
            showToast(`补键失败（已回滚）：${res.error}`, 'error');
            return;
        }
        showToast(`补键完成：写入 ${res.changed}${res.unchanged ? `，已是最新 ${res.unchanged}` : ''}`
            + `${res.failed.length ? `，失败 ${res.failed.length}` : ''}`,
            res.failed.length ? 'info' : 'success');
        if (res.failed.length) renderProblems(wrap, { unmatched: [], ambiguous: [], failed: res.failed });
        if (done) done();
    }
}

// ================================================================
// 当前文件夹自身的 extKey
// ================================================================

/**
 * 构建"当前文件夹自身 extKey"的编辑块
 *
 * 特地为**根节点**而做：节点列表只列子节点，根永远不在其中，
 * 没有这块表单就无法给根设 extKey。
 *
 * 语义与列表里的「更换」一致：只补空的；已有值要改需显式确认（单向操作）。
 *
 * @param {Object} node - 当前文件夹节点（可能是根）
 * @param {string} currentKey - 它现有的 key（可能为空）
 * @param {Function} [onDone]
 * @returns {HTMLElement}
 */
function buildSelfKeyBox(node, currentKey, onDone) {
    const box = document.createElement('div');
    box.className = 'ai-self-key-box';
    box.style.cssText = 'padding:10px 12px; border:1px solid #e2e8f0; border-radius:6px;'
        + ' background:#f8fafc; margin-bottom:12px;';

    const isRoot = !node || node.id === AppState.rootId || node.type === 'O';

    const title = document.createElement('b');
    title.textContent = isRoot ? '根节点的 extKey' : '当前文件夹自身的 extKey';
    box.appendChild(title);

    const note = document.createElement('div');
    note.style.cssText = 'font-size:12px; color:#64748b; margin:4px 0 8px 0; line-height:1.7;';
    note.innerHTML = isRoot
        ? '根节点<b>不是任何节点的子节点</b>，所以它不会出现在下面的列表里 —— 只能在这里设置。<br>'
        + '设好之后，脚本就可以用 <code>父extKey = 这个值</code> 显式指向根，'
        + '而不必依赖"父引用留空 = 挂根"这条隐式约定。'
        : '给当前文件夹自己设身份键（下面列表列的是它的<b>子节点</b>）。';
    box.appendChild(note);

    const row = document.createElement('div');
    row.style.cssText = 'display:flex; gap:8px; align-items:center; flex-wrap:wrap;';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'ai-self-key-input';
    input.value = currentKey || '';
    input.placeholder = isRoot ? '例如 root 或 acmtree:root' : '例如 qoj:contest';
    input.style.cssText = 'padding:5px 8px; border:1px solid #d1d5db; border-radius:4px;'
        + ' font-family:monospace; font-size:12px; width:260px;';
    row.appendChild(input);

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'ai-self-key-save';
    saveBtn.textContent = currentKey ? '更换' : '设置';
    saveBtn.style.cssText = currentKey
        ? 'padding:4px 12px; border:1px solid #b91c1c; border-radius:4px; font-size:12px; cursor:pointer; background:#b91c1c; color:#fff;'
        : BTN_PRIMARY_CSS;
    row.appendChild(saveBtn);

    const msg = document.createElement('span');
    msg.className = 'ai-self-key-msg';
    msg.style.cssText = 'font-size:12px;';
    row.appendChild(msg);

    box.appendChild(row);

    saveBtn.addEventListener('click', async () => {
        const next = String(input.value || '').trim();
        if (!node || !node.id) {
            msg.style.color = '#b91c1c';
            msg.textContent = '找不到当前文件夹节点。';
            return;
        }
        if (next === (currentKey || '')) {
            msg.style.color = '#64748b';
            msg.textContent = '值没有变化。';
            return;
        }

        // 已有值 → 这是"更换"，必须讲清后果并二次确认（与列表里的「更换」同规则）
        if (currentKey) {
            const what = next === '' ? '清空它的身份键' : `把它的 extKey 换成「${next}」`;
            const sure = window.confirm(
                `确认${what}？\n\n`
                + '后果：爬虫仍用旧 key，所以引用旧 key 的导入包会把它当成"找不到父节点"。\n'
                + '该操作可在「设置」里撤回。'
            );
            if (!sure) return;
            const res = await changeExtKeyAssignments({ assignments: [{ nodeId: node.id, extKey: next }] });
            if (!res.ok) { msg.style.color = '#b91c1c'; msg.textContent = `失败（已回滚）：${res.error}`; return; }
            if (res.failed.length) { msg.style.color = '#b91c1c'; msg.textContent = res.failed[0].reason; return; }
            showToast(next === '' ? '已清空 extKey' : `extKey 已更换为 ${next}`, 'success');
        } else {
            // 只补空的 → 无需确认，与列表外的"补键"语义一致
            if (next === '') {
                msg.style.color = '#64748b';
                msg.textContent = '留空即不设置。';
                return;
            }
            const res = await applyExtKeyAssignments({ state: AppState, assignments: [{ nodeId: node.id, extKey: next }] });
            if (!res.ok) { msg.style.color = '#b91c1c'; msg.textContent = `失败（已回滚）：${res.error}`; return; }
            if (res.failed.length) { msg.style.color = '#b91c1c'; msg.textContent = res.failed[0].reason; return; }
            showToast(`extKey 已设置为 ${next}`, 'success');
        }

        if (onDone) onDone();
    });

    return box;
}

// ================================================================
// 更换 / 清空 extKey（危险操作）
// ================================================================

/**
 * 在节点所在行原地展开"更换 key"表单
 *
 * 为什么必须在同一处把后果讲清楚：
 *   `extKey` 是身份。换掉它之后，爬虫那边**仍然用旧 key**，
 *   于是同一份导入包的**下一次导入会新建一个节点**——
 *   旧节点上的题解不会丢，但会与爬虫数据脱钩（两边分叉）。
 *   这是单向操作，UI 有义务先说清楚再让人点。
 *
 * 目标 key 已被别的节点占用时仍然拒绝：那是脏数据，不能靠覆盖来掩盖。
 *
 * @param {HTMLElement} anchorBtn - 触发按钮（表单插在它所在行之后）
 * @param {Object} node - 目标节点
 * @param {Function} [onDone] - 成功后的回调（通常触发重绘）
 */
function openChangeForm(anchorBtn, node, onDone) {
    const tr = anchorBtn.closest ? anchorBtn.closest('tr') : null;
    if (!tr || !tr.parentNode) return;

    // 已经开着就关掉（当作 toggle）
    const existing = tr.nextSibling;
    if (existing && existing.classList && existing.classList.contains('ai-extkey-change-form')) {
        existing.remove();
        return;
    }
    closeAllChangeForms();

    const current = node.extKey ? String(node.extKey).trim() : '';

    const formRow = document.createElement('tr');
    formRow.className = 'ai-extkey-change-form';
    const td = document.createElement('td');
    td.colSpan = 6;
    td.style.cssText = 'padding:10px 12px; background:#fff7f7; border-top:1px solid #fecaca;';

    // ---- 警告（必须显眼）----
    const warn = document.createElement('div');
    warn.style.cssText = 'color:#b91c1c; line-height:1.7; margin-bottom:8px;';
    warn.innerHTML = '<b>⚠️ 更换 extKey 是单向操作</b><br>'
        + '<span style="font-size:12px;">'
        + 'extKey 是这个节点在爬虫数据里的<b>身份</b>。换掉之后，'
        + '爬虫仍会用旧 key —— 于是<b>同一份导入包的下一次导入会新建一个节点</b>。<br>'
        + '旧节点上的<b>题解不会丢</b>，但会与爬虫数据脱钩（两边从此分叉）。<br>'
        + '<b>留空并确认 = 清空身份</b>（救援通道：补错了又不知道正确 key 时用）。'
        + '</span>';
    td.appendChild(warn);

    // ---- 当前值 ----
    const cur = document.createElement('div');
    cur.style.cssText = 'font-size:12px; color:#475569; margin-bottom:6px;';
    cur.textContent = `当前 extKey：${current || '(空)'}`;
    td.appendChild(cur);

    // ---- 输入 ----
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'ai-change-input';
    input.value = current;
    input.placeholder = '新的 extKey；留空表示清空';
    input.style.cssText = 'width:100%; max-width:460px; padding:5px 8px; border:1px solid #d1d5db;'
        + ' border-radius:4px; font-family:monospace; font-size:12px; box-sizing:border-box;';
    td.appendChild(input);

    const msg = document.createElement('div');
    msg.className = 'ai-change-msg';
    msg.style.cssText = 'font-size:12px; margin-top:6px; min-height:16px;';
    td.appendChild(msg);

    // ---- 按钮 ----
    const row = document.createElement('div');
    row.style.cssText = 'display:flex; gap:8px; align-items:center; margin-top:8px;';

    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'ai-change-confirm';
    okBtn.textContent = '确认更换';
    okBtn.style.cssText = 'padding:4px 12px; border:1px solid #b91c1c; border-radius:4px;'
        + ' font-size:12px; cursor:pointer; background:#b91c1c; color:#fff;';
    row.appendChild(okBtn);

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'ai-change-cancel';
    cancelBtn.textContent = '取消';
    cancelBtn.style.cssText = BTN_CSS;
    cancelBtn.addEventListener('click', () => formRow.remove());
    row.appendChild(cancelBtn);

    const hint = document.createElement('span');
    hint.style.cssText = 'font-size:12px; color:#94a3b8;';
    hint.textContent = '空值 = 清空身份 · 可在「设置」里撤回';
    row.appendChild(hint);

    td.appendChild(row);
    formRow.appendChild(td);
    tr.parentNode.insertBefore(formRow, tr.nextSibling);

    input.focus();

    okBtn.addEventListener('click', async () => {
        const next = String(input.value || '').trim();
        if (next === current) {
            msg.style.color = '#64748b';
            msg.textContent = '值没有变化，无需更换。';
            return;
        }

        // 二次确认：这是单向操作，必须再问一次
        const what = next === '' ? '清空这个节点的身份键' : `把 extKey 换成「${next}」`;
        const sure = window.confirm(
            `确认${what}？\n\n`
            + '后果：爬虫仍用旧 key，所以同一份导入包的下次导入会新建一个节点。\n'
            + '旧节点上的题解不会丢，但会与爬虫数据脱钩（两边分叉）。\n\n'
            + '该操作可在「设置」里撤回。'
        );
        if (!sure) return;

        const res = await changeExtKeyAssignments({
            assignments: [{ nodeId: node.id, extKey: next }]
        });

        if (!res.ok) {
            msg.style.color = '#b91c1c';
            msg.textContent = `更换失败（已回滚）：${res.error}`;
            return;
        }
        if (res.failed.length) {
            msg.style.color = '#b91c1c';
            msg.textContent = res.failed[0].reason;
            return;
        }

        showToast(next === '' ? '已清空 extKey' : `extKey 已更换为 ${next}`, 'success');
        formRow.remove();
        if (onDone) onDone();
    });
}

/** 关掉所有已展开的更换表单（同一时刻只留一个） */
function closeAllChangeForms() {
    document.querySelectorAll('.ai-extkey-change-form').forEach(el => el.remove());
}

/** 把未匹配 / 歧义 / 冲突渲染成一块可读的问题清单 */
function renderProblems(wrap, { unmatched = [], ambiguous = [], failed = [], preview = 0 }) {
    const old = wrap.querySelector('.ai-extkey-problems');
    if (old) old.remove();

    const box = document.createElement('div');
    box.className = 'ai-extkey-problems';
    box.style.cssText = 'margin-top:10px; padding:10px 12px; background:#fffbeb; border:1px solid #fde68a;'
        + ' border-radius:6px; font-size:12px; color:#92400e; line-height:1.8;';

    const lines = [];
    if (preview) lines.push(`✅ 可配对 ${preview} 条（尚未写入）`);
    for (const u of unmatched) lines.push(`⚠️ 未匹配到节点：${esc(u)} — 请确认题号/名称拼写`);
    for (const a of ambiguous) lines.push(`⚠️ 歧义：${esc(a)}`);
    for (const f of failed) lines.push(`⛔ [${esc(f.code)}] ${esc(f.reason)}`);

    box.innerHTML = lines.join('<br>') || '没有需要提示的问题';
    wrap.appendChild(box);
}
