// ================================================================
// 节点自动导入 — qoj 结构适配器（features/AutoImport/adapters/qoj.js）
// 职责：把 qoj 原生导出（中文列名的顶层数组）转成成熟 crate（7.1 的形状）
// 依赖：../constants.js
// 设计依据：docs/auto-import.md 3.4 / 7.1 / 7.5 / 7.7，以及 **2.5**
// 校准样本：仓库根目录的 qoj_problems.json / qoj_submissions.json
//
// 适配器只做**结构**归一（顶层是数组还是对象、extKey 怎么拼），
// **不猜字段语义**——语义一律由产出的 fieldMap 声明（7.3 / 7.7）。
//
// ⚠️ 容器链必须合法（2.5）：TYPE_CHILDREN_MAP 是
//      O → W/S，W → S/W，S → C/S，C → P，P → R
//    也就是说 **W 下不能直接放 C**。而 qoj 没有"系列"概念，
//    所以这里必须插一层 S 作为"比赛分组"，否则下游 upsert 会以
//    bad-parent-type 把每一条 C 都拒掉。
//
// extKey 拼法（3.4）：
//   平台    qoj                       ← 常量
//   比赛分组 qoj:contest               ← 常量（只为满足层级约束）
//   比赛    qoj:<contestId>           ← 题目链接里的 contest/<ID>
//   题目    qoj:<contestId>:<题目ID>  ← 题目ID（平台稳定主键，不用题号，决策 18）
//   提交    qoj:sub:<提交ID>          ← 提交ID
//
// 说明：本模块**不碰 DOM、不 import view/ shell/**，可在 Node 测试中直接引用。
// ================================================================
import { CURRENT_CRATE_VERSION } from '../constants.js';
import { isFieldApplicableTo } from '../../../core/model/elements.js';
import { isPlainObject } from '../../../utils/guards.js';

/** 平台码与默认平台节点 extKey */
const DEFAULT_PLATFORM_KEY = 'qoj';

/** 比赛分组的 extKey 后缀（qoj 无系列概念，纯为满足 W→S→C 约束） */
const CONTEST_GROUP_SEGMENT = 'contest';

/** 比赛分组的默认显示名 */
const CONTEST_GROUP_NAME = 'QOJ Contest';

/** 从 题目链接 里取 contestId / 题目ID（3.4 的正则） */
const CONTEST_ID_RE = /contest\/(\d+)/;
const PROBLEM_ID_RE = /problem\/(\d+)/;

/**
 * 产出 crate 的 fieldMap（7.1 / 7.5）。
 *
 * - `null` = 该列**显式忽略**（身份输入，不是节点字段）；
 * - 刻意**不列** `是否通过` / `得分` / `时间` / `内存` / `代码长度` /
 *   `用户主页`：它们是未使用字段，会被记进导入记录后丢弃（14）。
 *   尤其 `是否通过`——P 的 status2 由 R 子节点推导，爬虫不必写（7.6）。
 *
 * `提交者` 是**账户线索**（仍不是业务字段）
 * （所以这里显式忽略，别让它变成节点的字段），但会被写进记录级元列
 * `账户线索`，由 `state.accounts[*].mappings` 解释（应用不猜语义）。
 */
const QOJ_FIELD_MAP = Object.freeze({
    '题号': 'problemId',
    '题目名称': 'name',
    '题目链接': 'link',
    '提交链接': 'link',
    '结果': 'status',
    '提交时间': 'time',

    '题目ID': null,
    'contestId': null,
    '提交ID': null,
    '提交者': null
});

/**
 * 提交记录（R）必须丢掉的列：**映射目标不适用于 R 的那些**。
 *
 * 为什么需要它：`fieldMap` 是整包级的，而提交和题目共用一份原始列（都有 `题号`）。
 * `题号 → problemId`，而 `problemId` 是 P 的元素（见 core/model/elements.js 的 `types`）——
 * 于是 R 记录会带着一个 P 专有字段，导入时被**类型适用性校验**拒掉（`field-not-applicable`）。
 * 提交属于哪道题由 `父extKey` 表达，不需要这个字段。
 *
 * 判定**从属性表来**：以后 fieldMap 里再加 P 专有的映射，这里自动跟上。
 */
const SUBMISSION_DROP_COLUMNS = Object.freeze(
    Object.keys(QOJ_FIELD_MAP).filter((column) => {
        const target = QOJ_FIELD_MAP[column];
        return target && !isFieldApplicableTo(target, 'R');
    })
);

// ================================================================
// 小工具
// ================================================================

/** 是普通对象（非 null、非数组） *//** 取第一个非空字符串（trim 后），全空返回 '' */
function pickString(...values) {
    for (const v of values) {
        if (v === undefined || v === null) continue;
        const s = String(v).trim();
        if (s !== '') return s;
    }
    return '';
}

/** 用正则从链接里抓出数字 ID，抓不到返回 '' */
function matchId(re, text) {
    if (typeof text !== 'string') return '';
    const m = re.exec(text);
    return m ? m[1] : '';
}

/** 内容哈希（FNV-1a 32 位）——仅在 题目ID 缺失时兜底拼 key 用 */
function hashText(text) {
    const s = String(text === undefined || text === null ? '' : text);
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
}

/**
 * 拆出待转换的记录数组。
 * 顶层数组直接使用；也接受 `{ problems: [...] }` / `{ submissions: [...] }`
 * 这类包裹形态（detectAdapter 也认它们）。其余一律 null。
 */
function unwrapList(data) {
    if (Array.isArray(data)) return data;
    if (isPlainObject(data)) {
        if (Array.isArray(data.problems)) return data.problems;
        if (Array.isArray(data.submissions)) return data.submissions;
        if (Array.isArray(data.records)) return data.records;
    }
    return null;
}

// ================================================================
// 转换
// ================================================================

/**
 * 把 qoj 原生载荷转成成熟 crate 对象。
 *
 * 载荷类型**逐条**判定：有 `提交ID` 的按提交记录处理，其余按题目处理，
 * 因此混合数组天然支持。提交记录会顺带补齐它需要的 C / P 父记录
 * （树上没有父节点时整条会被拒绝，见 2.3/决策 12）。
 *
 * @param {Array<Object>} data - 如 qoj_problems.json / qoj_submissions.json 的内容
 * @param {Object} [opts]
 * @param {string} [opts.platformKey] - 平台码，默认 'qoj'
 * @returns {{ok:boolean, crate:Object|null, errors:Array<{code:string,message:string}>}}
 */
export function toCrate(data, opts = {}) {
    const options = isPlainObject(opts) ? opts : {};
    const errors = [];

    try {
        const platformKey = pickString(options.platformKey) || DEFAULT_PLATFORM_KEY;
        const list = unwrapList(data);

        if (!list) {
            return {
                ok: false,
                crate: null,
                errors: [{
                    code: 'not-array',
                    message: 'qoj 适配器只接受顶层数组，或形如 { problems: [...] } / { submissions: [...] } 的对象'
                }]
            };
        }

        if (list.length === 0) {
            return {
                ok: false,
                crate: null,
                errors: [{ code: 'empty-payload', message: '载荷是空数组，没有可转换的记录' }]
            };
        }

        const records = [];
        /** 已产出过的 extKey（防止本包内自相撞，3.2 / 2.4） */
        const emitted = new Set();

        const pushOnce = (record) => {
            if (emitted.has(record.extKey)) return false;
            emitted.add(record.extKey);
            records.push(record);
            return true;
        };

        // 平台节点 W：省略 父extKey ⇒ 挂根（3.3 / 决策 16）
        pushOnce({ '节点类型': 'W', extKey: platformKey });

        // 比赛分组 S：W 下不能直接放 C（2.5），必须插这一层
        const groupKey = `${platformKey}:${CONTEST_GROUP_SEGMENT}`;
        pushOnce({
            '节点类型': 'S',
            extKey: groupKey,
            '父extKey': platformKey,
            '比赛名称': CONTEST_GROUP_NAME
        });

        /** 保证比赛 C 记录存在，返回它的 extKey（父是比赛分组 S） */
        const ensureContest = (contestId) => {
            const key = `${platformKey}:${contestId}`;
            pushOnce({ '节点类型': 'C', extKey: key, '父extKey': groupKey });
            return key;
        };

        /** 保证题目 P 记录存在（提交记录会顺带补出父题目），返回它的 extKey */
        const ensureProblem = (contestId, problemId, src) => {
            const key = `${platformKey}:${contestId}:${problemId}`;
            if (!emitted.has(key)) {
                const record = {
                    '节点类型': 'P',
                    extKey: key,
                    '父extKey': `${platformKey}:${contestId}`
                };
                // 从提交记录补出来的 P，只顺带带上已知的展示列
                for (const column of ['题号', '题目名称', '题目链接', '题目ID']) {
                    if (src && src[column] !== undefined) record[column] = src[column];
                }
                pushOnce(record);
            }
            return key;
        };

        list.forEach((raw, index) => {
            if (!isPlainObject(raw)) {
                errors.push({ code: 'bad-record', message: `第 ${index} 条：不是对象，已跳过` });
                return;
            }

            const link = pickString(raw['题目链接']);
            const contestId = pickString(raw.contestId) || matchId(CONTEST_ID_RE, link);

            // ---------------- 提交记录（有 提交ID） ----------------
            const hasSubmissionId = raw['提交ID'] !== undefined && raw['提交ID'] !== null;
            if (hasSubmissionId) {
                const submissionId = pickString(raw['提交ID']);
                if (submissionId === '') {
                    errors.push({
                        code: 'missing-submission-id',
                        message: `第 ${index} 条：提交ID 为空，算不出 extKey，已跳过（4.4 无身份键即拒绝）`
                    });
                    return;
                }

                if (contestId === '') {
                    errors.push({
                        code: 'missing-contest-id',
                        message: `第 ${index} 条（提交 ${submissionId}）：题目链接里找不到 contest/<ID>，无法定位比赛，已跳过`
                    });
                    return;
                }

                const problemId = pickString(raw['题目ID']) || matchId(PROBLEM_ID_RE, link);
                if (problemId === '') {
                    errors.push({
                        code: 'missing-problem-id',
                        message: `第 ${index} 条（提交 ${submissionId}）：题目链接里找不到 problem/<ID>，无法定位父题目，已跳过`
                    });
                    return;
                }

                ensureContest(contestId);
                const parentExtKey = ensureProblem(contestId, problemId, raw);

                const sub = Object.assign({}, raw, {
                    '节点类型': 'R',
                    extKey: `${platformKey}:sub:${submissionId}`,
                    '父extKey': parentExtKey
                });
                // 丢掉 P 专有列（见 SUBMISSION_DROP_COLUMNS 的说明）
                for (const column of SUBMISSION_DROP_COLUMNS) delete sub[column];
                // 账户线索：`提交者` 是"这条提交关于谁"，不是节点字段。
                // 写成与 `字段来源` 同级的**元列**，由账户映射表解释。
                const submitter = pickString(raw['提交者']);
                if (submitter) {
                    sub['账户线索'] = { source: platformKey, field: '提交者', value: submitter };
                }
                pushOnce(sub);
                return;
            }

            // ---------------- 题目记录（默认分支） ----------------
            if (contestId === '') {
                errors.push({
                    code: 'missing-contest-id',
                    message: `第 ${index} 条：题目链接里找不到 contest/<ID>（也没有 contestId 列），拼不出 extKey，已跳过`
                });
                return;
            }

            let problemId = pickString(raw['题目ID']);
            if (problemId === '') {
                // 不用题号当 key（决策 18）；用内容哈希兜底，并把风险说出来
                problemId = `h${hashText([pickString(raw['题号']), pickString(raw['题目名称']), link, contestId].join('|'))}`;
                errors.push({
                    code: 'missing-problem-id',
                    message: `第 ${index} 条：题目ID 缺失，已用「题号+题名+链接」的哈希兜底为 ${problemId}；该 key 只在内容不变时稳定，请让爬虫补上题目ID`
                });
            }

            ensureContest(contestId);
            pushOnce(Object.assign({}, raw, {
                '节点类型': 'P',
                extKey: `${platformKey}:${contestId}:${problemId}`,
                '父extKey': `${platformKey}:${contestId}`
            }));
        });

        const crate = {
            crateVersion: CURRENT_CRATE_VERSION,
            source: { id: 'qoj-scraper', label: 'QOJ 爬虫', platform: 'qoj' },
            generatedAt: '',
            fieldMap: Object.assign({}, QOJ_FIELD_MAP),
            defaults: { fieldPolicies: {} },
            fieldPolicies: {},
            records
        };

        return { ok: true, crate, errors };
    } catch (err) {
        return {
            ok: false,
            crate: null,
            errors: [{
                code: 'internal-error',
                message: `qoj 适配器内部错误：${err && err.message ? err.message : String(err)}`
            }]
        };
    }
}
