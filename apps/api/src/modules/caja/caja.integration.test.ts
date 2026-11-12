import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, afterEach, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import * as core from '@llenamos/core'
import { apiServer } from '../../server.js'
import type { IdentityToken } from '../../auth.js'
import { migrationSql } from '../../test-migrations.js'
import { registerBillSource, type BillSource } from './source.js'
import { verifyFullChain } from './fiscal.js'
import type { Pos } from './pos.js'

const source = process.env.TEST_POSTGRES_URL
const enabled = process.env.TEST_POSTGRES_API === '1' && !!source
const token = (uid: string, version: string): IdentityToken => ({ uid, sessionVersion: version.repeat(32), authTime: 100, platformClaim: false })
const LINES: core.BillLine[] = [
  { lineId: 'menu', parentLineId: null, name: 'Menú', quantity: 1, grossCents: 1550, taxRate: 10, guest: 1 },
  { lineId: 'extra', parentLineId: 'menu', name: 'Suplemento', quantity: 1, grossCents: 400, taxRate: 10, guest: 1 },
  { lineId: 'vino', parentLineId: null, name: 'Vino', quantity: 1, grossCents: 501, taxRate: 21, guest: 2 },
]
const TOTAL = 2451
const settings = (nif: string, installation = 'inst-1', year = new Date().getFullYear()) => ({
  issuer: { name: 'Bar Prueba', nif, address: 'Calle de prueba 1' },
  system: { producerName: 'Desarrollo de prueba', producerNif: '89890001K', name: 'Llenamos local', id: 'LL', version: 'test', installation, onlyVerifactu: true, multiTaxpayer: true, multipleTaxpayers: false },
  fiscalRegime: 'verifactu', providerId: 'local_test', environment: 'test', ordinarySeriesId: `ordinary_${year}`, rectifyingSeriesId: `rectifying_${year}`, mobilePayments: false,
})

describe.skipIf(!enabled)('Caja SQL: cuentas, cobros, fiscal e impresión', () => {
  let admin: Pool, bootstrap: Pool, app: Pool, owned = false, server: ReturnType<typeof apiServer>, base: string
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12), database = `llenamos_api_test_caja_${suffix}`, runtime = `llenamos_api_caja_${suffix}`
  const consumption = new Map<string, { lines: core.BillLine[]; cancelled: boolean }>()
  const fakeSource: BillSource = { load: async (_c, scope, target) => {
    const found = consumption.get(`${scope.restaurantId}:${scope.locationId}:${target.kind}:${target.id}`)
    return found ? { customerId: null, lines: found.lines, cancelled: found.cancelled } : null
  } }
  const call = async (name: string, data: unknown, actor = 'owner-a') => {
    const response = await fetch(`${base}/v1/operations/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(actor ? { Authorization: `Bearer ${actor}` } : {}) }, body: JSON.stringify({ data }) })
    const body = await response.json() as { result?: any; error?: { code: string } }
    return { status: response.status, result: body.result, code: body.error?.code, body }
  }
  const ok = async (name: string, data: unknown, actor = 'owner-a') => {
    const r = await call(name, data, actor)
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    return r.result
  }
  const A = { restaurantId: 'tenant-a', locationId: 'loc-a' }, B = { restaurantId: 'tenant-b', locationId: 'loc-b' }
  const rid = () => randomUUID().replaceAll('-', '')
  const count = async (table: string, where = 'true') => Number((await admin.query(`SELECT count(*) FROM llenamos.${table} WHERE ${where}`)).rows[0].count)
  let seq = 0
  /** Una cuenta bloqueada lista para cobrar, con su caja abierta. */
  async function lockedBill(scope = A, actor = 'owner-a', register = `reg-${++seq}`) {
    const targetId = `mesa-${++seq}-${rid().slice(0, 6)}`
    consumption.set(`${scope.restaurantId}:${scope.locationId}:session:${targetId}`, { lines: LINES, cancelled: false })
    const cash = await ok('abrirCaja', { ...scope, requestId: rid(), registerId: register, openingCents: 10000 }, actor)
    const opened = await ok('abrirCuenta', { ...scope, requestId: rid(), target: { kind: 'session', id: targetId } }, actor)
    const prepared = await ok('prepararCobro', { ...scope, requestId: rid(), billId: opened.billId, expectedRevision: 1 }, actor)
    const parts = (await ok('verCuenta', { ...scope, billId: opened.billId }, actor)).parts as { id: string; totalCents: number }[]
    return { cashSessionId: cash.cashSessionId as string, billId: opened.billId as string, revision: prepared.revision as number, part: parts[0]!, targetId }
  }
  const pay = (b: Awaited<ReturnType<typeof lockedBill>>, extra: Record<string, unknown> = {}, scope = A, actor = 'owner-a') => call('registrarCobro', {
    ...scope, requestId: rid(), billId: b.billId, expectedRevision: b.revision, partId: b.part.id, cashSessionId: b.cashSessionId, method: 'cash', amountCents: TOTAL, tipCents: 0, tenderedCents: TOTAL, ...extra }, actor)

  beforeAll(async () => {
    registerBillSource(fakeSource)
    const url = new URL(source!)
    if (!['localhost', '127.0.0.1'].includes(url.hostname) || !url.pathname.startsWith('/llenamos_api_test_')) throw new Error('Solo PostgreSQL temporal loopback de pruebas.')
    bootstrap = new Pool({ connectionString: source, max: 1 })
    await bootstrap.query(`CREATE DATABASE ${database}`); owned = true
    url.pathname = `/${database}`
    admin = new Pool({ connectionString: url.toString(), max: 2 })
    for (const sql of migrationSql()) await admin.query(sql)
    await admin.query(`CREATE ROLE ${runtime} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD 'fixture-only' IN ROLE llenamos_app`)
    url.username = runtime; url.password = 'fixture-only'; app = new Pool({ connectionString: url.toString(), max: 8, statement_timeout: 8000 })
    const people: [string, string, string, string][] = [['owner-a', 'b', 'tenant-a', 'owner'], ['waiter-a', 'c', 'tenant-a', 'waiter'], ['kitchen-a', 'd', 'tenant-a', 'kitchen'], ['owner-b', 'e', 'tenant-b', 'owner'], ['waiter-b', 'f', 'tenant-b', 'waiter'], ['owner-c', 'a', 'tenant-c', 'owner']]
    for (const [uid, version] of people) await admin.query('INSERT INTO llenamos.identities(uid,session_version,tokens_valid_after,locked,platform_operator) VALUES($1,$2,to_timestamp(100),false,false)', [uid, version.repeat(32)])
    for (const [rid_, loc] of [['tenant-a', 'loc-a'], ['tenant-b', 'loc-b'], ['tenant-c', 'loc-c']]) {
      await admin.query("INSERT INTO llenamos.restaurants(id,name,slug,plan,active_modules,is_demo) VALUES($1,$2,$1,'completo',$3,$4)", [rid_, `Restaurante ${rid_}`, [...core.MODULES], rid_ !== 'tenant-b'])
      await admin.query('INSERT INTO llenamos.locations(restaurant_id,id,name,slug) VALUES($1,$2,$2,$2)', [rid_, loc])
    }
    for (const [uid, , tenant, role] of people) await admin.query('INSERT INTO llenamos.memberships(restaurant_id,uid,role,active,display_name,email) VALUES($1,$2::text,$3,true,$2::text,$4)', [tenant, uid, role, `${uid}@example.test`])
    const identities = Object.fromEntries(people.map(([uid, version]) => [uid, token(uid, version)]))
    server = apiServer(app, async value => identities[value] ?? token(value, 'z'), entry => { if (process.env.DEBUG_CAJA) console.error(JSON.stringify(entry)) })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('address')
    base = `http://127.0.0.1:${address.port}`
  }, 60_000)
  afterEach(() => { delete process.env.LLENAMOS_FISCAL_TEST_MODE })
  afterAll(async () => {
    registerBillSource(null)
    server?.closeAllConnections(); if (server) await new Promise<void>(resolve => server.close(() => resolve()))
    await app?.end(); await admin?.end()
    for (const pool of [app, admin]) pool?.on('error', error => { if ((error as { code?: string }).code !== '57P01') throw error })
    if (owned) { await bootstrap.query(`DROP DATABASE ${database} WITH(FORCE)`); await bootstrap.query(`DROP ROLE IF EXISTS ${runtime}`) }
    await bootstrap?.end()
  })

  describe('caja', () => {
    it('abre, mueve y cierra con diferencia que exige motivo; una sola apertura por terminal', async () => {
      const cash = await ok('abrirCaja', { ...A, requestId: rid(), registerId: 'solo', openingCents: 5000 })
      expect((await call('abrirCaja', { ...A, requestId: rid(), registerId: 'solo', openingCents: 1 })).code).toBe('failed-precondition')
      await ok('registrarMovimientoCaja', { ...A, requestId: rid(), cashSessionId: cash.cashSessionId, kind: 'in', amountCents: 500, reason: 'Cambio' })
      await ok('registrarMovimientoCaja', { ...A, requestId: rid(), cashSessionId: cash.cashSessionId, kind: 'out', amountCents: 200, reason: 'Hielo' })
      expect((await call('cerrarCaja', { ...A, requestId: rid(), cashSessionId: cash.cashSessionId, countedCents: 5000, reason: null })).status).toBe(412)
      const closed = await ok('cerrarCaja', { ...A, requestId: rid(), cashSessionId: cash.cashSessionId, countedCents: 5000, reason: 'Faltan 3 euros' })
      expect(closed.cashSession).toMatchObject({ expectedCents: 5300, differenceCents: -300, status: 'closed' })
      expect((await call('registrarMovimientoCaja', { ...A, requestId: rid(), cashSessionId: cash.cashSessionId, kind: 'in', amountCents: 1, reason: 'Tarde' })).status).toBe(412)
      await ok('abrirCaja', { ...A, requestId: rid(), registerId: 'solo', openingCents: 0 }) // tras cerrar, el terminal vuelve a abrirse
    })
    it('misma petición devuelve el mismo resultado sin duplicar; otra carga con la misma clave se rechaza', async () => {
      const input = { ...A, requestId: rid(), registerId: `idem-${rid()}`, openingCents: 100 }
      const first = await ok('abrirCaja', input), second = await ok('abrirCaja', input)
      expect(second).toEqual(first)
      expect(await count('pos_cash_sessions', `id='${first.cashSessionId}'`)).toBe(1)
      expect((await call('abrirCaja', { ...input, openingCents: 999 })).status).toBe(409)
    })
    it('el camarero no abre caja ni mueve efectivo, cocina no entra; otro restaurante no ve nada', async () => {
      const input = { ...A, requestId: rid(), registerId: 'prohibida', openingCents: 0 }
      expect((await call('abrirCaja', input, 'waiter-a')).status).toBe(403)
      expect((await call('abrirCaja', input, 'kitchen-a')).status).toBe(403)
      expect((await call('abrirCaja', input, 'owner-b')).status).toBe(403)
      expect((await call('abrirCaja', { ...B, requestId: rid(), registerId: 'prohibida', openingCents: 0 }, 'owner-a')).status).toBe(403)
    })
    it('desactivar el módulo bloquea las operaciones', async () => {
      await admin.query("UPDATE llenamos.restaurants SET active_modules='{reservations}' WHERE id='tenant-b'")
      try { expect((await call('abrirCaja', { ...B, requestId: rid(), registerId: 'x', openingCents: 0 }, 'owner-b')).status).toBe(412) }
      finally { await admin.query('UPDATE llenamos.restaurants SET active_modules=$1 WHERE id=\'tenant-b\'', [[...core.MODULES]]) }
    })
  })

  describe('cuentas y cobros', () => {
    it('abrir, ajustar, dividir, bloquear y cobrar en dos partes; cada céntimo conservado', async () => {
      const targetId = `mesa-${rid()}`
      consumption.set(`tenant-a:loc-a:session:${targetId}`, { lines: LINES, cancelled: false })
      const cash = await ok('abrirCaja', { ...A, requestId: rid(), registerId: `r-${rid()}`, openingCents: 0 })
      const opened = await ok('abrirCuenta', { ...A, requestId: rid(), target: { kind: 'session', id: targetId } })
      expect(opened.bill.totalCents).toBe(TOTAL)
      expect((await ok('abrirCuenta', { ...A, requestId: rid(), target: { kind: 'session', id: targetId } })).billId).toBe(opened.billId) // una cuenta por destino
      expect((await call('ajustarCuenta', { ...A, requestId: rid(), billId: opened.billId, expectedRevision: 1, lineId: 'vino', kind: 'invitation', amountCents: 101, reason: 'Cortesía' }, 'waiter-a')).status).toBe(403)
      const adjusted = await ok('ajustarCuenta', { ...A, requestId: rid(), billId: opened.billId, expectedRevision: 1, lineId: 'vino', kind: 'invitation', amountCents: 101, reason: 'Cortesía' })
      expect(adjusted).toMatchObject({ revision: 2, totalCents: TOTAL - 101 })
      expect((await call('dividirCuenta', { ...A, requestId: rid(), billId: opened.billId, expectedRevision: 1, split: { kind: 'equal', parts: 2 } })).status).toBe(412) // revisión vieja
      const split = await ok('dividirCuenta', { ...A, requestId: rid(), billId: opened.billId, expectedRevision: 2, split: { kind: 'equal', parts: 3 } })
      expect(split.parts.reduce((s: number, p: { totalCents: number }) => s + p.totalCents, 0)).toBe(TOTAL - 101)
      const locked = await ok('prepararCobro', { ...A, requestId: rid(), billId: opened.billId, expectedRevision: split.revision })
      for (const p of split.parts) {
        const r = await ok('registrarCobro', { ...A, requestId: rid(), billId: opened.billId, expectedRevision: locked.revision, partId: p.id, cashSessionId: cash.cashSessionId, method: 'cash', amountCents: p.totalCents, tipCents: 50, tenderedCents: p.totalCents + 50 + 25 }, 'waiter-a')
        expect(r.changeCents).toBe(25)
      }
      const seen = await ok('verCuenta', { ...A, billId: opened.billId })
      expect(seen.bill).toMatchObject({ status: 'settled', paidCents: TOTAL - 101 })
      expect((await call('desbloquearCuenta', { ...A, requestId: rid(), billId: opened.billId, expectedRevision: locked.revision, reason: 'Error' })).status).toBe(412)
    })
    it('sin origen de consumo no se abre cuenta ni se inventa (not-deployed)', async () => {
      registerBillSource(null)
      try { expect((await call('abrirCuenta', { ...A, requestId: rid(), target: { kind: 'session', id: 'cualquiera' } })).code).toBe('not-deployed') }
      finally { registerBillSource(fakeSource) }
    })
    it('no hay doble cobro: repetir la petición devuelve el mismo pago; cobrar de más o con otra clave se rechaza', async () => {
      const b = await lockedBill()
      const request = { ...A, requestId: rid(), billId: b.billId, expectedRevision: b.revision, partId: b.part.id, cashSessionId: b.cashSessionId, method: 'cash', amountCents: TOTAL, tipCents: 0, tenderedCents: TOTAL }
      const first = await call('registrarCobro', request), again = await call('registrarCobro', request)
      expect(first.status).toBe(200); expect(again.result).toEqual(first.result)
      expect(await count('pos_payments', `bill_id='${b.billId}'`)).toBe(1)
      expect((await pay(b)).status).toBe(412) // la parte ya está saldada
      expect(await count('pos_payments', `bill_id='${b.billId}'`)).toBe(1)
    })
    it('cobros simultáneos del mismo saldo: solo uno entra', async () => {
      const b = await lockedBill()
      const results = await Promise.all(Array.from({ length: 6 }, () => pay(b)))
      expect(results.filter(r => r.status === 200)).toHaveLength(1)
      expect(await count('pos_payments', `bill_id='${b.billId}'`)).toBe(1)
      expect(await count('pos_print_requests', `kind='drawer' AND source_id='${results.find(r => r.status === 200)!.result.paymentId}'`)).toBe(1)
    })
    it('tarjeta exige referencia y no admite repetirla en otro cobro; la señal exige una sesión con reserva', async () => {
      const b = await lockedBill()
      expect((await pay(b, { method: 'card', tenderedCents: 0, terminalReference: null })).status).toBe(400)
      const ref = `TPV-${rid()}`
      const first = await pay(b, { method: 'card', tenderedCents: 0, amountCents: 1000, terminalReference: ref })
      expect(first.status, JSON.stringify(first.body)).toBe(200)
      expect((await pay(b, { method: 'card', tenderedCents: 0, amountCents: 500, terminalReference: ref })).status).toBe(412)
      expect((await pay(b, { method: 'deposit', tenderedCents: 0, amountCents: 100 })).code).toBe('failed-precondition')
    })
    it('devoluciones: no exceden el cobro, salen de la caja abierta del terminal y no se repiten', async () => {
      const b = await lockedBill(A, 'owner-a', `ref-${rid()}`)
      const paid = (await pay(b, { tipCents: 100, tenderedCents: TOTAL + 100 })).result
      const refund = { ...A, requestId: rid(), paymentId: paid.paymentId, amountCents: 1000, tipCents: 0, reason: 'Plato frío' }
      expect((await call('devolverCobro', refund, 'waiter-a')).status).toBe(403)
      const first = await ok('devolverCobro', refund)
      expect(first.status).toBe('succeeded')
      expect(await ok('devolverCobro', refund)).toEqual(first)
      expect(await count('pos_payments', "kind='refund' AND original_payment_id='" + paid.paymentId + "'")).toBe(1)
      expect((await call('devolverCobro', { ...refund, requestId: rid(), amountCents: TOTAL })).status).toBe(412)
      expect((await ok('verCuenta', { ...A, billId: b.billId })).bill.refundedCents).toBe(1000)
    })
    it('arqueo y propinas: reparto con propina neta de devoluciones, se paga una sola vez', async () => {
      const register = `tips-${rid()}`
      const b = await lockedBill(A, 'owner-a', register)
      const paid = (await pay(b, { tipCents: 300, tenderedCents: TOTAL + 300 })).result
      await ok('devolverCobro', { ...A, requestId: rid(), paymentId: paid.paymentId, amountCents: 0, tipCents: 100, reason: 'Propina errónea' })
      const closeInput = (counted: number) => ({ ...A, requestId: rid(), cashSessionId: b.cashSessionId, countedCents: counted, reason: 'Ajuste' })
      const closed = await ok('cerrarCaja', closeInput(10000 + TOTAL + 300 - 100))
      expect(closed.cashSession.differenceCents).toBe(0)
      const hours = [{ uid: 'owner-a', minutes: 60 }, { uid: 'waiter-a', minutes: 180 }]
      const dist = await ok('repartirPropinas', { ...A, requestId: rid(), cashSessionId: b.cashSessionId, hours })
      expect(dist.shares.reduce((s: number, x: { amountCents: number }) => s + x.amountCents, 0)).toBe(200)
      expect((await call('repartirPropinas', { ...A, requestId: rid(), cashSessionId: b.cashSessionId, hours })).status).toBe(412)
      expect((await call('repartirPropinas', { ...A, requestId: rid(), cashSessionId: b.cashSessionId, hours: [{ uid: 'owner-b', minutes: 10 }] })).status).toBe(412)
    })
    it('aislamiento: el otro restaurante no cobra ni lee cuentas ajenas', async () => {
      const b = await lockedBill()
      expect((await pay(b, {}, A, 'owner-b')).status).toBe(403)
      expect((await call('verCuenta', { ...A, billId: b.billId }, 'owner-b')).status).toBe(403)
      expect((await call('verCuenta', { ...B, billId: b.billId }, 'owner-b')).status).toBe(404)
    })
    it('RLS: el rol de ejecución no ve filas sin contexto ni modifica pagos, facturas o registros fiscales', async () => {
      expect((await app.query('SELECT 1 FROM llenamos.pos_bills')).rowCount).toBe(0)
      await expect(app.query("UPDATE llenamos.pos_invoices SET number='x'")).rejects.toThrow()
      await expect(app.query('DELETE FROM llenamos.pos_fiscal_records')).rejects.toThrow()
      await expect(app.query('DELETE FROM llenamos.pos_payments')).rejects.toThrow()
    })
  })

  describe('fiscal', () => {
    it('sin proveedor fiscal falla con su código y no consume correlativo', async () => {
      expect((await call('guardarConfiguracionCaja', { ...A, requestId: rid(), settings: settings('B12345674') })).code).toBe('not-configured')
      const b = await lockedBill()
      await pay(b)
      const r = await call('emitirFactura', { ...A, requestId: rid(), billId: b.billId, expectedRevision: b.revision, partId: b.part.id, type: 'F2', recipient: null, qualifiedSimplified: false })
      expect(r.status).toBe(412)
      expect(await count('pos_invoices', `bill_id='${b.billId}'`)).toBe(0)
    })
    it('el modo de prueba fiscal solo existe en restaurantes de demostración', async () => {
      process.env.LLENAMOS_FISCAL_TEST_MODE = '1'
      expect((await call('guardarConfiguracionCaja', { ...B, requestId: rid(), settings: settings('B12345674', 'no-demo') }, 'owner-b')).code).toBe('not-configured')
    })
    it('emite una sola factura por parte aun con peticiones simultáneas, con cadena íntegra y correlativos seguidos', async () => {
      process.env.LLENAMOS_FISCAL_TEST_MODE = '1'
      await ok('guardarConfiguracionCaja', { ...A, requestId: rid(), settings: settings('B12345674') })
      const emit = (b: Awaited<ReturnType<typeof lockedBill>>) => call('emitirFactura', { ...A, requestId: rid(), billId: b.billId, expectedRevision: b.revision, partId: b.part.id, type: 'F2', recipient: null, qualifiedSimplified: false })
      const b1 = await lockedBill(), b2 = await lockedBill()
      const racing = await Promise.all([emit(b1), emit(b1), emit(b1), emit(b2)])
      expect(racing.every(r => r.status === 200), JSON.stringify(racing.map(r => r.body))).toBe(true)
      expect(new Set(racing.slice(0, 3).map(r => r.result.invoiceId)).size).toBe(1)
      const numbers = (await admin.query("SELECT sequence,number FROM llenamos.pos_invoices WHERE restaurant_id='tenant-a' AND location_id='loc-a' ORDER BY sequence")).rows
      expect(numbers.map(r => r.sequence)).toEqual(numbers.map((_, i) => i + 1))
      expect(await count('pos_invoices', `bill_id='${b1.billId}'`)).toBe(1)
      expect(racing[0]!.result.warning).toBe('no válido para Hacienda')
      // La cadena fiscal es íntegra desde el génesis y cada factura imprime desde su artefacto original.
      const chain = (await admin.query('SELECT id FROM llenamos.pos_fiscal_chains WHERE restaurant_id=$1', ['tenant-a'])).rows[0].id
      const client = await app.connect()
      try {
        await client.query('BEGIN'); await client.query("SELECT set_config('app.actor_uid','owner-a',true),set_config('app.restaurant_id','tenant-a',true),set_config('app.platform','false',true)")
        expect(await verifyFullChain({ client, rid: 'tenant-a' } as unknown as Pos, chain, 2)).toBe(true)
      } finally { await client.query('ROLLBACK'); client.release() }
      expect(await count('pos_fiscal_outbox', "restaurant_id='tenant-a' AND status='queued'")).toBeGreaterThanOrEqual(2)
      expect(await count('outbox', "kind='caja.fiscal_registro' AND restaurant_id='tenant-a'")).toBeGreaterThanOrEqual(2)
    })
    it('rectifica sin superar el original y sustituye la simplificada una sola vez', async () => {
      process.env.LLENAMOS_FISCAL_TEST_MODE = '1'
      await ok('guardarConfiguracionCaja', { ...A, requestId: rid(), settings: settings('B12345674') })
      const b = await lockedBill(); await pay(b)
      const invoice = await ok('emitirFactura', { ...A, requestId: rid(), billId: b.billId, expectedRevision: b.revision, partId: b.part.id, type: 'F2', recipient: null, qualifiedSimplified: false })
      expect((await call('rectificarFactura', { ...A, requestId: rid(), invoiceId: invoice.invoiceId, type: 'R1', mode: 'I', reason: 'x', reductions: [{ lineIndex: 0, amountCents: 100 }] })).status).toBe(412) // tipo no corresponde a F2
      expect((await call('rectificarFactura', { ...A, requestId: rid(), invoiceId: invoice.invoiceId, type: 'R5', mode: 'I', reason: 'x', reductions: [{ lineIndex: 0, amountCents: 99999 }] })).status).toBe(412)
      const rect = await ok('rectificarFactura', { ...A, requestId: rid(), invoiceId: invoice.invoiceId, type: 'R5', mode: 'I', reason: 'Plato devuelto', reductions: [{ lineIndex: 0, amountCents: 100 }] })
      expect(rect.number).toMatch(/\/R\//)
      const recipient = { name: 'Cliente SL', address: 'Calle 2', identity: { kind: 'nif', nif: 'B12345674' } }
      expect((await call('sustituirSimplificada', { ...A, requestId: rid(), invoiceId: invoice.invoiceId, recipient })).status).toBe(412) // ya corregida
    })
    it('una instalación fiscal no puede pertenecer a dos restaurantes', async () => {
      process.env.LLENAMOS_FISCAL_TEST_MODE = '1'
      await admin.query("UPDATE llenamos.restaurants SET is_demo=true WHERE id='tenant-b'")
      const C = { restaurantId: 'tenant-c', locationId: 'loc-c' }
      await ok('guardarConfiguracionCaja', { ...C, requestId: rid(), settings: settings('B12345674', 'compartida') }, 'owner-c')
      const clash = await call('guardarConfiguracionCaja', { ...B, requestId: rid(), settings: settings('B12345674', 'compartida') }, 'owner-b')
      expect(clash.status).toBe(412); expect(JSON.stringify(clash.body)).toContain('ya pertenece a otro restaurante')
      await ok('guardarConfiguracionCaja', { ...B, requestId: rid(), settings: settings('B12345674', 'propia-b') }, 'owner-b')
    })
    it('el camarero emite pero no rectifica; anular exige destino cancelado y sin cobros', async () => {
      process.env.LLENAMOS_FISCAL_TEST_MODE = '1'
      await ok('guardarConfiguracionCaja', { ...A, requestId: rid(), settings: settings('B12345674') })
      const b = await lockedBill(); await pay(b)
      const invoice = await ok('emitirFactura', { ...A, requestId: rid(), billId: b.billId, expectedRevision: b.revision, partId: b.part.id, type: 'F2', recipient: null, qualifiedSimplified: false }, 'waiter-a')
      expect((await call('rectificarFactura', { ...A, requestId: rid(), invoiceId: invoice.invoiceId, type: 'R5', mode: 'I', reason: 'x', reductions: [{ lineIndex: 0, amountCents: 1 }] }, 'waiter-a')).status).toBe(403)
      expect((await call('anularRegistroFiscal', { ...A, requestId: rid(), invoiceId: invoice.invoiceId, reason: 'Venta real' })).status).toBe(412)
    })
  })

  describe('impresión', () => {
    const printer = (bridgeId: string, extra: Record<string, unknown> = {}) => ({ name: 'Caja', bridgeId, paperMm: 80, columns: 48, stationIds: [], tickets: true, drawer: true, active: true, ...extra })
    let bridgeToken = '', printerId = ''
    const bridge = (name: string, data: Record<string, unknown>) => call(name, data, '')
    it('vincula puente e impresora, rechaza impresoras sin puente o con estaciones aún no portadas', async () => {
      expect((await call('guardarImpresora', { ...A, requestId: rid(), printerId: null, printer: printer('bridge-1') })).status).toBe(412) // sin puente
      expect((await call('vincularPuente', { ...A, requestId: rid(), bridgeId: 'bridge-1' }, 'waiter-a')).status).toBe(403)
      bridgeToken = (await ok('vincularPuente', { ...A, requestId: rid(), bridgeId: 'bridge-1' })).token
      expect((await call('guardarImpresora', { ...A, requestId: rid(), printerId: null, printer: printer('bridge-1', { stationIds: ['barra'] }) })).status).toBe(412)
      printerId = (await ok('guardarImpresora', { ...A, requestId: rid(), printerId: null, printer: printer('bridge-1') })).printerId
      expect((await call('guardarImpresora', { ...A, requestId: rid(), printerId: null, printer: printer('bridge-1') })).status).toBe(412) // una sola impresora de caja
      expect(await count('pos_print_bridges', "token_hash='" + bridgeToken + "'")).toBe(0) // nunca en claro
    })
    it('un efectivo crea un único trabajo de cajón y el puente lo reclama con lease y lo confirma', async () => {
      const b = await lockedBill(); const paid = (await pay(b)).result
      const jobs = (await admin.query("SELECT id,status FROM llenamos.pos_print_jobs WHERE restaurant_id='tenant-a' AND kind='drawer' AND source_id=$1", [paid.paymentId])).rows
      expect(jobs).toHaveLength(1)
      const claim = (extra: Record<string, unknown> = {}) => bridge('reclamarImpresiones', { ...A, bridgeId: 'bridge-1', token: bridgeToken, limit: 5, ...extra })
      expect((await bridge('reclamarImpresiones', { ...A, bridgeId: 'bridge-1', token: 'x'.repeat(43), limit: 5 })).status).toBe(403)
      expect((await bridge('reclamarImpresiones', { ...B, bridgeId: 'bridge-1', token: bridgeToken, limit: 5 })).status).toBe(403)
      // Al guardar la impresora se reencolaron los cajones pendientes de antes: se drena la cola por lotes.
      let mine: { id: string; payloadHash: string; leaseToken: string } | undefined
      for (let i = 0; i < 10 && !mine; i++) {
        const batch = await claim({ limit: 20 })
        expect(batch.status, JSON.stringify(batch.body)).toBe(200)
        mine = batch.result.jobs.find((j: { id: string }) => j.id === jobs[0].id)
      }
      if (!mine) throw new Error('El trabajo no se entregó al puente.')
      expect(mine!.payloadHash).toMatch(/^[a-f0-9]{64}$/)
      expect((await claim()).result.jobs.find((j: { id: string }) => j.id === jobs[0].id)).toBeUndefined() // en manos del puente: no se entrega dos veces
      const confirm = (leaseToken: string, status = 'printed') => bridge('confirmarImpresion', { ...A, bridgeId: 'bridge-1', token: bridgeToken, printJobId: mine!.id, leaseToken, status, error: null })
      expect((await confirm('y'.repeat(43))).status).toBe(403)
      expect((await confirm(mine!.leaseToken)).status).toBe(200)
      expect((await confirm(mine!.leaseToken, 'failed')).status).toBe(200) // idempotente: el resultado final no cambia
      expect((await admin.query('SELECT status FROM llenamos.pos_print_jobs WHERE id=$1', [mine!.id])).rows[0].status).toBe('printed')
    })
    it('un lease caducado queda incierto y nunca se reimprime solo; la copia es una acción explícita', async () => {
      const b = await lockedBill(); await pay(b)
      const prebill = await ok('solicitarImpresion', { ...A, requestId: rid(), printerId, kind: 'prebill', sourceId: b.billId, copy: false })
      expect(await ok('solicitarImpresion', { ...A, requestId: rid(), printerId, kind: 'prebill', sourceId: b.billId, copy: false })).toEqual(prebill) // sin segundo trabajo
      expect(await count('pos_print_jobs', `printer_id='${printerId}' AND kind='prebill' AND source_id='${b.billId}'`)).toBe(1)
      let claimed: { leaseToken: string } | undefined
      for (let i = 0; i < 10 && !claimed; i++) claimed = (await bridge('reclamarImpresiones', { ...A, bridgeId: 'bridge-1', token: bridgeToken, limit: 20 })).result.jobs.find((j: { id: string }) => j.id === prebill.printJobId)
      expect(claimed).toBeTruthy()
      await admin.query("UPDATE llenamos.pos_print_jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [prebill.printJobId])
      const again = await bridge('reclamarImpresiones', { ...A, bridgeId: 'bridge-1', token: bridgeToken, limit: 20 })
      expect(again.result.jobs.find((j: { id: string }) => j.id === prebill.printJobId)).toBeUndefined()
      expect((await admin.query('SELECT status FROM llenamos.pos_print_jobs WHERE id=$1', [prebill.printJobId])).rows[0].status).toBe('uncertain')
      expect((await bridge('confirmarImpresion', { ...A, bridgeId: 'bridge-1', token: bridgeToken, printJobId: prebill.printJobId, leaseToken: claimed!.leaseToken, status: 'printed', error: null })).status).toBe(200)
      expect((await admin.query('SELECT status FROM llenamos.pos_print_jobs WHERE id=$1', [prebill.printJobId])).rows[0].status).toBe('uncertain')
      const copy = await ok('solicitarImpresion', { ...A, requestId: rid(), printerId, kind: 'prebill', sourceId: b.billId, copy: true })
      expect(copy.printJobId).not.toBe(prebill.printJobId)
      expect((await call('solicitarImpresion', { ...A, requestId: rid(), printerId, kind: 'drawer', sourceId: b.billId, copy: false }, 'waiter-a')).status).toBe(403)
    })
    it('rotar la credencial invalida la anterior; sin impresora la solicitud queda sin configurar y se resuelve al guardar una', async () => {
      const second = (await ok('vincularPuente', { ...A, requestId: rid(), bridgeId: 'bridge-1' })).token
      expect((await bridge('reclamarImpresiones', { ...A, bridgeId: 'bridge-1', token: bridgeToken, limit: 1 })).status).toBe(403)
      bridgeToken = second
      expect((await bridge('reclamarImpresiones', { ...A, bridgeId: 'bridge-1', token: bridgeToken, limit: 1 })).status).toBe(200)
      const b = await lockedBill(B, 'owner-b'); await pay(b, {}, B, 'owner-b')
      expect((await admin.query("SELECT status FROM llenamos.pos_print_requests WHERE restaurant_id='tenant-b' AND kind='drawer'")).rows[0].status).toBe('not_configured')
      const bt = (await ok('vincularPuente', { ...B, requestId: rid(), bridgeId: 'bridge-b' }, 'owner-b')).token
      await ok('guardarImpresora', { ...B, requestId: rid(), printerId: null, printer: printer('bridge-b') }, 'owner-b')
      expect((await admin.query("SELECT status FROM llenamos.pos_print_requests WHERE restaurant_id='tenant-b' AND kind='drawer'")).rows[0].status).toBe('processed')
      expect((await bridge('reclamarImpresiones', { ...B, bridgeId: 'bridge-b', token: bt, limit: 5 })).result.jobs).toHaveLength(1)
    })
    it('la comanda de cocina se declara no desplegada, nunca como impresa', async () => {
      expect((await call('solicitarImpresion', { ...A, requestId: rid(), printerId, kind: 'kitchen', sourceId: 'pedido-1', copy: false })).code).toBe('not-deployed')
    })
  })

  describe('revisión V5', () => {
    const printer = (bridgeId: string, extra: Record<string, unknown> = {}) => ({ name: 'Caja', bridgeId, paperMm: 80, columns: 48, stationIds: [], tickets: true, drawer: true, active: true, ...extra })
    it('las funciones del puente y de personal las posee llenamos_migrator, no el rol que migra', async () => {
      const { rows } = await admin.query("SELECT p.proname,r.rolname,r.rolsuper FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.proname LIKE 'pos\\_%' AND p.prosecdef")
      expect(rows.map(r => r.proname).sort()).toEqual(['pos_active_members', 'pos_bridge_claim', 'pos_bridge_confirm', 'pos_bridge_scope'])
      for (const r of rows) { expect(r.rolname).toBe('llenamos_migrator'); expect(r.rolsuper).toBe(false) }
      const cfg = (await admin.query("SELECT p.proconfig FROM pg_proc p WHERE p.proname='pos_bridge_claim'")).rows[0].proconfig as string[]
      expect(cfg.join()).toContain('pg_temp')
    })
    it('con impresora de caja activa se puede emitir, rectificar y sustituir: el ticket sale del registro fiscal', async () => {
      process.env.LLENAMOS_FISCAL_TEST_MODE = '1'
      await ok('guardarConfiguracionCaja', { ...A, requestId: rid(), settings: settings('B12345674') })
      expect((await admin.query("SELECT count(*)::int AS n FROM llenamos.pos_printers WHERE restaurant_id='tenant-a' AND active AND data->>'tickets'='true'")).rows[0].n).toBe(1)
      const b = await lockedBill(); await pay(b)
      const invoice = await ok('emitirFactura', { ...A, requestId: rid(), billId: b.billId, expectedRevision: b.revision, partId: b.part.id, type: 'F2', recipient: null, qualifiedSimplified: false })
      const job = (await admin.query("SELECT status,kind FROM llenamos.pos_print_jobs WHERE restaurant_id='tenant-a' AND source_id=$1", [invoice.invoiceId])).rows
      expect(job).toEqual([{ status: 'queued', kind: 'invoice' }])
      const rect = await ok('rectificarFactura', { ...A, requestId: rid(), invoiceId: invoice.invoiceId, type: 'R5', mode: 'I', reason: 'Error', reductions: [{ lineIndex: 0, amountCents: 50 }] })
      expect((await admin.query("SELECT count(*)::int AS n FROM llenamos.pos_print_jobs WHERE restaurant_id='tenant-a' AND source_id=$1", [rect.invoiceId])).rows[0].n).toBe(1)
      const b2 = await lockedBill(); await pay(b2)
      const f2 = await ok('emitirFactura', { ...A, requestId: rid(), billId: b2.billId, expectedRevision: b2.revision, partId: b2.part.id, type: 'F2', recipient: null, qualifiedSimplified: false })
      const sub = await ok('sustituirSimplificada', { ...A, requestId: rid(), invoiceId: f2.invoiceId, recipient: { name: 'Cliente SL', address: 'Calle 2', identity: { kind: 'nif', nif: 'B12345674' } } })
      expect((await admin.query("SELECT count(*)::int AS n FROM llenamos.pos_print_jobs WHERE restaurant_id='tenant-a' AND source_id=$1", [sub.invoiceId])).rows[0].n).toBe(1)
    })
    it('un fallo al preparar la impresión no tumba el cobro ni el guardado de la impresora', async () => {
      const C = { restaurantId: 'tenant-c', locationId: 'loc-c' }
      await ok('vincularPuente', { ...C, requestId: rid(), bridgeId: 'bridge-c' }, 'owner-c')
      // Cajón sin ticket: antes hacía fallar todo cobro en efectivo con 412.
      const pid = (await ok('guardarImpresora', { ...C, requestId: rid(), printerId: null, printer: printer('bridge-c', { tickets: false, drawer: true }) }, 'owner-c')).printerId
      const b = await lockedBill(C, 'owner-c'); const paid = await pay(b, {}, C, 'owner-c')
      expect(paid.status, JSON.stringify(paid.body)).toBe(200)
      expect((await admin.query("SELECT status FROM llenamos.pos_print_requests WHERE restaurant_id='tenant-c' AND kind='drawer'")).rows[0].status).toBe('not_configured')
      // Una solicitud imposible de preparar queda en failed y no impide guardar.
      await admin.query("INSERT INTO llenamos.pos_print_requests(restaurant_id,location_id,id,kind,source_id,copy,status,requested_at) VALUES('tenant-c','loc-c',$1,'invoice','no-existe',0,'not_configured',now())", ['f'.repeat(64)])
      await admin.query("UPDATE llenamos.pos_printers SET data=jsonb_set(jsonb_set(data,'{tickets}','true'),'{drawer}','false') WHERE id=$1", [pid])
      await ok('guardarImpresora', { ...C, requestId: rid(), printerId: pid, printer: printer('bridge-c', { tickets: true, drawer: false }) }, 'owner-c')
      expect((await admin.query("SELECT status FROM llenamos.pos_print_requests WHERE id=$1", ['f'.repeat(64)])).rows[0].status).toBe('failed')
    })
    it('el puente solo confirma estados finales', async () => {
      const claimed = await call('confirmarImpresion', { ...A, bridgeId: 'bridge-1', token: 'a'.repeat(43), printJobId: 'x', leaseToken: 'b'.repeat(43), status: 'queued', error: null }, '')
      expect(claimed.status).toBe(400) // el esquema ya lo rechaza
      await expect(admin.query("SELECT llenamos.pos_bridge_confirm('tenant-a','loc-a','bridge-1','x','x','x','queued',NULL)")).rejects.toThrow()
      await expect(admin.query("UPDATE llenamos.pos_print_jobs SET status='reimprimir'")).rejects.toThrow()
    })
    it('si el consumo cambió, ajustar o dividir guarda el refresco y pide recargar', async () => {
      const targetId = `mesa-${rid()}`
      consumption.set(`tenant-a:loc-a:session:${targetId}`, { lines: LINES, cancelled: false })
      const opened = await ok('abrirCuenta', { ...A, requestId: rid(), target: { kind: 'session', id: targetId } })
      consumption.set(`tenant-a:loc-a:session:${targetId}`, { lines: [...LINES, { lineId: 'cafe', parentLineId: null, name: 'Café', quantity: 1, grossCents: 200, taxRate: 10, guest: 1 }], cancelled: false })
      const stale = await call('dividirCuenta', { ...A, requestId: rid(), billId: opened.billId, expectedRevision: 1, split: { kind: 'equal', parts: 2 } })
      expect(stale.status).toBe(412); expect(stale.body.error?.code).toBe('failed-precondition')
      const bill = (await admin.query('SELECT revision,(data->>\'totalCents\')::int AS total FROM llenamos.pos_bills WHERE id=$1', [opened.billId])).rows[0]
      expect(bill).toEqual({ revision: 2, total: TOTAL + 200 }) // el refresco sí quedó guardado
      const locked = await ok('prepararCobro', { ...A, requestId: rid(), billId: opened.billId, expectedRevision: 2 })
      expect(locked.revision).toBe(3)
    })
    it('una devolución de consumo deja una revisión fiscal pendiente solo visible al encargado, y rectificar la cierra', async () => {
      process.env.LLENAMOS_FISCAL_TEST_MODE = '1'
      await ok('guardarConfiguracionCaja', { ...A, requestId: rid(), settings: settings('B12345674') })
      const b = await lockedBill(A, 'owner-a', `rev-${rid()}`); const paid = (await pay(b)).result
      const invoice = await ok('emitirFactura', { ...A, requestId: rid(), billId: b.billId, expectedRevision: b.revision, partId: b.part.id, type: 'F2', recipient: null, qualifiedSimplified: false })
      const refund = await ok('devolverCobro', { ...A, requestId: rid(), paymentId: paid.paymentId, amountCents: 300, tipCents: 0, reason: 'Plato frío' })
      const rows = (await admin.query('SELECT status,amount_cents::int AS cents FROM llenamos.pos_refund_reviews WHERE id=$1', [refund.refundId])).rows
      expect(rows).toEqual([{ status: 'requires_fiscal_correction', cents: 300 }])
      expect((await admin.query("SELECT count(*)::int AS n FROM llenamos.events WHERE topic='caja.devolucion' AND entity_id=$1", [refund.refundId])).rows[0].n).toBe(1)
      await ok('rectificarFactura', { ...A, requestId: rid(), invoiceId: invoice.invoiceId, type: 'R5', mode: 'I', reason: 'Devolución', reductions: [{ lineIndex: 0, amountCents: 300 }] })
      expect((await admin.query('SELECT status FROM llenamos.pos_refund_reviews WHERE id=$1', [refund.refundId])).rows[0].status).toBe('corrected')
      expect((await app.query('SELECT 1 FROM llenamos.pos_refund_reviews')).rowCount).toBe(0) // RLS sin contexto
    })
  })

  describe('lecturas en vivo', () => {
    it('devuelven instantáneas acotadas con el mismo control de acceso', async () => {
      const { MODULES } = await import('../index.js')
      const queries = new Map(MODULES.flatMap(m => m.liveQueries ?? []).map(q => [q.name, q]))
      const run = async (name: string, input: unknown, uid: string) => {
        const q = queries.get(name)!, client = await app.connect()
        try {
          await client.query('BEGIN'); await client.query("SELECT set_config('app.actor_uid',$1,true),set_config('app.restaurant_id',$2,true),set_config('app.platform','false',true)", [uid, (input as { restaurantId: string }).restaurantId])
          return await q.snapshot(client, input, { uid })
        } finally { await client.query('ROLLBACK'); client.release() }
      }
      const cuentas = await run('cajaCuentas', A, 'waiter-a') as { bills: { id: string }[] }
      expect(cuentas.bills.length).toBeGreaterThan(0)
      expect(((await run('cajaTurnos', { ...A, limit: 3 }, 'owner-a')) as { sessions: unknown[] }).sessions.length).toBeLessThanOrEqual(3)
      for (const [name, input] of [['cajaTurnos', { ...A, limit: 3 }], ['cajaTurno', { ...A, cashSessionId: 'x' }], ['cajaImpresoras', A], ['cajaRevisiones', A]] as const) {
        await expect(run(name, input, 'waiter-a'), name).rejects.toThrow() // lo que antes veía solo el encargado
        expect(queries.get(name)!.roles).not.toContain('waiter')
      }
      expect(queries.get('cajaTurnos')!.roles).toEqual(['owner', 'manager'])
      expect(((await run('cajaHistorial', { ...A, limit: 5 }, 'owner-a')) as { payments: unknown[] }).payments.length).toBeLessThanOrEqual(5)
      await expect(run('cajaCuentas', A, 'owner-b')).rejects.toThrow()
      await expect(run('cajaCuentas', A, 'kitchen-a')).rejects.toThrow()
      expect(((await run('cajaCuentas', B, 'owner-b')) as { bills: { id: string }[] }).bills.some(b => cuentas.bills.some(a => a.id === b.id))).toBe(false)
      expect(queries.get('cajaCuentas')!.roles).not.toContain('kitchen')
      // La lectura de cuentas exige también el módulo de sala.
      await admin.query("UPDATE llenamos.restaurants SET active_modules='{pos}' WHERE id='tenant-b'")
      try {
        await expect(run('cajaCuentas', B, 'owner-b')).rejects.toThrow('módulo')
        await expect(run('cajaTurnos', { ...B, limit: 3 }, 'owner-b')).resolves.toBeTruthy()
      } finally { await admin.query('UPDATE llenamos.restaurants SET active_modules=$1 WHERE id=\'tenant-b\'', [[...core.MODULES]]) }
    })
  })
})
