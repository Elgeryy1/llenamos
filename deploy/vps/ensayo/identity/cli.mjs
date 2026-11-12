// Herramienta de ensayo dentro del contenedor de identidad. La contraseña se lee SIEMPRE de la entrada estándar
// (nunca como argumento: acabaría en `ps`, en el historial y en los registros):
//   login <correo>                            imprime el ID token
//   operator <uid> <correo> <sessionVersion>  crea el operador de plataforma de pruebas
import { readFileSync } from 'node:fs'
const [command, ...args] = process.argv.slice(2)
const readPassword = () => {
  const value = readFileSync(0, 'utf8').trim()
  if (!value) { console.error('falta la contraseña por la entrada estándar'); process.exit(2) }
  return value
}
const secret = readFileSync(process.env.REHEARSAL_ADMIN_SECRET_FILE ?? '/run/secrets/rehearsal_identity_secret', 'utf8').trim()
const post = async (path, body, admin) => {
  const response = await fetch(`http://127.0.0.1:9102${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(admin ? { Authorization: `Bearer ${secret}` } : {}) }, body: JSON.stringify(body) })
  if (!response.ok) { console.error(`${path}: ${response.status}`); process.exit(1) }
  return response.json()
}
if (command === 'login' && args.length === 1) {
  console.log((await post('/login', { email: args[0], password: readPassword() }, false)).idToken)
} else if (command === 'operator' && args.length === 3) {
  const [uid, email, sessionVersion] = args
  if (!/^[a-f0-9]{32}$/.test(sessionVersion)) { console.error('sessionVersion debe ser hexadecimal de 32 caracteres'); process.exit(2) }
  const account = await post('/admin/operator', { uid, email, password: readPassword(), sessionVersion }, true)
  console.log(JSON.stringify(account))
} else {
  console.error('uso: login <correo> | operator <uid> <correo> <sessionVersion>  (contraseña por stdin)'); process.exit(2)
}
