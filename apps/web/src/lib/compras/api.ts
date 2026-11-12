import { invokeOperation, operationErrorCode, isDefinitiveOperationError } from "@/lib/api/operations"
import { CALLABLE_SCHEMAS, type CallableInput, type CallableOutput } from "@llenamos/core"
import { ZodError } from "zod"

/** Las seis callables de compras de la fase 4 (más la sugerencia, que solo lee). */
export const CALLABLES_COMPRAS = [
  "guardarProveedor",
  "guardarFormatoProveedor",
  "guardarPedidoProveedor",
  "cambiarEstadoPedidoProveedor",
  "recibirPedidoProveedor",
  "sugerirPedidos",
] as const
export type NombreCompras = (typeof CALLABLES_COMPRAS)[number]

/** Llama a una callable con el esquema del contrato a la ida y a la vuelta. Los cálculos los hace el servidor. */
export async function llamarCompras<N extends NombreCompras>(
  name: N,
  input: CallableInput<N>,
): Promise<CallableOutput<N>> {
  if (typeof navigator !== "undefined" && !navigator.onLine)
    throw new Error("Necesitas conexión para guardar compras. No se ha confirmado nada.")
  const data = CALLABLE_SCHEMAS[name].input.parse(input)
  const result = await invokeOperation(name, data)
  const output = CALLABLE_SCHEMAS[name].output.safeParse(result)
  if (!output.success) throw new Error("La respuesta no coincide con el contrato. No se ha podido confirmar el resultado.")
  return output.data as CallableOutput<N>
}

export function codigo(error: unknown): string {
  return operationErrorCode(error)
}

/** Solo estos errores dicen que el servidor no hizo nada. Cualquier otro puede haber guardado: se reintenta con el mismo requestId. */
export function esDefinitivo(error: unknown): boolean {
  if (error instanceof ZodError) return true
  return isDefinitiveOperationError(error)
}

export function errorCompras(error: unknown): string {
  if (error instanceof ZodError) return error.issues.map((i) => i.message).join(" ")
  const code = codigo(error)
  if (code === "permission-denied") return "Tu cuenta no tiene acceso a las compras de este local o el módulo de inventario no está activo."
  if (["internal", "unavailable", "deadline-exceeded"].includes(code))
    return "No se ha podido confirmar la respuesta. Revisa la pantalla y vuelve a intentarlo: el servidor no repite lo que ya guardó."
  if (code === "not-found" && (!(error instanceof Error) || /^not[ _]found$/i.test(error.message)))
    return "El servidor de compras no responde en este entorno. No se ha guardado nada."
  if (error instanceof Error) return error.message
  return "No se ha podido completar la operación."
}
