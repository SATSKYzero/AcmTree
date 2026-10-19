// ================================================================
// 节点自动导入 — 常量（features/AutoImport/constants.js）
// 职责：字段策略枚举与默认表、阈值、适配器登记
// 依赖：core/model/elements.js（字段白名单由属性表派生）
// 设计依据：docs/auto-import.md 第六、七节
// ================================================================
import { importableElements } from '../../core/model/elements.js';
import { TYPE_CHILDREN_MAP } from '../../core/model/constants.js';

// ================================================================
// 导入包版本
// ================================================================

/** 本插件支持的 crate 版本（版本不符 → 整包报错，不猜） */
export const SUPPORTED_CRATE_VERSIONS = Object.freeze([1]);
export const CURRENT_CRATE_VERSION = 1;

// ================================================================
// 字段策略（docs/auto-import.md 6.1）
// ================================================================

export const POLICY = Object.freeze({
    NEVER: 'never',
    FILL_IF_EMPTY: 'fill-if-empty',
    OVERWRITE_IF_CHANGED: 'overwrite-if-changed',
    FORCE: 'force'
});

/** 合法策略名（供 `defaults.fieldPolicies` 校验） */
export const VALID_POLICIES = Object.freeze(Object.values(POLICY));

// ================================================================
// 默认策略表（6.2）
// 索引是**内部字段名**——即 fieldMap 映射之后的名字
// ================================================================

/**
 * 新建节点时的默认策略 —— **派生，不手写**
 *
 * 规则一句话：**凡是 `elements.js` 里 `importable: true` 的字段，都有策略** ——
 * 默认 `overwrite-if-changed`（包里值与树上不同就写）；下面那两组"例外"才单独列。
 *
 * ⚠️ 为什么要派生：手写表一旦漏登记，该字段就回落 `never`（值只进来源层、
 * 节点永远空）—— `atcoderDifficulty` / `clistDifficulty` 这类字段漏掉就是
 * 4600 多个难度值导不进节点。派生之后，"新字段忘了登记"这个 bug **不可能再出现**。
 * （`importableElements()` 与下面的 `WRITABLE_FIELDS` 用的是同一个真源。）
 */
const CREATE_FILL_IF_EMPTY = Object.freeze([
    // 「性质」四字段：人工整理的归类，**你手填过的一律不动**（只在空着时让包补）
    'natureClass', 'natureYear', 'natureSeason', 'natureRegion',
    // 客观测得值：同样只补空（不会有"反复变动"的语义）
    'identityKey', 'kind', 'submitKind', 'language', 'timeUsed', 'memoryUsed', 'codeLength'
]);

/** 新建表 = 派生（默认）＋ 例外（上面那组 fill-if-empty） */
function buildPolicyTable(kind) {
    const out = {};
    for (const field of importableElements()) {
        if (kind === 'create') {
            out[field] = CREATE_FILL_IF_EMPTY.includes(field)
                ? POLICY.FILL_IF_EMPTY : POLICY.OVERWRITE_IF_CHANGED;
        } else {
            // 已存在：默认**只补空、绝不动你改过的值**；例外见 EXISTING_OVERWRITE / EXISTING_NEVER
            out[field] = EXISTING_OVERWRITE.includes(field)
                ? POLICY.OVERWRITE_IF_CHANGED
                : (EXISTING_NEVER.includes(field) ? POLICY.NEVER : POLICY.FILL_IF_EMPTY);
        }
    }
    return Object.freeze(out);
}

/**
 * 已存在时的**两个例外组**（每组都要有理由；其余一律 `fill-if-empty`）。
 *
 * · `EXISTING_OVERWRITE = ['ownerSynth']` —— 成员指针要能**跟包走**（重导补归属）；
 *   而"包不得覆盖树上已存在的非空指针"那条硬规则在 `plan.js` 的 `planPointers` 里
 *   （策略层写成 `never` 会让"重导补归属"整条失效）。
 *   ⚠️ **`problemId` 不在这里**（曾经想加过，已撤）：题号是**各来源自己的事实**，
 *   产包侧（`scripts/problem-bind.mjs`）**不写回它**；"哪条属于哪一组"由配对算、落在
 *   `ownerSynth` 上就够了。让它跟包走会引入"同一份包算两遍得到两套答案"的自伤
 *   （见那个文件头那段）。
 * · `EXISTING_NEVER = ['tags', 'synthKey', 'time', 'status']` ——
 *   `tags` 是你手工整理的知识点；`synthKey` 由两阶段合成通道写（不走普通合并）；
 *   `time` / `status` 走 **R 专用的类型表**（`merge.js` 的 `R_EXISTING_DEFAULTS`，
 *   PD → AC 要能更新）。
 */
export const EXISTING_OVERWRITE = Object.freeze(['ownerSynth']);
export const EXISTING_NEVER = Object.freeze(['tags', 'synthKey', 'time', 'status']);

/** 新建节点时的默认策略（派生） */
export const CREATE_POLICY_DEFAULTS = buildPolicyTable('create');

/**
 * 已存在节点时的默认策略（**派生**，见上面的例外组）。
 *
 * 语义一句话：**只补空、绝不动你改过的值**；`ownerSynth` 例外（要能跟包走），
 * `tags`/`synthKey`/`time`/`status` 是 `never`（理由见 `EXISTING_NEVER`）。
 * ⚠️ "`link` 不在表内" ≠ "第二次导入不覆盖链接"：它走 `fill-if-empty`
 * （空着的链接重导时补上；手填过的仍然不动）。
 */
export const EXISTING_POLICY_DEFAULTS = buildPolicyTable('existing');

/**
 * 新建节点时也**必须**为 never 的字段
 * （remark 是唯一不可再生数据，任何情况都不由导入写）
 */
export const ALWAYS_NEVER_FIELDS = Object.freeze(['remark']);

/**
 * 允许由导入写入的字段白名单
 * = 节点上有意义的、非派生、非结构的字段
 *
 * ⚠️ **不手写**：它来自 `core/model/elements.js` 属性表里 `importable: true` 的元素
 * （"元素是什么性质"只有那一处真源；这里只做派生）。
 * **跨语言的那一份**（`scripts/crate.py` 的 `WRITABLE_FIELDS`）没法 import JS、只能手抄 ——
 * 所以**有对拍**：`scripts/crate_selftest.py` 会起 node import 本模块、把这份清单与 Python
 * 那份逐字比一遍（加字段时漏了一边，`npm run crate:selftest` 当场红；不用再靠"记得同步"）。
 */
export const WRITABLE_FIELDS = Object.freeze(importableElements());

// ================================================================
// 相似度警告（4.6）
// ================================================================

/** 低于该相似度就不吭声。只影响"说不说"，**不参与任何判定**。
 *  真源在 `utils/similarity.js`（通用工具，判重整理页也用它）—— 这里转一手，
 *  导入侧仍然只 import 这一个 constants。 */
export { DEFAULT_SIMILARITY_THRESHOLD } from '../../utils/similarity.js';

// ================================================================
// 适配器登记（7.7）
// ================================================================

/**
 * 平台适配器清单
 * 适配器只做**结构**归一（顶层是数组还是对象、extKey 怎么拼），
 * **不做字段语义猜测**——字段语义一律由包内 fieldMap 声明（7.3）。
 *
 * 注意：适配器是**可选**的。成熟的 crate（自带 fieldMap +
 * 节点类型 + extKey + 父extKey）走 `parseCrate` 的快路径，不需要适配器。
 */
export const ADAPTERS = Object.freeze({
    qoj: 'qoj',
    codeforces: 'codeforces'
});

// ================================================================
// 节点类型
// ================================================================

/** 合法节点类型 —— **从父子约束表派生**（唯一来源，别再手抄一份名单） */
export const NODE_TYPES = Object.freeze(Object.keys(TYPE_CHILDREN_MAP));

export function isValidNodeType(type) {
    return NODE_TYPES.includes(String(type || '').trim().toUpperCase());
}

// ================================================================
// 导入记录的持久化位置
// ================================================================

/**
 * 导入记录 / 配置写在 settings 下
 * 位置：state.settings.autoImport
 *   - history: 最近 N 次导入的摘要
 *   - scanner: 目录轮询配置（接线层用）
 */
export const SETTINGS_KEY = 'autoImport';
export const HISTORY_LIMIT = 50;
