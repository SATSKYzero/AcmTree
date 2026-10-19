import { isPlainObject } from '../../utils/guards.js';
// ================================================================
// `me.json` 的**结构模型**（ui/MeEditor/meForm.js）
//
// me.json 支持「JSON 修改 + UI 修改」两种改法（像 vsc 的设置那种）。
//
// 这个文件只做"文档 ⇄ 表单模型"的**纯**换算（不碰 DOM、不碰网络）：
//   `buildFormModel(doc)`  文档 → 模型（按**值长什么样**选控件，不认键名）
//   `collectFormModel(m)`  模型 → 文档（表单里改完再变回 JSON）
// 之所以按结构而不按键名：me.json 是**人写的**配置文件，字段一直在长
// （cf/qoj/pta/hdu/nk/atcoder/clist/team/_note…），写死键名的话每加一个平台
// 都要回来改一遍界面，而且"很多字段不会明写"，按名字猜会认错。
//
// 四种控件（按值选）：
//   object        → `group`   （一组字段，可「＋ 新字段」，键名可编辑）
//   string/数字/布尔 → `text`    （原样显示，不打码、不留占位符）
//   字符串数组     → `lines`   （一个多行框，**一行一条**；有换行的值退回 `raw`）
//   对象数组       → `records` （一行一条记录，字段取各条键名的并集 —— 对象/数组列给 JSON 框、
//                               **布尔列给勾选框**、标量列按原类型进出：`active: false` 不能变 `"false"`）
//   其余（混数组/嵌套怪结构）→ `raw` （一个 JSON 文本框，兜底但诚实）
// ================================================================

/** 控件种类 */
export const KIND = {
    GROUP: 'group',
    TEXT: 'text',
    LINES: 'lines',
    RECORDS: 'records',
    RAW: 'raw',
    //: 「＋ 新字段」点出来的**待定行**（键名 + 值两格，点 ✓ 才变成真节点）。
    //  为什么要它（用户 2026-10-19 实测）：原来新加的行直接就是 `TEXT` ⇒
    //  **表单里造不出一个新的对象**（`years.2026 = {contestUser, contestPassword}` 只能去 JSON 视图改）。
    ENTRY: 'entry'
};

/**
 * 待定行的"值"要按什么类型建：`auto` = 只认对象/数组的 JSON，其余一律**字符串**；
 * `object` = **直接建一个嵌套对象**（值留空也能建 ⇒ 先建壳、再往里「＋ 新字段」）。
 */
export const ENTRY_TYPES = ['auto', 'string', 'number', 'boolean', 'object'];

/** `collectFormModel` 里"这一项不要写进文档"的哨兵（用 Symbol 免得和真值撞） */
export const OMIT = Symbol('omit-me-field');
const isScalar = (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v);

/** 这个值用哪种控件（见文件头） */
function kindOf(value) {
    if (isPlainObject(value)) return KIND.GROUP;
    if (isScalar(value)) return KIND.TEXT;
    if (Array.isArray(value)) {
        if (value.length && value.every((x) => typeof x === 'string')) {
            // 值里带换行 ⇒ 多行框"一行一条"就存不回去了，退回 JSON 框（宁可难看也别悄悄改数据）
            return value.some((x) => x.includes('\n')) ? KIND.RAW : KIND.LINES;
        }
        if (value.length && value.every(isPlainObject)) return KIND.RECORDS;
        if (!value.length) return KIND.LINES;                 // 空数组：当"一行一条"的空表
        return KIND.RAW;
    }
    return KIND.RAW;
}

/**
 * 一个值 → 一个模型节点。
 *
 * @param {string} key
 * @param {*} value
 * @param {{keyEditable?: boolean}} [opts] - `keyEditable`：这个键是用户在表单里**新加**的
 *        （键名要渲染成输入框，初始为空）。
 */
export function nodeOf(key, value, opts = {}) {
    const kind = kindOf(value);
    const node = { kind, key, keyEditable: !!opts.keyEditable, wasPresent: true };
    if (kind === KIND.GROUP) {
        node.children = Object.keys(value).map((k) => nodeOf(k, value[k]));
    } else if (kind === KIND.TEXT) {
        node.value = value === null ? '' : String(value);
        node.valueType = typeof value;                        // 数字/布尔要原样存回去
        node.wasPresent = value !== null;
    } else if (kind === KIND.LINES) {
        node.values = (value || []).slice();
        node.wasPresent = Array.isArray(value);
    } else if (kind === KIND.RECORDS) {
        const keys = [];
        for (const item of value) {
            for (const k of Object.keys(item)) if (!keys.includes(k)) keys.push(k);
        }
        const jsonKeys = jsonKeysOf(value, keys);
        const boolKeys = boolKeysOf(value, keys);
        const numKeys = numKeysOf(value, keys);
        node.keys = keys;
        // ⚠️ 这三套**留在节点上**：`＋ 加一条` 也要照整列给控件（见 `meEditor.js` 那个点击分支），
        //    不然新加的行会退回文本框（`byYear` 当字符串、`active` 手打 `false`）。
        node.jsonKeys = jsonKeys;
        node.boolKeys = boolKeys;
        node.numKeys = numKeys;
        node.items = value.map((item) => recordItemOf(keys, item, jsonKeys, boolKeys, numKeys));
    } else {
        node.value = value;
    }
    // 用户在表单里**新加**的行：填了才写（空着 = 不加这个字段），见 `collectNode`
    if (opts.keyEditable) node.wasPresent = false;
    return node;
}

/**
 * 一行**待定**的新字段（`＋ 新字段` 点出来的）：键名一格、值一格，点 ✓ 才变成真节点。
 *
 * 为什么不直接给 `TEXT`（原来那样）：表单里就**造不出一个对象** —— 用户 2026-10-19 要加
 * `years.2026 = {contestUser, contestPassword}` 时只能切去 JSON 视图改。
 */
export function pendingEntry() {
    return {
        kind: KIND.ENTRY,
        key: '',
        keyEditable: true,
        wasPresent: false,
        value: '',          // 值那一格（多行：要能贴 `{…}`）
        valueType: 'auto'   // 见 `ENTRY_TYPES`
    };
}

/**
 * 待定行 → 真节点（**`auto` 只认对象/数组，其余一律字符串**）。
 *
 * ⚠️ **不许猜数字/布尔**（`me.json` 里 `contestPassword: "123456"` 这种就是数字形式的字符串）：
 *    猜成数字后 JSON 里就没引号了，`me_store` / 应用侧都不再按"字符串"对待它 ——
 *    与 `active: false ⇒ "false"` 是同一个坑的两头。真想要数字/布尔，让人在类型下拉里**显式**选。
 *
 * @param {string} key 字段名（空 ⇒ 抛错，别静默丢）
 * @param {string} text 值那一格的原文
 * @param {'auto'|'string'|'number'|'boolean'|'object'} type
 * @throws {Error} 名字为空 / JSON 不合法 / 数字或布尔填得不对
 */
export function nodeFromEntry(key, text, type = 'auto') {
    const k = String(key == null ? '' : key).trim();
    if (!k) throw new Error('先填字段名');
    const raw = String(text == null ? '' : text);
    const t = raw.trim();
    if (type === 'object') {
        // **嵌套**：值留空就建一个空对象（先建壳、再往里加字段），填了就按 JSON 读
        if (t === '') return nodeOf(k, {});
        if (!t.startsWith('{') && !t.startsWith('[')) {
            throw new Error(`「${k}」选的是对象：值留空（建空对象）或填 {…} / […]`);
        }
        let value;
        try {
            value = JSON.parse(t);
        } catch (err) {
            throw new Error(`「${k}」的值不是合法 JSON：${err.message}`);
        }
        return nodeOf(k, value);
    }
    if (type === 'number') {
        const n = Number(t);
        if (t === '' || !Number.isFinite(n)) throw new Error(`「${k}」的值不是数字`);
        return nodeOf(k, n);
    }
    if (type === 'boolean') {
        if (t !== 'true' && t !== 'false') throw new Error(`「${k}」的值要填 true 或 false`);
        return nodeOf(k, t === 'true');
    }
    if (type === 'string') return nodeOf(k, raw);
    // auto：**只有** `{`/`[` 开头才算 JSON（对象/数组）；其余原样当字符串
    if (t.startsWith('{') || t.startsWith('[')) {
        let value;
        try {
            value = JSON.parse(t);
        } catch (err) {
            throw new Error(`「${k}」的值不是合法 JSON：${err.message}`);
        }
        return nodeOf(k, value);
    }
    return nodeOf(k, raw);
}

/**
 * 对象数组里的一条 ⇒ `{fields:[{key,value,wasPresent,…}]}`（字段 = 各条键名的并集）。
 *
 * ⚠️ **对象/数组值的字段**（`accounts[]` 里就有：`byYear`、`mappings`）不能当字符串：
 *    一律 `String(v)` ⇒ 存一次就变成 `"[object Object]"`（**真丢数据**，实测踩到）。
 *    这类字段标 `isJson: true`，界面上给一个 JSON 文本框，读回来 `JSON.parse`。
 *
 * ⚠️ **标量也有类型**：`active: false` / `note: 3` 一律 `String(v)` ⇒ 存回去变成
 *    `"false"` / `"3"`（**字符串**）。`core/rosterAccounts.js` 的 `accountOf()` 判的是
 *    `item.active === false` ⇒ "停用"**静默失效**、爬虫照抓。所以每条字段都带 `valueType`，
 *    收集时走**与顶层 TEXT 同一个** `typedValue()`。
 *
 * @param {Set<string>|null} jsonKeys - **整列**里有没有对象/数组值（新加的空行也要照这个给控件）
 * @param {Set<string>|null} boolKeys - **整列**是不是布尔（给勾选框；见 `boolKeysOf`）
 * @param {Set<string>|null} numKeys  - **整列**是不是数字（同上，看整列）
 */
export function recordItemOf(keys, item = {}, jsonKeys = null, boolKeys = null, numKeys = null) {
    return {
        fields: keys.map((k) => {
            const raw = item[k];
            const scalar = raw === undefined || raw === null || ['string', 'number', 'boolean'].includes(typeof raw);
            // 「这一列是对象/数组」看**整列**（`jsonKeys`）：新加的空行也得给 JSON 框，
            // 否则用户在空行里填 `byYear` 会被当成字符串存下去（同一个丢数据的坑）。
            const isJson = jsonKeys ? jsonKeys.has(k) : !scalar;
            // 「这一列是布尔」也看整列（新行照样给勾选框，而不是让人手打 `false`）
            const isBool = !isJson && (boolKeys ? boolKeys.has(k) : typeof raw === 'boolean');
            const isNum = !isJson && !isBool && (numKeys ? numKeys.has(k) : typeof raw === 'number');
            return {
                key: k,
                value: scalar ? (raw === undefined || raw === null ? '' : String(raw)) : JSON.stringify(raw, null, 2),
                // ⚠️ **列的类型说了算**，不是这一格自己的：`active` 这一列是布尔，那么
                //    "本来没这个键、用户刚取消勾"这一格也必须回到布尔 `false`
                //    （只看 `typeof raw` 会得到 `'undefined'` ⇒ 存成字符串 `"false"`）。
                valueType: isJson ? 'object' : (isBool ? 'boolean' : (isNum ? 'number' : typeof raw)),
                wasPresent: raw !== undefined && raw !== null,
                isJson,
                isBool
            };
        })
    };
}

/**
 * 给一张 `records` 表**补一列**（只动模型，不动文档 —— 保存时才照模型写）。
 *
 * 为什么需要：表的列 = 各条键名的**并集** ⇒ 文件里从来没有人写过那一列时，它**根本不存在**，
 * 用户也就没地方去改它。`me.json` 的 `accounts[].active`（"是否启用"）正是这种：
 * 语义是"缺省即活跃" ⇒ 谁也不会去写 `true`，于是那一列永远不出现。
 *
 * @param {Object} node - `KIND.RECORDS` 的模型节点
 * @param {string} key - 列名
 * @param {string} valueType - `'boolean'`（默认）/ `'number'` / `'string'`
 * @param {{fill?:string}} [opts] - `fill`：**该列的缺省值**（写了它 ⇒ 缺这一格的行走"显式"那条路，
 *        保存时把这一列**写全**）。⚠️ 不写 `fill` 就是"给个能改的地方"：没动过的行**一个字都不写**
 *        （`collectNode` 的老规矩：本来没有 + 现在也空 ⇒ 不写）。
 */
export function ensureRecordColumn(node, key, valueType = 'boolean', opts = {}) {
    if (!node || node.kind !== KIND.RECORDS || !key) return node;
    const k = String(key);
    node.columnSpecs = Array.isArray(node.columnSpecs) ? node.columnSpecs : [];
    const spec = node.columnSpecs.find((s) => s.key === k);
    if (spec) {
        spec.valueType = valueType;
        if (opts.fill !== undefined) spec.fill = opts.fill;
    } else {
        node.columnSpecs.push({ key: k, valueType, fill: opts.fill });
    }
    return applyColumnSpecs(node, k);
}

/**
 * 按记在节点上的"列规格"把表补一遍（**新加的行也要走这里** —— 它不知道规格）。
 *
 * @param {string} [only] - 只处理这一列（不给 = 全部）
 */
export function applyColumnSpecs(node, only = '') {
    if (!node || node.kind !== KIND.RECORDS || !Array.isArray(node.columnSpecs)) return node;
    for (const spec of node.columnSpecs) {
        if (only && spec.key !== only) continue;
        const k = spec.key;
        node.keys = node.keys || [];
        if (!node.keys.includes(k)) node.keys.push(k);
        const colOf = { boolean: 'boolKeys', number: 'numKeys' }[spec.valueType];
        if (colOf) {
            const set = node[colOf] instanceof Set ? node[colOf] : new Set(node[colOf] || []);
            set.add(k);
            node[colOf] = set;
        }
        for (const item of node.items || []) {
            let field = item.fields.find((f) => f.key === k);
            if (!field) {
                // 本来就有这一格的（哪怕类型写错了）**不动它** —— 让它照原样显示出来
                field = {
                    key: k, value: '', valueType: spec.valueType, wasPresent: false,
                    isJson: false, isBool: spec.valueType === 'boolean'
                };
                // ⚠️ 补出来的列**插在 `name` 后面**（`accounts` 表有 `name`）——
                //    追加到末尾的话，它会排在那几个 JSON 框（`byYear`/`mappings`/`children`）后面，
                //    等于"有但看不见"。没有 `name` 的表就放最前面（新声明的列本来就该显眼）。
                const at = item.fields.findIndex((f) => f.key === 'name');
                item.fields.splice(at >= 0 ? at + 1 : 0, 0, field);
            }
            if (spec.fill !== undefined && !field.wasPresent) {
                field.value = String(spec.fill);
                field.wasPresent = true;
            }
        }
    }
    return node;
}

/** 这一列里有没有对象/数组值（决定"新行"也该给 JSON 框） */
function jsonKeysOf(items, keys) {
    const out = new Set();
    for (const item of items) {
        for (const k of keys) {
            const v = item[k];
            if (v !== undefined && v !== null && typeof v === 'object') out.add(k);
        }
    }
    return out;
}

/**
 * 这一列是不是**布尔列**（有值、且值全是布尔）—— 决定渲染成勾选框。
 *
 * 判据同 `jsonKeysOf`：看**整列**，这样"新加的一行"也知道该给勾选框（否则用户得手打
 * `false`，而 `"false"` 与 `false` 不是一回事）。
 */
function boolKeysOf(items, keys) {
    const out = new Set();
    for (const k of keys) {
        let seen = false;
        let allBool = true;
        for (const item of items) {
            const v = item[k];
            if (v === undefined || v === null) continue;
            seen = true;
            if (typeof v !== 'boolean') { allBool = false; break; }
        }
        if (seen && allBool) out.add(k);
    }
    return out;
}

/** 数字列（同 `boolKeysOf` 的形状：有值、且值全是数字） */
function numKeysOf(items, keys) {
    const out = new Set();
    for (const k of keys) {
        let seen = false;
        let allNum = true;
        for (const item of items) {
            const v = item[k];
            if (v === undefined || v === null) continue;
            seen = true;
            if (typeof v !== 'number') { allNum = false; break; }
        }
        if (seen && allNum) out.add(k);
    }
    return out;
}

/** 文档 → 模型（顶层必须是对象，与 `me.json` 同形） */
export function buildFormModel(doc) {
    if (!isPlainObject(doc)) throw new Error('me.json 顶层必须是对象');
    return {
        kind: KIND.GROUP,
        key: '',
        keyEditable: false,
        wasPresent: true,
        children: Object.keys(doc).map((k) => nodeOf(k, doc[k]))
    };
}

/** 文本 → 该存回去的类型（原来的值是什么类型就尽量还原，坏值原样留着） */
function typedValue(text, valueType) {
    if (valueType === 'number') {
        const n = Number(text);
        return text.trim() !== '' && Number.isFinite(n) ? n : text;
    }
    if (valueType === 'boolean') {
        if (text === 'true') return true;
        if (text === 'false') return false;
        return text;
    }
    return text;
}

/**
 * 模型 → 文档。
 *
 * 两条"别把文件改坏"的规矩：
 *   ① **本来没有、现在也空**的字段不写进去（新加的行留空 = 不加这个字段）；
 *   ② 同组内**键名重复**直接报错（对象里会悄悄吃掉一个 ⇒ 宁可让用户先改名）。
 */
export function collectFormModel(model) {
    if (!model || model.kind !== KIND.GROUP) throw new Error('模型顶层不是 group');
    return collectGroup(model);
}

function collectNode(node) {
    switch (node.kind) {
        case KIND.GROUP:
            return collectGroup(node);
        case KIND.ENTRY: {
            // 待定行：两格都空 ⇒ 当没加；只要填了内容就必须有名字（`nodeFromEntry` 会抛）
            const text = String(node.value == null ? '' : node.value);
            if (!String(node.key || '').trim() && !text.trim()) return OMIT;
            return collectNode(nodeFromEntry(node.key, text, node.valueType || 'auto'));
        }
        case KIND.TEXT: {
            const value = typedValue(node.value, node.valueType);
            if (!node.wasPresent && String(value).trim() === '') return OMIT;
            return value;
        }
        case KIND.LINES: {
            const values = node.values.slice();
            while (values.length && values[values.length - 1] === '') values.pop();   // 去掉尾部空行
            if (!node.wasPresent && !values.length) return OMIT;
            return values;
        }
        case KIND.RECORDS: {
            const items = node.items.map((item) => {
                const out = {};
                for (const field of item.fields) {
                    const value = field.value;
                    if (!field.wasPresent && String(value).trim() === '') continue;
                    if (field.isJson) {
                        // ⚠️ 对象/数组字段（`byYear` / `mappings`）：**必须**按 JSON 读回来，
                        //    否则存下去就是 `"[object Object]"`（真丢数据）
                        try {
                            out[field.key.trim()] = JSON.parse(value);
                        } catch (err) {
                            throw new Error(`字段「${field.key}」的 JSON 不合法：${err.message}`);
                        }
                        continue;
                    }
                    // ⚠️ **标量列按原类型存回去**（与顶层 TEXT 同一个 `typedValue`）：
                    //    `accounts[].active: false` 过一趟表单变 `"false"` ⇒ `accountOf()` 认不出
                    //    "停用"、爬虫照抓（实测踩过）；`note: 3` 同理不该变 `"3"`。
                    out[field.key.trim()] = typedValue(value, field.valueType);
                }
                return out;
            }).filter((item) => Object.keys(item).length);
            if (!node.wasPresent && !items.length) return OMIT;
            return items;
        }
        default: {
            if (typeof node.value === 'string') {                 // raw 的字符串形态 = 一段 JSON 文本
                try {
                    return JSON.parse(node.value);
                } catch (err) {
                    throw new Error(`字段「${node.key}」的 JSON 不合法：${err.message}`);
                }
            }
            return node.value;
        }
    }
}

function collectGroup(group) {
    const out = {};
    for (const child of group.children) {
        const key = (child.key || '').trim();
        if (!key) {
            // 新加的行没填名字：整行都空就当没加；填了内容却忘了名字 ⇒ 报错（别静默丢数据）
            if (!rowHasContent(child)) continue;
            throw new Error('有一项新字段没填名字');
        }
        if (Object.prototype.hasOwnProperty.call(out, key)) {
            throw new Error(`字段名「${key}」重复了（同一组里不能有两个同名）`);
        }
        const value = collectNode(child);
        if (value === OMIT) continue;
        out[key] = value;
    }
    return out;
}

/** 这一行里用户填东西了吗（用于"忘了填名字"的判断） */
function rowHasContent(node) {
    if (node.kind === KIND.ENTRY) return String(node.value == null ? '' : node.value).trim() !== '';
    if (node.kind === KIND.TEXT) return node.value.trim() !== '';
    if (node.kind === KIND.LINES) return node.values.some((v) => v !== '');
    if (node.kind === KIND.RECORDS) {
        return node.items.some((it) => it.fields.some((f) => f.value.trim() !== ''));
    }
    if (node.kind === KIND.GROUP) return node.children.some(rowHasContent);
    return true;                                                   // raw/别的一律当"有内容"
}

/** 给 UI 用的一行摘要（`_note` 之类长文本折叠时显示） */
export function summarize(node) {
    switch (node.kind) {
        case KIND.GROUP: return `${node.children.length} 个字段`;
        case KIND.TEXT: return node.value.length > 60 ? `${node.value.slice(0, 60)}…` : node.value;
        case KIND.LINES: return `${node.values.length} 行`;
        case KIND.RECORDS: return `${node.items.length} 条`;
        default: return 'JSON';
    }
}
