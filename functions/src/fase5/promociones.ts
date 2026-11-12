import * as core from '@llenamos/core'
import { type Ctx, type Input, fail, revision, ts, raw } from './context'
import { openBill, writeBill, discount } from './fidelizacion'

export async function guardarPromocion(c: Ctx, d: Input<'guardarPromocion'>) {
  const old = d.promotionId ? await c.get(`promotions/${d.promotionId}`,core.PromotionSchema) : null
  if (old) { revision(old.revision,d.expectedRevision); if (old.status === 'archived') fail('La promoción está archivada.') }
  else if (d.expectedRevision !== null) fail('La promoción no existe.')
  for (const lid of d.promotion.locationIds) await c.local(lid)
  if (c.actor?.locationIds.length && !d.promotion.locationIds.length) fail('Elige los locales de la promoción.')
  const id = d.promotionId ?? c.root.collection('promotions').doc().id, rev = (old?.revision ?? 0)+1
  const row: core.Promotion = { ...d.promotion,status:old?.status ?? 'draft',uses:old?.uses ?? 0,revision:rev }
  c.stage(`promotions/${id}`,core.promotionForWrite(row,n => ts(n)))
  return { promotionId:id,revision:rev,status:row.status }
}
export async function cambiarEstadoPromocion(c: Ctx, d: Input<'cambiarEstadoPromocion'>) {
  const p = await c.get(`promotions/${d.promotionId}`,core.PromotionSchema)
  revision(p.revision,d.expectedRevision)
  for (const lid of p.locationIds) await c.local(lid)
  if (p.status === 'archived') fail('La promoción está archivada.')
  c.stage(`promotions/${d.promotionId}`,{ status:d.to,revision:p.revision+1 },'update')
  return { status:d.to,revision:p.revision+1 }
}
async function evaluation(c: Ctx, b: Awaited<ReturnType<typeof openBill>>, p: core.Promotion & {id:string}, code: string | null) {
  const use = b.bill.customerId ? await c.maybe(`promotions/${p.id}/customerUses/${b.bill.customerId}`,raw) : null
  return core.evaluatePromotion(p,{ now:c.now,timezone:c.tz,locationId:c.lid!,channel:b.channel,customerId:b.bill.customerId,code,lines:b.lines,billBalanceCents:b.bill.totalCents,usage:{ total:p.uses,byCustomer:Number(use?.uses ?? 0) },hasLoyaltyRedemption:b.bill.adjustments.some(a => !!a.redemptionId) })
}
export async function promocionesAplicables(c: Ctx, d: Input<'promocionesAplicables'>) {
  const b = await openBill(c,d.billId), rows = await c.list('promotions',core.PromotionSchema)
  const evaluations = await Promise.all(rows.map(p => evaluation(c,b,p,d.code)))
  const best = evaluations.filter(e => e.eligible).sort((a,b) => b.discountCents-a.discountCents || (rows.find(p => p.id === b.promotionId)!.priority-rows.find(p => p.id === a.promotionId)!.priority) || a.promotionId.localeCompare(b.promotionId))[0]
  return { channel:b.channel,best:best ? { promotionId:best.promotionId,name:rows.find(p => p.id === best.promotionId)!.name,discountCents:best.discountCents } : null,evaluations:evaluations.map(e => ({ promotionId:e.promotionId,name:rows.find(p => p.id === e.promotionId)!.name,eligible:e.eligible,discountCents:e.eligible ? e.discountCents : null,reason:e.eligible ? null : e.reason })) }
}
export async function aplicarPromocion(c: Ctx, d: Input<'aplicarPromocion'>) {
  const b = await openBill(c,d.billId,d.expectedBillRevision)
  const old = await c.maybe(`${b.path}/billPromotions/${d.billId}`,core.BillPromotionSchema)
  if (old?.status === 'applied') fail('Quita primero la promoción de esta cuenta.')
  const p = await c.get(`promotions/${d.promotionId}`,core.PromotionSchema), e = await evaluation(c,b,{ ...p,id:d.promotionId },d.code)
  if (!e.eligible) return { status:'rejected',reason:e.reason,message:core.PROMOTION_REJECTION_LABEL[e.reason] }
  const usePath = b.bill.customerId ? `promotions/${d.promotionId}/customerUses/${b.bill.customerId}` : null
  const use = usePath ? await c.maybe(usePath,raw) : null
  const adjustments = discount(c,b.lines.filter(l => e.lineIds.includes(l.lineId)),e.discountCents,'promotion',d.promotionId,p.name)
  const bill = writeBill(c,b,d.billId,[...b.bill.adjustments,...adjustments])
  c.stage(`promotions/${d.promotionId}`,{ uses:p.uses+1 },'update')
  if (usePath) c.stage(usePath,{ uses:Number(use?.uses ?? 0)+1 })
  c.stage(`${b.path}/billPromotions/${d.billId}`,{ promotionId:d.promotionId,billId:d.billId,customerId:b.bill.customerId,discountCents:e.discountCents,adjustmentIds:adjustments.map(a => a.id),status:'applied',at:ts(c.now),by:c.uid })
  return { status:'applied',discountCents:e.discountCents,billRevision:bill.revision,totalCents:bill.totalCents }
}
export async function quitarPromocion(c: Ctx, d: Input<'quitarPromocion'>) {
  const b = await openBill(c,d.billId,d.expectedBillRevision), applied = await c.get(`${b.path}/billPromotions/${d.billId}`,core.BillPromotionSchema)
  if (applied.status !== 'applied') fail('No hay ninguna promoción aplicada.')
  const p = await c.get(`promotions/${applied.promotionId}`,core.PromotionSchema)
  const usePath = applied.customerId ? `promotions/${applied.promotionId}/customerUses/${applied.customerId}` : null
  const use = usePath ? await c.get(usePath,raw) : null
  c.stage(`promotions/${applied.promotionId}`,{ uses:Math.max(0,p.uses-1) },'update')
  if (usePath) c.stage(usePath,{ uses:Math.max(0,Number(use?.uses ?? 0)-1) })
  c.stage(`${b.path}/billPromotions/${d.billId}`,{ status:'removed' },'update')
  const bill = writeBill(c,b,d.billId,b.bill.adjustments.filter(a => !applied.adjustmentIds.includes(a.id)))
  return { billRevision:bill.revision,totalCents:bill.totalCents }
}
