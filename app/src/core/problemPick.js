// ================================================================
// 「按条件挑题」（core/problemPick.js）
//
// 干什么：给一个**子树根**，按条件挑出要放进题单的题 —— 这是"筛选放在更靠前的环节"那一步
//   （设计稿 `docs/training-plan.md` ㉒㉓："题单形成时挑好，计划那边不再筛"）。
// 谁在用：`ui/G_modal/G5_actions.js:promptTodoProblemSheet`（既有的「📋 待办题单」入口，**扩它、不新造**）。
//
// 依赖：`core/query/stats.js:collectByType`（子树收集唯一一份）、`core/fieldRegistry.js:difficultyValueOf`
//       （数值难度唯一一份）、`utils/color.js:XCPC_ORDER`（档位名单唯一一份）。
//
// ⚠️ **状态/难度一律按显示口径读**（调用方传 `opts.shownValue`）：
//    判重模式下同一组只推一条、且状态读的是"组那份"——与树上看到的一致。
// ⚠️ 本文件**不写状态**：它只回答"挑中哪些题"，写进副页是 `core/ops/page.js:batchCopyToPage` 的事。
// ================================================================
import { collectByType } from './query/stats.js';
import { difficultyValueOf } from './fieldRegistry.js';
import { XCPC_ORDER, XCPC_UNFILLED } from '../utils/color.js';

/** 挑题条件的默认值（= 老的「未通过/待处理」那一条，行为一字不改） */
export const DEFAULT_PICK_FILTER = {
    statuses: [0, 1, 2],        // 未使用 / 待写 / 已提交未通过
    includeUnhandled: true,     // 「已处理」没勾的也算（status1 === 0）
    levels: [],                 // XCPC 档位（空 = 不限）
    cfMin: '',                  // 数值难度下限（空 = 不限）
    cfMax: '',                  // 数值难度上限（空 = 不限）
    tags: [],                   // 标签（空 = 不限；命中任意一个即可）
    platforms: []               // 平台 / 赛系（取 `natureClass` 的第一段，如 `cf`、`qoj`）
};

/**
 * 空值 ⇒ `null`（= "这一维不限"）。
 * ⚠️ **别写成 `Number.isFinite(Number(v)) ? Number(v) : null`** —— `Number('')` 是 **0**，
 *    于是"上限留空"会变成"区间 0~0"，把**所有**题筛掉（2026-10-13 冒烟/单测当场抓到）。
 */
const num = (v) => {
    if (v === '' || v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};

/** 把 `tags` 的两种形状（来源层 `string[]` / 缓存 `[{id,text,color}]`）都归一成字符串数组 */
export function tagNamesOf(raw) {
    if (!raw) return [];
    const list = Array.isArray(raw) ? raw : String(raw).split(/[,，\s]+/);
    const out = [];
    for (const t of list) {
        const name = (t && typeof t === 'object') ? (t.text || t.id || '') : t;
        const s = String(name === undefined || name === null ? '' : name).trim();
        if (s && !out.includes(s)) out.push(s);
    }
    return out;
}

/** 平台/赛系：取 `natureClass`（`a/b/c`）的第一段；空 ⇒ 空串 */
export function platformOf(natureClass) {
    const s = String(natureClass === undefined || natureClass === null ? '' : natureClass).trim();
    if (!s) return '';
    return s.split('/')[0] || '';
}

/**
 * **四维条件**（档位 / 数值难度区间 / 标签 / 平台）的判据 —— **唯一一份**。
 *
 * 两个消费者：`pickProblemsOf`（挑题弹窗）与训练计划内层页的「题目列表筛选」（`ui/plan/planBlocks.js`）。
 * ⚠️ 空数组/空串 = 那一维**不限**；多条之间"与"、同一条内"或"。
 * ⚠️ 数值区间一旦设了，**没填难度**（值为 0 / 未定）的题**排除**并单独报 `unknown-difficulty`
 *    （别静默当成 0 分）。
 *
 * @param {Object} node
 * @param {Object} filter 见 `DEFAULT_PICK_FILTER`（这里只读 `levels`/`cfMin`/`cfMax`/`tags`/`platforms`）
 *        ⚠️ `levels` 里可以带哨兵 `utils/color.js:XCPC_UNFILLED`（「未填写」）——
 *        界面把它做成一个勾选项（训练计划页的列表筛选、挑题弹窗都列它）。
 * @param {{shownValue?:(n:Object,f:string)=>*, difficultyValueOf?:Function, state?:Object}} ctx
 * @returns {{ok:boolean, drop?:'level'|'cf'|'unknown-difficulty'|'tag'|'platform'}}
 */
export function matchesProblemFilter(node, filter = {}, ctx = {}) {
    const shownValue = ctx.shownValue || ((n, field) => (n ? n[field] : undefined));
    const diffOf = ctx.difficultyValueOf || difficultyValueOf;
    const levels = (Array.isArray(filter.levels) ? filter.levels : []).map((x) => String(x));
    const tags = (Array.isArray(filter.tags) ? filter.tags : []).map((x) => String(x).trim()).filter(Boolean);
    const platforms = (Array.isArray(filter.platforms) ? filter.platforms : []).map((x) => String(x).trim()).filter(Boolean);
    const cfMin = num(filter.cfMin);
    const cfMax = num(filter.cfMax);
    const hasCf = cfMin !== null || cfMax !== null;

    if (levels.length) {
        const levelRaw = shownValue(node, 'xcpcDifficulty');
        // ⚠️ 认不出的档位一律算「未填写」（哨兵值唯一一份：`utils/color.js:XCPC_UNFILLED`）——
        //   这样"勾上未填写"才有意义（否则它会变成"谁都不命中"）；
        //   而**没勾**未填写时，未填写/乱填的题照样被排除（失败方向仍然是安全的）。
        const level = XCPC_ORDER.includes(levelRaw) ? levelRaw : XCPC_UNFILLED;
        if (!levels.includes(level)) return { ok: false, drop: 'level' };
    }
    if (hasCf) {
        const diff = diffOf(ctx.state || {}, node, { shownValue: (n, f) => shownValue(n, f) }).value;
        if (!(diff > 0)) return { ok: false, drop: 'unknown-difficulty' };
        if (cfMin !== null && diff < cfMin) return { ok: false, drop: 'cf' };
        if (cfMax !== null && diff > cfMax) return { ok: false, drop: 'cf' };
    }
    if (tags.length) {
        const own = tagNamesOf(shownValue(node, 'tags'));
        if (!tags.some((t) => own.includes(t))) return { ok: false, drop: 'tag' };
    }
    if (platforms.length) {
        const plat = platformOf(shownValue(node, 'natureClass'));
        if (!platforms.includes(plat)) return { ok: false, drop: 'platform' };
    }
    return { ok: true };
}
/**
 * 按条件挑题（**挑题弹窗**那条主路；四维的判据在 `matchesProblemFilter`）。
 *
 * @param {Object} state
 * @param {string} rootId 子树根（挑它下面的题）
 * @param {Object} [filter] 见 `DEFAULT_PICK_FILTER`
 * @param {{shownValue?:(n:Object,f:string)=>*}} [opts]
 *        ⚠️ `shownValue` **必须**由界面传（`viewDerivedDisplay(...) ?? viewValue(...)`）；
 *        省略时退化成直读节点字段（只给测试/脚本用）。
 * @returns {{matched:Object[], total:number, byStatus:Object, unknownDifficulty:number,
 *            droppedByLevel:number, droppedByCf:number, droppedByTag:number, droppedByPlatform:number}}
 */
export function pickProblemsOf(state, rootId, filter = {}, opts = {}) {
    const f = { ...DEFAULT_PICK_FILTER, ...(filter || {}) };
    const shownValue = opts.shownValue || ((n, field) => (n ? n[field] : undefined));
    const statuses = (Array.isArray(f.statuses) ? f.statuses : DEFAULT_PICK_FILTER.statuses).map(Number);
    // ⚠️ **不把"乱填的档位"过滤掉**（别偷偷变成"不限"）：留着它 ⇒ 谁都不命中 ⇒ **挑不中**
    //    （安全的失败方向；过滤掉会变成"把全部题都给你"，那才危险）
    const levels = (Array.isArray(f.levels) ? f.levels : []).map((x) => String(x));
    const tags = (Array.isArray(f.tags) ? f.tags : []).map((x) => String(x).trim()).filter(Boolean);
    const platforms = (Array.isArray(f.platforms) ? f.platforms : []).map((x) => String(x).trim()).filter(Boolean);
    const cfMin = num(f.cfMin);
    const cfMax = num(f.cfMax);
    const hasCf = cfMin !== null || cfMax !== null;

    const all = collectByType(state, rootId, 'P');
    const matched = [];
    const byStatus = {};
    let unknownDifficulty = 0;
    let droppedByLevel = 0;
    let droppedByCf = 0;
    let droppedByTag = 0;
    let droppedByPlatform = 0;

    // 四维条件（档位 / 数值区间 / 标签 / 平台）的**判据**抽成一份 ——
    // 训练计划内层页的"题目列表筛选"也用这几个维度（第 3 轮"筛选满血"）⇒ 别各写一遍。
    const context = { shownValue, state, difficultyValueOf };

    for (const p of all) {
        const s2raw = shownValue(p, 'status2');
        const s2 = Number.isFinite(Number(s2raw)) ? Number(s2raw) : 0;
        const s1 = Number(shownValue(p, 'status1')) || 0;
        // ① 状态：在名单里，或者"还没处理过"（与老口径一字不差）
        const okStatus = statuses.includes(s2) || (f.includeUnhandled && s1 === 0);
        if (!okStatus) continue;

        // ②~⑤ 四个维度走**同一份判据**（与计划页的列表筛选共用）
        const verdict = matchesProblemFilter(p, f, context);
        if (!verdict.ok) {
            if (verdict.drop === 'level') droppedByLevel++;
            else if (verdict.drop === 'cf') droppedByCf++;
            else if (verdict.drop === 'tag') droppedByTag++;
            else if (verdict.drop === 'platform') droppedByPlatform++;
            else if (verdict.drop === 'unknown-difficulty') unknownDifficulty++;
            continue;
        }

        matched.push(p);
        byStatus[s2] = (byStatus[s2] || 0) + 1;
    }

    return { matched, total: all.length, byStatus, unknownDifficulty, droppedByLevel, droppedByCf, droppedByTag, droppedByPlatform };
}

/** 现有条件里出现过的平台/赛系（给界面做下拉；从**挑题的根**那棵子树里收） */
export function platformsUnder(state, rootId, opts = {}) {
    const shownValue = opts.shownValue || ((n, field) => (n ? n[field] : undefined));
    const out = [];
    for (const p of collectByType(state, rootId, 'P')) {
        const plat = platformOf(shownValue(p, 'natureClass'));
        if (plat && !out.includes(plat)) out.push(plat);
    }
    return out.sort();
}

/** 现有条件里出现过的标签（给界面做多选；来源层 `tags` 与缓存 `tags` 都认） */
export function tagsUnder(state, rootId, opts = {}) {
    const shownValue = opts.shownValue || ((n, field) => (n ? n[field] : undefined));
    const out = [];
    for (const p of collectByType(state, rootId, 'P')) {
        for (const t of tagNamesOf(shownValue(p, 'tags'))) if (!out.includes(t)) out.push(t);
    }
    return out.sort();
}
