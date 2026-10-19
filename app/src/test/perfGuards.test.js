// ================================================================
// 加速那三刀的**守卫** —— 都是"看不出但一改就慢 400ms"的那种坑
//
// 来由：相当多的操作延迟在 1s 以上。按纪律**先打点测时**
// （`scripts/perf-bench.mjs`，真实包 26921 条记录），量出来三处，各自有数量级证据：
//
//   ① `core/model/state.js` 的**顶层键顺序** —— `nodes`/`childOrder`/`parentOf` 若排在
//      `meta`/`settings` 这些浅键**前面**，Immer 提交事务时会对它们做**深度遍历**：
//      改 `meta` 一个键 **418ms** → 把三个大字典挪到最后 **1ms**。
//   ② `core/fieldValue.js` 的 `addSourceValue` —— 从 **draft** 数组里读条目会留下子 draft，
//      于是 Immer 又要深遍历整棵树：改一个 `status1` **432ms** → 读**原始值** **24ms**。
//   ③ `view/info.js` 的存储体积 —— `DB_MODIFIED`（每次改数据）都同步 `JSON.stringify(整个 state)`：
//      真包 **~300ms/次** → 改成"启动算一次、之后延迟 + 合并"。
//
// 三条合起来：**一次操作 982ms → ~610ms**（剩下的主要是落盘写 ~200ms、applyState/GC/刷新链 ~350ms）。
// ================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createInitialState } from '../core/model/state.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
/** 去掉**整行注释**之后再匹配 —— 坑就写在注释里（"别这么写"），按原文匹配会误伤（实测踩到） */
const codeOnly = (src) => src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

test('★ ① `createInitialState()` 的三个大字典必须是**最后**三个键（Immer finalize 顺序坑）', () => {
    const keys = Object.keys(createInitialState());
    assert.deepEqual(keys.slice(-3), ['nodes', 'childOrder', 'parentOf'],
        'nodes / childOrder / parentOf 必须排在最后 —— 挪到前面会让每次事务多花 ~400ms（见文件头）');
    // 反向锚：浅键（常常被事务改的那些）必须在前面，别哪天又给挪到后面去
    assert.ok(keys.indexOf('meta') < keys.indexOf('nodes'), 'meta 这类浅键要在前面');
    assert.ok(keys.indexOf('settings') < keys.indexOf('nodes'), 'settings 也一樣');
});

test('★ ② `addSourceValue` 读条目要走 `baseValuesOf`（别从 draft 数组里读）', () => {
    const src = read('src/core/fieldValue.js');
    assert.match(src, /function baseValuesOf\(node\)/, '基础版本读取器要在');
    assert.match(src, /baseValuesOf\(node\)/, '`addSourceValue` 要用它读条目');
    assert.doesNotMatch(codeOnly(src), /node\.values\s*=\s*\{\s*\.\.\./,
        '不许再把 `values` 整个换成新对象（`= { ...node.values }` 那写法会让 Immer 深遍历整棵树）');
});

test('★ ③ 存储体积**一律延迟算**（`view/info.js`；启动第一屏也不许同步算）', () => {
    const src = read('src/view/info.js');
    assert.match(src, /function scheduleSizeCompute/, '要有延迟计算的入口');
    assert.match(src, /const SIZE_DEFER_MS = \d+/, '延迟时长要写成常量（便于调/便于看）');
    // 2026-10-18 收紧：原来只禁"事务路径上同步算"，留着"启动第一屏同步算一次"；
    //   实测那一次在主树那一趟里是 157ms（探针机）/ ~300ms（浏览器），而**体积是最不影响判断的那个数**
    //   ⇒ 改成启动也走延迟、先显示 `…`。守卫也一起收紧成"updateInfoBar 里一次同步算都不许有"。
    const body = /export function updateInfoBar\(state\)[\s\S]*?\n\}/.exec(src);
    assert.ok(body, '找得到 updateInfoBar（守卫别是空转）');
    assert.match(body[0], /scheduleSizeCompute\(state\)/, '有缓存/没缓存都走延迟计算');
    assert.doesNotMatch(body[0], /computeSizeNow\(state\)/,
        '`updateInfoBar` 里**一次**同步算都不许有（启动那一次也包括）—— 它会卡住首屏几十到几百毫秒');
});

test('加速探针还在（`scripts/perf-bench.mjs`：先量再改，别把工具删了）', () => {
    const src = read('scripts/perf-bench.mjs');
    assert.match(src, /导包（解析 \+ 计划 \+ 落库）/, '它得走真实导包链路');
    assert.match(src, /一次操作/, '它得量"一次操作"那条最关键的数');
    assert.match(src, /分阶段耗时/, '它得按耗时排序打表');
});

// ================================================================
// 第二批（"把开销挪到初始化"）：派生表增量 / parentOf 不重建 / 判重页延迟重画
// ================================================================
test('★ ④ `applyState`：`childOrder` 没变就不重建 `parentOf`（27k 实测 ~9ms/次）', async () => {
    const { applyState } = await import('../transaction/history.js');
    const state = { childOrder: { a: ['b'] }, parentOf: { a: null, b: 'a' }, nodes: {}, meta: { x: 1 } };
    const before = state.parentOf;
    applyState(state, { nodes: { n: 1 }, childOrder: state.childOrder });   // 同一个 childOrder 引用
    assert.equal(state.parentOf, before, '结构没变 ⇒ parentOf 那个对象应当**原样保留**（不重建）');
    applyState(state, { childOrder: { a: ['b', 'c'] } });                  // 换了引用 = 结构变了
    assert.notEqual(state.parentOf, before, '结构变了 ⇒ 必须重建');
    assert.deepEqual(state.parentOf, { b: 'a', c: 'a' });
});

test('★ ⑤ 判重整理页的重画是**延迟一拍**的（那页冷算 0.5~1.2 秒，别卡在点击那一帧）', () => {
    const src = codeOnly(read('src/ui/tabs.js'));
    assert.match(src, /scheduleDedupRefresh\(\)/, '刷新要排进延迟队列');
    assert.match(src, /function scheduleDedupRefresh\(\)/, '延迟函数要在');
    assert.match(src, /setTimeout\(\(\) => \{[\s\S]{0,200}refreshDedupPage\(\)/, '延迟到点才重画');
    // 但**缓存作废仍要同步**（否则延迟窗口里读到的会是陈旧模型）
    const listener = /UI_REFRESH_REQUIRED, \(\) => \{[\s\S]*?\n    \}\)/.exec(src);
    assert.ok(listener, '找得到那个监听器（守卫别是空转）');
    assert.match(listener[0], /invalidateDedupCache\(\)/, '作废缓存那步必须同步做');
});

test('★ ⑥ 派生表增量：实现 + 对拍测试都在', () => {
    const src = read('src/core/derive.js');
    assert.match(src, /function affectedIds\(/, '要能算出"变了的 + 祖先"');
    assert.match(src, /INCREMENTAL_MAX/, '要有规模上限（超了就整份重算）');
    assert.match(src, /incremental: \{[\s\S]{0,200}?prev: hit\.table/, '只在记忆化那条路上走增量');
    assert.match(src, /function expandAffected\(/, '祖先那一段要与"扫全表那一趟"共用（写路径交名单时走它）');
    // ★ 写路径把"碰过哪些 id"交过来（省掉 27k 那一趟扫描）：名单与两代对不上就退回自己扫
    assert.match(src, /export function noteValueDelta\(/, '要有写路径交名单的入口');
    assert.match(src, /function notedDeltaOf\(/, '要有"名单与这两代对不对得上"的判据（对不上 ⇒ 自己扫）');
    // ★ 增量只折**成员动过的**那些组头（组划分动过 ⇒ `null` = 全部，见 affectedHeads 的注释）
    assert.match(src, /function affectedHeads\(/, '要能算出"哪些组头要重折"');
    assert.match(src, /if \(groupingChanged\) return null;/, '组划分动过 ⇒ 不敢挑名单，全部走一遍');
    assert.ok(fs.existsSync(path.join(REPO, 'src/test/deriveIncremental.test.js')),
        '对拍测试（增量 == 整份）要在 —— 这条最容易"静默算错数"');
});

test('★ ⑦ 组那份：不扫全表的早退 + 层间不重算派生表（`core/groupCompute.js`）', () => {
    const src = codeOnly(read('src/core/groupCompute.js'));
    assert.match(src, /function inSomeGroup\(node\)/, '要有"在不在组里"的判据');
    assert.match(src, /if \(!inSomeGroup\(node\)\) return undefined;/,
        '不在组里的节点要**直接返回**（不然为了一个是/否把整棵树算一遍，真包 ~750ms）');
    // 层间那张"带覆盖的派生表"没有任何读者（`readOwn` 的兜底顺序是 `own` → `working` → `baseOf`，
    // 而 `own` 只装本类型节点）⇒ 一次都不许再建。真包实测每建一次 **314ms**、两层 600+ms，
    // 而 dedup 的显示侧首次取值总共才 ~1s ⇒ 这一条是它最大的一笔。
    assert.doesNotMatch(src, /buildDerivedTable/,
        '层间不许再整份重算派生表（那张表没读者；每次真包 314ms）');
    assert.match(src, /scopeAccounts: scopeId/, '初始那份要按 `scopeOpts` 同形的范围参数走记忆化（能复用显示那张表）');
    assert.ok(fs.existsSync(path.join(REPO, 'src/test/groupValueEarlyExit.test.js')),
        '早退的测试要在（里面用"一枚举就抛"的 Proxy 钉住"确实没扫表"）');
});

// ================================================================
// Immer 那趟"深走"的开关 + 统计栏延迟一拍
//
// "点一下"仍要 ~0.3s：CPU 采样发现两笔：
//   ⑧ Immer 提交事务时会**深走普通对象**去找"被塞进普通对象的 draft" —— 走多远取决于改的
//      那个节点在 `nodes` 里的位置（改第 7 个 28ms / 第 9449 个 132ms / **最后一个 389ms**；
//      只动 `childOrder` 也 400ms+）。`finalizeProperty` 那道门是 `isDraftable && !isFrozen`
//      ⇒ **把节点对象冻上就整条跳过**（实测 389ms → 31ms、addChild 425ms → 127ms）。
//   ⑨ 全局统计（`computeGlobalStats`）每次事务都要整表扫好几趟（~100ms，占一次"点已处理"的一半）
//      ⇒ 它**不是交互反馈**，改成"先画上一次那串，一拍之后再算准"（与体积、判重页同一姿态）。
//
// 合起来：一次"点已处理" 292ms → 218ms、"新建一道题" 522ms → 473ms、"撤回" 403ms → 344ms。
// ================================================================
test('★ ⑧ 节点对象必须"冻上"（Immer 深走的开关），两个挂钩点都要在', () => {
    const stateSrc = codeOnly(read('src/core/model/state.js'));
    assert.match(stateSrc, /export function freezeNodes\(state\)/, '要有 `freezeNodes`（`core/model/state.js`）');
    assert.match(stateSrc, /!Object\.isFrozen\(node\)/, '只冻**没冻过**的（每次事务都要补冻，别重复冻）');

    // 挂钩点一：整体替换（启动加载 / 整包导入）—— 必须在 `applyView` **之后**（那是就地改节点）
    const shell = codeOnly(read('src/shell/state.js'));
    assert.match(shell, /freezeNodes\(AppState\)/, '`replaceState` 要补冻');
    assert.ok(shell.indexOf('applyView(AppState)') < shell.indexOf('freezeNodes(AppState)'),
        '顺序要紧：`applyView` 就地写 `expanded` ⇒ 必须先贴回折叠状态、再冻');

    // 挂钩点二：每次事务 / 撤回
    const history = codeOnly(read('src/transaction/history.js'));
    assert.match(history, /freezeNodes\(state\)/, '`applyState` 要补冻（事务改出来的节点是**可写的副本**）');
});

test('★ ⑧b 行为锚：事务之后节点是冻的，事务外就地改**当场抛错**（那本来就是静默 bug）', async () => {
    const { applyState } = await import('../transaction/history.js');
    const { freezeNodes } = await import('../core/model/state.js');
    const state = { nodes: { a: { id: 'a', name: 'A' } }, childOrder: { a: [] }, parentOf: { a: null } };
    applyState(state, { nodes: { a: { id: 'a', name: 'B' } } });
    assert.equal(Object.isFrozen(state.nodes.a), true, '事务之后节点对象应当是冻的');
    // ⚠️ 断言的是**冻结这一类**错误（不是"随便抛点什么"）：
    //    第二个参数写成字符串时 node:assert 把它当 message，抛个 RangeError 也算过。
    assert.throws(() => { state.nodes.a.name = 'C'; },
        { name: 'TypeError', message: /read only|not extensible/ },
        '事务外就地改节点 ⇒ 必须是"冻结"那个 TypeError（不冻上就是静默改坏）');
    // 冻过的不重复冻（返回 0）—— 每次事务只花"补冻那几个"的钱
    assert.equal(freezeNodes(state), 0, '已经冻过的不再冻（幂等、也不白花钱）');
});

test('★ ⑧c 行为锚：`replaceState`（启动加载 / 整包导入）之后节点也是冻的', async () => {
    // 为什么单列一条：⑧ 对 `replaceState` 那个挂钩点只做了
    // **源码字符串匹配** —— 把它改成 `if (false) freezeNodes(AppState);`，⑧/⑧b 全绿、
    // 也没有任何冒烟会红（⑧b 只测 `applyState`）。这里补上"真跑一次整体替换"的行为锚。
    // ⚠️ 只能在冒烟里跑（`shell/state.js` 牵进裸包名 `immer`）⇒ 真正那条断言在
    //    `scripts/smoke/data-invariants.smoke.mjs` 的「状态不变量」那一组，这里只钉"那条还在"。
    const src = read('scripts/smoke/data-invariants.smoke.mjs');
    assert.match(src, /replaceState 之后节点是冻的/, '冒烟里要有 replaceState 的冻结行为锚');
    assert.match(src, /Object\.isFrozen\(AppState\.nodes/, '而且断言的是"节点对象确实冻了"');
});

// ================================================================
// 只对"正确性"做对拍是不够的
//
// 实测：`scripts/smoke/tree-ops-incremental.smoke.mjs` 的六条 `converged`（"增量跑完再整树
// 重算必须返回 0"）**守不住它命名的那个性能性质** —— 把那六处换回 `fullAutoUpdate(draft)`
// 之后，整树算过再算一遍当然是 0，六条全绿（那是"新建一道题 1250ms"的回归）。
// 而"数一数读了几格 childOrder"这种判据**也不可靠**（容器汇总本来就是 O(子树)，实测
// 增量 2428 / 整树 3416，同量级）⇒ 这个性质只能用**源码锚**钉：`tree.js` 里不许再出现整树重算。
// ================================================================
test('★ ⑩ 结构操作不许再整树重算（`core/ops/tree.js` 里不许出现 `fullAutoUpdate(` 调用）', () => {
    const src = codeOnly(read('src/core/ops/tree.js'));
    assert.doesNotMatch(src, /fullAutoUpdate\s*\(/,
        '结构操作一律走"那棵子树 + 祖先链"（`updateAddedSubtree` / `updateAfterRemoval`）——'
        + '换回整树重算就是"新建一道题 ~1250ms"那个回归');
    assert.match(src, /autoUpdateSubtree\(draft, /, '增/清空那一支要用子树重算');
    assert.match(src, /autoUpdateChain\(draft, /, '删/移那一支要用"自己 + 祖先链"重算');
    // 注释里出现 `fullAutoUpdate` 不算违规：`codeOnly` 已经把整行注释去掉了（反向自检）
    assert.match(read('src/core/ops/tree.js'), /整棵树重算一遍/,
        '（自检）注释还在 ⇒ 上面的 `doesNotMatch` 确实是在"去注释之后"的代码上匹配的，不是空转');
});

test('★ ⑪ 那份"对拍"必须两头都钉（正确性 + 宽夹具），别退回只看收敛', () => {
    const src = read('scripts/smoke/tree-ops-incremental.smoke.mjs');
    assert.match(src, /const seeded = fullAutoUpdate\(d\)/, '初算要接住返回值');
    assert.match(src, /（前提）整树初算确实写了东西/, '而且断言它非 0（恒 0 的 no-op 会让六条对拍一起空转）');
    assert.match(src, /makeWideDraft/, '要有宽夹具（只在 7 节点小树上收敛，证明不了什么）');
    // 反向锚：不许把"数读了几格"那种不可靠判据写回来（试过，分不开，理由写在文件里）
    assert.doesNotMatch(src, /countWalks/, '别用"读了几格"当判据（容器汇总是 O(子树)，实测同量级）');
});

test('★ ⑨ 全局统计栏是**延迟一拍**的（那两串数不是交互反馈，别卡住"点一下"）', () => {
    const statsSrc = codeOnly(read('src/view/stats.js'));
    assert.match(statsSrc, /const STATS_DEFER_MS = \d+/, '延迟时长要写成常量');
    // ⚠️ 取值也要看住：`\d+` 匹配不上"200000"这种"名义上延迟、实际等于同步"
    const deferMs = Number(/const STATS_DEFER_MS = (\d+)/.exec(statsSrc)[1]);
    assert.ok(deferMs >= 50 && deferMs <= 1000,
        `延迟时长要在 50~1000ms 之间（现在 ${deferMs}）—— 太短等于同步、太长统计栏会明显滞后`);
    assert.match(statsSrc, /export function getGlobalStatsSoon\(state, paint\)/, '要有"先给旧的、过一拍再算准"的入口');
    // ⚠️ 首屏那条是**已定口径**（`stats-defer.smoke.mjs`：启动第一屏必须给算准的那串，不许占位）——
    //   我 2026-10-18 试过把它也改成延迟，被那条冒烟当场打回，已还原。这里钉住"别再改回去"。
    assert.match(statsSrc, /if \(!lastStats\) return statCompute\(state, key\);/,
        '启动第一屏仍要同步算一次（首屏数字必须是真的）');
    assert.match(statsSrc, /statsTimer = setTimeout\(statsFlush, STATS_DEFER_MS\)/, '重算要排在延迟队列里且**只有一个**定时器（连点只算一次）');

    const folder = codeOnly(read('src/ui/folder/folderMode.js'));
    assert.match(folder, /getGlobalStatsSoon\(state, paintStatsNumbers\)/, '树/文件夹根两条渲染路径都要走它');
    assert.match(codeOnly(read('src/ui/folder/folderShared.js')), /export function paintStatsNumbers\(/,
        '到点只刷那两串数字（别重画整块/整棵树）');
    // 反向锚：**渲染/信息栏**两条路上都不许再出现同步的 `getGlobalStats(state)`
    //（`view/info.js` 里同样不许出现同步调用）
    assert.doesNotMatch(folder, /getGlobalStats\(state\)/, '渲染里别再同步算全局统计');
    assert.doesNotMatch(codeOnly(read('src/view/info.js')), /getGlobalStats\(state\)/,
        '信息栏里也别同步调全局统计（要画那两串数走 `paintStatsNumbers`）');
});

// ================================================================
// 诊断日志的开关（2026-10-18，用户："诊断日志加全局开关或控制台消息优先级"）
//
// 来由：排查那几轮往热路径上撒了 7 处 `console.info`（`[事务]` / `[切页]` / `[切页·事务]` /
// `[树布局]` / `[副页·段]` / `[副页渲染]` / `[计划栏]`），每处各自一个开关（有的认
// `options.timing`、有的认 `localStorage.DSH_TX_TIMING`、有的干脆裸打）⇒ 控制台里
// 平时一直有行在刷。现在**只剩一个开关**（`utils/diag.js`），默认关。
// 这条守卫防两件事：① 又有人裸打 `console.info`（开关失效）；② 开关被改成"默认开"。
// ================================================================
// ================================================================
// 按页分槽的记忆表（2026-10-18，用户："你的记忆化怎么是共用槽位的？"）
//
// 病根：副页那三份缓存（统计 / 树 HTML / 计划栏那份进度）原来都是"只留最近一份"（模块级 `let`
// 或 `Map` 先 `clear()` 再 `set()`）⇒ 数据没变时同一页连画两次能命中，但**在两个副页之间
// 来回切（A→B→A）就每次全落空**；而单价是 39ms / 198ms / 31ms 那个量级。
// 现在三处共用一个实现（`utils/memoSlots.js`），这里钉它的两条语义。
// ================================================================
test('★ ⑬ 分槽记忆表：每页一个**独立**槽（键 = 页 id）、删掉的页由 `prune` 收', async () => {
    const { createSlots } = await import('../utils/memoSlots.js');
    const slots = createSlots();
    // 五"页"（键是**页 id 字符串** —— 折叠会换页对象，但 id 不变）
    for (const id of ['a', 'b', 'c', 'd', 'e']) slots.set(id, id.toUpperCase());
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
        assert.equal(slots.get(id), id.toUpperCase(),
            `第 ${id} 页那一格要独立留着（别的页塞进来不许把它挤掉）`);
    }
    assert.equal(slots.size(), 5, '槽数 = 页数（不设上限 ⇒ 不存在"被挤掉"这件事）');
    slots.set('c', 'C2');
    assert.equal(slots.get('c'), 'C2', '同一页新结果覆盖这一页自己的格');
    assert.equal(slots.get('a'), 'A', '覆盖别的页不影响这一页');
    // ★ 回收：删掉的页由 `prune(活着的 id 集合)` 顺手丢掉（"为什么不收？？"那条的答案）
    assert.equal(slots.prune(['a', 'b', 'c']), 2, '`prune` 要报出丢了几个');
    assert.equal(slots.get('d'), undefined, '已删的页那一格要没了');
    assert.equal(slots.get('a'), 'A', '还活着的页不许被误删');
    assert.equal(slots.get('a'), 'A');
    assert.equal(slots.get('nope'), undefined, '没有的键取到 undefined（别抛）');
    // ⚠️ 键必须是页 id：用页对象当键会在**折叠**时全部作废（`expanded` 存在 vNode 上，折一下就换页对象）
    const src = codeOnly(read('src/utils/memoSlots.js'));
    assert.doesNotMatch(src, /new WeakMap\(\)/, '槽表键是页 id 字符串（不是 WeakMap/页对象）');
    for (const rel of ['src/view/stats.js', 'src/ui/plan/planBar.js']) {
        const src2 = codeOnly(read(rel));
        assert.match(src2, /createSlots\(\)/, `${rel} 要用每页一格的表`);
        assert.doesNotMatch(src2, /Slots\.(get|set)\(\s*page\s*[,)]/,
            `${rel} 的槽键必须是 \`page.id\`（用页对象 ⇒ 折叠一次全作废）`);
    }
    assert.match(codeOnly(read('src/view/stats.js')), /virtualStatsSlots\.get\(page\.id\)/,
        '副页统计的槽要按页 id 取');
    assert.match(codeOnly(read('src/ui/plan/planBar.js')), /planBarSlots\.get\(page\.id\)/,
        '计划栏那份进度同样按页 id 分槽');
});

test('★ ⑭ 副页容器行那几串数字走缓存 + 后台烘热（别再每次现算整棵子树）', () => {
    // 病根（2026-10-18 实测）：副页每个 C/W/S 行渲染时都现算自己子树的 C 桶 / P 桶 / 📊分布
    // ⇒ 36ms/行、10 行 360ms；主树那几串走 `countPassOf`（一趟算好、按代缓存）。
    // 修法：按 `(page, 数据代, vNode)` 缓存 + 刷新/切页后**切片烘热**（用户："可以延迟"）。
    const src = codeOnly(read('src/view/stats.js'));
    assert.match(src, /export function virtualBucketText\(/, '要有按 vNode 取那几串的入口');
    assert.match(src, /export function scheduleVirtualWarmup\(/, '要有"后台烘热"的入口');
    assert.match(src, /const WARM_BUDGET_MS = \d+/, '切片预算要写成常量（便于调/便于看）');
    const budget = Number(/const WARM_BUDGET_MS = (\d+)/.exec(src)[1]);
    assert.ok(budget > 0 && budget <= 20,
        `每片预算要在 1~20ms（现在 ${budget}）—— 太大就等于把卡顿搬到了烘热里`);
    // 四个读口对**虚拟节点**必须走缓存（走回现算 = 360ms 又回来了）
    for (const name of ['getCProblemSummary', 'getCStatusDistribution', 'getWSMatchSummary', 'getWSProblemSummary']) {
        const body = new RegExp(`export function ${name}\\(state, node\\)[\\s\\S]*?\\n\\}`).exec(src);
        assert.ok(body, `找得到 ${name}（守卫别是空转）`);
        assert.match(body[0], /virtualBucketText\(state, node, '(c|p|dist)'\)/,
            `${name} 对虚拟节点要走 \`virtualBucketText\`（别每行现算子树）`);
    }
    // 烘热的触发点：刷新链（启动/切页/改数据都经过它）
    assert.match(codeOnly(read('src/ui/G_pageUI.js')), /scheduleVirtualWarmup\(AppState\)/,
        '`refreshCurrentPage` 里要排一次烘热（启动/刷新/切页都会走到）');
    // 渲染侧不得绕过它去直调那两个"现算"摘要（否则缓存等于没接上）
    assert.doesNotMatch(codeOnly(read('src/view/helpers.js')), /getWSProblemSummary\(/,
        '（自检）helpers.js 里本来就不该有它 —— 这条红了说明有人把摘要塞进了别处');
});

test('★ ⑮ 副页投影：**数据**按结构签名缓存，"看的姿势"（展开/页码/选中）走活取值器', () => {
    // 病根（2026-10-18，用户："副页的处理行为应与主页高度相似"）：投影把 vNode **递归**建成对象
    // （真包一页 5344 个 ⇒ 实测 ~18ms/趟）。若把 `expanded` 的**值**拷进投影，缓存就必须随折叠失效
    // （否则折叠看起来没反应）；若按页对象当键，那每次折叠都重建。
    // 修法：投影里那三格做成 getter（现读 `state.pages[pageId].virtualIndex[id]`）⇒ 投影可以按**结构签名**缓存，
    // 折叠立刻生效、且不用重建。判据：折叠一格 58–65ms → **6–7ms**（主页同一操作 3ms）。
    const src = codeOnly(read('src/view/dataAdapter.js'));
    assert.match(src, /function bindLiveViewFlags\(/, '要有"活取值器"这个口');
    for (const f of ['expanded', 'currentPage', 'selected']) {
        assert.match(src, new RegExp(`Object\\.defineProperty\\(obj, '${f}'`),
            `${f} 必须是活取值器（不许把值拷进投影对象）`);
    }
    assert.match(src, /VIRTUAL_TREE_MEMO\.get\(pageId\)/, '投影缓存按**页 id**取');
    assert.match(src, /hit\.sig === sig/, '键里要有结构签名');
    assert.doesNotMatch(src, /VIRTUAL_TREE_MEMO\.get\(page\)/,
        '别按页对象当键（折一下就换新页对象 ⇒ 白重建 18ms）');
    // 角标那份同理（`planSubtreeIntensityOf` 要扫一遍子树，实测 ~6ms/趟）
    assert.match(codeOnly(read('src/ui/plan/pageBadges.js')), /badgeMemo\.sig === sig/,
        '角标也要按结构签名记忆（折叠不该重算子树强度）');
});

test('★ ⑫ 诊断日志只有一个开关（`utils/diag.js`）：别处不许裸打 `console.info`，默认必须是关的', async () => {
    // ① 源码锚：全仓 `src/` 里只有 `utils/diag.js` 自己允许出现 `console.info`
    const files = [];
    const walk = (rel) => {
        for (const ent of fs.readdirSync(path.join(REPO, rel), { withFileTypes: true })) {
            const r = `${rel}/${ent.name}`;
            if (ent.isDirectory()) { if (r !== 'src/test') walk(r); }
            else if (ent.name.endsWith('.js')) files.push(r);
        }
    };
    walk('src');
    assert.ok(files.length > 100, `扫描得动（现在 ${files.length} 个文件）—— 路径错了别空转地绿`);
    const bad = files
        .filter((rel) => rel !== 'src/utils/diag.js')
        .filter((rel) => /console\.info\(/.test(codeOnly(read(rel))));
    assert.deepEqual(bad, [],
        '这些文件里有裸 `console.info` —— 诊断行一律走 `utils/diag.js:diag()`（控制台里不许再有开关管不住的行）');

    // ② 行为锚：默认一声不响；`localStorage.DSH_DIAG = '1'` 才打（正反各验一次）
    const realInfo = console.info;
    const realLs = Object.prototype.hasOwnProperty.call(globalThis, 'localStorage')
        ? globalThis.localStorage : undefined;
    const seen = [];
    console.info = (...args) => seen.push(args.join(' '));
    try {
        const off = await import('../utils/diag.js');
        assert.equal(off.diagOn(), false, '默认必须关着（没设 `DSH_DIAG`）');
        off.diag('树布局', '计划条 = 1ms（累计）');
        assert.equal(seen.length, 0, '关着的时候一行都不许打（连格式都不许拼）');

        // 打开：假 `localStorage` + 一份**新的模块实例**（`cached` 只读一次，所以得换实例）
        globalThis.localStorage = { getItem: (k) => (k === 'DSH_DIAG' ? '1' : null) };
        const on = await import('../utils/diag.js?on');
        assert.equal(on.diagOn(), true, '开关打开后要认得');
        on.diag('树布局', '计划条 = 3ms（累计）');
        on.diag('副页渲染', '冷（重建）', { page: 'p1' });
        assert.equal(seen.length, 2, '打开后要真的打出来');
        assert.equal(seen[0], '[树布局] 计划条 = 3ms（累计）', '标签 + 正文的形状');
        assert.match(seen[1], /^\[副页渲染\] 冷（重建）/);

        // 关掉（同一个 localStorage 语义）：又要不响
        globalThis.localStorage = { getItem: () => null };
        const off2 = await import('../utils/diag.js?off');
        assert.equal(off2.diagOn(), false);
        off2.diag('事务', 'produce = 1ms（累计）');
        assert.equal(seen.length, 2, '关掉之后不许再打');
    } finally {
        console.info = realInfo;
        if (realLs === undefined) delete globalThis.localStorage;
        else globalThis.localStorage = realLs;
    }
});
