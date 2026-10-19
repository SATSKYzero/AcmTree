// ================================================================
// 牛客（Nowcoder）榜单全量抓取（粘到浏览器控制台运行）
//
// 接口（脚本里已内置）：
//   GET /acm-heavy/acm/contest/real-time-rank-data
//       ?token=&id=<比赛ID>&limit=<条数>&pageSize=<每页>&page=<页码>&_=<时间戳>
//
// ---- 实测出来的三个坑（别再猜）----
// 1. `limit` 是**上限**（默认 50），超过就被钳回 50：
//       limit=0     → 用 pageSize（默认 50）
//       limit=3     → 只回 3 行；此时 basicInfo.rankCount 也变成 3（**不是总数**）
//       limit=2000  → 还是只回 50 行
//    ⇒ "总共有多少队"只能从 limit=0 且不传 pageSize 的那一次拿到。
// 2. `pageSize` **可设**（实测 pageSize=2&page=2 → 第 3、4 名，pageCount=822）。
//    ⇒ 因此**有机会一次装下全部**，本脚本会先试这个。
// 3. `limit=3&page=2` 会返回**空数组**，而 pageCurrent 还会回显 2 ——
//    看着像"page 被忽略"，其实是"结果集先被 limit 截成 3 条，第 2 页落在
//    3 条之外"。**判据要用行里的名次，不要用回显。**
//
// 它做的事：
//   1. 从当前网址认出比赛 ID
//   2. limit=0 探出真实总数 / 默认每页条数
//   3. 试一个大 pageSize 一次装下全部；不行就按 page 逐页抓（每页校验名次）
//   4. 拼成一个 JSON 下载：nk_cid<ID>_rank.json
//
// 用法：
//   1. 浏览器里打开该场比赛的 **Rank（榜单）** 页（确保已登录、能看到榜单）
//   2. F12 → Console → 整段粘贴 → 回车
//   3. 等进度跑完，会下载 nk_cid<ID>_rank.json
//   4. 放到 acm-data/raw/Scaper/01 nk/ 下，然后跑 npm run crate:nk
//
// ⚠️ 它只读，不改任何东西；请求都带着你当前的登录态（同源 + credentials）。
// ================================================================
(async () => {
  const log = (...a) => console.log('%c[nk-rank]', 'color:#2563eb;font-weight:600', ...a);
  const warn = (...a) => console.warn('%c[nk-rank]', 'color:#b45309;font-weight:600', ...a);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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

  // ---------------- 2. 请求工具 ----------------
  const PATH = '/acm-heavy/acm/contest/real-time-rank-data';
  const buildUrl = (extra = {}) => {
    const u = new URL(PATH, location.origin);
    for (const [k, v] of Object.entries({ token: '', id: contestId, limit: '0', ...extra })) {
      u.searchParams.set(k, String(v));
    }
    u.searchParams.set('_', String(Date.now()));
    return u.toString();
  };

  async function getJson(u) {
    const r = await fetch(u, { credentials: 'include', headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  }
  const isRankPayload = (j) => !!(j && j.data && j.data.basicInfo
    && String(j.data.basicInfo.contestId) === String(contestId));

  // ---------------- 3. 探真实总数（必须 limit=0 且不传 pageSize） ----------------
  let first;
  try {
    first = await getJson(buildUrl());
  } catch (e) {
    warn(`❌ 接口请求失败：${e.message}`);
    warn('   可能是接口改名 / 需要登录。请在 Network 面板找到那个请求，把 URL 发出来。');
    return '接口失败';
  }
  if (!isRankPayload(first)) {
    warn('❌ 接口有响应，但不是这份榜单（结构不对）。');
    return '响应异常';
  }

  const basic0 = first.data.basicInfo || {};
  const total = Number(basic0.rankCount) || 0;          // ★ 只有这次是真总数
  const defSize = Number(basic0.pageSize) || 50;
  const defPages = Number(basic0.pageCount) || Math.ceil(total / defSize) || 1;
  log(`共 ${total} 支队伍（默认每页 ${defSize}，${defPages} 页）`);

  const all = [];
  const seen = new Set();
  const collect = (list) => {
    let added = 0;
    for (const t of list || []) {
      const key = t.uid ?? t.ranking;
      if (seen.has(key)) continue;
      seen.add(key); all.push(t); added++;
    }
    return added;
  };
  collect(first.data.rankData);

  let problemData = first.data.problemData || [];
  let basic = basic0;
  let pageSize = defSize;

  // ---------------- 4. 试着一次装下全部（pageSize 可调） ----------------
  if (all.length < total) {
    for (const ps of [total + 10, 2000, 1000, 500, 200]) {
      try {
        const j = await getJson(buildUrl({ pageSize: ps, page: 1 }));
        if (!isRankPayload(j)) continue;
        const rows = j.data.rankData || [];
        if (rows.length >= total) {
          all.length = 0; seen.clear();
          collect(rows);
          problemData = j.data.problemData || problemData;
          basic = j.data.basicInfo || basic;
          log(`✅ 一次请求拿到全部 ${all.length} 队（pageSize=${ps}）`);
          break;
        }
        // 服务端把 pageSize 钳小了：记下它实际给多少，用于逐页抓
        if (rows.length > pageSize) pageSize = rows.length;
        log(`pageSize=${ps} 只回 ${rows.length} 队（被钳），可用每页 ${pageSize}`);
      } catch (e) {
        log(`pageSize=${ps} 失败（${e.message}），继续试。`);
      }
      await sleep(200);
    }
  }

  // ---------------- 5. 不行就按 page 逐页抓 ----------------
  if (all.length < total) {
    const pageCount = Math.ceil(total / pageSize);
    log(`逐页抓：每页 ${pageSize}，共 ${pageCount} 页`);

    for (let page = 2; page <= pageCount; page++) {
      const expectedFirst = (page - 1) * pageSize + 1;
      let ok = false;
      for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
        try {
          const j = await getJson(buildUrl({ pageSize, page }));
          if (!isRankPayload(j)) continue;
          const rows = j.data.rankData || [];
          // 判据：本页首行名次必须正好接上一页（不用回显，回显会骗人）
          if (rows.length && Number(rows[0].ranking) !== expectedFirst) {
            warn(`第 ${page} 页首行名次 ${rows[0].ranking}（预期 ${expectedFirst}），重试`);
            continue;
          }
          if (!rows.length) { ok = true; break; }   // 没数据了，当作抓完
          collect(rows);
          ok = true;
        } catch (e) {
          warn(`第 ${page} 页第 ${attempt} 次失败：${e.message}`);
        }
        await sleep(250);
      }
      if (!ok) warn(`第 ${page} 页没抓到，继续下一页（最后会校验总数）`);
      if (page % 5 === 0 || page === pageCount) {
        log(`进度 ${page}/${pageCount}，已收 ${all.length} 队`);
      }
      await sleep(300);   // 别把对面打疼
    }
  }

  // ---------------- 6. 校验 + 下载 ----------------
  const complete = all.length >= total;
  const solved = all.filter(t => Number(t.acceptedCount) > 0).length;
  if (!complete) {
    warn(`⚠️ 只收到 ${all.length}/${total} 队 —— "有效队伍数"会偏小，ratio 会偏大。`);
    warn('   本文件仍会下载，但 nk_rank_stats.py 会拒绝产出 ratio。');
    warn('   把 Network 里翻页时那个请求的 URL 发出来，好按它的参数名改。');
  } else {
    log(`✅ 收齐 ${all.length} 队，其中有解出题的（有效队伍数）= ${solved}`);
  }

  const bundle = {
    bundleVersion: 1,
    source: 'fetch-nk-rank.js',
    fetchedAt: new Date().toISOString(),
    contestId: String(contestId),
    // 用 limit=0 那次拿到的真实总数，而不是被 limit 污染的 rankCount
    pagesCollected: Math.ceil(all.length / pageSize),
    basicInfo: { ...basic, rankCount: total, pageSize, pageCount: Math.ceil(total / pageSize) },
    problemData,
    rankData: all
  };

  const name = `nk_cid${contestId}_rank.json`;
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);

  log(`已下载 ${name}`);
  log('   下一步：丢进 acm-data/raw/Scaper/01 nk/（哪个子目录都行），然后');
  log('   npm run crate:nk        ← 会算出赛时统计（榜单会被删掉，统计留下）');
  return `已下载 ${name}（${all.length}/${total} 队）`;
})()
