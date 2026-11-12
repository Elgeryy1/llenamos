import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Timestamp } from 'firebase-admin/firestore'
import type { CallableRequest, Request } from 'firebase-functions/v2/https'
import * as core from '@llenamos/core'
import { db } from '../shared'
import { execute, measureUsage, type Name } from './service'
import { apiHandler } from './http'
import { deliverWebhook, distributeEvents, enqueuePlatformEvent } from './events'
const enabled = process.env.TEST_FIREBASE_EMULATORS === '1' && process.env.GCLOUD_PROJECT === 'demo-llenamos' && /^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? '')
const roots: string[] = []
let rid: string
const root = () => db.doc(`restaurants/${rid}`)
const request = (uid = 'owner', logiqd = false) => ({ auth: { uid, token: { logiqd } } }) as unknown as CallableRequest<unknown>
const call = (name: Name, input: unknown, uid = 'owner', logiqd = false) => execute(name, input, request(uid, logiqd))
const mutation = () => ({ restaurantId: rid, requestId: randomUUID() })
async function key(scopes: core.ApiScope[] = ['menu.read', 'orders.read'], locationIds = ['centro']) {
  return await call('crearClaveApi', { ...mutation(), name: 'Aplicación', scopes, locationIds, expiresAt: Date.now() + 86_400_000 }) as core.CallableOutput<'crearClaveApi'>
}
async function endpoint() { return await call('guardarWebhook', { ...mutation(), endpointId: null, url: 'https://93.184.216.34/eventos', events: ['order.placed'], locationIds: ['centro'], status: 'active' }) as core.CallableOutput<'guardarWebhook'> }
async function delivery() {
  const e = await endpoint(), event: core.PlatformEvent = { id: randomUUID(), type: 'order.placed', version: 1, restaurantId: rid, locationId: 'centro', occurredAt: Date.now(), data: { entityId: 'pedido', status: 'accepted' } }
  await db.runTransaction(async tx => enqueuePlatformEvent(tx, event)); await distributeEvents(rid); await distributeEvents(rid)
  return { ...e, event, deliveryId: core.webhookDeliveryId(e.endpointId, event.id) }
}
async function http(token: string, resource = 'orders', locationId = 'centro', query: Record<string, string> = {}, restaurantId = rid) {
  let status = 200, body: unknown
  const res = { set: () => res, status: (code: number) => { status = code; return res }, json: (value: unknown) => { body = value; return res } }
  const req = { method: 'GET', path: `/v1/restaurants/${restaurantId}/locations/${locationId}/${resource}`, query, get: () => `Bearer ${token}` }
  await apiHandler(req as unknown as Request, res as unknown as Parameters<typeof apiHandler>[1])
  return { status, body: body as Record<string, unknown> }
}

describe.skipIf(!enabled)('Panel y API con Firestore y Auth de la fila 2', { timeout: 30000 }, () => {
  beforeEach(async () => {
    rid = `api-${randomUUID()}`; roots.push(rid)
    await root().set({ brandColor: '#f0a35e', timezone: 'Europe/Madrid', currency: 'EUR', locale: 'es', isDemo: true, name: 'Restaurante de integración', slug: rid, plan: 'sala', activeModules: ['floor', 'kitchen', 'reservations'], entitlementVersion: 1, moduleOverrides: {} })
    for (const lid of ['centro', 'otro']) await root().collection('locations').doc(lid).set({ name: lid, slug: lid, address: '', city: '', phone: '' })
    for (const uid of ['owner', 'waiter', 'limited']) await root().collection('members').doc(uid).set({ uid, displayName: uid, email: `${uid}@test.es`, role: uid === 'waiter' ? 'waiter' : 'owner', active: true, locationIds: uid === 'limited' ? ['otro'] : [] })
    await root().collection('platform').doc('subscription').set({ planId: 'sala', planVersion: 1, status: 'trialing', interval: 'month', trialEndsAt: Timestamp.fromMillis(Date.now() + 86_400_000), periodEndsAt: null, graceEndsAt: null, cancelAtPeriodEnd: false, stripeCustomerId: null, stripeSubscriptionId: null, revision: 1 })
    await root().collection('platform').doc('entitlements').set({ version: 1, planId: 'sala', planVersion: 1, activeModules: ['floor', 'kitchen', 'reservations'], moduleOverrides: {}, limits: { locations: 3, members: 50, apiKeys: 5, webhooks: 5 }, serviceEnabled: true, reason: null, evaluatedAt: Timestamp.now(), nextEvaluationAt: null })
    for (let i = 0; i < 3; i++) await root().collection('locations').doc('centro').collection('orders').doc(`pedido${i}`).set({ sessionId: 'session', takeawayId: null, source: 'staff', status: 'accepted', lineIds: ['linea'], totalCents: 1500, note: 'SECRETO NO PUBLICAR', language: 'es', fire: 'auto', placedAt: Timestamp.fromMillis(1000 + i), createdBy: 'owner', decidedBy: 'owner', decidedAt: Timestamp.fromMillis(1000), rejectReason: null })
  }, 60000)
  afterAll(async () => {
    for (const id of roots) {
      await db.recursiveDelete(db.doc(`restaurants/${id}`)); await db.doc(`platformRestaurantUsage/${id}`).delete()
      for (const collection of ['platformRequests', 'platformSupport']) { const docs = await db.collection(collection).where('restaurantId', '==', id).get(); for (const doc of docs.docs) await doc.ref.delete() }
    }
  }, 60000)
  it('exige claim logiqd y no da permiso por ser owner', async () => {
    await expect(call('listarRestaurantesLogiqd', {}, 'owner')).rejects.toMatchObject({ code: 'permission-denied' })
    await expect(call('abrirAccesoSoporte', { ...mutation(), reason: 'Revisar incidencia', durationMinutes: 30 })).rejects.toMatchObject({ code: 'permission-denied' })
    const result = await call('abrirAccesoSoporte', { ...mutation(), reason: 'Revisar incidencia', durationMinutes: 30 }, 'equipo', true) as core.CallableOutput<'abrirAccesoSoporte'>
    expect(result.expiresAt - Date.now()).toBeLessThanOrEqual(30 * 60_000)
    expect((await db.doc(`platformSupport/${result.supportAccessId}`).get()).get('actorUid')).toBe('equipo')
    await expect(call('abrirAccesoSoporte', { ...mutation(), reason: 'Revisar', durationMinutes: 61 }, 'equipo', true)).rejects.toMatchObject({ code: 'invalid-argument' })
  })
  it('recupera el mismo secreto ante doble petición y cifra la respuesta; otra huella falla', async () => {
    const input = { ...mutation(), name: 'Doble', scopes: ['menu.read'], locationIds: ['centro'], expiresAt: Date.now() + 60_000 }
    const [a, b] = await Promise.all([call('crearClaveApi', input), call('crearClaveApi', input)])
    expect(a).toEqual(b); expect((await root().collection('apiKeys').get()).size).toBe(1)
    await expect(call('crearClaveApi', { ...input, name: 'Otro' })).rejects.toMatchObject({ code: 'already-exists' })
    const keyResult = a as core.CallableOutput<'crearClaveApi'>, doc = (await root().collection('apiKeys').get()).docs[0]!
    expect(JSON.stringify(doc.data())).not.toContain(keyResult.token)
    expect(doc.id).not.toBe(doc.get('tokenHash'))
    const receipt = (await db.collection('platformRequests').where('restaurantId', '==', rid).get()).docs[0]!
    expect(JSON.stringify(receipt.data())).not.toContain(keyResult.token)
    await receipt.ref.update({ expiresAt: Timestamp.fromMillis(0) })
    await expect(call('crearClaveApi', input)).rejects.toMatchObject({ code: 'failed-precondition' })
  })
  it('reserva cuota transaccional y libera claves caducadas', async () => {
    await root().collection('platform').doc('entitlements').update({ 'limits.apiKeys': 1 })
    const results = await Promise.allSettled([key(), key()])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1)
    await (await root().collection('apiKeys').get()).docs[0]!.ref.update({ expiresAt: Timestamp.fromMillis(0) })
    await expect(key()).resolves.toHaveProperty('token')
  })
  it('deniega otro restaurante, local, rol y membresía revocada', async () => {
    await expect(call('crearClaveApi', { ...mutation(), name: 'No', scopes: ['menu.read'], locationIds: ['centro'], expiresAt: Date.now() + 1000 }, 'limited')).rejects.toMatchObject({ code: 'permission-denied' })
    await expect(call('listarIntegraciones', { restaurantId: rid }, 'waiter')).rejects.toMatchObject({ code: 'permission-denied' })
    const k = await key()
    expect((await http(k.token, 'orders', 'otro')).status).toBe(403)
    expect((await http(k.token, 'orders', 'centro', {}, 'restaurante-ajeno')).status).toBe(401)
    await root().collection('members').doc('owner').update({ active: false })
    await expect(call('listarIntegraciones', { restaurantId: rid })).rejects.toMatchObject({ code: 'permission-denied' })
  })
  it('limita alcance, caducidad, revocación y vencimiento exacto de prueba en HTTP', async () => {
    const k = await key(['menu.read'])
    expect((await http(k.token)).status).toBe(403)
    await root().collection('apiKeys').doc(k.keyId).update({ scopes: ['orders.read'] })
    expect((await http(k.token)).status).toBe(200)
    await root().collection('platform').doc('subscription').update({ trialEndsAt: Timestamp.fromMillis(0) })
    expect((await http(k.token)).status).toBe(403)
    await root().collection('apiKeys').doc(k.keyId).update({ expiresAt: Timestamp.fromMillis(0) })
    expect((await http(k.token)).status).toBe(401)
    await root().collection('apiKeys').doc(k.keyId).update({ expiresAt: Timestamp.fromMillis(Date.now() + 60_000) })
    await call('revocarClaveApi', { ...mutation(), keyId: k.keyId })
    expect((await http(k.token)).status).toBe(401)
  })
  it('pagina pedidos sin notas ni contactos y rechaza cursor alterado o de otro local/clave', async () => {
    const k = await key(), a = await http(k.token, 'orders', 'centro', { limit: '1' })
    expect(a.status).toBe(200); expect(JSON.stringify(a.body)).not.toContain('SECRETO')
    const cursor = a.body.nextCursor as string
    const b = await http(k.token, 'orders', 'centro', { limit: '1', cursor })
    expect((a.body.orders as { id: string }[])[0]!.id).not.toBe((b.body.orders as { id: string }[])[0]!.id)
    expect((await http(k.token, 'orders', 'centro', { limit: '1', cursor: cursor + 'x' })).status).toBe(400)
    const other = await key(['orders.read'], ['otro'])
    expect((await http(other.token, 'orders', 'otro', { limit: '1', cursor })).status).toBe(400)
  })
  it('aplica el límite por clave y devuelve 429', async () => {
    const k = await key()
    await root().collection('platform').doc(`apiRate_${k.keyId}`).set({ bucket: Math.floor(Date.now() / 60_000), count: 60 })
    expect((await http(k.token)).status).toBe(429)
  })
  it('lista sin hashes ni cuerpos privados y restringe locales del gestor', async () => {
    await key(); await delivery()
    const list = await call('listarIntegraciones', { restaurantId: rid })
    expect(JSON.stringify(list)).not.toMatch(/tokenHash|ciphertext|bodyHash|"body"/)
    const restricted = await call('listarIntegraciones', { restaurantId: rid }, 'limited') as core.CallableOutput<'listarIntegraciones'>
    expect(restricted.keys).toHaveLength(0); expect(restricted.endpoints).toHaveLength(0); expect(restricted.deliveries).toHaveLength(0)
  })
  it('usa outbox, deduplica fanout, lease y evento y firma sin cambiar cuerpo', async () => {
    const d = await delivery(), ref = root().collection('webhookDeliveries').doc(d.deliveryId)
    expect((await root().collection('webhookDeliveries').get()).size).toBe(1)
    let received = 0
    const transport = async (_url: string, body: string, signature: string) => { received++; expect(core.verifyPlatformWebhook(d.secret!, signature, body, Date.now())).toBe(true); expect(JSON.parse(body).id).toBe(d.event.id); return 204 }
    const results = await Promise.all([deliverWebhook(rid, d.deliveryId, transport), deliverWebhook(rid, d.deliveryId, transport)])
    expect(results.filter(Boolean)).toHaveLength(1); expect(received).toBe(1); expect((await ref.get()).get('status')).toBe('delivered')
    expect(await deliverWebhook(rid, d.deliveryId, transport)).toBe(false)
  })
  it('rota el secreto y repite con motivo el mismo evento y cuerpo', async () => {
    const d = await delivery(), ref = root().collection('webhookDeliveries').doc(d.deliveryId), original = (await ref.get()).get('body')
    await deliverWebhook(rid, d.deliveryId, async () => 400)
    const rotated = await call('rotarSecretoWebhook', { ...mutation(), endpointId: d.endpointId }) as core.CallableOutput<'rotarSecretoWebhook'>
    await call('repetirEntregaWebhook', { ...mutation(), deliveryId: d.deliveryId, reason: 'Receptor corregido' })
    await deliverWebhook(rid, d.deliveryId, async (_url, body, signature) => { expect(body).toBe(original); expect(core.verifyPlatformWebhook(rotated.secret, signature, body, Date.now())).toBe(true); expect(core.verifyPlatformWebhook(d.secret!, signature, body, Date.now())).toBe(false); return 200 })
    expect((await ref.get()).get('eventId')).toBe(d.event.id)
  })
  it('reintenta 5xx y 429, suspende a los 12 intentos y 410 revoca', async () => {
    const d = await delivery(), ref = root().collection('webhookDeliveries').doc(d.deliveryId)
    await deliverWebhook(rid, d.deliveryId, async () => 503)
    expect((await ref.get()).get('status')).toBe('retry')
    expect(await deliverWebhook(rid, d.deliveryId, async () => 200)).toBe(false)
    await ref.update({ attempts: 11, nextAttemptAt: Timestamp.fromMillis(0) })
    await deliverWebhook(rid, d.deliveryId, async () => 429)
    expect((await ref.get()).get('status')).toBe('exhausted')
    expect((await root().collection('webhookEndpoints').doc(d.endpointId).get()).get('status')).toBe('suspended')
    const second = await delivery(); await deliverWebhook(rid, second.deliveryId, async () => 410)
    expect((await root().collection('webhookEndpoints').doc(second.endpointId).get()).get('status')).toBe('revoked')
  })
  it('cancela pendientes al revocar o estrechar locales y recupera lease vencido', async () => {
    const d = await delivery(), ref = root().collection('webhookDeliveries').doc(d.deliveryId)
    await ref.update({ status: 'leased', leaseUntil: Timestamp.fromMillis(0), leaseId: 'trabajador-perdido', attempts: 1 })
    await deliverWebhook(rid, d.deliveryId, async () => 200)
    expect((await ref.get()).get('status')).toBe('delivered')
    const e = await delivery()
    await call('guardarWebhook', { ...mutation(), endpointId: e.endpointId, url: 'https://127.0.0.1/eventos', events: ['order.placed'], locationIds: ['centro'], status: 'revoked' })
    const send = vi.fn(async () => 200); await deliverWebhook(rid, e.deliveryId, send); expect(send).not.toHaveBeenCalled()
    expect((await root().collection('webhookDeliveries').doc(e.deliveryId).get()).get('status')).toBe('cancelled')
  })
  it('mide uso con fecha y proyecta módulos sin exponer datos privados', async () => {
    await key(); const usage = await measureUsage(rid)
    expect(usage).toMatchObject({ apiKeys: 1, locations: 2, members: 3, activeModules: ['reservations', 'floor', 'kitchen'] })
    expect(JSON.stringify(usage)).not.toMatch(/@test|tokenHash|stripe/)
    const result = await call('listarRestaurantesLogiqd', {}, 'equipo', true) as core.CallableOutput<'listarRestaurantesLogiqd'>
    expect(result.restaurants.some(r => r.restaurantId === rid)).toBe(true)
  })
})
