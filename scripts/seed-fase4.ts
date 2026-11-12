// Personal, inventario y costes de la taberna de demostración. Idempotente y solo contra emuladores.
async function main() {
  if (!/^127\.0\.0\.1:(8085|809[6-9]|8100)$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? '') || !/^127\.0\.0\.1:(9099|910[2-6])$/.test(process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '')) {
    throw new Error('Indica FIRESTORE_EMULATOR_HOST y FIREBASE_AUTH_EMULATOR_HOST de los emuladores locales (por ejemplo 127.0.0.1:8098 y 127.0.0.1:9104).')
  }
  process.env.GCLOUD_PROJECT = 'demo-llenamos'
  const { seedFase4 } = await import('../functions/src/fase4/seed')
  console.log(await seedFase4())
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
