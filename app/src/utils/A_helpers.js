// ================================================================
// 通用工具函数入口（utils/A_helpers.js）
// 职责：统一 re-export，方便调用方从一个路径获取所有工具
// 说明：实际实现在 utils/id.js / html.js / time.js / color.js / event.js
// ================================================================

export { genId, genTagId } from './id.js';
export { escapeHtml } from './html.js';
export { getNowStr, formatTime, displayTime, normalizeTime } from './time.js';
export { getCfColor, getXcpcDifficulty, getXcpcRange } from './color.js';
export { emit } from './event.js';