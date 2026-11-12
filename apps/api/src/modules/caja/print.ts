import { randomBytes } from 'node:crypto'
import type { Pool } from 'pg'
import * as core from '@llenamos/core'
import { ApiError } from '../../errors.js'
import { type Pos, fail, notFound, newId, sha, event } from './pos.js'
import { qrMatrix } from './qr.js'

const hashToken = (token: string) => sha(token)
const newToken = () => randomBytes(32).toString('base64url')
const jobId = (kind: string, sourceId: string, printerId: string, copy: number) => sha(JSON.stringify([kind, sourceId, printerId, copy]))

export async function bridgeAuth(pos: Pos, bridgeId: string) {
  const row = (await pos.client.query<{ revoked: boolean }>('SELECT revoked FROM llenamos.pos_print_bridges WHERE restaurant_id=$1 AND location_id=$2 AND id=$3', [pos.rid, pos.lid, bridgeId])).rows[0]
  return row && !row.revoked ? row : null
}
export async function guardarImpresora(pos: Pos, d: core.CallableParsedInput<'guardarImpresora'>) {
  const p = d.printer
  if (p.columns !== (p.paperMm === 58 ? 32 : 48)) fail('El perfil debe ser de 32 columnas para 58 mm o de 48 para 80 mm.')
  if (p.stationIds.length > 30 || new Set(p.stationIds).size !== p.stationIds.length) fail('Las estaciones deben ser distintas y como máximo treinta.')
  if (!(await bridgeAuth(pos, p.bridgeId))) fail('Vincula primero el puente de este local.')
  // Las estaciones pertenecen a cocina (V4). Mientras ese módulo no las publique, un destino de cocina no se puede validar.
  if (p.stationIds.length) fail('Las estaciones de cocina todavía no están desplegadas en el VPS. Guarda la impresora sin estaciones.')
  if (p.active && p.tickets) {
    const clash = (await pos.client.query('SELECT 1 FROM llenamos.pos_printers WHERE restaurant_id=$1 AND location_id=$2 AND active AND data->>\'tickets\'=\'true\' AND id IS DISTINCT FROM $3', [pos.rid, pos.lid, d.printerId])).rowCount
    if (clash) fail('Ya hay una impresora activa asignada a la caja. Desactiva esa asignación antes de cambiarla.')
  }
  const printerId = d.printerId ?? newId()
  const old = (await pos.client.query<{ data: core.Printer }>('SELECT data FROM llenamos.pos_printers WHERE restaurant_id=$1 AND location_id=$2 AND id=$3 FOR UPDATE', [pos.rid, pos.lid, printerId])).rows[0]
  if (d.printerId && !old) notFound('La impresora ya no existe en este local.')
  if (old && (old.data.bridgeId !== p.bridgeId || old.data.paperMm !== p.paperMm)) {
    const pending = (await pos.client.query('SELECT 1 FROM llenamos.pos_print_jobs WHERE restaurant_id=$1 AND location_id=$2 AND printer_id=$3 AND status IN (\'queued\',\'leased\') LIMIT 1', [pos.rid, pos.lid, printerId])).rowCount
    if (pending) fail('Resuelve los trabajos pendientes antes de cambiar el puente o el papel.')
  }
  await pos.client.query(`INSERT INTO llenamos.pos_printers(restaurant_id,location_id,id,active,data) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(restaurant_id,location_id,id) DO UPDATE SET active=EXCLUDED.active,data=EXCLUDED.data`, [pos.rid, pos.lid, printerId, p.active, core.PrinterSchema.parse(p)])
  // Equivale a `impresoraActualizada`: las solicitudes sin impresora se reintentan con el destino nuevo.
  const waiting = (await pos.client.query<{ id: string }>('SELECT id FROM llenamos.pos_print_requests WHERE restaurant_id=$1 AND location_id=$2 AND status=\'not_configured\' ORDER BY requested_at LIMIT 100', [pos.rid, pos.lid])).rows
  for (const r of waiting) await safeProcessPrintRequest(pos, r.id)
  await event(pos, 'caja.impresion', printerId)
  return { printerId }
}
/** Rota la credencial del puente; la anterior deja de valer. Solo se devuelve en claro esta vez. */
export async function vincularPuente(pos: Pos, d: core.CallableParsedInput<'vincularPuente'>) {
  const token = newToken()
  await pos.client.query(`INSERT INTO llenamos.pos_print_bridges(restaurant_id,location_id,id,token_hash,revoked,rotated_at) VALUES($1,$2,$3,$4,false,now())
    ON CONFLICT(restaurant_id,location_id,id) DO UPDATE SET token_hash=EXCLUDED.token_hash,revoked=false,rotated_at=now()`, [pos.rid, pos.lid, d.bridgeId, hashToken(token)])
  return { token }
}
export async function solicitarImpresion(pos: Pos, d: core.CallableParsedInput<'solicitarImpresion'>) {
  const kind = d.kind === 'test' ? 'prebill' as const : d.kind, sourceId = d.kind === 'test' ? `test_${d.requestId}` : d.sourceId
  if (d.kind === 'drawer' && d.copy) fail('Una copia nunca abre el cajón.')
  if (d.kind === 'drawer' && !core.can(await roleOf(pos), 'caja.gestionar')) throw new ApiError(403, 'permission-denied', 'No tienes permiso para esta operación en este local.')
  if (d.kind === 'test' && !core.can(await roleOf(pos), 'impresion.gestionar')) throw new ApiError(403, 'permission-denied', 'No tienes permiso para esta operación en este local.')
  const counterId = sha(JSON.stringify([kind, sourceId, d.printerId]))
  const counter = (await pos.client.query<{ value: number }>('SELECT value FROM llenamos.pos_print_copies WHERE restaurant_id=$1 AND location_id=$2 AND id=$3', [pos.rid, pos.lid, counterId])).rows[0]
  const copy = d.copy ? (counter?.value ?? 0) + 1 : 0
  const id = jobId(kind, sourceId, d.printerId, copy)
  const req: core.PrintRequest = { kind, sourceId, printerId: d.printerId, copy, status: 'queued', requestedBy: pos.uid, requestedAt: pos.now }
  const existing = (await pos.client.query<{ status: string; data: core.PrintJob }>('SELECT status FROM llenamos.pos_print_jobs WHERE restaurant_id=$1 AND location_id=$2 AND id=$3', [pos.rid, pos.lid, id])).rows[0]
  let job = existing ? { status: existing.status } : await prepareJob(pos, id, req, d.kind === 'test')
  if (existing?.status === 'failed' && !d.copy) {
    await pos.client.query('UPDATE llenamos.pos_print_jobs SET status=\'queued\',last_error=NULL,updated_at=now() WHERE restaurant_id=$1 AND location_id=$2 AND id=$3', [pos.rid, pos.lid, id])
    await pos.client.query('UPDATE llenamos.pos_print_statuses SET status=\'queued\',last_error=NULL,updated_at=now() WHERE restaurant_id=$1 AND location_id=$2 AND id=$3', [pos.rid, pos.lid, id])
  }
  if (!existing && job) await writeJob(pos, id, job as PreparedJob)
  await pos.client.query(`INSERT INTO llenamos.pos_print_requests(restaurant_id,location_id,id,kind,source_id,printer_id,copy,status,requested_by,requested_at,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT DO NOTHING`, [pos.rid, pos.lid, id, kind, sourceId, d.printerId, copy, job ? 'processed' : 'not_configured', pos.uid, new Date(pos.now), { test: d.kind === 'test' }])
  if (!job) await pos.client.query(`INSERT INTO llenamos.pos_print_statuses(restaurant_id,location_id,id,printer_id,source_id,kind,status,attempts,last_error) VALUES($1,$2,$3,$4,$5,$6,'not_configured',0,'Impresora o puente sin configurar.')
    ON CONFLICT DO NOTHING`, [pos.rid, pos.lid, id, d.printerId, sourceId, kind])
  if (d.copy) await pos.client.query(`INSERT INTO llenamos.pos_print_copies(restaurant_id,location_id,id,value) VALUES($1,$2,$3,$4)
    ON CONFLICT(restaurant_id,location_id,id) DO UPDATE SET value=EXCLUDED.value`, [pos.rid, pos.lid, counterId, copy])
  await event(pos, 'caja.impresion', id)
  return { printJobId: id, status: job ? 'queued' as const : 'not_configured' as const }
}
async function roleOf(pos: Pos) {
  return (await pos.client.query<{ role: core.Role }>('SELECT role FROM llenamos.memberships WHERE restaurant_id=$1 AND uid=$2', [pos.rid, pos.uid])).rows[0]?.role
}
type PreparedJob = NonNullable<Awaited<ReturnType<typeof prepareJob>>>
/** Genera solo bytes de confianza a partir de documentos del servidor; el cliente aporta una referencia. */
async function prepareJob(pos: Pos, id: string, request: core.PrintRequest, test: boolean) {
  const printerRow = (await pos.client.query<{ data: unknown }>('SELECT data FROM llenamos.pos_printers WHERE restaurant_id=$1 AND location_id=$2 AND id=$3', [pos.rid, pos.lid, request.printerId])).rows[0]
  const printer = core.PrinterSchema.safeParse(printerRow?.data)
  if (!printer.success || !printer.data.active || !(await bridgeAuth(pos, printer.data.bridgeId))) return null
  if (request.kind === 'drawer' && request.copy) fail('Una copia nunca abre el cajón.')
  // Una copia toma el documento congelado del original.
  const originalId = jobId(request.kind, request.sourceId, request.printerId!, 0)
  const original = request.copy ? (await pos.client.query<{ document: unknown }>('SELECT document FROM llenamos.pos_print_jobs WHERE restaurant_id=$1 AND location_id=$2 AND id=$3', [pos.rid, pos.lid, originalId])).rows[0] : null
  const document = original ? original.document as core.PrintDocument | null : test ? testDocument() : await documentFor(pos, request.kind, request.sourceId, printer.data, request.copy)
  const frozen = document ? core.PrintDocumentSchema.parse(document) : null
  if (request.copy && frozen && !frozen.lines.some(l => l.text === 'Copia')) frozen.lines.unshift({ text: 'Copia', bold: true, align: 'left' })
  const payload = frozen ? core.encodeEscPos(frozen, printer.data, qrMatrix) : core.drawerPulse()
  if (payload.length > 350_000) fail('El documento supera el tamaño máximo de impresión.')
  return { printerId: request.printerId!, bridgeId: printer.data.bridgeId, kind: request.kind, sourceId: request.sourceId, copy: request.copy, payloadHash: sha(Buffer.from(payload)), payloadBase64: Buffer.from(payload).toString('base64'), document: frozen }
}
async function writeJob(pos: Pos, id: string, job: PreparedJob) {
  await pos.client.query(`INSERT INTO llenamos.pos_print_jobs(restaurant_id,location_id,id,printer_id,bridge_id,kind,source_id,copy,status,payload_hash,payload_base64,document) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'queued',$9,$10,$11)
    ON CONFLICT DO NOTHING`, [pos.rid, pos.lid, id, job.printerId, job.bridgeId, job.kind, job.sourceId, job.copy, job.payloadHash, job.payloadBase64, job.document])
  await pos.client.query(`INSERT INTO llenamos.pos_print_statuses(restaurant_id,location_id,id,printer_id,source_id,kind,status,attempts) VALUES($1,$2,$3,$4,$5,$6,'queued',0)
    ON CONFLICT(restaurant_id,location_id,id) DO UPDATE SET status='queued',attempts=0,last_error=NULL,updated_at=now()`, [pos.rid, pos.lid, id, job.printerId, job.sourceId, job.kind])
}
const testDocument = () => core.prebillPrintDocument(['Prueba de impresora', 'Llenamos · impresión local', 'Papel térmico y acentos: á é í ó ú ñ €', 'No es una venta. No abre el cajón.'])
async function documentFor(pos: Pos, kind: core.PrintRequest['kind'], sourceId: string, printer: core.Printer, copy: number): Promise<core.PrintDocument | null> {
  if (kind === 'drawer') {
    if (!printer.drawer || !printer.tickets) fail('El cajón debe estar habilitado en la impresora de caja.')
    const row = (await pos.client.query<{ data: unknown }>('SELECT data FROM llenamos.pos_payments WHERE restaurant_id=$1 AND location_id=$2 AND id=$3', [pos.rid, pos.lid, sourceId])).rows[0]
    if (!row) return notFound('No se encuentra el origen de la impresión en este local.')
    const payment = core.PaymentSchema.parse(row.data)
    if (payment.status !== 'succeeded' || payment.method !== 'cash' || payment.kind !== 'charge') fail('El cajón requiere un cobro en efectivo confirmado de este local.')
    if (copy) fail('No se pueden crear copias de una apertura del cajón.')
    return null
  }
  if (kind === 'invoice') {
    if (!printer.tickets) fail('Esta impresora no está asignada a la caja.')
    const row = (await pos.client.query<{ data: unknown; record_id: string }>('SELECT data,record_id FROM llenamos.pos_invoices WHERE restaurant_id=$1 AND location_id=$2 AND id=$3', [pos.rid, pos.lid, sourceId])).rows[0]
    if (!row) return notFound('No se encuentra el origen de la impresión en este local.')
    const rec = (await pos.client.query<{ data: { qrUrl?: string | null; legend?: string | null; warning?: string | null; validForTaxAuthority?: boolean } }>(
      'SELECT data FROM llenamos.pos_fiscal_records WHERE restaurant_id=$1 AND id=$2 AND location_id=$3 AND invoice_id=$4', [pos.rid, row.record_id, pos.lid, sourceId])).rows[0]
    if (!rec) fail('No se encuentra el artefacto fiscal original de esta factura.')
    const a = rec!.data
    if (typeof a.qrUrl !== 'string') fail('Falta el QR fiscal original. No se ha generado un ticket.')
    return core.invoicePrintDocument(core.InvoiceSchema.parse(row.data), { qrUrl: a.qrUrl!, legend: a.legend ?? null, warning: a.validForTaxAuthority === true ? a.warning ?? null : core.FISCAL_TEST_WARNING }, copy > 0)
  }
  if (kind === 'prebill') {
    if (!printer.tickets) fail('Esta impresora no está asignada a la caja.')
    const row = (await pos.client.query<{ data: unknown }>('SELECT data FROM llenamos.pos_bills WHERE restaurant_id=$1 AND location_id=$2 AND id=$3', [pos.rid, pos.lid, sourceId])).rows[0]
    if (!row) return notFound('No se encuentra el origen de la impresión en este local.')
    const bill = core.BillSchema.parse(row.data)
    return core.prebillPrintDocument([...(copy ? ['Copia'] : []), ...core.netBillLines(bill.lines, bill.adjustments).map(l => `${l.quantity} x ${l.name}  ${core.fiscalDecimal(l.grossCents)} EUR`), `Total ${core.fiscalDecimal(bill.totalCents)} EUR`])
  }
  throw new ApiError(412, 'not-deployed', 'Las comandas de cocina las genera el módulo de sala y cocina, que todavía no está desplegado en el VPS.')
}
/**
 * Como `processSafely` del original: un documento que no se puede preparar deja la solicitud en `failed`
 * y nunca tumba el cobro, la factura o el guardado de la impresora que la originó.
 */
export async function safeProcessPrintRequest(pos: Pos, requestId: string) {
  await pos.client.query('SAVEPOINT print_request')
  try {
    await processPrintRequest(pos, requestId)
    await pos.client.query('RELEASE SAVEPOINT print_request')
  } catch {
    await pos.client.query('ROLLBACK TO SAVEPOINT print_request')
    await pos.client.query(`UPDATE llenamos.pos_print_requests SET status='failed',data=data||'{"lastError":"No se pudo preparar el documento. Revisa su origen y el perfil de la impresora."}'::jsonb
      WHERE restaurant_id=$1 AND location_id=$2 AND id=$3`, [pos.rid, pos.lid, requestId])
    await pos.client.query('RELEASE SAVEPOINT print_request')
  }
}
/** Convierte una solicitud durable en trabajos; reconciliable y con ID de trabajo estable. */
export async function processPrintRequest(pos: Pos, requestId: string) {
  const row = (await pos.client.query<{ kind: core.PrintRequest['kind']; source_id: string; printer_id: string | null; copy: number; requested_by: string | null; requested_at: Date; data: { test?: boolean }; status: string }>(
    'SELECT kind,source_id,printer_id,copy,requested_by,requested_at,data,status FROM llenamos.pos_print_requests WHERE restaurant_id=$1 AND location_id=$2 AND id=$3 FOR UPDATE', [pos.rid, pos.lid, requestId])).rows[0]
  if (!row || !['queued', 'not_configured'].includes(row.status)) return
  const printers = row.printer_id ? (await pos.client.query<{ id: string; data: unknown }>('SELECT id,data FROM llenamos.pos_printers WHERE restaurant_id=$1 AND location_id=$2 AND id=$3', [pos.rid, pos.lid, row.printer_id])).rows
    : (await pos.client.query<{ id: string; data: unknown }>('SELECT id,data FROM llenamos.pos_printers WHERE restaurant_id=$1 AND location_id=$2 AND active ORDER BY id', [pos.rid, pos.lid])).rows
  const eligible = printers.filter(p => {
    const v = core.PrinterSchema.safeParse(p.data)
    return v.success && v.data.active && (row.kind === 'kitchen' ? false : row.kind === 'drawer' ? v.data.drawer && v.data.tickets : v.data.tickets)
  })
  let any = false
  for (const p of eligible) {
    const request: core.PrintRequest = { kind: row.kind, sourceId: row.source_id, printerId: p.id, copy: row.copy, status: 'queued', requestedBy: row.requested_by, requestedAt: row.requested_at.getTime() }
    const id = jobId(request.kind, request.sourceId, p.id, request.copy)
    if ((await pos.client.query('SELECT 1 FROM llenamos.pos_print_jobs WHERE restaurant_id=$1 AND location_id=$2 AND id=$3', [pos.rid, pos.lid, id])).rowCount) { any = true; continue }
    const job = await prepareJob(pos, id, request, row.data?.test === true)
    if (job) { await writeJob(pos, id, job); any = true }
  }
  await pos.client.query('UPDATE llenamos.pos_print_requests SET status=$4 WHERE restaurant_id=$1 AND location_id=$2 AND id=$3', [pos.rid, pos.lid, requestId, any ? 'processed' : 'not_configured'])
}

// ---- Puente: se autentica con su credencial, sin usuario. ----
const BRIDGE_ERRORS: Record<string, [number, string, string]> = {
  '42501': [403, 'permission-denied', 'No tienes acceso a esta impresora o puente en este local.'],
  '22023': [400, 'invalid-argument', 'Estado de impresión no válido.'],
  P0001: [412, 'failed-precondition', 'El trabajo ya no tiene este lease activo.'],
}
function bridgeError(error: unknown): never {
  const code = (error as { code?: string }).code
  const mapped = code ? BRIDGE_ERRORS[code] : undefined
  if (mapped) throw new ApiError(...mapped)
  throw error
}
async function bridgeTx<T>(pool: Pool, scope: { restaurantId: string; locationId: string; bridgeId: string; token: string }, run: (client: import('pg').PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  let broken = false
  try {
    await client.query('BEGIN')
    const row = (await client.query<{ plan: string; module_overrides: unknown; active_modules: string[]; entitlement_version: number | null; access_valid_until: Date | null }>('SELECT * FROM llenamos.pos_bridge_scope($1,$2,$3,$4)', [scope.restaurantId, scope.locationId, scope.bridgeId, hashToken(scope.token)])).rows[0]
    if (!row) throw new ApiError(403, 'permission-denied', 'No tienes acceso a esta impresora o puente en este local.')
    const modules = { plan: row.plan as core.Plan, moduleOverrides: row.module_overrides as core.ModuleOverrides, activeModules: row.active_modules as core.Module[],
      ...(row.entitlement_version ? { entitlementVersion: row.entitlement_version, accessValidUntil: row.access_valid_until?.getTime() ?? 0 } : {}) }
    if (!core.hasModule(modules, 'pos')) throw new ApiError(412, 'failed-precondition', 'El módulo de caja está desactivado.')
    const result = await run(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    try { await client.query('ROLLBACK') } catch { broken = true }
    return bridgeError(error)
  } finally { client.release(broken) }
}
export function reclamarImpresiones(pool: Pool, d: core.CallableParsedInput<'reclamarImpresiones'>) {
  return bridgeTx(pool, d, async client => {
    const tokens = Array.from({ length: d.limit }, newToken)
    const { rows } = await client.query<{ idx: number; id: string; printer_id: string; payload_hash: string; payload_base64: string; lease_until: Date }>(
      'SELECT * FROM llenamos.pos_bridge_claim($1,$2,$3,$4,$5,$6,60)', [d.restaurantId, d.locationId, d.bridgeId, hashToken(d.token), d.limit, tokens.map(hashToken)])
    return { jobs: rows.map(r => ({ id: r.id, printerId: r.printer_id, payloadHash: r.payload_hash, payloadBase64: r.payload_base64, leaseToken: tokens[r.idx - 1]!, leaseUntil: r.lease_until.getTime() })) }
  })
}
export function confirmarImpresion(pool: Pool, d: core.CallableParsedInput<'confirmarImpresion'>) {
  return bridgeTx(pool, d, async client => {
    await client.query('SELECT llenamos.pos_bridge_confirm($1,$2,$3,$4,$5,$6,$7,$8)', [d.restaurantId, d.locationId, d.bridgeId, hashToken(d.token), d.printJobId, hashToken(d.leaseToken), d.status, d.error])
    return { ok: true as const }
  })
}
