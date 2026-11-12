import type { ModuleDefinition } from '../types.js'
import { floorOperations } from './floor.js'
import { EXPIRE_OFFER_JOB,expireOfferHandler,reservationReplyHandler,stripeDepositHandler } from './worker.js'
import { reservasPrivacy } from './privacy.js'
import { publicOperations } from './public.js'
import { reservasLiveQueries } from './reads.js'
import { staffOperations } from './staff.js'

export { reservationHooks } from './staff.js'
export { applyDepositPayment } from './deposit.js'
export { expireWaitlistOffers } from './jobs.js'
export { reservasMaintenance } from './worker.js'

/** Reservas completas: disponibilidad, reservas públicas y del personal, espera, plano y clientes. */
export const reservasModule:ModuleDefinition={
  name:'reservas',
  operations:[...publicOperations,...staffOperations,...floorOperations],
  liveQueries:reservasLiveQueries,
  workerHandlers:[[EXPIRE_OFFER_JOB,expireOfferHandler],['webhook.stripe',stripeDepositHandler],['mensaje.respuesta',reservationReplyHandler]],
  privacy:reservasPrivacy,
  personalData:['customers','reservations','waitlist','consents','reservation_origins'],
}
