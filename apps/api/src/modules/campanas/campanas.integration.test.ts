import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { CAMPAIGN_EXCLUSIONS, nextSendTime, type SegmentRule } from '@llenamos/core'
import { createFixture, postgresTests, type Fixture } from '../comun/fixture.js'
import { recordConsent } from '../comun/clientes.js'
import { MAX_CAMPAIGN_AUDIENCE, setLoyaltyPointsPort, setPublicAppOrigin, setUnsubscribeLimits } from './config.js'
import { unsubscribe } from './baja.js'
import { campaignOutboxId, issueUnsubscribeUrl, markCampaignMessageOutcome, processCampaigns, resolveCampaignMessage } from './proceso.js'
import { originReportRows, recordReservationConsents, recordReservationOrigin, updateOriginOutcome } from './origen.js'
import { campanasModule } from './index.js'

const DAY = 86_400_000
const settings = { maxPer30Days: 2, minHoursBetween: 72, sendWindow: { from: '10:00', to: '21:00' }, senderName: 'Lumbre' }
const rule: SegmentRule = { minVisits: null, maxVisits: null, lastVisitAtLeastDaysAgo: null, lastVisitAtMostDaysAgo: null, includeNeverVisited: true, maxNoShows: null, minSpentCents: null, tagsAny: [], tagsNone: [], languages: [], minPoints: null }
const cid = (n: number) => n.toString(16).padStart(20, '0')
const reqId = () => randomUUID()

describe.skipIf(!postgresTests)('campañas: segmentos, audiencia, outbox, baja y origen', () => {
  let f: Fixture
  // En ventana (10:00 a 21:00 de Madrid) y en el futuro de cualquier lanzamiento real de la prueba.
  const inWindow = nextSendTime(Date.now() + 3 * DAY, 'Europe/Madrid', settings.sendWindow)
  beforeAll(async () => {
    f = await createFixture('campanas')
    setPublicAppOrigin('https://app.example.test')
    await f.admin.query("INSERT INTO llenamos.identities(uid,session_version,tokens_valid_after,locked) VALUES('scoped','eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',to_timestamp(100),false)")
    await f.admin.query("INSERT INTO llenamos.memberships(restaurant_id,uid,role,active,display_name,email,location_ids) VALUES('a','scoped','manager',true,'scoped','scoped@example.test','{a-main}')")
  }, 90_000)
  afterAll(async () => { setPublicAppOrigin(undefined); setUnsubscribeLimits(null); setLoyaltyPointsPort(null); await f?.close() })

  const ok = async (name: string, uid: string, data: unknown) => { const r = await f.call(name, uid, data); expect(r.status, JSON.stringify(r.body)).toBe(200); return r.body.result }
  async function member<T>(rid: string, uid: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await f.app.connect()
    try {
      await client.query('BEGIN')
      await client.query("SELECT set_config('app.actor_uid',$1,true),set_config('app.platform','false',true),set_config('app.restaurant_id',$2,true)", [uid, rid])
      const out = await fn(client)
      await client.query('COMMIT')
      return out
    } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
  }
  async function reset() {
    for (const t of ['marketing_campaign_recipients', 'marketing_campaigns', 'marketing_segments', 'marketing_send_log', 'marketing_unsubscribe_tokens', 'marketing_settings', 'reservation_origins', 'marketing_consents', 'customer_marketing', 'marketing_unsubscribe_limits'])
      await f.admin.query(`DELETE FROM llenamos.${t}`)
    await f.admin.query("DELETE FROM llenamos.outbox WHERE kind LIKE 'marketing.%'")
    await f.admin.query("DELETE FROM llenamos.jobs WHERE kind LIKE 'marketing.%'")
    await f.admin.query("UPDATE llenamos.restaurants SET active_modules=$1 WHERE id='a'", [['reservations', 'floor', 'kitchen', 'pos', 'repite', 'staff', 'inventory', 'loyalty', 'marketing', 'analytics']])
    setUnsubscribeLimits(null); setLoyaltyPointsPort(null)
  }
  /** Clientes 1..n con correo y permiso de correo; extras (451..) para cada motivo de exclusión. */
  async function seed(rid: string, n: number, extras = false) {
    await f.admin.query(`INSERT INTO llenamos.customer_marketing(restaurant_id,customer_id,name,email,phone) SELECT $1,lpad(to_hex(g),20,'0'),'Cliente '||g,'c'||g||'@x.test','+3460000'||g FROM generate_series(1,$2) g`, [rid, n])
    await f.admin.query(`INSERT INTO llenamos.marketing_consents(restaurant_id,id,customer_id,purpose,status,policy_version,at,source,evidence_id)
      SELECT $1,'g'||g,lpad(to_hex(g),20,'0'),'marketing_email','granted','v1',to_timestamp(1),'public','e' FROM generate_series(1,$2) g`, [rid, n])
    if (!extras) return
    const add = (i: number, email: string | null, redacted = false) => f.admin.query('INSERT INTO llenamos.customer_marketing(restaurant_id,customer_id,name,email,redacted) VALUES($1,$2,$3,$4,$5)', [rid, cid(i), `Extra ${i}`, email, redacted])
    const grant = (i: number) => f.admin.query("INSERT INTO llenamos.marketing_consents(restaurant_id,id,customer_id,purpose,status,policy_version,at,source,evidence_id) VALUES($1,$2,$3,'marketing_email','granted','v1',to_timestamp(1),'public','e')", [rid, `g${i}`, cid(i)])
    await add(n + 1, null); await grant(n + 1)                   // sin contacto
    await add(n + 2, 'c452@x.test', true); await grant(n + 2)    // suprimido por privacidad
    await add(n + 3, 'c453@x.test'); await grant(n + 3)          // retiró el permiso
    await f.admin.query("INSERT INTO llenamos.marketing_consents(restaurant_id,id,customer_id,purpose,status,policy_version,at,source,evidence_id) VALUES($1,'w1',$2,'marketing_email','withdrawn','v1',to_timestamp(2),'staff','e')", [rid, cid(n + 3)])
    await add(n + 4, 'c454@x.test')                              // nunca dio permiso
    await add(n + 5, 'C1@X.test'); await grant(n + 5)            // mismo correo que el cliente 1
    await add(n + 6, 'c456@x.test'); await grant(n + 6)          // frecuencia
    await f.admin.query("INSERT INTO llenamos.marketing_send_log(restaurant_id,customer_id,campaign_id,at) VALUES($1,$2,'otra',$3),($1,$2,'otra_hoy',$4)", [rid, cid(n + 6), new Date(inWindow - 3_600_000), new Date(Date.now() - 3_600_000)])
  }
  async function makeCampaign(uid = 'alice', extra: Record<string, unknown> = {}) {
    const seg = await ok('guardarSegmento', uid, { restaurantId: 'a', requestId: reqId(), segmentId: null, expectedRevision: null, segment: { name: 'Todos', rule } })
    const camp = await ok('guardarCampana', uid, { restaurantId: 'a', requestId: reqId(), campaignId: null, expectedRevision: null, campaign: { name: 'Vermú', segmentId: seg.segmentId, channel: 'email', content: { title: 'Noche', body: 'Ven', includeBookingLink: true }, locationId: null, ...extra } })
    return { segmentId: seg.segmentId as string, campaignId: camp.campaignId as string, revision: camp.revision as number }
  }
  async function launch(campaignId: string, revision: number) {
    return ok('lanzarCampana', 'alice', { restaurantId: 'a', requestId: reqId(), campaignId, expectedRevision: revision, at: null })
  }
  async function drain(rid: string, now: number, pageSize = 200, campaignId: string | null = null) {
    let calls = 0, queued = 0
    for (;;) {
      const r = await member(rid, 'alice', c => processCampaigns(c, rid, now, pageSize, campaignId))
      calls++; queued += r.queued
      if (!r.more || calls > 20) return { calls, queued }
    }
  }
  beforeEach(reset)

  it('ajustes, segmentos y campañas: camino correcto, revisiones y borrado protegido', async () => {
    await ok('guardarConfiguracionMarketing', 'alice', { restaurantId: 'a', requestId: reqId(), settings })
    const live = await member('a', 'alice', c => campanasModule.liveQueries!.find(q => q.name === 'campanas.ajustes')!.snapshot(c, { restaurantId: 'a' }, { uid: 'alice' }))
    expect(live).toEqual(settings)
    const seg = await ok('guardarSegmento', 'mia', { restaurantId: 'a', requestId: reqId(), segmentId: null, expectedRevision: null, segment: { name: 'Todos', rule } })
    expect(seg.revision).toBe(1)
    const seg2 = await ok('guardarSegmento', 'mia', { restaurantId: 'a', requestId: reqId(), segmentId: seg.segmentId, expectedRevision: 1, segment: { name: 'Todos 2', rule } })
    expect(seg2.revision).toBe(2)
    const stale = await f.call('guardarSegmento', 'mia', { restaurantId: 'a', requestId: reqId(), segmentId: seg.segmentId, expectedRevision: 1, segment: { name: 'x', rule } })
    expect(stale.status).toBe(412)
    expect((await f.call('guardarSegmento', 'mia', { restaurantId: 'a', requestId: reqId(), segmentId: null, expectedRevision: 3, segment: { name: 'x', rule } })).status).toBe(412)
    const camp = await ok('guardarCampana', 'mia', { restaurantId: 'a', requestId: reqId(), campaignId: null, expectedRevision: null, campaign: { name: 'C', segmentId: seg.segmentId, channel: 'email', content: { title: 'T', body: 'B', includeBookingLink: false }, locationId: null } })
    expect((await f.call('guardarCampana', 'mia', { restaurantId: 'a', requestId: reqId(), campaignId: null, expectedRevision: null, campaign: { name: 'C', segmentId: 'no-existe', channel: 'email', content: { title: 'T', body: 'B', includeBookingLink: false }, locationId: null } })).status).toBe(404)
    const del = await f.call('borrarSegmento', 'mia', { restaurantId: 'a', requestId: reqId(), segmentId: seg.segmentId, expectedRevision: 2 })
    expect(del.status).toBe(412)
    expect(del.body.error.message).toContain('campaña')
    const edited = await ok('guardarCampana', 'mia', { restaurantId: 'a', requestId: reqId(), campaignId: camp.campaignId, expectedRevision: 1, campaign: { name: 'C2', segmentId: seg.segmentId, channel: 'whatsapp', content: { title: 'T', body: 'B', includeBookingLink: false }, locationId: null } })
    expect(edited.revision).toBe(2)
    const campaigns = await member('a', 'mia', c => campanasModule.liveQueries!.find(q => q.name === 'campanas.campanas')!.snapshot(c, { restaurantId: 'a' }, { uid: 'mia' })) as any[]
    expect(campaigns).toHaveLength(1)
    expect(campaigns[0]).toMatchObject({ id: camp.campaignId, name: 'C2', status: 'draft', channel: 'whatsapp', scheduledAt: null, revision: 2 })
    // Una campaña que no es borrador no se edita ni su segmento se borra.
    await f.admin.query("UPDATE llenamos.marketing_campaigns SET status='cancelled' WHERE restaurant_id='a'")
    expect((await f.call('guardarCampana', 'mia', { restaurantId: 'a', requestId: reqId(), campaignId: camp.campaignId, expectedRevision: 2, campaign: { name: 'C3', segmentId: seg.segmentId, channel: 'email', content: { title: 'T', body: 'B', includeBookingLink: false }, locationId: null } })).status).toBe(412)
    await ok('borrarSegmento', 'mia', { restaurantId: 'a', requestId: reqId(), segmentId: seg.segmentId, expectedRevision: 2 })
    const events = await f.admin.query("SELECT DISTINCT topic FROM llenamos.events WHERE restaurant_id='a' AND topic LIKE 'campanas.%' ORDER BY 1")
    expect(events.rows.map(r => r.topic)).toEqual(['campanas.ajustes', 'campanas.campana', 'campanas.segmento'])
  })

  it('roles, módulo apagado, otro restaurante e idempotencia', async () => {
    const body = (extra: object = {}) => ({ restaurantId: 'a', requestId: reqId(), segmentId: null, expectedRevision: null, segment: { name: 'S', rule }, ...extra })
    for (const uid of ['kit', 'wai', 'outsider']) expect((await f.call('guardarSegmento', uid, body())).status, uid).toBe(403)
    expect((await f.call('guardarSegmento', 'bob', body())).status).toBe(403)
    // Lanzar es solo del propietario.
    const c = await makeCampaign('mia')
    expect((await f.call('lanzarCampana', 'mia', { restaurantId: 'a', requestId: reqId(), campaignId: c.campaignId, expectedRevision: c.revision, at: null })).status).toBe(403)
    // informeOrigen pide analisis.ver
    expect((await f.call('informeOrigen', 'kit', { restaurantId: 'a', from: '2026-01-01', to: '2026-12-31', locationIds: null })).status).toBe(403)
    // Idempotencia: misma requestId y misma entrada = mismo resultado; otra entrada = 409.
    const input = body()
    const first = await ok('guardarSegmento', 'alice', input)
    const again = await ok('guardarSegmento', 'alice', input)
    expect(again).toEqual(first)
    expect((await f.admin.query("SELECT count(*)::int AS n FROM llenamos.marketing_segments WHERE name='S'")).rows[0].n).toBe(1)
    const other = await f.call('guardarSegmento', 'alice', { ...input, segment: { name: 'Otro', rule } })
    expect(other.status).toBe(409)
    // Aislamiento: el restaurante b no ve la campaña de a.
    const bobSeg = await ok('guardarSegmento', 'bob', { restaurantId: 'b', requestId: reqId(), segmentId: null, expectedRevision: null, segment: { name: 'B', rule } })
    expect((await f.call('informeCampana', 'bob', { restaurantId: 'b', campaignId: c.campaignId })).status).toBe(404)
    expect((await f.call('borrarSegmento', 'bob', { restaurantId: 'b', requestId: reqId(), segmentId: first.segmentId, expectedRevision: 1 })).status).toBe(404)
    const bobLive = await member('b', 'bob', cl => campanasModule.liveQueries!.find(q => q.name === 'campanas.segmentos')!.snapshot(cl, { restaurantId: 'b' }, { uid: 'bob' })) as any[]
    expect(bobLive.map(s => s.id)).toEqual([bobSeg.segmentId])
    // Módulo apagado.
    await f.admin.query("UPDATE llenamos.restaurants SET active_modules=ARRAY['reservations'] WHERE id='a'")
    expect((await f.call('guardarSegmento', 'alice', body())).status).toBe(403)
    expect((await f.call('informeOrigen', 'alice', { restaurantId: 'a', from: '2026-01-01', to: '2026-12-31', locationIds: null })).status).toBe(403)
    await expect(member('a', 'alice', cl => campanasModule.liveQueries![0]!.snapshot(cl, { restaurantId: 'a' }, { uid: 'alice' }))).rejects.toMatchObject({ status: 403 })
  })

  it('alcance de local: quien solo tiene a-main no toca a-terraza ni campañas de todo el restaurante', async () => {
    const seg = await ok('guardarSegmento', 'scoped', { restaurantId: 'a', requestId: reqId(), segmentId: null, expectedRevision: null, segment: { name: 'S', rule } })
    const campaign = (locationId: string | null) => ({ name: 'C', segmentId: seg.segmentId, channel: 'email', content: { title: 'T', body: 'B', includeBookingLink: false }, locationId })
     expect((await f.call('guardarCampana', 'scoped', { restaurantId: 'a', requestId: reqId(), campaignId: null, expectedRevision: null, campaign: campaign('a-terraza') })).status).toBe(403)
    expect((await f.call('guardarCampana', 'scoped', { restaurantId: 'a', requestId: reqId(), campaignId: null, expectedRevision: null, campaign: campaign(null) })).status).toBe(412)
    const mine = await ok('guardarCampana', 'scoped', { restaurantId: 'a', requestId: reqId(), campaignId: null, expectedRevision: null, campaign: campaign('a-main') })
    const global = await ok('guardarCampana', 'mia', { restaurantId: 'a', requestId: reqId(), campaignId: null, expectedRevision: null, campaign: campaign(null) })
    const terraza = await ok('guardarCampana', 'mia', { restaurantId: 'a', requestId: reqId(), campaignId: null, expectedRevision: null, campaign: campaign('a-terraza') })
    await ok('informeCampana', 'scoped', { restaurantId: 'a', campaignId: mine.campaignId })
    for (const id of [global.campaignId, terraza.campaignId]) expect((await f.call('informeCampana', 'scoped', { restaurantId: 'a', campaignId: id })).status).toBe(403)
    const ids = (await member('a', 'scoped', cl => campanasModule.liveQueries!.find(q => q.name === 'campanas.campanas')!.snapshot(cl, { restaurantId: 'a' }, { uid: 'scoped' })) as any[]).map(c => c.id)
    expect(ids).toEqual([mine.campaignId])
    // informeOrigen solo de sus locales.
    expect((await f.call('informeOrigen', 'scoped', { restaurantId: 'a', from: '2026-01-01', to: '2026-12-31', locationIds: ['a-terraza'] })).status).toBe(403)
    await ok('informeOrigen', 'scoped', { restaurantId: 'a', from: '2026-01-01', to: '2026-12-31', locationIds: null })
  })

  it('previsualización por páginas: recuentos por motivo, muestra de 20 y tope duro', async () => {
    await seed('a', 450, true)
    const pre = await ok('previsualizarSegmento', 'alice', { restaurantId: 'a', rule, channel: 'email' })
    expect(pre.audience).toBe(456)
    expect(pre.recipients).toBe(450)
    expect(pre.excluded).toEqual({ no_contact: 1, no_consent: 1, withdrawn: 1, suppressed: 1, frequency: 1, duplicate_contact: 1 })
    expect(pre.sample).toHaveLength(20)
    expect(JSON.stringify(pre)).not.toContain('@')
    // Tope: más de 50.000 clientes en el segmento se rechaza antes de recorrer nada.
    await f.admin.query(`INSERT INTO llenamos.customer_marketing(restaurant_id,customer_id,name) SELECT 'b',lpad(to_hex(g),20,'0'),'x' FROM generate_series(1,$1) g`, [MAX_CAMPAIGN_AUDIENCE + 1])
    const capped = await f.call('previsualizarSegmento', 'bob', { restaurantId: 'b', rule, channel: 'email' })
    expect(capped.status).toBe(412)
    // Con una regla que deja fuera a casi todos sí pasa (el filtro va a SQL).
    const narrow = await ok('previsualizarSegmento', 'bob', { restaurantId: 'b', rule: { ...rule, minVisits: 5 }, channel: 'email' })
    expect(narrow.audience).toBe(0)
    await f.admin.query("DELETE FROM llenamos.customer_marketing WHERE restaurant_id='b'")
  }, 60_000)

  it('filtros del segmento en SQL coinciden con matchesSegment', async () => {
    const day = (n: number) => new Date(Date.now() - n * DAY)
    const rows: [number, number, number, Date | null, number, string[], string][] = [
      [1, 1, 0, day(10), 1000, ['vip'], 'es'], [2, 5, 1, day(100), 5000, ['Vip', 'x'], 'ca'], [3, 0, 0, null, 0, [], 'en'], [4, 9, 3, day(400), 90000, ['no'], 'es'],
    ]
    for (const [i, v, ns, last, spent, tags, lang] of rows)
      await f.admin.query('INSERT INTO llenamos.customer_marketing(restaurant_id,customer_id,name,email,visits,no_shows,last_visit_at,spent_cents,tags,language) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', ['a', cid(i), `C${i}`, `c${i}@x.test`, v, ns, last, spent, tags, lang])
    const count = async (r: Partial<SegmentRule>) => (await ok('previsualizarSegmento', 'alice', { restaurantId: 'a', rule: { ...rule, ...r }, channel: 'email' })).audience
    expect(await count({})).toBe(4)
    expect(await count({ minVisits: 1, maxVisits: 5 })).toBe(2)
    expect(await count({ lastVisitAtLeastDaysAgo: 30, includeNeverVisited: false })).toBe(2)
    expect(await count({ lastVisitAtMostDaysAgo: 30, includeNeverVisited: false })).toBe(1)
    expect(await count({ lastVisitAtLeastDaysAgo: 30 })).toBe(3)
    expect(await count({ maxNoShows: 1 })).toBe(3)
    expect(await count({ minSpentCents: 5000 })).toBe(2)
    expect(await count({ tagsAny: ['VIP'] })).toBe(2)
    expect(await count({ tagsNone: ['vip'] })).toBe(2)
    expect(await count({ languages: ['ca', 'en'] })).toBe(2)
    // Los puntos exigen fidelización conectada: sin ella falla, con ella filtra.
    expect((await f.call('previsualizarSegmento', 'alice', { restaurantId: 'a', rule: { ...rule, minPoints: 10 }, channel: 'email' })).status).toBe(412)
    setLoyaltyPointsPort({ balances: async (_c, _r, ids) => new Map(ids.map(id => [id, id === cid(2) ? 50 : 0])) })
    expect(await count({ minPoints: 10 })).toBe(1)
  })

  it('lanza, prepara por páginas con outbox determinista, reintenta sin duplicar y cancela', async () => {
    await seed('a', 450, true)
    const c = await makeCampaign()
    const sim = await ok('simularCampana', 'alice', { restaurantId: 'a', campaignId: c.campaignId })
    expect(sim).toMatchObject({ audience: 456, recipients: 450 })
    expect(sim.preview.body).toContain('/baja/a?t=VISTA_PREVIA')
    expect(sim.preview.subject).toBe('Noche')
    const launched = await launch(c.campaignId, c.revision)
    expect(launched.status).toBe('scheduled')
    const job = await f.admin.query("SELECT kind,deduplication_key,payload FROM llenamos.jobs WHERE restaurant_id='a'")
    expect(job.rows).toEqual([{ kind: 'marketing.procesar_campana', deduplication_key: c.campaignId, payload: { campaignId: c.campaignId } }])
    // Lanzar otra vez la misma campaña no crea otro trabajo (otra requestId, ya no es borrador).
    expect((await f.call('lanzarCampana', 'alice', { restaurantId: 'a', requestId: reqId(), campaignId: c.campaignId, expectedRevision: launched.revision, at: null })).status).toBe(412)
    // Antes de la hora programada no se prepara nada.
    expect((await member('a', 'alice', cl => processCampaigns(cl, 'a', launched.scheduledAt - 1))).campaigns).toEqual([])
    const { calls, queued } = await drain('a', inWindow)
    expect(calls).toBe(3)
    expect(queued).toBe(450)
    const outbox = await f.admin.query("SELECT id,payload FROM llenamos.outbox WHERE kind='marketing.campaign_message' AND restaurant_id='a'")
    expect(outbox.rowCount).toBe(450)
    expect(outbox.rows.map(r => r.id)).toContain(campaignOutboxId(c.campaignId, cid(1)))
    const sample = outbox.rows.find(r => r.payload.customerId === cid(7))!.payload
    expect(sample).toMatchObject({ campaignId: c.campaignId, channel: 'email', purpose: 'marketing_email', template: 'marketing_campaign', language: 'es' })
    // El token de baja no viaja en el outbox: se crea al enviar (issueUnsubscribeUrl), y entonces solo queda su hash.
    expect(sample.data.unsubscribeUrl).toBe('')
    expect(sample.data.ctaUrl).toContain('llc=' + c.campaignId)
    expect(JSON.stringify(outbox.rows.map(r => r.payload))).not.toContain('@x.test')
    expect((await f.admin.query("SELECT count(*)::int AS n FROM llenamos.marketing_unsubscribe_tokens WHERE restaurant_id='a'")).rows[0].n).toBe(0)
    const url = await member('a', 'alice', cl => issueUnsubscribeUrl(cl, 'a', sample, 'a'))
    expect(url).toMatch(/^https:\/\/app\.example\.test\/baja\/a\?t=[A-Za-z0-9_-]{43}$/)
    const stored = await f.admin.query("SELECT token_hash FROM llenamos.marketing_unsubscribe_tokens WHERE restaurant_id='a'")
    expect(stored.rowCount).toBe(1)
    expect(JSON.stringify(stored.rows)).not.toContain(url.split('t=')[1])
    const report = await ok('informeCampana', 'alice', { restaurantId: 'a', campaignId: c.campaignId })
    expect(report).toMatchObject({ status: 'sent', audience: 456, queued: 450, sent: 0, captured: 0, notConfigured: 0, failed: 0, cancelled: 0, unsubscribed: 0 })
    expect(report.excluded).toEqual({ no_contact: 1, no_consent: 1, withdrawn: 1, suppressed: 1, frequency: 1, duplicate_contact: 1 })
    expect(await f.admin.query("SELECT count(*)::int AS n FROM llenamos.marketing_send_log WHERE campaign_id=$1", [c.campaignId])).toMatchObject({ rows: [{ n: 450 }] })
    // Reintento tras un fallo del worker: se reabre la campaña y vuelve a procesarse; no hay mensajes ni tokens nuevos.
    await f.admin.query("UPDATE llenamos.marketing_campaigns SET status='scheduled',cursor=NULL WHERE restaurant_id='a'")
    expect((await drain('a', inWindow)).queued).toBe(0)
    expect((await f.admin.query("SELECT count(*)::int AS n FROM llenamos.outbox WHERE kind='marketing.campaign_message'")).rows[0].n).toBe(450)
    // (el recuento de tokens pasó a ser por envío; ver el test de baja)
    // El worker deja el estado final: sent y not_configured (sin proveedor), sin repetir.
    await member('a', 'alice', async cl => {
      expect(await markCampaignMessageOutcome(cl, 'a', c.campaignId, cid(1), 'sent')).toBe(true)
      expect(await markCampaignMessageOutcome(cl, 'a', c.campaignId, cid(1), 'sent')).toBe(false)
      expect(await markCampaignMessageOutcome(cl, 'a', c.campaignId, cid(2), 'not_configured')).toBe(true)
    })
    const after = await ok('informeCampana', 'alice', { restaurantId: 'a', campaignId: c.campaignId })
    expect(after).toMatchObject({ queued: 448, sent: 1, notConfigured: 1 })
  })

  it('retirar el permiso cancela los pendientes de ese cliente; cancelar la campaña cancela el resto', async () => {
    await seed('a', 450)
    const c = await makeCampaign()
    const l = await launch(c.campaignId, c.revision)
    const first = await member('a', 'alice', cl => processCampaigns(cl, 'a', inWindow, 200))
    expect(first).toMatchObject({ queued: 200, more: true })
    // Retirada por personal (no por el enlace): el disparador borra el mensaje pendiente de ese cliente.
    await member('a', 'alice', cl => recordConsent(cl, { restaurantId: 'a', id: 'staff-w1', customerId: cid(5), purpose: 'marketing_email', status: 'withdrawn', policyVersion: 'v1', at: inWindow + 1000, source: 'staff', evidenceId: 'x' }))
    const mid = await ok('informeCampana', 'alice', { restaurantId: 'a', campaignId: c.campaignId })
    expect(mid).toMatchObject({ status: 'sending', queued: 199, cancelled: 1 })
    expect((await f.admin.query("SELECT count(*)::int AS n FROM llenamos.outbox WHERE payload->>'customerId'=$1", [cid(5)])).rows[0].n).toBe(0)
    const cancelled = await ok('cancelarCampana', 'alice', { restaurantId: 'a', requestId: reqId(), campaignId: c.campaignId, expectedRevision: mid.status && (await f.admin.query("SELECT revision FROM llenamos.marketing_campaigns WHERE id=$1", [c.campaignId])).rows[0].revision, reason: 'Error' })
    expect(cancelled.cancelledMessages).toBe(199)
    expect((await f.admin.query("SELECT count(*)::int AS n FROM llenamos.outbox WHERE kind='marketing.campaign_message'")).rows[0].n).toBe(0)
    const end = await ok('informeCampana', 'alice', { restaurantId: 'a', campaignId: c.campaignId })
    expect(end).toMatchObject({ status: 'cancelled', queued: 0, cancelled: 200 })
    // Una campaña cancelada ya no prepara más páginas y no se puede cancelar dos veces.
    expect((await drain('a', inWindow)).queued).toBe(0)
    const rev = (await f.admin.query('SELECT revision FROM llenamos.marketing_campaigns WHERE id=$1', [c.campaignId])).rows[0].revision
    expect((await f.call('cancelarCampana', 'alice', { restaurantId: 'a', requestId: reqId(), campaignId: c.campaignId, expectedRevision: rev, reason: 'otra' })).status).toBe(412)
    void l
  })

  it('un permiso retirado entre páginas deja fuera al cliente y la ventana de envío se respeta', async () => {
    await seed('a', 250)
    const c = await makeCampaign()
    await launch(c.campaignId, c.revision)
    // Fuera de ventana (03:00 hora de Madrid o antes): no se escribe nada y se indica cuándo volver.
    const night = Date.parse(new Date(inWindow).toISOString().slice(0, 10) + 'T01:00:00Z')
    const out = await member('a', 'alice', cl => processCampaigns(cl, 'a', night > Date.now() + DAY ? night : inWindow + DAY - 11 * 3_600_000))
    expect(out.queued).toBe(0)
    await f.admin.query("UPDATE llenamos.marketing_campaigns SET scheduled_at=to_timestamp(0)")
    const nightNow = nextSendTime(inWindow, 'Europe/Madrid', settings.sendWindow) - 12 * 3_600_000
    const w = await member('a', 'alice', cl => processCampaigns(cl, 'a', nightNow))
    expect(w).toMatchObject({ queued: 0, campaigns: [], more: true })
    expect(w.retryAt).toBe(nextSendTime(nightNow, 'Europe/Madrid', settings.sendWindow))
    expect(w.retryAt).toBeGreaterThan(nightNow)
    await member('a', 'alice', cl => processCampaigns(cl, 'a', inWindow, 200))
    // Cliente 230 (segunda página) retira el permiso antes de que se prepare.
    await f.admin.query("INSERT INTO llenamos.marketing_consents(restaurant_id,id,customer_id,purpose,status,policy_version,at,source,evidence_id) VALUES('a','w230',$1,'marketing_email','withdrawn','v1',$2,'staff','e')", [cid(230), new Date(inWindow - 1000)])
    const second = await member('a', 'alice', cl => processCampaigns(cl, 'a', inWindow, 200))
    expect(second.queued).toBe(49)
    const report = await ok('informeCampana', 'alice', { restaurantId: 'a', campaignId: c.campaignId })
    expect(report).toMatchObject({ status: 'sent', queued: 249 })
    expect(report.excluded.withdrawn).toBe(1)
    expect(Object.keys(report.excluded).sort()).toEqual([...CAMPAIGN_EXCLUSIONS].sort())
  })

  it('un módulo de marketing apagado detiene la preparación y no envía a quien ya no puede recibir', async () => {
    await seed('a', 10)
    const c = await makeCampaign()
    await launch(c.campaignId, c.revision)
    await f.admin.query("UPDATE llenamos.restaurants SET active_modules=ARRAY['reservations'] WHERE id='a'")
    expect((await member('a', 'alice', cl => processCampaigns(cl, 'a', inWindow))).queued).toBe(0)
    await f.admin.query("UPDATE llenamos.restaurants SET active_modules=$1 WHERE id='a'", [['marketing']])
    await member('a', 'alice', cl => processCampaigns(cl, 'a', inWindow))
    const payload = (await f.admin.query("SELECT payload FROM llenamos.outbox WHERE payload->>'customerId'=$1", [cid(3)])).rows[0].payload
    const check = (now = inWindow) => member('a', 'alice', cl => resolveCampaignMessage(cl, 'a', payload, now))
    expect(await check()).toMatchObject({ ok: true, to: 'c3@x.test', channel: 'email' })
    const nightTime = Date.parse(new Date(inWindow).toISOString().slice(0, 10) + 'T02:00:00Z');
    expect(await check(nightTime)).toMatchObject({ ok: false, reason: 'outside_window' })
    await f.admin.query("UPDATE llenamos.customer_marketing SET redacted=true WHERE customer_id=$1", [cid(3)])
    expect(await check()).toMatchObject({ ok: false, reason: 'suppressed' })
    await f.admin.query("UPDATE llenamos.customer_marketing SET redacted=false WHERE customer_id=$1", [cid(3)])
    await f.admin.query("UPDATE llenamos.marketing_campaigns SET status='cancelled'")
    expect(await check()).toMatchObject({ ok: false, reason: 'campaign_cancelled' })
  })

  describe('baja pública', () => {
    async function prepared() {
      await seed('a', 3)
      const c = await makeCampaign()
      await launch(c.campaignId, c.revision)
      await member('a', 'alice', cl => processCampaigns(cl, 'a', inWindow))
      const rows = (await f.admin.query("SELECT payload FROM llenamos.outbox WHERE kind='marketing.campaign_message' ORDER BY payload->>'customerId'")).rows
      // El enlace de baja se crea al enviar (en el worker): el outbox no lleva el token.
      expect(rows.every(r => r.payload.data.unsubscribeUrl === '')).toBe(true)
      const urls = await Promise.all(rows.map(r => member('a', 'alice', cl => issueUnsubscribeUrl(cl, 'a', r.payload, 'a'))))
      return { c, tokens: urls.map(u => u.split('t=')[1] as string) }
    }
    it('retira el permiso, cancela lo pendiente, marca el token y responde igual en todos los casos', async () => {
      const { c, tokens } = await prepared()
      const res = await f.call('darseDeBaja', null, { slug: 'a', token: tokens[0], website: '' })
      expect(res).toMatchObject({ status: 200, body: { result: { ok: true } } })
      const consent = await f.admin.query("SELECT status,source,policy_version FROM llenamos.marketing_consents WHERE id LIKE 'unsubscribe.%'")
      expect(consent.rows).toEqual([{ status: 'withdrawn', source: 'public', policy_version: 'unsubscribe' }])
      expect((await f.admin.query("SELECT count(*)::int AS n FROM llenamos.outbox WHERE payload->>'customerId'=$1", [cid(1)])).rows[0].n).toBe(0)
      expect((await f.admin.query("SELECT count(*)::int AS n FROM llenamos.outbox WHERE kind='marketing.campaign_message'")).rows[0].n).toBe(2)
      expect((await f.admin.query("SELECT status FROM llenamos.marketing_campaign_recipients WHERE customer_id=$1", [cid(1)])).rows[0].status).toBe('cancelled')
      const ev = await f.admin.query("SELECT payload,entity_id FROM llenamos.events WHERE topic='campanas.baja'")
      expect(ev.rows).toEqual([{ payload: { purpose: 'marketing_email' }, entity_id: c.campaignId }])
      expect((await ok('informeCampana', 'alice', { restaurantId: 'a', campaignId: c.campaignId })).unsubscribed).toBe(1)
      // Repetir, token falso, slug inexistente, token de otro restaurante: misma respuesta y sin cambios.
      const same = { ok: true }
      for (const body of [{ slug: 'a', token: tokens[0] }, { slug: 'a', token: 'x'.repeat(43) }, { slug: 'no-existe', token: tokens[1] }, { slug: 'b', token: tokens[1] }])
        expect((await f.call('darseDeBaja', null, { ...body, website: '' })).body.result).toEqual(same)
      expect((await f.admin.query("SELECT count(*)::int AS n FROM llenamos.marketing_consents WHERE id LIKE 'unsubscribe.%'")).rows[0].n).toBe(1)
      // Campo trampa: relleno responde ok sin hacer nada (el esquema solo deja `website` vacío; el operador lo vuelve a comprobar).
      expect(await unsubscribe(f.app, { slug: 'a', token: tokens[2]!, website: 'http://spam' })).toEqual({ ok: true })
      expect((await f.admin.query("SELECT count(*)::int AS n FROM llenamos.marketing_consents WHERE id LIKE 'unsubscribe.%'")).rows[0].n).toBe(1)
      // El enlace no caduca para darse de baja: aunque `expires_at` (la fecha de poda) haya pasado, la baja se registra.
      await f.admin.query("UPDATE llenamos.marketing_unsubscribe_tokens SET expires_at=now()-interval '1 day'")
      await unsubscribe(f.app, { slug: 'a', token: tokens[2]!, website: '' })
      expect((await f.admin.query("SELECT count(*)::int AS n FROM llenamos.marketing_consents WHERE id LIKE 'unsubscribe.%'")).rows[0].n).toBe(2)
      expect((await f.admin.query("SELECT payload->>'purpose' AS purpose FROM llenamos.events WHERE topic='marketing.unsubscribed'")).rows).toHaveLength(2)
      // La baja deja de recibirse también en el filtro de audiencia.
      expect((await f.call('darseDeBaja', null, { slug: 'a', token: tokens[1], website: 'x' })).status).toBe(400)
    })

    it('el proceso HTTP no puede leer ni escribir los contadores ni los tokens directamente', async () => {
      await expect(f.app.query('SELECT * FROM llenamos.marketing_unsubscribe_limits')).rejects.toMatchObject({ code: '42501' })
      await expect(f.app.query("SELECT * FROM llenamos.marketing_unsubscribe_tokens")).resolves.toMatchObject({ rowCount: 0 }) // RLS: sin identidad no ve nada
      await expect(f.app.query("SELECT llenamos.marketing_on_withdrawn()")).rejects.toMatchObject({ code: '42501' })
      await expect(f.app.query("SELECT llenamos.marketing_cancel_pending('a',NULL,NULL,NULL)")).rejects.toMatchObject({ code: '42501' })
      await expect(f.app.query("SELECT llenamos.marketing_cancel_campaign('a','x')")).rejects.toMatchObject({ message: expect.stringContaining('marketing_denied') })
    })

    it('abuso: una inundación de tokens falsos se frena con 429 pero una baja legítima sigue pasando; la tabla no crece sin límite', async () => {
      const { tokens } = await prepared()
      const now = new Date(Date.UTC(2026, 10, 20, 12, 0, 30))
      setUnsubscribeLimits({ windowSeconds: 3600, failuresPerSlug: 20, unknownSlug: 5, perIp: 1000 })
      const fake = () => ({ slug: 'a', token: randomUUID().replace(/-/g, '') + 'abcdefghijkl', website: '' })
      let limited = 0
      for (let i = 0; i < 60; i++) { try { await unsubscribe(f.app, fake(), now, '203.0.113.9') } catch (e: any) { expect(e).toMatchObject({ status: 429, code: 'resource-exhausted' }); limited++ } }
      expect(limited).toBe(40)
      expect((await f.admin.query('SELECT count(*)::int AS n FROM llenamos.marketing_unsubscribe_limits')).rows[0].n).toBeLessThanOrEqual(1 + 1)
      // Con el slug ya en su límite de fallos, una baja con token válido pasa y queda registrada.
      expect(await unsubscribe(f.app, { slug: 'a', token: tokens[2]!, website: '' }, now, '203.0.113.9')).toEqual({ ok: true })
      expect((await f.admin.query("SELECT count(*)::int AS n FROM llenamos.marketing_consents WHERE id LIKE 'unsubscribe.%'")).rows[0].n).toBe(1)
      // Slug inexistente: un único contador, sin una fila por slug.
      const later = new Date(now.getTime() + 2 * 3600_000)
      const before = (await f.admin.query('SELECT count(*)::int AS n FROM llenamos.marketing_unsubscribe_limits')).rows[0].n
      const unknown: string[] = []
      for (let i = 0; i < 12; i++) { try { await unsubscribe(f.app, { slug: `slug-${i}`, token: 'y'.repeat(43), website: '' }, later); unknown.push('ok') } catch (e: any) { unknown.push(String(e.status)) } }
      expect(unknown.filter(x => x === '429')).toHaveLength(7)
      expect((await f.admin.query('SELECT count(*)::int AS n FROM llenamos.marketing_unsubscribe_limits')).rows[0].n - before).toBeLessThanOrEqual(2)
      // Las ventanas viejas se podan.
      await unsubscribe(f.app, fake(), new Date(later.getTime() + 24 * 3600_000))
      expect((await f.admin.query('SELECT count(*)::int AS n FROM llenamos.marketing_unsubscribe_limits WHERE window_start<$1', [new Date(later.getTime())])).rows[0].n).toBe(0)
    })

    it('límite por IP verificada: una IP que inunda se corta aunque el token sea válido, otra IP no se ve afectada', async () => {
      const { tokens } = await prepared()
      const now = new Date(Date.UTC(2026, 10, 21, 12, 0, 30))
      setUnsubscribeLimits({ windowSeconds: 3600, failuresPerSlug: 1000, unknownSlug: 1000, perIp: 4 })
      const results: string[] = []
      for (let i = 0; i < 6; i++) { try { await unsubscribe(f.app, i === 5 ? { slug: 'a', token: tokens[0]!, website: '' } : { slug: 'a', token: 'z'.repeat(40) + i, website: '' }, now, '198.51.100.7'); results.push('ok') } catch (e: any) { results.push(String(e.status)) } }
      expect(results).toEqual(['ok', 'ok', 'ok', 'ok', '429', '429'])
      expect((await f.admin.query("SELECT count(*)::int AS n FROM llenamos.marketing_consents WHERE id LIKE 'unsubscribe.%'")).rows[0].n).toBe(0)
      expect(await unsubscribe(f.app, { slug: 'a', token: tokens[0]!, website: '' }, now, '198.51.100.8')).toEqual({ ok: true })
      expect((await f.admin.query("SELECT count(*)::int AS n FROM llenamos.marketing_consents WHERE id LIKE 'unsubscribe.%'")).rows[0].n).toBe(1)
    })
  })

  it('origen de reservas: registro, resultado final, informe por periodo y locales', async () => {
    await member('a', 'alice', async cl => {
      const base = { restaurantId: 'a', locationId: 'a-main', serviceDate: '2026-11-12', partySize: 4 }
      await recordReservationOrigin(cl, { ...base, reservationId: 'r1', reservationSource: 'widget', attribution: { utmSource: 'instagram', utmMedium: 'social', utmCampaign: null, utmContent: null, utmTerm: null, adId: null, campaignId: null, clickIds: [], referrer: null, embedHost: null, landingPath: null } })
      await recordReservationOrigin(cl, { ...base, reservationId: 'r2', partySize: 2, reservationSource: 'phone', attribution: null })
      await recordReservationOrigin(cl, { ...base, reservationId: 'r2', partySize: 9, reservationSource: 'phone', attribution: null }) // repetir es inocuo
      await recordReservationOrigin(cl, { ...base, reservationId: 'r3', locationId: 'a-terraza', reservationSource: 'web', attribution: { utmSource: null, utmMedium: null, utmCampaign: null, utmContent: null, utmTerm: null, adId: null, campaignId: 'camp1', clickIds: [], referrer: null, embedHost: null, landingPath: null } })
      expect(await updateOriginOutcome(cl, 'a', 'r1', { status: 'finished', salesCents: 8400 })).toBe(true)
      expect(await updateOriginOutcome(cl, 'a', 'r2', { status: 'no_show' })).toBe(true)
      expect(await updateOriginOutcome(cl, 'a', 'nope', { status: 'seated' })).toBe(false)
      await recordReservationConsents(cl, { restaurantId: 'a', reservationId: 'r1', customerId: cid(1), optIn: { email: true, whatsapp: false, policyVersion: 'v1' }, at: 1000 })
      await recordReservationConsents(cl, { restaurantId: 'a', reservationId: 'r1', customerId: cid(1), optIn: { email: true, whatsapp: false, policyVersion: 'v1' }, at: 1000 })
    })
    expect((await f.admin.query("SELECT id,purpose,evidence_id FROM llenamos.marketing_consents WHERE id LIKE 'reservation.%'")).rows).toEqual([{ id: 'reservation.r1.email', purpose: 'marketing_email', evidence_id: 'r1' }])
    const all = await ok('informeOrigen', 'mia', { restaurantId: 'a', from: '2026-11-01', to: '2026-11-30', locationIds: null })
    expect(all.withoutOrigin).toBe(0)
    expect(all.rows).toHaveLength(3)
    expect(all.rows.find((r: any) => r.channel === 'instagram')).toMatchObject({ reservations: 1, covers: 4, seated: 1, salesCents: 8400 })
    expect(all.rows.find((r: any) => r.channel === 'phone')).toMatchObject({ reservations: 1, covers: 2, noShows: 1 })
    expect(all.rows.find((r: any) => r.channel === 'campaign')).toMatchObject({ campaignId: 'camp1', reservations: 1 })
    const main = await ok('informeOrigen', 'mia', { restaurantId: 'a', from: '2026-11-01', to: '2026-11-30', locationIds: ['a-main'] })
    expect(main.rows).toHaveLength(2)
    expect((await ok('informeOrigen', 'mia', { restaurantId: 'a', from: '2026-12-01', to: '2026-12-31', locationIds: null })).rows).toEqual([])
    expect((await f.call('informeOrigen', 'mia', { restaurantId: 'a', from: '2026-12-01', to: '2026-11-01', locationIds: null })).status).toBe(400)
    expect((await f.call('informeOrigen', 'bob', { restaurantId: 'a', from: '2026-11-01', to: '2026-11-30', locationIds: null })).status).toBe(403)
    expect((await ok('informeOrigen', 'bob', { restaurantId: 'b', from: '2026-11-01', to: '2026-11-30', locationIds: null })).rows).toEqual([])
    // Función reutilizable para análisis.
    const direct = await member('a', 'alice', cl => originReportRows(cl, 'a', ['a-main', 'a-terraza'], '2026-11-12', '2026-11-12'))
    expect(direct.rows).toHaveLength(3)
    // La campaña ve sus reservas en el informe.
    const seg = await makeCampaign()
    await f.admin.query("UPDATE llenamos.reservation_origins SET campaign_id=$1 WHERE reservation_id='r1'", [seg.campaignId])
    expect(await ok('informeCampana', 'alice', { restaurantId: 'a', campaignId: seg.campaignId })).toMatchObject({ reservations: 1, covers: 4, seated: 1, salesCents: 8400 })
  })
})
