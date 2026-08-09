import { api, formatRating } from './api.js'
import { state, setSession, logout, refreshMe, applySettings, DEFAULT_SETTINGS, onStateChange } from './state.js'

const app = document.getElementById('app')
const modalRoot = document.getElementById('modal-root')
const accountArea = document.getElementById('account-area')

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]))
}

function showError(msg) {
  const el = document.createElement('div')
  el.className = 'toast error'
  el.textContent = msg
  document.body.appendChild(el)
  setTimeout(() => el.remove(), 4000)
}

function icon(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${name}"/></svg>`
}

const ICONS = {
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 17.3l-6.2 3.7 1.6-7-5.4-4.7 7.1-.6L12 2l2.9 6.7 7.1.6-5.4 4.7 1.6 7z"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
  logout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>',
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
}

/* ------------------------------------------------------------------ */
/* Boutons du header (compte + paramètres)                            */
/* ------------------------------------------------------------------ */

function renderHeader() {
  accountArea.innerHTML = state.user
    ? `<button class="btn btn-ghost" id="btn-account">${escapeHtml(state.user.username)}</button>
       <button class="icon-btn" id="btn-logout" title="Se déconnecter">${ICONS.logout}</button>`
    : `<button class="btn btn-primary" id="btn-login">Se connecter</button>`

  document.getElementById('btn-login')?.addEventListener('click', openAuth)
  document.getElementById('btn-account')?.addEventListener('click', openAuth)
  document.getElementById('btn-logout')?.addEventListener('click', () => {
    logout()
    renderHeader()
    route()
  })
}

document.getElementById('btn-settings').addEventListener('click', openSettings)

const searchInput = document.getElementById('search-input')
document.getElementById('search-form').addEventListener('submit', (e) => {
  e.preventDefault()
  const q = searchInput.value.trim()
  if (!q) return
  searchInput.blur()
  location.hash = '#/search/' + encodeURIComponent(q)
})

onStateChange(() => renderHeader())

/* ------------------------------------------------------------------ */
/* Router                                                             */
/* ------------------------------------------------------------------ */

function parseHash() {
  const h = location.hash.replace(/^#/, '') || '/'
  const parts = h.split('/').filter(Boolean)
  if (parts[0] === 'search') {
    return { page: 'search', query: decodeURIComponent(parts[1] || '') }
  }
  if (parts[0] === 'title' && parts[1] && parts[2]) {
    return { page: 'title', type: parts[1], id: parts[2] }
  }
  if (parts[0] === 'watch' && parts[1] && parts[2]) {
    return { page: 'watch', type: parts[1], id: parts[2] }
  }
  return { page: 'home' }
}

export function route() {
  const { page, type, id, query } = parseHash()
  window.scrollTo({ top: 0 })
  if (page === 'title') renderTitle(type, id)
  else if (page === 'watch') renderWatch(type, id)
  else if (page === 'search') renderSearch(query)
  else renderHome()
}

window.addEventListener('hashchange', route)

/* ------------------------------------------------------------------ */
/* Cartes                                                             */
/* ------------------------------------------------------------------ */

function providersRow(item) {
  if (!state.settings.showProviders) return ''
  if (!item.providers || item.providers.length === 0) {
    return `<div class="providers empty">Aucun streaming</div>`
  }
  return `
    <div class="providers" title="${escapeHtml(item.providers.map((p) => p.name).join(', '))}">
      ${item.providers
        .map(
          (p) =>
            `<img class="provider-logo" src="${p.logo}" alt="${escapeHtml(p.name)}" loading="lazy" title="${escapeHtml(p.name)}"/>`,
        )
        .join('')}
    </div>`
}

function card(item) {
  const showTitle = state.settings.showTitles
  const showRating = state.settings.showRatings
  return `
    <a class="card" href="#/title/${item.type}/${item.id}">
      <div class="poster">
        <img src="${item.poster || ''}" alt="${escapeHtml(item.title)}" loading="lazy"
             onerror="this.closest('.card').classList.add('no-poster')"/>
        ${showRating && item.rating != null
          ? `<span class="rating-badge">${ICONS.star}${formatRating(item.rating)}</span>`
          : ''}
        <span class="card-type">${item.type === 'tv' ? 'Série' : item.type === 'movie' ? 'Film' : ''}</span>
      </div>
      <div class="card-body">
        ${showTitle ? `<h3 class="card-title">${escapeHtml(item.title)}</h3>` : ''}
        ${showTitle && item.year ? `<span class="card-year">${escapeHtml(item.year)}</span>` : ''}
        ${providersRow(item)}
      </div>
    </a>`
}

function renderSection(title, items, label) {
  if (!items || items.length === 0) return ''
  return `
    <section class="section">
      <h2 class="section-title">${title}</h2>
      <div class="grid">
        ${items.map(card).join('')}
      </div>
    </section>`
}

/* ------------------------------------------------------------------ */
/* Page d'accueil                                                     */
/* ------------------------------------------------------------------ */

async function renderHome() {
  app.innerHTML = `<div class="spinner"></div>`
  try {
    const data = await api.discover(state.settings.region)
    app.innerHTML = `
      <div class="hero">
        <div class="hero-inner">
          <h1>Bienvenue sur <span class="hero-logo">Lumo</span></h1>
          <p>Films, séries et animes. Tout au même endroit, classés par popularité.</p>
        </div>
      </div>
      ${renderSection('Films populaires', data.movies)}
      ${renderSection('Séries populaires', data.series)}
      ${renderSection('Animes populaires', data.anime)}
    `
  } catch (err) {
    app.innerHTML = `
      <div class="error-state">
        <h2>Impossible de charger le catalogue</h2>
        <p>${escapeHtml(err.message)}</p>
        <p class="error-hint">Vérifiez que la clé TMDB est bien configurée dans <code>server/.env</code>.</p>
      </div>`
  }
}

/* ------------------------------------------------------------------ */
/* Page de recherche                                                   */
/* ------------------------------------------------------------------ */

async function renderSearch(query) {
  const q = String(query || '').trim()
  searchInput.value = q
  if (!q) {
    app.innerHTML = `
      <div class="search-empty">
        <h2>Recherche</h2>
        <p class="muted">Tapez le titre d'un film, d'une série ou d'un anime dans la barre en haut pour lancer une recherche.</p>
      </div>`
    return
  }
  app.innerHTML = `<div class="spinner"></div>`
  try {
    const data = await api.search(q, state.settings.region)
    const total = data.movies.length + data.series.length + data.anime.length
    app.innerHTML = `
      <div class="section search-results">
        <h2 class="section-title">Résultats pour « ${escapeHtml(q)} » <span class="result-count">${total}</span></h2>
        ${total === 0 ? `<p class="muted">Aucun résultat trouvé. Essayez un autre titre.</p>` : ''}
        ${renderSection('Films', data.movies)}
        ${renderSection('Séries', data.series)}
        ${renderSection('Animes', data.anime)}
      </div>`
  } catch (err) {
    app.innerHTML = `
      <div class="error-state">
        <h2>Recherche impossible</h2>
        <p>${escapeHtml(err.message)}</p>
        <a class="btn btn-primary" href="#/">Retour à l'accueil</a>
      </div>`
  }
}

/* ------------------------------------------------------------------ */
/* Page détail                                                        */
/* ------------------------------------------------------------------ */

function episodeRow(e) {
  return `
    <div class="episode">
      <div class="episode-img">
        ${e.still ? `<img src="${e.still}" alt="" loading="lazy"/>` : ''}
      </div>
      <div class="episode-body">
        <div class="episode-head">
          <span class="episode-num">Ép. ${e.number}</span>
          <h4>${escapeHtml(e.title)}</h4>
          ${e.rating != null ? `<span class="episode-rating">${ICONS.star}${formatRating(e.rating)}</span>` : ''}
        </div>
        ${e.airDate ? `<span class="episode-date">${escapeHtml(e.airDate)}</span>` : ''}
        ${e.overview ? `<p class="episode-overview">${escapeHtml(e.overview)}</p>` : ''}
      </div>
    </div>`
}

async function renderTitle(type, id) {
  app.innerHTML = `<div class="spinner"></div>`
  try {
    const t = await api.title(type, id, state.settings.region)
    const isTv = type === 'tv'

    const providers = state.settings.showProviders
      ? t.providers && t.providers.length
        ? `<div class="detail-providers">
             <h3>Disponible sur</h3>
             <div class="providers">
               ${t.providers
                 .map((p) => `<img class="provider-logo lg" src="${p.logo}" alt="${escapeHtml(p.name)}" title="${escapeHtml(p.name)}"/>`)
                 .join('')}
             </div>
           </div>`
        : `<div class="detail-providers"><h3>Disponible sur</h3><p class="muted">Aucun streaming trouvé.</p></div>`
      : ''

    const ratings = state.settings.showRatings && t.rating != null
      ? `<span class="detail-rating">${ICONS.star} ${formatRating(t.rating)} <small>(${t.votes.toLocaleString('fr-FR')} votes)</small></span>`
      : ''

    const titleEl = state.settings.showTitles
      ? `<div class="detail-title">
           <h1>${escapeHtml(t.title)}</h1>
           ${t.originalTitle && t.originalTitle !== t.title ? `<p class="detail-original">${escapeHtml(t.originalTitle)}</p>` : ''}
         </div>`
      : ''

    const episodesHtml = isTv
      ? `<section class="detail-section">
           <h2 class="section-title">Épisodes</h2>
           ${t.seasons && t.seasons.length
             ? `<div class="seasons">
                  ${t.seasons
                    .map(
                      (s) => `
                        <div class="season" data-season="${s.seasonNumber}">
                          <button class="season-btn">
                            <span class="season-chevron">▸</span>
                            <span class="season-name">${escapeHtml(s.name)}</span>
                            <span class="season-count">${s.episodeCount} ép.</span>
                          </button>
                          <div class="season-episodes"></div>
                        </div>`,
                    )
                    .join('')}
                </div>`
             : `<p class="muted">Aucune saison trouvée.</p>`}
         </section>`
      : ''

    app.innerHTML = `
      <div class="detail" ${t.backdrop ? `style="--backdrop:url('${t.backdrop}')"` : ''}>
        <div class="detail-backdrop"></div>
        <div class="detail-content">
          <a class="btn btn-ghost back-btn" href="#/">${ICONS.back} Retour</a>
          <div class="detail-main">
            <div class="detail-poster">
              ${t.poster ? `<img src="${t.poster}" alt="${escapeHtml(t.title)}"/>` : ''}
            </div>
            <div class="detail-info">
              ${titleEl}
              <div class="detail-meta">
                ${ratings}
                ${t.year ? `<span class="detail-year">${escapeHtml(t.year)}</span>` : ''}
                ${t.runtime ? `<span class="detail-runtime">${t.runtime} min</span>` : ''}
              </div>
              <div class="detail-genres">
                ${(t.genres || []).map((g) => `<span class="chip">${escapeHtml(g)}</span>`).join('')}
              </div>
              <a class="btn btn-watch" href="#/watch/${type}/${id}">${ICONS.play} Regarder</a>
              ${providers}
              ${t.overview ? `<div class="detail-overview"><h3>Synopsis</h3><p>${escapeHtml(t.overview)}</p></div>` : ''}
              ${t.trailerKey ? `<a class="trailer-link" href="https://www.youtube.com/watch?v=${t.trailerKey}" target="_blank" rel="noopener">▶ Regarder la bande-annonce</a>` : ''}
            </div>
          </div>
          ${episodesHtml}
        </div>
      </div>`

    document.querySelectorAll('.season-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const seasonEl = btn.closest('.season')
        const box = seasonEl.querySelector('.season-episodes')
        const n = seasonEl.dataset.season
        const open = seasonEl.classList.contains('open')
        if (open) {
          seasonEl.classList.remove('open')
          btn.querySelector('.season-chevron').textContent = '▸'
          box.innerHTML = ''
          return
        }
        seasonEl.classList.add('open')
        btn.querySelector('.season-chevron').textContent = '▾'
        box.innerHTML = `<div class="spinner small"></div>`
        try {
          const { episodes } = await api.season(id, n)
          box.innerHTML = episodes.length
            ? episodes.map(episodeRow).join('')
            : `<p class="muted">Aucun épisode.</p>`
        } catch (err) {
          box.innerHTML = `<p class="muted">${escapeHtml(err.message)}</p>`
        }
      })
    })
  } catch (err) {
    app.innerHTML = `
      <div class="error-state">
        <h2>Impossible de charger la fiche</h2>
        <p>${escapeHtml(err.message)}</p>
        <a class="btn btn-primary" href="#/">Retour à l'accueil</a>
      </div>`
  }
}

/* ------------------------------------------------------------------ */
/* Page regarder (placeholder)                                        */
/* ------------------------------------------------------------------ */

async function renderWatch(type, id) {
  app.innerHTML = `<div class="spinner"></div>`
  let title = ''
  try {
    const t = await api.title(type, id, state.settings.region)
    title = t.title
  } catch {}
  try {
    const meta = await api.watch(type, id)
    app.innerHTML = `
      <div class="watch-page">
        <div class="player">
          <div class="player-topbar">
            <a class="btn btn-ghost" href="#/title/${type}/${id}">${ICONS.back} Retour</a>
            <h2>${escapeHtml(title || 'Lecture')}</h2>
          </div>
          <div class="player-screen">
            <div class="player-placeholder">
              <div class="player-icon">${ICONS.play}</div>
              <h3>${escapeHtml(meta.message)}</h3>
              <p class="muted">La page de lecture arrive bientôt sur Lumo.</p>
            </div>
          </div>
          <div class="player-controls">
            <span class="ctrl disabled" title="Lecture">Lecture</span>
            <span class="ctrl disabled" title="Pause">Pause</span>
            <span class="player-bar"><span class="player-progress" style="width:0%"></span></span>
            <span class="ctrl disabled" title="Durée">Durée</span>
            <span class="ctrl disabled" title="Volume">Volume</span>
            <span class="ctrl disabled" title="Plein écran">Plein écran</span>
          </div>
        </div>
        <p class="muted center">${ICONS.eye} Ce lecteur est désactivé pour le moment.</p>
      </div>`
  } catch (err) {
    app.innerHTML = `
      <div class="error-state">
        <h2>Lecture indisponible</h2>
        <p>${escapeHtml(err.message)}</p>
        <a class="btn btn-primary" href="#/title/${type}/${id}">Retour à la fiche</a>
      </div>`
  }
}

/* ------------------------------------------------------------------ */
/* Modales : authentification                                          */
/* ------------------------------------------------------------------ */

function openAuth() {
  if (state.user) return openAccount()
  const box = document.createElement('div')
  box.className = 'modal-backdrop'
  box.innerHTML = `
    <div class="modal auth-modal">
      <button class="modal-close">×</button>
      <h2 id="auth-title">Connexion</h2>
      <p id="auth-sub" class="muted">Connectez-vous pour synchroniser vos paramètres.</p>
      <form id="auth-form">
        <label>Pseudo
          <input id="auth-username" type="text" autocomplete="username" required minlength="3" maxlength="24"/>
        </label>
        <label>Mot de passe
          <input id="auth-password" type="password" autocomplete="current-password" required minlength="6"/>
        </label>
        <button type="submit" class="btn btn-primary btn-block" id="auth-submit">Se connecter</button>
      </form>
      <p class="auth-switch">Pas de compte ? <a href="#" id="auth-toggle">Créer un compte</a></p>
      <p id="auth-error" class="auth-error"></p>
    </div>`
  modalRoot.appendChild(box)

  let mode = 'login'
  const title = box.querySelector('#auth-title')
  const sub = box.querySelector('#auth-sub')
  const submit = box.querySelector('#auth-submit')
  const toggle = box.querySelector('#auth-toggle')
  const errorEl = box.querySelector('#auth-error')
  const usernameInput = box.querySelector('#auth-username')
  const passwordInput = box.querySelector('#auth-password')

  function setMode(m) {
    mode = m
    title.textContent = m === 'login' ? 'Connexion' : 'Créer un compte'
    sub.textContent =
      m === 'login'
        ? 'Connectez-vous pour synchroniser vos paramètres.'
        : 'Créez un compte pour sauvegarder vos préférences.'
    submit.textContent = m === 'login' ? 'Se connecter' : 'Créer le compte'
    toggle.textContent = m === 'login' ? 'Créer un compte' : 'J\'ai déjà un compte'
    errorEl.textContent = ''
  }

  toggle.addEventListener('click', (e) => {
    e.preventDefault()
    setMode(mode === 'login' ? 'register' : 'login')
  })

  box.querySelector('.modal-close').addEventListener('click', close)
  box.addEventListener('mousedown', (e) => {
    if (e.target === box) close()
  })

  box.querySelector('#auth-form').addEventListener('submit', async (e) => {
    e.preventDefault()
    const username = usernameInput.value.trim()
    const password = passwordInput.value
    errorEl.textContent = ''
    submit.disabled = true
    try {
      const res =
        mode === 'login'
          ? await api.login(username, password)
          : await api.register(username, password)
      setSession(res)
      close()
      renderHeader()
      route()
    } catch (err) {
      errorEl.textContent = err.message
    } finally {
      submit.disabled = false
    }
  })

  function close() {
    box.remove()
  }
  usernameInput.focus()
}

function openAccount() {
  const box = document.createElement('div')
  box.className = 'modal-backdrop'
  box.innerHTML = `
    <div class="modal account-modal">
      <button class="modal-close">×</button>
      <h2>Mon compte</h2>
      <p class="muted">Connecté en tant que <strong>${escapeHtml(state.user.username)}</strong></p>
      <p class="muted">Membre depuis le ${new Date(state.user.createdAt).toLocaleDateString('fr-FR')}</p>
      <button class="btn btn-danger btn-block" id="account-logout">Se déconnecter</button>
    </div>`
  modalRoot.appendChild(box)
  box.querySelector('.modal-close').addEventListener('click', () => box.remove())
  box.addEventListener('mousedown', (e) => {
    if (e.target === box) box.remove()
  })
  box.querySelector('#account-logout').addEventListener('click', () => {
    logout()
    box.remove()
    renderHeader()
    route()
  })
}

/* ------------------------------------------------------------------ */
/* Modale : paramètres                                                 */
/* ------------------------------------------------------------------ */

const REGIONS = [
  ['FR', 'France'],
  ['US', 'États-Unis'],
  ['GB', 'Royaume-Uni'],
  ['CA', 'Canada'],
  ['DE', 'Allemagne'],
  ['JP', 'Japon'],
  ['ES', 'Espagne'],
  ['IT', 'Italie'],
  ['BR', 'Brésil'],
  ['MX', 'Mexique'],
]

function openSettings() {
  const s = state.settings
  const box = document.createElement('div')
  box.className = 'modal-backdrop'
  box.innerHTML = `
    <div class="modal settings-modal">
      <button class="modal-close">×</button>
      <h2>Paramètres d'affichage</h2>

      <div class="setting-row">
        <div>
          <strong>Afficher les fournisseurs</strong>
          <p class="muted">Logos Netflix, Disney+, HBO, Apple TV+, etc.</p>
        </div>
        <label class="switch"><input type="checkbox" id="opt-providers" ${s.showProviders ? 'checked' : ''}/><span></span></label>
      </div>

      <div class="setting-row">
        <div>
          <strong>Afficher les notes</strong>
          <p class="muted">Score TMDB sur les cartes</p>
        </div>
        <label class="switch"><input type="checkbox" id="opt-ratings" ${s.showRatings ? 'checked' : ''}/><span></span></label>
      </div>

      <div class="setting-row">
        <div>
          <strong>Afficher les titres</strong>
          <p class="muted">Nom du film / de la série</p>
        </div>
        <label class="switch"><input type="checkbox" id="opt-titles" ${s.showTitles ? 'checked' : ''}/><span></span></label>
      </div>

      <div class="setting-row">
        <div>
          <strong>Région des fournisseurs</strong>
          <p class="muted">Détermine les plateformes disponibles</p>
        </div>
        <select id="opt-region">
          ${REGIONS.map(([code, label]) => `<option value="${code}" ${s.region === code ? 'selected' : ''}>${label}</option>`).join('')}
        </select>
      </div>

      <div class="settings-save">
        <button class="btn btn-primary btn-block" id="settings-save">Enregistrer</button>
        <button class="btn btn-ghost btn-block" id="settings-reset">Réinitialiser</button>
      </div>
      <p class="muted center">${state.user ? 'Sauvegardé sur votre compte.' : 'Sauvegardé dans ce navigateur (connectez-vous pour synchroniser).'}</p>
    </div>`

  modalRoot.appendChild(box)
  box.querySelector('.modal-close').addEventListener('click', () => box.remove())
  box.addEventListener('mousedown', (e) => {
    if (e.target === box) box.remove()
  })

  box.querySelector('#settings-reset').addEventListener('click', () => {
    applySettings({ ...DEFAULT_SETTINGS })
    if (state.user) {
      api.saveSettings(state.settings).then(() => {
        box.remove()
        route()
      }).catch(() => {
        box.remove()
        route()
      })
    } else {
      box.remove()
      route()
    }
  })

  box.querySelector('#settings-save').addEventListener('click', async () => {
    const next = {
      showProviders: box.querySelector('#opt-providers').checked,
      showRatings: box.querySelector('#opt-ratings').checked,
      showTitles: box.querySelector('#opt-titles').checked,
      region: box.querySelector('#opt-region').value,
    }
    applySettings(next)
    if (state.user) {
      try {
        const { user } = await api.saveSettings(next)
        state.user = user
        state.settings = { ...DEFAULT_SETTINGS, ...user.settings }
      } catch (err) {
        showError(err.message)
      }
    }
    box.remove()
    route()
  })
}

/* ------------------------------------------------------------------ */
/* Démarrage                                                          */
/* ------------------------------------------------------------------ */

refreshMe().finally(() => {
  renderHeader()
  route()
})
