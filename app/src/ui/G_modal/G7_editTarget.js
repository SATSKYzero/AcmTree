// ================================================================
// 编辑目标选择器（ui/G_modal/G7_editTarget.js）
// 职责：副页节点双击/Ctrl+单击时，让用户选择编辑主树节点或副页节点
// 依赖：shell/state.js, A_constants.js,
//       G1_core.js, G1_toast.js
// ================================================================
import { AppState } from '../../shell/state.js';
import { EVENTS } from '../../A_constants.js';
import { createModal } from './G1_core.js';
import { showToast } from './G1_toast.js';

/**
 * 弹出编辑目标选择器
 * @param {string} pageId
 * @param {string} vId - 副页 vNode id
 */
export function showEditTargetSelector(pageId, vId) {
    const page = AppState.pages[pageId];
    if (!page) {
        showToast('副页不存在', 'error');
        return;
    }
    const vNode = page.virtualIndex[vId];
    if (!vNode) {
        showToast('虚拟节点不存在', 'error');
        return;
    }

    const hasRealRef = !!(vNode.refId && AppState.nodes[vNode.refId]);

    let btnHtml = '<div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap;">';
    if (hasRealRef) {
        btnHtml += `<button class="edit-target-btn" data-target="real" style="padding:10px 24px;border:none;border-radius:8px;font-size:16px;font-weight:bold;cursor:pointer;background:#2563eb;color:#fff;transition:transform 0.1s;box-shadow:0 2px 6px rgba(0,0,0,0.1);">编辑所映射主树节点</button>`;
    }
    btnHtml += `<button class="edit-target-btn" data-target="vnode" style="padding:10px 24px;border:none;border-radius:8px;font-size:16px;font-weight:bold;cursor:pointer;background:#7c3aed;color:#fff;transition:transform 0.1s;box-shadow:0 2px 6px rgba(0,0,0,0.1);">编辑本身</button>`;
    btnHtml += '</div>';

    const { panel, close } = createModal({
        title: '选择编辑对象',
        content: btnHtml,
        maxWidth: '400px',
        buttons: [],
        closeOnOverlay: true,
        closeOnEscape: true
    });

    panel.querySelectorAll('.edit-target-btn').forEach(btn => {
        btn.addEventListener('mouseenter', () => {
            btn.style.transform = 'scale(1.05)';
        });
        btn.addEventListener('mouseleave', () => {
            btn.style.transform = 'scale(1)';
        });
        btn.addEventListener('click', () => {
            const target = btn.dataset.target;
            close();
            if (target === 'real' && hasRealRef) {
                document.dispatchEvent(new CustomEvent(EVENTS.EDIT_NODE, {
                    detail: { nodeId: vNode.refId }
                }));
            } else if (target === 'vnode') {
                document.dispatchEvent(new CustomEvent(EVENTS.EDIT_VNODE, {
                    detail: { pageId, vId }
                }));
            }
        });
    });
}

/**
 * 「查看哪个」选择器：
 * 副页节点的 📋 可以看**所映射的主节点**，也可以看副页节点本身。
 *
 * 还有一个目标：**副页可以指向合成节点**（`refId` 就是一个合成节点），
 * 那时它就是"看合并结果"的入口 —— 所以选择框里明确写出"这是个合成节点"，
 * 而不是装作一个普通主树节点（用户会以为它是原料）。
 *
 * 与上面的编辑目标选择器是**同一套样式与套路**（同一个 `createModal`），
 * 只是把动作换成"打开哪个节点的信息界面"，由调用方通过 `onPick` 决定（`G_events` 里调
 * `openNodeInfoTab`）—— 这样这个模块不必反向依赖 `ui/tabs.js`（那里 import 了 nodeInfoView）。
 *
 * @param {object} o
 * @param {string} o.pageId   副页 id
 * @param {string} o.vId      虚拟节点 id
 * @param {string} [o.refId]  它所映射的真实节点 id（没有就只给"副页节点本身"）
 * @param {boolean} [o.isRoot] 是不是副页根节点（根不引用真实节点，如实说明）
 * @param {(target:'real'|'synth'|'vnode')=>void} o.onPick
 */
export function showInfoTargetSelector({ pageId, vId, refId = '', isRoot = false, onPick }) {
    const page = AppState.pages ? AppState.pages[pageId] : null;
    const vNode = page && page.virtualIndex ? page.virtualIndex[vId] : null;
    if (!vNode) {
        showToast('虚拟节点不存在', 'error');
        return;
    }
    const real = (refId && AppState.nodes) ? AppState.nodes[refId] : null;
    // 合成节点：有非空 `synthKey`（字段键，不是界面文案 —— 见 docs/manual-workflow.md（合成节点））。
    // 这里**只读字段**，不 import `core/ops/synth.js`：那个模块会牵进 shell/state + immer，
    // 而这个弹窗要在纯 Node 冒烟里能跑。
    const synthKey = real ? String(real.synthKey || '').trim() : '';
    const isSynth = synthKey !== '';

    // 内容**用真元素构造**（不是 innerHTML 字符串）：冒烟桩默认不解析 innerHTML，
    // 拼字符串的话"按钮在不在、点了有没有反应"都测不到。
    const wrap = document.createElement('div');
    wrap.className = 'info-target-box';

    const hint = document.createElement('p');
    hint.style.cssText = 'margin:4px 0 14px;font-size:13px;color:#4b5563;line-height:1.6;';
    if (isSynth) {
        hint.textContent = '这个副页节点引用的是一个合成节点：它的成员（原料）按指针归入它，'
            + '成员不算它的子节点。看哪个？';
    } else if (real) {
        hint.textContent = '这个副页节点是引用：字段与子节点都在主树那个节点上；'
            + '它自己只有"页内"的身份（属于哪个副页、选中/展开、页内位置）。看哪个？';
    } else if (isRoot) {
        hint.textContent = '这是副页根节点：它代表"这一页"，不引用任何主树节点。';
    } else {
        hint.textContent = '这个副页节点没有对应的主树节点（引用已失效）。';
    }
    wrap.appendChild(hint);

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:12px;justify-content:center;flex-wrap:wrap;';

    const mkBtn = (target, label, bg) => {
        const b = document.createElement('button');
        b.className = 'info-target-btn';
        b.dataset.target = target;
        b.textContent = label;
        b.style.cssText = `padding:10px 22px;border:none;border-radius:8px;font-size:15px;` +
            `font-weight:bold;cursor:pointer;background:${bg};color:#fff;` +
            'box-shadow:0 2px 6px rgba(0,0,0,0.1);transition:transform 0.1s;';
        b.addEventListener('mouseenter', () => { b.style.transform = 'scale(1.05)'; });
        b.addEventListener('mouseleave', () => { b.style.transform = 'scale(1)'; });
        b.addEventListener('click', () => {
            close();
            if (typeof onPick === 'function') onPick(target);
        });
        return b;
    };

    if (real) {
        row.appendChild(mkBtn('real', isSynth ? '查看合成节点' : '查看所映射主树节点', '#2563eb'));
    }
    row.appendChild(mkBtn('vnode', '查看副页节点本身', '#7c3aed'));
    wrap.appendChild(row);

    const { close } = createModal({
        title: '查看哪个节点？',
        content: wrap,
        maxWidth: '440px',
        buttons: [],
        closeOnOverlay: true,
        closeOnEscape: true
    });
}