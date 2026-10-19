// ================================================================
// 版本号的**手抄镜像**必须跟得上 `APP_VERSION`
//
// 病根：`src/A_constants.js` 的 `APP_VERSION` 是唯一真源，
// 但 `README.md` 与 `docs/guide.html` 各手抄了一遍版本号 —— 改真源时很容易只改其中一份
// （`README.md` 还自称"唯一的版本定义在 A_constants"）。
// 全仓**没有任何守卫**会红 ⇒ 过期版本会一直躺着，必须有守卫看着。
//
// 这条守卫只做一件事：真源一动，两个镜像没跟上就红。
// ================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { APP_VERSION } from '../A_constants.js';
import { APP_ROOT, repoRoot } from '../../scripts/roots.mjs';

// ⚠️ 两处镜像现在**不在同一个根**：`README.md` 在**仓库根**，`docs/guide.html` 在**机械层根**
//    （2026-10-17 机械层搬进 `app/`，`docs/` 跟着进去 —— 它要由服务器发给「📖 指南」按钮）。
//    ⇒ 按"仓库根 → 机械层根"各试一次，别手推 `..` 级数（推错会**静默**指到另一个根）。
const ROOT = repoRoot();
/** 读一份文件：先按仓库相对找，再按机械层相对找（与 `docHygiene.test.js` 同一形状） */
const read = (rel) => {
    const p = path.join(ROOT, ...rel.split('/'));
    return fs.readFileSync(fs.existsSync(p) ? p : path.join(APP_ROOT, ...rel.split('/')), 'utf8');
};

// ⚠️ **从锚点行取值再全等**：`.includes(APP_VERSION)` 那种写法不行 ——
//    子串任意位置命中就算过 —— 真源是 `v1.2.3` 而镜像写 `v1.2.3.4` 时照样绿（前缀关系），
//    镜像在更新记录里提过一次新版本、当前版本行烂着也能过。守卫的全部价值就是"下次改版本号时红"。
const MIRRORS = [
    ['README.md', /-\s*\*\*版本\*\*：\s*`(v[^`]+)`/],
    ['docs/guide.html', /Acm_Tree\s*·\s*(v\S+)/]
    // ⚠️ **只认下面这两处镜像**：真源一动，它们没跟上就红。
    //    别再往这张表里加第三个 —— 多一份手抄的版本号就是多一份要同步的镜像
    //    （把一份文档也登记进来就是多出来的一份镜像；
    //    对的做法是**别抄那个值**，而不是再配一条守卫看着它）。
];

for (const [rel, re] of MIRRORS) {
    test(`版本镜像：${rel} 的版本行必须**等于** APP_VERSION（${APP_VERSION}）`, () => {
        const src = read(rel);
        const m = re.exec(src);
        assert.ok(m, `${rel} 里找不到版本锚点行（宿主写法改了就要同步这条守卫）`);
        assert.equal(m[1], APP_VERSION,
            `${rel} 写的是 ${m[1]}，而 \`APP_VERSION\` 是 ${APP_VERSION} —— 改了真源就要把镜像一起改`);
    });
}
