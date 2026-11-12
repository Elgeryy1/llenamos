import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { bearer, type IdentityToken } from '../auth.js'
import { requireLocation, requireMember } from '../access.js'
import { withIdentity } from '../database.js'
import { ApiError, unauthorized } from '../errors.js'
import { jsonBody } from '../http.js'
import type { LiveQuery, ModuleDefinition } from '../modules/types.js'
import { EventWake } from './wake.js'

export interface LiveOptions {
  /** Conexión dedicada para LISTEN; sin ella solo hay sondeo. */
  listenUrl?: string
  pollMs?: number
  heartbeatMs?: number
  /** El token de Firebase dura 1 h: se cierra antes y el cliente renueva y reconecta. */
  maxLifetimeMs?: number
  maxPerIdentity?: number
  maxPerRestaurant?: number
  maxTotal?: number
  /** Aperturas y vueltas que pueden usar la base a la vez; el resto del pool queda para las operaciones. */
  maxConcurrentDb?: number
  /** Con LISTEN sano, cada cuánto se relee de todos modos (revocaciones, eventos perdidos). */
  backupPollMs?: number
  /** Los despertares masivos se reparten en este margen aleatorio. */
  wakeJitterMs?: number
  /** Una transacción abierta que retiene eventos más de esto se registra como retraso del horizonte. */
  lagWarnMs?: number
  maxSnapshotBytes?: number
  /** Sustituye `refreshMs` de las lecturas (pruebas). */
  refreshMs?: number
}
const envelope = z.strictObject({ data: z.unknown() }).refine(value => Object.hasOwn(value, 'data'))
const topicPattern = /^[a-z][a-z0-9_.-]*(?:\.\*)?$/

/** Registro cerrado de lecturas en vivo declaradas por los módulos. */
export function liveRegistry(modules: readonly ModuleDefinition[]): ReadonlyMap<string, LiveQuery> {
  const registry = new Map<string, LiveQuery>()
  for (const module of modules) for (const query of module.liveQueries ?? []) {
    if (registry.has(query.name)) throw new Error(`Lectura en vivo duplicada: ${query.name} (${module.name})`)
    registry.set(query.name, query)
  }
  return registry
}
function splitTopics(query: LiveQuery, input: unknown): { exact: string[]; prefix: string[] } {
  const topics = query.topics(input)
  if (!topics.length || topics.length > 20 || topics.some(topic => !topicPattern.test(topic))) throw new Error(`Temas no válidos en ${query.name}`)
  return { exact: topics.filter(topic => !topic.endsWith('.*')), prefix: topics.filter(topic => topic.endsWith('.*')).map(topic => `${topic.slice(0, -1)}%`) }
}
interface Scan { horizon: bigint; changed: boolean; lagSeconds: number | null }
/**
 * Una sola lectura: horizonte (todo `tx` menor ya está cerrado), si hay eventos relevantes desde el
 * cursor y cuánto lleva retenido el evento confirmado más antiguo que el horizonte aún no deja entregar
 * (una transacción vieja abierta). Usa EXISTS, no un recorrido: un `Last-Event-ID` manipulado no puede
 * recorrer el historial.
 */
async function scan(client: PoolClient, rid: string, from: bigint | null, topics: { exact: string[]; prefix: string[] }, lagWarnMs: number): Promise<Scan> {
  const { rows } = await client.query<{ h: string; changed: boolean; lag: number | null }>(`WITH h AS (SELECT pg_snapshot_xmin(pg_current_snapshot()) AS x)
    SELECT h.x::text AS h,
      ($2::text IS NOT NULL AND EXISTS(SELECT 1 FROM llenamos.events e WHERE e.restaurant_id=$1 AND e.tx>=$2::text::xid8 AND e.tx<h.x AND (e.topic=ANY($3::text[]) OR e.topic LIKE ANY($4::text[])))) AS changed,
      (SELECT extract(epoch FROM now()-min(e.occurred_at))::float8 FROM llenamos.events e WHERE e.restaurant_id=$1 AND e.tx>=h.x AND e.occurred_at<now()-make_interval(secs=>$5::float8/1000)) AS lag
    FROM h`, [rid, from === null ? null : from.toString(), topics.exact, topics.prefix, lagWarnMs])
  const row = rows[0]!
  return { horizon: BigInt(row.h), changed: row.changed, lagSeconds: row.lag }
}

/** Semáforo con cola: la base nunca atiende más de N aperturas o vueltas en vivo a la vez. */
class Gate {
  private active = 0
  private readonly queue: Array<() => void> = []
  constructor(private readonly max: number) {}
  async acquire(timeoutMs: number): Promise<void> {
    if (this.active < this.max) { this.active += 1; return }
    await new Promise<void>((resolve, reject) => {
      const entry = () => { clearTimeout(timer); resolve() }
      const timer = setTimeout(() => { const at = this.queue.indexOf(entry); if (at >= 0) this.queue.splice(at, 1); reject(new ApiError(503, 'unavailable', 'El servidor está ocupado. Reintenta en unos segundos.')) }, timeoutMs)
      this.queue.push(entry)
    })
  }
  release(): void { const next = this.queue.shift(); if (next) next(); else this.active -= 1 }
  async run<T>(work: () => Promise<T>, timeoutMs = 10_000): Promise<T> {
    await this.acquire(timeoutMs)
    try { return await work() } finally { this.release() }
  }
}

export interface LiveService {
  handle(req: IncomingMessage, res: ServerResponse, name: string): Promise<void>
  closeAll(): void
  stop(): Promise<void>
  readonly connections: number
}
export function createLiveService(pool: Pool, verify: (token: string) => Promise<IdentityToken>, modules: readonly ModuleDefinition[], options: LiveOptions = {}, log: (entry: object) => void = () => {}): LiveService {
  const registry = liveRegistry(modules)
  const pollMs = options.pollMs ?? 3000, backupPollMs = options.backupPollMs ?? 20_000, heartbeatMs = options.heartbeatMs ?? 15_000, lifetimeMs = options.maxLifetimeMs ?? 55 * 60_000
  const perIdentity = options.maxPerIdentity ?? 12, perRestaurant = options.maxPerRestaurant ?? 80, total = options.maxTotal ?? 200, maxBytes = options.maxSnapshotBytes ?? 1_048_576
  const jitterMs = options.wakeJitterMs ?? 250, lagWarnMs = options.lagWarnMs ?? 10_000
  const gate = new Gate(options.maxConcurrentDb ?? 3)
  const wake = new EventWake(options.listenUrl, log)
  wake.start()
  const open = new Set<() => void>()
  const byIdentity = new Map<string, number>(), byRestaurant = new Map<string, number>()
  // Cupos reservados antes de esperar nada: una ráfaga de aperturas no puede superar los límites.
  let pending = 0
  let lastLagLog = 0
  const bump = (map: Map<string, number>, key: string, by: 1 | -1) => { const next = (map.get(key) ?? 0) + by; if (next > 0) map.set(key, next); else map.delete(key) }
  // Retraso del horizonte: eventos ya confirmados que una transacción más antigua, aún abierta, no deja entregar.
  const noteLag = (seen: Scan) => {
    if (seen.lagSeconds === null || Date.now() - lastLagLog < 60_000) return
    lastLagLog = Date.now()
    log({ level: 'warn', event: 'live_horizon_lag', seconds: Math.round(seen.lagSeconds) })
  }

  async function handle(req: IncomingMessage, res: ServerResponse, name: string): Promise<void> {
    const found = registry.get(name)
    if (!found) throw new ApiError(404, 'not-deployed', 'Lectura en vivo no disponible.')
    const query: LiveQuery = found
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); throw new ApiError(405, 'method-not-allowed', 'Método no permitido.') }
    const token = await verify(bearer(req.headers.authorization))
    const body = envelope.safeParse(await jsonBody(req))
    if (!body.success) throw new ApiError(400, 'invalid-argument', 'La petición debe contener únicamente data.')
    const parsed = query.input.safeParse(body.data.data)
    if (!parsed.success) throw new ApiError(400, 'invalid-argument', 'Parámetros no válidos.')
    const input = parsed.data
    const rid = query.restaurantId(input)
    const locationId = query.locationId?.(input) ?? null
    const topics = splitTopics(query, input)
    // Un token a punto de caducar no abre un flujo largo: la vida es la menor de las dos.
    const remaining = token.exp === undefined ? Infinity : token.exp * 1000 - Date.now()
    if (remaining <= 0) throw unauthorized()
    const life = Math.min(lifetimeMs, remaining)
    const lastId = req.headers['last-event-id']
    // Un id que no cabe en un xid8 (o no es un número) se ignora: equivale a abrir de nuevo.
    const resume = typeof lastId === 'string' && /^\d{1,18}$/.test(lastId) ? BigInt(lastId) : null
    if (open.size + pending >= total || (byIdentity.get(token.uid) ?? 0) >= perIdentity || (byRestaurant.get(rid) ?? 0) >= perRestaurant)
      throw new ApiError(429, 'resource-exhausted', 'Demasiadas conexiones en vivo abiertas.')
    pending += 1; bump(byIdentity, token.uid, 1); bump(byRestaurant, rid, 1)
    let counted = true, released = false
    const settle = () => { if (counted) { counted = false; pending -= 1 } }
    const release = () => { settle(); if (!released) { released = true; bump(byIdentity, token.uid, -1); bump(byRestaurant, rid, -1) } }
    // Comprobaciones de cada vuelta: sesión (withIdentity), rol, plan y local asignado.
    const authorize = async (client: PoolClient, platform: boolean) => {
      if (platform) throw new ApiError(403, 'permission-denied', 'La plataforma no accede al interior de restaurantes.')
      await requireMember(client, token.uid, rid, query.roles)
      if (locationId !== null) await requireLocation(client, token.uid, rid, locationId)
    }
    let position: bigint
    let first: { snapshot: unknown } | null
    try {
      const opened = await gate.run(() => withIdentity(pool, token, rid, async (client, platform) => {
        await authorize(client, platform)
        const seen = await scan(client, rid, resume === null ? null : resume + 1n, topics, lagWarnMs)
        noteLag(seen)
        const start = seen.horizon - 1n
        // Al reanudar solo se relee si hubo eventos relevantes desde el último recibido. Un id futuro o
        // inventado no recorre nada: se trata como apertura nueva.
        if (resume !== null && resume <= start && !seen.changed) return { position: start, snapshot: null }
        return { position: start, snapshot: { snapshot: query.output.parse(await query.snapshot(client, input, { uid: token.uid })) } }
      }))
      position = opened.position
      first = opened.snapshot
    } catch (error) { release(); throw error }
    if (res.destroyed || req.socket.destroyed) { release(); return }

    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', Connection: 'keep-alive' })
    let closed = false, running = false, again = false
    let lastJson = JSON.stringify(first?.snapshot ?? null), lastRefresh = Date.now(), lastTick = Date.now()
    let wakeTimer: NodeJS.Timeout | undefined
    const timers: NodeJS.Timeout[] = []
    const write = (text: string): boolean => {
      if (closed) return false
      // Solo se corta a quien acumula varios mensajes sin leer; dos fotos grandes seguidas no son un cliente lento.
      if (res.writableLength > maxBytes * 4) { finish('slow'); return false }
      res.write(text)
      return true
    }
    const send = (event: string, id: bigint | null, data: unknown) => {
      const json = JSON.stringify(data)
      if (Buffer.byteLength(json) > maxBytes) { sendError(new ApiError(413, 'resource-exhausted', 'La lectura supera el tamaño permitido.'), true); return }
      write(`${id === null ? '' : `id: ${id}\n`}event: ${event}\ndata: ${json}\n\n`)
    }
    // Despertar por NOTIFY con variación aleatoria: un reinicio no hace que todos relean a la vez.
    const unsubscribe = wake.subscribe(rid, () => {
      if (closed || wakeTimer) return
      wakeTimer = setTimeout(() => { wakeTimer = undefined; void tick() }, Math.random() * jitterMs)
    })
    function finish(reason: string) {
      if (closed) return
      if (reason !== 'client') { try { res.write(`event: end\ndata: ${JSON.stringify({ reason })}\n\n`) } catch { /* conexión ya cerrada */ } }
      closed = true
      unsubscribe(); open.delete(close); release()
      clearTimeout(wakeTimer)
      for (const timer of timers) { clearInterval(timer); clearTimeout(timer) }
      if (!res.writableEnded) res.end()
    }
    function close() { finish('shutdown') }
    /** `fatal` avisa al cliente de que reintentar no sirve (p. ej. la foto es demasiado grande). */
    function sendError(error: unknown, fatal = false) {
      const known = error instanceof ApiError
      if (!known) log({ level: 'error', event: 'live_failed', errorCode: 'unexpected' })
      if (!closed) { try { res.write(`event: error\ndata: ${JSON.stringify({ code: known ? error.code : 'unavailable', message: known ? error.message : 'La lectura en vivo no está disponible.', ...(fatal ? { fatal: true } : {}) })}\n\n`) } catch { /* ya cerrada */ } }
      finish('error')
    }
    async function tick() {
      if (closed) return
      if (running) { again = true; return }
      running = true
      lastTick = Date.now()
      try {
        do {
          again = false
          // Cada vuelta vuelve a comprobar identidad, rol, plan y local: revocar cierra el flujo.
          const next = await gate.run(() => withIdentity(pool, token, rid, async (client, platform) => {
            await authorize(client, platform)
            const seen = await scan(client, rid, position + 1n, topics, lagWarnMs)
            noteLag(seen)
            const refreshMs = options.refreshMs ?? query.refreshMs
            const stale = refreshMs !== undefined && Date.now() - lastRefresh >= refreshMs
            // Aunque no haya eventos propios el cursor avanza al horizonte: la siguiente vuelta no reexamina lo ya visto.
            if (!seen.changed && !stale) return { horizon: seen.horizon, changed: false, stale: false, snapshot: undefined }
            return { horizon: seen.horizon, changed: seen.changed, stale, snapshot: query.output.parse(await query.snapshot(client, input, { uid: token.uid })) }
          }))
          if (closed) return
          if (next.horizon - 1n > position) position = next.horizon - 1n
          if (next.stale) lastRefresh = Date.now()
          if (next.snapshot !== undefined) {
            const json = JSON.stringify(next.snapshot)
            // Una relectura periódica sin cambios no molesta al cliente; un evento siempre se entrega.
            if (next.changed || json !== lastJson) { lastJson = json; send('snapshot', position, next.snapshot) }
          }
        } while (again && !closed)
      } catch (error) { sendError(error) } finally { running = false }
    }
    settle()
    open.add(close)
    res.on('close', () => finish('client'))
    res.on('error', () => finish('client'))
    res.write(`retry: 3000\n\n`)
    if (first) send('snapshot', position, first.snapshot); else write(`id: ${position}\nevent: ready\ndata: {}\n\n`)
    timers.push(
      setInterval(() => { if (!wake.healthy || Date.now() - lastTick >= backupPollMs) void tick() }, pollMs),
      setInterval(() => write(': ping\n\n'), heartbeatMs),
      setTimeout(() => finish('renew'), life))
    for (const timer of timers) timer.unref()
  }
  return {
    handle,
    closeAll() { for (const close of [...open]) close() },
    stop: () => wake.stop(),
    get connections() { return open.size },
  }
}
