// ================================================================
// 会话级信息状态（core/model/infoState.js）
// 职责：管理 UI 状态标记（打开时间、保存时间、导出标记）
// 说明：不参与 Immer，不参与快照，不进 State
// 依赖：无
// ================================================================

export const InfoState = {
    openTime: Date.now(),
    lastSaveTime: null,
    lastModifiedTime: Date.now(),
    dbIsSaved: true,
    jsonIsSaved: true,
    jsonLastSaveTime: null
};

// ---- 加载后重置 ----
// 规则（决策：问题 4）：
//   openTime：刷新后重取 Date.now()
//   lastSaveTime / lastModifiedTime / jsonLastSaveTime：从磁盘恢复
//   dbIsSaved：刷新后固定为 true
//   jsonIsSaved：从磁盘恢复
export function restoreInfoState(saved) {
    InfoState.openTime = Date.now();
    InfoState.lastSaveTime = saved?.lastSaveTime ?? null;
    InfoState.lastModifiedTime = saved?.lastModifiedTime ?? Date.now();
    InfoState.dbIsSaved = true;
    InfoState.jsonIsSaved = saved?.jsonIsSaved ?? true;
    InfoState.jsonLastSaveTime = saved?.jsonLastSaveTime ?? null;
}

// ---- 数据被修改 ----
// 两个标记语义不同，不可一起无条件清除：
//   dbIsSaved   ← persist: true 的字段变了
//   jsonIsSaved ← export: true 的字段变了（即"导出文件是否还是最新版本"）
// 例：切 tab 只改 currentTab（persist:true / export:false），
//     数据版本没变，导出文件依然是最新的，不应显示"JSON未导出"。
/**
 * @param {{persisted?: boolean, exported?: boolean}} [flags]
 *   缺省两者皆真 = "一律标记脏"
 */
export function markModified(flags = {}) {
    const { persisted = true, exported = true } = flags;
    InfoState.lastModifiedTime = Date.now();
    if (persisted) InfoState.dbIsSaved = false;
    if (exported) InfoState.jsonIsSaved = false;
}

// ---- 数据已保存到 DB ----
export function markSaved() {
    InfoState.lastSaveTime = Date.now();
    InfoState.dbIsSaved = true;
}

// ---- 数据已导出 JSON ----
export function markJsonSaved() {
    InfoState.jsonIsSaved = true;
    InfoState.jsonLastSaveTime = Date.now();
}