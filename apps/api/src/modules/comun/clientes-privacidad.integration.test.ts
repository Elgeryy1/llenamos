import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as core from '@llenamos/core'
import { createHash } from 'node:crypto'
import { enqueueJob } from '../../jobs.js'
import { privacyHandler } from '../../privacy/handler.js'
import { campaignOutboxId, issueUnsubscribeUrl } from '../campanas/proceso.js'
import { uncoveredTables } from '../../privacy/known.js'
import { withTenant } from '../../worker/tenant.js'
import { stableUuid } from '../../ids.js'
import { MODULES } from '../index.js'
import { setRepiteAdapter } from '../fidelizacion/ports.js'
import { compactLots } from '../fidelizacion/puntos.js'
import { liveQueries as loyaltyLive } from '../fidelizacion/live.js'
import { campanasModule } from '../campanas/index.js'
import { fidelizacion } from '../fidelizacion/index.js'
import { analisisModule } from '../analisis/index.js'
import { clientesEnvironment, cid, req, type ClientesEnvironment } from './entorno.js'

const enabled = process.env.TEST_POSTGRES_API === '1' && !!process.env.TEST_POSTGRES_URL
const rejects = async (p: Promise<unknown>) => { try { await p } catch (error) { return error as { code?: string; message: string } } throw new Error('Debía fallar') }

describe.skipIf(!enabled)('Clientes: privacidad, permisos de base de datos, alcance de local, Repite y repite_link', () => {
  let env: ClientesEnvironment
  const sql = (text: string, params: unknown[] = []) => env.db.admin.query(text, params)
  beforeAll(async () => { env = await clientesEnvironment('clipriv') }, 90_000)
  afterAll(async () => { setRepiteAdapter(null); await env?.close() })

  describe('privacidad', () => {
    // El id sale del teléfono sin sal, como en producción: justo lo que no debe poder volver a ligarse tras un borrado.
    const phone = '+34600111222'
    const campaign0 = 'camp1'
    const subject = core.customerIdFor('a', phone), other = cid(2), foreign = cid(5)
    const campaign = 'camp1', pendingMessage = campaignOutboxId(campaign0, subject)
    async function seedCustomer(rid: string, id: string, name: string, tel = '+34600111222') {
      await sql("INSERT INTO llenamos.customer_marketing(restaurant_id,customer_id,name,phone,email,tags,visits,no_shows,last_visit_at,spent_cents,language) VALUES($1,$2,$3,$5,$4,ARRAY['vip'],7,2,now(),9900,'en')", [rid, id, name, `${name.toLowerCase().replace(/ /g, '.')}@example.test`, tel])
      await sql("INSERT INTO llenamos.marketing_consents(restaurant_id,id,customer_id,purpose,status,policy_version,at,source,evidence_id) VALUES($1,$2,$3,'marketing_email','granted','v1',now()-interval '1 day','public','e')", [rid, `g.${id}`, id])
      await sql("INSERT INTO llenamos.loyalty_accounts(restaurant_id,customer_id,status,balance,earned,terms_version,enrolled_at,enrolled_by) VALUES($1,$2,'active',40,40,'1',1,'x')", [rid, id])
      await sql("INSERT INTO llenamos.loyalty_movements(restaurant_id,id,customer_id,kind,points,balance_after,at_ms,reason) VALUES($1,$2,$3,'adjust',40,40,1,'Regalo de cumpleaños de Ana')", [rid, `mv.${name.replace(/ /g, '')}`, id])
      await sql("INSERT INTO llenamos.automation_events(restaurant_id,id,type,subject,at,data) VALUES($1,$2,'customer.lapsed',$3,now(),'{\"daysSinceVisit\":90,\"visits\":3,\"spentCents\":4000}')", [rid, `customer.lapsed.${id}.d`, id])
      await sql("INSERT INTO llenamos.recommendations(restaurant_id,id,rule_id,event_id,event_type,subject,kind,text,evidence,created_at,expires_at) VALUES($1,$2,'r',$3,'customer.lapsed',$4,'contact_customer','Llamar','{\"visits\":3}',now(),now()+interval '7 days')", [rid, `r.${id}`, `customer.lapsed.${id}.d`, id])
    }
    beforeAll(async () => {
      await sql("INSERT INTO llenamos.marketing_campaigns(restaurant_id,id,name,segment_id,channel,content,status,updated_by,stat_queued) VALUES('a',$1,'Vermú','s','email','{\"title\":\"x\",\"body\":\"y\",\"includeBookingLink\":false}','sending','x',1)", [campaign])
      await seedCustomer('a', subject, 'Ana Perez'); await seedCustomer('a', other, 'Luis Gomez', '+34600333444'); await seedCustomer('b', foreign, 'Eva Ruiz', '+34600555666')
      // Una baja por enlace anterior: guarda como prueba el UUID del mensaje, que sale del id de la persona.
      await sql("INSERT INTO llenamos.marketing_consents(restaurant_id,id,customer_id,purpose,status,policy_version,at,source,evidence_id) VALUES('a','unsubscribe.'||repeat('c',64),$1,'marketing_email','withdrawn','unsubscribe',now()-interval '2 days','public',$2)", [subject, pendingMessage])
      for (const [id, status] of [[pendingMessage, 'pending'], [randomUUID(), 'done']] as const)
        await sql("INSERT INTO llenamos.outbox(id,restaurant_id,kind,payload,status) VALUES($1,'a','marketing.campaign_message',$2,$3)", [id, JSON.stringify({ campaignId: campaign, customerId: subject, purpose: 'marketing_email', data: { guestName: 'Ana', unsubscribeUrl: '' } }), status])
      await sql("INSERT INTO llenamos.marketing_campaign_recipients(restaurant_id,campaign_id,customer_id,status,message_id,contact_hash,at) VALUES('a',$1,$2,'queued',$3,$4,now())", [campaign, subject, pendingMessage, 'a'.repeat(64)])
      await sql("INSERT INTO llenamos.marketing_unsubscribe_tokens(restaurant_id,token_hash,customer_id,purpose,message_id,campaign_id,expires_at) VALUES('a',$1,$2,'marketing_email',$3,$4,now()+interval '1 day')", ['b'.repeat(64), subject, randomUUID(), campaign])
      await sql("INSERT INTO llenamos.repite_settings(restaurant_id,merchant_id,enabled,stamp_on,updated_by) VALUES('a','demo',true,'paid','x'),('b','demo',true,'paid','x')")
      for (const [rid, id] of [['a', subject], ['b', foreign]]) await sql("INSERT INTO llenamos.repite_cards(restaurant_id,customer_id,merchant_id,card_id,external_ref,status,created_at_ms) VALUES($1,$2,'demo','card-1','ref-1','active',1)", [rid, id])
      await sql("INSERT INTO llenamos.repite_queue(restaurant_id,id,kind,customer_id,merchant_id,visit_key,trigger,occurred_at_ms,next_attempt_at_ms,result) VALUES('a','stamp.v1','add_stamp',$1,'demo','v1','paid',1,9999999999999,'{\"saveUrl\":\"https://repite.example/guardar/abc\"}')", [subject])
    })
    const request = async (kind: 'export' | 'erase', who: string, rid = 'a') => {
      const id = randomUUID()
      await sql("INSERT INTO llenamos.privacy_requests(id,restaurant_id,subject_id,kind,status,requested_by,verified_by,reason,request_key,request_hash) VALUES($1,$2,$3,$4,'verified','owner-a','owner-a','Petición',$5,$6)", [id, rid, who, kind, `k${id.slice(0, 8)}`.padEnd(8, '0'), '0'.repeat(64)])
      await env.member(rid, 'owner-a', client => enqueueJob(client, { id: stableUuid('privacidad.procesar', id), restaurantId: rid, kind: 'privacidad.procesar', deduplicationKey: id, payload: { requestId: id } }))
      return id
    }
    const status = async (id: string) => (await sql('SELECT status,error FROM llenamos.privacy_requests WHERE id=$1', [id])).rows[0]
    const V7_TABLES = ['customer_marketing', 'marketing_consents', 'marketing_campaign_recipients', 'marketing_send_log', 'loyalty_accounts', 'loyalty_movements', 'loyalty_lots', 'loyalty_redemptions', 'promotion_customer_uses', 'bill_promotions', 'repite_cards', 'repite_queue']

    it('los tres módulos declaran sus tablas personales y un contribuyente de privacidad', () => {
      for (const module of [campanasModule, fidelizacion, analisisModule]) {
        expect(module.personalData?.length, module.name).toBeGreaterThan(0)
        expect(module.privacy, module.name).toBeDefined()
      }
      expect(campanasModule.marketingConsent).toBeDefined()
      expect(campanasModule.privacy!.subjectExists).toBeDefined()
    })

    it('exportar, con el rol del worker, reúne lo de la persona en los tres módulos y nada de otras personas ni de otro restaurante', async () => {
      const bundle = await withTenant(env.db.worker, 'a', async client => {
        const out: Record<string, readonly Record<string, unknown>[]> = {}
        for (const module of [campanasModule, fidelizacion, analisisModule]) Object.assign(out, await module.privacy!.exportData(client, 'a', subject))
        return out
      })
      const text = JSON.stringify(bundle)
      expect(Object.keys(bundle)).toEqual(expect.arrayContaining(['marketing_ficha', 'marketing_permisos', 'marketing_envios', 'fidelizacion_cuenta', 'fidelizacion_movimientos', 'repite_tarjeta', 'analisis_eventos', 'analisis_recomendaciones']))
      expect(text).toContain('Ana Perez'); expect(text).toContain('Regalo de cumpleaños')
      expect(text).not.toContain('Luis Gomez'); expect(text).not.toContain('Eva Ruiz')
      const none = await withTenant(env.db.worker, 'a', client => campanasModule.privacy!.exportData(client, 'a', foreign))
      expect(Object.values(none).flat()).toEqual([])
    })

    it('el enlace de baja se crea con el rol del worker y solo deja el hash', async () => {
      const url = await withTenant(env.db.worker, 'a', client => issueUnsubscribeUrl(client, 'a', { campaignId: campaign, customerId: other, purpose: 'marketing_email', messageId: randomUUID() }, 'a'))
      const raw = /t=([A-Za-z0-9_-]{43})$/.exec(url)![1]!
      const rows = (await sql("SELECT token_hash FROM llenamos.marketing_unsubscribe_tokens WHERE customer_id=$1", [other])).rows
      expect(rows).toEqual([{ token_hash: createHash('sha256').update(raw).digest('hex') }])
      await sql('DELETE FROM llenamos.marketing_unsubscribe_tokens WHERE customer_id=$1', [other])
    })

    it('un borrado espera a que la tarjeta se retire en Repite, reabre la retirada que falló y deja todo sin poder ligarse al teléfono', async () => {
      // 1. Un envío en curso bloquea. (El adaptador de Repite ya está puesto: la retirada que este paso encola falla de forma definitiva.)
      let removeFails = true
      const removed: string[] = []
      setRepiteAdapter({ ...core.notConfiguredRepite(), removeCard: async p => { if (removeFails) return { ok: false, error: { code: 'invalid', message: 'no', retryable: false } }; removed.push(p.cardId); return { ok: true, value: {} } } } as core.RepiteAdapter)
      await sql("UPDATE llenamos.outbox SET status='leased',lease_until=now()+interval '5 minutes' WHERE restaurant_id='a' AND status='pending'")
      const blocked = await request('erase', subject)
      await env.drain()
      expect(await status(blocked)).toMatchObject({ status: 'blocked' })
      expect(await env.member('a', 'owner-a', client => campanasModule.privacy!.blockers!(client, 'a', subject))).toEqual([expect.stringContaining('marketing')])
      expect((await sql('SELECT name FROM llenamos.customer_marketing WHERE customer_id=$1', [subject])).rows[0].name).toBe('Ana Perez')
      await sql("UPDATE llenamos.outbox SET status='pending',lease_until=NULL,available_at=now()+interval '1 day' WHERE restaurant_id='a' AND status='leased'")

      // 2. La tarjeta sigue activa: la solicitud se bloquea y deja encolada su retirada. Si esa retirada falla, otra verificación la reabre.
      const waiting = await request('erase', subject)
      await env.drain()
      expect(await status(waiting)).toMatchObject({ status: 'blocked', error: expect.stringContaining('tarjeta de Repite') })
      expect((await sql("SELECT status FROM llenamos.repite_queue WHERE id=$1", [`remove.${subject}`])).rows[0].status).toBe('failed')
      expect((await sql("SELECT status FROM llenamos.repite_cards WHERE restaurant_id='a' AND customer_id=$1", [subject])).rows[0].status).toBe('active')
      removeFails = false
      const reopened = await request('erase', subject)
      await env.drain(); await env.drain()
      expect(removed).toEqual(['card-1'])
      expect((await sql("SELECT status FROM llenamos.repite_cards WHERE restaurant_id='a' AND customer_id=$1", [subject])).rows[0].status).toBe('removed')
      expect(await status(reopened)).toMatchObject({ status: 'blocked' }) // la retirada acabó durante esta pasada: hace falta verificar una vez más

      // 3. Con la tarjeta retirada el borrado se completa.
      const done = await request('erase', subject)
      await env.drain()
      expect(await status(done), 'estado').toMatchObject({ status: 'completed', error: null })

      // El id sacado del teléfono ya no encuentra nada en ninguna tabla de V7...
      for (const table of V7_TABLES) expect((await sql(`SELECT count(*)::int AS n FROM llenamos.${table} WHERE restaurant_id='a' AND customer_id=$1`, [subject])).rows[0].n, table).toBe(0)
      expect((await env.ok('verCuentaFidelizacion', 'owner-a', { restaurantId: 'a', customerId: subject })).movements).toEqual([])
      expect((await env.ok('verCuentaFidelizacion', 'owner-a', { restaurantId: 'a', customerId: subject })).enrolled).toBe(false)
      // ...y lo anónimo vive bajo otro id, vacío de datos personales y de historial.
      const fresh = (await sql("SELECT customer_id FROM llenamos.loyalty_movements WHERE id=$1", ['mv.AnaPerez'])).rows[0].customer_id as string
      expect(fresh).not.toBe(subject)
      expect((await sql('SELECT name,phone,email,tags,language,visits,no_shows,last_visit_at,spent_cents,redacted FROM llenamos.customer_marketing WHERE customer_id=$1', [fresh])).rows[0])
        .toEqual({ name: '', phone: null, email: null, tags: [], language: 'es', visits: 0, no_shows: 0, last_visit_at: null, spent_cents: '0', redacted: true })
      expect((await env.ok('verCuentaFidelizacion', 'owner-a', { restaurantId: 'a', customerId: fresh })).enrolled).toBe(false) // cuenta cerrada
      expect((await sql("SELECT count(*)::int AS n FROM llenamos.marketing_consents WHERE customer_id=$1 AND id LIKE 'erasure.%'", [fresh])).rows[0].n).toBe(3)
      // Mensajes: el pendiente (que el contribuyente común ya había vaciado) se cancela por cliente y mensaje, no por payload.
      expect((await sql("SELECT status,contact_hash FROM llenamos.marketing_campaign_recipients WHERE campaign_id=$1 AND customer_id=$2", [campaign, fresh])).rows).toEqual([{ status: 'cancelled', contact_hash: null }])
      // B1: ni el id viejo ni nada derivado de él (permisos `erasure.<id>`, `card.<id>`, `remove.<id>`, el UUID del mensaje de cada campaña…) queda como llave.
      const derived = [subject, pendingMessage]
      for (const table of [...V7_TABLES, 'outbox', 'jobs', 'events', 'message_deliveries', 'automation_events', 'recommendations'])
        for (const needle of derived) expect((await sql(`SELECT count(*)::int AS n FROM llenamos.${table} t WHERE t.restaurant_id='a' AND t::text LIKE $1`, [`%${needle}%`])).rows[0].n, `${table} contiene ${needle}`).toBe(0)
      expect((await sql("SELECT count(*)::int AS n FROM llenamos.outbox WHERE id=$1 OR id=$2", [pendingMessage, stableUuid(core.campaignMessageId(campaign, subject))])).rows[0].n).toBe(0)
      expect((await sql("SELECT count(*)::int AS n FROM llenamos.marketing_consents WHERE evidence_id=$1", [pendingMessage])).rows[0].n).toBe(0) // la baja por enlace ya no apunta al mensaje
      expect((await sql("SELECT count(*)::int AS n FROM llenamos.marketing_consents WHERE id LIKE $1", [`%${subject}%`])).rows[0].n).toBe(0)
      expect((await sql("SELECT count(*)::int AS n FROM llenamos.repite_queue WHERE id IN ($1,$2)", [`card.${subject}`, `remove.${subject}`])).rows[0].n).toBe(0)
      expect((await sql("SELECT stat_cancelled,stat_queued FROM llenamos.marketing_campaigns WHERE id=$1", [campaign])).rows[0]).toEqual({ stat_cancelled: 1, stat_queued: 0 })
      expect((await sql("SELECT count(*)::int AS n FROM llenamos.outbox WHERE payload::text LIKE '%Ana%'")).rows[0].n).toBe(0)
      expect((await sql('SELECT count(*)::int AS n FROM llenamos.marketing_unsubscribe_tokens WHERE customer_id=$1', [fresh])).rows[0].n).toBe(0)
      expect((await sql('SELECT reason FROM llenamos.loyalty_movements WHERE customer_id=$1', [fresh])).rows).toEqual([{ reason: null }])
      expect((await sql("SELECT status,result FROM llenamos.repite_queue WHERE id='stamp.v1'")).rows[0]).toEqual({ status: 'skipped', result: null })
      expect((await sql('SELECT count(*)::int AS n FROM llenamos.automation_events WHERE subject=$1', [subject])).rows[0].n).toBe(0)
      expect((await sql("SELECT subject,event_id,evidence FROM llenamos.recommendations WHERE restaurant_id='a' AND subject='redacted'")).rows[0]).toEqual({ subject: 'redacted', event_id: 'redacted', evidence: {} })
      // Otras personas y otro restaurante, intactos.
      expect((await sql('SELECT name,visits FROM llenamos.customer_marketing WHERE customer_id=$1', [other])).rows[0]).toEqual({ name: 'Luis Gomez', visits: 7 })
      expect((await sql('SELECT name,redacted FROM llenamos.customer_marketing WHERE customer_id=$1', [foreign])).rows[0]).toEqual({ name: 'Eva Ruiz', redacted: false })
      expect((await sql("SELECT status FROM llenamos.repite_cards WHERE restaurant_id='b'")).rows[0].status).toBe('active')
      // Quien reserve de nuevo con ese teléfono empieza de cero: ni historial, ni permisos, ni cuenta de puntos.
      await env.member('a', 'owner-a', client => client.query("INSERT INTO llenamos.customers(restaurant_id,id,data) VALUES('a',$1,$2)", [subject, JSON.stringify({ name: 'Ana', phone, email: null, language: 'es', visits: 0 })]))
      expect((await sql('SELECT visits,spent_cents,redacted FROM llenamos.customer_marketing WHERE customer_id=$1', [subject])).rows).toEqual([{ visits: 0, spent_cents: '0', redacted: false }])
      expect((await sql("SELECT count(*)::int AS n FROM llenamos.marketing_consents WHERE customer_id=$1", [subject])).rows[0].n).toBe(0)
      expect((await env.ok('verCuentaFidelizacion', 'owner-a', { restaurantId: 'a', customerId: subject })).enrolled).toBe(false)
    })

    it('el borrado no queda bloqueado para siempre: sin Repite configurado, o con la retirada fallando de forma definitiva, la tarjeta se da por retirada en local', async () => {
      for (const [n, mode] of [[80, 'sin-adaptador'], [81, 'fallo-definitivo']] as const) {
        const customer = cid(n)
        setRepiteAdapter(mode === 'sin-adaptador' ? null : { ...core.notConfiguredRepite(), removeCard: async () => ({ ok: false, error: { code: 'invalid', message: 'no existe', retryable: false } }) } as core.RepiteAdapter)
        await sql("INSERT INTO llenamos.customer_marketing(restaurant_id,customer_id,name) VALUES('a',$1,'Sin salida')", [customer])
        await sql("INSERT INTO llenamos.repite_cards(restaurant_id,customer_id,merchant_id,card_id,external_ref,status,created_at_ms) VALUES('a',$1,'demo','card-x','ref-x','active',1)", [customer])
        // Umbral: las 4 primeras verificaciones siguen bloqueando (encola la retirada y la reabre 3 veces); a la quinta, y no antes, se da por retirada en local.
        const seen: string[] = []
        for (let attempt = 0; attempt < 8 && seen.at(-1) !== 'completed'; attempt++) {
          const asked = await request('erase', customer)
          await env.drain()
          seen.push((await status(asked)).status)
        }
        expect(seen, mode).toEqual(['blocked', 'blocked', 'blocked', 'blocked', 'completed'])
        const last = (await sql("SELECT id FROM llenamos.privacy_requests WHERE subject_id=$1 ORDER BY requested_at DESC LIMIT 1", [customer])).rows[0].id as string
        expect(await status(last), mode).toMatchObject({ status: 'completed', error: null })
        expect((await sql('SELECT count(*)::int AS n FROM llenamos.customer_marketing WHERE name=$1', ['Sin salida'])).rows[0].n, mode).toBe(0)
        expect((await sql("SELECT count(*)::int AS n FROM llenamos.repite_cards WHERE card_id='card-x' AND status='removed'")).rows[0].n).toBeGreaterThan(0)
        await sql("DELETE FROM llenamos.repite_cards WHERE card_id='card-x'")
      }
      // La retirada local llega a plataforma: baja pendiente con comercio y tarjeta (no con la persona), que solo plataforma lista y resuelve.
      expect((await sql("SELECT merchant_id,card_id,reason FROM llenamos.repite_pending_removals WHERE restaurant_id='a' ORDER BY created_at,id")).rows)
        .toEqual([{ merchant_id: 'demo', card_id: 'card-x', reason: 'repite_no_configurado' }, { merchant_id: 'demo', card_id: 'card-x', reason: 'retirada_fallida' }])
      expect((await env.call('listarBajasRepitePendientes', 'owner-a', {})).status).toBe(403)
      const listed = await env.ok('listarBajasRepitePendientes', 'plat', {})
      expect(listed.pending).toHaveLength(2)
      expect(listed.pending[0]).toMatchObject({ restaurantId: 'a', merchantId: 'demo', cardId: 'card-x', reason: 'repite_no_configurado' })
      expect((await env.call('resolverBajaRepite', 'owner-a', { restaurantId: 'a', id: listed.pending[0].id })).status).toBe(403)
      await env.ok('resolverBajaRepite', 'plat', { restaurantId: 'a', id: listed.pending[0].id })
      expect((await env.ok('listarBajasRepitePendientes', 'plat', {})).pending).toHaveLength(1)
      expect((await env.call('resolverBajaRepite', 'plat', { restaurantId: 'a', id: listed.pending[0].id })).status).toBe(404) // ya resuelta
      expect((await env.call('resolverBajaRepite', 'plat', { restaurantId: 'a', id: randomUUID() })).status).toBe(404)
      // El restaurante no puede escribir bajas a mano: solo la función del worker, con el comercio y la tarjeta de la propia ficha.
      expect((await rejects(env.member('a', 'owner-a', c => c.query("INSERT INTO llenamos.repite_pending_removals(restaurant_id,merchant_id,card_id,reason) VALUES('a','x','y','retirada_fallida')")))).code).toBe('42501')
      expect((await rejects(env.member('a', 'owner-a', c => c.query("SELECT llenamos.repite_register_removal('a','x','retirada_fallida')")))).message).toContain('marketing_denied')
      setRepiteAdapter(null)
    })

    it('el reasignar el id no depende del orden de los módulos: con fidelización la primera en el gestor, todo se borra y el id viejo desaparece', async () => {
      const customer = cid(82)
      await sql("INSERT INTO llenamos.customer_marketing(restaurant_id,customer_id,name,phone) VALUES('a',$1,'Orden','+34600888000')", [customer])
      await sql("INSERT INTO llenamos.marketing_consents(restaurant_id,id,customer_id,purpose,status,policy_version,at,source,evidence_id) VALUES('a','g82',$1,'marketing_email','granted','v',now(),'public','e')", [customer])
      await sql("INSERT INTO llenamos.loyalty_accounts(restaurant_id,customer_id,status,balance,earned,terms_version,enrolled_at,enrolled_by) VALUES('a',$1,'active',3,3,'1',1,'x')", [customer])
      await sql("INSERT INTO llenamos.automation_events(restaurant_id,id,type,subject,at,data) VALUES('a','ev82','customer.lapsed',$1,now(),'{\"daysSinceVisit\":90,\"visits\":3,\"spentCents\":4000}')", [customer])
      const reversed = [fidelizacion, campanasModule, analisisModule]
      const handler = privacyHandler({ modules: () => reversed })
      const id = await request('erase', customer)
      // Se reejecuta el trabajo ya encolado con el orden invertido: el gestor ejecuta primero todos los `erase` y al final los `finalize`.
      await sql("UPDATE llenamos.privacy_requests SET status='verified' WHERE id=$1", [id])
      await handler({ item: { id: randomUUID(), restaurantId: 'a', kind: 'privacidad.procesar', payload: { requestId: id }, attempts: 1, source: 'jobs' }, tenant: fn => withTenant(env.db.worker, 'a', fn), pool: env.db.worker, credentials: async () => ({}) as never, fetch, now: () => new Date(), signal: new AbortController().signal, extendLease: async () => true })
      expect(await status(id)).toMatchObject({ status: 'completed' })
      for (const table of V7_TABLES) expect((await sql(`SELECT count(*)::int AS n FROM llenamos.${table} WHERE restaurant_id='a' AND customer_id=$1`, [customer])).rows[0].n, table).toBe(0)
      expect((await sql('SELECT count(*)::int AS n FROM llenamos.automation_events WHERE subject=$1', [customer])).rows[0].n).toBe(0)
      expect((await sql("SELECT name,redacted FROM llenamos.customer_marketing WHERE name='' AND redacted AND NOT EXISTS(SELECT 1 FROM llenamos.customer_marketing x WHERE x.customer_id=$1)", [customer])).rowCount).toBeGreaterThan(0)
    })

    it('quien vuelve con el mismo teléfono tras un borrado recibe una tarjeta NUEVA en Repite (otra referencia y otra clave de idempotencia) y puede borrarse otra vez', async () => {
      const customer = cid(90), calls: Array<{ externalRef: string; idempotencyKey: string }> = [], removals: string[] = []
      setRepiteAdapter({ ...core.notConfiguredRepite(),
        createCard: async (p: { externalRef: string; idempotencyKey: string }) => { calls.push({ externalRef: p.externalRef, idempotencyKey: p.idempotencyKey }); return { ok: true, value: { cardId: `card-${calls.length}`, saveUrl: null } } },
        removeCard: async (p: { cardId: string; idempotencyKey: string }) => { removals.push(`${p.cardId}:${p.idempotencyKey}`); return { ok: true, value: {} } } } as unknown as core.RepiteAdapter)
      await sql("UPDATE llenamos.repite_settings SET enabled=true,merchant_id='demo' WHERE restaurant_id='a'")
      const issueCard = async () => {
        await sql("INSERT INTO llenamos.customer_marketing(restaurant_id,customer_id,name) VALUES('a',$1,'Vuelve') ON CONFLICT DO NOTHING", [customer])
        expect((await env.ok('crearTarjetaRepite', 'owner-a', { restaurantId: 'a', requestId: req(), customerId: customer })).status).toBe('queued')
        await env.drain()
      }
      await issueCard()
      expect(calls).toHaveLength(1)
      let done = ''
      for (let i = 0; i < 4 && (await status(done || randomUUID()))?.status !== 'completed'; i++) { done = await request('erase', customer); await env.drain() }
      expect(await status(done)).toMatchObject({ status: 'completed' })
      expect(removals).toHaveLength(1)
      await issueCard()
      // Otra operación `card.<id>` (la vieja se renombró), otra referencia opaca y otra clave: Repite no puede devolver la tarjeta de la persona borrada.
      expect(calls).toHaveLength(2)
      expect(calls[1]!.externalRef).not.toBe(calls[0]!.externalRef)
      expect(calls[1]!.idempotencyKey).not.toBe(calls[0]!.idempotencyKey)
      expect((await sql("SELECT status FROM llenamos.repite_cards WHERE restaurant_id='a' AND customer_id=$1", [customer])).rows).toEqual([{ status: 'active' }])
      // Y un segundo borrado de esa misma persona no se bloquea por la retirada anterior.
      let again = ''
      for (let i = 0; i < 4 && (await status(again || randomUUID()))?.status !== 'completed'; i++) { again = await request('erase', customer); await env.drain() }
      expect(await status(again)).toMatchObject({ status: 'completed' })
      expect(removals).toHaveLength(2)
      expect(new Set(removals).size).toBe(2) // retiradas con claves distintas
      setRepiteAdapter(null)
    })

    it('un bloqueo de otro módulo no deja efectos: con una reserva abierta la tarjeta de Repite ni se toca, y crearTarjetaRepite reabre una tarjeta terminada y retirada', async () => {
      const customer = cid(91)
      await sql("INSERT INTO llenamos.customer_marketing(restaurant_id,customer_id,name) VALUES('a',$1,'Reserva abierta')", [customer])
      await sql("INSERT INTO llenamos.repite_cards(restaurant_id,customer_id,merchant_id,card_id,external_ref,status,created_at_ms) VALUES('a',$1,'demo','card-91','ref-91','active',1)", [customer])
      await sql("INSERT INTO llenamos.reservations(restaurant_id,location_id,id,customer_id,reference,start_at,status,table_ids,manage_token_hash,data) VALUES('a','a-main','rs91',$1,'REF00091',now()+interval '2 days','confirmed','{}',$2,'{\"partySize\":2}')", [customer, '9'.repeat(64)])
      const removed: string[] = []
      setRepiteAdapter({ ...core.notConfiguredRepite(), removeCard: async (p: { cardId: string }) => { removed.push(p.cardId); return { ok: true, value: {} } } } as unknown as core.RepiteAdapter)
      const blocked = await request('erase', customer)
      await env.drain()
      expect(await status(blocked)).toMatchObject({ status: 'blocked', error: expect.stringContaining('reserva') })
      expect((await sql('SELECT count(*)::int AS n FROM llenamos.repite_queue WHERE customer_id=$1', [customer])).rows[0].n).toBe(0)
      expect((await sql("SELECT status FROM llenamos.repite_cards WHERE customer_id=$1", [customer])).rows[0].status).toBe('active')
      expect(removed).toEqual([])
      // Solo cuando nada más bloquea se encola la retirada.
      await sql("UPDATE llenamos.reservations SET status='cancelled' WHERE id='rs91'")
      await request('erase', customer); await env.drain()
      expect(removed).toEqual(['card-91'])

      // `crearTarjetaRepite` con la `card.<id>` terminada y la tarjeta retirada: la reabre y emite una nueva (no responde `queued` sin hacer nada).
      const again = cid(92), created: string[] = []
      setRepiteAdapter({ ...core.notConfiguredRepite(), createCard: async (p: { externalRef: string }) => { created.push(p.externalRef); return { ok: true, value: { cardId: `card-nueva-${created.length}`, saveUrl: null } } } } as unknown as core.RepiteAdapter)
      await sql("UPDATE llenamos.repite_settings SET enabled=true,merchant_id='demo' WHERE restaurant_id='a'")
      await sql("INSERT INTO llenamos.customer_marketing(restaurant_id,customer_id,name) VALUES('a',$1,'Reabre')", [again])
      await sql("INSERT INTO llenamos.repite_cards(restaurant_id,customer_id,merchant_id,card_id,external_ref,status,created_at_ms) VALUES('a',$1,'demo','card-vieja','ref-vieja','removed',1)", [again])
      await sql("INSERT INTO llenamos.repite_queue(restaurant_id,id,kind,customer_id,merchant_id,occurred_at_ms,next_attempt_at_ms,status,external_ref,result) VALUES('a',$1,'create_card',$2,'demo',1,1,'done','ref-vieja','{\"saveUrl\":null}')", [`card.${again}`, again])
      expect((await env.ok('crearTarjetaRepite', 'owner-a', { restaurantId: 'a', requestId: req(), customerId: again })).status).toBe('queued')
      await env.drain()
      expect(created).toHaveLength(1)
      expect(created[0]).not.toBe('ref-vieja')
      expect((await sql("SELECT status,card_id FROM llenamos.repite_cards WHERE customer_id=$1", [again])).rows).toEqual([{ status: 'active', card_id: 'card-nueva-1' }])
      setRepiteAdapter(null)
    })

    it('reabrir la tarjeta no esconde la nueva de un borrado posterior, y una creación fallida conserva su referencia opaca', async () => {
      const removals: string[] = [], created: string[] = []
      setRepiteAdapter({ ...core.notConfiguredRepite(),
        createCard: async (p: { externalRef: string }) => { created.push(p.externalRef); return { ok: true, value: { cardId: `card-n${created.length}`, saveUrl: null } } },
        removeCard: async (p: { cardId: string }) => { removals.push(p.cardId); return { ok: true, value: {} } } } as unknown as core.RepiteAdapter)
      await sql("UPDATE llenamos.repite_settings SET enabled=true,merchant_id='demo' WHERE restaurant_id='a'")
      // I1: tarjeta C1 ya retirada (retirada `done`), la persona vuelve, recibe C2 y entonces pide el borrado: se retira C2.
      const back = cid(95)
      await sql("INSERT INTO llenamos.customer_marketing(restaurant_id,customer_id,name) VALUES('a',$1,'Vuelve antes')", [back])
      await sql("INSERT INTO llenamos.repite_cards(restaurant_id,customer_id,merchant_id,card_id,external_ref,status,created_at_ms) VALUES('a',$1,'demo','card-c1','ref-c1','removed',1)", [back])
      for (const [id, kind] of [[`card.${back}`, 'create_card'], [`remove.${back}`, 'remove_card']])
        await sql("INSERT INTO llenamos.repite_queue(restaurant_id,id,kind,customer_id,merchant_id,occurred_at_ms,next_attempt_at_ms,status,external_ref,result) VALUES('a',$1,$2,$3,'demo',1,1,'done','ref-c1','{}')", [id, kind, back])
      expect((await env.ok('crearTarjetaRepite', 'owner-a', { restaurantId: 'a', requestId: req(), customerId: back })).status).toBe('queued')
      await env.drain()
      expect((await sql("SELECT status,card_id FROM llenamos.repite_cards WHERE customer_id=$1", [back])).rows).toEqual([{ status: 'active', card_id: 'card-n1' }])
      expect((await sql("SELECT count(*)::int AS n FROM llenamos.repite_queue WHERE id=$1", [`remove.${back}`])).rows[0].n).toBe(0) // la retirada vieja se apartó
      let result = ''
      for (let i = 0; i < 4 && (await status(result || randomUUID()))?.status !== 'completed'; i++) { result = await request('erase', back); await env.drain() }
      expect(await status(result)).toMatchObject({ status: 'completed' })
      expect(removals).toEqual(['card-n1']) // Repite recibe la baja de la tarjeta NUEVA
      expect((await sql("SELECT count(*)::int AS n FROM llenamos.repite_pending_removals WHERE card_id='card-n1'")).rows[0].n).toBe(0)

      // I2: creación fallida (no llegó la respuesta): se reintenta con la MISMA referencia, para no dejar una tarjeta huérfana en Repite.
      const failed = cid(96)
      await sql("INSERT INTO llenamos.customer_marketing(restaurant_id,customer_id,name) VALUES('a',$1,'Fallida')", [failed])
      await sql("INSERT INTO llenamos.repite_queue(restaurant_id,id,kind,customer_id,merchant_id,occurred_at_ms,next_attempt_at_ms,status,external_ref) VALUES('a',$1,'create_card',$2,'demo',1,1,'failed','ref-guardada')", [`card.${failed}`, failed])
      expect((await env.ok('crearTarjetaRepite', 'owner-a', { restaurantId: 'a', requestId: req(), customerId: failed })).status).toBe('queued')
      await env.drain()
      expect(created.at(-1)).toBe('ref-guardada')
      setRepiteAdapter(null)
    })

    it('uncoveredTables sigue detectando una tabla conocida con filas de la persona cuando ningún módulo con adaptador la declara', async () => {
      const customer = cid(93)
      await sql("INSERT INTO llenamos.customer_marketing(restaurant_id,customer_id,name) VALUES('a',$1,'Sin cubrir')", [customer])
      await sql("INSERT INTO llenamos.loyalty_accounts(restaurant_id,customer_id,status,balance,earned,terms_version,enrolled_at,enrolled_by) VALUES('a',$1,'active',0,0,'1',1,'x')", [customer])
      const covering = { name: 'otro', operations: [], personalData: ['otra_tabla'], privacy: { exportData: async () => ({}), erase: async () => 0 } }
      expect(await env.member('a', 'owner-a', c => uncoveredTables(c, 'a', customer, [covering]))).toEqual(expect.arrayContaining(['customer_marketing', 'loyalty_accounts']))
      expect(await env.member('a', 'owner-a', c => uncoveredTables(c, 'a', customer, [covering, campanasModule, fidelizacion]))).toEqual([])
      expect(await env.member('a', 'owner-a', c => uncoveredTables(c, 'a', cid(94), [covering]))).toEqual([])
    })
  })

  describe('permisos de base de datos y de operación', () => {
    it('el libro de puntos no admite UPDATE ni DELETE desde la API, y la anonimización solo la hace el worker', async () => {
      expect(await env.member('a', 'owner-a', client => client.query('UPDATE llenamos.loyalty_movements SET reason=NULL').catch((e: { code: string }) => e.code))).toBe('42501')
      expect(await env.member('a', 'owner-a', client => client.query('DELETE FROM llenamos.loyalty_movements').catch((e: { code: string }) => e.code))).toBe('42501')
      expect((await rejects(env.member('a', 'owner-a', client => client.query("SELECT llenamos.loyalty_anonymize('a','x')")))).message).toContain('marketing_denied')
      expect((await rejects(env.member('a', 'owner-a', client => client.query("SELECT llenamos.marketing_erase_customer('a','x')")))).message).toContain('marketing_denied')
      expect((await rejects(env.member('a', 'owner-a', client => client.query("SELECT llenamos.marketing_prune('a',now(),10)")))).message).toContain('marketing_denied')
    })
    it('cancelar una campaña desde SQL exige ser propietario o encargado del restaurante', async () => {
      expect((await rejects(env.member('a', 'wai', client => client.query("SELECT llenamos.marketing_cancel_campaign('a','x')")))).message).toContain('marketing_denied')
      expect((await rejects(env.member('b', 'owner-b', client => client.query("SELECT llenamos.marketing_cancel_campaign('a','x')")))).message).toContain('marketing_denied')
      expect((await env.member('a', 'mgr', client => client.query("SELECT llenamos.marketing_cancel_campaign('a','x') AS n"))).rows[0].n).toBe(0)
    })
    it('marketing_erase_customer (solo worker): cancela lo pendiente, quita el nombre del outbox ya enviado y el hash del contacto', async () => {
      const customer = cid(11)
      await sql("INSERT INTO llenamos.marketing_campaigns(restaurant_id,id,name,segment_id,channel,content,status,updated_by,stat_queued) VALUES('a','camp11','x','s','email','{\"title\":\"x\",\"body\":\"y\",\"includeBookingLink\":false}','sending','x',2) ON CONFLICT DO NOTHING")
      const pending = randomUUID(), sent = randomUUID()
      for (const [id, status] of [[pending, 'pending'], [sent, 'done']] as const)
        await sql("INSERT INTO llenamos.outbox(id,restaurant_id,kind,payload,status) VALUES($1,'a','marketing.campaign_message',$2,$3)", [id, JSON.stringify({ campaignId: 'camp11', customerId: customer, purpose: 'marketing_email', data: { guestName: 'Marta' } }), status])
      await sql("INSERT INTO llenamos.marketing_campaign_recipients(restaurant_id,campaign_id,customer_id,status,message_id,contact_hash,at) VALUES('a','camp11',$1,'queued',$2,$3,now())", [customer, pending, 'c'.repeat(64)])
      expect((await rejects(env.member('a', 'owner-a', client => client.query('SELECT llenamos.marketing_erase_customer($1,$2)', ['a', customer])))).message).toContain('marketing_denied')
      await withTenant(env.db.worker, 'a', client => client.query('SELECT llenamos.marketing_erase_customer($1,$2)', ['a', customer]))
      expect((await sql("SELECT id,payload->'data'->>'guestName' AS name FROM llenamos.outbox WHERE payload->>'customerId'=$1", [customer])).rows).toEqual([{ id: sent, name: 'Cliente' }])
      expect((await sql('SELECT status,contact_hash FROM llenamos.marketing_campaign_recipients WHERE customer_id=$1', [customer])).rows).toEqual([{ status: 'cancelled', contact_hash: null }])
      // El worker de una transacción de otro restaurante no puede usarla sobre este.
      expect((await rejects(withTenant(env.db.worker, 'b', client => client.query('SELECT llenamos.marketing_erase_customer($1,$2)', ['a', customer])))).message).toContain('marketing_denied')
    })
    it('los destinatarios del resumen solo los consulta un propietario o encargado', async () => {
      const ask = (uid: string) => env.member('a', uid, client => client.query("SELECT uid FROM llenamos.analytics_recipients('a',ARRAY['owner-a','mgr'])").then(r => r.rows.map(x => x.uid).sort()))
      expect(await ask('wai')).toEqual([])
      expect(await ask('mgr')).toEqual(['mgr', 'owner-a'])
    })
    it('location_exists solo responde a miembros del restaurante', async () => {
      const exists = (rid: string, uid: string, target: string) => env.member(rid, uid, client => client.query('SELECT llenamos.location_exists($1,$2) AS ok', [target, 'a-main']).then(r => r.rows[0].ok))
      expect(await exists('a', 'owner-a', 'a')).toBe(true)
      expect(await exists('b', 'owner-b', 'a')).toBe(false)
    })
    it('custodia estrecha: con el rol propietario de las funciones, el restaurante de la transacción es lo único que se ve', async () => {
      // Filas de `a` y de `b` en cada tabla que antes tenía USING(true).
      for (const rid of ['a', 'b']) {
        await sql("INSERT INTO llenamos.marketing_campaigns(restaurant_id,id,name,segment_id,channel,content,status,updated_by) VALUES($1,'cust','x','s','email','{\"title\":\"x\",\"body\":\"y\",\"includeBookingLink\":false}','draft','x') ON CONFLICT DO NOTHING", [rid])
        await sql("INSERT INTO llenamos.marketing_campaign_recipients(restaurant_id,campaign_id,customer_id,status,at) VALUES($1,'cust',$2,'sent',now()) ON CONFLICT DO NOTHING", [rid, cid(40)])
        await sql("INSERT INTO llenamos.marketing_unsubscribe_tokens(restaurant_id,token_hash,customer_id,purpose,message_id,expires_at) VALUES($1,$2,$3,'marketing_email',$4,now()+interval '1 day') ON CONFLICT DO NOTHING", [rid, rid.repeat(64).slice(0, 64).replace(/[^a-f0-9]/g, 'a'), cid(40), randomUUID()])
        await sql("INSERT INTO llenamos.customer_marketing(restaurant_id,customer_id,name) VALUES($1,$2,'x') ON CONFLICT DO NOTHING", [rid, cid(40)])
        await sql("INSERT INTO llenamos.marketing_consents(restaurant_id,id,customer_id,purpose,status,policy_version,at,source,evidence_id) VALUES($1,'unsubscribe.cust',$2,'marketing_email','withdrawn','v',now(),'public','e') ON CONFLICT DO NOTHING", [rid, cid(40)])
        await sql("INSERT INTO llenamos.marketing_unsubscribe_limits(bucket,window_start,hits) VALUES($1,now(),1) ON CONFLICT DO NOTHING", [`slug:${rid}`])
      }
      await sql("INSERT INTO llenamos.marketing_unsubscribe_limits(bucket,window_start,hits) VALUES('unknown',now(),1),('ip:'||repeat('a',64),now(),1) ON CONFLICT DO NOTHING")
      const asOwner = async <T>(restaurant: string | null, fn: (c: import('pg').PoolClient) => Promise<T>): Promise<T> => {
        const client = await env.db.admin.connect()
        try {
          await client.query('BEGIN'); await client.query('SET LOCAL ROLE llenamos_migrator')
          if (restaurant) await client.query("SELECT set_config('app.restaurant_id',$1,true)", [restaurant])
          return await fn(client)
        } finally { await client.query('ROLLBACK'); client.release() }
      }
      const rows = (c: import('pg').PoolClient, table: string) => c.query(`SELECT restaurant_id,count(*)::int AS n FROM llenamos.${table} GROUP BY restaurant_id ORDER BY 1`).then(r => r.rows.map(x => x.restaurant_id as string))
      for (const table of ['marketing_campaigns', 'marketing_campaign_recipients', 'marketing_unsubscribe_tokens', 'customer_marketing']) {
        expect(await asOwner('a', c => rows(c, table)), `${table} en a`).toEqual(['a'])
        expect(await asOwner('b', c => rows(c, table)), `${table} en b`).toEqual(['b'])
        expect(await asOwner(null, c => rows(c, table)), `${table} sin restaurante`).toEqual([])
      }
      // Los permisos son un libro: solo lectura del restaurante de la transacción (para reasignar el id en un borrado), sin UPDATE ni DELETE de otro.
      expect(await asOwner('a', c => rows(c, 'marketing_consents'))).toEqual(['a'])
      expect(await asOwner(null, c => rows(c, 'marketing_consents'))).toEqual([])
      expect(await asOwner('a', c => c.query("UPDATE llenamos.marketing_consents SET status='granted' WHERE restaurant_id='b'").then(r => r.rowCount))).toBe(0)
      expect(await asOwner('a', c => c.query("DELETE FROM llenamos.marketing_consents").then(r => r.rowCount))).toBe(0)
      // Contadores: el de un slug solo el de su restaurante; los comunes (IP y slugs inexistentes) siempre.
      expect((await asOwner('a', c => c.query('SELECT bucket FROM llenamos.marketing_unsubscribe_limits ORDER BY 1').then(r => r.rows.map(x => x.bucket as string)))).filter(b => b.startsWith('slug:'))).toEqual(['slug:a'])
      expect((await asOwner(null, c => c.query('SELECT bucket FROM llenamos.marketing_unsubscribe_limits ORDER BY 1').then(r => r.rows.map(x => x.bucket as string)))).some(b => b.startsWith('slug:'))).toBe(false)
      // Las políticas de reasignación (`rekey_*`) solo valen mientras `marketing_rekey` corre: fuera de ella el propietario no ve la cola de Repite aunque haya restaurante.
      expect(await asOwner('a', c => rows(c, 'repite_queue'))).toEqual([])
      expect(await asOwner('a', c => rows(c, 'message_deliveries'))).toEqual([])
      // Y la API, sin ser propietaria, no ve los contadores ni los tokens de otro restaurante.
      expect(await env.member('a', 'owner-a', c => c.query("SELECT count(*)::int AS n FROM llenamos.marketing_unsubscribe_tokens WHERE restaurant_id='b'").then(r => r.rows[0].n))).toBe(0)
    })
    it('los espejos de 016 funcionan sea cual sea el contexto de quien escribe (alta pública de sala, reserva pública, importación sin contexto) y no lo dejan cambiado', async () => {
      const inTx = async <T>(setup: string[], fn: (c: import('pg').PoolClient) => Promise<T>) => {
        const client = await env.db.admin.connect()
        try { await client.query('BEGIN'); for (const q of setup) await client.query(q); return await fn(client) } finally { await client.query('ROLLBACK'); client.release() }
      }
      const data = (name: string) => JSON.stringify({ name, phone: '+34600999111', email: null, language: 'es', visits: 0, noShows: 0, cancellations: 0, lastVisitAt: null })
      // 1. Alta pública de sala: solo `app.sala_public`, sin identidad ni `app.restaurant_id` (pedirParaLlevar devolvía 500).
      await inTx(['SET LOCAL ROLE llenamos_app', "SELECT set_config('app.sala_public','a',true)", "SELECT set_config('app.sala_public_location','a-main',true)"], async c => {
        await c.query("INSERT INTO llenamos.customers(restaurant_id,id,data) VALUES('a',$1,$2)", [cid(95), data('Sala pública')])
        await c.query("SELECT set_config('app.restaurant_id','',true)")
        expect((await c.query("SELECT current_setting('app.restaurant_id',true) AS v")).rows[0].v).toBe('')
        await c.query('RESET ROLE')
        expect((await c.query('SELECT name FROM llenamos.customer_marketing WHERE customer_id=$1', [cid(95)])).rows).toEqual([{ name: 'Sala pública' }])
      })
      // 2. Reserva pública (`app.public_restaurant`) con permiso: el espejo de `consents` escribe sin contexto de miembro.
      await inTx(['SET LOCAL ROLE llenamos_app', "SELECT set_config('app.public_restaurant','a',true)"], async c => {
        await c.query("INSERT INTO llenamos.customers(restaurant_id,id,data) VALUES('a',$1,$2)", [cid(96), data('Reserva pública')])
        await c.query("INSERT INTO llenamos.consents(restaurant_id,id,data) VALUES('a','reservation.pub96.email',$1)", [JSON.stringify({ customerId: cid(96), purpose: 'marketing_email', status: 'granted', policyVersion: 'v1', at: Date.now(), source: 'public', evidenceId: 'pub96' })])
        await c.query('RESET ROLE')
        expect((await c.query("SELECT status FROM llenamos.marketing_consents WHERE id='reservation.pub96.email'")).rows).toEqual([{ status: 'granted' }])
      })
      // 3. Importación o script sin ningún contexto (como administrador de la base): el INSERT en `consents` ya no aborta y el contexto de antes se conserva.
      await inTx(["SELECT set_config('app.restaurant_id','b',true)"], async c => {
        await c.query("INSERT INTO llenamos.consents(restaurant_id,id,data) VALUES('a','reservation.imp97.email',$1)", [JSON.stringify({ customerId: cid(97), purpose: 'marketing_email', status: 'granted', policyVersion: 'v1', at: Date.now(), source: 'import', evidenceId: 'imp97' })])
        expect((await c.query("SELECT current_setting('app.restaurant_id',true) AS v")).rows[0].v).toBe('b')
        expect((await c.query("SELECT restaurant_id FROM llenamos.marketing_consents WHERE id='reservation.imp97.email'")).rows).toEqual([{ restaurant_id: 'a' }])
      })
      // 4. Una ficha que reservas ya marcó como suprimida entra vacía y suprimida.
      await env.member('a', 'owner-a', c => c.query("INSERT INTO llenamos.customers(restaurant_id,id,data) VALUES('a',$1,$2)", [cid(98), JSON.stringify({ name: 'Suprimida', phone: '+34600999222', email: 'x@example.test', language: 'es', privacyRedacted: true })]))
      expect((await sql('SELECT name,phone,email,redacted FROM llenamos.customer_marketing WHERE customer_id=$1', [cid(98)])).rows).toEqual([{ name: '', phone: null, email: null, redacted: true }])
    })

    it('roles sin permiso y otro restaurante reciben 403; la lectura de otro restaurante no devuelve datos', async () => {
      const settings = { enabled: true, pointsPerEuro: 1, minSpendCents: 0, expiryDays: 365, termsVersion: '1' }
      expect((await env.call('guardarConfiguracionFidelizacion', 'wai', { restaurantId: 'a', requestId: req(), settings })).status).toBe(403)
      expect((await env.call('guardarConfiguracionFidelizacion', 'owner-b', { restaurantId: 'a', requestId: req(), settings })).status).toBe(403)
      expect((await env.call('ajustarPuntos', 'wai', { restaurantId: 'a', requestId: req(), customerId: cid(2), points: 5, reason: 'x' })).status).toBe(403)
      expect((await env.call('guardarSegmento', 'wai', { restaurantId: 'a', requestId: req(), segmentId: null, expectedRevision: null, segment: { name: 'x', rule: { minVisits: null, maxVisits: null, lastVisitAtLeastDaysAgo: null, lastVisitAtMostDaysAgo: null, includeNeverVisited: true, maxNoShows: null, minSpentCents: null, tagsAny: [], tagsNone: [], languages: [], minPoints: null } } })).status).toBe(403)
      const mine = await env.ok('verCuentaFidelizacion', 'owner-a', { restaurantId: 'a', customerId: cid(2) })
      expect(mine.enrolled).toBe(true)
      // El cliente de `b` no existe para `a`.
      expect((await env.ok('verCuentaFidelizacion', 'owner-a', { restaurantId: 'a', customerId: cid(5) })).enrolled).toBe(false)
      expect((await env.ok('verCuentaFidelizacion', 'owner-b', { restaurantId: 'b', customerId: cid(2) })).enrolled).toBe(false)
    })
  })

  describe('fidelización: tandas, promociones por local, cola de Repite y repite_link', () => {
    it('más de 500 tandas vivas se compactan en vez de abortar, sin perder puntos y con la caducidad esperada de cada grupo', async () => {
      const customer = cid(7), DAY = 86_400_000, WEEK = 7 * DAY
      await sql("INSERT INTO llenamos.loyalty_accounts(restaurant_id,customer_id,status,balance,earned,terms_version,enrolled_at,enrolled_by) VALUES('a',$1,'active',600,600,'1',1,'x')", [customer])
      // Una tanda por día de caducidad exacto: 600 ventanas de día (más de las 500 permitidas), así que se pasa a ventanas de semana.
      const base = Math.floor((Date.now() + 30 * DAY) / DAY) * DAY
      await sql(`INSERT INTO llenamos.loyalty_lots(restaurant_id,movement_id,customer_id,at_ms,expires_at_ms,initial,remaining)
        SELECT 'a','lot'||g,$1,1000+g,$2::bigint+g::bigint*86400000,1,1 FROM generate_series(1,600) g`, [customer, base])
      await sql("INSERT INTO llenamos.loyalty_movements(restaurant_id,id,customer_id,kind,points,balance_after,at_ms) VALUES('a','seed7',$1,'adjust',600,600,1)", [customer])
      const expected = new Map<number, { points: number; latest: number }>()
      for (let g = 1; g <= 600; g++) {
        const expires = base + g * DAY, key = Math.floor(expires / WEEK), got = expected.get(key) ?? { points: 0, latest: 0 }
        expected.set(key, { points: got.points + 1, latest: Math.max(got.latest, expires) })
      }
      expect(await env.member('a', 'owner-a', client => compactLots(client, 'a', customer))).toBe(expected.size)
      const live = (await sql('SELECT expires_at_ms::text AS e,remaining FROM llenamos.loyalty_lots WHERE customer_id=$1 AND remaining>0 ORDER BY expires_at_ms', [customer])).rows.map(r => [Number(r.e), r.remaining])
      expect(live).toEqual([...expected.values()].sort((x, y) => x.latest - y.latest).map(g => [g.latest, g.points]))
      // Con 600 tandas sin compactar, operar ya no falla con 412.
      await sql("UPDATE llenamos.loyalty_lots SET remaining=1,initial=1 WHERE customer_id=$1 AND movement_id IN (SELECT 'x'||g FROM generate_series(1,1) g)", [customer])
      const out = await env.ok('ajustarPuntos', 'owner-a', { restaurantId: 'a', requestId: req(), customerId: customer, points: 1, reason: 'Un punto más' })
      expect(out.available).toBe(601)
    })

    it('un encargado con locales limitados no ve ni toca promociones de todo el restaurante ni de otros locales', async () => {
      const input = (locationIds: string[], name = 'Promo') => ({ name, description: '', discount: { kind: 'percent', bp: 500 }, scope: { kind: 'bill' }, locationIds, channels: ['dine_in'], validFrom: null, validTo: null,
        weekdays: [], timeWindows: [], minSpendCents: 0, maxDiscountCents: null, usageLimit: null, perCustomerLimit: null, code: null, stacking: 'with_loyalty', priority: 0 })
      const save = (uid: string, locationIds: string[], extra: Record<string, unknown> = {}) => env.call('guardarPromocion', uid, { restaurantId: 'a', requestId: req(), promotionId: null, expectedRevision: null, promotion: input(locationIds), ...extra })
      const global = (await save('owner-a', [])).body.result, terraza = (await save('owner-a', ['a-terraza'])).body.result, main = (await save('lim', ['a-main'])).body.result
      expect((await save('lim', [])).status).toBe(412)
      expect((await save('lim', ['a-terraza'])).status).toBe(403)
      // Cambiar el estado de la global, o editar la de otro local, también está fuera de su alcance.
      expect((await env.call('cambiarEstadoPromocion', 'lim', { restaurantId: 'a', requestId: req(), promotionId: global.promotionId, expectedRevision: global.revision, to: 'active' })).status).toBe(403)
      expect((await env.call('cambiarEstadoPromocion', 'lim', { restaurantId: 'a', requestId: req(), promotionId: terraza.promotionId, expectedRevision: terraza.revision, to: 'active' })).status).toBe(403)
      expect((await save('lim', ['a-main'], { promotionId: global.promotionId, expectedRevision: global.revision })).status).toBe(403)
      expect((await env.call('cambiarEstadoPromocion', 'lim', { restaurantId: 'a', requestId: req(), promotionId: main.promotionId, expectedRevision: main.revision, to: 'active' })).status).toBe(200)
      // La lectura en vivo filtra por su alcance; el propietario lo ve todo.
      const query = loyaltyLive.find(q => q.name === 'fidelizacion.promociones')!
      const seen = async (uid: string) => (await env.member('a', uid, client => query.snapshot(client, { restaurantId: 'a' }, { uid })) as { id: string }[]).map(p => p.id).sort()
      expect(await seen('lim')).toEqual([main.promotionId])
      expect(await seen('owner-a')).toEqual([global.promotionId, terraza.promotionId, main.promotionId].sort())
    })

    it('la cola de Repite no se atasca: lo que ya no se puede hacer se cierra y las demás operaciones avanzan', async () => {
      await sql("UPDATE llenamos.repite_settings SET merchant_id='nuevo',enabled=true,auto_create_card=false WHERE restaurant_id='a'")
      await sql("DELETE FROM llenamos.repite_queue WHERE restaurant_id='a'")
      // 25 operaciones de un comercio anterior (más que las 20 de una pasada) y una válida detrás.
      await sql(`INSERT INTO llenamos.repite_queue(restaurant_id,id,kind,customer_id,merchant_id,visit_key,trigger,occurred_at_ms,next_attempt_at_ms)
        SELECT 'a','stamp.old'||g,'add_stamp',$1,'viejo','old'||g,'paid',1,g FROM generate_series(1,25) g`, [cid(2)])
      await sql("INSERT INTO llenamos.repite_queue(restaurant_id,id,kind,customer_id,merchant_id,visit_key,trigger,occurred_at_ms,next_attempt_at_ms) VALUES('a','stamp.nuevo','add_stamp',$1,'nuevo','nuevo','paid',1,100)", [cid(2)])
      await sql("INSERT INTO llenamos.repite_cards(restaurant_id,customer_id,merchant_id,card_id,external_ref,status,created_at_ms) VALUES('a',$1,'nuevo','card-2','ref-2','active',1)", [cid(2)])
      await env.member('a', 'owner-a', client => enqueueJob(client, { id: randomUUID(), restaurantId: 'a', kind: 'fidelizacion.procesar_repite', deduplicationKey: 'cola-1', payload: { restaurantId: 'a' } }))
      await env.drain(); await env.drain()
      const states = (await sql("SELECT status,count(*)::int AS n FROM llenamos.repite_queue WHERE restaurant_id='a' GROUP BY status ORDER BY status")).rows
      expect(states).toEqual([{ status: 'not_configured', n: 1 }, { status: 'skipped', n: 25 }])
      // Con Repite apagado, lo que llega después tampoco se queda en cola para siempre.
      await sql("UPDATE llenamos.repite_settings SET enabled=false WHERE restaurant_id='a'")
      await sql("INSERT INTO llenamos.repite_queue(restaurant_id,id,kind,customer_id,merchant_id,visit_key,trigger,occurred_at_ms,next_attempt_at_ms) VALUES('a','stamp.apagado','add_stamp',$1,'nuevo','apagado','paid',1,1)", [cid(2)])
      await env.member('a', 'owner-a', client => enqueueJob(client, { id: randomUUID(), restaurantId: 'a', kind: 'fidelizacion.procesar_repite', deduplicationKey: 'cola-2', payload: { restaurantId: 'a' } }))
      await env.drain()
      expect((await sql("SELECT status FROM llenamos.repite_queue WHERE id='stamp.apagado'")).rows[0].status).toBe('not_configured')
    })

    it('darSelloRepite solo sella visitas que son de ese cliente (reserva o mesa del local)', async () => {
      await sql("UPDATE llenamos.repite_settings SET enabled=true,merchant_id='comercio-sello' WHERE restaurant_id='a'")
      await env.member('a', 'owner-a', async client => {
        await client.query("INSERT INTO llenamos.customers(restaurant_id,id,data) VALUES('a',$1,$2) ON CONFLICT DO NOTHING", [cid(12), JSON.stringify({ name: 'Eva', phone: '+34600000012', email: null, language: 'es', visits: 0, noShows: 0, cancellations: 0, lastVisitAt: null })])
        await client.query("INSERT INTO llenamos.reservations(restaurant_id,location_id,id,customer_id,reference,start_at,status,table_ids,manage_token_hash,data) VALUES('a','a-main','rs12',$1,'REF00012',now(),'seated','{}',$2,'{\"partySize\":2}')", [cid(12), 'e'.repeat(64)])
      })
      const stamp = (uid: string, customerId: string, reservationId: string | null, sessionId: string | null = null, locationId = 'a-main') =>
        env.call('darSelloRepite', uid, { restaurantId: 'a', locationId, requestId: req(), customerId, reservationId, sessionId })
      expect((await stamp('owner-a', cid(2), 'rs12')).status).toBe(412) // la reserva es de otra persona
      expect((await stamp('owner-a', cid(12), 'no-existe')).status).toBe(404)
      expect((await stamp('lim', cid(12), 'rs12', null, 'a-terraza')).status).toBe(403) // local fuera de su alcance
      expect((await stamp('owner-a', cid(12), 'rs12', null, 'a-terraza')).status).toBe(404) // la reserva no es de ese local
      const done = await env.ok('darSelloRepite', 'wai', { restaurantId: 'a', locationId: 'a-main', requestId: req(), customerId: cid(12), reservationId: 'rs12', sessionId: null })
      expect(done.status).toBe('queued')
      expect((await sql("SELECT visit_key FROM llenamos.repite_queue WHERE id=$1", [done.operationId])).rows).toHaveLength(1)
    })

    it('Repite: los sellos cerrados como sin configurar mientras estuvo apagado se reabren al encenderlo', async () => {
      await sql("DELETE FROM llenamos.repite_queue WHERE restaurant_id='a'; DELETE FROM llenamos.jobs WHERE kind='fidelizacion.procesar_repite'")
      await sql("UPDATE llenamos.repite_settings SET enabled=false,merchant_id='encender' WHERE restaurant_id='a'")
      await sql("INSERT INTO llenamos.repite_queue(restaurant_id,id,kind,customer_id,merchant_id,visit_key,trigger,occurred_at_ms,next_attempt_at_ms,status) VALUES('a','stamp.apagado2','add_stamp',$1,'encender','a2','paid',$2,1,'not_configured'),('a','stamp.antiguo','add_stamp',$1,'encender','a3','paid',1,1,'not_configured')", [cid(2), Date.now() - 3_600_000])
      await env.ok('guardarAjustesRepite', 'owner-a', { restaurantId: 'a', requestId: req(), settings: { enabled: true, stampOn: 'paid', autoCreateCard: false } })
      expect((await sql("SELECT status,attempts FROM llenamos.repite_queue WHERE id='stamp.apagado2'")).rows[0]).toEqual({ status: 'queued', attempts: 0 })
      expect((await sql("SELECT status FROM llenamos.repite_queue WHERE id='stamp.antiguo'")).rows[0].status).toBe('not_configured') // de hace más de 7 días: no se reabre
      expect((await sql("SELECT count(*)::int AS n FROM llenamos.jobs WHERE restaurant_id='a' AND kind='fidelizacion.procesar_repite'")).rows[0].n).toBe(1)
    })

    it('la poda no borra el enlace de baja sin usar de quien sigue siendo cliente, pero sí el de quien ya no existe', async () => {
      await sql("DELETE FROM llenamos.marketing_unsubscribe_tokens WHERE restaurant_id='a'")
      await sql("INSERT INTO llenamos.customer_marketing(restaurant_id,customer_id,name) VALUES('a',$1,'Vive') ON CONFLICT DO NOTHING", [cid(60)])
      for (const [hash, customer] of [['1', cid(60)], ['2', cid(61)]])
        await sql("INSERT INTO llenamos.marketing_unsubscribe_tokens(restaurant_id,token_hash,customer_id,purpose,message_id,expires_at) VALUES('a',$1,$2,'marketing_email',$3,now()-interval '1 day')", [hash!.repeat(64), customer, randomUUID()])
      await sql("INSERT INTO llenamos.marketing_unsubscribe_tokens(restaurant_id,token_hash,customer_id,purpose,message_id,expires_at,used_at) VALUES('a',$1,$2,'marketing_email',$3,now()+interval '1 day',now()-interval '100 days')", ['3'.repeat(64), cid(60), randomUUID()])
      expect((await withTenant(env.db.worker, 'a', client => client.query('SELECT llenamos.marketing_prune($1,now(),100) AS n', ['a']))).rows[0].n).toBe(2)
      expect((await sql("SELECT token_hash FROM llenamos.marketing_unsubscribe_tokens WHERE restaurant_id='a'")).rows).toEqual([{ token_hash: '1'.repeat(64) }])
    })

    it('relleno de 016: las fichas y permisos que ya existían entran (y repetirlo no duplica); el gasto de la ficha se copia y no se pisa', async () => {
      const { readFileSync } = await import('node:fs')
      const migration = readFileSync(new URL('../../../migrations/016_clientes_revision.sql', import.meta.url), 'utf8')
      const backfill = migration.slice(migration.indexOf('-- BACKFILL-INICIO'), migration.indexOf('-- BACKFILL-FIN'))
      expect(backfill).toContain('ON CONFLICT')
      // Fichas anteriores a la migración: se escriben sin disparadores, como si ya estuvieran en la base.
      await sql('ALTER TABLE llenamos.customers DISABLE TRIGGER clientes_espejo; ALTER TABLE llenamos.consents DISABLE TRIGGER permisos_espejo')
      const old = cid(70)
      try {
        await sql("INSERT INTO llenamos.customers(restaurant_id,id,data) VALUES('a',$1,$2)", [old, JSON.stringify({ name: 'Previa', phone: '+34600700070', email: 'previa@example.test', language: 'ca', visits: 3, noShows: 1, lastVisitAt: Date.now() - 86_400_000, spentCents: 4500, tags: ['vip'] })])
        await sql("INSERT INTO llenamos.consents(restaurant_id,id,data) VALUES('a','reservation.vieja.email',$1)", [JSON.stringify({ customerId: old, purpose: 'marketing_email', status: 'granted', policyVersion: 'v0', at: Date.now() - 5 * 86_400_000, source: 'public', evidenceId: 'vieja' })])
      } finally { await sql('ALTER TABLE llenamos.customers ENABLE TRIGGER clientes_espejo; ALTER TABLE llenamos.consents ENABLE TRIGGER permisos_espejo') }
      expect((await sql('SELECT 1 FROM llenamos.customer_marketing WHERE customer_id=$1', [old])).rowCount).toBe(0)
      await sql(backfill); await sql(backfill)
      expect((await sql('SELECT name,language,visits,no_shows,spent_cents,tags,redacted FROM llenamos.customer_marketing WHERE customer_id=$1', [old])).rows).toEqual([{ name: 'Previa', language: 'ca', visits: 3, no_shows: 1, spent_cents: '4500', tags: ['vip'], redacted: false }])
      expect((await sql("SELECT status,policy_version FROM llenamos.marketing_consents WHERE id='reservation.vieja.email'")).rows).toEqual([{ status: 'granted', policy_version: 'v0' }])
      // Audiencia > 0 y la ficha existe para dar de alta en puntos.
      const preview = await env.ok('previsualizarSegmento', 'owner-a', { restaurantId: 'a', channel: 'email', rule: { minVisits: 3, maxVisits: null, lastVisitAtLeastDaysAgo: null, lastVisitAtMostDaysAgo: null, includeNeverVisited: false, maxNoShows: null, minSpentCents: 4000, tagsAny: [], tagsNone: [], languages: [], minPoints: null } })
      expect(preview.recipients).toBeGreaterThan(0)
      expect(preview.sample.map((x: { customerId: string }) => x.customerId)).toContain(old)
      await env.ok('guardarConfiguracionFidelizacion', 'owner-a', { restaurantId: 'a', requestId: req(), settings: { enabled: true, pointsPerEuro: 1, minSpendCents: 0, expiryDays: 365, termsVersion: '1' } })
      expect((await env.ok('altaFidelizacion', 'owner-a', { restaurantId: 'a', requestId: req(), customerId: old, acceptedTermsVersion: '1' })).alreadyEnrolled).toBe(false)
      // El gasto lo pone V11 en la ficha de reservas: una actualización sin ese campo no lo pone a 0, y una que lo trae lo copia.
      await env.member('a', 'owner-a', client => client.query("UPDATE llenamos.customers SET data=data-'spentCents' WHERE restaurant_id='a' AND id=$1", [old]))
      expect((await sql('SELECT spent_cents FROM llenamos.customer_marketing WHERE customer_id=$1', [old])).rows[0].spent_cents).toBe('4500')
      await env.member('a', 'owner-a', client => client.query("UPDATE llenamos.customers SET data=jsonb_set(data,'{spentCents}','9000') WHERE restaurant_id='a' AND id=$1", [old]))
      expect((await sql('SELECT spent_cents FROM llenamos.customer_marketing WHERE customer_id=$1', [old])).rows[0].spent_cents).toBe('9000')
    })

    it('repite_link: solo plataforma, con auditoría, idempotente y sin cambiar de comercio con tarjetas activas', async () => {
      await sql("INSERT INTO llenamos.platform_restaurants(restaurant_id,name,slug,plan_id,plan_version,owner_email,status,active_modules) VALUES('a','a','a','sala',1,'a@example.test','active',$1)", [['reservations']])
      const link = (uid: string, merchantId: string | null, requestId = req()) => env.call('vincularRepite', uid, { restaurantId: 'a', requestId, merchantId, reason: 'Alta del comercio' })
      expect((await link('owner-a', 'otro')).status).toBe(403)
      await sql("DELETE FROM llenamos.repite_cards WHERE restaurant_id='a'")
      const key = req()
      const first = await link('plat', 'comercio-1', key)
      expect(first.status, JSON.stringify(first.body)).toBe(200)
      expect((await link('plat', 'comercio-1', key)).status).toBe(200)
      expect((await link('plat', 'comercio-2', key)).status).toBe(409)
      expect((await sql("SELECT merchant_id FROM llenamos.repite_settings WHERE restaurant_id='a'")).rows[0].merchant_id).toBe('comercio-1')
      expect((await sql("SELECT count(*)::int AS n FROM llenamos.platform_audit WHERE restaurant_id='a' AND action='repite.linked'")).rows[0].n).toBe(1)
      await sql("INSERT INTO llenamos.repite_cards(restaurant_id,customer_id,merchant_id,card_id,external_ref,status,created_at_ms) VALUES('a',$1,'comercio-1','c','r','active',1)", [cid(9)])
      expect((await link('plat', 'comercio-3')).status).toBe(412)
      // Un restaurante ve el comercio pero no puede cambiarlo con guardarAjustesRepite.
      await env.ok('guardarAjustesRepite', 'owner-a', { restaurantId: 'a', requestId: req(), settings: { enabled: true, stampOn: 'paid', autoCreateCard: false } })
      expect((await sql("SELECT merchant_id FROM llenamos.repite_settings WHERE restaurant_id='a'")).rows[0].merchant_id).toBe('comercio-1')
    })
  })
})
