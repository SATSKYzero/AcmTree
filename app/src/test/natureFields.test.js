// ================================================================
// 「性质」注册表与「分类」Trie（src/test/natureFields.test.js）
//
// 定稿：
//   · **没有「大类 / 小类」，只有一个不定层的「分类」字段**：
//     值 = 有序字符串列表，节点上存 `/` 连起来的字符串（`xcpc/icpc/ec/pre`）；
//   · 合法性 = 注册表文件 `acm-data/nature-registry.json` 里的 **Trie**，
//     **任何前缀都合法**（"停在哪一层"本身就是信息）；
//   · `无归类` = 判过了但归不进去（含义同「无」）；**空 = 还没标**；
//   · 与 `年份` / `地区` **正交**。
//
// ⚠️ **注册表是唯一真源（一个文件）**：JS 侧读它（本模块）、Python 侧 `scripts/crate.py`
//    也读它 ⇒ **没有第二份镜像，也不需要"跨语言同步测试"**。
//    这里钉的是：JSON 能被加载、Trie 自检、路径校验/前缀匹配/归一这些**行为**。
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    NATURE_FIELD_KEYS,
    NATURE_CLASS_KEY,
    CLASS_NONE,
    CLASS_SEP,
    CLASS_TRIE,
    CLASS_ROOTS,
    CLASS_PATHS,
    NATURE_FIELDS,
    NATURE_YEAR_PATTERN,
    classPathOf,
    classValueOf,
    classChildren,
    classPathProblem,
    isKnownClassPath,
    isCompleteClassPath,
    classMatches,
    classRootOf,
    classLabel,
    isNatureField,
    natureFieldOf,
    natureFields,
    hasNatureVocabulary,
    natureValuesOf,
    normalizeNatureValue,
    isNatureYear,
    isNatureSeason,
    isRealYear,
    natureInputSuggestions,
    NATURE_PENDING_VALUES,
    NATURE_SEASON_NONE,
    NATURE_YEAR_NONE,
    NATURE_REGION_NONE,
    NATURE_REGION_TBD,
    NATURE_REGION_NOT_NEEDED,
    NATURE_REGION_UNKNOWN,
    NATURE_SEASON_PATTERN,
    isKnownNatureValue,
    collectNatureValues,
    natureComboOf,
    natureLabel,
    CLASS_PENDING,
    CLASS_UPSTREAM,
    NATURE_NOT_APPLICABLE,
    isNotApplicableValue
} from '../core/natureFields.js';
import { ELEMENT_NAMES } from '../core/model/elements.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = path.resolve(HERE, '..', '..', 'acm-data', 'nature-registry.json');

// ================================================================
// 一、字段表：三个字段，分类在前
// ================================================================

test('字段键 = 分类 / 年份 / 赛季 / 地区（四个）', () => {
    assert.deepEqual([...NATURE_FIELD_KEYS],
        ['natureClass', 'natureYear', 'natureSeason', 'natureRegion']);
    assert.equal(NATURE_CLASS_KEY, 'natureClass');
    assert.equal(NATURE_FIELDS.natureClass.label, '分类');
    assert.equal(NATURE_FIELDS.natureYear.label, '年份');
    assert.equal(NATURE_FIELDS.natureRegion.label, '地区');
    assert.equal(NATURE_FIELDS.natureClass.kind, 'classPath');
    assert.equal(NATURE_FIELDS.natureYear.kind, 'pattern');
    assert.equal(NATURE_FIELDS.natureRegion.kind, 'text');
    assert.equal(NATURE_YEAR_PATTERN, '^(20\\d{2}|无|待同步|不确定|上游异常)$');
});

test('三个字段都进了元素表（`types: '*'`，可空、可导入、可手改）', () => {
    for (const k of NATURE_FIELD_KEYS) {
        assert.equal(ELEMENT_NAMES.includes(k), true, `${k} 必须在元素名单里`);
    }
    assert.equal(ELEMENT_NAMES.includes('natureMain'), false, '`natureMain` 不在元素名单里');
    assert.equal(ELEMENT_NAMES.includes('natureSub'), false, '`natureSub` 不在元素名单里');
});

test('字段查询入口：isNatureField / natureFieldOf / natureFields', () => {
    assert.equal(isNatureField('natureClass'), true);
    assert.equal(isNatureField('natureMain'), false);
    assert.equal(isNatureField('name'), false);
    assert.equal(natureFieldOf('natureClass').key, 'natureClass');
    assert.equal(natureFieldOf('natureMain'), null);
    assert.deepEqual(natureFields().map(f => f.key), [...NATURE_FIELD_KEYS]);
});

// ================================================================
// 二、注册表文件与 Trie 自检
// ================================================================

test('注册表文件就是真源：字段表与 Trie 都从它来（没有第二份镜像）', () => {
    const raw = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
    assert.deepEqual(Object.keys(raw.fields), [...NATURE_FIELD_KEYS],
        'JSON 里的字段表必须与 NATURE_FIELD_KEYS 逐字同序');
    assert.deepEqual(raw.classTrie, CLASS_TRIE, 'CLASS_TRIE 就是 JSON 里那棵树（同一份内容）');
    assert.equal(typeof raw.registryVersion, 'number', '注册表要带版本号');
});

test('Trie 的根 = 七支；收集源不是分类', () => {
    for (const root of ['xcpc', 'cf', 'atcoder', 'qoj', 'nk', 'hdu', 'pta']) {
        assert.ok(CLASS_ROOTS.includes(root), `缺根 ${root}`);
    }
    for (const collected of ['xcpcio', 'rankland', 'srk']) {
        assert.equal(CLASS_ROOTS.includes(collected), false,
            `${collected} 是收集源，不该是分类的根`);
    }
    assert.equal(CLASS_ROOTS.includes('atc'), false, '简写 atc 不是根（用全称 atcoder）');
});

test('点名的路径都在 Trie 里，且 `qoj` 下**镜像**了 xcpc 的整棵子树', () => {
    const paths = CLASS_PATHS.map(p => p.value);
    for (const p of ['xcpc/icpc/ec/pre', 'xcpc/icpc/ec/regional', 'xcpc/icpc/ec/final',
        'xcpc/icpc/ec/无归类', 'xcpc/ccpc/pre', 'xcpc/ccpc/regional', 'xcpc/ccpc/final',
        'xcpc/ccpc/无归类', 'xcpc/ccpc/female', 'xcpc/ccpc/vocational',
        'xcpc/provincial&invitational', 'xcpc/icpc/eu', 'xcpc/icpc/ap', 'xcpc/无归类',
        // ICPC 的 8 个赛区都用官方缩写（aa/ec/ap/aw/eu/la/na/ne；`jp` 归在 `ap` 下）
        'xcpc/icpc/aa', 'xcpc/icpc/ec', 'xcpc/icpc/aw', 'xcpc/icpc/la', 'xcpc/icpc/na', 'xcpc/icpc/ne',
        'cf/contest/div1', 'cf/contest/div2', 'cf/contest/div3', 'cf/contest/div4', 'cf/contest/div1+2', 'cf/contest/edu',
        'cf/contest/others/team', 'cf/contest/others/april', 'cf/contest/others/kotlin', 'cf/contest/others/无归类',
        'atcoder/arc', 'atcoder/abc', 'atcoder/agc', 'atcoder/无归类',
        'nk/多校', 'hdu/多校', 'qoj/无归类',
        // qoj/ucup（Universal Cup 单独一支：年份=QOJ 端时间、赛季=无）
        'qoj/ucup',
        // qoj 下镜像 xcpc 的分类
        'qoj/xcpc/icpc/ec/regional', 'qoj/xcpc/icpc/ec/pre', 'qoj/xcpc/icpc/ec/final',
        'qoj/xcpc/icpc/ec/无归类', 'qoj/xcpc/ccpc/final', 'qoj/xcpc/ccpc/regional',
        'qoj/xcpc/ccpc/pre', 'qoj/xcpc/ccpc/无归类', 'qoj/xcpc/ccpc/female',
        'qoj/xcpc/ccpc/vocational', 'qoj/xcpc/provincial&invitational', 'qoj/xcpc/无归类',
        // 每一支再分 official / warm-up（`无归类` 不带这一层）
        'xcpc/icpc/ec/final/official', 'xcpc/icpc/ec/final/warm-up',
        'xcpc/ccpc/final/official', 'xcpc/ccpc/final/warm-up',
        // ★ 省赛那一支带"类型"这一段：
        //   "正交分为 4*3 类" ⇒ **相邻两段** `…/provincial&invitational/<主办>/<类型>/…`，
        //   类型判不出 ⇒ `…/无归类`（不带 phase）
        'xcpc/provincial&invitational/IC/省赛暨邀请赛/official',
        'xcpc/provincial&invitational/IC/邀请赛/warm-up',
        'xcpc/provincial&invitational/CC/省赛/official',
        'xcpc/provincial&invitational/IC&CC/邀请赛/official',
        'xcpc/provincial&invitational/无/邀请赛/official',
        'xcpc/provincial&invitational/无归类',
        'qoj/xcpc/icpc/ec/final/warm-up', 'qoj/xcpc/ccpc/regional/official']) {
        assert.ok(paths.includes(p), `路径 ${p} 必须在 Trie 里`);
    }
    assert.equal(paths.includes('xcpc/provincial&invitational/official'), false,
        '★ 省赛不直接带 official：中间夹**主办 + 类型**两段');
    assert.equal(paths.includes('xcpc/provincial&invitational/省赛/official'), false
        && paths.includes('xcpc/provincial&invitational/IC邀请赛/official'), false,
        '★ 那 5 类（`…/省赛/official`、`…/IC邀请赛/…`）**一个都不许留**——主办独立成一轴');
    assert.equal(paths.includes('xcpc/icpc/ec/无归类/official'), false,
        '`无归类` 不分 official/warm-up（"这一支里没有它可归的一项"没有正式/热身之分）');
    assert.equal(paths.includes('xcpc/icpc/ec/region') || paths.includes('xcpc/ccpc/region'), false,
        '`region` 这种写法一个都不许留（用 `regional`）');
    const xcpcSub = paths.filter(p => p === 'xcpc' || p.startsWith('xcpc/'));
    const missing = xcpcSub.map(p => `qoj/${p}`).filter(p => !paths.includes(p));
    assert.deepEqual(missing, [], 'qoj 下面必须镜像 xcpc 的整棵子树（含后代）');
    assert.equal(new Set(paths).size, paths.length, '展平出来的路径不许重复');
});

test('展平结果：每个合法**前缀**都在（"停在哪一层"本身就是信息）', () => {
    for (const p of ['xcpc', 'xcpc/icpc', 'xcpc/icpc/ec', 'cf', 'cf/contest/div2', 'atcoder', 'nk']) {
        assert.ok(CLASS_PATHS.some(x => x.value === p), `前缀 ${p} 应是一个合法值`);
    }
    // 深度不设上限：Trie 有几层就有几条
    const deepest = Math.max(...CLASS_PATHS.map(p => p.depth));
    assert.ok(deepest >= 3, `至少要有三层（实际最深 ${deepest} 层）`);
    // label 是给人看的（段之间用 ` / `）
    assert.equal(CLASS_PATHS.find(p => p.value === 'xcpc/icpc').label, 'xcpc / icpc');
});

test('Trie 自检：段非空、段里不许含分隔符（含了就切不开）', () => {
    const walk = (node, at) => {
        for (const [seg, kids] of Object.entries(node)) {
            assert.ok(String(seg).trim().length > 0, `${at} 下有空段`);
            assert.equal(String(seg).includes(CLASS_SEP), false, `段 ${seg} 里含分隔符`);
            walk(kids, `${at}/${seg}`);
        }
    };
    walk(CLASS_TRIE, '（根）');
});

// ================================================================
// 三、值的行为：拆分 / 归一 / 校验 / 前缀匹配
// ================================================================

test('classPathOf：`/` 串、列表、空 —— 都能拆（只 trim，不做别名替换）', () => {
    assert.deepEqual(classPathOf('xcpc/icpc/ec'), ['xcpc', 'icpc', 'ec']);
    assert.deepEqual(classPathOf(' xcpc / icpc '), ['xcpc', 'icpc']);
    assert.deepEqual(classPathOf(['xcpc', ' icpc ', '']), ['xcpc', 'icpc']);
    assert.deepEqual(classPathOf(''), []);
    assert.deepEqual(classPathOf(null), []);
    assert.deepEqual(classPathOf('CF'), ['CF'], '**不做大小写折叠**（原样，便于排查）');
});

test('classValueOf / classLabel / classRootOf', () => {
    assert.equal(classValueOf(['xcpc', 'icpc']), 'xcpc/icpc');
    assert.equal(classValueOf('xcpc/icpc'), 'xcpc/icpc');
    assert.equal(classLabel('cf/contest/div2'), 'cf / contest / div2');
    assert.equal(classLabel(''), '');
    assert.equal(classRootOf('cf/contest/div2'), 'cf');
    assert.equal(classRootOf(''), '');
});

test('classChildren：给一层拿下一层的候选（下拉要用）', () => {
    assert.deepEqual(classChildren(''), CLASS_ROOTS);
    assert.ok(classChildren('cf').includes('contest'), 'CF 的正式轮次收在 `contest` 这一层下');
    assert.ok(classChildren('cf/contest').includes('div2'));
    assert.ok(classChildren('xcpc/icpc').includes('ec'));
    assert.deepEqual(classChildren('cf/contest/div2'), [], '叶子没有下一层');
    assert.deepEqual(classChildren('不存在的'), []);
});

test('classPathProblem：合法路径一律 `""`；错了要说清在哪一层、可选什么', () => {
    for (const ok of ['', 'xcpc', 'xcpc/icpc', 'xcpc/icpc/ec/pre', 'cf/contest/others/无归类', 'qoj/无归类']) {
        assert.equal(classPathProblem(ok), '', `${ok} 应该合法`);
    }
    assert.match(classPathProblem('codeforces'), /没有「codeforces」/);
    assert.match(classPathProblem('codeforces'), /可选：/, '要说清这一层可选什么');
    assert.match(classPathProblem('cf/nope'), /分类「cf」下没有「nope」/);
    assert.match(classPathProblem('cf/contest/div2/x'), /已经没有下一层了/, '叶子下面再挂要说清');
});

test('isKnownClassPath：空值不算"登记过的值"', () => {
    assert.equal(isKnownClassPath('xcpc/icpc'), true);
    assert.equal(isKnownClassPath(''), false);
    assert.equal(isKnownClassPath(null), false);
    assert.equal(isKnownClassPath('cf/nope'), false);
});

test('classMatches：**前缀匹配**（选 `cf` 命中它下面所有更深的路径）', () => {
    assert.equal(classMatches('cf/contest/div2', 'cf'), true);
    assert.equal(classMatches('cf', 'cf'), true);
    assert.equal(classMatches('cf', 'cf/contest/div2'), false, '反过来不成立（父不在子的下面）');
    assert.equal(classMatches('xcpc/icpc', ''), true, '空前缀 = 全部');
    assert.equal(classMatches('', 'cf'), false, '没标的不落在任何前缀下');
});

// ================================================================
// 四、字段级 API（normalize / 词表 / 组合）
// ================================================================

test('normalizeNatureValue：分类归一成 `a/b`，年份/地区只 trim', () => {
    assert.equal(normalizeNatureValue('natureClass', ['xcpc', 'icpc']), 'xcpc/icpc');
    assert.equal(normalizeNatureValue('natureClass', ' xcpc/icpc '), 'xcpc/icpc');
    assert.equal(normalizeNatureValue('natureClass', null), '');
    assert.equal(normalizeNatureValue('natureYear', ' 2025 '), '2025');
    assert.equal(normalizeNatureValue('natureRegion', ' 成都 '), '成都');
    assert.equal(normalizeNatureValue('natureRegion', null), '');
});

test('年份格式只认 20xx；地区**不**校验格式', () => {
    assert.equal(isNatureYear('2025'), true);
    assert.equal(isNatureYear(' 2025 '), true);
    for (const bad of ['26', '2025年', '1999', '', 'abcd']) {
        assert.equal(isNatureYear(bad), false, `${bad} 不该算合法年份`);
    }
    assert.equal(NATURE_FIELDS.natureRegion.pattern, undefined, '地区刻意不穷举、不校验');
});

test('hasNatureVocabulary / natureValuesOf：只有分类有受控取值（= Trie 里所有路径）', () => {
    assert.equal(hasNatureVocabulary('natureClass'), true);
    assert.equal(hasNatureVocabulary('natureYear'), false);
    assert.equal(hasNatureVocabulary('natureRegion'), false);
    assert.deepEqual(natureValuesOf('natureClass'), CLASS_PATHS.map(p => p.value));
    assert.deepEqual(natureValuesOf('natureYear'), []);
    natureValuesOf('natureClass').push('我不该出现');
    assert.equal(CLASS_PATHS.some(p => p.value === '我不该出现'), false, '返回的是拷贝');
});

test('isKnownNatureValue：分类走 Trie；年份/地区永远 false（它们没有穷举词表）', () => {
    assert.equal(isKnownNatureValue('natureClass', 'xcpc/icpc'), true);
    assert.equal(isKnownNatureValue('natureClass', 'xcpc/nope'), false);
    assert.equal(isKnownNatureValue('natureClass', ''), false);
    assert.equal(isKnownNatureValue('natureYear', '2025'), false, '年份只有格式，没有词表');
    assert.equal(isKnownNatureValue('natureRegion', '成都'), false, '地区是自由值');
});

test('collectNatureValues / natureLabel', () => {
    const nodes = [
        { natureClass: 'xcpc/icpc', natureYear: '2025' },
        { natureClass: 'cf/contest/div2', natureYear: '2025' },
        { natureClass: 'xcpc/icpc' },
        { natureClass: '' }
    ];
    assert.deepEqual(collectNatureValues(nodes, 'natureClass'), ['xcpc/icpc', 'cf/contest/div2']);
    assert.deepEqual(collectNatureValues(nodes, 'natureYear'), ['2025']);
    assert.deepEqual(collectNatureValues([], 'natureClass'), []);
    assert.equal(natureLabel('natureClass', 'cf/contest/div2'), 'cf / contest / div2');
    assert.equal(natureLabel('natureYear', '2025'), '2025');
    assert.equal(natureLabel('natureClass', '', '没标分类'), '没标分类', '空值走兜底文案');
});

test('natureComboOf：两边都非空才比；分类按**前缀**算"同一性质"', () => {
    const a = natureComboOf({ natureClass: 'xcpc/icpc', natureYear: '2025' });
    assert.equal(a.natureClass, 'xcpc/icpc');
    assert.equal(a.matches({ natureClass: 'xcpc/icpc', natureYear: '2025' }), true);
    assert.equal(a.matches({ natureClass: 'xcpc/icpc' }), true, '对方没标年份 ⇒ 不否决');
    assert.equal(a.matches({ natureClass: 'cf' }), false, '不同支 ⇒ 不是同一性质');
    assert.equal(a.matches({ natureClass: 'xcpc/icpc/ec' }), true,
        '同一支的更深处 ⇒ 算同一性质（前缀匹配）');
    assert.equal(a.matches({ natureClass: 'xcpc/ccpc' }), false, '同一根的兄弟支 ⇒ 不算');
    assert.equal(a.matches({ natureYear: '2024' }), false, '年份不同 ⇒ 不算');
});

test('`无归类` 是合法值，且和"没标"是两件事', () => {
    assert.equal(CLASS_NONE, '无归类');
    assert.equal(isKnownClassPath(CLASS_NONE), false, '它本身不是根，得带上前面的段');
    assert.equal(isKnownClassPath('cf/contest/others/无归类'), true);
    assert.equal(isKnownClassPath(''), false);
    assert.notEqual(normalizeNatureValue('natureClass', 'cf/contest/others/无归类'), '',
        '`无归类` 是"判过了"，不是"还没标"');
});

test('`isNatureSeason`：`20xx`；**`无` 也算合法**（没有赛季概念的那些比赛）', () => {
    assert.equal(isNatureSeason('2024'), true);
    assert.equal(isNatureSeason('无'), true, 'CF 单场 / AtCoder 那种：赛季 = 「无」= 不适用');
    assert.equal(isNatureSeason('26'), false);
    assert.equal(isNatureSeason('2024年'), false);
    assert.equal(isNatureSeason(''), false, '空 = 还没标（与「无」是两件事）');
});

test('★ 占位取值「待同步」「不确定」：两个字段都能存，但**都不是年份**', () => {
    // "另外，年份/赛季提供『待同步』『不确定』选项，以后有用"
    assert.deepEqual([...NATURE_PENDING_VALUES], ['待同步', '不确定']);
    assert.equal(NATURE_SEASON_NONE, '无');
    for (const v of NATURE_PENDING_VALUES) {
        assert.equal(isNatureYear(v), true, `${v} 是合法年份值（存得下）`);
        assert.equal(isNatureSeason(v), true, `${v} 是合法赛季值（存得下）`);
        assert.equal(isRealYear(v), false, `★ 但 ${v} **不是年份**（排序/推荐都不许用它）`);
    }
    assert.equal(isRealYear('2025'), true);
    assert.equal(isRealYear(' 2025 '), true);
    for (const bad of ['', '无', '26', '2025年', null, undefined]) {
        assert.equal(isRealYear(bad), false, `${bad} 不该算真年份`);
    }
    // 输入框的候选提示（只提示，不禁手输）
    assert.deepEqual(natureInputSuggestions('natureYear'), ['无', '待同步', '不确定']);
    assert.deepEqual(natureInputSuggestions('natureSeason'), ['无', '待同步', '不确定']);
    assert.deepEqual(natureInputSuggestions('natureClass'), [], '分类的候选是 Trie，走下拉');
    // 地区：四个"不是地名但合法"的值——
    // `无` = 没有场地（网络赛）；`待填写` = 这一维暂时由人填（UC / 总决赛 / 女生·高职专场，
    // **但算填过了**）；`不需要` = 这一维对这类比赛不值得记（国外英文地名）；
    // `不知道` = **人工填的**（管线不产出；手填出来的，比如"中国多省赛"）。
    // ⚠️ 顺序**跟着 `NATURE_NOT_APPLICABLE.natureRegion` 走**（候选是从那张表派生的，
    //    不各写一份 —— 这一维的**成员**才是契约，顺序只是展示）。
    assert.deepEqual(natureInputSuggestions('natureRegion'), ['无', '不需要', '待填写', '不知道']);
    assert.equal(NATURE_REGION_NONE, '无');
    assert.equal(NATURE_REGION_TBD, '待填写');
    assert.equal(NATURE_REGION_NOT_NEEDED, '不需要');
    assert.equal(NATURE_REGION_UNKNOWN, '不知道');
    // 注册表里的格式（唯一真源）
    assert.equal(NATURE_YEAR_PATTERN, '^(20\\d{2}|无|待同步|不确定|上游异常)$');
    assert.equal(NATURE_SEASON_PATTERN, '^(20\\d{2}|无|待同步|不确定|上游异常)$');
    // 年份也允许 `无`（"ucup 的年份也填无吧"），但它**不是年份**
    assert.equal(isNatureYear(NATURE_YEAR_NONE), true);
    assert.equal(isRealYear(NATURE_YEAR_NONE), false, '`无` 永远不能当年份用（排序/推荐）');
});

test('`isCompleteClassPath`：只有**落在 Trie 叶子**上的分类才算"填好了"', () => {
    // "nature 的分类字段，只有在 Trie 树的叶子节点时才被视为填好"
    // + "到某位的『无归类』也算叶子"。
    for (const leaf of ['cf/contest/div2', 'cf/contest/div1+2', 'cf/contest/edu',
                        // `cf/gyms` 也细分了（A 方案 ⇒ 下面镜像整棵 xcpc 子树）
                        'cf/gyms/无归类', 'cf/gyms/ucup',
                        'cf/gyms/xcpc/icpc/ec/regional/official', 'cf/gyms/xcpc/ccpc/final/official',
                        'cf/gyms/xcpc/provincial&invitational/无/省赛/official',
                        'cf/contest/others/team', 'cf/contest/others/无归类',
                        'xcpc/无归类', 'xcpc/icpc/ec/pre/official', 'xcpc/icpc/ec/pre/warm-up',
                        'xcpc/ccpc/final/official', 'xcpc/provincial&invitational/IC/省赛/official',
                        'atcoder/abc', 'qoj/无归类', 'nk/多校', 'hdu/无归类', 'pta/无归类']) {
        assert.equal(isCompleteClassPath(leaf), true, `${leaf} 是叶子 ⇒ 算填好`);
    }
    // ⚠️ 停在中间：值**合法**（可以存），但**不算填好**
    //    —— `xcpc/icpc/ec/pre`、`xcpc/ccpc/final` 这些是"中间"
    //    （它们下面还有 official/warm-up 那一层）
    for (const prefix of ['', 'xcpc', 'xcpc/icpc', 'xcpc/icpc/ec', 'xcpc/ccpc', 'cf', 'cf/contest',
                          'cf/contest/others', 'xcpc/icpc/ec/pre', 'xcpc/ccpc/final',
                          'cf/gyms', 'cf/gyms/xcpc', 'cf/gyms/xcpc/icpc',
                          'atcoder', 'nk', 'qoj']) {
        assert.equal(isCompleteClassPath(prefix), false, `${prefix || '（空）'} 不是叶子 ⇒ 没填好`);
        assert.equal(classPathProblem(prefix), '', '⚠️ 但它**仍然是合法值**（"停在哪一层"是信息）');
    }
    // 不在 Trie 里的值（`cf/无归类`）不算填好 ⇒ 会回到 ③ 让人看见、清掉
    assert.equal(isCompleteClassPath('cf/无归类'), false, '不在 Trie 里的值不算填好');
    assert.equal(isCompleteClassPath('codeforces'), false);
    assert.equal(isCompleteClassPath(null), false);
    assert.equal(isCompleteClassPath(['cf', 'contest', 'div2']), true, '列表形态也认');
});

// ----------------------------------------------------------------
// 这一条是**给浏览器兜底**的：前端是"无构建的静态 ES module"，任何 `import … from 'node:*'`
// 在浏览器里都会以 "Cross origin requests are only supported for protocol schemes…" 炸掉整页
// 实际踩到：`natureFields.js` 顶层 `import { readFileSync } from 'node:fs'`）。
// 所以要读注册表的模块只能**在 Node 分支里动态 import**。这里把这条规矩钉成断言。
// ----------------------------------------------------------------
test('src/ 里不许顶层 import node:*（浏览器加载不了；要读文件就 Node 分支里动态 import）', () => {
    const SRC = path.resolve(HERE, '..');
    const offenders = [];
    const walk = (dir) => {
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, ent.name);
            if (ent.isDirectory()) {
                if (ent.name === 'test' || ent.name === 'node_modules') continue;  // 测试跑在 Node 里，随便用
                walk(p);
                continue;
            }
            if (!ent.name.endsWith('.js')) continue;
            fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
                if (/^\s*import\s[^;]*from\s+['"]node:/.test(line)) {
                    offenders.push(`${path.relative(SRC, p)}:${i + 1}`);
                }
            });
        }
    };
    walk(SRC);
    assert.deepEqual(offenders, [],
        '这些文件在浏览器里会整个加载失败（改成 `const { x } = await import(\'node:…\')`）');
});

// ----------------------------------------------------------------
// 为什么必须现取：浏览器会把 `nature-registry.json` 缓存住，应用拿缓存里的 Trie 判"到没到叶子"——
// `cf/contest/div1` 与 `xcpc/…/official` / `…/warm-up` 会被**判成「停在半路，没到叶子」**（蓝色）。
// 注册表是**唯一真源**且只有几 KB ⇒ 必须每次现取。这条把它钉死。
// ----------------------------------------------------------------
//: 取 `fetch(REGISTRY_URL, <init>)` 里的 init 表达式（按**括号配平**，不受逗号/换行/`)` 干扰）
function fetchInitOf(src) {
    const at = /fetch\(\s*REGISTRY_URL\s*,/.exec(src);
    if (!at) return null;
    let i = at.index + at[0].length;
    while (/\s/.test(src[i])) i += 1;
    if (src[i] !== '{') return src.slice(i, src.indexOf('\n', i));      // 不是字面量 init
    let depth = 0;
    for (let j = i; j < src.length; j += 1) {
        if (src[j] === '{') depth += 1;
        else if (src[j] === '}') { depth -= 1; if (depth === 0) return src.slice(i, j + 1); }
    }
    return null;
}

/**
 * 读注册表那次 `fetch` 的 `cache` 取值（没有这次 fetch / 没写 cache ⇒ null）。
 *
 * ⚠️ 判据要**解析取值**而不是匹配字面量（只认
 * `cache: 'no-store'` 那串字时，把常量写进去 —— `const CACHE_OPT = 'no-store'; … cache: CACHE_OPT`
 * —— 就照绿）。字面量与**同文件常量**都解析得出来；解不出的表达式会返回一句说明
 * （不是 null）⇒ 断言仍然红，并告诉你写法变了要同步。
 */
function cacheOptionOf(src) {
    const init = fetchInitOf(src);
    if (!init) return null;
    const m = /cache\s*:\s*([^,}]+)/.exec(init);
    if (!m) return null;                                   // 压根没写 cache ⇒ 会被浏览器缓存
    const raw = m[1].trim();
    const lit = /^(['"])(.*)\1$/.exec(raw);
    if (lit) return lit[2];
    const def = new RegExp(`(?:const|let|var)\\s+${raw}\\s*=\\s*['"]([^'"]+)['"]`).exec(src);
    return def ? def[1] : `（解不出的表达式 ${raw}）`;
}

test('注册表在浏览器里必须**绕过 HTTP 缓存**（否则新分类会被旧 Trie 判成"没到叶子"）', () => {
    const src = fs.readFileSync(path.join(HERE, '..', 'core', 'natureFields.js'), 'utf8');
    assert.ok(fetchInitOf(src), '找得到读注册表的那个 fetch');
    assert.equal(cacheOptionOf(src), 'no-store',
        "注册表的 fetch 必须带 `cache: 'no-store'`（浏览器缓存旧注册表 ⇒ 新分类显示成\"停在半路\"）");
    // ★ 自检：字面量 / 同文件常量都要认，缺 cache 或写别的值都要报出来
    assert.equal(cacheOptionOf("await fetch(REGISTRY_URL, { cache: 'no-store' });"), 'no-store');
    assert.equal(cacheOptionOf('await fetch(REGISTRY_URL, { cache: "no-store" });'), 'no-store', '双引号');
    assert.equal(cacheOptionOf("const CACHE_OPT = 'no-store';\nawait fetch(REGISTRY_URL, { cache: CACHE_OPT });"),
        'no-store', '★ 抽成常量也要认（只认字面量时这种照绿）');
    assert.equal(cacheOptionOf('await fetch(REGISTRY_URL, { mode: "cors" });'), null, '没写 cache ⇒ null');
    assert.equal(cacheOptionOf("await fetch(REGISTRY_URL, { cache: 'default' });"), 'default', '别的取值要报出来');
    assert.equal(cacheOptionOf('const o = { cache: "force-cache" };\nawait fetch(REGISTRY_URL, o);'), null,
        'init 不是字面量 ⇒ 判据兜不住，靠上面那条"找不到 fetch"报红');
});

// ================================================================
// ★ 「确定不用」白名单（口径："应该引入：1.『确定 nature 的该项不用的字段白名单』
//    （如 地点-`不需要`、年份-`待同步` 等）…确定不用是一种特殊的已填，颜色为灰；
//    判定冲突时，**自动忽略灰色项**（与自动忽略 C 即以下并行）"）
// ================================================================
test('「确定不用」白名单：每维一组，分类那一维**没有**', () => {
    assert.deepEqual([...NATURE_NOT_APPLICABLE.natureYear], ['无', '待同步', '不确定', '上游异常']);
    assert.deepEqual([...NATURE_NOT_APPLICABLE.natureSeason], ['无', '待同步', '不确定', '上游异常']);
    assert.deepEqual([...NATURE_NOT_APPLICABLE.natureRegion],
        ['无', '不需要', '待填写', '不知道', '上游异常']);
    assert.deepEqual([...NATURE_NOT_APPLICABLE.natureClass], [],
        '★ 分类没有"不用"：`无归类` 是"判过了但归不进去"——那是结论，不是不适用');
});

test('isNotApplicableValue：按字段判；真值/空都不算灰', () => {
    assert.equal(isNotApplicableValue('natureYear', '待同步'), true);
    assert.equal(isNotApplicableValue('natureYear', '无'), true);
    assert.equal(isNotApplicableValue('natureRegion', '不需要'), true);
    assert.equal(isNotApplicableValue('natureRegion', '香港'), false);
    assert.equal(isNotApplicableValue('natureYear', '2024'), false);
    assert.equal(isNotApplicableValue('natureYear', ''), false, '空 = 还没判（不是"不用"）');
    // ★ 分类这一维**以 `无归类` 结尾**就是灰（结论）；`未归类` 不算灰（蓝、等人补）
    assert.equal(isNotApplicableValue('natureClass', 'xcpc/无归类'), true, '无归类 = 结论 ⇒ 灰');
    assert.equal(isNotApplicableValue('natureClass', 'xcpc/ccpc/无归类'), true, '任何层级的 无归类 都算');
    assert.equal(isNotApplicableValue('natureClass', 'xcpc/provincial&invitational/未归类'), false,
        '★ 未归类 = 自动判不出 ⇒ 蓝（填写不完全），不是灰');
    assert.equal(isNotApplicableValue('不存在的字段', '无'), false, '不认识字段 ⇒ 一律 false');
});

test('★ `未归类`（蓝、填写不完全）与 `无归类`（灰、特殊已填）分得开', () => {
    assert.equal(CLASS_PENDING, '未归类');
    assert.equal(CLASS_NONE, '无归类');
    assert.equal(isKnownClassPath('xcpc/provincial&invitational/未归类'), true, '两个值都在 Trie 里');
    assert.equal(isCompleteClassPath('qoj/无归类'), true, '`无归类` = 判过了 ⇒ 算填好（灰）');
    assert.equal(isCompleteClassPath('xcpc/provincial&invitational/未归类'), false,
        '★ `未归类` = 判不出 ⇒ **不算**填好（蓝、回 ③）');
    assert.equal(isKnownClassPath('qoj/未归类'), false,
        '★ 只有**省赛那一支**有 `未归类`（其余判不出一律 `无归类`）');
});

// ================================================================
// ★ "像「获取数据失败」这种**上游异常**的情况，nature 可以用「上游异常」（灰）补充"
// ================================================================
test('`上游异常`：灰（特殊已填）+ 算填好 + 四个字段都认', () => {
    assert.equal(CLASS_UPSTREAM, '上游异常');
    assert.equal(isKnownClassPath('qoj/xcpc/provincial&invitational/上游异常'), true, '分类里它是 Trie 上的段');
    assert.equal(isCompleteClassPath('qoj/xcpc/provincial&invitational/上游异常'), true,
        '★ 上游异常 = 判不了 ⇒ **算填好**（灰），不进 ③ 等人白补');
    assert.equal(isNotApplicableValue('natureClass', 'qoj/xcpc/provincial&invitational/上游异常'), true,
        '★ 判冲突时当作没有主张');
    assert.equal(isNotApplicableValue('natureYear', '上游异常'), true, '年份也认');
    assert.equal(isNotApplicableValue('natureSeason', '上游异常'), true, '赛季也认');
    assert.equal(isNotApplicableValue('natureRegion', '上游异常'), true, '地区也认');
    assert.equal(isNatureYear('上游异常'), true, '注册表的年份取值白名单收它（`crate.py` 才不会拒）');
});
