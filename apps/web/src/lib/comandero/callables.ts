import {
  CALLABLE_SCHEMAS,
  type CallableInput,
  type CallableOutput,
  type CallableWithSchema,
} from "@llenamos/core"
import { invokeOperation, operationBackend, operationErrorCode } from "@/lib/api/operations"
import { describeError } from "@/lib/firebase/errors"

export async function llamarSala<N extends CallableWithSchema>(
  name: N,
  input: CallableInput<N>,
): Promise<CallableOutput<N>> {
  const data = CALLABLE_SCHEMAS[name].input.parse(input)
  // Las cinco intenciones de la cola van por ella en la demo y, en el VPS, cuando la pantalla ya preparó sus versiones y la
  // carga cumple el contrato de la cola. Con conexión y sin eso, van directas a la API (recogidas, historial, disponibilidad).
  if (["enviarPedido", "marcharPase", "cambiarEstadoLineas", "cambiarEstadoTarea", "marcarAgotado"].includes(name)) {
    const cola = await import("@/lib/sin-conexion/cliente")
    if (operationBackend() === "firebase-demo" || await cola.puedeEncolar(name as Parameters<typeof cola.queueOperation>[0], data as Record<string, unknown>)) {
      const response = await cola.queueOperation(name as Parameters<typeof cola.queueOperation>[0], data as Record<string, unknown>)
      return CALLABLE_SCHEMAS[name].output.parse(response) as CallableOutput<N>
    }
  }
  if (!navigator.onLine) throw new Error("Necesitas conexión con el servidor para esta operación. Sin conexión solo esperan los cambios de pantallas ya preparadas.")
  const result = await invokeOperation(name, data)
  const parsed = CALLABLE_SCHEMAS[name].output.safeParse(result)
  if (!parsed.success)
    throw new Error(
      "La respuesta del servidor no coincide con el contrato. Recarga antes de repetir la operación.",
    )
  return parsed.data as CallableOutput<N>
}

export function errorSala(error: unknown): string {
  const code = operationErrorCode(error)
  if (code === "not-deployed") return "Falta el servidor de esta función. No se ha confirmado la operación."
  if (code === "not-found") {
    const message =
      error &&
      typeof error === "object" &&
      "message" in error &&
      typeof error.message === "string"
        ? error.message
        : ""
    // El mismo código también identifica una mesa eliminada, con mensaje del backend.
    if (
      !message ||
      message.toLowerCase().replace(/[\s_-]+/g, "") === "notfound"
    )
      return "Falta el servidor de esta función. No se ha confirmado la operación."
    return describeError(error).message
  }
  // Un endpoint aún ausente puede llegar como error de red por el control CORS del emulador.
  if (code === "internal" || code === "unavailable")
    return "No se ha podido contactar con el servidor. Puede que falte el servidor de esta función. Comprueba el estado en directo antes de repetirla."
  return describeError(error).message
}
