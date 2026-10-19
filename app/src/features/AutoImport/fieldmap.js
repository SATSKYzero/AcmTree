// ================================================================
// 节点自动导入 — fieldMap 应用与校验（features/AutoImport/fieldmap.js）
// 职责：
//   1. applyFieldMap        —— 把一条记录的列名解析成内部字段名（7.3）
//   2. validateFieldMap     —— 校验包内 fieldMap 声明本身是否可用
//   3. collectUnusedColumns —— 汇总整包的「未使用字段」列名（只记名不记值，决策 14）
// 依赖：./constants.js（WRITABLE_FIELDS）
// 说明：
//   - 这是「字段由爬虫命名、应用却能套用策略」的那座桥（7.3）：
//     解析后键名统一为**内部字段名**，6.2 的策略表照常按内部名索引
//   - 语义一律由包内 fieldMap **显式声明**，绝不按列名猜（7.3、决策 13）；
//     唯一的例外是"列名本身就是内部字段名"——那不是猜，是直接命中
//   - 记录里**缺失**的列不产出字段（缺失 ≡ 本次不改，见 6.3），
//     因此这里永不写出空值
// 设计依据：docs/auto-import.md 6.3 / 7.1 / 7.3，决策 13 / 14
// ================================================================
import { WRITABLE_FIELDS as WRITABLE_FIELDS_LIST } from './constants.js';
import { isPlainObject } from '../../utils/guards.js';

/** 内部字段名集合（恒等兜底用） */
const WRITABLE_FIELDS = new Set(WRITABLE_FIELDS_LIST);

/**
 * 结构性键：它们不是业务列，既不算映射、也不算「未使用字段」。
 * 与 crate 记录级字段（7.4）对应；`parentExtKey` 是应用内部的同义写法。
 *
 * `字段来源`：合成包（crate-merge）用它记"每个字段是谁给的"
 * （`{ 列名: 来源id }`）。它是**元数据**，不是业务列 ——
 * 不放进这里的话，每次导入都会冒出一句"未使用字段：字段来源"，
 * 而它其实是**已经被用掉**的信息（进了来源层）。
 */
const DEFAULT_RESERVED_KEYS = Object.freeze([
    '节点类型',
    // `type`：**应用里**那条记录是什么（包里写 `节点类型`）—— 同一件事的两种写法。
    // ⚠️ `type` 必须在**这一份**里：各处现拼 `[...RESERVED_KEYS, 'type']`
    //    （应用 / 冒烟 / 单测各拼一遍）等于加一个结构键要记得改两处。
    'type',
    'extKey', '父extKey', 'parentExtKey', '字段来源',
    // **父引用的另一种写法** —— 父是合成节点时给 `父synthKey`
    // （身份是 `synthKey` 而不是 extKey；见 parse.js 与 resolve.js）。
    // 与 `父extKey` 一样是结构列：不映射成字段、也不报"未使用字段"。
    '父synthKey', 'parentSynthKey',
    // 账户线索（`{source, field, value}`）—— 元数据，不是业务列
    '账户线索',
    // 落选值（`{ 列名: [{v, src}] }`）—— 同字段多个来源各说各话时，合并层把没被采用的
    // 值连同**它自己的来源**记在这里，应用逐值写进来源层（"各来源信息尽可能提取"）
    '其它来源值',
    // **链接分类**（`{ 类别: [{v, src}] }`）—— C 的链接按用途记账（榜单/补题/仓库/其它）。
    // 爬取层**只记录、不取舍**（同一类别有多条就全列着），缓存值 `link`
    // 由应用层从这里派生。同样不放进这里的话，每次导入都会冒一句"未使用字段：链接分类"。
    '链接分类',
    // **分类依据**（`{ natureClass: 'xcpc:name-stage' }`）—— 记录"这条分类是
    // 哪条规则判出来的"，应用侧查级别表（`core/natureConfidence.js`）画依据强度徽标。
    // 元数据，不是业务列：不放进这里 → 每次导入都会冒一句"未使用字段：分类依据"。
    '分类依据'
]);

/**
 * 结构键的**唯一权威清单**（给脚本/工具复用）。
 *
 * 为什么要导出：这份清单散在多处（本文件、`parse.js` 的 STRUCTURAL_KEYS、
 * `scripts/crate-check.mjs` 的 RESERVED，以及各处的注释）就必然漏 ——
 * 漏掉 CLI 那一份，"已经被用掉的信息"就会被报成"未使用字段"。
 * ⚠️ **只有这一份** —— `parse.js` / `plan/prepare.js` / `index.js`
 *    都 import 它，各处也**不**现拼 `[...RESERVED_KEYS, 'type']`（`type` 已在这一份里）。
 * 新加结构键：**只改这里**。
 */
export const RESERVED_KEYS = DEFAULT_RESERVED_KEYS;

/** 是不是一个可当作字段表使用的普通对象（数组不算） *//** 自身是否带该键（不查原型链） */
function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
}

/** 消息里引用一个名字 */
function quote(value) {
    return `"${value === undefined || value === null ? '' : String(value)}"`;
}

/** 把非法映射值描述成人能看懂的形式（含 undefined / 对象 / 数字） */
function describeValue(value) {
    if (value === undefined) return 'undefined';
    if (value === null) return 'null';
    if (typeof value === 'string') return `字符串 ${quote(value)}`;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    try {
        return JSON.stringify(value);
    } catch {
        return Object.prototype.toString.call(value);
    }
}

/** 白名单的可读列表（用于消息） */
function allowedList(allowed) {
    return allowed.length > 0 ? allowed.join(' / ') : '（无）';
}

// ================================================================
// 应用映射（7.3）
// ================================================================

/**
 * 对**一条**记录应用 crate 的 fieldMap。
 *
 * 语义（7.3）：
 *   - `fields`   —— 内部字段名 → 值；只收**映射值是非空字符串**且记录里确实有的列
 *   - `ignored`  —— 映射为 `null` 的列（显式忽略），已排序
 *   - `unmapped` —— 根本没出现在 fieldMap 里的列（「未使用字段」），已排序
 *
 * 其它约定：
 *   - `reservedKeys`（默认见上）是结构元数据，既不进 `ignored` 也不进 `unmapped`
 *   - 两个列映射到同一内部字段时，**fieldMap 键序靠后者胜出**，不抛异常
 *   - `record` 不是对象 → 三项皆空；`fieldMap` 缺失 → 全部列进 `unmapped`
 *
 * @param {Object} record - crate 里的原始记录（爬虫/中文列名）
 * @param {Object} fieldMap - { 爬虫列名: 内部字段名 | null }
 * @param {Object} [opts]
 * @param {string[]} [opts.reservedKeys] - 结构键；默认见本文件顶部的 `DEFAULT_RESERVED_KEYS`（12 项：
 *        节点类型 / type / extKey / 父extKey / parentExtKey / 父synthKey / 字段来源 / 账户线索 /
 *        其它来源值 / 链接分类 / 分类依据 / …）
 * @returns {{ fields: Object, ignored: string[], unmapped: string[] }}
 */
export function applyFieldMap(record, fieldMap, opts) {
    const result = { fields: {}, ignored: [], unmapped: [] };

    // 防御：记录不是对象 → 什么都没得映射
    if (!isPlainObject(record)) return result;

    const options = isPlainObject(opts) ? opts : {};
    const reserved = new Set(
        Array.isArray(options.reservedKeys)
            ? options.reservedKeys.map(key => String(key))
            : DEFAULT_RESERVED_KEYS
    );
    const map = isPlainObject(fieldMap) ? fieldMap : null;

    // 记录里实际出现的列（结构键不算列）
    const columns = Object.keys(record).filter(column => !reserved.has(column));

    // ---- 显式忽略 / 未使用字段：按**记录里实际出现的列**判定 ----
    for (const column of columns) {
        if (!map || !hasOwn(map, column)) {
            result.unmapped.push(column);
        } else if (map[column] === null) {
            result.ignored.push(column);
        }
        // 出现在 fieldMap 但值既不是 null 也不是非空字符串（undefined / 数字 / 空串）：
        // 声明本身有误（由 validateFieldMap 报 bad-target-type），
        // 此处既不当成映射，也不记成「未使用字段」
    }

    // ---- 字段映射 ----
    //
    // ⚠️ 两条解析路径，**声明的映射优先**：
    //
    //   1. `fieldMap` 声明的列 → 映射到内部字段名（按 fieldMap 键序，后写覆盖先写）
    //   2. **列名本身就是内部字段名** → 直接采纳（恒等兜底）
    //
    // 第 2 条为什么必要：导入包有两种合理写法 ——
    //   - 爬虫用自己的列名（`题号`），必须靠 fieldMap 翻译；
    //   - 直接写内部字段名（`problemId`），这时**不需要**任何声明。
    // 只认第 1 条的话，手写包里 `problemId` 这种列会被**静默丢弃**：
    // 包看着正常，导入后字段却是空的（crate-merge 冒烟测试正是覆盖这条）。
    //
    // 保留"声明优先"是为了不破坏既有语义：fieldMap 明确说了怎么映射，就照它办。
    if (map) {
        for (const column of Object.keys(map)) {
            if (reserved.has(column)) continue;      // 结构键不是业务列
            if (!hasOwn(record, column)) continue;   // 记录里没有该列 ⇒ 不写空（6.3）

            const target = map[column];
            if (typeof target !== 'string' || target === '') continue;

            result.fields[target] = record[column];
        }
    }

    for (const column of columns) {
        if (hasOwn(result.fields, column)) continue;   // 已被显式映射认领
        if (map && hasOwn(map, column)) continue;      // 该列在 fieldMap 里有声明（含 null=忽略）
        if (WRITABLE_FIELDS.has(column)) {
            result.fields[column] = record[column];    // 恒等兜底：列名即内部字段名
        }
    }

    result.ignored.sort();
    result.unmapped.sort();
    return result;
}

// ================================================================
// 校验声明本身
// ================================================================

/**
 * 校验一份 fieldMap 声明。
 *
 * findings 的 code：
 *   - `empty-map`         —— fieldMap 不是对象，或没有自有键
 *   - `unknown-target`    —— 映射到了白名单之外的内部字段
 *   - `bad-target-type`   —— 映射值既不是 null 也不是非空字符串
 *                            （`undefined` 只在键确实存在并显式为 undefined 时报）
 *   - `duplicate-target`  —— 两个列映射到同一个非 null 内部字段
 *
 * 注意：本函数只报声明问题，**不改数据、不抛异常**；`empty-map` 时直接返回，
 * 不再叠加其它噪音。
 *
 * @param {Object} fieldMap
 * @param {string[]} allowedFields - 内部字段白名单（传 constants.js 的 WRITABLE_FIELDS）
 * @returns {Array<{code:string, message:string, column?:string, field?:string}>}
 */
export function validateFieldMap(fieldMap, allowedFields) {
    const allowed = Array.isArray(allowedFields) ? allowedFields.map(field => String(field)) : [];

    if (!isPlainObject(fieldMap) || Object.keys(fieldMap).length === 0) {
        return [{
            code: 'empty-map',
            message: 'fieldMap 缺失或是空对象；至少要有一个爬虫列名映射到内部字段' +
                `（可用字段：${allowedList(allowed)}）`
        }];
    }

    const findings = [];
    /** 内部字段 → 第一个声明它的列名（用于 duplicate-target） */
    const firstColumnOf = new Map();

    for (const column of Object.keys(fieldMap)) {
        const target = fieldMap[column];

        // null = 显式忽略，合法
        if (target === null) continue;

        if (typeof target !== 'string' || target === '') {
            const finding = {
                code: 'bad-target-type',
                message: `列 ${quote(column)} 的映射值 ${describeValue(target)} 非法；` +
                    '只能是 null（显式忽略）或非空的内部字段名' +
                    `（可用字段：${allowedList(allowed)}）`,
                column
            };
            if (typeof target === 'string') finding.field = target;
            findings.push(finding);
            continue;
        }

        if (!allowed.includes(target)) {
            findings.push({
                code: 'unknown-target',
                message: `列 ${quote(column)} 映射到未知内部字段 ${quote(target)}；` +
                    `可用字段：${allowedList(allowed)}`,
                column,
                field: target
            });
        }

        if (firstColumnOf.has(target)) {
            findings.push({
                code: 'duplicate-target',
                message: `列 ${quote(firstColumnOf.get(target))} 与列 ${quote(column)} ` +
                    `都映射到内部字段 ${quote(target)}；请只保留一个` +
                    '（按 fieldMap 键序，后者生效）',
                column,
                field: target
            });
        } else {
            firstColumnOf.set(target, column);
        }
    }

    return findings;
}

// ================================================================
// 未使用字段汇总（决策 14）
// ================================================================

/**
 * 汇总**整包**的未使用列名，供导入记录显示
 * （`未使用字段：得分, 时间, 内存, 代码长度`）。
 *
 * **只记字段名、绝不记值**——目的是让你将来想存「内存」时，
 * 知道爬虫早就在给这个字段了（决策 14）。
 *
 * @param {Array<Object>} records
 * @param {Object} fieldMap
 * @param {Object} [opts] - 同 applyFieldMap（如 reservedKeys）
 * @returns {string[]} 去重并排序后的列名
 */
export function collectUnusedColumns(records, fieldMap, opts) {
    const unique = new Set();
    const list = Array.isArray(records) ? records : [];

    for (const record of list) {
        const { unmapped } = applyFieldMap(record, fieldMap, opts);
        for (const column of unmapped) unique.add(column);
    }

    return [...unique].sort();
}
