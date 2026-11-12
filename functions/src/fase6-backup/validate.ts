import type { Row } from '../fase6-privacy/infra'
import { collectionOf } from '../fase6-privacy/infra'
/** Relaciones de servicio y caja que deben existir en el mismo corte y local. */
export function validRelations(rows:Row[]) {
  const paths = new Set(rows.map(r => r.path))
  const targetExists = (row:Row,collection:string,id:unknown) => typeof id !== 'string' || id.length === 0 || paths.has(`${row.path.split('/').slice(0,-2).join('/')}/${collection}/${id}`)
  for (const row of rows) {
    const d = row.data,collection = collectionOf(row)
    if (['orders','orderLines','floorTasks','bills'].includes(collection)) {
      if (!targetExists(row,'tableSessions',d.sessionId) || !targetExists(row,'takeaways',d.takeawayId)) return false
    }
    if (collection === 'orderLines' && !targetExists(row,'orders',d.orderId)) return false
    if (['payments','billParts','invoices','mobileCheckouts','paymentReservations'].includes(collection) && !targetExists(row,'bills',d.billId)) return false
    if (collection === 'bills' && d.target && !targetExists(row,d.target.kind === 'session' ? 'tableSessions' : 'takeaways',d.target.id)) return false
    if (collection === 'tableSessions' && !targetExists(row,'reservations',d.reservationId)) return false
    if (collection === 'floorTasks' && Array.isArray(d.lineIds) && !d.lineIds.every((id:unknown) => targetExists(row,'orderLines',id))) return false
    if (collection === 'takeaways' && Array.isArray(d.orderIds) && !d.orderIds.every((id:unknown) => targetExists(row,'orders',id))) return false
  }
  return true
}
