// ================================================================
// 方框上的「计划强度角标」展示位（`src/view/nodeBadge.js`）
//
// 干什么：副页里每个节点方框上，按住 Ctrl 时显示 **`剩 X / 共 Y`**
// （用户 2026-10-15："副页按下 Ctrl 时每个节点方框显示计划内剩余强度的总和" ⇒ 定了"两个都显示"）。
//
// ⚠️ **这里只存"算好的文案"**：
//   · 数字怎么算在 `core/trainingPlan.js:planSubtreeIntensityOf`（纯函数、有单测）；
//   · 谁来算、什么时候算在 `ui/plan/pageBadges.js`（计划侧）；
//   · `view/` **不许 import 计划模块** ⇒ 只能由计划侧 `setNodeBadges()` **注入**过来。
//     这样 `view/` 依旧不认识"计划"这个概念，只是"这一格有个角标要画"。
//
// ⚠️ 键是**页内 id**（vNode id）—— 方框画的就是页内节点；主页没有角标（计划侧给空）。
// ⚠️ 只读、纯展示：这里不写任何数据、也不进包。
// ================================================================

/** 页内 id → 文案（`null` = 没有角标） */
let current = null;

/**
 * 注入（计划侧调；传空 ⇒ 清掉）。
 * @param {Object<string,string>|null} map
 */
export function setNodeBadges(map) {
    current = (map && typeof map === 'object' && Object.keys(map).length) ? map : null;
}

/** 这一个节点方框的角标文案（没有 ⇒ `null`） */
export function nodeBadgeOf(id) {
    if (!current) return null;
    const text = current[String(id || '')];
    return text ? String(text) : null;
}

/** 现在有没有角标（渲染前判一下，省一次拼接；也给冒烟用） */
export function hasNodeBadges() {
    return !!current;
}
