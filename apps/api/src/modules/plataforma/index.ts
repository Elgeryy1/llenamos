import * as core from '@llenamos/core'
import type { Operation } from '../../operations.js'
import type { ModuleDefinition } from '../types.js'
import { completeOnboarding,saveOnboarding } from './alta.js'
import { plataformaWorkerHandlers } from './eventos.js'
import { createApiKey,listIntegrations,replayDelivery,revokeApiKey,rotateWebhookSecret,saveWebhook } from './integraciones.js'
import { billingAction,changeOverrides,publishPlan,viewSubscription } from './suscripcion.js'
import { openSupportAccess,platformUsageList,restaurantUsage } from './uso.js'

const schemas=core.CALLABLE_SCHEMAS_FASE6
const rolesWith=(permission:core.Permission)=>core.ROLES.filter(role=>core.can(role,permission))
const restaurantOf=(input:unknown)=>core.DocIdSchema.parse((input as {restaurantId:string}).restaurantId)
type Name=keyof typeof schemas
type Run=(client:Parameters<Extract<Operation,{access:'platform'|'member'|'account'}>['run']>[0],input:unknown,context:{uid:string})=>Promise<unknown>
/** Con restaurante y suscripción vigente (el servidor lo comprueba). */
const member=(name:Name,permission:core.Permission,run:Run):[string,Operation]=>[name,{access:'member',roles:rolesWith(permission),restaurantId:restaurantOf,input:schemas[name].input,output:schemas[name].output,run}]
/** Con restaurante pero sin exigir suscripción al día: es la vía para ver el plan y pagar. */
const account=(name:Name,permission:core.Permission,run:Run):[string,Operation]=>[name,{access:'account',roles:rolesWith(permission),restaurantId:restaurantOf,input:schemas[name].input,output:schemas[name].output,run}]
const platform=(name:Name,run:Run):[string,Operation]=>[name,{access:'platform',input:schemas[name].input,output:schemas[name].output,run}]

/** Alta por cuenta propia, suscripción y Stripe Billing, API pública con claves, webhooks salientes y uso del plan. */
export const platformModule:ModuleDefinition={
  name:'plataforma',
  // `plataforma.entrega` (envío firmado de webhooks) y `plataforma.evento` (hechos de otros módulos, p. ej. sala).
  workerHandlers:plataformaWorkerHandlers(),
  operations:[
    ['guardarAlta',{access:'account',input:schemas.guardarAlta.input,output:schemas.guardarAlta.output,run:saveOnboarding}],
    ['completarAlta',{access:'account',input:schemas.completarAlta.input,output:schemas.completarAlta.output,run:completeOnboarding}],
    account('verSuscripcion','planes.ver',(client,input)=>viewSubscription(client,input)),
    account('iniciarSuscripcion','planes.gestionar',(client,input,context)=>billingAction(client,'iniciarSuscripcion',input,context)),
    account('abrirPortalFacturacion','planes.gestionar',(client,input,context)=>billingAction(client,'abrirPortalFacturacion',input,context)),
    account('cancelarSuscripcion','planes.gestionar',(client,input,context)=>billingAction(client,'cancelarSuscripcion',input,context)),
    account('verUsoPlataforma','planes.ver',(client,input)=>restaurantUsage(client,input)),
    platform('guardarPlanPlataforma',(client,input)=>publishPlan(client,input)),
    platform('cambiarExcepcionesPlataforma',(client,input)=>changeOverrides(client,input)),
    platform('listarRestaurantesLogiqd',(client,input)=>platformUsageList(client,input)),
    platform('abrirAccesoSoporte',(client,input)=>openSupportAccess(client,input)),
    member('listarIntegraciones','integraciones.gestionar',listIntegrations),
    member('crearClaveApi','integraciones.gestionar',createApiKey),
    member('revocarClaveApi','integraciones.gestionar',revokeApiKey),
    member('guardarWebhook','integraciones.gestionar',saveWebhook),
    member('rotarSecretoWebhook','integraciones.gestionar',rotateWebhookSecret),
    member('repetirEntregaWebhook','integraciones.gestionar',replayDelivery),
  ],
}
export { enqueuePlatformEvent,platformEventId,platformMaintenance,plataformaWorkerHandlers } from './eventos.js'
export { expireDueSubscriptions } from './suscripcion.js'
export { billingWebhookRoute,BILLING_WEBHOOK_PATH,handleBillingEvent,poolRunner } from './webhook.js'
export { publicApiRoute,registerApiReaders } from './api-publica.js'
