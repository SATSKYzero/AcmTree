// ================================================================
// HDU 榜单全量抓取（粘到浏览器控制台运行）
//
// 为什么用这个而不是 CSV：
//   HDU 的 CSV 导出有 bug（字段会串在一起），没法用。
//   而榜单页是**服务端渲染**的（表格直接在 HTML 里），
//   所以在你**已登录的浏览器**里 fetch 各页，就能拿到完整数据。
//
// 它做的事：
//   按 page=0..N 逐页 fetch → 把每页 HTML 用分隔标记拼成一个文件 → 下载
//
// 为什么输出 HTML 而不是 JSON：
//   页面结构日后可能微调，HTML 是原始证据，随时能重新解析；
//   而 JSON 一旦解析规则写错就丢信息。解析交给 Python 那边做，
//   脚本只负责"把 23 页搬到本地"这一件事。
//
// 用法：
//   1. 先在浏览器打开该场比赛的 Rank 页（确保已登录、能看到榜单）
//   2. F12 → Console → 整段粘贴 → 回车
//   3. 等进度跑完，会自动下载 hdu_cid<ID>_rank.html
//   4. 放到 acm-data/raw/Scaper/02 hdu/ 下（**哪个子目录都行**，名字自带身份）
// ================================================================

(async () => {
  // ---------------- 可调参数 ----------------
  // ★ CID 自动从地址栏读 —— 你打开哪一场的 Rank 页，就抓哪一场，不用手改。
  const FALLBACK_CID = 1231;   // 地址栏里没有 ?cid= 时才用这个
  const MAX_PAGE = 40;         // 最多试到第几页（0-based；自动在空页停止）
  const DELAY_MS = 400;        // 每页之间的间隔，别把服务器打疼
  // -----------------------------------------

  const cidMatch = location.search.match(/[?&]cid=(\d+)/);
  const CID = cidMatch ? cidMatch[1] : String(FALLBACK_CID);
  const cidFromUrl = !!cidMatch;

  const log = (...a) => console.log('%c[HDU]', 'color:#2563eb;font-weight:600', ...a);
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // 取出该页里的榜单表格（服务端已渲染，直接在 HTML 文本里）
  function extractTable(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const table = doc.querySelector('table.page-card-table');
    return table ? table.outerHTML : '';
  }

  // 这一页有几支队（用 teamXXXX 计数）
  function countTeams(tableHtml) {
    return (tableHtml.match(/team\d{4}/g) || []).length;
  }

  log(`识别到 cid=${CID}`
      + (cidFromUrl ? '（来自地址栏 ✅）' : '（地址栏没有 cid=，用的默认值 ⚠️）'));
  log(`开始抓取，最多 ${MAX_PAGE} 页，间隔 ${DELAY_MS}ms`);
  log('（若中途弹登录页，说明登录态失效 —— 重新登录后再来）');

  const parts = [];
  let totalRows = 0;
  let emptyStreak = 0;

  for (let page = 0; page < MAX_PAGE; page++) {
    const url = `/contest/rank?cid=${CID}&page=${page}`;
    let html;
    try {
      const res = await fetch(url, { credentials: 'same-origin' });
      if (!res.ok) {
        log(`page=${page} HTTP ${res.status} —— 停止`);
        break;
      }
      html = await res.text();
    } catch (e) {
      log(`page=${page} 请求失败：${e.message} —— 停止`);
      break;
    }

    // 登录失效的典型信号
    if (/Contest\s+Login/.test(html) && !/page-card-table/.test(html)) {
      log(`page=${page} 返回的是登录页 —— 登录态失效，请重新登录后重跑`);
      break;
    }

    const table = extractTable(html);
    const n = table ? countTeams(table) : 0;

    if (!table || n === 0) {
      emptyStreak++;
      log(`page=${page} 空页（${emptyStreak}/2）`);
      if (emptyStreak >= 2) {
        log('连续两页为空 → 认为已到末尾，停止');
        break;
      }
    } else {
      emptyStreak = 0;
      totalRows += n;
      parts.push(`<!-- PAGE ${page} -->\n${table}`);
      log(`page=${page} ✓ 抓到 ${n} 行（累计 ${totalRows}）`);
    }

    await sleep(DELAY_MS);
  }

  if (parts.length === 0) {
    log('❌ 一页都没抓到。检查：地址栏 cid 是否正确、是否已登录、是否在该场比赛页面。');
    return '未抓到数据';
  }

  // ---- 拼成一个文件 ----
  const out = [
    `<!-- hdu-rank-bundle`,
    `     cid=${CID}`,
    `     pages=${parts.length}`,
    `     fetchedAt=${new Date().toISOString()}`,
    `     本文件由 scripts/fetch-hdu-rank.js 生成；每页之间用 "<!-- PAGE n -->" 分隔`,
    `-->`,
    ...parts
  ].join('\n');

  const name = `hdu_cid${CID}_rank.html`;
  const blob = new Blob([out], { type: 'text/html;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);

  log(`✅ 完成：${parts.length} 页 / 约 ${totalRows} 行 → 已下载 ${name}`);
  log('   把它放进 acm-data/raw/Scaper/02 hdu/，然后在项目根目录跑：');
  log('   npm run crate:hdu          # 它会自己认这份榜单并算出赛时通过率');
  return `已下载 ${name}（${parts.length} 页 / ${totalRows} 行）`;
})()
