// Puente local sin dependencias. No expone puertos ni recibe comandos de páginas web.
import { createConnection } from 'node:net'
import { createHash } from 'node:crypto'
import { open, readFile, rename, mkdir, readdir, unlink, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as pause } from 'node:timers/promises'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const idPattern = /^[a-f0-9]{64}$/
export function validateConfig(c) {
  for (const key of ['restaurantId', 'locationId', 'bridgeId']) if (typeof c[key] !== 'string' || !/^[^/]{1,128}$/.test(c[key])) throw new Error('Revisa los identificadores del archivo de configuración.')
  if (!/^[A-Za-z0-9_-]{43}$/.test(c.token)) throw new Error('Falta una credencial válida del puente.')
  const base = new URL(c.functionsUrl)
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)
  if (base.username || base.password || base.search || base.hash || base.protocol !== 'https:' && !(loopback && base.protocol === 'http:' && base.pathname === '/demo-llenamos/europe-west1')) throw new Error('Usa HTTPS o los emuladores locales de demo-llenamos.')
  if (!c.printers || typeof c.printers !== 'object' || Array.isArray(c.printers)) throw new Error('Falta el mapa local de impresoras.')
  const localTest = loopback && base.protocol === 'http:' && base.pathname === '/demo-llenamos/europe-west1'
  for (const [id, p] of Object.entries(c.printers)) {
    if (!/^[^/]{1,128}$/.test(id) || !p || typeof p.host !== 'string' || !p.host.length || /[\s/]/.test(p.host) || !(p.port === 9100 || localTest && ['localhost', '127.0.0.1', '127.0.0.2', '::1'].includes(p.host) && p.port === 9515)) throw new Error('Cada impresora necesita host local y puerto TCP 9100.')
  }
  return c
}
/** Éxito solo con cierre remoto limpio. Una escritura incierta nunca se reenvía. */
export async function sendTcp(printer, payload, timeoutMs = 4000) {
  return new Promise(resolveResult => {
    let attempted = false, remoteEnded = false, done = false
    const socket = createConnection({ host: printer.host, port: printer.port })
    const finish = (status, error) => {
      if (done) return
      done = true; socket.destroy(); resolveResult({ status, error })
    }
    socket.setTimeout(timeoutMs)
    socket.on('connect', () => { attempted = true; socket.end(payload) })
    socket.on('end', () => { remoteEnded = true })
    socket.on('close', hadError => finish(remoteEnded && !hadError ? 'printed' : attempted ? 'uncertain' : 'failed', remoteEnded && !hadError ? null : attempted ? 'Conexión cerrada sin confirmación del envío.' : 'No se pudo conectar con la impresora.'))
    socket.on('error', () => finish(attempted ? 'uncertain' : 'failed', attempted ? 'Conexión interrumpida durante el envío.' : 'No se pudo conectar con la impresora.'))
    socket.on('timeout', () => finish(attempted ? 'uncertain' : 'failed', 'La impresora no respondió dentro del plazo.'))
  })
}
export async function durableWrite(path, value) {
  const temp = `${path}.tmp`, file = await open(temp, 'w', 0o600)
  try { await file.writeFile(JSON.stringify(value)); await file.sync() } finally { await file.close() }
  await rename(temp, path)
  // fsync del directorio conserva también el rename ante un reinicio del sistema.
  if (process.platform !== 'win32') {
    const dir = await open(dirname(path), 'r')
    try { await dir.sync() } finally { await dir.close() }
  }
}
export async function callable(c, name, extra = {}) {
  const response = await fetch(`${c.functionsUrl}/${name}`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: { restaurantId: c.restaurantId, locationId: c.locationId, bridgeId: c.bridgeId, token: c.token, ...extra } }),
  })
  // Ningún error de proveedor se registra: podría contener credenciales reflejadas.
  if (!response.ok) throw new Error('El servidor no confirmó la operación del puente.')
  const body = await response.json()
  if (body.error || !body.result) throw new Error('Respuesta del servidor no válida.')
  return body.result
}
/** El diario se sincroniza ANTES del primer byte. Caer después se considera incierto. */
export async function handleJob(c, journal, job, api = callable, transport = sendTcp) {
  if (!idPattern.test(job.id) || !idPattern.test(job.payloadHash) || typeof job.printerId !== 'string' || typeof job.payloadBase64 !== 'string' || job.payloadBase64.length > 500_000 || !/^[A-Za-z0-9_-]{43}$/.test(job.leaseToken) || !Number.isSafeInteger(job.leaseUntil)) throw new Error('Trabajo rechazado por forma o tamaño.')
  const path = join(journal, `${job.id}.json`)
  let saved
  try { saved = JSON.parse(await readFile(path, 'utf8')) } catch (e) { if (e.code !== 'ENOENT') throw e }
  if (saved && saved.payloadHash !== job.payloadHash) throw new Error('El contenido del trabajo ha cambiado. Revisión manual necesaria.')
  if (!saved || saved.status === 'failed' && saved.leaseToken !== job.leaseToken) {
    const payload = Buffer.from(job.payloadBase64, 'base64'), printer = c.printers[job.printerId]
    saved = { id: job.id, payloadHash: job.payloadHash, leaseToken: job.leaseToken, status: 'sending', error: null }
    await durableWrite(path, saved)
    let result
    if (digest(payload) !== job.payloadHash || payload.toString('base64') !== job.payloadBase64) result = { status: 'failed', error: 'El hash o los bytes no coinciden.' }
    else if (!printer) result = { status: 'failed', error: 'Impresora sin dirección en este ordenador.' }
    else if (job.leaseUntil < Date.now() + 15_000) result = { status: 'failed', error: 'El lease no deja tiempo suficiente para enviar.' }
    else {
      try { result = await transport(printer, payload) }
      catch { result = { status: 'uncertain', error: 'El transporte terminó sin un resultado seguro.' } }
    }
    saved = { ...saved, ...result }
    await durableWrite(path, saved)
  } else if (saved.status === 'sending') {
    saved = { ...saved, status: 'uncertain', error: 'El ordenador se detuvo durante el envío. Revisa el papel.' }
    await durableWrite(path, saved)
  }
  await api(c, 'confirmarImpresion', { printJobId: job.id, leaseToken: saved.leaseToken, status: saved.status, error: saved.error })
  await durableWrite(path, { ...saved, acknowledged: true })
  return saved.status
}
export async function recover(c, journal, api = callable) {
  for (const filename of await readdir(journal)) {
    if (!/^[a-f0-9]{64}\.json$/.test(filename)) continue
    const path = join(journal, filename), saved = JSON.parse(await readFile(path, 'utf8'))
    if (saved.acknowledged) continue
    if (saved.status === 'sending') { saved.status = 'uncertain'; saved.error = 'El ordenador se detuvo durante el envío. Revisa el papel.'; await durableWrite(path, saved) }
    await api(c, 'confirmarImpresion', { printJobId: saved.id, leaseToken: saved.leaseToken, status: saved.status, error: saved.error })
    await durableWrite(path, { ...saved, acknowledged: true })
  }
}
export async function main(configPath, once = false) {
  const path = resolve(configPath), info = await stat(path)
  if (process.platform !== 'win32' && (info.mode & 0o077)) throw new Error('Protege la configuración con chmod 600 antes de arrancar.')
  const c = validateConfig(JSON.parse(await readFile(path, 'utf8')))
  const journal = resolve(dirname(path), c.journalDir ?? './diario')
  await mkdir(journal, { recursive: true, mode: 0o700 })
  const lockPath = join(journal, 'bridge.lock'), lock = await open(lockPath, 'wx', 0o600)
  await lock.writeFile(String(process.pid)); await lock.sync()
  let stopping = false
  const stop = () => { stopping = true }
  process.on('SIGTERM', stop); process.on('SIGINT', stop)
  try {
    do {
      try {
        await recover(c, journal)
        const { jobs } = await callable(c, 'reclamarImpresiones', { limit: 1 })
        if (!Array.isArray(jobs) || jobs.length > 1) throw new Error('Cola no válida.')
        for (const job of jobs) {
          const status = await handleJob(c, journal, job)
          console.log(`Trabajo ${job.id.slice(0, 8)}: ${status === 'printed' ? 'envío confirmado por el puente' : status === 'failed' ? 'fallido antes de enviar' : 'resultado incierto'}.`)
        }
      } catch {
        console.error('No se pudo completar el ciclo. Se conserva el diario sin reenviar bytes inciertos.')
        if (once) process.exitCode = 1
      }
      if (!once && !stopping) await pause(2000)
    } while (!once && !stopping)
  } finally {
    await lock.close(); await unlink(lockPath)
    process.off('SIGTERM', stop); process.off('SIGINT', stop)
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv[2] ?? './config.json', process.argv.includes('--once')).catch(() => { console.error('No se pudo iniciar el puente. Revisa el archivo protegido, los identificadores y el bloqueo del diario.'); process.exitCode = 1 })
}
