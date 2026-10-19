// ================================================================
// 删减（清理）环节 —— **统一声明表**（ui/dedup/pruneStages.js）
//
// 删减原来散成好几处、每处自带一段守卫与一段文案：
//   · 悬空成员指针 —— 判重页那条黄条（`synthSection.danglingRow`）；
//   · 计数不自洽的坏数据 —— 同一条黄条的后半句；
//   · 旧组头 —— ⑤ 的 ⑧（上一轮才加的）。
// "有几条、凭什么这么判、能不能安全删、删的时候做什么"这四件事**各处自己写一遍**，
// 于是同一个动作有两份实现、同一条判据有两种说法。
//
// 这个文件把四件事收成**一条声明**，两处（判重页的黄条、⑤ 的总台）**读同一条**：
//   id / title / tone / why   它是谁、在说什么、凭什么
//   items(conf, ctx)          有哪些候选（**判据仍来自各自那份真源**，这里一行判据都不写）
//   row(it, ctx)              一条长什么样
//   action                    怎么删（**没有 = 只报不动**：那种得人自己改数据）
//
// ⚠️ 三条纪律：
//   ① **判据不在这里**：悬空指针 = `core/ops/synth.js` 的 `findDanglingOwners`；
//      旧组头 = `core/synthConflicts.js` 的 ⑧（与产包脚本同一份）；不自洽 = `collectGroups`。
//   ② **动作只有一份实现**：都落在 `core/ops/**` 里，这里只做"一个事务"的壳。
//   ③ **只清指针不删数据**（除非这个环节本来就是"删那个节点"）——
//      每个环节都要在 `why` 里把这句话说出来，人才敢点。
// ================================================================
import { applyOwnerSynth, assignSynthKey, clearDanglingOwners, renameHeadKey, synthIndex, OWNER_FIELD } from '../../core/ops/synth.js';
import { deleteNode, moveNode } from '../../core/ops/tree.js';
import { cleanDeletedRealNode } from '../../core/ops/page.js';
// 「按现值算得出该归哪一组」用的就是产包脚本那一份（`core/synthPlan.js`）—— 判据只有一处
import { planKeyOf } from '../../core/synthPlan.js';
// 「成员指针是**人绑的**」这条判据只有一处（`natureConfidence.isHumanBoundOwner`）——
// 这里要用它来区分"组里还有没人绑着的成员"（那种不算"组内不一致"）
import { isHumanBoundOwner } from '../../core/natureConfidence.js';
import { AppState } from '../../shell/state.js';
import { mk } from '../../utils/dom.js';
import { nodeLabel, markGoto, runWrite } from './kit.js';
import { plain } from '../kit/report.js';

/** 悬空指针的三种成因（**唯一一份文案**） */
export const DANGLING_REASON = Object.freeze({
    missing: '指向的合成节点不存在',
    type: '类型不匹配',
    self: '指向了自己'
});

/**
 * 计数口径报出的坏数据里，**没被悬空那半句说过**的那些。
 *
 * ⚠️ 去重规则是**口径的一部分**，只能有一份：`collectGroups` 的警告里，
 *    节点 id 已经出现在悬空清单里的那条是**同一件事的两种说法**（`findDanglingOwners`
 *    按 `synthKey` 查表，写成节点 id 时查不到 ⇒ 也在悬空里）⇒ 黄条与 ⑤ 都只看剩下的。
 */
export function incoherentProblems(model) {
    const ids = new Set(((model && model.dangling) || []).map(d => d.id));
    return (((model && model.warnings) || [])).filter((w) => {
        const cut = String(w).indexOf(':');
        return cut > 0 && !ids.has(String(w).slice(0, cut));
    }).map(plain);
}

/** 一条小灰行（⑤ 里每条清理候选的公共骨架） */
function lineRow(cls, style) {
    return mk('div', cls, `font-size:12px;color:#475569;line-height:1.9;margin-left:12px;${style || ''}`);
}

/**
 * 树上有哪些合成标识 —— **一次渲染只建一遍**。
 *
 * ⚠️ 为什么必须缓存：`synthIndex(AppState)` 是**一趟全表扫描**，而调用它的是**每一行**
 *    （改到该键的按钮要查"树上有没有那个头"）。行数一多就是 O(行数 × N) ——
 *    与当初"点一下一键对齐卡死 37 秒"是**同一类**错（那次是每个组头建一次索引）。
 *    缓存按 `AppState.nodes` 的**引用**失效：每次事务都会换掉它，所以不会读到旧表。
 */
let headIndexFor = null;
let headIndex = null;
function treeHeads() {
    if (headIndexFor !== AppState.nodes) {
        headIndexFor = AppState.nodes;
        headIndex = synthIndex(AppState).byKey;
    }
    return headIndex;
}

/**
 * 「➡️ 改到该键」—— 指针过时时把成员**改指到按现值算出来的那个头**。
 *
 * 三条前提（缺一条就不给按钮，改说清为什么）：
 *   ① 按这个节点现在的 nature **算得出**键（`planKeyOf`）；
 *   ② 树上**真有**那一个头（`treeHeads()`）—— 没有就别给按钮：
 *      `applyOwnerSynth` 会当场抛"不存在"，那种情况该做的是**先定分类/补齐来源**，
 *      或者干脆解绑（`2025provincial-陕西` 这种"这场在别的来源根本没有"就是后者）；
 *   ③ 算出来的键与现在指着的不一样（一样就没必要）。
 * 三者都不满足时，这里**只写一句说明**（返回 `null`，调用方按"没有节点"处理）。
 *
 * ⚠️ 它是**唯一**一份"能不能改到该键"的判定：⑤ 的「该换键」「人绑的键过时了」
 *    与「🧹 清理悬空指针」三处**共用**（以前脚本那一档自己写了个不看守卫的按钮，
 *    目标不存在时点下去当场抛错）。
 */
export function retargetButton(node, row) {
    const got = planKeyOf(node);
    const want = got && got.key ? String(got.key) : '';
    const headId = want ? treeHeads().get(want) : '';
    if (!want) {
        row.appendChild(mk('span', '', 'color:#94a3b8;',
            '（按现在的分类/赛季/地区算不出该归哪一组 —— 先把性质补全）'));
        return null;
    }
    if (!headId) {
        row.appendChild(mk('span', '', 'color:#94a3b8;',
            `（按现值该是 ${want}，但树上没有这个组 —— 多半是分类与别的来源不一致、`
            + '或这场在别的来源没有；要么先统一分类，要么清掉这个指针）'));
        return null;
    }
    const btn = mk('button', 'btn', 'margin-left:8px;font-size:11px;padding:0 6px;');
    btn.setAttribute('title', plain(`把「所属合成节点」改成 ${want}（其余字段一个字不改；`
        + '这一步算人的结论，会记成 M 并随 baseline 回代）'));
    btn.textContent = '➡️ 改到该键';
    btn.addEventListener('click', () => {
        runWrite((draft) => {
            const n = draft.nodes[node.id];
            if (n) applyOwnerSynth(draft, n, want);
        }, `已改到 ${want}`).catch(() => {});
    });
    return btn;
}

/**
 * 「➡️ 把头改到该键」—— `retargetButton` **给不出按钮**那种情形的另一半。
 *
 * 情形：按现值算出来的键**树上没有那个头**（实测 9 条：`cc_provincial` ↔ `provincial`、
 *   `provincial` ↔ `ic_provincial`）。它为什么是**死结**（两边都不动）：
 *   · 应用侧没有按钮 ⇒ 只能干看着；
 *   · 脚本侧 `synth-bind` **人绑的键一个字不动**（它不替人拿主意）；
 *   · 于是包里那条成员指针指向一个**包里也没有的标识** ⇒ 导入时按悬空指针**直接拒收**
 *     （实测预览：「成员指针被拒 1 条 … 目标合成标识树上没有、包里也没有」）。
 * 出路只有一条：**承认按规则算出来的那个键，把这个头搬过去**（四个 nature 一个字不改 ——
 * 键本来就该由 nature 算出来，key 与 nature 打架时键才是错的那个）。
 *
 * 三条安全闸门（不满足就只写一句说明，返回 `null`）：
 *   ① 目标键上没有别的头（有 ⇒ 那是"两组该并"，得人先统一分类）；
 *   ② 现在指着的那个头**在树上**（不在 ⇒ 没有"把头搬过去"这回事，那属于悬空指针）；
 *   ③ **全组一致**：组里除这条以外、其余"不是人绑的"成员算出来也是同一个键
 *      （否则搬过去就把组拆了 —— 那种先统一分类）。
 */
export function headRenameOffer(node, row) {
    const got = planKeyOf(node);
    const want = got && got.key ? String(got.key) : '';
    if (!want) return null;
    if (treeHeads().get(want)) return null;                  // 目标头在 ⇒ `retargetButton` 那条路
    const heads = treeHeads();
    const curKey = String(node.ownerSynth || '').trim();
    if (!curKey) return null;
    const headId = heads.get(curKey);
    const head = headId ? AppState.nodes[headId] : null;
    if (!head) return null;
    // 全组一致：成员里"人绑的"不看（它们本来就停在自己的键上），其余必须**算得出同一个键** ——
    // ⚠️ 判据写成"算出来的键 === 目标键"，**不能**写成"算出来的键 ≠ 目标键才算不一致"：
    //    后者会把"算不出键"（`planKeyOf` 返回 `null`，性质还是残缺的）漏过去，
    //    于是把组搬走、把那种成员留在后面（实测：漏了一条分类只有两段的成员）。
    const others = Object.values(AppState.nodes || {}).filter((m) => m && m !== node
        && String(m.ownerSynth || '').trim() === curKey && !isHumanBoundOwner(m));
    const disagree = others.filter((m) => {
        const g = planKeyOf(m);
        return !g || !g.key || g.key !== want;
    });
    if (disagree.length) {
        row.appendChild(mk('span', '', 'color:#94a3b8;',
            `（按现值该是 ${want}，但树上没有这个组；组里另有 ${disagree.length} 条算出来是别的键 —— `
            + '先统一分类，再点。）'));
        return null;
    }
    const btn = mk('button', 'btn', 'margin-left:8px;font-size:11px;padding:0 6px;');
    btn.setAttribute('title', plain(`把这个组头自己改名为 ${want}（组里全部成员一起改指过去；`
        + '四个性质一个字不改。键本来就该由分类/赛季/地区算出来 ⇒ 打架时错的是键）'));
    btn.textContent = '➡️ 把头改到该键';
    btn.addEventListener('click', () => {
        runWrite((draft) => {
            if (draft.nodes[head.id]) renameHeadKey(draft, head.id, want);
        }, `组头已改到 ${want}`).catch(() => {});
    });
    return btn;
}

/**
 * **清理环节清单**（顺序 = 界面顺序）。
 *
 * ⚠️ 这份清单**同时**给两处用：判重页那条黄条（`synthSection`）与 ⑤ 的「🧹 可清理」总台。
 *    加一个清理环节 = 在这里加一条声明，两边一起有。
 */
export const PRUNE_STAGES = [
    // ---- ① 悬空成员指针（指针指向的合成节点不存在 / 类型不对 / 指向自己）----
    {
        id: 'dangling',
        tone: 'warn',
        items: (conf, ctx) => ((ctx && ctx.model && ctx.model.dangling) || []),
        title: (n) => `🧹 悬空成员指针 ${n} 个`
            + '（指向的合成节点不存在 / 类型不对 / 指向自己 ⇒ **只清指针，不删任何节点**）',
        row: (d) => {
            const row = lineRow('dedup-prune-dangling');
            const node = (AppState.nodes || {})[d.id];
            row.appendChild(document.createTextNode(`${nodeLabel(node) || d.id} → `));
            const key = mk('span', '', 'color:#b45309;word-break:break-all;');
            key.textContent = String(d.synthKey);
            row.appendChild(key);
            row.appendChild(document.createTextNode(`（${DANGLING_REASON[d.reason] || d.reason}）`));
            // ★ **改到该键**：指针"指向的头不存在"多半是**信息补全让键改了名**
            //   （`年份未知provincial-重庆` → `2025provincial-重庆`）—— 那时的正确动作是
            //   **改到按现值算出来的那个键**，不是把指针清掉（清掉等于丢了"它属于哪一组"这个结论）。
            //   ⚠️ 这一段**只对"指向不存在的头"**给按钮（`type`/`self` 是坏数据，改了没意义）。
            //   ⚠️ **人绑的也要给**：`synthConflicts` 的 `drift` 刻意跳过 `manual:set` 的
            //      （脚本不碰人的结论），于是这批"人绑 + 键过时"以前**只能清掉** —— 那是
            //      逼人丢结论。按钮点下去走的仍是 `applyOwnerSynth`（会写 `manual:set`），
            //      所以它照旧随 baseline 回代。
            // ⚠️ `retargetButton` 可能返回 `null`（算不出 / 树上没那个头时它只补一句说明）
            //    —— `appendChild(null)` 会当场抛，必须判返回值。
            if (d.reason === 'missing' && node) {
                const btn = retargetButton(node, row);
                if (btn) row.appendChild(btn);
            }
            return row;
        },
        action: {
            label: (n) => `🧹 清掉这 ${n} 个指针`,
            title: '把这些「所属合成节点」清空（**不删节点**，它们的其他字段一个字不改）',
            run: (draft) => { clearDanglingOwners(draft); },
            done: (n) => `已清掉 ${n} 个悬空指针`
        }
    },

    // ---- ② 计数不自洽的坏数据（节点 id 当标识写 / 两个节点共用一个标识）----
    //   ⚠️ **只报不动**：这两类得改数据，清指针解决不了（与黄条同一个姿态）。
    {
        id: 'incoherent',
        tone: 'note',
        items: (conf, ctx) => incoherentProblems(ctx && ctx.model),
        title: (n) => `⚠️ 数据不自洽 ${n} 处`
            + '（计数与成员表读不到一起 ⇒ **只报不动**，得改数据）',
        row: (w) => {
            const row = lineRow('dedup-prune-incoherent');
            row.textContent = String(w);
            return row;
        }
    },

    // ---- ③ 旧组头（空组 + 脚本键）----
    //   来由：**信息补全会让组标识改名**（`…年份未知provincial-山东` → `…2019provincial-山东`），
    //   成员被点到新头之后旧头就成了**空组**，在树上还挂着一张"没有成员的比赛卡"。
    //   守卫：**没有任何成员指着它** ∧ **键是脚本生成的**（判据一处：
    //   `core/synthPlan.js` 的 `isScriptKeyOrOld` —— 人手建的键不碰，
    //   因为"人刚建好、还没放成员"是常态，而人手建的键不可能是那两个形状）。
    //   ⚠️ **与 `synth-bind.mjs` 不是同一条**（以前这句注释写错了）：脚本侧更保守，
    //   只收**旧清单格式**的空组，本格式的留给这一栏 —— 见 `isScriptKeyOrOld` 的说明。
    {
        id: 'staleHeads',
        tone: 'warn',
        limit: 10,
        items: (conf) => (conf.staleHeads || []),
        title: (n) => `🕸 旧组头 ${n} 个`
            + '（没有任何成员指着它、键又是脚本生成的 ⇒ 收掉不影响任何绑定）',
        row: (it) => {
            const row = lineRow('dedup-prune-stalehead');
            const a = mk('span', '', 'cursor:pointer;');
            a.textContent = String(it.key);
            markGoto(a, it.id);
            row.appendChild(a);
            row.appendChild(document.createTextNode(`　${it.name || ''}`));
            return row;
        },
        action: {
            label: (n) => `🗑 收掉这 ${n} 个`,
            title: '把这些空组头删掉（同一个事务；没有成员指着它们 ⇒ 不会解开任何绑定）',
            run: (draft, items) => {
                for (const it of items) if (draft.nodes[it.id]) deleteNode(draft, it.id);
            },
            done: (n) => `已收掉 ${n} 个旧组头`
        }
    },

    // ---- ④ **同一个场次在树上被拆成两个 C**（一个键是另一个的键 + **旧写法**的尾巴）----
    //   来由：包那边的 QOJ 场次键只有两种 —— 基键 `qoj:c:<id>` 与 `qoj:c:<id>:ucup`
    //   （**两种读法两个节点**，2026-10-07 口径；`:ucup` 那份是**正规的**，**不在这一档里**）。
    //   旧写法 `:xcpc` 那个尾巴已废、包里不再产出，但**树上遗留的那批**包里已经没有对应记录了，
    //   而导入只加/改、**从不删** ⇒ 不收就永远当重复子树挂着。
    //   判据只有一份：`core/synthConflicts.js` 的 ⑫（这里一行判据都不写）。
    //   动作 = **连子树一起删**（那个 C 下面是它的题单/提交，都是这一场的重复副本）。
    {
        id: 'legacyTwins',
        tone: 'warn',
        limit: 10,
        items: (conf) => (conf.legacyTwins || []),
        title: (n) => `🪞 同一场被拆成两个 C ${n} 个`
            + '（键是另一个的键 + 尾巴 ⇒ 收掉带尾巴那个，**连它的题单一起**；'
            + '包里已经没有这个键的记录，所以导入不会碰它）',
        row: (it) => {
            const row = lineRow('dedup-prune-legacytwin');
            const a = mk('span', '', 'cursor:pointer;');
            a.textContent = String(it.key);
            markGoto(a, it.id);
            row.appendChild(a);
            row.appendChild(document.createTextNode(`　${it.name || ''}　→ 保留 ${it.base}`
                + `（这一份的整棵子树 ${it.subtree} 个节点会一起删掉）`));
            return row;
        },
        action: {
            label: (n) => `🗑 收掉这 ${n} 个`,
            title: '把带尾巴的那个 C 连同它的子树删掉（同一个事务；它没有独立记录 ⇒ 不影响别处绑定）',
            run: (draft, items) => {
                for (const it of items) {
                    if (!draft.nodes[it.id]) continue;
                    const res = deleteNode(draft, it.id);
                    cleanDeletedRealNode(draft, res.idsToClean);
                }
            },
            done: (n) => `已收掉 ${n} 个重复的 C 节点（含题单）`
        }
    },

    // ---- ⑤ **P 组键跟着 C 组过时了**（题目组没跟着场次的新键搬）----
    //   来由：场次（C 组）的键会因为"性质补全 / 改名"而变（实测：`…-东北` → `…-河北`），
    //   而题目组的键里嵌着**场次标识**（`synth:problem:<场次标识>-<题号>`）⇒ 一起过期。
    //   导入按 never 口径**不覆盖**已存在的成员指针（`planPointers`：旧值不是死指针就拒绝）
    //   ⇒ 它们一直停在旧键上：C 组叫新名、题目组还叫旧名，两边都"存在"、界面不报、导入不管。
    //   判据只有一份：`core/synthConflicts.js` 的 ⑬（这里一行判据都不写）。
    {
        id: 'staleProblemKeys',
        tone: 'warn',
        limit: 10,
        items: (conf) => (conf.staleProblemKeys || []),
        title: (n) => `📎 题目组的键跟着场次过时了 ${n} 个`
            + '（场次的键改过名 ⇒ 它下面的题目组键里还嵌着**旧场次标识**；'
            + '导入按 never 口径不覆盖已有指针 ⇒ 一直停在旧键上。点一下按**现在这个场次**的键改过去）',
        row: (it) => {
            const row = lineRow('dedup-prune-staleproblem');
            const a = mk('span', '', 'cursor:pointer;');
            a.textContent = String(it.key);
            a.title = '点一下跳到那个（旧）题目组头';
            markGoto(a, it.id);
            row.appendChild(a);
            row.appendChild(document.createTextNode(`　→ ${it.want}（这一组 ${it.count} 条成员）`));
            return row;
        },
        action: {
            label: (n) => `➡️ 改到该键这 ${n} 个`,
            title: '一次事务：把这一组的成员指针改到「按现在的场次算出来的键」。那个键已经有组头（多半是导入时'
                + '按新键造出来的）就逐个成员改指过去、再把空掉的旧头收掉；没有就把旧头本身改名过去。'
                + '**不删任何真实节点/题目**；做不到会当场说明原因（不静默失败）',
            // ⚠️ 这个动作**每一步都按 draft 的实时状态重新算**，不用渲染时那份快照
            //    （`it.memberIds` / `it.id` 是 `synthConflicts` 那一趟的产物）：
            //    实测踩到"点了按钮弹『已改 1 个』、行却还在" —— 快照与树对不上时，动作读完快照就
            //    悄悄什么都不做（成员列表为空 ⇒ 一个都没改），而调用方把异常吞掉（`.catch(() => {})`）
            //    ⇒ 人只看到"没反应"。失败要**说得出来**才查得动。
            run: (draft, items) => {
                const done = [];
                const cant = [];
                for (const it of items) {
                    const headId = synthIndex(draft).byKey.get(String(it.key));      // 实时找，不用快照
                    const targetId = synthIndex(draft).byKey.get(String(it.want));
                    // ---- ① 目标键还没有组头 ⇒ 把现在这个头**改名**过去（顺带把所有成员指针一起改）----
                    //   ⚠️ **必须用 `renameHeadKey`，不能用 `assignSynthKey`**：后者是"人手改标识"
                    //      那条路，会**拒收保留前缀 `synth:`**（`assertKeyUsable(auto=false)`）——
                    //      题目组的键全带 `synth:` ⇒ 从这条路上改名**必然被拒**，而调用方把异常吞掉
                    //      ⇒ 人看到的就是"点了按钮什么都没发生"（实测就是这个）。
                    //      `renameHeadKey` 是给"按规则算出来的标识"用的那条路（`auto=true`），
                    //      并且只改组头这一个键、四个性质一个字不改。
                    if (!targetId) {
                        if (!headId) { cant.push(`${it.key}：树上已经没有这个组头了（刷新一下）`); continue; }
                        try {
                            renameHeadKey(draft, headId, it.want);
                            done.push(it.key);
                        } catch (e) {
                            cant.push(`${it.key}：改成 ${it.want} 被拒（${e && e.message ? e.message : e}）`);
                        }
                        continue;
                    }
                    // ---- ② 目标键已经有那个头 ⇒ 把成员**改指过去**，再把空掉的旧头收掉 ----
                    if (!headId) { done.push(it.key); continue; }                    // 旧头本来就不在 ⇒ 已经对了
                    const memIds = Object.values(draft.nodes)
                        .filter((n) => n && String(n[OWNER_FIELD] || '').trim() === String(it.key))
                        .map((n) => n.id);
                    let moved = 0;
                    for (const mid of memIds) {
                        const m = draft.nodes[mid];
                        if (!m) continue;
                        try { applyOwnerSynth(draft, m, it.want); moved++; }
                        catch (e) { cant.push(`${mid}：改指到 ${it.want} 被拒（${e && e.message ? e.message : e}）`); }
                    }
                    // ⚠️ 旧头底下可能挂着**真实题目节点**（题目组头不是叶子）——
                    //    `deleteNode` 删的是**整棵子树**，直接删会把题目一起删掉 ⇒
                    //    先把孩子搬到新头下（题目的位置本来就是"组头底下"，搬过去正是它该在的地方）。
                    for (const cid of [...(draft.childOrder[headId] || [])]) {
                        try { moveNode(draft, cid, it.want); }
                        catch (e) { cant.push(`${cid}：搬到 ${it.want} 被拒（${e && e.message ? e.message : e}）`); }
                    }
                    if ((draft.childOrder[headId] || []).length) {
                        cant.push(`${it.key}：底下还挂着节点、搬不走 ⇒ 旧头留着（先把里面的东西处理掉）`);
                        continue;
                    }
                    const res = deleteNode(draft, headId);
                    cleanDeletedRealNode(draft, res.idsToClean);
                    done.push(it.key);
                    if (!moved) continue;
                }
                // ⚠️ **做不到就把话说出来**：调用方（`ui/kit/report.js` 的 actionButton）是
                //    `runWrite(...).catch(() => {})` —— 不抛错的话，人只会看到"点了没反应"。
                if (cant.length) throw new Error(`有 ${cant.length} 条没改成：${cant.slice(0, 3).join('；')}`);
            },
            done: (n) => `已把 ${n} 个题目组改到新键`
        }
    }
];

/** 按 id 取一条声明（判重页那条黄条要靠它拿到同一个动作与同一份文案） */
export function pruneStage(id) {
    return PRUNE_STAGES.find((s) => s.id === id) || null;
}

/** 悬空指针的**唯一**动作壳（判重页的黄条与 ⑤ 都走它，别各写一遍 `runWrite`） */
export function cleanDangling() {
    const st = pruneStage('dangling');
    runWrite((draft) => { st.action.run(draft); }, st.action.done(0)).catch(() => {});
}
