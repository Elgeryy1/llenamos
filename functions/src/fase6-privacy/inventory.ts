import * as core from '@llenamos/core'
import type { DocumentData } from 'firebase-admin/firestore'
import { collectionOf, digest, idOf, type Row } from './infra'

const kinds: Record<string,core.PersonalDataRecord["kind"]> = {
  privacyRequests:'submission', customers:'customer', reservations:'reservation',waitlist:'waitlist',takeaways:'takeaway',tableSessions:'session',orders:'order',orderLines:'line',floorTasks:'task',messages:'message',activity:'activity',orderSubmissions:'submission',posRequests:'submission',platformRequests:'submission',syncReceipts:'submission',digitalReceipts:'receipt',mobileCheckouts:'checkout',consents:'loyalty',privacyEvidence:'loyalty',loyalty:'loyalty',repite:'loyalty',reservationReferences:'reservation',takeawayReferences:'takeaway',takeawaySecrets:'takeaway',paymentRequests:'checkout',customerPhones:'customer',r2RateLimits:'customer',spendContributions:'submission',customerContributions:'submission',privacyJobs:'export',privacyDownloads:'export',
  bills:'receipt',billParts:'receipt',payments:'receipt',paymentReservations:'checkout',paymentEvents:'receipt',depositApplications:'receipt',invoiceEvents:'fiscal',invoices:'fiscal',fiscalRecords:'fiscal',fiscalResponses:'fiscal',fiscalOutbox:'fiscal',fiscalRequestKeys:'fiscal',
  // Fase 4: importes históricos de consumo enlazados a líneas, sin cambiar sus cantidades.
  lineCosts:'receipt',stockMovements:'receipt',refundReviews:'receipt',reservationSessions:'session',
  // Fase 5: cuenta, libro, permisos y colas con referencias personales.
  automationEvents:'loyalty',recommendations:'loyalty',loyaltyAccounts:'loyalty',loyaltyMovements:'loyalty',loyaltyRedemptions:'loyalty',repiteCards:'loyalty',repiteOutbox:'loyalty',recipients:'message',marketingSendLog:'message',unsubscribeTokens:'message',customerUses:'loyalty',fase5Requests:'submission',billPromotions:'receipt',
  // Fase 3: cola de impresión y pago móvil. Copian texto de la cuenta, notas de cocina o el receptor de una factura.
  printJobs:'receipt',printRequests:'receipt',printStatuses:'receipt',printCopies:'receipt',printIntents:'receipt',
  mobileRequests:'checkout',mobileStripeEvents:'checkout',mobileIncidents:'checkout',billTargets:'checkout',billAdjustments:'receipt',
  // Fase 6: recibos de sincronización y resoluciones. Conservan huella y secuencia para no repetir efectos.
  syncStreams:'submission',syncResolutions:'submission',
}
/**
 * Registro de jornada de la fase 4. No cuelga de ningún cliente y la obligación laboral de conservarlo
 * (cuatro años, a confirmar con el asesor laboral) es independiente de la supresión de un cliente: ni el
 * borrado ni la caducidad automática los tocan. Las copias de seguridad sí los incluyen.
 */
export const laborCollections = new Set(['timeEntries','timeEntryEvents','shifts','staffClockLocks','staffRequests'])
/** Plazo provisional del registro de jornada. Es un dato para el informe y la documentación, no una promesa legal. */
export const LABOR_RETENTION_DAYS_PROVISIONAL = 1461
export const fiscalCollections = new Set(['invoices','fiscalRecords','fiscalResponses','fiscalChains','invoiceSeries','invoiceNumbers','fiscalOutbox','fiscalRequestKeys','invoiceEvents'])
/** La cola de impresión apunta a su origen con `kind` + `sourceId`. */
const printSources: Record<string,string> = { kitchen:'orders',prebill:'bills',invoice:'invoices',drawer:'payments' }
export const printCollections = new Set(['printJobs','printRequests','printStatuses','printCopies','printIntents'])
const relationKeys: Record<string,string> = { reservationId:'reservations',sessionId:'tableSessions',takeawayId:'takeaways',orderId:'orders',lineId:'orderLines',billId:'bills',partId:'billParts',paymentId:'payments',invoiceId:'invoices',recordId:'fiscalRecords',jobId:'privacyJobs' }
export const millis = (v: unknown): number => typeof v === 'number' ? v : v && typeof v === 'object' && 'toMillis' in v ? (v as { toMillis():number }).toMillis() : 0
const lidOf = (r: Row) => { const p = r.path.split('/'); return p[2] === 'locations' ? p[3]! : '' }
function entries(value: unknown): [string,unknown][] {
  if (!value || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([k,v]) => [[k,v] as [string,unknown], ...entries(v)])
}
const contacts = (v: unknown) => typeof v === 'string' ? v.replace(/[\s().]/g,'').toLowerCase() : ''
const hasContact = (d: DocumentData, phone: string, email: string) => entries(d).some(([k,v]) => ['to','phone','email','recipient','recipientEmail'].includes(k) && !!contacts(v) && [phone,email].filter(Boolean).includes(contacts(v)))
export type Inventory = ReturnType<typeof inventory>
export function inventory(rows: Row[], rid: string, cid: string) {
  const customer = rows.find(r => collectionOf(r) === 'customers' && idOf(r) === cid)
  const phone = contacts(customer?.data.phone), email = contacts(customer?.data.email)
  const selected = new Map<string,Row>(), links = new Set<string>(), ambiguous: string[] = []
  function add(r: Row) { selected.set(r.path,r); links.add(`${lidOf(r)}:${collectionOf(r)}:${idOf(r)}`) }
  const isLinked = (r: Row, kind: string, id: string) => {
    if (lidOf(r)) return links.has(`${lidOf(r)}:${kind}:${id}`)
    const matching = [...links].filter(x => x.endsWith(`:${kind}:${id}`))
    if (matching.length > 1) ambiguous.push('Referencia de local ambigua')
    return matching.length === 1
  }
  for (const r of rows) {
    if (r.data.privacyRedacted || collectionOf(r) === 'privacyTombstones') continue
    if ((['automationEvents','recommendations'].includes(collectionOf(r)) && r.data.subject === cid) || (collectionOf(r) === 'customers' && idOf(r) === cid) || entries(r.data).some(([k,v]) => k === 'customerId' && v === cid) || (collectionOf(r) === 'messages' && hasContact(r.data,phone,email)) || ['r2RateLimits','customerPhones','loyaltyAccounts','repiteCards','recipients','marketingSendLog','customerUses'].includes(collectionOf(r)) && idOf(r) === cid) add(r)
  }
  for (let pass = 0; pass < rows.length + 1; pass++) {
    let changed = false
    for (const r of rows) {
      if (selected.has(r.path) || r.data.privacyRedacted || ['privacyTombstones','backups','restoreDrills'].includes(collectionOf(r))) continue
      const refs = entries(r.data)
      const related = refs.some(([k,v]) => typeof v === 'string' && relationKeys[k] && isLinked(r,relationKeys[k]!,v)) || (r.data.entity && typeof r.data.entity.id === 'string' && Object.entries({ reservation:'reservations',session:'tableSessions',takeaway:'takeaways',order:'orders',line:'orderLines',bill:'bills',customer:'customers' }).some(([t,c]) => r.data.entity.type === t && isLinked(r,c,r.data.entity.id))) || (r.data.target && isLinked(r,r.data.target.kind === 'session' ? 'tableSessions' : 'takeaways',r.data.target.id)) || (printCollections.has(collectionOf(r)) && typeof r.data.sourceId === 'string' && !!printSources[r.data.kind] && isLinked(r,printSources[r.data.kind]!,r.data.sourceId))
      if (related) { add(r); changed = true }
    }
    if (!changed) break
  }
  for (const r of rows) {
    if (selected.has(r.path) || r.data.privacyRedacted || ['privacyTombstones','backups','restoreDrills'].includes(collectionOf(r))) continue
    if (hasContact(r.data,phone,email) || entries(r.data).some(([,v]) => typeof v === 'string' && [phone,email].filter(Boolean).some(contact => contacts(v).includes(contact)))) ambiguous.push('Contacto en una copia sin relación demostrada')
  }
  for (const r of selected.values()) {
    if (r.data.privacyReviewRequired === true) ambiguous.push('Texto señalado para revisión humana')
    if (!kinds[collectionOf(r)]) ambiguous.push('Colección enlazada sin adaptador')
    if (entries(r.data).some(([k,v]) => k === 'customerId' && typeof v === 'string' && v !== cid && v !== '')) ambiguous.push('Copia compartida con otra persona')
  }
  const selectedRows = [...selected.values()].sort((a,b) => a.path.localeCompare(b.path))
  const live = selectedRows.filter(r => isLive(r))
  return { rows:selectedRows, ambiguous:[...new Set(ambiguous)], live, customer, phone, email, rid, cid }
}
/** Original fiscal, retención justificada o registro laboral: se conserva restringido y nunca se redacta. */
export function isRestricted(row: Row) {
  const c = collectionOf(row)
  return row.data.legalHold === true || fiscalCollections.has(c) || laborCollections.has(c) || (printCollections.has(c) && row.data.kind === 'invoice')
}
export function isLive(row: Row) {
  const c = collectionOf(row), d = row.data
  if (d.legalHold === true) return false
  if (c === 'repiteOutbox') return d.status === 'leased' && millis(d.leaseUntil) > Date.now()
  if (c === 'reservations') return !['finished','cancelled','no_show'].includes(d.status)
  if (c === 'tableSessions') return !['closed','cancelled','merged'].includes(d.status)
  if (c === 'takeaways') return !['picked_up','cancelled','rejected'].includes(d.status)
  if (c === 'floorTasks') return !['done','cancelled'].includes(d.status)
  if (c === 'orderLines') return !['served','cancelled'].includes(d.status)
  if (c === 'bills') return !['settled','cancelled'].includes(d.status)
  if (['mobileCheckouts','paymentReservations'].includes(c)) return ['pending','reserved','processing','ready','created'].includes(d.status)
  if (c === 'printJobs') return ['queued','leased','uncertain'].includes(d.status)
  if (c === 'printRequests') return ['queued','processing'].includes(d.status)
  if (c === 'messages') return !!d.claim || ['sending','leased','processing'].includes(d.status) || millis(d.leaseUntil) > Date.now()
  return false
}
export function projection(r: Row, rid: string, cid: string): core.PersonalDataRecord {
  const d = r.data
  return { restaurantId:rid,customerId:cid,kind:kinds[collectionOf(r)] ?? 'submission',id:idOf(r),locationId:lidOf(r) || null,occurredAt:millis(d.updatedAt ?? d.createdAt ?? d.startAt),active:isLive(r),legalHold:isRestricted(r),
    personal:{ name:d.guestName ?? d.name ?? null,phone:d.phone ?? (typeof d.to === 'string' && d.to.startsWith('+') ? d.to : null),email:d.email ?? (typeof d.to === 'string' && d.to.includes('@') ? d.to : null),notes:typeof d.notes === 'string' ? d.notes : null,allergies:typeof d.allergies === 'string' ? d.allergies : null,tags:Array.isArray(d.tags) ? d.tags : [] } }
}
/** Lista explícita de histórico: excluye credenciales, datos del emisor y actores ajenos. */
const historical = ['status','partySize','startAt','durationMinutes','pickupAt','openedAt','closedAt','placedAt','quantity','totalCents','paidCents','dueCents','amountCents','tipCents','currency','method','number','issueDate','type','purpose','policyVersion','at','visits','noShows','cancellations','spentCents','language','reference','guestNotes','balance','earned','redeemed','expired','points','balanceAfter','enrolledAt','expiresAt','kind','termsVersion','revision']
export function exportInventory(inv: Inventory, now: number) {
  return { ...core.exportCustomerData(inv.rid,inv.cid,inv.rows.map(r => projection(r,inv.rid,inv.cid)),now), history:inv.rows.map(r => ({ kind:kinds[collectionOf(r)],id:idOf(r),locationId:lidOf(r) || null,values:Object.fromEntries(historical.filter(k => r.data[k] !== undefined).map(k => [k, millis(r.data[k]) || r.data[k]])),retention:isRestricted(r) ? 'Conservación restringida. Plazo pendiente de política validada.' : null })), coverageVersion:1 }
}
const clearKeys = new Set(['name','guestName','phone','email','recipientEmail','notes','guestNotes','note','allergies','tags','rendered','providerMessageId','lastError','error','cancelReason','reason','reasonText','comment','comments','manageTokenHash','token','tokenHash','manageToken','trackingToken','checkoutUrl','url','secret','secretHash','offer','data','metadata','summary','label','customerName','customerPhone','customerEmail','response','evidenceId','tokenSecret','manageUrl','trackingUrl','document','recipient','payloadBase64'])
/** No cambia importes, estados fiscales ni hashes de peticiones que impiden duplicar efectos. */
export function redactedData(row: Row, tombstoneId: string): DocumentData {
  function clean(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(clean)
    if (!value || typeof value !== 'object' || 'toMillis' in value) return value
    return Object.fromEntries(Object.entries(value).map(([k,v]) => {
      if (k === 'customerId') return [k,tombstoneId.slice(0,20)]
      if (['manageTokenHash','tokenHash','secretHash'].includes(k)) return [k,'0'.repeat(64)]
      if (clearKeys.has(k)) {
        if (['phone'].includes(k)) return [k,'+34000000000']
        // Los nombres de platos, variantes y extras no identifican al comensal y conservan su esquema multilingüe.
        if (k === 'name' && ['orderLines','bills'].includes(collectionOf(row))) return [k,v]
        if (['name','guestName','label'].includes(k)) return [k,'Persona suprimida']
        if (k === 'reason' && typeof v === 'string') return [k,'Suprimido por privacidad']
        if (['notes','guestNotes','note','allergies','summary','reason','reasonText','cancelReason','payloadBase64'].includes(k) && typeof v === 'string') return [k,'']
        if (Array.isArray(v)) return [k,[]]
        return [k,null]
      }
      return [k,clean(v)]
    }))
  }
  const cleaned = clean(row.data) as DocumentData
  if (['automationEvents','recommendations'].includes(collectionOf(row))) cleaned.subject = tombstoneId.slice(0,20)
  if (collectionOf(row) === 'automationEvents') cleaned.data = {}
  if (collectionOf(row) === 'recommendations') Object.assign(cleaned,{ evidence:{},text:'Recomendación anonimizada',status:'dismissed' })
  if (collectionOf(row) === 'consents') Object.assign(cleaned,{ evidenceId:tombstoneId.slice(0,20),status:'withdrawn' })
  if (collectionOf(row) === 'fase5Requests') cleaned.result = null
  if (collectionOf(row) === 'loyaltyAccounts') Object.assign(cleaned, { status:'closed',balance:0,revision:Number(row.data.revision ?? 0)+1 })
  if (collectionOf(row) === 'repiteOutbox') Object.assign(cleaned, { status:'skipped',result:null,externalRef:null,leaseUntil:null,leaseOwner:null })
  if (collectionOf(row) === 'messages') Object.assign(cleaned,{ to:row.data.channel === 'whatsapp' ? '+34000000000' : 'suprimido@invalid.test',data:{},status:'cancelled',rendered:null,providerMessageId:null,lastError:null,claim:null,leaseUntil:null })
  return { ...cleaned,privacyRedacted:true,privacyTombstone:tombstoneId,changeId:digest(`privacy:${tombstoneId}:${row.path}`) }
}
export const deleteCollections = new Set(['privacyDownloads','customers','waitlist','reservationReferences','takeawayReferences','takeawaySecrets','customerPhones','r2RateLimits','digitalReceipts','repiteCards','recipients','marketingSendLog','unsubscribeTokens','customerUses'])
