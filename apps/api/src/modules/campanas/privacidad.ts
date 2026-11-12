import type { PoolClient } from 'pg'
import type { PrivacyContributor } from '../../privacy/types.js'

const PURPOSES = ['marketing_email', 'marketing_whatsapp', 'digital_receipt'] as const

/** Tablas de campañas con datos personales de un cliente (su ficha de marketing, permisos y envíos). */
export const CAMPAIGN_PERSONAL_DATA = ['customer_marketing', 'marketing_consents', 'marketing_campaign_recipients', 'marketing_unsubscribe_tokens', 'marketing_send_log'] as const

const rows = async (client: PoolClient, sql: string, params: unknown[]) => (await client.query(sql, params)).rows as Record<string, unknown>[]

export const campanasPrivacy: PrivacyContributor = {
  subjectExists: async (client, rid, subject) => (await client.query('SELECT 1 FROM llenamos.customer_marketing WHERE restaurant_id=$1 AND customer_id=$2', [rid, subject])).rowCount === 1,
  exportData: async (client, rid, subject) => ({
    marketing_ficha: await rows(client, 'SELECT name,phone,email,language,visits,no_shows,last_visit_at,spent_cents,tags FROM llenamos.customer_marketing WHERE restaurant_id=$1 AND customer_id=$2', [rid, subject]),
    marketing_permisos: await rows(client, 'SELECT purpose,status,policy_version,at,source FROM llenamos.marketing_consents WHERE restaurant_id=$1 AND customer_id=$2 ORDER BY at DESC LIMIT 1000', [rid, subject]),
    marketing_envios: await rows(client, 'SELECT campaign_id,status,excluded_reason,at FROM llenamos.marketing_campaign_recipients WHERE restaurant_id=$1 AND customer_id=$2 ORDER BY at DESC LIMIT 1000', [rid, subject]),
  }),
  // Un mensaje ya reclamado por el worker no se puede retirar: se espera a que termine antes de borrar a la persona.
  blockers: async (client, rid, subject) => (await client.query(
    "SELECT 1 FROM llenamos.outbox WHERE restaurant_id=$1 AND kind='marketing.campaign_message' AND status='leased' AND payload->>'customerId'=$2 LIMIT 1", [rid, subject])).rowCount ? ['Hay un mensaje de marketing en envío. Inténtalo de nuevo en unos minutos.'] : [],
  erase: async (client, rid, subject) => {
    let touched = (await client.query('SELECT llenamos.marketing_erase_customer($1,$2) AS n', [rid, subject])).rows[0].n as number
    // Los permisos son un libro que se conserva como prueba; se añade una baja de todo para que no salga nada más.
    for (const purpose of PURPOSES)
      touched += (await client.query(`INSERT INTO llenamos.marketing_consents(restaurant_id,id,customer_id,purpose,status,policy_version,at,source,evidence_id)
        VALUES($1,$2,$3,$4,'withdrawn','erasure',clock_timestamp(),'staff','privacy') ON CONFLICT DO NOTHING`, [rid, `erasure.${subject}.${purpose}`, subject, purpose])).rowCount ?? 0
    touched += (await client.query("UPDATE llenamos.customer_marketing SET name='',phone=NULL,email=NULL,tags='{}',language='es',visits=0,no_shows=0,last_visit_at=NULL,spent_cents=0,redacted=true,updated_at=now() WHERE restaurant_id=$1 AND customer_id=$2", [rid, subject])).rowCount ?? 0
    touched += (await client.query('DELETE FROM llenamos.marketing_send_log WHERE restaurant_id=$1 AND customer_id=$2', [rid, subject])).rowCount ?? 0
    return touched
  },
}
