#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
把 RankLand 的场次目录树拉下来，落成一份 slug 清单（给人看的）。

用途：确认某场该用哪个 slug（extKey 的身份来源）。
产出：`_rankland_slugs.md` —— 每场一行：`- \`slug\`  —  <中文名>`

用法：
    python fetch_rankland_tree.py
    python fetch_rankland_tree.py -o some/other.md
"""

from __future__ import annotations

import argparse
import collections
import os
import sys

sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, 'lib'))

from rankland_tree import fetch_config_text, iter_contests  # noqa: E402


def main(argv):
    ap = argparse.ArgumentParser(description='rankland 场次树 → slug 清单')
    ap.add_argument('-o', '--output', default=os.path.join(HERE, '_rankland_slugs.md'))
    args = ap.parse_args(argv)

    contests = iter_contests(fetch_config_text())

    lines = [
        '# RankLand / srk-collection 场次 slug 清单',
        '',
        '来源：https://github.com/algoux/srk-collection （`official/config.yaml`）',
        '许可：AGPL-3.0。按其 README 要求，使用数据时应标注来源；',
        '      二次加工产生的衍生数据应按相同协议开源。',
        '',
        f'共 {len(contests)} 场（= 有 `format: srk.json` 的叶子节点）。',
        '层级**不统一**（照抄来源的树，不要硬编码层级语义）：',
        '- 三层：`official/<系列>/<年份或省份>/<slug>.srk.json`',
        '- 两层：`official/<系列>/<slug>.srk.json`（如 ucup）',
        '',
        '本文件由 `fetch_rankland_tree.py` 生成，别手工改。',
    ]
    last = None
    for c in contests:
        key = (c['series'], c['mid'])
        if key != last:
            lines.append(f'\n## {c["series"]}' + (f' / {c["mid"]}' if c['mid'] else ''))
            last = key
        lines.append(f'- `{c["slug"]}`  —  {c["name"]}')

    with open(args.output, 'w', encoding='utf-8', newline='\n') as f:
        f.write('\n'.join(lines) + '\n')

    print(f'✅ {len(contests)} 场 → {os.path.relpath(args.output, HERE)}')
    print('   系列分布:', dict(collections.Counter(c['series'] for c in contests).most_common()))
    two = sorted({c['series'] for c in contests if not c['mid']})
    print('   两层结构的系列:', two or '（无）')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
