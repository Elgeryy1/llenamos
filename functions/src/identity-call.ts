import { onCall as firebaseOnCall, type CallableOptions, type CallableRequest, type CallableResponse } from 'firebase-functions/v2/https'
import { assertCurrentIdentity } from './identity-security'

export * from 'firebase-functions/v2/https'
/** Frontera para operaciones con sesión. La aceptación pública usa su propio token privado. */
export const onCall: typeof firebaseOnCall = ((options: CallableOptions<unknown>, handler: (request: CallableRequest<unknown>, response?: CallableResponse<unknown>) => unknown) =>
  firebaseOnCall<unknown, Promise<unknown>, unknown>(options, async (request, response) => {
    await assertCurrentIdentity(request)
    return handler(request, response)
  })) as typeof firebaseOnCall
