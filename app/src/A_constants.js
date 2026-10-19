// ================================================================
// 常量与配置
// ================================================================

// 评测结果词汇表（与 scripts/crate.py 的 STATUS_OPTIONS **完全对齐**）
//
// ⚠️ `CE`（编译错误）必须在这张表里：没有它，
//    各来源的编译错误一律被洗成 `-`（`cf_adapter` / `atcoder_adapter` 明写、HDU/牛客那边
//    映射出来的 `CE` 又在 `normalize_status` 那一层被丢掉）—— 那是**有意义的结论**，不该丢。
// ⚠️ `ILE`（CF 交互题空转 `IDLENESS_LIMIT_EXCEEDED`）**与 TLE 同色**。
//
// ⚠️ **这不等于"只允许这几个值"**：`crate.normalize_status()` 对**非空但认不出**的文本会给
//    一个**英文缩写**（`HACK` / `PC` / `PD` / `JG`…）
//    ⇒ 树上的 `status` 可能是**枚举之外**的短码；界面对这种值用 `RESULT_COLOR_UNKNOWN`（淡灰）
//    渲染，编辑弹窗也会把它**补进下拉选项**（否则 `<select>` 会把它静默改成空串）。
// ⚠️ `P.AC`（部分分）：
//    QOJ 按测试点部分给分的场次，一行 Result 会写成 `AC , WA` ⇒ 归一成 `P.AC`。
//    ⚠️ 这个值**字面带一个点**；它只当**值**用（`RESULT_COLORS[status]`、
//    来源层的 `v`、下拉的 `value`），从不进类名/选择器/文件名 ⇒ 那个点不会惹事。
export const STATUS_OPTIONS = ['AC', 'WA', 'TLE', 'RE', 'MLE', 'OLE', 'CE', 'ILE', 'P.AC', '-'];

export const STATUS2_COLORS = {
    0: '#ffffff', 1: '#fef9c3', 2: '#fed7aa', 3: '#d1fae5', 4: '#00db00', 5: '#e5e7eb'
};

/** 容器（C/W/S）颜色条：按 statusComplete2 的完成度分色（缺省白） */
export const CONTAINER_STATUS_COLORS = {
    1: '#bfdbfe',   // 有接触
    2: '#d1fae5',   // 全部处理
    3: '#00db00',   // AK
    4: '#e5e7eb'    // 忽略
};

export const STATUS2_LABELS = ['未使用', '待写', '已提交未通过', '赛后补题', '赛时通过', '忽略'];

/**
 * 状态2 的**全部取值**（`0..5`）—— 下拉框、循环都从这张表派生。
 * ⚠️ 与 `STATUS2_LABELS` / `STATUS2_ICONS` / `STATUS2_COLORS` **必须一样长**：
 *    散在各页面手写 `['0','1',…,'5']` 时，加一档就会出现"标签加了、下拉里选不到"
 *    （必须避免这种事）。守卫见 `src/test/status2Tables.test.js`。
 */
export const STATUS2_VALUES = Object.keys(STATUS2_COLORS).map(Number).sort((a, b) => a - b);

/**
 * 状态2 的**短图标**（与 `STATUS2_LABELS` 同序；只是为了让对比页扫得快）。
 * 图标在这张表里，而不是在对比页里：加一档状态时标签/取值/图标要一起长。
 */
export const STATUS2_ICONS = ['⬜', '⚪', '🔴', '🟢', '✅', '⛔'];

/**
 * 编辑面板里 `status2` 那一项的**文案与取值**（派生，别再各写一份）。
 * 放这里而不是写死在 `ui/G_modal/editForm.js`：两处各写一份，文案与词表会漂
 * （"赛后补题通过" vs 词表的"赛后补题"），加一档还会出现"标签加了、下拉里选不到"。
 * 守卫见 `src/test/status2Tables.test.js`。
 */
export const STATUS2_FIELD_INFO = Object.freeze({
    label: '状态2 (' + STATUS2_VALUES.map(i => i + STATUS2_LABELS[i]).join('/') + ')',
    options: Object.freeze(STATUS2_VALUES.map(String))
});

/**
 * 状态2 的**最大取值**（校验用；由取值表派生）。
 * ⚠️ 校验里**不许写死 `5`**：加一档时下拉给得出 `6`、校验却拒收，这是必须避免的事故。
 *    用在 `ui/G_modal/editForm.js` 与 `core/ops/node.js` 两处校验。
 */
export const STATUS2_MAX = STATUS2_VALUES[STATUS2_VALUES.length - 1];

/**
 * 评测结果的颜色 —— ⚠️ 它**同时**用在两处：R 方框上那串状态**文字色**（`builders.js`
 * 的 `statusDisplay`）与色条（`renderers.js` 的 `colorBarColor`）⇒ 必须**在白底上读得清**。
 * `CE`（编译错误）：取**深金黄**而不是纯黄 —— 纯黄 `#facc15` 当文字在白底上几乎看不见
 * （对比度 ~1.4:1），深一档的 `#ca8a04` 与 OLE 橙 `#f97316` 同一亮度档、白底读得清，
 * 色相仍明确是"黄"。
 * `ILE`（交互题空转）：**与 TLE 同色** —— 两者都是"没在规定时间内出结果"。
 * `P.AC`（部分分）：**浅绿** `#4ade80` —— 比 AC 的亮绿浅一档，
 * 语义上正对"过了一部分"。
 * ⚠️ **枚举之外的值**（`normalize_status` 自造的缩写，如 `HACK`/`JG`）走
 * `RESULT_COLOR_UNKNOWN`（**淡灰**）。
 */
export const RESULT_COLORS = {
    'AC': '#00db00', 'WA': '#ef4444', 'TLE': '#1f2937', 'RE': '#aa00aa',
    'MLE': '#3b82f6', 'OLE': '#f97316', 'CE': '#ca8a04', 'ILE': '#1f2937',
    'P.AC': '#4ade80', '-': '#ffffff'
};

/** 「不在 `STATUS_OPTIONS` 里的非空状态」的颜色 —— **淡灰**（`-`/空另有其色：白） */
export const RESULT_COLOR_UNKNOWN = '#9ca3af';

export const CF_COLORS = [
    // ⚠️ 0/负 = "没有难度" ⇒ 更淡的灰；**1~799 与 800 同灰**（用户 2026-10-13：
    //    "我想让 1~799 也显示 800 一样的灰"）——这两档原来共用 `[−∞,799]` 的 `#e5e7eb`，
    //    那个色淡到几乎看不出（`cf 2` 在面板里就是一片发白）。
    { range: [Number.NEGATIVE_INFINITY, 0], color: '#e5e7eb' },
    { range: [1, 799], color: '#9ca3af' },
    { range: [800, 1199], color: '#9ca3af' },
    { range: [1200, 1399], color: '#15803d' },
    { range: [1400, 1599], color: '#06b6d4' },
    { range: [1600, 1899], color: '#1d4ed8' },
    { range: [1900, 2099], color: '#aa00aa' },
    { range: [2100, 2399], color: '#f97316' },
    { range: [2400, 2999], color: '#dc2626' },
    { range: [3000, Number.POSITIVE_INFINITY], color: '#dc2626' }
];

/** 标签可选颜色（**顺序即下拉框顺序**，'无色' 是默认值） */
export const TAG_COLORS = {
    '无色': '#ffffff',
    '红': '#fee2e2', '黄': '#fef9c3', '蓝': '#dbeafe', '绿': '#dcfce7',
    '紫': '#ede9fe', '橙': '#ffedd5', '黑': '#e5e7eb'
};

/** 标签颜色名（下拉框选项）—— 从上面的颜色表派生，别再手抄一份名单 */
export const TAG_COLOR_NAMES = Object.keys(TAG_COLORS);

/** 新标签的默认颜色 */
export const DEFAULT_TAG_COLOR = TAG_COLOR_NAMES[0];

export const XCPC_THRESHOLDS = [
    { lower: 0, upper: 0.11, level: 'C+' },
    { lower: 0.11, upper: 0.22, level: 'C' },
    { lower: 0.22, upper: 0.33, level: 'C-' },
    { lower: 0.33, upper: 0.56, level: 'R+' },
    { lower: 0.56, upper: 0.78, level: 'R' },
    { lower: 0.78, upper: 1.0, level: 'R-' },
    { lower: 1.0, upper: 2.0, level: '金牌+' },
    { lower: 2.0, upper: 3.5, level: '金牌' },
    { lower: 3.5, upper: 5.0, level: '金牌-' },
    { lower: 5.0, upper: 8.0, level: '银牌+' },
    { lower: 8.0, upper: 11.0, level: '银牌' },
    { lower: 11.0, upper: 15.0, level: '银牌-' },
    { lower: 15.0, upper: 20.0, level: '铜牌+' },
    { lower: 20.0, upper: 25.0, level: '铜牌' },
    { lower: 25.0, upper: 30.0, level: '铜牌-' },
    { lower: 30.0, upper: 40.0, level: '铁牌+' },
    { lower: 40.0, upper: 55.0, level: '铁牌' },
    { lower: 55.0, upper: 70.0, level: '铁牌-' },
    { lower: 70.0, upper: 85.0, level: '签到+' },
    { lower: 85.0, upper: 100.0, level: '签到' }
];

export const XCPC_COLORS = {
    'C+': '#9b59b6', 'C': '#9b59b6', 'C-': '#9b59b6',
    'R+': '#e74c3c', 'R': '#e74c3c', 'R-': '#e74c3c',
    '金牌+': '#f7dc6f', '金牌': '#f7dc6f', '金牌-': '#f7dc6f',
    '银牌+': '#bdc3c7', '银牌': '#bdc3c7', '银牌-': '#bdc3c7',
    '铜牌+': '#e8b48c', '铜牌': '#e8b48c', '铜牌-': '#e8b48c',
    '铁牌+': '#2c3e50', '铁牌': '#2c3e50', '铁牌-': '#2c3e50',
    '签到+': '#22c55e', '签到': '#22c55e'
};

// ================================================================
// 节点类型映射与子节点约束
// ================================================================

export const TYPE_LABEL_MAP = {
    'O': '超级根',
    'W': '平台',
    'S': '系列',
    'C': '比赛',
    'P': '题目',
    'R': '提交记录'
};

export const TYPE_BADGE_MAP = {
    'O': '',
    'W': '平台',
    'S': '系列',
    'C': '比赛',
    'P': 'P.',
    'R': ''
};

// ================================================================
// 渲染相关常量
// ================================================================

export const BOX_COUNT_KEY = 'boxCount';
export const DEFAULT_BOX_COUNT = 15;
// ⚠️ 这里原来有个 `STORAGE_WARNING_THRESHOLD_MB = 45`（已删）：它来自**老 Firefox 在
//    IndexedDB 超过 50MB 时会弹窗要权限**（`dom.indexedDB.warningQuota`）那个年代。
//    现在警戒线**只看真实配额比例**（`view/info.js` 的 `QUOTA_WARN_RATIO` = 50% /
//    `QUOTA_FULL_RATIO` = 90%，`navigator.storage.estimate()`）—— 判据只有那一条。

// ================================================================
// 事件名常量（全部统一管理）
// ================================================================

export const EVENTS = {
    // 持久化事件
    DB_MODIFIED: 'acmtree:db-modified',
    DB_SAVED: 'acmtree:db-saved',
    JSON_MODIFIED: 'acmtree:json-modified',
    JSON_SAVED: 'acmtree:json-saved',

    // UI 刷新事件
    UI_REFRESH_REQUIRED: 'acmtree:ui-refresh-required',
    PAGE_TABS_REFRESH_REQUIRED: 'acmtree:page-tabs-refresh-required',
    CURRENT_PAGE_REFRESH_REQUIRED: 'acmtree:current-page-refresh-required',

    // UI 反馈事件
    SHOW_TOAST: 'acmtree:show-toast',
    SHOW_MAPPING_DIALOG: 'acmtree:show-mapping-dialog',
    SHOW_PROBLEM_INFO_DIALOG: 'acmtree:show-problem-info-dialog',
    SHOW_ANOMALIES_DIALOG: 'acmtree:show-anomalies-dialog',
    // 打开「👤 账户」面板 —— 导入摘要里"线索没匹配上"那个按钮直达它
    SHOW_ACCOUNTS_DIALOG: 'acmtree:show-accounts-dialog',

    // 树操作事件
    ADD_ROOT: 'acmtree:add-root',
    ADD_CHILD: 'acmtree:add-child',
    EDIT_NODE: 'acmtree:edit-node',
    EDIT_VNODE: 'acmtree:edit-vnode',
    DELETE_NODE: 'acmtree:delete-node',
    MOVE_UP: 'acmtree:move-up',
    MOVE_DOWN: 'acmtree:move-down',
    COPY_NODE: 'acmtree:copy-node',
    CLEAR_PROBLEMS: 'acmtree:clear-problems',
    CLEAR_SUBMISSIONS: 'acmtree:clear-submissions',

    // 定位事件：把某个节点在界面上显示出来（切页/切模式/展开祖先/滚动）
    // 由 ui/revealNode.js 实现，插件只需派发本事件，无需 import ui 层
    REVEAL_NODE: 'acmtree:reveal-node',

    // 批量操作事件
    BATCH_IMPORT: 'acmtree:batch-import',
    BATCH_SUBMIT_IMPORT: 'acmtree:batch-submit-import',
    BATCH_CONTEST_IMPORT: 'acmtree:batch-contest-import',
    BATCH_PROBLEM_INFO: 'acmtree:batch-problem-info',

    // 排序事件
    SORT_PROBLEMS: 'acmtree:sort-problems',
    SORT_SUBMISSIONS: 'acmtree:sort-submissions',

    // 副页事件
    PAGE_DATA_CHANGED: 'acmtree:page-data-changed',
    PAGES_SAVE_FAILED: 'acmtree:pages-save-failed',
    FOLDER_PAGE_CHANGE: 'acmtree:folder-page-change',

    // 主视图页切换事件
    SWITCH_PAGE: 'acmtree:switch-page',

    // 导出事件
    EXPORT_JSON: 'acmtree:export-json',
    EXPORT_FULL: 'acmtree:export-full',
    EXPORT_FULL_GZ: 'acmtree:export-full-gz',
    IMPORT_FULL: 'acmtree:import-full',
    AUTO_EXPORT_TRIGGERED: 'acmtree:auto-export-triggered',
};

// ================================================================
// 映射存储键
// ================================================================

export const MAPPING_KEYS = {
    BATCH_IMPORT: 'batchImportMapping_v1',
    SUBMIT: 'batchSubmitMapping_v1',
    CONTEST: 'batchContestMapping_v1',
};

// 分页配置
export const DEFAULT_NODE_PER_PAGE = 20;
export const NODE_PER_PAGE_KEY = 'nodePerPage';

// 展开节点数限制
export const EXPANDED_NODE_WARNING_LIMIT_KEY = 'expandedNodeWarningLimit';
export const EXPANDED_NODE_BLOCK_LIMIT_KEY = 'expandedNodeBlockLimit';
export const DEFAULT_EXPANDED_NODE_WARNING_LIMIT = 2500;
export const DEFAULT_EXPANDED_NODE_BLOCK_LIMIT = 5000;

// 副页数量上限
export const MAX_PAGES = 50;

// ================================================================
// ★ 历史记录配置
// ================================================================

export const DEFAULT_HISTORY_STEPS = 25;
export const MAX_HISTORY_STEPS = 100;
export const HISTORY_STEPS_KEY = 'historySteps';
export const BOX_DISPLAY_MODE_KEY = 'boxDisplayMode';
export const DEFAULT_BOX_DISPLAY_MODE = 'cf';  // 'cf' | 'xcpc'

// ★ AC列表统计独立设置
export const AC_STATS_SHOW_SPECIAL_KEY = 'acStatsShowSpecial';

// ================================================================
// 编辑模式常量
// ================================================================

export const EDIT_MODE_ATTRIBUTE = 'attribute';
export const EDIT_MODE_SELECTION = 'selection';
export const DEFAULT_EDIT_MODE = EDIT_MODE_ATTRIBUTE;

// ================================================================
// 统计视图筛选模式常量
// ================================================================

export const STATS_FILTER_MODES = {
    ALL: 'all',
    SP_ANCESTOR: 'sp_ancestor',
    SELECTED_ANCESTOR: 'selected_ancestor',
    PAGE_MAPPING_ONLY: 'page_mapping_only'   // ★ 仅选中副页映射（仅 projected）
};
export const DEFAULT_STATS_FILTER_MODE = STATS_FILTER_MODES.ALL;

// ================================================================
// 应用版本与运行时常量
// ================================================================

export const APP_VERSION = 'v9.5.0';

/**
 * 构建标记 —— **只在你改了"应用行为"时递增**，用来一眼分辨
 * "代码写错了"与"浏览器还在跑缓存的旧模块"。
 *
 * 形如 `<对外版本>-<改动摘要>-<序号>`；页面标题、`__ACM_BUILD__`、探活都读它。
 */
export const APP_BUILD = 'v9.5.0-hdu-required-not-auth-394';

/**
 * 长处理自测的阈值（`utils/longHandler.js`）。
 *
 * 浏览器那条 `[Violation] 'click' handler took xxxms` 的阈值是 **Blink 里的常量**
 * （`PerformanceMonitor`），**页面改不了** —— 所以应用自己量一份，阈值自己定。
 * 50ms 比浏览器细一档：优化到 100ms 以下也看得见。
 */
export const LONG_HANDLER_THRESHOLD_MS = 50;

// 分页标签 ID
// 注意：一级 Tab 的权威列表由 ui/tabs.js 从 index.html 的静态按钮读取，
// 并合并 plugins 通过 api.registerTab 注册的插件页；本常量仅作内置页速查，
// 不要再用于「是否为合法 Tab」的判断（请用 tabs.js 的 isKnownTab）。
export const TAB_IDS = ['main', 'stats'];

// 自动保存重试延迟（毫秒）
export const AUTO_SAVE_RETRY_DELAY = 5000;

