import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { ApiError } from '../../errors.js'

/**
 * Custodia de los secretos de sala (enlace de mesa, seguimiento de recogida, claves push): AES-256-GCM
 * con una clave derivada de `SALA_SECRET_KEY_FILE` (hexadecimal de 32 bytes), ligada al restaurante.
 * Sin clave, las operaciones que necesitan guardar o recuperar un secreto fallan con su código.
 */
function key(): Buffer {
  const file = process.env.SALA_SECRET_KEY_FILE, inline = process.env.SALA_SECRET_KEY
  const hex = (file ? readFileSync(file, 'utf8') : inline ?? '').trim()
  if (!/^[a-f0-9]{64}$/.test(hex)) throw new ApiError(503, 'failed-precondition', 'Falta la clave de custodia de los enlaces de sala (SALA_SECRET_KEY_FILE).')
  return createHmac('sha256', Buffer.from(hex, 'hex')).update('llenamos-sala:v1').digest()
}
const aad = (rid: string) => Buffer.from(`llenamos:sala_private:v1:${rid}`)
export function seal(rid: string, value: string): string {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key(), iv)
  cipher.setAAD(aad(rid))
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return `v1.${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url')}`
}
export function open(rid: string, sealed: string): string {
  const current = key()
  try {
    if (!sealed.startsWith('v1.')) throw new Error()
    const bytes = Buffer.from(sealed.slice(3), 'base64url')
    const decipher = createDecipheriv('aes-256-gcm', current, bytes.subarray(0, 12))
    decipher.setAAD(aad(rid)); decipher.setAuthTag(bytes.subarray(12, 28))
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8')
  } catch { throw new ApiError(503, 'unavailable', 'No se pudo abrir el secreto guardado.') }
}
