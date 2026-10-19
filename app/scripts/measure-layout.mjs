// ================================================================
// 真浏览器排版测量（scripts/measure-layout.mjs）—— **诊断，不进 CI**
//
// 为什么有这一份：DOM 桩**不做布局**（`docs/ui-conventions.md` 第 8 节），而"对不对齐"这种毛病
// 只有真浏览器量 `getBoundingClientRect` 才知道。以前这一类改动只能"改完让用户看截图"，
// 结果在「当前强度表」那一摊来回改了 8 版 —— 这个脚本就是那条**自证回路**。
//
// 跑法（需要能启动本地 Chrome ⇒ 沙箱里要用更高权限模式，见下）：
//   node scripts/measure-layout.mjs                 # 量「当前强度表」那一块
//   node scripts/measure-layout.mjs intensity       # 同上（显式写场景名）
//
// ⚠️ 前提：本机 dev-server 在 8321 上跑着（`启动AcmTree.bat`）。脚本**不改任何东西**，
//    它只：开 headless Chrome → 打开页面 → 用真模块画一块 → 量 → 打印。
// ⚠️ 沙箱边界：workspace-write 下 Chrome 启动即退出（已验证）；这一条要用
//    `danger-full-access` 跑（用户 2026-10-13 已批准）。**它不是 npm test 的一部分。**
//
// 它核什么（"做对的判据"，写成可执行的两条）：
//   ① 同一列里**所有档名的左端 x 相等**（档名左对齐）；
//   ② 同一列里**所有强度值的右端 x 相等**（值右端点对齐）；
//   ③ 同一列里**档名与值之间的间隙恒等**（对内那个固定空）；
//   ④ 列与列之间不重叠；⑤ 每一对是单行（不许逐字折行）。
// 任一不成立 ⇒ 打印 `✗ 判据不成立` 并以退出码 1 结束。
// ================================================================
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCENARIO = process.argv[2] || 'intensity';
const PAGE_URL = process.env.MEASURE_URL || 'http://127.0.0.1:8321/measure-probe.html';
const CHROME = process.env.CHROME_PATH || [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].find((p) => fs.existsSync(p));
const PORT = Number(process.env.MEASURE_PORT || 9341);

if (!CHROME) {
    console.error('找不到 Chrome/Edge（可用 CHROME_PATH 指定）');
    process.exit(2);
}

// 探针页（临时放工作区根，跑完就删）——它 import **真模块**、画**真元素**、量**真几何**
// ⚠️ import map 必须与 `index.html` 那份**同形**（`immer` 是裸包名，浏览器只认 import map）
// ⚠️ 画什么由 `SCENARIO_BODY` 给（两种场景共用这一份壳，别各写一份 import map / 初始 state）
const SCENARIO_BODY = {
    intensity: `
    vs.setPlanSectionView(AppState, 'probe', { intensity: { open: true } });
    const card = renderIntensityBlock(plan, { entries: [], periods: [] }, () => {});
    document.getElementById('app').appendChild(card);
    const cols = [...card.children].find((c) => c.querySelector && c.querySelector('[data-intensity-ratio]'));
    const colDivs = [...cols.children].filter((c) => c.querySelector && c.querySelector('[data-intensity-ratio]'));
    colDivs.forEach((colDiv, ci) => {
        for (const pair of [...colDiv.querySelectorAll('[data-intensity-ratio]')]) {
            const [lab, val] = [...pair.children];
            const lb = lab.getBoundingClientRect();
            const vb = val.getBoundingClientRect();
            rows.push({ col: ci, key: pair.dataset.intensityRatio, label: lab.textContent.trim(),
                value: val.textContent.trim(), labelLeft: round(lb.left), valueRight: round(vb.right),
                gap: round(vb.left - lb.right), labelTop: round(lb.top), labelHeight: round(lb.height) });
        }
    });
    out = { rows };`,
    // 「题目列表」那张表（与「每期完成情况」共用同一份行渲染）：量「强度」列对不对齐
    list: `
    const box = document.createElement('div');
    box.id = 'list-host';
    box.style.cssText = 'width:1100px;padding:12px;background:#fff;';
    document.getElementById('app').appendChild(box);
    AppState.nodes = Object.assign({}, AppState.nodes);
    const sample = [
        ['p1', 'G', 'Toll Gates on a Tight Schedule', '银牌+', 3, '2026.09.12 00:25:30', 8.6, false],
        ['p2', 'N', 'Red Sequence', '银牌+', 3, '2026.09.11 17:20:09', 8.1, false],
        ['p3', 'E', 'Efficient Express', '银牌', 0, '----.--.-- --:--', 6.4, false],
        ['p4', 'I', 'Inside Triangle', '银牌+', 3, '2026.03.04 15:56:43', 8.3, false],
        ['p5', 'M', 'Meeting for Meals', '银牌+', 3, '2026.03.04 14:26:41', 7.1, false],
        ['p6', 'K', 'K-Coverage', '银牌-', 3, '2026.03.04 13:54:28', 5.2, false],
        ['p7', 'J', 'Trajan Algorithm', '银牌', 3, '2026.02.13 19:38:40', 6.9, false],
        ['p8', 'E', 'Cyan White Tree', '银牌', 3, '2026.02.13 17:50:36', 6.4, false],
        ['p9', 'M', 'Many Convex Polygons', '银牌', 3, '2026.02.13 08:49:12', 6.2, false],
        ['p10', 'B', 'What, More Kangaroos?', '银牌-', 0, '----.--.-- --:--', 5.2, false],
        ['p11', 'A', 'No Difficulty Filled', '未填写', 3, '2026.02.12 10:00:00', 0, true],
        ['p12', 'C', 'Another One', '未填写', 3, '2026.02.12 09:00:00', 2.4, false]
    ];
    for (const [id, pid, name, level, s2, time, intensity, usedDefault] of sample) {
        AppState.nodes[id] = { id, type: 'P', problemId: pid, name, values: {} };
        box.appendChild(problemRow({ id, level, s2: s2 === 0 ? 'null' : s2, time, intensity, usedDefault }));
    }
    const head = box.firstChild ? null : null;
    box.insertBefore(problemHead(), box.firstChild);
    const headCols = [...box.children[0].children].map((c, i) => {
        const b = c.getBoundingClientRect();
        const kid = c.children && c.children[0] ? c.children[0].getBoundingClientRect() : null;
        return { i, text: (c.textContent || '').trim(), left: round(b.left), right: round(b.right),
            kidRight: kid ? round(kid.right) : null, css: String(c.style.cssText) };
    });
    const listRows = [];
    for (const r of [...box.children].slice(1)) {
        const cell = r.children[5];
        // ⚠️ 数字那格**永远是第 0 个孩子**（有说明时说明在第 1 个）—— 以前取"最后一个孩子"，
        //    在有说明的行上量到的是**说明**，于是把结论说反了（这里修掉）。
        const num = cell.children[0];
        const mark = cell.children.length > 1 ? cell.children[1] : null;
        const cb = cell.getBoundingClientRect();
        const nb = num.getBoundingClientRect();
        const mb = mark ? mark.getBoundingClientRect() : null;
        listRows.push({ id: r.dataset.planRow, numRight: round(nb.right), numText: (num.textContent || '').trim(),
            cellLeft: round(cb.left), cellRight: round(cb.right), cellWidth: round(cb.width),
            markText: mark ? (mark.textContent || '').trim() : '', markLeft: mb ? round(mb.left) : null,
            markWidth: mb ? round(mb.width) : null, numLeft: round(nb.left),
            contentWidth: round((mark ? mb.left : nb.left) < nb.left ? nb.right - (mb ? mb.left : nb.left) : nb.width) });
    }
    // ★ 2026-10-15（用户看着这张表："计划的每期完成题目列表 怎么文本忽上忽下"）：
    //   量**每一行、每一列的文字基线**——各列基线不一致 = 有的格被居中 / 行盒的 line-height 不同。
    //   ⚠️ 别拿"文字顶边"当判据：各格的 line-height 不一样（11px×1.2 与 ×1.6），顶边差 3px
    //      可能基线其实齐的 —— 那就成了**假判据**。这里用一个 0×0 的 inline-block 探针量真基线
    //      （它没有高度 ⇒ 它的 bottom 就在基线上，所以量它的 top 就是基线 y）。
    //   ⚠️ 这段是模板字符串里的代码：**不许出现反引号**（会当场截断模板）。
    const baselineOf = (elm) => {
        if (!elm) return null;
        const p = document.createElement('span');
        p.style.cssText = 'display:inline-block;width:0;height:0;';
        elm.appendChild(p);
        const b = p.getBoundingClientRect();
        const y = round(b.top);
        elm.removeChild(p);
        return y;
    };
    const rowTops = [...box.children].map((r, ri) => {
        // 每一列的"基线目标"：纯文本格直接在格上量；状态2 量它那颗文字（第 2 个孩子）；
        // 节点列量**身份键**与**面包屑里那句**（两处必须同一个基线）。
        const stCell = r.children[3];
        const nodeCell = r.children[6];
        const chip = nodeCell && nodeCell.querySelector ? nodeCell.querySelector('.node-entry-id') : null;
        const crumb = nodeCell && nodeCell.querySelector ? nodeCell.querySelector('.node-entry-crumb') : null;
        // ⚠️ 第 7 列要量**面包屑那一段**（正文那一路的字），不能量身份键 ——
        //    身份键是**等宽字体**（ui-monospace），同样行盒下它的基线天生比别人高/低 ~2px，
        //    拿它当判据会得出"这一列差 2px"的**假结论**（第一版就这么量的）。两个都打出来，眼见为实。
        const bases = [...r.children].map((c, i) => {
            if (i === 3) return baselineOf(stCell && stCell.children ? stCell.children[1] : c);
            if (i === 6) return baselineOf(crumb);
            return baselineOf(c);
        });
        const nums = bases.filter((t) => t !== null);
        return { row: ri, id: r.dataset.planRow || '(表头)', bases,
            chipBase: baselineOf(chip), crumbBase: baselineOf(crumb),
            entryH: round((nodeCell && nodeCell.querySelector('.node-entry')
                ? nodeCell.querySelector('.node-entry').getBoundingClientRect().height : 0)),
            height: round(r.getBoundingClientRect().height),
            spread: nums.length ? Math.max(...nums) - Math.min(...nums) : 0 };
    });
    out = { headCols, listRows, rowTops, boxWidth: round(box.getBoundingClientRect().width) };`
};

const PROBE_HTML_TEMPLATE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>measure</title>
<script type="importmap">{"imports":{"immer":"./src/vendor/immer.mjs"}}</script>
</head>
<body><div id="app"></div><pre id="out">pending</pre>
<script type="module">
try {
    const { AppState } = await import('/src/shell/state.js');
    const { createInitialState } = await import('/src/core/model/state.js');
    const vs = await import('/src/core/model/viewState.js');
    const { renderIntensityBlock, problemHead, problemRow } = await import('/src/ui/plan/planBlocks.js');
    const base = createInitialState();
    for (const k of Object.keys(base)) AppState[k] = base[k];
    AppState.nodes = { root: { id: 'root', type: 'O', name: '根', values: {} } };
    AppState.childOrder = { root: [] };
    AppState.parentOf = {};
    AppState.rootId = 'root';
    const plan = { id: 'probe', name: 'p', pageId: 'pp', start: '2026.10.13', end: '',
        goal: { mode: 'intensity', per: 'day', value: 3 }, statuses: [3, 4],
        intensitySource: 'xcpc', intensityTableId: '' };
    const round = (n) => Math.round(n * 100) / 100;
    const rows = [];
    let out = null;
    __SCENARIO_BODY__
    document.getElementById('out').textContent = 'RESULT ' + JSON.stringify(out);
} catch (e) {
    document.getElementById('out').textContent = 'ERROR ' + (e && e.stack || e);
}
</script></body></html>`;

if (!SCENARIO_BODY[SCENARIO]) {
    console.error(`未知场景：${SCENARIO}（可用：${Object.keys(SCENARIO_BODY).join(' / ')}）`);
    process.exit(2);
}
const probePath = path.join(process.cwd(), 'measure-probe.html');
fs.writeFileSync(probePath, PROBE_HTML_TEMPLATE.replace('__SCENARIO_BODY__', SCENARIO_BODY[SCENARIO]));

const profile = path.join(os.tmpdir(), 'acmtree-measure-' + Date.now());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ⚠️ `stdio: 'ignore'`：沙箱里"捕获子进程输出"会 EPERM（文档写明的边界），
//    结果全部走 CDP/WebSocket，用不着它的 stdout。
const child = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
    '--disable-dev-shm-usage', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'
], { stdio: 'ignore' });

async function findTarget() {
    for (let i = 0; i < 60; i++) {
        try {
            const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
            const page = list.find((t) => t.type === 'page');
            if (page) return page;
        } catch { /* 还没起来 */ }
        await sleep(250);
    }
    throw new Error('拿不到 CDP 目标（Chrome 没起来？）');
}

function connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && pending.has(msg.id)) {
            const { resolve, reject } = pending.get(msg.id);
            pending.delete(msg.id);
            if (msg.error) reject(new Error(JSON.stringify(msg.error)));
            else resolve(msg.result);
        }
    });
    const ready = new Promise((resolve) => ws.addEventListener('open', resolve));
    const send = (method, params = {}) => new Promise((resolve, reject) => {
        const myId = ++id;
        pending.set(myId, { resolve, reject });
        ws.send(JSON.stringify({ id: myId, method, params }));
    });
    return { send, ready, close: () => ws.close() };
}

/** 判据 → 逐列核对（列 = 三张表的"点列"） */
function check(rows) {
    const problems = [];
    const byCol = [...new Set(rows.map((r) => r.col))].sort((a, b) => a - b);
    const summary = [];
    for (const c of byCol) {
        const rs = rows.filter((r) => r.col === c);
        const labels = [...new Set(rs.map((r) => r.labelLeft))].sort((a, b) => a - b);
        const values = [...new Set(rs.map((r) => r.valueRight))].sort((a, b) => a - b);
        const gaps = [...new Set(rs.map((r) => r.gap))].sort((a, b) => a - b);
        const heights = [...new Set(rs.map((r) => r.labelHeight))].sort((a, b) => a - b);
        const tops = [...new Set(rs.map((r) => r.labelTop))].sort((a, b) => a - b);
        if (labels.length !== 1) problems.push(`第 ${c + 1} 列：档名左端有 ${labels.length} 种（${labels.join(' / ')}）`);
        if (values.length !== 1) problems.push(`第 ${c + 1} 列：值右端有 ${values.length} 种（${values.join(' / ')}）`);
        if (gaps.length !== 1) problems.push(`第 ${c + 1} 列：档名与值的间隙有 ${gaps.length} 种（${gaps.join(' / ')}）`);
        if (heights.length !== 1) problems.push(`第 ${c + 1} 列：某一对折行了（档名高度 ${heights.join(' / ')}）`);
        if (tops.length !== rs.length) problems.push(`第 ${c + 1} 列：${rs.length} 条却有 ${tops.length} 个行高（有两条挤在一行？）`);
        summary.push({ col: c + 1, n: rs.length, labelLeft: labels, valueRight: values, gap: gaps,
            labelHeight: heights, topCount: tops.length });
    }
    // 列与列不重叠
    const spans = summary.map((s) => {
        const rs = rows.filter((r) => r.col === s.col - 1);
        return { col: s.col, left: Math.min(...rs.map((r) => r.labelLeft)), right: Math.max(...rs.map((r) => r.valueRight)) };
    }).sort((a, b) => a.left - b.left);
    for (let i = 1; i < spans.length; i++) {
        if (spans[i].left < spans[i - 1].right) {
            problems.push(`第 ${spans[i - 1].col} 列与第 ${spans[i].col} 列重叠（${spans[i - 1].right} > ${spans[i].left}）`);
        }
    }
    return { problems, summary, spans };
}

/** 判据（「题目列表」）：强度那一列的数字右端**一条竖线**、数字不越界、说明文字不越界 */
function checkList({ headCols, listRows, rowTops, boxWidth }) {
    const problems = [];
    const rights = [...new Set(listRows.map((r) => r.numRight))].sort((a, b) => a - b);
    if (rights.length !== 1) {
        problems.push(`「强度」列数字右端有 ${rights.length} 种（${rights.join(' / ')}）`
            + ' ⇒ ' + listRows.filter((r) => r.numRight !== rights[0]).map((r) => `${r.numText}@${r.numRight}`).join(' '));
    }
    for (const r of listRows) {
        if (r.numRight > r.cellRight + 0.5) problems.push(`「${r.numText}」越出格子右边界（${r.numRight} > ${r.cellRight}）`);
        if (r.markLeft !== null && r.markLeft < r.cellLeft - 0.5) {
            problems.push(`「${r.numText}」的说明文字越出格子左边界（${r.markLeft} < ${r.cellLeft}）`);
        }
    }
    const iCol = headCols.find((c) => c.text === '强度');
    console.log(`容器宽 ${boxWidth}px · 表头列：${headCols.map((c) => `${c.text}[${c.left}~${c.right}]`).join(' ')}`);
    // ★ 每一**数据行**里各列**文字基线**必须一致（±1px）—— "文本忽上忽下"就是这里不成立。
    //   ⚠️ 表头那一行不在这条判据里：它的「强度」格是 grid（基线目标是里面那一格，不是格本身），
    //      量它会得出 13px 的假差（第一版就是这么假红了一次）。
    for (const rt of (rowTops || [])) {
        if (rt.id === '(表头)') continue;
        if (rt.spread > 1) {
            problems.push(`第 ${rt.row} 行（${rt.id}）各列基线差 ${rt.spread}px（${rt.bases.join(' / ')}）`
                + ' ⇒ 有一列被居中、别的列贴顶');
        }
    }
    const spreads = [...new Set((rowTops || []).filter((r) => r.id !== '(表头)').map((r) => r.spread))].sort((a, b) => a - b);
    console.log(`各行「各列文字基线之差」：${spreads.join(' / ')}px（0~1 才算各列对齐）`);
    for (const rt of (rowTops || []).slice(0, 3)) {
        console.log(`  第 ${rt.row} 行（${rt.id}）行高 ${rt.height}px · 入口条高 ${rt.entryH}px`
            + ` · 各列基线 ${rt.bases.join(' / ')}`
            + ` · 节点列：身份键基线 ${rt.chipBase} / 面包屑基线 ${rt.crumbBase}`);
    }
    const hc = headCols.find((c) => c.text === '强度');
    console.log(`表头「强度」细节：容器 ${hc && hc.left}~${hc && hc.right} · 里面那格右端 ${hc && hc.kidRight}`
        + ` · css「${hc && hc.css}」`);
    console.log(`「强度」列（表头 ${iCol ? `${iCol.left}~${iCol.right}` : '?'}）各行数字右端：`
        + listRows.map((r) => `${r.numText}=${r.numRight}`).join(' '));
    // ★ 第 27 轮：表头「强度」这四个字也要落在数字上方（右对齐）。
    //   ⚠️ 要比的是**表头里那一格**（`kidRight`）—— 表头**容器**当然占满整列（876），
    //   拿容器比会永远判"不成立"（我第一次就比错了）。
    if (hc && hc.kidRight !== null) {
        const numRight = listRows[0].numRight;
        if (Math.abs(hc.kidRight - numRight) > 1) {
            problems.push(`表头「强度」里那一格右端 ${hc.kidRight} 与数字右端 ${numRight} 不相等 ⇒ 标题没压在数字上方`);
        }
    }
    return { problems };
}

try {
    const target = await findTarget();
    const conn = connect(target.webSocketDebuggerUrl);
    await conn.ready;
    await conn.send('Page.enable');
    await conn.send('Page.navigate', { url: PAGE_URL });
    await sleep(2500);

    const out = await conn.send('Runtime.evaluate', {
        expression: `document.getElementById('out').textContent`, returnByValue: true
    });
    const text = String((out.result && out.result.value) || '');
    if (text.startsWith('ERROR')) throw new Error(text);
    if (!text.startsWith('RESULT')) throw new Error('探针页没出结果：' + text.slice(0, 200));
    const data = JSON.parse(text.slice('RESULT '.length));

    if (SCENARIO === 'list') {
        const { problems } = checkList(data);
        if (!data.listRows.length) throw new Error('没量到任何行');
        if (problems.length) {
            console.log('\n✗ 判据不成立：');
            for (const p of problems) console.log('  · ' + p);
            process.exitCode = 1;
        } else {
            console.log('\n✓ 判据成立：「强度」列的数字右端一条竖线、数字与说明都不越界');
        }
        conn.close();
        throw { __done: true };   // 走 finally 收尾，不再往下跑 intensity 那一段
    }

    const { rows } = data;
    if (!rows || !rows.length) throw new Error('没量到任何控制点（页面没画出来？）');

    const { problems, summary, spans } = check(rows);
    console.log(`量到的控制点：${rows.length} 条`);
    for (const s of summary) {
        console.log(`  第 ${s.col} 列（${s.n} 条）：档名左端 ${s.labelLeft.join(',')}px`
            + ` · 值右端 ${s.valueRight.join(',')}px · 对内间隙 ${s.gap.join(',')}px`
            + ` · 档名高 ${s.labelHeight.join(',')}px · 占 ${s.topCount} 行`);
    }
    console.log(`  列跨度：${spans.map((s) => `第${s.col}列 ${s.left}~${s.right}`).join(' | ')}`);
    if (problems.length) {
        console.log('\n✗ 判据不成立：');
        for (const p of problems) console.log('  · ' + p);
        process.exitCode = 1;
    } else {
        console.log('\n✓ 判据成立：档名左端一条竖线 · 值右端一条竖线 · 对内间隙恒定 · 列不重叠 · 无折行');
    }
    conn.close();
} catch (e) {
    if (e && e.__done) {
        // 场景自己已经出过结论（走 finally 收尾即可）
    } else {
        console.error('测量失败：' + (e && e.message || e));
        process.exitCode = 2;
    }
} finally {
    child.kill();
    await sleep(300);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(probePath, { force: true }); } catch { /* ignore */ }
}
