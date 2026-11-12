import { randomBytes } from 'node:crypto'
import type { PoolClient } from 'pg'
import * as core from '@llenamos/core'
import { ApiError } from '../../errors.js'
import { billingError,hash } from './common.js'

type Row=Record<string,any>
const usage=(row:Row,now:number)=>core.UsageSnapshotSchema.parse({
  restaurantId:row.restaurant_id,name:row.name,planId:row.plan_id,status:row.status,locations:Number(row.locations),members:Number(row.members),
  apiKeys:Number(row.api_keys),webhooks:Number(row.webhooks),
  // La cola sin conexión vive en la tablet hasta que el servicio de sincronización (V1) aporte su tabla: no se mide aún.
  pendingCommands:0,failedDeliveries:Number(row.failed_deliveries),measuredAt:now,
  activeModules:row.active_modules,moduleOverrides:row.module_overrides,legacyPlan:row.legacy_plan,platformRevision:row.revision??null,
})
/** Medición real hecha por SQL en el momento de la petición; no se guarda caché que pueda desactualizarse. */
export async function restaurantUsage(client:PoolClient,data:unknown) {
  const input=core.VerUsoPlataformaInputSchema.parse(data)
  try {
    const {rows}=await client.query('SELECT * FROM llenamos.billing_usage($1,NULL,1,NULL)',[input.restaurantId])
    if(!rows[0])throw new ApiError(404,'not-found','No se encuentra el restaurante.')
    return usage(rows[0],Date.now())
  }catch(error){return billingError(error)}
}
/** Equipo de plataforma: solo contadores y estado del plan, nunca datos operativos. Paginado por restaurante. */
export async function platformUsageList(client:PoolClient,data:unknown) {
  const input=core.ListarRestaurantesLogiqdInputSchema.parse(data)
  try {
    let after:string|null=null
    if(input.cursor) {
      try {after=Buffer.from(input.cursor,'base64url').toString('utf8')}catch{/* se rechaza abajo */}
      if(!after||!core.DocIdSchema.safeParse(after).success)throw new ApiError(400,'invalid-argument','El cursor no es válido.')
    }
    const {rows}=await client.query('SELECT * FROM llenamos.billing_usage(NULL,$1,$2,$3)',[after,input.limit+1,input.status==='all'?null:input.status])
    const shown=rows.slice(0,input.limit),now=Date.now()
    return {restaurants:shown.map(row=>usage(row,now)),nextCursor:rows.length>input.limit?Buffer.from(shown.at(-1)!.restaurant_id).toString('base64url'):null}
  }catch(error){return billingError(error)}
}
/** Deja constancia de una apertura de soporte con caducidad. No concede lectura del interior del restaurante. */
export async function openSupportAccess(client:PoolClient,data:unknown) {
  const input=core.AbrirAccesoSoporteInputSchema.parse(data)
  try {
    const request=hash(input),key=hash([input.restaurantId,input.requestId])
    const prior=(await client.query('SELECT llenamos.platform_request($1,$2,$3) AS receipt',['abrirAccesoSoporte',key,request])).rows[0].receipt
    if(prior)return core.AbrirAccesoSoporteOutputSchema.parse(prior)
    const id=`soporte_${randomBytes(12).toString('hex')}`
    const expires=(await client.query<{expires:Date}>('SELECT llenamos.billing_support_open($1,$2,$3,$4) AS expires',[input.restaurantId,id,input.reason,input.durationMinutes])).rows[0]!.expires
    const result={supportAccessId:id,expiresAt:expires.getTime()}
    await client.query('SELECT llenamos.platform_request($1,$2,$3,$4)',['abrirAccesoSoporte',key,request,JSON.stringify(result)])
    return result
  }catch(error){return billingError(error)}
}
