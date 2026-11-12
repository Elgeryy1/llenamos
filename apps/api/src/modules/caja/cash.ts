import * as core from '@llenamos/core'
import { type Pos, fail, newId, getCash, putCash, cashOpen, paymentsOf, movementsOf, event } from './pos.js'

export async function abrirCaja(pos: Pos, d: core.CallableParsedInput<'abrirCaja'>) {
  const open = (await pos.client.query('SELECT 1 FROM llenamos.pos_cash_sessions WHERE restaurant_id=$1 AND location_id=$2 AND register_id=$3 AND status=\'open\'', [pos.rid, pos.lid, d.registerId])).rowCount
  if (open) fail('Esta caja ya está abierta.')
  const cashSessionId = newId()
  await putCash(pos, cashSessionId, { registerId: d.registerId, status: 'open', openingCents: d.openingCents, openedAt: pos.now, openedBy: pos.uid, closedAt: null, closedBy: null,
    countedCents: null, expectedCents: null, differenceCents: null, closeReason: null })
  return { cashSessionId }
}
export async function cerrarCaja(pos: Pos, d: core.CallableParsedInput<'cerrarCaja'>) {
  const cash = await cashOpen(pos, d.cashSessionId)
  const payments = await paymentsOf(pos, 'cash_session_id', d.cashSessionId)
  if (payments.some(p => p.status === 'pending')) fail('Hay pagos externos pendientes. Reconcílialos antes de cerrar.')
  // Un cliente puede estar pagando en Stripe contra esta caja: cerrarla dejaría ese cobro sin dónde asentarse.
  if ((await pos.client.query(`SELECT 1 FROM llenamos.pos_mobile_checkouts WHERE restaurant_id=$1 AND location_id=$2 AND cash_session_id=$3 AND status='pending' AND start_request IS NOT NULL LIMIT 1`, [pos.rid, pos.lid, d.cashSessionId])).rowCount)
    fail('Hay un pago móvil en curso en esta caja. Espera a que termine o cancélalo antes de cerrar.')
  const totals = core.cashReconciliation(cash.openingCents, payments, await movementsOf(pos, d.cashSessionId), d.countedCents)
  if (totals.differenceCents && !d.reason) fail('Indica el motivo de la diferencia de caja.')
  const result: core.CashSession = { ...cash, ...totals, status: 'closed', closedAt: pos.now, closedBy: pos.uid, closeReason: d.reason }
  await putCash(pos, d.cashSessionId, result)
  return { ok: true as const, cashSession: result }
}
export async function registrarMovimientoCaja(pos: Pos, d: core.CallableParsedInput<'registrarMovimientoCaja'>) {
  await cashOpen(pos, d.cashSessionId)
  const movementId = newId()
  await insertMovement(pos, movementId, { cashSessionId: d.cashSessionId, kind: d.kind, amountCents: d.amountCents, reason: d.reason, at: pos.now, by: pos.uid, requestId: d.requestId, distributionId: null })
  return { movementId }
}
export async function insertMovement(pos: Pos, id: string, movement: core.CashMovement) {
  const m = core.CashMovementSchema.parse(movement)
  await pos.client.query('INSERT INTO llenamos.pos_cash_movements(restaurant_id,location_id,id,cash_session_id,distribution_id,data) VALUES($1,$2,$3,$4,$5,$6)',
    [pos.rid, pos.lid, id, m.cashSessionId, m.distributionId ?? null, m])
  await event(pos, 'caja.turno', m.cashSessionId)
}
export async function repartirPropinas(pos: Pos, d: core.CallableParsedInput<'repartirPropinas'>) {
  const cash = await getCash(pos, d.cashSessionId)
  if (cash.status !== 'closed') fail('Cierra y arquea la caja antes de repartir las propinas.')
  const done = (await pos.client.query('SELECT 1 FROM llenamos.pos_tip_distributions WHERE restaurant_id=$1 AND location_id=$2 AND cash_session_id=$3', [pos.rid, pos.lid, d.cashSessionId])).rowCount
  if (done) fail('Las propinas de esta caja ya están repartidas.')
  const active = new Set((await pos.client.query<{ uid: string }>('SELECT pos_active_members AS uid FROM llenamos.pos_active_members($1,$2,$3)', [pos.rid, pos.lid, d.hours.map(h => h.uid)])).rows.map(r => r.uid))
  if (d.hours.some(h => !active.has(h.uid))) fail('Las horas deben pertenecer a personal activo de este local.')
  // La propina pertenece al cobro original, aunque se devuelva desde una caja posterior.
  const charges = await paymentsOf(pos, 'cash_session_id', d.cashSessionId)
  const chargeIds = new Set(charges.filter(p => p.kind === 'charge' && p.status === 'succeeded').map(p => p.id))
  const refunds = (await pos.client.query<{ data: unknown }>(
    'SELECT data FROM llenamos.pos_payments WHERE restaurant_id=$1 AND location_id=$2 AND original_payment_id=ANY($3) AND status=\'succeeded\'', [pos.rid, pos.lid, [...chargeIds]])).rows.map(r => core.PaymentSchema.parse(r.data))
  const totalCents = core.sumCents([...charges.filter(p => chargeIds.has(p.id)).map(p => p.tipCents), ...refunds.map(p => -p.tipCents)].map(v => v))
  const shares = core.distributeTips(totalCents, d.hours), distributionId = newId()
  const row = core.TipDistributionSchema.parse({ cashSessionId: d.cashSessionId, totalCents, shares, at: pos.now, by: pos.uid })
  await pos.client.query('INSERT INTO llenamos.pos_tip_distributions(restaurant_id,location_id,id,cash_session_id,data) VALUES($1,$2,$3,$4,$5)', [pos.rid, pos.lid, distributionId, d.cashSessionId, row])
  await event(pos, 'caja.turno', d.cashSessionId)
  return { distributionId, shares }
}
/** Servicio interno (sin operación pública): paga un reparto en una apertura posterior del mismo terminal. */
export async function payTips(pos: Pos, d: { distributionId: string; cashSessionId: string; requestId: string; reason: string }) {
  const dist = (await pos.client.query<{ data: unknown }>('SELECT data FROM llenamos.pos_tip_distributions WHERE restaurant_id=$1 AND location_id=$2 AND id=$3', [pos.rid, pos.lid, d.distributionId])).rows[0]
  if (!dist) fail('No se encuentra el reparto de propinas.')
  const distribution = core.TipDistributionSchema.parse(dist.data)
  const source = await getCash(pos, distribution.cashSessionId), destination = await cashOpen(pos, d.cashSessionId)
  if (source.status !== 'closed' || source.registerId !== destination.registerId || d.cashSessionId === distribution.cashSessionId) fail('Las propinas se pagan desde una caja posterior del mismo terminal.')
  if (!distribution.totalCents) fail('El reparto no tiene propinas que pagar.')
  const movementId = newId()
  // El índice único por reparto impide un segundo pago aunque dos peticiones lleguen a la vez.
  await insertMovement(pos, movementId, { cashSessionId: d.cashSessionId, kind: 'tip_payout', amountCents: distribution.totalCents, reason: d.reason, at: pos.now, by: pos.uid, requestId: d.requestId, distributionId: d.distributionId })
  return { movementId }
}
