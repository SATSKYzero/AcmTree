// ================================================================
// 冒烟测试：题目排序的**方向**（scripts/smoke/problem-sort.smoke.mjs）
//
// 为什么在冒烟而不是 `src/test/`：`handlers/H3_sort.js` 会牵出 `shell/state.js` → 裸包名 `immer`
// （浏览器靠 import map 解析）⇒ 单元测试那边起不来；本套件有 `immer-loader.mjs` 的映射。
//
// 要钉的事（2026-10-16，用户看图后指出）：那两档 XCPC 读的是 **`ratio`（过题比例）**，
// 而比例**越大 = 越容易** ⇒ 它与"难度"**反向**：
//   · 仓里的口径是"难度**低 → 高**（易 → 难）"（`utils/color.js:XCPC_ORDER`，
//     `src/ui/AGENTS.md`："难度顺序一律易 → 难"）；
//   · 所以 **「难度升序」= 易题在前 = 过题比例降序**；改前是 `byNum(true)`（比例升序 = 难在前）
//     ⇒ **方向反了**。同一版里 CF 那两档用真正的难度数值，本来就对。
// 判据：`cmp(a,b) < 0` 表示 a 排前面。
//
// 运行：npm run test:smoke
// ================================================================
import { installDom } from './dom.mjs';
import { ok, eq, report } from './harness.mjs';

installDom();                                  // `H3_sort.js` → shell/state.js 需要 DOM 桩

const { problemSorters } = await import('../../src/handlers/H3_sort.js');
const s = problemSorters();

ok(s['xcpc-asc'].cmp('50', '10') < 0,
    '★ 难度升序 = 易题在前（过题比例**大**的在前）',
    '改前是反的：比例升序 ⇒ 难题在前');
ok(s['xcpc-asc'].cmp('10', '50') > 0, '难度升序：比例的排后面');
ok(s['xcpc-desc'].cmp('10', '50') < 0, '难度降序 = 难题在前（过题比例**小**的在前）');
ok(s['cf-asc'].cmp(800, 2500) < 0, 'CF 那两档用难度数值，方向本来就对（别被上面那对带偏）');
ok(s['cf-desc'].cmp(2500, 800) < 0, 'CF 难度降序：数值大的（难）在前');
eq(s['xcpc-asc'].field, 'ratio', '读的还是显示那一列 `ratio`（不是派生的档）');
eq(s['xcpc-asc'].label, 'XCPC难度升序（过题比例降序）', '标签写明按哪个口径（防"升序"被读成比例升序）');
eq(s['xcpc-desc'].label, 'XCPC难度降序（过题比例升序）', '同上，降序那一档');

report('题目排序方向');
