import * as core from '@llenamos/core'
import { type Context, type Input, get, account, parts, newId, hash, fail } from './context'

export function source(c: Context, target: core.PosTarget) {
  const dest = target.kind === 'session' ? get(c,'tableSessions',target.id) : get(c,'takeaways',target.id)
  if ('mergedInto' in dest && dest.mergedInto) fail('Esta sesión se ha juntado con otra mesa. Abre la cuenta de destino.')
  const lines = [...c.rows.orderLines].filter(([,l]) => target.kind === 'session' ? l.sessionId === target.id : l.takeawayId === target.id).map(([id,l]) => ({ ...l,id }))
  return { customerId: dest.customerId, lines: core.billLinesFromOrderLines(lines) }
}
export function refresh(c: Context, billId: string) {
  const bill = get(c,'bills',billId)
  if (bill.status !== 'open') return false
  const current = source(c,bill.target)
  if (JSON.stringify(current.lines) === JSON.stringify(bill.lines) && current.customerId === bill.customerId) return false
  const net = core.netBillLines(current.lines,bill.adjustments)
  const next = { ...bill, ...current, revision: bill.revision + 1, totalCents: core.sumCents(net.map(l => l.grossCents)) }
  c.put('bills',billId,next)
  replaceParts(c,billId,next,{ kind:'equal',parts:1 })
  return true
}
export function replaceParts(c: Context, billId: string, bill: core.Bill, split: core.SplitSpec) {
  const plans = core.splitBill(core.netBillLines(bill.lines,bill.adjustments),split)
  for (const p of parts(c,billId)) {
    if (p.paidCents || p.invoiceId || c.rows.paymentReservations.has(p.id)) fail('La cuenta ya tiene cobros, facturas o pagos en curso.')
    c.remove('billParts',p.id)
  }
  return plans.map((plan,i) => {
    const id = newId(c,'billParts'), part: core.BillPart = { ...plan, billId, label: plans.length === 1 ? 'Cuenta completa' : `Parte ${i + 1}`, revision:bill.revision, paidCents:0,invoiceId:null }
    c.put('billParts',id,part); return { ...part,id }
  })
}
export function abrirCuenta(c: Context, d: Input<'abrirCuenta'>) {
  const key = hash([d.target.kind,d.target.id]), old = c.secrets.billTargets.get(key)
  if (old) { refresh(c,old.billId); return { billId:old.billId,bill:get(c,'bills',old.billId) } }
  const current = source(c,d.target)
  if (!current.lines.length) fail('El destino no tiene consumo para abrir una cuenta.')
  const id = newId(c,'bills'), bill: core.Bill = { ...current,target:d.target,status:'open',revision:1,adjustments:[],totalCents:core.sumCents(current.lines.map(l => l.grossCents)),paidCents:0,refundedCents:0,openedAt:c.now,lockedAt:null,settledAt:null }
  c.put('bills',id,bill); c.secret('billTargets',key,{ billId:id })
  replaceParts(c,id,bill,{ kind:'equal',parts:1 })
  return { billId:id,bill }
}
export function verCuenta(c: Context, d: Input<'verCuenta'>) {
  refresh(c,d.billId)
  return { bill:get(c,'bills',d.billId),parts:parts(c,d.billId) }
}
export function ajustarCuenta(c: Context, d: Input<'ajustarCuenta'>) {
  const bill = account(c,d)
  if (bill.status !== 'open') fail('Desbloquea la cuenta antes de ajustar el consumo.')
  const adjustment: core.BillAdjustment = { id:newId(c,'billAdjustments'),lineId:d.lineId,kind:d.kind,amountCents:d.amountCents,reason:d.reason,at:c.now,by:c.uid! }
  const adjustments = [...bill.adjustments,adjustment], net = core.netBillLines(bill.lines,adjustments)
  const next = { ...bill,adjustments,revision:bill.revision + 1,totalCents:core.sumCents(net.map(l => l.grossCents)) }
  c.put('bills',d.billId,next); replaceParts(c,d.billId,next,{ kind:'equal',parts:1 })
  c.stage(`${c.local.path}/billAdjustments/${adjustment.id}`,{ ...adjustment,at:new Date(c.now),billId:d.billId },true)
  return { ok:true as const,revision:next.revision,totalCents:next.totalCents }
}
export function dividirCuenta(c: Context, d: Input<'dividirCuenta'>) {
  const bill = account(c,d)
  if (bill.status !== 'open') fail('La cuenta ya está bloqueada para el cobro.')
  const next = { ...bill,revision:bill.revision + 1 }
  const result = replaceParts(c,d.billId,next,d.split); c.put('bills',d.billId,next)
  return { revision:next.revision,parts:result }
}
export function prepararCobro(c: Context, d: Input<'prepararCobro'>) {
  const bill = account(c,d)
  if (bill.status !== 'open') fail('La cuenta ya está bloqueada o saldada.')
  const next = { ...bill,status:(bill.totalCents === 0 ? 'settled' : 'locked') as core.BillStatus,revision:bill.revision + 1,lockedAt:c.now,settledAt:bill.totalCents === 0 ? c.now : null }
  c.put('bills',d.billId,next)
  for (const p of parts(c,d.billId)) c.put('billParts',p.id,{ ...p,revision:next.revision })
  return { ok:true as const,revision:next.revision }
}
export function desbloquearCuenta(c: Context, d: Input<'desbloquearCuenta'>) {
  const bill = account(c,d), own = parts(c,d.billId)
  if (bill.status !== 'locked' || bill.paidCents || own.some(p => p.invoiceId || c.rows.paymentReservations.has(p.id)) || [...c.rows.payments.values()].some(p => p.billId === d.billId && p.status === 'pending')) fail('Solo se desbloquea una cuenta sin cobros, facturas ni reservas de pago.')
  const next = { ...bill,status:'open' as const,revision:bill.revision + 1,lockedAt:null }
  c.put('bills',d.billId,next); for (const p of own) c.put('billParts',p.id,{ ...p,revision:next.revision })
  return { ok:true as const,revision:next.revision }
}
