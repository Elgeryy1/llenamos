/**
 * Callables de fidelización, promociones y Repite (fase 5). Región europe-west1.
 *
 * Entradas estrictas e instantes en ms UTC. Ninguna entrada trae saldos, importes de descuento,
 * autor, estados ni usos: los calcula el servidor con la cuenta y el libro vigentes. Toda mutación
 * lleva `requestId`; repetirla con la misma entrada devuelve el resultado original y con otra
 * entrada, `already-exists`. Este archivo no importa `api.ts`.
 */
import { z } from "zod"
import { AmountCentsSchema } from "./caja/modelo"
import { CustomerIdSchema } from "./ids"
import { DocIdSchema } from "./model"
import type { Module } from "./modules"
import type { Permission } from "./roles"
import { MillisSchema } from "./timestamp"
import {
  LoyaltyRewardInputSchema, LoyaltySettingsSchema, PROMOTION_CHANNELS, PROMOTION_STATUSES, PromotionInputSchema,
} from "./fidelizacion/modelo"
import { PROMOTION_REJECTIONS } from "./fidelizacion/promociones"
import { RepiteCardStateSchema, RepiteMonthSchema, RepiteOwnerSettingsSchema, REPITE_ERROR_CODES } from "./fidelizacion/repite"

const Rid = { restaurantId: DocIdSchema }
const RMutation = { ...Rid, requestId: DocIdSchema }
const Scope = { restaurantId: DocIdSchema, locationId: DocIdSchema }
const Mutation = { ...Scope, requestId: DocIdSchema }
const Ok = z.literal(true)
const Reason = z.string().trim().min(1, "Escribe el motivo.").max(200)
const Revision = z.number().int().min(1)
const Points = z.number().int().min(0)

/** Respuesta de algo que depende de Repite: o el dato, o por qué no está (nunca un dato inventado). */
const RepiteUnavailable = z.object({ status: z.enum(REPITE_ERROR_CODES), message: z.string() })

/* Programa de puntos ---------------------------------------------------------------- */

export const GuardarConfiguracionFidelizacionInputSchema = z.strictObject({ ...RMutation, settings: LoyaltySettingsSchema })
export const GuardarConfiguracionFidelizacionOutputSchema = z.object({ ok: Ok })

export const GuardarPremioInputSchema = z.strictObject({ ...RMutation, rewardId: DocIdSchema.nullable(), expectedRevision: Revision.nullable(), reward: LoyaltyRewardInputSchema })
export const GuardarPremioOutputSchema = z.object({ rewardId: DocIdSchema, revision: Revision })

/** Alta en el programa con el cliente delante: el personal confirma que acepta las condiciones. */
export const AltaFidelizacionInputSchema = z.strictObject({ ...RMutation, customerId: CustomerIdSchema, acceptedTermsVersion: z.string().trim().min(1).max(40) })
export const AltaFidelizacionOutputSchema = z.object({ balance: Points, enrolledAt: MillisSchema, alreadyEnrolled: z.boolean() })

export const VerCuentaFidelizacionInputSchema = z.strictObject({ ...Rid, customerId: CustomerIdSchema })
export const VerCuentaFidelizacionOutputSchema = z.object({
  enrolled: z.boolean(),
  /** Puntos que se pueden canjear ahora (sin los caducados aunque el proceso no haya pasado). */
  available: Points,
  expiringIn30Days: Points,
  earned: Points, redeemed: Points, expired: Points,
  movements: z.array(z.object({ id: DocIdSchema, kind: z.string(), points: z.number().int(), balanceAfter: Points, at: MillisSchema, reason: z.string().nullable() })).max(50),
  rewards: z.array(z.object({ rewardId: DocIdSchema, name: z.string(), pointsCost: z.number().int().min(1), affordable: z.boolean() })),
})

/** Canje contra una cuenta abierta de caja. El descuento lo calcula el servidor con el premio. */
export const CanjearPuntosInputSchema = z.strictObject({ ...Mutation, customerId: CustomerIdSchema, rewardId: DocIdSchema, billId: DocIdSchema, expectedBillRevision: Revision })
export const CanjearPuntosOutputSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("applied"), redemptionId: DocIdSchema, points: z.number().int().min(1), discountCents: AmountCentsSchema, available: Points, billRevision: Revision }),
  z.object({ status: z.literal("insufficient"), available: Points, pointsCost: z.number().int().min(1) }),
])
/** Deshace un canje mientras la cuenta no esté cobrada: devuelve los puntos y quita el descuento. */
export const AnularCanjeInputSchema = z.strictObject({ ...Mutation, redemptionId: DocIdSchema, expectedBillRevision: Revision, reason: Reason })
export const AnularCanjeOutputSchema = z.object({ available: Points, billRevision: Revision })

export const AjustarPuntosInputSchema = z.strictObject({
  ...RMutation, customerId: CustomerIdSchema,
  points: z.number().int().min(-1_000_000).max(1_000_000).refine((v) => v !== 0, "El ajuste no puede ser cero."), reason: Reason,
})
export const AjustarPuntosOutputSchema = z.object({ movementId: DocIdSchema, available: Points })

/* Promociones ------------------------------------------------------------------------ */

export const GuardarPromocionInputSchema = z.strictObject({ ...RMutation, promotionId: DocIdSchema.nullable(), expectedRevision: Revision.nullable(), promotion: PromotionInputSchema })
export const GuardarPromocionOutputSchema = z.object({ promotionId: DocIdSchema, revision: Revision, status: z.enum(PROMOTION_STATUSES) })
export const CambiarEstadoPromocionInputSchema = z.strictObject({ ...RMutation, promotionId: DocIdSchema, expectedRevision: Revision, to: z.enum(["active", "paused", "archived"]) })
export const CambiarEstadoPromocionOutputSchema = z.object({ revision: Revision, status: z.enum(PROMOTION_STATUSES) })

/** Qué promociones valen ahora para esta cuenta y cuánto descontarían (sin aplicar nada). */
export const PromocionesAplicablesInputSchema = z.strictObject({ ...Scope, billId: DocIdSchema, code: z.string().trim().toUpperCase().max(20).nullable().default(null) })
export const PromocionesAplicablesOutputSchema = z.object({
  channel: z.enum(PROMOTION_CHANNELS),
  best: z.object({ promotionId: DocIdSchema, name: z.string(), discountCents: AmountCentsSchema }).nullable(),
  evaluations: z.array(z.object({ promotionId: DocIdSchema, name: z.string(), eligible: z.boolean(), discountCents: AmountCentsSchema.nullable(), reason: z.enum(PROMOTION_REJECTIONS).nullable() })),
})
/**
 * Aplica una promoción a la cuenta (una por cuenta). El servidor vuelve a evaluarla con la cuenta,
 * la hora y los cupos de la transacción; si ya no vale, `rejected` con el motivo.
 */
export const AplicarPromocionInputSchema = z.strictObject({ ...Mutation, billId: DocIdSchema, expectedBillRevision: Revision, promotionId: DocIdSchema, code: z.string().trim().toUpperCase().max(20).nullable().default(null) })
export const AplicarPromocionOutputSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("applied"), discountCents: AmountCentsSchema, billRevision: Revision, totalCents: AmountCentsSchema }),
  z.object({ status: z.literal("rejected"), reason: z.enum(PROMOTION_REJECTIONS), message: z.string() }),
])
export const QuitarPromocionInputSchema = z.strictObject({ ...Mutation, billId: DocIdSchema, expectedBillRevision: Revision, reason: Reason })
export const QuitarPromocionOutputSchema = z.object({ billRevision: Revision, totalCents: AmountCentsSchema })

/* Repite ----------------------------------------------------------------------------- */

/** Solo LogiQD (claim `logiqd`): qué comercio de Repite corresponde a este restaurante. */
export const VincularRepiteInputSchema = z.strictObject({ ...RMutation, merchantId: z.string().regex(/^[a-z0-9-]{2,60}$/).nullable(), reason: Reason })
export const VincularRepiteOutputSchema = z.object({ ok: Ok })
export const GuardarAjustesRepiteInputSchema = z.strictObject({ ...RMutation, settings: RepiteOwnerSettingsSchema })
export const GuardarAjustesRepiteOutputSchema = z.object({ ok: Ok, connected: z.boolean() })
export const CrearTarjetaRepiteInputSchema = z.strictObject({ ...RMutation, customerId: CustomerIdSchema })
export const CrearTarjetaRepiteOutputSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ready"), cardId: z.string(), saveUrl: z.string().nullable() }),
  /** Se encoló y se reintentará; la ficha lo enseña como pendiente. */
  z.object({ status: z.literal("queued") }),
  RepiteUnavailable.extend({ status: z.enum(["not_configured", "unauthorized", "invalid"]) }),
])
export const VerTarjetaRepiteInputSchema = z.strictObject({ ...Rid, customerId: CustomerIdSchema })
export const VerTarjetaRepiteOutputSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ready"), card: RepiteCardStateSchema, fetchedAt: MillisSchema }),
  z.object({ status: z.literal("no_card") }),
  RepiteUnavailable.extend({ status: z.enum(REPITE_ERROR_CODES) }),
])
/** Sello a mano para una visita (si el automático falló o no estaba activo). Misma clave, sin duplicar. */
export const DarSelloRepiteInputSchema = z.strictObject({ ...Mutation, customerId: CustomerIdSchema, reservationId: DocIdSchema.nullable(), sessionId: DocIdSchema.nullable() })
  .refine((v) => v.reservationId !== null || v.sessionId !== null, "Elige la reserva o la mesa de la visita.")
export const DarSelloRepiteOutputSchema = z.object({ operationId: z.string(), status: z.enum(["queued", "done", "duplicate", "not_configured", "failed"]) })
/** Aviso «te echamos de menos» en la tarjeta del Wallet, para clientes con tarjeta (máximo 100). */
export const AvisarTeEchamosDeMenosInputSchema = z.strictObject({ ...RMutation, customerIds: z.array(CustomerIdSchema).min(1).max(100) })
export const AvisarTeEchamosDeMenosOutputSchema = z.object({
  queued: z.number().int().min(0),
  skipped: z.array(z.object({ customerId: CustomerIdSchema, reason: z.enum(["no_card", "withdrawn", "already_today"]) })),
})
export const InformeRepiteInputSchema = z.strictObject({ ...Rid, month: RepiteMonthSchema })
export const InformeRepiteOutputSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ready"), month: z.string(), visits: Points, newCustomers: Points, returningCustomers: Points,
    rewardsRedeemed: Points, noticesSent: Points, returnedAfterNotice: Points,
    previous: z.object({ visits: Points, newCustomers: Points, returningCustomers: Points, rewardsRedeemed: Points, noticesSent: Points, returnedAfterNotice: Points }).nullable(),
  }),
  RepiteUnavailable.extend({ status: z.enum(REPITE_ERROR_CODES) }),
])

/* Registro ---------------------------------------------------------------------------- */

export const CALLABLES_FASE5_FIDELIZACION = {
  guardarConfiguracionFidelizacion: "guardarConfiguracionFidelizacion",
  guardarPremio: "guardarPremio",
  altaFidelizacion: "altaFidelizacion",
  verCuentaFidelizacion: "verCuentaFidelizacion",
  canjearPuntos: "canjearPuntos",
  anularCanje: "anularCanje",
  ajustarPuntos: "ajustarPuntos",
  guardarPromocion: "guardarPromocion",
  cambiarEstadoPromocion: "cambiarEstadoPromocion",
  promocionesAplicables: "promocionesAplicables",
  aplicarPromocion: "aplicarPromocion",
  quitarPromocion: "quitarPromocion",
  vincularRepite: "vincularRepite",
  guardarAjustesRepite: "guardarAjustesRepite",
  crearTarjetaRepite: "crearTarjetaRepite",
  verTarjetaRepite: "verTarjetaRepite",
  darSelloRepite: "darSelloRepite",
  avisarTeEchamosDeMenos: "avisarTeEchamosDeMenos",
  informeRepite: "informeRepite",
} as const

export const CALLABLE_SCHEMAS_FASE5_FIDELIZACION = {
  guardarConfiguracionFidelizacion: { input: GuardarConfiguracionFidelizacionInputSchema, output: GuardarConfiguracionFidelizacionOutputSchema },
  guardarPremio: { input: GuardarPremioInputSchema, output: GuardarPremioOutputSchema },
  altaFidelizacion: { input: AltaFidelizacionInputSchema, output: AltaFidelizacionOutputSchema },
  verCuentaFidelizacion: { input: VerCuentaFidelizacionInputSchema, output: VerCuentaFidelizacionOutputSchema },
  canjearPuntos: { input: CanjearPuntosInputSchema, output: CanjearPuntosOutputSchema },
  anularCanje: { input: AnularCanjeInputSchema, output: AnularCanjeOutputSchema },
  ajustarPuntos: { input: AjustarPuntosInputSchema, output: AjustarPuntosOutputSchema },
  guardarPromocion: { input: GuardarPromocionInputSchema, output: GuardarPromocionOutputSchema },
  cambiarEstadoPromocion: { input: CambiarEstadoPromocionInputSchema, output: CambiarEstadoPromocionOutputSchema },
  promocionesAplicables: { input: PromocionesAplicablesInputSchema, output: PromocionesAplicablesOutputSchema },
  aplicarPromocion: { input: AplicarPromocionInputSchema, output: AplicarPromocionOutputSchema },
  quitarPromocion: { input: QuitarPromocionInputSchema, output: QuitarPromocionOutputSchema },
  vincularRepite: { input: VincularRepiteInputSchema, output: VincularRepiteOutputSchema },
  guardarAjustesRepite: { input: GuardarAjustesRepiteInputSchema, output: GuardarAjustesRepiteOutputSchema },
  crearTarjetaRepite: { input: CrearTarjetaRepiteInputSchema, output: CrearTarjetaRepiteOutputSchema },
  verTarjetaRepite: { input: VerTarjetaRepiteInputSchema, output: VerTarjetaRepiteOutputSchema },
  darSelloRepite: { input: DarSelloRepiteInputSchema, output: DarSelloRepiteOutputSchema },
  avisarTeEchamosDeMenos: { input: AvisarTeEchamosDeMenosInputSchema, output: AvisarTeEchamosDeMenosOutputSchema },
  informeRepite: { input: InformeRepiteInputSchema, output: InformeRepiteOutputSchema },
} as const satisfies Record<keyof typeof CALLABLES_FASE5_FIDELIZACION, { input: z.ZodType; output: z.ZodType }>

/** Permiso y módulos de cada callable. `logiqd`: claim del equipo interno, no un permiso de la matriz. */
export type Fase5Permission = Permission | "logiqd" | "public"
export const FASE5_FIDELIZACION_ACCESS: Record<keyof typeof CALLABLES_FASE5_FIDELIZACION, { permission: Fase5Permission; modules: readonly Module[] }> = {
  guardarConfiguracionFidelizacion: { permission: "fidelizacion.gestionar", modules: ["loyalty"] },
  guardarPremio: { permission: "fidelizacion.gestionar", modules: ["loyalty"] },
  altaFidelizacion: { permission: "fidelizacion.operar", modules: ["loyalty"] },
  verCuentaFidelizacion: { permission: "fidelizacion.ver", modules: ["loyalty"] },
  canjearPuntos: { permission: "fidelizacion.operar", modules: ["loyalty", "pos"] },
  anularCanje: { permission: "fidelizacion.operar", modules: ["loyalty", "pos"] },
  ajustarPuntos: { permission: "fidelizacion.gestionar", modules: ["loyalty"] },
  guardarPromocion: { permission: "promociones.gestionar", modules: ["loyalty"] },
  cambiarEstadoPromocion: { permission: "promociones.gestionar", modules: ["loyalty"] },
  promocionesAplicables: { permission: "promociones.aplicar", modules: ["loyalty", "pos"] },
  aplicarPromocion: { permission: "promociones.aplicar", modules: ["loyalty", "pos"] },
  quitarPromocion: { permission: "promociones.aplicar", modules: ["loyalty", "pos"] },
  vincularRepite: { permission: "logiqd", modules: [] },
  guardarAjustesRepite: { permission: "fidelizacion.gestionar", modules: ["repite"] },
  crearTarjetaRepite: { permission: "fidelizacion.operar", modules: ["repite"] },
  verTarjetaRepite: { permission: "fidelizacion.ver", modules: ["repite"] },
  darSelloRepite: { permission: "fidelizacion.operar", modules: ["repite"] },
  avisarTeEchamosDeMenos: { permission: "fidelizacion.gestionar", modules: ["repite"] },
  informeRepite: { permission: "fidelizacion.gestionar", modules: ["repite"] },
}
