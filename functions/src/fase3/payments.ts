import * as core from '@llenamos/core'
import { type Context, type Input, get, account, cashOpen, newId, fail, hash, localOnly } from './context'

function applyCharge(c: Context, d: { billId: string; partId: string; cashSessionId: string; expectedRevision: number; amountCents: number; tipCents: number; requestId: string }, method: core.Payment['method'], externalId: string | null, tenderedCents = 0, reservationCheckout: string | null = null) {
  const bill = account(c,d), part = get(c,'billParts',d.partId)
  if (bill.status !== 'locked' || part.billId !== d.billId || part.revision !== bill.revision) fail('La parte no pertenece a esta cuenta bloqueada y revisión.')
  cashOpen(c,d.cashSessionId)
  const reservation = c.rows.paymentReservations.get(d.partId)
  const own = !!reservation && reservation.checkoutId === reservationCheckout && reservationCheckout !== null
  if (reservationCheckout && (!own || reservation!.billId !== d.billId || reservation!.revision !== bill.revision || reservation!.amountCents !== d.amountCents)) fail('La reserva del pago no coincide con la cuenta.')
  core.checkCharge(part.totalCents,part.paidCents,own ? 0 : reservation?.amountCents ?? 0,d.amountCents)
  const changeCents = method === 'cash' ? core.cashChange(d.amountCents,d.tipCents,tenderedCents) : 0
  const paymentId = newId(c,'payments')
  c.put('payments',paymentId,{ billId:d.billId,partId:d.partId,cashSessionId:d.cashSessionId,kind:'charge',originalPaymentId:null,method,status:'succeeded',amountCents:d.amountCents,tipCents:d.tipCents,tenderedCents,changeCents,externalId,requestId:d.requestId,reason:null,at:c.now,by:c.uid })
  c.put('billParts',d.partId,{ ...part,paidCents:core.sumCents([part.paidCents,d.amountCents]) })
  const paidCents = core.sumCents([bill.paidCents,d.amountCents]), settled = paidCents === bill.totalCents
  if (own) c.remove('paymentReservations',d.partId)
  const pending = [...c.rows.paymentReservations.values()].some(r => r.billId === d.billId) || [...c.rows.payments.values()].some(p => p.billId === d.billId && p.status === 'pending')
  if (settled && !pending && method === 'stripe') c.audit('bill.settled','Cuenta saldada por pago externo.',{ billId:d.billId })
  c.put('bills',d.billId,{ ...bill,paidCents,status:settled && !pending ? 'settled' : 'locked',settledAt:settled && !pending ? c.now : null })
  if (method === 'cash') c.stage(`${c.local.path}/printRequests/${hash(['drawer',paymentId])}`,core.printRequestForWrite({ kind:'drawer',sourceId:paymentId,printerId:null,copy:0,status:'queued',requestedBy:c.uid,requestedAt:c.now },ms => ms),true)
  return { paymentId,changeCents,dueCents:part.totalCents - part.paidCents - d.amountCents }
}
export function registrarCobro(c: Context, d: Input<'registrarCobro'>) {
  if (d.method === 'card' && !d.terminalReference) fail('Indica la referencia del datáfono. Es un registro manual, no un cargo bancario.')
  let externalId = d.terminalReference
  if (d.method === 'deposit') {
    localOnly()
    const bill = account(c,d)
    if (bill.target.kind !== 'session') fail('La señal solo se aplica a la sesión de su reserva.')
    const session = get(c,'tableSessions',bill.target.id)
    if (!session.reservationId) fail('Esta sesión no procede de una reserva con señal.')
    const reservation = get(c,'reservations',session.reservationId), deposit = reservation.deposit
    if (!deposit || deposit.status !== 'paid' || !deposit.checkoutSessionId || d.tipCents) fail('La reserva no tiene una señal pagada verificable o se ha pedido propina sobre ella.')
    const used = c.secrets.depositApplications.get(session.reservationId)
    const refunded = [...c.rows.payments.values()].some(p => p.method === 'deposit' && p.externalId === deposit.checkoutSessionId && p.kind === 'refund' && ['pending','succeeded'].includes(p.status))
    if (refunded) fail('Esta señal ya tiene una devolución. Revísala antes de aplicarla.')
    if (core.sumCents([used?.amountCents ?? 0,d.amountCents]) > deposit.amountCents) fail('La señal no tiene saldo suficiente o ya se aplicó.')
    externalId = deposit.checkoutSessionId
    const result = applyCharge(c,d,d.method,externalId)
    c.secret('depositApplications',session.reservationId,{ reservationId:session.reservationId,externalId,paymentId:result.paymentId,amountCents:core.sumCents([used?.amountCents ?? 0,d.amountCents]) })
    return result
  }
  return applyCharge(c,d,d.method,externalId,d.tenderedCents)
}
export function devolverCobro(c: Context, d: Input<'devolverCobro'>) {
  const original = get(c,'payments',d.paymentId)
  const refunds = [...c.rows.payments.values()].filter(p => p.originalPaymentId === d.paymentId)
  core.checkRefund(original,refunds,d.amountCents,d.tipCents)
  const external = original.method === 'stripe' || original.method === 'deposit'
  // Sin adaptador bancario no se declara un reembolso como realizado, aunque exista una clave.
  if (external) {
    const refundId = newId(c,'payments')
    c.put('payments',refundId,{ ...original,kind:'refund',originalPaymentId:d.paymentId,status:'failed',amountCents:d.amountCents,tipCents:d.tipCents,tenderedCents:0,changeCents:0,externalId:null,requestId:d.requestId,reason:d.reason,at:c.now,by:c.uid })
    return { refundId,status:'not_configured' as const }
  }
  // Un cierre no cambia: el dinero sale de una caja posterior del mismo terminal.
  const oldCash = get(c,'cashSessions',original.cashSessionId)
  const cashSessionId = c.secrets.registerLocks.get(oldCash.registerId)?.cashSessionId as string | undefined
  if (!cashSessionId) fail('Abre la caja del terminal para registrar la devolución.')
  cashOpen(c,cashSessionId!)
  if ([...c.rows.tipDistributions.values()].some(t => t.cashSessionId === original.cashSessionId) && d.tipCents) fail('Estas propinas ya están repartidas. Revisa su devolución con el encargado.')
  const refundId = newId(c,'payments')
  c.put('payments',refundId,{ ...original,cashSessionId:cashSessionId!,kind:'refund',originalPaymentId:d.paymentId,status:'succeeded',amountCents:d.amountCents,tipCents:d.tipCents,tenderedCents:0,changeCents:0,requestId:d.requestId,reason:d.reason,at:c.now,by:c.uid })
  const bill = get(c,'bills',original.billId)
  c.put('bills',original.billId,{ ...bill,refundedCents:core.sumCents([bill.refundedCents,d.amountCents]) })
  if (d.amountCents) c.stage(`${c.local.path}/refundReviews/${refundId}`,{ paymentId:d.paymentId,refundId,billId:original.billId,partId:original.partId,amountCents:d.amountCents,reason:d.reason,status:'requires_fiscal_correction' },true)
  return { refundId,status:'succeeded' as const }
}
export async function externalCharge(c: Context, d: core.ConfirmedExternalPayment) {
  const payloadHash = hash({ ...d,requestId:null })
  const key = hash(['stripe',d.externalId]), previous = c.secrets.paymentEvents.get(key)
  if (previous) {
    if (previous.payloadHash !== payloadHash) fail('Este pago externo ya está asociado a otra intención.')
    return previous.result as { paymentId: string; dueCents: number }
  }
  const checkout = get(c,'mobileCheckouts',d.checkoutId)
  const metadata = c.checkoutMetadata.get(d.checkoutId)!
  if (checkout.status !== 'pending' || checkout.billId !== d.billId || checkout.partId !== d.partId || checkout.revision !== d.expectedRevision || checkout.amountCents !== d.amountCents || checkout.tipCents !== d.tipCents || checkout.stripeSessionId !== d.externalId || metadata.cashSessionId !== d.cashSessionId) fail('El pago externo no coincide con la sesión y el saldo reservados. Requiere conciliación.')
  const { paymentId,dueCents } = applyCharge(c,d,'stripe',d.externalId,0,d.checkoutId)
  c.put('mobileCheckouts',d.checkoutId,{ ...checkout,status:'paid' })
  const result = { paymentId,dueCents }
  c.secret('paymentEvents',key,{ paymentId,payloadHash,result })
  return result
}
