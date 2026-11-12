import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose'
import { identityTokenFromPayload, type IdentityToken } from './auth.js'
import { ApiError, unauthorized } from './errors.js'
import type { InvitationAccount, InvitationAuthAdmin } from './invitations/auth-admin.js'

/**
 * Verificador de tokens de ensayo: dominio de confianza aislado (emisor https://identity.ensayo.invalid/<id>).
 * Un token de ensayo jamás es aceptado por el verificador de producción de Google, y viceversa.
 */
export function rehearsalVerifier(projectId: string, keys: JWTVerifyGetKey) {
  if (!projectId.endsWith('-ensayo') || projectId === 'llenamos-logiqd') {
    throw new Error('projectId de ensayo no válido: debe terminar en -ensayo y no ser el de producción.')
  }
  return async (token: string): Promise<IdentityToken> => {
    try {
      const { payload } = await jwtVerify(token, keys, {
        algorithms: ['RS256'],
        audience: projectId,
        issuer: `https://identity.ensayo.invalid/${projectId}`,
        requiredClaims: ['exp', 'iat', 'sub', 'auth_time'],
      })
      if (payload.aud !== projectId) throw unauthorized()
      return identityTokenFromPayload(payload, Math.floor(Date.now() / 1000))
    } catch {
      throw unauthorized()
    }
  }
}

/**
 * Identidad SOLO DE ENSAYO (deploy/vps/ensayo). Equivale a Firebase Auth sin nube: un servicio propio firma ID tokens RS256 con
 * una clave local y administra cuentas. `configuration()` solo lo activa con NODE_ENV=rehearsal; en producción el proceso no arranca.
 * Se verifican emisor y audiencia propios de ensayo, caducidad y auth_time; solo cambia el origen de las claves públicas.
 */
export function rehearsalIdentity(projectId: string, options: { url: string; secret: string }) {
  const keys = createRemoteJWKSet(new URL('/jwks.json', options.url), { timeoutDuration: 3000, cooldownDuration: 1000, cacheMaxAge: 60_000 })
  return { verify: rehearsalVerifier(projectId, keys), admin: rehearsalInvitationAuth(options.url, options.secret) }
}
export function rehearsalInvitationAuth(origin: string, secret: string, fetcher: typeof fetch = fetch): InvitationAuthAdmin {
  async function call<T>(path: string, init?: { method: string; body: unknown }): Promise<T> {
    let response: Response
    try {
      response = await fetcher(new URL(path, origin), { method: init?.method ?? 'GET', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        ...(init ? { body: JSON.stringify(init.body) } : {}), signal: AbortSignal.timeout(10_000) })
    } catch { throw new ApiError(503, 'unavailable', 'La identidad de ensayo no responde.') }
    if (response.status === 404) throw new ApiError(412, 'failed-precondition', 'No se puede invitar esta cuenta.')
    if (!response.ok) throw new ApiError(response.status === 409 ? 409 : 503, response.status === 409 ? 'aborted' : 'unavailable', 'La identidad de ensayo rechazó la operación.')
    return await response.json() as T
  }
  // Mismas reglas que el adaptador de Firebase: nada de cuentas de plataforma, sin correo o desactivadas.
  const map = (user: { uid: string; email?: string; disabled: boolean; claims?: Record<string, unknown> }): InvitationAccount => {
    if (!user.email || user.disabled || user.claims?.logiqd === true) throw new ApiError(412, 'failed-precondition', 'No se puede invitar esta cuenta.')
    return { uid: user.uid, email: user.email.toLowerCase(), disabled: user.disabled, claims: user.claims ?? {} }
  }
  return {
    async resolveAccount(email, displayName) { return map(await call('/admin/resolve', { method: 'POST', body: { email, displayName } })) },
    async account(uid) { return map(await call(`/admin/account/${encodeURIComponent(uid)}`)) },
    async proveMailbox(uid, email, password, version) {
      const user = map(await call(`/admin/account/${encodeURIComponent(uid)}`))
      if (user.email !== email) throw new ApiError(412, 'failed-precondition', 'La invitación no es válida.')
      return (await call<{ tokensValidAfter: number }>('/admin/prove', { method: 'POST', body: { uid, email, password, version } })).tokensValidAfter
    },
  }
}
