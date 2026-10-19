#!/usr/bin/env python
# ================================================================
# 原料三档：进包 / 不进包但保留 / 不保留（scripts/prune-raw.py）
#
# 用户 2026-10-17 定的三档（见 `Scaper/lib/material.py` 的文件头）：
#   · **进包**         产包应该读它 ⇒ 必须留
#   · **不进包但保留** 产包不读它，但文件留着（还在候选区）⇒ 留
#   · **不保留**       既不进包也不在候选区 ⇒ 不读，**可以删**
#
# **全仓唯一允许删除"原料"的地方**（`--apply` 才删；默认只报告，一个字节都不动）。
# 别的档位/步骤**一律不许删** —— 只许"增量合并"（缺的才抓；抓不到就保留旧文件）。
#
# ⚠️ **本文件不含任何判定**：三档怎么分只有一份实现，在
#    `acm-data/raw/Scaper/lib/material.py`（走 `stages` 那套判据/依据/记账）。
#    这里只负责：跑一遍 → 报给人看 → 在 `--apply` 时删「不保留」那一档。
#
# ★ **盘的是整个原料层，不只是 cf 那个缓存目录**（2026-10-17 改）：`material.ROOTS` 那几棵
#   （`05 xcpc/cache` / `03 PTA` / `02 hdu` / `01 nk`）。之前只盘 `05 xcpc/cache`
#   ⇒ 杭电/牛客/PTA 的原料连"进包/保留"都没被问过，`--apply` 实际上只对 cf 有效。
#   脚本与说明（`.py/.js/.mjs/.md`）不算原料，不参与分档。
#
# 用法（**从仓库根跑**）：
#   python -B app/scripts/prune-raw.py                # 只报告（默认，一个字节都不动）
#   python -B app/scripts/prune-raw.py --apply        # 真删「不保留」那档（逐条打印删了谁）
#   python -B app/scripts/prune-raw.py --root <目录>  # 只盘这一棵（替代 ROOTS）
#   python -B app/scripts/prune-raw.py --selftest     # 自测（转给 material.selftest）
# ================================================================
import argparse
import os
import re
import sys
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
LIB = os.path.join(REPO, 'acm-data', 'raw', 'Scaper', 'lib')
sys.path.insert(0, LIB)
sys.path.insert(0, HERE)          # 同目录的 `utf8_stdio`（手敲也能找到）

import material                                              # noqa: E402
# ★ 本进程 stdio 钉 UTF-8（2026-10-18，见 `utf8_stdio.py` 文件头）：关掉 Windows「UTF-8 Beta」后
#   ACP=936，这一页的 `🩺 / · ` 里有 GBK 编不出的字符。
import utf8_stdio                                            # noqa: E402
utf8_stdio.pin()


def _size(root, rows) -> int:
    total = 0
    for one in rows:
        rel = one[0] if isinstance(one, tuple) else one
        try:
            total += os.path.getsize(os.path.join(root, rel))
        except OSError:
            pass
    return total


_NUM = re.compile(r'\d{3,}')


def _shape(rel: str) -> str:
    """把一串 rel 归成一个"花样"（顶层目录 + 文件名里的长数字换成 `<cid>`）"""
    parts = rel.replace('\\', '/').split('/')
    return parts[0] + '/**' if len(parts) > 1 else _NUM.sub('<cid>', parts[0])


def report_one(tree, facts_label: str) -> None:
    """打一棵树的报告（档① / 档② / 档③ + 判据依据）"""
    root, got = tree['root'], tree['census']
    tiers = got['tiers']
    print('\n── %s ──' % tree['label'])
    print('   ① 进包（产包会读它 ⇒ 必须留）：%d 份 / %.2f MB'
          % (len(tiers['进包']), _size(root, tiers['进包']) / 1048576))
    print('   ② 不进包但保留（产包不读，但留着）：%d 份 / %.2f MB'
          % (len(tiers[material.KEEP]), _size(root, tiers[material.KEEP]) / 1048576))
    print('        其中**没有判据覆盖**的花样 %d 份（一律归这一档）' % len(got['unstated']))
    drops = tiers['不保留']
    print('   ③ 不保留（既不进包、也不在候选区 ⇒ 可以删）：%d 份 / %.2f MB'
          % (len(drops), _size(root, drops) / 1048576))
    by_rule = Counter(r for _rel, r, _k in drops)
    for rule, n in by_rule.most_common():
        why = next((r.why for r in material.RULES if rule.startswith(r.id) or r.id in rule), '')
        print('        %-18s %4d 份 ｜ %s' % (rule, n, why))
    for rel, _rule, key in drops[:5]:
        print('          · %s（key=%s）' % (rel, key))
    if len(drops) > 5:
        print('          · …（还有 %d 份）' % (len(drops) - 5))
    # ② 里"没有判据覆盖"的那批**长什么样**：只报花样与份数（不判档，纯粹让人知道还缺哪条判据）
    if got['unstated']:
        shapes = Counter(_shape(rel) for rel in got['unstated'])
        print('      没判据覆盖的花样（前 8）：')
        for pat, n in shapes.most_common(8):
            print('        %-44s %5d 份' % (pat, n))
    _ = facts_label


def main(argv) -> int:
    ap = argparse.ArgumentParser(description='原料三档（默认只报告；--apply 只删「不保留」那档）')
    ap.add_argument('--apply', action='store_true', help='真删「不保留」那档（默认只报告，一个字节都不动）')
    ap.add_argument('--root', default='', help='只盘这一棵（默认盘 material.ROOTS 那几棵）')
    ap.add_argument('--selftest', action='store_true', help='自测（临时目录造样本，不碰真原料）')
    args = ap.parse_args(argv)
    if args.selftest:
        return material.selftest()

    facts = material.facts()
    roots = (('(指定)', args.root),) if args.root else material.ROOTS
    trees = material.census_tree(facts, roots)
    print('🩺 原料三档：%d 棵树（%s）' % (len(trees), '、'.join(t['label'] for t in trees)))
    print('   事实（各只有一处）：%s' % material.facts_label(facts))
    print('   ⚠️ 「该不该读」由档决定；档来自**声明的范围**（清单 / 候选区 / 花名册），不看上一轮的产物')

    for tree in trees:
        report_one(tree, '')

    drops = [(t['root'], rel, rule, key) for t in trees for rel, rule, key in t['census']['tiers']['不保留']]
    if not args.apply:
        print('\n（默认只报告，没动任何文件。真删第③档：--apply）')
        return 0
    n = 0
    for root, rel, _rule, _key in drops:
        p = os.path.join(root, rel)
        try:
            os.remove(p)
            n += 1
            print('  🗑 删除 %s/%s' % (os.path.basename(root), rel))
        except OSError as err:
            print('  ❌ 删不掉 %s/%s：%s' % (os.path.basename(root), rel, err))
    keep = sum(len(t['census']['tiers'][material.KEEP]) for t in trees)
    packed = sum(len(t['census']['tiers']['进包']) for t in trees)
    print('\n✅ 已删除 %d 份（进包 %d 份 / 不进包但保留 %d 份，一个没动）' % (n, packed, keep))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
