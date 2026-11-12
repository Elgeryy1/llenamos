import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto'

/** Las exportaciones se guardan cifradas (AES-256-GCM, clave derivada de la de custodia, AAD = restaurante + solicitud). */
function key(master: Buffer) { return Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), 'llenamos-privacy-export:v1', 32)) }
export function sealExport(master: Buffer, rid: string, requestId: string, plain: Buffer): Buffer {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key(master), iv)
  cipher.setAAD(Buffer.from(`${rid}:${requestId}`))
  const body = Buffer.concat([cipher.update(plain), cipher.final()])
  return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), body])
}
export function openExport(master: Buffer, rid: string, requestId: string, sealed: Buffer): Buffer {
  if (sealed.length < 29 || sealed[0] !== 1) throw new Error('formato')
  const decipher = createDecipheriv('aes-256-gcm', key(master), sealed.subarray(1, 13))
  decipher.setAAD(Buffer.from(`${rid}:${requestId}`)); decipher.setAuthTag(sealed.subarray(13, 29))
  return Buffer.concat([decipher.update(sealed.subarray(29)), decipher.final()])
}
export const subjectHash = (rid: string, subjectId: string) => createHash('sha256').update(`${rid}:${subjectId}`).digest('hex')
