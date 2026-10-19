// ================================================================
// 节点自动导入 — 目录轮询（features/AutoImport/dirWatcher.js）
// 职责：用户授权一个「爬虫输出目录」后，定时发现新的导入包
// 依赖：无（只用 File System Access API）
//
// ⚠️ 能力边界（必须说清楚，否则会被当成 bug）：
//   浏览器**无法常驻后台**。所以"自动"的语义是
//   **「页面开着时定时发现」**，不是「关掉浏览器也会同步」。
//   轮询发现的包**只载入为待执行**，绝不自动写数据
//   （唯一例外是用户显式打开"自动应用"且预览 0 错误——见 shouldAutoApply）。
//
// 授权约束：
//   showDirectoryPicker 必须由用户手势触发；
//   权限过期后**不能静默重新请求**，必须再次由用户点击授权。
//
// 说明：本模块碰浏览器 API，不进 Node 单测，由冒烟测试覆盖（若可桩化）。
// ================================================================

/** 默认轮询间隔（毫秒） */
export const DEFAULT_POLL_INTERVAL = 60000;

/** 认得出来的导入包扩展名 */
const CRATE_EXTENSIONS = ['.json', '.json.gz', '.gz'];

let timer = null;
let seenFiles = new Set();

export function isCrateFileName(name) {
    const lower = String(name || '').toLowerCase();
    return CRATE_EXTENSIONS.some(ext => lower.endsWith(ext));
}

/**
 * 列出目录里的导入包文件（只一层，不递归）
 *
 * @param {FileSystemDirectoryHandle} handle
 * @returns {Promise<File[]>}
 */
export async function listCrateFiles(handle) {
    const files = [];
    if (!handle || typeof handle.values !== 'function') return files;

    for await (const entry of handle.values()) {
        if (!entry || entry.kind !== 'file') continue;
        if (!isCrateFileName(entry.name)) continue;
        try {
            files.push(await entry.getFile());
        } catch (err) {
            console.warn(`[AutoImport] 读取目录项失败：${entry.name}`, err);
        }
    }
    return files;
}

/**
 * 是否应当自动应用
 *
 * 保守策略：只有预览**零错误**且"待写入数"不超过上限时才允许自动写。
 * 默认开关是关的——发现的包只载入待执行。
 *
 * @param {Object} plan
 * @param {Object} [opts]
 * @param {boolean} [opts.autoApply] - 用户开关
 * @param {number} [opts.maxAutoApply] - 单次自动应用上限
 * @returns {boolean}
 */
export function shouldAutoApply(plan, { autoApply = false, maxAutoApply = 200 } = {}) {
    if (!autoApply || !plan || !plan.summary) return false;
    if (plan.summary.errors > 0) return false;
    return (plan.summary.create + plan.summary.update) <= maxAutoApply;
}

/**
 * 轮询目录，发现"上次之后新增"的导入包
 *
 * 首次调用只记基线（不把已有文件当新增）；
 * 后续每次返回新出现的文件。这个语义避免了"一授权就把整个目录导进来"。
 *
 * @param {FileSystemDirectoryHandle} handle
 * @param {Object} [opts]
 * @param {Function} [opts.onBatch] - (files:File[]) => void|Promise，发现新文件时调用
 * @param {number} [opts.interval] - 轮询间隔
 * @param {boolean} [opts.immediate] - 是否立刻扫一次并返回新增
 * @returns {Promise<number>} 本次发现的新文件数
 */
export async function watchDirectory(handle, { onBatch, interval = DEFAULT_POLL_INTERVAL, immediate = true } = {}) {
    stopWatching();
    seenFiles = new Set();

    // 基线：把当前目录里的文件记为"已见"，不算新增
    const baseline = await listCrateFiles(handle);
    for (const f of baseline) seenFiles.add(f.name);

    const scan = async () => {
        const files = await listCrateFiles(handle);
        const fresh = files.filter(f => !seenFiles.has(f.name));
        for (const f of fresh) seenFiles.add(f.name);

        if (fresh.length && typeof onBatch === 'function') {
            try {
                await onBatch(fresh);
            } catch (err) {
                console.error('[AutoImport] onBatch 处理失败:', err);
            }
        }
        return fresh.length;
    };

    const first = immediate ? 0 : await scan();   // immediate 只建基线

    timer = setInterval(() => {
        scan().catch(err => console.error('[AutoImport] 目录轮询失败:', err));
    }, Math.max(5000, interval));

    return first;
}

/** 停止轮询 */
export function stopWatching() {
    if (timer !== null) {
        clearInterval(timer);
        timer = null;
    }
}

/** 是否正在轮询 */
export function isWatching() {
    return timer !== null;
}

/** 手动触发一次扫描（供"立即检查"按钮） */
export async function scanOnce(handle) {
    const files = await listCrateFiles(handle);
    const fresh = files.filter(f => !seenFiles.has(f.name));
    for (const f of fresh) seenFiles.add(f.name);
    return fresh;
}
