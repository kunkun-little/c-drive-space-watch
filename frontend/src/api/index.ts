import type { AppConfig, CompareResponse, Snapshot } from '../types'

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) }
  })
  if (!res.ok) {
    const payload = await res.json().catch(() => ({ error: `${res.status} ${res.statusText}` }))
    throw new Error(payload.error || `${res.status} ${res.statusText}`)
  }
  if (res.status === 204) return undefined as T
  return res.json()
}

export const api = {
  getConfig: () => request<AppConfig>('/api/config'),
  saveConfig: (body: AppConfig) => request<AppConfig>('/api/config', { method: 'PUT', body: JSON.stringify(body) }),
  pickFolder: () => request<{ path: string }>('/api/system/pick-folder', { method: 'POST', body: '{}' }),
  listSnapshots: () => request<Snapshot[]>('/api/snapshots'),
  createSnapshot: (body: { rootPath: string; name?: string }) => request<Snapshot>('/api/snapshots', { method: 'POST', body: JSON.stringify(body) }),
  deleteSnapshot: (id: string) => request<void>(`/api/snapshots/${id}`, { method: 'DELETE' }),
  compare: (a: string, b: string, path: string, showUnchanged: boolean) => {
    const qs = new URLSearchParams({ a, b, path, showUnchanged: String(showUnchanged) })
    return request<CompareResponse>(`/api/compare?${qs}`)
  }
}
