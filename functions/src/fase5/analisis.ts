import * as core from '@llenamos/core'
import { type Ctx, type Input, fail, denied, revision, settings, ts, raw, ms } from './context'
import { informeOrigen } from './marketing'

export function defaultAnalytics(): core.AnalyticsSettings {
  return { dailySummary:{ enabled:false,hour:'09:00',channels:['email'],recipientUids:['owner'],covers:'previous' },forecast:{ lowOccupancyBp:3000,highOccupancyBp:8500,daysAhead:7 },lapsedAfterDays:60 }
}
export const analyticsSettings = (c: Ctx) => settings(c,'analytics',core.AnalyticsSettingsSchema,defaultAnalytics())
export function dates(from:string,to:string) { const out:string[] = []; for (let date=from;date<=to;date=core.sumarDias(date,1)) out.push(date); return out }

/** Proyecciones de documentos ya calculados por caja y almacén; nunca se cambia su precio. */
export async function facts(c: Ctx,ids:string[],from:string,to:string) {
  const bills: core.BillFact[] = [], refunds: core.RefundFact[] = [], reservations: core.ReservationFact[] = [], capacity: core.CapacityFact[] = [], sold: core.SoldLineFact[] = []
  const catalog: { itemId:string;name:string;active:boolean }[] = [], costs: core.LineCost[] = []
  for (const lid of ids) {
    const p = `locations/${lid}`
    const accounts = await c.list(`${p}/bills`,core.BillSchema), sessions = await c.list(`${p}/tableSessions`,core.TableSessionSchema), payments = await c.list(`${p}/payments`,core.PaymentSchema), res = await c.list(`${p}/reservations`,core.ReservationSchema)
    const lines = await c.list(`${p}/orderLines`,core.OrderLineSchema), tables = await c.list(`${p}/tables`,core.TableSchema), menu = await c.list(`${p}/menuItems`,core.MenuItemSchema)
    const lineCosts = await c.list(`${p}/lineCosts`,core.LineCostSchema)
    const config = await c.maybe(`${p}/settings/reservations`,core.ReservationSettingsSchema)
    const engine = config ? core.settingsToConfiguracion(config) : null
    const openMinutesByDate:Record<string,number> = {}
    for (const date of dates(from,to)) {
      const day = engine ? core.turnosDelDia(engine,date) : null
      const ranges = day?.turnos.map(s => core.rangoTurno(s)) ?? []
      // Última entrada más duración habitual; se unen intervalos para no contar minutos dos veces.
      const minutes = new Set<number>()
      for (const r of ranges) for (let m=r.desde;m<r.ultimaEntrada+(config?.duration.defaultMinutes ?? 0);m++) minutes.add(m)
      openMinutesByDate[date] = minutes.size
    }
    capacity.push({ locationId:lid,seats:tables.filter(t => t.enabled).reduce((s,t) => s+t.seats,0),openMinutesByDate })
    reservations.push(...res.map(r => ({ locationId:lid,startAt:r.startAt,partySize:r.partySize,status:r.status })))
    for (const b of accounts) {
      if (b.status !== 'settled' || b.settledAt === null) continue
      const session = b.target.kind === 'session' ? sessions.find(s => s.id === b.target.id) : null
      const net = core.netBillLines(b.lines,b.adjustments)
      const inPeriod = core.horaLocal(b.settledAt,c.tz).fecha >= from && core.horaLocal(b.settledAt,c.tz).fecha <= to
      bills.push({ billId:b.id,locationId:lid,kind:b.target.kind,openedAt:session?.openedAt ?? b.openedAt,settledAt:b.settledAt,closedAt:session?.closedAt ?? b.settledAt,orderedCents:b.lines.reduce((s,l) => s+l.grossCents,0),invitationCents:b.adjustments.filter(a => a.kind === 'invitation').reduce((s,a) => s+a.amountCents,0),voidCents:b.adjustments.filter(a => a.kind === 'void').reduce((s,a) => s+a.amountCents,0),discountCents:b.adjustments.filter(a => a.kind === 'discount').reduce((s,a) => s+a.amountCents,0),totalCents:b.totalCents,netCents:net.reduce((s,l) => s+core.netOfGross(l.grossCents,l.taxRate),0),tipCents:payments.filter(p => p.billId === b.id && p.status === 'succeeded' && p.kind === 'charge').reduce((s,p) => s+p.tipCents,0),guests:session?.guests ?? 0 })
      if (inPeriod) {
        for (const l of net) {
          const order = lines.find(o => o.id === l.lineId)
          if (!order?.itemId || order.status === 'cancelled' || order.kind === 'menu') continue
          sold.push({ itemId:order.itemId,kind:order.kind,quantity:order.quantity,netOfAdjustmentsCents:l.grossCents })
          const frozen = lineCosts.find(x => x.id === l.lineId)
          if (frozen) costs.push(frozen)
        }
      }
    }
    for (const pmt of payments) {
      if (pmt.kind !== 'refund' || pmt.status !== 'succeeded') continue
      const bill = accounts.find(b => b.id === pmt.billId)
      if (!bill) fail('Una devolución no tiene cuenta de origen.')
      const net = core.netBillLines(bill.lines,bill.adjustments).reduce((s,l) => s+core.netOfGross(l.grossCents,l.taxRate),0)
      // La proporción se obtiene de la base congelada; el día de la devolución manda.
      refunds.push({ locationId:lid,at:pmt.at,amountCents:pmt.amountCents,netCents:bill.totalCents ? core.roundRatio(BigInt(net)*BigInt(pmt.amountCents),BigInt(bill.totalCents)) : 0 })
    }
    catalog.push(...menu.map(i => ({ itemId:i.id,name:i.name.es,active:i.active })))
  }
  return { bills,refunds,reservations,capacity,sold,catalog,costs }
}
export const totalsFor = (c: Ctx,f: Awaited<ReturnType<typeof facts>>,ids:string[],from:string,to:string) => core.computeTotals({ ...f,from,to,timezone:c.tz,locationIds:ids })

export async function panelAnalisis(c: Ctx,d: Input<'panelAnalisis'>) {
  const ids = await c.locations(d.locationIds), prev = core.previousRange(d.from,d.to)
  const f = await facts(c,ids,d.compare === 'previous' ? prev.from : d.from,d.to)
  const today = core.horaLocal(c.now,c.tz).fecha, cached = new Map<string,core.MetricTotals>()
  // La instantánea se usa para los días cerrados. Hoy siempre sale de los datos vivos.
  for (const lid of ids) for (const date of dates(d.from,d.to)) {
    const day = date < today ? await c.maybe(`locations/${lid}/analyticsDays/${date}`,raw) : null
    cached.set(`${lid}.${date}`,day ? day.totals as core.MetricTotals : totalsFor(c,f,[lid],date,date))
  }
  const sum = (ls:string[],ds:string[]) => ls.flatMap(lid => ds.map(date => cached.get(`${lid}.${date}`)!)).reduce(core.addTotals,core.emptyTotals())
  const ds = dates(d.from,d.to), total = sum(ids,ds), byLocation = Object.fromEntries(ids.map(id => [id,sum([id],ds)]))
  const compared = core.compareLocations(byLocation)
  const period = await facts(c,ids,d.from,d.to), dishes = core.dishSales(period.sold,period.catalog)
  const hours = core.peakSlots({ ...period,timezone:c.tz,slotMinutes:d.slotMinutes,from:d.from,to:d.to })
  return { from:d.from,to:d.to,total:core.deriveMetrics(total),comparison:d.compare === 'previous' ? core.comparePeriods(total,totalsFor(c,f,ids,prev.from,prev.to)) : null,byLocation:compared.rows,byDay:ds.map(date => ({ date,metrics:core.deriveMetrics(sum(ids,[date])) })),hours:{ slots:hours.slots,peak:hours.peak?.slot ?? null },dishes:{ top:dishes.rows.slice(0,20),bottom:[...dishes.rows].reverse().slice(0,20),zeroSales:dishes.zeroSales.slice(0,200).map(x => ({ itemId:x.itemId,name:x.name })) },margin:c.actor && core.can(c.actor.role,'costes.ver') && core.hasModule(c.restaurant,'inventory') ? core.marginTotals(period.costs) : null,computedAt:c.now }
}
export async function exportarAnalisis(c: Ctx,d: Input<'exportarAnalisis'>) {
  if (d.kind === 'origins' && !core.hasModule(c.restaurant,'marketing')) denied()
  let rows:Record<string,core.CsvCell>[]
  if (d.kind === 'origins') rows = (await informeOrigen(c,d)).rows.map(r => ({ ...r }))
  else {
    const panel = await panelAnalisis(c,{ ...d,compare:'none',slotMinutes:60 })
    if (d.kind === 'sales_by_day') rows = panel.byDay.map(x => ({ date:x.date,...x.metrics }))
    else if (d.kind === 'locations') rows = panel.byLocation.map(x => ({ locationId:x.locationId,...x.metrics,salesShareBp:x.salesShareBp }))
    else if (d.kind === 'hours') rows = panel.hours.slots.map(x => ({ ...x }))
    else {
      const ids = await c.locations(d.locationIds), f = await facts(c,ids,d.from,d.to), dishes = core.dishSales(f.sold,f.catalog)
      rows = [...dishes.rows,...dishes.zeroSales].map(x => ({ ...x }))
    }
  }
  const labels:Record<string,string> = {
    fecha:'Fecha',date:'Fecha',locationId:'Local',itemId:'Id de plato',name:'Plato',units:'Unidades',unitsInMenu:'Unidades en menú',salesCents:'Ventas (€)',
    grossSalesCents:'Ventas brutas (€)',netSalesCents:'Ventas netas (€)',refundCents:'Devoluciones (€)',discountCents:'Descuentos (€)',bills:'Cuentas',guests:'Comensales',
    averageTicketCents:'Ticket medio (€)',averagePerGuestCents:'Gasto por comensal (€)',rotationBp:'Rotación (%)',revenuePerSeatHourCents:'Ingreso por plaza y hora (€)',
    occupancyBp:'Ocupación (%)',noShowBp:'No presentados (%)',noShows:'No presentados',noShowCovers:'Comensales no presentados',salesShareBp:'Parte de ventas (%)',
    slot:'Hora',reservations:'Reservas',reservationCovers:'Comensales reservados',channel:'Canal',campaignId:'Campaña',adId:'Anuncio',covers:'Comensales',seated:'Presentados',cancelled:'Canceladas',
  }
  const keys = rows.length ? Object.keys(rows[0]!) : ['fecha']
  return { filename:core.csvFilename(d.kind,d.from,d.to),csv:core.toCsv(rows,keys.map(k => ({ header:labels[k] ?? k,value:r => r[k] ?? null,kind:k.endsWith('Cents') ? 'cents' : k.endsWith('Bp') ? 'bp' : 'text' }))),rows:rows.length }
}
export async function guardarConfiguracionAnalisis(c: Ctx,d: Input<'guardarConfiguracionAnalisis'>) {
  for (const uid of d.settings.dailySummary.recipientUids) {
    const m = await c.get(`members/${uid}`,core.MemberSchema)
    if (!m.active || !['owner','manager'].includes(m.role)) fail('El resumen solo lo recibe personal encargado activo.')
  }
  c.stage('settings/analytics',d.settings); return { ok:true }
}
export async function previsionOcupacion(c: Ctx,d: Input<'previsionOcupacion'>) {
  const p = await c.local(d.locationId), from = core.sumarDias(d.from,-84), to = core.sumarDias(d.from,d.days-1)
  const f = await facts(c,[d.locationId],from,to), sessions = await c.list(`${p}/tableSessions`,core.TableSessionSchema)
  const reservations = await c.list(`${p}/reservations`,core.ReservationSchema), cap = f.capacity[0]!
  const closedDays = await c.list(`${p}/analyticsDays`,raw)
  const observed = new Set([...sessions.map(s => core.horaLocal(s.openedAt,c.tz).fecha),...closedDays.map(d => d.id)])
  // Tener un horario hoy no demuestra doce semanas de servicio. Sin datos, confianza baja.
  const history = dates(from,to).filter(date => observed.has(date) && date < core.horaLocal(c.now,c.tz).fecha).map(date => ({ date,open:(cap.openMinutesByDate[date] ?? 0)>0,slots:core.presenceBySlot(sessions,date,c.tz,c.now) }))
  return { seats:cap.seats,days:dates(d.from,to).map(date => {
    const booked = core.presenceBySlot(reservations.filter(r => ['confirmed','pending','seated'].includes(r.status)).map(r => ({ openedAt:r.startAt,closedAt:r.startAt+r.durationMinutes*60000,guests:r.partySize })),date,c.tz,c.now)
    const day = core.forecastDay({ date,history,seats:cap.seats,booked }); return { ...day,peak:day.peak?.slot ?? null }
  }) }
}
export async function verResumenDiario(c: Ctx,d: Input<'verResumenDiario'>) {
  const row = await c.get(`dailySummaries/${d.date}`,raw)
  // Un resumen global no se entrega a un encargado limitado a un local.
  if (c.actor?.locationIds.length) denied()
  const sentTo = []
  for (const recipient of row.sentTo as { uid:string;channel:'email'|'whatsapp';status:string }[]) {
    const message = await c.tx.get(c.ref(`messages/${core.dailySummaryMessageId(d.date,recipient.uid,recipient.channel)}`))
    sentTo.push({ ...recipient,status:message.get('status') ?? recipient.status })
  }
  return { date:d.date,text:row.text,sentTo }
}
export async function guardarAutomatizacion(c: Ctx,d: Input<'guardarAutomatizacion'>) {
  const old = d.ruleId ? await c.get(`automationRules/${d.ruleId}`,raw) : null
  if (old) revision(Number(old.revision),d.expectedRevision)
  else if (d.expectedRevision !== null) fail('La regla no existe.')
  for (const lid of d.rule.locationIds) await c.local(lid)
  if (c.actor?.locationIds.length && !d.rule.locationIds.length) denied()
  if (d.rule.recommendation.segmentId) await c.get(`segments/${d.rule.recommendation.segmentId}`,core.SegmentSchema)
  const id = d.ruleId ?? c.root.collection('automationRules').doc().id, rev = Number(old?.revision ?? 0)+1
  c.stage(`automationRules/${id}`,{ ...d.rule,revision:rev }); return { ruleId:id,revision:rev }
}
export async function borrarAutomatizacion(c: Ctx,d: Input<'borrarAutomatizacion'>) {
  const rule = await c.get(`automationRules/${d.ruleId}`,raw); revision(Number(rule.revision),d.expectedRevision)
  for (const lid of rule.locationIds as string[]) await c.local(lid)
  if (c.actor?.locationIds.length && !(rule.locationIds as string[]).length) denied()
  c.remove(`automationRules/${d.ruleId}`); return { ok:true }
}
export async function simularAutomatizacion(c: Ctx,d: Input<'simularAutomatizacion'>) {
  const ids = await c.locations(null), events = (await c.list('automationEvents',raw)).filter(e => e.privacyRedacted !== true).map(e => core.AutomationEventInstanceSchema.parse({ ...e,at:ms(e.at) })).filter(e => (!e.locationId ? !c.actor?.locationIds.length : ids.includes(e.locationId)) && core.horaLocal(e.at,c.tz).fecha >= d.from && core.horaLocal(e.at,c.tz).fecha <= d.to)
  const plan = core.simulateRule(d.rule,events)
  return { events:events.length,fired:plan.fired.slice(0,500),skipped:plan.skipped,sample:events.slice(0,20) }
}
export async function resolverRecomendacion(c: Ctx,d: Input<'resolverRecomendacion'>) {
  const r = await c.get(`recommendations/${d.recommendationId}`,core.RecommendationSchema)
  if (r.locationId) await c.local(r.locationId); else if (c.actor?.locationIds.length) denied()
  if (r.status !== 'open' || r.expiresAt <= c.now) fail('Esta recomendación ya no está pendiente.')
  c.stage(`recommendations/${d.recommendationId}`,{ status:d.decision,decidedBy:c.uid,decidedAt:ts(c.now),note:d.note },'update')
  return { status:d.decision,kind:r.kind }
}
