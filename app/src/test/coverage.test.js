// ================================================================
// 体检报告的纯计算（core/coverage.js）单测
//
// 这一层只做"排序 / 分页 / 小结"，**不做判定**（缺不缺是构建侧脚本算好的）。
// 所以用例盯的是三件事：
//   ① 形状容错（没报告 / 半截报告 ⇒ null 或空值，绝不抛错）；
//   ② 数字口径（真缺 / 可疑 / 豁免 / 同组不一致，各算各的，别串）；
//   ③ 分页夹页码（115 组翻到第 99 页要夹回来，不是画空白）。
// ================================================================
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    hasReports,
    summarizeCoverage,
    summarizeNeeds,
    groupNeedsByFix,
    uniqueProse,
    pageGroups,
    pageSlice,
    coverageVerdict,
    expectLabel,
    expectColor,
    plainProse,
    fmtNum,
    GROUP_PAGE_SIZE
} from '../core/coverage.js';
import { EXPECT_COLOR, expectColorOf } from '../core/fieldRegistry.js';

// ⚠️ 「三档 → 三色」必须只有**一处**定义。
//    这条守卫盯住"只有一处"这件事本身。
test('档位颜色只有一处：`coverage.expectColor` **就是** `fieldRegistry.expectColorOf`', () => {
    assert.equal(expectColor, expectColorOf, 'coverage 里不许再写一份三档三色（import 它）');
    assert.deepEqual({ ...EXPECT_COLOR },
        { required: '#b91c1c', expected: '#b45309', optional: '#94a3b8' },
        '颜色的取值与字段条同一个口径');
    assert.equal(expectColorOf('不知道'), EXPECT_COLOR.optional, '认不出/空 ⇒ 灰（与"可有可无"同色）');
});

/** 一份"最小但完整"的报告（形状与 `acm-data/reports/*.json` 一致） */
function makeReports(over = {}) {
    return {
        coverage: {
            package: 'acm-data/nodes/all_nodes.json',
            registryVersion: 1,
            records: 24528,
            rows: [
                { type: 'C', field: 'natureClass', expect: 'required', applies: 1456, filled: 1456, missing: 0, exempt: 0, why: '骨架' },
                { type: 'P', field: 'clistDifficulty', expect: 'expected', applies: 20000, filled: 19470, missing: 530, exempt: 0, why: 'CLIST 没算' },
                { type: 'P', field: 'tags', expect: 'optional', applies: 20000, filled: 6671, missing: 13329, exempt: 0, why: '可选' },
                { type: 'P', field: 'cfDifficulty', expect: 'required', applies: 6000, filled: 5975, missing: 0, exempt: 25, why: 'gym 题不适用' }
            ],
            inconsistent: [
                { type: 'P', field: 'clistDifficulty', parent: 'cf:c:2202', total: 9, filled: 3, missing_keys: ['a', 'b', 'c', 'd', 'e', 'f'] },
                { type: 'P', field: 'clistDifficulty', parent: 'cf:c:2191', total: 8, filled: 2, missing_keys: ['x', 'y'] }
            ],
            deltas: { worse: [], better: [{ field: 'atcoderDifficulty', delta: 3 }] },
            ...(over.coverage || {})
        },
        needs: {
            package: 'acm-data/reports/material-needs.json',
            needs: [
                // ⚠️ 两个渠道的 clistDifficulty 需求**共用同一条命令**（CLIST 是跨 judge 的缓存）——
                //    这正是"按命令合并"那张卡的现实形状
                { id: 'nk:clistDifficulty', channel: 'nk', channelLabel: '牛客', field: 'P.clistDifficulty', kind: 'refresh-cache', gain: 50, exhausted: 0, groups: 12, action: '刷缓存', why: '没抓到', command: 'python -B scripts/build-all.py --only-source nk', fixCommand: 'python -B scripts/clist-difficulty.py fetch --force', sample: ['n1'] },
                { id: 'cf:clistDifficulty', channel: 'cf', channelLabel: 'Codeforces', field: 'P.clistDifficulty', kind: 'refresh-cache', gain: 426, exhausted: 0, groups: 90, action: '刷缓存', why: '没抓到', command: 'python -B "…/cf_contest_adapter.py" -o <临时文件>', fixCommand: 'python -B scripts/clist-difficulty.py fetch --force', sample: ['c1'] },
                { id: 'atcoder:atcoderDifficulty', channel: 'atcoder', channelLabel: 'AtCoder', field: 'P.atcoderDifficulty', kind: 'rerun-source', gain: 38, exhausted: 2, groups: 10, action: '重跑', why: '上游没有', command: 'python -B scripts/build-all.py --only-source atcoder', sample: ['a1'] }
            ],
            ...(over.needs || {})
        },
        ...(over.top || {})
    };
}

test('没有报告 / 半截报告：一律 null 或空值，绝不抛错', () => {
    for (const bad of [null, undefined, {}, { coverage: null }, { coverage: {} },
                       { coverage: { rows: null } }, { needs: { needs: 'x' } }, 42, 'x']) {
        assert.equal(summarizeCoverage(bad), null, `summarizeCoverage(${JSON.stringify(bad)}) 应为 null`);
        assert.equal(summarizeNeeds(bad), null, `summarizeNeeds(${JSON.stringify(bad)}) 应为 null`);
        assert.equal(coverageVerdict(bad), '', '没报告 ⇒ 页头小结是空串（界面自己说"没带报告"）');
        const g = pageGroups(bad, 3);
        assert.deepEqual([g.items.length, g.page, g.pageCount, g.total], [0, 1, 1, 0]);
    }
    assert.equal(hasReports(null), false);
    assert.equal(hasReports({}), false);
    assert.equal(hasReports({ coverage: { rows: [] } }), true, '只有一节也算有');
});

test('小结：真缺 / 应该有而缺 / 可有可无而缺 / 豁免 / 覆盖格数各算各的（别串）', () => {
    const s = summarizeCoverage(makeReports());
    assert.equal(s.records, 24528);
    assert.equal(s.rowsTotal, 4);
    assert.equal(s.applies, 1456 + 20000 + 20000 + 6000);
    assert.equal(s.filled, 1456 + 19470 + 6671 + 5975);
    assert.equal(s.exempt, 25);
    // 真缺 = 只有 required 档缺了的（这份里 clistDifficulty 是 expected ⇒ 进"应该有而缺"）
    assert.equal(s.requiredMissing.length, 0);
    assert.equal(s.requiredMissingCount, 0);
    // ⚠️ 这三档**必须分开**（把 expected + optional 合成一句"可疑 37,488"：
    //    而真正该动手的只有 620 格 —— 差 60 倍，那种数只会误导）
    assert.equal(s.expectedMissing.length, 1);
    assert.equal(s.expectedMissingCount, 530, 'expected 档的缺单独算');
    assert.equal(s.optionalMissing.length, 1);
    assert.equal(s.optionalMissingCount, 13329, 'optional 档的缺单独算（记账用，不是待办）');
    // 排序 = 档位优先（真缺 → 应该有 → 可有可无），同档内缺得多的在前
    assert.deepEqual(s.missingRows.map((r) => r.field), ['clistDifficulty', 'tags'],
        '★ 该补的（expected）必须排在"可有可无"的大数前面');
    assert.equal(s.inconsistentTotal, 2);
    assert.equal(s.inconsistentMissingCount, 8, 'missing_keys 加起来 = 同组不一致的**格数**');
    assert.equal(s.deltas.better.length, 1);
    assert.equal(s.deltas.worse.length, 0);
});

test('required 档缺了必须进「真缺」（红的），不能混进另外两档', () => {
    const s = summarizeCoverage(makeReports({
        coverage: { rows: [{ type: 'R', field: 'submissionId', expect: 'required', applies: 9, filled: 8, missing: 1, exempt: 0, why: '' }] }
    }));
    assert.equal(s.requiredMissingCount, 1);
    assert.equal(s.expectedMissingCount, 0);
    assert.equal(s.optionalMissingCount, 0);
    assert.match(coverageVerdict(makeReports({
        coverage: { rows: [{ type: 'R', field: 'submissionId', expect: 'required', applies: 9, filled: 8, missing: 1, exempt: 0, why: '' }] }
    })), /真缺 1 格/);
});

test('页头小结：三个数分开念，"可有可无而缺"要注明是记账（口径）', () => {
    const v = coverageVerdict(makeReports());
    assert.match(v, /真缺 0 格/);
    assert.match(v, /应该有而缺 530 格/);
    assert.match(v, /可有可无而缺 13,329 格（记账用，不必追）/);
    assert.ok(!/可疑/.test(v), '不许出现"可疑"（那正是把 620 说成 37,488 的那个词）');
});

test('需求：两条命令分开（该跑的 vs 重跑来源），没有 fixCommand 时退回 command', () => {
    const n = summarizeNeeds(makeReports({
        needs: {
            needs: [
                { id: 'cf:clistDifficulty', channel: 'cf', field: 'P.clistDifficulty', gain: 5,
                  command: 'python -B "…/cf_contest_adapter.py" -o <临时文件>',
                  fixCommand: 'python -B scripts/clist-difficulty.py fetch --force' },
                { id: 'x:y', channel: 'x', field: 'P.z', gain: 1, command: 'python -B whatever.py' }
            ]
        }
    }));
    const byId = Object.fromEntries(n.items.map((x) => [x.id, x]));
    assert.match(byId['cf:clistDifficulty'].fixCommand, /clist-difficulty\.py fetch --force/,
        '★ 该跑的是"刷 CLIST 缓存"，不是重跑 cf 适配器');
    assert.match(byId['cf:clistDifficulty'].command, /cf_contest_adapter/, '重跑来源那条也留着');
    assert.equal(byId['x:y'].fixCommand, 'python -B whatever.py',
        '包里没给 fixCommand ⇒ 退回 command（老报告也能看）');
});

test('需求：**按"该跑的命令"合并**——命令相同的几条只该跑一次（别让人以为要跑三次）', () => {
    const n = summarizeNeeds(makeReports());
    const groups = groupNeedsByFix(n);
    assert.equal(groups.length, 2, '3 条 clist（命令相同）+ 1 条 atcoder ⇒ 2 组');
    // 合计收益大的排前面：clist 那组 = 426 + 50（fixture 里 cf/nk 都是 fetch）
    const first = groups[0];
    assert.match(first.fixCommand, /clist-difficulty\.py fetch --force/);
    assert.deepEqual(first.channels, ['Codeforces', '牛客'], '合并了哪几条渠道要能看出来');
    assert.deepEqual(first.fields, ['P.clistDifficulty']);
    assert.equal(first.items.length, 2, '原条目一个不丢（gain/样例/半填组都还在）');
    assert.equal(first.gain, 426 + 50, '合计 = 各条之和');
    assert.equal(groups[1].fixCommand, 'python -B scripts/build-all.py --only-source atcoder');
    // 页头那句也要说清"只需跑 N 条命令"
    assert.match(coverageVerdict(makeReports()), /原料需求 3 条 → 2 条命令/);
});

test('uniqueProse：合并后"为什么/怎么做"只念一遍（一字不差的重复去掉）', () => {
    const list = [{ why: '同一个原因' }, { why: '同一个原因' }, { why: '**另一个**原因' }, { why: '' }];
    assert.deepEqual(uniqueProse(list, 'why'), ['同一个原因', '另一个原因']);
    assert.deepEqual(uniqueProse(null, 'why'), []);
});

test('plainProse：去掉 Markdown 记号，不改字（页面上不许漏出 `**` 和反引号）', () => {
    assert.equal(plainProse('**它还没算出来**'), '它还没算出来');
    assert.equal(plainProse('`rating` 为 null'), 'rating 为 null');
    assert.equal(plainProse('**`两样`都有**'), '两样都有');
    assert.equal(plainProse(null), '');
    assert.equal(plainProse(undefined), '');
    assert.equal(plainProse(1200), '1200');
});

test('需求：按"能补几个空位"从多到少排，档位中文名照念 kindLabel', () => {
    const n = summarizeNeeds(makeReports());
    assert.deepEqual(n.items.map((x) => x.id), ['cf:clistDifficulty', 'nk:clistDifficulty', 'atcoder:atcoderDifficulty']);
    assert.equal(n.totalGain, 426 + 50 + 38);
    assert.equal(n.exhaustedCount, 2);
    assert.equal(n.items[0].channelLabel, 'Codeforces');
    assert.equal(n.items[0].kindLabel, '刷缓存（联网）', '联网那件事必须写在卡片上');
    assert.equal(n.items[2].kindLabel, '重跑来源（联网）');});

test('同组不一致：分页夹页码（翻过头夹回最后一页，不是画空白）', () => {
    const groups = Array.from({ length: 115 }, (_, i) => ({
        type: 'P', field: 'clistDifficulty', parent: `cf:c:${i}`, total: 8, filled: 2, missing_keys: ['a']
    }));
    const rep = makeReports({ coverage: { inconsistent: groups } });
    const p1 = pageGroups(rep, 1);
    assert.equal(p1.pageCount, Math.ceil(115 / GROUP_PAGE_SIZE));
    assert.equal(p1.items.length, GROUP_PAGE_SIZE);
    assert.equal(p1.items[0].parent, 'cf:c:0');
    const last = pageGroups(rep, 999);
    assert.equal(last.page, last.pageCount, '页码越界要夹回来');
    assert.equal(last.items.length, 115 - (last.pageCount - 1) * GROUP_PAGE_SIZE);
    const zero = pageGroups(rep, 0);
    assert.equal(zero.page, 1);
    // 通用分页：负数 / 空表 / 尺寸非法都不炸
    assert.deepEqual(pageSlice([1, 2, 3], -5).items, [1, 2, 3]);
    assert.equal(pageSlice([], 4).pageCount, 1);
    assert.equal(pageSlice([1, 2, 3], 1, 0).items.length, 1, 'size 非法 ⇒ 兜底 1 条/页（不除以 0）');
});

test('★ 「多半拿不到」是与「缺」「豁免」并列的一档，且**不算缺**（口径）', () => {
    // 夹具：一行纯粹「多半拿不到」（pursue low）、一行真缺、一行豁免
    const view = summarizeCoverage({ coverage: {
        package: 'p.json', records: 3, registryVersion: 1,
        rows: [
            { type: 'P', field: 'link', expect: 'optional', applies: 10, filled: 0,
              missing: 0, missingLow: 7, missingLowSample: ['qoj:1'], exempt: 0, pursueCounts: { low: 7 } },
            { type: 'C', field: 'contestTime', expect: 'optional', applies: 5, filled: 0,
              missing: 2, missingLow: 0, exempt: 0, pursueCounts: { normal: 2 } },
            { type: 'P', field: 'cfDifficulty', expect: 'expected', applies: 4, filled: 4,
              missing: 0, missingLow: 0, exempt: 0, pursueCounts: {} }
        ]
    } });
    assert.equal(view.missingLow, 7, '并列档的格数单独算');
    assert.equal(view.lowRows.length, 1, '并按格数排出来');
    assert.equal(view.missingRows.length, 1, '★ 「多半拿不到」那一行**不进** missingRows（不算缺）');
    assert.equal(view.optionalMissingCount, 2, '缺的只有真缺那 2 格');
    assert.equal(view.lowPursueCount, 7, '追值记账仍看得到（抓取计划要用）');
});

test('档位名 / 千分位：与字段条同一套话（复用 fieldRegistry 的表）', () => {
    assert.equal(expectLabel('required'), '必须有');
    assert.equal(expectLabel('expected'), '应该有');
    assert.equal(expectLabel('optional'), '可有可无');
    assert.equal(expectLabel(''), '—');
    assert.equal(fmtNum(24528), '24,528');
    assert.equal(fmtNum('x'), 'x', '非数字原样返回，不显示 NaN');
});
