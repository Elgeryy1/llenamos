import type { Pool } from 'pg'
import * as core from '@llenamos/core'
import { loadContext,refreshReservation } from './engine.js'
import { cancelPendingNotices,reservationNotices } from './notices.js'
import { failure,notFound,resolveTenantById,withPublicScope } from './scope.js'
import { lockLocation,readReservation,recordOriginStatus,reservationEvent,reservationPlatformEvent,syncCustomer,updateReservation } from './store.js'


export interface DepositPayment {restaurantId:string;locationId:string;reservationId:string;checkoutSessionId:string;amountCents:number;currency:string}

/** Guarda la sesión de pago creada por el módulo de cobros; solo mientras la señal sigue exigida. */
export async function recordCheckoutSession(pool:Pool,restaurantId:string,locationId:string,reservationId:string,checkoutSessionId:string) {
  const tenant=await resolveTenantById(pool,restaurantId,locationId)
  return withPublicScope(pool,restaurantId,async client=>{
    await lockLocation(client,restaurantId,locationId)
    const r=await readReservation(client,restaurantId,locationId,reservationId,true)
    if(!r)return notFound('No se encuentra la reserva.')
    if(r.deposit.status==='paid')return false
    if(!['pending','confirmed'].includes(r.status))failure('La reserva ya no admite el pago de la señal.')
    const {id:_id,...doc}=r
    await updateReservation(client,tenant.rid,locationId,reservationId,{...doc,deposit:{...r.deposit,status:'required',checkoutSessionId}},null)
    return true
  })
}
/**
 * Aplica un pago de señal confirmado por el proveedor. Idempotente: repetir el mismo evento no cambia
 * nada. Un pago tardío sobre una reserva cancelada se anota sin resucitarla y devuelve `paid_late` (quien llama debe alertar). Lo invoca el receptor de
 * webhooks (V2) tras verificar la firma y deduplicar por ID de evento.
 */
export async function applyDepositPayment(pool:Pool,payment:DepositPayment):Promise<'paid'|'paid_late'|'already_paid'> {
  const tenant=await resolveTenantById(pool,payment.restaurantId,payment.locationId)
  return withPublicScope(pool,tenant.rid,async client=>{
    await lockLocation(client,tenant.rid,payment.locationId)
    const current=await readReservation(client,tenant.rid,payment.locationId,payment.reservationId,true)
    if(!current)return notFound('No se encuentra la reserva.')
    if(current.deposit.status==='paid')return 'already_paid'
    if(current.deposit.checkoutSessionId!==payment.checkoutSessionId||current.deposit.amountCents!==payment.amountCents||payment.currency!=='eur')
      throw new Error('El pago no corresponde a la señal.')
    const c=await loadContext(client,tenant,payment.locationId,[current.startAt],{requireModule:false})
    // La reserva ya tenía su sitio: no se vuelve a buscar mesa (el aforo pudo reducirse) ni se pide otra vez la señal.
    const changed=current.status==='pending'?core.applyStatusChange(current,'confirmed',{nowMs:c.now,by:null,reason:'Señal pagada'}):null
    const {id:_id,...doc}=changed?.ok?changed.reservation:current
    const next:core.Reservation={...doc,deposit:{...current.deposit,status:'paid'}}
    await updateReservation(client,tenant.rid,payment.locationId,current.id,next,null)
    refreshReservation(c,current.id,next)
    if(changed?.ok) {
      await cancelPendingNotices(client,tenant.rid,current.id)
      await reservationNotices(c,current.id,next)
      await syncCustomer(client,tenant.rid,next)
      await recordOriginStatus(client,tenant.rid,current.id,next.status)
      await reservationPlatformEvent(client,tenant.rid,payment.locationId,current.id,'reservation.statusChanged',next.status,next.history.length)
    }
    await reservationEvent(client,tenant.rid,payment.locationId,current.id,'deposit','paid')
    // Cobrada pero la reserva ya no existe como tal (cancelada, no presentada…): se anota y se avisa para devolverla a mano.
    return ['pending','confirmed','seated'].includes(current.status)?'paid':'paid_late'
  })
}
