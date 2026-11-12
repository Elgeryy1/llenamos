import { invokeOperation, operationErrorCode, isDefinitiveOperationError } from "@/lib/api/operations"
import { CALLABLE_SCHEMAS, CALLABLES_FASE5_MARKETING, type CallableInput, type CallableOutput } from "@llenamos/core"
import { ZodError } from "zod"

export type NombreMarketing = keyof typeof CALLABLES_FASE5_MARKETING
export type MutacionMarketing = Extract<
  NombreMarketing,
  "guardarConfiguracionMarketing" | "guardarSegmento" | "borrarSegmento" | "guardarCampana" | "lanzarCampana" | "cancelarCampana"
>

/** Valida las dos fronteras con el contrato congelado. No hay respuestas de éxito locales. */
export async function llamarMarketing<N extends NombreMarketing>(name: N, input: CallableInput<N>): Promise<CallableOutput<N>> {
  const data = CALLABLE_SCHEMAS[name].input.parse(input)
  const result = await invokeOperation(name, data, { authentication: name === "darseDeBaja" ? "none" : "required" })
  const parsed = CALLABLE_SCHEMAS[name].output.safeParse(result)
  if (!parsed.success) throw new Error("La respuesta no coincide con el contrato. No se ha confirmado el resultado.")
  return parsed.data as CallableOutput<N>
}

export function codigoMarketing(error: unknown): string {
  return operationErrorCode(error)
}

export function errorMarketing(error: unknown): string {
  if (error instanceof ZodError) return error.issues.map((i) => i.message).join(" ")
  const code = codigoMarketing(error)
  if (
    ["not-found", "unimplemented"].includes(code) &&
    (!(error instanceof Error) || /^(not[ _-]?found|unimplemented)$/i.test(error.message))
  )
    return "El servicio de campañas no está disponible. No se ha confirmado ningún cambio."
  if (["internal", "unavailable", "deadline-exceeded"].includes(code))
    return "No ha llegado la respuesta del servicio. No se ha confirmado el resultado. Reintenta la misma acción para recuperar su respuesta sin duplicarla."
  if (code === "permission-denied") return "No tienes acceso a estos datos."
  return error instanceof Error ? error.message : "No se ha podido completar la operación."
}

/** Conserva el requestId ante una respuesta incierta; también evita duplicados tras un reintento. */
export class IntencionesMarketing {
  private pendientes = new Map<string, string>()
  constructor(
    private enviar: typeof llamarMarketing = llamarMarketing,
    private nuevoId = () => crypto.randomUUID(),
  ) {}
  async run<N extends MutacionMarketing>(name: N, input: Omit<CallableInput<N>, "requestId">): Promise<CallableOutput<N>> {
    const key = `${name}:${JSON.stringify(input)}`
    const requestId = this.pendientes.get(key) ?? this.nuevoId()
    this.pendientes.set(key, requestId)
    try {
      const out = await this.enviar(name, { ...input, requestId } as CallableInput<N>)
      this.pendientes.delete(key)
      return out
    } catch (error) {
      if (
        error instanceof ZodError ||
        isDefinitiveOperationError(error)
      )
        this.pendientes.delete(key)
      throw error
    }
  }
}
