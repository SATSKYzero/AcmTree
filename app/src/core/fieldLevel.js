// ================================================================
// 逐字段「依据级别」（core/fieldLevel.js）
//
// 字段来源的可信优先级设定覆盖**所有字段**。
//
// ⚠️ 别把它和「优先级」混为一谈 —— 这是**两件事**：
//   · **优先级**（`core/trust.js` 的 `KIND_RANK` / `state.trust`）决定"谁的值胜出"；
//   · **级别**（本文件）回答"**这一格的值凭什么、有多硬**"，给界面显示与"依据弱要复核"筛选。
//   nature 那四个字段的级别来自规则 id（`CLASS_RULE_LEVEL`，见 `natureConfidence.js`），
//   其它字段按来源类别定级 —— 同一张来源面板上，region 与 ratio 都有徽标。
//
// 级别的**唯一口径**（与 nature 那套字母表同一套，`CONFIDENCE_LEVELS`）：
//   M = 人改的
//   A = 权威榜单 / 官方来源（`kind: board`）
//   B = 脚本从原始数据抓的（`kind: script`）
//   C = 我们自己算出来的（`kind: derived`）
//   D = 旧数据回填（`local:v7`，不知原始出处）
//   '' = 不知道（没有来源信息时**不瞎猜**）
//
// 取级别的顺序（从精确到粗略）：
//   ① nature 字段有**规则 id**（`分类依据` 那一列）⇒ 用规则级别（最精确，能到 A…E）
//   ② `src` 是人工 ⇒ M
//   ③ `src` 是旧回填 ⇒ D
//   ④ 否则按**来源类别**（`state.sources[src].kind`）定级
// ================================================================

import { SOURCE_KINDS } from './trust.js';
import { BACKFILL_SRC } from './fieldValue.js';
import { classRuleOf, levelOfClassRule } from './natureConfidence.js';

/** 来源类别 → 级别（表格只有这一份；加类别就在这里加一行） */
export const KIND_LEVEL = Object.freeze({
    [SOURCE_KINDS.MANUAL]: 'M',
    [SOURCE_KINDS.BOARD]: 'A',
    [SOURCE_KINDS.SCRIPT]: 'B',
    [SOURCE_KINDS.DERIVED]: 'C'
});

/** 旧数据回填（`local:v7`）的级别 —— 比任何抓来的都软，但比"没有"硬 */
export const BACKFILL_LEVEL = 'D';

/** 级别 → 人话理由（界面 `title` 直接用它） */
export const LEVEL_REASON = Object.freeze({
    M: '人改的',
    A: '权威榜单 / 官方来源',
    B: '脚本从原始数据抓的',
    C: '我们自己算出来的（派生）',
    D: '旧数据回填（不知原始出处）',
    E: '占位 / 合成'
});

/** 来源类别 → 级别；不认识的类别 ⇒ `''`（不瞎猜） */
export function levelOfSourceKind(kind) {
    return KIND_LEVEL[kind] || '';
}

/** 级别 → 人话；未知级别返回 `''` */
export function levelReason(level) {
    return LEVEL_REASON[level] || '';
}

/**
 * 这一格的值**凭什么**（级别 + 为什么 + 一句现成的悬停说明）。
 *
 * @param {Object} state - 用于查来源注册表（`state.sources[src].kind`）
 * @param {string} src - 这条候选值的来源 id（来源面板逐行都给得出）
 * @param {string} field - 字段名（内部名，如 `ratio` / `natureRegion`）
 * @param {Object} [node] - 节点（nature 字段要从它的 `分类依据` 读规则 id）
 * @returns {{level:string, kind:string, rule:string, why:string, note:string}}
 *          `level === ''` 表示"不知道"（没有来源信息 / 认不出来源类别）；
 *          `note` 是**直接用**的那句悬停说明 —— 界面别再按级别字母去查表
 *          （同一套字母对 nature 字段是**规则级别**、对别的字段是**来源类别**，两套含义）。
 */
export function fieldLevelOf(state, src, field, node = null) {
    // ① 规则 id 最精确：nature 那四个字段有（`分类依据` → 规则表）
    const rule = node ? classRuleOf(node, field) : '';
    if (rule) {
        const level = levelOfClassRule(rule);
        return { level, kind: '', rule, why: `按规则 ${rule}`, note: fieldLevelNote(level, `按规则 ${rule}`) };
    }
    // ② / ③ 人工、旧回填
    if (src === SOURCE_KINDS.MANUAL) {
        return { level: 'M', kind: SOURCE_KINDS.MANUAL, rule: '', why: LEVEL_REASON.M, note: fieldLevelNote('M') };
    }
    if (src === BACKFILL_SRC) {
        return {
            level: BACKFILL_LEVEL, kind: '', rule: '', why: LEVEL_REASON[BACKFILL_LEVEL],
            note: fieldLevelNote(BACKFILL_LEVEL)
        };
    }
    // ④ 按来源类别
    const kind = (state && state.sources && state.sources[src] && state.sources[src].kind) || '';
    const level = levelOfSourceKind(kind);
    return { level, kind, rule: '', why: level ? LEVEL_REASON[level] : '没有来源信息', note: fieldLevelNote(level) };
}

/**
 * 界面用的一行说明（`级别 X：为什么`）；未知级别返回 `''`。
 *
 * @param {string} level 级别字母
 * @param {string} [why] 理由 —— **给了就用它**（例：nature 字段的"按规则 `gym:infer-region`"）。
 *        ⚠️ 不传时按字母查 `LEVEL_REASON`，那只对**来源类别**那一套字母成立；
 *        **规则级别**的字母含义不同（同一字母两套解释），必须把 `why` 传进来。
 */
export function fieldLevelNote(level, why = '') {
    const text = why || levelReason(level);
    return level && text ? `依据级别 ${level}：${text}` : '';
}
