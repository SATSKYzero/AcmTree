// ================================================================
// 事务层统一导出（transaction/index.js）
// ================================================================
export {
    executeTransaction,
    undo,
    initHistory,
    getHistoryCount,
    applyHistoryLimit
} from './executor.js';

export {
    captureState,
    applyState,
    getHistory,
    resetHistory,
    clearHistory,
    setHistoryFromArray
} from './history.js';