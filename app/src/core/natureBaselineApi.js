// ================================================================
// 回代 baseline 的**直接写盘**客户端（core/natureBaselineApi.js）
//
// 口径：`acm-data/nature-assignments.json` 不用备份，**直接写入** ——
// **缩水先拒绝、要人点一下确认**。
//
// 换成"浏览器下载 `nature-assignments.json` → 人自己搬进 `acm-data/`"的话有两个麻烦：
// ① 浏览器撞名会存成 `nature-assignments (2).json`（得靠人挑最新的）；
// ② "放对位置"这一步最容易忘。所以页面点一下、**本机主脚本直接写**。
//
// 边界（与 `/api/me`、`/api/build` 那两条同一套）：
//   · 页面交的只有**那整份文档**（`{doc, confirm}`）—— 传不了文件名、传不了路径；
//   · 形状在服务器侧按**回代同一份读法**校验；写进去的东西必能被 `nature-baseline.py` 读出来；
//   · **缩水（比磁盘上少节点）⇒ 409**，`err.status === 409` + `err.data.diff.removedKeys`
//     告诉页面少了哪些 —— 页面问过用户，再带 `confirm: true` 重发；
//   · **不备份**：这份文件是导出物（应用数据里那些人工值随时能再导一次）。
// ================================================================
import { resolvedBase, urlOf } from './localServer.js';

/** 接口路径（相对"服务器的根"） */
export const NATURE_ASSIGNMENTS_PATH = 'api/nature-assignments';

const jsonOf = async (res) => {
    try {
        return await res.json();
    } catch {
        return null;
    }
};

/** 出错时把 HTTP 状态与响应体挂在 Error 上（调用方靠 `err.status === 409` 认"缩水被拒"） */
function baselineError(data, res, fallback) {
    const err = new Error((data && data.error) || fallback || `接口返回 ${res && res.status}`);
    err.status = res && res.status;
    err.data = data || null;
    return err;
}

/**
 * 写回代 baseline（**直接落到 `acm-data/nature-assignments.json`**）。
 *
 * @param {Function} fetchImpl - 注入的 fetch（单测用）
 * @param {string} base - 服务器根地址（默认 `resolvedBase()`）
 * @param {{doc:Object, confirm?:boolean}} payload - `doc` = 整份 baseline 文档
 *        （`core/natureAssignments.collectNatureAssignments()` 的产物）；
 *        `confirm: true` 只在"缩水被拒之后、用户点了确认"这一次带。
 * @returns `{path, count, fields, diff}`
 * @throws `err.status === 409` ⇒ 缩水，`err.data.diff.removedKeys` 是少掉的 key
 */
export async function saveNatureBaseline(fetchImpl = globalThis.fetch, base = resolvedBase(),
    payload = {}) {
    const res = await fetchImpl(urlOf(base, NATURE_ASSIGNMENTS_PATH), {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ doc: payload.doc, confirm: !!payload.confirm })
    });
    const data = await jsonOf(res);
    if (!res || !res.ok || !data || !data.ok) {
        throw baselineError(data, res, '写不进 acm-data/nature-assignments.json');
    }
    return {
        path: data.path || '',
        count: Number(data.count || 0),
        fields: Number(data.fields || 0),
        diff: data.diff || null
    };
}

/**
 * 读磁盘上那份（只为了显示"现在盘上是几节点/几处"；**不参与写入**）。
 *
 * @returns `{path, doc, count, fields}` —— 还没有那份文件时 `doc` 是 `null`（合法状态）
 */
export async function fetchNatureBaseline(fetchImpl = globalThis.fetch, base = resolvedBase()) {
    const res = await fetchImpl(urlOf(base, NATURE_ASSIGNMENTS_PATH), { cache: 'no-store' });
    const data = await jsonOf(res);
    if (!res || !res.ok || !data || !data.ok) {
        throw baselineError(data, res, '读不到 acm-data/nature-assignments.json');
    }
    return {
        path: data.path || '',
        doc: data.doc || null,
        count: Number(data.count || 0),
        fields: Number(data.fields || 0)
    };
}

/** 把 `diff` 说成一句人话（toast 用）—— 数字取**完整的**，不是被截断的那几个 key */
export function diffText(diff) {
    if (!diff) return '';
    const parts = [];
    if (diff.added) parts.push(`新增 ${diff.added}`);
    if (diff.changed) parts.push(`改过 ${diff.changed}`);
    if (diff.removed) parts.push(`少了 ${diff.removed}`);
    return parts.length ? parts.join(' / ') : '与磁盘上那份一致';
}
