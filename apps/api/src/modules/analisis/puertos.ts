import type { PoolClient } from 'pg'
import type { BillFact, CapacityFact, LineCost, RefundFact, ReservationFact, SoldLineFact } from '@llenamos/core'
import { ApiError } from '../../errors.js'

/**
 * Puertos de análisis. Las tablas de caja (V5), reservas (V3), carta (V4) e inventario (V6) no son de este módulo:
 * cada una de ellas se enchufa con su `setXxxPort`. El valor por defecto NO inventa datos: falla con un código propio.
 */

export const FACTS_UNAVAILABLE = 'analytics-facts-unavailable'
export const RESERVATIONS_UNAVAILABLE = 'analytics-reservations-unavailable'
export const ORIGINS_UNAVAILABLE = 'analytics-origins-unavailable'
export const SEGMENTS_UNAVAILABLE = 'analytics-segments-unavailable'

/** Hechos de UN local y UN día local (zona del restaurante). Los rellena el código de caja, reservas, carta e inventario. */
export interface DayFacts {
  /** Cuentas LIQUIDADAS ese día local (por `settledAt`). */
  bills: readonly BillFact[]
  /** Devoluciones confirmadas ese día local. */
  refunds: readonly RefundFact[]
  /** Reservas cuya hora de llegada cae ese día local. */
  reservations: readonly ReservationFact[]
  /** Plazas habilitadas del local y minutos abiertos de ese día (`openMinutesByDate[date]`). */
  capacity: CapacityFact
  /** Líneas vendidas (no anuladas) de las cuentas liquidadas ese día. */
  sold: readonly SoldLineFact[]
  /** Carta del local (todos los platos, activos o no). */
  catalog: readonly { itemId: string; name: string; active: boolean }[]
  /** Costes congelados de esas líneas (inventario, V6). Vacío = sin datos de coste. */
  costs: readonly LineCost[]
}

export interface AnalyticsFactsPort {
  /** Debe leer SOLO ese local y ese día, con índices por fecha. `date` es `YYYY-MM-DD`. */
  dayFacts(client: PoolClient, restaurantId: string, locationId: string, date: string, timezone: string): Promise<DayFacts>
  /** Opcional: avisos abiertos para el resumen (stock bajo mínimos, fichajes sin cerrar). Sin él, solo salen recomendaciones. */
  openAlerts?(client: PoolClient, restaurantId: string, locationIds: readonly string[]): Promise<string[]>
}

export interface ForecastInputs {
  seats: number
  /** Minutos abiertos por fecha local (`YYYY-MM-DD`) del historial y de los días pedidos. */
  openMinutesByDate: Readonly<Record<string, number>>
  /** Mesas abiertas (sesiones) cuya apertura cae entre `historyFrom` y `to`. */
  sessions: readonly { openedAt: number; closedAt: number | null; guests: number }[]
  /** Reservas con llegada entre `from` y `to` (los días pedidos). */
  reservations: readonly { startAt: number; durationMinutes: number; partySize: number; status: string }[]
}

export interface AnalyticsReservationsPort {
  /** Lectura acotada: historial de 84 días (`historyFrom` a `from`-1) más los días pedidos (`from` a `to`) de UN local. */
  forecastInputs(client: PoolClient, restaurantId: string, locationId: string, p: { historyFrom: string; from: string; to: string; timezone: string }): Promise<ForecastInputs>
}

/** Informe de origen de reservas de marketing (`originReportRows` del módulo de campañas). */
export interface OriginReportPort {
  originReportRows(client: PoolClient, restaurantId: string, input: { from: string; to: string; locationIds: readonly string[] }): Promise<Record<string, string | number | null>[]>
}

/** Comprueba que un segmento de campañas existe (para reglas `launch_campaign`). */
export interface SegmentsPort {
  exists(client: PoolClient, restaurantId: string, segmentId: string): Promise<boolean>
}

/** 412 `failed-precondition` (la web ya lo trata como definitivo) con un `reason` propio para distinguirlo en código. */
export class PortUnavailable extends ApiError {
  constructor(readonly reason: string, what: string) { super(412, 'failed-precondition', `${what} Esa parte aún no está conectada en este servidor (${reason}).`) }
}
const unavailable = (code: string, what: string) => () => new PortUnavailable(code, what)

let facts: AnalyticsFactsPort = {
  dayFacts: async () => { throw unavailable(FACTS_UNAVAILABLE, 'Faltan los hechos de caja, reservas y carta para calcular el análisis.')() },
}
let reservations: AnalyticsReservationsPort = {
  forecastInputs: async () => { throw unavailable(RESERVATIONS_UNAVAILABLE, 'Faltan las mesas y reservas para la previsión.')() },
}
let origins: OriginReportPort = {
  originReportRows: async () => { throw unavailable(ORIGINS_UNAVAILABLE, 'Falta el informe de origen de las reservas.')() },
}
let segments: SegmentsPort = {
  exists: async () => { throw unavailable(SEGMENTS_UNAVAILABLE, 'Falta la lista de segmentos de campañas.')() },
}

export const factsPort = () => facts
export const reservationsPort = () => reservations
export const originsPort = () => origins
export const segmentsPort = () => segments
export const setAnalyticsFactsPort = (port: AnalyticsFactsPort) => { facts = port }
export const setAnalyticsReservationsPort = (port: AnalyticsReservationsPort) => { reservations = port }
export const setOriginReportPort = (port: OriginReportPort) => { origins = port }
export const setSegmentsPort = (port: SegmentsPort) => { segments = port }

export const isPortUnavailable = (error: unknown, reason: string) => error instanceof PortUnavailable && error.reason === reason

/** Solo para pruebas: vuelve a los puertos por defecto (los que fallan con 412). */
export function resetAnalyticsPortsForTests() {
  facts = { dayFacts: async () => { throw unavailable(FACTS_UNAVAILABLE, 'Faltan los hechos de caja, reservas y carta para calcular el análisis.')() } }
  reservations = { forecastInputs: async () => { throw unavailable(RESERVATIONS_UNAVAILABLE, 'Faltan las mesas y reservas para la previsión.')() } }
  origins = { originReportRows: async () => { throw unavailable(ORIGINS_UNAVAILABLE, 'Falta el informe de origen de las reservas.')() } }
  segments = { exists: async () => { throw unavailable(SEGMENTS_UNAVAILABLE, 'Falta la lista de segmentos de campañas.')() } }
}
