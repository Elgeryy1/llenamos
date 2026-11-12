import type { PoolClient } from 'pg'
import { AutomationEventInstanceSchema, type AutomationEventInstance } from '@llenamos/core'

export interface NewAutomationEvent {
  id: string
  type: AutomationEventInstance['type']
  locationId: string | null
  subject: string
  at: number
  data: AutomationEventInstance['data']
}

/** Inserta un evento de automatización; el id determinista hace idempotente el reintento. true = se creó ahora. */
export async function insertAutomationEvent(client: PoolClient, rid: string, e: NewAutomationEvent): Promise<boolean> {
  const parsed = AutomationEventInstanceSchema.parse(e)
  const r = await client.query('INSERT INTO llenamos.automation_events(restaurant_id,id,type,location_id,subject,at,data) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING',
    [rid, parsed.id, parsed.type, parsed.locationId, parsed.subject, new Date(parsed.at), JSON.stringify(parsed.data)])
  return (r.rowCount ?? 0) > 0
}
