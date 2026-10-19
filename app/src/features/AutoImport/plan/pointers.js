// ================================================================
// 成员指针的**规划**（features/AutoImport/plan/pointers.js）
//
// 阶段 2（`ownerSynth` 指针）的四条口径 —— 值相同不动 / 包不得覆盖已有非空指针 / 目标必须存在 / 不许写节点 id。
// ================================================================
import { OWNER_FIELD, normalizeSynthKey, synthKeyOf, synthIndex } from '../../../core/ops/synth.js';
import { PROBLEM_SYNTH_PREFIX } from '../../../core/synthPlan.js';
// 包里那条「这个绑定凭什么」（`分类依据.ownerSynth`，手绑的是 `manual:set`）—— **如实搬运**
import { classRulesOf, isHumanBoundOwner } from '../../../core/natureConfidence.js';
import { POLICY } from '../constants.js';
import { resolvePolicy } from '../merge.js';

export function planPointers({ prepped, state, index, policies, synthTypes, knownSynthKeys, warnings,
    pkgEmptyPGroups = null }) {
    // ★ 树上现有的合成标识集合（判"旧值是不是**死指针**"用）。
    //   为什么需要：**组标识会因为信息补全而改名**（`synth:xcpc:年份未知provincial-山东`
    //   → `synth:xcpc:2019provincial-山东`），于是树上那些旧值指着一个**已经不存在的组**。
    //   never 口径的本意是保护**有意义的**人工绑定，不是保一个死指针 ⇒ 悬空的旧值允许被包改写。
    //   （判据与读路径同一份：`core/ops/synth.js` 的 `synthIndex`；一次全表扫描，循环外算。）
    const treeSynthKeys = new Set(synthIndex(state || {}).byKey.keys());
    const out = [];
    for (const it of prepped) {
        if (it.error) continue;
        if (!it.ownerSynth || !it.extKey) continue;   // 指针只长在原料节点（有 extKey）上

        const rec = it.rec;
        const existingId = index ? index[it.extKey] : undefined;
        const existing = existingId && state && state.nodes ? state.nodes[existingId] : null;
        const current = normalizeSynthKey(existing && existing[OWNER_FIELD]);
        const nodeExists = !!existing;

        const base = {
            index: rec.index,
            extKey: it.extKey,
            nodeId: existing ? existing.id : null,
            synthKey: it.ownerSynth,
            current,
            // ★ 包里给这条绑定写的**依据**（`分类依据.ownerSynth`）：人手绑的是 `manual:set`。
            //   **必须原样带到落地那一步** —— 不然"人的结论"在应用里降级成脚本值，
            //   下次「📤 导出人工填写」就把它当非人工丢掉（实测：导出比对报"少了 1 个节点"）。
            //   脚本产的指针**本来就没有这一列** ⇒ 空串 ⇒ 不会误标成人工。
            rule: String((classRulesOf(rec.raw) || {})[OWNER_FIELD] || '').trim()
        };

        if (current === it.ownerSynth) {
            out.push({ ...base, action: 'same' });      // 值相同：不动
            continue;
        }

        const policy = resolvePolicy(OWNER_FIELD, nodeExists, policies);
        let action = 'set';
        let reason = '';
        // ★ 树上旧值是**死指针**（指着一个已经不存在的组）⇒ 允许改写（理由见函数开头）。
        const danglingOld = !!(nodeExists && current !== '' && !treeSynthKeys.has(current));
        // ★★ **"题号被改正 ⇒ 换组"也要算悬空的那一类**（本轮新增）。
        //   来由（实测 `2021 四川省赛`）：`problemId` 被按"这一场的规范题号"改正之后
        //   （QOJ 的 Ants 从 `C` 改到 `J`），这道题所属的**题目组合头键**跟着换了
        //   （`synth:problem:…-四川-C` → `…-四川-J`）。可**旧组头还在树上**，于是
        //   `danglingOld` 判不出来（那个键没消失）⇒ 导入把这些成员指针**当"人绑过的"拒收**，
        //   预览里就是那两条「树上已有成员指针 …，按 never 口径不覆盖」（实测）。
        //   判据：旧值与包里要写的**是同一场之外、同一场的另一个题号** ——
        //   题目组键的形状是 `synth:problem:<场次标识>-<题号>`，把末尾那段摘掉就是"哪一场"。
        //   ⚠️ 为什么敢覆盖"树上还存在的旧头"：组头与成员指针都是**本步建的脚本值**
        //      （`分类依据.ownerSynth` 没有 `manual:set` 那种人工痕迹时才会走到这里）；
        //      而"把一场的题号改正"是**这一场的规范结论**，跟着包走才对。
        const pGroupOf = (k) => (String(k).startsWith(PROBLEM_SYNTH_PREFIX) ? String(k) : '');
        const sameContestGroup = !!(pGroupOf(current) && pGroupOf(it.ownerSynth)
            && pGroupOf(current).slice(0, pGroupOf(current).lastIndexOf('-'))
                === pGroupOf(it.ownerSynth).slice(0, pGroupOf(it.ownerSynth).lastIndexOf('-')));
        // ★★ **不要拿"人绑"那个标记来挡这一档**（实测：它把同一场换键整批挡回去、点都点不动）。
        //   理由：题目组的键（`synth:problem:…`）是**脚本产物**，不可能有"人的结论"——
        //   树上那条 `分类依据.ownerSynth = manual:set` 多半是**应用侧动作写上去的**
        //   （`applyOwnerSynth` 一律打这个标记），它不代表"人挑了这个键"。
        //   真正该问的是：**包里那个旧组还有没有成员**——
        //     · 包里那个旧键**已经空了**（上一版把它拆掉了，比如 `…-C` 只剩 rankland 那两条、
        //       QOJ 那几条已被移到 `…-D`）⇒ 树上指着它的指针是**上一版的残留** ⇒ 让它跟包走；
        //     · 包里那个旧键**仍有成员**（它是这一场另一个正常的题目组）⇒ 不碰（保守）。
        //: **包里这一档旧组是不是"空组"**（包里已没有任何成员指着它）—— 是空组 ⇒ 树上指着它的
        //: 那条是**上一版的残留**，让它跟包走；不是空组（这一场另一个正常题目组）⇒ 保守不碰。
        const oldGroupEmptyInPkg = !!(pkgEmptyPGroups && pkgEmptyPGroups.has(current));
        const renamedOld = !!(nodeExists && current !== '' && !danglingOld && sameContestGroup
            && knownSynthKeys.has(it.ownerSynth)
            && (oldGroupEmptyInPkg || !isHumanBoundOwner(existing)));
        if (policy === POLICY.NEVER) {
            action = 'reject';
            reason = '策略 never：本次不写入';
        } else if (nodeExists && current !== '' && !danglingOld && !renamedOld) {
            action = 'reject';
            reason = `树上已有成员指针「${current}」，按 never 口径不覆盖`
                + `（包里想改成「${it.ownerSynth}」）—— 见 docs/auto-import.md（悬空指针的表现）`;
        } else if (danglingOld) {
            reason = `树上旧值「${current}」指的组已经不存在（组标识改过名）⇒ 允许改成「${it.ownerSynth}」`;
        } else if (renamedOld) {
            reason = `这一场的题号被改正过（旧值「${current}」是改号前的题目组）`
                + `⇒ 跟着包改到「${it.ownerSynth}」`;
        }

        // ③/④ 目标必须**存在**、且必须是**合成标识**：写路径直接拒绝。
        //    与 core/ops/synth.js 的 `assertOwnerTarget` 同一套判据（那条才是权威的
        //    —— 这里只是**预览**，让用户在导入前就看见这些条目会被拒）。
        if (action === 'set' && !knownSynthKeys.has(it.ownerSynth)) {
            const asId = state && state.nodes ? state.nodes[it.ownerSynth] : null;
            const byId = !!asId && !!synthKeyOf(asId);
            action = 'reject';
            reason = byId
                ? `「所属合成节点」写的是节点 id「${it.ownerSynth}」，不是合成标识（synthKey）`
                    + ` —— 要写「${synthKeyOf(asId)}」；写入会被拒绝`
                : `悬空指针：指向的合成标识「${it.ownerSynth}」树上没有、本包里也没有`
                    + ' —— 写入会被拒绝（不落成单元素组）';
            out.push({ ...base, action, reason, dangling: true });
            continue;
        }

        out.push({ ...base, action, reason });
        if (action !== 'set') continue;

        // 同类型约束：合成关系必须同类型（`applyOwnerSynth` 手改时会拦，
        // 这里先报一条警告 —— 跨类型的组在计算时是没有意义的）
        const holderType = synthTypes.get(it.ownerSynth);
        const selfType = String(rec.type || '').trim().toUpperCase();
        if (holderType && holderType !== selfType) {
            warnings.push({
                code: 'owner-type-mismatch',
                index: rec.index,
                message: `成员指针「${it.ownerSynth}」指向的是 ${holderType} 类型合成节点，`
                    + `而本条是 ${selfType} 类型 —— 合成关系必须同类型（core/ops/synth.js）`
            });
        }
    }
    return out;
}

/** 收集未被 fieldMap 使用的列名（只记名，不记值——决策 14） */
