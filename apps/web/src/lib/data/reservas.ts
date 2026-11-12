"use client"

/**
 * Datos de reservas en directo (fase 1): configuración del local, reservas de un día,
 * lista de espera, clientes y mensajes. Todo se valida con los esquemas de
 * @llenamos/core; si un documento no encaja, la interfaz dice cuál y qué campos.
 */
import {
  CustomerSchema,
  defaultReservationSettings,
  MessageRowSchema,
  MessageSchema,
  ReservationSchema,
  ReservationSettingsSchema,
  settingsToConfiguracion,
  WaitlistEntrySchema,
  type ConfiguracionReservas,
  type Customer,
  type Fecha,
  type Message,
  type ReservationSettings,
  type ReservationWithId,
  type WaitlistEntry,
} from "@llenamos/core"
import { useMemo } from "react"
import { z } from "zod"
import type { Live } from "@/lib/api/live"
import { isVpsBackend, mapLive, useVpsLive } from "./backend"
import { useDemoDoc, useDemoQuery } from "./demo-live"
import { belongsToDay, dayQueryWindow } from "@/lib/reservas/dia"
import { DataShapeError } from "./parse"

function parseWith<S extends z.ZodType>(schema: S, path: string, data: unknown): z.infer<S> {
  const result = schema.safeParse(data)
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((i) => i.path.join(".") || "documento"))]
    throw new DataShapeError(path, fields)
  }
  return result.data
}

const ReservationsDaySchema = z.object({ reservations: z.array(ReservationSchema.extend({ id: z.string() })) })

/* Parseo ------------------------------------------------------------------- */

export function parseReservation(id: string, data: unknown): ReservationWithId {
  return { id, ...parseWith(ReservationSchema, `reservations/${id}`, data) }
}

export type CustomerDoc = Customer & { id: string }

export function parseCustomer(id: string, data: unknown): CustomerDoc {
  return { id, ...parseWith(CustomerSchema, `customers/${id}`, data) }
}

export type WaitlistDoc = WaitlistEntry & { id: string }

export function parseWaitlistEntry(id: string, data: unknown): WaitlistDoc {
  return { id, ...parseWith(WaitlistEntrySchema, `waitlist/${id}`, data) }
}

export type MessageDoc = Message & { id: string }

export function parseMessage(id: string, data: unknown): MessageDoc {
  return { id, ...parseWith(MessageSchema, `messages/${id}`, data) }
}

export interface SettingsDoc {
  settings: ReservationSettings
  config: ConfiguracionReservas
  /** false si el local aún no ha guardado su configuración y se usan los valores por defecto. */
  saved: boolean
}

export function parseSettings(timezone: string) {
  return (id: string, data: unknown): SettingsDoc => {
    if (data === undefined) {
      const settings = defaultReservationSettings(timezone)
      return { settings, config: settingsToConfiguracion(settings), saved: false }
    }
    const settings = parseWith(ReservationSettingsSchema, `settings/${id}`, data)
    return { settings, config: settingsToConfiguracion(settings), saved: true }
  }
}

/* Ganchos ------------------------------------------------------------------ */

const locationPath = (rid: string, lid: string) => `restaurants/${rid}/locations/${lid}`

/** Configuración de reservas del local (o la de por defecto si no hay documento). */
export function useReservationSettings(rid: string, lid: string | null, timezone: string, enabled = true): Live<SettingsDoc> {
  const parse = useMemo(() => parseSettings(timezone), [timezone])
  const vps = isVpsBackend()
  const demo = useDemoDoc(!vps && enabled && lid ? `${locationPath(rid, lid)}/settings/reservations` : null, parse)
  const api = useVpsLive("ajustesReservas", enabled && lid ? { restaurantId: rid, locationId: lid } : null, z.object({ settings: ReservationSettingsSchema, saved: z.boolean() }))
  return useMemo(() => (vps ? mapLive(api, (a): SettingsDoc => ({ ...a, config: settingsToConfiguracion(a.settings) })) : demo), [vps, api, demo])
}

/**
 * Reservas de un día de servicio, en directo. Se piden las de dos días naturales (por los
 * turnos que cruzan la medianoche) y se quedan las que son de ese día.
 */
export function useDayReservations(
  rid: string,
  lid: string | null,
  date: Fecha,
  config: ConfiguracionReservas | null,
): Live<ReservationWithId[]> {
  const window = config ? dayQueryWindow(date, config.zonaHoraria) : null
  const path = lid ? `${locationPath(rid, lid)}/reservations` : ""
  const vps = isVpsBackend()
  const demo = useDemoQuery(
    !vps && lid && window
      ? { path, where: [["startAt", ">=", { ms: window.from }], ["startAt", "<", { ms: window.to }]], orderBy: ["startAt", "asc"] }
      : null,
    parseReservation,
  )
  const api = useVpsLive("reservasDia", lid && config ? { restaurantId: rid, locationId: lid, date } : null, ReservationsDaySchema)
  const live = useMemo(() => (vps ? mapLive(api, (a) => a.reservations as ReservationWithId[]) : demo), [vps, api, demo])
  return useMemo(() => {
    if (live.status !== "ready" || !config) return live
    return { status: "ready", data: live.data.filter((r) => belongsToDay(r.startAt, config, date)) }
  }, [live, config, date])
}

/** Entradas de la lista de espera de un día. */
export function useWaitlist(rid: string, lid: string | null, date: Fecha, enabled = true): Live<WaitlistDoc[]> {
  const path = lid ? `${locationPath(rid, lid)}/waitlist` : ""
  const vps = isVpsBackend()
  const demo = useDemoQuery(!vps && enabled && lid ? { path, where: [["date", "==", date]] } : null, parseWaitlistEntry)
  const api = useVpsLive("listaEsperaDia", enabled && lid ? { restaurantId: rid, locationId: lid, date } : null, z.object({ entries: z.array(WaitlistEntrySchema.extend({ id: z.string() })) }))
  return useMemo(() => (vps ? mapLive(api, (a) => a.entries) : demo), [vps, api, demo])
}

/** Fichas de cliente (las 1000 últimas por nombre; la búsqueda es en el navegador). */
export const CUSTOMERS_LIMIT = 1000

export function useCustomers(rid: string, enabled = true): Live<CustomerDoc[]> {
  const path = `restaurants/${rid}/customers`
  const vps = isVpsBackend()
  const demo = useDemoQuery(!vps && enabled ? { path, orderBy: ["name", "asc"], limit: CUSTOMERS_LIMIT } : null, parseCustomer)
  const api = useVpsLive("clientes", enabled ? { restaurantId: rid, limit: CUSTOMERS_LIMIT } : null, z.object({ customers: z.array(CustomerSchema.extend({ id: z.string() })) }))
  return useMemo(() => (vps ? mapLive(api, (a) => a.customers) : demo), [vps, api, demo])
}

/** Una ficha de cliente (null si aún no existe: la crea el servidor al guardar la reserva). */
export function useCustomer(rid: string, customerId: string | null): Live<CustomerDoc | null> {
  const vps = isVpsBackend()
  const demo = useDemoDoc(!vps && customerId ? `restaurants/${rid}/customers/${customerId}` : null, (id, data) =>
    data === undefined ? null : parseCustomer(id, data),
  )
  const api = useVpsLive("cliente", customerId ? { restaurantId: rid, customerId } : null, z.object({ customer: CustomerSchema.extend({ id: z.string() }).nullable() }))
  return useMemo(() => (vps ? mapLive(api, (a) => a.customer) : demo), [vps, api, demo])
}

/** Reservas de un cliente en un local, de la más reciente a la más antigua. */
export function useCustomerReservations(rid: string, lid: string | null, customerId: string | null, max = 20): Live<ReservationWithId[]> {
  const path = lid ? `${locationPath(rid, lid)}/reservations` : ""
  const vps = isVpsBackend()
  const demoLive = useDemoQuery(!vps && lid && customerId ? { path, where: [["customerId", "==", customerId]] } : null, parseReservation)
  const api = useVpsLive("reservasCliente", lid && customerId ? { restaurantId: rid, locationId: lid, customerId, limit: max } : null, ReservationsDaySchema)
  const live = useMemo(() => (vps ? mapLive(api, (a) => a.reservations as ReservationWithId[]) : demoLive), [vps, api, demoLive])
  // Se ordena aquí para no necesitar un índice compuesto (customerId + startAt).
  return useMemo(() => {
    if (live.status !== "ready") return live
    return { status: "ready", data: [...live.data].sort((a, b) => b.startAt - a.startAt).slice(0, max) }
  }, [live, max])
}

/** Mensajes de una reserva (solo quien tiene `mensajes.ver`). */
export function useReservationMessages(rid: string, reservationId: string | null, enabled: boolean): Live<MessageDoc[]> {
  const path = `restaurants/${rid}/messages`
  const vps = isVpsBackend()
  const demoLive = useDemoQuery(!vps && enabled && reservationId ? { path, where: [["reservationId", "==", reservationId]] } : null, parseMessage)
  const api = useVpsLive("mensajesReserva", enabled && reservationId ? { restaurantId: rid, reservationId } : null, z.object({ messages: z.array(MessageRowSchema.extend({ id: z.string() })) }))
  const live = useMemo(() => (vps ? mapLive(api, (a) => a.messages) : demoLive), [vps, api, demoLive])
  return useMemo(() => {
    if (live.status !== "ready") return live
    return { status: "ready", data: [...live.data].sort((a, b) => a.sendAt - b.sendAt) }
  }, [live])
}
