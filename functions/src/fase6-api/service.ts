import { randomBytes } from 'node:crypto'
import { FieldPath, Timestamp, type DocumentReference, type Transaction } from 'firebase-admin/firestore'
import { HttpsError, type CallableRequest } from 'firebase-functions/v2/https'
import * as core from '@llenamos/core'
import { db, membership, parse, stamp, uidOf } from '../shared'
import { decodeCursor, encodeCursor, seal, unseal } from './security'
import { assertIntegrationDestination } from './destination'

export const names = ['listarRestaurantesLogiqd', 'verUsoPlataforma', 'abrirAccesoSoporte', 'listarIntegraciones', 'crearClaveApi', 'revocarClaveApi', 'guardarWebhook', 'rotarSecretoWebhook', 'repetirEntregaWebhook'] as const
export type Name = typeof names[number]
type Input<N extends Name> = import('zod').z.output<(typeof core.CALLABLE_SCHEMAS_FASE6)[N]['input']>
const denied = () => { throw new HttpsError('permission-denied', 'No tienes permiso para esta operación.') }
function team(request: CallableRequest<unknown>) { if (request.auth?.token.logiqd !== true) denied() }
function rowId(value: unknown): string { return core.DocIdSchema.parse(value) }

/** Medición real del servidor. La cola que solo existe en una tablet no es observable aquí. */
export async function measureUsage(rid: string, now = Date.now()): Promise<core.UsageSnapshot> {
  const root = db.doc(`restaurants/${rid}`), restaurant = await root.get()
  if (!restaurant.exists) throw new HttpsError('not-found', 'No se encuentra el restaurante.')
  const [subscription, locations, members, keys, endpoints, failures] = await Promise.all([
    root.collection('platform').doc('subscription').get(), root.collection('locations').get(), root.collection('members').where('active', '==', true).count().get(),
    root.collection('apiKeys').get(), root.collection('webhookEndpoints').get(), root.collection('webhookDeliveries').where('status', '==', 'exhausted').count().get(),
  ])
  let pendingCommands = 0
  for (const local of locations.docs) {
    const streams = await local.ref.collection('syncStreams').where('blockedCommandId', '!=', null).count().get()
    pendingCommands += streams.data().count
  }
  const entitlements = await root.collection('platform').doc('entitlements').get()
  const result = core.UsageSnapshotSchema.parse({ activeModules: core.restaurantModules(restaurant.data()!), moduleOverrides: restaurant.get('moduleOverrides') ?? {}, legacyPlan: restaurant.get('plan') ?? 'completo', platformRevision: restaurant.get('entitlementVersion') === undefined ? null : entitlements.get('version') ?? null, restaurantId: rid, name: restaurant.get('name'), planId: subscription.get('planId') ?? restaurant.get('plan') ?? 'completo',
    status: subscription.get('status') ?? 'not_configured', locations: locations.size, members: members.data().count,
    apiKeys: keys.docs.filter(d => { const k = core.ApiKeySchema.parse(d.data()); return k.revokedAt === null && k.expiresAt > now }).length,
    webhooks: endpoints.docs.filter(d => d.get('status') !== 'revoked').length, pendingCommands, failedDeliveries: failures.data().count, measuredAt: now,
  })
  await db.doc(`platformRestaurantUsage/${rid}`).set({ ...result, measuredAt: Timestamp.fromMillis(now), ...stamp() })
  return result
}

async function pagedIntegrations(tx: Transaction, rid: string, actor: string, d: Input<'listarIntegraciones'>, allowed: string[]) {
  const binding = { name: 'listarIntegraciones', rid, actor, limit: d.limit }
  const cursors = decodeCursor<Record<string, string | false>>(d.cursor, binding) ?? {}
  const collections = ['apiKeys', 'webhookEndpoints', 'webhookDeliveries'] as const
  const pages = await Promise.all(collections.map(async name => {
    if (cursors[name] === false) return []
    let query = db.collection(`restaurants/${rid}/${name}`).orderBy(FieldPath.documentId()).limit(d.limit + 1)
    if (cursors[name]) query = query.startAfter(cursors[name])
    const docs = await tx.get(query)
    const shown = docs.docs.slice(0, d.limit)
    cursors[name] = docs.size > d.limit ? shown.at(-1)!.id : false
    return shown.filter(doc => {
      if (!allowed.length) return true
      if (name !== 'webhookDeliveries') return (doc.get('locationIds') as string[]).every(id => allowed.includes(id))
      const event = core.PlatformEventSchema.parse(JSON.parse(doc.get('body')))
      return event.locationId !== null && allowed.includes(event.locationId)
    }).map(doc => ({ id: doc.id, ...doc.data(), ...(name === 'webhookDeliveries' ? { lastAttemptAt: doc.get('lastAttemptAt') ? core.timestampToMillis(doc.get('lastAttemptAt')) : null } : {}) }))
  }))
  const keys = pages[0]!.map(k => { const { tokenHash: _hash, createdBy: _author, ...safe } = core.ApiKeySchema.extend({ id: core.DocIdSchema }).parse(k); return safe })
  const endpoints = pages[1]!.map(e => core.WebhookEndpointSchema.extend({ id: core.DocIdSchema }).parse(e))
  const deliveries = pages[2]!.map(e => { const { body: _body, bodyHash: _hash, leaseUntil: _lease, ...safe } = core.WebhookDeliverySchema.extend({ id: core.DocIdSchema, lastAttemptAt: core.MillisSchema.nullable().optional() }).parse(e); return safe })
  const health = await tx.get(db.doc(`restaurants/${rid}/platform/apiHealth`))
  return { keys, endpoints, deliveries, workerLastRunAt: health.get('workerLastRunAt') ? core.timestampToMillis(health.get('workerLastRunAt')) : null, nextCursor: collections.some(n => cursors[n] !== false) ? encodeCursor(binding, cursors) : null }
}

export async function execute<N extends Name>(name: N, raw: unknown, request: CallableRequest<unknown>): Promise<core.CallableOutput<N>> {
  const uid = uidOf(request), now = Date.now()
  const schema = core.CALLABLE_SCHEMAS_FASE6[name]
  const d = parse(schema.input as unknown as import('zod').z.ZodType<Input<N>>, raw)
  const input = d as Input<'crearClaveApi'> & Input<'guardarWebhook'> & Input<'repetirEntregaWebhook'> & Input<'abrirAccesoSoporte'>
  if (name === 'listarRestaurantesLogiqd') {
    team(request)
    const data = d as Input<'listarRestaurantesLogiqd'>, binding = { name, uid, status: data.status, limit: data.limit }
    const after = decodeCursor<string>(data.cursor, binding) ?? ''
    let query = db.collection('platformRestaurantUsage').orderBy(FieldPath.documentId()).limit(data.limit + 1)
    if (after) query = query.startAfter(after)
    if (data.status !== 'all') query = query.where('status', '==', data.status)
    const docs = await query.get(), rows = docs.docs.slice(0, data.limit)
    return schema.output.parse({ restaurants: rows.map(r => core.UsageSnapshotSchema.parse({ ...r.data(), measuredAt: core.timestampToMillis(r.get('measuredAt')) })), nextCursor: docs.size > data.limit ? encodeCursor(binding, rows.at(-1)!.id) : null }) as core.CallableOutput<N>
  }
  if (name === 'guardarWebhook' && input.status !== 'revoked') await assertIntegrationDestination(input.url)
  const rid = rowId(input.restaurantId), root = db.doc(`restaurants/${rid}`)
  if (name === 'verUsoPlataforma') {
    await db.runTransaction(async tx => { const member = await membership(tx, rid, uid); if (!member.active || !core.can(member.role, 'planes.ver')) denied() })
    return schema.output.parse(await measureUsage(rid, now)) as core.CallableOutput<N>
  }
  return db.runTransaction(async tx => {
    const restaurant = await tx.get(root)
    if (!restaurant.exists) throw new HttpsError('not-found', 'No se encuentra el restaurante.')
    const permission = core.FASE6_ACCESS[name].permission
    const member = permission === 'logiqd' ? (team(request), null) : await membership(tx, rid, uid)
    if (member && (!member.active || !core.can(member.role, 'integraciones.gestionar'))) denied()
    if (name === 'listarIntegraciones') return schema.output.parse(await pagedIntegrations(tx, rid, uid, d as Input<'listarIntegraciones'>, member?.locationIds ?? [])) as core.CallableOutput<N>
    const requestKey = core.sha256Hex(core.canonicalJson([uid, rid, name, input.requestId]))
    const receiptRef = db.doc(`platformRequests/${requestKey}`), receipt = await tx.get(receiptRef)
    const fingerprint = core.sha256Hex(core.canonicalJson(d))
    if (receipt.exists) {
      if (receipt.get('fingerprint') !== fingerprint) throw new HttpsError('already-exists', 'Esta petición ya se usó con otros datos.')
      if (receipt.get('expiresAt').toMillis() <= now) throw new HttpsError('failed-precondition', 'La respuesta ha caducado. Revisa el estado y revoca o rota el secreto perdido.')
      return schema.output.parse(unseal(receipt.get('ciphertext'), receiptRef.path)) as core.CallableOutput<N>
    }
    const staged: [DocumentReference, Record<string, unknown>][] = []
    const put = (ref: DocumentReference, value: Record<string, unknown>) => staged.push([ref, { ...value, updatedAt: Timestamp.fromMillis(now), updatedBy: uid }])
    const newSecret = () => core.linkToken(randomBytes(32))
    const validateLocations = async (ids: string[]) => {
      for (const lid of new Set(ids)) {
        if (member && member.locationIds.length && !member.locationIds.includes(lid)) denied()
        if (!(await tx.get(root.collection('locations').doc(lid))).exists) throw new HttpsError('not-found', 'No se encuentra uno de los locales.')
      }
    }
    const capacity = async (resource: 'apiKeys' | 'webhooks') => {
      const [ent, docs, usage] = await Promise.all([tx.get(root.collection('platform').doc('entitlements')), tx.get(root.collection(resource === 'apiKeys' ? 'apiKeys' : 'webhookEndpoints')), tx.get(root.collection('platform').doc('usage'))])
      if (!ent.exists) throw new HttpsError('failed-precondition', 'Configura los límites del plan de plataforma antes de crear integraciones.')
      const limits = core.EntitlementsSchema.parse(ent.data()).limits
      const used = docs.docs.filter(doc => resource === 'webhooks' ? doc.get('status') !== 'revoked' : doc.get('revokedAt') === null && core.ApiKeySchema.parse(doc.data()).expiresAt > now).length
      const result = core.checkPlanLimit(limits, resource, used)
      if (!result.ok) throw new HttpsError('resource-exhausted', result.reason!)
      put(usage.ref, { [resource]: used + 1, revision: Number(usage.get('revision') ?? 0) + 1 })
    }
    let result: unknown
    if (name === 'abrirAccesoSoporte') {
      const ref = db.collection('platformSupport').doc(), expiresAt = now + input.durationMinutes * 60_000
      put(ref, { actorUid: uid, restaurantId: rid, reason: input.reason, openedAt: Timestamp.fromMillis(now), expiresAt: Timestamp.fromMillis(expiresAt) })
      result = { supportAccessId: ref.id, expiresAt }
    } else if (name === 'crearClaveApi') {
      await validateLocations(input.locationIds)
      if (input.expiresAt <= now) throw new HttpsError('invalid-argument', 'La caducidad debe ser futura.')
      await capacity('apiKeys')
      const token = newSecret(), keyId = root.collection('apiKeys').doc().id, prefix = token.slice(0, 8)
      put(root.collection('apiKeys').doc(keyId), { ...core.apiKeyForWrite(core.ApiKeySchema.parse({ ...input, prefix, tokenHash: core.sha256Hex(token), createdBy: uid, revokedAt: null, lastUsedAt: null }), Timestamp.fromMillis), createdAt: Timestamp.fromMillis(now) })
      result = { keyId, token, prefix }
    } else if (name === 'revocarClaveApi') {
      const ref = root.collection('apiKeys').doc((d as Input<'revocarClaveApi'>).keyId), key = await tx.get(ref)
      if (!key.exists) throw new HttpsError('not-found', 'No se encuentra la clave.')
      await validateLocations(core.ApiKeySchema.parse(key.data()).locationIds)
      put(ref, { revokedAt: Timestamp.fromMillis(now) }); result = { ok: true }
    } else if (name === 'guardarWebhook' || name === 'rotarSecretoWebhook') {
      const endpointId = input.endpointId ?? root.collection('webhookEndpoints').doc().id
      const ref = root.collection('webhookEndpoints').doc(endpointId), previous = await tx.get(ref)
      if (input.endpointId && !previous.exists) throw new HttpsError('not-found', 'No se encuentra el webhook.')
      const old = previous.exists ? core.WebhookEndpointSchema.parse(previous.data()) : null
      if (!old && name === 'guardarWebhook' && input.status === 'revoked') throw new HttpsError('not-found', 'No se encuentra el webhook que quieres revocar.')
      if (old) await validateLocations(old.locationIds)
      if (old?.status === 'revoked' && (name === 'rotarSecretoWebhook' || input.status !== 'revoked')) throw new HttpsError('failed-precondition', 'Crea otro webhook para sustituir al revocado.')
      if (name === 'guardarWebhook') await validateLocations(input.locationIds)
      if (!previous.exists && input.status !== 'revoked') await capacity('webhooks')
      const rotates = name === 'rotarSecretoWebhook' || !old
      const secret = rotates ? newSecret() : null, version = (old?.secretVersion ?? 0) + (rotates ? 1 : 0)
      if (secret) { const secretRef = root.collection('webhookSecrets').doc(`${endpointId}_${version}`); put(secretRef, { ciphertext: seal(secret, secretRef.path), keyVersion: 1, createdAt: Timestamp.fromMillis(now) }) }
      const endpoint = name === 'rotarSecretoWebhook' ? { ...old!, secretVersion: version } : input.status === 'revoked' ? { ...old!, status: 'revoked', secretVersion: version } : core.WebhookEndpointSchema.parse({ ...input, secretVersion: version, consecutiveFailures: old?.consecutiveFailures ?? 0 })
      put(ref, { ...endpoint, ...(!old ? { createdAt: Timestamp.fromMillis(now) } : {}) })
      result = name === 'rotarSecretoWebhook' ? { secret, secretVersion: version } : { endpointId, secret, secretVersion: version }
    } else if (name === 'repetirEntregaWebhook') {
      const ref = root.collection('webhookDeliveries').doc(input.deliveryId), previous = await tx.get(ref)
      if (!previous.exists) throw new HttpsError('not-found', 'No se encuentra la entrega.')
      const delivery = core.WebhookDeliverySchema.parse(previous.data()), endpointRef = root.collection('webhookEndpoints').doc(delivery.endpointId)
      const endpoint = await tx.get(endpointRef)
      if (!endpoint.exists || endpoint.get('status') === 'revoked') throw new HttpsError('failed-precondition', 'El webhook está revocado.')
      await validateLocations(core.WebhookEndpointSchema.parse(endpoint.data()).locationIds)
      if (!['exhausted', 'delivered'].includes(delivery.status)) throw new HttpsError('failed-precondition', 'Espera a que termine la entrega antes de repetirla.')
      put(ref, { status: 'queued', attempts: 0, nextAttemptAt: Timestamp.fromMillis(now), leaseUntil: null, round: Number(previous.get('round') ?? 0) + 1 })
      put(endpointRef, { status: 'active', consecutiveFailures: 0 }); result = { deliveryId: ref.id, status: 'queued' }
    }
    const output = schema.output.parse(result)
    for (const [ref, value] of staged) tx.set(ref, value, { merge: true })
    tx.create(receiptRef, { actorUid: uid, restaurantId: rid, name, fingerprint, ciphertext: seal(output, receiptRef.path), keyVersion: 1, expiresAt: Timestamp.fromMillis(now + 86_400_000), ...stamp() })
    tx.create(root.collection('activity').doc(requestKey), { action: `platform.${name}`, summary: name === 'abrirAccesoSoporte' ? `Acceso de soporte temporal: ${input.reason}` : name === 'repetirEntregaWebhook' ? `Repetición de entrega: ${input.reason}` : 'Integración actualizada.', actorUid: uid, actorName: null, entity: null, ...stamp() })
    return output as core.CallableOutput<N>
  })
}
