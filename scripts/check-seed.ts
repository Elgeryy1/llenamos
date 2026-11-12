import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'
import { setTimeout } from 'node:timers/promises'

process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8085'
process.env.FIREBASE_AUTH_EMULATOR_HOST ||= '127.0.0.1:9099'
initializeApp({ projectId: 'demo-llenamos' })
const db = getFirestore()
async function snapshot() {
  const root = db.doc('restaurants/demo-lumbre')
  const local = root.collection('locations').doc('centro')
  const members = await root.collection('members').get()
  const areas = await local.collection('areas').get()
  const tables = await local.collection('tables').get()
  const reservations = await local.collection('reservations').get()
  const customers = await root.collection('customers').get()
  const waitlist = await local.collection('waitlist').get()
  const references = await root.collection('reservationReferences').get()
  assert.equal(reservations.size, 6)
  assert.equal(customers.size, 6)
  assert.equal(waitlist.size, 1)
  assert.equal(references.size, 6)
  assert.equal((await getAuth().getUserByEmail('equipo@logiqd.test')).customClaims?.logiqd, true)
  assert.equal((await root.collection('locations').get()).size, 1)
  assert.equal(members.size, 6)
  assert.equal(areas.size, 2)
  assert.equal(tables.size, 16)
  const profiles = await Promise.all(members.docs.map(m => db.doc(`users/${m.id}`).get()))
  for (const member of members.docs) {
    const user = await getAuth().getUser(member.id)
    assert.equal(user.email, member.data().email)
    assert.equal(user.displayName, member.data().displayName)
    assert.ok(user.displayName!.split(' ').length >= 2, 'Las cuentas deben tener nombre y apellido.')
  }
  assert.deepEqual([...new Set(tables.docs.map(t => t.data().seats))].sort((a, b) => a - b), [2, 4, 6, 8])
  for (const area of areas.docs) {
    const sameArea = tables.docs.filter(t => t.data().areaId === area.id).map(t => t.data())
    assert.equal(sameArea.length, area.id === 'sala' ? 10 : 6)
    assert.equal(new Set(sameArea.map(t => t.shape)).size, 2)
    assert.ok(sameArea.some(t => t.joinableWith.length === 1))
    if (area.id === 'sala') assert.ok(sameArea.some(t => t.joinableWith.length === 2))
    if (area.id === 'terraza') assert.ok(sameArea.some(t => !t.enabled))
    for (const t of tables.docs.filter(t => t.data().areaId === area.id)) {
      const a = t.data()
      assert.ok(a.x >= 0 && a.y >= 0 && a.x + a.w <= 100 && a.y + a.h <= 100)
      for (const id of a.joinableWith) {
        const other = tables.docs.find(t => t.id === id)
        assert.ok(other && other.id !== t.id && other.data().areaId === area.id)
        assert.ok(other.data().joinableWith.includes(t.id))
      }
    }
    for (const a of sameArea) for (const b of sameArea) {
      if (a === b) continue
      assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y)
    }
  }
  return [(await root.get()), (await local.get()), ...members.docs, ...areas.docs, ...tables.docs, ...profiles, ...reservations.docs, ...customers.docs, ...waitlist.docs, ...references.docs, await local.collection('settings').doc('reservations').get()]
    .map(doc => ({ path: doc.ref.path, data: doc.data() })).sort((a, b) => a.path.localeCompare(b.path))
}
async function main() {
  const run = () => {
    const result = spawnSync('pnpm seed', { shell: true, stdio: 'inherit', env: process.env })
    assert.equal(result.status, 0, 'El seed debe finalizar correctamente.')
  }
  run()
  await setTimeout(3000)
  const before = await snapshot()
  run()
  await setTimeout(1000)
  assert.deepEqual(await snapshot(), before, 'El segundo seed no debe cambiar ni duplicar documentos.')
  // Los disparadores se entregan de forma asíncrona; se espera su resultado observable.
  const activity = db.collection('restaurants/demo-lumbre/activity')
  let actions = new Set<string>()
  for (let attempt = 0; attempt < 60; attempt++) {
    actions = new Set((await activity.get()).docs.map(doc => doc.data().action as string))
    if (['restaurant.created', 'member.created', 'area.created', 'table.created'].every(action => actions.has(action))) break
    await setTimeout(500)
  }
  for (const action of ['restaurant.created', 'member.created', 'area.created', 'table.created']) assert.ok(actions.has(action), `Falta la actividad ${action}.`)
  console.log('Idempotencia comprobada: documentos y fechas estables, 7 cuentas, 16 mesas, 6 reservas, 6 clientes y lista de espera.')
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => db.terminate())
