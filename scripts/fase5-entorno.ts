/** Solo demo y emuladores locales (por defecto, los de la fila 2). Se importa antes de inicializar Admin. */
export function entorno() {
  process.env.GCLOUD_PROJECT ??= 'demo-llenamos'
  process.env.FIRESTORE_EMULATOR_HOST ??= '127.0.0.1:8097'
  process.env.FIREBASE_AUTH_EMULATOR_HOST ??= '127.0.0.1:9103'
  process.env.FIREBASE_STORAGE_EMULATOR_HOST ??= '127.0.0.1:9213'
  process.env.FIREBASE_EMULATOR_HUB ??= '127.0.0.1:4412'
  process.env.METADATA_SERVER_DETECTION = 'none'
  process.env.NO_PROXY = '127.0.0.1,localhost,::1'
  process.env.no_proxy = process.env.NO_PROXY
  if (process.env.GCLOUD_PROJECT !== 'demo-llenamos' || !/^(127\.0\.0\.[12]|localhost):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST) || !/^(127\.0\.0\.[12]|localhost):\d+$/.test(process.env.FIREBASE_AUTH_EMULATOR_HOST)) throw new Error('Usa solo los emuladores locales y demo-llenamos.')
}
