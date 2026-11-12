// Solo genera un par de prueba local. No contacta con servicios ni crea cuentas.
import { createECDH } from 'node:crypto'
const key = createECDH('prime256v1')
key.generateKeys()
console.log(`VAPID_PUBLIC_KEY=${key.getPublicKey().toString('base64url')}`)
console.log(`VAPID_PRIVATE_KEY=${key.getPrivateKey().toString('base64url')}`)
console.log('VAPID_SUBJECT=mailto:prueba@example.test')
