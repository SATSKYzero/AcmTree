// ================================================================
// 本机重建接口的客户端（features/AutoImport/buildApi.js）
//
// 谁在跑命令：**本机那个"主脚本"**（`scripts/dev-server.py`，`启动AcmTree.bat` 起的）——
// 原料处理链在它**进程内**跑（`scripts/build_chain.py`）。纯前端页面自己没法执行本机脚本，
// 所以这件事必须由一个本机进程接住；能做到的极限就是"这个进程同时是页面的服务器 +
// 处理链的拥有者"，也就是现在的形态。
//
// 本模块做四件事（都接受注入的 `fetchImpl` ⇒ 能在 Node 单测里跑）：
//   ① **找**这个进程（`probeBuildApi`，实现在 `core/localServer.js`）：先试同源，再试回环 ——
//      页面就算是别的静态服务器/双击 index.html 打开的，只要它在跑就能连上；
//   ② 探活时**带上自己的 `APP_BUILD`**：服务器拿磁盘上的版本一比，就能告诉页面
//      "你这份页面是旧代码"（"点了没反应"的真凶之一）；
//   ③ 起 / 查一次重建（跑哪几步写死在服务器侧；页面只能传**一个布尔 + 一个写死的档位名**）；
//   ④ 把产出的包取回来（`acm-data/nodes/all_nodes.json`），包成 File 走既有导入通道。
// ================================================================
import { APP_BUILD } from '../../A_constants.js';
// ★ `DEFAULT_PORT` / `defaultBases()` / `resolvedBase()` / `setResolved()` / `urlOf()`
//   的实现都在 `core/localServer.js` —— `ui/dedup`（回代 baseline 直接写盘那条路）
//   也要找主脚本，而 `ui/` 不许 import `features/`。本文件**原样 re-export**，
//   对外的 API 保持原样（`meApi.js` / `panel.js` / 单测都这么 import）。
import {
    DEFAULT_PORT, defaultBases, resolvedBase, setResolved, urlOf, PING_API_PATH, jsonOrNull,
    pingLocalServer, probeLocalServer,
} from '../../core/localServer.js';

// 原样 re-export：**对外的 API 保持原样**（`panel.js` / `buildBox.js` / 单测都这么 import）
export { DEFAULT_PORT, defaultBases, resolvedBase, setResolved, urlOf, PING_API_PATH };

/** 接口路径（相对"服务器的根"） */
export const BUILD_API_PATH = 'api/build';
/** 暂停接口 ——「跑完当前步就停」，见 `stopBuild()` */
export const BUILD_STOP_API_PATH = 'api/build/stop';
/** 产出的总包（服务器根目录下，静态可达） */
export const PACKAGE_URL = 'acm-data/nodes/all_nodes.json';
/** 页面期望的接口版本（服务器低于它 ⇒ 那是启动更早的旧进程）
 *  ⚠️ `/api/build/stop` 与状态里的 `stopRequested/canStop/stopped` 要求服务器到这个版本
 *     （低版本没有 ⇒ 页面得先让它重启，否则暂停按钮按了没反应）。
 *  ⚠️ v7 起还有 `GET/PUT /api/nature-registry`（性质注册表那一栏）——
 *     旧服务器不认这条路由（会 404），所以那一栏也得先让它重启。
 *     ⚠️ 改这里必须**同时**改服务器那份（`scripts/devserver/http_handler.py` 的 `API_VERSION`）。 */
export const API_VERSION = 7;
/**
 * **重建档位**：页面下拉框那几个选项。
 *
 * ⚠️ **重建有两个轴，下拉框里必须一起给**：
 *   · **轴 A：产包那一步怎么跑**（链上第 3 步 `xcpc_pipeline`）
 *       `--force` = 把已有归档当不存在、**所有来源重跑一遍**（联网）；
 *       `--offline` = **一次也不联网**、只用本地归档与缓存（缺了就当场报错）。
 *       这两个**互斥**（`read_modes` 直接报错），所以它们是**两个不同的档**，不是"一个开关"。
 *   · **轴 B：要不要先探数据、按需求补原料**（`needs` / `needs-low` / `probe-all` 三个档才有）。
 *   ⇒ 把"离线"做成独立勾选框，等于把轴 A 拆到两个控件上（勾选框 + 档位），
 *      描述怎么写都别扭；**一个下拉框 = 一个完整的预设**：`{offline, mode}` 一起定死。
 *
 * ⚠️ 键必须与服务器 `scripts/build_chain.py` 的 `BUILD_MODES` **一一对应**（键名就是契约）；
 *    标签/说明在这里再写一份，因为下拉框要在**连上服务器之前**就画出来。
 *    ⇒ 除 `offline`（本地预设：= `offline: true` + 标准档，服务器照旧只收"一个布尔 + 一个枚举名"）
 *      之外的四个键必须与服务器逐字一致。
 *    两边对不上的后果：服务器 `mode_of()` 认不出 ⇒ 按默认档 `standard` 跑（并在日志里写明），
 *    所以最坏情况是"选择了但按标准档跑"，不会跑出别的东西。
 *    ⚠️ 加档位要动三处：这里 / `build_chain.BUILD_MODES` / `docs/field-rules.md` §1.1.2。
 *    ⚠️ **顺序 = 越轻越前**：离线（不联网）
 *      → 标准（用现有原料，缺的才抓）→ 按需求补抓 → 补抓+low → 兜底重探 → **全删重爬**（唯一会删东西的）。
 *      下拉框按表的顺序画；**默认选中的仍是 `standard`**（`DEFAULT_BUILD_MODE`，与位置无关）。
 *    ★ **删除只在一处**（用户 2026-10-17 定："其他档位不应有任何删除，只有增量合并"）：
 *      只有「全删重爬」那一档会跑 `prune-raw.py --apply`（判定在 `Scaper/lib/material.py`）
 *      并让产包那步带 `--force`（整份重抓）；其余档位**一个字都不删**、也不整份重抓。
 */
export const BUILD_MODES = [
    {
        key: 'offline', offline: true, mode: 'standard',
        label: '离线重建（不联网，用现有原料）',
        // ⚠️ 「不联网」不是"省一点"的同义词：它是**一次也不联网**、只用本地归档（缺了就当场报错）。
        hint: '= build-all.py --offline：「一次也不联网」，只用本地已有的原料/归档把包重产一遍。'
            + '⚠️ 它「不会更新数据」 —— 那必须走联网那几档'
    },
    {
        key: 'standard', offline: false, mode: 'standard',
        label: '标准重建（用现有原料，缺的才抓）',
        hint: '= build-all.py（不带 --offline）：拿盘上现有原料按需出包 —— 缺的由适配器自己按缓存语义去抓。'
            + '⚠️ 不删任何东西、也不整份重抓（要那样请用最后的「全删重爬」）'
    },
    {
        key: 'needs', offline: false, mode: 'needs',
        label: '按需求补抓原料',
        hint: '= build-all.py --needs：先探数据 → 只补缺的/过期的那份原料 → 只重跑缺的那个来源。'
            + '⚠️「补」= 让 builder 去刷新，不删旧缓存'
    },
    {
        key: 'needs-low', offline: false, mode: 'needs-low',
        label: '补抓 + 连"多半拿不到"一起',
        hint: '= --needs --pursue low：追值门槛放到 low ⇒ 那 179 格（RankLand 的题链接与开赛时间）也进计划'
    },
    {
        key: 'probe-all', offline: false, mode: 'probe-all',
        label: '兜底重探（忘掉"拿不到"的旧结论）',
        hint: '= --needs --probe-all：把"这格多半拿不到"的旧结论也忘掉、缺的/缺难度的全部重查。'
            + '⚠️ 它不删原料、也不整份重抓；比标准档慢，不是"更全的默认"'
    },
    {
        key: 'purge', offline: false, mode: 'purge',
        label: '全删重爬（先去无用原料，再整份重抓）',
        hint: '= 先跑 prune-raw.py --apply（全仓唯一会删原料的地方：白名单/花名册之外的旧缓存），'
            + '再整份重抓（--force --all-nodes）。'
            + '⚠️ 用在"白名单改了 / 原料脏了、要重来一遍"的场合；比标准档慢得多'
    }
];
/** 默认档（= 与不带档位时的行为完全一致） */
export const DEFAULT_BUILD_MODE = 'standard';

/**
 * 探活一个根地址：这个根地址后面是不是支持"一键重建"的本机服务器？
 *
 * @returns `{ok:true, base, root, api, pid, port, diskBuild, pageBuild, stalePage}` /
 *          `{ok:false, base, error}`（**不抛**：探活失败是常态）
 */
export const pingBuildApi = pingLocalServer;
export const probeBuildApi = probeLocalServer;

/**
 * 开始重建（已经在跑 ⇒ 服务器返回 `started:false` + 当前状态）。
 *
 * @param {boolean|null} [offline] - **轴 A**：`true` = `--offline`（一次不联网），
 *        `false` = 联网（把归档当不存在、所有来源重跑一遍），
 *        `null`/不给 ⇒ 用服务器启动时那份默认。
 *        ⚠️ 页面上它**不是独立勾选框**（并进档位），由 `BUILD_MODES[].offline` 给。
 * @param {string} [mode] - **轴 B**：档位名（服务器 `build_chain.BUILD_MODES` 的 key）：
 *        空/`standard` ⇒ 不传（老服务器照旧按标准重建）。
 *        ⚠️ 页面能传的**只有这两样**（一个布尔 + 一个写死的档位名）——
 *        服务器侧只认 `parse_build_body` 那两个键，**传不了命令或任意参数**。
 */
export async function startBuild(fetchImpl = globalThis.fetch, base = resolvedBase(), offline = null,
    mode = '') {
    const opts = { method: 'POST', cache: 'no-store' };
    const body = {};
    if (typeof offline === 'boolean') body.offline = offline;
    if (mode && mode !== DEFAULT_BUILD_MODE) body.mode = String(mode);
    if (Object.keys(body).length) {
        // 带 Content-Type 会触发一次 CORS 预检 —— 服务器 `do_OPTIONS` 已放行本机 Origin
        opts.headers = { 'Content-Type': 'application/json' };
        opts.body = JSON.stringify(body);
    }
    const res = await fetchImpl(urlOf(base, BUILD_API_PATH), opts);
    const data = await jsonOrNull(res);
    if (!res || !res.ok || !data || !data.ok) {
        throw new Error((data && data.error) || `重建接口返回 ${res && res.status}`);
    }
    return { started: !!data.started, status: data.status || null };
}

/**
 * **暂停**正在跑的重建。
 *
 * ⚠️ 语义是「**跑完当前步就停**」，不是"立刻冻结进程"：链子正在写文件（产包/合并/回代）时
 *    中途掐断会留下**半个包**；在步骤边界停没有这个险，而且链子**幂等**，随时可以重跑。
 *    ⇒ 按下去之后按钮要显示「正在停…（跑完当前步）」，当前那一步（最长产包 ~19 秒）会跑完。
 *
 * @returns `{accepted, status}` —— `accepted=false` = 当时没在跑（不是错误）
 */
export async function stopBuild(fetchImpl = globalThis.fetch, base = resolvedBase()) {
    const res = await fetchImpl(urlOf(base, BUILD_STOP_API_PATH), { method: 'POST', cache: 'no-store' });
    const data = await jsonOrNull(res);
    if (!res || !res.ok || !data || !data.ok) {
        throw new Error((data && data.error) || `暂停接口返回 ${res && res.status}`);
    }
    return { accepted: !!data.accepted, status: data.status || null };
}

/** 查一次状态（页面轮询它：`lines` 是日志尾部若干行、`steps` 是每步状态） */
export async function fetchBuildStatus(fetchImpl = globalThis.fetch, base = resolvedBase()) {
    const res = await fetchImpl(urlOf(base, BUILD_API_PATH), { cache: 'no-store' });
    const data = await jsonOrNull(res);
    if (!res || !res.ok || !data || !data.ok) {
        throw new Error((data && data.error) || `状态接口返回 ${res && res.status}`);
    }
    return data.status || null;
}

/** 这一次构建结束了吗（成功与否都算结束；`code === null` = 还没跑完） */
export function isBuildFinished(status) {
    return !!status && !status.running && status.code !== null && status.code !== undefined;
}

/**
 * 把产出的总包取回来，包成一个 `File`（走既有的导入通道，与「选择文件」那条路完全一样）。
 *
 * @param {Function} [fetchImpl]
 * @param {Function} [FileImpl] - `File` 构造器（单测里可注入桩）
 * @returns {Promise<File>}
 */
export async function fetchPackageFile(fetchImpl = globalThis.fetch, FileImpl = globalThis.File,
    base = resolvedBase()) {
    // `?t=<时间戳>`：绕开可能的中间缓存（本机服务器本来就 `no-store`，多一道保险）
    const res = await fetchImpl(`${urlOf(base, PACKAGE_URL)}?t=${Date.now()}`, { cache: 'no-store' });
    if (!res || !res.ok) throw new Error(`取包失败：HTTP ${res && res.status}`);
    const blob = await res.blob();
    const name = PACKAGE_URL.split('/').pop();
    if (typeof FileImpl === 'function') return new FileImpl([blob], name, { type: 'application/json' });
    // 退路（老环境没有 File）：把 blob 补成"像 File 一样"的形状
    blob.name = name;
    return blob;
}

/** 这一步现在是什么状态（给界面画进度用） */
export function stepMark(state) {
    return ({ pending: '·', running: '⏳', ok: '✅', fail: '❌', skip: '⏭️' })[state] || '·';
}
