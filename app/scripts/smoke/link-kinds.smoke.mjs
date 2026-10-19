// ================================================================
// 冒烟测试：**真实 crate** 上的链接分类（scripts/smoke/link-kinds.smoke.mjs）
//
// 为什么要有它：`src/test/linkKinds.test.js` 是手搓 raw 记录的**单元**测试，
// 绕过了 `parse.js` 与 fieldMap —— 而"元列能不能活着穿过真实解析路径"恰恰是最容易
// 悄悄坏掉的一环（`链接分类` 必须留在 `rec.raw` 里，不能被当成业务列吞掉）。
// 这里直接拿 `acm-data/nodes/xcpc.json` 跑一遍 parseCrate → buildPlan。
//
// 钉三件事：
//   1. **所有类别的链接都进 `link`**（只有一个链接字段）；
//   2. 缓存值按类别优先级挑：补题 → 榜单 → 仓库 → 其它（有补题时它就是补题链接）；
//   3. 其余类别（仓库/其它）**一条都不丢**，以 `linkKind` 进来源层。
// ================================================================
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { parseCrate } from '../../src/features/AutoImport/parse.js';
import { buildPlan } from '../../src/features/AutoImport/plan.js';
import { applyFieldMap, RESERVED_KEYS } from '../../src/features/AutoImport/fieldmap.js';
import { buildExtKeyIndex } from '../../src/core/ops/upsert.js';
import { LINK_KIND_PRIORITY } from '../../src/core/linkKinds.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// ⚠️ `nodes/xcpc.json` 只含属于 xcpc 的内容（不混其它渠道）：
//    · `mix_contain_xcpc.json` = 7 个 XCPC 来源包 + 合成节点包（**不含** atcoder / cf-contest）
//    · `all_nodes.json`        = 上面那个 + atcoder + cf-contest + 牛客多校 + 杭电多校
//    这里要的是"含全部树的那一份"（下面那几个锚点分散在 qoj / aux-* 各棵树里）⇒ 用 all_nodes。
// ⚠️ **树包是生成物**（`clean-personal` 档位 1 会删它，用户 2026-10-19 定）⇒ 不在时**整份跳过**
//    （不是失败：与 `auto-import.smoke.mjs`「缺样本就跳过」同口径）。要真跑这个契约先产包：
//    `npm run build:all`（整链）或 `npm run crate:hdu` / `crate:xcpc:all`（分类包）。
const PKG = path.join(ROOT, 'acm-data', 'nodes', 'all_nodes.json');
if (!fs.existsSync(PKG)) {
    console.log('   ⏭ 跳过整份冒烟：acm-data/nodes/all_nodes.json 不在'
        + '（树包是生成物，可能刚被清个人数据删掉；先跑 npm run build:all）');
    process.exit(0);
}
const crate = JSON.parse(fs.readFileSync(PKG, 'utf8'));

// 三场各代表一种情况（**每个渠道各自一棵树**，所以钉到"哪棵树上的那个 C"）：
//   aux-xcpcio:c:icpc2025chengdu    —— 榜单（board）
//   aux-rankland:c:icpc2025chengdu  —— 仓库/补题入口（repo / problems）
//   aux-nk:c:gxcpc9th               —— 牛客榜（board，带 `#rank` 锚点）
//   aux-pta:c:icpc2026preliminary-1 —— PTA 榜
//   qoj:c:2567                      —— QOJ 那棵树自己的补题入口
const WANT = ['aux-xcpcio:c:icpc2025chengdu', 'aux-rankland:c:icpc2025chengdu',
    'aux-nk:c:gxcpc9th', 'aux-rankland:c:gxcpc9th', 'aux-pta:c:icpc2026preliminary-1',
    'qoj:c:2567'];

// ⚠️ 祖先容器（W + 所有 S）必须一起留下：少了它们，plan 会把每条记录
// 按 `parent-not-found` 拒掉（实测第一次就是这么失败的）。这里从锚点**沿父链**收，
// 顺带把锚点的子树（P / R）一起带上。
const byExtKey = new Map(crate.records.map(r => [r.extKey, r]));
const need = new Set();
for (const k of WANT) {
    for (let cur = k; cur; ) {
        need.add(cur);
        const rec = byExtKey.get(cur);
        cur = rec && rec['父extKey'];
    }
    for (const r of crate.records) {
        if (String(r.extKey).startsWith(k + ':')) need.add(r.extKey);
    }
}
const keep0 = crate.records.filter(r => need.has(r.extKey));

// ⚠️ 再补一遍**父链**：上面那套"锚点 + 祖先 + `锚点:` 前缀的子树"会把**同前缀的旁支**也带进来
// （它以 `qoj:c:2567:` 开头），可那些旁支的父**不在主节点的父链上** ⇒
// 少了它，plan 会把这条按 `parent-not-found` 拒掉（实测就是这么失败的）。
// 这里对留下的每条再沿父链补齐 —— 只补"留下的记录真正需要的那几个容器"。
for (const r of keep0) {
    for (let cur = r['父extKey']; cur && !need.has(cur); ) {
        need.add(cur);
        const rec = byExtKey.get(cur);
        cur = rec && rec['父extKey'];
    }
}
const keep = crate.records.filter(r => need.has(r.extKey));

const res = parseCrate({ ...crate, records: keep });
assert.equal(res.ok, true, `parseCrate 失败：${JSON.stringify(res.errors)}`);

// ① 元列必须活着穿过解析（这是本冒烟测试存在的理由）
for (const r of res.crate.records) {
    if (WANT.includes(r.extKey)) {
        assert.ok(r.raw['链接分类'], `${r.extKey} 的「链接分类」在 parseCrate 后丢了`);
    }
}

const state = {
    rootId: 'o',
    nodes: { o: { id: 'o', type: 'O', name: '根' } },
    childOrder: { o: [] },
    parentOf: { o: null }
};
const p = buildPlan({
    crate: res.crate,
    state,
    keyIndex: buildExtKeyIndex(state),
    applyFieldMap: (record, fieldMap) => applyFieldMap(record, fieldMap, {
        reservedKeys: RESERVED_KEYS
    })
});
assert.equal(p.summary.errors, 0, `计划里有错误：${JSON.stringify(p.errors)}`);

const byKey = Object.fromEntries(p.records.map(r => [r.extKey, r]));
const othersOf = rec => ((rec.otherValues || {}).link || []);
const kindsOf = rec => othersOf(rec).map(x => x.linkKind);
// 这条记录的 `link` **全部**类别：被选中的那个 + 落选的（只有一条候选时它就在"选中"那边）
const allKindsOf = rec => [(rec.linkKindsByField || {}).link, ...kindsOf(rec)].filter(Boolean);

// ② 成都站：链接按**渠道**分家 —— xcpcio 那棵树上只有榜单，rankland 那棵树上有仓库/补题
{
    const rec = byKey['aux-xcpcio:c:icpc2025chengdu'];
    assert.equal(rec.fields.link, 'https://board.xcpcio.com/icpc/50th/chengdu',
        'xcpcio 那棵树上就一条榜单链接 → 缓存值取它');
    assert.equal(rec.fieldSources.link, 'xcpcio-icpc2025chengdu', '缓存值的出处要是 xcpcio');
    assert.equal(rec.linkKindsByField.link, 'board', '缓存值的类别也带下去');
    const rl = byKey['aux-rankland:c:icpc2025chengdu'];
    assert.ok(allKindsOf(rl).includes('repo'), '仓库类链接留在 rankland 那棵树上（一条都不丢）');
    // 落选值全都要带类别（否则界面上会掉进「未分类」组）
    for (const x of othersOf(rl)) {
        assert.ok(x.linkKind, `落选值缺类别：${JSON.stringify(x)}`);
    }
}

// ②b QOJ 那棵树：同场的补题入口在**它自己**的 C 上（不是丢了，是搬走了）
{
    const rec = byKey['qoj:c:2567'];
    assert.ok(rec, 'QOJ 树的比赛节点在计划里');
    assert.equal(rec.fields.link, 'https://qoj.ac/contest/2567', 'QOJ 场次页链接挂在自己的 C 上');
    assert.equal(rec.linkKindsByField.link, 'problems', '类别仍是补题入口');
    assert.equal(rec.fieldSources.link, 'qoj', '出处是 QOJ 那个片段（整棵树一个片段）');
    // S 层就是 **QOJ 自己的分类**（严格按 qoj 的分类来），
    // 分类 id 是活的 ⇒ 只钉形状：一条 `qoj:s:cat-…` 的链。
    // ⚠️ **末尾还会有一层年份**（分类链走完统一补 `:<年份>`）⇒
    //    形状允许最后多一段 `20xx` / `年份未知`。
    assert.ok(/^qoj:s:cat-\d+(:cat-\d+)*(:(\d{4}|年份未知))?$/.test(rec.parentExtKey),
        '挂在 qoj → 分类 S 链下（可带年份层）');
}

// ③ gxcpc9th：牛客那棵树上只有榜单 → 缓存值就是它（`link` 不会空着）
// ⚠️ 牛客的榜单链接用 **`#rank` 锚点**（格式是 `…/contest/<cid>#rank`；
//    裸比赛页会停在题目列表、还得自己找榜单标签）—— 所以这里钉的是带锚点那个。
{
    const rec = byKey['aux-nk:c:gxcpc9th'];
    assert.equal(rec.fields.link, 'https://ac.nowcoder.com/acm/contest/136164#rank', '没有补题 → 退到榜单');
    assert.equal(rec.linkKindsByField.link, 'board');
    // 仓库那条在 **rankland 那棵树**上（各渠道各出各的，不再合并到同一个 C 上）
    const rl = byKey['aux-rankland:c:gxcpc9th'];
    assert.ok(allKindsOf(rl).includes('repo'), '仓库类链接要留在 rankland 那棵树上');
}

// ④ 全树的硬性不变量：`link` 的**所有**值都带类别，且缓存值就是按优先级挑出来的
{
    const PRIORITY = LINK_KIND_PRIORITY;   // ⚠️ 不许自造名单（手写 4 项会漏掉 browse，生产是 5 项）
    let checked = 0;
    for (const rec of p.records) {
        if (rec.type !== 'C') continue;
        checked++;
        const picked = rec.fields.link;
        if (!picked) continue;
        const others = othersOf(rec);
        const kind = (rec.linkKindsByField || {}).link;
        assert.ok(PRIORITY.includes(kind), `${rec.extKey} 的缓存值类别非法：${kind}`);
        assert.equal(others.some(x => x.v === picked), false, '缓存值不该重复出现在落选值里');
        // 落选值全都要带类别（否则界面上会掉进「未分类」组）
        for (const x of others) {
            assert.ok(x.linkKind, `${rec.extKey} 的落选值缺类别：${JSON.stringify(x)}`);
        }
        // 没有更高优先级的类别在落选值里（否则说明挑选规则没生效）
        const higher = PRIORITY.slice(0, PRIORITY.indexOf(kind));
        assert.equal(others.some(x => higher.includes(x.linkKind)), false,
            `${rec.extKey} 的 ${kind} 被选中，却还有更高优先级的落在落选值里`);
    }
    assert.ok(checked >= 3, `至少检查了 3 个 C 节点，实际 ${checked}`);
}

console.log('✅ 链接分类：真实 crate 上 parseCrate → buildPlan 全通');
console.log('   成都站（xcpcio 树）link =', byKey['aux-xcpcio:c:icpc2025chengdu'].fields.link);
console.log('   成都站（rankland 树）候选 =',
    allKindsOf(byKey['aux-rankland:c:icpc2025chengdu']).join('/'));
console.log('   gxcpc9th（牛客树）link =', byKey['aux-nk:c:gxcpc9th'].fields.link);

// ================================================================
// ⑤ 单来源包（hdu / nk）：它们**不走 crate-merge**，片段里的 `链接分类` 本来是裸 URL
//
// ⚠️ 这条钉住的 bug："杭电/牛客的比赛链接丢了"。
// 根因：`readLinkKinds` 按 `filter(x => x.src && …)` 读 —— 而这两个平台的流水线
// **不走 crate-merge**，适配器写的是 `{problems: ["https://…"]}`（没有 `src`），
// 于是条目被整批过滤掉、C 的 `link` 一片空白。xcpc 因为过了 merge、每条都带 `src`
// 恰好没暴露。
//
// ⚠️ 修法**不是**"读取端两种形状都认"（那等于"数据处理逻辑里有特判"），
//    而是**归一放产出点**：`scripts/crate.py` 的 `Crate._normalize_link_kinds`
//    把裸 URL 补成 `{v, src}`（出处缺省用包来源 id）。**读取端只认唯一形状。**
// ================================================================
for (const [name, sampleKey, expectPrefix] of [
    ['hdu-multi-university', 'hdu:c:1229', 'https://acm.hdu.edu.cn/contest/problems?cid='],
    ['nk-multi-university', 'nk:c:133876', 'https://ac.nowcoder.com/acm/contest/133876']
]) {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'acm-data', 'nodes', `${name}.json`), 'utf8'));
    const res2 = parseCrate(raw);
    assert.equal(res2.ok, true, `${name} parseCrate 应成功：${JSON.stringify(res2.errors)}`);
    const state2 = {
        rootId: 'o',
        nodes: { o: { id: 'o', type: 'O', name: '根' } },
        childOrder: { o: [] },
        parentOf: { o: null }
    };
    const p2 = buildPlan({
        crate: res2.crate,
        state: state2,
        keyIndex: buildExtKeyIndex(state2),
        applyFieldMap: (record, fieldMap) => applyFieldMap(record, fieldMap, {
            reservedKeys: RESERVED_KEYS
        })
    });
    assert.equal(p2.summary.errors, 0, `${name} 计划不该有错误`);
    const cRec = p2.records.find(r => r.extKey === sampleKey);
    assert.ok(cRec, `${name} 的 ${sampleKey} 应在计划里`);
    assert.ok(String(cRec.fields.link || '').startsWith(expectPrefix),
        `${name} 的 C 必须派生到比赛链接（实际 ${JSON.stringify(cRec.fields.link)}）`);
    assert.equal((cRec.linkKindsByField || {}).link, 'problems', `${name} 的缓存值类别`);
    // 榜单那条也要留下（带类别）
    assert.ok((((cRec.otherValues || {}).link) || []).some(x => x.linkKind === 'board'),
        `${name} 的榜单链接必须留在落选值里`);
    console.log(`   ${name} link =`, cRec.fields.link);
}
