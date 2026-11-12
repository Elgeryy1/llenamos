import { HttpsError, type CallableRequest } from 'firebase-functions/v2/https'
import { auth, db } from './shared'
import { currentIdentity, type IdentityState } from '@llenamos/core'
export { currentIdentity, type IdentityState } from '@llenamos/core'

/** Firebase verifica la firma; este paso invalida también ID tokens anteriores al relevo de cuenta. */
export async function assertCurrentIdentity(request: CallableRequest<unknown>, strictEmulatorTest = false) {
  if (!request.auth) return
  if (!strictEmulatorTest && process.env.GCLOUD_PROJECT === 'demo-llenamos' && process.env.FIRESTORE_EMULATOR_HOST) return
  const [user, state] = await Promise.all([auth.getUser(request.auth.uid), db.doc(`identitySecurity/${request.auth.uid}`).get()])
  if (!currentIdentity(request.auth.token, user, state.exists ? state.data() as IdentityState : undefined))
    throw new HttpsError('unauthenticated', 'Tu sesión ha caducado. Vuelve a entrar con tu contraseña actual.')
}
