import { describe, expect, it } from 'vitest'
import { scrubLabel } from './privacy.js'

describe('scrubLabel', () => {
  it('sustituye solo el segmento entero con el nombre', () => {
    expect(scrubLabel('Para llevar · Ana · 21:30', ['Ana'])).toBe('Para llevar · Persona suprimida · 21:30')
    expect(scrubLabel('Para llevar · Ana María · 21:30', ['Ana'])).toBe('Para llevar · Ana María · 21:30')
    expect(scrubLabel('Ensalada Ana', ['Ana'])).toBe('Ensalada Ana')
    expect(scrubLabel('Mesa 3', ['Ana'])).toBe('Mesa 3')
  })
})
