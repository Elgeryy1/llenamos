import type { PrivacyContributor } from '../../privacy/types.js'

type Json = Record<string, any>
const OPEN_BILL = ['open', 'locked']

/**
 * Caja guarda del cliente solo el vínculo de la cuenta (`customerId`). Borrar lo desvincula sin tocar importes,
 * cobros ni sellos. Las facturas con destinatario son documentos fiscales: NO se modifican al borrar (no hay en este
 * servidor ninguna restricción de acceso adicional; la conservación es la obligación legal). La exportación las
 * incluye, también las emitidas a nombre de la persona sin vínculo de cuenta (se localizan por el nombre de su ficha).
 */
export const cajaPrivacy: PrivacyContributor = {
  async subjectExists(client, rid, subject) {
    const { rowCount } = await client.query("SELECT 1 FROM llenamos.pos_bills WHERE restaurant_id=$1 AND data->>'customerId'=$2 LIMIT 1", [rid, subject])
    return rowCount === 1
  },
  async exportData(client, rid, subject) {
    const bills = await client.query<{ id: string; location_id: string; target_kind: string; status: string; opened_at: Date; data: Json }>(
      "SELECT id,location_id,target_kind,status,opened_at,data FROM llenamos.pos_bills WHERE restaurant_id=$1 AND data->>'customerId'=$2 ORDER BY opened_at DESC LIMIT 5000", [rid, subject])
    const name = (await client.query<{ name: string | null }>("SELECT data->>'name' AS name FROM llenamos.customers WHERE restaurant_id=$1 AND id=$2", [rid, subject])).rows[0]?.name ?? null
    const invoices = await client.query<{ number: string; created_at: Date; data: Json }>(
      `SELECT number,created_at,data FROM llenamos.pos_invoices WHERE restaurant_id=$1 AND (bill_id=ANY($2) OR ($3::text IS NOT NULL AND data->'recipient'->>'name'=$3))
         ORDER BY created_at DESC LIMIT 5000`, [rid, bills.rows.map(row => row.id), name])
    return {
      cuentas: bills.rows.map(row => ({ id: row.id, local: row.location_id, destino: row.target_kind, estado: row.status, apertura: row.opened_at.toISOString(), totalCentimos: row.data.totalCents, pagadoCentimos: row.data.paidCents })),
      facturas: invoices.rows.map(row => ({ numero: row.number, fecha: row.created_at.toISOString(), tipo: row.data.type, destinatario: row.data.recipient ? { nombre: row.data.recipient.name, direccion: row.data.recipient.address ?? null, identificacion: row.data.recipient.identity ?? null, nota: 'Documento fiscal: se conserva sin cambios al borrar.' } : null })),
    }
  },
  async blockers(client, rid, subject) {
    const { rowCount } = await client.query("SELECT 1 FROM llenamos.pos_bills WHERE restaurant_id=$1 AND data->>'customerId'=$2 AND status=ANY($3) LIMIT 1", [rid, subject, OPEN_BILL])
    return rowCount ? ['Hay una cuenta abierta o en cobro asociada a esta persona.'] : []
  },
  async erase(client, rid, subject) {
    return (await client.query("UPDATE llenamos.pos_bills SET data=data||'{\"customerId\":null}'::jsonb WHERE restaurant_id=$1 AND data->>'customerId'=$2 AND status<>ALL($3)", [rid, subject, OPEN_BILL])).rowCount ?? 0
  },
}
