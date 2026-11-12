"use client"

import { invokeOperation, operationErrorCode } from "@/lib/api/operations"

import { CALLABLE_SCHEMAS, FASE5_ACCESS, can, type CALLABLES_FASE5_FIDELIZACION, type CallableInput, type CallableOutput, type Module, type Role } from "@llenamos/core"
import { ZodError } from "zod"
import { describeError } from "@/lib/firebase/errors"

export type Nombre = keyof typeof CALLABLES_FASE5_FIDELIZACION
export type ApiFidelizacion = <N extends Nombre>(nombre: N, entrada: CallableInput<N>) => Promise<CallableOutput<N>>
export type Acceso = { role: Role; modules: readonly Module[] }
export function permitido(acceso: Acceso, nombre: Nombre): boolean {
  const regla = FASE5_ACCESS[nombre]
  return regla.permission !== "logiqd" && regla.permission !== "public" && can(acceso.role, regla.permission) && regla.modules.every((m) => acceso.modules.includes(m))
}

export const llamarFidelizacion: ApiFidelizacion = async (nombre, entrada) => {
  if (!navigator.onLine) throw new Error("Necesitas conexión. No se ha confirmado la operación.")
  const datos = CALLABLE_SCHEMAS[nombre].input.parse(entrada)
  const respuesta = await invokeOperation(nombre, datos)
  const salida = CALLABLE_SCHEMAS[nombre].output.safeParse(respuesta)
  if (!salida.success) throw new Error("La respuesta no cumple el contrato. No se ha podido confirmar el resultado. Revisa los datos antes de reintentar.")
  return salida.data as CallableOutput<typeof nombre>
}

export function mensajeError(error: unknown): string {
  if (error instanceof ZodError) {
    const issue = error.issues[0]
    if (issue?.code === "custom") return issue.message
    const campos: Record<string, string> = { name: "el nombre", pointsPerEuro: "los puntos por euro", minSpendCents: "el gasto mínimo", expiryDays: "los días de caducidad", termsVersion: "la versión de las condiciones", pointsCost: "los puntos del premio", valueCents: "el valor del premio", itemId: "el plato elegido", bp: "el porcentaje de descuento", cents: "el importe del descuento", code: "el código de promoción", channels: "los tipos de pedido", usageLimit: "el cupo total", perCustomerLimit: "los usos por cliente", priority: "la prioridad", points: "los puntos del ajuste", reason: "el motivo", timeWindows: "las franjas horarias", from: "la hora de inicio", to: "la hora de fin", scope: "los platos o categorías elegidos", itemIds: "los platos elegidos", categoryIds: "las categorías elegidas", month: "el mes del informe" }
    const campo = [...(issue?.path ?? [])].reverse().map(String).find((v) => campos[v])
    return `Revisa ${campo ? campos[campo] : "los datos del formulario"}. Comprueba el formato y los límites indicados.`
  }
  const codigo = operationErrorCode(error)
  if (codigo === "permission-denied") return "No tienes acceso a estos datos del restaurante."
  if (["not-found", "not-deployed"].includes(codigo)) return "El servicio de fidelización no está disponible o el dato ya no existe. No se ha confirmado ninguna operación."
  if (["internal", "unavailable", "deadline-exceeded"].includes(codigo)) return "No se ha podido confirmar la respuesta. Se ha perdido la conexión con el servicio de fidelización. Reintenta la misma operación para recuperar su resultado."
  return describeError(error).message
}

/** Una intención conserva su identificador cuando se desconoce el resultado. */
export class Intencion {
  private pendiente: { huella: string; id: string } | null = null
  constructor(private nuevoId = () => crypto.randomUUID()) {}
  id(nombre: string, datos: unknown) {
    const huella = JSON.stringify([nombre, datos])
    if (this.pendiente?.huella !== huella) this.pendiente = { huella, id: this.nuevoId() }
    return this.pendiente.id
  }
  cerrar() { this.pendiente = null }
}
