import { createHash, randomBytes } from 'node:crypto'
import type { PoolClient } from 'pg'
import type { z } from 'zod'
import * as core from '@llenamos/core'
import { ApiError } from '../../errors.js'
import { emitEvent } from '../../events.js'
import type { Operation } from '../../operations.js'
import { openStripeCredentials } from '../../payments/credentials.js'
import { StripeRejected, checkoutUrl, isLiveKey, stripeCheckout } from '../../payments/stripe.js'
import { appOrigin } from '../reservas/notices.js'
import { open as openSecret } from '../sala/secrets.js'
import { withPublicScope, type Tenant } from '../reservas/scope.js'
import { type Pos, fail, notFound, newId, sha, account, getPart, event } from './pos.js'
import { enqueueJob } from '../../jobs.js'
import { stableUuid } from '../../ids.js'
import { type PublicContext, openPublic, rejectLink, tokenMatches } from './enlace.js'

export const EXPIRE_SESSION_JOB = 'caja.expirar_sesion'
export const CHECKOUT_LIFETIME_MS = 15 * 60_000
/** Stripe exige al menos 30 minutos de vida para una sesión de Checkout. */
export const STRIPE_SESSION_SECONDS = 1800

export interface CheckoutRow {
  id: string; location_id: string; bill_id: string; part_id: string; revision: number; amount_cents: number; tip_cents: number
  status: 'pending' | 'paid' | 'expired' | 'failed' | 'reconciliation_required'; token_hash: string; expires_at: Date; cash_session_id: string
  start_request: string | null; start_fingerprint: string | null; started_at: Date | null; recipient: unknown; email: string | null
  accept_digital_receipt: boolean; language: core.Language; livemode: boolean | null; stripe_account: string | null; stripe_name: string | null
  stripe_origin: string | null; stripe_session_id: string | null; stripe_url: string | null; stripe_expires_at: Date | null
  payment_id: string | null; paid_at: Date | null; invoice_id: string | null; invoice_state: 'none' | 'pending' | 'not_configured' | 'done'
  receipt_id: string | null; receipt_path: string | null; delivery: string; needs_reconciliation: boolean; last_error: string | null
}
const newSecret = () => core.linkToken(randomBytes(32))
export const linkPath = (slug: string, lid: string, id: string, secret: string) => `/p/${slug}/${lid}/${id}?t=${secret}`

/** Un cobro en curso por local: el pago móvil se asienta en la única caja abierta. */
async function singleOpenCash(client: PoolClient, rid: string, lid: string) {
  const rows = (await client.query<{ id: string }>("SELECT id FROM llenamos.pos_cash_sessions WHERE restaurant_id=$1 AND location_id=$2 AND status='open' LIMIT 2", [rid, lid])).rows
  if (rows.length !== 1) fail('Para el pago móvil debe haber una sola caja abierta en este local.')
  return rows[0]!.id
}

// ---- Personal: crear el enlace privado de una parte ----
export async function crearEnlaceCobro(pos: Pos, d: core.CallableParsedInput<'crearEnlaceCobro'>) {
  const bill = await account(pos, d), part = await getPart(pos, d.partId)
  if (bill.status !== 'locked' || part.billId !== d.billId || part.revision !== d.expectedRevision || bill.revision !== d.expectedRevision) fail('La cuenta ha cambiado. Pide al personal un enlace actualizado.')
  const amount = part.totalCents - part.paidCents
  if (amount <= 0) fail('Esta parte ya está pagada.')
  const cashSessionId = await singleOpenCash(pos.client, pos.rid, pos.lid)
  const slug = (await pos.client.query<{ slug: string }>('SELECT slug FROM llenamos.restaurants WHERE id=$1', [pos.rid])).rows[0]!.slug
  const linkRequest = sha(['staff', pos.uid, d.requestId, d.partId])
  return rotateOrInsert(pos.client, { rid: pos.rid, lid: pos.lid, billId: d.billId, partId: d.partId, revision: d.expectedRevision, amount, cashSessionId, slug, createdBy: pos.uid, linkRequest })
}
/** Repetir la solicitud (mismo `requestId`) rota el secreto del mismo cobro aún sin iniciar en vez de abrir otro; el secreto nunca se guarda en claro. */
async function rotateOrInsert(client: PoolClient, v: Parameters<typeof insertCheckout>[1]) {
  const old = (await client.query<{ id: string; start_request: string | null; status: string }>('SELECT id,start_request,status FROM llenamos.pos_mobile_checkouts WHERE restaurant_id=$1 AND location_id=$2 AND link_request=$3 FOR UPDATE', [v.rid, v.lid, v.linkRequest])).rows[0]
  if (!old) return insertCheckout(client, v)
  if (old.status !== 'pending' || old.start_request) fail('Este enlace ya no admite nuevos pagos. Crea uno nuevo.')
  const secret = newSecret(), expiresAt = Date.now() + CHECKOUT_LIFETIME_MS
  await client.query('UPDATE llenamos.pos_mobile_checkouts SET token_hash=$4,expires_at=$5,updated_at=now() WHERE restaurant_id=$1 AND location_id=$2 AND id=$3', [v.rid, v.lid, old.id, core.sha256Hex(secret), new Date(expiresAt)])
  return { checkoutId: old.id, token: secret, path: linkPath(v.slug, v.lid, old.id, secret), expiresAt }
}
async function insertCheckout(client: PoolClient, v: { rid: string; lid: string; billId: string; partId: string; revision: number; amount: number; cashSessionId: string; slug: string; createdBy: string; linkRequest: string | null }) {
  const id = newId(), secret = newSecret(), expiresAt = Date.now() + CHECKOUT_LIFETIME_MS
  await client.query(`INSERT INTO llenamos.pos_mobile_checkouts(restaurant_id,location_id,id,bill_id,part_id,revision,amount_cents,token_hash,expires_at,cash_session_id,created_by,link_request)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [v.rid, v.lid, id, v.billId, v.partId, v.revision, v.amount, core.sha256Hex(secret), new Date(expiresAt), v.cashSessionId, v.createdBy, v.linkRequest])
  await emitEvent(client, { restaurantId: v.rid, locationId: v.lid, topic: 'caja.movil', entityId: id })
  return { checkoutId: id, token: secret, path: linkPath(v.slug, v.lid, id, secret), expiresAt }
}

// ---- Personal: cancelar un intento y revisar incidencias ----
export async function cancelarCobroMovil(pos: Pos, d: core.CallableParsedInput<'cancelarCobroMovil'>) {
  const row = (await pos.client.query<CheckoutRow>('SELECT * FROM llenamos.pos_mobile_checkouts WHERE restaurant_id=$1 AND location_id=$2 AND id=$3 FOR UPDATE', [pos.rid, pos.lid, d.checkoutId])).rows[0]
  if (!row) return notFound('No se encuentra el cobro móvil en este local.')
  if (row.status !== 'pending') return { ok: true as const, status: 'already_final' as const }
  await pos.client.query(`UPDATE llenamos.pos_mobile_checkouts SET status='expired',needs_reconciliation=false,last_error=$4,updated_at=now() WHERE restaurant_id=$1 AND location_id=$2 AND id=$3`,
    [pos.rid, pos.lid, d.checkoutId, `Cancelado por el personal: ${d.reason}`.slice(0, 300)])
  // Si el cliente ya tenía una sesión en Stripe, el worker la caduca (si aun así llegara a pagar, queda como incidencia, nunca como cobro).
  if (row.stripe_session_id) await enqueueJob(pos.client, { id: stableUuid(EXPIRE_SESSION_JOB, pos.rid, d.checkoutId), restaurantId: pos.rid, kind: EXPIRE_SESSION_JOB, deduplicationKey: d.checkoutId, payload: { locationId: pos.lid, checkoutId: d.checkoutId } })
  await event(pos, 'caja.movil', d.checkoutId)
  return { ok: true as const, status: 'expired' as const }
}
export async function resolverIncidenciaMovil(pos: Pos, d: core.CallableParsedInput<'resolverIncidenciaMovil'>) {
  const done = await pos.client.query("UPDATE llenamos.pos_mobile_incidents SET status='resolved' WHERE restaurant_id=$1 AND location_id=$2 AND id=$3", [pos.rid, pos.lid, d.incidentId])
  if (!done.rowCount) return notFound('No se encuentra la incidencia en este local.')
  await event(pos, 'caja.movil', d.incidentId)
  return { ok: true as const }
}

// ---- Lecturas del ámbito público (solo SELECT sobre cuentas, partes, ajustes y caja) ----
const missing = () => fail('La cuenta ya no está disponible. Pide al personal un enlace nuevo.')
async function loadAccount(client: PoolClient, rid: string, lid: string, row: CheckoutRow) {
  const b = (await client.query<{ data: unknown }>('SELECT data FROM llenamos.pos_bills WHERE restaurant_id=$1 AND location_id=$2 AND id=$3', [rid, lid, row.bill_id])).rows[0]
  const p = (await client.query<{ data: unknown }>('SELECT data FROM llenamos.pos_bill_parts WHERE restaurant_id=$1 AND location_id=$2 AND id=$3', [rid, lid, row.part_id])).rows[0]
  if (!b || !p) return missing()
  const bill = core.BillSchema.parse(b.data), part = core.BillPartSchema.parse(p.data)
  if (part.billId !== row.bill_id || bill.revision !== row.revision || part.revision !== row.revision) fail('La cuenta ha cambiado. Solicita un enlace actualizado.')
  return { bill, part }
}
const mobileEnabled = async (client: PoolClient, tenant: Tenant, lid: string) => {
  const s = (await client.query<{ settings: { mobilePayments?: boolean } }>('SELECT settings FROM llenamos.pos_settings WHERE restaurant_id=$1 AND location_id=$2', [tenant.rid, lid])).rows[0]
  return s?.settings.mobilePayments === true && tenant.stripe
}
const lockRow = async (client: PoolClient, tenant: Tenant, lid: string, id: string, forUpdate = false) =>
  (await client.query<CheckoutRow>(`SELECT * FROM llenamos.pos_mobile_checkouts WHERE restaurant_id=$1 AND location_id=$2 AND id=$3${forUpdate ? ' FOR UPDATE' : ''}`, [tenant.rid, lid, id])).rows[0]

// ---- verCobroPublico ----
export async function verCobroPublico(context: PublicContext, d: core.CallableParsedInput<'verCobroPublico'>) {
  const { tenant, ip } = await openPublic(context, d.slug, d.locationId, d.checkoutId)
  const out = await withPublicScope(context.pool, tenant.rid, async client => {
    const row = await lockRow(client, tenant, d.locationId, d.checkoutId)
    if (!row || !tokenMatches(row.token_hash, d.token)) return null
    const { bill, part } = await loadAccount(client, tenant.rid, d.locationId, row)
    const header = (await client.query<{ h: { restaurantName: string; locationName: string; brandColor: string } }>('SELECT llenamos.payments_public_header($1,$2) AS h', [tenant.rid, d.locationId])).rows[0]!.h
    const now = Date.now(), expired = row.expires_at.getTime() <= now
    const status = row.status === 'pending' && expired && !row.stripe_session_id && !row.start_request ? 'expired' : row.status
    return core.VerCobroPublicoVpsOutputSchema.parse({
      restaurantName: header.restaurantName, locationName: header.locationName, label: part.label,
      lines: part.allocations.map(a => ({ name: bill.lines.find(l => l.lineId === a.lineId)?.name ?? 'Consumo', amountCents: a.amountCents })),
      amountCents: Math.max(0, part.totalCents - part.paidCents), expiresAt: row.expires_at.getTime(), status,
      brandColor: header.brandColor, paymentsEnabled: await mobileEnabled(client, tenant, d.locationId), tipCents: row.tip_cents,
      paidCents: row.status === 'paid' ? row.amount_cents : 0, receiptPath: row.receipt_path && row.status === 'paid' ? openSecret(tenant.rid, row.receipt_path) : null,
      invoicePending: row.status === 'paid' && row.invoice_state !== 'done', delivery: row.delivery,
      paymentInProgress: row.status === 'pending' && !!row.start_request, checkoutUrl: row.status === 'pending' && (row.stripe_session_id ? (row.stripe_expires_at?.getTime() ?? 0) > now : !expired) ? row.stripe_url : null,
    })
  })
  return out ?? rejectLink(context, tenant, ip, d.checkoutId)
}

// ---- iniciarPagoCuenta ----
export async function iniciarPagoCuenta(context: PublicContext, d: z.output<typeof core.IniciarPagoCuentaVpsInputSchema>) {
  const { tenant, ip } = await openPublic(context, d.slug, d.locationId, d.checkoutId)
  const unavailable = { status: 'not_configured' as const, message: 'Los pagos móviles no están configurados. No se ha cobrado nada. Pide al personal que te cobre.' }
  const fingerprint = sha(d)
  // Fase 1 (una transacción): valida el enlace y la cuenta, reserva el saldo de la parte y fija el intento. Solo entonces se abre la clave.
  const prepared = await withPublicScope(context.pool, tenant.rid, async client => {
    const row = await lockRow(client, tenant, d.locationId, d.checkoutId, true)
    if (!row || !tokenMatches(row.token_hash, d.token)) return null
    if (!(await mobileEnabled(client, tenant, d.locationId))) return { unavailable: true as const }
    if (row.status !== 'pending' || row.expires_at.getTime() <= Date.now()) fail('Este enlace no admite nuevos pagos.')
    if (d.email && !d.acceptDigitalReceipt) fail('Para enviar el recibo por correo hace falta tu consentimiento.')
    if (row.start_fingerprint && row.start_fingerprint !== fingerprint) fail('Hay un intento de pago en curso. Recupera ese intento o pide al personal un enlace nuevo.')
    const { part } = await loadAccount(client, tenant.rid, d.locationId, row)
    const amount = part.totalCents - part.paidCents
    if (amount <= 0) fail('Esta parte ya está pagada.')
    if (!d.recipient && part.totalCents > 300_000) fail('Esta parte requiere los datos del destinatario para una factura completa.')
    if (amount !== row.amount_cents) fail('El saldo de la parte ha cambiado. Pide un enlace nuevo.')
    if (!Number.isSafeInteger(amount + d.tipCents) || amount + d.tipCents > 99_999_999) fail('El importe es demasiado alto para este medio de pago.')
    const cash = (await client.query<{ status: string }>('SELECT status FROM llenamos.pos_cash_sessions WHERE restaurant_id=$1 AND location_id=$2 AND id=$3', [tenant.rid, d.locationId, row.cash_session_id])).rows[0]
    if (cash?.status !== 'open') fail('La caja ya está cerrada.')
    if (row.stripe_url) return { url: row.stripe_url }
    const credentials = await openStripeCredentials(client, tenant.rid)
    if (!credentials) return { unavailable: true as const }
    const header = (await client.query<{ h: { restaurantName: string; locationName: string } }>('SELECT llenamos.payments_public_header($1,$2) AS h', [tenant.rid, d.locationId])).rows[0]!.h
    const startedAt = row.started_at ?? new Date()
    const name = row.stripe_name ?? `${header.restaurantName} · ${header.locationName}`.slice(0, 200), origin = row.stripe_origin ?? appOrigin()
    try {
      await client.query(`UPDATE llenamos.pos_mobile_checkouts SET start_request=coalesce(start_request,$4),start_fingerprint=$5,started_at=$6,recipient=$7,email=$8,accept_digital_receipt=$9,
        consent_at=CASE WHEN $9 THEN coalesce(consent_at,$6) ELSE NULL END,language=$10,tip_cents=$11,stripe_name=$12,stripe_origin=$13,stripe_account=$14,livemode=$15,
        invoice_state='none',needs_reconciliation=true,updated_at=now() WHERE restaurant_id=$1 AND location_id=$2 AND id=$3`,
      [tenant.rid, d.locationId, d.checkoutId, d.requestId, fingerprint, startedAt, d.recipient, d.email, d.acceptDigitalReceipt, d.language, d.tipCents, name, origin, credentials.accountId ?? null, isLiveKey(credentials.secretKey)])
    } catch (error) {
      // Índice único del intento vivo por parte: otra persona ya está pagando esta parte.
      if ((error as { code?: string }).code === '23505') fail('Otra persona está pagando esta parte. Espera a que termine.')
      throw error
    }
    await emitEvent(client, { restaurantId: tenant.rid, locationId: d.locationId, topic: 'caja.movil', entityId: d.checkoutId })
    return { credentials, row, name, origin, startedAt, amount, livemode: isLiveKey(credentials.secretKey) }
  })
  if (!prepared) return rejectLink(context, tenant, ip, d.checkoutId)
  if ('unavailable' in prepared) return unavailable
  if ('url' in prepared) return { status: 'ready' as const, url: prepared.url! }
  // Fase 2: la sesión de Checkout con la clave del restaurante. Un corte aquí deja el intento reservado; se recupera con la misma clave.
  let session
  try {
    session = await stripeCheckout(prepared.credentials).create(sessionRequest(tenant.rid, d.locationId, d.checkoutId, d.requestId, {
      amount: prepared.amount, tip: d.tipCents, name: prepared.name, origin: prepared.origin, startedAt: prepared.startedAt.getTime(), language: d.language }))
  } catch (error) {
    // Rechazo definitivo de Stripe (clave inválida, cuenta sin activar…): no hay sesión, se libera la parte en vez de bloquearla.
    if (error instanceof StripeRejected) await withPublicScope(context.pool, tenant.rid, c => releaseRejected(c, tenant.rid, d.locationId, d.checkoutId, fingerprint))
    throw error
  }
  const url = verifySession(session, tenant.rid, d.locationId, d.checkoutId, prepared.amount, d.tipCents, prepared.livemode)
  // Fase 3: se guarda la sesión. Solo si el intento sigue siendo este.
  await withPublicScope(context.pool, tenant.rid, async client => {
    const row = await lockRow(client, tenant, d.locationId, d.checkoutId, true)
    if (!row || row.start_fingerprint !== fingerprint) fail('El intento de pago ha cambiado.')
    if (row.stripe_session_id && row.stripe_session_id !== session.id) fail('Stripe ha devuelto otra sesión de pago.')
    await client.query('UPDATE llenamos.pos_mobile_checkouts SET stripe_session_id=$4,stripe_url=$5,stripe_expires_at=$6,updated_at=now() WHERE restaurant_id=$1 AND location_id=$2 AND id=$3',
      [tenant.rid, d.locationId, d.checkoutId, session.id, url, new Date(session.expires_at * 1000)])
  })
  return { status: 'ready' as const, url }
}

export async function releaseRejected(client: PoolClient, rid: string, lid: string, id: string, fingerprint: string) {
  await client.query(`UPDATE llenamos.pos_mobile_checkouts SET status='failed',needs_reconciliation=false,last_error='Stripe rechazó el pago: revisa la configuración de Stripe del restaurante.',updated_at=now()
    WHERE restaurant_id=$1 AND location_id=$2 AND id=$3 AND status='pending' AND stripe_session_id IS NULL AND start_fingerprint=$4`, [rid, lid, id, fingerprint])
  await emitEvent(client, { restaurantId: rid, locationId: lid, topic: 'caja.movil', entityId: id })
}

/** Parámetros de la sesión; los usa el inicio del pago y la recuperación del worker, con la misma clave de idempotencia. */
export function sessionRequest(rid: string, lid: string, checkoutId: string, startRequest: string, v: { amount: number; tip: number; name: string; origin: string; startedAt: number; language: string }) {
  const back = `${v.origin}/p/volver?checkout=${encodeURIComponent(checkoutId)}`
  return {
    lines: [{ name: v.name, amountCents: v.amount }, ...(v.tip ? [{ name: 'Propina voluntaria', amountCents: v.tip }] : [])],
    metadata: { restaurantId: rid, locationId: lid, checkoutId, tipCents: String(v.tip), amountCents: String(v.amount) },
    successUrl: back, cancelUrl: `${back}&cancelled=1`, expiresAt: Math.floor(v.startedAt / 1000) + STRIPE_SESSION_SECONDS, language: v.language,
    idempotencyKey: `mobile_${createHash('sha256').update([rid, lid, checkoutId, startRequest].join('\u0000')).digest('hex')}`,
  }
}
export function verifySession(session: { id: string; url?: string | null; amount_total: number | null; currency: string | null; livemode: boolean; metadata: Record<string, string> }, rid: string, lid: string, checkoutId: string, amount: number, tip: number, livemode: boolean) {
  if (session.metadata.checkoutId !== checkoutId || session.metadata.restaurantId !== rid || session.metadata.locationId !== lid || session.amount_total !== amount + tip || session.currency !== 'eur' || session.livemode !== livemode || !session.url)
    throw new ApiError(502, 'unavailable', 'La respuesta de Stripe no coincide con este intento. El saldo sigue reservado para revisión.')
  return checkoutUrl(session.url)
}

// ---- Pago desde el QR de la mesa ----
type TableInput = z.output<typeof core.PartesPagoMesaInputSchema>
async function tableBill(client: PoolClient, tenant: Tenant, d: { slug: string; locationId: string; tableId: string; token: string }) {
  // Abre además el ámbito de sala de ese local: solo lee el hash del enlace de mesa y las sesiones.
  await client.query('SELECT llenamos.sala_public_scope($1,$2)', [d.slug, d.locationId])
  const credential = (await client.query<{ doc: { tokenHash?: string } }>("SELECT doc FROM llenamos.sala_private WHERE restaurant_id=$1 AND location_id=$2 AND kind='tableTokens' AND id=$3", [tenant.rid, d.locationId, d.tableId])).rows[0]
  if (!credential || !tokenMatches(credential.doc.tokenHash, d.token)) return null
  const table = (await client.query<{ data: { enabled?: boolean } }>('SELECT data FROM llenamos.dining_tables WHERE restaurant_id=$1 AND location_id=$2 AND id=$3', [tenant.rid, d.locationId, d.tableId])).rows[0]
  if (table?.data.enabled !== true) fail('Esta mesa no está disponible.')
  const sessions = (await client.query<{ id: string; status: string }>("SELECT id,status FROM llenamos.sala_table_sessions WHERE restaurant_id=$1 AND location_id=$2 AND status IN ('open','bill_requested') AND doc->'tableIds' ? $3", [tenant.rid, d.locationId, d.tableId])).rows
    .filter(s => core.sessionIsOpen(s.status as 'open'))
  if (sessions.length !== 1) fail('Pide al personal que prepare tu cuenta.')
  const b = (await client.query<{ id: string; data: unknown }>("SELECT id,data FROM llenamos.pos_bills WHERE restaurant_id=$1 AND location_id=$2 AND target_kind='session' AND target_id=$3", [tenant.rid, d.locationId, sessions[0]!.id])).rows[0]
  const bill = b ? core.BillSchema.parse(b.data) : null
  if (!b || !bill || bill.status !== 'locked' || bill.target.kind !== 'session' || bill.target.id !== sessions[0]!.id) fail('Pide al personal que prepare tu cuenta.')
  return { billId: b!.id, bill: bill! }
}
/** El QR solo descubre partes ya preparadas; nunca entrega recibos ni enlaces previos. */
export async function verPartesPagoMesa(context: PublicContext, d: TableInput) {
  const { tenant, ip } = await openPublic(context, d.slug, d.locationId, d.tableId)
  const out = await withPublicScope(context.pool, tenant.rid, async client => {
    const found = await tableBill(client, tenant, d)
    if (!found) return null
    const header = (await client.query<{ h: { restaurantName: string; locationName: string; brandColor: string } }>('SELECT llenamos.payments_public_header($1,$2) AS h', [tenant.rid, d.locationId])).rows[0]!.h
    const parts = (await client.query<{ id: string; data: unknown }>('SELECT id,data FROM llenamos.pos_bill_parts WHERE restaurant_id=$1 AND location_id=$2 AND bill_id=$3 ORDER BY id', [tenant.rid, d.locationId, found.billId])).rows
    return core.VerPartesPagoMesaOutputSchema.parse({ ...header, billId: found.billId, revision: found.bill.revision, totalCents: found.bill.totalCents,
      parts: parts.map(p => { const part = core.BillPartSchema.parse(p.data); return { id: p.id, label: part.label, amountCents: Math.max(0, part.totalCents - part.paidCents) } }) })
  })
  return out ?? rejectLink(context, tenant, ip, d.tableId)
}
/** Crea el cobro de una parte desde el QR. Repetir la misma solicitud rota el secreto del mismo cobro, sin abrir otro. */
export async function elegirPartePagoMesa(context: PublicContext, d: z.output<typeof core.ElegirPartePagoMesaInputSchema>) {
  const { tenant, ip } = await openPublic(context, d.slug, d.locationId, d.tableId)
  const out = await withPublicScope(context.pool, tenant.rid, async client => {
    const found = await tableBill(client, tenant, d)
    if (!found) return null
    if (found.billId !== d.billId || found.bill.revision !== d.expectedRevision) fail('La cuenta ha cambiado. Vuelve a consultar las partes.')
    const p = (await client.query<{ data: unknown }>('SELECT data FROM llenamos.pos_bill_parts WHERE restaurant_id=$1 AND location_id=$2 AND id=$3 AND bill_id=$4', [tenant.rid, d.locationId, d.partId, d.billId])).rows[0]
    if (!p) return fail('La parte no pertenece a esta cuenta.')
    const part = core.BillPartSchema.parse(p.data)
    if (part.revision !== d.expectedRevision) fail('La cuenta ha cambiado. Vuelve a consultar las partes.')
    const amount = part.totalCents - part.paidCents
    if (amount <= 0) fail('Esta parte ya está pagada.')
    const cash = await singleOpenCash(client, tenant.rid, d.locationId)
    const actor = core.sha256Hex(d.token), linkRequest = sha(['link', actor, d.requestId, d.partId])
    return rotateOrInsert(client, { rid: tenant.rid, lid: d.locationId, billId: d.billId, partId: d.partId, revision: d.expectedRevision, amount, cashSessionId: cash, slug: tenant.slug, createdBy: actor, linkRequest })
  })
  return out ?? rejectLink(context, tenant, ip, d.tableId)
}

/** Operaciones públicas del cobro móvil. Cada una valida la credencial del enlace antes de abrir nada más. */
export const publicOperations: [string, Operation][] = [
  ['verCobroPublico', { access: 'public', input: core.CALLABLE_SCHEMAS_FASE3.verCobroPublico.input, output: core.VerCobroPublicoVpsOutputSchema, runPublic: (input, context) => verCobroPublico(context, input as never) }],
  ['iniciarPagoCuenta', { access: 'public', input: core.IniciarPagoCuentaVpsInputSchema, output: core.IniciarPagoCuentaOutputSchema, runPublic: (input, context) => iniciarPagoCuenta(context, input as never) }],
  ['verPartesPagoMesa', { access: 'public', input: core.PartesPagoMesaInputSchema, output: core.VerPartesPagoMesaOutputSchema, runPublic: (input, context) => verPartesPagoMesa(context, input as never) }],
  ['elegirPartePagoMesa', { access: 'public', input: core.ElegirPartePagoMesaInputSchema, output: core.ElegirPartePagoMesaOutputSchema, runPublic: (input, context) => elegirPartePagoMesa(context, input as never) }],
]
