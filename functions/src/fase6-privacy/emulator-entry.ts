// Entrada de prueba local. El coordinador integra estos exports en el índice común.
export * from '../index'
export { registrarConsentimiento,solicitarPrivacidad,verificarSolicitudPrivacidad,descargarExportacionPrivacidad,listarSolicitudesPrivacidad,privacyDownload } from './index'
export { crearCopiaSeguridad,simularRestauracion,verContinuidad } from '../fase6-backup/index'
import { onDocumentWritten } from 'firebase-functions/v2/firestore'
import { reservationChanged as original } from '../reservationTriggers'
import { options } from '../shared'
import { isPrivacyRedacted } from './index'
// El disparador antiguo recrea la ficha al editar el histórico. Este guard debe integrarse también.
export const reservationChanged = onDocumentWritten({ ...options,document:'restaurants/{rid}/locations/{lid}/reservations/{id}' },async event => {
  if (isPrivacyRedacted(event.data?.after.data()) || isPrivacyRedacted(event.data?.before.data())) return
  return original.run(event)
})

export { privacidadProgramada } from './process'
export { copiasProgramadas } from '../fase6-backup/process'
