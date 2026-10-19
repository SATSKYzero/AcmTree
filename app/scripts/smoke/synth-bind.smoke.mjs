// ================================================================
// 冒烟测试：按 nature 定合成归属（scripts/smoke/synth-bind.smoke.mjs）
//
// 钉住这套口径（`docs/field-rules.md` §10）：
//   · 键 = `synth:xcpc:<分支>:<赛季>:<键尾>`，显示名按四档称呼
//     （`2022 IC杭州` / `2022 IC杭州热身赛` / `2023 EC-Final` / `2024 IC网络赛1`；ccpc 同构）；
//   · 省赛的 **5 类必须是分类里的一段**（`…/provincial&invitational/<类型>/official`）
//     —— "或许省赛/邀请赛的 5 类细分应直接放到分类里" ⇒ 本步**读分类**，不读赛名；
//   · 地点读 `natureRegion` 字段；`无`/`待填写`/`不需要`/`不知道`/空 **不是**地点；
//   · 只做国内（`icpc/ec`、`ccpc`、省赛）；算不出 ⇒ **一个字不写**，报出来交给人；
//   · 覆盖"旧清单格式"的键、收掉空掉的旧组；**人绑的键不动**；重跑幂等。
// ================================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { group, ok, eq, deepEq, report } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'synth-bind.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'synth-bind-'));

const { xcpcTail, isDomestic, realPlace, bareClass, realYear, onlineRound, planKeyOf, planKeyProblem,
        bindByNature, unbindKindOf, isHumanBound, PROVINCIAL_TYPES, PROVINCIAL_ORGS, CLASS_TOKENS,
        KEY_PREFIX, isScriptKey, isOldKey } =
    await import(`file://${SCRIPT.replace(/\\/g, '/')}`);
const { noSynthRuleOf } = await import(`file://${ROOT.replace(/\\/g, '/')}/src/core/synthRegistry.js`);

const C = (k, cls, extra = {}) => ({ 节点类型: 'C', extKey: k, natureClass: cls, ...extra });
const SYN = (k, parent, name) => ({ 节点类型: 'C', synthKey: k, '父extKey': parent, name });
const S = (k, parent, name) => ({ 节点类型: 'S', extKey: k, '父extKey': parent, name });

group('分类切段：只做国内');
deepEq(xcpcTail('cf/gyms/xcpc/icpc/ec/regional/official'), ['icpc', 'ec', 'regional', 'official'], '`xcpc` 之后那几段');
ok(isDomestic('qoj/xcpc/icpc/ec/final/official') && isDomestic('cf/gyms/xcpc/ccpc/final/official')
   && isDomestic('xcpc/provincial&invitational/省赛/official'), '国内三支都算');
ok(!isDomestic('qoj/xcpc/icpc/eu/regional/official') && !isDomestic('qoj/ucup') && !isDomestic('cf/contest/div2'),
   '★ 欧洲赛区 / ucup / CF 正式轮次都**不**算（"暂时只针对国内部分"）');
eq(bareClass('qoj/xcpc/icpc/ec/final/official'), 'xcpc/icpc/ec/final/official', '镜像前缀去掉后比分类');
eq(realYear('2021'), '2021'); eq(realYear('待同步'), ''); eq(realYear(''), '');
ok(realPlace('成都') && !realPlace('无') && !realPlace('待填写') && !realPlace('不需要') && !realPlace('不知道') && !realPlace(''),
   '★ 四个特殊值 + 空都**不是**地点');

group('网络赛序号：清单 slug 与赛名两种来源');
eq(onlineRound({ extKey: 'aux-rankland:c:icpc2026preliminary-2', name: 'x' }), '2', '清单 slug 里的 `preliminary-2`');
eq(onlineRound({ extKey: 'qoj:c:1794', name: 'The 2024 ICPC Asia East Continent Online Contest (I)' }), '1', '赛名里的 `(I)`');
eq(onlineRound({ extKey: 'aux-xcpcio:c:ccpc2022preliminary', name: '2022 年中国大学生程序设计竞赛网络预选赛' }), '', '只有一场 ⇒ 空（不加序号）');
// ⚠️ 罗马数字若取的是**字符长度**、中文若用"逐字累加"，就会错：
//    ⇒ `(IV)`→2、`(V)`→1、`第十一场`→101、`第二十场`→30（键与组名会写成"网络赛101"）。
//    产包侧（`synth-bind.mjs`）与应用 ⑤ 冲突页共用这个函数 ⇒ 两边同错。下面每一条都是"改回去就红"。
eq(onlineRound({ name: '(III)' }), '3', '罗马 III = 3（`length` 恰好也对）');
eq(onlineRound({ name: '(IV)' }), '4', '★ 罗马 IV = 4（**不是** 2）');
eq(onlineRound({ name: '(V)' }), '5', '★ 罗马 V = 5（**不是** 1）');
eq(onlineRound({ name: '(v)' }), '5', '小写也认');
eq(onlineRound({ name: '2026 网络赛（第 11 场）' }), '11', '★ 中文十一 = 11（**不是** 101）');
eq(onlineRound({ name: '第二十场网络赛' }), '20', '★ 中文二十 = 20（**不是** 30）');
eq(onlineRound({ name: '第十场网络赛' }), '10', '整十');
eq(onlineRound({ name: '第十五场网络赛' }), '15', '十几');
eq(onlineRound({ name: '第一场网络赛' }), '1', '单字');
eq(onlineRound({ name: '第二十一场网络赛' }), '21', '二十几');
eq(onlineRound({ name: '第一百场网络赛' }), '', '认不出的中文数字 ⇒ 空（不猜）');

group('四档称呼 → 键与显示名');
{
    const g1 = planKeyOf(C('qoj:c:2567', 'qoj/xcpc/icpc/ec/regional/official',
        { natureSeason: '2025', natureRegion: '成都', name: 'The 2025 ICPC Asia Chengdu Regional Contest' }));
    eq(g1.key, 'synth:xcpc:2025ec_regional-成都', 'IC 区域赛的键');
    eq(g1.name, '2025 IC成都', 'IC 区域赛的显示名');
    const g2 = planKeyOf(C('qoj:c:1888', 'qoj/xcpc/icpc/ec/final/warm-up',
        { natureSeason: '2024', natureRegion: '待填写', name: 'EC-Final 2024. Warm Up.' }));
    eq(g2.key, 'synth:xcpc:2024ecfinal-warmup', 'EC-Final 热身赛的键');
    eq(g2.name, '2024 EC-Final热身赛', 'EC-Final 热身赛的显示名');
    const g3 = planKeyOf(C('qoj:c:1794', 'qoj/xcpc/icpc/ec/pre/official',
        { natureSeason: '2024', natureRegion: '无', name: 'The 2024 ICPC Asia East Continent Online Contest (I)' }));
    eq(g3.key, 'synth:xcpc:2024ec_pre1', '网络赛的键（带序号）');
    const g4 = planKeyOf(C('aux-rankland:c:ccpc2024final', 'xcpc/ccpc/final/official',
        { natureSeason: '2024', natureRegion: '待填写', name: '第十届中国大学生程序设计竞赛总决赛' }));
    eq(g4.key, 'synth:xcpc:2024ccpcf', 'ccpc 总决赛（同构）');
    ok(!planKeyOf(C('qoj:c:1', 'qoj/xcpc/icpc/eu/regional/official', { natureSeason: '2024', natureRegion: '华沙' })),
        '★ 非国内 ⇒ 没有键');
    ok(!planKeyOf(C('qoj:c:2', 'qoj/xcpc/icpc/ec/regional/official', { natureSeason: '2024', natureRegion: '待填写' })),
        '★ 区域赛缺地点 ⇒ 没有键（不猜）');
}

group('省赛：**两轴都从分类里读**（不读赛名）—— 4 主办 × 3 类型');
ok(PROVINCIAL_TYPES.length === 3 && PROVINCIAL_TYPES[0] === '省赛暨邀请赛', '类型 3 类与顺序');
ok(PROVINCIAL_ORGS.length === 4 && PROVINCIAL_ORGS[0] === 'IC&CC', '主办 4 档与顺序（先判"两个都有"）');
{
    const a = planKeyOf(C('aux-rankland:c:zjcpc23rd', 'xcpc/provincial&invitational/IC/省赛/official',
        { natureSeason: '2026', natureRegion: '浙江', name: '「睿琪杯」浙江省第 23 届大学生程序设计竞赛' }));
    eq(a.key, 'synth:xcpc:2026ic_provincial-浙江', '省赛的键（主办进键）');
    eq(a.name, '2026 浙江IC省赛', '省赛的显示名');
    // ⚠️ 名字像省赛、但分类说 `无归类` ⇒ **不建键**（分类是唯一真源；判错了在应用里改分类）
    ok(!planKeyOf(C('qoj:c:9', 'qoj/xcpc/provincial&invitational/无归类/official',
        { natureSeason: '2025', natureRegion: '浙江', name: '2025 浙江省赛' })),
        '★ 分类是 `无归类` ⇒ 不建键（哪怕名字像省赛）');
    const b = planKeyOf(C('qoj:c:1830', 'qoj/xcpc/provincial&invitational/CC/省赛暨邀请赛/official',
        { natureSeason: '2025', natureRegion: '江西', name: '2025 CCPC 全国邀请赛（南昌）暨江西省赛' }));
    eq(b.key, 'synth:xcpc:2025cc_prov&invi-江西', '省赛暨邀请赛的键');
    // ★ **主症状**：河南那种"同年同地 IC 场 + CC 场"必须算出**两个不同的键**
    const ic = planKeyOf(C('aux-rankland:c:haicpc17th', 'xcpc/provincial&invitational/IC/省赛/official',
        { natureSeason: '2026', natureRegion: '河南', name: '第 17 届 ICPC 河南省大学生程序设计竞赛' }));
    const cc = planKeyOf(C('aux-rankland:c:haccpc8th', 'xcpc/provincial&invitational/CC/省赛/official',
        { natureSeason: '2026', natureRegion: '河南', name: '第 8 届 CCPC 河南省大学生程序设计竞赛' }));
    ok(ic && cc && ic.key !== cc.key, '★ 河南 IC 场与 CC 场**不再并成一组**（正交化的目的）');
    eq(ic.name, '2026 河南IC省赛', 'IC 场的显示名');
    eq(cc.name, '2026 河南CC省赛', 'CC 场的显示名');
    // 主办是 `无` 时键里留着 `无`（要唯一），但**显示名不写它**（否则读成「河南无省赛」）
    const none = planKeyOf(C('cf:c:105222', 'cf/gyms/xcpc/provincial&invitational/无/省赛/official',
        { natureSeason: '2024', natureRegion: '四川', name: 'The 2024 Sichuan Provincial Collegiate PC' }));
    eq(none.key, 'synth:xcpc:2024provincial-四川', '主办 `无` 的键');
    eq(none.name, '2024 四川省赛', '★ 但显示名里不写 `无`');
    // ⚠️ 缺一段（只有类型、没有主办）⇒ **算不出键**，留给人
    ok(!planKeyOf(C('qoj:c:1', 'qoj/xcpc/provincial&invitational/省赛/official',
        { natureSeason: '2026', natureRegion: '河南', name: '2026 河南省赛' })),
        '★ 只有类型一段 ⇒ 算不出键，不硬算');
    ok(!planKeyOf(C('qoj:c:2', 'qoj/xcpc/provincial&invitational/IC/official',
        { natureSeason: '2026', natureRegion: '河南', name: '2026 河南省赛' })),
        '缺类型那一段 ⇒ 同样算不出');
    ok(planKeyProblem(C('qoj:c:1', 'qoj/xcpc/provincial&invitational/省赛/official',
        { natureSeason: '2026', natureRegion: '河南', name: 'x' })).includes('缺主办'),
        '★ 算不出键**连原因一起**说（不只是"没归入"）');
}

group('落地：铺容器/组、写指针、替换旧清单键、收掉空组、人绑的不动');
{
    const doc = {
        records: [
            { 节点类型: 'W', extKey: 'xcpc', name: 'XCPC' },
            // 旧清单方案留下的组（要被替换并收掉）
            S('xcpc:s:synth-icpc:ec', 'xcpc', 'icpc'),
            S('xcpc:s:synth-icpc:ec:2025', 'xcpc:s:synth-icpc:ec', '2025'),
            SYN('synth:xcpc:icpc2025ecfinal', 'xcpc:s:synth-icpc:ec:2025', '2025 EC-Final'),
            C('qoj:c:3295', 'qoj/xcpc/icpc/ec/final/official',
                { natureSeason: '2025', natureRegion: '待填写', name: 'EC-Final 2025', ownerSynth: 'synth:xcpc:icpc2025ecfinal' }),
            C('aux-xcpcio:c:icpc2025ecfinal', 'xcpc/icpc/ec/final/official',
                { natureSeason: '2025', natureRegion: '待填写', name: '华为杯 EC-Final 2025', ownerSynth: 'synth:xcpc:icpc2025ecfinal' }),
            // 人绑的（键不是我们的格式）⇒ 一个字不动
            SYN('synth:手工:一', 'xcpc:s:synth-icpc:ec:2025', '手工组'),
            C('aux-rankland:c:icpc2025chengdu', 'xcpc/icpc/ec/regional/official',
                { natureSeason: '2025', natureRegion: '成都', name: '成都站', ownerSynth: 'synth:手工:一' })
        ]
    };
    const res = bindByNature(doc);
    const keyOf = (r) => r.synthKey || r.extKey || '';
    const own = (k) => (doc.records.find((r) => keyOf(r) === k) || {}).ownerSynth;
    eq(own('qoj:c:3295'), 'synth:xcpc:2025ecfinal', '★ 旧清单键被换成新键');
    eq(own('aux-xcpcio:c:icpc2025ecfinal'), 'synth:xcpc:2025ecfinal', '同组另一条也换了');
    eq(own('aux-rankland:c:icpc2025chengdu'), 'synth:手工:一', '★ 人绑的键不动');
    ok(doc.records.some((r) => keyOf(r) === 'synth:xcpc:2025ecfinal'), '新组节点建出来了');
    ok(!doc.records.some((r) => keyOf(r) === 'synth:xcpc:icpc2025ecfinal'), '★ 空掉的旧组被收掉');
    eq(res.dropped.length, 1, '收掉 1 个');
    eq(res.replaced, 2, '替换 2 条旧指针');
    // 幂等
    const again = bindByNature(doc);
    eq(again.bound, 0, '再跑一遍无事可做（幂等）');
    ok(again.dropped.length === 0, '也不会再收组');
}

group('★ 组头年份：**不随输入顺序变**');
{
    // 病根：组头的 nature 若先照"第一个成员"写，两个成员都是真年份但不同时
    // **谁先遍历到就听谁的** ⇒ 输入顺序一变，组头年份就翻（实测 A→B 得 2021、B→A 得 2022），
    // 与"逐字节可复现"冲突。现在的口径：**级别高的赢（M>A>B>C>D>E），同级取最早**。
    const mk = (a, b) => ({
        records: [C('qoj:c:A', 'qoj/xcpc/icpc/ec/regional/official',
            { natureSeason: '2021', natureRegion: '成都', name: 'A 场', ...a }),
        C('qoj:c:B', 'qoj/xcpc/icpc/ec/regional/official',
            { natureSeason: '2021', natureRegion: '成都', name: 'B 场', ...b })]
    });
    const headYear = (doc) => {
        bindByNature(doc);
        const head = doc.records.find((r) => String(r.synthKey || '').trim());
        return head ? head.natureYear : '';
    };
    const both = (a, b) => [headYear(mk(a, b)), headYear(mk(b, a))];

    const [ab1, ba1] = both({ natureYear: '2021' }, { natureYear: '2022' });
    deepEq([ab1, ba1], ['2021', '2021'], '★ 两个真年份、级别都未知 ⇒ **取最早**（且两个顺序都一样）');

    const [ab2, ba2] = both({ natureYear: '待同步' }, { natureYear: '2022' });
    deepEq([ab2, ba2], ['2022', '2022'], '★ 真年份 vs `待同步` ⇒ 真年份顶上（两个顺序都一样）');

    const [ab3, ba3] = both({ natureYear: '2021' }, { natureYear: '2022', '分类依据': { natureYear: 'manual:set' } });
    deepEq([ab3, ba3], ['2022', '2022'], '★ 级别高的赢（M 级 2022 压过无依据的 2021）');

    const [ab4, ba4] = both({ natureYear: '2022', '分类依据': { natureYear: 'manual:set' } }, { natureYear: '2021' });
    deepEq([ab4, ba4], ['2022', '2022'], '★ 反过来放也一样：**级别高的一直赢**（早年份也不翻）');
}

group('★ 组头分类：只差**镜像前缀**的两种写法，取谁**也不随输入顺序变**');
{
    // 病根（2026-10-13 修）：成员循环里"第一个成员先写 `natureClass`"⇒ 组头那格记的是**包的记录顺序**
    // 里第一个成员的写法；而收敛那遍按 `sameNatureValue`（分类只差镜像前缀 ⇒ 不算不同）**跳过**
    // ⇒ 写法被输入顺序钉住（真包实测 50 个组头在 `cf/gyms/…` ↔ `qoj/…` 之间翻，而语义完全相同）。
    // 现在：组头四格**只**由 `pickGroupNature` 定（同级取字典序小的）⇒ 两种顺序必须得到**同一个写法**。
    const mk = (first, second) => ({
        records: [
            C('qoj:c:A', first, { natureSeason: '2021', natureRegion: '成都', name: 'A 场' }),
            C('qoj:c:B', second, { natureSeason: '2021', natureRegion: '成都', name: 'B 场' })
        ]
    });
    const headCls = (doc) => {
        bindByNature(doc);
        const head = doc.records.find((r) => String(r.synthKey || '').trim());
        return head ? head.natureClass : '';
    };
    const QOJ = 'qoj/xcpc/icpc/ec/regional/official';
    const CF = 'cf/gyms/xcpc/icpc/ec/regional/official';
    const ab = headCls(mk(QOJ, CF));
    const ba = headCls(mk(CF, QOJ));
    eq(ab, ba, '★ 两种记录顺序 ⇒ 组头分类的写法**必须一样**');
    eq(bareClass(ab), bareClass(QOJ), '而且去镜像前缀后仍是这一场（没换语义）');
}


{
    // 「上游异常」这一类：`上游异常` / `…/无归类` 是**结论**（判不了 / 判过了），
    // 不是等人补的欠账 ⇒ 构建日志里的"算不出、留给人"也不该报它们（真例 `qoj:c:2624`）。
    // ⚠️ 与 `src/core/synthConflicts.js`（应用侧 ⑤）**必须一致** —— 各说一套就没法信了。
    const mk = (cls) => ({ records: [S('xcpc:s:synth-provincial', 'root', '省赛'), C('qoj:c:x', cls,
        { natureSeason: '2025', natureRegion: '浙江', name: '某场' })] });
    const blue = bindByNature(mk('qoj/xcpc/provincial&invitational/未归类'));
    eq(blue.noKey.length, 1, '★ 蓝的 `未归类`（填写不完全）**照旧进**待办');
    eq(bindByNature(mk('qoj/xcpc/provincial&invitational/上游异常')).noKey.length, 0,
        '★ 灰的 `上游异常`（判不了）**不进**');
    eq(bindByNature(mk('qoj/xcpc/provincial&invitational/无归类')).noKey.length, 0,
        '★ 灰的 `…/无归类`（判过了、归不进去）**也不进**');
}

group('★ 人绑的合成归属：`ownerSynth` 一个字不动');
{
    // `ownerSynth` 若**没有任何痕迹** ⇒ 脚本只按 nature 重算，人手绑的那份会漂掉。
    // 现在手改那条路（`ops/synth.js:applyOwnerSynth`）会写 `分类依据.ownerSynth = manual:set`，
    // 本步看到它就**不搬**（哪怕键是脚本格式、哪怕按 nature 该是另一个键）。
    const doc = { records: [
        S('xcpc:s:synth-icpc:ec', 'root', 'ICPC-EC'),
        // 人把它绑到了**另一个**（脚本格式的）组上 —— 按 nature 它该去 2020:成都
        C('qoj:c:777', 'qoj/xcpc/icpc/ec/regional/official',
            { natureSeason: '2020', natureRegion: '成都', name: '人被绑走的那场',
                ownerSynth: 'synth:xcpc:2020ec_regional-银川',
                '分类依据': { ownerSynth: 'manual:set' } })
    ] };
    const res = bindByNature(doc);
    const rec = doc.records.find((r) => r.extKey === 'qoj:c:777');
    eq(rec.ownerSynth, 'synth:xcpc:2020ec_regional-银川', '★ 人绑的还是原来那个（脚本不许搬）');
    eq(res.humanBound.length, 1, '并报出"人绑的 N 条"');
    ok(!res.drift.some((d) => d.node === 'qoj:c:777'), '也不算"该换键"（那是脚本的口径，人是故意的）');
    ok(isHumanBound(rec) && !isHumanBound(C('z', 'xcpc')), 'isHumanBound 只认那条标记');
}

group('★ 注册表排除：不该算合成键的（两层白名单，见 `acm-data/synth-registry.json`）');
{
    // 注册表："有些节点不该算合成键"（两层："节点级白名单 +
    // 分类白名单，是不同层的属性叠加"），例子："**比如平壤**"；"已绑的怎么办" ⇒ **解绑**，
    // 删除路径（"现有的实现有许多地方没有考虑怎么删除"）由这一组钉住。
    const keyOf = (r) => r.synthKey || r.extKey || '';
    // A) 被点名的（`qoj:c:2180` = 2016 平壤区域赛，场地在中国境外）⇒ 不算键 + **解绑** + 收空组/空容器
    const doc = { records: [
        S('xcpc:s:synth-icpc:ec', 'root', 'ICPC-EC'),
        S('xcpc:s:synth-icpc:ec:2016', 'xcpc:s:synth-icpc:ec', '2016'),
        SYN('synth:xcpc:2016ec_regional-平壤', 'xcpc:s:synth-icpc:ec:2016', '2016 IC平壤'),
        C('qoj:c:2180', 'qoj/xcpc/icpc/ec/regional/official',
            { natureSeason: '2016', natureRegion: '平壤', name: 'The 2016 ICPC Asia Pyongyang Regional',
                ownerSynth: 'synth:xcpc:2016ec_regional-平壤' })
    ] };
    const res = bindByNature(doc);
    eq(res.noSynth.length, 1, '注册表排除了 1 条（平壤）');
    eq(res.noSynth[0].layer, 'nodeRules', '命中的是**节点白名单**那一层');
    eq(res.noKey.length, 0, '★ 它进的是"注册表排除"，**不是**"算不出"');
    eq(res.bound, 0, '一个字都不绑');
    eq(res.unbound.length, 1, '★ 绑着**脚本格式**的键 ⇒ 解绑');
    ok(!doc.records.some((r) => keyOf(r) === 'synth:xcpc:2016ec_regional-平壤'), '★ 空掉的组被收掉（删除路径）');
    ok(!doc.records.some((r) => keyOf(r) === 'xcpc:s:synth-icpc:ec:2016')
       && !doc.records.some((r) => keyOf(r) === 'xcpc:s:synth-icpc:ec'),
    '★ 因它空掉的容器**级联**收掉（赛季层空 ⇒ 分支层也跟着空）');
    const n = doc.records.find((r) => keyOf(r) === 'qoj:c:2180');
    ok(n && n.ownerSynth === undefined, '指针真的清了（它变回"无归属"）');

    // B) **人工绑的键一个字不动**；**人手建的空组**也不许被"收空组"误删
    const doc2 = { records: [
        SYN('synth:手工:空组', 'root', '人手建的空组'),
        C('qoj:c:2180', 'qoj/xcpc/icpc/ec/regional/official',
            { natureSeason: '2016', natureRegion: '平壤', ownerSynth: 'synth:手工:平壤' })
    ] };
    const res2 = bindByNature(doc2);
    eq(res2.unbound.length, 0, '人工绑的键 ⇒ **不解绑**');
    eq(res2.humanKeyed.length, 1, '但要报出来请人核（脚本不擅自删人的决定）');
    eq(doc2.records.find((r) => keyOf(r) === 'qoj:c:2180').ownerSynth, 'synth:手工:平壤',
        '★ 人工的键一个字不动');
    ok(doc2.records.some((r) => keyOf(r) === 'synth:手工:空组'),
        '★ 人手建的空组**不许**被误删（只收"本轮解绑而清空"的那些）');

    // C) 那一小段判断住在删除路径上 ⇒ 单独钉（错一次就会删掉别人的决定）
    const rule = noSynthRuleOf({ extKey: 'qoj:c:2180' });
    eq(unbindKindOf(null, rule), 'none', '不是节点 ⇒ 不动');
    eq(unbindKindOf({ extKey: 'qoj:c:1' }, rule), 'none', '没指针 ⇒ 不动');
    eq(unbindKindOf({ extKey: 'qoj:c:1', ownerSynth: 'synth:xcpc:2016ec_regional-平壤' }, rule), 'script',
        '我们格式 ⇒ 解绑');
    eq(unbindKindOf({ extKey: 'qoj:c:1', ownerSynth: 'synth:手工:平壤' }, rule), 'human',
        '人绑的 ⇒ 只报不动');
}

group('键的格式：三分支一张表（别再把省赛那支误判成"旧格式"）');
{
    // ⚠️ 踩过两次坑：① 正则写死分支名，改格式后"本步格式"的键被判成旧格式 ⇒ 每次构建重算、
    //    人挪进某个组会被悄悄撤销；② 省赛那支的分类段换过两次词表。
    //   ⇒ 现在只钉**判据**：前缀之后紧跟**赛季**才算"本步格式"，且算出来的分类段在词表里。
    const samples = [
        C('a', 'xcpc/icpc/ec/regional/official', { natureSeason: '2025', natureRegion: '成都' }),
        C('b', 'xcpc/ccpc/regional/official', { natureSeason: '2025', natureRegion: '东北' }),
        C('c', 'xcpc/provincial&invitational/IC/省赛/official', { natureSeason: '2025', natureRegion: '浙江' }),
        C('d', 'xcpc/ccpc/female/official', { natureSeason: '2024', natureRegion: '待填写' }),
        C('e', 'xcpc/provincial&invitational/无/邀请赛/warm-up', { natureSeason: '2026', natureRegion: '南昌' })
    ];
    const want = ['2025ec_regional-成都', '2025cc_regional-东北', '2025ic_provincial-浙江',
        '2024ccpc-female', '2026invitational-南昌-warmup'];
    samples.forEach((s, i) => {
        const g = planKeyOf(s);
        eq(g.id, want[i], '★ 场次标识 = <赛季><分类段>[-地点][-限定词]');
        ok(g.key === KEY_PREFIX + g.id, '键 = 前缀 + 场次标识');
        const token = CLASS_TOKENS.find((t) => g.id.startsWith(s.natureSeason + t));
        ok(!!token, `算出来的分类段在词表里：${token}`);
        ok(isScriptKey(g.key), `算出来的键被认成"本步格式"：${g.key}`);
        ok(!isOldKey(g.key), `★ 而且**不**被认成旧格式：${g.key}`);
    });
    ok(isOldKey(`${KEY_PREFIX}icpc2022hangzhou`) && !isScriptKey(`${KEY_PREFIX}icpc2022hangzhou`), '旧清单 slug 仍是旧格式');
    ok(isOldKey(`${KEY_PREFIX}icpc-ec:2025:成都`) && !isScriptKey(`${KEY_PREFIX}icpc-ec:2025:成都`),
        '★ `<分支>:<赛季>:<键尾>` 那代也是旧格式 —— 要被这一步替换掉');
    ok(!isOldKey('synth:手工:一') && !isScriptKey('synth:手工:一'), '人自己起的键两边都不是（所以一个字不动）');
    ok(!isOldKey('') && !isScriptKey(''), '空键两边都不是');
}

group('已绑的省赛成员：脚本不再重算（与 icpc/ccpc 一致）；键与 nature 不符 ⇒ 报出来、不搬');
{
    const doc = {
        records: [
            { 节点类型: 'W', extKey: 'xcpc', name: 'XCPC' },
            // 省赛组：脚本自己在上一轮建的（新格式键）+ 两个成员，其中第二个指向**另一个**键
            SYN(`${KEY_PREFIX}2025ic_provincial-浙江`, 'xcpc:s:synth-provincial&invitational:2025', '2025 浙江IC省赛'),
            SYN(`${KEY_PREFIX}2025provincial-浙江`, 'xcpc:s:synth-provincial&invitational:2025', '2025 浙江IC邀请赛（人自己起的键）'),
            C('aux-rankland:c:zjcpc23rd', 'xcpc/provincial&invitational/IC/省赛/official',
                { natureSeason: '2025', natureRegion: '浙江', name: '浙江省赛',
                  ownerSynth: `${KEY_PREFIX}2025ic_provincial-浙江` }),
            // 人把它挪进了另一个组（键是人手写的，不是本步格式 ⇒ 脚本一个字不动）
            C('qoj:c:999', 'qoj/xcpc/provincial&invitational/IC/省赛/official',
                { natureSeason: '2025', natureRegion: '浙江', name: '浙江省赛',
                  ownerSynth: `${KEY_PREFIX}2025provincial-浙江` })
        ]
    };
    const res = bindByNature(doc);
    const own = (k) => (doc.records.find((r) => (r.synthKey || r.extKey) === k) || {}).ownerSynth;
    eq(own('aux-rankland:c:zjcpc23rd'), `${KEY_PREFIX}2025ic_provincial-浙江`, '★ 已经在本步格式的键上 ⇒ 不再动它');
    eq(own('qoj:c:999'), `${KEY_PREFIX}2025provincial-浙江`, '★ 人挪进的那组**不撤销**');
    eq(res.bound, 0, '一条都没改');
    eq(res.drift.length, 1, '★ 但它与自己的 nature 不符 ⇒ 报 1 条（交给人核）');
    eq(res.drift[0].node, 'qoj:c:999', '报的是那一条');
    eq(res.drift[0].want, `${KEY_PREFIX}2025ic_provincial-浙江`, '报出"按 nature 该是哪个键"');
}

group('收空组：只收**旧格式**的空组（新格式与人手建的都不碰）');
{
    const doc = {
        records: [
            { 节点类型: 'W', extKey: 'xcpc', name: 'XCPC' },
            SYN(`${KEY_PREFIX}icpc2020yinchuan`, 'xcpc:s:synth-icpc:ec:2020', '旧组（没人指着 ⇒ 收掉）'),
            SYN(`${KEY_PREFIX}2025provincial-浙江`, 'xcpc:s:synth-provincial&invitational:2025', '新格式空组'),
            SYN('synth:手工:一', 'xcpc:s:synth-provincial&invitational:2025', '人手建的空组'),
            C('qoj:c:1888', 'qoj/xcpc/icpc/ec/final/official', { natureSeason: '2024', natureRegion: '待填写', name: 'EC-Final 2024' })
        ]
    };
    const res = bindByNature(doc);
    deepEq(res.dropped, [`${KEY_PREFIX}icpc2020yinchuan`], '★ 只收旧格式那一个');
    ok(doc.records.some((r) => r.synthKey === `${KEY_PREFIX}2025provincial-浙江`), '新格式的空组留着（脚本不替人清理）');
    ok(doc.records.some((r) => r.synthKey === 'synth:手工:一'), '人手建的空组留着');
}

group('组内年份：**只有 M/A/B 高可信**的冲突才报警');
{
    // 两个来源都拿**开赛时间**、且都是 A 档（`xcpcio` / `pta`）报年份、却不一样 ⇒ 报警。
    const doc = {
        records: [
            { 节点类型: 'W', extKey: 'xcpc', name: 'XCPC' },
            C('aux-a:c:1', 'xcpc/icpc/ec/regional/official',
                { natureSeason: '2020', natureYear: '2020', natureRegion: '银川', name: '银川站',
                  分类依据: { natureYear: 'xcpcio:year-time' } }),
            C('aux-b:c:1', 'xcpc/icpc/ec/regional/official',
                { natureSeason: '2020', natureYear: '2021', natureRegion: '银川', name: '银川站',
                  分类依据: { natureYear: 'pta:year-time' } })
        ]
    };
    const res = bindByNature(doc);
    eq(res.yearConflicts.length, 1, '★ 两个高可信的值不同 ⇒ 报 1 处');
    eq(res.yearConflicts[0].high.length, 2, '两边的值都列出来');
    deepEq(res.yearConflicts[0].high.map(h => h.value), ['2020', '2021'], '值升序');
    eq(res.conflicts.length, 0, '年份不再混进普通 conflicts');
    const g = doc.records.find((r) => String(r.synthKey || '').startsWith('synth:xcpc:'));
    eq(g.natureYear, '2020', '★ 组头的年份由 `pickGroupNature` 收敛（真年份顶占位 → 同级取小的：这里仍是 2020）');
    eq(g.natureSeason, '2020', '赛季本来就是身份里的那一段');
}
{
    // 一边是**赛季年顶出来的**（D，不高）⇒ 不报警，只记账
    const doc = {
        records: [
            { 节点类型: 'W', extKey: 'xcpc', name: 'XCPC' },
            C('aux-a:c:2', 'xcpc/icpc/ec/regional/official',
                { natureSeason: '2020', natureYear: '2020', natureRegion: '银川', name: '银川站',
                  分类依据: { natureYear: 'xcpcio:year-time' } }),
            C('aux-b:c:2', 'xcpc/icpc/ec/regional/official',
                { natureSeason: '2020', natureYear: '2021', natureRegion: '银川', name: '银川站',
                  分类依据: { natureYear: 'xcpc:year-season' } })
        ]
    };
    const res = bindByNature(doc);
    eq(res.yearConflicts.length, 0, '★ 低可信的差异**不算警报**（`…:year-season` = D）');
    eq(res.yearLow.length, 1, '记一笔账（高/低不一致）');
    eq(res.yearLow[0].low[0].value, '2021', '低的那一侧也写清是谁');
}
{
    // `待同步`（占位）不算值、更不算高可信
    const doc = {
        records: [
            { 节点类型: 'W', extKey: 'xcpc', name: 'XCPC' },
            C('aux-a:c:3', 'xcpc/icpc/ec/final/official',
                { natureSeason: '2019', natureYear: '待同步', natureRegion: '上海', name: 'EC-Final',
                  分类依据: { natureYear: 'xcpc:year-tbd' } }),
            C('aux-b:c:3', 'xcpc/icpc/ec/final/official',
                { natureSeason: '2019', natureYear: '2019', natureRegion: '上海', name: 'EC-Final',
                  分类依据: { natureYear: 'pta:year-time' } })
        ]
    };
    const res = bindByNature(doc);
    eq(res.yearConflicts.length, 0, '`待同步` 不参与比较');
    const g3 = doc.records.find((r) => String(r.synthKey || '').startsWith('synth:xcpc:'));
    eq(g3.natureYear, '2019', '组头那格仍然"真年份顶掉占位"（这条口径没变）');
}
{
    // 分类/地区不一致仍报（普通）
    const doc = {
        records: [
            { 节点类型: 'W', extKey: 'xcpc', name: 'XCPC' },
            C('aux-a:c:4', 'xcpc/icpc/ec/regional/official',
                { natureSeason: '2020', natureYear: '2020', natureRegion: '银川', name: '银川站' }),
            C('aux-b:c:4', 'xcpc/icpc/ec/regional',
                { natureSeason: '2020', natureYear: '2020', natureRegion: '银川', name: '银川站' })
        ]
    };
    const res = bindByNature(doc);
    eq(res.conflicts.length, 1, '分类深浅不同 ⇒ 报 1 条');
    eq(res.conflicts[0].field, 'natureClass', '★ 分类深浅不同 ⇒ 报的是分类');
    eq(res.conflicts[0].severity, 'normal', '分类那类只算普通冲突');
}

group('命令行：没得改时不动磁盘（真跑一遍 CLI）');
{
    const clean = { records: [{ 节点类型: 'W', extKey: 'xcpc', name: 'XCPC' }] };
    const p = path.join(tmp, 'clean.json');
    fs.writeFileSync(p, JSON.stringify(clean, null, 2) + '\n', 'utf8');
    const before = fs.readFileSync(p, 'utf8');
    eq(spawnSync(process.execPath, [SCRIPT, p], { stdio: 'inherit', cwd: ROOT }).status, 0, '退出码 0');
    eq(fs.readFileSync(p, 'utf8'), before, '没得改 ⇒ 文件一个字节都没动');
}
{
    const doc = {
        records: [
            { 节点类型: 'W', extKey: 'xcpc', name: 'XCPC' },
            C('qoj:c:1888', 'qoj/xcpc/icpc/ec/final/warm-up', { natureSeason: '2024', natureRegion: '待填写', name: 'EC-Final 2024. Warm Up.' })
        ]
    };
    const p = path.join(tmp, 'dirty.json');
    fs.writeFileSync(p, JSON.stringify(doc), 'utf8');
    eq(spawnSync(process.execPath, [SCRIPT, p], { stdio: 'inherit', cwd: ROOT }).status, 0, '退出码 0');
    const raw = fs.readFileSync(p, 'utf8');
    ok(raw.startsWith('{\n  "records"') && raw.endsWith('\n'), '口径与其它步骤一致（缩进 2、无 BOM、末尾换行）');
    const after = JSON.parse(raw);
    const g = after.records.find((r) => r.synthKey === `${KEY_PREFIX}2024ecfinal-warmup`);
    ok(g && g.name === '2024 EC-Final热身赛', '组合节点落盘了（名与键都对）');
    eq(after.records.find((r) => r.extKey === 'qoj:c:1888').ownerSynth, g.synthKey, '成员指针也落盘了');
    ok(after.records.some((r) => r.extKey === 'xcpc:s:synth-icpc:ec:2024'), '容器（赛季层）铺出来了');
}

fs.rmSync(tmp, { recursive: true, force: true });
report();
