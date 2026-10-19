// ================================================================
// 导入面板（features/AutoImport/ui/panel.js）
//
// 整个面板的编排（工具栏 → 包名行 → 失败明细 → 统计 →
// 执行条 → 问题 → 记录表 → 扩展键面板）。
// ⚠️ 它 `import { loadFiles, onExecute, replanBatches } from "../index.js"` —— **成环**。
// 在 ESM 里安全：两边都只在**函数体**里引用对方，顶层只做定义；入口那三个是函数声明（提升过）。
// ⚠️ **别在模块顶层用 index.js 的东西**（那时它可能还没求值完）。
// ================================================================
import { button, yieldToUI, showToast } from './kit.js';
import { makeProgress } from './progress.js';
import { renderSummary } from './summary.js';
import { renderRecordTable, resetRecordTableLimit } from './recordTable.js';
import { renderBatchTabs, renderExecuteBar } from './batchTabs.js';
import { renderImportFailures } from './failures.js';
import { buildLogBox, currentBuildBox, armOutsideClose } from './buildBox.js';
import { renderExtKeyPanel } from '../extKeyPanel.js';
import { probeBuildApi, startBuild, fetchBuildStatus, isBuildFinished,
         fetchPackageFile, API_VERSION, BUILD_MODES, DEFAULT_BUILD_MODE, stopBuild } from '../buildApi.js';
import { pickFiles } from '../files.js';
import { watchDirectory } from '../dirWatcher.js';
import { escapeHtml as esc } from '../../../utils/html.js';
// 悬停提示（`title`）也是给人看的字 ⇒ 统一去 Markdown 记号（实现只有一份）
import { plain } from '../../../utils/text.js';
// ⚠️ 成环（见头注）：入口提供执行/重算/读文件这三个动作
import { loadFiles, onExecute, replanBatches } from '../index.js';

export function renderPanel(container, v, { showToolbar = true } = {}) {
    if (!container) {
        console.error('[AutoImport] renderPanel 缺少容器（这是 bug，请反馈）');
        return;
    }
    if (!v) {
        console.error('[AutoImport] renderPanel 缺少视图状态（这是 bug，请反馈）');
        return;
    }

    /** 重绘自身（闭包捕获 container 与 v，避免到处传参漏掉） */
    const redraw = () => renderPanel(container, v, { showToolbar });

    /**
     * 当前选中的**重建档位**。
     *
     * 状态存进 `v.buildMode`（面板重画不丢）；认不出的值一律回落默认档
     * —— 服务器侧也会再判一次（`build_chain.mode_of`），两边都不认就按标准重建。
     */
    const buildMode = () => {
        const want = String(v.buildMode || '');
        return BUILD_MODES.some(m => m.key === want) ? want : DEFAULT_BUILD_MODE;
    };
    const modeLabelOf = (key) => (BUILD_MODES.find(m => m.key === key) || {}).label || key;

    /** 载入文件 → 解析 → 重绘（**带进度**：先拿到文件总数，再逐个推进，见 makeProgress） */
    const loadInto = async (files) => {
        const prog = makeProgress(wrap, wrap.querySelector ? wrap.querySelector('.ai-toolbar') : null);
        prog.set({ phase: '读取包文件', done: 0, total: files.length });
        try {
            // 文件夹视图：把"当前文件夹"作为默认父容器
            v.batches = await loadFiles(files, {
                forcedParentExtKey: v.forcedParentId || '',
                onProgress: (info) => prog.set(info)
            });
        } catch (err) {
            prog.el.dataset.phase = '失败';
            showToast(`载入失败：${err && err.message ? err.message : err}`, 'error');
            return;
        }
        v.selected = 0;
        // 「只看性质不一致」/「以包里为准」是**上一批**留下的状态 ⇒ 新载入的包从头看起
        //（「以包里为准」尤其重要：那是个**会改数据**的开关，绝不能跨批次悄悄留着）
        v.natureOnly = false;
        v.natureForce = false;
        // 记录表的「显示全部」同理：那是**上一批**按下的动作（那一批可能几万行），
        // 新包该从"只画前 N 行"重新开始 —— 否则换个包就自动铺满、当页直接卡住。
        resetRecordTableLimit();
        v.lastLoadedFiles = files.map(f => (f && f.name) ? f.name : '').filter(Boolean);
        v.lastProgress = {
            phase: prog.el.dataset.phase,
            done: Number(prog.el.dataset.done || 0),
            total: Number(prog.el.dataset.total || 0)
        };
        redraw();
    };

    container.innerHTML = '';

    const wrap = document.createElement('div');
    wrap.className = 'ai-panel';
    wrap.style.cssText = 'padding:14px 18px; overflow:auto; height:100%; box-sizing:border-box;';

    /**
     * **一键重建总包（并自动导入）** —— 工具栏上那个按钮。
     *
     * 流程：本机接口起一次 `npm run crate:all` → 轮询状态、把日志画出来 →
     * 成功后把产出的包取回来走**既有的导入通道**（`loadInto`）→
     * **计划里 0 错误才自动执行**（有错误就停在预览上，让人看）。
     *
     * ⚠️ 自动执行是既定行为，但"0 错误才自动"这道闸不动 —— 有错误自动写进去等于把
     *    带病的包灌进树里；那种情况留在预览页，人能逐条看。
     * ⚠️ 导入走的是既有 `onExecute`（一次事务、要么全成要么全回滚）与既有的字段策略，
     *    这里**不新开写路径**。
     */
    const runRebuildAndImport = async () => {
        const logBox = buildLogBox();
        logBox.reset();
        wrap.appendChild(logBox.el);          // 单例元素重新挂到当前面板上（见 `buildLogBox` 的说明）
        armOutsideClose();                    // 点框外任意处 ⇒ 关掉它
        const say = (t) => logBox.append(t);
        // 找本机那个"主脚本"：同源 → `127.0.0.1:<DEFAULT_PORT>` → `localhost:<DEFAULT_PORT>`
        // （`DEFAULT_PORT` = 8321，见 `core/localServer.js` 的 `defaultBases()`）。
        // 它自己会报身份，于是三种"看起来一样"的失败能分开说：
        //   ① 没在跑（都连不上）② 旧进程（接口版本低）③ 页面是旧代码（APP_BUILD 对不上）。
        const ping = await probeBuildApi();
        if (!ping.ok) {
            say(`❌ 用不上本机"主脚本"：${ping.error}`);
            for (const one of (ping.tried || [])) {
                say(`   · 试过 ${one.base || '页面同源'}：${one.error}`);
            }
            // 页面自己那个源上有服务器、但答不出 `/api/ping` ⇒ 大概率是**启动更早的旧进程**
            //（旧进程也发 no-store，所以只看页面看不出破绽），
            // 或者 `python -m http.server`。这两种都不是"没在跑"，措辞要说准。
            const sameOrigin = (ping.tried || []).find(t => !t.base);
            if (sameOrigin) {
                say('   ℹ️ 这个页面背后**有**服务器，但它不是主脚本（多半是启动更早的旧进程，'
                    + '或 `python -m http.server`）—— 所以它不认识 `/api/*`。');
            }
            say('   → 双击一次 `启动AcmTree.bat`：它会认出端口上那个旧 python 并**换掉它**'
                + '（已经在跑的就只开浏览器，不会起第二个）；然后刷新本页面再点。');
            say('     页面用别的静态服务器打开也行 —— 只要那个本机服务器在跑，这里就能连上。');
            showToast('本机主脚本没接管 —— 双击一次 启动AcmTree.bat', 'error');
            return;
        }
        say(`🔗 已连上 ${ping.base || '页面同源'}（pid ${ping.pid}，端口 ${ping.port}，`
            + `接口 v${ping.api}，源码 ${ping.srcSha}${ping.restarts ? `，已自重启 ${ping.restarts} 次` : ''}）`);
        if (ping.api < API_VERSION) {
            say(`❌ 服务器是**启动更早的旧进程**（接口 v${ping.api} < v${API_VERSION}）——`
                + ' 正常的服务器会自己重启；这个是更早的版本，关掉那个窗口重新双击 `启动AcmTree.bat`。');
            showToast('服务器是旧进程，重启一次 启动AcmTree.bat', 'error');
            return;
        }
        if (ping.stalePage) {
            // 这条专治"点了几次都没反应"：页面上跑的是旧模块，按钮背后是缓存的代码
            say(`❌ **这个页面是旧代码**（页面 ${ping.pageBuild} / 磁盘 ${ping.diskBuild}）——`
                + ' 按 **Ctrl+Shift+R** 刷新页面，再点一次这个按钮。');
            showToast('页面是旧代码 —— 先 Ctrl+Shift+R', 'error');
            return;
        }
        try {
            // 档位 = 一个完整预设：`offline`（轴 A：联不联网）与 `mode`（轴 B：补不补原料）
            // **一起定死**（`buildApi.BUILD_MODES`），页面不靠两个控件表达这两个轴。
            const preset = BUILD_MODES.find(m => m.key === buildMode()) || { offline: false, mode: '' };
            const { started } = await startBuild(undefined, undefined, !!preset.offline, preset.mode);
            logBox.running = true;          // 点下去就算“在跑”：这时切页回来要能看到进度
            syncStopBtn({ running: true });  // ★ 一开跑就把「⏸ 暂停」点亮

            say(started ? `▶ 已开始重建（处理链在本机主脚本进程内跑，档位：${modeLabelOf(buildMode())}）…`
                : '⚠️ 已经有一次重建在跑，跟着看它的日志。');
        } catch (err) {
            logBox.running = false;
            say(`❌ 起不来：${err && err.message ? err.message : err}`);
            showToast('重建没能启动（看下面的日志）', 'error');
            return;
        }
        // 轮询状态（1.2s 一次；日志每次整段重画，简单可靠）
        const timer = setInterval(async () => {
            let st = null;
            try {
                st = await fetchBuildStatus();
            } catch (err) {
                clearInterval(timer);
            logBox.running = false;
                say(`❌ 取状态失败：${err && err.message ? err.message : err}`);
                return;
            }
            if (st) logBox.render(st);
            syncStopBtn(st);                 // ★ 暂停按钮跟着状态走（在跑才可点；请求过就显示"正在停"）
            if (!isBuildFinished(st)) return;
            clearInterval(timer);
            if (st.code !== 0) {
            logBox.running = false;
                say(`❌ 重建失败（退出码 ${st.code}）—— 树里什么都没动，先看日志。`);
                showToast(`重建失败（退出码 ${st.code}）`, 'error');
                return;
            }
            // ★ 暂停结束（退出码 0、`stopped: true`）与"跑完"分开说 —— 否则用户按了暂停，
            //   却看到一模一样的「重建完成」，会以为没生效。
            say(st.stopped
                ? '⏸ 已按你的要求停下（产物停在最后跑完那一步，是可用的）。取包并载入预览 —— 导不导入你自己定。'
                : '✅ 重建完成，取包并导入…');
            let file = null;
            try {
                file = await fetchPackageFile();
            } catch (err) {
            logBox.running = false;
                say(`❌ 取包失败：${err && err.message ? err.message : err}`);
                return;
            }
            await loadInto([file]);
            const batch = v.batches[0];
            const plan = batch && batch.plan;
            if (!plan) {
                say(`❌ 预览失败：${(batch && batch.error) || '未知原因'}`);
                return;
            }
            // ⚠️ `plan.summary.errors` **就是** `plan.errors.length`（`plan.js` 同一个数）——
            //    以前这里两个相加，于是闸门把错误数**算了两遍**（"6 条"其实 3 条）。
            const bad = (plan.errors || []).length;
            if (bad > 0) {
                say(`⚠️ 预览里有 ${bad} 条错误 —— 请在下面逐条看（包已经准备好了）。`);
                showToast('预览有错误，先逐条看', 'error');
                return;
            }
            // ⚠️ **最后一步交给用户**：
            //    这里只把包**载入预览**（计划已经算好、错误为 0），**不自动写盘** ——
            //    由人去点下面那条「▶ 执行导入」。写盘是一次事务，值得让人按下那一下。
            logBox.running = false;
            say(`✅ 计划干净（新增 ${plan.summary.create} / 更新 ${plan.summary.update}`
                + ` / 跳过 ${plan.summary.skip}`
                + `${plan.summary.moved ? ` / 🔀 重挂 ${plan.summary.moved}` : ''}）`
                + ' —— 包已经载入预览，**请点下面的「▶ 执行导入」**'
                + `（不自动写盘了）。`);
            showToast('包已就绪 —— 点「执行导入」', 'success');
            const bar = wrap.querySelector ? wrap.querySelector('.ai-execute-bar') : null;
            if (bar && bar.scrollIntoView) bar.scrollIntoView({ block: 'center' });
        }, 1200);
    };

    // ---- 工具栏 ----
    if (showToolbar) {
        const toolbar = document.createElement('div');
        toolbar.className = 'ai-toolbar';
        toolbar.style.cssText = 'display:flex; align-items:center; gap:10px; flex-wrap:wrap; padding-bottom:10px; border-bottom:1px solid #eef2f6;';

        // 注意：这里必须闭包捕获 container —— 写成 onPickFiles() 不带参数的话，
        // 会导致 renderPanel(undefined) 抛 "Cannot set properties of undefined"。
        const pickBtn = button('选择导入文件…', () => onPickFiles(loadInto), true);
        pickBtn.className = 'ai-pick-btn';
        toolbar.appendChild(pickBtn);

        const dirBtn = button('📂 选择爬虫输出目录', () => onPickDirectory(loadInto));
        dirBtn.className = 'ai-dir-btn';
        dirBtn.title = plain('授权一次目录后，可定时发现新的导入包（浏览器无法后台运行）');
        toolbar.appendChild(dirBtn);

        // ★ 一键重建总包（+ 自动导入）—— 页面上直接触发建包，跑完自动导入。
        //   命令由**本机开发服务器**代跑（纯前端跑不了 npm/python），结果取回来走同一条导入通道。
        const buildBtn = button('🛠 重建总包并导入', () => runRebuildAndImport());
        buildBtn.className = 'ai-build-btn';
        // ⚠️ `title`（悬停提示）也是给人看的字 ⇒ 过 `plain()` 去 Markdown 记号（漏过一片）
        buildBtn.title = plain('在本机跑一次原料处理链（注册表 → 分类规则 → 产包 → 离线试跑），'
            + '完成后把 `acm-data/nodes/all_nodes.json` **自动导入**（0 错误才会自动执行）。\n'
            + '那条链跑在 启动AcmTree.bat 起的那个进程**里面**（不是 npm/node 子进程），'
            + '所以页面从别的端口打开也能用；大约 2~3 分钟，日志与每步进度显示在下面。');
        toolbar.appendChild(buildBtn);
        // ★ **暂停**。语义 = **跑完当前步就停** ——
        //   绝不在"产包/合并/回代"那几秒里掐断（那样可能留下半个包）；链子幂等，随时能重跑。
        //   所以点下去按钮先变「正在停…（跑完当前步）」，当前那一步（最长产包 ~19 秒）跑完才停。
        const stopBtn = button('⏸ 暂停', async () => {
            stopBtn.disabled = true;
            stopBtn.textContent = '正在停…（跑完当前步）';
            try {
                const { accepted } = await stopBuild();
                sayInBuildLog(accepted
                    ? '⏸ 已请求暂停：**当前这一步会跑完**（最长产包 ~19 秒），然后停下 —— 产物是可用的。'
                    : '⚠️ 当时没有在跑的重建（没什么可暂停的）。');
            } catch (err) {
                sayInBuildLog(`❌ 暂停请求失败：${err && err.message ? err.message : err}`);
                showToast('暂停请求失败（看下面的日志）', 'error');
                syncStopBtn({ running: true, stopRequested: false });   // 失败 ⇒ 按钮回到可点
            }
        });
        stopBtn.className = 'ai-build-stop';
        stopBtn.disabled = true;                         // 由 `syncStopBtn()` 按状态点亮
        stopBtn.title = plain('跑完**当前步**就停（绝不在写文件的中途掐断 —— 那样可能留下半个包）。\n'
            + '链子幂等：随时可以重跑，或直接导入这一步已经产出来的包。\n'
            + '暂停出来的退出码是 **0**（不是失败）。');
        toolbar.appendChild(stopBtn);
        syncStopBtn(lastBuildStatus);                    // 重画后按上一次状态初始化（在跑才点亮）

        // ★ **重建档位** ——
        //   页面只能传"一个布尔 + 一个写死的档位名"，档位对应命令行的一组开关。
        //   **离线不是旁边那个勾选框**，而是下拉框里的**一档** —— 因为重建有两个轴
        //     （轴 A 联网/离线跑产包、轴 B 要不要补抓原料），拆成"勾选框 + 档位"两个控件时
        //     描述怎么写都别扭（勾了离线再选补抓档其实是**非法组合**，只能靠服务器拒）。
        //     一个下拉框 = 一个完整预设（`{offline, mode}` 一起定死），状态存 `v.buildMode`。
        const modeWrap = document.createElement('label');
        modeWrap.className = 'ai-build-mode';
        modeWrap.style.cssText = 'font-size:12px; color:#475569; display:inline-flex;'
            + ' align-items:center; gap:4px; cursor:pointer; user-select:none;';
        modeWrap.appendChild(document.createTextNode('档位'));
        const modeSel = document.createElement('select');
        modeSel.className = 'ai-build-mode-sel';
        modeSel.style.cssText = 'font-size:12px; padding:2px 4px; border:1px solid #cbd5e1;'
            + ' border-radius:4px; background:#fff; color:#334155;';
        for (const one of BUILD_MODES) {
            const opt = document.createElement('option');
            opt.value = one.key;
            opt.textContent = one.label;
            modeSel.appendChild(opt);
        }
        modeSel.value = buildMode();
        // ⚠️ `hint` 是**构建侧写的散文**（`build_chain.py` 的 BUILD_MODES）⇒ 过 `plain`
        modeSel.title = plain(BUILD_MODES.map(m => `${m.label}：${m.hint}`).join('\n'));
        modeSel.addEventListener('change', () => {
            v.buildMode = modeSel.value;
            modeWrap.title = plain((BUILD_MODES.find(m => m.key === buildMode()) || {}).hint || '');
        });
        modeWrap.title = plain((BUILD_MODES.find(m => m.key === buildMode()) || {}).hint || '');
        modeWrap.appendChild(modeSel);
        toolbar.appendChild(modeWrap);


        if (v.batches.length > 0) {
            toolbar.appendChild(button('清空', () => {
                v.batches = [];
                v.selected = 0;
                redraw();
            }));
        }

        const tips = document.createElement('span');
        tips.style.cssText = 'font-size:12px; color:#94a3b8; margin-left:auto;';
        tips.textContent = '支持成熟 crate 与平台原生导出（如 qoj）；.json / .json.gz';
        toolbar.appendChild(tips);
        wrap.appendChild(toolbar);
    }

    // 重建日志面板（跑过一次就一直在）：**单例元素重新挂载** —— 切页/导入后的重画也不会把它丢掉
    // 已关掉（dismissed）就别再自动挂回来：口径是「点出去就关」，重画不该把它复活；
    // 没关过的话照旧挂回来 —— 自动导入会触发一次 redraw，那一下不能把日志/进度吃掉。
    // ⚠️ 那个"框"的状态现在住在 `./buildBox.js` 里（模块私有）⇒ 只能问 `currentBuildBox()`。
    const box = currentBuildBox();
    if (box && (!box.dismissed || box.running)) {
        wrap.appendChild(box.el);
        armOutsideClose();
    }

    // ---- 载入/导入的包文件名 ----
    if (v.batches.length > 0) {
        const filesLine = document.createElement('div');
        filesLine.className = 'ai-files';
        const names = v.batches.map(b => b.file).filter(Boolean);
        filesLine.dataset.files = names.join('|');
        filesLine.style.cssText = 'margin:8px 0 2px 0; font-size:12px; color:#334155;'
            + ' background:#f1f5f9; border-radius:4px; padding:6px 10px; word-break:break-all;';
        filesLine.innerHTML = `📦 <b>已载入 ${names.length} 份包</b>：${esc(names.join('、'))}`
            + (v.lastImport && v.lastImport.files && v.lastImport.files.length
                ? `　｜　✅ 上次导入：<b>${esc(v.lastImport.files.join('、'))}</b>`
                  + `（新增 ${v.lastImport.created}，更新 ${v.lastImport.updated}`
                  + `${v.lastImport.moved ? `，🔀 重挂 ${v.lastImport.moved}` : ''}`
                  + `${v.lastImport.failed ? `，失败 ${v.lastImport.failed}` : ''}）`
                : '');
        wrap.appendChild(filesLine);
        // 上次导入的失败明细（有才画；"失败 N" 后面总得有地方能点开看）
        renderImportFailures(wrap, v);
    }

    // ---- 无批次：空态 ----
    if (v.batches.length === 0) {
        // 未载入时也留一行占位，
        // 让人知道「这里会显示包名」，而不是整行不存在。
        const filesEmpty = document.createElement('div');
        filesEmpty.className = 'ai-files';
        filesEmpty.dataset.files = '';
        filesEmpty.style.cssText = 'margin:8px 0 2px 0; font-size:12px; color:#64748b;'
            + ' background:#f8fafc; border:1px dashed #e2e8f0; border-radius:4px; padding:6px 10px; word-break:break-all;';
        filesEmpty.innerHTML = '📦 <b>未载入包</b>'
            + (v.lastImport && v.lastImport.files && v.lastImport.files.length
                ? `　｜　✅ 上次导入：<b>${esc(v.lastImport.files.join('、'))}</b>`
                  + `（新增 ${v.lastImport.created}，更新 ${v.lastImport.updated}`
                  + `${v.lastImport.moved ? `，🔀 重挂 ${v.lastImport.moved}` : ''}`
                  + `${v.lastImport.failed ? `，失败 ${v.lastImport.failed}` : ''}）`
                : '');
        wrap.appendChild(filesEmpty);
        // 未载入包时也要能看上次导入的失败明细（否则"载入的包被清掉了"就等于线索没了）
        renderImportFailures(wrap, v);

        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.style.cssText = 'padding:50px 20px; text-align:center; color:#94a3b8;';
        empty.innerHTML = '<div style="font-size:40px; margin-bottom:12px; opacity:0.5;">📥</div>'
            + '<p>还没有载入导入包</p>'
            + '<p style="font-size:12px;">点上面的按钮选择文件；导入是<b>增量合并</b>，同一份包导两次不会重复。</p>';
        wrap.appendChild(empty);
        container.appendChild(wrap);
        return;
    }

    // ---- 批次切换 ----
    renderBatchTabs(wrap, v, redraw);

    const batch = v.batches[v.selected] || v.batches[0];

    // ---- 该批次解析失败 ----
    if (batch.error) {
        const err = document.createElement('div');
        err.className = 'ai-batch-error';
        err.style.cssText = 'padding:14px; background:#fef2f2; border:1px solid #fecaca; border-radius:6px; color:#b91c1c; font-size:13px;';
        err.innerHTML = `<b>${esc(batch.file)}</b><br>${esc(batch.error)}`;
        wrap.appendChild(err);
        container.appendChild(wrap);
        return;
    }

    const plan = batch.plan;
    renderSummary(wrap, plan, {
        // 解析阶段被逐条剔掉的（非法类型 / 缺身份键 …）—— 它们不在 plan 里，得单独带进来
        parseErrors: batch.parseErrors || [],
        // 「只看性质不一致」是**纯显示**筛选（不动计数、不动要写的内容），状态挂在视图上
        natureOnly: !!v.natureOnly,
        onToggleNatureOnly: () => { v.natureOnly = !v.natureOnly; redraw(); },
        // 「以包里为准」要**重算计划**（写哪些字段变了）—— 用留着的 crate 重算，不重读文件
        natureForce: !!v.natureForce,
        onToggleNatureForce: (on) => {
            v.natureForce = !!on;
            replanBatches(v.batches, v.natureForce);
            redraw();
        }
    });
    // 执行条紧挨统计栏正下方
    const toWrite = plan.summary.create + plan.summary.update;
    // 合成节点记录**不在** `plan.records` 里（它们没有 extKey，走两阶段通道），
    // 所以"可执行"的判定必须把两阶段的活儿算进来 —— 否则一份只带合成节点/指针的包
    // 会显示"没有需要写入的变更"、执行按钮点不动。
    const synthWrite = (plan.summary.synthNodes || 0) + (plan.summary.pointerSet || 0);
    // 包里带的**随包发布元数据**（体检报告 / 应有注册表）也**算有事可做** ——
    //   它们是在那笔事务里写进状态的 ⇒ 记录一条都不用写时（空包 / 全被拒的包）按钮也得能点，
    //   否则"导了包、体检页还说没带报告"（`apply.js` 的 `hasWork` 是同一套判据）。
    const crateMeta = !!(plan.crate && (plan.crate.reports
        || (plan.crate.fieldRegistry && plan.crate.fieldRegistry.fields)));
    const canExecute = plan.records.length > 0 || synthWrite > 0 || crateMeta;
    renderExecuteBar(wrap, {
        disabled: !canExecute,
        hint: (batch.file ? `包：${batch.file}　｜　` : '')
            + (!canExecute
                ? '没有需要写入的变更（已是最新）'
                : (toWrite + synthWrite > 0
                    ? `将写入 ${toWrite} 个节点`
                        + (plan.summary.synthNodes ? `、${plan.summary.synthNodes} 个合成节点` : '')
                        + (plan.summary.pointerSet ? `、${plan.summary.pointerSet} 条成员指针` : '')
                        + '（一次事务）'
                    : (crateMeta
                        ? '包里带了体检报告 / 应有注册表；这次没有记录要写，但会把它们写进应用数据'
                        : `没有字段变化；将登记 ${plan.summary.skip} 条记录的来源（不改任何字段）`))),
        onExecute: () => onExecute(container, v)
    });

    // ⚠️ 错误 / 警告**不再在这里单独渲染**：它们是"异常报告"的两栏，已经并进
    //    `renderSummary()`（统一模板：定序分段 / 每栏都在 / 默认折叠）——
    //    以前这里两块 + 统计栏里一串内联 note，三处各自为政（用户："理不清逻辑"）。

    renderRecordTable(wrap, plan, { natureOnly: !!v.natureOnly });

    // ---- **"没有字段要写" ≠ "什么都不用做"** ----
    // 来源层是**旁路**：`applyPlans` 对 skip 的记录只往 `node.values` 记
    // "这个来源说过什么"，一个缓存字段都不碰（导入策略仍是唯一写缓存字段的人）。
    // 所以 0 新增 / 0 更新**不等于**无事可做 —— 只要包里有记录，这次导入就该走一遍
    // 事务，把来源登记下来。
    // 按"待写入数 > 0"禁用执行按钮的后果：给已有节点补**第二个来源**
    // （同一个 extKey、同样的值，只是换了爬虫）时预览全是跳过，按钮直接点不了，
    // 于是 `applyPlans` 从来没被调用过 —— 来源层里永远只有第一次导入的那个来源。
    container.appendChild(wrap);
}

// ================================================================
// 交互
// ================================================================

/**
 * 同步「⏸ 暂停」按钮的可用状态（**唯一的写点**，别在别处手改 disabled）。
 *
 * 语义 = **跑完当前步就停**，所以只有"正在跑、且还没请求过暂停"才可点：
 *   - 在跑、没请求过 ⇒ 可点，文案「⏸ 暂停」
 *   - 已经请求过   ⇒ 不可点，文案「正在停…（跑完当前步）」
 *   - 没在跑       ⇒ 不可点，文案「⏸ 暂停」
 *
 * `st` 可能是局部状态 `{running:true}`（刚点下重建、状态还没回来），也可能是
 * 服务器的完整 status（含 `stopRequested`），两种都能吃。
 *
 * 为什么用 `querySelectorAll` 而不是拿一个按钮引用：面板会重画（重画后是**新**按钮），
 * 而且同一个页面上可能同时挂着两个 AutoImport 面板（插件页 + 标签页）。所以这里
 * **同步所有**暂停按钮，并记住最后一次状态 —— 工具栏新建时按它初始化，重画后
 * 不至于停在"永远不可点"上。纯装饰同步，面板里一个按钮都没有就直接返回。
 */
let lastBuildStatus = null;

/**
 * 往「重建日志框」里写一句。
 *
 * ⚠️ 工具栏上的「⏸ 暂停」不在 `runRebuildAndImport` 的作用域里（它在工具栏那一段建的），
 *    所以拿不到那里的 `say` —— 直接调 `say` 会 `ReferenceError: say is not defined`，
 *    而且这个错发生在 **async 回调里**，点按钮时也不崩页面，只是静默什么都不做。
 *    日志框是单例（`currentBuildBox()`），从这里写等价；没有框就退化成 toast。
 */
function sayInBuildLog(text) {
    const box = currentBuildBox();
    if (box && box.el && box.el.parentNode && typeof box.append === 'function') {
        box.append(text);
        return true;
    }
    showToast(String(text).replace(/\*\*/g, ''), 'info');
    return false;
}

function syncStopBtn(st) {
    if (st) lastBuildStatus = st;
    const btns = document.querySelectorAll('.ai-build-stop');
    if (!btns || !btns.length) return;
    const running = !!(lastBuildStatus && lastBuildStatus.running);
    const stopping = !!(lastBuildStatus && lastBuildStatus.stopRequested);
    for (const btn of btns) {
        btn.disabled = !running || stopping;
        btn.textContent = stopping ? '正在停…（跑完当前步）' : '⏸ 暂停';
    }
}

/**
 * 选择文件并载入
 * @param {Function} loadInto - (files) => Promise<void>，由 renderPanel 提供
 */

async function onPickFiles(loadInto) {
    const files = await pickFiles({ multiple: true });
    if (!files.length) return;
    await loadInto(files);
}

/**
 * 上次导入的**失败明细**。
 *
 * `applyPlans` 把 `perItem[].failures`（`{extKey|synthKey, code, reason}`）逐条收好，
 * 但**只把条数弹进 toast 就扔了**的话 —— 用户看到一个"失败 179"却无从下手（连控制台都没有）。
 * 这里把它显示出来：先按**原因码**分组给个概览，再逐条列 `标识 + 原因`（太多就截断），
 * 完整对象进控制台（`console.warn`）。判据与文案都照 `extKeyPanel.js` 的
 * 「⛔ [code] reason」来（同类的问题用同一套说法，别各写一种）。
 */

async function onPickDirectory(loadInto) {
    if (typeof window.showDirectoryPicker !== 'function') {
        showToast('当前浏览器不支持目录授权，请改用「选择导入文件」', 'info');
        return;
    }
    try {
        const handle = await window.showDirectoryPicker({ mode: 'read' });
        const found = await watchDirectory(handle, {
            onBatch: async (files) => {
                await loadInto(files);
                showToast(`发现 ${files.length} 个新的导入包，已载入待执行`, 'info');
            }
        });
        showToast(found === 0 ? '目录已授权，暂未发现导入包' : `目录已授权，发现 ${found} 个导入包`, 'success');
    } catch (err) {
        if (err && err.name === 'AbortError') return;
        showToast(`目录授权失败：${err && err.message ? err.message : err}`, 'error');
    }
}

// ================================================================
// 导入记录（settings.autoImport.history，决策 14 的落地）
// ================================================================
