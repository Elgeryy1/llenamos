/**
 * Panel interno del equipo de LogiQD (`/logiqd`): plan y módulos de cada
 * restaurante. Solo lo usa quien tiene el claim `logiqd: true`; el servidor lo
 * vuelve a comprobar en `cambiarPlan`.
 */
import {
  activeModulesFor,
  CambiarPlanInputSchema,
  DEFAULT_PLAN,
  MODULES,
  PLAN_MODULES,
  restaurantModules,
  type Module,
  type ModuleOverrides,
  type Plan,
} from "@llenamos/core"
import type { RestaurantDoc } from "@/lib/data/parse"

/** ¿El token de la sesión trae el claim del equipo de LogiQD? */
export function isLogiqdTeam(claims: Record<string, unknown> | null | undefined): boolean {
  return claims?.logiqd === true
}

/** Lo que se elige para cada módulo: lo que diga el plan, o encendido o apagado aparte. */
export type ModuleChoice = "plan" | "on" | "off"

export const MODULE_CHOICE_LABEL: Record<ModuleChoice, string> = {
  plan: "Según el plan",
  on: "Encendido",
  off: "Apagado",
}

export function choicesFromOverrides(overrides: ModuleOverrides | undefined): Record<Module, ModuleChoice> {
  return Object.fromEntries(
    MODULES.map((m) => {
      const v = overrides?.[m]
      return [m, v === true ? "on" : v === false ? "off" : "plan"]
    }),
  ) as Record<Module, ModuleChoice>
}

/**
 * Excepciones a guardar. Se quitan las que no cambian nada (encender un módulo que
 * el plan ya trae), para que al cambiar de plan más adelante no quede una excepción
 * olvidada.
 */
export function overridesFromChoices(plan: Plan, choices: Record<Module, ModuleChoice>): ModuleOverrides {
  const out: ModuleOverrides = {}
  for (const m of MODULES) {
    const inPlan = PLAN_MODULES[plan].includes(m)
    if (choices[m] === "on" && !inPlan) out[m] = true
    if (choices[m] === "off" && inPlan) out[m] = false
  }
  return out
}

/** Estado actual de un restaurante tal como lo enseña la lista. */
export interface PlanState {
  plan: Plan
  /** Sin `plan` guardado: se trata como `completo` hasta que se migre. */
  legacy: boolean
  overrides: ModuleOverrides
  active: Module[]
}

export function planStateOf(r: Pick<RestaurantDoc, "plan" | "moduleOverrides" | "activeModules">): PlanState {
  return {
    plan: r.plan ?? DEFAULT_PLAN,
    legacy: !r.plan,
    overrides: r.moduleOverrides ?? {},
    active: restaurantModules(r),
  }
}

export interface PlanDraft {
  plan: Plan
  choices: Record<Module, ModuleChoice>
}

export function draftFrom(state: PlanState): PlanDraft {
  return { plan: state.plan, choices: choicesFromOverrides(state.overrides) }
}

/** Módulos que quedarían activos con el borrador. */
export function previewModules(draft: PlanDraft): Module[] {
  return activeModulesFor(draft.plan, overridesFromChoices(draft.plan, draft.choices))
}

/** Qué cambia respecto a lo guardado: módulos que se encienden y que se apagan. */
export function moduleDiff(before: readonly Module[], after: readonly Module[]): { on: Module[]; off: Module[] } {
  return {
    on: after.filter((m) => !before.includes(m)),
    off: before.filter((m) => !after.includes(m)),
  }
}

function sameOverrides(a: ModuleOverrides, b: ModuleOverrides) {
  return MODULES.every((m) => a[m] === b[m])
}

export function isDirty(state: PlanState, draft: PlanDraft): boolean {
  if (state.legacy) return true
  return state.plan !== draft.plan || !sameOverrides(state.overrides, overridesFromChoices(draft.plan, draft.choices))
}

/** Entrada de `cambiarPlan`, validada con el esquema de core. */
export function cambiarPlanInput(restaurantId: string, draft: PlanDraft) {
  return CambiarPlanInputSchema.parse({
    restaurantId,
    plan: draft.plan,
    moduleOverrides: overridesFromChoices(draft.plan, draft.choices),
  })
}

/** Busca por nombre o identificador, sin tildes ni mayúsculas. */
export function matchesRestaurant(r: { id: string; name: string; slug: string }, text: string): boolean {
  const n = (s: string) =>
    s
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
  const q = n(text.trim())
  return q === "" || n(r.name).includes(q) || r.slug.includes(q) || r.id.includes(q)
}

/** Fila de la lista de `/logiqd`: un restaurante que no encaja no rompe la lista entera. */
export type TeamRestaurantRow = { ok: true; restaurant: RestaurantDoc } | { ok: false; id: string; message: string }

export function parseTeamRestaurant(id: string, data: unknown, parse: (id: string, data: unknown) => RestaurantDoc): TeamRestaurantRow {
  try {
    return { ok: true, restaurant: parse(id, data) }
  } catch (e) {
    return { ok: false, id, message: e instanceof Error ? e.message : "Datos con un formato inesperado." }
  }
}
