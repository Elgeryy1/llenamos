import type { PoolClient } from 'pg'
import type { PrivacyContributor } from '../../privacy/types.js'
import { newTombstone, redactDoc } from '../../privacy/redact.js'

type Json = Record<string, any>
type Linked = { takeaways: Array<{ location_id: string; id: string; doc: Json }>; sessions: Array<{ location_id: string; id: string; doc: Json }> }
/** Sustituye solo el segmento entero entre «·» («Para llevar · Ana · 21:30»): un plato o una mesa con ese texto dentro no se toca. */
export const scrubLabel = (text: string, names: readonly string[]) => text.split(' · ').map(part => names.includes(part) ? 'Persona suprimida' : part).join(' · ')
const iso = (value: number | null | undefined) => typeof value === 'number' ? new Date(value).toISOString() : null
const LIVE_TAKEAWAY = ['pending', 'accepted', 'ready']
const LIVE_SESSION = ['open', 'bill_requested']

async function linked(client: PoolClient, rid: string, subject: string, redacted = false): Promise<Linked> {
  const filter = redacted ? '' : " AND NOT coalesce((doc->>'privacyRedacted')::boolean,false)"
  const takeaways = await client.query(`SELECT location_id,id,doc FROM llenamos.sala_takeaways WHERE restaurant_id=$1 AND doc->>'customerId'=$2${filter} LIMIT 5000`, [rid, subject])
  const sessions = await client.query(`SELECT location_id,id,doc FROM llenamos.sala_table_sessions WHERE restaurant_id=$1 AND doc->>'customerId'=$2${filter} LIMIT 5000`, [rid, subject])
  return { takeaways: takeaways.rows, sessions: sessions.rows }
}
const byLocation = (rows: Array<{ location_id: string; id: string }>) => [...new Set(rows.map(row => row.location_id))].map(location => ({ location, ids: rows.filter(row => row.location_id === location).map(row => row.id) }))

/** Pedidos, líneas y tareas que cuelgan de las mesas o recogidas de la persona. */
async function children(client: PoolClient, rid: string, found: Linked) {
  const out = { orders: [] as Array<{ location_id: string; id: string; doc: Json }>, lines: [] as Array<{ location_id: string; id: string; doc: Json }>, tasks: [] as Array<{ location_id: string; id: string; doc: Json }> }
  for (const place of new Set([...found.sessions, ...found.takeaways].map(row => row.location_id))) {
    const sessions = found.sessions.filter(row => row.location_id === place).map(row => row.id), takeaways = found.takeaways.filter(row => row.location_id === place).map(row => row.id)
    for (const [key, table] of [['orders', 'sala_orders'], ['lines', 'sala_order_lines'], ['tasks', 'sala_floor_tasks']] as const)
      out[key].push(...(await client.query(`SELECT location_id,id,doc FROM llenamos.${table} WHERE restaurant_id=$1 AND location_id=$2 AND (session_id=ANY($3) OR takeaway_id=ANY($4)) AND NOT coalesce((doc->>'privacyRedacted')::boolean,false)`, [rid, place, sessions, takeaways])).rows)
  }
  return out
}

/** Mesas y recogidas con datos de la persona (nombre, contacto, notas), sus comandas y los avisos de recogida. */
export const salaPrivacy: PrivacyContributor = {
  async subjectExists(client, rid, subject) {
    const found = await linked(client, rid, subject)
    if (found.takeaways.length + found.sessions.length > 0) return true
    return ((await client.query('SELECT 1 FROM llenamos.sala_spend WHERE restaurant_id=$1 AND customer_id=$2 LIMIT 1', [rid, subject])).rowCount ?? 0) > 0
  },
  async exportData(client, rid, subject) {
    const found = await linked(client, rid, subject), kids = await children(client, rid, found)
    const notices = await client.query<{ channel: string; template: string; status: string; created_at: Date }>(
      "SELECT channel,template,status,created_at FROM llenamos.message_deliveries WHERE restaurant_id=$1 AND context->>'takeawayId'=ANY($2) ORDER BY created_at DESC LIMIT 5000", [rid, found.takeaways.map(row => row.id)])
    const spend = await client.query<{ target_kind: string; target_id: string; location_id: string; amount_cents: string }>(
      'SELECT target_kind,target_id,location_id,amount_cents FROM llenamos.sala_spend WHERE restaurant_id=$1 AND customer_id=$2 ORDER BY updated_at DESC LIMIT 5000', [rid, subject])
    return {
      gasto_sala: spend.rows.map(row => ({ destino: row.target_kind, id: row.target_id, local: row.location_id, importeCentimos: Number(row.amount_cents) })),
      recogidas: found.takeaways.map(row => ({ id: row.id, local: row.location_id, referencia: row.doc.reference, estado: row.doc.status, recogida: iso(row.doc.pickupAt), nombre: row.doc.guestName, telefono: row.doc.phone, correo: row.doc.email ?? null, notas: row.doc.notes ?? '', totalCentimos: row.doc.totalCents })),
      mesas: found.sessions.map(row => ({ id: row.id, local: row.location_id, estado: row.doc.status, comensales: row.doc.guests, nombre: row.doc.guestName ?? null, notas: row.doc.notes ?? '', apertura: iso(row.doc.openedAt) })),
      pedidos_sala: kids.orders.map(row => ({ id: row.id, local: row.location_id, estado: row.doc.status, nota: row.doc.note ?? '', totalCentimos: row.doc.totalCents })),
      avisos_recogida: notices.rows.map(row => ({ canal: row.channel, plantilla: row.template, estado: row.status, fecha: row.created_at.toISOString() })),
    }
  },
  async blockers(client, rid, subject) {
    const found = await linked(client, rid, subject)
    const sending = found.takeaways.length ? await client.query("SELECT 1 FROM llenamos.outbox WHERE restaurant_id=$1 AND status='leased' AND kind='aviso.recogida' AND payload->>'takeawayId'=ANY($2) LIMIT 1", [rid, found.takeaways.map(row => row.id)]) : null
    return [
      ...(found.takeaways.some(row => LIVE_TAKEAWAY.includes(row.doc.status)) ? ['Hay un pedido para llevar abierto de esta persona.'] : []),
      ...(found.sessions.some(row => LIVE_SESSION.includes(row.doc.status)) ? ['Hay una mesa abierta a nombre de esta persona.'] : []),
      ...(sending?.rowCount ? ['Hay un aviso de recogida enviándose a esta persona.'] : []),
    ]
  },
  async erase(client, rid, subject) {
    const tomb = newTombstone()
    const found = await linked(client, rid, subject, true), kids = await children(client, rid, found)
    let touched = 0
    // Las etiquetas de cocina y avisos llevan el nombre («Para llevar · Ana · 21:30»): se sustituye en el texto.
    const names = [...new Set([...found.takeaways, ...found.sessions].map(row => row.doc.guestName).filter((name): name is string => typeof name === 'string' && name.length > 0))]
    const scrub = (text: string) => scrubLabel(text, names)
    const update = async (table: string, rows: Array<{ location_id: string; id: string; doc: Json }>, keep: string[] = []) => {
      for (const row of rows) {
        const redacted = redactDoc(row.doc, tomb, ['waiterName', ...keep]) as Json
        if (typeof redacted.label === 'string' && (table === 'sala_order_lines' || table === 'sala_floor_tasks')) redacted.label = scrub(redacted.label)
        await client.query(`UPDATE llenamos.${table} SET doc=$4 WHERE restaurant_id=$1 AND location_id=$2 AND id=$3`, [rid, row.location_id, row.id, JSON.stringify(redacted)])
        touched++
      }
    }
    await update('sala_takeaways', found.takeaways)
    await update('sala_table_sessions', found.sessions)
    await update('sala_orders', kids.orders)
    await update('sala_order_lines', kids.lines, ['name'])
    await update('sala_floor_tasks', kids.tasks)
    // El secreto del enlace de seguimiento se vacía: sin él nadie reconstruye el enlace de la persona.
    for (const { location, ids } of byLocation(found.takeaways))
      touched += (await client.query("UPDATE llenamos.sala_private SET doc='{}'::jsonb,updated_at=now() WHERE restaurant_id=$1 AND location_id=$2 AND kind='takeawaySecrets' AND id=ANY($3)", [rid, location, ids])).rowCount ?? 0
    // Gasto acumulado por mesa o recogida: solo cuelga del id del cliente, así que se borra.
    touched += (await client.query('DELETE FROM llenamos.sala_spend WHERE restaurant_id=$1 AND customer_id=$2', [rid, subject])).rowCount ?? 0
    const ids = found.takeaways.map(row => row.id)
    if (ids.length) {
      await client.query(`UPDATE llenamos.outbox SET status=CASE WHEN status='pending' THEN 'cancelled' ELSE status END,finished_at=coalesce(finished_at,now()),last_error='privacidad'
        WHERE restaurant_id=$1 AND kind='aviso.recogida' AND status<>'leased' AND payload->>'takeawayId'=ANY($2)`, [rid, ids])
      touched += (await client.query(`UPDATE llenamos.message_deliveries SET recipient='suprimido',context='{"privacyRedacted":true}',rendered_subject=NULL,last_error=NULL,updated_at=now()
        WHERE restaurant_id=$1 AND context->>'takeawayId'=ANY($2)`, [rid, ids])).rowCount ?? 0
    }
    return touched
  },
}
