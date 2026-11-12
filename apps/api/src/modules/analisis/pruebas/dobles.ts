import { horaLocal, instanteDeHoraLocal, sumarDias, type LineCost } from '@llenamos/core'
import type { DayFacts } from '../puertos.js'

/** SOLO PARA PRUEBAS: hechos deterministas de un local y un día, para demostrar la lógica sin las tablas de caja, reservas y carta. */
export function fakeDayFacts(locationId: string, date: string, scale = 1): DayFacts {
  const at = (h: number, m = 0) => instanteDeHoraLocal(date, h * 60 + m, 'Europe/Madrid')!
  return {
    bills: [
      { billId: `${locationId}-${date}-1`, locationId, kind: 'session', openedAt: at(13, 30), settledAt: at(15), closedAt: at(15), orderedCents: 9000 * scale, invitationCents: 0, voidCents: 0, discountCents: 1000 * scale, totalCents: 8000 * scale, netCents: 7273 * scale, tipCents: 0, guests: 4 * scale },
      { billId: `${locationId}-${date}-2`, locationId, kind: 'takeaway', openedAt: at(20, 10), settledAt: at(20, 20), closedAt: null, orderedCents: 2000 * scale, invitationCents: 0, voidCents: 0, discountCents: 0, totalCents: 2000 * scale, netCents: 1818 * scale, tipCents: 0, guests: 0 },
    ],
    refunds: [],
    reservations: [
      { locationId, startAt: at(13, 30), partySize: 4, status: 'seated' },
      { locationId, startAt: at(21), partySize: 2, status: 'no_show' },
    ],
    capacity: { locationId, seats: 20, openMinutesByDate: { [date]: 360 } },
    sold: [
      { itemId: 'paella', kind: 'item', quantity: 3 * scale, netOfAdjustmentsCents: 6000 * scale },
      { itemId: 'flan', kind: 'item', quantity: 1 * scale, netOfAdjustmentsCents: 500 * scale },
      { itemId: 'paella', kind: 'menu_component', quantity: 1, netOfAdjustmentsCents: 0 },
    ],
    catalog: [
      { itemId: 'paella', name: 'Paella', active: true }, { itemId: 'flan', name: 'Flan', active: true },
      { itemId: 'tarta', name: 'Tarta', active: true }, { itemId: 'vieja', name: 'Vieja', active: false },
    ],
    costs: [{ itemId: 'paella', variantId: null, menuComponent: false, quantity: 3 * scale, state: 'consumed', costCents: 1500 * scale, complete: true, grossCents: 6000 * scale, taxRate: 10 } as unknown as LineCost],
  }
}

/** Fecha local de hoy en la zona del restaurante. */
export const todayLocal = (now = Date.now()) => horaLocal(now, 'Europe/Madrid').fecha
export { sumarDias }
