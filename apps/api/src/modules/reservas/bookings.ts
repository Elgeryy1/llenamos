import { randomBytes } from 'node:crypto'
import * as core from '@llenamos/core'
import { ApiError } from '../../errors.js'
import { cancelPendingNotices,queueMessage,reservationNotices } from './notices.js'
import { refreshReservation,selection,startOf,type Ctx } from './engine.js'
import { failure,newId,notFound } from './scope.js'
import { recordReservationOrigin } from '../campanas/origen.js'
import { insertReservation,readReservation,recordOriginStatus,reservationEvent,reservationPlatformEvent,syncCustomer,updateReservation } from './store.js'

export interface NewReservation {
  guestName:string;phone:string;email:string|null;language:core.Language;partySize:number;date:string;time:string;source:core.ReservationSource
  status?:core.ReservationStatus;durationMinutes?:number;tableIds?:string[];notes?:string;guestNotes?:string;skipWebLimits?:boolean
  attribution?:core.ReservationAttributionInput;marketingOptIn?:core.PublicMarketingOptIn
}
export const manageToken=()=>core.linkToken(randomBytes(32))

/** Inserta con referencia única por restaurante; una colisión rarísima entre locales reintenta con otra. */
export async function insertWithReference(c:Ctx,id:string,build:(reference:string)=>core.Reservation,actor:string|null) {
  for(let attempt=0;attempt<5;attempt++) {
    const r=build(core.reservationReference(randomBytes(16)))
    await c.client.query('SAVEPOINT reference_try')
    try {
      await insertReservation(c.client,c.tenant.rid,c.lid,id,r,actor)
      await c.client.query('RELEASE SAVEPOINT reference_try')
      return r
    } catch(error) {
      await c.client.query('ROLLBACK TO SAVEPOINT reference_try')
      if((error as {code?:string}).code!=='23505')throw error
    }
  }
  throw new ApiError(409,'aborted','Repite la operación para obtener otra referencia.')
}
/** Origen y permisos de marketing de una reserva nueva (sustituye a writeMarketing): el origen lo clasifica y guarda campañas. */
async function writeMarketing(c:Ctx,id:string,r:core.Reservation,date:string,input?:Pick<NewReservation,'attribution'|'marketingOptIn'>) {
  await recordReservationOrigin(c.client,{restaurantId:c.tenant.rid,locationId:c.lid,reservationId:id,reservationSource:r.source,attribution:input?.attribution??null,serviceDate:date,partySize:r.partySize})
  const opt=input?.marketingOptIn
  for(const channel of ['email','whatsapp'] as const) {
    if(!opt?.[channel])continue
    const consent:core.Consent={customerId:r.customerId,purpose:core.purposeForChannel(channel),status:'granted',policyVersion:opt.policyVersion,at:c.now,source:'public',evidenceId:id}
    await c.client.query('INSERT INTO llenamos.consents(restaurant_id,id,data) VALUES($1,$2,$3)',[c.tenant.rid,`reservation.${id}.${channel}`,JSON.stringify(core.consentForWrite(consent,v=>v))])
  }
}

/** `beforeWrite` corre con la franja ya validada y antes de escribir: los límites que cuentan solo lo aceptado van aquí. */
export async function createReservation(c:Ctx,input:NewReservation,uid:string|null,publicRequest=false,dryRun=false,beforeWrite?:()=>Promise<void>) {
  const startAt=startOf(c,input.date,input.time,input.partySize,input.durationMinutes,input.skipWebLimits??false)
  const amountCents=publicRequest?core.depositAmountFor(c.settings.deposit,input.partySize):0
  const status=publicRequest?(amountCents||!c.settings.autoConfirm?'pending':'confirmed'):input.status??'confirmed'
  const token=manageToken(),id=newId()
  const base:Omit<core.Reservation,'reference'>={guestName:input.guestName,phone:input.phone,email:input.email,language:input.language,partySize:input.partySize,startAt,
    durationMinutes:input.durationMinutes??core.duracionParaGrupo(c.config,input.partySize),status,tableIds:input.tableIds??[],suggestedTableIds:[],suggestionReason:null,source:input.source,
    notes:input.notes??'',guestNotes:input.guestNotes??'',customerId:core.customerIdFor(c.tenant.rid,input.phone),manageTokenHash:core.sha256Hex(token),
    deposit:{status:amountCents?(c.tenant.stripe?'required':'not_configured'):'none',amountCents,checkoutSessionId:null},history:[],createdBy:uid}
  if(core.occupiesTable(status)) {
    const suggestion=selection(c,{...base,startAt},base.tableIds)
    base.suggestedTableIds=suggestion.mesaIds
    base.suggestionReason=suggestion.explicacion
  }
  if(dryRun)return {reservationId:id,reference:'------',status,startAt,tableIds:base.tableIds,suggestedTableIds:base.suggestedTableIds,manageToken:token,deposit:base.deposit}
  await beforeWrite?.()
  const r=await insertWithReference(c,id,reference=>core.ReservationSchema.parse({...base,reference}),uid)
  await writeMarketing(c,id,r,input.date,publicRequest?input:undefined)
  await recordOriginStatus(c.client,c.tenant.rid,id,status)
  await syncCustomer(c.client,c.tenant.rid,r)
  await reservationNotices(c,id,r,token)
  await reservationEvent(c.client,c.tenant.rid,c.lid,id,'created',status)
  await reservationPlatformEvent(c.client,c.tenant.rid,c.lid,id,'reservation.created',status,'created')
  c.reservations.push({id,...r})
  c.occupancy.push(core.reservationToOcupacion(id,r))
  return {reservationId:id,reference:r.reference,status,startAt,tableIds:r.tableIds,suggestedTableIds:r.suggestedTableIds,manageToken:token,deposit:r.deposit}
}

export function view(c:Ctx,r:core.Reservation) {
  const unpaid=['required','not_configured','failed'].includes(r.deposit.status)
  return {...r,timezone:c.settings.timezone,locationId:c.lid,locationName:c.tenant.locationName,
    freeCancellationUntil:c.settings.cancellation.freeUntilHours?r.startAt-c.settings.cancellation.freeUntilHours*3600000:null,
    canConfirm:!unpaid&&core.canTransition(r.status,'confirmed',r.startAt,c.now),canCancel:core.canTransition(r.status,'cancelled',r.startAt,c.now)}
}
/** La reserva se lee con bloqueo de fila: dos cambios de estado simultáneos no se pisan. */
export async function lockedReservation(c:Ctx,id:string) {
  return (await readReservation(c.client,c.tenant.rid,c.lid,id,true))??notFound('No se encuentra la reserva.')
}
export async function changeStatus(c:Ctx,r:core.ReservationWithId,status:core.ReservationStatus,by:string|null,reason?:string|null) {
  const changed=core.applyStatusChange(r,status,{nowMs:c.now,by,reason})
  if(!changed.ok)return failure(changed.reason)
  const next=changed.reservation
  if(core.occupiesTable(status))selection(c,next,next.tableIds,r.id)
  await cancelPendingNotices(c.client,c.tenant.rid,r.id)
  await updateReservation(c.client,c.tenant.rid,c.lid,r.id,next,by)
  refreshReservation(c,r.id,next)
  await syncCustomer(c.client,c.tenant.rid,next)
  if(status==='confirmed'||status==='cancelled')await reservationNotices(c,r.id,next)
  if(status==='finished'&&c.settings.reviews.enabled&&c.settings.reviews.googleReviewUrl) {
    const sendAt=core.instanteDeHoraLocal(core.sumarDias(core.horaLocal(next.startAt,c.settings.timezone).fecha,1),720,c.settings.timezone)
    if(sendAt!==null)for(const channel of ['email','whatsapp'] as const) {
      const to=channel==='email'?next.email:next.phone
      if(to)await queueMessage(c.client,c.tenant.rid,{channel,to,template:'review_request',language:next.language,data:{guestName:next.guestName,googleReviewUrl:c.settings.reviews.googleReviewUrl},reservationId:r.id,waitlistId:null,sendAt} as core.MessageRequest,`${r.id}:review:${channel}`)
    }
  }
  await recordOriginStatus(c.client,c.tenant.rid,r.id,status)
  await reservationEvent(c.client,c.tenant.rid,c.lid,r.id,'status',status)
  await reservationPlatformEvent(c.client,c.tenant.rid,c.lid,r.id,'reservation.statusChanged',status,next.history.length)
  return next
}
