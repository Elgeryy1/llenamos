import { afterEach, expect, it, vi } from 'vitest'
import { queuedMessage } from '@llenamos/core'
import { sendMessage } from './send'
const message = () => queuedMessage({ channel: 'whatsapp', to: '+34600000000', template: 'takeaway_ready', language: 'en', data: { guestName: 'Ana', restaurantName: 'Lumbre', reference: 'ABCD23', startAt: Date.UTC(2026, 10, 9, 13), totalCents: 650, manageUrl: 'https://local.test/private', timezone: 'Europe/Madrid' }, reservationId: null, waitlistId: null, sendAt: 0 })
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })
it('no usa texto libre para avisos sin plantilla aprobada de WhatsApp', async () => {
  vi.stubEnv('WHATSAPP_TOKEN', 'test'); vi.stubEnv('WHATSAPP_PHONE_NUMBER_ID', 'test'); vi.stubEnv('WHATSAPP_TEMPLATE_TAKEAWAY_READY', '')
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
  expect((await sendMessage(message(), 'outbox/1', process.env)).status).toBe('not_configured')
  expect(fetcher).not.toHaveBeenCalled()
})
it('envía plantilla configurada con sus seis variables y sin botones de reserva', async () => {
  vi.stubEnv('WHATSAPP_TOKEN', 'test'); vi.stubEnv('WHATSAPP_PHONE_NUMBER_ID', 'test'); vi.stubEnv('WHATSAPP_TEMPLATE_TAKEAWAY_READY', 'pedido_listo')
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ messages: [{ id: 'local-test' }] }) }); vi.stubGlobal('fetch', fetcher)
  expect((await sendMessage(message(), 'outbox/1', process.env)).status).toBe('sent')
  const body = JSON.parse(fetcher.mock.calls[0]![1].body)
  expect(body).toMatchObject({ type: 'template', template: { name: 'pedido_listo', language: { code: 'en_GB' } } })
  expect(body.template.components[0].parameters).toHaveLength(6)
  expect(body.template.components[0].parameters[5].text).toBe('https://local.test/private')
})
