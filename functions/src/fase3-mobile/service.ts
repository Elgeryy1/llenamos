import { Timestamp, type DocumentReference, type Transaction } from 'firebase-admin/firestore'
import { HttpsError, type CallableRequest } from 'firebase-functions/v2/https'
import { z } from 'zod'
import * as core from '@llenamos/core'
import { db, parse } from '../shared'
import { appOrigin, routing, stripeClient, type Env } from './stripe'
import { tenantProviderEnv } from '../providers/tenant'
import { cajaConnected } from './backend'
import { activity, billPart, checkToken, fail, fresh, hash, meta, resolveSlug, scope, throttle, token } from './support'

export const StartInput = core.IniciarPagoCuentaInputSchema.extend({ language: core.LanguageSchema.default('es') })
export const TableInput = z.strictObject({ slug: core.SlugSchema, locationId: core.DocIdSchema, tableId: core.DocIdSchema, token: core.LinkTokenSchema })
export const ChooseInput = TableInput.extend({ partId: core.DocIdSchema, billId: core.DocIdSchema, expectedRevision: core.PosRevisionSchema, requestId: core.DocIdSchema })
export type CheckoutLink = core.CallableInput<'verCobroPublico'>
export const linkPath = (slug: string, lid: string, id: string, secret: string) => `/p/${slug}/${lid}/${id}?t=${secret}`
export function available(env: Env, injected = false) {
  return !!env.STRIPE_SECRET_KEY && !!env.STRIPE_MOBILE_WEBHOOK_SECRET && cajaConnected() &&
    (injected || (env.FUNCTIONS_EMULATOR !== 'true' && !env.GCLOUD_PROJECT?.startsWith('demo-')))
}
async function checkout(tx: Transaction, local: DocumentReference, id: string, secret: string) {
  const ref = local.collection('mobileCheckouts').doc(id), snap = await tx.get(ref)
  checkToken(snap.get('tokenHash'), secret)
  return { ref, raw: snap.data()!, value: core.MobileCheckoutSchema.parse(snap.data()) }
}
async function cash(tx: Transaction, local: DocumentReference) {
  const rows = await tx.get(local.collection('cashSessions').where('status', '==', 'open').limit(2))
  if (rows.size !== 1) fail('Para el pago móvil debe haber una sola caja abierta en este local.')
  return rows.docs[0]!.id
}
async function newLink(tx: Transaction, c: Awaited<ReturnType<typeof scope>>, d: { billId: string; partId: string; expectedRevision: number; requestId: string }, actor: string) {
  const requestRef = c.local.collection('mobileRequests').doc(hash(['link', actor, d.requestId]))
  const old = await tx.get(requestRef), fingerprint = hash(d)
  if (old.exists) {
    if (old.get('fingerprint') !== fingerprint) throw new HttpsError('already-exists', 'Esta solicitud ya tiene otro contenido.')
    if (old.get('expiresAt').toMillis() <= Date.now()) fail('Este enlace ha caducado. Solicita uno nuevo.')
    return core.CrearEnlaceCobroOutputSchema.parse(old.get('result'))
  }
  const { amount } = await billPart(tx, c.local, d.billId, d.partId, d.expectedRevision)
  const cashSessionId = await cash(tx, c.local)
  const secret = token(), id = c.local.collection('mobileCheckouts').doc().id, expiresAt = Date.now() + 15 * 60000
  const value = core.MobileCheckoutSchema.parse({ billId: d.billId, partId: d.partId, revision: d.expectedRevision,
    amountCents: amount, tipCents: 0, status: 'pending', stripeSessionId: null, tokenHash: core.sha256Hex(secret), expiresAt })
  const result = { checkoutId: id, token: secret, path: linkPath(c.restaurant.slug, c.lid, id, secret), expiresAt }
  tx.create(c.local.collection('mobileCheckouts').doc(id), { ...core.mobileCheckoutForWrite(value, Timestamp.fromMillis), cashSessionId, ...fresh(c.uid) })
  tx.create(requestRef, { fingerprint, result, expiresAt: Timestamp.fromMillis(expiresAt), ...fresh(c.uid) })
  activity(tx, c, hash(['mobile.link', id]), 'mobile.linkCreated', 'Enlace privado de cobro creado.')
  return result
}
export async function createLink(data: unknown, request: CallableRequest<unknown>) {
  const d = parse(core.CrearEnlaceCobroInputSchema, data)
  return db.runTransaction(async tx => {
    const c = await scope(tx, d.restaurantId, d.locationId, request)
    return newLink(tx, c, d, c.uid!)
  })
}
export async function viewCheckout(data: unknown, env: Env = process.env) {
  const d = parse(core.VerCobroPublicoInputSchema, data), rid = await resolveSlug(d.slug)
  if (env === process.env) env = await tenantProviderEnv(rid)
  return db.runTransaction(async tx => {
    const c = await scope(tx, rid, d.locationId)
    const { raw, value: v } = await checkout(tx, c.local, d.checkoutId, d.token)
    const [p, b] = await Promise.all([tx.get(c.local.collection('billParts').doc(v.partId)), tx.get(c.local.collection('bills').doc(v.billId))])
    const part = core.BillPartSchema.parse(p.data()), bill = core.BillSchema.parse(b.data())
    if (part.billId !== v.billId || bill.revision !== v.revision || part.revision !== v.revision) fail('La cuenta ha cambiado. Solicita un enlace actualizado.')
    const status = v.status === 'pending' && v.expiresAt <= Date.now() && !v.stripeSessionId && !raw.startRequest ? 'expired' : v.status
    const receipt = raw.receiptPath && v.status === 'paid' && v.expiresAt > Date.now() ? String(raw.receiptPath) : null
    const result = core.PublicBillSchema.parse({ restaurantName: c.restaurant.name, locationName: c.location.name, label: part.label,
      lines: part.allocations.map(a => ({ name: bill.lines.find(l => l.lineId === a.lineId)?.name ?? 'Consumo', amountCents: a.amountCents })),
      amountCents: Math.max(0, part.totalCents - part.paidCents), expiresAt: v.expiresAt, status })
    return { ...result, brandColor: c.restaurant.brandColor, paymentsEnabled: c.settings?.mobilePayments === true && available(env),
      tipCents: v.tipCents, paidCents: v.status === 'paid' ? v.amountCents : 0, receiptPath: receipt,
      invoicePending: raw.invoicePending === true, delivery: raw.delivery ?? 'none',
      paymentInProgress: v.status === 'pending' && !!raw.startRequest,
      checkoutUrl: v.status === 'pending' && v.expiresAt > Date.now() ? raw.stripeUrl ?? null : null }
  })
}
export async function startPayment(data: unknown, env: Env = process.env, transport?: typeof fetch) {
  const d = parse(StartInput, data), rid = await resolveSlug(d.slug)
  if (env === process.env) env = await tenantProviderEnv(rid)
  const provider = stripeClient(env, transport)
  const prepared = await db.runTransaction(async tx => {
    const c = await scope(tx, rid, d.locationId), row = await checkout(tx, c.local, d.checkoutId, d.token)
    if (!c.settings?.mobilePayments || !provider.configured || !available(env, !!transport))
      return { unavailable: true as const }
    if (row.value.status !== 'pending' || row.value.expiresAt <= Date.now()) fail('Este enlace no admite nuevos pagos.')
    if (d.email && !d.acceptDigitalReceipt) fail('Para enviar el recibo por correo hace falta tu consentimiento.')
    const fingerprint = hash(d), oldFingerprint = row.raw.startFingerprint
    if (oldFingerprint && oldFingerprint !== fingerprint) fail('Hay un intento de pago en curso. Recupera ese intento o pide al personal un enlace nuevo.')
    const { amount } = await billPart(tx, c.local, row.value.billId, row.value.partId, row.value.revision)
    if (!d.recipient && (await tx.get(c.local.collection('billParts').doc(row.value.partId))).get('totalCents') > 300000)
      fail('Esta parte requiere los datos del destinatario para una factura completa.')
    if (amount !== row.value.amountCents) fail('El saldo de la parte ha cambiado. Pide un enlace nuevo.')
    if (!Number.isSafeInteger(amount + d.tipCents) || amount + d.tipCents > 99999999) fail('El importe es demasiado alto para este medio de pago.')
    const reservationRef = c.local.collection('paymentReservations').doc(row.value.partId)
    const [reservation, register] = await Promise.all([tx.get(reservationRef), tx.get(c.local.collection('cashSessions').doc(row.raw.cashSessionId))])
    if (register.get('status') !== 'open') fail('La caja ya está cerrada.')
    if (reservation.exists && reservation.get('checkoutId') !== d.checkoutId) fail('Otra persona está pagando esta parte. Espera a que termine.')
    const route = row.raw.routing ?? routing(rid, env)
    const now = row.raw.startedAt?.toMillis() ?? Date.now()
    const name = row.raw.stripeName ?? `${c.restaurant.name} · ${c.location.name}`, origin = row.raw.stripeOrigin ?? appOrigin(env)
    if (row.raw.stripeUrl) return { url: String(row.raw.stripeUrl) }
    // La misma clave y los mismos parámetros sobreviven a un timeout de Stripe.
    tx.set(reservationRef, { billId: row.value.billId, partId: row.value.partId, revision: row.value.revision,
      amountCents: amount, checkoutId: d.checkoutId, expiresAt: Timestamp.fromMillis(now + 1800000), ...fresh() })
    tx.update(row.ref, { startRequest: d.requestId, startFingerprint: fingerprint, startedAt: Timestamp.fromMillis(now),
      recipient: d.recipient, email: d.email, acceptDigitalReceipt: d.acceptDigitalReceipt,
      consentAt: d.acceptDigitalReceipt ? Timestamp.fromMillis(now) : null, language: d.language, tipCents: d.tipCents,
      routing: route, stripeName: name, stripeOrigin: origin, livemode: env.STRIPE_SECRET_KEY?.startsWith('sk_live_') === true, invoicePending: false, needsReconciliation: true, ...meta() })
    return { row, route, now, name, origin }
  })
  if ('unavailable' in prepared) return { status: 'not_configured' as const, message: 'Los pagos móviles no están configurados. No se ha cobrado nada. Pide al personal que te cobre.' }
  if ('url' in prepared) return { status: 'ready' as const, url: prepared.url! }
  const s = await provider.create({ rid, lid: d.locationId, id: d.checkoutId, amount: prepared.row.value.amountCents, tip: d.tipCents,
    name: prepared.name, origin: prepared.origin, route: prepared.route, key: `mobile_${hash([rid, d.locationId, d.checkoutId, d.requestId])}`, now: prepared.now, lang: d.language })
  const { checkoutUrl } = await import('./stripe')
  if (s.metadata.checkoutId !== d.checkoutId || s.metadata.restaurantId !== rid || s.metadata.locationId !== d.locationId ||
    s.amount_total !== prepared.row.value.amountCents + d.tipCents || s.currency !== 'eur' || s.livemode !== (env.STRIPE_SECRET_KEY?.startsWith('sk_live_') === true))
    throw new HttpsError('unavailable', 'La respuesta de Stripe no coincide con este intento. El saldo sigue reservado para revisión.')
  const url = checkoutUrl(s.url ?? '')
  await db.runTransaction(async tx => {
    const current = await tx.get(prepared.row.ref)
    if (current.get('startFingerprint') !== hash(d)) fail('El intento de pago ha cambiado.')
    if (current.get('stripeSessionId') && current.get('stripeSessionId') !== s.id) fail('Stripe ha devuelto otra sesión de pago.')
    tx.update(prepared.row.ref, { stripeSessionId: s.id, stripeUrl: url, stripeExpiresAt: Timestamp.fromMillis(s.expires_at * 1000), ...meta() })
  })
  return { status: 'ready' as const, url }
}

async function tableBill(tx: Transaction, rid: string, d: z.output<typeof TableInput>) {
  const c = await scope(tx, rid, d.locationId)
  const [table, credential, sessions] = await Promise.all([tx.get(c.local.collection('tables').doc(d.tableId)), tx.get(c.local.collection('tableTokens').doc(d.tableId)),
    tx.get(c.local.collection('tableSessions').where('tableIds', 'array-contains', d.tableId))])
  checkToken(credential.get('tokenHash'), d.token)
  if (table.get('enabled') !== true) fail('Esta mesa no está disponible.')
  const current = sessions.docs.filter(s => core.sessionIsOpen(s.get('status')))
  if (current.length !== 1) fail('Pide al personal que prepare tu cuenta.')
  const index = await tx.get(c.local.collection('billTargets').doc(hash(['session', current[0]!.id])))
  if (!index.exists) fail('Pide al personal que prepare tu cuenta.')
  const billId = core.DocIdSchema.parse(index.get('billId')), b = await tx.get(c.local.collection('bills').doc(billId))
  const bill = core.BillSchema.parse(b.data())
  if (bill.status !== 'locked' || bill.target.kind !== 'session' || bill.target.id !== current[0]!.id) fail('Pide al personal que prepare tu cuenta.')
  return { c, bill, billId }
}
/** El QR solo descubre partes ya preparadas; nunca entrega recibos ni enlaces previos. */
export async function viewTableParts(data: unknown) {
  const d = parse(TableInput, data), rid = await resolveSlug(d.slug)
  return db.runTransaction(async tx => {
    const { c, bill, billId } = await tableBill(tx, rid, d)
    const parts = await tx.get(c.local.collection('billParts').where('billId', '==', billId))
    return { restaurantName: String(c.restaurant.name), locationName: String(c.location.name), brandColor: String(c.restaurant.brandColor),
      billId, revision: bill.revision, totalCents: bill.totalCents, parts: parts.docs.map(p => {
        const part = core.BillPartSchema.parse(p.data())
        return { id: p.id, label: part.label, amountCents: Math.max(0, part.totalCents - part.paidCents) }
      }) }
  })
}
export async function chooseTablePart(data: unknown) {
  const d = parse(ChooseInput, data), rid = await resolveSlug(d.slug)
  return db.runTransaction(async tx => {
    const { c, billId, bill } = await tableBill(tx, rid, d)
    if (billId !== d.billId || bill.revision !== d.expectedRevision) fail('La cuenta ha cambiado. Vuelve a consultar las partes.')
    return newLink(tx, c, { billId, partId: d.partId, expectedRevision: d.expectedRevision, requestId: d.requestId }, core.sha256Hex(d.token))
  })
}
export async function publicThrottle(data: unknown, request: CallableRequest<unknown>) {
  const d = parse(z.object({ slug: core.SlugSchema, token: core.LinkTokenSchema }), data)
  await throttle(await resolveSlug(d.slug), d.token, request.rawRequest?.ip ?? 'local')
}
