# ================================================================
# 两个"根"的唯一定义（scripts/devserver/roots.py）
#
# 这个仓库有**两层根**，别在手推 `..` 级数：
#   · `APP_ROOT`   —— **机械层**：`index.html` / `src/` / `scripts/` / `acm-data/` 所在那一层。
#                     静态服务目录、链上步骤脚本、包路径都相对它。
#   · `repo_root()` —— **仓库根**：含 `package.json` 的那一层。给人看的东西
#                     （`README.md`、`个人数据/`、`作者专用/`）在这一层。
#                     ⚠️ 机械层搬进 `app/` 之后 `docs/` 也跟进了 `app/docs/`（服务器只发 `app/` 这一层），
#                        所以"给人看的东西"只剩 `README.md` 与那两个数据/作者目录。
#
# 现在两者是同一个目录；机械层整目录搬进 `app/` 之后就不是（2026-10-17 试过一次）。
# **判据只有一条**：向上找到第一个含 `package.json` 的目录；一路到顶都没有就退回 `APP_ROOT`
# （不抛 —— 打包/临时目录里也得能跑）。
#
# ⚠️ `个人数据/`（凭据）按 **仓库根** 定位，不按 `APP_ROOT`：它是"这个人自己的东西"，
#    不进公开副本。同一条口径的 Python 侧另一份在
#    `acm-data/raw/Scaper/lib/me.py:ME_FILE`（抓取层 import 不到这里）。
# ================================================================
import os

#: 机械层根（本文件在 `<APP_ROOT>/scripts/devserver/`）
APP_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

#: 个人数据目录名（仓库根下；唯一的一份定义在这里）
PERSONAL_DIRNAME = '个人数据'


def repo_root(start: str = '') -> str:
    """
    仓库根 = 向上第一个含 `package.json` 的目录（见文件头）。

    ⚠️ 2026-10-17 的事故（**别再退回"先看 start 存不存在"那种写法**）：原来这里有一句
    `if not os.path.isdir(d): d = APP_ROOT`，看着像"容错"，实际是**静默换根** ——
    自测夹具传进来的 `http-root` 当时还没建目录 ⇒ 它直接跳到 `APP_ROOT`
    ⇒ `/api/me` 的写入用例**真的写了用户的 `me.json`**（4969 字节被覆盖成 73 字节）。
    现在：**照传进来的路径往上走**（不存在的路径也能走），到顶都没有标记才退回 `APP_ROOT`。
    """
    d = os.path.abspath(start or APP_ROOT)
    while True:
        if os.path.isfile(os.path.join(d, 'package.json')):
            return d
        up = os.path.dirname(d)
        if up == d:
            return APP_ROOT
        d = up


def personal_dir(start: str = '') -> str:
    """`个人数据/` 的绝对路径（**不保证存在**：抓取脚本第一次写时会自己建）"""
    return os.path.join(repo_root(start), PERSONAL_DIRNAME)
