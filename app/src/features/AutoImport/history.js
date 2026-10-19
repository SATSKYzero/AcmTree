// ================================================================
// 节点自动导入 — 导入记录（features/AutoImport/history.js）
// 职责：把每次导入的摘要写进 settings.autoImport.history（只留最近 N 条）
// 依赖：shell/state.js, shell/executor.js, ./constants.js
//
// 记录里存什么（决策 14）：
//   - 计数与来源、时间
//   - **未使用字段的列名**（只记名，绝不记值）——
//     目的是将来想存「内存」时，知道爬虫早就在给这个字段了
//
// 说明：本模块 import shell/，不进 Node 单测，由冒烟测试覆盖。
// ================================================================
import { AppState } from '../../shell/state.js';
import { execute } from '../../shell/executor.js';
import { SETTINGS_KEY, HISTORY_LIMIT } from './constants.js';

/** 读导入记录（副本） */
export function readHistory(state = AppState) {
    const box = state && state.settings ? state.settings[SETTINGS_KEY] : null;
    const list = box && Array.isArray(box.history) ? box.history : [];
    return list.map(h => ({ ...h }));
}

/**
 * 追加一条导入记录（走事务，可撤销）
 *
 * @param {Object} entry
 * @returns {Promise<boolean>} 是否写入成功
 */
export async function appendHistory(entry) {
    const record = {
        at: entry.at || new Date().toISOString(),
        source: String(entry.source || ''),
        file: String(entry.file || ''),
        created: Number(entry.created) || 0,
        updated: Number(entry.updated) || 0,
        skipped: Number(entry.skipped) || 0,
        failed: Number(entry.failed) || 0,
        // 换父（重挂）了几条：结构改动要留痕，事后能解释"这场怎么换位置了"
        moved: Number(entry.moved) || 0,
        unusedColumns: Array.isArray(entry.unusedColumns)
            ? entry.unusedColumns.map(String).slice(0, 40)
            : [],
        // 归认摘要：人话一句 + 两个可行动的数字
        // （认不出来时用户唯一能做的就是补映射，所以这两个数必须留下来）
        accounts: String(entry.accounts || ''),
        accountsMatched: Number(entry.accountsMatched) || 0,
        accountsUnmatched: Number(entry.accountsUnmatched) || 0
    };

    try {
        await execute(draft => {
            // settings 下可能还没有 autoImport 盒子
            if (!draft.settings[SETTINGS_KEY]) {
                draft.settings[SETTINGS_KEY] = { history: [] };
            }
            const box = draft.settings[SETTINGS_KEY];
            if (!Array.isArray(box.history)) box.history = [];

            box.history.unshift(record);
            if (box.history.length > HISTORY_LIMIT) {
                box.history.length = HISTORY_LIMIT;   // 只留最近 N 条
            }
        }, { skipHistory: true, validate: false });
        return true;
    } catch (err) {
        console.error('[AutoImport] 写入导入记录失败:', err);
        return false;
    }
}

/** 清空导入记录 */
export async function clearHistory() {
    try {
        await execute(draft => {
            if (draft.settings[SETTINGS_KEY]) draft.settings[SETTINGS_KEY].history = [];
        }, { skipHistory: true, validate: false });
        return true;
    } catch (err) {
        console.error('[AutoImport] 清空导入记录失败:', err);
        return false;
    }
}
