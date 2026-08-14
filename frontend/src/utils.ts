export function formatBytes(bytes: number, signed = false): string {
  if (!Number.isFinite(bytes)) return '—'
  const sign = signed && bytes > 0 ? '+' : ''
  const abs = Math.abs(bytes)
  if (abs < 1024) return `${sign}${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB', 'PB']
  let value = abs
  let idx = -1
  do { value /= 1024; idx++ } while (value >= 1024 && idx < units.length - 1)
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2
  return `${bytes < 0 ? '-' : sign}${value.toFixed(digits)} ${units[idx]}`
}

export function formatDate(value?: string): string {
  if (!value) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).format(new Date(value))
}

export function formatNs(value: number): string {
  if (!value) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).format(new Date(value / 1_000_000))
}
