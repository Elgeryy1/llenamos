import { beforeEach, expect, it, vi } from 'vitest'
import { commandFingerprint, OfflineCommandSchema, syncStreamKey, type CommandReceipt, type LocalQueueEntry } from '@llenamos/core'
import type { Espacio } from './almacen'
const mock = vi.hoisted(() => ({ uid: 'owner', request: vi.fn(), space: null as Espacio | null, backend: 'firebase-demo' as 'postgres' | 'firebase-demo' }))
vi.mock('@/lib/firebase/auth-client', () => ({ getFirebaseIdentity: () => ({ auth: { currentUser: { uid: mock.uid } } }) }))
vi.mock('@/lib/firebase/client', () => ({ getFirebase: () => ({ functions: {} }) }))
vi.mock('@/lib/api/operations', async importOriginal => ({ ...(await importOriginal<typeof import('@/lib/api/operations')>()), operationBackend: () => mock.backend }))
vi.mock('@/lib/api/transport', () => ({ postOperation: (name: string, data: unknown, options: unknown) => mock.request(name, data, options).then((r: { data: unknown }) => r.data) }))
vi.mock('firebase/functions', () => ({ httpsCallable: (_functions: unknown, name: string) => (data: unknown) => mock.request(name, data) }))
vi.mock('./almacen', () => ({
  mutate: async (_scope: unknown, change?: (s: Espacio) => Espacio) => { if (change) mock.space = change(mock.space!); return mock.space },
  scopeFor: vi.fn(), enqueue: vi.fn(),
}))
import { drain } from './cliente'
const command = OfflineCommandSchema.parse({ actorUid: 'owner', restaurantId: 'r', locationId: 'l', deviceId: 'tablet_00000000001', commandId: 'command_0000000001', sequence: 1, clientCreatedAt: 1000, preconditions: [{ kind: 'item', id: 'bravas', version: 'v1' }], operation: 'marcarAgotado', payload: { restaurantId: 'r', locationId: 'l', itemId: 'bravas', soldOut: true } })
const entry = (): LocalQueueEntry => ({ command, state: 'uncertain', attempts: 1, nextAttemptAt: 0, result: null, lastError: 'Respuesta perdida' })
const receipt = (result: CommandReceipt['result']): CommandReceipt => ({ commandId: command.commandId, streamKey: syncStreamKey(command), sequence: command.sequence, fingerprint: commandFingerprint(command), recordedAt: 2000, result })
beforeEach(() => {
  mock.uid = 'owner'; mock.backend = 'firebase-demo'; mock.request.mockReset()
  mock.space = { key: syncStreamKey(command), sequence: 1, entries: [entry()], versions: [], synchronizedAt: 0, cash: [] }
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true })
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: async (_name: string, _options: unknown, work: (lock: object) => Promise<void>) => work({}) } })
})
it('recupera la respuesta perdida con el mismo id antes de volver a ejecutar', async () => {
  mock.request.mockResolvedValue({ data: { receipt: receipt({ status: 'applied', response: { ok: true, soldOut: true }, versions: [{ kind: 'item', id: 'bravas', version: 'v2' }] }) } })
  await drain(command)
  expect(mock.request).toHaveBeenCalledTimes(1)
  expect(mock.request.mock.calls[0]?.[0]).toBe('recuperarComando')
  expect(mock.space?.entries[0]?.state).toBe('applied')
  expect(mock.space?.versions[0]?.version).toBe('v2')
})
it('otra cuenta no consulta ni envía la cola ajena', async () => {
  mock.uid = 'otra'
  await drain(command)
  expect(mock.request).not.toHaveBeenCalled()
  expect(mock.space?.entries[0]?.state).toBe('uncertain')
})
it('el conflicto de cabeza bloquea todos los comandos posteriores', async () => {
  mock.space!.entries.push({ ...entry(), command: { ...command, commandId: 'command_0000000002', sequence: 2 }, state: 'queued' })
  mock.request.mockResolvedValue({ data: { receipt: receipt({ status: 'conflict', code: 'stale_version', message: 'La disponibilidad ha cambiado.', currentVersions: [] }) } })
  await drain(command)
  expect(mock.request).toHaveBeenCalledTimes(1)
  expect(mock.space?.entries.map(e => e.state)).toEqual(['conflict', 'queued'])
})
it('sin red conserva la intención y no realiza ninguna petición', async () => {
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: false })
  await drain(command)
  expect(mock.request).not.toHaveBeenCalled()
  expect(mock.space?.entries[0]?.state).toBe('uncertain')
})
it('en el VPS recupera y sincroniza por la API, con identidad obligatoria y sin Functions', async () => {
  mock.backend = 'postgres'
  mock.request.mockResolvedValue({ data: { receipt: receipt({ status: 'applied', response: { ok: true, soldOut: true }, versions: [{ kind: 'item', id: 'bravas', version: 'v3' }] }) } })
  await drain(command)
  expect(mock.request.mock.calls[0]?.[0]).toBe('recuperarComando')
  expect(mock.request.mock.calls[0]?.[2]).toMatchObject({ authentication: 'required' })
  expect(mock.space?.entries[0]?.state).toBe('applied')
})
it('en el VPS un permiso denegado deja la intención rechazada y bloqueada, sin perderla', async () => {
  mock.backend = 'postgres'
  mock.request.mockRejectedValue(Object.assign(new Error('sin permiso'), { code: 'permission-denied' }))
  await drain(command)
  expect(mock.space?.entries[0]?.state).toBe('rejected')
  expect(mock.space?.entries[0]?.command).toEqual(command)
})
it('en el VPS un servicio no desplegado o una precondición fallida no se reintentan 12 veces: la intención queda rechazada y a la vista', async () => {
  for (const code of ['not-deployed', 'failed-precondition']) {
    mock.backend = 'postgres'
    mock.space = { key: syncStreamKey(command), sequence: 1, entries: [entry()], versions: [], synchronizedAt: 0, cash: [] }
    mock.request.mockReset()
    mock.request.mockRejectedValue(Object.assign(new Error('no disponible'), { code }))
    await drain(command)
    expect(mock.request).toHaveBeenCalledTimes(1)
    expect(mock.space?.entries[0]).toMatchObject({ state: 'rejected', attempts: 1, command })
  }
})
