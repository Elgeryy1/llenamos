import type { PoolClient } from 'pg'
import type { PrivacyContributor } from '../../privacy/types.js'
import { newTombstone, redactDoc } from '../../privacy/redact.js'

type Json = Record<string, any>
const iso = (value: Date | number | null | undefined) => value == null ? null : new Date(value).toISOString()
const OPEN_RESERVATION = ['pending', 'confirmed', 'seated']

/** Reservas del cliente: se usan para localizar también sus avisos, que no llevan el id de cliente. */
async function ownIds(client: PoolClient, rid: string, subject: string) {
  const reservations = (await client.query<{ id: string }>('SELECT id FROM llenamos.reservations WHERE restaurant_id=$1 AND customer_id=$2', [rid, subject])).rows.map(row => row.id)
  const waitlist = (await client.query<{ id: string }>('SELECT id FROM llenamos.waitlist WHERE restaurant_id=$1 AND customer_id=$2', [rid, subject])).rows.map(row => row.id)
  return { reservations, waitlist }
}

/**
 * Datos personales de reservas: ficha de cliente, reservas, lista de espera, permisos recogidos al reservar y
 * el rastro de avisos enviados. Exportar entrega lo que consta; borrar anonimiza sin tocar importes ni estados.
 */
export const reservasPrivacy: PrivacyContributor = {
  async subjectExists(client, rid, subject) {
    const { rowCount } = await client.query("SELECT 1 FROM llenamos.customers WHERE restaurant_id=$1 AND id=$2 AND NOT coalesce((data->>'privacyRedacted')::boolean,false)", [rid, subject])
    return rowCount === 1
  },
  async exportData(client, rid, subject) {
    const customers = await client.query<{ data: Json; created_at: Date }>('SELECT data,created_at FROM llenamos.customers WHERE restaurant_id=$1 AND id=$2', [rid, subject])
    const reservations = await client.query<{ id: string; location_id: string; reference: string; start_at: Date; status: string; data: Json }>(
      'SELECT id,location_id,reference,start_at,status,data FROM llenamos.reservations WHERE restaurant_id=$1 AND customer_id=$2 AND NOT privacy_redacted ORDER BY start_at DESC LIMIT 5000', [rid, subject])
    const waitlist = await client.query<{ id: string; location_id: string; service_date: string; status: string; data: Json }>(
      "SELECT id,location_id,service_date,status,data FROM llenamos.waitlist WHERE restaurant_id=$1 AND customer_id=$2 AND NOT coalesce((data->>'privacyRedacted')::boolean,false) ORDER BY created_at DESC LIMIT 5000", [rid, subject])
    const consents = await client.query<{ id: string; data: Json; created_at: Date }>("SELECT id,data,created_at FROM llenamos.consents WHERE restaurant_id=$1 AND data->>'customerId'=$2 ORDER BY created_at DESC LIMIT 5000", [rid, subject])
    const ids = await ownIds(client, rid, subject)
    const notices = await client.query<{ channel: string; template: string; status: string; created_at: Date }>(
      `SELECT channel,template,status,created_at FROM llenamos.message_deliveries WHERE restaurant_id=$1
         AND (context->>'reservationId'=ANY($2) OR context->>'waitlistId'=ANY($3)) ORDER BY created_at DESC LIMIT 5000`, [rid, ids.reservations, ids.waitlist])
    return {
      clientes: customers.rows.map(row => ({ nombre: row.data.name, telefono: row.data.phone, correo: row.data.email ?? null, idioma: row.data.language, notas: row.data.notes ?? '', alergias: row.data.allergies ?? '',
        etiquetas: row.data.tags ?? [], visitas: row.data.visits, ausencias: row.data.noShows, cancelaciones: row.data.cancellations, alta: iso(row.created_at) })),
      reservas: reservations.rows.map(row => ({ id: row.id, local: row.location_id, referencia: row.reference, fecha: iso(row.start_at), estado: row.status, comensales: row.data.partySize,
        nombre: row.data.guestName, telefono: row.data.phone, correo: row.data.email ?? null, notas: row.data.notes ?? '', notasCliente: row.data.guestNotes ?? '' })),
      espera: waitlist.rows.map(row => ({ id: row.id, local: row.location_id, dia: row.service_date, estado: row.status, nombre: row.data.guestName, telefono: row.data.phone, correo: row.data.email ?? null, notas: row.data.notes ?? '' })),
      consentimientos: consents.rows.map(row => ({ id: row.id, finalidad: row.data.purpose, estado: row.data.status, version: row.data.policyVersion, fecha: iso(row.data.at ?? row.created_at) })),
      avisos_reservas: notices.rows.map(row => ({ canal: row.channel, plantilla: row.template, estado: row.status, fecha: iso(row.created_at) })),
    }
  },
  async blockers(client, rid, subject) {
    const reservations = await client.query('SELECT 1 FROM llenamos.reservations WHERE restaurant_id=$1 AND customer_id=$2 AND status=ANY($3) AND NOT privacy_redacted LIMIT 1', [rid, subject, OPEN_RESERVATION])
    const waiting = await client.query("SELECT 1 FROM llenamos.waitlist WHERE restaurant_id=$1 AND customer_id=$2 AND status IN ('waiting','offered') LIMIT 1", [rid, subject])
    const ids = await ownIds(client, rid, subject)
    const sending = await client.query(
      "SELECT 1 FROM llenamos.outbox WHERE restaurant_id=$1 AND status='leased' AND (payload->>'reservationId'=ANY($2) OR payload->>'waitlistId'=ANY($3)) LIMIT 1", [rid, ids.reservations, ids.waitlist])
    return [
      ...(reservations.rowCount ? ['Hay una reserva abierta de esta persona. Cancélala o espera a que termine.'] : []),
      ...(waiting.rowCount ? ['Esta persona está en la lista de espera. Retírala primero.'] : []),
      ...(sending.rowCount ? ['Hay un aviso de reserva enviándose a esta persona.'] : []),
    ]
  },
  async erase(client, rid, subject) {
    const tomb = newTombstone()
    let touched = 0
    const ids = await ownIds(client, rid, subject)
    const known = await client.query<{ data: Json }>('SELECT data FROM llenamos.customers WHERE restaurant_id=$1 AND id=$2', [rid, subject])
    const phones = new Set<string>(known.rows.flatMap(row => typeof row.data.phone === 'string' ? [row.data.phone] : []))
    // Avisos de reserva o espera todavía en cola: se anulan y su payload (contacto, enlaces) se vacía.
    const queued = await client.query(
      `UPDATE llenamos.outbox SET status=CASE WHEN status='pending' THEN 'cancelled' ELSE status END,finished_at=coalesce(finished_at,now()),last_error='privacidad',payload='{"privacyRedacted":true}'
         WHERE restaurant_id=$1 AND status<>'leased' AND kind IN ('aviso.mensaje','mensaje.enviar') AND NOT payload ? 'privacyRedacted'
           AND (payload->>'reservationId'=ANY($2) OR payload->>'waitlistId'=ANY($3))`, [rid, ids.reservations, ids.waitlist])
    touched += queued.rowCount ?? 0
    const deliveries = await client.query<{ recipient: string; channel: string }>(
      `UPDATE llenamos.message_deliveries d SET recipient='suprimido',context='{"privacyRedacted":true}',rendered_subject=NULL,last_error=NULL,updated_at=now()
         FROM (SELECT id,recipient,channel FROM llenamos.message_deliveries WHERE restaurant_id=$1 AND (context->>'reservationId'=ANY($2) OR context->>'waitlistId'=ANY($3))) old
         WHERE d.id=old.id AND d.restaurant_id=$1 RETURNING old.recipient,old.channel`, [rid, ids.reservations, ids.waitlist])
    touched += deliveries.rowCount ?? 0
    for (const row of deliveries.rows) if (row.channel === 'whatsapp') phones.add(row.recipient)
    const reservations = await client.query<{ id: string; location_id: string; data: Json }>('SELECT id,location_id,data FROM llenamos.reservations WHERE restaurant_id=$1 AND customer_id=$2 AND NOT privacy_redacted FOR UPDATE', [rid, subject])
    for (const row of reservations.rows) {
      if (typeof row.data.phone === 'string') phones.add(row.data.phone)
      await client.query("UPDATE llenamos.reservations SET customer_id=$4,manage_token_hash=repeat('0',64),data=$5,privacy_redacted=true,updated_at=now() WHERE restaurant_id=$1 AND location_id=$2 AND id=$3",
        [rid, row.location_id, row.id, tomb, JSON.stringify(redactDoc(row.data, tomb))])
      touched++
    }
    // Respuestas de WhatsApp ya recibidas (teléfono, texto): por el aviso que citan o por el teléfono de la persona.
    const digits = [...phones].map(phone => phone.replace(/^\+/, ''))
    touched += (await client.query(
      `UPDATE llenamos.outbox SET payload='{"privacyRedacted":true}',last_error=coalesce(last_error,'privacidad'),
           status=CASE WHEN status='pending' THEN 'cancelled' ELSE status END,finished_at=coalesce(finished_at,now())
         WHERE restaurant_id=$1 AND status<>'leased' AND kind IN ('mensaje.respuesta','webhook.whatsapp') AND NOT payload ? 'privacyRedacted'
           AND (payload->'context'->>'reservationId'=ANY($2) OR payload->'context'->>'waitlistId'=ANY($3) OR payload->>'phone'=ANY($4) OR payload->>'from'=ANY($5))`,
      [rid, ids.reservations, ids.waitlist, [...phones], digits])).rowCount ?? 0
    // Origen de marketing: se conserva el resultado, pero ni campaña, anuncio, clics ni referencias.
    await client.query(`UPDATE llenamos.reservation_origins SET click_ids='{}',ad_id=NULL,referrer_host=NULL,campaign=NULL,campaign_id=NULL,content=NULL,term=NULL,data='{}'::jsonb
      WHERE restaurant_id=$1 AND reservation_id=ANY($2)`, [rid, ids.reservations])
    const waitlist = await client.query<{ id: string; location_id: string; data: Json }>('SELECT id,location_id,data FROM llenamos.waitlist WHERE restaurant_id=$1 AND customer_id=$2 AND NOT coalesce((data->>\'privacyRedacted\')::boolean,false) FOR UPDATE', [rid, subject])
    for (const row of waitlist.rows) {
      await client.query("UPDATE llenamos.waitlist SET customer_id=$4,offer_token_hash=NULL,data=$5,updated_at=now() WHERE restaurant_id=$1 AND location_id=$2 AND id=$3",
        [rid, row.location_id, row.id, tomb, JSON.stringify(redactDoc(row.data, tomb))])
      touched++
    }
    // El libro de permisos conserva su historia (sigue siendo prueba del permiso), pero ya no apunta a la persona.
    const consents = await client.query<{ id: string; data: Json }>("SELECT id,data FROM llenamos.consents WHERE restaurant_id=$1 AND data->>'customerId'=$2 FOR UPDATE", [rid, subject])
    for (const row of consents.rows) {
      await client.query('UPDATE llenamos.consents SET data=$3 WHERE restaurant_id=$1 AND id=$2', [rid, row.id, JSON.stringify({ ...row.data, customerId: tomb })])
      touched++
    }
    // La ficha (visitas, ausencias, gasto) se borra: con un id derivado del teléfono bastaría el teléfono para recuperarla.
    touched += (await client.query('DELETE FROM llenamos.customers WHERE restaurant_id=$1 AND id=$2', [rid, subject])).rowCount ?? 0
    return touched
  },
}
