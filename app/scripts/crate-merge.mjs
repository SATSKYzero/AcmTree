#!/usr/bin/env node
// ================================================================
// 导入包合并器（scripts/crate-merge.mjs）
//
// 职责：把**多个数据脚本产出**的 crate 合并成一份，并做**离线体检**。
//
// 它做什么：
//   1. 合并 records（按 extKey 去重；冲突则报告）
//   2. 合并 fieldMap / fieldPolicies
//   3. 体检：跨包 extKey 冲突（类型/父不同、字段值不同）、包内重复、
//      父引用断链、父子类型非法、成环、extKey 格式可疑
//
// 它**不**做什么（刻意的）：
//   - **不对账**。哪些是"新增/更新/跳过"，那是应用预览的权威结论 ——
//     因为树状态在浏览器 IndexedDB 里，命令行读不到。
//     本脚本只保证"合并出来的包本身是自洽的"。
//   - **不规定 extKey 命名**。那是各数据脚本与骨架脚本之间自行对齐的事，
//     主脚本不承担命名权威（否则各平台就没自由度了）。
//   - 不碰应用数据，纯读文件 + 写文件。
//
// 用法：
//   node scripts/crate-merge.mjs a.json b.json -o merged.json
//   npm run crate:merge -- a.json b.json -o merged.json
//   node scripts/crate-merge.mjs *.json -o merged.json --strict   # 有问题则退出码 1
//   node scripts/crate-merge.mjs a.json b.json --report report.json
// ================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mod = rel => `file://${path.join(ROOT, 'src', rel).replace(/\\/g, '/')}`;

/** 「应有」注册表（真源；随包发布，见下面 `out.fieldRegistry` 那段） */
const FIELD_REGISTRY_PATH = path.join(ROOT, 'acm-data', 'field-registry.json');

// 复用应用自己的解析/校验（结论与导入时一致）
const { parseCrate } = await import(mod('features/AutoImport/parse.js'));
// 「真年份」的判据也复用应用那份（`待同步`/`不确定`/`无`/空 都不算）—— 见下面合并那一段
const { isRealYear } = await import(mod('core/natureFields.js'));

// 同层顺序（`越新的越靠上`）：与应用侧**同一份**实现，见那个模块的文件头
const { treeOrder } = await import(mod('core/siblingOrder.js'));

// ---- 与应用一致的类型约束（真源：core/model/constants.js + A_constants.js）----
const { badParentTypeMessage } = await import(mod('core/model/constants.js'));
const { TYPE_LABEL_MAP } = await import(mod('A_constants.js'));

/** 可以由导入写入的内部字段（真源：features/AutoImport/constants.js） */
const { WRITABLE_FIELDS } = await import(mod('features/AutoImport/constants.js'));

// 链接分类的**并集**：与应用侧「组值」的链接聚合器共用同一份实现（`core/linkKinds.js`）
const { mergeLinkKinds } = await import(mod('core/linkKinds.js'));

const WRITABLE = new Set(WRITABLE_FIELDS);
const MAX_EXT_KEY_LENGTH = 200;

// ================================================================
// 参数
// ================================================================
const argv = process.argv.slice(2);
const inputs = [];
let outFile = '';
let reportFile = '';
let inputsFile = '';
let strict = false;
let quiet = false;

for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o' || a === '--out') { outFile = argv[++i] || ''; }
    else if (a === '--report') { reportFile = argv[++i] || ''; }
    // 片段多到**命令行放不下**时（实测：470 个片段 × 绝对路径 > Windows 上限，
    // 报 `WinError 206 文件名或扩展名太长`），用 `--inputs-file` 传一份清单文件：
    // 一行一个片段路径（`#` 开头的行忽略）。
    else if (a === '--inputs-file') { inputsFile = argv[++i] || ''; }
    else if (a === '--strict') { strict = true; }
    else if (a === '--quiet') { quiet = true; }
    else if (a.startsWith('-')) { console.error(`未知参数：${a}`); process.exit(2); }
    else inputs.push(a);
}

// `--inputs-file`：把清单里的路径并进来（命令行放不下时的通道）
if (inputsFile) {
    let text = '';
    try {
        text = fs.readFileSync(inputsFile, 'utf8');
    } catch (e) {
        console.error(`读不了输入清单 ${inputsFile}：${e.message}`);
        process.exit(2);
    }
    for (const line of text.split(/\r?\n/)) {
        const p = line.trim();
        if (p && !p.startsWith('#')) inputs.push(p);
    }
}

if (inputs.length === 0) {
    console.error('用法: node scripts/crate-merge.mjs <crate.json> [更多.json ...] -o merged.json');
    console.error('     [--inputs-file 清单.txt] [--report report.json] [--strict] [--quiet]');
    process.exit(2);
}
if (!outFile) {
    console.error('必须用 -o <文件> 指定输出路径（不覆盖输入文件）');
    process.exit(2);
}
if (inputs.includes(outFile)) {
    console.error('输出文件不能与输入文件同名（会覆盖原始数据）');
    process.exit(2);
}

// ================================================================
// 收集问题
// ================================================================
const problems = [];   // { level:'error'|'warn', file, code, message }
const addProblem = (level, file, code, message) => problems.push({ level, file, code, message });
const err = (file, code, msg) => addProblem('error', file, code, msg);
const warn = (file, code, msg) => addProblem('warn', file, code, msg);

/** 报告里只显示文件名 —— 绝对路径会把消息挤得没法读 */
const shortName = f => (f ? path.basename(String(f)) : '(合并后)');

// ================================================================
// 读取并解析每个输入
// ================================================================
const sources = [];    // { file, crate }
for (const f of inputs) {
    if (!fs.existsSync(f)) {
        err(f, 'missing-file', `文件不存在：${f}`);
        continue;
    }
    let raw;
    try {
        // 去掉 UTF-8 BOM：Windows 上的 PowerShell / 记事本 / 部分导出工具
        // 会写入 BOM，而 JSON.parse 会被它噎住（报 "Unexpected token"）。
        // 这与数据本身无关，属于读取层的兼容处理。
        const text = fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '');
        raw = JSON.parse(text);
    } catch (e) {
        err(f, 'bad-json', `JSON 解析失败：${e.message}`);
        continue;
    }
    const parsed = parseCrate(raw);
    if (!parsed.ok || !parsed.crate) {
        err(f, 'parse-failed', `解析失败（整包级）：${parsed.errors.map(e => e.message).join('；')}`);
        continue;
    }
    // 逐条解析错误不致命，但必须报出来（否则会静默丢记录）
    for (const e of parsed.errors) {
        err(f, e.code, `第 ${e.index !== undefined ? e.index : '?'} 条：${e.message}`);
    }
    sources.push({ file: f, crate: parsed.crate });
}

if (sources.length === 0) {
    console.error('❌ 没有任何可用的输入文件');
    for (const p of problems) console.error(`   • [${p.code}] ${p.file}: ${p.message}`);
    process.exit(1);
}

if (!quiet) {
    console.log(`\n📦 合并 ${sources.length} 个导入包`);
    for (const s of sources) {
        console.log(`   ${path.basename(s.file)}  —  ${s.crate.records.length} 条记录`
            + (s.crate.source && s.crate.source.id ? `  来源: ${s.crate.source.id}` : ''));
    }
}

// ================================================================
// 合并
// ================================================================

const mergedFieldMap = {};

//: 内部字段名 → 输出用的中文列名（**只此一份**）。
//  合并期要用它查"输入记录自带的 `字段来源`"（`字段来源` 的键是中文列名），
//  序列化期要用它写值 —— 两处各写一份必然对不上（把逐字段来源
//  在第二层合并里盖成 `crate-merge` 的根因就出在这一格的映射上）。
//  放在模块级是因为它被两个作用域用（合并循环 + `serializeRecord`）。
const colOf = internal => Object.keys(mergedFieldMap)
    .find(c => mergedFieldMap[c] === internal && c !== internal && mergedFieldMap[c] !== null)
    || internal;
const mergedFieldPolicies = {};
/** **身份键** → { record, fromFile }（普通节点是 extKey，合成节点是 synthKey） */
const byKey = new Map();

// 一条记录的**身份键**有两种写法，**恰好给一个**：
//   · `extKey`   → 普通节点（树上按 extKey 认人）
//   · `synthKey` → **合成节点**（它**没有** extKey，见 docs/manual-workflow.md（合成节点的指针））
//
// ⚠️ 身份键必须走 `identityOf`：写死 `rec.extKey` ⇒ 所有合成节点都成了
//    `extKey: ""` 的**同一批**，于是互相报"字段值不一致"
//    （实测：把 `xcpc-synth.json` 合进混装包时 114 条报错）。
const identityOf = rec => String(rec.synthKey || rec.extKey || '');
const isSynthRec = rec => !!rec.synthKey;

// ---- fieldMap / fieldPolicies（并集；冲突则报告）----
const fieldMapFrom = new Map();      // column → file（首次定义者）
for (const s of sources) {
    const fm = s.crate.fieldMap || {};
    for (const col of Object.keys(fm)) {
        if (Object.prototype.hasOwnProperty.call(mergedFieldMap, col)) {
            const prev = mergedFieldMap[col];
            const next = fm[col];
            if (prev !== next) {
                err(s.file, 'fieldmap-conflict',
                    `列「${col}」映射冲突：${fieldMapFrom.get(col)} 说是 ${JSON.stringify(prev)}，`
                    + `本包说是 ${JSON.stringify(next)}。请统一（否则同名列在不同包里含义不同）`);
            }
            continue;
        }
        mergedFieldMap[col] = fm[col];
        fieldMapFrom.set(col, s.file);
    }

    for (const field of Object.keys(s.crate.fieldPolicies || {})) {
        const v = s.crate.fieldPolicies[field];
        if (Object.prototype.hasOwnProperty.call(mergedFieldPolicies, field)
            && mergedFieldPolicies[field] !== v) {
            warn(s.file, 'policy-conflict',
                `字段「${field}」的合并策略冲突：${mergedFieldPolicies[field]} vs ${v}，保留前者`);
            continue;
        }
        mergedFieldPolicies[field] = v;
    }
}

// ---- records（按 extKey 去重）----
//
// ⚠️ 这里合并的是 parseCrate 产出的**归一化记录**
//    `{ index, type, extKey, parentExtKey, fields, raw }`，
//    而不是 crate 的原始记录。所以：
//      - 身份字段用 `type` / `parentExtKey`（不是 `节点类型` / `父extKey`）
//      - 业务字段只认 `fields`（已按 fieldMap 映射成内部字段名）
//    最后再**序列化回 crate 格式**（见下方"输出"）。
//
//    直接把归一化对象塞进输出，产物里就没有中文列名 ——
//    应用导入后会得到一堆空节点。这是本脚本最危险的一类 bug，
//    由 scripts/smoke/crate-merge.smoke.mjs 钉死。
// 逐字段来源（`字段来源`）：合并时记住"每个字段最后是谁给的"。
// 没有这张表，整包只能共用一个来源 —— 界面上就会显示
// "ratio 与 name 都来自『合并自 3 个包』"，那等于没有出处。
const srcIdOf = s => (s.crate.source && s.crate.source.id) || path.basename(s.file);

// 账户线索（`账户线索` 元列）：这条记录"关于谁"。
// 和 `字段来源` 一样是**记录级元信息**，不属于业务字段，合并时必须单独搬运 ——
// 否则合并产物一落地，归认信息就没了（提交记录尤其会被吃掉）。
const clueOf = rec => {
    const c = rec.raw && typeof rec.raw === 'object' ? rec.raw['账户线索'] : null;
    return (c && typeof c === 'object') ? c : null;
};
const sameClue = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// 链接分类（`链接分类` 元列）：`{ 类别: [url, …] }` —— C 的链接按**用途**记账。
//
// 为什么它是元列而不是业务字段：一条原则 ——
// **"数据爬取部分不应该有『存在多值时排除一些值』的逻辑"**。所以同一个类别有几条
// 就全都留在这儿（爬虫只记录、不取舍），缓存值 `link` 由**应用层**从这里派生。
//
// 因此这里**不能**走下面那个"业务字段先到先得"的循环：那会把后到的来源整个吃掉。
// 各来源的链接必须**并集**。
//
// 入参形状**只有一种**：`{ 类别: [{ v, src }] }` —— 由产出点归一
//（`scripts/crate.py` 的 `Crate._normalize_link_kinds`：裸 URL 也会被补成 `{v, src}`）。
// 这里**不写**"两种形状都认 / 出处回落"那种容错：**归一放产出点，读取端走直路**
//（"数据处理的逻辑中一个特判都没有"）。
const linkKindsOf = rec => {
    const raw = rec.raw && typeof rec.raw === 'object' ? rec.raw['链接分类'] : null;
    return (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : null;
};

// 分类依据（`分类依据` 元列）：`{ 性质字段: 规则id }` —— "这条分类凭什么判出来的"。
//
// 应用侧查**级别表**（`src/core/natureConfidence.js` 的 `CLASS_RULE_LEVEL`）画依据强度徽标，
// 所以这一列必须挺过合并 —— 与 `字段来源` 一样是**元列**（不进业务字段、也不报"未使用列"）。
//
// 口径：**先到先得，缺的补上**（与业务字段同一条路，理由也相同）——
//   分类字段本身在下面走"先到先得 + 其余进 `其它来源值`"，规则必须跟着**那个**值；
//   两个来源都给了规则且不一致时**报一声**（真冲突：同一场被判成两类的依据不同）。
const classRulesOf = rec => {
    const raw = rec.raw && typeof rec.raw === 'object' ? rec.raw['分类依据'] : null;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const out = {};
    for (const field of Object.keys(raw)) {
        const rule = String(raw[field] === undefined || raw[field] === null ? '' : raw[field]).trim();
        if (rule) out[field] = rule;
    }
    return Object.keys(out).length ? out : null;
};

// 链接分类的**并集**实现搬到了 `src/core/linkKinds.js`（判据只有一份）：
//   合并两条**记录**（这里，用 `linkKindsOf(rec)` 取出那份元列）与**组值的链接聚合器**
//   （`core/groupValue.js` 的 `AGG_BUILDERS['链接分类']`）用的是同一个并集口径 ——
//   各留一份迟早漂成"两种去重口径"（症状：同一个 URL 在树上两个一模一样的标签）。
// ⚠️ 入参形状**只有一种**（`{ 类别: [{v, src}] }`，归一在产出点 `scripts/crate.py`）：
//    `linkKindsOf` 只做"是不是个对象"的判断，读取端**不写**出处回落那种容错。

for (const s of sources) {
    const srcId = srcIdOf(s);
    // ⚠️ **输入自己带 `字段来源` 时，逐个字段沿用它**。
    //
    // 为什么：合并是**两层**的（片段 → mix 包 → all_nodes）。第一层已经把"这一格是谁给的"
    // 记成了真实来源（`qoj` / `xcpcio-bjcpc2024` …），可第二层若写成
    // `fieldSrc[f] = srcId`，而 mix 包自己的 `source.id` 是 `crate-merge` ——
    // **于是总包里每一格的来源都被盖成 `crate-merge`**，应用里"按来源设优先级"根本无从谈起。
    // 口径：**已合并过的输入以它自己那份为准**（它更靠内层、更接近原始来源）；
    // 没有那一格的记录（片段级输入）才用输入包的 id。
    const carriedSrcOf = rec => {
        const raw = rec.raw && typeof rec.raw === 'object' ? rec.raw['字段来源'] : null;
        return (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : null;
    };
    for (const rec of s.crate.records) {
        const key = identityOf(rec);           // 普通节点看 extKey，合成节点看 synthKey
        const clue = clueOf(rec);
        const carried = carriedSrcOf(rec);
        if (!byKey.has(key)) {
            // 首次出现：这条记录**自己**定义了它带的所有字段
            const fieldSrc = {};
            for (const f of Object.keys(rec.fields || {})) {
                fieldSrc[f] = (carried && carried[colOf(f)]) || srcId;
            }
            const linkKinds = {};
            mergeLinkKinds(linkKinds, linkKindsOf(rec));
            byKey.set(key, {
                record: rec, file: s.file, fieldSrc, accountClue: clue,
                linkKinds: Object.keys(linkKinds).length ? linkKinds : null,
                classRules: classRulesOf(rec)
            });
            continue;
        }

        // 已存在同 key —— 这**不一定是错**：多个脚本引用同一个容器是正常的。
        // 只有当"身份定义"不一致，或"字段值"互相矛盾时才是问题。
        const prev = byKey.get(key);
        const a = prev.record;
        const b = rec;

        // 账户线索：先到的非空为准；两个包说"关于不同的人"= 真冲突，报出来
        if (clue) {
            if (!prev.accountClue) {
                prev.accountClue = clue;
            } else if (!sameClue(prev.accountClue, clue)) {
                warn(s.file, 'account-clue-conflict',
                    `extKey "${key}" 的账户线索不一致：`
                    + `${JSON.stringify(prev.accountClue)}（来自 ${shortName(prev.file)}）vs `
                    + `${JSON.stringify(clue)}（本包）。**保留前者**`);
            }
        }

        // 链接分类：**并集**（同一场的数据可能分散在多个来源，各自的链接都要留）。
        // 见 `mergeLinkKinds` 的注释 —— 这里刻意不做"先到先得"。
        if (!prev.linkKinds) prev.linkKinds = {};
        mergeLinkKinds(prev.linkKinds, linkKindsOf(rec));
        if (!Object.keys(prev.linkKinds).length) prev.linkKinds = null;

        // 分类依据：**先到先得 + 缺的补上**（与业务字段同一口径 —— 见 `classRulesOf`）。
        // 两个来源都给了、且同字段的规则不一致 ⇒ 报一声（真冲突，不是噪声）。
        const incomingRules = classRulesOf(rec);
        if (incomingRules) {
            if (!prev.classRules) prev.classRules = {};
            for (const field of Object.keys(incomingRules)) {
                if (prev.classRules[field] === undefined) {
                    prev.classRules[field] = incomingRules[field];
                } else if (prev.classRules[field] !== incomingRules[field]) {
                    warn(s.file, 'class-rule-conflict',
                        `extKey "${key}" 的分类依据不一致（字段 ${field}）：`
                        + `${prev.classRules[field]}（来自 ${shortName(prev.file)}）vs `
                        + `${incomingRules[field]}（本包）。**保留前者**`
                        + '（分类值也保留前者，两者必须对得上）');
                }
            }
        }

        if (a.type !== b.type) {
            err(s.file, 'extkey-type-conflict',
                `extKey "${key}" 的类型冲突：${shortName(prev.file)} 说是 `
                + `${TYPE_LABEL_MAP[a.type] || a.type}(${a.type})，本包说是 `
                + `${TYPE_LABEL_MAP[b.type] || b.type}(${b.type})。`
                + '同一个 key 不能既是一个类型又是另一个 —— 请改名其中一个');
            continue;
        }
        if ((a.parentExtKey || '') !== (b.parentExtKey || '')) {
            err(s.file, 'extkey-parent-conflict',
                `extKey "${key}" 的父引用冲突：${shortName(prev.file)} 说父是 `
                + `"${a.parentExtKey || '(根)'}"，本包说是 "${b.parentExtKey || '(根)'}"。`
                + '同一个 key 不能挂在两个不同父下（全局唯一约束）');
            continue;
        }

        // 业务字段：不一致则**保留先到的**并提示（后面的包不覆盖前面的）
        for (const f of Object.keys(b.fields || {})) {
            const prevVal = a.fields ? a.fields[f] : undefined;
            const nextVal = b.fields[f];
            if (prevVal === undefined) {
                if (!a.fields) a.fields = {};
                a.fields[f] = nextVal;      // 先到的没这个字段 → 补上（信息更全）
                prev.fieldSrc[f] = srcId;   // 并记下这个字段是谁给的
                continue;
            }
            // ★ **年份/赛季：真 `20xx` 优先于占位**（实测）：
            //   同一个 extKey 的两份记录，一份手里有**开赛时间**（⇒ 真年份）、另一份只会写
            //   `待同步`（= "值在别处、还没同步过来"，见 `xcpc_nature`）；refs 那份先到 ⇒
            //   "先到先得"就把真年份挡掉了（`aux-rankland:c:ccpc2019qinhuangdao` 实测：
            //   2019.09.22 的日期在 `--role time` 那份里、却被 refs 的 `待同步` 盖掉）。
            //   ⇒ 占位不是"另一个答案"，只是"我这儿没有"：遇到真值就**让位**（反过来不动）。
            if ((f === 'natureYear' || f === 'natureSeason')
                && isRealYear(nextVal) && !isRealYear(prevVal)) {
                a.fields[f] = nextVal;
                prev.fieldSrc[f] = srcId;
                // ⚠️ **依据（`分类依据`）必须跟着值一起换**：那一列的合并是"先到先得"、
                //    跑在这段**之前** ⇒ 不改的话会出现"值是 2019（来自带日期那份）、
                //    依据却是 `…:year-tbd`（来自占位那份）"—— 徽标会显示 D、报警门槛也会
                //    把它当低可信（实测逮到：`aux-rankland:c:ccpc2019qinhuangdao`）。
                if (incomingRules && incomingRules[f]) prev.classRules[f] = incomingRules[f];
                if (prev.otherValues && prev.otherValues[f]) {
                    // 被让位的那份占位值留进「其它来源值」（来源面板仍看得到），但不再是主值
                    prev.otherValues[f] = prev.otherValues[f].filter(x => x.v !== prevVal);
                }
                continue;
            }
            if (JSON.stringify(prevVal) !== JSON.stringify(nextVal)) {
                // 同字段两个来源给了不同的值：**保留前者**（先到先得），但后者不能丢 ——
                // 应用的来源层是"每个值都记出处"的，丢了它，来源面板就永远看不到第二个链接。
                // 所以把它记进 `其它来源值`，应用会按**各自来源**写进来源层（不进缓存字段）。
                if (!prev.otherValues) prev.otherValues = {};
                if (!prev.otherValues[f]) prev.otherValues[f] = [];
                prev.otherValues[f].push({ v: nextVal, src: srcId });
                warn(s.file, 'field-value-conflict',
                    `extKey "${key}" 的字段「${f}」值不一致：`
                    + `${JSON.stringify(prevVal)}（来自 ${shortName(prev.file)}）vs `
                    + `${JSON.stringify(nextVal)}（本包）。**保留前者**，`
                    + `后者记进「其它来源值」供来源面板查看`);
            }
        }
    }
}

// ---- 体检：父引用 / 类型 / 环 / 格式 ----
const records = [...byKey.values()].map(v => v.record);
const owner = new Map([...byKey.entries()].map(([k, v]) => [k, v.file]));
for (const rec of records) {
    const key = identityOf(rec);
    const file = owner.get(key) || '(合并后)';

    // 格式可疑（与应用侧同一套判据）—— **按身份键各自的规矩查**：
    // `extKey` 查长度与全角；`synthKey` 查长度与保留前缀（`synth:` 是自动生成那套的记号）。
    if (key.length > MAX_EXT_KEY_LENGTH) {
        warn(file, 'suspicious-format', `身份键过长（>${MAX_EXT_KEY_LENGTH}）：${key}`);
    }
    if (isSynthRec(rec)) {
        if (!key.startsWith('synth:')) {
            warn(file, 'suspicious-format', `合成标识没有保留前缀 synth:：${key}`);
        }
    } else if (/[\uFF00-\uFFEF]/.test(key)) {
        warn(file, 'suspicious-format', `extKey 含全角字符：${key}（肉眼几乎看不出，建议改半角）`);
    }

    // ---- 父引用体检：**两种写法都认**（`父extKey` = 父是普通节点；`父synthKey` = 父是合成节点）----
    //   ⚠️ 身份键表 `byKey` 两种都收（`identityOf` = synthKey||extKey）⇒ 自指 / 不在包内 / 类型
    //      三条判定对两种写法**走同一条路**。只认 `父extKey` 会把合成父那一半整条判据**静默漏掉**
    //      （实测：`{synthKey:"synth:x", 父synthKey:"synth:不存在"}` 合并退出码 0、零提示）。
    const parentCol = rec.parentSynthKey ? '父synthKey' : (rec.parentExtKey ? '父extKey' : '');
    const parent = String((parentCol === '父synthKey' ? rec.parentSynthKey : rec.parentExtKey) || '');
    if (parent) {
        if (parent === key) {
            err(file, 'self-reference', `"${key}" 的 ${parentCol} 指向自己`);
        } else if (!byKey.has(parent)) {
            // 父不在**这几份包**里 —— 要么已在主树上（正常），要么真的断链。
            // ⚠️ 用**应用侧的同一个原因码**（`parent-not-found`，见 `features/AutoImport/resolve.js`
            //    与落地时的 `core/ops/upsert.js`）：这是**同一件事**，两边叫法必须一样，
            //    否则爬虫作者在"合并"与"试跑"两个脚本上看到两个词。
            //    这里只**提示**不判错：本脚本只看这几份包，看不见主树（主脚本又不对账）⇒
            //    当成错误会把"父已在树上"这种正常情况也拦下。试跑（带 `--tree`）才判得准。
            warn(file, 'parent-not-found',
                `"${key}" 的 ${parentCol} "${parent}" 不在本包内。`
                + '若它已在主树上则正常；否则导入时该条会被拒绝（parent-not-found）');
        } else {
            const p = byKey.get(parent).record;
            // ⚠️ 这句话**不在这里拼**：判据（`TYPE_CHILDREN_MAP`）与说法同处一源
            //    （`core/model/constants.js` 的 `badParentTypeMessage`）—— 应用侧预览
            //    （`features/AutoImport/plan.js`）、合成节点那一侧与落地（`core/ops/upsert.js`）
            //    读的是**同一句**。**不传标签**：有的入口传中文、有的传类型字母，同一个包
            //    就会看到两句话（实测踩到）。
            const msg = badParentTypeMessage(p.type, rec.type, {
                parentKey: parent, childKey: key, parentCol
            });
            if (msg) err(file, 'bad-parent-type', msg);
        }
    }

    // 派生字段不可写（写了也会被应用忽略 → 提前告知，避免白忙）
    // 注意用的是归一化后的 `fields`（已按 fieldMap 映射成内部字段名），
    // 不是原始列名 —— 判断"是否可写"必须在内部分名字上做。
    for (const f of Object.keys(rec.fields || {})) {
        if (!WRITABLE.has(f)) {
            warn(file, 'not-writable',
                `extKey "${key}" 的字段「${f}」不可由导入写入 ——`
                + '导入时会被忽略（派生字段由应用自动推导）');
        }
    }
}

// ---- 成环 ----
// ⚠️ 父引用**两种写法都走**（与上面那三条判定同一口径）：只跟 `父extKey` 会漏掉合成父成环。
for (const start of byKey.keys()) {
    const seen = new Set();
    let cur = start;
    while (cur && !seen.has(cur)) {
        seen.add(cur);
        const r = byKey.get(cur);
        cur = r ? (r.record.parentExtKey || r.record.parentSynthKey || '') : '';
    }
    if (cur && cur === start) {
        err(owner.get(start) || '(合并后)', 'parent-cycle',
            `父引用成环：extKey "${start}" 的父链回到自身`);
    }
}

// ================================================================
// 输出
// ================================================================

// ================================================================
// 让合并结果**自描述**：为实际用到的内部字段补上恒等映射
//
// 为什么必须做：serializeRecord 只能写出"fieldMap 声明过的列"。
// 若某个内部字段没有对应的声明列（例如上游包声明了 `题号→problemId`，
// 但数据实际写在 `problemId` 列上），它就会被**静默丢掉** ——
// 产物看着正常，导入后却是空字段。
//
// 补恒等映射后，产物自带说明：`{ name:'name', problemId:'problemId' }`，
// 无论上游怎么命名都能安全往返。
// ================================================================
{
    const used = new Set();
    for (const v of byKey.values()) {
        for (const f of Object.keys(v.record.fields || {})) used.add(f);
    }
    for (const f of used) {
        if (!Object.prototype.hasOwnProperty.call(mergedFieldMap, f)) {
            mergedFieldMap[f] = f;         // 恒等映射
        }
    }
}

// ================================================================
// 序列化回 crate 格式
//
// ⚠️ 关键一步：上面合并的是 parseCrate 的**归一化记录**
//    （`type` / `parentExtKey` / `fields`），而导入包要的是
//    **crate 格式**（`节点类型` / `父extKey` / 业务字段直接摊平在记录上）。
//    漏了这一步，产物虽然"看起来像 crate"，但里面没有可识别的字段名，
//    应用导入后会得到一堆空节点 —— 这是本脚本最危险的 bug。
// ================================================================
function serializeRecord(entry) {
    const rec = entry.record;
    // 身份键**按各自写法输出**：合成节点写 `synthKey`（**不能**同时写 extKey ——
    // 应用侧 `_add`/`plan.js` 对"两个都有"是整条拒绝）。
    const out = isSynthRec(rec)
        ? { '节点类型': rec.type, synthKey: rec.synthKey }
        : { '节点类型': rec.type, extKey: rec.extKey };
    if (rec.parentExtKey) out['父extKey'] = rec.parentExtKey;
    // 父是**合成节点**时用 `父synthKey`（第二种父引用写法）
    if (rec.parentSynthKey) out['父synthKey'] = rec.parentSynthKey;

    const fm = rec.fields || {};
    // 内部字段名 → 输出用的列名：用**模块级那一份** `colOf`（见上面的定义 ——
    // 合并期查"输入自带的字段来源"用的是同一个映射，两处各写一份必然对不上）。

    for (const internal of Object.keys(fm)) {
        const value = fm[internal];
        if (value === undefined) continue;
        out[colOf(internal)] = value;
    }

    // 逐字段来源（`字段来源`）：`{ 列名: 来源id }`。
    // 应用侧把它当**元列**（不进业务字段、也不报"未使用列"），
    // 逐字段记进来源层 —— 这样界面上才会显示"ratio 来自 PTA、name 来自 rankland"。
    const fieldSrc = entry.fieldSrc || {};
    const srcOut = {};
    for (const internal of Object.keys(fieldSrc)) {
        if (!(internal in fm)) continue;
        srcOut[colOf(internal)] = fieldSrc[internal];
    }
    if (Object.keys(srcOut).length) out['字段来源'] = srcOut;

    // 落选值：同字段多个来源各说各话时，除"保留的那个"以外都记在这里 ——
    // `{ 列名: [{ v: 值, src: 来源id }] }`。应用按**各自来源**把它们写进来源层
    // （`recordIncoming` 是逐值写入的），所以来源面板能看到"这题的链接 CF 说一个、QOJ 说一个"，
    // 而缓存字段仍是保留的那个（口径不变）。
    const other = entry.otherValues || {};
    const otherOut = {};
    for (const internal of Object.keys(other)) {
        const list = Array.isArray(other[internal]) ? other[internal] : [];
        if (!list.length) continue;
        otherOut[colOf(internal)] = list.map(x => ({ v: x.v, src: x.src }));
    }
    if (Object.keys(otherOut).length) out['其它来源值'] = otherOut;

    // 账户线索：原样搬运（应用只查映射表，不解释这些字段的含义）
    if (entry.accountClue) out['账户线索'] = entry.accountClue;

    // 链接分类：`{ 类别: [{ v, src }] }` —— 全量候选链接（不取舍）。
    // 应用层从这里派生缓存值 `link`（按类别优先级），其余类别也在树上按类别显示。
    if (entry.linkKinds && Object.keys(entry.linkKinds).length) {
        out['链接分类'] = entry.linkKinds;
    }

    // 分类依据：`{ 性质字段: 规则id }` —— "这条分类凭什么判出来的"。
    // ⚠️ 键是**内部字段名**（`natureClass`），不是输出列名（`分类`）：应用读的就是它
    //    （`core/natureConfidence.js` 的 `classLevelOf`），两边不许各写一份口径。
    // ⚠️ 只写**真的落在记录上**的那些字段（`fm`）：某个包里给了规则、字段却被策略挡下
    //    （值取的是别人的）⇒ 那条规则描述的不是这个值，不能落。
    const rules = entry.classRules || {};
    const rulesOut = {};
    for (const internal of Object.keys(rules)) {
        if (!(internal in fm)) continue;
        rulesOut[internal] = rules[internal];
    }
    if (Object.keys(rulesOut).length) out['分类依据'] = rulesOut;
    return out;
}

// ⚠️ 这里要传**条目**（`{record, file, fieldSrc}`）而不是 `records` 里的裸记录 ——
//    逐字段来源表挂在条目上。
//
// ★ **同层顺序**（"越新的越靠上为宜（顺序总是在补充节点时被破坏?）"）：
//   包的记录顺序**就是**应用里的同层顺序（导入一律 `childOrder.push`）⇒ 顺序必须由数据算出来，
//   不能是"输入片段的先后"。规则与实现都在 `src/core/siblingOrder.js`（**一处**，应用侧
//   增量导入用的是同一份），这里只负责"父在前、子按规则"地把整表重排一遍。
// ⚠️ 必须传 `nodeOf`：排序规则要的字段（`type` / `name` / `contestTime` / `natureYear` / `problemId`）
//    在条目里是**拆开**的 —— 类型在 `record.type`，业务字段全在 `record.fields`（内部字段名）。
//    不给的话规则读到的是空类型 ⇒ 一组都不排、静默失效（实测）。
const nodeOfEntry = (e) => {
    const f = (e.record && e.record.fields) || {};
    return { type: e.record.type, name: f.name, contestTime: f.contestTime,
             time: f.time, natureYear: f.natureYear,
             // ⚠️ P 的**题号**也要给：同一场下的题目按题号升序（"题号怎么是乱的"）
             problemId: f.problemId };
};
const orderedEntries = treeOrder([...byKey.values()], {
    keyOf: (e) => e.record.extKey || e.record.synthKey || '',
    parentOf: (e) => e.record.parentExtKey || e.record.parentSynthKey || '',
    nodeOf: nodeOfEntry
});
const outRecords = orderedEntries.map(serializeRecord);

// 每条记录的被拒字段（比如派生字段）已经在上面的体检里提示过了

const out = {
    crateVersion: sources[0].crate.crateVersion || 1,
    source: {
        id: 'crate-merge',
        label: `合并自 ${sources.length} 个包`,
        mergedFrom: sources.map(s => (s.crate.source && s.crate.source.id)
            ? s.crate.source.id
            : path.basename(s.file)),
        // 合并产物**必须把各来源的 kind 表带下去**：字段级的 `字段来源` 指的是这些 id，
        // 而应用要靠 kind 才知道"谁是权威榜单"（类别序 manual > board > script > derived）。
        // 不带的话，应用只注册 `crate-merge` 一个来源，`cf-…` / `qoj-…` 全是"未知
        // → script/rank 0"，类别序直接失效 —— 压错值就是这么来的。
        // ⚠️ **嵌套的也要带**：包**套包**合并时（`all_nodes.json` =
        //    混装包 + atcoder/cf-contest/两个多校包），每个输入自己已经是 `crate-merge`
        //    产物、它们的 kind 表在 `source.sources` 里；只抄 `source.id` 的话，
        //    all_nodes 的来源表就只剩 3 个 `crate-merge`/`*-scraper`，
        //    `xcpcio-*` / `cf-*` 这些真正在记录里当 `src` 用的一律查不到 kind。
        // 同名 id 的 kind 取**第一个**声明（榜单在前，与"先到先得"一致）。
        sources: (() => {
            const m = {};
            const add = (sid, kind, label) => {
                if (!sid || m[sid]) return;
                m[sid] = { kind: kind || 'script', label: label || sid };
            };
            for (const s of sources) {
                const nested = s.crate.source && s.crate.source.sources;
                if (nested && typeof nested === 'object') {
                    for (const sid of Object.keys(nested)) {
                        add(sid, nested[sid] && nested[sid].kind, nested[sid] && nested[sid].label);
                    }
                }
                const own = (s.crate.source && s.crate.source.id) || path.basename(s.file);
                add(own, s.crate.source && s.crate.source.kind, s.crate.source && s.crate.source.label);
            }
            // ★ **链上那几个脚本自己写进记录的值**也要在表里（否则应用查到"未知来源"、
            //   优先级表失效）：`synth` = 合成相关脚本（`synth-bind.mjs` 建组/绑定、
            //   `problem-bind.mjs` 绑题）写 `ownerSynth` 时用的来源 id。
            //   ⚠️ 以前这个 id 是 `xcpc-synth.json` 自己带进来的（那份包已停用）——
            //   现在**无条件声明**：谁在链上写 `synth`，表里就有它。
            //   判据钉子：`scripts/smoke/crate-invariants.smoke.mjs` 的「来源表覆盖用到的每个来源」。
            add('synth', 'script', '合成脚本（按 nature 建组 / 绑定：synth-bind · problem-bind）');
            return m;
        })()
    },
    // ⚠️ 唯一一处"跑一次就不一样"的地方就是它 —— 想让整包**逐字节可复现**，
    //    按标准做法给个 `SOURCE_DATE_EPOCH`（秒）即可：
    //      `$env:SOURCE_DATE_EPOCH=0` ⇒ 两次构建的包逐字节相同（实测：
    //      固定 PYTHONHASHSEED 之后，两份包只差这一个时间戳）。
    generatedAt: new Date(process.env.SOURCE_DATE_EPOCH
        ? Number(process.env.SOURCE_DATE_EPOCH) * 1000
        : Date.now()).toISOString(),
    fieldMap: mergedFieldMap,
    records: outRecords
};

// 把「**应有**」注册表**随包发布** —— "每个字段条都有『是否应有』
//   『是否已有』『来源』『优先级』"。后两样包里本来就有（`字段来源` / `source.sources` 的 kind），
//   前两样只在构建期（`acm-data/field-registry.json` 的 `expect` + 谓词、体检报告）——
//   应用一概不知道，字段条上自然也没有这一列。
//
// ⚠️ **规则只有一份**：这里只是把那份文件**原样**带进包（不复制、不改写、不裁剪），
//    应用侧的 `src/core/fieldRegistry.js` 按与 `scripts/field-coverage.py` 同样的谓词算。
//    文件不在（别的仓库/裁剪过的环境）就**不带**这一节 —— 界面那一路自然不显示，不报错。
if (fs.existsSync(FIELD_REGISTRY_PATH)) {
    try {
        const reg = JSON.parse(fs.readFileSync(FIELD_REGISTRY_PATH, 'utf-8'));
        if (reg && typeof reg === 'object' && reg.fields) out.fieldRegistry = reg;
    } catch (err) {
        warn(FIELD_REGISTRY_PATH, 'field-registry-unreadable',
            `读不了字段注册表：${err.message}（这一节就不带了，界面上的「应有」不显示）`);
    }
}
// **体检报告随包发布** —— "应用里加一页「🩺 体检 / 需求」"。
//
// 体检（`scripts/field-coverage.py`）与原料需求（`scripts/material-needs.py`）本来就各写一份
// **机器可读**的 JSON（`acm-data/reports/*.json`，还有给人看的 .md）。它们只在构建期存在时，
// 应用要看只能去翻仓库里的 md —— 现在原样带进包顶层，界面直接照着画。
//
// ⚠️ 与 `fieldRegistry` 同一态度：**只带不改**（一份快照，说明"这一版包体检出来是什么样"）；
//    文件不在就**不带这一节**，界面那页会说一句"这个包没带体检报告"，不报错。
const REPORTS = [
    ['coverage', path.join(ROOT, 'acm-data', 'reports', 'field-coverage.json')],
    ['needs', path.join(ROOT, 'acm-data', 'reports', 'material-needs.json')]
];
const reports = {};
for (const [key, file] of REPORTS) {
    if (!fs.existsSync(file)) continue;
    try {
        const doc = JSON.parse(fs.readFileSync(file, 'utf-8'));
        if (doc && typeof doc === 'object') reports[key] = doc;
    } catch (err) {
        warn(file, 'report-unreadable',
            `读不了体检报告 ${path.basename(file)}：${err.message}（这一节就不带了）`);
    }
}
if (Object.keys(reports).length) out.reports = reports;

if (Object.keys(mergedFieldPolicies).length) {
    out.defaults = { fieldPolicies: mergedFieldPolicies };
}

const errors = problems.filter(p => p.level === 'error');
const warns = problems.filter(p => p.level === 'warn');

// ---- 统计 ----
const byType = {};
for (const r of outRecords) byType[r.节点类型] = (byType[r.节点类型] || 0) + 1;

if (!quiet) {
    console.log('');
    console.log(`📊 合并结果：${outRecords.length} 条记录`);
    console.log('   ' + Object.keys(byType).sort()
        .map(t => `${TYPE_LABEL_MAP[t] || t}×${byType[t]}`).join('  '));
    console.log(`   字段映射 ${Object.keys(mergedFieldMap).length} 条`);
}

if (errors.length) {
    console.log(`\n❌ 错误（${errors.length}）—— 必须修，否则导入会出问题：`);
    for (const p of errors) console.log(`   • [${p.code}] ${shortName(p.file)}: ${p.message}`);
}
if (warns.length) {
    console.log(`\n⚠️  提示（${warns.length}）—— 不一定有问题，但值得看一眼：`);
    for (const p of warns) console.log(`   • [${p.code}] ${shortName(p.file)}: ${p.message}`);
}
if (!errors.length && !warns.length) {
    console.log('\n✅ 体检通过：没有发现冲突或断链');
}

// ---- 原子写：临时文件 + rename（**同一目录** ⇒ rename 是原子的）----
// 为什么必须（与 `scripts/crate.py:save`、`scripts/devserver/*_store.py` **同一条理由**）：
//   这份包是**要给应用导入**的 —— 直接覆盖写一旦被打断（Ctrl-C / 盘满 / 断电）就留下
//   **半个 JSON**，而下一轮 `crate-merge` 会把它当**正常输入**读进来（症状："合并莫名其妙少了一截"）。
//   报告文件同理（链尾与回代都会读它）。
// 命名沿用仓里已有的那一份约定 `<file>.tmp-write`（三个 store 的守卫都在查"不留 .tmp-write 垃圾"）。
function writeFileAtomic(file, text) {
    const tmp = `${file}.tmp-write`;
    try {
        fs.writeFileSync(tmp, text, 'utf8');
        fs.renameSync(tmp, file);          // Windows 上实测可覆盖已存在的目标（MoveFileEx + REPLACE）
    } catch (err) {
        try { fs.rmSync(tmp, { force: true }); } catch (_) { /* 尽力而为 */ }
        throw err;
    }
}

// ---- 有错误时不写输出（避免"带病文件"被误导入）----
if (errors.length) {
    console.log(`\n🚫 存在 ${errors.length} 个错误，**未写出** ${outFile}（请先修正后重跑）`);
    if (reportFile) {
        writeFileAtomic(reportFile, JSON.stringify({ ok: false, problems, summary: byType }, null, 2));
        console.log(`   报告已写出 → ${reportFile}`);
    }
    process.exit(1);
}

writeFileAtomic(outFile, JSON.stringify(out, null, 2) + '\n');
console.log(`\n✅ 已写出 ${outFile}（${outRecords.length} 条记录）`);

if (reportFile) {
    writeFileAtomic(reportFile, JSON.stringify({ ok: true, problems, summary: byType }, null, 2));
    console.log(`   报告已写出 → ${reportFile}`);
}

console.log('\n下一步：');
console.log(`   npm run crate:check -- ${outFile}        # 用应用真实引擎试跑`);
console.log('   然后把该文件拖进应用的「📥 节点自动导入」');

// --strict：有提示也视为失败（适合放进脚本流水线）
process.exit(strict && warns.length ? 1 : 0);
