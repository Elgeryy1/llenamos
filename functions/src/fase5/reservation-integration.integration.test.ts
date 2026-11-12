import { afterAll, describe, expect, it, vi } from 'vitest'
import { Timestamp } from 'firebase-admin/firestore'
import * as core from '@llenamos/core'
import { db } from '../shared'
import { processMessage } from '../messages/process'
import * as provider from '../providers/send'
import { handleWhatsApp } from '../webhooks/whatsapp'

const enabled = process.env.TEST_FIREBASE_EMULATORS === '1' && process.env.GCLOUD_PROJECT === 'demo-llenamos'
const rid = `marketing-hooks-${Date.now()}`, cid = core.customerIdFor(rid, '+34699888000')
const root = db.doc(`restaurants/${rid}`)
afterAll(async () => { if (enabled) await db.recursiveDelete(root) })
describe.skipIf(!enabled)('Guardias comunes de marketing', () => {
  it('cancela al reclamar sin consentimiento y conserva los avisos de servicio', async () => {
    await root.set({ name:'Prueba',slug:rid,plan:'completo' })
    await root.collection('customers').doc(cid).set({ name:'Ana',phone:'+34699888000' })
    const message = core.queuedMessage({ channel:'email',to:'ana@example.test',template:'marketing_campaign',language:'es',data:{ title:'Hola',body:'Volvemos',unsubscribeUrl:'http://localhost/baja' },reservationId:null,waitlistId:null,sendAt:Date.now()-1000 })
    const ref = root.collection('messages').doc('sin-permiso')
    await ref.set({ ...core.messageForWrite(message,Timestamp.fromMillis),customerId:cid,purpose:'marketing_email',campaignId:'c' })
    await processMessage(ref)
    expect((await ref.get()).get('status')).toBe('cancelled')
    expect((await ref.get()).get('attempts')).toBe(0)
    expect((await ref.get()).get('lastError')).toContain('consentimiento')
    const service = root.collection('messages').doc('servicio')
    await service.set(core.messageForWrite({ ...message,template:'confirmation',data:{ guestName:'Ana',restaurantName:'Prueba',startAt:Date.now(),timezone:'Europe/Madrid',reference:'ABCD23',manageUrl:'http://localhost/reserva' } },Timestamp.fromMillis))
    expect(await processMessage(service)).toBe(process.env.FUNCTIONS_EMULATOR === 'true' ? 'captured' : 'not_configured')
  })
  it('STOP sin contexto retira solo WhatsApp una vez y cancela lo pendiente',async () => {
    const at = Date.now()-1000
    for (const purpose of ['marketing_email','marketing_whatsapp'] as const) await root.collection('consents').doc(purpose).set(core.consentForWrite({ customerId:cid,purpose,status:'granted',policyVersion:'1',at,source:'public',evidenceId:'reserva' },Timestamp.fromMillis))
    await root.collection('messages').doc('pendiente-wa').set({ customerId:cid,purpose:'marketing_whatsapp',status:'queued' })
    const payload = { entry:[{ changes:[{ value:{ messages:[{ id:'stop-id',from:'34699888000',text:{ body:' STOP ' } }] } }] }] }
    await handleWhatsApp(payload); await handleWhatsApp(payload)
    const consents = (await root.collection('consents').get()).docs.map(row => core.ConsentSchema.parse(row.data()))
    expect(consents.filter(row => row.status === 'withdrawn')).toHaveLength(1)
    expect(core.hasCurrentConsent(consents,cid,'marketing_email',Date.now())).toBe(true)
    expect(core.hasCurrentConsent(consents,cid,'marketing_whatsapp',Date.now())).toBe(false)
    expect((await root.collection('messages').doc('pendiente-wa').get()).get('status')).toBe('cancelled')
  })
  it('mantiene en espera el marketing cuando su módulo está apagado',async () => {
    const ref = root.collection('messages').doc('modulo-apagado')
    const message = core.queuedMessage({ channel:'email',to:'ana@example.test',template:'marketing_campaign',language:'es',data:{title:'Hola',body:'Vuelve',unsubscribeUrl:'http://localhost/baja'},reservationId:null,waitlistId:null,sendAt:Date.now()-1000 })
    await ref.set({ ...core.messageForWrite(message,Timestamp.fromMillis),customerId:cid,purpose:'marketing_email',campaignId:'c' })
    await root.update({ activeModules:['reservations'] })
    expect(await processMessage(ref)).toBeNull();expect((await ref.get()).get('status')).toBe('queued')
    await root.update({ activeModules:[...core.MODULES] })
  })
  it('libera el lease al terminar un envío cancelado mientras esperaba respuesta',async () => {
    let entered!:()=>void, finish!:()=>void
    const started = new Promise<void>(resolve => { entered=resolve }), gate = new Promise<void>(resolve => { finish=resolve })
    const send = vi.spyOn(provider,'sendMessage').mockImplementation(async () => {
      entered();await gate
      return { status:'captured',rendered:{ subject:null,body:'Prueba local' },provider:null,providerMessageId:null }
    })
    const ref = root.collection('messages').doc('cancelado-durante-envio')
    try {
      await ref.set(core.messageForWrite(core.queuedMessage({ channel:'email',to:'ana@example.test',template:'confirmation',language:'es',data:{},reservationId:null,waitlistId:null,sendAt:Date.now()-1000 }),Timestamp.fromMillis))
      const processing = processMessage(ref)
      await started
      await ref.update({ status:'cancelled' });finish();await processing
      const row = await ref.get()
      expect(row.get('status')).toBe('cancelled');expect(row.get('claim')).toBeUndefined();expect(row.get('leaseUntil')).toBeUndefined()
    } finally { finish();send.mockRestore() }
  })

})
