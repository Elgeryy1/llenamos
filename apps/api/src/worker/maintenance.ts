import type { Pool } from 'pg'

export interface MaintenanceTask { name: string; everyMs: number; run: () => Promise<number> }

/** Tareas periódicas del worker. Cada una es idempotente y acotada (lotes con límite). */
export function maintenanceTasks(pool: Pool, extra: readonly MaintenanceTask[] = []): MaintenanceTask[] {
  return [
    { name: 'colas', everyMs: 600_000, run: async () => (await pool.query<{ n: number }>("SELECT llenamos.worker_purge_queues('30 days'::interval,1000) AS n")).rows[0]!.n },
    { name: 'webhooks', everyMs: 3_600_000, run: async () => (await pool.query<{ n: number }>("SELECT llenamos.webhook_purge('45 days'::interval) AS n")).rows[0]!.n },
    ...extra,
  ]
}

export function runMaintenance(tasks: readonly MaintenanceTask[], log: (entry: object) => void, now: () => number = Date.now) {
  const last = new Map<string, number>()
  return async () => {
    for (const task of tasks) {
      if (now() - (last.get(task.name) ?? 0) < task.everyMs) continue
      last.set(task.name, now())
      try { const changed = await task.run(); if (changed) log({ level: 'info', event: 'maintenance', task: task.name, changed }) }
      catch { log({ level: 'error', event: 'maintenance_failed', task: task.name }) }
    }
  }
}
