/** Datos explícitos de prueba para emuladores. Nunca son cobros ni facturas reales. */
import { Timestamp } from 'firebase-admin/firestore'
import * as core from '@llenamos/core'
import { db } from '../shared'
import { fresh, hash } from './support'
export const fixtureToken = 'm'.repeat(43)
export const fixtureTableToken = 't'.repeat(43)
export async function seedMobileFixture(rid: string, lid = 'centro', existingRestaurant = false) {
  if (process.env.GCLOUD_PROJECT !== 'demo-llenamos' || !/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? '')) throw new Error('Solo un emulador local de Firestore con el proyecto demo.')
  const root = db.doc(`restaurants/${rid}`), local = root.collection('locations').doc(lid)
  if (!existingRestaurant) await root.set({ name: 'Restaurante de prueba móvil', slug: rid, brandColor: '#d99b63', currency: 'EUR', timezone: 'Europe/Madrid', locale: 'es', isDemo: true, plan: 'completo', activeModules: ['pos', 'floor', 'reservations'], ...fresh() })
  await local.set({ name: 'Sala de prueba', slug: lid, address: '', city: '', phone: '', ...fresh() }, { merge: true })
  await root.collection('members').doc('owner-mobile').set({ uid: 'owner-mobile', displayName: 'Personal de prueba', email: 'owner@example.test', role: 'owner', locationIds: [], active: true })
  const lines: core.BillLine[] = [
    { lineId: 'l1', parentLineId: null, name: 'Arroz de temporada', quantity: 2, grossCents: 3600, taxRate: 10, guest: null },
    { lineId: 'l2', parentLineId: null, name: 'Croquetas de la casa', quantity: 1, grossCents: 1200, taxRate: 10, guest: null },
    { lineId: 'l3', parentLineId: null, name: 'Agua mineral', quantity: 1, grossCents: 400, taxRate: 10, guest: null },
  ]
  const bill: core.Bill = { target: { kind: 'session', id: 'session-mobile' }, customerId: null, status: 'locked', revision: 1,
    lines, adjustments: [], totalCents: 5200, paidCents: 0, refundedCents: 0, openedAt: Date.now(), lockedAt: Date.now(), settledAt: null }
  await local.collection('bills').doc('bill-mobile').set({ ...core.billForWrite(bill, Timestamp.fromMillis), ...fresh() })
  const plans = core.splitBill(lines, { kind: 'equal', parts: 2 })
  for (const [i, plan] of plans.entries()) await local.collection('billParts').doc(`part-${i + 1}`).set({ billId: 'bill-mobile',
    label: `Parte ${i + 1}`, revision: 1, allocations: plan.allocations, totalCents: plan.totalCents, paidCents: 0, invoiceId: null, ...fresh() })
  await local.collection('cashSessions').doc('cash-mobile').set({ registerId: 'demo-mobile', status: 'open', openingCents: 0, ...fresh() })
  await local.collection('settings').doc('pos').set({ mobilePayments: true, ...fresh() })
  await local.collection('tables').doc('table-mobile').set({ name: 'Mesa de prueba móvil', enabled: true,
    areaId: 'sala', seats: 4, shape: 'rect', x: 10, y: 10, w: 10, h: 10, joinableWith: [], ...fresh() })
  await local.collection('tableTokens').doc('table-mobile').set({ tokenHash: core.sha256Hex(fixtureTableToken), ...fresh() })
  const session = core.TableSessionSchema.parse({ tableIds: ['table-mobile'], status: 'bill_requested', label: 'Mesa de prueba móvil', guests: 2,
    reservationId: null, customerId: null, guestName: null, waiterUid: null, waiterName: null, notes: '', openedAt: Date.now(), openedBy: null,
    closedAt: null, closedBy: null, billRequestedAt: Date.now(), mergedInto: null, totalCents: 0, lineCount: 0, unservedCount: 0, history: [] })
  await local.collection('tableSessions').doc('session-mobile').set({ ...core.tableSessionForWrite(session, Timestamp.fromMillis), ...fresh() })
  await local.collection('billTargets').doc(hash(['session', 'session-mobile'])).set({ billId: 'bill-mobile', ...fresh() })
  await local.collection('mobileCheckouts').doc('checkout-mobile').set({ billId: 'bill-mobile', partId: 'part-1', revision: 1,
    amountCents: 2600, tipCents: 0, status: 'pending', stripeSessionId: null, expiresAt: Timestamp.fromMillis(Date.now() + 900000),
    tokenHash: core.sha256Hex(fixtureToken), cashSessionId: 'cash-mobile', ...fresh() })
  return { rid, lid, root, local, bill }
}
