import type { PoolClient } from 'pg'
import { z } from 'zod'
import * as core from '@llenamos/core'
import type { LiveQuery } from '../types.js'

const Doc=core.DocIdSchema
const roles=(permission:core.Permission)=>core.ROLES.filter(role=>core.can(role,permission))
const rid=(input:unknown)=>(input as {restaurantId:string}).restaurantId
/** Fila a fila: el destinatario puede ser `suprimido` o vacío (privacidad), así que no se exige que sea un correo o un teléfono. */
const MessageDoc=core.MessageRowSchema.and(z.object({id:z.string()}))
/** Enlaces con token: solo viajan en la cola hasta que el aviso termina; la bandeja nunca los devuelve. */
const LINKS=['manageUrl','offerUrl','paymentUrl','trackUrl']
const docId=(value:unknown)=>typeof value==='string'&&Doc.safeParse(value).success?value:null

interface DeliveryRow {id:string;channel:'email'|'whatsapp';template:string;recipient:string;language:string;status:'sent'|'not_configured'|'failed'|'cancelled';provider:string|null;provider_message_id:string|null
  context:Record<string,unknown>;payload:unknown;purpose:string|null;attempts:number;last_error:string|null;created_at:Date}
interface QueuedRow {id:string;payload:unknown;status:string;attempts:number;occurred_at:Date}

/** Datos de la plantilla sin enlaces con token (en la cola ya se limpian al terminar, pero aquí no se confía en ello). */
function safeData(payload:unknown):Record<string,string|number|boolean|null> {
  const request=core.MessageRequestSchema.safeParse(payload)
  return request.success?Object.fromEntries(Object.entries(request.data.data).filter(([key])=>!LINKS.includes(key))):{}
}
function fromDelivery(row:DeliveryRow) {
  const purpose=row.purpose==='marketing_email'||row.purpose==='marketing_whatsapp'?row.purpose:null
  return {at:row.created_at.getTime(),message:{id:row.id,channel:row.channel,to:row.recipient,template:row.template,language:row.language,data:safeData(row.payload),reservationId:docId(row.context.reservationId),waitlistId:docId(row.context.waitlistId),
    takeawayId:docId(row.context.takeawayId)??undefined,status:row.status,sendAt:row.created_at.getTime(),attempts:row.attempts,lastError:row.last_error,provider:row.provider,providerMessageId:row.provider_message_id,
    // La base guarda el asunto, no el cuerpo: sin texto completo no se inventa uno.
    rendered:null,purpose,customerId:docId(row.context.customerId),campaignId:docId(row.context.campaignId)}}
}
function fromQueue(row:QueuedRow) {
  const request=core.MessageRequestSchema.safeParse(row.payload)
  if(!request.success)return null
  const waiting=row.status==='pending'||row.status==='leased'
  return {at:row.occurred_at.getTime(),message:{...core.queuedMessage({...request.data,data:safeData(row.payload)}),id:row.id,status:waiting?'queued' as const:'failed' as const,attempts:row.attempts,lastError:waiting?null:'envio-fallido'}}
}
/**
 * Resultados ya registrados más los avisos aún en cola (o sin resultado), de los más recientes a los más antiguos.
 * Se ordena por el momento en que se creó cada aviso, no por la hora a la que debe salir: un recordatorio programado
 * para dentro de una semana no es «reciente». Cada fila se valida por separado y la que no encaje se descarta, para
 * que una sola fila rara no tumbe la bandeja entera.
 */
async function messages(client:PoolClient,restaurantId:string,limit:number,reservationId:string|null) {
  const filter=reservationId===null?'':" AND d.context->>'reservationId'=$3"
  const queueFilter=reservationId===null?'':" AND o.payload->>'reservationId'=$3"
  const params=reservationId===null?[restaurantId,limit]:[restaurantId,limit,reservationId]
  const [delivered,queued]=await Promise.all([
    client.query<DeliveryRow>(`SELECT d.*,o.payload FROM llenamos.message_deliveries d LEFT JOIN llenamos.outbox o ON o.id=d.id AND o.restaurant_id=d.restaurant_id
      WHERE d.restaurant_id=$1${filter} ORDER BY d.created_at DESC,d.id LIMIT $2`,params),
    client.query<QueuedRow>(`SELECT o.id,o.payload,o.status,o.attempts,o.occurred_at FROM llenamos.outbox o WHERE o.restaurant_id=$1 AND o.kind='mensaje.enviar'
      AND o.status IN ('pending','leased','failed','quarantined')${queueFilter} AND NOT EXISTS(SELECT 1 FROM llenamos.message_deliveries d WHERE d.id=o.id)
      ORDER BY o.occurred_at DESC,o.id LIMIT $2`,params)])
  const all=[...delivered.rows.map(fromDelivery),...queued.rows.map(fromQueue).filter(m=>m!==null)]
  return all.sort((a,b)=>b.at-a.at||a.message.id.localeCompare(b.message.id)).slice(0,limit)
    .map(item=>MessageDoc.safeParse(item.message)).filter(parsed=>parsed.success).map(parsed=>parsed.data)
}

export const MAX_MESSAGES=200

export const proveedoresLiveQueries:ReadonlyArray<LiveQuery>=[
  {name:'mensajesRecientes',roles:roles('mensajes.ver'),input:z.strictObject({restaurantId:Doc,limit:z.number().int().min(1).max(MAX_MESSAGES).default(50)}),output:z.object({messages:z.array(MessageDoc)}),
    restaurantId:rid,topics:()=>['reservas.reserva','reservas.espera'],refreshMs:10_000,
    snapshot:async(client,raw)=>{const d=raw as {restaurantId:string;limit:number};return {messages:await messages(client,d.restaurantId,d.limit,null)}}},
  {name:'mensajesReserva',roles:roles('mensajes.ver'),input:z.strictObject({restaurantId:Doc,reservationId:Doc}),output:z.object({messages:z.array(MessageDoc)}),
    restaurantId:rid,topics:()=>['reservas.reserva'],refreshMs:10_000,
    snapshot:async(client,raw)=>{const d=raw as {restaurantId:string;reservationId:string};return {messages:await messages(client,d.restaurantId,50,d.reservationId)}}},
  {name:'miembros',roles:core.ROLES,input:z.strictObject({restaurantId:Doc}),output:z.array(core.MemberSchema),
    restaurantId:rid,topics:()=>['equipo.*'],refreshMs:30_000,
    snapshot:async(client,raw)=>{
      const {rows}=await client.query<{uid:string;display_name:string;email:string;role:core.Role;location_ids:string[];active:boolean}>('SELECT * FROM llenamos.restaurant_members($1)',[(raw as {restaurantId:string}).restaurantId])
      return rows.map(r=>({uid:r.uid,displayName:r.display_name,email:r.email,role:r.role,locationIds:r.location_ids,active:r.active}))
    }},
]
