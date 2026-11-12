import { invokeOperation, operationErrorCode } from "@/lib/api/operations"
import { CALLABLE_SCHEMAS, FASE5_ACCESS, can, hasModule, sumarDias, type CALLABLES_FASE5_ANALISIS, type CallableInput, type CallableOutput, type Role, type RestaurantModulesLike } from "@llenamos/core"
import { ZodError } from "zod"

export type NombreAnalisis = keyof typeof CALLABLES_FASE5_ANALISIS

export function accesoAnalisis(name: NombreAnalisis, role: Role, restaurant: RestaurantModulesLike) {
  const access = FASE5_ACCESS[name]
  return access.permission !== "public" && access.permission !== "logiqd" && can(role, access.permission) && access.modules.every((module) => hasModule(restaurant, module))
}

export async function llamarAnalisis<N extends NombreAnalisis>(name: N, input: CallableInput<N>): Promise<CallableOutput<N>> {
  if (!navigator.onLine) throw new Error("Necesitas conexión para consultar o guardar el análisis. No se ha confirmado ninguna operación.")
  const data = CALLABLE_SCHEMAS[name].input.parse(input)
  const result = await invokeOperation(name, data)
  const output = CALLABLE_SCHEMAS[name].output.safeParse(result)
  if (!output.success) throw new Error("La respuesta de análisis no cumple el contrato. No se ha confirmado el resultado.")
  return output.data as CallableOutput<N>
}

export function errorAnalisis(error: unknown): string {
  if (error instanceof ZodError) return error.issues.map((i) => i.message).join(" ")
  const code = operationErrorCode(error)
  const message = error && typeof error === "object" && "message" in error ? String(error.message) : ""
  if (["unavailable", "internal", "not-deployed"].includes(code) || (code === "not-found" && (!message || /^(not found|not_found)$/i.test(message))))
    return "El servicio de análisis no está disponible. No se ha confirmado ningún resultado."
  if (code === "permission-denied") return "No tienes acceso a estos datos."
  if (code === "deadline-exceeded") return "No ha llegado la confirmación. Vuelve a consultar antes de repetir la operación."
  return message || "No se ha podido confirmar el resultado."
}

/** El contrato consulta por fecha y prohíbe leer dailySummaries desde el SDK cliente. */
export async function buscarUltimoResumen(restaurantId: string, today: string) {
  for (let offset = 0; offset < 92; offset++) {
    try {
      return await llamarAnalisis("verResumenDiario", { restaurantId, date: sumarDias(today, -offset) })
    } catch (error) {
      const code = operationErrorCode(error)
      // Un endpoint ausente no equivale a un día sin resumen.
      if (code !== "not-found" || /El servicio de análisis no está disponible/.test(errorAnalisis(error))) throw error
    }
  }
  throw new Error("No hay resúmenes guardados en los últimos 92 días. Puedes consultar una fecha anterior.")
}
