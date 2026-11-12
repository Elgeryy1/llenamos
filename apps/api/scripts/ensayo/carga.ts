// Prueba de carga del ensayo: 3 restaurantes con meses de histórico y mediciones de operaciones y lecturas en vivo a través de nginx.
// Uso (desde apps/api, con el stack arriba): pnpm exec tsx scripts/ensayo/carga.ts
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as core from '@llenamos/core'
import { BASE, CallError, PROJECT, RUN, call, openStream, requestId, sql, waits, lit } from './lib.js'
import { defaultVolumes, historySql } from './historial.js'
import { slowQueries } from './lentas.js'
import { operatorToken, provision, type Provisioned } from './provision.js'

const stamp = Date.now().toString(36)
const pct = (values: number[], p: number) => { const s = [...values].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : NaN }
interface Row { name: string; n: number; ok: number; p50: number; p95: number; max: number; note?: string }
const rows: Row[] = []
async function measure(name: string, n: number, run: (i: number) => Promise<unknown>, note?: string, concurrency = 1) {
  const times: number[] = [], errors: Record<string, number> = {}
  let next = 0
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < n) {
      const i = next++
      const start = performance.now(), store = { waited: 0 }
      try { await waits.run(store, () => run(i)); times.push(performance.now() - start - store.waited) } catch (e) { const code = e instanceof CallError ? `${e.status}` : (e as Error).message.slice(0, 40); errors[code] = (errors[code] ?? 0) + 1 }
    }
  }))
  const row: Row = { name, n, ok: times.length, p50: Math.round(pct(times, 0.5)), p95: Math.round(pct(times, 0.95)), max: Math.round(Math.max(0, ...times)), ...(Object.keys(errors).length || note ? { note: [note, Object.keys(errors).length ? `errores ${JSON.stringify(errors)}` : ''].filter(Boolean).join('; ') } : {}) }
  rows.push(row)
  console.log(`  ${row.name.padEnd(58)} n=${String(row.n).padStart(3)} ok=${String(row.ok).padStart(3)} p50=${String(row.p50).padStart(5)} ms p95=${String(row.p95).padStart(5)} ms max=${String(row.max).padStart(5)} ms${row.note ? '  ' + row.note : ''}`)
}
/** Tiempo hasta la primera foto de una lectura en vivo (abre, mide y cierra). */
async function firstSnapshot(name: string, token: string, input: unknown) {
  const start = performance.now()
  const stream = await openStream(name, token, input)
  try {
    if (stream.response.status !== 200) throw new CallError(stream.response.status, 'sse', name)
    await stream.until(() => stream.snapshots().length >= 1, 20_000)
    return { ms: performance.now() - start, bytes: stream.snapshots()[0]!.data!.length }
  } finally { await stream.close() }
}

async function main() {
  const operator = await operatorToken()
  console.log('1. Alta de 3 restaurantes por la API')
  const restaurants: Provisioned[] = []
  for (const name of ['uno', 'dos', 'tres']) {
    const start = performance.now()
    restaurants.push(await provision(operator, `carga-${name}-${stamp}`))
    console.log(`  ${name}: ${Math.round(performance.now() - start)} ms`)
  }

  console.log(`2. Histórico: ${defaultVolumes.days} días por restaurante`)
  for (const r of restaurants) {
    const start = performance.now()
    sql(historySql(r.rid, r.loc, r.template.session))
    console.log(`  ${r.slug}: ${Math.round(performance.now() - start)} ms`)
  }
  const counts = sql(`SELECT 'reservas',count(*) FROM llenamos.reservations UNION ALL SELECT 'sesiones',count(*) FROM llenamos.sala_table_sessions UNION ALL SELECT 'lineas',count(*) FROM llenamos.sala_order_lines UNION ALL SELECT 'cuentas',count(*) FROM llenamos.pos_bills UNION ALL SELECT 'cobros',count(*) FROM llenamos.pos_payments UNION ALL SELECT 'clientes',count(*) FROM llenamos.customers UNION ALL SELECT 'eventos',count(*) FROM llenamos.events`)
  console.log(counts.trim().split('\n').map(l => '  ' + l.replace('\t', ': ')).join('\n'))
  const dbSize = sql(`SELECT pg_size_pretty(pg_database_size('llenamos'))`).trim()
  console.log(`  tamaño de la base: ${dbSize}`)

  // Registro de consultas lentas (>20 ms) durante las mediciones.
  sql(`ALTER SYSTEM SET log_min_duration_statement = 20; SELECT pg_reload_conf()`)
  const logStart = new Date().toISOString()

  const [A, B, C] = restaurants as [Provisioned, Provisioned, Provisioned]
  const scope = (r: Provisioned) => ({ restaurantId: r.rid, locationId: r.loc })
  const today = core.horaLocal(Date.now(), 'Europe/Madrid').fecha
  const busyDay = core.sumarDias(today, -2)
  const tomorrow = core.sumarDias(today, 1)

  console.log('3. Lecturas en vivo (primera foto, a través de nginx, restaurante con histórico)')
  const reads: Array<[string, string, (r: Provisioned) => string, unknown]> = [
    ['reservasDia (día con ~45 reservas del histórico)', 'reservasDia', r => r.owner, { date: busyDay }],
    ['reservasDia (mañana)', 'reservasDia', r => r.owner, { date: tomorrow }],
    ['listaEsperaDia', 'listaEsperaDia', r => r.owner, { date: busyDay }],
    ['plano', 'plano', r => r.waiter, {}],
    ['clientes (1500, primera página)', 'clientes', r => r.owner, { __noLocation: true }],
    ['clientes (búsqueda «Cliente 12»)', 'clientes', r => r.owner, { __noLocation: true, search: 'Cliente 12' }],
    ['salaServicio (mesas activas)', 'salaServicio', r => r.waiter, {}],
    ['salaHistorial (con ~7000 sesiones cerradas por local)', 'salaHistorial', r => r.waiter, {}],
    ['salaCarta', 'salaCarta', r => r.waiter, {}],
    ['cocinaLineas (estación cocina)', 'cocinaLineas', r => r.cook, { stationId: '__kitchen__', kind: 'kitchen' }],
    ['cajaCuentas', 'cajaCuentas', r => r.waiter, {}],
    ['cajaHistorial (100 cobros)', 'cajaHistorial', r => r.owner, { limit: 100 }],
    ['cajaTurnos (30 turnos)', 'cajaTurnos', r => r.owner, {}],
  ]
  for (const [label, name, tokenOf, extra] of reads) {
    await measure(`SSE ${label}`, 15, async i => {
      const r = [A, B, C][i % 3]!
      const input = { ...scope(r), ...(extra as object) } as Record<string, unknown>
      if (input.stationId === '__kitchen__') input.stationId = r.stations.kitchen
      if (input.__noLocation) { delete input.__noLocation; delete input.locationId }
      const { ms } = await firstSnapshot(name, tokenOf(r), input)
      if (ms < 0) throw new Error('x')
    })
  }

  console.log('4. Operaciones de escritura (API a través de nginx)')
  await measure('consultarDisponibilidad (pública)', 30, i => call('consultarDisponibilidad', { slug: A.slug, locationId: A.loc, date: tomorrow, partySize: 2 + (i % 4) }, null))
  let seq = 0
  await measure('crearReservaPublica (pública; límite 8/h por IP y restaurante, 8 por restaurante)', 24, i => call('crearReservaPublica', { slug: restaurants[i % 3]!.slug, locationId: restaurants[i % 3]!.loc, date: core.sumarDias(today, 2 + (i % 5)), time: `${13 + (i % 8)}:00`, partySize: 2, guestName: `Carga ${i}`, phone: `+3466${String(1000000 + i * 7 + parseInt(stamp.slice(-3), 36)).slice(0, 7)}`, email: null, language: 'es', guestNotes: '', acceptPolicy: true, source: 'web', website: '' }, null), 'el 9.º intento por IP y restaurante recibe 429')
  await measure('crearReserva (personal)', 25, i => call('crearReserva', { ...scope(C), date: core.sumarDias(today, 3 + (i % 4)), time: `${13 + (i % 8)}:30`, partySize: 2, guestName: `Mostrador ${i}`, phone: `+3467${String(2000000 + i).slice(0, 7)}`, email: null, language: 'es', notes: '', source: 'phone' }, C.waiter))
  const cycleTimes = { open: [] as number[], order: [] as number[], serve: [] as number[], bill: [] as number[], pay: [] as number[], close: [] as number[] }
  async function cycle(r: Provisioned, table: string) {
    const R = scope(r)
    let t = performance.now(); const lap = (key: keyof typeof cycleTimes) => { cycleTimes[key].push(performance.now() - t); t = performance.now() }
    const opened = await call('abrirMesa', { ...R, tableIds: [table], guests: 2 }, r.waiter); lap('open')
    const order = await call('enviarPedido', { ...R, sessionId: opened.sessionId, lines: [{ kind: 'item', itemId: r.items.bravas, quantity: 2 }, { kind: 'item', itemId: r.items.agua, quantity: 1 }], requestId: randomUUID() }, r.waiter); lap('order')
    if (order.status !== 'sent') throw new Error('pedido rechazado')
    const lines = sql(`SELECT id,station_kind FROM llenamos.sala_order_lines WHERE restaurant_id=${lit(r.rid)} AND session_id=${lit(opened.sessionId)}`).trim().split('\n').map(l => l.split('\t'))
    t = performance.now()
    const kitchen = lines.filter(l => l[1] === 'kitchen').map(l => l[0]!)
    if (kitchen.length) { await call('cambiarEstadoLineas', { ...R, lineIds: kitchen, status: 'preparing' }, r.cook); await call('cambiarEstadoLineas', { ...R, lineIds: kitchen, status: 'ready' }, r.cook) }
    await call('cambiarEstadoLineas', { ...R, lineIds: lines.map(l => l[0]!), status: 'served' }, r.waiter); lap('serve')
    const bill = await call('abrirCuenta', { ...R, requestId: requestId('cta'), target: { kind: 'session', id: opened.sessionId } }, r.waiter)
    const prepared = await call('prepararCobro', { ...R, requestId: requestId('prep'), billId: bill.billId, expectedRevision: 1 }, r.waiter)
    const part = (await call('verCuenta', { ...R, billId: bill.billId }, r.waiter)).parts[0]; lap('bill')
    const cash = sql(`SELECT id FROM llenamos.pos_cash_sessions WHERE restaurant_id=${lit(r.rid)} AND status='open' LIMIT 1`).trim()
    await call('registrarCobro', { ...R, requestId: requestId('cobro'), billId: bill.billId, expectedRevision: prepared.revision, partId: part.id, cashSessionId: cash, method: 'cash', amountCents: part.totalCents, tipCents: 0, tenderedCents: part.totalCents }, r.waiter); lap('pay')
    await call('cambiarEstadoMesa', { ...R, sessionId: opened.sessionId, status: 'closed' }, r.waiter); lap('close')
  }
  const cashes = await Promise.all(restaurants.map(r => call('abrirCaja', { ...scope(r), requestId: requestId('caja'), registerId: 'caja-carga', openingCents: 5000 }, r.owner)))
  void cashes
  await measure('ciclo de mesa completo (abrir→pedido→servir→cuenta→cobro→cerrar), secuencial', 18, i => cycle(restaurants[i % 3]!, `t${1 + (i % 12)}`))
  for (const [key, values] of Object.entries(cycleTimes)) rows.push({ name: `  · fase ${key}`, n: values.length, ok: values.length, p50: Math.round(pct(values, 0.5)), p95: Math.round(pct(values, 0.95)), max: Math.round(Math.max(0, ...values)) })
  await measure('ciclo de mesa en paralelo (3 restaurantes × 4 mesas a la vez)', 24, i => cycle(restaurants[i % 3]!, `t${1 + (Math.floor(i / 3) % 12)}`), undefined, 12)

  console.log('5. Concurrencia y tiempo real')
  await measure('lecturas HTTP concurrentes: reservasDia SSE, 24 a la vez', 72, async i => { const r = restaurants[i % 3]!; await firstSnapshot('reservasDia', r.owner, { ...scope(r), date: busyDay }) }, 'límite de nginx: 24 conexiones SSE por IP', 24)
  // Fan-out: 20 pantallas abiertas en un restaurante reciben un cambio.
  {
    const who = [A.waiter, A.owner]
    const streams = await Promise.all(Array.from({ length: 20 }, (_, i) => openStream('salaServicio', who[i % 2]!, scope(A))))
    await Promise.all(streams.map(s => s.until(() => s.snapshots().length >= 1, 20_000)))
    const sent = performance.now()
    await call('abrirMesa', { ...scope(A), tableIds: ['t12'], guests: 2 }, A.waiter)
    await Promise.all(streams.map(s => s.until(() => s.snapshots().length >= 2, 20_000)))
    const lat = streams.map(s => s.snapshots()[1]!.at - sent)
    rows.push({ name: 'fan-out: 20 pantallas ven una mesa nueva', n: 20, ok: 20, p50: Math.round(pct(lat, 0.5)), p95: Math.round(pct(lat, 0.95)), max: Math.round(Math.max(...lat)) })
    console.log(`  fan-out 20 pantallas: p50=${Math.round(pct(lat, 0.5))} ms p95=${Math.round(pct(lat, 0.95))} ms max=${Math.round(Math.max(...lat))} ms`)
    await Promise.all(streams.map(s => s.close()))
  }
  {
    const who = [A.waiter, A.owner, A.cook, B.waiter, B.owner, B.cook]
    const streams = await Promise.all(Array.from({ length: 30 }, (_, i) => openStream('plano', who[i % 6]!, scope(i % 6 < 3 ? A : B)).catch(() => null)))
    const codes = streams.map(s => s?.response.status ?? 0)
    const refused = codes.filter(c => c === 429).length
    console.log(`  30 conexiones SSE desde una IP: ${codes.filter(c => c === 200).length} abiertas, ${refused} rechazadas con 429`)
    rows.push({ name: 'límite de conexiones SSE por IP (nginx live_per_ip 24)', n: 30, ok: codes.filter(c => c === 200).length, p50: 0, p95: 0, max: 0, note: `${refused} con 429` })
    await Promise.all(streams.map(s => s?.close()))
  }
  await measure('escrituras concurrentes sobre el mismo restaurante (pedidos en 12 mesas distintas)', 12, async i => {
    const R = scope(B), opened = await call('abrirMesa', { ...R, tableIds: [`t${1 + i}`], guests: 2 }, B.waiter)
    await call('enviarPedido', { ...R, sessionId: opened.sessionId, lines: [{ kind: 'item', itemId: B.items.agua, quantity: 1 }], requestId: randomUUID() }, B.waiter)
  }, undefined, 12)

  console.log('6. Consultas lentas del registro de PostgreSQL (>20 ms)')
  sql(`ALTER SYSTEM RESET log_min_duration_statement; SELECT pg_reload_conf()`)
  const { slow, groups, top } = slowQueries(logStart)
  const plans: Array<{ ms: number; n: number; statement: string; plan: string }> = []
  for (const g of top) {
    let statement = g.sample.statement
    const params = [...g.sample.params.matchAll(/\$(\d+) = (NULL|'(?:[^']|'')*')/g)]
    for (const [, index, value] of params.sort((a, b) => Number(b[1]) - Number(a[1]))) statement = statement.replaceAll(`$${index}`, value!)
    let plan = ''
    try {
      // Una vuelta con el rol de la API y el mismo contexto de RLS no es reproducible desde fuera; el plan del propietario muestra los índices usados.
      plan = sql(`EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF) ${statement}`).trim()
    } catch { plan = '(no reproducible desde fuera: la sentencia usa el contexto de la transacción)' }
    plans.push({ ms: Math.round(g.max), n: g.n, statement: g.sample.statement.slice(0, 400), plan: plan.split('\n').slice(0, 30).join('\n') })
    console.log(`  ${Math.round(g.max)} ms (x${g.n}, total ${Math.round(g.total)} ms): ${g.sample.statement.slice(0, 140)}`)
  }
  console.log(`  ${slow.length} ejecuciones por encima de 20 ms en ${groups.size} sentencias distintas`)
  writeFileSync(join(RUN, 'carga.json'), JSON.stringify({ stamp, dbSize, counts: counts.trim(), rows, slowTotal: slow.length, plans, volumes: defaultVolumes }, null, 2))
  console.log(`\nResultados en ${join(RUN, 'carga.json')}`)
  void BASE
}
main().catch(e => { console.error(e); process.exit(1) })
