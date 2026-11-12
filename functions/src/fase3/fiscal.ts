import { FieldValue } from 'firebase-admin/firestore'
import * as core from '@llenamos/core'
import { type Context, type Input, account, get, fail, hash, newId, localOnly } from './context'

export function fiscalClock(now: number, timezone: string) {
  const parts = new Intl.DateTimeFormat('sv-SE',{ timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23',timeZoneName:'longOffset' }).formatToParts(now)
  const field = (type: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === type)!.value
  const year = field('year'), month = field('month'), day = field('day'), offset = field('timeZoneName').replace('GMT','') || '+00:00'
  return { year:Number(year),issueDate:`${day}-${month}-${year}`,generatedAt:`${year}-${month}-${day}T${field('hour')}:${field('minute')}:${field('second')}${offset}` }
}
export const chainKey = (settings: core.PosSettings) => hash([settings.issuer.nif,settings.system.installation])
function validSettings(c: Context, settings = c.settings) {
  if (!settings) fail('Falta configurar el emisor y las series de caja antes de facturar.')
  localOnly()
  if (settings.providerId !== 'local_test' || settings.environment !== 'test' || settings.fiscalRegime !== 'verifactu') fail('Solo está disponible VERI*FACTU de prueba, no válido para Hacienda. TicketBAI requiere proveedor.')
  return settings
}
export function ensureSeries(c: Context, settings: core.PosSettings) {
  const clock = fiscalClock(c.now,c.restaurant.timezone)
  const prefix = `L${hash([c.rid,c.lid]).slice(0,20).toUpperCase()}/${clock.year}`
  if (settings.ordinarySeriesId !== `ordinary_${clock.year}` || settings.rectifyingSeriesId !== `rectifying_${clock.year}`) fail('Las series nuevas deben ser las del año fiscal actual, creadas por el servidor.')
  for (const kind of ['ordinary','rectifying'] as const) {
    const id = `${kind}_${clock.year}`, old = c.rows.invoiceSeries.get(id)
    const expectedPrefix = `${prefix}/${kind === 'ordinary' ? 'F' : 'R'}`
    if (old) { if (old.prefix !== expectedPrefix || old.kind !== kind || old.year !== clock.year || !old.active) fail('La serie necesita una migración del proveedor.'); continue }
    c.put('invoiceSeries',id,{ prefix:expectedPrefix,kind,year:clock.year,lastSequence:0,lastIssueDate:null,active:true })
  }
}
export async function guardarConfiguracionCaja(c: Context, d: Input<'guardarConfiguracionCaja'>) {
  const settings = validSettings(c,d.settings), key = chainKey(settings)
  const identity = c.settings && { issuer:c.settings.issuer,system:c.settings.system,fiscalRegime:c.settings.fiscalRegime,providerId:c.settings.providerId,environment:c.settings.environment }
  const nextIdentity = { issuer:settings.issuer,system:settings.system,fiscalRegime:settings.fiscalRegime,providerId:settings.providerId,environment:settings.environment }
  const ownRecords = await c.tx.get(c.root.collection('fiscalRecords').limit(1))
  if (!ownRecords.empty && identity && JSON.stringify(identity) !== JSON.stringify(nextIdentity)) fail('El emisor y el sistema usados requieren migración del proveedor. No se reinician cadenas.')
  const binding = c.root.firestore.doc(`fiscalInstallations/${key}`), existing = await c.tx.get(binding)
  if (existing.exists && existing.get('restaurantId') !== c.rid) fail('Esta instalación fiscal ya pertenece a otro restaurante.')
  const identityHash = hash({ issuer:settings.issuer,system:settings.system,regime:settings.fiscalRegime })
  if (existing.exists && existing.get('identityHash') !== identityHash) fail('La identidad de esta instalación ya está vinculada. Requiere migración del proveedor.')
  if (!existing.exists) c.stage(binding.path,{ restaurantId:c.rid,issuerNif:settings.issuer.nif,installation:settings.system.installation,identityHash },true)
  const chain = await c.tx.get(c.root.collection('fiscalChains').doc(key))
  if (chain.exists && (chain.get('issuerNif') !== settings.issuer.nif || chain.get('installation') !== settings.system.installation || chain.get('regime') !== settings.fiscalRegime)) fail('La instalación requiere migración del proveedor.')
  if (!chain.exists) c.stage(`${c.root.path}/fiscalChains/${key}`,{ issuerNif:settings.issuer.nif,installation:settings.system.installation,regime:settings.fiscalRegime,head:null },true)
  ensureSeries(c,settings)
  c.stage(`${c.local.path}/settings/pos`,settings,!c.settings)
  return { ok:true as const }
}

/** Lee y verifica toda la cadena local antes de reservar un correlativo. Sin red en la transacción. */
async function fiscalState(c: Context) {
  const settings = validSettings(c), clock = fiscalClock(c.now,c.restaurant.timezone), chainId = chainKey(settings)
  // El cambio de año crea series nuevas; nunca reinicia la cabeza fiscal.
  const current = { ...settings,ordinarySeriesId:`ordinary_${clock.year}`,rectifyingSeriesId:`rectifying_${clock.year}` }
  ensureSeries(c,current)
  if (settings.ordinarySeriesId !== current.ordinarySeriesId || settings.rectifyingSeriesId !== current.rectifyingSeriesId) c.stage(`${c.local.path}/settings/pos`,current)
  const [chainDoc, records, binding] = await Promise.all([
    c.tx.get(c.root.collection('fiscalChains').doc(chainId)),
    c.tx.get(c.root.collection('fiscalRecords').where('input.chainId','==',chainId).orderBy('input.chainSequence')),
    c.tx.get(c.root.firestore.doc(`fiscalInstallations/${chainId}`)),
  ])
  if (!binding.exists || binding.get('restaurantId') !== c.rid || !chainDoc.exists) fail('La instalación fiscal no está vinculada a este restaurante.')
  const parsedChain = core.FiscalChainSchema.safeParse(chainDoc.data())
  const parsedRecords = records.docs.map(d => core.FiscalStoredRecordSchema.safeParse(d.data()))
  if (!parsedChain.success || parsedRecords.some(r => !r.success)) fail('La integridad de la cadena fiscal contiene datos inválidos. Se bloquea la emisión y debe revisarla el encargado.')
  const chain = parsedChain.data, stored = parsedRecords.map(r => r.data!)
  const last = stored.at(-1), identity = last ? core.fiscalIdentity(last.input) : null
  const expected = last ? { ...identity!,recordId:last.input.recordId,hash:last.hash,sequence:last.input.chainSequence } : null
  if (!core.verifyFiscalChain(stored) || JSON.stringify(chain.head) !== JSON.stringify(expected) || chain.issuerNif !== settings.issuer.nif || chain.installation !== settings.system.installation || chain.regime !== settings.fiscalRegime || stored.some(r => JSON.stringify(r.input.system) !== JSON.stringify(settings.system))) fail('La integridad de la cadena fiscal no coincide. Se bloquea la emisión y debe revisarla el encargado.')
  if (last && Date.parse(last.input.generatedAt) > c.now) fail('El reloj fiscal retrocede respecto al último registro.')
  const previous = chain.head ? { recordId:chain.head.recordId,hash:chain.head.hash,issuerNif:chain.head.issuerNif,number:chain.head.number,issueDate:chain.head.issueDate } : null
  return { settings:current,clock,chainId,chain,previous,sequence:(chain.head?.sequence ?? 0) + 1 }
}
type State = Awaited<ReturnType<typeof fiscalState>>
function number(c: Context, s: State, type: core.Invoice['type']) {
  const seriesId = type.startsWith('R') ? s.settings.rectifyingSeriesId : s.settings.ordinarySeriesId
  const series = get(c,'invoiceSeries',seriesId)
  const issued = [...c.rows.invoices.values()].filter(i => i.seriesId === seriesId).sort((a,b) => a.sequence - b.sequence)
  if (issued.length !== series.lastSequence || issued.some((i,index) => i.sequence !== index + 1)) fail('El correlativo de la serie no coincide con sus facturas. Requiere revisión.')
  const next = core.nextInvoiceNumber(series,type,s.clock.issueDate)
  return { seriesId,series,next }
}
async function save(c: Context, s: State, invoiceId: string, input: core.FiscalRecordInput, invoice: core.Invoice | null, numbering?: ReturnType<typeof number>) {
  const artifact = core.createTestFiscalProvider().prepare({ regime:s.settings.fiscalRegime,record:input,ticketbaiPrevious:null })
  const { record,...originalArtifact } = artifact
  const recordId = input.recordId
  if (invoice && numbering) {
    const key = hash([invoice.issuer.nif,invoice.number]), ref = c.root.collection('invoiceNumbers').doc(key)
    if ((await c.tx.get(ref)).exists) fail('Este número fiscal ya existe. La serie requiere revisión.')
    c.stage(ref.path,{ locationId:c.lid,invoiceId },true)
    c.put('invoiceSeries',numbering.seriesId,{ ...numbering.series,lastSequence:numbering.next.sequence,lastIssueDate:invoice.issueDate })
    c.stage(`${c.local.path}/invoices/${invoiceId}`,{ ...invoice,recordId,artifact:originalArtifact },true)
    c.stage(`${c.local.path}/printRequests/${hash(['invoice',invoiceId])}`,{ kind:'invoice',sourceId:invoiceId,printerId:null,copy:0,status:'queued',requestedBy:c.uid,requestedAt:c.now },true)
  }
  c.stage(`${c.root.path}/fiscalRecords/${recordId}`,{ ...record,locationId:c.lid,invoiceId,...originalArtifact },true)
  const identity = core.fiscalIdentity(input)
  c.stage(`${c.root.path}/fiscalChains/${s.chainId}`,{ ...s.chain,head:{ ...identity,recordId,hash:record.hash,sequence:s.sequence } })
  c.stage(`${c.root.path}/fiscalOutbox/${recordId}`,{ recordId,chainId:s.chainId,locationId:c.lid,invoiceId,status:'queued',attempts:0,nextAttemptAt:c.now,leaseUntil:null,leaseOwner:null },true)
  return { invoiceId,recordId,number:identity.number,fiscalStatus:'queued' as const,warning:core.FISCAL_TEST_WARNING }
}
function alta(c: Context, s: State, invoice: core.Invoice): core.FiscalRecordInput {
  return { recordId:newId(c,'fiscalRecords'),chainId:s.chainId,chainSequence:s.sequence,version:'1.0',kind:'alta',invoice,system:s.settings.system,generatedAt:s.clock.generatedAt,previous:s.previous,correctionOfRecordId:null,subsanacion:false,previousRejection:false }
}
export async function emitirFactura(c: Context, d: Input<'emitirFactura'>) {
  const bill = account(c,d), part = get(c,'billParts',d.partId)
  if (!['locked','settled'].includes(bill.status) || part.billId !== d.billId || part.revision !== bill.revision) fail('La factura necesita una parte de esta cuenta bloqueada.')
  if (part.invoiceId) {
    const stored = await c.tx.get(c.local.collection('invoices').doc(part.invoiceId))
    const invoice = core.InvoiceSchema.parse(stored.data())
    if (invoice.type !== d.type || JSON.stringify(invoice.recipient) !== JSON.stringify(d.recipient) || invoice.qualifiedSimplified !== d.qualifiedSimplified) fail('Esta parte ya está facturada con otros datos. Usa una corrección.')
    return { invoiceId:part.invoiceId,recordId:stored.get('recordId') as string,number:invoice.number,fiscalStatus:'queued' as const,warning:core.FISCAL_TEST_WARNING }
  }
  const s = await fiscalState(c), n = number(c,s,d.type)
  const lines = core.invoiceLinesForPart(core.netBillLines(bill.lines,bill.adjustments),part)
  const invoice = core.InvoiceSchema.parse({ billId:d.billId,partId:d.partId,issuer:s.settings.issuer,recipient:d.recipient,seriesId:n.seriesId,sequence:n.next.sequence,number:n.next.number,issueDate:s.clock.issueDate,operationDate:s.clock.issueDate,type:d.type,qualifiedSimplified:d.qualifiedSimplified,description:'Servicio de restauración de prueba, no válido para Hacienda',lines,...core.invoiceTotals(lines),correction:null,replacedInvoices:[] })
  const invoiceId = newId(c,'invoices'), result = await save(c,s,invoiceId,alta(c,s,invoice),invoice,n)
  c.put('billParts',d.partId,{ ...part,invoiceId })
  return result
}
function originalEvents(c: Context, invoiceId: string) { return [...c.secrets.invoiceEvents.values()].filter(e => e.invoiceId === invoiceId) }
export async function rectificarFactura(c: Context, d: Input<'rectificarFactura'>) {
  const original = get(c,'invoices',d.invoiceId), events = originalEvents(c,d.invoiceId)
  if (original.type.startsWith('R') || events.some(e => e.kind === 'cancelled' || e.kind === 'replaced')) fail('Esta factura requiere revisión del proveedor antes de corregirla.')
  if ((original.type === 'F2' || original.qualifiedSimplified) ? d.type !== 'R5' : !['R1','R2','R3','R4'].includes(d.type)) fail('El tipo de rectificación no corresponde al documento original.')
  // Se aplica sobre el saldo económico corregido para que S no vuelva a sumar reducciones anteriores.
  const remaining = original.lines.map((line,lineIndex) => {
    const reduced = core.sumCents(events.flatMap(e => e.kind === 'rectified' ? (e.reductions as { lineIndex:number;amountCents:number }[]).filter(r => r.lineIndex === lineIndex).map(r => r.amountCents) : []))
    return { ...line,quantity:1,unitPriceCents:line.grossCents - reduced,discountCents:0,grossCents:line.grossCents - reduced }
  })
  const current = core.InvoiceSchema.parse({ ...original,lines:remaining,...core.invoiceTotals(remaining) })
  const s = await fiscalState(c), n = number(c,s,d.type)
  const invoice = core.rectifyInvoice(current,{ ...d,seriesId:n.seriesId,sequence:n.next.sequence,number:n.next.number,issueDate:s.clock.issueDate })
  const id = newId(c,'invoices'), result = await save(c,s,id,alta(c,s,invoice),invoice,n)
  c.secret('invoiceEvents',newId(c,'invoiceEvents'),{ invoiceId:d.invoiceId,kind:'rectified',correctionInvoiceId:id,reductions:d.reductions,mode:d.mode,reason:d.reason })
  return result
}
export async function sustituirSimplificada(c: Context, d: Input<'sustituirSimplificada'>) {
  const original = get(c,'invoices',d.invoiceId)
  if (original.type !== 'F2' || originalEvents(c,d.invoiceId).length) fail('Solo se sustituye una simplificada que no tenga correcciones ni sustitución.')
  const s = await fiscalState(c), n = number(c,s,'F3')
  const invoice = core.InvoiceSchema.parse({ ...original,type:'F3',recipient:d.recipient,seriesId:n.seriesId,sequence:n.next.sequence,number:n.next.number,issueDate:s.clock.issueDate,replacedInvoices:[core.invoiceIdentity(original)] })
  const id = newId(c,'invoices'), result = await save(c,s,id,alta(c,s,invoice),invoice,n)
  c.secret('invoiceEvents',newId(c,'invoiceEvents'),{ invoiceId:d.invoiceId,kind:'replaced',replacementInvoiceId:id })
  return result
}
export async function anularRegistroFiscal(c: Context, d: Input<'anularRegistroFiscal'>) {
  const invoice = get(c,'invoices',d.invoiceId), bill = get(c,'bills',invoice.billId)
  if (originalEvents(c,d.invoiceId).length) fail('La factura ya tiene una incidencia. Debe revisarla el encargado.')
  // Una venta real se rectifica. La anulación solo se permite sin cobro ni operación viva.
  const dest = invoice.billId && (bill.target.kind === 'session' ? get(c,'tableSessions',bill.target.id) : get(c,'takeaways',bill.target.id))
  if (bill.paidCents || !dest || dest.status !== 'cancelled') fail('La anulación exige ausencia de operación y de cobros. Para una venta real emite rectificativa.')
  const s = await fiscalState(c)
  const input: core.FiscalRecordInput = { recordId:newId(c,'fiscalRecords'),chainId:s.chainId,chainSequence:s.sequence,version:'1.0',kind:'anulacion',invoice:core.invoiceIdentity(invoice),system:s.settings.system,generatedAt:s.clock.generatedAt,previous:s.previous,reason:d.reason,noPreviousRecord:false,previousRejection:false }
  const result = await save(c,s,d.invoiceId,input,null)
  c.secret('invoiceEvents',newId(c,'invoiceEvents'),{ invoiceId:d.invoiceId,kind:'cancelled',recordId:result.recordId,reason:d.reason })
  return { recordId:result.recordId,fiscalStatus:result.fiscalStatus }
}

/** Incidencia durable separada: la transacción de emisión fallida no puede conservar escrituras. */
export async function recordIntegrityIncident(rid: string, lid: string, message: string) {
  const { db } = await import('../shared')
  await db.doc(`restaurants/${rid}/fiscalIncidents/${hash([lid,message])}`).set({ locationId:lid,message,updatedAt:FieldValue.serverTimestamp() },{ merge:true })
}

/** Subsanación técnica: conserva factura y número y añade un registro nuevo bajo la misma cadena. */
export async function correctRejectedRecord(c: Context, recordId: string, reason: string) {
  const [recordDoc,outbox] = await Promise.all([c.tx.get(c.root.collection('fiscalRecords').doc(recordId)),c.tx.get(c.root.collection('fiscalOutbox').doc(recordId))])
  if (!recordDoc.exists || recordDoc.get('locationId') !== c.lid || !['rejected','accepted_with_errors'].includes(outbox.get('status'))) fail('Solo se subsana un registro con rechazo o errores del proveedor en este local.')
  const original = core.FiscalStoredRecordSchema.parse(recordDoc.data())
  if (original.input.kind !== 'alta') fail('La subsanación automática de anulaciones requiere revisión del proveedor.')
  const corrections = await c.tx.get(c.root.collection('fiscalRecords').where('input.correctionOfRecordId','==',recordId).limit(1))
  if (!corrections.empty) fail('Este registro ya tiene una subsanación. Revisa su respuesta.')
  const s = await fiscalState(c)
  const input: core.FiscalRecordInput = { ...alta(c,s,original.input.invoice),kind:'alta',invoice:original.input.invoice,subsanacion:true,previousRejection:outbox.get('status') === 'rejected',correctionOfRecordId:recordId }
  const invoiceId = recordDoc.get('invoiceId') as string
  const result = await save(c,s,invoiceId,input,null)
  c.secret('invoiceEvents',newId(c,'invoiceEvents'),{ invoiceId,kind:'subsanacion',recordId:result.recordId,correctionOfRecordId:recordId,reason })
  // El rechazo original se conserva. El procesador puede continuar con su registro de subsanación.
  c.stage(outbox.ref.path,{ ...core.FiscalOutboxSchema.parse(outbox.data()),supersededByRecordId:result.recordId })
  return result
}
