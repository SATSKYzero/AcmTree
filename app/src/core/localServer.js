// ================================================================
// 本机主脚本的**地址解析 + 探活**（core/localServer.js）
//
// 对外 API 由 `features/AutoImport/buildApi.js` **原样 re-export**
// （它只 import + re-export，自己一个字没实现）。
//
// 为什么必须往下搬一层：`ui/` **不许依赖 `features/`**（那条边界见 `ui/dedup/kit.js` 的注释）。
// 而「📤 导出人工填写」这个按钮住在 `ui/dedup/naturePending.js` 里，它现在要**直接写盘**
// （POST 本机主脚本），于是"主脚本在哪个地址"这件事必须有 `ui/` 也能 import 的家。
//
// 规则仍然只有一份：同源 → 回环两个地址；哪个探通了就记住（`resolvedBase()`）。
//
// **探活**（`pingLocalServer` / `probeLocalServer`）放在这里，因为
// `ui/MeEditor/meApi.js` 要用它，而 `ui/` 不许依赖 `features/`。
// ================================================================
import { APP_BUILD } from '../A_constants.js';

/**
 * 本机主脚本的默认端口。
 *
 * ⚠️ 用 8321 而不是 8000：8000 常被别的工具占着（本机实测撞上过 `python -m http.server`，
 * 还叠了三份一起抢答）。换开之后，**哪怕这个页面是别的服务器给的**，按钮也会主动
 * 去 `127.0.0.1:8321` 找主脚本 —— 见 `defaultBases()`。
 */
export const DEFAULT_PORT = 8321;

/**
 * 按顺序试哪些根地址？
 *
 * - `''`（同源）永远第一个：页面就是本机主脚本提供的时候，一条相对路径就打中了；
 * - 页面**不是**从 `127.0.0.1:<DEFAULT_PORT>` 来的时候（别的端口 —— 比如 8000 上蹲着
 *   别人的静态服务器、或 `file://`、或双击 index.html），再试两个回环地址：
 *   主脚本对 `/api/*` 放行了本机回环 Origin，所以这能成。这也是"页面是别人给的、
 *   按钮照样好使"的原因。
 */
export function defaultBases(loc = globalThis.location) {
    const bases = [''];
    const host = (loc && loc.hostname) || '';
    const port = (loc && loc.port) || '';
    const fromServer = (host === '127.0.0.1' || host === 'localhost') && String(port) === String(DEFAULT_PORT);
    if (!fromServer) {
        bases.push(`http://127.0.0.1:${DEFAULT_PORT}/`);
        if (host !== 'localhost') bases.push(`http://localhost:${DEFAULT_PORT}/`);
    }
    return bases;
}

/** 已经找到的服务器（探活成功后就记住，后面几个调用都用它） */
let resolved = null;

/** 当前连着的服务器根地址（没连上时 = 同源相对） */
export function resolvedBase() {
    return (resolved && resolved.base) || '';
}

/** 手工指定（单测 / 特殊场景用） */
export function setResolved(ping) {
    resolved = ping || null;
    return resolved;
}

/** 拼一个绝对/相对地址（`base` 为空 = 同源相对路径） */
export const urlOf = (base, path) => `${base || ''}${path}`;

/** 探活那条接口的路径（主脚本对 `/api/*` 放行本机回环 Origin） */
export const PING_API_PATH = 'api/ping';

/** 读一个响应的 JSON（读不出来 ⇒ `null`，不抛）—— 两个本机客户端共用这一份 */
export async function jsonOrNull(res) {
    try {
        return await res.json();
    } catch {
        return null;
    }
}

/**
 * 探活一个根地址：这个根地址后面是不是本机主脚本？
 *
 * @returns `{ok:true, base, root, api, pid, port, diskBuild, pageBuild, stalePage, steps}` /
 *          `{ok:false, base, error}`（**不抛**：探活失败是常态）
 */
export async function pingLocalServer(fetchImpl = globalThis.fetch, base = '') {
    if (typeof fetchImpl !== 'function') return { ok: false, base, error: '这个环境没有 fetch' };
    const url = `${urlOf(base, PING_API_PATH)}?build=${encodeURIComponent(APP_BUILD)}`;
    try {
        const res = await fetchImpl(url, { cache: 'no-store' });
        const data = await jsonOrNull(res);
        if (res && res.ok && data && data.ok) {
            return {
                ok: true,
                base: base || '',
                root: data.root || '',
                api: Number(data.api || 0),
                pid: Number(data.pid || 0),
                port: Number(data.port || 0),
                srcSha: data.srcSha || '',
                restarts: Number(data.restarts || 0),
                diskBuild: data.diskBuild || '',
                pageBuild: data.pageBuild || '',
                stalePage: !!data.stalePage,
                steps: Array.isArray(data.steps) ? data.steps : []
            };
        }
        return { ok: false, base: base || '', error: (data && data.error) || `接口返回 ${res && res.status}` };
    } catch (err) {
        return { ok: false, base: base || '', error: (err && err.message) || '连不上本机接口' };
    }
}

/**
 * 找本机那个主脚本：同源 → 回环（见 `defaultBases`）。探通了就记住（`resolvedBase()`）。
 *
 * @returns `{ok:true, ...ping}` / `{ok:false, error, tried:[{base,error}]}`
 */
export async function probeLocalServer(fetchImpl = globalThis.fetch, bases = defaultBases()) {
    if (typeof fetchImpl !== 'function') return { ok: false, error: '这个环境没有 fetch', tried: [] };
    const tried = [];
    for (const base of bases) {
        const ping = await pingLocalServer(fetchImpl, base);
        if (ping.ok) {
            setResolved(ping);              // 记住它（本模块那份状态）
            return ping;
        }
        tried.push({ base, error: ping.error });
    }
    return { ok: false, error: tried.length ? tried[0].error : '没有可试的地址', tried };
}
