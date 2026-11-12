import { describe, expect, it } from "vitest"
import { can, hasModule, restaurantModules, RestaurantSchema } from "../index"
import { canSubscriptionTransition, checkPlanLimit, platformModules, planOverages, provisionalPlanCatalog, SubscriptionSchema, subscriptionAllowsService, subscriptionForWrite } from "./planes"

const catalog = provisionalPlanCatalog()
const plan = catalog[2]!
const subscription = SubscriptionSchema.parse({ planId: plan.id, planVersion: 1, status: "trialing", interval: "month", trialEndsAt: 1000, periodEndsAt: 3000, graceEndsAt: 2000, cancelAtPeriodEnd: false, stripeCustomerId: null, stripeSubscriptionId: null, revision: 1 })
describe("planes configurables y acceso", () => {
  it("marca propuesta, precios anuales totales y Repite opcional", () => {
    expect(catalog.map((p) => [p.legacyPlan, p.monthlyCents, p.annualCents])).toEqual([["reservas", 4900, 46800], ["sala", 9900, 94800], ["completo", 19900, 190800]])
    expect(catalog.every((p) => p.provisional && !p.modules.includes("repite") && p.stripeMonthlyPriceId === null)).toBe(true)
    expect(platformModules(plan, subscription, { repite: true, kitchen: false }, 999)).toEqual(["reservations", "floor", "pos", "repite"])
  })
  it("comprueba límites, cero, ilimitado y cambio a plan inferior sin borrar datos", () => {
    expect(checkPlanLimit(plan.limits, "locations", 2).ok).toBe(true)
    expect(checkPlanLimit(plan.limits, "locations", 3).ok).toBe(false)
    expect(checkPlanLimit(catalog[0]!.limits, "apiKeys", 0).ok).toBe(false)
    expect(checkPlanLimit({ ...plan.limits, members: null }, "members", 1000).ok).toBe(true)
    expect(checkPlanLimit({ ...plan.limits, members: null }, "members", Number.MAX_SAFE_INTEGER).ok).toBe(false)
    expect(planOverages(plan.limits, { locations: 4, members: 1, apiKeys: 1, webhooks: 1 })).toEqual(["locations"])
    expect(() => checkPlanLimit(plan.limits, "members", -1)).toThrow()
  })
  it("corta acceso en vencimientos exactos y nunca permite que una excepción salte la suspensión", () => {
    expect(subscriptionAllowsService(subscription, 999)).toBe(true)
    expect(subscriptionAllowsService(subscription, 1000)).toBe(false)
    expect(subscriptionAllowsService({ ...subscription, status: "active" }, 3000)).toBe(false)
    expect(subscriptionAllowsService({ ...subscription, status: "past_due" }, 1999)).toBe(true)
    for (const status of ["not_configured", "suspended", "cancelled"] as const) expect(platformModules(plan, { ...subscription, status }, { pos: true }, 500)).toEqual([])
    expect(() => platformModules({ ...plan, version: 2 }, subscription, {}, 500)).toThrow()
    expect(canSubscriptionTransition("cancelled", "active")).toBe(false)
  })
  it("mantiene contratos antiguos y niega completo por omisión en restaurantes migrados", () => {
    expect(restaurantModules({})).toContain("pos")
    expect(restaurantModules({ entitlementVersion: 1 })).toEqual([])
    const managed = RestaurantSchema.parse({ name: "Lumbre", slug: "lumbre", brandColor: "#123456", currency: "EUR", timezone: "Europe/Madrid", locale: "es", isDemo: true, entitlementVersion: 1, activeModules: ["floor"] })
    expect(restaurantModules(managed)).toEqual(["floor"])
  })
  it("un restaurante migrado pierde los módulos al llegar accessValidUntil aunque la proyección vaya por detrás", () => {
    const doc = { entitlementVersion: 1, activeModules: ["reservations", "floor"] as const, accessValidUntil: 1000 }
    expect(restaurantModules(doc, 999)).toEqual(["reservations", "floor"])
    expect(restaurantModules(doc, 1000)).toEqual([])
    expect(hasModule({ ...doc, accessValidUntil: { toMillis: () => 1000 } }, "floor", 5000)).toBe(false)
    expect(hasModule({ ...doc, accessValidUntil: new Date(9000) }, "floor", 5000)).toBe(true)
    // Los restaurantes antiguos no tienen fecha de acceso y no cambian.
    expect(hasModule({ plan: "sala", accessValidUntil: 1 }, "floor", 5000)).toBe(true)
  })
  it("separa propietario, encargado, personal y equipo de LogiQD", () => {
    expect(can("owner", "planes.gestionar")).toBe(true)
    expect(can("manager", "planes.gestionar")).toBe(false)
    expect(can("manager", "planes.ver")).toBe(true)
    expect(can("manager", "privacidad.gestionar")).toBe(true)
    expect(can("waiter", "privacidad.gestionar")).toBe(false)
    expect(can("kitchen", "integraciones.gestionar")).toBe(false)
    // El claim logiqd se comprueba fuera de la matriz de roles del restaurante.
    expect(can("owner", "propietarios.gestionar")).toBe(true)
  })
  it("adapta Timestamp sin reinterpretar el reloj", () => {
    expect(SubscriptionSchema.parse(subscriptionForWrite(subscription, (ms) => ({ seconds: ms / 1000, nanoseconds: 0 })))).toEqual(subscription)
  })
})
