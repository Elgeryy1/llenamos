import { beforeEach, describe, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({ rows: new Map<string, Record<string, unknown>>() }))
vi.mock('./shared', () => ({
  stamp: () => ({ createdAt: 'fecha', updatedAt: 'fecha' }),
  db: {
    doc: (path: string) => ({ path, get: async () => ({ data: () => ({ displayName: 'Ana' }) }) }),
    runTransaction: async (work: (tx: unknown) => Promise<void>) => work({
      get: async (ref: { path: string }) => ({ exists: mock.rows.has(ref.path) }),
      create: (ref: { path: string }, data: Record<string, unknown>) => { mock.rows.set(ref.path, data) },
    }),
  },
}))
import { writeActivity } from './activity'
type Event = Parameters<typeof writeActivity>[0]
function event(before?: Record<string, unknown>, after?: Record<string, unknown>): Event {
  return { id: 'evento-1', params: { rid: 'uno' }, authType: 'api_key', authId: 'ana', data: { before: { data: () => before }, after: { data: () => after } } } as unknown as Event
}
beforeEach(() => mock.rows.clear())
describe('Registro de actividad', () => {
  for (const authType of [undefined, 'unknown', 'system', 'unauthenticated', 'service_account'] as const) {
    for (const action of ['created', 'updated', 'deleted']) it(`recupera updatedBy con contexto ${authType} al ${action}`, async () => {
      const e = event(action === 'created' ? undefined : { name: 'Antes', updatedBy: 'anterior' }, action === 'deleted' ? undefined : { name: 'Después', updatedBy: 'cliente' })
      Object.assign(e, { authType, authId: undefined })
      await writeActivity(e, 'restaurant', 'uno')
      expect([...mock.rows.values()][0]).toMatchObject({ actorUid: action === 'deleted' ? 'anterior' : 'cliente', actorName: 'Ana' })
    })
  }
  it('prioriza el usuario del contexto sobre updatedBy', async () => {
    await writeActivity(event({ name: 'Antes' }, { name: 'Después', updatedBy: 'otra' }), 'restaurant', 'uno')
    expect([...mock.rows.values()][0]).toMatchObject({ actorUid: 'ana' })
  })
  it('ignora cambios exclusivos de autor y fechas', async () => {
    await writeActivity(event({ name: 'Igual', updatedBy: 'otra' }, { name: 'Igual', updatedBy: 'ana', updatedAt: 2 }), 'restaurant', 'uno')
    expect(mock.rows.size).toBe(0)
  })
  for (const updatedBy of [undefined, null, 42, '', 'ruta/incorrecta']) it(`sin contexto ni uid válido (${updatedBy}) conserva autor nulo`, async () => {
    const e = event(undefined, { name: 'Sistema', updatedBy })
    Object.assign(e, { authType: undefined, authId: undefined })
    await writeActivity(e, 'restaurant', 'uno')
    expect([...mock.rows.values()][0]).toMatchObject({ actorUid: null, actorName: null })
  })
  for (const type of ['restaurant','member','area','table']) {
    for (const action of ['created','updated','deleted']) it(`${type}.${action}, sin duplicar reintentos`, async () => {
      const e = event(action === 'created' ? undefined : { name: 'Antes' }, action === 'deleted' ? undefined : { name: 'Después' })
      await writeActivity(e, type, 'id')
      await writeActivity(e, type, 'id')
      expect(mock.rows.size).toBe(1)
      expect([...mock.rows.values()][0]).toMatchObject({ action: `${type}.${action}`, actorUid: 'ana', actorName: 'Ana', entity: { type, id: 'id' } })
    })
  }
  it('concuerda el resumen con el género de la entidad', async () => {
    await writeActivity(event(undefined, { name: 'S1' }), 'table', 'id')
    expect([...mock.rows.values()][0]).toMatchObject({ summary: 'Mesa creada: S1' })
    mock.rows.clear()
    await writeActivity(event({ name: 'Terraza' }, undefined), 'area', 'id')
    expect([...mock.rows.values()][0]).toMatchObject({ summary: 'Zona eliminada: Terraza' })
    mock.rows.clear()
    await writeActivity(event({ name: 'A' }, { name: 'B' }), 'restaurant', 'id')
    expect([...mock.rows.values()][0]).toMatchObject({ summary: 'Restaurante actualizado: B' })
  })
  it('ignora escrituras que solo cambian las fechas', async () => {
    await writeActivity(event({ name: 'Igual', updatedAt: 1 }, { name: 'Igual', updatedAt: 2 }), 'restaurant', 'uno')
    expect(mock.rows.size).toBe(0)
  })
  it('identifica las escrituras del sistema sin atribuirlas a una persona', async () => {
    const e = event(undefined, { name: 'Sistema' })
    e.authType = 'system'
    await writeActivity(e, 'restaurant', 'uno')
    expect([...mock.rows.values()][0]).toMatchObject({ actorUid: null, actorName: null })
  })
})

it('omite operaciones con outbox pero registra el siguiente cambio del cliente', async () => {
  for (const type of ['member', 'restaurant']) {
    await writeActivity(event(undefined, { name: 'Nueva', changeId: 'alta' }), type, 'id')
    await writeActivity(event({ changeId: 'alta' }, { changeId: 'cambio' }), type, 'id')
  }
  expect(mock.rows.size).toBe(0)
  await writeActivity(event({ name: 'Antes', changeId: 'alta' }, { name: 'Después', changeId: 'alta' }), 'restaurant', 'id')
  expect([...mock.rows.values()][0]).toMatchObject({ actorUid: 'ana', actorName: 'Ana', action: 'restaurant.updated' })
})
