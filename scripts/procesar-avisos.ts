// El modo local captura los avisos. No llama a los servicios push de los navegadores.
if (!process.env.FIRESTORE_EMULATOR_HOST || process.env.GCLOUD_PROJECT !== 'demo-llenamos') throw new Error('Usa GCLOUD_PROJECT=demo-llenamos y FIRESTORE_EMULATOR_HOST de tu agente.')
async function main() {
  const { processPush } = await import('../functions/src/fase2/push-process')
  const { db } = await import('../functions/src/shared')
  try { console.log(await processPush(process.argv[2], process.argv[3])) } finally { await db.terminate() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
