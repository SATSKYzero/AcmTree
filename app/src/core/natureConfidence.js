// ================================================================
// 「依据强度」（core/natureConfidence.js）
//
// 自动分类/填值规则高度依赖社区命名规范 —— 要做得精，就得引入**「可信度级别」**概念；
// 而「按推荐填」让用户选择接受 A/B/C/D/E 级及以上的推荐。
//
// ⚠️ **级别 = "这个值凭什么"，不是"它有多大概率对"**。写成"正确率"就会变成
//    需要人去校准的数字；写成"依据强度"只依赖**规则本身**，永远自洽、可复算。
//
// 六档（**M 最硬 → E 最弱**，与 `CONFIDENCE_LEVELS` 的顺序一致）：
//
//   M 人工      —— **人定的**：你手改过、或点头确认过的值（**手改的 nature 标为 `M`**）。
//                  它比任何规则都硬 —— 规则是"推测凭什么"，
//                  而这一个**是人看过之后下的结论**。⚠️ 它**不是**"规则级别"：
//                  「按推荐填」的门槛、以及"依据弱要复核"的筛选都只看 A…E（`RULE_LEVELS`）。
//   A 权威枚举  —— 别人给的分类表 / 官方数据：CF `filterTypes`、AtCoder 赛制 id、
//                  多校系列表、**QOJ 自己的分类路径**、节点的**官方开赛时间**
//   B 结构      —— 我们自己维护的结构：清单 `series`/`mid`、注册表 Trie、
//                  爬虫生成的标识（slug 里的年份）、**同一届的另一个来源填过的值**
//   C 明确字面词 —— 赛名里明写着的东西：`Regional` / `Final` / `EC-Final` / `网络赛` /
//                  `省` / `provincial` / `Invitational`、节点名里的年份
//   D 推断      —— 靠词表/城市推：城市→赛区、省份词→EC、「标题是 UC」、用赛季反推举办年
//   E 无依据    —— 什么都没命中（`无归类` / 停在浅处 / 留空）
//
// ⚠️ 三条纪律（写在前面，免得以后走偏）：
//   ① **级别绝不用于回删数据**：现在全库 898/1426 条分类的末层是"名字"得来的（C/D 级），
//      一按级别"清理低级别"就等于一夜清空 —— 级别只用来**排序、筛选、决定要不要自动写**。
//   ② **拿不准就不写**（既有口径）：低级别不等于"要写进去"，E 级根本不出推荐。
//   ③ **M 是"人的结论"，不参与"依据弱"的筛选**（`levelRank('M')` 最小 ⇒ 任何
//      「≤ X」（X 是 A…E）都不收它）；要看它们，筛选里有专门的「只看人工」那一档。
// ================================================================
// ⚠️ 只 import 两个**叶子模块**（`natureFields` 无 import；`synthPlan` 只 import `natureFields`）
//    —— 本文件被 `scripts/synth-bind.mjs` 直接 import（node 里跑），别引入会成环的东西。
import { isRealYear } from './natureFields.js';
import { MANUAL_OWNER_RULE, realPlace } from './synthPlan.js';

/**
 * 全部级别，**顺序即强度**（`M` 最硬）。
 *
 * ⚠️ 界面上做"规则门槛/依据弱筛选"的地方要用 `RULE_LEVELS`（A…E）—— 见本文件 ③ 的说明。
 */
export const CONFIDENCE_LEVELS = Object.freeze(['M', 'A', 'B', 'C', 'D', 'E']);

/**
 * **规则**级别（A…E）—— "按推荐填的门槛"与"只看依据弱的"都只在这五档里选。
 *
 * 为什么把 M 排除在外：M 不是规则，是人的结论。
 *   · 「接受 X 级及以上的推荐」里出现 M 没有意义（推荐永远是规则给的）；
 *   · 「只看依据弱的（≤ X）」里出现 M 更糟 —— 人填的值恰恰**最可信**，不该被当成"该复核的"。
 */
export const RULE_LEVELS = Object.freeze(['A', 'B', 'C', 'D', 'E']);

/** 「人工」这一档的级别字母 */
export const MANUAL_LEVEL = 'M';

/**
 * 元列 `分类依据` 里代表"人定的"那个规则 id（不是爬虫发的规则）。
 *
 * 用途：`core/ops/node.js` 在**人改过**某个 nature 字段时写上它，
 * 界面据此画 `M` 徽标；`scripts/nature-baseline.py` 靠它在包里认出"这条是人的结论"。
 *
 * ⚠️ **字面量只有一份**：`synthPlan.js` 的 `MANUAL_OWNER_RULE`（那边是"数据格式"的声明处，
 * 与 `ownerSynth`/`synthKey` 这些字段名同类），这里只**转发** —— 两处各写一个 `'manual:set'`
 * 迟早会跑偏，而"人确认过"这条判据一偏就是"点完不消失 / 人的结论被脚本盖掉"。
 */
export const MANUAL_RULE = MANUAL_OWNER_RULE;

/** 每档一句人话（界面上 `title`/图例直接用） */
export const CONFIDENCE_LABELS = Object.freeze({
    M: 'M 人工（你手改 / 确认过的值 —— 比任何规则都硬）',
    A: 'A 权威（官方分类表 / 官方开赛时间）',
    B: 'B 结构（清单与注册表 / 标识 slug / 同一届的另一个来源）',
    C: 'C 明确字面词（赛名里的区域赛、总决赛、省份…）',
    D: 'D 推断（城市→赛区、省份词→EC、赛季反推…）',
    E: 'E 无依据'
});

/** 归一化一个级别（不认识 → `'E'`） */
export function normalizeLevel(level) {
    const s = String(level === undefined || level === null ? '' : level).trim().toUpperCase();
    return CONFIDENCE_LEVELS.includes(s) ? s : 'E';
}

/**
 * 强度序：**越小越硬**（`M`=0、`A`=1 … `E`=5）。给排序用。
 * 不认识的级别排最后（比 E 还靠后），不会被误当成"硬"。
 */
export function levelRank(level) {
    const i = CONFIDENCE_LEVELS.indexOf(String(level || '').trim().toUpperCase());
    return i < 0 ? CONFIDENCE_LEVELS.length : i;
}

/** 「接受 `min` 级及以上」时，`level` 够不够？（A 最硬 ⇒ 门槛 A 只收 A） */
export function meetsMinLevel(level, min) {
    return levelRank(level) <= levelRank(min);
}

/** 级别 → 显示文案（`A` → `A 权威（…）`；不认识给原样） */
export function levelLabel(level) {
    const s = String(level || '').trim().toUpperCase();
    return CONFIDENCE_LABELS[s] || (s || '（未知）');
}

// ----------------------------------------------------------------
// 一、**推荐**的级别（`core/natureSuggest.js` 的 `SUGGEST_FROM`）
//
// 与那边的强度序（`suggestRank`）**同一份事实的两种说法**，所以放在这里、由测试钉住两边一致。
// ----------------------------------------------------------------
export const SUGGEST_LEVEL = Object.freeze({
    time: 'A',        // 本节点开赛时间 —— 官方数据
    sibling: 'B',     // 同一届的另一个来源填过的 —— 真凭据，但来自别的节点
    key: 'B',         // 标识（`xcpc:c:zjcpc-2026`）—— 爬虫从来源系统生成的 slug
    container: 'C',   // 父容器名里的年份 —— 容器是我们自己分的组
    name: 'C',        // 节点名里的年份 —— 明确，但未必是赛季年（要人核）
    season: 'D'       // 从赛季反推 —— 最弱（跨年赛事会差一年）
});

/** 推荐的出处 → 级别（不认识 → `'E'`，即"没有依据"） */
export function levelOfSuggestFrom(from) {
    return SUGGEST_LEVEL[String(from || '')] || 'E';
}

// ----------------------------------------------------------------
// 二、**分类**的级别（管线侧把"哪条规则命中"写进 `分类依据` 那一列之后才用得上）
//
// 规则 id 的写法约定：`<范围>:<规则>`，例如
//   `cf-contest:filterTypes`（A，CF 官方表）、`qoj:path-icpc`（A，QOJ 分类路径）、
//   `qoj:ucup-title`（C，标题写着 Universal Cup）、`xcpc:name-provincial`（C，赛名里的省/邀词）、
//   `gym:infer-region`（D，靠城市/省份词推赛区）
// ⚠️ **适配器已经在写这一列了**（`scripts/crate.py` 的 `class_rules()`，
//    每个适配器给每条判据发一个稳定 id；`crate-merge` 把它搬下来）。所以：
//      · 有那一列 ⇒ `classLevelOf()` 给级别，界面画**依据强度徽标**、③ 能按「依据 ≤ X」筛；
//      · 没有那一列（老数据 / 人填的分类）⇒ 返回 `''`（未知）：**不画徽标**，
//        也**不进任何一档**筛选 —— 那不是"依据弱"，是"没有依据这回事"。
//    规则 id ↔ 级别的表在下面，**唯一真源**；Python 侧只写 id、不写级别
//    （级别是"读法"，改分级不用重跑数据）。
// ----------------------------------------------------------------
export const CLASS_RULE_LEVEL = Object.freeze({
    // ★ M 人工（**不是爬虫发的规则** —— 由 `core/ops/node.js` 在人改时写上）
    'manual:set': 'M',
    // A 权威枚举
    'cf-contest:filterTypes': 'A',
    'atcoder:series': 'A',
    'nk:series': 'A',
    'hdu:series': 'A',
    'qoj:path-icpc': 'A',
    'qoj:path-ccpc': 'A',
    // B 结构
    'xcpc:series': 'B',
    'qoj:no-category': 'B',      // QOJ 上真的没挂分类（我提交过的补题场）⇒ 只能落到兜底 S
    // C 明确字面词
    'xcpc:name-stage': 'C',
    'xcpc:name-provincial': 'C',
    'ccpc:name-stage': 'C',
    'qoj:name-provincial': 'C',
    'qoj:ucup-title': 'C',
    'gym:name-stage': 'C',
    'gym:name-provincial': 'C',
    // D 推断
    'gym:infer-region': 'D',
    'gym:name-ucup': 'D',
    // ---- 「地区」（`natureRegion`）那几条（**与分类那几条分开**）----
    // 口径："统一成中文城市/省名"、网络赛与 UC 写 `无`、读不出留空。
    //   · `*:region-city` / `*:region-province`（C 明确字面词）—— 赛名里写着的城市/省名；
    //   · `*:region-none`（B 结构）—— 分类末段是 `pre`（网络赛）⇒ 没有场地；
    //   · `*:region-tbd`（B）—— **总决赛 / 女生专场 / 高职专场** ⇒ 先写 `待填写`
    //     （"都用脚本填『待填写』，但**在判定层面被视为已填写**"）；
    //   · `*:region-foreign`（B）—— 读到的是**本身英文写法的国外地名** ⇒ 写 `不需要`（不翻译）；
    //   · `qoj:region-ucup`（B）—— UC 系列（含拿不到变体名的镜像）⇒ `待填写`；
    //   · `qoj:path-*`（B）—— 地名来自 **QOJ 自己的分类路径**（不是赛名里的词，所以不是 C）。
    'xcpc:region-city': 'C',
    'xcpc:region-province': 'C',
    'xcpc:region-none': 'B',
    'xcpc:region-tbd': 'B',
    'xcpc:region-foreign': 'B',
    'gym:region-city': 'C',
    'gym:region-province': 'C',
    'gym:region-none': 'B',
    'gym:region-tbd': 'B',
    'gym:region-foreign': 'B',
    'qoj:region-city': 'C',
    'qoj:region-province': 'C',
    'qoj:region-none': 'B',
    'qoj:region-tbd': 'B',
    'qoj:region-foreign': 'B',
    'qoj:region-ucup': 'B',
    'qoj:path-city': 'B',
    'qoj:path-province': 'B',
    // ★ **"日期/年份按来源分档"**（"对于 xcpc，xcpcio/pta/nk 的可信度
    //   最高(A)，srk 你判断，rankland 次之(C)，cf gym/qoj 如果有、可信度差强人意(D)；对于
    //   cf contest/atc，当然是 A"）—— 所以**日期这一维**不再只看"是不是从开赛时间来的"，
    //   而是看**谁给的**（规则 id 的前缀就是来源，见 `xcpc_common.RULE_CHANNELS`）：
    //     · A：`xcpcio` / `pta` / `nk`（xcpc 侧最高档）+ `cf-contest` / `atcoder`（各自官方时间）；
    //     · C：`rankland`（次档）+ **`srk`**（我按"它就是 rankland 的榜单文件"判的 ——
    //          `srk_adapter.py` 的文件头写着"rankland（srk）榜单"，同一份数据的另一种形状）；
    //     · D：`gym`（CF gym 的日期/赛名年份"差强人意"）+ `qoj`（有日期也是镜像/重跑时间）。
    //   ⚠️ 赛季那一维**不动**（"赛季问题不大"）：仍是 `season-key` = B / `season-path` = A…
    'xcpcio:year-time': 'A', 'pta:year-time': 'A', 'nk:year-time': 'A',
    'rankland:year-time': 'C', 'srk:year-time': 'C',
    'gym:year-time': 'D', 'gym:year-name': 'D', 'qoj:year-time': 'D',
    'cf-contest:year-time': 'A', 'atcoder:year-time': 'A',
    // E 无依据
    'xcpc:shallow': 'E',
    'xcpc:unclassified': 'E',
    'qoj:shallow': 'E',
    'qoj:unclassified': 'E',
    'gym:shallow': 'E',
    'gym:unclassified': 'E'
});

/**
 * **性质"值"那几条规则的级别**（年份/赛季那几条也在这里定级）。
 *
 * 为什么单列一张**按后缀**的表：这几条规则（`…:year-*` / `…:season-*` / `…:region-*`）
 * 在 **7 个范围**（`xcpc` / `qoj` / `gym` / `cf-contest` / `atcoder` / `nk` / `hdu`）里同形，
 * 逐条登记要写 40+ 行、还容易漏 —— 级别只由**后缀**决定，与范围无关。
 *
 * 口径（"将『待同步』和 qoj 年份的可信度都标为『不高』" +
 * "同赛季不同年份**只有高可信度冲突时**才报警"）：
 *   · **A** 开赛时间（`…:year-time` / `…:season-time`）—— 硬数据；
 *   · **B** 结构（清单 `mid`/层 id 的年份 `season-key`、多校"一年一届"的 `season-same`、
 *         各种"不适用"的 `*-none`）；
 *   · **C** 明确字面词（**赛名里的 20xx**：`year-name` / `season-name`）—— ⚠️ 对**年份**来说
 *         **不算高**：赛名里的年份常常是**赛季年**（EC-Final 2023 是 2024 办的）；
 *   · **D** 推断 / 占位（`year-season` = 用赛季年顶、`year-tbd` = `待同步`）—— **不高**。
 * ⇒ 「高可信」= **M / A / B**（报警门槛用这三档，见 `scripts/synth-bind.mjs`）。
 */
export const NATURE_VALUE_RULE_LEVEL = Object.freeze({
    // 年份（natureYear）
    // ⚠️ `year-season`（**用赛季年顶**）**不再产出** —— "QOJ 分类链路口名的
    //    20xx 也是按赛季划的…那**与年份完全无关**" ⇒ 判不出就**写 `待同步`**（`…:year-tbd`）。
    //    这一条留着只为老包里导入进来的节点还能显示成 D（不高），不再有新数据用它。
    // ⚠️ 具体**哪一家**给的日期，由**前缀**决定（`xcpcio:year-time` / `rankland:year-time`…）——
    //    见上面 `CLASS_RULE_LEVEL` 里那一段（查表先命中）。这里的 `year-time` 只是**兜底**：
    //    来源不明（新渠道没登记）按 **C 次档**算，绝不冒充 A。
    'year-time': 'C', 'year-season': 'D', 'year-tbd': 'D', 'year-name': 'C', 'year-none': 'B',
    // 赛季（natureSeason）
    'season-path': 'A', 'season-time': 'A', 'season-key': 'B', 'season-same': 'B',
    'season-none': 'B', 'season-name': 'C',
    // 地区（natureRegion）—— 表里那几条（按范围登记）优先，这里只是兜底
    'region-city': 'C', 'region-province': 'C', 'region-none': 'B', 'region-tbd': 'B',
    'region-foreign': 'B', 'region-ucup': 'B'
});

/**
 * 「**这个规则 id 我认不出**」—— 与 `E` 级**不是一回事**：
 *
 *   · `E` = **规则本身**说"什么都没命中"（`xcpc:shallow` / `xcpc:unclassified` 那种，
 *     它们是**登记在表里**的规则，级别就是 E）；
 *   · `''` = **这张表里没有它**（拼错了 / 新规则忘了登记）。
 *
 * ⚠️ 两者必须分得开：以前认不出也返回 `'E'`，于是"规则 id 拼错"会画出一个**看起来合理**的
 *    "E 无依据"徽标，恰好把事故本身盖住（`crate.py` 的注释把"在应用侧只会静默降级成 E 级
 *    （'无依据'），没人会去查"当成要防的事故 —— 而当时的实现就是那样）。
 *    分开之后，界面上表现为"这一格**没有依据徽标**"，跨语言那条对拍也才有牙
 *    （`crossLangTables.test.js` 的 `!levelOfClassRule(id)` 从此不再恒真）。
 */
export const UNKNOWN_RULE_LEVEL = '';

/**
 * 规则 id → 依据级别。
 *
 * ① 先查 `CLASS_RULE_LEVEL`（逐条登记，含 `manual:set`）；
 * ② 再按**后缀**查 `NATURE_VALUE_RULE_LEVEL`（年份/赛季/地区那几条，与范围无关）；
 * ③ 最后按**前缀兜底**（同一族的规则没逐个登记时）：`…:filterTypes`/`…:path-*` → A、
 *    `…:series` → B、`…:name-*`/`…:title` → C、`…:infer-*` → D。
 *    ⚠️ 兜底只为"表漏了一条也能给出合理级别"，**不替代**登记 —— 新规则请两处都加。
 * ④ **都没命中 ⇒ `UNKNOWN_RULE_LEVEL`（空串）**，不是 `'E'`（见上面那个常量的说明）。
 * ⚠️ `manual:set` **必须查表命中**（兜底会把它判成 D/E —— 那是"无依据"，与"人定的"正好相反）。
 */
export function levelOfClassRule(ruleId) {
    const id = String(ruleId || '').trim();
    if (!id) return UNKNOWN_RULE_LEVEL;
    if (CLASS_RULE_LEVEL[id]) return CLASS_RULE_LEVEL[id];
    const suffix = id.slice(id.lastIndexOf(':') + 1);
    if (NATURE_VALUE_RULE_LEVEL[suffix]) return NATURE_VALUE_RULE_LEVEL[suffix];
    if (/:filterTypes$|:path-/.test(id)) return 'A';
    if (/:series$/.test(id)) return 'B';
    if (/:name-|:title$/.test(id)) return 'C';
    if (/:infer-/.test(id)) return 'D';
    return UNKNOWN_RULE_LEVEL;
}

/** 「高可信」的三档（M 人工 / A 权威 / B 结构）—— 冲突报警只认它 */
export const HIGH_LEVELS = Object.freeze(['M', 'A', 'B']);

/** 这个级别算不算「高可信」（见 `HIGH_LEVELS`） */
export function isHighLevel(level) {
    return HIGH_LEVELS.includes(String(level || '').trim().toUpperCase());
}

/**
 * 一个节点的**分类**级别：读元信息列 `分类依据` 里的规则 id。
 *
 * @returns {string} 级别（`M` 人工 / `A`…`E`）；**没有那一列时返回 `''`**（未知 —— 界面不画徽标）
 */
export function classLevelOf(node) {
    const rule = classRuleOf(node);
    return rule ? levelOfClassRule(rule) : '';
}

// ----------------------------------------------------------------
// 三、元信息列 `分类依据`（`{ natureClass: 'xcpc:name-stage' }`）
//
// 上游权威形状在 `scripts/crate.py`（`CLASS_RULE_COL` / `class_rules()` / `_normalize_class_rules`）：
// **单值**（不是列表），键是**内部字段名**。这里只做"读出来"与两处改写：
//   · 导入落库（`features/AutoImport/apply.js`）—— 爬虫说这条分类凭什么；
//   · 手改（`core/ops/node.js`）—— 人改了就**写 `manual:set`**（徽标变 `M`）：
//     那条规则描述的已经不是现在这个值了，而"这个值凭什么"的新答案是**人**。
//     ⚠️ 值被**清空**时改成 `clearClassRule()`（没有值就没有"凭什么"）。
// ----------------------------------------------------------------

/** crate 里承载"这条分类凭什么"的元列名（与 `字段来源` 同级的保留列） */
export const CLASS_RULE_COL = '分类依据';

// ================================================================
// 合成节点的性质：**由成员派生**（唯一一份口径） —— 应用侧与 `synth-bind.mjs` 共用
// ================================================================
/**
 * 组头（`synthKey` 节点）的性质该取什么 —— **从它的成员派生**。
 *
 * 为什么必须有它：组头自己**没有独立信息**（键与名都是 `planKeyOf(它的性质)` 算出来的），
 * 而**人填的是成员**（原料）那一份。成员补了年份/赛季/地区之后，组头那几格如果没人跟，
 * 就会一直停在 `年份未知`、继续挂在「性质待补」里
 * （用户 2026-10-06："填充原料节点的信息后，合成节点的信息不更新"）。
 *
 * 口径（与 `scripts/synth-bind.mjs` 里"组头年份怎么选"**逐字同源**，现在只此一份）：
 *   ① **真值顶掉占位**（`20xx` > 空 / `待同步` / `不确定` / `无`；地区同理，占位不算真地名）；
 *   ② 都是真值 ⇒ **依据级别高的赢**（`levelRank` 小 = 硬，M > A > … > E）；
 *   ③ 级别相同 ⇒ 取**最早**（字典序小）—— 这样"成员顺序一变、组头的年份就翻"不会发生
 *      （脚本那边为这条写过：实测 A→B 得 2021、B→A 得 2022，与"逐字节可复现"冲突）。
 * 空的字段**不写**（返回值里就没有那个键 ⇒ 调用方保持原样，不把值抹掉）。
 *
 * @param {Array<Object>} members 成员节点（`ownerSynth` 指向这个组头的那几个）
 * @returns {{values: Object, rules: Object}} 取值 + 各字段的**依据规则 id**
 *          （规则从**胜出的那个成员**那一格抄过来 ⇒ 不新增规则词表，来源面板照旧能解释它）
 */
export function pickGroupNature(members) {
    const list = (Array.isArray(members) ? members : []).filter(Boolean);
    const fields = [
        ['natureClass', null],
        ['natureYear', isRealYear],
        ['natureSeason', isRealYear],
        ['natureRegion', realPlace]
    ];
    const values = {};
    const rules = {};
    for (const [field, isReal] of fields) {
        let best = null;                       // { value, rule, rank, real }
        for (const m of list) {
            const raw = m[field];
            const value = (raw === undefined || raw === null) ? '' : String(raw).trim();
            if (!value) continue;
            const rule = classRulesOf(m)[field] || '';
            const cand = {
                value, rule,
                rank: levelRank(levelOfClassRule(rule)),
                real: isReal ? !!isReal(value) : true
            };
            if (!best) { best = cand; continue; }
            if (cand.real && !best.real) { best = cand; continue; }        // 真值顶掉占位
            if (cand.real !== best.real) continue;                         // 占位不许顶真值
            if (cand.rank < best.rank) { best = cand; continue; }          // 级别高的赢
            if (cand.rank === best.rank && cand.value < best.value) best = cand;   // 同级取最早
        }
        if (best) { values[field] = best.value; rules[field] = best.rule; }
    }
    return { values, rules };
}

/** 读一条记录/节点上的 `分类依据` → `{ 字段: 规则id }`（形状不对 ⇒ `{}`） */
export function classRulesOf(record) {
    const raw = record && typeof record === 'object' ? record[CLASS_RULE_COL] : null;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out = {};
    for (const field of Object.keys(raw)) {
        const rule = String(raw[field] === undefined || raw[field] === null ? '' : raw[field]).trim();
        if (rule) out[field] = rule;
    }
    return out;
}

/** 某个字段的依据规则 id（没有 ⇒ `''`） */
export function classRuleOf(node, field = 'natureClass') {
    return classRulesOf(node)[field] || '';
}

/**
 * 这个节点的**合成归属指针是人定的**吗？（`分类依据.ownerSynth = manual:set`）
 *
 * 由"人定"那条路自己标记（`core/ops/synth.js` 的 `applyOwnerSynth`）；导入与脚本产的一律没有。
 * ⚠️ **唯一一处口径**：构建侧的 `scripts/synth-bind.mjs` 与应用侧的 ⑤ 冲突栏
 * （`core/synthConflicts.js`）都用它 —— 两边各判一套的话，界面会叫人去改一个
 * **脚本本来就不碰**的键（实测症状：界面说 N 条、构建日志说 0 条）。
 *
 * ⚠️ **别把这条判据搬到组头的性质四格上**（曾经那么做过，被实测推翻）：
 *    组头那四格的 `分类依据.<字段>` 会是 `manual:set` 有**两个来源** —— 人直接改了组头那一格，
 *    或**成员**那格是人定的、被 `pickGroupNature` **原样抄上来**（级别 M 必然胜出）。
 *    两者在数据里长得一样 ⇒ 拿它当"人改过组头"的守卫会把派生**自己锁死**
 *    （成员改一次之后组头永远停在旧值、⑤ 也不报）。组头那四格的口径是**派生量**。
 */
export function isHumanBoundOwner(node) {
    return classRuleOf(node, 'ownerSynth') === MANUAL_RULE;
}

/**
 * 把某个字段的依据**写成一条规则 id**（`core/ops/node.js` 手改时用 `MANUAL_RULE`）。
 *
 * 为什么不是"直接改节点上的键"：列的**形状只有一种**（`{ 字段: 规则id }`），
 * 空值要丢掉、空对象要把整个键删掉 —— 这套规矩只应该有一处实现（就是这里）。
 *
 * @returns {boolean} 真的变了吗（没变 ⇒ `false`，调用方据此不写脏事务）
 */
export function setClassRule(node, field, rule) {
    if (!node || typeof node !== 'object') return false;
    const id = String(rule || '').trim();
    const rules = classRulesOf(node);
    if (!id) return clearClassRule(node, field);
    if (rules[field] === id) return false;
    rules[field] = id;
    node[CLASS_RULE_COL] = rules;
    return true;
}

/**
 * 把某个字段的依据降级成"未知"（值被清空时用；见 `core/ops/node.js`）。
 *
 * @returns {boolean} 真的清掉了东西吗（没得清 ⇒ `false`，调用方据此不写脏事务）
 */
export function clearClassRule(node, field = 'natureClass') {
    if (!node || typeof node !== 'object') return false;
    const rules = classRulesOf(node);
    if (!rules[field]) return false;
    delete rules[field];
    if (Object.keys(rules).length) node[CLASS_RULE_COL] = rules;
    else delete node[CLASS_RULE_COL];
    return true;
}
