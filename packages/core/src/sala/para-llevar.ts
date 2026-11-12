/**
 * Para llevar: horas de recogida.
 *
 * Se recoge dentro de los turnos de reservas del local (`settings/reservations`: semana,
 * excepciones y cierres), cada `takeaway.stepMinutes`, con `takeaway.minNoticeMinutes` de
 * antelación desde la web y como mucho `takeaway.maxOrdersPerSlot` pedidos por franja.
 * Usa el motor de reservas (`franjasDelDia`) para que los cambios de hora y los turnos que
 * cruzan la medianoche salgan igual que en las reservas.
 */
import { franjasDelDia, type ConfiguracionReservas } from "../reservas/horarios"
import type { Fecha, Hora } from "../reservas/tiempo"
import type { FloorSettings } from "./modelo"

const MINUTO = 60_000

export const PICKUP_SLOT_REASONS = ["min_notice", "slot_full"] as const
export type PickupSlotReason = (typeof PICKUP_SLOT_REASONS)[number]

export interface PickupSlot {
  time: Hora
  /** Fecha de pared (el día siguiente si el turno cruza la medianoche). */
  wallDate: Fecha
  startAt: number
  shift: string
  available: boolean
  reason: PickupSlotReason | null
  /** Pedidos que ya hay en esa franja. */
  orders: number
}

/**
 * Franjas de recogida de un día de servicio. `ordersBySlot` cuenta los para llevar no
 * anulados por instante de recogida. El personal (`staff: true`) se salta la antelación
 * y el límite por franja (lo enseña, pero deja elegir).
 */
export function pickupSlots(
  config: ConfiguracionReservas,
  takeaway: FloorSettings["takeaway"],
  date: Fecha,
  now: number,
  ordersBySlot: Readonly<Record<number, number>>,
  staff = false,
): PickupSlot[] {
  const franjas = franjasDelDia({ ...config, pasoMinutos: takeaway.stepMinutes }, date)
  return franjas.map((f) => {
    const orders = ordersBySlot[f.inicio] ?? 0
    let reason: PickupSlotReason | null = null
    if (f.inicio < now + takeaway.minNoticeMinutes * MINUTO) reason = "min_notice"
    else if (orders >= takeaway.maxOrdersPerSlot) reason = "slot_full"
    const pasada = f.inicio < now
    return {
      time: f.hora,
      wallDate: f.fecha,
      startAt: f.inicio,
      shift: f.turno,
      available: staff ? !pasada : reason === null,
      reason,
      orders,
    }
  })
}

/** La franja elegida, si existe y se puede: lo que comprueba `pedirParaLlevar` antes de guardar. */
export function findPickupSlot(slots: readonly PickupSlot[], time: Hora): PickupSlot | null {
  const s = slots.find((x) => x.time === time)
  return s && s.available ? s : null
}

/** Etiqueta para la cocina: «Para llevar · Ana · 21:30». */
export function takeawayLabel(guestName: string, pickupTime: Hora): string {
  const nombre = guestName.trim().split(/\s+/)[0] ?? guestName
  return `Para llevar · ${nombre} · ${pickupTime}`.slice(0, 80)
}
