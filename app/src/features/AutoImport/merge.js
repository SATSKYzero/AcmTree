// ================================================================
// 节点自动导入 — 逐字段策略合并（features/AutoImport/merge.js）
// 职责：空值判定、策略解析与校验、按策略算出「本次要写的字段」
// 依赖：./constants.js
// 设计依据：docs/auto-import.md 6.1 / 6.2 / 6.3
//
// 三条载重规则（写错任何一条都会毁数据）：
//   1) 字段在本次记录里**缺失** ≡ **不改该字段**（6.3）。
//      绝不允许「记录里没有 → 把节点上该字段清空」。
//   2) 不在 WRITABLE_FIELDS 里的字段在**任何策略之前**就被丢弃，
//      永远不会出现在 fields 里（派生字段/结构字段由核心重算）。
//   3) remark（ALWAYS_NEVER_FIELDS）**任何情况**都不由导入写，
//      新建与合并都不写——它是本应用里唯一不可再生的数据。
//
// 说明：本模块**不碰 DOM、不 import view/ shell/**，可在 Node 测试中直接引用。
// ================================================================
import {
    POLICY,
    VALID_POLICIES,
    WRITABLE_FIELDS,
    CREATE_POLICY_DEFAULTS,
    EXISTING_POLICY_DEFAULTS,
    ALWAYS_NEVER_FIELDS
} from './constants.js';
import { normalizeTime } from '../../utils/time.js';
import { isPlainObject } from '../../utils/guards.js';
// 「哪几格是时间」的真源（元素表）—— 见下面 `TIME_FIELDS` 的说明
import { ELEMENTS } from '../../core/model/elements.js';

/** 时间占位符（未提交过的时间槽位） */
const EMPTY_TIME_PLACEHOLDER = '----.--.-- --:--';

/**
 * 时间类字段：写入前必须标准化
 *
 * 为什么必要：爬虫给的是平台原生格式（如 `2026-09-13 22:06:07`），
 * 而应用内部的时间比较全是**字符串比较**（`computePacTime` 用 `sort()`、
 * `computePlastSubmitTime` 用 `>`）。格式不统一，比较就是错的。
 * `normalizeTime` 是核心已有的纯函数（utils/time.js），
 * 它把 12/14 位数字统一成 `YYYY.MM.DD HH:MM`。
 *
 * ⚠️ **不手写清单**：哪几格是时间，由元素表（`core/model/elements.js`）的
 *    `format: 'time'` 说了算 —— 以后再加时间字段（提交时间之外的）不用回来改这里，
 *    也不会出现"声明是时间、合并时没标准化"这种两边不一致。
 */
const TIME_FIELDS = Object.freeze(
    Object.entries(ELEMENTS).filter(([, def]) => def.format === 'time').map(([field]) => field)
);

/**
 * 把时间值标准化为 `YYYY.MM.DD HH:MM`；无法解析时**原样返回**
 * （宁可存一个可疑值让用户看见，也不要静默丢弃）
 * @param {*} value
 * @returns {*}
 */
function normalizeTimeValue(value) {
    if (value === undefined || value === null || value === '') return value;
    try {
        const res = normalizeTime(value);
        if (res && res.valid) {
            return res.isEmpty ? '' : res.value;
        }
    } catch (e) {
        // 落到下面原样返回
    }
    return value;
}

/**
 * R（提交记录）在**已存在节点**上的策略（6.2 的 R 表）。
 *
 * 为什么 R 要单独一张表：R 一条记录只对应一个 R（身份是 提交ID），
 * 它上面**没有手工整理的数据**，所以「保持最新」优先于「保护存量」——
 * 判题结果 PD → AC 必须能更新，这条路径是 P 的 status2 能自动变准的前提（7.6）。
 *
 * 注意：这里**故意只列 `time` / `status`**，不列 `link`、也不列那四个运行字段。
 * `link` / `language` / `timeUsed` / `memoryUsed` / `codeLength` 的已存在策略由
 * `EXISTING_POLICY_DEFAULTS`（constants.js）统一给 `fill-if-empty` ——
 * 即"只补空、绝不动已有的值"，所以这里不重复列它们（重复列反而要担心两表打架）。
 * ⚠️ "`link` 不在该表内" ≠ "第二次导入不覆盖链接"：它走 `fill-if-empty` ——
 * 空着的链接会在重导时补上；手填过的仍然不动。
 */
const R_EXISTING_DEFAULTS = Object.freeze({
    time: POLICY.OVERWRITE_IF_CHANGED,
    status: POLICY.OVERWRITE_IF_CHANGED
});

// ================================================================
// 小工具
// ================================================================

/** 是普通对象（非 null、非数组） *//** 取自有属性（避免 Object.prototype 上的键被误认为候选字段） */
function hasOwn(obj, key) {
    return isPlainObject(obj) && Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * 浅比较两个值是否相等（数组/对象走 JSON.stringify，见 6.1 的 overwrite-if-changed）
 * @param {*} a
 * @param {*} b
 * @returns {boolean}
 */
function valuesEqual(a, b) {
    if (a === b) return true;
    if (a === undefined || a === null || b === undefined || b === null) return false;
    if (typeof a !== 'object' && typeof b !== 'object') return false;
    try {
        return JSON.stringify(a) === JSON.stringify(b);
    } catch (e) {
        return false;
    }
}

// ================================================================
// 空值
// ================================================================

/**
 * 这个值对 `fill-if-empty` 而言算不算「空」？
 *
 * 空：`''`（含纯空白）/ `null` / `undefined` / `0` / `'-'` /
 *     `'----.--.-- --:--'`（未提交的时间占位符）/ `[]`。
 *
 * ⚠️ **与 `elements.isEmptyFieldValue` / `trust.isEmptyValue` 是两套口径，别合并**
 *    （避免下一个改代码的人把它"统一"掉）：
 *
 *    | 函数 | 回答的问题 | `0` | `'-'` | 占位符 |
 *    |---|---|---|---|---|
 *    | **本函数** `merge.isEmptyValue` | "这个位置**能不能被导入填上**" | 空 | 空 | 空 |
 *    | `elements.isEmptyFieldValue` / `trust.isEmptyValue` | "这个值**算不算有内容**（要不要参与投影）" | 非空 | 非空 | 非空 |
 *
 *    为什么不一样：导入看的是**缓存字段的"没填"状态**（`cfDifficulty:0` 就是"未填写难度"、
 *    `'-'` 是"还没判"），这些该被数据填上；而投影看的是**来源值有没有内容** ——
 *    `'-'` 是**有意义的标记**（"未填写"），当空会让界面从"未填写"变"什么都没有"。
 *    两边各自成立，契约由 `src/test/mergeEmptiness.test.js` 钉住。
 *
 * 注意 `0` 算空是**刻意的**：`cfDifficulty: 0` 表示「未填写难度」，
 * 而不是「难度为零」，所以它必须允许被导入填上（6.2）。
 *
 * @param {*} value
 * @returns {boolean}
 */
export function isEmptyValue(value) {
    if (value === undefined || value === null) return true;
    if (value === 0) return true;
    if (Array.isArray(value)) return value.length === 0;
    if (typeof value === 'string') {
        const s = value.trim();
        return s === '' || s === '-' || s === EMPTY_TIME_PLACEHOLDER;
    }
    return false;
}

// ================================================================
// 策略解析
// ================================================================

/**
 * 解析一个内部字段名的策略。
 *
 * 优先级：ALWAYS_NEVER / 非白名单（→ never，覆盖无法复活）
 *        → `overrides[field]`（合法时）
 *        → 默认表（nodeExists ? EXISTING_POLICY_DEFAULTS : CREATE_POLICY_DEFAULTS）
 *        → POLICY.NEVER
 *
 * @param {string} field - 内部字段名（fieldMap 映射之后的名字）
 * @param {boolean} nodeExists - 目标节点是否已存在
 * @param {Object} [overrides] - crate 的 defaults.fieldPolicies，按内部字段名索引
 * @returns {string} POLICY.* 之一
 */
export function resolvePolicy(field, nodeExists, overrides) {
    return resolvePolicyWithTable(
        field,
        nodeExists ? EXISTING_POLICY_DEFAULTS : CREATE_POLICY_DEFAULTS,
        overrides
    );
}

/**
 * resolvePolicy 的内部实现：允许换用类型相关的默认表（R 用 R_EXISTING_DEFAULTS）
 * @param {string} field
 * @param {Object} table
 * @param {Object} [overrides]
 * @returns {string}
 */
function resolvePolicyWithTable(field, table, overrides) {
    const name = field === undefined || field === null ? '' : String(field);

    // 不可写 / 永不写 —— 覆盖无法复活它们（6.2 的 ❌ 行 + 规则 6）
    if (ALWAYS_NEVER_FIELDS.includes(name)) return POLICY.NEVER;
    if (!WRITABLE_FIELDS.includes(name)) return POLICY.NEVER;

    // 包内覆盖
    if (hasOwn(overrides, name) && VALID_POLICIES.includes(overrides[name])) {
        return overrides[name];
    }

    // 默认表
    const dflt = isPlainObject(table) ? table[name] : undefined;
    if (VALID_POLICIES.includes(dflt)) return dflt;

    return POLICY.NEVER;
}

/** 取「已存在节点」要用的默认表（R 额外叠一层 6.2 的 R 表） */
function existingTableFor(type) {
    if (String(type === undefined || type === null ? '' : type).trim().toUpperCase() === 'R') {
        return Object.assign({}, EXISTING_POLICY_DEFAULTS, R_EXISTING_DEFAULTS);
    }
    return EXISTING_POLICY_DEFAULTS;
}

// ================================================================
// 计算合并
// ================================================================

/**
 * 算出一条记录要写的字段 + 每个候选字段的决策（供预览表显示字段级 diff）。
 *
 * 只读：不修改 `incoming` / `existing`，也不抛异常。
 *
 * @param {Object} params
 * @param {string} params.type - 节点类型（'R' 会启用提交记录的默认表）
 * @param {Object} params.incoming - 记录映射后的内部字段
 * @param {Object|null} params.existing - 已存在的节点；新建时为 null
 * @param {Object} [params.overrides] - crate 的 defaults.fieldPolicies
 * @returns {{
 *   fields: Object,
 *   decisions: Array<{field:string, policy:string, applied:boolean, reason:string, oldValue:*, newValue:*}>
 * }}
 */
export function computeMerge({ type, incoming, existing, overrides } = {}) {
    const fields = {};
    const decisions = [];

    // 记录里没有任何字段 ⇒ 什么也不改（规则 1 / 10）
    if (!isPlainObject(incoming)) return { fields, decisions };

    const nodeExists = isPlainObject(existing);
    const table = nodeExists ? existingTableFor(type) : CREATE_POLICY_DEFAULTS;

    // 候选字段 = 记录里出现的、且在白名单内的字段（规则 2：非白名单直接丢弃）
    const candidates = Object.keys(incoming).filter(f => WRITABLE_FIELDS.includes(f));

    for (const field of candidates) {
        const rawValue = incoming[field];
        // 时间字段先标准化：应用内部的时间比较是字符串比较，
        // 格式不统一会比较错（见文件头 TIME_FIELDS 的说明）
        const newValue = TIME_FIELDS.includes(field) ? normalizeTimeValue(rawValue) : rawValue;
        const oldValue = nodeExists ? existing[field] : undefined;

        // 显式 undefined ⇒ 视同「没提供」，不改（规则 1）
        if (newValue === undefined) {
            decisions.push({
                field,
                policy: POLICY.NEVER,
                applied: false,
                reason: '记录里该字段为 undefined，视同未提供：不改动',
                oldValue,
                newValue
            });
            continue;
        }

        let policy = resolvePolicyWithTable(field, table, overrides);
        let prefix = '';

        // 规则 6：非法覆盖值一律忽略（保守起见该字段本次不写），并留下决策痕迹
        if (hasOwn(overrides, field) && !VALID_POLICIES.includes(overrides[field])) {
            policy = POLICY.NEVER;
            prefix = `覆盖策略「${String(overrides[field])}」不是合法策略，已忽略；`;
        }

        let applied = false;
        let reason = '';

        switch (policy) {
            case POLICY.NEVER:
                reason = `${prefix}策略 never：本次不写入`;
                break;

            case POLICY.FILL_IF_EMPTY:
                if (isEmptyValue(oldValue)) {
                    applied = true;
                    reason = `${prefix}当前值为空，fill-if-empty 写入`;
                } else {
                    reason = `${prefix}当前值非空，fill-if-empty 不覆盖`;
                }
                break;

            case POLICY.OVERWRITE_IF_CHANGED:
                if (valuesEqual(oldValue, newValue)) {
                    reason = `${prefix}值未变化，overwrite-if-changed 跳过`;
                } else {
                    applied = true;
                    reason = nodeExists
                        ? `${prefix}值已变化，overwrite-if-changed 覆盖`
                        : `${prefix}新建节点，overwrite-if-changed 写入`;
                }
                break;

            case POLICY.FORCE:
                applied = true;
                reason = `${prefix}策略 force：无条件写入`;
                break;

            default:
                policy = POLICY.NEVER;
                reason = `${prefix}策略无法识别，按 never 处理：本次不写入`;
                break;
        }

        if (applied) fields[field] = newValue;

        decisions.push({ field, policy, applied, reason, oldValue, newValue });
    }

    return { fields, decisions };
}

// ================================================================
// 覆盖表校验（供预览报"包内配置有问题"）
// ================================================================

/**
 * 校验 crate 的 `defaults.fieldPolicies`。
 *
 * 只报告，不修正：未知策略一律被忽略（见 computeMerge 规则 6），
 * 非白名单字段的覆盖**不可能生效**，因为候选字段在策略之前就被过滤掉了。
 *
 * @param {Object} overrides
 * @returns {Array<{code:string, message:string, field?:string}>}
 */
export function validateFieldPolicies(overrides) {
    const findings = [];
    if (!isPlainObject(overrides)) return findings;

    for (const field of Object.keys(overrides)) {
        const value = overrides[field];

        if (ALWAYS_NEVER_FIELDS.includes(field)) {
            findings.push({
                code: 'always-never',
                field,
                message: `字段「${field}」永不由导入写入，覆盖策略无效（题解是不可再生数据）`
            });
            continue;
        }

        if (!WRITABLE_FIELDS.includes(field)) {
            findings.push({
                code: 'not-writable',
                field,
                message: `字段「${field}」不可由导入写入（派生字段或结构字段），覆盖策略无效`
            });
            continue;
        }

        if (!VALID_POLICIES.includes(value)) {
            findings.push({
                code: 'unknown-policy',
                field,
                message: `字段「${field}」的策略「${String(value)}」不是合法策略（合法值：${VALID_POLICIES.join(' / ')}）`
            });
        }
    }

    return findings;
}
