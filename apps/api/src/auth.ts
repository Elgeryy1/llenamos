import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey, type JWTPayload } from 'jose'
import { unauthorized } from './errors.js'

export interface IdentityToken {
  uid: string
  authTime: number
  sessionVersion: string | null
  platformClaim: boolean
  /** Caducidad del ID token en segundos Unix; los flujos largos no la superan. */
  exp?: number
}
export interface IdentityState {
  sessionVersion: string
  tokensValidAfter: number
  locked: boolean
  disabled: boolean
}
const remoteKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'), {
  timeoutDuration: 5000, cooldownDuration: 30_000, cacheMaxAge: 60 * 60_000,
})
export function identityTokenFromPayload(payload: JWTPayload, now: number): IdentityToken {
  if (typeof payload.sub !== 'string' || !payload.sub.trim() || payload.sub.length > 128
    || !Number.isInteger(payload.auth_time) || Number(payload.auth_time) > now
    || Number(payload.auth_time) < 0 || !Number.isInteger(payload.iat) || Number(payload.iat) > now
    || Number(payload.auth_time) > Number(payload.iat))
    throw unauthorized()
  return { uid: payload.sub, authTime: Number(payload.auth_time),
    sessionVersion: typeof payload.sessionVersion === 'string' ? payload.sessionVersion : null,
    platformClaim: payload.logiqd === true, ...(Number.isInteger(payload.exp) ? { exp: Number(payload.exp) } : {}) }
}
/** Solo ID tokens firmados por SecureToken, nunca JWT decodificados ni claves del header. */
export function firebaseVerifier(projectId: string, keys: JWTVerifyGetKey = remoteKeys) {
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId) || projectId.startsWith('demo-'))
    throw new Error('FIREBASE_PROJECT_ID debe identificar el proyecto real de Auth.')
  return async (token: string): Promise<IdentityToken> => {
    try {
      const { payload } = await jwtVerify(token, keys, {
        algorithms: ['RS256'], audience: projectId, issuer: `https://securetoken.google.com/${projectId}`,
        requiredClaims: ['exp', 'iat', 'sub', 'auth_time'],
      })
      if (payload.aud !== projectId) throw unauthorized()
      return identityTokenFromPayload(payload, Math.floor(Date.now() / 1000))
    } catch { throw unauthorized() }
  }
}
/** SQL es la autoridad operativa. No se permiten sesiones legacy sin bootstrap de identidad. */
export function assertCurrentIdentity(token: IdentityToken, state: IdentityState | null) {
  if (!state || state.disabled || state.locked || !/^[a-f0-9]{32}$/.test(state.sessionVersion)
    || token.sessionVersion !== state.sessionVersion || token.authTime < Math.floor(state.tokensValidAfter / 1000))
    throw unauthorized()
}
export function bearer(header: string | string[] | undefined): string {
  if (typeof header !== 'string' || header.length > 16_384) throw unauthorized()
  const match = /^Bearer ([A-Za-z0-9_.-]+)$/.exec(header)
  if (!match) throw unauthorized()
  return match[1]!
}
