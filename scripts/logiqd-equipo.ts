import { initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'

if (!process.env.FIREBASE_AUTH_EMULATOR_HOST) throw new Error('Indica FIREBASE_AUTH_EMULATOR_HOST. Este script solo admite emuladores.')
const email = process.argv[2]
if (!email) throw new Error('Uso: pnpm logiqd:equipo <correo>')
initializeApp({ projectId: 'demo-llenamos' })
const auth = getAuth()
const user = await auth.getUserByEmail(email)
await auth.setCustomUserClaims(user.uid, { ...user.customClaims, logiqd: true })
console.log(`Acceso del equipo LogiQD concedido a ${email} en el emulador.`)
