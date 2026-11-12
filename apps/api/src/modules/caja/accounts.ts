import * as core from '@llenamos/core'
import { type Pos, fail, notFound, newId, getBill, putBill, getParts, putPart, account, cashOpen, mobileInFlight } from './pos.js'
import { billSource } from './source.js'
import { emitBillSettled } from '../comun/ganchos.js'

async function readSource(pos: Pos, target: core.PosTarget) {
  const found = await billSource().load(pos.client, { restaurantId: pos.rid, locationId: pos.lid }, target)
  if (!found) return notFound('No se encuentra la mesa o la recogida en este local.')
  return found
}
/** Sustituye las partes: solo es posible si ninguna tiene cobros, factura o pagos en curso. */
export async function replaceParts(pos: Pos, billId: string, bill: core.Bill, split: core.SplitSpec) {
  const plans = core.splitBill(core.netBillLines(bill.lines, bill.adjustments), split)
  const existing = await getParts(pos, billId)
  if (existing.some(p => p.paidCents || p.invoiceId)) fail('La cuenta ya tiene cobros, facturas o pagos en curso.')
  const pending = (await pos.client.query('SELECT 1 FROM llenamos.pos_payments WHERE restaurant_id=$1 AND location_id=$2 AND bill_id=$3 AND status=\'pending\' LIMIT 1', [pos.rid, pos.lid, billId])).rowCount
  if (pending || await mobileInFlight(pos, billId)) fail('La cuenta ya tiene cobros, facturas o pagos en curso.')
  await pos.client.query('DELETE FROM llenamos.pos_bill_parts WHERE restaurant_id=$1 AND location_id=$2 AND bill_id=$3', [pos.rid, pos.lid, billId])
  const created: (core.BillPart & { id: string })[] = []
  for (const [i, plan] of plans.entries()) {
    const id = newId()
    const part: core.BillPart = { ...plan, billId, label: plans.length === 1 ? 'Cuenta completa' : `Parte ${i + 1}`, revision: bill.revision, paidCents: 0, invoiceId: null }
    await putPart(pos, id, part)
    created.push({ ...part, id })
  }
  return created
}
/** Devuelve true si el consumo había cambiado y la cuenta (abierta) se ha actualizado. */
export async function refresh(pos: Pos, billId: string) {
  const bill = await getBill(pos, billId, true)
  if (bill.status !== 'open') return false
  const current = await readSource(pos, bill.target)
  if (JSON.stringify(current.lines) === JSON.stringify(bill.lines) && current.customerId === bill.customerId) return false
  const net = core.netBillLines(current.lines, bill.adjustments)
  const next = { ...bill, lines: current.lines, customerId: current.customerId, revision: bill.revision + 1, totalCents: core.sumCents(net.map(l => l.grossCents)) }
  await putBill(pos, billId, next)
  await replaceParts(pos, billId, next, { kind: 'equal', parts: 1 })
  return true
}
export async function abrirCuenta(pos: Pos, d: core.CallableParsedInput<'abrirCuenta'>) {
  const old = (await pos.client.query<{ id: string }>('SELECT id FROM llenamos.pos_bills WHERE restaurant_id=$1 AND location_id=$2 AND target_kind=$3 AND target_id=$4', [pos.rid, pos.lid, d.target.kind, d.target.id])).rows[0]
  if (old) { await refresh(pos, old.id); return { billId: old.id, bill: await getBill(pos, old.id) } }
  const current = await readSource(pos, d.target)
  if (current.cancelled) fail('Esta mesa o recogida está cancelada.')
  if (!current.lines.length) fail('El destino no tiene consumo para abrir una cuenta.')
  const id = newId()
  const bill: core.Bill = { target: d.target, customerId: current.customerId, lines: current.lines, status: 'open', revision: 1, adjustments: [],
    totalCents: core.sumCents(current.lines.map(l => l.grossCents)), paidCents: 0, refundedCents: 0, openedAt: pos.now, lockedAt: null, settledAt: null }
  await putBill(pos, id, bill)
  await replaceParts(pos, id, bill, { kind: 'equal', parts: 1 })
  return { billId: id, bill }
}
export async function verCuenta(pos: Pos, d: core.CallableParsedInput<'verCuenta'>) {
  await refresh(pos, d.billId)
  return { bill: await getBill(pos, d.billId), parts: await getParts(pos, d.billId) }
}
export async function ajustarCuenta(pos: Pos, d: core.CallableParsedInput<'ajustarCuenta'>) {
  const bill = await account(pos, d)
  if (bill.status !== 'open') fail('Desbloquea la cuenta antes de ajustar el consumo.')
  const adjustment: core.BillAdjustment = { id: newId(), lineId: d.lineId, kind: d.kind, amountCents: d.amountCents, reason: d.reason, at: pos.now, by: pos.uid }
  const adjustments = [...bill.adjustments, adjustment], net = core.netBillLines(bill.lines, adjustments)
  const next = { ...bill, adjustments, revision: bill.revision + 1, totalCents: core.sumCents(net.map(l => l.grossCents)) }
  await putBill(pos, d.billId, next)
  await replaceParts(pos, d.billId, next, { kind: 'equal', parts: 1 })
  return { ok: true as const, revision: next.revision, totalCents: next.totalCents }
}
export async function dividirCuenta(pos: Pos, d: core.CallableParsedInput<'dividirCuenta'>) {
  const bill = await account(pos, d)
  if (bill.status !== 'open') fail('La cuenta ya está bloqueada para el cobro.')
  const next = { ...bill, revision: bill.revision + 1 }
  const parts = await replaceParts(pos, d.billId, next, d.split)
  await putBill(pos, d.billId, next)
  return { revision: next.revision, parts }
}
export async function prepararCobro(pos: Pos, d: core.CallableParsedInput<'prepararCobro'>) {
  const bill = await account(pos, d)
  if (bill.status !== 'open') fail('La cuenta ya está bloqueada o saldada.')
  const settled = bill.totalCents === 0
  const next: core.Bill = { ...bill, status: settled ? 'settled' : 'locked', revision: bill.revision + 1, lockedAt: pos.now, settledAt: settled ? pos.now : null }
  await putBill(pos, d.billId, next)
  for (const p of await getParts(pos, d.billId)) await putPart(pos, p.id, { ...p, revision: next.revision })
  // Una cuenta saldada a 0 € (p. ej. un canje que la cubre entera) también avisa: así el canje pasa a `settled`. Ni puntos ni sello: el total es 0.
  if (settled) await emitBillSettled(pos.client, { restaurantId: pos.rid, locationId: pos.lid, billId: d.billId, customerId: bill.customerId, totalCents: 0, settledAt: pos.now, targetKind: bill.target.kind, targetId: bill.target.id })
  return { ok: true as const, revision: next.revision }
}
export async function desbloquearCuenta(pos: Pos, d: core.CallableParsedInput<'desbloquearCuenta'>) {
  const bill = await account(pos, d), own = await getParts(pos, d.billId)
  const pending = (await pos.client.query('SELECT 1 FROM llenamos.pos_payments WHERE restaurant_id=$1 AND location_id=$2 AND bill_id=$3 AND status=\'pending\' LIMIT 1', [pos.rid, pos.lid, d.billId])).rowCount
  if (bill.status !== 'locked' || bill.paidCents || own.some(p => p.invoiceId) || pending || await mobileInFlight(pos, d.billId)) fail('Solo se desbloquea una cuenta sin cobros, facturas ni reservas de pago.')
  const next: core.Bill = { ...bill, status: 'open', revision: bill.revision + 1, lockedAt: null }
  await putBill(pos, d.billId, next)
  for (const p of own) await putPart(pos, p.id, { ...p, revision: next.revision })
  return { ok: true as const, revision: next.revision }
}
export { cashOpen }
