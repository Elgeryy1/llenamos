import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import * as core from '@llenamos/core'
import { ApiError } from '../errors.js'
import type { InvitationService } from '../invitations/service.js'
import type { HttpRoute } from '../http.js'
import { credentialsStatus,integrationVault,mergeCredentials,webhookSubset,WEBHOOK_PROVIDERS,type IntegrationVault,type Provider } from './integrations.js'

export interface PlatformServices {invitations?:InvitationService;integrationVault?:IntegrationVault;routes?:readonly HttpRoute[]}
export interface OperationContext {uid:string;afterCommit:(task:(output:unknown)=>Promise<unknown>)=>void;/** Bóveda de proveedores de la API; ausente si no hay clave de custodia. */integrationVault?:IntegrationVault}
const fingerprint=(value:unknown)=>createHash('sha256').update(core.canonicalJson(value)).digest('hex')
export function platformError(error:unknown):never {
  if(error instanceof ApiError)throw error
  const {code,message}=error as {code?:string;message?:string}
  if(code==='23505')throw new ApiError(409,'already-exists',message==='request_conflict'?'Este identificador ya se usó con otros datos.':'La dirección del restaurante ya está ocupada.')
  if(code==='40001')throw new ApiError(409,'aborted','La configuración ha cambiado. Actualiza el listado.')
  if(code==='42501')throw new ApiError(403,'permission-denied','No tienes permisos de administración.')
  if(code==='P0002')throw new ApiError(404,'not-found','No se encuentra el registro administrativo.')
  if(code==='P0001')throw new ApiError(412,'failed-precondition','Revisa el plan, su capacidad y el estado de la suscripción.')
  throw error
}
/** Fila `to_jsonb` de `platform_subscriptions` (fechas ISO) al contrato de core. */
export function subscriptionFromRow(row:Record<string,string|number|boolean|null>) {
  const at=(value:string|number|boolean|null)=>value===null?null:Date.parse(String(value))
  return core.SubscriptionSchema.parse({planId:row.plan_id,planVersion:row.plan_version,status:row.status,interval:row.interval,
    trialEndsAt:at(row.trial_ends_at!),periodEndsAt:at(row.period_ends_at!),graceEndsAt:at(row.grace_ends_at!),cancelAtPeriodEnd:row.cancel_at_period_end,
    stripeCustomerId:row.stripe_customer_id,stripeSubscriptionId:row.stripe_subscription_id,revision:row.revision})
}
export async function listPlans(client:PoolClient) {
  const {rows}=await client.query("SELECT DISTINCT ON(id) definition FROM llenamos.platform_plans WHERE (definition->>'enabled')::boolean ORDER BY id,version DESC LIMIT 100")
  return {plans:rows.map(row=>core.PublicPlanDefinitionSchema.parse(row.definition))}
}
export async function readPlan(client:PoolClient,id:string,version:number) {
  const {rows}=await client.query('SELECT definition FROM llenamos.platform_plans WHERE id=$1 AND version=$2',[id,version])
  if(!rows[0])throw new ApiError(404,'not-found','No se encuentra esa versión del plan.')
  const plan=core.PlanDefinitionSchema.parse(rows[0].definition)
  if(!plan.enabled)throw new ApiError(412,'failed-precondition','El plan no está disponible.')
  return plan
}
function administrative(row:Record<string,unknown>) {
  return core.AdministrativeRestaurantSchema.parse({restaurantId:row.restaurant_id,name:row.name,slug:row.slug,ownerEmail:row.owner_email,
    planId:row.plan_id,planVersion:row.plan_version,status:row.status,activeModules:row.active_modules,moduleOverrides:row.module_overrides,
    revision:row.revision,...(row.integration_status?{integrationStatus:row.integration_status}:{})})
}
export async function administrativeList(client:PoolClient,input:unknown) {
  const data=core.ListarRestaurantesAdministracionInputSchema.parse(input)
  const {rows}=await client.query(`SELECT restaurant_id,name,slug,owner_email,plan_id,plan_version,status,active_modules,module_overrides,revision,integration_status
    FROM llenamos.platform_restaurants WHERE ($1::text IS NULL OR restaurant_id>$1) ORDER BY restaurant_id LIMIT $2`,[data.cursor,data.limit+1])
  const shown=rows.slice(0,data.limit)
  return {restaurants:shown.map(administrative),nextCursor:rows.length>data.limit?shown.at(-1)?.restaurant_id??null:null}
}
async function receipt(client:PoolClient,operation:string,requestKey:string,hash:string,result?:unknown) {
  return (await client.query('SELECT llenamos.platform_request($1,$2,$3,$4) AS receipt',[operation,requestKey,hash,result===undefined?null:JSON.stringify(result)])).rows[0]?.receipt
}
async function saveIntegrations(client:PoolClient,rid:string,previous:string|null,patch:core.RestaurantIntegrationsInput|undefined,remove:Provider[]=[],vault:IntegrationVault) {
  const next=mergeCredentials(vault.open(rid,previous),patch,remove),status=credentialsStatus(next)
  await client.query('SELECT llenamos.platform_integrations($1,$2,$3)',[rid,vault.seal(rid,next),JSON.stringify(status)])
  // Los secretos de firma se guardan aparte para que el receptor de webhooks no vea el resto de credenciales.
  for(const provider of WEBHOOK_PROVIDERS)await client.query('SELECT llenamos.platform_webhook_secrets($1,$2,$3)',[rid,provider,vault.sealWebhook(rid,provider,webhookSubset(next,provider))])
  return status
}
export function platformService(services:PlatformServices={}) {
  const vault=services.integrationVault??integrationVault()
  return {
    async create(client:PoolClient,data:unknown,context:OperationContext) {
      const parsed=core.AltaRestauranteLogiqdInputSchema.parse(data),input={...parsed,ownerEmail:parsed.ownerEmail.toLowerCase()}
      const hash=fingerprint(input)
      try {
        const old=await receipt(client,'altaRestauranteLogiqd',input.requestId,hash)
        const invitation=services.invitations
        const after=(rid:string)=>context.afterCommit(async output=>{
          if(!invitation)return output
          try {return {...core.AltaRestauranteLogiqdOutputSchema.parse(output),invitationStatus:await invitation.deliverOwner(rid,input.ownerEmail)}}
          catch {return output} // La alta ya es durable: el envío permanece pendiente, nunca se simula.
        })
        if(old){
          const output=core.AltaRestauranteLogiqdOutputSchema.parse(old)
          if(invitation)await invitation.refreshOwnerPending(client,output.restaurantId,input.ownerEmail,input.ownerName)
          after(output.restaurantId);return output
        }
        if(!invitation)throw new ApiError(503,'failed-precondition','Configura la administración de identidad antes de dar de alta un restaurante.')
        await readPlan(client,input.planId,input.planVersion)
        const uid=await invitation.resolveAccount(input.ownerEmail,input.ownerName)
        const rid=`rest_${fingerprint([context.uid,input.requestId]).slice(0,32)}`
        const output=(await client.query('SELECT llenamos.platform_create($1,$2,$3,$4,$5,$6,$7,$8) AS result',
          [rid,input.name,input.slug,input.ownerEmail,input.locationName,core.slugify(input.locationName)||'principal',input.planId,input.planVersion])).rows[0].result
        await saveIntegrations(client,rid,null,input.integrations,[],vault)
        await invitation.prepare(client,{restaurantId:rid,uid,email:input.ownerEmail,displayName:input.ownerName,role:'owner',locationIds:[],invitedBy:context.uid,kind:'owner'})
        const result=core.AltaRestauranteLogiqdOutputSchema.parse({...output,invitationStatus:'pending'})
        await receipt(client,'altaRestauranteLogiqd',input.requestId,hash,result)
        after(rid)
        return result
      }catch(error){return platformError(error)}
    },
    async configure(client:PoolClient,data:unknown,context:OperationContext) {
      const input=core.ConfigurarRestauranteLogiqdInputSchema.parse(data)
      const hash=fingerprint(input),requestKey=fingerprint([input.restaurantId,input.requestId])
      try {
        const previous=await receipt(client,'configurarRestauranteLogiqd',requestKey,hash)
        if(previous)return core.ConfigurarRestauranteLogiqdOutputSchema.parse(previous)
        const raw=(await client.query('SELECT llenamos.platform_configuration($1) AS result',[input.restaurantId])).rows[0].result
        const subscription=subscriptionFromRow(raw.subscription)
        if(subscription.revision!==input.expectedRevision)throw new ApiError(409,'aborted','La configuración ha cambiado. Actualiza el listado.')
        if(subscription.stripeSubscriptionId)throw new ApiError(412,'failed-precondition','La suscripción está vinculada a Stripe. Revisa primero el contrato.')
        const plan=await readPlan(client,input.planId,input.planVersion)
        const usage=core.PlanLimitsSchema.parse({locations:raw.usage.locations,members:raw.usage.members,apiKeys:raw.usage.api_keys,webhooks:raw.usage.webhooks}) as Record<keyof core.PlanLimits,number>
        if(core.planOverages(plan.limits,usage).length)throw new ApiError(412,'failed-precondition','El restaurante supera los límites del nuevo plan.')
        const now=Date.now()
        if(input.serviceUntil!==undefined) {
          if(input.serviceUntil<=now||input.serviceUntil>now+366*86_400_000)throw new ApiError(400,'invalid-argument','La fecha debe ser futura y no superar 366 días.')
          if(!core.canSubscriptionTransition(subscription.status,'active'))throw new ApiError(412,'failed-precondition','Una suscripción cancelada requiere un nuevo contrato.')
          subscription.status='active';subscription.periodEndsAt=input.serviceUntil;subscription.cancelAtPeriodEnd=false
        }
        subscription.planId=plan.id;subscription.planVersion=plan.version;subscription.revision++
        const activeModules=core.platformModules(plan,subscription,input.moduleOverrides,now)
        const deadline=core.subscriptionAllowsService(subscription,now)?subscription.status==='trialing'?subscription.trialEndsAt:subscription.status==='past_due'?subscription.graceEndsAt:subscription.periodEndsAt:now
        await client.query('SELECT llenamos.platform_configure($1,$2,$3,$4,$5,$6,$7)',[input.restaurantId,input.expectedRevision,JSON.stringify(subscription),activeModules,JSON.stringify(input.moduleOverrides),new Date(deadline??now),input.reason])
        await saveIntegrations(client,input.restaurantId,raw.ciphertext,input.integrations,input.removeIntegrations,vault)
        const result={restaurant:administrative((await client.query('SELECT * FROM llenamos.platform_restaurants WHERE restaurant_id=$1',[input.restaurantId])).rows[0])}
        await receipt(client,'configurarRestauranteLogiqd',requestKey,hash,result)
        return result
      }catch(error){return platformError(error)}
    },
  }
}
