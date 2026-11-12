import { describe, expect, it } from 'vitest'
import { ROLES, type Member } from '@llenamos/core'
import { authorize, authorizeInvitation, ensureOwner, parse } from './shared'
import { z } from 'zod'

const member = (role: Member['role'], uid = 'actor', active = true): Member => ({ uid, role, active, displayName: uid, email: `${uid}@test.es`, locationIds: [] })
describe('Permisos de equipo', () => {
  for (const role of ROLES) {
    it(`${role}: permisos de gestión y roles asignables`, () => {
      for (const next of ROLES) {
        const action = () => authorize(member(role), undefined, next)
        if (role === 'owner' || (role === 'manager' && next !== 'owner')) expect(action).not.toThrow()
        else expect(action).toThrow()
      }
    })
    it(`${role}: no cambia ni desactiva su propia membresía`, () => {
      expect(() => authorize(member(role), member(role))).toThrow()
    })
    it(`${role}: una membresía inactiva no gestiona`, () => {
      expect(() => authorize(member(role, 'actor', false))).toThrow()
    })
  }
  it('un manager no puede degradar ni desactivar un owner', () => {
    expect(() => authorize(member('manager'), member('owner', 'otro'), 'waiter')).toThrow()
    expect(() => authorize(member('manager'), member('owner', 'otro'))).toThrow()
  })
  it('un owner puede gestionar otro owner', () => {
    expect(() => authorize(member('owner'), member('owner', 'otro'), 'manager')).not.toThrow()
  })
  it('protege al último propietario activo', () => {
    const owner = member('owner')
    expect(() => ensureOwner(owner, 'waiter', true, 1)).toThrow()
    expect(() => ensureOwner(owner, 'owner', false, 1)).toThrow()
    expect(() => ensureOwner(owner, 'owner', true, 1)).not.toThrow()
    expect(() => ensureOwner(owner, 'waiter', true, 2)).not.toThrow()
    expect(() => ensureOwner(member('owner', 'inactivo', false), 'waiter', false, 1)).not.toThrow()
  })
  it('devuelve un error de entrada en castellano', () => {
    expect(() => parse(z.string(), 123)).toThrow('Revisa los datos enviados.')
  })
})

describe('Reactivación mediante invitación', () => {
  it('solo rechaza como duplicada una membresía activa', () => {
    expect(() => authorizeInvitation(member('owner'), member('waiter', 'otro'), 'bar')).toThrowError(expect.objectContaining({ code: 'already-exists' }))
    expect(() => authorizeInvitation(member('owner'), member('waiter', 'otro', false), 'bar')).not.toThrow()
  })
  it('mantiene permisos y roles asignables al reactivar', () => {
    expect(() => authorizeInvitation(member('manager'), member('owner', 'otro', false), 'waiter')).toThrow()
    expect(() => authorizeInvitation(member('manager'), member('waiter', 'otro', false), 'owner')).toThrow()
    expect(() => authorizeInvitation(member('manager'), member('waiter', 'otro', false), 'bar')).not.toThrow()
    expect(() => authorizeInvitation(member('waiter'), member('waiter', 'otro', false), 'bar')).toThrow()
    expect(() => authorizeInvitation(member('owner', 'actor', false), undefined, 'bar')).toThrow()
  })
})
