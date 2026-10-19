// ================================================================
// 两个"根"的唯一定义（scripts/roots.mjs，JS 侧）
//
// 与 Python 侧 `scripts/devserver/roots.py` **同一份口径**（那边给服务器用，这边给测试/工具用）：
//   · `APP_ROOT`    —— **机械层**：`index.html` / `src/` / `scripts/` / `acm-data/` / `docs/` 所在那一层
//   · `repoRoot()`  —— **仓库根**：含 `package.json` 的那一层（`README.md` / `个人数据/` / `作者专用/`）
//
// ⚠️ **别手推 `..` 级数**：机械层整目录搬过一次（2026-10-17 进 `app/`），
//    手推的写法在那次搬迁后**静默指错**（docAnchors / docHygiene / versionMirrors 三个守卫
//    就是被它坑的：它们要读的 `README.md` / `docs/guide.html` / `作者专用/docs/…` 在仓库根，
//    而 `..`、`..` 给的是 `app/`）。
// 判据只有一条：**向上找第一个含 `package.json` 的目录**；到顶都没有就退回机械层根。
// ================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 机械层根（本文件在 `<APP_ROOT>/scripts/`） */
export const APP_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** 仓库根（见文件头；`start` 默认从机械层根往上找） */
export function repoRoot(start = APP_ROOT) {
    let d = path.resolve(start);
    for (;;) {
        if (fs.existsSync(path.join(d, 'package.json'))) return d;
        const up = path.dirname(d);
        if (up === d) return APP_ROOT;
        d = up;
    }
}

/**
 * 个人数据目录名（**仓库根**下）。
 *
 * ⚠️ 唯一的一份定义在这里；Python twin 在 `devserver/roots.py:PERSONAL_DIRNAME`，
 *    两边的字面量由 `src/test/crossLangTables.test.js` 对拍（改一边不红的日子结束了）。
 * ⚠️ 它是**仓库根**那一层的，不是机械层的：`app/` 里任何"自己去拼 me.json 路径"的写法都是错的
 *    —— 2026-10-17 真踩到：`clean-personal.mjs` 只走 `app/acm-data/` 一棵树，
 *    凭据搬去 `个人数据/` 之后它**看不见凭据了**（报告里"① 凭据 0 个"是假数字）。
 */
export const PERSONAL_DIRNAME = '个人数据';

/** `个人数据/` 的绝对路径（**不保证存在**：抓取脚本第一次写时会自己建） */
export function personalDir(start = APP_ROOT) {
    return path.join(repoRoot(start), PERSONAL_DIRNAME);
}
