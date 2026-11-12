import { describe, expect, it, vi } from 'vitest'
import { Timestamp, type Transaction } from 'firebase-admin/firestore'
import type { MessageRequest } from '@llenamos/core'

const mocks = vi.hoisted(() => ({ create: vi.fn(), collection: vi.fn(() => ({ doc: (key?: string) => ({ id: key ?? 'mensaje' }) })) }))
vi.mock('../shared', () => ({ db: { collection: mocks.collection }, stamp: () => ({ createdAt: 'fecha-servidor', updatedAt: 'fecha-servidor' }) }))
import { enqueueMessage } from './enqueue'

const request: MessageRequest = { channel: 'whatsapp', to: '+34600000000', template: 'reminder', language: 'es', data: { guestName: 'Ana' }, reservationId: 'reserva', waitlistId: null, sendAt: 100000 }
describe('Cola transaccional', () => {
  it('guarda fechas de Firestore y estado inicial controlado por el servidor', () => {
    mocks.create.mockClear()
    const id = enqueueMessage({ create: mocks.create } as unknown as Transaction, 'restaurante', { ...request, status: 'sent', attempts: 5 } as MessageRequest)
    expect(id).toBe('mensaje')
    expect(mocks.collection).toHaveBeenCalledWith('restaurants/restaurante/messages')
    expect(mocks.create).toHaveBeenCalledWith({ id: 'mensaje' }, expect.objectContaining({ status: 'queued', attempts: 0, provider: null, rendered: null, sendAt: Timestamp.fromMillis(100000), createdAt: 'fecha-servidor' }))
  })
  it('conserva el id determinista con la misma validación y fechas', () => {
    mocks.create.mockClear()
    const id = enqueueMessage({ create: mocks.create } as unknown as Transaction, 'restaurante', request, 'review_reserva_whatsapp')
    expect(id).toBe('review_reserva_whatsapp')
    expect(mocks.create).toHaveBeenCalledWith({ id }, expect.objectContaining({ status: 'queued', sendAt: Timestamp.fromMillis(100000) }))
  })
  it('rechaza un destinatario incompatible antes de escribir', () => {
    mocks.create.mockClear()
    expect(() => enqueueMessage({ create: mocks.create } as unknown as Transaction, 'restaurante', { ...request, to: 'ana@test.es' })).toThrow()
    expect(mocks.create).not.toHaveBeenCalled()
  })
})
