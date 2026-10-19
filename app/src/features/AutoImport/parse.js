// ================================================================
// 节点自动导入 — crate 解析与适配器调度（features/AutoImport/parse.js）
// 职责：把「成熟 crate」或「平台原生载荷」统一解析成规范化记录
// 依赖：./constants.js、./adapters/qoj.js
// 设计依据：docs/auto-import.md 7.1–7.5 / 7.7 / 9.2
//
// 分界（11.2）：本模块只做**结构与字段名**处理，
//   语义判定（父引用解析、匹配、合并）全在下游 plan.js ——
//   这条分界让"解析"与"决策"可以分别单测。
//
// 粒度（9.2）：
//   - **整包**错误（crate:null）：无数据、crateVersion 不符、records 为空。
//   - **逐条**错误（记录被剔除、其余照常）：节点类型非法、身份键缺失
//     （没有 extKey **且**没有 synthKey —— 合成节点只有后者）。
//   - fieldMap 缺失记 error 但**不**整包报废；包内列名不在 fieldMap 里
//     只记 warning（按未使用字段处理，14）。
//
// 关于 applyFieldMap：
//   `opts.applyFieldMap(record, fieldMap, opts)` 可以注入（应用走的就是注入那条）；
//   **没注入就用 `./fieldmap.js` 的那一份**（另抄一份"极小等价实现"必然要写
//   "必须与 fieldmap.js 行为一致"这种注释 —— 手抄镜像迟早分叉，
//   而分叉的症状是"离线试跑说字段在、导入后却是空的"，极难发现 ⇒ 只留一份）。
//
// 说明：本模块**不碰 DOM、不 import view/ shell/**，可在 Node 测试中直接引用。
// ================================================================
import { SUPPORTED_CRATE_VERSIONS, NODE_TYPES, isValidNodeType } from './constants.js';
import { toCrate as qojToCrate } from './adapters/qoj.js';
import { isPlainObject } from '../../utils/guards.js';

// ================================================================
// 常量
// ================================================================

// 身份/结构列：永不进内部字段，也永不参与"未使用字段"警告。
// ⚠️ 清单**只有一处**（`fieldmap.js` 的 `RESERVED_KEYS`，`type` 已在其中）—— 自己抄一份
//    就会差着 `type`、靠调用点现拼来对齐。
// ⚠️ `applyFieldMap` 也从这个模块 import：**fieldMap 的解析只有这一份实现**。
import { RESERVED_KEYS as STRUCTURAL_KEYS, applyFieldMap as applyFieldMapShared,
    validateFieldMap } from './fieldmap.js';
import { WRITABLE_FIELDS } from './constants.js';

/** qoj 原生载荷的中文列名特征（detectAdapter 用） */
const QOJ_COLUMNS = Object.freeze(['题号', '题目名称', '题目ID', '提交ID']);

// ================================================================
// 工具
// ================================================================

/** 是普通对象（非 null、非数组） *//**
 * 包顶层的**随包报告**（`reports.coverage` = 字段体检 / `reports.needs` = 原料需求 /
 * `reports.baseline` = 回代核对）。
 *
 * 形状由构建侧的 `scripts/field-coverage.py` / `material-needs.py` / `nature-baseline.py` 决定
 * （它们本来就写 JSON，这里只是**原样带过来**）。各节都可缺 —— 缺了返回 `null`
 * （界面那页会说一句，不是错误）。
 *
 * ⚠️ **这里是一份白名单**：新加一节报告时**必须在这里放行**，
 *    否则它会被静默丢掉 —— 现象是"包里明明有 `reports.baseline`，③ 那一行却说还没有核对"。
 */
function reportsOf(crateInput) {
    const raw = isPlainObject(crateInput) ? crateInput.reports : null;
    if (!isPlainObject(raw)) return null;
    const out = {};
    if (isPlainObject(raw.coverage) && Array.isArray(raw.coverage.rows)) out.coverage = raw.coverage;
    if (isPlainObject(raw.needs) && Array.isArray(raw.needs.needs)) out.needs = raw.needs;
    // 回代核对（`nature-baseline.py` 写的）：只要求是对象，别的不挑（形状变了也不该整节丢掉）
    if (isPlainObject(raw.baseline)) out.baseline = raw.baseline;
    return Object.keys(out).length ? out : null;
}

/** 取第一个非空字符串（trim 后），全空返回 '' */
function pickString(...values) {
    for (const v of values) {
        if (v === undefined || v === null) continue;
        const s = String(v).trim();
        if (s !== '') return s;
    }
    return '';
}

/** 规范化 source：缺省 `{ id:'unknown', label:'' }`，其余字段原样保留 */
function buildSource(src) {
    const base = isPlainObject(src) ? src : {};
    const id = pickString(base.id);
    return Object.assign({}, base, {
        id: id === '' ? 'unknown' : id,
        label: base.label === undefined || base.label === null ? '' : String(base.label)
    });
}

/**
 * 应用 fieldMap：优先用注入的实现，没注入就用 `./fieldmap.js` 的那一份（唯一实现）
 *
 * 另起一份 `applyFieldMapLocal` 的写法必然要写
 * "必须与 `fieldmap.js` 的 `applyFieldMap` 行为一致"这种注释 —— 手抄镜像迟早分叉，
 * 分叉症状是"离线试跑说字段在、导入后却是空的"（极难发现）⇒ 只留一份。
 */
function applyFieldMap(record, fieldMap, opts) {
    if (opts && typeof opts.applyFieldMap === 'function') {
        // ⚠️ 注入者返回的是 `{fields, ignored, unmapped}`（`plan/prepare.js` 的契约，
        //    `index.js` 与各测试的 `afm` 都这么写）—— 这里只能取 `fields`。
        //    ⚠️ 两条路形状不同（注入路把**整个外壳**当成了字段表）就会出同一种病：
        //    "只由 fieldMap 给出身份"的记录会被**静默丢掉**
        //    （`parse.js` 后面读 `fields.synthKey` 读不到 ⇒ `missing-extkey`）。
        const out = opts.applyFieldMap(record, fieldMap, opts);
        if (isPlainObject(out && out.fields)) return out.fields;
        return isPlainObject(out) ? out : {};
    }
    const out = applyFieldMapShared(record, fieldMap);
    return isPlainObject(out) && isPlainObject(out.fields) ? out.fields : {};
}

// ================================================================
// 成熟 crate 判定
// ================================================================

/**
 * 这是不是一个**成熟 crate**（自带 crateVersion + records + fieldMap）？
 *
 * 成熟 crate 走 `parseCrate` 的**快路径**，不需要任何适配器；
 * 也正因如此，`detectAdapter` 对它必须返回 null。
 *
 * @param {Object} data
 * @returns {boolean}
 */
export function isCrate(data) {
    if (!isPlainObject(data)) return false;
    if (data.crateVersion === undefined || data.crateVersion === null) return false;
    if (!Array.isArray(data.records)) return false;
    if (!isPlainObject(data.fieldMap)) return false;
    return true;
}

// ================================================================
// 适配器注册与探测
// ================================================================

/**
 * 结构适配器注册表。
 * 适配器只做**结构**归一（顶层是数组还是对象、extKey 怎么拼），
 * **不猜字段语义**——语义一律由包内 fieldMap 声明（7.3 / 7.7）。
 * 每个适配器签名：`(data, opts) → { ok, crate, errors }`。
 */
export const ADAPTER_REGISTRY = Object.freeze({
    qoj: qojToCrate
});

/**
 * 探测平台原生载荷该用哪个适配器（没有则 null）。
 *
 * 刻意保守：成熟 crate（带 crateVersion 的对象）一律返回 null，
 * 让它走快路径，绝不被适配器改写。
 *
 * @param {Object} data
 * @returns {string|null}
 */
export function detectAdapter(data) {
    try {
        if (!isPlainObject(data) && !Array.isArray(data)) return null;
        if (isCrate(data)) return null;
        if (isPlainObject(data) && data.crateVersion !== undefined) return null;

        const list = Array.isArray(data)
            ? data
            : Array.isArray(data.problems)
                ? data.problems
                : Array.isArray(data.submissions)
                    ? data.submissions
                    : null;
        if (!list || list.length === 0) return null;

        const sample = list.find(r => isPlainObject(r));
        if (!sample) return null;

        return Object.keys(sample).some(k => QOJ_COLUMNS.includes(k)) ? 'qoj' : null;
    } catch (e) {
        return null;
    }
}

// ================================================================
// 解析
// ================================================================

/**
 * 解析导入包。
 *
 * `data` 可以是成熟 crate，也可以是平台原生载荷（此时先经适配器转成 crate）。
 *
 * 规范化记录的形状（下游统一消费）：
 *   `{ index, type, extKey, synthKey, parentExtKey, parentSynthKey, fields, raw }`
 *   - `index` 是它在 `records` 里的**原始下标**（0 基），错误信息也用它；
 *   - `type` / `extKey` / `synthKey` / `parentExtKey` / `parentSynthKey` 为规范拼写
 *     （接受 `节点类型` / `type`、`extKey`、`synthKey`、`父extKey` / `parentExtKey`、
 *     `父synthKey` / `parentSynthKey`）；
 *   - `parentExtKey` 为空串 ⇒ 挂根（3.3，根不进 extKey 体系）；
 *   - `parentSynthKey` 是**父引用的另一种写法**（父是合成节点）：
 *     与 `parentExtKey` **恰好给一个** —— 都空 = 挂根；两个都有 = 由
 *     `resolve.js` 逐条拒绝（"父引用只能给一个"）。本层只做**结构**归一，
 *     不做语义判定（8.2 的分界）。
 *   - `fields` 是 fieldMap 映射后的内部字段；`raw` 是原始记录。
 *
 * @param {Object} data - 解析好的 JSON
 * @param {Object} [opts]
 * @param {string} [opts.adapter] - 强制指定适配器名（不合法则回落自动探测）
 * @param {Function} [opts.applyFieldMap] - 注入的 fieldMap 实现 (record, fieldMap, opts) → fields
 * @returns {{
 *   ok: boolean,
 *   errors: Array<{code:string, message:string, index?:number}>,
 *   warnings: Array<{code:string, message:string, index?:number}>,
 *   crate: Object|null
 * }}
 */
export function parseCrate(data, opts = {}) {
    const errors = [];
    const warnings = [];
    const options = isPlainObject(opts) ? opts : {};

    /** 整包报废 */
    const failWhole = (code, message) => {
        errors.push({ code, message });
        return { ok: false, errors, warnings, crate: null };
    };

    try {
        // 注意：这里**刻意允许数组**——平台原生载荷的顶层就是数组（7.7），
        // 由下面的适配器调度把它转成 crate。只挡 null / 基本类型。
        if (data === null || data === undefined || typeof data !== 'object') {
            return failWhole('no-data', '导入数据为空或不是对象/数组，无法解析');
        }

        // ---------------- 适配器（仅结构归一，7.7） ----------------
        let crateInput = data;
        let adapterName = null;

        if (!isCrate(data)) {
            const forced = pickString(options.adapter);
            const name = forced !== '' && typeof ADAPTER_REGISTRY[forced] === 'function'
                ? forced
                : detectAdapter(data);

            if (name && typeof ADAPTER_REGISTRY[name] === 'function') {
                const result = ADAPTER_REGISTRY[name](data, options);
                if (!result || result.ok !== true || !isPlainObject(result.crate)) {
                    const list = result && Array.isArray(result.errors) && result.errors.length
                        ? result.errors
                        : [{ code: 'adapter-failed', message: `适配器「${name}」未能生成 crate` }];
                    for (const e of list) {
                        errors.push({
                            code: pickString(e && e.code) || 'adapter-failed',
                            message: e && e.message !== undefined ? String(e.message) : ''
                        });
                    }
                    return { ok: false, errors, warnings, crate: null };
                }
                crateInput = result.crate;
                adapterName = name;
            }
        }

        // ---------------- crate 级校验（9.2 整包粒度） ----------------
        const rawVersion = crateInput.crateVersion;
        const version = rawVersion === undefined || rawVersion === null ? NaN : Number(rawVersion);
        if (!SUPPORTED_CRATE_VERSIONS.includes(version)) {
            return failWhole(
                'bad-crate-version',
                `不支持的 crateVersion：「${String(rawVersion)}」；本版本仅支持 ${SUPPORTED_CRATE_VERSIONS.join(' / ')}（版本不符整包报错，不猜）`
            );
        }

        if (!Array.isArray(crateInput.records) || crateInput.records.length === 0) {
            return failWhole('no-records', 'crate.records 缺失或为空数组（7.2 要求非空）');
        }

        let fieldMap = {};
        if (!isPlainObject(crateInput.fieldMap)) {
            // 不整包报废：把字段名记下来即可，本次没有任何列被映射
            errors.push({
                code: 'no-fieldmap',
                message: 'crate.fieldMap 缺失或不是对象：本次所有列都按未使用字段处理（7.3）'
            });
        } else {
            fieldMap = crateInput.fieldMap;
            // ★ **映射表要校验**（`validateFieldMap` 一直有、但**全仓没人调**）：
            //   列名映射到一个**不在白名单里**的内部名（`{"题目":"nam"}` 这种拼错 / 手写包映射到
            //   派生字段）时，`merge.js` 会把它当"不在 WRITABLE_FIELDS 里"**直接过滤掉，
            //   连一条 decision 都不产生** ⇒ 值不进节点、不进来源层、不算"未使用字段"、也不报错。
            //   这就是最纯的"静默丢"。这里把 findings 逐条接进 errors/warnings：
            //   `unknown-target`（映射到不存在的字段）**算错误** —— 那个列的值一定丢。
            for (const f of validateFieldMap(fieldMap, WRITABLE_FIELDS)) {
                if (f.code === 'unknown-target' || f.code === 'bad-target-type') {
                    errors.push({ code: `fieldmap-${f.code}`, message: `${f.message}（该列的值会被丢弃）` });
                } else {
                    warnings.push({ code: `fieldmap-${f.code}`, message: f.message });
                }
            }
        }

        // ---------------- 逐条校验（9.2 逐条粒度） ----------------
        const records = [];
        const reportedColumns = new Set();

        crateInput.records.forEach((record, index) => {
            if (!isPlainObject(record)) {
                errors.push({ code: 'bad-record', message: `第 ${index} 条：记录不是对象，已剔除`, index });
                return;
            }

            const type = pickString(record['节点类型'], record.type).toUpperCase();
            if (!isValidNodeType(type)) {
                errors.push({
                    code: 'bad-type',
                    message: `第 ${index} 条：节点类型「${pickString(record['节点类型'], record.type)}」不合法（应为 ${NODE_TYPES.join(' / ')}），已剔除`,
                    index
                });
                return;
            }

            const fields = applyFieldMap(record, fieldMap, options);

            // 合成：**合成节点没有 `extKey`**（它的身份是 `synthKey`，见 docs/manual-workflow.md（合成节点的指针））。
            // 所以"缺 extKey"不等于非法 —— 带 `synthKey` 的记录本身就是合法的一条
            // （包格式必须能表达"这条记录是合成节点"，不为兼容再造第二套格式）。
            // 两个字段可以来自列名 `synthKey`，也可以由 fieldMap 映射到内部名 `synthKey`。
            const extKey = pickString(record.extKey);
            const synthKey = pickString(record.synthKey, fields.synthKey);
            if (extKey === '' && synthKey === '') {
                errors.push({
                    code: 'missing-extkey',
                    message: `第 ${index} 条：extKey 缺失或 trim 后为空，也没有 synthKey，`
                        + '无身份键即拒绝（4.4；合成节点用 synthKey 作身份）',
                    index
                });
                return;
            }

            const parentExtKey = pickString(record['父extKey'], record.parentExtKey);
            const parentSynthKey = pickString(record['父synthKey'], record.parentSynthKey);

            // 未使用字段：包里出现过、fieldMap 未映射的列（只记列名不记值，14）
            for (const column of Object.keys(record)) {
                if (STRUCTURAL_KEYS.includes(column)) continue;
                if (Object.prototype.hasOwnProperty.call(fieldMap, column)) continue;
                if (reportedColumns.has(column)) continue;
                reportedColumns.add(column);
                warnings.push({
                    code: 'unmapped-column',
                    message: `列「${column}」不在 fieldMap 中，按未使用字段处理（只记列名，不导入值）`,
                    index
                });
            }

            records.push({
                index,
                type,
                extKey,
                // 合成节点的身份（空串 = 它不是合成节点）。下游的"两阶段解析"
                // 靠它认人：先建/更新合成节点，再处理指向它们的成员指针。
                synthKey,
                parentExtKey,
                // 父引用的另一种写法（父是合成节点）。语义判定不在这里 ——
                // "恰好给一个"、"两边都找不到就拒绝"都由 resolve.js 裁定（8.2 的分界）。
                parentSynthKey,
                fields,
                raw: record
            });
        });

        // ---------------- 产出 ----------------
        const crate = {
            crateVersion: version,
            source: buildSource(crateInput.source),
            generatedAt: typeof crateInput.generatedAt === 'string' ? crateInput.generatedAt : '',
            fieldMap,
            fieldPolicies: isPlainObject(crateInput.defaults) && isPlainObject(crateInput.defaults.fieldPolicies)
                ? crateInput.defaults.fieldPolicies
                : {},
            records,
            adapter: adapterName,
            // 包顶层带的「**应有**」注册表（`fieldRegistry`）——
            //   字段条上要显示「应有 / 已有」（"每个字段条都有『是否应有』『是否已有』……"）。
            //   ⚠️ **可选**：没有它（别的包/裁剪过的包）`crate.fieldRegistry = null`，
            //   界面那一路自然不显示这一行，**不是错误、不报警**。
            fieldRegistry: isPlainObject(crateInput.fieldRegistry) && isPlainObject(crateInput.fieldRegistry.fields)
                ? crateInput.fieldRegistry : null,
            // 包顶层带的**体检报告**（`reports.coverage` / `reports.needs`）——
            //   给「🩺 体检 / 需求」那一页用（界面直接读它）。
            //   ⚠️ **可选**：没有它（老包/裁剪过的包）`crate.reports = null`，
            //   那一页会说一句"这个包没带体检报告（重建一次包就有）"，**不是错误、不报警**。
            reports: reportsOf(crateInput)
        };

        // 记录级错误不整包报废（9.2）；只有 crate 级错误才 crate:null
        return { ok: true, errors, warnings, crate };
    } catch (err) {
        errors.push({
            code: 'internal-error',
            message: `解析导入包时发生内部错误：${err && err.message ? err.message : String(err)}`
        });
        return { ok: false, errors, warnings, crate: null };
    }
}
