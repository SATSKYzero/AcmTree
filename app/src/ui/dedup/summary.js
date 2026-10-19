// ================================================================
// 页尾小结（ui/dedup/summary.js）
//
// 数一数有多少合成节点、多少原料归入了、多少还散着。
//
// ★ 这里给出「合并显示」的**一键开关** `[不判重 / 判重]`
//   —— 写的就是**统计那边同一个设置键**（`settings.stats.countMode`），
//   绝不另造第二套口径；开了之后树上 / 检索的每题状态按**整组**显示（见 `view/scope.js`
//   的「合并显示」那一段）。
// ================================================================
import { nodeLabel, slice, runWrite, markGoto } from './kit.js';
import { mk } from '../../utils/dom.js';
// 悬停提示也是给人看的字 ⇒ 统一去 Markdown 记号（实现只有一份）
import { plain } from '../../utils/text.js';
import { AppState } from '../../shell/state.js';
import { resolveCountMode } from '../../core/query/countMode.js';
import { MODE_PLAIN, MODE_DEDUP } from '../../core/query/groupCount.js';

/**
 * `[不判重 / 判重]` 两个按钮（当前那个高亮）。
 *
 * ⚠️ 它改的是**全局设置** `settings.stats.countMode` —— 与「设置 → 📊 数据统计 → 计数模式」
 *    是**同一个键**（唯一一份口径）。改完走 `runWrite`：事务 + 全局刷新信号，
 *    树上 / 统计 / 检索一起跟着切。
 */
function modeToggle() {
    const box = mk('div', 'dedup-count-mode', 'margin-top:6px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;');
    const cur = resolveCountMode(AppState.settings);
    const label = mk('span', '', 'color:#64748b;');
    label.textContent = '显示口径：';
    box.appendChild(label);
    const mkBtn = (mode, text, title) => {
        const b = mk('button', 'btn', 'font-size:12px;padding:1px 8px;'
            + (cur === mode ? 'font-weight:700;border-color:#0ea5e9;color:#0369a1;' : ''));
        b.type = 'button';
        b.textContent = text;
        b.title = plain(title);
        b.disabled = (cur === mode);                  // 已经是这一档 ⇒ 不用再点（显式给布尔：DOM 桩里不赋值就是 undefined）
        b.addEventListener('click', () => {
            runWrite((draft) => {
                // 只改这一个设置键（与设置页那两个 radio 同一个键）
                draft.settings.stats.countMode = mode;
            }, mode === MODE_DEDUP
                ? '已切到「判重」：树上 / 检索按**整组**显示状态（一道题在别的平台 AC 了，这里也亮）'
                : '已切回「不判重」：每题只显示**它自己那份**');
        });
        return b;
    };
    box.appendChild(mkBtn(MODE_PLAIN, '不判重', '每题只显示它自己那份'));
    box.appendChild(mkBtn(MODE_DEDUP, '判重', '同组的状态合并成一份显示（树上 / 统计 / 检索一起切）'));
    return box;
}

export function summarySection(model) {
    const box = mk('div', '', 'font-size:12px;color:#64748b;border-top:1px solid #eef2f6;padding-top:8px;');
    const memberCount = model.groups.reduce((n, g) => n + g.memberIds.length, 0);
    box.textContent = `节点共 ${model.total} 个：合成节点 ${model.groups.length} 个、`
        + `已归入的原料 ${memberCount} 个、还没归入的原料 ${model.unowned.length} 个`
        + (model.dangling.length ? `、悬空指针 ${model.dangling.length} 个` : '')
        + '。';
    box.appendChild(modeToggle());
    const note = mk('div', '', 'margin-top:4px;');
    note.textContent = '「判重」下：同组的 P/C 计数、状态与信息**合并显示**'
        + '（树上、统计、检索一起切；编辑与导出**永远**用节点自己那份）。'
        + '这个开关与「设置 → 📊 数据统计 → 计数模式」是同一个设置。';
    box.appendChild(note);

    if (model.unowned.length) {
        const list = mk('div', 'dedup-unowned', 'margin-top:6px;font-size:12px;color:#475569;line-height:1.8;');
        const head = mk('span', '', 'color:#64748b;');
        head.textContent = `还没归入的原料（${model.unowned.length}）：`;
        list.appendChild(head);
        for (const id of slice(model.unowned, 'unowned')) {
            const tag = mk('span', '', 'display:inline-block;margin:0 6px 2px 0;');
            tag.textContent = nodeLabel(model.nodes[id]);
            // ★ 名字**点着能跳树**（与同页 ①②③⑤ 那几处同一条路，G6）：
            //   `markGoto` 挂 `data-reveal-node`（唯一承载）⇒ 全局那条文档级委托接住。
            //   ⚠️ 只有在**树上真有这个节点**时才挂 —— 节点没了就如实当纯文本
            //      （`ui/kit/report.js:nodeOrText` 的文件头："假链接比纯文本更糟"）。
            if (model.nodes[id]) markGoto(tag, id);
            list.appendChild(tag);
        }
        box.appendChild(list);
    }
    return box;
}
