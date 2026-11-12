import { HttpsError, onCall } from '../identity-call'
import { z } from 'zod'
import * as core from '@llenamos/core'
import { db, options, parse, safe } from '../shared'
import { entityVersion, syncContext, synchronize } from './service'

export const sincronizarComando = onCall(options, request => safe(async () => {
  const { command } = parse(core.SincronizarComandoInputSchema, request.data)
  return { receipt: await synchronize(command, request) }
}))
export const descartarComando = onCall(options, request => safe(async () => {
  const { command, requestId, reason } = parse(core.DescartarComandoInputSchema, request.data)
  return { receipt: await synchronize(command, request, { requestId, reason }) }
}))
export const recuperarComando = onCall(options, request => safe(async () => {
  const d = parse(core.RecuperarComandoInputSchema, request.data)
  return db.runTransaction(async tx => {
    const c = await syncContext(tx, d, request)
    const snap = await tx.get(c.local.collection('syncReceipts').doc(core.offlineCommandKey(d)))
    if (snap.get('privacyRedacted') === true) throw new HttpsError('failed-precondition', 'Este recibo se suprimió por privacidad. La operación no se volverá a ejecutar.')
    return { receipt: snap.exists ? core.CommandReceiptSchema.parse(snap.data()) : null }
  })
}))
/** Proyección autorizada de versiones. No entrega contactos, secretos ni otra estación. */
export const prepararSinConexion = onCall(options, request => safe(async () => {
  const d = parse(z.strictObject({ ...core.SyncScopeSchema.shape, entities: z.array(core.ServerEntityVersionSchema.omit({ version: true })).max(100) }), request.data)
  return db.runTransaction(async tx => {
    const c = await syncContext(tx, d, request)
    return { versions: d.entities.map(e => entityVersion(c, e)), contentHashes: d.entities.map(e => ({ ...e, hash: core.sha256Hex(core.canonicalJson(JSON.parse(JSON.stringify(c.rows[({ session: 'tableSessions', takeaway: 'takeaways', line: 'orderLines', task: 'floorTasks', item: 'menuItems' } as const)[e.kind]].get(e.id))))) })), synchronizedAt: Date.now() }
  })
}))
