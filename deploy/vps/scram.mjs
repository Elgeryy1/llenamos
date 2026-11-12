// Verificador SCRAM-SHA-256 de PostgreSQL a partir de una contraseña leída de la entrada estándar.
// Así el SQL del ensayo lleva solo el verificador (no reversible), nunca la contraseña en claro, ni en `ps` ni en el log del servidor.
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
const password = readFileSync(0, 'utf8').replace(/\n$/, '')
if (!password) { console.error('falta la contraseña por la entrada estándar'); process.exit(2) }
// Normaliza con NFKC, no con SASLprep (RFC 4013): para las contraseñas hexadecimales del ensayo es idéntico; no usar con texto libre.
const iterations = 4096, salt = randomBytes(16)
const salted = pbkdf2Sync(password.normalize('NFKC'), salt, iterations, 32, 'sha256')
const hmac = (key, data) => createHmac('sha256', key).update(data).digest()
const stored = createHash('sha256').update(hmac(salted, 'Client Key')).digest()
console.log(`SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${stored.toString('base64')}:${hmac(salted, 'Server Key').toString('base64')}`)
