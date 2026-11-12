import { randomBytes, randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import type { z } from 'zod'
import * as core from '@llenamos/core'
import { ApiError } from '../../errors.js'
import type { Operation } from '../../operations.js'
import { assertLocation, loadScope, memberOperation, requireModules, rolesFor, stableHash, type Scope } from '../comun/acceso.js'
import { customerRow, failed, moduleActive, notFound, notify, repiteSettings, repiteSettingsOrNull, restaurantTimezone, stableUuid } from './util.js'
import { now, repiteAdapter, repiteConfigured, visits } from './ports.js'

const S = core.CALLABLE_SCHEMAS_FASE5_FIDELIZACION
type In<N extends keyof typeof S> = z.output<(typeof S)[N]['input']>
type Out<N extends keyof typeof S> = z.output<(typeof S)[N]['output']>

/** Tipo de trabajo (`llenamos.jobs`) que despierta al worker para llamar a `processRepite`. */
export const REPITE_JOB_KIND = 'fidelizacion.procesar_repite'
const NOT_CONNECTED = 'Repite no está conectado en este restaurante.'

/* Cola ------------------------------------------------------------------------------------------ */

export interface QueueRequest { id: string; kind: core.RepiteOperation['kind']; customerId: string; merchantId: string; visitKey?: string | null; trigger?: core.RepiteOperation['trigger']; externalRef?: string | null }

/** Despierta al worker: un trabajo por operación y por intento, con ID estable (un reintento no lo duplica). */
async function wake(client: PoolClient, rid: string, opId: string, at: number, attempt: number) {
  await client.query(`INSERT INTO llenamos.jobs(id,restaurant_id,kind,deduplication_key,payload,scheduled_at) VALUES($1,$2,$3,$4,$5,to_timestamp($6::bigint/1000.0)) ON CONFLICT DO NOTHING`,
    [stableUuid(`${rid}:repite:${opId}:${attempt}`), rid, REPITE_JOB_KIND, `${opId}:${attempt}`.slice(0, 256), { restaurantId: rid, operationId: opId }, at])
}
/** Encola con ID determinista. Devuelve false si ya existía. */
export async function enqueueRepite(client: PoolClient, rid: string, q: QueueRequest, at = now()): Promise<boolean> {
  const inserted = await client.query(`INSERT INTO llenamos.repite_queue(restaurant_id,id,kind,customer_id,merchant_id,visit_key,trigger,occurred_at_ms,next_attempt_at_ms,external_ref)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8,$9) ON CONFLICT DO NOTHING`, [rid, q.id, q.kind, q.customerId, q.merchantId, q.visitKey ?? null, q.trigger ?? null, at, q.externalRef ?? null])
  if (inserted.rowCount) await wake(client, rid, q.id, at, 0)
  return !!inserted.rowCount
}

/** Reabre una operación terminada sin éxito (fallida, sin configurar u omitida) para que el worker la intente de nuevo. Devuelve si la reabrió. */
export async function reopenRepite(client: PoolClient, rid: string, id: string, at = now()): Promise<boolean> {
  const { rowCount } = await client.query("UPDATE llenamos.repite_queue SET status='queued',attempts=0,next_attempt_at_ms=$3,lease_until_ms=NULL,lease_owner=NULL,last_error=NULL WHERE restaurant_id=$1 AND id=$2 AND status IN ('failed','not_configured','skipped')", [rid, id, at])
  if (rowCount) await wake(client, rid, id, at, at)
  return !!rowCount
}

/** Pone un sello en cola (id `stamp.{visitKey}`). `retry` reabre una operación fallida, sin conexión u omitida. */
export async function queueStamp(client: PoolClient, rid: string, customerId: string, visitKey: string, trigger: 'seated' | 'paid' | 'manual', retry = false, at = now()) {
  const settings = await repiteSettings(client, rid), id = core.repiteOperationId.stamp(visitKey)
  if (!settings.enabled || !settings.merchantId) return { operationId: id, status: 'not_configured' as const }
  const old = (await client.query('SELECT status FROM llenamos.repite_queue WHERE restaurant_id=$1 AND id=$2 FOR UPDATE', [rid, id])).rows[0]
  if (old) {
    const reopen = retry && ['failed', 'not_configured', 'skipped'].includes(old.status)
    if (reopen) {
      await client.query("UPDATE llenamos.repite_queue SET status='queued',next_attempt_at_ms=$3,lease_until_ms=NULL,lease_owner=NULL WHERE restaurant_id=$1 AND id=$2", [rid, id, at])
      await wake(client, rid, id, at, at)
    }
    return { operationId: id, status: (reopen ? 'queued' : ['done', 'duplicate', 'not_configured', 'failed'].includes(old.status) ? old.status : 'queued') as 'queued' | 'done' | 'duplicate' | 'not_configured' | 'failed' }
  }
  await enqueueRepite(client, rid, { id, kind: 'add_stamp', customerId, merchantId: settings.merchantId, visitKey, trigger }, at)
  return { operationId: id, status: 'queued' as const }
}

/* Operaciones que llaman a Repite sin tener una transacción abierta -------------------------------- */

/**
 * La lectura de BD va dentro de la transacción; la llamada a Repite, después del COMMIT (`afterCommit`).
 * El resultado provisional (`unavailable`) solo existe entre ambos pasos y nunca llega al cliente.
 */
function remoteRead<N extends 'verTarjetaRepite' | 'informeRepite'>(name: N, spec: {
  permission: 'fidelizacion.ver' | 'fidelizacion.gestionar'
  read: (client: PoolClient, input: In<N>, scope: Scope) => Promise<{ done: Out<N> } | { fetch: () => Promise<Out<N>> }>
}): readonly [string, Operation] {
  return [name, {
    access: 'member', input: S[name].input, output: S[name].output, roles: rolesFor(spec.permission),
    restaurantId: input => (input as { restaurantId: string }).restaurantId,
    run: async (client, raw, context) => {
      const input = raw as In<N>, rid = (input as { restaurantId: string }).restaurantId
      await requireModules(client, rid, ['repite'])
      const scope = await loadScope(client, rid, context.uid)
      const step = await spec.read(client, input, scope)
      if ('done' in step) return step.done
      context.afterCommit(async () => {
        try { return await step.fetch() } catch { return { status: 'unavailable', message: 'Repite no responde.' } }
      })
      return { status: 'unavailable', message: 'Consultando Repite.' }
    },
  }]
}
const failure = (error: core.RepiteError) => ({ status: error.code, message: error.message })

export const verTarjetaRepite = remoteRead('verTarjetaRepite', {
  permission: 'fidelizacion.ver',
  read: async (client, d) => {
    const settings = await repiteSettings(client, d.restaurantId)
    if (!settings.enabled || !settings.merchantId) return { done: { status: 'not_configured' as const, message: NOT_CONNECTED } }
    const link = (await client.query('SELECT merchant_id,card_id,status FROM llenamos.repite_cards WHERE restaurant_id=$1 AND customer_id=$2', [d.restaurantId, d.customerId])).rows[0]
    if (!link || link.status !== 'active') return { done: { status: 'no_card' as const } }
    return { fetch: async () => {
      const result = await repiteAdapter().getCard({ merchantId: link.merchant_id, cardId: link.card_id })
      return (result.ok ? { status: 'ready' as const, card: result.value, fetchedAt: now() } : failure(result.error)) as Out<'verTarjetaRepite'>
    } }
  },
})

export const informeRepite = remoteRead('informeRepite', {
  permission: 'fidelizacion.gestionar',
  read: async (client, d) => {
    const settings = await repiteSettings(client, d.restaurantId)
    if (!settings.enabled || !settings.merchantId) return { done: { status: 'not_configured' as const, message: NOT_CONNECTED } }
    const merchantId = settings.merchantId
    return { fetch: async () => {
      const result = await repiteAdapter().monthReport({ merchantId, month: d.month })
      return (result.ok ? { status: 'ready' as const, ...result.value } : failure(result.error)) as Out<'informeRepite'>
    } }
  },
})

/* Operaciones de BD ------------------------------------------------------------------------------- */

function mapLinkError(error: unknown): never {
  const e = error as { code?: string; message?: string }
  if (e.code === '23505') throw new ApiError(409, 'already-exists', 'Este identificador ya se usó con otros datos.')
  if (e.code === 'P0002') throw new ApiError(404, 'not-found', 'No se encuentra el restaurante.')
  if (e.code === 'P0001' && e.message === 'repite_cards_active') throw failed('Retira las tarjetas actuales antes de cambiar de comercio.')
  if (e.code === '22023') throw new ApiError(400, 'invalid-argument', 'Datos no válidos.')
  if (e.code === '42501') throw new ApiError(403, 'permission-denied', 'Solo el equipo autorizado de plataforma.')
  throw error
}
/**
 * Solo LogiQD. Es una operación de plataforma: no entra al restaurante (RLS se lo impide) y llama a un
 * procedimiento SECURITY DEFINER que solo escribe `repite_settings.merchant_id`, con auditoría.
 */
export const vincularRepite: readonly [string, Operation] = ['vincularRepite', {
  access: 'platform', input: S.vincularRepite.input, output: S.vincularRepite.output,
  restaurantId: input => (input as In<'vincularRepite'>).restaurantId,
  run: async (client, raw) => {
    const d = raw as In<'vincularRepite'>
    try {
      await client.query('SELECT llenamos.repite_link($1,$2,$3,$4,$5)', [d.restaurantId, d.merchantId, d.reason, d.requestId, stableHash({ ...d, requestId: undefined })])
    } catch (error) { mapLinkError(error) }
    return { ok: true as const }
  },
}]

export const guardarAjustesRepite = memberOperation('guardarAjustesRepite', {
  permission: 'fidelizacion.gestionar', modules: ['repite'], input: S.guardarAjustesRepite.input as z.ZodType<In<'guardarAjustesRepite'>>, output: S.guardarAjustesRepite.output as z.ZodType<Out<'guardarAjustesRepite'>>,
  run: async (client, d, scope) => {
    const s = d.settings
    const { rows } = await client.query(`INSERT INTO llenamos.repite_settings(restaurant_id,enabled,stamp_on,auto_create_card,updated_by) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(restaurant_id) DO UPDATE SET enabled=EXCLUDED.enabled,stamp_on=EXCLUDED.stamp_on,auto_create_card=EXCLUDED.auto_create_card,revision=llenamos.repite_settings.revision+1,updated_by=EXCLUDED.updated_by,updated_at=now()
      RETURNING merchant_id`, [d.restaurantId, s.enabled, s.stampOn, s.autoCreateCard, scope.uid])
    await notify(client, d.restaurantId, 'fidelizacion.repite', 'settings')
    // Al encender Repite se reabren las operaciones que se cerraron como «sin configurar» mientras estuvo apagado (solo las de los últimos 7 días, como mucho 200 por vez).
    if (s.enabled && rows[0].merchant_id) {
      const stuck = await client.query("SELECT id FROM llenamos.repite_queue WHERE restaurant_id=$1 AND merchant_id=$2 AND status='not_configured' AND kind<>'remove_card' AND occurred_at_ms>$3 ORDER BY occurred_at_ms,id LIMIT 200", [d.restaurantId, rows[0].merchant_id, now() - 7 * 86_400_000])
      for (const row of stuck.rows) await reopenRepite(client, d.restaurantId, row.id as string)
    }
    // Guardar ajustes no acredita un adaptador: sin uno, nunca está conectado.
    return { ok: true as const, connected: !!rows[0].merchant_id && repiteConfigured() }
  },
})

export const crearTarjetaRepite = memberOperation('crearTarjetaRepite', {
  permission: 'fidelizacion.operar', modules: ['repite'], input: S.crearTarjetaRepite.input as z.ZodType<In<'crearTarjetaRepite'>>, output: S.crearTarjetaRepite.output as z.ZodType<Out<'crearTarjetaRepite'>>,
  run: async (client, d) => {
    const rid = d.restaurantId, settings = await repiteSettings(client, rid)
    if (!settings.enabled || !settings.merchantId || !repiteConfigured()) return { status: 'not_configured' as const, message: NOT_CONNECTED }
    const customer = await customerRow(client, rid, d.customerId)
    if (!customer) throw notFound()
    if (customer.redacted) throw failed('Los datos del cliente se han suprimido.')
    const id = core.repiteOperationId.card(d.customerId)
    const link = (await client.query("SELECT card_id FROM llenamos.repite_cards WHERE restaurant_id=$1 AND customer_id=$2 AND status='active'", [rid, d.customerId])).rows[0]
    if (link) {
      const created = (await client.query('SELECT result FROM llenamos.repite_queue WHERE restaurant_id=$1 AND id=$2', [rid, id])).rows[0]
      return { status: 'ready' as const, cardId: link.card_id as string, saveUrl: typeof created?.result?.saveUrl === 'string' ? created.result.saveUrl as string : null }
    }
    // Una `card.<id>` terminada no se puede dejar descartar la petición: si la tarjeta ya no está activa (retirada tras un borrado) se reabre con una referencia nueva.
    const finished = (await client.query("SELECT status FROM llenamos.repite_queue WHERE restaurant_id=$1 AND id=$2 FOR UPDATE", [rid, id])).rows[0]
    if (finished && ['done', 'duplicate', 'failed', 'not_configured', 'skipped'].includes(finished.status)) {
      const succeeded = finished.status === 'done' || finished.status === 'duplicate'
      if (succeeded) {
        // La persona que vuelve tras retirar su tarjeta: referencia nueva (otra tarjeta), y la retirada terminada se aparta para que un borrado posterior retire ESTA tarjeta.
        await client.query('UPDATE llenamos.repite_queue SET external_ref=NULL,result=NULL WHERE restaurant_id=$1 AND id=$2', [rid, id])
        await client.query("UPDATE llenamos.repite_queue SET id=id||'.'||$3 WHERE restaurant_id=$1 AND id=$2 AND status IN ('done','duplicate','skipped','failed','not_configured')", [rid, core.repiteOperationId.remove(d.customerId), String(now())])
        await client.query("UPDATE llenamos.repite_queue SET status='queued',attempts=0,next_attempt_at_ms=$3,lease_until_ms=NULL,lease_owner=NULL,last_error=NULL WHERE restaurant_id=$1 AND id=$2", [rid, id, now()])
        await wake(client, rid, id, now(), now())
      } else {
        // Fallida, sin configurar u omitida: se conserva la referencia opaca (Repite pudo crear la tarjeta aunque no llegara la respuesta) y se reintenta con la misma clave.
        await reopenRepite(client, rid, id)
      }
      return { status: 'queued' as const }
    }
    await enqueueRepite(client, rid, { id, kind: 'create_card', customerId: d.customerId, merchantId: settings.merchantId })
    return { status: 'queued' as const }
  },
})

export const darSelloRepite = memberOperation('darSelloRepite', {
  permission: 'fidelizacion.operar', modules: ['repite'], input: S.darSelloRepite.input as z.ZodType<In<'darSelloRepite'>>, output: S.darSelloRepite.output as z.ZodType<Out<'darSelloRepite'>>,
  run: async (client, d, scope) => {
    const rid = d.restaurantId
    await assertLocation(client, rid, scope, d.locationId)
    // El personal no puede sellar una referencia inventada: reservas o mesas confirman que la visita es de este cliente.
    await visits().assertVisit(client, { restaurantId: rid, locationId: d.locationId, customerId: d.customerId, reservationId: d.reservationId, sessionId: d.sessionId })
    const key = core.repiteVisitKey({ restaurantId: rid, reservationId: d.reservationId, sessionId: d.sessionId })
    return queueStamp(client, rid, d.customerId, key, 'manual', true)
  },
})

/** Para cada cliente, ¿hay una baja de marketing sin permiso vigente posterior? */
async function withdrawnMarketing(client: PoolClient, rid: string, customerIds: string[], at: number): Promise<Set<string>> {
  if (!customerIds.length) return new Set()
  const { rows } = await client.query(`SELECT e.customer_id,e.purpose,e.status,e.at_ms FROM unnest($2::text[]) AS c(id) CROSS JOIN LATERAL (
      SELECT customer_id,purpose,status,floor(extract(epoch from at)*1000)::bigint AS at_ms FROM llenamos.marketing_consents
      WHERE restaurant_id=$1 AND customer_id=c.id AND purpose<>'digital_receipt' ORDER BY at DESC LIMIT 100) e`, [rid, customerIds])
  const events = rows.map(r => ({ customerId: r.customer_id as string, purpose: r.purpose as core.Consent['purpose'], status: r.status as core.Consent['status'], at: Number(r.at_ms), policyVersion: '', source: 'staff' as const, evidenceId: 'x' }))
  const out = new Set<string>()
  for (const e of events) if (e.status === 'withdrawn' && !core.hasCurrentConsent(events, e.customerId, e.purpose, at)) out.add(e.customerId)
  return out
}

export const avisarTeEchamosDeMenos = memberOperation('avisarTeEchamosDeMenos', {
  permission: 'fidelizacion.gestionar', modules: ['repite'], input: S.avisarTeEchamosDeMenos.input as z.ZodType<In<'avisarTeEchamosDeMenos'>>, output: S.avisarTeEchamosDeMenos.output as z.ZodType<Out<'avisarTeEchamosDeMenos'>>,
  run: async (client, d) => {
    const rid = d.restaurantId, settings = await repiteSettings(client, rid)
    if (!settings.enabled || !settings.merchantId) throw failed('Repite no está conectado.')
    const t = now(), date = core.horaLocal(t, await restaurantTimezone(client, rid)).fecha
    const ids = [...new Set(d.customerIds)]
    const cards = new Set((await client.query("SELECT customer_id FROM llenamos.repite_cards WHERE restaurant_id=$1 AND customer_id=ANY($2) AND status='active'", [rid, ids])).rows.map(r => r.customer_id as string))
    const withdrawn = await withdrawnMarketing(client, rid, ids, t)
    let queued = 0
    const skipped: Out<'avisarTeEchamosDeMenos'>['skipped'] = []
    for (const customerId of ids) {
      if (withdrawn.has(customerId)) { skipped.push({ customerId, reason: 'withdrawn' }); continue }
      if (!cards.has(customerId)) { skipped.push({ customerId, reason: 'no_card' }); continue }
      if (await enqueueRepite(client, rid, { id: core.repiteOperationId.weMissYou(customerId, date), kind: 'we_miss_you', customerId, merchantId: settings.merchantId }, t)) queued++
      else skipped.push({ customerId, reason: 'already_today' })
    }
    return { queued, skipped }
  },
})

/* Proceso de la cola (worker V2) ------------------------------------------------------------------------ */

/** Abre una transacción con el contexto del restaurante (lo pone el worker). */
export type TxRunner = <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T>
export interface ProcessOptions { now?: number; adapter?: core.RepiteAdapter; limit?: number }
const LEASE_MS = 60_000

interface Claim { op: any; link: { merchantId: string; cardId: string; externalRef: string; status: 'active' | 'removed'; createdAt: number } | null; externalRef: string; displayName: string; language: 'es' | 'ca' | 'en' }

async function claim(client: PoolClient, rid: string, id: string, owner: string, at: number): Promise<Claim | null> {
  const op = (await client.query('SELECT * FROM llenamos.repite_queue WHERE restaurant_id=$1 AND id=$2 FOR UPDATE', [rid, id])).rows[0]
  if (!op) return null
  const settings = await repiteSettings(client, rid)
  const mark = (status: string) => client.query('UPDATE llenamos.repite_queue SET status=$3,lease_until_ms=NULL,lease_owner=NULL WHERE restaurant_id=$1 AND id=$2', [rid, id, status])
  // Una operación que ya no se puede hacer (módulo apagado, Repite desactivado o comercio cambiado) se cierra: si se dejara en cola,
  // las primeras de cada pasada taparían a las demás para siempre.
  if (op.kind !== 'remove_card' && ['queued', 'leased'].includes(op.status)) {
    if (!(await moduleActive(client, rid, 'repite')) || !settings.enabled) { await mark('not_configured'); return null }
    if (settings.merchantId !== op.merchant_id) { await mark('skipped'); return null }
  }
  if (!['queued', 'leased'].includes(op.status) || (op.next_attempt_at_ms !== null && Number(op.next_attempt_at_ms) > at) || (op.lease_until_ms !== null && Number(op.lease_until_ms) > at)) return null
  const linkRow = (await client.query('SELECT merchant_id,card_id,external_ref,status,created_at_ms FROM llenamos.repite_cards WHERE restaurant_id=$1 AND customer_id=$2', [rid, op.customer_id])).rows[0]
  const customer = await customerRow(client, rid, op.customer_id)
  if (op.kind !== 'remove_card' && (!customer || customer.redacted)) { await mark('skipped'); return null }
  if (op.kind === 'we_miss_you' && (await withdrawnMarketing(client, rid, [op.customer_id], at)).has(op.customer_id)) { await mark('skipped'); return null }
  const link = linkRow ? { merchantId: linkRow.merchant_id, cardId: linkRow.card_id, externalRef: linkRow.external_ref, status: linkRow.status, createdAt: Number(linkRow.created_at_ms) } : null
  if (!link && op.kind !== 'create_card' && op.kind !== 'remove_card' && !settings.autoCreateCard) { await mark('skipped'); return null }
  // La referencia opaca se guarda antes de llamar a Repite y sobrevive a un fallo de red.
  const cardOpId = core.repiteOperationId.card(op.customer_id)
  const cardOp = (await client.query('SELECT external_ref FROM llenamos.repite_queue WHERE restaurant_id=$1 AND id=$2', [rid, cardOpId])).rows[0]
  const externalRef: string = cardOp?.external_ref ?? op.external_ref ?? randomBytes(24).toString('base64url')
  if (!link && op.kind === 'add_stamp' && !cardOp) await enqueueRepite(client, rid, { id: cardOpId, kind: 'create_card', customerId: op.customer_id, merchantId: op.merchant_id, externalRef }, at)
  else if (!link && cardOp && !cardOp.external_ref) await client.query('UPDATE llenamos.repite_queue SET external_ref=$3 WHERE restaurant_id=$1 AND id=$2', [rid, cardOpId, externalRef])
  await client.query("UPDATE llenamos.repite_queue SET status='leased',lease_until_ms=$3,lease_owner=$4,external_ref=$5 WHERE restaurant_id=$1 AND id=$2", [rid, id, at + LEASE_MS, owner, externalRef])
  return { op, link, externalRef, displayName: (customer?.name ?? 'Cliente').split(' ')[0] || 'Cliente', language: customer?.language ?? 'es' }
}

const crash = (): core.RepiteResult<never> => ({ ok: false, error: { code: 'unavailable', message: 'Repite no responde o su respuesta no es válida.', retryable: true } })
async function guarded<T>(call: () => Promise<core.RepiteResult<T>>): Promise<core.RepiteResult<T>> { try { return await call() } catch { return crash() } }

/**
 * Procesa las operaciones vencidas de un restaurante: reclama con lease (transacción), llama a Repite SIN
 * transacción abierta y finaliza con el dueño del lease. Lo invoca el worker al recibir un trabajo
 * `fidelizacion.procesar_repite` o de forma periódica. Sin adaptador, las operaciones quedan en `not_configured`.
 */
export async function processRepite(run: TxRunner, rid: string, o: ProcessOptions = {}): Promise<number> {
  const at = o.now ?? now(), provider = o.adapter ?? repiteAdapter(), limit = Math.min(o.limit ?? 20, 100)
  const due = await run(async client => (await client.query(
    "SELECT id FROM llenamos.repite_queue WHERE restaurant_id=$1 AND status IN ('queued','leased') AND next_attempt_at_ms<=$2 AND (lease_until_ms IS NULL OR lease_until_ms<=$2) ORDER BY next_attempt_at_ms,id LIMIT $3", [rid, at, limit])).rows.map(r => r.id as string))
  let processed = 0
  for (const id of due) {
    const owner = randomUUID()
    const c = await run(client => claim(client, rid, id, owner, at))
    if (!c) continue
    let link = c.link, result: core.RepiteResult<unknown>
    const op = c.op, merchantId: string = op.merchant_id
    if (op.kind === 'create_card' || (!link && op.kind === 'add_stamp')) {
      const card = await guarded(() => provider.createCard({ merchantId, externalRef: c.externalRef, displayName: c.displayName, language: c.language, // La clave lleva la referencia opaca de ESTA tarjeta: quien vuelve con el mismo teléfono tras un borrado no recibe la tarjeta de la persona borrada.
      idempotencyKey: `${rid}.${core.repiteOperationId.card(op.customer_id)}.${c.externalRef}` }))
      if (card.ok) link = { merchantId, cardId: card.value.cardId, externalRef: c.externalRef, status: 'active', createdAt: at }
      result = card
    } else result = { ok: true, value: {} }
    if (result.ok && op.kind !== 'create_card') {
      const cardId = link?.cardId ?? String(op.result?.cardId ?? '')
      const p = { merchantId, cardId, idempotencyKey: `${id}.${cardId}` }
      if (op.kind === 'add_stamp') result = await guarded(() => provider.addStamp({ ...p, visitKey: op.visit_key, trigger: op.trigger, occurredAt: Number(op.occurred_at_ms) }))
      else if (op.kind === 'we_miss_you') result = await guarded(() => provider.sendWeMissYou(p))
      else result = await guarded(() => provider.removeCard(p))
    }
    const final = result
    const done = await run(async client => {
      const row = (await client.query('SELECT status,lease_owner FROM llenamos.repite_queue WHERE restaurant_id=$1 AND id=$2 FOR UPDATE', [rid, id])).rows[0]
      if (!row || row.lease_owner !== owner || row.status !== 'leased') return false
      const customer = await customerRow(client, rid, op.customer_id)
      if (link && customer && !customer.redacted && op.kind !== 'remove_card') {
        await client.query(`INSERT INTO llenamos.repite_cards(restaurant_id,customer_id,merchant_id,card_id,external_ref,status,created_at_ms) VALUES($1,$2,$3,$4,$5,'active',$6)
          ON CONFLICT(restaurant_id,customer_id) DO UPDATE SET merchant_id=EXCLUDED.merchant_id,card_id=EXCLUDED.card_id,external_ref=EXCLUDED.external_ref,status='active',created_at_ms=EXCLUDED.created_at_ms
          WHERE llenamos.repite_cards.status='removed' AND EXCLUDED.card_id<>llenamos.repite_cards.card_id`, [rid, op.customer_id, link.merchantId, link.cardId, link.externalRef, link.createdAt])
      }
      if (op.kind === 'remove_card' && final.ok) await client.query("UPDATE llenamos.repite_cards SET status='removed' WHERE restaurant_id=$1 AND customer_id=$2", [rid, op.customer_id])
      const settled = core.settleRepiteOperation({ attempts: op.attempts }, final, at)
      const retryAfter = !final.ok ? Number((final.error as core.RepiteError & { retryAfterMs?: number }).retryAfterMs ?? 0) : 0
      const next = settled.nextAttemptAt === null ? null : Math.max(settled.nextAttemptAt, at + retryAfter)
      const stored = final.ok ? final.value : null
      await client.query(`UPDATE llenamos.repite_queue SET status=$3,attempts=$4,next_attempt_at_ms=$5,lease_until_ms=NULL,lease_owner=NULL,last_error=$6,result=coalesce($7,CASE WHEN $8 THEN result END)
        WHERE restaurant_id=$1 AND id=$2`, [rid, id, settled.status, settled.attempts, next, settled.lastError ? JSON.stringify(settled.lastError) : null, stored ? JSON.stringify(stored) : null, op.kind === 'remove_card'])
      if (settled.status === 'queued' && next !== null) await wake(client, rid, id, next, settled.attempts)
      await notify(client, rid, 'fidelizacion.repite', id)
      return true
    })
    if (done) processed++
  }
  return processed
}
