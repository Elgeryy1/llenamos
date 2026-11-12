// IDENTIDAD DE ENSAYO. No es Firebase Auth ni debe llegar a producción: firma ID tokens RS256 con una clave local para que
// el ensayo del VPS funcione sin nube. Solo dependencias de Node. La API solo la acepta con NODE_ENV=rehearsal.
import { createServer } from 'node:http'
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, scryptSync, sign, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

const projectId = process.env.REHEARSAL_PROJECT_ID ?? 'llenamos-ensayo'
// Misma regla que la API: jamás firmar tokens para un proyecto que no sea de ensayo.
if (!/^[a-z][a-z0-9-]*-ensayo$/.test(projectId) || projectId === 'llenamos-logiqd') throw new Error('REHEARSAL_PROJECT_ID debe terminar en -ensayo y no ser el de producción.')
const secret = readFileSync(process.env.REHEARSAL_ADMIN_SECRET_FILE ?? '/run/secrets/rehearsal_identity_secret', 'utf8').trim()
const stateFile = process.env.REHEARSAL_STATE_FILE ?? '/state/identity.json'
if (!/^[a-f0-9]{48}$/.test(secret)) throw new Error('El secreto debe ser hexadecimal de 24 bytes (el mismo formato que exige la API)')

let state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : null
if (!state) {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  state = { privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }), users: {} }
}
const privateKey = createPrivateKey(state.privatePem)
const jwk = createPublicKey(privateKey).export({ format: 'jwk' })
jwk.kid = createHash('sha256').update(JSON.stringify([jwk.n, jwk.e])).digest('hex').slice(0, 16)
jwk.alg = 'RS256'; jwk.use = 'sig'
const persist = () => { writeFileSync(`${stateFile}.tmp`, JSON.stringify(state), { mode: 0o600 }); renameSync(`${stateFile}.tmp`, stateFile) }
persist()

const b64 = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url')
function idToken(user) {
  const now = Math.floor(Date.now() / 1000)
  const body = { iss: `https://identity.ensayo.invalid/${projectId}`, aud: projectId, sub: user.uid, iat: now, auth_time: now, exp: now + 3600,
    email: user.email, email_verified: true, ...(user.claims.sessionVersion ? { sessionVersion: user.claims.sessionVersion } : {}), ...(user.claims.logiqd === true ? { logiqd: true } : {}) }
  const head = b64({ alg: 'RS256', typ: 'JWT', kid: jwk.kid })
  const signed = `${head}.${b64(body)}`
  return `${signed}.${sign('RSA-SHA256', Buffer.from(signed), privateKey).toString('base64url')}`
}
const hash = (password, salt) => scryptSync(password, salt, 32).toString('hex')
const publicUser = user => ({ uid: user.uid, email: user.email, disabled: user.disabled, claims: user.claims })
const byEmail = email => Object.values(state.users).find(user => user.email === email.toLowerCase())
function authorized(req) {
  const given = Buffer.from(req.headers.authorization ?? ''), wanted = Buffer.from(`Bearer ${secret}`)
  return given.length === wanted.length && timingSafeEqual(given, wanted)
}
async function body(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) { size += chunk.length; if (size > 16384) throw Object.assign(new Error('grande'), { status: 413 }); chunks.push(chunk) }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
}
// Freno de /login por ventana de un minuto (global y por correo): el ensayo no necesita más y la fuerza bruta no avanza.
const attempts = new Map()
function throttled(key, limit) {
  const now = Date.now(), entry = attempts.get(key)
  if (!entry || now - entry.since > 60_000) {
    attempts.set(key, { since: now, count: 1 })
    // Limpieza de ventanas caducadas; nunca se borra el contador global ni el de un correo en plena ventana.
    if (attempts.size > 5000) for (const [k, v] of attempts) if (k !== '*' && now - v.since > 60_000) attempts.delete(k)
    return false
  }
  return ++entry.count > limit
}
const DUMMY_SALT = randomBytes(16).toString('hex'), DUMMY_HASH = hash('sin-usuario', DUMMY_SALT)
function setPassword(user, password) { const salt = randomBytes(16).toString('hex'); user.password = { salt, hash: hash(password, salt) } }

const server = createServer(async (req, res) => {
  const reply = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)) }
  try {
    const path = new URL(req.url ?? '/', 'http://identity.invalid').pathname
    if (req.method === 'GET' && path === '/healthz') return reply(200, { status: 'ok' })
    if (req.method === 'GET' && path === '/jwks.json') return reply(200, { keys: [jwk] })
    if (req.method === 'POST' && path === '/login') {
      const { email, password } = await body(req)
      if (typeof email !== 'string' || typeof password !== 'string') return reply(401, { error: 'credenciales' })
      if (throttled('*', 120) || throttled(email.toLowerCase(), 10)) return reply(429, { error: 'demasiados intentos' })
      const user = byEmail(email)
      // Siempre se calcula el hash (con uno de relleno si no hay cuenta): el tiempo no revela qué correos existen.
      const expected = Buffer.from(user?.password ? user.password.hash : DUMMY_HASH)
      const given = Buffer.from(hash(password, user?.password ? user.password.salt : DUMMY_SALT))
      if (!user || user.disabled || !user.password || !timingSafeEqual(given, expected)) return reply(401, { error: 'credenciales' })
      return reply(200, { uid: user.uid, idToken: idToken(user) })
    }
    if (!path.startsWith('/admin/')) return reply(404, { error: 'no existe' })
    if (!authorized(req)) return reply(401, { error: 'no autorizado' })
    if (req.method === 'POST' && path === '/admin/resolve') {
      const { email, displayName } = await body(req)
      if (typeof email !== 'string') return reply(400, { error: 'petición no válida' })
      let user = byEmail(email)
      if (!user) { user = { uid: randomBytes(14).toString('hex'), email: email.toLowerCase(), displayName, disabled: false, claims: {}, tokensValidAfter: 0 }; state.users[user.uid] = user; persist() }
      return reply(200, publicUser(user))
    }
    const account = /^\/admin\/account\/([A-Za-z0-9_-]+)$/.exec(path)
    if (req.method === 'GET' && account) { const user = state.users[account[1]]; return user ? reply(200, publicUser(user)) : reply(404, { error: 'no existe' }) }
    if (req.method === 'POST' && path === '/admin/prove') {
      const { uid, email, password, version } = await body(req)
      const user = state.users[uid]
      if (!user || user.email !== email) return reply(404, { error: 'no existe' })
      setPassword(user, password)
      user.claims = { ...user.claims, sessionVersion: version }
      user.tokensValidAfter = Math.floor(Date.now() / 1000) * 1000 // como Firebase: resolución de segundos
      persist()
      return reply(200, { tokensValidAfter: user.tokensValidAfter })
    }
    // Operador de plataforma de pruebas: el equivalente a asignar el claim `logiqd` en Auth. Se acompaña de la fila SQL del operador.
    if (req.method === 'POST' && path === '/admin/operator') {
      const { uid, email, password, sessionVersion } = await body(req)
      if (typeof uid !== 'string' || typeof email !== 'string' || typeof password !== 'string') return reply(400, { error: 'petición no válida' })
      // No se pisa una cuenta ajena: solo se repite el alta del mismo operador (mismo correo).
      const existing = state.users[uid]
      if (existing && (existing.email !== email.toLowerCase() || existing.claims?.logiqd !== true)) return reply(409, { error: 'la cuenta ya existe' })
      const user = { uid, email: email.toLowerCase(), displayName: 'Operador', disabled: false, claims: { logiqd: true, sessionVersion }, tokensValidAfter: 0 }
      setPassword(user, password); state.users[uid] = user; persist()
      return reply(200, publicUser(user))
    }
    return reply(404, { error: 'no existe' })
  } catch (error) { reply(error?.status ?? 400, { error: 'petición no válida' }) }
})
server.listen(Number(process.env.PORT ?? 9102), '0.0.0.0')
