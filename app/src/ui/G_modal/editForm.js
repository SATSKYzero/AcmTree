// ================================================================
// 编辑字段与提交规则（ui/G_modal/editForm.js）
//
// **唯一一处**：编辑弹窗（G4_edit.js）与节点信息大界面的「✏️ 编辑」页
// （ui/nodeinfo/nodeEdit.js）都用这里 —— 字段清单、校验、冲突确认、写库。
// 目的就一条：**不要第二套编辑模型**。
//
// 写入一律走 ops（`updateP/updateR/updateWS`）：
//   · 只读守卫与手改闸门在 ops 里（`assertManualEditAllowed`）；
//   · 手改留痕（`recordManualValue` / `setDerivedOverride`）也在 ops 里，
//     账户取自 `draft.currentAccountId`（= 当前账户），这里不写死；
//   · `manualFields` 只说"这个界面里哪些字段**可能**是手改"，
//     真正记不记由 `manualInput.js` 的"用户敲过字"证据 + "值确实变了"决定。
//
// 依赖：shell/state.js, shell/executor.js, core/ops/node.js, core/autoCompute.js,
//       core/validate/conflict.js, core/pluginRegistry.js, view/scope.js,
//       utils/A_helpers.js, A_constants.js, core/model/status.js,
//       core/ops/_helpers.js, G2_common.js（确认框）, manualInput.js,
//       sourcePanel.js
// ================================================================
import { AppState } from '../../shell/state.js';
import { execute } from '../../shell/executor.js';
import { updateR, updateP, updateWS, OBJECTIVE_PROMOTABLE_FIELDS } from '../../core/ops/node.js';
import { viewValue, viewDerived } from '../../view/scope.js';
import { makeParentResolver } from '../../core/fieldRegistry.js';
import { fullAutoUpdate, autoUpdateChain } from '../../core/autoCompute.js';
import { collectPNodeConflicts } from '../../core/validate/conflict.js';
import { getNodeEditorExtensions } from '../../core/pluginRegistry.js';
import { normalizeTime, escapeHtml } from '../../utils/A_helpers.js';
import { STATUS_OPTIONS, STATUS2_FIELD_INFO, STATUS2_MAX } from '../../A_constants.js';
import { SUBMIT_KINDS } from '../../core/model/status.js';
import { ensureUniqueName } from '../../core/ops/_helpers.js';
import { CLASS_PATHS, isCompleteClassPath, natureInputSuggestions } from '../../core/natureFields.js';
// 编辑面板**分两套**（原料 / 合成）的唯一判据 —— 合成 = `isSynthesis(node)`
//（**不自己判 `synthKey` 非空**：那是把同一条口径抄第二遍）。改合成标识的写入口
// 是 `assignSynthKey`（同一个事务里把所有成员指针一起改写），校验判据也在那边。
import {
    isSynthesis, synthKeyOf, synthMembers, assignSynthKey, SYNTH_KEY_FIELD,
    synthKeyProblem, synthKeyProblemText, SYNTH_PREFIX, MAX_SYNTH_KEY_LEN
} from '../../core/ops/synth.js';
import { confirmAnomalies } from './G2_common.js';
import { typedFields } from './manualInput.js';
import { buildSourcePanels } from './sourcePanel.js';

/** 每个字段该配哪条来源面板（"这个值是谁给的"）—— 三处调用同一个口径 */
function sourcePanelOpts() {
    return {
        accounts: AppState.accounts,
        viewingAccount: AppState.viewingAccountId,
        // ★ 范围口径（要不要带上**直接子账户**）也在这里传 —— `resolveScope` 从 `opts.settings` 读它。
        //   ⚠️ 少了它就会出现"树上把子账户算进去了、值级面板不认"的分叉（`v9.1.23`）。
        settings: AppState.settings,
        // 「本账户」= 我以谁的名义在操作（只有本账户的手改值才给「真删」）
        currentAccount: AppState.currentAccountId,
        // **应有 / 已有**这一行
        //   · registry  = 随包发布的「应有」注册表
        //   · shownValue = **界面上显示的那个值**（投影值）—— 「已有」必须问它，
        //                 问缓存字段 `node[field]` 会与用户看到的不一致（自查逮到）
        //   · parentOf  = 按 **extKey** 找父（`when.parentKind` 谓词用；`AppState.nodes` 是 id→节点，不能直接传）
        registry: AppState.fieldRegistry,
        shownValue: (node, field) => viewValue(AppState, node, field),
        parentOf: makeParentResolver(AppState),
        // 「转成所有人共用」只给名单里的字段（名单唯一一份在 core/ops/node.js；面板是纯字符串模块，自己 import 不了那条链）
        promoteFields: OBJECTIVE_PROMOTABLE_FIELDS
    };
}

/**
 * R 的「运行信息」只读块（导入抓来的：语言/耗时/内存/代码长度）。
 *
 * 放在编辑区最前面那几个字段下面：看提交时最常问的就是"这题我用了多久/多少内存"。
 * 它是**只读展示**，真正保证"不会被保存"的是 `updateR` 的入参只取
 * `time / status / submitKind / link`（手改候选也只有那几个）。
 */
function runInfoOf(node) {
    const val = (k) => String(viewValue(AppState, node, k) || '').trim();
    const items = [];
    if (val('language')) items.push(['语言', val('language')]);
    const ms = val('timeUsed');
    if (ms) {
        const n = Number(ms);
        items.push(['耗时', Number.isFinite(n) && n >= 1000
            ? `${ms} ms（${(n / 1000).toFixed(2)} s）` : `${ms} ms`]);
    }
    const mem = val('memoryUsed');
    if (mem) {
        const n = Number(mem);
        const kb = Number.isFinite(n) ? (n / 1024).toFixed(0) : '';
        items.push(['内存', Number.isFinite(n) && n >= 1024 * 1024
            ? `${(n / 1024 / 1024).toFixed(1)} MB（${mem} 字节）`
            : `${kb} KB（${mem} 字节）`]);
    }
    const code = val('codeLength');
    if (code) items.push(['代码长度', `${code} 字节`]);
    if (!items.length) return '';
    return `
                <div style="margin:2px 0 6px;font-size:12px;color:#475569;line-height:1.8;">
                    <div style="font-weight:600;color:#334155;">运行信息（导入时抓的，只读）</div>
                    ${items.map(([k, v]) => `<div>· ${escapeHtml(k)}：${escapeHtml(v)}</div>`).join('')}
                </div>`;
}

/** 插件扩展字段 → 控件描述（id 形如 `__ext_0__foo`，与"谁敲过字"的登记口径一致） */
function extFieldDescriptors(node) {
    const out = [];
    const exts = node ? getNodeEditorExtensions(node) : [];
    exts.forEach((ext, idx) => {
        ext.fields.forEach(f => {
            out.push({
                key: `__ext_${idx}__${f.key}`,
                label: f.label,
                type: f.type || 'text',
                default: node[f.key] ?? f.default ?? '',
                options: f.options,
                min: f.min,
                max: f.max
            });
        });
    });
    return out;
}

/** 从读回来的值里取出扩展字段（`__ext_<i>__<key>` → `{key: value}`） */
function extractExtData(res, node) {
    const data = {};
    getNodeEditorExtensions(node).forEach((ext, idx) => {
        ext.fields.forEach(f => {
            const key = `__ext_${idx}__${f.key}`;
            if (res[key] !== undefined) data[f.key] = res[key];
        });
    });
    return data;
}

/**
 * 三个「性质」（nature）字段的编辑控件 —— **分类 / 年份 / 地区**，都**可空**。
 *
 * **「分类」取代大类/小类** ——
 * 分类 = **不定层路径**（`xcpc/icpc/ec/pre`），合法性 = 注册表文件里的 Trie。
 *
 * 界面形态（**朴素到底**）：一个下拉，选项 = Trie 里**所有合法路径**（展平，
 * `分类｜xcpc / icpc / ec` 这样显示层级），加一个空选项 = 没标。
 * 为什么不做成"一级一个下拉"的级联：Trie 现在只有几十个合法路径，一个下拉就够用，
 * 而且**不需要给 `G2_common.js` 的 dependent-fields 机制加"不定层"特例**；
 * 等 Trie 长到几百个再换级联（换的时候只改这里 + `pendingFilterBar`）。
 *
 * ⚠️ 选项一律给**注册表里的原始值**（`CLASS_PATHS`），不在这里另抄一份；
 * ⚠️ 节点上已有的**旧值**（Trie 里没有的路径）必须留在选项里，否则它既看不见也清不掉
 *    （与"清空手改值"那个坑同一类）。
 */
export function natureFieldDescriptors(node) {
    const cls = viewValue(AppState, node, 'natureClass') || '';
    const known = CLASS_PATHS.map(p => p.value);
    const options = ['', ...known];
    if (cls && !known.includes(cls)) options.push(cls);
    return [
        {
            key: 'natureClass',
            label: '性质·分类（不定层路径，如 xcpc/icpc/ec/pre；留空 = 没标）',
            type: 'select',
            options,
            // 没细到叶子的路径**标一下**（分类只有在 Trie 的叶子节点时才
            // 被视为填好）—— 与判重页填充条同一套文案口径
            optionLabels: Object.fromEntries(CLASS_PATHS.map(p => [p.value,
                isCompleteClassPath(p.value) ? p.label : `${p.label}（还没到叶子）`])),
            default: cls
        },
        {
            key: 'natureYear',
            label: '性质·年份（「举办年份」 20xx；还没定下来可写「待同步」「不确定」；留空 = 不知道）',
            suggestions: natureInputSuggestions('natureYear'),
            default: viewValue(AppState, node, 'natureYear') || ''
        },
        {
            key: 'natureSeason',
            label: '性质·赛季（「赛季年份」 20xx；没有赛季概念的那些比赛（CF 正式轮次 / AtCoder）写「无」，'
                + '「cf gym 不写」；还没定下来可写「待同步」「不确定」；留空 = 不知道）',
            suggestions: natureInputSuggestions('natureSeason'),
            default: viewValue(AppState, node, 'natureSeason') || ''
        },
        {
            key: 'natureRegion',
            label: '性质·地区（自由文本；留空 = 不知道）',
            default: viewValue(AppState, node, 'natureRegion') || ''
        }
    ];
}

/** 「合成标识」控件用的是 `core/ops/synth.js` 的 `SYNTH_KEY_FIELD`（**import 来的，别自己写字面量**） */

/**
 * 合成节点的成员数 —— 用来把"改标识的后果"说清楚（"会同时改写 N 个成员指针"）。
 *
 * N 取自 `synthMembers(state, key)`（**按树序**，与判重页成员名单同一套口径）。
 * 拿不到（key 为空 / 查询异常）⇒ 返回 `null`，文案退回"所有成员"—— 宁可说粗一点，
 * 也不能报一个错数。
 */
function memberCountOf(key) {
    if (!key) return null;
    try {
        const list = synthMembers(AppState, key);
        return Array.isArray(list) ? list.length : null;
    } catch (_) {
        return null;
    }
}

/**
 * 合成节点的「合成标识」控件（**只有合成节点才有这个控件**）。
 *
 * 合成节点的编辑面板与原料节点长得一样 —— 顶上那个「所属合成节点」
 * 它填不了（写会被 `applyOwnerSynth` 拒绝），而它的身份 `synthKey` 还需要一个编辑入口。
 * 所以两套面板的分界线就一条：`isSynthesis(node)`（见 `core/ops/synth.js`）。
 *
 * ⚠️ 它**不是普通字段**：值不许塞进 `applyEdit` 的 payload（那只会改一个字段、把成员
 *    指针留在旧标识上）。提交时由 `applyEdit` 走 `assignSynthKey`（同一个事务）。
 */
function synthKeyFieldDescriptor(node) {
    const key = synthKeyOf(node);
    const n = memberCountOf(key);
    const scope = n === null ? '所有成员' : `${n} 个成员`;
    return {
        key: SYNTH_KEY_FIELD,
        label: '合成标识（就是它的身份 = 成员「所属合成节点」指针指向的那个值；可改）',
        default: key,
        hint: '<div style="margin:2px 0 6px;font-size:12px;color:#475569;line-height:1.8;">'
            + `改这个标识会在同一个事务里把 ${scope}的「所属合成节点」指针一起改掉`
            + '（不是分两步：不存在"指针指向一个已不存在的标识"的瞬间）。'
            + `不许以保留前缀 ${SYNTH_PREFIX} 开头（那是自动生成的），也不许与别的合成节点重复。`
            + '</div>'
    };
}

/**
 * 原料节点的「所属合成节点」控件（只是合成节点不画它）。
 *
 * 值是**某个合成节点的合成标识**（`synthKey`）；填了它就归属那一组。
 * 归入/解绑在判重页做（这里只是手改入口）。
 */
function ownerSynthFieldDescriptor(node) {
    return {
        key: 'ownerSynth',
        label: '所属合成节点（= 某个合成节点的合成标识 synthKey；填了它就归属那一组；归入/解绑请在判重页做）',
        default: viewValue(AppState, node, 'ownerSynth') || ''
    };
}

/** 表单里读出来的「合成标识」（trim；没有这个控件 ⇒ 空串） */
function synthKeyFromRes(res) {
    const v = res ? res.synthKey : undefined;
    return v === undefined || v === null ? '' : String(v).trim();
}

// ================================================================
// 「这次手改算谁的」开关（用户 2026-10-13 拍板，见 `docs/manual-values.md`）
//   · 默认 = `settings.manualScope`（上次的选择）；**没设过（`''`）= 第三态「按字段默认」**，
//     它 = **不表态**（`scope = undefined` ⇒ core 按字段回落，老行为一字不变）；
//   · 改选前两态 ⇒ 这一次编辑按它记（`opts.scope` 沿既有那条链到 `recordManualValue`），编辑完写回设置；
//   · ⚠️ **第三态不写进设置**（它不是第三种设置值，是"这次不表态"）。
// ================================================================
/** 开关的字段名（控件 id = `field-manualScope`；`readEditValues` 照常读它） */
const MANUAL_SCOPE_KEY = 'manualScope';
/** 三个选项：**值就是显示文案**（渲染器不认 `optionLabels`），读回来按这张表反查 */
const MANUAL_SCOPE_LABELS = Object.freeze({
    account: '只有我能看见（账户私有）',
    objective: '所有人共用（客观值）',
    // 「按字段默认」= 不表态（`settings.manualScope === ''` 时的默认）；**不属于设置的两个值**
    field: '按字段默认（推荐）'
});
/**
 * 开关的描述符：**默认显示跟着 `settings.manualScope` 走**（没设过 ⇒ 第三态）。
 *
 * ⚠️ 为什么**不**再用 `manualScopeOf(...)` 当默认：它把"没设过"直接回落成 `account`/`objective`
 *    （按字段名单），那正是"半诚实"的来源 —— 屏上写"账户私有"、core 却按字段回落记成客观。
 *    这里改成**照实显示"不表态"**，core 那条回落链一个字不动（选择只经 `opts.scope` 传）。
 * ⚠️ `applyEdit` 判"改没改"用的就是这个 `default` ⇒ 它必须与屏上所见同一份判据。
 */
function manualScopeField() {
    const set = String((AppState.settings && AppState.settings.manualScope) || '');
    return {
        key: MANUAL_SCOPE_KEY,
        label: '这次手改算谁的（不改＝按字段原本的默认：性质四格【分类/年份/赛季/地区】本来就是所有人共用）',
        type: 'select',
        options: [MANUAL_SCOPE_LABELS.account, MANUAL_SCOPE_LABELS.objective, MANUAL_SCOPE_LABELS.field],
        default: set ? MANUAL_SCOPE_LABELS[set] : MANUAL_SCOPE_LABELS.field
    };
}

/**
 * 该类型的字段清单（含每个字段的来源面板 `hint`）；`R` 还带"运行信息"只读块 */
export function buildEditForm(node) {
    const type = node ? node.type : '';
    const extFields = extFieldDescriptors(node);
    const exts = node ? getNodeEditorExtensions(node) : [];

    if (type === 'R') {
        const fields = [
            { key: 'time', label: '提交时间', type: 'text', default: node.time },
            { key: 'status', label: '评测结果', type: 'select', options: STATUS_OPTIONS, default: node.status },
            // 空选项 = 判不出来（真正落库的合法值只有 赛时 / VP / 补题，见 core/model/status.js）
            {
                key: 'submitKind',
                label: '提交性质（留空 = 判不出；可填 赛时 / VP / 补题）',
                type: 'select',
                options: ['', ...SUBMIT_KINDS],
                default: node.submitKind || ''
            },
            { key: 'link', label: '链接', type: 'text', default: node.link }
        ];
        // 合成节点（合成只在 C / P / R 上做）也要能改自己的身份 —— 它有
        // 「合成标识」控件，而**没有**「所属合成节点」（那是原料节点的指针）。
        if (isSynthesis(node)) fields.push(synthKeyFieldDescriptor(node));
        // 四个「性质」字段接在同一套控件里（可空；空选项 = 没填）
        // ⚠️ **组头（合成节点）不给这四格**：它是**派生量**（按成员算），人改了也会被
        //    下一次成员变化 / 重新导入 / 一键对齐按成员重算走 —— 给一个"改了不算数"的
        //    输入框比不给更糟（实测：手填落在组头上的那两条，最后成了"手填成了孤儿"）。
        //    要改这一组的口径 ⇒ 改**成员**那一格（下面那句说明里写了）。
        if (!isSynthesis(node)) fields.push(...natureFieldDescriptors(node));
        const panels = buildSourcePanels(node, fields, AppState.trust, sourcePanelOpts());
        for (const f of fields) if (f.key !== SYNTH_KEY_FIELD && panels[f.key]) f.hint = panels[f.key];
        // ★ **组头没有性质输入框**这件事要在编辑处说清（否则人以为"这一格不见了"）。
        //   ⚠️ 放在来源面板那个循环**之后**：否则 `hint` 会被来源面板覆盖掉。
        if (isSynthesis(node) && fields.length) {
            const note = '（这是「组头」：它的分类/年份/赛季/地区「按成员派生」 —— '
                + '所以这里不给输入框；要改这一组的口径，请改「成员」那一格）';
            fields[0].hint = note + (fields[0].hint || '');
        }
        const runInfo = runInfoOf(node);
        // 运行信息接在**第一个字段**的来源面板之后（必须在上面那个循环之后，
        // 否则会被来源面板覆盖掉）
        if (runInfo && fields.length) fields[0].hint = (fields[0].hint || '') + runInfo;
        // 「这次手改算谁的」开关（排最后：它管的是整张表单这一次的编辑）
        fields.push(manualScopeField());
        return { type, fields, exts, extFields };
    }

    if (type === 'P') {
        // ⚠️ **编辑表单的默认值永远读"自己那份"**（`viewDerived`），**绝不**换成显示用的
        //    `viewDerivedDisplay`：合并显示给的是"整组那份"，一旦填进表单、人一保存，
        //    就会把**别的成员的结论写进这个节点自己那份**（数据被悄悄改写）。
        //    显示侧该读哪一列，见 `view/scope.js` 的「合并显示」那一段。
        const fields = [
            { key: 'name', label: '名称', default: viewValue(AppState, node, 'name') },
            { key: 'status1', label: '状态1 (0未处理/1已处理)', type: 'select', options: ['0', '1'], default: String(viewDerived(AppState, node, 'status1')) },
            {
                // ⚠️ 文案与取值**都从 `STATUS2_FIELD_INFO` 来**（唯一一份词表）：手写
                //    整串档位文案 + 手写取值列表会与词表跑偏，加一档还会出现
                //    "标签加了、下拉里选不到"。
                key: 'status2',
                ...STATUS2_FIELD_INFO,
                default: String(viewDerived(AppState, node, 'status2')), type: 'select'
            },
            { key: 'problemId', label: '题号', default: viewValue(AppState, node, 'problemId') || '' },
            { key: 'cfDifficulty', label: 'CF难度', default: String(viewValue(AppState, node, 'cfDifficulty') || 0) },
            { key: 'link', label: '链接', default: viewValue(AppState, node, 'link') || '' },
            { key: 'ratio', label: '过题比例 (百分比，如 10.85 或 10.85%)', default: viewValue(AppState, node, 'ratio') || '' },
            // 判重：**编辑面板分两套** ——
            //   · 原料节点：画「所属合成节点」指针（现状不变）；
            //   · 合成节点：画「合成标识」（它自己填不了指针：写会被 `applyOwnerSynth` 拒绝）。
            // 判据只有一条 `isSynthesis(node)`，不在这里另判 `synthKey` 非空。
            isSynthesis(node)
                ? synthKeyFieldDescriptor(node)
                : ownerSynthFieldDescriptor(node)
        ];
        // 四个「性质」字段接在同一套控件里（可空；空选项 = 没填）
        fields.push(...natureFieldDescriptors(node));
        const panels = buildSourcePanels(node, fields, AppState.trust, sourcePanelOpts());
        for (const f of fields) if (f.key !== SYNTH_KEY_FIELD && panels[f.key]) f.hint = panels[f.key];
        fields.push(manualScopeField());
        return { type, fields, exts, extFields };
    }

    if (['W', 'S', 'C'].includes(type)) {
        const fields = [
            { key: 'name', label: '名称', default: viewValue(AppState, node, 'name') },
            // C 的 `link` 装**全部**链接（补题/榜单/仓库/其它），类别在来源面板里逐条标出；
            // 这里只是「我指定用哪一条」。
            {
                key: 'link',
                label: type === 'C' ? '链接（补题/榜单/仓库…；全部候选在下面的「来源」里）' : '链接',
                type: 'text',
                default: viewValue(AppState, node, 'link')
            },
            {
                key: 'statusComplete2', label: '完成状态2 (0未动/1有接触/2全部处理/3AK/4忽略)',
                type: 'select', options: ['0', '1', '2', '3', '4'], default: String(viewDerived(AppState, node, 'statusComplete2'))
            },
            // 判重：与 P 同一条口径（见上面 P 分支的注释）—— 原料画指针、合成画身份
            isSynthesis(node)
                ? synthKeyFieldDescriptor(node)
                : ownerSynthFieldDescriptor(node)
        ];
        if (type === 'C') {
            fields.push({
                key: 'contestTime',
                label: '比赛时间 (格式自定义，支持到分钟或秒)',
                type: 'text',
                default: viewValue(AppState, node, 'contestTime') || ''
            });
            // 真实比赛 / 练习容器（散题挂在练习容器下，见 docs/manual-workflow.md（散题容器））
            fields.push({
                key: 'kind',
                label: '种类（contest=真实比赛 / practice=练习容器）',
                type: 'select',
                options: ['contest', 'practice'],
                default: viewValue(AppState, node, 'kind') || 'contest'
            });
        }
        // 四个「性质」字段接在同一套控件里（可空；空选项 = 没填）
        fields.push(...natureFieldDescriptors(node));
        const panels = buildSourcePanels(node, fields, AppState.trust, sourcePanelOpts());
        for (const f of fields) if (f.key !== SYNTH_KEY_FIELD && panels[f.key]) f.hint = panels[f.key];
        fields.push(manualScopeField());
        return { type, fields, exts, extFields };
    }

    return { type, fields: [], exts, extFields };
}

/**
 * 校验（纯判断，不写库、不弹窗）。
 *
 * 弹窗与编辑页都拿它挡在写库之前：不过就**不关**（弹窗）/ **不保存**（编辑页），
 * 消息由调用方 `showToast`。
 *
 * @returns {{ok:boolean, error?:string}}
 */
export function validateEdit(id, res) {
    const node = AppState.nodes[id];
    if (!node) return { ok: false, error: '节点不存在' };
    const type = node.type;

    // 合成节点的「合成标识」是它的身份，**先**挡住不能用的值 ——
    // 挡在这里而不是只靠写库时抛，是因为调用方的顺序是"先校验、再关框"：
    // 校验不过 ⇒ 弹窗不关、用户敲的值一个字不改（与手建合成节点时同一口径，
    // 见 G4_add.js 的 commitSynth）。
    // ⚠️ 判据（空 / 太长 / 保留前缀 / 被占用）与 `core/ops/synth.js` 的
    //    `assertKeyUsable` 是同一条；那边是**写事务里**的最终防线（本函数被绕过时
    //    仍然拒绝），这里只是同一套判据的**早期**出口。
    if (isSynthesis(node)) {
        const key = synthKeyFromRes(res);
        const current = synthKeyOf(node);
        // ⚠️ 判据与文案**都不在这里** —— 与写事务里的最终防线共用
        //    `core/ops/synth.js` 的 `synthKeyProblem` / `synthKeyProblemText`（唯一一处）。
        // `auto = 标识没变`：自动分配的标识**本来就是** `synth:<n>`，原样保存必须放行；
        //    保留前缀只对"手敲一个新标识"设限。
        const code = synthKeyProblem(AppState, key, id, key === current);
        if (code) return { ok: false, error: synthKeyProblemText(code, key) };
    }

    if (type === 'P') {
        if (!String(res.name || '').trim()) return { ok: false, error: '名称不能为空' };
        const s1 = parseInt(res.status1);
        const s2 = parseInt(res.status2);
        if (isNaN(s1) || s1 < 0 || s1 > 1) return { ok: false, error: '状态1必须为0或1' };
        if (isNaN(s2) || s2 < 0 || s2 > STATUS2_MAX) {
            return { ok: false, error: `状态2必须为0-${STATUS2_MAX}` };
        }
        return { ok: true };
    }

    if (['W', 'S', 'C'].includes(type)) {
        if (!String(res.name || '').trim()) return { ok: false, error: '名称不能为空' };
        const sc = parseInt(res.statusComplete2);
        if (isNaN(sc) || sc < 0 || sc > 4) return { ok: false, error: '完成状态必须为0-4' };
        return { ok: true };
    }

    return { ok: true };      // R 无额外校验（时间在读取时就校验过了）
}

/**
 * 走 ops 落库（唯一一处）；返回 `{success, error?}`，不弹 toast（由调用方决定）。
 *
 * @param {string|null} synthKey 合成节点**新**的合成标识（没改 = `null`）。
 *        它**不进上面的 `data` 载荷**：身份的改动必须走 `assignSynthKey`
 *        （同一个事务里把所有成员指针一起改写），否则成员指针会留在旧标识上。
 *        `scope`（第 8 个参数）= 这次开关选的**归属**，`undefined` = 没改开关 ⇒ 不传。
 */
function writeNode(id, type, data, manualKeys, extData, exts, synthKey = null, scope = undefined) {
    return new Promise((resolve) => {
        // 事务里算出来的"改标识的后果"（改了才会被填），写进返回值供调用方提示用户
        let synth = null;
        const run = async () => {
            await execute(
                (draft) => {
                    const opts = { manualFields: typedFields(manualKeys) };
                    // ★ 归属跟着**这一次编辑**走（判据唯一一处是 core 的 `manualScopeOf`，它优先 `opts.scope`）
                    if (scope) opts.scope = scope;
                    // ⚠️ 改之前先记下"组归属"（`ownerSynth`）：它一变，**组划分**就变，
                    //    组头的合并值也要跟着重算 ⇒ 那种情况才需要整树（下面）。
                    const beforeNode = draft.nodes[id];
                    const beforeOwner = String((beforeNode && beforeNode.ownerSynth) || '');
                    if (type === 'P') updateP(draft, id, data, opts);
                    else if (type === 'R') updateR(draft, id, data, opts);
                    else updateWS(draft, id, data, opts);
                    for (const ext of exts) ext.apply(draft, id, extData);
                    // ★ 合成标识：同一个事务、`assignSynthKey` 一次性把所有成员的
                    //   `ownerSynth` 指针改到新标识（分两次改会出现"指针指向已不存在
                    //   的标识"的瞬间）。抛错 ⇒ 整个事务回滚（包括上面那些字段）。
                    if (synthKey !== null) {
                        const r = assignSynthKey(draft, id, synthKey);
                        synth = { from: r.from, to: r.to, moved: r.moved };
                    }
                    // ★ **重算范围**：一个节点算出来的字段只取决于"它自己 + 它的后代"，
                    //   所以普通编辑只需重算"它自己 + 祖先链"（与 `core/ops/tree.js` 的结构操作同一条）。
                    //   ⚠️ 两种例外必须**整树**（实测：真包上"链后整树重算还剩几处变化"的基线是 152，
                    //      组头那一路会偏离基线，净 −1）：
                    //     · **组划分变了**（改了合成标识 / 成员指针）—— 组头的合并值取自整组；
                    //     · **改的是组头本身**（`synthKey`）—— 它的值也要走合并那一趟。
                    //   （以前这里无条件 `fullAutoUpdate`：真包 27k 实测 **~1150~1350ms/次**，
                    //     而一条链只要 **~85ms** —— 用户实测"改一次 CF 难度 936ms"就是它。）
                    const afterNode = draft.nodes[id];
                    const afterOwner = String((afterNode && afterNode.ownerSynth) || '');
                    const isHead = !!(beforeNode && beforeNode.synthKey);
                    if (synthKey !== null || beforeOwner !== afterOwner || isHead) fullAutoUpdate(draft);
                    else autoUpdateChain(draft, id);
                },
                {
                    refreshParentId: id,
                    onSuccess: () => resolve({ success: true, synth }),
                    onError: (err) => resolve({ success: false, error: err && err.message ? err.message : String(err) })
                }
            );
        };
        run().catch(err => resolve({ success: false, error: err && err.message ? err.message : String(err) }));
    });
}

/**
 * 合成标识**变了没有**（变了才返回新标识；没变 / 不是合成节点 / 表单里没这个控件 ⇒ `null`）。
 *
 * 原料节点（没有这个控件）永远走不到这里 —— **原料那条路一字不动**。
 */
function synthKeyChangeOf(node, res) {
    if (!isSynthesis(node)) return null;
    if (!res || res.synthKey === undefined) return null;
    const next = synthKeyFromRes(res);
    return next === synthKeyOf(node) ? null : next;
}

const P_MANUAL = ['name', 'status1', 'status2', 'problemId', 'cfDifficulty', 'link', 'ratio', 'ownerSynth',
    'natureClass', 'natureYear', 'natureSeason', 'natureRegion'];
const R_MANUAL = ['time', 'status', 'submitKind', 'link',
    'natureClass', 'natureYear', 'natureSeason', 'natureRegion'];
const WS_MANUAL = ['name', 'link', 'kind', 'contestTime', 'ownerSynth',
    'natureClass', 'natureYear', 'natureSeason', 'natureRegion'];

/**
 * 编辑面板的「性质」提交载荷（分类 / 年份（举办）/ 赛季 / 地区）。
 *
 * ⚠️ **不放进载荷 = 编辑面板上的控件是假的** —— 实测踩过：控件画出来了、保存"成功"、
 * 数据一个字段都没变（`applyEdit` 的 payload 里没带它们）。所以这里必须显式带上。
 * 归一化（分类 → `a/b`、其余 trim）与 **Trie 校验**由 `core/ops/node.js` 的
 * `applyNatureFields` 统一做，这里只搬运。
 */
function naturePayload(res) {
    return {
        natureClass: res.natureClass,
        natureYear: res.natureYear,
        natureSeason: res.natureSeason,
        natureRegion: res.natureRegion
    };
}

/**
 * 提交前的**冲突确认**（要弹二级确认框的那部分）。
 *
 * 单独一步是为了让两个调用方各自保持原有的交互：
 *   · P 弹窗**先确认、再关框**（用户取消时弹窗留着）；
 *   · W/S/C 走 `showFormDialog`，框已经关了，取消就只是不写库。
 *
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
export async function confirmEditAnomalies(id, res) {
    const node = AppState.nodes[id];
    if (!node) return { ok: false, error: '节点不存在' };
    const type = node.type;

    if (type === 'P') {
        const name = String(res.name || '').trim();
        const problemId = String(res.problemId || '').trim();
        const parentId = AppState.parentOf[id] ?? null;
        if (!parentId) return { ok: true };
        const anomalies = [];
        if (name !== node.name) {
            anomalies.push(...collectPNodeConflicts(AppState, parentId, name, null, id));
        }
        if (problemId !== node.problemId) {
            anomalies.push(...collectPNodeConflicts(AppState, parentId, null, problemId, id));
        }
        if (anomalies.length > 0 && !(await confirmAnomalies(anomalies))) {
            return { ok: false, error: '用户取消' };
        }
        return { ok: true };
    }

    if (['W', 'S', 'C'].includes(type)) {
        const name = String(res.name || '').trim();
        const parentId = AppState.parentOf[id] ?? null;
        if (!parentId || name === node.name) return { ok: true };
        const existingNames = new Set();
        for (const cid of AppState.childOrder[parentId]) {
            const c = AppState.nodes[cid];
            if (c && c.id !== id && c.name) existingNames.add(c.name);
        }
        if (existingNames.has(name) && !(await confirmAnomalies([
            `名称 "${name}" 已存在于同父节点下，将自动重命名`
        ]))) {
            return { ok: false, error: '用户取消' };
        }
        return { ok: true };
    }

    return { ok: true };
}

/**
 * 编辑走完之后**记住这次的选择**（`settings.manualScope` = 下次的默认；只进本地缓存、不进撤销栈）。
 * ⚠️ 顺序要紧：**必须在节点写完之后** —— 这一次编辑的归属由传下去的 `opts.scope` 决定（它压过设置）；
 * 反过来"先改设置、再让 core 读设置"会让 `opts.scope` 变成可删的（删了看不出差别），也就没人守得住它。
 *
 * @param {*} result 原样返回（`applyEdit` 的返回值，方便链式 `return rememberScope(await writeNode(...))`）
 * @param {null|''|'objective'|'account'} remember `null` = 这次**没动开关**（一个字都不写）；
 *        `''` = 明确选了第三态「按字段默认」⇒ **清掉**设置；其余 = 写进去
 */
async function rememberScope(result, remember) {
    if (remember === null || remember === undefined) return result;
    await execute(draft => { draft.settings.manualScope = remember; },
        { skipHistory: true, validate: false });
    return result;
}

/**
 * 写库（唯一一处）。**假定冲突已经确认过**（见 `confirmEditAnomalies`）。
 *
 * @returns {Promise<{success:boolean, error?:string, synth?:{from:string,to:string,moved:number}}>}
 *          `synth` 只在**合成标识真的改了**时出现（`moved` = 同一个事务里一起改写
 *          的成员指针数）—— 调用方据此把"后果"告诉用户。
 */
export async function applyEdit(id, res) {
    const node = AppState.nodes[id];
    if (!node) return { success: false, error: '节点不存在' };
    const type = node.type;
    if (!['R', 'P', 'W', 'S', 'C'].includes(type)) return { success: false, error: '不支持的节点类型' };

    const exts = getNodeEditorExtensions(node);
    const extData = extractExtData(res, node);
    // 合成节点**新**的合成标识（没改 = null）。它不是普通字段：见 `writeNode`。
    const synthKey = synthKeyChangeOf(node, res);

    // ★ 开关（见上）：**没改 / 选了第三态「按字段默认」** ⇒ `undefined`（core 按字段回落）；
    //   选了前两态 ⇒ 作为这一次编辑的归属传下去，写完再记进设置（记的是 `'objective'` / `'account'`）。
    //   ★ **第三态要"记成空"**（`v9.1.20`，补残余）：它是"按字段默认"这一个**明确的选择**，
    //     选完不清设置的话，下次表单的默认又变回旧值 —— 选了个寂寞（用户会以为没生效）。
    //   ⚠️ `null` 与 `''` **必须分开**：`null` = "这次没动开关"（**别清**），
    //      `''` = "明确选了按字段默认"（**清掉**）。合成一个值就必然错一边。
    const askedScope = res ? res[MANUAL_SCOPE_KEY] : undefined;
    const scopeDefault = (buildEditForm(node).fields.find(f => f.key === MANUAL_SCOPE_KEY) || {}).default;
    // 用户**这次真的改过**开关吗？（没改 ⇒ 与默认逐字相同 ⇒ 设置一个字都不许动）
    const scopeTouched = askedScope !== undefined && askedScope !== scopeDefault;
    // 这一次编辑的归属（第三态 = `undefined` ⇒ core 按字段回落）
    const scope = !scopeTouched ? undefined
        : (askedScope === MANUAL_SCOPE_LABELS.objective ? 'objective'
            : askedScope === MANUAL_SCOPE_LABELS.account ? 'account' : undefined);
    // 记进设置（= 下次表单的默认）：**改过才记**；第三态记 `''`
    const remember = !scopeTouched ? null
        : (askedScope === MANUAL_SCOPE_LABELS.field ? '' : scope);

    if (type === 'R') {
        return rememberScope(await writeNode(id, 'R', {
            time: res.time,
            status: res.status,
            submitKind: res.submitKind,
            link: res.link,
            ...naturePayload(res)
        }, R_MANUAL, extData, exts, synthKey, scope), remember);
    }

    if (type === 'P') {
        const name = String(res.name).trim();
        return rememberScope(await writeNode(id, 'P', {
            name,
            status1: parseInt(res.status1),
            status2: parseInt(res.status2),
            problemId: String(res.problemId || '').trim(),
            cfDifficulty: parseInt(res.cfDifficulty) || 0,
            link: res.link || '',
            ratio: res.ratio || '',
            // 合成节点没有这个控件（它填不了指针）：不传 ⇒ `updateP` 连碰都不碰它
            ownerSynth: isSynthesis(node) ? undefined : String(res.ownerSynth || '').trim(),
            ...naturePayload(res)
        }, P_MANUAL, extData, exts, synthKey, scope), remember);
    }

    // W / S / C
    const name = String(res.name).trim();
    const sc = parseInt(res.statusComplete2);
    let contestTime;
    if (type === 'C' && res.contestTime !== undefined) {
        const timeResult = normalizeTime(String(res.contestTime).trim());
        if (!timeResult.valid) return { success: false, error: timeResult.reason || '比赛时间格式无效' };
        contestTime = timeResult.isEmpty ? '' : timeResult.value;
    }

    // 同名再确认一次"要不要自动重命名"（确认框在 `confirmEditAnomalies` 里弹过）
    let finalName = name;
    const parentId = AppState.parentOf[id] ?? null;
    if (parentId && name !== node.name) {
        const existingNames = new Set();
        for (const cid of AppState.childOrder[parentId]) {
            const c = AppState.nodes[cid];
            if (c && c.id !== id && c.name) existingNames.add(c.name);
        }
        if (existingNames.has(name)) finalName = ensureUniqueName(AppState, parentId, name);
    }

    return rememberScope(await writeNode(id, 'W', {
        name: finalName,
        link: res.link,
        statusComplete2: sc,
        // C 的种类（练习容器 = 散题挂它下面）
        kind: (type === 'C' && res.kind !== undefined) ? res.kind : undefined,
        contestTime,
        // 同上：合成节点不写指针（它没有这个控件）
        ownerSynth: isSynthesis(node) ? undefined : res.ownerSynth,
        ...naturePayload(res)
    }, WS_MANUAL, extData, exts, synthKey, scope), remember);
}
