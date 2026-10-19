// ================================================================
// 节点工厂（core/model/node.js）
// 职责：创建节点、计算派生字段
// 依赖：constants.js, utils/time.js, core/pluginRegistry.js
// ================================================================
import { TIME_PLACEHOLDER } from './constants.js';
import { getNowStr } from '../../utils/time.js';
import { runNodeMigrations } from '../pluginRegistry.js';

// ---- 通用默认字段（所有类型共有） ----
// ⚠️「性质」四字段（natureClass/natureYear/natureSeason/natureRegion）**故意不在这里**：
//    口径是"四个字段都要能可空 —— 没标就是没标，别写默认值占位"。
//    所以它们按 `extKey` 那套走**插件迁移**只补缺键
//    （`features/AutoImport/index.js` 的 registerNodeMigration / registerVNodeMigration），
//    节点上仍然只有"缺键"这一种"没有值"的表达。
const COMMON_DEFAULTS = {
    remark: '',
    link: '',
    selected: false,
    // 「这个容器的兄弟顺序是人定过的」（见 `elements.js` 的 `manualOrder`）：
    //   有它 ⇒ 导入后的同层重排**跳过**这个容器（手动顺序不会被冲掉）。
    manualOrder: false,
    // 来源层：`{ 字段: [{v, src, at}] }` —— "这个字段的每个值是谁给的"。
    // 投影值（node.name 等）仍是普通字段，调用方不需要改（来源层另存，两者互不干扰）。
    values: {}
};

// ---- 各类型特有默认字段 ----
const TYPE_DEFAULTS = {
    'O': {
        name: ''
    },
    'W': {
        name: '',
        statusComplete1: 0,
        statusComplete2: 0
    },
    'S': {
        name: '',
        statusComplete1: 0,
        statusComplete2: 0
    },
    'C': {
        name: '',
        statusComplete1: 0,
        statusComplete2: 0,
        contestTime: '',
        // C 的榜单链接（与泛化的 `link` 分开）
        // C 的种类 —— `contest` 真实比赛 / `practice` 练习容器（散题挂在它下面）
        kind: 'contest',
        // 合成（core/ops/synth.js）：C 既能当**合成节点**（有非空 synthKey），
        // 也能当**成员**（ownerSynth 指向某个 synthKey）。两者互斥、都可留空。
        synthKey: '',
        ownerSynth: ''
    },
    'P': {
        name: '',
        acTime: TIME_PLACEHOLDER,
        lastSubmitTime: TIME_PLACEHOLDER,
        status1: 0,
        status2: 0,
        problemId: '',
        // ★ 「这一组人确认过」的**组级标记**（只落在题目组头上；名字见 elements.js 的 CONFIRM_FIELD_NAME）
        已确认: false,
        // ★ 「这一条与同号那道题不是同一道」（成员级；见 elements.js 的 SPLIT_FIELD_NAME）
        拆开: false,
        cfDifficulty: 0,
        atcoderDifficulty: 0,
        clistDifficulty: 0,
        tags: [],
        ratio: '',
        xcpcDifficulty: '-',
        // 跨场身份 —— 同一道题出现在多个比赛时共享同一个值（如 `cf:gym:106701:A`）。
        // 树仍是树（每个 P 有自己的主父）；要"跨场完成情况"时按它分组即可。
        identityKey: '',
        // 合成：同 C（题目也能被合成 —— 例如同一道题被两个 OJ 各出一份）
        synthKey: '',
        ownerSynth: ''
    },
    'R': {
        time: TIME_PLACEHOLDER,
        status: '-',
        // 提交的性质（赛时 / VP / 补题）。**空 = 判不出/还没判**，不是"未知"这种值。
        submitKind: '',
        // 「先提取备用」：提交的运行信息（CF/QOJ 都有）。口径：毫秒 / 字节。
        language: '',
        timeUsed: '',
        memoryUsed: '',
        codeLength: '',
        // 合成：提交记录也能被合成（同一场在两个榜单上各抓一份提交时）
        synthKey: '',
        ownerSynth: ''
    }
};

// ---- 创建节点（纯函数，不依赖 State） ----
export function createNode(id, type, overrides = {}) {
    const typeDefaults = TYPE_DEFAULTS[type];
    if (!typeDefaults) {
        throw new Error(`未知节点类型: ${type}`);
    }
    const now = getNowStr();
    const node = {
        id,
        type,
        createdAt: now,
        lastModified: now,
        ...COMMON_DEFAULTS,
        ...typeDefaults,
        ...overrides
    };
    // ⚠️ 上面是**浅拷贝**，所以对象/数组默认值会在所有节点之间共享。
    //    `tags: []` 一直潜伏着这个问题（只要谁原地 push 就会污染全部节点），
    //    `values` 也踩中了它（来源层会跨节点串味）。
    //    这里统一给每个节点一份自己的容器 —— 创建节点是唯一入口，修在这里最省事。
    node.values = {};
    if (Array.isArray(node.tags)) node.tags = node.tags.slice();
    runNodeMigrations(node);
    return node;
}

// ---- 获取某类型的默认字段（供 UI 表单使用） ----
export function getNodeDefaults(type) {
    return {
        ...COMMON_DEFAULTS,
        ...(TYPE_DEFAULTS[type] || {})
    };
}