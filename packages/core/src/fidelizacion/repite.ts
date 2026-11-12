/**
 * Repite (fase 5): Llenamos habla con el servicio Repite (`LogiQD/repite`, tarjeta de sellos en
 * Google Wallet) a través de este adaptador. Repite es la única fuente de verdad de tarjetas y
 * sellos: Llenamos guarda solo el enlace cliente ↔ tarjeta y la cola de operaciones pendientes.
 *
 * El contrato de la API que Llenamos espera de Repite está en `docs/integraciones/repite-api.md`.
 * Hoy esa API **no existe**: Repite guarda sus pilotos en un JSON y tiene otra API para HQ. Hasta
 * que exista, el backend usa el doble local de este archivo en pruebas y emuladores, y fuera de
 * ellos devuelve `not_configured`. Nunca se simula un sello como si se hubiera dado de verdad.
 */
import { z } from "zod"
import { DocIdSchema } from "../model"
import { MillisSchema, TimestampSchema } from "../timestamp"

/* Ajustes y enlace ---------------------------------------------------------- */

export const REPITE_STAMP_TRIGGERS = ["seated", "paid", "both"] as const
export type RepiteStampTrigger = (typeof REPITE_STAMP_TRIGGERS)[number]

/** `settings/repite`. `merchantId` lo fija solo LogiQD (`vincularRepite`); lo demás, el encargado. */
export const RepiteSettingsSchema = z.strictObject({
  merchantId: z.string().regex(/^[a-z0-9-]{2,60}$/).nullable(),
  enabled: z.boolean(),
  /** Cuándo se da el sello. Con `both` se da en lo primero que pase y lo segundo es duplicado. */
  stampOn: z.enum(REPITE_STAMP_TRIGGERS),
  /** Crear la tarjeta sola al dar el primer sello a un cliente que no la tiene. */
  autoCreateCard: z.boolean(),
})
export type RepiteSettings = z.infer<typeof RepiteSettingsSchema>
export function defaultRepiteSettings(): RepiteSettings {
  return { merchantId: null, enabled: false, stampOn: "seated", autoCreateCard: false }
}
/** Lo que guarda el encargado (sin `merchantId`). */
export const RepiteOwnerSettingsSchema = RepiteSettingsSchema.omit({ merchantId: true })

/**
 * `repiteCards/{customerId}`: enlace con la tarjeta de Repite. `externalRef` es un id opaco aleatorio
 * que Llenamos manda a Repite en lugar del teléfono o del id del cliente (minimización de datos).
 */
export const RepiteCardLinkSchema = z.object({
  merchantId: z.string(),
  cardId: z.string().min(1).max(100),
  externalRef: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  status: z.enum(["active", "removed"]),
  createdAt: TimestampSchema,
})
export type RepiteCardLink = z.infer<typeof RepiteCardLinkSchema>

/* Interfaz del adaptador ------------------------------------------------------ */

export const REPITE_ERROR_CODES = ["not_configured", "unavailable", "invalid", "not_found", "conflict", "rate_limited", "unauthorized"] as const
export type RepiteErrorCode = (typeof REPITE_ERROR_CODES)[number]
export interface RepiteError { code: RepiteErrorCode; message: string; retryable: boolean }
export type RepiteResult<T> = { ok: true; value: T } | { ok: false; error: RepiteError }

export interface RepiteCard {
  cardId: string
  /** Enlace para guardar la tarjeta en Google Wallet (o Samsung Wallet); null si aún no hay. */
  saveUrl: string | null
}
export interface RepiteStamp {
  stampId: string
  stamps: number
  stampsForReward: number
  rewardReady: boolean
  /** true si ese mismo `idempotencyKey` ya se había usado: no se ha dado otro sello. */
  duplicate: boolean
}
export interface RepiteCardState {
  cardId: string
  status: "active" | "removed"
  stamps: number
  stampsForReward: number
  rewardsAvailable: number
  inWallet: boolean
  lastStampAt: number | null
}
export interface RepiteNotice { status: "scheduled" | "rate_limited" | "not_in_wallet"; noticeId: string | null; duplicate: boolean }
export interface RepiteMonthReport {
  month: string
  visits: number
  newCustomers: number
  returningCustomers: number
  rewardsRedeemed: number
  noticesSent: number
  returnedAfterNotice: number
  /** El mismo informe del mes anterior para comparar, o null si no hay datos. */
  previous: Omit<RepiteMonthReport, "previous" | "month"> | null
}

/** Lo que Llenamos necesita de Repite. Toda operación que cambia algo lleva `idempotencyKey`. */
export interface RepiteAdapter {
  createCard(p: { merchantId: string; externalRef: string; displayName: string; language: "es" | "ca" | "en"; idempotencyKey: string }): Promise<RepiteResult<RepiteCard>>
  addStamp(p: { merchantId: string; cardId: string; visitKey: string; trigger: "seated" | "paid" | "manual"; occurredAt: number; idempotencyKey: string }): Promise<RepiteResult<RepiteStamp>>
  getCard(p: { merchantId: string; cardId: string }): Promise<RepiteResult<RepiteCardState>>
  sendWeMissYou(p: { merchantId: string; cardId: string; idempotencyKey: string }): Promise<RepiteResult<RepiteNotice>>
  monthReport(p: { merchantId: string; month: string }): Promise<RepiteResult<RepiteMonthReport>>
  /** Borrado por privacidad (fase 6): la tarjeta deja de existir en Repite y en el Wallet. */
  removeCard(p: { merchantId: string; cardId: string; idempotencyKey: string }): Promise<RepiteResult<{ removed: true; duplicate: boolean }>>
}

/** Adaptador cuando no hay conexión configurada: lo dice siempre, nunca inventa. */
export function notConfiguredRepite(): RepiteAdapter {
  const error = { ok: false as const, error: { code: "not_configured" as const, message: "Repite no está conectado en este restaurante.", retryable: false } }
  return {
    createCard: async () => error, addStamp: async () => error, getCard: async () => error,
    sendWeMissYou: async () => error, monthReport: async () => error, removeCard: async () => error,
  }
}

/* Sello sin duplicar ---------------------------------------------------------- */

/**
 * Clave de visita: la misma al sentar y al cobrar, para que con `both` (o con un reintento) solo
 * haya un sello. Con reserva manda la reserva; sin ella, la mesa abierta; para llevar, el pedido.
 */
export function repiteVisitKey(p: { restaurantId: string; reservationId: string | null; sessionId: string | null; takeawayId?: string | null }): string {
  if (p.reservationId) return `${p.restaurantId}.r.${p.reservationId}`
  if (p.sessionId) return `${p.restaurantId}.s.${p.sessionId}`
  if (p.takeawayId) return `${p.restaurantId}.t.${p.takeawayId}`
  throw new Error("Hace falta una reserva, una mesa o un pedido para el sello.")
}

/** ¿Este hecho da sello con estos ajustes? */
export function repiteStampApplies(settings: RepiteSettings, trigger: "seated" | "paid"): boolean {
  return settings.enabled && settings.merchantId !== null && (settings.stampOn === "both" || settings.stampOn === trigger)
}

export const REPITE_OPERATION_KINDS = ["create_card", "add_stamp", "we_miss_you", "remove_card"] as const
export const REPITE_OPERATION_STATUSES = ["queued", "leased", "done", "duplicate", "failed", "not_configured", "skipped"] as const
/**
 * `repiteOutbox/{id}` (solo servidor). Se crea en la misma transacción que el hecho (o en su
 * disparador, si no existe ya) con id determinista: `stamp.{visitKey}`, `card.{customerId}`,
 * `missyou.{customerId}.{AAAA-MM-DD}`, `remove.{customerId}`. El trabajador llama al adaptador con `id` como clave de
 * idempotencia y guarda el resultado.
 */
export const RepiteOperationSchema = z.object({
  kind: z.enum(REPITE_OPERATION_KINDS),
  customerId: DocIdSchema,
  merchantId: z.string(),
  visitKey: z.string().nullable(),
  trigger: z.enum(["seated", "paid", "manual"]).nullable(),
  occurredAt: TimestampSchema,
  status: z.enum(REPITE_OPERATION_STATUSES),
  attempts: z.number().int().min(0),
  nextAttemptAt: TimestampSchema.nullable(),
  leaseUntil: TimestampSchema.nullable(),
  lastError: z.object({ code: z.enum(REPITE_ERROR_CODES), message: z.string().max(300) }).nullable(),
  result: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).nullable(),
})
export type RepiteOperation = z.infer<typeof RepiteOperationSchema>

export const repiteOperationId = {
  stamp: (visitKey: string) => `stamp.${visitKey}`,
  card: (customerId: string) => `card.${customerId}`,
  weMissYou: (customerId: string, date: string) => `missyou.${customerId}.${date}`,
  remove: (customerId: string) => `remove.${customerId}`,
}

/** Siguiente intento: 30 s, se duplica hasta 6 h; tras 12 intentos se deja en `failed`. */
export function nextRepiteAttempt(attempts: number, now: number): number | null {
  if (attempts >= 12) return null
  return now + Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 6 * 3_600_000)
}

/** Qué hacer con la respuesta del adaptador. */
export function settleRepiteOperation(op: Pick<RepiteOperation, "attempts">, result: RepiteResult<unknown>, now: number): Pick<RepiteOperation, "status" | "attempts" | "nextAttemptAt" | "lastError"> {
  const attempts = op.attempts + 1
  if (result.ok) {
    const dup = typeof result.value === "object" && result.value !== null && "duplicate" in result.value && result.value.duplicate === true
    return { status: dup ? "duplicate" : "done", attempts, nextAttemptAt: null, lastError: null }
  }
  const lastError = { code: result.error.code, message: result.error.message.slice(0, 300) }
  if (result.error.code === "not_configured") return { status: "not_configured", attempts, nextAttemptAt: null, lastError }
  const next = result.error.retryable ? nextRepiteAttempt(attempts, now) : null
  return { status: next === null ? "failed" : "queued", attempts, nextAttemptAt: next, lastError }
}

/* Doble local para pruebas y emuladores ----------------------------------------- */

export interface LocalRepiteOptions {
  merchantIds: readonly string[]
  stampsForReward?: number
  /** Repite real: como mucho un sello cada 4 horas por tarjeta. */
  minMinutesBetweenStamps?: number
  now: () => number
}

/**
 * Doble en memoria con el comportamiento que el contrato exige: idempotencia por clave, una visita
 * un sello, sellos con espera mínima, avisos con límite semanal e informe mensual. `failNext`
 * fuerza el siguiente error para probar reintentos. No hace red ni guarda nada fuera de memoria.
 */
export function createLocalRepite(options: LocalRepiteOptions) {
  const total = options.stampsForReward ?? 10
  const gapMs = (options.minMinutesBetweenStamps ?? 240) * 60_000
  const cards = new Map<string, { merchantId: string; externalRef: string; stamps: number; rewards: number; lastStampAt: number | null; inWallet: boolean; createdAt: number; notices: number[] }>()
  const keys = new Map<string, unknown>()
  const visits = new Set<string>()
  const stampsLog: { merchantId: string; cardId: string; at: number }[] = []
  let failure: RepiteError | null = null
  let seq = 0

  const err = (code: RepiteErrorCode, message: string, retryable = false) => ({ ok: false as const, error: { code, message, retryable } })
  const guard = (merchantId: string) => {
    if (failure) {
      const e = failure
      failure = null
      return { ok: false as const, error: e }
    }
    return options.merchantIds.includes(merchantId) ? null : err("unauthorized", "Ese comercio no existe en Repite.")
  }
  const once = <T>(key: string, run: () => RepiteResult<T>): RepiteResult<T> => {
    if (keys.has(key)) {
      const prev = keys.get(key) as RepiteResult<T>
      return prev.ok && typeof prev.value === "object" && prev.value !== null ? { ok: true, value: { ...prev.value, duplicate: true } } : prev
    }
    const result = run()
    if (result.ok) keys.set(key, result)
    return result
  }

  const adapter: RepiteAdapter = {
    async createCard(p) {
      const g = guard(p.merchantId)
      if (g) return g
      const existing = [...cards.entries()].find(([, c]) => c.merchantId === p.merchantId && c.externalRef === p.externalRef)
      if (existing) return { ok: true, value: { cardId: existing[0], saveUrl: `https://repite.local/wallet/${existing[0]}` } }
      return once<RepiteCard>(p.idempotencyKey, () => {
        const cardId = `tarjeta-${++seq}`
        cards.set(cardId, { merchantId: p.merchantId, externalRef: p.externalRef, stamps: 0, rewards: 0, lastStampAt: null, inWallet: false, createdAt: options.now(), notices: [] })
        return { ok: true, value: { cardId, saveUrl: `https://repite.local/wallet/${cardId}` } }
      })
    },
    async addStamp(p) {
      const g = guard(p.merchantId)
      if (g) return g
      const card = cards.get(p.cardId)
      if (!card || card.merchantId !== p.merchantId) return err("not_found", "No existe esa tarjeta.")
      return once<RepiteStamp>(p.idempotencyKey, () => {
        if (visits.has(`${p.merchantId}.${p.visitKey}`)) return { ok: true, value: { stampId: `visita-${p.visitKey}`, stamps: card.stamps, stampsForReward: total, rewardReady: card.rewards > 0, duplicate: true } }
        const at = options.now()
        if (p.trigger !== "manual" && card.lastStampAt !== null && at - card.lastStampAt < gapMs) return err("conflict", "Esta tarjeta ya tiene un sello reciente.")
        visits.add(`${p.merchantId}.${p.visitKey}`)
        card.stamps += 1
        card.lastStampAt = at
        if (card.stamps >= total) {
          card.stamps -= total
          card.rewards += 1
        }
        stampsLog.push({ merchantId: p.merchantId, cardId: p.cardId, at })
        return { ok: true, value: { stampId: `sello-${++seq}`, stamps: card.stamps, stampsForReward: total, rewardReady: card.rewards > 0, duplicate: false } }
      })
    },
    async getCard(p) {
      const g = guard(p.merchantId)
      if (g) return g
      const card = cards.get(p.cardId)
      if (!card || card.merchantId !== p.merchantId) return err("not_found", "No existe esa tarjeta.")
      return { ok: true, value: { cardId: p.cardId, status: "active", stamps: card.stamps, stampsForReward: total, rewardsAvailable: card.rewards, inWallet: card.inWallet, lastStampAt: card.lastStampAt } }
    },
    async sendWeMissYou(p) {
      const g = guard(p.merchantId)
      if (g) return g
      const card = cards.get(p.cardId)
      if (!card || card.merchantId !== p.merchantId) return err("not_found", "No existe esa tarjeta.")
      return once<RepiteNotice>(p.idempotencyKey, () => {
        if (!card.inWallet) return { ok: true, value: { status: "not_in_wallet", noticeId: null, duplicate: false } }
        const at = options.now()
        if (card.notices.some((n) => at - n < 7 * 86_400_000)) return { ok: true, value: { status: "rate_limited", noticeId: null, duplicate: false } }
        card.notices.push(at)
        return { ok: true, value: { status: "scheduled", noticeId: `aviso-${++seq}`, duplicate: false } }
      })
    },
    async monthReport(p) {
      const g = guard(p.merchantId)
      if (g) return g
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(p.month)) return err("invalid", "Mes no válido.")
      const inMonth = (at: number, month: string) => new Date(at).toISOString().slice(0, 7) === month
      const count = (month: string) => {
        const visitsOf = stampsLog.filter((s) => s.merchantId === p.merchantId && inMonth(s.at, month))
        const newOnes = [...cards.values()].filter((c) => c.merchantId === p.merchantId && inMonth(c.createdAt, month)).length
        const byCard = new Map<string, number>()
        for (const v of visitsOf) byCard.set(v.cardId, (byCard.get(v.cardId) ?? 0) + 1)
        return { visits: visitsOf.length, newCustomers: newOnes, returningCustomers: [...byCard.values()].filter((n) => n > 1).length, rewardsRedeemed: 0, noticesSent: 0, returnedAfterNotice: 0 }
      }
      const [y, m] = p.month.split("-").map(Number) as [number, number]
      const prevMonth = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`
      const previous = count(prevMonth)
      return { ok: true, value: { month: p.month, ...count(p.month), previous: previous.visits === 0 && previous.newCustomers === 0 ? null : previous } }
    },
    async removeCard(p) {
      const g = guard(p.merchantId)
      if (g) return g
      return once<{ removed: true; duplicate: boolean }>(p.idempotencyKey, () => {
        const card = cards.get(p.cardId)
        if (!card || card.merchantId !== p.merchantId) return err("not_found", "No existe esa tarjeta.")
        cards.delete(p.cardId)
        return { ok: true, value: { removed: true, duplicate: false } }
      })
    },
  }
  return {
    adapter,
    /** Simula que el cliente guarda la tarjeta en su Wallet. */
    markInWallet(cardId: string) { const c = cards.get(cardId); if (c) c.inWallet = true },
    failNext(error: RepiteError) { failure = error },
    stampsCount: () => stampsLog.length,
  }
}

/** Mes `AAAA-MM` válido para el informe. */
export const RepiteMonthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Usa un mes como 2026-11.")
export const RepiteCardStateSchema = z.object({
  cardId: z.string(), status: z.enum(["active", "removed"]), stamps: z.number().int().min(0), stampsForReward: z.number().int().min(1),
  rewardsAvailable: z.number().int().min(0), inWallet: z.boolean(), lastStampAt: MillisSchema.nullable(),
})
