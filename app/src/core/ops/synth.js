// ================================================================
// 合成节点写操作（core/ops/synth.js）
//
// 合成关系由两半组成：
//   · 合成节点 = 一个真正的节点，身份是 `synthKey`（显示名「合成标识」，全局唯一）
//   · 原料节点 = 普通节点，靠 `ownerSynth`（显示名「所属合成节点」）指向某个 `synthKey`
//
// 三条铁律：
//   ① **不是父子关系**：成员不是"子节点"，只是"名单里的一项" —— 没有嵌套、
//      没有环、不需要拓扑排序，删掉合成节点也不会带走成员。
//   ② **同类型**：合成节点只能建在 C/P/R 上（比赛 W / 系列 S / 平台 O 不参与合成）；
//      成员与合成节点必须同类型。
//   ③ **结构是全局的、值才分账户**：`synthKey` / `ownerSynth` 都不记手改来源值
//      （属性表里 `manual: false`），但它们**可以随导入包走**（`importable: true`）。
//
// 所有写操作都**进撤销栈**（不加 `skipHistory`）：
// 合成、改名、改成员都是要能一键撤回的动作。
//
// 依赖：model/node.js, ops/_helpers.js, ops/account.js, utils/time.js（可进 Node 单测）
// ================================================================
import { createNode } from '../model/node.js';
import { TYPE_CHILDREN_MAP } from '../model/constants.js';
import { nextNodeId, ensureChildOrder, pushChild, ensureUniqueName, setParentOf, parentOfInDraft } from './_helpers.js';
import { setExpanded } from '../model/viewState.js';
import { assertManualEditAllowed } from './account.js';
import { getNowStr } from '../../utils/time.js';
// ★ 手工绑定的回代：人绑的指针要能**跟 nature 一样被认出来**，
//   否则重出包就丢了（`ownerSynth` 本身没有任何痕迹：属性表里它是 `manual: false`、也不记值来源）。
//   办法：复用同一条元列 `分类依据` —— 人绑/改/解绑时写/清 `分类依据.ownerSynth = manual:set`（级别 M）。
import { MANUAL_RULE, clearClassRule, setClassRule, pickGroupNature } from '../natureConfidence.js';
// 组头的**键与名**是它性质（分类/赛季/地点）的纯函数 ⇒ 性质一变就重算
// （`synthPlan` 只 import `natureFields`，不成环）
import { planKeyOf, sameNatureValue, CONFIRM_FIELD, KEY_PREFIX, PROBLEM_SYNTH_PREFIX } from '../synthPlan.js';

/** 自动生成的合成标识前缀（保留：用户自己填的标识不许用它开头） */
export const SYNTH_PREFIX = 'synth:';

/** 身份的字段名（在合成节点上） */
export const SYNTH_KEY_FIELD = 'synthKey';

/** 指针的字段名（在原料节点上） */
export const OWNER_FIELD = 'ownerSynth';

/** 允许合成的节点类型（W/S/O 一律不许） */
export const SYNTH_TYPES = ['C', 'P', 'R'];

/** 标识长度上限（防手滑粘进一整段文本） */
export const MAX_SYNTH_KEY_LEN = 64;

/** 归一化一个合成标识（空 = 没有） */
export function normalizeSynthKey(value) {
    if (value === undefined || value === null) return '';
    return String(value).trim();
}

/** 节点的合成标识（非空 ⇒ 它是合成节点） */
export function synthKeyOf(node) {
    return normalizeSynthKey(node && node[SYNTH_KEY_FIELD]);
}

/** 节点指向的合成标识（非空 ⇒ 它是某个合成节点的成员） */
export function ownerSynthOf(node) {
    return normalizeSynthKey(node && node[OWNER_FIELD]);
}

/** 是不是合成节点（= 有非空 `synthKey`，与 `extKey` 那套身份互不干扰） */
export function isSynthesis(node) {
    return !!synthKeyOf(node);
}

/**
 * 合成关系反查表（`合成标识 → 合成节点` / `合成标识 → 成员`）。
 *
 * 每次现算（一次全表遍历）。20k 节点量级下这是几百微秒，不值得维护增量缓存 ——
 * 少一份缓存就少一处"忘了同步"的 bug（写操作全部集中在本模块，反而是可靠的）。
 *
 * ⚠️ `members` 的顺序 = `Object.keys(nodes)` 的**插入序**（即节点被创建的先后），
 *    **不是树的顺序**。要"按树序"的成员名单请用 `synthMembers(state, synthKey)`
 *    （它真按 `childOrder` 做 DFS）；聚合叠值也一律走树序那一个。
 *    判重页只用来**展示**，插入序无害，但别拿它当排序依据。
 *
 * @returns {{byKey: Map<string,string>, members: Map<string,string[]>, keys: Set<string>}}
 */
export function synthIndex(state) {
    const nodes = (state && state.nodes) || {};
    const byKey = new Map();
    const members = new Map();
    for (const id of Object.keys(nodes)) {
        const key = synthKeyOf(nodes[id]);
        if (!key) continue;
        if (byKey.has(key)) {
            // 坏数据（**只可能是老数据**：写路径直接拒绝）：
            // 两个节点共用一个 `synthKey`。
            // **语义不变**（仍然"最后出现的赢"），只是不再静默。
            // ⚠️ 顺带 O(1) 的 `has` 命中，不重扫全表。
            console.warn(`[synth] 合成标识「${key}」被多个节点共用：`
                + `${byKey.get(key)} 与 ${id}（本表取最后出现的 ${id}，请改掉一个）`
                + ' —— 这是历史数据；「新的写入会被拒绝」（两个节点不许共用一个标识）');
        }
        byKey.set(key, id);
        members.set(key, []);
    }
    for (const id of Object.keys(nodes)) {
        const key = ownerSynthOf(nodes[id]);
        if (!key) continue;
        if (members.has(key)) { members.get(key).push(id); continue; }
        // ⚠️ 坏数据（**只可能是老数据**；写路径直接拒绝）：
        //    `ownerSynth` 写的是**节点 id**而不是 `synthKey`。
        //    本表按标识建组 ⇒ 这里读不出来，那个节点不进任何组（`groupCount` 那条口径
        //    却顺手认了 ⇒ 两边分叉）。只在"那个 id 真的是个合成节点"时报，
        //    别把"指向原料 / 悬空"也报进来（那两种有各自的处理）。
        const target = nodes[key];
        if (target && isSynthesis(target)) {
            console.warn(`[synth] 节点 ${id} 的「所属合成节点」写的是节点 id「${key}」，`
                + `不是合成标识（应为「${synthKeyOf(target)}」）—— 本表按标识读，读不出来`
                + '；这是历史数据，「新的写入会被拒绝」（要写 synthKey，不是节点 id）');
        }
    }
    return { byKey, members, keys: new Set(byKey.keys()) };
}

/**
 * 某个合成节点的成员 id 列表（**按树的顺序**，不是对象键顺序）。
 *
 * 聚合要按"名单顺序"叠值，所以顺序必须稳定且看得懂：
 * 从根做一次 DFS，指针指向它的就算成员（成员的后代不算，除非自己也有指针）。
 *
 * ⚠️ **单点查询**：每次调用都是一趟全树遍历。XCPC 那种"几百个合成节点"的
 *    场景下**不许**在循环里调它（那就是 O(#合成 × N)）—— 要一次拿全表请用
 *    `synthMembersTable(state)`（见下）。
 *
 * ⚠️ 这里刻意用**显式栈**而不是递归：两万节点的深树会把调用栈打爆。
 *    显式栈的压栈顺序与递归 `walk` 逐元素等价（先自己、再每个子树按
 *    `childOrder` 的顺序），包括"节点不存在 ⇒ 连它的子树一起跳过"这一条。
 */
export function synthMembers(state, synthKey) {
    const key = normalizeSynthKey(synthKey);
    if (!key) return [];
    const nodes = (state && state.nodes) || {};
    const childOrder = (state && state.childOrder) || {};
    const out = [];
    const stack = [state && state.rootId];
    while (stack.length) {
        const id = stack.pop();
        const node = nodes[id];
        if (!node) continue;
        if (ownerSynthOf(node) === key) out.push(id);
        const kids = childOrder[id] || [];
        for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    }
    return out;
}

/**
 * **一次性建好的成员表**：`synthKey → 成员 id 列表（按树序）`。
 *
 * 为什么要有它：XCPC 那块会有**几百个合成节点**，
 * 而 `synthMembers(state, key)` 每调一次就是一趟全树 DFS —— 渲染时"每个合成节点
 * 各调一次"就是 O(#合成 × N)，几百 × 两万 = 几千万次访问，不可接受。
 *
 * 本函数的总代价 = **O(N + Σ 组内成员数)**：
 *   · 第 1 趟：`synthIndex(state)` 的全表遍历（把标识集齐，顺带给出"空组也是空数组"）；
 *   · 第 2 趟：一趟**预序 DFS**（`childOrder` 迭代，不递归 ⇒ 深树不爆栈），
 *     走到谁就把谁塞进它指向的那一组 —— 塞进去的顺序**天然就是树序**，
 *     所以**不需要再排序**（若改用"预序编号 + 各组排序"，那是 O(Σ 成员 × log)，本
 *     写法更省，而且顺带与 `synthMembers` 的重复访问口径完全一致）。
 *
 * ⚠️ 与 `synthMembers(state, key)` **逐元素相同**：同一套 `childOrder` 遍历顺序、
 *    同样只收"从根走得到"的节点、同样不排除合成节点自己（自指是有问题的数据，
 *    由 `findDanglingOwners` 标出来，这里只如实陈列）。
 * ⚠️ 表的**键集** = `synthIndex(state).members` 的键集（真的有合成节点占着的标识）。
 *    悬空指针指向的标识**不是键** —— 与"组"的定义一致，`synthMembers` 才不管有没有组。
 *
 * ⚠️ **坏数据报 `console.warn`（本项目一贯的日志出口），不改结果**：
 *   · 重复 `synthKey` / `ownerSynth` 写成节点 id —— 由 `synthIndex(state)` 那一趟顺带报；
 *   · **成员从根走不到**（在 `synthIndex.members` 里、这趟预序收不到）—— 本函数报。
 *
 * @param {Object} state
 * @returns {Map<string,string[]>}
 */
export function synthMembersTable(state) {
    const nodes = (state && state.nodes) || {};
    const childOrder = (state && state.childOrder) || {};
    // ⚠️ 走**记忆化**的那份索引：`synthIndex` 是一趟全表（真包 27k 实测 **21ms**），
    //    而本函数一次显示要建好几次（`view/builders.js` 一次 + `groupCompute` 每层一次…）
    //    ⇒ 每次重扫是白付。**只有 `synthIndex` 能这么缓存**（它只读 `nodes`，
    //    与 `childOrder` / `rootId` 无关 —— 见下面"记忆化访问器"那段），
    //    本函数自己那趟预序（~13ms）**仍然每次现算**（它依赖树序，不能缓存）。
    const index = synthIndexOf(state);
    const table = new Map();
    for (const key of index.members.keys()) table.set(key, []);
    // 一趟预序：与 `synthMembers` 的 walk 同序（先自己、再按 childOrder 的子树）
    const stack = [state && state.rootId];
    while (stack.length) {
        const id = stack.pop();
        const node = nodes[id];
        if (!node) continue;
        const key = ownerSynthOf(node);
        const bucket = key ? table.get(key) : null;   // 悬空标识没进表 ⇒ 自然跳过
        if (bucket) bucket.push(id);
        const kids = childOrder[id] || [];
        for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    }
    // ⚠️ 坏数据（**只可能是老数据**；写路径直接拒绝"归入不在树上的节点"）：
    //    成员在 `synthIndex(state).members` 里有、这趟预序却走不到
    //    （成员挂在从根走不到的节点上 ⇒ 它明明指着某个标识，渲染时却从名单里消失）。
    //    检测**用集合大小差**，不重跑 DFS、不加中间结构：长度相等的组直接跳过；
    //    只有真不一致时才去算差集（坏数据路径，不在热路径上花这个钱）。
    for (const [key, full] of index.members) {
        const bucket = table.get(key);
        if (!bucket || bucket.length === full.length) continue;
        const missing = full.filter(id => bucket.indexOf(id) < 0);
        console.warn(`[synth] 合成标识「${key}」有 ${missing.length} 个成员从根`
            + `（${String(state && state.rootId)}）走不到，成员表收不到它们：`
            + missing.slice(0, 5).join('、')
            + (missing.length > 5 ? ` …等 ${missing.length} 个` : '')
            + ' —— 这是历史数据；「新的归入会被拒绝」（不在树上的节点没有归入的意义）');
    }
    return table;
}

// ================================================================
// 记忆化访问器（**只给读路径用**）
//
// 为什么需要：`synthIndex` 是一趟全表（真包 27k 实测 ~9ms），而读路径里它是**逐节点**
// 被调的 —— `core/groupValue.js` 的 `groupValueOnDemand`（走「组那份」显示时每个节点一次）
// ⇒ 那就是 **O(N²)**：几百个可见节点就几秒、上千个就是几十秒。
//
// ⚠️ **只有 `synthIndex` 能这么缓存**：它只读 `nodes`（两趟 `Object.keys(nodes)`），
//    **与 `childOrder` / `rootId` 无关** ⇒ 键取 `nodes` 引用就够（Immer 结构共享：
//    同一份引用内容不变，换了引用就重建；一槽 ⇒ 最多多留一份上一状态的引用）。
//    `synthMembersTable` **不能**这么缓存 —— 它依赖**树序**，而"就地换掉
//    `childOrder[某父]` 那个数组"不会换 `childOrder` 对象本身
//    （`src/test/groupValue.test.js` 的"成员顺序起作用"正是这么测的）⇒ 会拿到陈旧名单。
//
// ⚠️ **原始函数保持原样**：它们的 `console.warn`（坏数据）是按次报的，测试在数那个
//    （`synthMembersTable.test.js` 的 `captureWarn`）；缓存版本同一代只报一次。
// ================================================================
let indexMemo = null;

/** `synthIndex` 的记忆化版（读路径用；写路径继续用原始函数） */
export function synthIndexOf(state) {
    const nodes = (state && state.nodes) || null;
    if (indexMemo && indexMemo.nodes === nodes) return indexMemo.index;
    const index = synthIndex(state);
    indexMemo = { nodes, index };
    return index;
}

/**
 * 某个合成标识**是不是已经被别的节点占用**了。
 *
 * 这是"两个节点不许共用一个标识"这条铁律的**唯一判据** ——
 * `createSynthNode` / `assignSynthKey`（写路径拒绝）与判重页的 `createAndJoin`
 * （"建议的标识被占了就退回自动标识"）都调它，判断只有这一处。
 *
 * @param {Object} state
 * @param {string} key
 * @param {string} [selfId] 自己不算占用（改自己的标识时传自己的节点 id）
 */
export function isSynthKeyTaken(state, key, selfId = null) {
    const k = normalizeSynthKey(key);
    if (!k) return false;                       // 空标识 = 还没给，永远不算"被占用"
    const holder = synthIndex(state).byKey.get(k);
    return !!holder && holder !== selfId;
}

/**
 * 在 `parentId` 下找一个**已经存在的合成节点**，用来"复用而不是再叠一个"。
 *
 * 这是"位置不撞"的**唯一判据**（合成节点的生成"不要又撞位置又撞名字"）：
 * 同一个父节点下已经有一个**代表同一批东西**的合成节点时，调用方应当**归入它**，
 * 而不是在旁边再建一个几乎同名的组头（"同一父节点下并排好几个近乎同名的合成节点"
 * 就是这么来的）。
 *
 * 三条判据**全部是精确相等**（没有模糊匹配、没有随机数），按顺序取第一个命中的；
 * 都要求**同一个父 + 同一个类型**（跨父不是"同一个位置"，跨类型会被
 * `assertOwnerTarget` 的同类型校验拒掉，不能在这里埋）：
 *   ① **标识命中**：`synthKey` 非空，且这个兄弟用的就是它 —— 那就是同一批东西的组头
 *      （判重页候选给的标识"被占用"时走这一条：占它的若正在同一个位置，就是它）。
 *   ② **名字命中**：兄弟里已经有一个合成节点的 `name` 与 `name` **一字不差**。
 *      ⚠️ 只认**完全相同**：被 `ensureUniqueName` 改过名的（`X` → `X1`）**不算** ——
 *         那正是"另一个组头"，不是同一个。
 *   ③ **成员命中**：某个兄弟的成员集合与 `memberIds` **完全相同**（且非空）。
 *      这一条兜住"同一批成员又被点了一次"：`ensureUniqueName` 保证新建的那个**永远
 *      不会**和已有兄弟同名（`渠道甲` 会被改成 `渠道甲1`），所以光靠名字②是认不出
 *      "同一批"的 —— 认成员集合才准。它也正是"代表同一批成员"的字面口径。
 *
 * ⚠️ **只读、不改状态**：它只回答"该复用谁"，写不写由调用方决定
 *    （判重页 `createAndJoin` 复用它；`createSynthNode` 自己**不**调它 ——
 *    "新建"这个动作的语义就是新建，导入也依赖这一点）。
 * ⚠️ 顺序确定：按 `childOrder` 从前往后取**第一个**命中的（同一父下的结果可预测）。
 *
 * @param {Object} draft
 * @param {string} parentId 打算把新合成节点挂到哪儿（= 那个"位置"）
 * @param {Object} [want]
 * @param {string} [want.synthKey]   候选给的标识（省 = 不看标识）
 * @param {string} [want.name]       打算用的名字（省 = 不看名字）
 * @param {string[]} [want.memberIds] 打算归入的那批成员（省 = 不看成员）
 * @param {string} [want.type]       打算用的类型（省 = 不筛类型）
 * @returns {Object|null} 已有的那个合成节点（没有可复用的就 null）
 */
export function findReusableSynthSibling(draft, parentId, want = {}) {
    if (!draft || !draft.nodes || !parentId || !draft.nodes[parentId]) return null;
    const key = normalizeSynthKey(want.synthKey);
    const wantName = String(want.name === undefined || want.name === null ? '' : want.name).trim();
    const wantType = want.type ? String(want.type) : '';
    const memberIds = Array.isArray(want.memberIds) ? want.memberIds.filter(Boolean) : [];

    // 同父 + 同类型的合成节点（按 childOrder 顺序 ⇒ 结果可预测）
    const siblings = [];
    for (const cid of draft.childOrder[parentId] || []) {
        const child = draft.nodes[cid];
        if (!child || !isSynthesis(child)) continue;
        if (wantType && child.type !== wantType) continue;
        siblings.push(child);
    }
    if (!siblings.length) return null;

    // ① 标识命中
    if (key) {
        for (const child of siblings) {
            if (synthKeyOf(child) === key) return child;
        }
    }
    // ② 名字命中（一字不差）
    if (wantName) {
        for (const child of siblings) {
            if (String(child.name || '').trim() === wantName) return child;
        }
    }
    // ③ 成员命中（集合完全相同，且非空）
    if (memberIds.length) {
        const wantSet = new Set(memberIds);
        for (const child of siblings) {
            const have = new Set(synthMembers(draft, synthKeyOf(child)));
            if (have.size !== wantSet.size) continue;
            let same = true;
            for (const id of wantSet) {
                if (!have.has(id)) { same = false; break; }
            }
            if (same) return child;
        }
    }
    return null;
}

/**
 * 一个标识**有什么毛病**？`null` = 能用。
 *
 * ⚠️ **判据只有这一处**：写事务里的最终防线 `assertKeyUsable` 与 UI 关框前的早期出口
 * （`ui/G_modal/editForm.js` 的 `validateEdit`）**都读它**。
 * 为什么必须合并：两边各判一次就容易口径不一致 —— UI 那边若**无条件**查保留前缀，
 * 而自动分配的标识本来就是 `synth:<n>` ⇒ **每个合成节点连改个名字都保存不了**（实测踩过）。
 * 一处判据、一处文案，就不存在"哪天又漂移"。
 *
 * @param {Object} state - 只读（`isSynthKeyTaken` 要扫标识表）
 * @param {string} key
 * @param {string|null} [selfId] - 改自己的标识时把自己排除掉
 * @param {boolean} [auto] - 这个标识**不是人敲的**（自动生成 / 导入带入 / **原样保留旧值**）
 *        ⇒ 允许保留前缀。保留前缀只对"手敲一个新标识"设限。
 * @returns {null | 'empty' | 'too-long' | 'reserved' | 'taken'}
 */
export function synthKeyProblem(state, key, selfId = null, auto = false, takenHint = null) {
    if (!key) return 'empty';
    if (key.length > MAX_SYNTH_KEY_LEN) return 'too-long';
    if (!auto && key.startsWith(SYNTH_PREFIX)) return 'reserved';
    // ★ 调用方手里**已经有"哪些标识被占了"那张表**时（导入建合成节点）
    //   就别再 `synthIndex(state)` —— 那是两趟全表扫描，immer draft 上 25k 个代理 ⇒
    //   483 个合成节点实测多花 31s。`takenHint` 的答案与 `isSynthKeyTaken` **按构造相同**
    //   （那张表就是用同一个 `synthIndex` 播种的，之后每建一个就补一个）。
    if (takenHint) return takenHint.has(key) ? 'taken' : null;
    if (isSynthKeyTaken(state, key, selfId)) return 'taken';
    return null;
}

/** 毛病码 → 给用户看的话（**唯一一处文案**；两端共用，别各写一份） */
export function synthKeyProblemText(code, key) {
    switch (code) {
        case 'empty': return '合成标识不能为空';
        case 'too-long': return `合成标识太长（上限 ${MAX_SYNTH_KEY_LEN} 字符）`;
        case 'reserved': return `合成标识不能以保留前缀 ${SYNTH_PREFIX} 开头（那是自动生成的）`;
        case 'taken': return `合成标识「${key}」已被占用`;
        default: return '';
    }
}

/**
 * 校验一个标识能不能用（抛错版）。
 *
 * `auto` = 这个标识**不是人敲的**（自动生成 / 导入包带入）⇒ 允许保留前缀 `synth:`。
 * 保留前缀只对"手敲"设限：用户自己填的标识不许用它开头（免得和自动生成的长得一样）。
 */
function assertKeyUsable(draft, key, selfId, auto = false, takenHint = null) {
    const code = synthKeyProblem(draft, key, selfId, auto, takenHint);
    if (code) throw new Error(synthKeyProblemText(code, key));
}

/** 自动标识：`synth:1`、`synth:2`…（计数器存 `meta`，重开也接着往后排） */
function nextAutoSynthKey(draft) {
    const used = synthIndex(draft).byKey;
    const meta = draft.meta || (draft.meta = {});
    let n = Number(meta.synthKeyCounter) || 0;
    let key;
    do {
        n += 1;
        key = SYNTH_PREFIX + n;
    } while (used.has(key));
    meta.synthKeyCounter = n;
    return key;
}

/**
 * 新建合成节点。
 *
 * 它就是一个**普通节点**（挂在 `parentId` 下、有 name、能改名能删），只是多了个身份。
 * ⚠️ 父节点只管"这棵树让不让放这种类型"（`TYPE_CHILDREN_MAP`）——
 * 合成节点是**容器的兄弟**，不要求与父节点同类型（同类型说的是"与成员"，见 `applyOwnerSynth`）。
 *
 * @param {Object} draft
 * @param {string} parentId 挂到哪儿
 * @param {Object} [opts]
 * @param {string} [opts.synthKey] 指定标识（省 = 自动生成）
 * @param {string} [opts.name]     显示名（省 = 「合成」）
 * @param {string} [opts.type]     合成节点的类型（默认 = C，即"整场合成"）
 * @param {boolean} [opts.allowReserved=false] 允许 `synthKey` 以保留前缀 `synth:` 开头。
 *        只给**导入**用：包里的标识是**别的机器自动生成**的（`synth:1`），必须原样落地，
 *        否则"包可以带合成节点"在往返时就会因为前缀被拒而失败。
 *        手改（判重页的输入框）**不许**传它 —— 保留前缀对用户仍然是禁地。
 * @param {boolean} [opts.expandParent=true] 建完之后把父节点展开。
 *        默认 true（手改时你要立刻看见新建的合成节点）；**导入传 false** ——
 *        导入的铁律是"不展开"（一次上百个节点会把整棵树炸开，还会撞上
 *        `settings.performance` 的展开上限，见 core/validate/expanded.js）。
 * @returns {Object} 新节点
 */
export function createSynthNode(draft, parentId, opts = {}) {
    assertManualEditAllowed(draft, '新建合成节点');

    const parent = draft.nodes[parentId];
    if (!parent) throw new Error('父节点不存在');
    const type = opts.type ? String(opts.type) : 'C';
    if (!SYNTH_TYPES.includes(type)) {
        throw new Error(
            `不能合成 ${type} 节点：合成只在 ${SYNTH_TYPES.join(' / ')} 上做`
            + '（比赛 W / 系列 S / 平台 O 不参与合成）'
        );
    }
    const allowed = TYPE_CHILDREN_MAP[parent.type] || [];
    if (!allowed.includes(type)) {
        throw new Error(`父节点类型 ${parent.type} 不允许添加 ${type}`);
    }

    const given = normalizeSynthKey(opts.synthKey);
    const key = given || nextAutoSynthKey(draft);
    assertKeyUsable(draft, key, null, !given || opts.allowReserved === true, opts.takenHint || null);

    const id = nextNodeId(draft);
    const node = createNode(id, type, {
        name: (opts.name || '').trim() || '合成',
        [SYNTH_KEY_FIELD]: key
    });
    node.name = ensureUniqueName(draft, parentId, node.name);

    pushChild(draft, parentId, id);
    setParentOf(draft, id, parentId);
    draft.nodes[id] = node;
    ensureChildOrder(draft, id);
    if (opts.expandParent !== false) setExpanded(draft, parentId, true);
    return node;
}

/**
 * 改合成标识 —— **一次事务里把所有成员指针一起改掉**。
 *
 * 为什么必须一次做完：标识是成员指向它的唯一凭据，分两次改就会出现
 * "指针指向一个已经不存在的标识"的瞬间，而那个瞬间可能被自动保存下来。
 *
 * @returns {{node:Object, from:string, to:string, moved:number}}
 */
export function assignSynthKey(draft, nodeId, newKey) {
    assertManualEditAllowed(draft, '修改合成标识');

    const node = draft.nodes[nodeId];
    if (!node) throw new Error('节点不存在');
    if (!isSynthesis(node)) throw new Error('不是合成节点（它没有合成标识）');

    const key = normalizeSynthKey(newKey);
    if (key === node[SYNTH_KEY_FIELD]) return { node, from: key, to: key, moved: 0 };
    assertKeyUsable(draft, key, nodeId);

    const from = node[SYNTH_KEY_FIELD];
    node[SYNTH_KEY_FIELD] = key;
    node.lastModified = getNowStr();

    let moved = 0;
    for (const member of Object.values(draft.nodes)) {
        if (ownerSynthOf(member) !== from) continue;
        member[OWNER_FIELD] = key;
        member.lastModified = getNowStr();
        moved++;
    }
    return { node, from, to: key, moved };
}

/**
 * 把**组头自己**改到按现值算出来的那个键（成员一起改指过去）—— **一次事务**。
 *
 * 为什么必须有它（`assignSynthKey` 覆盖不到的那种情形）：
 *   `assignSynthKey` 管的是"这个头**换个名字**"，而 ⑤「人绑的键过时了」报出来的那一类
 *   是"**按规则算出来的那个头，树上根本没有**"（实测 9 条：`cc_provincial` ↔ `provincial`、
 *   `provincial` ↔ `ic_provincial`）。目标头不存在 ⇒ 既不能把成员改指过去（`applyOwnerSynth`
 *   会抛"不存在"），也不能靠重出包补上 —— 脚本那边**人绑的键一个字不动**（它不替人拿主意），
 *   于是包里那条指针指向一个**包里也没有的标识**，导入时被当悬空指针**直接拒收**
 *   （实测预览：「成员指针被拒 1 条 … 目标合成标识**树上没有、包里也没有**」）。
 *
 * 口径：
 *   · **只改组头这一个键**，四个 nature 一个字不改（"哪个方向是对的"由人点这一下表达：
 *     改了键 = 承认规则算出来的那个键、把头搬过去）；
 *   · 成员指针在**同一事务里**一起改（沿用 `assignSynthKey` 的做法，不留中间态）；
 *   · 目标键被别的头占着 ⇒ **抛错**（那是"两组该并"的另一件事，得人先统一分类）；
 *   · 目标键跨容器（父 S 层不一样）⇒ **抛错**：本操作不搬容器（少做一件事就少一个坑）。
 *
 * @returns {{head:Object, from:string, to:string}}
 */
export function renameHeadKey(draft, headId, newKey) {
    assertManualEditAllowed(draft, '改组头的合成标识');
    const head = draft.nodes[headId];
    if (!head) throw new Error('节点不存在');
    if (!isSynthesis(head)) throw new Error('不是合成节点（它没有合成标识）');

    const key = normalizeSynthKey(newKey);
    const from = synthKeyOf(head);
    if (key === from) return { head, from, to: key };
    assertKeyUsable(draft, key, headId, true);

    // 容器那一段必须一致：`synth:xcpc:<token>-<地名>` 的父是那一支的 S 层。
    // 不一致时的正确动作是"搬容器"（这一支还没做）⇒ 明说，别悄悄改出一个挂错父的头。
    const seg = (k) => String(k).split(':').slice(0, 2).join(':');
    if (seg(key) !== seg(from)) {
        throw new Error(`目标键在另一支容器下（${seg(from)} → ${seg(key)}）—— 这里只改键，不搬容器`);
    }

    let moved = 0;
    for (const m of Object.values(draft.nodes)) {
        if (ownerSynthOf(m) !== from) continue;
        m[OWNER_FIELD] = key;
        m.lastModified = getNowStr();
        moved++;
    }
    head[SYNTH_KEY_FIELD] = key;
    head.lastModified = getNowStr();
    return { head, from, to: key, moved };
}

/**
 * **成员的 nature 变了 ⇒ 组头跟着走**（同一事务里做，不另开一步）。
 *
 * 为什么必须有它：组头**没有独立信息**（键与名都是 `planKeyOf(它的性质)` 算出来的），
 * 而人填的是**成员**那一份。成员补了年份/赛季/地区之后没人跟，组头就一直停在
 * `年份未知`、继续挂在「性质待补」里（用户 2026-10-06："填充原料节点的信息后，
 * 合成节点的信息不更新"）。
 *
 * 口径**只有一份**：`core/natureConfidence.js` 的 `pickGroupNature()`（真值顶占位、
 * 级别高的赢、同级取最早；`scripts/synth-bind.mjs` 用的是同一条）。
 * 它交出**取值 + 依据规则 id**，规则从**胜出的那个成员**那格抄过来 ⇒ 不新增规则词表。
 *
 * 顺带把**键与名**跟上：nature 一变，`planKeyOf()` 算出的键就变了 ⇒ 走既有的
 * `assignSynthKey()`（它会在**同一事务里**把全部成员指针一起改写 —— 与「该换键」按钮
 * 完全同一条路）。⚠️ 目标键被别的组占着 / 算不出键 ⇒ **不搬**，留给人处理（与
 * `synth-bind.mjs` 的"一个字不写、只报出来"同姿态）。
 *
 * ⚠️ 组头的 nature 是**派生量**：它自己那几格不参与推导（人若手改组头的 nature，
 *    下一次成员改动会把它拉回派生值 —— 这是刻意的，"组头 = 成员的并"）。
 *
 * @param {Object} draft - `{ nodes, ... }`（draft，会被就地修改）
 * @param {Object} member - **draft 里**那个成员节点（有 `ownerSynth`）
 * @returns {{fields: string[], from: string, to: string, name: string}|null}
 *          改了什么；不在任何组 / 组头不在 ⇒ `null`
 */
export function syncGroupNature(draft, member) {
    const key = member ? ownerSynthOf(member) : '';
    if (!key || !draft || !draft.nodes) return null;
    const index = synthIndex(draft);
    const headId = index.byKey.get(key);
    if (!headId) return null;                    // 悬空指针：没有组头就没有"组头性质"
    return syncHeadNature(draft, headId, index); // 索引传下去：别为这一个头再扫一遍全表
}

/**
 * **一键**：树上所有"还有成员"的组头都按成员刷新一遍（同一个事务里）。
 *
 * 用途：**存量**那些"成员早填好了、组头还停在 `年份未知`"的（用户 2026-10-06：
 * "还有没同步的"）—— 单次编辑的自动跟随（`syncGroupNature`）只管之后的改动，
 * 这一支专门用来把旧数据一次对齐。
 *
 * ⚠️ 没成员的空组头**不动**（那是 ⑤「🕸 旧组头」要收的东西，不是拿来同步的）。
 * ⚠️ 键与名同 `syncHeadNature`：名跟着派生名走，人改过的名不动；键留给管线/「➡️ 改到该键」。
 *
 * @returns {Array<{id:string,key:string,fields:string[],name:string}>} 真的改了的组头
 */
export function syncAllGroupNatures(draft) {
    if (!draft || !draft.nodes) return [];
    // ⚠️ **索引只建一次**（`synthKeyOf`/`ownerSynthOf` 全表扫描）并传下去。
    //    让每个组头各自 `synthIndex(draft)` 是 O(#组头 × N)：实测 2.5k 个组头 × 2.8 万节点
    //    点一下按钮就**卡死界面**（用户 2026-10-06 反馈）。
    const index = synthIndex(draft);
    const out = [];
    for (const [key, headId] of index.byKey) {
        if (!(index.members.get(key) || []).length) continue;
        const r = syncHeadNature(draft, headId, index);
        if (r) out.push({ id: headId, key: r.key, fields: r.fields, name: r.name });
    }
    return out;
}

/**
 * 这一**场**（C 组头的键）底下**已确认**的题目组键（只读，给"取消确认"找对象用）。
 *
 * 为什么按**键**找而不是按树 / 父指针找：题目组的键是纯函数 `synth:problem:<场次标识>-<题号>`
 * （`core/synthPlan.problemSynthKey`），场次的键是 `synth:xcpc:<场次标识>` ⇒
 * "这一场的题目组" = 键以 `synth:problem:<场次标识>-` 开头的那些，**字符串就能判**，
 * 不用管它挂在树上哪、也不用管 `父synthKey` 那一格在应用侧存成什么样。
 * （末尾那个 `-` 是必需的：`…-北京` 与 `…-北京北` 只靠前缀会撞。）
 *
 * @param {Object} state
 * @param {string} cKey - 场次组键（`synth:xcpc:…`）
 * @returns {string[]} 题目组键（升序）
 */
export function confirmedProblemKeys(state, cKey) {
    const key = String(cKey || '').trim();
    if (!key.startsWith(KEY_PREFIX)) return [];
    const pfx = `${PROBLEM_SYNTH_PREFIX}${key.slice(KEY_PREFIX.length)}-`;
    const nodes = (state && state.nodes) || {};
    const out = [];
    for (const id of Object.keys(nodes)) {
        const n = nodes[id];
        if (!n) continue;
        const sk = String(n.synthKey || '');
        if (!sk.startsWith(pfx)) continue;
        if (n[CONFIRM_FIELD] === true || n[CONFIRM_FIELD] === '是') out.push(sk);
    }
    return out.sort();
}

/**
 * **取消"人确认过这一组"**（题目组；人撤销自己那条结论）。
 *
 * 撤销的是**两处**痕迹，缺一处就等于没取消：
 *   · 组头那格 `已确认`（组级标记，`scripts/problem-bind.mjs` 认的就是它）；
 *   · 成员身上 `分类依据.ownerSynth = manual:set` —— 那是**老数据**那套"人确认过"的痕迹
 *     （`core/synthConflicts` 的兜底判据仍然认它）⇒ 不撤掉的话，⑤ 里那一组**照样算已确认**。
 * ⚠️ **指针一个字不动**（`ownerSynth` 照旧）：取消的是"我确认过"这条结论，不是"它归哪一组"。
 *    要改归属请走 `bindOwner` / 判重页。
 *
 * @param {Object} draft
 * @param {Iterable<string>} keys - 题目组键（`synth:problem:…`）
 * @returns {{heads:number, members:number}} 真的清掉的组头数 / 成员痕迹数
 */
export function unconfirmProblems(draft, keys) {
    const index = synthIndex(draft);
    let heads = 0;
    let members = 0;
    for (const raw of keys || []) {
        const key = String(raw || '').trim();
        if (!key) continue;
        const headId = index.byKey.get(key);
        const head = headId ? draft.nodes[headId] : null;
        if (head && (head[CONFIRM_FIELD] === true || head[CONFIRM_FIELD] === '是')) {
            head[CONFIRM_FIELD] = false;
            heads++;
        }
        for (const mid of index.members.get(key) || []) {
            const m = draft.nodes[mid];
            if (m && clearClassRule(m, OWNER_FIELD)) members++;
        }
    }
    return { heads, members };
}

/**
 * 按成员刷新**一个**组头的性质（`syncGroupNature` 与 `syncAllGroupNatures` 共用这一份）。
 *
 * @param {Object} draft
 * @param {string} headId 组头节点 id
 * @param {Object} [index] 已经建好的 `synthIndex(draft)` —— **批量调用必须传**，
 *        否则每个头都重扫一遍全表（O(#组头 × N)，见 `syncAllGroupNatures`）
 * @returns {{fields:string[], key:string, name:string}|null} 改了什么；没成员/没改动 ⇒ `null`
 */
export function syncHeadNature(draft, headId, index) {
    const head = draft && draft.nodes ? draft.nodes[headId] : null;
    if (!head || !isSynthesis(head)) return null;
    const idx = index || synthIndex(draft);
    const key = synthKeyOf(head);
    const members = (idx.members.get(key) || [])
        .filter(id => id !== headId)
        .map(id => draft.nodes[id])
        .filter(Boolean);
    if (!members.length) return null;

    const { values, rules } = pickGroupNature(members);
    const fields = [];
    const before = {
        natureClass: head.natureClass, natureYear: head.natureYear,
        natureSeason: head.natureSeason, natureRegion: head.natureRegion
    };
    for (const [field, value] of Object.entries(values)) {
        if (!value) continue;
        // ★ **组头这四格是派生量，这里没有"人改过就别动"的守卫**（**故意没有**，别再加）：
        //   `分类依据.<字段>` 在组头上写 `manual:set` 有**两个来源** ——
        //     (a) 人直接改了组头这一格；
        //     (b) **成员**那格是人定的（级别 M 必然胜出）⇒ `pickGroupNature` 把它的规则 id
        //         **原样抄到组头**（见 `natureConfidence.pickGroupNature`）。
        //   两者在数据里长得一模一样 ⇒ 拿它当"人改过组头"的判据会**把派生自己锁死**：
        //   实测（2026-10-06）成员 2021（M）⇒ 组头 2021 + `manual:set`；成员改成 2022 后
        //   `syncHeadNature` 直接 `null`、组头停在 2021，且 ⑤ 一格都不报 —— 静默分叉。
        //   口径：组头那四格**按成员派生**（人改了它，下一次成员变化 / 重新导入 / 一键对齐
        //   会按成员重算；编辑面板上已如实写明这一点）。
        // ★ 与 ⑤「🔄 组头待同步」**同一份"算不算一致"**（分类只差镜像前缀不算不同）——
        //   这样"报出来的"与"点一下会改的"逐条对齐，不会点了却什么都没变。
        if (sameNatureValue(field, head, value)) continue;
        head[field] = value;
        if (rules[field]) setClassRule(head, field, rules[field]);
        fields.push(field);
    }
    if (!fields.length) return null;
    head.lastModified = getNowStr();

    // ---- 派生名跟上（键**不动**，见下）----
    //   ⚠️ **键不在这里改**：`synth:` 是**保留前缀**（`assertKeyUsable` 会拒人手写），
    //      它的改名是**管线**（`scripts/synth-bind.mjs` 按同一份 nature 重算）与
    //      判重页「➡️ 改到该键」（改的是**成员指针**，指向脚本已经建好的那个头）的事。
    //      这里只把**名字**从旧派生名换成新派生名 —— 且只在"当前名就等于旧派生名 / 是空的"
    //      时才动（人手改过的名字一个字不改）。
    let name = String(head.name || '');
    const oldGot = planKeyOf({ ...head, ...before });
    const got = planKeyOf(head);
    const oldName = oldGot && oldGot.name ? String(oldGot.name) : '';
    const newName = got && got.name ? String(got.name) : '';
    if (newName && newName !== name && (name === '' || name === oldName)) {
        head.name = newName;
        name = newName;
    }
    return { fields, key: String(head[SYNTH_KEY_FIELD] || key), name };
}

/**
 * 这个节点**在树上吗**？（`parentOf` 链能走到 `state.rootId`，且每一跳都真在
 * 父亲的 `childOrder` 里）
 *
 * 为什么需要它：`nodes` 表里有、却挂不到根上的节点（半拉子数据 / 手工塞进来的）
 * **归入一个合成节点是没有意义的** —— 它根本不会出现在树里，成员表按树序 DFS
 * 也收不到它，归入这个动作只是把一份"看不见的坏数据"写进去。
 *
 * ⚠️ 迭代 + `seen` 防环（数据里 `parentOf` 可能自指/成环），两万节点的深链不爆栈。
 * ⚠️ 只给**写路径**用；读路径（`synthMembersTable` / `collectGroups`）对坏数据
 *    仍然只警告 + 按单元素组处理，绝不抛错。
 */
function isNodeOnTree(state, id) {
    if (!state || !id) return false;
    const rootId = state.rootId;
    if (!rootId) return false;
    const nodes = state.nodes || {};
    const childOrder = state.childOrder || {};
    const seen = new Set();
    let cur = id;
    while (cur) {
        if (cur === rootId) return true;
        if (seen.has(cur) || !nodes[cur]) return false;
        seen.add(cur);
        // ★ 走 `parentOfInDraft`：结构操作已不再写 `draft.parentOf`（见 `_helpers.js` 文件头），
        //   直接读 `state.parentOf` 会把**本事务刚建的节点**判成"不在树上"（实测：导入第二阶段全被拒）。
        const parent = parentOfInDraft(state, cur);
        if (!parent) return false;
        const siblings = childOrder[parent];
        if (!siblings || siblings.indexOf(cur) < 0) return false;   // 不在 childOrder 体系里
        cur = parent;
    }
    return false;
}

/**
 * 写「所属合成节点」指针前的**唯一一处**校验（五个出口全走它，别各抄一遍）。
 *
 * 四条铁律：**这些坏数据不能由操作产生**，写路径直接拒绝：
 *   ① 目标必须**存在**：那个 `synthKey` 得真有合成节点用着它。悬空指针不由写路径
 *      产生（文件里已经躺着的悬空指针是另一回事：读路径 `findDanglingOwners`
 *      标黄 + 一键清理 + 按单元素组算）。
 *   ② 写的必须是**合成标识**，不是**节点 id** —— 写 id 只有 `groupCount` 顺手认，
 *      成员表与别处读不出来，两套口径会分叉。
 *   ③ 同类型（P 不能进 C 的合成）。
 *   ④ 成员得**在树上**（从 `rootId` 走得到）—— 见 `isNodeOnTree`。
 *
 * 抛出的异常 = 事务回滚（界面弹错），也就是"拒绝这次操作"。
 *
 * ⚠️ 导入的**第二阶段**（`setOwnerRaw`）也走这里：那一刻包里新建的合成节点
 *    已经在第一阶段登记好了，所以"目标必须存在"成立；见 features/AutoImport/plan.js。
 */
function assertOwnerTarget(draft, node, key, holderHint = '') {
    // ⚠️ `holderHint`（实测）：「这个 key 指向哪个节点」有时**调用方已经知道**
    //    （导入的指针阶段手里就有一张"键 → id"表，见 `synthApply.js`）。给了它就不必再跑
    //    `synthIndex(draft)` —— 那是**两趟全表扫描**，而且在 immer draft 上读 25k 个代理时极慢
    //    （实测 918 个指针 × 全表 = 70s，占整个导入 98%）。语义一点没变：提示与 `synthIndex`
    //    对同一个 key 的答案**按构造相同**（那张表就是用它播种、之后只在建节点时 `.set`）。
    // ⑤ 合成节点不能当成员：它自己是"组头"，再挂一个指针就自相矛盾
    //    （读路径 `collectGroups` 对这种数据只警告 + 按它自己那组处理）。
    //    这条也在这里挡住（导入的 plan 层另有 `synth-node-with-owner`，
    //    校验收在这里之后，两处合成一套判据）。
    if (isSynthesis(node)) {
        throw new Error('合成节点不能有「所属合成节点」—— 成员名单不能嵌套'
            + `（「${node.id}」的合成标识是「${synthKeyOf(node)}」，它自己就是组头）`);
    }
    const holderId = holderHint && draft.nodes[holderHint] ? holderHint : synthIndex(draft).byKey.get(key);
    if (!holderId) {
        // ② 写的是节点 id：单独一条文案（否则用户只看到"不存在"，根本不知道
        //    自己要写的是另一个值）。判据与读路径 `synthIndex` 的警告完全相同。
        const asId = draft.nodes[key];
        if (asId && isSynthesis(asId)) {
            throw new Error('「所属合成节点」要写合成标识（synthKey），不是节点 id：'
                + `「${key}」是节点 id，它的合成标识是「${synthKeyOf(asId)}」`);
        }
        // ① 悬空：拒绝（写路径不许产生悬空指针）
        throw new Error(`合成标识「${key}」不存在：树上没有任何合成节点用它`
            + '（悬空指针不能由操作产生，请先建好那个合成节点）');
    }
    // ④ 成员不在树上：归入没有意义
    if (!isNodeOnTree(draft, node.id)) {
        throw new Error(`「${node.id}」不在树上（从根走不到），归入它没有意义`);
    }
    const target = draft.nodes[holderId];
    if (target && target.type !== node.type) {
        throw new Error(`合成关系必须同类型（成员是 ${node.type}，合成节点是 ${target.type}）`);
    }
    if (holderId === node.id) throw new Error('不能把自己设成所属合成节点');
}

/**
 * 把 `ownerSynth` 应用到某个节点上（**校验过的低层入口**）。
 *
 * 给 `updateP` / `updateWS` / `updateR` 共用：手改走这条路，所以必须严格 ——
 * 指一个不存在的标识、把节点 id 当标识写、跨类型、指向自己、节点不在树上
 * 都直接抛（抛出 = 事务回滚，界面弹错）。
 * 导入包的两阶段解析**不走这里**（它要先把节点建齐），见 `setOwnerRaw`。
 *
 * @returns {string} 落定的标识（空 = 解绑）
 */
export function applyOwnerSynth(draft, node, value) {
    assertManualEditAllowed(draft, '设置所属合成节点');
    const key = normalizeSynthKey(value);
    if (!key) {
        node[OWNER_FIELD] = '';
        clearClassRule(node, OWNER_FIELD);      // 解绑 = 撤掉"这是人定的"那条痕迹
        return '';
    }
    assertOwnerTarget(draft, node, key);
    node[OWNER_FIELD] = key;
    // ★ 标 M：这是**人的决定**（`分类依据.ownerSynth`）⇒ ① 才能被「📤 导出人工填写」收进 baseline、
    //   重出包后被回代；② `synth-bind` 看到它**一个字不动**（否则它会照 nature 重算、悄悄搬走）。
    //   ⚠️ 只标在**手改这条路**上：导入走 `setOwnerRaw`（那边不标），脚本产的指针也不经过这里。
    setClassRule(node, OWNER_FIELD, MANUAL_RULE);
    return key;
}

/**
 * 不改手动闸门、但**一样校验**的裸写（**只给导入用**）。
 *
 * "裸"指的是它豁免 `assertManualEditAllowed`（导入不是手改），**不是**豁免校验：
 * 它同样拒绝 ①目标不存在 ②写节点 id ③跨类型/自指 ④成员不在树上
 * ⑤合成节点当成员（见 `assertOwnerTarget`）。导入与手改**同一套判据**。
 * 导入是两阶段（先建合成节点、再写指针），
 * 所以"目标必须存在"的判定发生在**第二阶段** —— 此刻包内新建的合成节点
 * 已经在第一阶段落地并登记好了，"同一次导入里新建 + 指向它"不会被误杀。
 *
 * 解绑（空值）任何时刻都允许：把指针清掉永远不会写坏数据。
 */
export function setOwnerRaw(draft, nodeId, value, opts = {}) {
    const node = draft.nodes[nodeId];
    if (!node) throw new Error('节点不存在');
    const key = normalizeSynthKey(value);
    if (!key) {
        node[OWNER_FIELD] = '';
        return '';
    }
    // `opts.holderId`：调用方已经知道"这个 key 的组头是谁"时（导入的指针阶段）传进来，
    // 省掉一次全表扫描 —— 见 `assertOwnerTarget` 的说明。
    assertOwnerTarget(draft, node, key, opts.holderId || '');
    node[OWNER_FIELD] = key;
    return node[OWNER_FIELD];
}

/** 把某个节点设成某合成节点的成员（空标识 = 解绑） */
export function bindOwner(draft, nodeId, synthKey) {
    assertManualEditAllowed(draft, '设置所属合成节点');
    const node = draft.nodes[nodeId];
    if (!node) throw new Error('节点不存在');
    const key = applyOwnerSynth(draft, node, synthKey);
    if (key) node.lastModified = getNowStr();
    else node[OWNER_FIELD] = '';
    return node;
}

/** 解绑（= 把它从名单里去掉；成员本身还在树上） */
export function unbindOwner(draft, nodeId) {
    return bindOwner(draft, nodeId, '');
}

/**
 * 找出所有**悬空**的指针（指向不存在的合成节点、跨类型、或指向自己）。
 *
 * 只读，给界面标红 + 导入预览用。默认口径：
 * **提示 + 一键清理**，不抛异常、更不删节点。
 */
export function findDanglingOwners(state) {
    const nodes = (state && state.nodes) || {};
    const idx = synthIndex(state);
    const out = [];
    for (const id of Object.keys(nodes)) {
        const node = nodes[id];
        const key = ownerSynthOf(node);
        if (!key) continue;
        const holderId = idx.byKey.get(key);
        const target = holderId ? nodes[holderId] : null;
        let reason = '';
        if (!target) reason = 'missing';
        else if (holderId === id) reason = 'self';
        else if (target.type !== node.type) reason = 'type';
        if (!reason) continue;
        out.push({ id, synthKey: key, reason });
    }
    return out;
}

/** 一键清理悬空指针（返回清了几条 + 清的是哪些） */
export function clearDanglingOwners(draft) {
    assertManualEditAllowed(draft, '清理悬空的所属合成节点');
    const bad = findDanglingOwners(draft);
    for (const item of bad) {
        const node = draft.nodes[item.id];
        if (node) node[OWNER_FIELD] = '';
    }
    return { cleaned: bad.length, items: bad };
}

/**
 * 清掉指向这些标识的所有指针（合成节点被删时由 `tree.deleteNode` 调）。
 *
 * 与删除**同一个事务**：删除后不能让树里留着一批指向死标识的指针。
 */
export function clearOwnersOf(draft, synthKeys) {
    assertManualEditAllowed(draft, '清理所属合成节点指针');
    const set = new Set((synthKeys || []).map(normalizeSynthKey).filter(Boolean));
    if (!set.size) return 0;
    let cleared = 0;
    for (const node of Object.values(draft.nodes)) {
        const key = ownerSynthOf(node);
        if (!key || !set.has(key)) continue;
        node[OWNER_FIELD] = '';
        cleared++;
    }
    return cleared;
}
