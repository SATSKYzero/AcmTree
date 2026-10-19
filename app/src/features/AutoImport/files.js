// ================================================================
// 节点自动导入 — 文件读取（features/AutoImport/files.js）
// 职责：把用户选中的文件读成 JS 值；支持 .json / .json.gz / .gz
// 依赖：无（只用标准 Web API：FileReader / Blob / DecompressionStream）
//
// 说明：本模块**碰 DOM 与浏览器 API**，因此不进 Node 单测（见 如何使用test.md），
//       由 scripts/smoke/auto-import.smoke.mjs 覆盖。
//
// 与 handlers/H1_jsonIO.js 的 gzip 处理保持一致（同样的 API 与错误文案），
// 不引入任何依赖。
// ================================================================

/** 该文件名看起来是 gzip 吗 */
export function isGzipFile(fileName) {
    const name = String(fileName || '').toLowerCase();
    return name.endsWith('.gz');
}

/**
 * 解压 gzip 数据
 * @param {ArrayBuffer|Uint8Array} data
 * @returns {Promise<string>} 解压后的文本
 */
export async function decompressGzip(data) {
    if (typeof DecompressionStream === 'undefined') {
        throw new Error('当前浏览器不支持解压，请使用普通 JSON 文件');
    }
    const blob = new Blob([data], { type: 'application/gzip' });
    const stream = blob.stream().pipeThrough(new DecompressionStream('gzip'));
    const reader = stream.getReader();
    const chunks = [];
    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        chunks.push(value);
    }
    const total = chunks.reduce((sum, c) => sum + c.length, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
    }
    return new TextDecoder('utf-8').decode(merged);
}

/** 把 File 读成 ArrayBuffer（Promise 包装 FileReader） */
function readAsArrayBuffer(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = e => resolve(e.target.result);
        reader.onerror = () => reject(new Error(`读取文件失败：${file && file.name ? file.name : ''}`));
        reader.readAsArrayBuffer(file);
    });
}

/**
 * 读一个文件并解析成 JS 值
 *
 * @param {File} file
 * @returns {Promise<*>} 解析后的值（crate 对象或平台原生数组）
 */
export async function readJsonFile(file) {
    if (!file) throw new Error('没有选择文件');

    const buffer = await readAsArrayBuffer(file);
    const text = isGzipFile(file.name)
        ? await decompressGzip(buffer)
        : new TextDecoder('utf-8').decode(new Uint8Array(buffer));

    if (!text || text.trim() === '') {
        throw new Error(`文件为空：${file.name}`);
    }
    try {
        return JSON.parse(text);
    } catch (err) {
        throw new Error(`JSON 解析失败（${file.name}）：${err.message}`);
    }
}

/**
 * 打开文件选择框并读取选中的文件
 *
 * 用 `input.click()` 而非 `showOpenFilePicker`——后者在非安全上下文/部分浏览器
 * 不可用，而本项目是纯本地静态页面。
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.multiple]
 * @returns {Promise<File[]>} 用户取消时返回空数组
 */
export function pickFiles({ multiple = true } = {}) {
    return new Promise(resolve => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json,.gz,.json.gz';
        input.multiple = multiple;

        // 取消时 change 不一定触发；用 window 的 focus 兜底（详见注释）
        let settled = false;
        const finish = files => {
            if (settled) return;
            settled = true;
            window.removeEventListener('focus', onFocus);
            resolve(files);
        };

        function onFocus() {
            // focus 回来后再等一拍，让 change 有机会先跑（选到文件时 change 在前）
            setTimeout(() => finish([]), 400);
        }

        input.onchange = e => {
            const files = Array.from(e.target.files || []);
            finish(files);
        };

        window.addEventListener('focus', onFocus);
        input.click();
    });
}

/**
 * 读取一批文件；逐个解析，坏文件不影响其余
 *
 * @param {File[]} files
 * @param {Object} [opts]
 * @param {Function} [opts.onProgress] - `(info) => void`，每个文件读完后回调一次
 *        （`{done, total, file, bytes}`）—— 供导入页出进度条/预计时间
 * @returns {Promise<{ payloads: Array<{file:string, data:*}>,
 *                     errors: Array<{file:string, message:string}> }>}
 */
export async function readAllFiles(files = [], { onProgress } = {}) {
    const payloads = [];
    const errors = [];
    const total = files.length;
    let done = 0;

    for (const file of files) {
        const before = payloads.length + errors.length;
        try {
            payloads.push({ file: file.name, data: await readJsonFile(file) });
        } catch (err) {
            errors.push({ file: file && file.name ? file.name : '(未知文件)', message: err.message });
        }
        done++;
        if (typeof onProgress === 'function') {
            const size = (file && typeof file.size === 'number') ? file.size : 0;
            onProgress({
                done, total,
                file: (file && file.name) ? file.name : '',
                bytes: size,
                ok: (payloads.length + errors.length) > before
            });
        }
    }
    return { payloads, errors };
}
