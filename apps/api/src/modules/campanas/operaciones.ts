import { createHash } from 'node:crypto'
import {
  CAMPAIGN_EXCLUSIONS, FASE5_MARKETING_ACCESS, CALLABLE_SCHEMAS_FASE5_MARKETING as S, canCampaignTransition, nextSendTime, type CampaignExclusion,
} from '@llenamos/core'
import { enqueueJob } from './trabajos.js'
import { failed, memberOperation, missing, visibleLocations, assertLocation } from '../comun/acceso.js'
import { loadMarketingSettings, summarizeAudience, assertAudienceWithinCap, type PageContext } from './audiencia.js'
import { CAMPAIGN_COLUMNS, campaignView, emitCampaign, expectRevision, loadSegment, newId, previewMessage, restaurantAndSettings, scopedCampaign, type CampaignRow } from './campanas.js'
import { JOB_KIND_PROCESS } from './config.js'
import { originReportRows } from './origen.js'
import { emitEvent } from '../../events.js'

const access = (name: keyof typeof FASE5_MARKETING_ACCESS) => {
  const a = FASE5_MARKETING_ACCESS[name]
  if (a.permission === 'public' || a.permission === 'logiqd') throw new Error(`${name} no es una operación de miembro`)
  return { permission: a.permission, modules: a.modules }
}
const uuidFrom = (value: string) => { const h = createHash('sha256').update(value).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}` }
export const jobId = (rid: string, campaignId: string) => uuidFrom(`job:${JOB_KIND_PROCESS}:${rid}:${campaignId}`)

function exclusionCounts(counts: Record<CampaignExclusion, number>) {
  return Object.fromEntries(CAMPAIGN_EXCLUSIONS.map(k => [k, counts[k]])) as Record<CampaignExclusion, number>
}

export const guardarConfiguracionMarketing = memberOperation('guardarConfiguracionMarketing', {
  ...access('guardarConfiguracionMarketing'), ...S.guardarConfiguracionMarketing,
  run: async (client, d, scope) => {
    await client.query(`INSERT INTO llenamos.marketing_settings(restaurant_id,settings,updated_by) VALUES($1,$2,$3)
      ON CONFLICT(restaurant_id) DO UPDATE SET settings=EXCLUDED.settings,updated_by=EXCLUDED.updated_by,updated_at=now()`, [d.restaurantId, d.settings, scope.uid])
    await emitEvent(client, { restaurantId: d.restaurantId, topic: 'campanas.ajustes' })
    return { ok: true as const }
  },
})

export const guardarSegmento = memberOperation('guardarSegmento', {
  ...access('guardarSegmento'), ...S.guardarSegmento,
  run: async (client, d, scope) => {
    let id: string, revision: number
    if (d.segmentId) {
      const old = await loadSegment(client, d.restaurantId, d.segmentId, true)
      expectRevision(old.revision, d.expectedRevision)
      id = old.id; revision = old.revision + 1
      await client.query('UPDATE llenamos.marketing_segments SET name=$3,rule=$4,revision=$5,updated_by=$6,updated_at=now() WHERE restaurant_id=$1 AND id=$2',
        [d.restaurantId, id, d.segment.name, d.segment.rule, revision, scope.uid])
    } else {
      if (d.expectedRevision !== null) throw failed('El segmento no existe.')
      id = newId(); revision = 1
      await client.query('INSERT INTO llenamos.marketing_segments(restaurant_id,id,name,rule,revision,updated_by) VALUES($1,$2,$3,$4,1,$5)', [d.restaurantId, id, d.segment.name, d.segment.rule, scope.uid])
    }
    await emitEvent(client, { restaurantId: d.restaurantId, topic: 'campanas.segmento', entityId: id })
    return { segmentId: id, revision }
  },
})

export const borrarSegmento = memberOperation('borrarSegmento', {
  ...access('borrarSegmento'), ...S.borrarSegmento,
  run: async (client, d) => {
    const old = await loadSegment(client, d.restaurantId, d.segmentId, true)
    expectRevision(old.revision, d.expectedRevision)
    const used = await client.query("SELECT 1 FROM llenamos.marketing_campaigns WHERE restaurant_id=$1 AND segment_id=$2 AND status IN ('draft','scheduled','sending') LIMIT 1", [d.restaurantId, d.segmentId])
    if (used.rowCount) throw failed('Hay una campaña que usa este segmento.')
    await client.query('DELETE FROM llenamos.marketing_segments WHERE restaurant_id=$1 AND id=$2', [d.restaurantId, d.segmentId])
    await emitEvent(client, { restaurantId: d.restaurantId, topic: 'campanas.segmento', entityId: d.segmentId })
    return { ok: true as const }
  },
})

export const previsualizarSegmento = memberOperation('previsualizarSegmento', {
  ...access('previsualizarSegmento'), ...S.previsualizarSegmento,
  run: async (client, d, scope) => {
    const { settings } = await restaurantAndSettings(client, d.restaurantId)
    const ctx: PageContext = { rid: d.restaurantId, rule: d.rule, channel: d.channel, settings, now: Date.now(), ignoreCampaign: null }
    const { counts, sample } = await summarizeAudience(client, ctx)
    // Los clientes no pertenecen a un local: quien tiene locales limitados ve las cifras pero no los nombres de la muestra.
    return { audience: counts.audience, recipients: counts.recipients, excluded: exclusionCounts(counts), sample: scope.locationIds.length ? [] : sample }
  },
})

export const guardarCampana = memberOperation('guardarCampana', {
  ...access('guardarCampana'), ...S.guardarCampana,
  run: async (client, d, scope) => {
    const rid = d.restaurantId
    let old: CampaignRow | null = null
    if (d.campaignId) {
      old = await scopedCampaign(client, rid, scope, d.campaignId, true)
      expectRevision(old.revision, d.expectedRevision)
      if (old.status !== 'draft') throw failed('Solo se edita una campaña en borrador.')
    } else if (d.expectedRevision !== null) throw failed('La campaña no existe.')
    await loadSegment(client, rid, d.campaign.segmentId)
    if (d.campaign.locationId) await assertLocation(client, rid, scope, d.campaign.locationId)
    else if (scope.locationIds.length) throw failed('Elige un local al que tengas acceso.')
    const c = d.campaign
    let id: string, revision: number
    if (old) {
      id = old.id; revision = old.revision + 1
      await client.query(`UPDATE llenamos.marketing_campaigns SET name=$3,segment_id=$4,channel=$5,content=$6,location_id=$7,revision=$8,updated_by=$9,updated_at=now() WHERE restaurant_id=$1 AND id=$2`,
        [rid, id, c.name, c.segmentId, c.channel, c.content, c.locationId, revision, scope.uid])
    } else {
      id = newId(); revision = 1
      await client.query(`INSERT INTO llenamos.marketing_campaigns(restaurant_id,id,name,segment_id,channel,content,location_id,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [rid, id, c.name, c.segmentId, c.channel, c.content, c.locationId, scope.uid])
    }
    await emitCampaign(client, rid, id, c.locationId, 'draft')
    return { campaignId: id, revision }
  },
})

export const simularCampana = memberOperation('simularCampana', {
  ...access('simularCampana'), ...S.simularCampana,
  run: async (client, d, scope) => {
    const rid = d.restaurantId, now = Date.now()
    const campaign = await scopedCampaign(client, rid, scope, d.campaignId)
    const rule = campaign.rule_snapshot ?? (await loadSegment(client, rid, campaign.segment_id)).rule
    const { restaurant, settings } = await restaurantAndSettings(client, rid)
    const { counts } = await summarizeAudience(client, { rid, rule, channel: campaign.channel, settings, now, ignoreCampaign: d.campaignId })
    return {
      audience: counts.audience, recipients: counts.recipients, excluded: exclusionCounts(counts),
      preview: previewMessage(restaurant, d.campaignId, { channel: campaign.channel, content: campaign.content }),
      firstSendAt: nextSendTime(now, restaurant.timezone, settings.sendWindow),
    }
  },
})

export const lanzarCampana = memberOperation('lanzarCampana', {
  ...access('lanzarCampana'), ...S.lanzarCampana,
  run: async (client, d, scope) => {
    const rid = d.restaurantId, now = Date.now()
    const campaign = await scopedCampaign(client, rid, scope, d.campaignId, true)
    expectRevision(campaign.revision, d.expectedRevision)
    if (campaign.status !== 'draft') throw failed('La campaña ya se lanzó o está cancelada.')
    const segment = await loadSegment(client, rid, campaign.segment_id)
    await assertAudienceWithinCap(client, rid, segment.rule, now)
    const { restaurant, settings } = await restaurantAndSettings(client, rid)
    const at = nextSendTime(Math.max(now, d.at ?? now), restaurant.timezone, settings.sendWindow)
    const revision = campaign.revision + 1
    await client.query(`UPDATE llenamos.marketing_campaigns SET status='scheduled',scheduled_at=to_timestamp($3::bigint/1000.0),launched_by=$4,rule_snapshot=$5,revision=$6,updated_by=$4,updated_at=now() WHERE restaurant_id=$1 AND id=$2`,
      [rid, d.campaignId, at, scope.uid, segment.rule, revision])
    await enqueueJob(client, { id: jobId(rid, d.campaignId), restaurantId: rid, kind: JOB_KIND_PROCESS, deduplicationKey: d.campaignId, payload: { campaignId: d.campaignId }, scheduledAt: new Date(at) })
    await emitCampaign(client, rid, d.campaignId, campaign.location_id, 'scheduled')
    return { revision, status: 'scheduled' as const, scheduledAt: at }
  },
})

export const cancelarCampana = memberOperation('cancelarCampana', {
  ...access('cancelarCampana'), ...S.cancelarCampana,
  run: async (client, d, scope) => {
    const rid = d.restaurantId
    const campaign = await scopedCampaign(client, rid, scope, d.campaignId, true)
    expectRevision(campaign.revision, d.expectedRevision)
    if (!canCampaignTransition(campaign.status, 'cancelled')) throw failed('Esta campaña ya terminó.')
    const { rows } = await client.query<{ n: number }>('SELECT llenamos.marketing_cancel_campaign($1,$2) AS n', [rid, d.campaignId])
    const revision = campaign.revision + 1
    await client.query(`UPDATE llenamos.marketing_campaigns SET status='cancelled',revision=$3,updated_by=$4,updated_at=now() WHERE restaurant_id=$1 AND id=$2`, [rid, d.campaignId, revision, scope.uid])
    await emitCampaign(client, rid, d.campaignId, campaign.location_id, 'cancelled')
    return { revision, cancelledMessages: rows[0]!.n }
  },
})

export const informeCampana = memberOperation('informeCampana', {
  ...access('informeCampana'), ...S.informeCampana,
  run: async (client, d, scope) => {
    const rid = d.restaurantId
    const campaign = await scopedCampaign(client, rid, scope, d.campaignId)
    const counts = await client.query<{ status: string; excluded_reason: CampaignExclusion | null; n: number }>(
      `SELECT status,excluded_reason,count(*)::int AS n FROM llenamos.marketing_campaign_recipients WHERE restaurant_id=$1 AND campaign_id=$2 GROUP BY status,excluded_reason`, [rid, d.campaignId])
    const by = (status: string) => counts.rows.filter(r => r.status === status).reduce((s, r) => s + r.n, 0)
    const excluded = Object.fromEntries(CAMPAIGN_EXCLUSIONS.map(k => [k, counts.rows.find(r => r.status === 'excluded' && r.excluded_reason === k)?.n ?? 0])) as Record<CampaignExclusion, number>
    const unsub = await client.query<{ n: number }>('SELECT count(*)::int AS n FROM llenamos.marketing_unsubscribe_tokens WHERE restaurant_id=$1 AND campaign_id=$2 AND used_at IS NOT NULL', [rid, d.campaignId])
    const origin = await client.query<{ reservations: number; covers: string; seated: number; sales: string }>(
      `SELECT count(*)::int AS reservations,coalesce(sum(party_size),0)::text AS covers,count(*) FILTER (WHERE final_status IN ('seated','finished'))::int AS seated,coalesce(sum(sales_cents),0)::text AS sales
       FROM llenamos.reservation_origins WHERE restaurant_id=$1 AND campaign_id=$2 AND ($3::text IS NULL OR location_id=$3)`, [rid, d.campaignId, campaign.location_id])
    const o = origin.rows[0]!
    return {
      status: campaign.status, audience: campaign.stat_audience, queued: by('queued'), sent: by('sent'),
      // Sin proveedor el worker deja los mensajes en not_configured; el envío de prueba por captura no existe en el VPS.
      captured: 0, notConfigured: by('not_configured'), failed: by('failed'), cancelled: by('cancelled'), excluded,
      unsubscribed: unsub.rows[0]!.n, reservations: o.reservations, covers: Number(o.covers), seated: o.seated, salesCents: Number(o.sales),
    }
  },
})

export const informeOrigen = memberOperation('informeOrigen', {
  ...access('informeOrigen'), ...S.informeOrigen,
  run: async (client, d, scope) => {
    const ids = await visibleLocations(client, d.restaurantId, scope, d.locationIds)
    return originReportRows(client, d.restaurantId, ids, d.from, d.to)
  },
})

export { CAMPAIGN_COLUMNS, campaignView, loadMarketingSettings, missing }
