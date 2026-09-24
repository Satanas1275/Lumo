import { promises as fs, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import crypto from 'crypto'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DATA_DIR = join(ROOT, 'data')
const USERS_FILE = join(DATA_DIR, 'users.json')

let users = []

function now() {
  return new Date().toISOString()
}

async function load() {
  try {
    const raw = await fs.readFile(USERS_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    users = (parsed.users || []).map(normalizeUser)
  } catch {
    users = []
  }
}

function normalizeUser(u) {
  return {
    ...u,
    role: u.role === 'admin' ? 'admin' : 'member',
    status: u.status === 'pending' ? 'pending' : 'active',
  }
}

export function approvalRequired() {
  return process.env.REQUIRE_ADMIN_APPROVAL === 'true'
}

let writeQueue = Promise.resolve()
async function save() {
  writeQueue = writeQueue.then(async () => {
    await fs.mkdir(DATA_DIR, { recursive: true })
    const tmp = USERS_FILE + '.tmp'
    await fs.writeFile(tmp, JSON.stringify({ users }, null, 2))
    await fs.rename(tmp, USERS_FILE)
  })
  return writeQueue
}

export function getSecret() {
  const env = process.env.JWT_SECRET
  if (env) return env
  const file = join(DATA_DIR, '.secret')
  try {
    const existing = readFileSync(file, 'utf8').trim()
    if (existing) return existing
  } catch {}
  const secret = crypto.randomBytes(32).toString('hex')
  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(file, secret)
  return secret
}

const JWT_EXPIRES = '30d'

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    role: u.role || 'member',
    status: u.status || 'active',
    createdAt: u.createdAt,
    settings: u.settings,
  }
}

function defaultSettings() {
  return {
    showProviders: true,
    showRatings: true,
    showTitles: true,
    region: 'FR',
  }
}

export function signToken(u) {
  return jwt.sign({ uid: u.id }, getSecret(), { expiresIn: JWT_EXPIRES })
}

export function verifyToken(token) {
  try {
    const payload = jwt.verify(token, getSecret())
    const u = users.find((x) => x.id === payload.uid)
    return u || null
  } catch {
    return null
  }
}

export class UserError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.status = status
  }
}

export async function register(username, password) {
  const name = String(username || '').trim()
  if (name.length < 3 || name.length > 24) {
    throw new UserError('Le pseudo doit faire entre 3 et 24 caractères.')
  }
  if (!/^[a-zA-Z0-9_.-]+$/.test(name)) {
    throw new UserError('Pseudo invalide (lettres, chiffres, _ . - uniquement).')
  }
  if (typeof password !== 'string' || password.length < 6) {
    throw new UserError('Le mot de passe doit faire au moins 6 caractères.')
  }
  const existing = users.find((u) => u.username.toLowerCase() === name.toLowerCase())
  if (existing) throw new UserError('Ce pseudo est déjà pris.')

  const user = {
    id: crypto.randomUUID(),
    username: name,
    role: 'member',
    status: approvalRequired() ? 'pending' : 'active',
    passwordHash: await bcrypt.hash(password, 10),
    createdAt: now(),
    settings: defaultSettings(),
  }
  users.push(user)
  await save()
  return user
}

export async function login(username, password) {
  const name = String(username || '').trim()
  const user = users.find((u) => u.username.toLowerCase() === name.toLowerCase())
  if (!user) return null
  const ok = await bcrypt.compare(String(password || ''), user.passwordHash)
  return ok ? user : null
}

export async function updateSettings(uid, patch) {
  const user = users.find((u) => u.id === uid)
  if (!user) return null
  const allowed = { showProviders: 1, showRatings: 1, showTitles: 1, region: 1 }
  const next = { ...user.settings }
  for (const k of Object.keys(allowed)) {
    if (k in patch) next[k] = patch[k]
  }
  if (typeof next.region !== 'string' || !/^[A-Z]{2}$/.test(next.region)) {
    next.region = 'FR'
  }
  user.settings = next
  await save()
  return publicUser(user)
}

export function toPublic(u) {
  return publicUser(u)
}

// ---------------------------------------------------------------------------
// Administration (création d'admin uniquement via CLI / npm)
// ---------------------------------------------------------------------------

function findUser(id) {
  return users.find((u) => u.id === id) || null
}

function validateName(name) {
  if (name.length < 3 || name.length > 24) {
    throw new UserError('Le pseudo doit faire entre 3 et 24 caractères.')
  }
  if (!/^[a-zA-Z0-9_.-]+$/.test(name)) {
    throw new UserError('Pseudo invalide (lettres, chiffres, _ . - uniquement).')
  }
}

export function hasUsername(name, excludeId) {
  return users.some((u) => u.username.toLowerCase() === String(name).toLowerCase() && u.id !== excludeId)
}

export async function addAdmin(username, password) {
  const name = String(username || '').trim()
  validateName(name)
  if (hasUsername(name)) throw new UserError('Ce pseudo est déjà pris.')
  if (typeof password !== 'string' || password.length < 10) {
    throw new UserError('Le mot de passe admin doit faire au moins 10 caractères.')
  }
  if (password.toLowerCase().includes(name.toLowerCase())) {
    throw new UserError('Le mot de passe ne doit pas contenir le pseudo.')
  }

  const user = {
    id: crypto.randomUUID(),
    username: name,
    role: 'admin',
    status: 'active',
    passwordHash: await bcrypt.hash(password, 12),
    createdAt: now(),
    settings: defaultSettings(),
  }
  users.push(user)
  await save()
  return publicUser(user)
}

export function listUsers() {
  return users.map(publicUser)
}

export async function approveUser(id) {
  const u = findUser(id)
  if (!u) return null
  if (u.role === 'admin') throw new UserError('Un administrateur ne peut pas être approuvé.', 400)
  u.status = 'active'
  await save()
  return publicUser(u)
}

export async function deleteUser(id, actorId) {
  const u = findUser(id)
  if (!u) return null
  if (id === actorId) throw new UserError('Impossible de supprimer votre propre compte.', 400)
  if (u.role === 'admin') throw new UserError('Un administrateur ne peut pas être supprimé via cette API.', 400)
  users = users.filter((x) => x.id !== id)
  await save()
  return { ok: true }
}

await load()
