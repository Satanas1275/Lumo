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
  pause: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>',
  volume: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>',
  muted: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>',
  fullscreen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>',
  exitFullscreen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
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

  const nav = document.querySelector('.nav-links')
  const adminLink = nav ? nav.querySelector('.nav-link[href="#/admin"]') : null
  if (state.user?.role === 'admin') {
    if (nav && !adminLink) {
      const a = document.createElement('a')
      a.className = 'nav-link'
      a.href = '#/admin'
      a.textContent = 'Admin'
      nav.appendChild(a)
    }
  } else if (adminLink) {
    adminLink.remove()
  }

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
/* Menu hamburger (mobile)                                            */
/* ------------------------------------------------------------------ */

const menuToggle = document.getElementById('btn-menu-toggle')
const headerMenu = document.getElementById('header-menu')

function closeHeaderMenu() {
  headerMenu.classList.remove('open')
  menuToggle.setAttribute('aria-expanded', 'false')
}

menuToggle.addEventListener('click', () => {
  const willOpen = !headerMenu.classList.contains('open')
  headerMenu.classList.toggle('open', willOpen)
  menuToggle.setAttribute('aria-expanded', String(willOpen))
})

// Ferme le menu dès qu'on clique un lien/bouton à l'intérieur, ou qu'on navigue
headerMenu.addEventListener('click', (e) => {
  if (e.target.closest('a, button')) closeHeaderMenu()
})
window.addEventListener('hashchange', closeHeaderMenu)

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
    const r = { page: 'watch', type: parts[1], id: parts[2] }
    if (parts[1] === 'tv') {
      r.season = Number(parts[3]) || 1
      r.episode = Number(parts[4]) || 1
    }
    return r
  }
  if (parts[0] === 'admin') return { page: 'admin' }
  return { page: 'home' }
}

export function route() {
  const { page, type, id, query, season, episode } = parseHash()
  window.scrollTo({ top: 0 })
  if (page === 'title') renderTitle(type, id)
  else if (page === 'watch') renderWatch(type, id, { season, episode })
  else if (page === 'search') renderSearch(query)
  else if (page === 'admin') renderAdmin()
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

function episodeRow(e, tid, season) {
  return `
    <a class="episode" href="#/watch/tv/${tid}/${season}/${e.number}">
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
    </a>`
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
            ? episodes.map((e) => episodeRow(e, id, n)).join('')
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
/* Page regarder : téléchargement local + player                       */
/* ------------------------------------------------------------------ */

let watchToken = 0
let currentTeardown = null

function teardownPlayer() {
  if (currentTeardown) {
    currentTeardown()
    currentTeardown = null
  }
}

window.addEventListener('hashchange', teardownPlayer)

function fmtTime(sec) {
  if (!Number.isFinite(sec)) return '0:00'
  const s = Math.max(0, Math.floor(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(ss).padStart(2, '0')}`
}

function fmtBytes(n) {
  if (!n) return '0'
  const u = ['o', 'Ko', 'Mo', 'Go', 'To']
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)))
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`
}

function bindPlayer(video, src) {
  let hls = null
  const teardown = () => {
    if (hls) { hls.destroy(); hls = null }
  }

  const isHls = /\.m3u8(\?|$)/i.test(String(src || ''))
  if (!isHls) {
    video.src = src
  } else if (window.Hls && Hls.isSupported()) {
    hls = new Hls({ enableWorker: true, maxBufferLength: 90 })
    hls.loadSource(src)
    hls.attachMedia(video)
    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (!data.fatal) return
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad()
      else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError()
      else {
        teardown()
        showError('Erreur de lecture de la vidéo locale.')
      }
    })
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = src
  } else {
    showError('Votre navigateur ne peut pas lire HLS.')
    return teardown
  }

  const screen = document.getElementById('player-screen')
  const controls = document.getElementById('player-controls')
  const btnPlay = document.getElementById('ctl-play')
  const btnMute = document.getElementById('ctl-mute')
  const btnFs = document.getElementById('ctl-fullscreen')
  const bar = document.getElementById('player-bar')
  const prog = document.getElementById('player-progress')
  const timeEl = document.getElementById('player-time')

  const setPlayIcon = () => { btnPlay.innerHTML = video.paused ? ICONS.play : ICONS.pause }
  const setMuteIcon = () => {
    btnMute.innerHTML = video.muted ? ICONS.muted : ICONS.volume
    btnMute.classList.toggle('active', video.muted)
  }

  btnPlay.addEventListener('click', () => {
    if (video.paused) video.play().catch(() => {})
    else video.pause()
  })
  btnMute.addEventListener('click', () => { video.muted = !video.muted })
  btnFs.addEventListener('click', () => {
    if (!document.fullscreenElement) screen.requestFullscreen?.().catch(() => {})
    else document.exitFullscreen?.()
  })

  bar.addEventListener('click', (e) => {
    if (!video.duration) return
    const rect = bar.getBoundingClientRect()
    const r = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
    video.currentTime = r * video.duration
  })

  video.addEventListener('play', setPlayIcon)
  video.addEventListener('pause', setPlayIcon)
  video.addEventListener('volumechange', setMuteIcon)

  const updateTime = () => {
    const d = video.duration || 0
    const c = video.currentTime || 0
    prog.style.width = `${d ? (c / d) * 100 : 0}%`
    timeEl.textContent = `${fmtTime(c)} / ${fmtTime(d)}`
  }
  video.addEventListener('timeupdate', updateTime)
  video.addEventListener('loadedmetadata', () => { controls.hidden = false; updateTime() })
  video.addEventListener('durationchange', updateTime)

  setPlayIcon()
  setMuteIcon()
  video.play().then(() => {}).catch(() => {})

  return teardown
}

async function renderWatch(type, id, opts = {}) {
  const token = ++watchToken
  teardownPlayer()

  if (!state.user) {
    const cfg = await api.config().catch(() => ({ requireAuthToWatch: true }))
    if (token !== watchToken) return
    if (cfg.requireAuthToWatch) {
      app.innerHTML = `
        <div class="error-state watch-locked">
          <div class="player-icon">${ICONS.play}</div>
          <h2>Connexion requise pour regarder</h2>
          <p class="muted">Connectez-vous (ou créez un compte) pour lancer des téléchargements et accéder à la lecture.</p>
          <button class="btn btn-primary" id="watch-login">Se connecter</button>
          <p class="error-hint"><a class="nav-link" href="#/title/${type}/${id}">← Retour à la fiche</a></p>
        </div>`
      document.getElementById('watch-login').addEventListener('click', openAuth)
      return
    }
  }

  app.innerHTML = `<div class="spinner"></div>`

  let title = 'Lecture'
  try {
    const t = await api.title(type, id, state.settings.region)
    title = t.title
  } catch {}

  const isTv = type === 'tv'
  const label = isTv ? `S${opts.season}E${opts.episode}` : null
  const quality = opts.quality || 'max'

  app.innerHTML = `
    <div class="watch-page">
      <div class="player">
        <div class="player-topbar">
          <a class="btn btn-ghost" href="#/title/${type}/${id}">${ICONS.back} Retour</a>
          <h2>${escapeHtml(title)}${label ? ` <span class="player-ep">${escapeHtml(label)}</span>` : ''}</h2>
          <label class="quality-picker">
            <select id="sel-quality">
              <option value="max" ${quality === 'max' ? 'selected' : ''}>Max (source)</option>
              <option value="1080" ${quality === '1080' ? 'selected' : ''}>1080p</option>
              <option value="720" ${quality === '720' ? 'selected' : ''}>720p</option>
              <option value="480" ${quality === '480' ? 'selected' : ''}>480p</option>
              <option value="360" ${quality === '360' ? 'selected' : ''}>360p</option>
            </select>
          </label>
        </div>
        <div class="player-screen" id="player-screen">
          <video id="lumo-video" class="lumo-video" preload="auto" playsinline webkit-playsinline></video>
          <div class="dl-overlay" id="dl-overlay">
            <div class="dl-card">
              <div class="dl-icon">${ICONS.download}</div>
              <h3 id="dl-title">Téléchargement en cours</h3>
              <div class="dl-bar"><span class="dl-progress" id="dl-progress"></span></div>
              <p class="dl-stats muted" id="dl-stats">Démarrage…</p>
            </div>
          </div>
        </div>
        <div class="player-controls" id="player-controls" hidden>
          <button class="ctrl" id="ctl-play" title="Lecture / Pause">${ICONS.play}</button>
          <button class="ctrl" id="ctl-mute" title="Muet">${ICONS.volume}</button>
          <span class="player-bar" id="player-bar"><span class="player-progress" id="player-progress"></span></span>
          <span class="player-time" id="player-time">0:00 / 0:00</span>
          <button class="ctrl" id="ctl-fullscreen" title="Plein écran">${ICONS.fullscreen}</button>
        </div>
      </div>
    </div>`

  const overlay = document.getElementById('dl-overlay')
  const progressEl = document.getElementById('dl-progress')
  const statsEl = document.getElementById('dl-stats')

  const showStatus = (st) => {
    if (st.status === 'ready') {
      overlay.hidden = true
      const video = document.getElementById('lumo-video')
      teardownPlayer()
      currentTeardown = bindPlayer(video, st.playUrl)
    } else if (st.status === 'error') {
      overlay.innerHTML = `
        <div class="dl-card dl-error-card">
          <div class="dl-icon err">${ICONS.play}</div>
          <h3>Téléchargement impossible</h3>
          <p class="muted">${escapeHtml(st.error || 'Erreur inconnue.')}</p>
          <button class="btn btn-primary" id="dl-retry">Réessayer</button>
        </div>`
      document.getElementById('dl-retry').addEventListener('click', () => route())
    } else if (st.status === 'downloading') {
      const pct = st.ratio > 0 ? Math.round(st.ratio * 100) : null
      progressEl.style.width = pct != null ? `${pct}%` : '25%'
      progressEl.classList.toggle('indeterminate', pct == null)
      const parts = st.totalBytes
        ? [`${pct}% — ${fmtBytes(st.downloadedBytes)} / ${fmtBytes(st.totalBytes)}`]
        : st.segmentsTotal
          ? [`${fmtBytes(st.downloadedBytes)} · ${st.segments}/${st.segmentsTotal} segments`]
          : [`${fmtBytes(st.downloadedBytes)} téléchargés`]
      if (st.message) parts.push(escapeHtml(st.message))
      if (st.quality) parts.push(`Qualité : ${escapeHtml(st.quality)}`)
      statsEl.textContent = parts.join(' — ')
    }
  }

  const start = async () => {
    let st
    try {
      await api.dlStart(type, id, { ...opts, quality })
      st = await api.dlStatus(type, id, { ...opts, quality })
    } catch (err) {
      showStatus({ status: 'error', error: err.message })
      return
    }
    if (token !== watchToken) return
    showStatus(st)
    if (st.status === 'downloading') schedulePoll()
  }

  const schedulePoll = () => {
    setTimeout(async () => {
      if (token !== watchToken) return
      let st
      try {
        st = await api.dlStatus(type, id, { ...opts, quality })
      } catch {}
      if (token !== watchToken || !st) return
      showStatus(st)
      if (st.status === 'downloading') schedulePoll()
    }, 900)
  }

  start()

  const sel = document.getElementById('sel-quality')
  if (sel) {
    sel.addEventListener('change', (e) => {
      teardownPlayer()
      const nextQ = e.target.value
      renderWatch(type, id, { ...opts, quality: nextQ })
    })
  }
}

/* ------------------------------------------------------------------ */
/* Page admin : approbation des comptes                                */
/* ------------------------------------------------------------------ */

async function renderAdmin() {
  if (state.user?.role !== 'admin') {
    app.innerHTML = `
      <div class="error-state">
        <h2>Accès refusé</h2>
        <p class="muted">Cette page est réservée aux administrateurs.</p>
        <a class="btn btn-primary" href="#/">Retour à l'accueil</a>
      </div>`
    return
  }

  app.innerHTML = `<div class="spinner"></div>`
  try {
    const [{ users }, settings] = await Promise.all([api.adminUsers(), api.adminSettings()])
    const allowRegistration = settings.allowRegistration !== false
    const pending = users.filter((u) => u.status === 'pending')
    const rest = users.filter((u) => u.status !== 'pending')

    const row = (u) => `
      <div class="admin-row">
        <div class="admin-ident">
          <span class="admin-name">${escapeHtml(u.username)}</span>
          ${u.role === 'admin' ? `<span class="chip chip-admin">admin</span>` : ''}
          <span class="admin-created">membre depuis le ${new Date(u.createdAt).toLocaleDateString('fr-FR')}</span>
        </div>
        ${u.status === 'pending'
          ? `<div class="admin-actions">
               <button class="btn btn-ghost" data-approve="${u.id}">Approuver</button>
               <button class="btn btn-danger" data-remove="${u.id}">Refuser</button>
             </div>`
          : u.role === 'admin'
            ? `<span class="muted">${u.username === state.user.username ? 'vous' : 'administrateur'}</span>`
            : `<div class="admin-actions">
                 <button class="btn btn-danger" data-remove="${u.id}">Supprimer</button>
               </div>`}
      </div>`

    app.innerHTML = `
      <div class="admin-page">
        <div class="section">
          <h2 class="section-title">Administration</h2>
          <p class="muted">Les comptes en attente doivent être approuvés avant de pouvoir se connecter.</p>

          <h3 class="admin-sub">Réglages</h3>
          <div class="admin-row">
            <div class="admin-ident">
              <span class="admin-name">Nouvelles inscriptions</span>
              <span class="admin-created">Autoriser la création de comptes sur le site</span>
            </div>
            <label class="switch">
              <input type="checkbox" id="reg-toggle" ${allowRegistration ? 'checked' : ''} />
              <span class="slider"></span>
            </label>
          </div>

          ${pending.length ? `
            <h3 class="admin-sub">En attente (${pending.length})</h3>
            <div class="admin-list">${pending.map(row).join('')}</div>` : ''}

          <h3 class="admin-sub">Comptes (${rest.length})</h3>
          <div class="admin-list">${rest.map(row).join('')}</div>
        </div>
      </div>`

    const regToggle = app.querySelector('#reg-toggle')
    if (regToggle) {
      regToggle.addEventListener('change', async () => {
        const on = regToggle.checked
        regToggle.disabled = true
        try {
          await api.adminSetSettings({ allowRegistration: on })
        } catch (err) {
          regToggle.checked = !on
          showError(err.message)
        } finally {
          regToggle.disabled = false
        }
      })
    }

    app.querySelectorAll('[data-approve]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await api.adminApprove(btn.dataset.approve)
          renderAdmin()
        } catch (err) {
          showError(err.message)
        }
      })
    })
    app.querySelectorAll('[data-remove]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Supprimer ce compte ?')) return
        try {
          await api.adminDelete(btn.dataset.remove)
          renderAdmin()
        } catch (err) {
          showError(err.message)
        }
      })
    })
  } catch (err) {
    app.innerHTML = `
      <div class="error-state">
        <h2>Administration indisponible</h2>
        <p>${escapeHtml(err.message)}</p>
        <a class="btn btn-primary" href="#/">Retour à l'accueil</a>
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
  let allowRegistration = true
  api.config().then((c) => {
    allowRegistration = c.allowRegistration !== false
  }).catch(() => {})
  const title = box.querySelector('#auth-title')
  const sub = box.querySelector('#auth-sub')
  const submit = box.querySelector('#auth-submit')
  const toggle = box.querySelector('#auth-toggle')
  const errorEl = box.querySelector('#auth-error')
  const usernameInput = box.querySelector('#auth-username')
  const passwordInput = box.querySelector('#auth-password')

  function setMode(m) {
    if (m === 'register' && allowRegistration === false) {
      errorEl.textContent = "L'inscription est désactivée par l'administrateur."
      return
    }
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
      if (res.pending) {
        errorEl.textContent = res.message || "Compte créé. En attente d'approbation par un administrateur."
        setMode('login')
        return
      }
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
