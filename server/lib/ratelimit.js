const buckets = new Map()

function cleanup(now) {
  if (buckets.size < 5000) return
  for (const [k, b] of buckets) {
    if (b.reset <= now) buckets.delete(k)
  }
}

/**
 * Limiteur de débit en mémoire. `key` (string) et `max` sont évalués par
 * requête : utile pour brider la force brute sur /api/auth/* .
 * Note : en Docker le point d'entrée voit l'IP du réseau interne ; la clé
 * inclut donc aussi le pseudo pour ne pas bloquer tout le monde d'un coup.
 */
export function rateLimit({ maxPerIdentity = 10, maxGlobal = 100, windowMs = 15 * 60 * 1000 }) {
  return (req, res, next) => {
    const now = Date.now()
    cleanup(now)

    const ip = req.ip || '0'
    const identity = req.body?.username ? `${ip}:${String(req.body.username).toLowerCase()}` : ip
    const globKey = `g:${ip}`

    const hit = (key, cap) => {
      let b = buckets.get(key)
      if (!b || b.reset <= now) {
        b = { count: 0, reset: now + windowMs }
        buckets.set(key, b)
      }
      b.count++
      if (b.count > cap) {
        res.setHeader('Retry-After', Math.ceil((b.reset - now) / 1000))
        res.status(429).json({ error: 'Trop de tentatives. Réessayez dans quelques minutes.' })
        return true
      }
      return false
    }

    if (hit(identity, maxPerIdentity)) return
    if (hit(globKey, maxGlobal)) return

    next()
  }
}