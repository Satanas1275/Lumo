import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { register, login, signToken, toPublic, updateSettings } from './lib/users.js'
import { requireAuth } from './lib/auth.js'
import {
  ApiError,
  getDiscover,
  getTitle,
  getSeasonEpisodes,
  getWatchMeta,
} from './lib/tmdb.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CLIENT_DIR = join(ROOT, 'client')
const PORT = Number(process.env.PORT || 3000)
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || ''

const app = express()
app.use(cors({ origin: PUBLIC_ORIGIN || true }))
app.use(express.json({ limit: '1mb' }))

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next)

app.get('/api/health', (req, res) => {
  res.json({ ok: true, name: 'Lumo', origin: PUBLIC_ORIGIN || 'localhost' })
})

// --- Auth ---------------------------------------------------------------
app.post('/api/auth/register', wrap(async (req, res) => {
  const { username, password } = req.body || {}
  const user = await register(username, password)
  res.status(201).json({ token: signToken(user), user: toPublic(user) })
}))

app.post('/api/auth/login', wrap(async (req, res) => {
  const { username, password } = req.body || {}
  const user = await login(username, password)
  if (!user) return res.status(401).json({ error: 'Pseudo ou mot de passe incorrect.' })
  res.json({ token: signToken(user), user: toPublic(user) })
}))

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: toPublic(req.user) })
})

app.put('/api/me/settings', requireAuth, wrap(async (req, res) => {
  const user = await updateSettings(req.user.id, req.body || {})
  res.json({ user })
}))

// --- TMDB (clé cachée côté serveur) --------------------------------------
app.get('/api/discover', wrap(async (req, res) => {
  const region = String(req.query.region || 'FR').toUpperCase().slice(0, 2)
  res.json(await getDiscover(region))
}))

app.get('/api/title/:type/:id', wrap(async (req, res) => {
  const { type, id } = req.params
  if (!['movie', 'tv'].includes(type)) throw new ApiError(400, 'Type invalide.')
  const region = String(req.query.region || 'FR').toUpperCase().slice(0, 2)
  res.json(await getTitle(type, Number(id), region))
}))

app.get('/api/title/tv/:id/season/:season', wrap(async (req, res) => {
  const { id, season } = req.params
  res.json({ episodes: await getSeasonEpisodes(Number(id), Number(season)) })
}))

app.get('/api/watch/:type/:id', wrap(async (req, res) => {
  const { type, id } = req.params
  res.json(getWatchMeta(type, Number(id)))
}))

// --- Frontend statique ----------------------------------------------------
app.use(express.static(CLIENT_DIR))
app.get(/^\/(?!api\/).*/, (req, res) => {
  res.sendFile(join(CLIENT_DIR, 'index.html'))
})

// --- Gestion des erreurs ---------------------------------------------------
app.use((err, req, res, next) => {
  if (err instanceof ApiError) return res.status(err.status).json({ error: err.message })
  if (err.status) return res.status(err.status).json({ error: err.message })
  console.error(err)
  res.status(500).json({ error: 'Erreur serveur interne.' })
})

app.listen(PORT, () => {
  console.log(`Lumo backend sur http://localhost:${PORT}${PUBLIC_ORIGIN ? ` (origine: ${PUBLIC_ORIGIN})` : ''}`)
})
