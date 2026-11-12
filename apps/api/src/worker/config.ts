import { readFileSync } from 'node:fs'

function hexKey(file: string | undefined): Buffer | undefined {
  if (!file) return undefined
  const value = readFileSync(file, 'utf8').trim()
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('La clave de integraciones debe ser hexadecimal de 32 bytes.')
  return Buffer.from(value, 'hex')
}

/** El worker no usa Firebase: solo su conexión SQL, la clave de integraciones y el volumen de archivos. */
export function workerConfiguration(env: NodeJS.ProcessEnv = process.env) {
  if (env.FIREBASE_AUTH_EMULATOR_HOST || env.FIRESTORE_EMULATOR_HOST || env.FUNCTIONS_EMULATOR) throw new Error('El worker no admite emuladores.')
  const databaseUrl = env.DATABASE_URL_FILE ? readFileSync(env.DATABASE_URL_FILE, 'utf8').trim() : ''
  if (!/^postgres(?:ql)?:\/\//.test(databaseUrl)) throw new Error('Falta DATABASE_URL_FILE con la conexión del rol del worker.')
  const filesRoot = env.FILES_ROOT ?? ''
  if (!filesRoot.startsWith('/')) throw new Error('FILES_ROOT debe ser una ruta absoluta del volumen privado.')
  return { databaseUrl, integrationKey: hexKey(env.PLATFORM_INTEGRATION_KEY_FILE), filesRoot, pollMs: Number(env.WORKER_POLL_MS ?? 2000), concurrency: Number(env.WORKER_CONCURRENCY ?? 4) }
}
