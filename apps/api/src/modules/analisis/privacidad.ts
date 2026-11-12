import type { PoolClient } from 'pg'
import type { PrivacyContributor } from '../../privacy/types.js'

/** Eventos y recomendaciones de automatización que nombran a un cliente (su id va en `subject` y dentro de los ids). */
export const ANALYTICS_PERSONAL_DATA = ['automation_events', 'recommendations'] as const

const rows = async (client: PoolClient, sql: string, params: unknown[]) => (await client.query(sql, params)).rows as Record<string, unknown>[]

export const analisisPrivacy: PrivacyContributor = {
  exportData: async (client, rid, subject) => ({
    analisis_eventos: await rows(client, 'SELECT type,location_id,at,data FROM llenamos.automation_events WHERE restaurant_id=$1 AND subject=$2 AND NOT redacted ORDER BY at DESC LIMIT 1000', [rid, subject]),
    analisis_recomendaciones: await rows(client, "SELECT kind,text,status,created_at FROM llenamos.recommendations WHERE restaurant_id=$1 AND subject=$2 AND subject<>'redacted' ORDER BY created_at DESC LIMIT 1000", [rid, subject]),
  }),
  erase: async (client, rid, subject) => {
    // Los eventos (el cliente que no se presentó, el que lleva meses sin venir) se borran; de las recomendaciones queda el texto genérico sin sujeto, sin pruebas y con un id nuevo (el viejo llevaba el id del cliente dentro).
    let touched = (await client.query('DELETE FROM llenamos.automation_events WHERE restaurant_id=$1 AND subject=$2', [rid, subject])).rowCount ?? 0
    touched += (await client.query("UPDATE llenamos.recommendations SET id='redacted.'||gen_random_uuid(),subject='redacted',event_id='redacted',evidence='{}' WHERE restaurant_id=$1 AND subject=$2", [rid, subject])).rowCount ?? 0
    return touched
  },
}
