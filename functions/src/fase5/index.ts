/** Backend de fase 5. Exportar desde la entrada común es tarea del coordinador. */
import { onCall, HttpsError, type CallableRequest } from '../identity-call'
import { z } from 'zod'
import * as core from '@llenamos/core'
import { db, options, parse, safe } from '../shared'
import { context, type Name, type Input, hash, clean, names } from './context'
import * as fidelizacion from './fidelizacion'
import * as promociones from './promociones'
import * as repite from './repite/service'
import * as marketing from './marketing'
import * as analisis from './analisis'

const handlers = { ...fidelizacion,...promociones,...repite,...marketing,...analisis } as unknown as Record<Name,(c:Awaited<ReturnType<typeof context>>,d:never)=>Promise<unknown>>
export async function execute<N extends Name>(name:N,data:unknown,request:CallableRequest<unknown>|null,opts:{ now?:number } = {}):Promise<core.CallableOutput<N>> {
  const schema = core.CALLABLE_SCHEMAS_FASE5[name], d = parse(schema.input as unknown as z.ZodType<Input<N>>,data)
  if (name === 'darseDeBaja') {
    const v = d as Input<'darseDeBaja'>
    return await marketing.unsubscribe(v.slug,v.token,opts.now) as core.CallableOutput<N>
  }
  const scope = d as { restaurantId:string;locationId?:string;requestId?:string }
  try {
    return await db.runTransaction(async tx => {
      const c = await context(tx,scope.restaurantId,request,name,scope.locationId,opts.now)
      const intent = scope.requestId ? `fase5Requests/${hash([request?.auth?.uid,name,scope.requestId])}` : null
      const payloadHash = hash(d)
      if (intent) {
        const old = await tx.get(c.ref(intent))
        if (old.exists) {
          if (old.get('privacyRedacted')) throw new HttpsError('failed-precondition','Esta respuesta se ha suprimido por privacidad.')
          if (old.get('payloadHash') !== payloadHash) throw new HttpsError('already-exists','Esta petición ya se usó con otros datos.')
          return schema.output.parse(old.get('result')) as core.CallableOutput<N>
        }
      }
      const result = schema.output.parse(await handlers[name](c,d as never))
      if (intent) {
        c.stage(intent,{ requestId:scope.requestId,actor:c.uid,name,payloadHash,result:clean(result),...('customerId' in d ? { customerId:d.customerId } : {}),...('billId' in d ? { billId:d.billId } : {}) },'create')
        c.audit(`fase5.${name}`,'Operación de clientes, campañas o análisis registrada',{ requestId:scope.requestId })
      }
      c.flush(); return result as core.CallableOutput<N>
    },{ maxAttempts:10 })
  } catch (error) {
    if (error instanceof HttpsError) throw error
    if (error instanceof z.ZodError || (error instanceof Error && !('code' in error))) throw new HttpsError('failed-precondition',error instanceof z.ZodError ? error.issues.map(i => i.message).join(' ').slice(0,400) : error.message)
    throw error
  }
}
const callable = (name:Name) => onCall(options,request => safe(() => execute(name,request.data,request)))
export const guardarConfiguracionFidelizacion = callable('guardarConfiguracionFidelizacion')
export const guardarPremio = callable('guardarPremio')
export const altaFidelizacion = callable('altaFidelizacion')
export const verCuentaFidelizacion = callable('verCuentaFidelizacion')
export const canjearPuntos = callable('canjearPuntos')
export const anularCanje = callable('anularCanje')
export const ajustarPuntos = callable('ajustarPuntos')
export const guardarPromocion = callable('guardarPromocion')
export const cambiarEstadoPromocion = callable('cambiarEstadoPromocion')
export const promocionesAplicables = callable('promocionesAplicables')
export const aplicarPromocion = callable('aplicarPromocion')
export const quitarPromocion = callable('quitarPromocion')
export const vincularRepite = callable('vincularRepite')
export const guardarAjustesRepite = callable('guardarAjustesRepite')
export const crearTarjetaRepite = callable('crearTarjetaRepite')
export const verTarjetaRepite = callable('verTarjetaRepite')
export const darSelloRepite = callable('darSelloRepite')
export const avisarTeEchamosDeMenos = callable('avisarTeEchamosDeMenos')
export const informeRepite = callable('informeRepite')
export const guardarConfiguracionMarketing = callable('guardarConfiguracionMarketing')
export const guardarSegmento = callable('guardarSegmento')
export const borrarSegmento = callable('borrarSegmento')
export const previsualizarSegmento = callable('previsualizarSegmento')
export const guardarCampana = callable('guardarCampana')
export const simularCampana = callable('simularCampana')
export const lanzarCampana = callable('lanzarCampana')
export const cancelarCampana = callable('cancelarCampana')
export const informeCampana = callable('informeCampana')
export const darseDeBaja = callable('darseDeBaja')
export const informeOrigen = callable('informeOrigen')
export const panelAnalisis = callable('panelAnalisis')
export const exportarAnalisis = callable('exportarAnalisis')
export const guardarConfiguracionAnalisis = callable('guardarConfiguracionAnalisis')
export const previsionOcupacion = callable('previsionOcupacion')
export const verResumenDiario = callable('verResumenDiario')
export const guardarAutomatizacion = callable('guardarAutomatizacion')
export const borrarAutomatizacion = callable('borrarAutomatizacion')
export const simularAutomatizacion = callable('simularAutomatizacion')
export const resolverRecomendacion = callable('resolverRecomendacion')
export { names }
export { repiteLocal } from './repite/service'
export { acumularPuntos, revertirPuntosPorDevolucion, selloRepitePorReserva, selloRepitePorCobro, eventoAnalisisReserva, eventoAnalisisStock, evaluarAutomatizaciones, repiteOperacionCreada, cancelarMarketingSinPermiso, caducarPuntos, procesarRepite, procesarCampanas, agregarDiaAnalisis, enviarResumenDiario, caducarRecomendaciones } from './procesos'
