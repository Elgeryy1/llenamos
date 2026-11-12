export type IdentityState = { version: string; locked: boolean }
/** Reglas compartidas por API VPS y adaptador de transición. No valida firmas JWT. */
export function currentIdentity(token: Record<string, unknown>, user: { disabled: boolean; tokensValidAfterTime?: string; customClaims?: Record<string, unknown> }, state?: IdentityState): boolean {
  if (user.disabled || state?.locked) return false
  const version = state?.version ?? user.customClaims?.sessionVersion
  if (version && token.sessionVersion !== version) return false
  const validAfter = Date.parse(user.tokensValidAfterTime ?? '')
  return !Number.isFinite(validAfter) || (typeof token.auth_time === 'number' && token.auth_time >= Math.floor(validAfter / 1000))
}
