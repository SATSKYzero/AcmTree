// ================================================================
// "手改"判据：用户到底在哪个输入框里**敲过字**（ui/G_modal/manualInput.js）
//
// 为什么要单独一个模块
// --------------------
// 来源层里，`manual`（手改）优先级最高（core/trust.js 的 categoryRank）。
// 用户定的判据是「**值是通过手动途径输入的**」——不是"值变了"。
// 所以界面必须能回答一个问题：**这一次弹窗里，用户真的输入过哪些字段？**
//
// ★ 判据是"用户敲键盘"这个真实信号
// --------------------------------
// 用户输入会让输入框触发 `input` 事件；而程序里 `el.value = x`（例如来源面板
// 的「优先」把重算后的值同步进输入框）**不会触发任何事件**。
// 于是"弹窗里被 user 打过字的字段集合"就是一个**不可能被程序伪造**的证据。
//
// ⚠️ 为什么必须用**正向**信号
// --------------------------
// 反向判据（给定某个"程序写入过"的标记，**按"没有这个标记"**判定手改）会出错：
// 只要输入框没被打标记就算手改：
//   * 用户一个键都没敲，弹窗里没被同步过的字段（例：ratio）照样算手改；
//   * 于是"点某个字段来源行的 优先"会把**另一个字段**记成 manual ——
//     而 manual 优先级最高，用户的偏好/来源等级从此永远失效。
// 正向信号（input 事件）不可能这样被骗：没敲过 = 不在集合里。
//
// 会话管理
// --------
// 集合按**弹窗会话**管理：弹窗打开时清空（`beginInputSession()`），
// 点「确定」时取（`typedFields([...候选字段])`）。
// P 弹窗（G4_edit.js）与 W/S/C 弹窗（G2_common.js 的 showFormDialog）都要清。
// 注意：清空点必须放在**弹窗打开**处，而不是 createModal 里 ——
// 点「确定」时可能弹出二级确认框（confirmAnomalies），
// 若在 createModal 里清空，那份"用户敲过字"的证据会被二级弹窗冲掉。
//
// 依赖：无（不 import 任何业务模块，纯 DOM 信号）。
// ================================================================

/** 输入框 id 的统一前缀（见 G4_edit.js / G2_common.js 的字段渲染） */
const FIELD_ID_PREFIX = 'field-';

/** 本次弹窗会话里，用户**敲过字**的字段集合 */
let typedFieldsInSession = new Set();

/** 从元素身上认出它对应哪个业务字段（`field-ratio` → `ratio`） */
function fieldOfElement(el) {
    if (!el || typeof el.id !== 'string') return '';
    if (!el.id.startsWith(FIELD_ID_PREFIX)) return '';
    return el.id.slice(FIELD_ID_PREFIX.length);
}

/**
 * 开启一次新的弹窗输入会话（**弹窗打开时**调用）。
 * 幂等且廉价：只是换一个新的空集合。
 */
export function beginInputSession() {
    typedFieldsInSession = new Set();
}

/**
 * 登记"这个字段是用户手动输入的"。
 *
 * 正常路径由下面的委托监听自动调用；导出它是为了：
 *   ① 测试可以显式模拟"用户敲字"；
 *   ② 将来若有非 `<input>` 的手动输入入口（自定义控件），可以直接登记。
 *
 * @param {string} field - 内部字段名（如 'ratio'）
 */
export function noteTypedField(field) {
    const f = String(field || '');
    if (f) typedFieldsInSession.add(f);
}

/** 用户这次弹窗里**有没有**在某个字段上敲过字 */
export function hasTypedInput(field) {
    return typedFieldsInSession.has(String(field || ''));
}

/**
 * 候选字段里**真正被用户手动输入过**的那些（交给 `updateP` 的 `opts.manualFields`）。
 *
 * @param {string[]} candidates - 该弹窗关心的业务字段（P 弹窗是 `['name','ratio']`）
 * @returns {string[]}
 */
export function typedFields(candidates) {
    const list = Array.isArray(candidates) ? candidates : [];
    return list.filter(key => typedFieldsInSession.has(key));
}

/**
 * 委托式登记（模块被 import 时执行一次）。
 *
 * 为什么委托到 document：弹窗内容由 `innerHTML` 拼出来（P 弹窗自己拼、
 * W/S/C 走 showFormDialog），逐个字段挂监听既啰嗦又容易漏；
 * `input` 事件是**冒泡**的，在 document 上听一次就够。
 *
 * `change` 也一起听：`<select>` 在部分浏览器/场景只保证 `change`。
 * 两者都只在**用户交互**时触发，程序赋 `el.value` 永远不会触发。
 */
for (const type of ['input', 'change']) {
    document.addEventListener(type, event => {
        const field = fieldOfElement(event && event.target);
        if (field) typedFieldsInSession.add(field);
    });
}

export { FIELD_ID_PREFIX };
