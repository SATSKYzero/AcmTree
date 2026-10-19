// ================================================================
// 链接块（view/linkChips.js）—— C 节点的「🔗 链接」整块显示
//
// 为什么单独一个文件：`builders.js` 会牵进 `shell/state.js`（依赖 `immer`，单元测试里
// 装不上），渲染逻辑放在那儿就**永远测不到**。这里只依赖 `core/fieldValue.js`
// 与 `utils/html.js`（都是自足的），于是口径可以被契约测试钉住。
//
// 依据：`docs/field-rules.md`
//   * "`link` 的性质是补题链接…与榜单链接**没有主次关系**" → 按类别**平级**分组，不设主链接；
//   * "「仓库」与「未知」两类也应在**非空时显示**" → 这两类也成组，不许藏；
//   * "显示『链接』下若干小标题的一整块" → `🔗 链接 (N)` 是**折叠头**，展开才是那个块。
//
// ⚠️ 折叠用原生 `<details>`/`<summary>`：**不需要一行 JS**，键盘可操作，
//    也不会和树上其它的点击/拖拽逻辑打架（自己写 toggle 就得多一个事件委托）。
// ================================================================
import { readFieldInfo } from '../core/fieldValue.js';
import { srcLabel } from '../core/sourceLabel.js';
// 类别词汇表**唯一一份**在 `core/linkKinds.js`（弹窗的来源面板也用同一份）
import { LINK_KIND_LABELS, LINK_KIND_ORDER, linkKindLabel } from '../core/linkKinds.js';
// ⚠️ 读值一律带上**查看范围**（`scopeOpts`）：不带的话会把别的账户的链接也显示出来
//（账户层是来源层的维度，视图层读值必须过这一层）。
import { scopeOpts } from './scope.js';
// ⚠️ `escapeHtml` 从 `utils/html.js` 直接取，**不要**走 `utils/A_helpers.js`：
// 后者 re-export 了 `event.js`，那条链会拉进 `shell/state.js`（依赖 `immer`）。
import { escapeHtml, EXTERNAL_LINK_ATTRS } from '../utils/html.js';

/** 类别 → 小标题（词汇表**唯一一份**在 `core/linkKinds.js`，弹窗的来源面板也用同一份） */
export const LINK_KIND_CHIPS = LINK_KIND_LABELS;

/**
 * 收集一个节点上的**全部**链接，按类别分组（空类别不返回）。
 *
 * 数据来源：来源层里 **`link`** 的每条值（`linkKind` 标着类别）。
 * **所有类别的链接都进 `link`**（没有另一份单独的榜单链接字段）。
 * 选中的那条也算（它在来源层里就有），**不会重复**（同类同 URL 去重）。
 *
 * @returns {Array<{kind:string, label:string, items:Array<{v:string, src:string, selected:boolean}>}>}
 */
export function collectLinkGroups(state, node) {
    const seen = new Set();
    const byKind = new Map();
    {
        const field = 'link';
        const info = readFieldInfo(node, field, scopeOpts(state));
        const shown = String(info.value || '');
        // `stored` = 全量（含被标"不用"的），但展示时跳过 invalid 的
        for (const one of (info.stored || [])) {
            if (!one || one.invalid) continue;
            const v = String(one.v || '');
            if (!v) continue;
            const kind = one.linkKind || 'unclassified';
            const key = `${kind}|${v}`;
            if (seen.has(key)) continue;
            seen.add(key);
            if (!byKind.has(kind)) byKind.set(kind, []);
            byKind.get(kind).push({ v, src: String(one.src || ''), selected: v === shown });
        }
        // `stored` 为空但有缓存值（v7 老数据、来源层还没回填）→ 至少显示那一个
        if (!(info.stored || []).length && info.fromCache && shown) {
            const key = `unclassified|${shown}`;
            if (!seen.has(key)) {
                seen.add(key);
                if (!byKind.has('unclassified')) byKind.set('unclassified', []);
                byKind.get('unclassified').push({ v: shown, src: '', selected: true });
            }
        }
    }
    const kinds = [...byKind.keys()].sort((a, b) => {
        const ia = LINK_KIND_ORDER.indexOf(a);
        const ib = LINK_KIND_ORDER.indexOf(b);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    return kinds.map(kind => ({
        kind,
        // 查表只走 `linkKindLabel`（唯一实现）；兜底显式传「❔ 其它」
        label: linkKindLabel(kind, LINK_KIND_CHIPS.unknown),
        items: byKind.get(kind)
    }));
}

/** 链接显示文本：太长就截断（完整 URL 放 `title`，鼠标一悬停就能看） */
export function shortLinkText(url, max = 46) {
    const u = String(url || '');
    if (u.length <= max) return u;
    return `${u.slice(0, max - 1)}…`;
}

/**
 * 渲染 C 的链接块：**折叠头 + 按类别分组的整块**。
 *
 * @param {Object} [groupLinks] **组那份链接**（`{类别:[{v,src}]}`，来自
 *        `viewDerived(..., {column:'group'})` 的 `链接分类` 组值）—— 只有合成节点用得上：
 *        组头自己没有链接（导入不给组头写 `link`）⇒ 不传这一份，组头的块就是空的。
 *        并进同一个块（同类别同 URL 去重），**出处照写**（`src` 就是那个成员的来源）。
 * @returns {string} HTML；一个链接都没有时返回空串
 */
export function buildLinkBlock(state, node, groupLinks = null) {
    const groups = collectLinkGroups(state, node);
    // 组那份并进来（**补充**，不覆盖自己那份）
    const byKind = new Map(groups.map(g => [g.kind, g]));
    for (const kind of Object.keys(groupLinks || {})) {
        const list = Array.isArray(groupLinks[kind]) ? groupLinks[kind] : [];
        for (const one of list) {
            const v = String((one && one.v) || '');
            if (!v) continue;
            if (!byKind.has(kind)) {
                byKind.set(kind, { kind, label: linkKindLabel(kind, LINK_KIND_CHIPS.unknown), items: [] });
            }
            const g = byKind.get(kind);
            if (g.items.some(it => it.v === v)) continue;      // 同类别同 URL 只留一条
            g.items.push({ v, src: String((one && one.src) || ''), selected: false });
        }
    }
    const ordered = [...byKind.values()].sort((a, b) => {
        const ia = LINK_KIND_ORDER.indexOf(a.kind);
        const ib = LINK_KIND_ORDER.indexOf(b.kind);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    const total = ordered.reduce((n, g) => n + g.items.length, 0);
    if (!total) return '';

    const sections = ordered.map(g => {
        const links = g.items.map(it => {
            const cls = it.selected ? 'link pick' : 'link';
            const title = it.src ? `${it.v}\n（来自 ${srcLabel(it.src)}）` : it.v;
            return `<a class="${cls}" href="${escapeHtml(it.v)}" ${EXTERNAL_LINK_ATTRS}`
                + ` title="${escapeHtml(title)}">${escapeHtml(shortLinkText(it.v))}</a>`;
        }).join('');
        return `<div class="link-group">`
            + `<span class="link-kind">${escapeHtml(g.label)}</span>`
            + `<span class="link-list">${links}</span>`
            + `</div>`;
    }).join('');

    // `<details>` 折叠：summary 就是"🔗 链接"那一行，展开才是整块
    return `<details class="link-block">`
        + `<summary class="link-block-toggle">🔗 链接 (${total})</summary>`
        + `<div class="link-block-body">${sections}</div>`
        + `</details>`;
}
