import { createHmac, timingSafeEqual } from 'node:crypto'
function equalHex(a: string, b: string) {
 return /^[a-f0-9]{64}$/i.test(a) && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
}
export function verifyWhatsApp(raw: Buffer, signature: string, secret: string) {
 return !!secret && signature.startsWith('sha256=') && equalHex(signature.slice(7), createHmac('sha256', secret).update(raw).digest('hex'))
}
export function verifyStripe(raw: Buffer, signature: string, secret: string, now = Date.now()) {
 const fields = signature.split(',').map(s => s.trim().split('='))
 const t = fields.find(f => f[0] === 't')?.[1]
 if (!secret || !t || !/^\d+$/.test(t) || Math.abs(now / 1000 - Number(t)) > 300) return false
 const hash = createHmac('sha256', secret).update(`${t}.`).update(raw).digest('hex')
 return fields.some(f => f[0] === 'v1' && equalHex(f[1] ?? '', hash))
}
