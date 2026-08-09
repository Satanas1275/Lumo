import 'dotenv/config'

const API_BASE = 'https://api.themoviedb.org/3'
const IMG_BASE = 'https://image.tmdb.org/t/p/'
const LANG = 'fr-FR'

const cache = new Map()

function cacheGet(key) {
  const e = cache.get(key)
  if (!e) return null
  if (e.exp < Date.now()) { cache.delete(key); return null }
  return e.val
}

function cacheSet(key, val, ttlMs) {
  cache.set(key, { val, exp: Date.now() + ttlMs })
}

export class ApiError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

export function apiKey() {
  return process.env.TMDB_API_KEY || ''
}

export async function tmdb(path, params = {}) {
  const key = apiKey()
  if (!key) {
    throw new ApiError(503, 'Clé API TMDB manquante. Ajoutez TMDB_API_KEY dans server/.env')
  }
  const q = new URLSearchParams({ language: LANG, ...params })
  const isV4Token = key.length > 32
  const url = isV4Token
    ? `${API_BASE}${path}?${q}`
    : `${API_BASE}${path}?${q}&api_key=${key}`
  const res = await fetch(url, {
    headers: isV4Token ? { Authorization: `Bearer ${key}` } : {},
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new ApiError(res.status, `TMDB ${res.status}: ${body.slice(0, 140)}`)
  }
  return res.json()
}

export function extractProviders(results, region) {
  const r = results?.[region]
  if (!r) return []
  const sources = [
    ...(r.flatrate || []),
    ...(r.free || []),
    ...(r.ads || []),
    ...(r.buy || []),
    ...(r.rent || []),
  ]
  const seen = new Set()
  const out = []
  for (const p of sources) {
    if (seen.has(p.provider_id)) continue
    seen.add(p.provider_id)
    out.push({
      id: p.provider_id,
      name: p.provider_name,
      logo: p.logo_path ? IMG_BASE + 'w92' + p.logo_path : null,
      priority: p.display_priority ?? 999,
    })
  }
  return out.sort((a, b) => a.priority - b.priority).slice(0, 6)
}

function roundRating(v) {
  return typeof v === 'number' ? Math.round(v * 10) / 10 : null
}

export function normalizeItem(type, d) {
  return {
    id: d.id,
    type,
    title: d.title || d.name || 'Sans titre',
    originalTitle: d.original_title || d.original_name || null,
    tagline: d.tagline || null,
    poster: d.poster_path ? IMG_BASE + 'w342' + d.poster_path : null,
    backdrop: d.backdrop_path ? IMG_BASE + 'w1280' + d.backdrop_path : null,
    rating: roundRating(d.vote_average),
    votes: d.vote_count || 0,
    year: (d.release_date || d.first_air_date || '').slice(0, 4) || null,
    genres: (d.genres || []).map((g) => g.name),
    overview: d.overview || null,
    runtime: d.runtime || null,
    status: d.status || null,
    providers: [],
  }
}

async function providersFor(type, id, region) {
  const key = `prov:${type}:${id}:${region}`
  const hit = cacheGet(key)
  if (hit) return hit
  const res = await tmdb(`/${type}/${id}/watch/providers`)
  const out = extractProviders(res.results, region)
  cacheSet(key, out, 6 * 60 * 60 * 1000)
  return out
}

async function attachProviders(items, region) {
  await Promise.all(
    items.map(async (item) => {
      try {
        item.providers = await providersFor(item.type, item.id, region)
      } catch {
        item.providers = []
      }
    }),
  )
  return items
}

function sliceRandom(arr, n) {
  return arr.slice(0, n)
}

const DISCOVER_TTL = 30 * 60 * 1000

export async function getDiscover(region = 'FR') {
  const key = `discover:${region}`
  const hit = cacheGet(key)
  if (hit) return hit

  const [movies, series, animeMovies, animeSeries] = await Promise.all([
    tmdb('/discover/movie', { sort_by: 'popularity.desc', page: 1, watch_region: region }),
    tmdb('/discover/tv', { sort_by: 'popularity.desc', page: 1, watch_region: region }),
    tmdb('/discover/movie', {
      sort_by: 'popularity.desc',
      page: 1,
      with_genres: '16',
      with_original_language: 'ja',
    }),
    tmdb('/discover/tv', {
      sort_by: 'popularity.desc',
      page: 1,
      with_genres: '16',
      with_original_language: 'ja',
    }),
  ])

  const movieItems = sliceRandom(movies.results || [], 10).map((d) => normalizeItem('movie', d))
  const serieItems = sliceRandom(series.results || [], 10).map((d) => normalizeItem('tv', d))
  const animeItems = [
    ...sliceRandom(animeMovies.results || [], 4).map((d) => normalizeItem('movie', d)),
    ...sliceRandom(animeSeries.results || [], 4).map((d) => normalizeItem('tv', d)),
  ]

  await Promise.all([
    attachProviders(movieItems, region),
    attachProviders(serieItems, region),
    attachProviders(animeItems, region),
  ])

  const out = { movies: movieItems, series: serieItems, anime: animeItems }
  cacheSet(key, out, DISCOVER_TTL)
  return out
}

export async function getTitle(type, id, region = 'FR') {
  const key = `title:${type}:${id}:${region}`
  const hit = cacheGet(key)
  if (hit) return hit

  const d = await tmdb(`/${type}/${id}`, { append_to_response: 'watch/providers,videos' })
  const item = normalizeItem(type, d)
  item.providers = extractProviders(d['watch/providers']?.results, region)
  if (type === 'tv') {
    item.seasons = (d.seasons || [])
      .filter((s) => s.season_number >= 0)
      .map((s) => ({
        seasonNumber: s.season_number,
        name: s.name,
        episodeCount: s.episode_count,
        overview: s.overview || null,
        poster: s.poster_path ? IMG_BASE + 'w342' + s.poster_path : null,
        airDate: s.air_date || null,
      }))
  }
  const trailer = (d.videos?.results || []).find((v) => v.type === 'Trailer' && v.site === 'YouTube')
  item.trailerKey = trailer?.key || null
  cacheSet(key, item, 60 * 60 * 1000)
  return item
}

export async function getSeasonEpisodes(id, seasonNumber) {
  const key = `season:${id}:${seasonNumber}`
  const hit = cacheGet(key)
  if (hit) return hit
  const d = await tmdb(`/tv/${id}/season/${seasonNumber}`)
  const episodes = (d.episodes || []).map((e) => ({
    number: e.episode_number,
    title: e.name,
    overview: e.overview || null,
    airDate: e.air_date || null,
    rating: roundRating(e.vote_average),
    still: e.still_path ? IMG_BASE + 'w300' + e.still_path : null,
    runtime: e.runtime || null,
  }))
  cacheSet(key, episodes, 60 * 60 * 1000)
  return episodes
}

const SEARCH_TTL = 60 * 60 * 1000

function splitByType(results) {
  const buckets = { movies: [], series: [], anime: [] }
  const seen = new Set()
  for (const r of results || []) {
    if (!r || !['movie', 'tv'].includes(r.media_type)) continue
    if (seen.has(`${r.media_type}:${r.id}`)) continue
    seen.add(`${r.media_type}:${r.id}`)
    const isAnime =
      (r.genre_ids || []).includes(16) && (r.original_language || '') === 'ja'
    const target = r.media_type === 'movie' ? (isAnime ? 'anime' : 'movies') : isAnime ? 'anime' : 'series'
    buckets[target].push(normalizeItem(r.media_type, r))
  }
  return buckets
}

export async function searchTMDB(query, region = 'FR') {
  const q = String(query || '').trim()
  if (!q) return { query: '', movies: [], series: [], anime: [] }
  const cacheKey = `search:${q.toLowerCase()}:${region}`
  const hit = cacheGet(cacheKey)
  if (hit) return hit

  const multi = await tmdb('/search/multi', { query: q, include_adult: false, page: 1 })
  const buckets = splitByType(multi.results)

  buckets.movies = buckets.movies.slice(0, 15)
  buckets.series = buckets.series.slice(0, 15)
  buckets.anime = buckets.anime.slice(0, 8)
  await attachProviders([...buckets.movies, ...buckets.series, ...buckets.anime], region)

  const out = { query: q, ...buckets }
  cacheSet(cacheKey, out, SEARCH_TTL)
  return out
}

export function getWatchMeta(type, id) {
  return {
    type,
    id,
    available: false,
    message: "Le lecteur n'est pas encore disponible sur Lumo. Revenez bientôt !",
  }
}
