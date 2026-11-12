import type { Pool,PoolClient } from 'pg'
import { z } from 'zod'
import * as core from '@llenamos/core'
import { enqueueOutbox } from '../../outbox.js'
import { PermanentFailure,RetryLater } from '../../worker/types.js'
import type { MaintenanceTask } from '../../worker/maintenance.js'
import { stableUuid } from './common.js'
import { custodyKey,unseal } from './custody.js'
import { sendWebhook,type WebhookTransport } from './destination.js'

/**
 * Evento de plataforma para webhooks salientes. Lo llama el productor (reservas, sala, caja, facturación) dentro de
 * su transacción, tras decidir el hecho. El `id` debe ser determinista (`platformEventId`): repetir el mismo hecho
 * no duplica entregas. Crea una entrega por webhook activo suscrito y su trabajo `plataforma.entrega` en la cola.
 * Solo lleva la referencia (`entityId`, estado); los detalles se leen por API con permisos vigentes.
 */
export async function enqueuePlatformEvent(client:PoolClient,input:Omit<core.PlatformEvent,'occurredAt'|'version'> & {occurredAt?:number}):Promise<number> {
  const event=core.PlatformEventSchema.parse({version:1,occurredAt:Date.now(),...input})
  // La función SQL actúa solo sobre el restaurante del contexto de la transacción (sesión, ámbito público o worker).
  const {rows}=await client.query<{n:number}>('SELECT llenamos.platform_emit_event($1,$2,$3,$4,$5,$6,$7) AS n',[event.restaurantId,event.id,event.type,event.locationId,event.data.entityId,event.data.status,event.occurredAt])
  return rows[0]!.n
}
/** ID determinista de un hecho: la misma decisión confirmada produce siempre el mismo id, venga de la ruta que venga. */
export const platformEventId=(...parts:(string|number)[])=>core.sha256Hex(JSON.stringify(parts))

// --- Trabajo del worker: `plataforma.entrega` ---------------------------------------------------------------
// Forma de `WorkerHandler` de V2 (`src/worker/types.ts`): se registra en el módulo con
// `workerHandlers: plataformaWorkerHandlers()` cuando esa rama esté fusionada. Idempotente por entrega y ronda.
export interface DeliveryContext {
  item:{id:string;restaurantId:string;kind:string;payload:Record<string,unknown>;attempts:number}
  tenant<T>(fn:(client:PoolClient)=>Promise<T>):Promise<T>
  now():Date
  /** Renueva el lease justo antes del efecto externo; falso = otro worker tiene el elemento. */
  extendLease?():Promise<boolean>
}
export type DeliveryHandler=(context:DeliveryContext)=>Promise<void>
interface Claimed {event:core.PlatformEvent;url:string;secret:string;secretVersion:number;attempts:number;round:number;leaseId:string}
const MAX_ATTEMPTS=12
const secretContext=(rid:string,endpoint:string,version:number)=>`webhook:${rid}:${endpoint}:${version}`
export const sealWebhookSecret=secretContext

/** Reclama, envía fuera de la transacción y registra el resultado. Reintenta con un trabajo nuevo y espera creciente. */
export function deliveryHandler(options:{transport?:WebhookTransport;key?:Buffer}={}):DeliveryHandler {
  const transport=options.transport??sendWebhook
  return async ctx=>{
    const rid=ctx.item.restaurantId,deliveryId=String(ctx.item.payload.deliveryId??''),round=Number(ctx.item.payload.round),attempt=Number(ctx.item.payload.attempt)
    if(!/^[A-Za-z0-9_-]{1,128}$/.test(deliveryId)||!Number.isSafeInteger(round)||!Number.isSafeInteger(attempt))return
    const now=ctx.now().getTime()
    const claimed=await ctx.tenant<Claimed|null>(async client=>{
      const {rows}=await client.query('SELECT d.*,e.url,e.events,e.location_ids,e.status AS endpoint_status,e.secret_version FROM llenamos.webhook_deliveries d JOIN llenamos.webhook_endpoints e ON e.restaurant_id=d.restaurant_id AND e.id=d.endpoint_id WHERE d.restaurant_id=$1 AND d.id=$2 FOR UPDATE OF d',[rid,deliveryId])
      const d=rows[0]
      // Un trabajo viejo (otra ronda u otro intento) o ya terminado no vuelve a enviar nada.
      if(!d||['delivered','cancelled','exhausted'].includes(d.status)||d.round!==round)return null
      // Un lease vencido de nuestro propio intento anterior (el worker cayó tras reclamar) se retoma como el mismo intento.
      const expired=d.status==='leased'&&d.lease_until!==null&&new Date(d.lease_until).getTime()<=now&&d.attempts===attempt+1
      // Con un lease vigente de otro intento no se envía, pero tampoco se da por hecho: el elemento se reintenta más tarde.
      if(!expired&&d.status==='leased'&&d.attempts===attempt+1&&d.lease_until!==null)throw new RetryLater(Math.max(5,Math.ceil((new Date(d.lease_until).getTime()-now)/1000)+1),'entrega-en-curso')
      if(!expired&&(d.attempts!==attempt||d.status==='leased'))return null
      const base=expired?attempt:d.attempts
      const finish=(status:string,error:string)=>client.query('UPDATE llenamos.webhook_deliveries SET status=$3,lease_id=NULL,lease_until=NULL,last_error=$4 WHERE restaurant_id=$1 AND id=$2',[rid,deliveryId,status,error])
      if(d.endpoint_status==='revoked'){await finish('cancelled','webhook-revocado');return null}
      if(d.endpoint_status!=='active'){await finish('exhausted','webhook-suspendido');return null}
      if(base>=MAX_ATTEMPTS){
        await finish('exhausted','intentos-agotados')
        await client.query("UPDATE llenamos.webhook_endpoints SET status='suspended',updated_at=now() WHERE restaurant_id=$1 AND id=$2",[rid,d.endpoint_id]);return null
      }
      const event=core.PlatformEventSchema.parse(d.event)
      if(!d.events.includes(event.type)||(event.locationId!==null?!d.location_ids.includes(event.locationId):event.type!=='subscription.changed')){await finish('cancelled','suscripcion-cambiada');return null}
      const secret=await client.query('SELECT ciphertext FROM llenamos.webhook_secrets WHERE restaurant_id=$1 AND endpoint_id=$2 AND version=$3',[rid,d.endpoint_id,d.secret_version])
      if(!secret.rows[0]){await finish('exhausted','secreto-no-disponible');return null}
      const leaseId=stableUuid('lease',deliveryId,round,base+1,now)
      await client.query("UPDATE llenamos.webhook_deliveries SET status='leased',attempts=$6,lease_id=$3,lease_until=$4,last_attempt_at=$5 WHERE restaurant_id=$1 AND id=$2",[rid,deliveryId,leaseId,new Date(now+30_000),new Date(now),base+1])
      return {event,url:d.url,secret:unseal<string>(secret.rows[0].ciphertext,secretContext(rid,d.endpoint_id,d.secret_version),options.key??custodyKey()),secretVersion:d.secret_version,attempts:base+1,round:d.round,leaseId}
    })
    if(!claimed)return
    // Antes de salir a la red hay que seguir siendo el dueño del elemento en la cola.
    if(ctx.extendLease&&!(await ctx.extendLease()))return
    const started=Date.now()
    let status:number|null=null,error:string|null=null
    try {
      const body=core.webhookBody(claimed.event)
      status=await transport(claimed.url,body,core.signPlatformWebhook(claimed.secret,Math.floor(Date.now()/1000),body))
      if(!Number.isInteger(status)||status<100||status>599)throw new Error('invalid_status')
    }catch{status=null;error='No se pudo conectar con el receptor de forma segura.'}
    await ctx.tenant(async client=>{
      const {rows}=await client.query('SELECT d.lease_id,d.endpoint_id,e.status AS endpoint_status,e.consecutive_failures FROM llenamos.webhook_deliveries d JOIN llenamos.webhook_endpoints e ON e.restaurant_id=d.restaurant_id AND e.id=d.endpoint_id WHERE d.restaurant_id=$1 AND d.id=$2 FOR UPDATE OF d',[rid,deliveryId])
      const stored=rows[0]
      // Una respuesta de un trabajador con lease vencido no confirma otro intento.
      if(!stored||stored.lease_id!==claimed.leaseId)return
      const revoked=stored.endpoint_status==='revoked',success=status!==null&&status>=200&&status<300
      const retryable=status===null||status===429||status>=500
      const next=retryable?core.nextWebhookAttempt(claimed.attempts,now):null
      const final=revoked||status===410?'cancelled':success?'delivered':next!==null?'retry':'exhausted'
      await client.query('UPDATE llenamos.webhook_deliveries SET status=$3,lease_id=NULL,lease_until=NULL,last_status=$4,last_error=$5,next_attempt_at=$6 WHERE restaurant_id=$1 AND id=$2',
        [rid,deliveryId,final,status,success?null:error??'El receptor no ha aceptado la entrega.',new Date(next??now)])
      await client.query('INSERT INTO llenamos.webhook_attempts(restaurant_id,delivery_id,round,attempt,status,duration_ms,error,secret_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING',
        [rid,deliveryId,claimed.round,claimed.attempts,status,Date.now()-started,error,claimed.secretVersion])
      if(!revoked)await client.query('UPDATE llenamos.webhook_endpoints SET consecutive_failures=$3,status=CASE WHEN $4 THEN $5 ELSE status END,updated_at=now() WHERE restaurant_id=$1 AND id=$2',
        [rid,stored.endpoint_id,success?0:Number(stored.consecutive_failures)+1,status===410||final==='exhausted',status===410?'revoked':'suspended'])
      // El siguiente intento es un trabajo nuevo con ID propio y espera: la cola del worker no limita a 12 intentos.
      if(final==='retry')await enqueueOutbox(client,{id:stableUuid('entrega',deliveryId,claimed.round,claimed.attempts),restaurantId:rid,kind:'plataforma.entrega',
        payload:{deliveryId,round:claimed.round,attempt:claimed.attempts},availableAt:new Date(next!)})
    })
  }
}

/**
 * `plataforma.evento`: hechos de otros módulos (p. ej. sala: `order.placed`) que dejan su aviso en la cola con ID estable
 * y sin datos personales. Se convierten en entregas dentro del restaurante del elemento; repetirlo no duplica.
 */
const FactSchema=z.object({type:core.PlatformEventTypeSchema,locationId:core.DocIdSchema.nullable(),occurredAt:core.MillisSchema,data:core.PlatformEventSchema.shape.data})
export const platformEventHandler:DeliveryHandler=async ctx=>{
  const fact=FactSchema.safeParse(ctx.item.payload)
  if(!fact.success)throw new PermanentFailure('evento-no-valido')
  await ctx.tenant(client=>enqueuePlatformEvent(client,{id:platformEventId('outbox',ctx.item.id),type:fact.data.type,restaurantId:ctx.item.restaurantId,locationId:fact.data.locationId,occurredAt:fact.data.occurredAt,data:fact.data.data}))
}
/** Tareas periódicas del worker: vencimientos de suscripción y entregas de webhook atascadas. */
export function platformMaintenance(pool:Pool):MaintenanceTask[] {
  return [
    {name:'suscripciones-vencidas',everyMs:600_000,run:async()=>(await pool.query<{n:number}>('SELECT llenamos.billing_expire_due(200) AS n')).rows[0]!.n},
    {name:'entregas-webhook',everyMs:300_000,run:async()=>(await pool.query<{n:number}>('SELECT llenamos.billing_deliveries_sweep(200) AS n')).rows[0]!.n},
  ]
}
export const plataformaWorkerHandlers=(options:{transport?:WebhookTransport;key?:Buffer}={}):ReadonlyArray<readonly [string,DeliveryHandler]>=>[
  ['plataforma.entrega',deliveryHandler(options)],['plataforma.evento',platformEventHandler]]
