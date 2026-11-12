import { randomBytes } from 'node:crypto'
import * as core from '@llenamos/core'
import { db } from '../shared'
import { configuredAppOrigin } from '../public-app-url'
import { assertMarketingConsent } from '../fase6-privacy/index'
import { type Ctx, type Input, fail, revision, ts, context, raw, marketingSettings, hash, ms, denied } from './context'

export async function guardarConfiguracionMarketing(c: Ctx,d: Input<'guardarConfiguracionMarketing'>) { c.stage('settings/marketing',d.settings); return { ok:true } }
export async function guardarSegmento(c: Ctx,d: Input<'guardarSegmento'>) {
  const old = d.segmentId ? await c.get(`segments/${d.segmentId}`,core.SegmentSchema) : null
  if (old) revision(old.revision,d.expectedRevision)
  else if (d.expectedRevision !== null) fail('El segmento no existe.')
  const id = d.segmentId ?? c.root.collection('segments').doc().id, rev = (old?.revision ?? 0)+1
  c.stage(`segments/${id}`,{ ...d.segment,revision:rev }); return { segmentId:id,revision:rev }
}
export async function borrarSegmento(c: Ctx,d: Input<'borrarSegmento'>) {
  revision((await c.get(`segments/${d.segmentId}`,core.SegmentSchema)).revision,d.expectedRevision)
  const campaigns = await c.list('campaigns',core.CampaignSchema)
  if (campaigns.some(x => x.segmentId === d.segmentId && ['draft','scheduled','sending'].includes(x.status))) fail('Hay una campaña que usa este segmento.')
  c.remove(`segments/${d.segmentId}`); return { ok:true }
}
export async function audience(c: Ctx,rule: core.SegmentRule,channel: core.CampaignChannel,ignoreCampaign?: string) {
  const customers = await c.list('customers',raw), accounts = await c.list('loyaltyAccounts',core.LoyaltyAccountSchema)
  const tombstones = await c.tx.get(c.root.collection('privacyTombstones'))
  const suppressed = new Set(tombstones.docs.map(t => t.get('customerHash')))
  const candidates: core.AudienceCandidate[] = customers.map(x => ({ customerId:x.id,visits:Number(x.visits ?? 0),noShows:Number(x.noShows ?? 0),lastVisitAt:x.lastVisitAt ? ms(x.lastVisitAt) : null,spentCents:Number(x.spentCents ?? 0),tags:Array.isArray(x.tags) ? x.tags as string[] : [],language:core.LanguageSchema.catch('es').parse(x.language),points:accounts.find(a => a.customerId === x.id)?.balance ?? null,phone:typeof x.phone === 'string' ? x.phone : null,email:typeof x.email === 'string' ? x.email : null,suppressed:x.privacyRedacted === true || suppressed.has(core.sha256Hex(`${c.rid}:${x.id}`)) }))
  const consents = await c.list('consents',core.ConsentSchema), settings = await marketingSettings(c), logs = await c.list('marketingSendLog',raw)
  const sendLog = new Map(logs.map(x => [x.id,(x.entries as core.SendLogEntry[] ?? []).filter(e => e.campaignId !== ignoreCampaign)]))
  return { plan:core.planCampaignAudience({ candidates,rule,channel,consents,sendLog,settings,now:c.now }),customers,consents,settings,logs }
}
export async function previsualizarSegmento(c: Ctx,d: Input<'previsualizarSegmento'>) {
  const a = await audience(c,d.rule,d.channel)
  const { audience:count,recipients,...excluded } = a.plan.counts
  return { audience:count,recipients,excluded,sample:a.plan.recipients.slice(0,20).map(r => ({ customerId:r.customerId,name:String(a.customers.find(x => x.id === r.customerId)?.name ?? '') })) }
}
export async function guardarCampana(c: Ctx,d: Input<'guardarCampana'>) {
  const old = d.campaignId ? await c.get(`campaigns/${d.campaignId}`,core.CampaignSchema) : null
  if (old) { revision(old.revision,d.expectedRevision); if (old.status !== 'draft') fail('Solo se edita una campaña en borrador.') }
  else if (d.expectedRevision !== null) fail('La campaña no existe.')
  await c.get(`segments/${d.campaign.segmentId}`,core.SegmentSchema)
  if (d.campaign.locationId) await c.local(d.campaign.locationId)
  else if (c.actor?.locationIds.length) fail('Elige un local al que tengas acceso.')
  const id = d.campaignId ?? c.root.collection('campaigns').doc().id, rev = (old?.revision ?? 0)+1
  c.stage(`campaigns/${id}`,{ ...d.campaign,status:'draft',scheduledAt:null,launchedBy:null,stats:{ audience:0,queued:0,excluded:0,sent:0,failed:0,cancelled:0 },cursor:null,revision:rev })
  return { campaignId:id,revision:rev }
}
async function scopedCampaign(c: Ctx,id: string) { const row = await c.get(`campaigns/${id}`,core.CampaignSchema); if (row.locationId) await c.local(row.locationId); else if (c.actor?.locationIds.length) denied(); return row }
const baseUrl = configuredAppOrigin
function messageData(c: Ctx,campaign: core.Campaign,id: string,name: string,url: string) {
  return { title:campaign.content.title,body:campaign.content.body,guestName:name,restaurantName:String(c.restaurant.name),bookingUrl:campaign.content.includeBookingLink ? core.campaignLink(baseUrl(),String(c.restaurant.slug),id,campaign.channel) : '',unsubscribeUrl:url }
}
export async function simularCampana(c: Ctx,d: Input<'simularCampana'>) {
  const campaign = await scopedCampaign(c,d.campaignId), segment = await c.get(`segments/${campaign.segmentId}`,core.SegmentSchema)
  const a = await audience(c,segment.rule,campaign.channel), { audience:count,recipients,...excluded } = a.plan.counts
  const preview = core.renderMessage({ template:'marketing_campaign',channel:campaign.channel,language:'es',data:messageData(c,campaign,d.campaignId,'Cliente',`${baseUrl()}/baja/${c.restaurant.slug}?t=VISTA_PREVIA`) })
  return { audience:count,recipients,excluded,preview:{ subject:preview.subject,body:preview.body },firstSendAt:core.nextSendTime(c.now,c.tz,a.settings.sendWindow) }
}
export async function lanzarCampana(c: Ctx,d: Input<'lanzarCampana'>) {
  const campaign = await scopedCampaign(c,d.campaignId), settings = await marketingSettings(c)
  revision(campaign.revision,d.expectedRevision)
  if (campaign.status !== 'draft') fail('La campaña ya se lanzó o está cancelada.')
  const at = core.nextSendTime(Math.max(c.now,d.at ?? c.now),c.tz,settings.sendWindow)
  c.stage(`campaigns/${d.campaignId}`,{ status:'scheduled',scheduledAt:ts(at),launchedBy:c.uid,revision:campaign.revision+1 },'update')
  return { revision:campaign.revision+1,status:'scheduled',scheduledAt:at }
}
export async function cancelPending(c: Ctx,customerId?: string,purpose?: string,campaignId?: string) {
  let query = c.root.collection('messages').where('status','in',['queued','failed'])
  if (customerId) query = query.where('customerId','==',customerId)
  if (campaignId) query = query.where('campaignId','==',campaignId)
  const docs = await c.tx.get(query)
  let count = 0
  for (const m of docs.docs) {
    if (!m.get('purpose') || (purpose && m.get('purpose') !== purpose)) continue
    c.stage(`messages/${m.id}`,{ status:'cancelled',lastError:'Se retiró el permiso o se canceló la campaña.' },'update'); count++
    const cid = String(m.get('campaignId')), customer = String(m.get('customerId'))
    const r = await c.tx.get(c.ref(`campaigns/${cid}/recipients/${customer}`))
    if (r.exists) c.stage(`campaigns/${cid}/recipients/${customer}`,{ status:'cancelled' },'update')
  }
  return count
}
export async function cancelarCampana(c: Ctx,d: Input<'cancelarCampana'>) {
  const row = await scopedCampaign(c,d.campaignId); revision(row.revision,d.expectedRevision)
  if (!core.canCampaignTransition(row.status,'cancelled')) fail('Esta campaña ya terminó.')
  const count = await cancelPending(c,undefined,undefined,d.campaignId)
  c.stage(`campaigns/${d.campaignId}`,{ status:'cancelled',revision:row.revision+1 },'update')
  return { revision:row.revision+1,cancelledMessages:count }
}
export async function informeCampana(c: Ctx,d: Input<'informeCampana'>) {
  const row = await scopedCampaign(c,d.campaignId), recipients = await c.list(`campaigns/${d.campaignId}/recipients`,core.CampaignRecipientSchema)
  const messages = await c.tx.get(c.root.collection('messages').where('campaignId','==',d.campaignId))
  const states = messages.docs.map(m => m.get('status')), count = (s:string) => states.filter(x => x === s).length
  const excluded = Object.fromEntries(core.CAMPAIGN_EXCLUSIONS.map(k => [k,recipients.filter(r => r.excludedReason === k).length]))
  const tokens = await c.tx.get(c.root.collection('unsubscribeTokens').where('campaignId','==',d.campaignId))
  const origins = await informeOrigen(c,{ restaurantId:c.rid,from:'2000-01-01',to:'2100-01-01',locationIds:row.locationId ? [row.locationId] : null })
  const rows = origins.rows.filter(x => x.campaignId === d.campaignId)
  return { status:row.status,audience:row.stats.audience,queued:count('queued'),sent:count('sent')+count('delivered')+count('read'),captured:count('captured'),notConfigured:count('not_configured'),failed:count('failed'),cancelled:count('cancelled'),excluded,unsubscribed:tokens.docs.filter(t => t.get('usedAt')).length,reservations:rows.reduce((s,r) => s+r.reservations,0),covers:rows.reduce((s,r) => s+r.covers,0),seated:rows.reduce((s,r) => s+r.seated,0),salesCents:rows.reduce((s,r) => s+r.salesCents,0) }
}
export async function unsubscribe(slug: string,token: string,now = Date.now()) {
  // Índice público para resolver el slug; la misma respuesta para todos los casos.
  const found = await db.collection('restaurants').where('slug','==',slug).limit(1).get()
  if (found.empty) return { ok:true }
  await db.runTransaction(async tx => {
    const c = await context(tx,found.docs[0]!.id,null,undefined,undefined,now), id = core.sha256Hex(token)
    const row = await c.maybe(`unsubscribeTokens/${id}`,core.UnsubscribeTokenSchema)
    if (!row || row.usedAt !== null) return
    await cancelPending(c,row.customerId,row.purpose)
    c.stage(`consents/unsubscribe.${id}`,core.consentForWrite({ customerId:row.customerId,purpose:row.purpose,status:'withdrawn',policyVersion:'unsubscribe',at:now,source:'public',evidenceId:row.messageId },n => ts(n)),'create')
    c.stage(`unsubscribeTokens/${id}`,{ usedAt:ts(now) },'update')
    c.audit('marketing.unsubscribed','Permiso de marketing retirado',{ purpose:row.purpose }); c.flush()
  })
  return { ok:true }
}
export async function informeOrigen(c: Ctx,d: Input<'informeOrigen'>) {
  const ids = await c.locations(d.locationIds), rows: Parameters<typeof core.originReport>[0][number][] = []
  let withoutOrigin = 0
  for (const lid of ids) {
    const p = `locations/${lid}`, reservations = await c.list(`${p}/reservations`,core.ReservationSchema), origins = await c.list(`${p}/reservationOrigins`,core.ReservationOriginSchema)
    const sessions = await c.list(`${p}/tableSessions`,core.TableSessionSchema), bills = await c.list(`${p}/bills`,core.BillSchema)
    for (const r of reservations) {
      const date = core.horaLocal(r.startAt,c.tz).fecha
      if (date < d.from || date > d.to) continue
      const origin = origins.find(o => o.id === r.id)
      if (!origin) { withoutOrigin++; continue }
      const sessionIds = sessions.filter(s => s.reservationId === r.id).map(s => s.id)
      rows.push({ origin,status:r.status,salesCents:bills.filter(b => b.status === 'settled' && b.target.kind === 'session' && sessionIds.includes(b.target.id)).reduce((s,b) => s+b.totalCents-b.refundedCents,0) })
    }
  }
  return { rows:core.originReport(rows),withoutOrigin }
}

/** Una página de hasta 200; cada destinatario vuelve a comprobar permiso y frecuencia. */
export async function processCampaigns(rid: string,now = Date.now(),pageSize = 200) {
  const root = db.doc(`restaurants/${rid}`), rows = await root.collection('campaigns').where('status','in',['scheduled','sending']).get()
  let queued = 0
  for (const doc of rows.docs) {
    const planned = await db.runTransaction(async tx => {
      const c = await context(tx,rid,null,undefined,undefined,now), campaign = await c.get(`campaigns/${doc.id}`,core.CampaignSchema), settings = await marketingSettings(c)
      if (!core.hasModule(c.restaurant,'marketing') || !['scheduled','sending'].includes(campaign.status) || (campaign.scheduledAt ?? now) > now || core.nextSendTime(now,c.tz,settings.sendWindow) !== now) return null
      const segment = await c.get(`segments/${campaign.segmentId}`,core.SegmentSchema), a = await audience(c,segment.rule,campaign.channel,doc.id)
      const ids = [...a.plan.recipients.map(x => x.customerId),...a.plan.excluded.map(x => x.customerId)].sort().filter(id => campaign.cursor === null || id > campaign.cursor).slice(0,pageSize)
      c.stage(`campaigns/${doc.id}`,{ status:'sending',stats:{ ...campaign.stats,audience:a.plan.counts.audience },revision:campaign.revision+1 },'update'); c.flush()
      return ids
    })
    if (!planned) continue
    for (const customerId of planned) {
      queued += await db.runTransaction(async tx => {
        const c = await context(tx,rid,null,undefined,undefined,now), campaign = await c.get(`campaigns/${doc.id}`,core.CampaignSchema)
        if (!core.hasModule(c.restaurant,'marketing') || campaign.status !== 'sending') return 0
        const old = await c.tx.get(c.ref(`campaigns/${doc.id}/recipients/${customerId}`))
        if (old.exists) return 0
        const segment = await c.get(`segments/${campaign.segmentId}`,core.SegmentSchema), a = await audience(c,segment.rule,campaign.channel,doc.id)
        const recipient = a.plan.recipients.find(r => r.customerId === customerId), excluded = a.plan.excluded.find(r => r.customerId === customerId)
        if (!recipient) {
          c.stage(`campaigns/${doc.id}/recipients/${customerId}`,{ status:'excluded',excludedReason:excluded?.reason ?? 'suppressed',messageId:null,at:ts(now) },'create'); c.flush(); return 0
        }
        await assertMarketingConsent(tx,rid,customerId,core.purposeForChannel(campaign.channel))
        const id = core.campaignMessageId(doc.id,customerId), token = randomBytes(32).toString('base64url'), tokenHash = core.sha256Hex(token)
        const data = messageData(c,campaign,doc.id,String(a.customers.find(x => x.id === customerId)?.name ?? 'Cliente'),`${baseUrl()}/baja/${c.restaurant.slug}?t=${token}`)
        const m: core.Message = { channel:campaign.channel,to:recipient.to,template:'marketing_campaign',language:recipient.language,data,reservationId:null,waitlistId:null,status:'queued',sendAt:now,attempts:0,lastError:null,provider:null,providerMessageId:null,rendered:null,purpose:core.purposeForChannel(campaign.channel) as 'marketing_email' | 'marketing_whatsapp',customerId,campaignId:doc.id }
        core.MessageSchema.parse(m)
        c.stage(`messages/${id}`,{ ...m,sendAt:ts(now) },'create')
        c.stage(`unsubscribeTokens/${tokenHash}`,{ customerId,purpose:m.purpose,messageId:id,campaignId:doc.id,usedAt:null,createdAt:ts(now) },'create')
        c.stage(`marketingSendLog/${customerId}`,{ entries:[...(a.logs.find(x => x.id === customerId)?.entries as core.SendLogEntry[] ?? []).filter(x => x.at > now-30*86400000),{ at:now,campaignId:doc.id }] })
        c.stage(`campaigns/${doc.id}/recipients/${customerId}`,{ status:'queued',excludedReason:null,messageId:id,at:ts(now) },'create')
        c.audit('marketing.queued','Mensaje de campaña preparado',{ campaignId:doc.id }); c.flush(); return 1
      })
    }
    await db.runTransaction(async tx => {
      const c = await context(tx,rid,null,undefined,undefined,now), campaign = await c.get(`campaigns/${doc.id}`,core.CampaignSchema)
      if (campaign.status !== 'sending') return
      const recipients = await c.list(`campaigns/${doc.id}/recipients`,core.CampaignRecipientSchema)
      c.stage(`campaigns/${doc.id}`,{ cursor:planned.at(-1) ?? campaign.cursor,status:planned.length < pageSize ? 'sent' : 'sending',stats:{ ...campaign.stats,queued:recipients.filter(x => x.status === 'queued').length,excluded:recipients.filter(x => x.status === 'excluded').length } },'update'); c.flush()
    })
  }
  return queued
}

/** Guardia reutilizable para el coordinador; los mensajes locales nunca usan proveedores reales. */
export async function captureMarketingMessages(rid: string,now = Date.now()) {
  const docs = await db.collection(`restaurants/${rid}/messages`).where('status','==','queued').get()
  for (const row of docs.docs) await db.runTransaction(async tx => {
    const c = await context(tx,rid,null,undefined,undefined,now), snap = await tx.get(row.ref)
    if (!snap.get('purpose') || snap.get('status') !== 'queued' || ms(snap.get('sendAt')) > now) return
    const m = core.MessageSchema.parse(snap.data()), settings = await marketingSettings(c)
    const consents = await c.list('consents',core.ConsentSchema)
    const campaign = await c.maybe(`campaigns/${m.campaignId}`,core.CampaignSchema)
    const customer = await c.maybe(`customers/${m.customerId}`,raw)
    const cancelled = !core.hasCurrentConsent(consents,m.customerId!,m.purpose!,now) || campaign?.status === 'cancelled' || !customer || customer.privacyRedacted === true
    if (!cancelled && (!core.hasModule(c.restaurant,'marketing') || core.nextSendTime(now,c.tz,settings.sendWindow) !== now)) return
    c.stage(`messages/${row.id}`,{ status:cancelled ? 'cancelled' : process.env.FIRESTORE_EMULATOR_HOST ? 'captured' : 'not_configured',rendered:cancelled ? null : core.renderMessage(m),lastError:cancelled ? 'Ya no hay permiso para enviar.' : null },'update'); c.flush()
  })
}
