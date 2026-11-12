import type { PoolClient } from 'pg'
import * as core from '@llenamos/core'
import { ApiError } from '../../errors.js'
import { NOT_CONFIGURED,billingError,evaluate,hash,readPlanDefinition,subscriptionOf } from './common.js'
import { billingProvider } from './provider.js'

const publicPlan=(plan:core.PlanDefinition)=>core.PublicPlanDefinitionSchema.parse(plan)
type Action='iniciarSuscripcion'|'abrirPortalFacturacion'|'cancelarSuscripcion'

export async function viewSubscription(client:PoolClient,data:unknown) {
  const input=core.VerSuscripcionInputSchema.parse(data)
  try {
    const raw=(await client.query('SELECT llenamos.billing_view($1) AS result',[input.restaurantId])).rows[0].result
    const subscription=subscriptionOf(raw.subscription),plan=core.PlanDefinitionSchema.parse(raw.plan)
    return {subscription,entitlements:evaluate(plan,subscription,core.ModuleOverridesSchema.parse(raw.overrides??{}),Date.now()),plan:publicPlan(plan)}
  }catch(error){return billingError(error)}
}

/**
 * Inicio de suscripción, portal y baja. La clave de la intención (actor, restaurante, acción y petición) es también
 * la clave de idempotencia de Stripe: un reintento tras un corte recibe el mismo objeto externo.
 * La llamada a Stripe crea una sesión o programa una baja al fin del periodo; no cobra. Se hace aquí porque la
 * persona necesita el enlace en la respuesta, y se hace sin bloqueos tomados: el escrito final revalida bajo bloqueo.
 */
export async function billingAction(client:PoolClient,name:Action,data:unknown,context:{uid:string}) {
  const schema=core.CALLABLE_SCHEMAS_FASE6[name]
  const input=schema.input.parse(data) as core.CallableInput<Action>,uid=context.uid,provider=billingProvider()
  const key=hash([uid,input.restaurantId,name,input.requestId]),fingerprint=hash(input)
  try {
    const context_=(await client.query('SELECT llenamos.billing_context($1,$2) AS result',[input.restaurantId,key])).rows[0].result
    const subscription=subscriptionOf(context_.subscription),intent=context_.intent as {fingerprint:string;result:unknown}|null
    if(intent) {
      if(intent.fingerprint.trim()!==fingerprint)throw new ApiError(409,'already-exists','La petición ya se usó con otros datos.')
      if(intent.result)return schema.output.parse(intent.result)
    } else if('expectedRevision' in input&&input.expectedRevision!==subscription.revision)throw new ApiError(409,'aborted','La suscripción ha cambiado. Actualiza la pantalla.')
    const pending=context_.pending as string|null
    if(pending&&pending!==key&&name!=='abrirPortalFacturacion')throw new ApiError(412,'failed-precondition','Hay un cambio de facturación pendiente. Revisa su resultado antes de iniciar otro.')
    let plan=await readPlanDefinition(client,subscription.planId,subscription.planVersion)
    if('planId' in input) {
      plan=await readPlanDefinition(client,input.planId,input.planVersion)
      if(!plan.enabled)throw new ApiError(412,'failed-precondition','Este plan ya no admite contrataciones.')
      const usage=context_.usage
      if(!usage||core.planOverages(plan.limits,{locations:usage.locations,members:usage.members,apiKeys:usage.api_keys,webhooks:usage.webhooks}).length)
        throw new ApiError(412,'failed-precondition','Hay recursos por encima del límite. Desactívalos antes de cambiar de plan.')
    }
    const interval='interval' in input?input.interval:subscription.interval
    const price=name==='iniciarSuscripcion'&&(interval==='month'?plan.stripeMonthlyPriceId:plan.stripeAnnualPriceId)
    const missing=!provider.configured||(name==='iniciarSuscripcion'&&(!price||!price.startsWith('price_')))||(name!=='iniciarSuscripcion'&&!subscription.stripeCustomerId)||(name==='cancelarSuscripcion'&&!subscription.stripeSubscriptionId)
    const commit=async(result:unknown,external:string|null,pending:boolean)=>schema.output.parse((await client.query('SELECT llenamos.billing_intent_commit($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) AS result',
      [input.restaurantId,key,name,fingerprint,'planId' in input?plan.id:null,'planId' in input?plan.version:null,'interval' in input?input.interval:null,'expectedRevision' in input?input.expectedRevision:null,JSON.stringify(result),external,pending])).rows[0].result)
    if(missing)return await commit({status:'not_configured',message:NOT_CONFIGURED},null,false)
    if(name==='iniciarSuscripcion'&&subscription.status==='cancelled')throw new ApiError(412,'failed-precondition','La suscripción está dada de baja. LogiQD debe revisar un nuevo contrato.')
    if(name==='iniciarSuscripcion') {
      const external=await provider.start({restaurantId:input.restaurantId,intentId:key,plan,interval:interval as 'month'|'year',subscription,key})
      return await commit({status:'ready',url:external.url},external.id,true)
    }
    if(name==='abrirPortalFacturacion') {
      const external=await provider.portal(subscription.stripeCustomerId!,key)
      return await commit({status:'ready',url:external.url},null,false)
    }
    const external=await provider.cancel(subscription.stripeSubscriptionId!,key)
    const reason=(input as core.CallableInput<'cancelarSuscripcion'>).reason
    const result={status:'scheduled',endsAt:external.endsAt}
    return schema.output.parse((await client.query('SELECT llenamos.billing_cancel_commit($1,$2,$3,$4,$5,$6,$7) AS result',
      [input.restaurantId,key,fingerprint,(input as core.CallableInput<'cancelarSuscripcion'>).expectedRevision,external.endsAt,JSON.stringify(result),reason])).rows[0].result)
  }catch(error) {
    // Fallos del proveedor (red, 4xx, respuesta inesperada): ningún estado cambia y se puede reintentar con la misma petición.
    if(error instanceof Error&&!(error instanceof ApiError)&&!(error as {code?:string}).code)throw new ApiError(502,'unavailable','No se ha podido completar la petición con el proveedor de facturación. Reintenta en unos minutos.')
    return billingError(error)
  }
}

/** Equipo de plataforma: versiones inmutables del catálogo. Misma versión con el mismo contenido es idempotente. */
export async function publishPlan(client:PoolClient,data:unknown) {
  const input=core.GuardarPlanPlataformaInputSchema.parse(data)
  try {
    const request=hash(input),prior=(await client.query('SELECT llenamos.platform_request($1,$2,$3) AS receipt',['guardarPlanPlataforma',input.requestId,request])).rows[0].receipt
    if(prior)return core.GuardarPlanPlataformaOutputSchema.parse(prior)
    await client.query('SELECT llenamos.billing_plan_publish($1)',[JSON.stringify(input.plan)])
    const result={ok:true as const}
    await client.query('SELECT llenamos.platform_request($1,$2,$3,$4)',['guardarPlanPlataforma',input.requestId,request,JSON.stringify(result)])
    return result
  }catch(error){return billingError(error)}
}

/** Equipo de plataforma: activa o apaga módulos de un restaurante sin tocar su contrato facturado. */
export async function changeOverrides(client:PoolClient,data:unknown) {
  const input=core.CambiarExcepcionesPlataformaInputSchema.parse(data)
  try {
    const request=hash(input),requestKey=hash([input.restaurantId,input.requestId])
    const prior=(await client.query('SELECT llenamos.platform_request($1,$2,$3) AS receipt',['cambiarExcepcionesPlataforma',requestKey,request])).rows[0].receipt
    if(prior)return core.CambiarExcepcionesPlataformaOutputSchema.parse(prior)
    const raw=(await client.query('SELECT llenamos.billing_overrides_read($1) AS result',[input.restaurantId])).rows[0].result
    const subscription=subscriptionOf(raw.subscription),plan=core.PlanDefinitionSchema.parse(raw.plan)
    if(subscription.revision!==input.expectedRevision)throw new ApiError(409,'aborted','La suscripción ha cambiado.')
    const now=Date.now(),next={...subscription,revision:subscription.revision+1}
    const entitlements=evaluate(plan,next,input.moduleOverrides,now)
    await client.query('SELECT llenamos.billing_overrides_commit($1,$2,$3,$4,$5,$6,$7)',[input.restaurantId,input.expectedRevision,JSON.stringify(input.moduleOverrides),entitlements.activeModules,new Date(entitlements.nextEvaluationAt??now),input.reason,`override_${request}`])
    const result={entitlements}
    await client.query('SELECT llenamos.platform_request($1,$2,$3,$4)',['cambiarExcepcionesPlataforma',requestKey,request,JSON.stringify(result)])
    return result
  }catch(error){return billingError(error)}
}

/**
 * Mantenimiento del worker: aplica los vencimientos ya cumplidos (prueba, gracia, periodo) aunque nadie abra el plan.
 * Es idempotente y acotado por `limit`; devuelve cuántos restaurantes ha cerrado.
 */
export async function expireDueSubscriptions(client:Pick<PoolClient,'query'>,limit=100):Promise<number> {
  return (await client.query<{n:number}>('SELECT llenamos.billing_expire_due($1) AS n',[limit])).rows[0]!.n
}
