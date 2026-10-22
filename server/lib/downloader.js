import { createDecipheriv } from 'crypto'
import { spawn } from 'child_process'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'fs/promises'
import { createWriteStream, readdirSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { pipeline } from 'stream/promises'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const ROOT = join(__dirname, '..', '..')
export const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR
  ? process.env.DOWNLOAD_DIR.startsWith('/')
    ? process.env.DOWNLOAD_DIR
    : join(ROOT, process.env.DOWNLOAD_DIR)
  : join(ROOT, 'downloads')
export const AGGREGATE_URL = (process.env.AGGREGATE_URL || 'http://localhost:3001').replace(/\/+$/, '')

const HLS_TYPES = ['application/vnd.apple.mpegurl', 'application/x-mpegurl']
const DIRECT_EXT = ['.mp4', '.m4v', '.webm', '.mov']

// Durée minimale acceptée pour une source. Sous ce seuil (intros, bandes
// annonces), la source est jugée mauvaise et on passe à la suivante.
const MIN_SECONDS = Number(process.env.MIN_SOURCE_SECONDS || 60) || 60

// Sources à exclure (hostname) : certains "firestream" ne servent qu'une
// intro. Complétable via DOWNLOAD_EXCLUDE_SOURCES (liste séparée par virgules).
const BLOCKED_HOSTS = new Set(['firestream.to', 'firestream.top'])
for (const h of (process.env.DOWNLOAD_EXCLUDE_SOURCES || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) {
  BLOCKED_HOSTS.add(h)
}

export function isBlockedUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return [...BLOCKED_HOSTS].some((b) => host === b || host.endsWith('.' + b))
  } catch {
    return false
  }
}

const jobs = new Map()

function reqHeaders(referer) {
  return {
    'User-Agent':
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    ...(referer ? { Referer: referer } : {}),
  }
}

function progressJob(job, patch) {
  Object.assign(job, patch)
  if (job.totalBytes) job.ratio = Math.max(0, Math.min(1, job.downloadedBytes / job.totalBytes))
}

export function readdirSafe(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

// Durée réelle d'un média via ffprobe (ou null si indisponible/illisible).
function probeDuration(target) {
  return new Promise((resolve) => {
    const child = spawn(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', target],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let out = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve(null)
    }, 15000)
    child.stdout.on('data', (c) => (out += c))
    child.on('error', () => {
      clearTimeout(timer)
      resolve(null)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) return resolve(null)
      const dur = parseFloat(out.trim())
      resolve(Number.isFinite(dur) && dur > 0 ? dur : null)
    })
  })
}

function assertLongEnough(dur, label) {
  if (dur === null) return
  if (dur < MIN_SECONDS) {
    throw new Error(`${label} : durée ${Math.round(dur)}s < ${MIN_SECONDS}s — probablement une intro, rejetée.`)
  }
}

// Hauteur de la piste vidéo d'un média via ffprobe (ou null si indisponible).
function probeHeight(target) {
  return new Promise((resolve) => {
    const child = spawn(
      'ffprobe',
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=height', '-of', 'csv=p=0', target],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let out = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve(null)
    }, 15000)
    child.stdout.on('data', (c) => (out += c))
    child.on('error', () => {
      clearTimeout(timer)
      resolve(null)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) return resolve(null)
      const h = Number.parseInt(out.trim(), 10)
      resolve(Number.isFinite(h) && h > 0 ? h : null)
    })
  })
}

// Lance ffmpeg ; rejette si le binaire est absent ou si l'encodage échoue.
export function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
        stdio: ['ignore', 'ignore', 'pipe'],
      })
    } catch (err) {
      reject(new Error(`Impossible de lancer ffmpeg : ${err.message}`))
      return
    }
    let errBuf = ''
    child.stderr.on('data', (c) => {
      errBuf = (errBuf + c).slice(-4000)
    })
    child.on('error', () => reject(new Error('ffmpeg introuvable. Installez-le pour la sélection de qualité.')))
    child.on('close', (code) => {
      if (code === 0) return resolve()
      const detail = errBuf.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-2).join(' · ')
      reject(new Error(`Encodage ffmpeg échoué (code ${code})${detail ? ` — ${detail}` : ''}`))
    })
  })
}

// Transcode `input` vers un MP4 H.264/AAC en `targetH` de haut. La largeur est
// calculée automatiquement (multiple de 2) pour préserver le ratio.
async function transcodeToHeight(input, destDir, targetH, job) {
  const outName = `video_${targetH}p.mp4`
  const dest = join(destDir, outName)
  progressJob(job, {
    status: 'downloading',
    ratio: 0,
    downloadedBytes: 0,
    totalBytes: 0,
    segments: 0,
    segmentsTotal: 0,
    quality: `${targetH}p`,
    message: `Encodage en ${targetH}p…`,
  })
  await runFfmpeg([
    '-i', input,
    '-vf', `scale=-2:${targetH}`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24',
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
    dest,
  ])
  return outName
}

// Hauteur cible (en pixels) déduite du paramètre `quality` du client.
// Renvoie null pour "max" (qualité source, aucune conversion).
export function targetHeight(quality) {
  if (quality === undefined || quality === null) return null
  const q = String(quality).trim().toLowerCase()
  if (!q || q === 'max' || q === 'source') return null
  const h = Number(q.replace(/p$/, ''))
  return Number.isFinite(h) && h > 0 ? h : null
}

function variantHeight(variant) {
  return Number(variant?.resolution?.split('x')?.[1] || 0)
}

export function pathKey(type, id, season, episode, quality) {
  const base = type === 'tv' ? `tv/${id}/s${season || 1}e${episode || 1}` : `movie/${id}`
  // Toujours stocker la source (max) sous la clé de base. La qualité est
  // gérée au niveau de la lecture/transcodage, pas du téléchargement.
  return base
}

export function folderFor(key) {
  return join(DOWNLOAD_DIR, key)
}

async function hasIndexFile(key) {
  return readdirSafe(folderFor(key)).some((f) => f === 'index.m3u8' || /^video\./.test(f))
}

function latestReady(key) {
  const entries = readdirSafe(folderFor(key))
  if (entries.includes('index.m3u8')) return `/dl/${key}/index.m3u8`
  const v = entries.find((f) => /^video\./.test(f))
  return v ? `/dl/${key}/${v}` : null
}

export async function getStatus(key) {
  const job = jobs.get(key)
  if (job) {
    return {
      key,
      status: job.status,
      title: job.title || null,
      quality: job.quality || null,
      error: job.error || null,
      message: job.message || null,
      downloadedBytes: job.downloadedBytes || 0,
      totalBytes: job.totalBytes || 0,
      segments: job.segments || 0,
      segmentsTotal: job.segmentsTotal || 0,
      ratio: job.ratio || 0,
      playUrl: job.playUrl || null,
    }
  }
  if (await hasIndexFile(key)) {
    return { key, status: 'ready', playUrl: latestReady(key) }
  }
  return { key, status: 'idle' }
}

// ---------------------------------------------------------------------------
// Transcodage à la volée depuis le fichier local (changement de qualité)
// La source n'est téléchargée qu'une fois (qualité max) ; les qualités
// inférieures sont obtenues en encodant en HLS le fichier déjà local, sans
// aucun nouveau téléchargement.
// ---------------------------------------------------------------------------

const encodes = new Map() // "baseKey|qH" -> { child, dir }
const sourceHeights = new Map() // baseKey -> hauteur native (ou null)

function encodeDir(baseKey, h) {
  return join(folderFor(baseKey), `q${h}`)
}

// Convertit une URL de lecture locale (/dl/xxx) en chemin disque.
function sourceFsPath(playUrl) {
  const rel = String(playUrl).replace(/^\/dl\//, '')
  return join(DOWNLOAD_DIR, rel)
}

async function playlistReady(playlist) {
  try {
    const text = await readFile(playlist, 'utf8')
    // Au moins un segment présent = lisible.
    return /\.ts(\?|$)/m.test(text)
  } catch {
    return false
  }
}

async function startEncode(baseKey, h, sourcePath) {
  const id = `${baseKey}|q${h}`
  if (encodes.has(id)) return
  const dir = encodeDir(baseKey, h)
  // Réservation synchrone pour éviter un double démarrage concurrent.
  encodes.set(id, { child: null, dir })
  await rm(dir, { recursive: true, force: true }).catch(() => {})
  await mkdir(dir, { recursive: true })

  const child = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', sourcePath,
    '-vf', `scale=-2:${h}`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24',
    '-c:a', 'aac', '-b:a', '128k',
    '-f', 'hls', '-hls_time', '4', '-hls_list_size', '0',
    '-hls_segment_filename', join(dir, 'seg%05d.ts'),
    join(dir, 'index.m3u8'),
  ], { stdio: ['ignore', 'ignore', 'ignore'] })

  const entry = encodes.get(id)
  if (entry) entry.child = child
  const done = () => {
    if (encodes.get(id)?.child === child) encodes.delete(id)
  }
  child.on('error', done)
  child.on('close', done)
}

// Renvoie le statut de lecture pour la qualité demandée. Pour "max", renvoie
// directement la source. Pour une qualité inférieure, lance (si besoin) un
// encodage HLS à la volée depuis le fichier local et renvoie son statut.
export async function getStreamStatus(type, id, season, episode, quality) {
  const baseKey = pathKey(type, id, season, episode)
  const st = await getStatus(baseKey)
  const h = targetHeight(quality)

  if (!h || st.status !== 'ready' || !st.playUrl) return st

  const srcPath = sourceFsPath(st.playUrl)

  // Hauteur native de la source (mise en cache).
  if (!sourceHeights.has(baseKey)) {
    sourceHeights.set(baseKey, await probeHeight(srcPath))
  }
  const nativeH = sourceHeights.get(baseKey)

  // Source déjà <= qualité demandée : on sert la source telle quelle.
  if (nativeH && nativeH <= h) {
    return { ...st, quality: `${nativeH}p`, playUrl: st.playUrl }
  }

  const playlist = join(encodeDir(baseKey, h), 'index.m3u8')
  if (await playlistReady(playlist)) {
    return { ...st, quality: `${h}p`, playUrl: `/dl/${baseKey}/q${h}/index.m3u8` }
  }

  startEncode(baseKey, h, srcPath).catch(() => {})
  return {
    ...st,
    quality: `${h}p`,
    status: 'downloading',
    message: `Encodage en ${h}p depuis la copie locale…`,
    playUrl: null,
  }
}

// ---------------------------------------------------------------------------
// Récupération de la fiche + sources depuis le serveur agrégateur
// ---------------------------------------------------------------------------

export function aggregatePath(type, id, season, episode) {
  if (type === 'tv') {
    return `/series/${id}/episode?season=${season || 1}&episode=${episode || 1}`
  }
  return `/movie/${id}`
}

async function fetchAggregate(type, id, season, episode) {
  const url = `${AGGREGATE_URL}${aggregatePath(type, id, season, episode)}`
  const res = await fetch(url, { headers: reqHeaders() })
  if (!res.ok) throw new Error(`Source agrégée ${res.status}: ${res.statusText}`)
  return res.json()
}

function collectCandidates(meta) {
  const found = []

  function walk(v) {
    if (typeof v === 'string' && /\.(m3u8|mp4|m4v|webm|mov)(\?|$)/i.test(v)) {
      if (/^https?:\/\//.test(v) && !isBlockedUrl(v)) found.push(v)
      return
    }
    if (Array.isArray(v)) return v.forEach(walk)
    if (v && typeof v === 'object') return Object.values(v).forEach(walk)
  }

  if (meta && typeof meta === 'object') walk(meta)

  const seen = new Set()
  const dedup = []
  for (const url of found) {
    const clean = url.replace(/#.*$/, '')
    if (seen.has(clean)) continue
    seen.add(clean)
    dedup.push(clean)
  }

  const score = (u) => {
    let s = 0
    if (/\.m3u8(?:\?|$)/i.test(u)) s += 10
    if (/\/(master|index)(\.m3u8)?(\?|$)/i.test(u)) s += 20
    if (/1080|2160|4k/i.test(u)) s += 5
    if (/720/i.test(u)) s += 3
    if (/mp4|m4v|webm|mov/i.test(u)) s += 2
    return s
  }

  return dedup.sort((a, b) => score(b) - score(a))
}

// URLs "page de lecteur" (embed) présentes dans la fiche, à scraper à la
// recherche d'une vraie source vidéo (m3u8/mp4) si aucune URL directe n'existe.
function collectEmbedPages(meta) {
  const seen = new Set()
  const pages = []

  function walk(v) {
    if (typeof v === 'string' && /^https?:\/\//.test(v)) {
      const clean = v.replace(/#.*$/, '')
      if (/\.(m3u8|mp4|m4v|webm|mov)(\?|$)/i.test(clean)) return
      if (/\.(jpe?g|png|webp|gif|svg|css|js|json)(\?|$)/i.test(clean)) return
      if (isBlockedUrl(clean)) return
      if (seen.has(clean)) return
      seen.add(clean)
      pages.push(clean)
      return
    }
    if (Array.isArray(v)) return v.forEach(walk)
    if (v && typeof v === 'object') return Object.values(v).forEach(walk)
  }

  walk(meta)
  return pages
}

// ---------------------------------------------------------------------------
// Provider cinejoy (spécifique) : gestion différente — les liens sont résolus
// par l'API de l'agrégateur qui renvoie des playlists HLS servies via un proxy
// (/api/cinejoy/stream). On télécharge ces playlists comme n'importe quelle
// source HLS ; le flux reste ainsi servi par le serveur.
// ---------------------------------------------------------------------------

const CINEJOY_QUALITY = { '2160p': 4, '1080p': 3, hd: 2, '720p': 2, '480p': 1, '360p': 1 }

async function fetchCinejoy(type, id, season, episode) {
  const ep = type === 'tv'
    ? `/tv/${id}/${season || 1}/${episode || 1}`
    : `/movie/${id}`
  const url = `${AGGREGATE_URL}/api/cinejoy${ep}`
  const res = await fetch(url, { headers: reqHeaders() })
  if (!res.ok) return null
  const data = await res.json()
  if (!data || data.failure) return null
  return data
}

// Liens cinejoy en candidats HLS (via le proxy de l'agrégateur), meilleure
// langue disponible (vostfr puis vf), meilleure qualité en premier.
export async function cinejoyCandidates(type, id, season, episode) {
  let data
  try {
    data = await fetchCinejoy(type, id, season, episode)
  } catch {
    return []
  }
  if (!data) return []
  const out = []
  const seen = new Set()
  for (const lang of ['vostfr', 'vf']) {
    for (const link of (data.links || {})[lang] || []) {
      const q = String(link.quality || '').toLowerCase()
      const tag = `cinejoy ${lang} ${link.server || ''} ${q}`.trim()
      if (link.playUrl && !seen.has(link.playUrl)) {
        seen.add(link.playUrl)
        out.push({ url: link.playUrl, referer: null, tag, quality: q })
      }
    }
  }
  return out.sort((a, b) => (CINEJOY_QUALITY[b.quality] || 0) - (CINEJOY_QUALITY[a.quality] || 0))
}

// Scrape les pages embed : on cherche des URLs de médias (m3u8/mp4...) dans
// le HTML (balises source, variable file, ...). Parallélisé avec un plafond
// raisonnable : certaines sources ne se trouvent qu'à la fin de la liste.
async function scrapeMediaFromEmbeds(pages, job) {
  const re = /(?:https?:)?\/\/[^"'\s<>]+?\.(m3u8|mp4|m4v|webm|mov)(?:[?#][^"'\s<>]*)?/gi
  const target = pages.slice(0, 30)
  const found = []

  async function scrapeOne(page) {
    try {
      const res = await fetch(page, {
        headers: reqHeaders(new URL(page).origin),
        redirect: 'follow',
      })
      if (!res.ok) return
      const text = await res.text()
      for (const m of text.matchAll(re)) {
        const clean = m[0].replace(/#.*$/, '')
        const full = resolveUrl(page, clean)
        if (/^https?:\/\//.test(full) && !isBlockedUrl(full)) found.push(full)
      }
    } catch {
      // page suivante
    }
  }

  const pool = 5
  for (let i = 0; i < target.length; i += pool) {
    if (job) {
      progressJob(job, {
        message: `Scraping des lecteurs… (${Math.min(i + pool, target.length)}/${target.length})`,
      })
    }
    await Promise.all(target.slice(i, i + pool).map(scrapeOne))
  }

  const seen = new Set()
  const dedup = []
  for (const url of found) {
    if (seen.has(url)) continue
    seen.add(url)
    dedup.push(url)
  }
  const score = (u) => {
    let s = 0
    if (/\.m3u8(?:\?|$)/i.test(u)) s += 10
    if (/\/(master|index)(\.m3u8)?(\?|$)/i.test(u)) s += 20
    if (/1080|2160|4k/i.test(u)) s += 5
    if (/720/i.test(u)) s += 3
    if (/mp4|m4v|webm|mov/i.test(u)) s += 2
    return s
  }
  return dedup.sort((a, b) => score(b) - score(a))
}

// ---------------------------------------------------------------------------
// Parser minimal .m3u8 (gère variants, AES-128, EXT-X-MAP, BYTERANGE)
// ---------------------------------------------------------------------------

function parsePlaylist(text) {
  const lines = text.split(/\r?\n/)
  const isMaster = text.includes('#EXT-X-STREAM-INF')
  const variants = []
  const segments = []
  let mediaSequence = 0

  let currentKey = null
  let pendingKey = null
  let pendingMap = null
  let byterange = null
  let duration = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue

    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE')) {
      mediaSequence = Number(line.split(':')[1] || 0)
      continue
    }

    if (line.startsWith('#EXT-X-STREAM-INF')) {
      const attrs = Object.fromEntries(
        [...line.matchAll(/([A-Z0-9-]+)=(?:"([^"]*)"|([^",]*))/g)].map((m) => [m[1], m[2] ?? m[3]]),
      )
      const next = lines[i + 1]?.trim()
      if (next && !next.startsWith('#')) {
        variants.push({
          uri: next,
          bandwidth: Number(attrs.BANDWIDTH || 0),
          resolution: attrs.RESOLUTION || null,
        })
        i++
      }
      continue
    }

    if (line.startsWith('#EXT-X-KEY')) {
      const method = /METHOD=([A-Z0-9-]+)/.exec(line)?.[1]
      const uri = /URI="([^"]*)"/.exec(line)?.[1]
      const iv = /IV=0x([0-9A-Fa-f]+)/.exec(line)?.[1]
      pendingKey = { method, uri: uri || null, iv: iv ? Buffer.from(iv, 'hex') : null }
      currentKey = pendingKey
      continue
    }

    if (line.startsWith('#EXT-X-MAP')) {
      const uri = /URI="([^"]*)"/.exec(line)?.[1]
      const brMatch = /BYTERANGE="?([^"]*)"?/.exec(line)
      pendingMap = uri ? { uri, byterange: brMatch ? brMatch[1] : null } : null
      continue
    }

    if (line.startsWith('#EXT-X-BYTERANGE')) {
      byterange = line.replace('#EXT-X-BYTERANGE:', '').trim()
      continue
    }

    if (line.startsWith('#EXTINF')) {
      duration = Number(/#EXTINF:\s*([\d.]+)/.exec(line)?.[1] || 0)
      continue
    }

    if (line.startsWith('#')) continue

    segments.push({
      uri: line,
      duration,
      key: pendingKey || currentKey,
      map: pendingMap,
      byterange,
    })
    pendingMap = null
    byterange = null
    duration = null
    pendingKey = null
  }

  return { isMaster, variants, segments, mediaSequence }
}

function pickVariant(variants) {
  return [...variants].sort(
    (a, b) =>
      b.bandwidth - a.bandwidth ||
      Number(b.resolution?.split('x')[1] || 0) - Number(a.resolution?.split('x')[1] || 0),
  )[0]
}

function resolveUrl(base, rel) {
  try {
    return new URL(rel, base).toString()
  } catch {
    return rel
  }
}

// ---------------------------------------------------------------------------
// Téléchargement HLS
// ---------------------------------------------------------------------------

const KEY_CACHE = new Map()

async function fetchKey(uri, playlistUrl, referer) {
  if (KEY_CACHE.has(uri)) return KEY_CACHE.get(uri)
  const res = await fetch(resolveUrl(playlistUrl, uri), {
    headers: reqHeaders(referer || new URL(playlistUrl).origin),
  })
  if (!res.ok) throw new Error(`Clé de chiffrement indisponible (${res.status})`)
  const key = Buffer.from(await res.arrayBuffer())
  KEY_CACHE.set(uri, key)
  return key
}

function defaultIv(sequence) {
  const buf = Buffer.alloc(16)
  buf.writeBigUInt64BE(BigInt(sequence), 8)
  return buf
}

async function downloadSegment(seg, sequence, playlistUrl, outPath, job, referer) {
  const url = resolveUrl(playlistUrl, seg.uri)
  const headers = reqHeaders(referer || new URL(playlistUrl).origin)

  if (seg.byterange) {
    const [len, offset] = seg.byterange.split('@').map(Number)
    const start = offset ?? (seg.rangeEnd ?? 0)
    headers.Range = `bytes=${start}-${start + len - 1}`
    seg.rangeEnd = start + len
  }

  const res = await fetch(url, { headers })
  if (!res.ok) throw new Error(`Segment ${url} → ${res.status}`)
  let data = Buffer.from(await res.arrayBuffer())

  const cl = Number(res.headers.get('content-length') || 0)
  if (cl > 0) job.sizes.push(data.length || cl)

  if (seg.key && seg.key.method === 'AES-128' && seg.key.uri) {
    const key = await fetchKey(seg.key.uri, playlistUrl, referer)
    const iv = seg.key.iv || defaultIv(sequence)
    const decipher = createDecipheriv('aes-128-cbc', key, iv)
    data = Buffer.concat([decipher.update(data), decipher.final()])
  }

  await writeFile(outPath, data)

  const downloadedBytes = job.downloadedBytes + data.length
  const segments = job.segments + 1
  const patch = { downloadedBytes, segments }

  // Estimation du total à partir de la taille moyenne RÉELLE des segments
  // déjà téléchargés. Contrairement à une estimation figée sur le 1er segment,
  // elle est toujours >= bytes téléchargés (ratio <= 100%) et converge vers la
  // taille finale exacte quand tous les segments sont téléchargés.
  if (job.segmentsTotal) {
    const avg = downloadedBytes / segments
    patch.totalBytes = Math.max(Math.round(avg * job.segmentsTotal), downloadedBytes)
  }

  progressJob(job, patch)
}

async function downloadHls(url, destDir, job, referer, targetH = null) {
  const origin = new URL(url).origin
  const masterRes = await fetch(url, { headers: reqHeaders(referer || origin) })
  if (!masterRes.ok) throw new Error(`Playlist indisponible (${masterRes.status})`)
  const masterText = (await masterRes.text()).trim()
  const master = parsePlaylist(masterText)

  let playlistUrl = url
  let playlistText = masterText
  let quality = null
  let nativeH = null

  if (master.isMaster && master.variants.length) {
    let variant
    if (targetH) {
      // Toujours télécharger la meilleure variante (source max) pour transcoder
      // nous-mêmes vers la qualité demandée. Ne pas demander une variante plus
      // basse au serveur source.
      variant = pickVariant(master.variants)
    } else {
      variant = pickVariant(master.variants)
    }
    playlistUrl = resolveUrl(url, variant.uri)
    quality = variant.resolution || null
    nativeH = variantHeight(variant) || null
    const vres = await fetch(playlistUrl, { headers: reqHeaders(referer || origin) })
    if (!vres.ok) throw new Error(`Variant indisponible (${vres.status})`)
    playlistText = await vres.text()
    await writeFile(join(destDir, 'source.m3u8'), masterText)
  }

  const playlist = parsePlaylist(playlistText)
  if (!playlist.segments.length) throw new Error('Aucun segment dans la playlist')

  // Rejet précoce des sources trop courtes (avant de télécharger les segments)
  const extinfTotal = playlist.segments.reduce((a, s) => a + (s.duration || 0), 0)
  assertLongEnough(extinfTotal || null, 'Playlist trop courte')

  progressJob(job, { quality, segmentsTotal: playlist.segments.length, message: 'Téléchargement des segments…' })

  const segDir = join(destDir, 'segments')
  await mkdir(segDir, { recursive: true })

  const needsVersion4 = playlist.segments.some((s) => s.byterange || s.map)
  const localLines = [
    '#EXTM3U',
    `#EXT-X-VERSION:${needsVersion4 ? 4 : 3}`,
    `#EXT-X-TARGETDURATION:${Math.max(1, Math.ceil(Math.max(...playlist.segments.map((s) => s.duration || 6))))}`,
  ]

  let mapDone = false
  if (playlist.segments[0]?.map) {
    const mapRes = await fetch(resolveUrl(playlistUrl, playlist.segments[0].map.uri), {
      headers: reqHeaders(referer || origin),
    })
    if (!mapRes.ok) throw new Error(`Segment d'initialisation indisponible (${mapRes.status})`)
    await writeFile(join(segDir, 'init.mp4'), Buffer.from(await mapRes.arrayBuffer()))
    mapDone = true
  }

  for (let i = 0; i < playlist.segments.length; i++) {
    const seg = playlist.segments[i]
    const name = `seg${String(i).padStart(5, '0')}.ts`
    await downloadSegment(seg, playlist.mediaSequence + i, playlistUrl, join(segDir, name), job, referer)
    if (mapDone) {
      localLines.push('#EXT-X-MAP:URI="segments/init.mp4"')
      mapDone = false
    }
    localLines.push(`#EXTINF:${(seg.duration || 6).toFixed(3)},`)
    localLines.push(`segments/${name}`)
  }
  localLines.push('#EXT-X-ENDLIST')

  await writeFile(join(destDir, 'index.m3u8'), localLines.join('\n') + '\n')

  // Vérification réelle avec ffprobe (les EXTINF peuvent mentir)
  await assertLongEnough(await probeDuration(join(destDir, 'index.m3u8')), 'Vidéo trop courte')

  // Conversion vers la qualité demandée si la source est plus grande.
  const srcH = nativeH || (await probeHeight(join(destDir, 'index.m3u8')))
  if (targetH && srcH && srcH > targetH) {
    const outName = await transcodeToHeight(join(destDir, 'index.m3u8'), destDir, targetH, job)
    await rm(segDir, { recursive: true, force: true }).catch(() => {})
    await rm(join(destDir, 'index.m3u8'), { force: true }).catch(() => {})
    await rm(join(destDir, 'source.m3u8'), { force: true }).catch(() => {})
    const fstat = await stat(join(destDir, outName))
    progressJob(job, {
      status: 'ready',
      ratio: 1,
      downloadedBytes: fstat.size,
      totalBytes: fstat.size,
      segments: playlist.segments.length,
      segmentsTotal: playlist.segments.length,
      message: null,
      playUrl: `/dl/${job.key}/${outName}`,
    })
    return
  }

  const actual = job.sizes.length === playlist.segments.length
    ? job.sizes.reduce((a, b) => a + b, 0)
    : job.downloadedBytes
  progressJob(job, {
    status: 'ready',
    ratio: 1,
    downloadedBytes: actual,
    totalBytes: actual,
    segmentsTotal: playlist.segments.length,
    playUrl: `/dl/${job.key}/index.m3u8`,
  })
}

// ---------------------------------------------------------------------------
// Téléchargement fichier direct (mp4/webm...)
// ---------------------------------------------------------------------------

async function downloadDirect(url, destDir, job, referer, targetH = null) {
  const ext = DIRECT_EXT.find((e) => url.toLowerCase().includes(e)) || '.mp4'
  const target = join(destDir, `video${ext}`)
  const res = await fetch(url, { headers: reqHeaders(referer || new URL(url).origin) })
  if (!res.ok) throw new Error(`Vidéo indisponible (${res.status})`)

  const cl = Number(res.headers.get('content-length') || 0)
  if (cl) progressJob(job, { totalBytes: cl, message: 'Téléchargement de la vidéo…' })

  await pipeline(res.body, createWriteStream(target))
  const fstat = await stat(target)

  // Rejet des fichiers trop courts (intros) si la durée est mesurable
  await assertLongEnough(await probeDuration(target), 'Vidéo trop courte')

  // Conversion vers la qualité demandée si la source est plus grande.
  const srcH = await probeHeight(target)
  if (targetH && srcH && srcH > targetH) {
    const outName = await transcodeToHeight(target, destDir, targetH, job)
    await rm(target, { force: true }).catch(() => {})
    const outStat = await stat(join(destDir, outName))
    progressJob(job, {
      status: 'ready',
      downloadedBytes: outStat.size,
      totalBytes: outStat.size,
      ratio: 1,
      message: null,
      playUrl: `/dl/${job.key}/${outName}`,
    })
    return
  }

  progressJob(job, {
    status: 'ready',
    downloadedBytes: fstat.size,
    totalBytes: cl || fstat.size,
    ratio: 1,
    playUrl: `/dl/${job.key}/video${ext}`,
  })
}

// ---------------------------------------------------------------------------
// Fallback yt-dlp : ultime recours quand aucune source (directe ou scrapée)
// n'a pu être trouvée. yt-dlp sait résoudre certains hosts/players via ses
// extracteurs. À garder uniquement en fallback.
// ---------------------------------------------------------------------------

function parseHumanSize(text) {
  const m = /([\d.]+)\s*([KMGT]i?B)/i.exec(text || '')
  if (!m) return 0
  const mult = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4 }
  return Math.round(Number(m[1]) * (mult[m[2].toUpperCase()] || 1))
}

// Lance yt-dlp sur une page et rend le nom du fichier produit (ex: video.mp4).
// Suit la progression via la sortie `--newline` de yt-dlp.
export async function ytdlpDownload(page, destDir, job) {
  const bin = process.env.YTDLP_BIN || 'yt-dlp'
  const target = join(destDir, 'video.%(ext)s')
  const timeoutMs = Number(process.env.YTDLP_TIMEOUT || 0) || 180000

  return new Promise((resolve, reject) => {
    let child
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('yt-dlp a pris trop de temps'))
    }, timeoutMs)

    try {
      child = spawn(
        bin,
        ['--newline', '--no-playlist', '--no-warnings', '-f', 'best[ext=mp4]/best', '-o', target, page],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      )
    } catch (err) {
      clearTimeout(timer)
      reject(new Error(`Impossible de lancer yt-dlp (${bin}) : ${err.message}`))
      return
    }

    child.on('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`yt-dlp introuvable (${bin}). Installez-le pour activer ce fallback.`))
    })

    child.stdout.on('data', (chunk) => {
      const m = /(\d+(?:\.\d+)?)%\s+of\s+([\d.]+)\s*[KMGT]i?B/i.exec(chunk.toString())
      if (m) {
        const ratio = Math.max(0, Math.min(1, Number(m[1]) / 100))
        const total = parseHumanSize(m[0])
        if (total) progressJob(job, { totalBytes: total, downloadedBytes: Math.round(total * ratio), ratio })
      }
    })

    let errBuf = ''
    child.stderr.on('data', (c) => {
      errBuf = (errBuf + c).slice(-4000)
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        const detail = errBuf
          .split(/\r?\n/)
          .map((l) => l.trim().replace(/^ERROR:\s*/i, ''))
          .filter(Boolean)
          .slice(-2)
          .join(' · ')
        reject(new Error(`yt-dlp a échoué sur ${page}${detail ? ` — ${detail}` : ` (code ${code})`}`))
        return
      }
      const file = readdirSync(destDir).find((f) => /^video\./.test(f))
      if (!file) {
        reject(new Error("yt-dlp n'a produit aucun fichier"))
        return
      }
      resolve(file)
    })
  })
}

async function tryYtdlpFallback(pages, key, job, targetH = null) {
  if ((process.env.YTDLP_FALLBACK || 'true') === 'false') {
    throw new Error("Aucune source vidéo trouvée pour ce titre sur l'agrégateur.")
  }
  const destDir = folderFor(key)
  let lastErr = null
  progressJob(job, { downloadedBytes: 0, totalBytes: 0, ratio: 0, segments: 0, segmentsTotal: 0, quality: targetH ? `${targetH}p` : 'fallback' })
  for (const page of pages.slice(0, 5)) {
    try {
      progressJob(job, { message: `yt-dlp : essai de ${new URL(page).host}…` })
      const file = await ytdlpDownload(page, destDir, job)
      const srcPath = join(destDir, file)
      const fstat = await stat(srcPath)
      await assertLongEnough(await probeDuration(srcPath), 'Vidéo (yt-dlp) trop courte')

      // Conversion vers la qualité demandée si la source est plus grande.
      const srcH = await probeHeight(srcPath)
      if (targetH && srcH && srcH > targetH) {
        const outName = await transcodeToHeight(srcPath, destDir, targetH, job)
        await rm(srcPath, { force: true }).catch(() => {})
        const outStat = await stat(join(destDir, outName))
        progressJob(job, {
          status: 'ready',
          downloadedBytes: outStat.size,
          totalBytes: outStat.size,
          ratio: 1,
          quality: `${targetH}p`,
          message: null,
          playUrl: `/dl/${key}/${outName}`,
        })
        return
      }

      progressJob(job, {
        status: 'ready',
        downloadedBytes: fstat.size,
        totalBytes: fstat.size,
        ratio: 1,
        quality: 'fallback',
        playUrl: `/dl/${key}/${file}`,
      })
      return
    } catch (err) {
      lastErr = err
      await rm(destDir, { recursive: true, force: true }).catch(() => {})
      await mkdir(destDir, { recursive: true })
    }
  }
  throw new Error(
    `Aucune source vidéo trouvée (ni directe, ni scrapée, ni via yt-dlp).${lastErr ? ` Dernier essai : ${lastErr.message}` : ''}`,
  )
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export async function startDownload(type, id, season, episode, quality) {
  // La source est toujours téléchargée en qualité maximale, une seule fois.
  // Les qualités inférieures sont obtenues par transcodage du fichier local
  // (voir getStreamStatus). `quality` est donc ignoré au téléchargement.
  const key = pathKey(type, id, season, episode, quality)

  if (jobs.has(key)) return getStatus(key)
  if (await hasIndexFile(key)) return getStatus(key)

  const destDir = folderFor(key)
  await rm(destDir, { recursive: true, force: true })
  await mkdir(destDir, { recursive: true })

  const job = {
    key,
    type,
    id,
    season: season || null,
    episode: episode || null,
    status: 'downloading',
    title: null,
    quality: null,
    error: null,
    message: 'Récupération des sources…',
    totalBytes: 0,
    downloadedBytes: 0,
    ratio: 0,
    segments: 0,
    segmentsTotal: 0,
    sizes: [],
    playUrl: null,
  }
  jobs.set(key, job)

  startDownloadAsync(type, id, season, episode, key, job, null).catch((err) => {
    progressJob(job, { status: 'error', error: err.message })
  })

  return getStatus(key)
}

async function startDownloadAsync(type, id, season, episode, key, job, targetH = null) {
  let lastErr = null
  try {
    const meta = await fetchAggregate(type, id, season, episode)
    job.title = meta?.title || meta?.tmdb_details?.title || `${type} ${id}`

    let candidates = collectCandidates(meta)
    const pages = collectEmbedPages(meta)

    // Aucune source directe : on demande cinejoy (provider spécifique, servi
    // par l'agrégateur) puis, à défaut, on scrappe les pages embed.
    if (!candidates.length) {
      progressJob(job, { message: 'Recherche sur cinejoy…' })
      candidates = await cinejoyCandidates(type, id, season, episode)
    }
    if (!candidates.length) {
      // Toujours rien : scraping des pages embed.
      candidates = await scrapeMediaFromEmbeds(pages, job)
    }
    if (!candidates.length) {
      // Ultime recours : yt-dlp sur les pages embed.
      await tryYtdlpFallback(pages, key, job, targetH)
      return
    }

    for (const item of candidates) {
      const url = typeof item === 'string' ? item : item.url
      const referer = typeof item === 'string' ? null : item.referer || null
      try {
        progressJob(job, { message: `${item.tag || ''} — test de ${new URL(url).host}…`.trim() })
        const probe = await fetch(url, {
          headers: { ...reqHeaders(referer || new URL(url).origin), Range: 'bytes=0-65536' },
        })
        if (!probe.ok) throw new Error(`réponse ${probe.status}`)
        const ctype = probe.headers.get('content-type') || ''
        const buf = Buffer.from(await probe.arrayBuffer())
        const headText = buf.toString('utf8', 0, Math.min(buf.length, 1024))
        const isM3U8 = HLS_TYPES.some((t) => ctype.includes(t)) || headText.trimStart().startsWith('#EXTM3U')
        const isMp4 = ctype.includes('video') || buf.length > 11 && buf.readUInt32BE(4) === 0x66747970 /* ftyp */

        if (isM3U8) {
          await downloadHls(url, folderFor(key), job, referer, targetH)
          return
        }
        if (isMp4) {
          await downloadDirect(url, folderFor(key), job, referer, targetH)
          return
        }
        throw new Error('format non reconnu')
      } catch (err) {
        lastErr = err
        // Une source rejetée (intro trop courte, etc.) laisse des fichiers :
        // on nettoie avant d'essayer la candidat suivant.
        await rm(folderFor(key), { recursive: true, force: true }).catch(() => {})
        await mkdir(folderFor(key), { recursive: true }).catch(() => {})
      }
    }

    // Tous les candidats ont échoué (intros trop courtes, formats, 403...) :
    // dernier espoir, on laisse yt-dlp tenter sa chance sur les pages embed.
    if (pages.length) {
      await tryYtdlpFallback(pages, key, job, targetH)
      return
    }
    throw new Error(`Aucune source exploitable. ${lastErr ? `Dernière erreur : ${lastErr.message}` : ''}`.trim())
  } catch (err) {
    await rm(folderFor(key), { recursive: true, force: true }).catch(() => {})
    progressJob(job, { status: 'error', error: err.message })
  }
}