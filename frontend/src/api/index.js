async function request(url, init) {
    const res = await fetch(url, {
        ...init,
        headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) }
    });
    if (!res.ok) {
        const payload = await res.json().catch(() => ({ error: `${res.status} ${res.statusText}` }));
        throw new Error(payload.error || `${res.status} ${res.statusText}`);
    }
    if (res.status === 204)
        return undefined;
    return res.json();
}
export const api = {
    getConfig: () => request('/api/config'),
    saveConfig: (body) => request('/api/config', { method: 'PUT', body: JSON.stringify(body) }),
    pickFolder: () => request('/api/system/pick-folder', { method: 'POST', body: '{}' }),
    listSnapshots: () => request('/api/snapshots'),
    createSnapshot: (body) => request('/api/snapshots', { method: 'POST', body: JSON.stringify(body) }),
    deleteSnapshot: (id) => request(`/api/snapshots/${id}`, { method: 'DELETE' }),
    compare: (a, b, path, showUnchanged) => {
        const qs = new URLSearchParams({ a, b, path, showUnchanged: String(showUnchanged) });
        return request(`/api/compare?${qs}`);
    }
};
