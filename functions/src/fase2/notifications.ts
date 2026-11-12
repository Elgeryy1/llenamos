import { Timestamp } from 'firebase-admin/firestore'
import * as core from '@llenamos/core'
import type { Context, Row } from './context'
import { configuredAppOrigin } from '../public-app-url'

/** Outbox transaccional con una sola notificación por estado y canal. */
export function queueTakeawayNotifications(c: Context, t: Row<core.Takeaway>) {
  if (!['accepted', 'ready'].includes(t.status)) return
  const token = c.privateRows.takeawaySecrets.get(t.id)?.tokenSecret
  // Un pedido anterior sin secreto conserva su seguimiento original; no se rota en silencio.
  if (typeof token !== 'string' || core.sha256Hex(token) !== t.manageTokenHash) return
  const base = configuredAppOrigin()
  const templates = t.status === 'ready' ? ['takeaway_accepted', 'takeaway_ready'] as const : ['takeaway_accepted'] as const
  for (const template of templates) {
    const whatsappTemplate = template === 'takeaway_ready' ? c.providers.whatsappReady : c.providers.whatsappAccepted
    for (const channel of ['email', 'whatsapp'] as const) {
      const to = channel === 'email' ? t.email : t.phone
      if (!to || (channel === 'whatsapp' && !(c.providers.whatsapp && whatsappTemplate))) continue
      const id = `takeaway_${c.lid}_${t.id}_${template}_${channel}`
      if (c.messages.has(id)) continue
      const message = core.queuedMessage({ channel, to, template, language: t.language,
        takeawayId: t.id, reservationId: null, waitlistId: null, sendAt: c.now,
        data: { guestName: t.guestName, restaurantName: c.restaurant.name, locationName: c.location.name,
          address: String(c.location.address ?? ''), phone: String(c.location.phone ?? ''),
          startAt: t.pickupAt, timezone: c.reservationSettings.timezone, reference: t.reference,
          totalCents: t.totalCents, manageUrl: new URL(core.takeawayTrackPath(c.restaurant.slug, t.reference, token), base).href } })
      c.messages.set(id, message)
      c.stage(`${c.root.path}/messages/${id}`, core.messageForWrite(message, Timestamp.fromMillis), true)
    }
  }
}
