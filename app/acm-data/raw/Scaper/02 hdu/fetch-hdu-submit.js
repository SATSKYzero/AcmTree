// ================================================================
// HDU 提交记录全量抓取（粘到浏览器控制台运行）
//
// 为什么需要它：
//   HDU 的 Status 页是**服务端渲染 + 分页**的，一页就几十条。
//   手动一页页复制粘贴再拼起来，既费事又容易漏页/重页。
//   在**你已登录的浏览器**里按页 fetch，就不会有这些问题。
//
// 和其他脚本的分工（和 fetch-hdu-rank.js 一致）：
//   本脚本只负责"把 N 页搬到本地" → 输出**原始 HTML**（不解析）。
//   解析交给 Hdu_submit_scraper.py —— 页面结构日后变了，HTML 还在，
//   随时能重新解析；反过来 JSON 一旦解析错就丢信息。
//
// 它做的事：
//   1. 以**你当前地址栏的 URL** 为基准（去掉 page 参数）——
//      这样你在页面上选的筛选（用户 / 结果 / 题号…）会被原样保留
//   2. 先探 page=2，用它确定分页基准（见下）
//   3. 顺推抓完；按**运行ID 去重**，空表即到末尾
//   4. 把有内容的页用 "<!-- PAGE n -->" 分隔拼成一个 HTML 下载
//
// 分页基准（**实测确认**，cid=1230）：
//   /contest/status?cid=1230                  ← 第 1 页
//   /contest/status?cid=1230&status=&page=1   ← 也是第 1 页
//   /contest/status?cid=1230&status=&page=2   ← 第 2 页
//   ⇒ page 是 1 基，"不带 page"就等于 page=1。
//   之所以还要"探"而不是写死：脚本对 0 基的站点（以及哪天改版）也得能用。
//   ⚠️ 从 [1, 0, 2, 3…] 顺序试的话，在 page=1/page=0 两次"没新记录"后
//      就触发了"连续两页无新增 = 结束"，**根本没走到 page=2**。
//
// 用法：
//   1. 浏览器里打开该场比赛的 **Status 页**（确保已登录、能看到记录）
//      需要筛选就先设好筛选条件
//   2. F12 → Console → 整段粘贴 → 回车
//   3. 等进度跑完，会自动下载 hdu_cid<ID>_submit.html
//   4. 放到 acm-data/raw/Scaper/02 hdu/ 下（哪个子目录都行，名字自带身份），然后跑：
//        python "acm-data/raw/Scaper/02 hdu/Hdu_submit_scraper.py" -i <那个文件>
//      （不加 -o 时，它会写成同目录的 hdu_cid<ID>_submits.json）
// ================================================================
(async () => {
  // ---------------- 可调参数 ----------------
  const MAX_PAGE = 60;      // 最多试到第几页（到末尾会自动停）
  const DELAY_MS = 400;     // 每页之间的间隔，别把服务器打疼
  // -----------------------------------------

  const log = (...a) => console.log('%c[HDU-Status]', 'color:#2563eb;font-weight:600', ...a);
  const warn = (...a) => console.warn('%c[HDU-Status]', 'color:#b45309;font-weight:600', ...a);
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ---------------- 1. 以当前 URL 为基准 ----------------
  if (!/\/contest\/status/.test(location.pathname)) {
    warn(`当前页面不是 Status 页（${location.pathname}）。请先打开该场比赛的 Status 页再运行。`);
    return '不在 Status 页';
  }
  const m = location.search.match(/[?&]cid=(\d+)/);
  if (!m) {
    warn('地址栏里没有 cid= —— 请在 Status 页（带 ?cid=…）上运行。');
    return '没有 cid';
  }
  const CID = m[1];

  const base = new URL(location.href);
  base.searchParams.delete('page');           // 基准不带 page
  const plainUrl = base.pathname + base.search;
  const urlFor = (p) => {
    const u = new URL(base.toString());
    u.searchParams.set('page', String(p));
    return u.pathname + u.search;
  };

  log(`cid=${CID}`);
  log(`基准 URL：${plainUrl}`);
  log('（页面上已有的筛选会原样保留；想只抓自己就先去页面上筛好）');

  // ---------------- 2. 取一页并抽出表格 ----------------
  function extract(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const rows = doc.querySelectorAll('tr.page-card-row');
    const ids = [];
    for (const tr of rows) {
      const td = tr.querySelector('td');
      const rid = td ? td.textContent.trim() : '';
      if (rid) ids.push(rid);
    }
    const table = doc.querySelector('table.page-card-table');
    return { ids, tableHtml: table ? table.outerHTML : '' };
  }

  async function fetchPage(url) {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    // 登录态失效的典型信号
    if (/\/contest\/login/.test(res.url) || (/Contest\s+Login/.test(html) && !/page-card-row/.test(html))) {
      throw new Error('LOGIN');
    }
    return extract(html);
  }

  const seen = new Set();
  const parts = [];
  let pagesWithRows = 0;

  function take(page, ids, tableHtml) {
    const fresh = ids.filter(id => !seen.has(id));
    if (fresh.length === 0) return 0;
    for (const id of ids) seen.add(id);
    pagesWithRows++;
    parts.push(`<!-- PAGE ${page} -->\n${tableHtml}`);
    return fresh.length;
  }

  // ---------------- 3. 先抓"基准页"（不带 page）----------------
  let first;
  try {
    first = await fetchPage(plainUrl);
  } catch (e) {
    if (e.message === 'LOGIN') {
      warn('❌ 返回的是登录页 —— 登录态失效。重新登录后再跑。');
      return '未登录';
    }
    warn(`❌ 请求基准页失败：${e.message}`);
    return '基准页失败';
  }
  const firstFresh = take('base', first.ids, first.tableHtml);
  log(`基准页：${first.ids.length} 条（新增 ${firstFresh}，累计 ${seen.size}）`);
  if (first.ids.length === 0) {
    warn('基准页没有提交记录。检查：是否在该场比赛的 Status 页、筛选条件是否把记录滤掉了。');
    return '基准页没有记录';
  }
  await sleep(DELAY_MS);

  // ---------------- 4. 先确定分页基准，再逐页抓 ----------------
  // 实测（真实 URL，cid=1230）：
  //   /contest/status?cid=1230                   ← 第 1 页
  //   /contest/status?cid=1230&status=&page=1    ← 也是第 1 页
  //   /contest/status?cid=1230&status=&page=2    ← 第 2 页
  //   ⇒ **page 是 1 基**，且"不带 page"就等于 page=1。
  //
  // ⚠️ 从 [1, 0, 2, 3…] 试的话，page=1/page=0 两次"没新记录"后
  //    就停了（连续两页无新增 = 结束），**根本没走到 page=2**。
  //    所以改成**先探 2**，用它来区分三种情况：
  //      page=2 有新记录   → 1 基，后面从 3 开始
  //      page=2 全是重复   → 分页参数被忽略（真有问题，要吵）
  //      page=2 空表       → 确实只有一页（正常，不用吵）
  //    再补探 page=1（0 基站点的情况），最后才轮到大循环。
  let nextPage = null;
  {
    const probes = [2, 1, 0];
    for (const p of probes) {
      let got;
      try {
        got = await fetchPage(urlFor(p));
      } catch (e) {
        if (e.message === 'LOGIN') {
          warn('❌ 登录态失效，停止。已抓到的部分仍会下载。');
          break;
        }
        warn(`探测 page=${p} 请求失败：${e.message}`);
        await sleep(DELAY_MS);
        continue;
      }
      const fresh = take(p, got.ids, got.tableHtml);
      log(`探测 page=${p}：本页 ${got.ids.length} 条，新增 ${fresh}`);
      if (fresh > 0) {
        nextPage = p + 1;
        log(`➡️ 分页基准确定：${p + 1 === 2 ? '1 基（page=1 就是首页）' : '0 基'}`
            + `，接着从 page=${nextPage} 顺推`);
        break;
      }
      // page=2 空表 ⇒ 到末尾了，没有第 2 页
      if (p === 2 && got.ids.length === 0) {
        log('page=2 是空表 → 这场比赛确实只有这一页');
        break;
      }
      // page=2 有行但全是重复 ⇒ 参数没生效，这是真问题
      if (p === 2 && got.ids.length > 0) {
        warn(`⚠️ page=2 返回的 ${got.ids.length} 条与第 1 页完全相同 → `
             + '分页参数似乎没生效，可能只会抓到第一页。');
      }
      await sleep(DELAY_MS);
    }
  }

  // ---------------- 5. 顺推抓完 ----------------
  if (nextPage !== null) {
    let missStreak = 0;
    for (let p = nextPage; p < MAX_PAGE; p++) {
      if (missStreak >= 2) break;
      let got;
      try {
        got = await fetchPage(urlFor(p));
      } catch (e) {
        if (e.message === 'LOGIN') {
          warn('❌ 登录态失效，停止。已抓到的部分仍会下载。');
          break;
        }
        warn(`page=${p} 请求失败：${e.message} —— 跳过`);
        await sleep(DELAY_MS);
        continue;
      }

      if (got.ids.length === 0) {
        log(`page=${p} 空表 → 到末尾了，停止`);
        break;
      }
      const fresh = take(p, got.ids, got.tableHtml);
      if (fresh > 0) {
        missStreak = 0;
        log(`page=${p} ✓ 新增 ${fresh} 条（累计 ${seen.size}）`);
      } else {
        missStreak++;
        log(`page=${p} 没有新记录（${missStreak}/2，本页 ${got.ids.length} 条都与已有重复）`);
      }
      await sleep(DELAY_MS);
    }
  }

  // ---------------- 6. 完整性提醒 + 下载 ----------------
  // HDU Status 页**不显示总数**，没有可对照的基准，所以只能给可疑信号。
  log(`共收到 ${seen.size} 条，来自 ${pagesWithRows} 个有内容的页`);
  const firstPageRows = first.ids.length;
  if (pagesWithRows === 1 && nextPage === null) {
    // 探测阶段没能确定基准：page=2 既没新记录也不是空表（或请求都失败了）
    warn('⚠️ 没能确认分页基准，只抓到第 1 页。');
    warn('   请在浏览器里手动点一次"下一页"，把地址栏那个 URL 发我。');
  } else if (pagesWithRows === 1 && firstPageRows >= 50) {
    warn(`⚠️ 只有 1 页有内容，而这页有 ${firstPageRows} 条（= 每页上限）——`);
    warn('   多半后面还有页，但 page=2 返回的是空表。把翻页时的 URL 发我。');
  }

  const out = [
    `<!-- hdu-submit-bundle`,
    `     cid=${CID}`,
    `     base=${plainUrl}`,
    `     pages=${pagesWithRows}`,
    `     rows=${seen.size}`,
    `     fetchedAt=${new Date().toISOString()}`,
    `     本文件由 fetch-hdu-submit.js 生成；每页之间用 "<!-- PAGE n -->" 分隔`,
    `     解析：Hdu_submit_scraper.py（它按"运行ID"去重，重复页不会算两次）`,    `-->`,
    ...parts
  ].join('\n');

  const name = `hdu_cid${CID}_submit.html`;
  const blob = new Blob([out], { type: 'text/html;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);

  log(`✅ 已下载 ${name}`);
  log('   下一步：');
  log(`   python "acm-data/raw/Scaper/02 hdu/Hdu_submit_scraper.py" -i "acm-data/raw/Scaper/02 hdu/${name}"`);
  return `已下载 ${name}（${seen.size} 条 / ${pagesWithRows} 页）`;
})()
