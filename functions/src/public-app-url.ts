import { publicAppOrigin } from '@llenamos/core'
import { HttpsError } from 'firebase-functions/v2/https'

export function configuredAppOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const demo = env.GCLOUD_PROJECT?.startsWith('demo-') === true
    && (env.FUNCTIONS_EMULATOR === 'true' || /^127\.0\.0\.1:\d+$/.test(env.FIRESTORE_EMULATOR_HOST ?? ''))
  try { return publicAppOrigin(env.PUBLIC_APP_URL, demo) }
  catch { throw new HttpsError('failed-precondition', 'Falta configurar la dirección segura de la aplicación.') }
}
