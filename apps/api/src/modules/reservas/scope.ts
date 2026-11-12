import { randomUUID } from 'node:crypto'
import type { Pool,PoolClient } from 'pg'
import * as core from '@llenamos/core'
import { ApiError } from '../../errors.js'

export const failure=(message:string):never=>{throw new ApiError(412,'failed-precondition',message)}
export const notFound=(message:string):never=>{throw new ApiError(404,'not-found',message)}
export const newId=()=>randomUUID().replaceAll('-','').slice(0,20)

/** Lo mínimo del restaurante que cualquier operación de reservas necesita. */
export interface Tenant {
  rid:string;name:string;slug:string;timezone:string;stripe:boolean
  restaurant:core.RestaurantModulesLike
  locationName:string
}

/** Ámbito público: RLS solo deja ver el restaurante resuelto por slug y nada más. Una sola transacción. */
export async function withPublicScope<T>(pool:Pool,rid:string,work:(client:PoolClient)=>Promise<T>):Promise<T> {
  const client=await pool.connect()
  let broken=false
  try {
    await client.query('BEGIN')
    await client.query("SELECT set_config('app.actor_uid','',true),set_config('app.platform','false',true),set_config('app.restaurant_id','',true),set_config('app.public_restaurant',$1,true)",[rid])
    const result=await work(client)
    await client.query('COMMIT')
    return result
  } catch(error) {
    try{await client.query('ROLLBACK')}catch{broken=true}
    throw error
  } finally {client.release(broken)}
}

interface ResolvedRow {
  restaurantId:string;name:string;slug:string;timezone:string;locale:string;plan:string;activeModules:string[];moduleOverrides:Record<string,boolean>
  entitlementVersion:number|null;accessOk:boolean;accessValidUntil:number|null;locationId:string|null;locationName:string|null;stripe:boolean
}
/** Slug + local -> inquilino. Usa un procedimiento estrecho: no abre lectura pública de tablas privadas. */
export async function resolvePublicTenant(pool:Pick<Pool,'query'>,slug:string,locationId:string):Promise<Tenant> {
  return resolveTenant(pool,null,slug,locationId)
}
/** Para webhooks y trabajos, que conocen el ID del restaurante y no su slug. */
export async function resolveTenantById(pool:Pick<Pool,'query'>,rid:string,locationId:string):Promise<Tenant> {
  return resolveTenant(pool,rid,null,locationId)
}
async function resolveTenant(pool:Pick<Pool,'query'>,rid:string|null,slug:string|null,locationId:string):Promise<Tenant> {
  const {rows}=await pool.query<{r:ResolvedRow|null}>('SELECT llenamos.reservas_public_resolve($1,$2,$3) AS r',[rid,slug,locationId||null])
  const r=rows[0]?.r
  if(!r)throw new ApiError(404,'not-found','No se encuentra el restaurante.')
  if(locationId&&!r.locationId)throw new ApiError(404,'not-found','No se encuentra el local.')
  if(!r.accessOk)failure('El restaurante no admite reservas ahora mismo.')
  const restaurant={plan:r.plan as core.Plan,activeModules:r.activeModules as core.Module[],moduleOverrides:r.moduleOverrides,entitlementVersion:r.entitlementVersion,...(r.accessValidUntil!==null?{accessValidUntil:r.accessValidUntil}:{})}
  return {rid:r.restaurantId,name:r.name,slug:r.slug,timezone:r.timezone,stripe:r.stripe,restaurant,locationName:r.locationName??''}
}
