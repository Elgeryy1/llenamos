import { afterEach, describe, expect, it, vi } from 'vitest'
import { mobileCall, privatePath, tipFromText } from './api'
import type { FirebaseSettings } from '@/lib/firebase/config'
const config: FirebaseSettings = { options: { projectId: 'demo-llenamos' }, region: 'europe-west1', emulators: {
  host: '127.0.0.1', ports: { auth: 9106, firestore: 8100, functions: 5016, storage: 9216 },
} }
describe('Cliente público de pago', () => {
  it('convierte propina con coma o punto sin redondear decimales ocultos', () => {
    expect(tipFromText('1,29')).toBe(129)
    expect(tipFromText('0.01')).toBe(1)
    expect(tipFromText('1.999')).toBeNull()
    expect(tipFromText('-1')).toBeNull()
    expect(tipFromText('1e2')).toBeNull()
  })
  it('solo abre enlaces internos de pago o recibo', () => {
    expect(privatePath('/recibo/r/l/id?t=secret', '/recibo/')).toBe('/recibo/r/l/id?t=secret')
    expect(() => privatePath('//evil.test/recibo/id', '/recibo/')).toThrow()
    expect(() => privatePath('/panel/caja', '/recibo/')).toThrow()
  })
  it('valida el contrato y envía datos por POST sin referrer, caché ni credenciales', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ result: { status: 'not_configured', message: 'Sin configurar' } })))
    const input = { slug: 'lumbre', locationId: 'centro', checkoutId: 'private', token: 't'.repeat(43), requestId: 'one', acceptDigitalReceipt: false }
    expect(await mobileCall(config, 'iniciarPagoCuenta', input, fetcher)).toMatchObject({ status: 'not_configured' })
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:5016/demo-llenamos/europe-west1/iniciarPagoCuenta', expect.objectContaining({ method: 'POST', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' }))
    await expect(mobileCall(config, 'iniciarPagoCuenta', { ...input, token: 'bad' }, fetcher)).rejects.toThrow()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  describe('en el VPS', () => {
    afterEach(() => vi.unstubAllEnvs())
    const input = { slug: 'lumbre', locationId: 'centro', checkoutId: 'private', token: 't'.repeat(43) }
    it('llama a la API sin identidad ni cookies, con o sin configuración de Firebase, y valida la salida', async () => {
      vi.stubEnv('NEXT_PUBLIC_DATA_BACKEND', 'postgres')
      const bill = { restaurantName: 'R', locationName: 'L', label: 'Cuenta completa', lines: [], amountCents: 100, expiresAt: 1, status: 'pending', brandColor: '#000', paymentsEnabled: true, tipCents: 0, paidCents: 0, receiptPath: null, invoicePending: false, delivery: 'none' }
      const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ result: bill })))
      expect(await mobileCall(null, 'verCobroPublico', input, fetcher)).toMatchObject({ amountCents: 100, paymentsEnabled: true })
      const [url, init] = fetcher.mock.calls[0]!
      expect(url).toBe('/api/v1/operations/verCobroPublico')
      expect(init).toMatchObject({ method: 'POST', credentials: 'omit', cache: 'no-store' })
      expect((init!.headers as Record<string, string>).Authorization).toBeUndefined()
      fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ result: { amountCents: 'mal' } })))
      await expect(mobileCall(config, 'verCobroPublico', input, fetcher)).rejects.toThrow()
    })
    it('conserva el código de error de la API para que la pantalla lo distinga', async () => {
      vi.stubEnv('NEXT_PUBLIC_DATA_BACKEND', 'postgres')
      const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ error: { code: 'permission-denied', message: 'x', requestId: 'r' } }), { status: 403 }))
      await expect(mobileCall(null, 'verCobroPublico', input, fetcher)).rejects.toMatchObject({ code: 'permission-denied' })
      fetcher.mockRejectedValueOnce(new TypeError('red'))
      await expect(mobileCall(null, 'verCobroPublico', input, fetcher)).rejects.toMatchObject({ code: 'network' })
    })
    it('las partes de la mesa se piden por la misma frontera', async () => {
      vi.stubEnv('NEXT_PUBLIC_DATA_BACKEND', 'postgres')
      const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ result: { restaurantName: 'R', locationName: 'L', brandColor: '#000', billId: 'b', revision: 2, totalCents: 100, parts: [{ id: 'p', label: 'Cuenta completa', amountCents: 100 }] } })))
      const parts = await mobileCall(null, 'verPartesPagoMesa', { slug: 'lumbre', locationId: 'centro', tableId: 'm1', token: 't'.repeat(43) }, fetcher)
      expect(parts.parts[0]!.amountCents).toBe(100)
      expect(fetcher.mock.calls[0]![0]).toBe('/api/v1/operations/verPartesPagoMesa')
    })
  })
})
