import { state } from './state.js'

async function request(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) }
  if (state.token) headers.Authorization = `Bearer ${state.token}`
  const res = await fetch(path, { ...opts, headers })
  let data = null
  try { data = await res.json() } catch {}
  if (!res.ok) {
    const msg = (data && data.error) || `Erreur ${res.status}`
    const err = new Error(msg)
    err.status = res.status
    throw err
  }
  return data
}

export const api = {
  discover: (region) => request(`/api/discover?region=${encodeURIComponent(region)}`),

  title: (type, id, region) =>
    request(`/api/title/${type}/${id}?region=${encodeURIComponent(region)}`),

  season: (id, season) => request(`/api/title/tv/${id}/season/${season}`),

  watch: (type, id) => request(`/api/watch/${type}/${id}`),

  register: (username, password) =>
    request('/api/auth/register', { method: 'POST', body: JSON.stringify({ username, password }) }),

  login: (username, password) =>
    request('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),

  me: () => request('/api/auth/me'),

  saveSettings: (settings) =>
    request('/api/me/settings', { method: 'PUT', body: JSON.stringify(settings) }),
}

export function posterUrl(item, width = 'w342') {
  return item && item.poster ? item.poster : null
}

export function formatRating(v) {
  return v == null ? '—' : v.toFixed(1)
}
