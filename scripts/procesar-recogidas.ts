// Ejecución explícita local: no hay endpoint administrativo expuesto al público.
if (!process.env.FIRESTORE_EMULATOR_HOST || process.env.GCLOUD_PROJECT !== 'demo-llenamos') throw new Error('Indica FIRESTORE_EMULATOR_HOST y GCLOUD_PROJECT=demo-llenamos para tus emuladores.')
async function main() {
const { processTakeaways } = await import('../functions/src/fase2/process')
const { db } = await import('../functions/src/shared')
try { console.log(await processTakeaways(process.argv[2], process.argv[3])) } finally { await db.terminate() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
