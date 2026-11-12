import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import * as core from '@llenamos/core'
import { enqueueOutbox } from '../../outbox.js'
import { failure,type Tenant } from './scope.js'
import type { Ctx } from './engine.js'

export const NOTICE_KIND='aviso.mensaje'

/** UUID estable derivado del hecho: repetir la operación nunca duplica el aviso. */
export function stableId(...parts:Array<string|number>):string {
  const h=createHash('sha256').update(parts.join('\u0000')).digest('hex')
  return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`
}
export function appOrigin(env:NodeJS.ProcessEnv=process.env):string {
  try{return core.publicAppOrigin(env.PUBLIC_APP_URL,false)}
  catch{return failure('Falta configurar la dirección segura de la aplicación.')}
}
export const reservationLink=(slug:string,reference:string,token:string)=>new URL(`/r/${slug}/reserva/${reference}?t=${token}`,appOrigin()).href

/** Un aviso por canal con destinatario. El worker (no la petición HTTP) lo envía. */
export async function queueMessage(client:PoolClient,rid:string,request:core.MessageRequest,key:string) {
  const parsed=core.MessageRequestSchema.parse(request)
  await enqueueOutbox(client,{id:stableId(rid,key),restaurantId:rid,kind:NOTICE_KIND,payload:parsed as unknown as Record<string,unknown>,availableAt:new Date(parsed.sendAt)})
}
/** El enlace de gestión lleva el token claro: solo vive en la cola hasta que el worker envía el aviso. */
export async function reservationNotices(c:Ctx,id:string,r:core.Reservation,token?:string) {
  const tenant:Tenant=c.tenant
  const data:core.MessageData={guestName:r.guestName,restaurantName:tenant.name,locationName:tenant.locationName,reference:r.reference,startAt:r.startAt,partySize:r.partySize,timezone:c.settings.timezone,amountCents:r.deposit.amountCents,slug:tenant.slug,locationId:c.lid}
  if(token)data.manageUrl=reservationLink(tenant.slug,r.reference,token)
  const send=async(template:core.MessageTemplate,sendAt:number)=>{
    for(const channel of ['whatsapp','email'] as const) {
      const to=channel==='email'?r.email:r.phone
      if(to)await queueMessage(c.client,tenant.rid,{channel,to,template,language:r.language,data,reservationId:id,waitlistId:null,sendAt} as core.MessageRequest,`${id}:${template}:${channel}:${sendAt}:${c.now}`)
    }
  }
  if(r.status==='cancelled'){await send('cancellation',c.now);return}
  if(!['pending','confirmed'].includes(r.status))return
  await send(r.status==='confirmed'?'confirmation':'pending',c.now)
  if(r.deposit.status==='required')await send('deposit_request',c.now)
  if(c.settings.reminders.dayBefore) {
    const day=core.sumarDias(core.horaLocal(r.startAt,c.settings.timezone).fecha,-1)
    const at=core.instanteDeHoraLocal(day,core.horaAMinutos(c.settings.reminders.hour),c.settings.timezone)
    if(at!==null&&at>c.now&&at<r.startAt)await send('reminder',at)
  }
}
/** Anula avisos aún sin enviar de una reserva (cambio de hora, estado o cancelación). */
export async function cancelPendingNotices(client:PoolClient,rid:string,reservationId:string) {
  await client.query('SELECT llenamos.reservas_cancel_notices($1,$2)',[rid,reservationId])
}
