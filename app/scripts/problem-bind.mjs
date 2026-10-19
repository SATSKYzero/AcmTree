#!/usr/bin/env node
// ================================================================
// 比赛绑定「辅助」题目绑定（scripts/problem-bind.mjs）
//
// 比赛绑定做好后，再辅助其下题目的绑定。
//
// 做什么：**以比赛组为单位**（一个 C 合成组 = `synth:xcpc:<场次标识>`），把组内各成员 C
// 下面的 P **按题号**对上 ⇒ 同一道题的各来源拷贝归成一组：
//   · 组头 = 一个 **P 合成节点**，键 `synth:problem:<场次标识>-<题号>`（**纯函数**，不存）；
//   · **父 = 那个 C 合成节点**（`父synthKey`）—— 即"**合成节点 P 随合成节点 C**"；
//   · 成员 = 各来源那份 P，就地写 `ownerSynth`。
//   ⚠️ **记录自己的 `problemId` 一个字都不改**（理由见 `bindProblems` 里那段）：
//      题号是**各来源自己的事实**，"哪条属于哪一组"由配对算、落在 `ownerSynth` 上就够了。
//
// ★ **组头名字的真源**：`acm-data/nature-assignments.json`（应用「📤 导出人工填写」写的那一份）
//   的 `confirmedGroups` —— 人确认过的那一组，组名**取人给的那份快照**。
//   为什么非读它不可（实测）：`xcpc_pipeline` 那一步会把**上一轮的 P 层记录整批收掉**
//   （这一轮的输入里一个 P 组头都没有）⇒ 包里的 `已确认` 要到链尾 `baseline2` 才写回来，
//   而本步跑在它**前面** ⇒ 只看包的话 `keepName` 恒为假、人改好的组名每轮被冲掉。
//
// 计划与异常都是**纯函数**算的（`src/core/synthPlan.js` 的 `problemBindPlan`），
// 本文件只做读写外壳 —— 判据只有一份，将来 ⑤ 要报同一批异常时读的是同一个函数。
//
// 题号映射表（`acm-data/synth-registry.json` 的 `problemIdMap`）在这里被喂进去：
// 题号映射表也属于注册表。
//
// ⚠️ **异常一律不自动处理、只报出来**（异常交给人，由人判断是否绑定）
//    —— 题号对不上 / 题名冲突 / 全组无题名，都只计数+打印，人在应用里直接改 `ownerSynth`。
// ⚠️ **不许抢别人的成员**：已经绑在**非本步建的**组上的 P（例如 CF/AtCoder 复用题那批
//    `synth:problem:<老家 extKey>`）一个字不动，只记账。判据 = 那个键**是不是一个有 `父synthKey` 的 P 合成节点**。
//
// 用法：node scripts/problem-bind.mjs <包> [--dry-run] [--quiet] [--baseline <文件>]
// ================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONFIRM_FIELD as PLAN_CONFIRM_FIELD, PROBLEM_SYNTH_PREFIX, problemBindPlan } from '../src/core/synthPlan.js';
import { isHumanBoundOwner } from '../src/core/natureConfidence.js';
import { SYNTH_PROBLEM_ID_MAP, problemIdMapOf } from '../src/core/synthRegistry.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** baseline 的默认位置 —— 与 `scripts/nature-baseline.py` 的 `--baseline` 默认值**同一个文件** */
const DEFAULT_BASELINE = path.join(HERE, '..', 'acm-data', 'nature-assignments.json');

/** 一条记录是不是"**本步建的** P 合成节点"（判据：键有 `synth:problem:` 前缀 **且** 有 `父synthKey`） */
const isOurSynth = (r) => String(r && r.synthKey || '').startsWith(PROBLEM_SYNTH_PREFIX)
    && !!String(r && r['父synthKey'] || '').trim();

//: ★ **"人确认过这一组"的标记** —— 存在**组头自己**的一格上（**组级**、一条）。
//  为什么必须组级（实测的坑）：以前它塞在**每条成员**的 `分类依据.ownerSynth='manual:set'` 里，
//  而那个格同时被"脚本改过指针 / 应用动作"写着（`applyOwnerSynth` 一律打它）⇒
//  "确认"的语义被污染成"任何一次动作"，于是脚本产出的指针也被当成"人的结论"锁死
//  （"点一次换一次、永远改不动"就是这么来的）。改成组级之后：
//    · 它只表达"人看过这一组、认为对"这一件事；
//    · 脚本那些动作**不写它**；
//    · 导出 / 回代 / 包都带着它 ⇒ 重建不丢。
// ⚠️ 名字的**唯一定义**在 `src/core/synthPlan.js`（应用侧也读那一份）—— 这里 import，别再抄一遍。
const CONFIRM_FIELD = PLAN_CONFIRM_FIELD;

/** 这一组（组头）是不是被人确认过 */
const isConfirmedHead = (r) => !!(r && (r[CONFIRM_FIELD] === true || r[CONFIRM_FIELD] === '是'));

/**
 * 读 baseline 里**「人确认过这一组」**那一节：组键 → 人给的那个组名。
 *
 * ⚠️ 只取两个字段（`synthKey` / `name`）：这一节**完整形状**的校验住在
 *    `scripts/nature_baseline_lib.py`（回代那一侧才是权威），这里是为"组名别被冲掉"读的。
 *    JSON 读不出来（被截断/写坏）⇒ **当场抛**：那是人的数据坏了，不该静默当"没有"。
 *    文件不存在（新克隆 / 没导出过）⇒ 空表，照旧按计划取名。
 *
 * @returns {Map<string,string>} 组键 → 名字（可能是空串：那一格本来就空）
 */
export function readConfirmedNames(baselinePath = DEFAULT_BASELINE) {
    const out = new Map();
    if (!fs.existsSync(baselinePath)) return out;
    const doc = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
    for (const one of (doc && doc.confirmedGroups) || []) {
        if (!one || typeof one !== 'object') continue;
        const key = String(one.synthKey || '').trim();
        if (!key) continue;
        out.set(key, String(one.name || ''));
    }
    return out;
}

/**
 * 算并落地（**纯逻辑部分在 `problemBindPlan`**；这里只管改 `doc.records`）。
 *
 * @param {Object} doc - 包（原地改 `doc.records`）
 * @param {boolean} [dryRun] - true ⇒ 只算不写
 * @param {Map<string,string>} [confirmedNames] - baseline 的 `confirmedGroups`（组键 → 人给的组名）
 * @returns {Object} 统计（`main()` 打印它）
 */
export function bindProblems(doc, dryRun = false, confirmedNames = new Map()) {
    const records = doc.records || [];
    // ★ **本步只写"归属与组"，一个字都不改记录自己的题号**。
    //   为什么（这是踩出来的判法）：题号是**各来源自己的事实**（QOJ 就把它那一场排成那样），
    //   "哪条属于哪一组"由配对算出来、落在 `ownerSynth` 上就够了 —— **不需要、也不该**把
    //   算出来的规范题号写回记录。写回去会立刻自伤：
    //     · 这一趟的产物被写进包里 ⇒ 同一份包上再算一遍（`synth-bind` 还要算一遍、
    //       应用侧读树时也要算一遍）时，**第二遍读到的就是第一遍写进去的值**
    //       ⇒ 同一条记录两趟坐到不同的号 ⇒ 两套答案互相打架；
    //     · 应用侧看到的就是"点一次换一次、永远改不动"（用户实测）。
    //   ⇒ 判法只有一条：**输入不动，答案就稳**。
    //   代价：不同来源的同名题在卡片上可能显示各自的字母（那是如实的），⑤ 不再因此报错。

    // 现状：本步建的 P 合成节点（上一次构建留下的）
    const mine = new Map();                       // key → 记录
    for (const r of records) if (isOurSynth(r)) mine.set(String(r.synthKey), r);
    // ★★ **"人确认过"现在是组级标记**（存在组头自己那格 `已确认` 上）。
    //   名册来源：① **baseline 的 `confirmedGroups`**（人刚在应用里点的那些 —— 见下面那条）；
    //   ② 包里组头自己带 `已确认`；③ **兼容老数据** —— 成员身上那套
    //   `分类依据.ownerSynth='manual:set'` 仍然认（否则这次重建会把已经确认过的组全忘掉）。
    //   ⚠️ ①**不是可有可无的**：`xcpc_pipeline` 把上一轮的 P 层记录整批收掉 ⇒ 这一轮的
    //     输入里**一个带标记的组头都没有**（②③ 都落空）。只有 ① 认得人刚确认过的那些。
    const confirmedKeys = new Set();
    for (const r of records) {
        if (isOurSynth(r) && isConfirmedHead(r)) confirmedKeys.add(String(r.synthKey));
    }
    for (const r of records) {
        if (isHumanBoundOwner(r) && String(r.ownerSynth || '').trim()) confirmedKeys.add(String(r.ownerSynth).trim());
    }
    for (const key of confirmedNames.keys()) confirmedKeys.add(String(key));

    // ⚠️ **算计划这一步必须排在"人名册"之后**：`confirmedKeys`（人确认过的那批组键）要传进去，
    //    否则这一步**看不到人确认过谁** —— 组头是它自己刚建的、"包里的 `已确认`"更还没写回来
    //    ⇒ 那 47 处**已经确认过**的题名冲突会被当成"交给人"报出来，而应用侧 ⑤ 同一时刻说得
    //    清清楚楚"没有待判"（两边对不上，一次实测：日志说 47、⑤ 说 0）。
    const plan = problemBindPlan(records, problemIdMapOf, confirmedKeys);
    const wanted = new Set(plan.groups.map((g) => g.key));

    // ---- ① 组头：要的建/更新，多出来的删掉 ----
    //   ★ **组头名 = 这一号上"题名与官方对得上的那一条"的名字**（`plan.groups[].name` 就是这么来的）。
    //     ⚠️ 这一条必须成立，否则包会**自相矛盾**：成员题号被排座位改正过（`2026 东北`：
    //       QOJ 的 `电梯` 从 `C` 改到 `D`），而组头名却从**另一个来源那条号还没改的记录**上取
    //       ⇒ 出现"组头叫 `D` 的题、成员题号写着 `C`"这种局面，应用侧会如实报成
    //       「题名不一致」（实测 4 处）。所以下面**名字一律以计划为准**（人确认过的除外）。
    let created = 0;
    let updated = 0;
    const toDelete = [...mine.keys()].filter((k) => !wanted.has(k));
    for (const g of plan.groups) {
        const cur = mine.get(g.key);
        // ★ **人确认过的组：名字不覆盖**（整组无题名照旧提示，但可以直接绑）。
        //   整组无题名的组头是**兜底名** `A（题名缺失）`，得让人改得动：在树上改名 + 在 ⑤ 点
        //   「✓ 确认这一场」⇒ 组头带上 `已确认` ⇒ 以后每次重建都保住这个名字。
        //   没确认过的照旧按计划覆盖（否则"题名后来补上了"就永远更新不进组头）。
        const keepName = confirmedKeys.has(String(g.key));
        // ★ **人确认过的那一组：组名取 baseline 里那份快照**（应用导出时抄下的、人给的名字）。
        //   为什么非要在这一层落地：`keepName` 只说了"别按计划覆盖"，可这一轮的头**多半
        //   是刚被收掉重建的**（`cur` 常常根本不存在）⇒ 名字只能由这里**带进来**。
        //   baseline 里那一格是空串（老格式 / 组头本来没名字）⇒ 退回计划里的名字。
        const keepText = keepName ? String(confirmedNames.get(String(g.key)) || '').trim() : '';
        const wantName = keepText || g.name;
        if (cur) {
            const same = cur.name === wantName && String(cur.problemId || '') === g.problemId
                && String(cur['父synthKey'] || '') === g.parentSynthKey;
            if (!same && !dryRun) {
                if (!keepName) cur.name = g.name;
                else if (wantName !== cur.name) cur.name = wantName;
                cur.problemId = g.problemId;
                cur['父synthKey'] = g.parentSynthKey;
            }
            if (!same) updated++;
            // 已经确认过的组：把**组级标记**补到组头上（老数据从成员那套迁过来）
            if (!dryRun && keepName && !isConfirmedHead(cur)) cur[CONFIRM_FIELD] = true;
        } else {
            created++;
            if (!dryRun) {
                const head = {
                    节点类型: 'P', synthKey: g.key, 父synthKey: g.parentSynthKey,
                    name: wantName, problemId: g.problemId
                };
                if (keepName) head[CONFIRM_FIELD] = true;
                records.push(head);
            }
        }
    }
    if (!dryRun && toDelete.length) {
        const kill = new Set(toDelete.filter((k) => !confirmedKeys.has(k)));
        doc.records = records.filter((r) => !(r && r.synthKey && kill.has(String(r.synthKey))));
    }

    // ---- ② 成员指针：按计划写；**人绑过/人确认过的**与**别人绑的**都一个字不动 ----
    //   ★ 匹配要能存储『**是否由人确认过**』这一信息 ——
    //     这一信息**没有新造字段**：就是仓库既有的 `分类依据.ownerSynth = 'manual:set'`
    //     （判据 `natureConfidence.isHumanBoundOwner`）。它已经有三重保障：
    //     ① 脚本不动它；② 随「人工填写」导出（`nature-assignments.json`）；③ 产包时**回代**。
    //     ⇒ 人在应用里确认/改过一次，之后每次重建都稳。
    const wantMember = new Map();                 // 成员 extKey → 该归的键
    for (const g of plan.groups) for (const e of g.memberExts) wantMember.set(e, g.key);
    // ⚠️ `ourKeys` 要**包含将被删掉的那些**（`mine` 的全部）—— 不然"指向上一个版本建的、这一轮
    //    要被收掉的键"的成员会被误判成"别人绑的"而跳过（实测踩到：221 条该重绑的被跳过）。
    //    "别人的"另有判据：那个键**不是**一个有 `父synthKey` 的 P 合成节点（如 CF/AtCoder 复用题那批）。
    const ourKeys = new Set(mine.keys());
    let pointed = 0;
    let keptForeign = 0;
    let keptHuman = 0;
    let cleared = 0;
    for (const r of doc.records) {
        const ext = String(r && r.extKey || '').trim();
        if (!ext) continue;
        const cur = String(r.ownerSynth || '').trim();
        const want = wantMember.get(ext);
        if (isHumanBoundOwner(r)) { keptHuman++; continue; }        // ★ 人确认过 ⇒ 一个字不动
        if (want) {
            if (cur && !ourKeys.has(cur)) { keptForeign++; continue; }   // 别人绑的（复用题那批）→ 不动
            if (cur === want) continue;
            pointed++;
            if (!dryRun) r.ownerSynth = want;
        } else if (cur && ourKeys.has(cur)) {
            // 归在本步建的某个组、但已不该归（组没了 / 题号对不上）⇒ 清掉指针
            cleared++;
            if (!dryRun) delete r.ownerSynth;
        }
    }

    return {
        ...plan.stats,
        created, updated, dropped: toDelete.length,
        pointed, cleared, keptForeign,
        renumbered: 0,
        // ★ 「人确认过」这条线有没有真的接上（名字取自人工快照的组数）—— 0 也不该是常态：
        //   它说明 baseline 没被读到（路径不对 / 还没导出），组名正按计划被覆盖。
        confirmedGroups: confirmedNames.size,
        namedByHuman: plan.groups.filter((g) => {
            const k = String(g.key);
            return confirmedKeys.has(k) && String(confirmedNames.get(k) || '').trim() !== '';
        }).length,
        anomalies: plan.anomalies,
        mapRows: SYNTH_PROBLEM_ID_MAP.length
    };
}

function main(argv) {
    const args = { package: '', dryRun: false, quiet: false, baseline: DEFAULT_BASELINE };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--dry-run') args.dryRun = true;
        else if (a === '--quiet') args.quiet = true;
        else if (a === '--baseline') args.baseline = argv[++i] || '';
        else if (!a.startsWith('-')) args.package = a;
    }
    if (!args.package) {
        console.error('用法: node scripts/problem-bind.mjs <包> [--dry-run] [--quiet] [--baseline <文件>]');
        return 2;
    }
    // ★ 人确认过的那份名单（组名不许被冲掉）—— 读不到文件 ⇒ 空表，退回"按计划取名"
    let confirmedNames = new Map();
    try {
        confirmedNames = readConfirmedNames(args.baseline);
    } catch (err) {
        console.error(`❌ baseline 读不出来（${args.baseline}）：${err && err.message ? err.message : err}`
            + ' —— 人确认过的组名这一轮会被计划名覆盖，先修好它再重建。');
        return 2;
    }
    const doc = JSON.parse(fs.readFileSync(args.package, 'utf8'));
    const res = bindProblems(doc, args.dryRun, confirmedNames);
    if (!args.quiet) {
        console.log(`📝 比赛绑定辅助题目绑定（P 随 C）：比赛组 ${res.cGroups} 个`
            + ` ⇒ P 合成组 ${res.groups} 个（新建 ${res.created}｜更新 ${res.updated}｜收掉 ${res.dropped}）`
            + `｜绑上成员 ${res.pointed} 条（清掉 ${res.cleared}｜**没动别人绑的** ${res.keptForeign}）`);
        console.log(`   🔢 P 指针合计 ${res.boundP} 条｜题号映射表 ${res.mapRows} 行`
            + `｜✅ 人确认过 ${res.confirmedGroups} 组（组名取人工快照 ${res.namedByHuman} 组）`);
        const an = res.anomalies;
        const lines = [
            ['题号空', an.noProblemId.length],
            // ⚠️ 整组无题名照旧提示、但可以直接绑：这一类**已经绑上了**，
            //    只是显示名是兜底名 `题号（题名缺失）` ⇒ 措辞别再说"建不出组名"。
            ['整组无题名（已按题号绑上，显示名是兜底名）', an.noName.length],
            ['题名冲突', an.nameConflicts.length]
        ].filter(([, n]) => n);
        if (lines.length) {
            console.log('   ⚠️ **交给人**（只报不自动处理 —— 在应用里直接改 `ownerSynth`）：'
                + lines.map(([k, n]) => `${k} ${n}`).join('｜'));
            for (const x of an.nameConflicts.slice(0, 5)) {
                console.log(`      · ${x.key}（基准 ${x.base}）`);
                for (const c of x.list.slice(0, 2)) console.log(`          ${c.ext}：${c.name} ≠ ${c.base}`);
            }
            for (const x of an.noName.slice(0, 3)) {
                console.log(`      · ${x.cId} 的 ${x.problemId}：整组都没题名 ⇒ 已按题号绑成 `
                    + `${x.key || ('synth:problem:' + x.cId + '-' + x.problemId)}（${x.memberExts.join('、')}）`);
            }
            console.log('      （**以上只印前几条；完整清单在应用「判重整理 → ⑤ 冲突」里**，那儿可点、可改）');
        }
    }
    if (!args.dryRun) fs.writeFileSync(args.package, JSON.stringify(doc, null, 2) + '\n', 'utf8');
    return 0;
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/problem-bind.mjs')) {
    process.exit(main(process.argv.slice(2)));
}
