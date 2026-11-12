import { createHmac } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Timestamp } from 'firebase-admin/firestore'
import { ConsultarDisponibilidadOutputSchema, defaultReservationSettings, reservationForWrite, queuedMessage, messageForWrite, customerIdFor, sha256Hex, horaLocal, sumarDias, instanteDeHoraLocal } from '@llenamos/core'
import { db, stamp } from '../shared'
import { procesarMensajesPendientes } from './process'
import { consultarDisponibilidad, verReservaPublica } from '../reservations'
import { iniciarPagoSenal } from '../deposit/stripe'
import { apuntarseListaEspera, aceptarOfertaListaEspera } from '../waitlist/service'
const enabled = process.env.TEST_R2_EMULATORS === '1' && /^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? '') && process.env.GCLOUD_PROJECT === 'demo-llenamos'
describe.skipIf(!enabled)('R2 con sus emuladores propios', () => {
 beforeAll(() => { process.env.FUNCTIONS_EMULATOR = 'true' })
 const rid = `r2-${Date.now()}`, slug=rid, path=`restaurants/${rid}/locations/centro`
 const startAt=instanteDeHoraLocal(sumarDias(horaLocal(Date.now(),'Europe/Madrid').fecha,2),13*60,'Europe/Madrid')!
 const date=horaLocal(startAt,'Europe/Madrid').fecha
 const base=`http://127.0.0.1:${process.env.FUNCTIONS_PORT ?? '5013'}/demo-llenamos/europe-west1`
 const request=(data:unknown) => ({data,auth:{uid:'r2',token:{logiqd:true}}}) as unknown as Parameters<typeof procesarMensajesPendientes.run>[0]
 afterAll(async () => { await db.recursiveDelete(db.doc(`restaurants/${rid}`));await db.doc(`publicRestaurants/${slug}`).delete() },60000)
 it('captura, procesa un recordatorio vencido, cancela por WhatsApp y ofrece y acepta el hueco',async () => {
  const s=defaultReservationSettings();s.publicBooking=true;s.autoConfirm=true;s.waitlist={enabled:true,offerMinutes:30};s.minNoticeMinutes=0
  for(const day of Object.keys(s.week) as (keyof typeof s.week)[]) s.week[day]=[{name:'comida',from:'13:00',lastEntry:'13:00'}]
  await db.doc(`restaurants/${rid}`).set({name:'R2 restaurante',slug,brandColor:'#f0a35e',currency:'EUR',timezone:'Europe/Madrid',locale:'es',isDemo:true})
  await db.doc(path).set({name:'Centro',slug:'centro',address:'',city:'',phone:''})
  await db.doc(`${path}/settings/reservations`).set(s)
  await db.doc(`${path}/tables/t1`).set({name:'Mesa 1',areaId:'sala',seats:4,shape:'rect',x:0,y:0,w:10,h:10,joinableWith:[],enabled:true})
  await db.doc(`publicRestaurants/${slug}`).set({restaurantId:rid,name:'R2 restaurante',brandColor:'#f0a35e',locale:'es',timezone:'Europe/Madrid',bookingEnabled:true,bookingDisabledReason:null,locations:[{id:'centro',name:'Centro',address:'',city:'',phone:''}],minPartySize:1,maxPartySize:12,maxAdvanceDays:90,deposit:s.deposit,cancellationFreeUntilHours:0})
  const reservation={guestName:'Ana',phone:'+34600000001',email:null,language:'es' as const,partySize:4,startAt,durationMinutes:90,status:'confirmed' as const,tableIds:['t1'],suggestedTableIds:[],suggestionReason:null,source:'web' as const,notes:'',guestNotes:'',customerId:customerIdFor(rid,'+34600000001'),reference:'ABCD23',manageTokenHash:sha256Hex('test'),deposit:{status:'none' as const,amountCents:0,checkoutSessionId:null},history:[],createdBy:null}
  await db.doc(`restaurants/${rid}/reservationReferences/ABCD23`).set({locationId:'centro',reservationId:'book1'})
  await db.doc(`${path}/reservations/book1`).set({...reservationForWrite(reservation,Timestamp.fromMillis),...stamp()})
  const message=queuedMessage({channel:'whatsapp',to:reservation.phone,template:'confirmation',language:'es',data:{guestName:'Ana',startAt},reservationId:'book1',waitlistId:null,sendAt:Date.now()})
  const msg=db.doc(`restaurants/${rid}/messages/wa1`)
  await msg.set({...messageForWrite(message,Timestamp.fromMillis),...stamp()})
  await expect.poll(async () => (await msg.get()).get('status'),{timeout:60000}).toBe('captured')
  expect((await msg.get()).get('rendered.body')).toContain('Ana')
  const reminder=db.doc(`restaurants/${rid}/messages/reminder`)
  await reminder.set({...messageForWrite({...message,template:'reminder',sendAt:Date.now()+3600000},Timestamp.fromMillis),...stamp()})
  await procesarMensajesPendientes.run(request({restaurantId:rid}))
  expect((await reminder.get()).get('status')).toBe('queued')
  await reminder.update({sendAt:Timestamp.fromMillis(Date.now()-1000)})
  expect(await procesarMensajesPendientes.run(request({restaurantId:rid}))).toMatchObject({captured:1})
  const waiting=await apuntarseListaEspera.run(request({slug,locationId:'centro',date,from:'13:00',to:'13:00',partySize:4,guestName:'Luis',phone:'+34600000002',email:'luis@example.test',language:'es',website:''}))
  const raw=JSON.stringify({entry:[{changes:[{value:{messages:[{id:'wa-incoming-1',from:'34600000001',interactive:{button_reply:{id:`${msg.path}:cancel`}}}]}}]}]})
  const signature='sha256='+createHmac('sha256','r2-local-test').update(raw).digest('hex')
  expect((await fetch(`${base}/whatsappWebhook`,{method:'POST',headers:{'Content-Type':'application/json','X-Hub-Signature-256':'bad'},body:raw})).status).toBe(401)
  expect((await fetch(`${base}/whatsappWebhook`,{method:'POST',headers:{'Content-Type':'application/json','X-Hub-Signature-256':signature},body:raw})).status).toBe(200)
  expect((await db.doc(`${path}/reservations/book1`).get()).get('status')).toBe('cancelled')
  const wait=db.doc(`${path}/waitlist/${waiting.waitlistId}`)
  await expect.poll(async () => (await wait.get()).get('status'),{timeout:60000}).toBe('offered')
  const offered=(await db.doc(`restaurants/${rid}/messages/offer_${wait.id}_email`).get()).data()!
  const token=new URL(offered.data.offerUrl).searchParams.get('t')!
  const accepted=await aceptarOfertaListaEspera.run(request({slug,waitlistId:wait.id,token,website:''}))
  expect(accepted.status).toBe('confirmed')
  expect(await verReservaPublica.run(request({slug,reference:accepted.reference,token:accepted.manageToken}))).toMatchObject({reference:accepted.reference,guestName:'Luis',startAt:accepted.startAt,status:'confirmed'})
  await expect(aceptarOfertaListaEspera.run(request({slug,waitlistId:wait.id,token,website:''}))).rejects.toMatchObject({code:'failed-precondition'})
 },120000)
 it('incrementa el bloqueo al aceptar y respeta la oferta propia una sola vez', async () => {
  const offeredDate = sumarDias(date, 1)
  const offeredStart = instanteDeHoraLocal(offeredDate, 13*60, 'Europe/Madrid')!
  const previous = (await db.collection(`${path}/waitlist`).get()).docs[0]!.data()
  const token = 'b'.repeat(43)
  const ref = db.doc(`${path}/waitlist/lock-test`)
  await ref.set({...previous,date:offeredDate,status:'offered',offer:{startAt:Timestamp.fromMillis(offeredStart),expiresAt:Timestamp.fromMillis(Date.now()+600000),tokenHash:sha256Hex(token)}})
  // R1 reserva la capacidad de esta oferta; R2 debe excluirla al aceptarla.
  const slots = ConsultarDisponibilidadOutputSchema.parse(await consultarDisponibilidad.run(request({slug,locationId:'centro',date:offeredDate,partySize:4})))
  expect(slots.slots.every(slot => !slot.available)).toBe(true)
  const lock = db.doc(`${path}/reservationLocks/current`)
  const revision = (await lock.get()).get('revision')
  await aceptarOfertaListaEspera.run(request({slug,waitlistId:ref.id,token,website:''}))
  expect((await lock.get()).get('revision')).toBe(revision+1)
 },90000)
 it('verifica la firma de Stripe, rechaza importe incorrecto y aplica el pago una sola vez',async () => {
  const ref=db.doc(`${path}/reservations/book1`)
  await ref.update({status:'pending',history:[],deposit:{status:'required',amountCents:2000,checkoutSessionId:'cs_test'}})
  // La prueba reinicia el historial a mano; el id del evento sale del largo del historial, así que se limpian los eventos anteriores.
  await db.recursiveDelete(db.collection(`${path.split('/').slice(0,2).join('/')}/platformEvents`))
  const manageToken='a'.repeat(43)
  await ref.update({manageTokenHash:sha256Hex(manageToken)})
  expect(await iniciarPagoSenal.run(request({slug,reference:'ABCD23',token:manageToken}))).toMatchObject({status:'not_configured'})
  vi.stubEnv('STRIPE_SECRET_KEY','test-only');vi.stubEnv('PUBLIC_APP_URL','https://example.test')
  const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({id:'cs_test',url:'https://checkout.stripe.com/test'})))
  vi.stubGlobal('fetch',fetcher)
  try {
   expect(await iniciarPagoSenal.run(request({slug,reference:'ABCD23',token:manageToken}))).toMatchObject({status:'redirect'})
   expect(new URLSearchParams(fetcher.mock.calls[0]?.[1].body).get('line_items[0][price_data][unit_amount]')).toBe('2000')
  } finally {vi.unstubAllGlobals();vi.unstubAllEnvs()}
  const event={id:'evt_test' ,type:'checkout.session.completed',data:{object:{id:'cs_test',metadata:{reservationPath:ref.path},payment_status:'paid',amount_total:2000,currency:'eur'}}}
  const send=async (valid:boolean,amount=2000) => {
   event.data.object.amount_total=amount
   const raw=JSON.stringify(event),t=Math.floor(Date.now()/1000)
   const v1=createHmac('sha256','r2-local-test').update(`${t}.${raw}`).digest('hex')
   return fetch(`${base}/stripeWebhook`,{method:'POST',headers:{'Content-Type':'application/json','Stripe-Signature':valid?`t=${t},v1=${v1}`:'invalid'},body:raw})
  }
  expect((await send(false)).status).toBe(401)
  expect((await send(true,1)).status).toBe(500)
  expect((await ref.get()).get('deposit.status')).toBe('required')
  expect((await send(true)).status).toBe(200)
  expect((await send(true)).status).toBe(200)
  expect((await ref.get()).get('deposit.status')).toBe('paid')
  expect((await ref.get()).get('status')).toBe('confirmed')
  expect((await ref.get()).get('history')).toHaveLength(1)
  await db.doc(`${path}/settings/reservations`).update({'reviews.enabled':true,'reviews.googleReviewUrl':'https://example.test/review'})
  await ref.update({status:'finished'})
  const review=db.doc(`restaurants/${rid}/messages/review_book1_whatsapp`)
  await expect.poll(async () => (await review.get()).exists,{timeout:60000}).toBe(true)
  const local=horaLocal((await review.get()).get('sendAt').toMillis(),'Europe/Madrid')
  expect(local.hora).toBe('12:00')
  expect(local.fecha).toBe(sumarDias(date,1))
 },90000)
})
