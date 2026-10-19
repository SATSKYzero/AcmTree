// ================================================================
// 批次栏与执行条（features/AutoImport/ui/batchTabs.js）
//
// 多份包的切换栏 + 底下那条"将写入 N 个节点（一次事务）"。
// ================================================================
import { button } from './kit.js';

export function renderBatchTabs(container, v, onChange) {
    if (v.batches.length <= 1) return;
    const bar = document.createElement('div');
    bar.style.cssText = 'display:flex; gap:6px; flex-wrap:wrap; padding:4px 0 10px 0;';

    v.batches.forEach((b, i) => {
        const active = i === v.selected;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ai-batch-tab';
        btn.dataset.index = String(i);
        btn.textContent = b.error ? `✗ ${b.file}` : b.file;
        btn.style.cssText = `padding:3px 10px; border:1px solid ${active ? '#2563eb' : '#d1d5db'};`
            + ` border-radius:4px; font-size:12px; cursor:pointer;`
            + ` background:${active ? '#2563eb' : '#fff'}; color:${active ? '#fff' : '#475569'};`;
        btn.addEventListener('click', () => {
            v.selected = i;
            onChange();
        });
        bar.appendChild(btn);
    });

    container.appendChild(bar);
}

// ================================================================
// 渲染：汇总
// ================================================================

export function renderExecuteBar(container, { onExecute, disabled, hint }) {
    const bar = document.createElement('div');
    bar.className = 'ai-execute-bar';
    bar.style.cssText = 'display:flex; align-items:center; gap:12px; padding:12px 0 4px 0;';

    const btn = button('▶ 执行导入', onExecute, true);
    btn.className = 'ai-execute-btn';
    btn.disabled = !!disabled;
    if (disabled) btn.style.cssText += ' opacity:0.5; cursor:not-allowed;';
    bar.appendChild(btn);

    const note = document.createElement('span');
    note.style.cssText = 'font-size:12px; color:#94a3b8;';
    note.textContent = hint || '整批一次事务：要么全成，要么全回滚。';
    bar.appendChild(note);

    container.appendChild(bar);
}

// ================================================================
// 主体渲染
// ================================================================

/**
 * **重算**这批计划（不重新读文件）。
 *
 * 用途：「以包里为准」那个开关勾上/取消时要重算（计划里"写哪些字段"会变）。
 * 为什么要留 `batch.crate` 而不是重读文件：用户可能已经把文件挪走/改过，
 * 而且重读要再走一遍解析（慢）。留的是**首次规划用的那一份 crate**
 * （已含"文件夹视图补默认父容器"的结果）⇒ 重算结果与"重新载入一次"逐字节相同。
 */
