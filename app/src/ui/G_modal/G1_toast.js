// ================================================================
// Toast 消息（G1_toast.js）
// ================================================================

let toastTimer = null;

export function showToast(msg, type = 'info') {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.className = 'toast';
    if (type === 'error') el.classList.add('error');
    if (type === 'success') el.classList.add('success');
    void el.offsetWidth;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}