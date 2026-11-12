import type { PoolClient } from 'pg'
import * as core from '@llenamos/core'
import { failure,type Tenant } from './scope.js'
import { lockLocation,readOffers,readSettings,readTables,readWindow } from './store.js'

/** Hueco que una oferta de espera vigente guarda hasta que caduque. */
export function offeredOccupancy(id:string,entry:core.WaitlistEntry,settings:core.ReservationSettings,now:number):core.ReservaOcupacion[] {
  if(entry.status!=='offered'||!entry.offer||entry.offer.expiresAt<=now)return []
  const duration=core.duracionParaGrupo(core.settingsToConfiguracion(settings),entry.partySize)
  return [{id:`waitlist-${id}`,inicio:entry.offer.startAt,duracionMinutos:duration,comensales:entry.partySize,estado:'pendiente',mesaIds:[]}]
}

/**
 * Mesas ocupadas que no son reservas (sesiones de mesa de sala, V4). Con el módulo de sala activo hay que
 * registrar una fuente: sin ella se podría vender una mesa que ya está sentada. `represented` son las
 * reservas sentadas que ya cuenta su sesión y no deben contarse dos veces.
 */
export interface OccupancySource {
  (client:PoolClient,input:{tenant:Tenant;locationId:string;focus:readonly number[];settings:core.ReservationSettings;now:number}):Promise<{occupancy:core.ReservaOcupacion[];represented:ReadonlySet<string>}>
}
const sources=new Map<string,OccupancySource>()
export function registerOccupancySource(name:string,source:OccupancySource) {sources.set(name,source)}
export function unregisterOccupancySource(name:string) {sources.delete(name)}
export const occupancySourceNames=()=>[...sources.keys()]

export interface Ctx {
  client:PoolClient;tenant:Tenant;lid:string;now:number
  /** Instantes (ms) cuya ventana de ±48 h ya está cargada. */
  focus:number[];represented:Set<string>;offers:Array<core.WaitlistEntry&{id:string}>
  settings:core.ReservationSettings;saved:boolean;config:core.ConfiguracionReservas
  tables:core.MesaMotor[];reservations:core.ReservationWithId[];occupancy:core.ReservaOcupacion[]
}
/**
 * Bloquea el local y carga solo lo cercano a los instantes pedidos (ventana indexada).
 * No hay lecturas de histórico completo: el motor ve las reservas de ±48 h.
 */
export async function loadContext(client:PoolClient,tenant:Tenant,lid:string,focus:readonly number[],options:{now?:number;skipWaitlist?:string;publicBooking?:boolean;requireModule?:boolean;lock?:boolean}={}):Promise<Ctx> {
  if(options.requireModule!==false&&!core.hasModule(tenant.restaurant,'reservations'))failure('El módulo de reservas está desactivado.')
  if(options.lock!==false)await lockLocation(client,tenant.rid,lid)
  const now=options.now??Date.now()
  const {settings,saved}=await readSettings(client,tenant.rid,lid,tenant.timezone)
  if(options.publicBooking&&!settings.publicBooking)failure('El local no acepta reservas por la web.')
  const [tables,reservations,offers]=await Promise.all([readTables(client,tenant.rid,lid),readWindow(client,tenant.rid,lid,focus),readOffers(client,tenant.rid,lid,now,options.skipWaitlist)])
  const extra=await Promise.all([...sources.values()].map(source=>source(client,{tenant,locationId:lid,focus,settings,now})))
  const represented=new Set(extra.flatMap(e=>[...e.represented]))
  const c:Ctx={client,tenant,lid,now,focus:[...focus],represented,offers,settings,saved,config:core.settingsToConfiguracion(settings),tables,reservations,occupancy:[]}
  c.occupancy=[...reservations.filter(r=>!(r.status==='seated'&&represented.has(r.id))).map(r=>core.reservationToOcupacion(r.id,r)),...extra.flatMap(e=>e.occupancy),...offers.flatMap(w=>offeredOccupancy(w.id,w,settings,now))]
  return c
}
/** Carga la ventana de otro instante (p. ej. otra fecha de la lista de espera) si aún no está en el contexto. */
export async function ensureWindow(c:Ctx,instant:number) {
  if(c.focus.some(f=>Math.abs(f-instant)<=24*3_600_000))return
  const more=await readWindow(c.client,c.tenant.rid,c.lid,[instant])
  const known=new Set(c.reservations.map(r=>r.id))
  const fresh=more.filter(r=>!known.has(r.id))
  c.reservations.push(...fresh)
  c.occupancy.push(...fresh.filter(r=>!(r.status==='seated'&&c.represented.has(r.id))).map(r=>core.reservationToOcupacion(r.id,r)))
  const extra=await Promise.all([...sources.values()].map(source=>source(c.client,{tenant:c.tenant,locationId:c.lid,focus:[instant],settings:c.settings,now:c.now})))
  const ids=new Set(c.occupancy.map(o=>o.id))
  c.occupancy.push(...extra.flatMap(e=>e.occupancy).filter(o=>!ids.has(o.id)))
  c.focus.push(instant)
}
/** Tras escribir una reserva en la transacción, el contexto en memoria debe reflejarla (la oferta de espera lo necesita). */
export function refreshReservation(c:Ctx,id:string,r:core.Reservation) {
  c.reservations=c.reservations.filter(x=>x.id!==id).concat([{id,...r}])
  c.occupancy=c.occupancy.filter(x=>x.id!==id).concat([core.reservationToOcupacion(id,r)])
}
/** Instante representativo de un día de servicio, para acotar la ventana de lectura. */
export function dayFocus(date:string,timezone:string):number {
  return core.instanteDeHoraLocal(date,720,timezone)??Date.parse(`${date}T12:00:00Z`)
}

export function proposals(c:Ctx,startAt:number,partySize:number,durationMinutes?:number,reservationId?:string,preferredAreaId?:string|null,limit=10000) {
  return core.proponerMesas({config:c.config,mesas:c.tables,reservas:c.occupancy,ahora:c.now,peticion:{inicio:startAt,comensales:partySize,duracionMinutos:durationMinutes,reservaId:reservationId,zonaPreferida:preferredAreaId},limite:limit})
}
export function selection(c:Ctx,r:Pick<core.Reservation,'startAt'|'partySize'|'durationMinutes'>,tableIds:string[],id?:string) {
  const result=proposals(c,r.startAt,r.partySize,r.durationMinutes,id)
  if(!result.propuestas.length)failure('No queda sitio para esta reserva.')
  if(tableIds.length&&!result.propuestas.some(p=>p.mesaIds.length===tableIds.length&&p.mesaIds.every(t=>tableIds.includes(t))))failure('Las mesas elegidas no están disponibles o no admiten al grupo.')
  return result.propuestas[0]!
}
export function availability(c:Ctx,date:string,partySize:number,durationMinutes?:number,skip=false,exclude?:string) {
  return core.calcularDisponibilidad({config:c.config,fecha:date,comensales:partySize,mesas:c.tables,reservas:c.occupancy,ahora:c.now,duracionMinutos:durationMinutes,ignorarLimitesPublicos:skip,excluirReservaId:exclude})
}
/** Instante de una franja; falla si la franja ya no está libre (decisión tomada con el local bloqueado). */
export function startOf(c:Ctx,date:string,time:string,partySize:number,durationMinutes?:number,skip=false,exclude?:string) {
  const slot=core.slotStartAt(c.config,date,time)
  if(!slot)return failure('Esa hora no existe en la zona horaria del local.')
  const available=availability(c,date,partySize,durationMinutes,skip,exclude)
  if(slot.inShift?!available.franjas.some(f=>f.inicio===slot.startAt&&f.disponible):!skip)failure('Esa franja ya no está disponible.')
  return slot.startAt
}
