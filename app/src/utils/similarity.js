// ================================================================
// 标题相似度（utils/similarity.js）
// 职责：**通用**的标题归一化 + 相似度计算（谁都能用：导入的相似警告、判重整理页的候选推荐）
//
// ⚠️ 硬约束：**相似度永不参与判定，只参与提示**（4.6）。
//    key 精确相等 → 合并；key 不一致但标题高度相似 → 新建 + 警告。
//    本模块的分数只决定「说不说」，不阻断、不门控、不做上限。
//
// 已知局限（写出来是为了不让它被误当成 bug，4.6）：
//    中文标题「同义不同译」（`Two Sum` vs `两数之和`）分数会很低，
//    **不会触发警告**。这是算法能力的边界，本项目**刻意不加翻译表**。
//
// 说明：本模块不碰 DOM、可抛异常的函数一律兜底，可在 Node 测试中直接引用。
// 设计依据：docs/auto-import.md 4.6 / 4.7
//
// 位置说明：放在 utils 是因为它没有任何"自动导入"的语义 ——
// 判重整理页也要用它，而 `core/` 不该反向依赖某个功能插件。
// ================================================================
import { treeOfExtKey } from './extkey.js';

/** 相似度默认阈值（唯一真源；AutoImport 的 constants.js 从这里转出去） */
export const DEFAULT_SIMILARITY_THRESHOLD = 0.7;

/** 全角字符转半角（含全角空格），让 `＋` / `Ａ` 之类不成为差异 */
function toHalfWidth(str) {
    let out = '';
    for (const ch of str) {
        const code = ch.charCodeAt(0);
        if (code === 0x3000) {
            out += ' ';                                       // 全角空格
        } else if (code >= 0xff01 && code <= 0xff5e) {
            out += String.fromCharCode(code - 0xfee0);        // 全角 ASCII 区
        } else {
            out += ch;
        }
    }
    return out;
}

/** 首尾的标点 / 符号 / 空白（内部标点保留——`Div.1 + Div.2` 的点与加号是信息） */
const EDGE_PUNCT_RE = /^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu;

/** 取词用的字符类：拉丁字母 / 数字 连续段，或单个中日韩汉字 */
const TOKEN_RE = /[a-z0-9]+|[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;

/** 字母与数字的交界（`div1` → `div` + `1`），让 `Div.1` 与 `Div1` 等价 */
const ALNUM_SPLIT_RE = /[a-z]+|[0-9]+/g;

/** 阈值兜底：非有限数一律回落到 constants.js 的默认值 */
function resolveThreshold(threshold) {
    return (typeof threshold === 'number' && Number.isFinite(threshold))
        ? threshold
        : DEFAULT_SIMILARITY_THRESHOLD;
}

/** extKey 归一化：只 trim（与 3.1 的身份口径一致） */
function normKey(value) {
    if (value === undefined || value === null) return '';
    return String(value).trim();
}

/** 从 fields 里取标题原文（未归一化，供警告展示） */
function readTitle(fields) {
    if (!fields || typeof fields !== 'object') return '';
    const value = fields.name;
    if (value === undefined || value === null) return '';
    return String(value);
}

/** 把归一化后的标题切成 token 集合的数组形式（内部） */
function tokenize(text) {
    const tokens = [];
    const matches = text.match(TOKEN_RE);
    if (!matches) return tokens;
    for (const piece of matches) {
        if (piece.charCodeAt(0) <= 0x7f) {
            const parts = piece.match(ALNUM_SPLIT_RE);
            if (parts) tokens.push(...parts);
        } else {
            tokens.push(piece);      // 汉字：一字一词
        }
    }
    return tokens;
}

/**
 * 标题归一化：trim、小写、压缩空白、全角转半角、去掉首尾标点
 *
 * 归一化是**幂等**的（同一标题反复调用结果相同），
 * 因此下面的相似度函数内部再归一化一次也不会改变结果。
 *
 * @param {*} value
 * @returns {string}
 */
export function normalizeTitle(value) {
    if (value === undefined || value === null) return '';
    const text = toHalfWidth(String(value)).toLowerCase();
    return text
        .replace(/\s+/g, ' ')
        .trim()
        .replace(EDGE_PUNCT_RE, '');
}

/**
 * 阻塞键（blocking key）：归一化标题的**前 n 个 token**（默认只取第 1 个）。
 *
 * 用途：两两比相似度是 O(n²)，2 万节点上实测要 18 秒（`titleSimilarity` 内含
 * Levenshtein）—— 判重整理页直接卡死。所以先用一个 O(n) 的**便宜键**把候选分块，
 * 只在同一块里两两比。
 *
 * ⚠️ 为什么默认只取 **1** 个：取 2 个时，短标题（`Two Sum` vs `Two Sums`）整串就是
 * 前两个 token，永远落不到同一块 —— 而"多一个字母"恰恰是要抓的相似。取 1 个
 * （`two` vs `two`）它们就在一块。块变大由调用方的总量预算兜住。
 *
 * 代价（刻意写清楚，别被当成 bug）：**第一个 token 不同的标题不会被推荐**
 * （例如「浙江省赛 2026」与「2026 浙江省赛」）。这只是"少提示一条"，
 * **不影响判定** —— 判定永远只看用户填的 `映射元素值`。
 *
 * @param {*} value
 * @param {number} [n]
 * @returns {string} 空串 = 没有可用 token（调用方应跳过该节点）
 */
export function blockingKey(value, n = 1) {
    const tokens = tokenize(normalizeTitle(value));
    if (tokens.length === 0) return '';
    return tokens.slice(0, n).join(' ');
}

/**
 * Levenshtein 比率（编辑距离归一化到 [0,1]）
 *
 * `1 - 距离 / 较长串长度`，抓错别字、大小写、多余空格、版本后缀
 * （`Two Sum` vs `Two Sums`）。两个空串视为完全相同 → 1。
 *
 * @param {*} a
 * @param {*} b
 * @returns {number} [0,1]
 */
export function levenshteinRatio(a, b) {
    const s = normalizeTitle(a);
    const t = normalizeTitle(b);
    if (s === t) return 1;

    const m = s.length;
    const n = t.length;
    if (m === 0 || n === 0) return 0;

    let prev = new Array(n + 1);
    let cur = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;

    for (let i = 1; i <= m; i++) {
        cur[0] = i;
        const sc = s.charCodeAt(i - 1);
        for (let j = 1; j <= n; j++) {
            const cost = (sc === t.charCodeAt(j - 1)) ? 0 : 1;
            const del = prev[j] + 1;
            const ins = cur[j - 1] + 1;
            const sub = prev[j - 1] + cost;
            cur[j] = Math.min(del, ins, sub);
        }
        const tmp = prev;
        prev = cur;
        cur = tmp;
    }

    const distance = prev[n];
    const maxLen = Math.max(m, n);
    return Math.max(0, 1 - distance / maxLen);
}

/**
 * token 集合相似度（Jaccard）
 *
 * 对符号与分隔符更鲁棒：`Div.1 + Div.2` 与 `Div1+Div2` 的 token 集合完全相同。
 * 双方都没有 token 时返回 0（无内容可比）。
 *
 * @param {*} a
 * @param {*} b
 * @returns {number} [0,1]
 */
export function tokenSetSimilarity(a, b) {
    const setA = new Set(tokenize(normalizeTitle(a)));
    const setB = new Set(tokenize(normalizeTitle(b)));
    if (setA.size === 0 || setB.size === 0) return 0;

    let inter = 0;
    for (const token of setA) {
        if (setB.has(token)) inter += 1;
    }
    const union = setA.size + setB.size - inter;
    return union === 0 ? 0 : inter / union;
}

/**
 * 标题相似度 = 归一化后取「Levenshtein 比率」与「token 集合相似度」的较大值
 * @param {*} a
 * @param {*} b
 * @returns {number} [0,1]
 */
export function titleSimilarity(a, b) {
    return Math.max(levenshteinRatio(a, b), tokenSetSimilarity(a, b));
}

/**
 * 去掉数字后的词序列（用于识别"只差序号"的标题）
 *
 * 用**词**而不是字符，是因为 `Slot Machine` 与 `Slot Machine 2` 只差一个
 * 数字词；若直接删字符，会留下多余空格（`slot machine ` ≠ `slot machine`）。
 */
function stripNumberTokens(text) {
    return tokenize(normalizeTitle(text))
        .filter((token) => !/^[0-9]+$/.test(token))
        .join(' ');
}

/**
 * 两个标题是否**只差数字**（`…联赛（1）` vs `…联赛（10）`、`Round 900` vs `Round 901`）
 *
 * 为什么需要它：**编号系列天然"高度相似"**。10 场「暑期联赛（1）…（10）」
 * 两两都是 0.96，会被相似度警告刷屏 —— 而它们本来就是不同的比赛。
 * 这类"只差序号"的配对没有任何信息量，属于误报，直接跳过。
 *
 * 判据刻意很窄：**去掉数字词之后，剩余词序列完全相同**，且两者本身不相等。
 * 所以 `phi master` / `gcd master`（差在字母）仍然会照常报警 ——
 * 那才是这条检查真正要提醒的东西。
 *
 * 「多一个序号」也算同一类：`Slot Machine`（B 题）与 `Slot Machine 2`（C 题）
 * 是同一场比赛里成对出现的续作，key 各不相同，报出来同样只是刷屏。
 *
 * @param {*} a
 * @param {*} b
 * @returns {boolean}
 */
export function differsOnlyByNumbers(a, b) {
    const s = normalizeTitle(a);
    const t = normalizeTitle(b);
    if (!s || !t || s === t) return false;
    const stripped = stripNumberTokens(s);
    // 全是数字的标题（`2026`）没有词可比，不算"只差序号"
    if (!stripped) return false;
    return stripped === stripNumberTokens(t);
}

/**
 * 找出**同父容器下**标题相似、但 extKey 不同的兄弟节点候选（4.6）
 *
 * 只警告，不判定：调用方负责把结果当 ⚠️ 提示，绝不用它决定合并。
 * 归一化后标题为空的候选一律跳过（无可比语义）；extKey 相同的候选是
 * 「匹配」另一条路径（4.2），也跳过。
 *
 * 本函数**照常返回"只差序号"的配对**（判据留给调用方，便于计数）：
 * plan 层会用 `differsOnlyByNumbers` 把它们过滤掉并计入 `similaritySuppressed`。
 *
 * @param {{extKey:string, fields:Object}} incoming
 * @param {Array<{extKey:string, fields:Object}>} existingSiblings - 同一父容器下的兄弟
 * @param {number} [threshold] - 默认取 constants.js 的 DEFAULT_SIMILARITY_THRESHOLD
 * @returns {Array<{ extKey:string, conflict:boolean, score:number, otherTitle:string, title:string }>}
 *          按 score 降序；`conflict: true` 表示对方有非空 extKey 且与本条不同
 */
export function findSimilarSiblings(incoming, existingSiblings, threshold) {
    const out = [];
    try {
        if (!incoming || typeof incoming !== 'object') return out;
        if (!Array.isArray(existingSiblings) || existingSiblings.length === 0) return out;

        const limit = resolveThreshold(threshold);
        const incomingKey = normKey(incoming.extKey);
        const incomingTitle = readTitle(incoming.fields);
        const title = normalizeTitle(incomingTitle);
        if (!title) return out;   // 本条标题归一化后为空 → 没有可比语义

        for (const sibling of existingSiblings) {
            if (!sibling || typeof sibling !== 'object') continue;
            const otherKey = normKey(sibling.extKey);
            // 同一个非空 extKey = 精确匹配，不是「相似冲突」，由 match 层处理（4.2）
            if (otherKey !== '' && otherKey === incomingKey) continue;

            const otherTitle = readTitle(sibling.fields);
            const otherNorm = normalizeTitle(otherTitle);
            if (!otherNorm) continue;

            const score = titleSimilarity(title, otherNorm);
            if (score < limit) continue;

            out.push({
                extKey: otherKey,
                conflict: otherKey !== '' && otherKey !== incomingKey,
                score,
                otherTitle,
                title: incomingTitle
            });
        }

        out.sort((x, y) => y.score - x.score);   // 稳定排序：同分保持传入顺序
    } catch (err) {
        return [];
    }
    return out;
}

/**
 * 找出**同一份包内**的近似重复记录（爬虫 bug → 4.7）
 *
 * 只配对 extKey **不同**的记录：extKey 相同属于「包内重复」这条独立路径（3.2），
 * 由 resolve/plan 层逐条拒绝，不在这里重复计。
 *
 * 也只配对**类型相同**的记录：容器之间名字像不是问题 ——
 * `XCPC` 与它下属的 `ICPC` 相似度 0.75，但一个是平台一个是系列，
 * 报出来纯属噪声。这条检查要抓的是"同一道题/同一场比赛被导成了两个 key"，
 * 那只可能发生在同类型之间。
 *
 * ⚠️ **"像"还不够，得是"同一件东西"**：
 * 光按相似度报，实测真包 **3362 条全是误报**：
 *   · **3216 条**：同一个父容器里**题号不同**的两道题（`arc120 F` vs `F2`、`nk … p:I` vs `p:J`）——
 *     一场比赛里题号不同就是两道题，**天经地义**；
 *   · 余下的**不同父**同名题已被上面 `a.parent !== b.parent` 挡掉（跨场同名是常态）。
 * 而"**题名逐字相同**"也不是信号：`arc120 F` 与 `F2` 都叫 `Wine Thief`（AtCoder 的**重发题**）
 * —— 实测剩下那 3 条全是这种，合法。
 * ⇒ 唯一无歧义的指纹 = **同一父里同一个题号出来两个 key**（形态：字母重复 C,C,E,E,…）。
 * 所以本函数**只负责算相似度并给出题号**，
 * 那条"是不是真信号"的闸门由调用方（`plan.js`）按 `aPid === bPid` 下。
 *
 * 每个无序对最多出现一次；结果按 score 降序、再按 `a` 升序。
 *
 * @param {Array<{index:number, extKey:string, type?:string, fields:Object}>} records
 * @param {number} [threshold]
 * @returns {Array<{ a:number, b:number, score:number, aKey:string, bKey:string, aTitle:string, bTitle:string, aPid:string, bPid:string }>}
 */
export function findIntraBatchDuplicates(records, threshold) {
    const out = [];
    try {
        if (!Array.isArray(records) || records.length < 2) return out;
        const limit = resolveThreshold(threshold);

        const list = [];
        for (let i = 0; i < records.length; i++) {
            const rec = records[i];
            if (!rec || typeof rec !== 'object') continue;
            const titleRaw = readTitle(rec.fields);
            const title = normalizeTitle(titleRaw);
            if (!title) continue;   // 标题为空 → 没有比对的语义
            const key = normKey(rec.extKey);
            const cut = key.lastIndexOf(':');
            list.push({
                index: Number.isInteger(rec.index) ? rec.index : i,
                key,
                // 所属的"树" = extKey 的第一段（`xcpc:…` / `qoj:…` / `cf:…`）
                // ⚠️ 取法是**共享**的（`utils/extkey.js`）：全仓四处各写一遍会让
                //    "带空格的键"在不同界面上变成两棵树。
                tree: treeOfExtKey(key),
                // 所属的**父容器**：优先用记录自己声明的 `parentKey`（比赛 → 系列 → 平台
                // 都能如实表达）；没给才退回"extKey 最后一个 `:` 之前"——
                // ⚠️ 那个退回写法对 P/R 成立，对 C 不成立（C 的父是系列，键里没有）。
                parent: (rec.parentKey === undefined || rec.parentKey === null)
                    ? (cut > 0 ? key.slice(0, cut) : '')
                    : String(rec.parentKey),
                type: (rec.type === undefined || rec.type === null) ? '' : String(rec.type),
                // 题号（同一个父里它就是"这是哪道题"的权威身份，见上面的说明）
                pid: normKey(rec.fields && rec.fields.problemId),
                title,
                titleRaw
            });
        }

        for (let i = 0; i < list.length; i++) {
            for (let j = i + 1; j < list.length; j++) {
                const a = list[i];
                const b = list[j];
                if (a.key === b.key) continue;    // key 相同 = 包内重复，另一条路径（3.2）
                if (a.type !== b.type) continue;  // 跨类型比标题 = 噪声（见上）
                // 跨"树"不比：各渠道**各自成节点**是设计，
                // 同一道题在 `xcpc:` 与 `qoj:` 两棵树下各有一份是**预期**，
                // 不是"爬虫 key 不稳定"。真要合并由用户在判重整理页绑 `映射元素值`。
                if (a.tree !== b.tree) continue;
                // 跨父容器也不比：这条检查要抓的是"**同一道题被导成了两个 key**"，
                // 那只可能发生在同一个父容器里。不同比赛出现同名题是**正常**的
                // （实测：合并包里 1101 条这类报警，全是不同比赛之间的同名题，
                //  把真问题淹了）。
                if (a.parent !== b.parent) continue;
                const score = titleSimilarity(a.title, b.title);
                if (score < limit) continue;
                out.push({
                    a: a.index,
                    b: b.index,
                    score,
                    aKey: a.key,
                    bKey: b.key,
                    aTitle: a.titleRaw,
                    bTitle: b.titleRaw,
                    aPid: a.pid,
                    bPid: b.pid
                });
            }
        }

        out.sort((x, y) => (y.score - x.score) || (x.a - y.a));
    } catch (err) {
        return [];
    }
    return out;
}
