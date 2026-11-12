// Alta o renovación de un operador de plataforma de LogiQD en Firebase Auth (solo Auth, sin contraseña: se fija con el correo
// de restablecimiento). Lo lanza operador.sh dentro de la imagen API; imprime «uid sessionVersion» para la fila de identities.
import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { cert, initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'

const email = (process.argv[2] ?? '').trim().toLowerCase()
if (!/^[a-z0-9._-]+@logiqd\.me$/.test(email)) { console.error('Solo cuentas @logiqd.me.'); process.exit(2) }
const auth = getAuth(initializeApp({ credential: cert(JSON.parse(readFileSync('/run/secrets/firebase_auth_admin', 'utf8'))) }))
let user
try { user = await auth.getUserByEmail(email) } catch (error) {
  if (error?.code !== 'auth/user-not-found') throw error
  user = await auth.createUser({ email, displayName: email.split('@')[0] })
}
if (user.disabled) { console.error('La cuenta está deshabilitada en Firebase.'); process.exit(1) }
// Una versión nueva invalida las sesiones anteriores de esa cuenta.
const sessionVersion = randomBytes(16).toString('hex')
await auth.setCustomUserClaims(user.uid, { ...(user.customClaims ?? {}), logiqd: true, sessionVersion })
console.log(`${user.uid} ${sessionVersion}`)
