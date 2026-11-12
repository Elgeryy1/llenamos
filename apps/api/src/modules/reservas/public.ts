import type { Pool,PoolClient } from 'pg'
import type { z } from 'zod'
import * as core from '@llenamos/core'
import { ApiError } from '../../errors.js'
import type { Operation } from '../../operations.js'
import { assertBelow,guardBeforeResolve,guardKeyed,hit,ipKey,limits,recipients,txHit } from './abuse.js'
import { changeStatus,createReservation,lockedReservation,view } from './bookings.js'
import { availability,dayFocus,loadContext,type Ctx } from './engine.js'
import { failure,resolvePublicTenant,withPublicScope,type Tenant } from './scope.js'
import { lockLocation,readReservation } from './store.js'
import { acceptOffer,joinWaitlist,offerWaitlist } from './waitlist.js'
import { startDepositCheckout } from '../../payments/deposit.js'

type PublicContext={pool:Pool;clientIp?:string|null}
const publicOperation=(input:z.ZodType,output:z.ZodType,run:(input:never,context:PublicContext)=>Promise<unknown>):Operation=>({access:'public',input,output,runPublic:(data,context)=>run(data as never,context)})


const schemas=core.CALLABLE_SCHEMAS

/** Orden fijo: límite en memoria -> resolver slug -> módulo -> límites persistentes -> transacción. */
async function begin(context:PublicContext,slug:string,locationId:string,rules:Array<[string,string,{window:number;max:number}]>):Promise<Tenant> {
  guardBeforeResolve(context.clientIp??null)
  const tenant=await resolvePublicTenant(context.pool,slug,locationId)
  if(!core.hasModule(tenant.restaurant,'reservations'))failure('Las reservas públicas están desactivadas.')
  for(const [scope,key,rule] of rules)await hit(context.pool,tenant.rid,scope,key,rule)
  return tenant
}
const ipOf=(context:PublicContext)=>ipKey(context.clientIp??null)

/**
 * Credenciales del enlace (referencia + token) validadas con un procedimiento estrecho ANTES de cargar
 * ningún contexto de reserva. Los fallos se cuentan por IP y por referencia en su propia transacción.
 */
async function linkAccess(context:PublicContext,slug:string,reference:string,token:string) {
  guardBeforeResolve(context.clientIp??null)
  const first=await resolvePublicTenant(context.pool,slug,'')
  await hit(context.pool,first.rid,'link-ip',ipOf(context),limits.link.ipRestaurant)
  // Bloqueo real: con demasiados fallos recientes ni el token correcto entra hasta que acabe la ventana.
  await assertBelow(context.pool,first.rid,'link-fail-ip',ipOf(context),limits.link.failedIp)
  await assertBelow(context.pool,first.rid,'link-fail-ref',reference,limits.link.failedReference)
  const {rows}=await context.pool.query<{location_id:string;reservation_id:string}>('SELECT * FROM llenamos.reservas_link_lookup($1,$2,$3)',[first.rid,reference,core.sha256Hex(token)])
  if(!rows[0]) {
    await hit(context.pool,first.rid,'link-fail-ip',ipOf(context),limits.link.failedIp)
    await hit(context.pool,first.rid,'link-fail-ref',reference,limits.link.failedReference)
    throw new ApiError(404,'not-found','El enlace de reserva no es válido.')
  }
  const tenant=await resolvePublicTenant(context.pool,slug,rows[0].location_id)
  return {tenant,lid:rows[0].location_id,reservationId:rows[0].reservation_id}
}
/** Bloquea el local, lee la reserva y carga solo la ventana alrededor de su hora. */
export async function reservationContext(client:PoolClient,tenant:Tenant,lid:string,id:string,options:{lock?:boolean;requireModule?:boolean}={}):Promise<{c:Ctx;r:core.ReservationWithId}> {
  if(options.lock!==false)await lockLocation(client,tenant.rid,lid)
  const current=await readReservation(client,tenant.rid,lid,id)
  if(!current)throw new ApiError(404,'not-found','No se encuentra la reserva.')
  const c=await loadContext(client,tenant,lid,[current.startAt],{lock:options.lock,requireModule:options.requireModule})
  return {c,r:options.lock===false?current:await lockedReservation(c,id)}
}
const publicDeposit=(d:core.Deposit)=>({status:d.status,amountCents:d.amountCents})

/** Proyección pública (nombre, color, locales con reserva web y políticas); como la antigua `publicRestaurants/{slug}`. */
async function publicRestaurant(pool:Pool,slug:string) {
  const {rows}=await pool.query<{p:{restaurantId:string;name:string;brandColor:string;locale:string;timezone:string;plan:core.Plan;activeModules:core.Module[];moduleOverrides:core.ModuleOverrides;entitlementVersion:number|null;accessValidUntil:number|null;locations:unknown[];settings:unknown}|null}>('SELECT llenamos.reservas_public_projection($1) AS p',[slug])
  const p=rows[0]?.p
  if(!p)throw new ApiError(404,'not-found','No se encuentra el restaurante.')
  const settings=p.settings?core.ReservationSettingsSchema.parse(p.settings):core.defaultReservationSettings(p.timezone)
  const modules=core.hasModule({plan:p.plan,activeModules:p.activeModules,moduleOverrides:p.moduleOverrides,entitlementVersion:p.entitlementVersion,...(p.accessValidUntil!==null?{accessValidUntil:p.accessValidUntil}:{})},'reservations')
  const locations=p.locations.map(l=>core.PublicLocationSchema.parse(l))
  return core.PublicRestaurantSchema.parse({restaurantId:p.restaurantId,name:p.name,brandColor:p.brandColor,locale:p.locale,timezone:p.timezone,bookingEnabled:modules&&locations.length>0,
    bookingDisabledReason:!modules?'module_off':locations.length?null:'public_booking_off',locations,minPartySize:settings.minPartySize,maxPartySize:settings.maxPartySize,
    maxAdvanceDays:settings.maxAdvanceDays,deposit:settings.deposit,cancellationFreeUntilHours:settings.cancellation.freeUntilHours})
}

export const publicOperations:ReadonlyArray<readonly [string,Operation]>=[
  // Límite en memoria por IP, amplio: también la lee el servidor de Next (una IP) y la respuesta se guarda unos segundos.
  ['verRestaurantePublico',publicOperation(schemas.verRestaurantePublico.input,schemas.verRestaurantePublico.output,(d:core.CallableParsedInput<'verRestaurantePublico'>,context)=>{guardKeyed('projection',context.clientIp??null,limits.projection);return publicRestaurant(context.pool,d.slug)})],
  ['consultarDisponibilidad',publicOperation(schemas.consultarDisponibilidad.input,schemas.consultarDisponibilidad.output,async(d:core.CallableParsedInput<'consultarDisponibilidad'>,context)=>{
    const tenant=await begin(context,d.slug,d.locationId,[['availability-ip',ipOf(context),limits.availability.ipRestaurant]])
    return withPublicScope(context.pool,tenant.rid,async client=>{
      const c=await loadContext(client,tenant,d.locationId,[dayFocus(d.date,tenant.timezone)],{publicBooking:true,lock:false})
      return core.disponibilidadToOutput(availability(c,d.date,d.partySize),{timezone:c.settings.timezone,waitlistEnabled:c.settings.waitlist.enabled})
    })
  })],
  ['crearReservaPublica',publicOperation(schemas.crearReservaPublica.input,schemas.crearReservaPublica.output,async(d:core.CallableParsedInput<'crearReservaPublica'>,context)=>{
    const tenant=await begin(context,d.slug,d.locationId,[['create-ip',ipOf(context),limits.create.ipRestaurant]])
    await assertBelow(context.pool,tenant.rid,'create-restaurant','all',limits.create.restaurant)
    for(const recipient of recipients(d.phone,d.email))await assertBelow(context.pool,tenant.rid,'recipient-create',recipient,limits.create.recipient)
    return withPublicScope(context.pool,tenant.rid,async client=>{
      const c=await loadContext(client,tenant,d.locationId,[dayFocus(d.date,tenant.timezone)],{publicBooking:true})
      const duplicate=await client.query('SELECT 1 FROM llenamos.reservations WHERE restaurant_id=$1 AND customer_id=$2 AND location_id=$3 AND status IN (\'pending\',\'confirmed\') AND start_at=$4 LIMIT 1',
        [tenant.rid,core.customerIdFor(tenant.rid,d.phone),d.locationId,new Date(core.slotStartAt(c.config,d.date,d.time)?.startAt??0)])
      if(duplicate.rowCount)throw new ApiError(409,'already-exists','Ya tienes una reserva para esa hora.')
      const out=await createReservation(c,{...d,status:undefined},null,true,false,async()=>{
        // Ya validada la franja: solo ahora cuenta para restaurante y destinatario, y se deshace si algo falla.
        const keys:Array<[string,string,{window:number;max:number}]>=[['create-restaurant','all',limits.create.restaurant],...recipients(d.phone,d.email).map((r):[string,string,{window:number;max:number}]=>['recipient-create',r,limits.create.recipient])]
        for(const [scope,key,rule] of keys)if(!(await txHit(client,tenant.rid,scope,key,rule)))throw new ApiError(429,'resource-exhausted','Demasiados intentos. Vuelve a intentarlo más tarde.')
      })
      return {reference:out.reference,status:out.status,manageToken:out.manageToken,startAt:out.startAt,deposit:publicDeposit(out.deposit)}
    })
  })],
  ['verReservaPublica',publicOperation(schemas.verReservaPublica.input,schemas.verReservaPublica.output,async(d:core.CallableParsedInput<'verReservaPublica'>,context)=>{
    const {tenant,lid,reservationId}=await linkAccess(context,d.slug,d.reference,d.token)
    return withPublicScope(context.pool,tenant.rid,async client=>{
      const {c,r}=await reservationContext(client,tenant,lid,reservationId,{lock:false,requireModule:false})
      return view(c,r)
    })
  })],
  ['gestionarReservaPublica',publicOperation(schemas.gestionarReservaPublica.input,schemas.gestionarReservaPublica.output,async(d:core.CallableParsedInput<'gestionarReservaPublica'>,context)=>{
    const {tenant,lid,reservationId}=await linkAccess(context,d.slug,d.reference,d.token)
    return withPublicScope(context.pool,tenant.rid,async client=>{
      const {c,r}=await reservationContext(client,tenant,lid,reservationId,{requireModule:false})
      if(d.action==='confirm'&&!view(c,r).canConfirm)failure('La reserva no se puede confirmar; comprueba la señal pendiente.')
      const next=await changeStatus(c,r,d.action==='confirm'?'confirmed':'cancelled',null,d.reason)
      if(d.action==='cancel')await offerWaitlist(c)
      return view(c,{...next})
    })
  })],
  ['apuntarseListaEspera',publicOperation(schemas.apuntarseListaEspera.input,schemas.apuntarseListaEspera.output,async(d:core.CallableParsedInput<'apuntarseListaEspera'>,context)=>{
    const tenant=await begin(context,d.slug,d.locationId,[['waitlist-ip',ipOf(context),limits.waitlist.ipRestaurant]])
    await assertBelow(context.pool,tenant.rid,'waitlist-restaurant','all',limits.waitlist.restaurant)
    for(const recipient of recipients(d.phone,d.email))await assertBelow(context.pool,tenant.rid,'recipient-waitlist',recipient,limits.waitlist.recipient)
    return withPublicScope(context.pool,tenant.rid,async client=>{
      const c=await loadContext(client,tenant,d.locationId,[],{publicBooking:true,lock:false})
      return joinWaitlist(c,async()=>{
        const keys:Array<[string,string,{window:number;max:number}]>=[['waitlist-restaurant','all',limits.waitlist.restaurant],...recipients(d.phone,d.email).map((r):[string,string,{window:number;max:number}]=>['recipient-waitlist',r,limits.waitlist.recipient])]
        for(const [scope,key,rule] of keys)if(!(await txHit(client,tenant.rid,scope,key,rule)))throw new ApiError(429,'resource-exhausted','Demasiados intentos. Vuelve a intentarlo más tarde.')
      },d)
    })
  })],
  ['aceptarOfertaListaEspera',publicOperation(schemas.aceptarOfertaListaEspera.input,schemas.aceptarOfertaListaEspera.output,async(d:core.CallableParsedInput<'aceptarOfertaListaEspera'>,context)=>{
    guardBeforeResolve(context.clientIp??null)
    const first=await resolvePublicTenant(context.pool,d.slug,'')
    await hit(context.pool,first.rid,'link-ip',ipOf(context),limits.link.ipRestaurant)
    await assertBelow(context.pool,first.rid,'link-fail-ip',ipOf(context),limits.link.failedIp)
    await assertBelow(context.pool,first.rid,'link-fail-ref',d.waitlistId,limits.link.failedReference)
    const {rows}=await context.pool.query<{lid:string|null}>('SELECT llenamos.reservas_offer_lookup($1,$2,$3) AS lid',[first.rid,d.waitlistId,core.sha256Hex(d.token)])
    if(!rows[0]?.lid) {
      await hit(context.pool,first.rid,'link-fail-ip',ipOf(context),limits.link.failedIp)
      await hit(context.pool,first.rid,'link-fail-ref',d.waitlistId,limits.link.failedReference)
      throw new ApiError(404,'not-found','No se encuentra la oferta.')
    }
    const lid=rows[0].lid,tenant=await resolvePublicTenant(context.pool,d.slug,lid)
    if(!core.hasModule(tenant.restaurant,'reservations'))failure('Las reservas públicas están desactivadas.')
    return withPublicScope(context.pool,tenant.rid,async client=>{
      await lockLocation(client,tenant.rid,lid)
      const offer=await client.query<{date:string}>('SELECT service_date AS date FROM llenamos.waitlist WHERE restaurant_id=$1 AND location_id=$2 AND id=$3',[tenant.rid,lid,d.waitlistId])
      const c=await loadContext(client,tenant,lid,[dayFocus(offer.rows[0]!.date,tenant.timezone)],{publicBooking:true,skipWaitlist:d.waitlistId})
      const out=await acceptOffer(c,d.waitlistId,d.token)
      return {...out,deposit:publicDeposit(out.deposit)}
    })
  })],
  ['iniciarPagoSenal',publicOperation(schemas.iniciarPagoSenal.input,schemas.iniciarPagoSenal.output,async(d:core.CallableParsedInput<'iniciarPagoSenal'>,context)=>{
    const {tenant,lid,reservationId}=await linkAccess(context,d.slug,d.reference,d.token)
    const r=await withPublicScope(context.pool,tenant.rid,client=>readReservation(client,tenant.rid,lid,reservationId))
    if(!r)throw new ApiError(404,'not-found','No se encuentra la reserva.')
    if(r.deposit.status==='paid')return {status:'already_paid' as const}
    if(!r.deposit.amountCents||r.deposit.status==='none')return {status:'not_required' as const}
    if(!['pending','confirmed'].includes(r.status))failure('Esta reserva ya no admite el pago de la señal.')
    if(!tenant.stripe)return {status:'not_configured' as const,message:'Los pagos de señal no están configurados. Contacta con el restaurante.'}
    // Sesión de Checkout con la Stripe del restaurante (módulo de pagos): el dinero lo confirma su webhook firmado.
    const checkout=await startDepositCheckout(context.pool,{rid:tenant.rid,locationId:lid,reservationId,reference:r.reference,slug:tenant.slug,token:d.token,amountCents:r.deposit.amountCents,checkoutSessionId:r.deposit.checkoutSessionId})
    if(!checkout)return {status:'not_configured' as const,message:'Los pagos de señal no están configurados. Contacta con el restaurante.'}
    return {status:'redirect' as const,url:checkout.url}
  })],
]
