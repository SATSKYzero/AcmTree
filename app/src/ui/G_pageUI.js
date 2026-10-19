// ================================================================
// 副页 UI（ui/G_pageUI.js）
// 职责：副页 Tab 栏渲染、当前页面刷新
// 依赖：shell/state.js, shell/executor.js, A_constants.js,
//       utils/A_helpers.js,
//       G_modal/G_modals.js,
//       I_folderMode.js (renderTree), I_virtualFolderMode.js (renderVirtualPage)
// ================================================================
import { AppState } from '../shell/state.js';
import { execute } from '../shell/executor.js';
import { addPage, deletePage, duplicatePage, setPageHideBlocked, setPageSelected, setVNodeBlocked, syncPageWithTree } from '../core/ops/page.js';
// ★ 页列表 / 计数口径的唯一一份（`ui/kit/pagePicker.js`）
import { pageChoicesOf } from './kit/pagePicker.js';
import { EVENTS, MAX_PAGES } from '../A_constants.js';
import { escapeHtml, getNowStr } from '../utils/A_helpers.js';
// ★ 诊断日志的唯一开关（`localStorage.DSH_DIAG = '1'` + 刷新；见 `utils/diag.js` 文件头）
import { diag, nowMs, msSince } from '../utils/diag.js';
import { showDeleteConfirm, showToast } from './G_modal/G_modals.js';
import { getTreeDisplayMode, getEditMode, renderTree } from './folder/folderMode.js';
import { renderVirtualPage } from './folder/virtualFolderMode.js';
// ★ 副页容器行那几串数字的**后台烘热**（见 `view/stats.js` 那段注释）
import { scheduleVirtualWarmup } from '../view/stats.js';
// ★ 计划栏那条进度的后台烘热（见 `plan/planBar.js:warmPlanBars` 的注释）
import { warmPlanBars } from './plan/planBar.js';
// ★ 副页仪表盘（用户 2026-10-15："副页需要一个仪表盘，用来装副页的全局操作"）
import { PAGE_DASHBOARD_ID, changeBlockedPage, renderPageDashboard, toggleBlockedList } from './folder/pageDashboard.js';

// ================================================================
// 内部辅助
// ================================================================

function getCurrentPageId() {
    return AppState.currentPageId;
}

function getPageById(pageId) {
    return AppState.pages[pageId] || null;
}

function getPagesList() {
    // ★ 页列表与"这一页几个节点"的口径**只有一份**（`ui/kit/pagePicker.js:pageChoicesOf`）——
    //   以前这里、`G4_copy.js`、`G5_todoSheet.js` 各写一遍，其中一处还少了 `max(0, …)`。
    return pageChoicesOf(AppState).map((p) => ({
        id: p.id, name: p.name, nodeCount: p.count, selected: p.selected
    }));
}

// ================================================================
// 副页 Tab 栏渲染
// ================================================================
export function renderPageTabs() {
    // 副页栏的宿主 = `#page-tabs-host`（`index.html` 里在 `#tab-main` 内）。
    // ⚠️ 2026-10-18 之前这里找的是 `.app-header` 并 `header.after(...)` —— 那时副页栏**挂在顶部栏后面**，
    //   于是"把顶部栏挪到一级 tab 栏上面"就做不了（副页栏会跟着跑上去）。顶部栏与副页栏是两件事：
    //   顶部栏全局可见、副页栏只属于主视图 ⇒ 各占一个槽位。
    const host = document.getElementById('page-tabs-host');
    if (!host) return;
    let tabsContainer = document.getElementById('page-tabs');
    if (tabsContainer) tabsContainer.remove();
    // ⚠️ 副页仪表盘那个槽位**也要先摘掉旧的**：`renderPageTabs()` 每次重画都会被调一次
    //    （切页 / 改设置 / 每次 `execute` 成功的 onSuccess…），只建不删就会**一层摞一层**
    //    —— 实测：连续几次重画之后页面上叠了 4 块一样的仪表盘。
    const staleDash = document.getElementById(PAGE_DASHBOARD_ID);
    if (staleDash) staleDash.remove();

    tabsContainer = document.createElement('div');
    tabsContainer.id = 'page-tabs';
    tabsContainer.style.cssText = `
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 4px 0 8px 0;
        border-bottom: 1px solid #e2e8f0;
        margin-top: 4px;
        flex-wrap: wrap;
    `;

    const currentId = getCurrentPageId();
    const editMode = getEditMode();

    // ---- 主页按钮 ----
    const mainBtn = document.createElement('button');
    mainBtn.className = 'btn';
    mainBtn.textContent = '🏠 主页';
    mainBtn.dataset.page = 'main';
    mainBtn.style.cssText = `
        background: ${currentId === 'main' ? '#bfdbfe' : 'transparent'};
        color: #1e293b;
        border-color: ${currentId === 'main' ? '#bfdbfe' : '#d1d5db'};
    `;
    mainBtn.addEventListener('click', () => {
        document.dispatchEvent(new CustomEvent(EVENTS.SWITCH_PAGE, {
            detail: { pageId: 'main' }
        }));
    });
    tabsContainer.appendChild(mainBtn);

    // ---- 副页按钮 ----
    const pages = getPagesList();
    for (const page of pages) {
        const isActive = currentId === page.id;
        const btn = document.createElement('button');
        btn.className = 'btn';
        btn.dataset.page = page.id;

        // ★ 全局操作（复制 / 删除 / 重命名 / 与主树对齐）**全部搬进副页仪表盘**了
        //   （用户 2026-10-15："副页需要一个仪表盘，用来装副页的全局操作"；口径见 `docs/subpage-sync.md` 的「副页对齐」一节）。
        //   页签上只留**选择模式那颗整页 ○** —— "同一件事两处入口"正是 `v9.4.9` 删掉的那一类问题。
        let actionHtml = '';
        if (editMode === 'selection') {
            const isSelected = page.selected || false;
            actionHtml += `<span class="page-select-toggle" data-page-id="${page.id}" style="display:inline-block; width:14px; height:14px; border-radius:50%; border:2px solid ${isSelected ? '#2563eb' : '#94a3b8'}; background:${isSelected ? '#2563eb' : 'transparent'}; cursor:pointer; margin-left:4px; flex-shrink:0;"></span>`;
        }

        btn.innerHTML = `📄 ${escapeHtml(page.name)} (${page.nodeCount}) ${actionHtml}`;
        btn.style.cssText = `
            background: ${isActive ? '#bfdbfe' : 'transparent'};
            color: #1e293b;
            border-color: ${isActive ? '#bfdbfe' : '#d1d5db'};
            display: inline-flex;
            align-items: center;
            gap: 4px;
        `;

        btn.addEventListener('click', (e) => {
            // ★ 这颗小按钮的点击**不许**再触发"整颗 tab"的行为（切页 / Ctrl 开副页设置）。
            //   ⚠️ 必须**分开写 `closest`**：DOM 桩不解析逗号选择器（`docs/ui-conventions.md` §8），
            //   合写成 `.a, .b` 会让这条守卫在冒烟里**看着在、其实返回 null**。
            //   ⚠️ 另外三个分支（`.page-del-btn` / `.page-copy-btn`）现在住在**仪表盘**里、不在 tab 上；
            //      留着它们是防"以后又放回来" —— 真要放回来时**别删**这几个判断。
            if (e.target.closest('.page-del-btn') || e.target.closest('.page-select-toggle')
                || e.target.closest('.page-copy-btn')) return;

            if (e.ctrlKey || e.metaKey) {
                e.preventDefault();
                import('./G_modal/G_modals.js').then(module => {
                    module.showPageEditDialog(page.id, page.name, () => {
                        renderPageTabs();
                    });
                });
                return;
            }

            document.dispatchEvent(new CustomEvent(EVENTS.SWITCH_PAGE, {
                detail: { pageId: page.id }
            }));
        });

        tabsContainer.appendChild(btn);
    }

    // ---- 新建副页按钮 ----
    const addBtn = document.createElement('button');
    addBtn.className = 'btn btn-primary';
    addBtn.textContent = '+ 新建副页';
    addBtn.style.cssText = `padding: 4px 12px; font-size: 13px;`;
    addBtn.addEventListener('click', async () => {
        const name = prompt('请输入副页名称：', '我的题单');
        if (name === null || name.trim() === '') return;
        const trimmed = name.trim();

        try {
            await execute(
                (draft) => {
                    if (Object.keys(draft.pages).length >= MAX_PAGES) {
                        throw new Error(`副页数量已达上限（${MAX_PAGES}个）`);
                    }
                    // 建副页走 core 的唯一实现（重名检查、id 生成、根 vNode 都在那里；
                    // 只读守卫也在那里 —— 自己拼 page 对象等于绕过守卫）
                    const page = addPage(draft, trimmed);
                    draft.currentPageId = page.id;
                    return { pageId: page.id };
                },
                {
                    validate: false,
                    refreshParentId: null,
                    onSuccess: () => {
                        renderPageTabs();
                        refreshCurrentPage();
                    },
                    onError: (err) => {
                        alert(err.message);
                    }
                }
            );
        } catch (_) {}
    });
    tabsContainer.appendChild(addBtn);

    host.appendChild(tabsContainer);

    // ---- 副页仪表盘（**槽位**；内容由 `folder/pageDashboard.js` 按当前页填）----
    // 用户 2026-10-15："副页需要一个仪表盘，用来装副页的全局操作"（口径见 `docs/subpage-sync.md` §2③）。
    // ⚠️ 槽位跟页签**一起重建**（`#page-tabs` 本身就是每次 remove + 重建的）；主页时它被隐藏并清空。
    const dash = document.createElement('div');
    dash.id = PAGE_DASHBOARD_ID;
    // 「模块尽可能有圆角淡框」（用户 2026-10-15）—— 整块也套一个淡框
    dash.style.cssText = 'display:none;margin:4px 0 8px 0;padding:8px 10px;'
        + 'border:1px solid #eef2f6;border-radius:8px;background:#fff;';
    host.appendChild(dash);
    renderPageDashboard(currentId);
}

// ================================================================
// 刷新当前页面
// ================================================================
export function refreshCurrentPage(opts = {}) {
    const pageId = getCurrentPageId();
    const treeStats = document.getElementById('tree-stats');
    // 诊断（2026-10-18，用户排查"切副页还是慢"）：逐段打毫秒数。
    // ⚠️ 只是日志；开关在 `utils/diag.js` 一处（`localStorage.DSH_DIAG = '1'` + 刷新）。
    const t0 = nowMs();
    const lap = (name) => diag('切页', `${name} = ${msSince(t0)}ms（累计）`);

    if (pageId === 'main') {
        renderTree(opts);
        lap('主页 renderTree');
        // 主页上没有"副页仪表盘"这回事 ⇒ 顺手收起（切页走的是这条路，不是每次都会重画页签）
        renderPageDashboard('main');
        lap('主页 仪表盘');
    } else {
        if (treeStats) treeStats.style.display = 'none';
        renderVirtualPage(pageId);
        lap('副页 renderVirtualPage');
        renderPageDashboard(pageId);
        lap('副页 仪表盘');
    }
    // ★ 把副页容器行那几串数字**在后台烘热**（用户 2026-10-18："在启动/刷新时就计算，跟主页一样，
    //   但可以延迟"）。刷新/切页/数据变动都会走到这里 ⇒ 等你点进副页时它已经是热的。
    //   ⚠️ 幂等 + 切片（每片 8ms）⇒ 不阻塞首屏/交互；同一页同一代已经烘过就直接跳过。
    scheduleVirtualWarmup(AppState);
    // ★ 计划栏那条进度同理（冷算 ~23ms / 页，切进副页时那一格会现算）
    warmPlanBars(AppState);
}

// ================================================================
// 副页 Tab 按钮事件委托（删除、选中切换）
// ================================================================
// ================================================================
// 复制整个副页（`⧉` 那两颗入口共用这一份）
//
// 口径与边界：`docs/subpage-copy.md`。要点：
//   · 结构 + 视图态一起复制、**页内 id 全换新**、`refId` 原样（两页指向同一批题）；
//   · **不复制计划**、不复制 `view.pages[id]`；
//   · 复制完**直接切到新副页**（复制出来就是为了用它）。
// ================================================================
async function runDuplicatePage(pageId, newName) {
    try {
        await execute(
            (draft) => {
                const { page: newPage } = duplicatePage(draft, pageId, newName);
                draft.currentPageId = newPage.id;
                // ⚠️ 返回值**原样**交给 `onSuccess`（`G5_actions.js` 就是 `result.count` 那种用法）
                return { page: newPage };
            },
            {
                validate: false,
                refreshParentId: null,
                onSuccess: (result) => {
                    renderPageTabs();
                    refreshCurrentPage();
                    // ⚠️ 别靠 `onSuccess` 的入参取名字（执行器那层的 result 形状是另一件事，
                    //    这里只做"界面刷新"这一件事 —— 与删除那一路同一个形状）。
                    const page = (result && result.page) || null;
                    showToast(page ? `已复制成副页「${page.name}」` : '副页已复制', 'success');
                },
                onError: (err) => {
                    showToast('复制失败: ' + err.message, 'error');
                }
            }
        );
    } catch (_) {}
}

// ================================================================
// 🔄 与主树对齐（仪表盘那颗）
//
// 口径与边界：`docs/subpage-sync.md` 的「副页对齐」一节。要点：
//   · **只加不删**、**同级顺序跟主树**（`childOrder`：有共同主树父就排、主树里已经没有的垫到末尾；
//     页根那层要求孩子来自同一个主树父）、**幂等**；
//   · 走到**被屏蔽**的节点就**不再往下递归**（那一支已有的内容不增不减）；
//   · 页里没有的那几支**永远不进来**（所以"只保留 22~26 年"就是"页根下只放那几年"）。
// ================================================================
async function runSyncPage(pageId) {
    const page = getPageById(pageId);
    if (!page) return;
    let report = null;
    try {
        await execute(
            (draft) => {
                report = syncPageWithTree(draft, pageId);
                return report;
            },
            {
                validate: false,
                refreshParentId: null,
                onSuccess: () => {
                    renderPageTabs();
                    refreshCurrentPage();
                    const r = report || { added: 0, blocked: 0, reordered: 0 };
                    const bits = [`补进 ${r.added} 个`];
                    if (r.reordered) bits.push(`${r.reordered} 层顺序跟主树`);
                    if (r.blocked) bits.push(`${r.blocked} 处屏蔽没往下走`);
                    showToast((r.added || r.reordered) ? `已与主树对齐：${bits.join('，')}`
                        : `没有新东西（${bits.join('，')}）`, 'success');
                },
                onError: (err) => {
                    showToast('对齐失败: ' + err.message, 'error');
                }
            }
        );
    } catch (_) {}
}

/** 取消一处屏蔽（仪表盘的屏蔽清单里那一颗） */
async function runUnblock(pageId, vid) {
    if (!pageId || !vid) return;
    try {
        await execute(
            (draft) => {
                setVNodeBlocked(draft, pageId, vid, false);
            },
            {
                validate: false,
                refreshParentId: null,
                onSuccess: () => {
                    renderPageTabs();
                    refreshCurrentPage();
                    showToast('已取消屏蔽', 'success');
                },
                onError: (err) => {
                    showToast(err.message || '取消屏蔽失败', 'error');
                }
            }
        );
    } catch (_) {}
}

/** 折 / 展开仪表盘上"已屏蔽 N 处"那份清单（默认折叠 —— 几十条会顶掉别的东西） */
function runToggleBlockedList() {
    toggleBlockedList();
}

/** 勾 / 取消「不显示屏蔽的部分」（页级字段：只管渲染；统计里本来就不算屏蔽的支） */
async function runSetHideBlocked(pageId, hide) {
    const page = getPageById(pageId);
    if (!page) return;
    try {
        await execute(
            (draft) => {
                setPageHideBlocked(draft, pageId, hide);
            },
            {
                validate: false,
                refreshParentId: null,
                onSuccess: () => {
                    renderPageTabs();
                    refreshCurrentPage();
                    showToast(hide ? '已隐藏屏蔽的部分（只是不画，数据没动）' : '屏蔽的部分又画出来了', 'success');
                },
                onError: (err) => {
                    showToast(err.message || '改不了这个开关', 'error');
                }
            }
        );
    } catch (_) {}
}

export function setupPageTabsEvents() {
    document.addEventListener('click', function (e) {
        // ---- 删除按钮 ----
        const delBtn = e.target.closest('.page-del-btn');
        if (delBtn) {
            e.stopPropagation();
            const pageId = delBtn.dataset.pageId;
            if (!pageId) return;
            if (!e.ctrlKey) {
                showToast('请按住 Ctrl 键执行删除操作', 'error');
                return;
            }
            const page = getPageById(pageId);
            if (!page) return;
            const pageName = page.name;
            showDeleteConfirm('删除副页', `确定要删除副页「${escapeHtml(pageName)}」吗？`, async (confirmed) => {
                if (!confirmed) return;
                try {
                    await execute(
                        (draft) => {
                            // 删副页也走 core 的唯一实现（守卫 + currentPageId 回落都在那里）
                            deletePage(draft, pageId);
                        },
                        {
                            validate: false,
                            refreshParentId: null,
                            onSuccess: () => {
                                refreshCurrentPage();
                                renderPageTabs();
                            },
                            onError: (err) => {
                                showToast('删除失败: ' + err.message, 'error');
                            }
                        }
                    );
                } catch (_) {}
            });
            return;
        }

        // ---- 复制副页（⧉）：普通点击直接复制；按住 Ctrl 点 ⇒ 先问新名字 ----
        const copyBtn = e.target.closest('.page-copy-btn');
        if (copyBtn) {
            e.stopPropagation();
            const pageId = copyBtn.dataset.pageId;
            if (!pageId) return;
            const page = getPageById(pageId);
            if (!page) return;
            if (e.ctrlKey) {
                import('./G_modal/G_modals.js').then((module) => {
                    module.showPromptDialog('复制副页', `把「${page.name}」复制一份，新副页名：`,
                        `${page.name}副本`, (name) => {
                            // ⚠️ **取消 / 名字清空 ⇒ 什么都不做**（`showPromptDialog` 这两种情况都给 `null`）。
                            //   以前这里直接 `runDuplicatePage(pageId, null)` ⇒ core 用默认名「原名副本」
                            //   **照常复制** —— 用户 2026-10-13 报的正是这个：
                            //   "取消只取消命名但不取消复制,反直觉"。
                            //   ⚠️ 与 `G4_add.js` 那几处（`if (!name || !name.trim()) return;`）是**同一条约定**，
                            //   别在这一处特立独行。
                            if (!name || !name.trim()) return;
                            runDuplicatePage(pageId, name.trim());
                        });
                });
                return;
            }
            runDuplicatePage(pageId, '');
            return;
        }

        // ---- 仪表盘那几颗：✎ 重命名 / 🔄 与主树对齐 / 取消屏蔽 ----
        //   （⧉ / ✖ 两颗仍走上面那两条分支 —— 它们现在住在仪表盘里，class 与 `data-page-id` 是同一套）
        const renameBtn = e.target.closest('.page-rename-btn');
        if (renameBtn) {
            e.stopPropagation();
            const page = renameBtn.dataset.pageId ? getPageById(renameBtn.dataset.pageId) : null;
            if (page) {
                import('./G_modal/G_modals.js').then((module) => {
                    module.showPageEditDialog(page.id, page.name, () => {
                        renderPageTabs();
                        refreshCurrentPage();
                    });
                });
            }
            return;
        }
        const syncBtn = e.target.closest('.page-sync-btn');
        if (syncBtn) {
            e.stopPropagation();
            if (syncBtn.dataset.pageId) runSyncPage(syncBtn.dataset.pageId);
            return;
        }
        const unblockBtn = e.target.closest('.page-unblock-btn');
        if (unblockBtn) {
            e.stopPropagation();
            runUnblock(unblockBtn.dataset.pageId, unblockBtn.dataset.vid);
            return;
        }
        const blockedToggle = e.target.closest('.page-blocked-toggle');
        if (blockedToggle) {
            e.stopPropagation();
            runToggleBlockedList();
            return;
        }
        // 清单翻页（◀ / ▶）—— 页大小是**那个清单自己的**（默认 10），与树的「每页条数」设置无关
        const pageBtn = e.target.closest('.page-blocked-prev') || e.target.closest('.page-blocked-next');
        if (pageBtn) {
            e.stopPropagation();
            changeBlockedPage(Number(pageBtn.dataset.delta) < 0 ? -1 : 1);
            return;
        }
        // ⚠️ 复选框读 `.checked`（`value` 恒为 `"on"` —— `docs/ui-conventions.md` §10）
        const hideBox = e.target.closest('.page-hide-blocked');
        if (hideBox) {
            e.stopPropagation();
            const pageId = AppState.currentPageId;
            if (pageId && pageId !== 'main') runSetHideBlocked(pageId, !!hideBox.checked);
            return;
        }

        // ---- 选中切换按钮 ----
        const toggleBtn = e.target.closest('.page-select-toggle');
        if (toggleBtn) {
            e.stopPropagation();
            const pageId = toggleBtn.dataset.pageId;
            if (!pageId) return;
            const page = getPageById(pageId);
            if (!page) return;
            const newSelected = !page.selected;
            execute(
                (draft) => {
                    // ★ 走 `core/ops/page.js:setPageSelected()`（**声明的写口**），别在界面里就地写那一格
                    //   （2026-10-16 修，审计点出来的"绕道"）：那个口还负责 `lastModified`（页签排序/
                    //   同步要用的元信息）与"副页不存在"的错误文案 —— 就地写就悄悄丢掉了那一半。
                    setPageSelected(draft, pageId, newSelected);
                },
                {
                    validate: false,
                    refreshParentId: null,
                    onSuccess: () => {
                        renderPageTabs();
                        refreshCurrentPage();
                    },
                    onError: (err) => {
                        showToast('切换失败: ' + err.message, 'error');
                    }
                }
            ).catch(() => {});
            return;
        }
    });
}