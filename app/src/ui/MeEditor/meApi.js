// ================================================================
// `me.json` 的读写客户端（ui/MeEditor/meApi.js）
//
// me.json 支持「JSON 修改 + UI 修改」两种改法（像 vsc 的设置那种）。
//
// 三件事都交给本机主脚本（`scripts/dev-server.py`）：
//   - 读 `GET /api/me`：**原样返回**（页面隐藏 cookie 之类的没有必要；页面只对本机
//     回环 Origin 放行，遮它只是让自己多一步）；
//   - 写 `PUT /api/me`：页面只能交"整份 JSON 文本"，服务器自己决定写哪个文件、先备份、比对 sha256；
//   - 探活 `POST /api/auth-probe`：把"现在到底有效没有"问给抓取侧那份判据
//     （`Scaper/lib/auth_state.py --probe <平台>`，1 个请求）。
// 页面这一侧因此**传不了路径、也传不了命令** —— 与「一键重建」那条路的边界一致
// （探活只能传一个平台名 + 几格覆盖值，形状在服务器侧校验）。
// ================================================================
import { APP_BUILD } from '../../A_constants.js';
import { probeLocalServer, resolvedBase, DEFAULT_PORT } from '../../core/localServer.js';

/** 接口路径（相对"服务器的根"） */
export const ME_API_PATH = 'api/me';
/** 登录态探活那条接口 */
export const AUTH_PROBE_PATH = 'api/auth-probe';

const jsonOf = async (res) => {
    try {
        return await res.json();
    } catch {
        return null;
    }
};

/** 出错时把 HTTP 状态挂在 Error 上（调用方靠 `err.status === 409` 认"磁盘变了"） */
function meError(data, res, fallback) {
    const err = new Error((data && data.error) || fallback || `接口返回 ${res && res.status}`);
    err.status = res && res.status;
    return err;
}

/**
 * 找一个能接 `/api/me` 的主脚本。
 *
 * 先复用「一键重建」那套探活（同源 → 回环两个地址）；它没找到时**再单独探一次**
 * `/api/me`：页面可能是从别的静态服务器打开的，而主脚本在跑。
 * 失败**不抛**（没在本机跑主脚本是常态，设置页要给一句人话提示）。
 */
export async function probeMeApi(fetchImpl = globalThis.fetch, bases = null) {
    const ping = await probeLocalServer(fetchImpl, bases || undefined);
    if (ping.ok) return ping;
    const tried = [];
    for (const base of (bases || ['', `http://127.0.0.1:${DEFAULT_PORT}/`])) {
        try {
            const res = await fetchImpl(`${base}${ME_API_PATH}`, { cache: 'no-store' });
            const data = await jsonOf(res);
            if (res && res.status !== 404 && data && (data.ok || data.error)) {
                return { ok: true, base: base || '', api: Number(data.api || 0), me: true };
            }
            tried.push({ base, error: `接口返回 ${res && res.status}` });
        } catch (err) {
            tried.push({ base, error: (err && err.message) || '连不上' });
        }
    }
    return { ok: false, error: ping.error || '连不上本机主脚本', tried: tried.concat(ping.tried || []) };
}

/**
 * 读 `me.json`（**原样，不打码** —— 见文件头）。
 *
 * ★ **文件不在不算错**（2026-10-19）：服务器对"还没有 `个人数据/me.json`"回 200 + 空文档，
 *   这里把 `exists: false` 原样带出来 —— 调用方据此说一句"还没有 me.json，保存一次就会建出来"，
 *   但**照样进可编辑状态**（旧口径回 404 ⇒ 设置页整块是空的，新装时凭据与账户一处都填不了）。
 *
 * @returns `{path, exists, sha256, mtime, doc}`
 * @throws 接口不通 / me.json 读不了（坏了、顶层不是对象）时抛（`err.status` 里带 HTTP 码）
 */
export async function fetchMe(fetchImpl = globalThis.fetch, base = resolvedBase()) {
    const res = await fetchImpl(`${base}${ME_API_PATH}`, { cache: 'no-store' });
    const data = await jsonOf(res);
    if (!res || !res.ok || !data || !data.ok) {
        throw meError(data, res, '读不到 me.json');
    }
    return {
        path: data.path || '',
        exists: data.exists !== false,
        sha256: data.sha256 || '',
        mtime: Number(data.mtime || 0),
        doc: data.doc || {}
    };
}

/**
 * 写 `me.json`。
 *
 * @param {{text:string, sha256?:string}} payload - `text` 是**整份 JSON 文本**；
 *        `sha256` 是载入时那份（服务器拿它挡"磁盘上被别人改过"）——不带就跳过这道闸。
 * @throws `err.status === 409` ⇒ 磁盘变了，页面应提示"重新载入再决定怎么合"
 */
export async function saveMe(fetchImpl = globalThis.fetch, base = resolvedBase(), payload = {}) {
    const res = await fetchImpl(`${base}${ME_API_PATH}`, {
        method: 'PUT',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: payload.text, sha256: payload.sha256 || '' })
    });
    const data = await jsonOf(res);
    if (!res || !res.ok || !data || !data.ok) {
        throw meError(data, res, '写不进去');
    }
    return {
        path: data.path || '',
        sha256: data.sha256 || '',
        mtime: Number(data.mtime || 0),
        doc: data.doc || {}
    };
}

/**
 * 探一次登录态：`POST /api/auth-probe`。
 *
 * @param {{platform:string, overrides?:Object}} payload - 平台名（`qoj`/`clist`…）+
 *        可选覆盖值（`{'qoj.cookie': '刚敲的那个'}`）；**不传 overrides ⇒ 测磁盘上那份**。
 * @returns `{code, platform, output}` —— `code` 0 = 有效、1 = 过期/被拦（`output` 里就是那句话）
 */
export async function authProbe(fetchImpl = globalThis.fetch, base = resolvedBase(), payload = {}) {
    const res = await fetchImpl(`${base}${AUTH_PROBE_PATH}`, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: payload.platform || '', overrides: payload.overrides || {} })
    });
    const data = await jsonOf(res);
    if (!res || !res.ok || !data || !data.ok) {
        throw meError(data, res, '探活失败');
    }
    return {
        code: Number(data.code || 0),
        platform: data.platform || '',
        output: String(data.output || '')
    };
}

/** 磁盘上那份是什么时候改的（设置页显示"最后改动"用） */
export function mtimeText(mtime) {
    if (!mtime) return '未知';
    const d = new Date(mtime * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
