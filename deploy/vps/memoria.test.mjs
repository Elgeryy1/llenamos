// Coherencia de memoria y conexiones del despliegue. Solo lee ficheros: `node --test deploy/vps/memoria.test.mjs`.
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const leer = ruta => readFileSync(new URL(ruta, import.meta.url), 'utf8')
const base = leer('./compose.yaml'), api = leer('./compose.api.yaml'), pg = leer('./compose.postgres.yaml'), worker = leer('./compose.worker.yaml')
const servicio = (texto, nombre) => {
  const inicio = texto.search(new RegExp(`^  ${nombre}:$`, 'm'))
  assert.ok(inicio >= 0, `falta el servicio ${nombre}`)
  const resto = texto.slice(inicio + 1), fin = resto.search(/^  [a-z_]+:$|^[a-z]+:/m)
  return fin < 0 ? resto : resto.slice(0, fin)
}
const mem = bloque => Number(/mem_limit: (\d+)m/.exec(bloque)?.[1])
const heap = bloque => Number(/--max-old-space-size=(\d+)/.exec(bloque)?.[1])

const topes = { web: [servicio(base, 'web'), 256], api: [servicio(api, 'api'), 192], postgres: [servicio(pg, 'postgres'), 384],
  worker: [servicio(worker, 'worker'), 128], gateway: [servicio(base, 'gateway'), 64], tunnel: [servicio(base, 'tunnel'), 64] }

for (const [nombre, [bloque, esperado]] of Object.entries(topes)) {
  test(`${nombre}: tope de ${esperado} MiB`, () => assert.equal(mem(bloque), esperado))
}
for (const nombre of ['web', 'api', 'worker']) {
  test(`${nombre}: el heap de Node queda por debajo del tope con margen para el resto del proceso`, () => {
    const [bloque, tope] = topes[nombre]
    assert.ok(heap(bloque) > 0, 'falta NODE_OPTIONS --max-old-space-size')
    assert.ok(heap(bloque) <= tope * 0.8, `heap ${heap(bloque)} demasiado cerca de ${tope}`)
  })
}
test('el total no pasa de 1100 MiB', () => assert.ok(Object.values(topes).reduce((suma, [bloque]) => suma + mem(bloque), 0) <= 1100))

test('PostgreSQL afinado para un servidor pequeño', () => {
  assert.match(pg, /shared_buffers=128MB/)
  assert.match(pg, /work_mem=2MB/)
  const maxConnections = Number(/max_connections=(\d+)/.exec(pg)?.[1])
  assert.ok(maxConnections >= 25 && maxConnections <= 40, `max_connections=${maxConnections}`)
})

test('los pools de la API, el receptor de webhooks y el worker caben en max_connections', () => {
  const fuente = leer('../../apps/api/src/pools.ts')
  const pool = nombre => {
    const valor = Number(new RegExp(`${nombre}:\\s*(\\d+)`).exec(fuente)?.[1])
    assert.ok(valor >= 1, `apps/api/src/pools.ts no define POOL_MAX.${nombre}`)
    return valor
  }
  const apiMax = pool('api'), webhookMax = pool('webhook'), workerMax = pool('worker')
  for (const fichero of ['main.ts', 'worker-main.ts']) assert.match(leer(`../../apps/api/src/${fichero}`), /POOL_MAX\./, `${fichero} no usa POOL_MAX`)
  const maxConnections = Number(/max_connections=(\d+)/.exec(pg)?.[1])
  const reservadas = 3 // superuser_reserved_connections por defecto
  const holgura = 5 // migraciones, copias y consultas de mantenimiento
  assert.ok(apiMax + webhookMax + workerMax + reservadas + holgura <= maxConnections, `${apiMax}+${webhookMax}+${workerMax} no caben en ${maxConnections}`)
  const concurrencia = Number(/WORKER_CONCURRENCY: (\d+)/.exec(worker)?.[1])
  assert.ok(concurrencia <= workerMax, 'la concurrencia del worker no puede superar su pool')
})
