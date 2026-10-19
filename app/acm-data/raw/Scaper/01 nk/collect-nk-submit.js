// ================================================================
// 牛客（Nowcoder）提交记录「就地取源」（粘到浏览器控制台运行）
//
// ⚠️ 为什么不是 fetch 版：
//   牛客的比赛页是 **SPA 客户端路由**：直接请求
//   `/acm/contest/status?contestId=…` 返回的是 404 页面，
//   题目页 `/acm/contest/<id>` 也只是一句"加载中…"。
//   所以提交记录**不能靠 fetch 拿**（榜单能，因为它有独立 JSON 接口）。
//
// 它做的事（在你已经打开的 Status 页上）：
//   1. 读当前页渲染好的提交表
//   2. **自动点「下一页」**并等表格真的换了，逐页收集（按 submissionId 去重）
//   3. 全收集完，拼成一个 HTML 下载：nk_cid<ID>_submit.html
//
//   输出仍是**原始 HTML**（多页用 `<!-- PAGE n -->` 分隔），解析交给
//   Nowcoder_submit_scraper.py —— 与其他几套保持同一分工。
//
// 用法：
//   1. 浏览器里打开该场比赛的 **Status（提交）页**（先登录；需要筛选就先筛好）
//   2. F12 → Console → 整段粘贴 → 回车
//   3. **别碰页面**，让它自己翻页（几十秒，取决于页数）
//   4. 自动下载 nk_cid<ID>_submit.html → 丢到 acm-data/raw/Scaper/01 nk/（哪层都行）
//   5. 项目根目录跑 npm run crate:nk —— 它会解析成 nk_cid<ID>_submits.json，
//      再合成 acm-data/nodes/nk-multi-university.json（解析完源 HTML 会被删掉，见 _usage.md 2.4）
//
// ⚠️ 只读页面 + 点它自己的翻页按钮，不改任何数据。
// ================================================================
(async () => {
  const log = (...a) => console.log('%c[nk-submit]', 'color:#2563eb;font-weight:600', ...a);
  const warn = (...a) => console.warn('%c[nk-submit]', 'color:#b45309;font-weight:600', ...a);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const MAX_PAGE = 60;

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
  log(`比赛 ID = ${contestId}`);

  // ---------------- 2. 读当前页的提交表 ----------------
  function readPage() {
    const tables = [...document.querySelectorAll('table.table-hover')]
      .filter(t => /view-submission\?submissionId=/.test(t.innerHTML));
    const ids = [];
    const htmls = [];
    for (const t of tables) {
      htmls.push(t.outerHTML);
      for (const a of t.querySelectorAll('a[href*="submissionId="]')) {
        const m = a.getAttribute('href').match(/submissionId=(\d+)/);
        if (m) ids.push(m[1]);
      }
    }
    return { ids: [...new Set(ids)], tables: htmls };
  }

  const firstId = () => {
    const r = readPage();
    return r.ids.length ? r.ids[0] : '';
  };

  const seen = new Set();
  const parts = [];
  let pagesWithRows = 0;

  function take(page, got) {
    const fresh = got.ids.filter(id => !seen.has(id));
    if (fresh.length === 0) return 0;
    for (const id of got.ids) seen.add(id);
    pagesWithRows++;
    parts.push(`<!-- PAGE ${page} -->\n${got.tables.join('\n')}`);
    return fresh.length;
  }

  const first = readPage();
  if (first.ids.length === 0) {
    warn('当前页没有提交记录。检查：是否在该场比赛的 Status 页、筛选条件是否滤空了。');
    warn('（如果页面还在"加载中"，等它渲染完再粘一次。）');
    return '没有记录';
  }
  take(0, first);
  log(`第 1 页：${first.ids.length} 条`);

  // ---------------- 3. 自动翻页 ----------------
  function nextButton() {
    // 牛客的分页器：<li class="txt-pager"><a href="javascript:void(0);">下一页</a></li>
    const li = [...document.querySelectorAll('.pagination li')]
      .find(el => el.textContent.replace(/\s+/g, '') === '下一页');
    if (!li) return null;
    if (li.classList.contains('disabled')) return null;
    return li.querySelector('a') || li;
  }

  let stuck = 0;
  for (let page = 1; page <= MAX_PAGE; page++) {
    const btn = nextButton();
    if (!btn) { log('「下一页」不可用 → 已到最后一页'); break; }

    const before = firstId();
    btn.click();

    // 等表格真的换页（SPA 是异步渲染，不能点完就读）
    let changed = false;
    for (let i = 0; i < 40; i++) {          // 最多等 40×150ms = 6s
      await sleep(150);
      const now = firstId();
      if (now && now !== before) { changed = true; break; }
    }

    if (!changed) {
      stuck++;
      warn(`点了「下一页」但表格没变（${stuck}/2）`);
      if (stuck >= 2) { warn('连续两次没变化，停止（可能到底了，也可能页面结构变了）'); break; }
      continue;
    }

    const fresh = take(page, readPage());
    log(`第 ${page + 1} 页：新增 ${fresh} 条（累计 ${seen.size}）`);
    await sleep(200);
  }

  // ---------------- 4. 下载 ----------------
  const pageSize = first.ids.length;
  if (pagesWithRows === 1 && pageSize >= 20) {
    warn(`⚠️ 只收到 1 页，而这页正好 ${pageSize} 条（= 每页上限）—— 多半还有后页。`);
    warn('   把分页器的 HTML（F12 选中 .pagination 右键 Copy outerHTML）发出来。');
  }
  log(`共收到 ${seen.size} 条，来自 ${pagesWithRows} 个有内容的页`);

  const out = [
    `<!-- nk-submit-bundle`,
    `     contestId=${contestId}`,
    `     pages=${pagesWithRows}`,
    `     rows=${seen.size}`,
    `     source=${location.href}`,
    `     fetchedAt=${new Date().toISOString()}`,
    `     本文件由 collect-nk-submit.js 从**已渲染的 DOM** 逐页抠出`,
    `     （牛客比赛页是 SPA，fetch 拿不到内容，所以只能就地取 + 点它自己的翻页）`,
    `     每页之间用 "<!-- PAGE n -->" 分隔；解析：Nowcoder_submit_scraper.py`,    `-->`,
    ...parts
  ].join('\n');

  const name = `nk_cid${contestId}_submit.html`;
  const blob = new Blob([out], { type: 'text/html;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);

  log(`✅ 已下载 ${name}`);
  log('   下一步：丢进 acm-data/raw/Scaper/01 nk/（哪个子目录都行），然后');
  log('   npm run crate:nk        ← 自动解析 + 算通过率 + 合成导入包');
  log('   （源文件解析完会被删掉；想留着用 npm run crate:nk:keep）');
  return `已下载 ${name}（${seen.size} 条 / ${pagesWithRows} 页）`;
})()
