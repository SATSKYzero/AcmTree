// ================================================================
// 重建日志框（features/AutoImport/ui/buildBox.js）
//
// 点「一键重建总包」后那个黑框（日志 + 进度 + ✕ + 点外关闭）。
// ⚠️ 它带着**模块级状态**（当前那个框、点外关闭挂没挂）—— 正好作为模块私有，
// 外面只看得到 `currentBuildBox()`。
// ================================================================
import { button } from './kit.js';
import { makeProgress } from './progress.js';
import { probeBuildApi, startBuild, fetchBuildStatus, isBuildFinished,
         fetchPackageFile, API_VERSION, stepMark } from '../buildApi.js';
import { escapeHtml as esc } from '../../../utils/html.js';
// 悬停提示也是给人看的字 ⇒ 统一去 Markdown 记号（实现只有一份）
import { plain } from '../../../utils/text.js';

let buildBox = null;

// ---- 「点框外任意处就关掉日志框」----

let outsideCloseArmed = false;

function onDocClickForClose(e) {
    const box = buildBox;
    if (!box || box.dismissed) {
        disarmOutsideClose();
        return;
    }
    // ★ **只在"正在跑"时**点框外才算关（2026-10-16，用户："跑完不消失"）：
    //   跑之前那条"点框外就关"的初衷是"别挡着用应用"；可跑完（没有轮询再把它挂回来）之后
    //   随手一点别处，**日志就永久没了**（用户要看的正是跑完的结果）。
    //   ⇒ 跑完就只剩 ✕/折叠两个显式动作，随便点哪儿都不会丢。
    if (!box.running) return;
    if (box.el.contains(e.target)) return;                       // 框里面：不关（要能滚动/选中日志）
    // 工具栏那一排（重建 / **暂停** / 档位 / 离线）是同一条功能的控制条，点它们不算"点框外"。
    // ⚠️ 尤其「⏸ 暂停」：它的语义就是"停下来"，要是顺手把日志框也关了，
    //    用户根本看不到"当前这一步跑完了没有"。
    if (e.target && e.target.closest && e.target.closest('.ai-toolbar')) return;
    if (e.target && e.target.closest && e.target.closest('.ai-build-btn')) return;  // 刚点了重建（兜底）
    box.close();
}

export function armOutsideClose() {
    if (outsideCloseArmed) return;
    document.addEventListener('click', onDocClickForClose);
    outsideCloseArmed = true;
}

export function disarmOutsideClose() {
    if (!outsideCloseArmed) return;
    document.removeEventListener('click', onDocClickForClose);
    outsideCloseArmed = false;
}

export function buildLogBox() {
    if (buildBox) return buildBox;
    const el = document.createElement('div');
    el.className = 'ai-build-log';
    el.style.cssText = 'margin:10px 0 2px; border:1px solid #e2e8f0; border-radius:6px;'
        + ' background:#0f172a; color:#e2e8f0; padding:8px 10px; font-size:12px;';
    const head = document.createElement('div');
    head.style.cssText = 'color:#93c5fd; font-weight:600; margin-bottom:4px;'
        + ' display:flex; align-items:center; gap:8px;';
    const title = document.createElement('span');
    // ✕ 关闭：除了这个按钮，**跑的时候**点框外面任何地方也会关掉它（见 `armOutsideClose`）；
    // 点框里面不关（要能选中日志）。**跑完就不再自动关**（2026-10-16：用户要"跑完不消失"）——
    // 那之后只剩 ✕ 与「折叠」两个显式动作。
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'ai-build-close';
    closeBtn.textContent = '✕';
    closeBtn.title = plain('关掉这个日志框（跑的时候点框外也会关；跑完就留着）');
    closeBtn.style.cssText = 'background:transparent; border:1px solid #475569;'
        + ' color:#cbd5e1; border-radius:4px; cursor:pointer; font-size:11px; line-height:1;'
        + ' padding:3px 7px;';
    // ---- 折叠：把日志那一块收起来，只留这条标题（状态/步骤/档位都在标题里）----
    //   为什么要有（用户 2026-10-16："让建包的运行信息框可折叠,且跑完不消失"）：
    //   跑完的日志要能**留着查**，又不该一直占着半屏 —— 一个按钮让用户自己收。
    const foldBtn = document.createElement('button');
    foldBtn.type = 'button';
    foldBtn.className = 'ai-build-fold';
    foldBtn.style.cssText = 'margin-left:auto; background:transparent; border:1px solid #475569;'
        + ' color:#cbd5e1; border-radius:4px; cursor:pointer; font-size:11px; line-height:1;'
        + ' padding:3px 7px;';
    head.appendChild(title);
    head.appendChild(foldBtn);
    head.appendChild(closeBtn);
    const pre = document.createElement('pre');
    pre.style.cssText = 'margin:0; max-height:260px; overflow:auto; white-space:pre-wrap;'
        + ' font-family:Consolas, Menlo, monospace; line-height:1.5;';
    el.appendChild(head);
    el.appendChild(pre);
    const box = {
        el,
        head,
        title,
        pre,
        dismissed: false,
        // “正在跑”状态：跑着的时候**关过也要挂回来**
        // （“正在跑时没挂回来”）—— 进度不能被藏掉。
        running: false,
        /** 日志那一块收起来了没有（**跨重画保持**：状态住在这个单例上，见文件头） */
        collapsed: false,
        /** 把折叠状态落到 DOM（标题那条永远在 ⇒ 收起来也能看见 状态/步骤/档位） */
        applyCollapse() {
            pre.style.display = box.collapsed ? 'none' : '';
            foldBtn.textContent = box.collapsed ? '▸' : '▾';
            foldBtn.title = plain(box.collapsed ? '展开日志' : '折叠日志（只留这条标题）');
        },
        reset() {
            box.dismissed = false;
            // 新的一次重建 ⇒ **自动展开**（点了按钮就是来看日志的；上一次收起来的状态不带过来）
            box.collapsed = false;
            box.applyCollapse();
            title.textContent = '🛠 重建总包（处理链在本机主脚本进程内跑）';
            pre.textContent = '';
        },
        /** 关掉：从 DOM 里拿掉，并标记 dismissed ⇒ 之后的 redraw 不再自动挂回来 */
        close() {
            box.dismissed = true;
            if (el.parentNode) el.parentNode.removeChild(el);
            disarmOutsideClose();
        },
        append(line) {
            pre.textContent += (pre.textContent ? '\n' : '') + String(line);
            if (pre.scrollTop !== undefined) pre.scrollTop = pre.scrollHeight;
        },
        /** 用服务器给的状态整段重画（日志行来自 `status.lines`；进度来自 `status.steps`） */
        render(status) {
            box.running = !!(status && status.running);
            // ★ 跑完 ⇒ 把"点框外就关"那条摘掉（用户 2026-10-16："跑完不消失"）：
            //   那之后没有轮询再把它挂回来，随手一点别处日志就永久没了。
            if (!box.running) disarmOutsideClose();
            const lines = (status && status.lines) || [];
            pre.textContent = lines.join('\n');
            // 步骤条：服务器是**进程内**跑的处理链，所以它知道"现在第几步、每步多久"，
            // 不用从日志里猜（这是单进程化顺手拿到的确定性）。
            const steps = (status && status.steps) || [];
            const bar = steps.length
                ? '　' + steps.map(s => `${stepMark(s.state)}${s.title.split('（')[0]}`
                    + (s.seconds ? `${s.seconds}s` : '')).join(' ')
                : '';
            const mode = status && status.offline ? '　🛰 离线' : '';
            // 「重建档位」由**服务器**报回来（`buildModeLabel`）：标签只有一份，客户端不自己编
            const gear = (status && status.buildModeLabel) ? `　🎚 ${status.buildModeLabel}` : '';
            title.textContent = `🛠 重建总包（${(status && status.cmd) || 'build_chain'}）${mode}${gear}`
                + (status && status.running
                    ? `　⏳ 进行中 ${status.elapsed}s`
                    : (status && status.code === 0 ? '　✅ 完成' : `　❌ 退出码 ${status && status.code}`))
                + bar;
            if (pre.scrollTop !== undefined) pre.scrollTop = pre.scrollHeight;
        }
    };
    closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        box.close();
    });
    foldBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        box.collapsed = !box.collapsed;
        box.applyCollapse();
    });
    box.applyCollapse();                       // 初值（▾ / 展开）
    buildBox = box;
    return box;
}

/**
 * 渲染整个面板
 *
 * @param {HTMLElement} container - 渲染目标（Tab 容器 / 文件夹视图 body）
 * @param {Object} v - 视图状态（tabView 或 folderView），带 kind 与 forcedParentId
 * @param {Object} [opts]
 * @param {boolean} [opts.showToolbar=true] - 文件夹视图自己已有工具栏，可关掉
 */

/** 现在那个重建日志框（入口只问它"关没关 / 在不在跑"） */
export function currentBuildBox() { return buildBox; }

