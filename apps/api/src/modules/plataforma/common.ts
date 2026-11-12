import { createHash,randomBytes } from 'node:crypto'
import type { PoolClient } from 'pg'
import * as core from '@llenamos/core'
import { ApiError } from '../../errors.js'
import { subscriptionFromRow } from '../../platform/service.js'

export const NOT_CONFIGURED='La facturación de la suscripción no está configurada. No se ha realizado ningún cargo.'
export const hash=(value:unknown)=>createHash('sha256').update(core.canonicalJson(value)).digest('hex')
/** UUID estable a partir de partes: repetir el hecho produce el mismo ID de cola y no duplica el trabajo. */
export function stableUuid(...parts:(string|number)[]):string {
  const h=createHash('sha256').update(JSON.stringify(parts)).digest('hex')
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`
}
export const newId=(prefix:string)=>`${prefix}_${randomBytes(12).toString('hex')}`
const ERRORS:Record<string,[number,string,string]>={
  billing_forbidden:[403,'permission-denied','No tienes permiso para gestionar esta suscripción.'],
  subscription_missing:[412,'failed-precondition','Este restaurante necesita una migración revisada por LogiQD.'],
  billing_pending:[412,'failed-precondition','Hay un cambio de facturación pendiente. Revisa su resultado antes de iniciar otro.'],
  period_changed:[412,'failed-precondition','El periodo ha cambiado. Es necesario reconciliar la suscripción.'],
  trial_used:[412,'failed-precondition','Esta cuenta ya ha utilizado el alta y la prueba. Revisa su restaurante existente.'],
  owner_email_unknown:[412,'failed-precondition','Necesitas un correo de acceso verificado para crear el restaurante.'],
  plan_unavailable:[412,'failed-precondition','El plan no está disponible para nuevas altas.'],
  plan_capacity:[412,'failed-precondition','El plan no permite abrir un restaurante.'],
  plan_immutable:[412,'failed-precondition','La versión ya existe y es inmutable. Publica una versión nueva.'],
  capacity_exceeded:[429,'resource-exhausted','Has alcanzado el límite de tu plan. Revisa el plan antes de añadir más.'],
  usage_missing:[412,'failed-precondition','Faltan los contadores de capacidad. Revisa el restaurante.'],
  checkout_mismatch:[422,'failed-precondition','Checkout no corresponde a la intención guardada.'],
  contract_unbound:[503,'unavailable','El contrato todavía no está vinculado. Reintenta el evento.'],
  event_reordered:[503,'unavailable','Ha llegado otro evento. Reintenta para reconciliar.'],
  restaurant_missing:[404,'not-found','No se encuentra el restaurante.'],
  self_signup_disabled:[403,'permission-denied','El alta de restaurantes la realiza el equipo de LogiQD.'],
  price_reused:[412,'failed-precondition','Ese precio de Stripe ya pertenece a otra versión del catálogo.'],
  invalid_restaurant:[400,'invalid-argument','El nombre o la dirección del restaurante no son válidos.'],
  onboarding_missing:[404,'not-found','No se encuentra el borrador.'],
}
/** Traduce los códigos de las funciones SQL a errores de API; lo desconocido sube como 500 sin detalle. */
export function billingError(error:unknown):never {
  if(error instanceof ApiError)throw error
  const {code,message}=error as {code?:string;message?:string}
  const known=message?ERRORS[message]:undefined
  if(known)throw new ApiError(...known)
  if((error as {constraint?:string}).constraint==='platform_subscriptions_stripe')throw new ApiError(409,'already-exists','Ese contrato de Stripe ya está vinculado a otro restaurante.')
  if(code==='23505')throw new ApiError(409,'already-exists',message==='request_conflict'?'Este identificador ya se usó con otros datos.':'La dirección del restaurante ya está ocupada.')
  if(code==='40001')throw new ApiError(409,'aborted','La suscripción ha cambiado. Actualiza la pantalla.')
  if(code==='42501')throw new ApiError(403,'permission-denied','No tienes permiso para esta operación.')
  if(code==='P0002')throw new ApiError(404,'not-found','No se encuentra el registro.')
  throw error
}
export async function readPlanDefinition(client:PoolClient,id:string,version:number) {
  const {rows}=await client.query('SELECT definition FROM llenamos.platform_plans WHERE id=$1 AND version=$2',[id,version])
  if(!rows[0])throw new ApiError(404,'not-found','No se encuentra esa versión del plan.')
  return core.PlanDefinitionSchema.parse(rows[0].definition)
}
export const subscriptionOf=(row:Record<string,string|number|boolean|null>)=>subscriptionFromRow(row)
/** Misma evaluación que el origen: el acceso nunca sobrevive a un periodo vencido, ni con excepciones de módulo. */
export function evaluate(plan:core.PlanDefinition,subscription:core.Subscription,overrides:core.ModuleOverrides,now:number):core.Entitlements {
  const enabled=core.subscriptionAllowsService(subscription,now)
  const deadline=subscription.status==='trialing'?subscription.trialEndsAt:subscription.status==='past_due'?subscription.graceEndsAt:subscription.status==='active'?subscription.periodEndsAt:null
  const reason=enabled?null:subscription.status==='trialing'?'trial_expired':subscription.status==='past_due'?'payment_required':subscription.status==='active'?(subscription.cancelAtPeriodEnd?'cancelled':'payment_required'):subscription.status
  return core.EntitlementsSchema.parse({version:subscription.revision,planId:plan.id,planVersion:plan.version,activeModules:core.platformModules(plan,subscription,overrides,now),
    moduleOverrides:overrides,limits:plan.limits,serviceEnabled:enabled,reason,evaluatedAt:now,nextEvaluationAt:enabled?deadline:null})
}
/** Recibo idempotente por restaurante, actor, operación y petición. Serializa reintentos simultáneos. */
export async function receipt(client:PoolClient,rid:string,uid:string,operation:string,requestId:string,input:unknown) {
  const key=`${rid}:${uid}:${operation}:${requestId}`,fingerprint=hash(input)
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[key])
  const {rows}=await client.query<{request_hash:string;result:unknown}>('SELECT request_hash,result FROM llenamos.idempotency WHERE restaurant_id=$1 AND actor_uid=$2 AND operation=$3 AND request_key=$4',[rid,uid,operation,requestId])
  if(rows[0]&&rows[0].request_hash!==fingerprint)throw new ApiError(409,'already-exists','Este identificador ya se usó con otros datos.')
  return {result:rows[0]?.result??null,
    save:(result:unknown)=>client.query('INSERT INTO llenamos.idempotency(restaurant_id,actor_uid,operation,request_key,request_hash,result) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',[rid,uid,operation,requestId,fingerprint,JSON.stringify(result)])}
}
