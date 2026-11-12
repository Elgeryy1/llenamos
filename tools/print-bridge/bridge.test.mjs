import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { sendTcp, handleJob, recover, durableWrite, validateConfig } from './bridge.mjs'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const payload = Buffer.from([27,64,27,116,19,27,69,1,27,97,0,80,114,117,101,98,97,10,27,69,0,27,97,0,10,10,10,29,86,66,0])
const c = { restaurantId: 'demo-lumbre', locationId: 'centro', bridgeId: 'local', token: 'a'.repeat(43), functionsUrl: 'http://127.0.0.1:5012/demo-llenamos/europe-west1', printers: { thermal: { host: '127.0.0.2', port: 9515 } } }
const job = () => ({ id: hash('test'), printerId: 'thermal', payloadBase64: payload.toString('base64'), payloadHash: hash(payload), leaseToken: 'b'.repeat(43), leaseUntil: Date.now()+60000 })
async function dir(t) { const d = await mkdtemp(join(tmpdir(), 'llenamos-print-')); t.after(() => rm(d, { recursive: true, force: true })); return d }

test('TCP falso guarda exactamente los bytes ESC/POS y solo entonces confirma', async t => {
  const d = await dir(t), received = [], saved = join(d, 'tcp.bin')
  // Único puerto TCP de impresora autorizado por el encargo, sin hardware real.
  const server = createServer({ allowHalfOpen: true }, socket => { socket.on('data', b => received.push(b)); socket.on('end', async () => { await writeFile(saved, Buffer.concat(received)); socket.end() }) })
  await new Promise(r => server.listen(9515, '127.0.0.2', r)); t.after(() => new Promise(r => server.close(r)))
  const confirms = []
  const result = await handleJob(c, d, job(), async (_, name, input) => { confirms.push({ name, input }) })
  assert.equal(result, 'printed'); assert.deepEqual(await readFile(saved), payload)
  assert.equal(confirms[0].name, 'confirmarImpresion')
  assert.equal(confirms[0].input.status, 'printed')
  await handleJob(c, d, job(), async () => {}, () => { throw new Error('No debe reenviar') })
  assert.deepEqual(Buffer.concat(received), payload)
})
test('fallo antes de conectar permite solo otro lease explícito', async t => {
  const d = await dir(t), j = job(); let sends = 0
  const transport = async () => { sends++; return { status: 'failed', error: 'Sin conexión.' } }
  await handleJob(c, d, j, async () => {}, transport)
  await handleJob(c, d, j, async () => {}, transport); assert.equal(sends, 1)
  await handleJob(c, d, { ...j, leaseToken: 'c'.repeat(43) }, async () => {}, transport); assert.equal(sends, 2)
})
test('corte incierto y pérdida de confirmación no duplican el envío', async t => {
  const d = await dir(t); let sends = 0
  await assert.rejects(handleJob(c, d, job(), async () => { throw new Error('Se perdió la respuesta') }, async () => { sends++; return { status: 'uncertain', error: 'Corte después de escribir.' } }))
  const statuses = []
  await recover(c, d, async (_, __, v) => statuses.push(v.status))
  await handleJob(c, d, job(), async () => {}, async () => { sends++; throw new Error('No') })
  assert.equal(sends, 1); assert.deepEqual(statuses, ['uncertain'])
})
test('un reinicio con el diario en sending se recupera como incierto', async t => {
  const d = await dir(t), j = job()
  await durableWrite(join(d, `${j.id}.json`), { id: j.id, payloadHash: j.payloadHash, leaseToken: j.leaseToken, status: 'sending', error: null })
  const confirmations = []
  await recover(c, d, async (_, __, v) => confirmations.push(v))
  assert.equal(confirmations[0].status, 'uncertain')
})
test('rechaza hash manipulado, impresora sin mapa y lease casi caducado sin enviar', async t => {
  for (const variant of [{ payloadHash: hash('otro') }, { printerId: 'ausente' }, { leaseUntil: Date.now() }]) {
    const d = await dir(t)
    assert.equal(await handleJob(c, d, { ...job(), ...variant }, async () => {}, () => { throw new Error('No debe enviar') }), 'failed')
  }
})
test('configuración de demo local y excepción TCP de prueba limitada a loopback', () => {
  assert.equal(validateConfig(c), c)
  assert.throws(() => validateConfig({ ...c, functionsUrl: 'https://functions.example.test' }))
  assert.throws(() => validateConfig({ ...c, printers: { p: { host: '192.168.1.5', port: 9515 } } }))
  assert.equal(validateConfig({ ...c, functionsUrl: 'https://functions.example.test', printers: { p: { host: '192.168.1.5', port: 9100 } } }).printers.p.port, 9100)
  assert.throws(() => validateConfig({ ...c, functionsUrl: 'http://public.test' }))
  assert.throws(() => validateConfig({ ...c, printers: { p: { host: 'localhost', port: 80 } } }))
})
test('timeout después de conectar es incierto', async t => {
  const sockets = []
  const server = createServer({ allowHalfOpen: true }, socket => { sockets.push(socket); socket.resume() })
  await new Promise(r => server.listen(9515, '127.0.0.2', r)); t.after(() => { for (const socket of sockets) socket.destroy(); return new Promise(r => server.close(r)) })
  assert.equal((await sendTcp(c.printers.thermal, payload, 30)).status, 'uncertain')
})
