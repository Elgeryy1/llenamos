import type { PoolClient } from 'pg'
import * as core from '@llenamos/core'
import { emitEvent } from '../../events.js'
import { updateOriginOutcome } from '../campanas/origen.js'
import { enqueuePlatformEvent,platformEventId } from '../plataforma/eventos.js'

const ms=(value:Date|string|number)=>value instanceof Date?value.getTime():Number(new Date(value))
const HOUR=3_600_000
/** Estados que cuentan para capacidad (cancelada y no presentada quedan fuera). */
const COUNTING=['pending','confirmed','seated','finished']

export interface Inventory {
  settings:core.ReservationSettings
  saved:boolean
  tables:core.MesaMotor[]
  reservations:core.ReservationWithId[]
  waiting:Array<core.WaitlistEntry&{id:string}>
}

/** Serializa toda escritura que afecta al aforo del local: dos peticiones no ven nunca el mismo hueco libre. */
export async function lockLocation(client:PoolClient,rid:string,lid:string) {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`reservas:${rid}:${lid}`])
}
export async function readSettings(client:PoolClient,rid:string,lid:string,timezone:string) {
  const {rows}=await client.query<{data:unknown}>('SELECT data FROM llenamos.reservation_settings WHERE restaurant_id=$1 AND location_id=$2',[rid,lid])
  return rows[0]?{settings:core.ReservationSettingsSchema.parse(rows[0].data),saved:true}:{settings:core.defaultReservationSettings(timezone),saved:false}
}
export async function readTables(client:PoolClient,rid:string,lid:string) {
  const {rows}=await client.query<{id:string;data:unknown}>('SELECT id,data FROM llenamos.dining_tables WHERE restaurant_id=$1 AND location_id=$2 ORDER BY id',[rid,lid])
  return rows.map(row=>core.tableToMesa(row.id,core.TableSchema.parse(row.data)))
}
export function toReservation(row:{id:string;data:unknown}):core.ReservationWithId {
  return {id:row.id,...core.ReservationSchema.parse(row.data)}
}
/**
 * Reservas que pueden afectar a los instantes pedidos. Doble acotación por `start_at`: el rango total (mínimo y máximo de
 * los instantes ±48 h, para el índice por local y día) y las ventanas de cada instante (no el hueco entre ellos).
 */
export const READ_WINDOW_SQL=`SELECT id,data FROM llenamos.reservations r WHERE restaurant_id=$1 AND location_id=$2 AND status=ANY($3) AND NOT privacy_redacted
       AND r.start_at >= $6 AND r.start_at < $7
       AND EXISTS(SELECT 1 FROM unnest($4::timestamptz[],$5::timestamptz[]) w(f,t) WHERE r.start_at>=w.f AND r.start_at<w.t) ORDER BY start_at,id`
export const readWindowParams=(rid:string,lid:string,focus:readonly number[])=>{
  const ranges=focus.flatMap(f=>[new Date(f-48*HOUR),new Date(f+48*HOUR)])
  return [rid,lid,COUNTING,ranges.filter((_,i)=>i%2===0),ranges.filter((_,i)=>i%2===1),new Date(Math.min(...focus)-48*HOUR),new Date(Math.max(...focus)+48*HOUR)]
}
export async function readWindow(client:PoolClient,rid:string,lid:string,focus:readonly number[]) {
  if(!focus.length)return []
  const {rows}=await client.query<{id:string;data:unknown}>(READ_WINDOW_SQL,readWindowParams(rid,lid,focus))
  return rows.map(toReservation)
}
export async function readOffers(client:PoolClient,rid:string,lid:string,now:number,exclude?:string) {
  const {rows}=await client.query<{id:string;data:unknown}>(
    `SELECT id,data FROM llenamos.waitlist WHERE restaurant_id=$1 AND location_id=$2 AND status='offered' AND offer_expires_at>$3 ORDER BY created_at,id`,[rid,lid,new Date(now)])
  return rows.filter(row=>row.id!==exclude).map(row=>({id:row.id,...core.WaitlistEntrySchema.parse(row.data)}))
}
export async function readReservation(client:PoolClient,rid:string,lid:string,id:string,forUpdate=false) {
  const {rows}=await client.query<{id:string;data:unknown}>(`SELECT id,data FROM llenamos.reservations WHERE restaurant_id=$1 AND location_id=$2 AND id=$3 AND NOT privacy_redacted${forUpdate?' FOR UPDATE':''}`,[rid,lid,id])
  return rows[0]?toReservation(rows[0]):null
}

export async function insertReservation(client:PoolClient,rid:string,lid:string,id:string,r:core.Reservation,actor:string|null) {
  await client.query(
    `INSERT INTO llenamos.reservations(restaurant_id,location_id,id,customer_id,reference,start_at,status,table_ids,manage_token_hash,data,updated_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [rid,lid,id,r.customerId,r.reference,new Date(r.startAt),r.status,r.tableIds,r.manageTokenHash,JSON.stringify(core.ReservationSchema.parse(r)),actor])
}
export async function updateReservation(client:PoolClient,rid:string,lid:string,id:string,r:core.Reservation,actor:string|null) {
  await client.query(
    `UPDATE llenamos.reservations SET customer_id=$4,start_at=$5,status=$6,table_ids=$7,data=$8,updated_by=$9,updated_at=now() WHERE restaurant_id=$1 AND location_id=$2 AND id=$3`,
    [rid,lid,id,r.customerId,new Date(r.startAt),r.status,r.tableIds,JSON.stringify(core.ReservationSchema.parse(r)),actor])
}

/**
 * Recalcula la ficha del cliente con un agregado indexado por (restaurante, cliente):
 * sustituye al disparador `reservationChanged` y corre en la misma transacción que el cambio.
 */
export async function syncCustomer(client:PoolClient,rid:string,r:core.Reservation) {
  const old=await client.query<{data:unknown}>('SELECT data FROM llenamos.customers WHERE restaurant_id=$1 AND id=$2 FOR UPDATE',[rid,r.customerId])
  const agg=await client.query<{visits:string;no_shows:string;cancellations:string;last_visit:Date|null}>(
    `SELECT count(*) FILTER(WHERE status IN ('seated','finished')) AS visits,count(*) FILTER(WHERE status='no_show') AS no_shows,
      count(*) FILTER(WHERE status='cancelled') AS cancellations,max(start_at) FILTER(WHERE status IN ('seated','finished')) AS last_visit
     FROM llenamos.reservations WHERE restaurant_id=$1 AND customer_id=$2 AND NOT privacy_redacted`,[rid,r.customerId])
  const a=agg.rows[0]!
  const customer=core.CustomerSchema.parse({name:r.guestName,phone:r.phone,email:r.email,language:r.language,notes:'',allergies:'',tags:[],
    ...((old.rows[0]?.data as {privacyRedacted?:boolean}|undefined)?.privacyRedacted?undefined:old.rows[0]?.data as object|undefined),visits:Number(a.visits),noShows:Number(a.no_shows),cancellations:Number(a.cancellations),lastVisitAt:a.last_visit?ms(a.last_visit):null})
  await client.query(
    `INSERT INTO llenamos.customers(restaurant_id,id,data) VALUES($1,$2,$3) ON CONFLICT(restaurant_id,id) DO UPDATE SET data=EXCLUDED.data,updated_at=now()`,
    [rid,r.customerId,JSON.stringify(customer)])
}

/** Evento de tiempo real sin datos personales: solo qué cambió y dónde. */
export async function reservationEvent(client:PoolClient,rid:string,lid:string,id:string,action:string,status:string,topic='reservas.reserva') {
  await emitEvent(client,{restaurantId:rid,locationId:lid,topic,entityId:id,payload:{action,status}})
}

/**
 * Evento de plataforma (webhooks salientes) en la misma transacción que el hecho. Id determinista por reserva, tipo y
 * decisión (`discriminator`): repetir el mismo hecho no duplica entregas. Solo referencia y estado, sin datos personales.
 */
export async function reservationPlatformEvent(client:PoolClient,rid:string,lid:string,id:string,type:'reservation.created'|'reservation.statusChanged',status:string,discriminator:string|number) {
  await enqueuePlatformEvent(client,{id:platformEventId(type,rid,lid,id,discriminator),type,restaurantId:rid,locationId:lid,data:{entityId:id,status}})
}

/**
 * Estado final de la reserva en su origen (informe de origen). El personal pasa por `updateOriginOutcome` de campañas;
 * las rutas públicas no leen orígenes, así que ahí actúa una función estrecha de solo ese campo.
 */
export async function recordOriginStatus(client:PoolClient,rid:string,id:string,status:core.ReservationStatus) {
  if(!(await updateOriginOutcome(client,rid,id,{status})))await client.query('SELECT llenamos.reservas_origin_outcome($1,$2,$3)',[rid,id,status])
}
