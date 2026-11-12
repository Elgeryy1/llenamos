import { describe, it, expect } from 'vitest'
import { encodeEscPos, sha256Hex } from '@llenamos/core'
import { qrMatrix } from './qr.js'

describe('QR térmico real de corrección M', () => {
  // Vectores independientes generados con Project Nayuki, V11 M, byte y máscara 0.
  it.each([
    ['https://prewww2.aeat.es/wlpl/TIKE-CONT/ValidarQR?nif=B12345678&numserie=LUMBRE%2F2026%2FF%2F1&fecha=09-11-2026&importe=12.50', '1ee63b02ee76ff821fff20afec3675c164c521fc3cd5054a6eb517c65e5695df'],
    ['José y á ñ €', '28ca34dc6ce4e9b641a6deb23ea8f60d7ceb074ecbd7e4e81ba52ab29bb220a1'],
  ])('coincide módulo a módulo con un generador independiente', (text, hash) => {
    const matrix = qrMatrix(text)
    expect(matrix).toHaveLength(61)
    expect(sha256Hex(matrix.flat().map(Number).join(''))).toBe(hash)
  })
  it('rechaza exceso de capacidad UTF8', () => {
    expect(() => qrMatrix('a'.repeat(251))).not.toThrow()
    expect(() => qrMatrix('a'.repeat(252))).toThrow()
    expect(() => qrMatrix('é'.repeat(126))).toThrow()
  })
  it.each([58, 80] as const)('genera raster M con 30 a 40 mm y márgenes en papel de %s mm', paperMm => {
    const doc = { kind: 'invoice' as const, lines: [], fiscal: { qrUrl: 'https://ejemplo.test/qr', legend: 'VERI*FACTU', warning: 'no válido para Hacienda' } }
    const bytes = Buffer.from(encodeEscPos(doc, { paperMm, columns: paperMm === 58 ? 32 : 48 }, qrMatrix))
    const start = bytes.indexOf(Buffer.from([29,118,48,0]))
    const width = bytes[start+4]! + bytes[start+5]! * 256
    expect(width * 8).toBeLessThanOrEqual(paperMm === 58 ? 384 : 576)
    expect(61 * 4 * 25.4 / 203).toBeGreaterThanOrEqual(30)
    expect(bytes.includes(Buffer.from([27,112]))).toBe(false)
  })
})
