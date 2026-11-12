import { randomUUID } from 'node:crypto'
import { afterAll,beforeEach,describe,expect,it } from 'vitest'
import { Timestamp } from 'firebase-admin/firestore'
import type { CallableRequest } from 'firebase-functions/v2/https'
import * as core from '@llenamos/core'
import { testFiscalRecord } from '../../../packages/core/src/caja/datos-prueba'
import { execute } from './index'
import { processBackup,processDrill,runContinuity } from './worker'
import { db } from '../shared'
import { bucket,decrypt,digest,rootOf } from '../fase6-privacy/infra'
const enabled = process.env.TEST_FIREBASE_EMULATORS === '1'
const req = (owner=true) => ({ auth:{ uid:owner ? 'owner' : 'logiqd',token:{ logiqd:!owner } } }) as unknown as CallableRequest<unknown>
let rid:string
const roots:string[] = [],targets:string[] = []
const mutation = () => ({ restaurantId:rid,requestId:randomUUID() })
async function backup() {
  const result = await execute('crearCopiaSeguridad',{ ...mutation(),reason:'Prueba de recuperación' },req()) as core.CallableOutput<'crearCopiaSeguridad'>
  await processBackup(rid,result.backupId)
  const ref = rootOf(rid).collection('backups').doc(result.backupId)
  expect((await ref.get()).get('status')).toBe('verified')
  return ref
}
async function drill(backupId:string) {
  const result = await execute('simularRestauracion',{ ...mutation(),backupId },req()) as core.CallableOutput<'simularRestauracion'>
  await processDrill(rid,result.drillId)
  const ref = rootOf(rid).collection('restoreDrills').doc(result.drillId), data = (await ref.get()).data()!
  targets.push(data.isolatedTarget)
  return { ref,data }
}
describe.skipIf(!enabled)('Copia y simulacro real de un restaurante', { timeout:120000 },() => {
  beforeEach(async () => {
    rid = `backup-${randomUUID()}`;roots.push(rid)
    await rootOf(rid).set({ name:'Copia local',slug:rid,plan:'completo' })
    await rootOf(rid).collection('members').doc('owner').set({ uid:'owner',displayName:'Propietario',email:'owner@example.test',role:'owner',locationIds:[],active:true })
    await db.doc('users/owner').set({ restaurants:{ [rid]:{ role:'owner' },other:{ role:'manager' } } })
    await db.doc(`publicRestaurants/${rid}`).set({ restaurantId:rid,name:'Copia local' })
    await db.doc(`restaurants/${rid}/locations/centro`).set({ name:'Centro' })
    await bucket().file(`restaurants/${rid}/locations/centro/menu/a/foto.webp`).save(Buffer.from('FOTO_LOCAL'))
  },60000)
  afterAll(async () => {
    for (const id of roots) { await db.recursiveDelete(rootOf(id));await db.doc(`publicRestaurants/${id}`).delete();await bucket().deleteFiles({ prefix:`platform/${id}/` });await bucket().deleteFiles({ prefix:`restaurants/${id}/` }) }
    for (const target of targets) if (target.startsWith('restoreSandbox/')) { await db.recursiveDelete(db.doc(target));await bucket().deleteFiles({ prefix:`restore-drills/${target.split('/')[1]}/` }) }
    await db.doc('users/owner').delete()
  },60000)
  it('solo propietario sin claim LogiQD y el id de petición recupera la misma intención',async () => {
    const d = { ...mutation(),reason:'Operación' }
    await expect(execute('crearCopiaSeguridad',d,req(false))).rejects.toMatchObject({ code:'permission-denied' })
    const a = await execute('crearCopiaSeguridad',d,req()),b = await execute('crearCopiaSeguridad',d,req())
    expect(a).toEqual(b)
  })
  it('restaura aislado, mide RPO y RTO, preserva otro restaurante y pone efectos en cuarentena',async () => {
    await rootOf(rid).collection('messages').doc('pending').set({ status:'queued',to:'correo@example.test' })
    await rootOf(rid).collection('fiscalOutbox').doc('pending').set({ status:'queued',recordId:'pending' })
    await db.doc(`restaurants/${rid}/locations/centro/orderSubmissions/key`).set({ payloadHash:'HASH',result:{ orderId:'o' } })
    const sentinel = db.doc('restaurants/backup-other');await sentinel.set({ totalCents:999 })
    const copy = await backup(),{ data } = await drill(copy.id)
    expect(data.status,data.error).toBe('passed');expect(Object.values(data.checks).every(Boolean)).toBe(true)
    expect(data.measuredRtoMs).toBe(data.completedAt.toMillis()-data.startedAt.toMillis());expect(data.measuredRpoMs).toBeGreaterThanOrEqual(0)
    const local = `${data.isolatedTarget}/restaurants/${rid}`
    expect((await db.doc(`${local}/messages/pending`).get()).get('status')).toBe('restore_quarantine')
    expect((await db.doc(`${local}/fiscalOutbox/pending`).get()).get('restoreDisposition')).toBe('reconcile')
    expect((await db.doc(`${local}/locations/centro/orderSubmissions/key`).get()).get('payloadHash')).toBe('HASH')
    expect((await db.doc(`${data.isolatedTarget}/users/owner`).get()).get('restaurants.other')).toBeUndefined()
    expect((await sentinel.get()).get('totalCents')).toBe(999);expect((await rootOf(rid).collection('messages').doc('pending').get()).get('status')).toBe('queued')
    await sentinel.delete()
  })
  it('aplica tombstones posteriores y no publica exportaciones de la copia antigua',async () => {
    const cid = core.customerIdFor(rid,'+34600000777')
    await rootOf(rid).collection('customers').doc(cid).set({ name:'NO_RESUCITAR',phone:'+34600000777',email:null })
    await db.doc(`restaurants/${rid}/locations/centro/takeaways/t`).set({ customerId:cid,status:'picked_up',guestName:'NO_RESUCITAR',phone:'+34600000777' })
    const copy = await backup()
    await rootOf(rid).collection('customers').doc(cid).delete()
    await rootOf(rid).collection('privacyTombstones').doc(digest(`${rid}:${cid}`)).set({ state:'completed',at:Timestamp.now() })
    const { data } = await drill(copy.id)
    expect(data.status,data.error).toBe('passed')
    const restored = (await db.doc(`${data.isolatedTarget}/restaurants/${rid}/customers/${cid}`).get()).data()
    expect(JSON.stringify(restored)).not.toContain('NO_RESUCITAR');expect(JSON.stringify(restored)).not.toContain('+34600000777')
  })
  it('rechaza archivo manipulado y cadena fiscal rota sin tocar el origen',async () => {
    const copy = await backup(), manifest = (await copy.get()).data()!
    await bucket().file(manifest.files[0].path).save(Buffer.from('CORRUPTO'))
    expect((await drill(copy.id)).data.status).toBe('failed')
    const input = testFiscalRecord()
    await rootOf(rid).collection('fiscalRecords').doc(input.recordId).set({ ...core.prepareFiscalRecord(input),hash:'0'.repeat(64) })
    const broken = await backup()
    const result = await drill(broken.id)
    expect(result.data.status).toBe('failed');expect(result.data.checks.fiscalChains).toBe(false)
  })
  it('deja fuera las credenciales, suspende los webhooks restaurados y conserva el registro de jornada',async () => {
    const local = `restaurants/${rid}`
    await db.doc(`${local}/webhookEndpoints/e1`).set({ url:'https://example.test/hook',events:['order.placed'],locationIds:['centro'],status:'active',secretVersion:1,consecutiveFailures:0 })
    await db.doc(`${local}/webhookSecrets/e1_1`).set({ ciphertext:'SECRETO_WEBHOOK',keyVersion:1 })
    await db.doc(`${local}/locations/centro/staffPins/u1`).set({ hash:'PIN_HASH',salt:'SAL' })
    await db.doc(`${local}/locations/centro/pushSubscriptions/p1`).set({ endpoint:'https://push.example.test/ENDPOINT_PRIVADO',uid:'owner',enabled:true })
    await db.doc(`${local}/locations/centro/timeEntries/t1`).set({ uid:'owner',status:'closed',workedMinutes:480,date:'2026-11-02' })
    await db.doc(`${local}/locations/centro/printJobs/j1`).set({ kind:'prebill',sourceId:'b',status:'queued',payloadBase64:'AAAA',printerId:'p' })
    const copy = await backup(), manifest = (await copy.get()).data()!
    const raw = decrypt((await bucket().file(manifest.files[0].path).download())[0],manifest.files[0].path).toString()
    for (const forbidden of ['SECRETO_WEBHOOK','PIN_HASH','ENDPOINT_PRIVADO']) expect(raw).not.toContain(forbidden)
    expect(raw).toContain('workedMinutes')
    const { data } = await drill(copy.id)
    expect(data.status,data.error).toBe('passed')
    const target = `${data.isolatedTarget}/${local}`
    expect((await db.doc(`${target}/webhookEndpoints/e1`).get()).get('status')).toBe('suspended')
    expect((await db.doc(`${target}/webhookSecrets/e1_1`).get()).exists).toBe(false)
    expect((await db.doc(`${target}/locations/centro/timeEntries/t1`).get()).get('workedMinutes')).toBe(480)
    expect((await db.doc(`${target}/locations/centro/printJobs/j1`).get()).get('status')).toBe('restore_quarantine')
    expect((await db.doc(`${local}/locations/centro/printJobs/j1`).get()).get('status')).toBe('queued')
  })
  it('ejecuta programación diaria y mensual idempotente con salud real',async () => {
    await runContinuity(rid);await runContinuity(rid)
    expect((await rootOf(rid).collection('backups').get()).size).toBe(1)
    expect((await rootOf(rid).collection('restoreDrills').get()).size).toBe(1)
    expect((await rootOf(rid).collection('backupHealth').doc('worker').get()).get('lastRunAt')).toBeTruthy()
  })
})
