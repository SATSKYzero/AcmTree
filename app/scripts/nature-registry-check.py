#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
性质注册表**只读体检**（`scripts/nature-registry-check.py`）—— 判据在 `nature_registry_lib.py`

    python -B scripts/nature-registry-check.py              # 体检仓库里那份
    python -B scripts/nature-registry-check.py <路径>        # 体检指的那份（改之前先试）
    python -B scripts/nature-registry-check.py --selftest   # 跑判据本身的正反用例

写盘那道闸在**别处**（主脚本 `PUT /api/nature-registry` → `devserver/nature_registry_store.py`），
两边**共用同一份** `parse_registry()` —— 这里只是"人也想手跑一下"的那个入口。

⚠️ 只校验**形状**（能不能被两个消费者读出来），不判"这个分类该不该有" —— 那是人的决定。
"""
from __future__ import annotations

import argparse
import os
import sys

sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from nature_registry_lib import (  # noqa: E402
    CLASS_SPECIAL, KINDS, read_registry, registry_summary,
)

#: 默认就看仓库里那份
DEFAULT_REGISTRY = os.path.join(os.path.dirname(HERE), 'acm-data', 'nature-registry.json')


def run(path: str) -> int:
    try:
        doc = read_registry(path)
    except ValueError as err:
        print('❌ 没过：%s' % err, file=sys.stderr)
        return 1
    s = registry_summary(doc)
    rel = os.path.relpath(path, os.path.dirname(HERE)).replace('\\', '/')
    print('✅ %s 形状没问题' % rel)
    print('   版本 registryVersion = %d' % s['version'])
    print('   字段 %d 条：%s' % (len(s['fields']),
                                '、'.join('%s(%s)' % (f['key'], f['kind']) for f in s['fields'])))
    print('   kind 词表：%s' % ' / '.join(KINDS))
    print('   分类叶子 %d 条；根 %d 个：%s' % (s['classPaths'], len(s['roots']), '、'.join(s['roots'])))
    print('   特殊叶子：%s（必须在，缺一条就有值判不出来）'
          % '、'.join('%s×%d' % (k, v) for k, v in s['special'].items()))
    print('   （只判形状；"这个分类该不该有"由人定 —— 改完记得重建总包，'
          '应用侧要刷新页面才拿到新词表）')
    return 0


def main(argv):
    ap = argparse.ArgumentParser(description='性质注册表只读体检（形状）')
    ap.add_argument('registry', nargs='?', default=DEFAULT_REGISTRY, help='默认仓库里那份')
    ap.add_argument('--selftest', action='store_true', help='跑判据本身的正反用例')
    args = ap.parse_args(argv)
    if args.selftest:
        from nature_registry_lib import _selftest
        return _selftest()
    if not os.path.isfile(args.registry):
        print('❌ 找不到 %s' % args.registry, file=sys.stderr)
        return 1
    return run(args.registry)


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
