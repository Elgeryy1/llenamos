import { onCall, onRequest } from '../identity-call'
import { onSchedule } from 'firebase-functions/v2/scheduler'
import { options, safe } from '../shared'
import { chooseTablePart, createLink, publicThrottle, startPayment, viewCheckout, viewTableParts } from './service'
import { createReceipt, viewReceipt } from './receipts'
import { ingestWebhook, reconcileMobile } from './worker'
import { tenantProviderEnv } from '../providers/tenant'
import { DocIdSchema } from '@llenamos/core'
const tenantOptions = { ...options, secrets: ['PLATFORM_API_MASTER_KEY'] }
export { connectCajaServices } from './backend'

function privateResponse(r: { rawRequest: { res?: { setHeader(name: string, value: string): unknown } } }) {
  r.rawRequest.res?.setHeader('Cache-Control', 'no-store')
  r.rawRequest.res?.setHeader('Referrer-Policy', 'no-referrer')
  r.rawRequest.res?.setHeader('X-Robots-Tag', 'noindex, nofollow')
}

export const crearEnlaceCobro = onCall(options, r => safe(() => createLink(r.data, r)))
export const verCobroPublico = onCall(tenantOptions, r => safe(async () => { privateResponse(r); await publicThrottle(r.data, r); return viewCheckout(r.data) }))
export const iniciarPagoCuenta = onCall(tenantOptions, r => safe(async () => { privateResponse(r); await publicThrottle(r.data, r); return startPayment(r.data) }))
export const crearReciboDigital = onCall(options, r => safe(() => createReceipt(r.data, r)))
export const verReciboDigital = onCall(options, r => safe(async () => { privateResponse(r); await publicThrottle(r.data, r); return viewReceipt(r.data) }))
export const verPartesPagoMesa = onCall(options, r => safe(async () => { privateResponse(r); await publicThrottle(r.data, r); return viewTableParts(r.data) }))
export const elegirPartePagoMesa = onCall(options, r => safe(async () => { privateResponse(r); await publicThrottle(r.data, r); return chooseTablePart(r.data) }))
export const stripeCuentaWebhook = onRequest(tenantOptions, async (request, response) => {
  response.set('Cache-Control', 'no-store')
  if (request.method !== 'POST') { response.status(405).send('Método no permitido.'); return }
  const rid = DocIdSchema.safeParse(request.query.restaurantId)
  const demo = process.env.GCLOUD_PROJECT === 'demo-llenamos' && !!process.env.FIRESTORE_EMULATOR_HOST
  if (!rid.success && !demo) { response.status(400).send('Falta identificar el restaurante.'); return }
  try {
    const env = rid.success ? await tenantProviderEnv(rid.data) : process.env
    response.status(await ingestWebhook(request.rawBody, request.get('stripe-signature') ?? '', env, Date.now(), rid.success ? rid.data : undefined)).send('Recibido.')
  }
  catch { response.status(503).send('No se ha podido guardar el evento.'); }
})
export const reconciliarPagosMoviles = onSchedule({ ...tenantOptions, schedule: 'every 5 minutes' }, async () => { await reconcileMobile() })
