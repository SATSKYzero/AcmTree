// ================================================================
// 节点自动导入 — 内容指纹（features/AutoImport/contentHash.js）
// 职责：稳定、与键序无关的内容哈希，用于「导两次必须收敛」的幂等判定（5）
// 依赖：无（纯 JS，浏览器与 Node 跑出完全相同的值）
//
// ⚠️ 文件名为什么避开 fingerprint 这个词：
//    浏览器隐私扩展（广告拦截器）会按**文件名关键词**拦截请求，
//    `fingerprint`（浏览器指纹）是拦截名单的标准条目，
//    结果是 `ERR_BLOCKED_BY_CLIENT` —— 请求根本没到服务器，
//    表现成「模块 404 / 插件激活失败」，而代码与服务器都是好的。
//    同理，导出的函数名也避开该词（见 hashRecord）。
//
// ⚠️ 这是**变更检测**哈希，不是安全哈希（5）：
//    FNV-1a 32 位不抗碰撞攻击，只用来回答「这份内容与上次导入的那份是不是同一份」。
//    因此**刻意不使用 node:crypto**——同一段代码要在浏览器里也跑出同样的值。
//
// 指纹的覆盖范围（5）：
//    覆盖 extKey、type、fields、**账户线索**（`账户线索` 那一列）；
//    **不覆盖** generatedAt / source / crateVersion / parentExtKey / raw / 分类依据 / 链接分类。
//    这样「同一节点、同一份内容」无论出现在哪个包、什么时候生成，指纹都相同。
//
// ⚠️ 为什么**账户线索**也算"内容"（它明明也是元列）：它会被写进**来源层**
//    （每条值的 `account` / `clue`，见 `core/fieldValue.js` 的 `addSourceValue`）
//    ⇒ 线索变了就是树里的数据要变。不算进来的后果实测过（2026-10-06）：
//    `nk`/`hdu` 声明 handle 之后重导，业务字段一个字没变 ⇒ 整批判"跳过"，
//    预览写着「更新 0」，而界面上那些提交其实刚从"客观"变成了"归到某人名下"。
//
// 设计依据：docs/auto-import.md 第五节
// ================================================================

/** extKey 归一化：只 trim（与 3.1 的身份口径一致） */
function normKey(value) {
    if (value === undefined || value === null) return '';
    return String(value).trim();
}

/** 类型归一化：只做字符串化，避免 undefined 变成字符串 "undefined" */
function normType(value) {
    if (value === undefined || value === null) return '';
    return String(value);
}

/**
 * 把任意值写成**规范化 JSON**：对象键递归排序、紧凑（无空白）
 *
 * 规则：
 *   - 普通对象的键按字典序（UTF-16 码元顺序）排序；
 *   - 数组保持原顺序；
 *   - 对象的 `undefined` 值被丢弃；
 *   - 数组里的 `undefined` 写成 `null`（与 JSON.stringify 一致）；
 *   - `null` 保留；
 *   - 嵌套对象递归处理；
 *   - 环形引用保守地写成 `null`（绝不抛异常、绝不栈溢出）。
 *
 * @param {*} value
 * @returns {string}
 */
export function canonicalize(value) {
    return writeCanonical(value, []);
}

/**
 * canonicalize 的递归实现（内部）
 * @param {*} value
 * @param {Array} stack - 当前递归路径，用于环形引用保护
 * @returns {string}
 */
function writeCanonical(value, stack) {
    if (value === undefined || value === null) return 'null';

    const type = typeof value;
    if (type === 'number') return Number.isFinite(value) ? String(value) : 'null';
    if (type === 'boolean') return value ? 'true' : 'false';
    if (type === 'string') return JSON.stringify(value);
    if (type === 'bigint') return JSON.stringify(String(value));
    if (type === 'function' || type === 'symbol') return 'null';

    // 以下只剩对象与数组
    if (stack.indexOf(value) !== -1) return 'null';   // 环形引用：保守处理
    stack.push(value);

    let out;
    if (Array.isArray(value)) {
        const parts = [];
        for (const item of value) parts.push(writeCanonical(item, stack));
        out = '[' + parts.join(',') + ']';
    } else {
        const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
        const parts = [];
        for (const k of keys) {
            parts.push(JSON.stringify(k) + ':' + writeCanonical(value[k], stack));
        }
        out = '{' + parts.join(',') + '}';
    }

    stack.pop();
    return out;
}

/**
 * 稳定哈希：FNV-1a 32 位，按 **UTF-16 码元**逐位计算
 *
 * 用 `Math.imul` 做 32 位乘法（`*` 会溢出成 53 位浮点，结果不稳定），
 * 因此中文等非 ASCII 字符同样是确定性的。
 *
 * @param {string} str
 * @returns {string} 8 位小写十六进制，如 `'1a2b3c4d'`
 */
export function hashString(str) {
    const text = (str === undefined || str === null) ? '' : String(str);
    let hash = 0x811c9dc5;                  // FNV-1a 32 位 offset basis
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193); // FNV prime
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * 线索归一化：只留三个非空字段（与 `core/fieldValue.js` 的 `normalizeClue` 同口径）。
 * 空 ⇒ `''`（老包 / 没有线索的记录），参与哈希时是个固定值，不会让指纹漂。
 */
function normClue(raw) {
    if (!raw || typeof raw !== 'object') return '';
    const source = String(raw.source || '').trim();
    const field = String(raw.field || '').trim();
    const value = raw.value === undefined || raw.value === null ? '' : String(raw.value).trim();
    if (!value) return '';
    return { source, field, value };
}

/**
 * 一条记录的内容哈希
 *
 * 覆盖 `extKey`、`type`、`fields`、`clue`（`账户线索`），其余键
 * （generatedAt / source / crateVersion / parentExtKey / raw / 分类依据 / 链接分类）
 * 一律不参与（5）。
 *
 * @param {{extKey:string, type:string, fields:Object, clue?:Object}} record
 * @returns {string} 形如 `'fnv1a:1a2b3c4d'`
 */
export function hashRecord(record) {
    const rec = (record && typeof record === 'object') ? record : {};
    const payload = {
        extKey: normKey(rec.extKey),
        type: normType(rec.type),
        fields: (rec.fields && typeof rec.fields === 'object') ? rec.fields : {},
        clue: normClue(rec.clue)
    };
    return 'fnv1a:' + hashString(canonicalize(payload));
}
