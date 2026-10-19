// ================================================================
// 冒烟测试：日期范围控件**只有一份实现**（共用组件）
//            （scripts/smoke/date-range-picker.smoke.mjs）
//
// 用户 2026-10-13（v9.2.2）："在不影响功能的前提下最好实现一致,若模块复杂可以共用"。
// 这一组钉两件事：
//   ① **共用组件本身**（`ui/kit/dateRangePicker.js:buildDateRangePicker`）：六个下拉的 id / 选项 /
//      当前值那一项被选中 / 年→月→日的级联（含闰年）/ 两颗按钮的钩子；
//   ② **统计页接上了它**（`ui/stats/ac/dailyList.js:initTimeRangeControls`）：控件建在 `#tr-picker` 里、
//      **id 仍是 `tr-start-*` / `tr-end-*`**（所以 `renderTimeRangeACList` 读值那六行不用改）、
//      点「确定 / 重置」真的走 `Date` 三参构造把那一段算出来。
//
// ⚠️ 为什么用 `installDom([], { parseHtml: true })`：组件的选项是 `innerHTML` 写进去的。
//    桩**默认不解析** `innerHTML` ⇒ 那样连 `<option>` 都不存在（`children.length` 恒 0、`sel.value` 恒空），
//    断言会**空转地绿**。开了这个开关之后，`sel.children` 就是真的 option 元素、`sel.value` 也是选中项
//    （⚠️ 但 `innerHTML` 会被清空 ⇒ **读值一律用 `children.length` / `sel.value`，不要读 `innerHTML`**）。
//
// 运行：npm run test:smoke
// ================================================================
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDom, makeContainer } from './dom.mjs';
import { group, ok, eq, report } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = path.join(ROOT, 'src');
const mod = (rel) => `file://${path.join(SRC, rel).replace(/\\/g, '/')}`;

const body = installDom([], { parseHtml: true });
const app = makeContainer(body, 'app');
makeContainer(app, 'toast');
// 统计页那一格（`index.html: #time-range-controls` 里的容器）与列表容器
const pickerHost = makeContainer(app, 'tr-picker');
makeContainer(app, 'time-range-ac-list');

const { AppState } = await import(mod('shell/state.js'));
const { createInitialState } = await import(mod('core/model/state.js'));
const { buildDateRangePicker, readDateRange, daysInMonthOf } = await import(mod('ui/kit/dateRangePicker.js'));
const { initTimeRangeControls } = await import(mod('ui/stats/ac/dailyList.js'));

const sel = (id) => document.getElementById(id);
const optionCount = (id) => (sel(id) ? sel(id).children.length : 0);
const valueOf = (id) => (sel(id) ? sel(id).value : null);
const pad2 = (n) => String(n).padStart(2, '0');
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const DATE_IDS = ['tr-start-year', 'tr-start-month', 'tr-start-day',
    'tr-end-year', 'tr-end-month', 'tr-end-day'];
/** 改下拉 + 派发 change（与真实浏览器里用户操作同形） */
const fire = (id, v) => { sel(id).value = v; sel(id).dispatchEvent({ type: 'change' }); };

// ================================================================
group('共用组件本身：六个下拉 / 选项 / 当前值选中 / 级联');
// ================================================================
{
    const host = makeContainer(body, 'kit-picker-demo');
    const wrap = buildDateRangePicker({
        from: '2026.03.05', to: '2026.04.09',
        onApply() {}, onReset() {}
    });
    host.appendChild(wrap);
    for (const suffix of ['start-year', 'start-month', 'start-day', 'end-year', 'end-month', 'end-day']) {
        ok(!!sel(`plan-range-${suffix}`), `★ \`plan-range-${suffix}\` 建出来了`);
    }
    eq(valueOf('plan-range-start-year'), '2026', '起点年按 `from` 选中');
    eq(valueOf('plan-range-start-month'), '3', '起点月按 `from` 选中');
    eq(valueOf('plan-range-start-day'), '5', '起点日按 `from` 选中');
    eq(valueOf('plan-range-end-month'), '4', '终点月按 `to` 选中');
    eq(valueOf('plan-range-end-day'), '9', '终点日按 `to` 选中');
    eq(optionCount('plan-range-start-year'), 2026 - 2000 + 1, '年下拉 = 2000…今年');
    eq(optionCount('plan-range-start-month'), 12, '月下拉 = 1…12');
    eq(optionCount('plan-range-start-day'), 31, '3 月的日下拉 = 31 天');
    ok(!!wrap.querySelector('[data-plan-action="range-apply"]'), '★ 「确定」按钮带钩子');
    ok(!!wrap.querySelector('[data-plan-action="range-reset"]'), '★ 重置那颗带钩子');
    ok(typeof readDateRange('plan-range-start', 'plan-range-end') === 'object',
        '★ `readDateRange` 回来的是 `{from, to}`（按前缀找那六个 id）');

    // ★ 级联：改月 ⇒ 按当月天数重填"日"；改年 ⇒ 月归 1（并跟着重填"日"）
    // ⚠️ 用**写死的月份**当夹具（3 月 31 天、4 月 30 天）—— 别写"今年 2 月是几天"（它不是闰年）。
    fire('plan-range-start-month', '4');
    eq(optionCount('plan-range-start-day'), 30, '★ 改月 ⇒ "日"按当月天数重填（4 月 ⇒ 30 天）');
    fire('plan-range-start-month', '2');
    eq(optionCount('plan-range-start-day'), daysInMonthOf(2026, 2), '★ 2 月 ⇒ 按那一年的天数（2026 ⇒ 28 天）');
    fire('plan-range-start-year', '2026');
    eq(valueOf('plan-range-start-month'), '1', '★ 改年 ⇒ 月归 1');
    eq(optionCount('plan-range-start-day'), 31, '★ 并跟着按 1 月重填（31 天）');
    fire('plan-range-start-month', '2');
    eq(optionCount('plan-range-start-day'), 28, '★ 2 月 ⇒ 按那一年算（2026 不是闰年 ⇒ 28 天）');
    eq(daysInMonthOf(2028, 2), 29, '（对拍）`daysInMonthOf(2028, 2)` 就是 29');
}

// ⚠️ 闰年那一条要**单独拿一个组件**试：年下拉只到"今年"（`now`），2028 在未来就不在选项里了
//    ⇒ 传一个 2029 年的 `now`（年下拉变成 2029…2000），并且**换一套前缀**（别与上一组同 id）。
{
    const host = makeContainer(body, 'kit-picker-leap');
    const wrap = buildDateRangePicker({
        startPrefix: 'leap-start', endPrefix: 'leap-end',
        now: new Date(2029, 0, 1), from: '2029.01.01', to: '2029.01.01'
    });
    host.appendChild(wrap);
    const leap = (suffix) => sel(`leap-start-${suffix}`);
    ok(optionCount('leap-start-year') >= 30, '（前提）那个 `now=2029` 的组件年下拉够长');
    fire('leap-start-year', '2028');
    fire('leap-start-month', '2');
    eq(optionCount('leap-start-day'), 29, '★ 闰年 2 月 ⇒ 29 天（`daysInMonthOf` 算的，不是写死的）');
    fire('leap-start-year', '2030');
    fire('leap-start-month', '2');
    eq(optionCount('leap-start-day'), 28, '★ 平年 2 月 ⇒ 28 天');
    fire('leap-start-month', '4');
    eq(optionCount('leap-start-day'), 30, '★ 4 月 ⇒ 30 天');
    ok(!!leap('year') && !!leap('day'), '（前提）闰年那组的下拉找得到');
}

// ================================================================
group('统计页接上共用组件：控件在 `#tr-picker` 里、id 仍是 `tr-*`');
// ================================================================
{
    const base = createInitialState();
    for (const key of Object.keys(base)) AppState[key] = base[key];
    AppState.nodes = { root: { id: 'root', type: 'O', name: '根', values: {} } };
    AppState.childOrder = { root: [] };
    AppState.parentOf = {};
    AppState.rootId = 'root';
    initTimeRangeControls();

    eq(pickerHost.children.length, 1, '★ 控件由共用组件建在 `#tr-picker` 里（不再写死在 index.html）');
    for (const id of DATE_IDS) {
        ok(!!sel(id), `★ 六个下拉里 \`${id}\` 还在（id 没变 ⇒ 读值那六行不用改）`);
    }
    ok(pickerHost.querySelector('[data-range="start-year"]') === sel('tr-start-year'),
        '（前提）它确实是共用组件建的那一个（带 `data-range` 钩子）');
    ok(!!pickerHost.querySelector('[data-plan-action="range-apply"]'), '★ 「确定」按钮来自共用组件');
    ok(!!pickerHost.querySelector('[data-plan-action="range-reset"]'), '★ 那颗重置按钮也来自共用组件');
    initTimeRangeControls();
    eq(pickerHost.children.length, 1, '★ 再调一次不会重复建（幂等：已经建过就直接返回）');

    // 默认区间 = 今年 1 月 1 日 → 今天（与老实现一致）
    const now = new Date();
    eq(Number(valueOf('tr-start-year')), now.getFullYear(), '默认起点年 = 今年');
    eq(Number(valueOf('tr-start-month')), 1, '默认起点月 = 1（老实现就是"今年 1 月 1 日"）');
    eq(Number(valueOf('tr-start-day')), 1, '默认起点日 = 1');
    eq(Number(valueOf('tr-end-year')), now.getFullYear(), '默认终点年 = 今年');
    eq(Number(valueOf('tr-end-month')), now.getMonth() + 1, '默认终点月 = 本月');
    eq(Number(valueOf('tr-end-day')), now.getDate(), '默认终点日 = 今天');
    eq(optionCount('tr-start-year'), now.getFullYear() - 2000 + 1, '年下拉从 2000 到今年');
    eq(optionCount('tr-start-day'), 31, '日下拉按"今年 1 月"给 31 天');

    // ★ 点「确定」⇒ 走 `renderTimeRangeACList`：它把六个下拉读成 `new Date(y, m-1, d)` 那一段。
    //   这里钉"真的读了那六个下拉并算了一段"（起止各一个三参 `Date`）+ 值就是下拉当前的选中项。
    const seen = [];
    const realDate = globalThis.Date;
    globalThis.Date = new Proxy(realDate, {
        construct(t, args) {
            if (args.length === 3) seen.push(`${args[0]}-${args[1] + 1}-${args[2]}`);
            return new t(...args);
        }
    });
    pickerHost.querySelector('[data-plan-action="range-apply"]').click();
    await tick();
    ok(seen.length >= 2, '★ 点「确定」⇒ 真的按六个下拉算了一段（起止各一个 `Date`）');
    eq(seen[0], `${now.getFullYear()}-1-1`, '起点 = 下拉当前值（今年 1 月 1 日）');
    eq(seen[1], `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`, '终点 = 下拉当前值（今天）');

    // 「重置」⇒ 回到"今年 1 月 1 日 → 今天"（老 `#tr-reset-btn` 的行为）
    seen.length = 0;
    fire('tr-start-month', '5');
    fire('tr-end-month', '6');
    pickerHost.querySelector('[data-plan-action="range-reset"]').click();
    await tick();
    eq(Number(valueOf('tr-start-month')), 1, '★ 重置 ⇒ 起点月回到 1');
    eq(Number(valueOf('tr-start-day')), 1, '★ 重置 ⇒ 起点日回到 1');
    eq(Number(valueOf('tr-end-month')), now.getMonth() + 1, '★ 重置 ⇒ 终点月回到本月');
    eq(Number(valueOf('tr-end-day')), now.getDate(), '★ 重置 ⇒ 终点日回到今天');
    ok(seen.length >= 2, '★ 重置之后也**重新筛了一次**（不是只摆了下拉）');
    eq(seen[seen.length - 2], `${now.getFullYear()}-1-1`, '重置后的起点 = 1 月 1 日');
    eq(seen[seen.length - 1], `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`, '重置后的终点 = 今天');
    globalThis.Date = realDate;
}

report();
