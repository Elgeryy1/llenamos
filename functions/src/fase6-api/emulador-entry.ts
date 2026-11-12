// Entrada local para comprobar esta fila sin editar el registro común del coordinador.
export * from '../index'
export { listarRestaurantesLogiqd, verUsoPlataforma, abrirAccesoSoporte, listarIntegraciones, crearClaveApi, revocarClaveApi, guardarWebhook, rotarSecretoWebhook, repetirEntregaWebhook, plataformaApi } from './index'
// La edición de excepciones de los restaurantes con suscripción la entrega la fila de Billing.
export { cambiarExcepcionesPlataforma } from '../fase6-billing'
