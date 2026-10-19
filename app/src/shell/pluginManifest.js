// ================================================================
// 插件清单解析（shell/pluginManifest.js）
// 职责：把 plugins.json 的原始内容解析成"可激活的条目序列"
// 依赖：无
// 说明：本模块**不做 IO、不碰 DOM、不 import 插件**，
//       因此可在 Node 测试中直接引用。真正的 fetch/import 在 bootstrap.js。
//
// plugins.json 条目格式：
//   {
//     "name":     "TestnumOp",              // 必填，唯一
//     "path":     "/src/features/.../index.js", // 必填，唯一（支持 './x' 或 '/x'）
//     "activate": "activateTestnumOp",      // 必填，导出函数名
//     "enabled":  true,                     // 选填，false 则跳过（默认启用）
//     "requires": ["OtherPlugin"]           // 选填，依赖的插件名（决定激活顺序）
//   }
// ================================================================

/**
 * 归一化插件路径：支持 './src/x.js' 与 '/src/x.js'
 * @param {string} path
 * @returns {string}
 */
export function normalizePluginPath(path) {
    return path.startsWith('/') ? path : '/' + path.replace(/^\.\//, '');
}

/**
 * 稳定的依赖优先排序（拓扑）。存在环时保留剩余条目的原始顺序并记录问题。
 * @param {Array<Object>} candidates
 * @param {Array<Object>} problems - 追加问题用
 * @returns {Array<Object>}
 */
function orderByRequirements(candidates, problems) {
    const byName = new Map(candidates.map(c => [c.name, c]));
    const state = new Map();   // name -> 'visiting' | 'done'
    const result = [];

    const visit = (c, chain) => {
        const st = state.get(c.name);
        if (st === 'done') return;
        if (st === 'visiting') {
            problems.push({ name: c.name, reason: `依赖成环：${[...chain, c.name].join(' -> ')}` });
            return;
        }
        state.set(c.name, 'visiting');
        for (const req of c.requires) {
            const dep = byName.get(req);
            if (dep) visit(dep, [...chain, c.name]);
        }
        state.set(c.name, 'done');
        result.push(c);
    };

    for (const c of candidates) visit(c, []);
    return result;
}

/**
 * 解析插件清单
 * @param {Object} config - plugins.json 解析后的对象
 * @returns {{entries: Array<Object>, skipped: Array<Object>, problems: Array<Object>}}
 *   entries  - 可激活条目，已归一化路径并按依赖排序
 *   skipped  - 因 enabled=false 而跳过的条目
 *   problems - 格式错误/重名/重路径/依赖缺失等，均已被排除出 entries
 */
export function resolvePluginEntries(config) {
    const problems = [];
    const skipped = [];
    const raw = config && Array.isArray(config.plugins) ? config.plugins : [];

    const seenNames = new Set();
    const seenPaths = new Set();
    const candidates = [];

    for (const entry of raw) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            problems.push({ name: null, reason: '条目不是对象', entry });
            continue;
        }

        const { name, path, activate, enabled, requires } = entry;

        if (typeof name !== 'string' || name === '') {
            problems.push({ name: null, reason: '缺少合法的 name', entry });
            continue;
        }
        if (typeof path !== 'string' || path === '') {
            problems.push({ name, reason: `${name}: 缺少合法的 path`, entry });
            continue;
        }
        if (typeof activate !== 'string' || activate === '') {
            problems.push({ name, reason: `${name}: 缺少合法的 activate`, entry });
            continue;
        }
        if (requires !== undefined && (!Array.isArray(requires) || requires.some(r => typeof r !== 'string' || r === ''))) {
            problems.push({ name, reason: `${name}: requires 需为非空字符串数组`, entry });
            continue;
        }
        if (enabled === false) {
            skipped.push({ name, reason: 'enabled=false' });
            continue;
        }

        const fullPath = normalizePluginPath(path);
        if (seenNames.has(name)) {
            problems.push({ name, reason: `插件名 ${name} 重复`, entry });
            continue;
        }
        if (seenPaths.has(fullPath)) {
            problems.push({ name, reason: `${name}: 路径 ${fullPath} 与前面的插件重复`, entry });
            continue;
        }

        seenNames.add(name);
        seenPaths.add(fullPath);
        candidates.push({
            name,
            activate,
            fullPath,
            requires: requires ? [...requires] : []
        });
    }

    // 依赖校验：被依赖者必须已启用且存在
    const available = new Set(candidates.map(c => c.name));
    for (const c of candidates) {
        for (const req of c.requires) {
            if (!available.has(req)) {
                problems.push({ name: c.name, reason: `${c.name} 依赖的插件 "${req}" 未启用或不存在` });
            }
        }
    }

    return {
        entries: orderByRequirements(candidates, problems),
        skipped,
        problems
    };
}
