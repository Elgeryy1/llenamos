/**
 * Llamadas a las callables públicas desde el navegador, con `fetch` y el protocolo de
 * las callables de Firebase (POST `{ data }` → `{ result }` o `{ error }`).
 *
 * La página pública no tiene sesión, así que no necesita el SDK de Firebase: con esto
 * pesa mucho menos y carga antes en el móvil. La entrada se valida con el esquema de
 * `@llenamos/core` antes de enviarla y la salida se valida al recibirla.
 */
import { CALLABLE_SCHEMAS, type CallableInput, type CallableOutput } from "@llenamos/core"
import type { z } from "zod"
import type { FirebaseSettings } from "@/lib/firebase/config"
import { dataBackend } from "@/lib/api/config"
import { ApiCallError, operationPath, postOperation } from "@/lib/api/transport"

export type PublicCallable =
  | "consultarDisponibilidad"
  | "crearReservaPublica"
  | "verReservaPublica"
  | "gestionarReservaPublica"
  | "apuntarseListaEspera"
  | "aceptarOfertaListaEspera"
  | "iniciarPagoSenal"
  | "darseDeBaja"

/** Códigos de error: los de Firebase y tres propios de la red. */
export type CallErrorCode =
  | "invalid-argument"
  | "failed-precondition"
  | "not-found"
  | "permission-denied"
  | "resource-exhausted"
  | "aborted"
  | "unavailable"
  | "internal"
  | "deadline-exceeded"
  | "unauthenticated"
  | "already-exists"
  | "cancelled"
  | "unknown"
  /** La función no existe en el servidor (sin desplegar o sin compilar). */
  | "not-deployed"
  /** Sin red o el servidor no contesta. */
  | "network"
  /** Firebase no está configurado en la web. */
  | "config"

export class PublicCallError extends Error {
  constructor(
    readonly code: CallErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "PublicCallError"
  }
}

export const CALL_TIMEOUT_MS = 20_000

export function callableUrl(settings: FirebaseSettings, name: string): string {
  if (dataBackend(settings) === "postgres") return operationPath(name)
  const projectId = settings.options.projectId ?? ""
  if (settings.emulators) {
    const { host, ports } = settings.emulators
    return `http://${host}:${ports.functions}/${projectId}/${settings.region}/${name}`
  }
  throw new PublicCallError("config", "El backend de datos Firebase solo está permitido en los emuladores de demostración.")
}

/** «FAILED_PRECONDITION» → «failed-precondition». */
function codeFromStatus(status: unknown): CallErrorCode {
  if (typeof status !== "string") return "unknown"
  return status.toLowerCase().replace(/_/g, "-") as CallErrorCode
}

export interface CallOptions {
  fetcher?: typeof fetch
  timeoutMs?: number
  signal?: AbortSignal
}

export async function callPublic<N extends PublicCallable>(
  settings: FirebaseSettings | null,
  name: N,
  input: CallableInput<N>,
  options: CallOptions = {},
): Promise<CallableOutput<N>> {
  const backend = dataBackend(settings)
  const schemas = CALLABLE_SCHEMAS[name]
  // Lanza ZodError si algo no encaja: el formulario ya lo ha validado antes.
  const data = (schemas.input as z.ZodType).parse(input)

  if (backend === "postgres") {
    try {
      const result = await postOperation(name, data, { authentication: "none", ...options })
      const parsed = (schemas.output as z.ZodType).safeParse(result)
      if (!parsed.success) throw new PublicCallError("internal", "La respuesta del servidor no encaja con el contrato.")
      return parsed.data as CallableOutput<N>
    } catch (error) {
      if (error instanceof ApiCallError) throw new PublicCallError(error.code, error.message)
      throw error
    }
  }
  if (!settings) throw new PublicCallError("config", "Firebase no está configurado en la web.")

  // Un controlador propio en vez de AbortSignal.any, que no está en los Safari de iOS antiguos.
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, options.timeoutMs ?? CALL_TIMEOUT_MS)
  const onAbort = () => controller.abort()
  options.signal?.addEventListener("abort", onAbort)

  let response: Response
  let body: { result?: unknown; error?: { status?: string; message?: string } } | null
  try {
    response = await (options.fetcher ?? fetch)(callableUrl(settings, name), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data }),
      signal: controller.signal,
    })
    body = (await response.json().catch(() => null)) as typeof body
  } catch (error) {
    if (options.signal?.aborted) throw error
    if (timedOut) throw new PublicCallError("deadline-exceeded", "El servidor ha tardado demasiado en responder.")
    throw new PublicCallError("network", "No hay conexión con el servidor.")
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener("abort", onAbort)
  }

  if (!response.ok || body?.error) {
    if (!body?.error && response.status === 404) {
      throw new PublicCallError("not-deployed", `La función ${name} no existe en el servidor.`)
    }
    const code = body?.error ? codeFromStatus(body.error.status) : response.status >= 500 ? "internal" : "unknown"
    throw new PublicCallError(code, body?.error?.message ?? "")
  }
  if (!body || !("result" in body)) throw new PublicCallError("internal", "Respuesta del servidor no válida.")

  const parsed = (schemas.output as z.ZodType).safeParse(body.result)
  if (!parsed.success) throw new PublicCallError("internal", "La respuesta del servidor no encaja con el contrato.")
  // El esquema de salida es el de esta callable (CALLABLE_SCHEMAS[name]), así que el tipo coincide.
  return parsed.data as CallableOutput<N>
}
