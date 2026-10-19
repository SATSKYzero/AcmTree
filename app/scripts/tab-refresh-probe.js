// ================================================================
// Tab 渲染诊断（**在页面加载完成后**粘贴到控制台运行）
//
// 用于定位「在插件页（题目检索 / 节点自动导入）刷新后不渲染」。
//
// ⚠️ 用法要点（**先刷新，再粘贴** —— 反过来会踩坑）：
//   不要在刷新**前**粘贴带定时器的探针——刷新会把定时器打断，
//   而旧页面即将销毁时捕获的 DOM 快照是**不可信**的（会显示 null）。
//   正确做法：先刷新页面，等它稳定，**再**粘贴本文件并回车。
//
// 它只读，不改任何状态。
// ================================================================
(async () => {
  const out = {};
  const L = (...a) => { console.log('%c[AItab]', 'color:#2563eb;font-weight:600', ...a); return a; };
  const gcs = (el) => { try { return getComputedStyle(el).display; } catch { return '(取不到)'; } };

  // ---- 1. 元素层：容器到底在不在 ----
  const app = document.getElementById('app');
  const pane = document.getElementById('tab-auto-import');
  const bar = document.getElementById('tab-bar');

  out['#app 存在'] = !!app;
  out['#app 子元素数'] = app ? app.children.length : null;
  out['#app 的 id 列表'] = app ? Array.from(app.children).map(c => c.id || `(无id:${c.tagName})`) : null;
  out['#tab-auto-import 存在'] = !!pane;
  out['容器 计算后 display'] = pane ? gcs(pane) : null;
  out['容器 子元素数'] = pane ? pane.children.length : null;
  out['容器 innerHTML 长度'] = pane ? pane.innerHTML.length : null;
  out['有 .ai-panel'] = pane ? !!pane.querySelector('.ai-panel') : null;
  out['有「选择导入文件」按钮'] = pane ? !!pane.querySelector('.ai-pick-btn') : null;

  // ---- 2. 当前 DOM 里所有 .tab-content ----
  const panes = Array.from(document.querySelectorAll('.tab-content')).map(el => ({
    id: el.id,
    active: el.classList.contains('active'),
    display: gcs(el),
    children: el.children.length
  }));
  out['全部 .tab-content'] = panes;

  // ---- 3. 按钮层 ----
  const btns = bar ? Array.from(bar.querySelectorAll('.tab-btn')).map(b => ({
    tab: b.dataset.tab,
    plugin: b.dataset.pluginTab === '1',
    active: b.classList.contains('active')
  })) : [];
  out['全部 Tab 按钮'] = btns;

  // ---- 4. 状态层 ----
  try {
    const tabsMod = await import('/src/ui/tabs.js');
    const stateMod = await import('/src/shell/state.js');

    // ★★ 最省事的一条：入口挂的构建标记。
    //    I_app.js 启动时把它挂到 window 与 body[data-app-build]；
    //    **改任何核心行为都应递增**（src/A_constants.js 的 APP_BUILD）。
    out['★ 应用构建标记'] = window.__ACM_BUILD__ || '(未挂上 → 入口是旧版代码)';
    out['★ body[data-app-build]'] = document.body
      ? (document.body.dataset.appBuild || '(未设置)')
      : null;

    // ★★ 另一条：浏览器加载的 tabs.js 是不是**磁盘上的那一份**？
    //    两份不一致 ⇒ 跑的是缓存里的旧模块，与代码无关 —— 直接照末尾"还是旧版怎么办"处理。
    //    ⚠️ 这里**不写死期望值**：写死一个版本串，就等于要求每次递增 `TABS_BUILD` 时同步改本文件，
    //    必然腐烂 ⇒ 一直误报"这是旧版"。
    const loadedBuild = tabsMod.TABS_BUILD || '';
    out['★ tabs.js 构建标记（浏览器加载的）'] = loadedBuild || '(未导出 → 这是旧版代码)';
    try {
      const res = await fetch('/src/ui/tabs.js?probe=' + Date.now(), { cache: 'no-store' });
      const diskText = await res.text();
      const m = diskText.match(/export\s+const\s+TABS_BUILD\s*=\s*'([^']+)'/);
      out['★ tabs.js 构建标记（服务器磁盘上的）'] = m ? m[1] : '(读不到)';
      out['★ 两份一致'] = !!m && m[1] === loadedBuild;
    } catch (e) {
      out['读取磁盘版 tabs.js 失败'] = e.message;
    }

    out['AppState.currentTab'] = stateMod.AppState.currentTab;
    out['getCurrentTab()'] = tabsMod.getCurrentTab();
    out['isKnownTab(currentTab)'] = tabsMod.isKnownTab(tabsMod.getCurrentTab());
    out['已知 Tab 列表'] = tabsMod.getTabs().map(t => t.id + (t.isPlugin ? '(插件)' : '')).join(', ');

    // 直接调一次公共创建入口，看它能不能造出来
    const made = tabsMod.ensureTabContent('auto-import');
    out['手动 ensureTabContent 结果'] = made ? `成功，id=${made.id}` : '返回 null（创建失败）';
    out['手动调用后 #tab-auto-import 存在'] = !!document.getElementById('tab-auto-import');
  } catch (e) {
    out['读取状态失败'] = e.message;
  }

  L('诊断结果：', out);

  // ---- 5. 人话结论 ----
  console.log('%c[AItab] 结论', 'color:#16a34a;font-weight:600');

  console.log('  当前构建：' + (out['★ 应用构建标记'] || '(未知)'));
  if (!window.__ACM_BUILD__) {
    console.log('  🚨 入口 I_app.js 没挂构建标记 → 页面大概率跑的是旧版入口，'
      + '先按末尾「还是旧版怎么办」清缓存再看。');
  }

  const build = out['★ tabs.js 构建标记（浏览器加载的）'];
  if (out['★ 两份一致'] === false) {
    console.log('  🚨 首要问题：浏览器加载的 tabs.js 与服务器磁盘上的**不是同一份**（加载的 = '
      + build + '，磁盘的 = ' + out['★ tabs.js 构建标记（服务器磁盘上的）'] + '）。');
    console.log('     也就是说：**代码已经修好了，但你的浏览器没用上**。');
    console.log('     → 请按本文件末尾「还是旧版怎么办」处理，然后再看这个探针。');
  } else if (out['#tab-auto-import 存在']) {
    console.log('  ✅ 容器存在（新版代码已生效）。');
    if (out['有 .ai-panel'] === false) {
      console.log('     但内容是空的 → 挂载阶段的问题，把「全部 .tab-content」发我。');
    } else {
      console.log('     内容也在。若画面仍空白，是 CSS/布局问题，'
        + '请把「容器 计算后 display」发我。');
    }
  } else {
    console.log('  ❌ 新版代码已生效，但容器仍不存在 → 是真的代码缺陷。');
    console.log('     请把「#app 的 id 列表」「手动 ensureTabContent 结果」发我。');
  }

  return out;   // 返回值同样可在 [[PromiseResult]] 里展开
})()

// ================================================================
// 还是旧版怎么办
// ================================================================
//
// 说明浏览器把一个旧模块留在了缓存/内存里。按顺序试：
//
//   1. 关掉该站点的**所有**标签页（只刷当前那个往往不够——模块注册表
//      是按站点(realm)共享的），然后重新打开 http://127.0.0.1:8321/index.html
//
//   2. 确认服务器只有一个。关掉启动AcmTree.bat 起的那个最小化窗口，重新双击。
//      原因：Windows 的 SO_REUSEADDR 允许两个进程绑同一端口，旧的（不发
//      no-store）会抢答，于是你看到的可能一直是旧文件。
//
//   3. Ctrl+Shift+R（硬刷新）。
//
//   4. 最彻底：换端口重新起服务器，origin 变了，缓存与它无关：
//          python scripts/dev-server.py 8010
//      然后访问 http://localhost:8010/index.html
//
// 自检（不依赖浏览器）：直接在地址栏打开
//      http://127.0.0.1:8321/src/ui/tabs.js
// 搜 `TABS_BUILD`，拿它的值与探针输出的「服务器磁盘上的」那份对照。
// ================================================================
