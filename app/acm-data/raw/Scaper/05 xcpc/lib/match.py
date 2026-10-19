#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
**同一场认定**的唯一实现（注册表 / 报告这条链路）：三件套判据 + CJK bigram

✅ **同一场认定只有这一份**：`gen_gym_manifest.py` 与 `link_qoj_activity.py` 都调这里
（`match_by_gym` / `problem_id_votes` / `best_title_match` / `name_hint` / `name_tokens`）
⇒ **改这里的判据，那两个工具跟着变**。
⚠️ 唯一的例外是**阈值**：`match_by_problem_names`（重合率 0.8 / 题数 3）与
`gen_gym_manifest.match_by_problems`（0.5 / 5）各自的标定留在调用处 —— 那是场景标定，不是重复。

为什么要有它
---------------------------------------
"这两条是不是同一场"曾散在三处、三套标准：
  * gym ↔ rankland：CF 榜单里的**题名集合**
  * QOJ ↔ rankland：**题目 id**
  * QOJ ↔ 清单：**赛名特征词**（空格分词）
标准不统一 → 同一件事三种结果；而且中文标题空格不一致时，空格分词直接全灭：
rankland「…中国大学生程序设计竞赛重庆站」是一个整词，QOJ 别名「…重庆站」是另一个词，
重合 0。实测就有 7 场 XCPC 因此没被认出来。

现在的判据（**只有前三条算证据，第四条只用来排序/给人看**）：
    ① 平台号直配     gym 号 / QOJ 比赛号 → rankland slug（外部数据直说，最硬）
    ② 题目 id 集合   提交里的 pid 与索引里那场的 pid 重合
    ③ 题名集合       两边题名归一化后逐题相同（**CJK 用字符 bigram**，不受空格影响）
    ④ QOJ 分类链 + 别名   只当"提示"与置信度，**不参与认定**

设计原则：**宁多报、不误合**。这里是给"候选"用的 —— 结论要人拍板（见 `xcpc_registry.py`），
所以可以召回优先；但**绝不自己把两条身份合成一条**。
"""

from __future__ import annotations

import re

# ================================================================
# 归一化
# ================================================================

_LATIN = re.compile(r'[a-z0-9]+')
_CJK = re.compile(r'[\u4e00-\u9fa5]')

# 判"两个赛名像不像"时忽略的词：赛制/范围/主办等通用词。
# 留着它们会让「EC Online Contest」与「EC-Final」看起来一样（实测踩到过）。
NAME_STOP = {
    'the', 'a', 'of', 'and', 'contest', 'contests', 'programming', 'collegiate', 'cp',
    'onsite', 'online', 'regional', 'regionals', 'icpc', 'acm', 'ccpc', 'cup', 'stage',
    'universal', 'international', 'university', 'national', 'china', 'chinese', 'round',
    'preliminary', 'provincial', 'invitational', 'official', 'asia', 'grand', 'prix',
    'site', 'day', 'winter', 'summer', 'camp', 'workshop', 'extra',
}
_CJK_STOP_BIGRAM = {'中国', '大学', '学生', '生程', '程序', '序设', '设计', '计竞', '竞赛'}


def norm_text(s) -> str:
    """去掉一切非字母数字汉字（空格、括号、破折号都不留）"""
    return re.sub(r'[^a-z0-9\u4e00-\u9fa5]', '', str(s or '').lower())


def name_tokens(s) -> set:
    """
    赛名 → 特征 token 集合：**拉丁词 + 汉字 bigram**。

    为什么用 bigram：中文标题的空格毫无规律（「…设计竞赛重庆站」vs「…设计竞赛 重庆站」），
    按空格切词会把同一个名字切成不同 token；bigram 只依赖字符序列，天然免疫。

    ⚠️ 拉丁词必须从**原串**里切（保留空格/标点）：
    如果先 `norm_text` 去掉一切分隔符，`The 2023 ICPC Asia Macau Regional Contest` 会粘成
    一个巨词 `the2023icpcasiamacauregionalcontest`，和谁都比不上（实测踩到）。
    """
    raw = str(s or '').lower()
    out = {w for w in _LATIN.findall(raw) if w not in NAME_STOP and len(w) > 1}
    cjk = ''.join(_CJK.findall(raw))
    for i in range(len(cjk) - 1):
        bg = cjk[i:i + 2]
        if bg not in _CJK_STOP_BIGRAM:
            out.add(bg)
    return out


def overlap(a: set, b: set) -> tuple[int, float]:
    """(重合数, 重合率) —— 重合率的分母取两边较小的那个（短名字不该被长名字稀释）"""
    if not a or not b:
        return 0, 0.0
    inter = len(a & b)
    return inter, inter / min(len(a), len(b))


# ================================================================
# ① 平台号直配
# ================================================================

def match_by_gym(gym, index: dict) -> tuple[str, list]:
    """CF gym 号 → rankland slug（索引的 `byGym`，外部数据直接给的对应关系）"""
    slug = (index.get('byGym') or {}).get(str(gym)) or ''
    return (slug, [f'rankland 索引里 gym {gym} 直接指向 {slug}']) if slug else ('', [])


def problem_id_votes(pids, index: dict) -> tuple[str, int, int]:
    """
    题目 id 集合 → `(slug, 命中题数, 题目总数)`（**多数票**）。

    判据只有这一处：索引的 `byProblem` 是 pid → slug。
    ⚠️ 收口：`link_qoj_activity.match_slug()` 自己抄过一遍同样的多数票
    （连 `str(p)` 的转换都一样）—— 两份可以各自漂，所以它现在调这里。
    """
    import collections
    by_problem = index.get('byProblem') or {}
    total = len([p for p in pids if str(p)])
    votes = collections.Counter(by_problem[str(p)] for p in pids if str(p) in by_problem)
    if not votes:
        return '', 0, total
    slug, hit = votes.most_common(1)[0]
    return slug, hit, total


def match_by_problem_ids(pids, index: dict) -> tuple[str, list]:
    """
    题目 id 集合 → rankland slug（多数票）。

    用于 QOJ 提交（记录里有 pid）。索引的 `byProblem` 是 pid → slug。
    """
    slug, hit, total = problem_id_votes(pids, index)
    return (slug, [f'题目 id 对上 {hit}/{total}（{slug}）']) if slug else ('', [])


# ================================================================
# ③ 题名集合
# ================================================================

def best_title_match(mine: set, index: dict, claimed=None, year: str = '', year_of=None,
                     min_common: int = 1,
                     min_score: float = 0.0) -> tuple[str, dict, float, int]:
    """
    **已归一化的题名集合** → `(slug, info, 重合率, 重合题数)`；没命中返回 `('', {}, 0.0, 0)`。

    判据只有这一处："两场的题名集合重合多少"。两个旋钮（`min_common` / `min_score`）由调用方
    按自己的场景定 —— 各自的标定见 `match_by_problem_names` 与
    `gen_gym_manifest.match_by_problems` 的 docstring。
      · `claimed`：排掉**已被别人认领**的 slug（gym 逐条匹配时要，否则两个 gym 抢同一场）；
      · `year` + `year_of`：年份守卫 —— 差 >1 年直接跳过（任一边没年份不算冲突）。
        `year_of` 默认 `index_year`（**赛季年**）。⚠️ **别改用 `startAt`**：跨年赛
        （EC-Final / CCPC Final 常在次年上半年办）会被误杀，见 `index_year` 的说明。
    """
    claimed = claimed or set()
    pick = year_of or index_year
    best = ('', {}, 0.0, 0)
    for slug, info in (index.get('bySlug') or {}).items():
        if slug in claimed:
            continue
        if year:
            iy = pick(info)
            if iy and abs(year_gap(year, iy)) > 1:
                continue
        theirs = {norm_text(p.get('title')) for p in (info.get('problems') or [])}
        theirs.discard('')
        if not theirs:
            continue
        inter, score = overlap(mine, theirs)
        if inter >= min_common and score >= min_score and score > best[2]:
            best = (slug, info, score, inter)
    return best


def match_by_problem_names(names, index: dict, min_common: int = 3,
                           min_score: float = 0.8) -> tuple[str, list]:
    """
    题名集合 → rankland slug。

    `names` 是这场（来自任一平台）的题名列表；索引里每场也有题名列表。
    逐题归一化后求交集 —— 同一场的题名集合必然高度重合。

    **两个旋钮**（分别管质量与数量）：
      * `min_score` 重合率 = 交集 / **较小的一边**。分母取 min 的理由：
        rankland 一场 13 题、只抓到 4 题且 4 题全中 → 4/4 = 100%（"知道的全中"）；
        若用较大边当分母就变成 31%，会被冤枉。
      * `min_common` 重合题数下限。**保持 3**：实测 `ccpc2023shenzhen` 就是 3/3 = 100%
        （只在那里提交过 3 题），提到 4 会丢掉它（好在它有 xcpcio 兜底）。

    阈值定 0.8 的依据（实测，57 个 gym + 40 场 QOJ）：
        重合率 ≥80% → 62 个，**全部是 100%**（13/13、12/12…）
        50%~80%    → **0 个**
        <50%       → 35 个，最好的也只有 8~9%（1/13 题，纯属撞名，如两道都叫 `Memory`）
    分布是双峰的，所以 0.5 与 0.8 结果完全一样 —— 取 0.8 是**给将来留余量**
    （题名有翻译差异、少一两题时还能中），同时把中间地带挡在门外。
    """
    mine = {norm_text(n) for n in names if norm_text(n)}
    if len(mine) < min_common:
        return '', []
    slug, _info, score, inter = best_title_match(mine, index, min_common=min_common,
                                                 min_score=min_score)
    if not slug:
        return '', []
    return slug, [f'题名重合 {inter} 题 / {score:.0%}（{slug}）']


# ================================================================
# ④ 提示：QOJ 分类链 + 别名（**不参与认定**）
# ================================================================

def classify_xcpc(chain: list) -> tuple[bool | None, str, str]:
    """
    QOJ 的分类链 → (是不是 XCPC, 系列 id, 年份)。

    实测 QOJ 的分类是**多归属**的，UCup 分站会同时挂在 UCup 与 XCPC 下：
        ICPC → Regionals → Asia East Continent → Hong Kong & Macau      ← XCPC
        Misc → Team Competition → CCPC → 第十一届 CCPC 2025              ← XCPC
        Misc → Team Competition → Chinese Provincial / Invitational → …  ← XCPC（省赛/邀请赛）
        ICPC → Regionals → Europe / North America / Asia Pacific         ← 非 XCPC
        Training Camps → Petrozavodsk / Moscow International Workshops   ← 非 XCPC
    分类链给不出判断时返回 (None, '', '') —— 交给人工。
    """
    text = ' ｜ '.join(str(c) for c in chain or [])
    year = ''
    m = re.findall(r'(?:19|20)\d{2}', text)
    if m:
        year = m[-1]
    if 'China Collegiate Programming Contest (CCPC)' in text:
        return True, 'ccpc', year
    if 'Chinese Provincial' in text:
        return True, 'provincial', year
    if 'Asia East Continent' in text:
        return True, 'icpc', year
    if not text.strip():
        return None, '', ''
    return False, '', year


def build_season_years(index: dict) -> dict:
    """
    `(系列, 届次) → 年份` —— 从**已有数据**里推，不硬编码。

    rankland 的标题里同时有届次和年份（「第 11 届 CCPC … 」+ slug/repoPath 里的 2025），
    所以能安全地建出这张表：
        ('ccpc', '11th') → 2025      ('icpc', '48th') → 2023      …
    没有它就只能拿"候选自己的年份"去猜 slug —— 实测会把 `ccpc/10th/chongqing`（2024）
    也解成 `ccpc2025chongqing`（2025），那是**认错场**。
    """
    out: dict = {}
    ord_re = re.compile(r'第\s*(\d+)\s*届')
    for slug, info in (index.get('bySlug') or {}).items():
        series = str(info.get('series') or '')
        if series not in ('icpc', 'ccpc'):
            continue
        year = index_year(info)
        if not year:
            continue
        m = ord_re.search(str(info.get('title') or ''))
        if not m:
            continue        # 英文标题里没有"第 N 届"，给不出届次
        n = int(m.group(1))
        for suffix in ('th', 'st', 'nd', 'rd'):
            out.setdefault((series, f'{n}{suffix}'), year)
    return out


def season_year(season: str, series: str, season_years: dict) -> str:
    """届次 → 年份：`11th` 查表、`2025` 直接用；查不到返回 ''（那就只给证据、不解 slug）"""
    s = str(season or '').strip().lower()
    if re.fullmatch(r'(?:19|20)\d{2}', s):
        return s
    return str((season_years or {}).get((series, s), ''))


def xcpcio_hint(names: list, tree: list, year: str = '', index: dict | None = None,
                season_years: dict | None = None, top: int = 3) -> list:
    """
    xcpcio/board-data 的目录树 → "系列/届次/站点"这条证据（**仍是提示级**）。

    它的目录名就是分类：`data/ccpc/11th/zhengzhou`。站点名（`zhengzhou`）通常只有一两个
    英文词，和 QOJ/CF 的英文赛名一比就中 —— 这正是 rankland 没有题名、中文标题又对不上时
    缺的那块拼图。

    若同时给了年份（QOJ 分类链里有）且 index 里有 `系列+年+站点` 这个 slug，就顺手把
    rankland 的 slug 也解出来（`ccpc2025zhengzhou`）。省赛不行 —— rankland 那边叫
    `zjcpc23rd` 这种缩写+届次，所以省赛只给证据、不猜 slug。

    @returns [(1.0, 系列, 届次, 站点, 解出的 slug 或 '', 目录路径)]
    """
    mine = set()
    for n in names or []:
        mine |= name_tokens(n)
    if not mine:
        return []
    out, seen = [], set()
    for e in tree or []:
        if e.get('warmup'):
            continue
        site = str(e.get('site') or '')
        site_toks = name_tokens(site.replace('-', ' '))
        common = mine & site_toks
        if not common or not any(not c.isdigit() for c in common):
            continue
        key = (e.get('series'), e.get('season'), site)
        if key in seen:
            continue
        seen.add(key)
        sy = season_year(e.get('season'), str(e.get('series')), season_years or {})
        gap = year_gap(year, sy) if (year and sy) else 0
        # 年份**差值**（不是"必须相等"）：同届次不同年才是别场；±1 是"赛季年 vs 次年办"
        if abs(gap) > 1:
            continue
        slug = ''
        # 只有届次推出的年份与候选年份**完全一致**时才解 slug（差 1 年时不敢断言是同一届）
        if index and sy and sy == year and str(e.get('series')) in ('icpc', 'ccpc'):
            # 站点名不统一（xcpcio 里 46th 是 `ec-final`、48th 是 `ecfinal`、还有 `world-finals`），
            # 所以按"去掉分隔符"再拼一次 —— 拼出来的形式与 rankland 的 slug 不一定逐字相同。
            #
            # ⚠️ **两个方向都要归一化**（实测踩到，2026-10：ICPC 48th 西安站整场没进来）：
            # 目录 `48th/xian` 推出 `icpc2023xian`，而 rankland 的 slug 是 **`icpc2023xi_an`**
            # （**下划线**）⇒ 只归一化目录那侧的词、拿结果去**逐字**比 slug，永远比不上。
            # 全索引 394 个 slug 里 **93 个**带 `-`/`_`（西安历届、各 `preliminary-N`、
            # `invitational-*` 全在内），这类场次会静默退化成"只作证据、不解 slug"。
            by_slug = index.get('bySlug') or {}
            flat2slug: dict = {}
            for k in by_slug:
                flat2slug.setdefault(re.sub(r'[^a-z0-9]', '', k.lower()), k)
            for s in (site, re.sub(r'[^a-z0-9]', '', site.lower())):
                cand = f"{e['series']}{sy}{s}"
                if cand in by_slug:
                    slug = cand
                    break
                slug = flat2slug.get(re.sub(r'[^a-z0-9]', '', cand.lower()), '')
                if slug:
                    break
        out.append((1.0, str(e.get('series')), str(e.get('season')), site, slug,
                    str(e.get('path') or ''), abs(gap)))
    out.sort(key=lambda x: (not x[4], x[6], x[3]))
    return [o[:6] for o in out[:top]]


def index_year(info: dict) -> str:
    """
    索引条目的**赛季年**：仓库路径 / 目录名 / slug（`…/icpc2023/icpc2023ecfinal.srk.json`）
    → 最后才退回开赛时间。

    ⚠️ 为什么**不优先用 startAt**：届次年 ≠ 日历举办年。实测（394 场里，有 startAt 的 288 场）：
        实际年 − 赛季年 = 0 → 268 场；+1 → **19 场**；+3 → 1 场（疫情推迟的 World Finals）
    EC-Final / CCPC Final / World Finals 常在**次年上半年**办：`icpc2023ecfinal` 赛季 2023、
    实际 2024-02。标题里写的是赛季年，所以要跟标题比就得用赛季年；先取 startAt 会**误杀**正确候选。
    """
    for field in ('repoPath', 'mid', 'slug', 'title'):
        m = re.search(r'(?:19|20)\d{2}', str(info.get(field) or ''))
        if m:
            return m.group(0)
    m = re.search(r'(?:19|20)\d{2}', str(info.get('startAt') or ''))
    return m.group(0) if m else ''


def year_gap(a: str, b: str) -> int:
    """两年份差多少（缺一个就返回 0 = 不算冲突）；`+1` 是"赛季年 vs 次年办"这类正常情况"""
    if not a or not b:
        return 0
    try:
        return int(a) - int(b)
    except (TypeError, ValueError):
        return 0


def name_hint(qoj_names: list, index: dict, year: str = '', top: int = 3,
              exclude: set | None = None) -> list:
    """
    QOJ 官方名/别名 → 最像的 rankland 场次（**只当提示**，用于给候选排可信度）。

    `also known as` 常常就是它的 XCPC 身份（如 UCup Stage 15 Macau ↔
    The 2023 ICPC Asia Macau Regional Contest），所以别名要和主名一起比。

    ⚠️ **必须卡年份**：`第十届`/`第十一届` 只差一个字，bigram 几乎全同 ——
    实测「CCPC Online 2025」最像的竟然是 `ccpc2024preliminary`（89%）。年份已知时不一致就丢。
    ⚠️ `exclude` 用来排掉"自己"：注册表里的条目名会进索引，不排掉就会自己匹配自己（100%）。
    """
    mine = set()
    for n in qoj_names or []:
        mine |= name_tokens(n)
    if len(mine) < 2:
        return []
    out = []
    for slug, info in (index.get('bySlug') or {}).items():
        if exclude and slug in exclude:
            continue
        iy = index_year(info)
        gap = year_gap(year, iy) if (year and iy) else 0
        if abs(gap) > 1:          # 差 2 年以上一定不是同一届；±1 是"赛季年 vs 次年办"
            continue
        theirs = name_tokens(info.get('title'))
        common = mine & theirs
        # 至少 2 个词重合，且**不能只有年份**（`The 2023 ICPC Asia Macau Regional Contest`
        # 去掉通用词后只剩 {2023, macau}，所以门槛不能定成 3 个词）
        if len(common) < 2 or not any(not c.isdigit() for c in common):
            continue
        inter, score = len(common), len(common) / min(len(mine), len(theirs)) if theirs else 0.0
        if score >= 0.4:
            out.append((score, inter, slug, str(info.get('title') or ''), abs(gap)))
    # 年份**完全一致**的排前面，±1 的排后面（`CCPC Online 2025` 不该被 2024 那届挤掉）
    out.sort(key=lambda x: (x[4], -x[0]))
    return out[:top]
