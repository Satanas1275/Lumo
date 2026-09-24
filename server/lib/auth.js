import { verifyToken } from './users.js'

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null
  const user = token ? verifyToken(token) : null
  if (!user || user.status !== 'active') {
    return res.status(401).json({ error: 'Authentification requise.' })
  }
  req.user = user
  next()
}

export function requireAdmin(req, res, next) {
  requireAuth(req, res, (err) => {
    if (err) return next(err)
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Accès réservé aux administrateurs.' })
    }
    next()
  })
}