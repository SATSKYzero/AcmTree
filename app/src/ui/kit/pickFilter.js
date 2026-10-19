// ================================================================
// 「按条件挑题」那四维条件的**共用件**（ui/kit/pickFilter.js）
//
// **唯一一份**：难度档 / 数值区间 / 标签 / 平台 —— 的选项名单 + 渲染 + 读回。
// 为什么要有它：这套条件现在有**两个编辑入口** ——
//   ① `ui/G_modal/G5_todoSheet.js`（按条件挑题 → 生成题单页）；
//   ② 计划设置卡里的「条件」那一栏（`ui/plan/planPage.js` 的 `[data-plan-cond-box]`，§13）。
// ⚠️ 以前还有第三个入口 `ui/plan/planDialog.js`（新建计划弹窗）—— `v9.4.16` 起
//    「副页⇄计划一对一、计划不增删」⇒ 那个弹窗已删，别照旧文档去找它。
// 两边各写一份 ⇒ 必然分叉（"挑题时能勾、计划里勾不到"）。
//
// ⚠️ **判据不在这里**：四维的唯一判据是 `core/problemPick.js:matchesProblemFilter`
//    （计划侧由 `core/trainingPlan.js:planProblemsOf` 调它）。这儿只管"画"与"读"。
// ⚠️ 这里**没有 `statuses`**：那是挑题弹窗自己的"状态筛选"，与计划的"算不算做完"
//    （`plan.statuses`）是**两件事** —— 别混（见 `core/ops/plan.js:normPick` 的文件头）。
// ⚠️ id 写法固定（`pick-cf-min` / `pick-cf-max` / `data-pick="level|tag|platform"`）：
//    这两处**不会同时在屏幕上**（都是弹窗），所以共用同一组 id 是安全的。
// ================================================================
import { AppState } from '../../shell/state.js';
import { XCPC_ORDER, XCPC_UNFILLED } from '../../utils/color.js';
import { XCPC_COLORS } from '../../A_constants.js';
import { escapeHtml } from '../../utils/html.js';
import { tagsUnder, platformsUnder } from '../../core/problemPick.js';

/** 一行多选芯片（HTML 串；`key` 就是 `data-pick` 那个值） */
export function chipRow(key, label, items, selected = []) {
    const on = (v) => selected.includes(v);
    const chips = items.map((it) => {
        const v = (it && typeof it === 'object') ? it.value : it;
        const text = (it && typeof it === 'object') ? it.label : it;
        // ★ 档名芯片也上色（色表仍是那一份 `XCPC_COLORS`；状态2/标签/平台不在表里 ⇒ 默认色）
        const color = XCPC_COLORS[text];
        return `<label style="display:inline-flex;align-items:center;gap:3px;margin:0 8px 4px 0;font-size:12px;color:#475569;cursor:pointer;">`
            + `<input type="checkbox" data-pick="${escapeHtml(key)}" value="${escapeHtml(v)}" ${on(v) ? 'checked' : ''}>`
            + `<span${color ? ` style="color:${color};"` : ''}>${escapeHtml(text)}</span></label>`;
    }).join('');
    return `<div style="margin-bottom:6px;"><div style="font-size:11px;color:#94a3b8;margin-bottom:2px;">${escapeHtml(label)}</div>`
        + `<div style="max-height:74px;overflow:auto;border:1px solid #eef2f6;border-radius:6px;padding:6px;">${chips || '<span style="font-size:11px;color:#cbd5e1;">（这个范围里没有可选值）</span>'}</div></div>`;
}

/** 难度档名单（易 → 难 + 哨兵「未填写」）—— 界面唯一的取处 */
export function levelItems() {
    return XCPC_ORDER.concat([XCPC_UNFILLED]).map((lv) => ({ value: lv, label: lv }));
}

/**
 * 四维条件的 HTML（**不含**"状态2"那两行 —— 那是挑题弹窗自己的事）。
 *
 * @param {{rootIds?:string[], initial?:Object, shownValue?:Function}} opts
 *        `rootIds` = 从哪几棵子树里收「可选值」（标签/平台）；空 = 整棵树
 *        （`tagsUnder` / `platformsUnder` 收的就是"这个范围里现有哪些值"）
 */
export function pickConditionHtml({ rootIds = [], initial = {}, shownValue } = {}) {
    const roots = (Array.isArray(rootIds) ? rootIds : []).filter((r) => r && AppState.nodes[r]);
    const scanIds = roots.length ? roots : [AppState.rootId];
    const tags = new Set();
    const plats = new Set();
    for (const rid of scanIds) {
        for (const t of tagsUnder(AppState, rid, { shownValue })) tags.add(t);
        for (const p of platformsUnder(AppState, rid, { shownValue })) plats.add(p);
    }
    return ''
        + chipRow('level', 'XCPC 档位（不勾 = 不限）', levelItems(), initial.levels || [])
        + `<div style="display:flex;gap:8px;align-items:flex-end;margin-bottom:6px;">
            <label style="font-size:11px;color:#94a3b8;">数值难度 ≥
                <input id="pick-cf-min" type="number" value="${escapeHtml(initial.cfMin)}" style="width:80px;padding:4px 6px;border:1px solid #d1d5db;border-radius:6px;font-size:12px;margin-left:4px;">
            </label>
            <label style="font-size:11px;color:#94a3b8;">≤
                <input id="pick-cf-max" type="number" value="${escapeHtml(initial.cfMax)}" style="width:80px;padding:4px 6px;border:1px solid #d1d5db;border-radius:6px;font-size:12px;margin-left:4px;">
            </label>
            <span style="font-size:11px;color:#94a3b8;">（留空 = 不限；设了区间 ⇒ 没填难度的题会被排除）</span>
        </div>`
        + chipRow('tag', '标签（不勾 = 不限；命中任意一个）', [...tags].sort(), initial.tags || [])
        + chipRow('platform', '平台 / 赛系（不勾 = 不限）', [...plats].sort(), initial.platforms || []);
}

/**
 * 从面板里读回四维条件（**唯一一份**）。
 * ⚠️ 读不到的维一律给**空**（= 不限）—— 绝不把 `''` 变成 `0`（那会变成"区间 0~0"，把所有题筛掉）。
 */
export function readPickCondition(panel) {
    const checked = (key) => [...panel.querySelectorAll(`[data-pick="${key}"]`)]
        .filter((el) => el.checked)
        .map((el) => el.value);
    const val = (id) => {
        const el = panel.querySelector('#' + id);
        return el ? String(el.value) : '';
    };
    return {
        levels: checked('level'),
        cfMin: val('pick-cf-min'),
        cfMax: val('pick-cf-max'),
        tags: checked('tag'),
        platforms: checked('platform')
    };
}
