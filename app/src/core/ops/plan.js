// ================================================================
// 训练计划操作（core/ops/plan.js）
//
// 职责：**新建 / 修改 / 删除**训练计划（`state.plans`）—— 只动"计划"这一块数据。
// 依赖：`_helpers.js`（id）、`ops/account.js`（只读守卫）、`utils/time.js`、`core/trainingPlan.js`（名单与归一化口径）。
//
// 只读边界：新建/改/删计划**同样是手改**（会随存档走、会进包）⇒ **每个写口都过
//   `assertManualEditAllowed`**，与 `tree.js` / `page.js` 完全对称。
//   ⚠️ 漏一个就是"只看别人时也能改"的系统性缺口 ⇒ 守卫名单里**必须**有这三个口
//   （`scripts/smoke/readonly-boundary.smoke.mjs`）。
//
// ⚠️ 计划里**只存形状**（用户 ⑦）：完成情况一律现算（`core/trainingPlan.js`），这里一个字节都不写。
// ⚠️ 计划**不碰副页**：题集就是它引用的那个副页里的题（㉒）。删副页**不删计划**（§10 ⑧）。
// ================================================================
import { assertManualEditAllowed } from './account.js';
import { nextIdOf } from './_helpers.js';
import { getNowStr } from '../../utils/time.js';
import {
    PLAN_GRAINS,
    DEFAULT_PLAN_GRAIN,
    DEFAULT_PLAN_STATUSES,
    INTENSITY_SOURCES,
    PLAN_SOURCES
} from '../trainingPlan.js';
// 老强度表（`byXcpc`）迁移要用到档位表那 20 个通过率上限（唯一一份）
import { XCPC_THRESHOLDS } from '../../A_constants.js';

/** 计划名上限（与副页名一样的尺度；长了界面放不下） */
export const PLAN_NAME_MAX = 40;

/** 新计划 id（走与副页/节点同一个计数器；⚠️ 要传 state —— 见 `_helpers.js` 文件头） */
export function nextPlanId(state) {
    return nextIdOf(state, 'plan_');
}

const normName = (v) => String(v === undefined || v === null ? '' : v).trim().slice(0, PLAN_NAME_MAX);

/** 粒度合法性：非法一律退回默认（日）—— 与 `core/acTimeRule.js` 对坏值的态度一致 */
const normGrain = (v) => (PLAN_GRAINS.includes(v) ? v : DEFAULT_PLAN_GRAIN);

/** 状态集合：数组、去重、只留 0..5 的整数；空 ⇒ 默认 [3,4] */
function normStatuses(v) {
    if (!Array.isArray(v)) return DEFAULT_PLAN_STATUSES.slice();
    const out = [];
    for (const x of v) {
        const n = Number(x);
        if (Number.isInteger(n) && n >= 0 && n <= 5 && !out.includes(n)) out.push(n);
    }
    return out.length ? out : DEFAULT_PLAN_STATUSES.slice();
}

/** 日期（`YYYY.MM.DD` 或空）；取不出就原样存空串（界面按"必填"提示，不在这儿猜） */
const normDay = (v) => {
    const s = String(v === undefined || v === null ? '' : v).trim();
    return /^\d{4}\.\d{2}\.\d{2}$/.test(s) ? s : '';
};

/** 字符串数组（去空、去重，保序）—— `pick.tags` / `pick.levels` / `pick.platforms` / `rootIds` 共用 */
function normStrList(v) {
    if (!Array.isArray(v)) return [];
    const out = [];
    for (const x of v) {
        const s = String(x === undefined || x === null ? '' : x).trim();
        if (s && !out.includes(s)) out.push(s);
    }
    return out;
}

/**
 * 范围条件（**只管"挑哪些题"这四个维度**）。
 *
 * ⚠️ **这里没有 `statuses`**：`matchesProblemFilter.statuses` 是"挑题那时的状态筛选"，
 *    而计划的"算不算做完"由 `plan.statuses` 定义 —— 两个 statuses 是**两件事**，别混。
 * ⚠️ 档位值**不校验成员资格**：认不出的档位在 `matchesProblemFilter` 里谁都不命中
 *    （失败方向是安全的），而档位名单的唯一一份在 `utils/color.js`，不在这一层抄。
 */
function normPick(v) {
    const r = (v && typeof v === 'object') ? v : {};
    // 空串 = "这一维不限"；**别把空串变成 0**（`Number('') === 0` ⇒ 会变成"区间 0~0"把所有题筛掉）
    const cf = (x) => {
        const s = String(x === undefined || x === null ? '' : x).trim();
        return (s !== '' && Number.isFinite(Number(s))) ? s : '';
    };
    return {
        levels: normStrList(r.levels),
        cfMin: cf(r.cfMin),
        cfMax: cf(r.cfMax),
        tags: normStrList(r.tags),
        platforms: normStrList(r.platforms)
    };
}

/**
 * 把**任意来源**（包里 / 老存档 / 界面草稿）的计划形状归一化 —— **唯一一份**。
 *
 * 为什么要它：`importedState` 直接搬包里的 `plans` ⇒ 坏值会一路进内存
 * （而"包可以手改"是这个项目**有意**留的口子）⇒ 归一化放在写入口这一处，
 * 界面与导入**共用同一份判据**（不再各写一遍 if）。
 *
 * @param {Object} raw
 * @returns {Object} 干净的计划形状（**不保证 `name`/`pageId` 非空** —— 那是 `addPlan`/`updatePlan` 的校验）
 */
export function normalizePlanShape(raw) {
    const r = (raw && typeof raw === 'object') ? raw : {};
    const goalRaw = (r.goal && typeof r.goal === 'object') ? r.goal : {};
    const value = Number(goalRaw.value);
    const rootIds = normStrList(r.rootIds);
    return {
        name: normName(r.name),
        pageId: String(r.pageId || ''),
        start: normDay(r.start),
        end: normDay(r.end),
        goal: {
            mode: (goalRaw.mode === 'count') ? 'count' : 'intensity',
            per: normGrain(goalRaw.per),
            value: Number.isFinite(value) && value > 0 ? value : 0
        },
        statuses: normStatuses(r.statuses),
        intensitySource: INTENSITY_SOURCES.includes(r.intensitySource) ? r.intensitySource : INTENSITY_SOURCES[0],
        intensityTableId: String(r.intensityTableId || ''),
        // ---- 题集（第 13 节）：范围根 + 四维条件；`source` 是**兼容字段**，由 `rootIds` 推出 ----
        // ⚠️ 用户 2026-10-14："「就用这个副页里的题」就是无选中时自动选超级根节点的逻辑"
        //    ⇒ 不再是"两条来源"，是**同一个旋钮**（空 = 超级根）。这个字段只为旧包/旧存档原地往返，
        //    **读的地方一律不看它**（`core/trainingPlan.js:planSourceOf` 也是从 `rootIds` 推的）。
        source: rootIds.length ? PLAN_SOURCES[1] : PLAN_SOURCES[0],
        rootIds,
        pick: normPick(r.pick),
        createdAt: String(r.createdAt || ''),
        lastModified: String(r.lastModified || '')
    };
}

/**
 * **默认初始状态**（用户 2026-10-15："计划不需要增删功能，位置也固定，只是需要默认初始状态"）。
 *
 * 口径（`docs/training-plan.md` 的「14. 2026-10-15 用户新反馈（三条 · 分析稿）」那一节）：
 * **计划是副页的一部分（一对一，内建）** —— 建一个副页就自带一份，值就是这套默认；
 * 用户之后在「计划设置」里改，**没有"新建计划 / 删除计划"这半边界面**。
 */
export const DEFAULT_PLAN_GOAL = Object.freeze({
    mode: 'intensity',
    per: DEFAULT_PLAN_GRAIN,
    value: 3
});

/**
 * 这个副页的**那一份**计划（一对一；没有 ⇒ `null`）。
 *
 * ⚠️ 这里是"一个副页对应哪份计划"的**唯一读口** —— 别再各处 `plans.filter(p => p.pageId === id)`
 *    （界面里以前这么写过；一对一口径定下来之后，那种写法会悄悄变成"取第一条"，两处必然分叉）。
 * ⚠️ 老数据即便真有多条（用户 2026-10-15 确认**没有**这种数据），这里也**只取第一条**、不当错误 ——
 *    读口要稳，清理该由写路径负责。
 *
 * @param {Object} state
 * @param {string} pageId
 * @returns {Object|null}
 */
export function planOfPage(state, pageId) {
    const id = String(pageId || '');
    if (!id) return null;
    const plans = (state && state.plans) || {};
    for (const pid of Object.keys(plans)) {
        const p = plans[pid];
        if (p && String(p.pageId || '') === id) return p;
    }
    return null;
}

/**
 * 给一个副页补上它那一份计划（**幂等**）：已经有了就原样返回，没有才按默认初始状态建一份。
 *
 * ⚠️ 只在**写路径**上调（`addPage` / `duplicatePage`）—— 它内部会走 `addPlan`，
 *    而 `addPlan` 有 `assertManualEditAllowed`（"只看别人"时会抛）。
 *    **别在渲染里调**：那样"看一眼只读模式"就会炸，而且渲染不该改数据。
 *
 * @param {Object} draft
 * @param {string} pageId
 * @returns {Object|null} 这一页的那份计划
 */
export function ensurePagePlan(draft, pageId) {
    const id = String(pageId || '');
    const page = draft && draft.pages ? draft.pages[id] : null;
    if (!page) return null;
    const existing = planOfPage(draft, id);
    if (existing) return existing;
    return addPlan(draft, {
        // 名字默认取副页名（可改）；副页名在 `addPage` 那关就是非空的，这里再兜一层
        name: normName(page.name) || '默认计划',
        pageId: id,
        start: getNowStr().split(' ')[0],
        goal: { ...DEFAULT_PLAN_GOAL }
    });
}

function requirePage(draft, pageId) {
    const id = String(pageId || '');
    if (!id) throw new Error('请先选一个副页当题单（计划必须绑一个副页）');
    if (!draft.pages || !draft.pages[id]) throw new Error('题单页不存在');
    return id;
}

/**
 * 新建计划。
 *
 * @param {Object} draft
 * @param {{name:string, pageId:string, [k:string]:*}} data
 * @returns {Object} 建好的那一条（含 `id`）
 */
export function addPlan(draft, data = {}) {
    assertManualEditAllowed(draft, '新建训练计划');
    const shape = normalizePlanShape(data);
    if (!shape.name) throw new Error('计划名称不能为空');
    const pageId = requirePage(draft, data.pageId);
    if (!shape.start) throw new Error('要填一个开始时间（YYYY.MM.DD）');
    if (!(shape.goal.value > 0)) throw new Error('目标值要大于 0');
    if (!draft.plans) draft.plans = {};
    const id = nextPlanId(draft);
    const now = getNowStr();
    draft.plans[id] = { ...shape, id, pageId, createdAt: now, lastModified: now };
    return draft.plans[id];
}

/**
 * 改计划（**只改传进来的字段**；`id` 不给改）。
 *
 * @param {Object} draft
 * @param {string} planId
 * @param {Object} patch 允许的键：`name` / `pageId` / `start` / `end` / `goal` / `statuses` /
 *        `intensitySource` / `intensityTableId` / `source` / `rootIds` / `pick`
 *        ⚠️ `pageId` 对**两种来源都必填**（`range` 型计划也绑一个副页当"落点/展示位"——
 *        计划栏只在绑定副页上显示是第 1 轮定的口径）
 * @returns {Object} 改完那一条
 */
export function updatePlan(draft, planId, patch = {}) {
    assertManualEditAllowed(draft, '修改训练计划');
    const plan = draft.plans && draft.plans[planId];
    if (!plan) throw new Error('计划不存在');
    // 先在**合并后的形状**上归一化（唯一一份判据），再挑允许的键写回
    const merged = normalizePlanShape({ ...plan, ...patch, id: plan.id });
    if (!merged.name) throw new Error('计划名称不能为空');
    if ('pageId' in patch) merged.pageId = requirePage(draft, patch.pageId);
    if (!merged.start) throw new Error('要填一个开始时间（YYYY.MM.DD）');
    if (!(merged.goal.value > 0)) throw new Error('目标值要大于 0');
    const keepId = plan.id;
    Object.assign(plan, merged, { id: keepId, lastModified: getNowStr() });
    return plan;
}

/**
 * 删计划。
 *
 * ⚠️ **只删计划这一条**：不碰副页（那个题单页留着，它可能还绑着别的计划、也可能你还想手改它）。
 * @returns {boolean}
 */
export function deletePlan(draft, planId) {
    assertManualEditAllowed(draft, '删除训练计划');
    if (!draft.plans || !draft.plans[planId]) throw new Error('计划不存在');
    delete draft.plans[planId];
    return true;
}

// ----------------------------------------------------------------
// 强度映射表库（⑮：全局若干张、每张有名字；计划引用一张）
// ----------------------------------------------------------------

/** 表 id（走同一个计数器；⚠️ 同样要传 state） */
export function nextIntensityTableId(state) {
    return nextIdOf(state, 'ti_');
}

/** 控制点数组归一化（升序；`null`/空 = 「+∞」那一点排最后；负数/非数丢掉） */
function normalizePoints(raw) {
    const out = [];
    if (!Array.isArray(raw)) return out;
    for (const row of raw) {
        if (!row || typeof row !== 'object') continue;
        const val = Number(row.value);
        if (!Number.isFinite(val) || val < 0) continue;
        const max = (row.max === null || row.max === undefined || row.max === '') ? null : Number(row.max);
        out.push({ max: Number.isFinite(max) ? max : null, value: val });
    }
    // ⚠️ **必须升序**：`core/trainingPlan.js:intensityAtPoints` 按"点之间线性插值"读它
    //    ⇒ 顺序乱了曲线会来回折（用户手填/导入的顺序都可能乱）。`null`（= +∞）永远排最后。
    out.sort((a, b) => {
        const am = (a.max === null) ? Infinity : a.max;
        const bm = (b.max === null) ? Infinity : b.max;
        return am - bm;
    });
    return out;
}

/**
 * 老表（`byXcpc`：档位 → 强度）**迁到新曲线**（`byRatio`：通过率上限 → 强度）。
 * 每个档位那一点落在**它自己的通过率上限**上 —— 形状与老表逐档对齐，只是从台阶变成折线。
 */
function pointsFromLegacyXcpc(byXcpc) {
    const out = [];
    if (!byXcpc || typeof byXcpc !== 'object') return out;
    for (const t of XCPC_THRESHOLDS) {
        const v = Number(byXcpc[t.level]);
        if (Number.isFinite(v) && v >= 0) out.push({ max: Number(t.upper), value: v });
    }
    return normalizePoints(out);
}

function normalizeTableShape(raw) {
    const r = (raw && typeof raw === 'object') ? raw : {};
    // ★ `v9.1.38`：XCPC 侧从"按档位的台阶表"改成"按通过率的控制点折线"；
    //   老表（只有 `byXcpc`）在这里**迁一次**，形状与原来逐档对齐（见 `pointsFromLegacyXcpc`）
    let byRatio = normalizePoints(r.byRatio);
    if (!byRatio.length) byRatio = pointsFromLegacyXcpc(r.byXcpc);
    const byCf = normalizePoints(r.byCf);
    // ★ `v9.1.45`（用户第 12 轮："未填写的不计入 因为有热身赛等"）：`defaultValue` **不再有**——
    //   没填难度的题强度直接记 0。⚠️ 老存档里那个字段**照旧留着不管**（读的时候不看它），
    //   这里也不再写出来；别为它加迁移。
    return {
        name: normName(r.name) || '强度表',
        byRatio,
        byCf,
        // 点之间怎么相接：`'exp'`（指数段，默认）| `'line'`（线段）| `'smooth'`（单调三次）
        mode: (r.mode === 'smooth') ? 'smooth' : ((r.mode === 'line') ? 'line' : 'exp')
    };
}

/** 加一张强度表（`settings.trainingIntensityTables`） */
export function addIntensityTable(draft, data = {}) {
    assertManualEditAllowed(draft, '新建强度映射表');
    const shape = normalizeTableShape(data);
    const list = draft.settings.trainingIntensityTables;
    if (!Array.isArray(list)) draft.settings.trainingIntensityTables = [];
    if (draft.settings.trainingIntensityTables.some((t) => t && t.name === shape.name)) {
        throw new Error(`强度表「${shape.name}」已存在`);
    }
    const table = { ...shape, id: nextIntensityTableId(draft) };
    draft.settings.trainingIntensityTables.push(table);
    return table;
}

/** 改一张强度表（`id` 不给改；改名撞车也拦） */
export function updateIntensityTable(draft, tableId, patch = {}) {
    assertManualEditAllowed(draft, '修改强度映射表');
    const list = draft.settings.trainingIntensityTables || [];
    const hit = list.find((t) => t && t.id === tableId);
    if (!hit) throw new Error('强度表不存在');
    const merged = normalizeTableShape({ ...hit, ...patch });
    if (list.some((t) => t && t.id !== tableId && t.name === merged.name)) {
        throw new Error(`强度表「${merged.name}」已存在`);
    }
    Object.assign(hit, merged, { id: tableId });
    return hit;
}

/** 删一张强度表（⚠️ 引用它的计划**不删** —— 会退回内置默认表，界面要说清） */
export function deleteIntensityTable(draft, tableId) {
    assertManualEditAllowed(draft, '删除强度映射表');
    const list = draft.settings.trainingIntensityTables || [];
    const idx = list.findIndex((t) => t && t.id === tableId);
    if (idx < 0) throw new Error('强度表不存在');
    list.splice(idx, 1);
    return true;
}
