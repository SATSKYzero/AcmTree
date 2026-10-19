// ================================================================
// 节点自动导入 — extKey 校验与一致性自检（features/AutoImport/extkey.js）
// 职责：
//   1. normalizeExtKey / isNonEmptyExtKey  —— 规范化与非空校验（3.1）
//   2. checkKeyConsistency                 —— 纯文本一致性检查，只产警告（3.5 / 4.8）
//   3. composeExtKey                       —— 给爬虫与「补身份键」页的拼装便捷函数（3.4）
// 依赖：无（纯字符串计算；不碰 DOM、不 import view/ shell/）
// 说明：
//   - 应用**从不解析** extKey 的内部语义，只检查「空 / 重复 / 形状」（3.1、3.2）
//   - 本模块只**返回** findings，永不 throw、永不拒绝记录——拒绝由 4.4 的
//     逐条判定负责（见 core/ops/upsert.js 的 missing-extkey）
//   - 相似度**不在**这里算：3.5 的 opts.similarity 是保留参数，见 similarity.js
//   - 刻意不做 key 自动修正（改了 key 就等于换了身份，会破坏幂等，见 4.8）
// 设计依据：docs/auto-import.md 3.1 / 3.2 / 3.4 / 3.5 / 4.2 / 4.8
// ================================================================

/** extKey 长度上限：超过即「格式可疑」。纯形状检查，不是语义校验 */
const MAX_EXT_KEY_LENGTH = 200;

/** 全角字符区（含全角冒号「：」、全角空格）——混进 key 后肉眼几乎看不出 */
const FULL_WIDTH_RE = /[\uFF00-\uFFEF]/;

/**
 * 父引用字段的两种写法：
 *   - `parentExtKey` 是应用内部名
 *   - `父extKey`     是 crate 里的中文列名（7.1）
 * 两者语义相同，都按「空 = 根」处理（3.3）
 */
const PARENT_KEY_FIELDS = Object.freeze(['parentExtKey', '父extKey']);

/** 是不是一个可当作记录使用的普通对象 */
function isRecordObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 消息里引用一个值（带引号，便于看出首尾空白） */
function quote(value) {
    return `"${value === undefined || value === null ? '' : String(value)}"`;
}

// ================================================================
// 规范化与非空校验（3.1）
// ================================================================

/**
 * 规范化 extKey 以便比较：**只做 trim**，不改变大小写、不解析结构。
 * 永不返回 undefined / null。
 * @param {*} value
 * @returns {string} 缺省 / null / 非字符串 → 其字符串形式 trim 后的值（空则为 ''）
 */
export function normalizeExtKey(value) {
    if (value === undefined || value === null) return '';
    return String(value).trim();
}

/**
 * trim 后是否非空（4.4 的唯一硬要求）
 * @param {*} value
 * @returns {boolean}
 */
export function isNonEmptyExtKey(value) {
    return normalizeExtKey(value) !== '';
}

// ================================================================
// 一致性检查（3.5 / 4.8）—— 全部只是警告
// ================================================================

/**
 * 取 extKey 的「前缀段」：**最后一个 `:` 之前**的部分；
 * 不含 `:` 时前缀就是整个 key。
 * 例：`qoj:4113:20236` → `qoj:4113`；`qoj:4113` → `qoj`；`qoj` → `qoj`
 * @param {string} key - 已规范化的 extKey
 * @returns {string}
 */
function prefixOf(key) {
    const idx = key.lastIndexOf(':');
    return idx < 0 ? key : key.slice(0, idx);
}

/**
 * 取记录声明的父 extKey（已规范化为字符串；空串表示挂根）。
 * `parentExtKey` 优先于 `父extKey`，但空值会被跳过，
 * 以免「一个字段写空、另一个字段写对」时误判成挂根。
 * @param {Object} record
 * @returns {string}
 */
function pickParentKey(record) {
    for (const field of PARENT_KEY_FIELDS) {
        const key = normalizeExtKey(record[field]);
        if (key) return key;
    }
    return '';
}

/**
 * 对一组记录做**纯文本**的 extKey 一致性检查。
 *
 * 只产出**两类**警告（3.5），**不阻断导入、不修改数据、不抛异常**：
 *   1. `mixed-prefix`      —— 同一父下兄弟节点的前缀段有 ≥2 种写法
 *   2. `suspicious-format` —— 含首尾空白 / 全角字符 / 过长 / 与父 key 完全相同
 * （不做前缀嵌套类检查 —— 理由见下面那条注释。）
 *
 * 返回值已去重（同一 `(code, index)` 只出现一次），
 * 排序为「记录下标升序，其次 code 字典序」。
 *
 * @param {Array<{extKey?:string, 父extKey?:string, parentExtKey?:string, type?:string}>} records
 * @param {{similarity?:number}} [opts] - **保留未用**：相似度不在此计算（4.6）
 * @returns {Array<{code:string, message:string, extKey?:string, index?:number}>}
 */
export function checkKeyConsistency(records, opts) {
    // opts.similarity 刻意忽略：标题相似度在 similarity.js 计算（硬约束见 4.6）
    void opts;

    const findings = [];
    if (!Array.isArray(records)) return findings;

    const seen = new Set();
    const push = finding => {
        const dedupKey = `${finding.code}#${finding.index}`;
        if (seen.has(dedupKey)) return;
        seen.add(dedupKey);
        findings.push(finding);
    };

    // 同一父（空串 = 根，见 3.3）下的兄弟分组：父 key → 成员
    const groups = new Map();

    records.forEach((record, index) => {
        if (!isRecordObject(record)) return;

        const raw = record.extKey;
        const extKey = normalizeExtKey(raw);
        const parentKey = pickParentKey(record);

        // 格式可疑：对**未 trim 的原文**检查，纯空白也能被抓到。
        // 这是本模块唯一真正可靠的检查——它只看字符，不假设任何拼法约定。
        const reasons = [];
        if (typeof raw === 'string' && raw !== raw.trim()) {
            reasons.push('首尾有空白');
        }
        if (extKey && FULL_WIDTH_RE.test(extKey)) {
            reasons.push('含全角字符');
        }
        if (extKey.length > MAX_EXT_KEY_LENGTH) {
            reasons.push(`长度 ${extKey.length} 超过 ${MAX_EXT_KEY_LENGTH}`);
        }
        if (extKey && parentKey && extKey === parentKey) {
            reasons.push('与父extKey 完全相同');
        }
        if (reasons.length > 0) {
            push({
                code: 'suspicious-format',
                message: `extKey ${quote(raw)} 格式可疑（${reasons.join('、')}）；` +
                    '请改成 trim 后的半角字符串，且不要照抄父extKey',
                extKey,
                index
            });
        }

        // 空 key 由 4.4 逐条拒绝，这里不重复诊断
        if (!extKey) return;

        // 前缀一致性分组（用于下面那条"仅供参考"的整体观察）
        // ⚠️ 按 **(父, 类型)** 分组 —— 同一父下**不同类型**的兄弟比前缀纯属噪声：
        //    QOJ 的分类 S 下既有 C（`qoj:c:1234`）又有 S（`qoj:s:cat-…`），
        //    实测那 16 条 `mixed-prefix` 全是这么来的。这与 `intra-batch-duplicate`
        //    是同一个坑（`utils/similarity.js`："那只可能发生在同类型之间"）。
        const type = String(record.节点类型 || record.type || '');
        const member = { index, extKey, prefix: prefixOf(extKey), parentKey, type };
        const groupKey = `${type}\u0000${parentKey}`;
        const bucket = groups.get(groupKey);
        if (bucket) bucket.push(member);
        else groups.set(groupKey, [member]);
    });

    // ---------------------------------------------------------------
    // 为什么不做基于「前缀嵌套」的字符串检查（记录原因，避免日后被当成"漏了"）
    // ---------------------------------------------------------------
    // 子 key 必须以「父key + :」开头、同父下前缀必须一致，这类检查
    // 都**基于一个从未成立的假设**：extKey 采用「父:子」嵌套拼法。
    // 本设计只要求 extKey 非空且全局唯一（3.1 / 2.4），**从不要求前缀嵌套**；
    // 3.4 的推荐拼法本身就是扁平的（比赛 `qoj:4113`、提交 `qoj:sub:2951241`）。
    // 于是这两条检查在**完全正确**的数据上大量误报：
    //
    //     qoj:4113        (父 qoj:contest)      → 误报
    //     qoj:sub:2951241 (父 qoj:4113:20244)   → 误报
    //
    // 而 `父extKey` 写错的真实代价很低：**父引用解析不到时应用会直接拒绝该条**
    // （2.3），报错信息里带父子双方的 key，一眼可辨。
    // 既然准确性由解析层保证，字符串启发式就只剩下噪音——故不做。
    //
    // 这里只保留一条**按父聚合、只报一次**的观察，用于发现"同一个父下
    // 兄弟节点混用了两套拼法"这种规范漂移（不指向具体条目，避免刷屏）。
    for (const bucket of groups.values()) {
        const parentKey = bucket[0].parentKey;
        if (!parentKey) continue;                 // 挂根的兄弟不比前缀
        const typeLabel = bucket[0].type || '?';
        const prefixes = [...new Set(bucket.map(m => m.prefix))].sort();
        if (prefixes.length < 2) continue;

        // 组内只有一个成员时说明不了"漂移"，跳过
        if (bucket.length < 2) continue;

        // ⚠️ **嵌套的前缀不算两套写法**：
        // `qoj:c` 与 `qoj:c:1435` 是**同一族**的键（后者只是多带了一段 —— 比赛下面还挂着题目）。
        // 真"规范漂移"的样子是**互不派生**的两种写法（如 `qoj:c:1` vs `qoj:contest:1`）。
        const distinct = prefixes.filter(p => !prefixes.some(q => q !== p && p.startsWith(`${q}:`)));
        if (distinct.length < 2) continue;

        // ⚠️ 还有两类**显然是有意为之**的，一并跳过（实测真包剩下那 4 条全是它们）：
        //   ① 挂在辅助根 `aux` 下的 W —— `aux-<渠道>` 是**文档里写明的**约定
        //      （`xcpc_common.AUX_TREES`，键**故意不带冒号**：第一段就是"树身份"）；
        //   ② 前缀只差**纯数字**段（`qoj:c:1358` vs `qoj:c:1404`）—— 那一段是**节点自己的 id**
        //      （一个系列下本来就挂着很多场比赛），不是两种拼法。
        if (parentKey === 'aux') continue;
        const skeletons = new Set(distinct.map(p => p.replace(/[0-9]+/g, '#')));
        if (skeletons.size < 2) continue;

        push({
            code: 'mixed-prefix',
            message: `同一父（${quote(parentKey)}）下的 ${bucket.length} 个「${typeLabel}」节点用了 ` +
                `${distinct.length} 种互不派生的前缀写法：${distinct.map(quote).join(' / ')}` +
                (distinct.length < prefixes.length
                    ? '（另有同族的嵌套写法已折叠，如 qoj:c 与 qoj:c:1435）' : '') +
                '。这只提示"规范可能不统一"，「不影响导入」；若是有意为之可忽略',
            extKey: bucket[0].extKey,
            index: bucket[0].index
        });
    }

    // ---- 排序：记录下标升序，其次 code（未知下标排最后） ----
    const indexOf = finding => (finding.index === undefined ? Number.MAX_SAFE_INTEGER : finding.index);
    findings.sort((a, b) => {
        const diff = indexOf(a) - indexOf(b);
        if (diff !== 0) return diff;
        return a.code < b.code ? -1 : (a.code > b.code ? 1 : 0);
    });

    return findings;
}

// ================================================================
// 拼装（3.4）—— 约定，非强制；应用不依赖它
// ================================================================

/**
 * 按 3.4 的推荐拼法，为一组已收集到的平台标识生成 extKey。
 *
 * 这是给爬虫作者与「补身份键」页的**便捷函数**：应用永远不反过来解析 extKey，
 * 所以这里只是纯字符串拼接。
 *
 * 规则（platform 先 trim + 小写）：
 *   有 submissionId                     → `${platform}:sub:${submissionId}`
 *   否则有 problemId 且有 contestId     → `${platform}:${contestId}:${problemId}`
 *   否则有 contestId                    → `${platform}:${contestId}`
 *   否则                                → `${platform}`
 * platform 缺失 / 为空 → `''`（不抛异常）
 *
 * @param {{platform?:string, contestId?:string, problemId?:string, submissionId?:string}} parts
 * @returns {string}
 */
export function composeExtKey(parts) {
    const source = (typeof parts === 'object' && parts !== null) ? parts : {};

    const platform = normalizeExtKey(source.platform).toLowerCase();
    if (!platform) return '';

    const contestId = normalizeExtKey(source.contestId);
    const problemId = normalizeExtKey(source.problemId);
    const submissionId = normalizeExtKey(source.submissionId);

    // 提交用 `sub` 段，避免与比赛的纯数字 ID 撞车（3.4）
    if (submissionId) return `${platform}:sub:${submissionId}`;
    if (problemId && contestId) return `${platform}:${contestId}:${problemId}`;
    if (contestId) return `${platform}:${contestId}`;
    return platform;
}
