import type { PoolClient } from 'pg'
import * as core from '@llenamos/core'
import { ApiError } from '../../errors.js'

/* Reloj ------------------------------------------------------------------------------------- */

let clock: () => number = () => Date.now()
/** Solo para pruebas: fija el reloj de las operaciones. */
export function setClock(fn: (() => number) | null) { clock = fn ?? (() => Date.now()) }
export const now = () => clock()

/* Caja (V5) ---------------------------------------------------------------------------------- */

/** Código del error cuando caja aún no está conectada con fidelización. */
export const BILL_PORT_UNAVAILABLE = 'caja-no-disponible'

export interface BillView {
  billId: string
  locationId: string
  /** Revisión de la cuenta: la fidelización la devuelve en `expectedRevision` al reemplazar ajustes. */
  revision: number
  customerId: string | null
  channel: core.PromotionChannel
  /** Total actual a cobrar (tras ajustes). */
  totalCents: number
  /** Líneas con lo que queda por cobrar de cada una (tras invitaciones, anulaciones y descuentos). */
  lines: readonly core.RewardLine[]
  adjustments: readonly core.BillAdjustment[]
}
export interface BillPort {
  /**
   * Abre la cuenta para descontar. Debe fallar con `ApiError` 404 si no existe en ese local y 412 si no está
   * abierta, ya tiene cobros, facturas o pagos pendientes, o hay consumo sin reflejar; y con 412 si
   * `expectedRevision` (cuando no es null) no coincide. Se ejecuta dentro de la transacción de la operación.
   */
  openBill(client: PoolClient, p: { restaurantId: string; locationId: string; billId: string; expectedRevision: number | null }): Promise<BillView>
  /**
   * Sustituye todos los ajustes de la cuenta (incluidos los que no son de fidelización) comprobando la revisión,
   * recalcula el total, rehace las partes y devuelve la revisión nueva.
   */
  replaceAdjustments(client: PoolClient, p: { restaurantId: string; locationId: string; billId: string; expectedRevision: number; actorUid: string; adjustments: readonly core.BillAdjustment[] }): Promise<{ revision: number; totalCents: number }>
}
const noBill = (): never => { throw new ApiError(412, BILL_PORT_UNAVAILABLE, 'La caja todavía no está conectada con la fidelización en este servidor. No se ha cambiado la cuenta.') }
const unavailableBill: BillPort = { openBill: async () => noBill(), replaceAdjustments: async () => noBill() }
let billPort: BillPort = unavailableBill
/** Lo enchufa el módulo de caja (V5) al arrancar. Con `null` vuelve al valor por defecto, que falla. */
export function setBillPort(port: BillPort | null) { billPort = port ?? unavailableBill }
export const bills = (): BillPort => billPort

/* Visitas (reservas V3 y mesas V4/V5) ------------------------------------------------------------ */

/** Código del error cuando reservas o mesas aún no verifican visitas. */
export const VISIT_PORT_UNAVAILABLE = 'visitas-no-disponibles'
export interface VisitPort {
  /** Debe fallar (404/412) si la reserva o la mesa no existe en el local o no pertenece a ese cliente. */
  assertVisit(client: PoolClient, p: { restaurantId: string; locationId: string; customerId: string; reservationId: string | null; sessionId: string | null }): Promise<void>
}
const unavailableVisits: VisitPort = {
  assertVisit: async () => { throw new ApiError(412, VISIT_PORT_UNAVAILABLE, 'Reservas y mesas todavía no están conectadas con Repite en este servidor. No se ha dado el sello.') },
}
let visitPort: VisitPort = unavailableVisits
export function setVisitPort(port: VisitPort | null) { visitPort = port ?? unavailableVisits }
export const visits = (): VisitPort => visitPort

/* Repite ---------------------------------------------------------------------------------------- */

let injected: core.RepiteAdapter | null = null
/** En el VPS no hay adaptador real. Solo se inyecta uno de prueba o el que se contrate algún día. */
export function setRepiteAdapter(adapter: core.RepiteAdapter | null) { injected = adapter }
export const repiteAdapter = (): core.RepiteAdapter => injected ?? core.notConfiguredRepite()
export const repiteConfigured = () => injected !== null
