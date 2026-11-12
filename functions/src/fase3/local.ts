// Procesador fiscal explícito. Solo emuladores y artefactos originales, sin envíos reales.
if (process.env.GCLOUD_PROJECT !== 'demo-llenamos' || !process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Usa demo-llenamos y FIRESTORE_EMULATOR_HOST.')
const { processFiscalOutbox } = await import('./process')
console.log(await processFiscalOutbox(process.argv[2] ?? 'demo-lumbre'))
export {}
