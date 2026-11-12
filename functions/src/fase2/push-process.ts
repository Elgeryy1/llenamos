import { randomUUID } from 'node:crypto'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { onSchedule } from 'firebase-functions/v2/scheduler'
import * as core from '@llenamos/core'
import { db, options } from '../shared'
import { sendPush, vapidConfig, type PushSubscriptionData } from './web-push'

/** Solo tareas vencidas sin dueño. El servidor vuelve a comprobar permisos y estado al enviar. */
export async function processPush(rid?: string, lid?: string, deps: { transport?: typeof fetch; capture?: boolean; now?: number } = {}) {
  const config = vapidConfig()
  if (!config) return { configured: false, sent: 0, captured: 0 }
  const now = deps.now ?? Date.now(), capture = deps.capture ?? !!process.env.FIRESTORE_EMULATOR_HOST
  let sent = 0, captured = 0
  const restaurants = rid ? [db.doc(`restaurants/${rid}`)] : (await db.collection('restaurants').get()).docs.map(d => d.ref)
  for (const root of restaurants) {
    const locals = lid ? [root.collection('locations').doc(lid)] : (await root.collection('locations').get()).docs.map(d => d.ref)
    for (const local of locals) {
      const [tasks, subscriptions] = await Promise.all([local.collection('floorTasks').where('status', '==', 'open').get(), local.collection('pushSubscriptions').where('enabled', '==', true).get()])
      for (const task of tasks.docs) {
        const parsed = core.FloorTaskSchema.safeParse(task.data())
        if (!parsed.success || parsed.data.claimedBy || parsed.data.dueAt > now) continue
        for (const sub of subscriptions.docs) {
          const id = core.sha256Hex(JSON.stringify([task.id, parsed.data.dueAt, sub.id]))
          const delivery = local.collection('pushDeliveries').doc(id), lease = randomUUID()
          const active = async () => {
            const [r, l, t, s, m] = await Promise.all([root.get(), local.get(), task.ref.get(), sub.ref.get(), root.collection('members').doc(String(sub.get('uid'))).get()])
            const member = core.MemberSchema.safeParse(m.data())
            return r.exists && l.exists && core.hasModule(r.data()!, 'floor') && t.get('status') === 'open' && !t.get('claimedBy') && core.timestampToMillis(t.get('dueAt')) === parsed.data.dueAt && s.get('enabled') && s.get('publicKey') === config.publicKey && member.success && member.data.active && core.can(member.data.role, 'tareas.atender') && (!member.data.locationIds.length || member.data.locationIds.includes(local.id))
          }
          if (!await active()) continue
          const locked = await db.runTransaction(async tx => {
            const [previous, current] = await Promise.all([tx.get(delivery), tx.get(task.ref)])
            if (current.get('status') !== 'open' || current.get('claimedBy')) return false
            const old = previous.data()
            if (old && (['sent', 'captured', 'expired', 'cancelled'].includes(old.status) || old.attempts >= 3 || core.timestampToMillis(old.retryAt)! > now)) return false
            tx.set(delivery, { taskId: task.id, subscriptionId: sub.id, status: 'sending', lease, attempts: (old?.attempts ?? 0) + 1, retryAt: Timestamp.fromMillis(now + 60_000), updatedAt: FieldValue.serverTimestamp(), updatedBy: null, ...(!previous.exists ? { createdAt: FieldValue.serverTimestamp() } : {}) }, { merge: true })
            return true
          })
          if (!locked) continue
          const payload = JSON.stringify({ title: `${parsed.data.label || 'Sala'} necesita atención`, body: `${core.FLOOR_TASK_TYPE_LABEL[parsed.data.type]} con retraso y sin responsable.`, tag: `task:${root.id}:${local.id}:${task.id}`, url: `/panel/avisos?task=${encodeURIComponent(task.id)}&restaurant=${encodeURIComponent(root.id)}&local=${encodeURIComponent(local.id)}${parsed.data.sessionId ? `&s=${encodeURIComponent(parsed.data.sessionId)}` : ''}` })
          let status = 'cancelled', error: string | null = null
          try {
            if (await active()) {
              if (capture) { status = 'captured'; captured++ }
              else {
                const response = await sendPush(sub.data() as PushSubscriptionData, payload, config, deps.transport)
                if (response.status === 404 || response.status === 410) {
                  // No desactiva una suscripción renovada mientras se enviaba el aviso.
                  await db.runTransaction(async tx => { const current = await tx.get(sub.ref); if (current.get('publicKey') === sub.get('publicKey')) tx.update(sub.ref, { enabled: false, updatedBy: null, updatedAt: FieldValue.serverTimestamp() }) })
                  status = 'expired'
                } else if (response.ok) { status = 'sent'; sent++ }
                else { status = 'failed'; error = `HTTP ${response.status}` }
              }
            }
          } catch { status = 'failed'; error = 'No se pudo entregar al servicio push.' }
          await db.runTransaction(async tx => {
            const current = await tx.get(delivery)
            if (current.get('lease') === lease) tx.update(delivery, { status, error, ...(capture ? { payload: JSON.parse(payload) as Record<string, string> } : {}), updatedAt: FieldValue.serverTimestamp() })
          })
        }
      }
    }
  }
  return { configured: true, sent, captured }
}
export const avisosRetrasados = onSchedule({ ...options, schedule: 'every 1 minutes', timeZone: 'Europe/Madrid' }, () => processPush().then(() => undefined))
