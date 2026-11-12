/** Transporte de operaciones del VPS. No selecciona ni utiliza ningún backend alternativo. */
import { FirebaseConfigError } from "@/lib/firebase/config-error"
export const API_ERROR_CODES = [
  "invalid-argument", "failed-precondition", "not-found", "permission-denied", "resource-exhausted",
  "aborted", "unavailable", "internal", "deadline-exceeded", "unauthenticated", "already-exists",
  "cancelled", "unknown", "not-deployed", "network", "config",
] as const
export type ApiErrorCode = (typeof API_ERROR_CODES)[number]
export class ApiCallError extends Error {
  /** `fatal`: reintentar no arregla nada (p. ej. una lectura en vivo demasiado grande). */
  constructor(readonly code: ApiErrorCode, message: string, readonly requestId?: string, readonly fatal = false) {
    super(message)
    this.name = "ApiCallError"
  }
}

export interface OperationOptions {
  authentication: "required" | "none"
  fetcher?: typeof fetch
  getToken?: () => Promise<string>
  signal?: AbortSignal
  timeoutMs?: number
}

const privateRequests = new Set<AbortController>()
/** Al salir o cambiar de cuenta, ninguna petición de la identidad anterior continúa. */
export function cancelIdentityRequests(): void {
  for (const controller of privateRequests) controller.abort()
  privateRequests.clear()
}

/** Las conexiones en vivo (SSE) se cancelan igual que las peticiones privadas al cambiar de cuenta. */
export function trackIdentityRequest(controller: AbortController): () => void {
  privateRequests.add(controller)
  return () => { privateRequests.delete(controller) }
}

/** Ruta fija same-origin; el proxy elimina /api antes de llegar al servidor. */
export function operationPath(name: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(name)) throw new ApiCallError("invalid-argument", "El nombre de la operación no es válido.")
  return `/api/v1/operations/${name}`
}

function serverCode(value: unknown): ApiErrorCode {
  if (typeof value !== "string") return "unknown"
  const code = value.toLowerCase().replace(/_/g, "-")
  return (API_ERROR_CODES as readonly string[]).includes(code) ? code as ApiErrorCode : "unknown"
}
function fallbackCode(status: number): ApiErrorCode {
  return ({ 400: "invalid-argument", 401: "unauthenticated", 403: "permission-denied", 404: "not-deployed", 409: "aborted", 429: "resource-exhausted" } as Record<number, ApiErrorCode>)[status] ?? (status >= 500 ? "unavailable" : "unknown")
}
function aborted(): DOMException { return new DOMException("Se ha cancelado la operación.", "AbortError") }

/** Permite cancelar la espera del refresco del token, sin enviar luego la petición caducada. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(aborted())
    signal.addEventListener("abort", onAbort, { once: true })
    if (signal.aborted) onAbort()
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort)).catch(() => undefined)
  })
}

export async function postOperation(name: string, data: unknown, options: OperationOptions): Promise<unknown> {
  return requestApi(operationPath(name), { method: "POST", data, envelope: true }, options)
}

/** Solo rutas de lectura del contrato; nunca acepta URL, query ni fragmento externos. */
export async function getIdentityResource(path: string, options: Omit<OperationOptions, "authentication"> = {}): Promise<unknown> {
  if (path !== "/api/v1/session" && !/^\/api\/v1\/restaurants\/[A-Za-z0-9_-]{1,128}\/context$/.test(path)) {
    throw new ApiCallError("invalid-argument", "La ruta de la API no es válida.")
  }
  return requestApi(path, { method: "GET", envelope: false }, { ...options, authentication: "required" })
}

async function requestApi(path: string, request: { method: "POST" | "GET"; data?: unknown; envelope: boolean }, options: OperationOptions): Promise<unknown> {
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  if (options.signal?.aborted) throw aborted()
  if (options.authentication === "required") privateRequests.add(controller)
  options.signal?.addEventListener("abort", onAbort, { once: true })
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, options.timeoutMs ?? 20_000)
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" }
    if (options.authentication === "required") {
      let token: string
      try {
        const getToken = options.getToken ?? (async () => (await import("@/lib/firebase/auth-client")).identityToken())
        token = await untilAborted(getToken(), controller.signal)
      } catch (error) {
        if (controller.signal.aborted) throw error
        if (error instanceof FirebaseConfigError) throw new ApiCallError("config", error.problems.join(" "))
        throw new ApiCallError("unauthenticated", "Tu sesión ha caducado. Vuelve a entrar.")
      }
      if (!token || /[\r\n]/.test(token)) throw new ApiCallError("unauthenticated", "Inicia sesión para continuar.")
      headers.Authorization = `Bearer ${token}`
    }
    if (controller.signal.aborted) throw aborted()
    const response = await untilAborted((options.fetcher ?? fetch)(path, {
      method: request.method, headers, ...(request.method === "POST" ? { body: JSON.stringify({ data: request.data }) } : {}), signal: controller.signal,
      credentials: "omit", cache: "no-store", redirect: "error",
    }), controller.signal)
    const body: unknown = await untilAborted(response.json().catch(() => null), controller.signal)
    const envelope = body && typeof body === "object" ? body as { result?: unknown; error?: { code?: unknown; status?: unknown; message?: unknown; requestId?: unknown }; requestId?: unknown } : null
    if (!response.ok || envelope?.error) {
      const code = envelope?.error ? serverCode(envelope.error.code ?? envelope.error.status) : fallbackCode(response.status)
      const message = code === "internal" || code === "unknown" ? "No se ha podido completar la operación." : typeof envelope?.error?.message === "string" ? envelope.error.message : response.status === 404 ? "Esta operación todavía no está disponible en el servidor del VPS." : "El servidor no puede completar la operación ahora mismo."
      const correlation = envelope?.error?.requestId ?? envelope?.requestId
      const requestId = typeof correlation === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(correlation) ? correlation : undefined
      throw new ApiCallError(code, message, requestId)
    }
    if (controller.signal.aborted) throw aborted()
    if (!request.envelope) return body
    if (!envelope || !("result" in envelope)) throw new ApiCallError("internal", "La respuesta del servidor no es válida.")
    return envelope.result
  } catch (error) {
    if (options.signal?.aborted) throw aborted()
    if (timedOut) throw new ApiCallError("deadline-exceeded", "El servidor ha tardado demasiado en responder.")
    if (controller.signal.aborted) throw aborted()
    if (error instanceof ApiCallError) throw error
    throw new ApiCallError("network", "No hay conexión con el servidor.")
  } finally {
    clearTimeout(timer)
    privateRequests.delete(controller)
    options.signal?.removeEventListener("abort", onAbort)
  }
}
