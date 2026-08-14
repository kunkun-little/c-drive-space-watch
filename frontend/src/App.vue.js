import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { api } from './api';
import { formatBytes, formatDate, formatNs } from './utils';
const page = ref('snapshots');
const snapshots = ref([]);
const config = ref({ listen: '127.0.0.1:8899', defaultScanRoot: 'C:\\Users', excludePaths: [], useAllocatedSize: true, recordFileData: false });
const loadingSnapshots = ref(false);
const globalError = ref('');
const toast = ref('');
const showCreate = ref(false);
const showSettings = ref(false);
const newRoot = ref('C:\\Users');
const newName = ref('');
const creating = ref(false);
const picking = ref(false);
const savingSettings = ref(false);
const snapshotA = ref('');
const snapshotB = ref('');
const comparePath = ref('');
const showUnchanged = ref(false);
const comparison = ref(null);
const comparing = ref(false);
const compareError = ref('');
const sortKey = ref('delta');
const sortDesc = ref(true);
const searchText = ref('');
let pollTimer = 0;
let toastTimer = 0;
const readySnapshots = computed(() => snapshots.value.filter(s => s.status === 'ready'));
const scanningCount = computed(() => snapshots.value.filter(s => s.status === 'scanning').length);
const totalSnapshotSize = computed(() => snapshots.value.filter(s => s.status === 'ready').reduce((sum, s) => sum + s.totalSize, 0));
const currentItems = computed(() => comparison.value?.items ?? []);
const filteredItems = computed(() => {
    const q = searchText.value.trim().toLowerCase();
    const rows = q ? currentItems.value.filter(x => x.name.toLowerCase().includes(q)) : [...currentItems.value];
    return rows.sort((a, b) => {
        if (a.isDir !== b.isDir)
            return a.isDir ? -1 : 1;
        const av = a[sortKey.value];
        const bv = b[sortKey.value];
        let n = 0;
        if (typeof av === 'string' && typeof bv === 'string')
            n = av.localeCompare(bv, 'zh-CN', { numeric: true, sensitivity: 'base' });
        else
            n = Number(av) - Number(bv);
        return sortDesc.value ? -n : n;
    });
});
const pathSegments = computed(() => comparePath.value ? comparePath.value.split('/').filter(Boolean) : []);
const currentDelta = computed(() => currentItems.value.reduce((sum, x) => sum + x.delta, 0));
const changedCount = computed(() => currentItems.value.filter(x => x.status !== 'unchanged').length);
const addedCount = computed(() => currentItems.value.filter(x => x.status === 'added').length);
const removedCount = computed(() => currentItems.value.filter(x => x.status === 'removed').length);
function notify(message) {
    toast.value = message;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => { toast.value = ''; }, 2600);
}
async function loadInitial() {
    try {
        const [cfg] = await Promise.all([api.getConfig(), loadSnapshots()]);
        config.value = cfg;
        newRoot.value = cfg.defaultScanRoot;
        chooseDefaultPair();
    }
    catch (err) {
        globalError.value = errorText(err);
    }
}
async function loadSnapshots(silent = false) {
    if (!silent)
        loadingSnapshots.value = true;
    try {
        snapshots.value = await api.listSnapshots();
        chooseDefaultPair();
    }
    catch (err) {
        if (!silent)
            globalError.value = errorText(err);
    }
    finally {
        if (!silent)
            loadingSnapshots.value = false;
    }
}
function chooseDefaultPair() {
    const ready = readySnapshots.value;
    const ids = new Set(ready.map(s => s.id));
    if (snapshotA.value && !ids.has(snapshotA.value))
        snapshotA.value = '';
    if (snapshotB.value && !ids.has(snapshotB.value))
        snapshotB.value = '';
    if (!snapshotB.value && ready[0])
        snapshotB.value = ready[0].id;
    if (!snapshotA.value && ready[1])
        snapshotA.value = ready[1].id;
    if (snapshotA.value === snapshotB.value)
        snapshotA.value = ready.find(s => s.id !== snapshotB.value)?.id || '';
}
function openCreate() {
    newRoot.value = config.value.defaultScanRoot;
    newName.value = '';
    showCreate.value = true;
}
async function pickFolder(target) {
    picking.value = true;
    globalError.value = '';
    try {
        const result = await api.pickFolder();
        if (result.path) {
            if (target === 'snapshot')
                newRoot.value = result.path;
            else
                config.value.defaultScanRoot = result.path;
        }
    }
    catch (err) {
        globalError.value = errorText(err);
    }
    finally {
        picking.value = false;
    }
}
async function createSnapshot() {
    const rootPath = newRoot.value.trim();
    if (!rootPath)
        return;
    creating.value = true;
    globalError.value = '';
    try {
        await api.createSnapshot({ rootPath, name: newName.value.trim() || undefined });
        showCreate.value = false;
        await loadSnapshots(true);
        notify('快照任务已开始扫描');
    }
    catch (err) {
        globalError.value = errorText(err);
    }
    finally {
        creating.value = false;
    }
}
async function deleteSnapshot(row) {
    if (!confirm(`确定删除快照“${row.name}”吗？\n\n删除后会同时移除该快照的全部目录/文件索引数据。`))
        return;
    try {
        await api.deleteSnapshot(row.id);
        if (snapshotA.value === row.id)
            snapshotA.value = '';
        if (snapshotB.value === row.id)
            snapshotB.value = '';
        comparison.value = null;
        await loadSnapshots(true);
        notify('快照已删除');
    }
    catch (err) {
        globalError.value = errorText(err);
    }
}
function setAsA(row) {
    snapshotA.value = row.id;
    if (!snapshotB.value || snapshotB.value === row.id) {
        const other = readySnapshots.value.find(s => s.id !== row.id);
        snapshotB.value = other?.id || '';
    }
    comparePath.value = '';
    page.value = 'compare';
    void runCompare();
}
function setAsB(row) {
    snapshotB.value = row.id;
    if (!snapshotA.value || snapshotA.value === row.id) {
        const other = readySnapshots.value.find(s => s.id !== row.id);
        snapshotA.value = other?.id || '';
    }
    comparePath.value = '';
    page.value = 'compare';
    void runCompare();
}
async function saveSettings() {
    savingSettings.value = true;
    globalError.value = '';
    try {
        config.value = await api.saveConfig(config.value);
        newRoot.value = config.value.defaultScanRoot;
        showSettings.value = false;
        notify('设置已保存');
    }
    catch (err) {
        globalError.value = errorText(err);
    }
    finally {
        savingSettings.value = false;
    }
}
async function runCompare() {
    if (!snapshotA.value || !snapshotB.value) {
        compareError.value = '至少需要两个已完成快照才能进行比较。';
        comparison.value = null;
        return;
    }
    if (snapshotA.value === snapshotB.value) {
        compareError.value = '快照 A 和快照 B 必须是两个不同的快照。';
        comparison.value = null;
        return;
    }
    comparing.value = true;
    compareError.value = '';
    try {
        comparison.value = await api.compare(snapshotA.value, snapshotB.value, comparePath.value, showUnchanged.value);
    }
    catch (err) {
        compareError.value = errorText(err);
        comparison.value = null;
    }
    finally {
        comparing.value = false;
    }
}
function enterFolder(row) {
    if (!row.isDir)
        return;
    comparePath.value = row.relPath;
    searchText.value = '';
    void runCompare();
}
function goUp() {
    if (!comparePath.value)
        return;
    const parts = comparePath.value.split('/').filter(Boolean);
    parts.pop();
    comparePath.value = parts.join('/');
    void runCompare();
}
function goRoot() {
    comparePath.value = '';
    void runCompare();
}
function goSegment(index) {
    comparePath.value = pathSegments.value.slice(0, index + 1).join('/');
    void runCompare();
}
function setSort(key) {
    if (sortKey.value === key)
        sortDesc.value = !sortDesc.value;
    else {
        sortKey.value = key;
        sortDesc.value = key !== 'name' && key !== 'status';
    }
}
function sortMark(key) {
    if (sortKey.value !== key)
        return '';
    return sortDesc.value ? ' ↓' : ' ↑';
}
function statusText(status) {
    return { added: '新增', removed: '删除', modified: '变化', unchanged: '未变化' }[status];
}
function snapshotStatusText(row) {
    return { scanning: '扫描中', ready: '已完成', failed: '失败' }[row.status];
}
function errorText(err) {
    return err instanceof Error ? err.message : String(err);
}
watch([snapshotA, snapshotB], () => {
    comparePath.value = '';
    comparison.value = null;
});
watch(showUnchanged, () => {
    if (page.value === 'compare' && snapshotA.value && snapshotB.value)
        void runCompare();
});
watch(page, value => {
    if (value === 'compare' && !comparison.value && snapshotA.value && snapshotB.value)
        void runCompare();
});
onMounted(() => {
    void loadInitial();
    pollTimer = window.setInterval(async () => {
        if (scanningCount.value > 0)
            await loadSnapshots(true);
    }, 1500);
});
onBeforeUnmount(() => {
    window.clearInterval(pollTimer);
    window.clearTimeout(toastTimer);
});
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "app-shell" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.header, __VLS_intrinsicElements.header)({
    ...{ class: "topbar" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "brand" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "brand-mark" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "brand-title" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "brand-subtitle" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "top-actions" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
    ...{ onClick: (...[$event]) => {
            __VLS_ctx.showSettings = true;
        } },
    ...{ class: "btn btn-secondary" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
    ...{ onClick: (__VLS_ctx.openCreate) },
    ...{ class: "btn btn-primary" },
});
if (__VLS_ctx.globalError) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "error-banner" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
    (__VLS_ctx.globalError);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.globalError))
                    return;
                __VLS_ctx.globalError = '';
            } },
        ...{ class: "icon-btn" },
    });
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.main, __VLS_intrinsicElements.main)({
    ...{ class: "workspace" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.aside, __VLS_intrinsicElements.aside)({
    ...{ class: "sidebar" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.nav, __VLS_intrinsicElements.nav)({
    ...{ class: "nav-list" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
    ...{ onClick: (...[$event]) => {
            __VLS_ctx.page = 'snapshots';
        } },
    ...{ class: (['nav-item', { active: __VLS_ctx.page === 'snapshots' }]) },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "nav-icon" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
    ...{ onClick: (...[$event]) => {
            __VLS_ctx.page = 'compare';
        } },
    ...{ class: (['nav-item', { active: __VLS_ctx.page === 'compare' }]) },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "nav-icon" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "sidebar-info" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "side-label" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "side-path" },
    title: (__VLS_ctx.config.defaultScanRoot),
});
(__VLS_ctx.config.defaultScanRoot);
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "side-stats" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
(__VLS_ctx.snapshots.length);
if (__VLS_ctx.scanningCount) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "scan-dot" },
    });
    (__VLS_ctx.scanningCount);
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.section, __VLS_intrinsicElements.section)({
    ...{ class: "content" },
});
if (__VLS_ctx.page === 'snapshots') {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "page-heading" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.h1, __VLS_intrinsicElements.h1)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (__VLS_ctx.openCreate) },
        ...{ class: "btn btn-primary mobile-create" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "metrics-grid" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "metric-card" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.strong, __VLS_intrinsicElements.strong)({});
    (__VLS_ctx.snapshots.length);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.small, __VLS_intrinsicElements.small)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "metric-card" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.strong, __VLS_intrinsicElements.strong)({});
    (__VLS_ctx.scanningCount);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.small, __VLS_intrinsicElements.small)({});
    (__VLS_ctx.scanningCount ? '后台扫描进行中' : '当前无任务');
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "metric-card" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.strong, __VLS_intrinsicElements.strong)({});
    (__VLS_ctx.formatBytes(__VLS_ctx.totalSnapshotSize));
    __VLS_asFunctionalElement(__VLS_intrinsicElements.small, __VLS_intrinsicElements.small)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "panel snapshot-panel" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "panel-toolbar" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.strong, __VLS_intrinsicElements.strong)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "muted" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.page === 'snapshots'))
                    return;
                __VLS_ctx.loadSnapshots();
            } },
        ...{ class: "btn btn-ghost" },
        disabled: (__VLS_ctx.loadingSnapshots),
    });
    if (__VLS_ctx.loadingSnapshots && !__VLS_ctx.snapshots.length) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "empty-state" },
        });
    }
    else if (!__VLS_ctx.snapshots.length) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "empty-state" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "empty-icon" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.strong, __VLS_intrinsicElements.strong)({});
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
        (__VLS_ctx.config.defaultScanRoot);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
            ...{ onClick: (__VLS_ctx.openCreate) },
            ...{ class: "btn btn-primary" },
        });
    }
    else {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "snapshot-list" },
        });
        for (const [row] of __VLS_getVForSourceType((__VLS_ctx.snapshots))) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.article, __VLS_intrinsicElements.article)({
                key: (row.id),
                ...{ class: "snapshot-row" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "snapshot-icon" },
                ...{ class: (row.status) },
            });
            (row.status === 'ready' ? '◫' : row.status === 'scanning' ? '◌' : '!');
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "snapshot-main" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "snapshot-title-line" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.strong, __VLS_intrinsicElements.strong)({});
            (row.name);
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: (['status-chip', row.status]) },
            });
            (__VLS_ctx.snapshotStatusText(row));
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "snapshot-path" },
                title: (row.rootPath),
            });
            (row.rootPath);
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "snapshot-meta" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
            (__VLS_ctx.formatDate(row.createdAt));
            if (row.status === 'ready') {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
                (row.entryCount.toLocaleString());
            }
            if (row.status === 'ready') {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
                (row.fileCount.toLocaleString());
            }
            if (row.status === 'ready') {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
                (row.recordFileData ? '含文件明细' : '仅文件夹数据');
            }
            if (row.skippedCount) {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
                (row.skippedCount.toLocaleString());
            }
            if (row.status === 'failed') {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                    ...{ class: "danger-text" },
                    title: (row.errorMessage),
                });
                (row.errorMessage);
            }
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "snapshot-size" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.strong, __VLS_intrinsicElements.strong)({});
            (row.status === 'ready' ? __VLS_ctx.formatBytes(row.totalSize) : '—');
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
            (row.status === 'ready' ? `${row.dirCount.toLocaleString()} 文件夹` : row.status === 'scanning' ? '正在建立索引…' : '未完成');
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "snapshot-actions" },
            });
            if (row.status === 'ready') {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
                    ...{ onClick: (...[$event]) => {
                            if (!(__VLS_ctx.page === 'snapshots'))
                                return;
                            if (!!(__VLS_ctx.loadingSnapshots && !__VLS_ctx.snapshots.length))
                                return;
                            if (!!(!__VLS_ctx.snapshots.length))
                                return;
                            if (!(row.status === 'ready'))
                                return;
                            __VLS_ctx.setAsA(row);
                        } },
                    ...{ class: "btn btn-small" },
                });
            }
            if (row.status === 'ready') {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
                    ...{ onClick: (...[$event]) => {
                            if (!(__VLS_ctx.page === 'snapshots'))
                                return;
                            if (!!(__VLS_ctx.loadingSnapshots && !__VLS_ctx.snapshots.length))
                                return;
                            if (!!(!__VLS_ctx.snapshots.length))
                                return;
                            if (!(row.status === 'ready'))
                                return;
                            __VLS_ctx.setAsB(row);
                        } },
                    ...{ class: "btn btn-small btn-accent-light" },
                });
            }
            __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
                ...{ onClick: (...[$event]) => {
                        if (!(__VLS_ctx.page === 'snapshots'))
                            return;
                        if (!!(__VLS_ctx.loadingSnapshots && !__VLS_ctx.snapshots.length))
                            return;
                        if (!!(!__VLS_ctx.snapshots.length))
                            return;
                        __VLS_ctx.deleteSnapshot(row);
                    } },
                ...{ class: "icon-btn danger" },
                disabled: (row.status === 'scanning'),
                title: "删除快照",
            });
        }
    }
}
else {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "page-heading compare-heading" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.h1, __VLS_intrinsicElements.h1)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "compare-selectors panel" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.select, __VLS_intrinsicElements.select)({
        value: (__VLS_ctx.snapshotA),
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.option, __VLS_intrinsicElements.option)({
        value: "",
    });
    for (const [s] of __VLS_getVForSourceType((__VLS_ctx.readySnapshots))) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.option, __VLS_intrinsicElements.option)({
            key: (s.id),
            value: (s.id),
        });
        (s.name);
        (s.rootPath);
    }
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "compare-arrow" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.select, __VLS_intrinsicElements.select)({
        value: (__VLS_ctx.snapshotB),
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.option, __VLS_intrinsicElements.option)({
        value: "",
    });
    for (const [s] of __VLS_getVForSourceType((__VLS_ctx.readySnapshots))) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.option, __VLS_intrinsicElements.option)({
            key: (s.id),
            value: (s.id),
        });
        (s.name);
        (s.rootPath);
    }
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (__VLS_ctx.runCompare) },
        ...{ class: "btn btn-primary compare-btn" },
        disabled: (__VLS_ctx.comparing || !__VLS_ctx.snapshotA || !__VLS_ctx.snapshotB),
    });
    (__VLS_ctx.comparing ? '比较中…' : '开始比较');
    if (__VLS_ctx.compareError) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "panel empty-state compact-error" },
        });
        (__VLS_ctx.compareError);
    }
    if (__VLS_ctx.comparison) {
        if (__VLS_ctx.comparison.snapshotA.rootPath.toLowerCase() !== __VLS_ctx.comparison.snapshotB.rootPath.toLowerCase()) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "warning-banner" },
            });
            (__VLS_ctx.comparison.snapshotA.rootPath);
            (__VLS_ctx.comparison.snapshotB.rootPath);
        }
        if (!__VLS_ctx.comparison.snapshotA.recordFileData || !__VLS_ctx.comparison.snapshotB.recordFileData) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "warning-banner" },
            });
        }
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "metrics-grid compare-metrics" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "metric-card" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
        __VLS_asFunctionalElement(__VLS_intrinsicElements.strong, __VLS_intrinsicElements.strong)({});
        (__VLS_ctx.formatBytes(__VLS_ctx.comparison.summary.sizeA));
        __VLS_asFunctionalElement(__VLS_intrinsicElements.small, __VLS_intrinsicElements.small)({});
        (__VLS_ctx.comparison.snapshotA.name);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "metric-card" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
        __VLS_asFunctionalElement(__VLS_intrinsicElements.strong, __VLS_intrinsicElements.strong)({});
        (__VLS_ctx.formatBytes(__VLS_ctx.comparison.summary.sizeB));
        __VLS_asFunctionalElement(__VLS_intrinsicElements.small, __VLS_intrinsicElements.small)({});
        (__VLS_ctx.comparison.snapshotB.name);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "metric-card" },
            ...{ class: ({ 'delta-positive': __VLS_ctx.comparison.summary.delta > 0, 'delta-negative': __VLS_ctx.comparison.summary.delta < 0 }) },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
        __VLS_asFunctionalElement(__VLS_intrinsicElements.strong, __VLS_intrinsicElements.strong)({});
        (__VLS_ctx.formatBytes(__VLS_ctx.comparison.summary.delta, true));
        __VLS_asFunctionalElement(__VLS_intrinsicElements.small, __VLS_intrinsicElements.small)({});
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "metric-card" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
        __VLS_asFunctionalElement(__VLS_intrinsicElements.strong, __VLS_intrinsicElements.strong)({});
        (__VLS_ctx.changedCount);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.small, __VLS_intrinsicElements.small)({});
        (__VLS_ctx.addedCount);
        (__VLS_ctx.removedCount);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "explorer panel" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "explorer-toolbar" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "nav-buttons" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
            ...{ onClick: (__VLS_ctx.goUp) },
            ...{ class: "icon-btn" },
            disabled: (!__VLS_ctx.comparePath),
            title: "上一级",
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
            ...{ onClick: (__VLS_ctx.runCompare) },
            ...{ class: "icon-btn" },
            title: "刷新",
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "breadcrumb" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
            ...{ onClick: (__VLS_ctx.goRoot) },
            ...{ class: "crumb root" },
        });
        (__VLS_ctx.comparison.snapshotB.rootPath);
        for (const [seg, index] of __VLS_getVForSourceType((__VLS_ctx.pathSegments))) {
            (`${seg}-${index}`);
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
            __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
                ...{ onClick: (...[$event]) => {
                        if (!!(__VLS_ctx.page === 'snapshots'))
                            return;
                        if (!(__VLS_ctx.comparison))
                            return;
                        __VLS_ctx.goSegment(index);
                    } },
                ...{ class: "crumb" },
            });
            (seg);
        }
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "explorer-search" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
        __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
            placeholder: "搜索当前目录",
        });
        (__VLS_ctx.searchText);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "explorer-options" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "legend" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
        __VLS_asFunctionalElement(__VLS_intrinsicElements.i, __VLS_intrinsicElements.i)({
            ...{ class: "legend-dot added" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
        __VLS_asFunctionalElement(__VLS_intrinsicElements.i, __VLS_intrinsicElements.i)({
            ...{ class: "legend-dot removed" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
        __VLS_asFunctionalElement(__VLS_intrinsicElements.i, __VLS_intrinsicElements.i)({
            ...{ class: "legend-dot modified" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
            ...{ class: "switch-row" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
            type: "checkbox",
        });
        (__VLS_ctx.showUnchanged);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "current-delta" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.strong, __VLS_intrinsicElements.strong)({
            ...{ class: (__VLS_ctx.currentDelta > 0 ? 'delta-up' : __VLS_ctx.currentDelta < 0 ? 'delta-down' : '') },
        });
        (__VLS_ctx.formatBytes(__VLS_ctx.currentDelta, true));
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "table-wrap" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.table, __VLS_intrinsicElements.table)({
            ...{ class: "file-table" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.thead, __VLS_intrinsicElements.thead)({});
        __VLS_asFunctionalElement(__VLS_intrinsicElements.tr, __VLS_intrinsicElements.tr)({});
        __VLS_asFunctionalElement(__VLS_intrinsicElements.th, __VLS_intrinsicElements.th)({
            ...{ onClick: (...[$event]) => {
                    if (!!(__VLS_ctx.page === 'snapshots'))
                        return;
                    if (!(__VLS_ctx.comparison))
                        return;
                    __VLS_ctx.setSort('name');
                } },
            ...{ class: "name-col" },
        });
        (__VLS_ctx.sortMark('name'));
        __VLS_asFunctionalElement(__VLS_intrinsicElements.th, __VLS_intrinsicElements.th)({
            ...{ onClick: (...[$event]) => {
                    if (!!(__VLS_ctx.page === 'snapshots'))
                        return;
                    if (!(__VLS_ctx.comparison))
                        return;
                    __VLS_ctx.setSort('status');
                } },
        });
        (__VLS_ctx.sortMark('status'));
        __VLS_asFunctionalElement(__VLS_intrinsicElements.th, __VLS_intrinsicElements.th)({
            ...{ onClick: (...[$event]) => {
                    if (!!(__VLS_ctx.page === 'snapshots'))
                        return;
                    if (!(__VLS_ctx.comparison))
                        return;
                    __VLS_ctx.setSort('sizeA');
                } },
            ...{ class: "num" },
        });
        (__VLS_ctx.sortMark('sizeA'));
        __VLS_asFunctionalElement(__VLS_intrinsicElements.th, __VLS_intrinsicElements.th)({
            ...{ onClick: (...[$event]) => {
                    if (!!(__VLS_ctx.page === 'snapshots'))
                        return;
                    if (!(__VLS_ctx.comparison))
                        return;
                    __VLS_ctx.setSort('sizeB');
                } },
            ...{ class: "num" },
        });
        (__VLS_ctx.sortMark('sizeB'));
        __VLS_asFunctionalElement(__VLS_intrinsicElements.th, __VLS_intrinsicElements.th)({
            ...{ onClick: (...[$event]) => {
                    if (!!(__VLS_ctx.page === 'snapshots'))
                        return;
                    if (!(__VLS_ctx.comparison))
                        return;
                    __VLS_ctx.setSort('delta');
                } },
            ...{ class: "num" },
        });
        (__VLS_ctx.sortMark('delta'));
        __VLS_asFunctionalElement(__VLS_intrinsicElements.th, __VLS_intrinsicElements.th)({
            ...{ onClick: (...[$event]) => {
                    if (!!(__VLS_ctx.page === 'snapshots'))
                        return;
                    if (!(__VLS_ctx.comparison))
                        return;
                    __VLS_ctx.setSort('fileCountB');
                } },
            ...{ class: "num" },
        });
        (__VLS_ctx.sortMark('fileCountB'));
        __VLS_asFunctionalElement(__VLS_intrinsicElements.th, __VLS_intrinsicElements.th)({});
        __VLS_asFunctionalElement(__VLS_intrinsicElements.tbody, __VLS_intrinsicElements.tbody)({});
        if (__VLS_ctx.comparing) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.tr, __VLS_intrinsicElements.tr)({});
            __VLS_asFunctionalElement(__VLS_intrinsicElements.td, __VLS_intrinsicElements.td)({
                colspan: "7",
                ...{ class: "table-message" },
            });
        }
        else if (!__VLS_ctx.filteredItems.length) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.tr, __VLS_intrinsicElements.tr)({});
            __VLS_asFunctionalElement(__VLS_intrinsicElements.td, __VLS_intrinsicElements.td)({
                colspan: "7",
                ...{ class: "table-message" },
            });
        }
        else {
            for (const [row] of __VLS_getVForSourceType((__VLS_ctx.filteredItems))) {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.tr, __VLS_intrinsicElements.tr)({
                    ...{ onDblclick: (...[$event]) => {
                            if (!!(__VLS_ctx.page === 'snapshots'))
                                return;
                            if (!(__VLS_ctx.comparison))
                                return;
                            if (!!(__VLS_ctx.comparing))
                                return;
                            if (!!(!__VLS_ctx.filteredItems.length))
                                return;
                            __VLS_ctx.enterFolder(row);
                        } },
                    key: (`${row.status}-${row.relPath}`),
                    ...{ class: (['file-row', row.status]) },
                });
                __VLS_asFunctionalElement(__VLS_intrinsicElements.td, __VLS_intrinsicElements.td)({
                    ...{ class: "name-cell" },
                    title: (row.isDir ? '双击进入文件夹' : row.relPath),
                });
                __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                    ...{ class: "file-icon" },
                });
                (row.isDir ? '📁' : '📄');
                __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                    ...{ class: "file-name" },
                });
                (row.name);
                __VLS_asFunctionalElement(__VLS_intrinsicElements.td, __VLS_intrinsicElements.td)({});
                __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                    ...{ class: (['diff-chip', row.status]) },
                });
                (__VLS_ctx.statusText(row.status));
                __VLS_asFunctionalElement(__VLS_intrinsicElements.td, __VLS_intrinsicElements.td)({
                    ...{ class: "num mono" },
                });
                (__VLS_ctx.formatBytes(row.sizeA));
                __VLS_asFunctionalElement(__VLS_intrinsicElements.td, __VLS_intrinsicElements.td)({
                    ...{ class: "num mono" },
                });
                (__VLS_ctx.formatBytes(row.sizeB));
                __VLS_asFunctionalElement(__VLS_intrinsicElements.td, __VLS_intrinsicElements.td)({
                    ...{ class: "num mono delta-cell" },
                    ...{ class: (row.delta > 0 ? 'delta-up' : row.delta < 0 ? 'delta-down' : '') },
                });
                (__VLS_ctx.formatBytes(row.delta, true));
                __VLS_asFunctionalElement(__VLS_intrinsicElements.td, __VLS_intrinsicElements.td)({
                    ...{ class: "num mono" },
                });
                (row.isDir ? row.fileCountB.toLocaleString() : '—');
                __VLS_asFunctionalElement(__VLS_intrinsicElements.td, __VLS_intrinsicElements.td)({
                    ...{ class: "time-cell" },
                });
                (row.isDir ? '—' : __VLS_ctx.formatNs(row.modTimeNsB));
            }
        }
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "explorer-footer" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
        (__VLS_ctx.filteredItems.length.toLocaleString());
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
        if (!__VLS_ctx.showUnchanged) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
        }
    }
}
if (__VLS_ctx.showCreate) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ onMousedown: (...[$event]) => {
                if (!(__VLS_ctx.showCreate))
                    return;
                __VLS_ctx.showCreate = false;
            } },
        ...{ class: "modal-backdrop" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "modal" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "modal-head" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.h2, __VLS_intrinsicElements.h2)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({});
    (__VLS_ctx.config.recordFileData ? '保存文件明细与目录聚合数据' : '只保存文件夹记录与目录聚合数据');
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.showCreate))
                    return;
                __VLS_ctx.showCreate = false;
            } },
        ...{ class: "icon-btn" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "modal-body" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "field" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "input-button" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
        ...{ onKeyup: (__VLS_ctx.createSnapshot) },
        placeholder: "\u0043\u003a\u005c\u005c\u0055\u0073\u0065\u0072\u0073",
    });
    (__VLS_ctx.newRoot);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.showCreate))
                    return;
                __VLS_ctx.pickFolder('snapshot');
            } },
        ...{ class: "btn btn-secondary" },
        disabled: (__VLS_ctx.picking),
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.small, __VLS_intrinsicElements.small)({});
    (__VLS_ctx.config.defaultScanRoot);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "field" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.em, __VLS_intrinsicElements.em)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
        ...{ onKeyup: (__VLS_ctx.createSnapshot) },
        placeholder: "留空时自动使用当前日期时间",
    });
    (__VLS_ctx.newName);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "info-box" },
    });
    (__VLS_ctx.config.recordFileData ? '记录文件数据' : '仅记录文件夹数据');
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "modal-actions" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.showCreate))
                    return;
                __VLS_ctx.showCreate = false;
            } },
        ...{ class: "btn btn-secondary" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (__VLS_ctx.createSnapshot) },
        ...{ class: "btn btn-primary" },
        disabled: (__VLS_ctx.creating || !__VLS_ctx.newRoot.trim()),
    });
    (__VLS_ctx.creating ? '正在创建…' : '开始扫描');
}
if (__VLS_ctx.showSettings) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ onMousedown: (...[$event]) => {
                if (!(__VLS_ctx.showSettings))
                    return;
                __VLS_ctx.showSettings = false;
            } },
        ...{ class: "modal-backdrop" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "modal" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "modal-head" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.h2, __VLS_intrinsicElements.h2)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.showSettings))
                    return;
                __VLS_ctx.showSettings = false;
            } },
        ...{ class: "icon-btn" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "modal-body" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "field" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "input-button" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({});
    (__VLS_ctx.config.defaultScanRoot);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.showSettings))
                    return;
                __VLS_ctx.pickFolder('settings');
            } },
        ...{ class: "btn btn-secondary" },
        disabled: (__VLS_ctx.picking),
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "field" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({});
    (__VLS_ctx.config.listen);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.small, __VLS_intrinsicElements.small)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "field" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.em, __VLS_intrinsicElements.em)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.textarea, __VLS_intrinsicElements.textarea)({
        ...{ onInput: (...[$event]) => {
                if (!(__VLS_ctx.showSettings))
                    return;
                __VLS_ctx.config.excludePaths = $event.target.value.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
            } },
        value: (__VLS_ctx.config.excludePaths.join('\n')),
        rows: "5",
        placeholder: "\u4f8b\u5982\uff1a\u0043\u003a\u005c\u005c\u0055\u0073\u0065\u0072\u0073\u005c\u005c\u006e\u0061\u006d\u0065\u005c\u005c\u0041\u0070\u0070\u0044\u0061\u0074\u0061\u005c\u005c\u004c\u006f\u0063\u0061\u006c\u005c\u005c\u0054\u0065\u006d\u0070",
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.small, __VLS_intrinsicElements.small)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "check-setting" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
        type: "checkbox",
    });
    (__VLS_ctx.config.useAllocatedSize);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.strong, __VLS_intrinsicElements.strong)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.small, __VLS_intrinsicElements.small)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "check-setting" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
        type: "checkbox",
    });
    (__VLS_ctx.config.recordFileData);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.strong, __VLS_intrinsicElements.strong)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.small, __VLS_intrinsicElements.small)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "modal-actions" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.showSettings))
                    return;
                __VLS_ctx.showSettings = false;
            } },
        ...{ class: "btn btn-secondary" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (__VLS_ctx.saveSettings) },
        ...{ class: "btn btn-primary" },
        disabled: (__VLS_ctx.savingSettings),
    });
    (__VLS_ctx.savingSettings ? '保存中…' : '保存设置');
}
const __VLS_0 = {}.transition;
/** @type {[typeof __VLS_components.Transition, typeof __VLS_components.transition, typeof __VLS_components.Transition, typeof __VLS_components.transition, ]} */ ;
// @ts-ignore
const __VLS_1 = __VLS_asFunctionalComponent(__VLS_0, new __VLS_0({
    name: "toast",
}));
const __VLS_2 = __VLS_1({
    name: "toast",
}, ...__VLS_functionalComponentArgsRest(__VLS_1));
__VLS_3.slots.default;
if (__VLS_ctx.toast) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "toast" },
    });
    (__VLS_ctx.toast);
}
var __VLS_3;
/** @type {__VLS_StyleScopedClasses['app-shell']} */ ;
/** @type {__VLS_StyleScopedClasses['topbar']} */ ;
/** @type {__VLS_StyleScopedClasses['brand']} */ ;
/** @type {__VLS_StyleScopedClasses['brand-mark']} */ ;
/** @type {__VLS_StyleScopedClasses['brand-title']} */ ;
/** @type {__VLS_StyleScopedClasses['brand-subtitle']} */ ;
/** @type {__VLS_StyleScopedClasses['top-actions']} */ ;
/** @type {__VLS_StyleScopedClasses['btn']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-secondary']} */ ;
/** @type {__VLS_StyleScopedClasses['btn']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-primary']} */ ;
/** @type {__VLS_StyleScopedClasses['error-banner']} */ ;
/** @type {__VLS_StyleScopedClasses['icon-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['workspace']} */ ;
/** @type {__VLS_StyleScopedClasses['sidebar']} */ ;
/** @type {__VLS_StyleScopedClasses['nav-list']} */ ;
/** @type {__VLS_StyleScopedClasses['active']} */ ;
/** @type {__VLS_StyleScopedClasses['nav-item']} */ ;
/** @type {__VLS_StyleScopedClasses['nav-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['active']} */ ;
/** @type {__VLS_StyleScopedClasses['nav-item']} */ ;
/** @type {__VLS_StyleScopedClasses['nav-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['sidebar-info']} */ ;
/** @type {__VLS_StyleScopedClasses['side-label']} */ ;
/** @type {__VLS_StyleScopedClasses['side-path']} */ ;
/** @type {__VLS_StyleScopedClasses['side-stats']} */ ;
/** @type {__VLS_StyleScopedClasses['scan-dot']} */ ;
/** @type {__VLS_StyleScopedClasses['content']} */ ;
/** @type {__VLS_StyleScopedClasses['page-heading']} */ ;
/** @type {__VLS_StyleScopedClasses['btn']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-primary']} */ ;
/** @type {__VLS_StyleScopedClasses['mobile-create']} */ ;
/** @type {__VLS_StyleScopedClasses['metrics-grid']} */ ;
/** @type {__VLS_StyleScopedClasses['metric-card']} */ ;
/** @type {__VLS_StyleScopedClasses['metric-card']} */ ;
/** @type {__VLS_StyleScopedClasses['metric-card']} */ ;
/** @type {__VLS_StyleScopedClasses['panel']} */ ;
/** @type {__VLS_StyleScopedClasses['snapshot-panel']} */ ;
/** @type {__VLS_StyleScopedClasses['panel-toolbar']} */ ;
/** @type {__VLS_StyleScopedClasses['muted']} */ ;
/** @type {__VLS_StyleScopedClasses['btn']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-ghost']} */ ;
/** @type {__VLS_StyleScopedClasses['empty-state']} */ ;
/** @type {__VLS_StyleScopedClasses['empty-state']} */ ;
/** @type {__VLS_StyleScopedClasses['empty-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['btn']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-primary']} */ ;
/** @type {__VLS_StyleScopedClasses['snapshot-list']} */ ;
/** @type {__VLS_StyleScopedClasses['snapshot-row']} */ ;
/** @type {__VLS_StyleScopedClasses['snapshot-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['snapshot-main']} */ ;
/** @type {__VLS_StyleScopedClasses['snapshot-title-line']} */ ;
/** @type {__VLS_StyleScopedClasses['status-chip']} */ ;
/** @type {__VLS_StyleScopedClasses['snapshot-path']} */ ;
/** @type {__VLS_StyleScopedClasses['snapshot-meta']} */ ;
/** @type {__VLS_StyleScopedClasses['danger-text']} */ ;
/** @type {__VLS_StyleScopedClasses['snapshot-size']} */ ;
/** @type {__VLS_StyleScopedClasses['snapshot-actions']} */ ;
/** @type {__VLS_StyleScopedClasses['btn']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-small']} */ ;
/** @type {__VLS_StyleScopedClasses['btn']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-small']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-accent-light']} */ ;
/** @type {__VLS_StyleScopedClasses['icon-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['danger']} */ ;
/** @type {__VLS_StyleScopedClasses['page-heading']} */ ;
/** @type {__VLS_StyleScopedClasses['compare-heading']} */ ;
/** @type {__VLS_StyleScopedClasses['compare-selectors']} */ ;
/** @type {__VLS_StyleScopedClasses['panel']} */ ;
/** @type {__VLS_StyleScopedClasses['compare-arrow']} */ ;
/** @type {__VLS_StyleScopedClasses['btn']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-primary']} */ ;
/** @type {__VLS_StyleScopedClasses['compare-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['panel']} */ ;
/** @type {__VLS_StyleScopedClasses['empty-state']} */ ;
/** @type {__VLS_StyleScopedClasses['compact-error']} */ ;
/** @type {__VLS_StyleScopedClasses['warning-banner']} */ ;
/** @type {__VLS_StyleScopedClasses['warning-banner']} */ ;
/** @type {__VLS_StyleScopedClasses['metrics-grid']} */ ;
/** @type {__VLS_StyleScopedClasses['compare-metrics']} */ ;
/** @type {__VLS_StyleScopedClasses['metric-card']} */ ;
/** @type {__VLS_StyleScopedClasses['metric-card']} */ ;
/** @type {__VLS_StyleScopedClasses['metric-card']} */ ;
/** @type {__VLS_StyleScopedClasses['delta-positive']} */ ;
/** @type {__VLS_StyleScopedClasses['delta-negative']} */ ;
/** @type {__VLS_StyleScopedClasses['metric-card']} */ ;
/** @type {__VLS_StyleScopedClasses['explorer']} */ ;
/** @type {__VLS_StyleScopedClasses['panel']} */ ;
/** @type {__VLS_StyleScopedClasses['explorer-toolbar']} */ ;
/** @type {__VLS_StyleScopedClasses['nav-buttons']} */ ;
/** @type {__VLS_StyleScopedClasses['icon-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['icon-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['breadcrumb']} */ ;
/** @type {__VLS_StyleScopedClasses['crumb']} */ ;
/** @type {__VLS_StyleScopedClasses['root']} */ ;
/** @type {__VLS_StyleScopedClasses['crumb']} */ ;
/** @type {__VLS_StyleScopedClasses['explorer-search']} */ ;
/** @type {__VLS_StyleScopedClasses['explorer-options']} */ ;
/** @type {__VLS_StyleScopedClasses['legend']} */ ;
/** @type {__VLS_StyleScopedClasses['legend-dot']} */ ;
/** @type {__VLS_StyleScopedClasses['added']} */ ;
/** @type {__VLS_StyleScopedClasses['legend-dot']} */ ;
/** @type {__VLS_StyleScopedClasses['removed']} */ ;
/** @type {__VLS_StyleScopedClasses['legend-dot']} */ ;
/** @type {__VLS_StyleScopedClasses['modified']} */ ;
/** @type {__VLS_StyleScopedClasses['switch-row']} */ ;
/** @type {__VLS_StyleScopedClasses['current-delta']} */ ;
/** @type {__VLS_StyleScopedClasses['table-wrap']} */ ;
/** @type {__VLS_StyleScopedClasses['file-table']} */ ;
/** @type {__VLS_StyleScopedClasses['name-col']} */ ;
/** @type {__VLS_StyleScopedClasses['num']} */ ;
/** @type {__VLS_StyleScopedClasses['num']} */ ;
/** @type {__VLS_StyleScopedClasses['num']} */ ;
/** @type {__VLS_StyleScopedClasses['num']} */ ;
/** @type {__VLS_StyleScopedClasses['table-message']} */ ;
/** @type {__VLS_StyleScopedClasses['table-message']} */ ;
/** @type {__VLS_StyleScopedClasses['file-row']} */ ;
/** @type {__VLS_StyleScopedClasses['name-cell']} */ ;
/** @type {__VLS_StyleScopedClasses['file-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['file-name']} */ ;
/** @type {__VLS_StyleScopedClasses['diff-chip']} */ ;
/** @type {__VLS_StyleScopedClasses['num']} */ ;
/** @type {__VLS_StyleScopedClasses['mono']} */ ;
/** @type {__VLS_StyleScopedClasses['num']} */ ;
/** @type {__VLS_StyleScopedClasses['mono']} */ ;
/** @type {__VLS_StyleScopedClasses['num']} */ ;
/** @type {__VLS_StyleScopedClasses['mono']} */ ;
/** @type {__VLS_StyleScopedClasses['delta-cell']} */ ;
/** @type {__VLS_StyleScopedClasses['num']} */ ;
/** @type {__VLS_StyleScopedClasses['mono']} */ ;
/** @type {__VLS_StyleScopedClasses['time-cell']} */ ;
/** @type {__VLS_StyleScopedClasses['explorer-footer']} */ ;
/** @type {__VLS_StyleScopedClasses['modal-backdrop']} */ ;
/** @type {__VLS_StyleScopedClasses['modal']} */ ;
/** @type {__VLS_StyleScopedClasses['modal-head']} */ ;
/** @type {__VLS_StyleScopedClasses['icon-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['modal-body']} */ ;
/** @type {__VLS_StyleScopedClasses['field']} */ ;
/** @type {__VLS_StyleScopedClasses['input-button']} */ ;
/** @type {__VLS_StyleScopedClasses['btn']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-secondary']} */ ;
/** @type {__VLS_StyleScopedClasses['field']} */ ;
/** @type {__VLS_StyleScopedClasses['info-box']} */ ;
/** @type {__VLS_StyleScopedClasses['modal-actions']} */ ;
/** @type {__VLS_StyleScopedClasses['btn']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-secondary']} */ ;
/** @type {__VLS_StyleScopedClasses['btn']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-primary']} */ ;
/** @type {__VLS_StyleScopedClasses['modal-backdrop']} */ ;
/** @type {__VLS_StyleScopedClasses['modal']} */ ;
/** @type {__VLS_StyleScopedClasses['modal-head']} */ ;
/** @type {__VLS_StyleScopedClasses['icon-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['modal-body']} */ ;
/** @type {__VLS_StyleScopedClasses['field']} */ ;
/** @type {__VLS_StyleScopedClasses['input-button']} */ ;
/** @type {__VLS_StyleScopedClasses['btn']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-secondary']} */ ;
/** @type {__VLS_StyleScopedClasses['field']} */ ;
/** @type {__VLS_StyleScopedClasses['field']} */ ;
/** @type {__VLS_StyleScopedClasses['check-setting']} */ ;
/** @type {__VLS_StyleScopedClasses['check-setting']} */ ;
/** @type {__VLS_StyleScopedClasses['modal-actions']} */ ;
/** @type {__VLS_StyleScopedClasses['btn']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-secondary']} */ ;
/** @type {__VLS_StyleScopedClasses['btn']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-primary']} */ ;
/** @type {__VLS_StyleScopedClasses['toast']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            formatBytes: formatBytes,
            formatDate: formatDate,
            formatNs: formatNs,
            page: page,
            snapshots: snapshots,
            config: config,
            loadingSnapshots: loadingSnapshots,
            globalError: globalError,
            toast: toast,
            showCreate: showCreate,
            showSettings: showSettings,
            newRoot: newRoot,
            newName: newName,
            creating: creating,
            picking: picking,
            savingSettings: savingSettings,
            snapshotA: snapshotA,
            snapshotB: snapshotB,
            comparePath: comparePath,
            showUnchanged: showUnchanged,
            comparison: comparison,
            comparing: comparing,
            compareError: compareError,
            searchText: searchText,
            readySnapshots: readySnapshots,
            scanningCount: scanningCount,
            totalSnapshotSize: totalSnapshotSize,
            filteredItems: filteredItems,
            pathSegments: pathSegments,
            currentDelta: currentDelta,
            changedCount: changedCount,
            addedCount: addedCount,
            removedCount: removedCount,
            loadSnapshots: loadSnapshots,
            openCreate: openCreate,
            pickFolder: pickFolder,
            createSnapshot: createSnapshot,
            deleteSnapshot: deleteSnapshot,
            setAsA: setAsA,
            setAsB: setAsB,
            saveSettings: saveSettings,
            runCompare: runCompare,
            enterFolder: enterFolder,
            goUp: goUp,
            goRoot: goRoot,
            goSegment: goSegment,
            setSort: setSort,
            sortMark: sortMark,
            statusText: statusText,
            snapshotStatusText: snapshotStatusText,
        };
    },
});
export default (await import('vue')).defineComponent({
    setup() {
        return {};
    },
});
; /* PartiallyEnd: #4569/main.vue */
