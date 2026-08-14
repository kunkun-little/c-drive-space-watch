export interface Snapshot {
  id: string
  name: string
  rootPath: string
  status: 'scanning' | 'ready' | 'failed'
  recordFileData: boolean
  createdAt: string
  finishedAt?: string
  entryCount: number
  fileCount: number
  dirCount: number
  totalSize: number
  skippedCount: number
  errorMessage?: string
}

export interface AppConfig {
  listen: string
  defaultScanRoot: string
  excludePaths: string[]
  useAllocatedSize: boolean
  recordFileData: boolean
}

export type DiffStatus = 'added' | 'removed' | 'modified' | 'unchanged'

export interface CompareEntry {
  relPath: string
  name: string
  isDir: boolean
  status: DiffStatus
  sizeA: number
  sizeB: number
  delta: number
  fileCountA: number
  fileCountB: number
  modTimeNsA: number
  modTimeNsB: number
}

export interface CompareResponse {
  snapshotA: Snapshot
  snapshotB: Snapshot
  path: string
  items: CompareEntry[]
  summary: { sizeA: number; sizeB: number; delta: number }
}
