import { CALLABLE_SCHEMAS, FASE2_ACCESS, PublicMenuSchema, type CallableInput, type CallableOutput } from "@llenamos/core"
import { ZodError, type z } from "zod"
import { invokeOperation, operationBackend } from "@/lib/api/operations"
import { ApiCallError, postOperation } from "@/lib/api/transport"
import { getFirebaseIdentity } from "@/lib/firebase/auth-client"
import { firebaseConfig } from "@/lib/firebase/config"

export type CartaCallable =
  | "guardarCategoriaCarta"
  | "guardarPlato"
  | "guardarMenuDia"
  | "ordenarCarta"
  | "marcarAgotado"
  | "guardarEstacion"
  | "guardarConfiguracionSala"
  | "recuperarQrMesa"
  | "revocarQrMesa"
  | "importarQrMesa"
  | "regenerarQrMesa"
export type PublicCallable =
  | "verMesaPublica"
  | "pedirDesdeMesa"
  | "avisarDesdeMesa"
  | "consultarRecogida"
  | "pedirParaLlevar"
  | "verParaLlevarPublico"
export class ServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly requestId?: string,
  ) {
    super(message)
  }
}

/** Protocolo callable con detección explícita de funciones aún ausentes en el emulador. */
export async function callService<N extends CartaCallable | PublicCallable>(
  name: N,
  input: CallableInput<N>,
  authenticated = false,
  fetcher: typeof fetch = fetch,
): Promise<CallableOutput<N>> {
  const data = CALLABLE_SCHEMAS[name].input.parse(input)
  // Conservamos el argumento por compatibilidad, pero solo el contrato decide la autoría.
  authenticated = FASE2_ACCESS[name].permission !== "public"
  if (operationBackend() === "postgres") {
    let response: unknown
    try {
      response = await invokeOperation(name, data, { authentication: authenticated ? "required" : "none", fetcher })
    } catch (error) {
      if (error instanceof ApiCallError) {
        const code = error.code === "not-deployed" ? "missing" : ["network", "internal", "unavailable", "deadline-exceeded"].includes(error.code) ? "uncertain" : error.code
        throw new ServiceError(code, error.message, error.requestId)
      }
      throw error
    }
    const parsed = CALLABLE_SCHEMAS[name].output.safeParse(response)
    if (!parsed.success) throw new ServiceError(name.startsWith("pedir") ? "uncertain" : "contract", "La respuesta del servidor no encaja con el contrato. Consulta el estado antes de reenviar.")
    return parsed.data as CallableOutput<N>
  }
  if (!firebaseConfig.ok) throw new ServiceError("config", "Falta configurar Firebase.")
  const url = `/m/api/${name}`
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (authenticated) {
    const user = getFirebaseIdentity().auth.currentUser
    if (!user) throw new ServiceError("unauthenticated", "Vuelve a entrar para guardar los cambios.")
    headers.Authorization = `Bearer ${await user.getIdToken()}`
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20_000)
  try {
    const response = await fetcher(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ data }),
      signal: controller.signal,
      credentials: "omit", cache: "no-store", redirect: "error",
    })
    const body = (await response.json().catch(() => null)) as {
      result?: unknown
      error?: { status?: string; message?: string }
    } | null
    if (response.status === 404 && !body?.error)
      throw new ServiceError("missing", `Falta el servidor de esta función: ${name}.`)
    if (body?.error || !response.ok) {
      const code = body?.error?.status?.toLowerCase().replaceAll("_", "-") ?? "network"
      throw new ServiceError(
        response.status >= 500 && code !== "config" ? "uncertain" : code,
        body?.error?.message ?? "No se ha podido conectar con el servidor.",
      )
    }
    const result = CALLABLE_SCHEMAS[name].output.safeParse(body?.result)
    if (!result.success)
      throw new ServiceError(
        name.startsWith("pedir") ? "uncertain" : "contract",
        "La respuesta del servidor no encaja con el contrato. Consulta el estado antes de reenviar.",
      )
    return result.data as CallableOutput<N>
  } catch (error) {
    if (error instanceof ServiceError) throw error
    throw new ServiceError(
      "uncertain",
      "No se ha recibido respuesta. Consulta el estado antes de volver a enviar.",
    )
  } finally {
    clearTimeout(timer)
  }
}

export const saveCarta = <N extends CartaCallable>(name: N, input: CallableInput<N>) => callService(name, input, true)
export function errorText(error: unknown): string {
  if (error instanceof ZodError) return error.issues.map((i) => `${i.path.join(" · ")}: ${i.message}`).join(". ")
  if (error instanceof Error && "code" in error && String(error.code).includes("permission-denied"))
    return "El servidor aún no permite leer estos datos de la fase 2 o tu cuenta no tiene acceso. Puedes preparar el formulario; solo se guardará cuando el servidor lo confirme."
  return error instanceof Error ? error.message : "No se ha podido completar la operación."
}

/** Carta pública del local en modo VPS (antes el documento `publicMenus/{id}`). Sin identidad. */
export async function verCartaPublica(slug: string, locationId: string): Promise<z.output<typeof PublicMenuSchema>> {
  try {
    return PublicMenuSchema.parse(await postOperation("verCartaPublica", { slug, locationId }, { authentication: "none" }))
  } catch (error) {
    if (error instanceof ApiCallError) throw new ServiceError(error.code === "not-deployed" ? "missing" : error.code, error.message, error.requestId)
    throw error
  }
}
