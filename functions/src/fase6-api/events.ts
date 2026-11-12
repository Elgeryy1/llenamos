import { FieldPath, Timestamp, type Transaction } from 'firebase-admin/firestore'
import { randomBytes } from 'node:crypto'
import * as core from '@llenamos/core'
import { db, stamp } from '../shared'
import { unseal } from './security'
import { sendWebhook, type WebhookTransport } from './destination'

/** El productor llama dentro de su decisión transaccional, tras todas sus lecturas. */
export function enqueuePlatformEvent(tx: Transaction, input: core.PlatformEvent): void {
  const event = core.PlatformEventSchema.parse(input)
  tx.create(db.doc(`restaurants/${event.restaurantId}/platformEvents/${event.id}`), { ...event, distributed: false, ...stamp() })
}
/** Id determinista de un hecho: la misma decisión confirmada produce siempre el mismo id, venga de la ruta que venga. */
export const platformEventId = (...parts: (string | number)[]) => core.sha256Hex(JSON.stringify(parts))
/**
 * Evento de reserva en la transacción del productor, tras sus lecturas. `decision` identifica el hecho:
 * 'created' al crearla y el largo del historial al cambiar de estado (igual desde reservas, sala, señal o WhatsApp).
 */
export function enqueueReservationEvent(tx: Transaction, input: { restaurantId: string; locationId: string; type: 'reservation.created' | 'reservation.statusChanged'; reservationId: string; status: string; decision: string | number; at: number }): void {
  enqueuePlatformEvent(tx, {
    id: platformEventId(input.restaurantId, input.locationId, input.type, input.reservationId, input.decision), type: input.type, version: 1,
    restaurantId: input.restaurantId, locationId: input.locationId, occurredAt: input.at, data: { entityId: input.reservationId, status: input.status },
  })
}
export async function distributeEvents(rid: string, limit = 100) {
  const root = db.doc(`restaurants/${rid}`)
  const events = await root.collection('platformEvents').where('distributed', '==', false).limit(limit).get()
  for (const ref of events.docs) await db.runTransaction(async tx => {
    const stored = await tx.get(ref.ref)
    if (stored.get('distributed')) return
    const event = core.PlatformEventSchema.parse(stored.data())
    let endpointQuery = root.collection('webhookEndpoints').orderBy(FieldPath.documentId()).limit(100)
    if (stored.get('endpointCursor')) endpointQuery = endpointQuery.startAfter(stored.get('endpointCursor'))
    const endpoints = await tx.get(endpointQuery)
    const matching = endpoints.docs.filter(e => {
      const endpoint = core.WebhookEndpointSchema.parse(e.data())
      return endpoint.status !== 'revoked' && endpoint.events.includes(event.type) &&
        (event.locationId !== null ? endpoint.locationIds.includes(event.locationId) : event.type === 'subscription.changed')
    })
    const deliveries = await Promise.all(matching.map(e => tx.get(root.collection('webhookDeliveries').doc(core.webhookDeliveryId(e.id, event.id)))))
    const body = core.webhookBody(event)
    matching.forEach((e, i) => {
      if (deliveries[i]!.exists) return
      const delivery: core.WebhookDelivery = { endpointId: e.id, eventId: event.id, body, bodyHash: core.sha256Hex(body),
        status: 'queued', attempts: 0, nextAttemptAt: event.occurredAt, leaseUntil: null, lastStatus: null, lastError: null }
      tx.create(deliveries[i]!.ref, { ...core.webhookDeliveryForWrite(delivery, Timestamp.fromMillis), round: 0, ...stamp() })
    })
    const distributed = endpoints.size < 100
    // Las entregas guardan su propio cuerpo. Solo el evento ya repartido puede caducar;
    // nunca borrar por TTL un hecho que aún no ha generado todas sus entregas.
    tx.update(stored.ref, { distributed, endpointCursor: endpoints.docs.at(-1)?.id ?? '',
      ...(distributed ? { expiresAt: Timestamp.fromMillis(Date.now() + 90 * 86_400_000) } : {}), updatedAt: Timestamp.now() })
  })
  return events.size
}

/** Lease con propietario único: una respuesta de un trabajador vencido no confirma otro intento. */
export async function deliverWebhook(rid: string, deliveryId: string, transport: WebhookTransport = sendWebhook, now = Date.now()) {
  const root = db.doc(`restaurants/${rid}`), ref = root.collection('webhookDeliveries').doc(deliveryId)
  const leaseId = randomBytes(16).toString('hex')
  const claimed = await db.runTransaction(async tx => {
    const doc = await tx.get(ref)
    if (!doc.exists) return null
    const d = core.WebhookDeliverySchema.parse(doc.data())
    if (['delivered', 'cancelled', 'exhausted'].includes(d.status) || d.nextAttemptAt > now || (d.leaseUntil !== null && d.leaseUntil > now)) return null
    const endpointDoc = await tx.get(root.collection('webhookEndpoints').doc(d.endpointId))
    if (!endpointDoc.exists || endpointDoc.get('status') === 'revoked') {
      tx.update(ref, { status: 'cancelled', leaseUntil: null, updatedAt: Timestamp.fromMillis(now) }); return null
    }
    if (endpointDoc.get('status') !== 'active') return null
    if (d.attempts >= 12) {
      tx.update(ref, { status: 'exhausted', leaseUntil: null }); tx.update(endpointDoc.ref, { status: 'suspended' }); return null
    }
    const endpoint = core.WebhookEndpointSchema.parse(endpointDoc.data())
    const event = core.PlatformEventSchema.parse(JSON.parse(d.body))
    if (!endpoint.events.includes(event.type) || (event.locationId !== null ? !endpoint.locationIds.includes(event.locationId) : event.type !== 'subscription.changed')) {
      tx.update(ref, { status: 'cancelled', leaseUntil: null, updatedAt: Timestamp.fromMillis(now) }); return null
    }
    const secret = await tx.get(root.collection('webhookSecrets').doc(`${d.endpointId}_${endpoint.secretVersion}`))
    if (!secret.exists) return null
    tx.update(ref, { status: 'leased', leaseId, attempts: d.attempts + 1, lastAttemptAt: Timestamp.fromMillis(now), leaseUntil: Timestamp.fromMillis(now + 30_000), updatedAt: Timestamp.fromMillis(now) })
    return { ...d, attempts: d.attempts + 1, endpoint, secret: unseal<string>(secret.get('ciphertext'), secret.ref.path), round: Number(doc.get('round') ?? 0) }
  })
  if (!claimed) return false
  const started = Date.now()
  let status: number | null = null, error: string | null = null
  try {
    if (core.sha256Hex(claimed.body) !== claimed.bodyHash) throw new Error('body_changed')
    status = await transport(claimed.endpoint.url, claimed.body, core.signPlatformWebhook(claimed.secret, Math.floor(Date.now() / 1000), claimed.body))
    if (!Number.isInteger(status) || status < 100 || status > 599) throw new Error('invalid_status')
  } catch { status = null; error = 'No se pudo conectar con el receptor de forma segura.' }
  await db.runTransaction(async tx => {
    const stored = await tx.get(ref), endpointRef = root.collection('webhookEndpoints').doc(claimed.endpointId)
    const endpoint = await tx.get(endpointRef)
    if (stored.get('leaseId') !== leaseId) return
    const revoked = !endpoint.exists || endpoint.get('status') === 'revoked'
    const success = status !== null && status >= 200 && status < 300
    const retryable = status === null || status === 429 || status >= 500
    const next = retryable ? core.nextWebhookAttempt(claimed.attempts, now) : null
    const finalStatus = revoked || status === 410 ? 'cancelled' : success ? 'delivered' : next !== null ? 'retry' : 'exhausted'
    tx.update(ref, { status: finalStatus, leaseUntil: null, lastStatus: status, lastError: success ? null : error ?? 'El receptor no ha aceptado la entrega.',
      nextAttemptAt: Timestamp.fromMillis(next ?? now), updatedAt: Timestamp.now() })
    tx.create(root.collection('webhookAttempts').doc(`${deliveryId}_${claimed.round}_${claimed.attempts}`), {
      deliveryId, eventId: claimed.eventId, attempt: claimed.attempts, round: claimed.round, status, durationMs: Date.now() - started,
      error, secretVersion: claimed.endpoint.secretVersion, ...stamp(),
    })
    if (endpoint.exists && !revoked) tx.update(endpointRef, { consecutiveFailures: success ? 0 : Number(endpoint.get('consecutiveFailures') ?? 0) + 1,
      ...(status === 410 ? { status: 'revoked' } : finalStatus === 'exhausted' ? { status: 'suspended' } : {}), updatedAt: Timestamp.now() })
  })
  return true
}
export async function processPlatformWebhooks(rid: string, transport: WebhookTransport = sendWebhook) {
  await distributeEvents(rid)
  const pending = await db.collection(`restaurants/${rid}/webhookDeliveries`).where('status', 'in', ['queued', 'retry', 'leased']).where('nextAttemptAt', '<=', Timestamp.now()).orderBy('nextAttemptAt').limit(100).get()
  let attempted = 0
  for (const doc of pending.docs) if (await deliverWebhook(rid, doc.id, transport)) attempted++
  await db.doc(`restaurants/${rid}/platform/apiHealth`).set({ workerLastRunAt: Timestamp.now(), attempted, outbound: process.env.FIRESTORE_EMULATOR_HOST ? 'disabled_except_injected_local_transport' : 'https', updatedAt: Timestamp.now() }, { merge: true })
  return attempted
}
