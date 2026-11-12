import type { PoolClient } from 'pg'
import type { z } from 'zod'
import * as core from '@llenamos/core'
import { ApiError } from '../../errors.js'
import type { Operation } from '../../operations.js'
import { changeStatus,createReservation,lockedReservation } from './bookings.js'
import { dayFocus,loadContext,proposals,refreshReservation,selection,startOf,type Ctx } from './engine.js'
import { cancelPendingNotices,reservationNotices } from './notices.js'
import { failure,notFound,resolvePublicTenant,type Tenant } from './scope.js'
import { lockLocation,readReservation,reservationEvent,syncCustomer,updateReservation } from './store.js'
import { offerWaitlist } from './waitlist.js'

const schemas=core.CALLABLE_SCHEMAS
const rolesFor=(permission:core.Permission)=>core.ROLES.filter(role=>core.can(role,permission))
/** Ganchos para sala (V4): sentar/terminar abre y cierra la sesión de mesa; la caja puede bloquear la mesa. */
export const reservationHooks:{
  onSeated?:(c:Ctx,r:core.ReservationWithId,uid:string)=>Promise<void>
  onFinished?:(c:Ctx,r:core.ReservationWithId,uid:string)=>Promise<void>
  assertAssignable?:(c:Ctx,r:core.ReservationWithId)=>Promise<void>
}={}

/**
 * Personal: restaurante y local desde SQL (RLS limita lo visible), rol con permiso y local asignado.
 * El UID sale del token verificado, nunca del cuerpo.
 */
export async function staffTenant(client:PoolClient,uid:string,rid:string,lid:string,permission:core.Permission):Promise<Tenant> {
  const m=await client.query<{role:core.Role;location_ids:string[]}>('SELECT role,location_ids FROM llenamos.memberships WHERE uid=$1 AND restaurant_id=$2 AND active',[uid,rid])
  const member=m.rows[0]
  if(!member||!core.can(member.role,permission)||(member.location_ids.length&&!member.location_ids.includes(lid)))
    throw new ApiError(403,'permission-denied','No tienes permiso para gestionar las reservas de este local.')
  const r=await client.query<{slug:string}>('SELECT slug FROM llenamos.restaurants WHERE id=$1',[rid])
  if(!r.rows[0])return notFound('No se encuentra el restaurante.')
  // Reutiliza la resolución pública (mismas reglas de módulos y suscripción) sin otra consulta de tablas privadas.
  return resolveFrom(client,r.rows[0].slug,lid)
}
const resolveFrom=(client:PoolClient,slug:string,lid:string)=>resolvePublicTenant(client,slug,lid)
async function reservationFor(client:PoolClient,uid:string,rid:string,lid:string,id:string,permission:core.Permission='reservas.gestionar') {
  const tenant=await staffTenant(client,uid,rid,lid,permission)
  await lockLocation(client,rid,lid)
  const current=await readReservation(client,rid,lid,id)
  if(!current)return notFound('No se encuentra la reserva.')
  const c=await loadContext(client,tenant,lid,[current.startAt])
  return {c,r:await lockedReservation(c,id)}
}
const staffOperation=(permission:core.Permission,input:z.ZodType,output:z.ZodType,restaurantId:(input:unknown)=>string,run:(client:PoolClient,input:never,uid:string)=>Promise<unknown>):Operation=>({
  access:'member',roles:rolesFor(permission),restaurantId,input,output,run:(client,data,context)=>run(client,data as never,context.uid),
})
const rid=(input:unknown)=>(input as {restaurantId:string}).restaurantId

export const staffOperations:ReadonlyArray<readonly [string,Operation]>=[
  ['crearReserva',staffOperation('reservas.gestionar',schemas.crearReserva.input,schemas.crearReserva.output,rid,async(client,d:core.CallableParsedInput<'crearReserva'>,uid)=>{
    const tenant=await staffTenant(client,uid,d.restaurantId,d.locationId,'reservas.gestionar')
    const c=await loadContext(client,tenant,d.locationId,[dayFocus(d.date,tenant.timezone)])
    const out=await createReservation(c,d,uid)
    return {reservationId:out.reservationId,reference:out.reference,status:out.status,startAt:out.startAt,tableIds:out.tableIds,suggestedTableIds:out.suggestedTableIds}
  })],
  ['cambiarEstadoReserva',staffOperation('reservas.gestionar',schemas.cambiarEstadoReserva.input,schemas.cambiarEstadoReserva.output,rid,async(client,d:core.CallableParsedInput<'cambiarEstadoReserva'>,uid)=>{
    const {c,r}=await reservationFor(client,uid,d.restaurantId,d.locationId,d.reservationId)
    const next=await changeStatus(c,r,d.status,uid,d.reason)
    if(d.status==='seated')await reservationHooks.onSeated?.(c,next,uid)
    if(d.status==='finished')await reservationHooks.onFinished?.(c,next,uid)
    if(d.status==='cancelled'||d.status==='no_show')await offerWaitlist(c)
    return {ok:true as const,status:d.status}
  })],
  ['asignarMesas',staffOperation('reservas.gestionar',schemas.asignarMesas.input,schemas.asignarMesas.output,rid,async(client,d:core.CallableParsedInput<'asignarMesas'>,uid)=>{
    const {c,r}=await reservationFor(client,uid,d.restaurantId,d.locationId,d.reservationId)
    await reservationHooks.assertAssignable?.(c,r)
    if(!core.occupiesTable(r.status))failure('Esta reserva ya no ocupa mesa.')
    selection(c,r,d.tableIds,r.id)
    const {id:_id,...doc}=r
    await updateReservation(client,d.restaurantId,d.locationId,r.id,{...doc,tableIds:d.tableIds},uid)
    refreshReservation(c,r.id,{...doc,tableIds:d.tableIds})
    await reservationEvent(client,d.restaurantId,d.locationId,r.id,'tables',r.status)
    return {ok:true as const,tableIds:d.tableIds}
  })],
  ['moverReserva',staffOperation('reservas.gestionar',schemas.moverReserva.input,schemas.moverReserva.output,rid,async(client,d:core.CallableParsedInput<'moverReserva'>,uid)=>{
    const {c,r:old}=await reservationFor(client,uid,d.restaurantId,d.locationId,d.reservationId)
    if(!['pending','confirmed'].includes(old.status))failure('Solo se pueden mover reservas pendientes o confirmadas.')
    const partySize=d.partySize??old.partySize,durationMinutes=d.durationMinutes??core.duracionParaGrupo(c.config,partySize)
    const {id,...doc}=old
    // El nuevo día puede estar fuera de la ventana cargada: se recarga alrededor de la nueva hora.
    const startAt=core.slotStartAt(c.config,d.date,d.time)?.startAt
    if(startAt===undefined)failure('Esa hora no existe en la zona horaria del local.')
    const target=await loadContext(client,c.tenant,d.locationId,[old.startAt,startAt!])
    const moved:core.Reservation={...doc,partySize,durationMinutes,startAt:startOf(target,d.date,d.time,partySize,durationMinutes,true,id),tableIds:d.tableIds??old.tableIds}
    const p=proposals(target,moved.startAt,partySize,durationMinutes,id)
    if(d.tableIds===undefined&&!p.propuestas.some(x=>x.mesaIds.length===moved.tableIds.length&&x.mesaIds.every(t=>moved.tableIds.includes(t))))moved.tableIds=[]
    const suggestion=selection(target,moved,moved.tableIds,id)
    moved.suggestedTableIds=suggestion.mesaIds;moved.suggestionReason=suggestion.explicacion
    await cancelPendingNotices(client,d.restaurantId,id)
    await updateReservation(client,d.restaurantId,d.locationId,id,moved,uid)
    refreshReservation(target,id,moved)
    await syncCustomer(client,d.restaurantId,moved)
    await reservationNotices(target,id,moved)
    await reservationEvent(client,d.restaurantId,d.locationId,id,'moved',moved.status)
    await offerWaitlist(target)
    return {ok:true as const,startAt:moved.startAt,durationMinutes:moved.durationMinutes,tableIds:moved.tableIds}
  })],
  ['proponerMesasReserva',staffOperation('reservas.gestionar',schemas.proponerMesasReserva.input,schemas.proponerMesasReserva.output,rid,async(client,d:core.CallableParsedInput<'proponerMesasReserva'>,uid)=>{
    const tenant=await staffTenant(client,uid,d.restaurantId,d.locationId,'reservas.gestionar')
    const existing=d.reservationId?await readReservation(client,d.restaurantId,d.locationId,d.reservationId):null
    if(d.reservationId&&!existing)return notFound('No se encuentra la reserva.')
    const probe=await loadContext(client,tenant,d.locationId,[],{lock:false})
    const wall=existing?core.horaLocal(existing.startAt,probe.settings.timezone):undefined
    const startAt=d.date||d.time?core.slotStartAt(probe.config,d.date??wall!.fecha,d.time??core.minutosAHora(wall!.minutos))?.startAt:existing?.startAt
    if(startAt===undefined)failure('Indica una fecha y hora válidas.')
    const c=await loadContext(client,tenant,d.locationId,[startAt!],{lock:false})
    return core.asignacionToOutput(proposals(c,startAt!,d.partySize??existing!.partySize,d.durationMinutes??existing?.durationMinutes,existing?.id,d.preferredAreaId,d.limit))
  })],
  ['guardarConfiguracionReservas',staffOperation('reservas.configurar',schemas.guardarConfiguracionReservas.input,schemas.guardarConfiguracionReservas.output,rid,async(client,d:core.CallableParsedInput<'guardarConfiguracionReservas'>,uid)=>{
    const tenant=await staffTenant(client,uid,d.restaurantId,d.locationId,'reservas.configurar')
    if(!core.hasModule(tenant.restaurant,'reservations'))failure('El módulo de reservas está desactivado.')
    await lockLocation(client,d.restaurantId,d.locationId)
    await client.query(`INSERT INTO llenamos.reservation_settings(restaurant_id,location_id,data,updated_by) VALUES($1,$2,$3,$4)
      ON CONFLICT(restaurant_id,location_id) DO UPDATE SET data=EXCLUDED.data,revision=llenamos.reservation_settings.revision+1,updated_at=now(),updated_by=EXCLUDED.updated_by`,
      [d.restaurantId,d.locationId,JSON.stringify(core.ReservationSettingsSchema.parse(d.settings)),uid])
    await reservationEvent(client,d.restaurantId,d.locationId,d.locationId,'settings','ok','reservas.ajustes')
    // Con la espera recién activada o con más aforo puede haber huecos para ofrecer.
    await offerWaitlist(await loadContext(client,tenant,d.locationId,[Date.now()]))
    return {ok:true as const}
  })],
  ['importarReservas',staffOperation('reservas.importar',schemas.importarReservas.input,schemas.importarReservas.output,rid,async(client,d:core.CallableParsedInput<'importarReservas'>,uid)=>{
    const tenant=await staffTenant(client,uid,d.restaurantId,d.locationId,'reservas.importar')
    const errors:core.ImportRowError[]=[],reservationIds:string[]=[]
    // Cada fila va en su SAVEPOINT: un fallo no revierte las filas correctas.
    for(const [index,raw] of d.rows.entries()) {
      const row=core.parseImportRow(raw,index)
      if(!row.ok){errors.push(...row.errors);continue}
      await client.query('SAVEPOINT import_row')
      try {
        const c=await loadContext(client,tenant,d.locationId,[dayFocus(row.value.date,tenant.timezone)])
        const tableIds=row.value.tables.map(name=>{
          const table=c.tables.find(t=>t.name===name)
          if(!table)failure(`No existe la mesa ${name}.`)
          return table!.id
        })
        const out=await createReservation(c,{...row.value,source:'import',skipWebLimits:true,tableIds},uid,false,d.dryRun)
        if(!d.dryRun)reservationIds.push(out.reservationId)
        await client.query('RELEASE SAVEPOINT import_row')
      } catch(error) {
        await client.query('ROLLBACK TO SAVEPOINT import_row')
        if(!(error instanceof ApiError)||error.status>=500)throw error
        errors.push({row:index,field:null,message:error.message})
      }
    }
    return {created:reservationIds.length,reservationIds,errors}
  })],
]
