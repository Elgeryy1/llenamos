import { createHash } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import * as core from '@llenamos/core'
import { ApiError } from '../../errors.js'
import { emitEvent } from '../../events.js'
import { enqueueJob } from '../../jobs.js'
import { stableUuid } from '../../ids.js'
import { stripeFrom } from '../../payments/credentials.js'
import { StripeRejected, isLiveKey, stripeCheckout, type StripeSession } from '../../payments/stripe.js'
import { MAX_ATTEMPTS } from '../../worker/queue.js'
import { forEachRestaurant } from '../../worker/tasks.js'
import { withTenant } from '../../worker/tenant.js'
import type { MaintenanceTask } from '../../worker/maintenance.js'
import { Quarantine, RetryLater, type WorkerContext, type WorkerHandler } from '../../worker/types.js'
import { emitirFactura } from './fiscal.js'
import { type CheckoutRow, EXPIRE_SESSION_JOB, releaseRejected, sessionRequest, verifySession } from './movil.js'
import { seal } from '../sala/secrets.js'
import { applyCharge } from './payments.js'
import { getBill, openSystemPos } from './pos.js'
import { createReceipt } from './recibo.js'

const hash = (...parts: string[]) => createHash('sha256').update(parts.join('\u0000')).digest('hex')
export const RECONCILE_JOB = 'caja.reconciliar_cobro'
export { EXPIRE_SESSION_JOB }
/** Sin credenciales del restaurante no se puede consultar nada: pasada una hora el intento sale del flujo automático y queda a revisar. */
const NO_CREDENTIALS_MS = 3_600_000
const SUPPORTED = new Set(['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed', 'checkout.session.expired'])
/** Un pago confirmado por Stripe poco después de que la sesión de Stripe caducara aún cuenta (el evento puede llegar tarde). */
const LATE_GRACE_MS = 5 * 60_000
const ledgerCodes = new Set(['failed-precondition', 'permission-denied', 'already-exists', 'invalid-argument', 'not-found', 'not-configured'])

type Run = <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T>
type Outcome = 'done' | 'wait'
/** Errores de negocio (saldo, caja cerrada, fiscal sin configurar) frente a fallos de base de datos, que se reintentan. */
const isDomainError = (error: unknown) => error instanceof ApiError ? ledgerCodes.has(error.code) || error.status === 409
  : error instanceof Error && !('severity' in error) && !(error instanceof TypeError)

const lockRow = async (client: PoolClient, rid: string, lid: string, id: string) =>
  (await client.query<CheckoutRow>('SELECT * FROM llenamos.pos_mobile_checkouts WHERE restaurant_id=$1 AND location_id=$2 AND id=$3 FOR UPDATE', [rid, lid, id])).rows[0]

/** Anota la incidencia (una vez por cobro, código y operación del proveedor) y saca el cobro del flujo automático. */
async function incident(client: PoolClient, rid: string, lid: string, checkoutId: string, code: string, externalId: string) {
  await client.query("UPDATE llenamos.pos_mobile_checkouts SET status='reconciliation_required',needs_reconciliation=false,updated_at=now() WHERE restaurant_id=$1 AND location_id=$2 AND id=$3 AND status<>'paid'", [rid, lid, checkoutId])
  await client.query(`INSERT INTO llenamos.pos_mobile_incidents(restaurant_id,location_id,id,checkout_id,external_id,code,summary) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
    [rid, lid, hash(checkoutId, code, externalId), checkoutId, externalId, code, 'Revisar un pago móvil con el proveedor antes de liberar el saldo o devolverlo.'])
  await emitEvent(client, { restaurantId: rid, locationId: lid, topic: 'caja.movil', entityId: checkoutId })
}

interface Summary { id: string; status: 'open' | 'complete' | 'expired'; payment_status: string; amount_total: number | null; currency: string | null; livemode: boolean; metadata: Record<string, string> }

/**
 * Aplica lo que dice Stripe de una sesión (evento firmado o consulta directa) al cobro móvil. Idempotente: el cobro de caja
 * lleva como referencia externa el ID de la sesión (índice único) y el estado `paid` no vuelve a cobrarse.
 */
export async function applySession(run: Run, rid: string, lid: string, checkoutId: string, session: Summary, account: string | null, occurredAt: number | null): Promise<Outcome> {
  return run(async client => {
    const row = await lockRow(client, rid, lid, checkoutId)
    if (!row) {
      // Un local que no existe no admite incidencia (clave ajena): el evento se aparta para revisarlo, no falla en bucle.
      if (!(await client.query('SELECT 1 FROM llenamos.locations WHERE restaurant_id=$1 AND id=$2', [rid, lid])).rowCount) throw new Quarantine('cobro-movil-local-desconocido')
      await incident(client, rid, lid, checkoutId, 'unknown_checkout', session.id); return 'done'
    }
    // El evento puede adelantarse a la respuesta de creación: se espera a que la sesión quede guardada.
    if (!row.stripe_session_id && row.start_request) return 'wait'
    const meta = session.metadata
    const correct = row.stripe_session_id === session.id && (row.stripe_account ?? null) === (account ?? null) && meta.restaurantId === rid && meta.locationId === lid && meta.checkoutId === checkoutId
      && meta.amountCents === String(row.amount_cents) && meta.tipCents === String(row.tip_cents) && session.amount_total === row.amount_cents + row.tip_cents && session.currency === 'eur' && session.livemode === row.livemode
    if (!correct) { await incident(client, rid, lid, checkoutId, 'provider_mismatch', session.id); return 'done' }
    if (row.status === 'paid') return 'done'
    if (session.status === 'expired' && session.payment_status === 'unpaid') {
      if (row.status === 'pending') {
        await client.query("UPDATE llenamos.pos_mobile_checkouts SET status='expired',needs_reconciliation=false,updated_at=now() WHERE restaurant_id=$1 AND location_id=$2 AND id=$3", [rid, lid, checkoutId])
        await emitEvent(client, { restaurantId: rid, locationId: lid, topic: 'caja.movil', entityId: checkoutId })
      }
      return 'done'
    }
    if (session.payment_status === 'failed') {
      // Pago diferido rechazado: la sesión no se completará, la parte se libera.
      if (row.status === 'pending') {
        await client.query("UPDATE llenamos.pos_mobile_checkouts SET status='failed',needs_reconciliation=false,updated_at=now() WHERE restaurant_id=$1 AND location_id=$2 AND id=$3", [rid, lid, checkoutId])
        await emitEvent(client, { restaurantId: rid, locationId: lid, topic: 'caja.movil', entityId: checkoutId })
      }
      return 'done'
    }
    if (session.status !== 'complete' || session.payment_status !== 'paid') return 'done'
    // El plazo solo se aplica a la hora que dice el evento firmado; una consulta posterior no sabe cuándo se pagó.
    const deadline = (row.stripe_expires_at ?? row.expires_at).getTime() + LATE_GRACE_MS
    if (row.status !== 'pending' || (occurredAt !== null && occurredAt > deadline)) { await incident(client, rid, lid, checkoutId, 'late_payment', session.id); return 'done' }
    await client.query('SAVEPOINT confirm')
    try {
      const pos = await openSystemPos(client, 'stripe', { restaurantId: rid, locationId: lid })
      const known = (await client.query<{ id: string }>("SELECT id FROM llenamos.pos_payments WHERE restaurant_id=$1 AND method='stripe' AND external_id=$2 AND kind='charge' AND status='succeeded'", [rid, session.id])).rows[0]
      const paymentId = known?.id ?? (await applyCharge(pos, { billId: row.bill_id, partId: row.part_id, cashSessionId: row.cash_session_id, expectedRevision: row.revision, amountCents: row.amount_cents,
        tipCents: row.tip_cents, requestId: `mobile_${hash(checkoutId, session.id)}`.slice(0, 64) }, 'stripe', session.id, 0, checkoutId)).paymentId
      await client.query('RELEASE SAVEPOINT confirm')
      await client.query("UPDATE llenamos.pos_mobile_checkouts SET status='paid',payment_id=$4,paid_at=$5,invoice_state='pending',needs_reconciliation=true,last_error=NULL,updated_at=now() WHERE restaurant_id=$1 AND location_id=$2 AND id=$3",
        [rid, lid, checkoutId, paymentId, new Date(occurredAt ?? Date.now())])
      await emitEvent(client, { restaurantId: rid, locationId: lid, topic: 'caja.movil', entityId: checkoutId })
      return 'done'
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT confirm')
      if (!isDomainError(error)) throw error
      // Caja cerrada, cuenta cambiada, saldo ya cubierto…: el dinero está cobrado y no cuadra, lo revisa una persona.
      await incident(client, rid, lid, checkoutId, 'ledger_conflict', session.id)
      return 'done'
    }
  })
}

/**
 * Emite la factura simplificada (o completa si hay destinatario) de la parte pagada y crea el recibo digital. Sin proveedor
 * fiscal configurado la factura no se inventa: el cobro queda confirmado y la factura pendiente de emitir a mano.
 */
export async function finishInvoice(run: Run, rid: string, lid: string, checkoutId: string) {
  await run(async client => {
    const row = await lockRow(client, rid, lid, checkoutId)
    if (!row || row.status !== 'paid' || row.invoice_state === 'done') return
    const pos = await openSystemPos(client, 'stripe', { restaurantId: rid, locationId: lid })
    let invoiceId = row.invoice_id
    if (!invoiceId) {
      const bill = await getBill(pos, row.bill_id)
      await client.query('SAVEPOINT invoice')
      try {
        const issued = await emitirFactura(pos, { restaurantId: rid, locationId: lid, billId: row.bill_id, partId: row.part_id, expectedRevision: bill.revision, requestId: `mi_${hash(checkoutId)}`.slice(0, 64),
          type: row.recipient ? 'F1' : 'F2', recipient: row.recipient ?? null, qualifiedSimplified: false } as never)
        invoiceId = issued.invoiceId
        await client.query('RELEASE SAVEPOINT invoice')
      } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT invoice')
        if (!isDomainError(error)) throw error
        await client.query("UPDATE llenamos.pos_mobile_checkouts SET invoice_state='not_configured',needs_reconciliation=false,last_error=$4,updated_at=now() WHERE restaurant_id=$1 AND location_id=$2 AND id=$3",
          [rid, lid, checkoutId, 'El cobro está confirmado. La factura no se ha emitido: revisa la configuración fiscal y emítela desde caja.'])
        return
      }
    }
    const receipt = await createReceipt(client, rid, lid, { invoiceId, requestId: `mr_${hash(checkoutId)}`.slice(0, 64), email: row.email, acceptDigitalReceipt: row.accept_digital_receipt, language: row.language })
    await client.query("UPDATE llenamos.pos_mobile_checkouts SET invoice_id=$4,invoice_state='done',receipt_id=$5,receipt_path=$6,delivery=$7,needs_reconciliation=$8,last_error=NULL,updated_at=now() WHERE restaurant_id=$1 AND location_id=$2 AND id=$3",
      [rid, lid, checkoutId, invoiceId, receipt.receiptId, seal(rid, receipt.path), receipt.delivery, receipt.delivery === 'queued'])
    await emitEvent(client, { restaurantId: rid, locationId: lid, topic: 'caja.movil', entityId: checkoutId })
  })
}

/** Copia al recibo y al cobro el resultado definitivo del correo (lo envía el worker de avisos). */
export async function syncReceiptDelivery(run: Run, rid: string, lid: string, checkoutId: string) {
  await run(async client => {
    const row = await lockRow(client, rid, lid, checkoutId)
    if (!row?.receipt_id) return
    const receipt = (await client.query<{ message_id: string | null }>('SELECT message_id FROM llenamos.pos_digital_receipts WHERE restaurant_id=$1 AND location_id=$2 AND id=$3', [rid, lid, row.receipt_id])).rows[0]
    if (!receipt?.message_id) return
    const status = (await client.query<{ status: string }>('SELECT status FROM llenamos.message_deliveries WHERE id=$1 AND restaurant_id=$2', [receipt.message_id, rid])).rows[0]?.status
    const delivery = status === 'sent' ? 'sent' : status === 'not_configured' ? 'not_configured' : status === 'failed' || status === 'cancelled' ? 'failed' : null
    if (!delivery) return
    await client.query('UPDATE llenamos.pos_digital_receipts SET delivery=$4 WHERE restaurant_id=$1 AND location_id=$2 AND id=$3', [rid, lid, row.receipt_id, delivery])
    await client.query('UPDATE llenamos.pos_mobile_checkouts SET delivery=$4,needs_reconciliation=false,updated_at=now() WHERE restaurant_id=$1 AND location_id=$2 AND id=$3', [rid, lid, checkoutId, delivery])
  })
}

/**
 * `webhook.stripe` de caja: el cobro móvil confirmado por el evento firmado con el secreto de ESE restaurante. Los eventos
 * sin `checkoutId` (la señal de reserva) los atiende otro módulo.
 */
export const stripeCashHandler: WorkerHandler = async ctx => {
  const event = ctx.item.payload as { type?: string; created?: number | null; livemode?: boolean; account?: string | null;
    object?: { id?: unknown; payment_status?: unknown; amount_total?: unknown; currency?: unknown; metadata?: Record<string, unknown> } }
  const object = event.object, meta = object?.metadata
  if (typeof meta?.checkoutId !== 'string' || !event.type || !SUPPORTED.has(event.type)) return
  const rid = ctx.item.restaurantId
  if (meta.restaurantId !== rid || typeof meta.locationId !== 'string') throw new Quarantine('cobro-movil-otro-restaurante')
  if (typeof object?.id !== 'string' || typeof object.amount_total !== 'number' || typeof object.currency !== 'string') throw new Quarantine('cobro-movil-mal-formado')
  const strings = Object.fromEntries(Object.entries(meta).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  const session: Summary = { id: object.id, status: event.type === 'checkout.session.expired' ? 'expired' : 'complete',
    payment_status: event.type === 'checkout.session.async_payment_failed' ? 'failed' : typeof object.payment_status === 'string' ? object.payment_status : 'unpaid',
    amount_total: object.amount_total, currency: object.currency, livemode: event.livemode === true, metadata: strings }
  const occurredAt = (event.created ?? Math.floor(Date.now() / 1000)) * 1000
  const outcome = await applySession(ctx.tenant, rid, meta.locationId, meta.checkoutId, session, event.account ?? null, occurredAt)
  if (outcome === 'wait') {
    if (ctx.item.attempts >= MAX_ATTEMPTS) throw new Quarantine('cobro-movil-sin-sesion')
    throw new RetryLater(30, 'cobro-movil-sin-sesion')
  }
  await finishInvoice(ctx.tenant, rid, meta.locationId, meta.checkoutId)
}

/** Trabajo `caja.reconciliar_cobro`: recupera creaciones inciertas, consulta la sesión y termina facturas y recibos. */
export const reconcileHandler: WorkerHandler = async ctx => {
  const { locationId, checkoutId } = ctx.item.payload as { locationId?: unknown; checkoutId?: unknown }
  if (typeof locationId !== 'string' || typeof checkoutId !== 'string') return
  const rid = ctx.item.restaurantId
  let row = await ctx.tenant(client => client.query<CheckoutRow>('SELECT * FROM llenamos.pos_mobile_checkouts WHERE restaurant_id=$1 AND location_id=$2 AND id=$3', [rid, locationId, checkoutId]).then(r => r.rows[0]))
  if (!row || !row.needs_reconciliation) return
  if (row.status === 'paid') {
    if (row.invoice_state === 'pending') await finishInvoice(ctx.tenant, rid, locationId, checkoutId)
    await syncReceiptDelivery(ctx.tenant, rid, locationId, checkoutId)
    return
  }
  if (row.status !== 'pending') return
  if (!row.start_request) {
    if (row.expires_at.getTime() <= Date.now()) await ctx.tenant(c => c.query("UPDATE llenamos.pos_mobile_checkouts SET status='expired',needs_reconciliation=false,updated_at=now() WHERE restaurant_id=$1 AND location_id=$2 AND id=$3 AND start_request IS NULL AND status='pending'", [rid, locationId, checkoutId]))
    return
  }
  const credentials = stripeFrom((await ctx.credentials()).stripe)
  if (!credentials) {
    if (Date.now() - (row.started_at?.getTime() ?? 0) > NO_CREDENTIALS_MS) await ctx.tenant(c => incident(c, rid, locationId, checkoutId, 'sin_credenciales', row!.stripe_session_id ?? 'sin-sesion'))
    return
  }
  const stripe = stripeCheckout(credentials, ctx.fetch)
  if (!row.stripe_session_id) {
    // La clave de idempotencia de Stripe vive 24 h: pasado ese margen solo cabe la revisión manual, nunca otro POST.
    if (Date.now() - (row.started_at?.getTime() ?? 0) > 23 * 3_600_000) { await ctx.tenant(c => incident(c, rid, locationId, checkoutId, 'creation_unknown', 'unknown')); return }
    let created: StripeSession
    try { created = await stripe.create(sessionRequest(rid, locationId, checkoutId, row.start_request, { amount: row.amount_cents, tip: row.tip_cents, name: row.stripe_name ?? 'Cuenta', origin: row.stripe_origin ?? '', startedAt: row.started_at!.getTime(), language: row.language })) }
    catch (error) {
      // Rechazo definitivo: la sesión no existe y repetir no lo cambia. Se libera la parte.
      if (error instanceof StripeRejected) { await ctx.tenant(c => releaseRejected(c, rid, locationId, checkoutId, row!.start_fingerprint!)); return }
      throw error
    }
    let url: string
    try { url = verifySession(created, rid, locationId, checkoutId, row.amount_cents, row.tip_cents, isLiveKey(credentials.secretKey)) }
    catch { await ctx.tenant(c => incident(c, rid, locationId, checkoutId, 'provider_mismatch', created.id)); return }
    await ctx.tenant(c => c.query('UPDATE llenamos.pos_mobile_checkouts SET stripe_session_id=$4,stripe_url=$5,stripe_expires_at=$6,updated_at=now() WHERE restaurant_id=$1 AND location_id=$2 AND id=$3 AND stripe_session_id IS NULL',
      [rid, locationId, checkoutId, created.id, url, new Date(created.expires_at * 1000)]))
    row = { ...row, stripe_session_id: created.id }
  }
  const session: StripeSession = await stripe.retrieve(row.stripe_session_id!)
  const outcome = await applySession(ctx.tenant, rid, locationId, checkoutId, session, row.stripe_account, null)
  if (outcome === 'wait') return
  await finishInvoice(ctx.tenant, rid, locationId, checkoutId)
}

/** Cada 5 minutos deja un trabajo por cobro móvil pendiente de conciliar (ID por cobro y tramo de 5 minutos, sin duplicados). */
export function cajaMaintenance(pool: Pool, now: () => number = Date.now): MaintenanceTask[] {
  return [{ name: 'caja-cobros-moviles', everyMs: 300_000, run: () => forEachRestaurant(pool, rid => withTenant(pool, rid, async client => {
    const bucket = Math.floor(now() / 300_000)
    const { rows } = await client.query<{ id: string; location_id: string }>('SELECT id,location_id FROM llenamos.pos_mobile_checkouts WHERE restaurant_id=$1 AND needs_reconciliation AND updated_at<now()-interval \'20 seconds\' ORDER BY updated_at LIMIT 100', [rid])
    for (const row of rows) await enqueueJob(client, { id: stableUuid(RECONCILE_JOB, rid, row.id, String(bucket)), restaurantId: rid, kind: RECONCILE_JOB, deduplicationKey: `${row.id}:${bucket}`, payload: { locationId: row.location_id, checkoutId: row.id } })
    // Se toca la fila para que las atascadas no ocupen siempre las 100 primeras: la siguiente pasada sigue con las demás.
    if (rows.length) await client.query('UPDATE llenamos.pos_mobile_checkouts SET updated_at=now() WHERE restaurant_id=$1 AND id=ANY($2)', [rid, rows.map(r => r.id)])
    return rows.length
  })) }]
}
export type { WorkerContext }

/** `caja.expirar_sesion`: el personal canceló un intento con sesión en Stripe; se caduca allí para que no pueda pagarse. */
export const expireSessionHandler: WorkerHandler = async ctx => {
  const { locationId, checkoutId } = ctx.item.payload as { locationId?: unknown; checkoutId?: unknown }
  if (typeof locationId !== 'string' || typeof checkoutId !== 'string') return
  const rid = ctx.item.restaurantId
  const row = await ctx.tenant(client => client.query<CheckoutRow>('SELECT * FROM llenamos.pos_mobile_checkouts WHERE restaurant_id=$1 AND location_id=$2 AND id=$3', [rid, locationId, checkoutId]).then(r => r.rows[0]))
  if (!row?.stripe_session_id) return
  const credentials = stripeFrom((await ctx.credentials()).stripe)
  if (!credentials) return
  const stripe = stripeCheckout(credentials, ctx.fetch)
  const session = await stripe.retrieve(row.stripe_session_id)
  if (session.status === 'open') await stripe.expire(session.id, `expire_${hash(rid, checkoutId)}`)
}
