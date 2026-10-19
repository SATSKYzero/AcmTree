// ================================================================
// 平台 → 线索字段（core/rosterMappings.js）
//
// 方向："**绝对可信源是映射，在 AppState 里，
// me.json 本质上完全是映射的派生部分**"。所以：
//   · 账户（映射）住在应用数据里 → 它是真源；
//   · `me.json` 的 `accounts[]`（`cf: "…"` / `byYear: {"nk": {"2026": "…"}}`）是**导出物**
//     （设置页「📤 写进 me.json」）；反方向读回来时也用它。
//
// 这个文件只剩一样东西：**每个平台的线索字段叫什么**（导出/导入都靠它对上）。
//
// ⚠️ 这张表**照抄**抓取侧各 adapter 的 `CLUE_FIELD`。**对拍**在 `src/test/clueFields.test.js`
//    （它去解析那些 `.py` 里写着的线索字段，与这张表逐行比 —— 抄错了会红，别只靠人记）：
//      cf  → `handle`（提交里的 `author.members`）
//      qoj → `提交者`
//      nk  → `用户名`   （带赛季：`nk:2026` —— **四位年**）
//      hdu → `handle`   （带赛季；数据里没有提交者，靠自己声明）
//      pta → `队伍`     （带赛季，但赛季是**命名空间** `icpc2026`，不是两位年）
//    抓取侧改了字段名/赛季写法，这里要跟着改（应用推不出这个语义）。
//
// `season` 三态（"**多校都是有赛季的**" ⇒ `nk:"某用户名"` 就是 `nk:26`、
// `hdu:"示例队/teamA"` 就是 `hdu:26`）：
//   · `null`  —— 线索 source 就是平台名（`cf` / `qoj`）：账户上那格直接推；
//   · `'yy'`  —— 赛季是**两位年**（`season_of(year)`）：账户上那格 = **本赛季**（今年），
//                `byYear: {"nk": {"2025": "示例队0"}}` 那种则按往年各推一条；
//   · `'ns'`  —— 赛季是**命名空间**（PTA 的 `icpc2026`）：从年份推不出来 ⇒ **只能靠显式映射**
//                （`mappings: [{"source": "pta:icpc2026", "field": "队伍", "value": "示例队"}]`）。
// ================================================================

import { isRealYear } from './natureFields.js';

export const PLATFORM_CLUES = {
    cf: { field: 'handle', season: null },
    qoj: { field: '提交者', season: null },
    // ⚠️ `atcoder` **没有账户线索**（AtCoder 的提交不抓），但它**是**一个平台账号：
    //    爬虫侧 `me.handles('atcoder')` 要靠它去抓提交。实测踩到：
    //    这张表里没有 atcoder ⇒ 导出 me.json 时**不写**这一格 ⇒ `handles('atcoder')` 空
    //    ⇒ 那一棵树 0 条 ⇒ 合并失败、整条链挂掉。所以：`season: null`（不带赛季）+ 字段 handle。
    atcoder: { field: 'handle', season: null },
    nk: { field: '用户名', season: 'year' },
    hdu: { field: 'handle', season: 'year' },
    pta: { field: '队伍', season: 'ns' }
};

/** 两位年赛季的平台（Python 侧 `me.by_year()` 也按这个集合把裸账号算今年） */
export const SEASON_YY_PLATFORMS = Object.entries(PLATFORM_CLUES)
    .filter(([, c]) => c.season === 'year').map(([p]) => p);

/** 今年的两位年（`2026` → `26`）—— 带赛季平台的"裸账号"就是本赛季 */
export const currentSeason = (today = new Date()) => String(today.getFullYear());

/**
 * 检查映射行的**写法**（纯函数；只提醒、不自动改 —— 判据是"全等匹配"，改错了更糟）。
 *
 * 实测踩到的坑：账户里写了 `nk.2023 / nk.2024 / nk.2025`，
 * 而抓取侧发的是 `nk:23`（**冒号 + 两位年**）⇒ **10120 条值全成"未认领的线索"**。
 * 这类错字眼看不出来（点号 vs 冒号、4 位 vs 2 位），所以让界面自己说：
 * 账户编辑弹窗把可疑行标出来，并给出**正确的写法**。
 *
 * @param {Array<{source,field,value}>} mappings
 * @returns {Array<{source:string, field:string, value:string, why:string, suggest:string}>}
 */
export function mappingWarnings(mappings) {
    const out = [];
    for (const m of Array.isArray(mappings) ? mappings : []) {
        if (!m || typeof m !== 'object') continue;
        const source = String(m.source === undefined || m.source === null ? '' : m.source).trim();
        const field = String(m.field || '').trim();
        const value = String(m.value === undefined || m.value === null ? '' : m.value).trim();
        if (!source) continue;
        // ⚠️ 平台段先 trim + 小写再查表：`nk :2023` / `NK:2023` 这种写法
        //    查不到 `nk ` / `NK` 就会**一声不响**（永远看不出为什么认不上）。
        //    这里只**识别**它们、好把话说明白；**不改用户存下的值**（匹配是全等，改了会认错人）。
        const parts = /^([A-Za-z]+)\s*([:.]?)\s*(.*)$/.exec(source);
        const platform = (parts ? parts[1] : source).toLowerCase();
        const clue = PLATFORM_CLUES[platform];
        if (!clue) continue;                                   // 不认识的平台：不猜
        const sep = parts ? parts[2] : '';
        const suffix = parts ? parts[3] : '';
        const hasSep = sep !== '';
        const canonical = `${platform}:${suffix}`;
        const push = (why, suggest) => out.push({ source, field, value, why, suggest });
        if (clue.season === null) {                            // cf / qoj：source 就是平台名
            if (hasSep || source !== platform) {
                push(`${platform} 的线索「不带赛季」（抓取侧发出来的就是 ${platform}）`, platform);
            }
            continue;
        }
        if (clue.season === 'year') {                          // nk / hdu：冒号 + **四位年**
            if (!hasSep) continue;                             // 只写平台名 = 本赛季，合法
            // 建议值统一成"冒号 + 四位年"（`nk:23` 与 `nk.2023` 都会建议成 `nk:2023`）
            const fixed = /^\d{2}$/.test(suffix) ? `20${suffix}` : suffix;
            const suggest = `${platform}:${fixed}`;
            if (sep !== ':') {
                push(`赛季要用「冒号」（抓取侧发的是 ${platform}:<四位年>）`, suggest);
                continue;
            }
            if (/^\d{2}$/.test(suffix)) {
                push('赛季是「四位年」（如 nk:2023）—— 数据端统一用四位年', suggest);
                continue;
            }
            // ⚠️ **写法要一模一样**：线索匹配是**三元组全等**，
            //    所以"冒号前后多空格"（`nk: 2023` / `nk :2023`）与"平台大小写不对"（`NK:2023`）
            //    都**永远认不上** —— 一声不响（`isRealYear` 会 trim，把 `' 2023'` 当合法年份）。
            //    这里比的是**规范化之后的写法**与用户存下的写法，两者不等就报出来。
            if (source !== canonical || !isRealYear(suffix)) {
                push(`赛季的写法要对得上（抓取侧发的是 ${platform}:<四位年>，`
                     + `空格/大小写不同都认不上）`, suggest);
            }
            continue;
        }
        // pta：赛季是命名空间（`icpc2026` 那种），不能省、也推不出来
        if (!hasSep) push('PTA 的赛季是「命名空间」（如 icpc2026），不能只写 pta —— '
            + '照「未认领的线索」里那条原样抄', 'pta:<命名空间>');
    }
    return out;
}

