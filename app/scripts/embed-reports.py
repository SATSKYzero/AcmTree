#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
体检报告**随包发布**（scripts/embed-reports.py）—— 只往包顶层加一节 `reports`。

**体检报告应该能在应用里看**（报告不该只躺在 `acm-data/reports/` 里让人翻 JSON/MD）。

为什么要**单独一步**（而不是让 `crate-merge` 顺手带上）：
  · 报告是在**包写出来之后**才算得出来的 —— `field-coverage.py` / `material-needs.py`
    读的就是 `acm-data/nodes/all_nodes.json` 本身（"这一版包里哪个字段缺多少"）；
  · 而 `crate-merge`（产包那一步）跑在它们**之前**，那时报告文件还是**上一版**的。
  ⇒ 顺序只能是：产包 → CLIST → 试跑 → 体检 → 原料需求 → **本脚本把刚出的两份塞回包顶层**。

⚠️ **只加一节、不动别的**：`records` / `fieldMap` / `fieldRegistry` 原样，命令行会核对条数。
⚠️ **幂等**：内容一样就连文件都不重写（免得无谓的 mtime/差异）。
⚠️ 报告文件不在（别的仓库/裁剪过的环境）⇒ **不动包**、exit 0（界面那页会说"这个包没带体检报告"；
   那是**一个正常状态**，不是错误）。文件在、却读不出来（JSON 坏了）⇒ **响亮失败、不写包** ——
   若默默跳过，包里原来那一节就被抹掉了：那不是"少一节"，是把已有的证据删了。

用法：
    python -B scripts/embed-reports.py
    python -B scripts/embed-reports.py --package acm-data/nodes/xcpc.json --reports-dir acm-data/reports
    python -B scripts/embed-reports.py --selftest
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from selftest_kit import Selftest

sys.dont_write_bytecode = True

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_PACKAGE = os.path.join(REPO, 'acm-data', 'nodes', 'all_nodes.json')
DEFAULT_REPORTS_DIR = os.path.join(REPO, 'acm-data', 'reports')

#: 包顶层 `reports` 的三节：键名 → 报告文件名（形状由各自的脚本决定，这里**只搬不改**）
REPORT_FILES = (
    ('coverage', 'field-coverage.json'),      # scripts/field-coverage.py
    ('needs', 'material-needs.json'),         # scripts/material-needs.py
    # ★ 原料脚本端给出的『手输与自动计算结果一致』列表（只读提示）：
    #   回代时**顺手核对**的结论（人工值 vs 脚本自己算的值）—— 应用「判重整理 · ③」那一行只读显示。
    ('baseline', 'baseline.json'),            # scripts/nature-baseline.py
)

#: 写包的口径与 `scripts/crate-merge.mjs` **逐字节一致**：缩进 2 + 末尾换行 + UTF-8 无 BOM。
#  （不一致的后果不是"坏"，而是每次 embed 都产生一个假的整文件 diff —— 查起来很费劲。）
JSON_KW = dict(ensure_ascii=False, indent=2)


def read_reports(reports_dir: str) -> tuple:
    """
    读报告目录里那两份 JSON。
    @returns (reports, notes, errors)
      · `reports` 只含**读得出来**的那几节；
      · `notes` 是给人看的提示（文件不在 ⇒ 静默，这是正常状态）；
      · `errors` = **文件在、却用不了**（JSON 坏了 / 形状不对）。这种是**真问题**：
        不能默默跳过 —— 那会把"上一版塞进去的那一节"悄悄抹掉（包里的证据就这么没了）。
    """
    reports = {}
    notes = []
    errors = []
    for key, name in REPORT_FILES:
        path = os.path.join(reports_dir, name)
        if not os.path.exists(path):
            continue                     # 正常状态：这一版没出这份报告
        try:
            with open(path, 'r', encoding='utf-8') as fh:
                doc = json.load(fh)
        except (OSError, ValueError) as err:
            errors.append('%s 读不出来：%s' % (name, err))
            continue
        if isinstance(doc, dict):
            reports[key] = doc
        else:
            errors.append('%s 的形状不对（顶层不是对象）' % name)
    return reports, notes, errors


def _dumps(doc: dict) -> str:
    return json.dumps(doc, **JSON_KW) + '\n'


def _write_atomic(path: str, text: str) -> None:
    """
    先写同目录的临时文件再 `os.replace` —— 中途失败/断电也不会留下半个包。
    ⚠️ 临时文件必须与目标**同目录**（跨盘的 replace 不是原子操作）；名字带 `.embed-`，
        正常路径上由 `os.replace` 收走，异常路径由 `finally` 清掉（不留垃圾文件）。
    """
    tmp = '%s.embed-%d' % (path, os.getpid())
    try:
        with open(tmp, 'w', encoding='utf-8', newline='\n') as fh:
            fh.write(text)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass


def embed(package: str, reports_dir: str, quiet: bool = False) -> int:
    """把报告塞进包顶层。@returns 进程退出码（0 = 成功/无需处理）"""
    if not os.path.exists(package):
        print('❌ 找不到包：%s' % package)
        return 1

    reports, notes, errors = read_reports(reports_dir)
    for line in notes:
        print(line)
    if errors:
        # ⚠️ **不写**：坏报告如果被"跳过"，包里原来那一节就被抹掉了 ——
        #    那不是"少了一节"，而是"把已有的证据删了"。宁可响亮失败。
        for line in errors:
            print('❌ %s（%s）' % (line, os.path.relpath(reports_dir, REPO)))
        print('🚫 报告用不了 ⇒ **未写出** %s（先修报告，别让它带着没了一节）'
              % os.path.relpath(package, REPO))
        return 1
    if not reports:
        print('ℹ️ %s 里没有体检报告（先跑 field-coverage / material-needs）—— 包**未改动**：%s'
              % (os.path.relpath(reports_dir, REPO), os.path.relpath(package, REPO)))
        return 0

    with open(package, 'r', encoding='utf-8') as fh:
        doc = json.load(fh)
    if not isinstance(doc, dict) or not isinstance(doc.get('records'), list):
        print('❌ %s 不像一份包（顶层没有 records 数组）—— 不动它'
              % os.path.relpath(package, REPO))
        return 1

    before_records = len(doc['records'])
    old_text = _dumps(doc)
    doc['reports'] = reports
    new_text = _dumps(doc)

    if old_text == new_text:
        if not quiet:
            print('✅ 包里的体检报告已经是最新的（未重写）：%s' % os.path.relpath(package, REPO))
        return 0

    _write_atomic(package, new_text)

    # 写回之后再读一次：**确认没写坏**（条数不变 + reports 还在）。
    # 这一步很便宜（就是读一次自己刚写的文件），但它把"写坏了却当成功"这条路堵死。
    with open(package, 'r', encoding='utf-8') as fh:
        back = json.load(fh)
    if len(back.get('records') or []) != before_records or 'reports' not in back:
        print('❌ 写回校验失败：条数 %d → %d，reports %s'
              % (before_records, len(back.get('records') or []),
                 '在' if 'reports' in back else '丢了'))
        return 1

    if not quiet:
        got = '、'.join(sorted(reports))
        print('✅ 体检报告已随包：%s（%s；%d 条记录）'
              % (os.path.relpath(package, REPO), got, before_records))
    return 0


# ================================================================
# 自测
# ================================================================

def _selftest() -> int:
    import shutil

    _st = Selftest('随包')
    ok = _st.ok

    # ⚠️ 用**仓库内**的临时目录（不是系统 temp）：受限沙箱/CI 里写系统 temp 会被拒，
    #    自测就跑不起来了。跑完由 finally 清掉（不留垃圾）。
    tmp = os.path.join(REPO, '.tmp-embed-reports-selftest')
    shutil.rmtree(tmp, ignore_errors=True)
    try:
        pkg = os.path.join(tmp, 'pkg.json')
        rep_dir = os.path.join(tmp, 'reports')
        os.makedirs(rep_dir)
        base = {'crateVersion': 1, 'fieldMap': {'\u6bd4\u8d5b': 'extKey'},
                'fieldRegistry': {'registryVersion': 1, 'fields': {}},
                'records': [{'\u8282\u70b9\u7c7b\u578b': 'C', '\u6bd4\u8d5b': 'cf:c:1'}],
                'defaults': {'fieldPolicies': {}}}
        with open(pkg, 'w', encoding='utf-8', newline='\n') as fh:
            fh.write(json.dumps(base, **JSON_KW) + '\n')

        # ① 没有报告文件 ⇒ 不动包
        ok(embed(pkg, rep_dir, quiet=True) == 0, '没报告时返回 0')
        with open(pkg, 'rb') as fh:
            raw0 = fh.read()
        ok(b'reports' not in raw0, '没报告时**不往包里加**那一节')

        # ② 只有一节 ⇒ 只带那一节
        with open(os.path.join(rep_dir, 'field-coverage.json'), 'w', encoding='utf-8') as fh:
            json.dump({'package': 'x', 'records': 1, 'rows': [{'type': 'C', 'field': 'name',
                                                              'expect': 'required', 'missing': 0}]}, fh)
        ok(embed(pkg, rep_dir, quiet=True) == 0, '塞报告成功')
        with open(pkg, encoding='utf-8') as fh:
            got = json.load(fh)
        ok(list(got.get('reports', {})) == ['coverage'], '只有一份报告 ⇒ 只带 coverage')
        ok(got['records'] == base['records'], 'records 一个字都没动')
        ok(got['fieldRegistry'] == base['fieldRegistry'], 'fieldRegistry 一个字都没动')
        ok(got['fieldMap'] == base['fieldMap'], 'fieldMap 一个字都没动')

        # ③ 写出来的字节 = crate-merge 的口径（缩进 2 + 末尾换行 + 无 BOM）
        with open(pkg, 'rb') as fh:
            raw = fh.read()
        ok(not raw.startswith(b'\xef\xbb\xbf'), '没有 BOM')
        ok(raw.endswith(b'\n'), '末尾有换行')
        ok(raw.split(b'\n')[1].startswith(b'  "'), '缩进 2（与 crate-merge 一致）')
        ok(b'reports' in raw and b'.embed-' not in raw, '没有把临时文件名写进包里')

        # ④ 幂等：再跑一次，**文件一个字节都不变**
        before = raw
        ok(embed(pkg, rep_dir, quiet=True) == 0, '第二次也返回 0')
        with open(pkg, 'rb') as fh:
            ok(fh.read() == before, '⚙️ 幂等：内容一样就不重写')

        # ⑤ 两份都在 ⇒ 两节都带；且**不删**旧的那节里已经有的东西
        with open(os.path.join(rep_dir, 'material-needs.json'), 'w', encoding='utf-8') as fh:
            json.dump({'package': 'y', 'needs': [{'id': 'cf:x', 'gain': 3, 'command': 'python x'}]}, fh)
        ok(embed(pkg, rep_dir, quiet=True) == 0, '两份报告都能塞')
        with open(pkg, encoding='utf-8') as fh:
            got = json.load(fh)
        ok(sorted(got['reports']) == ['coverage', 'needs'], '两节都在')
        ok(got['reports']['needs']['needs'][0]['gain'] == 3, '内容原样（只搬不改）')

        # ⑥ 坏 JSON ⇒ **响亮失败、不动包**（跳过会抹掉包里已有的那一节）
        with open(os.path.join(rep_dir, 'field-coverage.json'), 'w', encoding='utf-8') as fh:
            fh.write('{ 这不是 JSON')
        notes, errs = read_reports(rep_dir)[1], read_reports(rep_dir)[2]
        ok(any('field-coverage.json' in e for e in errs), '坏报告被当成**错误**（不是提示）')
        with open(pkg, 'rb') as fh:
            before_bad = fh.read()
        ok(embed(pkg, rep_dir, quiet=True) == 1, '坏报告 ⇒ 返回 1')
        with open(pkg, 'rb') as fh:
            ok(fh.read() == before_bad, '坏报告 ⇒ 包一个字节都没动（已有的那一节还在）')

        # ⑦ 形状不对的包 ⇒ 不动它、返回 1（先把报告修好，免得又撞上 ⑥ 那条分支）
        with open(os.path.join(rep_dir, 'field-coverage.json'), 'w', encoding='utf-8') as fh:
            json.dump({'package': 'x', 'records': 1, 'rows': []}, fh)
        with open(pkg, 'w', encoding='utf-8') as fh:
            json.dump({'nope': 1}, fh)
        ok(embed(pkg, rep_dir, quiet=True) == 1, '不是包 ⇒ 返回 1（不瞎写）')

        # ⑧ 目录里没有报告目录 ⇒ 静默跳过（不炸）
        ok(embed(pkg, os.path.join(tmp, 'no-such-dir'), quiet=True) == 0,
           '报告目录不存在 ⇒ 返回 0（当成"没报告"那一路）')

        # ⑨ 临时文件不留：目录里除了 pkg.json 与 reports/，没有别的
        leftovers = [n for n in os.listdir(tmp) if '.embed-' in n]
        ok(not leftovers, '不留临时文件')
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    return _st.done()


def main(argv):
    ap = argparse.ArgumentParser(description='把体检报告塞进包顶层（只加一节 reports）')
    ap.add_argument('--package', default=DEFAULT_PACKAGE)
    ap.add_argument('--reports-dir', default=DEFAULT_REPORTS_DIR)
    ap.add_argument('--quiet', action='store_true')
    ap.add_argument('--selftest', action='store_true')
    args = ap.parse_args(argv)
    if args.selftest:
        return _selftest()
    return embed(args.package, args.reports_dir, quiet=args.quiet)


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
