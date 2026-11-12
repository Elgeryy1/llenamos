import * as core from '@llenamos/core'
import { ApiError } from '../../errors.js'
import { enqueueOutbox } from '../../outbox.js'
import { type Pos, fail, sha, newId, account, getBill, getPart, putPart, event } from './pos.js'
import { safeProcessPrintRequest } from './print.js'
import { billSource } from './source.js'
import { uuidFrom } from './ids.js'

/**
 * No hay adaptador fiscal real. Solo se admite el proveedor de prueba cuando el despliegue lo activa
 * de forma explícita (`LLENAMOS_FISCAL_TEST_MODE=1`); todo documento sale marcado «no válido para Hacienda».
 * Sin eso, la operación falla con `not-configured` y no consume ningún correlativo.
 */
export const fiscalTestMode = () => process.env.LLENAMOS_FISCAL_TEST_MODE === '1'
function validSettings(pos: Pos) {
  const settings = pos.settings
  if (!settings) return fail('Falta configurar el emisor y las series de caja antes de facturar.')
  if (!fiscalTestMode() || !pos.restaurant.isDemo) throw new ApiError(412, 'not-configured', 'La facturación electrónica no tiene proveedor fiscal configurado. El modo de prueba solo existe en restaurantes de demostración. No se emite ni se simula ningún registro.')
  if (settings.providerId !== 'local_test' || settings.environment !== 'test' || settings.fiscalRegime !== 'verifactu') fail('Solo está disponible VERI*FACTU de prueba, no válido para Hacienda. TicketBAI requiere proveedor.')
  return settings
}
export function fiscalClock(now: number, timezone: string) {
  const parts = new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset' }).formatToParts(now)
  const field = (type: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === type)!.value
  const year = field('year'), month = field('month'), day = field('day'), offset = field('timeZoneName').replace('GMT', '') || '+00:00'
  return { year: Number(year), issueDate: `${day}-${month}-${year}`, generatedAt: `${year}-${month}-${day}T${field('hour')}:${field('minute')}:${field('second')}${offset}` }
}
export const chainKey = (settings: core.PosSettings) => sha([settings.issuer.nif, settings.system.installation])
const lockChain = (pos: Pos, chainId: string) => pos.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`fiscal:${chainId}`])

async function ensureSeries(pos: Pos, settings: core.PosSettings) {
  const clock = fiscalClock(pos.now, pos.restaurant.timezone)
  const prefix = `L${sha([pos.rid, pos.lid]).slice(0, 20).toUpperCase()}/${clock.year}`
  if (settings.ordinarySeriesId !== `ordinary_${clock.year}` || settings.rectifyingSeriesId !== `rectifying_${clock.year}`) fail('Las series nuevas deben ser las del año fiscal actual, creadas por el servidor.')
  for (const kind of ['ordinary', 'rectifying'] as const) {
    const id = `${kind}_${clock.year}`, expectedPrefix = `${prefix}/${kind === 'ordinary' ? 'F' : 'R'}`
    const old = (await pos.client.query<{ data: unknown }>('SELECT data FROM llenamos.pos_invoice_series WHERE restaurant_id=$1 AND location_id=$2 AND id=$3', [pos.rid, pos.lid, id])).rows[0]
    if (old) {
      const s = core.InvoiceSeriesSchema.parse(old.data)
      if (s.prefix !== expectedPrefix || s.kind !== kind || s.year !== clock.year || !s.active) fail('La serie necesita una migración del proveedor.')
      continue
    }
    await pos.client.query('INSERT INTO llenamos.pos_invoice_series(restaurant_id,location_id,id,data) VALUES($1,$2,$3,$4)',
      [pos.rid, pos.lid, id, core.InvoiceSeriesSchema.parse({ prefix: expectedPrefix, kind, year: clock.year, lastSequence: 0, lastIssueDate: null, active: true })])
  }
}
export async function guardarConfiguracionCaja(pos: Pos, d: core.CallableParsedInput<'guardarConfiguracionCaja'>) {
  const settings = validSettings({ ...pos, settings: d.settings }), key = chainKey(settings)
  const identityOf = (s: core.PosSettings) => ({ issuer: s.issuer, system: s.system, fiscalRegime: s.fiscalRegime, providerId: s.providerId, environment: s.environment })
  const hasRecords = (await pos.client.query('SELECT 1 FROM llenamos.pos_fiscal_records WHERE restaurant_id=$1 LIMIT 1', [pos.rid])).rowCount
  if (hasRecords && pos.settings && JSON.stringify(identityOf(pos.settings)) !== JSON.stringify(identityOf(settings))) fail('El emisor y el sistema usados requieren migración del proveedor. No se reinician cadenas.')
  const identityHash = sha({ issuer: settings.issuer, system: settings.system, regime: settings.fiscalRegime })
  await lockChain(pos, key)
  const chain = (await pos.client.query<{ restaurant_id: string; identity_hash: string }>('SELECT restaurant_id,identity_hash FROM llenamos.pos_fiscal_chains WHERE id=$1', [key])).rows[0]
  if (chain && chain.restaurant_id !== pos.rid) fail('Esta instalación fiscal ya pertenece a otro restaurante.')
  if (chain && chain.identity_hash !== identityHash) fail('La identidad de esta instalación ya está vinculada. Requiere migración del proveedor.')
  if (!chain) {
    // La clave primaria global rechaza la misma instalación aunque RLS oculte la fila de otro restaurante.
    try {
      await pos.client.query('INSERT INTO llenamos.pos_fiscal_chains(id,restaurant_id,identity_hash,data) VALUES($1,$2,$3,$4)', [key, pos.rid, identityHash,
        { issuerNif: settings.issuer.nif, installation: settings.system.installation, regime: settings.fiscalRegime, head: null }])
    } catch (error) { if ((error as { code?: string }).code === '23505') fail('Esta instalación fiscal ya pertenece a otro restaurante.'); throw error }
  }
  await ensureSeries(pos, settings)
  await pos.client.query(`INSERT INTO llenamos.pos_settings(restaurant_id,location_id,settings) VALUES($1,$2,$3)
    ON CONFLICT(restaurant_id,location_id) DO UPDATE SET settings=EXCLUDED.settings,updated_at=now()`, [pos.rid, pos.lid, settings])
  return { ok: true as const }
}

/** Comprueba la cola de la cadena: cabeza guardada, último registro reconstruido y enlace con el anterior. */
async function verifyTail(pos: Pos, chainId: string, chain: core.FiscalChain) {
  const last2 = (await pos.client.query<{ data: unknown }>('SELECT data FROM llenamos.pos_fiscal_records WHERE chain_id=$1 AND restaurant_id=$2 ORDER BY chain_sequence DESC LIMIT 2', [chainId, pos.rid])).rows
  const stored = last2.map(r => core.FiscalStoredRecordSchema.safeParse(r.data))
  if (stored.some(r => !r.success)) return false
  const [last, prev] = stored.map(r => r.data!)
  if (!last) return chain.head === null
  const rebuilt = core.prepareFiscalRecord(last.input)
  if (last.hash !== rebuilt.hash || last.canonical !== rebuilt.canonical || last.xml !== rebuilt.xml || last.snapshotHash !== rebuilt.snapshotHash) return false
  const identity = core.fiscalIdentity(last.input)
  if (JSON.stringify(chain.head) !== JSON.stringify({ ...identity, recordId: last.input.recordId, hash: last.hash, sequence: last.input.chainSequence })) return false
  if (prev) { const p = last.input.previous; if (!p || p.recordId !== prev.input.recordId || p.hash !== prev.hash) return false }
  else if (last.input.chainSequence !== 1 || last.input.previous !== null) return false
  return true
}
/** Verificación completa desde el génesis, por páginas. Es una herramienta de revisión, no parte de cada emisión. */
export async function verifyFullChain(pos: Pos, chainId: string, page = 500) {
  const all: core.FiscalStoredRecord[] = []
  for (let after = 0; ; after += page) {
    const rows = (await pos.client.query<{ data: unknown }>('SELECT data FROM llenamos.pos_fiscal_records WHERE chain_id=$1 AND restaurant_id=$2 AND chain_sequence>$3 ORDER BY chain_sequence LIMIT $4', [chainId, pos.rid, after, page])).rows
    all.push(...rows.map(r => core.FiscalStoredRecordSchema.parse(r.data)))
    if (rows.length < page) break
  }
  return core.verifyFiscalChain(all)
}
async function fiscalState(pos: Pos) {
  const settings = validSettings(pos), clock = fiscalClock(pos.now, pos.restaurant.timezone), chainId = chainKey(settings)
  const current = { ...settings, ordinarySeriesId: `ordinary_${clock.year}`, rectifyingSeriesId: `rectifying_${clock.year}` }
  await ensureSeries(pos, current)
  if (settings.ordinarySeriesId !== current.ordinarySeriesId || settings.rectifyingSeriesId !== current.rectifyingSeriesId)
    await pos.client.query('UPDATE llenamos.pos_settings SET settings=$3,updated_at=now() WHERE restaurant_id=$1 AND location_id=$2', [pos.rid, pos.lid, current])
  await lockChain(pos, chainId)
  const row = (await pos.client.query<{ restaurant_id: string; data: unknown }>('SELECT restaurant_id,data FROM llenamos.pos_fiscal_chains WHERE id=$1 FOR UPDATE', [chainId])).rows[0]
  if (!row || row.restaurant_id !== pos.rid) fail('La instalación fiscal no está vinculada a este restaurante.')
  const parsed = core.FiscalChainSchema.safeParse(row.data)
  if (!parsed.success) fail('La integridad de la cadena fiscal contiene datos inválidos. Se bloquea la emisión y debe revisarla el encargado.')
  const chain = parsed.data!
  if (!(await verifyTail(pos, chainId, chain)) || chain.issuerNif !== settings.issuer.nif || chain.installation !== settings.system.installation || chain.regime !== settings.fiscalRegime)
    fail('La integridad de la cadena fiscal no coincide. Se bloquea la emisión y debe revisarla el encargado.')
  if (chain.head) {
    const last = core.FiscalStoredRecordSchema.parse((await pos.client.query<{ data: unknown }>('SELECT data FROM llenamos.pos_fiscal_records WHERE chain_id=$1 AND restaurant_id=$2 AND chain_sequence=$3', [chainId, pos.rid, chain.head.sequence])).rows[0]?.data)
    if (JSON.stringify(last.input.system) !== JSON.stringify(settings.system)) fail('La integridad de la cadena fiscal no coincide. Se bloquea la emisión y debe revisarla el encargado.')
    if (Date.parse(last.input.generatedAt) > pos.now) fail('El reloj fiscal retrocede respecto al último registro.')
  }
  const previous = chain.head ? { recordId: chain.head.recordId, hash: chain.head.hash, issuerNif: chain.head.issuerNif, number: chain.head.number, issueDate: chain.head.issueDate } : null
  return { settings: current, clock, chainId, chain, previous, sequence: (chain.head?.sequence ?? 0) + 1 }
}
type State = Awaited<ReturnType<typeof fiscalState>>

async function numbering(pos: Pos, s: State, type: core.Invoice['type']) {
  const seriesId = type.startsWith('R') ? s.settings.rectifyingSeriesId : s.settings.ordinarySeriesId
  const row = (await pos.client.query<{ data: unknown }>('SELECT data FROM llenamos.pos_invoice_series WHERE restaurant_id=$1 AND location_id=$2 AND id=$3 FOR UPDATE', [pos.rid, pos.lid, seriesId])).rows[0]
  if (!row) fail('La serie no existe. Guarda la configuración de caja.')
  const series = core.InvoiceSeriesSchema.parse(row.data)
  // El correlativo de la serie debe corresponder a una factura existente (índice único por serie y secuencia).
  if (series.lastSequence > 0 && !(await pos.client.query('SELECT 1 FROM llenamos.pos_invoices WHERE restaurant_id=$1 AND location_id=$2 AND series_id=$3 AND sequence=$4', [pos.rid, pos.lid, seriesId, series.lastSequence])).rowCount)
    fail('El correlativo de la serie no coincide con sus facturas. Requiere revisión.')
  return { seriesId, series, next: core.nextInvoiceNumber(series, type, s.clock.issueDate) }
}
async function save(pos: Pos, s: State, invoiceId: string, input: core.FiscalRecordInput, invoice: core.Invoice | null, n?: Awaited<ReturnType<typeof numbering>>) {
  const artifact = core.createTestFiscalProvider().prepare({ regime: s.settings.fiscalRegime, record: input, ticketbaiPrevious: null })
  const { record, ...originalArtifact } = artifact
  const recordId = input.recordId, identity = core.fiscalIdentity(input)
  if (invoice && n) {
    try {
      await pos.client.query(`INSERT INTO llenamos.pos_invoices(restaurant_id,location_id,id,bill_id,part_id,series_id,sequence,issuer_nif,number,record_id,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [pos.rid, pos.lid, invoiceId, invoice.billId, invoice.partId, n.seriesId, invoice.sequence, invoice.issuer.nif, invoice.number, recordId, invoice])
    } catch (error) { if ((error as { code?: string }).code === '23505') fail('Este número fiscal ya existe. La serie requiere revisión.'); throw error }
    await pos.client.query('UPDATE llenamos.pos_invoice_series SET data=$4 WHERE restaurant_id=$1 AND location_id=$2 AND id=$3',
      [pos.rid, pos.lid, n.seriesId, { ...n.series, lastSequence: n.next.sequence, lastIssueDate: invoice.issueDate }])
  }
  await pos.client.query('INSERT INTO llenamos.pos_fiscal_records(restaurant_id,id,location_id,chain_id,chain_sequence,invoice_id,data) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [pos.rid, recordId, pos.lid, s.chainId, s.sequence, invoiceId, { ...record, locationId: pos.lid, invoiceId, ...originalArtifact }])
  await pos.client.query('UPDATE llenamos.pos_fiscal_chains SET data=$2 WHERE id=$1', [s.chainId, { ...s.chain, head: { ...identity, recordId, hash: record.hash, sequence: s.sequence } }])
  await pos.client.query(`INSERT INTO llenamos.pos_fiscal_outbox(restaurant_id,record_id,chain_id,location_id,invoice_id,status,attempts,next_attempt_at) VALUES($1,$2,$3,$4,$5,'queued',0,$6)`,
    [pos.rid, recordId, s.chainId, pos.lid, invoiceId, new Date(pos.now)])
  if (invoice && n) {
    const reqId = sha(['invoice', invoiceId])
    await pos.client.query(`INSERT INTO llenamos.pos_print_requests(restaurant_id,location_id,id,kind,source_id,printer_id,copy,status,requested_by,requested_at) VALUES($1,$2,$3,'invoice',$4,NULL,0,'queued',$5,$6) ON CONFLICT DO NOTHING`,
      [pos.rid, pos.lid, reqId, invoiceId, pos.uid, new Date(pos.now)])
    await safeProcessPrintRequest(pos, reqId)
  }
  // El envío lo hace el worker con un adaptador real; aquí solo queda el aviso estable del hecho.
  await enqueueOutbox(pos.client, { id: uuidFrom(sha(['fiscal', recordId])), restaurantId: pos.rid, kind: 'caja.fiscal_registro', payload: { locationId: pos.lid, recordId, chainId: s.chainId } })
  await event(pos, 'caja.factura', invoiceId)
  return { invoiceId, recordId, number: identity.number, fiscalStatus: 'queued' as const, warning: core.FISCAL_TEST_WARNING }
}
const alta = (s: State, invoice: core.Invoice): core.FiscalRecordInput => ({ recordId: newId(), chainId: s.chainId, chainSequence: s.sequence, version: '1.0', kind: 'alta', invoice,
  system: s.settings.system, generatedAt: s.clock.generatedAt, previous: s.previous, correctionOfRecordId: null, subsanacion: false, previousRejection: false })

const getInvoice = async (pos: Pos, id: string) => {
  const row = (await pos.client.query<{ data: unknown; record_id: string }>('SELECT data,record_id FROM llenamos.pos_invoices WHERE restaurant_id=$1 AND location_id=$2 AND id=$3', [pos.rid, pos.lid, id])).rows[0]
  if (!row) throw new ApiError(404, 'not-found', 'No se encuentra el documento en este local.')
  return { invoice: core.InvoiceSchema.parse(row.data), recordId: row.record_id }
}
const eventsOf = async (pos: Pos, invoiceId: string) =>
  (await pos.client.query<{ kind: string; data: Record<string, unknown> }>('SELECT kind,data FROM llenamos.pos_invoice_events WHERE restaurant_id=$1 AND location_id=$2 AND invoice_id=$3', [pos.rid, pos.lid, invoiceId])).rows
const addEvent = (pos: Pos, invoiceId: string, kind: string, data: Record<string, unknown>) =>
  pos.client.query('INSERT INTO llenamos.pos_invoice_events(restaurant_id,location_id,id,invoice_id,kind,data) VALUES($1,$2,$3,$4,$5,$6)', [pos.rid, pos.lid, newId(), invoiceId, kind, data])

export async function emitirFactura(pos: Pos, d: core.CallableParsedInput<'emitirFactura'>) {
  const bill = await account(pos, d), part = await getPart(pos, d.partId)
  if (!['locked', 'settled'].includes(bill.status) || part.billId !== d.billId || part.revision !== bill.revision) fail('La factura necesita una parte de esta cuenta bloqueada.')
  if (part.invoiceId) {
    const { invoice, recordId } = await getInvoice(pos, part.invoiceId)
    if (invoice.type !== d.type || JSON.stringify(invoice.recipient) !== JSON.stringify(d.recipient) || invoice.qualifiedSimplified !== d.qualifiedSimplified) fail('Esta parte ya está facturada con otros datos. Usa una corrección.')
    return { invoiceId: part.invoiceId, recordId, number: invoice.number, fiscalStatus: 'queued' as const, warning: core.FISCAL_TEST_WARNING }
  }
  const s = await fiscalState(pos), n = await numbering(pos, s, d.type)
  const lines = core.invoiceLinesForPart(core.netBillLines(bill.lines, bill.adjustments), part)
  const invoice = core.InvoiceSchema.parse({ billId: d.billId, partId: d.partId, issuer: s.settings.issuer, recipient: d.recipient, seriesId: n.seriesId, sequence: n.next.sequence, number: n.next.number,
    issueDate: s.clock.issueDate, operationDate: s.clock.issueDate, type: d.type, qualifiedSimplified: d.qualifiedSimplified, description: 'Servicio de restauración de prueba, no válido para Hacienda',
    lines, ...core.invoiceTotals(lines), correction: null, replacedInvoices: [] })
  const invoiceId = newId(), result = await save(pos, s, invoiceId, alta(s, invoice), invoice, n)
  await putPart(pos, d.partId, { ...part, invoiceId })
  return result
}
export async function rectificarFactura(pos: Pos, d: core.CallableParsedInput<'rectificarFactura'>) {
  const { invoice: original } = await getInvoice(pos, d.invoiceId), events = await eventsOf(pos, d.invoiceId)
  if (original.type.startsWith('R') || events.some(e => e.kind === 'cancelled' || e.kind === 'replaced')) fail('Esta factura requiere revisión del proveedor antes de corregirla.')
  if ((original.type === 'F2' || original.qualifiedSimplified) ? d.type !== 'R5' : !['R1', 'R2', 'R3', 'R4'].includes(d.type)) fail('El tipo de rectificación no corresponde al documento original.')
  const remaining = original.lines.map((line, lineIndex) => {
    const reduced = core.sumCents(events.flatMap(e => e.kind === 'rectified' ? (e.data.reductions as { lineIndex: number; amountCents: number }[]).filter(r => r.lineIndex === lineIndex).map(r => r.amountCents) : []))
    return { ...line, quantity: 1, unitPriceCents: line.grossCents - reduced, discountCents: 0, grossCents: line.grossCents - reduced }
  })
  const current = core.InvoiceSchema.parse({ ...original, lines: remaining, ...core.invoiceTotals(remaining) })
  const s = await fiscalState(pos), n = await numbering(pos, s, d.type)
  const invoice = (() => { try { return core.rectifyInvoice(current, { ...d, seriesId: n.seriesId, sequence: n.next.sequence, number: n.next.number, issueDate: s.clock.issueDate }) } catch (e) { return fail((e as Error).message) } })()
  const id = newId(), result = await save(pos, s, id, alta(s, invoice), invoice, n)
  await pos.client.query("UPDATE llenamos.pos_refund_reviews SET status='corrected' WHERE restaurant_id=$1 AND location_id=$2 AND bill_id=$3 AND status='requires_fiscal_correction'", [pos.rid, pos.lid, original.billId])
  await addEvent(pos, d.invoiceId, 'rectified', { correctionInvoiceId: id, reductions: d.reductions, mode: d.mode, reason: d.reason })
  return result
}
export async function sustituirSimplificada(pos: Pos, d: core.CallableParsedInput<'sustituirSimplificada'>) {
  const { invoice: original } = await getInvoice(pos, d.invoiceId)
  if (original.type !== 'F2' || (await eventsOf(pos, d.invoiceId)).length) fail('Solo se sustituye una simplificada que no tenga correcciones ni sustitución.')
  const s = await fiscalState(pos), n = await numbering(pos, s, 'F3')
  const invoice = core.InvoiceSchema.parse({ ...original, type: 'F3', recipient: d.recipient, seriesId: n.seriesId, sequence: n.next.sequence, number: n.next.number, issueDate: s.clock.issueDate, replacedInvoices: [core.invoiceIdentity(original)] })
  const id = newId(), result = await save(pos, s, id, alta(s, invoice), invoice, n)
  await addEvent(pos, d.invoiceId, 'replaced', { replacementInvoiceId: id })
  return result
}
export async function anularRegistroFiscal(pos: Pos, d: core.CallableParsedInput<'anularRegistroFiscal'>) {
  const { invoice } = await getInvoice(pos, d.invoiceId), bill = await getBill(pos, invoice.billId, true)
  if ((await eventsOf(pos, d.invoiceId)).length) fail('La factura ya tiene una incidencia. Debe revisarla el encargado.')
  // Una venta real se rectifica. La anulación solo se permite sin cobro ni operación viva.
  const dest = await billSource().load(pos.client, { restaurantId: pos.rid, locationId: pos.lid }, bill.target)
  if (bill.paidCents || !dest || !dest.cancelled) fail('La anulación exige ausencia de operación y de cobros. Para una venta real emite rectificativa.')
  const s = await fiscalState(pos)
  const input: core.FiscalRecordInput = { recordId: newId(), chainId: s.chainId, chainSequence: s.sequence, version: '1.0', kind: 'anulacion', invoice: core.invoiceIdentity(invoice), system: s.settings.system,
    generatedAt: s.clock.generatedAt, previous: s.previous, reason: d.reason, noPreviousRecord: false, previousRejection: false }
  const result = await save(pos, s, d.invoiceId, input, null)
  await addEvent(pos, d.invoiceId, 'cancelled', { recordId: result.recordId, reason: d.reason })
  return { recordId: result.recordId, fiscalStatus: result.fiscalStatus }
}
