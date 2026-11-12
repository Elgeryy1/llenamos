import * as core from '@llenamos/core'
import { type Context, type Input, fail, denied } from './context.js'
import { vapidConfig, validSubscription } from './web-push.js'
import { seal } from './secrets.js'

export function configuracionPush(c: Context, _d: Input<'configuracionPush'>) {
  const config = vapidConfig()
  return { configured: !!config, publicKey: config?.publicKey ?? null, localCapture: process.env.SALA_PUSH_CAPTURE === '1',
    subscribedEndpoints: [...c.privateRows.pushSubscriptions.values()].filter(s => s.uid === c.uid && s.enabled && s.publicKey === config?.publicKey).map(s => String(s.endpoint)) }
}
export function guardarSuscripcionPush(c: Context, d: Input<'guardarSuscripcionPush'>) {
  const id = core.sha256Hex(d.subscription.endpoint)
  const previous = c.privateRows.pushSubscriptions.get(id)
  if (!d.enabled) {
    if (previous && previous.uid !== c.uid) denied()
    if (previous) c.secret('pushSubscriptions', id, { ...previous, enabled: false })
    return { ok: true }
  }
  const config = vapidConfig()
  if (!config) fail('Sin claves VAPID válidas no se activan ni envían avisos al móvil.')
  if (!validSubscription(d.subscription)) fail('La suscripción del navegador no es válida.')
  const own = [...c.privateRows.pushSubscriptions.values()].filter(s => s.uid === c.uid && s.enabled)
  if (own.length >= 10 && !(previous?.enabled && previous.uid === c.uid)) fail('Ya tienes diez dispositivos activos en este local. Desactiva uno antes.')
  c.secret('pushSubscriptions', id, { endpoint: d.subscription.endpoint, keysSealed: seal(c.rid, JSON.stringify(d.subscription.keys)), uid: c.uid, enabled: true, publicKey: config!.publicKey })
  return { ok: true }
}
