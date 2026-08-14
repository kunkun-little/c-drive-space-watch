<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { api } from './api'
import type { AppConfig, CompareEntry, CompareResponse, Snapshot } from './types'
import { formatBytes, formatDate, formatNs } from './utils'

type Page = 'snapshots' | 'compare'
type SortKey = 'name' | 'status' | 'sizeA' | 'sizeB' | 'delta' | 'fileCountB'

const page = ref<Page>('snapshots')
const snapshots = ref<Snapshot[]>([])
const config = ref<AppConfig>({ listen: '127.0.0.1:8899', defaultScanRoot: 'C:\\Users', excludePaths: [], useAllocatedSize: true, recordFileData: false })
const loadingSnapshots = ref(false)
const globalError = ref('')
const toast = ref('')

const showCreate = ref(false)
const showSettings = ref(false)
const newRoot = ref('C:\\Users')
const newName = ref('')
const creating = ref(false)
const picking = ref(false)
const savingSettings = ref(false)

const snapshotA = ref('')
const snapshotB = ref('')
const comparePath = ref('')
const showUnchanged = ref(false)
const comparison = ref<CompareResponse | null>(null)
const comparing = ref(false)
const compareError = ref('')
const sortKey = ref<SortKey>('delta')
const sortDesc = ref(true)
const searchText = ref('')

let pollTimer = 0
let toastTimer = 0

const readySnapshots = computed(() => snapshots.value.filter(s => s.status === 'ready'))
const scanningCount = computed(() => snapshots.value.filter(s => s.status === 'scanning').length)
const totalSnapshotSize = computed(() => snapshots.value.filter(s => s.status === 'ready').reduce((sum, s) => sum + s.totalSize, 0))
const currentItems = computed(() => comparison.value?.items ?? [])
const filteredItems = computed(() => {
  const q = searchText.value.trim().toLowerCase()
  const rows = q ? currentItems.value.filter(x => x.name.toLowerCase().includes(q)) : [...currentItems.value]
  return rows.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    const av = a[sortKey.value]
    const bv = b[sortKey.value]
    let n = 0
    if (typeof av === 'string' && typeof bv === 'string') n = av.localeCompare(bv, 'zh-CN', { numeric: true, sensitivity: 'base' })
    else n = Number(av) - Number(bv)
    return sortDesc.value ? -n : n
  })
})
const pathSegments = computed(() => comparePath.value ? comparePath.value.split('/').filter(Boolean) : [])
const currentDelta = computed(() => currentItems.value.reduce((sum, x) => sum + x.delta, 0))
const changedCount = computed(() => currentItems.value.filter(x => x.status !== 'unchanged').length)
const addedCount = computed(() => currentItems.value.filter(x => x.status === 'added').length)
const removedCount = computed(() => currentItems.value.filter(x => x.status === 'removed').length)

function notify(message: string) {
  toast.value = message
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => { toast.value = '' }, 2600)
}

async function loadInitial() {
  try {
    const [cfg] = await Promise.all([api.getConfig(), loadSnapshots()])
    config.value = cfg
    newRoot.value = cfg.defaultScanRoot
    chooseDefaultPair()
  } catch (err) {
    globalError.value = errorText(err)
  }
}

async function loadSnapshots(silent = false) {
  if (!silent) loadingSnapshots.value = true
  try {
    snapshots.value = await api.listSnapshots()
    chooseDefaultPair()
  } catch (err) {
    if (!silent) globalError.value = errorText(err)
  } finally {
    if (!silent) loadingSnapshots.value = false
  }
}

function chooseDefaultPair() {
  const ready = readySnapshots.value
  const ids = new Set(ready.map(s => s.id))
  if (snapshotA.value && !ids.has(snapshotA.value)) snapshotA.value = ''
  if (snapshotB.value && !ids.has(snapshotB.value)) snapshotB.value = ''
  if (!snapshotB.value && ready[0]) snapshotB.value = ready[0].id
  if (!snapshotA.value && ready[1]) snapshotA.value = ready[1].id
  if (snapshotA.value === snapshotB.value) snapshotA.value = ready.find(s => s.id !== snapshotB.value)?.id || ''
}

function openCreate() {
  newRoot.value = config.value.defaultScanRoot
  newName.value = ''
  showCreate.value = true
}

async function pickFolder(target: 'snapshot' | 'settings') {
  picking.value = true
  globalError.value = ''
  try {
    const result = await api.pickFolder()
    if (result.path) {
      if (target === 'snapshot') newRoot.value = result.path
      else config.value.defaultScanRoot = result.path
    }
  } catch (err) {
    globalError.value = errorText(err)
  } finally {
    picking.value = false
  }
}

async function createSnapshot() {
  const rootPath = newRoot.value.trim()
  if (!rootPath) return
  creating.value = true
  globalError.value = ''
  try {
    await api.createSnapshot({ rootPath, name: newName.value.trim() || undefined })
    showCreate.value = false
    await loadSnapshots(true)
    notify('快照任务已开始扫描')
  } catch (err) {
    globalError.value = errorText(err)
  } finally {
    creating.value = false
  }
}

async function deleteSnapshot(row: Snapshot) {
  if (!confirm(`确定删除快照“${row.name}”吗？\n\n删除后会同时移除该快照的全部目录/文件索引数据。`)) return
  try {
    await api.deleteSnapshot(row.id)
    if (snapshotA.value === row.id) snapshotA.value = ''
    if (snapshotB.value === row.id) snapshotB.value = ''
    comparison.value = null
    await loadSnapshots(true)
    notify('快照已删除')
  } catch (err) {
    globalError.value = errorText(err)
  }
}

function setAsA(row: Snapshot) {
  snapshotA.value = row.id
  if (!snapshotB.value || snapshotB.value === row.id) {
    const other = readySnapshots.value.find(s => s.id !== row.id)
    snapshotB.value = other?.id || ''
  }
  comparePath.value = ''
  page.value = 'compare'
  void runCompare()
}

function setAsB(row: Snapshot) {
  snapshotB.value = row.id
  if (!snapshotA.value || snapshotA.value === row.id) {
    const other = readySnapshots.value.find(s => s.id !== row.id)
    snapshotA.value = other?.id || ''
  }
  comparePath.value = ''
  page.value = 'compare'
  void runCompare()
}

async function saveSettings() {
  savingSettings.value = true
  globalError.value = ''
  try {
    config.value = await api.saveConfig(config.value)
    newRoot.value = config.value.defaultScanRoot
    showSettings.value = false
    notify('设置已保存')
  } catch (err) {
    globalError.value = errorText(err)
  } finally {
    savingSettings.value = false
  }
}

async function runCompare() {
  if (!snapshotA.value || !snapshotB.value) {
    compareError.value = '至少需要两个已完成快照才能进行比较。'
    comparison.value = null
    return
  }
  if (snapshotA.value === snapshotB.value) {
    compareError.value = '快照 A 和快照 B 必须是两个不同的快照。'
    comparison.value = null
    return
  }
  comparing.value = true
  compareError.value = ''
  try {
    comparison.value = await api.compare(snapshotA.value, snapshotB.value, comparePath.value, showUnchanged.value)
  } catch (err) {
    compareError.value = errorText(err)
    comparison.value = null
  } finally {
    comparing.value = false
  }
}

function enterFolder(row: CompareEntry) {
  if (!row.isDir) return
  comparePath.value = row.relPath
  searchText.value = ''
  void runCompare()
}

function goUp() {
  if (!comparePath.value) return
  const parts = comparePath.value.split('/').filter(Boolean)
  parts.pop()
  comparePath.value = parts.join('/')
  void runCompare()
}

function goRoot() {
  comparePath.value = ''
  void runCompare()
}

function goSegment(index: number) {
  comparePath.value = pathSegments.value.slice(0, index + 1).join('/')
  void runCompare()
}

function setSort(key: SortKey) {
  if (sortKey.value === key) sortDesc.value = !sortDesc.value
  else {
    sortKey.value = key
    sortDesc.value = key !== 'name' && key !== 'status'
  }
}

function sortMark(key: SortKey) {
  if (sortKey.value !== key) return ''
  return sortDesc.value ? ' ↓' : ' ↑'
}

function statusText(status: CompareEntry['status']) {
  return { added: '新增', removed: '删除', modified: '变化', unchanged: '未变化' }[status]
}

function snapshotStatusText(row: Snapshot) {
  return { scanning: '扫描中', ready: '已完成', failed: '失败' }[row.status]
}

function errorText(err: unknown) {
  return err instanceof Error ? err.message : String(err)
}

watch([snapshotA, snapshotB], () => {
  comparePath.value = ''
  comparison.value = null
})

watch(showUnchanged, () => {
  if (page.value === 'compare' && snapshotA.value && snapshotB.value) void runCompare()
})

watch(page, value => {
  if (value === 'compare' && !comparison.value && snapshotA.value && snapshotB.value) void runCompare()
})

onMounted(() => {
  void loadInitial()
  pollTimer = window.setInterval(async () => {
    if (scanningCount.value > 0) await loadSnapshots(true)
  }, 1500)
})

onBeforeUnmount(() => {
  window.clearInterval(pollTimer)
  window.clearTimeout(toastTimer)
})
</script>

<template>
  <div class="app-shell">
    <header class="topbar">
      <div class="brand">
        <div class="brand-mark">C:</div>
        <div>
          <div class="brand-title">C Drive Space Watch</div>
          <div class="brand-subtitle">Windows 磁盘空间快照与差异分析</div>
        </div>
      </div>
      <div class="top-actions">
        <button class="btn btn-secondary" @click="showSettings = true">⚙ 设置</button>
        <button class="btn btn-primary" @click="openCreate">＋ 创建快照</button>
      </div>
    </header>

    <div v-if="globalError" class="error-banner">
      <span>{{ globalError }}</span>
      <button class="icon-btn" @click="globalError = ''">×</button>
    </div>

    <main class="workspace">
      <aside class="sidebar">
        <nav class="nav-list">
          <button :class="['nav-item', { active: page === 'snapshots' }]" @click="page = 'snapshots'">
            <span class="nav-icon">◫</span><span>快照管理</span>
          </button>
          <button :class="['nav-item', { active: page === 'compare' }]" @click="page = 'compare'">
            <span class="nav-icon">⇄</span><span>快照比较</span>
          </button>
        </nav>
        <div class="sidebar-info">
          <div class="side-label">默认扫描目录</div>
          <div class="side-path" :title="config.defaultScanRoot">{{ config.defaultScanRoot }}</div>
          <div class="side-stats">
            <span>{{ snapshots.length }} 个快照</span>
            <span v-if="scanningCount" class="scan-dot">{{ scanningCount }} 扫描中</span>
          </div>
        </div>
      </aside>

      <section class="content">
        <template v-if="page === 'snapshots'">
          <div class="page-heading">
            <div>
              <h1>快照管理</h1>
              <p>记录指定目录在某一时刻的完整文件树，用于后续任意两次快照之间的空间差异分析。</p>
            </div>
            <button class="btn btn-primary mobile-create" @click="openCreate">＋ 创建快照</button>
          </div>

          <div class="metrics-grid">
            <div class="metric-card"><span>快照数量</span><strong>{{ snapshots.length }}</strong><small>SQLite 索引记录</small></div>
            <div class="metric-card"><span>扫描任务</span><strong>{{ scanningCount }}</strong><small>{{ scanningCount ? '后台扫描进行中' : '当前无任务' }}</small></div>
            <div class="metric-card"><span>快照数据总量</span><strong>{{ formatBytes(totalSnapshotSize) }}</strong><small>各快照扫描文件体积之和</small></div>
          </div>

          <div class="panel snapshot-panel">
            <div class="panel-toolbar">
              <div>
                <strong>历史快照</strong>
                <span class="muted">最新快照排在最前</span>
              </div>
              <button class="btn btn-ghost" :disabled="loadingSnapshots" @click="loadSnapshots()">↻ 刷新</button>
            </div>

            <div v-if="loadingSnapshots && !snapshots.length" class="empty-state">正在读取快照…</div>
            <div v-else-if="!snapshots.length" class="empty-state">
              <div class="empty-icon">◫</div>
              <strong>还没有快照</strong>
              <span>建议先对 {{ config.defaultScanRoot }} 创建第一个基准快照。</span>
              <button class="btn btn-primary" @click="openCreate">创建第一个快照</button>
            </div>
            <div v-else class="snapshot-list">
              <article v-for="row in snapshots" :key="row.id" class="snapshot-row">
                <div class="snapshot-icon" :class="row.status">{{ row.status === 'ready' ? '◫' : row.status === 'scanning' ? '◌' : '!' }}</div>
                <div class="snapshot-main">
                  <div class="snapshot-title-line">
                    <strong>{{ row.name }}</strong>
                    <span :class="['status-chip', row.status]">{{ snapshotStatusText(row) }}</span>
                  </div>
                  <div class="snapshot-path" :title="row.rootPath">{{ row.rootPath }}</div>
                  <div class="snapshot-meta">
                    <span>{{ formatDate(row.createdAt) }}</span>
                    <span v-if="row.status === 'ready'">{{ row.entryCount.toLocaleString() }} 项</span>
                    <span v-if="row.status === 'ready'">{{ row.fileCount.toLocaleString() }} 文件</span>
                    <span v-if="row.status === 'ready'">{{ row.recordFileData ? '含文件明细' : '仅文件夹数据' }}</span>
                    <span v-if="row.skippedCount">跳过 {{ row.skippedCount.toLocaleString() }}</span>
                    <span v-if="row.status === 'failed'" class="danger-text" :title="row.errorMessage">{{ row.errorMessage }}</span>
                  </div>
                </div>
                <div class="snapshot-size">
                  <strong>{{ row.status === 'ready' ? formatBytes(row.totalSize) : '—' }}</strong>
                  <span>{{ row.status === 'ready' ? `${row.dirCount.toLocaleString()} 文件夹` : row.status === 'scanning' ? '正在建立索引…' : '未完成' }}</span>
                </div>
                <div class="snapshot-actions">
                  <button v-if="row.status === 'ready'" class="btn btn-small" @click="setAsA(row)">设为基准</button>
                  <button v-if="row.status === 'ready'" class="btn btn-small btn-accent-light" @click="setAsB(row)">设为对比</button>
                  <button class="icon-btn danger" :disabled="row.status === 'scanning'" title="删除快照" @click="deleteSnapshot(row)">🗑</button>
                </div>
              </article>
            </div>
          </div>
        </template>

        <template v-else>
          <div class="page-heading compare-heading">
            <div>
              <h1>快照比较</h1>
              <p>以快照 A 为基准，查看快照 B 相对发生的新增、删除与空间增减。</p>
            </div>
          </div>

          <div class="compare-selectors panel">
            <label>
              <span>快照 A · 基准</span>
              <select v-model="snapshotA">
                <option value="">请选择快照</option>
                <option v-for="s in readySnapshots" :key="s.id" :value="s.id">{{ s.name }} · {{ s.rootPath }}</option>
              </select>
            </label>
            <div class="compare-arrow">→</div>
            <label>
              <span>快照 B · 对比</span>
              <select v-model="snapshotB">
                <option value="">请选择快照</option>
                <option v-for="s in readySnapshots" :key="s.id" :value="s.id">{{ s.name }} · {{ s.rootPath }}</option>
              </select>
            </label>
            <button class="btn btn-primary compare-btn" :disabled="comparing || !snapshotA || !snapshotB" @click="runCompare">
              {{ comparing ? '比较中…' : '开始比较' }}
            </button>
          </div>

          <div v-if="compareError" class="panel empty-state compact-error">{{ compareError }}</div>

          <template v-if="comparison">
            <div v-if="comparison.snapshotA.rootPath.toLowerCase() !== comparison.snapshotB.rootPath.toLowerCase()" class="warning-banner">
              两个快照的扫描根目录不同，将按相对路径进行比较：{{ comparison.snapshotA.rootPath }} → {{ comparison.snapshotB.rootPath }}
            </div>
            <div v-if="!comparison.snapshotA.recordFileData || !comparison.snapshotB.recordFileData" class="warning-banner">
              至少一个快照未记录文件明细，本次比较仅显示文件夹级别；如需查看文件级变化，请开启“记录文件数据”后重新创建快照。
            </div>

            <div class="metrics-grid compare-metrics">
              <div class="metric-card"><span>快照 A</span><strong>{{ formatBytes(comparison.summary.sizeA) }}</strong><small>{{ comparison.snapshotA.name }}</small></div>
              <div class="metric-card"><span>快照 B</span><strong>{{ formatBytes(comparison.summary.sizeB) }}</strong><small>{{ comparison.snapshotB.name }}</small></div>
              <div class="metric-card" :class="{ 'delta-positive': comparison.summary.delta > 0, 'delta-negative': comparison.summary.delta < 0 }">
                <span>总空间变化</span><strong>{{ formatBytes(comparison.summary.delta, true) }}</strong><small>B − A</small>
              </div>
              <div class="metric-card"><span>当前目录变化</span><strong>{{ changedCount }}</strong><small>新增 {{ addedCount }} · 删除 {{ removedCount }}</small></div>
            </div>

            <div class="explorer panel">
              <div class="explorer-toolbar">
                <div class="nav-buttons">
                  <button class="icon-btn" :disabled="!comparePath" title="上一级" @click="goUp">↑</button>
                  <button class="icon-btn" title="刷新" @click="runCompare">↻</button>
                </div>
                <div class="breadcrumb">
                  <button class="crumb root" @click="goRoot">{{ comparison.snapshotB.rootPath }}</button>
                  <template v-for="(seg, index) in pathSegments" :key="`${seg}-${index}`">
                    <span>›</span>
                    <button class="crumb" @click="goSegment(index)">{{ seg }}</button>
                  </template>
                </div>
                <div class="explorer-search">
                  <span>⌕</span><input v-model="searchText" placeholder="搜索当前目录" />
                </div>
              </div>

              <div class="explorer-options">
                <div class="legend">
                  <span><i class="legend-dot added"></i>新增</span>
                  <span><i class="legend-dot removed"></i>删除</span>
                  <span><i class="legend-dot modified"></i>变化</span>
                </div>
                <label class="switch-row"><input v-model="showUnchanged" type="checkbox" /> 显示未变化项</label>
                <span class="current-delta">当前层级净变化 <strong :class="currentDelta > 0 ? 'delta-up' : currentDelta < 0 ? 'delta-down' : ''">{{ formatBytes(currentDelta, true) }}</strong></span>
              </div>

              <div class="table-wrap">
                <table class="file-table">
                  <thead>
                    <tr>
                      <th class="name-col" @click="setSort('name')">名称{{ sortMark('name') }}</th>
                      <th @click="setSort('status')">状态{{ sortMark('status') }}</th>
                      <th class="num" @click="setSort('sizeA')">快照 A{{ sortMark('sizeA') }}</th>
                      <th class="num" @click="setSort('sizeB')">快照 B{{ sortMark('sizeB') }}</th>
                      <th class="num" @click="setSort('delta')">大小差异{{ sortMark('delta') }}</th>
                      <th class="num" @click="setSort('fileCountB')">文件数{{ sortMark('fileCountB') }}</th>
                      <th>修改时间 B</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-if="comparing"><td colspan="7" class="table-message">正在计算当前目录差异…</td></tr>
                    <tr v-else-if="!filteredItems.length"><td colspan="7" class="table-message">当前目录没有符合条件的差异项。</td></tr>
                    <template v-else>
                      <tr
                        v-for="row in filteredItems"
                        :key="`${row.status}-${row.relPath}`"
                        :class="['file-row', row.status]"
                        @dblclick="enterFolder(row)"
                      >
                        <td class="name-cell" :title="row.isDir ? '双击进入文件夹' : row.relPath">
                          <span class="file-icon">{{ row.isDir ? '📁' : '📄' }}</span>
                          <span class="file-name">{{ row.name }}</span>
                        </td>
                        <td><span :class="['diff-chip', row.status]">{{ statusText(row.status) }}</span></td>
                        <td class="num mono">{{ formatBytes(row.sizeA) }}</td>
                        <td class="num mono">{{ formatBytes(row.sizeB) }}</td>
                        <td class="num mono delta-cell" :class="row.delta > 0 ? 'delta-up' : row.delta < 0 ? 'delta-down' : ''">{{ formatBytes(row.delta, true) }}</td>
                        <td class="num mono">{{ row.isDir ? row.fileCountB.toLocaleString() : '—' }}</td>
                        <td class="time-cell">{{ row.isDir ? '—' : formatNs(row.modTimeNsB) }}</td>
                      </tr>
                    </template>
                  </tbody>
                </table>
              </div>
              <div class="explorer-footer">
                <span>{{ filteredItems.length.toLocaleString() }} 项</span>
                <span>双击文件夹进入下一级</span>
                <span v-if="!showUnchanged">已隐藏未变化项</span>
              </div>
            </div>
          </template>
        </template>
      </section>
    </main>

    <div v-if="showCreate" class="modal-backdrop" @mousedown.self="showCreate = false">
      <div class="modal">
          <div class="modal-head"><div><h2>创建目录快照</h2><p>递归扫描目录下的所有文件和子目录，并{{ config.recordFileData ? '保存文件明细与目录聚合数据' : '只保存文件夹记录与目录聚合数据' }}。</p></div><button class="icon-btn" @click="showCreate = false">×</button></div>
        <div class="modal-body">
          <label class="field"><span>扫描目录</span><div class="input-button"><input v-model="newRoot" placeholder="C:\\Users" @keyup.enter="createSnapshot" /><button class="btn btn-secondary" :disabled="picking" @click="pickFolder('snapshot')">浏览…</button></div><small>默认 {{ config.defaultScanRoot }}；支持选择 C:\\、C:\\Users 或任意子目录。</small></label>
          <label class="field"><span>快照名称 <em>可选</em></span><input v-model="newName" placeholder="留空时自动使用当前日期时间" @keyup.enter="createSnapshot" /></label>
          <div class="info-box">当前设置：{{ config.recordFileData ? '记录文件数据' : '仅记录文件夹数据' }}。扫描期间可继续使用界面；遇到无权限目录或重解析点时会跳过并记录数量，不会中断整个快照。</div>
        </div>
        <div class="modal-actions"><button class="btn btn-secondary" @click="showCreate = false">取消</button><button class="btn btn-primary" :disabled="creating || !newRoot.trim()" @click="createSnapshot">{{ creating ? '正在创建…' : '开始扫描' }}</button></div>
      </div>
    </div>

    <div v-if="showSettings" class="modal-backdrop" @mousedown.self="showSettings = false">
      <div class="modal">
        <div class="modal-head"><div><h2>设置</h2><p>配置文件保存在项目目录的 config/config.json。</p></div><button class="icon-btn" @click="showSettings = false">×</button></div>
        <div class="modal-body">
          <label class="field"><span>默认扫描目录</span><div class="input-button"><input v-model="config.defaultScanRoot" /><button class="btn btn-secondary" :disabled="picking" @click="pickFolder('settings')">浏览…</button></div></label>
          <label class="field"><span>后端监听地址</span><input v-model="config.listen" /><small>修改监听地址后需要重启程序才能生效。</small></label>
          <label class="field"><span>排除目录 <em>每行一个绝对路径</em></span><textarea :value="config.excludePaths.join('\n')" rows="5" placeholder="例如：C:\\Users\\name\\AppData\\Local\\Temp" @input="config.excludePaths = ($event.target as HTMLTextAreaElement).value.split(/\r?\n/).map(x => x.trim()).filter(Boolean)"></textarea><small>默认不排除任何普通目录，确保能够发现真正的空间增长来源。</small></label>
          <label class="check-setting"><input v-model="config.useAllocatedSize" type="checkbox" /><span><strong>按磁盘实际占用大小统计</strong><small>推荐。Windows 下使用 Size on disk，更贴近 C 盘实际可用空间变化；关闭后使用逻辑文件大小。</small></span></label>
          <label class="check-setting"><input v-model="config.recordFileData" type="checkbox" /><span><strong>记录文件数据</strong><small>默认关闭。关闭时仍会统计文件对文件夹大小、文件数和变化指纹的贡献，但数据库只保存文件夹记录；开启后才可查看文件级新增、删除和变化。</small></span></label>
        </div>
        <div class="modal-actions"><button class="btn btn-secondary" @click="showSettings = false">取消</button><button class="btn btn-primary" :disabled="savingSettings" @click="saveSettings">{{ savingSettings ? '保存中…' : '保存设置' }}</button></div>
      </div>
    </div>

    <transition name="toast"><div v-if="toast" class="toast">✓ {{ toast }}</div></transition>
  </div>
</template>
