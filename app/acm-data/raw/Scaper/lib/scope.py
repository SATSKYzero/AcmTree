#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
渠道抓取范围 = **显式指定 ∪ 我有提交的**

各渠道的爬取范围都套入"指定范围与有提交取并集"的逻辑，用代码具现化，方便自定义。

为什么放在**通用区**（`Scaper/lib/`）而不是某个渠道目录：这条逻辑是**所有渠道共用**的，
而 `04 qoj` 与 `05 xcpc` 是两个互不依赖的包 —— 放在任一方的 `lib/` 里都会让另一方反向依赖。
各渠道只需要声明**两个来源**：

    explicit  显式指定的范围：`--contest` / `--category` / 白名单 / 清单 / 注册表 …
    mine      我有提交的范围：提交文件 / `user.status` / AtCoder submissions …

`union_scope()` 返回并集并打一行人话，渠道**不许**在这上面再加自己的取舍
（要收窄就收窄 `explicit`/`mine` 本身，别在并集之后偷偷过滤）。
"""

from __future__ import annotations


def union_scope(*, explicit=None, mine=None, name: str = '') -> set:
    """
    抓取范围 = `explicit ∪ mine`；`name` 给了就打一行带上它。

    @param explicit 显式指定（可空）
    @param mine     我有提交的（可空）
    @param name     渠道名，用于打印；不给就不打
    @returns 并集（`set[str]`，元素一律字符串化 —— 免得场次号/比赛号混用 int/str）
    """
    e = {str(x).strip() for x in (explicit or ()) if str(x).strip()}
    m = {str(x).strip() for x in (mine or ()) if str(x).strip()}
    out = e | m
    if name:
        parts = []
        if e:
            parts.append(f'显式 {len(e)}')
        if m:
            parts.append(f'提交 {len(m)}')
        head = ' ∪ '.join(parts) if parts else '（两边都空）'
        print(f'🏷️ {name}：{head} = {len(out)} 场（重叠 {len(e & m)}）')
    return out


def split_by_origin(*, explicit=None, mine=None) -> dict:
    """
    把并集按**来源**分类，给"要显式标注来源"的渠道用 —— gym 里会出现我没打过的场，
    必须能说清是谁给的。返回 `{场次号: 'whitelist'|'mine'|'both'}` 风格的字典 ——
    键名由调用方自己起（这里只给 `both`/`only_explicit`/`only_mine` 三种判定）。
    """
    e = {str(x).strip() for x in (explicit or ()) if str(x).strip()}
    m = {str(x).strip() for x in (mine or ()) if str(x).strip()}
    out: dict = {}
    for k in sorted(e | m):
        out[k] = 'both' if (k in e and k in m) else ('only_explicit' if k in e else 'only_mine')
    return out
