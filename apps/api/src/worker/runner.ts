import { backoffSeconds, claim, extend, finish, LEASE_SECONDS, MAX_ATTEMPTS, type Claimed, type Outcome } from './queue.js'
import { withTenant } from './tenant.js'
import { Defer, PermanentFailure, Quarantine, RetryLater, type QueueSource, type WorkerContext, type WorkerDeps } from './types.js'

const HANDLER_TIMEOUT_MS = 90_000

function failureCode(error: unknown): string {
  if (error instanceof PermanentFailure || error instanceof Quarantine) return error.code
  const raw = (error as { code?: unknown })?.code
  return typeof raw === 'string' && /^[0-9A-Za-z_-]{1,40}$/.test(raw) ? raw : 'unexpected'
}

export function createWorker(deps: WorkerDeps) {
  const log = deps.log ?? (entry => console.error(JSON.stringify(entry)))
  const fetchImpl = deps.fetch ?? fetch
  const leaseSeconds = deps.leaseSeconds ?? LEASE_SECONDS
  const timeoutMs = deps.handlerTimeoutMs ?? HANDLER_TIMEOUT_MS
  let beat: () => void = () => undefined

  async function execute({ item, leaseId }: Claimed): Promise<Outcome> {
    const handlers = deps.handlers.get(item.kind)
    let outcome: Outcome = 'done', error: string | null = null, delay = 0
    if (!handlers?.length) {
      // Un worker más antiguo que la API puede no conocer aún el tipo: espera sin gastar intentos.
      outcome = 'defer'; error = 'sin-manejador'; delay = 300
    } else {
      const abort = new AbortController()
      const renew = async () => {
        const ok = await extend(deps.pool, item.source, item.id, leaseId, leaseSeconds).catch(() => false)
        if (!ok) { abort.abort(new RetryLater(0, 'lease-perdido')) }
        return ok
      }
      // El lease se renueva mientras el manejador trabaja: nadie más lo reclama por tardar.
      const heartbeat = setInterval(() => { void renew() }, Math.max(1000, (leaseSeconds * 1000) / 3))
      const timer = setTimeout(() => abort.abort(new RetryLater(60, 'timeout')), timeoutMs)
      const context: WorkerContext = {
        item, pool: deps.pool, fetch: fetchImpl, now: () => new Date(), signal: abort.signal, extendLease: renew,
        tenant: fn => withTenant(deps.pool, item.restaurantId, fn),
        credentials: async () => {
          const { rows } = await deps.pool.query<{ ciphertext: string | null }>('SELECT llenamos.worker_integration_ciphertext($1) AS ciphertext', [item.restaurantId])
          return deps.openCredentials(item.restaurantId, rows[0]?.ciphertext ?? null)
        },
      }
      try {
        for (const handler of handlers) {
          // Se espera a que el manejador termine de verdad; si se agotó el tiempo, su señal ya está abortada.
          await handler(context)
          if (abort.signal.aborted) throw abort.signal.reason
        }
      } catch (caught) {
        const reason = abort.signal.aborted && !(caught instanceof PermanentFailure || caught instanceof Quarantine || caught instanceof Defer) ? abort.signal.reason : caught
        error = failureCode(reason)
        if (reason instanceof PermanentFailure) outcome = 'failed'
        else if (reason instanceof Quarantine) outcome = 'quarantined'
        else if (reason instanceof Defer) { outcome = 'defer'; delay = reason.seconds }
        else { outcome = 'retry'; delay = reason instanceof RetryLater && reason.seconds > 0 ? reason.seconds : backoffSeconds(item.attempts) }
        if (reason instanceof RetryLater && reason.message === 'lease-perdido') error = 'lease-perdido'
        else if (reason instanceof RetryLater && reason.message === 'timeout') error = 'timeout'
      } finally { clearInterval(heartbeat); clearTimeout(timer) }
    }
    const kept = await finish(deps.pool, item.source, item.id, leaseId, outcome, error, delay)
    // Nunca el contenido ni el destinatario: solo ids, tipo y código.
    log({ level: outcome === 'done' ? 'info' : 'warn', event: 'worker_item', source: item.source, id: item.id, kind: item.kind, restaurantId: item.restaurantId, attempt: item.attempts, outcome, ...(error ? { errorCode: error } : {}), ...(kept ? {} : { leaseLost: true }) })
    return outcome
  }

  async function run(claimed: Claimed[]) {
    for (const next of claimed) {
      try { await execute(next) }
      catch (error) { log({ level: 'error', event: 'worker_item_crashed', id: next.item.id, kind: next.item.kind, errorCode: failureCode(error) }) }
    }
  }
  /** Reclama como mucho `limit` elementos (outbox primero, luego jobs) con los carriles indicados. */
  async function claimUpTo(limit: number): Promise<Claimed[]> {
    const claimed = await claim(deps.pool, 'outbox', limit, leaseSeconds)
    if (claimed.length < limit) claimed.push(...await claim(deps.pool, 'jobs', limit - claimed.length, leaseSeconds))
    return claimed
  }

  /** Una pasada (pruebas y tareas puntuales): nunca reclama más elementos que carriles. */
  async function runOnce(concurrency = 4): Promise<number> {
    const claimed = await claimUpTo(concurrency)
    await Promise.all(claimed.map(item => run([item])))
    return claimed.length
  }

  /** Cada carril reclama de uno en uno: ningún elemento espera con el lease corriendo detrás de otro. */
  function start({ pollMs = 2000, concurrency = 4 } = {}) {
    let stopping = false
    const lane = async () => {
      while (!stopping) {
        let claimed: Claimed[] = []
        try { claimed = await claimUpTo(1); beat() }
        catch (error) { log({ level: 'error', event: 'worker_poll_failed', errorCode: failureCode(error) }) }
        if (claimed.length) await run(claimed)
        else if (!stopping) await new Promise(resolve => setTimeout(resolve, pollMs))
      }
    }
    const lanes = Array.from({ length: concurrency }, lane)
    return { stop: async () => { stopping = true; await Promise.all(lanes) } }
  }
  return { runOnce, start, maxAttempts: MAX_ATTEMPTS, onBeat: (fn: () => void) => { beat = fn } }
}
export type Worker = ReturnType<typeof createWorker>
