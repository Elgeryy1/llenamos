import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { HttpsError } from 'firebase-functions/v2/https'
import { canonicalJson } from '@llenamos/core'

/** La clave de desarrollo solo funciona en el proyecto de demostración y sus emuladores. */
function masterKey(): Buffer {
  const configured = process.env.PLATFORM_API_MASTER_KEY
  if (configured && /^[a-f0-9]{64}$/.test(configured)) return Buffer.from(configured, 'hex')
  if (process.env.FIRESTORE_EMULATOR_HOST && process.env.GCLOUD_PROJECT === 'demo-llenamos')
    return Buffer.from(createHmac('sha256', 'solo emuladores demo-llenamos').update('fase6-api').digest())
  throw new HttpsError('failed-precondition', 'La custodia de las integraciones no está configurada.')
}
function derive(purpose: string) { return createHmac('sha256', masterKey()).update(purpose).digest() }
export function seal(value: unknown, context: string): string {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', derive('secrets:v1'), iv)
  cipher.setAAD(Buffer.from(context))
  const body = Buffer.concat([cipher.update(canonicalJson(value), 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url')
}
export function unseal<T>(value: string, context: string): T {
  const b = Buffer.from(value, 'base64url'), cipher = createDecipheriv('aes-256-gcm', derive('secrets:v1'), b.subarray(0, 12))
  cipher.setAAD(Buffer.from(context)); cipher.setAuthTag(b.subarray(12, 28))
  return JSON.parse(Buffer.concat([cipher.update(b.subarray(28)), cipher.final()]).toString('utf8')) as T
}
export function encodeCursor(binding: unknown, after: unknown, now = Date.now()): string {
  const body = Buffer.from(canonicalJson({ binding, after, expiresAt: now + 3_600_000 })).toString('base64url')
  return `${body}.${createHmac('sha256', derive('cursors:v1')).update(body).digest('hex')}`
}
export function decodeCursor<T>(cursor: string | null, binding: unknown, now = Date.now()): T | null {
  if (!cursor) return null
  try {
    const [body, sig, extra] = cursor.split('.')
    const expected = createHmac('sha256', derive('cursors:v1')).update(body!).digest()
    if (extra || !sig || !/^[a-f0-9]{64}$/.test(sig) || !timingSafeEqual(Buffer.from(sig, 'hex'), expected)) throw new Error()
    const decoded = JSON.parse(Buffer.from(body!, 'base64url').toString('utf8'))
    if (decoded.expiresAt <= now || canonicalJson(decoded.binding) !== canonicalJson(binding)) throw new Error()
    return decoded.after as T
  } catch { throw new HttpsError('invalid-argument', 'El cursor ha caducado o no corresponde a esta consulta.') }
}
