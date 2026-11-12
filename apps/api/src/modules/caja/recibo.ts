import { createHash, randomBytes } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import * as core from '@llenamos/core'
import { ApiError } from '../../errors.js'
import { stableUuid } from '../../ids.js'
import { enqueueMessage } from '../../worker/messages.js'
import { appOrigin } from '../reservas/notices.js'
import { assertBelow, guardBeforeResolve, hit, ipKey } from '../reservas/abuse.js'
import { resolvePublicTenant, withPublicScope } from '../reservas/scope.js'
import { type Pos, fail } from './pos.js'
import { limits, tokenMatches } from './enlace.js'

const hash = (...parts: string[]) => createHash('sha256').update(parts.join('\u0000')).digest('hex')
const RECEIPT_LIFETIME_MS = 30 * 86_400_000

export interface ReceiptRequest { invoiceId: string; requestId: string; email: string | null; acceptDigitalReceipt: boolean; language?: core.Language }
/**
 * Crea el enlace del recibo de una factura ya emitida y, con consentimiento y correo, encola su envío. No emite ni toca
 * facturas. El aviso lleva un ID estable (factura, correo y solicitud): repetirlo no envía otro correo.
 */
export async function createReceipt(client: PoolClient, rid: string, lid: string, d: ReceiptRequest) {
  if (d.email && !d.acceptDigitalReceipt) fail('No se envía correo sin consentimiento.')
  const origin = appOrigin()
  const row = (await client.query<{ data: unknown; slug: string; name: string }>(
    `SELECT i.data,r.slug,r.name FROM llenamos.pos_invoices i JOIN llenamos.restaurants r ON r.id=i.restaurant_id WHERE i.restaurant_id=$1 AND i.location_id=$2 AND i.id=$3`, [rid, lid, d.invoiceId])).rows[0]
  if (!row) fail('La factura todavía no está disponible.')
  const invoice = core.InvoiceSchema.parse(row.data)
  const id = hash('receipt', d.invoiceId, d.requestId), secret = core.linkToken(randomBytes(32)), expiresAt = Date.now() + RECEIPT_LIFETIME_MS
  const path = `/recibo/${row.slug}/${lid}/${id}?t=${secret}`
  // Repetir la solicitud no duplica el recibo ni el correo: se rota el secreto del mismo recibo (el anterior deja de valer).
  const old = (await client.query<{ delivery: string }>('SELECT delivery FROM llenamos.pos_digital_receipts WHERE restaurant_id=$1 AND location_id=$2 AND id=$3 FOR UPDATE', [rid, lid, id])).rows[0]
  if (old) {
    await client.query('UPDATE llenamos.pos_digital_receipts SET token_hash=$4,expires_at=$5 WHERE restaurant_id=$1 AND location_id=$2 AND id=$3', [rid, lid, id, core.sha256Hex(secret), new Date(expiresAt)])
    return { receiptId: id, token: secret, path, delivery: old.delivery as 'none' }
  }
  const delivery = d.acceptDigitalReceipt && d.email ? 'queued' as const : 'none' as const
  const messageId = delivery === 'queued' ? stableUuid('digital_receipt', rid, d.invoiceId, d.email!, d.requestId) : null
  if (messageId) await enqueueMessage(client, rid, messageId, { channel: 'email', to: d.email!, template: 'digital_receipt', language: d.language ?? 'es',
    data: { restaurantName: row.name, reference: invoice.number, totalCents: invoice.totalCents, manageUrl: origin + path }, reservationId: null, waitlistId: null, sendAt: Date.now() })
  await client.query(`INSERT INTO llenamos.pos_digital_receipts(restaurant_id,location_id,id,invoice_id,token_hash,expires_at,email,consent_at,accepted_digital,delivery,message_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [rid, lid, id, d.invoiceId, core.sha256Hex(secret), new Date(expiresAt), d.acceptDigitalReceipt ? d.email : null,
    d.acceptDigitalReceipt ? new Date() : null, d.acceptDigitalReceipt, delivery, messageId])
  return { receiptId: id, token: secret, path, delivery }
}

/** Operación del personal `crearReciboDigital`. */
export async function crearReciboDigital(pos: Pos, d: core.CallableParsedInput<'crearReciboDigital'>) {
  return createReceipt(pos.client, pos.rid, pos.lid, d)
}

/** `verReciboDigital`: pública con el secreto del recibo. Solo expone la factura sin identificadores internos. */
export async function verReciboDigital(pool: Pool, ip: string | null, d: core.CallableParsedInput<'verReciboDigital'>) {
  guardBeforeResolve(ip)
  const tenant = await resolvePublicTenant(pool, d.slug, d.locationId)
  if (!core.hasModule(tenant.restaurant, 'pos')) fail('El servicio de caja no está disponible.')
  const key = ipKey(ip)
  await hit(pool, tenant.rid, 'cobro-ip', key, limits.ipRestaurant)
  await assertBelow(pool, tenant.rid, 'cobro-fail-ip', key, limits.failedIp)
  await assertBelow(pool, tenant.rid, 'cobro-fail-ref', d.receiptId, limits.failedReference)
  const found = await withPublicScope(pool, tenant.rid, async client => {
    const receipt = (await client.query<{ invoice_id: string; token_hash: string; expires_at: Date; delivery: string; accepted_digital: boolean }>(
      'SELECT invoice_id,token_hash,expires_at,delivery,accepted_digital FROM llenamos.pos_digital_receipts WHERE restaurant_id=$1 AND location_id=$2 AND id=$3', [tenant.rid, d.locationId, d.receiptId])).rows[0]
    if (!receipt || !tokenMatches(receipt.token_hash, d.token)) return null
    if (receipt.expires_at.getTime() <= Date.now()) fail('Este recibo ha caducado. Pide al restaurante otro enlace.')
    const inv = (await client.query<{ data: unknown; record_id: string | null }>('SELECT data,record_id FROM llenamos.pos_invoices WHERE restaurant_id=$1 AND location_id=$2 AND id=$3', [tenant.rid, d.locationId, receipt.invoice_id])).rows[0]
    if (!inv) fail('La factura todavía no está disponible.')
    const record = inv!.record_id ? (await client.query<{ data: Record<string, unknown> }>('SELECT data FROM llenamos.pos_fiscal_records WHERE restaurant_id=$1 AND id=$2', [tenant.rid, inv!.record_id])).rows[0]?.data : null
    const header = (await client.query<{ h: { restaurantName: string; locationName: string; brandColor: string } }>('SELECT llenamos.payments_public_header($1,$2) AS h', [tenant.rid, d.locationId])).rows[0]!.h
    return { receipt, invoice: inv!.data, record: record ?? {}, header }
  })
  if (!found) {
    await hit(pool, tenant.rid, 'cobro-fail-ip', key, limits.failedIp)
    await hit(pool, tenant.rid, 'cobro-fail-ref', d.receiptId, limits.failedReference)
    throw new ApiError(403, 'permission-denied', 'El enlace no es válido o ha caducado.')
  }
  const artifact = found.record as { qrUrl?: string; legend?: string; validForTaxAuthority?: boolean; warning?: string }
  const result = core.VerReciboDigitalOutputSchema.parse({ invoice: found.invoice, qrUrl: artifact.qrUrl ?? null, legend: artifact.legend ?? null,
    warning: artifact.validForTaxAuthority === true ? artifact.warning ?? null : 'Proveedor de prueba: no válido para Hacienda.' })
  return { ...result, restaurantName: found.header.restaurantName, locationName: found.header.locationName, brandColor: found.header.brandColor,
    delivery: found.receipt.delivery as 'none', acceptedDigital: found.receipt.accepted_digital }
}
