import * as core from '@llenamos/core'
import { RestaurantSchema,MemberSchema,LocationSchema } from '@llenamos/core'
import { z } from 'zod'
import type { Pool,PoolClient } from 'pg'
import { ApiError } from './errors.js'
import { administrativeList,listPlans,platformService,type PlatformServices,type OperationContext } from './platform/service.js'
import { AcceptInvitationInput,InviteMemberInput,ChangeRoleInput,DeactivateInput } from './invitations/service.js'
import { digest } from './invitations/crypto.js'
import { MODULES } from './modules/index.js'

interface PrivateOperation {
  /**
   * `account`: identidad vigente y no operadora; con `restaurantId` exige rol (`roles`) pero no
   * comprueba que la suscripción esté al día (es la vía para pagar, ver el plan o dar el primer alta).
   */
  access:'platform'|'member'|'account'
  input:z.ZodType
  output:z.ZodType
  restaurantId?:(input:unknown)=>string
  roles?:readonly string[]
  run:(client:PoolClient,input:unknown,context:OperationContext)=>Promise<unknown>
}
interface PublicOperation {
  access:'public'
  input:z.ZodType
  output:z.ZodType
  runPublic:(input:unknown,context:{pool:Pool;clientIp?:string|null})=>Promise<unknown>
}
export type Operation=PrivateOperation|PublicOperation
/** Registry cerrado: un nombre desconocido nunca se convierte en SQL o en una llamada Firebase. */
export function createOperations(services:PlatformServices={}):ReadonlyMap<string,Operation> {
const platform=platformService(services)
const registry=new Map<string,Operation>([
  ['listarRestaurantesAdministracion',{
    access:'platform',input:core.ListarRestaurantesAdministracionInputSchema,output:core.ListarRestaurantesAdministracionOutputSchema,run:administrativeList,
  }],
  ['listarPlanesDisponibles',{
    access:'public',input:core.ListarPlanesDisponiblesInputSchema,output:core.ListarPlanesDisponiblesOutputSchema,
    runPublic:async(_input,{pool})=>{const client=await pool.connect();try{return await listPlans(client)}finally{client.release()}},
  }],
  ['altaRestauranteLogiqd',{
    access:'platform',input:core.AltaRestauranteLogiqdInputSchema,output:core.AltaRestauranteLogiqdOutputSchema,run:platform.create,
  }],
  ['configurarRestauranteLogiqd',{
    access:'platform',input:core.ConfigurarRestauranteLogiqdInputSchema,output:core.ConfigurarRestauranteLogiqdOutputSchema,run:platform.configure,
  }],
])
const invitation=services.invitations
if(invitation) {
  const inviteOutput=z.object({uid:z.string().min(1).max(128),invitationStatus:z.enum(['pending','sent'])})
  registry.set('aceptarInvitacion',{access:'public',input:AcceptInvitationInput,output:z.object({ok:z.literal(true),email:z.email()}),runPublic:input=>invitation.accept(input)})
  registry.set('invitarMiembro',{access:'member',roles:['owner','manager'],restaurantId:input=>InviteMemberInput.parse(input).restaurantId,input:InviteMemberInput,output:inviteOutput,
    run:async(client,input,context)=>{
      const result=await invitation.invite(client,input,context),rid=InviteMemberInput.parse(input).restaurantId
      context.afterCommit(async output=>{try{return {...inviteOutput.parse(output),invitationStatus:await invitation.deliver(digest(`${rid}:${result.uid}`))}}catch{return output}})
      return result
    }})
  registry.set('cambiarRolMiembro',{access:'member',roles:['owner','manager'],restaurantId:input=>ChangeRoleInput.parse(input).restaurantId,input:ChangeRoleInput,output:z.object({ok:z.literal(true)}),run:invitation.changeRole})
  registry.set('desactivarMiembro',{access:'member',roles:['owner','manager'],restaurantId:input=>DeactivateInput.parse(input).restaurantId,input:DeactivateInput,output:z.object({ok:z.literal(true)}),run:invitation.deactivate})
}
for(const module of MODULES)for(const [name,operation] of module.operations){
  if(registry.has(name))throw new Error(`Operación duplicada: ${name} (${module.name})`)
  registry.set(name,operation)
}
return registry
}

/** Contexto del panel seleccionado: SQL real y contratos actuales; no rellena datos de demo. */
export async function restaurantContext(client:PoolClient,uid:string,rid:string) {
  const restaurant=await client.query('SELECT * FROM llenamos.restaurants WHERE id=$1',[rid])
  const member=await client.query('SELECT * FROM llenamos.memberships WHERE uid=$1 AND restaurant_id=$2 AND active',[uid,rid])
  if(!restaurant.rows[0]||!member.rows[0])throw new ApiError(403,'permission-denied','No tienes acceso al restaurante.')
  const r=restaurant.rows[0],m=member.rows[0]
  if(r.entitlement_version!==null&&r.entitlement_version!==undefined&&(!r.access_valid_until||r.access_valid_until.getTime()<=Date.now()))throw new ApiError(412,'failed-precondition','La suscripción no permite acceder al servicio. Revisa el plan.')
  const locations=await client.query('SELECT * FROM llenamos.locations WHERE restaurant_id=$1 ORDER BY name,id',[rid])
  return {
    restaurant:{id:r.id,...RestaurantSchema.parse({name:r.name,slug:r.slug,brandColor:r.brand_color,currency:r.currency,timezone:r.timezone,
      locale:r.locale,isDemo:r.is_demo,plan:r.plan,activeModules:r.active_modules,moduleOverrides:r.module_overrides,
      ...(r.entitlement_version?{entitlementVersion:r.entitlement_version,accessValidUntil:r.access_valid_until.getTime(),commercialPlanId:r.commercial_plan_id,commercialPlanVersion:r.commercial_plan_version}:{})})},
    member:MemberSchema.parse({uid:m.uid,displayName:m.display_name,email:m.email,role:m.role,active:m.active,locationIds:m.location_ids}),
    locations:locations.rows.map(row=>({id:row.id,...LocationSchema.parse(row)})),
  }
}
