/** Procesador local. No carga claves de Stripe ni conecta un backend de prueba. */
import { reconcileMobile } from '../functions/src/fase3-mobile/worker'
import { connectCajaServices } from '../functions/src/fase3-mobile/backend'
import { confirmExternalPayment, issuePartInvoice } from '../functions/src/fase3/service'
async function main() {
  if (process.env.GCLOUD_PROJECT !== 'demo-llenamos' || process.env.FIRESTORE_EMULATOR_HOST !== '127.0.0.1:8100') throw new Error('Solo el emulador de la fila 5.')
  connectCajaServices({ confirmExternalPayment, issuePartInvoice })
  process.env.FUNCTIONS_EMULATOR = 'true'
  console.log(await reconcileMobile())
}
void main().catch(e => { console.error(e); process.exitCode = 1 })
