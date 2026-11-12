import { describe, expect, it } from 'vitest'
import { sha256Hex } from '@llenamos/core'
import { qrMatrix, qrSvg } from './qr'
describe('QR fiscal M del recibo', () => {
  it('coincide con Python qrcode 8.2, versión 10, byte, M y máscara 0', () => {
    const url = 'https://prewww2.aeat.es/wlpl/TIKE-CONT/ValidarQR?nif=89890001K&numserie=TEST%2F000001&fecha=09-11-2026&importe=26.00'
    expect(sha256Hex(qrMatrix(url).flat().map(Number).join(''))).toBe('6ecddb45e4b8cc7fd4a98c4d0bb07dd46f1fade25fe6618b22fa5f760848b27c')
  })
  it('preserva zona blanca y no genera un código si sobrepasa su capacidad', () => {
    expect(qrSvg('https://local.test')).toContain('viewBox="0 0 65 65"')
    expect(() => qrMatrix('a'.repeat(213))).not.toThrow()
    expect(() => qrMatrix('a'.repeat(214))).toThrow()
  })
})
