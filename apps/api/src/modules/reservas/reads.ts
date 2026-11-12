import type { PoolClient } from 'pg'
import { z } from 'zod'
import * as core from '@llenamos/core'
import { ApiError } from '../../errors.js'
import type { LiveQuery } from '../types.js'
import { resolveTenantById } from './scope.js'
import { readSettings } from './store.js'

const Doc=core.DocIdSchema
const roles=(permission:core.Permission)=>core.ROLES.filter(role=>core.can(role,permission))
const ReservationDoc=core.ReservationSchema.extend({id:Doc})
const WaitlistDoc=core.WaitlistEntrySchema.extend({id:Doc})
const CustomerDoc=core.CustomerSchema.extend({id:Doc})
const Local=z.strictObject({restaurantId:Doc,locationId:Doc})
const rid=(input:unknown)=>(input as {restaurantId:string}).restaurantId

/** Un miembro con locales asignados solo lee esos locales. */
async function assertLocation(client:PoolClient,uid:string,restaurantId:string,locationId:string) {
  const {rows}=await client.query<{location_ids:string[]}>('SELECT location_ids FROM llenamos.memberships WHERE uid=$1 AND restaurant_id=$2 AND active',[uid,restaurantId])
  if(!rows[0]||(rows[0].location_ids.length&&!rows[0].location_ids.includes(locationId)))throw new ApiError(403,'permission-denied','No tienes acceso a este local.')
}
async function timezone(client:PoolClient,restaurantId:string,locationId:string) {
  const {rows}=await client.query<{timezone:string}>('SELECT r.timezone FROM llenamos.restaurants r JOIN llenamos.locations l ON l.restaurant_id=r.id WHERE r.id=$1 AND l.id=$2',[restaurantId,locationId])
  if(!rows[0])throw new ApiError(404,'not-found','No se encuentra el local.')
  return rows[0].timezone
}
/** 00:00 del día hasta 00:00 de dos días después (turnos que cruzan la medianoche); mismo criterio que el panel. */
function dayWindow(date:string,tz:string) {
  const from=core.instanteDeHoraLocal(date,0,tz)??Date.parse(`${date}T00:00:00Z`)
  const end=core.sumarDias(date,2),to=core.instanteDeHoraLocal(end,0,tz)??Date.parse(`${end}T00:00:00Z`)
  return {from:new Date(from),to:new Date(to)}
}
const reservationTopics=()=>['reservas.reserva']
export const CUSTOMERS_PAGE=1000

const base:ReadonlyArray<LiveQuery>=[
  {name:'reservasDia',roles:roles('reservas.ver'),input:Local.extend({date:core.FechaSchema}),output:z.object({reservations:z.array(ReservationDoc)}),restaurantId:rid,topics:reservationTopics,
    snapshot:async(client,raw,{uid})=>{
      const d=raw as {restaurantId:string;locationId:string;date:string}
      await assertLocation(client,uid,d.restaurantId,d.locationId)
      const {from,to}=dayWindow(d.date,await timezone(client,d.restaurantId,d.locationId))
      const {rows}=await client.query<{id:string;data:unknown}>(
        'SELECT id,data FROM llenamos.reservations WHERE restaurant_id=$1 AND location_id=$2 AND start_at>=$3 AND start_at<$4 AND NOT privacy_redacted ORDER BY start_at,id LIMIT 2000',[d.restaurantId,d.locationId,from,to])
      return {reservations:rows.map(row=>({id:row.id,...core.ReservationSchema.parse(row.data)}))}
    }},
  {name:'ajustesReservas',roles:roles('reservas.ver'),input:Local,output:z.object({settings:core.ReservationSettingsSchema,saved:z.boolean()}),restaurantId:rid,topics:()=>['reservas.ajustes'],
    snapshot:async(client,raw,{uid})=>{
      const d=raw as {restaurantId:string;locationId:string}
      await assertLocation(client,uid,d.restaurantId,d.locationId)
      return readSettings(client,d.restaurantId,d.locationId,await timezone(client,d.restaurantId,d.locationId))
    }},
  {name:'listaEsperaDia',roles:roles('reservas.ver'),input:Local.extend({date:core.FechaSchema}),output:z.object({entries:z.array(WaitlistDoc)}),restaurantId:rid,topics:()=>['reservas.espera'],
    snapshot:async(client,raw,{uid})=>{
      const d=raw as {restaurantId:string;locationId:string;date:string}
      await assertLocation(client,uid,d.restaurantId,d.locationId)
      const {rows}=await client.query<{id:string;data:unknown}>('SELECT id,data FROM llenamos.waitlist WHERE restaurant_id=$1 AND location_id=$2 AND service_date=$3 ORDER BY created_at,id LIMIT 500',[d.restaurantId,d.locationId,d.date])
      return {entries:rows.map(row=>({id:row.id,...core.WaitlistEntrySchema.parse(row.data)}))}
    }},
  {name:'plano',roles:[...new Set([...roles('sala.ver'),...roles('cocina.ver'),...roles('barra.ver')])],input:Local,output:z.object({areas:z.array(core.AreaSchema.extend({id:Doc})),tables:z.array(core.TableSchema.extend({id:Doc}))}),restaurantId:rid,topics:()=>['reservas.plano'],
    snapshot:async(client,raw,{uid})=>{
      const d=raw as {restaurantId:string;locationId:string}
      await assertLocation(client,uid,d.restaurantId,d.locationId)
      const [areas,tables]=await Promise.all([
        client.query<{id:string;data:unknown}>('SELECT id,data FROM llenamos.dining_areas WHERE restaurant_id=$1 AND location_id=$2 ORDER BY id',[d.restaurantId,d.locationId]),
        client.query<{id:string;data:unknown}>('SELECT id,data FROM llenamos.dining_tables WHERE restaurant_id=$1 AND location_id=$2 ORDER BY id',[d.restaurantId,d.locationId])])
      return {areas:areas.rows.map(row=>({id:row.id,...core.AreaSchema.parse(row.data)})),tables:tables.rows.map(row=>({id:row.id,...core.TableSchema.parse(row.data)}))}
    }},
  {name:'clientes',roles:roles('clientes.ver'),input:z.strictObject({restaurantId:Doc,search:z.string().trim().max(80).optional(),limit:z.number().int().min(1).max(CUSTOMERS_PAGE).default(CUSTOMERS_PAGE),
      after:z.strictObject({name:z.string().max(80),id:core.CustomerIdSchema}).optional()}),
    output:z.object({customers:z.array(CustomerDoc),nextCursor:z.strictObject({name:z.string(),id:z.string()}).nullable()}),restaurantId:rid,topics:()=>['reservas.cliente','reservas.reserva'],
    snapshot:async(client,raw)=>{
      const d=raw as {restaurantId:string;search?:string;limit:number;after?:{name:string;id:string}}
      const pattern=d.search?`%${d.search.replace(/[\\%_]/g,'\\$&')}%`:null
      // Paginación por cursor (nombre, id) con el índice customers_name; la búsqueda filtra sobre esa misma página ordenada.
      const {rows}=await client.query<{id:string;data:unknown}>(
        `SELECT id,data FROM llenamos.customers WHERE restaurant_id=$1 AND ($2::text IS NULL OR data->>'name' ILIKE $2 OR data->>'phone' LIKE $2 OR data->>'email' ILIKE $2)
           AND ($3::text IS NULL OR (data->>'name',id)>($3,$4)) ORDER BY data->>'name',id LIMIT $5`,[d.restaurantId,pattern,d.after?.name??null,d.after?.id??null,d.limit+1])
      const page=rows.slice(0,d.limit).map(row=>({id:row.id,...core.CustomerSchema.parse(row.data)}))
      const last=page.at(-1)
      return {customers:page,nextCursor:rows.length>d.limit&&last?{name:last.name,id:last.id}:null}
    }},
  {name:'cliente',roles:roles('clientes.ver'),input:z.strictObject({restaurantId:Doc,customerId:core.CustomerIdSchema}),output:z.object({customer:CustomerDoc.nullable()}),restaurantId:rid,topics:()=>['reservas.cliente','reservas.reserva'],
    snapshot:async(client,raw)=>{
      const d=raw as {restaurantId:string;customerId:string}
      const {rows}=await client.query<{id:string;data:unknown}>('SELECT id,data FROM llenamos.customers WHERE restaurant_id=$1 AND id=$2',[d.restaurantId,d.customerId])
      return {customer:rows[0]?{id:rows[0].id,...core.CustomerSchema.parse(rows[0].data)}:null}
    }},
  {name:'reservasCliente',roles:roles('clientes.ver'),input:Local.extend({customerId:core.CustomerIdSchema,limit:z.number().int().min(1).max(100).default(20)}),output:z.object({reservations:z.array(ReservationDoc)}),restaurantId:rid,topics:reservationTopics,
    snapshot:async(client,raw,{uid})=>{
      const d=raw as {restaurantId:string;locationId:string;customerId:string;limit:number}
      await assertLocation(client,uid,d.restaurantId,d.locationId)
      const {rows}=await client.query<{id:string;data:unknown}>(
        'SELECT id,data FROM llenamos.reservations WHERE restaurant_id=$1 AND location_id=$2 AND customer_id=$3 AND NOT privacy_redacted ORDER BY start_at DESC LIMIT $4',[d.restaurantId,d.locationId,d.customerId,d.limit])
      return {reservations:rows.map(row=>({id:row.id,...core.ReservationSchema.parse(row.data)}))}
    }},
]

/** Toda lectura exige el módulo de reservas activo (la de plano también vale con sala), como las reglas `bookingStaff`. */
async function assertModule(client:PoolClient,restaurantId:string,alsoFloor:boolean) {
  const tenant=await resolveTenantById(client,restaurantId,'')
  if(!core.hasModule(tenant.restaurant,'reservations')&&!(alsoFloor&&core.hasModule(tenant.restaurant,'floor')))
    throw new ApiError(412,'failed-precondition','El módulo de reservas está desactivado.')
}
export const reservasLiveQueries:ReadonlyArray<LiveQuery>=base.map(query=>({...query,snapshot:async(client,input,context)=>{
  await assertModule(client,query.restaurantId(input),query.name==='plano')
  return query.snapshot(client,input,context)
}}))
