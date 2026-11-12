/** Catálogo comercial versionado. La propuesta no activa cobros ni cambia planes antiguos. */
import { z } from "zod"
import { DocIdSchema } from "../model"
import { MODULES, ModuleOverridesSchema, ModuleSchema, PlanSchema } from "../modules"
import type { Module, ModuleOverrides } from "../modules"
import { AmountCentsSchema } from "../caja/modelo"
import { TimestampSchema } from "../timestamp"

export const PlatformRevisionSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
const Count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
export const PlanLimitsSchema = z.strictObject({ locations: Count.nullable(), members: Count.nullable(), apiKeys: Count.nullable(), webhooks: Count.nullable() })
export type PlanLimits = z.infer<typeof PlanLimitsSchema>
export const PlanDefinitionSchema = z.strictObject({
  id: DocIdSchema, version: PlatformRevisionSchema, name: z.string().trim().min(1).max(80),
  legacyPlan: PlanSchema, provisional: z.boolean(), enabled: z.boolean(),
  modules: z.array(ModuleSchema).refine((v) => new Set(v).size === v.length, "Hay módulos repetidos."),
  limits: PlanLimitsSchema, trialDays: Count.max(90), currency: z.literal("EUR"),
  monthlyCents: AmountCentsSchema, annualCents: AmountCentsSchema,
  stripeMonthlyPriceId: z.string().min(1).nullable(), stripeAnnualPriceId: z.string().min(1).nullable(),
})
export type PlanDefinition = z.infer<typeof PlanDefinitionSchema>
/** Importes sin IVA; el anual es el total de doce meses. Límites propuestos, no aprobados. */
export function provisionalPlanCatalog(): PlanDefinition[] {
  return [
    { id: "barra", name: "Barra", legacyPlan: "reservas", modules: ["reservations"], monthlyCents: 4900, annualCents: 46800, limits: { locations: 1, members: 5, apiKeys: 0, webhooks: 0 } },
    { id: "sala", name: "Sala", legacyPlan: "sala", modules: ["reservations", "floor", "kitchen"], monthlyCents: 9900, annualCents: 94800, limits: { locations: 1, members: 15, apiKeys: 1, webhooks: 1 } },
    { id: "grupo", name: "Grupo", legacyPlan: "completo", modules: ["reservations", "floor", "kitchen", "pos"], monthlyCents: 19900, annualCents: 190800, limits: { locations: 3, members: 50, apiKeys: 5, webhooks: 5 } },
  ].map((v) => PlanDefinitionSchema.parse({ ...v, version: 1, provisional: true, enabled: true, trialDays: 14, currency: "EUR", stripeMonthlyPriceId: null, stripeAnnualPriceId: null }))
}
export const SUBSCRIPTION_STATUSES = ["not_configured", "trialing", "active", "past_due", "suspended", "cancelled"] as const
export const SubscriptionSchema = z.object({
  planId: DocIdSchema, planVersion: PlatformRevisionSchema, status: z.enum(SUBSCRIPTION_STATUSES),
  interval: z.enum(["month", "year"]), trialEndsAt: TimestampSchema.nullable(),
  periodEndsAt: TimestampSchema.nullable(), graceEndsAt: TimestampSchema.nullable(),
  cancelAtPeriodEnd: z.boolean(), stripeCustomerId: z.string().nullable(), stripeSubscriptionId: z.string().nullable(),
  revision: PlatformRevisionSchema,
})
export type Subscription = z.infer<typeof SubscriptionSchema>
export const SUBSCRIPTION_TRANSITIONS: Record<Subscription["status"], readonly Subscription["status"][]> = {
  not_configured: ["trialing", "active", "cancelled"], trialing: ["active", "past_due", "suspended", "cancelled"],
  active: ["past_due", "suspended", "cancelled"], past_due: ["active", "suspended", "cancelled"],
  suspended: ["active", "cancelled"], cancelled: [],
}
export function canSubscriptionTransition(from: Subscription["status"], to: Subscription["status"]): boolean {
  return from === to || SUBSCRIPTION_TRANSITIONS[from].includes(to)
}
export function subscriptionAllowsService(s: Subscription, now: number): boolean {
  if (s.status === "trialing") return s.trialEndsAt !== null && now < s.trialEndsAt
  if (s.status === "past_due") return s.graceEndsAt !== null && now < s.graceEndsAt
  return s.status === "active" && s.periodEndsAt !== null && now < s.periodEndsAt
}
/** La proyección se persiste en servidor; una excepción de módulo no salta una suspensión. */
export function platformModules(plan: PlanDefinition, subscription: Subscription, overrides: ModuleOverrides, now: number): Module[] {
  if (plan.id !== subscription.planId || plan.version !== subscription.planVersion) throw new Error("La versión del plan no coincide.")
  if (!subscriptionAllowsService(subscription, now)) return []
  return MODULES.filter((m) => overrides[m] ?? plan.modules.includes(m))
}
export function checkPlanLimit(limits: PlanLimits, resource: keyof PlanLimits, used: number, additional = 1): { ok: boolean; limit: number | null; reason: string | null } {
  Count.parse(used); Count.parse(additional)
  const limit = limits[resource]
  const ok = Number.isSafeInteger(used + additional) && (limit === null || used + additional <= limit)
  return { ok, limit, reason: ok ? null : "Has alcanzado el límite de tu plan. Revisa el plan antes de añadir más." }
}
export function planOverages(limits: PlanLimits, usage: Record<keyof PlanLimits, number>): (keyof PlanLimits)[] {
  return (Object.keys(limits) as (keyof PlanLimits)[]).filter((k) => !checkPlanLimit(limits, k, usage[k], 0).ok)
}
export const EntitlementsSchema = z.object({
  version: PlatformRevisionSchema, planId: DocIdSchema, planVersion: PlatformRevisionSchema,
  activeModules: z.array(ModuleSchema), moduleOverrides: ModuleOverridesSchema, limits: PlanLimitsSchema,
  serviceEnabled: z.boolean(), reason: z.enum(["trial_expired", "payment_required", "suspended", "cancelled", "not_configured"]).nullable(),
  evaluatedAt: TimestampSchema, nextEvaluationAt: TimestampSchema.nullable(),
})
export type Entitlements = z.infer<typeof EntitlementsSchema>
export const OnboardingSchema = z.object({
  ownerUid: DocIdSchema, restaurantId: DocIdSchema.nullable(),
  status: z.enum(["draft", "provisioning", "ready", "failed", "cancelled"]),
  step: z.enum(["identity", "location", "hours", "plan", "review", "done"]),
  revision: PlatformRevisionSchema, requestId: DocIdSchema, error: z.string().max(300).nullable(), trialUsed: z.boolean(),
})
export type Onboarding = z.infer<typeof OnboardingSchema>
export const ONBOARDING_TRANSITIONS: Record<Onboarding["status"], readonly Onboarding["status"][]> = {
  draft: ["provisioning", "cancelled"], provisioning: ["ready", "failed"], failed: ["provisioning", "cancelled"], ready: [], cancelled: [],
}
export function subscriptionForWrite<H>(s: Subscription, convert: (ms: number) => H) {
  return { ...s, trialEndsAt: s.trialEndsAt === null ? null : convert(s.trialEndsAt), periodEndsAt: s.periodEndsAt === null ? null : convert(s.periodEndsAt), graceEndsAt: s.graceEndsAt === null ? null : convert(s.graceEndsAt) }
}
export function entitlementsForWrite<H>(s: Entitlements, convert: (ms: number) => H) {
  return { ...s, evaluatedAt: convert(s.evaluatedAt), nextEvaluationAt: s.nextEvaluationAt === null ? null : convert(s.nextEvaluationAt) }
}
