// ================================================================
// id 生成（utils/id.js）
// 职责：生成唯一节点 id / 标签 id
// 依赖：shell/state.js（读 meta.idCounter）
// ================================================================
import { AppState } from '../shell/state.js';

export function genId() {
    return 'n_' + (++AppState.meta.idCounter) + '_' + Date.now().toString(36);
}

export function genTagId() {
    return 't_' + (++AppState.meta.idCounter) + '_' + Date.now().toString(36);
}