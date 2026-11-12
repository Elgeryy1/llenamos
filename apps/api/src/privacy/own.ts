import type { PrivacyContributor } from './types.js'

/** Los datos personales que guarda este corte: avisos enviados y por enviar a la persona. */
export const deliveriesContributor: PrivacyContributor = {
  async exportData(client, rid, subject) {
    const { rows } = await client.query(`SELECT channel,template,status,provider,created_at FROM llenamos.message_deliveries
      WHERE restaurant_id=$1 AND context->>'customerId'=$2 ORDER BY created_at DESC LIMIT 5000`, [rid, subject])
    return { avisos: rows.map(row => ({ canal: row.channel, plantilla: row.template, estado: row.status, proveedor: row.provider, fecha: row.created_at.toISOString() })) }
  },
  async blockers(client, rid, subject) {
    const { rows } = await client.query("SELECT count(*)::int AS n FROM llenamos.outbox WHERE restaurant_id=$1 AND status='leased' AND payload->>'customerId'=$2", [rid, subject])
    return rows[0].n ? ['Hay un aviso enviándose a esta persona.'] : []
  },
  async erase(client, rid, subject) {
    const queued = await client.query("UPDATE llenamos.outbox SET status='failed',finished_at=now(),last_error='privacidad',payload='{\"privacyRedacted\":true}' WHERE restaurant_id=$1 AND status='pending' AND payload->>'customerId'=$2", [rid, subject])
    const old = await client.query("UPDATE llenamos.outbox SET payload='{\"privacyRedacted\":true}' WHERE restaurant_id=$1 AND status<>'leased' AND payload->>'customerId'=$2", [rid, subject])
    const deliveries = await client.query("UPDATE llenamos.message_deliveries SET recipient='suprimido',context='{\"privacyRedacted\":true}',rendered_subject=NULL,status=CASE WHEN status='sent' THEN status ELSE 'cancelled' END,updated_at=now() WHERE restaurant_id=$1 AND context->>'customerId'=$2", [rid, subject])
    return (queued.rowCount ?? 0) + (old.rowCount ?? 0) + (deliveries.rowCount ?? 0)
  },
}
