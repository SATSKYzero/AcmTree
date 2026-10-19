// ================================================================
// HDU 页面「一键存源」（粘到浏览器控制台运行）—— **不用剪贴板**
//
// 为什么不是 navigator.clipboard：
//   它会报 `NotAllowedError: Document is not focused` ——
//   剪贴板 API 要求**文档获得焦点**，而你在 DevTools 控制台里点来点去时，
//   焦点通常在 DevTools 上，不在页面上。这不是你操作错了。
//
// 为什么可以绕开：
//   HDU 的题目/提交/比赛列表页都是**服务端渲染**的（表格直接在返回的 HTML 里），
//   所以在页面里 `fetch(location.href)` 拿到的就是同一份 HTML，
//   连剪贴板都不用碰。
//
// 它做的事：
//   1. 看当前网址，判断你在哪一页、属于哪场比赛
//   2. fetch 当前页 → 按规范名下载**源 HTML**
//   3. 打印"下一步该干什么"
//
// 命名（与流水线的唯一规则对齐）：
//   /contest/problems?cid=1231   → hdu_cid1231_problems_source.html
//   /contest/status?cid=1231     → hdu_cid1231_submits_source.html
//   /contests/contest_list.php   → hdu_contests_source.html
//   /contest/rank?cid=1231       → hdu_cid1231_rank.html（榜单，本身就是输入）
//
// 它**不**负责：
//   - 分页。Status 有多页 → 用 fetch-hdu-submit.js；Rank 40 页 → 用 fetch-hdu-rank.js。
//     本脚本只存"你当前看到的这一页"，所以在这两处要当心（会警告）。
//   - 解析。HTML → JSON 是 Python 那边的事，而且流水线会自动做。
//
// 用法：
//   1. 浏览器里打开要存的那一页（题目 / 提交 / 比赛列表 / 榜单）
//   2. F12 → Console → 整段粘贴 → 回车
//   3. 自动下载一个**名字已经规范**的文件
//   4. 丢进 acm-data/raw/Scaper/02 hdu/（哪个子目录都行），然后 `npm run crate:hdu`
//      —— 它会自动解析、算通过率、合成导入包（源 HTML 解析完会被删掉，
//         想留着加 --keep-source，即 `npm run crate:hdu:keep`）
//
// ⚠️ 只读页面，不改任何东西。
// ================================================================
(async () => {
  const log = (...a) => console.log('%c[HDU-save]', 'color:#2563eb;font-weight:600', ...a);
  const warn = (...a) => console.warn('%c[HDU-save]', 'color:#b45309;font-weight:600', ...a);

  const url = new URL(location.href);
  const path = url.pathname;
  const cid = url.searchParams.get('cid') || '';

  let name = '';
  let what = '';

  if (/\/contest\/problems/.test(path)) {
    if (!cid) { warn('网址里没有 cid= —— 请在该场比赛的 Problems 页上运行。'); return '没有 cid'; }
    name = `hdu_cid${cid}_problems_source.html`;
    what = '题目列表';
  } else if (/\/contest\/status/.test(path)) {
    if (!cid) { warn('网址里没有 cid= —— 请在该场比赛的 Status 页上运行。'); return '没有 cid'; }
    name = `hdu_cid${cid}_submits_source.html`;
    what = '提交记录（**只有当前这一页**）';
  } else if (/contest_list\.php/.test(path)) {
    name = 'hdu_contests_source.html';
    what = '比赛列表';
  } else if (/\/contest\/rank/.test(path)) {
    if (!cid) { warn('网址里没有 cid= —— 请在该场比赛的 Rank 页上运行。'); return '没有 cid'; }
    // 榜单本身就是流水线的输入（不用再解析），所以名去掉了 _source
    name = `hdu_cid${cid}_rank.html`;
    what = '榜单（**只有当前这一页**）';
  } else {
    warn(`不认识这一页：${path}`);
    warn('支持：/contest/problems、/contest/status、/contest/rank、/contests/contest_list.php');
    return '不支持的页面';
  }

  log(`当前页：${path}${cid ? '?cid=' + cid : ''}   保存为：${name}（${what}）`);

  // 榜单页分页（一页只有 50 队），整页另存会不完整 —— 提醒用专门的抓取脚本
  if (/\/contest\/rank/.test(path)) {
    warn('⚠️ 榜单分页，直接存这一页**不完整**。完整榜单请用 fetch-hdu-rank.js。');
    warn('   （本脚本仍会保存当前页，仅当你确实只想要这一页时用）');
  }

  let html;
  try {
    const res = await fetch(location.href, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
  } catch (e) {
    warn(`❌ 取页面失败：${e.message}`);
    return '取页面失败';
  }

  // 登录态失效的典型信号
  if (/Contest\s+Login/.test(html) && !/page-card-table/.test(html)) {
    warn('❌ 拿到的是登录页 —— 登录态失效，重新登录后再来。');
    return '未登录';
  }

  // 校验：这一页真的含需要的表吗？（避免存下一个空壳）
  const need = /\/contest\/problems|\/contest\/rank/.test(path)
    ? /page-card-table/ : /page-card-row|contest_list/;
  if (!need.test(html)) {
    warn('⚠️ 取到的 HTML 里没看到预期的表格 —— 可能这页是前端渲染的（HDU 一般是服务端渲染）。');
    warn('   那就退回老办法：Elements 面板右键 <html> → Copy → Copy outerHTML。');
  }

  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);

  log(`✅ 已下载 ${name}（${(html.length / 1024).toFixed(0)} KB）`);
  log('   下一步：丢进 acm-data/raw/Scaper/02 hdu/（哪个子目录都行），然后');
  log('   npm run crate:hdu          ← 自动解析 + 算通过率 + 合成导入包');
  log('   （源 HTML 解析完会被删掉；想留着用 npm run crate:hdu:keep）');
  return `已下载 ${name}`;
})()
