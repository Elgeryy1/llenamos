import * as core from '@llenamos/core'
import { type Pos, fail, notFound, newId, sha, account, cashOpen, getBill, putBill, getPart, putPart, getCash, getPayment, paymentsOf, putPayment, event, reservedByMobile, mobileInFlight } from './pos.js'
import { safeProcessPrintRequest } from './print.js'
import { ApiError } from '../../errors.js'
import { emitBillRefunded, emitBillSettled } from '../comun/ganchos.js'
import { updateOriginOutcome } from '../campanas/origen.js'
import { enqueuePlatformEvent, platformEventId } from '../plataforma/eventos.js'
import { billSource } from './source.js'

type ChargeInput = { billId: string; partId: string; cashSessionId: string; expectedRevision: number; amountCents: number; tipCents: number; requestId: string }
/** `mobileCheckoutId`: el pago móvil confirmado libera su propia reserva de saldo; cualquier otra sigue restando. */
export async function applyCharge(pos: Pos, d: ChargeInput, method: core.Payment['method'], externalId: string | null, tenderedCents = 0, mobileCheckoutId: string | null = null) {
  const bill = await account(pos, d), part = await getPart(pos, d.partId)
  if (bill.status !== 'locked' || part.billId !== d.billId || part.revision !== bill.revision) fail('La parte no pertenece a esta cuenta bloqueada y revisión.')
  await cashOpen(pos, d.cashSessionId)
  core.checkCharge(part.totalCents, part.paidCents, await reservedByMobile(pos, d.partId, mobileCheckoutId), d.amountCents)
  const changeCents = method === 'cash' ? core.cashChange(d.amountCents, d.tipCents, tenderedCents) : 0
  const paymentId = newId()
  await putPayment(pos, paymentId, { billId: d.billId, partId: d.partId, cashSessionId: d.cashSessionId, kind: 'charge', originalPaymentId: null, method, status: 'succeeded',
    amountCents: d.amountCents, tipCents: d.tipCents, tenderedCents, changeCents, externalId, requestId: d.requestId, reason: null, at: pos.now, by: pos.uid })
  await putPart(pos, d.partId, { ...part, paidCents: core.sumCents([part.paidCents, d.amountCents]) })
  const paidCents = core.sumCents([bill.paidCents, d.amountCents]), settled = paidCents === bill.totalCents
  const pending = (await pos.client.query('SELECT 1 FROM llenamos.pos_payments WHERE restaurant_id=$1 AND location_id=$2 AND bill_id=$3 AND status=\'pending\' LIMIT 1', [pos.rid, pos.lid, d.billId])).rowCount || await mobileInFlight(pos, d.billId, mobileCheckoutId)
  await putBill(pos, d.billId, { ...bill, paidCents, status: settled && !pending ? 'settled' : 'locked', settledAt: settled && !pending ? pos.now : null })
  await event(pos, 'caja.cobro', paymentId)
  await enqueuePlatformEvent(pos.client, { id: platformEventId('payment.succeeded', pos.rid, pos.lid, paymentId), type: 'payment.succeeded', restaurantId: pos.rid, locationId: pos.lid, data: { entityId: paymentId, status: 'succeeded' } })
  if (settled && !pending) {
    await event(pos, 'caja.cuenta', d.billId)
    await syncOriginSales(pos, d.billId)
    // Gancho de V7 (puntos y sello): no puede abortar el cobro.
    await emitBillSettled(pos.client, { restaurantId: pos.rid, locationId: pos.lid, billId: d.billId, customerId: bill.customerId, totalCents: bill.totalCents, settledAt: pos.now, targetKind: bill.target.kind, targetId: bill.target.id })
  }
  // El cajón lo abre el puente, una sola vez por cobro: ID estable y solicitud durable en la misma transacción.
  if (method === 'cash') {
    const id = sha(['drawer', paymentId])
    await pos.client.query(`INSERT INTO llenamos.pos_print_requests(restaurant_id,location_id,id,kind,source_id,printer_id,copy,status,requested_by,requested_at)
      VALUES($1,$2,$3,'drawer',$4,NULL,0,'queued',$5,$6) ON CONFLICT DO NOTHING`, [pos.rid, pos.lid, id, paymentId, pos.uid, new Date(pos.now)])
    await safeProcessPrintRequest(pos, id)
  }
  return { paymentId, changeCents, dueCents: part.totalCents - part.paidCents - d.amountCents }
}
export async function registrarCobro(pos: Pos, d: core.CallableParsedInput<'registrarCobro'>) {
  if (d.method === 'card' && !d.terminalReference) fail('Indica la referencia del datáfono. Es un registro manual, no un cargo bancario.')
  if (d.method === 'card') {
    // El mismo apunte de datáfono no puede cobrar dos veces (también lo impone un índice único).
    const dup = (await pos.client.query('SELECT 1 FROM llenamos.pos_payments WHERE restaurant_id=$1 AND method=\'card\' AND external_id=$2 AND kind=\'charge\' AND status=\'succeeded\'', [pos.rid, d.terminalReference])).rowCount
    if (dup) fail('Esta referencia de datáfono ya se ha registrado en un cobro.')
  }
  if (d.method === 'deposit') return applyDeposit(pos, d)
  return applyCharge(pos, d, d.method, d.terminalReference, d.tenderedCents)
}
/**
 * Descuenta la señal pagada de la reserva (Stripe, verificada por el receptor de webhooks) de la cuenta de su mesa.
 * La señal solo se aplica a la sesión de su reserva, sin propina, una vez devuelta no vale y la suma de lo aplicado
 * nunca pasa de lo cobrado. Dos cobros a la vez se serializan con el cerrojo del local y el bloqueo de la cuenta.
 */
async function applyDeposit(pos: Pos, d: core.CallableParsedInput<'registrarCobro'>) {
  const bill = await account(pos, d)
  if (bill.target.kind !== 'session') fail('La señal solo se aplica a la sesión de su reserva.')
  const reservationId = (await billSource().load(pos.client, { restaurantId: pos.rid, locationId: pos.lid }, bill.target))?.reservationId
  if (!reservationId) fail('Esta sesión no procede de una reserva con señal.')
  const row = (await pos.client.query<{ data: unknown }>('SELECT data FROM llenamos.reservations WHERE restaurant_id=$1 AND location_id=$2 AND id=$3 AND NOT privacy_redacted FOR UPDATE', [pos.rid, pos.lid, reservationId])).rows[0]
  if (!row) return notFound('No se encuentra la reserva de la señal.')
  const deposit = core.ReservationSchema.parse(row.data).deposit
  if (deposit.status !== 'paid' || !deposit.checkoutSessionId || d.tipCents) fail('La reserva no tiene una señal pagada verificable o se ha pedido propina sobre ella.')
  const applied = (await pos.client.query<{ charged: string; refunded: string }>(
    `SELECT coalesce(sum((data->>'amountCents')::bigint) FILTER (WHERE kind='charge' AND status='succeeded'),0) AS charged,
            count(*) FILTER (WHERE kind='refund' AND status IN ('pending','succeeded')) AS refunded
     FROM llenamos.pos_payments WHERE restaurant_id=$1 AND location_id=$2 AND method='deposit' AND external_id=$3`, [pos.rid, pos.lid, deposit.checkoutSessionId])).rows[0]!
  if (Number(applied.refunded)) fail('Esta señal ya tiene una devolución. Revísala antes de aplicarla.')
  if (core.sumCents([Number(applied.charged), d.amountCents]) > deposit.amountCents) fail('La señal no tiene saldo suficiente o ya se aplicó.')
  return applyCharge(pos, d, 'deposit', deposit.checkoutSessionId)
}
/** Ventas cobradas de la reserva de origen (IVA incluido, netas de devoluciones) para el informe de origen. */
async function syncOriginSales(pos: Pos, billId: string) {
  const bill = await getBill(pos, billId)
  if (bill.target.kind !== 'session') return
  const reservationId = (await billSource().load(pos.client, { restaurantId: pos.rid, locationId: pos.lid }, bill.target))?.reservationId
  if (reservationId) await updateOriginOutcome(pos.client, pos.rid, reservationId, { salesCents: Math.max(0, bill.paidCents - bill.refundedCents) })
}
export async function devolverCobro(pos: Pos, d: core.CallableParsedInput<'devolverCobro'>) {
  const original = await getPayment(pos, d.paymentId)
  // Bloquea la cuenta del cobro para que dos devoluciones concurrentes no excedan el saldo.
  await getBill(pos, original.billId, true)
  core.checkRefund(original, await paymentsOf(pos, 'original_payment_id', d.paymentId), d.amountCents, d.tipCents)
  const refundId = newId()
  // Sin adaptador bancario no se declara un reembolso como realizado, aunque exista una clave.
  if (original.method === 'stripe' || original.method === 'deposit') {
    await putPayment(pos, refundId, { ...original, kind: 'refund', originalPaymentId: d.paymentId, status: 'failed', amountCents: d.amountCents, tipCents: d.tipCents, tenderedCents: 0, changeCents: 0,
      externalId: null, requestId: d.requestId, reason: d.reason, at: pos.now, by: pos.uid })
    return { refundId, status: 'not_configured' as const }
  }
  // Un cierre no cambia: el dinero sale de una caja posterior abierta del mismo terminal.
  const oldCash = await getCash(pos, original.cashSessionId)
  const open = (await pos.client.query<{ id: string }>('SELECT id FROM llenamos.pos_cash_sessions WHERE restaurant_id=$1 AND location_id=$2 AND register_id=$3 AND status=\'open\'', [pos.rid, pos.lid, oldCash.registerId])).rows[0]
  if (!open) fail('Abre la caja del terminal para registrar la devolución.')
  if (d.tipCents && (await pos.client.query('SELECT 1 FROM llenamos.pos_tip_distributions WHERE restaurant_id=$1 AND location_id=$2 AND cash_session_id=$3', [pos.rid, pos.lid, original.cashSessionId])).rowCount)
    fail('Estas propinas ya están repartidas. Revisa su devolución con el encargado.')
  await putPayment(pos, refundId, { ...original, cashSessionId: open!.id, kind: 'refund', originalPaymentId: d.paymentId, status: 'succeeded', amountCents: d.amountCents, tipCents: d.tipCents,
    tenderedCents: 0, changeCents: 0, requestId: d.requestId, reason: d.reason, at: pos.now, by: pos.uid })
  const bill = await getBill(pos, original.billId)
  const refundedCents = core.sumCents([bill.refundedCents, d.amountCents])
  await putBill(pos, original.billId, { ...bill, refundedCents })
  if (d.amountCents) await emitBillRefunded(pos.client, { restaurantId: pos.rid, locationId: pos.lid, billId: original.billId, paymentId: refundId, customerId: bill.customerId, originalPaidCents: bill.paidCents, refundedCents })
  await event(pos, 'caja.cobro', refundId)
  await syncOriginSales(pos, original.billId)
  if (d.amountCents) {
    // Devolver consumo obliga a coordinar la rectificativa: queda pendiente para el encargado, sin reabrir la cuenta.
    await pos.client.query(`INSERT INTO llenamos.pos_refund_reviews(restaurant_id,location_id,id,payment_id,bill_id,part_id,amount_cents,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [pos.rid, pos.lid, refundId, d.paymentId, original.billId, original.partId, d.amountCents, d.reason])
    await event(pos, 'caja.devolucion', refundId)
  }
  return { refundId, status: 'succeeded' as const }
}
