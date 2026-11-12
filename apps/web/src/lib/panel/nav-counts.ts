"use client"

import { can, hasModule } from "@llenamos/core"
import { usePanel } from "@/components/panel/PanelContext"
import { useDayReservations, useReservationSettings, useWaitlist } from "@/lib/data/reservas"
import { isDropped, localDate } from "@/lib/reservas/dia"
import { useNow } from "@/lib/reservas/hooks"
import type { PanelSection } from "./nav"

/**
 * Cifras que acompañan a las secciones de la barra lateral: reservas activas de hoy y
 * personas esperando en la lista de espera de hoy, del local elegido. Salen de los datos
 * en directo; nunca se ponen cifras de relleno. Sin permiso o sin el módulo de reservas,
 * no se escucha nada y no se pinta nada.
 */
export function usePanelNavCounts(restaurantId: string): Partial<Record<PanelSection, number>> {
  const { restaurant, location, role } = usePanel()
  const enabled = restaurant.id === restaurantId && can(role, "reservas.ver") && hasModule(restaurant, "reservations")
  const lid = enabled ? (location?.id ?? null) : null
  const now = useNow(60_000)
  const tz = restaurant.timezone
  const today = localDate(now, tz)
  const settings = useReservationSettings(restaurantId, lid, tz)
  const reservations = useDayReservations(restaurantId, lid, today, settings.status === "ready" ? settings.data.config : null)
  const waitlist = useWaitlist(restaurantId, lid, today)

  if (!lid) return EMPTY
  const out: Partial<Record<PanelSection, number>> = {}
  if (reservations.status === "ready") out.reservas = reservations.data.filter((r) => !isDropped(r.status)).length
  if (waitlist.status === "ready") {
    const waiting = waitlist.data.filter((w) => w.status === "waiting" || w.status === "offered").length
    if (waiting > 0) out["lista-espera"] = waiting
  }
  return out
}

const EMPTY: Partial<Record<PanelSection, number>> = {}
