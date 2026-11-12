/** Trabajadores explícitos de la fila 2. Nunca conecta con proyectos ni receptores reales. */
import { createServer, request as httpRequest } from 'node:http'
import { randomUUID } from 'node:crypto'
import { Timestamp } from 'firebase-admin/firestore'
import * as core from '../packages/core/src/index'
import { db } from '../functions/src/shared'
import { measureUsage } from '../functions/src/fase6-api/service'
import { enqueuePlatformEvent, processPlatformWebhooks } from '../functions/src/fase6-api/events'
import { unseal } from '../functions/src/fase6-api/security'
if (process.env.GCLOUD_PROJECT !== 'demo-llenamos' || process.env.FIRESTORE_EMULATOR_HOST !== '127.0.0.1:8097' || process.env.FIREBASE_AUTH_EMULATOR_HOST !== '127.0.0.1:9103') throw new Error('Solo se permite demo-llenamos en la fila 2.')
async function main() {
const mode = process.argv[2], rid = process.argv[3] ?? 'demo-lumbre', root = db.doc(`restaurants/${core.DocIdSchema.parse(rid)}`)
if (mode === 'publicar-demo') {
  const { syncPublicMenu } = await import('../functions/src/fase2/triggers')
  await syncPublicMenu(rid, 'centro')
  console.log('Carta de demo publicada con el servicio existente.')
} else if (mode === 'preparar-demo') {
  if (rid !== 'demo-lumbre') throw new Error('La preparación solo modifica el restaurante de demo.')
  const plan = core.provisionalPlanCatalog().find(p => p.id === 'grupo')!
  // No migra ni activa pagos: configura únicamente límites de integración para la demostración.
  await root.collection('platform').doc('entitlements').set({ version: 1, planId: plan.id, planVersion: plan.version, activeModules: core.restaurantModules((await root.get()).data()!), moduleOverrides: {}, limits: plan.limits, serviceEnabled: true, reason: null, evaluatedAt: Timestamp.now(), nextEvaluationAt: null })
  console.log('Límites provisionales preparados para la demo. No hay suscripción pagada ni cargos.')
} else if (mode === 'medir') {
  let after = ''
  for (;;) {
    let query = db.collection('restaurants').orderBy('__name__').limit(25)
    if (after) query = query.startAfter(after)
    const docs = await query.get()
    for (const doc of docs.docs) await measureUsage(doc.id)
    if (docs.size < 25) break
    after = docs.docs.at(-1)!.id
  }
  console.log('Mediciones actualizadas con su fecha.')
} else if (mode === 'worker') {
  console.log(`Intentos procesados: ${await processPlatformWebhooks(rid)}. Transporte externo bloqueado en emuladores.`)
} else if (mode === 'probar-receptor') {
  const endpointId = 'receptor-local', secret = core.linkToken(crypto.getRandomValues(new Uint8Array(32))), secretRef = root.collection('webhookSecrets').doc(`${endpointId}_1`)
  const { seal } = await import('../functions/src/fase6-api/security')
  await root.collection('webhookEndpoints').doc(endpointId).set({ url: 'https://receptor.llenamos.test/eventos', events: ['order.placed'], locationIds: ['centro'], status: 'active', secretVersion: 1, consecutiveFailures: 0, createdAt: Timestamp.now(), updatedAt: Timestamp.now() })
  await secretRef.set({ ciphertext: seal(secret, secretRef.path), keyVersion: 1, updatedAt: Timestamp.now() })
  const event: core.PlatformEvent = { id: randomUUID(), type: 'order.placed', version: 1, restaurantId: rid, locationId: 'centro', occurredAt: Date.now(), data: { entityId: 'verificacion-local', status: 'accepted' } }
  await db.runTransaction(async tx => enqueuePlatformEvent(tx, event))
  const seen = new Set<string>(); let received = 0
  const receiver = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', b => chunks.push(b)); req.on('end', async () => {
      const body = Buffer.concat(chunks).toString('utf8'), stored = await secretRef.get(), key = unseal<string>(stored.get('ciphertext'), secretRef.path)
      if (!core.verifyPlatformWebhook(key, String(req.headers['llenamos-signature'] ?? ''), body, Date.now())) { res.writeHead(401).end(); return }
      const value = core.PlatformEventSchema.parse(JSON.parse(body)); if (!seen.has(value.id)) { seen.add(value.id); received++ }
      res.writeHead(204).end()
    })
  })
  // Tasks escucha en 127.0.0.1. El receptor de prueba usa otra dirección loopback del mismo puerto asignado.
  await new Promise<void>((resolve, reject) => { receiver.once('error', reject); receiver.listen(9512, '127.0.0.2', resolve) })
  try {
    const transport = async (url: string, body: string, signature: string) => {
      if (url !== 'https://receptor.llenamos.test/eventos') throw new Error('Destino no permitido para el transporte local.')
      return new Promise<number>((resolve, reject) => {
        const req = httpRequest('http://127.0.0.2:9512/eventos', { method: 'POST', headers: { 'Llenamos-Signature': signature, 'Content-Type': 'application/json' }, timeout: 10_000 }, res => { res.resume(); resolve(res.statusCode ?? 500) })
        req.on('timeout', () => req.destroy(new Error('timeout'))); req.on('error', reject); req.end(body)
      })
    }
    await processPlatformWebhooks(rid, transport)
    // Repite exactamente el mismo evento. El receptor no vuelve a aplicarlo.
    const { execute } = await import('../functions/src/fase6-api/service')
    await execute('repetirEntregaWebhook', { restaurantId: rid, requestId: randomUUID(), deliveryId: core.webhookDeliveryId(endpointId, event.id), reason: 'Comprobar deduplicación local' }, { auth: { uid: 'lumbre-propietario', token: {} } } as unknown as Parameters<typeof execute>[2])
    await processPlatformWebhooks(rid, transport)
    if (received !== 1) throw new Error('No se ha deduplicado el evento.')
    console.log('Receptor local: firma válida, dos entregas, un solo efecto.')
  } finally { await new Promise<void>(resolve => receiver.close(() => resolve())) }
} else throw new Error('Uso: plataforma-api-local.ts preparar-demo|medir|worker|probar-receptor [restaurantId]')

}
void main().catch(error => { console.error(error); process.exitCode = 1 })
