import type { PoolClient } from 'pg'
import * as core from '@llenamos/core'
import { ApiError } from '../../errors.js'
import { replaceParts } from '../caja/accounts.js'
import { getBill, getParts, putBill, type Pos } from '../caja/pos.js'
import type { BillPort, BillView, VisitPort } from './ports.js'

const precondition = (message: string) => new ApiError(412, 'failed-precondition', message)

/** Contexto mínimo de caja para reutilizar sus lecturas y escrituras (`getBill`, `putBill`, `replaceParts`) dentro de la transacción del llamador. */
function posOf(client: PoolClient, rid: string, lid: string, uid: string): Pos {
  return { client, rid, lid, uid, now: Date.now(), restaurant: { timezone: 'Europe/Madrid', isDemo: false }, settings: null }
}
/** El mismo cerrojo por local que toman las operaciones de caja: descontar y cobrar no se pisan. */
const lock = (client: PoolClient, rid: string, lid: string) => client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`pos:${rid}:${lid}`])

async function openAccount(pos: Pos, billId: string, expectedRevision: number | null) {
  await lock(pos.client, pos.rid, pos.lid)
  const bill = await getBill(pos, billId, true)
  if (expectedRevision !== null && bill.revision !== expectedRevision) throw precondition('La cuenta ha cambiado. Recarga antes de continuar.')
  if (bill.status !== 'open') throw precondition('La cuenta no está abierta: desbloquéala antes de aplicar descuentos.')
  const pending = (await pos.client.query("SELECT 1 FROM llenamos.pos_payments WHERE restaurant_id=$1 AND location_id=$2 AND bill_id=$3 AND status='pending' LIMIT 1", [pos.rid, pos.lid, billId])).rowCount
  if (pending || (await getParts(pos, billId)).some(p => p.paidCents || p.invoiceId)) throw precondition('La cuenta ya tiene cobros, facturas o pagos en curso.')
  return bill
}

/** Fidelización sobre las cuentas de caja (V5). Las líneas de caja no llevan plato ni categoría: los premios y promociones por plato no casan con ellas. */
export const cajaBillPort: BillPort = {
  async openBill(client, p) {
    const pos = posOf(client, p.restaurantId, p.locationId, 'fidelizacion')
    const bill = await openAccount(pos, p.billId, p.expectedRevision)
    const net = core.netBillLines(bill.lines, bill.adjustments)
    const view: BillView = {
      billId: p.billId, locationId: p.locationId, revision: bill.revision, customerId: bill.customerId,
      channel: bill.target.kind === 'takeaway' ? 'takeaway' : 'dine_in', totalCents: bill.totalCents,
      lines: net.map(l => ({ lineId: l.lineId, itemId: null, categoryId: null, balanceCents: l.grossCents, quantity: l.quantity })), adjustments: bill.adjustments,
    }
    return view
  },
  async replaceAdjustments(client, p) {
    const pos = posOf(client, p.restaurantId, p.locationId, p.actorUid)
    const bill = await openAccount(pos, p.billId, p.expectedRevision)
    let net: core.BillLine[]
    try { net = core.netBillLines(bill.lines, p.adjustments) } catch (error) { throw precondition(error instanceof Error ? error.message : 'Los descuentos no son válidos.') }
    const next: core.Bill = { ...bill, adjustments: [...p.adjustments], revision: bill.revision + 1, totalCents: core.sumCents(net.map(l => l.grossCents)) }
    await putBill(pos, p.billId, next)
    await replaceParts(pos, p.billId, next, { kind: 'equal', parts: 1 })
    return { revision: next.revision, totalCents: next.totalCents }
  },
}

/** La visita a sellar tiene que ser de ese cliente: una reserva del local o una mesa de sala. */
export const salaVisitPort: VisitPort = {
  async assertVisit(client, p) {
    if (p.reservationId) {
      const { rows } = await client.query<{ customer_id: string }>('SELECT customer_id FROM llenamos.reservations WHERE restaurant_id=$1 AND location_id=$2 AND id=$3 AND NOT privacy_redacted', [p.restaurantId, p.locationId, p.reservationId])
      if (!rows[0]) throw new ApiError(404, 'not-found', 'No se encuentra la reserva en este local.')
      if (rows[0].customer_id !== p.customerId) throw precondition('La reserva no es de este cliente.')
      return
    }
    if (p.sessionId) {
      const { rows } = await client.query<{ customer: string | null }>("SELECT doc->>'customerId' AS customer FROM llenamos.sala_table_sessions WHERE restaurant_id=$1 AND location_id=$2 AND id=$3", [p.restaurantId, p.locationId, p.sessionId])
      if (!rows[0]) throw new ApiError(404, 'not-found', 'No se encuentra la mesa en este local.')
      if (rows[0].customer !== p.customerId) throw precondition('La mesa no es de este cliente.')
      return
    }
    throw precondition('Indica la reserva o la mesa de la visita.')
  },
}
