// ================================================================
// 冒烟测试：重建日志框（scripts/smoke/build-box.smoke.mjs）
//
// 口径（用户 2026-10-16）："让建包的运行信息框可折叠，且**跑完不消失**"。
//
// 病根（原来的行为）：`onDocClickForClose` **不论在不在跑**，点框外任何地方都关掉它。
//   跑的时候还好（轮询触发面板重画会把它挂回来），**跑完就没有人再挂**了
//   ⇒ 随手点一下别处，刚跑完的日志**永久没了** —— 而用户要看的正是跑完的结果。
//
// 判据（三条）：
//   ① 「▾/▸」能把日志那一块收起来/展开，且**重画不会把用户选的状态冲掉**；
//      （收起来也留标题：状态/步骤/档位都在标题里 ⇒ 收着也能看结论）
//   ② **跑完**之后点框外 ⇒ 框**还在**（只剩 ✕ 与折叠两个显式动作）；
//   ③ 跑**的时候**点框外 ⇒ 照旧会关（老行为不丢 —— 那会儿重画会挂回来，且它不挡着用应用）。
//
// 运行：npm run test:smoke
// ================================================================
import { installDom } from './dom.mjs';
import { ok, eq, report } from './harness.mjs';

const body = installDom();
const { buildLogBox, armOutsideClose } = await import('../../src/features/AutoImport/ui/buildBox.js');

const box = buildLogBox();
body.appendChild(box.el);
box.reset();
box.append('第一行');
box.append('第二行');

const foldBtn = box.el.querySelector('.ai-build-fold');
const pre = box.el.querySelector('pre');
ok(!!foldBtn && foldBtn.className === 'ai-build-fold', '★ 日志框有「折叠」按钮');
eq(pre.style.display, '', '默认展开');
eq(foldBtn.textContent, '▾', '展开时图标是 ▾');

// ① 折叠 / 展开
foldBtn.click();
eq(pre.style.display, 'none', '★ 点一下 ⇒ 日志收起来（只留标题）');
eq(foldBtn.textContent, '▸', '收起来时图标是 ▸');
ok(/第一行/.test(pre.textContent), '收起来只是不显示 —— 日志内容还在 DOM 里（能选中/复制）');
box.render({ running: true, lines: ['x'], steps: [] });
eq(pre.style.display, 'none', '★ 轮询重画不会把用户的折叠状态冲掉');
foldBtn.click();
eq(pre.style.display, '', '再点 ⇒ 展开');

// ② 跑完：点框外**不**关（用户要看的正是这个）
box.render({ running: false, code: 0, lines: ['done'], steps: [] });
armOutsideClose();                                  // 就算那条监听还挂着
const outside = document.createElement('div');
body.appendChild(outside);
outside.click();
ok(box.el.parentNode === body, '★ 跑完点框外 ⇒ 日志框**还在**（不再一点就没）');
eq(box.dismissed, false, '也没被标成"关掉了"');
ok(/done/.test(pre.textContent), '刚跑完的日志仍然读得到');

// ③ 跑着的时候：点框外照旧关（老行为留住 —— 那会儿重画会挂回来）
box.render({ running: true, lines: ['running'], steps: [] });
armOutsideClose();
outside.click();
ok(box.dismissed === true && !box.el.parentNode, '跑着时点框外 ⇒ 关掉（进度那会儿会自己挂回来）');

report('重建日志框');
