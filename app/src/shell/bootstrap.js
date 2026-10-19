// ================================================================
// 插件引导（shell/bootstrap.js）
// 职责：读取 plugins.json，动态 import 插件，调用其激活函数
// 依赖：core/pluginRegistry.js, shell/pluginManifest.js
// 说明：
//   - 唯一知道"插件存在"的模块
//   - 清单解析（格式校验/启用开关/依赖排序）在 pluginManifest.js，
//     本模块只负责 IO（fetch + import）与激活，并对单个插件失败做隔离
//   - 用 Set 防重复激活（同一会话内多次调用 bootstrapPlugins）
// ================================================================
import { createPluginApi } from '../core/pluginRegistry.js';
import { resolvePluginEntries } from './pluginManifest.js';

// ---- 应用根：`index.html` / `plugins.json` / `src/` 所在的那一层 ----
//
// ⚠️ **不许写死 `/plugins.json`、`/src/...` 这种"服务器根"路径**（2026-10-17 实测踩到）：
//    本仓库是**两段根** —— 机械部分（`index.html`/`src/`/`scripts/`/`acm-data/`）在 `<仓库根>/app/` 下，
//    而本机服务器（`scripts/dev-server.py`）的静态根是**仓库根**。
//    于是写死的 `/src/x.js` 会被解析成 `<仓库根>/src/x.js` ⇒ **清单读不到、每个插件都 404**
//    ⇒ 表现是"检索 / 自动导入这两页静默消失"（正是下面 `startupProblems` 那套要报的事）。
//    写法照 `core/natureFields.js` / `core/synthRegistry.js` 那份：`new URL(相对路径, import.meta.url)`
//    —— 本模块在 `src/shell/` 下，`../../` 正好是应用根。
const APP_BASE = new URL('../../', import.meta.url);

const activated = new Set();

// ---- 启动期的"插件装载问题"（清单读不上 / 条目有问题 / 激活失败）----
//
// ⚠️ 为什么要**攒着**而不是就地弹：本模块在 `registerAllEvents()` **之前**跑，
//    那时 `show-toast` 的监听器还没注册（`ui/eventBridge.js`）⇒ 直接 dispatch 会被丢掉，
//    于是检索 / 自动导入这些**插件页会"无提示地消失"**。
//    （⚠️ 不是"toast 容器没建"：`#toast` 是 `index.html` 里的静态标记，一直在。）
//    这里只记，交给 `I_app.js` 在监听器就位后统一说一次。
const startupProblems = [];

/** 取走并清空启动期问题（调用方在 UI 就绪后弹一次就够，别每次刷新都念） */
export function takeStartupProblems() {
    const out = startupProblems.slice();
    startupProblems.length = 0;
    return out;
}

/**
 * 把攒下的启动问题**报出去**（`I_app.js` 在监听器就位后调一次）。
 *
 * 为什么要单独一个函数：攒下的问题必须有人在监听器就位后派发出去，
 * 少了这一步就等于没修 —— 攒得再好，不派发也没人看得见。
 *
 * @returns {string} 派发出去的那句话（没有问题 ⇒ 空串）
 */
export function announceStartupProblems() {
    const problems = takeStartupProblems();
    if (!problems.length) return '';
    const message = `插件没装全：${problems[0]}`
        + (problems.length > 1 ? `（另有 ${problems.length - 1} 条，见控制台）` : '');
    try {
        document.dispatchEvent(new CustomEvent('show-toast', { detail: { message, type: 'error' } }));
    } catch (_) {
        // 没有 DOM / 事件系统起不来时：至少别把这句话也丢了
        console.error('[bootstrap] 插件装载问题：', message);
    }
    return message;
}

/**
 * 加载并激活所有插件
 * @returns {Promise<{activated: string[], skipped: Object[], failed: Object[], problems: Object[]}>}
 *   失败与问题只记录不抛出：插件问题不应阻断应用启动
 */
export async function bootstrapPlugins() {
    const summary = { activated: [], skipped: [], failed: [], problems: [] };

    let config;
    try {
        const res = await fetch(new URL('plugins.json', APP_BASE), { cache: 'no-cache' });
        if (!res.ok) {
            console.warn('[bootstrap] 未找到 plugins.json，跳过插件加载');
            startupProblems.push(`读不到插件清单 plugins.json（HTTP ${res.status}）——`
                + '检索、自动导入这些「插件页这一趟都没有」');
            return summary;
        }
        config = await res.json();
    } catch (err) {
        console.error('[bootstrap] 读取 plugins.json 失败:', err);
        startupProblems.push(`读插件清单 plugins.json 出错了（${err && err.message ? err.message : err}）——`
            + '检索、自动导入这些「插件页这一趟都没有」');
        return summary;
    }

    const { entries, skipped, problems } = resolvePluginEntries(config);
    summary.skipped = skipped;
    summary.problems = problems;
    for (const p of problems) startupProblems.push(`插件清单有问题：${p.reason}`);

    for (const p of problems) {
        console.warn(`[bootstrap] 插件清单问题 — ${p.reason}`);
    }
    for (const s of skipped) {
        console.log(`[bootstrap] 插件 ${s.name} 已禁用（${s.reason}），跳过`);
    }

    if (entries.length === 0) {
        console.log('[bootstrap] 没有需要激活的插件');
        return summary;
    }

    const api = createPluginApi();

    for (const entry of entries) {
        if (activated.has(entry.fullPath)) {
            console.warn(`[bootstrap] 插件 ${entry.name} 已激活，跳过`);
            continue;
        }

        try {
            const mod = await import(new URL(entry.fullPath.replace(/^\//, ''), APP_BASE).href);
            const activateFn = mod[entry.activate];
            if (typeof activateFn !== 'function') {
                const reason = `导出 ${entry.activate} 不是函数`;
                console.warn(`[bootstrap] 插件 ${entry.name}: ${reason}`);
                summary.failed.push({ name: entry.name, reason });
                continue;
            }
            activateFn(api);
            activated.add(entry.fullPath);
            summary.activated.push(entry.name);
            console.log(`[bootstrap] 插件 ${entry.name} 已激活`);
        } catch (err) {
            const reason = err && err.message ? err.message : String(err);
            console.error(`[bootstrap] 激活插件 ${entry.name} 失败:`, err);
            summary.failed.push({ name: entry.name, reason });
        }
    }

    if (summary.failed.length > 0) {
        console.warn(`[bootstrap] 本次共有 ${summary.failed.length} 个插件激活失败：`
            + summary.failed.map(f => `${f.name}(${f.reason})`).join('、'));
        for (const f of summary.failed) {
            startupProblems.push(`插件 ${f.name} 激活失败：${f.reason}（它提供的那一页/那个功能不会出现）`);
        }
    }

    return summary;
}
