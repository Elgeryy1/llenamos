import { writeFileSync } from 'node:fs'
import { createPool } from './database.js'
import { POOL_MAX } from './pools.js'
import { checkRehearsalMark, checkWorkerRole } from './database.js'
import { MODULES } from './modules/index.js'
import { integrationVault } from './platform/integrations.js'
import { fileStore } from './files/storage.js'
import { workerConfiguration } from './worker/config.js'
import { buildHandlers, createWorker } from './worker/index.js'
import { maintenanceTasks, runMaintenance } from './worker/maintenance.js'
import { workerMaintenance } from './worker/tasks.js'
import { platformMaintenance } from './modules/plataforma/index.js'
import { clientesMaintenance } from './modules/comun/mantenimiento.js'
import { reservasMaintenance } from './modules/reservas/index.js'
import { salaMaintenance } from './modules/sala/jobs.js'
import { pushMaintenance } from './modules/sala/push-envio.js'
import { cajaMaintenance } from './modules/caja/worker.js'

const config = workerConfiguration()
const pool = createPool(config.databaseUrl, { applicationName: 'llenamos-worker', max: POOL_MAX.worker })
await checkWorkerRole(pool)
// Misma barrera simétrica que la API: la marca de la base debe coincidir con NODE_ENV=rehearsal.
await checkRehearsalMark(pool, process.env.NODE_ENV === 'rehearsal')
const files = fileStore(config.filesRoot)
const vault = integrationVault(config.integrationKey)
const log = (entry: object) => console.error(JSON.stringify(entry))
const worker = createWorker({ pool, handlers: buildHandlers(MODULES, { files, privacyKey: config.integrationKey }), openCredentials: (rid, ciphertext) => vault.open(rid, ciphertext), log })
const maintain = runMaintenance(maintenanceTasks(pool, [...workerMaintenance(pool, files), ...platformMaintenance(pool), ...reservasMaintenance(pool), ...salaMaintenance(pool), ...clientesMaintenance(pool), ...pushMaintenance(pool), ...cajaMaintenance(pool)]), log)
const beatFile = process.env.WORKER_HEARTBEAT_FILE ?? '/tmp/worker-heartbeat'
let lastBeat = 0
// Latido para el healthcheck: se escribe al sondear la cola, así un worker colgado deja de latir.
worker.onBeat(() => { const now = Date.now(); if (now - lastBeat > 10_000) { lastBeat = now; try { writeFileSync(beatFile, String(now)) } catch { /* sin latido, el healthcheck lo detectará */ } } })
const running = worker.start({ pollMs: config.pollMs, concurrency: config.concurrency })
const timer = setInterval(() => { void maintain() }, 30_000)
let closing = false
const stop = () => {
  if (closing) return
  closing = true
  clearInterval(timer)
  setTimeout(() => process.exit(1), 30_000).unref()
  void running.stop().then(() => pool.end()).then(() => process.exit(0))
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
