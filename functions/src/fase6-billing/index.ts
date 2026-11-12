import { HttpsError, onCall } from '../identity-call'
import * as core from '@llenamos/core'
import { options, parse, safe, uidOf } from '../shared'
import { billingAction, changeOverrides, listPlans, publishPlan, viewSubscription } from './billing'
import { completeOnboarding, saveOnboarding } from './onboarding'
import { administrativeCreate, administrativeList, administrativeConfigure } from './administration'

const callable = <N extends keyof typeof core.CALLABLE_SCHEMAS_FASE6>(name: N, run: (uid: string, data: core.CallableInput<N>) => Promise<unknown>) => onCall({ ...options, secrets: name === 'configurarRestauranteLogiqd' ? ['PLATFORM_API_MASTER_KEY'] : [] }, request => safe(async () => {
  const platform = core.FASE6_ACCESS[name].permission === 'logiqd'
  const uid = uidOf(request, platform || name === 'listarPlanesDisponibles')
  if (['iniciarSuscripcion', 'cancelarSuscripcion', 'abrirPortalFacturacion'].includes(name))
    throw new HttpsError('permission-denied', 'Los planes y cambios de suscripción los configura LogiQD. Solicita el cambio al equipo.')
  if (core.FASE6_ACCESS[name].permission === 'logiqd' && request.auth?.token.logiqd !== true) throw new HttpsError('permission-denied', 'Solo el equipo de LogiQD puede hacer este cambio.')
  const input = parse<unknown>(core.CALLABLE_SCHEMAS_FASE6[name].input, request.data) as core.CallableInput<N>
  const output = await run(uid, input)
  return core.CALLABLE_SCHEMAS_FASE6[name].output.parse(output) as core.CallableOutput<N>
}))
export const listarPlanesDisponibles = callable('listarPlanesDisponibles', async () => listPlans())
// Es una opción de despliegue: habilitar correo exige volver a desplegar con el secreto real.
export function administrativeSecretBindings(enabled = process.env.PLATFORM_EMAIL_ENABLED === '1') {
  return enabled ? ['PLATFORM_API_MASTER_KEY', 'RESEND_API_KEY'] : ['PLATFORM_API_MASTER_KEY']
}
export const altaRestauranteLogiqd = onCall({ ...options, secrets: administrativeSecretBindings() }, request => safe(async () => {
  const uid = uidOf(request, true)
  if (request.auth?.token.logiqd !== true) throw new HttpsError('permission-denied', 'Solo LogiQD puede dar de alta restaurantes.')
  return administrativeCreate(uid, parse(core.AltaRestauranteLogiqdInputSchema, request.data))
}))
export const listarRestaurantesAdministracion = callable('listarRestaurantesAdministracion', (_uid, input) => administrativeList(input))
export const configurarRestauranteLogiqd = callable('configurarRestauranteLogiqd', administrativeConfigure)
export const guardarAlta = callable('guardarAlta', saveOnboarding)
export const completarAlta = callable('completarAlta', completeOnboarding)
export const verSuscripcion = callable('verSuscripcion', (uid, d) => viewSubscription(uid, d.restaurantId))
export const iniciarSuscripcion = callable('iniciarSuscripcion', (uid, d) => billingAction(uid, 'iniciarSuscripcion', d))
export const abrirPortalFacturacion = callable('abrirPortalFacturacion', (uid, d) => billingAction(uid, 'abrirPortalFacturacion', d))
export const cancelarSuscripcion = callable('cancelarSuscripcion', (uid, d) => billingAction(uid, 'cancelarSuscripcion', d))
export const guardarPlanPlataforma = callable('guardarPlanPlataforma', publishPlan)
export const cambiarExcepcionesPlataforma = callable('cambiarExcepcionesPlataforma', changeOverrides)
export { stripeBillingWebhook } from './webhook'
export { assertPlatformCapacity, refreshPlatformAccess, releasePlatformCapacity } from './context'
