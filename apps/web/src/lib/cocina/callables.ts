import { CALLABLE_SCHEMAS, type CallableInput, type CallableOutput, type OfflineCommand } from "@llenamos/core"
import { invokeOperation, operationBackend, operationErrorCode } from "@/lib/api/operations"
import { describeError } from "@/lib/firebase/errors"

type Nombre = "cambiarEstadoLineas" | "marcarAgotado" | "guardarRaciones"

export async function llamarCocina<N extends Nombre>(name: N, input: CallableInput<N>): Promise<CallableOutput<N>> {
  const data = CALLABLE_SCHEMAS[name].input.parse(input)
  const operacion = (name === "guardarRaciones" ? null : name) as OfflineCommand["operation"] | null
  const cola = operacion ? await import("@/lib/sin-conexion/cliente") : null
  if (cola && operacion && (operationBackend() === "firebase-demo" || await cola.puedeEncolar(operacion, data as Record<string, unknown>))) {
    const response = await cola.queueOperation(operacion, data as Record<string, unknown>)
    const parsed = CALLABLE_SCHEMAS[name].output.safeParse(response)
    if (!parsed.success) throw new Error(`La respuesta de ${name} no cumple el contrato. Comprueba el estado antes de repetir.`)
    return parsed.data as CallableOutput<N>
  }
  if (!navigator.onLine) throw new Error("Necesitas conexión para confirmar cambios en cocina. No se ha enviado la operación.")
  const response = await invokeOperation(name, data)
  const parsed = CALLABLE_SCHEMAS[name].output.safeParse(response)
  if (!parsed.success) throw new Error(`La respuesta de ${name} no cumple el contrato. Comprueba el estado antes de repetir.`)
  return parsed.data as CallableOutput<N>
}

export function errorCocina(error: unknown): string {
  const info = describeError(error)
  const code = operationErrorCode(error)
  if (["not-found", "unimplemented", "not-deployed"].includes(code)) return "Falta el servidor de esta función. No se ha confirmado ningún cambio."
  if (info.code === "permission-denied") return "No se pueden leer los datos de esta estación: falta el servidor de esta función o el permiso de acceso al local."
  return info.message
}
