import { Timestamp, type Transaction, type DocumentReference } from 'firebase-admin/firestore'
import * as core from '@llenamos/core'
import { db } from '../shared'
import { fail, hash, local, metadata, type Scope } from './context'
import { documentFor, encode, testDocument, type KitchenBatch } from './documents'

export type StoredRequest = core.PrintRequest & { kitchenBatch?: KitchenBatch; test?: boolean }
export function project(tx: Transaction, ref: DocumentReference, id: string, job: core.PrintJob) {
  const { printerId, sourceId, kind, status, attempts, lastError } = job
  tx.set(ref.collection('printStatuses').doc(id), { printerId, sourceId, kind, status, attempts, lastError, ...metadata(null) })
}
/** Solo genera bytes confiables. El cliente aporta una referencia semántica. */
export async function prepareJob(tx: Transaction, s: Scope, id: string, request: StoredRequest) {
  const ref = local(s)
  const [existing, printerSnap] = await Promise.all([tx.get(ref.collection('printJobs').doc(id)), tx.get(ref.collection('printers').doc(request.printerId!))])
  if (existing.exists) return core.PrintJobSchema.parse(existing.data())
  const printer = core.PrinterSchema.safeParse(printerSnap.data())
  if (!printer.success || !printer.data.active) return null
  const auth = await tx.get(ref.collection('printBridges').doc(printer.data.bridgeId))
  if (!auth.exists || auth.get('revoked')) return null
  if (request.kind === 'drawer' && request.copy) fail('Una copia nunca abre el cajón.')
  // Las copias toman el documento congelado del original cuando existe.
  const originalId = hash(JSON.stringify([request.kind, request.sourceId, request.printerId, 0]))
  const original = request.copy ? await tx.get(ref.collection('printJobs').doc(originalId)) : null
  let kitchenCopy: core.PrintDocument | null = null
  if (request.copy && request.kind === 'kitchen' && !original?.exists) {
    const originals = await tx.get(ref.collection('printJobs').where('printerId', '==', request.printerId).where('sourceId', '==', request.sourceId).where('kind', '==', 'kitchen').where('copy', '==', 0).limit(51))
    if (originals.empty || originals.size > 50) fail('No se puede recuperar una copia completa de esta comanda. Revisa sus trabajos originales.')
    const documents = originals.docs.sort((a,b) => a.get('createdAt').toMillis() - b.get('createdAt').toMillis()).map(d => core.PrintDocumentSchema.parse(d.get('document')))
    kitchenCopy = core.PrintDocumentSchema.parse({ kind: 'kitchen', fiscal: null, lines: documents.flatMap(d => d.lines) })
  }
  const document = original?.exists ? original.get('document') as core.PrintDocument | null : kitchenCopy ?? (request.test ? testDocument() : await documentFor(tx, s, request.kind, request.sourceId, printer.data, request.copy, request.kitchenBatch))
  const frozen = document ? core.PrintDocumentSchema.parse(document) : null
  if (request.copy && frozen && !frozen.lines.some(l => l.text === 'Copia')) frozen.lines.unshift({ text: 'Copia', bold: true, align: 'left' })
  const payload = encode(frozen, printer.data)
  if (payload.length > 350_000) fail('El documento supera el tamaño máximo de impresión.')
  return { printerId: request.printerId!, kind: request.kind, sourceId: request.sourceId, copy: request.copy, status: 'queued' as const,
    payloadHash: hash(payload), payloadBase64: Buffer.from(payload).toString('base64'), attempts: 0, leaseUntil: null, leaseOwner: null, lastError: null,
    bridgeId: printer.data.bridgeId, document: frozen }
}
export function writeJob(tx: Transaction, s: Scope, id: string, job: NonNullable<Awaited<ReturnType<typeof prepareJob>>>, request: StoredRequest) {
  const ref = local(s)
  tx.create(ref.collection('printJobs').doc(id), { ...core.printJobForWrite(job, Timestamp.fromMillis), bridgeId: 'bridgeId' in job ? job.bridgeId : null, document: 'document' in job ? job.document : null, ...metadata(request.requestedBy, true) })
  project(tx, ref, id, job)
}
/** Reconciliable sin depender de que llegue una sola vez el disparador. */
export async function processRequest(s: Scope, requestId: string) {
  return db.runTransaction(async tx => {
    const ref = local(s), snap = await tx.get(ref.collection('printRequests').doc(requestId))
    if (!snap.exists || !['queued', 'not_configured'].includes(snap.get('status'))) return
    const request: StoredRequest = { ...core.PrintRequestSchema.parse(snap.data()), kitchenBatch: snap.get('kitchenBatch'), test: snap.get('test') === true }
    const restaurant = await tx.get(ref.parent.parent!)
    if (!core.hasModule(restaurant.data() ?? {}, 'pos')) return
    const printers = request.printerId ? [(await tx.get(ref.collection('printers').doc(request.printerId)))] : (await tx.get(ref.collection('printers').where('active', '==', true))).docs
    const destinations = printers.filter(p => {
      const v = core.PrinterSchema.safeParse(p.data())
      return v.success && v.data.active && (request.kind === 'kitchen' ? v.data.stationIds.includes(request.kitchenBatch?.stationId ?? '') : request.kind === 'drawer' ? v.data.drawer : v.data.tickets)
    })
    const plans = await Promise.all(destinations.map(async p => {
      const r = { ...request, printerId: p.id }, id = hash(JSON.stringify([r.kind, r.sourceId, r.printerId, r.copy, ...(r.kitchenBatch ? [r.kitchenBatch] : [])]))
      const exists = await tx.get(ref.collection('printJobs').doc(id))
      if (exists.exists) return { id, exists: true, job: core.PrintJobSchema.parse(exists.data()), request: r }
      return { id, exists: false, job: await prepareJob(tx, s, id, r), request: r }
    }))
    for (const plan of plans) if (plan.job && !plan.exists) writeJob(tx, s, plan.id, plan.job, plan.request)
    tx.update(snap.ref, { status: plans.some(p => p.job) ? 'processed' : 'not_configured', ...metadata(null) })
  })
}

/** Reconciliación local aunque el ordenador del puente no vuelva a conectarse. */
export async function expireLeases(s: Scope) {
  return db.runTransaction(async tx => {
    const ref = local(s)
    const expired = await tx.get(ref.collection('printJobs').where('status', '==', 'leased').where('leaseUntil', '<=', Timestamp.now()).limit(100))
    for (const snap of expired.docs) {
      const job = { ...core.PrintJobSchema.parse(snap.data()), status: 'uncertain' as const, lastError: 'El lease caducó sin confirmación. Revisa el papel antes de pedir una copia.' }
      tx.update(snap.ref, { status: job.status, lastError: job.lastError, ...metadata(null) })
      project(tx, ref, snap.id, job)
    }
    return expired.size
  })
}
