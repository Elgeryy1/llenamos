/**
 * Módulos y planes.
 *
 * Llenamos se vende por partes: cada restaurante tiene un plan, y el plan trae unos
 * módulos. Además, LogiQD puede encender o apagar un módulo concreto aparte del plan
 * (`moduleOverrides`). El resultado se guarda calculado en `activeModules`, que es lo que
 * comprueban las reglas de Firestore. Los tres campos solo los escribe el servidor
 * (`cambiarPlan`, con el claim `logiqd`).
 *
 * Igual que con los roles, el módulo se comprueba en la interfaz, en las funciones y en
 * las reglas, y las tres deben decir lo mismo.
 */
import { z } from "zod"
import { timestampToMillis } from "./timestamp"

export const MODULES = [
  "reservations", "floor", "kitchen", "pos", "repite", "staff", "inventory",
  // Fase 5: clientes, marketing y análisis.
  "loyalty", "marketing", "analytics",
] as const
export type Module = (typeof MODULES)[number]
export const ModuleSchema = z.enum(MODULES)

export const MODULE_LABEL: Record<Module, string> = {
  reservations: "Reservas",
  floor: "Sala y comandero",
  kitchen: "Cocina y barra",
  pos: "Caja",
  repite: "Repite",
  staff: "Personal",
  inventory: "Inventario y costes",
  loyalty: "Fidelización y promociones",
  marketing: "Campañas y origen de reservas",
  analytics: "Análisis y previsión",
}

/** Planes provisionales y sin precio: los precios se deciden más adelante (PLAN.md, decisión 5). */
export const PLANS = ["reservas", "sala", "completo"] as const
export type Plan = (typeof PLANS)[number]
export const PlanSchema = z.enum(PLANS)

export const PLAN_LABEL: Record<Plan, string> = {
  reservas: "Reservas",
  sala: "Sala",
  completo: "Completo",
}

/** Módulos que trae cada plan. */
export const PLAN_MODULES: Record<Plan, readonly Module[]> = {
  reservas: ["reservations"],
  sala: ["reservations", "floor", "kitchen"],
  completo: MODULES,
}

/**
 * Propuesta **provisional** de la fase 5 para el catálogo comercial (decisiones 5 y 8 de PLAN.md),
 * pendiente del propietario: no cambia `provisionalPlanCatalog` de la fase 6 ni los planes antiguos.
 * Los planes antiguos no cambian: `completo` trae todos los módulos (como en la fase 4) y `reservas`
 * y `sala` no traen ninguno de la fase 5. `repite` queda fuera de todos: lo enciende LogiQD aparte
 * (`moduleOverrides`) y además necesita la conexión con el servicio Repite.
 */
export const PHASE5_PLAN_PROPOSAL = {
  provisional: true,
  barra: ["analytics"],
  sala: ["analytics", "marketing"],
  grupo: ["analytics", "marketing", "loyalty"],
  aparte: ["repite"],
} as const satisfies { provisional: true } & Record<"barra" | "sala" | "grupo" | "aparte", readonly Module[]>

/** Plan que se aplica a un restaurante que todavía no tiene `plan` (creado antes de la fase 1). */
export const DEFAULT_PLAN: Plan = "completo"

/** `true` enciende el módulo aunque el plan no lo traiga; `false` lo apaga aunque lo traiga. */
export const ModuleOverridesSchema = z.partialRecord(ModuleSchema, z.boolean())
export type ModuleOverrides = z.infer<typeof ModuleOverridesSchema>

/** Módulos activos de un plan con sus excepciones, en el orden de `MODULES`. */
export function activeModulesFor(plan: Plan, overrides: ModuleOverrides = {}): Module[] {
  const delPlan = PLAN_MODULES[plan]
  return MODULES.filter((m) => overrides[m] ?? delPlan.includes(m))
}

/** Lo que hace falta de un restaurante para saber sus módulos (el documento tal cual). */
export interface RestaurantModulesLike {
  plan?: Plan | null
  moduleOverrides?: ModuleOverrides | null
  activeModules?: readonly Module[] | null
  /** Los restaurantes migrados nunca heredan completo si falta la proyección. */
  entitlementVersion?: number | null
  /** Fin del acceso (Timestamp, Date o ms). Pasada esta fecha un restaurante migrado no tiene módulos, igual que en las reglas. */
  accessValidUntil?: unknown
}

/**
 * Módulos activos de un restaurante.
 *
 * - Con `entitlementVersion`: manda exclusivamente la proyección, ausente = sin módulos; pasada
 *   `accessValidUntil` (suscripción vencida o suspendida) no queda ninguno.
 * - Sin `plan` ni migración: se trata como `completo` (con sus excepciones, si las hubiera) hasta que se migre.
 * - Con `plan` y `activeModules`: manda `activeModules`, que es lo que comprueban las reglas.
 * - Con `plan` y sin `activeModules`: se calcula.
 */
export function restaurantModules(restaurant: RestaurantModulesLike, now: number = Date.now()): Module[] {
  if (restaurant.entitlementVersion != null) {
    // Prueba gratis terminada, impago o baja: la proyección puede ir por detrás del reloj, así que manda la fecha.
    const until = timestampToMillis(restaurant.accessValidUntil)
    if (until !== null && now >= until) return []
    return MODULES.filter((m) => restaurant.activeModules?.includes(m))
  }
  if (!restaurant.plan) return activeModulesFor(DEFAULT_PLAN, restaurant.moduleOverrides ?? {})
  if (Array.isArray(restaurant.activeModules)) return MODULES.filter((m) => restaurant.activeModules?.includes(m))
  return activeModulesFor(restaurant.plan, restaurant.moduleOverrides ?? {})
}

export function hasModule(restaurant: RestaurantModulesLike, module: Module, now: number = Date.now()): boolean {
  return restaurantModules(restaurant, now).includes(module)
}

export function isModule(value: unknown): value is Module {
  return typeof value === "string" && (MODULES as readonly string[]).includes(value)
}
