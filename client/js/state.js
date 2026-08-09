const TOKEN_KEY = 'lumo_token'
const GUEST_SETTINGS_KEY = 'lumo_guest_settings'

export const DEFAULT_SETTINGS = {
  showProviders: true,
  showRatings: true,
  showTitles: true,
  region: 'FR',
}

export const state = {
  token: localStorage.getItem(TOKEN_KEY) || null,
  user: null,
  settings: { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(GUEST_SETTINGS_KEY) || '{}') },
}

const listeners = new Set()

export function onStateChange(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function emit() {
  listeners.forEach((fn) => fn(state))
}

function persistGuestSettings() {
  localStorage.setItem(GUEST_SETTINGS_KEY, JSON.stringify(state.settings))
}

export function setSession({ token, user }) {
  state.token = token
  state.user = user
  if (user && user.settings) {
    state.settings = { ...DEFAULT_SETTINGS, ...user.settings }
    localStorage.setItem(TOKEN_KEY, token)
    persistGuestSettings()
  }
  emit()
}

export function logout() {
  state.token = null
  state.user = null
  localStorage.removeItem(TOKEN_KEY)
  emit()
}

export async function refreshMe() {
  if (!state.token) return
  try {
    const { user } = await fetch('/api/auth/me', {
      headers: { Authorization: `Bearer ${state.token}` },
    }).then((r) => r.json())
    if (user) {
      state.user = user
      state.settings = { ...DEFAULT_SETTINGS, ...user.settings }
    }
  } catch {}
  emit()
}

export function applySettings(next) {
  state.settings = { ...state.settings, ...next }
  persistGuestSettings()
  emit()
}
