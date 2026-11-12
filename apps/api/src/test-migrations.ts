import { readFileSync, readdirSync } from 'node:fs'

/** Para pruebas: todas las migraciones en el mismo orden que `migrate.ts`. */
export function migrationSql(): string[] {
  const folder = new URL('../migrations/', import.meta.url)
  return readdirSync(folder).filter(name => /^\d+[a-z]?_[a-z0-9_]+\.sql$/.test(name)).sort().map(name => readFileSync(new URL(name, folder), 'utf8'))
}
