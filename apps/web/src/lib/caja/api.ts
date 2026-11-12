import { invokeOperation, operationErrorCode, isDefinitiveOperationError } from "@/lib/api/operations"
import {
  CALLABLE_SCHEMAS_FASE3,
  type CALLABLES_FASE3,
  type CallableInput,
  type CallableOutput,
} from "@llenamos/core"
import { ZodError } from "zod"

export type NombreCaja = keyof typeof CALLABLES_FASE3
export async function llamarCaja<N extends NombreCaja>(
  name: N,
  input: CallableInput<N>,
): Promise<CallableOutput<N>> {
  if (!navigator.onLine) throw new Error("Necesitas conexión para registrar cobros, emitir facturas y modificar la caja. No se ha confirmado ninguna operación.")
  const data = CALLABLE_SCHEMAS_FASE3[name].input.parse(input)
  const result = await invokeOperation(name, data)
  const output = CALLABLE_SCHEMAS_FASE3[name].output.safeParse(result)
  if (!output.success)
    throw new Error(
      "La respuesta no coincide con el contrato. No se ha podido confirmar el resultado.",
    )
  return output.data as CallableOutput<N>
}
export function codigo(error: unknown): string {
  return operationErrorCode(error)
}
export function esIncierto(error: unknown) {
  return !isDefinitiveOperationError(error)
}
export function errorCaja(error: unknown): string {
  if (error instanceof ZodError)
    return error.issues.map((i) => i.message).join(" ")
  const code = codigo(error)
  if (code === "permission-denied")
    return "No se pueden leer los datos de caja. Puede que las reglas de caja aún no estén integradas o que no tengas acceso. No se ha confirmado ninguna operación."
  if (
    (code === "not-deployed" || code === "not-found") &&
    (!error ||
      typeof error !== "object" ||
      !("message" in error) ||
      /^(not found|not_found|NOT_FOUND)$/i.test(String(error.message)))
  )
    return "El backend de esta operación de caja aún no está disponible. No se ha confirmado la operación."
  if (
    [
      "internal",
      "unavailable",
      "deadline-exceeded",
    ].includes(code)
  )
    return "No se ha podido confirmar la respuesta. El backend de caja puede no estar integrado o la conexión se ha interrumpido. Revisa los datos y recupera la misma operación antes de continuar."
  if (error instanceof Error) return error.message
  if (error && typeof error === "object" && "message" in error)
    return String(error.message)
  return "No se ha podido confirmar la operación."
}
