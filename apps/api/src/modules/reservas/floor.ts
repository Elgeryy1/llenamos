import type { PoolClient } from 'pg'
import type { z } from 'zod'
import * as core from '@llenamos/core'
import { ApiError } from '../../errors.js'
import type { Operation } from '../../operations.js'
import { failure,notFound } from './scope.js'
import { lockLocation,reservationEvent } from './store.js'
import { staffTenant } from './staff.js'

const schemas=core.CALLABLE_SCHEMAS
const rolesFor=(permission:core.Permission)=>core.ROLES.filter(role=>core.can(role,permission))
type PlanoInput=z.output<typeof core.GuardarPlanoInputSchema>

/** Guarda el plano en una sola transacción: o entra todo o nada (antes eran tres lotes sueltos). */
export async function savePlano(client:PoolClient,uid:string,d:PlanoInput) {
  const {restaurantId:rid,locationId:lid}=d
  const tenant=await staffTenant(client,uid,rid,lid,'plano.editar')
  void tenant
  await lockLocation(client,rid,lid)
  const area=async(id:string)=>(await client.query<{data:unknown}>('SELECT data FROM llenamos.dining_areas WHERE restaurant_id=$1 AND location_id=$2 AND id=$3 FOR UPDATE',[rid,lid,id])).rows[0]
  for(const {id,...data} of d.createAreas)
    await client.query('INSERT INTO llenamos.dining_areas(restaurant_id,location_id,id,data,updated_by) VALUES($1,$2,$3,$4,$5)',[rid,lid,id,JSON.stringify(core.AreaSchema.parse(data)),uid])
  for(const {id,...patch} of d.updateAreas) {
    const row=await area(id)
    if(!row)return notFound('No se encuentra la zona.')
    const next=core.AreaSchema.parse({...(row.data as object),...patch})
    await client.query('UPDATE llenamos.dining_areas SET data=$4,updated_at=now(),updated_by=$5 WHERE restaurant_id=$1 AND location_id=$2 AND id=$3',[rid,lid,id,JSON.stringify(next),uid])
  }
  for(const {id,...data} of d.createTables) {
    const parsed=core.TableSchema.parse(data)
    await client.query('INSERT INTO llenamos.dining_tables(restaurant_id,location_id,id,area_id,data,updated_by) VALUES($1,$2,$3,$4,$5,$6)',[rid,lid,id,parsed.areaId,JSON.stringify(parsed),uid])
  }
  for(const {id,...patch} of d.updateTables) {
    const {rows}=await client.query<{data:unknown}>('SELECT data FROM llenamos.dining_tables WHERE restaurant_id=$1 AND location_id=$2 AND id=$3 FOR UPDATE',[rid,lid,id])
    if(!rows[0])return notFound('No se encuentra la mesa.')
    const next=core.TableSchema.parse({...(rows[0].data as object),...patch})
    await client.query('UPDATE llenamos.dining_tables SET area_id=$4,data=$5,updated_at=now(),updated_by=$6 WHERE restaurant_id=$1 AND location_id=$2 AND id=$3',[rid,lid,id,next.areaId,JSON.stringify(next),uid])
  }
  if(d.deleteTables.length) {
    // Con el bloqueo del local (sala toma el mismo antes de abrir o mover mesas) nadie abre una sesión entre la comprobación y el borrado.
    const busy=await client.query(`SELECT 1 FROM llenamos.sala_table_sessions WHERE restaurant_id=$1 AND location_id=$2 AND status IN ('open','bill_requested') AND jsonb_exists_any(doc->'tableIds',$3::text[]) LIMIT 1`,[rid,lid,d.deleteTables])
    if(busy.rowCount)failure('No se puede borrar una mesa con una sesión abierta o con la cuenta pedida. Cierra antes la mesa en sala.')
  }
  if(d.deleteTables.length)await client.query('DELETE FROM llenamos.dining_tables WHERE restaurant_id=$1 AND location_id=$2 AND id=ANY($3)',[rid,lid,d.deleteTables])
  if(d.deleteAreas.length) {
    const used=await client.query('SELECT 1 FROM llenamos.dining_tables WHERE restaurant_id=$1 AND location_id=$2 AND area_id=ANY($3) LIMIT 1',[rid,lid,d.deleteAreas])
    if(used.rowCount)failure('No se puede borrar una zona que aún tiene mesas.')
    await client.query('DELETE FROM llenamos.dining_areas WHERE restaurant_id=$1 AND location_id=$2 AND id=ANY($3)',[rid,lid,d.deleteAreas])
  }
  await reservationEvent(client,rid,lid,lid,'plano','ok','reservas.plano')
  return {ok:true as const}
}
export async function editCustomer(client:PoolClient,uid:string,d:z.output<typeof core.EditarClienteInputSchema>) {
  const m=await client.query<{role:core.Role}>('SELECT role FROM llenamos.memberships WHERE uid=$1 AND restaurant_id=$2 AND active',[uid,d.restaurantId])
  if(!m.rows[0]||!core.can(m.rows[0].role,'clientes.editar'))throw new ApiError(403,'permission-denied','No tienes permiso para editar clientes.')
  const {rows}=await client.query<{data:unknown}>('SELECT data FROM llenamos.customers WHERE restaurant_id=$1 AND id=$2 FOR UPDATE',[d.restaurantId,d.customerId])
  if(!rows[0])return notFound('No se encuentra el cliente.')
  const next=core.CustomerSchema.parse({...(rows[0].data as object),notes:d.notes,allergies:d.allergies,tags:d.tags,updatedBy:uid})
  await client.query('UPDATE llenamos.customers SET data=$3,updated_at=now(),updated_by=$4 WHERE restaurant_id=$1 AND id=$2',[d.restaurantId,d.customerId,JSON.stringify(next),uid])
  await client.query(`INSERT INTO llenamos.events(restaurant_id,topic,entity_id,payload) VALUES($1,'reservas.cliente',$2,'{"action":"edited"}')`,[d.restaurantId,d.customerId])
  return {ok:true as const}
}
const rid=(input:unknown)=>(input as {restaurantId:string}).restaurantId
export const floorOperations:ReadonlyArray<readonly [string,Operation]>=[
  ['guardarPlano',{access:'member',roles:rolesFor('plano.editar'),restaurantId:rid,input:schemas.guardarPlano.input,output:schemas.guardarPlano.output,run:(client,d,context)=>savePlano(client,context.uid,d as PlanoInput)}],
  ['editarCliente',{access:'member',roles:rolesFor('clientes.editar'),restaurantId:rid,input:schemas.editarCliente.input,output:schemas.editarCliente.output,run:(client,d,context)=>editCustomer(client,context.uid,d as z.output<typeof core.EditarClienteInputSchema>)}],
]
