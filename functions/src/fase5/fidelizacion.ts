import * as core from '@llenamos/core'
import { type Ctx, type Input, fail, revision, ts, loyaltySettings, raw, hash } from './context'

export async function guardarConfiguracionFidelizacion(c: Ctx, d: Input<'guardarConfiguracionFidelizacion'>) { c.stage('settings/loyalty', d.settings); return { ok: true } }
export async function guardarPremio(c: Ctx, d: Input<'guardarPremio'>) {
  const old = d.rewardId ? await c.get(`loyaltyRewards/${d.rewardId}`, core.LoyaltyRewardSchema) : null
  if (old) revision(old.revision, d.expectedRevision)
  else if (d.expectedRevision !== null) fail('El premio todavía no existe.')
  const id = d.rewardId ?? c.root.collection('loyaltyRewards').doc().id, rev = (old?.revision ?? 0) + 1
  c.stage(`loyaltyRewards/${id}`, { ...d.reward, revision: rev }); return { rewardId: id, revision: rev }
}
export async function altaFidelizacion(c: Ctx, d: Input<'altaFidelizacion'>) {
  await c.get(`customers/${d.customerId}`, raw)
  const settings = await loyaltySettings(c)
  if (!settings.enabled || settings.termsVersion !== d.acceptedTermsVersion) fail('Confirma las condiciones vigentes del programa.')
  const old = await c.maybe(`loyaltyAccounts/${d.customerId}`, core.LoyaltyAccountSchema)
  if (old?.status === 'closed') fail('Esta cuenta está cerrada por privacidad.')
  if (old) return { balance: old.balance, enrolledAt: old.enrolledAt, alreadyEnrolled: true }
  const account: core.LoyaltyAccount = { customerId: d.customerId, status: 'active', balance: 0, earned: 0, redeemed: 0, expired: 0, termsVersion: settings.termsVersion, enrolledAt: c.now, enrolledBy: c.uid!, revision: 1 }
  c.stage(`loyaltyAccounts/${d.customerId}`, core.loyaltyAccountForWrite(account, n => ts(n)), 'create')
  return { balance: 0, enrolledAt: c.now, alreadyEnrolled: false }
}
export async function ledger(c: Ctx, customerId: string) {
  const docs = await c.tx.get(c.root.collection('loyaltyMovements').where('customerId', '==', customerId))
  const rows = docs.docs.map(d => ({ ...core.LoyaltyMovementSchema.parse(d.data()), id: d.id }))
  c.movementClocks.set(customerId,Math.max(-1,...rows.map(m => m.at)))
  return rows
}
/** Libro inmutable y saldo se confirman juntos. También expira antes de operar. */
export function movement(c: Ctx, account: core.LoyaltyAccount, id: string, data: Pick<core.LoyaltyMovement, 'kind' | 'points'> & Partial<core.LoyaltyMovement>) {
  const at = Math.max(data.at ?? c.now,(c.movementClocks.get(account.customerId) ?? -1)+1)
  c.movementClocks.set(account.customerId,at)
  const next = core.applyLoyaltyMovement(account, data)
  const m: core.LoyaltyMovement = { customerId: account.customerId, expiresAt: null, locationId: c.lid ?? null, billId: null, redemptionId: null, earnMovementId: null, reason: null, by: c.uid, ...data, at, balanceAfter: next.balance }
  c.stage(`loyaltyMovements/${id}`, core.loyaltyMovementForWrite(m, n => ts(n)), 'create')
  c.stage(`loyaltyAccounts/${account.customerId}`, core.loyaltyAccountForWrite(next, n => ts(n)))
  return next
}
export function expire(c: Ctx, a: core.LoyaltyAccount, rows: core.MovementWithId[]) {
  for (const e of core.planExpirations(rows, c.now)) a = movement(c, a, e.id, { kind: 'expire', points: e.points, earnMovementId: e.earnMovementId })
  return a
}
export async function verCuentaFidelizacion(c: Ctx, d: Input<'verCuentaFidelizacion'>) {
  const a = await c.maybe(`loyaltyAccounts/${d.customerId}`, core.LoyaltyAccountSchema), rows = await ledger(c, d.customerId)
  const available = core.availablePoints(rows, c.now)
  const rewards = await c.list('loyaltyRewards', core.LoyaltyRewardSchema)
  return { enrolled: a?.status === 'active', available, expiringIn30Days: core.pointsExpiringBefore(rows, c.now, c.now + 30 * 86400000), earned: a?.earned ?? 0, redeemed: a?.redeemed ?? 0, expired: a?.expired ?? 0,
    movements: rows.sort((a,b) => b.at - a.at || b.id.localeCompare(a.id)).slice(0,50).map(m => ({ id: m.id, kind:m.kind,points:m.points,balanceAfter:m.balanceAfter,at:m.at,reason:m.reason })),
    rewards: rewards.filter(r => r.active).map(r => ({ rewardId:r.id,name:r.name,pointsCost:r.pointsCost,affordable:available >= r.pointsCost })) }
}
export async function ajustarPuntos(c: Ctx, d: Input<'ajustarPuntos'>) {
  let a = await c.get(`loyaltyAccounts/${d.customerId}`, core.LoyaltyAccountSchema)
  if (a.status !== 'active') fail('Esta cuenta de puntos está cerrada.')
  const rows = await ledger(c, d.customerId), settings = await loyaltySettings(c)
  if (d.points < 0 && core.availablePoints(rows,c.now) < -d.points) fail('No hay puntos suficientes.')
  a = expire(c,a,rows)
  const id = `adjust.${hash([c.uid,d.requestId]).slice(0,32)}`
  movement(c,a,id,{ kind:'adjust',points:d.points,reason:d.reason,expiresAt:d.points > 0 ? core.lotExpiresAt(c.now,settings) : null })
  c.audit('loyalty.adjusted','Puntos ajustados',{ customerId:d.customerId,points:d.points,reason:d.reason })
  return { movementId:id,available:core.availablePoints(rows,c.now) + d.points }
}

/** Conserva la coordinación con caja: revisión, partes, facturas y pagos pendientes. */
export async function openBill(c: Ctx, billId: string, expected?: number) {
  const path = `locations/${c.lid}`, bill = await c.get(`${path}/bills/${billId}`,core.BillSchema)
  if (expected !== undefined) revision(bill.revision,expected)
  if (bill.status !== 'open' || bill.paidCents) fail('La cuenta debe estar abierta y sin cobros.')
  const docs = await c.tx.get(c.root.collection(`${path}/billParts`).where('billId','==',billId))
  const parts = docs.docs.map(d => ({ ...core.BillPartSchema.parse(d.data()),id:d.id }))
  for (const p of parts) if (p.paidCents || p.invoiceId || (await c.tx.get(c.ref(`${path}/paymentReservations/${p.id}`))).exists) fail('La cuenta ya tiene pagos o facturas en curso.')
  const payments = await c.tx.get(c.root.collection(`${path}/payments`).where('billId','==',billId).where('status','==','pending'))
  if (!payments.empty) fail('La cuenta tiene pagos pendientes.')
  const orderDocs = await c.tx.get(c.root.collection(`${path}/orderLines`).where(bill.target.kind === 'session' ? 'sessionId' : 'takeawayId','==',bill.target.id))
  const orders = orderDocs.docs.map(d => ({ ...core.OrderLineSchema.parse(d.data()),id:d.id }))
  const current = core.billLinesFromOrderLines(orders)
  // Un pedido añadido después de abrir caja obliga a refrescarla con verCuenta de fase 3.
  if (orders.length && JSON.stringify(current) !== JSON.stringify(bill.lines)) fail('Hay consumo nuevo. Recarga la cuenta antes de aplicar descuentos.')
  const catalog = await c.list(`${path}/menuItems`,core.MenuItemSchema)
  const headers = await c.list(`${path}/orders`,core.OrderSchema)
  const lines: core.PromotionLine[] = core.netBillLines(bill.lines,bill.adjustments).map(l => {
    const order = orders.find(o => o.id === l.lineId)
    return { lineId:l.lineId,itemId:order?.itemId ?? null,categoryId:catalog.find(i => i.id === order?.itemId)?.categoryId ?? null,balanceCents:l.grossCents }
  })
  const take = bill.target.kind === 'takeaway' ? await c.maybe(`${path}/takeaways/${bill.target.id}`,raw) : null
  const channel: core.PromotionChannel = bill.target.kind === 'takeaway' ? 'takeaway' : take?.source === 'qr' || headers.some(o => o.sessionId === bSessionId(bill) && o.source === 'table') ? 'qr' : 'dine_in'
  return { bill,parts,lines,path,channel }
}
export function writeBill(c: Ctx, b: Awaited<ReturnType<typeof openBill>>, billId: string, adjustments: core.BillAdjustment[]) {
  const bill = { ...b.bill,adjustments,revision:b.bill.revision + 1,totalCents:core.netBillLines(b.bill.lines,adjustments).reduce((s,l) => s+l.grossCents,0) }
  c.stage(`${b.path}/bills/${billId}`,core.billForWrite(bill,n => ts(n)))
  for (const p of b.parts) c.remove(`${b.path}/billParts/${p.id}`)
  const plans = core.splitBill(core.netBillLines(bill.lines,adjustments),{ kind:'equal',parts:1 })
  plans.forEach((plan,i) => c.stage(`${b.path}/billParts/${hash([billId,bill.revision,i]).slice(0,32)}`,{ ...plan,billId,label:'Cuenta completa',revision:bill.revision,paidCents:0,invoiceId:null },'create'))
  return bill
}
export function discount(c: Ctx, lines: core.PromotionLine[], amount: number, kind: 'promotion' | 'reward', id: string, reason: string): core.BillAdjustment[] {
  return core.allocateDiscount(lines,amount).map(p => ({ id:core.discountAdjustmentId(kind,id,p.lineId),lineId:p.lineId,kind:'discount',amountCents:p.amountCents,at:c.now,by:c.uid!,reason,...(kind === 'promotion' ? { promotionId:id } : { redemptionId:id }) }))
}
export async function canjearPuntos(c: Ctx, d: Input<'canjearPuntos'>) {
  const b = await openBill(c,d.billId,d.expectedBillRevision)
  if (b.bill.customerId !== d.customerId) fail('El cliente no corresponde a esta cuenta.')
  let a = await c.get(`loyaltyAccounts/${d.customerId}`,core.LoyaltyAccountSchema)
  if (a.status !== 'active') fail('La cuenta de puntos está cerrada.')
  const settings = await loyaltySettings(c); if (!settings.enabled) fail('El programa de puntos está apagado.')
  const reward = await c.get(`loyaltyRewards/${d.rewardId}`,core.LoyaltyRewardSchema)
  if (!reward.active) fail('Este premio está desactivado.')
  const applied = await c.maybe(`${b.path}/billPromotions/${d.billId}`,core.BillPromotionSchema)
  if (applied?.status === 'applied' && (await c.get(`promotions/${applied.promotionId}`,core.PromotionSchema)).stacking === 'exclusive') fail('La promoción no admite canjes de puntos.')
  const rows = await ledger(c,d.customerId), plan = core.planRedemption(rows,reward.pointsCost,c.now)
  if (!plan.ok) return { status:'insufficient',available:plan.available,pointsCost:reward.pointsCost }
  const lines = b.lines.filter(l => reward.kind === 'amount' || l.itemId === reward.itemId)
  const selected = reward.kind === 'item' ? lines.slice(0,1) : lines
  const amount = Math.min(reward.valueCents,selected.reduce((s,l) => s+l.balanceCents,0),reward.kind === 'item' && selected[0] ? Math.floor(selected[0].balanceCents / (b.bill.lines.find(l => l.lineId === selected[0]!.lineId)?.quantity ?? 1)) : reward.valueCents)
  if (!amount) fail('El premio no descuenta ningún plato de esta cuenta.')
  const id = hash([c.uid,d.requestId]).slice(0,32)
  a = expire(c,a,rows)
  movement(c,a,core.loyaltyMovementId.redeem(id),{ kind:'redeem',points:-reward.pointsCost,redemptionId:id,billId:d.billId })
  c.stage(`loyaltyRedemptions/${id}`,{ customerId:d.customerId,rewardId:d.rewardId,locationId:c.lid,billId:d.billId,points:reward.pointsCost,discountCents:amount,status:'applied',at:ts(c.now),by:c.uid },'create')
  const bill = writeBill(c,b,d.billId,[...b.bill.adjustments,...discount(c,selected,amount,'reward',id,reward.name)])
  return { status:'applied',redemptionId:id,points:reward.pointsCost,discountCents:amount,available:plan.balanceAfter,billRevision:bill.revision }
}
export async function anularCanje(c: Ctx, d: Input<'anularCanje'>) {
  const r = await c.get(`loyaltyRedemptions/${d.redemptionId}`,core.LoyaltyRedemptionSchema)
  if (r.locationId !== c.lid || r.status !== 'applied') fail('El canje no está aplicado en este local.')
  const b = await openBill(c,r.billId,d.expectedBillRevision), settings = await loyaltySettings(c)
  let a = await c.get(`loyaltyAccounts/${r.customerId}`,core.LoyaltyAccountSchema)
  const rows = await ledger(c,r.customerId)
  a = expire(c,a,rows)
  movement(c,a,core.loyaltyMovementId.redeemReversal(d.redemptionId),{ kind:'redeem_reversal',points:r.points,redemptionId:d.redemptionId,billId:r.billId,reason:d.reason,expiresAt:core.lotExpiresAt(c.now,settings) })
  c.stage(`loyaltyRedemptions/${d.redemptionId}`,{ status:'reversed' },'update')
  const bill = writeBill(c,b,r.billId,b.bill.adjustments.filter(a => a.redemptionId !== d.redemptionId))
  return { available:core.availablePoints(rows,c.now)+r.points,billRevision:bill.revision }
}

function bSessionId(b: core.Bill) { return b.target.kind === 'session' ? b.target.id : null }
