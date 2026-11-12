import { describe, expect, it } from 'vitest'
import { liveQueries } from './live.js'

const roles = (name: string) => liveQueries.find(q => q.name === name)!.roles

describe('lecturas en vivo de fidelización', () => {
  it('los ajustes los lee quien atiende al cliente; premios, promociones y Repite, solo quien gestiona', () => {
    expect(roles('fidelizacion.ajustes')).toEqual(expect.arrayContaining(['owner', 'manager', 'waiter']))
    expect(roles('fidelizacion.ajustes')).not.toContain('kitchen')
    for (const name of ['fidelizacion.premios', 'fidelizacion.promociones', 'fidelizacion.repite']) {
      expect(roles(name)).toEqual(expect.arrayContaining(['owner', 'manager']))
      expect(roles(name)).not.toContain('waiter')
    }
  })
})
