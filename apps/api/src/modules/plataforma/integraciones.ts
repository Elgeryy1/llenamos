import { randomBytes } from 'node:crypto'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import * as core from '@llenamos/core'
import { ApiError } from '../../errors.js'
import { emitEvent } from '../../events.js'
import { enqueueOutbox } from '../../outbox.js'
import { billingError,newId,receipt,stableUuid } from './common.js'
import { custodyKey,seal,unseal } from './custody.js'
import { assertIntegrationDestination } from './destination.js'

type Out<N extends keyof typeof core.CALLABLE_SCHEMAS_FASE6>=core.CallableOutput<N>
const RECEIPT_TTL=86_400_000
const newSecret=()=>core.linkToken(randomBytes(32))
type Row={created_at:Date;id:string;[column:string]:any}
const iso=(value:Date|null)=>value===null?null:value.getTime()

async function memberLocations(client:PoolClient,rid:string,uid:string) {
  const {rows}=await client.query<{location_ids:string[]}>('SELECT location_ids FROM llenamos.memberships WHERE restaurant_id=$1 AND uid=$2 AND active',[rid,uid])
  if(!rows[0])throw new ApiError(403,'permission-denied','No tienes permiso para esta operación.')
  return rows[0].location_ids
}
/** Un encargado acotado a locales solo toca integraciones de esos locales; y el local debe existir. */
async function validateLocations(client:PoolClient,rid:string,allowed:string[],ids:string[]) {
  for(const lid of new Set(ids)) {
    if(allowed.length&&!allowed.includes(lid))throw new ApiError(403,'permission-denied','No tienes permiso para esta operación.')
    if(!(await client.query('SELECT 1 FROM llenamos.locations WHERE restaurant_id=$1 AND id=$2',[rid,lid])).rowCount)throw new ApiError(404,'not-found','No se encuentra uno de los locales.')
  }
}
/** Operaciones que devuelven un secreto: el recibo guarda la respuesta cifrada y caduca a las 24 horas. */
async function withSecretReceipt<N extends keyof typeof core.CALLABLE_SCHEMAS_FASE6>(client:PoolClient,name:N,rid:string,uid:string,input:{requestId:string},run:()=>Promise<Out<N>>):Promise<Out<N>> {
  const schema=core.CALLABLE_SCHEMAS_FASE6[name].output as unknown as z.ZodType<Out<N>>
  const prior=await receipt(client,rid,uid,name,input.requestId,input),context=`idempotency:${rid}:${uid}:${name}:${input.requestId}`
  if(prior.result) {
    const stored=prior.result as {sealed:string;expiresAt:number}
    if(stored.expiresAt<=Date.now())throw new ApiError(412,'failed-precondition','La respuesta ha caducado. Revisa el estado y revoca o rota el secreto perdido.')
    return schema.parse(unseal(stored.sealed,context))
  }
  const output=schema.parse(await run())
  await prior.save({sealed:seal(output,context),expiresAt:Date.now()+RECEIPT_TTL})
  return output
}

export async function createApiKey(client:PoolClient,data:unknown,context:{uid:string}) {
  const input=core.CrearClaveApiInputSchema.parse(data),rid=input.restaurantId
  try {
    custodyKey()
    const allowed=await memberLocations(client,rid,context.uid)
    return await withSecretReceipt(client,'crearClaveApi',rid,context.uid,input,async()=>{
      await validateLocations(client,rid,allowed,input.locationIds)
      if(input.expiresAt<=Date.now())throw new ApiError(400,'invalid-argument','La caducidad debe ser futura.')
      await client.query('SELECT llenamos.billing_capacity($1,$2,true)',[rid,'apiKeys'])
      const token=newSecret(),keyId=newId('key'),prefix=token.slice(0,8)
      // Solo el hash: el token se muestra una vez y no queda en ninguna tabla.
      await client.query('INSERT INTO llenamos.api_keys(restaurant_id,id,name,prefix,token_hash,scopes,location_ids,expires_at,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [rid,keyId,input.name,prefix,core.sha256Hex(token),input.scopes,[...new Set(input.locationIds)],new Date(input.expiresAt),context.uid])
      await emitEvent(client,{restaurantId:rid,topic:'plataforma.integracion',entityId:keyId,payload:{kind:'apiKey',action:'created'}})
      return {keyId,token,prefix}
    })
  }catch(error){return billingError(error)}
}

export async function revokeApiKey(client:PoolClient,data:unknown,context:{uid:string}) {
  const input=core.RevocarClaveApiInputSchema.parse(data),rid=input.restaurantId
  try {
    const prior=await receipt(client,rid,context.uid,'revocarClaveApi',input.requestId,input)
    if(prior.result)return core.RevocarClaveApiOutputSchema.parse(prior.result)
    const allowed=await memberLocations(client,rid,context.uid)
    const {rows}=await client.query<{location_ids:string[]}>('SELECT location_ids FROM llenamos.api_keys WHERE restaurant_id=$1 AND id=$2 FOR UPDATE',[rid,input.keyId])
    if(!rows[0])throw new ApiError(404,'not-found','No se encuentra la clave.')
    await validateLocations(client,rid,allowed,rows[0].location_ids)
    await client.query('UPDATE llenamos.api_keys SET revoked_at=now() WHERE restaurant_id=$1 AND id=$2 AND revoked_at IS NULL',[rid,input.keyId])
    await client.query('SELECT llenamos.billing_capacity($1,$2,false)',[rid,'apiKeys'])
    await emitEvent(client,{restaurantId:rid,topic:'plataforma.integracion',entityId:input.keyId,payload:{kind:'apiKey',action:'revoked'}})
    const result={ok:true as const}
    await prior.save(result)
    return result
  }catch(error){return billingError(error)}
}

interface Endpoint {id:string;url:string;events:string[];location_ids:string[];status:'active'|'suspended'|'revoked';secret_version:number;consecutive_failures:number}
async function loadEndpoint(client:PoolClient,rid:string,id:string):Promise<Endpoint|null> {
  return (await client.query<Endpoint>('SELECT id,url,events,location_ids,status,secret_version,consecutive_failures FROM llenamos.webhook_endpoints WHERE restaurant_id=$1 AND id=$2 FOR UPDATE',[rid,id])).rows[0]??null
}
async function storeSecret(client:PoolClient,rid:string,endpointId:string,version:number) {
  const secret=newSecret()
  await client.query('INSERT INTO llenamos.webhook_secrets(restaurant_id,endpoint_id,version,ciphertext) VALUES($1,$2,$3,$4)',[rid,endpointId,version,seal(secret,`webhook:${rid}:${endpointId}:${version}`)])
  return secret
}

/** Alta, edición y revocación de un destino. El secreto solo se devuelve al crearlo (y al rotarlo). */
export async function saveWebhook(client:PoolClient,data:unknown,context:{uid:string}) {
  const input=core.GuardarWebhookInputSchema.parse(data),rid=input.restaurantId
  try {
    custodyKey()
    if(input.status!=='revoked')await assertIntegrationDestination(input.url)
    const allowed=await memberLocations(client,rid,context.uid)
    return await withSecretReceipt(client,'guardarWebhook',rid,context.uid,input,async()=>{
      const endpointId=input.endpointId??newId('wh'),old=await loadEndpoint(client,rid,endpointId)
      if(input.endpointId&&!old)throw new ApiError(404,'not-found','No se encuentra el webhook.')
      if(!old&&input.status==='revoked')throw new ApiError(404,'not-found','No se encuentra el webhook que quieres revocar.')
      if(old)await validateLocations(client,rid,allowed,old.location_ids)
      if(old?.status==='revoked'&&input.status!=='revoked')throw new ApiError(412,'failed-precondition','Crea otro webhook para sustituir al revocado.')
      await validateLocations(client,rid,allowed,input.locationIds)
      if(!old)await client.query('SELECT llenamos.billing_capacity($1,$2,true)',[rid,'webhooks'])
      const version=old?old.secret_version:1
      if(!old) {
        await client.query('INSERT INTO llenamos.webhook_endpoints(restaurant_id,id,url,events,location_ids,status,secret_version) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [rid,endpointId,input.url,input.events,[...new Set(input.locationIds)],input.status,version])
        const secret=await storeSecret(client,rid,endpointId,version)
        await emitEvent(client,{restaurantId:rid,topic:'plataforma.integracion',entityId:endpointId,payload:{kind:'webhook',action:'created'}})
        return {endpointId,secret,secretVersion:version}
      }
      if(input.status==='revoked')await client.query("UPDATE llenamos.webhook_endpoints SET status='revoked',updated_at=now() WHERE restaurant_id=$1 AND id=$2",[rid,endpointId])
      else await client.query('UPDATE llenamos.webhook_endpoints SET url=$3,events=$4,location_ids=$5,status=$6,updated_at=now() WHERE restaurant_id=$1 AND id=$2',
        [rid,endpointId,input.url,input.events,[...new Set(input.locationIds)],input.status])
      await client.query('SELECT llenamos.billing_capacity($1,$2,false)',[rid,'webhooks'])
      await emitEvent(client,{restaurantId:rid,topic:'plataforma.integracion',entityId:endpointId,payload:{kind:'webhook',action:input.status==='revoked'?'revoked':'updated'}})
      return {endpointId,secret:null,secretVersion:version}
    })
  }catch(error){return billingError(error)}
}

export async function rotateWebhookSecret(client:PoolClient,data:unknown,context:{uid:string}) {
  const input=core.RotarSecretoWebhookInputSchema.parse(data),rid=input.restaurantId
  try {
    custodyKey()
    const allowed=await memberLocations(client,rid,context.uid)
    return await withSecretReceipt(client,'rotarSecretoWebhook',rid,context.uid,input,async()=>{
      const old=await loadEndpoint(client,rid,input.endpointId)
      if(!old)throw new ApiError(404,'not-found','No se encuentra el webhook.')
      await validateLocations(client,rid,allowed,old.location_ids)
      if(old.status==='revoked')throw new ApiError(412,'failed-precondition','Crea otro webhook para sustituir al revocado.')
      const version=old.secret_version+1,secret=await storeSecret(client,rid,old.id,version)
      await client.query('UPDATE llenamos.webhook_endpoints SET secret_version=$3,updated_at=now() WHERE restaurant_id=$1 AND id=$2',[rid,old.id,version])
      await emitEvent(client,{restaurantId:rid,topic:'plataforma.integracion',entityId:old.id,payload:{kind:'webhook',action:'rotated'}})
      return {secret,secretVersion:version}
    })
  }catch(error){return billingError(error)}
}

/** Repite una entrega agotada o entregada: nueva ronda, intentos a cero y un trabajo nuevo en la cola. */
export async function replayDelivery(client:PoolClient,data:unknown,context:{uid:string}) {
  const input=core.RepetirEntregaWebhookInputSchema.parse(data),rid=input.restaurantId
  try {
    const prior=await receipt(client,rid,context.uid,'repetirEntregaWebhook',input.requestId,input)
    if(prior.result)return core.RepetirEntregaWebhookOutputSchema.parse(prior.result)
    const allowed=await memberLocations(client,rid,context.uid)
    const {rows}=await client.query('SELECT status,round,endpoint_id FROM llenamos.webhook_deliveries WHERE restaurant_id=$1 AND id=$2 FOR UPDATE',[rid,input.deliveryId])
    if(!rows[0])throw new ApiError(404,'not-found','No se encuentra la entrega.')
    const endpoint=await loadEndpoint(client,rid,rows[0].endpoint_id)
    if(!endpoint||endpoint.status==='revoked')throw new ApiError(412,'failed-precondition','El webhook está revocado.')
    await validateLocations(client,rid,allowed,endpoint.location_ids)
    if(!['exhausted','delivered'].includes(rows[0].status))throw new ApiError(412,'failed-precondition','Espera a que termine la entrega antes de repetirla.')
    const round=rows[0].round+1
    await client.query("UPDATE llenamos.webhook_deliveries SET status='queued',attempts=0,round=$3,next_attempt_at=now(),lease_id=NULL,lease_until=NULL WHERE restaurant_id=$1 AND id=$2",[rid,input.deliveryId,round])
    await client.query("UPDATE llenamos.webhook_endpoints SET status='active',consecutive_failures=0,updated_at=now() WHERE restaurant_id=$1 AND id=$2",[rid,endpoint.id])
    await enqueueOutbox(client,{id:stableUuid('entrega',input.deliveryId,round,0),restaurantId:rid,kind:'plataforma.entrega',payload:{deliveryId:input.deliveryId,round,attempt:0}})
    await emitEvent(client,{restaurantId:rid,topic:'plataforma.integracion',entityId:input.deliveryId,payload:{kind:'delivery',action:'replayed'}})
    const result={deliveryId:input.deliveryId,status:'queued' as const}
    await prior.save(result)
    return result
  }catch(error){return billingError(error)}
}

// --- Lista con cursor por sección -----------------------------------------------------------------------------
const Position=z.tuple([z.string(),z.string()]).nullable()
const Cursor=z.object({keys:Position.optional(),endpoints:Position.optional(),deliveries:Position.optional()})
type Position_=z.infer<typeof Position>|undefined
function decodeCursor(raw:string|null) {
  if(!raw)return {} as z.infer<typeof Cursor>
  try {return Cursor.parse(JSON.parse(Buffer.from(raw,'base64url').toString('utf8')))}
  catch{throw new ApiError(400,'invalid-argument','El cursor no es válido.')}
}
export async function listIntegrations(client:PoolClient,data:unknown,context:{uid:string}) {
  const input=core.ListarIntegracionesInputSchema.parse(data),rid=input.restaurantId
  try {
    const allowed=await memberLocations(client,rid,context.uid),cursor=decodeCursor(input.cursor),next:z.infer<typeof Cursor>={}
    const limit=input.limit
    async function page<T extends {created_at:Date;id:string}>(name:keyof typeof next,sql:string,position:Position_,extra:unknown[]):Promise<T[]> {
      if(position===null)return []
      const params=[rid,limit+1,...extra,...(position?[position[0],position[1]]:[])]
      const {rows}=await client.query<T>(sql.replace('$AFTER',position?`AND (created_at,id)<($${extra.length+3}::timestamptz,$${extra.length+4})`:''),params)
      const shown=rows.slice(0,limit)
      next[name]=rows.length>limit?[shown.at(-1)!.created_at.toISOString(),shown.at(-1)!.id]:null
      return shown
    }
    const scope=allowed.length?'AND location_ids <@ $3::text[]':'',extra=allowed.length?[allowed]:[]
    const keys=await page<Row>('keys',`SELECT id,name,prefix,scopes,location_ids,expires_at,revoked_at,last_used_at,created_at FROM llenamos.api_keys WHERE restaurant_id=$1 ${scope} $AFTER ORDER BY created_at DESC,id DESC LIMIT $2`,cursor.keys,extra)
    const endpoints=await page<Row>('endpoints',`SELECT id,url,events,location_ids,status,secret_version,consecutive_failures,created_at FROM llenamos.webhook_endpoints WHERE restaurant_id=$1 ${scope} $AFTER ORDER BY created_at DESC,id DESC LIMIT $2`,cursor.endpoints,extra)
    const deliveries=await page<Row>('deliveries',`SELECT id,endpoint_id,event_id,status,attempts,next_attempt_at,last_status,last_error,last_attempt_at,created_at FROM llenamos.webhook_deliveries WHERE restaurant_id=$1 ${allowed.length?'AND event->>\'locationId\' = ANY($3::text[])':''} $AFTER ORDER BY created_at DESC,id DESC LIMIT $2`,cursor.deliveries,extra)
    const health=await client.query<{last:Date|null}>('SELECT max(created_at) AS last FROM llenamos.webhook_attempts WHERE restaurant_id=$1',[rid])
    const more=Object.values(next).some(position=>position!==null&&position!==undefined)
    return core.ListarIntegracionesOutputSchema.parse({
      keys:keys.map(k=>({id:k.id,name:k.name,prefix:k.prefix,scopes:k.scopes,locationIds:k.location_ids,expiresAt:k.expires_at.getTime(),revokedAt:iso(k.revoked_at),lastUsedAt:iso(k.last_used_at)})),
      endpoints:endpoints.map(e=>({id:e.id,url:e.url,events:e.events,locationIds:e.location_ids,status:e.status,secretVersion:e.secret_version,consecutiveFailures:e.consecutive_failures})),
      deliveries:deliveries.map(d=>({id:d.id,endpointId:d.endpoint_id,eventId:d.event_id,status:d.status,attempts:d.attempts,nextAttemptAt:d.next_attempt_at.getTime(),lastStatus:d.last_status,lastError:d.last_error,lastAttemptAt:iso(d.last_attempt_at)})),
      nextCursor:more?Buffer.from(JSON.stringify(next)).toString('base64url'):null,workerLastRunAt:iso(health.rows[0]!.last),
    })
  }catch(error){return billingError(error)}
}
