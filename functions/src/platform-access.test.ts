import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CallableRequest } from 'firebase-functions/v2/https'
import { uidOf } from './shared'
import { assertLocalOnboarding } from './fase6-billing/onboarding'
import { altaRestauranteLogiqd, configurarRestauranteLogiqd, guardarAlta, iniciarSuscripcion, listarRestaurantesAdministracion } from './fase6-billing'
import { execute } from './fase6-api/service'
import { invitationConfiguration } from './fase6-billing/administration'

const request = (logiqd: boolean, data: unknown = {}) => ({ auth: { uid: logiqd ? 'equipo-logiqd' : 'propietario', token: { logiqd } }, data }) as unknown as CallableRequest<unknown>
afterEach(() => vi.unstubAllEnvs())
beforeEach(() => { vi.stubEnv('GCLOUD_PROJECT', 'demo-llenamos'); vi.stubEnv('FIRESTORE_EMULATOR_HOST', '127.0.0.1:8085') })

describe('Separación de plataforma y operación', () => {
  it('deniega el uid operativo a LogiQD aunque una cuenta conserve membresías antiguas', () => {
    expect(() => uidOf(request(true))).toThrow('no tiene acceso al interior')
    expect(uidOf(request(false))).toBe('propietario')
    expect(uidOf(request(true), true)).toBe('equipo-logiqd')
  })
  it('no permite alta o listado administrativo al propietario manipulando la callable', async () => {
    await expect(altaRestauranteLogiqd.run(request(false))).rejects.toMatchObject({ code: 'permission-denied' })
    await expect(listarRestaurantesAdministracion.run(request(false))).rejects.toMatchObject({ code: 'permission-denied' })
    await expect(configurarRestauranteLogiqd.run(request(false))).rejects.toMatchObject({ code: 'permission-denied' })
  })
  it('cierra el alta de autoservicio fuera de los emuladores de demo', () => {
    vi.stubEnv('GCLOUD_PROJECT', 'llenamos-produccion'); vi.stubEnv('FIRESTORE_EMULATOR_HOST', '')
    expect(assertLocalOnboarding).toThrow('la realiza el equipo de LogiQD')
    vi.stubEnv('GCLOUD_PROJECT', 'demo-llenamos'); vi.stubEnv('FIRESTORE_EMULATOR_HOST', '127.0.0.1:8085')
    expect(assertLocalOnboarding).not.toThrow()
  })
  it('tampoco usa el alta pública con identidad de LogiQD', async () => {
    await expect(guardarAlta.run(request(true))).rejects.toMatchObject({ code: 'permission-denied' })
  })
  it('no deja cambiar el plan con el circuito anterior del propietario', async () => {
    await expect(iniciarSuscripcion.run(request(false))).rejects.toMatchObject({ code: 'permission-denied' })
  })
  it('deniega soporte y métricas operativas a LogiQD antes de consultar datos', async () => {
    await expect(execute('abrirAccesoSoporte', { restaurantId: 'r', requestId: 'req-123456789', reason: 'Prueba de aislamiento', durationMinutes: 30 }, request(true))).rejects.toMatchObject({ code: 'permission-denied' })
    await expect(execute('verUsoPlataforma', { restaurantId: 'r' }, request(true))).rejects.toMatchObject({ code: 'permission-denied' })
  })
  it('no crea una invitación sin custodia, correo y origen HTTPS', () => {
    vi.stubEnv('PUBLIC_APP_URL', 'https://app.llenamos.logiqd.me'); vi.stubEnv('EMAIL_FROM', 'Llenamos <acceso@logiqd.me>')
    vi.stubEnv('RESEND_API_KEY', ''); expect(invitationConfiguration).toThrow('Configura')
    vi.stubEnv('RESEND_API_KEY', 'fixture'); vi.stubEnv('PUBLIC_APP_URL', 'http://app.llenamos.logiqd.me')
    expect(invitationConfiguration).toThrow('HTTPS')
    vi.stubEnv('PUBLIC_APP_URL', 'https://app.llenamos.logiqd.me'); vi.stubEnv('PLATFORM_API_MASTER_KEY', 'a'.repeat(64))
    expect(invitationConfiguration().origin).toBe('https://app.llenamos.logiqd.me')
  })
})
