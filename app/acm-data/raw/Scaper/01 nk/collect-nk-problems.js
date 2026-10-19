// ================================================================
// 牛客（Nowcoder）题目页「就地取源」（粘到浏览器控制台运行）
//
// ⚠️ 为什么不是 fetch 版：
//   牛客的比赛页是 **SPA 客户端路由** —— 直接请求
//   `/acm/contest/133877` 只会拿到"加载中…"的空壳，
//   `/acm/contest/status?contestId=…` 更是 404。
//   所以**只能从已经渲染好的 DOM 里取**，不能像榜单那样打接口
//   （榜单有独立的 JSON 接口，所以那个 fetcher 是好用的）。
//
// 它做的事：
//   把当前页 DOM 里的「比赛名（h1）」+「题目表格」原样抠出来，
//   拼成一个**最小 HTML** 下载：nk_cid<ID>_problems_source.html
//
//   为什么下载 HTML 而不是 JSON：解析规则一旦写错就丢信息，
//   而 HTML 是原始证据，随时能用 Nowcoder_prob_scraper.py 重新解析
//   —— 与榜单/提交那两套保持同一个分工。
//
// 用法：
//   1. 浏览器里打开该场比赛的 **题目列表页**（能看到题号/标题/通过率）
//   2. F12 → Console → 整段粘贴 → 回车
//   3. 自动下载 nk_cid<ID>_problems_source.html
//   4. 把这个文件丢到 acm-data/raw/Scaper/01 nk/ 下（不用管放哪个子目录）
//   5. 在项目根目录跑 npm run crate:nk —— 解析成
//      nk_cid<ID>_problems.json + nk_cid<ID>_contest.json（写在源旁边），
//      再合成 acm-data/nodes/nk-multi-university.json（源 HTML 随后被删，见 _usage.md 2.4）
//
// ⚠️ 它只读页面，不改任何东西。
// ================================================================
(() => {
  const log = (...a) => console.log('%c[nk-prob]', 'color:#2563eb;font-weight:600', ...a);
  const warn = (...a) => console.warn('%c[nk-prob]', 'color:#b45309;font-weight:600', ...a);

  // ---------------- 1. 认比赛 ID ----------------
  const url = new URL(location.href);
  let contestId = url.searchParams.get('contestId')
    || url.searchParams.get('contest_id')
    || url.searchParams.get('id')
    || (location.href.match(/\/contest\/(\d+)/) || [])[1]
    || '';
  if (!contestId) {
    contestId = (prompt('没能从网址里认出比赛 ID，请输入（例如 133877）：') || '').trim();
  }
  if (!contestId) { warn('没有比赛 ID，已中止。'); return '需要比赛 ID'; }

  // ---------------- 2. 抠比赛名（h1） ----------------
  const h1 = document.querySelector('h1');
  const contestName = h1 ? h1.textContent.replace(/\s+/g, ' ').trim() : '';
  if (!h1) warn('页面上没有 <h1>，比赛名可能取不到（C 节点会退化成"比赛 <cid>"）');

  // ---------------- 3. 抠题目表格 ----------------
  // 判据：表格里必须有指向 /acm/contest/<cid>/<题号> 的链接
  const linkRe = new RegExp(`/acm/contest/${contestId}/[A-Za-z0-9]+`);
  const tables = [...document.querySelectorAll('table')];
  const table = tables.find(t => linkRe.test(t.innerHTML));

  if (!table) {
    warn('❌ 没找到题目表格。检查：是否在该场比赛的**题目列表**页、是否已经加载完成。');
    warn(`   当前页面上的表格数：${tables.length}`);
    tables.slice(0, 5).forEach((t, i) => {
      log(`   表 ${i}: class="${t.className}" 行数=${t.querySelectorAll('tbody tr').length}`);
    });
    return '没找到题目表格';
  }

  const rows = table.querySelectorAll('tbody tr');
  log(`比赛名：${contestName || '(未取到)'}`);
  log(`比赛 ID：${contestId}`);
  log(`题目表：${rows.length} 行`);

  if (rows.length === 0) {
    warn('题目表里没有行 —— 页面可能还没渲染完，稍等一秒再试。');
    return '表格为空';
  }

  // ---------------- 4. 拼最小 HTML 并下载 ----------------
  // 只保留 <h1> 与题目表：爬虫正是从这两处取数据（见 Nowcoder_prob_scraper.py）
  const out = [
    `<!-- nk-problems-source`,
    `     contestId=${contestId}`,
    `     contestName=${contestName || '(未取到)'}`,
    // 记下当前页的真实地址：适配器会把它挂到 C 节点的 link 上
    // （牛客的网址形态不止一种，别拿模板去猜）
    `     contestUrl=${location.href}`,
    `     rows=${rows.length}`,
    `     fetchedAt=${new Date().toISOString()}`,
    `     本文件由 collect-nk-problems.js 从**已渲染的 DOM** 抠出`,
    `     （牛客比赛页是 SPA，fetch 拿不到内容，所以只能就地取）`,
    `     解析：Nowcoder_prob_scraper.py`,
    `-->`,
    h1 ? h1.outerHTML : '',
    table.outerHTML
  ].join('\n');

  const name = `nk_cid${contestId}_problems_source.html`;
  const blob = new Blob([out], { type: 'text/html;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);

  log(`✅ 已下载 ${name}（${rows.length} 道题）`);
  log('   下一步：丢进 acm-data/raw/Scaper/01 nk/（哪个子目录都行），然后');
  log('   npm run crate:nk        ← 自动解析 + 算通过率 + 合成导入包');
  log('   （源文件解析完会被删掉；想留着用 npm run crate:nk:keep）');
  return `已下载 ${name}（${rows.length} 题）`;
})()
