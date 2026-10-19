// ================================================================
// 冒烟测试：按 nature 落位（scripts/smoke/nature-rehome.smoke.mjs）
//
// 钉住这套判据（"仅针对各渠道分类本就不充分的节点，
// 若有足够的 nature，直接改变其在树中的路径" + "跟同 class 的邻居走，认不出再按
// nature 类路径铺" + "暂时只对 nature 属于 (?/)xcpc 的生效"
// + "无邻居参考时，有分类和赛季就能确定位置了"）。
//
// 为什么是冒烟而不是单测：这一条**改的是包本身**（和 `crate-merge` 同形）——
// 真正的契约是"给一份包 → 记录被搬到该去的地方 / 不该动的一个字不动"，
// 所以这里造**小包**跑真函数，再跑一次真 CLI 验证"没得搬时不动磁盘"。
// ================================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { group, ok, eq, deepEq, report } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'nature-rehome.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nature-rehome-'));

const {
    isFallbackLayer, classSegments, classIsXcpc, enoughClass, stripYearLayer,
    yearLabel, isRealYear, seasonLabel, classPathLayers, buildHomeIndex, resolveHome, rehome,
    isSeasonLayer, collapseSeasonLayers
} = await import(`file://${SCRIPT.replace(/\\/g, '/')}`);

// ---- 小包构造器 --------------------------------------------------
const C = (key, parent, extra = {}) => ({ 节点类型: 'C', extKey: key, '父extKey': parent, ...extra });
const S = (key, parent, name) => ({ 节点类型: 'S', extKey: key, '父extKey': parent, name });

/** 一份最小包：`qoj` 树 + 兜底桶里的两场 + 若干 `xcpc` 族邻居 */
function fixture() {
    return {
        records: [
            { 节点类型: 'W', extKey: 'qoj', name: 'QOJ' },
            S('qoj:s', 'qoj', '系列'),
            // 兜底桶（渠道没给分类）
            S('qoj:s:no-category', 'qoj', '（QOJ 上没挂分类）'),
            C('qoj:c:1', 'qoj:s:no-category', { natureClass: 'qoj/xcpc/ccpc/final/official', natureYear: '2025', natureSeason: '2025' }),
            C('qoj:c:2', 'qoj:s:no-category', { natureClass: 'qoj/xcpc/provincial&invitational/official', natureYear: '2026', natureSeason: '2026', natureRegion: '浙江' }),
            // 一个"nature 不够"的（class 就是无归类）⇒ 必须原地不动
            C('qoj:c:3', 'qoj:s:no-category', { natureClass: 'qoj/无归类', natureYear: '2020', natureSeason: '2020' }),
            // 一个 nature 够、但**不是 xcpc 那支** ⇒ 也必须原地不动（限定范围）
            C('qoj:c:4', 'qoj:s:no-category', { natureClass: 'qoj/其他/一般', natureYear: '2021' }),
            // 邻居：CCPC Final 只有一处落点
            S('qoj:s:cat-205', 'qoj:s', 'CCPC'),
            S('qoj:s:cat-205:年份未知', 'qoj:s:cat-205', '年份未知'),
            C('qoj:c:10', 'qoj:s:cat-205:年份未知', { natureClass: 'qoj/xcpc/ccpc/final/official', natureYear: '待同步', natureSeason: '2023' }),
            // 邻居：省赛有**多处**落点 ⇒ 靠地区认（浙江 / 广东）
            S('qoj:s:cat-212', 'qoj:s', '省赛'),
            S('qoj:s:cat-212:cat-250', 'qoj:s:cat-212', 'Zhejiang'),
            S('qoj:s:cat-212:cat-250:2025', 'qoj:s:cat-212:cat-250', '2025'),
            C('qoj:c:11', 'qoj:s:cat-212:cat-250:2025', { natureClass: 'qoj/xcpc/provincial&invitational/official', natureYear: '2025', natureSeason: '2025', natureRegion: '浙江' }),
            S('qoj:s:cat-212:cat-213', 'qoj:s:cat-212', 'Guangdong'),
            S('qoj:s:cat-212:cat-213:2024', 'qoj:s:cat-212:cat-213', '2024'),
            C('qoj:c:12', 'qoj:s:cat-212:cat-213:2024', { natureClass: 'qoj/xcpc/provincial&invitational/official', natureYear: '2024', natureSeason: '2024', natureRegion: '广东' })
        ]
    };
}

const parentOf = (recs, key) => (recs.find((r) => (r.synthKey || r.extKey) === key) || {})['父extKey'] || (recs.find((r) => (r.synthKey || r.extKey) === key) || {})['父synthKey'];
const has = (recs, key) => recs.some((r) => (r.synthKey || r.extKey) === key);

// ================================================================
group('判据：兜底桶 / xcpc 那一支 / nature 够不够');
ok(isFallbackLayer('（QOJ 上没挂分类）') && isFallbackLayer('无归类') && isFallbackLayer('其他'), '兜底桶的名字认得出');
ok(!isFallbackLayer('Zhejiang') && !isFallbackLayer('') && !isFallbackLayer(undefined), '别的名字不算兜底桶（空也算不算）');
deepEq(classSegments('qoj/xcpc/ccpc/final'), ['qoj', 'xcpc', 'ccpc', 'final'], '分类路径 → 段');
ok(classIsXcpc('xcpc/icpc/ec') && classIsXcpc('qoj/xcpc/ccpc') && classIsXcpc('cf/gyms/xcpc/icpc'), '`(?/)xcpc` 都算（平台/镜像前缀几层都行）');
ok(!classIsXcpc('cf/contest/div2') && !classIsXcpc('atcoder/abc') && !classIsXcpc('nk/多校') && !classIsXcpc('qoj/xcpc'),
   '★ 别的分支不算；**`qoj/xcpc` 这种"停在半路"的也不算**（末段就是 xcpc ⇒ 没到叶子）');
ok(enoughClass('qoj/xcpc/ccpc/final/official') && !enoughClass('qoj/无归类') && !enoughClass('') && !enoughClass('qoj/xcpc/无分类'),
   'nature"够"= 有值 ∧ 不是无归类/无分类 ∧ 属 xcpc 那一支');
eq(stripYearLayer('qoj:s:cat-205:2025'), 'qoj:s:cat-205', '容器键：掐掉年份层');
eq(stripYearLayer('qoj:s:cat-205:年份未知'), 'qoj:s:cat-205', '容器键：`年份未知` 也掐');
eq(stripYearLayer('qoj:s:cat-205'), 'qoj:s:cat-205', '本来就没有年份层 ⇒ 原样');
eq(stripYearLayer('2024'), '2024', '★ 整个键就是年份层 ⇒ **原样**（不许剥成空串）');
eq(stripYearLayer('年份未知'), '年份未知', '★ 同上：没有冒号的输入不算"末尾有一层"');
eq(stripYearLayer('qoj:s:cat-205:1999'), 'qoj:s:cat-205:1999', '★ 19xx 不是年份层（与应用侧同一口径）');
eq(yearLabel('2026'), '2026', '年份层层名');
eq(yearLabel('待同步'), '年份未知', '不是真年份 ⇒ `年份未知`（不静默丢）');
ok(isRealYear('2024') && !isRealYear('待同步') && !isRealYear('无') && !isRealYear(''),
   '★ 真年份只有 `20xx` —— 与应用侧 `core/natureFields.isRealYear` **同一个函数**'
   + '（自写 `^(19|20)\\d{2}$` 会让 19xx 一层一套判法）');
eq(yearLabel('1999'), '年份未知', '19xx 不算真年份 ⇒ 层名"年份未知"（与应用侧一致）');
eq(seasonLabel({ natureSeason: '2023', natureYear: '2024' }), '2023', '★ 年份层优先取**赛季**（跨年那场）');
eq(seasonLabel({ natureSeason: '待同步', natureYear: '待同步' }), '年份未知', '赛季也不行 ⇒ 退举办年份 ⇒ 还不行就是 `年份未知`');
eq(seasonLabel({ natureSeason: '', natureYear: '2021' }), '2021', '赛季空 ⇒ 退举办年份');

group('落点：同 class 唯一 ⇒ 去那儿；多处 ⇒ 按地区认；没有 ⇒ 报空');
const idx = buildHomeIndex(fixture().records, {
    keyOf: (r) => r.synthKey || r.extKey || '', parentOf: (r) => r['父synthKey'] || r['父extKey'] || ''
});
const qoj = idx.get('qoj');
eq(resolveHome(qoj, 'qoj/xcpc/ccpc/final/official', '').chain, 'qoj:s:cat-205', '同 class 只有一处落点 ⇒ 直接去');
eq(resolveHome(qoj, 'qoj/xcpc/provincial&invitational/official', '浙江').chain, 'qoj:s:cat-212:cat-250', '★ 多处落点 ⇒ 按地区「浙江」认出');
eq(resolveHome(qoj, 'qoj/xcpc/provincial&invitational/official', '四川').chain, '', '★ 地区认不出（27 处都不是它）⇒ 报空、交给类路径（不瞎认）');
eq(resolveHome(qoj, 'qoj/xcpc/icpc/na/无归类', '').chain, '', '同 class 一处都没有 ⇒ 报空');
ok(![...(qoj.get('qoj/xcpc/ccpc/final/official') || new Map()).keys()].includes('qoj:s:no-category'),
   '★ 兜底桶**不会**被当成候选落点（否则它会把自己变成"邻居"）');
deepEq(classPathLayers('qoj', 'qoj/xcpc/ccpc/final/official'),
   { keys: ['qoj:s:xcpc', 'qoj:s:xcpc:ccpc', 'qoj:s:xcpc:ccpc:final', 'qoj:s:xcpc:ccpc:final:official'], names: ['xcpc', 'ccpc', 'final', 'official'] },
   '类路径铺：每段一层（树根那段掐掉）');

group('搬：该搬的搬、不该动的一个字不动');
{
    const doc = fixture();
    const { moved, buckets } = rehome(doc);
    const recs = doc.records;
    eq(moved.length, 3, `该搬的三场都搬了（含"年份层兜底桶里的那场"，实际 ${moved.length}）`);
    eq(parentOf(recs, 'qoj:c:1'), 'qoj:s:cat-205:2025', '① 跟同 class 的邻居走 + 自己那年的年份层');
    eq(parentOf(recs, 'qoj:c:2'), 'qoj:s:cat-212:cat-250:2026', '② 多处落点按地区认（浙江 ⇒ Zhejiang）');
    eq(parentOf(recs, 'qoj:c:3'), 'qoj:s:no-category', '★ nature 不够（无归类）⇒ 原地不动');
    eq(parentOf(recs, 'qoj:c:4'), 'qoj:s:no-category', '★ 不是 xcpc 那一支 ⇒ 原地不动（限定范围）');
    eq(parentOf(recs, 'qoj:c:11'), 'qoj:s:cat-212:cat-250:2025', '邻居一个都没被动过');
    ok(has(recs, 'qoj:s:no-category'), '桶里还剩人 ⇒ 桶还在（这里还有两个原地不动的）');
    ok(has(recs, 'qoj:s:cat-205:2023'),
       '★ `年份未知` 里的那场（赛季 2023）按**赛季轴**搬到 `2023` 层（xcpc 系列按赛季分）');
    // 那场的 `年份未知` 桶因此空了 ⇒ 一并收掉（"年份未知"也是兜底桶）
    deepEq(buckets.map((b) => b.key), ['qoj:s:cat-205:年份未知'], '年份层空掉 ⇒ 收掉它');
    // 搬完要重排（父在前、同层按规则）——这里只钉"父一定在子之前"
    const pos = new Map(recs.map((r, i) => [r.synthKey || r.extKey, i]));
    ok(pos.get('qoj:s:cat-205') < pos.get('qoj:s:cat-205:2025') && pos.get('qoj:s:cat-205:2025') < pos.get('qoj:c:1'),
       '记录顺序：容器在年份层之前、年份层在比赛之前');
}
{
    // 桶里只剩"该搬的" ⇒ 搬完桶要收掉
    const doc = fixture();
    doc.records = doc.records.filter((r) => !['qoj:c:3', 'qoj:c:4'].includes(r.synthKey || r.extKey));
    const { moved, buckets } = rehome(doc);
    eq(moved.length, 3, '三场都搬走（含年份层兜底桶那场）');
    eq(buckets.length, 2, '空掉的两个兜底桶都收掉了（分类层那个 + 年份层那个）');
    ok(!has(doc.records, 'qoj:s:no-category'), '桶的记录也真的从包里没了');
}
{
    // 幂等：再跑一遍 ⇒ 没有可搬的
    const doc = fixture();
    rehome(doc);
    const again = rehome(doc);
    eq(again.moved.length, 0, '再跑一遍无事可做（幂等）');
}
{
    // ★ `--dry-run` 必须报出"**将**删哪几个兜底桶"，且与真跑结果一致。
    //   桶的收集若被 `!dryRun` 挡住 ⇒ 试跑看不到删除、删除路径没有测试。
    const mk = () => {
        const d = fixture();
        d.records = d.records.filter((r) => !['qoj:c:3', 'qoj:c:4'].includes(r.synthKey || r.extKey));
        return d;
    };
    const dryDoc = mk();
    const before = JSON.stringify(dryDoc.records);
    const dry = rehome(dryDoc, true);
    eq(dry.moved.length, 3, 'dry-run 照样算出要搬 3 场');
    deepEq(dry.buckets.map((b) => b.key), ['qoj:s:no-category', 'qoj:s:cat-205:年份未知'],
        '★ dry-run 报出要收掉的两个桶（分类层 + 年份层）');
    eq(JSON.stringify(dryDoc.records), before, 'dry-run 一个字都没改');

    const realDoc = mk();
    const real = rehome(realDoc, false);
    deepEq(dry.buckets, real.buckets, '★ 试跑与实际写盘的"要收掉的桶"完全一致');
    ok(!has(realDoc.records, 'qoj:s:no-category'), '真跑确实把它删掉了');
}
{
    // 无邻居参考：按类路径铺，且年份层取**赛季**
    const doc = {
        records: [
            { 节点类型: 'W', extKey: 'qoj', name: 'QOJ' },
            S('qoj:s', 'qoj', '系列'),
            S('qoj:s:no-category', 'qoj', '（QOJ 上没挂分类）'),
            C('qoj:c:9', 'qoj:s:no-category', { natureClass: 'qoj/xcpc/icpc/ec/final/official', natureYear: '待同步', natureSeason: '2023' })
        ]
    };
    const { moved } = rehome(doc);
    eq(moved.length, 1, '没有邻居也搬（分类 + 赛季就够定位）');
    eq(moved[0].to, 'qoj:s:xcpc:icpc:ec:final:official:2023', '★ 按类路径铺 + 赛季 2023（举办年份是 `待同步`，靠赛季才定得下来）');
    ok(has(doc.records, 'qoj:s:xcpc') && has(doc.records, 'qoj:s:xcpc:icpc:ec:final:official'),
       '中间那几层也按段铺出来了（每段一层）');
    eq(doc.records.find((r) => (r.synthKey || r.extKey) === 'qoj:s:xcpc:icpc:ec:final:official:2023').name, '2023', '年份层的层名');
    eq(doc.records.find((r) => (r.synthKey || r.extKey) === 'qoj:s:xcpc').name, 'xcpc', '每段的层名就是那一段');
}

group('精简层：只剩赛季区别的组，收掉赛季层');
{
    const S = (key, parent, name) => ({ 节点类型: 'S', extKey: key, '父extKey': parent, name });
    const C = (key, parent, cls, time) => ({ 节点类型: 'C', extKey: key, '父extKey': parent, natureClass: cls, contestTime: time });
    ok(isSeasonLayer({ 节点类型: 'S', name: '2024' }) && isSeasonLayer({ 节点类型: 'S', name: '年份未知' }),
        '赛季层：`20xx` / `年份未知`');
    ok(!isSeasonLayer({ 节点类型: 'S', name: 'Central Europe' }) && !isSeasonLayer({ 节点类型: 'C', name: '2024' }),
        '别的层 / C 都不是赛季层');
    ok(!isSeasonLayer({ 节点类型: 'S', name: '1999' }),
        '★ 19xx 不算赛季层（`^20\\d{2}$` 是唯一真源）');
    const doc = {
        records: [
            { 节点类型: 'W', extKey: 'qoj', name: 'QOJ' },
            S('qoj:s:a', 'qoj', 'Europe'),
            // ① 三场同 class、每层一场（只有赛季不同）⇒ 三层都收掉
            S('qoj:s:a:2022', 'qoj:s:a', '2022'),
            S('qoj:s:a:2023', 'qoj:s:a', '2023'),
            S('qoj:s:a:2024', 'qoj:s:a', '2024'),
            C('qoj:c:1', 'qoj:s:a:2022', 'qoj/xcpc/icpc/eu/regional/official', '2022.11.01'),
            C('qoj:c:2', 'qoj:s:a:2023', 'qoj/xcpc/icpc/eu/regional/official', '2023.11.01'),
            C('qoj:c:3', 'qoj:s:a:2024', 'qoj/xcpc/icpc/eu/regional/official', '2024.12.01'),
            // ② class 混着 ⇒ 一层都不动
            S('qoj:s:b', 'qoj', 'Asia East Continent'),
            S('qoj:s:b:2024', 'qoj:s:b', '2024'),
            C('qoj:c:4', 'qoj:s:b:2024', 'qoj/xcpc/icpc/ec/regional/official', '2024.11.01'),
            C('qoj:c:5', 'qoj:s:b:2024', 'qoj/xcpc/icpc/ec/final/official', '2024.12.01'),
            // ③ 赛季层里混着非 C（热身赛层）⇒ 整组不动
            S('qoj:s:c', 'qoj', 'CCPC'),
            S('qoj:s:c:2025', 'qoj:s:c', '2025'),
            C('qoj:c:6', 'qoj:s:c:2025', 'qoj/xcpc/ccpc/final/official', '2025.05.01'),
            S('qoj:s:c:2025:warm-up', 'qoj:s:c:2025', '热身赛'),
            C('qoj:c:7', 'qoj:s:c:2025:warm-up', 'qoj/xcpc/ccpc/final/warm-up', '2025.05.02'),
            // ④ 省赛：class 一样，但**每季多场** ⇒ 赛季层有用，一层都不收
            S('qoj:s:d', 'qoj', 'Chinese Provincial / Invitational'),
            S('qoj:s:d:2024', 'qoj:s:d', '2024'),
            C('qoj:c:8', 'qoj:s:d:2024', 'qoj/xcpc/provincial&invitational/official', '2024.05.01'),
            C('qoj:c:9', 'qoj:s:d:2024', 'qoj/xcpc/provincial&invitational/official', '2024.06.01')
        ]
    };
    const { collapsed, moved } = collapseSeasonLayers(doc);
    const has = (k) => doc.records.some((r) => (r.synthKey || r.extKey) === k);
    const par = (k) => (doc.records.find((r) => (r.synthKey || r.extKey) === k) || {})['父extKey'];
    eq(collapsed.length, 1, '只有 ① 那一组该收（② class 混、③ 有热身赛层、④ 每季多场）');
    eq(moved, 3, '三场比赛上提一层');
    ok(!has('qoj:s:a:2022') && !has('qoj:s:a:2024'), '赛季层被收掉');
    eq(par('qoj:c:2'), 'qoj:s:a', '比赛直接挂在容器下');
    ok(has('qoj:s:b:2024') && par('qoj:c:4') === 'qoj:s:b:2024', '★ class 混着的组一层不动');
    ok(has('qoj:s:c:2025') && has('qoj:s:c:2025:warm-up'), '★ 赛季层里有「热身赛」层 ⇒ 不动');
    ok(has('qoj:s:d:2024') && par('qoj:c:9') === 'qoj:s:d:2024',
        '★ 省赛那种"每季多场"的同 class 组 ⇒ 赛季层留着');
    // 幂等
    eq(collapseSeasonLayers(doc).collapsed.length, 0, '再跑一遍无事可做（幂等）');
}

group('命令行：没得搬时不动磁盘（真跑一遍 CLI）');
{
    const clean = { records: [{ 节点类型: 'W', extKey: 'qoj', name: 'QOJ' }] };
    const p = path.join(tmp, 'clean.json');
    fs.writeFileSync(p, JSON.stringify(clean, null, 2) + '\n', 'utf8');
    const before = fs.readFileSync(p, 'utf8');
    const res = spawnSync(process.execPath, [SCRIPT, '--package', p], { stdio: 'inherit', cwd: ROOT });
    eq(res.status, 0, '退出码 0（没有问题不是失败）');
    eq(fs.readFileSync(p, 'utf8'), before, '没有可搬的 ⇒ 文件一个字节都没动');
}
{
    // 有得搬：CLI 真写盘 + 无 BOM + 缩进 2（与 crate-merge 同口径）
    const doc = fixture();
    const p = path.join(tmp, 'dirty.json');
    fs.writeFileSync(p, JSON.stringify(doc), 'utf8');
    const res = spawnSync(process.execPath, [SCRIPT, '--package', p], { stdio: 'inherit', cwd: ROOT });
    eq(res.status, 0, '退出码 0');
    const raw = fs.readFileSync(p, 'utf8');
    ok(raw.startsWith('{\n  "records"'), '写出来的口径与 crate-merge 一致（缩进 2、无 BOM）');
    ok(raw.endsWith('\n'), '末尾有换行');
    const after = JSON.parse(raw);
    // ⚠️ 这里只钉"搬到 CCPC 那棵子树里去了"：落位之后**精简层那一步还会再动一次**
    //    （这个夹具里 `cat-205` 底下只剩一种 class ⇒ 赛季层会被收掉 ⇒ 直接挂 `cat-205`）
    ok(after.records.some((r) => r.extKey === 'qoj:c:1'
        && String(r['父extKey'] || '').startsWith('qoj:s:cat-205')), '搬动落盘了（落进了 CCPC 那支）');
    ok(!JSON.stringify(after).includes('"父synthKey"'), '合成父那种引用没被写上（这里父都是 extKey 节点）');
}

fs.rmSync(tmp, { recursive: true, force: true });
report();
