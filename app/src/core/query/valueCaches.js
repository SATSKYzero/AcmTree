// ================================================================
// 值缓存的"接代"（core/query/valueCaches.js）
//
// 职责：**纯顺序改动**（上移 / 下移这种只换兄弟位置的）之后，把各份"按代缓存"的
//   派生值**接到新一代上** —— 不清、不重算。
//
// 为什么可以：派生值/计数**与兄弟顺序无关**（聚合都是可交换的加法/取或）。
//   真包实测（27206 节点 × plain/dedup 两种模式）：
//     · 那一趟的全部输出（本身值 / P 桶 / C 桶 / 📊分布）逐节点对拍 **0 不同**；
//     · 组那份覆盖表（dedup 17093 条）**逐条相同**；
//     · 而兄弟顺序**确实换了**。
//   ⇒ 换了 `nodes`/`childOrder` 的引用只是 Immer 的结构共享，不代表值变了；
//     不接的话，下一次读会白跑一整趟（实测 ~150~250ms）。
//
// ⚠️ **只许在"值确实没变"的改动上用**（调用方用 `orderOnly` 声明），
//    别拿它当"随便改都接一下"的通用开关。
// ================================================================
import { rekeyCountCache } from './countCache.js';
import { rekeyDerivedMemo } from '../derive.js';
import { rekeyGroupMemo } from '../groupCompute.js';

/** 把三份按代缓存（那一趟 / 派生表 / 组表）都接到 `state` 这一代上 */
export function rekeyValueCaches(state) {
    rekeyCountCache(state);
    rekeyDerivedMemo(state);
    rekeyGroupMemo(state);
}
