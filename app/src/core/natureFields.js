// ================================================================
// 节点的「性质」字段与**注册表**（core/natureFields.js）
//
// 口径：
//   · **不再有「大类 / 小类」两级**，换成**一个不定层的「分类」字段**：
//     值 = **有序字符串列表**，写进节点的形态是 `/` 连起来的字符串（字段/来源层是标量值）：
//       ["xcpc","icpc","ec","pre"]  ⇔  "xcpc/icpc/ec/pre"
//     例：`xcpc/icpc/ec/pre`（网络赛）、`xcpc/icpc/ec/regional`、`xcpc/ccpc/final`、
//         `cf/div2`、`atcoder/arc`、`nk/多校`、`qoj/xcpc/icpc/ec/regional`（qoj 下镜像了 xcpc）。
//     ⚠️ **平台不是分类**（"qoj/xcpc/… 那个是错的，不用套 qoj"）：
//        QOJ 上办的 XCPC 场次就归 `xcpc/…`，不写成 `qoj/xcpc/…`；`qoj` 这一支只剩 `无归类`。
//   · **`无归类`** = "判过了，这一支里没有它可归的一项"（= 「无」，含义不变）；
//     与"还没标"（空）**不是一回事** —— 空会进「性质待补」，`无归类` 不会。
//   · 与 `年份` / `地区` **正交**：三个字段互不影响，筛选各占一维。
//   · **合法性 = Trie 树**（**写死**在注册表文件里），**任何前缀都合法** ⇒ "停在哪一层"本身就是信息。
//
// ================================================================
// 注册表文件是**唯一真源**：`acm-data/nature-registry.json`
// ================================================================
//   · Python 侧（`scripts/crate.py`）直接 `json.load` 这一份；
//   · 本模块在 Node（单测/冒烟/脚本）里用 `fs` 读同一份，在浏览器里 `fetch` 同一份 ⇒
//     **没有第二份镜像**，也就不需要"跨语言同步测试"（有两份镜像时就得靠它兜着）。
//   · 因此本模块**有 I/O**（一个文件），这是有意的：注册表要能被主脚本导出/回代。
//
// ⚠️ 浏览器里 `node:fs` / `node:url` 是**加载不进来**的（"Cross origin requests are only
//    supported for protocol schemes…"就是它）⇒ 那两个模块**只能动态 import，且在 Node 分支里**；
//    顶层写 `import ... from 'node:fs'` 会让整个前端一片红。
// ⚠️ 两条路都在**模块求值期**走完（顶层 await）⇒ 下面那些 `export const`（`CLASS_TRIE` /
//    `CLASS_PATHS` …）在 Node 与浏览器里都能**同步**用，调用方不必先等一个 init。
//
// ⚠️ 改 Trie 只改那个 JSON；改完 `npm test` 会跑本模块的加载自检 + `crate.py selftest` 的同款断言。
// ================================================================

/** 注册表文件的位置（仓库根下 `acm-data/`）—— 本文件在 `src/core/`，上两级就是仓库根 */
const REGISTRY_URL = new URL('../../acm-data/nature-registry.json', import.meta.url);

/** 跑在 Node 里吗（单测/冒烟/脚本 = 是；浏览器 = 否） */
const IS_NODE = typeof process !== 'undefined' && !!(process.versions && process.versions.node);

/** 节点上那几个字段的键名（**唯一一份**：别处引用一律从这里取） */
export const NATURE_FIELD_KEYS = Object.freeze(
    ['natureClass', 'natureYear', 'natureSeason', 'natureRegion']);

/** 「分类」的字段键（界面上叫「分类」） */
export const NATURE_CLASS_KEY = 'natureClass';

/** `无归类` —— 判过了但归不进去（不是"没标"）—— 应用里显示成**灰**（特殊的"已填"） */
export const CLASS_NONE = '无归类';

/**
 * ★ `未归类` —— **脚本判不出、等人补**（"区分『无归类』和『未归类』，
 *   仅来自自动的『未归类』是**填写不完全（蓝）**，…的『无归类』是**特殊已填（灰）**"）。
 *
 * 两个值的分工（**别再混**）：
 *   · **`未归类`（蓝）** = "自动判不出来" ⇒ **不算填好**（`isCompleteClassPath` 为 false）
 *     ⇒ 照旧挂 ③ 性质待补 / 被「（分类不完全）」筛出来 ⇒ 人工重填 + 回代它就正常了；
 *   · **`无归类`（灰）** = "判过了，这一支里没有它可归的一项"（人下的结论，或确凿的"都不属于"）
 *     ⇒ **算填好**（特殊的"已填"），但判冲突时**当作没有主张**（见 `isNotApplicableValue`）。
 * ⚠️ 分类器（Python）**默认写 `无归类`**（`xcpc_common.STAGE_NONE`，灰 = 判过了的结论）；
 *    `未归类`（蓝）**只在省赛那一支的类型失配时**写（`PROVINCIAL_TYPE_NONE`，唯一一处）。
 */
export const CLASS_PENDING = '未归类';

/**
 * ★ `上游异常` —— **上游本身坏了**（抓不到那一页 / 403 …）时那一格写它（
 *   "像『获取数据失败』这种上游异常的情况，nature 可以用『上游异常』（灰）补充"）。
 *
 * 语义与 `无归类` 同一档：**灰、算填好、判冲突时当作没有主张** —— 但它表达的是"**这一格判不了**"
 * （不是"判过了、都不属于"，也不是"等人补"）。四个 nature 字段都能用它
 * （分类里它是 Trie 上的一个段；年份/赛季的取值白名单也加了它；地区是自由文本）。
 */
export const CLASS_UPSTREAM = '上游异常';

/** 分类的分隔符（节点上存的是这个字符串形态） */
export const CLASS_SEP = '/';

async function readRegistry() {
    if (IS_NODE) {
        // Node：`fs` 同步读（`node:*` 只能这样动态引，见文件头那条警告）
        const [{ readFileSync }, { fileURLToPath }] = await Promise.all([
            import('node:fs'), import('node:url')
        ]);
        return JSON.parse(readFileSync(fileURLToPath(REGISTRY_URL), 'utf8'));
    }
    // ⚠️ **必须 `cache: 'no-store'`**（实测踩到）：注册表是**唯一真源**，
    //    但它是个普通静态 `.json`，浏览器会照 HTTP 缓存策略留着旧的那份 —— 于是
    //    "换了注册表 + 新导的包"会出现：**新值（`cf/contest/div1`、`xcpc/…/official`、
    //    `…/warm-up`）在应用里被判成「停在半路，没到叶子」**（蓝色），
    //    因为应用还在用**旧 Trie** 判"到没到叶子"。文件才几 KB ⇒ 每次现取，不值当为它冒险。
    //    （"cf/contest/div1 现在被判为 half，改一下 xcpc 的 /official /warm-up 也是"。）
    const res = await fetch(REGISTRY_URL, { cache: 'no-store' });
    if (!res.ok) {
        throw new Error(`natureFields：注册表取不到（HTTP ${res.status}）—— ${REGISTRY_URL}`);
    }
    return res.json();
}

let registryCache = null;

/**
 * 注册表本体。**两边的模块求值期都已经把它读好了**（见下面的顶层 await）⇒
 * 这个函数现在只是"把已加载的还给你"，调用方不必在启动时等它（要求调用方先 await
 * 一次的话，实际上没人调 ⇒ 浏览器里直接炸）。
 */
export async function loadNatureRegistry() {
    return registryCache;
}

const REGISTRY = await readRegistry();
assertRegistry(REGISTRY);
registryCache = REGISTRY;

/** 字段定义（`natureClass` / `natureYear` / `natureRegion`） */
export const NATURE_FIELDS = Object.freeze(Object.fromEntries(
    Object.entries(REGISTRY.fields).map(([key, def]) => [key, Object.freeze({ key, ...def })])));

/**
 * 注册表版本（文件里的 `registryVersion`）。
 *
 * 用途：回代 baseline（`core/natureAssignments.js` 导出的那份）要带上它 ——
 * 脚本侧据此判断"这份人工填写是对着哪一版词表写的"（词表换了，里面的值可能已经不合法）。
 */
export const NATURE_REGISTRY_VERSION = Number(REGISTRY.registryVersion || 0);

/** 「分类」的 Trie（**写死**在注册表里；树的每一层都是"可停"的位置） */
export const CLASS_TRIE = Object.freeze(REGISTRY.classTrie);

/** Trie 的根（= 分类的第一段，例如 `xcpc` / `cf` / `atcoder` / `qoj` / `nk` / `hdu` / `pta`） */
export const CLASS_ROOTS = Object.freeze(Object.keys(CLASS_TRIE));

/** 年份格式（只校验格式，绝不穷举） */
export const NATURE_YEAR_PATTERN = NATURE_FIELDS.natureYear.pattern;

/** 赛季格式（与年份同一套格式：`20xx`） */
export const NATURE_SEASON_PATTERN = NATURE_FIELDS.natureSeason.pattern;

/** 地区：自由文本（脚本填「无」表示线上赛没有场地、"不需要"表示这一维对这类比赛不值得记；写法不穷举） */
export const NATURE_REGION_PATTERN = null;

/** 地区 = **没有场地**（网络赛 / 线上轮：这类比赛本来就没有举办地） */
export const NATURE_REGION_NONE = '无';

/**
 * 地区 = **不需要**（"加个『不需要』的字段"）。
 *
 * 与 `无` / `待填写` 的区别（三个别混）：
 *   · `无` = 这场**没有场地**（网络赛/线上轮 —— "不适用"）；
 *   · `待填写` = **这一维暂时由人不定期地填**（UC、EC-Final、CCPC Final、女生/高职专场）——
 *     但**算填过了**（"在判定层面被视为已填写"），想填时按值筛出来填；
 *   · `不需要` = 这一维对这类比赛**不值得记**（本身是英文写法的国外地名）。
 * 三者都算"处理过了"（不会挂在 ③ 等人补），差别只在语义与将来怎么用。
 */
export const NATURE_REGION_NOT_NEEDED = '不需要';

/** 地区 = **待填写**（UC / 总决赛 / 女生·高职专场） */
export const NATURE_REGION_TBD = '待填写';

/**
 * 地区 = **不知道**（手填出来的第四个值，比如"中国多省赛"那种一场跑好几个省、
 * 没有单一举办地的）。
 *
 * ⚠️ 这个值**不是管线产出的**（脚本永远不写它）—— 它只是手填时候选里的一个词，
 * 语义与年份/赛季那套的 `不确定` 同族："我处理过了，但答案我也没有"。
 */
export const NATURE_REGION_UNKNOWN = '不知道';

/**
 * **占位取值**：值确实存在，只是还没定下来 —— 年份与赛季**都能写**（
 * "年份/赛季提供『待同步』『不确定』选项，以后有用"）。
 *
 *   · `待同步` = 值在别处（比如另一棵树 / 另一个来源）还没同步过来；
 *   · `不确定` = 看过了但拿不准。
 *
 * ⚠️ 它们**算填过了**（不会挂在 ③ 性质待补里）—— 这正是这两个值的用处：
 *    "这一维我处理过了，只是答案还没到手"，别再拿它当空缺来烦人。
 * ⚠️ 但它们**绝不能被推荐**（推荐 = "我有证据说是 20xx"）：见 `core/natureSuggest.js`
 *    里的 `isRealYear` 那道闸。
 */
export const NATURE_PENDING_VALUES = Object.freeze(['待同步', '不确定']);

/**
 * 赛季的「不适用」值：**没有赛季概念**的那些比赛才写（CF 的正式轮次、AtCoder 的 ABC/ARC/AGC…）。
 *
 * ⚠️ **`cf gym` 不写它**（"我说 cf 无赛季，但通常单说 cf 有仅 cf contest
 *    的含义" —— gym 不是 cf contest）⇒ gym 的赛季 = 举办年份，见 `cf_board_adapter.cf_nature`。
 */
export const NATURE_SEASON_NONE = '无';

/**
 * 年份的「不适用」值（"ucup 的年份也填无吧"）。
 *
 * 目前只有 **`qoj/ucup`** 用它：Universal Cup 既没有赛季概念、QOJ 那边也基本没记时间
 * （70 场里只有 4 场有 `startAt`）—— 与其让它们空着挂在 ③ 等人补一个拿不到的值，不如标成"不适用"。
 * ⚠️ 与 `待同步` 的区别：`无` = 这一维**不适用**；`待同步` = 值存在但还没同步过来。
 */
export const NATURE_YEAR_NONE = '无';

/**
 * ★ **"确定不用"白名单**（"应该引入：1.『确定 nature 的该项不用的字段白名单』
 *   （如 地点-`不需要`、年份-`待同步` 等）…现在 nature 都是无色/蓝/绿，**确定不用是一种特殊的已填，
 *   颜色为灰**；判定冲突时，**自动忽略灰色项**（与"自动忽略 C 即以下"并行），
 *   这样就不用动手改优先级了"）。
 *
 * 语义（三档，别再混）：
 *   · **空** = 还没判（无色）—— 挂 ③ 等人补；
 *   · **确定不用（灰）** = 这一维**对这场比赛不适用**，或"值在别处/暂时由人填" —— **算填过了**
 *     （不挂 ③），但**判冲突时当作没主张**（所以 xcpcio 说 2021、QOJ 写 `待同步` 不再互相打架）；
 *   · **真值**（蓝=没到叶子 / 绿=填好）= 有内容的主张，参与冲突判定。
 * ⚠️ **分类这一维没有"不用"**：`无归类` 是"判过了、但归不进去"——那是**结论**，不是"不适用"
 *   （所以它在判冲突时照旧算一个值）。
 */
export const NATURE_NOT_APPLICABLE = Object.freeze({
    natureClass: Object.freeze([]),
    // 无（不适用）/ 待同步 / 不确定 / **上游异常** —— 典型例子就是"年份-`待同步`"
    natureYear: Object.freeze([NATURE_YEAR_NONE, ...NATURE_PENDING_VALUES, CLASS_UPSTREAM]),
    natureSeason: Object.freeze([NATURE_SEASON_NONE, ...NATURE_PENDING_VALUES, CLASS_UPSTREAM]),
    // 无（网络赛没场地）/ 不需要（国外地名）/ 待填写（暂时由人填）/ 不知道 / **上游异常**
    natureRegion: Object.freeze([NATURE_REGION_NONE, NATURE_REGION_NOT_NEEDED,
        NATURE_REGION_TBD, NATURE_REGION_UNKNOWN, CLASS_UPSTREAM])
});

/** 这一格是不是"确定不用"（灰）？ */
export function isNotApplicableValue(field, value) {
    const v = String(value === undefined || value === null ? '' : value).trim();
    // ★ 分类这一维**没有**白名单词，但**以 `无归类` 结尾**就是"确定不用"（灰）——
    //   它是"判过了、这一支里没有它可归的一项"（人下的结论/确凿的都不属于），
    //   所以判冲突时**当作没有主张**（"判定冲突时自动忽略灰色项"）。
    //   ⚠️ `未归类`（自动判不出、蓝、等人补）**不算**灰 —— 它是要人去填的欠账，不是结论。
    if (String(field || '') === 'natureClass') {
        return v.endsWith(CLASS_NONE) || v.endsWith(CLASS_UPSTREAM);
    }
    const list = NATURE_NOT_APPLICABLE[String(field || '')];
    if (!list || !list.length) return false;
    return list.includes(v);
}

/**
 * 拆一个分类值 → 段数组。
 *
 * 接受三种写法：`"xcpc/icpc/ec"`（节点上的形态）、`["xcpc","icpc","ec"]`（列表形态）、
 * `""` / null / undefined（→ `[]`）。**只做 trim 与切分，不做任何别名替换**。
 */
export function classPathOf(value) {
    if (Array.isArray(value)) return value.map(x => String(x == null ? '' : x).trim()).filter(Boolean);
    const s = String(value == null ? '' : value).trim();
    if (!s) return [];
    return s.split(CLASS_SEP).map(x => x.trim()).filter(Boolean);
}

/** 段数组 → 节点上存的字符串形态 */
export function classValueOf(path) {
    return classPathOf(path).join(CLASS_SEP);
}

/** 前缀的孩子（没有 → 空数组）。`prefix` 空 ⇒ 根列表。 */
export function classChildren(prefix) {
    const segs = classPathOf(prefix);
    let node = CLASS_TRIE;
    for (const seg of segs) {
        if (!node || !Object.prototype.hasOwnProperty.call(node, seg)) return [];
        node = node[seg];
    }
    return node ? Object.keys(node) : [];
}

/** 合法的分类路径（**展平成"所有前缀"**，供下拉直接用；顺序 = Trie 的书写顺序） */
export const CLASS_PATHS = Object.freeze(flattenTrie(CLASS_TRIE));

function flattenTrie(trie, prefix = [], out = []) {
    for (const [seg, kids] of Object.entries(trie)) {
        const path = [...prefix, seg];
        out.push(Object.freeze({
            value: path.join(CLASS_SEP),
            segments: Object.freeze(path),
            depth: path.length,
            label: path.join(` ${CLASS_SEP} `)
        }));
        flattenTrie(kids || {}, path, out);
    }
    return out;
}

/**
 * 分类值合不合法？
 *
 * 口径：**每一段都必须落在 Trie 的对应层上**（"任何前缀都合法"是自然的 ——
 * 只要逐段都在 Trie 里，停在第一段、第二段…都是合法值）。空值 = 没标 ⇒ 合法（可空字段）。
 *
 * @returns {string} 合法 → `''`；否则一句人话（界面/报错直接用）
 */
export function classPathProblem(value) {
    const segs = classPathOf(value);
    if (!segs.length) return '';                       // 可空：没标不是错
    let node = CLASS_TRIE;
    const walked = [];
    for (const seg of segs) {
        if (!node || !Object.prototype.hasOwnProperty.call(node, seg)) {
            const kids = node ? Object.keys(node) : [];
            return `分类「${walked.join(CLASS_SEP) || '（根）'}」下没有「${seg}」`
                + (kids.length ? `（可选：${kids.join('、')}）` : '（它已经没有下一层了）');
        }
        walked.push(seg);
        node = node[seg];
    }
    return '';
}

/** 这个值在 Trie 里吗（空值 → `false`；"没标"不是"登记过的值"） */
export function isKnownClassPath(value) {
    const segs = classPathOf(value);
    return segs.length > 0 && classPathProblem(value) === '';
}

/**
 * 「分类填好了吗」—— **只有落在 Trie 的叶子节点上才算填好**。
 *
 * 为什么（与"任何前缀都合法"并不矛盾）：**合法性**讲的是一条值能不能存
 * （`xcpc/icpc` 是合法值，"停在哪一层"本身是信息）；**填好没有**讲的是这一维还欠不欠活。
 * 归类这件事的终点是"这场到底是哪一档"，停在 `cf`/`xcpc/icpc` 意味着**还没细到能定**，
 * 所以它该继续挂在 ③ 性质待补里等人/脚本补，而不是被当成"已填满"藏起来。
 *
 * 判据 = 这一串段在 Trie 里走得通，**且最后一段没有孩子**（`无归类` 这类叶子也算填好）。
 * 不在 Trie 里的值（如 `cf/无归类`）**不算填好** ⇒ 会回到 ③，正好让人看见、清掉。
 *
 * ⚠️ **`未归类` 例外**（"区分『无归类』和『未归类』，仅来自自动的『未归类』
 *   是**填写不完全（蓝）**"）：`…/未归类` 虽然也是 Trie 叶子，但它的意思是"**脚本判不出、等人补**"
 *   ⇒ **不算填好**（显示成蓝、照旧挂 ③）。
 */
export function isCompleteClassPath(value) {
    const segs = classPathOf(value);
    if (!segs.length) return false;
    if (segs[segs.length - 1] === CLASS_PENDING) return false;      // ★ 未归类 = 填写不完全
    let node = CLASS_TRIE;
    for (const seg of segs) {
        if (!node || !Object.prototype.hasOwnProperty.call(node, seg)) return false;
        node = node[seg];
    }
    return !!node && Object.keys(node).length === 0;
}

/** 前缀匹配（筛选用）：`value` 等于 `prefix` 或落在它下面 */
export function classMatches(value, prefix) {
    const v = classPathOf(value);
    const p = classPathOf(prefix);
    if (!p.length) return true;
    if (v.length < p.length) return false;
    return p.every((seg, i) => v[i] === seg);
}

/** 分类值的第一段（= 「大类」，界面上的"一族"）；空值 → `''` */
export function classRootOf(value) {
    const segs = classPathOf(value);
    return segs.length ? segs[0] : '';
}

/** 分类值的**显示**（原样，只是把分隔符换成更好看的 ` / `；空值 → `''`） */
export function classLabel(value) {
    return classPathOf(value).join(' / ');
}

// ----------------------------------------------------------------
// 字段级 API（三个字段，一个 Trie）
// ----------------------------------------------------------------

/** 这个键名是 nature 的字段之一吗？ */
export function isNatureField(key) {
    return NATURE_FIELD_KEYS.includes(String(key || ''));
}

/** 取一个 nature 字段的定义（不是 nature 字段 → `null`） */
export function natureFieldOf(key) {
    return NATURE_FIELDS[String(key || '')] || null;
}

/** 全部 nature 字段的定义（按 `NATURE_FIELD_KEYS` 顺序） */
export function natureFields() {
    return NATURE_FIELD_KEYS.map(k => NATURE_FIELDS[k]);
}

/** 这个字段有没有"受控取值集合"？分类 = Trie（有），年份/地区 = 没有 */
export function hasNatureVocabulary(key) {
    const f = natureFieldOf(key);
    return !!(f && f.kind === 'classPath');
}

/** 受控取值的原始列表（只有「分类」有：所有合法路径；其余 → `[]`） */
export function natureValuesOf(key) {
    return hasNatureVocabulary(key) ? CLASS_PATHS.map(p => p.value) : [];
}

/** 规范化一个 nature 值：分类 → `a/b` 形态；其余 → trim 后的字符串（空就是没标） */
export function normalizeNatureValue(key, value) {
    if (String(key || '') === NATURE_CLASS_KEY) return classValueOf(value);
    return value === undefined || value === null ? '' : String(value).trim();
}

/**
 * 年份格式对不对（注册表里的 `^(20\d{2}|待同步|不确定)$`；空 → `false`）。
 *
 * ⚠️ 这个函数回答的是"**能不能存**"，**不是**"能不能拿去当年份用" —— 排序、推荐这类
 *    真的要一个年份的地方一律用 `isRealYear`（`待同步` 过不了它）。
 */
export function isNatureYear(value) {
    const s = normalizeNatureValue('natureYear', value);
    if (!s) return false;
    return new RegExp(NATURE_YEAR_PATTERN).test(s);
}

/** 赛季格式对不对（注册表里的 `^(20\d{2}|无|待同步|不确定)$`；与 `isNatureYear` 同一口径） */
export function isNatureSeason(value) {
    const s = normalizeNatureValue('natureSeason', value);
    if (!s) return false;
    return new RegExp(NATURE_SEASON_PATTERN).test(s);
}

/**
 * 是不是**真的年份**（`20\d{2}`）—— 把 `无` / `待同步` / `不确定` 这些"没给出年份"的值挡在外面。
 *
 * 唯一用处是**排序与推荐**（"按年份排"、"从赛季反推举办年"）：拿 `待同步` 去 `Number()` 会得到
 * `NaN`、拿去当年份推会推出一个假的年份。合法性判断仍然走 `isNatureYear` / `isNatureSeason`。
 */
export function isRealYear(value) {
    return /^20\d{2}$/.test(normalizeNatureValue('natureYear', value));
}

/**
 * 一个字段在输入框里该给出的**候选提示**（原生 `<datalist>` 用；不是取值表）。
 *
 * 分类的候选是 Trie（走 `CLASS_PATHS`，界面是下拉）；年份/赛季**没有表**，只提示那几个
 * "不是年份但合法"的值 —— 敲字仍然自由（人可能真知道一个注册表没写的写法，写路径会挡）。
 */
export function natureInputSuggestions(key) {
    const k = String(key || '');
    if (k === 'natureYear') return [NATURE_YEAR_NONE, ...NATURE_PENDING_VALUES];
    if (k === 'natureSeason') return [NATURE_SEASON_NONE, ...NATURE_PENDING_VALUES];
    // 地区：四个"不是地名但合法"的值 ——
    //   `无` = 没有场地（网络赛/线上轮）；`待填写` = 这一维暂时由人填（UC / 总决赛 /
    //   女生·高职专场，但**算填过了**）；`不需要` = 这一维对这类比赛不值得记（国外英文地名）；
    //   `不知道` = **人工填的**（管线永远不写），比如"一场跑好几个省、没有单一举办地"那种。
    // 手填时这几个在候选里点一下就有（敲字仍旧自由）。
    // ⚠️ **从"确定不用"那张表里取**（唯一真源），只去掉 `上游异常` —— 那是**上游状态**，
    //    不该出现在"给人挑"的候选里。
    if (k === 'natureRegion') {
        return NATURE_NOT_APPLICABLE.natureRegion.filter((v) => v !== CLASS_UPSTREAM);
    }
    return [];
}

/** 这个值是**登记过的**取值吗（只有分类有登记表；年份/地区永远 `false`） */
export function isKnownNatureValue(key, value) {
    if (String(key || '') !== NATURE_CLASS_KEY) return false;
    return isKnownClassPath(value);
}

/** 从数据里收集已出现过的取值（判重页筛选用；分类给的是**原样的路径**） */
export function collectNatureValues(nodes, key) {
    const out = [];
    const seen = new Set();
    for (const node of (Array.isArray(nodes) ? nodes : [])) {
        const v = normalizeNatureValue(key, node && node[key]);
        if (!v || seen.has(v)) continue;
        seen.add(v);
        out.push(v);
    }
    return out;
}

/** 分类 → 显示文案（`a / b`）；其它字段原样 */
export function natureLabel(key, value, fallback) {
    const k = String(key || '');
    if (k === NATURE_CLASS_KEY) {
        const s = classLabel(value);
        return s || (fallback === undefined ? '' : fallback);
    }
    const s = normalizeNatureValue(k, value);
    return s || (fallback === undefined ? '' : fallback);
}

/**
 * 一个节点的 nature 组合（筛范围 / 分组用）。
 *
 * `matches(other)` 只比较**两边都非空**的那些维度；分类按**前缀**算匹配
 * （`xcpc/icpc` 与 `xcpc/icpc/ec` 是"同一性质的两个深度"，不该互相否决）。
 */
export function natureComboOf(node) {
    const combo = {};
    for (const key of NATURE_FIELD_KEYS) combo[key] = normalizeNatureValue(key, node && node[key]);
    combo.matches = function matches(other) {
        for (const key of NATURE_FIELD_KEYS) {
            const a = combo[key];
            const b = normalizeNatureValue(key, other && other[key]);
            if (!a || !b) continue;
            if (key === NATURE_CLASS_KEY) {
                if (!classMatches(a, b) && !classMatches(b, a)) return false;
                continue;
            }
            if (a !== b) return false;
        }
        return true;
    };
    return combo;
}

// ----------------------------------------------------------------
// 注册表加载自检（模块加载即执行；与 crate.py selftest 里的同款断言）
// ----------------------------------------------------------------
function assertRegistry(reg) {
    const keys = Object.keys(reg.fields || {});
    if (keys.join(',') !== NATURE_FIELD_KEYS.join(',')) {
        throw new Error(`natureFields：注册表字段 ${keys.join(',')} ≠ ${NATURE_FIELD_KEYS.join(',')}`);
    }
    for (const [k, def] of Object.entries(reg.fields)) {
        if (!def.label) throw new Error(`natureFields：字段 ${k} 没有界面文案`);
    }
    const trie = reg.classTrie;
    if (!trie || typeof trie !== 'object' || !Object.keys(trie).length) {
        throw new Error('natureFields：注册表里没有 classTrie（分类的 Trie 是必需品）');
    }
    // ① 每一层的 key 都非空、且**不许含分隔符**（含了就切不开）
    // ② 同层不许重复（JSON 对象天然去重，这个断言只是把口径写下来）
    const walk = (node, at) => {
        for (const [seg, kids] of Object.entries(node || {})) {
            if (!String(seg).trim()) throw new Error(`natureFields：${at} 下有空段`);
            if (String(seg).includes(CLASS_SEP)) {
                throw new Error(`natureFields：段 ${JSON.stringify(seg)} 里含分隔符 ${CLASS_SEP}（切不开）`);
            }
            walk(kids, `${at}/${seg}`);
        }
    };
    walk(trie, '（根）');
}
