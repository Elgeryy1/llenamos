import { afterEach, expect, it, vi } from 'vitest'
import { queuedMessage } from '@llenamos/core'
import { sendMessage } from './send'
const message = queuedMessage({channel:'email',to:'ana@example.test',language:'es',template:'confirmation',data:{guestName:'Ana'},reservationId:null,waitlistId:null,sendAt:0})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })
it('captura sin proveedor solo en emulador', async () => {
 vi.stubEnv('RESEND_API_KEY',''); vi.stubEnv('FUNCTIONS_EMULATOR','true')
 expect(await sendMessage(message,'key',process.env)).toMatchObject({status:'captured',providerMessageId:null,rendered:{body:expect.stringContaining('Ana')}})
 vi.stubEnv('FUNCTIONS_EMULATOR','false')
 expect(await sendMessage(message,'key',process.env)).toMatchObject({status:'not_configured'})
})
it('no finge envíos y transmite la clave de idempotencia', async () => {
 vi.stubEnv('RESEND_API_KEY','test');vi.stubEnv('EMAIL_FROM','test@example.test')
 const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({id:'mail-1'}),{status:200}))
 vi.stubGlobal('fetch',fetcher)
 expect(await sendMessage(message,'unique',process.env)).toMatchObject({status:'sent',providerMessageId:'mail-1'})
 expect(fetcher.mock.calls[0]?.[1].headers['Idempotency-Key']).toBe('unique')
 fetcher.mockResolvedValue(new Response('',{status:429}))
 await expect(sendMessage(message,'unique',process.env)).rejects.toThrow('429')
})
