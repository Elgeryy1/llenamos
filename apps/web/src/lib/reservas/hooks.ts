"use client"

/** Ganchos del panel del día: el reloj, los datos del día juntos y las acciones sobre una reserva. */
import { type ReservationWithId } from "@llenamos/core"
import { useCallback, useEffect, useMemo, useState } from "react"
import { combineLive, useSala, type SalaData } from "@/lib/data/hooks"
import { useDayReservations, useReservationSettings, type SettingsDoc } from "@/lib/data/reservas"
import { llamarCore } from "@/lib/data/callables"
import { describeError, type ErrorInfo } from "@/lib/firebase/errors"
import type { Live } from "@/lib/firebase/live"
import type { ReservationAction } from "./estados"

/** Instante actual que se renueva cada `intervalMs` (para retrasos y «ahora»). */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(id)
  }, [intervalMs])
  return now
}

export interface DayData {
  settings: SettingsDoc
  sala: SalaData
  reservations: ReservationWithId[]
  /** id de mesa → nombre («S4»). */
  tableNames: Map<string, string>
}

/** Configuración, plano y reservas de un día, en directo y juntos. */
export function useDayData(restaurantId: string, locationId: string | null, date: string, timezone: string): Live<DayData> {
  const settings = useReservationSettings(restaurantId, locationId, timezone)
  const sala = useSala(restaurantId, locationId)
  const config = settings.status === "ready" ? settings.data.config : null
  const reservations = useDayReservations(restaurantId, locationId, date, config)
  return useMemo(() => {
    const base = combineLive(settings, sala, (s, p) => ({ settings: s, sala: p }))
    return combineLive(base, reservations, (b, r) => ({
      ...b,
      reservations: r,
      tableNames: new Map(b.sala.tables.map((t) => [t.id, t.name] as const)),
    }))
  }, [settings, sala, reservations])
}

export interface ActionContext {
  restaurantId: string
  locationId: string
}

/**
 * Ejecuta una acción de estado o «sentar en la mesa sugerida» (asigna y luego sienta).
 * Las acciones que abren un diálogo (mesa, mover) no pasan por aquí.
 */
export async function runStatusAction(
  ctx: ActionContext,
  reservation: Pick<ReservationWithId, "id">,
  action: Extract<ReservationAction, { kind: "status" | "seatAt" }>,
  reason?: string,
): Promise<void> {
  const base = { restaurantId: ctx.restaurantId, locationId: ctx.locationId, reservationId: reservation.id }
  if (action.kind === "seatAt") {
    await llamarCore("asignarMesas", { ...base, tableIds: action.tableIds })
    await llamarCore("cambiarEstadoReserva", { ...base, status: "seated" })
    return
  }
  await llamarCore("cambiarEstadoReserva", { ...base, status: action.to, reason: reason?.trim() ? reason.trim() : null })
}

/** Estado de una operación con el servidor: en marcha, error en castellano y repetir. */
export function useMutation<A extends unknown[]>(fn: (...args: A) => Promise<void>) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ErrorInfo | null>(null)
  const run = useCallback(
    async (...args: A): Promise<boolean> => {
      setPending(true)
      setError(null)
      try {
        await fn(...args)
        return true
      } catch (e) {
        setError(describeError(e))
        return false
      } finally {
        setPending(false)
      }
    },
    [fn],
  )
  const reset = useCallback(() => setError(null), [])
  return { run, pending, error, reset }
}
