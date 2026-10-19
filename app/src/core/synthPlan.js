// ================================================================
// 合成归属的**算键规则**（core/synthPlan.js）
//
// 这份规则有两个消费者 ——
//   · 产包侧的 `scripts/synth-bind.mjs`（给成员写 `ownerSynth`、铺组节点；国内范围）；
//   · 应用侧「判重整理 → ⑤ 冲突」那一栏（**实时**算：年份冲突 / 算不出键 / 该换键）。
// ⇒ 规则**只能有一份**（警报要进 UI，但"顺序/级别那套口径"必须与应用共用，
//    不能各写一份）。方向是 `scripts/*` 依赖 `src/core/*`（与 `crate-merge.mjs` 同一做法），
//    反过来不行。
//
// 口径全文见 `docs/field-rules.md` §10（**键** = `synth:xcpc:<赛季><分类段>[-地点][-限定词]`，
// 见下面 `KEY_PREFIX` 那段；地点**读
// `natureRegion` 字段**、不从赛名猜；只做国内；算不出 ⇒ **一个字不写**，交给人）。
// ================================================================
import { NATURE_NOT_APPLICABLE } from './natureFields.js';
import { treeOfExtKey } from '../utils/extkey.js';
// 「组确认」那一格的名字（唯一定义在属性表里 —— 它得先登记成"能随包走的字段"）
import { CONFIRM_FIELD_NAME, SPLIT_FIELD_NAME } from './model/elements.js';

/**
 * 不是"真地点"的那些取值（`无` / `不需要` / `待填写` / `不知道` / `上游异常`）。
 *
 * ⚠️ **从唯一真源派生**（`natureFields.NATURE_NOT_APPLICABLE.natureRegion`），不再手抄一份：
 *    手抄那份**漏了 `上游异常`** ⇒ `realPlace('上游异常')` 把它当成**真地名**，而
 *    `isNotApplicableValue('natureRegion', '上游异常')` 说它是"灰、没有主张" —— 同一件事
 *    两处判、结论相反。后果具体有两个：`pickGroupNature` 会把这个"判不了"的值当占位/真值
 *    参与决胜并写进组头；`synthConflicts` 会报出一条**假地区冲突**要人去解。
 */
export const NON_PLACE = new Set(NATURE_NOT_APPLICABLE.natureRegion);

//: 脚本产出的键长这样（用来区分"我们管的"与"人绑的"）
export const KEY_PREFIX = 'synth:xcpc:';
//: ★ **键的格式**：**统一的场次标识** `<赛季><分类段>[-地点][-限定词]`
//: （例：`2024provincial-jilin`、
//: `2021ecfinal`、`2024ccpc-female`、`2025ec_regional-chengdu-warmup`）。
//: 口径："最好统一为『赛季 + [icpc/ccpc/省赛区域赛细分] + 地点』"，
//: "当基本需要地名才能区分不同比赛时…分类的中间那一部分**对应分类，分类是什么就填什么**"，
//: "不需要地名就能唯一定位时：`20xxecfinal`、`20xxccpcf`、`20xxccpc female`…"，
//: 末尾那个限定词用 `-` 连接（"可能 `-` 确实更好"）。
//: ⚠️ **不存**：id 是**纯函数**（分类 + 赛季 + 地点），谁用谁算（"让每个来源算，完全不存"）。
//:    匹配的原理就是各来源的 nature 高度一致 —— 一致 ⇒ 算出同一个 id ⇒ 自动成组。
//: ⚠️ `KEY_PREFIX` 之后**必须紧跟赛季**（`20xx` 或 `年份未知`）—— 这是"本格式"与
//:    "人手起的键"的**唯一区分点**（人手起的键在前缀后面都是字母或冒号）。
const SEASON_TOKEN_RE = '(?:\\d{4}|年份未知)';
const NEW_KEY_RE = new RegExp(`^${KEY_PREFIX}${SEASON_TOKEN_RE}[a-z&]`);
//: ★ P 层的键（`synth:problem:<场次标识>-<题号>`，`scripts/problem-bind.mjs` 产出）**同样是脚本产的**。
//: ⚠️ 漏了它的后果（真事故）：导出人工填写那一步用"**键不是脚本格式** ⇒ 只可能是人绑的"
//:    来判断，而它只认 C 层的 `synth:xcpc:` ⇒ 把 **5678 条脚本产的 P 指针**当成人工填写导了出去，
//:    回来一代又被标成 `manual:set` ⇒ 于是"人确认过的不动"那条规矩把整个 P 层冻住。
//:    （CF/AtCoder 复用题的 `synth:problem:<老家 extKey>` 也一样，它同样会被误导出。）
//: ⚠️ 这里**写字面量**不引用 `PROBLEM_SYNTH_PREFIX`：那个常量在本文件**后面**才定义，
//:    在这行用它 ⇒ **模块导入时 TDZ 报错**（见省赛那段的注释）。
export const PROBLEM_KEY_RE = /^synth:problem:\S/;
/** 本步格式的键（我们管的：按规则可重算）—— **C 层与 P 层都算** */
export const isScriptKey = (k) => {
    const s = String(k || '');
    return NEW_KEY_RE.test(s) || PROBLEM_KEY_RE.test(s);
};
//: 非本格式的旧键（`<分支>:…`，以及清单 slug 方案 `synth:xcpc:icpc2022hangzhou`）
//: —— 国内范围要被本步替换掉
export const isOldKey = (k) => {
    const s = String(k || '');
    return s.startsWith(KEY_PREFIX) && !NEW_KEY_RE.test(s);
};

/**
 * 「这个组头键是**脚本产的**吗」—— 空了就该收掉的判据（应用侧 ⑤「旧组头」用它）。
 *
 * 为什么可以按"键的格式"判：**人手建的键不可能是这两个形状** ——
 *   · 手输的键会被 `assertKeyUsable` 拒掉保留前缀 `synth:`；
 *   · 应用自动生成的键是 `synth:<序号>`（`ops/synth.js` 的 `nextAutoSynthKey`），
 *     既不是本格式也不是旧清单格式 ⇒ 那种空组归"人手建的"，**只报不动**。
 *
 * ⚠️ **两侧口径故意不同一档**（写在这里，免得以后以为谁写错了）：
 *   · **应用侧**：`脚本格式 + 空` ⇒ 一键收掉（人点了才删，看得见）；
 *   · **脚本侧**（`synth-bind.mjs`）：**只收旧清单格式**的空组 —— 它更保守（脚本删节点不可见）。
 *     代价是本格式的空壳会留在包里，由应用侧那一栏收 —— 那正是 ⑤ 有这么一栏的原因。
 */
export const isScriptKeyOrOld = (k) => isScriptKey(k) || isOldKey(k);

//: 键里那个**分类段**的词表（逐字照抄）。冒烟测试钉住"算出来的段一定在表里"。
//: ⚠️ 与 `natureClass` **一一对应**（"分类是什么就填什么"）：分类改了，键自动跟着改。
export const CLASS_TOKENS = Object.freeze([
    // 省赛那一支：12 个组合（4 主办 × 3 类型）
    'provincial', 'ic_provincial', 'cc_provincial', 'ic&cc_provincial',
    'prov&invi', 'ic_prov&invi', 'cc_prov&invi', 'ic&cc_prov&invi',
    'invitational', 'ic_invitational', 'cc_invitational', 'ic&cc_invitational',
    // icpc-ec / ccpc 两支（`<NN>` 是网络赛序号，拼在后面）
    'ec_regional', 'ec_pre', 'ecfinal',
    'cc_regional', 'cc_pre', 'ccpcf', 'ccpc'
]);

/** 分类里 `xcpc` 之后的那几段（`cf/gyms/xcpc/icpc/ec` → `['icpc','ec']`） */
export function xcpcTail(cls) {
    const segs = String(cls || '').split('/').filter(Boolean);
    const i = segs.indexOf('xcpc');
    return i < 0 ? [] : segs.slice(i + 1);
}

/** 只做**国内**：`icpc/ec`、`ccpc`、`省赛与邀请赛`（"暂时只针对国内部分"） */
export function isDomestic(cls) {
    const t = xcpcTail(cls);
    if (t[0] === 'icpc') return t[1] === 'ec';
    return t[0] === 'ccpc' || t[0] === 'provincial&invitational';
}

/** 真地点？不是 ⇒ 返回 ''（`无` / `待填写` / `不需要` / `不知道` / 空） */
export function realPlace(region) {
    const t = String(region === undefined || region === null ? '' : region).trim();
    return t && !NON_PLACE.has(t) ? t : '';
}

/**
 * 赛名里的中文场次 → 数，读不出 ⇒ 0。
 *
 * ⚠️ **别用"逐字累加"**（潜伏错误）：`[...s].reduce((n,ch) => n*10 + 值, 0)`
 * 把 `十一` 算成 10*10+1 = **101**、`二十` 算成 2*10+10 = **30** —— 键与组名会写成
 * `网络赛101`，两场不同的网络赛就并进同一组 / 一场被拆成两组。而**产包侧
 * （`scripts/synth-bind.mjs`）与应用 ⑤ 冲突页共用这个函数** ⇒ 两边同错。
 *
 * 只覆盖 1–99（够用）：`十` = 10、`十Y` = 10+Y、`X十` = X*10、`X十Y` = X*10+Y、单字 = 值。
 */
function zhRound(s) {
    if (/^\d+$/.test(s)) return Number(s);
    const ZH = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    const i = s.indexOf('十');
    if (i >= 0) {
        const hi = i === 0 ? 1 : ZH[s[i - 1]];
        const lo = i === s.length - 1 ? 0 : ZH[s[i + 1]];
        return hi === undefined || lo === undefined ? 0 : hi * 10 + lo;
    }
    const one = [...s];
    return one.length === 1 && ZH[one[0]] ? ZH[one[0]] : 0;
}

// ================================================================
// 「网络赛是第几场」—— 编号的**三种写法**（阿拉伯数字 / 中文 / 罗马数字）
//
// ⚠️ **罗马数字的 `I` 最容易被干扰**（用户 2026-10-06 点名）：它与普通字母 `i` 同形，
//    `II` / `V` / `X` 也可能是词里的一部分（`Division I` / `(Div. I)` / `ICPC` / `i.e.`）⇒
//    分**两档**，判据只有下面这一份：
//      · **括号隔离档**（`(I)` —— 括号里**只有这一个 token**）：括号本身就把内容隔离了
//        ⇒ 大写小写都认（来源写成 `(i)` / `(v)` 也算）；
//      · **非隔离档**（跟在「网络赛」后面、或夹在 `第…场` 里）：**只认大写**，而且由调用方
//        保证 token 后面不是字母数字（`(?![0-9A-Za-z])`）—— 小写 `i` 在这里就是普通字母。
// ================================================================

//: 罗马数字 **1–39**（`(?:X{0,3})(?:IX|IV|V?I{0,3})`）—— **不是**"字符长度"：`IV` = 4、`V` = 5
//: ⚠️ 这两个正则**能吃空串**（三段都可空）⇒ 调用方必须先把空 token 挡掉（见 `roundNumberOf`），
//:    否则空串会算出 `'0'`，键里就多出一个 `…ec_pre0` 这种假序号。
const ROMAN_LOOSE = /^(?:X{0,3})(?:IX|IV|V?I{0,3})$/i;   // 括号隔离档：大小写都认
const ROMAN_STRICT = /^(?:X{0,3})(?:IX|IV|V?I{0,3})$/;    // 非隔离档：**只认大写**

//: 场次 token 的**候选**字符类（三写法）—— **只负责"切出来"**，认不认得出交给
//: `roundNumberOf` 那**唯一一个**校验器（切宽一点没关系：切不出来才是漏读）。
//: ⚠️ 罗马给到 **5 位**（最长的 `XXXIX` = 39）；给 4 位会让 36–39 变成**死区**（实测）。
const ROUND_TOKEN = '[0-9]{1,2}|[一二三四五六七八九十]+|[IVX]{1,5}';
const ROUND_TOKEN_I = '[0-9]{1,2}|[一二三四五六七八九十]+|[IVXivx]{1,5}';   // 括号隔离档（小写也收）

//: 括号里**只有编号**：`(I)` / `(1)` / `（二）`。**全局扫**（见 `onlineRound` 的说明）
const RE_PAREN_ROUND = new RegExp(`\\(\\s*(${ROUND_TOKEN_I})\\s*\\)`, 'g');
//: `第 X 场`
const RE_DI_ROUND = new RegExp(`第\\s*(${ROUND_TOKEN})\\s*场`);
//: 紧跟「网络赛 / 预选赛」的编号；后面**不许再跟字母数字 / 汉字 / 下划线**
//: （`网络赛 IC`、`网络赛I题`、`网络赛2_3`、`网络赛2026` 都不算场次）
const RE_INLINE_ROUND = new RegExp(
    `(?:网络预选赛|网络赛|预选赛)\\s*第?\\s*(${ROUND_TOKEN})(?![0-9A-Za-z_\\u4e00-\\u9fff])`);

/** 罗马数字 → 数（`IV` = 4、`IX` = 9：左小右大就是减）。只在上面两个正则**已经验过**之后调用 */
function romanToInt(s) {
    const V = { I: 1, V: 5, X: 10 };
    let n = 0;
    const t = String(s).toUpperCase();
    for (let i = 0; i < t.length; i++) {
        const cur = V[t[i]];
        const nxt = V[t[i + 1]] || 0;
        n += cur < nxt ? -cur : cur;
    }
    return n;
}

/**
 * 场次编号的**三种写法** → 统一的阿拉伯数字串；认不出 ⇒ `''`（**不猜**）。
 *
 * @param {string} token   已经从赛名里**切出来**的那一小段（`1` / `一` / `I` / `十一`…）
 * @param {boolean} isolated 这一段是不是"括号里只有它"（决定罗马数字认不认小写，见上面两档）
 */
export function roundNumberOf(token, isolated = false) {
    const t = String(token === undefined || token === null ? '' : token).trim();
    // ⚠️ **空串先挡**：罗马那两个正则能吃空串（三段都可空）⇒ 不挡就会算出 `'0'`
    if (!t) return '';
    if (/^[0-9]{1,2}$/.test(t)) {                                      // ① 阿拉伯数字 `1`
        const n = Number(t);
        return n >= 1 ? String(n) : '';                                // 场次从 1 起：`0`/`00` 不猜
    }
    if (/^[一二三四五六七八九十]+$/.test(t)) {                          // ② 中文 `一` / `十一`
        const n = zhRound(t);
        return n >= 1 ? String(n) : '';
    }
    const roman = isolated ? ROMAN_LOOSE : ROMAN_STRICT;               // ③ 罗马数字 `I`
    if (!roman.test(t)) return '';
    const n = romanToInt(t);
    return n >= 1 ? String(n) : '';
}

/**
 * 「网络赛」是**第几场** —— 四种来源，先硬后软；读不出 ⇒ `''`（那个赛季只有一场时本来就该是空）：
 *   ① 来源清单的 slug（`aux-rankland:c:icpc2026preliminary-2`）—— 来源自己的编号，最硬；
 *   ② 赛名里**括号里只有编号**（`(I)` / `(II)` / `(1)` / `（二）`）—— 括号隔离档；
 *   ③ 赛名里的 `第 X 场`（`第 1 场` / `第一场` / `第 I 场`）；
 *   ④ 紧跟「网络赛 / 网络预选赛 / 预选赛」的编号（`…网络赛1` / `…网络预选赛 二`）。
 * 三种写法（阿拉伯数字 / 中文 / 罗马数字）由 `roundNumberOf` 统一认；②③④ 都走它。
 *
 * ⚠️ **不要**放宽成"名字里出现数字就算一场"：赛名里到处是数字（届次、年份、题号）
 *    ⇒ 同一场会被算成好几场。宁可读不出（留给人），也不猜。
 */
export function onlineRound(node) {
    const ext = String(node.extKey || '');
    // ① slug：编号后面**不许再跟字母数字**（`preliminary-1abc` 不算）
    const m1 = /preliminary[-_]?(\d+)(?![0-9A-Za-z])/i.exec(ext);
    if (m1) return String(Number(m1[1]));
    const name = String(node.name || '').replace(/（/g, '(').replace(/）/g, ')');
    // ② 括号里**只有**这个编号（多一个字都不算：`(Div. I)` / `(Interactive)` / `(i.e.)` 不会进来）。
    //    ⚠️ **要扫完整串**：只取**第一个**括号时，前面一个坏 token（`(VX)`）会把后面的好 token
    //       （`(II)`）一起吞掉，那一场就读不出序号了（实测）。取**第一个能认出来的**。
    //    ⚠️ 罗马在这里**大小写都收**（`ROUND_TOKEN_I`）—— 括号已经把内容隔离了，小写没有歧义；
    //       非隔离档（③④）只收大写，那是"小写 `i` 就是个普通字母"的地方。
    for (const m2 of name.matchAll(RE_PAREN_ROUND)) {
        const r2 = roundNumberOf(m2[1], true);
        if (r2) return r2;
    }
    // ③ `第 X 场`
    const m3 = RE_DI_ROUND.exec(name);
    if (m3) {
        const r3 = roundNumberOf(m3[1], false);
        if (r3) return r3;
    }
    // ④ 紧跟「网络赛 / 预选赛」的编号：**罗马只认大写**，且后面不能再跟字母数字/汉字/下划线
    //    （`…网络赛 ICPC` 里的 `I` 是单词开头；`…网络赛2026` 是年份 ⇒ 都不算场次）
    const m4 = RE_INLINE_ROUND.exec(name);
    return m4 ? roundNumberOf(m4[1], false) : '';
}

/**
 * 这条记录来自哪棵树：`extKey` 的第一段（`aux-xcpcio:c:x` → `aux-xcpcio`、`qoj:c:1` → `qoj`）。
 *
 * ⚠️ **判据只有一份**：`utils/extkey.js` 的 `treeOfExtKey`（全仓四处"取第一段"都收口到它，
 *    详见那个文件头）。`ui/nodeinfo/nodeGroup.js` 的 `treeTagOf` 也转调这里
 *    （只额外处理合成节点那一种写法）。合成节点没有 `extKey` ⇒ 返回 `''`。
 */
export function extTreeOf(node) {
    return treeOfExtKey(node && node.extKey);
}

/**
 * 「这一场是**没序号的网络赛**」吗？—— 只认**键的尾标**（`…ec_pre` / `…cc_pre`）。
 * 为什么需要它：网络赛的键靠**序号**区分（`token = ec_pre${onlineRound(node)}`），序号读不出来
 * 时**不猜**（不硬塞一个数字）⇒ 同一赛季的多场无序号网络赛会**算出同一个键**、被并成一组。
 * 这是**两个常见情形里正常的那一种**（"单场无序号、2 场有序号"），所以**不能**因此拒写键；
 * 但"这场其实是两场"时就**无法区分**了 ⇒ ⑤ 拿这条判据把那种组报出来（见 `synthConflicts` 的 ⑩）。
 *
 * ⚠️ 尾标要连**热身赛变体**一起收（`…ec_pre-warmup`）：`planKeyOf` 会给分类里带 `warm-up`
 *    的场次加 `-warmup`，漏了它那种组就报不出来。
 */
export function isUnroundedOnlineKey(key) {
    return /(?:ec_pre|cc_pre)(?:-warmup)?$/.test(String(key || ''));
}

//: 省赛那一支的**两轴**（正交，4×3 = 12 类）——**判据在 Python**
//: （`xcpc_common.provincial_type_of()` / `provincial_org_of()`，唯一一份），
//: 结果写进 `natureClass` 的相邻两段（`…/provincial&invitational/<主办>/<类型>/official`）；
//: 这里只**认这两份名单**（应用侧也按同一份名单筛/改）。
//: ⚠️ 分类正交成 4×3 类（"省赛/邀请赛分支，可能得正交分为 4*3 类"）——`IC邀请赛` /
//:    `CC邀请赛` 那种把主办混进类型的写法不能用；两边的名字必须与
//:    `acm-data/nature-registry.json` 的 Trie 逐字一致（`crate.py selftest` 有断言钉住）。
//: ⚠️ 顺序即**优先级/展示序**：`省赛暨邀请赛` 与 `IC&CC` 都是"两个都有"，排最前（先判）。
export const PROVINCIAL_TYPES = ['省赛暨邀请赛', '省赛', '邀请赛'];
export const PROVINCIAL_ORGS = ['IC&CC', 'IC', 'CC', '无'];

/** 主办判不出时那一段（= "这个名字里没提是 IC 还是 CC"）。与 Python 的 `PROVINCIAL_ORG_NONE` 同值 */
export const PROVINCIAL_ORG_NONE = '无';

/**
 * 12 个省份组合 → **键里那个分类段**（词表逐字照抄）：
 * `provincial` / `ic_provincial` / `cc_provincial` / `ic&cc_provincial` /
 * `prov&invi` / `ic_prov&invi` / … / `invitational` / `ic_invitational` / …
 *
 * ⚠️ 口径是"**分类的中间那一部分对应分类，分类是什么就填什么**" ⇒ 这张表就是
 *    `(主办, 类型)` 到分类段的**唯一映射**；分类改了，键自动跟着改（所以键不用存）。
 * ⚠️ 12 条必须一条不缺（4 主办 × 3 类型）—— 有单测钉住条数。
 */
export const PROVINCIAL_TOKEN = Object.freeze({
    '无/省赛': 'provincial',
    'IC/省赛': 'ic_provincial',
    'CC/省赛': 'cc_provincial',
    'IC&CC/省赛': 'ic&cc_provincial',
    '无/省赛暨邀请赛': 'prov&invi',
    'IC/省赛暨邀请赛': 'ic_prov&invi',
    'CC/省赛暨邀请赛': 'cc_prov&invi',
    'IC&CC/省赛暨邀请赛': 'ic&cc_prov&invi',
    '无/邀请赛': 'invitational',
    'IC/邀请赛': 'ic_invitational',
    'CC/邀请赛': 'cc_invitational',
    'IC&CC/邀请赛': 'ic&cc_invitational'
});

/**
 * 国内范围的一场 → `{key, name, container, season, branch}`；**算不出 ⇒ `null`**（不猜）。
 *
 * @param {Object} node - 包里的 C 记录（或树上的节点：只要带 `natureClass`/`natureSeason`/
 *                        `natureRegion`/`name`/`extKey` 那几格就行）
 */
export function planKeyOf(node) {
    const cls = String(node.natureClass || '').trim();
    if (!isDomestic(cls)) return null;
    const t = xcpcTail(cls);
    const season = String(node.natureSeason || '').trim() || '年份未知';
    const place = realPlace(node.natureRegion);
    const warm = t.includes('warm-up') ? '热身赛' : '';
    // 分支：键里的分支段与容器。⚠️ **容器沿用既有形状**（`synth-icpc` → `ec` → `<赛季>`；
    // 赛区段在 icpc 这支配有，ccpc / 省赛没有）—— 容器键**只在这一处算**
    // （`scripts/synth-bind.mjs` 拿它铺层；改形状就改这里）。
    const branch = t[0] === 'icpc' ? 'icpc-ec' : t[0];
    const container = t[0] === 'icpc' ? 'xcpc:s:synth-icpc:ec'
        : (t[0] === 'ccpc' ? 'xcpc:s:synth-ccpc' : 'xcpc:s:synth-provincial&invitational');
    const icpc = t[0] === 'icpc';
    // ⚠️ 阶段段的位置**因支而异**：`icpc/ec/<阶段>/<phase>` 与 `ccpc/<阶段>/<phase>` 里阶段在
    //    `t[1]`/`t[2]`，而**省赛那一支 `t[0]` 本身就是分支**（`provincial&invitational/official`）
    //    ⇒ 先把它挑出来，不要再按"第几段是阶段"去取（那样省赛整支进不了新键）。
    const stage = t[0] === 'provincial&invitational' ? 'provincial&invitational'
        : (icpc ? (t[2] || '') : (t[1] || ''));
    const short = icpc ? 'IC' : 'CC';
    let tail = '';
    let name = '';
    // ★ 键 = `<赛季><分类段>[-地点][-限定词]`（见 `CLASS_TOKENS` 那段注释）。
    //   `token` = 分类段（**分类是什么就填什么**）；`qualifier` = 末尾限定词（`female` 之类）；
    //   `needPlace` = 这一支要不要地名才能唯一（要 ⇒ 再跟一段地点）。
    let token = '';
    let qualifier = '';
    let needPlace = false;
    if (stage === 'regional') {
        if (!place) return null;
        tail = `${place}${warm}`;
        token = icpc ? 'ec_regional' : 'cc_regional';
        needPlace = true;
        name = `${season} ${short}${place}${warm}`;
    } else if (stage === 'final') {
        tail = `${icpc ? 'EC' : 'CC'}-Final${warm}`;
        token = icpc ? 'ecfinal' : 'ccpcf';
        name = `${season} ${icpc ? 'EC' : 'CC'}-Final${warm}`;
    } else if (stage === 'pre') {
        const round = onlineRound(node);
        tail = `网络赛${round}`;
        token = `${icpc ? 'ec_pre' : 'cc_pre'}${round}`;
        name = `${season} ${short}网络赛${round}`;
    } else if (stage === 'female' || stage === 'vocational') {
        tail = stage === 'female' ? '女生赛' : '高职赛';
        token = 'ccpc';
        qualifier = stage;                    // `2024ccpc-female` / `2024ccpc-vocational`
        name = `${season} ${short}${tail}`;
    } else if (stage === 'provincial&invitational') {
        // ★ 两段**已经是分类里的相邻两段**（`xcpc/provincial&invitational/<主办>/<类型>`，
        //   正交化成 4×3 = 12 类）⇒ 全部从**分类**取，不读赛名
        //   （读赛名那条路实测猜不准，而且判错了没法在应用里改）。
        // ⚠️ 两段都要认：只有类型对、主办是别的写法（如 `IC邀请赛`）⇒ **算不出键**
        //    （宁可留给人，也不按一条读不懂的分类硬算）。
        const org = t[1] || '';
        const type = t[2] || '';
        if (!place || !PROVINCIAL_TYPES.includes(type) || !PROVINCIAL_ORGS.includes(org)) return null;
        token = PROVINCIAL_TOKEN[`${org}/${type}`] || '';
        if (!token) return null;
        needPlace = true;
        tail = `${place}${org}${type}${warm}`;
        // 名字里 `无`（"这个名字里没提主办"）不写出来 —— 否则会读成「河南无省赛」
        name = `${season} ${place}${org === '无' ? '' : org}${type}${warm}`;
    } else {
        return null;                    // 阶段判不出（`无归类` 等）⇒ 交给人
    }
    // ★ 场次标识：`<赛季><分类段>[-地点][-限定词]`（`-` 连接，"可能 `-` 确实更好"）
    const id = `${season}${token}`
        + (needPlace && place ? `-${place}` : '')
        + (qualifier ? `-${qualifier}` : '')
        + (warm ? '-warmup' : '');
    return { key: `${KEY_PREFIX}${id}`, id, name, container, season, branch };
}

/**
 * 为什么算不出键（给人看的一句话）—— 与 `planKeyOf()` **同一批判据**，只是把 `null` 的原因说出来。
 *
 * ⚠️ 只做**国内**：非国内（`icpc/eu·ap·na·la`、`ucup`…）本来就不归这一步管 ⇒ 返回 `''`
 * （那不算"算不出"，是"不归这一套"）。
 */
export function planKeyProblem(node) {
    const cls = String(node.natureClass || '').trim();
    if (!isDomestic(cls)) return '';
    const t = xcpcTail(cls);
    const place = realPlace(node.natureRegion);
    const stage = t[0] === 'provincial&invitational' ? 'provincial&invitational'
        : (t[0] === 'icpc' ? (t[2] || '') : (t[1] || ''));
    if (stage === 'provincial&invitational') {
        const org = t[1] || '';
        const type = t[2] || '';
        if (!place) return '缺地点（natureRegion 不是真地名）';
        // ⚠️ 只有一段的两种情形要分开说：`…/未归类`（停在"类型"那个坑位上 ⇒ **缺类型**）
        //    与 `…/省赛`（类型有了、主办还没 ⇒ **缺主办**）。
        if (!type) {
            return PROVINCIAL_TYPES.includes(org)
                ? `缺主办（分类只有类型「${org}」，没到 ${PROVINCIAL_ORGS.join('/')} 之一）`
                : `缺类型（分类停在「${org || '（空）'}」，没到 ${PROVINCIAL_TYPES.join('/')} 之一）`;
        }
        if (!PROVINCIAL_ORGS.includes(org)) {
            return `缺主办（分类第二段不是 ${PROVINCIAL_ORGS.join('/')} 之一，`
                + `现在是「${org || '（空）'}」）`;
        }
        if (!PROVINCIAL_TYPES.includes(type)) {
            return `缺类型（分类第三段不是 ${PROVINCIAL_TYPES.join('/')} 之一，`
                + `现在是「${type || '（空）'}」）`;
        }
        return '';
    }
    if (stage === 'regional') return place ? '' : '缺地点（natureRegion 不是真地名）';
    if (stage === 'final' || stage === 'pre' || stage === 'female' || stage === 'vocational') return '';
    return `阶段判不出（分类停在「${String(cls)}」）`;
}

/** 分类的**镜像前缀**去掉（`qoj/xcpc/…` / `cf/gyms/xcpc/…` → `xcpc/…`）—— 比"打架"时不能算不同 */
export function bareClass(cls) {
    const segs = String(cls || '').split('/').filter(Boolean);
    const i = segs.indexOf('xcpc');
    return i < 0 ? String(cls || '') : segs.slice(i).join('/');
}

/**
 * 组头那一格**算不算已经和成员一致了** —— 「组头待同步」的判据**只有这一份**。
 *
 * 三个消费者（各写一份必然分叉）：
 *   · ⑤ 的「🔄 组头待同步」检测（`core/synthConflicts.js`）；
 *   · 应用侧的执行（`core/ops/synth.js` 的 `syncHeadNature`）；
 *   · 产包侧的收敛（`scripts/synth-bind.mjs` 的"组头性质"那一段）。
 *
 * ⚠️ **分类只差镜像前缀不算不同**（`qoj/xcpc/…` 与 `cf/gyms/xcpc/…` 指的是同一件事）——
 *    这与 ⑤「同组内分类不一致」那一档（`bareClass`）**同一口径**；以前这两处一个用裸串、
 *    一个用 `bareClass`，于是"只差镜像"的组头会被报成"待同步"、点一下只是把一个
 *    语义相同的字符串换掉（实测真数据 3 条，全是这种）。其余字段（年份/赛季/地区）逐字比。
 */
export function sameNatureValue(field, head, want) {
    const s = (v) => String(v === undefined || v === null ? '' : v).trim();
    const cur = s(head && head[field]);
    const w = s(want);
    if (field === 'natureClass') return bareClass(cur) === bareClass(w);
    return cur === w;
}

// ================================================================
// 「**疑似被拆开的组**」
//
// 来由：省赛那一支正交化（`<主办>/<类型>` 两段进分类**也进键**）带来一个误差：
//   主办是**从各来源自己的赛名**读的，而**同一场比赛在不同来源的名字里品牌词不一致** ——
//   qoj 用官方英文名（`The 2026 ICPC China Zhejiang Province Programming Contest`）写着 `ICPC`，
//   中文来源（`「睿琪杯」浙江省第 23 届大学生程序设计竞赛`）**一个品牌词都不写** ⇒ 算出两个键、拆成两组。
//
// 取舍：**不自动合**（按组投票"看别人怎么说"是**不可从零复现**的：
//   同一场会随来源增减换键；而"每个节点按自己赛名判分类"是可复现的）——
//   这 16 组当**异常交给用户**，由人在判重整理页判断是否同一场、要不要并。
//   ⇒ 于是**必须有一条正确的警告**把它们报出来，判据就是下面这条纯函数。
// ================================================================

/**
 * 一个**合成组**的四要素（从组头那个节点的 nature 读；键里的尾段是拼出来的、切不回来）。
 *
 * @param {Object} node - 组头（有 `synthKey` 的那个 C 节点）
 * @param {number} memberCount - 这一组**还有几个成员**（`ownerSynth` 指着它）
 */
export function groupFacetsOf(node, memberCount = 0) {
    const t = xcpcTail(node && node.natureClass);
    const provincial = t[0] === 'provincial&invitational';
    return {
        key: String((node && node.synthKey) || ''),
        name: String((node && node.name) || ''),
        season: String((node && node.natureSeason) || '').trim() || '年份未知',
        place: realPlace(node && node.natureRegion),
        org: provincial ? (t[1] || '') : '',
        type: provincial ? (t[2] || '') : '',
        provincial,
        memberCount
    };
}

/**
 * 这两个组**疑似本来是一场、被"主办"拆开了**吗？（纯函数；产包侧 `synth-bind.mjs` 与应用侧 ⑤ 共用）
 *
 * 四条同时成立才算：
 *   ① 两边都是**省赛支**的组（只有那一支有主办轴）；
 *   ② **赛季 + 地点 + 类型**三者完全相同；
 *   ③ **主办一边是 `无`、另一边不是 `无`**；
 *   ④ **两组都还有成员**。
 *
 * ⚠️ 为什么必须"一边是 `无`"：**两边都写了品牌且不同**（河南 2024/2026 CC vs IC、
 *    江西 2025/2026 CC vs IC）本来就是**要拆的真·两场**，报它就是**误报**。
 * ⚠️ 为什么必须"两组都还有成员"：**脚本侧只收旧清单格式的空组**（本格式的空组它不碰，见
 *    `isScriptKeyOrOld` 的说明）⇒ 人在应用里手工并回去之后，那个空壳会一直留着；
 *    不排掉它，这条警告**永远消不掉**（那比不报警还糟）。
 */
export function isSuspectSplit(a, b) {
    if (!a || !b || !a.provincial || !b.provincial) return false;
    if (!(a.memberCount > 0) || !(b.memberCount > 0)) return false;
    if (!a.place || !b.place) return false;
    if (a.season !== b.season || a.place !== b.place || a.type !== b.type) return false;
    const aNone = a.org === PROVINCIAL_ORG_NONE;
    const bNone = b.org === PROVINCIAL_ORG_NONE;
    return aNone !== bNone;
}

/**
 * 一批组里所有"疑似被拆开"的**两两**（同一 (赛季, 地点, 类型) 桶内比）。
 *
 * ★ **按 (赛季, 地点, 类型) 分桶**（2026-10-18）：这函数原来是**双循环 O(n²)** —— 真包约 2400 个组
 *   ⇒ **约 290 万次** `isSuspectSplit`（`⑤` 那页 `facets/suspect` 那 43ms 里的一大块）。
 *   而判据本身就写着"三者必须完全相同、且主办一边是 `无`"⇒ **跨桶的配对必然不成立**
 *   ⇒ 分桶后只比桶内、且只把"主办=`无`"的与"主办≠`无`"的配对，**结果与逐对暴力完全相同**。
 *   ⚠️ **顺序也要完全相同**（⑤ 那一栏按这个顺序列，改顺序 = 界面上的顺序变了）：
 *   原实现的顺序是 (i, j) 字典序 ⇒ 这里最后按 `(i, j)` 排一次。
 *
 * @param {Array} groups - `groupFacetsOf()` 的产物
 * @returns {Array<[Object, Object]>}
 */
export function suspectSplitPairs(groups) {
    const list = groups || [];
    // 先筛出"可能参与"的（provincial + 还有成员 + 有地点），按三元组归桶，桶内再按主办分两摞
    const buckets = new Map();   // key → { none: [i…], some: [i…] }
    for (let i = 0; i < list.length; i++) {
        const g = list[i];
        if (!g || !g.provincial) continue;
        if (!(g.memberCount > 0)) continue;
        if (!g.place) continue;
        const k = `${g.season}\u0000${g.place}\u0000${g.type}`;
        let b = buckets.get(k);
        if (!b) { b = { none: [], some: [] }; buckets.set(k, b); }
        ((g.org === PROVINCIAL_ORG_NONE) ? b.none : b.some).push(i);
    }
    const idxPairs = [];
    for (const b of buckets.values()) {
        for (const i of b.none) {
            for (const j of b.some) idxPairs.push(i < j ? [i, j] : [j, i]);
        }
    }
    idxPairs.sort((p, q) => (p[0] - q[0]) || (p[1] - q[1]));
    return idxPairs.map(([i, j]) => [list[i], list[j]]);
}

// ================================================================
// P 层（题目）的绑定计划（"等比赛的绑定做好后…再辅助其下题目的绑定"）
//
// **以比赛组为单位**：一个 C 合成组（`synth:xcpc:<id>`）里，各成员 C 下面的 P **按题号**对上
// ⇒ 同一道题的各来源拷贝归成一组。做法：
//   · "以**直接按题号暴力绑定**为基础，**合成节点 P 随合成节点 C**"；
//   · "若**未发现题名冲突**…；否则…"；
//   · **异常交给用户**：拿不准的一律**不绑**、**报出来**，人在应用里直接改 `ownerSynth`。
//
// ★ 键是**纯函数**（与 C 层同构）：`synth:problem:<C 的场次标识>-<题号>`。
//   ⚠️ 与"C 层身份"同一个道理：各来源算出同一个键 ⇒ 自动成组；来源增减**不换键**
//   （挂在"基准那份的 extKey"上就会随来源集合变 —— 那正是"不可从零复现"）。
//   ⚠️ **不存**：没有"题号映射表"（那套是给"身份要人定"设计的；身份能算了，映射就不存在了，
//   剩下的只是**异常清单**，而异常清单同样不存 —— 存了会跟树状态脱钩成第二套口径）。
//   ⚠️ 与 CF/AtCoder 的**复用题**（跨场同题，键 = `synth:problem:<老家 P 的 extKey>`）**键空间不冲突**：
//   那一种的第二段是 extKey（`cf:c:2268:p:A`），这一种是场次标识（`2026ic_provincial-浙江-A`）。
// ================================================================

/** P 层合成键的前缀（与 `xcpc_common.PROBLEM_SYNTH_PREFIX` 同值 —— 两边都写 `synth:problem:`） */
export const PROBLEM_SYNTH_PREFIX = 'synth:problem:';

/**
 * 「**人确认过**」那条痕迹的值（`分类依据.ownerSynth = 'manual:set'`，由 `core/ops/synth.js`
 * 的 `applyOwnerSynth` 写）。
 *
 * ⚠️ 这里**写死字面量**而不是 import `ops/synth.js` 的常量：那边会拉进 `ops/account.js`
 *    → `shell/state.js` → **immer**，而本文件必须能在**纯 Node**（脚本/单测）里跑。
 *    它是一个**数据格式**（与 `ownerSynth`/`synthKey` 这些字段名同类），不是实现细节。
 * ⚠️ "匹配应该能够存储『是否由人确认过』" ⇒ **报告也要认它**：
 *    确认过的组**不再出现在"交给人"的清单里**（否则点完不消失，等于白点）。
 */
export const MANUAL_OWNER_RULE = 'manual:set';

/**
 * ★ **"人确认过这一组"的标记名** —— 存在**组头自己**那一格上（组级、一条）。
 *
 * 为什么是组级（实测的坑）：以前它塞在**每条成员**的 `分类依据.ownerSynth='manual:set'` 里，
 * 而那一格同时被"脚本改指针 / 应用动作"写着（`applyOwnerSynth` 一律打它）⇒
 * "确认"的语义被污染成"任何一次动作"，脚本产出的指针也被当成"人的结论"锁死
 * （"点一次换一次、永远改不动"）。改成组级之后：它只表达"人看过这一组、认为对"；
 * 脚本那些动作**不写它**；而它随组头进出包 ⇒ 重建不丢。
 *
 * ⚠️ 字面量的**唯一定义处**是 `core/model/elements.js` 的 `CONFIRM_FIELD_NAME`
 * （它得先登记成"能随包走的字段"，重建才不丢）；这里转发。
 */
export const CONFIRM_FIELD = CONFIRM_FIELD_NAME;

/** 「这一条与同号那道题不是同一道」那一格（唯一定义在属性表里；这里转发） */
export const SPLIT_FIELD = SPLIT_FIELD_NAME;

/** 一道"某场次的某题号"的合成键（纯函数） */
export function problemSynthKey(cId, problemId) {
    return `${PROBLEM_SYNTH_PREFIX}${String(cId || '').trim()}-${String(problemId || '').trim()}`;
}

/**
 * **整组都没有题名**时那个组头的兜底显示名（纯函数）。
 *
 * "整组无题名照旧提示，但**可以直接绑**" —— 题号本身就是绑定的**证据**
 * （"直接按题号暴力绑定"是既定规则），题名只是**显示名**；"全组都没题名"不该是"不绑"的理由。
 * ⇒ 照旧报进 `anomalies.noName`（⑤ 里看得见），同时**照常建组、照常绑成员**，名字用这个兜底名：
 *   它**自报缺失**（扫一眼就知道这条的题名还没来），而且人改过名并「✓ 确认」之后脚本不再覆盖。
 */
export function noNameProblemDisplayName(problemId) {
    return `${String(problemId || '').trim()}（题名缺失）`;
}

/**
 * **题名归一化** —— **只用于配对与判重**，**绝不改显示名**（"加进题名归一化"）。
 *
 * 为什么要有：实测那 32 条冲突里一大半是**纯写法差异**，不该占人的时间：
 *   · `PLAYERUNKNOWN'S` vs `PLAYERUNKNOWN’S`（直撇号 vs 弯撇号）
 *   · `Cool, It's …` vs `Cool, It’s …`
 *   · `Hidden $k$-Tuples` vs `Hidden $$$k$$$-Tuples`（LaTeX 的 `$` 个数）
 *   · 全角括号/逗号与半角、全角空格、连续空白
 *
 * ⚠️ 归一化**只影响"这两条算不算同一个题名"**；包里的题名、组名、显示名一个字符都不动。
 * ⚠️ 大小写也归一（配对用；题名的大小写差异不是"不同题"）。
 */
export function normalizeProblemName(name) {
    return String(name === undefined || name === null ? '' : name)
        // ★ **先解 HTML 实体**（实测：爬虫把 `'` 落成 `&#039;`、`"` 落成 `&quot;` ⇒
        //   同一道题的两份题名被判成"对不上"。它只是转义写法不同，不是不同的题）。
        .replace(/&#0?39;|&apos;/gi, "'")
        .replace(/&quot;/gi, '"')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/[\u2018\u2019\u02bc\u2032]/g, "'")          // ‘ ’ ʼ ′ → '
        .replace(/[\u201c\u201d]/g, '"')                       // “ ” → "
        // ★ **LaTeX 的引号也归一到 `"` / `'`**（实测：`A Minor ``Low Space''` vs `A Minor "Low Space"`）：
        //   `` '' 是 LaTeX 的左右双引号、` ' 是左右单引号。
        .replace(/``/g, '"').replace(/''/g, '"')
        .replace(/(?<![`\w])`(?![`\w])/g, "'").replace(/'{2}/g, '"')
        .replace(/[\u2010-\u2015\u2212]/g, '-')                // ‐ – — ― − → -
        .replace(/[\uff01-\uff5e]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
        .replace(/\u3000/g, ' ')                               // 全角空格
        .replace(/\$/g, '')                                    // LaTeX 的 $（`$$$k$$$` vs `$k$`）
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

/** crate 记录的读法（`节点类型` / `父extKey`；应用侧那套形状不同，不在这里兼容） */
const TYPE_OF = (r) => String((r && (r['节点类型'] || r.type)) || '');
const PARENT_OF = (r) => String((r && r['父extKey']) || '');

/**
 * 算出**该建哪些 P 合成组、以及哪些地方对不上**（纯函数）。
 *
 * @param {Array} records - 包里的记录（crate 形状）
 * @param {Function} [idMapOf] - `(contest, memberExtKey) => ({来源题号: 本场题号} | null)`；
 *   题号映射表（住在 `synthRegistry.js`）。**传函数而不是 import**：`synthRegistry` 已经
 *   import 了本文件（用 `bareClass`），反过来 import 会绕成环。
 * @param {Set<string>|null} [confirmedKeys] - **人确认过的那批组键**（`已确认`）。
 *   为什么要在**外面**再传一份：产包链上 `problem-bind` 跑的时刻，P 层记录刚被
 *   `xcpc_pipeline` 整批收掉 ⇒ 组头「还没有」，包里的 `已确认` 更没写回来 ⇒
 *   光看记录认不出人确认过谁，那几处已确认的题名冲突会被当成"交给人"报出来。
 *   应用侧（`synthConflicts`）**不用传**：树上组头就在，`已确认` 读得到。
 * @returns {{groups: Array, anomalies: {noProblemId: Array, noName: Array, nameConflicts: Array},
 *            stats: {cGroups: number, boundP: number, byPid: number}}}
 *   `groups[]` = `{key, parentSynthKey, cId, problemId, name, memberExts, conflicts}`
 */
export function problemBindPlan(records, idMapOf = null, confirmedKeys = null, onPhase = null) {
    // ★ 可观测性（2026-10-18，**只给诊断用**）：`onPhase('段名')` 在每个阶段收尾时被调一次；
    //   **不传就零开销**（生产路径就是这么调的），判定逻辑一个字没动。
    //   ⚠️ 主循环里**每一场**都会喊一遍同名段 ⇒ 调用方要**按名字累加**（`perf-bench.mjs` 就这么汇总）。
    const mark = onPhase ? (name) => { try { onPhase(name); } catch { /* 探针自己炸了不许影响正事 */ } } : null;
    const list = records || [];
    const childrenOf = new Map();
    const heads = new Map();
    // ★ **P 层组头（题目组）**：`已确认` 那一格在**它**身上（组级标记）。
    //   ⚠️ 以前这里只建了 C 组头的表，下面却拿它去查 **P 组键** ⇒ `confirmedByHead` **恒为假**，
    //      "人确认过的组不再报"整条失效（⑤ 里那些组照样算待判；树刚从包里导进来时尤其明显 ——
    //      那时成员身上那套老的 `manual:set` 痕迹根本不存在）。
    const pHeads = new Map();
    const members = new Map();
    for (const r of list) {
        if (!r) continue;
        const p = PARENT_OF(r);
        if (p && r.extKey) {
            if (!childrenOf.has(p)) childrenOf.set(p, []);
            childrenOf.get(p).push(r);
        }
        const sk = String(r.synthKey || '').trim();
        if (TYPE_OF(r) === 'C' && sk.startsWith(KEY_PREFIX)) heads.set(sk, r);
        if (TYPE_OF(r) === 'P' && sk.startsWith(PROBLEM_SYNTH_PREFIX)) pHeads.set(sk, r);
        const o = String(r.ownerSynth || '').trim();
        if (o && r.extKey && TYPE_OF(r) === 'C') {
            if (!members.has(o)) members.set(o, []);
            members.get(o).push(String(r.extKey));
        }
    }

    if (mark) mark('setup');
    const groups = [];
    const anomalies = { noProblemId: [], noName: [], nameConflicts: [], namePaired: [], confirmedGroups: [], sameSourceExtra: [] };
    let cGroups = 0;
    for (const [ck, head] of heads) {
        const mem = members.get(ck) || [];
        // ★★ **单来源的组头也必须有它自己的 P 层组头**（`v9.1.22`）——
        //   ⚠️ 这里原本是 `if (mem.length < 2) continue;`（"只有一个来源 ⇒ 没有可绑的"），
        //      后果是**单来源的 C 组头一个 P 子节点都没有**：树上展不开（灰箭头）、
        //      而 C 卡片那排小方框照样从成员那边并起来画 ⇒ 用户实测：
        //      「这个合成节点分明没有下接题目却有方框」（`synth:xcpc:2025cc_prov&invi-东北` 那场，成员共 1）。
        //      判据（可核）：`node scripts/problem-bind.mjs acm-data/nodes/all_nodes.json --dry-run`
        //      ⇒ 改前"比赛组 **160**"（= 多来源那些），改后应是 **272**（= 全部 C 组头）。
        //   ⚠️ 1 个来源走下面那套**增量名册**是平凡的（每题坐自己那一号），产出同样合法 ——
        //      不是特判分支，只是不再把它挡在门外。
        if (mem.length < 1) continue;
        // ★ 场次标识**直接取组头自己的键**（`synth:xcpc:<id>` 去掉前缀）。
        //   ⚠️ **不要**用 `planKeyOf(head).id` 重算：那是拿**组头自己那几个字段 / 名字**去推，
        //   而组头是脚本按成员造出来的**产物**（名字是拼的、字段之后可能被人改过）——
        //   拿产物当输入，改一次名字就可能换一个标识、把这场的题拆散。
        //   组头的键本来就是**各成员按 nature 算出来并一致**的那一个 ⇒ 它就是权威，读它。
        const cId = String(ck).slice(KEY_PREFIX.length);
        cGroups++;
        // 各成员 C 下面的 P —— 先各自按题号收一摞（**手写题号映射**在这一步生效，见 `remap`）
        //
        // ⚠️ 这里**没有"读回上一轮那个字母"那一档了**（曾经有个 `seeded`/`storedLetterOf`）：
        //   "谁坐哪个号"完全由下面那段**增量名册**算，输入只有三样稳定量
        //   （来源 extKey 顺序 / 各自报的题号 / 题名）⇒ 包与树两边必然算出同一套，
        //   不必靠"读回上一轮的答案"求稳。
        const perMember = [];
        for (const c of mem) {
            const remap = idMapOf ? idMapOf(cId, c) : null;
            const m = new Map();
            for (const p of childrenOf.get(c) || []) {
                if (TYPE_OF(p) !== 'P') continue;
                // ★★ **题目组的组头不是"这一场的题"**（它也是 `C` 类型、也挂在比赛 C 下面）——
                //    它是**上一轮建出来的产物**。把它当输入会让"同样一份包、两遍算出不同答案"：
                //      · 组头带 `synthKey`（`synth:problem:…`），按题名/题号参与配对，
                //        会把真正的成员挤到别的号上；
                //      · 于是每重建一轮，答案就漂一次（用户实测"点一次换一次"）。
                //    判据：**有 `synthKey` 的就不是成员**（与 `synth-bind` 那边同一条）。
                if (String(p.synthKey || '').trim()) continue;
                const raw = String(p.problemId || '').trim();
                if (!raw) { anomalies.noProblemId.push({ c, ext: String(p.extKey || '') }); continue; }
                const pid = (remap && remap[raw]) ? String(remap[raw]).trim() : raw;
                if (!m.has(pid)) m.set(pid, []);
                m.get(pid).push(p);
            }
            perMember.push({ c, m, remap });
        }
        // ★ **题号对不上时按题名配对**（"在默认**同场无同名**的前提下，
        //   **尽可能同名配对即可**"）—— 别再让脚本去认"整体偏移 k"。
        //   基准那份的「题名 → 题号」就是**本场的规范题号**，其他来源按题名对齐到它。
        //   配上的记进 `anomalies.namePaired`（**可审**：哪一条、从哪个题号对到哪个题号），
        //   配不上的（基准里没这个题名）照旧只报。
        //
        //   ★★ **基准怎么挑：先挑"这一份报出来的题最多"的那一份**（同数再按有题名的题数、
        //      最后按 extKey 字典序）。
        //      为什么不能只按 extKey 挑（实测踩到 `2021 四川省赛`）：
        //        CF 那一场**少了一题**（QOJ 13 题、CF 12 题）⇒ CF 的字母整体错位
        //        （它把 Ants 排在 `C`，而这一场 Ants 是 `J`、`C` 是 Triangle Pendant）。
        //        基准挑中 CF ⇒ **它的错位被当成"本场规范"**传给所有来源：Ants 被对齐到 `C`，
        //        而真正属于 `C` 的那道（CF 里没有）在 QOJ 自己那边变成"同号第二题"
        //        —— 用户看到的「2个C」就是它。
        //      **为什么是"题数"而不是"有题名的题数"**：缺题必然让字母整体前移（错位），
        //      而"有题名"只影响可读性 —— 一份全但没题名的成员当基准，比一份少一题但题名全的
        //      更不容易错。实测 `2023 广东省赛`：几份题数都全、只是排法不同，按"有题名"会挑中
        //      QOJ 的排法当规范，反而把别的来源的字母改成靠不住的（撞号闸门一挡，12 条白改）。
        //      ⚠️ 这条只是"最不容易错"的启发式，不是理论保证：真出现**两份都缺、且缺的不是同一题**
        //        时仍可能挑错 —— 那种会以「同一来源两条题号撞车」的形式露出来
        //        （见 `scripts/problem-bind.mjs` 的撞号闸门：撞上就**一条都不改**）。
        const reportCount = (x) => x.m.size;
        //: 这一份成员里"有题名"的题号有几个（只作挑基准的次级判据，不当正判据 —— 见上）
        const namedCountOf = (x) => [...x.m.values()]
            .filter((ps) => ps.some((p) => String(p.name || '').trim())).length;
        const baseMem = perMember.slice()
            .filter((x) => namedCountOf(x) > 0)
            .sort((a, b) => (reportCount(b) - reportCount(a))
                || (namedCountOf(b) - namedCountOf(a))
                || String(a.c).localeCompare(String(b.c)))[0];

        if (mark) mark('perMember');
        // ---- ★★★ **一道题一个号怎么定**：唯一的口径是下面那段**增量名册**
        //   （`rosterName` / `nameToSlot` / `slotOf`）—— 逐条落座，名字认得出就用那一号，
        //   认不出就坐自己报的号，号被占且两边都有名字 ⇒ 共用（报"题名不一致"）或 `拆开` 拿溢出号。
        //   ⚠️ 这里曾经还有一套"按基准那份的题名**直接**定号"的写法（`nameToPid` + `letterOf`），
        //      它已被名册取代（名册同样以题名为准，但按来源顺序逐条落座 —— 于是"两个来源
        //      各自的同号题"也能各就各位）。`baseMem` 还留着，只用于把**基准来源**记进
        //      `namePaired`（给人看"这条是按谁对上的"）。
        //
        // ★★ **一场一排座位**：每条记录最多占一个题号，同一个来源不许两个记录占同一个号。
        //   坐下来分三档（先到先得）：
        //     ① **名字认得出的**（"它就是这一号的那道题"）—— 最高优先；
        //     ② **自己报的号还空着**的 —— 坐在自己那个号上（这就是"只在 QOJ 上有、官方没有"
        //        的那几道的位置）；
        //     ③ 两样都没位置 ⇒ **没座位**（`byPid` 里不出现）⇒ 不绑、由 ⑤ 如实报出来。
        //   ⚠️ 为什么"名字认得出的"必须排在"自己报的号"前面：`2026 东北` 的 `电梯`（QOJ 报 `C`、
        //      但它就是官方 `D` 那道）与 `星塔`（QOJ 报 `C`，官方没有这道）**都想坐 `C`** ——
        //      只有让"名字说了算"的先坐，`电梯` 才能搬到 `D`；否则一个抱着"我原来就叫 C"的
        //      无名之辈就能把整条链堵死（实测：改前 `电梯` 留在 `C`、`D/G/J` 三组各多一条未绑）。
        // ---- ★★★ **本组的匹配：以整组为单位走一遍"增量名册"**（用户设计，逐字实现）----
        //   ⚠️ 落座顺序**只有一条**：来源按 extKey 字典序、场内按记录自己报的题号
        //      （同号再看 extKey）—— `srcOrder` / `problemsOf` 两处显式排序。
        //      为什么非要显式排：包里（文件顺序）与树上（`childOrder`）顺序不同，
        //      不排就会走出**两套答案**（"点一次换一次"就是这么来的）。
        //      用"记录自己报的题号"当顺序是**安全的**：本步**不写回**任何记录的题号
        //      （见 `scripts/problem-bind.mjs` 里那段"只写归属与组"），所以它是稳定输入。
        //   规则：**按序遍历各原料节点的各题** ——
        //     ① 题名在名册里已出现      → 映射到那一号；
        //     ② 否则自己的题号不在名册里 → **占用该号**；
        //     ③ 否则那个号已被占：
        //          · 占它的那条**还没名字** → 映射过去（用我这条的名字补上）；
        //          · 已经有名字            → 用 **X1、X2…X99**（溢出号）。
        //   为什么它是对的：**一道题恰好一个号**（不是"每条记录各自抢座"），而且溢出号让
        //   "两个来源各自的同号题"都能落下 ⇒ 没有"谁先抢到"的歧义。
        //   ⚠️ **两级顺序都显式排序**（来源按 extKey、场内按题号）：否则包里（文件顺序）与
        //      树上（`childOrder`）会走出两套答案 —— 那正是"点一次换一次"的来源。
        //: ★ **「这一条与同号那道题不是同一道」**（人在 ⑤ 点「✂️ 不同的题」打上的标记）——
        //: 它让这一条拿**溢出号**（`X1、X2…`），从此与那一号分属两组。
        const isSplitMarked = (p) => !!(p && (p[SPLIT_FIELD_NAME] === true || p[SPLIT_FIELD_NAME] === '是'));
        const srcOrder = [...perMember].sort((a, b) => String(a.c).localeCompare(String(b.c)));
        // ⚠️ 这一份**每场只算一次**（2026-10-18）：下面"增量名册"与"手写映射"两趟都要它，
        //    原来各调一次 `problemsOf(x)` ⇒ 每场把成员题表**重建 + 排序两遍**（实测那两段合计 ~80ms）。
        //    ⚠️ 顺序必须与原来逐字相同（来源按 extKey、场内按题号 numeric、再按 extKey）；
        //       缓存的是**同一个数组**，调用方只读不改。
        const problemsCache = new Map();
        const problemsOf = (x) => {
            const hit = problemsCache.get(x);
            if (hit) return hit;
            const all = [];
            for (const ps of x.m.values()) for (const p of ps) all.push(p);
            // 场内按**它自己报的题号**排（稳定：同号再看 extKey）
            const sorted = all.sort((a, b) => String(a.problemId || '').localeCompare(
                String(b.problemId || ''), undefined, { numeric: true })
                || String(a.extKey || '').localeCompare(String(b.extKey || '')));
            problemsCache.set(x, sorted);
            return sorted;
        };
        const rosterName = new Map();            // 号 → 题名（归一化；`''` = 还空着）
        const nameToSlot = new Map();            // 归一化题名 → 号
        const slotOf = new Map();                // 记录 → 号
        let overflow = 0;
        for (const x of srcOrder) {
            for (const p of problemsOf(x)) {
                const nm = normalizeProblemName(p.name);
                const ownRaw = String(p.problemId || '').trim();
                // ★ **手写题号映射**（注册表 `problemIdMap`）在**这一步**生效：
                //   "这个来源在这一场里，题号 `X` 算本场的 `Y`" ⇒ 名册里"它想坐哪个号"
                //   要用**映射后**的那个号（`ownRaw` 只用于"哪一条、从哪个号对到哪个号"的记账）。
                const own = (x.remap && x.remap[ownRaw]) ? String(x.remap[ownRaw]).trim() : ownRaw;
                let slot = '';
                if (nm && nameToSlot.has(nm)) slot = nameToSlot.get(nm);       // ① 题名认出来了
                else if (own && !rosterName.has(own)) slot = own;              // ② 自己的号空着 ⇒ 占用
                // ③a 那个号已被占，但**没有"两边都有名字且不一样"的证据** ⇒ 映射过去：
                //    · 占它的那条还没名字（用我这条的名字补上）；**或**
                //    · **我这条自己没题名**（`空题名弃权` —— 仓库既有口径：没名字不构成争号的证据）
                else if (own && (!rosterName.get(own) || !nm)) slot = own;
                // ③b **号相同、题名不同** ⇒ 这是**要人判**的那一类，两种确认都在：
                //    · **(b) 同一道题**（默认）：**照样共用这一号**，把"题名不一致"报给人在 ⑤ 确认
                //      —— 这是绝大多数情形（同一道题的中/英两种写法）。
                //    · **(a) 不同的题**：人点了「✂️ 不同的题」⇒ 这条记录带上 `拆开` 标记
                //      ⇒ 这里**给它一个溢出号 `X1、X2…`**（它与那一号从此分属两组）。
                else if (own && !isSplitMarked(p)) slot = own;                 // (b) 默认：共用这一号
                else { overflow += 1; slot = `X${overflow}`; }                 // (a) 已确认要拆 ⇒ 溢出号
                if (!slot) continue;
                if (!rosterName.has(slot)) rosterName.set(slot, '');
                if (!rosterName.get(slot) && nm) rosterName.set(slot, nm);     // 顺手把名字补上
                if (nm && !nameToSlot.has(nm)) nameToSlot.set(nm, slot);
                slotOf.set(p, slot);
                // ★ **"按题名对上"要如实记一笔**（⑤ 的「⚠️ 按题名对上 N 处（已绑上，点开可审）」读它）：
                //   从哪个题号 → 对到哪个题号。**手写映射不算**（那是人的结论，不是"按题名配上的"）。
                if (own && slot !== own && nm) {
                    anomalies.namePaired.push({
                        cId, c: x.c, ext: String(p.extKey || ''),
                        // ⚠️ 存**原始**题名（不是归一化名）：这一档拿给人看
                        name: String(p.name || '').trim(),
                        from: own, to: slot, base: String((baseMem || {}).c || '')
                    });
                }
            }
        }
        if (mark) mark('roster');
        // ---- ★ **到这一步才轮到"原有的手写映射"** ----
        //   手写映射是**人的结论** ⇒ **压过**上面算出来的号（口径与全仓一致：`manual:set` = 级别 M，
        //   比任何规则硬）。它只改"这一条坐哪个号"，不改别的；两条手写映射撞到同一个号时，
        //   **高一级的那条说了算**（同级按来源/题号顺序，先到先得）—— 这就是"按最高级别规则破环"。
        for (const x of srcOrder) {
            for (const p of problemsOf(x)) {
                const rules = p['分类依据'];
                if (!rules || String(rules.ownerSynth || '') !== MANUAL_OWNER_RULE) continue;
                const cur = String(p.ownerSynth || '').trim();
                const want = cur.slice(cur.lastIndexOf('-') + 1);
                if (!want) continue;
                slotOf.set(p, want);
                if (!rosterName.has(want)) rosterName.set(want, '');
                const nm = normalizeProblemName(p.name);
                if (!rosterName.get(want) && nm) rosterName.set(want, nm);
                if (nm && !nameToSlot.has(nm)) nameToSlot.set(nm, want);
            }
        }
        if (mark) mark('byPid');
        // ---- 入桶：**按它落下的那个号** ----
        //   ⚠️ 同一个来源在同一号上仍可能有多条（手写映射与算出来的撞车）——
        //      下面那句"同一来源最多一条"会挑出与组名相符的那条绑上、其余报 extras（只报不绑）。
        const byPid = new Map();
        for (const x of srcOrder) {
            for (const p of problemsOf(x)) {
                const slot = slotOf.get(p);
                if (!slot) continue;
                if (!byPid.has(slot)) byPid.set(slot, []);
                byPid.get(slot).push(p);
            }
        }
        for (const [pid, ps] of byPid) {
            // ★★ **只有一份来源的题号也要建组**（`v9.1.22`）——原本 `if (ps.length < 2) continue;`
            //   （"这一题号只有一份来源 ⇒ 不必绑"）。后果与上面 `mem.length` 那道门**同一个**：
            //   组头没有 P 子节点 ⇒ 树上展不开、而 C 卡片那排小方框照画（用户："分明没有下接题目却有方框"）。
            //   为什么"不必绑"曾经说得通：P 层组的本意是**把各来源的同一道题并成一组**，一份来源没得并。
            //   但**组还是要有**：否则那个 C 组头的"子树"是空的，而它的方框/计数却是这些题算的。
            //   ⇒ 口径改成：**每个（场次, 题号）都有一个 P 层组头**，成员 1..N 条。
            if (ps.length < 1) continue;
            const key = problemSynthKey(cId, pid);
            // 组名：**有题名的那一份**里 extKey 最小的（空题名弃权 —— "空题名不算冲突"）
            const named = ps.filter((p) => String(p.name || '').trim())
                .sort((a, b) => String(a.extKey).localeCompare(String(b.extKey)));
            const base = named[0];
            // ★ **整组都没题名 ⇒ 照旧提示，但照样绑**。
            //   不建组（`continue`）的后果是那 61 组的成员**一条都绑不上**，
            //   而 ⑤ 里只列了成员、没有任何可给的键，人在界面上**想绑也绑不了**（死胡同）。
            //   所以：照旧进 `anomalies.noName`（带 `key`，⑤ 能点、能确认），同时照常建组，
            //   显示名用兜底名 `题号（题名缺失）`（人在树上改名 + 「✓ 确认」之后脚本不再覆盖）。
            const baseName = base ? String(base.name).trim() : '';
            const displayName = baseName || noNameProblemDisplayName(pid);
            // ⚠️ 判"题名一不一致"也要走**归一化**：直/弯撇号、`$`、全角半角这些**不是不同的题**
            //    （"加进题名归一化"）—— 不归一化的话它们会一直挂在"要人判"里。
            //   ⚠️ 全组无题名时 `baseNorm` 是空串，而每个人的 `nm` 也是空串 ⇒ 不会误报冲突。
            const baseNorm = normalizeProblemName(baseName);
            // ★ **一组里同一个来源最多一条**（报过的：
            //   "`synth:problem:2026provincial-东北-D` 怎么被同一场的 C/D 都绑上了？"）。
            //   同场无同名 ⇒ 一个来源对**同一道题**只该有一条。多出来的那些 = "题号错位还没对齐干净"
            //   ⇒ **不绑、报出来**（`sameSourceExtra`）。
            //   两份里留哪条：**题名与组名一致**的那条（组名就是这道题的题名），另一条踢出去。
            const picked = new Map();               // 来源（成员 C）→ 留下的那条
            const extras = [];
            for (const p of ps) {
                const src = String(p.extKey).replace(/:p:[^:]+$/, '');
                const prev = picked.get(src);
                if (!prev) { picked.set(src, p); continue; }
                const okPrev = normalizeProblemName(prev.name) === baseNorm;
                const okNew = normalizeProblemName(p.name) === baseNorm;
                if (okNew && !okPrev) { picked.set(src, p); extras.push(prev); } else extras.push(p);
            }
            if (extras.length) {
                anomalies.sameSourceExtra.push({ key, cId: cId, problemId: pid,
                    list: extras.map((p) => ({ ext: String(p.extKey), name: String(p.name || '').trim() })) });
            }
            const kept = [...picked.values()];
            const conflicts = kept
                .filter((p) => {
                    const nm = normalizeProblemName(p.name);
                    return nm && nm !== baseNorm;
                })
                .map((p) => ({ ext: String(p.extKey), name: String(p.name).trim(), base: baseName }));
            // ★ **确认过的组不再报**（"匹配应该能够存储『是否由人确认过』"）：
            //   判据（**两个都认**，新老并存）：
            //     ① ★ **组头自己那格 `已确认`** —— 组级标记、一条，脚本动作**不写它**
            //        （`scripts/problem-bind.mjs` 的 `CONFIRM_FIELD`）；
            //     ② 老数据：**每个成员**都写着这个键 + **都带** `分类依据.ownerSynth = 'manual:set'`。
            //   ⚠️ 为什么改成组级：那个成员级的标记同时被"脚本改指针"写着 ⇒ 语义被污染成
            //      "任何一次动作"，于是脚本产出的指针也被当成人的结论锁死（"点一次换一次"）。
            //   ⚠️ 少了这一条会"点完不消失"——因为冲突是**按题名**比的，而确认**不改题名**（实测踩到）。
            const headRec = pHeads.get(key) || null;   // 组头（P 层；可能不在树上/不在包里）
            // 「人确认过」：① 组头那格 `已确认`；② 外面递进来的那份名册（产包链上组头还没建，
            //   见 `confirmedKeys` 的说明）；③ 老数据：成员身上那套 `manual:set` 痕迹。
            const confirmedByHead = !!(headRec && (headRec[CONFIRM_FIELD] === true || headRec[CONFIRM_FIELD] === '是'))
                || !!(confirmedKeys && confirmedKeys.has(key));
            const confirmedByMembers = kept.length > 0 && kept.every((p) => String(p.ownerSynth || '').trim() === key
                && String(((p['分类依据'] || {}) || {}).ownerSynth || '') === MANUAL_OWNER_RULE);
            if (confirmedByHead || confirmedByMembers) {
                anomalies.confirmedGroups.push({ key, cId: cId, problemId: pid, n: kept.length });
            } else if (!base) {
                // ★ 整组无题名 ⇒ 照旧**提示**（`memberExts` 用 `kept`，也就是真正绑上的那些 ——
                //   ⑤ 的「✓ 确认」要按这份名单逐个打标记，把"同一来源多出来的那条"混进去会误标）。
                //   ⚠️ 与冲突那一档**同一道闸**：确认过的**不再列** —— 否则"在 ② 里点了 ✓，
                //      它还在那儿"（实测：用户 2026-10-08 报的），而那句提示写的就是
                //      "确认过的组脚本不再覆盖名字"。
                anomalies.noName.push({ key, cId: cId, problemId: pid,
                    memberExts: kept.map((p) => String(p.extKey)) });
            } else if (conflicts.length) {
                anomalies.nameConflicts.push({ key, cId: cId, problemId: pid, base: String(base.extKey), list: conflicts });
            }
            // ⚠️ 成员名单用 `kept`（踢掉"同一来源的第二条"之后的那份）。
            //   ⚠️ `v9.1.22` 起这里是 `< 1`（原本 `< 2`，"没有可绑的第二份来源"）——
            //      与上面 `ps.length` 那道门**同一口径**：**只剩一条成员也要建组**，
            //      否则那个 P 层组头不存在、C 组头下面又空了（那正是这一轮在治的东西）。
            if (kept.length < 1) continue;
            groups.push({
                key, parentSynthKey: ck, cId: cId, problemId: pid, name: displayName,
                noName: !baseName,                    //: 显示名是兜底名（整组都没题名）
                memberExts: kept.map((p) => String(p.extKey)).sort(), conflicts
            });
        }
        if (mark) mark('pheads');
    }
    return {
        groups,
        anomalies,
        stats: { cGroups, groups: groups.length, boundP: groups.reduce((n, g) => n + g.memberExts.length, 0) }
    };
}
