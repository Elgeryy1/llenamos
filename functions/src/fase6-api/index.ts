import { onCall, onRequest } from '../identity-call'
import { options, safe } from '../shared'
import { execute, type Name } from './service'
import { apiHandler } from './http'
function callable(name: Name) { return onCall({ ...options, secrets: ['PLATFORM_API_MASTER_KEY'] }, request => safe(() => execute(name, request.data, request))) }
export const listarRestaurantesLogiqd = callable('listarRestaurantesLogiqd')
export const verUsoPlataforma = callable('verUsoPlataforma')
export const abrirAccesoSoporte = callable('abrirAccesoSoporte')
export const listarIntegraciones = callable('listarIntegraciones')
export const crearClaveApi = callable('crearClaveApi')
export const revocarClaveApi = callable('revocarClaveApi')
export const guardarWebhook = callable('guardarWebhook')
export const rotarSecretoWebhook = callable('rotarSecretoWebhook')
export const repetirEntregaWebhook = callable('repetirEntregaWebhook')
export const plataformaApi = onRequest({ ...options, cors: false }, apiHandler)
export { enqueuePlatformEvent, distributeEvents, processPlatformWebhooks } from './events'
export { assertIntegrationDestination } from './destination'
