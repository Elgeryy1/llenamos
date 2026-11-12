import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDecipheriv, createECDH, createHmac, createPublicKey, randomBytes, verify } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { encryptedPush, sendPush, validSubscription, vapidAuthorization, vapidConfig } from './web-push.js'

function fixture() {
  const user = createECDH('prime256v1'); user.generateKeys()
  const server = createECDH('prime256v1'); server.generateKeys()
  const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/prueba-local', keys: { p256dh: user.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } }
  const config = { publicKey: server.getPublicKey().toString('base64url'), privateKey: server.getPrivateKey().toString('base64url'), subject: 'mailto:prueba@example.test' }
  return { user, subscription, config }
}

describe('Web Push sin proveedores externos', () => {
  it('no configura avisos con claves ausentes, mal emparejadas o contacto inválido', () => {
    const { config } = fixture()
    expect(vapidConfig({})).toBeNull()
    expect(vapidConfig({ VAPID_PUBLIC_KEY: config.publicKey, VAPID_PRIVATE_KEY: config.privateKey, VAPID_SUBJECT: config.subject })).toEqual(config)
    const dir = mkdtempSync(path.join(os.tmpdir(), 'vapid-')), file = path.join(dir, 'vapid_private_key')
    writeFileSync(file, `${config.privateKey}\n`)
    expect(vapidConfig({ VAPID_PUBLIC_KEY: config.publicKey, VAPID_PRIVATE_KEY_FILE: file, VAPID_SUBJECT: config.subject })).toEqual(config)
    writeFileSync(file, '') // archivo vacío = sin avisos
    expect(vapidConfig({ VAPID_PUBLIC_KEY: config.publicKey, VAPID_PRIVATE_KEY_FILE: file, VAPID_SUBJECT: config.subject })).toBeNull()
    expect(vapidConfig({ VAPID_PUBLIC_KEY: config.publicKey, VAPID_PRIVATE_KEY_FILE: path.join(dir, 'no-existe'), VAPID_SUBJECT: config.subject })).toBeNull()
    rmSync(dir, { recursive: true })
    expect(vapidConfig({ VAPID_PUBLIC_KEY: config.publicKey, VAPID_PRIVATE_KEY: fixture().config.privateKey, VAPID_SUBJECT: config.subject })).toBeNull()
  })
  it('rechaza destinos internos, redirecciones de URL y claves falsas', () => {
    const { subscription } = fixture()
    expect(validSubscription(subscription)).toBe(true)
    for (const endpoint of ['http://127.0.0.1:8099', 'https://fcm.googleapis.com.ejemplo.test/x', 'https://user@fcm.googleapis.com/x', 'https://fcm.googleapis.com:1234/x']) expect(validSubscription({ ...subscription, endpoint })).toBe(false)
    expect(validSubscription({ ...subscription, keys: { ...subscription.keys, p256dh: 'falso' } })).toBe(false)
  })
  it('el receptor descifra y autentica el registro RFC 8291 con HMAC independientes', () => {
    const { user, subscription } = fixture()
    const payload = JSON.stringify({ title: 'La mesa necesita atención', tag: 'task:123' })
    const body = encryptedPush(subscription, payload), salt = body.subarray(0, 16), serverKey = body.subarray(21, 86)
    expect(body.readUInt32BE(16)).toBe(4096); expect(body[20]).toBe(65)
    const hmac = (key: Buffer, value: Buffer) => createHmac('sha256', key).update(value).digest()
    const prkKey = hmac(Buffer.from(subscription.keys.auth, 'base64url'), user.computeSecret(serverKey))
    const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), user.getPublicKey(), serverKey, Buffer.from([1])]))
    const prk = hmac(salt, ikm)
    const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16)
    const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12)
    const decipher = createDecipheriv('aes-128-gcm', cek, nonce)
    decipher.setAuthTag(body.subarray(-16))
    const decoded = Buffer.concat([decipher.update(body.subarray(86, -16)), decipher.final()])
    expect(decoded.at(-1)).toBe(2); expect(decoded.subarray(0, -1).toString()).toBe(payload)
    expect(encryptedPush(subscription, payload)).not.toEqual(body)
  })
  it('firma VAPID ES256 para el origen correcto y envía aes128gcm con caducidad corta', async () => {
    const { subscription, config } = fixture()
    const authorization = vapidAuthorization(subscription.endpoint, config, 1000000)
    const token = authorization.split('t=')[1]!.split(',')[0]!, [header, claims, signature] = token.split('.')
    expect(JSON.parse(Buffer.from(claims!, 'base64url').toString())).toEqual({ aud: 'https://fcm.googleapis.com', exp: 4600, sub: config.subject })
    const raw = Buffer.from(config.publicKey, 'base64url')
    const key = createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') } })
    expect(verify('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature!, 'base64url'))).toBe(true)
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 201 }))
    await sendPush(subscription, '{}', config, transport)
    expect(transport).toHaveBeenCalledWith(subscription.endpoint, expect.objectContaining({ redirect: 'error', headers: expect.objectContaining({ TTL: '60', 'Content-Encoding': 'aes128gcm' }) }))
  })
})
