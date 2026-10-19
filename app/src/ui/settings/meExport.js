// ================================================================
// 「📤 写进 me.json（爬虫用）」（ui/settings/meExport.js）
//
// 口径：**绝对可信源是映射、在 AppState 里；me.json 本质上完全是映射的派生部分**
// ⇒ 这个按钮就是那一次"派生"：
//
//   读 me.json（**为了保住凭据与说明**）→ 用应用里的账户重算 `accounts[]`（见
//   `core/rosterAccounts.js` 的 `rosterAccountsFrom`）→ 写回 → 给一份预览
//
// ⚠️ **只改 `accounts` 这一节**：`cf.apiKey` / `qoj.cookie` / `clist.*` / `hdu.files` /
//    `_note` / `current` 一个字都不动（它们是"配置"，不是映射的派生）。
// ⚠️ 没有服务器就没法写（me.json 在磁盘上）—— 报错说人话。
// ================================================================
import { AppState } from '../../shell/state.js';
import { rosterAccountsFrom, accountOf } from '../../core/rosterAccounts.js';
import { escapeHtml } from '../../utils/html.js';
import { createModal } from '../G_modal/G1_core.js';
import { showToast } from '../G_modal/G1_toast.js';
import { probeMeApi, fetchMe, saveMe } from '../MeEditor/meApi.js';

const TITLE = 'font-size:13px;font-weight:600;color:#334155;margin:10px 0 4px;';
const HINT = 'font-size:11px;color:#94a3b8;line-height:1.6;';

/** 预览：每个人会被导成什么样（账号 / 历年 / 推不出来的映射） */
function previewHtml(items, before) {
    if (!items.length) {
        return '<div style="font-size:13px;color:#475569;">账户里还没有映射，导出去也是一份空名册。</div>';
    }
    const rows = items.map((item) => {
        const acc = accountOf(item);
        const plats = Object.entries(acc.handles).map(([p, v]) => `${p}=${v}`);
        for (const [platform, years] of Object.entries(acc.byYear)) {
            for (const [year, value] of Object.entries(years)) plats.push(`${platform}:${year}=${value}`);
        }
        const kept = acc.mappings.length;
        return `<div style="border:1px solid #e2e8f0;border-radius:8px;padding:6px 10px;margin-bottom:6px;">
            <b>${escapeHtml(acc.name)}</b>${acc.active === false ? ` <span style="${HINT}">（已停用 ⇒ 爬虫不抓）</span>` : ''}
            <div style="font-size:12px;color:#475569;line-height:1.7;">${escapeHtml(plats.join('、') || '（没有平台账号）')}</div>
            ${kept ? `<div style="${HINT}">另外原样保留 ${kept} 条推不出来的映射（如 pta 的命名空间）</div>` : ''}
        </div>`;
    }).join('');
    const prevNames = (before || []).map((a) => a.name).join('、');
    return `<div style="${TITLE}">会写成 ${items.length} 个人</div>${rows}
        <div style="${HINT}">${prevNames ? `文件里现有：${escapeHtml(prevNames)}（会被这次覆盖）` : '文件里还没有账户'}</div>`;
}

/**
 * 打开「写进 me.json」：算一遍 → 预览 → 写回。
 *
 * @param {{onApplied?:Function, fetchImpl?:Function, toast?:Function}} [opts]
 */
export async function openMeExport(opts = {}) {
    const toast = opts.toast || showToast;
    const fetchImpl = opts.fetchImpl || globalThis.fetch;

    const probe = await probeMeApi(fetchImpl);
    if (!probe.ok) {
        toast(`没连上本机主脚本（${probe.error}）—— 写 me.json 要它。用启动AcmTree.bat 起服务器。`, 'error');
        return null;
    }
    let got;
    try {
        got = await fetchMe(fetchImpl, probe.base || '');
    } catch (err) {
        toast(`读不到 me.json：${err.message}`, 'error');
        return null;
    }

    const items = rosterAccountsFrom(AppState.accounts || {});
    const before = Array.isArray(got.doc && got.doc.accounts) ? got.doc.accounts : [];

    createModal({
        title: '📤 写进 me.json（爬虫用）',
        maxWidth: '680px',
        maxHeight: '82vh',
        content: `
            <div style="font-size:12px;color:#475569;line-height:1.7;">
                把应用里的「账户映射」导成 me.json 的名册形状
                （<code>cf: "..."</code> / <code>byYear: {"nk": {"2026": "..."}}</code>）。
                <b>凭据（apiKey / cookie）、说明（_note）、current 都不动</b> ——
                只有 <code>accounts</code> 这一节是按映射重算的。
            </div>
            ${previewHtml(items, before)}`,
        buttons: [
            { label: '取消', className: 'btn', callback: () => {} },
            {
                label: `确定写 ${items.length} 个人`,
                className: 'btn btn-primary',
                disabled: items.length === 0,
                callback: async () => {
                    const next = { ...got.doc, accounts: items };
                    try {
                        await saveMe(fetchImpl, probe.base || '', {
                            text: JSON.stringify(next, null, 2) + '\n',
                            sha256: got.sha256
                        });
                    } catch (err) {
                        toast(err.status === 409
                            ? 'me.json 刚被别处改过（没写）—— 重新载入再试'
                            : `写不进去：${err.message}`, 'error');
                        return false;
                    }
                    toast(`已写进 me.json：${items.length} 个人（凭据与说明没动）`, 'success');
                    if (typeof opts.onApplied === 'function') opts.onApplied();
                    return true;
                }
            }
        ]
    });
    return { items };
}
