import type { ModuleDefinition } from '../types.js'
import { connectClientesModules } from '../comun/conexion.js'
import { darseDeBaja } from './baja.js'
import { borrarSegmento, cancelarCampana, guardarCampana, guardarConfiguracionMarketing, guardarSegmento, informeCampana, informeOrigen, lanzarCampana, previsualizarSegmento, simularCampana } from './operaciones.js'
import { liveQueries } from './vivo.js'
import { campaignMessageHandler, marketingConsent, processCampaignHandler } from './envio.js'
import { CAMPAIGN_PERSONAL_DATA, campanasPrivacy } from './privacidad.js'
import { JOB_KIND_PROCESS, OUTBOX_KIND_MESSAGE } from './config.js'

export const campanasModule: ModuleDefinition = {
  name: 'campanas',
  operations: [guardarConfiguracionMarketing, guardarSegmento, borrarSegmento, previsualizarSegmento, guardarCampana, simularCampana, lanzarCampana, cancelarCampana, informeCampana, darseDeBaja, informeOrigen],
  liveQueries,
  workerHandlers: [[JOB_KIND_PROCESS, processCampaignHandler()], [OUTBOX_KIND_MESSAGE, campaignMessageHandler()]],
  marketingConsent,
  personalData: CAMPAIGN_PERSONAL_DATA,
  privacy: campanasPrivacy,
}

export { campaignMessageHandler, processCampaignHandler, marketingConsent } from './envio.js'
export { processCampaigns, issueUnsubscribeUrl, markCampaignMessageOutcome, resolveCampaignMessage, campaignOutboxId, type CampaignMessagePayload, type ProcessResult } from './proceso.js'
export { recordReservationOrigin, recordReservationConsents, updateOriginOutcome, originReportRows } from './origen.js'
export { setPublicAppOrigin, setLoyaltyPointsPort, setReservationsWithoutOriginPort, setUnsubscribeLimits, OUTBOX_KIND_MESSAGE, JOB_KIND_PROCESS, MAX_CAMPAIGN_AUDIENCE } from './config.js'

// Conecta los puertos entre fidelización, campañas, análisis, caja, reservas y sala en cuanto se carga cualquiera de los tres módulos.
connectClientesModules()
