import { type CallableRequest } from 'firebase-functions/v2/https'
import { getAuth } from 'firebase-admin/auth'
import * as core from '@llenamos/core'
import { db } from '../shared'
import { execute } from './index'
import { fiscalClock } from './fiscal'
import { localOnly } from './context'

export function demoPosSettings(): core.PosSettings {
  const year = fiscalClock(Date.now(),'Europe/Madrid').year
  return { issuer:{ name:'Taberna Lumbre de prueba',nif:'89890001K',address:'Dirección inventada para pruebas locales' },
    system:{ producerName:'Desarrollo local de prueba',producerNif:'89890001K',name:'Llenamos local',id:'LL',version:'fase3-test',installation:'demo-lumbre-local',onlyVerifactu:true,multiTaxpayer:true,multipleTaxpayers:false },
    providerId:'local_test',environment:'test',fiscalRegime:'verifactu',ordinarySeriesId:`ordinary_${year}`,rectifyingSeriesId:`rectifying_${year}`,mobilePayments:false }
}
/** Idempotente: no reinicia contadores, documentos fiscales, pagos ni cajas existentes. */
export async function seedCaja() {
  localOnly()
  const rid = 'demo-lumbre', lid = 'centro', scope = { restaurantId:rid,locationId:lid }
  const owner = await getAuth().getUserByEmail('propietario@lumbre.test')
  const request = (data: unknown) => ({ data,auth:{ uid:owner.uid,token:{} } }) as unknown as CallableRequest<unknown>
  const root = db.doc(`restaurants/${rid}`), restaurant = (await root.get()).data()
  if (!restaurant) throw new Error('Ejecuta primero pnpm seed.')
  const modules = core.restaurantModules(restaurant)
  await root.update({ plan:'completo',activeModules:[...new Set([...modules,'pos'])] })
  await execute('guardarConfiguracionCaja',{ ...scope,requestId:`seed-caja-config-${demoPosSettings().ordinarySeriesId}`,settings:demoPosSettings() },request(null))
  const lock = await db.doc(`${root.path}/locations/${lid}/registerLocks/principal`).get()
  if (!lock.get('cashSessionId')) {
    const openings = await db.collection(`${root.path}/locations/${lid}/cashSessions`).get()
    await execute('abrirCaja',{ ...scope,requestId:`seed-caja-apertura-${openings.size}`,registerId:'principal',openingCents:10000 },request(null))
  }
  return { restaurantId:rid,locationId:lid,warning:core.FISCAL_TEST_WARNING,mobilePayments:'not_configured' }
}
