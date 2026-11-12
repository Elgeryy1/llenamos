import { beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeCursor, encodeCursor, seal, unseal } from './security'
import { assertIntegrationDestination, isPublicAddress } from './destination'
beforeEach(() => { vi.stubEnv('PLATFORM_API_MASTER_KEY', 'ab'.repeat(32)) })
describe('Cursores y custodia de integraciones', () => {
  it('vincula cursor al actor, restaurante, local y filtro y rechaza alteración y caducidad', () => {
    const binding = { actor: 'a', rid: 'r', lid: 'l', filter: 'all' }, token = encodeCursor(binding, 'ultimo', 1000)
    expect(decodeCursor(token, binding, 1000)).toBe('ultimo')
    for (const field of ['actor', 'rid', 'lid', 'filter']) expect(() => decodeCursor(token, { ...binding, [field]: 'otro' }, 1000)).toThrow()
    expect(() => decodeCursor(token.slice(0, -1) + 'x', binding, 1000)).toThrow()
    expect(() => decodeCursor(token, binding, 3_601_000)).toThrow()
  })
  it('cifra respuestas y secretos con contexto autenticado y rechaza otra ruta y otra clave', () => {
    const encrypted = seal({ token: 'secreto irrepetible' }, 'r/uno')
    expect(encrypted).not.toContain('secreto')
    expect(unseal(encrypted, 'r/uno')).toEqual({ token: 'secreto irrepetible' })
    expect(() => unseal(encrypted, 'r/otro')).toThrow()
    vi.stubEnv('PLATFORM_API_MASTER_KEY', 'cd'.repeat(32)); expect(() => unseal(encrypted, 'r/uno')).toThrow()
  })
})
describe('Destinos y protección SSRF', () => {
  it.each(['127.0.0.1', '0.0.0.0', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '198.18.0.1', '224.0.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2001:db8::1', '2002:7f00:1::'])('rechaza %s', async ip => {
    expect(isPublicAddress(ip)).toBe(false)
    await expect(assertIntegrationDestination('https://receptor.test', async () => [{ address: ip, family: ip.includes(':') ? 6 : 4 }])).rejects.toMatchObject({ code: 'invalid-argument' })
  })
  it('revalida DNS cada vez y bloquea respuestas mixtas o resolución cambiada', async () => {
    let privateDns = false
    const resolver = async () => [{ address: privateDns ? '127.0.0.1' : '93.184.216.34', family: 4 }]
    expect((await assertIntegrationDestination('https://receptor.test', resolver)).address.address).toBe('93.184.216.34')
    privateDns = true; await expect(assertIntegrationDestination('https://receptor.test', resolver)).rejects.toThrow()
    await expect(assertIntegrationDestination('https://receptor.test', async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }])).rejects.toThrow()
  })
  it.each(['http://example.test', 'https://example.test:8080', 'https://user:pass@example.test', 'https://example.test/#a', 'https://2130706433', 'https://0x7f000001'])('rechaza URL %s', async url => {
    await expect(assertIntegrationDestination(url, async () => [{ address: '93.184.216.34', family: 4 }])).rejects.toThrow()
  })
})
