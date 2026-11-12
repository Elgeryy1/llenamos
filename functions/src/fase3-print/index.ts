import { onCall, HttpsError, type CallableRequest } from '../identity-call'
import { Timestamp } from 'firebase-admin/firestore'
import * as core from '@llenamos/core'
import { type z } from 'zod'
import { db, options, parse, safe } from '../shared'
import { activity, bridge, deny, equal, fail, hash, local, metadata, staff, token, type Scope } from './context'
import { prepareJob, project, writeJob } from './queue'

type Name = 'guardarImpresora' | 'vincularPuente' | 'solicitarImpresion' | 'reclamarImpresiones' | 'confirmarImpresion'
export async function execute<N extends Name>(name: N, raw: unknown, request: CallableRequest<unknown>): Promise<core.CallableOutput<N>> {
  const schema = core.CALLABLE_SCHEMAS_FASE3[name]
  const d = parse(schema.input as z.ZodType<core.CallableParsedInput<Name>>, raw)
  const result = name === 'reclamarImpresiones' ? await claim(d as core.CallableParsedInput<'reclamarImpresiones'>)
    : name === 'confirmarImpresion' ? await confirm(d as core.CallableParsedInput<'confirmarImpresion'>)
    : await mutate(name, d as core.CallableParsedInput<'guardarImpresora'> | core.CallableParsedInput<'vincularPuente'> | core.CallableParsedInput<'solicitarImpresion'>, request)
  return schema.output.parse(result) as core.CallableOutput<N>
}
async function mutate(name: Name, d: core.CallableParsedInput<'guardarImpresora'> | core.CallableParsedInput<'vincularPuente'> | core.CallableParsedInput<'solicitarImpresion'>, request: CallableRequest<unknown>) {
  return db.runTransaction(async tx => {
    const c = await staff(tx, d, request, name === 'solicitarImpresion' ? 'caja.cobrar' : 'impresion.gestionar')
    if ('kind' in d && d.kind === 'drawer' && !core.can(c.member.role, 'caja.gestionar')) deny()
    if ('kind' in d && d.kind === 'test' && !core.can(c.member.role, 'impresion.gestionar')) deny()
    const intentRef = c.ref.collection('printIntents').doc(hash(JSON.stringify([c.uid, name, d.requestId])))
    const previous = await tx.get(intentRef), fingerprint = hash(JSON.stringify(d))
    if (previous.exists) {
      if (previous.get('fingerprint') !== fingerprint) throw new HttpsError('already-exists', 'Esta operación ya se utilizó con otros datos.')
      if (name === 'vincularPuente') {
        const current = await tx.get(c.ref.collection('printBridges').doc((d as core.CallableParsedInput<'vincularPuente'>).bridgeId))
        if (previous.get('expiresAt').toMillis() < Date.now() || !equal(current.get('tokenHash'), hash(previous.get('result').token))) fail('La credencial recuperable ha caducado o se ha renovado. Crea otra vinculación.')
      }
      return previous.get('result')
    }
    let result: unknown, summary: string
    if ('printer' in d) {
      const p = d.printer
      if (p.columns !== (p.paperMm === 58 ? 32 : 48)) fail('El perfil debe ser de 32 columnas para 58 mm o de 48 para 80 mm.')
      if (p.stationIds.length > 30 || new Set(p.stationIds).size !== p.stationIds.length) fail('Las estaciones deben ser distintas y como máximo treinta.')
      const [stations, siblings, auth] = await Promise.all([
        Promise.all(p.stationIds.map(id => tx.get(c.ref.collection('stations').doc(id)))),
        tx.get(c.ref.collection('printers')), tx.get(c.ref.collection('printBridges').doc(p.bridgeId)),
      ])
      if (!auth.exists || auth.get('revoked')) fail('Vincula primero el puente de este local.')
      if (stations.some(s => !s.exists || !s.get('active'))) fail('Todas las estaciones deben estar activas en este local.')
      if (p.active && p.tickets && siblings.docs.some(s => s.id !== d.printerId && s.get('active') && s.get('tickets'))) fail('Ya hay una impresora activa asignada a la caja. Desactiva esa asignación antes de cambiarla.')
      const printerId = d.printerId ?? c.ref.collection('printers').doc().id
      const old = await tx.get(c.ref.collection('printers').doc(printerId))
      if (d.printerId && !old.exists) throw new HttpsError('not-found', 'La impresora ya no existe en este local.')
      if (old.exists && (old.get('bridgeId') !== p.bridgeId || old.get('paperMm') !== p.paperMm)) {
        const pending = await tx.get(c.ref.collection('printJobs').where('printerId', '==', printerId).where('status', 'in', ['queued', 'leased']).limit(1))
        if (!pending.empty) fail('Resuelve los trabajos pendientes antes de cambiar el puente o el papel.')
      }
      tx.set(old.ref, { ...p, ...metadata(c.uid, !old.exists) })
      result = { printerId }; summary = 'Impresora y destinos guardados.'
    } else if ('bridgeId' in d) {
      const fresh = token(), ref = c.ref.collection('printBridges').doc(d.bridgeId), old = await tx.get(ref)
      tx.set(ref, { tokenHash: hash(fresh), revoked: false, rotatedAt: Timestamp.now(), ...metadata(c.uid, !old.exists) })
      result = { token: fresh }; summary = 'Credencial del puente renovada. La anterior queda invalidada.'
    } else {
      const kind = d.kind === 'test' ? 'prebill' as const : d.kind, sourceId = d.kind === 'test' ? `test_${d.requestId}` : d.sourceId
      const counterRef = c.ref.collection('printCopies').doc(hash(JSON.stringify([kind, sourceId, d.printerId])))
      const counter = await tx.get(counterRef)
      if (d.kind === 'drawer' && d.copy) fail('Una copia nunca abre el cajón.')
      const copy = d.copy ? (counter.get('value') ?? 0) + 1 : 0
      const id = hash(JSON.stringify([kind, sourceId, d.printerId, copy]))
      const exists = await tx.get(c.ref.collection('printJobs').doc(id))
      const printRequest = { kind, sourceId, printerId: d.printerId, copy, status: 'queued' as const, requestedAt: Date.now(), requestedBy: c.uid, test: d.kind === 'test' }
      const job = await prepareJob(tx, d, id, printRequest)
      if (!exists.exists && job) writeJob(tx, d, id, job, printRequest)
      if (exists.exists && exists.get('status') === 'failed' && !d.copy) {
        const old = core.PrintJobSchema.parse(exists.data()), queued = { ...old, status: 'queued' as const, lastError: null }
        tx.update(exists.ref, { status: 'queued', lastError: null, ...metadata(c.uid) }); project(tx, c.ref, id, queued)
      }
      const r = c.ref.collection('printRequests').doc(id)
      tx.set(r, { ...core.printRequestForWrite({ ...printRequest, status: job ? 'processed' : 'not_configured' }, Timestamp.fromMillis), test: printRequest.test, ...metadata(c.uid, true) })
      if (!job) tx.set(c.ref.collection('printStatuses').doc(id), { printerId: d.printerId, sourceId, kind, status: 'not_configured', attempts: 0, lastError: 'Impresora o puente sin configurar.', ...metadata(c.uid, true) })
      if (d.copy) tx.set(counterRef, { value: copy, ...metadata(c.uid) })
      result = { printJobId: id, status: job ? 'queued' : 'not_configured' }; summary = kind === 'drawer' ? 'Apertura de cajón solicitada para un cobro en efectivo confirmado.' : 'Impresión solicitada. Pendiente de confirmación del puente.'
    }
    tx.create(intentRef, { fingerprint, result, expiresAt: Timestamp.fromMillis(Date.now() + (name === 'vincularPuente' ? 10 * 60_000 : 30 * 86400_000)), ...metadata(c.uid, true) })
    activity(tx, d, c.uid, c.member.displayName, `print.${name}`, summary)
    return result
  })
}
async function claim(d: core.CallableParsedInput<'reclamarImpresiones'>) {
  return db.runTransaction(async tx => {
    const c = await bridge(tx, d), now = Date.now()
    const [pending, expired] = await Promise.all([
      tx.get(c.ref.collection('printJobs').where('bridgeId', '==', d.bridgeId).where('status', '==', 'queued').limit(100)),
      tx.get(c.ref.collection('printJobs').where('bridgeId', '==', d.bridgeId).where('status', '==', 'leased').where('leaseUntil', '<=', Timestamp.fromMillis(now)).limit(100)),
    ])
    const candidates = await Promise.all(pending.docs.map(async snap => ({ snap, printer: await tx.get(c.ref.collection('printers').doc(snap.get('printerId'))) })))
    const jobs = []
    for (const snap of expired.docs) {
      const job = { ...core.PrintJobSchema.parse(snap.data()), status: 'uncertain' as const, lastError: 'El lease caducó sin confirmación. Revisa el papel antes de pedir una copia.' }
      tx.update(snap.ref, { status: job.status, lastError: job.lastError, ...metadata(null) }); project(tx, c.ref, snap.id, job)
    }
    for (const { snap, printer } of candidates) {
      const p = core.PrinterSchema.safeParse(printer.data())
      if (!p.success || !p.data.active || p.data.bridgeId !== d.bridgeId || jobs.length >= d.limit) continue
      const leaseToken = token(), leaseUntil = now + 60_000
      const job = { ...core.PrintJobSchema.parse(snap.data()), status: 'leased' as const, leaseUntil, leaseOwner: d.bridgeId, attempts: snap.get('attempts') + 1 }
      tx.update(snap.ref, { status: job.status, leaseUntil: Timestamp.fromMillis(leaseUntil), leaseOwner: d.bridgeId, attempts: job.attempts, ...metadata(null) })
      tx.set(c.ref.collection('printLeases').doc(snap.id), { leaseTokenHash: hash(leaseToken), owner: d.bridgeId, ...metadata(null) })
      project(tx, c.ref, snap.id, job)
      jobs.push({ id: snap.id, printerId: job.printerId, payloadHash: job.payloadHash, payloadBase64: job.payloadBase64, leaseToken, leaseUntil })
    }
    tx.update(c.bridge.ref, { lastSeenAt: Timestamp.now() })
    return { jobs }
  })
}
async function confirm(d: core.CallableParsedInput<'confirmarImpresion'>) {
  return db.runTransaction(async tx => {
    const c = await bridge(tx, d)
    const [snap, lease] = await Promise.all([tx.get(c.ref.collection('printJobs').doc(d.printJobId)), tx.get(c.ref.collection('printLeases').doc(d.printJobId))])
    if (!snap.exists || !lease.exists || lease.get('owner') !== d.bridgeId || !equal(lease.get('leaseTokenHash'), hash(d.leaseToken))) deny()
    const job = core.PrintJobSchema.parse(snap.data())
    if (['printed', 'failed', 'uncertain'].includes(job.status)) return { ok: true }
    if (job.status !== 'leased' || job.leaseOwner !== d.bridgeId) fail('El trabajo ya no tiene este lease activo.')
    const status = job.leaseUntil! <= Date.now() ? 'uncertain' : d.status
    const next = { ...job, status, lastError: status === 'uncertain' ? 'No se puede asegurar el resultado. Revisa el papel antes de solicitar copia.' : d.error }
    tx.update(snap.ref, { status, lastError: next.lastError, ...metadata(null) }); project(tx, c.ref, snap.id, next)
    return { ok: true }
  })
}
function callable(name: Name) { return onCall(options, r => safe(() => execute(name, r.data, r))) }
export const guardarImpresora = callable('guardarImpresora')
export const vincularPuente = callable('vincularPuente')
export const solicitarImpresion = callable('solicitarImpresion')
export const reclamarImpresiones = callable('reclamarImpresiones')
export const confirmarImpresion = callable('confirmarImpresion')
export { peticionImpresion, comandaMarchada, impresoraActualizada } from './triggers'
