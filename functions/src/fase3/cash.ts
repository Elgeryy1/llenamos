import * as core from '@llenamos/core'
import { type Context, type Input, get, cashOpen, fail, newId } from './context'

export function abrirCaja(c: Context, d: Input<'abrirCaja'>) {
  if (c.secrets.registerLocks.get(d.registerId)?.cashSessionId) fail('Esta caja ya está abierta.')
  const cashSessionId = newId(c,'cashSessions')
  c.put('cashSessions',cashSessionId,{ registerId:d.registerId,status:'open',openingCents:d.openingCents,openedAt:c.now,openedBy:c.uid!,closedAt:null,closedBy:null,countedCents:null,expectedCents:null,differenceCents:null,closeReason:null })
  c.secret('registerLocks',d.registerId,{ cashSessionId })
  return { cashSessionId }
}
export function cerrarCaja(c: Context, d: Input<'cerrarCaja'>) {
  const cash = cashOpen(c,d.cashSessionId)
  const pendingExternal = [...c.checkoutMetadata.values()].some(p => p.cashSessionId === d.cashSessionId && ['pending','reconciliation_required'].includes(p.status))
  const reserved = [...c.rows.paymentReservations.values()].some(r => !r.checkoutId || c.checkoutMetadata.get(r.checkoutId)?.cashSessionId === d.cashSessionId)
  if (pendingExternal || reserved || [...c.rows.payments.values()].some(p => p.cashSessionId === d.cashSessionId && p.status === 'pending')) fail('Hay pagos externos pendientes. Reconcílialos antes de cerrar.')
  const payments = [...c.rows.payments.values()].filter(p => p.cashSessionId === d.cashSessionId)
  const movements = [...c.rows.cashMovements.values()].filter(p => p.cashSessionId === d.cashSessionId)
  const totals = core.cashReconciliation(cash.openingCents,payments,movements,d.countedCents)
  if (totals.differenceCents && !d.reason) fail('Indica el motivo de la diferencia de caja.')
  const result: core.CashSession = { ...cash,...totals,status:'closed',closedAt:c.now,closedBy:c.uid,closeReason:d.reason }
  c.put('cashSessions',d.cashSessionId,result); c.secret('registerLocks',cash.registerId,{ cashSessionId:null })
  return { ok:true as const,cashSession:result }
}
export function registrarMovimientoCaja(c: Context, d: Input<'registrarMovimientoCaja'>) {
  cashOpen(c,d.cashSessionId)
  const movementId = newId(c,'cashMovements')
  c.put('cashMovements',movementId,{ cashSessionId:d.cashSessionId,kind:d.kind,amountCents:d.amountCents,reason:d.reason,at:c.now,by:c.uid!,requestId:d.requestId,distributionId:null })
  return { movementId }
}
export function repartirPropinas(c: Context, d: Input<'repartirPropinas'>) {
  const cash = get(c,'cashSessions',d.cashSessionId)
  if (cash.status !== 'closed') fail('Cierra y arquea la caja antes de repartir las propinas.')
  if ([...c.rows.tipDistributions.values()].some(t => t.cashSessionId === d.cashSessionId)) fail('Las propinas de esta caja ya están repartidas.')
  for (const h of d.hours) {
    const member = c.members.get(h.uid)
    if (!member?.active || (member.locationIds.length && !member.locationIds.includes(c.lid))) fail('Las horas deben pertenecer a personal activo de este local.')
  }
  // La propina pertenece al cobro original, aunque se devuelva desde una caja posterior.
  const charges = new Set([...c.rows.payments].filter(([,p]) => p.cashSessionId === d.cashSessionId && p.kind === 'charge' && p.status === 'succeeded').map(([id]) => id))
  const totalCents = core.sumCents([...c.rows.payments].filter(([id,p]) => p.status === 'succeeded' && (charges.has(id) || (p.originalPaymentId !== null && charges.has(p.originalPaymentId)))).map(([,p]) => (p.kind === 'charge' ? 1 : -1) * p.tipCents))
  const shares = core.distributeTips(totalCents,d.hours), distributionId = newId(c,'tipDistributions')
  c.put('tipDistributions',distributionId,{ cashSessionId:d.cashSessionId,totalCents,shares,at:c.now,by:c.uid! })
  return { distributionId,shares }
}

/** Servicio interno: paga un reparto completo en la apertura posterior del mismo terminal. */
export function payTips(c: Context, d: { distributionId: string; cashSessionId: string; requestId: string; reason: string }) {
  const distribution = get(c,'tipDistributions',d.distributionId)
  const source = get(c,'cashSessions',distribution.cashSessionId), destination = cashOpen(c,d.cashSessionId)
  if (source.status !== 'closed' || source.registerId !== destination.registerId || d.cashSessionId === distribution.cashSessionId) fail('Las propinas se pagan desde una caja posterior del mismo terminal.')
  if ([...c.rows.cashMovements.values()].some(m => m.distributionId === d.distributionId)) fail('Este reparto ya se ha pagado.')
  if (!distribution.totalCents) fail('El reparto no tiene propinas que pagar.')
  const movementId = newId(c,'cashMovements')
  c.put('cashMovements',movementId,{ cashSessionId:d.cashSessionId,kind:'tip_payout',amountCents:distribution.totalCents,reason:d.reason,at:c.now,by:c.uid!,requestId:d.requestId,distributionId:d.distributionId })
  return { movementId }
}
