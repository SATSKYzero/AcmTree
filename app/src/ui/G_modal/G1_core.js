// ================================================================
// 通用模态框创建器（G1_core.js）
// ================================================================

/**
 * 创建统一的模态框
 * @param {Object} options
 * @param {string} options.title - 标题
 * @param {string|HTMLElement} options.content - 内容（HTML字符串或DOM元素）
 * @param {Array<{label:string, className?:string, callback:Function, disabled?:boolean}>} options.buttons - 按钮列表（右侧排列）
 * @param {string} [options.width] - 面板宽度（如 '600px'）
 * @param {string} [options.maxWidth] - 面板最大宽度
 * @param {string} [options.height] - 面板高度
 * @param {string} [options.maxHeight] - 面板最大高度
 * @param {boolean} [options.closeOnOverlay=true] - 点击背景是否关闭
 * @param {boolean} [options.closeOnEscape=true] - 按 ESC 是否关闭
 * @param {Function} [options.onClose] - 关闭时的回调
 * @param {Function} [options.onConfirm] - 确定按钮的快捷回调（若有确认按钮，可省略buttons）
 * @param {Function} [options.onCancel] - 取消按钮的快捷回调
 * @returns {{ panel: HTMLElement, overlay: HTMLElement, close: Function, setContent: Function }}
 */
export function createModal(options) {
    const {
        title,
        content,
        buttons = [],
        width = '',
        maxWidth = '550px',
        height = '',
        maxHeight = '80vh',
        closeOnOverlay = true,
        closeOnEscape = true,
        enterToConfirm = true,
        autoFocus = true,
        onClose = null,
        onConfirm = null,
        onCancel = null,
    } = options;

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    const panel = document.createElement('div');
    panel.className = 'modal-panel';
    if (width) panel.style.width = width;
    if (maxWidth) panel.style.maxWidth = maxWidth;
    if (height) panel.style.height = height;
    if (maxHeight) panel.style.maxHeight = maxHeight;

    const titleEl = document.createElement('h3');
    titleEl.textContent = title;
    panel.appendChild(titleEl);

    const contentContainer = document.createElement('div');
    contentContainer.id = 'modal-content-container';
    if (typeof content === 'string') {
        contentContainer.innerHTML = content;
    } else if (content instanceof HTMLElement) {
        contentContainer.appendChild(content);
    }
    panel.appendChild(contentContainer);

    const btnRow = document.createElement('div');
    btnRow.className = 'btn-row';

    const allButtons = [...buttons];
    if (onConfirm && !buttons.some(b => b.label === '确定')) {
        allButtons.push({ label: '确定', className: 'btn btn-primary', callback: onConfirm });
    }
    if (onCancel && !buttons.some(b => b.label === '取消')) {
        allButtons.push({ label: '取消', className: 'btn', callback: onCancel });
    }

    allButtons.forEach(btnDef => {
        const btn = document.createElement('button');
        btn.className = btnDef.className || 'btn';
        btn.textContent = btnDef.label;
        if (btnDef.disabled) btn.disabled = true;
        btn.addEventListener('click', async (e) => {
            const result = btnDef.callback(e);
            // 若回调返回 Promise，等待其完成
            if (result && typeof result.then === 'function') {
                const finalResult = await result;
                if (finalResult !== false) {
                    close();
                }
            } else if (result !== false) {
                close();
            }
        });
        btnRow.appendChild(btn);
    });

    panel.appendChild(btnRow);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    // ---- 聚焦 ----
    if (autoFocus) {
        if (!panel.hasAttribute('tabindex')) {
            panel.setAttribute('tabindex', '-1');
        }
        requestAnimationFrame(() => {
            panel.focus({ preventScroll: true });
        });
    }

    let isClosed = false;
    let escHandler = null;
    let enterHandler = null;

    function close() {
        if (isClosed) return;
        isClosed = true;

        if (escHandler) {
            document.removeEventListener('keydown', escHandler);
            escHandler = null;
        }
        if (enterHandler) {
            document.removeEventListener('keydown', enterHandler);
            enterHandler = null;
        }

        if (document.body.contains(overlay)) {
            document.body.removeChild(overlay);
        }

        if (onClose) onClose();
    }

    if (closeOnOverlay) {
        // 关弹窗的判据：**框外按下 ∧ 框外松开**。
        //
        // 只看 `click` 不行：`click` 的 target 是**按下与松开两点的最近公共祖先** ——
        // 在框内按住、拖到框外松开时，公共祖先正好是 overlay ⇒ 被当成"点了框外"，
        // 弹窗在用户只是想选中/拖一下文本时就关了。
        // 所以这里把"按下那一下"也记下来，两次都在框外才算点框外。
        let downOnOverlay = false;
        overlay.addEventListener('mousedown', (e) => {
            downOnOverlay = (e.target === overlay);
        });
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay && downOnOverlay) close();
        });
    }

    if (closeOnEscape) {
        escHandler = (e) => {
            if (e.key === 'Escape') close();
        };
        document.addEventListener('keydown', escHandler);
    }

    if (enterToConfirm) {
        enterHandler = (e) => {
            if (e.key === 'Enter') {
                if (!panel.contains(e.target)) return;
                if (e.target.tagName === 'TEXTAREA') return;
                const primaryBtn = panel.querySelector('.btn-primary:not(:disabled), .btn-danger:not(:disabled)');
                if (primaryBtn) {
                    e.preventDefault();
                    primaryBtn.click();
                }
            }
        };
        document.addEventListener('keydown', enterHandler);
    }

    function setContent(newContent) {
        contentContainer.innerHTML = '';
        if (typeof newContent === 'string') {
            contentContainer.innerHTML = newContent;
        } else if (newContent instanceof HTMLElement) {
            contentContainer.appendChild(newContent);
        }
    }

    return { panel, overlay, close, setContent };
}