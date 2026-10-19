// ================================================================
// 冒烟测试用模块解析钩子（scripts/smoke/specifier-loader.mjs）
// 职责：补上 Node 相对浏览器缺失的两处解析能力
//
//   1. `immer` —— 裸包名。浏览器靠 index.html 的 import map 解析；
//      Node 没有 import map，会 ERR_MODULE_NOT_FOUND。
//   2. `/src/...` —— plugins.json 里写的是**服务器根路径**（浏览器语义）。
//      Node 会把它当成盘符根路径（D:\src\...），同样找不到。
//
// 这两处都是"浏览器能跑、Node 不能跑"的环境差异，不是代码问题。
// ================================================================
const VENDOR_IMMER = new URL('../../src/vendor/immer.mjs', import.meta.url).href;
const SRC_PREFIX = new URL('../../src/', import.meta.url);

export async function resolve(specifier, context, next) {
    if (specifier === 'immer') {
        return { url: VENDOR_IMMER, shortCircuit: true };
    }
    if (specifier.startsWith('/src/')) {
        return { url: new URL(specifier.slice('/src/'.length), SRC_PREFIX).href, shortCircuit: true };
    }
    return next(specifier, context);
}
