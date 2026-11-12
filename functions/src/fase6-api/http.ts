import { FieldPath, Timestamp } from 'firebase-admin/firestore'
import { HttpsError, type Request } from 'firebase-functions/v2/https'
import type { onRequest } from 'firebase-functions/v2/https'
type Response = Parameters<Parameters<typeof onRequest>[0]>[1]
import * as core from '@llenamos/core'
import { db } from '../shared'
import { decodeCursor, encodeCursor } from './security'

/** Dos lecturas reales. No hay rutas de escritura ni acceso a contactos o notas. */
export async function apiHandler(req: Request, res: Response) {
  res.set('Cache-Control', 'no-store').set('X-Content-Type-Options', 'nosniff')
  try {
    if (req.method !== 'GET') { res.set('Allow', 'GET').status(405).json({ error: 'Método no permitido.' }); return }
    const match = /^\/v1\/restaurants\/([^/]+)\/locations\/([^/]+)\/(menu|orders)$/.exec(req.path)
    if (!match) { res.status(404).json({ error: 'Ruta no encontrada.' }); return }
    const [, ridRaw, lidRaw, resource] = match
    const rid = core.DocIdSchema.parse(decodeURIComponent(ridRaw!)), lid = core.DocIdSchema.parse(decodeURIComponent(lidRaw!))
    const data = core.ApiReadInputSchema.parse({ restaurantId: rid, locationId: lid, cursor: req.query.cursor ?? null, limit: req.query.limit === undefined ? 50 : Number(req.query.limit) })
    if (Object.keys(req.query).some(k => !['cursor', 'limit'].includes(k))) throw new HttpsError('invalid-argument', 'Filtro no admitido.')
    const bearer = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.get('Authorization') ?? '')
    if (!bearer) throw new HttpsError('unauthenticated', 'La clave de API no es válida.')
    const token = bearer[1]!, tokenHash = core.sha256Hex(token), now = Date.now(), root = db.doc(`restaurants/${rid}`)
    let keyId = ''
    const scope = resource === 'menu' ? 'menu.read' : 'orders.read'
    await db.runTransaction(async tx => {
      const keyDocs = await tx.get(root.collection('apiKeys').where('tokenHash', '==', tokenHash).limit(1))
      const stored = keyDocs.docs[0]
      if (!stored) throw new HttpsError('unauthenticated', 'La clave de API no es válida.')
      keyId = stored.id
      const ref = stored.ref
      const [restaurant, local, subscription, entitlements] = await Promise.all([tx.get(root), tx.get(root.collection('locations').doc(lid)), tx.get(root.collection('platform').doc('subscription')), tx.get(root.collection('platform').doc('entitlements'))])
      if (!stored.exists) throw new HttpsError('unauthenticated', 'La clave de API no es válida.')
      const key = core.ApiKeySchema.parse(stored.data())
      if (key.revokedAt !== null || key.expiresAt <= now) throw new HttpsError('unauthenticated', 'La clave ha caducado o está revocada.')
      if (!core.apiKeyAllows(key, token, scope, lid, now) || !restaurant.exists || !local.exists) throw new HttpsError('permission-denied', 'La clave no permite consultar este recurso.')
      if (!core.hasModule(restaurant.data()!, 'floor')) throw new HttpsError('permission-denied', 'El módulo de sala no está activo.')
      if (restaurant.get('entitlementVersion') !== undefined) {
        if (!subscription.exists || !entitlements.exists || !core.subscriptionAllowsService(core.SubscriptionSchema.parse(subscription.data()), now) || (!core.EntitlementsSchema.parse(entitlements.data()).serviceEnabled || !core.EntitlementsSchema.parse(entitlements.data()).activeModules.includes('floor')))
          throw new HttpsError('permission-denied', 'El servicio de este restaurante no está activo.')
      }
      const bucket = Math.floor(now / 60_000)
      const counters = [root.collection('platform').doc(`apiRate_${keyId}`), root.collection('platform').doc('apiRate_restaurant')]
      const previous = await Promise.all(counters.map(ref => tx.get(ref)))
      const values = previous.map(doc => doc.get('bucket') === bucket ? Number(doc.get('count')) : 0)
      if (values[0]! >= 60 || values[1]! >= 300) throw new HttpsError('resource-exhausted', 'Se ha alcanzado el límite de peticiones. Espera un minuto.')
      counters.forEach((ref, i) => tx.set(ref, { bucket, count: values[i]! + 1, updatedAt: Timestamp.fromMillis(now) }))
      tx.update(ref, { lastUsedAt: Timestamp.fromMillis(now) })
    })
    const binding = { rid, lid, resource, keyId, limit: data.limit }
    const cursor = decodeCursor<{ placedAt: number; id: string }>(data.cursor, binding, now)
    if (resource === 'menu') {
      if (cursor) throw new HttpsError('invalid-argument', 'La carta no admite paginación.')
      const projection = await db.doc(`publicMenus/${core.publicMenuId(rid, lid)}`).get()
      if (!projection.exists) throw new HttpsError('failed-precondition', 'La carta aún no está publicada.')
      res.json(core.ApiMenuOutputSchema.parse({ menu: projection.data() })); return
    }
    let query = root.collection('locations').doc(lid).collection('orders').orderBy('placedAt').orderBy(FieldPath.documentId()).limit(data.limit + 1)
    if (cursor) {
      if (!Number.isSafeInteger(cursor.placedAt)) throw new HttpsError('invalid-argument', 'Cursor no válido.')
      query = query.startAfter(Timestamp.fromMillis(cursor.placedAt), core.DocIdSchema.parse(cursor.id))
    }
    const result = await query.get(), docs = result.docs.slice(0, data.limit)
    const orders = docs.map(doc => { const o = core.OrderSchema.parse(doc.data()); return { id: doc.id, placedAt: o.placedAt, status: o.status, totalCents: o.totalCents, lineIds: o.lineIds } })
    const last = orders.at(-1)
    res.json(core.ApiOrdersOutputSchema.parse({ orders, nextCursor: result.size > data.limit && last ? encodeCursor(binding, { placedAt: last.placedAt, id: last.id }, now) : null }))
  } catch (error) {
    const code = error instanceof HttpsError ? error.code : 'invalid-argument'
    const status = ({ unauthenticated: 401, 'permission-denied': 403, 'resource-exhausted': 429, 'failed-precondition': 409, 'not-found': 404 } as Record<string, number>)[code] ?? 400
    if (status === 401) res.set('WWW-Authenticate', 'Bearer')
    if (status === 429) res.set('Retry-After', '60')
    res.status(status).json({ error: error instanceof HttpsError ? error.message : 'No se ha podido consultar el recurso.' })
  }
}
