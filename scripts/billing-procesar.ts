// Ejecuta el mismo trabajador de servidor, exclusivamente contra la fila 4 local.
if (process.env.GCLOUD_PROJECT !== 'demo-llenamos' || process.env.FIRESTORE_EMULATOR_HOST !== '127.0.0.1:8099' || process.env.FIREBASE_AUTH_EMULATOR_HOST !== '127.0.0.1:9105') throw new Error('Usa demo-llenamos y los emuladores de la fila 4.')
async function main() {
const { processSubscriptions } = await import('../functions/src/fase6-billing/process')
console.log(await processSubscriptions())
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
