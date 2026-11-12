import type { PoolClient } from 'pg'

/** La ficha de marketing la rellena el disparador `clientes_espejo` (016) desde la ficha de reservas; no hay escritura directa. */

export interface ConsentEvent { restaurantId: string; id: string; customerId: string; purpose: 'marketing_email' | 'marketing_whatsapp' | 'digital_receipt'; status: 'granted' | 'withdrawn'; policyVersion: string; at: number; source: 'public' | 'staff' | 'import'; evidenceId: string }

/**
 * Registra un permiso o una baja. El id estable hace idempotente el reintento. La hora la pone el servidor (`clock_timestamp()`):
 * el `at` del llamador solo cuenta en una importación (`source: 'import'`, la fecha original del permiso) y nunca puede ser futuro.
 */
export async function recordConsent(client: PoolClient, e: ConsentEvent): Promise<void> {
  await client.query(`INSERT INTO llenamos.marketing_consents(restaurant_id,id,customer_id,purpose,status,policy_version,at,source,evidence_id)
    VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $8='import' THEN least(to_timestamp($7::bigint/1000.0),clock_timestamp()) ELSE clock_timestamp() END,$8,$9) ON CONFLICT DO NOTHING`,
    [e.restaurantId, e.id, e.customerId, e.purpose, e.status, e.policyVersion, e.at, e.source, e.evidenceId])
}
