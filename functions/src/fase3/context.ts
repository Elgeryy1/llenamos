import { FieldValue, Timestamp, type DocumentData, type Transaction } from 'firebase-admin/firestore'
import { enqueuePlatformEvent, platformEventId } from '../fase6-api/events'
import { HttpsError, type CallableRequest } from 'firebase-functions/v2/https'
import { z } from 'zod'
import * as core from '@llenamos/core'
import { db, membership, uidOf } from '../shared'

export const names = ['guardarConfiguracionCaja','abrirCaja','cerrarCaja','registrarMovimientoCaja','abrirCuenta','verCuenta','ajustarCuenta','dividirCuenta','prepararCobro','desbloquearCuenta','registrarCobro','devolverCobro','emitirFactura','rectificarFactura','sustituirSimplificada','anularRegistroFiscal','repartirPropinas'] as const
export type Name = typeof names[number]
export type Input<N extends Name> = core.CallableParsedInput<N>
export function fail(message: string): never { throw new HttpsError('failed-precondition', message) }
export const hash = (v: unknown) => core.sha256Hex(JSON.stringify(v))
export function localOnly() {
  if (process.env.GCLOUD_PROJECT !== 'demo-llenamos' || !process.env.FIRESTORE_EMULATOR_HOST) fail('El proveedor de prueba solo funciona en los emuladores de demo. No es válido para Hacienda.')
}
const schemas = {
  bills: core.BillSchema, billParts: core.BillPartSchema, payments: core.PaymentSchema,
  cashSessions: core.CashSessionSchema, cashMovements: core.CashMovementSchema,
  invoices: core.InvoiceSchema, invoiceSeries: core.InvoiceSeriesSchema,
  tableSessions: core.TableSessionSchema, takeaways: core.TakeawaySchema,
  orderLines: core.OrderLineSchema, reservations: core.ReservationSchema,
  paymentReservations: core.PaymentReservationSchema, mobileCheckouts: core.MobileCheckoutSchema,
  tipDistributions: core.TipDistributionSchema,
} as const
type Rows = { [K in keyof typeof schemas]: Map<string, z.output<(typeof schemas)[K]>> }
const privateNames = ['billTargets','registerLocks','depositApplications','paymentEvents','invoiceEvents'] as const
export type Context = Awaited<ReturnType<typeof context>>
export async function context(tx: Transaction, rid: string, lid: string, name: Name, request: CallableRequest<unknown> | null) {
  const root = db.doc(`restaurants/${rid}`), local = root.collection('locations').doc(lid)
  const [r, l, lock, config] = await Promise.all([tx.get(root), tx.get(local), tx.get(local.collection('reservationLocks').doc('current')), tx.get(local.collection('settings').doc('pos'))])
  if (!r.exists || !l.exists) throw new HttpsError('not-found','No se encuentra el restaurante o el local.')
  const actor = request ? await membership(tx, rid, uidOf(request)) : null
  const access = core.FASE3_ACCESS[name]
  if (request && (!actor?.active || (actor.locationIds.length && !actor.locationIds.includes(lid)) || !core.can(actor.role, access.permission as core.Permission))) throw new HttpsError('permission-denied','No tienes permiso para esta operación en este local.')
  if (request && access.modules.some(m => !core.hasModule(r.data()!, m))) fail('El módulo necesario está desactivado.')
  const rows = {} as Rows
  const checkoutMetadata = new Map<string, DocumentData>()
  await Promise.all(Object.entries(schemas).map(async ([key, schema]) => {
    const snap = await tx.get(local.collection(key))
    if (key === 'mobileCheckouts') for (const doc of snap.docs) checkoutMetadata.set(doc.id,doc.data())
    Object.assign(rows, { [key]: new Map(snap.docs.map(doc => [doc.id, schema.parse(doc.data())])) })
  }))
  const secrets = {} as Record<typeof privateNames[number], Map<string, DocumentData>>
  await Promise.all(privateNames.map(async key => { secrets[key] = new Map((await tx.get(local.collection(key))).docs.map(d => [d.id,d.data()])) }))
  const members = new Map((await tx.get(root.collection('members'))).docs.map(d => [d.id,core.MemberSchema.parse(d.data())]))
  const writes = new Map<string, { data: DocumentData; create: boolean; remove?: boolean }>()
  const now = Date.now(), uid = actor?.uid ?? null
  const events: { action:string;summary:string;details:DocumentData }[] = []
  function audit(action: string, summary: string, details: DocumentData = {}) { events.push({ action,summary,details }) }
  function stage(path: string, data: DocumentData, create = false) {
    const previous = writes.get(path)
    writes.set(path, { data: { ...previous?.data, ...data }, create: previous?.create ?? create })
  }
  // Cobros confirmados para webhooks: se encolan en flush, en la misma transacción que el cobro.
  const succeeded = new Set<string>()
  function put<K extends keyof Rows>(key: K, id: string, data: z.output<(typeof schemas)[K]>) {
    const fresh = !rows[key].has(id)
    const parsed = schemas[key].parse(data)
    if (key === 'payments') {
      const payment = parsed as z.output<typeof schemas.payments>, before = rows.payments.get(id)
      if (payment.kind === 'charge' && payment.status === 'succeeded' && before?.status !== 'succeeded') succeeded.add(id)
    }
    ;(rows[key] as Map<string, unknown>).set(id,parsed)
    stage(`${local.path}/${key}/${id}`, parsed, fresh)
  }
  function secret(key: typeof privateNames[number], id: string, data: DocumentData) {
    stage(`${local.path}/${key}/${id}`,data,!secrets[key].has(id)); secrets[key].set(id,data)
  }
  function remove(key: 'billParts' | 'paymentReservations', id: string) {
    rows[key].delete(id); writes.set(`${local.path}/${key}/${id}`, { data: {}, create: false, remove: true })
  }
  function flush(action: string | null, summary: string, details: DocumentData = {}) {
    const conversions: Record<string, (v: never, convert: typeof Timestamp.fromMillis) => unknown> = {
      bills: core.billForWrite, payments: core.paymentForWrite, cashSessions: core.cashSessionForWrite,
      cashMovements: core.cashMovementForWrite, tipDistributions: core.tipDistributionForWrite,
      paymentReservations: core.paymentReservationForWrite, mobileCheckouts: core.mobileCheckoutForWrite,
      printRequests: core.printRequestForWrite, fiscalOutbox: core.fiscalOutboxForWrite,
    }
    for (const [path,w] of writes) {
      if (w.remove) { tx.delete(db.doc(path)); continue }
      const convert = conversions[path.split('/').at(-2)!]
      const data = convert ? convert(w.data as never,Timestamp.fromMillis) as DocumentData : w.data
      const value = { ...data, updatedBy: uid, updatedAt: FieldValue.serverTimestamp(), ...(w.create ? { createdAt: FieldValue.serverTimestamp() } : {}) }
      if (Buffer.byteLength(JSON.stringify(value)) > 900_000) fail('El documento supera el tamaño permitido. Divide la cuenta.')
      if (w.create) tx.create(db.doc(path),value); else tx.set(db.doc(path),value,{ merge: true })
    }
    if (writes.size) tx.set(lock.ref,{ revision: FieldValue.increment(1) },{ merge: true })
    for (const paymentId of succeeded) enqueuePlatformEvent(tx,{ id:platformEventId(rid,lid,'payment.succeeded',paymentId),type:'payment.succeeded',version:1,restaurantId:rid,locationId:lid,occurredAt:now,data:{ entityId:paymentId,status:'succeeded' } })
    succeeded.clear()
    if (action) audit(action,summary,details)
    for (const event of events) tx.create(root.collection('activity').doc(), { ...event,actorUid:uid,actorName:actor?.displayName ?? null,entity:{ type:'location',id:lid },createdAt:FieldValue.serverTimestamp(),updatedAt:FieldValue.serverTimestamp() })
  }
  return { tx, root, local, rid, lid, restaurant:r.data()!, location:l.data()!, actor, uid, now, rows, secrets, members, writes, stage, put, secret, remove, flush, audit,
    checkoutMetadata, settings: config.exists ? core.PosSettingsSchema.parse(config.data()) : null }
}
export function get<K extends keyof Rows>(c: Context, key: K, id: string): z.output<(typeof schemas)[K]> {
  const row = c.rows[key].get(id)
  if (!row) throw new HttpsError('not-found','No se encuentra el documento en este local.')
  return row as z.output<(typeof schemas)[K]>
}
export const newId = (c: Context, key: string) => c.local.collection(key).doc().id
export function account(c: Context, d: { billId: string; expectedRevision: number }) {
  const bill = get(c,'bills',d.billId)
  if (bill.revision !== d.expectedRevision) fail('La cuenta ha cambiado. Recarga antes de continuar.')
  return bill
}
export const parts = (c: Context, billId: string) => [...c.rows.billParts].filter(([,p]) => p.billId === billId).map(([id,p]) => ({ ...p,id }))
export function cashOpen(c: Context, id: string) {
  const cash = get(c,'cashSessions',id)
  if (cash.status !== 'open' || c.secrets.registerLocks.get(cash.registerId)?.cashSessionId !== id) fail('Abre una caja antes de registrar el movimiento.')
  return cash
}
