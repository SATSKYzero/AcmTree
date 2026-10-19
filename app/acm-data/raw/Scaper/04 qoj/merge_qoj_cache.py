#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
QOJ 提交文件合并：把新抓的（带语言）按提交ID 并回旧文件（历史全）。

用法：
    python merge_qoj_cache.py                     # 旧备份 + 当前文件 → 当前文件
    python merge_qoj_cache.py --dry-run
"""
from __future__ import annotations
import argparse
import importlib.util
import json
import os
import sys

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
SCRAPER = os.path.join(HERE, 'QOJ_submissions_scraper.py')


def load_scraper():
    spec = importlib.util.spec_from_file_location('qoj_scraper', SCRAPER)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def main(argv):
    ap = argparse.ArgumentParser(description='合并 QOJ 提交缓存（提交ID 去重）')
    # ⚠️ `--old` 缺省为空：不给 `--old` 就只对 `--new` 内部去重，
    #    脚本照常跑（下面用 `os.path.isfile` 兜着）。真要并历史，自己留一份旧缓存指过来。
    ap.add_argument('--old', default='', help='旧提交缓存（缺省 = 没有，只处理 --new 内部去重）')
    ap.add_argument('--new', default=os.path.join(HERE, 'qoj_submissions.json'))
    ap.add_argument('--out', default='')
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args(argv)

    m = load_scraper()
    out = args.out or args.new
    old_rows = m.load_json_list(args.old) if os.path.isfile(args.old) else []
    new_rows = m.load_json_list(args.new) if os.path.isfile(args.new) else []
    print(f'旧 {len(old_rows)} 条 ｜ 新 {len(new_rows)} 条')

    old_by = {str(r.get(m.KEY)): r for r in old_rows if r.get(m.KEY)}
    new_by = {str(r.get(m.KEY)): r for r in new_rows if r.get(m.KEY)}
    print(f'旧唯一 {len(old_by)} ｜ 新唯一 {len(new_by)} ｜ 交集 {len(set(old_by) & set(new_by))}')

    merged = []
    stats = {'new_only': 0, 'old_only': 0, 'both': 0, '为旧记录补上语言': 0}
    for k, row in old_by.items():
        if k in new_by:
            stats['both'] += 1
            before = row.get('使用语言')
            row = {**row, **{kk: vv for kk, vv in new_by[k].items() if vv not in (None, '')}}
            if not before and row.get('使用语言'):
                stats['为旧记录补上语言'] += 1
        else:
            stats['old_only'] += 1
        merged.append(row)
    for k, row in new_by.items():
        if k not in old_by:
            stats['new_only'] += 1
            merged.append(row)

    print('合并结果:', json.dumps(stats, ensure_ascii=False))

    for r in merged:
        r.pop('_来源文件', None)
    con = {}
    sub = {}
    lang = 0
    for r in merged:
        cid = m.contest_of_record(r)
        con[cid] = con.get(cid, 0) + 1
        s = str(r.get('提交者') or '')
        sub[s] = sub.get(s, 0) + 1
        if r.get('使用语言'):
            lang += 1
    print(f'合并后 {len(merged)} 条：涉及 {len([c for c in con if c])} 场、'
          f'有语言 {lang} 条')
    print('  提交者:', sub)
    if args.dry_run:
        print('（--dry-run：没写文件）')
        return 0
    m.write_json_list(out, merged)
    print(f'💾 {out}')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
