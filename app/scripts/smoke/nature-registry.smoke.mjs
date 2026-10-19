// ================================================================
// 冒烟测试：性质注册表面板（scripts/smoke/nature-registry.smoke.mjs）
//
// 钉的是这一栏整条链：**读回来 → 改（改名/加子/删/上下移）→ 保存**，
// 以及两条"服务器说不行"的路（形状不过 400 / 磁盘变过 409）与"旧进程"那条。
//
// why 真跑面板而不是只跑纯函数：`natureRegistryTree` 的单测证明"编辑是对的"，
// 但证明不了"按钮接对了、状态行说了人话、保存真的 PUT 了、失败不清空草稿"。
// fetch 全程是桩，不碰网络、不碰磁盘。
// ================================================================
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDom, makeContainer, serialize } from './dom.mjs';
import { group, ok, eq, report } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = path.join(ROOT, 'src');
const mod = (rel) => `file://${path.join(SRC, rel).replace(/\\/g, '/')}`;

const body = installDom([], { parseHtml: true });
const { createNatureRegistryPanel } = await import(mod('ui/settings/natureRegistryPanel.js'));

/** 一份"像真注册表"的文档 */
const REGISTRY = {
    registryVersion: 1,
    note: ['说明一行'],
    fields: {
        natureClass: { label: '分类', kind: 'classPath' },
        natureYear: { label: '年份', kind: 'pattern', pattern: '^(20\\d{2}|无)$' }
    },
    classTrie: {
        xcpc: { icpc: { aa: { pre: { official: {}, 无归类: {}, 未归类: {}, 上游异常: {} } } } },
        cf: { contest: {} }
    }
};
const clone = (v) => JSON.parse(JSON.stringify(v));

const calls = [];
let putFails = null;                 // 让下一次 PUT 失败：`{status, error}` 或 null
let sha = 'a'.repeat(64);
let apiVersion = 7;
const fetchImpl = async (url, opts = {}) => {
    calls.push({ url: String(url), method: String(opts.method || 'GET'), body: opts.body });
    const okJson = (json, status = 200) => ({ ok: status < 400, status, json: async () => json });
    if (String(url).includes('api/ping')) {
        return okJson({ ok: true, api: apiVersion, root: ROOT, pid: 1, port: 8399, steps: [] });
    }
    if (String(opts.method) === 'PUT') {
        if (putFails) return okJson({ ok: false, error: putFails.error }, putFails.status);
        const sent = JSON.parse(opts.body);
        sha = 'b'.repeat(64);
        calls.at(-1).sent = sent;
        return okJson({ ok: true, path: 'acm-data/nature-registry.json', sha256: sha, mtime: 1700000000,
            doc: sent.doc, summary: { classPaths: 5, roots: ['xcpc', 'cf'] },
            diff: { addedClassCount: 1, removedClassCount: 0, keptClassCount: 4 } });
    }
    return okJson({ ok: true, path: 'acm-data/nature-registry.json', sha256: sha, mtime: 1700000000,
        doc: clone(REGISTRY), summary: { classPaths: 5, roots: ['xcpc', 'cf'] } });
};

const toasts = [];
const usage = new Map([['xcpc', 3], ['xcpc/icpc', 2], ['cf', 1]]);
const host = makeContainer(body, 'settings-tab-nature');
const panel = createNatureRegistryPanel(host, {
    fetchImpl, toast: (m, k) => toasts.push(`${k || 'info'}:${m}`), usageOf: () => usage
});
const rows = () => host.querySelectorAll('.nr-row');
const rowOf = (key) => rows().find((r) => r.dataset.path === key);
const act = (key, action) => rowOf(key).querySelectorAll(`[data-act="${action}"]`)[0].click();
const statusText = () => host.querySelector('#nr-status').textContent;
const statusColor = () => host.querySelector('#nr-status').style.color;

group('🧬 性质注册表：读回来 → 概况 / 字段 / 分类树');
panel.activate();
await new Promise(r => setTimeout(r, 20));
ok(calls.some(c => c.url.includes('api/ping')), '先探活主脚本');
ok(calls.some(c => c.url.includes('api/nature-registry') && c.method === 'GET'), '再去读注册表');
ok(/nature-registry\.json/.test(statusText()) && /sha aaaaaaaa/.test(statusText()),
    '★ 状态行报出路径 + 指纹', statusText());
ok(serialize(host).includes('分类叶子'), '概况里有"分类叶子 N 条"');
ok(serialize(host).includes('3 个') || serialize(host).includes('根'), '概况里有根那一层');
eq(host.querySelectorAll('.nr-field').length, 2, '两个字段各一行');
eq(host.querySelectorAll('.nr-field .nr-pattern').length, 2, 'pattern 那一格也在');
eq(rows().length, 2, '★ 默认**全收起**：只画根那一层（xcpc / cf 两行）');
eq(rowOf('xcpc').querySelectorAll('.nr-toggle').length, 1, '有子分类的行有 ▸');
ok(serialize(host).includes('用它的节点 3'), '★ 行上带"用它的节点 N"（注入的用量）');

group('展开 / 加子 / 改名 / 删除 / 上下移');
act('xcpc', 'toggle');
eq(rows().length, 3, '展开 xcpc ⇒ 多出它的子行', `现在 ${rows().length} 行`);
eq(rows().map(r => r.dataset.path).includes('xcpc/icpc'), true, '子分类那一行出现了');

// 加子分类：点 ＋ ⇒ 出现输入框 ⇒ 填名字 ⇒ ✓
act('xcpc/icpc', 'add');
ok(!!rowOf('xcpc/icpc').querySelectorAll('.nr-new-child')[0] || !!host.querySelector('.nr-new-child'),
    '点 ＋ 出现"新子分类"输入框');
host.querySelector('.nr-new-child').value = 'ec';
host.querySelector('[data-act="add-ok"]').click();
eq(Object.keys(panel.doc().classTrie.xcpc.icpc).join(','), 'aa,ec',
    '★ 新分类加进去了（在原有两个之后）');
ok(/加了「ec」/.test(statusText()), '状态行说了改了什么', statusText());

// 重名 ⇒ 拒绝，而且**草稿不动**
const before = JSON.stringify(panel.doc());
act('xcpc/icpc', 'add');
host.querySelector('.nr-new-child').value = 'aa';
host.querySelector('[data-act="add-ok"]').click();
eq(JSON.stringify(panel.doc()), before, '★ 重名被拒时草稿一个字没动');
ok(toasts.some(t => t.startsWith('error') && t.includes('已经有')), '给了错误提示');

// 改名：点 ✎ ⇒ 输入 ⇒ ✓（同级顺序要保持）
act('xcpc/icpc/aa', 'rename');
host.querySelector('.nr-rename').value = 'aaa';
host.querySelector('[data-act="rename-ok"]').click();
eq(Object.keys(panel.doc().classTrie.xcpc.icpc).join(','), 'aaa,ec',
    '★ 改名后**还在原位**（顺序是语义）');
ok(!!rowOf('xcpc/icpc/aaa'), '树上也跟着换了名字');

// 删：特殊叶子不许删；普通叶子能删
act('xcpc/icpc/aaa', 'toggle');
act('xcpc/icpc/aaa/pre', 'toggle');
const specialBefore = JSON.stringify(panel.doc());
act('xcpc/icpc/aaa/pre/无归类', 'del');
eq(JSON.stringify(panel.doc()), specialBefore, '★ 特殊叶子删不掉（草稿不动）');
ok(toasts.some(t => t.includes('不能删')), '并说清了为什么');
act('xcpc/icpc/aaa/pre/official', 'del');
eq('official' in panel.doc().classTrie.xcpc.icpc.aaa.pre, false, '普通叶子删掉了');

// 上下移
act('cf', 'up');
eq(Object.keys(panel.doc().classTrie).join(','), 'cf,xcpc', '★ 根那一层也能调序（顺序有意义）');

group('保存：只交 doc + sha256；成功/失败都说人话');
const beforePuts = calls.filter(c => c.method === 'PUT').length;
host.querySelector('#nr-save').click();
await new Promise(r => setTimeout(r, 20));
const puts = calls.filter(c => c.method === 'PUT');
eq(puts.length, beforePuts + 1, '★ 保存真的 PUT 了');
const sent = puts.at(-1).sent;
eq(sent.sha256, 'a'.repeat(64), '带上载入时那份 sha256（服务器据此挡"磁盘变了"）');
eq(Object.keys(sent.doc.classTrie).join(','), 'cf,xcpc', '交上去的就是改过的那份草稿');
ok(/刷新页面/.test(statusText()) && /重建总包/.test(statusText()),
    '★ 写成功后状态行提醒"刷新页面 + 重建总包"', statusText());
eq(host.querySelector('#nr-dirty').style.display, 'none', '写成功后"未保存"标记收掉');

// 409：磁盘被别处改过 ⇒ 说人话 + 草稿留着（别把用户改的清掉）
const draftAfterPut = JSON.stringify(panel.doc());
putFails = { status: 409, error: '磁盘上的 nature-registry.json 变过了（冲突）' };
host.querySelector('#nr-save').click();
await new Promise(r => setTimeout(r, 20));
ok(/被别处改过|变过/.test(statusText()), '★ 409 时说"磁盘上那份被别处改过"', statusText());
eq(/b91c1c|185, 28, 28/.test(statusColor()), true, '状态行是红的（或 #b91c1c）');
eq(JSON.stringify(panel.doc()), draftAfterPut, '★ 草稿原样留着（没因为失败被清空）');

// 400：形状不过（服务器那句判据原样给人看）
putFails = { status: 400, error: 'acm-data/nature-registry.json 的分类树里少了特殊叶子：无归类' };
host.querySelector('#nr-save').click();
await new Promise(r => setTimeout(r, 20));
ok(/少了特殊叶子/.test(statusText()), '★ 400 把服务器那句判据原样显示', statusText());
putFails = null;

group('旧服务器（接口 v6）⇒ 提示重启，而不是莫名其妙地 404');
apiVersion = 6;
const host2 = makeContainer(body, 'settings-tab-nature-2');
const panel2 = createNatureRegistryPanel(host2, {
    fetchImpl, toast: () => {}, usageOf: () => new Map()
});
panel2.activate();
await new Promise(r => setTimeout(r, 20));
ok(/旧进程|重启/.test(host2.querySelector('#nr-status').textContent),
    '★ 接口版本低 ⇒ 提示"双击 启动AcmTree.bat 重启"', host2.querySelector('#nr-status').textContent);
eq(host2.querySelectorAll('.nr-row').length, 0, '读不成形就不画树（不画一半）');
apiVersion = 7;

report();
