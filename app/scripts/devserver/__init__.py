"""开发用静态服务器的内部模块（从 `dev-server.py` 拆出来的）。

⚠️ 这里**第一件事**是关掉字节码缓存：入口 `dev-server.py` 由 `启动AcmTree.bat` 直接跑
（`python "scripts\\dev-server.py"`，**没带 `-B`**），不关的话跑一次就会生成
`scripts/devserver/__pycache__`（仓库规矩：不留这些）。
"""
import sys

sys.dont_write_bytecode = True
