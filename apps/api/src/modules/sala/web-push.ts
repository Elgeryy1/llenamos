import { readFileSync } from 'node:fs'
import { createCipheriv, createECDH, createPrivateKey, hkdfSync, randomBytes, sign } from 'node:crypto'

export interface PushSubscriptionData { endpoint: string; keys: { p256dh: string; auth: string } }
export interface VapidConfig { publicKey: string; privateKey: string; subject: string }

/** RFC 8292: par P-256 y contacto desde el entorno. La clave privada puede venir de un archivo de secreto (`VAPID_PRIVATE_KEY_FILE`). */
export function vapidConfig(env: NodeJS.ProcessEnv = process.env): VapidConfig | null {
  const { VAPID_PUBLIC_KEY: publicKey, VAPID_SUBJECT: subject } = env
  let privateKey = env.VAPID_PRIVATE_KEY
  if (env.VAPID_PRIVATE_KEY_FILE) {
    try { privateKey = readFileSync(env.VAPID_PRIVATE_KEY_FILE, 'utf8').trim() } catch { return null }
  }
  if (!publicKey || !privateKey || !subject || !/^(mailto:|https:\/\/)/.test(subject)) return null
  try {
    const ec = createECDH('prime256v1')
    ec.setPrivateKey(Buffer.from(privateKey, 'base64url'))
    if (ec.getPublicKey().toString('base64url') !== publicKey) return null
    return { publicKey, privateKey, subject }
  } catch { return null }
}

/** Lista de servicios de los navegadores. Nunca se llama a una URL interna aportada por cliente. */
export function validSubscription(s: PushSubscriptionData): boolean {
  try {
    const url = new URL(s.endpoint)
    const hosts = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'push.services.mozilla.com', 'web.push.apple.com']
    if (url.protocol !== 'https:' || url.port || url.hash || url.username || url.password || !hosts.includes(url.hostname)) return false
    const ec = createECDH('prime256v1'); ec.generateKeys()
    const key = Buffer.from(s.keys.p256dh, 'base64url')
    if (key.length !== 65 || key[0] !== 4 || Buffer.from(s.keys.auth, 'base64url').length !== 16) return false
    ec.computeSecret(key)
    return true
  } catch { return false }
}

/** RFC 8291 y 8188: un único registro aes128gcm con clave efímera distinta de VAPID. */
export function encryptedPush(s: PushSubscriptionData, payload: string): Buffer {
  const userKey = Buffer.from(s.keys.p256dh, 'base64url'), auth = Buffer.from(s.keys.auth, 'base64url')
  const ec = createECDH('prime256v1'); ec.generateKeys()
  const serverKey = ec.getPublicKey(), salt = randomBytes(16)
  const ikm = Buffer.from(hkdfSync('sha256', ec.computeSecret(userKey), auth, Buffer.concat([Buffer.from('WebPush: info\0'), userKey, serverKey]), 32))
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))
  const plaintext = Buffer.concat([Buffer.from(payload), Buffer.from([2])])
  if (plaintext.length > 3993) throw new Error('El aviso es demasiado largo.')
  const cipher = createCipheriv('aes-128-gcm', cek, nonce)
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])
  const header = Buffer.alloc(21); salt.copy(header); header.writeUInt32BE(4096, 16); header[20] = serverKey.length
  return Buffer.concat([header, serverKey, encrypted])
}

export function vapidAuthorization(endpoint: string, config: VapidConfig, now = Date.now()): string {
  const key = Buffer.from(config.publicKey, 'base64url')
  const privateKey = createPrivateKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: key.subarray(1, 33).toString('base64url'), y: key.subarray(33).toString('base64url'), d: config.privateKey } })
  const header = Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })).toString('base64url')
  const claims = Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 3600, sub: config.subject })).toString('base64url')
  const token = `${header}.${claims}`
  const signature = sign('sha256', Buffer.from(token), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')
  return `vapid t=${token}.${signature}, k=${config.publicKey}`
}

export async function sendPush(subscription: PushSubscriptionData, payload: string, config: VapidConfig, transport: typeof fetch = fetch) {
  if (!validSubscription(subscription)) throw new Error('Suscripción no válida.')
  return transport(subscription.endpoint, { method: 'POST', redirect: 'error', headers: {
    Authorization: vapidAuthorization(subscription.endpoint, config), 'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream', TTL: '60', Urgency: 'normal',
  }, body: new Uint8Array(encryptedPush(subscription, payload)), signal: AbortSignal.timeout(10_000) })
}
