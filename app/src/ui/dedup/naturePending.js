// ================================================================
// ③ 性质待补 + 填充条（ui/dedup/naturePending.js）
//
// 职责：性质待补那一整套 —— 大类 chip、筛选、
// 逐行编辑 + 推荐、批量填充条、导出人工填写。
// ================================================================
import { pageState } from './state.js';
import { PAGE_SIZE, button, chipGroup, field, hint, linkBlockOf, markGoto, nodeLabel, pager, runWrite, selectControl, slice, textInput, wireGotoLinks } from './kit.js';
import { NATURE_NO_MAIN_LABEL, groupNaturePending } from '../../core/dedup.js';
import { collectNatureAssignments } from '../../core/natureAssignments.js';
// ★ 回代 baseline 走**直接写盘**（`POST /api/nature-assignments`）——
//   客户端在 `core/` 里（`ui/` 不许依赖 `features/`，那条边界见 `ui/dedup/kit.js` 的注释；
//   地址解析在 `core/localServer.js`）。
import { diffText, saveNatureBaseline } from '../../core/natureBaselineApi.js';
import { MANUAL_LEVEL, RULE_LEVELS, classLevelOf, classRuleOf, levelLabel, levelOfClassRule, levelRank } from '../../core/natureConfidence.js';
import { CLASS_PATHS, NATURE_FIELD_KEYS, NATURE_REGISTRY_VERSION, classLabel, classMatches, classPathOf, classPathProblem, classRootOf, isCompleteClassPath, isNatureSeason, isNatureYear, isNotApplicableValue, isRealYear, natureFieldOf, natureInputSuggestions } from '../../core/natureFields.js';
import { suggestNatureFields, suggestNatureSeason, suggestNatureYear } from '../../core/natureSuggest.js';
import { makeParentResolver } from '../../core/fieldRegistry.js';
import { updateP, updateR, updateWS } from '../../core/ops/node.js';
import { AppState } from '../../shell/state.js';
import { mk } from '../../utils/dom.js';
// ⚠️ 这一栏整段是 `textContent` ⇒ 文案里的 `**强调**` 必须在落界面前去掉
//    （写漏了就是页面上直接显示一串星号 —— 实测踩到过）
import { plain } from '../kit/report.js';
import { showFormDialog } from '../G_modal/G2_common.js';
import { showToast } from '../G_modal/G_modals.js';
import { natureFieldDescriptors } from '../G_modal/editForm.js';

// ★ 筛选的**哨兵值**：真源在 `core/dedup.js`（② 与 ③ 共用同一份；别再在这里抄字面量）
import { ALL_CLASSES, NO_CLASS, PARTIAL_CLASS, NO_VALUE, HAS_VALUE } from '../../core/dedup.js';

/** 分类值（可能是空串）→ 筛选键 */
const classKeyOf = cls => String(cls || '') || NO_CLASS;

export const pendingState = {
    selected: new Set(),
    // ★ 四维筛选**都是多选**（2026-10-12 与 ② 对齐）：`[]` = 全部（与 ② 的 `emptyDedupFilter()` 同形），
    //   维度内"或"、维度之间"与" —— 与 ② 那套判据同一条口径（`core/dedup.js` 的 `matchesDedupFilter`）。
    cls: [],             // 分类筛选：前缀匹配（`cf` 含 `cf/div2`）；哨兵 `NO_CLASS` / `PARTIAL_CLASS`
    filterYear: [],      // 年份（举办）筛选（`NO_VALUE` = 没标年份的那些）
    filterSeason: [],    // 赛季筛选（同上）
    filterRegion: [],    // 地区筛选（同上）
    // 分类的**依据强度**筛选：'' = 全部；`A`…`E` = **该级及更弱**
    // （"只看 C 以下"就是 `C`）。⚠️ 级别未知（人填的 / 老数据）不算"弱"，见 `passFilters`。
    // ⚠️ 这一档**仍是单选**（它是"门槛"，不是"取值集合"）—— 与 ② 那一行同姿态。
    classLevel: '',
    fillCls: '',         // 「要填的分类」（填充条上那个下拉，'' = 不改动）
    year: '', season: '', region: '',
    suggestMinLevel: 'D',   // 「按推荐填」接受的**依据强度门槛**（A…E；D = 现有的全部依据）
    showFilled: false    // 顺带显示「已填满」的节点（**不计入待补条数**）
};

/**
 * 「依据强度」下拉里的一项：`D 推断（城市→赛区…）` 这样带一句人话。
 *
 * ⚠️ 级别与文案都取自 `core/natureConfidence.js`（**唯一处**），这里只把它拼成一行。
 */

function confidenceOptionLabel(level) {
    return levelLabel(level);
}

/**
 * 把一组 nature 字段写进**一个节点** —— 类型分派只有这一处。
 *
 * 为什么不用一个通用写入口：`updateP / updateR / updateWS` 各自带**只读守卫**
 * （`assertManualEditAllowed`）与**类型校验**，绕过它们 = 在查看别人账户时还能改数据。
 * 这里只按类型转发，别的什么都不做。
 *
 * ⚠️ 节点不存在就**抛**（事务回滚，整批不写）——
 *    "静默跳过一条"会让人以为填完了，而实际上漏了一条。
 */

function writeNatureFields(draft, id, fields) {
    const node = draft.nodes[id];
    if (!node) throw new Error('节点不存在，未写入：' + id);
    if (node.type === 'P') return updateP(draft, id, fields);
    if (node.type === 'R') return updateR(draft, id, fields);
    return updateWS(draft, id, fields);          // W / S / C
}

/**
 * 把填充条里的值写进选中的条目（**一次事务**）。
 *
 * 三条口径（都是"宁可少写，不写错"）：
 *   · **只写填了值的字段**：空着的字段"不动"，不是"清空"（清空是另一个语义，
 *     不该由一个批量按钮顺手做掉）；
 *   · 小类只接受 `NATURE_SUB_VALUES` 里的**可存值** —— 分组名（「省赛或邀请赛」）
 *     不是可存值（`isKnownNatureValue` 对它返回 false），下拉里本来就没有它，
 *     这里再挡一道，防止将来有人往填充条里塞别的东西；
 *   · 年份走 `isNatureYear`（`^(20\d{2}|待同步|不确定)$`）。这条**故意在界面挡**：`26` / `2026年`
 *     写下去，判重页按年份筛就永远筛不到一起 —— 那正是 nature 要解决的问题本身。
 *     （写路径本身只 trim，不替用户猜，见 `applyNatureFields` 的注释。）
 */

function applyPendingFill(ids, redraw) {
    const targets = (Array.isArray(ids) ? ids : []).filter(Boolean);
    if (!targets.length) {
        showToast('先勾选要补的条目', 'info');
        return;
    }
    const cls = String(pendingState.fillCls || '').trim();
    const year = String(pendingState.year || '').trim();
    const season = String(pendingState.season || '').trim();
    const region = String(pendingState.region || '').trim();

    const fields = {};
    if (cls) {
        const problem = classPathProblem(cls);
        if (problem) {
            showToast(`分类不在注册表里：${problem}`, 'error');
            return;
        }
        fields.natureClass = cls;
    }
    if (year) {
        if (!isNatureYear(year)) {
            showToast('年份（举办年份）要写成 20xx（例如 2025）；还没定下来写「待同步」或「不确定」；'
                + '拿不准就留空', 'error');
            return;
        }
        fields.natureYear = year;
    }
    if (season) {
        if (!isNatureSeason(season)) {
            showToast('赛季要写成 20xx（例如 2025）、「无」（没有赛季概念的那些比赛：CF 正式轮次 / AtCoder）'
                + '或「待同步」/「不确定」；拿不准就留空', 'error');
            return;
        }
        fields.natureSeason = season;
    }
    if (region) fields.natureRegion = region;
    if (!Object.keys(fields).length) {
        showToast('先在上面填一个要补的值（分类 / 年份 / 赛季 / 地区）', 'info');
        return;
    }

    // 填充条**先清空**：事务成功后页面会重画（重画的取值都来自这里），
    // 不清的话用户会看到刚填过的值还留在框里、以为没生效。
    // （代价：事务失败时这几个字也没了 —— 宁可重敲也不误导。）
    pendingState.fillCls = '';
    pendingState.year = '';
    pendingState.season = '';
    pendingState.region = '';

    runWrite((draft) => {
        for (const id of targets) writeNatureFields(draft, id, fields);
        return targets.length;
    }, (n) => `已补 ${n} 条的性质`).catch(() => {});
    if (typeof redraw === 'function') redraw();
}

/**
 * 一行里的三个 nature 小标签（分类 / 年份 / 地区）——**链接块左边**：判重整理的每个页面
 * 都在链接左侧显示 3 个 nature（可点击修改），无论是否已填满。
 *
 * 点任意一个 ⇒ 打开**编辑弹窗**（`showFormDialog` + `natureFieldDescriptors`）：三个字段一起改，
 * 控件与「编辑节点」里的那一套**是同一份**（分类是 Trie 下拉、年份/地区是文本框），
 * 所以这里不会出现"两套口径"（连"当前值不在 Trie 里也要留着"这种细节都自动一致）。
 *
 * ⚠️ 空值显示成 `—`（不是什么都不画）："这个节点没标年份"本身就是要看的信息。
 *
 * ⚠️ **三种颜色**（分类填了但不够细的用蓝）：
 *    · **绿** = 填好了（分类**到了叶子**；年份/地区非空即可）；
 *    · **蓝** = 有值但**没到叶子**（只有"分类"这一维会有这种状态）—— 与"还没填"（灰）区分开：
 *      这既不是缺，也不是完成，是"停在中途，还得往下补一层"；
 *    · **灰** = 空（没标）。
 */

export function natureChips(nodeId, redraw) {
    const node = (AppState.nodes || {})[nodeId];
    const wrap = mk('span', 'dedup-nature-chips', 'display:inline-flex;gap:4px;align-items:center;');
    if (!node) return wrap;
    for (const key of NATURE_FIELD_KEYS) {
        const f = natureFieldOf(key);
        const label = (f && f.label) || key;
        const raw = String(node[key] === undefined || node[key] === null ? '' : node[key]).trim();
        const text = key === 'natureClass' ? (classLabel(raw) || '—') : (raw || '—');
        // 分类要**到叶子**才算"绿"；其余两维非空即算（与 `natureStatusOf` 同一口径）
        const partial = key === 'natureClass' && !!raw && !isCompleteClassPath(raw);
        // ★ **"确定不用"是第四种状态**（灰）：它是一种特殊的已填，判定冲突时自动忽略。
        //   ⚠️ 它仍然是"填过了"（`state` 不进 `off`），只是不算一个"主张"
        //   （见 `core/synthConflicts.js` 里那两处判据）。
        const na = isNotApplicableValue(key, raw);
        const state = !raw ? 'off' : (na ? 'na' : (partial ? 'partial' : 'on'));
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `dedup-nature-chip ${state}`;
        b.dataset.field = key;
        b.dataset.id = String(nodeId);
        b.dataset.state = state;
        // ★ **四个 nature 都要依据强度徽标**（`A`…`E`）—— 级别来自元列 `分类依据`
        //   （爬虫写的规则 id）；**人改过 ⇒ `M`；没有依据信息 ⇒ 没有徽标**
        //   （那正是"依据未知"，不该画一个冒充的等级）。
        //   四个字段都有规则 id（见 `scripts/crate.py` 的 `class_rules` 与各适配器的
        //   `…:year-*` / `…:season-*`）。
        const rule = classRuleOf(node, key);
        const level = rule ? levelOfClassRule(rule) : '';
        if (level) {
            b.dataset.level = level;
            b.dataset.rule = rule;
        }
        b.textContent = `${label}:${text}${level ? ` · ${level}` : ''}`;
        // ⚠️ **悬停提示也是给人看的字**：这里整段过 `plain()`（去 `**` 与反引号）——
        //    以前只在 `textContent` 上做了，`title` 漏了一片（用户看到悬停里一串星号）。
        b.title = plain(partial
            ? `点击修改「${label}」（当前：${text}）——⚠ 停在半路，没到叶子，所以还算"缺分类"`
            : `点击修改「${label}」（当前：${text}）`);
        if (na) {
            b.title += plain('\n**确定不用**（这一维对这场比赛不适用 / 值在别处）—— 算"填过了"，'
                + '但**判冲突时当作没有主张**（灰色项自动忽略）。');
        }
        if (level) {
            b.title += plain(`\n依据强度：${levelLabel(level)}（规则 ${rule}）`);
        } else if (raw && !na) {
            // ★ 有值、却没有依据徽标 ⇒ 只能判成"依据未知"（人改过会写 `M`）。
            b.title += plain('\n依据：**未知**（没有依据信息）—— 这一格来自**老数据**'
                + '（包里没带 `分类依据` 这一列）。\n'
                + '爬虫重导一次、且包里的判定与它一致时，徽标会自己回来；'
                + '你自己改过之后会标成 `M`（人工）。'
                + '\n（这条值是谁给的，来源面板里看得见。）');
        }
        // 四态：无色 = 还没判 · **灰 = 确定不用（特殊的"已填"）** ·
        // 蓝 = 分类没到叶子 · 绿 = 填好了。灰比"无色"实一点，一眼能分开。
        b.style.cssText = 'font-size:11px;padding:1px 6px;border-radius:10px;cursor:pointer;'
            + (state === 'on'
                ? 'border:1px solid #bbf7d0;background:#f0fdf4;color:#166534;'
                : (state === 'partial'
                    ? 'border:1px solid #bfdbfe;background:#eff6ff;color:#1d4ed8;'
                    : (state === 'na'
                        ? 'border:1px solid #cbd5e1;background:#e2e8f0;color:#475569;'
                        : 'border:1px solid #e2e8f0;background:#f8fafc;color:#94a3b8;')));
        b.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            openNatureEditor(nodeId, redraw);
        });
        wrap.appendChild(b);
    }
    return wrap;
}

/**
 * 改一个节点的性质（三个字段一起）——**复用编辑弹窗那一套**。
 *
 * 写操作走 `runWrite`（`execute` 事务）+ `writeNatureFields`（与编辑面板、③ 填充条同一条路）。
 * 校验只挡两件**写进去就修不回来**的事：分类不在 Trie 里、年份不是 `20xx`。
 */

function openNatureEditor(nodeId, redraw) {
    const node = (AppState.nodes || {})[nodeId];
    if (!node) return;
    showFormDialog(`改性质 · ${nodeLabel(node)}`, natureFieldDescriptors(node), (values) => {
        if (!values) return;                  // ★ 取消 ⇒ 什么都不做（`showFormDialog` 取消给 null）
        runWrite((draft) => {
            writeNatureFields(draft, nodeId, values);
            return 1;
        }, '性质已更新').catch(() => {});
        if (typeof redraw === 'function') redraw();
    }, (values) => {
        const year = String(values.natureYear || '').trim();
        if (year && !isNatureYear(year)) {
            return { ok: false, error: '年份要写成 20xx（例如 2025）；还没定下来写「待同步」或「不确定」；拿不准就留空' };
        }
        const problem = classPathProblem(values.natureClass);
        if (problem) return { ok: false, error: `分类不在注册表里：${problem}` };
        return { ok: true };
    });
}

/**
 * 一条待补的行：☑ + 三个 nature + 节点标签 + 「🔗 链接」+（有依据时）「✍️ 20xx」+「缺：…」。
 *
 * ⚠️ 顺序：链接左侧显示 3 个 nature ⇒ nature 小标签紧挨在链接块左边。
 * ⚠️ 已填满那些行**没有勾选框**（它们不是待补，勾上也没有任何批量动作作用于它们），
 *    名字用**绿色**（未填满的仍是蓝色 —— 未填满的超链接是蓝色、已填满的用绿色）。
 * ⚠️ 推荐按钮挂在 `<label>` 里：必须 `preventDefault/stopPropagation`
 *    （不然点它会顺带勾上勾选框）。`<button>` 在真浏览器里本来就不触发 label 激活，
 *    这里再拦一道是为了**不依赖那条细则**。
 */

function pendingRow(item, redraw) {
    const row = mk('label', 'dedup-pending-row',
        'display:flex;align-items:center;flex-wrap:wrap;gap:6px;font-size:13px;color:#0f172a;margin:1px 0;'
        + (item.filled ? 'opacity:.92;' : ''));

    if (!item.filled) {
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'dedup-pending-check';
        cb.dataset.id = item.id;
        cb.checked = pendingState.selected.has(item.id);
        cb.addEventListener('change', () => {
            if (cb.checked) pendingState.selected.add(item.id);
            else pendingState.selected.delete(item.id);
            redraw();                 // 勾选数写在按钮上；重画不会丢输入（取值都在 pendingState）
        });
        row.appendChild(cb);
    }

    const name = mk('span', 'dedup-pending-name', 'flex:1;min-width:0;');
    name.textContent = nodeLabel((AppState.nodes || {})[item.id]);
    // 未填满 = 蓝、已填满 = 绿（点名字都是"跳到树上"，`wireGotoLinks` 里 `preventDefault`）
    markGoto(name, item.id, item.filled ? '#15803d' : '#1d4ed8');
    row.appendChild(name);

    row.appendChild(natureChips(item.id, redraw));      // ← 链接左侧那几个 nature（分类/年份/赛季/地区）

    const links = linkBlockOf(item.id, 'margin-right:4px;');
    if (links) row.appendChild(links);

    // 「推荐」按**字段**各给一个（口径全在 `core/natureSuggest.js`）：
    // 年份 = 举办年份（只认开赛时间）、赛季（只认标识/名字/容器）——两个概念不互相顶替。
    if (!item.filled && item.missing.includes('natureYear')) {
        const s = suggestNatureYear(AppState, item.id);
        if (s) row.appendChild(suggestChip('年份', s, () => applySuggestedYears([item.id], redraw)));
    }
    if (!item.filled && item.missing.includes('natureSeason')) {
        const s = suggestNatureSeason(AppState, item.id);
        if (s) row.appendChild(suggestChip('赛季', s, () => applySuggestedYears([item.id], redraw)));
    }

    if (!item.filled) {
        const miss = mk('span', 'dedup-pending-missing', 'font-size:12px;color:#b45309;white-space:nowrap;');
        miss.textContent = '缺：' + item.missing
            .map(k => { const f = natureFieldOf(k); return (f && f.label) || k; })
            .join('、');
        // ⚠️ 分类字段只有在 Trie 的叶子节点时才被视为填好 ⇒ 会出现
        //    "分类明明有值却写着缺分类"，这里把原因说出来（不然像个 bug）。
        const clsStuck = item.missing.includes('natureClass') && !!item.cls;
        if (clsStuck) {
            const why = mk('span', 'dedup-pending-class-why',
                'font-size:12px;color:#94a3b8;white-space:nowrap;');
            why.textContent = `（分类还停在 ${item.cls}，没到叶子）`;
            miss.appendChild(why);
        }
        row.appendChild(miss);
    } else {
        const ok = mk('span', 'dedup-pending-filled-mark', 'font-size:12px;color:#15803d;white-space:nowrap;');
        ok.textContent = '✅ 已填满';
        row.appendChild(ok);
    }
    return row;
}

/**
 * 「✍️ 2024」那个小按钮 —— 推荐值的**唯一**写法入口。
 *
 * class 用 `dedup-suggest`（**刻意不挂 `.btn` / `.dedup-chip`**）：既有冒烟按那两个 class
 * 找"操作按钮"与"筛选芯片"，别让这一行的推荐混进去（与 `dedup-subtab` 同一个理由）。
 *
 * ⚠️ 按钮上带**依据强度**（`s.level`，见 `core/natureConfidence.js`）——
 * 文案写成 `✍️ A·年份 2024`、`dataset.level` 也给一份（筛选/冒烟都能读），
 * `title` 开头写清是哪个级别。批量那个按钮才有"按级别收"的门槛（见 `pendingFillBar`）。
 */

function suggestChip(fieldLabel, s, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'dedup-suggest';
    b.dataset.value = s.value;
    b.dataset.field = String(fieldLabel || '');
    if (s.level) b.dataset.level = s.level;
    // ⚠️ `s.why` 是**推荐引擎写的散文**（带 Markdown 记号）⇒ 悬停提示要过 `plain`
    b.title = plain(`推荐${fieldLabel ? `「${fieldLabel}」` : ''} ${s.value}：${s.why}（点了才写入）`
        + (s.level ? `\n依据强度：${levelLabel(s.level)}` : ''));
    // 两个字段各有一个按钮 ⇒ 按钮上得写明**是哪个字段**（不然两个 `✍️ 2024` 长得一样）
    b.textContent = `✍️ ${s.level ? `${s.level}·` : ''}${fieldLabel ? `${fieldLabel} ` : ''}${s.value}`;
    b.style.cssText = 'font-size:12px;padding:1px 8px;border:1px solid #bfdbfe;'
        + 'border-radius:10px;background:#eff6ff;color:#1d4ed8;cursor:pointer;white-space:nowrap;';
    b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
    });
    return b;
}

/**
 * 按推荐填「年份（举办）」与「赛季」：**每一条用它自己那些推荐值**（一次事务写完）。
 *
 * 为什么不是"填一个值给一批"：年份/赛季都是**每条一个**的（同一个容器下也各是各的），
 * 这才是这一栏真正省事的地方。推不出来的字段**不动**（不是填空、更不是猜），
 * 写完在提示里如实说"还有 N 条没有依据"。
 *
 * ⚠️ `minLevel` = 选的**依据强度门槛**（`A`…`E`）——
 * 低于门槛的推荐**不写**（见 `suggestNatureFields` 的 `opts.minLevel`），
 * 提示里照实说"其中 M 条因为依据太弱被跳过"。
 */

function applySuggestedYears(ids, redraw, minLevel) {
    const targets = (Array.isArray(ids) ? ids : []).filter(Boolean);
    if (!targets.length) {
        showToast('先勾选要补的条目', 'info');
        return;
    }
    const level = minLevel || pendingState.suggestMinLevel || 'E';
    const suggestions = suggestNatureFields(AppState, targets, { minLevel: level });
    if (!suggestions.length) {
        showToast(`这 ${targets.length} 条都没有「${level} 级及以上」的依据（不猜），留给你手填`, 'info');
        return;
    }
    let fieldCount = 0;
    for (const s of suggestions) fieldCount += Object.keys(s.fields).length;
    runWrite((draft) => {
        for (const s of suggestions) writeNatureFields(draft, s.id, s.fields);
        return { filled: suggestions.length, rest: targets.length - suggestions.length, fieldCount };
    }, (r) => `已按推荐补 ${r.filled} 条（共 ${r.fieldCount} 个字段：年份=举办年份、赛季=赛季年份；`
        + `依据门槛 ${level} 级）`
        + (r.rest > 0 ? `；还有 ${r.rest} 条没有这么硬的依据，留给你手填` : '')).catch(() => {});
    if (typeof redraw === 'function') redraw();
}

/**
 * ③ 的大类 chip 行：`全部（1242）` + 每个大类一个 chip（`CF（594）`…）。
 *
 * 为什么单开一行而不是复用 ② 的筛选控制栏：③ **刻意不受 ② 的范围/条件影响**
 * （它回答"树上还有什么没补"，不是"当前这批建议里有什么"），两者维度也不同
 * （② 筛的是"哪一对"，③ 筛的是"哪一族"）。
 *
 * class 用 `dedup-pending-main`（**不挂 `.dedup-chip` / `.btn`**）：既有冒烟按那两个
 * class 找筛选芯片与操作按钮，别让这一行混进去。
 */

function pendingMainBar(roots, total, noClsCount, redraw) {
    const bar = mk('div', 'dedup-pending-mains',
        'display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px;');
    // ⚠️ 这是**分类筛选的快捷方式**（按**第一段**分族，带条数）：真值仍存在 `pendingState.cls`，
    //    与下面筛选行的「分类」下拉是**同一个状态**（点 chip = 选 `cf`；下拉还能选更深的路径）。
    // ⚠️ 哨兵：`全部` 与 `没标分类`（分类是空串）**必须能区分**，否则两个 chip 的
    //    `data-main` 都是空串、点谁都一样（`pendingState` 里只存一个字符串，没有第二个位置）。
    const chips = [{ key: ALL_CLASSES, label: '全部', count: total, cls: '' },
        // ⚠️「没标分类」**永远在**（count 为 0 也画）——三个维度口径一致：
        //    「（没标分类）」在筛选行里有，这里也得有。
        { key: NO_CLASS, label: NATURE_NO_MAIN_LABEL, count: noClsCount, cls: '' },
        ...roots.map(r => ({ key: r.root, label: r.root, count: r.count, cls: r.root }))];
    for (const c of chips) {
        // 多选：`全部` = 一个都没选；其余 key 看它在不在数组里
        const on = c.key === ALL_CLASSES ? pendingState.cls.length === 0 : pendingState.cls.includes(c.key);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'dedup-pending-main' + (on ? ' dedup-pending-main-on' : '');
        btn.dataset.main = c.key === ALL_CLASSES || c.key === NO_CLASS ? '' : c.cls;
        btn.textContent = `${c.label}（${c.count}）`;
        btn.title = plain(c.key === ALL_CLASSES ? '看全部分类'
            : (c.cls ? `只看 ${c.label} 这一支（含它下面所有更深的分支）`
                : '只看**连分类都没标**的比赛（在填充条上补分类）'));
        btn.style.cssText = `font-size:12px;padding:2px 8px;cursor:pointer;border-radius:10px;`
            + `border:1px solid ${on ? '#2563eb' : '#d1d5db'};`
            + `background:${on ? '#2563eb' : '#fff'}; color:${on ? '#fff' : '#334155'};`;
        btn.addEventListener('click', () => { setClassFilter(c.key, redraw); });
        bar.appendChild(btn);
    }
    return bar;
}

/** 设「分类筛选」整份选中（筛选行的 chipGroup 与下面那个"切换一个"共用这一处，两边永远同值） */
function setClassFilterList(next, redraw) {
    pendingState.cls = [...next];
    pendingState.fillCls = '';   // 「要填的分类」也跟着回默认（避免手滑把整支改成别的）
    pageState.pending = 1;
    redraw();
}

/** 大类 chip 行：**切换一个**（`全部` = 清空整个选中） */
function setClassFilter(key, redraw) {
    if (key === ALL_CLASSES) return setClassFilterList([], redraw);
    const has = pendingState.cls.includes(key);
    setClassFilterList(has ? pendingState.cls.filter(v => v !== key) : [...pendingState.cls, key], redraw);
}

/**
 * ③ 的**筛选**行 —— **三个字段都在这一行**：分类（按前缀）/ 年份 / 地区。
 *
 * **三个**筛选字段：nature 就是三个字段（分类 / 年份 / 地区），筛选行与它们**一一对应**。
 * 最左边那个「分类」下拉与上面那排 chip **同一份状态**（chip 是第一段/一族的快捷方式，
 * 下拉可以选**更深的路径**，选 `cf/div2` 就只留 `cf/div2` 开头的那批）。
 *
 * 取值从**当前列表里收集**（不穷举 Trie，与 ② 的 facet 同一口径），并各给一个
 * 「（没标…）」项 —— "还没标"本身就是有用的筛（地区在原料数据里**一律**是空的，
 * 没这一项就永远只看得到"已填"的那些）。
 *
 * ⚠️ `scopeItems` = **候选来源**（开了"同时显示已填满"时是两摞的并集），`allItems` = 报数口径
 *    （"./N 条"说的是**待补**有多少条 —— 已填满的不计数）。
 *
 * ⚠️ 与填充条**分开两行**：填充条那一行是"要写入的值"（"不改动"什么都不写），
 *    挨着放太容易看成筛选器（实测被当成"nature 筛选不生效"）。
 */

function pendingFilterBar(scopeItems, allItems, shownCount, redraw) {
    const bar = mk('div', 'dedup-pending-filter',
        'display:flex;align-items:center;flex-wrap:wrap;gap:8px;font-size:12px;color:#475569;margin-bottom:6px;');
    const label = mk('span', '', 'color:#64748b;');
    label.textContent = '筛选：';
    bar.appendChild(label);

    // ① 分类（**前缀**；与 chip 行同一份状态）
    const clsValues = [];
    for (const it of scopeItems) {
        const segs = classPathOf(it.cls);
        for (let i = 1; i <= segs.length; i++) {
            const v = segs.slice(0, i).join('/');
            if (!clsValues.includes(v)) clsValues.push(v);
        }
    }
    // ⚠️ 除了「全部」「（没标分类）」，还多一个 **`（分类不完全）`**：
    //    有值但**没到 Trie 的叶子** ⇒ 按口径它仍算「缺分类」，得能一键把它们筛出来补。
    const clsOpts = [{ value: NO_CLASS, label: `（${NATURE_NO_MAIN_LABEL}）` },
        { value: PARTIAL_CLASS, label: '（分类不完全）' },
        ...clsValues.sort().map(v => ({ value: v, label: classLabel(v) }))];
    // 多选（空选 = 全部）；顺手把已经不在候选里的值回收掉
    pendingState.cls = pendingState.cls.filter(v => clsOpts.some(o => o.value === v));
    bar.appendChild(field('分类', chipGroup(clsOpts, pendingState.cls,
        (next) => { setClassFilterList(next, redraw); })));

    // ②③④ 年份（举办）/ 赛季 / 地区（值从当前列表里收集）
    const years = [];
    const seasons = [];
    const regions = [];
    for (const it of scopeItems) {
        const n = (AppState.nodes || {})[it.id] || {};
        const y = String(it.year || '');
        if (!years.includes(y)) years.push(y);
        const s = String(it.season || '');
        if (!seasons.includes(s)) seasons.push(s);
        const r = String(n.natureRegion || '');
        if (!regions.includes(r)) regions.push(r);
    }
    // ⚠️「（没标 X）」「（有标 X）」**无条件列在最前**（不看当前有没有这样的条目）—— 各维度口径一致，
    //    而且"先把没标的筛出来补"正是这一块的常用动线；
    //    「（有标 X）」是第三个：一眼看清"哪几维已经处理过了"
    //    （含 `无` / `待同步` / `不确定` 这些"值不是年份但有值"的情况）。
    const withEmpty = (values, emptyLabel, hasLabel) => {
        const out = [{ value: NO_VALUE, label: emptyLabel }, { value: HAS_VALUE, label: hasLabel }];
        for (const v of values.filter(x => x).sort()) out.push({ value: v, label: v });
        return out;
    };
    const defs = [
        ['filterYear', '年份', years, '（没标年份）', '（有标年份）'],
        ['filterSeason', '赛季', seasons, '（没标赛季）', '（有标赛季）'],
        ['filterRegion', '地区', regions, '（没标地区）', '（有标地区）']
    ];
    for (const [key, fieldLabel, values, emptyLabel, hasLabel] of defs) {
        // 多选（空选 = 全部）；去掉原来那一项「全部」——空选就是全部
        const opts = withEmpty(values, emptyLabel, hasLabel);
        pendingState[key] = pendingState[key].filter(v => opts.some(o => o.value === v));
        bar.appendChild(field(fieldLabel, chipGroup(opts, pendingState[key],
            (next) => { pendingState[key] = next; pageState.pending = 1; redraw(); })));
    }

    // ⑤ **依据强度**（"只看 C 以下"）——
    //    "这条分类是**哪条规则**判出来的"（元列 `分类依据`）→ 级别（`core/natureConfidence.js`）。
    //    用它回答的是："**哪些分类是我该复核的**"（靠赛名/城市推出来的那些）。
    //    ⚠️ 选项是「**≤ X**」= 该级**及更弱**（A 最硬 ⇒ `≤ A` 只排除"没有依据"的）；
    //    ⚠️ **人填的（`M`）不在任何"≤ X"里** —— 它比 A 还硬（`levelRank('M')` 最小），
    //       那不是"依据弱"，是**人的结论**；要看它们用专门的「M 人工」那一档。
    //    ⚠️ 级别未知（老数据、从来没写过 `分类依据`）也不在"≤ X"里：那是"没有依据这回事"。
    const lvOpts = [{ value: '', label: '全部' },
        { value: MANUAL_LEVEL, label: `${MANUAL_LEVEL} 人工（只看我填的）` },
        ...RULE_LEVELS.slice()
            .reverse()
            .map(lv => ({ value: lv, label: `≤ ${levelLabel(lv).split('（')[0]}` }))];
    if (pendingState.classLevel && !lvOpts.some(o => o.value === pendingState.classLevel)) {
        pendingState.classLevel = '';
    }
    bar.appendChild(field('依据', selectControl(lvOpts, pendingState.classLevel,
        (v) => { pendingState.classLevel = v; pageState.pending = 1; redraw(); })));

    const on = !!(pendingState.filterYear.length || pendingState.filterSeason.length || pendingState.filterRegion.length)
        || pendingState.classLevel !== ''
        || pendingState.cls.length > 0;
    if (on) {
        bar.appendChild(button('清空筛选', 'font-size:12px;padding:2px 8px;', () => {
            pendingState.filterYear = [];
            pendingState.filterSeason = [];
            pendingState.filterRegion = [];
            pendingState.classLevel = '';
            pendingState.cls = [];
            pendingState.fillCls = '';
            pageState.pending = 1;
            redraw();
        }));
    }
    bar.appendChild(hint(on
        ? `筛后 ${shownCount} / ${allItems.length} 条`
        : `${allItems.length} 条`));
    return bar;
}

/** 改「大类筛选」——chip 行与筛选行的下拉**共用这一处**（两边永远同值） */

function setMainFilter(key, redraw) {
    if (pendingState.main === key) return;
    pendingState.main = key;
    pendingState.sub = '';       // 换了族 ⇒ 小类下拉的候选也变了，清掉免得留一个非法值
    pendingState.fillMain = '';  // 「要填的大类」也跟着回默认（避免手滑把整族改成别的大类）
    pageState.pending = 1;
    redraw();
}

/**
 * 下拉里的分类文案：**没细到叶子的路径标一下**（分类只有在 Trie 的
 * 叶子节点时才被视为填好）——不然"选了 `xcpc/icpc` 却还挂在待补里"看起来像 bug。
 */

function classOptionLabel(value) {
    const label = classLabel(value) || String(value || '');
    return isCompleteClassPath(value) ? label : `${label}（还没到叶子）`;
}

/**
 * 填充条：**一次事务填一批**。
 *
 * 朴实到底（下拉 / 批量控件保持最朴素 —— 原生 `<select>` + 复选框即可）：
 * 「分类」一个下拉 + 「年份」「地区」两个文本框 + 三个按钮。
 * ⚠️ 每个字段都有"**不改动**"这个默认状态：批量填年份时**不会**顺手把分类抹掉。
 * ⚠️ 这是**要写入的值**，不是筛选器（筛选在上面那一行）—— 行的开头写着「✍️ 批量填入」，
 *    免得再被当成 nature 筛选。
 *
 * ⚠️ **分类下拉 = Trie 里所有合法路径**（`CLASS_PATHS`，展平）：
 *    连分类都没标的比赛（C）**只在这一块里能补分类** —— 否则行尾写着"缺：分类"却无处可填。
 *    下拉只列注册表里的路径 ⇒ "填进去的值一定合法"这件事由控件本身保证（写路径还会再挡一道）。
 */

function pendingFillBar(items, redraw) {
    const pendingIds = new Set(items.map(it => it.id));
    const box = mk('div', 'dedup-pending-fill', 'display:flex;align-items:center;flex-wrap:wrap;gap:10px;'
        + 'padding:8px 10px;border:1px solid #eef2f6;border-radius:8px;background:#fcfdff;margin-bottom:8px;');

    const fillTitle = mk('span', 'dedup-pending-fill-title', 'font-size:12px;color:#334155;font-weight:600;');
    fillTitle.textContent = '✍️ 批量填入（不改动 = 不写这个字段）：';
    box.appendChild(fillTitle);

    box.appendChild(field('分类', selectControl(
        [{ value: '', label: '（不改动）' },
            ...CLASS_PATHS.map(p => ({ value: p.value, label: classOptionLabel(p.value) }))],
        pendingState.fillCls,
        (v) => { pendingState.fillCls = v; }
    )));
    box.appendChild(field('年份', textInput(pendingState.year,
        '举办年份 20xx（不改动就留空）',
        (v) => { pendingState.year = v; }, '170px', natureInputSuggestions('natureYear'))));
    box.appendChild(field('赛季', textInput(pendingState.season,
        '赛季年 20xx / 无 / 待同步（不改动就留空）',
        (v) => { pendingState.season = v; }, '200px', natureInputSuggestions('natureSeason'))));
    box.appendChild(field('地区', textInput(pendingState.region, '如 Asia East（不改动就留空）',
        (v) => { pendingState.region = v; }, '170px')));

    const selected = [...pendingState.selected].filter(id => pendingIds.has(id));
    const fillBtn = button(selected.length ? `填入选中的 ${selected.length} 条` : '填入选中的条目',
        'font-size:12px;padding:3px 12px;', () => applyPendingFill(
            [...pendingState.selected].filter(id => pendingIds.has(id)), redraw));
    fillBtn.className = 'btn dedup-pending-fill-btn';
    box.appendChild(fillBtn);

    // 全选本页 = 只勾**当前这一页**的条目（别的页的条目界面上根本看不到，
    // 勾上是"看不见的选择"，比没有更糟）。
    box.appendChild(button('全选本页', 'font-size:12px;padding:3px 10px;', () => {
        for (const it of slice(items, 'pending')) pendingState.selected.add(it.id);
        redraw();
    }));
    box.appendChild(button('清空选择', 'font-size:12px;padding:3px 10px;', () => {
        pendingState.selected.clear();
        redraw();
    }));

    // 「按推荐填年份 / 赛季」：**每条用它自己那些推荐值**（见 `applySuggestedYears`）。
    // 一个字段都推不出来的**不写**，所以按钮上先写清楚"有几条能推"。
    // ★ 前面的下拉是**依据强度门槛**（接受 A/B/C/D/E 级及以上的推荐）——
    //   门槛一改，能推的条数当场跟着变（按钮上的 N 就是这个门槛下的数字）。
    //   ⚠️ 只列**规则**级别（`RULE_LEVELS`）：`M 人工` 不是"规则"，推荐永远不会是它
    //      （列上去只会让人以为"选 M 能收到人工的推荐"）。
    const levelSel = selectControl(
        RULE_LEVELS.map(lv => ({ value: lv, label: confidenceOptionLabel(lv) })),
        pendingState.suggestMinLevel,
        (v) => { pendingState.suggestMinLevel = v; redraw(); });
    levelSel.className = 'dedup-select dedup-suggest-level';
    levelSel.title = plain('按推荐填时**接受哪一档依据及以上**：'
        + RULE_LEVELS.map(lv => confidenceOptionLabel(lv)).join('｜')
        + '\n（级别只控制"批量按推荐填"，不影响每行那个单独的 ✍️ 按钮）');
    box.appendChild(field('依据≥', levelSel));
    const selectedIds = [...pendingState.selected].filter(id => pendingIds.has(id));
    const suggestible = suggestNatureFields(AppState, selectedIds,
        { minLevel: pendingState.suggestMinLevel });
    const suggestBtn = button(
        suggestible.length
            ? `✍️ 按推荐填年份/赛季（${suggestible.length} 条）`
            : '✍️ 按推荐填年份/赛季',
        'font-size:12px;padding:3px 12px;',
        () => applySuggestedYears(selectedIds, redraw, pendingState.suggestMinLevel));
    suggestBtn.className = 'btn dedup-pending-suggest-btn';
    suggestBtn.title = plain('年份=**举办年份**（只认本节点开赛时间）；赛季=**赛季年份**（标识 > 名字 > 父容器）；'
        + `只接受**${pendingState.suggestMinLevel} 级及以上**的依据（可在左边那个下拉里改）；`
        + '没有依据的字段一律不写');
    box.appendChild(suggestBtn);

    box.appendChild(hint(`${items.length} 条待补，每页 ${PAGE_SIZE} 条`
        + (selected.length ? `；已选 ${selected.length} 条` : '')));
    return box;
}

/**
 * ③ 里那个「📤 导出人工填写（回代 baseline）」——
 *
 * 回代闭环（`docs/manual-workflow.md`（回代闭环））：**脚本产出 → 人在应用里补/接受 → 应用导出 ③
 * → 下次脚本跑先读它做 baseline**。没有这一步，"我改过的那些"会在规则重跑时被重新推一遍。
 *
 * ⚠️ 导的是**人定过的**（`分类依据` = `manual:set`，级别 `M`）—— 别的值脚本能复现，不必带回去。
 *
 * ★ **点一下直接写进 `acm-data/nature-assignments.json`**（不走"下载一份 + 人自己搬进
 * `acm-data/`"—— 浏览器还会把它存成 `nature-assignments (2).json`，得靠人挑最新的）：
 *   · **不备份** —— 这份文件是导出物，应用数据里那些人工值随时能再导一次；
 *   · **缩水（比磁盘上那份少了节点）默认拒绝**（服务器 409）⇒ 问一句，确认后再写；
 *   · 服务器不在 / 旧进程（不认这条接口）⇒ **退回到"下载一份"**并说明，不让人无路可走。
 */

function natureBaselineExportRow() {
    const row = mk('div', 'dedup-pending-baseline', 'display:flex;align-items:center;gap:8px;'
        + 'font-size:12px;color:#475569;margin-bottom:6px;flex-wrap:wrap;');
    const label = mk('span', '', 'color:#64748b;');
    label.textContent = '回代：';
    row.appendChild(label);

    const btn = button('📤 导出人工填写', 'font-size:12px;padding:3px 10px;', async () => {
        const payload = collectNatureAssignments(AppState, {
            generatedAt: new Date().toISOString(),
            registryVersion: NATURE_REGISTRY_VERSION
        });
        if (!payload.count) {
            showToast('还没有人工改过的 nature（手改过之后才有东西可导）', 'info');
            return;
        }
        try {
            const out = await saveNatureBaseline(undefined, undefined, { doc: payload });
            showToast(`已写入 acm-data/nature-assignments.json：${out.count} 个节点 / `
                + `${out.fields} 处人工填写`
                + (payload.bindings ? ` / ${payload.bindings} 条手工绑定` : '')
                // ★ **"人确认过这一组"**也要念出来（否则你不知道确认有没有写进 baseline ——
                //   它不在 nature 四字段里、也不在成员指针里，是**组头**那一格）
                + ((payload.confirmedGroups || []).length
                    ? ` / ${payload.confirmedGroups.length} 组已确认` : '')
                + `（${diffText(out.diff)}）`, 'success');
        } catch (err) {
            if (err && err.status === 409 && err.data && err.data.diff) {
                // ★ 缩水：**先拒绝**（服务器一个字没写），问过用户再决定
                const gone = (err.data.diff.removedKeys || []).slice(0, 12);
                const more = Math.max(0, (err.data.diff.removed || 0) - gone.length);
                const sure = window.confirm(
                    `这次比磁盘上那份少了 ${err.data.diff.removed} 个节点：\n`
                    + gone.map((k) => `· ${k}`).join('\n')
                    + (more ? `\n…还有 ${more} 个` : '')
                    + '\n\n少了通常意味着"应用里那批人工值被别的操作冲掉了"。'
                    + '\n仍要覆盖磁盘上那份吗？（取消 = 什么都不动）');
                if (!sure) {
                    showToast('已取消：磁盘上那份没动', 'info');
                    return;
                }
                try {
                    const out = await saveNatureBaseline(undefined, undefined,
                        { doc: payload, confirm: true });
                    showToast(`已覆盖写入：${out.count} 个节点 / ${out.fields} 处`
                        + `（${diffText(out.diff)}）`, 'success');
                } catch (err2) {
                    showToast(`写不进去：${(err2 && err2.message) || err2}`, 'error');
                }
                return;
            }
            // 服务器不在 / 旧进程不认这条接口 ⇒ **退回下载**（下载那条路仍然能用）
            downloadJsonFile('nature-assignments.json', payload);
            showToast(`直接写盘没成（${(err && err.message) || err}）⇒ 已下载一份：`
                + '把它放到 acm-data/nature-assignments.json 也一样（要重启主脚本才能直接写）',
            'warning');
        }
    });
    btn.className = 'btn dedup-baseline-export';
    btn.title = plain('把我手改/确认过的那几处 nature（级别 M）**直接写进** '
        + 'acm-data/nature-assignments.json：\n'
        + '· 文件里只有**人定过的**（别的值是规则的产物，脚本重跑能复现）；\n'
        + '· **不备份**（这份文件本身就是导出物，应用数据里随时能再导一次）；\n'
        + '· 比磁盘上那份**少了节点时先拒绝**，问过你才写；\n'
        + '· 之后 `python -B scripts/nature-baseline.py apply` 会把它回写进包 ——'
        + '规则改动也就冲不掉你定过的值。');
    row.appendChild(btn);

    const tip = mk('span', '', 'color:#94a3b8;');
    tip.textContent = plain('（手改过的值与**手工绑定的归属**都会标成 M；直接写进 acm-data/nature-assignments.json）');
    row.appendChild(tip);
    row.appendChild(natureBaselineVerdict());
    return row;
}

/**
 * ★ **由原料脚本端给出的核对**，只读（『手输与自动计算结果一致』的列表，作为只读提示）。
 *
 * 数据来自包顶层 `reports.baseline`（`scripts/nature-baseline.py` 回代时顺手算的，
 * `embed-reports.py` 随包发布；应用**不重算** —— 它不知道"若不禁用人工标记，管线会判成什么"）：
 *   · `sameAsAuto`  —— 包里**脚本自己算的值**与你手输的**一致**（钉不钉都一样）；
 *   · `differs`     —— 脚本有个值、但与你手输的不同（**钉住真的在起作用**）；
 *   · `filledEmpty` —— 包里那一格本来空着（你补的是缺口）；
 *   · `missing`     —— baseline 里的 identity 在这个包里找不到（那场没了 / key 改了）；
 *   · `renamed`     —— identity 还在，但它**现在指着另一场**（名字对不上：换读法 / 改名）
 *                      ⇒ 那几条手填**一条都没套**（回代按名字核对过，见 `scripts/nature-baseline.py`）。
 *
 * ⚠️ 这一块**只读**：它不提供"取消钉住"的按钮 —— 想撤销只有一条路（把那一格清空，让规则重新接管），
 *    那会丢掉这个结论，属于人的决定，不该在这行顺手做掉。
 */
function natureBaselineVerdict() {
    const b = AppState.reports && AppState.reports.baseline;
    const box = mk('div', 'dedup-baseline-verdict',
        'font-size:12px;color:#64748b;line-height:1.8;width:100%;');
    if (!b || typeof b !== 'object') {
        box.textContent = '（还没有脚本端的核对：下次重建会随包带一份）';
        return box;
    }
    const base = b.baseline || {};
    const head = mk('div', '', '');
    head.textContent = `上次重建的核对（盘上 ${base.nodes || 0} 节点 / ${base.fields || 0} 处）：`
        + `与脚本算出来的一致 ${b.sameAsAuto || 0} 处 · 压住了脚本的值 ${b.differs || 0} 处 · `
        + `包里本来空着 ${b.filledEmpty || 0} 处`;
    box.appendChild(head);
    if (b.missing) {
        const miss = mk('div', '', 'color:#b45309;');
        // ⚠️ 措辞说**时点**：这一串是"**回代那一刻**"的核对，而合成节点还会在
        //    **后面的步骤**里被建出来 / 改名（`synth-bind` 新建组、旧清单键换新键）——
        //    写成"在包里找不到"会让人以为包坏了；说清"那一刻还不在"才准确，
        //    而且它正好指出了该做什么（对齐组头 / 改到该键 / 重新导出人工填写）。
        miss.textContent = plain(`⚠️ 回代那一刻、这 ${b.missing} 个 identity 还不在包里`
            + '（组头多半是**之后**才建出来 / 改名的）⇒ 那几格手填没落上：'
            + `${(b.missingKeys || []).slice(0, 5).join('、')}${b.missing > 5 ? '…' : ''}`);
        box.appendChild(miss);
    }
    if (b.renamed) {
        // ⚠️ 这一档**不是"值过期"，是"身份换了"**：同一个键（`qoj:c:<id>` 这种）因为
        //    **换读法 / 改名**现在指着**另一场** —— 套上去就是把 A 场的结论按到 B 场上
        //    （实测：25/24 浙江省赛被 `qoj:c:1780/2021` 的旧条目涂成 UC）。回代那边
        //    **一条都没套**，这里把"两边分别叫什么"如实列出来，让人去改 baseline 的键或删掉。
        const ren = mk('div', '', 'color:#b45309;');
        const first = (b.renamedItems || [])[0];
        ren.textContent = plain(`⚠️ 这 ${b.renamed} 条手填**名字对不上**（同一个键现在指另一场）`
            + '⇒ **一条都没套**（回代只按 extKey 找节点，不看它还是不是那一场）：'
            + (first ? `${first.key}（baseline 写的是「${first.was}」，包里是「${first.now}」）` +
                (b.renamed > 1 ? ` 等 ${b.renamed} 条` : '') : ''));
        box.appendChild(ren);
    }
    if (b.invalid) {
        const bad = mk('div', '', 'color:#b45309;');
        bad.textContent = `⚠️ 有 ${b.invalid} 处没写进去（值过不了注册表词表）`;
        box.appendChild(bad);
    }
    // 「与自动一致」的**列表**（默认收起；只读，点开只是看）
    const items = Array.isArray(b.sameAsAutoItems) ? b.sameAsAutoItems : [];
    if (b.sameAsAuto) {
        // ⚠️ "收起"这件事只写**一个地方**（`style.display` 属性），别一半写在 `cssText` 里：
        //    冒烟测试的 DOM 桩只保存 `style.cssText` 字符串、不解析出 `display`
        //    ⇒ 写在 cssText 里的隐藏状态在桩里看不见、切换逻辑会翻过来（实测踩到）。
        const list = mk('div', 'dedup-baseline-same', 'margin:2px 0 0 12px;');
        list.style.display = 'none';
        // ⚠️ 条目里只有 **extKey**（脚本侧不认识应用里的节点 id）⇒ 用既有的 extKey 解析器
        //    找到节点，再 `markGoto` 上去（**别再建第二份 extKey 索引**）。
        const resolve = makeParentResolver(AppState);
        for (const it of items) {
            const f = natureFieldOf(it.field);
            const one = mk('div', '', '');
            const node = resolve(it.key);
            if (node && node.id) {
                const a = mk('span', '', '');
                a.textContent = it.key;
                markGoto(a, node.id);                 // 点一下就跳树（与 ①②⑤ 那几个标识同一条路）
                one.appendChild(a);
            } else {
                one.appendChild(document.createTextNode(it.key));
            }
            one.appendChild(document.createTextNode(` ${(f && f.label) || it.field} = ${it.value}`
                + `（脚本给的也是这个值，依据 ${it.rule || '（无 id）'}）`));
            list.appendChild(one);
        }
        if (b.sameAsAuto > items.length) {
            list.appendChild(mk('div', '', '', `（只列了前 ${items.length} 条，共 ${b.sameAsAuto} 条）`));
        }
        const toggle = button(`▸ 看那 ${b.sameAsAuto} 条（与自动一致）`,
            'font-size:12px;padding:1px 8px;margin-left:6px;', () => {
                const open = list.style.display !== 'none';
                list.style.display = open ? 'none' : 'block';
                toggle.textContent = (open ? '▸ ' : '▾ ')
                    + `看那 ${b.sameAsAuto} 条（与自动一致）`;
            });
        toggle.className = 'btn dedup-baseline-same-toggle';
        toggle.title = plain('这些格：脚本自己也算出了同一个值 ⇒ **钉不钉都一样**（留着无害，想精简可以从这些下手）');
        head.appendChild(toggle);
        box.appendChild(list);
    }
    return box;
}

/** 触发浏览器下载一份 JSON（与 `handlers/H1_jsonIO.js` 里那个同一套动作，各写一份免得跨层依赖） */

function downloadJsonFile(filename, data) {
    const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.download = filename;
    a.href = url;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

/**
 * ③ 性质待补（块本身）。
 *
 * ⚠️ 分页分的是**条目**（不是分组）：一个组跨页时组头会重复出现并标「（续）」——
 *    这样"一页最多画 25 行"这条硬约束才守得住（两三万条也不会把页面拖死）。
 *    组头里的条数**始终是该组的总数**（不是本页的），别把它读成"本页有这么多"。
 *
 * ⚠️ 这一块**不受 ② 的范围 / 筛选条件影响**：它回答的是"树上还有什么没补"，
 *    而不是"当前这批建议里有什么"。共用控制栏会让"补性质"这件事被筛选悄悄阉掉一半。
 */

export function naturePendingSection(model, redraw) {
    const items = model.pendingItems || [];
    const filledAll = model.filledItems || [];         // 已填满的（**不计入**条数，只是"顺便看看"）
    const groups = groupNaturePending(items);          // 已按 **大类（登记序）→ 年份** 排好
    const box = mk('div', 'dedup-pending', 'margin-bottom:16px;');

    const title = mk('div', '', 'font-weight:600;font-size:13px;color:#334155;margin-bottom:6px;');
    title.textContent = `③ 性质待补：${items.length} 条`;
    box.appendChild(title);

    const intro = mk('div', '', 'font-size:12px;color:#64748b;line-height:1.7;margin-bottom:6px;');
    intro.textContent = plain('下面这些节点已经标出分类，但分类没细到叶子 / 年份 / 赛季 / 地区还有空缺'
        + '（缺哪几项写在每行末尾）。先按**分类**缩到一族，再勾选 → 填值 → 一次事务写完。'
        + '⚠️ 地区在原料数据里通常故意留空（脚本不猜），所以这一块会很长：只画当前页。');
    // 「推荐」是先给证据、由你点一下才写：能推的条数写在说明下面（推不出来的不硬凑，见
    // `core/natureSuggest.js`）——地区一律不推（库里还没有真实地名可学）。
    const sugYear = items.filter(it => it.missing.includes('natureYear')
        && suggestNatureYear(AppState, it.id)).length;
    const sugSeason = items.filter(it => it.missing.includes('natureSeason')
        && suggestNatureSeason(AppState, it.id)).length;
    if (sugYear || sugSeason) {
        const tip = mk('div', 'dedup-pending-suggest-tip', 'font-size:12px;color:#1d4ed8;line-height:1.7;margin-bottom:6px;');
        tip.textContent = `✍️ 有依据可以按推荐补的：年份（举办）${sugYear} 条、赛季 ${sugSeason} 条`
            + ' —— 行尾那个「✍️ 年份 20xx」「✍️ 赛季 20xx」点一下才写入'
            + '（年份只认本节点开赛时间；赛季取标识 > 名字 > 父容器；鼠标停在按钮上能看到依据）。'
            + '两个字段各推各的，没有依据的字段一律不猜。';
        box.appendChild(tip);
    }
    box.appendChild(intro);
    // ★ **回代 baseline 的导出入口**：把"人定过的那些 nature"（依据是 `manual:set`，级别 `M`）
    //   导成一份小文件；
    //   放到 `acm-data/nature-assignments.json` 后，爬虫下次产包会**先读它做 baseline**
    //   （`scripts/nature-baseline.py`），把人的结论原样带回包里 —— 规则重跑也改不动它。
    //   ⚠️ 只导人定过的：别的值都是规则的产物，脚本重跑一遍就能复现（§10.5 的 ③ 就是"增量"）。
    box.appendChild(natureBaselineExportRow());
    // 填完 / 数据变了之后，把已经补全的条目从勾选集合里剔掉
    //（它们的行会消失，留着这个 id 只会让"已选 N 条"数出看不见的东西）。
    const pendingIds = new Set(items.map(it => it.id));
    for (const id of [...pendingState.selected]) {
        if (!pendingIds.has(id)) pendingState.selected.delete(id);
    }

    // 开关打开时，**在待补那一摞之后**再画一摞 —— 可以同时按筛选看到 nature 已填满的节点
    // （不混排：未填满的放完才轮到已填满）。
    const showFilled = !!pendingState.showFilled && filledAll.length > 0;

    if (!items.length) {
        const empty = mk('div', 'dedup-pending-empty', 'font-size:12px;color:#94a3b8;line-height:1.8;');
        // 门槛是**比赛（C）必须有分类**（其余类型只在"分类已标"时才管）⇒ 空状态就这一句：
        empty.textContent = '没有待补的：比赛都有分类，且标了分类的节点年份 / 地区都填齐了。';
        box.appendChild(empty);
        // ⚠️ **这里一个字都不许提前 return**：待补 0 条时，下面那个「同时显示已填满的节点」开关是**唯一**能进到
        //    "已填满"那上千条、进而点开编辑弹窗的入口 —— 提前返回 = 开关永远画不出来 ⇒
        //    用户永远打不开它（"数据都填满了"和"我改不了"是两件事）。
    }

    // ---- 筛选谓词（**待补与已填满用同一套**：要能"按筛选"看已填满的）----
    const passClass = it => {
        if (!pendingState.cls.length) return true;
        // 维度内"或"（选中多个分类 = 看这几支的并集）；哨兵与真值同列
        return pendingState.cls.some(w => {
            if (w === NO_CLASS) return !it.cls;
            // 「（分类不完全）」= 有值但**没到 Trie 的叶子**（与 ③ 的"缺分类"同一套口径）
            if (w === PARTIAL_CLASS) return !!it.cls && !isCompleteClassPath(it.cls);
            return classMatches(it.cls, w);
        });
    };
    // 「（有标）」= 这一维**非空**（`无` / `待同步` / `不确定` 也算有标 —— 它们都是"处理过了"）
    const passValue = (raw, wants) => {
        if (!wants.length) return true;
        return wants.some(w => (w === HAS_VALUE ? !!raw : (raw || NO_VALUE) === w));
    };
    const passFilters = it => {
        if (!passValue(it.year, pendingState.filterYear)) return false;
        if (!passValue(it.season, pendingState.filterSeason)) return false;
        if (!passValue(it.region, pendingState.filterRegion)) return false;
        // 「≤ X」= 该级**及更弱**（A 最硬 ⇒ 门槛 A 只收 A）。
        // ⚠️ `it.level` 为空（老数据、没有依据那一列）⇒ **任何"≤ X"都不收**，理由见筛选栏那一段。
        // ⚠️ `M`（人工）是**单选**那一档：它比 A 还硬，"≥/≤"那套不适用 —— 选它就只看人填的。
        if (pendingState.classLevel === MANUAL_LEVEL) return it.level === MANUAL_LEVEL;
        if (pendingState.classLevel) {
            if (!it.level) return false;
            if (levelRank(it.level) < levelRank(pendingState.classLevel)) return false;
        }
        return true;
    };
    const pick = list => list.filter(it => passClass(it) && passFilters(it));

    /**
     * 画一摞（分组 → 铺平 → 分页 → 组头 + 行）。
     *
     * ⚠️ 分页分的是**条目**（不是分组）：组头跨页时标「（续）」——"一页最多 25 行"这条硬约束
     *    才守得住。组头里的条数**始终是该组的总数**（不是本页的）。
     */
    const drawList = (list, pageKey, note) => {
        const listGroups = groupNaturePending(list);
        // **按组顺序铺平**再分页：组头因此真的只出现一次（树序 + 就地插组头是错的）
        const ordered = listGroups.reduce((acc, g) => acc.concat(g.items), []);
        box.appendChild(pager(ordered.length, pageState[pageKey], pageKey, redraw));
        const pageItems = slice(ordered, pageKey);
        const startIndex = (pageState[pageKey] - 1) * PAGE_SIZE;
        const indexOfId = new Map(ordered.map((it, i) => [it.id, i]));

        let currentKey = '';
        for (const item of pageItems) {
            const key = `${item.filled ? 'F' : 'P'}\u0000${item.cls}\u0000${item.season}`;
            if (key !== currentKey) {
                const g = listGroups.find(x => x.main === item.cls && x.season === item.season);
                const continued = !!g && (indexOfId.get(g.items[0].id) || 0) < startIndex;
                const head = mk('div', 'dedup-pending-group',
                    'font-weight:600;font-size:12px;color:#334155;margin:6px 0 2px;');
                head.textContent = `${g ? (g.mainLabel || g.main) : (item.cls || NATURE_NO_MAIN_LABEL)}`
                    + ` · ${seasonGroupLabel(item.season)}`
                    + `${note(g)}${continued ? '（续）' : ''}`;
                box.appendChild(head);
                currentKey = key;
            }
            box.appendChild(pendingRow(item, redraw));
        }
        return ordered;
    };

    if (items.length) {
        // ---- 分类 chip 行（按**第一段**分族）----
        // 真实数据里这一块上千条、横跨好几个平台/赛系 ⇒ 没有入口就只能一页页翻。chip 上的数字
        // 是**这一支的待补总数**（不是本页的），选了就把列表 + 填充条 + 分页一起缩到那一支。
        //
        // ⚠️ 候选来源必须与筛选行**同一份**（开了"同时显示已填满"就是两摞的并集）：
        //    只用待补那一摞的话，"只存在于已填满那摞里的分类"（例如 `qoj/无归类`）虽然在下拉里
        //    有选项，但下面那个守卫看着"没有这一族"就把选择打回「全部」—— 用户看到的就是
        //    **"有选项、点不动"**（实测反馈）。
        const rootSource = showFilled ? items.concat(filledAll) : items;
        const roots = [];
        let noClsCount = 0;
        for (const it of items) {
            if (!classRootOf(it.cls)) noClsCount++;
        }
        for (const it of rootSource) {
            const root = classRootOf(it.cls);
            if (!root) continue;
            const hit = roots.find(r => r.root === root);
            const add = it.filled ? 0 : 1;          // chip 上的数字**只数待补**
            if (hit) hit.count += add;
            else roots.push({ root, count: add });
        }
        // 多选：回收"已经选不到"的那些值（真值要真有一支匹配得上；两个分类哨兵永远有效）
        const alive = pendingState.cls.filter(v => v === NO_CLASS || v === PARTIAL_CLASS
            || roots.some(r => classMatches(r.root, v) || classMatches(v, r.root)));
        if (alive.length !== pendingState.cls.length) pendingState.cls = alive;
        box.appendChild(pendingMainBar(roots, items.length, noClsCount, redraw));

        // ---- 分类 / 年份 / 地区**筛选**（筛选必须真的生效）----
        // ⚠️ 填充条那一行是**要写入的值**，不是筛选器（"不改动"就什么都不写）——
        //    两者挨着确实容易看错，所以筛选单开一行、并且真能缩列表。
        const filtered = pick(items);
        // ⚠️ 筛选行的**候选一律取自"全部待补项"**（不是当前筛后的子集）：
        //    否则一旦缩到某一支/某一年，下拉里就只剩当前那一项，**再也换不回去**（实测踩到）。
        // ⚠️ 开了「同时显示已填满」时，候选取**两摞的并集**：否则"只存在于已填满那摞里的分类"
        //    根本选不到（`selectControl` 的 value 不在 options 里就等于没选），
        //    而"我这一族填成什么样了"恰恰要看那些分类。
        box.appendChild(pendingFilterBar(items.concat(showFilled ? filledAll : []), items,
            filtered.length, redraw));
        box.appendChild(filledToggle(filledAll.length, redraw));

        const ordered = groupNaturePending(filtered).reduce((acc, g) => acc.concat(g.items), []);
        box.appendChild(pendingFillBar(ordered, redraw));
        drawList(filtered, 'pending', g => `（待补 ${g ? g.items.length : 1} 条）`);
    } else {
        // 一条待补都没有：**开关照画**（它是唯一入口，见上面那段）——开了之后**筛选行也要在**，
        // 否则"已填满"那上千条没法按分类 / 年份 / 赛季 / 地区缩，等于换个地方又找不着。
        box.appendChild(filledToggle(filledAll.length, redraw));
        if (showFilled) {
            box.appendChild(pendingFilterBar(filledAll, filledAll, pick(filledAll).length, redraw));
        }
    }

    if (!showFilled) return box;

    // ---- 已填满那一摞（**在待补之后**；条数单独写，不进 tab / 标题的计数）----
    const filledFiltered = pick(filledAll);
    const head = mk('div', 'dedup-filled-title',
        'font-weight:600;font-size:13px;color:#15803d;margin:14px 0 6px;'
        + 'border-top:1px solid #dcfce7;padding-top:10px;');
    head.textContent = `✅ 已填满的节点：${filledFiltered.length} / ${filledAll.length} 条`
        + `（筛选后 / 全部；不计入上面 ${items.length} 条待补）`;
    box.appendChild(head);
    if (!filledFiltered.length) {
        box.appendChild(hint('当前筛选下没有已填满的节点。'));
        return box;
    }
    drawList(filledFiltered, 'pendingFilled', g => `（已填满 ${g ? g.items.length : 1} 条）`);
    return box;
}

/**
 * 「同时显示已填满的节点」开关（③ 的筛选行下面那一个）。
 *
 * 为什么做成开关而不是总是画着：已填满的有**上千条**（待补才几百），总是画着会把这一块
 * 变成一堵墙；而它回答的是另一个问题 —— "这一族的性质我填成什么样了"。
 */

function filledToggle(total, redraw) {
    // 观感：复选框与文字一起套一层**圆角框 + 淡绿底**，免得看漏
    //（只留一行灰字时，人在 ③ 里找了半天）。`inline-flex` = 框只包住内容，不占满整行。
    const row = mk('label', 'dedup-pending-showfilled',
        'display:inline-flex;align-items:center;gap:6px;font-size:12px;color:#166534;'
        + 'border:1px solid #bbf7d0;background:#f0fdf4;border-radius:8px;'
        + 'padding:4px 10px;margin:0 0 8px;cursor:pointer;');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'dedup-pending-showfilled-check';
    cb.checked = !!pendingState.showFilled;
    cb.addEventListener('change', () => {
        pendingState.showFilled = cb.checked;
        pageState.pending = 1;
        pageState.pendingFilled = 1;
        redraw();
    });
    row.appendChild(cb);
    const text = mk('span', '', '');
    text.textContent = `同时显示已填满的节点（${total} 条；不计入上面的条数）`;
    row.appendChild(text);
    return row;
}

/**
 * 组头里那个值怎么念：**赛季**。
 *
 * ③ 这一栏按 **赛季** 分组（口径在 `core/dedup.js` 的 `groupNaturePending`）——
 * 因为**分组键（`planKeyOf`）用的就是赛季**，这样看到的切片才和"判重里怎么分组"对得上。
 * 用户 2026-10-07："把 `.2023` 改为 `.2023赛季` 即可"。
 *
 * 真年份念成 `2023赛季`；占位值（`待同步` / `不确定` / `无`）**原样念** ——
 * 它们本来就不像年份，不会再跟"哪一年"混起来；空 ⇒ `赛季未知`。
 */
function seasonGroupLabel(season) {
    const v = String(season === undefined || season === null ? '' : season).trim();
    if (!v) return '赛季未知';
    return isRealYear(v) ? `${v}赛季` : v;
}

/** ④ 概览（页尾小结；没有编号，避免与上面①②③抢位） */
