import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { checkReadiness, checkRehearsalMark, checkWorkerRole, createPool } from './database.js'
import { createTestDatabase } from './test-support.js'

const enabled = process.env.TEST_POSTGRES_API === '1' && !!process.env.TEST_POSTGRES_URL
const ensayo = /no está marcada para ensayo/, produccion = /marcada para ensayo; el proceso en producción/
const ready = (pool: Pool, rehearsal: boolean) => checkReadiness(pool, false, rehearsal)

describe.skipIf(!enabled)('La marca de ensayo de la base se exige en los dos sentidos', { timeout: 60_000 }, () => {
  let marked: Awaited<ReturnType<typeof createTestDatabase>>, clean: Awaited<ReturnType<typeof createTestDatabase>>, broken: Awaited<ReturnType<typeof createTestDatabase>>
  let markedApp: Pool, cleanApp: Pool, brokenApp: Pool
  beforeAll(async () => {
    marked = await createTestDatabase('rehearsal'); clean = await createTestDatabase('markclean'); broken = await createTestDatabase('markbroken')
    ;[markedApp, cleanApp, brokenApp] = [marked, clean, broken].map(db => new Pool({ connectionString: db.appUrl, max: 2 })) as [Pool, Pool, Pool]
  })
  afterAll(async () => { await marked?.drop(markedApp); await clean?.drop(cleanApp); await broken?.drop(brokenApp) })

  it('base de ensayo: arranca en modo ensayo y se niega en producción', async () => {
    await expect(ready(markedApp, true)).resolves.toBeUndefined()
    await expect(ready(markedApp, false)).rejects.toThrow(produccion)
  })
  it('base sin marca: arranca en producción y se niega en modo ensayo', async () => {
    await expect(ready(cleanApp, false)).resolves.toBeUndefined()
    await expect(ready(cleanApp, true)).rejects.toThrow(ensayo)
  })
  it('el rol de ejecución solo lee la fila rehearsal, no el resto de interruptores, y no puede escribirla', async () => {
    await clean.admin.query("INSERT INTO llenamos.platform_flags(name,enabled) VALUES('self_signup',true) ON CONFLICT(name) DO UPDATE SET enabled=true")
    expect((await cleanApp.query('SELECT name FROM llenamos.platform_flags')).rows).toEqual([{ name: 'rehearsal' }])
    await expect(cleanApp.query("UPDATE llenamos.platform_flags SET enabled=true WHERE name='rehearsal'")).rejects.toThrow(/permission denied/)
    await expect(ready(cleanApp, false)).resolves.toBeUndefined()
  })
  it('un fallo al leer la marca NO se toma por producción: ni en producción ni en ensayo', async () => {
    // Sin privilegio de lectura: el esquema se considera no migrado y la consulta de la marca falla con permiso denegado.
    await broken.admin.query('REVOKE SELECT ON llenamos.platform_flags FROM llenamos_app')
    for (const mode of [false, true]) {
      await expect(ready(brokenApp, mode)).rejects.toThrow(/esquema de la API no está migrado/)
      await expect(checkRehearsalMark(brokenApp, mode)).rejects.toThrow(/permission denied/)
    }
    // Con privilegio pero sin fila visible (política ausente): tampoco «producción» silenciosa, aunque la base esté marcada.
    await broken.admin.query('GRANT SELECT ON llenamos.platform_flags TO llenamos_app')
    await broken.admin.query("UPDATE llenamos.platform_flags SET enabled=true WHERE name='rehearsal'")
    await broken.admin.query('DROP POLICY platform_flags_read ON llenamos.platform_flags')
    for (const mode of [false, true]) await expect(checkRehearsalMark(brokenApp, mode)).rejects.toThrow(/No se puede leer la marca/)
    // Tabla ausente: error de la propia consulta.
    const lost = new Pool({ connectionString: broken.appUrl, max: 1 })
    await broken.admin.query('ALTER TABLE llenamos.platform_flags RENAME TO platform_flags_x')
    try { for (const mode of [false, true]) await expect(checkRehearsalMark(lost, mode)).rejects.toThrow(/platform_flags/) }
    finally { await lost.end(); await broken.admin.query('ALTER TABLE llenamos.platform_flags_x RENAME TO platform_flags') }
  })
  it('la misma comprobación vale para el worker (rol llenamos_worker + llenamos_app)', async () => {
    const worker = `llenamos_wk_${Math.random().toString(36).slice(2, 10)}`
    await marked.admin.query(`CREATE ROLE ${worker} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD 'fixture-only' IN ROLE llenamos_app, llenamos_worker`)
    const asWorker = (db: typeof marked) => { const url = new URL(db.appUrl); url.username = worker; url.password = 'fixture-only'; return createPool(url.toString(), 'worker-test') }
    const [markedWorker, cleanWorker] = [asWorker(marked), asWorker(clean)]
    try {
      await checkWorkerRole(markedWorker)
      await expect(checkRehearsalMark(markedWorker, true)).resolves.toBeUndefined()
      await expect(checkRehearsalMark(markedWorker, false)).rejects.toThrow(produccion)
      await expect(checkRehearsalMark(cleanWorker, false)).resolves.toBeUndefined()
      await expect(checkRehearsalMark(cleanWorker, true)).rejects.toThrow(ensayo)
    } finally {
      await markedWorker.end(); await cleanWorker.end()
      await marked.admin.query(`DROP ROLE ${worker}`)
    }
  })
  it('012 conserva exactamente su contenido de la fusión (18ad664) y la marca vive solo en 015', async () => {
    const { migrationSql } = await import('./test-migrations.js')
    const { createHash } = await import('node:crypto')
    const all = migrationSql()
    const billing = all.find(sql => /CREATE TABLE llenamos\.platform_flags/.test(sql))!
    // sha256 de `git show 18ad664:apps/api/migrations/012_billing_api.sql`: si cambia, migrate.ts abortaría por huella en cualquier base ya migrada.
    expect(createHash('sha256').update(billing).digest('hex')).toBe('978cc28962cf49f4acef12a34996054d8d87383b8b16cf5294986eb468d74219')
    expect(all.filter(sql => /platform_flags_read/.test(sql))).toHaveLength(1)
  })
  it('el verificador SCRAM que genera el ensayo es válido: el rol entra con la contraseña y no con otra', async () => {
    const password = 'contraseña-de-prueba-0123456789'
    const verifier = execFileSync(process.execPath, [join(__dirname, '../../../deploy/vps/ensayo/scram.mjs')], { input: password }).toString().trim()
    expect(verifier).toMatch(/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/)
    expect(verifier).not.toContain(password)
    const role = `llenamos_scram_${Math.random().toString(36).slice(2, 10)}`
    await clean.admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER PASSWORD '${verifier}' IN ROLE llenamos_app`)
    try {
      const as = (pw: string) => { const url = new URL(clean.appUrl); url.username = role; url.password = pw; return new Pool({ connectionString: url.toString(), max: 1 }) }
      const good = as(password), bad = as('otra')
      try {
        expect((await good.query('SELECT current_user AS u')).rows[0].u).toBe(role)
        await expect(bad.query('SELECT 1')).rejects.toThrow(/password authentication failed/)
      } finally { await good.end(); await bad.end() }
    } finally { await clean.admin.query(`DROP ROLE ${role}`) }
  })
})
