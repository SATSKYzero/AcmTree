// ================================================================
// 标签操作（core/ops/tag.js）
// 职责：增删改移标签
// 依赖：_helpers.js, core/ops/account.js（只读守卫）, core/ops/node.js（手改留痕）
//
// 标签改动也必须过**同一条规则**
// ---------------------------------------
// `tags` 是列表型元素（`elements.js` 里 `manual: true, shape: 'list'`），
// 所以"谁改的标签"同样要进来源层；而且**不改来源层就会看不见** ——
// 树上读的是 `viewValue(state, node, 'tags')`（= 来源层的投影值），
// 只改 `node.tags` 的话，标签管理器里加了、树上却不显示（实测一致性问题）。
//
// 于是这里把"守卫 + 改 + 留痕"收成**一个内部助手**，四个操作都是它的薄封装 ——
// 谁都不用再记住"别忘了守卫/留痕"。
// ================================================================
import { nextTagId } from './_helpers.js';
import { getNowStr } from '../../utils/time.js';
import { DEFAULT_TAG_COLOR } from '../../A_constants.js';
import { assertManualEditAllowed } from './account.js';
import { recordManualValue } from './node.js';

/** 标签列表的**值**（来源层里存的是标签文字数组，形状由属性表 `shape:'list'` 决定） */
export function tagTexts(tags) {
    return (Array.isArray(tags) ? tags : [])
        .map(t => (t && t.text !== undefined ? String(t.text) : String(t)))
        .filter(Boolean);
}

/**
 * 所有标签改动的**唯一入口**：先过只读守卫，改完按统一规则留痕。
 *
 * @param {Object} draft
 * @param {string} pId
 * @param {(node:Object) => void} mutate - 真正改 `node.tags` 的那一步
 * @returns {Object} 被改的节点
 */
export function mutateNodeTags(draft, pId, mutate) {
    assertManualEditAllowed(draft, '修改标签');
    const node = draft.nodes[pId];
    if (!node || node.type !== 'P') throw new Error('不是题目节点');
    const before = tagTexts(node.tags);
    mutate(node);
    node.lastModified = getNowStr();
    recordManualValue(draft, node, 'tags', before, tagTexts(node.tags), {});
    return node;
}

// ---- 添加标签 ----
export function addTag(draft, pId, text, color = DEFAULT_TAG_COLOR) {
    const tagId = nextTagId(draft);
    mutateNodeTags(draft, pId, (node) => {
        node.tags.push({ id: tagId, text: String(text || '').trim() || 'tag', color: color || DEFAULT_TAG_COLOR });
    });
    return { tagId };
}

// ---- 删除标签 ----
export function deleteTag(draft, pId, tagId) {
    mutateNodeTags(draft, pId, (node) => {
        const idx = node.tags.findIndex(t => t.id === tagId);
        if (idx === -1) throw new Error('标签不存在');
        node.tags.splice(idx, 1);
    });
    return true;
}

// ---- 上移标签 ----
export function moveTagUp(draft, pId, tagId) {
    mutateNodeTags(draft, pId, (node) => {
        const idx = node.tags.findIndex(t => t.id === tagId);
        if (idx <= 0) throw new Error('已在最上方或标签不存在');
        [node.tags[idx - 1], node.tags[idx]] = [node.tags[idx], node.tags[idx - 1]];
    });
    return true;
}

// ---- 下移标签 ----
export function moveTagDown(draft, pId, tagId) {
    mutateNodeTags(draft, pId, (node) => {
        const idx = node.tags.findIndex(t => t.id === tagId);
        if (idx === -1 || idx >= node.tags.length - 1) {
            throw new Error('已在最下方或标签不存在');
        }
        [node.tags[idx + 1], node.tags[idx]] = [node.tags[idx], node.tags[idx + 1]];
    });
    return true;
}
