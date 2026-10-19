// ================================================================
// 体检报告的**纯计算**（core/coverage.js）
//
// 数据来源：包顶层 `reports`（随包发布，见 `scripts/crate-merge.mjs`）。
// 里面两节，都是构建侧的脚本原本就写好的 JSON，这里**只读不判**：
//   · `reports.coverage` ← `scripts/field-coverage.py` → `acm-data/reports/field-coverage.json`
//       `{ package, registryVersion, registrySha, records, rows[29], inconsistent[115], deltas }`
//       `rows` 每行 = 一个「类型 × 字段」：`{ type, field, expect, applies, filled, missing, exempt, why }`
//       `inconsistent` = 同一场比赛里**有的题填了、有的没填**的组：
//       `{ type, field, parent, total, filled, missing_keys[] }`
//   · `reports.needs`    ← `scripts/material-needs.py` → `acm-data/reports/material-needs.json`
//       `{ package, needs[4] }`，每项 = 一条"要补这个字段，去跑这条命令"：
//       `{ id, channel, channelLabel, field, kind, action, why, command, caches, gain, exhausted, groups, sample, partialGroups }`
//
// ⚠️ 这一层**不做任何判定**（"缺"是脚本算好的）：它只排序、分页、算小结、给名字。
//    判定口径（**应该有** = per-contest Rated Yes/No；**实际有** = 抓到没抓到）在
//    `scripts/material-needs.py` 里，界面照着念就行 —— 别在这儿长出第二套规则。
//
// ⚠️ 报告**可能没有**（老包 / 裁剪过的包 / 还没导入过带报告的包）：
//    所有函数拿到 `null` / 缺节都要返回 `null` 或空值，**不抛错**。
// ================================================================
import { EXPECT_LABEL, expectColorOf } from './fieldRegistry.js';
// 「去 Markdown 记号」只有一份实现（`utils/text.js`）：页面上的字与**悬停提示**共用它
import { plainProse } from '../utils/text.js';
import { num } from '../utils/guards.js';

/** 一页画几条（同组不一致那 115 组；DOM 只画当前页 —— 与判重整理一个口径） */
export const GROUP_PAGE_SIZE = 25;
/** 「需求卡片」里最多列几个样例题号（几十个全列出来是堵墙，看命令/条数就够） */
export const NEED_SAMPLE_LIMIT = 12;

/** 需求的两类动作（构建侧 `kind`）：都是**要联网**的，页面上必须说清楚 */
export const NEED_KINDS = Object.freeze({
    'refresh-cache': '刷缓存（联网）',
    'rerun-source': '重跑来源（联网）'
});
/** 千分位（24528 → `24,528`）；非数字原样返回 */
export function fmtNum(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return String(v);
    return n.toLocaleString('en-US');
}

/** 档位中文名（复用 `core/fieldRegistry.js` 那张表，别造第二份） */
export function expectLabel(expect) {
    const key = String(expect || '');
    return EXPECT_LABEL[key] || key || '—';
}

/**
 * 档位颜色 —— **从 `core/fieldRegistry.js` 取**（三档三色的唯一一处）。
 * `ui/coverage/coveragePage.js` 从本模块 import。
 */
export const expectColor = expectColorOf;

/** 这一包带体检报告了吗（两节任一有内容即算有） */
export function hasReports(reports) {
    if (!reports || typeof reports !== 'object') return false;
    return !!(reports.coverage || reports.needs);
}

/**
 * 报告里的 `why` / `action` 是**构建侧写给人看的散文**，带 Markdown 记号（`**强调**`、`` `命令` ``）。
 * 界面把它们当**纯文本**念（不然页面上会原样漏出星号和反引号 —— 需求卡片上的 `rating`
 * 就是这样）。**实现只有一份**（`utils/text.js`，与 `title` 那边共用同一个），这里只是再导出。
 */
export { plainProse };

/**
 * 字段体检那一节的小结。
 * @returns {null|{package, records, registryVersion, rowsTotal, applies, filled, exempt,
 *   missingRows: Array, requiredMissing: Array, expectedMissing: Array, optionalMissing: Array,
 *   requiredMissingCount: number, expectedMissingCount: number, optionalMissingCount: number,
 *   inconsistentTotal: number, inconsistentMissingCount: number,
 *   deltas: {worse, better}}}
 */
export function summarizeCoverage(reports) {
    const cov = reports && reports.coverage;
    if (!cov || typeof cov !== 'object' || !Array.isArray(cov.rows)) return null;

    const rows = cov.rows.filter((r) => r && typeof r === 'object');
    // 缺的行**按档位排序**（真缺 → 应该有 → 可有可无），同档内按缺得多少排。
    // ⚠️ 只按"缺多少"排是错的：「可有可无」那几行（tags 13,329 / ratio 10,722 …）会把
    //    「应该有」那几行（clistDifficulty 530 …）压到 6 行之外 —— 而真正该去补的是后者。
    const rank = (r) => (r.expect === 'required' ? 0 : (r.expect === 'expected' ? 1 : 2));
    const missingRows = rows.filter((r) => num(r.missing) > 0)
        .sort((a, b) => (rank(a) - rank(b)) || (num(b.missing) - num(a.missing)));
    const requiredMissing = missingRows.filter((r) => r.expect === 'required');
    const expectedMissing = missingRows.filter((r) => r.expect === 'expected');
    const optionalMissing = missingRows.filter((r) => r.expect !== 'required' && r.expect !== 'expected');
    const sumOf = (list, key) => list.reduce((acc, r) => acc + num(r[key]), 0);

    const inconsistent = Array.isArray(cov.inconsistent) ? cov.inconsistent : [];
    const deltas = cov.deltas && typeof cov.deltas === 'object' ? cov.deltas : {};

    return {
        package: cov.package || '',
        records: num(cov.records),
        registryVersion: cov.registryVersion === undefined ? null : cov.registryVersion,
        rowsTotal: rows.length,
        applies: sumOf(rows, 'applies'),
        filled: sumOf(rows, 'filled'),
        exempt: sumOf(rows, 'exempt'),
        // ★ 『多半拿不到』值得与『已填』『缺』『豁免』并列，**不算缺**：
        //   `missingLow` 是**并列的第四档**（注册表标了 `pursue: low`）—— 它**不进** `missingRows`，
        //   下面的计数也**不把它算进缺**。页面把它与"豁免"一样单独列一句。
        missingLow: sumOf(rows, 'missingLow'),
        lowRows: rows.filter((r) => num(r.missingLow) > 0)
            .sort((a, b) => num(b.missingLow) - num(a.missingLow)),
        missingRows,
        requiredMissing,
        expectedMissing,
        optionalMissing,
        // 三个**分开算**的格数：
        //   「真缺」= 必须有而缺（要修）；「应该有而缺」= 该去补的原料（有需求派出来）；
        //   「可有可无而缺」= 记账用 —— tags/ratio/codeLength 那些**没人会去填**，
        //   混进「可疑」会把 620 格说成 37,488 格。
        requiredMissingCount: sumOf(requiredMissing, 'missing'),
        expectedMissingCount: sumOf(expectedMissing, 'missing'),
        optionalMissingCount: sumOf(optionalMissing, 'missing'),
        // 「**追值**」（pursue：对这些**不能确定能不能爬到**的东西，也应该引入优先级）：
        //   `low` = **多半永远拿不到**（记账、别花力气追）；`high` = 值得优先追；缺省 normal。
        //   一行取"缺的那些格里最高的一档"（`pursue`），各档计数在 `pursueCounts` 里。
        // ⚠️ 这是**抓取计划**的记账（`pursueCounts.low` 含"多半拿不到"那 179 格）；
        //    与上面 `missingLow`（体检的并列档）**是两件事**：一个说"要不要去抓"，一个说"算不算缺"。
        lowPursueCount: missingRows.reduce(
            (acc, r) => acc + num((r.pursueCounts || {}).low), 0)
            + sumOf(rows, 'missingLow'),
        highPursueCount: missingRows.reduce(
            (acc, r) => acc + num((r.pursueCounts || {}).high), 0),
        inconsistentTotal: inconsistent.length,
        inconsistentMissingCount: inconsistent.reduce(
            (acc, g) => acc + (Array.isArray(g && g.missing_keys) ? g.missing_keys.length : 0), 0),
        deltas: {
            worse: Array.isArray(deltas.worse) ? deltas.worse : [],
            better: Array.isArray(deltas.better) ? deltas.better : []
        }
    };
}

/**
 * 原料需求那一节：按「能补几个空位」从多到少排（先干最划算的活）。
 * @returns {null|{package, items: Array, totalGain, exhaustedCount}}
 */
export function summarizeNeeds(reports) {
    const sec = reports && reports.needs;
    if (!sec || typeof sec !== 'object' || !Array.isArray(sec.needs)) return null;

    const items = sec.needs.filter((x) => x && typeof x === 'object').map((x) => ({
        id: String(x.id || ''),
        channel: String(x.channel || ''),
        channelLabel: String(x.channelLabel || x.channel || ''),
        field: String(x.field || ''),
        kind: String(x.kind || ''),
        kindLabel: NEED_KINDS[String(x.kind || '')] || String(x.kind || ''),
        action: String(x.action || ''),
        why: String(x.why || ''),
        // ⚠️ 两条命令**不是一件事**：
        //   `fixCommand` = 真正该跑的那条；`command` = "重跑这个**来源**"（CLIST 难度是跨 judge 的
        //   缓存，重跑 cf/nk 的适配器一次都补不到）。界面必须分开写，否则复制了后者等于白跑。
        command: String(x.command || ''),
        fixCommand: String(x.fixCommand || x.command || ''),
        caches: Array.isArray(x.caches) ? x.caches.slice() : [],
        gain: num(x.gain),
        exhausted: num(x.exhausted),
        groups: num(x.groups),
        sample: Array.isArray(x.sample) ? x.sample.slice() : [],
        partialGroups: x.partialGroups && typeof x.partialGroups === 'object' ? x.partialGroups : {}
    })).sort((a, b) => (b.gain - a.gain) || a.id.localeCompare(b.id));

    return {
        package: sec.package || '',
        items,
        totalGain: items.reduce((acc, x) => acc + x.gain, 0),
        exhaustedCount: items.reduce((acc, x) => acc + x.exhausted, 0)
    };
}

/**
 * 把需求**按"该跑的命令"合并**。
 *
 * 为什么必须合并：报告是按**渠道**派需求的（同一格字段，cf/atcoder/牛客 各一条），
 * 可 **CLIST 难度的三条需求是同一份跨 judge 缓存**、命令一模一样 —— 不合并的话界面上
 * 摆着三张看起来要跑三次的卡，用户会以为要跑三遍。
 *
 * ⚠️ 合并的**唯一判据是命令相同**（不是字段、不是渠道）：命令相同 ⇒ 跑一次就都补上了。
 *    每条原样留在 `items` 里（各自的 `gain` / 样例 / 半填组都还要用），只是**画一张卡**。
 *
 * @param {{items: Array}} summary - `summarizeNeeds()` 的结果
 * @returns {Array<{fixCommand, kindLabel, gain, groups, exhausted, items: Array,
 *                  channels: string[], fields: string[]}>} 按合计收益从多到少排
 */
export function groupNeedsByFix(summary) {
    const items = (summary && Array.isArray(summary.items)) ? summary.items : [];
    const byFix = new Map();
    for (const it of items) {
        const key = it.fixCommand || '(没有命令)';
        if (!byFix.has(key)) byFix.set(key, []);
        byFix.get(key).push(it);
    }
    const groups = [];
    for (const [fixCommand, list] of byFix) {
        const channels = [];
        const fields = [];
        for (const it of list) {
            if (it.channelLabel && !channels.includes(it.channelLabel)) channels.push(it.channelLabel);
            if (it.field && !fields.includes(it.field)) fields.push(it.field);
        }
        groups.push({
            fixCommand,
            // 同一份规则派出来的，档位名一致；真有出入就念第一条（别在这里编）
            kindLabel: list[0] ? list[0].kindLabel : '',
            gain: list.reduce((acc, x) => acc + x.gain, 0),
            groups: list.reduce((acc, x) => acc + x.groups, 0),
            exhausted: list.reduce((acc, x) => acc + x.exhausted, 0),
            channels,
            fields,
            items: list
        });
    }
    return groups.sort((a, b) => (b.gain - a.gain) || a.fixCommand.localeCompare(b.fixCommand));
}

/**
 * 去重后的散文（同一份规则派出来的需求，`why` / `action` 一字不差 —— 合并后只念一遍）
 * @returns {string[]}
 */
export function uniqueProse(list, key) {
    const out = [];
    for (const it of (Array.isArray(list) ? list : [])) {
        const text = plainProse(it && it[key]);
        if (text && !out.includes(text)) out.push(text);
    }
    return out;
}

/**
 * 同组不一致那 115 组的分页（DOM 只画当前页；页数变化时页码夹回范围内）。
 * @returns {{items: Array, page: number, pageCount: number, total: number}}
 */
export function pageGroups(reports, page = 1, size = GROUP_PAGE_SIZE) {
    const cov = reports && reports.coverage;
    const all = (cov && Array.isArray(cov.inconsistent)) ? cov.inconsistent.filter((g) => g && typeof g === 'object') : [];
    // 顺序照构建侧给的（按 缺得多 → 少 排），不再排一次 —— 报告是"谁的账谁算"
    return pageSlice(all, page, size);
}

/** 通用分页（页码越界夹回 [1, pageCount]；空表也返回 page 1 / pageCount 1） */
export function pageSlice(list, page = 1, size = GROUP_PAGE_SIZE) {
    const all = Array.isArray(list) ? list : [];
    const per = Math.max(1, Math.floor(num(size)) || 1);
    const pageCount = Math.max(1, Math.ceil(all.length / per));
    let p = Math.floor(num(page)) || 1;
    if (p < 1) p = 1;
    if (p > pageCount) p = pageCount;
    const start = (p - 1) * per;
    return { items: all.slice(start, start + per), page: p, pageCount, total: all.length };
}

/**
 * 页头那句小结（"一眼看到结论"）。没有报告时返回空串，由界面自己说"没带报告"。
 *
 * ⚠️ **三个数分开念**：真缺（必须有而缺，要修）/
 *    应该有而缺（该去补的原料）/ 可有可无而缺（**记账用**，不是待办）。把后两个
 *    合成一句"可疑 37,488 格" —— 真正该动手的只有 620 格，差 60 倍。
 */
export function coverageVerdict(reports) {
    const s = summarizeCoverage(reports);
    if (!s) return '';
    const parts = [
        `${fmtNum(s.records)} 个节点`,
        `字段体检 ${s.rowsTotal} 行（覆盖 ${fmtNum(s.applies)} 格 / 已填 ${fmtNum(s.filled)} 格）`
    ];
    parts.push(s.requiredMissingCount
        ? `🔴 真缺 ${fmtNum(s.requiredMissingCount)} 格`
        : '🟢 真缺 0 格');
    if (s.expectedMissingCount) parts.push(`🟡 应该有而缺 ${fmtNum(s.expectedMissingCount)} 格`);
    if (s.optionalMissingCount) {
        parts.push(`⚪️ 可有可无而缺 ${fmtNum(s.optionalMissingCount)} 格（记账用，不必追）`);
    }
    // 「追值」：把"记账"再分一层 —— 哪些是**多半拿不到**（low），别花力气追
    if (s.lowPursueCount) {
        parts.push(`⏬ 其中 ${fmtNum(s.lowPursueCount)} 格标了**多半拿不到**（追值 low）`);
    }
    if (s.highPursueCount) parts.push(`⏫ 值得优先追 ${fmtNum(s.highPursueCount)} 格`);
    if (s.inconsistentTotal) parts.push(`🔁 同组不一致 ${s.inconsistentTotal} 组`);
    const n = summarizeNeeds(reports);
    if (n && n.items.length) {
        // 需求**按命令合并**后念：4 条需求可能只要跑 2 条命令（别让人以为要跑 4 次）
        const cmdCount = groupNeedsByFix(n).length;
        parts.push(`📋 原料需求 ${n.items.length} 条`
            + (cmdCount < n.items.length ? ` → ${cmdCount} 条命令` : '')
            + `（${fmtNum(n.totalGain)} 个空位）`);
    }
    return parts.join(' · ');
}
