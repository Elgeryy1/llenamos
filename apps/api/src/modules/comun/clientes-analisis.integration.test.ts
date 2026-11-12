import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as core from '@llenamos/core'
import { withTenant } from '../../worker/tenant.js'
import { aggregateDay } from '../analisis/dias.js'
import { clientesMaintenance } from './mantenimiento.js'
import { clientesEnvironment, cid, req, vault, type ClientesEnvironment } from './entorno.js'

const enabled = process.env.TEST_POSTGRES_API === '1' && !!process.env.TEST_POSTGRES_URL
const TZ = 'Europe/Madrid'

/** Análisis con el rol del worker real: resumen diario, automatizaciones, eventos diarios, instantáneas y destinatarios. */
describe.skipIf(!enabled)('Análisis: resumen diario, automatizaciones, eventos diarios e instantáneas con el rol del worker', () => {
  let env: ClientesEnvironment
  const sql = (text: string, params: unknown[] = []) => env.db.admin.query(text, params)
  const task = (name: string) => clientesMaintenance(env.db.worker).find(t => t.name === name)!
  const analyticsSettings = (extra: object = {}) => ({ dailySummary: { enabled: true, hour: '00:00', channels: ['email'], recipientUids: ['owner-a', 'mgr'], covers: 'previous' }, forecast: { lowOccupancyBp: 3000, highOccupancyBp: 8500, daysAhead: 7 }, lapsedAfterDays: 60, ...extra })
  beforeAll(async () => { env = await clientesEnvironment('clianalisis') }, 90_000)
  afterAll(async () => { await env?.close() })

  it('guardarConfiguracionAnalisis: solo encargados activos reciben el resumen y solo quien configura puede guardar', async () => {
    expect((await env.call('guardarConfiguracionAnalisis', 'wai', { restaurantId: 'a', requestId: req(), settings: analyticsSettings() })).status).toBe(403)
    expect((await env.call('guardarConfiguracionAnalisis', 'owner-b', { restaurantId: 'a', requestId: req(), settings: analyticsSettings() })).status).toBe(403)
    // Un camarero, un desconocido y alguien de otro restaurante no pueden ser destinatarios.
    for (const uid of ['wai', 'nadie', 'owner-b'])
      expect((await env.call('guardarConfiguracionAnalisis', 'owner-a', { restaurantId: 'a', requestId: req(), settings: analyticsSettings({ dailySummary: { enabled: true, hour: '09:00', channels: ['email'], recipientUids: [uid], covers: 'previous' } }) })).status).toBe(412)
    await env.ok('guardarConfiguracionAnalisis', 'owner-a', { restaurantId: 'a', requestId: req(), settings: analyticsSettings() })
    expect((await sql("SELECT settings->'dailySummary'->'recipientUids' AS r FROM llenamos.analytics_settings WHERE restaurant_id='a'")).rows[0].r).toEqual(['owner-a', 'mgr'])
  })

  it('el resumen diario lo prepara el worker una vez al día, lo envía por el avisador y solo lo ve quien dirige todo el restaurante', async () => {
    expect(await task('resumen-diario').run()).toBe(2)
    expect(await task('resumen-diario').run()).toBe(0) // idempotente: un resumen por día
    const summaries = (await sql("SELECT date::text AS date,text FROM llenamos.daily_summaries WHERE restaurant_id='a'")).rows
    expect(summaries).toHaveLength(1)
    expect(summaries[0].text).toContain('Resumen del')
    const queued = (await sql("SELECT payload->>'to' AS to, payload->>'template' AS template FROM llenamos.outbox WHERE restaurant_id='a' AND kind='mensaje.enviar' ORDER BY 1")).rows
    expect(queued).toEqual([{ to: 'mgr@example.test', template: 'daily_summary' }, { to: 'owner-a@example.test', template: 'daily_summary' }])
    // Sin proveedor el aviso queda sin configurar; con proveedor sale.
    await env.drain()
    expect((await sql("SELECT status FROM llenamos.message_deliveries WHERE restaurant_id='a'")).rows.every(r => r.status === 'not_configured')).toBe(true)
    await sql('INSERT INTO llenamos.integration_secrets(restaurant_id,ciphertext) VALUES($1,$2)', ['a', vault.seal('a', { email: { apiKey: 'k', from: 'casa@example.test' } })])
    await sql("UPDATE llenamos.outbox SET status='pending',attempts=0,available_at=now(),finished_at=NULL,lease_until=NULL WHERE restaurant_id='a' AND kind='mensaje.enviar'")
    await sql("DELETE FROM llenamos.message_deliveries WHERE restaurant_id='a'")
    await env.drain()
    expect(env.provider.map(p => p.body.to)).toEqual(expect.arrayContaining([['mgr@example.test'], ['owner-a@example.test']]))
    expect(JSON.stringify(env.provider[0]!.body)).toContain('Resumen del')
    const date = summaries[0].date
    const view = await env.ok('verResumenDiario', 'owner-a', { restaurantId: 'a', date })
    expect(view.sentTo.map((s: { status: string }) => s.status)).toEqual(['sent', 'sent'])
    expect((await env.call('verResumenDiario', 'lim', { restaurantId: 'a', date })).status).toBe(403)
    expect((await env.call('verResumenDiario', 'owner-b', { restaurantId: 'a', date })).status).toBe(403)
  })

  describe('automatizaciones y eventos', () => {
    const customer = cid(10)
    const rule = { name: 'No se presentó', enabled: true, event: 'reservation.no_show', conditions: { all: [] }, recommendation: { kind: 'require_deposit', note: null, segmentId: null }, cooldownMinutes: 0, locationIds: [] as string[] }
    it('un no presentado genera evento, recomendación y se resuelve; un encargado limitado no toca reglas de todo el restaurante', async () => {
      await env.member('a', 'owner-a', async client => {
        await client.query('INSERT INTO llenamos.customers(restaurant_id,id,data) VALUES($1,$2,$3)', ['a', customer, JSON.stringify({ name: 'Ana', phone: '+34600000010', email: 'ana10@example.test', language: 'es', visits: 0, noShows: 0, cancellations: 0, lastVisitAt: null })])
        await client.query("INSERT INTO llenamos.reservations(restaurant_id,location_id,id,customer_id,reference,start_at,status,table_ids,manage_token_hash,data) VALUES('a','a-main','rs10',$1,'REF00010',now()-interval '1 hour','confirmed','{}',$2,$3)", [customer, 'd'.repeat(64), JSON.stringify({ partySize: 3, deposit: { status: 'none', amountCents: 0, checkoutSessionId: null } })])
      })
      const saved = await env.ok('guardarAutomatizacion', 'owner-a', { restaurantId: 'a', requestId: req(), ruleId: null, expectedRevision: null, rule })
      expect((await env.call('guardarAutomatizacion', 'lim', { restaurantId: 'a', requestId: req(), ruleId: null, expectedRevision: null, rule })).status).toBe(403)
      expect((await env.call('guardarAutomatizacion', 'lim', { restaurantId: 'a', requestId: req(), ruleId: null, expectedRevision: null, rule: { ...rule, locationIds: ['a-terraza'] } })).status).toBe(403)
      expect((await env.call('borrarAutomatizacion', 'lim', { restaurantId: 'a', requestId: req(), ruleId: saved.ruleId, expectedRevision: saved.revision })).status).toBe(403)
      expect((await env.call('borrarAutomatizacion', 'owner-a', { restaurantId: 'a', requestId: req(), ruleId: saved.ruleId, expectedRevision: saved.revision + 1 })).status).toBe(412)
      const limited = await env.ok('guardarAutomatizacion', 'lim', { restaurantId: 'a', requestId: req(), ruleId: null, expectedRevision: null, rule: { ...rule, name: 'Solo a-main', locationIds: ['a-main'] } })
      // El disparador de reservas encola el trabajo y el worker anota el evento del no presentado.
      await env.member('a', 'owner-a', client => client.query("UPDATE llenamos.reservations SET status='no_show' WHERE restaurant_id='a' AND id='rs10'"))
      await sql("UPDATE llenamos.jobs SET scheduled_at=now()-interval '1 minute' WHERE status='pending'")
      await env.drain()
      expect((await sql("SELECT id,subject,data FROM llenamos.automation_events WHERE restaurant_id='a'")).rows).toEqual([{ id: 'reservation.no_show.a-main.rs10', subject: customer, data: { partySize: 3, customerNoShows: 0, hasDeposit: false } }])
      // Simular la regla ve el evento; evaluar crea una recomendación por regla (id determinista) y repetir no duplica.
      const simulated = await env.ok('simularAutomatizacion', 'owner-a', { restaurantId: 'a', rule, from: core.horaLocal(Date.now(), TZ).fecha, to: core.horaLocal(Date.now(), TZ).fecha })
      expect(simulated.events).toBe(1)
      expect(await task('automatizaciones').run()).toBe(2)
      expect(await task('automatizaciones').run()).toBe(0)
      const open = (await sql("SELECT id,rule_id,status,location_id FROM llenamos.recommendations WHERE restaurant_id='a' ORDER BY rule_id")).rows
      expect(open).toHaveLength(2)
      expect(open.every(r => r.status === 'open' && r.location_id === 'a-main')).toBe(true)
      const recommendationId = open.find(r => r.rule_id === limited.ruleId)!.id
      expect((await env.call('resolverRecomendacion', 'wai', { restaurantId: 'a', requestId: req(), recommendationId, decision: 'accepted', note: null })).status).toBe(403)
      expect(await env.ok('resolverRecomendacion', 'lim', { restaurantId: 'a', requestId: req(), recommendationId, decision: 'accepted', note: 'Hecho' })).toEqual({ status: 'accepted', kind: 'require_deposit' })
      expect((await env.call('resolverRecomendacion', 'lim', { restaurantId: 'a', requestId: req(), recommendationId, decision: 'dismissed', note: null })).status).toBe(412)
      // Reservas de otro restaurante no existen para este.
      expect((await env.call('resolverRecomendacion', 'owner-b', { restaurantId: 'b', requestId: req(), recommendationId, decision: 'accepted', note: null })).status).toBe(404)
    })

    it('eventos diarios: el cliente que lleva meses sin venir genera un solo evento al día, y las recomendaciones caducadas se cierran', async () => {
      await sql("UPDATE llenamos.customer_marketing SET last_visit_at=now()-interval '100 days',visits=4,spent_cents=8000 WHERE restaurant_id='a' AND customer_id=$1", [customer])
      await task('analisis-diario').run()
      const lapsed = () => sql("SELECT count(*)::int AS n FROM llenamos.automation_events WHERE restaurant_id='a' AND type='customer.lapsed'").then(r => r.rows[0].n)
      expect(await lapsed()).toBe(1)
      await task('analisis-diario').run()
      expect(await lapsed()).toBe(1)
      await sql("UPDATE llenamos.recommendations SET expires_at=now()-interval '1 day' WHERE restaurant_id='a' AND status='open'")
      await task('automatizaciones').run()
      expect((await sql("SELECT count(*)::int AS n FROM llenamos.recommendations WHERE restaurant_id='a' AND status='open'")).rows[0].n).toBe(0)
    })
  })

  it('instantáneas con el rol del worker: las cuentas cobradas de caja entran en el panel, por local y día, sin leer más', async () => {
    const yesterday = core.sumarDias(core.horaLocal(Date.now(), TZ).fecha, -1)
    const at = core.instanteDeHoraLocal(yesterday, 14 * 60, TZ)!
    const bill = { target: { kind: 'takeaway', id: 'rec1' }, customerId: null, status: 'settled', revision: 3, lines: [{ lineId: 'l1', parentLineId: null, name: 'Paella', quantity: 2, grossCents: 2000, taxRate: 10, guest: null }],
      adjustments: [], totalCents: 2000, paidCents: 2000, refundedCents: 0, openedAt: at - 600_000, lockedAt: at - 60_000, settledAt: at }
    await sql("INSERT INTO llenamos.pos_bills(restaurant_id,location_id,id,target_kind,target_id,status,revision,opened_at,data) VALUES('a','a-main','bill1','takeaway','rec1','settled',3,$1,$2)", [new Date(at - 600_000), JSON.stringify(bill)])
    // Con el rol del worker (no el de la API) se calcula y guarda el día.
    const totals = await withTenant(env.db.worker, 'a', client => aggregateDay(client, 'a', 'a-main', yesterday))
    expect(totals).toMatchObject({ bills: 1, grossSalesCents: 2000, takeawayBills: 1 })
    expect((await sql("SELECT totals->>'grossSalesCents' AS g FROM llenamos.analytics_days WHERE restaurant_id='a' AND location_id='a-main' AND date=$1", [yesterday])).rows).toEqual([{ g: '2000' }])
    // Otro local u otro día sale vacío; el panel (rol de la API) lee solo las instantáneas.
    await task('analisis-diario').run()
    const panel = await env.ok('panelAnalisis', 'owner-a', { restaurantId: 'a', locationIds: null, from: yesterday, to: yesterday, compare: 'none', slotMinutes: 60 })
    expect(panel.total.grossSalesCents).toBe(2000)
    expect((await env.ok('panelAnalisis', 'lim', { restaurantId: 'a', locationIds: ['a-main'], from: yesterday, to: yesterday, compare: 'none', slotMinutes: 60 })).total.grossSalesCents).toBe(2000)
    expect((await env.call('panelAnalisis', 'lim', { restaurantId: 'a', locationIds: ['a-terraza'], from: yesterday, to: yesterday, compare: 'none', slotMinutes: 60 })).status).toBe(403)
    expect((await env.ok('panelAnalisis', 'owner-b', { restaurantId: 'b', locationIds: null, from: yesterday, to: yesterday, compare: 'none', slotMinutes: 60 })).total.grossSalesCents).toBe(0)
    // Una devolución del día entra en las cifras con la base proporcional.
    await sql("INSERT INTO llenamos.pos_payments(restaurant_id,location_id,id,bill_id,part_id,cash_session_id,original_payment_id,kind,status,method,at,data) VALUES('a','a-main',$1,'bill1','p','c','pay0','refund','succeeded','cash',$2,$3)",
      [randomUUID().replaceAll('-', ''), new Date(at + 3_600_000), JSON.stringify({ amountCents: 500, tipCents: 0 })])
    const again = await withTenant(env.db.worker, 'a', client => aggregateDay(client, 'a', 'a-main', yesterday))
    expect(again).toMatchObject({ refundCents: 500 })
  })

  it('el informe de origen sale por el puerto de campañas y respeta el alcance de local', async () => {
    const origin = { ...core.classifyOrigin({ reservationSource: 'widget', attribution: { utmSource: 'instagram', utmMedium: 'social', utmCampaign: null, utmContent: null, utmTerm: null, adId: null, campaignId: null, clickIds: [], referrer: null, embedHost: null, landingPath: null }, ownHosts: [] }), date: core.horaLocal(Date.now(), TZ).fecha, partySize: 2, createdAt: Date.now() }
    await env.member('a', 'owner-a', client => client.query('INSERT INTO llenamos.reservation_origins(restaurant_id,location_id,reservation_id,data) VALUES($1,$2,$3,$4)', ['a', 'a-main', 'ro1', JSON.stringify(core.reservationOriginForWrite(origin, v => v))]))
    const today = core.horaLocal(Date.now(), TZ).fecha
    const exp = (uid: string, locationIds: string[] | null) => env.call('exportarAnalisis', uid, { restaurantId: 'a', from: today, to: today, locationIds, kind: 'origins' })
    const all = await exp('owner-a', null)
    expect(all.status, JSON.stringify(all.body)).toBe(200)
    expect(all.body.result.rows).toBeGreaterThan(0)
    expect((await exp('lim', ['a-terraza'])).status).toBe(403)
    expect((await exp('wai', null)).status).toBe(403)
  })
})
