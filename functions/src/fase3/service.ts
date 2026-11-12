import type { CallableRequest } from 'firebase-functions/v2/https'
import * as core from '@llenamos/core'
import { db, parse } from '../shared'
import { context } from './context'
import { externalCharge } from './payments'
import { execute } from './index'

/** Solo servidor: recibe hechos ya verificados por el webhook, nunca el retorno de una página. */
export async function confirmExternalPayment(input: core.ConfirmedExternalPayment): Promise<{ paymentId:string;dueCents:number }> {
  const d = parse(core.ConfirmedExternalPaymentSchema,input)
  return db.runTransaction(async tx => {
    const c = await context(tx,d.restaurantId,d.locationId,'registrarCobro',null)
    const result = await externalCharge(c,d)
    if (c.writes.size) c.flush('payment.recorded','Pago externo verificado y registrado.',{ paymentId:result.paymentId,billId:d.billId })
    return result
  },{ maxAttempts:10 })
}
export function issuePartInvoice(input: core.CallableParsedInput<'emitirFactura'>, actorUid: string | null): Promise<core.CallableOutput<'emitirFactura'>> {
  const request = actorUid ? { auth:{ uid:actorUid,token:{} } } as unknown as CallableRequest<unknown> : null
  return execute('emitirFactura',input,request)
}

/** Sin callable adicional: lo invoca una herramienta interna autenticada del encargado. */
export async function payTipDistribution(input: { restaurantId:string;locationId:string;requestId:string;distributionId:string;cashSessionId:string;reason:string }, actorUid: string) {
  const { z } = await import('zod')
  const { HttpsError } = await import('firebase-functions/v2/https')
  const { hash } = await import('./context')
  const { payTips } = await import('./cash')
  const d = parse(z.strictObject({ restaurantId:core.DocIdSchema,locationId:core.DocIdSchema,requestId:core.DocIdSchema,distributionId:core.DocIdSchema,cashSessionId:core.DocIdSchema,reason:core.PosReasonSchema }),input)
  return db.runTransaction(async tx => {
    const c = await context(tx,d.restaurantId,d.locationId,'registrarMovimientoCaja',{ auth:{ uid:actorUid,token:{} } } as unknown as CallableRequest<unknown>)
    const ref = c.local.collection('posRequests').doc(hash([actorUid,'pagarPropinas',d.requestId])), previous = await tx.get(ref)
    if (previous.exists) {
      if (previous.get('privacyRedacted') === true) throw new HttpsError('failed-precondition','Esta petición se suprimió por privacidad. No se volverá a ejecutar.')
      if (previous.get('payloadHash') !== hash(d)) throw new HttpsError('already-exists','Esta petición ya se usó con otros datos.')
      return z.object({ movementId:core.DocIdSchema }).parse(previous.get('result'))
    }
    const result = payTips(c,d)
    c.stage(ref.path,{ requestId:d.requestId,actorUid,route:'pagarPropinas',payloadHash:hash(d),result },true)
    c.flush('cash.movement','Reparto de propinas pagado desde una caja posterior.',{ distributionId:d.distributionId,movementId:result.movementId,reason:d.reason })
    return result
  },{ maxAttempts:10 })
}

/** Herramienta interna de encargado, sin endpoint público ni modificación de originales. */
export async function correctRejectedFiscalRecord(input: { restaurantId:string;locationId:string;requestId:string;recordId:string;reason:string }, actorUid: string) {
  const { z } = await import('zod')
  const { hash } = await import('./context')
  const { correctRejectedRecord } = await import('./fiscal')
  const d = parse(z.strictObject({ restaurantId:core.DocIdSchema,locationId:core.DocIdSchema,requestId:core.DocIdSchema,recordId:core.DocIdSchema,reason:core.PosReasonSchema }),input)
  return db.runTransaction(async tx => {
    const c = await context(tx,d.restaurantId,d.locationId,'anularRegistroFiscal',{ auth:{ uid:actorUid,token:{} } } as unknown as CallableRequest<unknown>)
    const ref = c.root.collection('fiscalRequestKeys').doc(hash([actorUid,'subsanar',d.requestId])), previous = await tx.get(ref)
    if (previous.exists) {
      if (previous.get('payloadHash') !== hash(d)) throw new Error('La petición de subsanación ya tiene otro contenido.')
      return core.EmitirFacturaOutputSchema.parse(previous.get('result'))
    }
    const result = await correctRejectedRecord(c,d.recordId,d.reason)
    c.stage(ref.path,{ payloadHash:hash(d),result,actorUid,requestId:d.requestId },true)
    c.flush('fiscal.corrected','Subsanación fiscal registrada sin cambiar el número de factura.',{ recordId:d.recordId,reason:d.reason })
    return result
  })
}
