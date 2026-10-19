// ================================================================
// 性质注册表的**树编辑**（`ui/settings/natureRegistryTree.js`）
//
// 为什么单独一份：分类树的形状（"对象套对象"、叶子 = `{}`、**同级顺序有意义**、
// 三片特殊叶子）是**规则**的一部分 ⇒ 判据只写在这里，界面只管调；纯函数 ⇒ 单测直接跑。
//
// ⚠️ 这里改的是**前端草稿**；写盘时主脚本那侧会**再校验一遍**
//    （`scripts/nature_registry_lib.py:parse_registry` —— 形状判据的唯一一份）。
//    所以这里的检查是"早点告诉人"，不是最后一道闸。
// ================================================================

//: 分类树里那三片特殊叶子（与 `core/natureFields.js` 的常量逐字相同 —— 有跨语言对拍照）
export const SPECIAL_LEAVES = Object.freeze(['无归类', '未归类', '上游异常']);

/** 这一层名是不是特殊叶子 */
export const isSpecial = (name) => SPECIAL_LEAVES.includes(String(name || ''));

/** 路径数组 → 显示串（`['xcpc','icpc']` ⇒ `xcpc/icpc`） */
export const pathText = (path) => (path || []).map(String).join('/');

const clone = (doc) => JSON.parse(JSON.stringify(doc && typeof doc === 'object' ? doc : {}));

/** 按路径取分类树上的那个对象（取不到 ⇒ `null`）。空路径 = 整棵树 */
export function readAt(doc, path = []) {
    let node = (doc || {}).classTrie;
    for (const name of path) {
        if (!node || typeof node !== 'object') return null;
        node = node[name];
    }
    return node && typeof node === 'object' ? node : null;
}

/**
 * 这一层名能不能用（**唯一的命名判据**）。
 *
 * @param {string[]} siblings - 同一层的现有键（重名要挡）
 * @returns 错误消息（`''` = 没问题）
 */
export function validateName(name, siblings = []) {
    const clean = String(name === undefined || name === null ? '' : name);
    if (!clean.trim()) return '分类名不能是空的';
    if (clean !== clean.trim()) return '分类名不能有首尾空白（写进节点值就是另一个分类）';
    if (clean.includes('/')) return '分类名里不能有「/」—— 那是写进节点时的分隔符，会把两层压成一层';
    if (siblings.includes(clean)) return `这一层已经有「${clean}」了`;
    return '';
}

/** 树 → 行清单（只列"所有祖先都展开"的那些；`open` 是路径串的 Set） */
export function listRows(doc, open = new Set(), path = [], out = []) {
    const node = readAt(doc, path);
    if (!node) return out;
    for (const [name, child] of Object.entries(node)) {
        const here = [...path, name];
        const depth = Object.keys(child && typeof child === 'object' ? child : {}).length;
        out.push({
            path: here,
            name,
            depth: here.length,
            leaf: depth === 0,
            children: depth,
            special: isSpecial(name)
        });
        if (depth > 0 && open.has(pathText(here))) listRows(doc, open, here, out);
    }
    return out;
}

/** 树里所有**叶子路径**（与 `nature_registry_lib.class_paths()` 同一口径：特殊叶子也算叶子） */
export function leafPaths(doc) {
    const out = [];
    const walk = (node, path) => {
        if (!node || typeof node !== 'object') return;
        const keys = Object.keys(node);
        if (!keys.length) {
            if (path.length) out.push(pathText(path));
            return;
        }
        for (const k of keys) walk(node[k], [...path, k]);
    };
    walk((doc || {}).classTrie, []);
    return out;
}

/** 把父对象的条目**整批换掉**（保顺序；`pairs` 就是新的顺序） */
function replaceEntries(parent, pairs) {
    for (const key of Object.keys(parent)) delete parent[key];
    for (const [key, value] of pairs) parent[key] = value;
}

/**
 * 加一个子分类。
 * @throws Error（消息可直接给人看）
 */
export function addChild(doc, path, name) {
    const next = clone(doc);
    const parent = readAt(next, path);
    if (!parent) throw new Error(`找不到「${pathText(path)}」`);
    const self = path[path.length - 1];
    if (self && isSpecial(self)) {
        throw new Error(`「${self}」是特殊叶子（"这一维没有"的意思）—— 它下面不加子分类`);
    }
    const clean = String(name === undefined || name === null ? '' : name).trim();
    const bad = validateName(clean, Object.keys(parent));
    if (bad) throw new Error(bad);
    parent[clean] = {};
    return next;
}

/** 改名（**保持同级顺序** —— 顺序是语义：分类是"有序列表"落成的串） */
export function renameAt(doc, path, name) {
    if (path.length <= 1) {
        throw new Error('根分类不能改名（节点值的第一段就是它 —— 改名等于把全树的分类读串）');
    }
    const next = clone(doc);
    const parent = readAt(next, path.slice(0, -1));
    const old = path[path.length - 1];
    if (!parent || !(old in parent)) throw new Error(`找不到「${pathText(path)}」`);
    const clean = String(name === undefined || name === null ? '' : name).trim();
    const bad = validateName(clean, Object.keys(parent).filter((k) => k !== old));
    if (bad) throw new Error(bad);
    if (clean === old) return next;
    replaceEntries(parent, Object.entries(parent).map(([k, v]) => (k === old ? [clean, v] : [k, v])));
    return next;
}

/** 删掉一条分类（**根与特殊叶子不许删**：根是平台那一层，特殊叶子少一片就有值判不出来） */
export function removeAt(doc, path) {
    if (!path.length) throw new Error('整棵树不能删');
    const self = path[path.length - 1];
    if (path.length === 1) throw new Error(`根分类「${self}」不能删（要停用整个平台得另想办法）`);
    if (isSpecial(self)) throw new Error(`特殊叶子「${self}」不能删 —— 少一片就有值判不出来`);
    const next = clone(doc);
    const parent = readAt(next, path.slice(0, -1));
    if (!parent || !(self in parent)) throw new Error(`找不到「${pathText(path)}」`);
    delete parent[self];
    return next;
}

/**
 * 同一层里上下移一格（`delta` = -1 上 / +1 下）—— ⚠️ **顺序有意义**：
 * `natureClass` 是有序列表落成的 `a/b/c`，同级顺序就是它们显示/落位的先后。
 */
export function moveAt(doc, path, delta) {
    if (!path.length) throw new Error('根那一层不能移');
    const next = clone(doc);
    const parent = readAt(next, path.slice(0, -1));
    const self = path[path.length - 1];
    const keys = Object.keys(parent || {});
    const at = keys.indexOf(self);
    const to = at + (delta < 0 ? -1 : 1);
    if (at < 0) throw new Error(`找不到「${pathText(path)}」`);
    if (to < 0 || to >= keys.length) return next;              // 到头了：什么都不做
    const pairs = keys.map((k) => [k, parent[k]]);
    const [moved] = pairs.splice(at, 1);
    pairs.splice(to, 0, moved);
    replaceEntries(parent, pairs);
    return next;
}

/**
 * 改一个字段定义（`fields[key]` 上的那几格：`label` / `kind` / `pattern`）。
 *
 * ⚠️ 键名（`natureClass` 这些）**不许改**：节点上存的值与它绑定，改名等于把全树的分类读串。
 */
export function patchField(doc, key, patch = {}) {
    const next = clone(doc);
    const cur = (next.fields || {})[key];
    if (!cur) throw new Error(`找不到字段「${key}」`);
    for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) continue;
        if (v === '') delete cur[k];                            // 清空 = 删掉这一格（与 me.json 那条同一规矩）
        else cur[k] = v;
    }
    return next;
}

/** 正则能不能编出来（界面上"这行 pattern 行不行"的即时提示） */
export function patternProblem(text) {
    const s = String(text === undefined || text === null ? '' : text);
    if (!s.trim()) return '这一格不能是空的（pattern 档必须有正则）';
    try {
        new RegExp(s);
    } catch (err) {
        return `编不出来：${(err && err.message) || err}`;
    }
    return '';
}
