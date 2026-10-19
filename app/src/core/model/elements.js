// ================================================================
// 元素属性表（core/model/elements.js）
//
// 这是"**有哪些元素**、每个元素**是什么性质**"的**唯一属性源**。
//
// 依赖：A_constants.js（只为一个默认值：新标签的颜色）—— 那个文件是叶子，不成环。
// ================================================================
import { DEFAULT_TAG_COLOR } from '../../A_constants.js';

/**
 * ★ **"这一组（题目组）人确认过"的字段名** —— 字面量的**唯一定义处**。
 *
 * 它必须登记成一个**能随包走的字段**（否则重建一次就丢），所以定义放在这张属性表里；
 * `core/synthPlan.js` 的 `CONFIRM_FIELD` 与 `scripts/problem-bind.mjs` 都**引用这一份**
 * （那边只是转发，别再抄字面量）。
 *
 * 为什么是**组级、一行**：以前它塞在成员的 `分类依据.ownerSynth='manual:set'` 里，
 * 而那一格**脚本改指针时也会写**（`applyOwnerSynth` 一律打它）⇒ "确认"被污染成"任何一次动作"，
 * 脚本产出的指针也被当成人的结论锁死（"点一次换一次、永远改不动"）。
 */
export const CONFIRM_FIELD_NAME = '已确认';

/**
 * ★ **"这一条与同号那道题**不是同一道**"的标记**（成员级；名字的唯一定义处）。
 *
 * 来由：两个来源对同一题号给了不同的题名 —— 绝大多数是**同一道题的中/英两种写法**，
 * 少数**确实是两道不同的题**。算法默认按号共用（报"题名不一致"交给人），
 * 人在 ⑤ 点「✂️ 不同的题」时给这条打上它 ⇒ 算法给它发 `X1、X2…` 溢出号，从此分属两组。
 */
export const SPLIT_FIELD_NAME = '拆开';

// 为什么要这张表
// ----------------------------------------
// "手改判据（我敲过它 ∧ 它确实变了）"、"只读时禁不禁"、"导入能不能写"、
// "值级来源记不记" —— 这些规则若**逐处手写特判**：
//   `updateP` 只对 name/ratio 记手改、`manualRecorder` 里硬写 `tags` 不记、
//   `WRITABLE_VALUE_FIELDS` 在 core 里抄一份、`WRITABLE_FIELDS` 在 features 里再抄一份……
// 结果就是 R 的字段、`problemId`/`link` 的手改**根本不进来源层**（实测踩到）。
//
// 正确做法：**先让所有元素过同一条规则，需要特判的元素靠"属性字段"特判**。
// 于是规则只读属性、不含 if：加新字段 = 在这里写一行；要新性质 = 加一个属性。
//
// 属性的含义
// ----------
//   nature     元素的性质（见 ELEMENT_NATURE）
//   types      它属于哪些节点类型（`*` = 通用）—— **导入时按它校验**（`inapplicableFields`）
//   importable 导入包**可以写**它（`WRITABLE_FIELDS` 的语义）
//   manual     用户**手改**它时记一条来源值（`WRITABLE_VALUE_FIELDS` 的语义）
//   shape      值的形状：`scalar`（默认）| `list`（列表型字段，如 tags）
//   take       ★ 这一格"**怎么取**"（模板：一个字段怎么取**只写这一行**）：
//                `{ agg: <聚合器名>, materialize: <要不要回代物化> }`
//                · `agg` 必须是 `core/groupValue.js` 的 `AGG_BUILDERS` 的键（**没有 = 这格没有"组那份"**）；
//                · `materialize: true` ⇒ 进 `GROUP_FIELDS`（逐层物化的"回代覆盖表"）——
//                  那张名单现在**由这份派生**（`Object.keys(ELEMENTS).filter(...)`，不再是手写清单）。
//              ⚠️ 两件事**刻意不在这里**（别往这张表里塞）：
//                · **"读本份"走哪条**：由 `nature` 决定（唯一分流在 `view/scope.js` 的 `ownColumnReader`）；
//                · **"取哪一份"（本份 / 合并那份）**：那是**显示列**的事，判据只有
//                  `view/scope.js` 的 `displayColumnOf`（模式 + 逐字段覆盖）—— 见 `src/core/AGENTS.md`
//                  的「显示列（plain / dedup）」一节。它是**按调用点**决定的，不是字段的属性。
//
// ⚠️ 导入的**合并策略**（never / fill-if-empty …）不在这里，它们在
//    `features/AutoImport/constants.js` 的 CREATE/EXISTING_POLICY_DEFAULTS ——
//    那是"导入时怎么合并"的策略，与"元素是什么性质"是两件事（别混）。
//
// 说明：纯常量 + 纯函数，可进 Node 单测（唯一的 import 是叶子常量文件）。
// ================================================================

/** 元素性质 */
export const ELEMENT_NATURE = Object.freeze({
    /** 普通字段：多个来源各说一个值 → 投影选一个 */
    FIELD: 'field',
    /** 列表型字段：值本身是有序列表（如标签列表） */
    TAG_LIST: 'tagList',
    /** 身份：决定"是不是同一个东西"（导入可写、手改算手改、只读时禁） */
    IDENTITY: 'identity',
    /** 私有笔记（remark）：非可再生，导入永不写，手改要留痕 */
    NOTE: 'note',
    /** 派生字段：由 core/autoCompute.js 算出来 → 不记来源（记了也会被下一轮重算冲掉） */
    DERIVED: 'derived',
    /** 结构/元信息：由树结构或运行时决定，谁都不该当字段写它 */
    STRUCTURAL: 'structural',
    /** 存在性：元素"在不在"本身也是一个元素，记它的来源/账户 */
    EXISTENCE: 'existence'
});

/**
 * 元素表。
 *
 * 顺序 = `WRITABLE_FIELDS` 的顺序（有单测钉住，防漂移）。
 */
export const ELEMENTS = Object.freeze({
    // ---------------- 普通字段（导入可写 + 手改留痕） ----------------
    name: { nature: ELEMENT_NATURE.FIELD, types: '*', importable: true, manual: true },
    problemId: { nature: ELEMENT_NATURE.FIELD, types: ['P'], importable: true, manual: true },
    cfDifficulty: {
        nature: ELEMENT_NATURE.FIELD, types: ['P'], importable: true, manual: true,
        take: { agg: 'cfDifficulty', materialize: true }
    },
    // **数值难度字段组**的另一员（AtCoder：kenkoooo problem-models 的 difficulty，可为负数）
    atcoderDifficulty: {
        nature: ELEMENT_NATURE.FIELD, types: ['P'], importable: true, manual: true,
        take: { agg: 'atcoderDifficulty', materialize: true }
    },
    // 数值难度字段组第三员（CLIST 的难度口径；可为空 = clist 也没给）
    clistDifficulty: {
        nature: ELEMENT_NATURE.FIELD, types: ['P'], importable: true, manual: true,
        take: { agg: 'clistDifficulty', materialize: true }
    },
    ratio: {
        nature: ELEMENT_NATURE.FIELD, types: ['P'], importable: true, manual: true,
        take: { agg: 'ratio', materialize: true }
    },
    link: { nature: ELEMENT_NATURE.FIELD, types: '*', importable: true, manual: true },
    tags: {
        nature: ELEMENT_NATURE.TAG_LIST, types: ['P'], importable: true, manual: true, shape: 'list'
        // 为什么 tags 单独一种性质：它的**值是一个列表**（"这份标签列表是谁给的"）。
        // 来源层只会 `String(value)`，对数组会得到 `[object Object]`，
        // 所以它一直是被硬性排除的特判；现在由 `shape: 'list'` 明说。
        // ⚠️ tag 本身以后会变成**节点**（还要加 tag 归类）——
        //    到那时这个字段的值 = 标签节点 id 的列表，是一次单独的数据迁移。
    },
    // ⚠️ `format: 'time'` = **这一格的值是时间**（应用内部格式 `YYYY.MM.DD HH:MM`）——
    //    导入合并前要过 `normalizeTime` 标准化，否则"字符串比较"会算错（见
    //    `features/AutoImport/merge.js` 的 `TIME_FIELDS`：它**从这一份派生**，不再手写清单）。
    contestTime: {
        nature: ELEMENT_NATURE.FIELD, types: ['C'], importable: true, manual: true, format: 'time',
        // 有聚合器（组里任一份的时间都算数）但**不回代**：时间只有 C 用得上 ⇒ 走按需聚合
        take: { agg: 'contestTime' }
    },
    // C 的**榜单链接**：
    //   "别和补题链接混一起" —— C 上的 `link` 是**泛化引用**（xcpcio 是榜单、rankland 是
    //   github 数据源、cf 是 gym 主页），语义不纯；抢了榜首的那两个位置也不该混。
    //   所以榜单链接**单独一个字段**，各来源都可以写自己的榜单地址（策略 fill-if-empty：
    //   权威榜单来源先到先得），`link` 一律不动。
    // C 的种类：`contest` 真实比赛 / `practice` 练习容器（散题挂在它下面）
    kind: { nature: ELEMENT_NATURE.FIELD, types: ['C'], importable: true, manual: true },
    // P 的跨场身份：同一道题出现在多场比赛时共享（树仍是树，跨场靠这个字段关联）
    identityKey: { nature: ELEMENT_NATURE.IDENTITY, types: ['P'], importable: true, manual: true },
    // 「合成」：把"其实是同一个东西"这件事
    // 显式建成树上的一个**真节点**（合成节点），原料节点靠指针挂进去。
    //   · `synthKey`   只长在合成节点上（身份，全局唯一，保留前缀 `synth:`）
    //   · `ownerSynth` 只长在原料节点上（指针，值是某个 `synthKey`）
    // 两者都是**结构性的全局信息**，不是"某账户在某渠道看到的值"：
    //   · 导入包**可以带**（`importable: true`）—— 别的机器上的合成分工要能过来；
    //   · 但**不记手改来源值**（`manual: false`）—— 换账户看，它还是同一个关系。
    // 只有 C/P/R 参与合成（W/S/O 是容器，见 core/ops/synth.js）。
    synthKey: {
        nature: ELEMENT_NATURE.FIELD, types: ['C', 'P', 'R'], importable: true, manual: false
    },
    ownerSynth: {
        nature: ELEMENT_NATURE.FIELD, types: ['C', 'P', 'R'], importable: true, manual: false
    },
    // R（提交记录）
    // 提交的**性质**：`赛时` / `VP` / `补题`；**判不出就留空**
    // （不写"未知" —— 留空表示"还没判出来 / 无从判断"，以后重抓还能补上）。
    // 它决定 P.status2 是「4 赛时通过」还是「3 赛后补题」（`pStatus2` 只看赛时的 AC）。
    submitKind: { nature: ELEMENT_NATURE.FIELD, types: ['R'], importable: true, manual: true },
    time: { nature: ELEMENT_NATURE.FIELD, types: ['R'], importable: true, manual: true, format: 'time' },
    status: { nature: ELEMENT_NATURE.FIELD, types: ['R'], importable: true, manual: true },
    // ---- 提交的运行信息（"先提取备用"：CF/QOJ 都有，先存下来）----
    // 口径统一：`timeUsed` = **毫秒**、`memoryUsed` = **字节**。两家的原始格式不同
    // （CF 给纯数字，QOJ 给 `95ms` / `4956kb`），由适配器负责归一，界面才好横向比。
    language: { nature: ELEMENT_NATURE.FIELD, types: ['R'], importable: true, manual: true },
    timeUsed: { nature: ELEMENT_NATURE.FIELD, types: ['R'], importable: true, manual: true },
    memoryUsed: { nature: ELEMENT_NATURE.FIELD, types: ['R'], importable: true, manual: true },
    codeLength: { nature: ELEMENT_NATURE.FIELD, types: ['R'], importable: true, manual: true },

    // ---------------- 「性质」三个字段（分类 / 年份 / 地区） ----------------
    //   · `natureClass`（界面「分类」）：值 = 有序字符串列表，**节点上存 `/` 连起来的字符串**
    //     （`"xcpc/icpc/ec/pre"`）。合法性 = 注册表文件里的 Trie，**任何前缀都合法**；
    //     `无归类` = 判过了但归不进去；空 = 还没标。
    //   · `natureYear`（`20xx`）/ `natureRegion`（自由文本，脚本对线上赛填「无」）与分类**正交**。
    //
    // 为什么仍是**普通字段**而不是一个 `nature` 对象：值级来源层（`node.values`）是**按字段名**记的，
    // 收成一个对象字段，`addSourceValue` / 投影 / 编辑弹窗全都得为它开特例 ——
    // 与"规则只读属性、不含 if"（本文件顶部）直接冲突。
    //
    // `types: '*'`：C/P/R/W/S **都可能要标**（判重只在同性质之间发生，而噪声横跨渠道与类型）。
    // `importable: true` + `manual: true`：爬虫产包要能写，人也要能手改。
    // **三个都可空** —— 没标就是没标，节点默认值里刻意不给占位值。
    // 注册表（Trie + 字段定义）**唯一真源**：`acm-data/nature-registry.json`，
    // JS 侧 `core/natureFields.js` 读它、Python 侧 `scripts/crate.py` 读同一份（没有第二份镜像）。
    natureClass: { nature: ELEMENT_NATURE.FIELD, types: '*', importable: true, manual: true },
    natureYear: { nature: ELEMENT_NATURE.FIELD, types: '*', importable: true, manual: true },
    natureSeason: { nature: ELEMENT_NATURE.FIELD, types: '*', importable: true, manual: true },
    natureRegion: { nature: ELEMENT_NATURE.FIELD, types: '*', importable: true, manual: true },
    // ★ **"这一组（题目组）人确认过"** —— **组级标记**，只落在**组头**上（一条，不是每条成员各一枚）。
    //   为什么单独立一格（实测的坑）：以前它塞在成员的 `分类依据.ownerSynth='manual:set'` 里，
    //   而那一格**脚本改指针时也会写**（`applyOwnerSynth` 一律打它）⇒ "确认"被污染成"任何一次动作"，
    //   脚本产出的指针也被当成人的结论锁死（"点一次换一次、永远改不动"）。
    //   类型 `['P']` 是刻意的：它只可能落在题目组头上（不是 `*`）。
    //   ⚠️ 排在**最后**（顺序即 `WRITABLE_FIELDS`，有单测钉住）。
    [CONFIRM_FIELD_NAME]: { nature: ELEMENT_NATURE.FIELD, types: ['P'], importable: true, manual: true },
    // ★ 「这一条与同号那道题**不是同一道**」（成员级；人在 ⑤ 点「✂️ 不同的题」时打上）
    [SPLIT_FIELD_NAME]: { nature: ELEMENT_NATURE.FIELD, types: ['P'], importable: true, manual: true },

    // ---------------- 私有笔记 ----------------
    remark: {
        nature: ELEMENT_NATURE.NOTE, types: '*', importable: false, manual: true
        // 导入**永不写**（`ALWAYS_NEVER_FIELDS`）：题解是不可再生数据。
        // 手改要留痕 —— 它同样是"你写的一个值"，只是不给导入碰。
    },

    // ---------------- 派生字段（自动算，不记来源） ----------------
    status1: {
        nature: ELEMENT_NATURE.DERIVED, types: ['P'],
        take: { agg: 'status1', materialize: true },
        // 它的值不是算出来的，是**用户输入**（"我处理了吗"）—— 所以它和 status2 的
        // "忽略 / 赛时通过" 一样，是一条**用户按下的覆盖**：`1` = 已处理，记进来源层
        // （**带账户**、按查看范围生效）；`0` = 没覆盖（默认）。
        // 声明在这儿之后，记/清、按范围重算、老数据迁移全都不用再写 if
        // （与 status2 共用 `setDerivedOverride` / `effectivePin`）。
        pinValues: ['1']
    },
    status2: {
        nature: ELEMENT_NATURE.DERIVED, types: ['P'],
        take: { agg: 'status2', materialize: true },
        // **可覆盖**：这几个值是"用户按下的"，不是算出来的（规则只会返回 0..3）。
        // 声明在属性上之后，写入/校验/迁移/按范围重算全都不用再写 if。
        pinValues: ['1', '4', '5']      // 待写 / 赛时通过 / 忽略
    },
    acTime: {
        nature: ELEMENT_NATURE.DERIVED, types: ['P'],
        take: { agg: 'acTime', materialize: true }
    },
    lastSubmitTime: {
        nature: ELEMENT_NATURE.DERIVED, types: ['P'],
        take: { agg: 'lastSubmitTime', materialize: true }
    },
    xcpcDifficulty: {
        nature: ELEMENT_NATURE.DERIVED, types: ['P'],
        take: { agg: 'xcpcDifficulty', materialize: true }
    },
    statusComplete1: {
        nature: ELEMENT_NATURE.DERIVED, types: ['W', 'S', 'C'],
        // 有聚合器但**不回代**（C 的容器字段走 `groupValueOnDemand` 按需聚合）
        take: { agg: 'statusComplete1' }
        // 由子树里 P 的 status1 聚合 → 跟着 status1 一起**按查看范围现算**
        // （实现在 `core/derive.js` 的 `deriveContainerStatusComplete1`）
    },
    statusComplete2: {
        nature: ELEMENT_NATURE.DERIVED, types: ['W', 'S', 'C'],
        take: { agg: 'statusComplete2' },
        pinValues: ['4']                // 容器"忽略"
    },

    // ---------------- 结构 / 元信息（谁都不该当字段写） ----------------
    id: { nature: ELEMENT_NATURE.STRUCTURAL, types: '*' },
    type: { nature: ELEMENT_NATURE.STRUCTURAL, types: '*' },
    extKey: { nature: ELEMENT_NATURE.STRUCTURAL, types: '*' },
    createdAt: { nature: ELEMENT_NATURE.STRUCTURAL, types: '*' },
    lastModified: { nature: ELEMENT_NATURE.STRUCTURAL, types: '*' },
    // ⚠️ `expanded` **已经不住在节点上**（视图态，见 `core/model/viewState.js` 的
    //    `state.view.expanded`）。这里留着它**不是为了节点字段**，而是让导入白名单继续
    //    拒绝这个键：包里的 `expanded` 一律不许写进节点（否则"导入不覆盖折叠态"就破了）。
    expanded: { nature: ELEMENT_NATURE.STRUCTURAL, types: '*' },
    // ⚠️ 同 expanded：**已不住在节点上**（视图态 state.view.pages，见 core/model/viewState.js）。
    //    这里留着只为让**导入白名单继续拒绝**这个键（包里的 currentPage 不许写进节点）。
    currentPage: { nature: ELEMENT_NATURE.STRUCTURAL, types: '*' },
    selected: { nature: ELEMENT_NATURE.STRUCTURAL, types: '*' },
    // **这个容器的兄弟顺序是人定过的**（`true` = 人排过 ⇒ 导入时**不许**按规范序重排它）。
    //   为什么需要它（实测）：手排（`handlers/H3_sort.js` 的题目/提交排序、`core/ops/tree.js`
    //   的上移/下移）写的是 `childOrder`，而导入后的 `siblingOrder.orderChildren` 一律按规范序
    //   （P = 题号升序、C = 开赛时间倒序…）**重排所有容器** ⇒ 手动顺序**下次导入就被冲掉**。
    //   STRUCTURAL ⇒ 导入包**写不进**这个键（与 `expanded` 同一姿态：包不许替本机安排顺序）。
    manualOrder: { nature: ELEMENT_NATURE.STRUCTURAL, types: '*' },
    values: { nature: ELEMENT_NATURE.STRUCTURAL, types: '*' },
    importFingerprint: { nature: ELEMENT_NATURE.STRUCTURAL, types: '*' },
    importSource: { nature: ELEMENT_NATURE.STRUCTURAL, types: '*' },
    // **分类依据**（`{ natureClass: 'xcpc:name-stage' }`）—— "这条分类凭什么
    // 判出来的"，由导入包带来（元列 `分类依据`），界面读它画**依据强度**徽标
    // （`core/natureConfidence.js` 的 `CLASS_RULE_LEVEL` / `classLevelOf`）。
    // 为什么是 STRUCTURAL（不是 FIELD）：它**不是**业务字段 —— 没有"多个来源各说一个值"
    // 这回事（一条分类只有一个产出点），也不该进编辑弹窗；导入包更不许把它当字段写
    // （STRUCTURAL ⇒ PROTECTED_NODE_KEYS），只能走 `apply.js` 那条显式通道。
    '分类依据': { nature: ELEMENT_NATURE.STRUCTURAL, types: '*' },

    // ---------------- 存在性 ----------------
    // 节点"在不在"本身也是一个元素：它同样有"谁让它出现的"。
    // 它**不**复用字段模型（没有"多个候选值"这回事），值存在节点的 `origin` 字段上：
    //   `origin = { src: 'manual' | <导入包来源 id>, account, at }`
    // 它同时是**结构保护字段**（core/ops/upsert.js 的 PROTECTED_NODE_KEYS）：
    // 导入包不许写它，否则一个 crate 就能伪造"这个节点是我建的"。
    origin: { nature: ELEMENT_NATURE.EXISTENCE, types: '*' }
});

/** 全部元素名 */
export const ELEMENT_NAMES = Object.freeze(Object.keys(ELEMENTS));

/** 取一个元素的属性（没登记过 → undefined） */
export function elementOf(key) {
    return ELEMENTS[String(key || '')];
}

/** 该元素是否登记过 */
export function isElement(key) {
    return !!elementOf(key);
}

/** 元素性质（未登记 → `'unknown'`） */
export function natureOf(key) {
    const e = elementOf(key);
    return e ? e.nature : 'unknown';
}

/** 值形状：`scalar`（默认）| `list` */
export function shapeOf(key) {
    const e = elementOf(key);
    return (e && e.shape) || 'scalar';
}

/** 导入包是否可以写它 */
export function isImportable(key) {
    const e = elementOf(key);
    return !!(e && e.importable);
}

/** 手改它是否要记一条来源值 */
export function isManuallyEditable(key) {
    const e = elementOf(key);
    return !!(e && e.manual);
}

/** 导入可写的元素名（= `WRITABLE_FIELDS` / `WRITABLE_VALUE_FIELDS`） */
export function importableElements() {
    return ELEMENT_NAMES.filter(isImportable);
}

/**
 * 某类性质的元素名。
 *
 * 为什么要有它：**"哪些字段是派生的""哪些是结构字段"这类名单若抄在多处**
 * （`core/ops/upsert.js` 的 `AUTO_NODE_KEYS` / `PROTECTED_NODE_KEYS`、
 *  `view/dataAdapter.js` 的 `STRUCTURAL_VNODE_KEYS`…），加一个字段就要改好几处
 * （`identityKey` 就这么漏过）。一律从这里派生。
 */
export function natureElements(nature) {
    return ELEMENT_NAMES.filter(k => ELEMENTS[k].nature === nature);
}

/** 派生字段名（自动算、导入不可写；其中一部分可被用户覆盖，见 `pinValuesOf`） */
export function derivedElements() {
    return natureElements(ELEMENT_NATURE.DERIVED);
}

/** 结构/元信息字段名（由树结构或运行时决定，谁都不该当业务字段写） */
export function structuralElements() {
    return natureElements(ELEMENT_NATURE.STRUCTURAL);
}

/**
 * 这个派生元素**可以被用户覆盖**吗？可以的话，哪些值算覆盖？
 *
 * 这是"覆盖"这件事的**唯一真源**：写入（编辑弹窗/批量/粘表格）、校验、
 * 迁移老数据、按范围重算，全都读它 —— 谁都不用再抄一份 `[1,4,5]`。
 *
 * @returns {string[]} 规范形式（字符串）的覆盖值；空数组 = 不可覆盖
 */
export function pinValuesOf(key) {
    const e = elementOf(key);
    return (e && Array.isArray(e.pinValues)) ? e.pinValues.map(String) : [];
}

/** 这个元素是不是覆盖值（按同一张表判断） */
export function isPinValue(key, value) {
    const v = (value === undefined || value === null) ? '' : String(value).trim();
    return v !== '' && pinValuesOf(key).includes(v);
}

// 注：所有派生字段都按查看范围算，**没有**"这个派生字段要不要按范围算"这个开关
// （`status1` / `statusComplete1` 也不留登录口径的例外）。


/** 某节点类型上的元素名（`*` 与指定类型匹配）—— `types` 属性的唯一读取处 */
export function elementsOfType(type) {
    const t = String(type || '');
    return ELEMENT_NAMES.filter((k) => {
        const types = ELEMENTS[k].types;
        return types === '*' || (Array.isArray(types) && types.includes(t));
    });
}

/**
 * 这个元素适用于这个节点类型吗？（`types: '*'` = 所有类型都适用）
 * 未登记的元素返回 `true`（宁可放行，也不凭字段名猜性质 + 不拦插件自有字段）。
 */
export function isFieldApplicableTo(field, type) {
    const e = elementOf(field);
    if (!e) return true;
    const types = e.types;
    if (types === '*') return true;
    return Array.isArray(types) && types.includes(String(type || ''));
}

/**
 * `fields` 里哪些字段**不适用**于这个节点类型（空数组 = 全都适用）。
 *
 * 用途：导入前校验"给 C 节点的记录里带 P 专有字段"这类错误 —— 由 `types` 说了算，
 * 而不是散在各处的 if。（口径：不适用就**拒绝并报错**，不静默丢弃）
 */
export function inapplicableFields(type, fields) {
    const list = Array.isArray(fields) ? fields : Object.keys(fields || {});
    return list.filter(f => !isFieldApplicableTo(f, type));
}

// ================================================================
// 值的规范化 / 比较 / 显示（**按属性表的 shape 决定**）
//
// 为什么放在这里：`core/trust.js`（投影）和 `core/fieldValue.js`（来源层）
// 都要用，而 fieldValue 依赖 trust（不能反向），所以规则放这张无依赖的表里。
//
// 标量（shape: scalar）：一律 trim 成字符串。
// 列表（shape: list）  ：一律规范成**字符串数组**（去空、去重、保序）。
//   为什么不用对象数组：tag 的 `id` 是随机生成的，两个来源说"同一份标签"
//   会得到不同的 id，永远合并不了。值的**内容**就是标签文字，颜色/ID 属于
//   节点自己的展示信息（tag 以后变成节点时，这个值会改成引用那些节点）。
// ================================================================

/**
 * 规范化一个字段值（不改变语义，只统一形状）。
 * @returns {string|string[]}
 */
export function normalizeFieldValue(field, value) {
    if (shapeOf(field) !== 'list') {
        return value === undefined || value === null ? '' : String(value).trim();
    }
    const list = Array.isArray(value) ? value : (value === undefined || value === null || value === '' ? [] : [value]);
    const out = [];
    for (const item of list) {
        const text = String(itemText(item)).trim();
        if (!text) continue;
        if (!out.includes(text)) out.push(text);       // 去重（保序）
    }
    return out;
}

/** 列表里的元素可能是字符串，也可能是 `{text, color}` 这类对象 */
function itemText(item) {
    if (item && typeof item === 'object') {
        return item.text !== undefined ? item.text : (item.v !== undefined ? item.v : '');
    }
    return item;
}

// ----------------------------------------------------------------
// 缓存字段的形状（**与来源层不同**，别混）
//
// 同一个 `tags`，两种形状各司其职：
//   - 来源层的值（`node.values.tags`）：**字符串数组** `['dp','math']`
//     —— 因为"谁说了什么"只认内容，id/颜色会让两个来源永远合并不了（见上）；
//   - 缓存字段（`node.tags`）：`[{id, text, color}]`
//     —— id 给标签管理器的增删移用，color 是节点自己的展示信息。
//
// 于是**把值写进缓存字段时**必须转一次形状。漏了这一步就会这样：
// 导入把字符串数组直接写进 `node.tags`，树上看得到（读来源层投影）、
// 标签管理器却是空白行、删除/上移一律报"标签不存在"。
// 规则放这张表里，与 `normalizeFieldValue`（来源层形状）成对。
// ----------------------------------------------------------------

/** 稳定短哈希：同一段文字 → 同一个 id（避免每次加载都换一批新 id） */
function shortHash(text) {
    let h = 5381;
    for (let i = 0; i < text.length; i++) {
        h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
    }
    return h.toString(36);
}

/**
 * 把标签列表规范成**缓存字段的形状**：`[{id, text, color}]`。
 * 已经是对象的保留其 id/color（只补缺的），字符串的补一个稳定 id。
 */
export function normalizeTagList(value) {
    if (value === undefined || value === null) return [];
    const list = Array.isArray(value) ? value : [value];
    const seen = new Set();
    const out = [];
    for (const item of list) {
        const text = String(itemText(item) === undefined ? '' : itemText(item)).trim();
        if (!text || seen.has(text)) continue;      // 去空、去重（保序，与来源层规则一致）
        seen.add(text);
        const isObj = item && typeof item === 'object';
        out.push({
            id: (isObj && item.id) ? item.id : `t_${shortHash(text)}`,
            text,
            color: (isObj && item.color) ? item.color : DEFAULT_TAG_COLOR
        });
    }
    return out;
}

/**
 * 把一个字段的值转成**缓存字段的形状**。
 * 目前只有标签列表需要转（其它元素的两种形状一致）；新元素若两种形状不同，在这里加一条。
 */
export function toCacheShape(field, value) {
    return natureOf(field) === ELEMENT_NATURE.TAG_LIST ? normalizeTagList(value) : value;
}

/** 缓存里的标签列表是不是已经是规范形状（免得每次加载都无谓地重建数组） */
export function isCanonicalTagList(value) {
    if (!Array.isArray(value)) return false;
    for (const item of value) {
        if (!item || typeof item !== 'object') return false;
        if (typeof item.text !== 'string' || !item.id || !item.color) return false;
    }
    return true;
}

/**
 * 这个值算不算"空"（空值不记来源、不参与投影）。
 * ⚠️ 与 `core/trust.js` 的标量规则一致：`'-'` **不算空**（它是"没有评测结果"的合法值）。
 */
export function isEmptyFieldValue(field, value) {
    if (shapeOf(field) !== 'list') {
        const s = value === undefined || value === null ? '' : String(value).trim();
        return s === '';
    }
    return !Array.isArray(value) || value.length === 0;
}

/** 比较/去重用的键（同键 = 同一个值）。列表用 JSON，标量就是它自己 */
export function fieldValueKey(field, value) {
    const norm = normalizeFieldValue(field, value);
    return shapeOf(field) === 'list' ? JSON.stringify(norm) : String(norm);
}

/** 给人看的写法：列表用 `、` 连起来 */
export function formatFieldValue(field, value) {
    const norm = normalizeFieldValue(field, value);
    return shapeOf(field) === 'list' ? norm.join('、') : String(norm);
}
