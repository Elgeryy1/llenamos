// Nunca usa el proyecto ni los puertos de producción.
async function main() {
  if (process.env.GCLOUD_PROJECT !== 'demo-llenamos' || !/^(127\.0\.0\.[12]|localhost):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? '') || !/^(127\.0\.0\.[12]|localhost):\d+$/.test(process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '')) throw new Error('Usa solo los emuladores locales y demo-llenamos.')
  process.env.GCLOUD_PROJECT = 'demo-llenamos'
  const { seedCaja } = await import('../functions/src/fase3/seed')
  console.log(await seedCaja())
}
main().catch(error => { console.error(error); process.exitCode = 1 })
