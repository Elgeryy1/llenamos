/** Copia diaria y simulacro como máximo cada 30 días, ejecutados por el mismo worker. */
import { db } from '../functions/src/shared'
import { runContinuity } from '../functions/src/fase6-backup/worker'
async function main() {
try { if (process.argv[2] === 'todo') { const { continuityMaintenanceWork } = await import('../functions/src/fase6-backup/process');await continuityMaintenanceWork() } else await runContinuity(process.argv[2] ?? 'demo-lumbre'); console.log('Trabajador terminado. Revisa backups, restoreDrills y backupHealth, también cuando una comprobación falla.') }
finally { await db.terminate() }

}
main().catch(error => { console.error(error);process.exitCode=1 })
