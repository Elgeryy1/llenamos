import { describe, expect, it } from 'vitest'
import { currentIdentity } from './identity-security'

describe('Relevo de identidad y tokens previos', () => {
  const user = { disabled: false, tokensValidAfterTime: '2026-11-10T20:00:00Z', customClaims: { sessionVersion: 'new' } }
  const token = { auth_time: Date.parse('2026-11-10T20:00:00Z') / 1000, sessionVersion: 'new' }
  it('acepta la nueva sesión y rechaza el token antiguo aunque su firma siga siendo válida', () => {
    expect(currentIdentity(token, user, { version: 'new', locked: false })).toBe(true)
    expect(currentIdentity({ ...token, sessionVersion: 'old' }, user, { version: 'new', locked: false })).toBe(false)
    expect(currentIdentity({ auth_time: token.auth_time }, user)).toBe(false)
  })
  it('bloquea durante el cambio y al desactivar la cuenta', () => {
    expect(currentIdentity(token, user, { version: 'new', locked: true })).toBe(false)
    expect(currentIdentity(token, { ...user, disabled: true })).toBe(false)
  })
  it('rechaza autenticación anterior a una revocación incluso si conserva el claim', () => {
    expect(currentIdentity({ ...token, auth_time: token.auth_time - 1 }, user)).toBe(false)
  })
})
