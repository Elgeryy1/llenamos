import { onCall, HttpsError, type CallableRequest } from '../identity-call'
import { z } from 'zod'
import * as core from '@llenamos/core'
import { db, options, parse, safe, uidOf } from '../shared'
import { context, hash, names, type Name, type Input, fail } from './context'
import * as accounts from './accounts'
import * as cash from './cash'
import * as payments from './payments'
import * as fiscal from './fiscal'

const handlers = { ...accounts,...cash,...payments,...fiscal }
const actions: Record<Name,string> = {
  guardarConfiguracionCaja:'pos.settingsChanged',abrirCaja:'cash.opened',cerrarCaja:'cash.closed',registrarMovimientoCaja:'cash.movement',
  abrirCuenta:'bill.opened',verCuenta:'bill.refreshed',ajustarCuenta:'bill.adjusted',dividirCuenta:'bill.split',prepararCobro:'bill.locked',desbloquearCuenta:'bill.unlocked',
  registrarCobro:'payment.recorded',devolverCobro:'payment.refunded',emitirFactura:'invoice.issued',rectificarFactura:'invoice.rectified',sustituirSimplificada:'invoice.replaced',anularRegistroFiscal:'fiscal.cancelled',repartirPropinas:'tips.distributed',
}
export async function execute<N extends Name>(name: N, data: unknown, request: CallableRequest<unknown> | null): Promise<core.CallableOutput<N>> {
  const schema = core.CALLABLE_SCHEMAS_FASE3[name]
  const d = parse(schema.input as unknown as z.ZodType<Input<N>>,data)
  const scope = d as { restaurantId:string;locationId:string;requestId?:string;billId?:string;expectedRevision?:number;reason?:string }
  const uid = request ? uidOf(request) : null
  try {
    const result = await db.runTransaction(async tx => {
      const c = await context(tx,scope.restaurantId,scope.locationId,name,request)
      if (!request && name !== 'emitirFactura') throw new HttpsError('permission-denied','La operación necesita personal autenticado.')
      const key = scope.requestId ? hash([uid,name,scope.requestId]) : null
      const intent = key ? c.local.collection('posRequests').doc(key) : null
      const old = intent ? await tx.get(intent) : null
      const payloadHash = hash(d)
      if (old?.exists) {
        if (old.get('privacyRedacted') === true) throw new HttpsError('failed-precondition','Esta petición se suprimió por privacidad. No se volverá a ejecutar.')
        if (old.get('payloadHash') !== payloadHash) throw new HttpsError('already-exists','Esta petición ya se usó con otros datos.')
        return { value:schema.output.parse(old.get('result')) }
      }
      if (!request) {
        const invoice = d as core.CallableParsedInput<'emitirFactura'>
        const checkouts = await tx.get(c.local.collection('mobileCheckouts').where('partId','==',invoice.partId))
        const permitted = checkouts.docs.some(doc => doc.get('status') === 'paid' && doc.get('billId') === invoice.billId && doc.get('revision') === invoice.expectedRevision && JSON.stringify(doc.get('recipient') ?? null) === JSON.stringify(invoice.recipient) && ((invoice.recipient === null && invoice.type === 'F2') || (invoice.recipient !== null && invoice.type === 'F1' && !invoice.qualifiedSimplified)))
        if (!permitted) throw new HttpsError('permission-denied','La emisión automática exige un Checkout confirmado y su destinatario guardado.')
      }
      if (scope.billId && name !== 'verCuenta' && name !== 'abrirCuenta' && c.rows.bills.get(scope.billId)?.status === 'open') {
        if (accounts.refresh(c,scope.billId)) {
          c.flush('bill.refreshed','Consumo de la cuenta actualizado.',{ billId:scope.billId })
          return { stale:true }
        }
      }
      const handle = handlers[name] as unknown as (c: Parameters<typeof accounts.abrirCuenta>[0],d:Input<N>) => unknown
      const value = schema.output.parse(await handle(c,d))
      const businessWrites = c.writes.size
      const existingInvoice = name === 'emitirFactura' && !businessWrites
      if (intent) c.stage(intent.path,{ requestId:scope.requestId,actorUid:uid,route:name,payloadHash,result:value },true)
      if (name === 'registrarCobro' && c.rows.bills.get(scope.billId!)?.status === 'settled') c.audit('bill.settled','Cuenta saldada.',{ billId:scope.billId })
      let action: string | null = actions[name]
      if ((name === 'verCuenta' || name === 'abrirCuenta') && !businessWrites || existingInvoice) action = null
      const failedRefund = name === 'devolverCobro' && 'status' in value && value.status === 'not_configured'
      if (failedRefund) action = 'payment.refundNotConfigured'
      const summary = failedRefund ? 'Devolución bancaria no realizada. El proveedor no está configurado.' : ['emitirFactura','rectificarFactura','sustituirSimplificada','anularRegistroFiscal','guardarConfiguracionCaja'].includes(name) ? 'Fiscalidad de prueba: no válido para Hacienda.' : 'Operación de caja registrada.'
      c.flush(action,summary,{ requestId:scope.requestId ?? null,billId:scope.billId ?? null,reason:scope.reason ?? null,operation:name })
      return { value }
    },{ maxAttempts:10 })
    if ('stale' in result) fail('El consumo ha cambiado y se ha actualizado la cuenta. Recarga y vuelve a repartir antes de cobrar.')
    return result.value as core.CallableOutput<N>
  } catch (error) {
    if (error instanceof HttpsError) {
      if (error.message.includes('integridad de la cadena')) await fiscal.recordIntegrityIncident(scope.restaurantId,scope.locationId,error.message)
      throw error
    }
    if (error instanceof z.ZodError || (error instanceof Error && !('code' in error))) throw new HttpsError('failed-precondition',error instanceof z.ZodError ? error.issues.map(i => i.message).join(' ').slice(0,400) : error.message)
    throw error
  }
}
function callable(name: Name) { return onCall(options,request => safe(() => execute(name,request.data,request))) }
export const guardarConfiguracionCaja = callable('guardarConfiguracionCaja')
export const abrirCaja = callable('abrirCaja')
export const cerrarCaja = callable('cerrarCaja')
export const registrarMovimientoCaja = callable('registrarMovimientoCaja')
export const abrirCuenta = callable('abrirCuenta')
export const verCuenta = callable('verCuenta')
export const ajustarCuenta = callable('ajustarCuenta')
export const dividirCuenta = callable('dividirCuenta')
export const prepararCobro = callable('prepararCobro')
export const desbloquearCuenta = callable('desbloquearCuenta')
export const registrarCobro = callable('registrarCobro')
export const devolverCobro = callable('devolverCobro')
export const emitirFactura = callable('emitirFactura')
export const rectificarFactura = callable('rectificarFactura')
export const sustituirSimplificada = callable('sustituirSimplificada')
export const anularRegistroFiscal = callable('anularRegistroFiscal')
export const repartirPropinas = callable('repartirPropinas')
export { names }
