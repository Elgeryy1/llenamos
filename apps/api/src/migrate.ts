import { readFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { Pool } from 'pg'
import { createHash } from 'node:crypto'

// Comando administrativo separado. La API no recibe la credencial de migración.
const file=process.env.MIGRATION_DATABASE_URL_FILE
if (!file) throw new Error('Falta MIGRATION_DATABASE_URL_FILE.')
const pool=new Pool({connectionString:readFileSync(file,'utf8').trim(),max:1})
const client=await pool.connect()
try {
  await client.query("SELECT pg_advisory_lock(hashtext('llenamos-schema-migration'))")
  await client.query('CREATE SCHEMA IF NOT EXISTS llenamos_migrations; REVOKE ALL ON SCHEMA llenamos_migrations FROM PUBLIC')
  await client.query('CREATE TABLE IF NOT EXISTS llenamos_migrations.applied (name text PRIMARY KEY, checksum char(64) NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())')
  const folder=new URL('../migrations/',import.meta.url)
  for (const name of (await readdir(folder)).filter(name=>/^\d+[a-z]?_[a-z0-9_]+\.sql$/.test(name)).sort()) {
    const sql=readFileSync(new URL(name,folder),'utf8'), checksum=createHash('sha256').update(sql).digest('hex')
    const applied=await client.query<{checksum:string}>('SELECT checksum FROM llenamos_migrations.applied WHERE name=$1',[name])
    if(applied.rowCount) {
      if(applied.rows[0]!.checksum!==checksum)throw new Error(`La migración aplicada ${name} ha cambiado; crear una migración nueva.`)
      continue
    }
    await client.query('BEGIN')
    try {
      await client.query(sql)
      await client.query('INSERT INTO llenamos_migrations.applied(name,checksum) VALUES($1,$2)',[name,checksum])
      await client.query('COMMIT')
    } catch(error) { await client.query('ROLLBACK'); throw error }
  }
} finally {
  await client.query("SELECT pg_advisory_unlock(hashtext('llenamos-schema-migration'))")
  client.release();await pool.end()
}
