import { randomUUID } from 'node:crypto'
import * as core from '@llenamos/core'
import type { Pool, PoolClient } from 'pg'
import { stableUuid } from '../../ids.js'
import { enqueueJob } from '../../jobs.js'
import type { MaintenanceTask } from '../../worker/maintenance.js'
import { forEachRestaurant } from '../../worker/tasks.js'
import { withTenant } from '../../worker/tenant.js'
import type { WorkerHandler } from '../../worker/types.js'
import { restaurantView } from './context.js'
import { open } from './secrets.js'
import { sendPush, vapidConfig, type PushSubscriptionData, type VapidConfig } from './web-push.js'

export const PUSH_JOB = 'sala.avisos_push'
/** Solo pruebas: en producción la captura se ignora y se envía de verdad. */
const captureMode = () => process.env.SALA_PUSH_CAPTURE === '1' && process.env.NODE_ENV !== 'production'
const MAX_ATTEMPTS = 3, RETRY_MS = 60_000, RETENTION_DAYS = 7

type Task = { id: string; doc: core.FloorTask & Record<string, unknown> }
type Sub = { id: string; doc: { endpoint: string; keysSealed: string; uid: string; enabled: boolean; publicKey: string } }
type Member = { uid: string; role: string; active: boolean; location_ids: string[] }

/** Solo tareas abiertas, vencidas y sin responsable. */
export const overdueTask = (doc: { status: string; claimedBy?: unknown; dueAt: number }, now: number) => doc.status === 'open' && !doc.claimedBy && doc.dueAt <= now

/** Quién puede recibir avisos de este local: miembro activo con `tareas.atender` que ve el local. */
const eligibleUid = (m: Member, lid: string) => m.active && core.can(m.role as core.Role, 'tareas.atender') && (!m.location_ids.length || m.location_ids.includes(lid))

/** Comprobación ligera justo antes de enviar: la tarea sigue abierta, vencida y sin dueño, con la misma hora de vencimiento. */
async function taskStillOverdue(client: PoolClient, rid: string, lid: string, taskId: string, dueAt: number, now: number) {
  const t = (await client.query<{ doc: Task['doc'] }>('SELECT doc FROM llenamos.sala_floor_tasks WHERE restaurant_id=$1 AND location_id=$2 AND id=$3', [rid, lid, taskId])).rows[0]?.doc
  return !!t && overdueTask(t, now) && t.dueAt === dueAt
}

/**
 * Trabajo `sala.avisos_push` de un local (port de `processPush`): envía un aviso por tarea, hora de vencimiento y suscripción.
 * Restaurante y miembros se leen una vez; solo se consideran suscripciones de quien puede atender tareas. La reserva de la
 * entrega es atómica (`INSERT … ON CONFLICT DO UPDATE … WHERE` con `RETURNING`): dos trabajos solapados no envían el mismo
 * aviso, y un envío en vuelo (espera de un minuto, más que los 10 s de tope del push) no se repite. El envío va FUERA de la
 * transacción y con el `fetch` y la señal del worker. Sin claves VAPID no hay nada que enviar y no se simula.
 */
export function processPush(deps: { transport?: typeof fetch; now?: () => number } = {}): WorkerHandler {
  return async ctx => {
    const lid = ctx.item.payload.locationId
    if (typeof lid !== 'string' || !lid) return
    const rid = ctx.item.restaurantId
    const config = vapidConfig()
    if (!config) return
    const capture = captureMode()
    const clock = deps.now ?? Date.now
    const { tasks, subs } = await ctx.tenant(async client => {
      const restaurant = (await client.query('SELECT * FROM llenamos.restaurants WHERE id=$1', [rid])).rows[0]
      if (!restaurant || !core.hasModule(restaurantView(restaurant), 'floor')) return { tasks: [] as Task[], subs: [] as Sub[] }
      const uids = (await client.query<Member>('SELECT uid,role,active,location_ids FROM llenamos.memberships WHERE restaurant_id=$1 AND active', [rid])).rows.filter(m => eligibleUid(m, lid)).map(m => m.uid)
      if (!uids.length) return { tasks: [] as Task[], subs: [] as Sub[] }
      return {
        tasks: (await client.query<Task>("SELECT id,doc FROM llenamos.sala_floor_tasks WHERE restaurant_id=$1 AND location_id=$2 AND status='open' AND (doc->>'dueAt')::bigint<=$3 AND doc->>'claimedBy' IS NULL ORDER BY id LIMIT 50", [rid, lid, clock()])).rows,
        subs: (await client.query<Sub>("SELECT id,doc FROM llenamos.sala_private WHERE restaurant_id=$1 AND location_id=$2 AND kind='pushSubscriptions' AND (doc->>'enabled')::boolean AND doc->>'publicKey'=$3 AND doc->>'uid'=ANY($4) ORDER BY id LIMIT 200", [rid, lid, config.publicKey, uids])).rows,
      }
    })
    if (!tasks.length || !subs.length) return
    for (const task of tasks) {
      const parsed = core.FloorTaskSchema.safeParse(task.doc)
      if (!parsed.success || !overdueTask(parsed.data, clock())) continue
      // Una sola lectura de las entregas de la tarea: lo ya enviado o agotado no cuesta nada más.
      const ids = subs.map(sub => core.sha256Hex(JSON.stringify([task.id, parsed.data.dueAt, sub.id])))
      const closed = new Set((await ctx.tenant(client => client.query<{ id: string }>(
        "SELECT id FROM llenamos.sala_push_deliveries WHERE restaurant_id=$1 AND location_id=$2 AND id=ANY($3) AND (status IN ('sent','captured','expired','cancelled') OR attempts>=$4)", [rid, lid, ids, MAX_ATTEMPTS]))).rows.map(r => r.id))
      for (const [index, sub] of subs.entries()) {
        const id = ids[index]!
        if (closed.has(id)) continue
        if (ctx.signal.aborted) return
        const lease = randomUUID()
        const reserved = await ctx.tenant(async client => {
          const now = clock()
          if (!await taskStillOverdue(client, rid, lid, task.id, parsed.data.dueAt, now)) return false
          const { rowCount } = await client.query(
            `INSERT INTO llenamos.sala_push_deliveries(restaurant_id,location_id,id,task_id,subscription_id,status,lease,attempts,retry_at) VALUES($1,$2,$3,$4,$5,'sending',$6,1,$7)
             ON CONFLICT(restaurant_id,location_id,id) DO UPDATE SET status='sending',lease=$6,attempts=llenamos.sala_push_deliveries.attempts+1,retry_at=$7,updated_at=now()
               WHERE llenamos.sala_push_deliveries.status IN ('failed','sending') AND llenamos.sala_push_deliveries.attempts<$8 AND llenamos.sala_push_deliveries.retry_at<=$9
             RETURNING 1`,
            [rid, lid, id, task.id, sub.id, lease, now + RETRY_MS, MAX_ATTEMPTS, now])
          return !!rowCount
        })
        if (!reserved) continue
        const payload = JSON.stringify({
          title: `${parsed.data.label || 'Sala'} necesita atención`, body: `${core.FLOOR_TASK_TYPE_LABEL[parsed.data.type]} con retraso y sin responsable.`, tag: `task:${rid}:${lid}:${task.id}`,
          url: `/panel/avisos?task=${encodeURIComponent(task.id)}&restaurant=${encodeURIComponent(rid)}&local=${encodeURIComponent(lid)}${parsed.data.sessionId ? `&s=${encodeURIComponent(parsed.data.sessionId)}` : ''}`,
        })
        let status = 'cancelled', error: string | null = null, expired = false
        try {
          if (await ctx.tenant(client => taskStillOverdue(client, rid, lid, task.id, parsed.data.dueAt, clock()))) {
            if (capture) status = 'captured'
            else {
              const keys = JSON.parse(open(rid, sub.doc.keysSealed)) as PushSubscriptionData['keys']
              const response = await sendPush({ endpoint: sub.doc.endpoint, keys }, payload, config, deps.transport ?? ctx.fetch)
              if (response.status === 404 || response.status === 410) { status = 'expired'; expired = true }
              else if (response.ok) status = 'sent'
              else { status = 'failed'; error = `HTTP ${response.status}` }
            }
          }
        } catch { status = 'failed'; error = 'No se pudo entregar al servicio push.' }
        // En el modo de captura solo se guarda la etiqueta y el enlace: el título puede llevar el nombre de un cliente.
        const stored = capture ? JSON.stringify({ tag: `task:${rid}:${lid}:${task.id}`, url: (JSON.parse(payload) as { url: string }).url }) : null
        await ctx.tenant(async client => {
          const updated = await client.query('UPDATE llenamos.sala_push_deliveries SET status=$4,error=$5,payload=$6,updated_at=now() WHERE restaurant_id=$1 AND location_id=$2 AND id=$3 AND lease=$7',
            [rid, lid, id, status, error, stored, lease])
          // No desactiva una suscripción renovada mientras se enviaba el aviso (misma clave pública).
          if (expired && updated.rowCount) await client.query("UPDATE llenamos.sala_private SET doc=jsonb_set(doc,'{enabled}','false'),updated_at=now() WHERE restaurant_id=$1 AND location_id=$2 AND kind='pushSubscriptions' AND id=$3 AND doc->>'publicKey'=$4",
            [rid, lid, sub.id, sub.doc.publicKey])
        })
      }
    }
  }
}

/** Cada minuto, un trabajo por local con tareas vencidas sin dueño y suscripciones activas; ID estable por local y minuto. También retira entregas antiguas. */
export function pushMaintenance(pool: Pool, now: () => number = Date.now): MaintenanceTask[] {
  return [{ name: 'sala-avisos-push', everyMs: 60_000, run: () => forEachRestaurant(pool, rid => withTenant(pool, rid, async client => {
    if (!vapidConfig()) return 0
    const minute = Math.floor(now() / 60_000)
    const { rows } = await client.query<{ location_id: string }>(
      `SELECT DISTINCT t.location_id FROM llenamos.sala_floor_tasks t
         WHERE t.restaurant_id=$1 AND t.status='open' AND (t.doc->>'dueAt')::bigint<=$2 AND t.doc->>'claimedBy' IS NULL
           AND EXISTS(SELECT 1 FROM llenamos.sala_private p WHERE p.restaurant_id=t.restaurant_id AND p.location_id=t.location_id AND p.kind='pushSubscriptions' AND (p.doc->>'enabled')::boolean)`, [rid, now()])
    for (const { location_id } of rows)
      await enqueueJob(client, { id: stableUuid(PUSH_JOB, rid, location_id, String(minute)), restaurantId: rid, kind: PUSH_JOB, deduplicationKey: `${location_id}:${minute}`, payload: { locationId: location_id } })
    // Solo se retiran las entregas de tareas que ya no están abiertas: borrar la de una tarea abierta la reenviaría.
    await client.query("DELETE FROM llenamos.sala_push_deliveries d WHERE d.restaurant_id=$1 AND d.updated_at<now()-make_interval(days=>$2) AND NOT EXISTS(SELECT 1 FROM llenamos.sala_floor_tasks t WHERE t.restaurant_id=d.restaurant_id AND t.location_id=d.location_id AND t.id=d.task_id AND t.status='open')", [rid, RETENTION_DAYS])
    return rows.length
  })) }]
}
