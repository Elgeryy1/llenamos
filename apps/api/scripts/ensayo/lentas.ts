import { spawnSync } from 'node:child_process'
import { PROJECT } from './lib.js'

export interface Slow { ms: number; statement: string; params: string }
/** Sentencias lentas del registro de PostgreSQL desde `since` (log_min_duration_statement), agrupadas por sentencia. */
export function slowQueries(since: string, minMs = 0) {
  const result = spawnSync('docker', ['logs', '--since', since, `${PROJECT}-postgres-1`], { maxBuffer: 1 << 29 })
  // PostgreSQL escribe en stderr: docker logs lo reenvía por el stderr del cliente.
  const log = `${result.stdout}\n${result.stderr}`
  const lines = log.split('\n'), slow: Slow[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = /LOG:\s+duration: ([\d.]+) ms\s+(?:execute [^:]*|statement): (.*)$/.exec(lines[i]!)
    if (!m || Number(m[1]) < minMs) continue
    let statement = m[2]!, j = i + 1
    while (j < lines.length && !/^\d{4}-\d\d-\d\d /.test(lines[j]!)) { statement += '\n' + lines[j]!.trim(); j++ }
    const detail = /DETAIL:\s+[Pp]arameters: (.*)/.exec(lines[j] ?? '')
    slow.push({ ms: Number(m[1]), statement: statement.replace(/\s+/g, ' ').trim(), params: detail?.[1] ?? '' })
  }
  const groups = new Map<string, { n: number; max: number; total: number; sample: Slow }>()
  for (const s of slow) {
    if (s.statement === 'COMMIT' || s.statement === 'BEGIN') continue
    const key = s.statement.replace(/'[^']*'/g, "'?'").slice(0, 160), g = groups.get(key)
    if (!g) groups.set(key, { n: 1, max: s.ms, total: s.ms, sample: s }); else { g.n++; g.total += s.ms; if (s.ms > g.max) { g.max = s.ms; g.sample = s } }
  }
  return { slow, groups, top: [...groups.values()].sort((a, b) => b.total - a.total).slice(0, 8) }
}
