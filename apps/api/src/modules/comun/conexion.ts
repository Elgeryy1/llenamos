import { setLoyaltyPointsPort, setReservationsWithoutOriginPort } from '../campanas/config.js'
import { originReportRows } from '../campanas/origen.js'
import { setAnalyticsFactsPort, setAnalyticsReservationsPort, setOriginReportPort, setSegmentsPort } from '../analisis/puertos.js'
import { postgresFactsPort, postgresReservationsPort } from '../analisis/hechos.js'
import { cajaBillPort, salaVisitPort } from '../fidelizacion/cuentas.js'
import { setBillPort, setVisitPort } from '../fidelizacion/ports.js'
import { registerLoyaltyHooks } from '../fidelizacion/trabajos.js'

let connected = false
/**
 * Conecta fidelización, campañas y análisis entre sí y con caja, reservas y sala. Se ejecuta una vez al cargar los módulos (la API
 * y el worker importan `MODULES`), así que ningún proceso arranca con un puerto por defecto que falla. Idempotente.
 * Las pruebas pueden sustituir cualquier puerto con su `setXxx` después.
 */
export function connectClientesModules(): void {
  if (connected) return
  connected = true
  setLoyaltyPointsPort({
    async balances(client, rid, ids) {
      if (!ids.length) return new Map()
      const { rows } = await client.query<{ customer_id: string; balance: string }>("SELECT customer_id::text,balance::text FROM llenamos.loyalty_accounts WHERE restaurant_id=$1 AND customer_id=ANY($2::bpchar[]) AND status='active'", [rid, [...ids]])
      return new Map(rows.map(r => [r.customer_id, Number(r.balance)]))
    },
  })
  setReservationsWithoutOriginPort({
    async count(client, rid, locationIds, from, to) {
      if (!locationIds.length) return 0
      const { rows } = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM llenamos.reservations r JOIN llenamos.restaurants z ON z.id=r.restaurant_id
         WHERE r.restaurant_id=$1 AND r.location_id=ANY($2::text[]) AND r.start_at>=($3::date::timestamp AT TIME ZONE z.timezone) AND r.start_at<(($4::date+1)::timestamp AT TIME ZONE z.timezone)
           AND NOT r.privacy_redacted AND NOT EXISTS(SELECT 1 FROM llenamos.reservation_origins o WHERE o.restaurant_id=r.restaurant_id AND o.reservation_id=r.id)`,
        [rid, [...locationIds], from, to])
      return rows[0]!.n
    },
  })
  setOriginReportPort({ originReportRows: async (client, rid, input) => (await originReportRows(client, rid, input.locationIds, input.from, input.to)).rows.map(row => ({ ...row })) })
  setSegmentsPort({ exists: async (client, rid, segmentId) => (await client.query('SELECT 1 FROM llenamos.marketing_segments WHERE restaurant_id=$1 AND id=$2', [rid, segmentId])).rowCount === 1 })
  setBillPort(cajaBillPort)
  setVisitPort(salaVisitPort)
  setAnalyticsFactsPort(postgresFactsPort)
  setAnalyticsReservationsPort(postgresReservationsPort)
  registerLoyaltyHooks()
}
