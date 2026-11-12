import { describe, expect, it } from 'vitest'
import { publicAppOrigin } from './public-app-url'

describe('Origen de enlaces públicos', () => {
  it('normaliza el origen configurado sin añadir rutas ni heredar Host', () => {
    expect(publicAppOrigin('https://app.example.com/')).toBe('https://app.example.com')
    expect(publicAppOrigin('https://app.example.com:8443')).toBe('https://app.example.com:8443')
  })
  it.each([undefined, '', 'http://app.example.com', 'https://app.example.com/path',
    'https://app.example.com/?x=1', 'https://app.example.com/#x', 'https://user:pass@app.example.com',
    'https://localhost', 'https://127.0.0.1', 'https://[::1]'])('rechaza un origen productivo incorrecto: %s', value => {
    expect(() => publicAppOrigin(value)).toThrow('origen HTTPS')
  })
  it('solo permite HTTP y fallback local con la demo emulada explícita', () => {
    expect(publicAppOrigin(undefined, true)).toBe('http://localhost:3000')
    expect(publicAppOrigin('http://127.0.0.1:3015', true)).toBe('http://127.0.0.1:3015')
    expect(() => publicAppOrigin('http://app.example.com', true)).toThrow()
  })
})
