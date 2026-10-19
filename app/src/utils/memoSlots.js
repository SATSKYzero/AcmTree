// ================================================================
// 按**页 id** 分槽的记忆表（`utils/memoSlots.js`）
//
// 来由（用户 2026-10-18 连续追问，每一条都对应前面一版的具体毛病）：
//   ① "你的记忆化怎么是共用槽位的？" —— 原来是"只留最近一份"（模块级一个 `let` 或 `clear()+set()`）
//     ⇒ 数据没变时同一页连画两次能命中，但**两个副页来回切（A→B→A）每次全落空**。
//   ② "改成独立槽位" —— 我加了"上限 N 页、丢最久没用"，那还是**一个池子里抢格子** ⇒ 改成每页一格。
//   ③ "为什么不收？？" —— 每页一格之后，删掉的页会留一格没人清 ⇒ 我把键换成**页对象** + `WeakMap`，
//     让"没人引用就自动回收"。
//   ④ "副页折叠现在慢啊" —— `expanded` 存在 vNode 上，折一下就换一个新页对象 ⇒ **页对象当键的缓存
//     每折一次全作废**（桶缓存白算、统计记忆化白算）。这就是 ③ 那个选择的副作用。
//
// ⇒ 现在：**键 = 页 id（字符串）**（折叠不会变）+ **显式回收**（`prune(aliveIds)`，每趟顺手丢掉已删的页）。
//   "记得去清"这件事没人要记得 —— 由 `prune()` 在每次取用前自动做。
//
// ⚠️ 槽里存的**只是结果**，"能不能用"仍由调用方逐项按引用比（`nodes` / 结构签名 / 账户…）。
// ⚠️ 调用方**必须调 `prune()`**（否则删掉的页会留一格）。判据：`src/test/perfGuards.test.js` ⑬。
// ================================================================

/**
 * 造一份"每页一格"的记忆表。
 * @returns {{get:(id:string)=>*, set:(id:string,v:*)=>void, drop:(id:string)=>void,
 *            prune:(alive:Iterable<string>)=>number, size:()=>number, clear:()=>void}}
 */
export function createSlots() {
    const map = new Map();
    return {
        get(id) {
            return typeof id === 'string' ? map.get(id) : undefined;
        },
        set(id, value) {
            if (typeof id === 'string') map.set(id, value);      // 只写这一页那一格，不淘汰别的页
        },
        drop(id) {
            map.delete(id);
        },
        /** 丢掉"已经不存在的页"那些格（传当前活着的页 id 集合）；返回丢了几个 */
        prune(alive) {
            const keep = alive instanceof Set ? alive : new Set(alive || []);
            let dropped = 0;
            for (const id of [...map.keys()]) {
                if (!keep.has(id)) { map.delete(id); dropped++; }
            }
            return dropped;
        },
        size() {
            return map.size;
        },
        clear() {
            map.clear();
        }
    };
}
