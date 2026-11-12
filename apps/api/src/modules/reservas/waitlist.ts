import { randomBytes,randomUUID } from 'node:crypto'
import { ApiError } from '../../errors.js'
import { limits,txHit } from './abuse.js'
import * as core from '@llenamos/core'
import { appOrigin,queueMessage,reservationNotices } from './notices.js'
import { availability,dayFocus,ensureWindow,offeredOccupancy,type Ctx } from './engine.js'
import { failure,newId } from './scope.js'
import { recordReservationOrigin } from '../campanas/origen.js'
import { recordOriginStatus,reservationEvent,reservationPlatformEvent,syncCustomer } from './store.js'
import { insertWithReference,manageToken } from './bookings.js'

const offerToken=()=>core.linkToken(randomBytes(32))
const toEntry=(row:{id:string;data:unknown})=>({id:row.id,...core.WaitlistEntrySchema.parse(row.data)})

export async function joinWaitlist(c:Ctx,beforeWrite:(()=>Promise<void>)|undefined,input:{date:string;from:string;to:string;partySize:number;guestName:string;phone:string;email:string|null;language:core.Language;source:'web'|'widget'}) {
  const s=c.settings,today=core.horaLocal(c.now,s.timezone).fecha
  if(input.partySize<s.minPartySize||input.partySize>s.maxPartySize||input.date<today||input.date>core.sumarDias(today,s.maxAdvanceDays))
    failure('La fecha o el tamaño del grupo están fuera del plazo de reservas.')
  if(!s.waitlist.enabled)failure('La lista de espera está desactivada.')
  await beforeWrite?.()
  const id=newId(),entry=core.WaitlistEntrySchema.parse({guestName:input.guestName,phone:input.phone,email:input.email,language:input.language,partySize:input.partySize,
    date:input.date,from:input.from,to:input.to,status:'waiting',offer:null,customerId:core.customerIdFor(c.tenant.rid,input.phone),source:input.source})
  await c.client.query('INSERT INTO llenamos.waitlist(restaurant_id,location_id,id,customer_id,service_date,status,data) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [c.tenant.rid,c.lid,id,entry.customerId,entry.date,entry.status,JSON.stringify(entry)])
  await reservationEvent(c.client,c.tenant.rid,c.lid,id,'waitlist','waiting','reservas.espera')
  return {waitlistId:id,status:'waiting' as const}
}

/**
 * Ofrece el hueco liberado a la entrada más antigua que encaje. Se ejecuta dentro de la misma
 * transacción (y bajo el bloqueo del local) que liberó la mesa: nunca ofrece el mismo hueco dos veces.
 */
export async function offerWaitlist(c:Ctx) {
  const s=c.settings
  if(!core.hasModule(c.tenant.restaurant,'reservations')||!c.saved||!s.waitlist.enabled||!s.publicBooking)return
  const {rows}=await c.client.query<{id:string;data:unknown}>(
    `SELECT id,data FROM llenamos.waitlist WHERE restaurant_id=$1 AND location_id=$2 AND status='waiting' AND service_date>=$3 ORDER BY created_at,id LIMIT 200 FOR UPDATE`,
    [c.tenant.rid,c.lid,core.horaLocal(c.now,s.timezone).fecha])
  for(const row of rows) {
    const entry=toEntry(row)
    // El contexto solo trae las reservas cercanas al hueco liberado: cada fecha candidata carga su propia ventana.
    await ensureWindow(c,dayFocus(entry.date,c.tenant.timezone))
    const available=availability(c,entry.date,entry.partySize)
    const from=core.horaAMinutos(entry.from),to=core.horaAMinutos(entry.to)
    const slot=available.franjas.find(f=>f.disponible&&(from<=to?core.horaAMinutos(f.hora)>=from&&core.horaAMinutos(f.hora)<=to:core.horaAMinutos(f.hora)>=from||core.horaAMinutos(f.hora)<=to))
    if(!slot)continue
    const raw=offerToken(),expiresAt=c.now+s.waitlist.offerMinutes*60000
    const next:core.WaitlistEntry={...entry,status:'offered',offer:{startAt:slot.inicio,expiresAt,tokenHash:core.sha256Hex(raw)}}
    await c.client.query(`UPDATE llenamos.waitlist SET status='offered',offer_token_hash=$4,offer_expires_at=$5,data=$6,updated_at=now() WHERE restaurant_id=$1 AND location_id=$2 AND id=$3`,
      [c.tenant.rid,c.lid,row.id,next.offer!.tokenHash,new Date(expiresAt),JSON.stringify(core.WaitlistEntrySchema.parse(next))])
    c.occupancy.push(...offeredOccupancy(row.id,next,s,c.now))
    const offerUrl=new URL(`/r/${c.tenant.slug}/lista-espera/${row.id}?t=${raw}`,appOrigin()).href
    for(const channel of ['email','whatsapp'] as const) {
      const to_=channel==='email'?entry.email:entry.phone
      if(to_)await queueMessage(c.client,c.tenant.rid,{channel,to:to_,template:'waitlist_offer',language:entry.language,data:{guestName:entry.guestName,restaurantName:c.tenant.name,partySize:entry.partySize,startAt:slot.inicio,timezone:s.timezone,offerUrl,expiresAt},reservationId:null,waitlistId:row.id,sendAt:c.now} as core.MessageRequest,`offer:${row.id}:${channel}`)
    }
    // El worker caduca la oferta con este trabajo (clave estable por entrada).
    await c.client.query(`INSERT INTO llenamos.jobs(id,restaurant_id,kind,deduplication_key,payload,scheduled_at) VALUES($1,$2,'reservas.caducar_oferta',$3,$4,$5) ON CONFLICT DO NOTHING`,
      [randomUUID(),c.tenant.rid,`${c.lid}:${row.id}:${expiresAt}`,JSON.stringify({locationId:c.lid,waitlistId:row.id}),new Date(expiresAt)])
    await reservationEvent(c.client,c.tenant.rid,c.lid,row.id,'offered','offered','reservas.espera')
    return
  }
}
/** Caduca ofertas vencidas del local y, liberado el hueco, ofrece a la siguiente persona. */
export async function expireOffers(c:Ctx) {
  const res=await c.client.query<{id:string;data:unknown}>(
    `UPDATE llenamos.waitlist SET status='expired',data=jsonb_set(data,'{status}','"expired"'),updated_at=now()
     WHERE restaurant_id=$1 AND location_id=$2 AND status='offered' AND offer_expires_at<=$3 RETURNING id,data`,[c.tenant.rid,c.lid,new Date(c.now)])
  if(res.rowCount)await offerWaitlist(c)
  return res.rowCount??0
}

/** Acepta la oferta con el token: se convierte en reserva con el aforo bloqueado. */
export async function acceptOffer(c:Ctx,waitlistId:string,token:string) {
  const {rows}=await c.client.query<{id:string;data:unknown}>(`SELECT id,data FROM llenamos.waitlist WHERE restaurant_id=$1 AND location_id=$2 AND id=$3 FOR UPDATE`,[c.tenant.rid,c.lid,waitlistId])
  if(!rows[0])return failure('La oferta ha caducado o el enlace no es válido.')
  const entry=toEntry(rows[0])
  if(entry.status!=='offered'||!entry.offer||entry.offer.tokenHash!==core.sha256Hex(token)||entry.offer.expiresAt<=c.now)failure('La oferta ha caducado o el enlace no es válido.')
  const offer=entry.offer!
  const available=availability(c,entry.date,entry.partySize)
  if(!available.franjas.some(f=>f.inicio===offer.startAt&&f.disponible))failure('El hueco ya no está disponible.')
  const amountCents=core.depositAmountFor(c.settings.deposit,entry.partySize),manage=manageToken(),id=newId()
  const deposit={status:amountCents?c.tenant.stripe?'required' as const:'not_configured' as const:'none' as const,amountCents,checkoutSessionId:null}
  const r0:Omit<core.Reservation,'reference'>=({guestName:entry.guestName,phone:entry.phone,email:entry.email,language:entry.language,partySize:entry.partySize,startAt:offer.startAt,
    durationMinutes:available.duracionMinutos,status:c.settings.autoConfirm&&!amountCents?'confirmed':'pending',tableIds:[],suggestedTableIds:[],suggestionReason:null,source:'waitlist',notes:'',guestNotes:'',
    customerId:entry.customerId,manageTokenHash:core.sha256Hex(manage),deposit,history:[],createdBy:null}) as Omit<core.Reservation,'reference'>
  // Máximo 10 ofertas aceptadas por cliente y hora; la cuenta se revierte si la aceptación falla.
  if(!(await txHit(c.client,c.tenant.rid,'accept-customer',entry.customerId,limits.accept)))throw new ApiError(429,'resource-exhausted','Demasiados intentos. Vuelve a intentarlo más tarde.')
  const r=await insertWithReference(c,id,reference=>core.ReservationSchema.parse({...r0,reference}),null)
  await recordReservationOrigin(c.client,{restaurantId:c.tenant.rid,locationId:c.lid,reservationId:id,reservationSource:'waitlist',attribution:null,serviceDate:entry.date,partySize:r.partySize})
  await recordOriginStatus(c.client,c.tenant.rid,id,r.status)
  await c.client.query(`UPDATE llenamos.waitlist SET status='booked',data=jsonb_set(data,'{status}','"booked"'),updated_at=now() WHERE restaurant_id=$1 AND location_id=$2 AND id=$3`,[c.tenant.rid,c.lid,waitlistId])
  await syncCustomer(c.client,c.tenant.rid,r)
  await reservationNotices(c,id,r,manage)
  await reservationEvent(c.client,c.tenant.rid,c.lid,id,'created',r.status)
  await reservationPlatformEvent(c.client,c.tenant.rid,c.lid,id,'reservation.created',r.status,'created')
  await reservationEvent(c.client,c.tenant.rid,c.lid,waitlistId,'booked','booked','reservas.espera')
  return {reference:r.reference,status:r.status,manageToken:manage,startAt:r.startAt,deposit:r.deposit}
}
