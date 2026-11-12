import { onDocumentWritten, onDocumentCreated } from 'firebase-functions/v2/firestore'
import { onSchedule } from 'firebase-functions/v2/scheduler'
import * as core from '@llenamos/core'
import { HttpsError } from 'firebase-functions/v2/https'
import { db, options } from '../shared'
import { context, type Ctx, loyaltySettings, repiteSettings, raw, ts, ms } from './context'
import { ledger, movement, expire } from './fidelizacion'
import { processRepite, queueStamp } from './repite/service'
import { processCampaigns, cancelPending } from './marketing'
import { facts, totalsFor, analyticsSettings, previsionOcupacion } from './analisis'

export async function accruePoints(rid:string,lid:string,billId:string,now=Date.now()) {
  return db.runTransaction(async tx => {
    const c = await context(tx,rid,null,undefined,lid,now), p = `locations/${lid}`
    const bill = await c.get(`${p}/bills/${billId}`,core.BillSchema)
    if (bill.status !== 'settled' || !bill.customerId || !core.hasModule(c.restaurant,'loyalty')) return false
    const settings = await loyaltySettings(c), a = await c.maybe(`loyaltyAccounts/${bill.customerId}`,core.LoyaltyAccountSchema)
    const id = core.loyaltyMovementId.earn(billId), old = await tx.get(c.ref(`loyaltyMovements/${id}`))
    const redemptions = await c.list('loyaltyRedemptions',core.LoyaltyRedemptionSchema)
    const rows = await ledger(c,bill.customerId)
    for (const r of redemptions.filter(r => r.billId === billId && r.locationId === lid && r.status === 'applied')) c.stage(`loyaltyRedemptions/${r.id}`,{ status:'settled' },'update')
    if (!old.exists && a?.status === 'active' && a.enrolledAt <= (bill.settledAt ?? now) && settings.enabled) {
      const points = core.pointsForSpend(bill.totalCents,settings)
      if (points) {
        movement(c,expire(c,a,rows),id,{ kind:'earn',points,billId,locationId:lid,at:bill.settledAt ?? now,expiresAt:core.lotExpiresAt(bill.settledAt ?? now,settings) })
        c.audit('loyalty.earned','Puntos acumulados',{ billId,points }); c.flush(); return true
      }
    }
    c.flush(); return false
  },{ maxAttempts:10 })
}
export async function reversePoints(rid:string,lid:string,paymentId:string,now=Date.now()) {
  return db.runTransaction(async tx => {
    const c = await context(tx,rid,null,undefined,lid,now), p = `locations/${lid}`, payment = await c.get(`${p}/payments/${paymentId}`,core.PaymentSchema)
    if (payment.kind !== 'refund' || payment.status !== 'succeeded' || !core.hasModule(c.restaurant,'loyalty')) return false
    const bill = await c.get(`${p}/bills/${payment.billId}`,core.BillSchema)
    if (!bill.customerId) return false
    const a = await c.maybe(`loyaltyAccounts/${bill.customerId}`,core.LoyaltyAccountSchema)
    if (!a || a.status !== 'active') return false
    const id = core.loyaltyMovementId.earnReversal(paymentId)
    if ((await tx.get(c.ref(`loyaltyMovements/${id}`))).exists) return false
    const rows = await ledger(c,bill.customerId), payments = await c.tx.get(c.root.collection(`${p}/payments`).where('billId','==',payment.billId))
    if (!rows.some(m => m.id === core.loyaltyMovementId.earn(payment.billId))) return false
    const refunds = payments.docs.map(d => core.PaymentSchema.parse(d.data())).filter(p => p.kind === 'refund' && p.status === 'succeeded').reduce((s,p) => s+p.amountCents,0)
    const plan = core.planEarnReversal({ movements:rows,billId:payment.billId,originalPaidCents:bill.totalCents,paidAfterRefundsCents:Math.max(0,bill.totalCents-refunds),now })
    movement(c,expire(c,a,rows),id,{ kind:'earn_reversal',points:-plan.points,billId:payment.billId,earnMovementId:core.loyaltyMovementId.earn(payment.billId),reason:'Devolución de cobro' })
    c.audit('loyalty.reversed','Puntos corregidos por devolución',{ paymentId,points:plan.points,unrecovered:plan.unrecovered }); c.flush(); return true
  },{ maxAttempts:10 })
}
export async function expirePoints(rid:string,now=Date.now()) {
  const accounts = await db.collection(`restaurants/${rid}/loyaltyAccounts`).where('status','==','active').get()
  let count = 0
  for (const doc of accounts.docs) count += await db.runTransaction(async tx => {
    const c = await context(tx,rid,null,undefined,undefined,now), a = await c.get(`loyaltyAccounts/${doc.id}`,core.LoyaltyAccountSchema), rows = await ledger(c,doc.id)
    const planned = core.planExpirations(rows,now); if (!planned.length) return 0
    expire(c,a,rows); c.audit('loyalty.expired','Puntos caducados',{ customerId:doc.id,points:-planned.reduce((s,p) => s+p.points,0) }); c.flush(); return planned.length
  })
  return count
}
export async function stampReservation(rid:string,lid:string,id:string,now=Date.now()) {
  return db.runTransaction(async tx => {
    const c = await context(tx,rid,null,undefined,lid,now), r = await c.get(`locations/${lid}/reservations/${id}`,core.ReservationSchema), settings = await repiteSettings(c)
    if (!core.hasModule(c.restaurant,'repite') || !r.customerId || !['seated','finished'].includes(r.status) || !core.repiteStampApplies(settings,'seated')) return
    await queueStamp(c,r.customerId,core.repiteVisitKey({ restaurantId:rid,reservationId:id,sessionId:null }),'seated'); c.flush()
  })
}
export async function stampBill(rid:string,lid:string,id:string,now=Date.now()) {
  return db.runTransaction(async tx => {
    const c = await context(tx,rid,null,undefined,lid,now), b = await c.get(`locations/${lid}/bills/${id}`,core.BillSchema), settings = await repiteSettings(c)
    if (!core.hasModule(c.restaurant,'repite') || !b.customerId || b.status !== 'settled' || !core.repiteStampApplies(settings,'paid')) return
    const session = b.target.kind === 'session' ? await c.get(`locations/${lid}/tableSessions/${b.target.id}`,core.TableSessionSchema) : null
    const key = core.repiteVisitKey({ restaurantId:rid,reservationId:session?.reservationId ?? null,sessionId:b.target.kind === 'session' ? b.target.id : null,takeawayId:b.target.kind === 'takeaway' ? b.target.id : null })
    await queueStamp(c,b.customerId,key,'paid'); c.flush()
  })
}
export function event(c:Ctx,id:string,type:core.AutomationEvent,locationId:string|null,subject:string,data:core.AutomationEventInstance['data'],at=c.now) {
  c.stage(`automationEvents/${id}`,{ id,type,locationId,subject,data,at:ts(at) },'create')
}
export async function aggregateDay(rid:string,lid:string,date:string,now=Date.now()) {
  return db.runTransaction(async tx => {
    const c = await context(tx,rid,null,undefined,lid,now)
    if (!core.hasModule(c.restaurant,'analytics')) return null
    const f = await facts(c,[lid],date,date), totals = totalsFor(c,f,[lid],date,date), hours = core.peakSlots({ ...f,from:date,to:date,timezone:c.tz,slotMinutes:60 }), dishes = core.dishSales(f.sold,f.catalog)
    const id = `day.closed.${lid}.${date}`, old = await tx.get(c.ref(`automationEvents/${id}`))
    const prior = await c.maybe(`locations/${lid}/analyticsDays/${core.sumarDias(date,-7)}`,raw)
    c.stage(`locations/${lid}/analyticsDays/${date}`,{ totals,hours:{ slots:hours.slots,peak:hours.peak?.slot ?? null },dishes,computedAt:ts(now),sourceVersion:1 })
    if (!old.exists) { const metrics = core.deriveMetrics(totals); event(c,id,'day.closed',lid,date,{ grossSalesCents:totals.grossSalesCents,salesDeltaBp:core.comparePeriods(totals,prior?.totals as core.MetricTotals ?? null).grossSalesCents.deltaBp ?? 0,noShowBp:metrics.noShowBp ?? 0,occupancyBp:metrics.occupancyBp ?? 0 }) }
    c.audit('analytics.aggregated','Día de análisis calculado',{ locationId:lid,date }); c.flush(); return totals
  })
}
export async function sendDailySummary(rid:string,now=Date.now()) {
  return db.runTransaction(async tx => {
    const c = await context(tx,rid,null,undefined,undefined,now), config = await analyticsSettings(c)
    if (!core.hasModule(c.restaurant,'analytics')) return 0
    const date = core.dailySummaryDate(now,c.tz,config.dailySummary)
    if (!date) return 0
    if ((await tx.get(c.ref(`dailySummaries/${date}`))).exists) return 0
    const ids = await c.locations(null), priorDate = core.sumarDias(date,-7), today = core.horaLocal(now,c.tz).fecha
    const f = await facts(c,ids,priorDate,today), totals = totalsFor(c,f,ids,date,date), previous = totalsFor(c,f,ids,priorDate,priorDate)
    const res = f.reservations.filter(r => core.horaLocal(r.startAt,c.tz).fecha === today && r.status !== 'cancelled')
    const recs = await c.list('recommendations',core.RecommendationSchema), alerts:string[] = []
    if (recs.some(r => r.status === 'open')) alerts.push('Hay recomendaciones pendientes')
    for (const lid of ids) {
      const stocks = await c.list(`locations/${lid}/stockAlerts`,raw), entries = await c.list(`locations/${lid}/timeEntries`,raw)
      if (stocks.some(s => s.status === 'open')) alerts.push('Hay existencias bajo mínimos')
      if (entries.some(e => e.status === 'open' && e.forgotten === true)) alerts.push('Hay fichajes sin cerrar')
    }
    const text = core.renderDailySummary({ date,restaurantName:String(c.restaurant.name),totals,previous:core.hasBase(previous) ? previous : null,today:{ reservations:res.length,covers:res.reduce((s,r) => s+r.partySize,0),pending:res.filter(r => r.status === 'pending').length },alerts })
    const sentTo: { uid:string;channel:'email'|'whatsapp';status:string }[] = []
    for (const uid of config.dailySummary.recipientUids) {
      const m = await c.maybe(`members/${uid}`,core.MemberSchema), doc = await c.tx.get(c.ref(`members/${uid}`))
      if (!m?.active || !['owner','manager'].includes(m.role) || m.locationIds.length) continue
      for (const channel of config.dailySummary.channels) {
        const contact = channel === 'email' ? m.email : doc.get('phone'), id = core.dailySummaryMessageId(date,uid,channel)
        const existing = await tx.get(c.ref(`messages/${id}`))
        if (!contact) { sentTo.push({ uid,channel,status:'not_configured' }); continue }
        if (!existing.exists) c.stage(`messages/${id}`,{ channel,to:contact,template:'daily_summary',language:'es',data:{ summaryText:text,restaurantName:c.restaurant.name },reservationId:null,waitlistId:null,status:'queued',sendAt:ts(now),attempts:0,lastError:null,provider:null,providerMessageId:null,rendered:null },'create')
        sentTo.push({ uid,channel,status:existing.get('status') ?? 'queued' })
      }
    }
    c.stage(`dailySummaries/${date}`,{ text,totals,sentTo },'create'); c.audit('analytics.summary','Resumen diario preparado',{ date }); c.flush(); return sentTo.length
  })
}
export async function evaluateAutomations(rid:string,now=Date.now()) {
  return db.runTransaction(async tx => {
    const c = await context(tx,rid,null,undefined,undefined,now)
    if (!core.hasModule(c.restaurant,'analytics')) return 0
    const rules = await c.list('automationRules',raw), events = (await c.list('automationEvents',raw)).filter(e => e.privacyRedacted !== true).map(e => core.AutomationEventInstanceSchema.parse({ ...e,at:ms(e.at) })).filter(e => e.at <= now && e.at >= now-92*86400000).sort((a,b) => a.at-b.at || a.id.localeCompare(b.id)), recs = await c.list('recommendations',core.RecommendationSchema)
    let count = 0
    for (const row of rules) {
      const data: Record<string,unknown> = { ...row }; delete data.id; delete data.revision; delete data.createdAt; delete data.updatedAt; delete data.updatedBy
      const rule = core.AutomationRuleInputSchema.parse(data), last = new Map<string,number>()
      for (const r of recs.filter(r => r.ruleId === row.id)) last.set(r.subject,Math.max(last.get(r.subject) ?? 0,r.createdAt))
      for (const e of events) {
        const id = core.automationFiringId(row.id,e.id)
        if (recs.some(r => r.id === id) || !core.evaluateRule(rule,e,last.get(e.subject) ?? null).fire) continue
        c.stage(`recommendations/${id}`,{ ruleId:row.id,eventId:e.id,eventType:e.type,locationId:e.locationId,subject:e.subject,kind:rule.recommendation.kind,text:rule.recommendation.note ?? core.RECOMMENDATION_LABEL[rule.recommendation.kind],evidence:e.data,status:'open',createdAt:ts(e.at),expiresAt:ts(now+7*86400000),decidedBy:null,decidedAt:null,note:null },'create')
        last.set(e.subject,e.at); count++
        if (count >= 200) break
      }
      if (count >= 200) break
    }
    if (count) c.audit('analytics.recommended','Recomendaciones preparadas',{ count }); c.flush(); return count
  },{ maxAttempts:10 })
}
export async function expireRecommendations(rid:string,now=Date.now()) {
  const docs = await db.collection(`restaurants/${rid}/recommendations`).where('status','==','open').get()
  let count = 0
  for (const d of docs.docs) await db.runTransaction(async tx => {
    const c = await context(tx,rid,null,undefined,undefined,now), r = await c.get(`recommendations/${d.id}`,core.RecommendationSchema)
    if (r.status !== 'open' || r.expiresAt > now) return
    c.stage(`recommendations/${d.id}`,{ status:'expired' },'update'); c.audit('analytics.expired','Recomendación caducada'); c.flush(); count++
  })
  return count
}
export async function dailyEvents(rid:string,now=Date.now()) {
  return db.runTransaction(async tx => {
    const c = await context(tx,rid,null,undefined,undefined,now), config = await analyticsSettings(c)
    if (!core.hasModule(c.restaurant,'analytics')) return
    const date = core.horaLocal(now,c.tz).fecha, old = await c.tx.get(c.root.collection('automationEvents')), existing = new Set(old.docs.map(x => x.id))
    for (const customer of await c.list('customers',raw)) {
      if (!customer.lastVisitAt || customer.privacyRedacted) continue
      const days = Math.floor((now-ms(customer.lastVisitAt))/86400000), id = `customer.lapsed.${customer.id}.${date}`
      if (days >= config.lapsedAfterDays && !existing.has(id)) event(c,id,'customer.lapsed',null,customer.id,{ daysSinceVisit:days,visits:Number(customer.visits ?? 0),spentCents:Number(customer.spentCents ?? 0) })
    }
    if (core.hasModule(c.restaurant,'reservations')) for (const lid of await c.locations(null)) {
      const forecast = await previsionOcupacion(c,{ restaurantId:rid,locationId:lid,from:date,days:config.forecast.daysAhead })
      for (const day of forecast.days) {
        const occupancyBp = Math.max(0,...day.slots.map(s => s.occupancyBp ?? 0)), type = occupancyBp < config.forecast.lowOccupancyBp ? 'forecast.low_occupancy' : occupancyBp > config.forecast.highOccupancyBp ? 'forecast.high_occupancy' : null
        if (!type) continue
        const id = `${type}.${lid}.${day.date}.${date}`
        if (!existing.has(id)) event(c,id,type,lid,day.date,{ occupancyBp,daysAhead:Math.round((Date.parse(day.date)-Date.parse(date))/86400000),confidence:day.confidence })
      }
    }
    c.flush()
  })
}
export async function reservationEvent(rid:string,lid:string,id:string,now=Date.now()) {
  await db.runTransaction(async tx => {
    const c = await context(tx,rid,null,undefined,lid,now), r = await c.get(`locations/${lid}/reservations/${id}`,core.ReservationSchema)
    if (!core.hasModule(c.restaurant,'analytics') || !['no_show','cancelled'].includes(r.status)) return
    const type = r.status === 'no_show' ? 'reservation.no_show' : 'reservation.cancelled', eventId = `${type}.${lid}.${id}`
    if ((await tx.get(c.ref(`automationEvents/${eventId}`))).exists) return
    const customer = r.customerId ? await c.maybe(`customers/${r.customerId}`,raw) : null
    event(c,eventId,type,lid,r.customerId ?? id,type === 'reservation.no_show' ? { partySize:r.partySize,customerNoShows:Number(customer?.noShows ?? 0),hasDeposit:r.deposit.status === 'paid' } : { partySize:r.partySize,hoursBeforeStart:Math.max(0,Math.floor((r.startAt-now)/3600000)) })
    c.flush()
  })
}

/** Salud durable del trabajador, diferenciando fallo y última ejecución. */
export async function runWorker(name:string,work:(rid:string,now:number)=>Promise<unknown>,only?:string,now=Date.now()) {
  const restaurants = only ? [await db.doc(`restaurants/${only}`).get()] : (await db.collection('restaurants').get()).docs
  for (const r of restaurants) {
    if (!r.exists) continue
    const health = r.ref.collection('fase5Health').doc(name)
    try { await work(r.id,now); await health.set({ status:'ok',lastRunAt:ts(now),lastError:null,updatedBy:null }) }
    catch (error) { await health.set({ status:'failed',lastRunAt:ts(now),lastError:error instanceof Error ? error.message.slice(0,300) : 'Error del trabajador',updatedBy:null }); throw error }
  }
}
const billPath = 'restaurants/{rid}/locations/{lid}/bills/{id}', resPath = 'restaurants/{rid}/locations/{lid}/reservations/{id}'
/** Un disparador que llega cuando el restaurante o el documento ya no existen (borrado) no tiene nada que hacer. */
const siExiste = <E>(handler: (e: E) => Promise<unknown>) => async (e: E) => {
  try { await handler(e) } catch (error) { if (error instanceof HttpsError && error.code === 'not-found') return; throw error }
}
export const acumularPuntos = onDocumentWritten({ ...options,document:billPath },siExiste(async e => { if (e.data?.after.exists && e.data.after.get('status') === 'settled' && e.data.before.get('status') !== 'settled') { await accruePoints(e.params.rid,e.params.lid,e.params.id); const payments = await db.collection(`restaurants/${e.params.rid}/locations/${e.params.lid}/payments`).where('billId','==',e.params.id).where('kind','==','refund').get(); for (const p of payments.docs) await reversePoints(e.params.rid,e.params.lid,p.id) } }))
export const revertirPuntosPorDevolucion = onDocumentWritten({ ...options,document:'restaurants/{rid}/locations/{lid}/payments/{id}' },siExiste(async e => { if (e.data?.after.exists && e.data.after.get('kind') === 'refund' && e.data.after.get('status') === 'succeeded') { await reversePoints(e.params.rid,e.params.lid,e.params.id) } }))
export const selloRepitePorReserva = onDocumentWritten({ ...options,document:resPath },siExiste(async e => { if (e.data?.after.exists && e.data.after.get('status') === 'seated') await stampReservation(e.params.rid,e.params.lid,e.params.id) }))
export const selloRepitePorCobro = onDocumentWritten({ ...options,document:billPath },siExiste(async e => { if (e.data?.after.exists && e.data.after.get('status') === 'settled') await stampBill(e.params.rid,e.params.lid,e.params.id) }))
export const eventoAnalisisReserva = onDocumentWritten({ ...options,document:resPath },siExiste(async e => { if (e.data?.after.exists) await reservationEvent(e.params.rid,e.params.lid,e.params.id) }))
export const eventoAnalisisStock = onDocumentWritten({ ...options,document:'restaurants/{rid}/locations/{lid}/stockAlerts/{id}' },siExiste(async e => {
  if (!e.data?.after.exists || e.data.after.get('status') !== 'open' || e.data.before.get('status') === 'open') return
  await db.runTransaction(async tx => { const c = await context(tx,e.params.rid,null,undefined,e.params.lid), id = `stock.low.${e.params.lid}.${e.params.id}.${e.id}`; if (!core.hasModule(c.restaurant,'analytics') || (await tx.get(c.ref(`automationEvents/${id}`))).exists) return; event(c,id,'stock.low',e.params.lid,e.params.id,{ level:String(e.data!.after.get('level') ?? 'low'),daysToRunOut:0 }); c.flush() })
}))
export const evaluarAutomatizaciones = onDocumentCreated({ ...options,document:'restaurants/{rid}/automationEvents/{id}' },siExiste(async e => { await evaluateAutomations(e.params.rid) }))
export const repiteOperacionCreada = onDocumentCreated({ ...options,document:'restaurants/{rid}/repiteOutbox/{id}' },siExiste(async e => { await processRepite(e.params.rid) }))
export const cancelarMarketingSinPermiso = onDocumentCreated({ ...options,document:'restaurants/{rid}/consents/{id}' },siExiste(async e => { if (e.data?.get('status') === 'withdrawn') await db.runTransaction(async tx => { const c = await context(tx,e.params.rid,null); await cancelPending(c,String(e.data!.get('customerId')),String(e.data!.get('purpose'))); c.flush() }) }))
export const caducarPuntos = onSchedule({ ...options,schedule:'every day 03:00',timeZone:'Europe/Madrid' },() => runWorker('caducarPuntos',expirePoints))
export const procesarRepite = onSchedule({ ...options,schedule:'every 1 minutes' },() => runWorker('procesarRepite',processRepite))
export const procesarCampanas = onSchedule({ ...options,schedule:'every 5 minutes',timeoutSeconds:540 },() => runWorker('procesarCampanas',processCampaigns))
export const agregarDiaAnalisis = onSchedule({ ...options,schedule:'every day 04:00',timeZone:'Europe/Madrid',timeoutSeconds:540 },() => runWorker('agregarDiaAnalisis',async (rid,now) => { const r = await db.doc(`restaurants/${rid}`).get(), today = core.horaLocal(now,String(r.get('timezone') ?? 'Europe/Madrid')).fecha; for (const l of (await r.ref.collection('locations').get()).docs) for (let n=1;n<=4;n++) await aggregateDay(rid,l.id,core.sumarDias(today,-n),now); await dailyEvents(rid,now) }))
export const enviarResumenDiario = onSchedule({ ...options,schedule:'every 15 minutes',timeoutSeconds:540 },() => runWorker('enviarResumenDiario',sendDailySummary))
export const caducarRecomendaciones = onSchedule({ ...options,schedule:'every day 05:00',timeZone:'Europe/Madrid' },() => runWorker('caducarRecomendaciones',expireRecommendations))
