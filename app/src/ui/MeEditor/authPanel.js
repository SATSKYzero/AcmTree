// ================================================================
// 「🔐 登录态」那一块（ui/MeEditor/authPanel.js）
//
// 「🔐 登录态」那一块要做的事：**登录态所需资料在 UI 端手输**，
// 不必去翻 me.json 里那些 cookie 之类的字段。
//
// 于是这里做三件事：
//   ① **手输**：把"登录态真正要的那几样"单独列出来（QOJ 的 cookie、CF 的 key/secret、
//      CLIST 的 username/key），敲完点「💾 存进 me.json」—— 落盘走**同一份草稿**与
//      同一个保存出口（`meEditor` 的 `doc/setDotted/save`），不开第二条写文件的路径；
//   ② **探活**：每行一个「🔎 探活」—— 用的是**框里现在的值**（不要求先保存），
//      经 `POST /api/auth-probe` 起 `Scaper/lib/auth_state.py --probe <平台>`（1 个请求），
//      把"有效 / 过期 / 被拦"和那句**可执行的话**原样显示出来；
//   ③ **说清什么不用管**：牛客/PTA/AtCoder 这些**没有凭据**（只有"被拦"这一类），
//      列表照旧列出来（带一句"没有登录态"），免得用户到处找它们的 cookie。
//      ★ **杭电是个例外**（2026-10-17 加）：站点没有登录态，但**赛内页**要比赛口令
//      （`POST /contest/login`）—— 所以它有自己一行、两格输入框，别把它归到"什么都不用填"那类里。
//
// ⚠️ 平台表在 `acm-data/raw/Scaper/lib/auth_state.py` 的 `PLATFORMS`（抓取侧的唯一一份）；
//    这里只放**界面要用的那一小撮**（标签、路径、有没有便宜探针）。加平台要同时改两处，
//    注释里标了 —— 不选"从服务器拉表"是因为下拉/输入框要在连上服务器之前就画出来。
// ================================================================
import { escapeHtml } from '../../utils/html.js';
import { authProbe } from './meApi.js';
import { dottedValue } from './meEditor.js';

const HINT = 'font-size:11px;color:#94a3b8;';
const INPUT = 'width:100%;padding:4px 8px;border:1px solid #d1d5db;border-radius:6px;'
    + 'font-size:12px;margin-top:2px;box-sizing:border-box;font-family:Consolas,Menlo,monospace;';
const LABEL = 'font-size:12px;color:#334155;font-weight:600;';

/**
 * 界面上要手输/探活的那几样。
 *
 * `fields` 里的 `path` 是 me.json 的点分路径（输入框原样显示真实值）。
 * `probe` = 这个平台有没有**便宜的探针**（后端表里 `probe` 为空的原因写在 `why`）。
 */
export const AUTH_PLATFORMS = [
    {
        id: 'qoj', label: 'QOJ', credential: 'qoj.cookie', probe: true,
        fields: [{ path: 'qoj.cookie', label: 'cookie', placeholder: 'session=…; …' }],
        why: '抓提交列表要它；过期时 QOJ 回 302 → //qoj.ac/login（0 字节）'
    },
    {
        id: 'cf', label: 'Codeforces', credential: 'cf.apiKey / cf.apiSecret', probe: true,
        fields: [
            { path: 'cf.apiKey', label: 'apiKey' },
            { path: 'cf.apiSecret', label: 'apiSecret' }
        ],
        why: 'CF 的每一发都要 apiSig 签名 —— 探活就真发一个带签名的请求'
            + '（gym 104813 的榜单），错了会当场说清是 key 还是 secret'
            + '（「Incorrect API key」/「Incorrect signature」）。'
    },
    {
        id: 'clist', label: 'CLIST', credential: 'clist.username / clist.apiKey', probe: true,
        fields: [
            { path: 'clist.username', label: 'username' },
            { path: 'clist.apiKey', label: 'apiKey' }
        ],
        why: '难度缓存用它；⚠️ 用户名不是可选的（只给 key 一律 401）'
    },
    {
        // ⚠️ 杭电这一条是 2026-10-17 新加的，别和上面那些"cookie / apiKey"混为一谈：
        //   **站点**确实没有登录态（公开页），但**赛内页**（`/contest/problems|status|rank`）
        //   是另一道门：`POST /contest/login?cid=…` 的比赛口令（多校**全季一个**）。
        //   没填的话那几个 URL 也回 200、正文却是 `Contest Login` 页（实测 11247 字节）。
        //   用途：`02 hdu/hdu_multi_fetch.py` 靠它自动抓，不必再逐场在浏览器里手存页面。
        // ★★ 2026-10-19 用户："杭电不应有登录态，只需写明必须提供密码" ⇒
        //   ① 它**不归「🔐 登录态」**那一块（那里是"过期/被拦、可以探活"的东西），单独一块「📌 必须填」；
        //   ② **没有探活按钮**（原来那颗是灰的占位）；③ 文案直说"必须填、不填抓不到赛内页"。
        id: 'hdu', label: '杭电（赛内页）', required: true,
        credential: 'hdu.contestUser / hdu.contestPassword',
        fields: [
            { path: 'hdu.contestUser', label: '比赛用户名（必填）', placeholder: '比赛登录时填的那个（常是队名/账号）' },
            { path: 'hdu.contestPassword', label: '比赛口令（必填，全季一个）', placeholder: '只用于赛内页' }
        ],
        why: '杭电没有登录态（站点是公开页），但要抓赛内页（题目 / 提交 / 榜单）「必须提供」这两格；'
            + '多校全季一个口令。填了 hdu_multi_fetch.py 就能自动抓，不用逐场在浏览器里手存页面。'
    },
    {
        id: '', label: '牛客 / PTA / AtCoder', credential: '', probe: false,
        fields: [],
        why: '这几个「没有登录态」（公开页或公开 API）—— 不用找它们的 cookie；'
            + '真被 403/429 拦住时抓取侧也会明说"这不是凭据的问题"。'
    }
];

/**
 * 建「🔐 登录态」那一块。
 *
 * @param {HTMLElement} host
 * @param {{doc:Function, base:Function, fetchImpl:Function, setDotted:Function, save:Function,
 *          ready:Function, toast:Function}} io - 都由 `meEditor` 注入（**同一份草稿**）
 * @returns {{paint:Function}}
 */
export function createAuthPanel(host, io) {
    const toast = io.toast || (() => {});
    /** 每一行最近一次的探活结果（`{text, color, bg}`），重画后还在 */
    const results = {};
    /**
     * 哪些格"**改过、还没存**" —— ⚠️ **只是给人看的那个小标记**，不是值的第二份拷贝。
     *
     * 2026-10-17 改（用户："新版又把我填的值吞了" / "别打补丁"）：这一块原来私藏了一份
     * `pending = {路径: 值}`，**只有按下本行的「存进 me.json」才提交进草稿**；
     * 而底部那颗「💾 保存到 me.json」是按**表单模型**重算整份文档的 ⇒ 两条路各写各的：
     * 你在这几格里敲的字，底部一保存就**整格消失**（实测：CF key/secret + QOJ cookie 全丢）。
     * ⇒ 现在：**敲一下就直接写进编辑器那份唯一草稿**（`io.setDotted`），这里只剩"哪几格动过"。
     */
    const touched = new Set();

    function paint() {
        const doc = io.doc() || {};
        const ready = io.ready ? io.ready() : true;
        const dirty = io.isDirty ? io.isDirty() : true;
        const rowHtml = (p) => {
            const inputs = p.fields.map((f) => {
                const value = dottedValue(doc, f.path);
                return `
                <label style="flex:1;min-width:180px;">
                    <span style="${HINT}">${escapeHtml(f.label)} · <code>${escapeHtml(f.path)}</code></span>
                    <input class="auth-field" data-path="${escapeHtml(f.path)}"
                        value="${escapeHtml(value)}"
                        placeholder="${escapeHtml(f.placeholder || '')}" style="${INPUT}">
                </label>`;
            }).join('');
            const res = results[p.id] || null;
            // ★ 只有"真的能探"的行才有这颗按钮（用户 2026-10-19："杭电不应有登录态" ——
            //   原来它挂一颗灰的占位按钮，等于把"必须填的口令"说成了"可以验的登录态"）。
            const probeBtn = p.probe
                ? `<button class="btn auth-probe" data-platform="${escapeHtml(p.id)}"
                        title="用框里现在的值探一发（1 个请求）"
                        style="padding:3px 10px;font-size:12px;"${ready ? '' : ' disabled'}>🔎 探活</button>`
                : '';
            const saveBtn = p.fields.length
                ? `<button class="btn auth-save" data-platform="${escapeHtml(p.id)}"
                        style="padding:3px 10px;font-size:12px;"${ready ? '' : ' disabled'}>💾 存进 me.json</button>`
                : '';
            // "改过、还没存" = 这一行的某一格动过 **且**编辑器整体还是脏的（存成功后 `isDirty()` 就是假）
            const unsaved = dirty && p.fields.some((f) => touched.has(f.path));
            const badge = unsaved
                ? `<span class="auth-unsaved" style="${HINT};color:#b45309;">（框里改过了，还没存）</span>` : '';
            const line = res
                ? `<pre class="auth-result" style="margin:6px 0 0;padding:6px 8px;border-radius:6px;`
                  + `background:${res.bg};color:${res.color};font-size:11px;white-space:pre-wrap;`
                  + `font-family:Consolas,Menlo,monospace;max-height:180px;overflow:auto;">`
                  + `${escapeHtml(res.text)}</pre>`
                : '';
            return `
                <div class="auth-row" data-platform="${escapeHtml(p.id)}"
                    style="border:1px solid #eef2f6;border-radius:8px;padding:8px;margin-bottom:8px;">
                    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                        <b style="${LABEL}">${escapeHtml(p.label)}</b>
                        ${p.credential ? `<code style="${HINT}">${escapeHtml(p.credential)}</code>` : ''}
                        ${badge}
                        <span style="margin-left:auto;display:flex;gap:6px;">${probeBtn}${saveBtn}</span>
                    </div>
                    ${p.fields.length ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px;">${inputs}</div>` : ''}
                    <div style="${HINT};margin-top:4px;line-height:1.5;">${escapeHtml(p.why)}</div>
                    ${line}
                </div>`;
        };
        // 「🔐 登录态」= 有登录态、能过期/被拦、有便宜探针的那几样；
        // 「📌 必须填」= 没有登录态、但不填就抓不到东西的那几样（杭电赛内页口令）—— 用户 2026-10-19 定的分家。
        const authRows = AUTH_PLATFORMS.filter((p) => !p.required).map(rowHtml).join('');
        const requiredRows = AUTH_PLATFORMS.filter((p) => p.required).map(rowHtml).join('');

        host.innerHTML = `
            <div style="border:1px solid #dbeafe;background:#f8fbff;border-radius:10px;padding:10px;">
                <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                    <b style="font-size:13px;color:#1e293b;">🔐 登录态</b>
                    <span style="${HINT}">抓取要用到的凭据就这几样；「🔎 探活」用「框里现在的值」试一发
                        （1 个请求，不用先保存）。</span>
                </div>
                <div style="margin-top:8px;">${authRows}</div>
            </div>
            ${requiredRows ? `
            <div style="border:1px solid #fde68a;background:#fffbeb;border-radius:10px;padding:10px;margin-top:8px;">
                <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                    <b style="font-size:13px;color:#92400e;">📌 必须填（不是登录态）</b>
                    <span style="${HINT}">这几格「不填就抓不到东西」；它们没有"有效/过期"这回事，所以没有探活按钮。</span>
                </div>
                <div style="margin-top:8px;">${requiredRows}</div>
            </div>` : ''}`;
    }

    host.addEventListener('click', async (ev) => {
        const target = ev.target;
        if (!target || !target.classList || typeof target.closest !== 'function') return;
        const probeBtn = target.closest('.auth-probe');
        const saveBtn = target.closest('.auth-save');
        if (probeBtn && !probeBtn.disabled) {
            await runProbe(probeBtn.closest('.auth-row'), probeBtn.dataset.platform);
            return;
        }
        if (saveBtn && !saveBtn.disabled) {
            // 值**早就在草稿里了**（真敲键时 `input` 事件已经 `io.setDotted` 过了）⇒ 这里只管保存。
            // ⚠️ 但仍要把**本行框里现在的值**再对一遍：浏览器自动填充（autofill）**不一定发 `input`**
            //    事件 —— 那颗按钮写着"存进 me.json"，就该以**它这一行框里看到的**为准。
            //    （这不是第二份存储：写进去的还是编辑器那份唯一草稿。）
            const row = saveBtn.closest('.auth-row');
            const spec = AUTH_PLATFORMS.find((p) => p.id === saveBtn.dataset.platform);
            for (const f of (spec ? spec.fields : [])) {
                const input = row ? row.querySelector(`.auth-field[data-path="${cssEscape(f.path)}"]`) : null;
                if (input) {
                    io.setDotted(f.path, input.value);
                    touched.add(f.path);
                }
            }
            await io.save();
            paint();
        }
    });

    host.addEventListener('input', (ev) => {
        const target = ev.target;
        if (!target || !target.classList || !target.classList.contains('auth-field')) return;
        // ★ **敲一下就直接进唯一那份草稿**（见 `touched` 的说明）：这样底部那颗
        //   「💾 保存到 me.json」与这一行的「存进 me.json」写出来的是同一份东西。
        io.setDotted(target.dataset.path, target.value);
        touched.add(target.dataset.path);
        // 只把"未保存"那个小标记刷出来，**不重画输入框**（否则光标会跳、字会丢）
        const row = target.closest ? target.closest('.auth-row') : null;
        if (!row) return;
        const platform = row.dataset.platform;
        const spec = AUTH_PLATFORMS.find((p) => p.id === platform);
        const unsaved = !!(spec && spec.fields.some((f) => touched.has(f.path)));
        const existing = row.querySelector('.auth-unsaved');
        if (unsaved && !existing) {
            const mark = document.createElement('span');
            mark.className = 'auth-unsaved';
            mark.style.cssText = HINT + ';color:#b45309;';
            mark.textContent = '（框里改过了，还没存）';
            const name = row.querySelector('b');
            if (name && name.after) name.after(mark);
        } else if (!unsaved && existing && existing.remove) {
            existing.remove();
        }
    });

    async function runProbe(row, platform) {
        const spec = AUTH_PLATFORMS.find((p) => p.id === platform);
        // 探活 = **用框里现在的值**（不要求先保存）⇒ 直接读输入框。
        // ⚠️ 这里**不再往面板里存一份**（原来那行 `pending[f.path] = input.value` 就是为了
        //    "探完重画别把刚敲的抹掉"—— 现在值本来就在草稿里，重画自然带得回来，见 `touched`）。
        const overrides = {};
        for (const f of (spec ? spec.fields : [])) {
            const input = row.querySelector(`.auth-field[data-path="${cssEscape(f.path)}"]`);
            if (input) overrides[f.path] = input.value;
        }
        results[platform] = { text: '⏳ 正在探…', color: '#475569', bg: '#f1f5f9' };
        paint();
        try {
            const got = await authProbe(io.fetchImpl, io.base(), { platform, overrides });
            const ok = got.code === 0;
            results[platform] = {
                text: got.output || (ok ? '✅ 有效' : '❌ 无效'),
                color: ok ? '#166534' : '#991b1b',
                bg: ok ? '#f0fdf4' : '#fef2f2'
            };
        } catch (err) {
            results[platform] = {
                text: `❌ 探活没跑起来：${err && err.message ? err.message : err}`,
                color: '#991b1b', bg: '#fef2f2'
            };
        }
        paint();
    }

    paint();
    return { paint };
}

/** 冒烟用的 DOM 桩不认 `CSS.escape`；路径里只有字母数字与点，够用了 */
function cssEscape(text) {
    return String(text || '').replace(/["\\]/g, '\\$&');
}
