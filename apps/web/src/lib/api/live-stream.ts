/**
 * Cliente SSE por `fetch` para las lecturas en vivo del VPS. El token va siempre en la cabecera
 * `Authorization` (nunca en la URL), con reconexión de espera creciente y `Last-Event-ID`.
 * Es lógica pura, sin React: la usa `useLiveQuery` y se prueba con un `fetch` falso.
 */
import { API_ERROR_CODES, ApiCallError, type ApiErrorCode } from "./transport"

export const LIVE_BACKOFF_MS = { base: 1000, max: 30_000 } as const
/** Con estos códigos reintentar no arregla nada: se enseña el error en vez de reconectar. */
const DEFINITIVE = new Set<ApiErrorCode>(["invalid-argument", "permission-denied", "unauthenticated", "failed-precondition", "not-found", "not-deployed", "config"])

export interface LiveStreamOptions {
  name: string
  input: unknown
  getToken: () => Promise<string>
  signal: AbortSignal
  onSnapshot: (data: unknown) => void
  /** Error definitivo: el flujo se detiene. Los cortes de red se reintentan sin avisar. */
  onFatal: (error: ApiCallError) => void
  onConnectionChange?: (connected: boolean) => void
  fetcher?: typeof fetch
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  random?: () => number
  /** Sin bytes (ni latidos) durante este tiempo se da la conexión por muerta. */
  silenceMs?: number
}

export function livePath(name: string): string {
  if (!/^[A-Za-z][A-Za-z0-9]{0,127}$/.test(name)) throw new ApiCallError("invalid-argument", "El nombre de la lectura en vivo no es válido.")
  return `/api/v1/live/${name}`
}
function code(value: unknown): ApiErrorCode {
  const normal = typeof value === "string" ? value.toLowerCase().replace(/_/g, "-") : ""
  return (API_ERROR_CODES as readonly string[]).includes(normal) ? normal as ApiErrorCode : "unknown"
}
function fallback(status: number): ApiErrorCode {
  return ({ 400: "invalid-argument", 401: "unauthenticated", 403: "permission-denied", 404: "not-deployed", 412: "failed-precondition", 429: "resource-exhausted" } as Record<number, ApiErrorCode>)[status] ?? "unavailable"
}
export function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(done, ms)
    function done() { clearTimeout(timer); signal.removeEventListener("abort", done); resolve() }
    signal.addEventListener("abort", done, { once: true })
  })
}
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const raw = Math.min(LIVE_BACKOFF_MS.max, LIVE_BACKOFF_MS.base * 2 ** Math.max(0, attempt - 1))
  return Math.round(raw * (0.75 + random() * 0.5))
}

interface Frame { id?: string; event: string; data: string }
/** Trocea el flujo en tramas SSE aunque lleguen partidas por cualquier byte. */
export function createFrameParser(onFrame: (frame: Frame) => void): (chunk: string) => void {
  let buffer = ""
  return chunk => {
    buffer += chunk
    for (;;) {
      const match = /\r?\n\r?\n/.exec(buffer)
      if (!match) return
      const block = buffer.slice(0, match.index)
      buffer = buffer.slice(match.index + match[0].length)
      const frame: Frame = { event: "message", data: "" }
      let any = false
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith(":")) continue
        const at = line.indexOf(":")
        const field = at < 0 ? line : line.slice(0, at)
        const value = at < 0 ? "" : line.slice(at + 1).replace(/^ /, "")
        if (field === "id") frame.id = value
        else if (field === "event") frame.event = value
        else if (field === "data") frame.data += (frame.data ? "\n" : "") + value
        else continue
        any = true
      }
      if (any) onFrame(frame)
    }
  }
}

export async function runLiveStream(options: LiveStreamOptions): Promise<void> {
  const { signal } = options
  const fetcher = options.fetcher ?? fetch
  const sleep = options.sleep ?? defaultSleep
  let lastEventId: string | null = null
  let failures = 0
  let received = false
  const path = livePath(options.name)
  while (!signal.aborted) {
    received = false
    try {
      await connect()
      failures = 0
      // El servidor cierra con `end` al renovar o apagarse: se vuelve enseguida, sin castigo.
      await sleep(250, signal)
    } catch (error) {
      if (signal.aborted) return
      if (error instanceof ApiCallError && (DEFINITIVE.has(error.code) || error.fatal)) { options.onConnectionChange?.(false); options.onFatal(error); return }
      options.onConnectionChange?.(false)
      failures = received ? 1 : failures + 1
      await sleep(backoffDelay(failures, options.random), signal)
    }
  }

  async function connect(): Promise<void> {
    const connection = new AbortController()
    const stop = () => connection.abort()
    signal.addEventListener("abort", stop, { once: true })
    let watchdog: ReturnType<typeof setTimeout> | undefined
    const rearm = () => {
      clearTimeout(watchdog)
      watchdog = setTimeout(() => connection.abort(), options.silenceMs ?? 45_000)
    }
    try {
      let token: string
      try { token = await options.getToken() } catch { throw new ApiCallError("unauthenticated", "Tu sesión ha caducado. Vuelve a entrar.") }
      if (!token || /[\r\n]/.test(token)) throw new ApiCallError("unauthenticated", "Inicia sesión para continuar.")
      if (signal.aborted) return
      const headers: Record<string, string> = { "Content-Type": "application/json", Authorization: `Bearer ${token}`, Accept: "text/event-stream" }
      if (lastEventId !== null) headers["Last-Event-ID"] = lastEventId
      rearm()
      let response: Response
      try {
        response = await fetcher(path, { method: "POST", headers, body: JSON.stringify({ data: options.input }), signal: connection.signal, credentials: "omit", cache: "no-store", redirect: "error" })
      } catch { throw new ApiCallError("network", "No hay conexión con el servidor.") }
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: { code?: unknown } } | null
        const found = body?.error ? code(body.error.code) : fallback(response.status)
        throw new ApiCallError(found === "unknown" ? fallback(response.status) : found, found === "permission-denied" ? "No tienes acceso a estos datos." : "No se pueden recibir los cambios en directo ahora mismo.")
      }
      if (!response.body) throw new ApiCallError("network", "La conexión en directo no devuelve datos.")
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let ended = false
      let failure: ApiCallError | null = null
      const parse = createFrameParser(frame => {
        received = true
        if (frame.id !== undefined && /^\d{1,20}$/.test(frame.id)) lastEventId = frame.id
        if (frame.event === "snapshot") {
          let data: unknown
          try { data = JSON.parse(frame.data) } catch { failure ??= new ApiCallError("internal", "La respuesta en directo no es válida."); return }
          options.onConnectionChange?.(true)
          options.onSnapshot(data)
        } else if (frame.event === "ready") options.onConnectionChange?.(true)
        else if (frame.event === "end") ended = true
        else if (frame.event === "error") {
          let body: { code?: unknown; fatal?: unknown } = {}
          try { body = JSON.parse(frame.data) as typeof body } catch { /* sin detalle */ }
          failure ??= new ApiCallError(code(body.code) === "unknown" ? "unavailable" : code(body.code), "Se ha interrumpido la conexión en directo.", undefined, body.fatal === true)
        }
      })
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          rearm()
          parse(decoder.decode(value, { stream: true }))
          if (failure) throw failure
        }
      } catch (error) {
        if (error instanceof ApiCallError) throw error
        if (signal.aborted) return
        throw new ApiCallError("network", "Se ha cortado la conexión en directo.")
      } finally { void reader.cancel().catch(() => undefined) }
      if (!ended && !signal.aborted) throw new ApiCallError("network", "Se ha cortado la conexión en directo.")
    } finally {
      clearTimeout(watchdog)
      signal.removeEventListener("abort", stop)
      connection.abort()
    }
  }
}
