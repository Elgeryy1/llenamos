import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createFixture, postgresTests, type Fixture } from './fixture.js'
import { rolesFor } from './acceso.js'

describe.skipIf(!postgresTests)('comun: permisos, módulos e idempotencia', () => {
  let f: Fixture
  beforeAll(async () => { f = await createFixture('comun') }, 60_000)
  afterAll(async () => { await f?.close() })
  it('rolesFor sigue la matriz de permisos', () => {
    expect(rolesFor('campanas.lanzar')).toEqual(['owner'])
    expect(rolesFor('analisis.ver')).not.toContain('kitchen')
  })
  it('el fixture arranca con dos restaurantes aislados', async () => {
    const { rows } = await f.admin.query("SELECT count(*)::int AS n FROM llenamos.memberships")
    expect(rows[0].n).toBe(5)
    const denied = await f.call('operacionInexistente', 'alice', {})
    expect(denied.status).toBe(404)
  })
})
