import { verifyToken } from './users.js'

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null
  const user = token ? verifyToken(token) : null
  if (!user) return res.status(401).json({ error: 'Authentification requise.' })
  req.user = user
  next()
}
