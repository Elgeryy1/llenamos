import { Timestamp, type Transaction } from 'firebase-admin/firestore'
import * as core from '@llenamos/core'
import { db, stamp } from '../shared'
import { configuredAppOrigin } from '../public-app-url'

/** Se llama después de las lecturas, dentro de la transacción que crea la reserva. */
export function writeReservationMarketing(tx: Transaction, rid: string, lid: string, id: string, reservation: core.Reservation, date: string, now: number, input?: { attribution?: core.ReservationAttributionInput; marketingOptIn?: core.PublicMarketingOptIn }) {
  const root = db.doc(`restaurants/${rid}`)
  const ownHost = core.hostOf(configuredAppOrigin())
  const origin: core.ReservationOrigin = { ...core.classifyOrigin({ reservationSource: reservation.source, attribution: input?.attribution ?? null, ownHosts: ownHost ? [ownHost] : [] }), date, partySize: reservation.partySize, createdAt: now }
  tx.create(root.collection('locations').doc(lid).collection('reservationOrigins').doc(id), { ...core.reservationOriginForWrite(origin, Timestamp.fromMillis), updatedBy: reservation.createdBy })
  const opt = input?.marketingOptIn
  for (const channel of ['email', 'whatsapp'] as const) {
    if (!opt?.[channel]) continue
    const consent: core.Consent = { customerId: reservation.customerId, purpose: core.purposeForChannel(channel), status: 'granted', policyVersion: opt.policyVersion, at: now, source: 'public', evidenceId: id }
    tx.create(root.collection('consents').doc(`reservation.${id}.${channel}`), { ...core.consentForWrite(consent, Timestamp.fromMillis), ...stamp(), updatedBy: null })
  }
}
