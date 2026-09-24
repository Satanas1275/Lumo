import { createDecipheriv } from 'crypto'
import { spawn } from 'child_process'
import { mkdir, readdir, rm, stat, writeFile } from 'fs/promises'
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

function readdirSafe(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

export function pathKey(type, id, season, episode) {
  if (type === 'tv') return `tv/${id}/s${season || 1}e${episode || 1}`
  return `movie/${id}`
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
      if (/^https?:\/\//.test(v)) found.push(v)
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

// Scrape les pages embed : on cherche des URLs de médias (m3u8/mp4...) dans
// le HTML (balises source, variable file, ...). Parallélisé avec un plafond
// raisonnable : certaines sources ne se trouvent qu'à la fin de la liste.
async function scrapeMediaFromEmbeds(pages) {
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
        if (/^https?:\/\//.test(full)) found.push(full)
      }
    } catch {
      // page suivante
    }
  }

  const pool = 5
  for (let i = 0; i < target.length; i += pool) {
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

async function fetchKey(uri, playlistUrl) {
  if (KEY_CACHE.has(uri)) return KEY_CACHE.get(uri)
  const res = await fetch(resolveUrl(playlistUrl, uri), {
    headers: reqHeaders(new URL(playlistUrl).origin),
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

async function downloadSegment(seg, sequence, playlistUrl, outPath, job) {
  const url = resolveUrl(playlistUrl, seg.uri)
  const headers = reqHeaders(new URL(playlistUrl).origin)

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
  if (!job.knownTotal && job.sizes.length && job.segmentsTotal) {
    // Estimation progressive : moyenne connue × nombre total de segments
    const avg = job.sizes.reduce((a, b) => a + b, 0) / job.sizes.length
    progressJob(job, { totalBytes: Math.round(avg * job.segmentsTotal), knownTotal: true })
  }

  if (seg.key && seg.key.method === 'AES-128' && seg.key.uri) {
    const key = await fetchKey(seg.key.uri, playlistUrl)
    const iv = seg.key.iv || defaultIv(sequence)
    const decipher = createDecipheriv('aes-128-cbc', key, iv)
    data = Buffer.concat([decipher.update(data), decipher.final()])
  }

  await writeFile(outPath, data)
  progressJob(job, {
    downloadedBytes: job.downloadedBytes + data.length,
    segments: job.segments + 1,
  })
}

async function downloadHls(url, destDir, job) {
  const origin = new URL(url).origin
  const masterRes = await fetch(url, { headers: reqHeaders(origin) })
  if (!masterRes.ok) throw new Error(`Playlist indisponible (${masterRes.status})`)
  const masterText = (await masterRes.text()).trim()
  const master = parsePlaylist(masterText)

  let playlistUrl = url
  let playlistText = masterText
  let quality = null

  if (master.isMaster && master.variants.length) {
    const variant = pickVariant(master.variants)
    playlistUrl = resolveUrl(url, variant.uri)
    quality = variant.resolution || null
    const vres = await fetch(playlistUrl, { headers: reqHeaders(origin) })
    if (!vres.ok) throw new Error(`Variant indisponible (${vres.status})`)
    playlistText = await vres.text()
    await writeFile(join(destDir, 'source.m3u8'), masterText)
  }

  const playlist = parsePlaylist(playlistText)
  if (!playlist.segments.length) throw new Error('Aucun segment dans la playlist')

  progressJob(job, { quality, segmentsTotal: playlist.segments.length })

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
      headers: reqHeaders(origin),
    })
    if (!mapRes.ok) throw new Error(`Segment d'initialisation indisponible (${mapRes.status})`)
    await writeFile(join(segDir, 'init.mp4'), Buffer.from(await mapRes.arrayBuffer()))
    mapDone = true
  }

  for (let i = 0; i < playlist.segments.length; i++) {
    const seg = playlist.segments[i]
    const name = `seg${String(i).padStart(5, '0')}.ts`
    await downloadSegment(seg, playlist.mediaSequence + i, playlistUrl, join(segDir, name), job)
    if (mapDone) {
      localLines.push('#EXT-X-MAP:URI="segments/init.mp4"')
      mapDone = false
    }
    localLines.push(`#EXTINF:${(seg.duration || 6).toFixed(3)},`)
    localLines.push(`segments/${name}`)
  }
  localLines.push('#EXT-X-ENDLIST')

  await writeFile(join(destDir, 'index.m3u8'), localLines.join('\n') + '\n')
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

async function downloadDirect(url, destDir, job) {
  const ext = DIRECT_EXT.find((e) => url.toLowerCase().includes(e)) || '.mp4'
  const target = join(destDir, `video${ext}`)
  const res = await fetch(url, { headers: reqHeaders(new URL(url).origin) })
  if (!res.ok) throw new Error(`Vidéo indisponible (${res.status})`)

  const cl = Number(res.headers.get('content-length') || 0)
  if (cl) progressJob(job, { totalBytes: cl })

  await pipeline(res.body, createWriteStream(target))
  const fstat = await stat(target)
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

    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        reject(new Error(`yt-dlp a échoué sur ${page} (code ${code})`))
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

async function tryYtdlpFallback(pages, key, job) {
  if ((process.env.YTDLP_FALLBACK || 'true') === 'false') {
    throw new Error("Aucune source vidéo trouvée pour ce titre sur l'agrégateur.")
  }
  const destDir = folderFor(key)
  let lastErr = null
  for (const page of pages.slice(0, 5)) {
    try {
      const file = await ytdlpDownload(page, destDir, job)
      const fstat = await stat(join(destDir, file))
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

export async function startDownload(type, id, season, episode) {
  const key = pathKey(type, id, season, episode)

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
    totalBytes: 0,
    downloadedBytes: 0,
    ratio: 0,
    segments: 0,
    segmentsTotal: 0,
    sizes: [],
    knownTotal: false,
    playUrl: null,
  }
  jobs.set(key, job)

  startDownloadAsync(type, id, season, episode, key, job).catch((err) => {
    progressJob(job, { status: 'error', error: err.message })
  })

  return getStatus(key)
}

async function startDownloadAsync(type, id, season, episode, key, job) {
  let lastErr = null
  try {
    const meta = await fetchAggregate(type, id, season, episode)
    job.title = meta?.title || meta?.tmdb_details?.title || `${type} ${id}`

    let candidates = collectCandidates(meta)
    const pages = collectEmbedPages(meta)
    if (!candidates.length) {
      // Pas d'URL directe : on scrappe les pages embed pour en extraire une.
      candidates = await scrapeMediaFromEmbeds(pages)
    }
    if (!candidates.length) {
      // Ultime recours : yt-dlp sur les pages embed.
      await tryYtdlpFallback(pages, key, job)
      return
    }

    for (const url of candidates) {
      try {
        const probe = await fetch(url, {
          headers: { ...reqHeaders(new URL(url).origin), Range: 'bytes=0-65536' },
        })
        if (!probe.ok) throw new Error(`réponse ${probe.status}`)
        const ctype = probe.headers.get('content-type') || ''
        const buf = Buffer.from(await probe.arrayBuffer())
        const headText = buf.toString('utf8', 0, Math.min(buf.length, 1024))
        const isM3U8 = HLS_TYPES.some((t) => ctype.includes(t)) || headText.trimStart().startsWith('#EXTM3U')
        const isMp4 = ctype.includes('video') || buf.length > 11 && buf.readUInt32BE(4) === 0x66747970 /* ftyp */

        if (isM3U8) {
          await downloadHls(url, folderFor(key), job)
          return
        }
        if (isMp4) {
          await downloadDirect(url, folderFor(key), job)
          return
        }
        throw new Error('format non reconnu')
      } catch (err) {
        lastErr = err
      }
    }
    throw new Error(`Aucune source exploitable. ${lastErr ? `Dernière erreur : ${lastErr.message}` : ''}`.trim())
  } catch (err) {
    await rm(folderFor(key), { recursive: true, force: true }).catch(() => {})
    progressJob(job, { status: 'error', error: err.message })
  }
}