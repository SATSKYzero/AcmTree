// ================================================================
// 冒烟测试：弹窗的「点框外关闭」判据（scripts/smoke/modal-overlay.smoke.mjs）
//
// 要钉住的 bug：**在节点编辑框内按住鼠标、拖到框外松开，弹窗就关了**。
// 根因：`G1_core.js` 只看 `click` 事件，而 `click` 的 `target` 是**按下点与松开点的
// 最近公共祖先** —— 框内按下、框外松开时公共祖先正好是 overlay（背景），
// 于是被当成"点了框外"。
//
// 现在判据是：**框外按下 ∧ 框外松开**。这个文件把三种情形都走一遍真实路径
// （`createModal` → 桩事件 → 看弹窗还在不在）：
//   ① 框外按下 + 框外松开 → 关（正常用法）
//   ② 框内按下 + 框外松开 → **不关**（这就是那个 bug）
//   ③ 框内按下 + 框内松开 → 不关
//
// 运行：npm run test:smoke
// ================================================================
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDom } from './dom.mjs';
import { group, ok, eq, report } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = path.join(ROOT, 'src');

installDom();

const mod = p => `file://${path.join(SRC, p).replace(/\\/g, '/')}`;
const { createModal } = await import(mod('ui/G_modal/G1_core.js'));

/** 开一个弹窗，返回 { panel, overlay } */
function openModal() {
    return createModal({ title: '测试弹窗', content: '<input id="x">' });
}

/** 真按下/真松开：mousedown 在 which 上，click 落在 clickTarget 上（与浏览器一致） */
function dragRelease(which, clickTarget) {
    which.dispatchEvent({ type: 'mousedown' });
    (clickTarget || which).dispatchEvent({ type: 'click' });
}

group('弹窗：点框外关闭的判据 = 框外按下 ∧ 框外松开');
{
    // ① 框外按下 + 框外松开 → 关
    const m1 = openModal();
    ok(document.body.contains(m1.overlay), '（前提）弹窗开着');
    dragRelease(m1.overlay);
    eq(document.body.contains(m1.overlay), false, '框外按下 + 框外松开 → 关闭');

    // ② 框内按下 + 框外松开 → **不关**（拖到框外松开不等于"点了框外"）
    const m2 = openModal();
    dragRelease(m2.panel, m2.overlay);
    eq(document.body.contains(m2.overlay), true,
        '框内按下 + 框外松开 → **保持打开**（拖选文本/拖一下不该把弹窗关掉）');
    m2.close();

    // ③ 框内按下 + 框内松开 → 不关
    const m3 = openModal();
    dragRelease(m3.panel, m3.panel);
    eq(document.body.contains(m3.overlay), true, '框内按下 + 框内松开 → 保持打开');
    m3.close();

    // ④ 框外按一下再松开后，**下一次**框内按下不该继承上一次的"框外"状态
    const m4 = openModal();
    m4.overlay.dispatchEvent({ type: 'mousedown' });     // 框外按下（但没松开成 click）
    m4.overlay.dispatchEvent({ type: 'mousedown' });     // 再来一次：状态被覆盖成"框外按下"
    m4.panel.dispatchEvent({ type: 'mousedown' });       // 真的在框内按下
    m4.overlay.dispatchEvent({ type: 'click' });         // 松开在框外
    eq(document.body.contains(m4.overlay), true, '按下点每次都被重新记录（不会记住上一次）');
    m4.close();
}

report('弹窗关闭判据');
