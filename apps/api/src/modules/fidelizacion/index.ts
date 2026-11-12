import type { ModuleDefinition } from '../types.js'
import { connectClientesModules } from '../comun/conexion.js'
import { guardarConfiguracionFidelizacion, guardarPremio, altaFidelizacion, verCuentaFidelizacion, ajustarPuntos } from './programa.js'
import { canjearPuntos, anularCanje } from './canje.js'
import { guardarPromocion, cambiarEstadoPromocion, promocionesAplicables, aplicarPromocion, quitarPromocion } from './promociones.js'
import { vincularRepite, guardarAjustesRepite, crearTarjetaRepite, verTarjetaRepite, darSelloRepite, avisarTeEchamosDeMenos, informeRepite } from './repite.js'
import { liveQueries } from './live.js'
import { listarBajasRepitePendientes, resolverBajaRepite } from './bajas.js'
import { LOYALTY_PERSONAL_DATA, fidelizacionPrivacy } from './privacidad.js'
import { loyaltyWorkerHandlers } from './trabajos.js'

export const fidelizacion: ModuleDefinition = {
  name: 'fidelizacion',
  operations: [
    guardarConfiguracionFidelizacion, guardarPremio, altaFidelizacion, verCuentaFidelizacion, canjearPuntos, anularCanje, ajustarPuntos,
    guardarPromocion, cambiarEstadoPromocion, promocionesAplicables, aplicarPromocion, quitarPromocion,
    vincularRepite, guardarAjustesRepite, crearTarjetaRepite, verTarjetaRepite, darSelloRepite, avisarTeEchamosDeMenos, informeRepite,
    listarBajasRepitePendientes, resolverBajaRepite,
  ],
  liveQueries,
  workerHandlers: loyaltyWorkerHandlers,
  personalData: LOYALTY_PERSONAL_DATA,
  privacy: fidelizacionPrivacy,
}
export { setBillPort, setVisitPort, setRepiteAdapter, setClock, BILL_PORT_UNAVAILABLE, VISIT_PORT_UNAVAILABLE, type BillPort, type BillView, type VisitPort } from './ports.js'
export { accruePoints, reversePoints, expirePoints, enqueueExpirationJob, stampReservation, stampBill, EXPIRE_JOB_KIND, type SettledBillFacts, type RefundFacts } from './ganchos.js'
export { processRepite, enqueueRepite, queueStamp, REPITE_JOB_KIND, type TxRunner } from './repite.js'
export { registerLoyaltyHooks } from './trabajos.js'
export { cajaBillPort, salaVisitPort } from './cuentas.js'

// Conecta los puertos entre fidelización, campañas, análisis, caja, reservas y sala en cuanto se carga cualquiera de los tres módulos.
connectClientesModules()
