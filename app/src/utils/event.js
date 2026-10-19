// ================================================================
// 事件工具（utils/event.js）
// 职责：CustomEvent 派发
// 依赖：无
// ================================================================

export function emit(eventName, detail) {
    document.dispatchEvent(new CustomEvent(eventName, { detail }));
}