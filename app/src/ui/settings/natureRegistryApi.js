// ================================================================
// 性质注册表的读写客户端（`ui/settings/natureRegistryApi.js`）
//
// 页面自己写不了磁盘 ⇒ 三件事都交给本机主脚本（`scripts/dev-server.py`）：
//   · 读 `GET  /api/nature-registry`：那份文档 + `sha256` + 概况（`summary`）；
//   · 写 `PUT  /api/nature-registry`：交"整份文档"（页面**传不了路径**）；
//   · 探活：复用 `/api/ping`（`core/localServer.js` 那一份，别再造第二个探针）。
// ⚠️ 与「一键重建」「me.json」两条路同一个边界：页面只能传真值，判据一律在服务器侧。
// ================================================================
import { probeLocalServer, resolvedBase } from '../../core/localServer.js';
import { mtimeText } from '../MeEditor/meApi.js';

/** 接口路径（相对"服务器的根"） */
export const REGISTRY_API_PATH = 'api/nature-registry';

//: 重新导出：这张卡显示"最后改动"用的是 me.json 那份同一个格式化（**别抄第二份**）
export { mtimeText };

const jsonOf = async (res) => {
    try {
        return await res.json();
    } catch {
        return null;
    }
};

/** 出错时把 HTTP 状态挂在 Error 上（调用方靠 `err.status === 409` 认"磁盘变了"） */
function registryError(data, res, fallback) {
    const err = new Error((data && data.error) || fallback || `接口返回 ${res && res.status}`);
    err.status = res && res.status;
    return err;
}

/**
 * 找一个能接这条路由的主脚本（`/api/ping`；它自报 `api` 版本）。
 *
 * 失败**不抛**（没在本机跑主脚本是常态，那一栏要给一句人话提示）。
 * ⚠️ 调用方要自己比 `api` 版本（这条路由是接口 v7 才有的）：低了就提示重启 `启动AcmTree.bat`。
 */
export async function probeRegistryApi(fetchImpl = globalThis.fetch, bases = null) {
    const ping = await probeLocalServer(fetchImpl, bases || undefined);
    if (ping.ok) return ping;
    return { ok: false, error: ping.error || '连不上本机主脚本', tried: ping.tried || [] };
}

/**
 * 读注册表。
 * @returns `{path, sha256, mtime, doc, summary}`
 * @throws 接口不通 / 文件缺了（`err.status === 404`）时抛
 */
export async function fetchRegistry(fetchImpl = globalThis.fetch, base = resolvedBase()) {
    const res = await fetchImpl(`${base}${REGISTRY_API_PATH}`, { cache: 'no-store' });
    const data = await jsonOf(res);
    if (!res || !res.ok || !data || !data.ok) throw registryError(data, res, '读不到性质注册表');
    return {
        path: data.path || '',
        sha256: data.sha256 || '',
        mtime: Number(data.mtime || 0),
        doc: data.doc || {},
        summary: data.summary || {}
    };
}

/**
 * 写注册表。
 *
 * @param {{doc:Object, sha256?:string}} payload - `doc` 是**整份注册表**；
 *        `sha256` 是载入时那份（服务器拿它挡"磁盘上被别人改过"）—— 不带就跳过这道闸。
 * @throws `err.status === 409` ⇒ 磁盘变了；`400` ⇒ 形状不过（`err.message` 就是判据那句话）
 */
export async function saveRegistry(fetchImpl = globalThis.fetch, base = resolvedBase(), payload = {}) {
    const res = await fetchImpl(`${base}${REGISTRY_API_PATH}`, {
        method: 'PUT',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ doc: payload.doc, sha256: payload.sha256 || '' })
    });
    const data = await jsonOf(res);
    if (!res || !res.ok || !data || !data.ok) throw registryError(data, res, '写不进去');
    return {
        path: data.path || '',
        sha256: data.sha256 || '',
        mtime: Number(data.mtime || 0),
        doc: data.doc || {},
        summary: data.summary || {},
        diff: data.diff || {}
    };
}
